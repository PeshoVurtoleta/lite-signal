// 15-identity.test.mjs — node-identity surface added in 1.1.5 for @zakkster/lite-devtools:
// describe() / nodeId() and re-walkable descriptors. Requires the 1.1.5 engine.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("node identity", () => {
  it("assigns unique, stable ids", () => {
    const a = r.signal(1), b = r.signal(2), c = r.computed(() => a() + b());
    const ids = [a, b, c].map((h) => r.nodeId(h));
    assert.equal(new Set(ids).size, 3, "ids unique");
    assert.equal(r.nodeId(a), r.nodeId(a), "id stable across calls");
  });

  it("nodeId / describe return undefined for a non-handle", () => {
    assert.equal(r.nodeId(null), undefined);
    assert.equal(r.nodeId({}), undefined);
    assert.equal(r.describe(() => {}), undefined);
  });

  it("describe returns the handle's own { id, kind, value }", () => {
    const a = r.signal(7);
    const d = r.describe(a);
    assert.deepEqual(Object.keys(d), ["id", "kind", "value"], "visible keys are id,kind,value only");
    assert.equal(d.kind, "signal");
    assert.equal(d.value, 7);
    assert.equal(d.id, r.nodeId(a));
  });

  it("forEach* descriptors carry id and are re-walkable", () => {
    const a = r.signal(1), b = r.signal(2);
    const sum = r.computed(() => a() + b());
    r.effect(() => sum());                    // keep sum observed
    let sumDesc = null;
    r.forEachObserver(a, (d) => { if (d.kind === "computed") sumDesc = d; });
    assert.equal(typeof sumDesc.id, "number", "descriptor carries id");
    assert.equal(r.nodeId(sumDesc), r.nodeId(sum), "nodeId works on a descriptor");
    const srcKinds = [];
    r.forEachSource(sumDesc, (d) => srcKinds.push(d.kind));   // re-walk FROM the descriptor
    assert.deepEqual(srcKinds.sort(), ["signal", "signal"], "descriptor re-walkable via forEachSource");
  });

  it("identity walks are non-perturbing (no observers added)", () => {
    const a = r.signal(1);
    const c = r.computed(() => a() * 2);
    r.effect(() => c());
    const before = r.stats().activeLinks;
    r.describe(a); r.nodeId(c);
    r.forEachObserver(a, (d) => r.forEachSource(d, () => {}));
    assert.equal(r.stats().activeLinks, before, "activeLinks unchanged");
  });
});
