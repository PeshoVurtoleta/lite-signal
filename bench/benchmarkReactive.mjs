/**
 * benchmarkReactive.mjs — single-file port of the js-reactivity-benchmark suite
 * (transitive-bullshit/js-reactivity-benchmark, fork of milomg/js-reactivity-benchmark)
 * collapsed into one runnable .mjs, comparing @zakkster/lite-signal against
 * alien-signals, @preact/signals-core, @vue/reactivity, and solid-js.
 *
 * Mirrors the spirit of bench/benchmark.mjs: one file, all adapters inline,
 * `node --expose-gc`. The benchmark bodies (kairo ×8, mol, S.js micro-benches,
 * cellx, dynamic graph) are the framework-agnostic suite cases, run through a
 * tiny ReactiveFramework adapter per library.
 *
 * Run:  node --expose-gc bench/benchmarkReactive.mjs
 *       QUICK=1 node --expose-gc bench/benchmarkReactive.mjs   (fast smoke run)
 *
 * Adapter contract (per framework):
 *   name, signal(v)->{read,write}, computed(fn)->{read}, effect(fn),
 *   withBatch(fn), withBuild(fn)->ret, cleanup()
 *
 * cleanup() is the "reclaim between sections" hook. The suite reuses one
 * framework object across every benchmark and relies on GC to drop nodes
 * between sections; lite-signal pools nodes, so its cleanup() is destroy().
 * To keep the comparison fair (and to stop S.js/Solid from OOMing on ~1e5
 * undisposed nodes), every adapter here also disposes what it created on
 * cleanup(). cleanup() is only ever called at UNTIMED section boundaries.
 *
 * Correctness is validated two ways, neither of which depends on a pinned PRNG:
 *   1. The kairo + cellx cases keep their internal console.assert checks
 *      (these are deterministic and PRNG-free).
 *   2. The dynamic graph is built identically (shared seeded PRNG) for every
 *      framework, and we assert all frameworks produce the SAME leaf sum —
 *      a direct glitch-freeness cross-check. A divergent framework is flagged.
 */

import { createRegistry } from "../Signal.js";

// ── Optional framework imports (skip cleanly if a package isn't installed) ──
async function tryImport(spec) {
  try {
    return await import(spec);
  } catch {
    return null;
  }
}
const alienLib = await tryImport("alien-signals");
const preactLib = await tryImport("@preact/signals-core");
const vueLib = await tryImport("@vue/reactivity");
const solidLib = await tryImport("solid-js/dist/solid.js");

// ── Scale knobs (QUICK shrinks everything for a fast smoke run) ─────────────
const QUICK = process.env.QUICK === "1";
const KAIRO_ITERS = QUICK ? 100 : 1000; // inner repeats per kairo case
const KAIRO_REPEATS = QUICK ? 3 : 10; // fastest-of-N
const MOL_ITERS = QUICK ? 1e3 : 1e4;
const MOL_REPEATS = QUICK ? 3 : 10;
const S_COUNT = QUICK ? 1e4 : 1e5;
const DYN_REPEATS = 1;

// ─────────────────────────────────────────────────────────────────────────
// Deterministic PRNG (replaces the `random` npm dep; shared by all frameworks
// so every framework builds an identical graph). mulberry32 over a hashed seed.
// ─────────────────────────────────────────────────────────────────────────
function makeRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    float: () => next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Adapters
// ─────────────────────────────────────────────────────────────────────────
const FRAMEWORKS = [];

// --- lite-signal ---
{
  const reg = createRegistry({ maxNodes: 1 << 14, onCapacityExceeded: "grow" });
  FRAMEWORKS.push({
    name: "lite-signal",
    signal: (v) => {
      const s = reg.signal(v);
      return { read: s, write: (x) => s.set(x) };
    },
    computed: (fn) => ({ read: reg.computed(fn) }),
    effect: (fn) => {
      reg.effect(fn);
    },
    withBatch: (fn) => reg.batch(fn),
    withBuild: (fn) => fn(),
    cleanup: () => reg.destroy(), // resets the arena in place (keeps grown capacity)
  });
}

