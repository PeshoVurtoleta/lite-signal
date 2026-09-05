// isTracking(): observer-context predicate for lazy-allocation wrappers.
//
// Returns true iff a read RIGHT NOW would record a dependency on this
// registry. Mirrors the engine's own read-trap check
// (`isTrackingDeps && currentObserver !== null`) so callers stay in
// lockstep with what the engine actually does — not just whether an
// observer body is on the stack.
//
// Use case: wrappers like lite-store / lite-query / lite-form that want
// to allocate reactive primitives lazily on property reads. Without this
// predicate, the wrapper must always allocate (defeats zero-GC) or probe
// engine internals (fragile coupling).
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {
    createRegistry,
    isTracking as topLevelIsTracking,
    effect as topLevelEffect,
} from "../Signal.js";
import {watch} from "../Watch.js";

let r;
beforeEach(() => { r = createRegistry(); });

// ─── observer bodies: true ─────────────────────────────────────────────────

describe("registry.isTracking() — true inside observer bodies", () => {
    it("returns true inside an effect body", () => {
        let inside;
        const stop = r.effect(() => { inside = r.isTracking(); });
        assert.equal(inside, true);
        stop();
    });

    it("returns true inside a computed body when forced by a tracked read", () => {
        // Computeds are lazy; an outer effect pulls the computed and that
        // pull sets currentObserver = the computed during its body.
        let inside;
        const c = r.computed(() => { inside = r.isTracking(); return 0; });
        const stop = r.effect(() => { c(); });
        assert.equal(inside, true);
        stop();
    });
});

// ─── untracked windows inside an observer: false ───────────────────────────

describe("registry.isTracking() — false in untracked windows", () => {
    it("returns false inside untrack()", () => {
        // The case that catches an observer-only misimplementation: untrack
        // clears isTrackingDeps but leaves currentObserver set, so a
        // currentObserver-only predicate would false-positive here.
        let inside = true;
        const stop = r.effect(() => { r.untrack(() => { inside = r.isTracking(); }); });
        assert.equal(inside, false);
        stop();
    });

    it("returns false inside signal.subscribe's callback", () => {
        // subscribe inlines the same untracked-notify pattern as untrack().
        let inside = true;
        const s = r.signal(0);
        const stop = s.subscribe(() => { inside = r.isTracking(); });
        assert.equal(inside, false);              // immediate fire
        s.set(1);
        assert.equal(inside, false);              // and on subsequent fires
        stop();
    });

    it("returns false inside an onCleanup body", () => {
        // runCleanup clears BOTH currentObserver and isTrackingDeps; this
        // test pins the runCleanup contract against a future refactor that
        // drops the cleanup-time clearing.
        let inside = true;
        const stop = r.effect(() => { r.onCleanup(() => { inside = r.isTracking(); }); });
        stop();
        assert.equal(inside, false);
    });

    it("returns false inside a watch() callback", () => {
        // watch() internally creates an effect and runs the user callback
        // through untrack — same contract as subscribe but the code path
        // lives in Watch.js, so it could regress independently.
        let inside = true;
        const s = r.signal(0);
        // watch is module-level, defaults to the default registry; bind to r
        // via the same engine module (single-instance guarantee from packaging).
        const stop = watch(s, () => { inside = r.isTracking(); }, { immediate: true });
        assert.equal(inside, false);
        stop();
    });
});

// ─── outside any observer: false ────────────────────────────────────────────

describe("registry.isTracking() — false outside any observer context", () => {
    it("returns false at module scope", () => {
        assert.equal(r.isTracking(), false);
    });

    it("returns false at the call site of an unobserved computed read", () => {
        // During pullComputed, currentObserver is briefly set to the
        // computed node — but only *inside* the body. From the caller's
        // perspective, isTracking() at the call site is still false.
        const c = r.computed(() => 1);
        c();
        assert.equal(r.isTracking(), false);
    });
});

// ─── robustness ─────────────────────────────────────────────────────────────

describe("registry.isTracking() — robustness", () => {
    it("returns false in the catch after an observer body throws", () => {
        // Regression: a thrown effect body must leave tracking state restored
        // (try/finally in executeEffect) so the outer caller's isTracking()
        // is not stuck at true.
        assert.throws(() => r.effect(() => { throw new Error("boom"); }));
        assert.equal(r.isTracking(), false);
    });

    it("is per-registry — registry B is false inside registry A's effect", () => {
        // The case that matters for lite-store: a wrapper must call THAT
        // registry's isTracking(), not the top-level one. An app using a
        // custom registry would silently miss tracking contexts otherwise.
        const r2 = createRegistry();
        let seen;
        const stop = r.effect(() => { seen = r2.isTracking(); });
        assert.equal(seen, false);
        stop();
    });
});

// ─── top-level binding ──────────────────────────────────────────────────────

describe("top-level isTracking()", () => {
    it("binds to the default registry — true inside a top-level effect", () => {
        // Confirms the module-level export delegates correctly. The
        // top-level helpers (signal/computed/effect) all operate against
        // the default registry; isTracking() must follow the same pattern.
        let inside;
        const stop = topLevelEffect(() => { inside = topLevelIsTracking(); });
        assert.equal(inside, true);
        stop();
    });
});
