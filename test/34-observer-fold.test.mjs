// 34-observer-fold.test.mjs -- LEDGER #30 "observer-fold" conformance: isTrackingDeps was
// deleted; tracking is now `currentObserver !== null`. untrack, sharedSubscribe
// (signal/computed .subscribe) and boxSubscribe null the observer for their
// window and restore it ONLY if it survived (`po.gen === pg`), reproducing
// disposeNode's own self-dispose guard.
//
// Every assertion below is OBSERVABLE behaviour (values, run counts,
// isTracking(), stats().activeLinks / activeNodes deltas) -- never internals
// (no reaching into ReactiveNode fields, no relying on object identity of a
// recycled pool slot).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

// Nests `fn` inside `depth` layers of untrack. depth === 0 means "call fn
// directly, no untrack at all" -- the control case for the boundary matrix.
function nestUntrack(reg, depth, fn) {
    if (depth === 0) return fn();
    return reg.untrack(() => nestUntrack(reg, depth - 1, fn));
}

// ---------------------------------------------------------------------------
// 1. isTracking() truth table
// ---------------------------------------------------------------------------
describe("isTracking() truth table", () => {
    it("top level = false", () => {
        assert.equal(r.isTracking(), false);
    });

    it("inside effect = true", () => {
        let seen;
        r.effect(() => { seen = r.isTracking(); });
        assert.equal(seen, true);
    });

    it("inside computed body = true", () => {
        let seen;
        const c = r.computed(() => { seen = r.isTracking(); return 1; });
        r.effect(() => { c(); });   // computed is lazy: force a pull
        assert.equal(seen, true);
    });

    it("inside untrack in effect = false", () => {
        let seen;
        r.effect(() => { r.untrack(() => { seen = r.isTracking(); }); });
        assert.equal(seen, false);
    });

    it("after untrack returns = true", () => {
        let seen;
        r.effect(() => { r.untrack(() => {}); seen = r.isTracking(); });
        assert.equal(seen, true);
    });

    it("inside subscribe callback = false", () => {
        const s = r.signal(0);
        let seen;
        const unsub = s.subscribe(() => { seen = r.isTracking(); });
        unsub();
        assert.equal(seen, false);
    });

    it("inside untrack at top level = false", () => {
        let seen;
        r.untrack(() => { seen = r.isTracking(); });
        assert.equal(seen, false);
    });
});

// ---------------------------------------------------------------------------
// 2. untrack nesting depth 0, 1, 2, N (N=64)
// ---------------------------------------------------------------------------
describe("untrack nesting depth 0/1/2/N(64)", () => {
    for (const depth of [0, 1, 2, 64]) {
        it(`depth=${depth}: tracking restored at every level; reads inside create no links`, () => {
            const sInner = r.signal("inner");
            const sOuter = r.signal("outer");
            let trackingAtDepth;
            let outerRuns = 0;

            r.effect(() => {
                outerRuns++;
                nestUntrack(r, depth, () => {
                    trackingAtDepth = r.isTracking();
                    sInner();   // must NOT link when depth > 0; must link when depth === 0
                });
                sOuter();       // must ALWAYS link: observer is restored by the time this runs
            });

            assert.equal(trackingAtDepth, depth === 0, "isTracking() at the deepest level");

            // sOuter always links: re-running via sOuter proves the observer
            // was correctly restored after unwinding `depth` untrack levels.
            const before = outerRuns;
            sOuter.set("outer2");
            assert.equal(outerRuns, before + 1, "observer restored -> sOuter re-triggers the effect");

            // sInner: linked only for depth === 0 (the no-untrack control case).
            const before2 = outerRuns;
            sInner.set("inner2");
            assert.equal(outerRuns, depth === 0 ? before2 + 1 : before2,
                depth === 0 ? "depth 0 is untracked control: sInner must be tracked" :
                    "any untrack depth >= 1 suppresses tracking of reads made inside it");
        });
    }
});

