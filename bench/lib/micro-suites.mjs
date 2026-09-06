// bench/lib/micro-suites.mjs -- the kairo / mol / fan / sBench micro-benchmarks,
// ported verbatim from Andrii's src (kairo/*, molBench, fanBench, sBench) onto the SAME
// ReactiveFramework adapter the mirror already uses. Together with the mirror's 17
// dependency-graph shapes these complete the full 47-row js-reactivity-benchmark field,
// so `benchmarkReactive.mjs` can be retired: one unified run, one protocol, one adapter.
//
// Faithfulness: bodies are 1:1 with his source (iteration counts, graph shapes, the
// `busy()` heavy-work stub, fan's checksum + seeded mutation, mol's fib(16) hard()).
// Reporting matches his fastestTest: median over BENCH_RUNS repeats, each rebuilding the
// graph outside the timed window. fan rows carry a `checksum=` for the checksum guard.

import { summarizeSamples } from "./stats.mjs";

const BENCH_RUNS = process.env.BENCH_RUNS ? +process.env.BENCH_RUNS : (process.env.QUICK === "1" ? 1 : 5);
const COUNT = process.env.QUICK === "1" ? 1e3 : 1e5;   // sBench base; QUICK shrinks it

// kairo/util busy(): a fixed heavy-work stub (100-iteration spin) used by avoidable.
function busy() { let a = 0; for (let i = 0; i < 100; i++) a++; return a; }

// fastestTest-equivalent: median over BENCH_RUNS rebuild+measure repeats.
function measureMedian(repeat) {
    const samples = [];
    for (let r = 0; r < BENCH_RUNS; r++) { samples.push(repeat()); globalThis.gc?.(); }
    return summarizeSamples(samples).median;
}

// ---------------------------------------------------------------- kairo (8) ----------
// Each case builds a graph and returns an `iter` closure that performs its own fixed
// update loop; the timed window is one iter() call on a fresh, settled graph.
const kairoCases = {
    avoidablePropagation(fw) {
        const head = fw.signal(0);
        const c1 = fw.computed(() => head.read());
        const c2 = fw.computed(() => (c1.read(), 0));
        const c3 = fw.computed(() => (busy(), c2.read() + 1));
        const c4 = fw.computed(() => c3.read() + 2);
        const c5 = fw.computed(() => c4.read() + 3);
        fw.effect(() => { c5.read(); busy(); });
        return () => { for (let i = 0; i < 1000; i++) fw.withBatch(() => head.write(i)); };
    },
    broadPropagation(fw) {
        const head = fw.signal(0); let last = head;
        for (let i = 0; i < 50; i++) {
            const cur = fw.computed(() => head.read() + i);
            const cur2 = fw.computed(() => cur.read() + 1);
            fw.effect(() => { cur2.read(); });
            last = cur2;
        }
        return () => { for (let i = 0; i < 50; i++) fw.withBatch(() => head.write(i)); };
    },
    deepPropagation(fw) {
        const len = 50; const head = fw.signal(0); let cur = head;
        for (let i = 0; i < len; i++) { const c = cur; cur = fw.computed(() => c.read() + 1); }
        fw.effect(() => { cur.read(); });
        return () => { for (let i = 0; i < 50; i++) fw.withBatch(() => head.write(i)); };
    },
    diamond(fw) {
        const width = 5; const head = fw.signal(0); const cur = [];
        for (let i = 0; i < width; i++) cur.push(fw.computed(() => head.read() + 1));
        const sum = fw.computed(() => cur.map((x) => x.read()).reduce((a, b) => a + b, 0));
        fw.effect(() => { sum.read(); });
        return () => { for (let i = 0; i < 500; i++) fw.withBatch(() => head.write(i)); };
    },
    mux(fw) {
        const heads = new Array(100).fill(null).map(() => fw.signal(0));
        const m = fw.computed(() => Object.fromEntries(heads.map((h) => h.read()).entries()));
        const splited = heads.map((_, index) => fw.computed(() => m.read()[index])).map((x) => fw.computed(() => x.read() + 1));
        splited.forEach((x) => fw.effect(() => x.read()));
        return () => {
            for (let i = 0; i < 10; i++) fw.withBatch(() => heads[i].write(i));
            for (let i = 0; i < 10; i++) fw.withBatch(() => heads[i].write(i * 2));
        };
    },
    repeatedObservers(fw) {
        const size = 30; const head = fw.signal(0);
        const cur = fw.computed(() => { let r = 0; for (let i = 0; i < size; i++) r += head.read(); return r; });
        fw.effect(() => { cur.read(); });
        return () => { for (let i = 0; i < 100; i++) fw.withBatch(() => head.write(i)); };
    },
    triangle(fw) {
        const width = 10; const head = fw.signal(0); let cur = head; const list = [];
        for (let i = 0; i < width; i++) { const c = cur; list.push(cur); cur = fw.computed(() => c.read() + 1); }
        const sum = fw.computed(() => list.map((x) => x.read()).reduce((a, b) => a + b, 0));
        fw.effect(() => { sum.read(); });
        return () => { for (let i = 0; i < 100; i++) fw.withBatch(() => head.write(i)); };
    },
    unstable(fw) {
        const head = fw.signal(0);
        const double = fw.computed(() => head.read() * 2);
        const inverse = fw.computed(() => -head.read());
        const cur = fw.computed(() => { let r = 0; for (let i = 0; i < 20; i++) r += head.read() % 2 ? double.read() : inverse.read(); return r; });
        fw.effect(() => { cur.read(); });
        return () => { for (let i = 0; i < 100; i++) fw.withBatch(() => head.write(i)); };
    },
};

