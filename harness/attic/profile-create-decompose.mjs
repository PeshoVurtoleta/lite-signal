// profile-create-decompose.mjs
// Time each phase of computed() construction in isolation to attribute cost.
// Run with: node --expose-gc profile-create-decompose.mjs

import { createRegistry } from "./lite_v120/Signal.js";
import * as alien from "./alien_sigs/esm/index.mjs";

const COUNT = 100_000;
const PASSES = 10;
const WARMUPS = 8;

// We'll measure 5 patterns of equivalent ALLOC count to attribute cost.

// (1) Just allocate an arrow closure that captures something.
function alloc_closure_only(n, payloads) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = payloads[i & 7];
    out[i] = () => p;
  }
  return out;
}

// (2) Same as (1) but also assign 4 properties (shared funcs + symbol PTR).
const sym1 = Symbol("a"), sym2 = Symbol("b");
const sharedA = function () {};
const sharedB = function () {};
function alloc_closure_with_props(n, payloads) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = payloads[i & 7];
    const f = () => p;
    f.peek = sharedA;
    f.subscribe = sharedB;
    f[sym1] = p;
    f[sym2] = 0;
    out[i] = f;
  }
  return out;
}

// (3) Just allocate a plain object literal with 7 fields (alien's per-computed state shape).
function alloc_object_literal(n, payloads) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = payloads[i & 7];
    out[i] = {
      value: undefined,
      subs: undefined,
      subsTail: undefined,
      deps: undefined,
      depsTail: undefined,
      flags: 0,
      getter: p,
    };
  }
  return out;
}

// (4) Object literal + bind (alien's full per-computed pattern).
function alienShape_computedOper() { return this.getter(); }
function alloc_object_then_bind(n, payloads) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = payloads[i & 7];
    out[i] = alienShape_computedOper.bind({
      value: undefined,
      subs: undefined,
      subsTail: undefined,
      deps: undefined,
      depsTail: undefined,
      flags: 0,
      getter: p,
    });
  }
  return out;
}

// (5) Real lite-signal computed (for reference).
const reg = createRegistry({ maxNodes: 1 << 18, maxLinks: 1 << 22, onCapacityExceeded: "grow" });
const liteSrc = (() => {
  const out = new Array(8);
  for (let i = 0; i < 8; i++) out[i] = reg.signal(i);
  return out;
})();
function alloc_lite_computed(n, payloads) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = payloads[i & 7];
    out[i] = reg.computed(() => p());
  }
  return out;
}

// (6) Real alien computed (for reference).
const alienSrc = (() => {
  const out = new Array(8);
  for (let i = 0; i < 8; i++) out[i] = alien.signal(i);
  return out;
})();
function alloc_alien_computed(n, payloads) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = payloads[i & 7];
    out[i] = alien.computed(() => p());
  }
  return out;
}

function timePass(fn, payloads) {
  globalThis.gc?.(); globalThis.gc?.();
  const t0 = performance.now();
  const r = fn(COUNT, payloads);
  const t1 = performance.now();
  if (r.length !== COUNT) throw new Error("alloc count mismatch");
  return t1 - t0;
}

function run(name, fn, payloads) {
  // Warmup
  for (let i = 0; i < WARMUPS; i++) fn(COUNT / 10, payloads);
  globalThis.gc?.(); globalThis.gc?.();
  const samples = [];
  for (let i = 0; i < PASSES; i++) samples.push(timePass(fn, payloads));
  const min = Math.min(...samples);
  const med = [...samples].sort((a,b)=>a-b)[samples.length >> 1];
  console.log(`${name.padEnd(36)} min=${min.toFixed(2)}ms  med=${med.toFixed(2)}ms`);
  return min;
}

// Payloads (8 distinct objects so the closures don't all share identity)
const payloads = [];
for (let i = 0; i < 8; i++) payloads.push({ x: i });
const litePayloads = liteSrc;
const alienPayloads = alienSrc;

console.log(`-- decompose: per-computed allocation cost, ${COUNT} allocations ---`);
console.log(`node ${process.version}, WARMUPS=${WARMUPS}, PASSES=${PASSES}`);
console.log();

const t1 = run("(1) closure only (no props)         ", alloc_closure_only, payloads);
const t2 = run("(2) closure + 4 props (lite shape) ", alloc_closure_with_props, payloads);
const t3 = run("(3) plain object literal (7 fields) ", alloc_object_literal, payloads);
const t4 = run("(4) object literal + bind (alien)   ", alloc_object_then_bind, payloads);
console.log();
const t5 = run("(5) REAL lite.computed             ", alloc_lite_computed, litePayloads);
const t6 = run("(6) REAL alien.computed            ", alloc_alien_computed, alienPayloads);

console.log();
console.log(`-- attribution --`);
console.log(`Pure closure cost          : ${t1.toFixed(2)}ms`);
console.log(`Closure + 4 prop writes    : ${t2.toFixed(2)}ms  (delta = ${(t2-t1).toFixed(2)}ms for the prop writes)`);
console.log(`Real lite.computed         : ${t5.toFixed(2)}ms  (delta over pattern 2 = ${(t5-t2).toFixed(2)}ms : node pool + version bookkeeping)`);
console.log();
console.log(`Object literal alone       : ${t3.toFixed(2)}ms`);
console.log(`Object lit + bind          : ${t4.toFixed(2)}ms  (delta = ${(t4-t3).toFixed(2)}ms for the bind)`);
console.log(`Real alien.computed        : ${t6.toFixed(2)}ms  (delta over pattern 4 = ${(t6-t4).toFixed(2)}ms)`);
console.log();
console.log(`lite vs alien gap          : ${(t5-t6).toFixed(2)}ms total  (${(t5/t6).toFixed(1)}x)`);
console.log(`  attributable to closure : ${(t1-t3).toFixed(2)}ms  (closure alloc - object alloc)`);
console.log(`  attributable to props   : ${(t2-t1).toFixed(2)}ms`);
console.log(`  attributable to pool    : ${(t5-t2).toFixed(2)}ms  (real lite - synthetic closure+props)`);
console.log(`  attributable to alien   : ${(t6-t4).toFixed(2)}ms  (real alien overhead beyond bind)`);
