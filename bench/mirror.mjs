// bench/mirror.mjs -- the ECOSYSTEM MIRROR. Reproduces Andrii's dynamic suite so local
// rows diff 1:1 against his log. This file's job is fidelity, not flattery: the lite
// adapter uses HIS canonical config verbatim (lazy / 131072 / 1048576 / default eager
// flush / destroy()+rebuild between benches), because the only way the rows are
// comparable is byte-identical setup.
//
//   node --expose-gc bench/mirror.mjs                 # lite + alien, full
//   FW=lite-signal node --expose-gc bench/mirror.mjs  # one engine (isolated protocol)
//   QUICK=1 node --expose-gc bench/mirror.mjs          # fast smoke
//   node --expose-gc bench/mirror.mjs --self-verify    # counters vs the document, then exit
//
// Output: his 4-column CSV `framework , test , time , metrics`, preceded by a machine
// stamp. Metrics carry counters (nodesRecomputed/nodesVisited/edgesTraversed/sinkReads)
// and, on lite rows, the pool fingerprint (flushPasses/poolGrowths). SLOW/CAPPED rows
// carry `SLOW/CAPPED samples=N ceiling=Xms` exactly as his log marks them.

import { performance } from "node:perf_hooks";
import { createRegistry } from "../Signal.js";
import { makeGraph, runGraph, Counter } from "./lib/depgraph.mjs";
import { DYNAMIC_TESTS, scaleQuick } from "./lib/mirror-config.mjs";
import { microRows } from "./lib/micro-suites.mjs";
import { summarizeSamples } from "./lib/stats.mjs";
import { makeStamp, printStamp, formatStampLine, PROTOCOLS } from "./lib/stamp.mjs";
import { testColumn } from "./lib/title.mjs";
import * as G from "./lib/guards.mjs";

const QUICK = process.env.QUICK === "1";
const FW = process.env.FW ? new Set(process.env.FW.split(",").map((s) => s.trim())) : null;
const SELF_VERIFY = process.argv.includes("--self-verify");
// Child mode for per-row isolation (Session 3): a parent forks one process per
// (engine, scenario). SCENARIO selects the single row; ROWS_ONLY suppresses the pretty
// stamp block + header so the parent captures just `#STAMP` + the data row.
const SCENARIO = process.env.SCENARIO || null;
const ROWS_ONLY = process.env.ROWS_ONLY === "1";

// A row that exceeds this wall-clock ceiling is measured ONCE and marked SLOW/CAPPED,
// so a pathologically slow engine (vue/solid on the app shapes) doesn't stall the sweep.
// Matches the `ceiling=...ms samples=1` marker in his log.
const CEILING_MS = QUICK ? 400 : 1500;
const REPEATS = QUICK ? 1 : 3;

// --- his canonical lite adapter config, as one frozen reference (single-reference rule) --
const LITE_CONFIG = Object.freeze({ maxNodes: 131072, maxLinks: 1048576, prealloc: "lazy", onCapacityExceeded: "grow" });

function liteAdapter() {
    let reg = createRegistry(LITE_CONFIG);
    return {
        name: "lite-signal",
        signal: (v) => { const s = reg.signal(v); return { read: s, write: s.set }; },
        computed: (fn) => ({ read: reg.computed(fn) }),
        effect: (fn) => { reg.effect(fn); },
        withBatch: (fn) => reg.batch(fn),
        withBuild: (fn) => fn(),
        // his resetBenchmark(): destroy AND rebuild a fresh registry between benches
        reset() { reg.destroy(); reg = createRegistry(LITE_CONFIG); },
        // lite-only pool fingerprint for the metrics column (free; absent on ref engines)
        // Emit only counters this stats() shape actually carries: 1.5.0 has no
        // flushPasses key, and "flushPasses=undefined" in the metrics column
        // broke the pool fingerprint the header promises (2026-08 review).
        poolMetrics() {
            const s = reg.stats();
            const out = { poolGrowths: s.poolGrowths };
            if (typeof s.flushPasses === "number") out.flushPasses = s.flushPasses;
            return out;
        },
    };
}

async function alienAdapter() {
    let alien;
    try { alien = await import("alien-signals"); } catch { return null; }
    const { signal, computed, effect, startBatch, endBatch } = alien;
    return {
        name: "alien-signals",
        signal: (v) => { const s = signal(v); return { read: () => s(), write: (x) => s(x) }; },
        computed: (fn) => { const c = computed(fn); return { read: () => c() }; },
        effect: (fn) => { effect(() => { fn(); }); },
        withBatch: (fn) => { startBatch(); try { fn(); } finally { endBatch(); } },
        withBuild: (fn) => fn(),
        reset() {},
        poolMetrics() { return null; },
    };
}

