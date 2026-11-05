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
 *      ALONE: 20 warmup + 200 measured cycles, through measureWindows
 *      (helpers/heap-window.mjs, PLAN-F198 D-b168-1). ALL-SPACE instrument:
 *      three snapshots a, b, c of every heap space's space_used_size into
 *      preallocated Float64Arrays; the window delta is the sum over every
 *      allocating space of (c - b) - (b - a) (the empty bracket b - a
 *      subtracts the statistics call's own allocation). A new_space-only read
 *      is blind on node 22 / 24: pretenuring moves the control's objects to
 *      old_space, and a type-old allocation (Symbol) never touches new_space.
 *      TAINT signature: a window in which code_space / trusted_space (any
 *      space named /code|trusted/) changes anywhere across a, b, c is a JIT
 *      code installation (it drags up to ~3 KB of new / old space along;
 *      b198: max 2888 B, 0-2 tainted windows per 200-window run observed):
 *      excluded from the byte statistic, counted, and capped at TAINT_CAP =
 *      4 of 200; its GC entries still count. The GC entries whose startTime falls inside a window are
 *      counted (kind classification fail-closed, as zerogc-torture). Gate
 *      (FLOOR UNIT: per 256-node WINDOW): the LARGEST clean window delta
 *      <= 0 B AND 0 minor / 0 major GCs inside the windows AND tainted <= 4
 *      AND no unverifiable (NaN) window. The max, not the median: an
 *      empty-bracket read can come out high (that window then reads
 *      negative), so a real per-reset allocation shows in the max.
 *   2. MUST-FAIL CONTROLS (lessons b85 / b104 / b136 / b125). The same window
 *      gate over two reset-shaped bodies: "control" allocates one {} per node
 *      into a SINK array (slots OVERWRITTEN every cycle, so each object lives
 *      one cycle across the next pre-window gc(): node 22 / 24 pretenure the
 *      site to old_space, which is why the window sums every space), and
 *      "control-old" allocates one Symbol() per node (old-space by type on
 *      every version). Each control must MEASURE >= 16 B per NODE (FLOOR UNIT:
 *      the median over its CLEAN windows / 256; no NaN window, taint within
 *      the cap) and the gate must FAIL on it, or this scenario is red (the
 *      gate has no teeth). Both allocate on every tier, including
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

import { measureOps, checkNoGc } from "@zakkster/lite-gc-profiler";
import { createLeakTracker } from "@zakkster/lite-leak";
import * as Signal from "../../Signal.js";
import { createReport } from "./helpers/index.mjs";
import { measureWindows, windowGate, TAINT_CAP } from "./helpers/heap-window.mjs";

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

// Control body: one {} per node into overwritten SINK slots (each object lives one cycle, across the
// next window's pre-window gc(), so node 22 / 24 pretenure the site into old_space: the all-space window sees it).
const SINK = new Array(NODES).fill(null);
const control = () => { for (let i = 0; i < NODES; i++) SINK[i] = { i }; };
// control-old body: one Symbol() per node -- old-space by TYPE on every version (TASK 0 probe: 6144 B per
// 256 on 22 / 24 / 26, tiered and --no-opt --no-maglev), so a new_space-only window reads it as 0 B.
const SINK_OLD = new Array(NODES).fill(null);
const controlOld = () => { for (let i = 0; i < NODES; i++) SINK_OLD[i] = Symbol(); };

const cap0 = r.stats();

/*
 * Window hooks for measureWindows (helpers/heap-window.mjs): the graph is rebuilt OUTSIDE every window
 * (before); after a reset() window the D-1 stats contract is audited (auditReset), after a control window
 * the graph is torn down by an unmeasured reset (resetAfter). Module-level counters: Smi, < 2^30.
 */
let s0 = null, c0 = 0, badStats = 0, badCleanups = 0, firstBad = null;
const before = () => { build(); s0 = r.stats(); c0 = cleanupRuns; };
const auditReset = (k) => {
    const s1 = r.stats();
    const bad =
        s1.activeNodes !== 0 || s1.activeLinks !== 0 || s1.signals !== 0 || s1.computeds !== 0 || s1.effects !== 0 ||
        s1.totalAllocations !== s0.totalAllocations || s1.poolGrowths !== s0.poolGrowths ||
        s1.nodePoolCapacity !== s0.nodePoolCapacity || s1.linkPoolCapacity !== s0.linkPoolCapacity ||
        s1.nodePoolCapacity !== cap0.nodePoolCapacity || s1.linkPoolCapacity !== cap0.linkPoolCapacity ||
        s1.totalDisposals - s0.totalDisposals !== NODES || s0.activeNodes !== NODES;
    if (bad) { badStats++; if (firstBad === null) firstBad = { k, s0, s1 }; }
    if (cleanupRuns - c0 !== N_E) badCleanups++;
};
const resetAfter = () => { r.reset(); };
const RESET_OPTS = { warmup: WARMUP, cycles: CYCLES, before, after: auditReset };
const CONTROL_OPTS = { warmup: WARMUP, cycles: CYCLES, before, after: resetAfter };

const fmtW = (w) => `max ${w.max} B, median ${w.median} B, min ${w.min} B per ${NODES}-node window over ` +
    `${w.clean} clean; tainted ${w.tainted}${w.tainted > 0 ? ` (max ${w.taintMax} B)` : ""} of cap ${TAINT_CAP}, ` +
    `nan ${w.nan}; minor ${w.minor}, major ${w.major} in ${CYCLES} windows (forced outside ${w.forced})`;

/* -- 1. A4: reset() alone, 0 B/op + 0 GC ------------------------------------ */
{
    const w = await measureWindows(doReset, RESET_OPTS);
    R.eq("a4-window", w.nan, 0, "heap space statistics unverifiable (space count changed, NaN, or no new_space / " +
        "old_space) -- the window witness is unverifiable");
    R.ok("a4-window", w.forced >= 2 * (WARMUP + CYCLES), `the gc observer saw ${w.forced} of the ${2 * (WARMUP + CYCLES)} forced collections: the in-window minor / major count is unmeasured`);
    R.ok("a4-window", w.tainted <= TAINT_CAP, `${w.tainted} tainted (code / trusted space changed) reset() windows ` +
        `exceed the cap of ${TAINT_CAP}: too few clean windows to gate (${fmtW(w)})`);
    R.ok("a4-window", w.max <= 0, `reset() allocated in its window: ${fmtW(w)}`);
    R.eq("a4-window", w.minor, 0, `minor GCs inside the reset() windows (${fmtW(w)})`);
    R.eq("a4-window", w.major, 0, `major GCs inside the reset() windows (${fmtW(w)})`);
    R.ok("a4-window", windowGate(w, CYCLES, TAINT_CAP), "the shared window gate rejected reset()");
    R.eq("a4-stats", badStats, 0, "resets that broke the D-1 stats contract" +
        (firstBad ? ` (first at cycle ${firstBad.k}: before ${JSON.stringify(firstBad.s0)} ` +
            `after ${JSON.stringify(firstBad.s1)})` : ""));
    R.eq("a4-stats", badCleanups, 0, `resets whose cleanup count was not exactly ${N_E}`);
    R.note(`reset() window: ${fmtW(w)} -> ${Math.max(0, w.max) / NODES} B/node ` +
        `(gate: max <= 0, 0 minor, 0 major, tainted <= ${TAINT_CAP})`);
}

/* -- 2. must-fail controls + steady-phase majors ---------------------------- */
// Two rows per control: it MEASURES >= CONTROL_MIN_B_PER_NODE per node (median over CLEAN windows, no NaN
// window, taint within the cap) and the shared gate (windowGate, the same call as a4-window) FAILS it.
const seesAlloc = (w) => w.nan === 0 && w.tainted <= TAINT_CAP && w.median / NODES >= CONTROL_MIN_B_PER_NODE;
const blindMsg = (what, w) => `the ${what} control measured ${w.median / NODES} B/node (< ${CONTROL_MIN_B_PER_NODE}) ` +
    `or was unverifiable: the window cannot see an allocation (${fmtW(w)})`;
const controlNote = (name, w) => R.note(`${name} window: ${fmtW(w)} -> ${w.median / NODES} B/node ` +
    `(must be >= ${CONTROL_MIN_B_PER_NODE}, gate must fail)`);
{
    const w = await measureWindows(control, CONTROL_OPTS);
    R.ok("control", seesAlloc(w), blindMsg("{}-per-node", w));
    R.ok("control", windowGate(w, CYCLES, TAINT_CAP) === false,
        `the window gate PASSED the allocating {}-per-node control -- no teeth (${fmtW(w)})`);
    controlNote("control", w);
}
{
    const w = await measureWindows(controlOld, CONTROL_OPTS);
    R.ok("control-old", seesAlloc(w), blindMsg("Symbol()-per-node", w));
    R.ok("control-old", windowGate(w, CYCLES, TAINT_CAP) === false,
        `the window gate PASSED the allocating Symbol()-per-node control -- no teeth (${fmtW(w)})`);
    controlNote("control-old", w);
}
{
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
    "stale handles retained nothing", { minAsserts: 26 }));
