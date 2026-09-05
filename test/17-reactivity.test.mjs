// 17-reactivity.test.mjs — behavioral suite mirroring the universal signal-system bug
// classes seen across alien-signals' closed issues. Each test asserts lite-signal's
// behavior for a class; we test the BEHAVIOR, not anyone's implementation.
//
// Architecture mapping (does lite even have the mechanism that caused the bug?):
//   1 subscription lifecycle ....... YES (links / observeObservers)
//   2 effect cleanup ordering ...... YES (onCleanup)
//   3 stale dependency tracking .... YES (cursor retracking)
//   4 batching / timing ............ YES (batch; lite is synchronous — no microtask queue)
//   5 equality cutoff .............. YES (Object.is default + custom equals)
//   6 nested invalidation .......... YES (computed chains)
//   7 memory / retained nodes ...... YES (pool + dispose + stats)
//   8 async boundary ............... PARTIAL — lite is sync; tracking is scoped to the
//                                     synchronous body, so cross-boundary reads can't leak
//   9 SSR hydration ................ N/A — lite has no render/DOM layer (see skipped test)
//  10 scheduler starvation/loops ... YES (maxFlushPasses + cycle flag)
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("1 · subscription lifecycle", () => {
  it("subscribes on read, unsubscribes on dispose", () => {
    const a = r.signal(0);
    assert.equal(r.hasObservers(a), false);
    const d = r.effect(() => a());
    assert.equal(r.hasObservers(a), true);
    d();
    assert.equal(r.hasObservers(a), false);
  });
  it("stays observed until the LAST observer leaves (0→1→…→0)", () => {
    const a = r.signal(0);
    const d1 = r.effect(() => a()), d2 = r.effect(() => a());
    d1(); assert.equal(r.hasObservers(a), true, "still observed by d2");
    d2(); assert.equal(r.hasObservers(a), false);
  });
  it("re-subscribing after full dispose tracks freshly", () => {
    const a = r.signal(1); let v;
    r.effect(() => { v = a(); })();
    const d2 = r.effect(() => { v = a() * 10; });
    a.set(5); assert.equal(v, 50);
    d2();
  });
});

describe("2 · effect cleanup ordering", () => {
  it("cleanup runs before each re-execution", () => {
    const a = r.signal(0); const order = [];
    r.effect(() => { a(); order.push("run"); r.onCleanup(() => order.push("cleanup")); });
    a.set(1); a.set(2);
    assert.deepEqual(order, ["run", "cleanup", "run", "cleanup", "run"]);
  });
  it("cleanup runs on dispose", () => {
    const a = r.signal(0); let cleaned = 0;
    r.effect(() => { a(); r.onCleanup(() => cleaned++); })();
    assert.equal(cleaned, 1);
  });
  it("multiple cleanups fire in registration order", () => {
    const a = r.signal(0); const order = [];
    r.effect(() => { a(); r.onCleanup(() => order.push("A")); r.onCleanup(() => order.push("B")); })();
    assert.deepEqual(order, ["A", "B"]);
  });
});

describe("3 · stale dependency tracking", () => {
  it("conditional dep drops the unused branch", () => {
    const use = r.signal(true), a = r.signal(1), b = r.signal(2);
    let runs = 0, v;
    r.effect(() => { runs++; v = use() ? a() : b(); });
    let r0 = runs; b.set(20); assert.equal(runs, r0, "b not tracked while use=true");
    use.set(false); assert.equal(v, 20);
    r0 = runs; a.set(10); assert.equal(runs, r0, "a dropped after switch");
  });
  it("a dep read only in an earlier run is not retained", () => {
    const gate = r.signal(true), x = r.signal(1); let v;
    r.effect(() => { v = gate() ? x() : 0; });
    gate.set(false); const before = v;
    x.set(999); assert.equal(v, before, "stale dep x dropped");
  });
});

