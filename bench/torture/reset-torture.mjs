/**
 * bench/torture/reset-torture.mjs -- registry.reset(): zero-GC window, must-fail
 * control, stale-handle retention (reset ships at 1.6.0).
 *
 * reset() disposes every live node of a registry (effects, then computeds, then
 * signals; each effect's cleanups run) and keeps the pools, the capacities and
 * the lifetime counters. It is a COLD call by design, but it is the call a host
 * makes between levels / documents / tests, so it must not turn a 256-node
 * teardown into garbage. Three things are asserted directly (PLAN-C-RESET
 * A4 + the reset half of A5):
 *
 *   1. ZERO-GC WINDOW (A4, DETERMINISTIC). A warm 256-node graph (64 signals,
 *      64 computeds, 128 effects, each effect with 1 onCleanup) is rebuilt
 *      before every cycle, OUTSIDE the window; the measured window is reset()
 *      ALONE: 20 warmup + 200 measured cycles. Per window the nursery delta is
 *      (m2 - m1) - (m1 - m0) around reset() (the empty bracket m1 - m0
 *      subtracts the statistics call's own allocation), and the GC entries
 *      whose startTime falls inside a window are counted (kind classification
 *      fail-closed, as zerogc-torture). Gate: the LARGEST window delta <= 0
 *      (0 B/op) AND 0 minor / 0 major GCs inside the windows. The max, not the
 *      median: an empty-bracket read can come out 16 B high (that window then
 *      reads -16), so a real per-reset allocation shows in the max.
 *   2. MUST-FAIL CONTROL (lessons b85 / b104 / b136 / b125). The same window
 *      gate over a reset-shaped body that allocates one {} per node into a SINK
 *      array (slots OVERWRITTEN every cycle: transient, not retained, not a
 *      nesting v => [v] that pretenures to 0 minors). The control must MEASURE
 *      >= 16 B/node and the gate must FAIL on it, or this scenario is red (the
 *      gate has no teeth). The control allocates on every tier, including
 *      --no-opt --no-maglev (an escaping object literal is never elided).
 *      Plus checkNoGc maxMajor 0 over a measureOps steady phase of 200
 *      build + reset cycles (lite-gc-profiler, stabilize "deep").
 *   3. RETENTION (A5, reset half). Over 5 reset cycles on ONE long-lived
 *      registry, every stale handle (signal, computed, effect stop) is HELD,
 *      and a lite-leak tracker watches 256 node-held values (64 signal values,
 *      64 computed values, 128 effect bodies) + 128 cleanup closures:
 *      tracker.size() === 0 after gc on every cycle (the pool slots kept by
 *      reset must not pin what the disposed nodes held).
 *
 * After every measured reset: activeNodes / activeLinks / signals / computeds /
 * effects 0; totalAllocations, poolGrowths and both capacities unchanged ACROSS
 * the reset() call (C-RESET D-1); totalDisposals grew by exactly 256; each of
 * the 128 cleanups ran exactly once.
 *
 * Exit code: 0 iff every contract held; 77 = no reset() (engine below the
 * 1.6.0 floor); 78 = runtime lacks --expose-gc (environment, never escalated).
 *
 * Usage: node --expose-gc bench/torture/reset-torture.mjs
 *        node --expose-gc --no-opt --no-maglev bench/torture/reset-torture.mjs
 */

import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import v8 from "node:v8";
import { measureOps, checkNoGc } from "@zakkster/lite-gc-profiler";
import { createLeakTracker } from "@zakkster/lite-leak";
import * as Signal from "../../Signal.js";
import { createReport, flushAll } from "./helpers/index.mjs";

const { createRegistry } = Signal;

if (typeof createRegistry({ maxNodes: 16 }).reset !== "function") {
    console.log("lite-signal reset torture -- SKIP: registry.reset not available (1.6.0+)");
    process.exit(77); // SKIP_EXIT -- the runner escalates this to FAIL at/above the floor
}
if (typeof globalThis.gc !== "function") {
    // Every section needs a forced collection; a window gate without one is noise, not a pass.
    console.log("lite-signal reset torture -- ENV SKIP: needs node --expose-gc");
    process.exit(78); // ENV_SKIP_EXIT
}

