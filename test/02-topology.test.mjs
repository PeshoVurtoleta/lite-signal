// Graph-shape tests: diamond, deep chains, dynamic deps, conditional branches.
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("diamond dependency (glitch-free)", () => {
    it("downstream effect sees a consistent view of both branches", () => {
        const a = r.signal(1);
        const b = r.computed(() => a() + 1);     // 2
        const c = r.computed(() => a() * 10);    // 10
        const d = r.computed(() => b() + c());   // 12

        const trace = [];
        r.effect(() => trace.push(d()));

        a.set(2);   // b=3, c=20, d=23 — expect exactly ONE intermediate
        assert.deepEqual(trace, [12, 23]);
    });

    it("does not double-fire effects sharing two computed paths", () => {
        const src = r.signal(0);
        const left = r.computed(() => src() + 1);
        const right = r.computed(() => src() - 1);

        let runs = 0;
        r.effect(() => { runs++; left(); right(); });
        assert.equal(runs, 1);

        src.set(10);
        assert.equal(runs, 2, "single src change → single effect re-run");
    });

    it("deeper diamond stays glitch-free", () => {
        const a = r.signal(0);
        const b = r.computed(() => a() + 1);
        const c = r.computed(() => a() + 2);
        const d = r.computed(() => b() + c());
        const e = r.computed(() => d() * 2);

        let runs = 0, lastVal;
        r.effect(() => { runs++; lastVal = e(); });
        assert.equal(lastVal, (0 + 1 + 0 + 2) * 2);

        a.set(5);
        assert.equal(lastVal, (5 + 1 + 5 + 2) * 2);
        assert.equal(runs, 2);
    });
});

describe("deep chains", () => {
    it("256-deep computed chain propagates correctly", () => {
        const src = r.signal(0);
        let prev = src;
        for (let i = 0; i < 256; i++) {
            const p = prev;
            prev = r.computed(() => p() + 1);
        }
        const tip = prev;
        assert.equal(tip(), 256);
        src.set(10);
        assert.equal(tip(), 266);
    });

    it("1024-deep chain still works (well under the stack-limit ~10k)", () => {
        const big = createRegistry({maxNodes: 1024, onCapacityExceeded: "grow"});
        const src = big.signal(0);
        let prev = src;
        for (let i = 0; i < 1024; i++) {
            const p = prev;
            prev = big.computed(() => p() + 1);
        }
        const tip = prev;
        assert.equal(tip(), 1024);
        src.set(1000);
        assert.equal(tip(), 2024);
    });

    it("deep chain feeds a downstream effect", () => {
        const src = r.signal(0);
        let prev = src;
        for (let i = 0; i < 128; i++) {
            const p = prev;
            prev = r.computed(() => p() + 1);
        }
        let last = -1;
        r.effect(() => { last = prev(); });
        assert.equal(last, 128);
        src.set(42);
        assert.equal(last, 170);
    });
});

describe("wide fan-out (broadcast)", () => {
    it("one signal → 100 effects, all update on every change", () => {
        const src = r.signal(0);
        let total = 0;
        for (let i = 0; i < 100; i++) {
            r.effect(() => { total += src(); });
        }
        assert.equal(total, 0);
        src.set(1);
        assert.equal(total, 100, "100 effects × value 1");
        src.set(2);
        assert.equal(total, 300, "100 effects × (0+1+2)");
    });

    it("one signal → 100 computeds → 1 aggregating effect", () => {
        const src = r.signal(1);
        const cs = [];
        for (let i = 0; i < 100; i++) cs.push(r.computed(() => src() * (i + 1)));

        let sum = 0;
        r.effect(() => {
            sum = 0;
            for (let i = 0; i < 100; i++) sum += cs[i]();
        });
        // 1 * (1+2+...+100) = 5050
        assert.equal(sum, 5050);
        src.set(2);
        assert.equal(sum, 10100);
    });
});