// ---------------------------------------------------------------- mol (1) -------------
function fib(n) { return n < 2 ? 1 : fib(n - 1) + fib(n - 2); }
function hard(n) { return n + fib(16); }
function molBuild(fw) {
    const nums = [0, 1, 2, 3, 4]; const res = [];
    return fw.withBuild(() => {
        const A = fw.signal(0), B = fw.signal(0);
        const C = fw.computed(() => (A.read() % 2) + (B.read() % 2));
        const Ditems = nums.map(() => ({ x: 0 }));
        const D = fw.computed(() => { const a = A.read() % 2, b = B.read() % 2; for (let i = 0; i < nums.length; i++) Ditems[i].x = nums[i] + a - b; return Ditems; });
        const E = fw.computed(() => hard(C.read() + A.read() + D.read()[0].x));
        const F = fw.computed(() => hard(D.read()[2].x || B.read()));
        const G = fw.computed(() => C.read() + (C.read() || E.read() % 2) + D.read()[4].x + F.read());
        fw.effect(() => res.push(hard(G.read())));
        fw.effect(() => res.push(G.read()));
        fw.effect(() => res.push(hard(F.read())));
        return (i) => { res.length = 0; fw.withBatch(() => { B.write(1); A.write(1 + i * 2); }); fw.withBatch(() => { A.write(2 + i * 2); B.write(2); }); };
    });
}

