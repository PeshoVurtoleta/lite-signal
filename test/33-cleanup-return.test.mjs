// Ledger #18 discriminator: cleanup-return semantics preserved, cost relocated.
// Run against ANY corrected version (1.8.0-alpha.0 .. 1.12.0-candidate.1):
//   node --test test/33-cleanup-return.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

test("cleanup return runs before each re-run and on dispose", () => {
    const r = createRegistry();
    const s = r.signal(0);
    const log = [];
    const stop = r.effect(() => { const v = s(); log.push("run" + v); return () => log.push("clean" + v); });
    s.set(1);
    s.set(2);
    stop();
    assert.deepEqual(log, ["run0", "clean0", "run1", "clean1", "run2", "clean2"]);
    r.destroy();
});

// THE case a naive "latch after first run" optimization silently breaks: the first run
// returns nothing, so a latching impl would swap to the raw fn and ignore every later
// cleanup. The cold-helper design has no latch -- the branch is evaluated every run.
test("conditional cleanup return works on ANY run, not just the first", () => {
    const r = createRegistry();
    const g = r.signal(0);
    const log = [];
    const stop = r.effect(() => {
        const v = g();
        if (v % 2 === 1) return () => log.push("c" + v);
        log.push("none" + v);
    });
    g.set(1);
    g.set(2);
    g.set(3);
    stop();
    assert.deepEqual(log, ["none0", "c1", "none2", "c3"]);
    r.destroy();
});

test("composes with imperative onCleanup in call order", () => {
    const r = createRegistry();
    const t = r.signal(0);
    const log = [];
    const stop = r.effect(() => {
        t();
        r.onCleanup(() => log.push("imperative"));
        return () => log.push("returned");
    });
    t.set(1);
    stop();
    assert.deepEqual(log, ["imperative", "returned", "imperative", "returned"]);
    r.destroy();
});

test("a returned cleanup appends when two+ imperative cleanups already made an array", () => {
    // Two onCleanup calls promote node.cleanupFn from a function to an array; the
    // returned cleanup then takes the array-append branch (not the promote branch).
    // All three fire, in registration order, on every re-run and on dispose.
    const r = createRegistry();
    const t = r.signal(0);
    const log = [];
    const stop = r.effect(() => {
        const v = t();
        r.onCleanup(() => log.push("a" + v));   // cleanupFn := fn
        r.onCleanup(() => log.push("b" + v));   // cleanupFn := [a, b]  (now an array)
        return () => log.push("r" + v);          // registerCleanupReturn -> existing.push(ret)
    });
    t.set(1);                                    // flush run 0's cleanups before run 1
    assert.deepEqual(log, ["a0", "b0", "r0"], "all three run-0 cleanups fired in order");
    stop();                                      // dispose flushes run 1's cleanups
    assert.deepEqual(log, ["a0", "b0", "r0", "a1", "b1", "r1"]);
    r.destroy();
});

test("non-function returns are ignored (a value-returning effect body is harmless)", () => {
    const r = createRegistry();
    const s = r.signal(0);
    let runs = 0;
    const stop = r.effect(() => { s(); runs++; return 42; });
    s.set(1);
    assert.equal(runs, 2);
    assert.doesNotThrow(() => stop());
    r.destroy();
});

test("a self-disposing effect body registers no cleanup (gen advanced)", () => {
    const r = createRegistry();
    const s = r.signal(0);
    const log = [];
    let phase = 0;
    let stop;
    stop = r.effect(() => {
        s();
        phase++;
        if (phase === 2) {
            stop();                                  // dispose mid-body: gen advances
            return () => log.push("must-not-run");   // must NOT be registered
        }
        // first run returns nothing, so nothing is registered to fire on the re-run
    });
    s.set(1);   // triggers run 2, which self-disposes and then returns a cleanup
    assert.deepEqual(log, [], "cleanup returned by a self-disposed body must not be registered");
    r.destroy();
});

// Regression guard for the cost itself. An effect that returns NOTHING must not pay for
// the cleanup-return feature: the hot body carries only `if (ret !== undefined)`, and the
// append ladder lives in a cold helper entered only when a body actually returns. This
// pins the SHAPE of the guarantee; the number is pinned by the fanout64 bench (bar 1b).
test("effects that return nothing still deliver correctly (the zero-cost common path)", () => {
    const r = createRegistry();
    const src = r.signal(0);
    let runs = 0;
    for (let i = 0; i < 64; i++) r.effect(() => { src(); runs++; });
    runs = 0;
    r.batch(() => src.set(1));
    assert.equal(runs, 64, "all 64 effects ran once on the batched write");
    r.destroy();
});
