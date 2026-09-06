// burst-dag.mjs (ARCHIVED) -- @zakkster/lite-signal 1.6 burst/flush harness, contiguous-window guess.
// -----------------------------------------------------------------------------
// SUPERSEDED: the canonical harness/burst-dag.mjs now uses Andrii's verbatim
// strided generator (ROADMAP S5 closed). This contiguous-window version is kept
// for provenance only -- it is the earlier faithful guess, before reconciliation.
// Reconstruction of the js-reactivity-benchmark burst shape from its PUBLISHED
// parameters (256->512x32, fanIn 8, burst 16). This uses a CONTIGUOUS edge
// window and is NOT byte-identical to Andrii's generator -- the edge pattern
// and sink topology are a faithful guess. The head-to-head (strided real
// recomputes ~2x the nodes at ~26% higher us/burst, both single-pass -- so the
// gap is locality, not redundancy) now lives in the canonical burst-dag.mjs. The
// point is to characterize lite-signal's OWN burst behavior reproducibly and to
// give burstProfile / watchAllocations a real shape to chew on BEFORE that ask.
//
// It answers ONE question the 1.8 plan hinges on: is the ~2x gap REDUNDANT WORK
// (a multi-pass flush re-marking already-clean cones -- fixable by coalescing) or
// LOCALITY at scale (touching 16k nodes' worth of marks+pulls per burst -- not
// fixable without a layout change, and #10/#12 already proved layout changes
// deopt the propagation hot path)? The structure probe reports flush passes per
// burst and max recomputes per node; if both are 1, there is nothing to coalesce
// and the gap is locality -- which is exactly what ledger #11 concluded by
// profiling. This harness lets you re-confirm that with the new op 6/7 counters
// and quantify it, reproducibly, on any engine build.
//
// Two consumers, one file:
//   - standalone:  node --expose-gc burst-dag.mjs [--width=512 --layers=32 ...]
//       builds the DAG, runs ONE instrumented steady-state burst (structure),
//       then a median-of-N timed run with the profiler DETACHED (the comparable
//       number), and prints a verdict.
//   - the gate:    import { burstDagScenario } and add it to zgc-scenarios.mjs
//       (steady-state allocation under the burst shape). NB each "iter" is one
//       whole burst -- pass a much smaller N than the gate's 200k default.
//
// Engine-agnostic by the same rule as the gate: it imports only `./signal.js`
// (createRegistry) and the public onGraphMutation hook. Point `signal.js` at 1.5,
// the 1.6 alpha, or a rejected candidate and compare. No devtools dependency --
// the op-code aggregation here is the same logic burstProfile() uses, inlined so
// the harness stays self-contained.
//
// MIT (c) Zahary Shinikchiev.

import { createRegistry } from "../Signal.js";
import { performance } from "node:perf_hooks";

const DEFAULTS = {
    sources: 256, width: 512, layers: 32, fanIn: 8, burst: 16,
    kind: "callable",          // "callable" (user path, clean propagation) | "box" (leaderboard creation path)
    leaves: 0,                 // 0 => one sink effect per last-layer node (= width)
    trials: 9, burstsPerTrial: 100, warmupBursts: 500,
};

function parseParams(argv) {
    const p = { ...DEFAULTS };
    for (const arg of argv) {
        const m = /^--([a-zA-Z]+)=(.+)$/.exec(arg);
        if (m === null) continue;
        const key = m[1], val = m[2];
        if (key === "kind") p.kind = (val === "box" ? "box" : "callable");
        else if (Object.prototype.hasOwnProperty.call(p, key)) p[key] = val | 0;
    }
    return p;
}

function resolveLeaves(p) { return p.leaves > 0 ? p.leaves : p.width; }

// Pool capacities sized to the shape so the BUILD is fully pooled (no growth).
// Build-time allocation is fine for the zero-GC claim -- the gate measures only
// the hot() window, which does writes, not node creation -- but sizing the pool
// keeps setup fast and poolGrowths honestly 0.
function capacities(p) {
    const leaves = resolveLeaves(p);
    const nodes = p.sources + p.width * p.layers + leaves + 16;
    const links = p.width * p.fanIn                    // layer 1 <- sources
        + (p.layers - 1) * p.width * p.fanIn           // layers 2..L <- previous layer
        + leaves * p.fanIn                             // leaves <- last layer
        + 16;
    return {
        maxNodes: Math.ceil(nodes * 1.1),
        maxLinks: Math.ceil(links * 1.1),
        prealloc: "eager",
        onCapacityExceeded: "grow",
    };
}

