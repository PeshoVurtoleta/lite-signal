// Nested-object & reference-identity behaviours.
//
// Signals use Object.is by default, which means mutating a nested property
// without changing the root object reference is invisible to the reactive
// graph. These tests pin down the resulting patterns: when an update fires,
// when it doesn't, and what to reach for when you need structural equality
// or fine-grained nested reactivity.
//
// The contract is intentionally identity-based — it's predictable, O(1),
// and matches every other signals library. The trade-off lands on the user:
// either replace references immutably, or supply a custom `equals` predicate.
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

// ─── Array mutations ─────────────────────────────────────────────────────────

describe("arrays in signals", () => {
    it("push() on the same array reference does NOT notify", () => {
        const list = r.signal([1, 2, 3]);
        let runs = 0;
        r.effect(() => { runs++; list(); });
        const arr = list.peek();
        arr.push(4);
        list.set(arr); // same reference
        assert.equal(runs, 1, "Object.is(arr, arr) is true → no notify");
    });

    it("spreading into a new array notifies", () => {
        const list = r.signal([1, 2, 3]);
        let runs = 0;
        r.effect(() => { runs++; list(); });
        list.set([...list.peek(), 4]);
        assert.equal(runs, 2);
        assert.deepEqual(list(), [1, 2, 3, 4]);
    });

    it("splice() on the same reference does NOT notify", () => {
        const list = r.signal(["a", "b", "c"]);
        let runs = 0;
        r.effect(() => { runs++; list(); });
        const arr = list.peek();
        arr.splice(1, 1);
        list.set(arr);
        assert.equal(runs, 1);
    });

    it("filter/map/slice produce new references and notify", () => {
        const list = r.signal([1, 2, 3, 4]);
        let lastLen = 0;
        r.effect(() => { lastLen = list().length; });
        list.set(list.peek().filter(n => n % 2 === 0));
        assert.equal(lastLen, 2);
        list.set(list.peek().map(n => n * 10));
        assert.deepEqual(list(), [20, 40]);
    });

    it("custom equality can compare arrays element-wise", () => {
        const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
        const list = r.signal([1, 2, 3], {equals: eq});
        let runs = 0;
        r.effect(() => { runs++; list(); });
        list.set([1, 2, 3]); // new reference, same content → suppressed
        assert.equal(runs, 1);
        list.set([1, 2, 4]); // different content → fires
        assert.equal(runs, 2);
    });
});

// ─── Deeply nested paths ─────────────────────────────────────────────────────

describe("deep nested paths", () => {
    it("a single object replacement re-runs every effect that read a nested path", () => {
        const state = r.signal({user: {profile: {name: "Alice", age: 30}}, theme: "dark"});
        let nameRuns = 0, ageRuns = 0, themeRuns = 0;
        r.effect(() => { nameRuns++; state().user.profile.name; });
        r.effect(() => { ageRuns++; state().user.profile.age; });
        r.effect(() => { themeRuns++; state().theme; });

        // Replace the root object — all three effects re-run (they all read state()).
        state.set({...state.peek(), theme: "light"});
        assert.equal(nameRuns, 2);
        assert.equal(ageRuns, 2);
        assert.equal(themeRuns, 2);
    });

    it("computed memoisation cuts off downstream effects when the projected slice is unchanged", () => {
        const state = r.signal({user: {name: "Alice", age: 30}, count: 0});
        const name = r.computed(() => state().user.name);
        let effectRuns = 0;
        r.effect(() => { effectRuns++; name(); });
        assert.equal(effectRuns, 1);

        // Replacing the root object with a different `count` does not change
        // the projected `name` — the computed's equality (Object.is on a string)
        // suppresses downstream notification.
        state.set({...state.peek(), count: 1});
        assert.equal(effectRuns, 1, "computed equality cutoff should suppress downstream");

        state.set({...state.peek(), user: {...state.peek().user, name: "Bob"}});
        assert.equal(effectRuns, 2);
    });

    it("multiple computeds derive disjoint slices independently", () => {
        const state = r.signal({x: 1, y: 1, z: 1});
        const sumXY = r.computed(() => state().x + state().y);
        const z = r.computed(() => state().z);
        let xyRuns = 0, zRuns = 0;
        r.effect(() => { xyRuns++; sumXY(); });
        r.effect(() => { zRuns++; z(); });

        state.set({...state.peek(), z: 99});
        assert.equal(xyRuns, 1, "sumXY unchanged → no re-run");
        assert.equal(zRuns, 2);
    });
});

