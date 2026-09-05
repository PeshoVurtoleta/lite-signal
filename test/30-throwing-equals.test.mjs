// test/30-throwing-equals.test.mjs -- a user `equals` that THROWS (1.6.0-beta)
//
// `equals` is user code the engine calls on the hot write/recompute path. The
// engine does not sandbox it, so a throwing predicate must fail predictably at
// each site that invokes it. This file pins that behaviour so a future change to
// any site is caught deliberately.
//
// SITE AUDIT (1.6.0 Signal.js). There are three LOGICAL equals sites, exercised
// through the CALLABLE signal/computed surface this file drives:
//   (a) signal set pre-check      :1105  eq(node.value, value)
//   (b) batch revert check        :1112  eq(node.preBatchValue, value)
//   (c) computed re-eval          :986   eq(node.value, newValue)
// 1.6.0 ALSO ships signalBox, whose boxSet (Signal.js :1206-1224) mirrors the
// callable set path with its OWN two eq() calls (:1210 pre-check, :1217 revert)
// -- so a raw grep shows five physical eq() invocations, but they collapse to the
// same three logical sites; the signalBox pair is byte-identical in logic to
// (a)/(b). Its two boxSet sites are pinned DIRECTLY below in describe "(box)": a
// throwing pre-check propagates unmutated, and a throwing batch-revert propagates
// the net value with downstream firing -- verified to behave IDENTICALLY to the
// callable path. No behavioral divergence from 1.4.4 was observed on either path
// -- every assertion here holds identically.
//
// Site (b) is DOCUMENTED, not asserted-as-atomic: the throw at :1112 happens
// AFTER node.value was written at :1111 but BEFORE the version bump/revert. We
// pin exactly what the engine does -- value written, version left bumped,
// downstream fires -- so a future move to a truly atomic revert trips this pin
// rather than silently claiming a rollback the engine never provided.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

describe("throwing equals (a): signal set pre-check", () => {
    it("propagates the original error and leaves the signal unmutated", () => {
        const r = createRegistry();
        const boom = new Error("eq-precheck-boom");
        const s = r.signal(1, { equals: () => { throw boom; } });

        let threw = null;
        try { s.set(2); } catch (e) { threw = e; }

        assert.equal(threw, boom, "the pre-check throw must propagate the ORIGINAL error to the caller");
        assert.equal(s.peek(), 1, "the signal must be left unmutated when the pre-check equals throws");
    });

    it("does not fire downstream when the pre-check throws", () => {
        const r = createRegistry();
        const boom = new Error("eq-precheck-boom-2");
        const s = r.signal(1, { equals: () => { throw boom; } });
        let runs = 0;
        const stop = r.effect(() => { s(); runs++; });
        assert.equal(runs, 1, "effect runs once at creation");

        try { s.set(2); } catch { /* expected */ }
        assert.equal(runs, 1, "a pre-check throw must not have marked downstream -- value never changed");
        stop();
    });
});

describe("throwing equals (b): batch revert check", () => {
    // Set X then set back to the original value inside one batch. The revert
    // check at :1112 compares preBatchValue against the value on the SECOND set.
    // We craft equals to throw ONLY on that specific comparison (both operands
    // are the sentinel), so the pre-check at :1105 never throws.
    const POISON = { tag: "poison" };
    const X = { tag: "x" };
    const makeEquals = () => (a, b) => {
        if (a === POISON && b === POISON) throw new Error("eq-revert-boom");
        return Object.is(a, b);
    };

    it("PINNED: throw propagates, value is the net (written) value, downstream fires", () => {
        const r = createRegistry();
        const s = r.signal(POISON, { equals: makeEquals() });
        let runs = 0;
        const seen = [];
        const stop = r.effect(() => { seen.push(s()); runs++; });
        assert.equal(runs, 1, "effect runs once at creation");

        let threw = null;
        try {
            r.batch(() => {
                s.set(X);        // :1112 compares (POISON, X) -> no throw
                s.set(POISON);   // :1112 compares (POISON, POISON) -> throws
            });
        } catch (e) { threw = e; }

        // The throw reaches the batch caller.
        assert.ok(threw instanceof Error && threw.message === "eq-revert-boom",
            "the revert-check throw must propagate out of the batch");
        // node.value was written at :1111 before the throw -- it holds the net value.
        assert.equal(s.peek(), POISON, "PINNED: node.value is the value written at :1111 (the net value)");
        // The version was left BUMPED (revert never completed), so the effect
        // marked by the first set re-runs -- unlike a clean set-X-then-back which
        // the revert would suppress (see the contrast test below).
        assert.equal(runs, 2, "PINNED: downstream fires -- the throw stranded the version bump, defeating the revert");
        assert.equal(seen[seen.length - 1], POISON, "the downstream read observed the net value");
        stop();
    });

    it("CONTRAST: a clean set-X-then-back in a batch suppresses the downstream re-run", () => {
        // Proves the pin above is caused by the throw, not by the set-then-back
        // shape itself: without a throw, the revert works and the effect stays put.
        const r = createRegistry();
        const s = r.signal(0);
        let runs = 0;
        const stop = r.effect(() => { s(); runs++; });
        assert.equal(runs, 1);

        r.batch(() => { s.set(5); s.set(0); });
        assert.equal(runs, 1, "clean set-X-then-back must NOT re-fire downstream (revert suppresses it)");
        assert.equal(s.peek(), 0, "clean revert lands the original value");
        stop();
    });

    it("PINNED: the registry recovers -- a subsequent batch works normally", () => {
        // The stranded revertEpoch from the throwing batch must not corrupt future
        // writes: a fresh batch with a new value propagates correctly.
        const r = createRegistry();
        const s = r.signal(POISON, { equals: makeEquals() });
        let runs = 0;
        const stop = r.effect(() => { s(); runs++; });

        try { r.batch(() => { s.set(X); s.set(POISON); }); } catch { /* expected */ }
        const runsAfterThrow = runs;

        const Y = { tag: "y" };
        let threw2 = null;
        try { r.batch(() => { s.set(Y); }); } catch (e) { threw2 = e; }

        assert.equal(threw2, null, "a batch after the throwing batch must not throw");
        assert.equal(s.peek(), Y, "the recovery write must land");
        assert.equal(runs, runsAfterThrow + 1, "the recovery write must fire downstream exactly once");
        stop();
    });
});

