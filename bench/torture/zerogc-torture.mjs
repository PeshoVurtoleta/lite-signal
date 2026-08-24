/**
 * bench/torture/zerogc-torture.mjs -- the zero-GC claim, made falsifiable.
 *
 * The headline promise of this engine is a single sentence: writing through an
 * ALREADY-BUILT reactive graph allocates nothing. No closures, no arrays, no
 * boxing on `set` / pull / `flush`; node and link churn is absorbed by the
 * monomorphic pool, not the garbage collector. Every other torture file in this
 * directory asserts on MEANING -- values, wakeups, ordering. This one asserts on
 * BYTES, and it is the only file that turns "zero-GC" from a slogan into a gate
 * a skeptic can re-run against any build.
 *
 * The claim is narrow on purpose, and this file states the non-goal as loudly as
 * the goal. Node CREATION is NOT zero-alloc: the callable API allocates two
 * closures per `signal`, and even a `signalBox` allocates its wrapper object. The
 * pool removes the internal NODE allocation, never the public HANDLE. What the
 * pool guarantees -- and what the churn scenarios below prove -- is that a
 * create+dispose cycle RETAINS nothing: the transient handle is collected, the
 * node returns to the pool, and the pool never grows. So the honest reading of a
 * PASS is "the steady-state hot path allocates nothing, and node churn leaks
 * nothing", not "constructing a signal is free".
 *
 * Three independent witnesses, because no single one sees everything:
 *
 *   1. per-call RETAINED bytes (`measureAllocs` + `checkAllocs`) -- allocation
 *      surviving a forced collection, taken as the min across batches so ambient
 *      noise is stripped off. STEADY scenarios gate at `maxBytesPerCall: 0`: a
 *      write through an already-built graph retains literally nothing. CHURN
 *      scenarios (create+dispose) gate at a sub-object floor (`CHURN_BYTES_FLOOR`,
 *      < 1 B/call) instead -- not a loosened claim but an honest one. Measuring a
 *      create+dispose cycle necessarily observes a TRANSIENT wrapper (a signalBox
 *      is ~16-48 B), and gc-profiler 1.16.0 no longer lets a negative-delta batch
 *      mask it: inverted batches are excluded from the min (`invertedBatches`), so
 *      when the forced-GC windows happen to straddle a single surviving wrapper
 *      the min lands on it (observed 0.0016-0.1152 B/call, ~1 object across 10k
 *      calls). That is measurement floor, not a leak: a real per-call leak is a
 *      whole un-recycled wrapper, >=16 B/call -- two to three orders of magnitude
 *      above the floor -- and it would ALSO move the exact counters in witness 3,
 *      which is the deterministic proof the byte witness only corroborates.
 *   2. major GC count and longest pause over a measured window (`measureOps` +
 *      `checkNoGc`, `maxMajor: 0` / `maxPauseMs: 2`) -- a zero-alloc window
 *      forces no major collection regardless of how long it runs, so a nonzero
 *      count is transient garbage the retained-bytes settling would hide.
 *   3. the engine's own exact counters (`stats()`): for the steady scenarios
 *      `poolGrowths` and `totalAllocations` must not move across the window (no
 *      node was pulled, the pool never grew); for the churn scenarios
 *      `poolGrowths` must stay 0 and `activeNodes` must return to its baseline
 *      (every acquired node was recycled, none leaked).
 *
 * These are gated separately, not blended: `maxBytesPerCall` belongs to
 * `checkAllocs` and `maxMajor` / `maxPauseMs` to `checkNoGc`, and each gate
 * fails closed on a rule key the other lane owns -- so `RULES` is destructured
 * per lane rather than handed whole to either.
 *
 * Self-test: `ZEROGC_BREAK=1` arms an effect that pushes a fresh `{ v }` object
 * into a MODULE-LEVEL sink on every write (module scope so V8 cannot scalar-
 * replace it away -- a function-local throwaway would be elided and read as
 * zero, the exact false negative this control rules out). In that mode the
 * `injected` scenario MUST allocate and the gate MUST reject it; reaching the
 * PASS line with the break armed is itself a failure, because a gate blind to a
 * planted allocation is blind to a real one.
 *
 * Exit code: 0 iff every steady-state write retained 0 bytes, forced 0 major
 * collections, and moved no counter it must not; and node churn leaked nothing.
 *
 * Usage: node --expose-gc bench/torture/zerogc-torture.mjs
 *        ZEROGC_BREAK=1 node --expose-gc bench/torture/zerogc-torture.mjs
 */

import { measureAllocs, checkAllocs, measureOps, checkNoGc } from "@zakkster/lite-gc-profiler";
import { createReport, mulberry32 } from "./helpers/index.mjs";

import { createRegistry } from "../../Signal.js";

/* -- configuration ---------------------------------------------------------- */

const CFG = { maxNodes: 8192, maxLinks: 131072, prealloc: "eager", onCapacityExceeded: "grow" };