// ---------------------------------------------------------------------------
// 3. untrack whose fn THROWS
// ---------------------------------------------------------------------------
describe("untrack fn throws", () => {
    it("observer is restored after the throw: a subsequent read in the same effect body links; next set re-runs the effect", () => {
        const a = r.signal(1);
        const b = r.signal(2);
        let runs = 0;
        let caught = false;

        r.effect(() => {
            runs++;
            a();   // link #1, unconditionally
            try {
                r.untrack(() => { throw new Error("boom"); });
            } catch (e) {
                caught = true;
            }
            b();   // must link: the observer was restored by untrack's finally despite the throw
        });

        assert.equal(runs, 1);
        assert.equal(caught, true, "the throw must propagate out of untrack to the caller");
        assert.equal(r.stats().activeLinks, 2, "both a and b are tracked -- untrack's restore ran even though fn threw");

        b.set(3);
        assert.equal(runs, 2, "b is tracked (post-throw read linked), so a set on it re-runs the effect");
    });
});

// ---------------------------------------------------------------------------
// 4. effect disposes ITSELF inside untrack, then reads 3 signals
// ---------------------------------------------------------------------------
describe("effect self-disposes inside untrack", () => {
    it("no throw; activeLinks returns exactly to the pre-effect baseline; effect never re-runs", () => {
        const trigger = r.signal(0);
        const s1 = r.signal(1), s2 = r.signal(2), s3 = r.signal(3);
        const baselineLinks = r.stats().activeLinks;   // 0: nothing created yet involving this effect

        let stop;
        let runs = 0;
        let kill = false;
        let threw = false;

        stop = r.effect(() => {
            runs++;
            trigger();
            if (kill) {
                try {
                    r.untrack(() => {
                        stop();          // self-dispose from inside untrack
                        s1(); s2(); s3(); // reads in the now-dead body: must create no links
                    });
                } catch (e) {
                    threw = true;
                }
            }
        });

        assert.equal(runs, 1);
        kill = true;
        assert.doesNotThrow(() => trigger.set(1));
        assert.equal(threw, false);
        assert.equal(runs, 2, "the run that self-disposed still counts as a run");
        assert.equal(r.stats().activeLinks, baselineLinks,
            "self-dispose severs the trigger link; s1/s2/s3 create no links (observer stayed null: gen mismatch)");

        trigger.set(2);
        assert.equal(runs, 2, "a disposed effect must never re-run");
    });
});

// ---------------------------------------------------------------------------
// 5. effect self-disposes inside untrack AND creates a new signal/effect in
//    the same window (the freed slot may be recycled for the new resident).
// ---------------------------------------------------------------------------
describe("effect self-disposes inside untrack while minting a new effect in the same window", () => {
    it("the recycled resident must not become the observer", () => {
        const trigger = r.signal(0);
        const target = r.signal(10);

        let stop;
        let freshSignal;
        let newEffectStop;
        let outerRuns = 0;
        let newEffectRuns = 0;
        let kill = false;
        let deadReadLinked = false;

        stop = r.effect(() => {
            outerRuns++;
            trigger();
            if (kill) {
                r.untrack(() => {
                    stop();   // self-dispose; frees this effect's pool slot
                    // Mint a brand-new signal + effect in the very same window.
                    // The pool is LIFO, so this MAY reuse the just-freed slot.
                    freshSignal = r.signal(0);
                    newEffectStop = r.effect(() => { newEffectRuns++; freshSignal(); });
                });
                // Dead-body read AFTER the window: currentObserver must still be
                // null (the gen mismatch means untrack did not restore it), so
                // this must not attach to whatever now occupies the recycled slot.
                const before = r.stats().activeLinks;
                target();
                deadReadLinked = r.stats().activeLinks !== before;
            }
        });

        assert.equal(outerRuns, 1);
        kill = true;
        trigger.set(1);

        assert.equal(outerRuns, 2, "the outer effect ran exactly once more (the self-disposing run)");
        assert.equal(newEffectRuns, 1, "the new effect ran normally on its own creation");
        assert.equal(deadReadLinked, false, "a read after the window, still in the dead body, creates no link");

        freshSignal.set(1);
        assert.equal(newEffectRuns, 2, "the new effect (possibly in a recycled slot) reacts normally to its own dependency");

        trigger.set(2);
        assert.equal(outerRuns, 2, "the disposed outer effect never runs again, even though its slot may now be live");

        newEffectStop();
    });
});

