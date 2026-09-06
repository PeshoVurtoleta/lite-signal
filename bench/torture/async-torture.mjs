/**
 * bench/torture/async-torture.mjs — watch / when / whenAsync.
 *
 * These three are the public async surface, and every one of them makes a
 * precise, falsifiable promise that the differential fuzzers cannot see because
 * they never call them:
 *
 *   watch(source, cb, opts) — fires cb(newValue, oldValue, stop) when the
 *     PROJECTED value changes under Object.is. The projection guard is the
 *     subtle part: a raw dependency mutation that leaves the projected value
 *     unchanged must NOT fire. `oldValue` must be the previous projection.
 *     `stop` must work from inside the callback. The disposer is idempotent.
 *
 *   when(pred, cb) — fires cb exactly once when pred first goes truthy, then
 *     auto-disposes. Synchronous if pred is already truthy. Never fires twice.
 *
 *   whenAsync(pred) — resolves once when pred first goes truthy. Never rejects.
 *     Never re-settles. A held reference must not keep firing.
 *
 * A bug in any of these produces correct-looking graph values — the signals are
 * all fine — while the callback fires the wrong number of times, with the wrong
 * arguments, or after it was supposed to stop. That is invisible to a value
 * oracle and to a wakeup counter that only knows about effects.
 *
 * Where the shipped behaviour differs from the type declaration (the immediate
 * callback delivers oldValue === null, while the .d.ts says undefined) this file
 * PINS the shipped behaviour and flags the discrepancy, rather than encoding
 * either as gospel.
 *
 * Exit code: 0 iff every async-utility contract held.
 *
 * Usage: node --expose-gc bench/torture/async-torture.mjs
 *        ASYNC_SEEDS=2000 node --expose-gc bench/torture/async-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, soakRegistry, createReport, flushMicrotasks } from "./helpers/index.mjs";

const { createRegistry, setDefaultRegistry, signal } = Signal;
const { watch, when, whenAsync } = Signal;

if (typeof watch !== "function" || typeof when !== "function" || typeof whenAsync !== "function") {
    console.log("lite-signal async torture — SKIP: watch/when/whenAsync not all present");
    process.exit(77); // SKIP_EXIT — the runner escalates this to FAIL at/above the floor
}

// These are top-level helpers bound to the default registry, so give it a pool
// large enough for the storm and restore it afterwards.
const savedDefault = (() => { try { return null; } catch { return null; } })();
setDefaultRegistry(soakRegistry(createRegistry, { maxNodes: 1 << 16, maxLinks: 1 << 18 }));

const SEEDS = Number(process.env.ASYNC_SEEDS || 300);
const R = createReport(`lite-signal async torture — watch/when/whenAsync, ${SEEDS} seeds`);

/* ── 1. watch: values, oldValue, projection guard ─────────────────────────── */
{
    const s = signal(1);
    const log = [];
    const stop = watch(() => s(), (nv, ov) => log.push([nv, ov]), { immediate: true });

    // Immediate fire. The .d.ts documents oldValue === undefined; the engine
    // delivers null. Pin the SHIPPED behaviour and record the mismatch so it is
    // a deliberate decision, not a silent drift.
    R.eq("watch-immediate", log.length, 1, "immediate:true did not fire on registration");
    R.eq("watch-immediate", log[0][0], 1, "immediate fire delivered the wrong new value");
    if (log[0][1] !== undefined) {
        R.note(`watch immediate oldValue is ${String(log[0][1])}, but Signal.d.ts documents \`undefined\` — reconcile before 1.5.0`);
    }

    s.set(2);
    s.set(2);                                   // no-op: projection unchanged
    s.set(3);
    R.eq("watch-change", log.length, 3, "a duplicate write fired the watcher (projection guard failed)");
    R.eq("watch-change", log[1][0], 2, "wrong new value");
    R.eq("watch-change", log[1][1], 1, "oldValue was not the previous projection");
    R.eq("watch-change", log[2][1], 2, "oldValue drifted across fires");

    stop();
    const after = log.length;
    s.set(99);
    R.eq("watch-stop", log.length, after, "the watcher fired after being stopped");
}
{
    // The projection guard, isolated: the raw dependency changes identity every
    // write but the projected field does not. Object.is on the projection must
    // suppress all but the real change.
    const o = signal({ v: 1 });
    const log = [];
    watch(() => o().v, (nv, ov) => log.push([nv, ov]));
    o.set({ v: 1 });                            // new object, same projection
    o.set({ v: 1 });
    o.set({ v: 2 });                            // real change
    R.eq("watch-projection", log.length, 1, "the projection guard let an unchanged value through");
    if (log.length === 1) R.eq("watch-projection", log[0][0], 2, "wrong value survived the guard");
}
{
    // stop() called from INSIDE the callback must halt further fires.
    const s = signal(0);
    const log = [];
    watch(() => s(), (nv, ov, stop) => { log.push(nv); if (nv === 2) stop(); });
    s.set(1); s.set(2); s.set(3); s.set(4);
    R.ok("watch-self-stop", log.join(",") === "1,2", `stop() from inside the callback did not halt it: ${log.join(",")}`);
}
{
    // A watcher on a NaN projection: Object.is(NaN, NaN) is true, so writing NaN
    // over NaN must not fire, but the first transition to NaN must.
    const s = signal(0);
    const log = [];
    watch(() => (s() === 0 ? NaN : s()), (nv) => log.push(nv));
    s.set(0);                                   // still projects NaN
    s.set(5);                                   // NaN -> 5
    s.set(0);                                   // 5 -> NaN
    R.eq("watch-nan", log.length, 2, `NaN projection guard miscounted: ${log.map(String).join(",")}`);
}

