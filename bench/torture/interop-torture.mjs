/**
 * bench/torture/interop-torture.mjs — multi-registry isolation + the
 * destroy() staleness contract.
 *
 * 2026-08 instrument audit, Phase 2. Two silently-degrading quadrants had no
 * torture coverage:
 *
 *   MULTI-REGISTRY ISOLATION -- registries are isolated reactive worlds.
 *   Reading registry A's signal from inside registry B's effect returns the
 *   current VALUE but establishes NO tracking link: each registry's
 *   currentObserver lives in its own closure, so A's read sees no observer
 *   and B's effect records no dep. That is the documented degradation -- and
 *   exactly the kind that ships green forever if untested, because nothing
 *   crashes; the effect just never re-runs. Pinned here: no re-run, no link
 *   on either side, batches do not cross registries (a foreign write inside
 *   rA.batch flushes immediately), and cross-registry dispose() splits by
 *   handle kind: signal/computed handles (which carry .peek) fail the
 *   per-registry NODE_PTR lookup AND the arbitrary-function duck-test, so
 *   they genuinely no-op -- but an effect-STOP handle is a plain function,
 *   and dispose()'s documented function-call contract INVOKES it, killing
 *   the foreign effect. Both halves are pinned (2026-08 review: the first
 *   draft overclaimed "silent no-op" universally and left the divergent
 *   effect-stop path ungated).
 *
 *   DESTROY STALENESS -- destroy() resets all pools and bumps every node's
 *   gen. Every handle from before the destroy must degrade fail-closed:
 *   reads -> undefined, set()/dispose()/effect-stop -> silent no-ops,
 *   describe() -> undefined; a scheduler thunk still pending at destroy time
 *   fires into the gen guard and no-ops; destroy() is idempotent; and the
 *   registry is immediately REUSABLE with fresh nodes. Verified single-shot
 *   and then hammered: thousands of stale-handle operations after destroy
 *   must neither throw nor resurrect state nor disturb the reused registry.
 *
 * All surfaces here are 1.4.0-floor (signal/computed/effect/batch/dispose/
 * destroy/stats; hasObservers is 1.1.4). Owner-handle staleness across
 * destroy() is pinned in owner-torture.mjs (1.5.0 floor) where a missing
 * owner surface is a FAILURE, not a skip.
 *
 * Exit code: 0 iff isolation held and every stale handle degraded silently.
 *
 * Usage: node --expose-gc bench/torture/interop-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;
const R = createReport("lite-signal interop torture — multi-registry isolation + destroy staleness");

/* ── 1. cross-registry read: value flows, tracking never links ────────────── */
{
    const rA = createRegistry(), rB = createRegistry();
    const sA = rA.signal(1);
    const a0 = rA.stats(), b0 = rB.stats();

    let runs = 0, seen = -1;
    const stop = rB.effect(() => { seen = sA(); runs++; });
    R.eq("cross-read", seen, 1, "the cross-registry read did not return the current value");
    R.eq("cross-read", runs, 1, "creation run count wrong");

    // The load-bearing pin: no link was created on EITHER side.
    R.eq("cross-read", rA.stats().activeLinks - a0.activeLinks, 0, "a cross-registry read created a link in the SOURCE registry");
    R.eq("cross-read", rB.stats().activeLinks - b0.activeLinks, 0, "a cross-registry read created a link in the OBSERVER registry");
    R.ok("cross-read", rA.hasObservers(sA) === false, "the source registry reports an observer for a foreign effect");

    sA.set(2);
    R.eq("cross-read", runs, 1, "a foreign effect RE-RAN on the source's write -- cross-registry tracking must not exist");
    R.eq("cross-read", seen, 1, "the foreign effect's captured value moved without a re-run");
    R.eq("cross-read", sA.peek(), 2, "the source write itself was lost");

    // Same for a foreign COMPUTED: value flows on pull, no subscription forms.
    const cA = rA.computed(() => sA() * 10);
    let cSeen = -1, cRuns = 0;
    rB.effect(() => { cSeen = cA(); cRuns++; });
    R.eq("cross-read", cSeen, 20, "a foreign computed did not deliver its value on pull");
    sA.set(3);
    R.eq("cross-read", cRuns, 1, "a foreign effect re-ran through a foreign computed");
    R.eq("cross-read", cA(), 30, "the foreign computed went stale for direct pulls -- laziness must survive the foreign read");
    stop();
}

