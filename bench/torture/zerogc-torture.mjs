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
 * Four independent witnesses, because no single one sees everything:
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
 *   4. SCAVENGE count over a long un-forced window (steady scenarios only) --
 *      the transient-garbage witness the first three are structurally blind to.
 *      Witness 1 settles transient garbage away by design; witness 2 gates
 *      MAJOR collections, and a stray `{...}` per write dies in the nursery
 *      without ever forcing one. So: a PerformanceObserver on the "gc" channel
 *      counts MINOR collections across 1M raw hot-fn calls (GC entries deliver
 *      asynchronously, so the count is read after a macrotask drain -- a sync
 *      read observes nothing and would pass vacuously). Measured on this
 *      engine: a clean write path sustains 1M ops with exactly 0 scavenges
 *      (stable across runs), while a planted 1-object-per-write body forces 2
 *      (~16 MB semispace / ~32 MB of garbage). Churn scenarios are exempt:
 *      their transient HANDLES are allocation by design (see the header), so
 *      scavenges under churn are the pool working, not a leak.
 *
 * These are gated separately, not blended: `maxBytesPerCall` belongs to
 * `checkAllocs` and `maxMajor` / `maxPauseMs` to `checkNoGc`, and each gate
 * fails closed on a rule key the other lane owns -- so `RULES` is destructured
 * per lane rather than handed whole to either.
 *
 * Self-tests -- one per witness class, because a gate blind to a planted
 * allocation is blind to a real one:
 *   `ZEROGC_BREAK=1` arms an effect that pushes a fresh `{ v }` object into a
 *   MODULE-LEVEL sink on every write (module scope so V8 cannot scalar-replace
 *   it away -- a function-local throwaway would be elided and read as zero, the
 *   exact false negative this control rules out). RETAINED allocation: witness
 *   1 must reject it.
 *   `ZEROGC_BREAK=transient` arms the same effect to overwrite a single module
 *   slot instead -- every write allocates one `{ v }` that dies on the next
 *   write, so retention stays ~0 and witnesses 1-3 all PASS. Only the scavenge
 *   witness can catch it; the run must still FAIL, proving witness 4 is live.
 * In either mode, reaching the PASS line with a break armed is itself a failure.
 *
 * Exit code: 0 iff every steady-state write retained 0 bytes, forced 0 major
 * collections, forced 0 scavenges, and moved no counter it must not; and node
 * churn leaked nothing.
 *
 * Usage: node --expose-gc bench/torture/zerogc-torture.mjs
 *        ZEROGC_BREAK=1 node --expose-gc bench/torture/zerogc-torture.mjs
 *        ZEROGC_BREAK=transient node --expose-gc bench/torture/zerogc-torture.mjs
 */

import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import v8 from "node:v8";
import { measureAllocs, checkAllocs, measureOps, checkNoGc } from "@zakkster/lite-gc-profiler";
import { createReport, mulberry32, flushAll } from "./helpers/index.mjs";

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

// Scavenge-witness window (witness 4). A 1-object-per-write leak produces
// ~32 MB of nursery garbage over the window. Node 26's V8 grows new_space
// ADAPTIVELY (measured 8.8 -> 38.8 MB, zero scavenge entries), so the window
// is gated on BOTH signals: scavenge count AND nursery used-bytes delta.
// The garbage cannot dodge both -- it is either collected (minors > 0) or
// still resident (delta ~ tens of MB vs a sub-MB clean cap).
const SCAVENGE_OPS = 1_000_000;
// Clean-path nursery drift cap. Measured clean deltas are sub-MB (the settle
// gc() empties the nursery; a zero-alloc write loop adds nothing); the
// planted 1-object-per-write control lands at tens of MB (or forces minors).
// 4 MB gives an order of magnitude of margin on BOTH sides.
const NURSERY_DELTA_CAP = 4 * 1048576;

// Deterministic starting values so a failure is reproducible from the seed
// alone. The writes themselves march by the call index (fn(i)), which is what
// exercises propagation; the seed only colours the graph's initial state.
const SEED = 0x1234abcd | 0;

const BREAK_RETAINED = process.env.ZEROGC_BREAK === "1";
const BREAK_TRANSIENT = process.env.ZEROGC_BREAK === "transient";
const BREAK = BREAK_RETAINED || BREAK_TRANSIENT;

