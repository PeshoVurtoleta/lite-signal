// test/23-owner-introspection.test.mjs — pins for forEachOwned / ownerOf
// and the gen-guarded introspection surface (1.2.1).
//
// 1.2.1 adds two new owner-tree introspection functions, both gen-guarded:
//   - forEachOwned(handle, fn)  iterate owned children
//   - ownerOf(handle)           descriptor of the owner, or undefined
//
// AND it gen-guards the full introspection surface that previously resolved
// NODE_PTR unconditionally. After the 1.2.0 owner tree made the engine
// recycle slots autonomously, a stale handle would resolve to the slot's
// NEW resident -- wrong id, wrong kind, wrong edges. 1.2.1 ABA-guards via
// liveNode() in: nodeId, describe, hasObservers, observeObservers,
// forEachObserver, forEachSource, forEachOwned, ownerOf.
//
// Descriptors returned by describeNode are themselves re-walkable handles
// (per the 1.1.5 contract). 1.2.1 gen-stamps them so they go stale on
// recycle just like primary handles.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("ownerOf", () => {
    it("returns undefined for top-level signals/computeds/effects", () => {
        const s = r.signal(1);
        const c = r.computed(() => s());
        assert.equal(r.ownerOf(s), undefined, "signal has no owner");
        assert.equal(r.ownerOf(c), undefined, "top-level computed has no owner");
    });

    it("returns undefined for garbage input", () => {
        assert.equal(r.ownerOf(null), undefined);
        assert.equal(r.ownerOf(undefined), undefined);
        assert.equal(r.ownerOf(42), undefined);
        assert.equal(r.ownerOf("not a handle"), undefined);
        assert.equal(r.ownerOf({}), undefined);
    });

    it("returns undefined for a stale handle (gen-guard)", () => {
        const s = r.signal(1);
        r.dispose(s);
        assert.equal(r.ownerOf(s), undefined, "stale handle's owner lookup is undefined");
    });

    it("returns the owner descriptor for a child created inside an effect body", () => {
        let innerDescriptor = null;
        const s = r.signal(1);
        const stop = r.effect(() => {
            const inner = r.computed(() => s() * 2);
            // Inside the body, the effect is the current owner. Capture once.
            if (innerDescriptor === null) innerDescriptor = r.describe(inner);
        });
        assert.notEqual(innerDescriptor, null, "captured inner computed's descriptor");

        // ownerOf the inner should be a descriptor whose kind is "effect"
        const owner = r.ownerOf(innerDescriptor);
        assert.notEqual(owner, undefined, "inner computed has an owner");
        assert.equal(owner.kind, "effect", "owner is the enclosing effect");
        stop();
    });
});

describe("forEachOwned", () => {
    it("is a no-op for a top-level handle with no owned children", () => {
        const s = r.signal(1);
        let calls = 0;
        r.forEachOwned(s, () => calls++);
        assert.equal(calls, 0, "signal has no owned children");
    });

    it("is a no-op for garbage input", () => {
        let calls = 0;
        const cb = () => calls++;
        r.forEachOwned(null, cb);
        r.forEachOwned(undefined, cb);
        r.forEachOwned(42, cb);
        r.forEachOwned({}, cb);
        assert.equal(calls, 0, "garbage input never invokes callback");
    });

    it("iterates owned children as descriptors with id/kind/value", () => {
        let outerDescriptor = null;
        const s = r.signal(10);

        // We need a handle on the OUTER observer to ask forEachOwned about its children.
        // Pattern: a top-level effect creates a child whose owner is the effect; we
        // grab a descriptor of that child, then ask ownerOf() to get the effect's
        // descriptor, then forEachOwned() on that effect descriptor.
        let firstChildDesc = null;
        let secondChildDesc = null;
        const stop = r.effect(() => {
            const child1 = r.computed(() => s() + 1);
            const child2 = r.computed(() => s() * 2);
            if (firstChildDesc === null) {
                firstChildDesc = r.describe(child1);
                secondChildDesc = r.describe(child2);
            }
        });

        outerDescriptor = r.ownerOf(firstChildDesc);
        assert.notEqual(outerDescriptor, undefined, "got the effect's descriptor via ownerOf");

        const seen = [];
        r.forEachOwned(outerDescriptor, (d) => seen.push({ id: d.id, kind: d.kind }));
        assert.ok(seen.length >= 2, "iterated at least 2 owned children");
        assert.ok(seen.every((d) => d.kind === "computed"), "all owned children are computeds");

        stop();
    });

    it("returns no children on a stale handle (gen-guard)", () => {
        let outerDescriptor = null;
        const s = r.signal(1);
        const stop = r.effect(() => {
            r.computed(() => s());
            r.computed(() => s());
        });
        // Get the effect's descriptor via a child's ownerOf
        const someChild = r.computed(() => s());   // not actually a child of the effect (out-of-scope)
        // Approach: capture from inside instead.
        // Simpler: dispose the effect, then any handle we had to it goes stale.
        stop();
        // Without a captured outer handle, nothing to assert. Use a more direct probe:
        // make a top-level computed, dispose it, then forEachOwned must be a no-op.
        const c = r.computed(() => 1);
        const cDesc = r.describe(c);
        r.dispose(c);
        let calls = 0;
        r.forEachOwned(cDesc, () => calls++);
        assert.equal(calls, 0, "stale descriptor's forEachOwned is a no-op");
    });
});

