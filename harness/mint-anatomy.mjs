// mint-anatomy.mjs -- per-op heap-byte anatomy of mint+dispose cycles.
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT License
//
// WHAT THIS MEASURES
//   The heap bytes charged per mint+dispose cycle for every creation primitive
//   (signal, computed, effect, signalBox, computedBox) plus a mint-and-hold
//   survivor lane, on a PRE-GROWN fixed-ceiling registry:
//       createRegistry({maxNodes: 1<<16, maxLinks: 1<<18, onCapacityExceeded: "throw"})
//   Pre-growing (warmup drains the pool to its ceiling first) removes pool-growth
//   churn from the window so the delta is pure per-mint allocation.
//
// ALL-SPACE vs NEW-SPACE (the LS-06 lesson)
//   A new-space-only witness UNDERCOUNTS. Before signal() reaches TurboFan
//   (< ~15-25k lifetime mints), ~56 B/op of the mint -- closure feedback
//   plumbing -- is allocated directly in OLD space, invisible to a new_space
//   delta (LiteStore LS-06 read ~209 this way; the true cost is 264). This probe
//   sums space_used_size over ALL heap spaces. The all-space lane is the truth;
//   the new-space lane is reported only to expose the tier artifact.
//
// FRESH CHILD PER CELL
//   JIT tier state poisons same-process comparisons: a signal() warmed to
//   TurboFan in one variant contaminates the next. Every (variant, warmup) cell
//   is therefore its OWN child process (parent spawns via process.execPath with
//   --expose-gc --max-semi-space-size=64). The child prints one JSON line; the
//   parent aggregates into an ASCII table and (with --verify) applies relative
//   pins. Absolute byte figures are REPORTED, not gated (except the one generous
//   P1 ceiling).
//
// USAGE
//   node harness/run.mjs mint            report the variant x warmup matrix
//   node harness/run.mjs mint --verify   report + apply P1..P5 pins (exit 1 on fail)
//   (internal) node harness/mint-anatomy.mjs --child <variant> <warmup>
//
// LINEARITY (P4) FORMULATION
//   Per-op is compared between the 1k..4k window slope and the 4k..16k window
//   slope: slopeA = (a4-a1)/3000, slopeB = (a16-a4)/12000. This cancels the
//   sampler's own constant offset (which contaminates the raw 1k per-op figure)
//   on both sides. The reported B/op is the (16k-1k) slope: (a16-a1)/15000.

import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import v8 from "node:v8";
import {createRegistry} from "../Signal.js";

const HERE = fileURLToPath(import.meta.url);
const NODE = process.execPath;

const VARIANTS = ["signal", "computed", "effect", "signalBox", "computedBox", "mintHold"];
const WARMUPS = [12000, 250000];
const OPS = [1000, 4000, 16000];

// ---- child measurement core (allprims.mjs method, productionized) ---------

function newSpaceUsed() {
    for (const s of v8.getHeapSpaceStatistics()) {
        if (s.space_name === "new_space") return s.space_used_size;
    }
    return 0;
}
function allSpaceUsed() {
    let t = 0;
    for (const s of v8.getHeapSpaceStatistics()) t += s.space_used_size;
    return t;
}

