// Schedulers, version-wrap immunity, and miscellaneous edge cases.
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("effect scheduler", () => {
    it("scheduler defers initial run", () => {
        const queue = [];
        const scheduler = (run) => queue.push(run);

        let ran = 0;
        r.effect(() => { ran++; }, {scheduler});
        assert.equal(ran, 0, "first run is deferred to the scheduler");
        queue.shift()();
        assert.equal(ran, 1);
    });

    it("scheduler defers re-runs", () => {
        const queue = [];
        const scheduler = (run) => queue.push(run);
        const a = r.signal(0);

        let last = -1;
        r.effect(() => { last = a(); }, {scheduler});
        queue.shift()();
        assert.equal(last, 0);

        a.set(7);
        assert.equal(last, 0, "no scheduler drain yet → no effect");
        assert.equal(queue.length, 1);
        queue.shift()();
        assert.equal(last, 7);
    });

    it("disposing before the scheduler drains is safe", () => {
        const queue = [];
        const scheduler = (run) => queue.push(run);
        const a = r.signal(0);

        let last = -1;
        const dispose = r.effect(() => { last = a(); }, {scheduler});
        queue.shift()();
        assert.equal(last, 0);

        a.set(99);
        dispose();
        // Now drain the queued trampoline — it must NOT run the disposed effect.
        queue.shift()?.();
        assert.equal(last, 0, "disposed effect's queued trampoline is a no-op");
    });

    it("microtask scheduler-style coalescing works", async () => {
        const scheduler = (run) => Promise.resolve().then(run);
        const a = r.signal(0);
        let runs = 0;
        r.effect(() => { runs++; a(); }, {scheduler});
        await Promise.resolve();
        assert.equal(runs, 1);

        a.set(1);
        a.set(2);
        a.set(3);
        // All three writes flushed synchronously into the effect queue → each
        // scheduled separately, but the effect's eval-version check makes the
        // subsequent runs cheap no-ops.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        assert(runs <= 4);
        assert(runs >= 2);
    });
});


describe("scheduler trampoline — allocation contract (1.1.4+)", () => {
    // The scheduler dispatch must allocate ZERO closures per re-schedule.
    // Without this contract the rAF-driven HUD path generates ~120 closures
    // per second per scheduled effect — silent GC pressure on exactly the
    // workload the zero-GC contract targets.

    it("same thunk reference is reused across every re-schedule", () => {
        // Capture thunk references across N schedules; the cached design
        // means there is exactly one distinct reference for the effect's
        // lifetime.
        const queue = [];
        const sched = (run) => { queue.push(run); };
        const drain = () => { const q = queue.splice(0); q.forEach(t => t()); };

        const s = r.signal(0);
        let runs = 0;
        const seen = new Set();
        r.effect(() => { s(); runs++; }, { scheduler: sched });
        for (const t of queue) seen.add(t);
        drain();
        for (let i = 1; i <= 5; i++) {
            s.set(i);
            for (const t of queue) seen.add(t);
            drain();
        }
        assert.equal(runs, 6);              // ran 6 times (initial + 5 sets)
        assert.equal(seen.size, 1);         // ONE distinct closure across all
    });

    it("ABA: a stale thunk fired after dispose is a no-op (gen guard)", () => {
        // Capture a thunk, dispose the effect (gen bumps), fire the stale
        // thunk — the cached closure's captured gen now mismatches
        // node.gen, so the dispatch must no-op without running the body.
        const queue = [];
        const sched = (run) => { queue.push(run); };

        const a = r.signal(0);
        let body = 0;
        const stop = r.effect(() => { a(); body++; }, { scheduler: sched });
        queue.splice(0).forEach(t => t());        // initial run

        a.set(1);                                  // schedules a thunk
        const stale = queue.shift();
        stop();                                    // dispose → gen bumps
        const before = body;
        stale();                                   // fire stale thunk

        assert.equal(body, before);                // body did NOT run again
    });

    it("recycled node gets a fresh thunk — old stale thunk does not run new effect", () => {
        // Tight slot-reuse case. After dispose+recycle, the node may be
        // reallocated for a new scheduled effect with the same scheduler.
        // The new effect must rebuild its own thunk (different identity),
        // and the OLD stale thunk must still no-op against the new gen.
        const queueA = [];
        const schedA = (run) => { queueA.push(run); };

        // Force a small registry so disposing one and creating a new one
        // is highly likely to land on the same pool slot.
        const r2 = createRegistry({ maxNodes: 4, maxLinks: 16 });
        const s = r2.signal(0);

        const stop1 = r2.effect(() => { s(); }, { scheduler: schedA });
        queueA.splice(0).forEach(t => t());
        s.set(1);
        const staleThunk = queueA.shift();
        stop1();                                   // free the slot, gen bump

        // Recreate; with maxNodes=4 and only a few signals in flight, this
        // should land on a freshly-recycled slot.
        let newBody = 0;
        const stop2 = r2.effect(() => { s(); newBody++; }, { scheduler: schedA });
        queueA.splice(0).forEach(t => t());        // initial new effect run
        const newThunk = queueA[0] ?? null;        // may not have queued yet
        s.set(2);
        const drained = queueA.splice(0);
        drained.forEach(t => t());

        const beforeStale = newBody;
        staleThunk();                              // fire the OLD thunk
        assert.equal(newBody, beforeStale);        // new effect not touched
        if (newThunk !== null) {
            assert.notEqual(newThunk, staleThunk); // different identities
        }
        stop2();
    });
});