// Compute-body factories: one read shape per kind, chosen at BUILD time so the
// hot path carries no kind branch. The deps array is captured once (build-time
// allocation, retained as graph state) and looped -- the realistic wide-DAG
// pattern. Distinct deps per node make the call site megamorphic, which is part
// of what the shape stresses; that is intentional, not a flaw to optimize away.
function makeCallableBody(deps) {
    return () => { let s = 0; for (let k = 0; k < deps.length; k++) s += deps[k](); return s; };
}
function makeBoxBody(deps) {
    return () => { let s = 0; for (let k = 0; k < deps.length; k++) s += deps[k].get(); return s; };
}

function sinkSum(sinks) { let s = 0; for (let i = 0; i < sinks.length; i++) s += sinks[i]; return s; }

/**
 * Build the layered DAG and return its source array, the sink buffer, and a
 * zero-alloc `fire(i)` that drives one burst (a batch of `burst` source writes,
 * window rotating with i). `fire` is kind-agnostic (both primitives expose .set);
 * only the read shape inside compute bodies differs by kind.
 */
function buildBurstDag(p, r) {
    const callable = p.kind === "callable";
    const leaves = resolveLeaves(p);

    const sources = new Array(p.sources);
    for (let i = 0; i < p.sources; i++) sources[i] = callable ? r.signal(0) : r.signalBox(0);

    let prev = sources, prevW = p.sources;
    for (let L = 0; L < p.layers; L++) {
        const layer = new Array(p.width);
        for (let j = 0; j < p.width; j++) {
            const deps = new Array(p.fanIn);
            for (let k = 0; k < p.fanIn; k++) deps[k] = prev[(j + k) % prevW];
            const body = callable ? makeCallableBody(deps) : makeBoxBody(deps);
            layer[j] = callable ? r.computed(body) : r.computedBox(body);
        }
        prev = layer; prevW = p.width;
    }

    const sinks = new Float64Array(leaves);
    const last = prev, lastW = prevW;
    for (let e = 0; e < leaves; e++) {
        const deps = new Array(p.fanIn);
        for (let k = 0; k < p.fanIn; k++) deps[k] = last[(e + k) % lastW];
        const idx = e;
        if (callable) r.effect(() => { let s = 0; for (let k = 0; k < deps.length; k++) s += deps[k](); sinks[idx] = s; });
        else r.effect(() => { let s = 0; for (let k = 0; k < deps.length; k++) s += deps[k].get(); sinks[idx] = s; });
    }

    // Hoisted burst callback (one allocation at build, not per iteration -- the
    // same discipline steadyBatch uses; a fresh arrow per fire would measure the
    // caller's closure, not the engine's flush).
    const S = p.sources, B = p.burst;
    const drv = { i: 0 };
    const cb = () => {
        const i = drv.i, base = (i * B) % S;
        for (let k = 0; k < B; k++) sources[(base + k) % S].set(i);
    };
    const fire = (i) => { drv.i = i; r.batch(cb); };

    return { sources, sinks, fire };
}

/**
 * One instrumented steady-state burst. Warms first (JIT + a settled cone), then
 * attaches the op 5/6/7 hook for exactly ONE burst. Reports the structural
 * answer to the 1.8 question. Counts are deterministic -- the hook never alters
 * control flow -- so this characterizes shape; TIME is measured separately, with
 * the hook detached (attaching allocates Map growth and would perturb timing).
 */
