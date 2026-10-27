// Perf gate -- the standing, self-validating zero-GC judge for lite-signal (1.5.2).
//
// WHY THIS EXISTS. lite-signal MEASURES its zero-GC claim in many bespoke lanes
// (04-zero-gc, 31-devtools-zerogc-probe, the mint-anatomy harness, VersionMatrix),
// but nothing JUDGES it with permanent, self-validating controls. This lane wires
// @zakkster/lite-perf-gate (devDependency only) as the standing verdict: five
// signals (scavenges / engine counters / retainedKB / oldGen / arrayBuffersKB),
// two scales (N and k*N), positive+negative+large detector controls on every run,
// and mustFail scenarios that keep the gate honest.
//
// GUARD (see BRIEF, and 04-zero-gc.test.mjs:26 for the resident hasGC pattern).
// zgcSuite() registers UNGUARDED node:test cases and its measure() THROWS without
// --expose-gc; and at the default 16MB semi-space (plain `npm run test:gc`) the
// positive control forces ~5 scavenges against its floor of 6 -> a false red. So
// the gate only executes for real when BOTH --expose-gc AND --max-semi-space-size=4
// are present, i.e. under `npm run test:gate`. Otherwise we emit ONE loud named
// skip (never a silent pass, never an unguarded zgcSuite call).
//
// NEGATIVE CONTROL OVERRIDE (b125). lite-perf-gate 1.4.2's stock controlNegative
// accumulates `a += (i * 3) ^ i` without bound, so `a` leaves the Smi range and
// the interpreter / Sparkplug tiers box a HeapNumber per iteration; only Maglev /
// TurboFan keep it unboxed. Gates job run 40599429786 (c864ddf) failed "negative
// control forced 12 scavenges (need <=2)" (stock CONTROL- lo 0 hi 12; also on
// f941aa6 and 3ef853a), consistent with tier-up lag; the local --no-opt
// --no-maglev repro gives the same 12 (N=200000 k=8: stock lo 1 hi 12).
// NEGATIVE_INT32 is an XOR accumulator that never leaves int32 (b125 r2
// re-measure: lo 0 hi 0 at default tiers and under --no-opt --no-maglev). So
// zgcSuite gets NEGATIVE_INT32, defined ONCE in fixtures/perf-gate-negctrl.mjs;
// the two witness rows at the bottom re-prove it below Maglev (a --no-opt
// --no-maglev child) on every plain `npm test`.

import {it} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {zgcSuite} from "@zakkster/lite-perf-gate";
import {createRegistry} from "../Signal.js";
import {NEGATIVE_INT32, WITNESS_FLAGS} from "./fixtures/perf-gate-negctrl.mjs";

const hasGC = typeof globalThis.gc === "function";
const hasSemi = process.execArgv.includes("--max-semi-space-size=4");
const gateReady = hasGC && hasSemi;

// Warm INSIDE setup so hot() measures steady state. 20k passes takes every hot
// path past its re-track / cache-hit floor before the measurement window opens.
const WARM = 20000;

// Every scenario reads its OWN isolated registry's ledger. Global counters would
// fail closed (a foreign registry's churn would poison the delta), so statsOf is
// per-scenario, pointed at the registry built in that scenario's setup().
function eager(nodes, links) {
    return createRegistry({maxNodes: nodes, maxLinks: links, prealloc: "eager"});
}

