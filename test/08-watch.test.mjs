import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { signal, computed, effect, batch, watch, createRegistry, setDefaultRegistry } from "../Signal.js";

// Each test uses a fresh registry so node-pool state doesn't leak between cases.
// We swap the default registry rather than using the registry instance directly,
// because `watch` (and the top-level helpers) bind to the default.
let r;
beforeEach(() => {
    r = createRegistry({ maxNodes: 256, maxLinks: 1024, onCapacityExceeded: "grow" });
    setDefaultRegistry(r);
});

describe("watch — basic semantics", () => {
    it("fires (newValue, oldValue) on change", () => {
        const c = signal(0);
        const log = [];
        watch(c, (n, p) => log.push([n, p]));

        c.set(1);
        c.set(2);
        c.set(3);

        assert.deepEqual(log, [[1, 0], [2, 1], [3, 2]]);
    });

    it("does not fire on registration by default", () => {
        const c = signal(42);
        let fired = false;
        watch(c, () => { fired = true; });
        assert.equal(fired, false);
    });

    it("oldValue is the value at the previous fire, not at registration", () => {
        const c = signal("a");
        const log = [];
        watch(c, (n, p) => log.push([n, p]));

        c.set("b");
        c.set("c");
        c.set("d");

        assert.deepEqual(log, [["b", "a"], ["c", "b"], ["d", "c"]]);
    });
});

describe("watch — immediate option", () => {
    it("fires once on registration with oldValue=undefined when immediate=true", () => {
        const c = signal("hello");
        const log = [];
        watch(c, (n, p) => log.push([n, p]), { immediate: true });

        assert.deepEqual(log, [["hello", undefined]]);
    });

    it("subsequent fires after immediate use real previous values, not undefined", () => {
        const c = signal(1);
        const log = [];
        watch(c, (n, p) => log.push([n, p]), { immediate: true });

        c.set(2);
        c.set(3);

        assert.deepEqual(log, [[1, undefined], [2, 1], [3, 2]]);
    });

    it("options object can be omitted entirely", () => {
        const c = signal(0);
        assert.doesNotThrow(() => watch(c, () => {}));
    });

    it("immediate=false behaves identically to omitting options", () => {
        const c = signal(1);
        let count = 0;
        watch(c, () => { count++; }, { immediate: false });
        assert.equal(count, 0);
    });
});

describe("watch — raw getter equality guard (the bug Object.is prevents)", () => {
    it("does NOT fire when getter result is unchanged after dep mutation", () => {
        // The classic case: source maps a continuous value to a boolean. Many
        // dep mutations produce the same boolean — callback must not see them.
        const health = signal(10);
        const log = [];
        watch(() => health() <= 0, (isDead, wasDead) => log.push([isDead, wasDead]));

        // health changes but isDead stays false → no fires
        health.set(9);
        health.set(8);
        health.set(5);
        health.set(1);
        assert.deepEqual(log, []);

        // health crosses threshold → fire once with (true, false)
        health.set(0);
        assert.deepEqual(log, [[true, false]]);

        // dead stays dead, more dep changes, still no fire
        health.set(-1);
        health.set(-5);
        assert.deepEqual(log, [[true, false]]);

        // recovers → fire with (false, true)
        health.set(10);
        assert.deepEqual(log, [[true, false], [false, true]]);
    });

    it("does not fire when getter combines multiple deps but result is stable", () => {
        const a = signal(1);
        const b = signal(2);
        let fires = 0;
        watch(() => a() + b(), () => { fires++; });

        // Compensating changes — sum stays 3
        batch(() => { a.set(2); b.set(1); });
        assert.equal(fires, 0);

        // Real change
        a.set(5);
        assert.equal(fires, 1);
    });

    it("uses Object.is, so NaN → NaN does NOT fire (NaN is treated as equal to itself)", () => {
        const c = signal(NaN);
        let fires = 0;
        watch(c, () => { fires++; });

        c.set(NaN);
        // Note: signal's own equals already short-circuits NaN→NaN, so the
        // effect doesn't even re-run. But the guard inside watch is the
        // defense-in-depth that catches the raw-getter case where the engine
        // can't intervene. This test documents the contract.
        assert.equal(fires, 0);
    });

    it("uses Object.is, so +0 vs -0 DOES fire (Object.is distinguishes them)", () => {
        // Force the source through a getter that returns -0 then +0 from the
        // same signal value — bypasses signal's default Object.is equality so
        // the effect re-runs, and our guard then correctly fires.
        const flag = signal(false);
        let fires = 0;
        let log = [];
        watch(() => (flag() ? +0 : -0), (n, p) => { fires++; log.push([n, p]); });

        flag.set(true);   // -0 → +0, Object.is(+0, -0) === false, must fire
        assert.equal(fires, 1);
        assert.deepEqual(log, [[+0, -0]]);
    });
});

