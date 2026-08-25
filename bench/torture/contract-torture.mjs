/**
 * bench/torture/contract-torture.mjs — the three unpinned engine quadrants:
 * throw-inside-batch, write-inside-computed, and the equals contract under
 * churn volume.
 *
 * 2026-08 instrument audit, Phase 2. Each quadrant had ZERO torture coverage:
 * a regression in any of them would ship green. This file pins the OBSERVED
 * 1.5.0 contract (probed live before writing, same discipline as
 * test/29-throwing-equals) so that a future engine which changes any of these
 * semantics trips a loud assert instead of silently redefining the behavior.
 *
 * The pinned contracts, verified against 1.5.0 Signal.js:
 *
 *   THROW-INSIDE-BATCH -- a batch body that throws:
 *     - propagates the ORIGINAL error unchanged (no wrapping);
 *     - writes made BEFORE the throw are committed AND flushed on the abnormal
 *       unwind (the batch-exit flush runs in a finally, not after a normal
 *       return only);
 *     - a set-then-revert (X -> Y -> X under equals) inside the throwing batch
 *       is still honored: no value change, no downstream fire;
 *     - the engine is NOT wedged: the very next plain write flushes
 *       synchronously and the next batch runs normally (batch depth restored);
 *     - an inner nested batch's throw, caught by the outer body, leaves the
 *       outer batch intact -- one coalesced flush at outer exit.
 *
 *   WRITE-INSIDE-COMPUTED -- a computed body that calls set() during its own
 *   evaluation:
 *     - is LEGAL (no throw), both on a direct pull and when pulled from an
 *       effect mid-flush;
 *     - the written signal's downstream flushes in the same pass, ordered
 *       after the writer, observing the final value exactly once (no glitch);
 *     - a computed that writes its OWN dependency does not loop and does not
 *       re-dirty itself: evalVersion is stamped AFTER the body returns, so the
 *       self-write is invisible to its own staleness check and the computed
 *       stays cached at the pre-write evaluation. The dependency HOLDS the
 *       written value, and the next EXTERNAL write recomputes normally -- the
 *       node is never wedged.
 *
 *   EQUALS UNDER CHURN -- the custom-equals write path at fuzz volume:
 *     - a coalesced write (equals says equal) does NOT update the stored value
 *       and does NOT fire downstream -- peek() returns the OLD value;
 *     - fire counts under a quantizing equals match an exact shadow model
 *       across thousands of seeded writes (test/29 pins the throwing sites;
 *       this pins the non-throwing semantics at volume);
 *     - a THROWING equals on one signal mid-churn surfaces to the writer,
 *       leaves the value unmutated, and does not disturb NEIGHBORING nodes'
 *       propagation in the same churn loop.
 *
 * Exit code: 0 iff every pinned contract held.
 *
 * Usage: node --expose-gc bench/torture/contract-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;
const R = createReport("lite-signal contract torture — throw-in-batch, write-in-computed, equals under churn");

/* ── 1. throw-inside-batch: single-shot pins ──────────────────────────────── */
{
    const r = createRegistry();
    const s1 = r.signal(0), s2 = r.signal(0);
    let runs1 = 0, seen1 = -1, runs2 = 0, seen2 = -1;
    r.effect(() => { seen1 = s1(); runs1++; });
    r.effect(() => { seen2 = s2(); runs2++; });
    const boom = new Error("batch-boom");
    let caught = null;
    try { r.batch(() => { s1.set(11); throw boom; }); } catch (e) { caught = e; }

    R.ok("batch-throw", caught === boom, "the batch body's error was wrapped or replaced instead of re-thrown unchanged");
    R.eq("batch-throw", s1.peek(), 11, "a write made BEFORE the throw was rolled back -- pre-throw writes must commit");
    R.eq("batch-throw", runs1 - 1, 1, "the abnormal unwind did not flush the pre-throw write -- batch exit must flush in finally");
    R.eq("batch-throw", seen1, 11, "the flushed effect observed a stale value");

    // The wedge check -- the single most important pin in this section. A batch
    // depth counter left incremented by the abnormal exit would make every
    // later write queue forever and never flush.
    s2.set(22);
    R.eq("batch-throw", runs2 - 1, 1, "a plain write AFTER a throwing batch did not flush -- batch depth is wedged");
    R.eq("batch-throw", seen2, 22, "the post-throw flush delivered a stale value");

    let laterRan = false;
    r.batch(() => { s1.set(33); laterRan = true; });
    R.ok("batch-throw", laterRan, "a batch after a throwing batch did not run");
    R.eq("batch-throw", s1.peek(), 33, "a batch after a throwing batch did not commit");
    R.eq("batch-throw", runs1 - 1, 2, "a batch after a throwing batch did not flush");
}

