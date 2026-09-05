// Hard suite -- registry isolation + pool/leak stability. The perf-hardening
// half: the engine's promise is that dispose reclaims and the steady state does
// not grow. These assertions tighten the same moat the profiler's anti-trap test
// guards from the consumer side.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as LS from '@zakkster/lite-signal';
const { signal, computed, effect, dispose, stats } = LS;
const HAS_REGISTRY = typeof LS.createRegistry === 'function';
const need = (cond, why) => (cond ? false : why);

describe('registry isolation', () => {
  it('two registries are fully independent', { skip: need(HAS_REGISTRY, 'requires createRegistry') }, () => {
    const r1 = LS.createRegistry();
    const r2 = LS.createRegistry();
    const a = r1.signal(0);
    const b = r2.signal(0);
    let aRuns = 0, bRuns = 0;
    const ea = r1.effect(() => { a(); aRuns++; });
    const eb = r2.effect(() => { b(); bRuns++; });
    assert.equal(aRuns, 1); assert.equal(bRuns, 1);
    a.set(1);
    assert.equal(aRuns, 2, 'r1 effect re-ran');
    assert.equal(bRuns, 1, 'r2 effect is unaffected by an r1 write');
    ea(); eb();
    if (typeof r1.destroy === 'function') r1.destroy();
    if (typeof r2.destroy === 'function') r2.destroy();
  });
});

describe('pool / leak stability (zero-GC steady state)', () => {
  it('reclaims nodes on dispose: live count returns to baseline after heavy churn', () => {
    // warm up so pools are populated before measuring
    for (let i = 0; i < 200; i++) {
      const s = signal(0);
      const c = computed(() => s());
      const e = effect(() => c());
      e(); dispose(c); dispose(s);
    }

    const before = stats();
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const s = signal(i);
      const c = computed(() => s() * 2);
      const e = effect(() => c());
      void c();           // realize the computed
      e();                // dispose the effect
      dispose(c);
      dispose(s);
    }
    const after = stats();

    // Everything created in the loop was disposed -> the live node count must not
    // grow with N. A small slack covers any registry-internal bookkeeping nodes.
    assert.ok(
      Math.abs(after.activeNodes - before.activeNodes) <= 8,
      `activeNodes leaked across ${N} create/dispose cycles: ${before.activeNodes} -> ${after.activeNodes}`
    );

    // The node pool sizes to PEAK concurrency (a few nodes), never to cumulative N.
    if (typeof after.nodePoolCapacity === 'number') {
      assert.ok(
        after.nodePoolCapacity < N,
        `node pool capacity ${after.nodePoolCapacity} should be far below the ${N} total nodes created`
      );
    }
  });

  it('keeps the link pool bounded under repeated re-tracking', () => {
    const cond = signal(true);
    const a = signal(0), b = signal(0);
    const e = effect(() => { void (cond() ? a() : b()); });
    const before = stats();
    // Flip dependencies many times: each flip drops one edge and adds another.
    for (let i = 0; i < 2000; i++) cond.set(i % 2 === 0);
    const after = stats();
    // Edge churn must not leak links: active links return to ~baseline.
    if (typeof after.activeLinks === 'number' && typeof before.activeLinks === 'number') {
      assert.ok(
        Math.abs(after.activeLinks - before.activeLinks) <= 4,
        `links leaked under re-tracking: ${before.activeLinks} -> ${after.activeLinks}`
      );
    }
    e();
  });
});
