// Core signal / computed / effect behaviours.
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("signal", () => {
    it("returns initial value", () => {
        const s = r.signal(42);
        assert.equal(s(), 42);
    });

    it("set() updates the value", () => {
        const s = r.signal(0);
        s.set(10);
        assert.equal(s(), 10);
    });

    it("peek() returns value without tracking", () => {
        const s = r.signal(7);
        let runs = 0;
        r.effect(() => { runs++; s.peek(); });
        s.set(8);
        assert.equal(runs, 1, "peek must not establish a dependency");
    });

    it("update() applies fn(current)", () => {
        const s = r.signal(5);
        s.update(v => v + 3);
        assert.equal(s(), 8);
    });

    it("set() is a no-op when value is unchanged under Object.is", () => {
        const s = r.signal(1);
        let runs = 0;
        r.effect(() => { runs++; s(); });
        assert.equal(runs, 1);
        s.set(1);
        assert.equal(runs, 1, "equal write must not trigger effects");
    });

    it("respects custom equality predicate", () => {
        const eq = (a, b) => a.id === b.id;
        const s = r.signal({id: 1, name: "a"}, {equals: eq});
        let runs = 0;
        r.effect(() => { runs++; s(); });
        s.set({id: 1, name: "b"});                  // same id → no notification
        assert.equal(runs, 1);
        s.set({id: 2, name: "b"});                  // different id → notify
        assert.equal(runs, 2);
    });

    it("NaN === NaN under Object.is is true", () => {
        const s = r.signal(NaN);
        let runs = 0;
        r.effect(() => { runs++; s(); });
        s.set(NaN);
        assert.equal(runs, 1, "Object.is(NaN, NaN) is true → no re-run");
    });

    it("+0 vs -0 differ under Object.is", () => {
        const s = r.signal(+0);
        let runs = 0;
        r.effect(() => { runs++; s(); });
        s.set(-0);
        assert.equal(runs, 2, "Object.is(+0, -0) is false → re-run");
    });

    it("subscribe() fires with initial value", () => {
        const s = r.signal("hello");
        const seen = [];
        const off = s.subscribe(v => seen.push(v));
        s.set("world");
        s.set("!");
        off();
        s.set("ignored");
        assert.deepEqual(seen, ["hello", "world", "!"]);
    });
});

describe("computed", () => {
    it("derives from a signal", () => {
        const a = r.signal(2);
        const b = r.computed(() => a() * 3);
        assert.equal(b(), 6);
        a.set(4);
        assert.equal(b(), 12);
    });

    it("is lazy: compute body does not run until read", () => {
        const a = r.signal(1);
        let runs = 0;
        const b = r.computed(() => { runs++; return a() + 1; });
        assert.equal(runs, 0, "no read → no run");
        b();
        assert.equal(runs, 1);
    });

    it("is memoised: repeated reads do not re-run", () => {
        const a = r.signal(1);
        let runs = 0;
        const b = r.computed(() => { runs++; return a() + 1; });
        b(); b(); b();
        assert.equal(runs, 1);
        a.set(2);
        b();
        assert.equal(runs, 2);
    });

    it("propagates equality cutoff: downstream effect does not re-run when value is unchanged", () => {
        const a = r.signal(1);
        const b = r.computed(() => a() % 2); // 1 → 1 stays 1 from 1,3,5
        let eRuns = 0;
        r.effect(() => { eRuns++; b(); });
        assert.equal(eRuns, 1);
        a.set(3);    // b is still 1 (1 % 2 === 1)
        assert.equal(eRuns, 1, "equal computed result → effect should not re-run");
        a.set(2);    // b becomes 0
        assert.equal(eRuns, 2);
    });

    it("supports computed-of-computed", () => {
        const a = r.signal(2);
        const b = r.computed(() => a() + 1);
        const c = r.computed(() => b() * 2);
        assert.equal(c(), 6);
        a.set(5);
        assert.equal(c(), 12);
    });

    it("captures and rethrows errors; recovers on dep change", () => {
        const a = r.signal(0);
        const b = r.computed(() => {
            if (a() === 0) throw new Error("nope");
            return a() * 2;
        });
        assert.throws(() => b(), /nope/);
        assert.throws(() => b(), /nope/, "cached error read must re-throw");
        a.set(3);
        assert.equal(b(), 6);
    });

    it("rethrows errors that occurred in this propagation cycle", () => {
        const a = r.signal(1);
        const b = r.computed(() => {
            if (a() === 0) throw new RangeError("zero");
            return a();
        });
        assert.equal(b(), 1);
        a.set(0);
        assert.throws(() => b(), RangeError);
    });

    it("detects direct cycle", () => {
        let self;
        const c = r.computed(() => self());
        self = c;
        assert.throws(() => c(), /CycleError/);
    });
});

