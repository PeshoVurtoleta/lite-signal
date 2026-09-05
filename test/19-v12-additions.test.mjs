// 19-v12-additions.test.mjs — release-prep tests added for v1.2.0.
//
// Locks in v1.2-specific behavior surfaced during the release review:
//   1. shared peek (one closure per registry, not per primitive)
//   2. owner adoption rule (signals NOT adopted, observers ARE)
//   3. pre-batch revert (set X then back inside a batch suppresses the
//      version bump, downstream effects do not fire)
//   4. multi-effect flush errors become AggregateError
//   5. CycleError when the flush exceeds maxFlushPasses
//   6. maxLinks config branch (was uncovered by the existing suite)
//   7. dispose-then-set on a signal is a silent no-op (documented hazard)
//   8. ABA gen guard: a stop function captured pre-dispose is a no-op
//      after dispose+recycle into the same pool slot.

import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {
    createRegistry,
    signal, computed, effect, batch, dispose, stats,
    CapacityError
} from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

// ─────────────────────────────────────────────────────────────────────────────
// 1. SHARED PEEK
// ─────────────────────────────────────────────────────────────────────────────
describe("shared peek (release-prep optimisation, v1.2.0)", () => {
    it("every signal's peek is the SAME function reference (one per registry)", () => {
        const a = r.signal(1);
        const b = r.signal("x");
        const c = r.signal({});
        assert.strictEqual(a.peek, b.peek, "two signals share peek");
        assert.strictEqual(a.peek, c.peek, "all signals share peek");
        assert.equal(typeof a.peek, "function");
    });

    it("every computed's peek is the SAME function reference", () => {
        const a = r.signal(1);
        const c1 = r.computed(() => a() * 2);
        const c2 = r.computed(() => a() + 1);
        assert.strictEqual(c1.peek, c2.peek, "two computeds share peek");
    });

    it("signal.peek does NOT track inside an effect", () => {
        const a = r.signal(10);
        let runs = 0;
        const stop = r.effect(() => { runs++; a.peek(); });
        const base = runs;
        a.set(99);
        assert.equal(runs - base, 0, "peek should not establish a dep");
        stop();
    });

    it("computed.peek correctly resolves the cached/pull paths", () => {
        const a = r.signal(5);
        const c = r.computed(() => a() * 10);
        assert.equal(c.peek(), 50, "fresh pull via peek");
        a.set(7);
        assert.equal(c.peek(), 70, "re-pull after upstream change");
        a.set(7);  // same value -> equality short-circuit -> still 70
        assert.equal(c.peek(), 70, "no-op set leaves value intact");
    });

    it("two registries hold INDEPENDENT shared peeks", () => {
        const r2 = createRegistry();
        const a = r.signal(1);
        const b = r2.signal(1);
        assert.notStrictEqual(a.peek, b.peek, "peek is per-registry, not global");
        r2.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. OWNER ADOPTION RULE
// ─────────────────────────────────────────────────────────────────────────────
describe("owner adoption rule (v1.2.0)", () => {
    it("a signal allocated inside an effect is NOT owner-adopted (stats prove it)", () => {
        const ext = r.signal(0);
        let innerSig = null;
        const stop = r.effect(() => {
            ext();
            if (!innerSig) innerSig = r.signal("LAZY");
        });
        const sigsBefore = r.stats().signals;
        ext.set(1);                                    // forces effect re-run
        const sigsAfter = r.stats().signals;
        assert.equal(sigsAfter, sigsBefore,
            "signal count is stable across owner re-runs (signal NOT adopted)");
        assert.equal(innerSig(), "LAZY", "lazy signal survives re-run");
        stop();
    });

    it("a computed allocated inside an effect IS owner-adopted", () => {
        const ext = r.signal(0);
        const stop = r.effect(() => {
            ext();
            r.computed(() => 42);                     // lazily allocated, no handle kept
        });
        const before = r.stats().computeds;
        ext.set(1); ext.set(2); ext.set(3);
        const after = r.stats().computeds;
        assert.equal(after, before,
            "computeds count stays steady: old ones disposed, new ones replace them");
        stop();
    });

    it("the owner cascade drains via firstOwned (no orphan children after outer dispose)", () => {
        const ext = r.signal(0);
        const outer = r.effect(() => {
            ext();
            r.effect(() => {});   // 5 nested effects per outer-run
            r.effect(() => {});
            r.effect(() => {});
            r.effect(() => {});
            r.effect(() => {});
        });
        // Trigger a few re-runs to be sure
        ext.set(1); ext.set(2); ext.set(3);
        const before = r.stats().effects;
        outer();
        const after = r.stats().effects;
        assert.equal(after, before - 6,
            "outer + 5 inner = 6 effects gone; no orphan children");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PRE-BATCH REVERT
// ─────────────────────────────────────────────────────────────────────────────
describe("pre-batch revert (v1.2.0)", () => {
    it("set X then set X back inside a batch does NOT fire the effect", () => {
        const a = r.signal(10);
        let runs = 0;
        const stop = r.effect(() => { runs++; a(); });
        const base = runs;
        r.batch(() => { a.set(99); a.set(10); });
        assert.equal(runs - base, 0, "version was reverted, no re-fire");
        stop();
    });

    it("revert propagates: downstream computed is NOT invalidated", () => {
        const a = r.signal(10);
        let cRuns = 0;
        const c = r.computed(() => { cRuns++; return a() * 2; });
        const stop = r.effect(() => { c(); });
        const base = cRuns;
        r.batch(() => { a.set(99); a.set(10); });
        assert.equal(cRuns - base, 0, "downstream computed did not re-evaluate");
        stop();
    });

    it("revert respects a custom equals predicate", () => {
        const a = r.signal({x: 1}, {equals: (l, r) => l.x === r.x});
        let runs = 0;
        const stop = r.effect(() => { runs++; a(); });
        const base = runs;
        r.batch(() => {
            a.set({x: 2});   // a real change
            a.set({x: 1});   // semantically equal to original under user equals
        });
        assert.equal(runs - base, 0, "custom equals saw the revert as a no-op");
        stop();
    });

    it("revert in a nested batch still works", () => {
        const a = r.signal(10);
        let runs = 0;
        const stop = r.effect(() => { runs++; a(); });
        const base = runs;
        r.batch(() => {
            a.set(99);
            r.batch(() => { a.set(10); });
        });
        assert.equal(runs - base, 0);
        stop();
    });

    it("revert does NOT mask a legitimate FINAL different value", () => {
        const a = r.signal(10);
        let runs = 0;
        const stop = r.effect(() => { runs++; a(); });
        const base = runs;
        r.batch(() => { a.set(99); a.set(10); a.set(7); });
        assert.equal(runs - base, 1, "final value 7 differs from 10, must fire once");
        assert.equal(a(), 7);
        stop();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. MULTI-THROW → AggregateError
// ─────────────────────────────────────────────────────────────────────────────
describe("flush error aggregation (v1.2.0)", () => {
    it("two effects throwing in the SAME flush produce AggregateError", () => {
        const a = r.signal(0);
        // Effects that throw only on re-run (first-run throws would surface
        // synchronously at the effect() call site)
        const stop1 = r.effect(() => { if (a() === 5) throw new Error("e1"); });
        const stop2 = r.effect(() => { if (a() === 5) throw new Error("e2"); });
        let runsClean = 0;
        const stopClean = r.effect(() => { a(); runsClean++; });
        let caught;
        try { a.set(5); } catch (e) { caught = e; }
        assert.ok(caught instanceof AggregateError, "got AggregateError");
        assert.equal(caught.errors.length, 2, "both errors carried");
        const messages = caught.errors.map(e => e.message).sort();
        assert.deepEqual(messages, ["e1", "e2"]);
        assert.ok(runsClean >= 2, "clean effect still ran");
        stop1(); stop2(); stopClean();
    });

    it("single throw is rethrown directly, not wrapped", () => {
        const a = r.signal(0);
        const stop = r.effect(() => { if (a() === 5) throw new Error("lone"); });
        let caught;
        try { a.set(5); } catch (e) { caught = e; }
        assert.ok(!(caught instanceof AggregateError), "single error is not aggregated");
        assert.equal(caught.message, "lone");
        stop();
    });

    it("engine survives a thrown effect — subsequent sets propagate normally", () => {
        const a = r.signal(0);
        let runs = 0;
        const stop = r.effect(() => { runs++; const v = a(); if (v === 3) throw new Error("boom"); });
        const base = runs;
        try { a.set(3); } catch (_) {}
        a.set(4);
        assert.ok(runs > base + 1, "post-throw set still triggered a re-run");
        stop();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CycleError via maxFlushPasses
// ─────────────────────────────────────────────────────────────────────────────
describe("CycleError detection (v1.2.0)", () => {
    it("default maxFlushPasses (100) catches a real ping-pong cycle", () => {
        const a = r.signal(0), b = r.signal(0);
        // Each effect updates the OTHER; the self-trigger guard does not stop
        // cross-effect feedback, only same-effect feedback.
        const stopA = r.effect(() => { const v = a(); if (v < 500) b.set(v + 1); });
        const stopB = r.effect(() => { const v = b(); if (v < 500) a.set(v + 1); });
        let caught;
        try { a.set(1); } catch (e) { caught = e; }
        assert.ok(caught, "must throw");
        assert.match(caught.message, /^CycleError:/);
        stopA(); stopB();
    });

    it("a custom maxFlushPasses can be set per registry", () => {
        const r2 = createRegistry({maxFlushPasses: 5});
        const a = r2.signal(0), b = r2.signal(0);
        const stopA = r2.effect(() => { const v = a(); if (v < 50) b.set(v + 1); });
        const stopB = r2.effect(() => { const v = b(); if (v < 50) a.set(v + 1); });
        let caught;
        try { a.set(1); } catch (e) { caught = e; }
        assert.match(caught.message, /^CycleError:/);
        stopA(); stopB(); r2.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. maxLinks config branch
// ─────────────────────────────────────────────────────────────────────────────
describe("maxLinks config (coverage gap)", () => {
    it("createRegistry({maxLinks: N}) is honored under 'throw' policy", () => {
        const r2 = createRegistry({maxNodes: 16, maxLinks: 4, onCapacityExceeded: "throw"});
        const a = r2.signal(0), b = r2.signal(0), c = r2.signal(0), d = r2.signal(0), e = r2.signal(0);
        // 5 deps -> needs 5 links; capacity is 4 -> CapacityError
        const _ = r2.computed(() => a() + b() + c() + d() + e());
        assert.throws(() => _(),
            (err) => err instanceof CapacityError && err.kind === "links",
            "should throw on link exhaustion");
        r2.destroy();
    });

    it("createRegistry({maxLinks: N, onCapacityExceeded: 'grow'}) grows the link pool", () => {
        const r2 = createRegistry({maxNodes: 16, maxLinks: 2, onCapacityExceeded: "grow"});
        const sources = [];
        for (let i = 0; i < 10; i++) sources.push(r2.signal(i));
        let read = null;
        const c = r2.computed(() => {
            let sum = 0;
            for (const s of sources) sum += s();
            return sum;
        });
        // 10 deps with maxLinks: 2 → must grow at least 3 times (2→4→8→16)
        assert.equal(c(), 45);
        const linkCap = r2.stats().linkPoolCapacity;
        assert.ok(linkCap >= 16, `link pool grew (capacity now ${linkCap})`);
        r2.destroy();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. DISPOSED-SIGNAL READ/SET HAZARD (locks in documented behavior)
// ─────────────────────────────────────────────────────────────────────────────
describe("disposed signal read/set (documented behavior)", () => {
    it("read after dispose returns undefined (no throw)", () => {
        const s = r.signal(42);
        r.dispose(s);
        let v, threw = false;
        try { v = s(); } catch (_) { threw = true; }
        assert.equal(threw, false, "read should not throw");
        assert.equal(v, undefined, "read returns undefined post-dispose");
    });

    it("set after dispose is a silent no-op (no throw, no propagation)", () => {
        const s = r.signal(42);
        const c = r.computed(() => s() * 2);
        const stop = r.effect(() => { c(); });
        const cBefore = c();
        r.dispose(s);
        let threw = false;
        try { s.set(99); } catch (_) { threw = true; }
        assert.equal(threw, false, "set should not throw");
        assert.equal(c(), cBefore, "downstream did not update");
        stop();
    });

    it("dispose() on the same node twice is idempotent", () => {
        const s = r.signal(1);
        r.dispose(s);
        assert.doesNotThrow(() => r.dispose(s));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ABA GUARD on the effect stop function
// ─────────────────────────────────────────────────────────────────────────────
describe("stop-fn ABA guard (v1.2.0)", () => {
    it("a stop function captured before dispose is a no-op after dispose+recycle", () => {
        const a = r.signal(0);
        // Saturate the pool a bit so the recycle path is exercised
        const stop1 = r.effect(() => { a(); });
        const beforeEffects = r.stats().effects;
        stop1();
        assert.equal(r.stats().effects, beforeEffects - 1, "stop1 disposed");

        // Create a new effect in the recycled slot — same node pointer likely
        const stop2 = r.effect(() => { a(); });
        const beforeRecycle = r.stats().effects;

        // Call the OLD stop function. With the gen-bound guard it must be a no-op:
        stop1();
        assert.equal(r.stats().effects, beforeRecycle,
            "stale stop did not free the recycled effect");

        // Real stop still works
        stop2();
        assert.equal(r.stats().effects, beforeRecycle - 1);
    });
});