/* ── 2. batches do not cross registries ───────────────────────────────────── */
{
    const rA = createRegistry(), rB = createRegistry();
    const sB = rB.signal(0);
    let runs = 0, seen = -1, insideDelta = -1;
    rB.effect(() => { seen = sB(); runs++; });
    rA.batch(() => {
        sB.set(7);
        insideDelta = runs - 1;   // sampled INSIDE rA's batch body
    });
    R.eq("cross-batch", insideDelta, 1, "a write to registry B was deferred by registry A's batch -- batches must not cross");
    R.eq("cross-batch", seen, 7, "the foreign write's flush delivered a stale value");
    R.eq("cross-batch", runs - 1, 1, "flush count wrong after the cross-batch write");
}

/* ── 3. cross-registry dispose: no-op for node handles, INVOKE for stops ──── */
{
    // The TRUE 1.5.0 contract, both halves (2026-08 review corrected the first
    // draft's overclaim): signal/computed handles carry .peek, so a foreign
    // dispose() fails the per-registry NODE_PTR lookup, fails the arbitrary-
    // function duck-test, and genuinely no-ops. An effect-STOP handle is a
    // plain function with no .peek -- dispose()'s documented function-call
    // contract ("passing an arbitrary function invokes it") applies, so a
    // foreign dispose INVOKES the stop and the effect dies exactly as if its
    // owner had called it. Both paths are pinned so a future change to the
    // fallback (tightening OR widening) trips loudly.
    const rA = createRegistry(), rB = createRegistry();
    const sA = rA.signal(5);
    const cA = rA.computed(() => sA() * 2);
    let runs = 0;
    const stopA = rA.effect(() => { sA(); runs++; });
    cA();
    const before = rA.stats();

    let threw = null;
    try { rB.dispose(sA); rB.dispose(cA); } catch (e) { threw = e; }
    R.ok("cross-dispose", threw === null, `cross-registry dispose of node handles threw: ${threw && threw.message}`);
    const after = rA.stats();
    R.eq("cross-dispose", after.activeNodes, before.activeNodes, "cross-registry dispose of a signal/computed handle mutated the source registry's nodes");
    R.eq("cross-dispose", after.activeLinks, before.activeLinks, "cross-registry dispose of a signal/computed handle mutated the source registry's links");
    sA.set(6);
    R.eq("cross-dispose", runs - 1, 1, "the node stopped propagating after a foreign dispose -- the no-op was not a no-op");
    R.eq("cross-dispose", sA.peek(), 6, "the node's value path broke after a foreign dispose");
    R.eq("cross-dispose", cA(), 12, "the computed broke after a foreign dispose");

    // The effect-stop half: the function-call contract crosses registries.
    try { rB.dispose(stopA); } catch (e) { threw = e; }
    R.ok("cross-dispose", threw === null, `cross-registry dispose of an effect-stop handle threw: ${threw && threw.message}`);
    sA.set(7);
    R.eq("cross-dispose", runs - 1, 1,
        "a foreign dispose(effectStop) did NOT stop the effect -- the documented function-call contract no longer applies to stop handles");
    R.eq("cross-dispose", rA.stats().activeNodes, before.activeNodes - 1,
        "the foreign-invoked stop did not release the effect's node");
}

/* ── 4. destroy staleness: every pre-destroy handle degrades silently ─────── */
{
    const r = createRegistry();
    const s = r.signal(42);
    const c = r.computed(() => s() + 1);
    const stop = r.effect(() => { s(); });
    c();                                          // prime the computed's cache pre-destroy
    r.destroy();

    R.eq("destroy-stale", s(), undefined, "a stale signal read did not degrade to undefined");
    R.eq("destroy-stale", s.peek(), undefined, "a stale peek did not degrade to undefined");
    R.eq("destroy-stale", c(), undefined, "a stale computed read did not degrade to undefined (cached value resurrected?)");

    // Each probe latches its own throw -- a shared un-reset variable would
    // misattribute one early throw to every later probe (2026-08 review, LOW).
    let threw = null;
    try { s.set(1); } catch (e) { threw = e; }
    R.ok("destroy-stale", threw === null, `a stale set() threw: ${threw && threw.message}`);
    R.eq("destroy-stale", s.peek(), undefined, "a stale set() mutated a destroyed slot");
    threw = null;
    try { stop(); } catch (e) { threw = e; }
    R.ok("destroy-stale", threw === null, `a stale effect-stop threw: ${threw && threw.message}`);
    threw = null;
    try { r.dispose(s); } catch (e) { threw = e; }
    R.ok("destroy-stale", threw === null, `a stale dispose() threw: ${threw && threw.message}`);
    R.eq("destroy-stale", r.describe(s), undefined, "describe() resurrected a destroyed node");

    // Idempotence + immediate reuse.
    threw = null;
    try { r.destroy(); } catch (e) { threw = e; }
    R.ok("destroy-stale", threw === null, `a second destroy() threw: ${threw && threw.message}`);
    const s2 = r.signal(7);
    let seen = -1;
    r.effect(() => { seen = s2(); });
    s2.set(8);
    R.eq("destroy-stale", seen, 8, "the registry was not reusable after destroy()");
    R.eq("destroy-stale", s.peek(), undefined, "reusing the registry resurrected a STALE handle (gen guard must still hold)");
}

