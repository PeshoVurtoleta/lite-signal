import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    signal, computed, effect, batch,
    watch, when, whenAsync,
    createRegistry, setDefaultRegistry
} from "../Signal.js";

let r;
beforeEach(() => {
    r = createRegistry({ maxNodes: 256, maxLinks: 1024, onCapacityExceeded: "grow" });
    setDefaultRegistry(r);
});

// ────────────────────────────────────────────────────────────────────────────
//                              watch
// ────────────────────────────────────────────────────────────────────────────

describe("watch — basic semantics", () => {
    it("fires (newValue, oldValue, stop) on change", () => {
        const c = signal(0);
        const log = [];
        watch(c, (n, p, stop) => log.push([n, p, typeof stop]));
        c.set(1); c.set(2);
        assert.deepEqual(log, [[1, 0, "function"], [2, 1, "function"]]);
    });

    it("does not fire on registration by default", () => {
        const c = signal(42);
        let fired = false;
        watch(c, () => { fired = true; });
        assert.equal(fired, false);
    });

    it("oldValue is the value at the previous fire", () => {
        const c = signal("a");
        const log = [];
        watch(c, (n, p) => log.push([n, p]));
        c.set("b"); c.set("c"); c.set("d");
        assert.deepEqual(log, [["b", "a"], ["c", "b"], ["d", "c"]]);
    });
});

describe("watch — immediate option", () => {
    it("fires once on registration with oldValue=undefined", () => {
        const c = signal("hello");
        const log = [];
        watch(c, (n, p) => log.push([n, p]), { immediate: true });
        assert.deepEqual(log, [["hello", undefined]]);
    });

    it("subsequent fires after immediate use real previous values", () => {
        const c = signal(1);
        const log = [];
        watch(c, (n, p) => log.push([n, p]), { immediate: true });
        c.set(2); c.set(3);
        assert.deepEqual(log, [[1, undefined], [2, 1], [3, 2]]);
    });
});

describe("watch — Object.is equality guard for raw getters", () => {
    it("does NOT fire when getter result is unchanged across dep mutations", () => {
        const health = signal(10);
        const log = [];
        watch(() => health() <= 0, (isDead, wasDead) => log.push([isDead, wasDead]));

        health.set(9); health.set(8); health.set(5); health.set(1);
        assert.deepEqual(log, []);

        health.set(0);
        assert.deepEqual(log, [[true, false]]);

        health.set(-1); health.set(-5);
        assert.deepEqual(log, [[true, false]]);

        health.set(10);
        assert.deepEqual(log, [[true, false], [false, true]]);
    });

    it("compensating multi-source changes that net to same projection don't fire", () => {
        const a = signal(1);
        const b = signal(2);
        let fires = 0;
        watch(() => a() + b(), () => { fires++; });
        batch(() => { a.set(2); b.set(1); });
        assert.equal(fires, 0);
        a.set(5);
        assert.equal(fires, 1);
    });

    it("NaN → NaN does NOT fire", () => {
        const c = signal(NaN);
        let fires = 0;
        watch(c, () => { fires++; });
        c.set(NaN);
        assert.equal(fires, 0);
    });

    it("+0 vs -0 DOES fire (Object.is distinguishes them)", () => {
        const flag = signal(false);
        let fires = 0;
        const log = [];
        watch(() => (flag() ? +0 : -0), (n, p) => { fires++; log.push([n, p]); });
        flag.set(true);
        assert.equal(fires, 1);
        assert.deepEqual(log, [[+0, -0]]);
    });
});

describe("watch — stop handle in callback (self-disposal)", () => {
    it("calling stop() inside the callback disposes the watcher", () => {
        const c = signal(0);
        const log = [];
        watch(c, (n, p, stop) => {
            log.push(n);
            if (n >= 2) stop();
        });
        c.set(1); c.set(2); c.set(3); c.set(4);
        assert.deepEqual(log, [1, 2]);
    });

    it("stop in callback is a function and is idempotent", () => {
        const c = signal(0);
        let capturedStop = null;
        const returnedStop = watch(c, (n, p, stop) => { capturedStop = stop; });
        c.set(1);
        assert.equal(typeof capturedStop, "function");
        assert.doesNotThrow(() => { capturedStop(); capturedStop(); returnedStop(); });
    });

    it("self-dispose during immediate fire works (the wantsStopEarly path)", () => {
        // At the moment the immediate callback runs, stopFn hasn't been assigned
        // yet. The wrapper stop() must defer the dispose until after effect() returns.
        const c = signal("ready");
        let fires = 0;
        watch(c, (n, p, stop) => { fires++; stop(); }, { immediate: true });
        c.set("done"); c.set("more");
        assert.equal(fires, 1);
    });

    it("stop in callback prevents subsequent propagations", () => {
        const c = signal(0);
        let fires = 0;
        watch(c, (n, p, stop) => { fires++; stop(); });
        c.set(1); c.set(2); c.set(3);
        assert.equal(fires, 1);
    });
});

