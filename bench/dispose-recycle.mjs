/**
 * dispose-recycle microbench — isolates the create / dispose / recreate cycle
 * that the 1.2.2 clean-free-list-invariant audit targets.
 *
 * Per Zahary's correctness note: EVERY framework is medianed the same way
 * (10 runs, median run by total time). On a 10-year-old MacBook a single run
 * can spike from a GC pause; medianing all frameworks identically is the only
 * fair comparison. Reports each framework's median run side by side.
 *
 * lite-signal is pre-sized (maxNodes / maxLinks) so the timed window is pure
 * allocation/recycle mechanics with no pool-growth array-copy penalty. The
 * nursery-allocated libraries (alien, preact) have no equivalent knob — they
 * allocate into the V8 heap and pay GC pressure, which is the point of the
 * comparison.
 *
 * Run:  node --expose-gc dispose-recycle.mjs
 *       FW=lite-signal,alien-signals node --expose-gc dispose-recycle.mjs
 */

const N = 100_000;
const WARMUP_RUNS = 3;
const ACTUAL_RUNS = 10;

const SELECTED = (process.env.FW || "lite-signal,alien-signals,preact").split(",").map(s => s.trim());

// ─── adapters ────────────────────────────────────────────────────────────────
// Each adapter exposes: setup() -> { createSignal, dispose, supportsDispose }
// createSignal(i) returns a handle; dispose(handle) tears it down (or no-op if
// the library has no manual disposal — in which case recreate measures fresh
// allocation against a GC'd heap, still a fair number).

const adapters = {
    "lite-signal": async () => {
        const { createRegistry } = await import("../Signal.js");
        let registry;
        return {
            supportsDispose: true,
            fresh() { registry = createRegistry({ maxNodes: N + 1000, maxLinks: N * 2 }); },
            createSignal: (i) => registry.signal(i),
            dispose: (h) => registry.dispose(h),
        };
    },
    "alien-signals": async () => {
        const mod = await import("alien-signals");
        const signal = mod.signal || (mod.default && mod.default.signal);
        return {
            supportsDispose: false,   // alien has no manual node disposal; recreate = fresh alloc
            fresh() {},
            createSignal: (i) => signal(i),
            dispose: (_h) => {},
        };
    },
    "preact": async () => {
        const { signal } = await import("@preact/signals-core");
        return {
            supportsDispose: false,
            fresh() {},
            createSignal: (i) => signal(i),
            dispose: (_h) => {},
        };
    },
};

function benchOne(adapter) {
    adapter.fresh();
    const handles = new Array(N);

    const t0 = performance.now();
    for (let i = 0; i < N; i++) handles[i] = adapter.createSignal(i);
    const t1 = performance.now();

    for (let i = 0; i < N; i++) adapter.dispose(handles[i]);
    const t2 = performance.now();

    for (let i = 0; i < N; i++) handles[i] = adapter.createSignal(i);
    const t3 = performance.now();

    // anti-DCE: touch the array so V8 can't elide the recreate loop
    let acc = 0;
    for (let i = 0; i < N; i += 4096) acc += (typeof handles[i] === "function" ? 1 : 0);
    if (acc < 0) console.log("unreachable", acc);

    return { creation: t1 - t0, dispose: t2 - t1, recreate: t3 - t2, total: t3 - t0 };
}

function medianRun(runs) {
    runs.sort((a, b) => a.total - b.total);
    return runs[Math.floor(runs.length / 2)];
}

async function run() {
    console.log(`dispose-recycle microbench  |  N=${N.toLocaleString()}  warmup=${WARMUP_RUNS}  runs=${ACTUAL_RUNS}  (median run by total)`);
    console.log(`Node ${process.version}\n`);

    const results = {};
    for (const fw of SELECTED) {
        if (!adapters[fw]) { console.log(`(skip ${fw}: no adapter)`); continue; }
        let adapter;
        try { adapter = await adapters[fw](); }
        catch (e) { console.log(`(skip ${fw}: ${e.message})`); continue; }

        for (let i = 0; i < WARMUP_RUNS; i++) benchOne(adapter);
        if (global.gc) global.gc();

        const runs = [];
        for (let i = 0; i < ACTUAL_RUNS; i++) {
            runs.push(benchOne(adapter));
            if (global.gc) global.gc();
        }
        results[fw] = { median: medianRun(runs), disposeReal: adapter.supportsDispose };
    }

    const cols = ["creation", "dispose", "recreate", "total"];
    const pad = (s, n) => String(s).padStart(n);
    console.log(`${"framework".padEnd(16)} ${cols.map(c => pad(c, 12)).join(" ")}   dispose?`);
    console.log("-".repeat(16 + 13 * 4 + 12));
    for (const fw of SELECTED) {
        const r = results[fw];
        if (!r) continue;
        const m = r.median;
        const row = cols.map(c => pad(m[c].toFixed(2) + "ms", 12)).join(" ");
        console.log(`${fw.padEnd(16)} ${row}   ${r.disposeReal ? "real" : "no-op (fresh alloc)"}`);
    }

    // Head-to-head on the recreate (warm recycle) column — the row the audit targets
    if (results["lite-signal"] && results["alien-signals"]) {
        const lite = results["lite-signal"].median;
        const alien = results["alien-signals"].median;
        console.log(`\nWarm recreate, lite vs alien: ${lite.recreate.toFixed(1)}ms vs ${alien.recreate.toFixed(1)}ms ` +
            `(${lite.recreate < alien.recreate ? "lite +" + ((alien.recreate / lite.recreate - 1) * 100).toFixed(0) + "%" : "alien +" + ((lite.recreate / alien.recreate - 1) * 100).toFixed(0) + "%"})`);
    }
}

run().catch(e => {
    console.error(e);
});