const R = createReport("lite-signal reset torture -- 0 B/op + 0 GC per reset, must-fail control, stale-handle retention");

const N_S = 64, N_C = 64, N_E = 128;
const NODES = N_S + N_C + N_E;            // 256
const TARGETS = N_S + N_C + N_E + N_E;    // 384 = 256 node-held values + 128 cleanup closures
const WARMUP = 20, CYCLES = 200;
const CONTROL_MIN_B_PER_NODE = 16;

const GC_MAJOR = perfConstants.NODE_PERFORMANCE_GC_MAJOR;
const GC_INCREMENTAL = perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL;
const GC_WEAKCB = perfConstants.NODE_PERFORMANCE_GC_WEAKCB;

/** Bytes live in the nursery, or -1 when the statistic is unavailable (the gate then FAILS). */
function newSpaceUsed() {
    const spaces = v8.getHeapSpaceStatistics();
    for (let i = 0; i < spaces.length; i++) {
        if (spaces[i].space_name === "new_space") return spaces[i].space_used_size;
    }
    return -1;
}

/* -- the measured graph ----------------------------------------------------- */

const r = createRegistry({ maxNodes: 1024 });          // default "throw" policy: a fixed pool
const S = new Array(N_S).fill(null), C = new Array(N_C).fill(null);
let cleanupRuns = 0;                                    // Smi: < 2^30 over the whole run
const onCl = () => { cleanupRuns++; };
function build() {
    for (let i = 0; i < N_S; i++) S[i] = r.signal(i);
    for (let i = 0; i < N_C; i++) { const s = S[i]; C[i] = r.computed(() => s() + 1); }
    for (let i = 0; i < N_E; i++) { const c = C[i & (N_C - 1)]; r.effect(() => { c(); r.onCleanup(onCl); }); }
}
const doReset = () => { r.reset(); };

// Control body: one {} per node into overwritten SINK slots (transient garbage, never retained).
const SINK = new Array(NODES).fill(null);
const control = () => { for (let i = 0; i < NODES; i++) SINK[i] = { i }; };

const cap0 = r.stats();

/**
 * Run WARMUP + CYCLES windows of `body` (the graph is rebuilt outside every window; a control body
 * is followed by an unmeasured reset). Returns the per-window nursery deltas of the measured cycles
 * and the GC entries whose startTime falls inside a measured window. With `audit`, checks the D-1
 * stats contract across each reset() call.
 */
async function windows(body, isReset) {
    const T = new Float64Array(2 * CYCLES);
    const D = new Float64Array(CYCLES);
    const entries = [];
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            entries.push({ start: e.startTime, kind: (e.detail !== undefined && e.detail !== null) ? e.detail.kind : e.kind });
        }
    });
    obs.observe({ entryTypes: ["gc"] });
    let badStats = 0, badCleanups = 0, firstBad = null;
    for (let k = 0; k < WARMUP + CYCLES; k++) {
        build();
        const s0 = r.stats();
        const c0 = cleanupRuns;
        globalThis.gc(); globalThis.gc();
        const t0 = performance.now();
        const m0 = newSpaceUsed();
        const m1 = newSpaceUsed();
        body();
        const m2 = newSpaceUsed();
        const t1 = performance.now();
        if (k >= WARMUP) {
            const j = k - WARMUP;
            T[2 * j] = t0; T[2 * j + 1] = t1;
            D[j] = (m0 < 0 || m1 < 0 || m2 < 0) ? Number.NaN : (m2 - m1) - (m1 - m0);
        }
        if (!isReset) { r.reset(); continue; }
        const s1 = r.stats();
        const bad =
            s1.activeNodes !== 0 || s1.activeLinks !== 0 || s1.signals !== 0 || s1.computeds !== 0 || s1.effects !== 0 ||
            s1.totalAllocations !== s0.totalAllocations || s1.poolGrowths !== s0.poolGrowths ||
            s1.nodePoolCapacity !== s0.nodePoolCapacity || s1.linkPoolCapacity !== s0.linkPoolCapacity ||
            s1.nodePoolCapacity !== cap0.nodePoolCapacity || s1.linkPoolCapacity !== cap0.linkPoolCapacity ||
            s1.totalDisposals - s0.totalDisposals !== NODES || s0.activeNodes !== NODES;
        if (bad) { badStats++; if (firstBad === null) firstBad = { k, s0, s1 }; }
        if (cleanupRuns - c0 !== N_E) badCleanups++;
    }
    await flushAll(); await flushAll();
    obs.disconnect();
    let minor = 0, major = 0, forced = 0;
    for (const e of entries) {
        let inside = false;
        for (let j = 0; j < CYCLES; j++) { if (e.start >= T[2 * j] && e.start <= T[2 * j + 1]) { inside = true; break; } }
        if (!inside) { if (e.kind === GC_MAJOR) forced++; continue; }
        if (e.kind === GC_MAJOR) major++;
        else if (e.kind === GC_INCREMENTAL || e.kind === GC_WEAKCB) continue;
        else minor++;                                    // minor, MinorMS, unknown: fail closed
    }
    const sorted = Array.from(D).sort((a, b) => a - b);  // a NaN window is counted below and fails the gate
    let nan = 0;
    for (let j = 0; j < CYCLES; j++) if (D[j] !== D[j]) nan++;
    return {
        min: sorted[0], median: sorted[CYCLES >> 1], max: sorted[CYCLES - 1], nan, minor, major, forced,
        badStats, badCleanups, firstBad,
    };
}