function runChild(variant, warmup) {
    const gc = globalThis.gc;
    if (typeof gc !== "function") {
        process.stderr.write("mint-anatomy child requires --expose-gc\n");
        process.exit(2);
    }
    const R = createRegistry({maxNodes: 1 << 16, maxLinks: 1 << 18, onCapacityExceeded: "throw"});
    const sharedCompute = () => 1;
    const sharedBody = () => {};
    let sink = null;

    // mint-and-hold: survivors kept in a pre-sized array strictly < maxNodes,
    // drained (disposed) whenever it fills, and once after warmup / each window.
    const HOLD = 1 << 15;            // 32768 < 65536 maxNodes
    const holder = new Array(HOLD).fill(null);
    let holdIdx = 0;
    const drain = () => {
        while (holdIdx > 0) {
            holdIdx--;
            R.dispose(holder[holdIdx]);
            holder[holdIdx] = null;
        }
    };

    const CYCLE = {
        signal:      () => { const h = R.signal(1); R.dispose(h); sink = h; },
        computed:    () => { const h = R.computed(sharedCompute); R.dispose(h); sink = h; },
        effect:      () => { const d = R.effect(sharedBody); d(); sink = d; },
        signalBox:   () => { const h = R.signalBox(1); R.dispose(h); sink = h; },
        computedBox: () => { const h = R.computedBox(sharedCompute); R.dispose(h); sink = h; },
        mintHold:    () => { holder[holdIdx++] = R.signal(1); },
    };
    const WARM = {
        // mintHold warms by minting-and-holding, draining at capacity so the pool
        // grows to its ceiling without overflowing the holder.
        mintHold: () => { holder[holdIdx++] = R.signal(1); if (holdIdx === HOLD) drain(); },
    };
    const isHold = variant === "mintHold";
    const fn = CYCLE[variant];
    if (!fn) {
        process.stderr.write("unknown variant: " + variant + "\n");
        process.exit(2);
    }
    const warmFn = WARM[variant] ?? fn;

    for (let i = 0; i < warmup; i++) warmFn();
    if (isHold) drain();

    const baselineActive = R.stats().activeNodes;
    let p5ok = true;
    const windows = [];
    let guardFail = null;

    for (const ops of OPS) {
        gc(); gc();
        const nBefore = newSpaceUsed();
        const aBefore = allSpaceUsed();
        for (let i = 0; i < ops; i++) fn();
        const nAfter = newSpaceUsed();
        const aAfter = allSpaceUsed();
        if (isHold) { drain(); gc(); }
        const nDelta = nAfter - nBefore;
        const aDelta = aAfter - aBefore;
        // P5: active-node count must return to its pre-window baseline (cycle
        // variants dispose in-loop; mintHold after drain).
        const activeNow = R.stats().activeNodes;
        if (activeNow !== baselineActive) p5ok = false;
        // Guard: a negative new-space delta means a scavenge fired mid-window
        // and ate live survivors -- the sample is meaningless. Fail the cell.
        if (nDelta < 0) {
            guardFail = "scavenge fired mid-window (new-space delta " + nDelta +
                " B at ops=" + ops + "). Remediation: lower ops window or raise " +
                "--max-semi-space-size; expected window bytes must stay far under " +
                "the semispace.";
        }
        windows.push({ops, nDelta, aDelta});
    }

    const out = {variant, warmup, windows, p5ok, guardFail};
    process.stdout.write(JSON.stringify(out) + "\n");
    if (guardFail) process.exit(1);
    process.exit(0);
}

// ---- parent aggregation + verify ------------------------------------------

function semiSpaceSupported() {
    const r = spawnSync(NODE, ["--max-semi-space-size=64", "-e", "0"], {stdio: "ignore"});
    return r.status === 0;
}

function spawnCell(variant, warmup, useSemi) {
    const flags = ["--expose-gc"];
    if (useSemi) flags.push("--max-semi-space-size=64");
    const args = [...flags, HERE, "--child", variant, String(warmup)];
    const r = spawnSync(NODE, args, {encoding: "utf8"});
    return r;
}

function parseCell(r) {
    const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
    if (!line) return null;
    try { return JSON.parse(line); } catch { return null; }
}

// slope over the full 1k..16k span (cancels the sampler constant)
function slope(windows, key) {
    const w1 = windows[0], w16 = windows[2];
    return (w16[key] - w1[key]) / (w16.ops - w1.ops);
}
// piecewise slopes for the P4 linearity comparison
function slopeAB(windows, key) {
    const [w1, w4, w16] = windows;
    const a = (w4[key] - w1[key]) / (w4.ops - w1.ops);
    const b = (w16[key] - w4[key]) / (w16.ops - w4.ops);
    return {a, b, diff: Math.abs(a - b)};
}

