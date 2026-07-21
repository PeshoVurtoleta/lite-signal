/**
 * bench/torture/scheduler-storm.mjs -- deferred-execution hazards under saturation.
 *
 * SCOPE NOTE, because the obvious wishlist for a file with this name is mostly
 * inapplicable here. `scheduler` is a user-supplied callback: the engine hands
 * it a `run` thunk and the scheduler must eventually invoke it. There is no
 * priority concept anywhere in Signal.js, so there is nothing to invert; and a
 * scheduler that never calls `run` is honouring its contract, not starving.
 * Testing either would be testing this file's own harness.
 *
 * What IS engine-side, load-bearing, and untested elsewhere:
 *
 *   - The thunk is gen-bound. `executeEffect` builds it once as
 *     `() => { if (node.gen === gen && (flags & FLAG_EFFECT)) executeEffect(node) }`
 *     and caches it on the node. dispose bumps `gen`, so a `run` the scheduler
 *     is still holding must become a silent no-op -- and, critically, must not
 *     fire the NEW resident once that pool slot is recycled. That is a textbook
 *     ABA hazard and the guard is one `===` away from being wrong.
 *
 *   - `FLAG_QUEUED` is only cleared inside `executeEffect`. So while a scheduler
 *     defers, the effect stays flagged and further writes do NOT re-schedule it.
 *     That is what makes a microtask scheduler coalesce N writes into one run --
 *     and if the flag were cleared early, a write storm would schedule a storm
 *     of runs instead. Nothing else in the suite pins this.
 *
 *   - The flush loop calls `scheduler(node.schedulerThunk)` inside a try/catch
 *     that routes into `flushErrorBuffer`. A throwing scheduler must not take
 *     the rest of the pass down with it.
 *
 * Where no contract is documented (what a scheduler invoking `run` twice should
 * mean, for instance) this file PINS the observed behaviour rather than
 * asserting an invented one, and says so at the scenario.
 *
 * Exit code: 0 iff every scenario held.
 *
 * Usage: node --expose-gc bench/torture/scheduler-storm.mjs
 *        SCHED_EFFECTS=50000 node --expose-gc bench/torture/scheduler-storm.mjs
 */

import { createRegistry } from "../../Signal.js";
import { soakRegistry, createReport, flushMicrotasks } from "./helpers/index.mjs";

const SATURATION = Number(process.env.SCHED_EFFECTS || 10000);
const R = createReport(`lite-signal scheduler storm -- deferred execution, ${SATURATION.toLocaleString()} effects`);
const reg = () => soakRegistry(createRegistry, { maxNodes: SATURATION * 4, maxLinks: SATURATION * 8 });

/* -- 1. The cached thunk is reused, not reallocated ------------------------- */
{
    // Documented as "reuse cached thunk". It is an allocation-avoidance
    // guarantee: a fresh closure per re-schedule would allocate once per effect
    // per flush, which is exactly what this engine exists not to do.
    const r = reg();
    const s = r.signal(0);
    const seen = [];
    const stop = r.effect(function () { s(); }, { scheduler: (run) => { seen.push(run); run(); } });
    s.set(1);
    s.set(2);
    R.ok("thunk-identity", seen.length >= 2, `scheduler was called ${seen.length} times, expected >= 2`);
    if (seen.length >= 2) {
        R.ok("thunk-identity", seen.every((f) => f === seen[0]),
            "a fresh thunk closure was allocated per re-schedule");
    }
    stop();
}

/* -- 2. A thunk held past dispose is inert ---------------------------------- */
{
    const r = reg();
    const s = r.signal(0);
    let runs = 0;
    let held = null;
    const stop = r.effect(function () { runs++; s(); }, { scheduler: (run) => { held = run; run(); } });
    const before = runs;
    stop();
    let threw = null;
    try { held(); } catch (err) { threw = err; }
    R.ok("stale-thunk", threw === null, `invoking a disposed effect's thunk threw: ${threw && threw.message}`);
    R.eq("stale-thunk", runs, before, "a disposed effect ran from a stale thunk");
}

