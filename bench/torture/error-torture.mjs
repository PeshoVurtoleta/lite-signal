/**
 * bench/torture/error-torture.mjs -- throwing effect bodies under flush.
 *
 * When an effect BODY throws during a flush, the engine does not abort the pass
 * and does not lose the error. `flushEffects` buffers each per-effect throw into
 * a pre-allocated error buffer, keeps running the remaining queued effects, and
 * only after the pass decides how to surface what it caught:
 *
 *   - exactly one throw  -> the ORIGINAL error is re-thrown, unwrapped;
 *   - two or more throws -> a single AggregateError carrying EXACTLY those
 *     errors, in order;
 *   - either way the buffer is EMPTIED before the throw leaves flushEffects, and
 *     an abnormal (non-error) unwind clears it in `finally` -- so the next flush
 *     starts from a clean slate and retains nothing.
 *
 * (Confirmed against 1.7.0 Signal.js: :864 buffer append (flushErrorBuffer),
 * :872-873 finally clear on abnormal exit, :877-887 single re-throw / AggregateError
 * aggregation. The per-effect buffering, exact-order aggregation and buffer drain
 * are byte-identical to 1.4.4 -- no behavioral divergence observed on 1.7.0.)
 *
 * This is a STRESS scenario, not a unit duplicate of test/09-conformance. It
 * asserts what the unit tests do not: that SURVIVING effects in the same pass
 * still run, and -- the part a single-shot unit test cannot show -- that the
 * buffer truly returns to baseline under MANY error cycles, so nothing bleeds
 * from one throwing flush into the next.
 *
 * Exit code: 0 iff the error path buffered, aggregated and drained correctly.
 *
 * Usage: node --expose-gc bench/torture/error-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;
const R = createReport("lite-signal error torture -- throwing effect bodies under flush");

/* -- 1. A single throwing effect re-throws the ORIGINAL error --------------- */
{
    const r = createRegistry();
    const s = r.signal(0);
    const boom = new Error("solo-throw");
    r.effect(() => { if (s() > 0) throw boom; });   // throws only after the first (creation) run

    let caught = null;
    try { s.set(1); } catch (e) { caught = e; }
    R.ok("single-throw", caught !== null, "a throwing effect body did not surface any error");
    R.ok("single-throw", caught === boom,
        "a single throw was wrapped or replaced instead of re-thrown unchanged");
}

/* -- 2. Two throws in one pass aggregate into EXACTLY those errors ----------- */
{
    const r = createRegistry();
    const s = r.signal(0);
    const e1 = new Error("boom-1");
    const e2 = new Error("boom-2");
    let survivorRuns = 0;

    r.effect(() => { if (s() > 0) throw e1; });
    r.effect(() => { s(); survivorRuns++; });        // (c) the survivor, wired between the two throwers
    r.effect(() => { if (s() > 0) throw e2; });

    const survivorBefore = survivorRuns;             // 1: the creation run
    let caught = null;
    try { s.set(1); } catch (e) { caught = e; }

    R.ok("aggregate", caught !== null, "two throwing effects surfaced no error");
    R.ok("aggregate", caught instanceof AggregateError,
        `two throws produced ${caught && caught.constructor.name}, expected AggregateError`);
    const errs = caught && caught.errors;
    R.eq("aggregate", errs ? errs.length : -1, 2, "the AggregateError did not carry exactly two errors");
    R.ok("aggregate", !!errs && errs.indexOf(e1) !== -1 && errs.indexOf(e2) !== -1,
        "the AggregateError did not carry the two original errors");
    // (c) the effect scheduled BETWEEN the two throwers still ran in the same pass.
    R.eq("aggregate", survivorRuns, survivorBefore + 1,
        "a surviving effect did not run when its neighbours in the same pass threw");
}

/* -- 3. The error buffer drains: many error cycles leave nothing behind ------ */
{
    // Drive many throwing flushes interleaved with clean flushes. If the buffer
    // ever retained an error across a pass, a later CLEAN flush would surface a
    // stale throw, or stats() would drift as buffered errors pinned nodes. Both
    // are checked. Scratch is allocated ONCE, outside the cycle loop.
    const r = createRegistry();
    const s = r.signal(0);
    const reusableErr = new Error("cycle-throw");     // allocated once; never rebuilt in-loop
    let ran = 0;
    r.effect(() => { ran++; if (s() > 0) throw reusableErr; });

    // Baseline after one clean flush (s already 0 -> effect ran once at creation).
    s.set(0);                                          // no-op, stays clean
    const baseline = r.stats();

    const CYCLES = 4096;
    let throwsSeen = 0;
    let leakedCleanThrow = null;
    for (let i = 0; i < CYCLES; i++) {
        // throwing flush
        try { s.set(1); } catch (e) { if (e === reusableErr) throwsSeen++; }
        // clean flush -- must NOT surface any residue from the throwing flush
        try { s.set(0); } catch (e) { if (leakedCleanThrow === null) leakedCleanThrow = e; }
    }

    R.eq("buffer-drain", throwsSeen, CYCLES, "not every throwing cycle re-threw -- an error was swallowed");
    R.ok("buffer-drain", leakedCleanThrow === null,
        "a clean flush surfaced a stale error -- the buffer retained residue across passes");

    const after = r.stats();
    R.eq("buffer-drain", after.activeNodes, baseline.activeNodes,
        "activeNodes drifted across error cycles -- buffered errors pinned nodes");
    R.eq("buffer-drain", after.activeLinks, baseline.activeLinks,
        "activeLinks drifted across error cycles");
    R.ok("buffer-drain", ran > CYCLES,
        "the throwing effect stopped re-running -- the error path disabled it");
    R.note(`${CYCLES} throw/clean cycles: every throw re-surfaced, every clean flush stayed clean`);
}

/* -- 4. Aggregate then recover: a clean pass after an AggregateError is clean */
{
    // After a multi-throw AggregateError, remove the throwing condition and
    // confirm the registry flushes cleanly and the survivor keeps running --
    // the buffer did not strand the graph in a broken state.
    const r = createRegistry();
    const gate = r.signal(0);
    const e1 = new Error("a1");
    const e2 = new Error("a2");
    let live = 0;
    r.effect(() => { if (gate() === 1) throw e1; });
    r.effect(() => { gate(); live++; });
    r.effect(() => { if (gate() === 1) throw e2; });

    try { gate.set(1); } catch { /* AggregateError expected */ }
    const liveBefore = live;

    let cleanThrew = null;
    try { gate.set(2); } catch (e) { cleanThrew = e; }   // no thrower fires at 2
    R.ok("recover", cleanThrew === null,
        `a clean flush after an AggregateError threw ${cleanThrew && cleanThrew.message}`);
    R.eq("recover", live, liveBefore + 1, "the survivor stopped running after an AggregateError");
}

process.exit(R.finish("effect-body throws buffered, aggregated exactly, and drained to a clean baseline"));
