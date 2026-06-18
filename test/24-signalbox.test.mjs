import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

test("signalBox: basic get/set", {skip: true}, () => {
    const r = createRegistry();
    const s = r.signalBox(5);
    assert.equal(s.get(), 5);
    s.set(10);
    assert.equal(s.get(), 10);
});

test("computedBox: derives + memoizes",  {skip: true}, () => {
    const r = createRegistry();
    const a = r.signalBox(2), b = r.signalBox(3);
    let runs = 0;
    const c = r.computedBox(() => { runs++; return a.get() * b.get(); });
    assert.equal(c.get(), 6);
    assert.equal(c.get(), 6);   // cached
    assert.equal(runs, 1);
    a.set(4);
    assert.equal(c.get(), 12);
    assert.equal(runs, 2);
});

test("box: peek does not track",  {skip: true}, () => {
    const r = createRegistry();
    const a = r.signalBox(1);
    let runs = 0;
    r.effect(() => { runs++; a.peek(); });
    assert.equal(runs, 1);
    a.set(2);
    assert.equal(runs, 1);   // peek didn't subscribe
});

test("box: update applies fn",  {skip: true}, () => {
    const r = createRegistry();
    const a = r.signalBox(10);
    a.update(n => n + 5);
    assert.equal(a.get(), 15);
});

test("box: subscribe fires on change, untracks callback",  {skip: true}, () => {
    const r = createRegistry();
    const a = r.signalBox(0);
    const seen = [];
    const unsub = a.subscribe(v => seen.push(v));
    a.set(1); a.set(2);
    assert.deepEqual(seen, [0, 1, 2]);
    unsub();
    a.set(3);
    assert.deepEqual(seen, [0, 1, 2]);   // no more after unsub
});

test("box <-> callable interop both directions", {skip: true}, () => {
    const r = createRegistry();
    const boxSig = r.signalBox(1);
    const callSig = r.signal(10);
    const boxReadsCall = r.computedBox(() => boxSig.get() + callSig());
    const callReadsBox = r.computed(() => boxSig.get() * 2);
    assert.equal(boxReadsCall.get(), 11);
    assert.equal(callReadsBox(), 2);
    boxSig.set(5);
    callSig.set(20);
    assert.equal(boxReadsCall.get(), 25);
    assert.equal(callReadsBox(), 10);
});

test("box: batch coalesces",  {skip: true}, () => {
    const r = createRegistry();
    const a = r.signalBox(1), b = r.signalBox(1);
    const sum = r.computedBox(() => a.get() + b.get());
    let runs = 0;
    r.effect(() => { runs++; sum.get(); });
    assert.equal(runs, 1);
    r.batch(() => { a.set(10); b.set(20); });
    assert.equal(sum.get(), 30);
    assert.equal(runs, 2);   // one re-run for the batch, not two
});

test("box: dispose stops updates + ABA-safe", {skip: true}, () => {
    const r = createRegistry();
    const a = r.signalBox(1);
    r.dispose(a);
    // stale handle reads undefined, set is a no-op (gen guard)
    assert.equal(a.get(), undefined);
    a.set(99);   // must not throw, must not corrupt a recycled slot
    assert.equal(a.peek(), undefined);
});

test("box: equals option short-circuits", {skip: true}, () => {
    const r = createRegistry();
    const a = r.signalBox(1, { equals: (x, y) => Math.abs(x - y) < 0.5 });
    let runs = 0;
    r.effect(() => { runs++; a.get(); });
    assert.equal(runs, 1);
    a.set(1.2);   // within epsilon -> no notify
    assert.equal(runs, 1);
    a.set(5);     // outside -> notify
    assert.equal(runs, 2);
});
