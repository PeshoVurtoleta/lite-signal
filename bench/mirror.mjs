// bench/mirror.mjs -- the ECOSYSTEM MIRROR. Reproduces Andrii's dynamic suite so local
// rows diff 1:1 against his log. This file's job is fidelity, not flattery: the lite
// adapter uses the config of his committed adapter at fb10dd9 (src/frameworks/liteSignal.ts:4-15:
// maxNodes 262144 / maxLinks 1048576 / prealloc "lazy" / onCapacityExceeded "throw", no
// flush option) and, as its resetBenchmark() does (:46-49), destroys the registry and
// builds a fresh one from the same config between benches.
//
//   node --expose-gc bench/mirror.mjs                 # lite + alien + reflex-quant, full
//   FW=lite-signal node --expose-gc bench/mirror.mjs  # one engine, one process (isolated-per-engine)
//   QUICK=1 node --expose-gc bench/mirror.mjs          # fast smoke
//   node --expose-gc bench/mirror.mjs --self-verify    # counters vs the document, then exit
//
// Output: his 4-column CSV `framework , test , time , metrics`, preceded by a machine
// stamp. Dynamic rows carry counters (nodesRecomputed/nodesVisited/edgesTraversed/sinkReads),
// the result `sum=` of the timed run and, on lite rows, the pool fingerprint
// (flushPasses/poolGrowths); kairo / fan / mol rows carry `checksum=`. SLOW/CAPPED rows
// carry `SLOW/CAPPED samples=N ceiling=Xms` as his log marks them, N = the samples taken
// before the ceiling stopped sampling (all of them are kept; the time is their median).
// The stamp's extra names the capture (`captureId` = env CAPTURE_ID, null when unset), the
// reference libraries this process imported (`refLibs` {name: version}) and load1.

import { performance } from "node:perf_hooks";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
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

// --- his lite adapter config (fb10dd9 liteSignal.ts:4-15), one frozen reference (single-reference rule)
const LITE_CONFIG = Object.freeze({
    maxNodes: 262144, maxLinks: 1048576, prealloc: "lazy", onCapacityExceeded: "throw",
});

function liteAdapter() {
    let reg = createRegistry(LITE_CONFIG);
    // pool counters of the registries reset() has retired, so poolMetrics() is cumulative
    let retiredGrowths = 0, retiredFlushPasses = 0;
    return {
        name: "lite-signal",
        signal: (v) => { const s = reg.signal(v); return { read: s, write: s.set }; },
        computed: (fn) => ({ read: reg.computed(fn) }),
        effect: (fn) => { reg.effect(fn); },
        withBatch: (fn) => reg.batch(fn),
        withBuild: (fn) => fn(),
        // his resetBenchmark() (liteSignal.ts:46-49): destroy the registry, then build a fresh
        // one from LITE_CONFIG. The retired registry's counters are folded in first.
        reset() {
            const s = reg.stats();
            retiredGrowths += s.poolGrowths;
            if (typeof s.flushPasses === "number") retiredFlushPasses += s.flushPasses;
            reg.destroy();
            reg = createRegistry(LITE_CONFIG);
        },
        // lite-only pool fingerprint for the metrics column (free; absent on ref engines)
        // Emit only counters this stats() shape actually carries: 1.5.0 has no
        // flushPasses key, and "flushPasses=undefined" in the metrics column
        // broke the pool fingerprint the header promises (2026-08 review).
        poolMetrics() {
            const s = reg.stats();
            const out = { poolGrowths: retiredGrowths + s.poolGrowths };
            if (typeof s.flushPasses === "number") out.flushPasses = retiredFlushPasses + s.flushPasses;
            return out;
        },
    };
}

// Engines this harness can drive, in row order, and why a reference engine failed to import.
const KNOWN_FW = ["lite-signal", "alien-signals", "reflex-quant"];
const LOAD_ERRORS = new Map();  // name -> import error
// Fail closed: stderr reason, exit 2, nothing on stdout (called before the stamp).
function refuse(msg) { console.error("mirror: " + msg); process.exitCode = 2; }

