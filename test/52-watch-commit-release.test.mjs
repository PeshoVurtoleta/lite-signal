// watch(): the baseline is committed before the callback runs, and stop() releases the
// watcher's value slots. Both are regressions against the 1.5.2 Watch.js, where
// untrackedFire wrote `oldValue = currentNewValue` AFTER the callback (a throwing
// callback left a stale baseline) and stop() only disposed the effect (a kept stop
// handle kept the last observed value reachable). Every test below is red on 1.5.2
// except the idempotence row, which pins engine behaviour (see its comment).
//
// The release tests enable gc via v8.setFlagsFromString inside this process. That is
// safe only because node:test runs each test file in its own process; never run this
// file in-process alongside other tests (the flag would leak into them).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import {
    signal, batch, watch,
    createRegistry, setDefaultRegistry
} from "../Signal.js";

let r;
beforeEach(() => {
    r = createRegistry({ maxNodes: 256, maxLinks: 1024, onCapacityExceeded: "grow" });
    setDefaultRegistry(r);
});

/** Run fn, expect it to throw `msg`. */
function throwsBoom(fn, msg) {
    assert.throws(fn, (e) => e instanceof Error && e.message === msg);
}

describe("watch -- the baseline is committed before the callback", () => {
    it("a callback that throws once does not leave a stale oldValue", () => {
        const s = signal(0);
        const log = [];
        let thrown = false;
        watch(s, (n, p) => {
            log.push([n, p]);
            if (!thrown) { thrown = true; throw new Error("boom"); }
        });
        throwsBoom(() => s.set(1), "boom");
        s.set(2);
        // 1.5.2: [[1, 0], [2, 0]] -- the throw skipped the baseline write.
        assert.deepEqual(log, [[1, 0], [2, 1]]);
    });

    it("after a throwing fire, the Object.is guard compares against the committed value", () => {
        // Projection a + b: the throwing fire saw 1; a compensating change keeps the
        // projection at 1, so nothing may fire. 1.5.2 compared against the stale 0 and
        // re-fired [1, 0].
        const a = signal(0), b = signal(0);
        const log = [];
        let thrown = false;
        watch(() => a() + b(), (n, p) => {
            log.push([n, p]);
            if (!thrown) { thrown = true; throw new Error("boom"); }
        });
        throwsBoom(() => a.set(1), "boom");
        batch(() => { a.set(0); b.set(1); });
        assert.deepEqual(log, [[1, 0]]);
        a.set(5);
        assert.deepEqual(log, [[1, 0], [6, 1]]);
    });

    it("an immediate watcher whose first post-registration fire throws resumes from that value", () => {
        const s = signal("a");
        const log = [];
        let n = 0;
        watch(s, (next, prev) => {
            log.push([next, prev]);
            if (++n === 2) throw new Error("boom");
        }, { immediate: true });
        throwsBoom(() => s.set("b"), "boom");
        s.set("c");
        assert.deepEqual(log, [["a", undefined], ["b", "a"], ["c", "b"]]);
    });
});

// ---------------------------------------------------------------------------
// stop() releases the value slots. Probe: the payload is the watcher's last observed
// value; after stop() the source signal is moved off it, so only the watcher's own
// slots can still reach it. Callbacks log tags, never the payload itself.
// ---------------------------------------------------------------------------

function enableGc() {
    v8.setFlagsFromString("--expose-gc");
    return vm.runInNewContext("gc");
}

/** WeakRef targets stay alive until the current job ends: yield, then collect. */
async function collect(gc) {
    await new Promise((res) => setTimeout(res, 0));
    gc(); gc();
}