// ---------------------------------------------------------------------------
// 6. subscribe callback disposes its own subscription (signal and signalBox)
// ---------------------------------------------------------------------------
describe("subscribe callback disposes its own subscription", () => {
    it("signal.subscribe: no throw, no further calls, links back to baseline", () => {
        const s = r.signal(0);
        const baseline = r.stats().activeLinks;
        let calls = 0;
        // subscribe() runs the callback synchronously on creation, before the
        // disposer it returns exists -- guard the self-dispose to the SECOND
        // call (triggered by an external set), matching the codebase's own
        // established self-dispose pattern (see 14-lifecycle-teardown).
        let unsub;
        let armed = false;
        assert.doesNotThrow(() => {
            unsub = s.subscribe(() => { calls++; if (armed) unsub(); });
        });
        assert.equal(calls, 1, "creation run does not self-dispose (disposer not yet bound)");
        armed = true;
        s.set(1);
        assert.equal(calls, 2, "second run self-disposes");
        assert.equal(r.stats().activeLinks, baseline, "self-unsubscribe severs its own link back to baseline");
        s.set(2);
        assert.equal(calls, 2, "no further calls after self-dispose");
    });

    it("signalBox.subscribe: no throw, no further calls, links back to baseline", () => {
        const b = r.signalBox(0);
        const baseline = r.stats().activeLinks;
        let calls = 0;
        let unsub;
        let armed = false;
        assert.doesNotThrow(() => {
            unsub = b.subscribe(() => { calls++; if (armed) unsub(); });
        });
        assert.equal(calls, 1, "creation run does not self-dispose (disposer not yet bound)");
        armed = true;
        b.set(1);
        assert.equal(calls, 2, "second run self-disposes");
        assert.equal(r.stats().activeLinks, baseline, "self-unsubscribe severs its own link back to baseline");
        b.set(2);
        assert.equal(calls, 2, "no further calls after self-dispose");
    });
});

// ---------------------------------------------------------------------------
// 7. duplicate dispose inside the window; re-entrant write
// ---------------------------------------------------------------------------
describe("duplicate dispose inside the window", () => {
    it("dispose function is idempotent even when called twice inside the same untracked window", () => {
        const s = r.signal(0);
        const baseline = r.stats().activeLinks;
        let stop;
        let calls = 0;
        let armed = false;
        assert.doesNotThrow(() => {
            stop = s.subscribe(() => {
                calls++;
                if (armed) { stop(); stop(); }   // duplicate dispose, same window
            });
        });
        assert.equal(calls, 1, "creation run does not self-dispose (disposer not yet bound)");
        armed = true;
        s.set(1);
        assert.equal(calls, 2);
        assert.equal(r.stats().activeLinks, baseline);
        s.set(2);
        assert.equal(calls, 2);
    });

    it("r.dispose(handle) called twice on an already-disposed effect is a silent no-op", () => {
        const s = r.signal(0);
        let runs = 0;
        const stop = r.effect(() => { runs++; s(); });
        assert.equal(runs, 1);
        assert.doesNotThrow(() => { r.dispose(stop); r.dispose(stop); });
        s.set(1);
        assert.equal(runs, 1, "still disposed after two dispose(handle) calls");
    });
});

