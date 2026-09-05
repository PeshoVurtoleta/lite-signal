// burst-dag.mjs -- reproduces Andrii's "layered burst flush warm" EXACTLY
// (pickLayeredSources strided edges, staticFraction=1, per-batch pull reads,
// updatesPerIteration=16) and contrasts it with the earlier contiguous-window
// guess (kept as attic/burst-dag.mjs), on whatever engine is passed. Answers:
// redundancy or locality? and does the strided topology cost more than the
// contiguous one (the locality tell)?
//
//   node --expose-gc burst-dag.mjs <Signal.js>

import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const enginePath = process.argv[2];
const { createRegistry } = await import(pathToFileURL(enginePath).href);

const P = { sources: 256, width: 512, layers: 32, fanIn: 8, burst: 16,
            iters: 96, warmup: 256, trials: 9 };

// --- edge pickers -----------------------------------------------------------
function pickContiguous(prev, prevW, node, layer, fanIn) {          // burst-dag
  const d = new Array(fanIn);
  for (let k = 0; k < fanIn; k++) d[k] = prev[(node + k) % prevW];
  return d;
}
function pickLayered(prev, prevW, node, layer, fanIn) {             // ANDRII, verbatim
  const d = new Array(fanIn);
  const base = (node * 13 + layer * 17) % prevW;
  const step = Math.max(1, Math.floor(prevW / Math.max(1, fanIn * 8)));
  for (let k = 0; k < fanIn; k++) d[k] = prev[(base + k * step) % prevW];
  return d;
}

function build(r, pick) {
  const sources = new Array(P.sources);
  for (let i = 0; i < P.sources; i++) sources[i] = r.signal(i);
  let prev = sources, prevW = P.sources;
  for (let L = 0; L < P.layers; L++) {
    const layer = new Array(P.width);
    for (let j = 0; j < P.width; j++) {
      const deps = pick(prev, prevW, j, L, P.fanIn);            // static node: sum all deps
      layer[j] = r.computed(() => { let s = 0; for (let k = 0; k < deps.length; k++) s += deps[k](); return s; });
    }
    prev = layer; prevW = P.width;
  }
  const leaves = prev;                                           // last layer, readFraction=1
  // real drive: 16 distinct source writes per iteration, then read every leaf
  const write = (i) => { const t0 = i * P.burst; for (let u = 0; u < P.burst; u++) { const t = t0 + u, sd = t % P.sources; sources[sd].set(t + sd); } };
  const readAll = () => { let s = 0; for (let e = 0; e < leaves.length; e++) s += leaves[e](); return s; };
  return { sources, leaves, write, readAll };
}

function cap() {
  const nodes = P.sources + P.width * P.layers + 16;
  const links = P.width * P.fanIn * P.layers + 16;
  return { maxNodes: Math.ceil(nodes * 1.15), maxLinks: Math.ceil(links * 1.15), prealloc: "eager", onCapacityExceeded: "grow" };
}

function structure(pick) {
  const r = createRegistry(cap());
  const g = build(r, pick);
  for (let i = 0; i < 32; i++) { r.batch(() => g.write(i)); g.readAll(); }   // warm the cone + JIT
  let passes = 0; const ran = new Map();
  const off = r.onGraphMutation((op, a) => {
    if (op === 5) ran.set(a, (ran.get(a) ?? 0) + 1);
    else if (op === 6) passes++;
  });
  r.batch(() => g.write(1000)); g.readAll();                     // ONE measured burst
  off();
  let maxRan = 0; for (const c of ran.values()) if (c > maxRan) maxRan = c;
  const st = r.stats();
  r.destroy();
  return { passes, recomputed: ran.size, maxRecompute: maxRan, flushPasses: st.flushPasses, poolGrowths: st.poolGrowths };
}

function timing(pick) {
  const r = createRegistry(cap());
  const g = build(r, pick);
  for (let i = 0; i < P.warmup; i++) { r.batch(() => g.write(i)); g.readAll(); }
  globalThis.gc?.();
  let sink = 0; const times = new Array(P.trials);
  for (let t = 0; t < P.trials; t++) {
    const a = performance.now();
    for (let i = 0; i < P.iters; i++) { r.batch(() => g.write(i)); sink += g.readAll(); }
    times[t] = performance.now() - a;
  }
  times.sort((x, y) => x - y);
  r.destroy();
  return { medianMs: times[times.length >> 1], perBurstUs: (times[times.length >> 1] / P.iters) * 1000, minMs: times[0], _sink: sink };
}

for (const [label, pick] of [["contiguous (old guess)", pickContiguous], ["strided  (Andrii real)", pickLayered]]) {
  const s = structure(pick);
  const t = timing(pick);
  console.log(`${label}`);
  console.log(`   structure : passes/burst=${s.passes}  recomputed=${s.recomputed}  maxRecompute/node=${s.maxRecompute}  poolGrowths=${s.poolGrowths}`);
  console.log(`   timing    : min ${t.minMs.toFixed(2)}ms  median ${t.medianMs.toFixed(2)}ms  =>  ${t.perBurstUs.toFixed(2)} us/burst\n`);
}
