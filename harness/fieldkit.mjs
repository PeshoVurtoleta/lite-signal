#!/usr/bin/env node
// @zakkster/lite-signal field kit -- single-file, zero-dep verify + bench.
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT License
//
// USAGE (run on each machine, compare outputs):
//   node --expose-gc fieldkit.mjs ./Signal-1.9.1.js
//   node --expose-gc fieldkit.mjs ./Signal-1.9.1.js ./Signal-1.8.0.js   (interleaved A/B)
//
// What it does:
//   1. Prints the host fingerprint (node / platform / arch / cpu).
//   2. Runs a correctness quick-verify on engine A (fixed point, settled,
//      link counters, Symbol.dispose, sab) -- ~1s, hard-fails loudly.
//   3. Spawns COLD CHILD PROCESSES per bench shape, interleaved A/B when two
//      engines are given (the VersionMatrix discipline: same-run, alternating,
//      median-of-in-process-samples per child, min+median across children so
//      per-process bimodality is visible instead of averaged away).
// Shapes: 1to1 (unbatched write+effect), fan64batch (64 writes/batch),
//   selfnoop (non-writing 9-dep effect), unrelatedwrite (effect writes an
//   untracked signal every run -- the 1.9 fixed-point tax probe),
//   chain900 (900-deep recompute cascade -- the bimodality-prone shape),
//   plateau (recursive-pull overflow point -- V8 scope-shape indicator).

import {pathToFileURL, fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import os from "node:os";

const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);

// ---------------------------------------------------------------- child mode
if (args[0] === "--child") {
    const E = await import(pathToFileURL(args[1]).href);
    const shape = args[2];
    process.stdout.write(runShape(E, shape).join(" "));
    process.exit(0);
}