describe("watch — disposal", () => {
    it("returned dispose function stops the watcher", () => {
        const c = signal(0);
        const log = [];
        const stop = watch(c, (n) => log.push(n));
        c.set(1);
        stop();
        c.set(2);
        assert.deepEqual(log, [1]);
    });

    it("dispose is idempotent", () => {
        const c = signal(0);
        const stop = watch(c, () => {});
        stop();
        assert.doesNotThrow(() => stop());
    });
});

describe("watch — callback untracking", () => {
    it("reads inside callback do NOT register as dependencies", () => {
        const tracked = signal(0);
        const unrelated = signal("a");
        let fires = 0;
        watch(tracked, () => { unrelated(); fires++; });
        tracked.set(1);
        assert.equal(fires, 1);
        unrelated.set("b"); unrelated.set("c");
        assert.equal(fires, 1);
    });
});

describe("watch — undefined-as-value distinguished from never-ran (UNINITIALIZED)", () => {
    it("source value `undefined` is not confused with first-run state", () => {
        const c = signal(undefined);
        const log = [];
        watch(c, (n, p) => log.push([n, p]));
        c.set("first"); c.set(undefined); c.set("second");
        assert.deepEqual(log, [
            ["first", undefined],
            [undefined, "first"],
            ["second", undefined]
        ]);
    });

    it("immediate=true with signal(undefined) fires callback(undefined, undefined)", () => {
        const c = signal(undefined);
        const log = [];
        watch(c, (n, p) => log.push([n, p]), { immediate: true });
        assert.deepEqual(log, [[undefined, undefined]]);
    });
});

describe("watch — source types", () => {
    it("plain signal", () => {
        const c = signal(10);
        const log = [];
        watch(c, (n) => log.push(n));
        c.set(20);
        assert.deepEqual(log, [20]);
    });

    it("computed", () => {
        const base = signal(5);
        const doubled = computed(() => base() * 2);
        const log = [];
        watch(doubled, (n, p) => log.push([n, p]));
        base.set(7);
        assert.deepEqual(log, [[14, 10]]);
    });

    it("multi-source getter closure", () => {
        const a = signal(1);
        const b = signal(10);
        const log = [];
        watch(() => a() + b(), (n, p) => log.push([n, p]));
        a.set(2); b.set(20);
        assert.deepEqual(log, [[12, 11], [22, 12]]);
    });
});

