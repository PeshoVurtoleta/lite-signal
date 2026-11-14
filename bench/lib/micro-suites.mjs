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
// Rows, fixtures, bodies and validation of js-reactivity-benchmark src/sBench.ts at fb10dd9.
// Create rows (:105-153): setup resets the framework, builds the sources and allocates the
// `nodes` array; the timed call creates every node, reads it (initialisation and dependency
// tracking are part of creation for lazy and eager engines alike), retains it in `nodes` and
// sums the reads; validate throws unless the checksum equals his closed form (his `nodes.length`
// check is kept verbatim; `nodes` is preallocated at row.nodes, so it cannot see a dropped node).
// Every created node stays reachable from the result and every read feeds the
// checksum, so no JIT can delete the creation loop for one engine and not another.
// Update rows (:155-195): every write is followed by a read of every consumer; the checksum
// is validated against his closed form the same way. Writes start at 1 so each one changes
// the source.
function makeComputation(fw, sources, fanIn, offset, constant) {
    if (fanIn === 0) return fw.computed(() => constant);
    if (fanIn === 1) { const source = sources[offset]; return fw.computed(() => source.read()); }
    return fw.computed(() => {
        let sum = 0;
        for (let i = 0; i < fanIn; i++) sum += sources[offset + i].read();
        return sum;
    });
}
// sBench.ts:35-103, names and parameters verbatim (COUNT = his 1e5; QUICK shrinks it).
function sbenchRows() {
    const creation = [
        { name: "createDataSignals", nodes: COUNT, sources: 0, fanIn: 0, fanOut: 1, signals: true },
        { name: "createComputations0to1", nodes: COUNT, sources: 0, fanIn: 0, fanOut: 1 },
        { name: "createComputations1to1", nodes: COUNT, sources: COUNT, fanIn: 1, fanOut: 1 },
        { name: "createComputations2to1", nodes: COUNT / 2, sources: COUNT, fanIn: 2, fanOut: 1 },
        { name: "createComputations4to1", nodes: COUNT / 4, sources: COUNT, fanIn: 4, fanOut: 1 },
        { name: "createComputations1000to1", nodes: COUNT / 1000, sources: COUNT, fanIn: 1000, fanOut: 1 },
        ...[2, 4, 8, 1000].map((fanOut) => (
            { name: `createComputations1to${fanOut}`, nodes: COUNT, sources: COUNT / fanOut, fanIn: 1, fanOut })),
    ].map((row) => ({ ...row, kind: "create" }));
    const update = [
        { name: "updateComputations1to1", writes: COUNT * 4, fanIn: 1, fanOut: 1 },
        { name: "updateComputations2to1", writes: COUNT * 2, fanIn: 2, fanOut: 1 },
        { name: "updateComputations4to1", writes: COUNT, fanIn: 4, fanOut: 1 },
        { name: "updateComputations1000to1", writes: COUNT / 100, fanIn: 1000, fanOut: 1 },
        ...[2, 4, 1000].map((fanOut) => (
            { name: `updateComputations1to${fanOut}`, writes: (COUNT * 4) / fanOut, fanIn: 1, fanOut })),
    ].map((row) => ({ ...row, kind: "update" }));
    return [...creation, ...update];
}
// One sBench case as his registerBenchmark sees it: setup / benchmark / validate.
function sbenchCase(fw, row) {
    if (row.kind === "create") return {
        setup() {
            fw.reset();
            return fw.withBuild(() => ({
                sources: Array.from({ length: row.sources }, (_, i) => fw.signal(i)),
                nodes: new Array(row.nodes),
            }));
        },
        benchmark({ sources, nodes }) {
            return fw.withBuild(() => {
                let checksum = 0;
                for (let i = 0; i < row.nodes; i++) {
                    const node = row.signals
                        ? fw.signal(i)
                        : makeComputation(fw, sources, row.fanIn, Math.floor(i / row.fanOut) * row.fanIn, i);
                    nodes[i] = node;
                    checksum += node.read();
                }
                return { nodes, checksum };
            });
        },
        validate({ nodes, checksum }) {
            const expected = row.signals || row.fanIn === 0
                ? (row.nodes * (row.nodes - 1)) / 2
                : (row.fanOut * row.sources * (row.sources - 1)) / 2;
            if (nodes.length !== row.nodes || checksum !== expected) {
                throw new Error(`${row.name}: creation checksum ${checksum}, expected ${expected}`);
            }
        },
    };
    return {
        setup() {
            fw.reset();
            return fw.withBuild(() => {
                const sources = Array.from({ length: row.fanIn }, (_, i) => fw.signal(i));
                const nodes = Array.from({ length: row.fanOut }, () => makeComputation(fw, sources, row.fanIn, 0, 0));
                for (const node of nodes) node.read();
                return { sources, nodes };
            });
        },
        benchmark({ sources, nodes }) {
            let checksum = 0;
            for (let value = 1; value <= row.writes; value++) {
                sources[0].write(value);
                for (const node of nodes) checksum += node.read();
            }
            return checksum;
        },
        validate(checksum) {
            const unchangedSources = (row.fanIn * (row.fanIn - 1)) / 2;
            const expected = row.fanOut * ((row.writes * (row.writes + 1)) / 2 + row.writes * unchangedSources);
            if (checksum !== expected) {
                throw new Error(`${row.name}: update checksum ${checksum}, expected ${expected}`);
            }
        },
    };
}
// his blackholeSink (util/benchmark.ts:704): the last result stays reachable until the next
// invocation's setup.
const SBENCH_SINK = { value: undefined };

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
// his measureCase (util/benchmark.ts:707-816), default quick profile (:197): each invocation
// is reset + setup, a full GC, then the timed benchmark; every result is validated (a mismatch
// throws). One untimed pilot and SBENCH_WARMUP untimed warmups at full size precede the
// BENCH_RUNS timed samples; the median is reported. His default profile also keeps sampling until
// >= 10 samples and >= 250 ms (max 100); runSbench takes BENCH_RUNS samples instead (5, or 1 under QUICK).
const SBENCH_WARMUP = 2;
function runSbench(fw, row) {
    const c = sbenchCase(fw, row);
    const invoke = () => {
        SBENCH_SINK.value = undefined;
        const fixture = c.setup();
        globalThis.gc?.();
        const t0 = performance.now();
        const result = c.benchmark(fixture);
        const t = performance.now() - t0;
        c.validate(result);
        SBENCH_SINK.value = result;
        return t;
    };
    for (let k = 0; k <= SBENCH_WARMUP; k++) invoke();
    const time = measureMedian(invoke);
    SBENCH_SINK.value = undefined;
    fw.reset();
    return { time };
}

// ---------------------------------------------------------------- registry ------------
// Full ordered list matching Andrii's log grouping: kairo, fan, mol, sBench.
export function microRows() {
    const rows = [];
    for (const name of Object.keys(kairoCases)) rows.push({ name, group: "kairo", run: (fw) => runKairo(fw, name) });
    for (const name of Object.keys(fanCases)) rows.push({ name, group: "fan", run: (fw) => runFan(fw, name) });
    rows.push({ name: "molBench", group: "mol", run: (fw) => runMol(fw) });
    for (const row of sbenchRows()) rows.push({ name: row.name, group: "s", run: (fw) => runSbench(fw, row) });
    return rows;
}
