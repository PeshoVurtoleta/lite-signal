// 1.10.0: computed fn(prev) + opts.initial, getOwner/runWithOwner, and a
// pin of the DELIBERATE #179 exclusion (rejection ledger #15): a computed
// that writes its own tracked dep ABSORBS -- predictable 1.x contract,
// unchanged since the mark/absorb design. Strict to 1.10+ for the new
// APIs; the absorption pin holds on every 1.x engine.
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

function hasPrev() {
    // Discriminate on the SECOND run: only the feature passes the previous
    // value; legacy engines call fn() bare, so prev stays undefined forever.
    const r = createRegistry();
    const dep = r.signal(0);
    const c = r.computed((prev) => { dep(); return prev === undefined ? 1 : prev + 1; });
    c(); dep.set(1);
    const v = c(); r.destroy();
    return v === 2;
}
function hasOwner() {
    return typeof createRegistry().getOwner === "function";
}

describe("computed fn(prev) + opts.initial", {skip: !hasPrev() ? "engine predates fn(prev) (rebuilt-line 1.9.1)" : false}, () => {
    it("the body receives its previous value; undefined on an unseeded first run", () => {
        const r = createRegistry();
        const src = r.signal(5);
        const c = r.computed((prev) => (prev === undefined ? 0 : prev) + src());
        assert.equal(c(), 5);
        src.set(3);
        assert.equal(c(), 8, "running sum via prev");
        src.set(2);
        assert.equal(c(), 10);
    });

    it("opts.initial seeds the first run's prev", () => {
        const r = createRegistry();
        const src = r.signal(1);
        const scan = r.computed((prev) => prev + src(), {initial: 100});
        assert.equal(scan(), 101);
        src.set(9);
        assert.equal(scan(), 110);
    });

    it("computedBox gets the same fn(prev) + initial", () => {
        const r = createRegistry();
        const src = r.signal(2);
        const b = r.computedBox((prev) => prev * src(), {initial: 3});
        assert.equal(b.get(), 6);
        src.set(4);
        assert.equal(b.get(), 24);
    });

    it("zero-parameter bodies take the exact pre-1.10 path (no wrapper)", () => {
        const r = createRegistry();
        const src = r.signal(1);
        let sawArgs = -1;
        const c = r.computed(function () { sawArgs = arguments.length; return src() * 2; });
        assert.equal(c(), 2);
        assert.equal(sawArgs, 0, "plain bodies are called with zero arguments, as always");
    });

    it("equality still gates propagation on prev-using computeds", () => {
        const r = createRegistry();
        const src = r.signal(1);
        let topRuns = 0;
        const clamp = r.computed((prev) => Math.min(10, src()), {initial: 0});
        const top = r.computed(() => { topRuns++; return clamp(); });
        assert.equal(top(), 1);
        src.set(50);
        assert.equal(top(), 10);
        assert.equal(topRuns, 2);
        src.set(99);   // clamp recomputes to the SAME 10 -> blocked
        assert.equal(top(), 10);
        assert.equal(topRuns, 2, "equality-blocked as always");
    });
});

describe("getOwner / runWithOwner", {skip: !hasOwner() ? "engine predates owner APIs (rebuilt-line 1.9.2)" : false}, () => {
    it("getOwner returns a live handle inside a scope, undefined at root", () => {
        const r = createRegistry();
        assert.equal(r.getOwner(), undefined);
        let inner = null;
        const stop = r.effect(() => { inner = r.getOwner(); });
        assert.ok(inner !== null && inner !== undefined);
        assert.equal(inner.kind, "effect");
        stop();
    });

    it("runWithOwner adopts created nodes into the chosen scope (async-continuation shape)", () => {
        const r = createRegistry();
        const sig = r.signal(0);
        let owner = null, innerRuns = 0;
        const stop = r.effect(() => { owner = r.getOwner(); });

        // simulate the post-await continuation: no ambient owner here
        r.runWithOwner(owner, () => {
            r.effect(() => { sig(); innerRuns++; });
        });
        sig.set(1);
        assert.equal(innerRuns, 2, "adopted effect is live");

        stop();   // disposing the owner cascades the adopted effect
        sig.set(2);
        assert.equal(innerRuns, 2, "cascade-disposed with the original scope");
    });

    it("runWithOwner does not track reads in fn's direct body", () => {
        const r = createRegistry();
        const noise = r.signal(0);
        let ownerRuns = 0, owner = null;
        const stop = r.effect(() => { ownerRuns++; owner = r.getOwner(); });
        r.runWithOwner(owner, () => { noise(); });   // must not link the owner
        noise.set(1);
        assert.equal(ownerRuns, 1, "direct read created no dependency");
        stop();
    });

    it("a stale owner handle degrades to rooted execution (gen guard)", () => {
        const r = createRegistry({maxNodes: 8, maxLinks: 8, onCapacityExceeded: "grow"});
        const sig = r.signal(0);
        let owner = null, innerRuns = 0;
        const stop = r.effect(() => { owner = r.getOwner(); });
        stop();                                   // owner disposed; handle now stale
        r.effect(() => {});                       // recycle pressure on the slot
        r.runWithOwner(owner, () => {
            r.effect(() => { sig(); innerRuns++; });
        });
        sig.set(1);
        assert.equal(innerRuns, 2, "runs rooted -- created effect is alive and unowned");
        assert.equal(r.getOwner(), undefined);
    });

    it("nested runWithOwner restores the previous owner on exit (throw-safe)", () => {
        const r = createRegistry();
        let outerOwner = null;
        const stop = r.effect(() => {
            outerOwner = r.getOwner();
            assert.throws(() => r.runWithOwner(undefined, () => { throw new Error("x"); }), /x/);
            assert.deepEqual(r.getOwner().id, outerOwner.id, "owner restored after throw");
        });
        stop();
    });
});

describe("computed self-write stays ABSORBED (deliberate -- rejection ledger #15)", () => {
    it("a computed writing its own tracked dep is cached after its run (upstream #179 excluded by design)", () => {
        // The construct is pathological (a value that mutates its own input)
        // and the engine's contract deliberately excludes it: the run's
        // result absorbs, consecutive reads are cached, downstream sees one
        // committed value. Closing upstream #179 was built, measured at
        // +2.7-4.7% frame medians on hot paths, and REJECTED -- ledger #15.
        // This pin exists so the contract can never drift silently.
        const r = createRegistry();
        const s = r.signal(1);
        let runs = 0;
        const c = r.computed(() => { runs++; s.set(s() + 1); return s(); });
        assert.equal(c(), 2);
        assert.equal(s(), 2);
        assert.equal(c(), 2, "cached -- self-writes never re-dirty the writer");
        assert.equal(s(), 2);
        assert.equal(runs, 1);
        const top = r.computed(() => c() * 10);
        assert.equal(top(), 20);
        assert.equal(top(), 20, "derived consumers equally stable");
        assert.equal(runs, 1);
    });
});
