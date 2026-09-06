import { performance } from "node:perf_hooks";

const [engineDir, mode, scenarioKey] = process.argv.slice(2);
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Engines live in the PRIVATE, gitignored ./engines/ dir (v18..v112 are unreleased).
// Resolve from THIS file so the sweep does not depend on the caller's cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const enginePath = resolve(HERE, "engines", engineDir, "Signal.js");
const { createRegistry } = await import(pathToFileURL(enginePath).href);

const WARMUP = 5;
const RUNS = 7;
const ITERATIONS = 20_000;
const SINK_SIZE = 4096;
const SINK = new Float64Array(SINK_SIZE);
globalThis.__BENCH_SINK = SINK;

// MODES
//   eager     -- default registry, effects deliver on every set (pre-1.7 semantics)
//   sab       -- flushStrategy "sab": effects deliver at batch exit; drive is batch-wrapped
//   settled   -- sab + createRegistry({settled:true})  [1.11.0+]  measures the settle tail ON
//   trace     -- sab + createRegistry({trace:true})    [1.12.0+]  measures the trace twin ON
//
// FIX (was the silent corrupter): the old line read
//     if (mode === "sab" && engineDir === "v17") base.flushStrategy = "sab";
// so ONLY v17 ever got flushStrategy:"sab". Every later engine (v18/v19/v110/v111/v112)
// was labelled "sab" in COMBOS -- and therefore had its drive batch-wrapped -- while its
// registry was silently built EAGER. That is a different workload than the column claims,
// and it is the most likely source of the "broadcast cliff at 1.8.0". Now: mode decides.
function mkCfg(N) {
    const base = { maxNodes: N + 64, maxLinks: N * 8 + 256, prealloc: "eager", onCapacityExceeded: "grow" };
    if (mode !== "eager") base.flushStrategy = "sab";
    if (mode === "settled") base.settled = true;
    if (mode === "trace") base.trace = true;
    return base;
}

// Any non-eager mode delivers effects at batch exit, so each drive() is one batch --
// apples to apples with eager (which delivers on every set).
function wrapDrive(r, drive) {
    if (mode !== "eager") return (i) => r.batch(() => drive(i));
    return drive;
}

