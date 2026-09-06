// 14-lifecycle-teardown.test.mjs — guards against the alien-signals@3.2.1 effect-teardown
// regressions. #1 (self-dispose re-subscription) was present in lite through 1.1.3 and fixed
// by the allocateLink eligibility gate; #2 (throwing setup) lite already handled; #3 (scope
// teardown) is reserved for the 1.2.0 owner-tree.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("effect teardown", () => {
  it("a stopped effect does not re-subscribe to signals read later in the same run", () => {
    const rerun = r.signal(0), readAfterStop = r.signal(0);
    let stop, kill = false, runs = 0;
    stop = r.effect(() => { runs++; rerun(); if (kill) { stop(); readAfterStop(); } });
    assert.equal(runs, 1);
    kill = true; rerun.set(1);
    assert.equal(runs, 2);
    assert.equal(r.hasObservers(readAfterStop), false, "dead effect must not be in subscriber list");
    const before = runs; readAfterStop.set(1);
    assert.equal(runs, before, "dead effect must not re-run");
  });

  it("self-dispose leaves no orphaned link (clean activeLinks)", () => {
    const rerun = r.signal(0), readAfterStop = r.signal(0);
    let stop, kill = false;
    stop = r.effect(() => { rerun(); if (kill) { stop(); readAfterStop(); } });
    kill = true; rerun.set(1);
    assert.equal(r.stats().activeLinks, 0, "no link should survive a fully self-disposed effect");
  });

  it("a throwing effect setup leaves no live subscription", () => {
    const source = r.signal(0);
    let runs = 0;
    assert.throws(() => r.effect(() => { runs++; source(); throw new Error("setup failed"); }), /setup failed/);
    assert.equal(runs, 1);
    assert.equal(r.hasObservers(source), false);
    assert.doesNotThrow(() => source.set(1));
    assert.equal(runs, 1, "torn-down effect must not re-run");
  });

  it("normal tracking and dynamic re-tracking are unaffected by the gate", () => {
    const a = r.signal(1), b = r.signal(10), flag = r.signal(true);
    let n = 0; r.effect(() => { n++; a(); if (flag()) b(); });
    let m = n; b.set(11); assert.equal(n, m + 1, "tracks b while flag=true");
    flag.set(false); m = n; b.set(12); assert.equal(n, m, "drops b after flag=false");
    flag.set(true); m = n; b.set(13); assert.equal(n, m + 1, "re-tracks b after flag=true");
  });
});
