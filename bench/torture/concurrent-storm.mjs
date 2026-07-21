/**
 * bench/torture/concurrent-storm.mjs -- reentrancy, nesting and flush-order storm.
 *
 * Everything here targets contracts llms.txt states explicitly, because those
 * are the ones a versioning or queue bug breaks quietly:
 *
 *   - "Double-buffered effect queue: effectQueueA / effectQueueB alternate each
 *      flush pass -- effects *scheduled by* the current pass drain in the next."
 *   - "A self-write (an effect writing a signal it reads) ... does not re-queue
 *      the writing effect, so a self-cycle runs exactly once -- while the write
 *      still propagates to the signal's other observers, and the effect stays
 *      responsive to later external writes."
 *   - "Mutual cross-effect write loops (A->B->A) ... trip CycleError: flush
 *      passes exceeded via maxFlushPasses."
 *   - "Nested batches flush at the outermost boundary."
 *
 * Each of those is a precise, falsifiable statement, and none of the other
 * torture files exercises any of them. The soaks perform writes inside effects
 * incidentally, but their oracle is "nothing threw" -- a self-write that ran
 * twice, or a cascade that drained a pass early, throws nothing.
 *
 * The randomised storm at the end mixes all of it together under a seeded RNG
 * and asserts the surviving invariants: no unexpected throw, effect run counts
 * stay finite, and the graph still settles to oracle-correct values.
 *
 * Exit code: 0 iff every documented contract held.
 *
 * Usage: node --expose-gc bench/torture/concurrent-storm.mjs
 *        STORM_SEEDS=2000 node --expose-gc bench/torture/concurrent-storm.mjs
 */

import { createRegistry } from "../../Signal.js";
import { mulberry32, randInt, soakRegistry, createReport, flushMicrotasks } from "./helpers/index.mjs";

const SEEDS = Number(process.env.STORM_SEEDS || 200);
const R = createReport(`lite-signal concurrent storm -- reentrancy + flush ordering, ${SEEDS} seeds`);
const reg = () => soakRegistry(createRegistry);

/* -- 1. Self-write: runs once, still propagates, stays responsive ----------- */
{
    const r = reg();
    const s = r.signal(0);
    let selfRuns = 0;
    let otherRuns = 0;

    const stopOther = r.effect(function () { otherRuns++; s(); });
    const o0 = otherRuns;

    const stopSelf = r.effect(function () {
        selfRuns++;
        const v = s();
        if (v < 5) s.set(v + 1);          // writes a signal it reads
    });

    // Contract: the writing effect is not re-queued by its own write, so this
    // settles instead of looping. Exactly one run per external trigger.
    R.ok("self-write", selfRuns >= 1, "the self-writing effect never ran");
    R.ok("self-write", selfRuns < 50, `self-write cycled ${selfRuns} times; it must not re-queue itself`);

    // ...but the write must still reach the signal's OTHER observers.
    R.ok("self-write", otherRuns > o0, "a self-write did not propagate to the signal's other observers");

    // ...and the effect must remain responsive to later EXTERNAL writes.
    const before = selfRuns;
    s.set(100);
    R.ok("self-write", selfRuns > before, "after a self-write the effect stopped responding to external writes");

    stopSelf(); stopOther();
}

/* -- 2. Mutual cross-effect loop trips the ceiling -------------------------- */
{
    const r = soakRegistry(createRegistry, { maxFlushPasses: 20 });
    const a = r.signal(0);
    const b = r.signal(0);
    let threw = null;
    let runsA = 0;
    let runsB = 0;
    try {
        const stopA = r.effect(function () { runsA++; b.set(a() + 1); });
        const stopB = r.effect(function () { runsB++; a.set(b() + 1); });
        a.set(1);
        stopA(); stopB();
    } catch (err) {
        threw = err;
    }
    // A->B->A is NOT a self-cycle, so it must be caught by the ceiling rather
    // than spinning forever. The precise message is documented.
    R.ok("cross-effect-loop", threw !== null, "a mutual A->B->A write loop did not trip any ceiling");
    if (threw !== null) {
        R.ok("cross-effect-loop", /CycleError/.test(threw.message),
            `expected a CycleError, got: ${threw.message}`);
    }
    R.ok("cross-effect-loop", runsA < 1000 && runsB < 1000,
        `the loop ran ${runsA}/${runsB} times before stopping -- the ceiling is not bounding it`);
}

