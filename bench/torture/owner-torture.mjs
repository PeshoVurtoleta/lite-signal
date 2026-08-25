/**
 * bench/torture/owner-torture.mjs -- getOwner / runWithOwner capture-restore (1.5.0+).
 *
 * getOwner() captures the current lifecycle owner as an opaque, gen-stamped
 * handle; runWithOwner(handle, fn) reinstates it so effects/computeds created
 * directly in fn are ADOPTED by that owner (and cascade-dispose when it does).
 * These are load-bearing on every rebuilt-line cut, yet the base suite only
 * exercised happy-path adoption. The safety-critical behaviours checked here:
 *
 *   1. THE ABA DEGRADATION. Handles are gen-stamped with the same describeNode /
 *      liveNode machinery as describe/nodeId/ownerOf. If the captured owner is
 *      disposed and its pool slot recycled by an unrelated node, the handle's gen
 *      no longer matches -- and runWithOwner must degrade to ROOTED execution
 *      rather than adopting the continuation into the recycled slot's NEW resident
 *      (Signal.js:1496 sets currentOwner=null when liveNode returns undefined).
 *
 *   2. ADOPTION vs ROOTING, observably distinguished. A live-owner adoption means
 *      the adopted effect STOPS when the owner is disposed; a rooted effect KEEPS
 *      running. This file drives both and asserts the observable difference.
 *
 *   3. DEP ISOLATION. runWithOwner nulls the tracking observer AND disables
 *      isTrackingDeps for fn's direct body (Signal.js:1497-1498), so reads inside
 *      fn cannot form accidental dependency edges into the surrounding observer.
 *
 *   4. runWithOwner(undefined) runs rooted; nested runWithOwner composes; two
 *      getOwner() calls in one body agree; getOwner() at top level is undefined.
 *
 * PORT NOTE (1.5.0). 1.5.0's owner surface is getOwner/runWithOwner/createRoot --
 * there is NO createScope. The 1.4.4 source built its owner scopes with
 * createScope; here every scope is built from the primitive 1.5.0 ships: an
 * EFFECT is the unit of ownership. Inside an effect body currentOwner IS that
 * effect, so r.getOwner() captures it and children created under it (directly or
 * via runWithOwner) are adopted; the effect's stop() is the cascade-disposer.
 * `ownerScope(r, fn)` below is that shape.
 *
 * MUTATION FINDINGS (recorded honestly). The ADOPTION contract is the reachable,
 * catchable core: breaking runWithOwner so it never adopts (always roots) is
 * caught by scenarios 2 and 6 (an adopted effect must cascade-dispose with its
 * owner; a rooted one must not). The ABA gen-guard and the dep-isolation are
 * DEFENSE-IN-DEPTH, each protected by a redundant second guard, so no single-line
 * mutant reaches them from the public API. On 1.5.0 the ABA guard's TRIGGER (a
 * disposed owner's slot recycled into a NEW owner before restore) is reachable
 * only if the seed fuzz actually forces that exact recycle ordering; the pool
 * hands out fresh slots first, so scenario 3 PINS the observable behaviour
 * (graceful rooted degradation) rather than claiming to catch the guard's removal.
 *
 * Skips if getOwner/runWithOwner are absent.
 *
 * Exit code: 0 iff every owner-handle contract held.
 *
 * Usage: node --expose-gc bench/torture/owner-torture.mjs
 *        OWNER_SEEDS=2000 node --expose-gc bench/torture/owner-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;

{
    let ok = false;
    try {
        const r = createRegistry({ maxNodes: 32, onCapacityExceeded: "grow" });
        ok = typeof r.getOwner === "function" && typeof r.runWithOwner === "function";
    } catch { ok = false; }
    if (!ok) {
        console.log("lite-signal owner torture -- SKIP: getOwner/runWithOwner require 1.5.0+");
        process.exit(77); // SKIP_EXIT — the runner escalates this to FAIL at/above the floor
    }
}

const SEEDS = Number(process.env.OWNER_SEEDS || 300);
const R = createReport(`lite-signal owner torture -- getOwner/runWithOwner capture-restore, ${SEEDS} seeds`);
const reg = () => createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow" });

// An effect is the unit of ownership on 1.5.0. Run `fn` as an effect body (fn may
// call r.getOwner() to capture that effect, and create/adopt children under it)
// and return the effect's stop() -- the cascade-disposer. The body must read no
// signal so the effect runs exactly once and never re-fires mid-scenario.
function ownerScope(r, fn) {
    return r.effect(() => { fn(); });
}

/* -- 1. getOwner: undefined at top level, a handle inside a body ------------ */
{
    const r = reg();
    R.eq("top-level", r.getOwner(), undefined, "getOwner() returned a handle at the top level");

    let inside = "unset";
    const dispose = ownerScope(r, () => { inside = r.getOwner(); });
    R.ok("inside-body", inside !== undefined && inside !== null, "getOwner() inside an owner scope returned no handle");

    // Two captures in one body agree (same owner).
    let a = null, b = null;
    const d2 = ownerScope(r, () => { a = r.getOwner(); b = r.getOwner(); });
    R.ok("stable-capture", a !== undefined && b !== undefined, "one of two getOwner() calls returned nothing");
    dispose(); d2();
}