describe("re-entrant write: set the tracked signal inside untrack in the effect body", () => {
    it("no infinite loop; the run count is exactly what the guard predicts", () => {
        const s = r.signal(0);
        let runs = 0;

        // Every run reads s, then (inside untrack, so the write below never
        // re-tracks) writes s again. markDownstream's FLAG_COMPUTING guard
        // keeps this effect from re-queueing itself for its own write.
        r.effect(() => {
            runs++;
            const v = s();
            r.untrack(() => { s.set(v + 1); });
        });

        assert.equal(runs, 1, "creation run: exactly one run, no self-triggered second run");
        assert.equal(s.peek(), 1, "the untracked re-entrant write did land");

        // Three external triggers -> exactly three more runs, each of which
        // performs its own harmless re-entrant untracked write. No cascade,
        // no infinite loop.
        for (let i = 0; i < 3; i++) {
            const before = runs;
            s.set(s.peek() + 10);
            assert.equal(runs, before + 1, `external trigger #${i} causes exactly one run`);
        }
        assert.equal(runs, 4, "total: 1 creation run + 3 external-trigger runs");
    });
});

// ---------------------------------------------------------------------------
// 8. untrack inside a computed inside an effect
// ---------------------------------------------------------------------------
describe("untrack inside a computed inside an effect", () => {
    it("the computed does not track the untracked read", () => {
        const s = r.signal(1);
        let compRuns = 0;
        const c = r.computed(() => {
            compRuns++;
            let v;
            r.untrack(() => { v = s(); });
            return v;
        });
        let effRuns = 0;
        r.effect(() => { effRuns++; c(); });

        assert.equal(effRuns, 1);
        assert.equal(compRuns, 1);
        assert.equal(r.stats().activeLinks, 1, "only effect->computed is linked; computed->s is not");

        s.set(2);
        assert.equal(effRuns, 1, "effect must not re-run: the computed has no dependency on s");
    });
});

// ---------------------------------------------------------------------------
// 9. createRoot / runWithOwner inside untrack
// ---------------------------------------------------------------------------
describe("createRoot / runWithOwner inside untrack", () => {
    it("createRoot: nodes created there are not owned by the enclosing effect and survive its re-run", () => {
        const trigger = r.signal(0);
        const child = r.signal(0);
        let childRuns = 0;
        let trackingDuringCreate;
        let created = false;   // mint the child exactly once, on the outer effect's first run

        r.effect(() => {
            trigger();
            r.untrack(() => {
                if (created) return;
                created = true;
                r.createRoot(() => {
                    r.effect(() => { childRuns++; trackingDuringCreate = r.isTracking(); child(); });
                });
            });
        });

        assert.equal(childRuns, 1);
        assert.equal(trackingDuringCreate, true, "the child effect establishes its own observer scope as usual");

        const linksBefore = r.stats().activeLinks;
        trigger.set(1);   // re-runs the OUTER effect; an owned child would be cascade-disposed here
        assert.equal(childRuns, 1, "child not owned by the outer effect -> not torn down on its re-run");
        assert.equal(r.stats().activeLinks, linksBefore, "child's link survives the outer effect's re-run");

        child.set(1);
        assert.equal(childRuns, 2, "the surviving child still reacts normally");
    });

    it("runWithOwner(undefined, ...) inside untrack: rooted degrade, not owned by the enclosing effect", () => {
        const trigger = r.signal(0);
        const child = r.signal(0);
        let childRuns = 0;
        let made = false;   // mint the child exactly once, on the outer effect's first run

        r.effect(() => {
            trigger();
            r.untrack(() => {
                if (made) return;
                made = true;
                r.runWithOwner(undefined, () => {
                    r.effect(() => { childRuns++; child(); });
                });
            });
        });

        assert.equal(childRuns, 1);
        const linksBefore = r.stats().activeLinks;
        trigger.set(1);   // re-runs the outer effect; an owned child would be cascade-disposed here
        assert.equal(childRuns, 1, "child survives the outer effect's re-run: a stale/undefined owner handle degrades to rooted execution, not adoption by the enclosing effect");
        assert.equal(r.stats().activeLinks, linksBefore, "child's link survives the outer effect's re-run");

        child.set(1);
        assert.equal(childRuns, 2, "the surviving rooted child still reacts normally");
    });
});