describe("throwing equals (c): computed re-eval", () => {
    // On FIRST eval evalVersion === 0 short-circuits equals, so the throw only
    // occurs on RE-eval. When it throws it is caught at :991, cached as
    // FLAG_HAS_ERROR (:993-995), re-thrown on every read until a dep change
    // re-evaluates successfully and clears the flag.
    const POISON = 999;

    it("caches the re-eval throw and re-throws it until a dep changes", () => {
        const r = createRegistry();
        const boom = new Error("eq-computed-boom");
        const src = r.signal(1);
        const c = r.computed(
            () => src(),
            { equals: (a, b) => { if (b === POISON) throw boom; return Object.is(a, b); } }
        );

        assert.equal(c(), 1, "first read: evalVersion 0, equals not called, value cached");

        src.set(POISON);   // re-eval: equals(1, POISON) throws -> cached as error

        let r1 = null, r2 = null;
        try { c(); } catch (e) { r1 = e; }
        try { c(); } catch (e) { r2 = e; }
        assert.equal(r1, boom, "the cached computed error must be the original error");
        assert.equal(r2, boom, "a repeat read must re-throw the SAME cached error until a dep changes");
    });

    it("clears the cached error once a dep change re-evaluates cleanly", () => {
        const r = createRegistry();
        const boom = new Error("eq-computed-boom-2");
        const src = r.signal(1);
        const c = r.computed(
            () => src(),
            { equals: (a, b) => { if (b === POISON) throw boom; return Object.is(a, b); } }
        );
        c();
        src.set(POISON);
        assert.throws(() => c(), /eq-computed-boom-2/, "poisoned read throws");

        src.set(5);   // clean re-eval: equals(<error>, 5) -> false, no throw
        let cleared = null, threw = null;
        try { cleared = c(); } catch (e) { threw = e; }
        assert.equal(threw, null, "a dep change to a non-poison value must clear the cached error");
        assert.equal(cleared, 5, "after clearing, the computed returns the fresh value");
    });
});

describe("throwing equals (box): signalBox mirrors the callable set sites", () => {
    // signalBox's boxSet (Signal.js :1206-1224) invokes equals at two sites that
    // mirror the callable set path exactly: the pre-check at :1210 (before the
    // value is written -- a throw leaves the box unmutated) and the batch-revert
    // check at :1217 (after node.value is written at :1216 -- a throw strands the
    // version bump so downstream fires). Confirmed on 1.6.0: boxSet behaves
    // IDENTICALLY to read.set; no divergence.

    it("(a-box) set pre-check throw propagates the original error, box unmutated", () => {
        const r = createRegistry();
        const boom = new Error("box-precheck-boom");
        const b = r.signalBox(1, { equals: () => { throw boom; } });

        let threw = null;
        try { b.set(2); } catch (e) { threw = e; }

        assert.equal(threw, boom, "the box pre-check throw must propagate the ORIGINAL error");
        assert.equal(b.peek(), 1, "the box must be left unmutated when the pre-check equals throws");
    });

    it("(b-box) batch revert-check throw propagates, box holds the net value, downstream fires", () => {
        const POISON = { tag: "poison" };
        const X = { tag: "x" };
        const makeEquals = () => (a, bb) => {
            if (a === POISON && bb === POISON) throw new Error("box-revert-boom");
            return Object.is(a, bb);
        };
        const r = createRegistry();
        const b = r.signalBox(POISON, { equals: makeEquals() });
        let runs = 0;
        const seen = [];
        const stop = r.effect(() => { seen.push(b.get()); runs++; });
        assert.equal(runs, 1, "effect runs once at creation");

        let threw = null;
        try {
            r.batch(() => {
                b.set(X);        // :1217 compares (POISON, X) -> no throw
                b.set(POISON);   // :1217 compares (POISON, POISON) -> throws
            });
        } catch (e) { threw = e; }

        assert.ok(threw instanceof Error && threw.message === "box-revert-boom",
            "the box revert-check throw must propagate out of the batch");
        // node.value was written at :1216 before the throw -- it holds the net value.
        assert.equal(b.peek(), POISON, "PINNED: box value is the value written at :1216 (the net value)");
        assert.equal(runs, 2, "PINNED: downstream fires -- the throw stranded the version bump");
        assert.equal(seen[seen.length - 1], POISON, "the downstream read observed the net value");
        stop();
    });
});
