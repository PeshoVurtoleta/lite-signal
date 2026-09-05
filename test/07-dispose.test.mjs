// Universal disposal: registry.dispose(api).
//
// Signals, computeds, and effect dispose handles all flow through one
// function. Per-registry Symbol prevents cross-registry corruption: a
// signal from registry A passed to registry B's dispose is a silent
// no-op, not a pool-corrupting free.
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

// ─── Signal disposal ─────────────────────────────────────────────────────────

describe("dispose(signal)", () => {
    it("removes the node from the pool and decrements stats", () => {
        const before = r.stats();
        const s = r.signal(42);
        assert.equal(r.stats().signals, before.signals + 1);
        assert.equal(r.stats().activeNodes, before.activeNodes + 1);

        r.dispose(s);
        assert.equal(r.stats().signals, before.signals);
        assert.equal(r.stats().activeNodes, before.activeNodes);
    });

    it("is idempotent — calling twice is safe and stats only move once", () => {
        const s = r.signal(0);
        const baseline = r.stats().signals - 1;
        r.dispose(s);
        r.dispose(s);
        r.dispose(s);
        assert.equal(r.stats().signals, baseline);
    });

    it("stale handle does not corrupt a recycled slot (slot-reuse safety)", () => {
        // Regression test for a real bug: without a generation-stamp check
        // on the API, the second dispose() of a stale handle would see the
        // slot's newly-set flags and incorrectly free the *new* occupant.
        const small = createRegistry({maxNodes: 4, maxLinks: 16});
        const sigA = small.signal("A");
        small.dispose(sigA);

        const sigB = small.signal("B");          // lands in the freed slot
        assert.equal(small.stats().signals, 1);
        assert.equal(sigB(), "B");

        small.dispose(sigA);                     // stale handle — must be no-op
        assert.equal(small.stats().signals, 1, "stale dispose must not free the recycled slot");
        assert.equal(sigB(), "B", "B must still be readable after stale dispose(A)");

        // And B's own dispose must still work normally.
        small.dispose(sigB);
        assert.equal(small.stats().signals, 0);
    });

    it("stale handle survives create/dispose churn on the same slot", () => {
        const small = createRegistry({maxNodes: 2, maxLinks: 8});
        const stale = small.signal("stale");
        small.dispose(stale);

        // Burn through the slot many times.
        for (let i = 0; i < 100; i++) {
            const s = small.signal(i);
            small.dispose(s);
        }
        const live = small.signal("live");
        small.dispose(stale);                    // any number of stale calls — all safe
        small.dispose(stale);
        small.dispose(stale);

        assert.equal(live(), "live");
        assert.equal(small.stats().signals, 1);
    });

    it("unhooks downstream effects so further writes don't propagate", () => {
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { runs++; s(); });
        assert.equal(runs, 1);

        s.set(1);
        assert.equal(runs, 2);

        r.dispose(s);
        // The signal is gone from the graph. Writes to its read closure are
        // operating on a reclaimed pool slot — they must not fire the effect.
        s.set(2);
        assert.equal(runs, 2, "no effect run after dispose");
    });

    it("frees the dependency links the signal participated in", () => {
        const linksBefore = r.stats().activeLinks;
        const s = r.signal(0);
        const c = r.computed(() => s() + 1);
        c(); // wire the link s → c
        assert.ok(r.stats().activeLinks > linksBefore);

        r.dispose(s);
        r.dispose(c);
        assert.equal(r.stats().activeLinks, linksBefore);
    });
});

// ─── Computed disposal ──────────────────────────────────────────────────────

describe("dispose(computed)", () => {
    it("removes the computed and decrements stats", () => {
        const before = r.stats().computeds;
        const c = r.computed(() => 1);
        c(); // force evaluation
        assert.equal(r.stats().computeds, before + 1);

        r.dispose(c);
        assert.equal(r.stats().computeds, before);
    });

    it("is idempotent on computeds too", () => {
        const c = r.computed(() => 1);
        const baseline = r.stats().computeds - 1;
        r.dispose(c);
        r.dispose(c);
        assert.equal(r.stats().computeds, baseline);
    });

    it("stale computed handle does not corrupt a recycled slot", () => {
        const small = createRegistry({maxNodes: 4, maxLinks: 16});
        const compA = small.computed(() => 1);
        compA();
        small.dispose(compA);

        const compB = small.computed(() => 2);
        compB();
        assert.equal(small.stats().computeds, 1);

        small.dispose(compA);   // stale — must be a no-op
        assert.equal(small.stats().computeds, 1);
        assert.equal(compB(), 2);
    });

    it("disposed computed disconnects from its upstream signals", () => {
        const s = r.signal(0);
        const c = r.computed(() => s() * 2);
        const linksAfterWire = (c(), r.stats().activeLinks);

        r.dispose(c);
        assert.ok(r.stats().activeLinks < linksAfterWire);

        // Setting s should not be (incorrectly) marking the disposed c as dirty
        // — easiest way to verify: another effect attached to s still fires.
        let runs = 0;
        r.effect(() => { runs++; s(); });
        s.set(1);
        assert.equal(runs, 2);
    });
});