export function profileBurst(params = {}) {
    const p = { ...DEFAULTS, ...params };
    const r = createRegistry(capacities(p));
    const g = buildBurstDag(p, r);
    for (let i = 0; i < 8; i++) g.fire(i);   // warm: settle JIT + evaluate the cone

    let passes = 0;
    const perPass = [];
    const ran = new Map();      // node id -> recomputes this burst (op 5; fires only on real recompute)
    const queued = new Map();   // effect id -> enqueues this burst (op 7)
    const off = r.onGraphMutation((op, a, b) => {
        if (op === 5) { ran.set(a, (ran.get(a) ?? 0) + 1); return; }
        if (op === 7) { queued.set(a, (queued.get(a) ?? 0) + 1); return; }
        if (op === 6) { passes++; perPass.push(b | 0); }
    });
    g.fire(1000);               // the one measured burst
    off();

    let maxRan = 0, ranOnce = 0, ranMulti = 0;
    for (const c of ran.values()) { if (c > maxRan) maxRan = c; if (c === 1) ranOnce++; else if (c > 1) ranMulti++; }
    let enqueuesTotal = 0, shortCircuited = 0;
    for (const [id, q] of queued) { enqueuesTotal += q; if (q > (ran.get(id) ?? 0)) shortCircuited++; }

    return {
        params: { ...p, leaves: resolveLeaves(p) },
        passes,
        perPass,
        effectsRunThisBurst: perPass.reduce((a, b) => a + b, 0),
        computedsRecomputed: ran.size,
        maxRecomputePerNode: maxRan,
        recomputedOnce: ranOnce,
        recomputedMulti: ranMulti,
        effectsEnqueued: queued.size,
        enqueuesTotal,
        shortCircuitedEffects: shortCircuited,
        flushPassesStat: r.stats().flushPasses,   // cross-check: == passes (hook was attached only for the one burst)
    };
}

/**
 * Median-of-N wall-clock for the burst loop, profiler DETACHED. The comparable
 * number: run the reference engines (alien, preact) through an identically
 * parameterized shape in their own cold processes and compare per-burst us.
 */
export function timeBurst(params = {}) {
    const p = { ...DEFAULTS, ...params };
    const r = createRegistry(capacities(p));
    const g = buildBurstDag(p, r);
    for (let i = 0; i < p.warmupBursts; i++) g.fire(i);

    let sink = 0;
    const times = new Array(p.trials);
    for (let t = 0; t < p.trials; t++) {
        const t0 = performance.now();
        for (let i = 0; i < p.burstsPerTrial; i++) g.fire(i);
        const t1 = performance.now();
        times[t] = t1 - t0;
        sink += sinkSum(g.sinks);   // anti-DCE: force the effect writes to be observed
    }
    times.sort((a, b) => a - b);
    const medianMs = times[times.length >> 1];
    return {
        params: { ...p, leaves: resolveLeaves(p) },
        medianMs,
        perBurstUs: (medianMs / p.burstsPerTrial) * 1000,
        trialsMs: times.slice(),
        _sink: sink,
    };
}

/**
 * Controlled multi-pass shape -- NOT the burst DAG. A two-effect write-back that
 * forces a second flush pass, so you can validate that op 6/7 + the short-circuit
 * detector behave on an engine where passes > 1 actually occurs (the pure DAG
 * never write-backs, so it is single-pass by construction). Expect passes=2,
 * perPass=[2,1] on a correct engine.
 */
export function multiPassProbe() {
    const r = createRegistry({ maxNodes: 64, maxLinks: 256, prealloc: "eager", onCapacityExceeded: "grow" });
    const x = r.signal(0), y = r.signal(0);
    r.effect(() => { x(); y(); });                     // re-fires when y changes
    r.effect(() => { if (x() > 0) y.set(y() + 1); });  // writes y on x>0 -> forces pass 2
    r.batch(() => { x.set(0); });                      // warm without tripping the x>0 branch

    let passes = 0; const perPass = []; const ran = new Map(); const queued = new Map();
    const off = r.onGraphMutation((op, a, b) => {
        if (op === 5) ran.set(a, (ran.get(a) ?? 0) + 1);
        else if (op === 7) queued.set(a, (queued.get(a) ?? 0) + 1);
        else if (op === 6) { passes++; perPass.push(b | 0); }
    });
    x.set(1);
    off();
    return { passes, perPass, ran: [...ran.entries()], queued: [...queued.entries()] };
}

/**
 * zgc-scenarios.mjs entry. Add to steadyScenarios (or run on its own) to prove
 * the burst shape allocates nothing in steady state. WARNING: one hot() iter is
 * a full burst (burst writes x layers x width of propagation) -- pass N in the
 * low thousands, not the gate's 200_000 default. The scaling check still holds:
 * ~0 scavenges at N and k*N, poolGrowthDelta 0, allocDelta 0.
 */