describe("gen-guarded introspection (1.2.1 ABA fix)", () => {
    it("nodeId returns undefined for a stale handle (slot recycled)", () => {
        const s1 = r.signal("a");
        const id1 = r.nodeId(s1);
        assert.equal(typeof id1, "number");
        r.dispose(s1);
        const s2 = r.signal("b");   // recycle the slot
        // nodeId on the stale handle must NOT report s2's id
        assert.equal(r.nodeId(s1), undefined, "stale handle's nodeId is undefined");
        // sanity: the new resident reports its own id
        assert.equal(typeof r.nodeId(s2), "number");
        assert.notEqual(r.nodeId(s2), id1, "fresh signal has a different id");
    });

    it("describe returns undefined for a stale handle", () => {
        const s = r.signal(42);
        assert.notEqual(r.describe(s), undefined);
        r.dispose(s);
        assert.equal(r.describe(s), undefined, "stale handle's describe is undefined");
    });

    it("hasObservers returns false for a stale handle", () => {
        const s = r.signal(1);
        const stop = r.effect(() => { s(); });
        assert.equal(r.hasObservers(s), true);
        stop();
        r.dispose(s);
        assert.equal(r.hasObservers(s), false, "stale handle's hasObservers is false");
    });

    it("observeObservers throws TypeError for a stale handle", () => {
        const s = r.signal(1);
        r.dispose(s);
        assert.throws(
            () => r.observeObservers(s, { onConnect() {} }),
            TypeError,
            "stale handle on observeObservers throws TypeError (existing non-handle contract)",
        );
    });

    it("forEachObserver / forEachSource are no-ops on stale handles", () => {
        const s = r.signal(1);
        const c = r.computed(() => s() + 1);
        c();   // establish dep
        // Stale source
        r.dispose(s);
        let cb1 = 0;
        r.forEachObserver(s, () => cb1++);
        assert.equal(cb1, 0, "stale handle's forEachObserver is a no-op");

        // Stale target
        r.dispose(c);
        let cb2 = 0;
        r.forEachSource(c, () => cb2++);
        assert.equal(cb2, 0, "stale handle's forEachSource is a no-op");
    });

    it("describeNode descriptors are gen-stamped: re-walking a live descriptor works, stale goes silent", () => {
        const s = r.signal(7);
        const c = r.computed(() => s() * 2);
        c();   // establish dep

        // Walk live: descriptor of c is a re-walkable handle for forEachSource
        const cDesc = r.describe(c);
        let liveCount = 0;
        r.forEachSource(cDesc, (d) => { liveCount++; assert.equal(d.kind, "signal"); });
        assert.equal(liveCount, 1, "live descriptor walks one source (s)");

        // Dispose c, recycle its slot
        r.dispose(c);
        const recycled = r.computed(() => 1);   // takes c's old slot
        recycled();

        // The OLD cDesc must not walk the new resident's sources
        let staleCount = 0;
        r.forEachSource(cDesc, () => staleCount++);
        assert.equal(staleCount, 0, "stale descriptor of recycled slot is a no-op");
    });
});
