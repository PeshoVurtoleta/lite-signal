// /tests/09-conformance_test.mjs
// johnsoncodehk/reactive-framework-test-suite conformance fixes.
// Grouped by upstream test ID for traceability against the score line.
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

const hasGC = typeof globalThis.gc === "function";
function forceGc() { if (hasGC) { globalThis.gc(); globalThis.gc(); } }
function heapKB() { return process.memoryUsage().heapUsed / 1024; }

let r;
beforeEach(() => { r = createRegistry(); });

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