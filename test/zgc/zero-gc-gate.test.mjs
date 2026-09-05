// CI gate.  Run:  node --expose-gc --max-semi-space-size=4 --test test/zgc/zero-gc-gate.test.mjs
// --expose-gc is required. --max-semi-space-size=4 sharpens scavenge sensitivity;
// the `test:zgc` root script sets both automatically. Never invoke this file with
// a plain `node --test` -- the assertion budget assumes the small semi-space.
//
// The N used here matches the standalone runner (`zero-gc-gate.mjs` uses N=200000).
// An earlier version of this test ran N=150000, which was 25% short of the runner's
// budget and could saw only ~4 scavenges on the positive control against a
// MAX_SCAVENGES+3 = 5 threshold -- an off-by-one against a noisy signal. The two
// files must stay aligned; asserting on a smaller window than the runner uses
// leaves the CI gate strictly weaker than the report the runner prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureScenario } from "./zgc-core.mjs";
import {
  ctrlPositive, ctrlNegative, steadyScenarios, churnBox, injectedAlloc,
  steadyPass, keepAlive, injKeepAlive, MAX_SCAVENGES,
} from "./zgc-scenarios.mjs";

assert.ok(typeof global.gc === "function", "run with --expose-gc");
const OPTS = { N: 200000, k: 8 };

test("detector sees a known allocation (positive control)", async () => {
  const r = await measureScenario(ctrlPositive, OPTS); keepAlive();
  assert.ok(r.minorHi > MAX_SCAVENGES + 3, `positive control should force scavenges, saw ${r.minorHi}`);
});

test("detector reads 0 for a non-allocating loop (negative control)", async () => {
  const r = await measureScenario(ctrlNegative, OPTS);
  assert.ok(r.minorHi <= MAX_SCAVENGES, `no-op control forced ${r.minorHi} scavenges`);
});

for (const sc of steadyScenarios) {
  test(`zero-GC: ${sc.name}`, async () => {
    const r = await measureScenario(sc, OPTS);
    assert.equal(r.poolGrowthDelta_hi, 0, "pool must not grow in steady state");
    assert.equal(r.allocDelta_hi, 0, "no node may be pulled from the pool in steady state");
    assert.ok(r.minorHi <= MAX_SCAVENGES, `forced ${r.minorHi} scavenges (transient allocation)`);
    assert.ok(r.retainedKB_hi < 64, `retained ${r.retainedKB_hi.toFixed(0)} KB`);
  });
}

test("pool recycles nodes under create/dispose churn", async () => {
  const r = await measureScenario(churnBox, OPTS);
  assert.equal(r.poolGrowthDelta_hi, 0, "pool grew under churn");
  assert.equal(r.activeDelta_hi, 0, "nodes were not fully returned to the pool");
  assert.ok(r.allocDelta_hi >= OPTS.N * OPTS.k * 0.9, "expected ~k*N node allocations from the free-list");
});

test("GATE CATCHES an injected steady-state allocation", async () => {
  const r = await measureScenario(injectedAlloc, OPTS); injKeepAlive();
  assert.equal(steadyPass(r), false, "gate failed to flag a real steady-state allocation");
  assert.ok(r.minorHi > MAX_SCAVENGES, `injected leak forced only ${r.minorHi} scavenges`);
});