describe("version-wrap immunity (modular 32-bit arithmetic)", () => {
    // We can't actually do 2^31 writes in a test, but we can verify the math is
    // consistent under the assumption that the wrap check is `(a - b) | 0 > 0`.
    it("simulated wrap: after globalVersion-near-INT_MAX, fresh writes still trigger effects", () => {
        // Build a registry, then force many writes to push globalVersion forward.
        // We use a tiny graph so this stays fast. We can't exhaustively push to 2^31,
        // but we sanity-check the subtraction logic by inspecting downstream behaviour
        // after many cycles.
        const a = r.signal(0);
        let last;
        r.effect(() => { last = a(); });

        for (let i = 1; i <= 50_000; i++) a.set(i);
        assert.equal(last, 50_000);

        // Even after many cycles, behaviour is still correct.
        a.set(50_000); // same value, no change
        assert.equal(last, 50_000);
        a.set(60_000);
        assert.equal(last, 60_000);
    });
});

describe("subscribe semantics", () => {
    it("subscribe fires synchronously with the initial value", () => {
        const s = r.signal(42);
        const out = [];
        const off = s.subscribe(v => out.push(v));
        assert.deepEqual(out, [42]);
        off();
    });

    it("subscribe on a computed fires with initial value too", () => {
        const a = r.signal(2);
        const b = r.computed(() => a() * 5);
        const out = [];
        const off = b.subscribe(v => out.push(v));
        a.set(3);
        assert.deepEqual(out, [10, 15]);
        off();
        a.set(4);
        assert.deepEqual(out, [10, 15]);
    });

    it("subscriber callback is untracked: reading other signals does not add deps", () => {
        const a = r.signal(0);
        const b = r.signal(100);
        let bRuns = 0;
        const off = a.subscribe(_v => { bRuns++; b(); });
        const baseline = bRuns;
        b.set(200);
        assert.equal(bRuns, baseline, "subscriber reading b should not subscribe to b");
        off();
    });
});

describe("onCleanup edge cases", () => {
    it("onCleanup outside an effect is a no-op", () => {
        // Should not throw, should not crash.
        r.onCleanup(() => {});
    });

    it("cleanup registered in computed runs on next compute", () => {
        const a = r.signal(0);
        const trace = [];
        const c = r.computed(() => {
            const v = a();
            r.onCleanup(() => trace.push(`clean:${v}`));
            return v * 2;
        });
        c();           // run 1
        a.set(1);
        c();           // run 2 → cleanup from run 1 fires first
        a.set(2);
        c();
        assert.deepEqual(trace, ["clean:0", "clean:1"]);
    });
});

describe("untrack composability", () => {
    it("untrack inside an effect still allows writes", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let runs = 0;
        r.effect(() => {
            runs++;
            a();
            r.untrack(() => { b.set(b.peek() + 1); });
        });
        assert.equal(runs, 1);
        assert.equal(b(), 1);
        a.set(1);
        assert.equal(runs, 2);
        assert.equal(b(), 2);
    });
});

describe("integration: signal-of-array re-render trace", () => {
    it("classic counter list pattern", () => {
        const items = r.signal([0, 0, 0]);
        const total = r.computed(() => items().reduce((a, b) => a + b, 0));

        const trace = [];
        r.effect(() => trace.push(total()));

        items.set([1, 0, 0]);            // total: 1 → notify
        items.set([1, 2, 0]);            // total: 3 → notify
        items.set([1, 2, 3]);            // total: 6 → notify
        items.set([1, 2, 3]);            // total: 6 → Object.is cuts → no notify

        // The fifth set produces an array with the same sum; equality cutoff blocks
        // downstream notification. This is the desired behaviour.
        assert.deepEqual(trace, [0, 1, 3, 6]);
    });
});

describe("setDefaultRegistry", () => {
    it("top-level helpers route to the default registry", async () => {
        const mod = await import("../Signal.js");
        const r1 = mod.createRegistry();
        const r2 = mod.createRegistry();
        mod.setDefaultRegistry(r1);

        const a = mod.signal(0);
        let lastA = -1;
        mod.effect(() => { lastA = a(); });
        a.set(5);
        assert.equal(lastA, 5);
        assert.equal(r1.stats().signals, 1);

        mod.setDefaultRegistry(r2);
        const b = mod.signal(0);
        assert.equal(r2.stats().signals, 1);
        assert.equal(r1.stats().signals, 1, "r1 unchanged");

        // restore for any subsequent test
        mod.setDefaultRegistry(mod.createRegistry());
    });
});