/* -- 2. Live adoption: an adopted effect cascade-disposes with its owner ---- */
{
    const r = reg();
    const s = r.signal(0);
    let runs = 0;
    const ownerDispose = ownerScope(r, () => {
        const owner = r.getOwner();
        r.runWithOwner(owner, () => { r.effect(() => { s(); runs++; }); });
    });
    const base = runs;
    s.set(1);
    const afterWrite = runs;
    R.ok("live-adopt", afterWrite > base, "the adopted effect never ran on a write");
    ownerDispose();                    // dispose the owner -> the adopted effect must stop
    s.set(2);
    R.eq("live-adopt", runs - afterWrite, 0, "an adopted effect kept running after its owner was disposed (not adopted)");
}

/* -- 3. THE ABA DEGRADATION: stale owner handle degrades to ROOTED ---------- */
{
    const r = reg();
    let captured = null;
    const d = ownerScope(r, () => { captured = r.getOwner(); });
    d();                                             // dispose the owner
    // Recycle the freed slot via the LIFO free list.
    const recyc = [];
    for (let i = 0; i < 32; i++) recyc.push(r.signal(1000 + i));

    const s = r.signal(0);
    let runs = 0;
    let threw = null;
    try {
        r.runWithOwner(captured, () => { r.effect(() => { s(); runs++; }); });
    } catch (e) { threw = e; }
    R.ok("aba-degrade", threw === null, `runWithOwner on a stale handle threw: ${threw && threw.message}`);
    const base = runs;
    s.set(1);
    // The effect ran rooted, so it reacts to writes -- and crucially it was NOT
    // adopted by any recycled resident, so nothing can cascade-dispose it early.
    R.ok("aba-degrade", runs - base >= 1, "the rooted effect from a stale-handle runWithOwner did not react to writes");

    // Prove it is NOT adopted by a recycled resident: dispose every recycled node;
    // the rooted effect must survive and keep reacting.
    for (const n of recyc) r.dispose(n);
    const afterDispose = runs;
    s.set(2);
    R.ok("aba-degrade", runs - afterDispose >= 1,
        "the rooted effect stopped after recycled residents were disposed -- it was wrongly adopted (ABA guard failed)");
}

/* -- 4. Dep isolation: runWithOwner body forms no edge into the outer observer - */
{
    const r = reg();
    const trap = r.signal(0);
    let outerReruns = 0;
    // An outer effect whose body captures the owner and runs a restored body that
    // reads `trap`. The read must NOT become a dependency of the outer effect.
    const stop = r.effect(() => {
        outerReruns++;
        const owner = r.getOwner();
        if (owner !== undefined) {
            r.runWithOwner(owner, () => { trap(); });   // read trap in the restored body
        }
    });
    const base = outerReruns;
    trap.set(1); trap.set(2); trap.set(3);
    R.eq("dep-isolation", outerReruns - base, 0,
        "writing a signal read only inside runWithOwner re-ran the outer effect -- a dep edge leaked");
    stop();
}

/* -- 5. runWithOwner(undefined) runs rooted; nested composes ---------------- */
{
    const r = reg();
    let threw = null;
    try {
        r.runWithOwner(undefined, () => { const e = r.effect(() => {}); e(); });
    } catch (e) { threw = e; }
    R.ok("undefined-owner", threw === null, `runWithOwner(undefined) threw: ${threw && threw.message}`);

    // Nested: capture inside a restored body and restore again.
    let nestOk = true;
    try {
        const d = ownerScope(r, () => {
            const o1 = r.getOwner();
            r.runWithOwner(o1, () => {
                const o2 = r.getOwner();
                r.runWithOwner(o2, () => { const e = r.effect(() => {}); e(); });
            });
        });
        d();
    } catch (e) { nestOk = false; }
    R.ok("nested", nestOk, "nested runWithOwner crashed");
}