describe("watch — disposal", () => {
    it("dispose function stops the watcher", () => {
        const c = signal(0);
        const log = [];
        const stop = watch(c, (n, p) => log.push([n, p]));

        c.set(1);
        stop();
        c.set(2);
        c.set(3);

        assert.deepEqual(log, [[1, 0]]);
    });

    it("calling dispose twice is safe (idempotent)", () => {
        const c = signal(0);
        const stop = watch(c, () => {});
        stop();
        assert.doesNotThrow(() => stop());
    });

    it("multiple independent watchers on the same source dispose independently", () => {
        const c = signal(0);
        const logA = [];
        const logB = [];
        const stopA = watch(c, (n) => logA.push(n));
        const stopB = watch(c, (n) => logB.push(n));

        c.set(1);
        stopA();
        c.set(2);
        stopB();
        c.set(3);

        assert.deepEqual(logA, [1]);
        assert.deepEqual(logB, [1, 2]);
    });
});

describe("watch — callback untracking", () => {
    it("reads inside callback do NOT register as dependencies", () => {
        const tracked = signal(0);
        const unrelated = signal("a");
        let fires = 0;

        watch(tracked, () => {
            // Reading `unrelated` inside the callback must NOT create a dep
            const _ = unrelated();
            fires++;
        });

        tracked.set(1);
        assert.equal(fires, 1);

        // Changing `unrelated` must NOT trigger the callback
        unrelated.set("b");
        unrelated.set("c");
        assert.equal(fires, 1);

        // Changing the actual tracked source does
        tracked.set(2);
        assert.equal(fires, 2);
    });

    it("writes inside the callback don't accidentally re-trigger this watcher", () => {
        // The callback is allowed to write to other signals; those writes should
        // propagate to other watchers but never re-enter this watcher's effect.
        const trigger = signal(0);
        const side = signal("x");
        const sideLog = [];
        let triggerFires = 0;

        watch(side, (n) => sideLog.push(n));
        watch(trigger, () => {
            triggerFires++;
            side.set("from-trigger-" + triggerFires);
        });

        trigger.set(1);
        // The trigger watcher fired once; its side.set fired the side watcher once.
        assert.equal(triggerFires, 1);
        assert.deepEqual(sideLog, ["from-trigger-1"]);

        trigger.set(2);
        assert.equal(triggerFires, 2);
        assert.deepEqual(sideLog, ["from-trigger-1", "from-trigger-2"]);
    });
});

describe("watch — value semantics across the UNINITIALIZED sentinel", () => {
    it("source value `undefined` is distinguished from 'never ran'", () => {
        // signal initialized to undefined. With a naive `if (oldValue === undefined)`
        // check, the first change FROM undefined → undefined would be misread as
        // "first run" and oldValue would be wrongly reported as undefined again on
        // the SECOND change. The Symbol sentinel prevents this.
        const c = signal(undefined);
        const log = [];
        watch(c, (n, p) => log.push([n, p]));

        c.set("first");
        c.set(undefined);  // back to undefined — must report ('undefined', 'first')
        c.set("second");

        assert.deepEqual(log, [
            ["first", undefined],
            [undefined, "first"],
            ["second", undefined]
        ]);
    });

    it("immediate=true with signal(undefined) calls callback(undefined, undefined)", () => {
        const c = signal(undefined);
        const log = [];
        watch(c, (n, p) => log.push([n, p]), { immediate: true });

        assert.deepEqual(log, [[undefined, undefined]]);
    });
});

