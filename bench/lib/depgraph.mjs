// bench/lib/depgraph.mjs -- faithful port of src_2 util/dependencyGraph.ts.
//
// This is the mirror's core: it reproduces Andrii's graph shapes and drive loop
// byte-for-behavior so the counters (nodesRecomputed/nodesVisited/edgesTraversed/
// sinkReads) come out IDENTICAL to his log. Those counters are the F6 proof: if a row
// here reports the same counts as his row for the same shape, the two harnesses did
// the same work and the times are comparable. If they diverge, the port is wrong and
// the counter-agreement guard says so.
//
// The one external dep in his source used to be npm `random`. His copy now vendors the
// random@5.4.1 generator (src/util/seededRandom.ts) and this mirror vendors the same
// code below. The RNG only decides static-vs-dynamic node split and leaf-skip selection;
// the counter match against his log (mirror.mjs --self-verify) is the proof the sequence
// matches his.

// --- seeded RNG -----------------------------------------------------------------------
// The mirror MUST reproduce Andrii's exact static/dynamic node split, which is driven by
// `float() < staticFraction`, so this is the same generator, not a look-alike: npm
// random@5.5 seeds strings with xoshiro128** and corrects the ARC4 swap, and either change
// moves every staticFraction<1 row. Golden sequence: bench/lib/_selftest.mjs.
//
// Vendored from js-reactivity-benchmark (https://github.com/volynetstyle/js-reactivity-benchmark)
// src/util/seededRandom.ts:14-91 at commit e3107157e34653b2770d1eab27c97b2e6615e850
// (sha256/8 of that file 6ee8056e). Port: TypeScript annotations and `private` / `readonly`
// removed; the logic and comments are unchanged. The generator is itself a copy of the
// ARC4 generator in npm random@5.4.1 (MIT, (c) Travis Fischer).
//
// MIT License
//
// Copyright (c) 2026 Andrii Volynets
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
class SeededRandom {
  i = 0;
  j = 0;
  S = [];

  constructor(seed) {
    const key = mixKey(seed);
    const S = this.S;
    for (let i = 0; i <= 255; i++) S[i] = i;
    for (let i = 0, j = 0; i <= 255; i++) {
      const t = S[i];
      j = 255 & (j + key[i % key.length] + t);
      S[i] = S[j];
      S[j] = t;
    }
    this.g(256);
  }

  /** Uniform float in [0, 1), with 52 bits of randomness. */
  next() {
    let n = this.g(6);
    let d = 281474976710656; // 2^48
    let x = 0;
    while (n < 4503599627370496) {
      // 2^52
      n = (n + x) * 256;
      d *= 256;
      x = this.g(1);
    }
    while (n >= 9007199254740992) {
      // 2^53
      n /= 2;
      d /= 2;
      x >>>= 1;
    }
    return (n + x) / d;
  }

  /** Equivalent to `random@5.4.1` `Random#float()` with default bounds. */
  float() {
    return this.next();
  }

  /** Equivalent to `random@5.4.1` `Random#int(min, max)`; both inclusive. */
  int(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max))
      throw new TypeError("SeededRandom.int bounds must be integers");
    return Math.floor(this.next() * (max - min + 1) + min);
  }

  g(count) {
    const S = this.S;
    let i = this.i;
    let j = this.j;
    let r = 0;
    while (count--) {
      i = 255 & (i + 1);
      const t = S[i];
      S[j] = t;
      j = 255 & (j + t);
      S[i] = S[j];
      r = r * 256 + S[255 & (S[i] + t)];
    }
    this.i = i;
    this.j = j;
    return r;
  }
}

function mixKey(seed) {
  const key = [];
  let smear = 0;
  for (let j = 0; j < seed.length; j++) {
    key[255 & j] =
      255 & ((smear ^= (key[255 & j] ?? 0) * 19) + seed.charCodeAt(j));
  }
  return key.length ? key : [0];
}

export function makeRandom(seedStr) {
    const r = new SeededRandom(seedStr);
    return {
        float: () => r.float(),
        int: (lo, hi) => r.int(lo, hi),
    };
}