describe("watch -- stop() releases the last observed value", () => {
    it("stop() from outside: a kept stop handle does not retain the last value", async () => {
        const gc = enableGc();
        const s = signal(null);
        let fires = 0;
        let ref = null;
        const stop = watch(s, () => { fires++; });
        (() => {
            const payload = { big: new Array(4096).fill(1) };
            ref = new WeakRef(payload);
            s.set(payload);
        })();
        assert.equal(fires, 1);
        stop();
        s.set(null);
        await collect(gc);
        assert.equal(typeof stop, "function");   // the handle is still held here
        assert.equal(ref.deref(), undefined);    // 1.5.2: retained (oldValue)
        assert.equal(fires, 1);                  // and the watcher is dead
    });

    it("stop() from inside the callback (the handle kept by the caller)", async () => {
        const gc = enableGc();
        const s = signal(null);
        let kept = null;
        let fires = 0;
        let ref = null;
        watch(s, (n, p, stop) => { fires++; kept = stop; stop(); });
        (() => {
            const payload = { big: new Array(4096).fill(1) };
            ref = new WeakRef(payload);
            s.set(payload);
        })();
        s.set(null);
        await collect(gc);
        assert.equal(typeof kept, "function");
        assert.equal(ref.deref(), undefined);    // 1.5.2: retained (the post-callback write)
        assert.equal(fires, 1);
    });

    it("stop() inside the immediate fire (the wantsStopEarly path) releases and disposes", async () => {
        const gc = enableGc();
        let ref = null;
        let fires = 0;
        const s = signal(null);
        let stop = null;
        (() => {
            const payload = { big: new Array(4096).fill(1) };
            ref = new WeakRef(payload);
            s.set(payload);
            stop = watch(s, (n, p, st) => { fires++; st(); }, { immediate: true });
        })();
        s.set(null);
        s.set(1);
        await collect(gc);
        assert.equal(typeof stop, "function");
        assert.equal(fires, 1);                  // disposed: the later writes did not fire
        assert.equal(ref.deref(), undefined);    // 1.5.2: retained (oldValue)
    });

    // Pins ENGINE behaviour, not a Watch.js clear: the engine dispose handle has its own
    // `disposed` flag and birth-gen guard, so no Watch.js mutant can turn this row red.
    it("stop() is idempotent: repeated calls are no-ops, inside and outside the callback", () => {
        const s = signal(0);
        const log = [];
        const stop = watch(s, (n, p, st) => { log.push([n, p]); st(); st(); });
        s.set(1);
        stop();
        stop();
        s.set(2);
        assert.deepEqual(log, [[1, 0]]);
        // The disposed node's slot is recycled by a new effect; a late stop() must not
        // touch the new resident.
        const t = signal(0);
        const seen = [];
        watch(t, (n) => { seen.push(n); });
        stop();
        t.set(7);
        assert.deepEqual(seen, [7]);
    });
});

// ---------------------------------------------------------------------------
// stop() drops the engine dispose handle. That handle closes over the registry's
// scope (its node pool), so a kept handle would keep the whole registry -- and every
// value its nodes hold -- reachable. Probe: a throwaway registry holds a payload in an
// unrelated signal; the source reads through a holder cleared after stop(), and the
// callback closes over nothing of the registry, so the kept stop handle's only path
// to the registry is the dispose handle. One row per release site in Watch.js: the
// outside stop() and the wantsStopEarly path (stop() inside the immediate fire).
// ---------------------------------------------------------------------------

describe("watch -- stop() drops the engine dispose handle", () => {
    it("stop() from outside: a kept stop handle does not retain the registry", async () => {
        const gc = enableGc();
        const holder = { s: null };
        let ref = null, stop = null, fires = 0;
        (() => {
            const r2 = createRegistry();
            setDefaultRegistry(r2);
            const payload = { big: new Array(4096).fill(1) };
            ref = new WeakRef(payload);
            r2.signal(payload);                  // held only by r2's node pool
            holder.s = r2.signal(0);
            stop = watch(() => holder.s(), () => { fires++; });
            holder.s.set(1);
            stop();
            holder.s = null;
            setDefaultRegistry(r);
        })();
        await collect(gc);
        assert.equal(typeof stop, "function");   // the handle is still held here
        assert.equal(fires, 1);
        assert.equal(ref.deref(), undefined);    // 1.5.2: retained (stopFn -> registry)
    });

    it("stop() inside the immediate fire (wantsStopEarly): a kept stop handle does not retain the registry", async () => {
        const gc = enableGc();
        const holder = { s: null };
        let ref = null, stop = null, fires = 0;
        (() => {
            const r2 = createRegistry();
            setDefaultRegistry(r2);
            const payload = { big: new Array(4096).fill(1) };
            ref = new WeakRef(payload);
            r2.signal(payload);                  // held only by r2's node pool
            holder.s = r2.signal(0);
            stop = watch(() => holder.s(), (n, p, st) => { fires++; st(); }, { immediate: true });
            holder.s.set(1);
            holder.s = null;
            setDefaultRegistry(r);
        })();
        await collect(gc);
        assert.equal(typeof stop, "function");
        assert.equal(fires, 1);                  // disposed: the later write did not fire
        assert.equal(ref.deref(), undefined);    // 1.5.2: retained (stopFn -> registry)
    });
});