// ─── Map / Set ───────────────────────────────────────────────────────────────

describe("Map and Set in signals", () => {
    it("Map.set() on the same Map reference does NOT notify", () => {
        const cache = r.signal(new Map([["a", 1]]));
        let runs = 0;
        r.effect(() => { runs++; cache(); });
        const m = cache.peek();
        m.set("b", 2);
        cache.set(m);
        assert.equal(runs, 1);
    });

    it("constructing a fresh Map notifies", () => {
        const cache = r.signal(new Map([["a", 1]]));
        let runs = 0;
        r.effect(() => { runs++; cache(); });
        cache.set(new Map([...cache.peek(), ["b", 2]]));
        assert.equal(runs, 2);
        assert.equal(cache().get("b"), 2);
    });

    it("custom equality compares Sets by size and membership", () => {
        const eq = (a, b) => a.size === b.size && [...a].every(v => b.has(v));
        const tags = r.signal(new Set(["red", "blue"]), {equals: eq});
        let runs = 0;
        r.effect(() => { runs++; tags(); });
        tags.set(new Set(["blue", "red"])); // same content, different reference
        assert.equal(runs, 1);
        tags.set(new Set(["blue", "red", "green"]));
        assert.equal(runs, 2);
    });
});

// ─── Date ────────────────────────────────────────────────────────────────────

describe("Date in signals", () => {
    it("mutating a Date in place does NOT notify", () => {
        const ts = r.signal(new Date(2026, 0, 1));
        let runs = 0;
        r.effect(() => { runs++; ts(); });
        const d = ts.peek();
        d.setHours(12);
        ts.set(d);
        assert.equal(runs, 1);
    });

    it("custom equality on getTime() compares Dates by value", () => {
        const eq = (a, b) => a.getTime() === b.getTime();
        const ts = r.signal(new Date(2026, 0, 1), {equals: eq});
        let runs = 0;
        r.effect(() => { runs++; ts(); });
        ts.set(new Date(2026, 0, 1));   // same instant, new reference → suppressed
        assert.equal(runs, 1);
        ts.set(new Date(2026, 0, 2));
        assert.equal(runs, 2);
    });
});

// ─── update() helper ─────────────────────────────────────────────────────────

describe("update() with nested state", () => {
    it("immutable functional update fires", () => {
        const state = r.signal({count: 0, label: "x"});
        let runs = 0;
        r.effect(() => { runs++; state(); });
        state.update(s => ({...s, count: s.count + 1}));
        assert.equal(state().count, 1);
        assert.equal(runs, 2);
    });

    it("update() returning the same reference (in-place mutation) does NOT fire", () => {
        const state = r.signal({count: 0});
        let runs = 0;
        r.effect(() => { runs++; state(); });
        state.update(s => { s.count++; return s; });  // mutates and returns same ref
        assert.equal(state().count, 1, "value did mutate");
        assert.equal(runs, 1, "but no notify, since Object.is(s, s) is true");
    });
});

// ─── Computed returning objects ──────────────────────────────────────────────

describe("computed returning objects", () => {
    it("by default a fresh object each time means downstream always re-runs", () => {
        const src = r.signal(1);
        const obj = r.computed(() => ({value: src() * 2}));   // new {} every run
        let runs = 0;
        r.effect(() => { runs++; obj(); });
        assert.equal(runs, 1);
        src.set(1);   // src unchanged → no recompute → no re-run
        assert.equal(runs, 1);
        src.set(2);
        assert.equal(runs, 2);
        // Even when src changes by an amount that keeps obj structurally the same,
        // Object.is on the fresh object is false → effect re-runs:
        src.set(2);   // unchanged src → no recompute
        assert.equal(runs, 2);
    });

    it("custom equality on a computed suppresses notification when structural value is unchanged", () => {
        const eq = (a, b) => a.value === b.value;
        const src = r.signal(1);
        const obj = r.computed(() => ({value: src() % 2}), {equals: eq});
        let runs = 0;
        r.effect(() => { runs++; obj(); });
        assert.equal(runs, 1);

        // src changes but `src % 2` lands on the same value — projected obj
        // is structurally equal → downstream effect should not re-run.
        src.set(3);
        assert.equal(runs, 1);

        src.set(2);
        assert.equal(runs, 2);
    });
});