export class Counter {
    count = 0; nodesVisited = 0; edgesTraversed = 0; sinkReads = 0;
    reset() { this.count = 0; this.nodesVisited = 0; this.edgesTraversed = 0; this.sinkReads = 0; }
    snapshot() {
        return { nodesRecomputed: this.count, nodesVisited: this.nodesVisited, edgesTraversed: this.edgesTraversed, sinkReads: this.sinkReads };
    }
}

// active-counter shim so sink reads are counted exactly where his trackedRead counts them
let activeCounter = null;
function withActiveCounter(counter, fn) {
    const prev = activeCounter; activeCounter = counter;
    try { return fn(); } finally { activeCounter = prev; }
}
function trackedRead(node) {
    if (activeCounter) activeCounter.sinkReads++;
    return node.read();
}

// --- static/dynamic node bodies (counters incremented exactly as his source) ----------
function readStaticNode(mySources, counter) {
    counter.count++; counter.nodesVisited++; counter.edgesTraversed++;
    let sum = mySources[0].read();
    for (let i = 1; i < mySources.length; i++) { counter.edgesTraversed++; sum += mySources[i].read(); }
    return sum;
}

// --- source pickers (verbatim) ---------------------------------------------------------
function pickRectSources(sources, myDex, nSources) {
    const s = [];
    for (let d = 0; d < nSources; d++) s.push(sources[(myDex + d) % sources.length]);
    return s;
}
function pickLayeredSources(prevRow, nodeDex, fanIn, layer) {
    const s = []; const base = (nodeDex * 13 + layer * 17) % prevRow.length;
    const step = Math.max(1, Math.floor(prevRow.length / Math.max(1, fanIn * 8)));
    for (let d = 0; d < fanIn; d++) s.push(prevRow[(base + d * step) % prevRow.length]);
    return s;
}
function pickMeshSources(prevRow, nodeDex, fanIn, layer) {
    const s = []; const clusterSize = Math.max(2, Math.floor(fanIn / 2));
    const clusterBase = (Math.floor(nodeDex / clusterSize) * clusterSize + layer * clusterSize) % prevRow.length;
    for (let d = 0; d < fanIn; d++) s.push(prevRow[(clusterBase + Math.floor(d / 2)) % prevRow.length]);
    return s;
}

// --- row builders ----------------------------------------------------------------------
function makeRow(sources, counter, staticFraction, nSources, framework, random) {
    return sources.map((_, myDex) => {
        const mySources = pickRectSources(sources, myDex, nSources);
        const isStatic = random.float() < staticFraction;
        if (isStatic) return framework.computed(() => readStaticNode(mySources, counter));
        const first = mySources[0], tail = mySources.slice(1);
        return framework.computed(() => {
            counter.count++; counter.nodesVisited++; counter.edgesTraversed++;
            let sum = first.read();
            const shouldDrop = sum & 0x1, dropDex = sum % tail.length;
            for (let i = 0; i < tail.length; i++) { if (shouldDrop && i === dropDex) continue; counter.edgesTraversed++; sum += tail[i].read(); }
            return sum;
        });
    });
}
function makeLayeredNode(prevRow, nodeDex, layer, counter, staticFraction, fanIn, framework, graphKind, random) {
    const mySources = graphKind === "diamond-mesh"
        ? pickMeshSources(prevRow, nodeDex, fanIn, layer)
        : pickLayeredSources(prevRow, nodeDex, fanIn, layer);
    const isStatic = random.float() < staticFraction;
    if (isStatic) return framework.computed(() => readStaticNode(mySources, counter));
    const first = mySources[0], tail = mySources.slice(1);
    return framework.computed(() => {
        counter.count++; counter.nodesVisited++; counter.edgesTraversed++;
        let sum = first.read();
        const shouldDrop = (sum + layer + nodeDex) & 0x1;
        const dropDex = tail.length === 0 ? 0 : (sum + nodeDex) % tail.length;
        for (let i = 0; i < tail.length; i++) { if (shouldDrop && i === dropDex) continue; counter.edgesTraversed++; sum += tail[i].read(); }
        return sum;
    });
}
function makeDependentRows(sources, numRows, counter, staticFraction, nSources, framework) {
    let prev = sources; const rand = makeRandom("seed"); const rows = [];
    for (let l = 0; l < numRows; l++) { const row = makeRow(prev, counter, staticFraction, nSources, framework, rand); rows.push(row); prev = row; }
    return rows;
}
function makeLayeredRows(initial, numRows, width, counter, staticFraction, fanIn, framework, graphKind) {
    let prev = initial; const rand = makeRandom("seed"); const rows = [];
    for (let layer = 0; layer < numRows; layer++) {
        const row = new Array(width).fill(0).map((_, nodeDex) =>
            makeLayeredNode(prev, nodeDex, layer, counter, staticFraction, fanIn, framework, graphKind, rand));
        rows.push(row); prev = row;
    }
    return rows;
}