/* ── 2. throw-inside-batch: set-then-revert under the abnormal exit ───────── */
{
    const r = createRegistry();
    const s = r.signal(5);
    let runs = 0;
    r.effect(() => { s(); runs++; });
    try { r.batch(() => { s.set(9); s.set(5); throw new Error("revert-throw"); }); } catch { /* expected */ }
    R.eq("batch-revert", s.peek(), 5, "set-then-revert inside a throwing batch left the intermediate value committed");
    R.eq("batch-revert", runs - 1, 0, "set-then-revert inside a throwing batch fired downstream -- the revert check was skipped on abnormal exit");
    s.set(6);
    R.eq("batch-revert", runs - 1, 1, "the engine is wedged after a reverted throwing batch");
}

/* ── 3. throw-inside-batch: nested inner throw, outer coalesces ───────────── */
{
    const r = createRegistry();
    const s = r.signal(0);
    let runs = 0, seen = -1;
    r.effect(() => { seen = s(); runs++; });
    r.batch(() => {
        s.set(1);
        try { r.batch(() => { s.set(2); throw new Error("inner"); }); } catch { /* swallowed by the outer body */ }
        s.set(3);
    });
    R.eq("batch-nested", runs - 1, 1, "an outer batch surviving an inner throw did not coalesce to exactly one flush");
    R.eq("batch-nested", seen, 3, "the outer batch's flush delivered a non-final value");
    R.eq("batch-nested", s.peek(), 3, "the outer batch's writes after the swallowed inner throw were lost");
}

/* ── 4. throw-inside-batch: 4096 throw/clean cycles leave no residue ──────── */
{
    // The single-shot pins above prove the shape once; this proves nothing
    // BLEEDS. If the abnormal unwind leaked batch depth, links, or queued
    // effects, thousands of cycles would drift stats or wedge a later flush.
    const r = createRegistry();
    const s = r.signal(0);
    const boom = new Error("cycle");            // allocated once; never rebuilt in-loop
    let runs = 0, seen = -1;
    r.effect(() => { seen = s(); runs++; });
    const baseline = r.stats();
    const runs0 = runs;

    const CYCLES = 4096;
    let thrown = 0;
    for (let i = 1; i <= CYCLES; i++) {
        try { r.batch(() => { s.set(i); throw boom; }); } catch (e) { if (e === boom) thrown++; }
        if (seen !== i) break;                  // committed+flushed every cycle, checked in-loop
    }
    R.eq("batch-cycles", thrown, CYCLES, "not every throwing batch re-threw -- an error was swallowed");
    R.eq("batch-cycles", seen, CYCLES, "a throwing batch stopped committing/flushing its pre-throw write mid-run");
    R.eq("batch-cycles", runs - runs0, CYCLES, "flush count drifted from write count across throwing batches");

    const after = r.stats();
    R.eq("batch-cycles", after.activeNodes, baseline.activeNodes, "activeNodes drifted across throwing batches");
    R.eq("batch-cycles", after.activeLinks, baseline.activeLinks, "activeLinks drifted across throwing batches");
    R.note(`${CYCLES} throwing batches: every error surfaced, every pre-throw write flushed, stats exact`);
}

