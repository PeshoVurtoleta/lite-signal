// 11-adopted-reactive.test.mjs
//
// Tests adopted from across the reactive ecosystem. The preceding 10 files
// cover the engine's own guarantees; this file fills the corners other
// frameworks discovered the hard way — regressions they've shipped and
// reverted, edge cases their issue trackers documented, and contracts the
// wider test suites turned out to exercise that ours did not.
//
// Source attribution per describe block in the comments. Every test in
// this file is engine-agnostic (no assumptions about ownership trees,
// scheduler-thunk caching, or other version-specific behavior) — so the
// file is the same shape across 1.1.x and 1.2.x.

import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

const hasGC = typeof gc === "function";

let r;
beforeEach(() => { r = createRegistry(); });

// ─── alien-signals: parent-child link integrity through inner re-runs ──────

describe("adopted (alien-signals): outer responds to its own dep after inner re-runs", () => {
    // alien-signals 3.2.0 shipped a regression where, after an inner effect
    // re-ran on its own dep, the outer effect's link to its own dep got
    // dropped — outer never fired again on subsequent writes to that dep.
    // Upstream test IDs: #226, #227, #228. Worth pinning here because the
    // exact same code path (markDownstream + dep severance after an inner
    // re-run) exists in every nested-effect-capable engine.

    it("#226 outer still fires after a single inner re-run on its own dep", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let outerRuns = 0;
        r.effect(() => {
            outerRuns++;
            a();
            r.effect(() => { b(); });
        });
        const startOuter = outerRuns;
        b.set(1);                          // inner re-runs only
        a.set(1);                          // outer MUST still respond
        assert.ok(outerRuns > startOuter, "outer dropped its link to a");
    });

    it("#227 outer responds after one of multiple sibling inners re-runs", () => {
        const a = r.signal(0);
        const b1 = r.signal(0);
        const b2 = r.signal(0);
        let outerRuns = 0;
        r.effect(() => {
            outerRuns++;
            a();
            r.effect(() => { b1(); });
            r.effect(() => { b2(); });
        });
        const startOuter = outerRuns;
        b1.set(1);                         // one sibling re-runs
        a.set(1);                          // outer must still respond
        assert.ok(outerRuns > startOuter);
    });

    it("#228 outer responds after inner re-runs in a burst", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let outerRuns = 0;
        r.effect(() => {
            outerRuns++;
            a();
            r.effect(() => { b(); });
        });
        const startOuter = outerRuns;
        b.set(1); b.set(2); b.set(3);      // inner re-runs three times
        a.set(1);
        assert.ok(outerRuns > startOuter);
    });
});

// ─── equality predicate edge cases ─────────────────────────────────────────

describe("adopted (preact/solid/vue): equality predicate edge cases", () => {
    // The default Object.is path is widely tested in 01-core. These tests
    // exercise the predicate IS-CUSTOM path — the one preact and vue handle
    // distinctly from Object.is.

    it("struct equals: comparing a key field halts propagation when key unchanged", () => {
        const eq = (a, b) => a.id === b.id;
        const s = r.signal({id: 1, name: "alice"}, {equals: eq});
        let runs = 0;
        r.effect(() => { s(); runs++; });
        s.set({id: 1, name: "bob"});       // same id → no propagate
        assert.equal(runs, 1);
        s.set({id: 2, name: "bob"});       // different id → propagate
        assert.equal(runs, 2);
    });

    it("equals: () => false forces propagation on every set, even same value", () => {
        const s = r.signal(5, {equals: () => false});
        let runs = 0;
        r.effect(() => { s(); runs++; });
        s.set(5); s.set(5); s.set(5);
        assert.equal(runs, 4);             // 1 initial + 3 forced
    });

    it("equals: () => true never propagates", () => {
        const s = r.signal(0, {equals: () => true});
        let runs = 0;
        r.effect(() => { s(); runs++; });
        s.set(1); s.set(2); s.set(99);
        assert.equal(runs, 1);             // only the initial run
    });

    it("computed equals halts downstream when projection is stable", () => {
        const a = r.signal(0);
        const c = r.computed(() => a() % 2, {equals: Object.is});
        let runs = 0;
        r.effect(() => { c(); runs++; });
        a.set(2);                          // c stays 0
        a.set(4);                          // c stays 0
        assert.equal(runs, 1);
    });
});

