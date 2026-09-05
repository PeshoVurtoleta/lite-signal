// profile-read-after-proto.mjs
// Confirm setPrototypeOf doesn't deopt the read side.
// Run with: node --expose-gc profile-read-after-proto.mjs

const COUNT = 100_000;
const READS = 10_000_000;
const PASSES = 6;
const WARMUPS = 5;

const sharedPeek = function () { return this[sym].value; };
const sharedSub = function (fn) { return fn; };
const sym = Symbol("ptr");

// SETUP A: own-prop pattern (current lite shape)
function makeA(node) {
  const f = () => node.value;
  f.peek = sharedPeek;
  f.subscribe = sharedSub;
  f[sym] = node;
  f.gen = 0;
  return f;
}

// SETUP B: shared-proto pattern (proposed v1.2.1 shape)
const PROTO_B = Object.create(Function.prototype);
PROTO_B.peek = sharedPeek;
PROTO_B.subscribe = sharedSub;

function makeB(node) {
  const f = () => node.value;
  Object.setPrototypeOf(f, PROTO_B);
  f[sym] = node;
  f.gen = 0;
  return f;
}

// SETUP C: bind() pattern (alien-style ceiling)
function operC() { return this.value; }
function makeC(node) {
  return operC.bind({ value: node.value, [sym]: node, gen: 0 });
}

// Test 1: construction cost (we already measured this, just confirming).
function build(maker, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = maker({ value: i, gen: 0 });
  }
  return out;
}

// Test 2: read path cost — call the read function many times.
function readCall(handles, reads) {
  let sum = 0;
  const m = handles.length;
  for (let i = 0; i < reads; i++) sum += handles[i % m]();
  return sum;
}

// Test 3: peek path cost — call the peek method many times.
function readPeek(handles, reads) {
  let sum = 0;
  const m = handles.length;
  for (let i = 0; i < reads; i++) sum += handles[i % m].peek();
  return sum;
}

function timePass(fn, ...args) {
  globalThis.gc?.(); globalThis.gc?.();
  const t0 = performance.now();
  const r = fn(...args);
  const t1 = performance.now();
  return { ms: t1 - t0, sink: r };
}

let SINK = 0;
function run(name, fn, ...args) {
  for (let i = 0; i < WARMUPS; i++) SINK += timePass(fn, ...args).sink || 0;
  globalThis.gc?.(); globalThis.gc?.();
  const samples = [];
  for (let i = 0; i < PASSES; i++) {
    const r = timePass(fn, ...args);
    samples.push(r.ms);
    SINK += r.sink || 0;
  }
  const min = Math.min(...samples);
  console.log(`${name.padEnd(40)} min=${min.toFixed(2)}ms`);
  return min;
}

console.log(`-- build vs read after setPrototypeOf ---`);
console.log(`node ${process.version}, build=${COUNT}, reads=${READS.toLocaleString()}`);
console.log();

const handlesA = build(makeA, COUNT);
const handlesB = build(makeB, COUNT);
const handlesC = build(makeC, COUNT);

// pre-warm a small read loop for each pattern so V8 has a real read IC
readCall(handlesA, 100_000); readCall(handlesB, 100_000); readCall(handlesC, 100_000);
readPeek(handlesA, 100_000); readPeek(handlesB, 100_000);  // C has no peek

console.log("call(): handle() — the hot read path");
run("A: own-prop pattern (lite)            ", readCall, handlesA, READS);
run("B: setPrototypeOf pattern (proposed)  ", readCall, handlesB, READS);
run("C: bind() pattern (alien-style)       ", readCall, handlesC, READS);

console.log();
console.log("peek(): handle.peek() — the cold-path read (A vs B only; C has no peek by design)");
run("A: own-prop pattern (lite)            ", readPeek, handlesA, READS);
run("B: setPrototypeOf pattern (proposed)  ", readPeek, handlesB, READS);

console.log();
console.log("(sink to avoid DCE:", SINK > 0 ? "ok" : "WARNING", ")");
