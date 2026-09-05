// Zero-GC gate core — three signals, each chosen for what it can actually see:
//
//   1. SCAVENGE COUNT (perf_hooks 'gc', kind=minor) during the window — the
//      reliable detector of TRANSIENT allocation. Per-iteration garbage fills
//      the young generation and forces scavenges; a zero-alloc window forces
//      none, no matter how many iterations. (An earlier version leaned on the
//      V8 sampling heap profiler, which reports live-at-stop bytes and silently
//      MISSES transient garbage — the precise failure this signal fixes.)
//   2. stats().poolGrowths / totalAllocations — EXACT engine counters. Prove no
//      node was pulled from the pool and the pool never grew. Not sampled.
//   3. Retained-heap delta (memoryUsage + gc) — leak detector.
//
// Pass/fail uses the SCALING idea: measure at N and k*N. A true zero-alloc path
// shows ~0 scavenges at both; an allocating path scavenges in proportion to
// total bytes. Run with --expose-gc; for sharp sensitivity to small per-iter
// allocation also pass --max-semi-space-size=4 (the standalone runner re-execs
// itself with it).

import { PerformanceObserver, constants } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const MINOR = constants.NODE_PERFORMANCE_GC_MINOR;
const MAJOR = constants.NODE_PERFORMANCE_GC_MAJOR;

function makeGcCounter() {
  const c = { minor: 0, major: 0 };
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const k = e.detail ? e.detail.kind : e.kind;
      if (k === MINOR) c.minor++; else if (k === MAJOR) c.major++;
    }
  });
  obs.observe({ entryTypes: ["gc"] });
  return { c, close: () => obs.disconnect() };
}

function gc2() { if (global.gc) { global.gc(); global.gc(); } }

async function meterOnce(scenario, iters) {
  const state = scenario.setup();
  scenario.hot(state, Math.min(iters, 20000)); // warm this graph (JIT + deopt settle)
  gc2();
  const statsBefore = scenario.statsOf ? scenario.statsOf(state) : null;
  const heapBefore = process.memoryUsage().heapUsed;

  const gcc = makeGcCounter();
  scenario.hot(state, iters);          // <-- the only thing in the window
  await sleep(40);                     // drain buffered GC entries to the observer
  const minor = gcc.c.minor, major = gcc.c.major;
  gcc.close();                         // snapshot BEFORE our own gc2(), so explicit GCs don't count

  gc2();
  const heapAfter = process.memoryUsage().heapUsed;
  const statsAfter = scenario.statsOf ? scenario.statsOf(state) : null;
  if (scenario.teardown) scenario.teardown(state);
  return {
    minor, major,
    retainedKB: (heapAfter - heapBefore) / 1024,
    poolGrowthDelta: statsAfter ? statsAfter.poolGrowths - statsBefore.poolGrowths : null,
    allocDelta: statsAfter ? statsAfter.totalAllocations - statsBefore.totalAllocations : null,
    activeDelta: statsAfter ? statsAfter.activeNodes - statsBefore.activeNodes : null,
  };
}

export async function measureScenario(scenario, { N = 200000, k = 8 } = {}) {
  const lo = await meterOnce(scenario, N);
  const hi = await meterOnce(scenario, k * N);
  return {
    name: scenario.name, N, k,
    minorLo: lo.minor, minorHi: hi.minor,
    majorLo: lo.major, majorHi: hi.major,
    retainedKB_hi: hi.retainedKB,
    poolGrowthDelta_hi: hi.poolGrowthDelta,
    allocDelta_hi: hi.allocDelta,
    activeDelta_hi: hi.activeDelta,
  };
}