// ─── Effect disposal ─────────────────────────────────────────────────────────

describe("dispose(effectHandle)", () => {
    it("dispose() on the effect-returned function is the same as calling it directly", () => {
        const s = r.signal(0);
        let runs = 0;
        const handle = r.effect(() => { runs++; s(); });
        assert.equal(runs, 1);

        r.dispose(handle);
        s.set(1);
        assert.equal(runs, 1, "no re-run after dispose() on the handle");
    });

    it("is idempotent when routed through dispose()", () => {
        const handle = r.effect(() => {});
        const baseline = r.stats().effects - 1;
        r.dispose(handle);
        r.dispose(handle);
        r.dispose(handle);
        assert.equal(r.stats().effects, baseline);
    });

    it("stale effect handle does not corrupt a slot recycled after destroy()", () => {
        // Regression: the effect's disposeFn closure captured a direct
        // reference to its pool slot. After destroy() + reuse, that slot
        // could be a signal — the stale closure would treat it as an effect
        // and decrement statEffects (going negative) while freeing the new
        // occupant. Fix: capture birth-gen and bail if the slot has moved on.
        const small = createRegistry({maxNodes: 4});
        const oldDispose = small.effect(() => {});

        small.destroy();
        const newSig = small.signal("survivor");

        oldDispose();  // stale — must be a complete no-op

        const s = small.stats();
        assert.equal(s.signals, 1, "the new signal must still be counted");
        assert.equal(s.effects, 0, "statEffects must not go negative");
        assert.ok(s.effects >= 0, "stat counters must never go negative");
        assert.equal(newSig(), "survivor", "new signal must remain alive and readable");
    });

    it("stale effect handle survives repeated dispose() after destroy", () => {
        const small = createRegistry({maxNodes: 4});
        const oldDispose = small.effect(() => {});
        small.destroy();
        const newSig = small.signal("ok");
        // Hammer it.
        for (let i = 0; i < 50; i++) oldDispose();
        assert.equal(small.stats().signals, 1);
        assert.equal(newSig(), "ok");
    });
});

// ─── Foreign / unrelated values ──────────────────────────────────────────────

describe("dispose() of unrelated values", () => {
    it("dispose(undefined) is a safe no-op", () => {
        assert.doesNotThrow(() => r.dispose(undefined));
    });

    it("dispose(null) is a safe no-op", () => {
        assert.doesNotThrow(() => r.dispose(null));
    });

    it("dispose(primitive) is a safe no-op", () => {
        for (const v of [0, 42, "", "x", true, false, NaN, Symbol("x")]) {
            assert.doesNotThrow(() => r.dispose(v), `dispose(${String(v)})`);
        }
    });

    it("dispose(plain object) is a safe no-op", () => {
        assert.doesNotThrow(() => r.dispose({}));
        assert.doesNotThrow(() => r.dispose({foo: "bar"}));
        assert.doesNotThrow(() => r.dispose([1, 2, 3]));
    });

    it("dispose(arbitrary function) calls it (effect-handle shape)", () => {
        // Any function passed in is treated as an effect dispose handle and
        // invoked once. Documented contract — keep it explicit in tests so we
        // catch any future regression that breaks effect dispose forwarding.
        let called = 0;
        const fn = () => { called++; };
        r.dispose(fn);
        assert.equal(called, 1);
    });
});

// ─── Cross-registry safety ───────────────────────────────────────────────────