describe("dynamic dependencies", () => {
    it("branch switch: A or B based on flag", () => {
        const flag = r.signal(true);
        const a = r.signal(10);
        const b = r.signal(100);

        let last;
        r.effect(() => { last = flag() ? a() : b(); });
        assert.equal(last, 10);

        a.set(20);             // tracked → re-run
        assert.equal(last, 20);

        b.set(200);            // not tracked → no re-run
        assert.equal(last, 20);

        flag.set(false);       // re-run, now tracking b
        assert.equal(last, 200);

        a.set(30);             // no longer tracked → no re-run
        assert.equal(last, 200);

        b.set(300);            // tracked → re-run
        assert.equal(last, 300);
    });

    it("releases stale dep links", () => {
        const flag = r.signal(true);
        const a = r.signal(10);
        const b = r.signal(100);
        r.effect(() => flag() ? a() : b());

        const linksWithA = r.stats().activeLinks;
        flag.set(false);
        const linksWithB = r.stats().activeLinks;

        // (effect→flag) + (effect→a) → (effect→flag) + (effect→b)
        // Link count should stay the same: stale link to `a` is freed, fresh link to `b` is allocated.
        assert.equal(linksWithA, linksWithB);
    });

    it("conditional fan-out adds and removes deps cleanly", () => {
        const ids = r.signal([1, 2, 3]);
        const sigs = new Map();
        for (let i = 1; i <= 5; i++) sigs.set(i, r.signal(i * 10));

        let observedSum = 0;
        r.effect(() => {
            let s = 0;
            for (const id of ids()) s += sigs.get(id)();
            observedSum = s;
        });
        assert.equal(observedSum, 10 + 20 + 30);

        // Drop 2, add 4 and 5
        ids.set([1, 3, 4, 5]);
        assert.equal(observedSum, 10 + 30 + 40 + 50);

        // Updating dropped dep does nothing
        sigs.get(2).set(999);
        assert.equal(observedSum, 10 + 30 + 40 + 50);

        // Updating active dep triggers
        sigs.get(4).set(400);
        assert.equal(observedSum, 10 + 30 + 400 + 50);
    });
});

describe("same-dep read multiple times", () => {
    it("two reads of the same signal create one link", () => {
        const a = r.signal(0);
        r.effect(() => { a(); a(); a(); });
        assert.equal(r.stats().activeLinks, 1);
    });
});

describe("self-referential signal write inside effect", () => {
    it("write that does not change value does not retrigger", () => {
        const a = r.signal(0);
        let runs = 0;
        r.effect(() => {
            runs++;
            const v = a();
            if (v < 5) a.set(v);   // same value → equality cutoff
        });
        assert.equal(runs, 1);
    });

    it("write to a different (untracked) signal during effect run is safe", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let runs = 0;
        r.effect(() => {
            runs++;
            const v = a();
            // Writing to b doesn't loop because we never read b → no dep.
            if (v < 3) b.set(b.peek() + 1);
        });
        // First run sets b to 1; no re-trigger because b isn't tracked.
        assert.equal(runs, 1);
        assert.equal(b(), 1);

        a.set(1);
        assert.equal(runs, 2);
        assert.equal(b(), 2);
    });

    it("infinite self-write trips the cycle guard", () => {
        const a = r.signal(0);
        assert.throws(() => {
            r.effect(() => {
                a.set(a() + 1);
            });
        }, /CycleError/);
    });
});

describe("nested effects", () => {
    it("inner effect re-runs without affecting outer's deps", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let outerRuns = 0, innerRuns = 0;

        r.effect(() => {
            outerRuns++;
            a();
            r.effect(() => { innerRuns++; b(); });
        });

        assert.equal(outerRuns, 1);
        assert.equal(innerRuns, 1);

        b.set(1);
        assert.equal(outerRuns, 1, "outer not subscribed to b");
        assert.equal(innerRuns, 2);

        a.set(1);                              // outer re-runs
        assert.equal(outerRuns, 2);
        // Outer re-run creates a NEW inner effect (we don't auto-dispose nested) →
        // we'll see at least one additional inner run from the new effect's first run.
        assert(innerRuns >= 3);
    });
});
