// 1.11.0 discriminator: onSettled as a creation-time capability.
// Run: node --test test/31-onsettled.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

test("onSettled throws on a registry built without the capability, pointing at the option", () => {
    const r = createRegistry();
    assert.throws(() => r.onSettled(() => {}), /settled: true/);
    r.destroy();
});

test("default registry effects still deliver normally (capability off is inert)", () => {
    const r = createRegistry();
    let runs = 0;
    const s = r.signal(0);
    r.effect(() => { s(); runs++; });
    s.set(1); s.set(2);
    assert.equal(runs, 3); // initial + two writes
    r.destroy();
});

test("fires once per top-level drain (one write -> one settle)", () => {
    const r = createRegistry({ settled: true });
    const s = r.signal(0);
    r.effect(() => { s(); });
    let settles = 0;
    r.onSettled(() => settles++);
    s.set(1);
    s.set(2);
    assert.equal(settles, 2);
    r.destroy();
});

test("coalesces: many effects in ONE flush -> ONE settle (not per effect)", () => {
    const r = createRegistry({ settled: true });
    const s = r.signal(0);
    for (let i = 0; i < 5; i++) r.effect(() => { s(); });
    let settles = 0;
    r.onSettled(() => settles++);
    s.set(1); // all five effects re-run in a single drain
    assert.equal(settles, 1);
    r.destroy();
});

test("coalesces under batch: many writes -> ONE settle at drain", () => {
    const r = createRegistry({ settled: true });
    const s = r.signal(0);
    r.effect(() => { s(); });
    let settles = 0;
    r.onSettled(() => settles++);
    r.batch(() => { s.set(1); s.set(2); s.set(3); });
    assert.equal(settles, 1);
    r.destroy();
});

test("nested writes during a drain do not add settles (one top-level drain, one settle)", () => {
    const r = createRegistry({ settled: true });
    const a = r.signal(0);
    const b = r.signal(0);
    r.effect(() => { if (a() > 0) b.set(a()); }); // writes b during the drain
    r.effect(() => { b(); });
    let settles = 0;
    r.onSettled(() => settles++);
    a.set(1); // drains a's effect, which writes b, which drains b's effect -- all one top-level flush
    assert.equal(settles, 1);
    r.destroy();
});

test("does not fire on an empty flush", () => {
    const r = createRegistry({ settled: true });
    let settles = 0;
    r.onSettled(() => settles++);
    r.flush(); // nothing queued
    assert.equal(settles, 0);
    r.destroy();
});

test("does not fire when the flush throws (settled means clean quiescence)", () => {
    const r = createRegistry({ settled: true });
    const s = r.signal(0);
    r.effect(() => { if (s() > 0) throw new Error("boom"); });
    let settles = 0;
    r.onSettled(() => settles++);
    assert.throws(() => s.set(1), /boom/);
    assert.equal(settles, 0);
    r.destroy();
});

test("unsubscribe stops future settles; multiple callbacks all fire", () => {
    const r = createRegistry({ settled: true });
    const s = r.signal(0);
    r.effect(() => { s(); });
    let a = 0, b = 0;
    const offA = r.onSettled(() => a++);
    r.onSettled(() => b++);
    s.set(1);
    assert.equal(a, 1);
    assert.equal(b, 1);
    offA();
    s.set(2);
    assert.equal(a, 1, "unsubscribed callback stays put");
    assert.equal(b, 2, "other callback keeps firing");
    r.destroy();
});