/* -- 3. ABA: a stale thunk must not fire the slot's NEW resident ------------ */
{
    // The sharp case the gen guard exists for. Dispose an effect, hold its run,
    // then allocate enough new effects that the pool hands the slot to someone
    // else -- invoking the old thunk must still do nothing.
    const r = reg();
    const s = r.signal(0);
    let victimRuns = 0;
    let staleRun = null;
    const victim = r.effect(function () { victimRuns++; s(); }, { scheduler: (run) => { staleRun = run; run(); } });
    victim();                                   // dispose -> gen bumps

    // The new residents must (a) have run, so they track `s`, and (b) be
    // DEFERRED when the stale thunk fires. If they were already settled,
    // executeEffect would no-op on them for this globalVersion and a missing
    // gen guard would look harmless.
    let newResidentRuns = 0;
    const residentPending = [];
    const stops = [];
    for (let i = 0; i < 64; i++) {              // force the freed slot to be reused
        let first = true;
        stops.push(r.effect(function () { newResidentRuns++; s(); }, {
            scheduler: (run) => { if (first) { first = false; run(); return; } residentPending.push(run); },
        }));
    }
    s.set(1);                                   // every resident is now pending, none has re-run
    const residentBefore = newResidentRuns;
    const victimBefore = victimRuns;

    let threw = null;
    try { staleRun(); } catch (err) { threw = err; }

    R.ok("aba-recycle", threw === null, `a stale thunk threw after slot recycle: ${threw && threw.message}`);
    R.eq("aba-recycle", victimRuns, victimBefore, "the disposed effect ran from its stale thunk");
    R.eq("aba-recycle", newResidentRuns, residentBefore,
        "a stale thunk fired the NEW resident of a recycled slot (ABA guard failed)");
    while (residentPending.length > 0) residentPending.shift()();
    for (const st of stops) st();
}

/* -- 4. Deferral coalesces a write storm into one run ----------------------- */
{
    // FLAG_QUEUED stays set until executeEffect clears it, so writes arriving
    // while the scheduler defers must not each schedule their own run. This is
    // the entire value of a microtask scheduler.
    const r = reg();
    const s = r.signal(0);
    let runs = 0;
    let scheduleCalls = 0;
    const pending = [];
    // The FIRST schedule must run synchronously. An effect whose body has never
    // executed has tracked no dependencies, so writes cannot schedule it at all
    // -- an earlier draft deferred the first call too and then "proved"
    // coalescing by observing zero re-schedules of an effect that was simply
    // not subscribed to anything.
    let established = false;
    const stop = r.effect(function () { runs++; s(); }, {
        scheduler: (run) => {
            scheduleCalls++;
            if (!established) { established = true; run(); return; }
            pending.push(run);
        },
    });
    R.ok("coalescing", runs === 1, `the effect body must run once to establish deps, ran ${runs}`);

    const s0 = scheduleCalls;
    for (let i = 1; i <= 100; i++) s.set(i);     // 100 writes while deferred
    R.eq("coalescing", scheduleCalls - s0, 1,
        "100 writes during deferral should schedule exactly once, not once per write");

    const r0 = runs;
    while (pending.length > 0) pending.shift()();
    R.eq("coalescing", runs - r0, 1, "draining after 100 deferred writes");
    R.eq("coalescing", s.peek(), 100, "the effect must observe the LATEST value, not the first");
    stop();
}

/* -- 5. A scheduler that never invokes run ---------------------------------- */
{
    // Contract-honouring, not a bug: the effect simply never runs. What matters
    // is that it does not wedge the flush or block unrelated effects.
    const r = reg();
    const s = r.signal(0);
    let dormantRuns = 0;
    let neighbourRuns = 0;
    const dormant = r.effect(function () { dormantRuns++; s(); }, { scheduler: () => { /* dropped */ } });
    const neighbour = r.effect(function () { neighbourRuns++; s(); });
    const d0 = dormantRuns;
    const n0 = neighbourRuns;
    let threw = null;
    try { s.set(1); s.set(2); } catch (err) { threw = err; }
    R.ok("never-invoked", threw === null, `a dropped thunk broke the flush: ${threw && threw.message}`);
    R.eq("never-invoked", dormantRuns, d0, "an effect whose scheduler dropped run still executed");
    R.ok("never-invoked", neighbourRuns > n0, "a dropped thunk starved an unrelated effect");
    dormant(); neighbour();
}

/* -- 6. A synchronous scheduler behaves like no scheduler ------------------- */
{
    const r = reg();
    const s = r.signal(0);
    let syncRuns = 0;
    let plainRuns = 0;
    const stopSync = r.effect(function () { syncRuns++; s(); }, { scheduler: (run) => run() });
    const stopPlain = r.effect(function () { plainRuns++; s(); });
    const a0 = syncRuns, b0 = plainRuns;
    s.set(1);
    s.set(2);
    R.eq("sync-scheduler", syncRuns - a0, plainRuns - b0,
        "a synchronous scheduler produced a different run count than no scheduler");
    stopSync(); stopPlain();
}

/* -- 7. A scheduler invoking run twice -------------------------------------- */
{
    // PIN, not a contract: nothing documents what a double invocation should
    // mean. The observed answer is better than I assumed when writing this --
    // the body runs ONCE. The thunk calls executeEffect on both invocations,
    // but the second finds the effect already settled for this globalVersion and
    // does no work, so a sloppy scheduler that fires `run` twice cannot double-
    // apply an effect. Worth stating in llms.txt as a guarantee rather than
    // leaving it as an accident of the eval bookkeeping.
    const r = reg();
    const s = r.signal(0);
    let runs = 0;
    let threw = null;
    const stop = r.effect(function () { runs++; s(); }, { scheduler: (run) => { run(); run(); } });
    const before = runs;
    try { s.set(1); } catch (err) { threw = err; }
    R.ok("double-invoke", threw === null, `invoking run twice threw: ${threw && threw.message}`);
    R.eq("double-invoke", runs - before, 1,
        "a scheduler invoking run twice now double-applies the effect (pin changed)");
    stop();
}

