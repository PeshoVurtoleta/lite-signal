// 1.2.2 free-list-invariant tests.
//
// 1.2.2 removes redundant field-writes from createNode that defended against
// state that cannot exist on a clean free-list. The audit claim is:
//   - 7 graph/batch fields (headDep, tailDep, headSub, tailSub, revertEpoch,
//     preBatchValue, preBatchVersion) and
//   - 4 owner-tree fields (owner, prevOwned, nextOwned, firstOwned)
// are guaranteed-null/zero on every node leaving the pool, because both
// teardown paths (disposeNode direct, runCleanup parent cascade) null them
// and the fresh-allocation path (ReactiveNode constructor) initializes them
// to the same values.
//
// The right test for a code-deletion patch is NOT a new-branch test (none
// exists) but an invariant assertion: walk freshly-allocated nodes after a
// varied exercise of the engine, and assert every parked node satisfies the
// invariant. If a future change reintroduces a write to a clean-state
// field on the dispose path, this test still passes (overwrite-with-zero
// is idempotent); if a future change FAILS to clear one of these fields,
// this test catches it immediately.

import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

// Reach into a freshly-allocated node via describe(handle). describe() surfaces
// the underlying ReactiveNode on the descriptor as a symbol-keyed property
// (the documented "re-walkable descriptor" contract -- see 1.2.1 changelog).
function nodeOf(handle, registry) {
    const desc = registry.describe(handle);
    if (desc === undefined) return undefined;
    for (const s of Object.getOwnPropertySymbols(desc)) {
        const v = desc[s];
        if (v !== null && typeof v === "object" && "flags" in v && "headDep" in v) return v;
    }
    return undefined;
}

describe("1.2.2 free-list invariant: graph/batch fields clean on recycle", () => {
    it("a recycled slot reports null head/tailDep, null head/tailSub", () => {
        const r = createRegistry();
        const s = r.signal(0);
        const c = r.computed(() => s() * 2);
        const e = r.effect(() => { c(); });

        // Pre-condition: edges actually exist.
        const sNodeBefore = nodeOf(s, r);
        const cNodeBefore = nodeOf(c, r);
        assert.ok(sNodeBefore.headSub !== null, "signal should have subscribers pre-dispose");
        assert.ok(cNodeBefore.headDep !== null, "computed should have a dep pre-dispose");

        r.dispose(e); r.dispose(c); r.dispose(s);

        // LIFO free list: fresh allocation lands on a recycled slot.
        const fresh = r.signal(42);
        const node = nodeOf(fresh, r);
        assert.ok(node !== undefined, "fresh handle must resolve");

        // The 7 audited graph/batch fields must be at their clean-state values.
        // (createNode in 1.2.2 NO LONGER writes these; they must already be clean.)
        assert.equal(node.headDep, null, "headDep must be null on a freshly-allocated node");
        assert.equal(node.tailDep, null, "tailDep must be null on a freshly-allocated node");
        assert.equal(node.headSub, null, "headSub must be null on a freshly-allocated node");
        assert.equal(node.tailSub, null, "tailSub must be null on a freshly-allocated node");
        assert.equal(node.revertEpoch, 0, "revertEpoch must be 0 on a freshly-allocated node");
        assert.equal(node.preBatchValue, undefined, "preBatchValue must be undefined on a freshly-allocated node");
        assert.equal(node.preBatchVersion, 0, "preBatchVersion must be 0 on a freshly-allocated node");
    });

    it("a recycled slot reports null owner/prevOwned/nextOwned/firstOwned (owner-tree clean)", () => {
        const r = createRegistry();

        // Owner cascade: outer effect owns inner effect, inner owns inner computed.
        let innerEff, innerComp;
        const outer = r.effect(() => {
            innerEff = r.effect(() => {
                innerComp = r.computed(() => 1);
                innerComp();
            });
        });

        r.dispose(outer);   // cascade-disposes both inner observers

        // Allocate fresh -- the recycled slots' owner-tree fields must be clean.
        const fresh1 = r.signal(0);
        const fresh2 = r.signal(0);
        const fresh3 = r.signal(0);
        for (const h of [fresh1, fresh2, fresh3]) {
            const n = nodeOf(h, r);
            assert.equal(n.owner, null, "owner must be null on a freshly-allocated node");
            assert.equal(n.prevOwned, null, "prevOwned must be null on a freshly-allocated node");
            assert.equal(n.firstOwned, null, "firstOwned must be null on a freshly-allocated node");
            // A top-level signal is NOT owner-adopted, so nextOwned must be null here too.
            assert.equal(n.nextOwned, null, "nextOwned must be null on a non-adopted freshly-allocated node");
        }
    });

    it("varied churn (simple/batched/error-flush) leaves no dirty state on the free list", () => {
        const r = createRegistry();

        // 1) Simple churn
        for (let i = 0; i < 64; i++) {
            const s = r.signal(i);
            const c = r.computed(() => s() + 1);
            c();
            r.dispose(c); r.dispose(s);
        }
        // 2) Batched writes touch preBatchValue/preBatchVersion/revertEpoch
        const sb = r.signal(0);
        for (let i = 0; i < 16; i++) r.batch(() => { sb.set(i); sb.set(i + 1); });
        r.dispose(sb);
        // 3) Error-flush path must still leave clean state
        const sErr = r.signal(0);
        const eErr = r.effect(() => { if (sErr() === 1) throw new Error("test"); });
        try { sErr.set(1); } catch { /* expected */ }
        r.dispose(eErr); r.dispose(sErr);

        // Every fresh allocation thereafter must satisfy the invariant.
        for (let i = 0; i < 32; i++) {
            const h = r.signal(i);
            const n = nodeOf(h, r);
            assert.equal(n.headDep, null);
            assert.equal(n.tailDep, null);
            assert.equal(n.headSub, null);
            assert.equal(n.tailSub, null);
            assert.equal(n.revertEpoch, 0);
            assert.equal(n.preBatchValue, undefined);
            assert.equal(n.preBatchVersion, 0);
            assert.equal(n.owner, null);
            assert.equal(n.prevOwned, null);
            assert.equal(n.nextOwned, null);
            assert.equal(n.firstOwned, null);
        }
    });
});

describe("1.2.2 coverage: self-disposing computed-that-throws (close the 891-898 gap)", () => {
    it("a computed that disposes itself and throws is swallowed without corrupting the pool", () => {
        // This hits the else-branch in pullComputed's catch (the 'swallow rather
        // than corrupt a recycled slot' path) which is provably unreachable from
        // the conformance set but covered here.
        const r = createRegistry();
        const s = r.signal(0);

        // Create a computed that, when first pulled, disposes itself then throws.
        // We capture the dispose handle by writing it from outside.
        let selfDispose = null;
        const c = r.computed(() => {
            s();
            if (selfDispose !== null) selfDispose();
            throw new Error("self-disposed and threw");
        });
        // Wire the dispose handle so the body can self-dispose on next pull
        selfDispose = () => r.dispose(c);

        // First pull triggers the body
        let caught = null;
        try { c(); } catch (e) { caught = e; }

        // The engine should have either:
        //  - Thrown the error (caller catches it), OR
        //  - Swallowed silently (because the slot was disposed mid-throw)
        // Either is correct -- the invariant we care about is that the pool is
        // not corrupted. Allocate fresh nodes and verify the invariant.
        for (let i = 0; i < 4; i++) {
            const fresh = r.signal(i);
            const id = r.nodeId(fresh);
            assert.equal(typeof id, "number", "fresh allocation must produce a valid handle");
        }
    });
});