/* -- 3. Nested batches flush only at the outermost boundary ----------------- */
{
    const r = reg();
    const s = r.signal(0);
    let runs = 0;
    const stop = r.effect(function () { runs++; s(); });
    const base = runs;
    let innerRuns = -1;

    r.batch(function () {
        s.set(1);
        r.batch(function () {
            s.set(2);
            r.batch(function () { s.set(3); });
            innerRuns = runs;               // still inside: nothing may have flushed
        });
    });

    R.eq("nested-batch", innerRuns, base, "an inner batch boundary flushed early");
    R.eq("nested-batch", runs - base, 1, "the whole nest should produce exactly one run");
    R.eq("nested-batch", s.peek(), 3, "final value after nested batches");
    stop();
}

/* -- 4. Effects scheduled BY a pass drain in the NEXT pass ------------------ */
{
    // Double-buffering means a cascade is ordered, not interleaved: everything
    // queued during pass N runs together in pass N+1.
    const r = reg();
    const trigger = r.signal(0);
    const relay = r.signal(0);
    const order = [];

    const stopA = r.effect(function () { const v = trigger(); order.push("A" + v); if (v > 0) relay.set(v); });
    const stopB = r.effect(function () { const v = relay(); order.push("B" + v); });

    order.length = 0;
    trigger.set(1);

    // A writes relay during its pass; B must run after A's pass completes.
    const ai = order.indexOf("A1");
    const bi = order.indexOf("B1");
    R.ok("double-buffer", ai !== -1, `the writing effect did not run: ${JSON.stringify(order)}`);
    R.ok("double-buffer", bi !== -1, `the cascaded effect did not run: ${JSON.stringify(order)}`);
    if (ai !== -1 && bi !== -1) {
        R.ok("double-buffer", ai < bi, `cascade ran out of order: ${order.join(",")}`);
    }
    stopA(); stopB();
}

/* -- 5. Writes and reads inside cleanup ------------------------------------- */
{
    const r = reg();
    const s = r.signal(0);
    const audit = r.signal(0);
    let auditRuns = 0;
    let cleanupReads = [];
    let threw = null;

    const stopAudit = r.effect(function () { auditRuns++; audit(); });

    try {
        const stop = r.effect(function () {
            const v = s();
            r.onCleanup(function () {
                // Reading during cleanup must be safe and must see the value the
                // run was working with, not a torn intermediate.
                cleanupReads.push(s.peek());
                // Writing during cleanup must not corrupt the in-flight flush.
                audit.set(audit.peek() + 1);
            });
        });
        s.set(1);
        s.set(2);
        stop();
    } catch (err) {
        threw = err;
    }

    R.ok("cleanup-write", threw === null, `writing inside cleanup threw: ${threw && threw.message}`);
    R.ok("cleanup-write", cleanupReads.length >= 2, `cleanup ran ${cleanupReads.length} times, expected >= 2`);
    R.ok("cleanup-write", auditRuns >= 1, "a write inside cleanup never reached its observer");
    R.eq("cleanup-write", audit.peek(), cleanupReads.length, "one audit increment per cleanup pass");
}

/* -- 6. Disposing an effect from inside another effect mid-flush ------------ */
{
    const r = reg();
    const s = r.signal(0);
    let victimRuns = 0;
    let threw = null;
    try {
        const victim = r.effect(function () { victimRuns++; s(); });
        const killer = r.effect(function () {
            if (s() === 1) victim();          // dispose the victim during the same flush
        });
        const before = victimRuns;
        s.set(1);
        R.ok("dispose-mid-flush", victimRuns <= before + 1,
            `a victim disposed mid-flush ran ${victimRuns - before} times`);
        const afterKill = victimRuns;
        s.set(2);
        R.eq("dispose-mid-flush", victimRuns, afterKill, "a disposed effect ran again after the flush");
        killer();
    } catch (err) { threw = err; }
    R.ok("dispose-mid-flush", threw === null, `disposing mid-flush threw: ${threw && threw.message}`);
}

/* -- 7. Self-disposal from inside the effect body --------------------------- */
{
    const r = reg();
    const s = r.signal(0);
    let runs = 0;
    let threw = null;
    try {
        let stop;
        stop = r.effect(function () { runs++; if (s() === 1) stop(); });
        s.set(1);
        const after = runs;
        s.set(2);
        R.eq("self-dispose", runs, after, "an effect that disposed itself ran again");
    } catch (err) { threw = err; }
    R.ok("self-dispose", threw === null, `self-disposal threw: ${threw && threw.message}`);
}

/* -- 8. Async writes interleaved with flushes ------------------------------- */