/* -- 8. A throwing scheduler must not take the pass down -------------------- */
{
    const r = reg();
    const s = r.signal(0);
    let goodRuns = 0;
    // Throw on RE-schedule only. The very first call happens inside `effect()`
    // itself, outside the flush loop's try/catch, so a scheduler that throws
    // immediately propagates to the caller -- correct, but a different path
    // from the one being tested here.
    let firstCall = true;
    const bad = r.effect(function () { s(); }, {
        scheduler: (run) => {
            if (firstCall) { firstCall = false; run(); return; }
            throw new Error("scheduler exploded");
        },
    });
    const good = r.effect(function () { goodRuns++; s(); });
    const g0 = goodRuns;
    let threw = null;
    try { s.set(1); } catch (err) { threw = err; }
    R.ok("throwing-scheduler", goodRuns > g0,
        `a throwing scheduler starved an unrelated effect${threw ? ` (flush threw: ${threw.message})` : ""}`);
    bad(); good();
}

/* -- 9. Saturation: writes landing mid-drain must not be lost --------------- */

async function saturation() {
    const r = reg();
    const s = r.signal(0);
    const observed = new Int32Array(SATURATION);
    const stops = new Array(SATURATION);
    let pending = [];
    let threw = null;

    try {
        for (let i = 0; i < SATURATION; i++) {
            const idx = i;
            stops[i] = r.effect(function () { observed[idx] = s(); },
                { scheduler: (run) => { pending.push(run); } });
        }
        // Initial schedule drains first.
        let batchRuns = pending; pending = [];
        for (const run of batchRuns) run();

        // Now the storm: write, drain half, write again mid-drain, drain the rest.
        s.set(1);
        batchRuns = pending; pending = [];
        const half = batchRuns.length >> 1;
        for (let i = 0; i < half; i++) batchRuns[i]();
        s.set(2);                                    // lands while the drain is in flight
        for (let i = half; i < batchRuns.length; i++) batchRuns[i]();
        // Anything re-scheduled by the mid-drain write.
        let guard = 0;
        while (pending.length > 0 && guard++ < 10) {
            const next = pending; pending = [];
            for (const run of next) run();
        }
        await flushMicrotasks();
    } catch (err) {
        threw = err;
    }

    R.ok("saturation", threw === null, `saturation storm threw: ${threw && threw.message}`);

    // Every effect must have settled on the FINAL value. A lost update shows up
    // as a stale entry; a torn drain shows up as a mix.
    let stale = 0;
    let firstStale = -1;
    for (let i = 0; i < SATURATION; i++) {
        if (observed[i] !== s.peek()) { stale++; if (firstStale === -1) firstStale = i; }
    }
    R.eq("saturation", stale, 0,
        stale === 0 ? "" : `${stale} effect(s) settled on a stale value; first is #${firstStale} ` +
            `holding ${observed[firstStale]} while the signal is ${s.peek()}`);

    R.note(`${SATURATION.toLocaleString()} deferred effects drained with a write landing mid-drain`);
    for (let i = 0; i < SATURATION; i++) stops[i]();
}

/* -- 10. Dispose arriving mid-drain ----------------------------------------- */
{
    // Half the pending thunks belong to effects disposed after scheduling but
    // before draining. They must no-op; the survivors must still run.
    const r = reg();
    const s = r.signal(0);
    const N = 200;
    const runs = new Int32Array(N);
    const stops = new Array(N);
    let pending = [];
    for (let i = 0; i < N; i++) {
        const idx = i;
        stops[i] = r.effect(function () { runs[idx]++; s(); }, { scheduler: (run) => pending.push(run) });
    }
    for (const run of pending) run();
    pending = [];

    s.set(1);
    const scheduled = pending; pending = [];
    for (let i = 0; i < N; i += 2) stops[i]();          // dispose every other one
    const before = Array.from(runs);
    let threw = null;
    try { for (const run of scheduled) run(); } catch (err) { threw = err; }

    R.ok("dispose-mid-drain", threw === null, `draining after dispose threw: ${threw && threw.message}`);
    let deadRan = 0;
    let liveSkipped = 0;
    for (let i = 0; i < N; i++) {
        if (i % 2 === 0 && runs[i] !== before[i]) deadRan++;
        if (i % 2 === 1 && runs[i] === before[i]) liveSkipped++;
    }
    R.eq("dispose-mid-drain", deadRan, 0, "disposed effects ran from their pending thunks");
    R.eq("dispose-mid-drain", liveSkipped, 0, "live effects were skipped because their neighbours were disposed");
    for (let i = 1; i < N; i += 2) stops[i]();
}

/* -- driver ----------------------------------------------------------------- */

await saturation();
process.exit(R.finish("every deferred-execution contract held under saturation"));
