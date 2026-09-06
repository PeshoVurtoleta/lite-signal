// Port of Andrii's sBench (js-reactivity-benchmark/src/sBench.ts) update group.
// Verbatim from upstream: same warmup protocol (3 runs at n/100), same iteration
// counts, same scenarios. Aggregation per scenario uses median over BENCH_RUNS.
// Single engine per cold process.
import {performance} from "node:perf_hooks";

const [engineDir, mode] = process.argv.slice(2);
if (!engineDir || !mode) {
    console.error("Usage: sbench-runner.mjs <engineDir> <mode>");
    process.exit(2);
}
const BENCH_RUNS = parseInt(process.env.BENCH_RUNS || "10", 10);

const {createRegistry} = await import(`./${engineDir}/Signal.js`);

const cfg = {maxNodes: 200000, maxLinks: 800000, prealloc: "lazy", onCapacityExceeded: "grow"};
if (mode === "sab" && engineDir === "v17") cfg.flushStrategy = "sab";
let r = null;

// Andrii's adapter shape (Signal/Computed exposing .read/.write):
const framework = {
    name: `${engineDir}-${mode}`,
    signal: (initial) => {
        const v = r.signal(initial);
        return {read: v, write: v.set};
    },
    computed: (fn) => ({read: r.computed(fn)}),
    effect: (fn) => r.effect(fn),
    withBatch: (fn) => r.batch(fn),
    withBuild: (fn) => fn(),
};

// Verbatim port of sBench.ts:run()
function run(fn, n, scount) {
    let start = 0, end = 0;
    framework.withBuild(() => {
        // Warmup: 3 runs with small n to JIT-compile hot paths
        let sources = createDataSignals(scount, []);
        fn(n / 100, sources);
        sources = createDataSignals(scount, []);
        fn(n / 100, sources);
        sources = createDataSignals(scount, []);
        fn(n / 100, sources);
        // Final fresh setup
        sources = createDataSignals(scount, []);
        // Warm CPU caches
        for (let i = 0; i < scount; i++) sources[i].read();
        globalThis.gc?.();
        start = performance.now();
        fn(n, sources);
        end = performance.now();
        sources = null;
        globalThis.gc?.();
    });
    return end - start;
}

function createDataSignals(n, sources) {
    for (let i = 0; i < n; i++) sources[i] = framework.signal(i);
    return sources;
}

// Verbatim from sBench.ts:
function updateComputations1to1(n, sources) {
    const {read: get1, write: set1} = sources[0];
    framework.computed(() => get1());
    for (let i = 0; i < n; i++) set1(i);
}

function updateComputations2to1(n, sources) {
    const {read: get1, write: set1} = sources[0], {read: get2} = sources[1];
    framework.computed(() => get1() + get2());
    for (let i = 0; i < n; i++) set1(i);
}

function updateComputations4to1(n, sources) {
    const {read: get1, write: set1} = sources[0], {read: get2} = sources[1],
        {read: get3} = sources[2], {read: get4} = sources[3];
    framework.computed(() => get1() + get2() + get3() + get4());
    for (let i = 0; i < n; i++) set1(i);
}

function updateComputations1000to1(n, sources) {
    const {read: _get1, write: set1} = sources[0];
    framework.computed(() => {
        let sum = 0;
        for (let i = 0; i < 1000; i++) sum += sources[i].read();
        return sum;
    });
    for (let i = 0; i < n; i++) set1(i);
}

function updateComputations1to2(n, sources) {
    const {read: get1, write: set1} = sources[0];
    framework.computed(() => get1());
    framework.computed(() => get1());
    for (let i = 0; i < n; i++) set1(i);
}

function updateComputations1to4(n, sources) {
    const {read: get1, write: set1} = sources[0];
    framework.computed(() => get1());
    framework.computed(() => get1());
    framework.computed(() => get1());
    framework.computed(() => get1());
    for (let i = 0; i < n; i++) set1(i);
}

function updateComputations1to1000(n, sources) {
    const {read: get1, write: set1} = sources[0];
    for (let i = 0; i < 1000; i++) framework.computed(() => get1());
    for (let i = 0; i < n; i++) set1(i);
}

const COUNT = 1e5;
// (fn, n, scount) per Andrii's sBench.ts lines 47-53
const TESTS = [
    [updateComputations1to1, COUNT * 4, 1],
    [updateComputations2to1, COUNT * 2, 2],
    [updateComputations4to1, COUNT, 4],
    [updateComputations1000to1, COUNT / 100, 1000],
    [updateComputations1to2, COUNT * 4, 1],
    [updateComputations1to4, COUNT * 4, 1],
    [updateComputations1to1000, COUNT, 1],
];

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)];
}

function p95(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.95)];
}

const results = {};
for (const [fn, n, scount] of TESTS) {
    // Each "sample" is a full run() (with its own internal warmup + GC + measurement)
    const samples = [];
    // Outer warmup: 2 throwaway runs to pre-warm V8 across consecutive same-test runs
    r = createRegistry(cfg);
    run(fn, n, scount);
    r.destroy();
    r = createRegistry(cfg);
    run(fn, n, scount);
    r.destroy();
    for (let i = 0; i < BENCH_RUNS; i++) {
        r = createRegistry(cfg);
        try {
            samples.push(run(fn, n, scount));
        } finally {
            r.destroy();
        }
    }
    results[fn.name] = {
        n, scount,
        samples: samples.map(x => +x.toFixed(3)),
        min: +Math.min(...samples).toFixed(3),
        median: +median(samples).toFixed(3),
        p95: +p95(samples).toFixed(3),
    };
}

console.log(JSON.stringify({version: engineDir, mode, BENCH_RUNS, results}));