// Module-level sink for the break control. It must escape the JIT-compiled hot
// function or V8 will dead-store the push and the planted allocation reads as
// zero -- the false negative this whole control exists to rule out.
const __sink = [];
export function sinkLen() { return __sink.length; }

// One-object slot for the TRANSIENT break: each write's fresh { v } evicts the
// previous one, so retention stays at a single object (invisible to witness 1)
// while the write path churns nursery garbage (visible only to witness 4).
// Module scope for the same escape-analysis reason as __sink.
let __slot = null;
export function slotRef() { return __slot; }

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

/**
 * Branch-flipping retrack: every write flips a selector, so the computed drops
 * its whole previous dep set and links a fresh one -- ~8 link-pool cycles per
 * call with ZERO node churn. This is the LINK-graveyard witness (2026-08 audit,
 * Phase 2): an engine that deferred link recycling to node-dispose would drain
 * the 131,072-link pool inside the 1M-op scavenge window (4M+ dropped links)
 * and trip poolGrowths / retained-bytes / the scavenge count, while every
 * node-centric gate in the suite stayed green.
 */
function buildRetrack() {
    const rnd = mulberry32(SEED);
    const r = createRegistry(CFG);
    const sel = r.signal(0);
    const a = [], b = [];
    for (let i = 0; i < 4; i++) { a.push(r.signal((rnd() * 1000) | 0)); b.push(r.signal((rnd() * 1000) | 0)); }
    const c = r.computed(() => {
        let t = 0;
        if (sel() & 1) { for (let j = 0; j < 4; j++) t += b[j](); }
        else { for (let j = 0; j < 4; j++) t += a[j](); }
        return t;
    });
    let sink = 0; r.effect(() => { sink = c(); });
    // Self-driven toggle: the flip must not depend on any lane's fn(i) calling
    // convention -- a lane that called hot() argless would otherwise coalesce
    // every write (Object.is) and measure a vacuous no-retrack loop.
    let flip = 0;
    return { statsOf: () => r.stats(), hot: () => sel.set(flip ^= 1) };
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
        if (BREAK_RETAINED) {
            __sink.push({ v });
            // Bound the sink so measureOps' long window cannot OOM. The cap is far
            // above measureAllocs' batch size, so retained bytes stay clearly
            // nonzero across the batches that actually gate retention.
            if (__sink.length > (1 << 19)) __sink.length = 0;
        } else if (BREAK_TRANSIENT) {
            // Allocate-and-drop: one fresh object per write, previous one dies.
            // Retention ~0 (witnesses 1-3 stay green); nursery churn only.
            __slot = { v };
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

/**
 * Witness 4: count MINOR (scavenge) and MAJOR collections across a long
 * un-forced window of raw hot-fn calls. GC performance entries deliver
 * asynchronously, so the window is bracketed by macrotask drains: settle +
 * drain BEFORE opening the window, run it, drain again, then read. Without
 * the drains a synchronous read observes zero entries and the witness passes
 * vacuously -- the exact fail-open this suite exists to prevent.
 *
 * Two fail-open traps closed here (2026-08 review):
 *   - KIND CLASSIFICATION is fail-closed. V8's Minor Mark-Sweep nursery
 *     collector (replacing the Scavenger on some Node/V8 builds) reports a
 *     kind that is neither NODE_PERFORMANCE_GC_MINOR nor _MAJOR; an allowlist
 *     of {minor, major} would count it as NOTHING and pass a leaking build.
 *     So: MAJOR counts as major, INCREMENTAL/WEAKCB are ignored (marking
 *     steps and callbacks, not collections), and EVERY other kind -- minor,
 *     MinorMS, or anything a future V8 invents -- counts as minor.
 *   - ATTRIBUTION is by the entry's startTime, not its delivery time. The
 *     settle gc() entries can deliver AFTER the counter zeroing, and ambient
 *     GCs from the drain turns could deliver into the post-window batch;
 *     filtering on t0 <= startTime <= t1 counts exactly the window's work.
 */
const GC_MAJOR = perfConstants.NODE_PERFORMANCE_GC_MAJOR;
const GC_INCREMENTAL = perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL;
const GC_WEAKCB = perfConstants.NODE_PERFORMANCE_GC_WEAKCB;

/** Bytes currently live in the nursery, or -1 when the stat is unavailable
 *  (the gate then FAILS -- an unverifiable witness is not a green witness). */
function newSpaceUsed() {
    const spaces = v8.getHeapSpaceStatistics();
    for (let i = 0; i < spaces.length; i++) {
        if (spaces[i].space_name === "new_space") return spaces[i].space_used_size;
    }
    return -1;
}

async function countGcOverWindow(fn, ops) {
    const entries = [];
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            entries.push({ start: e.startTime, kind: (e.detail !== undefined && e.detail !== null) ? e.detail.kind : e.kind });
        }
    });
    obs.observe({ entryTypes: ["gc"] });
    globalThis.gc(); globalThis.gc();   // settle so the window starts clean
    await flushAll();                    // let the settle entries deliver (filtered below anyway)
    const used0 = newSpaceUsed();
    const t0 = performance.now();
    for (let i = 0; i < ops; i++) fn(i);
    const t1 = performance.now();
    const used1 = newSpaceUsed();        // sampled BEFORE the drain turns allocate
    await flushAll();                    // deliver the window's entries
    obs.disconnect();

    const seen = { minor: 0, major: 0 };
    for (const e of entries) {
        if (e.start < t0 || e.start > t1) continue;      // outside the measured window
        if (e.kind === GC_MAJOR) seen.major++;
        else if (e.kind === GC_INCREMENTAL || e.kind === GC_WEAKCB) continue;
        else seen.minor++;                                // minor, MinorMS, unknown: fail closed
    }
    // NURSERY GROWTH (2026-08 Phase 2 review, HIGH): modern V8 (Node 26) grows
    // new_space ADAPTIVELY -- measured 8.8 MB -> 38.8 MB across a 1M-op
    // 1-object-per-write window with ZERO scavenge entries, so a scavenge
    // count alone certifies the exact allocation class this witness exists to
    // catch. The garbage cannot hide from both signals at once: either V8
    // collects it (minors > 0) or it accumulates in the nursery (used-bytes
    // delta ~ total garbage). -1 when the space statistic is unavailable.
    seen.nurseryDeltaBytes = (used0 < 0 || used1 < 0) ? -1 : used1 - used0;
    return seen;
}

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