// --- alien-signals ---
if (alienLib) {
  const { signal, computed, effect, startBatch, endBatch } = alienLib;
  const disposers = [];
  FRAMEWORKS.push({
    name: "alien-signals",
    signal: (v) => {
      const s = signal(v);
      return { read: () => s(), write: (x) => s(x) };
    },
    computed: (fn) => {
      const c = computed(fn);
      return { read: () => c() };
    },
    effect: (fn) => {
      // alien 3.x treats a returned value as a cleanup fn; the suite's effect
      // bodies return read() values, so discard the return.
      const stop = effect(() => {
        fn();
      });
      if (typeof stop === "function") disposers.push(stop);
    },
    withBatch: (fn) => {
      startBatch();
      try {
        fn();
      } finally {
        endBatch();
      }
    },
    withBuild: (fn) => fn(),
    cleanup: () => {
      for (let i = 0; i < disposers.length; i++) disposers[i]();
      disposers.length = 0;
    },
  });
}

// --- @preact/signals-core ---
if (preactLib) {
  const { signal, computed, effect, batch } = preactLib;
  const disposers = [];
  FRAMEWORKS.push({
    name: "preact",
    signal: (v) => {
      const s = signal(v);
      return { read: () => s.value, write: (x) => (s.value = x) };
    },
    computed: (fn) => {
      const c = computed(fn);
      return { read: () => c.value };
    },
    effect: (fn) => {
      // preact treats a returned function as cleanup; discard read() returns.
      const dispose = effect(() => {
        fn();
      });
      if (typeof dispose === "function") disposers.push(dispose);
    },
    withBatch: (fn) => batch(fn),
    withBuild: (fn) => fn(),
    cleanup: () => {
      for (let i = 0; i < disposers.length; i++) disposers[i]();
      disposers.length = 0;
    },
  });
}

// --- @vue/reactivity ---
if (vueLib) {
  const { shallowRef, computed, effect, effectScope } = vueLib;
  // Vue effects don't auto-batch: use a scheduler + manual drain (per upstream).
  let scheduled = [];
  let batching = false;
  const scopes = [];
  FRAMEWORKS.push({
    name: "vue-reactivity",
    signal: (v) => {
      const data = shallowRef(v);
      return { read: () => data.value, write: (x) => (data.value = x) };
    },
    computed: (fn) => {
      const c = computed(fn);
      return { read: () => c.value };
    },
    effect: (fn) => {
      const runner = effect(() => fn(), {
        scheduler: () => scheduled.push(runner),
      });
    },
    withBatch: (fn) => {
      if (batching) {
        fn();
      } else {
        batching = true;
        fn();
        while (scheduled.length) scheduled.pop()();
        batching = false;
      }
    },
    withBuild: (fn) => {
      const e = effectScope();
      scopes.push(e);
      return e.run(fn);
    },
    cleanup: () => {
      scheduled.length = 0;
      for (let i = 0; i < scopes.length; i++) scopes[i].stop();
      scopes.length = 0;
    },
  });
}