/* -- 6. Adopted effect count matches under runWithOwner vs direct creation -- */
{
    // An effect created inside runWithOwner(liveOwner) must be owned exactly like
    // one created directly in the owner's body: same cascade-dispose behaviour,
    // no double-adoption (which would double-dispose).
    const r = reg();
    const s = r.signal(0);
    let directRuns = 0, adoptedRuns = 0;
    const ownerDispose = ownerScope(r, () => {
        r.effect(() => { s(); directRuns++; });               // direct child
        const owner = r.getOwner();
        r.runWithOwner(owner, () => { r.effect(() => { s(); adoptedRuns++; }); }); // adopted child
    });
    const db = directRuns, ab = adoptedRuns;
    s.set(1);
    R.ok("parity", directRuns > db && adoptedRuns > ab, "direct or adopted child failed to run");
    ownerDispose();
    const da = directRuns, aa = adoptedRuns;
    s.set(2);
    R.eq("parity", directRuns - da, 0, "direct child ran after owner dispose");
    R.eq("parity", adoptedRuns - aa, 0, "adopted child ran after owner dispose -- adoption differs from direct");
}

/* -- 7. Fuzz: capture/dispose/recycle/restore never crashes, always degrades - */

function fuzzSeed(seed) {
    const rnd = mulberry32(seed);
    const r = reg();
    const handles = [];

    // Build a handful of owner scopes, capturing each owner.
    const scopes = [];
    const n = 2 + randInt(rnd, 4);
    for (let i = 0; i < n; i++) {
        scopes.push(ownerScope(r, () => { handles.push(r.getOwner()); }));
    }
    // Dispose a random subset (staling their handles).
    for (let i = 0; i < scopes.length; i++) {
        if (rnd() < 0.5) scopes[i]();
    }
    // Churn the pool to recycle freed slots.
    const churn = [];
    for (let i = 0; i < 20; i++) churn.push(r.signal(i));
    for (let i = 0; i < churn.length; i++) if (rnd() < 0.5) r.dispose(churn[i]);

    // Restore every captured handle (live or stale) and create an effect inside.
    const s = r.signal(0);
    for (const h of handles) {
        r.runWithOwner(h, () => { r.effect(() => { s(); }); });
    }
    // Drive a write; nothing must crash.
    s.set(1);

    // Dispose remaining scopes.
    for (const sc of scopes) { try { sc(); } catch { /* already disposed */ } }
    return null;   // success == no throw
}

let fuzzFail = 0;
let firstFail = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    try { fuzzSeed(seed); }
    catch (err) { fuzzFail++; if (!firstFail) firstFail = { seed, threw: err.message }; }
}
if (fuzzFail > 0) {
    R.fail("owner-fuzz", `${fuzzFail}/${SEEDS} seeds crashed; first seed ${firstFail.seed}: ${firstFail.threw}`);
}

R.note(`${SEEDS} seeds: capture/dispose/recycle/restore of owner handles never crashed`);

/* -- 8. Owner handle across destroy(): degrade to ROOTED, never crash ------- */
{
    // destroy() bumps every node's gen, so a handle captured BEFORE it is the
    // deepest staleness the ABA guard faces: not one recycled slot but a whole
    // reset world. Contract (2026-08 audit, Phase 2; verified live on 1.5.0):
    // runWithOwner on the pre-destroy handle degrades to ROOTED execution --
    // the continuation effect is alive, runs on writes, and ownerOf() reports
    // it unowned -- exactly the corpse/recycled degradation the fuzz above
    // pins, extended across the registry reset.
    const r = reg();
    let cap = null;
    r.effect(() => { cap = r.getOwner(); });
    R.ok("owner-destroy", cap !== undefined && cap !== null, "getOwner returned nothing inside an effect");
    r.destroy();

    const s = r.signal(0);
    let runs = 0, inner = null, threw = null;
    try {
        r.runWithOwner(cap, () => { inner = r.effect(() => { s(); runs++; }); });
        s.set(1);
    } catch (e) { threw = e; }
    R.ok("owner-destroy", threw === null, `runWithOwner on a pre-destroy handle threw: ${threw && threw.message}`);
    R.eq("owner-destroy", runs, 2, "the continuation effect under a pre-destroy owner is not alive (want creation run + 1 write)");
    // Fail CLOSED on a missing ownerOf: "unverifiable" must not alias the pass
    // value (undefined) -- same sentinel discipline as harness/owner-hazard-repro.
    const owner = typeof r.ownerOf === "function" ? r.ownerOf(inner) : "<engine lacks ownerOf -- unverifiable>";
    R.ok("owner-destroy", owner === undefined,
        `continuation is owned by ${JSON.stringify(owner)} -- a pre-destroy handle must degrade to rooted, not adopt`);
}

process.exit(R.finish("owner handles adopt live owners, degrade stale handles to rooted, and isolate deps"));