/** Steady scenarios: no node was acquired, the pool never grew, and the whole
 *  scavenge window forced zero collections of either generation. */
async function gateSteady(name, build) {
    const st = build();
    const { s0, s1 } = gateAllocAndGc(name, st, RULES.maxBytesPerCall);
    R.eq(name, s1.poolGrowths - s0.poolGrowths, 0, "the pool grew during steady-state writes");
    R.eq(name, s1.totalAllocations - s0.totalAllocations, 0, "a node was acquired during steady-state writes");

    // Witness 4 -- transient garbage, TWO signals that cannot both stay quiet:
    // a clean write path sustains the full window with 0 scavenges AND a flat
    // nursery; per-write allocate-and-drop either forces scavenges or (Node
    // 26's adaptive nursery growth -- see countGcOverWindow) piles up as
    // nursery used-bytes. An unavailable nursery stat fails, not skips.
    const gcw = await countGcOverWindow(st.hot, SCAVENGE_OPS);
    R.eq(name, gcw.minor, 0,
        `scavenges during a ${SCAVENGE_OPS.toLocaleString()}-op un-forced window (transient allocation on the write path)`);
    R.eq(name, gcw.major, 0,
        `major GCs during the ${SCAVENGE_OPS.toLocaleString()}-op un-forced window`);
    R.ok(name, gcw.nurseryDeltaBytes >= 0 && gcw.nurseryDeltaBytes <= NURSERY_DELTA_CAP,
        gcw.nurseryDeltaBytes < 0
            ? "nursery statistics unavailable -- the transient witness is unverifiable"
            : `nursery grew ${(gcw.nurseryDeltaBytes / 1048576).toFixed(1)} MB over the un-forced window ` +
              `(cap ${(NURSERY_DELTA_CAP / 1048576).toFixed(0)} MB) -- per-write transient allocation ` +
              `absorbed by adaptive nursery growth instead of scavenges`);
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

await gateSteady("steady-deep", buildDeep);
await gateSteady("steady-wide", buildWide);
await gateSteady("steady-batch", buildBatch);
await gateSteady("steady-retrack", buildRetrack);

/* -- bounded-pool churn: the slow-graveyard witness -------------------------
 * steady-retrack's gates catch an AGGRESSIVE graveyard (the pool drains inside
 * the window -> poolGrowths / capacity blow-up). A SLOW one hides: leaked pool
 * objects are not new allocations (bytes stay 0) and a 131k free list absorbs
 * a fractional leak for the whole window. stats() cannot arbitrate either --
 * `pooledLinks` is DERIVED (capacity - activeLinks), so a conservation check
 * is a tautology (mutant-verified: a 1-in-64 freeLink leak sails past every
 * wide-pool gate). The witness that cannot be fooled is structural: churn
 * links on a pool with ZERO slack. The shape holds exactly 6 active links
 * (sel->c, 4 branch deps->c, c->effect) and the retrack cursor reuses slots
 * in place, so maxLinks:6 leaves NOTHING free (2026-08 review: the first
 * draft's 64-link pool left 58 spare -- an escape band down to ~1-in-69k
 * severs; at 6 the FIRST link that fails to return to the free list makes the
 * very next branch flip throw CapacityError -- sensitivity 1 leaked link in
 * 4M severs). Policy "throw"; a healthy engine recycles at a fixed active
 * count forever. */
{
    const rB = createRegistry({ maxNodes: 32, maxLinks: 6, prealloc: "eager", onCapacityExceeded: "throw" });
    const sel = rB.signal(0);
    const a = [], b = [];
    for (let i = 0; i < 4; i++) { a.push(rB.signal(i)); b.push(rB.signal(i + 4)); }
    const c = rB.computed(() => {
        let t = 0;
        if (sel() & 1) { for (let j = 0; j < 4; j++) t += b[j](); }
        else { for (let j = 0; j < 4; j++) t += a[j](); }
        return t;
    });
    let boundedSink = 0; rB.effect(() => { boundedSink = c(); });
    const BOUNDED_FLIPS = 1_000_000;
    let threw = null, flips = 0;
    try { for (; flips < BOUNDED_FLIPS; flips++) sel.set(flips & 1 ? 1 : 0); } catch (e) { threw = e; }
    R.ok("bounded-churn", threw === null,
        `link churn on a zero-slack 6-link pool threw after ${flips.toLocaleString()} flips ` +
        `(${threw && threw.message}) -- a severed link failed to return to the free list (graveyard)`);
    const sB = rB.stats();
    R.eq("bounded-churn", sB.poolGrowths, 0, "the bounded pool grew -- policy \"throw\" makes this unreachable except by accounting corruption");
    // The final flip is deterministic: the loop's last write is set(1), the
    // b-branch, so the ONLY healthy final sink is 4+5+6+7 = 22 (effects run
    // eagerly at creation, so 6 exists only transiently before the loop).
    R.eq("bounded-churn", boundedSink, 22,
        "bounded-churn sink after the final (b-branch) flip -- the flip loop did not recompute to the end");
    if (threw === null) R.note(`bounded-churn -- ok: ${BOUNDED_FLIPS.toLocaleString()} flips x 4 severs on a zero-slack pool, every link came back`);
}
gateChurn("churn-plain", buildChurnPlain);
gateChurn("churn-box", buildChurnBox);

// The break control runs the same four-witness verdict. Without BREAK it is a
// steady write that must PASS; with BREAK=1 its effect RETAINS and checkAllocs
// must flag it; with BREAK=transient its effect allocates-and-drops and only
// the scavenge witness can flag it. Reference the escaping sink/slot so
// nothing about them can be elided.
await gateSteady("injected", buildInjected);
if (BREAK_RETAINED && __sink.length === 0) R.note(`sink stayed empty (len ${sinkLen()}) -- break did not fire`);
if (BREAK_TRANSIENT && __slot === null) R.note(`slot stayed null (${String(slotRef())}) -- transient break did not fire`);

// A gate blind to a planted allocation is blind to a real one: with a break
// armed, sailing past every assertion is itself the failure.
if (BREAK) {
    R.ok("injected", R.failureCount > 0,
        `ZEROGC_BREAK=${process.env.ZEROGC_BREAK} armed an allocating effect but every witness passed -- the gate is blind`);
}

R.note(`seed 0x${(SEED >>> 0).toString(16)}; ` +
    `${BREAK ? `BREAK=${process.env.ZEROGC_BREAK} armed (${BREAK_TRANSIENT ? "transient" : "retained"} allocation expected)` : "steady mode"}; ` +
    `measureAllocs ${ITER}/batch, measureOps ${OPS} ops, scavenge window ${SCAVENGE_OPS.toLocaleString()} ops, stabilize=deep`);

process.exit(R.finish("the steady-state hot path retained 0 bytes and forced 0 major GCs; node churn leaked nothing"));