describe("cross-registry isolation", () => {
    it("disposing a signal in the wrong registry is a silent no-op", () => {
        const a = createRegistry();
        const b = createRegistry();
        const sigA = a.signal(7);
        const aSignalsBefore = a.stats().signals;
        const bSignalsBefore = b.stats().signals;

        b.dispose(sigA);   // wrong registry

        assert.equal(a.stats().signals, aSignalsBefore, "regA stats untouched");
        assert.equal(b.stats().signals, bSignalsBefore, "regB stats untouched");

        // sigA is still alive in regA — it can still be read and updated.
        assert.equal(sigA(), 7);
        let runs = 0;
        a.effect(() => { runs++; sigA(); });
        sigA.set(8);
        assert.equal(runs, 2);
        assert.equal(sigA(), 8);
    });

    it("disposing a computed across registries is a silent no-op", () => {
        const a = createRegistry();
        const b = createRegistry();
        const sigA = a.signal(0);
        const compA = a.computed(() => sigA() + 1);
        compA();

        const before = a.stats();
        b.dispose(compA);
        const after = a.stats();
        assert.equal(after.computeds, before.computeds);
        assert.equal(after.activeNodes, before.activeNodes);
        assert.equal(compA(), 1);
    });

    it("disposing a foreign effect handle is safe: closure is bound to its own registry", () => {
        // Effect dispose handles are plain functions with no `.peek` — they
        // self-execute when passed to any registry's dispose(). That's correct
        // because the closure is bound to its origin registry and only frees
        // its own slot.
        const a = createRegistry();
        const b = createRegistry();
        const sigA = a.signal(0);
        let runs = 0;
        const handle = a.effect(() => { runs++; sigA(); });

        b.dispose(handle);  // foreign call: but the function self-executes
        sigA.set(1);
        assert.equal(runs, 1, "effect was disposed via its own closure");
    });

    it("disposing a foreign SIGNAL does NOT invoke it (no read, no link)", () => {
        // Regression: a foreign signal is also a function. Without a .peek
        // guard, dispose() would fall through and call api() — at best
        // evaluating it, at worst (if called inside a tracking context)
        // cross-linking it into the wrong observer.
        const a = createRegistry();
        const b = createRegistry();
        const sigB = b.signal("B");

        let invocations = 0;
        const probe = new Proxy(sigB, {
            apply(t, thisArg, args) { invocations++; return Reflect.apply(t, thisArg, args); }
        });
        a.dispose(probe);
        assert.equal(invocations, 0, "foreign signal must not be called");

        // And of course it must still be alive and well in its own registry.
        assert.equal(sigB(), "B");
    });

    it("disposing a foreign COMPUTED does NOT invoke it", () => {
        const a = createRegistry();
        const b = createRegistry();
        const sigB = b.signal(2);
        const compB = b.computed(() => sigB() * 10);
        compB();

        let invocations = 0;
        const probe = new Proxy(compB, {
            apply(t, thisArg, args) { invocations++; return Reflect.apply(t, thisArg, args); }
        });
        a.dispose(probe);
        assert.equal(invocations, 0, "foreign computed must not be called");
    });
});

// ─── Top-level dispose() helper ──────────────────────────────────────────────

describe("top-level dispose()", () => {
    it("routes to the default registry", async () => {
        // Import lazily to avoid coupling tests to module-evaluation order.
        const {signal, computed, effect, dispose, stats} = await import("../Signal.js");

        const s = signal(0);
        const c = computed(() => s() * 2);
        let runs = 0;
        const e = effect(() => { runs++; c(); });

        const before = stats();
        dispose(s);
        dispose(c);
        dispose(e);

        const after = stats();
        assert.equal(after.signals, before.signals - 1);
        assert.equal(after.computeds, before.computeds - 1);
        assert.equal(after.effects, before.effects - 1);
    });
});

// ─── Stress: balanced create/dispose churn ──────────────────────────────────

describe("dispose churn", () => {
    it("balanced create/dispose cycles leave stats and pool size stable", () => {
        const baseline = r.stats();

        for (let i = 0; i < 500; i++) {
            const s = r.signal(i);
            const c = r.computed(() => s() + 1);
            const e = r.effect(() => { c(); });
            r.dispose(e);
            r.dispose(c);
            r.dispose(s);
        }

        const after = r.stats();
        assert.equal(after.signals, baseline.signals);
        assert.equal(after.computeds, baseline.computeds);
        assert.equal(after.effects, baseline.effects);
        assert.equal(after.activeNodes, baseline.activeNodes);
        assert.equal(after.activeLinks, baseline.activeLinks);
        // Pool should not have had to grow.
        assert.equal(after.nodePoolCapacity, baseline.nodePoolCapacity);
        assert.equal(after.linkPoolCapacity, baseline.linkPoolCapacity);
    });
});