// --- measured run of one config on one framework -------------------------------------
function measureOnce(framework, cfg) {
    const counter = new Counter();
    const graph = makeGraph(framework, cfg, counter);
    const warm = cfg.warmupIterations || 0;
    if (warm) runGraph(graph, { ...cfg, iterations: warm, startTick: 0 }, framework);
    counter.reset();
    globalThis.gc?.();
    const t0 = performance.now();
    const sum = runGraph(graph, { ...cfg, startTick: warm * (cfg.updatesPerIteration || 1) }, framework);
    const time = performance.now() - t0;
    globalThis.gc?.();
    return { time, sum, snapshot: counter.snapshot() };
}

// Repeat until either REPEATS samples or the ceiling is hit; report median (or the
// single capped sample). Returns { time, capped, samples, snapshot, sum }.
function measure(framework, cfg) {
    const times = [];
    let last = null;
    for (let i = 0; i < REPEATS; i++) {
        last = measureOnce(framework, cfg);
        times.push(last.time);
        framework.reset();
        if (last.time > CEILING_MS) return { time: last.time, capped: true, samples: 1, snapshot: last.snapshot, sum: last.sum };
    }
    return { time: summarizeSamples(times).median, capped: false, samples: times.length, snapshot: last.snapshot, sum: last.sum };
}

// --- CSV row (his 4-column format) ---------------------------------------------------
function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }
function metricsStr(res, pool, capped) {
    const parts = [];
    if (capped) parts.push(`SLOW/CAPPED samples=1 ceiling=${Math.round(CEILING_MS)}ms`);
    const s = res.snapshot;
    parts.push(`nodesRecomputed=${s.nodesRecomputed} nodesVisited=${s.nodesVisited} edgesTraversed=${s.edgesTraversed} sinkReads=${s.sinkReads}`);
    if (pool) parts.push(`flushPasses=${pool.flushPasses} poolGrowths=${pool.poolGrowths}`);
    return parts.join(" ");
}
function emitRow(fwName, cfg, res, pool) {
    console.log([pad(fwName, 22), pad(testColumn(cfg), 60), pad(res.time.toFixed(2), 8), metricsStr(res, pool, res.capped)].join(" , "));
}

// --- self-verify: counters vs the document -------------------------------------------
async function runSelfVerify() {
    const EXP = {
        "dashboard selective reads": { nodesRecomputed: 2642029, edgesTraversed: 10568081, sinkReads: 960008 },
        "editor derived state": { nodesRecomputed: 4736332, edgesTraversed: 14208887, sinkReads: 900010 },
        "kanban board": { nodesRecomputed: 1765496, edgesTraversed: 8827231, sinkReads: 660022 },
        "entity detail page": { nodesRecomputed: 3984210, edgesTraversed: 15936789, sinkReads: 720024 },
        "large web app": { nodesRecomputed: 1473786, edgesTraversed: 5891713, sinkReads: 7001000 },
        "wide dense": { nodesRecomputed: 735756, edgesTraversed: 18393900, sinkReads: 3001000 },
        "layered burst flush warm": { nodesRecomputed: 1529088, edgesTraversed: 12232704, sinkReads: 49664 },
        "stable diamond mesh warm": { nodesRecomputed: 24576, edgesTraversed: 196608, sinkReads: 49664 },
    };
    const fw = liteAdapter();
    let fail = 0;
    for (const cfg of DYNAMIC_TESTS) {
        const exp = EXP[cfg.name];
        if (!exp) continue;
        const res = measureOnce(fw, cfg);
        fw.reset();
        const s = res.snapshot;
        const ok = s.nodesRecomputed === exp.nodesRecomputed && s.edgesTraversed === exp.edgesTraversed && s.sinkReads === exp.sinkReads;
        console.log(`${ok ? "MATCH" : "DIFF "} ${pad(cfg.name, 26)} nodes ${s.nodesRecomputed}/${exp.nodesRecomputed}  edges ${s.edgesTraversed}/${exp.edgesTraversed}  sink ${s.sinkReads}/${exp.sinkReads}`);
        if (!ok) fail++;
    }
    console.log(`\n${fail === 0 ? "SELF-VERIFY PASS: counters match the document" : "SELF-VERIFY FAIL: " + fail}`);
    process.exitCode = fail === 0 ? 0 : 1;
}

