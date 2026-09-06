// 16-alien-parity.test.mjs — differential regression guards. Each test reproduces the
// PROPERTY behind a fixed alien-signals bug and asserts lite-signal does not exhibit it.
// Source: alien-signals v3.2.0 "Bug Fixes" (#109/#110, #112, and the dispose-cleanup fix).
// #111 (effectScope propagation) is N/A until lite ships an owner tree (1.2.0).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("alien-parity (v3.2.0 fixed-bug classes)", () => {
  // alien: "dispose cleanup running inside tracking context — cleanup reads no longer create deps"
  it("reads inside a cleanup do not create spurious dependencies", () => {
    const a = r.signal(0), probe = r.signal(0);
    let cleanups = 0;
    const dispose = r.effect(() => { a(); r.onCleanup(() => { cleanups++; probe(); }); });
    a.set(1);                                  // re-run: cleanup fires, reads probe
    assert.equal(r.hasObservers(probe), false, "no spurious dep on re-run");
    dispose();                                 // dispose: cleanup fires again, reads probe
    assert.equal(r.hasObservers(probe), false, "no spurious dep on dispose");
    assert.equal(r.hasObservers(a), false, "disposed effect drops its real deps");
    assert.equal(cleanups, 2);
  });

  // alien #112: "inner write blocking future propagation through computed chain"
  it("a write inside an effect does not block later propagation through a computed chain", () => {
    const a = r.signal(1);
    const b = r.computed(() => a() * 2);
    const c = r.computed(() => b() + 1);
    let cVal;
    r.effect(() => { cVal = c(); });           // a→b→c→effect, cVal=3
    const trigger = r.signal(0);
    r.effect(() => { if (trigger() > 0) a.set(50); });  // inner write to a
    trigger.set(1);
    assert.equal(cVal, 101, "inner write propagates (50*2+1)");
    a.set(7);                                  // later top-level write must still propagate
    assert.equal(cVal, 15, "later top-level write still propagates (7*2+1)");
  });

  // alien #109/#110: "checkDirty resilient to graph mutations during update"
  it("dynamic dependency-set changes stay correct under dirty-check", () => {
    const cond = r.signal(true);
    const a = r.signal(10), b = r.signal(20);
    const dyn = r.computed(() => (cond() ? a() : b()));
    let effVal;
    r.effect(() => { effVal = dyn(); });
    assert.equal(effVal, 10);
    cond.set(false); assert.equal(effVal, 20, "dep set switched to b");
    b.set(99);       assert.equal(effVal, 99, "new dep live");
    a.set(1000);     assert.equal(effVal, 99, "dropped dep no longer triggers");
    r.batch(() => { cond.set(true); a.set(5); });
    assert.equal(effVal, 5, "batched graph mutation + dep change resolves");
  });
});