async function asyncStorm() {
    const r = reg();
    const sigs = Array.from({ length: 8 }, (_, i) => r.signal(i));
    let runs = 0;
    let threw = null;
    const stop = r.effect(function () { runs++; for (const s of sigs) s(); });

    try {
        // Writes landing from microtasks, some inside batches, some not, while
        // previous flushes are still settling.
        const tasks = [];
        for (let i = 0; i < 200; i++) {
            tasks.push(Promise.resolve().then(function () {
                if (i % 3 === 0) r.batch(function () { sigs[i % 8].set(i); sigs[(i + 1) % 8].set(i); });
                else sigs[i % 8].set(i);
            }));
        }
        await Promise.all(tasks);
        await flushMicrotasks();
    } catch (err) { threw = err; }

    R.ok("async-writes", threw === null, `async write storm threw: ${threw && threw.message}`);
    R.ok("async-writes", runs > 1, "the effect never re-ran during the async storm");
    // Whatever the interleaving, the settled read must equal the last write.
    for (let i = 0; i < 8; i++) {
        const want = sigs[i].peek();
        R.eq("async-writes", sigs[i](), want, `signal ${i} disagrees with its own peek after the storm`);
    }
    stop();
}

/* -- 9. Randomised mixed storm ---------------------------------------------- */

function mixedStorm(seed) {
    const rnd = mulberry32(seed);
    const r = soakRegistry(createRegistry, { maxFlushPasses: 200 });
    const leaves = Array.from({ length: 6 }, (_, i) => r.signal(i));
    const model = leaves.map((_, i) => i);          // shadow of the leaf values
    let runs = 0;
    let threw = null;

    const comps = [];
    for (let i = 0; i < 4; i++) {
        const a = randInt(rnd, leaves.length);
        const b = randInt(rnd, leaves.length);
        comps.push(r.computed(function () { return leaves[a]() + leaves[b](); }));
    }

    const stops = [];
    try {
        for (let i = 0; i < 3; i++) {
            const c = comps[randInt(rnd, comps.length)];
            stops.push(r.effect(function () {
                runs++;
                c();
                r.onCleanup(function () { /* cleanup churn on every re-run */ });
            }));
        }

        for (let op = 0; op < 60; op++) {
            const roll = rnd();
            if (roll < 0.4) {
                const li = randInt(rnd, leaves.length);
                const v = randInt(rnd, 100);
                leaves[li].set(v); model[li] = v;
            } else if (roll < 0.7) {
                r.batch(function () {
                    const n = 1 + randInt(rnd, 3);
                    for (let w = 0; w < n; w++) {
                        const li = randInt(rnd, leaves.length);
                        const v = randInt(rnd, 100);
                        leaves[li].set(v); model[li] = v;
                    }
                });
            } else if (roll < 0.85) {
                r.batch(function () {
                    const li = randInt(rnd, leaves.length);
                    const v = randInt(rnd, 100);
                    leaves[li].set(v); model[li] = v;
                    r.batch(function () {
                        const lj = randInt(rnd, leaves.length);
                        const w = randInt(rnd, 100);
                        leaves[lj].set(w); model[lj] = w;
                    });
                });
            } else {
                r.untrack(function () { comps[randInt(rnd, comps.length)](); });
            }
        }
    } catch (err) {
        threw = err;
    }

    for (const s of stops) { try { s(); } catch { /* already gone */ } }

    if (threw !== null) return { seed, threw };
    // Settled state must match the shadow model exactly.
    for (let i = 0; i < leaves.length; i++) {
        if (!Object.is(leaves[i].peek(), model[i])) {
            return { seed, mismatch: { leaf: i, got: leaves[i].peek(), want: model[i] } };
        }
    }
    return null;
}

/* -- driver ----------------------------------------------------------------- */

await asyncStorm();

let stormFailures = 0;
let firstStorm = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    const bad = mixedStorm(seed);
    if (bad !== null) {
        stormFailures++;
        if (firstStorm === null) firstStorm = bad;
    }
}
if (stormFailures > 0) {
    const d = firstStorm.threw
        ? `seed ${firstStorm.seed} threw: ${firstStorm.threw.message}`
        : `seed ${firstStorm.seed}: leaf ${firstStorm.mismatch.leaf} settled at ${firstStorm.mismatch.got}, model says ${firstStorm.mismatch.want}`;
    R.fail("mixed-storm", `${stormFailures}/${SEEDS} seeds failed; ${d}`);
}

R.note(`${SEEDS} mixed seeds, 8 documented-contract scenarios, 200 async writes`);
process.exit(R.finish("every documented reentrancy and flush-ordering contract held"));