// --- main ----------------------------------------------------------------------------
async function main() {
    if (SELF_VERIFY) { await runSelfVerify(); return; }

    const stamp = makeStamp({
        enginePath: new URL("../Signal.js", import.meta.url).href,
        harnessPath: import.meta.url,
        config: LITE_CONFIG,
        protocol: (FW && FW.size === 1 && SCENARIO) ? PROTOCOLS.PER_ROW : (FW && FW.size === 1 ? PROTOCOLS.PER_ROW : PROTOCOLS.PER_ENGINE),
        reps: REPEATS,
        extra: { ceiling_ms: CEILING_MS, quick: QUICK, adapter: "andrii-canonical", scenario: SCENARIO || "all" },
    });
    if (ROWS_ONLY) {
        // child mode: machine stamp line + rows, no pretty block, no header
        console.log(formatStampLine(stamp));
    } else {
        printStamp(stamp);
        console.log(["framework".padEnd(22), "test".padEnd(60), "time".padEnd(8), "metrics"].join(" , "));
    }

    let tests = scaleQuick(DYNAMIC_TESTS, QUICK);
    if (SCENARIO) tests = tests.filter((t) => t.name === SCENARIO);
    // SCENARIO may name a dynamic shape OR a micro-suite row; only error if neither.
    if (SCENARIO && tests.length === 0 && !microRows().some((r) => r.name === SCENARIO)) {
        console.error("unknown scenario: " + SCENARIO); process.exitCode = 2; return;
    }
    const adapters = [];
    if (!FW || FW.has("lite-signal")) adapters.push(liteAdapter());
    if (!FW || FW.has("alien-signals")) { const a = await alienAdapter(); if (a) adapters.push(a); }

    const verdict = G.makeVerdict();
    const byTest = new Map();   // edgesTraversed, for counter-agreement across engines
    const sumByTest = new Map();  // res.sum, for RESULT-agreement across engines

    for (const fw of adapters) {
        for (const cfg of tests) {
            const res = measure(fw, cfg);
            const pool = fw.poolMetrics();
            emitRow(fw.name, cfg, res, pool);
            // CORRECTNESS: instead of comparing res.sum against a hand-transcribed
            // `expected` constant (which drifts -- his config.ts vectors are stale vs his
            // own current log, e.g. simple-component count 2640004 in config vs 3180010 in
            // the log), we compare engines against EACH OTHER. If lite and alien produce
            // the same sum on the same shape, both did the shape correctly -- a stronger,
            // self-maintaining check that needs no external oracle (same spirit as the
            // counter-agreement and checksum guards).
            if (!byTest.has(cfg.name)) byTest.set(cfg.name, []);
            byTest.get(cfg.name).push({ framework: fw.name, value: res.snapshot.edgesTraversed });
            if (res.sum !== undefined && res.sum !== null) {
                if (!sumByTest.has(cfg.name)) sumByTest.set(cfg.name, []);
                sumByTest.get(cfg.name).push({ framework: fw.name, value: res.sum });
            }
        }
    }
    // --- micro-suites (kairo / fan / mol / sBench): the other 30 rows of the field ----
    // Timing-only shapes (no dependency-graph counters); fan rows carry a checksum that
    // must agree across engines (checksum guard). Together with the dynamic rows above
    // this is the full 47-row js-reactivity-benchmark field -- benchmarkReactive.mjs is
    // now redundant and retired.
    let micro = microRows();
    if (SCENARIO) micro = micro.filter((r) => r.name === SCENARIO);
    const fanChecksums = new Map();  // row -> [{framework, checksum}]
    for (const fw of adapters) {
        for (const r of micro) {
            const out = r.run(fw);
            const metrics = out.checksum !== undefined ? `checksum=${out.checksum}` : "";
            console.log([pad(fw.name, 22), pad(r.name, 60), pad(out.time.toFixed(2), 8), metrics].join(" , "));
            if (out.checksum !== undefined) {
                if (!fanChecksums.has(r.name)) fanChecksums.set(r.name, []);
                fanChecksums.get(r.name).push({ framework: fw.name, checksum: out.checksum });
            }
        }
    }
    for (const [row, entries] of fanChecksums) G.checkChecksum(verdict, row, entries);

    // counter-agreement guard across engines (skip solid/s-js semantics-divergent rows; not run here)
    for (const [test, rows] of byTest) G.checkCounterAgreement(verdict, test, "edgesTraversed", rows);
    // result-agreement guard: same sum across engines = the shape computed correctly
    for (const [test, rows] of sumByTest) G.checkCounterAgreement(verdict, test, "sum", rows);

    if (ROWS_ONLY) {
        // child: emit any guard failures as machine lines for the parent to collect
        for (const f of verdict.failures) console.log("#GUARD " + f);
        if (!verdict.ok) process.exitCode = 1;
    } else {
        G.reportVerdict(verdict);
    }
}

main();