// The zero-retention claim, whole. Split per lane at the call site: checkAllocs
// owns maxBytesPerCall, checkNoGc owns maxMajor/maxPauseMs, and each throws on
// the other's key (gates fail closed on unknown rules), so neither is ever
// handed the full object. NO maxArrayBuffersGrowth: lite-signal pools are object
// graphs, not ArrayBuffer backing stores -- that rule gates a surface this engine
// does not have, and carrying it over from a typed-array library would be a lie.
const RULES = { maxMajor: 0, maxPauseMs: 2, maxBytesPerCall: 0 };

// Churn-only per-call retention floor. Steady writes retain exactly 0; a
// create+dispose cycle cannot be measured at exactly 0 because the forced-GC
// windows may straddle the single transient wrapper the cycle is built to
// reclaim (gc-profiler 1.16.0 surfaces this by excluding inverted batches from
// the min). < 1 B/call means "less than one byte retained per create+dispose" --
// under 1/16th of a wrapper on average, i.e. full reclamation -- while a real
// per-call handle leak (>=16 B/call) still fails here AND moves the exact
// poolGrowths / activeNodes counters, which are the deterministic proof.
const CHURN_BYTES_FLOOR = 1;

const ITER = 10000;    // measureAllocs calls per batch
const OPS = 100000;    // measureOps steady-window ops
const WARMUP = 10000;  // shared warmup for both lanes

// Deterministic starting values so a failure is reproducible from the seed
// alone. The writes themselves march by the call index (fn(i)), which is what
// exercises propagation; the seed only colours the graph's initial state.
const SEED = 0x1234abcd | 0;

const BREAK = process.env.ZEROGC_BREAK === "1";

// Module-level sink for the break control. It must escape the JIT-compiled hot
// function or V8 will dead-store the push and the planted allocation reads as
// zero -- the false negative this whole control exists to rule out.
const __sink = [];
export function sinkLen() { return __sink.length; }

const R = createReport("lite-signal zero-GC torture -- the steady-state hot path allocates nothing");

/* -- scenario builders ------------------------------------------------------ */
// Every builder allocates all scratch ONCE and returns a `hot(i)` that allocates
// nothing (except the injected effect, by design, under BREAK). The measured
// loop bodies are `a.set(i)` / a hoisted batch callback -- never a fresh closure.

/** Deep chain x16 + a tail effect. Ported from zgc-scenarios `steadyDeep`. */
function buildDeep() {
    const rnd = mulberry32(SEED);
    const r = createRegistry(CFG);
    const a = r.signal((rnd() * 1000) | 0);
    let prev = a;
    for (let i = 0; i < 16; i++) { const p = prev; prev = r.computed(() => p() + 1); }
    let sink = 0; const tail = prev; r.effect(() => { sink = tail(); });
    return { statsOf: () => r.stats(), hot: (i) => a.set(i) };
}

/** One signal fanning out to 32 computed+effect pairs. */
function buildWide() {
    const rnd = mulberry32(SEED);
    const r = createRegistry(CFG);
    const a = r.signal((rnd() * 1000) | 0);
    const sinks = new Array(32).fill(0);
    for (let i = 0; i < 32; i++) { const k = i; const c = r.computed(() => a() + k); r.effect(() => { sinks[k] = c(); }); }
    return { statsOf: () => r.stats(), hot: (i) => a.set(i) };
}

/** Eight signals written together under one effect, HOISTED batch callback. */
function buildBatch() {
    const rnd = mulberry32(SEED);
    const r = createRegistry(CFG);
    const sigs = []; for (let i = 0; i < 8; i++) sigs.push(r.signal((rnd() * 1000) | 0));
    let sink = 0; r.effect(() => { let t = 0; for (let j = 0; j < 8; j++) t += sigs[j](); sink = t; });
    let cur = 0;
    // Hoisted: a fresh arrow per iteration would measure the CALLER's closure,
    // not the engine's batch internals -- and the caller's allocation is the
    // caller's business. This scenario isolates the engine.
    const cb = () => { for (let j = 0; j < 8; j++) sigs[j].set(cur + j); };
    return { statsOf: () => r.stats(), hot: (i) => { cur = i; r.batch(cb); } };
}

/** create+dispose churn on the callable form. NO signalBox -- see churnBox. */
function buildChurnPlain() {
    const r = createRegistry(CFG);
    return { statsOf: () => r.stats(), hot: (i) => { const a = r.signal(i); r.dispose(a); } };
}

/** create+dispose churn on signalBox. Self-skips below 1.5.0 (no signalBox). */
function buildChurnBox() {
    const r = createRegistry(CFG);
    if (typeof r.signalBox !== "function") return null; // SKIP: signalBox requires 1.5.0+
    return { statsOf: () => r.stats(), hot: (i) => { const a = r.signalBox(i); r.dispose(a); } };
}

/**
 * The break control. Reads its source every run; under BREAK it also pushes a
 * fresh object into the escaping module sink. Without BREAK the branch folds to
 * nothing and the scenario is a plain steady write that must PASS.
 */