/* ── 5. destroy vs a pending scheduler thunk ──────────────────────────────── */
{
    // A deferred effect's thunk is still queued in USER land when destroy()
    // resets the world. Firing it afterwards must hit the gen guard and no-op:
    // no throw, no run, no interference with the rebuilt graph.
    const r = createRegistry();
    const s = r.signal(0);
    let runs = 0;
    const pend = [];
    r.effect(() => { s(); runs++; }, { scheduler: (fn) => pend.push(fn) });
    while (pend.length) pend.shift()();           // drain the (deferred) creation run
    const runs0 = runs;
    s.set(1);                                     // queues a thunk...
    R.ok("destroy-thunk", pend.length > 0, "the scheduler was never handed the re-run thunk");
    r.destroy();                                  // ...which destroy strands
    let threw = null;
    try { while (pend.length) pend.shift()(); } catch (e) { threw = e; }
    R.ok("destroy-thunk", threw === null, `a stranded thunk threw after destroy(): ${threw && threw.message}`);
    R.eq("destroy-thunk", runs - runs0, 0, "a stranded thunk RAN after destroy() -- the gen guard must no-op it");

    const s2 = r.signal(5);
    let seen = -1;
    r.effect(() => { seen = s2(); });
    s2.set(6);
    R.eq("destroy-thunk", seen, 6, "the registry misbehaved after a stranded thunk fired into the gen guard");
}

/* ── 6. the stale-handle hammer: volume over every degraded surface ───────── */
{
    // Single-shot pins prove the shape; this proves no PATH through the stale
    // surface throws or resurrects under volume, interleaved with live work in
    // the SAME (reused) registry -- the case a per-op unit test cannot cover.
    const SEED = 0xD15EA5E;
    const rnd = mulberry32(SEED);
    const N = 64, OPS = 20000;

    const r = createRegistry();
    const stale = { sigs: new Array(N), comps: new Array(N), stops: new Array(N) };
    for (let i = 0; i < N; i++) {
        stale.sigs[i] = r.signal(i);
        const idx = i;
        stale.comps[i] = r.computed(() => stale.sigs[idx]() + 1);
        stale.stops[i] = r.effect(() => { stale.sigs[idx](); });
    }
    r.destroy();

    // Live graph in the reused registry; the hammer must never disturb it.
    const live = r.signal(0);
    let liveSeen = -1, liveRuns = 0;
    r.effect(() => { liveSeen = live(); liveRuns++; });

    let threw = null, resurrected = -1, liveWrites = 0;
    for (let op = 0; op < OPS; op++) {
        const i = randInt(rnd, N);
        try {
            switch (randInt(rnd, 6)) {
                case 0: if (stale.sigs[i]() !== undefined && resurrected < 0) resurrected = op; break;
                case 1: stale.sigs[i].set(op); break;
                case 2: if (stale.comps[i]() !== undefined && resurrected < 0) resurrected = op; break;
                case 3: stale.stops[i](); break;
                case 4: r.dispose(stale.sigs[i]); break;
                default: { liveWrites++; live.set(liveWrites); break; }
            }
        } catch (e) { if (threw === null) threw = e; break; }
    }
    R.ok("stale-hammer", threw === null, `a stale-handle op threw under volume: ${threw && threw.message}`);
    R.ok("stale-hammer", resurrected < 0, `op ${resurrected}: a stale read returned a value -- destroyed state resurrected`);
    R.eq("stale-hammer", liveSeen, liveWrites, "the live graph's delivery drifted while stale handles were hammered");
    R.eq("stale-hammer", liveRuns - 1, liveWrites, "the live effect's run count drifted while stale handles were hammered");
    const st = r.stats();
    R.eq("stale-hammer", st.activeNodes, 2, `stale-handle ops moved activeNodes (want the 2 live nodes, got ${st.activeNodes})`);
    R.note(`${OPS} interleaved stale/live ops after destroy(): zero throws, zero resurrections, live graph exact`);
}

process.exit(R.finish("registries are isolated worlds and destroy() degrades every stale surface silently"));