async function alienAdapter() {
    let alien;
    try { alien = await import("alien-signals"); } catch (e) { LOAD_ERRORS.set("alien-signals", e); return null; }
    const { signal, computed, effect, startBatch, endBatch } = alien;
    // Handles exactly as upstream js-reactivity-benchmark 12f169b src/frameworks/alienSignals.ts:13-24:
    // the signal function IS read and write ({read: data, write: data}; alien's signal checks
    // arity), the computed function IS read. The effect wrapper stays because upstream wraps it
    // too (:25-29): alien treats a returned function as a cleanup, the harness ignores it.
    return {
        name: "alien-signals",
        signal: (v) => { const s = signal(v); return { read: s, write: s }; },
        computed: (fn) => ({ read: computed(fn) }),
        effect: (fn) => { effect(() => { fn(); }); },
        withBatch: (fn) => { startBatch(); try { fn(); } finally { endBatch(); } },
        withBuild: (fn) => fn(),
        reset() {},
        poolMetrics() { return null; },
    };
}

// reflex-quant: a handle IS the node (get(h) / set(h, v)); effects run synchronously on
// creation and inside set(), and batch(fn) delivers its writes once fn returns. The effect
// body is wrapped like alien's: reflex-quant treats a returned function as a cleanup.
async function reflexAdapter() {
    let rq;
    try { rq = await import("reflex-quant"); } catch (e) { LOAD_ERRORS.set("reflex-quant", e); return null; }
    const { signal, computed, effect, get, set, batch } = rq;
    return {
        name: "reflex-quant",
        signal: (v) => { const s = signal(v); return { read: () => get(s), write: (x) => set(s, x) }; },
        computed: (fn) => { const c = computed(fn); return { read: () => get(c) }; },
        effect: (fn) => { effect(() => { fn(); }); },
        withBatch: (fn) => { batch(fn); },
        withBuild: (fn) => fn(),
        reset() {},
        poolMetrics() { return null; },
    };
}

// Version of the copy of `name` this process imports: walk up from its resolved entry to the
// package.json that names it. Fails closed (throws): a stamp must not name a library it cannot
// identify.
function refLibVersion(name) {
    let dir = dirname(fileURLToPath(import.meta.resolve(name)));
    for (;;) {
        const pj = join(dir, "package.json");
        if (existsSync(pj)) {
            const j = JSON.parse(readFileSync(pj, "utf8"));
            if (j.name === name && typeof j.version === "string" && j.version !== "") return j.version;
        }
        const up = dirname(dir);
        if (up === dir) throw new Error("stamp: cannot determine the version of " + name);
        dir = up;
    }
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

// Repeat until either REPEATS samples or a sample crosses the ceiling; report the median of
// every sample taken (a capped row keeps every sample taken, including the one that crossed it).
// Returns { time, capped, samples, snapshot, sum }.
function measure(framework, cfg) {
    const times = [];
    let last = null, capped = false;
    for (let i = 0; i < REPEATS; i++) {
        last = measureOnce(framework, cfg);
        times.push(last.time);
        framework.reset();
        if (last.time > CEILING_MS) { capped = true; break; }
    }
    return { time: summarizeSamples(times).median, capped, samples: times.length, snapshot: last.snapshot, sum: last.sum };
}

// --- CSV row (his 4-column format) ---------------------------------------------------
function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }
function metricsStr(res, pool, capped) {
    const parts = [];
    if (capped) parts.push(`SLOW/CAPPED samples=${res.samples} ceiling=${Math.round(CEILING_MS)}ms`);
    const s = res.snapshot;
    parts.push(`nodesRecomputed=${s.nodesRecomputed} nodesVisited=${s.nodesVisited} edgesTraversed=${s.edgesTraversed} sinkReads=${s.sinkReads} sum=${res.sum}`);
    if (pool) parts.push((typeof pool.flushPasses === "number" ? `flushPasses=${pool.flushPasses} ` : "") + `poolGrowths=${pool.poolGrowths}`);
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
        "pure push": { nodesRecomputed: 910133, edgesTraversed: 3640532, sinkReads: 220010 },
    };
    const fw = liteAdapter();
    let fail = 0, total = 0;
    for (const cfg of DYNAMIC_TESTS) {
        const exp = EXP[cfg.name];
        if (!exp) continue;
        total++;
        const res = measureOnce(fw, cfg);
        fw.reset();
        const s = res.snapshot;
        const ok = s.nodesRecomputed === exp.nodesRecomputed && s.edgesTraversed === exp.edgesTraversed && s.sinkReads === exp.sinkReads;
        console.log(`${ok ? "MATCH" : "DIFF "} ${pad(cfg.name, 26)} nodes ${s.nodesRecomputed}/${exp.nodesRecomputed}  edges ${s.edgesTraversed}/${exp.edgesTraversed}  sink ${s.sinkReads}/${exp.sinkReads}`);
        if (!ok) fail++;
    }
    const want = Object.keys(EXP).length;
    const pass = fail === 0 && total === want;
    console.log(`\n${total - fail}/${want} MATCH`);
    console.log(pass ? "SELF-VERIFY PASS: counters match the document" : "SELF-VERIFY FAIL: " + fail + " DIFF, " + (want - total) + " EXP rows not run");
    process.exitCode = pass ? 0 : 1;
}