function fmt(n) { return n.toFixed(1); }

async function parent(verify) {
    const useSemi = semiSpaceSupported();
    if (!useSemi) {
        process.stderr.write(
            "warning: this node build rejects --max-semi-space-size=64; " +
            "running children without it (scavenge-window guard may trip on " +
            "large windows -- degrade, not fail)\n");
    }

    // cell key -> parsed result
    const cells = new Map();
    let anyFail = false;

    for (const variant of VARIANTS) {
        for (const warmup of WARMUPS) {
            const r = spawnCell(variant, warmup, useSemi);
            const parsed = parseCell(r);
            const key = variant + "@" + warmup;
            if (!parsed) {
                process.stderr.write("FAIL cell " + key + ": no parseable output (exit " +
                    r.status + ")\n" + (r.stderr || "") + "\n");
                anyFail = true;
                continue;
            }
            if (parsed.guardFail || r.status !== 0) {
                process.stderr.write("FAIL cell " + key + ": " +
                    (parsed.guardFail || ("child exit " + r.status)) + "\n");
                anyFail = true;
            }
            cells.set(key, parsed);
        }
    }

    // ---- table -----------------------------------------------------------
    process.stdout.write("\nmint-anatomy -- mint+dispose cycle, pre-grown throw-policy registry\n");
    process.stdout.write("node " + process.version + " " + process.platform + "/" + process.arch +
        "  semispace=" + (useSemi ? "64MB" : "default") + "\n");
    process.stdout.write("slope = (delta16k - delta1k) / 15000 ops; all-space sums every heap space\n\n");
    const head = "variant".padEnd(13) + "warmup".padStart(8) +
        "new-space B/op".padStart(16) + "all-space B/op".padStart(16) + "  P5";
    process.stdout.write(head + "\n");
    process.stdout.write("-".repeat(head.length) + "\n");
    for (const variant of VARIANTS) {
        for (const warmup of WARMUPS) {
            const c = cells.get(variant + "@" + warmup);
            if (!c) {
                process.stdout.write(variant.padEnd(13) + String(warmup).padStart(8) +
                    "n/a".padStart(16) + "n/a".padStart(16) + "  --\n");
                continue;
            }
            const nS = slope(c.windows, "nDelta");
            const aS = slope(c.windows, "aDelta");
            process.stdout.write(variant.padEnd(13) + String(warmup).padStart(8) +
                fmt(nS).padStart(16) + fmt(aS).padStart(16) +
                "  " + (c.p5ok ? "ok" : "FAIL") + "\n");
        }
    }

    if (!verify) {
        process.exit(anyFail ? 1 : 0);
    }

    // ---- verify: relative pins -------------------------------------------
    process.stdout.write("\n-- verify (relative pins) --\n");
    const pins = [];
    const pin = (name, ok, detail) => { pins.push({name, ok, detail}); };

    const aSlopeOf = (v, w) => {
        const c = cells.get(v + "@" + w);
        return c ? slope(c.windows, "aDelta") : null;
    };
    const nSlopeOf = (v, w) => {
        const c = cells.get(v + "@" + w);
        return c ? slope(c.windows, "nDelta") : null;
    };

    // P1: box discipline -- box all-space slope <= callable/3 at BOTH warmups,
    // plus a generous absolute ceiling of 128 B/op on the box slope.
    for (const [box, base] of [["signalBox", "signal"], ["computedBox", "computed"]]) {
        for (const w of WARMUPS) {
            const b = aSlopeOf(box, w), c = aSlopeOf(base, w);
            if (b == null || c == null) { pin("P1 " + box + " vs " + base + " @" + w, false, "missing cell"); continue; }
            const okRatio = b <= c / 3;
            const okCeil = b <= 128;
            pin("P1 " + box + " <= " + base + "/3 @" + w,
                okRatio && okCeil,
                box + "=" + fmt(b) + " " + base + "/3=" + fmt(c / 3) + " ceil<=128");
        }
    }

    // P2: dispose adds nothing -- |signal cycle all-space - mintHold all-space| <= 8 at both warmups.
    for (const w of WARMUPS) {
        const cyc = aSlopeOf("signal", w), hold = aSlopeOf("mintHold", w);
        if (cyc == null || hold == null) { pin("P2 dispose-free @" + w, false, "missing cell"); continue; }
        const d = Math.abs(cyc - hold);
        pin("P2 |signal - mintHold| <= 8 @" + w, d <= 8,
            "signal=" + fmt(cyc) + " mintHold=" + fmt(hold) + " diff=" + fmt(d));
    }

    // P3: accounting sanity -- new-space slope <= all-space slope + 4 for every cell.
    for (const variant of VARIANTS) {
        for (const w of WARMUPS) {
            const n = nSlopeOf(variant, w), a = aSlopeOf(variant, w);
            if (n == null || a == null) { pin("P3 " + variant + " @" + w, false, "missing cell"); continue; }
            pin("P3 new<=all+4 " + variant + " @" + w, n <= a + 4,
                "new=" + fmt(n) + " all=" + fmt(a));
        }
    }

    // P4: linearity -- |slope(1k..4k) - slope(4k..16k)| <= 8 (all-space) per cell.
    for (const variant of VARIANTS) {
        for (const w of WARMUPS) {
            const c = cells.get(variant + "@" + w);
            if (!c) { pin("P4 " + variant + " @" + w, false, "missing cell"); continue; }
            const s = slopeAB(c.windows, "aDelta");
            pin("P4 linear " + variant + " @" + w, s.diff <= 8,
                "slopeA=" + fmt(s.a) + " slopeB=" + fmt(s.b) + " diff=" + fmt(s.diff));
        }
    }

    // P5: pool discipline -- active-node count returns to baseline every window (checked in-child).
    for (const variant of VARIANTS) {
        for (const w of WARMUPS) {
            const c = cells.get(variant + "@" + w);
            if (!c) { pin("P5 " + variant + " @" + w, false, "missing cell"); continue; }
            pin("P5 activeNodes conserved " + variant + " @" + w, c.p5ok === true,
                c.p5ok ? "conserved" : "drifted");
        }
    }

    let allPass = true;
    for (const p of pins) {
        if (!p.ok) allPass = false;
        process.stdout.write((p.ok ? "PASS " : "FAIL ") + p.name + "  [" + p.detail + "]\n");
    }

    process.stdout.write("\n" + (allPass && !anyFail ? "all pins PASS" : "PINS FAILED") + "\n");
    process.exit(allPass && !anyFail ? 0 : 1);
}

// ---- dispatch --------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv[0] === "--child") {
    const variant = argv[1];
    const warmup = Number(argv[2]);
    if (!VARIANTS.includes(variant)) {
        process.stderr.write("unknown variant: " + String(variant) + "\n");
        process.exit(2);
    }
    if (!Number.isFinite(warmup) || warmup < 0) {
        process.stderr.write("bad warmup: " + String(argv[2]) + "\n");
        process.exit(2);
    }
    runChild(variant, warmup);
} else {
    // parent: recognized flags only. Fail closed on anything else.
    let verify = false;
    for (const a of argv) {
        if (a === "--verify") { verify = true; continue; }
        if (a === "--help" || a === "-h") {
            process.stdout.write(
                "mint-anatomy -- mint+dispose cycle allocation anatomy\n\n" +
                "  node harness/run.mjs mint [--verify]\n\n" +
                "  --verify   apply relative pins P1..P5 (exit 1 on any fail)\n");
            process.exit(0);
        }
        const hint = a === "--verfy" || a === "--verifty" || a === "-verify" ? " (did you mean --verify?)" : "";
        process.stderr.write("unknown flag: " + a + hint + "\n");
        process.exit(2);
    }
    await parent(verify);
}
