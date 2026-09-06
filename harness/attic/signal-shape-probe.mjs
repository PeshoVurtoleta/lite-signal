// signal-shape-probe.mjs
// Test the specific combination of (closure alloc + setPrototypeOf + 2nd closure + props)
// that the v1.2.1 signal() body uses, to find the source of the 1.5x regression.

const COUNT = 100_000;
const BATCHES = 5;
const WARMUPS = 5;
const sharedA = function() {};
const sharedB = function() {};
const sharedC = function() {};
const sym1 = Symbol("ptr");
const sym2 = Symbol("gen");

const SIGNAL_PROTO = Object.create(Function.prototype);
SIGNAL_PROTO.peek = sharedA;
SIGNAL_PROTO.update = sharedB;
SIGNAL_PROTO.subscribe = sharedC;

const variants = [
  ["A: v1.2.0 signal shape (6 own props, NO proto)", (n, payloads) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const node = payloads[i & 7];
      const read = () => node;
      read.peek = sharedA;
      read.set = (v) => { node.x = v; };
      read.update = sharedB;
      read.subscribe = sharedC;
      read[sym1] = node;
      read[sym2] = 0;
      out[i] = read;
    }
    return out;
  }],
  ["B: v1.2.1 signal shape (proto + set + NODE_PTR + NODE_GEN)", (n, payloads) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const node = payloads[i & 7];
      const read = () => node;
      Object.setPrototypeOf(read, SIGNAL_PROTO);
      read.set = (v) => { node.x = v; };
      read[sym1] = node;
      read[sym2] = 0;
      out[i] = read;
    }
    return out;
  }],
  ["C: v1.2.1 shape, set FIRST then setPrototypeOf", (n, payloads) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const node = payloads[i & 7];
      const read = () => node;
      read.set = (v) => { node.x = v; };
      read[sym1] = node;
      read[sym2] = 0;
      Object.setPrototypeOf(read, SIGNAL_PROTO);
      out[i] = read;
    }
    return out;
  }],
  ["D: no second closure (set is also shared), with setPrototypeOf", (n, payloads) => {
    const sharedSet = function(v) { this[sym1].x = v; };
    const PROTO_WITH_SET = Object.create(Function.prototype);
    PROTO_WITH_SET.peek = sharedA;
    PROTO_WITH_SET.update = sharedB;
    PROTO_WITH_SET.subscribe = sharedC;
    PROTO_WITH_SET.set = sharedSet;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const node = payloads[i & 7];
      const read = () => node;
      Object.setPrototypeOf(read, PROTO_WITH_SET);
      read[sym1] = node;
      read[sym2] = 0;
      out[i] = read;
    }
    return out;
  }],
  ["E: bind() pattern (alien ceiling)", (n, payloads) => {
    function operFn() { return this.value; }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const node = payloads[i & 7];
      out[i] = operFn.bind({ value: node, [sym1]: node, [sym2]: 0 });
    }
    return out;
  }],
];

function runVariant(name, fn) {
  const payloads = [];
  for (let i = 0; i < 8; i++) payloads.push({ x: i });
  for (let i = 0; i < WARMUPS; i++) fn(COUNT / 10, payloads);
  globalThis.gc?.(); globalThis.gc?.();
  const samples = [];
  for (let i = 0; i < BATCHES; i++) {
    globalThis.gc?.(); globalThis.gc?.();
    const t0 = performance.now();
    const r = fn(COUNT, payloads);
    const t1 = performance.now();
    samples.push(t1 - t0);
    if (r.length !== COUNT) throw new Error();
  }
  const min = Math.min(...samples);
  const med = [...samples].sort((a,b)=>a-b)[samples.length >> 1];
  console.log(`${name.padEnd(54)} min=${min.toFixed(2)}ms med=${med.toFixed(2)}ms  samples=[${samples.map(s=>s.toFixed(1)).join(", ")}]`);
  return min;
}

console.log(`signal-shape variants, ${COUNT} allocs each, ${BATCHES} batches`);
console.log();
for (const [name, fn] of variants) runVariant(name, fn);
