// when(): the cancel handle drops the engine dispose handle once the watcher is done --
// after the predicate fires, and after an explicit cancel. On the 1.5.2 / 7676dac
// Watch.js, when() never cleared `stopFn`, so a kept cancel handle kept the engine
// dispose handle, and through it the whole registry (every value its nodes hold),
// reachable for as long as the caller held the handle. The four release rows are red
// on 7676dac. Three go through stop() (a later fire, an explicit cancel, cancel inside
// the callback) and one through the wantsStopEarly path (predicate truthy at
// registration); removing `stopFn = null` at either site turns that site's rows red.
// These rows clear the predicate's holder, so they isolate the engine dispose handle; the
// predicate / callback slots themselves are pinned by the burst-30 rows further down.
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

// ---------------------------------------------------------------------------
// Burst 30: the kept handle must also drop predicate + callback. These rows let the
// predicate close DIRECTLY over an r2 signal (no holder clearing) and the callback over
// a second WeakRef'd payload, so the closure slots themselves are the path under test.
// Red on 01c00bc (kept handle still references predicate + callback): A1, A1s, A2, A3,
// A4, A5, A8b, A9b. Pins green on 01c00bc: A8, A9, A10. A6 / A7 (cancel inside the
// predicate / callback AT REGISTRATION) are not expressible: the handle does not exist
// until when() returns, so there is nothing to call.
// ---------------------------------------------------------------------------

/** Like probe(), but also WeakRefs a callback payload; run(r2, cb) returns the handle(s). */
async function probe2(run) {
    const gc = enableGc();
    let regRef = null, cbRef = null, out = null;
    (() => {
        const r2 = createRegistry();
        setDefaultRegistry(r2);
        const payload = { big: new Array(4096).fill(1) };
        regRef = new WeakRef(payload);
        r2.signal(payload);                  // held only by r2's node pool
        const cb = { big: new Array(4096).fill(2) };
        cbRef = new WeakRef(cb);
        out = run(r2, cb);
        setDefaultRegistry(r);
    })();
    await collect(gc);
    return {
        out,
        regRetained: regRef.deref() !== undefined,
        cbRetained: cbRef.deref() !== undefined
    };
}

// Built in separate function scopes so the two closures do not share a V8 context: each
// slot is then the only path to its own payload, which pins each `= null` on its own.
function predOf(s) { return () => s() > 0; }
function counterOf(cb, cnt) { return () => { cnt.n += cb.big.length > 0 ? 1 : 100; }; }

describe("when -- a kept handle drops predicate and callback (closure slots)", () => {
    it("A1 after a later fire", async () => {
        let fires = 0;
        const { out, regRetained, cbRetained } = await probe2((r2, cb) => {
            const s = r2.signal(0);
            const cancel = when(() => s() > 0, () => { fires += cb.big.length > 0 ? 1 : 100; });
            s.set(1);
            return cancel;
        });
        assert.equal(typeof out, "function");
        assert.equal(fires, 1);
        assert.equal(regRetained, false, "registry payload retained");
        assert.equal(cbRetained, false, "callback payload retained");
    });

    it("A1s after a later fire, predicate and callback in separate scopes: each slot released", async () => {
        const cnt = { n: 0 };
        const { out, regRetained, cbRetained } = await probe2((r2, cb) => {
            const s = r2.signal(0);
            const cancel = when(predOf(s), counterOf(cb, cnt));
            s.set(1);
            return cancel;
        });
        assert.equal(typeof out, "function");
        assert.equal(cnt.n, 1);
        assert.equal(regRetained, false, "predicate slot retained (registry payload)");
        assert.equal(cbRetained, false, "callback slot retained (callback payload)");
    });

    it("A2 after an explicit cancel before the fire", async () => {
        let fires = 0;
        const { out, regRetained, cbRetained } = await probe2((r2, cb) => {
            const s = r2.signal(0);
            const cancel = when(() => s() > 0, () => { fires += cb.big.length > 0 ? 1 : 100; });
            cancel();
            s.set(1);
            return cancel;
        });
        assert.equal(typeof out, "function");
        assert.equal(fires, 0);
        assert.equal(regRetained, false, "registry payload retained");
        assert.equal(cbRetained, false, "callback payload retained");
    });

    it("A3 predicate truthy at registration (wantsStopEarly)", async () => {
        let fires = 0;
        const { out, regRetained, cbRetained } = await probe2((r2, cb) => {
            const s = r2.signal(1);
            const cancel = when(() => s() > 0, () => { fires += cb.big.length > 0 ? 1 : 100; });
            s.set(2);
            return cancel;
        });
        assert.equal(typeof out, "function");
        assert.equal(fires, 1);
        assert.equal(regRetained, false, "registry payload retained");
        assert.equal(cbRetained, false, "callback payload retained");
    });

    it("A4 cancel() inside a later predicate run that returns falsy", async () => {
        let fires = 0;
        let cancel = null;
        const { out, regRetained, cbRetained } = await probe2((r2, cb) => {
            const s = r2.signal(0);
            cancel = when(() => {
                if (s() === 1) { cancel(); return false; }
                return false;
            }, () => { fires += cb.big.length > 0 ? 1 : 100; });
            s.set(1);                        // must not throw
            s.set(2);
            return cancel;
        });
        assert.equal(typeof out, "function");
        assert.equal(fires, 0);
        assert.equal(regRetained, false, "registry payload retained");
        assert.equal(cbRetained, false, "callback payload retained");
    });

    it("A5 cancel() inside a later predicate run that returns truthy: cancel wins", async () => {
        let fires = 0;
        let cancel = null;
        const { out, regRetained, cbRetained } = await probe2((r2, cb) => {
            const s = r2.signal(0);
            cancel = when(() => {
                if (s() === 1) { cancel(); return true; }
                return false;
            }, () => { fires += cb.big.length > 0 ? 1 : 100; });
            s.set(1);                        // must not throw
            s.set(2);
            return cancel;
        });
        assert.equal(typeof out, "function");
        assert.equal(fires, 0);              // 01c00bc: 1 (callback still fires after cancel)
        assert.equal(regRetained, false, "registry payload retained");
        assert.equal(cbRetained, false, "callback payload retained");
    });
});

