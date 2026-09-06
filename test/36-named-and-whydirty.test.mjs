// 1.10.0 discriminator: named nodes + whyDirty().
// Run: node --test test/30-named-and-whydirty.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

test("named creation surfaces in describe(); unnamed stays clean", () => {
    const r = createRegistry();
    const named = r.signal(7, { name: "hp" });
    const plain = r.signal(8);
    const c = r.computed(() => named() + 1, { name: "hpPlus" });
    c(); // pull so it is live
    assert.equal(r.describe(named).name, "hp");
    assert.equal(r.describe(c).name, "hpPlus");
    assert.equal(r.describe(plain).name, undefined);
    assert.equal("name" in r.describe(plain), false, "unnamed node must not carry a name key");
    r.destroy();
});

test("named effect creates without throwing; unnamed path untouched", () => {
    const r = createRegistry();
    let seen = 0;
    const s = r.signal(0);
    const stop = r.effect(() => { s(); seen++; }, { name: "watcher" });
    s.set(1);
    assert.ok(seen >= 1);
    stop();
    r.destroy();
});

test("whyDirty is empty for a clean computed and for non-computeds", () => {
    const r = createRegistry();
    const a = r.signal(1, { name: "a" });
    const sum = r.computed(() => a() + 1, { name: "sum" });
    sum(); // clean
    assert.deepEqual(r.whyDirty(sum), []);
    assert.deepEqual(r.whyDirty(a), [], "signal handle -> []");
    r.destroy();
});

test("whyDirty reports ONLY the moved dep (rejected-sketch would report both)", () => {
    const r = createRegistry();
    const a = r.signal(1, { name: "a" });
    const b = r.signal(2, { name: "b" });
    const sum = r.computed(() => a() + b(), { name: "sum" });
    sum(); // pull -> clean; both a,b are deps
    assert.deepEqual(r.whyDirty(sum), []);

    a.set(10); // ONLY a moves
    const w = r.whyDirty(sum);
    const names = w.map((d) => d.name).sort();
    // The bug (`src.version !== src.evalVersion`) reports every written signal
    // -> ["a","b"]. The correct predicate reports only the one past evalVersion.
    assert.deepEqual(names, ["a"], "must be exactly [a], never [a,b]");

    sum(); // re-pull -> clean
    assert.deepEqual(r.whyDirty(sum), []);
    r.destroy();
});

test("whyDirty traces transitively to the root signal write", () => {
    const r = createRegistry();
    const base = r.signal(1, { name: "base" });
    const mid = r.computed(() => base() + 1, { name: "mid" });
    const top = r.computed(() => mid() + 1, { name: "top" });
    top(); // clean

    base.set(5); // mid is now pending but not yet re-pulled (its version has not moved)
    const w = r.whyDirty(top);
    assert.equal(w.length, 1);
    assert.equal(w[0].name, "mid", "direct dep reported");
    assert.ok(w[0].rootCause, "rootCause present when the dep is a pending computed");
    assert.equal(w[0].rootCause.name, "base", "root cause traced to the underlying signal");
    r.destroy();
});

test("whyDirty does not mutate: value unchanged, still dirty after the call", () => {
    const r = createRegistry();
    const a = r.signal(1);
    let runs = 0;
    const c = r.computed(() => { runs++; return a() + 1; });
    c();
    const runsAfterFirst = runs;
    a.set(9);
    r.whyDirty(c);       // must NOT pull/recompute c
    assert.equal(runs, runsAfterFirst, "whyDirty must not trigger a recompute");
    assert.equal(c(), 10, "value still correct once actually pulled");
    assert.equal(runs, runsAfterFirst + 1, "exactly one recompute, from the real pull");
    r.destroy();
});