/* ── 5. throw-inside-batch: a PENDING scheduler effect still gets its thunk ─ */
{
    // 2026-08 review (MED): sections 1-4 pin the abnormal unwind with SYNC
    // effects only; the scheduler dispatch inside the finally-flush was
    // unpinned across the whole suite (a mutant guarding scheduler dispatch
    // behind a clean-exit flag passed 21/21 scenarios and 513/513 tests).
    // 1.5.0 contract, probe-verified: the abnormal unwind hands the pending
    // node's schedulerThunk to the scheduler exactly as a normal exit would,
    // and draining it delivers the pre-throw value.
    const r = createRegistry();
    const s = r.signal(0);
    const pend = [];
    let runs = 0, seen = -1;
    r.effect(() => { seen = s(); runs++; }, { scheduler: (fn) => pend.push(fn) });
    while (pend.length) pend.shift()();               // drain the deferred creation run
    const runs0 = runs;
    const boom = new Error("sched-batch-boom");
    let caught = null;
    try { r.batch(() => { s.set(41); throw boom; }); } catch (e) { caught = e; }
    R.ok("batch-throw-sched", caught === boom, "the throwing batch's error changed with a scheduler effect pending");
    R.ok("batch-throw-sched", pend.length > 0,
        "the abnormal batch unwind never dispatched the pending effect's scheduler thunk -- deferred effects are dropped by throwing batches");
    while (pend.length) pend.shift()();
    R.eq("batch-throw-sched", runs - runs0, 1, "draining the post-throw thunk ran the effect a wrong number of times");
    R.eq("batch-throw-sched", seen, 41, "the post-throw thunk delivered a stale value");
}

/* ── 6. write-inside-computed: direct pull + flush pull ───────────────────── */
{
    const r = createRegistry();
    const src = r.signal(1), out = r.signal(0);
    let outSeen = -1, outRuns = 0;
    r.effect(() => { outSeen = out(); outRuns++; });
    const c = r.computed(() => { const v = src() * 10; out.set(v); return v; });

    let threw = null, v = null;
    try { v = c(); } catch (e) { threw = e; }
    R.ok("computed-write", threw === null, `a set() inside a computed body threw on a direct pull: ${threw && threw.message}`);
    R.eq("computed-write", v, 10, "the computed's own value was wrong after its side-write");
    R.eq("computed-write", out.peek(), 10, "the side-write did not commit");
    R.eq("computed-write", outSeen, 10, "the side-write's downstream did not observe the written value");
    R.eq("computed-write", outRuns - 1, 1, "the side-write's downstream fired a wrong number of times");
}
{
    // Pulled from INSIDE a flush: effect A pulls the writing computed, effect B
    // observes the written signal. B must run after A in the same pass and see
    // the final value exactly once -- no glitch, no dropped delivery.
    const r = createRegistry();
    const src = r.signal(1), out = r.signal(0);
    const c = r.computed(() => { const v = src() * 10; out.set(v); return v; });
    let log = [];
    r.effect(() => { log.push("A:" + c()); });
    r.effect(() => { log.push("B:" + out()); });
    log = [];
    let threw = null;
    try { src.set(3); } catch (e) { threw = e; }
    R.ok("computed-write-flush", threw === null, `a set() inside a computed pulled mid-flush threw: ${threw && threw.message}`);
    R.eq("computed-write-flush", log.join(","), "A:30,B:30",
        "mid-flush side-write delivery was glitched, reordered, or dropped");
    R.eq("computed-write-flush", out.peek(), 30, "the mid-flush side-write did not commit");
}

/* ── 7. write-inside-computed: self-dependency write ──────────────────────── */
{
    const r = createRegistry();
    const s = r.signal(1);
    let bodyRuns = 0;
    const c = r.computed(() => { bodyRuns++; const v = s(); if (v === 1) s.set(2); return v; });

    const v1 = c(), v2 = c();
    R.eq("computed-self-write", v1, 1, "the self-writing computed returned the post-write value on its own pull");
    R.eq("computed-self-write", v2, 1, "a second pull recomputed -- the self-write must be invisible to the node's own staleness");
    R.eq("computed-self-write", bodyRuns, 1, `the self-writing computed looped (${bodyRuns} body runs for 2 pulls, want 1)`);
    R.eq("computed-self-write", s.peek(), 2, "the self-write to the dependency did not commit");

    // Recovery: the node must not be wedged -- an EXTERNAL write recomputes.
    s.set(10);
    R.eq("computed-self-write", c(), 10, "the computed never recovered from its self-write -- external writes no longer recompute it");
    R.eq("computed-self-write", bodyRuns, 2, "recovery recompute ran a wrong number of times");
}

