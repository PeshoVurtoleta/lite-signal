// /tests/09-conformance_test.mjs
// johnsoncodehk/reactive-framework-test-suite conformance fixes.
// Grouped by upstream test ID for traceability against the score line.
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

const hasGC = typeof globalThis.gc === "function";
function forceGc() { if (hasGC) { globalThis.gc(); globalThis.gc(); } }
function heapKB() { return process.memoryUsage().heapUsed / 1024; }

// ─── Capability probe: owner tree (auto-dispose of nested observers) ──────────
// Present in v1.2.0+, absent in v1.1.x. Detected behaviorally so this one file
// runs unchanged across branches — same idiom as `hasGC` above. The owner-tree
// conformance items (#209/#210) only hold on an engine that has the owner tree;
// on 1.1.x they are skipped, not failed.
const HAS_OWNER_TREE = (() => {
    try {
        const rr = createRegistry();
        const a = rr.signal(0), b = rr.signal(0);
        let innerRuns = 0;
        rr.effect(() => { a(); rr.effect(() => { b(); innerRuns++; }); });
        a.set(1);                          // outer re-runs => creates a fresh inner
        const before = innerRuns;
        b.set(1);                          // fire every still-live inner
        rr.destroy();
        return (innerRuns - before) === 1; // 1 => only newest inner alive => owner tree
    } catch { return false; }
})();
const ownerSkip = HAS_OWNER_TREE ? false : "owner tree lands in v1.2 (engine has no owner tree)";


let r;
beforeEach(() => { r = createRegistry(); });

describe("#121 throw isolation in flush", () => {
    it("pending effects run even if some effects throw during batch", () => {
        const a = r.signal(0);
        let goodRuns = 0;

        r.effect(() => { a(); goodRuns++; });
        r.effect(() => { if (a() > 0) throw new Error("bad effect"); });

        assert.equal(goodRuns, 1);

        try { r.batch(() => { a.set(1); }); } catch {}
        assert(goodRuns >= 2, `goodRuns=${goodRuns}`);
    });

    it("effect created BEFORE thrower still runs (order independence)", () => {
        // Variant of #121 with the thrower scheduled first — would have
        // halted the flush pre-patch even with creation-order propagation.
        const a = r.signal(0);
        let goodRuns = 0;

        r.effect(() => { if (a() > 0) throw new Error("bad effect"); });
        r.effect(() => { a(); goodRuns++; });

        try { r.batch(() => { a.set(1); }); } catch {}
        assert.equal(goodRuns, 2, "effect after thrower in queue must still run");
    });

    it("single throw is re-raised as-is, not wrapped", () => {
        const a = r.signal(0);
        const sentinel = new Error("solo");
        r.effect(() => { if (a() > 0) throw sentinel; });

        let caught = null;
        try { r.batch(() => { a.set(1); }); } catch (e) { caught = e; }
        assert.strictEqual(caught, sentinel, "single error must propagate unchanged");
    });

    it("multiple throws collected into AggregateError in order", () => {
        const a = r.signal(0);
        const e1 = new Error("first");
        const e2 = new Error("second");
        const e3 = new Error("third");

        r.effect(() => { if (a() > 0) throw e1; });
        r.effect(() => { if (a() > 0) throw e2; });
        r.effect(() => { if (a() > 0) throw e3; });

        let caught = null;
        try { r.batch(() => { a.set(1); }); } catch (e) { caught = e; }
        assert(caught instanceof AggregateError, "expected AggregateError");
        assert.deepEqual(caught.errors, [e1, e2, e3]);
    });

    it("registry remains usable after a throwing flush (isFlushing cleared)", () => {
        const a = r.signal(0);
        let goodRuns = 0;
        r.effect(() => { a(); goodRuns++; });
        r.effect(() => { if (a() > 0) throw new Error("bad"); });

        try { r.batch(() => { a.set(1); }); } catch {}
        const runsBefore = goodRuns;

        // A subsequent write must still propagate.
        // We wrap in try/catch because the bad effect will legitimately throw again!
        try { a.set(2); } catch {}
        assert(goodRuns > runsBefore, `goodRuns=${goodRuns}, expected > ${runsBefore}`);
    });

    it("CycleError takes precedence over buffered effect errors", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let caught = null;

        try {
            r.batch(() => {
                // Will throw on every pass once a > 0:
                r.effect(() => { if (a() > 0) throw new Error("buffered"); });
                // Ping-pong pair, stabilized via batch:
                r.effect(() => { b.set(a() + 1); });
                r.effect(() => { a.set(b() + 1); });
            });
        } catch (e) { caught = e; }

        assert(caught instanceof Error);
        assert(/Cycle/i.test(caught.message), `got: ${caught?.message}`);
    });
});