/** The window gate shared by reset() and the control: one function, so the control proves its teeth. */
const windowGate = (w) => w.nan === 0 && w.max <= 0 && w.minor === 0 && w.major === 0;

const fmtW = (w) => `max ${w.max} B, median ${w.median} B, min ${w.min} B per ${NODES}-node window; ` +
    `minor ${w.minor}, major ${w.major} in ${CYCLES} windows`;

/* -- 1. A4: reset() alone, 0 B/op + 0 GC ------------------------------------ */
{
    const w = await windows(doReset, true);
    R.eq("a4-window", w.nan, 0, "new_space statistics unavailable -- the window witness is unverifiable");
    R.ok("a4-window", w.forced >= 2 * (WARMUP + CYCLES), `the gc observer saw ${w.forced} of the ${2 * (WARMUP + CYCLES)} forced collections: the in-window minor / major count is unmeasured`);
    R.ok("a4-window", w.max <= 0, `reset() allocated in its window: ${fmtW(w)}`);
    R.eq("a4-window", w.minor, 0, `minor GCs inside the reset() windows (${fmtW(w)})`);
    R.eq("a4-window", w.major, 0, `major GCs inside the reset() windows (${fmtW(w)})`);
    R.ok("a4-window", windowGate(w), "the shared window gate rejected reset()");
    R.eq("a4-stats", w.badStats, 0, "resets that broke the D-1 stats contract" +
        (w.firstBad ? ` (first at cycle ${w.firstBad.k}: before ${JSON.stringify(w.firstBad.s0)} after ${JSON.stringify(w.firstBad.s1)})` : ""));
    R.eq("a4-stats", w.badCleanups, 0, `resets whose cleanup count was not exactly ${N_E}`);
    R.note(`reset() window: ${fmtW(w)} -> ${Math.max(0, w.max) / NODES} B/node (gate: max <= 0, 0 minor, 0 major)`);
}

/* -- 2. must-fail control + steady-phase majors ----------------------------- */
{
    const w = await windows(control, false);
    const perNode = w.median / NODES;
    R.ok("control", w.nan === 0 && perNode >= CONTROL_MIN_B_PER_NODE,
        `the {}-per-node control measured ${perNode} B/node (< ${CONTROL_MIN_B_PER_NODE}): the window cannot see an allocation`);
    R.ok("control", windowGate(w) === false, `the window gate PASSED the allocating control -- no teeth (${fmtW(w)})`);
    R.note(`control window: ${fmtW(w)} -> ${perNode} B/node (must be >= ${CONTROL_MIN_B_PER_NODE}, gate must fail)`);

    const ops = measureOps(() => { build(); r.reset(); }, { ops: CYCLES, warmup: WARMUP, stabilize: "deep" });
    const g = checkNoGc(ops.summary, { maxMajor: 0 });
    R.ok("steady-major", g.ok, `checkNoGc maxMajor 0 over ${CYCLES} build + reset cycles: major=${ops.summary.gc.major} ` +
        `minor=${ops.summary.gc.minor} (verdict ${g.verdict})`);
    R.eq("steady-major", r.stats().activeNodes, 0, "live nodes after the steady phase");
    R.note(`steady phase (measureOps, ${CYCLES} build + reset): major ${ops.summary.gc.major}, minor ${ops.summary.gc.minor}, ` +
        `maxMs ${ops.summary.gc.maxMs.toFixed(2)} (gate: checkNoGc maxMajor 0)`);
}