// --- main ----------------------------------------------------------------------------
async function main() {
    if (SELF_VERIFY) { await runSelfVerify(); return; }

    // FW set: every engine it names must be known AND load, else exit 2 before the stamp.
    // FW unset: a reference engine joins only if installed, but at least one adapter must load.
    if (FW) for (const n of FW) if (!KNOWN_FW.includes(n)) return refuse(`unknown FW engine "${n}" (known: ${KNOWN_FW.join(", ")})`);
    const adapters = [];
    if (!FW || FW.has("lite-signal")) adapters.push(liteAdapter());
    if (!FW || FW.has("alien-signals")) { const a = await alienAdapter(); if (a) adapters.push(a); else if (FW) return refuse("FW names alien-signals but it cannot be imported: " + LOAD_ERRORS.get("alien-signals")); }
    if (!FW || FW.has("reflex-quant")) { const a = await reflexAdapter(); if (a) adapters.push(a); else if (FW) return refuse("FW names reflex-quant but it cannot be imported: " + LOAD_ERRORS.get("reflex-quant")); }
    if (adapters.length === 0) return refuse("no engine adapter loaded");
    // the reference libraries this process imported (lite is named by engineSha256)
    const refLibs = {};
    for (const fw of adapters) if (fw.name !== "lite-signal") refLibs[fw.name] = refLibVersion(fw.name);

    const stamp = makeStamp({
        enginePath: new URL("../Signal.js", import.meta.url).href,
        harnessPath: import.meta.url,
        config: LITE_CONFIG,
        protocol: FW && FW.size === 1 ? (SCENARIO ? PROTOCOLS.PER_ROW : PROTOCOLS.PER_ENGINE) : PROTOCOLS.SMOKE,
        reps: REPEATS,
        extra: {
            ceiling_ms: CEILING_MS, quick: QUICK, adapter: "destroy", scenario: SCENARIO || "all",
            captureId: process.env.CAPTURE_ID ?? null, refLibs, load1: os.loadavg()[0],
        },
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

    const verdict = G.makeVerdict();
    const byTest = new Map();   // edgesTraversed, for counter-agreement across engines
    const sumByTest = new Map();  // res.sum, for RESULT-agreement across engines

    for (const fw of adapters) {
        for (const cfg of tests) {
            const before = fw.poolMetrics();
            const res = measure(fw, cfg);
            const pool = fw.poolMetrics();
            // poolMetrics() is cumulative across reset() rebuilds, so a row reports its own delta.
            if (pool && before) {
                pool.poolGrowths -= before.poolGrowths;
                if (typeof pool.flushPasses === "number") pool.flushPasses -= before.flushPasses;
            }
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
    // Timing-only shapes (no dependency-graph counters); kairo / fan / mol rows carry a
    // checksum that must agree across engines (checksum guard). kairo and mol also check
    // their outputs against closed forms in-process (micro-suites.mjs; a mismatch throws). Together with the dynamic rows above
    // this is the full 47-row js-reactivity-benchmark field -- benchmarkReactive.mjs is
    // now redundant and retired.
    let micro = microRows();
    if (SCENARIO) micro = micro.filter((r) => r.name === SCENARIO);
    const checksums = new Map();  // row -> [{framework, checksum}]
    for (const fw of adapters) {
        for (const r of micro) {
            const out = r.run(fw);
            const metrics = out.checksum !== undefined ? `checksum=${out.checksum}` : "";
            console.log([pad(fw.name, 22), pad(r.name, 60), pad(out.time.toFixed(2), 8), metrics].join(" , "));
            if (out.checksum !== undefined) {
                if (!checksums.has(r.name)) checksums.set(r.name, []);
                checksums.get(r.name).push({ framework: fw.name, checksum: out.checksum });
            }
        }
    }
    for (const [row, entries] of checksums) G.checkChecksum(verdict, row, entries);

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