// 1. set-propagate -- llms.txt "set O(downstream) zero alloc after warm-up".
//    1 signal -> 8 computeds -> 1 effect; flush is synchronous (no scheduler in
//    the default path), so hot = signal.set() runs the whole cone in-window.
const setPropagate = {
    name: "set-propagate (1 signal -> 8 computeds -> 1 effect, sync flush)",
    setup() {
        const r = eager(128, 256);
        const s = r.signal(0);
        const cs = new Array(8);
        for (let i = 0; i < 8; i++) cs[i] = r.computed(() => s() + i);
        const st = {r, s, cs, sink: 0};
        r.effect(() => {
            let a = 0;
            for (let i = 0; i < 8; i++) a += cs[i]();
            st.sink = a;
        });
        for (let i = 0; i < WARM; i++) s.set(i);
        return st;
    },
    hot(st, n) {
        const s = st.s;
        for (let i = 0; i < n; i++) s.set(i);
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 2. computed-cache-hit -- llms.txt "computed cache hit zero alloc".
//    No dep change between reads: every read is a version-compare short-circuit.
const computedCacheHit = {
    name: "computed-cache-hit (read with no dep change)",
    setup() {
        const r = eager(64, 64);
        const s = r.signal(1);
        const c = r.computed(() => s() + 1);
        const st = {r, c, sink: 0};
        for (let i = 0; i < WARM; i++) st.sink += c();
        return st;
    },
    hot(st, n) {
        const c = st.c;
        let x = 0;
        for (let i = 0; i < n; i++) x += c();
        st.sink = x;
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 3. computed-recompute-stable -- llms.txt "computed recompute with stable dep
//    structure". Set a dep then read: recompute, but the dep SET never changes,
//    so no link is allocated after warm-up.
const computedRecomputeStable = {
    name: "computed-recompute-stable (set dep then read, stable structure)",
    setup() {
        const r = eager(64, 64);
        const s = r.signal(0);
        const c = r.computed(() => s() + 1);
        const st = {r, s, c, sink: 0};
        for (let i = 0; i < WARM; i++) {
            s.set(i);
            st.sink += c();
        }
        return st;
    },
    hot(st, n) {
        // Overwrite (not accumulate): summing c()'s growing return past ~2^30
        // boxes a HeapNumber PER OP in the scenario itself -- a measurement
        // artifact, not the engine. The bounded sink keeps the value a Smi so
        // the only thing measured is the engine's recompute path.
        const s = st.s, c = st.c;
        for (let i = 0; i < n; i++) {
            s.set(i);
            st.sink = c();
        }
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 4. effect-rerun-stable -- llms.txt "effect re-run with stable dep order".
//    One signal -> one effect; each set re-runs the effect, which re-tracks the
//    SAME single dep in the SAME order -> link is reused, nothing allocated.
const effectRerunStable = {
    name: "effect-rerun-stable (set dep so a warmed effect re-runs)",
    setup() {
        const r = eager(64, 64);
        const s = r.signal(0);
        const st = {r, s, sink: 0};
        r.effect(() => { st.sink = s(); });
        for (let i = 0; i < WARM; i++) s.set(i);
        return st;
    },
    hot(st, n) {
        const s = st.s;
        for (let i = 0; i < n; i++) s.set(i);
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 5. peek -- llms.txt "peek O(1) zero alloc". An untracked O(1) read.
const peek = {
    name: "peek (O(1) untracked read)",
    setup() {
        const r = eager(64, 64);
        const s = r.signal(42);
        const st = {r, s, sink: 0};
        for (let i = 0; i < WARM; i++) st.sink += s.peek();
        return st;
    },
    hot(st, n) {
        const s = st.s;
        let x = 0;
        for (let i = 0; i < n; i++) x += s.peek();
        st.sink = x;
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 6. batch-flush -- 3 sets per batch, one synchronous flush at batch end.
//    The batch body is allocated ONCE in setup and reused every op (a per-op
//    closure would be a scenario-side allocation, not an engine one).
const batchFlush = {
    name: "batch-flush (batch of 3 sets, sync flush at batch end)",
    setup() {
        const r = eager(64, 64);
        const a = r.signal(0), b = r.signal(0), c = r.signal(0);
        const st = {r, a, b, c, v: 0, sink: 0};
        r.effect(() => { st.sink = a() + b() + c(); });
        st.body = () => {
            const v = st.v;
            st.a.set(v);
            st.b.set(v + 1);
            st.c.set(v + 2);
        };
        for (let i = 0; i < WARM; i++) { st.v = i; r.batch(st.body); }
        return st;
    },
    hot(st, n) {
        const r = st.r, body = st.body;
        for (let i = 0; i < n; i++) { st.v = i; r.batch(body); }
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 7. box-set-propagate -- the 1.5.0 box surface (signalBox / computedBox) shares
//    the same read/write hot path. Same shape as set-propagate through boxes.
const boxSetPropagate = {
    name: "box-set-propagate (signalBox -> 8 computedBox -> 1 effect)",
    setup() {
        const r = eager(128, 256);
        const s = r.signalBox(0);
        const cs = new Array(8);
        for (let i = 0; i < 8; i++) { cs[i] = r.computedBox(() => s.get() + i); cs[i].get(); }
        const st = {r, s, cs, sink: 0};
        r.effect(() => {
            let a = 0;
            for (let i = 0; i < 8; i++) a += cs[i].get();
            st.sink = a;
        });
        for (let i = 0; i < WARM; i++) s.set(i);
        return st;
    },
    hot(st, n) {
        const s = st.s;
        for (let i = 0; i < n; i++) s.set(i);
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// mustFail -- permanent negative controls. Each MUST trip the gate; if either
// ever passes, the gate has gone blind and the whole lane is a lie.

// (a) per-op object allocator: {x,y,z,w} into a bounded ring so it escapes and
//     dies young (defeats escape analysis + pretenuring). Trips signal 1
//     (scavenges). Its statsOf reads a live but idle registry so the engine
//     counters stay 0-delta -- the ONLY signal that trips is the honest one.
const mustFailAlloc = {
    name: "MUSTFAIL per-op object allocator ({x,y,z,w})",
    setup() {
        const r = eager(64, 64);
        return {r, ring: new Array(64).fill(null)};
    },
    hot(st, n) {
        const ring = st.ring;
        for (let i = 0; i < n; i++) ring[i & 63] = {x: i, y: i + 1, z: i + 2, w: i + 3};
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// (b) per-op signal()+dispose churn -- the documented 264 B/op creation path.
//     signal() mints a fresh callable handle every op (the pooled node recycles,
//     the handle does not), so scavenges scale AND totalAllocations climbs by n.
//     It is the documented non-zero path, which is exactly what makes it a
//     truthful control.
const mustFailChurn = {
    name: "MUSTFAIL signal()+dispose churn (264 B/op)",
    setup() {
        const r = createRegistry({maxNodes: 64, maxLinks: 64, prealloc: "eager", onCapacityExceeded: "grow"});
        return {r};
    },
    hot(st, n) {
        const r = st.r;
        for (let i = 0; i < n; i++) {
            const s = r.signal(0);
            r.dispose(s);
        }
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

if (!gateReady) {
    it("perf gate", {skip: "requires npm run test:gate (node --expose-gc --max-semi-space-size=4)"}, () => {});
} else {
    zgcSuite({
        scenarios: [
            setPropagate,
            computedCacheHit,
            computedRecomputeStable,
            effectRerunStable,
            peek,
            batchFlush,
            boxSetPropagate,
        ],
        // The engine-ledger witness beside V8's -- every claimed-zero path must
        // acquire no node, dispose none, and grow no pool during the window.
        counters: {totalAllocations: 0, totalDisposals: 0, poolGrowths: 0},
        // At least two permanent negative controls. Both MUST trip the gate.
        mustFail: [mustFailAlloc, mustFailChurn],
        // Tier-independent detector control (see the header and the witness row).
        negativeControl: NEGATIVE_INT32,
        // Thresholds: lite-perf-gate DEFAULTS, untouched (maxScavenges 2,
        // maxRetainedKB 64, maxOldGen 0, maxArrayBuffersKB 64). A claimed-zero
        // path that cannot meet defaults is a FINDING, not a config knob.
    });
}

// Witness for the override -- runs in EVERY mode (plain `npm test` too), never
// gated on gateReady. A child with Maglev and TurboFan OFF (the CI tier-lag case
// forced) measures the stock control and NEGATIVE_INT32 at N=200000 k=8:
//   - stock minorHi > 2: the mechanism that reddened CI is real (teeth). If a
//     future lite-perf-gate fixes its control this half fails -- then drop the
//     negativeControl override and this row together.
//   - NEGATIVE_INT32 minorLo === 0 and minorHi <= 2 (the gate's maxScavenges)
//     under the same flags.
// Fail closed: timeout kill, signal, non-zero exit, unparsable JSON or a missing
// key is a failure. --max-old-space-size pinned (CI heap is smaller than dev).
const WITNESS_CHILD = fileURLToPath(new URL("./fixtures/perf-gate-negctrl.mjs", import.meta.url));

function witnessEnv() {
    const env = {};
    for (const k of Object.keys(process.env)) {
        if (k !== "NODE_OPTIONS" && k !== "NODE_TEST_CONTEXT") env[k] = process.env[k];
    }
    return env;
}

function witnessCount(obj, lane, key, raw) {
    const v = obj !== null && typeof obj === "object" && obj[lane] !== null && typeof obj[lane] === "object"
        ? obj[lane][key] : undefined;
    assert.ok(Number.isInteger(v) && v >= 0, "witness child: missing/invalid " + lane + "." + key + "\n  stdout: " + raw);
    return v;
}

it("perf gate: negative-control override witness (stock boxes below Maglev, NEGATIVE_INT32 does not)", () => {
    const res = spawnSync(process.execPath,
        [...WITNESS_FLAGS, "--max-old-space-size=256", WITNESS_CHILD],
        {encoding: "utf8", env: witnessEnv(), timeout: 120000, killSignal: "SIGKILL"});
    const raw = String(res.stdout || "").trim();
    const why = "\n  status=" + res.status + " signal=" + res.signal +
        (res.error ? " error=" + res.error.message : "") +
        "\n  stdout: " + raw + "\n  stderr: " + String(res.stderr || "").trim();
    assert.ok(!res.error && res.signal === null && res.status === 0, "witness child did not exit 0" + why);
    let out;
    try { out = JSON.parse(raw); } catch { assert.fail("witness child printed unparsable JSON" + why); }
    assert.ok(Array.isArray(out.flags), "witness child: missing flags" + why);
    for (const f of ["--expose-gc", "--max-semi-space-size=4", "--no-opt", "--no-maglev"]) {
        assert.ok(out.flags.includes(f), "witness child ran without " + f + why);
    }
    const stockHi = witnessCount(out, "stock", "minorHi", raw);
    const intLo = witnessCount(out, "int32", "minorLo", raw);
    const intHi = witnessCount(out, "int32", "minorHi", raw);
    assert.ok(stockHi > 2,
        "stock lite-perf-gate controlNegative no longer scavenges below Maglev (minorHi=" + stockHi +
        " <= 2): the upstream control looks fixed -- drop the negativeControl override and this row" + why);
    assert.equal(intLo, 0, "NEGATIVE_INT32 minorLo must be 0 under " + WITNESS_FLAGS.join(" ") + why);
    assert.ok(intHi <= 2, "NEGATIVE_INT32 minorHi=" + intHi + " > 2 under " + WITNESS_FLAGS.join(" ") + why);
});

it("perf gate: override wiring witness (zgcSuite detector passes below Maglev)", () => {
    const res = spawnSync(process.execPath,
        [...WITNESS_FLAGS, "--max-old-space-size=256", "--test", "--test-reporter=tap",
            "--test-name-pattern=^perf-gate: detector validation \\(", fileURLToPath(import.meta.url)],
        {encoding: "utf8", env: witnessEnv(), timeout: 120000, killSignal: "SIGKILL"});
    const out = String(res.stdout || "");
    assert.ok(!res.error && res.signal === null && res.status === 0 &&
        /^ok \d+ - perf-gate: detector validation \(/m.test(out) && /^# pass 1$/m.test(out) && /^# fail 0$/m.test(out),
        "detector validation under " + WITNESS_FLAGS.join(" ") + " did not pass exactly 1 test\n" + out + String(res.stderr || ""));
});