// --- makeGraph -------------------------------------------------------------------------
export function makeGraph(framework, config, counter) {
    const { width, totalLayers, staticFraction, nSources, graphKind = "rect", sourcesCount = width, fanIn = nSources } = config;
    return framework.withBuild(() => {
        const sources = new Array(sourcesCount).fill(0).map((_, i) => framework.signal(i));
        const rows = graphKind === "rect"
            ? makeDependentRows(sources, totalLayers - 1, counter, staticFraction, nSources, framework)
            : makeLayeredRows(sources, totalLayers, width, counter, staticFraction, fanIn, framework, graphKind);
        return { sources, layers: rows, counter };
    });
}

// --- runGraph -------------------------------------------------------------------------
// Drive loop and batch granularity of js-reactivity-benchmark src/util/dependencyGraph.ts:77-157
// at fb10dd9: push = one withBatch(writeBatch) per iteration under the leaf effects; mixed
// per-update = one withBatch(write) per write, leaves read OUTSIDE it; every other row = one
// withBatch(writeBatch) per iteration, mixed per-batch reading the leaves after it; then a
// final read() outside any batch. One difference: his push effects are created inside
// fixtureScope (a scope effect, fixtureScope.ts); here they are bare effects: the lite
// adapter's reset() (destroy) disposes them; the alien adapter's reset() is a no-op, so its push effects
// stay subscribed to the retired graph (never written again), unlike his, which disposes every
// framework's push effects.
function removeElems(src, rmCount, rand) {
    const copy = src.slice();
    for (let i = 0; i < rmCount; i++) copy.splice(rand.int(0, copy.length - 1), 1);
    return copy;
}

export function runGraph(graph, config, framework) {
    return withActiveCounter(graph.counter, () => {
        const { iterations, readFraction, mode = "mixed", updatesPerIteration = 1, sinkReadMode = "per-update",
            startTick = 0 } = config;
        const { sources, layers } = graph;
        if (updatesPerIteration > sources.length && (mode !== "mixed" || sinkReadMode !== "per-update")) {
            throw new Error("A transaction must write each source at most once (S.js freeze contract).");
        }
        const leaves = layers[layers.length - 1];
        const removeCount = Math.round(leaves.length * (1 - readFraction));
        // Full-drain rows need neither a copy nor a fresh random generator.
        const readLeaves = removeCount === 0 ? leaves : removeElems(leaves, removeCount, makeRandom("seed"));
        let tick = startTick;
        const write = () => {
            const sourceIndex = tick % sources.length;
            sources[sourceIndex].write(tick + sourceIndex);
            tick++;
        };
        const writeBatch = () => { for (let update = 0; update < updatesPerIteration; update++) write(); };
        const read = () => { let sum = 0; for (const leaf of readLeaves) sum += trackedRead(leaf); return sum; };

        if (mode === "push") {
            const latest = new Array(readLeaves.length).fill(0);
            readLeaves.forEach((leaf, i) => framework.effect(() => { latest[i] = trackedRead(leaf); }));
            for (let iteration = 0; iteration < iterations; iteration++) framework.withBatch(writeBatch);
            return latest.reduce((t, v) => t + v, 0);
        }

        for (let iteration = 0; iteration < iterations; iteration++) {
            if (mode === "mixed" && sinkReadMode === "per-update") {
                for (let update = 0; update < updatesPerIteration; update++) {
                    framework.withBatch(write);
                    read();
                }
            } else {
                framework.withBatch(writeBatch);
                if (mode === "mixed" && sinkReadMode === "per-batch") read();
            }
        }
        return read();
    });
}