/* ── 8. equals under churn: exact fire counts vs a shadow model ───────────── */
{
    // A quantizing equals ((a|0) === (b|0)) on every node, driven by seeded
    // fuzz. The shadow model applies the IDENTICAL predicate: stored value
    // updates and downstream fires happen iff equals returns false. Exact
    // effect-run counts + exact stored values, across the whole run.
    const SEED = 0xC0FFEE;
    const N = 16, WRITES = 8000;
    const rnd = mulberry32(SEED);
    const quant = (a, b) => (a | 0) === (b | 0);

    const r = createRegistry();
    const sigs = new Array(N), model = new Array(N), fires = new Array(N).fill(0), expected = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
        sigs[i] = r.signal(0, { equals: quant });
        model[i] = 0;
        const idx = i;
        r.effect(() => { sigs[idx](); fires[idx]++; });   // creation run counted; expected[] starts after it
    }

    for (let w = 0; w < WRITES; w++) {
        const i = randInt(rnd, N);
        const v = rnd() * 8;                              // float in [0,8): int part changes ~7/8 of the time
        sigs[i].set(v);
        if (!quant(model[i], v)) { model[i] = v; expected[i]++; }
    }

    let fireMismatch = -1, valueMismatch = -1;
    for (let i = 0; i < N; i++) {
        if (fires[i] - 1 !== expected[i] && fireMismatch < 0) fireMismatch = i;
        if (!Object.is(sigs[i].peek(), model[i]) && valueMismatch < 0) valueMismatch = i;
    }
    R.ok("equals-churn", fireMismatch < 0,
        `node ${fireMismatch}: ${fireMismatch >= 0 ? fires[fireMismatch] - 1 : 0} fires vs model ${fireMismatch >= 0 ? expected[fireMismatch] : 0} -- custom-equals coalescing diverged from the predicate`);
    R.ok("equals-churn", valueMismatch < 0,
        `node ${valueMismatch}: stored value diverged from the model -- a coalesced write mutated the value (or a fired write did not)`);
    R.note(`${WRITES} quantized writes over ${N} nodes: fire counts and stored values exact`);
}

/* ── 9. equals under churn: a throwing equals does not disturb neighbors ──── */
{
    const r = createRegistry();
    const boom = new Error("eq-boom");
    const POISON = 666;
    const hostile = r.signal(0, { equals: (a, b) => { if (b === POISON) throw boom; return Object.is(a, b); } });
    const good = r.signal(0);
    let hostileRuns = 0, goodRuns = 0, goodSeen = -1;
    r.effect(() => { hostile(); hostileRuns++; });
    r.effect(() => { goodSeen = good(); goodRuns++; });

    const CYCLES = 512;
    let thrown = 0;
    let strandedAt = -1, strandedValue = 0;
    for (let i = 1; i <= CYCLES; i++) {
        try { hostile.set(POISON); } catch (e) { if (e === boom) thrown++; }
        // THE value pin, checked BEFORE the recovery write can mask it (2026-08
        // review, HIGH): a throwing equals must leave the stored value at the
        // pre-throw value (i-1). An engine that writes node.value before
        // consulting equals strands the poison here -- and passes every OTHER
        // assert in this section, because the recovery write overwrites the
        // stranded 666 and fires exactly once either way. Mutant-verified.
        if (strandedAt < 0 && !Object.is(hostile.peek(), i - 1)) { strandedAt = i; strandedValue = hostile.peek(); }
        good.set(i);                                     // the neighbor keeps propagating
        hostile.set(i);                                  // and the hostile node recovers per cycle
    }
    R.eq("equals-throw", thrown, CYCLES, "a throwing equals did not surface to the writer on every cycle");
    R.ok("equals-throw", strandedAt < 0,
        `cycle ${strandedAt}: the stored value read ${strandedValue} after the throwing set (want ${strandedAt - 1}) -- ` +
        "the value was mutated before equals threw");
    R.eq("equals-throw", hostile.peek(), CYCLES, "the hostile node lost a legitimate write after its equals threw");
    R.eq("equals-throw", goodRuns - 1, CYCLES, "a NEIGHBORING node's propagation was disturbed by another signal's throwing equals");
    R.eq("equals-throw", goodSeen, CYCLES, "the neighbor's delivered value drifted");
    R.eq("equals-throw", hostileRuns - 1, CYCLES, "the hostile node's own recovery writes did not all propagate");
}

process.exit(R.finish("throw-in-batch, write-in-computed, and the equals contract all hold under volume"));