describe("watch — batched updates", () => {
    it("multiple sets within a batch coalesce into one fire", () => {
        const c = signal(0);
        const log = [];
        watch(c, (n, p) => log.push([n, p]));
        batch(() => { c.set(1); c.set(2); c.set(3); });
        assert.deepEqual(log, [[3, 0]]);
    });

    it("batch with net-zero change does not fire", () => {
        const c = signal(5);
        let fires = 0;
        watch(c, () => { fires++; });
        batch(() => { c.set(10); c.set(5); });
        assert.equal(fires, 0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
//                              when
// ────────────────────────────────────────────────────────────────────────────

describe("when — basic semantics", () => {
    it("fires callback exactly once when predicate becomes truthy", () => {
        const ready = signal(false);
        let fires = 0;
        when(() => ready(), () => { fires++; });
        assert.equal(fires, 0);
        ready.set(true);
        assert.equal(fires, 1);
    });

    it("fires synchronously if predicate is already truthy at registration", () => {
        const ready = signal(true);
        let fires = 0;
        when(() => ready(), () => { fires++; });
        assert.equal(fires, 1);
    });

    it("does NOT fire again on subsequent truthy values (one-shot)", () => {
        const counter = signal(0);
        let fires = 0;
        when(() => counter() > 0, () => { fires++; });
        counter.set(1);
        assert.equal(fires, 1);
        counter.set(2); counter.set(3); counter.set(100);
        assert.equal(fires, 1);
    });

    it("does not fire while predicate stays falsy", () => {
        const counter = signal(0);
        let fires = 0;
        when(() => counter() > 10, () => { fires++; });
        counter.set(1); counter.set(5); counter.set(9);
        assert.equal(fires, 0);
        counter.set(11);
        assert.equal(fires, 1);
    });

    it("manual dispose before predicate fires prevents the callback", () => {
        const ready = signal(false);
        let fires = 0;
        const cancel = when(() => ready(), () => { fires++; });
        cancel();
        ready.set(true);
        assert.equal(fires, 0);
    });

    it("dispose is idempotent", () => {
        const ready = signal(false);
        const cancel = when(() => ready(), () => {});
        assert.doesNotThrow(() => { cancel(); cancel(); cancel(); });
    });

    it("dispose after the callback has fired is a safe no-op", () => {
        const ready = signal(true);
        const cancel = when(() => ready(), () => {});
        assert.doesNotThrow(() => cancel());
    });

    it("callback reads are untracked", () => {
        const ready = signal(false);
        const unrelated = signal("x");
        let fires = 0;
        when(() => ready(), () => { unrelated(); fires++; });
        ready.set(true);
        assert.equal(fires, 1);
        unrelated.set("y");
        assert.equal(fires, 1);
    });

    it("various truthy values all trigger the callback", () => {
        const cases = [1, "a", {}, [], -1, 0.5, true];
        for (const truthy of cases) {
            const s = signal(false);
            let fires = 0;
            when(() => s(), () => { fires++; });
            s.set(truthy);
            assert.equal(fires, 1, `value ${JSON.stringify(truthy) ?? String(truthy)} should trigger`);
        }
    });

    it("various falsy values do NOT trigger the callback", () => {
        const cases = [0, "", null, undefined, false];
        for (const falsy of cases) {
            const s = signal(falsy);
            let fires = 0;
            when(() => s(), () => { fires++; });
            assert.equal(fires, 0, `falsy ${JSON.stringify(falsy) ?? String(falsy)} should not trigger`);
        }
    });

    it("toggling false → true → false → true fires only on first true", () => {
        const s = signal(false);
        let fires = 0;
        when(() => s(), () => { fires++; });
        s.set(true);
        s.set(false);
        s.set(true);
        assert.equal(fires, 1);
    });

    it("when can dispose itself synchronously when predicate is truthy at registration", () => {
        // Similar to watch's wantsStopEarly path — when's predicate is already
        // truthy, the body calls stop() before stopFn has been assigned. The
        // wrapper defers the dispose. After effect() returns, the deferred
        // dispose runs, so the watcher does not see further changes.
        const flag = signal(true);
        let fires = 0;
        when(() => flag(), () => { fires++; });
        flag.set(false);
        flag.set(true);   // would re-fire if not properly disposed
        assert.equal(fires, 1);
    });
});

// ────────────────────────────────────────────────────────────────────────────
//                              whenAsync
// ────────────────────────────────────────────────────────────────────────────

describe("whenAsync — basic semantics", () => {
    it("resolves when predicate first becomes truthy", async () => {
        const ready = signal(false);
        const p = whenAsync(() => ready());
        let resolved = false;
        p.then(() => { resolved = true; });
        assert.equal(resolved, false);
        ready.set(true);
        await p;
        assert.equal(resolved, true);
    });

    it("resolves immediately if predicate is already truthy at registration", async () => {
        const ready = signal(true);
        await whenAsync(() => ready());
        assert.ok(true);  // reached here = resolved
    });

    it("composes with async/await for sequential reactive flow", async () => {
        const phase = signal("idle");
        const log = [];

        const flow = async () => {
            log.push("waiting");
            await whenAsync(() => phase() === "ready");
            log.push("got ready");
            await whenAsync(() => phase() === "done");
            log.push("got done");
        };

        const flowPromise = flow();
        await new Promise((r) => setTimeout(r, 0));
        phase.set("processing");
        await new Promise((r) => setTimeout(r, 0));
        phase.set("ready");
        await new Promise((r) => setTimeout(r, 0));
        phase.set("done");
        await flowPromise;

        assert.deepEqual(log, ["waiting", "got ready", "got done"]);
    });

    it("Promise.race with timeout works as documented", async () => {
        const ready = signal(false);
        let caught = null;
        try {
            await Promise.race([
                whenAsync(() => ready()),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30))
            ]);
        } catch (e) { caught = e; }
        assert.ok(caught instanceof Error);
        assert.equal(caught.message, "timeout");
    });

    it("never settles on its own when predicate stays falsy", async () => {
        const ready = signal(false);
        let settled = false;
        whenAsync(() => ready()).then(() => { settled = true; }, () => { settled = true; });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(settled, false);
        // cleanup
        ready.set(true);
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(settled, true);
    });
});