// ---------------------------------------------------------------- fan (4) -------------
const FAN_ITERS = process.env.QUICK === "1" ? 1e3 : 50_000;
const SOURCE_COUNT = 128, MUT_PER_STEP = 8, DIRECT_STRIDE = 16;
const nextSeed = (s) => (Math.imul(s, 1664525) + 1013904223) >>> 0;
const makeSources = (fw) => Array.from({ length: SOURCE_COUNT }, (_, i) => fw.signal(i));
const makeTotal = (fw, s) => fw.computed(() => { let sum = 0; for (let i = 0; i < s.length; i++) sum += s[i].read(); return sum; });
const readEvery16th = (s) => { let sum = 0; for (let i = 0; i < SOURCE_COUNT; i += DIRECT_STRIDE) sum += s[i].read(); return sum; };
function mutationRunner(fw, sources, readChecksum) {
    let seed = 0x9e3779b9, value = 0;
    return (iters) => {
        for (let step = 0; step < iters; step++) fw.withBatch(() => {
            const changed = new Set();
            while (changed.size < MUT_PER_STEP) { seed = nextSeed(seed); changed.add(seed % SOURCE_COUNT); }
            for (const idx of changed) sources[idx].write(++value);
        });
        return readChecksum();
    };
}
const fanCases = {
    manyEffectsFromOneSource(fw) {
        const source = fw.signal(0); const doubled = fw.computed(() => source.read() * 2); let checksum = 0;
        for (let i = 0; i < 48; i++) fw.effect(() => { checksum += source.read(); });
        for (let i = 0; i < 48; i++) fw.effect(() => { checksum += doubled.read(); });
        return (iters) => { for (let i = 1; i <= iters; i++) fw.withBatch(() => source.write(i)); return checksum; };
    },
    manySourcesIntoOneComputedEffectWithDirect(fw) {
        const s = makeSources(fw); const total = makeTotal(fw, s); let checksum = 0;
        fw.effect(() => { checksum += total.read(); }); fw.effect(() => { checksum += readEvery16th(s); });
        return mutationRunner(fw, s, () => checksum);
    },
    manySourcesIntoOneComputedEffect(fw) {
        const s = makeSources(fw); const total = makeTotal(fw, s); let checksum = 0;
        fw.effect(() => { checksum += total.read(); });
        return mutationRunner(fw, s, () => checksum);
    },
    manySourcesIntoOneDirectEffect(fw) {
        const s = makeSources(fw); let checksum = 0;
        fw.effect(() => { checksum += readEvery16th(s); });
        return mutationRunner(fw, s, () => checksum);
    },
};