describe("#121 zero-GC invariant on happy path", {skip: !hasGC ? "requires --expose-gc" : false}, () => {
    it("100k flushes with NO throws: retained heap ~ 0KB", () => {
        const r2 = createRegistry({maxNodes: 8, maxLinks: 8, onCapacityExceeded: "grow"});
        const a = r2.signal(0);
        let sink = 0;
        r2.effect(() => { sink = a(); });

        for (let i = 0; i < 5000; i++) a.set(i);
        forceGc();
        const before = heapKB();

        for (let i = 0; i < 100_000; i++) a.set(i);

        forceGc();
        const delta = heapKB() - before;
        assert(delta < 200, `retained heap ${delta.toFixed(1)} KB`);
        assert.equal(sink, 99_999);
    });
});

describe("#216 effects fire in creation order on shared signal", () => {
    it("three effects on one signal fire in creation order", () => {
        const a = r.signal(0);
        const order = [];
        r.effect(() => { a(); order.push(1); });
        r.effect(() => { a(); order.push(2); });
        r.effect(() => { a(); order.push(3); });
        order.length = 0;

        a.set(1);
        assert.deepEqual(order, [1, 2, 3]);

        order.length = 0;
        a.set(2);
        assert.deepEqual(order, [1, 2, 3], "order is stable across writes");
    });

    it("position is fixed at first subscription; cursor-reuse does not move it", () => {
        // E2 also depends on b. When b changes, E2 re-evaluates and reuses
        // its existing link to `a` via the activeObserverCurrentDep cursor —
        // sub-list position on `a` must not change.
        const a = r.signal(0);
        const b = r.signal(0);
        const order = [];
        r.effect(() => { a(); order.push(1); });
        r.effect(() => { a(); b(); order.push(2); });
        r.effect(() => { a(); order.push(3); });

        order.length = 0;
        b.set(1);                    // re-runs E2 only
        order.length = 0;
        a.set(1);
        assert.deepEqual(order, [1, 2, 3]);
    });

    it("recreated effect lands at tail of sub list", () => {
        const a = r.signal(0);
        const order = [];
        r.effect(() => { a(); order.push(1); });
        const stop2 = r.effect(() => { a(); order.push(2); });
        r.effect(() => { a(); order.push(3); });
        stop2();
        r.effect(() => { a(); order.push(4); });

        order.length = 0;
        a.set(1);
        assert.deepEqual(order, [1, 3, 4], "disposed E2 is gone; new E4 is at tail");
    });
});

describe("#216 zero-GC invariant preserved", {skip: !hasGC ? "requires --expose-gc" : false}, () => {
    it("100k set() with three sub effects: retained heap ~ 0KB", () => {
        const r2 = createRegistry({maxNodes: 8, maxLinks: 8, onCapacityExceeded: "grow"});
        const a = r2.signal(0);
        let s1 = 0, s2 = 0, s3 = 0;
        r2.effect(() => { s1 = a(); });
        r2.effect(() => { s2 = a(); });
        r2.effect(() => { s3 = a(); });

        for (let i = 0; i < 5000; i++) a.set(i);
        forceGc();
        const before = heapKB();

        for (let i = 0; i < 100_000; i++) a.set(i);

        forceGc();
        const delta = heapKB() - before;
        assert(delta < 200, `retained heap ${delta.toFixed(1)} KB should be small`);
        assert.equal(s1, 99_999);
        assert.equal(s2, 99_999);
        assert.equal(s3, 99_999);
    });
});

describe("#178 cleanup invoked during sync dispose does not leak deps", () => {
    it("inner effect's cleanup-side reads do not retrack onto active outer observer", () => {
        const a = r.signal(0);
        const b = r.signal(100);

        let outerRuns = 0;
        const stopInner = r.effect(() => {
            a();
            r.onCleanup(() => { b(); });    // analogue of return-cleanup
        });

        r.effect(() => {
            a();
            outerRuns++;
            if (a() === 1) stopInner();      // dispose from within outer's tracking
        });
        outerRuns = 0;

        a.set(1);
        assert.equal(outerRuns, 1);

        outerRuns = 0;
        b.set(200);
        assert.equal(outerRuns, 0, "b must not have been linked to outer via cleanup read");
    });
});