const SCENARIOS = {
    kairos: { N: 1000, setup(N, sink) {
        const r = createRegistry(mkCfg(N));
        const src = r.signal(0);
        const cs = new Array(N);
        for (let i = 0; i < N; i++) { const k = i; cs[i] = r.computed(() => src() * (k + 1)); }
        r.effect(() => { let s = 0; for (let i = 0; i < N; i++) s += cs[i](); SINK[sink] = s; });
        return { drive: wrapDrive(r, (i) => src.set(i)), teardown: () => r.destroy(), checkSink: () => SINK[sink] };
    }},
    broadcast: { N: 1000, setup(N, sink) {
        const r = createRegistry(mkCfg(N));
        const src = r.signal(0);
        for (let i = 0; i < N; i++) { const k = i; r.effect(() => { SINK[sink + (k & 31)] = src() + k; }); }
        return { drive: wrapDrive(r, (i) => src.set(i)), teardown: () => r.destroy(), checkSink: () => SINK[sink] };
    }},
    deepChain: { N: 256, setup(N, sink) {
        const r = createRegistry(mkCfg(N));
        const src = r.signal(0);
        let prev = src;
        for (let i = 0; i < N; i++) { const p = prev; prev = r.computed(() => p() + 1); }
        const tip = prev;
        r.effect(() => { SINK[sink] = tip(); });
        return { drive: wrapDrive(r, (i) => src.set(i)), teardown: () => r.destroy(), checkSink: () => SINK[sink] };
    }},
    mux: { N: 256, setup(N, sink) {
        const r = createRegistry(mkCfg(N));
        const sigs = new Array(N);
        for (let i = 0; i < N; i++) sigs[i] = r.signal(0);
        const sum = r.computed(() => { let s = 0; for (let i = 0; i < N; i++) s += sigs[i](); return s; });
        r.effect(() => { SINK[sink] = sum(); });
        return { drive: wrapDrive(r, (i) => sigs[i % N].set(i)), teardown: () => r.destroy(), checkSink: () => SINK[sink] };
    }},
    // No-effect update tests (Andrii sBench shape): nothing to deliver, no batch wrap
    // needed -- this is the SAB design's strong case.
    upd1to1: { N: 400_000, setup(N, sink) {
        const r = createRegistry(mkCfg(8));
        const sig = r.signal(0);
        r.computed(() => sig());
        return { drive: (i) => sig.set(i), teardown: () => r.destroy(), checkSink: () => null };
    }},
    upd1to4: { N: 400_000, setup(N, sink) {
        const r = createRegistry(mkCfg(8));
        const sig = r.signal(0);
        for (let k = 0; k < 4; k++) { const idx = k; r.computed(() => sig() * idx); }
        return { drive: (i) => sig.set(i), teardown: () => r.destroy(), checkSink: () => null };
    }},
    // CAPABILITY-ON shapes (1.11.0 / 1.12.0). Run these under mode=settled / mode=trace
    // against the SAME shape under mode=sab to price the capability when it is ON.
    // "Zero cost when off" is proven by byte-identity; this measures the cost when on.
    //
    // fanout: one source, 64 effects -> one drain per batch, 64 effect runs per drain.
    // Under settled: one settle tail per drain (NOT per effect) -- the coalescing claim.
    // Under trace:   64 op-8 duration records + op-5/6/7 events per drain -- the ring cost.
    fanout64: { N: 64, setup(N, sink) {
        const r = createRegistry(mkCfg(N));
        const src = r.signal(0);
        for (let i = 0; i < N; i++) { const k = i; r.effect(() => { SINK[sink + (k & 31)] = src() + k; }); }
        const settledCount = { n: 0 };
        if (mode === "settled") r.onSettled(() => { settledCount.n++; });
        return { drive: wrapDrive(r, (i) => src.set(i)), teardown: () => r.destroy(), checkSink: () => SINK[sink] };
    }},
    // churn: dynamic topology -- a conditional dep flips every iteration, so links are
    // allocated/severed continuously. The shape the offense track cares about, and the
    // one where trace's op-3/op-4 link events fire hardest.
    churn: { N: 64, setup(N, sink) {
        const r = createRegistry(mkCfg(N * 2));
        const gate = r.signal(0);
        const a = new Array(N);
        const b = new Array(N);
        for (let i = 0; i < N; i++) { a[i] = r.signal(i); b[i] = r.signal(i + N); }
        const sum = r.computed(() => {
            const on = (gate() & 1) === 0;
            let s = 0;
            for (let i = 0; i < N; i++) s += on ? a[i]() : b[i]();
            return s;
        });
        r.effect(() => { SINK[sink] = sum(); });
        return { drive: wrapDrive(r, (i) => gate.set(i)), teardown: () => r.destroy(), checkSink: () => SINK[sink] };
    }},
};

function median(arr) { const s = [...arr].sort((a,b) => a-b); return s[Math.floor(s.length/2)]; }
function p95(arr) { const s = [...arr].sort((a,b) => a-b); return s[Math.floor(s.length*0.95)]; }
function mean(arr) { return arr.reduce((a,b) => a+b, 0) / arr.length; }

const sc = SCENARIOS[scenarioKey];
const iters = scenarioKey.startsWith("upd") ? sc.N : ITERATIONS;
const { drive, teardown, checkSink } = sc.setup(sc.N, 7);
try {
    for (let w = 0; w < WARMUP; w++) for (let i = 0; i < iters; i++) drive(i);
    globalThis.gc?.(); globalThis.gc?.();
    const samples = [];
    for (let r = 0; r < RUNS; r++) {
        const t0 = performance.now();
        for (let i = 0; i < iters; i++) drive(i);
        samples.push(performance.now() - t0);
    }
    const sinkOk = checkSink === null || checkSink() !== 0;
    const result = {
        version: engineDir, mode, scenario: scenarioKey,
        iterations: iters, samples: samples.map(x => +x.toFixed(3)),
        min: +Math.min(...samples).toFixed(3),
        median: +median(samples).toFixed(3),
        p95: +p95(samples).toFixed(3),
        mean: +mean(samples).toFixed(3),
        sinkOk,
    };
    console.log(JSON.stringify(result));
} finally { teardown(); }