/* -- 3. A5 reset half: stale handles held, nothing retained ----------------- */
// The tracker cleanup and every tag are a module-level constant / numbers: neither closes over a target.
const LEAK_NOOP = () => {};
let leakTag = 0;
/** Build one tracked 256-node graph. A SYNC frame on purpose: a target held in a local of the async
 *  module body survives the await below in the suspended register file (measured: the last loop
 *  iteration's signal value + effect body read as 2 residual targets), which is harness retention,
 *  not engine retention. This frame dies before the gc loop runs. */
function buildTracked(tracker) {
    const hs = [], hc = [], he = [];
    for (let i = 0; i < N_S; i++) {
        const v = { v: i };
        tracker.track(v, LEAK_NOOP, ++leakTag);
        hs.push(r.signal(v));
    }
    for (let i = 0; i < N_C; i++) {
        const s = hs[i];
        const c = r.computed(() => ({ c: s().v }));
        tracker.track(c(), LEAK_NOOP, ++leakTag);
        hc.push(c);
    }
    for (let i = 0; i < N_E; i++) {
        const c = hc[i & (N_C - 1)];
        const body = () => {
            c();
            const cl = () => { cleanupRuns++; };
            tracker.track(cl, LEAK_NOOP, ++leakTag);
            r.onCleanup(cl);
        };
        tracker.track(body, LEAK_NOOP, ++leakTag);
        he.push(r.effect(body));
    }
    return [hs, hc, he];
}
{
    const leaks = [];
    const tracker = createLeakTracker({ name: "reset-torture", onLeak: (x) => leaks.push(x.kind + ":" + String(x.tag)) });
    const held = [];                                   // stale handles, kept across all 5 cycles
    let badBefore = 0, badStale = 0, staleThrew = 0;
    const sizes = [];
    for (let cyc = 0; cyc < 5; cyc++) {
        const [hs, hc, he] = buildTracked(tracker);
        if (tracker.size() !== TARGETS) badBefore++;
        r.reset();
        for (let i = 0; i < N_S; i++) {
            if (hs[i]() !== undefined || hs[i].peek() !== undefined) badStale++;
            try { hs[i].set(-1); } catch { staleThrew++; }
        }
        for (let i = 0; i < N_C; i++) if (hc[i]() !== undefined) badStale++;
        for (let i = 0; i < N_E; i++) { try { he[i](); } catch { staleThrew++; } }
        held.push(hs, hc, he);
        for (let k = 0; k < 20 && tracker.size() > 0; k++) { globalThis.gc(); await new Promise((res) => setTimeout(res, 25)); }
        sizes.push(tracker.size());
        R.eq("a5-retention", tracker.size(), 0, `cycle ${cyc}: values / effect bodies / cleanups still alive after reset + gc ` +
            `with the stale handles held (lite-leak tracker.size())`);
    }
    R.eq("a5-retention", badBefore, 0, `cycles whose tracker did not see all ${TARGETS} targets before reset`);
    R.eq("a5-stale", badStale, 0, "stale handle reads that did not return undefined after reset");
    R.eq("a5-stale", staleThrew, 0, "stale set() / stop() calls that threw after reset");
    R.eq("a5-retention", r.stats().activeNodes, 0, "live nodes after the retention cycles");
    R.eq("a5-retention", held.length, 15, "stale handle groups held to the end");
    R.eq("a5-retention", leaks.length, 5 * TARGETS, "finalizer reports (one per collected target)");
    R.note(`lite-leak witness: 5 reset cycles x ${TARGETS} targets, stale handles held; tracker.size() per cycle ` +
        `${sizes.join(" ")}; finalizer reports ${leaks.length}`);
}

process.exit(R.finish("reset() allocated 0 B and forced 0 GCs per 256-node reset, the control failed the same gate, " +
    "stale handles retained nothing", { minAsserts: 15 }));