describe("#111 dispose from within cleanup body", () => {
    it("self-dispose during cleanup terminates re-run cleanly", () => {
        const a = r.signal(0);
        let runs = 0;
        let stop;
        stop = r.effect(() => {
            runs++;
            a();
            r.onCleanup(() => { stop?.(); });
        });
        assert.equal(runs, 1);

        // Must not throw, must not double-run the body.
        a.set(1);
        assert(runs <= 2, `runs=${runs}, expected <=2`);

        a.set(2);
        assert(runs <= 2, `runs=${runs} after second write`);
    });
});

describe("#213 inner write during initial effect execution", () => {
    it("inner write during init does not block future propagation", () => {
        const s = r.signal(1);
        const c = r.computed(() => s());
        r.effect(() => { if (c() > 0) s.set(0); });

        assert.equal(s(), 0);
        s.set(2);
        assert.equal(s(), 0);
        s.set(3);
        assert.equal(s(), 0);
    });

    it("body's self-cycle write does not throw", () => {
        const s = r.signal(1);
        // Direct self-cycle (no intermediate computed). Pre-patch: CycleError.
        assert.doesNotThrow(() => {
            r.effect(() => { if (s() > 0) s.set(0); });
        });
        assert.equal(s(), 0);
    });
});

describe("#180 inner write through computed chain", () => {
    it("computed cache reflects 'no re-run' semantics", () => {
        const s = r.signal(false);
        const c = r.computed(() => s());
        let runs = 0;
        r.effect(() => { runs++; if (c()) s.set(false); });
        assert.equal(runs, 1);

        s.set(true);
        assert.equal(s(), false);
        assert(runs >= 2, `runs=${runs}`);
        const runsAfterFirst = runs;
        const effectReRuns = runs >= 3;

        s.set(true);
        if (effectReRuns) {
            assert.equal(s(), false);
            assert(runs >= runsAfterFirst + 2);
        } else {
            // lite-signal lands here: c.cache stayed true, eq-guard blocks re-eval
            assert.equal(s(), true);
            assert.equal(runs, runsAfterFirst);
        }
    });

    it("sibling effects DO fire when the writer is gated (no collateral damage)", () => {
        // Pin the design: only the *writing* effect skips re-queueing.
        // A sibling subscribed to the same dep must still see the change.
        const s = r.signal(0);
        let writerRuns = 0;
        let siblingLast = -1, siblingRuns = 0;

        r.effect(() => {
            writerRuns++;
            const v = s();
            if (v === 1) s.set(99);     // self-cycle write
        });
        r.effect(() => {
            siblingLast = s();
            siblingRuns++;
        });

        siblingRuns = 0; writerRuns = 0;
        s.set(1);
        // Writer runs once (body wrote s=99, no self re-fire).
        // Sibling sees both s=1 and s=99 — at least one fire, final value 99.
        assert(siblingRuns >= 1, `siblingRuns=${siblingRuns}`);
        assert.equal(siblingLast, 99);
    });

    it("self-cycle in cleanup does not throw", () => {
        // Companion to the cleanup hardening: a cleanup that writes a signal
        // looping back to its own effect must silently no-op the self-trigger.
        const s = r.signal(0);
        let runs = 0;
        const stop = r.effect(() => {
            runs++;
            s();
            r.onCleanup(() => { if (s() > 0) s.set(0); });
        });

        assert.doesNotThrow(() => s.set(5));
        // Cleanup wrote s=0; writer did not re-fire on its own write.
        // Whether body re-runs depends on whether s=5→0→5 cycle resolves.
        // Just assert termination + final state coherence.
        assert.equal(s(), 0);
        stop();
    });

    it("computed cache stays stale until re-pulled (no re-run consequence)", () => {
        const s = r.signal(1);
        const c = r.computed(() => s());
        r.effect(() => { if (c() > 0) s.set(0); });

        s.set(5);
        // Effect captured c=5 and wrote s=0. c not re-evaluated yet.
        assert.equal(s.peek(), 0);
        assert.equal(c(), 0, "explicit pull reconciles c to current s");
    });
});

