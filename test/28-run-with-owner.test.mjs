// getOwner / runWithOwner (1.5.0-beta.2). Companion primitives to
// createRoot: capture the current lifecycle scope, restore it later
// (typically across an async boundary). Handles are gen-stamped so they
// degrade cleanly to rooted execution when the captured owner has died --
// which is the normal case across async gaps, since the LIFO free list
// recycles disposed nodes' slots into whatever effect/computed is allocated
// next. The two hazards that a naive raw-pointer implementation exhibits
// are pinned here directly (recycled-slot cascade death and corpse
// adoption): they are the failure modes the ABA guard exists to prevent,
// and the tests must include allocation pressure or they won't cover them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

// -------------------------------------------------------------------------
// Basic shape
// -------------------------------------------------------------------------

test("getOwner returns undefined outside any effect/computed", () => {
    const r = createRegistry();
    assert.equal(r.getOwner(), undefined);
});

test("getOwner returns a descriptor for the current effect inside its body", () => {
    const r = createRegistry();
    let captured;
    let capturedId;
    r.effect(() => {
        captured = r.getOwner();
        capturedId = captured && captured.id;
    });
    assert.notEqual(captured, undefined);
    assert.equal(captured.kind, "effect");
    assert.equal(typeof capturedId, "number");
});

test("getOwner returns a descriptor for the current computed inside its body", () => {
    const r = createRegistry();
    let captured;
    const c = r.computed(() => { captured = r.getOwner(); return 1; });
    c();
    assert.notEqual(captured, undefined);
    assert.equal(captured.kind, "computed");
});

test("getOwner returns undefined again after the effect finishes", () => {
    const r = createRegistry();
    r.effect(() => { r.getOwner(); });
    assert.equal(r.getOwner(), undefined);
});

// -------------------------------------------------------------------------
// runWithOwner: adoption + tracking-null semantics
// -------------------------------------------------------------------------

test("runWithOwner adopts a nested effect into the captured owner", () => {
    const r = createRegistry();
    const sig = r.signal(0);
    let owner;
    let inner = 0;
    const outer = r.effect(() => { owner = r.getOwner(); });
    // Create the inner effect OUTSIDE the outer, but adopted under it.
    r.runWithOwner(owner, () => {
        r.effect(() => { sig(); inner++; });
    });
    // 1 inner run from initial fire.
    assert.equal(inner, 1);
    sig.set(1);
    assert.equal(inner, 2);
    // Disposing the outer cascade-disposes the inner via the owner tree.
    outer();
    sig.set(2);
    assert.equal(inner, 2, "cascade-dispose should have killed inner");
});

test("runWithOwner nulls the tracking observer (reads in fn body do not link)", () => {
    const r = createRegistry();
    const sig = r.signal(0);
    let owner;
    let outerRuns = 0;
    const outer = r.effect(() => {
        owner = r.getOwner();
        outerRuns++;
    });
    // sig is NOT read inside outer's body; outer runs once initially.
    assert.equal(outerRuns, 1);
    // Reading sig directly inside runWithOwner must not link it to outer.
    r.runWithOwner(owner, () => { sig(); });
    sig.set(1);
    assert.equal(outerRuns, 1, "outer must not have re-run: the direct read inside runWithOwner should not link");
    outer();
});

test("runWithOwner returns whatever fn returns", () => {
    const r = createRegistry();
    let owner;
    r.effect(() => { owner = r.getOwner(); });
    assert.equal(r.runWithOwner(owner, () => 42), 42);
    const obj = {};
    assert.equal(r.runWithOwner(owner, () => obj), obj);
});

test("runWithOwner restores previous owner/observer/tracking on return", () => {
    const r = createRegistry();
    let a, b;
    r.effect(() => {
        a = r.getOwner();
        r.runWithOwner(a, () => { /* inner scope */ });
        b = r.getOwner();
    });
    // After runWithOwner returns, we're back in the outer effect body.
    assert.equal(a.id, b.id, "owner must be restored after runWithOwner");
});

test("runWithOwner restores state even when fn throws", () => {
    const r = createRegistry();
    let owner, after;
    r.effect(() => {
        owner = r.getOwner();
        try {
            r.runWithOwner(owner, () => { throw new Error("boom"); });
        } catch (_) { /* swallow */ }
        after = r.getOwner();
    });
    assert.equal(owner.id, after.id, "owner must be restored even on throw");
});

test("nested runWithOwner: inner switches to b, outer unwinds to a", () => {
    const r = createRegistry();
    let a, b, insideNested, afterNested;
    const outer1 = r.effect(() => { a = r.getOwner(); });
    const outer2 = r.effect(() => { b = r.getOwner(); });
    r.runWithOwner(a, () => {
        r.runWithOwner(b, () => { insideNested = r.getOwner(); });
        afterNested = r.getOwner();
    });
    assert.equal(insideNested.id, b.id);
    assert.equal(afterNested.id, a.id);
    outer1(); outer2();
});

// -------------------------------------------------------------------------
// Degradation: null/undefined/stale/signal-handle -> rooted execution
// -------------------------------------------------------------------------

