// profile-prop-writes.mjs
// Quantify the cost of each property write onto a freshly-allocated arrow.
// Run with: node --expose-gc profile-prop-writes.mjs

const COUNT = 100_000;
const PASSES = 10;
const WARMUPS = 8;

const sharedA = function () {};
const sharedB = function () {};
const sharedC = function () {};
const sym1 = Symbol("a"), sym2 = Symbol("b");

const variants = [
  ["0 props", (n, payloads) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) { const p = payloads[i & 7]; out[i] = () => p; }
    return out;
  }],
  ["1 prop: NODE_PTR (symbol)", (n, payloads) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) { const p = payloads[i & 7]; const f = () => p; f[sym1] = p; out[i] = f; }
    return out;
  }],
  ["2 props (sym + named)", (n, payloads) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) { const p = payloads[i & 7]; const f = () => p; f[sym1] = p; f.peek = sharedA; out[i] = f; }
    return out;
  }],
  ["3 props", (n, payloads) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) { const p = payloads[i & 7]; const f = () => p; f[sym1] = p; f.peek = sharedA; f.subscribe = sharedB; out[i] = f; }
    return out;
  }],
  ["4 props (current lite computed)", (n, payloads) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) { const p = payloads[i & 7]; const f = () => p; f[sym1] = p; f.peek = sharedA; f.subscribe = sharedB; f[sym2] = 0; out[i] = f; }
    return out;
  }],
  ["6 props (current lite signal)", (n, payloads) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = payloads[i & 7];
      const f = () => p;
      f[sym1] = p;
      f.peek = sharedA;
      f.subscribe = sharedB;
      f.update = sharedC;
      f.set = ((v) => v);  // separate closure
      f[sym2] = 0;
      out[i] = f;
    }
    return out;
  }],
  ["1 prop via Object.setPrototypeOf to shared proto", (n, payloads) => {
    const proto = { peek: sharedA, subscribe: sharedB };
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = payloads[i & 7];
      const f = () => p;
      Object.setPrototypeOf(f, proto);
      f[sym1] = p;
      out[i] = f;
    }
    return out;
  }],
  ["1 prop (NODE_PTR) only - peek/sub on proto", (n, payloads) => {
    // Allocate proto ONCE outside loop, then ONLY set 1 own prop per instance
    const proto = Object.assign(Object.create(Function.prototype), { peek: sharedA, subscribe: sharedB });
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = payloads[i & 7];
      const f = () => p;
      Object.setPrototypeOf(f, proto);
      f[sym1] = p;
      out[i] = f;
    }
    return out;
  }],
  ["bind() pattern (alien-style)", (n, payloads) => {
    function operFn() { return this.getter(); }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = payloads[i & 7];
      out[i] = operFn.bind({ value: undefined, subs: undefined, getter: p });
    }
    return out;
  }],
];

function timePass(fn, payloads) {
  globalThis.gc?.(); globalThis.gc?.();
  const t0 = performance.now();
  const r = fn(COUNT, payloads);
  const t1 = performance.now();
  if (r.length !== COUNT) throw new Error();
  return t1 - t0;
}

function run(name, fn) {
  const payloads = [];
  for (let i = 0; i < 8; i++) payloads.push({ x: i });
  for (let i = 0; i < WARMUPS; i++) fn(COUNT / 10, payloads);
  globalThis.gc?.(); globalThis.gc?.();
  const samples = [];
  for (let i = 0; i < PASSES; i++) samples.push(timePass(fn, payloads));
  const min = Math.min(...samples);
  console.log(`${name.padEnd(56)} min=${min.toFixed(2)}ms`);
  return min;
}

console.log(`-- per-property-write cost on a fresh arrow closure, ${COUNT} allocs ---`);
console.log(`node ${process.version}, WARMUPS=${WARMUPS}, PASSES=${PASSES}`);
console.log();

for (const [name, fn] of variants) run(name, fn);