describe("when -- a callback that throws on a later fire", () => {
    // A8 pins the throw surface on 01c00bc (green there and on head): the throw of a
    // later-fire callback propagates out of s.set(); fired is already true so later
    // writes never refire, and stop() was skipped so the effect stays live and the kept
    // handle (not cancelled) retains the registry. A8b: cancel() then releases (red).
    function build(withCancel) {
        let fires = 0, thrown = null, cancel = null, predCalls = 0;
        return probe2((r2, cb) => {
            const s = r2.signal(0);
            cancel = when(() => { predCalls++; return s() > 0; }, () => {
                fires++;
                if (cb.big.length > 0) throw new Error("boom");
            });
            // Keep only the message: a kept Error with an unformatted .stack keeps its call-site
            // frames (and through them r2 and the callback) alive, which would mask A8b and
            // make A8's retention pin pass for the wrong reason.
            try { s.set(1); } catch (e) { thrown = e instanceof Error ? e.message : e; }
            s.set(2);                        // already fired: must not refire
            if (withCancel) cancel();
            return cancel;
        }).then((res) => ({ ...res, fires, thrown, predCalls }));
    }

    it("A8 throw surfaces from s.set(); no refire; live effect retains the registry", async () => {
        const { out, regRetained, fires, thrown, predCalls } = await build(false);
        assert.equal(typeof out, "function");
        assert.equal(thrown, "boom");
        assert.equal(fires, 1);
        // registration + s.set(1); the write after the throw re-runs the live effect, which
        // must exit at the first `done` guard without calling the predicate again
        assert.equal(predCalls, 2);
        assert.equal(regRetained, true);     // live effect + uncancelled handle
    });

    it("A8b then cancel() releases registry and callback", async () => {
        const { out, regRetained, cbRetained, fires } = await build(true);
        assert.equal(typeof out, "function");
        assert.equal(fires, 1);
        assert.equal(regRetained, false, "registry payload retained");
        assert.equal(cbRetained, false, "callback payload retained");
    });
});

describe("when -- owner-disposed watcher (D2: documented, not fixed)", () => {
    // The owner is an effect (createRoot() returns fn()'s result and has no dispose).
    // A9 pins that the kept handle of an owner-disposed, never-fired when() retains
    // (green on both); A9b: calling the kept handle releases (red on 01c00bc).
    function ownerBuild(callHandle) {
        let fires = 0;
        return probe2((r2, cb) => {
            const s = r2.signal(0);
            let cancel = null;
            const owner = r2.effect(() => {
                cancel = when(() => s() > 0, () => { fires += cb.big.length > 0 ? 1 : 100; });
            });
            owner();                         // dispose the owner before the fire
            s.set(1);
            if (callHandle) cancel();
            return cancel;
        }).then((res) => ({ ...res, fires }));
    }

    it("A9 kept handle retains (pin)", async () => {
        const { out, regRetained, fires } = await ownerBuild(false);
        assert.equal(typeof out, "function");
        assert.equal(fires, 0);
        assert.equal(regRetained, true);
    });

    it("A9b calling the kept handle releases", async () => {
        const { out, regRetained, cbRetained, fires } = await ownerBuild(true);
        assert.equal(typeof out, "function");
        assert.equal(fires, 0);
        assert.equal(regRetained, false, "registry payload retained");
        assert.equal(cbRetained, false, "callback payload retained");
    });
});

describe("when -- stale cancel handles after owner disposal (regression pin)", () => {
    it("A10 1000 stale handles called after slot reuse: no throw, no collateral", () => {
        const s = r.signal(0);
        const handles = [];
        const owner = r.effect(() => {
            for (let i = 0; i < 1000; i++) handles.push(when(() => s() > 0, () => {}));
        });
        assert.equal(handles.length, 1000);
        owner();                             // cascades: every when() is disposed
        let newFires = 0, sibRuns = 0;
        when(() => s() > 0, () => { newFires++; });
        r.effect(() => { sibRuns++; s(); });
        for (let i = 0; i < 1000; i++) handles[i]();   // must not throw or hit residents
        s.set(1);
        assert.equal(newFires, 1);
        assert.equal(sibRuns, 2);
    });
});