// ---------------------------------------------------------------- sBench (17) ---------
// createComputation helpers. Two corrections vs the first port:
//  (1) cc0 now captures the loop var -- Andrii's is `computed(() => i)`, not `() => 0`.
//      A constant no-capture body compiles to one shared closure, which V8 can prove dead
//      and elide the whole discard loop for a lazy engine (alien collapsed to 0.04ms on
//      Node 26 / M4 while lite paid full cost -- a fake 27000x gap).
//  (2) ANTI-DCE ANCHOR. Andrii's harness discards created nodes; a sufficiently smart JIT
//      then deletes the creation loop for the lazy engine but not the side-effecting one,
//      so the row measures "creation unless the JIT deleted it" -- not comparable across
//      engines or hosts. Each created handle is written into a reused ring buffer (one
//      array write, equal cost for every engine), making the loop observably live. This
//      is the SAME technique the microscope's Float64Array sink uses for propagation; it
//      makes the create rows host-stable. NOTE: this intentionally diverges from Andrii's
//      exact create numbers (his are the un-anchored, DCE-vulnerable values) -- the trade
//      is a meaningful, reproducible measurement over bit-comparability with a fragile ref.
const CREATE_ANCHOR = new Array(1 << 16);
const ANCHOR_MASK = (1 << 16) - 1;
let anchorIdx = 0;
function sbenchHelpers(fw) {
    const createDataSignals = (n, sources) => { for (let i = 0; i < n; i++) sources[i] = fw.signal(i); return sources; };
    const anchor = (c) => { CREATE_ANCHOR[anchorIdx++ & ANCHOR_MASK] = c; return c; };
    const cc0 = (i) => anchor(fw.computed(() => i));
    const cc1 = (get) => anchor(fw.computed(() => get()));
    const cc2 = (g1, g2) => anchor(fw.computed(() => g1() + g2()));
    const cc4 = (g1, g2, g3, g4) => anchor(fw.computed(() => g1() + g2() + g3() + g4()));
    const cc1000 = (ss, off) => anchor(fw.computed(() => { let sum = 0; for (let i = 0; i < 1000; i++) sum += ss[off + i].read(); return sum; }));
    return { createDataSignals, cc0, cc1, cc2, cc4, cc1000 };
}
// (fn, count, scount) rows -- names + params exactly as sBench.sbench() calls them
function sbenchRows() {
    return [
        ["createDataSignals", COUNT, COUNT], ["createComputations0to1", COUNT, 0],
        ["createComputations1to1", COUNT, COUNT], ["createComputations2to1", COUNT / 2, COUNT],
        ["createComputations4to1", COUNT / 4, COUNT], ["createComputations1000to1", COUNT / 1000, COUNT],
        ["createComputations1to2", COUNT, COUNT / 2], ["createComputations1to4", COUNT, COUNT / 4],
        ["createComputations1to8", COUNT, COUNT / 8], ["createComputations1to1000", COUNT, COUNT / 1000],
        ["updateComputations1to1", COUNT * 4, 1], ["updateComputations2to1", COUNT * 2, 2],
        ["updateComputations4to1", COUNT, 4], ["updateComputations1000to1", COUNT / 100, 1000],
        ["updateComputations1to2", COUNT * 4, 1], ["updateComputations1to4", COUNT * 4, 1],
        ["updateComputations1to1000", COUNT * 4, 1],
    ];
}
function sbenchBody(name, fw, H) {
    const { createDataSignals, cc0, cc1, cc2, cc4, cc1000 } = H;
    switch (name) {
        case "createDataSignals": return (n) => { const s = []; createDataSignals(n, s); };
        case "createComputations0to1": return (n) => { for (let i = 0; i < n; i++) cc0(i); };
        case "createComputations1to1": return (n, s) => { for (let i = 0; i < n; i++) cc1(s[i].read); };
        case "createComputations2to1": return (n, s) => { for (let i = 0; i < n; i++) cc2(s[i * 2].read, s[i * 2 + 1].read); };
        case "createComputations4to1": return (n, s) => { for (let i = 0; i < n; i++) cc4(s[i * 4].read, s[i * 4 + 1].read, s[i * 4 + 2].read, s[i * 4 + 3].read); };
        case "createComputations1000to1": return (n, s) => { for (let i = 0; i < n; i++) cc1000(s, i * 1000); };
        case "createComputations1to2": return (n, s) => { for (let i = 0; i < n / 2; i++) { const g = s[i].read; cc1(g); cc1(g); } };
        case "createComputations1to4": return (n, s) => { for (let i = 0; i < n / 4; i++) { const g = s[i].read; cc1(g); cc1(g); cc1(g); cc1(g); } };
        case "createComputations1to8": return (n, s) => { for (let i = 0; i < n / 8; i++) { const g = s[i].read; for (let j = 0; j < 8; j++) cc1(g); } };
        case "createComputations1to1000": return (n, s) => { for (let i = 0; i < n / 1000; i++) { const g = s[i].read; for (let j = 0; j < 1000; j++) cc1(g); } };
        case "updateComputations1to1": return (n, s) => { const g = s[0].read, w = s[0].write; cc1(g); for (let i = 0; i < n; i++) w(i); };
        case "updateComputations2to1": return (n, s) => { const g1 = s[0].read, w = s[0].write, g2 = s[1].read; cc2(g1, g2); for (let i = 0; i < n; i++) w(i); };
        case "updateComputations4to1": return (n, s) => { const w = s[0].write; cc4(s[0].read, s[1].read, s[2].read, s[3].read); for (let i = 0; i < n; i++) w(i); };
        case "updateComputations1000to1": return (n, s) => { const w = s[0].write; cc1000(s, 0); for (let i = 0; i < n; i++) w(i); };
        case "updateComputations1to2": return (n, s) => { const g = s[0].read, w = s[0].write; cc1(g); cc1(g); for (let i = 0; i < n / 2; i++) w(i); };
        case "updateComputations1to4": return (n, s) => { const g = s[0].read, w = s[0].write; cc1(g); cc1(g); cc1(g); cc1(g); for (let i = 0; i < n / 4; i++) w(i); };
        case "updateComputations1to1000": return (n, s) => { const g = s[0].read, w = s[0].write; for (let j = 0; j < 1000; j++) cc1(g); for (let i = 0; i < n / 1000; i++) w(i); };
        default: throw new Error("unknown sbench row " + name);
    }
}