export function burstDagScenario(overrides = {}) {
    const p = { ...DEFAULTS, ...overrides };
    let R = null, G = null;
    return {
        name: `burst layered DAG (${p.sources}->${p.width}x${p.layers}, fanIn ${p.fanIn}, burst ${p.burst}, ${p.kind})`,
        setup() { R = createRegistry(capacities(p)); G = buildBurstDag(p, R); return { r: R, fire: G.fire }; },
        statsOf: (s) => s.r.stats(),
        hot(s, n) { const fire = s.fire; for (let i = 0; i < n; i++) fire(i); },
        teardown() { if (R !== null) R.destroy(); R = null; G = null; },
    };
}

// ---- standalone CLI ----------------------------------------------------------
function isMain() {
    try { return import.meta.url === `file://${process.argv[1]}`; } catch (_) { return false; }
}

if (isMain()) {
    const p = parseParams(process.argv.slice(2));
    const leaves = resolveLeaves(p);
    const nodes = p.sources + p.width * p.layers + leaves;
    const links = p.width * p.fanIn + (p.layers - 1) * p.width * p.fanIn + leaves * p.fanIn;

    console.log("burst-DAG  sources=%d  %dw x %dL  fanIn=%d  burst=%d  kind=%s  leaves=%d",
        p.sources, p.width, p.layers, p.fanIn, p.burst, p.kind, leaves);
    console.log("graph      ~%d nodes  ~%d edges\n", nodes, links);

    const prof = profileBurst(p);
    console.log("-- structure (1 steady-state burst, profiler attached) --");
    console.log("  flush passes / burst   : %d", prof.passes);
    console.log("  effects run this burst : %d   (enqueued %d, short-circuited %d)",
        prof.effectsRunThisBurst, prof.enqueuesTotal, prof.shortCircuitedEffects);
    console.log("  computeds recomputed   : %d   (max per node: %d)", prof.computedsRecomputed, prof.maxRecomputePerNode);
    console.log("  stats().flushPasses    : %d   (cross-check, == passes)\n", prof.flushPassesStat);

    const tim = timeBurst(p);
    console.log("-- timing (profiler DETACHED, median-of-%d, %d bursts/trial) --", p.trials, p.burstsPerTrial);
    console.log("  median %s ms / %d bursts   =>   %s us per burst\n",
        tim.medianMs.toFixed(2), p.burstsPerTrial, tim.perBurstUs.toFixed(2));

    // Redundancy = the SAME work done more than once: multiple flush passes
    // re-marking a settled cone, or a node recomputing more than once in a burst.
    // shortCircuitedEffects is NOT redundancy -- it counts effects the mark phase
    // enqueued but the clean-read short-circuit then SKIPPED at flush (input value
    // unchanged). That is work AVOIDED, the lazy-pull engine doing less, not more;
    // it is reported below as a diagnostic, never as evidence of waste.
    const noRedundant = prof.passes <= 1 && prof.maxRecomputePerNode <= 1;
    if (noRedundant) {
        console.log("VERDICT: single pass, one recompute per node (%d effects enqueued-but-skipped,",
            prof.shortCircuitedEffects);
        console.log("         i.e. work AVOIDED by the clean-read short-circuit, not waste).");
        console.log("         The gap vs alien is LOCALITY at scale, not algorithmic waste --");
        console.log("         consistent with ledger #11. A markDownstream coalesce guard has");
        console.log("         nothing to coalesce; the remaining lever is data locality, which");
        console.log("         #10 (field relocation) and #12 (edge-arena SoA) both measured as");
        console.log("         propagation-deopting. => 1.8-as-flush-fix is likely a measured");
        console.log("         ceiling. Spend the effort where the roadmap S4 already points.");
    } else {
        console.log("VERDICT: redundant work present (passes=%d, maxRecompute/node=%d).",
            prof.passes, prof.maxRecomputePerNode);
        console.log("         Multiple flush passes or multi-recompute nodes mean a coalesce /");
        console.log("         re-queue-dedupe / empty-pass-short-circuit fix has a real target --");
        console.log("         use burstProfile().redundant() to find the nodes that ran >1x.");
        console.log("         (shortCircuited=%d is work AVOIDED, not part of this verdict.)",
            prof.shortCircuitedEffects);
    }
}
