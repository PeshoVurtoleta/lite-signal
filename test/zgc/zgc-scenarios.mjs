// Scenarios, controls, and verdict logic shared by the gate runner and the
// node:test wrapper. Keeping them in one place means CI asserts the exact same
// thing the human-readable report shows.

import { createRegistry } from "../../Signal.js";

export const CFG = { maxNodes: 8192, maxLinks: 131072, prealloc: "eager", onCapacityExceeded: "grow" };
// (kept for reference) the old sampling threshold is replaced by scavenge counting

// ---- controls (prove the meter detects allocation) ------------------------
// Module-level sink: allocations escape the JIT-compiled hot function, so V8
// cannot scalar-replace or dead-store them. (Function-local objects get
// eliminated and read as zero — the trap that the controls exist to rule out.)
//
// Object shape: {x,y,z,w} rather than {x,y}. Four SMI in-object properties
// roughly ~1.5x the per-object byte footprint of the two-field shape, so the
// young generation fills faster and the positive control produces a comfortable
// margin over MAX_SCAVENGES + 3 even when a caller forgets to pass
// --max-semi-space-size=4. Under `test:zgc` (which passes that flag) this is
// belt-and-braces; under a bare `node --test` it is the belt.
const __posKeep = [];
export function keepAlive() { return __posKeep.length; } // referenced by callers to stay live
export const ctrlPositive = {
  name: "CONTROL+ (allocates {x,y,z,w} per iter — meter MUST flag)",
  setup: () => ({}),
  hot(s, n) {
    // 2026-09 re-arm: the original 1-object-per-iter volume (~12 MB/run) rotted
    // under Node 26's adaptive/MinorMS nursery, which absorbed it at 2 scavenges
    // vs the > MAX_SCAVENGES+3 budget -- the meter still worked, it was merely
    // under-fed (same V8 lesson as the torture suite's dual transient witness).
    // Four fresh objects per iter (~50 MB/run of young-gen garbage, most of it
    // dropped) restores a comfortable double-digit margin under the gate's
    // 4 MB semi-space cap. The 1-in-4096 retain keeps escape analysis honest;
    // the arithmetic sink keeps the drops from being dead-stored.
    let t = 0;
    for (let i = 0; i < n; i++) {
      const a = { x: i, y: i + 1, z: i + 2, w: i + 3 };
      const b = { x: i + 4, y: i + 5, z: i + 6, w: i + 7 };
      const c = { x: t, y: i, z: t + 1, w: i + 1 };
      const d = { x: i, y: t, z: i + 2, w: t + 2 };
      t += a.x + b.y + c.z + d.w;
      // ALL FOUR objects are phi-reachable at a conditional escape site, so
      // scalar replacement cannot elide any of them (a future V8 SRA that
      // dropped b/c/d would quietly shrink the planted volume back under the
      // budget -- the exact rot this control just recovered from).
      const pick = (i & 3) === 0 ? a : (i & 3) === 1 ? b : (i & 3) === 2 ? c : d;
      if ((i & 4095) === 0) __posKeep.push(pick);
    }
    s.t = (s.t | 0) + t;
    if (__posKeep.length > 3_000_000) __posKeep.length = 0;
  },
};
export const ctrlNegative = {
  name: "CONTROL- (pure arithmetic — must be ~0)",
  setup: () => ({ acc: 0 }),
  hot(s, n) { let a = s.acc; for (let i = 0; i < n; i++) a += (i * 3) ^ i; s.acc = a; },
};

// ---- steady-state scenarios (the zero-GC claim) ---------------------------
function buildDeep() {
  const r = createRegistry(CFG);
  const a = r.signal(0);
  let prev = a;
  for (let i = 0; i < 16; i++) { const p = prev; prev = r.computed(() => p() + 1); }
  let sink = 0; const tail = prev; r.effect(() => { sink = tail(); });
  return { r, a };
}
export const steadyDeep = {
  name: "steady-state propagation (deep chain x16)",
  setup: buildDeep, statsOf: (s) => s.r.stats(),
  hot(s, n) { const a = s.a; for (let i = 0; i < n; i++) a.set(i); },
};

function buildWide() {
  const r = createRegistry(CFG);
  const a = r.signal(0);
  const sinks = new Array(32).fill(0);
  for (let i = 0; i < 32; i++) { const k = i; const c = r.computed(() => a() + k); r.effect(() => { sinks[k] = c(); }); }
  return { r, a };
}
export const steadyWide = {
  name: "steady-state propagation (wide fan-out x32)",
  setup: buildWide, statsOf: (s) => s.r.stats(),
  hot(s, n) { const a = s.a; for (let i = 0; i < n; i++) a.set(i); },
};

function buildBatch() {
  const r = createRegistry(CFG);
  const sigs = []; for (let i = 0; i < 8; i++) sigs.push(r.signal(0));
  let sink = 0; r.effect(() => { let t = 0; for (const s of sigs) t += s(); sink = t; });
  let cur = 0;
  // Hoist the batch callback: allocating a fresh arrow each loop iteration would
  // measure the CALLER's closure, not the engine. Real callers control that; the
  // engine's batch internals are what this scenario isolates.
  const cb = () => { for (let j = 0; j < 8; j++) sigs[j].set(cur + j); };
  return { r, cb, setCur: (v) => { cur = v; } };
}
export const steadyBatch = {
  name: "steady-state propagation (batched 8-signal writes)",
  setup: buildBatch, statsOf: (s) => s.r.stats(),
  hot(s, n) { for (let i = 0; i < n; i++) { s.setCur(i); s.r.batch(s.cb); } },
};

export const steadyScenarios = [steadyDeep, steadyWide, steadyBatch];

// ---- churn (node recycling; the pool claim, via exact counters) -----------
export const churnBox = {
  name: "create+dispose churn (signalBox; node must recycle, pool must NOT grow)",
  setup: () => ({ r: createRegistry(CFG) }), statsOf: (s) => s.r.stats(),
  hot(s, n) { const r = s.r; for (let i = 0; i < n; i++) { const a = r.signalBox(i); r.dispose(a); } },
};

// ---- injected allocation (proves the GATE VERDICT catches a leak) ---------
// An effect that pushes to an array every run: a real steady-state allocation
// crossing the engine boundary (not function-local, so not elidable). The gate
// MUST flag this — it is the "fails on injected allocation" self-test.
// An effect that allocates a real heap object every run and lets it escape to
// module scope (so V8 can't elide it). Pushing integers into a reused array
// would NOT allocate — SMIs are inline and the backing store is reused — which
// is exactly the false-negative this scenario must avoid.
const __injSink = [];
export function injKeepAlive() { return __injSink.length; }
function buildInjected() {
  const r = createRegistry(CFG);
  const a = r.signal(0);
  r.effect(() => { __injSink.push({ v: a() }); if (__injSink.length > 3000) __injSink.length = 0; });
  return { r, a };
}
export const injectedAlloc = {
  name: "INJECTED steady-state allocation (gate MUST flag)",
  setup: buildInjected, statsOf: (s) => s.r.stats(),
  hot(s, n) { const a = s.a; for (let i = 0; i < n; i++) a.set(i); },
};

// ---- verdict --------------------------------------------------------------
export const MAX_SCAVENGES = 2; // a zero-alloc window forces no young-gen GC
export function steadyPass(r) {
  return r.minorHi <= MAX_SCAVENGES && r.poolGrowthDelta_hi === 0 &&
    r.allocDelta_hi === 0 && r.retainedKB_hi < 64;
}