function armBreak(r, src) {
    r.effect(() => {
        const v = src();
        if (BREAK) {
            __sink.push({ v });
            // Bound the sink so measureOps' long window cannot OOM. The cap is far
            // above measureAllocs' batch size, so retained bytes stay clearly
            // nonzero across the batches that actually gate retention.
            if (__sink.length > (1 << 19)) __sink.length = 0;
        }
    });
}

function buildInjected() {
    const rnd = mulberry32(SEED);
    const r = createRegistry(CFG);
    const a = r.signal((rnd() * 1000) | 0);
    armBreak(r, a);
    return { statsOf: () => r.stats(), hot: (i) => a.set(i) };
}

/* -- verdict ---------------------------------------------------------------- */

/** Signals 1 and 2, shared by every scenario: retained bytes, then major/pause. */
function gateAllocAndGc(name, st, maxBytesPerCall) {
    const fn = st.hot;

    const alloc = measureAllocs(fn, { iterations: ITER, warmup: WARMUP });
    const aRep = checkAllocs(alloc, { maxBytesPerCall });
    R.ok(name, aRep.verdict === "pass",
        `retained ${alloc.bytesPerCall} B/call vs floor ${maxBytesPerCall} ` +
        `(verdict ${aRep.verdict}${alloc.settled ? "" : ", UNSETTLED"}` +
        `${alloc.invertedBatches ? `, ${alloc.invertedBatches} inverted batch(es)` : ""})`);

    const s0 = st.statsOf();
    const ops = measureOps(fn, { ops: OPS, warmup: WARMUP, stabilize: "deep" });
    const s1 = st.statsOf();

    const gRep = checkNoGc(ops.summary, { maxMajor: RULES.maxMajor, maxPauseMs: RULES.maxPauseMs });
    R.ok(name, gRep.ok,
        `major=${ops.summary.gc.major} maxMs=${ops.summary.gc.maxMs.toFixed(2)} (verdict ${gRep.verdict})`);

    return { s0, s1 };
}

/** Steady scenarios: no node was acquired and the pool never grew. */
function gateSteady(name, build) {
    const st = build();
    const { s0, s1 } = gateAllocAndGc(name, st, RULES.maxBytesPerCall);
    R.eq(name, s1.poolGrowths - s0.poolGrowths, 0, "the pool grew during steady-state writes");
    R.eq(name, s1.totalAllocations - s0.totalAllocations, 0, "a node was acquired during steady-state writes");
}

/** Churn scenarios: the pool never grew and every acquired node was recycled. */
function gateChurn(name, build) {
    const st = build();
    if (st === null) { R.note(`${name} -- SKIP: signalBox requires 1.5.0+`); return; }
    const { s0, s1 } = gateAllocAndGc(name, st, CHURN_BYTES_FLOOR);
    R.eq(name, s1.poolGrowths - s0.poolGrowths, 0, "the pool grew under create+dispose churn");
    R.eq(name, s1.activeNodes - s0.activeNodes, 0, "activeNodes did not return to baseline -- a churned node leaked");
    // Visible positive verdict so a RUNNING churn gate is legible in the output --
    // R.eq is silent on success, and on 1.5.0 churn-box ACTIVATES (signalBox is a
    // function, buildChurnBox no longer returns null), so without this line its
    // first-time activation would be invisible and indistinguishable from a SKIP.
    R.note(`${name} -- ok: retained < ${CHURN_BYTES_FLOOR} B/call (sub-object floor), poolGrowths delta 0, activeNodes returned to baseline`);
}

/* -- run -------------------------------------------------------------------- */

gateSteady("steady-deep", buildDeep);
gateSteady("steady-wide", buildWide);
gateSteady("steady-batch", buildBatch);
gateChurn("churn-plain", buildChurnPlain);
gateChurn("churn-box", buildChurnBox);

// The break control runs the same three-witness verdict. Without BREAK it is a
// steady write that must PASS; with BREAK its effect allocates and checkAllocs
// must flag it. Reference the escaping sink so nothing about it can be elided.
gateSteady("injected", buildInjected);
if (BREAK && __sink.length === 0) R.note(`sink stayed empty (len ${sinkLen()}) -- break did not fire`);

// A gate blind to a planted allocation is blind to a real one: with the break
// armed, sailing past every assertion is itself the failure.
if (BREAK) {
    R.ok("injected", R.failureCount > 0,
        "ZEROGC_BREAK armed an allocating effect but every witness passed -- the gate is blind");
}

R.note(`seed 0x${(SEED >>> 0).toString(16)}; ${BREAK ? "BREAK armed (allocation expected)" : "steady mode"}; ` +
    `measureAllocs ${ITER}/batch, measureOps ${OPS} ops, stabilize=deep`);

process.exit(R.finish("the steady-state hot path retained 0 bytes and forced 0 major GCs; node churn leaked nothing"));