// ─── update() functional setter ─────────────────────────────────────────────

describe("adopted (vue/solid): signal.update(fn) functional setter", () => {
    // update is the functional equivalent of `s.set(fn(s.peek()))`.
    // The contract that the read inside is NOT tracked is critical for
    // callers using update inside an effect.

    it("applies the result of fn(current)", () => {
        const s = r.signal(10);
        s.update(v => v * 2);
        assert.equal(s.peek(), 20);
        s.update(v => v + 5);
        assert.equal(s.peek(), 25);
    });

    it("reads current without tracking — no spurious dep created", () => {
        // If update tracked, calling it inside an effect that doesn't
        // otherwise depend on `s` would create a phantom dep.
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { runs++; /* never reads s */ });
        s.update(v => v + 1);              // update calls peek internally
        s.set(99);                         // external write to s
        assert.equal(runs, 1);             // effect did not pick up s as dep
    });
});

// ─── peek() depth ────────────────────────────────────────────────────────────

describe("adopted (preact/vue): peek() does not subscribe", () => {
    it("peek inside an effect does not create a dep edge", () => {
        const s = r.signal(0);
        const t = r.signal(0);
        let runs = 0;
        r.effect(() => { s(); t.peek(); runs++; });
        t.set(1);                          // peeked dep should not fire
        assert.equal(runs, 1);
        s.set(1);                          // tracked dep fires
        assert.equal(runs, 2);
    });

    it("peek on a lazy computed forces evaluation but does not subscribe", () => {
        const a = r.signal(0);
        let evals = 0;
        const c = r.computed(() => { evals++; return a() * 2; });
        assert.equal(c.peek(), 0);
        assert.equal(evals, 1);
        // No subscriber from this peek: subsequent set must NOT
        // eagerly re-evaluate.
        a.set(5);
        assert.equal(evals, 1);
        // But the next peek sees dirty and re-evaluates lazily.
        assert.equal(c.peek(), 10);
        assert.equal(evals, 2);
    });
});

// ─── subscribe behavioral contract ─────────────────────────────────────────

describe("adopted (preact/mobx): subscribe behavioral contract", () => {
    it("fires synchronously with current value on registration", () => {
        const s = r.signal(42);
        let seen;
        s.subscribe(v => { seen = v; });
        assert.equal(seen, 42);
    });

    it("multiple subscribers all fire on set, in creation order", () => {
        const s = r.signal(0);
        const log = [];
        s.subscribe(v => log.push(["a", v]));
        s.subscribe(v => log.push(["b", v]));
        s.subscribe(v => log.push(["c", v]));
        log.length = 0;                    // clear initial fires
        s.set(1);
        assert.deepEqual(log, [["a", 1], ["b", 1], ["c", 1]]);
    });

    it("dispose → re-subscribe is independent (no zombie callbacks)", () => {
        const s = r.signal(0);
        let firstCount = 0, secondCount = 0;
        const stop1 = s.subscribe(() => firstCount++);
        s.set(1);
        stop1();
        s.set(2);                          // first should NOT fire
        const stop2 = s.subscribe(() => secondCount++);
        s.set(3);
        assert.equal(firstCount, 2);       // initial + one update
        assert.equal(secondCount, 2);      // initial + one update
        stop2();
    });

    it("subscribe to a computed fires on transitive source change", () => {
        const a = r.signal(0);
        const c = r.computed(() => a() + 1);
        let seen;
        c.subscribe(v => { seen = v; });
        assert.equal(seen, 1);
        a.set(10);
        assert.equal(seen, 11);
    });

    it("dispose is idempotent — calling stop twice does not throw", () => {
        const s = r.signal(0);
        const stop = s.subscribe(() => {});
        stop();
        assert.doesNotThrow(() => stop());
    });
});

// ─── multi-source convergence ──────────────────────────────────────────────