//Signal.js >=1.3.0;
function runShape(E, shape) {
    const cfg = {maxNodes: 16384, maxLinks: 65536, prealloc: "lazy", onCapacityExceeded: "grow"};
    if (shape === "createSignals" || shape === "createEffects") {
        // sbench-style cold mass creation under Andrii's adapter config:
        // lazy prealloc, registry discarded between reps (the pool never
        // amortizes -- exactly the bench's rules). Measures ns/op.
        const N = 100000;
        const samples = [];
        for (let s = 0; s < 7; s++) {
            const reg = E.createRegistry({
                maxNodes: 262144,
                maxLinks: 1048576,
                prealloc: "lazy",
                onCapacityExceeded: "grow"
            });
            const sources = [];
            if (shape === "createEffects") for (let i = 0; i < N; i++) sources.push(reg.signal(i));
            globalThis.gc?.();
            const t0 = performance.now();
            if (shape === "createSignals") {
                for (let i = 0; i < N; i++) sources.push(reg.signal(i));
            } else {
                for (let i = 0; i < N; i++) {
                    const g = sources[i];
                    reg.effect(() => g());
                }
            }
            samples.push(performance.now() - t0);
            reg.destroy();
        }
        samples.sort((a, b) => a - b);
        return [samples[0].toFixed(2), samples[3].toFixed(2)];
    }
    if (shape === "1to1batch") {
        // sbench updateComputations1to1, exact: one effect on one signal,
        // every set wrapped in batch() -- the shape that exposed the 1.9.x
        // settled-check regression (+10% in-process, +27% forked). Decides
        // between the stock drain and the swap/stub candidates.
        const r = E.createRegistry({maxNodes: 65536, maxLinks: 1048576, prealloc: "lazy", onCapacityExceeded: "grow"});
        const s = r.signal(0);
        let sink = 0;
        r.effect(() => {
            sink = s();
        });
        for (let i = 0; i < 40000; i++) r.batch(() => {
            s.set(i);
        });
        globalThis.gc?.();
        const samples = [];
        for (let k = 0; k < 9; k++) {
            const t0 = performance.now();
            for (let i = 0; i < 400000; i++) r.batch(() => {
                s.set(1e6 + k * 400000 + i);
            });
            samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        return [samples[0].toFixed(2), samples[4].toFixed(2)];
    }
    if (shape === "plateau") {
        // binary-search the deepest successful cold recursive pull
        let lo = 256, hi = 65536, best = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const r = E.createRegistry({
                maxNodes: mid + 64,
                maxLinks: (mid + 64) * 2,
                prealloc: "lazy",
                onCapacityExceeded: "grow"
            });
            let prev = r.signal(0);
            let ok = true;
            for (let i = 0; i < mid; i++) {
                const p = prev;
                prev = r.computed(() => p() + 1);
            }
            try {
                prev();
            } catch (e) {
                ok = false;
            }
            r.destroy();
            if (ok) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return [String(best), String(best)];
    }
    const r = E.createRegistry(cfg);
    let write, n;
    if (shape === "1to1") {
        const s = r.signal(0);
        let sink = 0;
        r.effect(() => {
            sink = s();
        });
        write = v => s.set(v);
        n = 400000;
    } else if (shape === "fan64batch") {
        const sigs = [];
        for (let i = 0; i < 64; i++) sigs.push(r.signal(i));
        let sink = 0;
        r.effect(() => {
            for (let i = 0; i < 64; i++) sink += sigs[i]();
        });
        write = v => r.batch(() => {
            for (let i = 0; i < 64; i++) sigs[i].set(v + i);
        });
        n = 40000;
    } else if (shape === "selfnoop") {
        const src = r.signal(0);
        let sink = 0;
        const deps = [];
        for (let i = 0; i < 8; i++) deps.push(r.signal(i));
        r.effect(() => {
            let s = src();
            for (let i = 0; i < 8; i++) s += deps[i]();
            sink = s;
        });
        write = v => src.set(v);
        n = 400000;
    } else if (shape === "unrelatedwrite") {
        const src = r.signal(0);
        const out = r.signal(0);
        const deps = [];
        for (let i = 0; i < 8; i++) deps.push(r.signal(i));
        r.effect(() => {
            let s = src();
            for (let i = 0; i < 8; i++) s += deps[i]();
            out.set(s);
        });
        write = v => src.set(v);
        n = 400000;
    } else if (shape === "chain900") {
        const root = r.signal(0);
        let prev = root;
        for (let i = 0; i < 900; i++) {
            const p = prev;
            prev = r.computed(() => p() + 1);
        }
        let sink = 0;
        r.effect(() => {
            sink = prev();
        });
        write = v => root.set(v);
        n = 3000;
    } else {
        throw new Error("unknown shape: " + shape);
    }
    for (let j = 0; j < Math.max(300, n / 10); j++) write(j);   // warm to steady state
    globalThis.gc?.();
    const samples = [];
    for (let s = 0; s < 9; s++) {
        const t0 = performance.now();
        for (let j = 0; j < n; j++) write(1000 + s * n + j);
        samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return [samples[0].toFixed(2), samples[4].toFixed(2)];   // min, median
}

// ---------------------------------------------------------------- verify
async function verify(enginePath) {
    const E = await import(pathToFileURL(enginePath).href);
    const results = [];
    const check = (name, fn) => {
        try {
            fn();
            results.push(["PASS", name]);
        } catch (e) {
            results.push(["FAIL", name + " -- " + e.message]);
        }
    };
    const eq = (a, b, m) => {
        if (a !== b) throw new Error(`${m}: ${a} !== ${b}`);
    };

    check("fixed point: conditional self-write converges observing each step", () => {
        const r = E.createRegistry();
        const n = r.signal(5);
        const seen = [];
        r.effect(() => {
            const v = n();
            seen.push(v);
            if (v < 8) n.set(v + 1);
        });
        eq(n(), 8, "final");
        eq(seen.join(","), "5,6,7,8", "sequence");
    });
    check("fixed point: unconditional self-write is CycleError, not a hang", () => {
        const r = E.createRegistry({maxFlushPasses: 20});
        const n = r.signal(0);
        let threw = null;
        try {
            r.effect(() => {
                n.set(n() + 1);
            });
        } catch (e) {
            threw = e;
        }
        if (!threw || !/CycleError/.test(threw.message)) throw new Error("expected CycleError");
    });
    check("fixed point: untracked writes never refire (spam filter)", () => {
        const r = E.createRegistry();
        const a = r.signal(0);
        const out = r.signal(0);
        let runs = 0;
        r.effect(() => {
            runs++;
            out.set(a() * 10);
        });
        a.set(1);
        a.set(2);
        eq(runs, 3, "one run per trigger");
    });
    check("fixed point: batched self-writes coalesce atomically (upstream #235 shape)", () => {
        const r = E.createRegistry();
        const a = r.signal(0);
        const b = r.signal(0);
        let obsRuns = 0, obsLast = -1;
        r.effect(() => {
            a();
            r.batch(() => {
                b.set(b() + 10);
                b.set(b() + 1);
            });
        });
        r.effect(() => {
            obsLast = b();
            obsRuns++;
        });
        eq(b(), 11, "setup");
        obsRuns = 0;
        a.set(1);
        eq(b(), 22, "one atomic +11 per run");
        eq(obsRuns, 1, "observer once");
        eq(obsLast, 22, "final view");
    });
    check("computed self-write ABSORBS (deliberate contract -- ledger #15, upstream #179 excluded)", () => {
        const r = E.createRegistry();
        const s = r.signal(1);
        const c = r.computed(() => {
            s.set(s() + 1);
            return s();
        });
        const top = r.computed(() => c() * 10);
        const seq = [c(), s(), c(), top(), top()].join(",");
        eq(seq, "2,2,2,20,20", "self-writing computed stays cached and predictable");
    });
    check("onSettled: fires once per clean drain, never on no-op writes", () => {
        const r = E.createRegistry();
        const a = r.signal(0);
        let settles = 0;
        r.effect(() => {
            a();
        });
        r.onSettled(() => settles++);
        a.set(1);
        a.set(1);
        r.batch(() => {
            a.set(2);
            a.set(3);
        });
        eq(settles, 2, "settle count");
    });
    check("link counters: stable topology reads as flat, flips read as churn", () => {
        const r = E.createRegistry();
        const flag = r.signal(true);
        const x = r.signal(1);
        const y = r.signal(2);
        r.effect(() => {
            flag() ? x() : y();
        });
        const s0 = r.stats();
        for (let i = 0; i < 500; i++) x.set(i + 10);
        const s1 = r.stats();
        eq(s1.totalLinkAllocations - s0.totalLinkAllocations, 0, "stable allocs");
        flag.set(false);
        const s2 = r.stats();
        if (s2.totalLinkDisposals - s1.totalLinkDisposals < 1) throw new Error("flip not counted");
    });
    check("Symbol.dispose: effect disposer + box + registry", () => {
        if (typeof Symbol.dispose !== "symbol") return;   // host without the symbol: skip quietly
        const r = E.createRegistry();
        const s = r.signal(1);
        let runs = 0;
        const stop = r.effect(() => {
            s();
            runs++;
        });
        stop[Symbol.dispose]();
        s.set(2);
        eq(runs, 1, "effect disposed");
        const b = r.signalBox(5);
        b[Symbol.dispose]();
        eq(b.get(), undefined, "box disposed");
        r[Symbol.dispose]();
        eq(r.stats().activeNodes, 0, "registry destroyed");
    });
    check("sab: fixed point defers to batch-exit delivery", () => {
        const r = E.createRegistry({flushStrategy: "sab"});
        const n = r.signal(5);
        const seen = [];
        r.effect(() => {
            const v = n();
            seen.push(v);
            if (v < 8) n.set(v + 1);
        });
        eq(seen.join(","), "5", "deferred");
        r.batch(() => {
        });
        eq(n(), 8, "converged at batch exit");
    });
    return results;
}

// ---------------------------------------------------------------- main
const engines = args.filter(a => !a.startsWith("-"));
if (engines.length < 1) {
    console.log("usage: node --expose-gc fieldkit.mjs <SignalA.js> [<SignalB.js>]");
    process.exit(1);
}
const gcOn = typeof globalThis.gc === "function";
console.log("lite-signal field kit");
console.log(`  host: node ${process.version}  ${os.platform()}/${os.arch()}  ${os.cpus()[0]?.model ?? "?"}`);
console.log(`  gc exposed: ${gcOn} ${gcOn ? "" : " (re-run with --expose-gc for stable numbers)"}`);
console.log(`  engine A: ${engines[0]}${engines[1] ? `\n  engine B: ${engines[1]}` : ""}\n`);

console.log("-- verify (engine A) --");
for (const [tag, name] of await verify(engines[0])) console.log(`  ${tag}  ${name}`);
console.log("");

const SHAPES = ["createSignals", "createEffects", "1to1", "1to1batch", "selfnoop", "unrelatedwrite", "fan64batch", "chain900", "plateau"];
const REPS = 5;
console.log(`-- bench: ${REPS} interleaved cold processes per engine per shape (min | median, ms; plateau = depth) --`);
const w = 15;
console.log("  " + "shape".padEnd(w) + "A min".padEnd(10) + "A med".padEnd(10) + (engines[1] ? "B min".padEnd(10) + "B med".padEnd(10) + "delta med" : ""));
for (const shape of SHAPES) {
    const acc = [[], []];
    for (let rep = 0; rep < (shape === "plateau" ? 2 : REPS); rep++) {
        for (let e = 0; e < engines.length; e++) {
            const out = execFileSync(process.execPath, ["--expose-gc", SELF, "--child", engines[e], shape],
                {encoding: "utf-8", timeout: 300000});
            acc[e].push(out.trim().split(" ").map(Number));
        }
    }
    const stat = (arr) => {
        const mins = arr.map(x => x[0]).sort((a, b) => a - b);
        const meds = arr.map(x => x[1]).sort((a, b) => a - b);
        return [mins[0], meds[Math.floor(meds.length / 2)],
            (meds[meds.length - 1] - meds[0]) / meds[0]];
    };
    const [amin, amed, aspread] = stat(acc[0]);
    let line = "  " + shape.padEnd(w) + String(amin).padEnd(10) + String(amed).padEnd(10);
    if (engines[1]) {
        const [bmin, bmed] = stat(acc[1]);
        const deltaNum = ((bmed - amed) / amed) * 100;
        line += String(bmin).padEnd(10) + String(bmed).padEnd(10) + `${deltaNum > 0 ? "+" : ""}${deltaNum.toFixed(1)}%`;
    }
    if (aspread > 0.10 && shape !== "plateau") line += `   [A spread ${(aspread * 100).toFixed(0)}% -- bimodal host?]`;
    console.log(line);
}
console.log("\nNotes: chain900 is the known bimodality-prone shape (per-process V8 tier-up");
console.log("coin flip, strikes ANY engine); trust interleaved medians, inspect mins.");
console.log("plateau depends on registry scope size and --stack-size, not engine quality.");