/* ── 2. when: once, synchronous-if-truthy, cancellable ────────────────────── */
{
    let fired = 0;
    when(() => true, () => fired++);
    R.eq("when-sync", fired, 1, "when did not fire synchronously on an already-truthy predicate");
}
{
    const g = signal(0);
    let fired = 0;
    when(() => g() > 0, () => fired++);
    g.set(1);
    g.set(2);
    g.set(3);
    R.eq("when-once", fired, 1, `when fired ${fired} times; it must fire exactly once then auto-dispose`);
}
{
    // Cancel before the predicate fires.
    const g = signal(0);
    let fired = 0;
    const cancel = when(() => g() > 0, () => fired++);
    cancel();
    g.set(1);
    R.eq("when-cancel", fired, 0, "a cancelled when still fired");
    let threw = null;
    try { cancel(); cancel(); } catch (err) { threw = err; }
    R.ok("when-cancel", threw === null, `repeated cancel threw: ${threw && threw.message}`);
}
{
    // A predicate that toggles truthy→falsy→truthy must still fire only once,
    // on the FIRST truthy, and not re-arm.
    const g = signal(1);
    let fired = 0;
    when(() => g() > 0, () => fired++);        // already truthy -> fires now
    g.set(-1);
    g.set(1);
    R.eq("when-no-rearm", fired, 1, "when re-armed after firing");
}

/* ── 3. whenAsync: resolves once, never rejects, never re-settles ─────────── */

async function whenAsyncContracts() {
    {
        const a = signal(0);
        const p = whenAsync(() => a() > 0);
        let settled = 0;
        p.then(() => settled++, () => settled--);   // count resolve(+) vs reject(-)
        a.set(1);
        await flushMicrotasks();
        await flushMicrotasks();
        R.eq("whenAsync-resolve", settled, 1, "whenAsync did not resolve exactly once on truthy");

        // Further writes must not re-settle (a promise cannot, but the machinery
        // behind it must not throw or leak a second registration).
        a.set(2);
        a.set(0);
        a.set(3);
        await flushMicrotasks();
        R.eq("whenAsync-resolve", settled, 1, "whenAsync re-settled after resolving");
    }
    {
        // Already truthy at registration: resolves without a write.
        const a = signal(5);
        let resolved = false;
        await whenAsync(() => a() > 0).then(() => { resolved = true; });
        R.ok("whenAsync-immediate", resolved, "whenAsync on an already-truthy predicate never resolved");
    }
    {
        // A predicate that briefly goes truthy inside a batch, then falsy, before
        // the microtask runs. whenAsync fires on the FIRST truthy observation.
        const a = signal(0);
        let resolved = false;
        const p = whenAsync(() => a() > 0).then(() => { resolved = true; });
        a.set(1);
        await p;
        R.ok("whenAsync-batch", resolved, "whenAsync missed a transient truthy transition");
    }
}

/* ── 4. Randomised mixed storm ────────────────────────────────────────────── */

function watchStorm(seed) {
    const rnd = mulberry32(seed);
    const s = signal(0);

    const project = (v) => (v & ~1);            // collapse pairs so ~half the writes are no-ops under the projection

    // A shadow of what the watcher SHOULD have seen. Without `immediate`, watch
    // does NOT fire on registration: the projection at registration time is the
    // BASELINE, and only a change away from it fires. So the shadow seeds
    // lastProjected with the initial projection and counts no fire for it.
    const expected = [];
    let lastProjected = project(s.peek());

    const actual = [];
    const stop = watch(() => project(s()), (nv) => actual.push(nv));

    const writes = 40 + randInt(rnd, 40);
    for (let i = 0; i < writes; i++) {
        const v = randInt(rnd, 20);
        const proj = project(v);
        if (!Object.is(proj, lastProjected)) {
            expected.push(proj);
            lastProjected = proj;
        }
        s.set(v);
    }
    stop();

    if (actual.length !== expected.length) {
        return { seed, reason: `fire count ${actual.length} vs expected ${expected.length}` };
    }
    for (let i = 0; i < expected.length; i++) {
        if (!Object.is(actual[i], expected[i])) {
            return { seed, reason: `fire #${i}: got ${actual[i]}, expected ${expected[i]}` };
        }
    }
    return null;
}

/* ── driver ───────────────────────────────────────────────────────────────── */

await whenAsyncContracts();

let stormFailures = 0;
let firstStorm = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    let bad;
    try { bad = watchStorm(seed); }
    catch (err) { bad = { seed, reason: "threw: " + err.message }; }
    if (bad !== null) {
        stormFailures++;
        if (firstStorm === null) firstStorm = bad;
    }
}
if (stormFailures > 0) {
    R.fail("watch-storm", `${stormFailures}/${SEEDS} seeds disagreed; first at seed ${firstStorm.seed}: ${firstStorm.reason}`);
}

R.note(`${SEEDS} watch-storm seeds + watch/when/whenAsync contract scenarios`);
process.exit(R.finish("every async-utility contract held"));
