// 20-axis-stress.test.mjs — engine-invariant regression guards.
//
// Eight orthogonal "axes" along which a future engine refactor could silently
// break behaviour. Each test PINS lite-signal's actual v1.2.0 contract — the
// goal is that this file passes today, passes tomorrow, and fails LOUDLY if a
// future refactor accidentally drifts on any of these dimensions.
//
// Provenance: derived from a community-contributed 8-test "axis" suite probing
// engine invariants. Rewritten against lite-signal's real API and documented
// semantics; aspirational behaviours that lite-signal does NOT implement are
// pinned as the current contract (with a comment pointing at the gap).

import test, {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
    signal, effect, computed, batch, untrack, dispose,
    observeObservers, stats,
} from "../Signal.js";

// ─────────────────────────────────────────────────────────────────────────────
// AXIS 1 — BATCH IS NOT TRANSACTIONAL (writes commit immediately).
// What lite-signal DOES guarantee: pre-batch revert under value equality.
// ─────────────────────────────────────────────────────────────────────────────
describe("Axis 1: batch semantics under exception", () => {
    it("CONTRACT: writes apply immediately; an exception does NOT roll back applied writes", () => {
        // This pins the current behaviour. lite-signal's batch coalesces effect
        // dispatch but does not snapshot/revert writes on exception. If a future
        // version adds transactional batch, FLIP this test to assert rollback.
        const a = signal(10), b = signal(20);
        let caught = false;
        try {
            batch(() => {
                a.set(11);
                batch(() => {
                    b.set(21);
                    a.set(12);
                    throw new Error("boom");
                });
            });
        } catch { caught = true; }

        assert.equal(caught, true, "the throw propagates out of batch");
        assert.equal(a(), 12, "applied writes are NOT rolled back");
        assert.equal(b(), 21, "applied writes are NOT rolled back");
    });

    it("HOLDS: pre-batch revert — set X then back inside a batch suppresses propagation", () => {
        // This IS what lite-signal guarantees about batch transactionality.
        const a = signal(10);
        let runs = 0;
        const stop = effect(() => { runs++; a(); });
        const baseline = runs;
        batch(() => { a.set(99); a.set(10); });
        assert.equal(runs - baseline, 0, "revert was detected, no propagation");
        assert.equal(a(), 10);
        stop();
    });

    it("HOLDS: effects observing a thrown-in-batch signal still see the post-throw value", () => {
        const a = signal(0);
        let seen = -1;
        const stop = effect(() => { seen = a(); });
        try {
            batch(() => { a.set(7); throw new Error("x"); });
        } catch {}
        assert.equal(a(), 7, "write applied");
        assert.equal(seen, 7, "effect ran with the applied value on batch close");
        stop();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AXIS 2 — LIFECYCLE RE-ENTRANCY VIA observeObservers.
// (the original test used a `.onConnect=` property assignment that does
//  nothing — that's a different library's API. lite-signal's transition
//  hook is observeObservers(handle, { onConnect, onDisconnect }).)
// ─────────────────────────────────────────────────────────────────────────────
describe("Axis 2: connect/disconnect lifecycle re-entrancy", () => {
    it("onConnect can SAFELY create new reactive primitives", () => {
        const src = signal(0);
        const side = signal(0);
        let spawnedEffectRan = false;
        let connectFired = false;

        const unobserve = observeObservers(src, {
            onConnect: () => {
                connectFired = true;
                side.set(1);
                effect(() => { spawnedEffectRan = true; });
            },
        });

        // 0→1 observer transition: the effect below subscribes.
        const stop = effect(() => { src(); });

        assert.equal(connectFired, true, "onConnect fired on first observer");
        assert.equal(side(), 1, "onConnect's side.set committed");
        assert.equal(spawnedEffectRan, true, "the effect spawned inside onConnect ran");
        stop();
        unobserve();
    });

    it("onDisconnect fires on the 1→0 transition", () => {
        const src = signal(0);
        const events = [];
        const unobserve = observeObservers(src, {
            onConnect: () => events.push("connect"),
            onDisconnect: () => events.push("disconnect"),
        });
        const stop = effect(() => { src(); });
        assert.deepEqual(events, ["connect"]);
        stop();
        assert.deepEqual(events, ["connect", "disconnect"]);
        unobserve();
    });

    it("a second observer does NOT re-fire onConnect", () => {
        const src = signal(0);
        let connects = 0;
        const unobserve = observeObservers(src, {onConnect: () => connects++});
        const s1 = effect(() => { src(); });
        const s2 = effect(() => { src(); });
        assert.equal(connects, 1, "transition-only registration");
        s1(); s2();
        unobserve();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AXIS 3 — OWNER-CASCADE + UNTRACK BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────
describe("Axis 3: untrack does not change owner-cascade semantics", () => {
    it("a nested effect created inside untrack() is still owner-adopted", () => {
        // untrack suppresses TRACKING (dep links) but does NOT suppress
        // ownership. The nested effect is still owned by the outer effect and
        // is cascade-disposed when the outer re-runs.
        const run = signal(true);
        let innerCreates = 0;
        let innerLastValue;
        const probe = signal("v0");

        const outer = effect(() => {
            if (!run()) return;
            untrack(() => {
                innerCreates++;
                effect(() => { innerLastValue = probe(); });
            });
        });

        assert.equal(innerCreates, 1);
        assert.equal(innerLastValue, "v0");

        // Trigger the inner via its own dep (probe) — it should still respond.
        probe.set("v1");
        assert.equal(innerLastValue, "v1", "the inner effect's own deps still fire");

        // Now flip the outer's gate so outer returns early. The PREVIOUS inner
        // is owner-cascaded out. After this, probe.set must not touch it.
        run.set(false);
        assert.equal(innerCreates, 1, "outer returned early; no new inner created");

        probe.set("v2");
        assert.equal(innerLastValue, "v1",
            "old inner was disposed by owner cascade; probe.set finds no observer");

        outer();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AXIS 4 — UNTRACK INSIDE A COMPUTED: no hidden dep
// ─────────────────────────────────────────────────────────────────────────────
describe("Axis 4: untrack inside a computed body", () => {
    it("hidden read does not create a dep — computed is NOT invalidated by its untracked source", () => {
        const t = signal(0);
        const h = signal("A");
        let evals = 0;

        const c = computed(() => {
            evals++;
            let v;
            untrack(() => { v = h(); });
            return t() + (v === "A" ? 1 : 0);
        });

        // Materialise the computed
        assert.equal(c(), 1);
        assert.equal(evals, 1);

        // Untracked source changes — re-read MUST NOT re-evaluate.
        h.set("B");
        assert.equal(c(), 1, "value stale from c's POV since c is NOT invalidated");
        assert.equal(evals, 1, "hidden dep did not leak");

        // Tracked source changes — re-read MUST re-evaluate (and see the new h).
        t.set(10);
        assert.equal(c(), 10, "tracked invalidation: t=10, h is 'B' (untracked path)");
        assert.equal(evals, 2);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AXIS 5 — QUEUE REUSE SAFETY: an effect disposing itself mid-flush
// (the original test miscounted by omitting the synchronous initial run.)
// ─────────────────────────────────────────────────────────────────────────────
describe("Axis 5: queue safety under self-dispose mid-flush", () => {
    it("an effect that calls its own stop during a flush does NOT corrupt the queue", () => {
        const s = signal(0);
        const order = [];

        const stopA = effect(() => {
            const v = s();
            order.push("A@" + v);
            if (v === 1) stopA();   // self-dispose during propagation
        });
        const stopB = effect(() => { order.push("B@" + s()); });

        // Initial runs (synchronous on effect creation): A reads 0, B reads 0.
        assert.deepEqual(order, ["A@0", "B@0"]);
        order.length = 0;

        // Propagation run: A reads 1 and disposes itself; B then reads 1.
        // The queue must NOT skip B because A's onSettle modified pool state.
        s.set(1);
        assert.deepEqual(order, ["A@1", "B@1"]);

        // After A is gone, a further set must not crash and must fire only B.
        order.length = 0;
        s.set(2);
        assert.deepEqual(order, ["B@2"]);

        stopB();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AXIS 6 — DYNAMIC COMPUTED CYCLE DETECTION
// ─────────────────────────────────────────────────────────────────────────────
describe("Axis 6: cycle detection in a value-dependent computed graph", () => {
    it("A depends on B only when flip is true; the cycle is detected on the first cyclic read", () => {
        const flip = signal(false);
        let A, B;
        A = computed(() => (flip() ? B() : 1));
        B = computed(() => A() + 1);

        // No cycle yet.
        assert.equal(A(), 1);
        assert.equal(B(), 2);

        flip.set(true);

        // Now A reads B which reads A — a structural cycle. The engine throws.
        assert.throws(() => A(), (err) => /CycleError|cycle/i.test(err.message),
            "the value-dependent cycle is detected");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AXIS 7 — NESTED-EFFECT BODY ORDER (effects run synchronously on creation)
// ─────────────────────────────────────────────────────────────────────────────
describe("Axis 7: nested effect creation order + owner cascade", () => {
    it("effects run synchronously on creation; an immediately-stopped one still ran once", () => {
        // Effects are eager: effect(fn) calls fn() synchronously. The stop
        // function only prevents FUTURE re-runs on dep changes. The original
        // axis test expected B's body never to run, which would only hold for
        // libraries with deferred-first-run semantics (not lite-signal).
        const t = signal(0);
        const logs = [];

        const outer = effect(() => {
            t();
            effect(() => logs.push("A"));
            const stopB = effect(() => logs.push("B"));
            effect(() => logs.push("C"));
            stopB();
        });

        // Initial outer run: A, B, C all run synchronously on creation.
        assert.deepEqual(logs, ["A", "B", "C"]);

        // After t changes: owner cascade disposes old A, B (already disposed), C;
        // outer re-runs; new A, B, C are created and all run synchronously.
        logs.length = 0;
        t.set(1);
        assert.deepEqual(logs, ["A", "B", "C"]);
        outer();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AXIS 8 — SYNCHRONOUS FLUSH (no microtask/setTimeout starvation)
// ─────────────────────────────────────────────────────────────────────────────
describe("Axis 8: synchronous flush — no scheduler in the default path", () => {
    it("an effect fires SYNCHRONOUSLY in the same call stack as set()", () => {
        const x = signal(0);
        let ran = 0;
        let lastSeen = -1;
        const stop = effect(() => { ran++; lastSeen = x(); });
        const baseline = ran;
        x.set(42);
        // No await, no setTimeout — by the time set returns, the effect has run.
        assert.equal(ran, baseline + 1, "effect ran in the same tick as set()");
        assert.equal(lastSeen, 42);
        stop();
    });

    it("inside a batch the effect does NOT fire until the outermost batch closes", () => {
        const x = signal(0);
        let ran = 0, lastSeen = -1;
        const stop = effect(() => { ran++; lastSeen = x(); });
        const baseline = ran;
        batch(() => {
            x.set(7);
            assert.equal(ran, baseline, "no fire yet — still inside batch");
            x.set(8);
            assert.equal(ran, baseline, "still no fire");
        });
        // outermost batch closed -> single coalesced fire with final value
        assert.equal(ran, baseline + 1);
        assert.equal(lastSeen, 8);
        stop();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// BONUS — INVARIANTS THIS AXIS SET HINTS AT BUT DOES NOT DIRECTLY ASSERT
// ─────────────────────────────────────────────────────────────────────────────
describe("Axis bonus: pool integrity under sustained churn", () => {
    it("1,000 effect-create-then-dispose cycles leave the pool exactly where it started", () => {
        const a = signal(0);
        const beforeNodes = stats().activeNodes;
        const beforeLinks = stats().activeLinks;
        for (let i = 0; i < 1000; i++) {
            const stop = effect(() => { a(); });
            stop();
        }
        assert.equal(stats().activeNodes, beforeNodes, "no leaked nodes");
        assert.equal(stats().activeLinks, beforeLinks, "no leaked links");
    });

    it("dispose() on a disposed handle is a silent no-op (idempotent)", () => {
        const s = signal(0);
        const stop = effect(() => { s(); });
        stop();
        assert.doesNotThrow(() => stop());
        assert.doesNotThrow(() => stop());
    });

    it("dispose() on a foreign value is a silent no-op", () => {
        assert.doesNotThrow(() => dispose(null));
        assert.doesNotThrow(() => dispose(undefined));
        assert.doesNotThrow(() => dispose(42));
        assert.doesNotThrow(() => dispose({}));
        assert.doesNotThrow(() => dispose(() => {}));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFORMANCE PINS — regressions found in the 1.2 release prep against the
// upstream alien-signals "reactivity-correctness" suite. Each test pins the
// EXACT scenario from the upstream test of the same number; passing here means
// the corresponding conformance row in the dashboard stays green.
//
// Provenance: surfaced when re-running the conformance suite against the v1.2
// engine; the bug was a pre-existing latent crash on self-dispose-mid-run that
// the v1.2 owner tree exercised more aggressively, plus a runCleanup ordering
// that swapped cleanup-order on cascade.
// ─────────────────────────────────────────────────────────────────────────────

import { onCleanup } from "../Signal.js";

// Adapter that mirrors the upstream suite's `fw.effect(fn)` shape: if the body
// returns a function, it's the cleanup. Equivalent to onCleanup(fn).
function effectWithReturnCleanup(fn) {
    return effect(() => {
        const cleanup = fn();
        if (typeof cleanup === "function") onCleanup(cleanup);
    });
}

describe("Conformance: dispose-during-execution (#141)", () => {
    it("#141: dispose mid-run then continue reading another signal — no re-run", () => {
        const a = signal(0);
        const b = signal(0);
        let runs = 0;
        let dispose;

        dispose = effectWithReturnCleanup(() => {
            runs++;
            const va = a();
            if (va === 1) dispose?.();    // self-dispose mid-run
            b();                           // read continues after dispose
        });

        assert.equal(runs, 1, "initial run");
        a.set(1);
        assert.equal(runs, 2, "re-runs once on a=1, then disposes itself");
        b.set(1);
        assert.equal(runs, 2, "disposed — b.set does not re-trigger");
        a.set(2);
        assert.equal(runs, 2, "disposed — a.set does not re-trigger");
    });

    it("#141 variant: self-dispose mid-run with no further reads is still safe", () => {
        const a = signal(0);
        let runs = 0;
        let dispose;
        dispose = effect(() => {
            runs++;
            if (a() === 1) dispose?.();
        });
        a.set(1);
        a.set(2);
        assert.equal(runs, 2);
    });

    it("#141 variant: many signals read AFTER self-dispose are all safe no-ops", () => {
        const sigs = Array.from({length: 8}, () => signal(0));
        const trigger = signal(0);
        let runs = 0;
        let dispose;
        dispose = effect(() => {
            runs++;
            if (trigger() === 1) dispose?.();
            for (const s of sigs) s();    // 8 reads after dispose
        });
        trigger.set(1);
        // Now mutate every supposed-dep and confirm no re-trigger
        for (const s of sigs) s.set(99);
        assert.equal(runs, 2);
    });
});

describe("Conformance: cascade cleanup ordering (#238 / #241 / #243)", () => {
    it("#238: two-level — inner:cleanup fires BEFORE outer:cleanup on cascade dispose", () => {
        const log = [];
        const dispose = effectWithReturnCleanup(() => {
            effectWithReturnCleanup(() => {
                return () => log.push("inner:cleanup");
            });
            return () => log.push("outer:cleanup");
        });
        log.length = 0;
        dispose();

        const innerIdx = log.indexOf("inner:cleanup");
        const outerIdx = log.indexOf("outer:cleanup");
        assert.ok(innerIdx >= 0, "inner cleanup fired");
        assert.ok(outerIdx >= 0, "outer cleanup fired");
        assert.ok(innerIdx < outerIdx, `inner before outer (got [${log.join(", ")}])`);
    });

    it("#241: three-level — grand:cleanup < child:cleanup < outer:cleanup", () => {
        const log = [];
        const dispose = effectWithReturnCleanup(() => {
            effectWithReturnCleanup(() => {
                effectWithReturnCleanup(() => {
                    return () => log.push("grand:cleanup");
                });
                return () => log.push("child:cleanup");
            });
            return () => log.push("outer:cleanup");
        });
        dispose();

        const g = log.indexOf("grand:cleanup");
        const c = log.indexOf("child:cleanup");
        const o = log.indexOf("outer:cleanup");
        assert.ok(g >= 0 && c >= 0 && o >= 0, `all cleanups fired: [${log.join(", ")}]`);
        assert.ok(g < c && c < o, `deepest-first: g<c<o (got [${log.join(", ")}])`);
    });

    it("#243: cleanup ordering correct after a prior inner-only re-run", () => {
        const a = signal(0);
        const b = signal(0);
        const log = [];

        effectWithReturnCleanup(() => {
            a();
            log.push("outer:run");
            effectWithReturnCleanup(() => {
                b();
                log.push("inner:run");
                return () => log.push("inner:cleanup");
            });
            return () => log.push("outer:cleanup");
        });

        // Step 1: inner re-runs alone — its cleanup fires, new run logs.
        b.set(1);
        log.length = 0;

        // Step 2: outer re-runs. Owner cascade disposes the current inner
        // FIRST (so inner:cleanup), then outer:cleanup, then outer body
        // runs which makes a fresh inner.
        a.set(1);

        const outerCleanupIdx = log.indexOf("outer:cleanup");
        const outerRunIdx     = log.lastIndexOf("outer:run");
        const innerCleanupIdx = log.indexOf("inner:cleanup");

        assert.ok(outerCleanupIdx >= 0, `outer cleanup fired: [${log.join(", ")}]`);
        assert.ok(outerRunIdx > outerCleanupIdx, "cleanup before re-run");
        assert.ok(innerCleanupIdx >= 0, "inner cleanup fired");
        assert.ok(innerCleanupIdx < outerCleanupIdx, `inner cleanup before outer cleanup (got [${log.join(", ")}])`);
    });

    it("BONUS: cleanup order also holds for re-run cascade (not just dispose)", () => {
        // Same invariant should hold when a parent re-runs (cascade-dispose
        // its current children) as when it's explicitly disposed.
        const trigger = signal(0);
        const log = [];

        effectWithReturnCleanup(() => {
            trigger();
            effectWithReturnCleanup(() => {
                return () => log.push("child:cleanup");
            });
            return () => log.push("outer:cleanup");
        });
        log.length = 0;
        trigger.set(1);   // outer re-runs → cleanup cascade

        const c = log.indexOf("child:cleanup");
        const o = log.indexOf("outer:cleanup");
        assert.ok(c >= 0 && o >= 0, `both fired: [${log.join(", ")}]`);
        assert.ok(c < o, `child before outer on re-run cascade (got [${log.join(", ")}])`);
    });
});