// ---------------------------------------------------------------------------
// 10. Adversarial case (planner's list stops at #9; this one is ours):
//     a subscribe callback is NOT a tracking window for currentObserver, but
//     currentOwner IS untouched by that window. A nested subscribe minted
//     from inside an outer subscribe's callback is therefore still OWNED by
//     the outer subscribe-driving effect, even though it was created while
//     isTracking() reports false. Disposing the outer subscription must
//     cascade-dispose the nested one automatically via the (untouched)
//     owner tree -- an interaction between the #30 observer-only window and
//     the separate, unmodified ownership axis that a change focused solely
//     on currentObserver could plausibly break without anyone noticing.
// ---------------------------------------------------------------------------
describe("adversarial: nested subscribe minted inside a subscribe callback", () => {
    it("is owned (though not tracking) by the outer subscribe effect, and cascade-disposes with it", () => {
        const outer = r.signal(0);
        const inner = r.signal(0);
        let innerCalls = 0;
        let innerUnsub;
        let trackingInCallback;

        const outerUnsub = outer.subscribe(() => {
            trackingInCallback = r.isTracking();
            if (innerUnsub === undefined) {
                innerUnsub = inner.subscribe(() => { innerCalls++; });
            }
        });

        assert.equal(trackingInCallback, false, "subscribe callback is a non-tracking window");
        assert.equal(innerCalls, 1, "nested subscribe ran once on its own creation");
        assert.equal(r.stats().activeLinks, 2, "outer->outer-signal and inner-effect->inner-signal");

        outerUnsub();   // disposes only the OUTER subscription directly
        assert.equal(r.stats().activeLinks, 0,
            "owner cascade (untouched by the observer-only window) disposes the nested subscribe too");

        inner.set(1);
        assert.equal(innerCalls, 1, "the cascade-disposed nested subscription must not fire again");
    });
});

// ---------------------------------------------------------------------------
// 11. Resident-memory budget over 1e4 create/dispose cycles exercising the
//     #30 observer-fold window (untrack / subscribe / self-dispose-in-untrack).
//     Requires --expose-gc; loudly skips (not silently passes) otherwise.
// ---------------------------------------------------------------------------
describe("observer-fold window churn: 1e4 create/dispose cycles", () => {
    const hasGc = typeof globalThis.gc === "function";

    it("activeNodes/activeLinks return to baseline; resident delta measured under forced GC", { skip: hasGc ? false : "requires node --expose-gc" }, () => {
        const CYCLES = 10000;
        // s1/s2 are long-lived (created once, outside the loop): the axis under
        // test is the #30 observer-fold WINDOW's own churn (effect create/dispose,
        // untrack enter/exit), not the signal pool.
        const s1 = r.signal(0), s2 = r.signal(0);
        const baselineNodes = r.stats().activeNodes;
        const baselineLinks = r.stats().activeLinks;

        globalThis.gc();
        const before = process.memoryUsage();
        const beforeResident = before.heapUsed + before.arrayBuffers;

        for (let i = 0; i < CYCLES; i++) {
            const stop = r.effect(() => {
                s1();
                r.untrack(() => { s2(); });   // exercise the #30 observer-fold window every cycle
            });
            stop();
        }

        assert.equal(r.stats().activeNodes, baselineNodes, "activeNodes returns to baseline after 1e4 create/dispose cycles");
        assert.equal(r.stats().activeLinks, baselineLinks, "activeLinks returns to baseline after 1e4 create/dispose cycles");

        globalThis.gc();
        const after = process.memoryUsage();
        const afterResident = after.heapUsed + after.arrayBuffers;
        const deltaKB = (afterResident - beforeResident) / 1024;

        console.log(`GATE resident delta after 1e4 create/dispose cycles: ${deltaKB.toFixed(2)} KB (limit 64 KB)`);
        assert.ok(deltaKB <= 64, `resident (heapUsed+arrayBuffers) delta ${deltaKB.toFixed(2)} KB must be <= 64 KB after forced GC`);
    });
});