describe("adopted (cellx/kairo): multi-source convergence and coalescing", () => {
    // Beyond the basic diamond, frameworks frequently regress on convergence
    // points: did sink C run exactly once after a multi-source change?
    // Counting exact recomputes catches subtle propagation-order bugs.

    it("triangle: two sources fan into one sink; batch update → sink runs once", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let evals = 0;
        const sum = r.computed(() => { evals++; return a() + b(); });
        r.effect(() => { sum(); });        // pin subscribed
        evals = 0;
        r.batch(() => { a.set(1); b.set(1); });
        assert.equal(evals, 1);
        assert.equal(sum.peek(), 2);
    });

    it("hourglass: source → 2 branches → 1 sink; source change → sink runs once", () => {
        const src = r.signal(0);
        const left = r.computed(() => src() + 1);
        const right = r.computed(() => src() * 2);
        let sinkRuns = 0;
        const sink = r.computed(() => { sinkRuns++; return left() + right(); });
        r.effect(() => { sink(); });
        sinkRuns = 0;
        src.set(5);
        assert.equal(sinkRuns, 1);
        assert.equal(sink.peek(), 6 + 10);
    });

    it("wide fan-in: 50 sources → 1 computed; full batch update → 1 recompute", () => {
        const sigs = [];
        for (let i = 0; i < 50; i++) sigs.push(r.signal(0));
        let evals = 0;
        const sum = r.computed(() => {
            evals++;
            let acc = 0;
            for (const s of sigs) acc += s();
            return acc;
        });
        r.effect(() => { sum(); });
        evals = 0;
        r.batch(() => {
            for (let i = 0; i < 50; i++) sigs[i].set(i + 1);
        });
        assert.equal(evals, 1);
        assert.equal(sum.peek(), 50 * 51 / 2);
    });
});

// ─── batch return value & nesting semantics ───────────────────────────────

describe("adopted (preact/mobx): batch() return value forwarding", () => {
    it("batch forwards the callback's return value", () => {
        const result = r.batch(() => 42);
        assert.equal(result, 42);
    });

    it("batch forwards the value computed from signals set inside", () => {
        const a = r.signal(0);
        const result = r.batch(() => {
            a.set(7);
            return a.peek() * 2;
        });
        assert.equal(result, 14);
        assert.equal(a.peek(), 7);
    });
});

// ─── stress / graph-balance invariants ─────────────────────────────────────

describe("adopted (cellx/stress): graph-balance invariants under churn", () => {
    // These tests are about long-running behavior. A library claiming
    // zero-GC must also claim graph-state stability — activeLinks should
    // return to baseline after balanced churn, not grow.

    it("subscribe-dispose cycle (1000x) returns activeLinks to baseline", () => {
        const s = r.signal(0);
        const baseline = r.stats().activeLinks;
        for (let i = 0; i < 1000; i++) {
            const stop = s.subscribe(() => {});
            stop();
        }
        assert.equal(r.stats().activeLinks, baseline);
    });

    it("alternating writes on a dynamic-branch graph stay bounded", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let sink;
        const c = r.computed(() => (a() & 1) ? b() : a());  // dynamic dep
        r.effect(() => { sink = c(); });
        const peak = r.stats().activeLinks;
        for (let i = 0; i < 1000; i++) {
            a.set(i & 1);
            b.set(i);
        }
        assert.ok(r.stats().activeLinks <= peak + 2,
            `activeLinks grew unboundedly: ${r.stats().activeLinks} vs peak ${peak}`);
        // sink should also have a final value (not stale)
        assert.equal(typeof sink, "number");
    });

    if (hasGC) {
        it("subscribe-dispose loop has bounded retained heap [--expose-gc]", () => {
            const s = r.signal(0);
            // Warmup pass to get V8 stable.
            for (let i = 0; i < 500; i++) { const x = s.subscribe(() => {}); x(); }
            gc(); gc();
            const before = process.memoryUsage().heapUsed;
            for (let i = 0; i < 10000; i++) { const x = s.subscribe(() => {}); x(); }
            gc(); gc();
            const grew = process.memoryUsage().heapUsed - before;
            // Generous ceiling — we only care that it's bounded, not that
            // it's literally zero. Anything <512KB after 10k cycles is fine.
            assert.ok(grew < 512 * 1024,
                `retained heap grew ${grew} bytes after 10k subscribe-dispose cycles`);
        });
    }
});