// ─── Frozen / sealed objects ─────────────────────────────────────────────────

describe("frozen objects", () => {
    it("Object.freeze() on the value doesn't break the signal", () => {
        const state = r.signal(Object.freeze({count: 0}));
        let last;
        r.effect(() => { last = state(); });
        state.set(Object.freeze({count: 1}));
        assert.equal(last.count, 1);
        assert.equal(Object.isFrozen(last), true);
    });
});

// ─── Signal-of-signals pattern ───────────────────────────────────────────────

describe("nested-signal composition", () => {
    it("an outer object holding inner signals tracks the inner signals independently", () => {
        // Pattern: each leaf is its own signal; the outer object is just a bag.
        // Reading an inner signal inside an effect should track only that inner.
        const player = {
            x: r.signal(0),
            y: r.signal(0),
            hp: r.signal(100)
        };
        let xRuns = 0, hpRuns = 0;
        r.effect(() => { xRuns++; player.x(); });
        r.effect(() => { hpRuns++; player.hp(); });

        player.x.set(10);
        assert.equal(xRuns, 2);
        assert.equal(hpRuns, 1, "writing x must not touch effects that read only hp");

        player.hp.set(50);
        assert.equal(xRuns, 2);
        assert.equal(hpRuns, 2);
    });

    it("a computed can fan in over several inner signals to project a derived view", () => {
        const player = {x: r.signal(0), y: r.signal(0)};
        const distance = r.computed(() => Math.hypot(player.x(), player.y()));
        let runs = 0;
        r.effect(() => { runs++; distance(); });

        r.batch(() => { player.x.set(3); player.y.set(4); });
        assert.equal(distance(), 5);
        assert.equal(runs, 2, "batched two writes → one re-run");
    });
});

// ─── High-frequency object updates ───────────────────────────────────────────

describe("high-frequency object updates", () => {
    it("100 sequential immutable updates produce 100 effect runs (no drops)", () => {
        const state = r.signal({n: 0});
        let runs = 0, lastSeen = -1;
        r.effect(() => { runs++; lastSeen = state().n; });
        for (let i = 1; i <= 100; i++) state.set({n: i});
        assert.equal(runs, 101);
        assert.equal(lastSeen, 100);
    });

    it("100 immutable updates inside a batch produce exactly one effect run", () => {
        const state = r.signal({n: 0});
        let runs = 0, lastSeen = -1;
        r.effect(() => { runs++; lastSeen = state().n; });
        r.batch(() => { for (let i = 1; i <= 100; i++) state.set({n: i}); });
        assert.equal(runs, 2, "initial + one flush");
        assert.equal(lastSeen, 100);
    });
});

// ─── Common foot-gun: derived array vs derived element ──────────────────────

describe("derived selectors over collections", () => {
    it("a computed selecting one item by id re-runs only when that item or the list shape changes", () => {
        const items = r.signal([
            {id: 1, name: "alice", score: 10},
            {id: 2, name: "bob",   score: 20},
        ]);
        const aliceScore = r.computed(() => items().find(i => i.id === 1)?.score);
        let runs = 0, lastScore;
        r.effect(() => { runs++; lastScore = aliceScore(); });
        assert.equal(lastScore, 10);

        // Replace alice immutably — different selected value → re-run
        items.set(items.peek().map(i => i.id === 1 ? {...i, score: 99} : i));
        assert.equal(lastScore, 99);
        assert.equal(runs, 2);

        // Replace bob immutably — alice unchanged → no downstream re-run thanks
        // to computed equality cutoff.
        items.set(items.peek().map(i => i.id === 2 ? {...i, score: 21} : i));
        assert.equal(runs, 2, "computed equality should suppress");
    });

    it("indexing by position keeps the same identity even when other items change", () => {
        const items = r.signal([{v: 1}, {v: 2}, {v: 3}]);
        const second = r.computed(() => items()[1]);
        let runs = 0;
        r.effect(() => { runs++; second(); });

        // Replace items[0] with a fresh reference — items[1] is the SAME
        // object reference, so the computed result is Object.is-equal and
        // the downstream effect does not re-run.
        const arr = items.peek();
        items.set([{v: 99}, arr[1], arr[2]]);
        assert.equal(runs, 1);

        // Replace items[1] with a fresh object — different reference → re-run.
        items.set([items.peek()[0], {v: 200}, items.peek()[2]]);
        assert.equal(runs, 2);
    });
});
