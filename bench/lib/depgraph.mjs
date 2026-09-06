// bench/lib/depgraph.mjs -- faithful port of src_2 util/dependencyGraph.ts.
//
// This is the mirror's core: it reproduces Andrii's graph shapes and drive loop
// byte-for-behavior so the counters (nodesRecomputed/nodesVisited/edgesTraversed/
// sinkReads) come out IDENTICAL to his log. Those counters are the F6 proof: if a row
// here reports the same counts as his row for the same shape, the two harnesses did
// the same work and the times are comparable. If they diverge, the port is wrong and
// the counter-agreement guard says so.
//
// The one external dep in his source is npm `random` (`new Random("seed").float()/.int()`).
// The mirror cannot take that dep, so we port a seeded PRNG below and PIN it against his
// published counter values (see bench/lib/_depgraph_verify.mjs). The RNG only decides
// static-vs-dynamic node split and leaf-skip selection; matching his counters proves the
// sequence matches his.

// --- seeded RNG -----------------------------------------------------------------------
// The mirror MUST reproduce Andrii's exact static/dynamic node split, which is driven by
// `new Random("seed").float() < staticFraction`. His source uses npm `random`, so the
// mirror uses it too -- bit-identity is the only way the counters match his log, and the
// counter-match IS the proof of a faithful port (verified in _depgraph_verify.mjs against
// his published counter values). A hashed-seed mulberry32 was tried first and diverged on
// exactly the staticFraction<1 shapes, which is what motivated using his real dep.
import { Random } from "random";

export function makeRandom(seedStr) {
    const r = new Random(seedStr);
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

// --- runGraph (verbatim drive semantics) ----------------------------------------------
function removeElems(src, rmCount, rand) {
    const copy = src.slice();
    for (let i = 0; i < rmCount; i++) copy.splice(rand.int(0, copy.length - 1), 1);
    return copy;
}

export function runGraph(graph, config, framework) {
    return withActiveCounter(graph.counter, () => {
        const { iterations, readFraction, mode = "mixed", updatesPerIteration = 1, sinkReadMode = "per-update", startTick = 0 } = config;
        const rand = makeRandom("seed");
        const { sources, layers } = graph;
        const leaves = layers[layers.length - 1];
        const skipCount = Math.round(leaves.length * (1 - readFraction));
        const readLeaves = removeElems(leaves, skipCount, rand);
        const fwName = framework.name.toLowerCase();
        const batchPerIteration = fwName === "s-js" || fwName === "solidjs";

        const writeIteration = (iteration, updateDex) => {
            const tick = startTick + iteration * updatesPerIteration + updateDex;
            sources[tick % sources.length].write(tick + (tick % sources.length));
        };
        const sumLeaves = () => { let t = 0; for (const leaf of readLeaves) t += trackedRead(leaf); return t; };
        const flushPerIteration = (iteration) => {
            if (sinkReadMode === "final-only") { for (let u = 0; u < updatesPerIteration; u++) writeIteration(iteration, u); return; }
            if (sinkReadMode === "per-update") { for (let u = 0; u < updatesPerIteration; u++) { writeIteration(iteration, u); readLeaves.forEach(trackedRead); } return; }
            for (let u = 0; u < updatesPerIteration; u++) writeIteration(iteration, u);
            readLeaves.forEach(trackedRead);
        };
        const writeOnlyIteration = (iteration) => { for (let u = 0; u < updatesPerIteration; u++) writeIteration(iteration, u); };

        if (mode === "pull") {
            if (batchPerIteration) { for (let i = 0; i < iterations; i++) framework.withBatch(() => writeOnlyIteration(i)); }
            else framework.withBatch(() => { for (let i = 0; i < iterations; i++) writeOnlyIteration(i); });
            return sumLeaves();
        }
        if (mode === "push") {
            const latest = new Array(readLeaves.length).fill(0);
            readLeaves.forEach((leaf, i) => framework.effect(() => { latest[i] = trackedRead(leaf); }));
            for (let i = 0; i < iterations; i++) framework.withBatch(() => writeOnlyIteration(i));
            return latest.reduce((t, v) => t + v, 0);
        }
        let sum = 0;
        if (batchPerIteration) { for (let i = 0; i < iterations; i++) framework.withBatch(() => flushPerIteration(i)); sum = sumLeaves(); }
        else framework.withBatch(() => { for (let i = 0; i < iterations; i++) flushPerIteration(i); sum = sumLeaves(); });
        return sum;
    });
}