describe("4 · batching / timing", () => {
  it("batched writes coalesce to one run with final values", () => {
    const a = r.signal(0), b = r.signal(0); let runs = 0, sum;
    r.effect(() => { runs++; sum = a() + b(); });
    const r0 = runs;
    r.batch(() => { a.set(1); b.set(2); a.set(3); });
    assert.equal(runs, r0 + 1); assert.equal(sum, 5);
  });
  it("nested batches flush at the outermost boundary", () => {
    const a = r.signal(0); let runs = 0;
    r.effect(() => { a(); runs++; });
    const r0 = runs;
    r.batch(() => { a.set(1); r.batch(() => a.set(2)); a.set(3); });
    assert.equal(runs, r0 + 1);
  });
  it("set-then-revert within a batch produces no propagation", () => {
    const a = r.signal(5); let runs = 0;
    r.effect(() => { a(); runs++; });
    const r0 = runs;
    r.batch(() => { a.set(99); a.set(5); });
    assert.equal(runs, r0, "net-zero batch → no re-run");
  });
  it("writing an equal value is a no-op", () => {
    const a = r.signal(7); let runs = 0;
    r.effect(() => { a(); runs++; });
    const r0 = runs; a.set(7); assert.equal(runs, r0);
  });
});

describe("5 · equality cutoff", () => {
  it("NaN === NaN under Object.is → no spurious update", () => {
    const a = r.signal(NaN); let runs = 0;
    r.effect(() => { a(); runs++; });
    const r0 = runs; a.set(NaN); assert.equal(runs, r0);
  });
  it("+0 and -0 are distinct (Object.is)", () => {
    const a = r.signal(0); let runs = 0;
    r.effect(() => { a(); runs++; });
    const r0 = runs; a.set(-0); assert.equal(runs, r0 + 1);
  });
  it("a new object reference always triggers; same reference does not", () => {
    const a = r.signal({ n: 1 }); let runs = 0;
    r.effect(() => { a(); runs++; });
    let r0 = runs; a.set({ n: 1 }); assert.equal(runs, r0 + 1, "different identity triggers");
    r0 = runs; a.set(a.peek()); assert.equal(runs, r0, "same reference is a no-op");
  });
  it("custom equals predicate is honored", () => {
    const a = r.signal({ id: 1 }, { equals: (p, n) => p.id === n.id }); let runs = 0;
    r.effect(() => { a(); runs++; });
    let r0 = runs; a.set({ id: 1 }); assert.equal(runs, r0, "same id → suppressed");
    a.set({ id: 2 }); assert.equal(runs, r0 + 1, "different id → fires");
  });
});

describe("6 · nested computation invalidation", () => {
  it("computed updates when nested (a→b→c)", () => {
    const a = r.signal(1);
    const b = r.computed(() => a() + 1);
    const c = r.computed(() => b() + 1);
    assert.equal(c(), 3); a.set(2); assert.equal(c(), 4);
  });
  it("diamond is glitch-free: one run, consistent value", () => {
    const a = r.signal(1);
    const b = r.computed(() => a() + 1);
    const c2 = r.computed(() => a() + 10);
    const d = r.computed(() => b() + c2());
    let runs = 0, v;
    r.effect(() => { runs++; v = d(); });
    const r0 = runs; a.set(2);
    assert.equal(v, (2 + 1) + (2 + 10), "consistent");
    assert.equal(runs, r0 + 1, "runs once, not twice");
  });
  it("deep chain (20 levels) propagates", () => {
    const a = r.signal(0); let node = a;
    for (let i = 0; i < 20; i++) { const prev = node; node = r.computed(() => prev() + 1); }
    assert.equal(node(), 20); a.set(100); assert.equal(node(), 120);
  });
});

describe("7 · memory / retained nodes", () => {
  it("disposing an effect frees its links", () => {
    const a = r.signal(0); const baseL = r.stats().activeLinks;
    const d = r.effect(() => a());
    assert.ok(r.stats().activeLinks > baseL);
    d(); assert.equal(r.stats().activeLinks, baseL, "links freed");
  });
  it("no link accumulation across 100 create/dispose cycles", () => {
    const a = r.signal(0); const baseL = r.stats().activeLinks;
    for (let i = 0; i < 100; i++) r.effect(() => a())();
    assert.equal(r.stats().activeLinks, baseL, "no leak");
  });
});