describe("effect", () => {
    it("runs once on creation", () => {
        let runs = 0;
        r.effect(() => { runs++; });
        assert.equal(runs, 1);
    });

    it("re-runs when a tracked signal changes", () => {
        const s = r.signal(0);
        let last = -1;
        r.effect(() => { last = s(); });
        s.set(5);
        assert.equal(last, 5);
        s.set(7);
        assert.equal(last, 7);
    });

    it("dispose() stops further re-runs", () => {
        const s = r.signal(0);
        let runs = 0;
        const dispose = r.effect(() => { runs++; s(); });
        s.set(1);
        assert.equal(runs, 2);
        dispose();
        s.set(2);
        assert.equal(runs, 2);
    });

    it("dispose() is idempotent", () => {
        const s = r.signal(0);
        const dispose = r.effect(() => s());
        dispose();
        dispose();
        dispose();
        // Should not throw, and stats should reflect a single dispose.
        assert.equal(r.stats().effects, 0);
    });

    it("runs cleanup before re-execution", () => {
        const s = r.signal(0);
        const trace = [];
        r.effect(() => {
            const v = s();
            trace.push(`run:${v}`);
            r.onCleanup(() => trace.push(`clean:${v}`));
        });
        s.set(1);
        s.set(2);
        assert.deepEqual(trace, ["run:0", "clean:0", "run:1", "clean:1", "run:2"]);
    });

    it("runs cleanup on dispose", () => {
        const trace = [];
        const dispose = r.effect(() => {
            r.onCleanup(() => trace.push("cleaned"));
        });
        dispose();
        assert.deepEqual(trace, ["cleaned"]);
    });

    it("supports multiple cleanups per run", () => {
        const trace = [];
        const dispose = r.effect(() => {
            r.onCleanup(() => trace.push("a"));
            r.onCleanup(() => trace.push("b"));
            r.onCleanup(() => trace.push("c"));
        });
        dispose();
        assert.deepEqual(trace, ["a", "b", "c"]);
    });

    it("does not re-run if a dependency notifies but its value is equal", () => {
        const s = r.signal({n: 1}, {equals: (a, b) => a.n === b.n});
        let runs = 0;
        r.effect(() => { runs++; s(); });
        s.set({n: 1});
        assert.equal(runs, 1);
    });

    it("ignores writes inside its own body unless they actually change a tracked dep", () => {
        const a = r.signal(0);
        let runs = 0;
        r.effect(() => {
            runs++;
            // Read first
            const v = a();
            // Self-update outside the dep set, but value won't change because equality
            if (v < 3) a.set(v); // same value, equality short-circuits
        });
        assert.equal(runs, 1);
    });

    it("first-run error disposes the effect node", () => {
        const before = r.stats().effects;
        assert.throws(() => {
            r.effect(() => { throw new Error("boom"); });
        }, /boom/);
        assert.equal(r.stats().effects, before, "errored effect should not increment effect count");
    });
});

describe("batch", () => {
    it("coalesces multiple writes into a single flush", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let runs = 0;
        r.effect(() => { runs++; a(); b(); });
        assert.equal(runs, 1);

        r.batch(() => {
            a.set(1);
            b.set(2);
        });
        assert.equal(runs, 2, "two writes in a batch → one re-run");
    });

    it("returns the inner function's value", () => {
        const out = r.batch(() => 42);
        assert.equal(out, 42);
    });

    it("nested batches flush at the outermost boundary", () => {
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { runs++; s(); });
        r.batch(() => {
            r.batch(() => { s.set(1); });
            assert.equal(runs, 1, "inner batch must not flush");
            s.set(2);
        });
        assert.equal(runs, 2, "outer flush sees only the final value");
    });

    it("flushes on error from inside the batch", () => {
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { runs++; s(); });
        assert.throws(() => {
            r.batch(() => {
                s.set(1);
                throw new Error("kaboom");
            });
        }, /kaboom/);
        assert.equal(runs, 2, "writes before throw must still flush");
    });
});

describe("untrack", () => {
    it("prevents read inside untrack from establishing dependency", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let runs = 0;
        r.effect(() => {
            runs++;
            a();
            r.untrack(() => b());
        });
        assert.equal(runs, 1);
        b.set(99);
        assert.equal(runs, 1, "untracked read must not re-run");
        a.set(1);
        assert.equal(runs, 2);
    });

    it("returns the inner fn value", () => {
        assert.equal(r.untrack(() => 7), 7);
    });

    it("nesting restores tracking on exit", () => {
        const a = r.signal(0);
        let runs = 0;
        r.effect(() => {
            runs++;
            r.untrack(() => {});
            a(); // should still track
        });
        a.set(1);
        assert.equal(runs, 2);
    });
});

describe("nested objects", () => {
    it("blocks updates on deep mutation due to Object.is reference equality", () => {
        const state = r.signal({ profile: { age: 25 } });
        let runs = 0;
        r.effect(() => { runs++; state(); });
        assert.equal(runs, 1);

        // Mutating the nested property but keeping the same root object reference
        const current = state.peek();
        current.profile.age = 26;
        state.set(current);

        assert.equal(runs, 1, "Mutating same reference must NOT trigger an update");
    });

    it("triggers updates via immutable spreading (reference change)", () => {
        const state = r.signal({ profile: { age: 25 } });
        let runs = 0;
        r.effect(() => { runs++; state(); });

        // Creating a new object reference
        state.set({ ...state.peek(), profile: { age: 26 } });

        assert.equal(runs, 2, "New object reference must trigger an update");
    });

    it("triggers updates on mutation if custom equality is disabled", () => {
        // equals: () => false forces the signal to ALWAYS notify on .set()
        const state = r.signal({ profile: { age: 25 } }, { equals: () => false });
        let runs = 0;
        r.effect(() => { runs++; state(); });

        const current = state.peek();
        current.profile.age = 26;
        state.set(current); // Manually trigger the notification

        assert.equal(runs, 2, "Bypassed equality must trigger an update on mutation");
    });
});