test("runWithOwner(null) runs rooted -- created effect survives after fn returns", () => {
    const r = createRegistry();
    const sig = r.signal(0);
    let n = 0;
    let dispose;
    r.runWithOwner(null, () => {
        dispose = r.effect(() => { sig(); n++; });
    });
    assert.equal(n, 1);
    sig.set(1);
    assert.equal(n, 2, "rooted effect must fire on updates");
    dispose();
    sig.set(2);
    assert.equal(n, 2);
});

test("runWithOwner(undefined) runs rooted", () => {
    const r = createRegistry();
    const sig = r.signal(0);
    let n = 0;
    r.runWithOwner(undefined, () => { r.effect(() => { sig(); n++; }); });
    sig.set(1);
    assert.equal(n, 2);
});

test("runWithOwner(signalHandle) runs rooted (signals cannot own)", () => {
    const r = createRegistry();
    const sig = r.signal(0);
    const sigDescriptor = r.describe(sig);
    let n = 0;
    r.runWithOwner(sigDescriptor, () => { r.effect(() => { sig(); n++; }); });
    // If the effect were adopted by the signal (impossible), no cascade
    // would kill it. Rooted, so we just verify it works normally.
    sig.set(1);
    assert.equal(n, 2);
});

// -------------------------------------------------------------------------
// THE HAZARDS -- the reason this feature ships gen-stamped
// -------------------------------------------------------------------------

test("HAZARD 1: recycled-slot cascade -- stale handle does NOT adopt into the recycled slot's new resident", () => {
    // The pool is LIFO: the next effect created after owner A's disposal
    // reuses A's slot. A raw-pointer runWithOwner would silently adopt the
    // continuation into that stranger (effect B), whose disposal would then
    // take the continuation with it. The ABA guard on the handle catches
    // this: the captured handle's gen no longer matches B's gen.
    const r = createRegistry({ maxNodes: 8, maxLinks: 32, onCapacityExceeded: "grow" });
    const sig = r.signal(0);

    let captured;
    const stopA = r.effect(() => { captured = r.getOwner(); });   // owner A
    stopA();                                                       // A dies

    // B pops A's slot (LIFO free list).
    let strangerRuns = 0;
    const stopB = r.effect(() => { sig(); strangerRuns++; });

    // Continuation via the stale capture: MUST NOT adopt into B.
    let innerRuns = 0;
    r.runWithOwner(captured, () => {
        r.effect(() => { sig(); innerRuns++; });
    });
    sig.set(1);
    assert.equal(innerRuns, 2, "continuation must run on the update");

    // Disposing the UNRELATED stranger must NOT take the continuation.
    stopB();
    sig.set(2);
    assert.equal(innerRuns, 3, "continuation must survive stranger B's disposal (proves it was rooted, not adopted into B)");
});

test("HAZARD 2: corpse adoption -- adopting into a dead-but-unrecycled owner does NOT crash the engine", () => {
    // A naive raw-pointer runWithOwner over a disposed-but-not-recycled
    // owner splices a child into a corpse's firstOwned. The next disposal
    // cascade then walks the corpse's owner chain and recurses without
    // termination -> RangeError: Maximum call stack size exceeded.
    // The gen guard rejects the corpse handle (its gen was bumped on
    // disposal) and the continuation runs rooted.
    const r = createRegistry();
    const sig = r.signal(0);

    let captured;
    const stop = r.effect(() => { captured = r.getOwner(); });
    stop();  // dead, slot not yet recycled

    let runs = 0;
    // Must not throw.
    assert.doesNotThrow(() => {
        r.runWithOwner(captured, () => {
            r.effect(() => { sig(); runs++; });
        });
    });
    assert.equal(runs, 1);
    sig.set(1);
    assert.equal(runs, 2, "continuation must run rooted, not owned by a corpse");
});

test("HAZARD 3: capture, dispose owner, allocate a stranger, THEN runWithOwner: continuation is rooted and survives everything", () => {
    // Composition of hazards 1 and 2: the classic async-gap pattern
    // (capture during an effect, await, capture is stale by then). The
    // reason this test is separate: it explicitly asserts that neither
    // the stranger's re-run nor its disposal touches the continuation.
    const r = createRegistry();
    const sig = r.signal(0);

    let captured;
    const stopA = r.effect(() => { captured = r.getOwner(); });
    stopA();

    // Force the slot to be recycled.
    let strangerRuns = 0;
    const stopStranger = r.effect(() => { sig(); strangerRuns++; });

    let contRuns = 0;
    r.runWithOwner(captured, () => {
        r.effect(() => { sig(); contRuns++; });
    });

    // Both fire on the write.
    sig.set(1);
    assert.equal(strangerRuns, 2);
    assert.equal(contRuns, 2);

    // Force the stranger to re-run several times; continuation must not
    // be cascade-disposed by the stranger's re-execution.
    sig.set(2); sig.set(3);
    assert.equal(contRuns, 4);

    // Disposing the stranger must not take the continuation.
    stopStranger();
    sig.set(4);
    assert.equal(contRuns, 5, "continuation must still be firing after the stranger is disposed");
});