describe("8 · async boundary", () => {
  it("reads outside the synchronous body are not tracked", async () => {
    const a = r.signal(1), b = r.signal(2); let runs = 0, deferred;
    r.effect(() => { runs++; a(); deferred = () => b(); });  // capture a read for later
    const r0 = runs;
    deferred();                       // run it OUTSIDE the tracking window
    b.set(99); await Promise.resolve();
    assert.equal(runs, r0, "deferred read created no dependency");
  });
});

describe("9 · SSR hydration", () => {
  it("N/A — lite-signal has no render/DOM/hydration layer", { skip: true }, () => {});
});

describe("10 · scheduler & loops", () => {
  it("a self-writing effect terminates (no infinite flush)", () => {
    const a = r.signal(0); let runs = 0, err = null;
    try { r.effect(() => { runs++; const v = a(); if (v < 3) a.set(v + 1); }); }
    catch (e) { err = e; }
    assert.ok(runs >= 1 && runs < 100, `bounded (runs=${runs}${err ? ", "+err.message : ""})`);
  });
  it("a computed that reads itself does not hang", () => {
    let c, val, err = null;
    c = r.computed(() => (c ? c() : 0));
    try { val = c(); } catch (e) { err = e; }
    assert.ok(err instanceof Error || typeof val === "number", "handled, not hung");
  });
});

describe("11 · differential-review additions", () => {
  it("computed errors are cached and re-thrown without re-evaluating", () => {
    const trigger = r.signal(1); let evals = 0;
    const c = r.computed(() => { evals++; if (trigger() === 1) throw new Error("boom"); return "ok"; });
    assert.throws(() => c(), /boom/); assert.equal(evals, 1);
    assert.throws(() => c(), /boom/); assert.equal(evals, 1, "cached error, not re-run");
    trigger.set(2); assert.equal(c(), "ok"); assert.equal(evals, 2, "dep change clears the error cache");
  });
  it("a computed read mid-batch resolves to the latest value (pull-based)", () => {
    const a = r.signal(1); const b = r.computed(() => a() * 2); let runs = 0;
    r.effect(() => { b(); runs++; });
    r.batch(() => { a.set(2); assert.equal(b(), 4, "fresh mid-batch"); a.set(3); assert.equal(b(), 6, "fresh mid-batch"); });
    assert.equal(runs, 2, "effect flushed once at batch end");
  });
  it("a computed getter that disposes its own observer mid-eval does not crash", () => {
    const shouldDispose = r.signal(false); let n = 0, dispose;
    const bad = r.computed(() => { if (shouldDispose() && dispose) dispose(); return ++n; });
    dispose = r.effect(() => { bad(); });
    assert.doesNotThrow(() => shouldDispose.set(true));
  });
  it("a throwing effect setup returns its slot to the pool (no node/link leak)", () => {
    const base = r.stats(); const a = r.signal(0);
    try { r.effect(() => { a(); throw new Error("crash"); }); } catch { /* expected */ }
    const post = r.stats();
    assert.equal(post.activeNodes, base.activeNodes + 1, "only signal 'a' remains; effect slot returned");
    assert.equal(post.activeLinks, base.activeLinks, "no phantom link left on 'a'");
  });
  it("computed equality cutoff halts downstream when its output is unchanged", () => {
    const a = r.signal(1); let runs = 0;
    const positive = r.computed(() => a() > 0);
    r.effect(() => { positive(); runs++; });
    const r0 = runs; a.set(2); a.set(10);     // 'a' changes but 'positive' stays true
    assert.equal(runs, r0, "unchanged computed output → no downstream run");
  });
  it("a self-mutating effect is self-protected: runs once, no loop, no throw", () => {
    // lite's deliberate contract (matches alien's self-protection): the currently-running
    // effect is NOT re-triggered by its own write — it is NOT a thrown CycleError.
    const a = r.signal(0); let runs = 0, threw = null;
    try { r.effect(() => { runs++; a.set(a() + 1); }); } catch (e) { threw = e; }
    assert.equal(runs, 1, "own write does not re-trigger the running effect");
    assert.equal(a.peek(), 1);
    assert.equal(threw, null, "graceful self-protection, not an error");
  });
});