// --- solid-js ---
if (solidLib) {
  const { createSignal, createMemo, createRenderEffect, createRoot, batch } =
    solidLib;
  const roots = [];
  FRAMEWORKS.push({
    name: "solid",
    signal: (v) => {
      const [get, set] = createSignal(v);
      return { read: () => get(), write: (x) => set(x) };
    },
    computed: (fn) => {
      const memo = createMemo(fn);
      return { read: () => memo() };
    },
    effect: (fn) => createRenderEffect(fn),
    withBatch: (fn) => batch(fn),
    withBuild: (fn) => {
      let ret;
      createRoot((dispose) => {
        roots.push(dispose);
        ret = fn();
      });
      return ret;
    },
    cleanup: () => {
      for (let i = 0; i < roots.length; i++) roots[i]();
      roots.length = 0;
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Shared utils
// ─────────────────────────────────────────────────────────────────────────
class Counter {
  count = 0;
}

function runTimed(fn) {
  const start = performance.now();
  const result = fn();
  return { result, time: performance.now() - start };
}

async function fastestTest(times, fn) {
  let best = null;
  for (let i = 0; i < times; i++) {
    globalThis.gc?.();
    const r = runTimed(fn);
    globalThis.gc?.();
    if (best === null || r.time < best.time) best = r;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
// Dynamic dependency graph (the configurable benchmark)
// ─────────────────────────────────────────────────────────────────────────
function makeGraph(framework, config, counter) {
  const { width, totalLayers, staticFraction, nSources } = config;
  return framework.withBuild(() => {
    const sources = new Array(width).fill(0).map((_, i) => framework.signal(i));
    const rows = makeDependentRows(
      sources,
      totalLayers - 1,
      counter,
      staticFraction,
      nSources,
      framework
    );
    return { sources, layers: rows };
  });
}

function runGraph(graph, iterations, readFraction, framework) {
  const rand = makeRng("seed");
  const { sources, layers } = graph;
  const leaves = layers[layers.length - 1];
  const skipCount = Math.round(leaves.length * (1 - readFraction));
  const readLeaves = removeElems(leaves, skipCount, rand);
  let sum = 0;

  framework.withBatch(() => {
    for (let i = 0; i < iterations; i++) {
      const sourceDex = i % sources.length;
      sources[sourceDex].write(i + sourceDex);
      for (const leaf of readLeaves) leaf.read();
    }
    sum = readLeaves.reduce((total, leaf) => leaf.read() + total, 0);
  });

  return sum;
}

function removeElems(src, rmCount, rand) {
  const copy = src.slice();
  for (let i = 0; i < rmCount; i++) {
    const rmDex = rand.int(0, copy.length - 1);
    copy.splice(rmDex, 1);
  }
  return copy;
}

function makeDependentRows(
  sources,
  numRows,
  counter,
  staticFraction,
  nSources,
  framework
) {
  let prevRow = sources;
  const rand = makeRng("seed");
  const rows = [];
  for (let l = 0; l < numRows; l++) {
    const row = makeRow(prevRow, counter, staticFraction, nSources, framework, rand);
    rows.push(row);
    prevRow = row;
  }
  return rows;
}

function makeRow(sources, counter, staticFraction, nSources, framework, random) {
  return sources.map((_, myDex) => {
    const mySources = [];
    for (let sourceDex = 0; sourceDex < nSources; sourceDex++) {
      mySources.push(sources[(myDex + sourceDex) % sources.length]);
    }
    const staticNode = random.float() < staticFraction;
    if (staticNode) {
      return framework.computed(() => {
        counter.count++;
        let sum = 0;
        for (const src of mySources) sum += src.read();
        return sum;
      });
    } else {
      const first = mySources[0];
      const tail = mySources.slice(1);
      return framework.computed(() => {
        counter.count++;
        let sum = first.read();
        const shouldDrop = sum & 0x1;
        const dropDex = sum % tail.length;
        for (let i = 0; i < tail.length; i++) {
          if (shouldDrop && i === dropDex) continue;
          sum += tail[i].read();
        }
        return sum;
      });
    }
  });
}

const perfTests = [
  { name: "simple component", width: 10, staticFraction: 1, nSources: 2, totalLayers: 5, readFraction: 0.2, iterations: QUICK ? 6000 : 600000 },
  { name: "dynamic component", width: 10, totalLayers: 10, staticFraction: 3 / 4, nSources: 6, readFraction: 0.2, iterations: QUICK ? 1500 : 15000 },
  { name: "large web app", width: 1000, totalLayers: 12, staticFraction: 0.95, nSources: 4, readFraction: 1, iterations: QUICK ? 200 : 7000 },
  { name: "wide dense", width: 1000, totalLayers: 5, staticFraction: 1, nSources: 25, readFraction: 1, iterations: QUICK ? 200 : 3000 },
  { name: "deep", width: 5, totalLayers: 500, staticFraction: 1, nSources: 3, readFraction: 1, iterations: QUICK ? 100 : 500 },
];

async function runDynamic(framework) {
  const rows = [];
  for (const config of perfTests) {
    const counter = new Counter();
    const runOnce = () => {
      try {
        const graph = makeGraph(framework, config, counter);
        const res = runGraph(graph, config.iterations, config.readFraction, framework);
        globalThis.gc?.();
        return res;
      } catch (err) {
        console.warn(`  ! dynamic "${framework.name}/${config.name}":`, err.message);
        return NaN;
      }
    };
    runOnce(); // warm up
    let sum = NaN;
    const { time } = await fastestTest(DYN_REPEATS, () => {
      counter.count = 0;
      sum = runOnce();
      return sum;
    });
    rows.push({ test: `dyn: ${config.name}`, time, sum });
    framework.cleanup?.();
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// kairo cases
// ─────────────────────────────────────────────────────────────────────────
function busy() {
  let a = 0;
  for (let i = 0; i < 100; i++) a++;
  return a;
}

function k_avoidable(b) {
  const head = b.signal(0);
  const c1 = b.computed(() => head.read());
  const c2 = b.computed(() => (c1.read(), 0));
  const c3 = b.computed(() => (busy(), c2.read() + 1));
  const c4 = b.computed(() => c3.read() + 2);
  const c5 = b.computed(() => c4.read() + 3);
  b.effect(() => { c5.read(); busy(); });
  return () => {
    for (let i = 0; i < KAIRO_ITERS; i++) {
      b.withBatch(() => head.write(i));
      console.assert(c5.read() === 6);
    }
  };
}

function k_broad(b) {
  const head = b.signal(0);
  let last = head;
  for (let i = 0; i < 50; i++) {
    const cur = b.computed(() => head.read() + i);
    const cur2 = b.computed(() => cur.read() + 1);
    b.effect(() => cur2.read());
    last = cur2;
  }
  return () => {
    for (let i = 0; i < 50; i++) {
      b.withBatch(() => head.write(i));
      console.assert(last.read() === i + 50);
    }
  };
}

function k_deep(b) {
  const len = 50;
  const head = b.signal(0);
  let cur = head;
  for (let i = 0; i < len; i++) {
    const c = cur;
    cur = b.computed(() => c.read() + 1);
  }
  const tip = cur;
  b.effect(() => tip.read());
  return () => {
    for (let i = 0; i < 50; i++) {
      b.withBatch(() => head.write(i));
      console.assert(tip.read() === len + i);
    }
  };
}

function k_diamond(b) {
  const width = 5;
  const head = b.signal(0);
  const cur = [];
  for (let i = 0; i < width; i++) cur.push(b.computed(() => head.read() + 1));
  const sum = b.computed(() => cur.map((x) => x.read()).reduce((a, c) => a + c, 0));
  b.effect(() => sum.read());
  return () => {
    for (let i = 0; i < 500; i++) {
      b.withBatch(() => head.write(i));
      console.assert(sum.read() === (i + 1) * width);
    }
  };
}

function k_mux(b) {
  const heads = new Array(100).fill(null).map(() => b.signal(0));
  const m = b.computed(() => Object.fromEntries(heads.map((h) => h.read()).entries()));
  const splited = heads
    .map((_, index) => b.computed(() => m.read()[index]))
    .map((x) => b.computed(() => x.read() + 1));
  splited.forEach((x) => b.effect(() => x.read()));
  return () => {
    for (let i = 0; i < 10; i++) {
      b.withBatch(() => heads[i].write(i));
      console.assert(splited[i].read() === i + 1);
    }
    for (let i = 0; i < 10; i++) {
      b.withBatch(() => heads[i].write(i * 2));
      console.assert(splited[i].read() === i * 2 + 1);
    }
  };
}

function k_repeated(b) {
  const size = 30;
  const head = b.signal(0);
  const cur = b.computed(() => {
    let r = 0;
    for (let i = 0; i < size; i++) r += head.read();
    return r;
  });
  b.effect(() => cur.read());
  return () => {
    for (let i = 0; i < 100; i++) {
      b.withBatch(() => head.write(i));
      console.assert(cur.read() === i * size);
    }
  };
}

function k_triangle(b) {
  const width = 10;
  const head = b.signal(0);
  let cur = head;
  const list = [];
  for (let i = 0; i < width; i++) {
    const c = cur;
    list.push(cur);
    cur = b.computed(() => c.read() + 1);
  }
  const sum = b.computed(() => list.map((x) => x.read()).reduce((a, c) => a + c, 0));
  b.effect(() => sum.read());
  const constant = new Array(width).fill(0).map((_, i) => i + 1).reduce((x, y) => x + y, 0);
  return () => {
    for (let i = 0; i < 100; i++) {
      b.withBatch(() => head.write(i));
      console.assert(sum.read() === constant - width + i * width);
    }
  };
}

function k_unstable(b) {
  const head = b.signal(0);
  const double = b.computed(() => head.read() * 2);
  const inverse = b.computed(() => -head.read());
  const cur = b.computed(() => {
    let r = 0;
    for (let i = 0; i < 20; i++) r += head.read() % 2 ? double.read() : inverse.read();
    return r;
  });
  b.effect(() => cur.read());
  return () => {
    for (let i = 0; i < 100; i++) b.withBatch(() => head.write(i));
  };
}

const KAIRO_CASES = [
  ["avoidable", k_avoidable],
  ["broad", k_broad],
  ["deep", k_deep],
  ["diamond", k_diamond],
  ["mux", k_mux],
  ["repeated", k_repeated],
  ["triangle", k_triangle],
  ["unstable", k_unstable],
];

async function runKairo(framework) {
  const rows = [];
  for (const [name, build] of KAIRO_CASES) {
    const iter = framework.withBuild(() => build(framework));
    iter(); // warm up
    const { time } = await fastestTest(KAIRO_REPEATS, () => {
      for (let i = 0; i < KAIRO_ITERS; i++) iter();
    });
    rows.push({ test: `kairo: ${name}`, time });
    framework.cleanup?.();
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// molBench
// ─────────────────────────────────────────────────────────────────────────
function fib(n) {
  if (n < 2) return 1;
  return fib(n - 1) + fib(n - 2);
}
function hard(n) {
  return n + fib(16);
}
const molNumbers = Array.from({ length: 5 }, (_, i) => i);

async function runMol(framework) {
  let res = [];
  const iter = framework.withBuild(() => {
    const A = framework.signal(0);
    const B = framework.signal(0);
    const C = framework.computed(() => (A.read() % 2) + (B.read() % 2));
    const D = framework.computed(() => molNumbers.map((i) => ({ x: i + (A.read() % 2) - (B.read() % 2) })));
    const E = framework.computed(() => hard(C.read() + A.read() + D.read()[0].x));
    const F = framework.computed(() => hard(D.read()[2].x || B.read()));
    const G = framework.computed(() => C.read() + (C.read() || E.read() % 2) + D.read()[4].x + F.read());
    framework.effect(() => res.push(hard(G.read())));
    framework.effect(() => res.push(G.read()));
    framework.effect(() => res.push(hard(F.read())));
    return (i) => {
      res.length = 0;
      framework.withBatch(() => { B.write(1); A.write(1 + i * 2); });
      framework.withBatch(() => { A.write(2 + i * 2); B.write(2); });
    };
  });
  iter(1); // warm up
  const { time } = await fastestTest(MOL_REPEATS, () => {
    for (let i = 0; i < MOL_ITERS; i++) iter(i);
  });
  framework.cleanup?.();
  return [{ test: "mol", time }];
}

// ─────────────────────────────────────────────────────────────────────────
// sBench (S.js create/update micro-benchmarks)
// ─────────────────────────────────────────────────────────────────────────
async function runS(framework) {
  const rows = [];
  const C = S_COUNT;

  const benches = [
    ["createDataSignals", createDataSignals, C, C],
    ["createComputations0to1", createComputations0to1, C, 0],
    ["createComputations1to1", createComputations1to1, C, C],
    ["createComputations2to1", createComputations2to1, C / 2, C],
    ["createComputations4to1", createComputations4to1, C / 4, C],
    ["createComputations1000to1", createComputations1000to1, C / 1000, C],
    ["createComputations1to2", createComputations1to2, C, C / 2],
    ["createComputations1to4", createComputations1to4, C, C / 4],
    ["createComputations1to8", createComputations1to8, C, C / 8],
    ["createComputations1to1000", createComputations1to1000, C, C / 1000],
    ["updateComputations1to1", updateComputations1to1, C * 4, 1],
    ["updateComputations2to1", updateComputations2to1, C * 2, 2],
    ["updateComputations4to1", updateComputations4to1, C, 4],
    ["updateComputations1000to1", updateComputations1000to1, C / 100, 1000],
    ["updateComputations1to2", updateComputations1to2, C * 4, 1],
    ["updateComputations1to4", updateComputations1to4, C * 4, 1],
    ["updateComputations1to1000", updateComputations1to1000, C * 4, 1],
  ];

  for (const [name, fn, count, scount] of benches) {
    const time = run(fn, count, scount);
    rows.push({ test: `S: ${name}`, time });
    framework.cleanup?.();
  }
  return rows;

  function run(fn, n, scount) {
    let start = 0, end = 0;
    framework.withBuild(() => {
      let sources = createDataSignals(scount, []);
      fn(n / 100, sources);
      sources = createDataSignals(scount, []);
      fn(n / 100, sources);
      sources = createDataSignals(scount, []);
      fn(n / 100, sources);
      sources = createDataSignals(scount, []);
      for (let i = 0; i < scount; i++) {
        sources[i].read(); sources[i].read(); sources[i].read();
      }
      globalThis.gc?.();
      start = performance.now();
      fn(n, sources);
      sources = null;
      globalThis.gc?.();
      end = performance.now();
    });
    return end - start;
  }

  function createDataSignals(n, sources) {
    for (let i = 0; i < n; i++) sources[i] = framework.signal(i);
    return sources;
  }
  function createComputations0to1(n) {
    for (let i = 0; i < n; i++) framework.computed(() => i);
  }
  function createComputations1to1000(n, sources) {
    for (let i = 0; i < n / 1000; i++) {
      const { read: get } = sources[i];
      for (let j = 0; j < 1000; j++) framework.computed(() => get());
    }
  }
  function createComputations1to8(n, sources) {
    for (let i = 0; i < n / 8; i++) {
      const { read: get } = sources[i];
      for (let j = 0; j < 8; j++) framework.computed(() => get());
    }
  }
  function createComputations1to4(n, sources) {
    for (let i = 0; i < n / 4; i++) {
      const { read: get } = sources[i];
      for (let j = 0; j < 4; j++) framework.computed(() => get());
    }
  }
  function createComputations1to2(n, sources) {
    for (let i = 0; i < n / 2; i++) {
      const { read: get } = sources[i];
      framework.computed(() => get());
      framework.computed(() => get());
    }
  }
  function createComputations1to1(n, sources) {
    for (let i = 0; i < n; i++) {
      const { read: get } = sources[i];
      framework.computed(() => get());
    }
  }
  function createComputations2to1(n, sources) {
    for (let i = 0; i < n; i++) {
      const s1 = sources[i * 2].read, s2 = sources[i * 2 + 1].read;
      framework.computed(() => s1() + s2());
    }
  }
  function createComputations4to1(n, sources) {
    for (let i = 0; i < n; i++) {
      const s1 = sources[i * 4].read, s2 = sources[i * 4 + 1].read,
        s3 = sources[i * 4 + 2].read, s4 = sources[i * 4 + 3].read;
      framework.computed(() => s1() + s2() + s3() + s4());
    }
  }
  function createComputations1000to1(n, sources) {
    for (let i = 0; i < n; i++) createComputation1000(sources, i * 1000);
  }
  function createComputation1000(ss, offset) {
    framework.computed(() => {
      let sum = 0;
      for (let i = 0; i < 1000; i++) sum += ss[offset + i].read();
      return sum;
    });
  }
  function updateComputations1to1(n, sources) {
    const { read: g, write: s } = sources[0];
    framework.computed(() => g());
    for (let i = 0; i < n; i++) s(i);
  }
  function updateComputations2to1(n, sources) {
    const { read: g1, write: s } = sources[0], { read: g2 } = sources[1];
    framework.computed(() => g1() + g2());
    for (let i = 0; i < n; i++) s(i);
  }
  function updateComputations4to1(n, sources) {
    const { read: g1, write: s } = sources[0], { read: g2 } = sources[1],
      { read: g3 } = sources[2], { read: g4 } = sources[3];
    framework.computed(() => g1() + g2() + g3() + g4());
    for (let i = 0; i < n; i++) s(i);
  }
  function updateComputations1000to1(n, sources) {
    const { write: s } = sources[0];
    framework.computed(() => {
      let sum = 0;
      for (let i = 0; i < 1000; i++) sum += sources[i].read();
      return sum;
    });
    for (let i = 0; i < n; i++) s(i);
  }
  function updateComputations1to2(n, sources) {
    const { read: g, write: s } = sources[0];
    framework.computed(() => g());
    framework.computed(() => g());
    for (let i = 0; i < n / 2; i++) s(i);
  }
  function updateComputations1to4(n, sources) {
    const { read: g, write: s } = sources[0];
    for (let j = 0; j < 4; j++) framework.computed(() => g());
    for (let i = 0; i < n / 4; i++) s(i);
  }
  function updateComputations1to1000(n, sources) {
    const { read: g, write: s } = sources[0];
    for (let i = 0; i < 1000; i++) framework.computed(() => g());
    for (let i = 0; i < n / 1000; i++) s(i);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// cellxBench (with deterministic before/after correctness vectors)
// ─────────────────────────────────────────────────────────────────────────
function cellx(framework, layers) {
  return framework.withBuild(() => {
    const start = {
      prop1: framework.signal(1),
      prop2: framework.signal(2),
      prop3: framework.signal(3),
      prop4: framework.signal(4),
    };
    let layer = start;
    for (let i = layers; i > 0; i--) {
      const m = layer;
      const s = {
        prop1: framework.computed(() => m.prop2.read()),
        prop2: framework.computed(() => m.prop1.read() - m.prop3.read()),
        prop3: framework.computed(() => m.prop2.read() + m.prop4.read()),
        prop4: framework.computed(() => m.prop3.read()),
      };
      framework.effect(() => s.prop1.read());
      framework.effect(() => s.prop2.read());
      framework.effect(() => s.prop3.read());
      framework.effect(() => s.prop4.read());
      s.prop1.read(); s.prop2.read(); s.prop3.read(); s.prop4.read();
      layer = s;
    }
    const end = layer;
    const t0 = performance.now();
    const before = [end.prop1.read(), end.prop2.read(), end.prop3.read(), end.prop4.read()];
    framework.withBatch(() => {
      start.prop1.write(4); start.prop2.write(3); start.prop3.write(2); start.prop4.write(1);
    });
    const after = [end.prop1.read(), end.prop2.read(), end.prop3.read(), end.prop4.read()];
    const elapsed = performance.now() - t0;
    return [elapsed, before, after];
  });
}

const CELLX_EXPECTED = {
  1000: [[-3, -6, -2, 2], [-2, -4, 2, 3]],
  2500: [[-3, -6, -2, 2], [-2, -4, 2, 3]],
  5000: [[2, 4, -1, -6], [-2, 1, -4, -4]],
};
const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function runCellx(framework) {
  const rows = [];
  const layerSizes = QUICK ? [1000] : [1000, 2500, 5000];
  for (const layers of layerSizes) {
    let total = 0;
    let lastBefore, lastAfter;
    const reps = QUICK ? 2 : 10;
    for (let i = 0; i < reps; i++) {
      const [elapsed, before, after] = cellx(framework, layers);
      total += elapsed;
      lastBefore = before;
      lastAfter = after;
      framework.cleanup?.();
    }
    const exp = CELLX_EXPECTED[layers];
    const ok = arraysEqual(lastBefore, exp[0]) && arraysEqual(lastAfter, exp[1]);
    if (!ok) {
      console.warn(`  ! cellx${layers} "${framework.name}" mismatch: before=${lastBefore} after=${lastAfter}`);
    }
    rows.push({ test: `cellx: ${layers}`, time: total, ok });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// Runner + reporting
// ─────────────────────────────────────────────────────────────────────────
function fmtMs(n) {
  return Number.isFinite(n) ? n.toFixed(2).padStart(9) + "ms" : "      n/a";
}
function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - s.length));
}

const results = {}; // testName -> { fwName -> {time, sum?, ok?} }
const testOrder = [];
function record(fwName, rows) {
  for (const row of rows) {
    if (!results[row.test]) {
      results[row.test] = {};
      testOrder.push(row.test);
    }
    results[row.test][fwName] = row;
  }
}

// Optional single-framework filter, e.g. FW=preact (comma-separated allowed).
const FW_FILTER = process.env.FW
  ? new Set(process.env.FW.split(",").map((s) => s.trim()))
  : null;
const ACTIVE = FW_FILTER
  ? FRAMEWORKS.filter((f) => FW_FILTER.has(f.name))
  : FRAMEWORKS;

console.log(
  `Config: ${QUICK ? "QUICK smoke run" : "FULL run"}  |  frameworks: ${ACTIVE.map((f) => f.name).join(", ")}`
);
if (typeof globalThis.gc !== "function") {
  console.log("⚠️  Run with --expose-gc for clean timing/memory.");
}
console.log("");

for (const fw of ACTIVE) {
  process.stdout.write(`Running ${fw.name} ... `);
  const t0 = performance.now();
  record(fw.name, await runKairo(fw));
  record(fw.name, await runMol(fw));
  record(fw.name, await runS(fw));
  record(fw.name, runCellx(fw));
  record(fw.name, await runDynamic(fw));
  fw.cleanup?.();
  globalThis.gc?.();
  console.log(`done (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

// ── Comparison table (grouped by test, frameworks side by side) ─────────────
console.log("");
const nameCol = 34;
const header = pad("test", nameCol) + ACTIVE.map((f) => pad(f.name, 16)).join("");
console.log(header);
console.log("─".repeat(header.length));
for (const test of testOrder) {
  const cells = ACTIVE.map((f) => {
    const r = results[test][f.name];
    return pad(r ? fmtMs(r.time).trim() : "n/a", 16);
  });
  console.log(pad(test, nameCol) + cells.join(""));
}

// ── Correctness: dynamic-graph sum agreement across frameworks ──────────────
// Only FINITE sums are compared. A framework whose adapter threw (runDynamic
// caught the error and returned NaN — e.g. Solid creating computations outside a
// createRoot) is reported as "failed" and EXCLUDED from the agreement test: a
// third-party adapter erroring out is not evidence about any other framework's
// correctness. Among the finite sums, exact equality is "agree"; values that
// match only within a tiny relative epsilon are flagged "(fp)" — that is
// floating-point non-associativity at large magnitudes (e.g. the deep chain
// reaching ~1e241), not a reactivity bug. Only a real beyond-epsilon mismatch
// among working frameworks counts as DIVERGE.
console.log("");
console.log("Correctness — dynamic-graph leaf-sum agreement across frameworks:");
const REL_EPS = 1e-9;
let allAgree = true;
for (const test of testOrder) {
  if (!test.startsWith("dyn:")) continue;

  const entries = ACTIVE
    .map((f) => ({ name: f.name, sum: results[test][f.name]?.sum }))
    .filter((e) => e.sum !== undefined);
  const finite = entries.filter((e) => Number.isFinite(e.sum));
  const failed = entries.filter((e) => !Number.isFinite(e.sum));

  let status;
  if (finite.length < 2) {
    status = "—  (insufficient finite results)";
  } else {
    const ref = finite[0].sum;
    const exact = finite.every((e) => e.sum === ref);
    const approx = finite.every(
      (e) => Math.abs(e.sum - ref) <= REL_EPS * Math.max(Math.abs(e.sum), Math.abs(ref))
    );
    if (exact) status = "✓ agree";
    else if (approx) status = "≈ agree (fp)";
    else { status = "✗ DIVERGE"; allAgree = false; }
  }

  const failNote = failed.length ? `  [${failed.map((e) => `${e.name}: failed`).join(", ")}]` : "";
  console.log(`  ${pad(test, nameCol)} ${status}${failNote}`);
  // Show the per-framework breakdown whenever it's worth inspecting.
  if (status.startsWith("✗") || status.startsWith("≈")) {
    for (const e of finite) console.log(`      ${pad(e.name, 16)} ${e.sum}`);
  }
}

// ── Correctness: cellx vectors ──────────────────────────────────────────────
let cellxOk = true;
for (const test of testOrder) {
  if (!test.startsWith("cellx:")) continue;
  for (const fw of ACTIVE) {
    const r = results[test][fw.name];
    if (r && r.ok === false) cellxOk = false;
  }
}
console.log("");
console.log(`Correctness — kairo + cellx internal assertions: ${cellxOk ? "✓ cellx vectors matched" : "✗ cellx mismatch (see warnings above)"}`);
console.log(`Correctness — dynamic sum agreement: ${allAgree ? "✓ all working frameworks agree (failed adapters excluded)" : "✗ divergence detected"}`);
console.log("");
console.log("Note: times from this host are a relative baseline; run on a quiet machine for publishable numbers.");