// ---------------------------------------------------------------- runners -------------
// Each returns { time, checksum? }. fw.reset() between rows keeps pool state clean
// (his adapter's resetBenchmark()).
// Andrii's kairoBench times `for (i<1000) iter()` -- a 1000x OUTER loop around each
// case's own internal update loop. Missing it made every kairo row measure 1/1000th of
// the work (sub-ms, noise-dominated). This restores the scale so the rows match his log.
const KAIRO_LOOPS = process.env.QUICK === "1" ? 25 : 1000;
function runKairo(fw, name) {
    const build = kairoCases[name];
    const w = fw.withBuild(() => build(fw)); w(); globalThis.gc?.(); fw.reset();
    const time = measureMedian(() => {
        const iter = fw.withBuild(() => build(fw));
        iter();   // settle (un-timed)
        const t0 = performance.now();
        for (let i = 0; i < KAIRO_LOOPS; i++) iter();
        const t = performance.now() - t0;
        fw.reset();
        return t;
    });
    return { time };
}
function runMol(fw) {
    const w = molBuild(fw); w(1); globalThis.gc?.(); fw.reset();
    const iters = process.env.QUICK === "1" ? 1e3 : 1e4;
    const time = measureMedian(() => { const iter = molBuild(fw); iter(0); const t0 = performance.now(); for (let i = 0; i < iters; i++) iter(i); const t = performance.now() - t0; fw.reset(); return t; });
    return { time };
}
function runFan(fw, name) {
    const build = fanCases[name];
    const w = fw.withBuild(() => build(fw)); w(1000); globalThis.gc?.(); fw.reset();
    let checksum = 0;
    const time = measureMedian(() => { const run = fw.withBuild(() => build(fw)); run(1000); const t0 = performance.now(); checksum = run(FAN_ITERS); const t = performance.now() - t0; fw.reset(); return t; });
    return { time, checksum };
}
function runSbench(fw, name, count, scount) {
    const H = sbenchHelpers(fw); const fn = sbenchBody(name, fw, H);
    const time = measureMedian(() => {
        let out;
        fw.withBuild(() => {
            // warmup x3 at n/100 (his harness), then prepare final sources + cache-warm
            for (let k = 0; k < 3; k++) { const s = H.createDataSignals(scount, []); fn(Math.max(1, count / 100), s); }
            const s = H.createDataSignals(scount, []);
            for (let i = 0; i < scount; i++) s[i].read();
            globalThis.gc?.();
            const t0 = performance.now(); fn(count, s); out = performance.now() - t0;
        });
        fw.reset();
        return out;
    });
    return { time };
}

// ---------------------------------------------------------------- registry ------------
// Full ordered list matching Andrii's log grouping: kairo, fan, mol, sBench.
export function microRows() {
    const rows = [];
    for (const name of Object.keys(kairoCases)) rows.push({ name, group: "kairo", run: (fw) => runKairo(fw, name) });
    for (const name of Object.keys(fanCases)) rows.push({ name, group: "fan", run: (fw) => runFan(fw, name) });
    rows.push({ name: "molBench", group: "mol", run: (fw) => runMol(fw) });
    for (const [name, count, scount] of sbenchRows()) rows.push({ name, group: "s", run: (fw) => runSbench(fw, name, count, scount) });
    return rows;
}
