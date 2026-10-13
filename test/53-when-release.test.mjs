// when(): the cancel handle drops the engine dispose handle once the watcher is done --
// after the predicate fires, and after an explicit cancel. On the 1.5.2 / 7676dac
// Watch.js, when() never cleared `stopFn`, so a kept cancel handle kept the engine
// dispose handle, and through it the whole registry (every value its nodes hold),
// reachable for as long as the caller held the handle. The four release rows are red
// on 7676dac. Three go through stop() (a later fire, an explicit cancel, cancel inside
// the callback) and one through the wantsStopEarly path (predicate truthy at
// registration); removing `stopFn = null` at either site turns that site's rows red.
// Scope: the rows clear the predicate's holder, because a kept handle still references
// predicate and callback (shared closure context) -- that retention is not fixed here.
//
// The premise rows pin the engine fact the release rows rest on: a kept effect dispose
// handle -- live OR already disposed -- keeps its registry reachable. If an engine
// change ever breaks that, the release rows would pass on a when() that still leaks,
// so the premise rows fail first and say so.
//
// The tests enable gc via v8.setFlagsFromString inside this process. That is safe only
// because node:test runs each test file in its own process; never run this file
// in-process alongside other tests (the flag would leak into them).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import {
    when, whenAsync,
    createRegistry, setDefaultRegistry
} from "../Signal.js";

let r;
beforeEach(() => {
    r = createRegistry({ maxNodes: 256, maxLinks: 1024, onCapacityExceeded: "grow" });
    setDefaultRegistry(r);
});

function enableGc() {
    v8.setFlagsFromString("--expose-gc");
    return vm.runInNewContext("gc");
}

/** WeakRef targets stay alive until the current job ends: yield, then collect. */
async function collect(gc) {
    await new Promise((res) => setTimeout(res, 0));
    gc(); gc();
}

// Probe shape (as test/52): a throwaway registry r2 holds a payload in an unrelated
// signal, so the payload is reachable only through r2's node pool. The predicate reads
// through a holder that is cleared before collection, and the callback closes over
// nothing of r2, so the kept handle's only path to r2 is the engine dispose handle.
// `run(r2, holder)` builds the watcher and returns the handle to keep.
async function probe(run) {
    const gc = enableGc();
    const holder = { s: null };
    let ref = null, kept = null;
    (() => {
        const r2 = createRegistry();
        setDefaultRegistry(r2);
        const payload = { big: new Array(4096).fill(1) };
        ref = new WeakRef(payload);
        r2.signal(payload);                  // held only by r2's node pool
        kept = run(r2, holder);
        holder.s = null;
        setDefaultRegistry(r);
    })();
    await collect(gc);
    return { kept, retained: ref.deref() !== undefined };
}

describe("when -- premise: a kept effect dispose handle retains its registry", () => {
    it("a kept live effect handle keeps the registry payload alive", async () => {
        const { kept, retained } = await probe((r2) => r2.effect(() => {}));
        assert.equal(typeof kept, "function");
        assert.equal(retained, true);        // engine fact; if false, the rows below are vacuous
    });

    it("a kept DISPOSED effect handle keeps the registry payload alive", async () => {
        const { kept, retained } = await probe((r2) => {
            const d = r2.effect(() => {});
            d();
            return d;
        });
        assert.equal(typeof kept, "function");
        assert.equal(retained, true);        // engine fact; if false, the rows below are vacuous
    });
});

describe("when -- a kept cancel handle does not retain the registry", () => {
    it("after the predicate fires later (stop() from the effect)", async () => {
        let fires = 0;
        const { kept, retained } = await probe((r2, holder) => {
            holder.s = r2.signal(0);
            const cancel = when(() => holder.s() > 0, () => { fires++; });
            holder.s.set(1);
            return cancel;
        });
        assert.equal(typeof kept, "function"); // the handle is still held here
        assert.equal(fires, 1);
        assert.equal(retained, false);       // 7676dac: retained (stopFn -> registry)
    });

    it("after an explicit cancel before the predicate fires", async () => {
        let fires = 0;
        const { kept, retained } = await probe((r2, holder) => {
            holder.s = r2.signal(0);
            const cancel = when(() => holder.s() > 0, () => { fires++; });
            cancel();
            holder.s.set(1);                 // cancelled: must not fire
            return cancel;
        });
        assert.equal(typeof kept, "function");
        assert.equal(fires, 0);
        assert.equal(retained, false);       // 7676dac: retained (stopFn -> registry)
    });

    it("after the predicate is truthy at registration (wantsStopEarly path)", async () => {
        let fires = 0;
        const { kept, retained } = await probe((r2, holder) => {
            holder.s = r2.signal(1);
            const cancel = when(() => holder.s() > 0, () => { fires++; });
            holder.s.set(2);                 // disposed at registration: must not fire again
            return cancel;
        });
        assert.equal(typeof kept, "function");
        assert.equal(fires, 1);
        assert.equal(retained, false);       // 7676dac: retained (stopFn -> registry)
    });

    it("cancel() inside the callback, then again from outside: fires once, releases", async () => {
        let fires = 0;
        let cancel = null;
        const { kept, retained } = await probe((r2, holder) => {
            holder.s = r2.signal(0);
            cancel = when(() => holder.s() > 0, () => { fires++; cancel(); });
            holder.s.set(1);
            cancel();                        // idempotent: no throw, no second dispose effect
            holder.s.set(2);
            return cancel;
        });
        assert.equal(typeof kept, "function");
        assert.equal(fires, 1);
        assert.equal(retained, false);       // 7676dac: retained (stopFn -> registry)
    });
});

describe("when -- cancel() after the watcher is done is a no-op", () => {
    it("cancel() after fire, twice, and after registry destroy() does not throw", () => {
        const r2 = createRegistry();
        setDefaultRegistry(r2);
        const s = r2.signal(0);
        let fires = 0;
        const cancel = when(() => s() > 0, () => { fires++; });
        s.set(1);
        cancel();
        cancel();
        r2.destroy();
        cancel();
        setDefaultRegistry(r);
        assert.equal(fires, 1);
    });
});

// whenAsync() discards when()'s cancel handle and the Promise holds no path back to the
// registry, so a kept promise never kept it alive. Pinned (green on 7676dac too) so a
// future whenAsync that stores the handle on the promise cannot regress silently.
describe("whenAsync -- a kept promise does not retain the registry", () => {
    it("a kept resolved promise", async () => {
        const { kept, retained } = await probe((r2, holder) => {
            holder.s = r2.signal(0);
            const p = whenAsync(() => holder.s() > 0);
            holder.s.set(1);
            return p;
        });
        assert.ok(kept instanceof Promise);
        await kept;                          // resolved before collection
        assert.equal(retained, false);
    });

    it("a kept pending promise (its registry otherwise unreachable)", async () => {
        const { kept, retained } = await probe((r2, holder) => {
            holder.s = r2.signal(0);
            return whenAsync(() => holder.s() > 0);
        });
        assert.ok(kept instanceof Promise);
        assert.equal(retained, false);
    });
});