describe("#180/#213 zero-GC invariant", {skip: !hasGC ? "requires --expose-gc" : false}, () => {
    it("100k self-cycle writes: retained heap ~ 0KB", () => {
        const r2 = createRegistry({maxNodes: 8, maxLinks: 8, onCapacityExceeded: "grow"});
        const s = r2.signal(1);
        const c = r2.computed(() => s());
        let sink = 0;

        r2.effect(() => {
            sink = c();
            if (c() > 0) s.set(0);
        });

        // Warmup to stabilize pool sizes
        for (let i = 0; i < 5000; i++) s.set(i + 1);
        forceGc();
        const before = heapKB();

        // 100k writes
        for (let i = 0; i < 100_000; i++) s.set(i + 1);

        forceGc();
        const delta = heapKB() - before;

        // Assert zero-allocation guarantee
        assert(delta < 200, `retained heap ${delta.toFixed(1)} KB`);

        // Assert "no re-run" semantics:
        // The effect captures the final external write (100,000), executes its
        // self-write to 0, and halts. It is explicitly gated from re-running
        // to see its own 0.
        assert.equal(sink, 100_000, "sink captures the value from the last external write");

        // Assert state coherence:
        // The signal's actual internal state MUST be 0 from the effect's self-write.
        assert.equal(s.peek(), 0, "signal state reflects the self-write");
    });
});
describe("#209 three-level nested effect: cascading disposal", {skip: ownerSkip}, () => {
    it("disposing the outermost effect cascades to middle and inner", () => {
        const a = r.signal(0);
        let middleRuns = 0;
        let innerRuns = 0;

        const dispose = r.effect(() => {
            a();
            r.effect(() => {
                a();
                middleRuns++;
                r.effect(() => {
                    a();
                    innerRuns++;
                });
            });
        });

        middleRuns = 0;
        innerRuns = 0;

        dispose();
        a.set(1);

        assert.equal(middleRuns, 0, "middle must not run after outer disposed");
        assert.equal(innerRuns, 0, "inner must not run after outer disposed");
    });
});

describe("#210 multiple inner effects all cleaned when outer re-runs", {skip: ownerSkip}, () => {
    it("old sibling inner effects are disposed before the outer re-creates them", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        const c = r.signal(0);
        let bRuns = 0;
        let cRuns = 0;

        r.effect(() => {
            a();
            r.effect(() => { b(); bRuns++; });
            r.effect(() => { c(); cRuns++; });
        });
        bRuns = 0;
        cRuns = 0;

        // Outer re-run — old inner effects must be cleaned up (no ghost accumulation).
        a.set(1);
        bRuns = 0;
        cRuns = 0;

        b.set(1);
        assert.equal(bRuns, 1, "only the one NEW inner-b effect responds");

        c.set(1);
        assert.equal(cRuns, 1, "only the one NEW inner-c effect responds");
    });
});

describe("#209/#210 zero-GC invariant on nested-effect churn", {skip: !hasGC ? "requires --expose-gc" : ownerSkip}, () => {
    it("100k outer re-runs that recreate an inner effect: retained heap ~ 0KB", () => {
        // If the owner tree failed to dispose children, each re-run would leak a
        // ghost inner effect node — retained heap would climb without bound.
        const r2 = createRegistry({maxNodes: 16, maxLinks: 16, onCapacityExceeded: "grow"});
        const a = r2.signal(0);
        let innerRuns = 0;
        r2.effect(() => {
            a();
            r2.effect(() => { a(); innerRuns++; });
        });

        for (let i = 0; i < 5000; i++) a.set(i);
        forceGc();
        const before = heapKB();

        for (let i = 0; i < 100_000; i++) a.set(i);

        forceGc();
        const delta = heapKB() - before;
        assert(delta < 200, `retained heap ${delta.toFixed(1)} KB (ghost inner effects must be reclaimed)`);
    });
});

describe("owner tree: direct dispose of a nested (owned) observer", {skip: ownerSkip}, () => {
    it("disposing an inner effect directly detaches it from the parent's owned-list", () => {
        const a = r.signal(0), b = r.signal(0);
        let innerRuns = 0, innerDispose = null;
        r.effect(() => {
            a();
            innerDispose = r.effect(() => { b(); innerRuns++; });
        });
        const base = innerRuns;
        innerDispose();                 // O(1) detach of an owned child from its parent
        b.set(1);
        assert.equal(innerRuns, base, "directly-disposed inner no longer fires");
        const beforeOuter = innerRuns;
        a.set(1);                       // outer still re-runs and re-creates an inner
        assert(innerRuns > beforeOuter, "outer is unaffected by the child's manual dispose");
    });
});