describe("watch — source types", () => {
    it("plain signal works as source via auto-callable", () => {
        const c = signal(10);
        const log = [];
        watch(c, (n, p) => log.push([n, p]));

        c.set(20);
        assert.deepEqual(log, [[20, 10]]);
    });

    it("computed works as source", () => {
        const base = signal(5);
        const doubled = computed(() => base() * 2);
        const log = [];
        watch(doubled, (n, p) => log.push([n, p]));

        base.set(7);  // doubled: 10 → 14
        assert.deepEqual(log, [[14, 10]]);
    });

    it("getter closure combining multiple sources works", () => {
        const a = signal(1);
        const b = signal(10);
        const log = [];
        watch(() => a() + b(), (n, p) => log.push([n, p]));

        a.set(2);  // 11 → 12
        b.set(20);  // 12 → 22
        assert.deepEqual(log, [[12, 11], [22, 12]]);
    });
});

describe("watch — reference vs value identity", () => {
    it("object references fire only when reference changes, not on internal mutation", () => {
        const initial = { count: 0 };
        const obj = signal(initial);
        const log = [];
        watch(obj, (n, p) => log.push([n.count, p && p.count, n === p]));

        // Mutating internals does NOT change reference — signal.set isn't called,
        // so the effect never re-runs. No fire.
        obj().count = 5;
        assert.deepEqual(log, []);

        // New reference fires. Note: `initial` (the old ref passed to the callback
        // as `p`) was mutated above, so its `.count` is now 5 — same as the new
        // ref's count. But they're still distinct references.
        obj.set({ count: 5 });
        assert.deepEqual(log, [[5, 5, false]]);

        // Same reference assigned twice — signal's default equals (Object.is)
        // short-circuits on the second set, watch never sees it.
        const ref = { count: 99 };
        obj.set(ref);
        obj.set(ref);
        assert.equal(log.length, 2);
        assert.deepEqual(log[1].slice(0, 2), [99, 5]);
    });
});

describe("watch — batched updates", () => {
    it("multiple sets within a batch coalesce into one watcher fire", () => {
        const c = signal(0);
        const log = [];
        watch(c, (n, p) => log.push([n, p]));

        batch(() => {
            c.set(1);
            c.set(2);
            c.set(3);
        });

        // Only one fire, with the final value vs the pre-batch value
        assert.deepEqual(log, [[3, 0]]);
    });

    it("batch with net-zero change does not fire", () => {
        const c = signal(5);
        let fires = 0;
        watch(c, () => { fires++; });

        batch(() => {
            c.set(10);
            c.set(5);  // back to original
        });

        // Engine's equality check on the final set vs. the prior value short-circuits.
        // This is signal-level behavior, watch sits on top of it.
        assert.equal(fires, 0);
    });
});

describe("watch — composability with other reactive primitives", () => {
    it("watch + effect can observe the same source independently", () => {
        const c = signal(0);
        const watchLog = [];
        const effectLog = [];

        watch(c, (n) => watchLog.push(n));
        effect(() => effectLog.push(c()));

        c.set(1);
        c.set(2);

        assert.deepEqual(watchLog, [1, 2]);
        assert.deepEqual(effectLog, [0, 1, 2]);  // effect runs once on registration
    });

    it("nested watches work — outer watch's callback creates an inner watch", () => {
        const outer = signal(0);
        const inner = signal("a");
        const innerLog = [];
        let innerStop = null;

        watch(outer, (n) => {
            if (innerStop) innerStop();
            if (n > 0) {
                innerStop = watch(inner, (v) => innerLog.push([n, v]));
            }
        });

        outer.set(1);    // inner watcher attached
        inner.set("b");  // logs [1, "b"]
        inner.set("c");  // logs [1, "c"]
        outer.set(2);    // detaches old, attaches new
        inner.set("d");  // logs [2, "d"]

        assert.deepEqual(innerLog, [[1, "b"], [1, "c"], [2, "d"]]);
    });
});
