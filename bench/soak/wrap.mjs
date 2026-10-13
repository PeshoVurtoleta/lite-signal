/**
 * @zakkster/lite-signal soak -- the WRAP job (SPEC-B v2 sections 5.2, 7, 8; SPEC-S2 group A TASK 5).
 *
 *   node --expose-gc --min-semi-space-size=4 --max-semi-space-size=4 bench/soak/wrap.mjs   (npm run soak:wrap)
 *
 * Drives every 32-bit engine counter across its crossing with REAL operations on the kernel (kernel.mjs K,
 * the SOAK_KERNEL seam; never the adapter, no test hook), then judges each check with wraprules.mjs:
 *
 *   W1 globalVersion  idle effect + idle computed, 2^31 + 1000 writes to an unobserved signal (spinVersion);
 *                     the wraparound band pins FLIPPED: the first post-dormancy write is delivered exactly
 *                     (effect saw 1, c() = 10)
 *   W2 batchEpoch     2^32 - 2 noop top-level batches between two captures (c = 50, effect saw 50)
 *   W3 gen            stale handle, 2^32 - 1 recycles of one slot: the stale set is a no-op (victim stays
 *                     'innocent') and the stale dispose leaves the resident alive; sameSlot false = retired
 *   W4 nodeSeq        2^31 signal() + dispose() with 16 long-lived nodes; nodeId sampled every 2^20
 *                     allocations and for every live node at the end: in [1, 2^31 - 1], unique among the
 *                     nodes of the last window; collisions with the old nodes are expectedCollisions (DIV-D4).
 *                     The crossing is witnessed by the registry itself: stats().totalAllocations read before
 *                     and after the drive (outside every window) must advance by >= the target (W5[nodeSeq] too)
 *   W5 (F16, F19)     each census counter re-driven past its target by its own op on a FRESH registry
 *                     (globalVersion writes, batchEpoch noop batches, gen recycles, nodeSeq create+dispose
 *                     -- the drive that also crosses statTotalAllocations / statTotalDisposals -- and
 *                     evalCount effect body runs), B/op of the 4 step classes {set->effect,
 *                     set->computed->effect, batch(set), create+dispose} measured pre and post on that
 *                     same registry
 *
 * W5 B/op of one class = max(transient, retained), null when either is null (null is not zero):
 *   transient  V8 new-space used-size delta over NS_K ops per window, with a forced GC before every window
 *              and any window in which a GC STARTED discarded (perf_hooks 'gc' entries), minus the empty-step
 *              baseline; steady state = MIN over windows 1..n-1 (window 0 is printed, never floored on). It
 *              sees a TRANSIENT box (the F16 / F19 HeapNumber), which a retained measure cannot. Its teeth: a
 *              one-box-per-op control lane MUST read >= W5_BOP_FAIL on the same side, else the side is
 *              blind and every class on it is null (INCONCLUSIVE). The new-space capacity is re-read per
 *              side; a grown nursery makes the side null.
 *   retained   lite-gc-profiler measureAllocs (W5_ITER / W5_BATCHES / W5_WARMUP, min over batches).
 * The record carries the class whose (pre, post) pair binds the rule (a FAIL first, then an unmeasured
 * class, then the largest post - pre); every class is in pre.classes / post.classes (all 4, bop null on an
 * unmeasured post side), and wraprules.mjs judges the record by its WORST class, not by the binding one.
 *
 * Every check runs on its own registry, tracked by lite-leak and a WeakRef witness; after the check the
 * registry is destroy()ed, dropped and drained (boundary.mjs). A tracker growth at that boundary
 * (trackerDelta > 0; the tracker is run-wide) or weakAlive != 0 is a FAIL of that check (values.boundary;
 * the first W5 boundary also counts the 'W5-warm' registries). The B/op windows hold no performance.now() and no adapter: the steps are
 * hoisted no-argument closures over Int32Array slots, drive totals live in the Float64Array DRIVE slot and
 * spinVersion only ever gets a Smi chunk (<= CHUNK = 2^24). The one harness allocation inside a bracket is
 * the bracket read itself (v8.getHeapSpaceStatistics(), ~1.8 KB per window, constant): it is cancelled by
 * an empty-step baseline taken at EACH lane's own window size k, and a baseline above BASELINE_MAX_BYTES
 * per window makes the side unmeasured with a named cause (side.unmeasured), never a silent reading.
 * Before the first W5 measurement every step class is warmed on WARM_REGISTRIES throwaway registries, so
 * the step call sites are polymorphic from the start and a class reads the same in any SOAK_WRAP order.
 *
 * Stream (jsonl.mjs kind 'wrap'): header (provenance.mjs + header.wrap), one wrap record per selected
 * (check, counter) {check, counter, opsDriven, crossed, pre: {bop, ...}, post: {bop, ...}, values, wallMs,
 * status}, summary {reason, checks, records, breaches, inconclusive, repr, verdict, exitCode}; a crash adds
 * a fatal record. stderr: `soak: BREACH gate=wrap check=<W> counter=<c> [bop=<b>] detail=...`,
 * `soak: INCONCLUSIVE -- wrap <W|W5[c]> crossing unwitnessed | unmeasured`, NOTE, CONFIG (exit 2), CRASH.
 * stdout: HEARTBEAT lines, then `soak: END verdict=<V> exit=<n> records=<k>` LAST.
 * Verdict: reason end -> wrapRule; fatal -> FAIL; signal -> FAIL when a record judges FAIL, else
 * INCONCLUSIVE (wraprules.mjs wrapStreamProblems re-derives exactly this).
 *
 * Config: SOAK_WRAP (check subset), SOAK_REPR (=1: wrap-repr.mjs child, NOTE only), SOAK_KERNEL, SOAK_OUT,
 * SOAK_REQUIRE_PROVENANCE. A burn-in key (SOAK_CYCLES, SOAK_OPS, SOAK_SEED, SOAK_LANES, SOAK_SMOKE / --smoke,
 * SOAK_REPLAY, SOAK_SHRINK, SOAK_MUSTFAIL) would be silently ignored here, so it exits 2.
 *
 * COLD orchestration; the hot bodies are the drive chunks and the W5 steps.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getHeapSpaceStatistics } from 'node:v8';
import { PerformanceObserver } from 'node:perf_hooks';
import { readConfig, configExit, VERDICT, EXIT_CODE, W5_BOP_FAIL, W5_ITER, W5_BATCHES, W5_WARMUP } from './config.mjs';
import { WRAP_TARGETS, W5_CLASSES, w5Rule, crossRule, wrapRule } from './wraprules.mjs';
import { ROSTER, ALL_SCENARIOS, COV_OFF_SUPPORTED } from './lanes/index.mjs';
import { openStream, writeRecord, protocol, stdoutLine, endLine, installFatalHandlers, defaultOutPath } from './jsonl.mjs';
import { spinVersion } from '../torture/helpers/spin.mjs';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const r4 = (x) => Math.round(x * 10000) / 10000;
const r1 = (x) => Math.round(x * 10) / 10;
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- local constants (A-B2: candidates for config.mjs CONSTANTS + gatesBlock) ------------------------ */

export const SEMI_SPACE_MB = 4;
const SEMI_BYTES = SEMI_SPACE_MB * 1048576;
const SEMI_TOL = 65536;            // new_space used + available reads 4 MB - 256 B with the pinned flags
const CHUNK = 1 << 24;             // drive chunk: a Smi, <= 1 << 28 (spinVersion's contract)
const HEARTBEAT_MS = 5000;
const MAX_NODES = 64;              // every check fits a 64-node pool (SOAK.md appendix A)
const NS_K_SET = W5_ITER;          // transient window, set / batch classes: <= 32 B/op x 20000 = 640 KB << 4 MB
const NS_K_CYCLE = 4096;           // transient window, create+dispose (~264 B/op handle mint x 4096 = 1.1 MB)
const NS_WINDOWS = W5_BATCHES;     // windows per lane; steady state = min over windows 1..n-1
const BASELINE_MAX_BYTES = 8192;   // empty-step bytes per window (the bracket read is ~1.8 KB); above -> unmeasured
const WARM_REGISTRIES = 2;         // throwaway registries that warm every W5 step class before the first measure
const W4_LIVE = 16;
const W4_SAMPLE_MASK = 0xFFFFF;    // nodeId sampled every 2^20 allocations
const ID_MAX = 0x7FFFFFFF;
const REPR_TIMEOUT_MS = 600000;
const BURN_IN_KEYS = Object.freeze(['SOAK_CYCLES', 'SOAK_OPS', 'SOAK_SEED', 'SOAK_LANES', 'SOAK_SMOKE', 'SOAK_REPLAY', 'SOAK_SHRINK', 'SOAK_MUSTFAIL']);
const KERNEL_API = Object.freeze(['signal', 'computed', 'effect', 'batch', 'dispose', 'destroy', 'nodeId', 'stats']);

export { W5_CLASSES };   // defined in wraprules.mjs (the judge needs the class list); re-exported here
const NS_K = Object.freeze([NS_K_SET, NS_K_SET, NS_K_SET, NS_K_CYCLE]);

/* ---- semi-space pin (fail closed) ------------------------------------------------------------------ */

function newSpaceStats() {
    const sp = getHeapSpaceStatistics();
    for (let i = 0; i < sp.length; i++) if (sp[i].space_name === 'new_space') return sp[i];
    return null;
}

/** new_space capacity in bytes (used + available), or -1 when V8 reports no new_space. */
function newSpaceCapacity() {
    const ns = newSpaceStats();
    return ns === null ? -1 : ns.space_used_size + ns.space_available_size;
}

/**
 * null when the pinned 4 MB semi-space is in force, else the reason. BOTH flags must be on the command line
 * with value 4 and no other value for either (a later flag wins in V8), AND v8.getHeapSpaceStatistics()
 * must show a 4 MB new space: --min alone starts at 4 MB but grows, --max alone starts at 1 MB.
 */
export function semiSpaceProblem(execArgv, capacity) {
    const seen = { min: [], max: [] };
    for (const a of execArgv) {
        const m = /^--(min|max)[-_]semi[-_]space[-_]size(?:=(.*))?$/.exec(a);
        if (m !== null) seen[m[1]].push(m[2] === undefined ? '' : m[2]);
    }
    for (const k of ['min', 'max']) {
        if (seen[k].length === 0) return '--' + k + '-semi-space-size=' + SEMI_SPACE_MB + ' is not in execArgv';
        for (const v of seen[k]) if (v !== String(SEMI_SPACE_MB)) return '--' + k + '-semi-space-size=' + v + ' is not ' + SEMI_SPACE_MB;
    }
    if (capacity < 0) return 'v8.getHeapSpaceStatistics() reports no new_space';
    if (!(capacity > SEMI_BYTES - SEMI_TOL && capacity <= SEMI_BYTES)) {
        return 'new_space capacity ' + capacity + ' B is not the pinned ' + SEMI_SPACE_MB + ' MB semi-space';
    }
    return null;
}

/* ---- protocol lines --------------------------------------------------------------------------------- */

/** The INCONCLUSIVE line of one wrapRule cause (SPEC-B section 7 text; A-B2 task 8 moves it to gates.mjs). */
export function wrapCauseLine(c) {
    if (c.cause === 'wrap-crossing') return 'soak: INCONCLUSIVE -- wrap ' + c.label + ' crossing unwitnessed';
    if (c.cause === 'wrap-unmeasured') return 'soak: INCONCLUSIVE -- wrap ' + c.label + ' unmeasured';
    throw new TypeError('wrapCauseLine: unknown cause ' + String(c.cause));
}

/**
 * The BREACH line of one wrapRule breach; why is the check's own failure text. A W5 line prints bop= and
 * class= from the breach's WORST class (b.cls / b.post, wraprules.mjs wrapRule), never from the record's
 * binding class; rec is kept for the call shape and not read.
 */
export function breachLine(b, rec, why) {
    const bop = b.check === 'W5' && typeof b.post === 'number' ? ' bop=' + b.post.toFixed(2) : '';
    const cls = b.check === 'W5' && typeof b.cls === 'string' ? 'class=' + b.cls + ' ' : '';
    const detail = why ? why : cls + String(b.detail).replace(/^bop=\S+ /, '');   // the bop is already on the line
    return 'soak: BREACH gate=wrap check=' + b.check + ' counter=' + b.counter + bop + ' detail=' + detail;
}

/* ---- the drive -------------------------------------------------------------------------------------- */

// DRIVE[0] ops done, DRIVE[1] target: drive totals reach 2^32 - 1, so they never live in a closure let.
const DRIVE = new Float64Array(2);
// W4 sample state: [0] bad ids, [1] first bad id, [2] its allocation index, [3] samples
const W4S = new Float64Array(4);
// W5[evalCount]: effect body runs caused by the drive (exact past 2^31)
const EVALS = new Float64Array(1);

/**
 * Run chunkFn(n) with Smi chunks until DRIVE reaches target, yielding one macrotask per chunk (signals and
 * heartbeats land between chunks, never inside one). -> {opsDriven, wallMs, interrupted}.
 */
async function drive(run, label, target, chunkFn) {
    DRIVE[0] = 0;
    DRIVE[1] = target;
    const t0 = performance.now();
    let beat = t0;
    while (DRIVE[0] < DRIVE[1]) {
        if (run.stop !== null) break;
        const rem = DRIVE[1] - DRIVE[0];
        const n = (rem < CHUNK ? rem : CHUNK) | 0;
        chunkFn(n);
        DRIVE[0] += n;
        await tick();
        const now = performance.now();
        if (now - beat >= HEARTBEAT_MS) {
            beat = now;
            stdoutLine('soak: HEARTBEAT check=' + label + ' ops=' + DRIVE[0] + ' of ' + target + ' tS=' + r1((now - run.t0) / 1000));
        }
    }
    const opsDriven = DRIVE[0];
    return { opsDriven, wallMs: r1(performance.now() - t0), interrupted: opsDriven < target };
}

/* ---- W5 measurement ---------------------------------------------------------------------------------- */

// [T0, T1, B/op] per (lane, window); lanes: 0 empty at NS_K_SET, 1 empty at NS_K_CYCLE, 2 box control,
// 3.. the classes. Every class subtracts the empty lane of its OWN k (the bracket read is per window).
const LANES = 3 + W5_CLASSES.length;
const CLASS_LANE0 = 3;
const baseLaneFor = (k) => (k === NS_K_CYCLE ? 1 : 0);
const WIN = new Float64Array(LANES * NS_WINDOWS * 3);
const GC_STARTS = [];   // perf_hooks 'gc' entry start times (pushed by the observer, outside every window)
let gcObserver = null;

function watchGc() {
    if (gcObserver !== null) return;
    gcObserver = new PerformanceObserver((list) => { for (const e of list.getEntries()) GC_STARTS.push(e.startTime); });
    gcObserver.observe({ entryTypes: ['gc'] });
}

function nsUsed() {
    const ns = newSpaceStats();
    return ns === null ? -1 : ns.space_used_size;
}

/** The measured loop: one shared, megamorphic call site, so no step can be inlined into its window. */
function loop(step, k) {
    for (let i = 0; i < k; i++) step();
}

function laneWindows(lane, step, k) {
    const base = lane * NS_WINDOWS * 3;
    for (let w = 0; w < NS_WINDOWS; w++) {
        globalThis.gc();
        const o = base + w * 3;
        WIN[o] = performance.now();
        const before = nsUsed();
        loop(step, k);
        const after = nsUsed();
        WIN[o + 1] = performance.now();
        WIN[o + 2] = before >= 0 && after >= before ? (after - before) / k : NaN;   // NaN: the bracket inverted
    }
}

/** Mark every window in which a GC started as invalid (NaN). Returns the number discarded. */
function discardGcWindows() {
    let n = 0;
    for (let lane = 0; lane < LANES; lane++) {
        for (let w = 0; w < NS_WINDOWS; w++) {
            const o = (lane * NS_WINDOWS + w) * 3;
            if (Number.isNaN(WIN[o + 2])) continue;
            for (let g = 0; g < GC_STARTS.length; g++) {
                if (GC_STARTS[g] >= WIN[o] && GC_STARTS[g] <= WIN[o + 1]) { WIN[o + 2] = NaN; n++; break; }
            }
        }
    }
    return n;
}

function laneMin(lane) {
    let m = null;
    for (let w = 1; w < NS_WINDOWS; w++) {
        const v = WIN[(lane * NS_WINDOWS + w) * 3 + 2];
        if (Number.isNaN(v)) continue;
        if (m === null || v < m) m = v;
    }
    return m;
}
function lane0(lane) {
    const v = WIN[lane * NS_WINDOWS * 3 + 2];
    return Number.isNaN(v) ? null : r4(v);
}

// The control: one 16 B HeapNumber per op (a double stored into PACKED_ELEMENTS). EMPTY is the baseline.
const CTL = new Int32Array(1);
const BOX = ['tagged'];
const emptyStep = () => { CTL[0] = (CTL[0] + 1) & 0x3FFFFFFF; };
const boxStep = () => { CTL[0] = (CTL[0] + 1) & 0x3FFFFFFF; BOX[0] = CTL[0] + 0.5; };

/**
 * One side (pre or post) of a W5 check: retained (measureAllocs) and transient (new-space) B/op of each
 * class. -> {classes: {name: {bop, transient, retained, window0}}, baseline {set, cycle}, control, controlOk,
 *            capacity, pinned, discarded, unmeasured: null | named cause}.
 */
async function measureSide(steps, measureAllocs) {
    const retained = [];
    for (let c = 0; c < steps.length; c++) {
        const res = measureAllocs(steps[c], { iterations: W5_ITER, batches: W5_BATCHES, warmup: W5_WARMUP });
        retained.push(typeof res.bytesPerCall === 'number' && Number.isFinite(res.bytesPerCall) ? res.bytesPerCall : null);
    }
    await sleep(5);
    GC_STARTS.length = 0;
    const capBefore = newSpaceCapacity();
    laneWindows(0, emptyStep, NS_K_SET);
    laneWindows(1, emptyStep, NS_K_CYCLE);
    laneWindows(2, boxStep, NS_K_SET);
    for (let c = 0; c < steps.length; c++) laneWindows(CLASS_LANE0 + c, steps[c], NS_K[c]);
    const capAfter = newSpaceCapacity();
    await tick();
    await sleep(5);   // the window GCs' perf entries land before they are judged
    const discarded = discardGcWindows();
    const base = [laneMin(0), laneMin(1)];
    const boxMin = laneMin(2);
    const control = base[0] === null || boxMin === null ? null : r4(boxMin - base[0]);
    const pinned = capBefore === capAfter && semiSpaceProblem(process.execArgv, capAfter) === null;
    // the side's named cause when it cannot be measured (first one wins; null = measured)
    let unmeasured = null;
    if (!pinned) unmeasured = 'semi-space: new_space capacity ' + capBefore + ' -> ' + capAfter + ' B (not the pinned ' + SEMI_SPACE_MB + ' MB)';
    for (let b = 0; b < 2 && unmeasured === null; b++) {
        const k = b === 0 ? NS_K_SET : NS_K_CYCLE;
        if (base[b] === null) unmeasured = 'baseline: no valid empty-step window at k=' + k + ' (a GC started in every window)';
        else if (!(base[b] * k <= BASELINE_MAX_BYTES)) unmeasured = 'baseline: empty step ' + r4(base[b]) + ' B/op x k=' + k + ' > ' + BASELINE_MAX_BYTES + ' B per window';
    }
    if (unmeasured === null && control === null) unmeasured = 'control: no valid box-control window';
    if (unmeasured === null && !(control >= W5_BOP_FAIL)) unmeasured = 'control: the box lane read ' + control + ' B/op < ' + W5_BOP_FAIL + ' (blind lane)';
    const controlOk = unmeasured === null;
    const classes = {};
    for (let c = 0; c < steps.length; c++) {
        const m = laneMin(CLASS_LANE0 + c);
        const bl = base[baseLaneFor(NS_K[c])];
        if (unmeasured === null && m === null) unmeasured = 'class ' + W5_CLASSES[c] + ': no valid window (a GC started in every window)';
        const transient = !controlOk || m === null ? null : r4(Math.max(0, m - bl));
        const ret = retained[c] === null ? null : r4(Math.max(0, retained[c]));
        if (unmeasured === null && ret === null) unmeasured = 'class ' + W5_CLASSES[c] + ': measureAllocs bytesPerCall null';
        classes[W5_CLASSES[c]] = {
            bop: transient === null || ret === null ? null : Math.max(transient, ret),
            transient, retained: ret, window0: lane0(CLASS_LANE0 + c),
        };
    }
    const baseline = { set: base[0] === null ? null : r4(base[0]), cycle: base[1] === null ? null : r4(base[1]) };
    return { classes, baseline, control, controlOk, capacity: capAfter, pinned, discarded, unmeasured };
}

/**
 * The class whose (pre, post) pair binds w5Rule: the FAIL with the largest post - pre, else the first
 * unmeasured class, else the class with the largest post - pre; ties go to the first in W5_CLASSES order
 * (wraprules.mjs worstClass re-derives the same pick independently). -> {cls, rule}.
 */
export function pickClass(preClasses, postClasses) {
    let fail = null, unmeasured = null, best = null;
    for (const name of W5_CLASSES) {
        const pre = preClasses[name] ? preClasses[name].bop : null;
        const post = postClasses[name] ? postClasses[name].bop : null;
        const rule = w5Rule({ pre, post });
        if (rule.verdict === VERDICT.FAIL) {
            if (fail === null || rule.delta > fail.rule.delta) fail = { cls: name, rule };
        } else if (rule.verdict === VERDICT.INCONCLUSIVE) {
            if (unmeasured === null) unmeasured = { cls: name, rule };
        } else if (best === null || rule.delta > best.rule.delta) best = { cls: name, rule };
    }
    return fail !== null ? fail : unmeasured !== null ? unmeasured : best;
}

/* ---- per-check helpers -------------------------------------------------------------------------------- */

/** The ReactiveNode behind a handle (symbol-keyed, SOAK.md:333), or undefined. Report-only identity probe. */
function nodeOf(h) {
    for (const k of Object.getOwnPropertySymbols(h)) {
        const v = h[k];
        if (v !== null && typeof v === 'object' && 'flags' in v) return v;
    }
    return undefined;
}

/**
 * stats().totalAllocations of a registry (every createNode, pool pop or fresh build), or null when the kernel
 * exposes no stats() or no safe count (null is not zero: the crossing is then unwitnessed). COLD: read only
 * outside every measurement window (stats() builds an object).
 */
function totalAllocations(r) {
    const s = typeof r.stats === 'function' ? r.stats() : null;
    const v = s !== null && typeof s === 'object' ? s.totalAllocations : undefined;
    return Number.isSafeInteger(v) && v >= 0 ? v : null;
}
const allocDelta = (a0, a1) => (a0 === null || a1 === null ? null : a1 - a0);

/** A fresh registry for one check, tracked (lite-leak) and witnessed (WeakRef). */
function openRegistry(run, label) {
    const r = run.K.createRegistry({ maxNodes: MAX_NODES });
    run.tracker.track(r, null, label);
    run.witness.push(new WeakRef(r));
    return r;
}

/** W5 fixture: the four hoisted no-argument steps over one registry (Int32Array slots, no closure lets). */
function w5Steps(r) {
    const S = new Int32Array(4);
    const signal = r.signal, dispose = r.dispose, batch = r.batch;
    const sA = r.signal(0);
    r.effect(() => { S[1] = (S[1] + sA()) & 0x3FFFFFFF; });
    const sB = r.signal(0);
    const cB = r.computed(() => sB() + 1);
    r.effect(() => { S[2] = (S[2] + cB()) & 0x3FFFFFFF; });
    const sC = r.signal(0);
    r.effect(() => { S[3] = (S[3] + sC()) & 0x3FFFFFFF; });
    const batchBody = () => { sC.set(S[0]); };
    return [
        () => { S[0] = (S[0] + 1) & 0xFFFF; sA.set(S[0]); },
        () => { S[0] = (S[0] + 1) & 0xFFFF; sB.set(S[0]); },
        () => { S[0] = (S[0] + 1) & 0xFFFF; batch(batchBody); },
        () => { dispose(signal(0)); },
    ];
}

/** The drive chunk of one W5 counter: the counter's own op (wraprules.mjs WRAP_TARGETS doc). */
function w5Drive(r, counter) {
    const signal = r.signal, dispose = r.dispose, batch = r.batch;
    if (counter === 'globalVersion') {
        const noise = r.signal(0);
        return (n) => spinVersion(noise, n);
    }
    if (counter === 'batchEpoch') {
        const noop = () => {};
        return (n) => { for (let i = 0; i < n; i++) batch(noop); };
    }
    if (counter === 'gen' || counter === 'nodeSeq') {
        return (n) => { for (let i = 0; i < n; i++) dispose(signal(0)); };
    }
    if (counter === 'evalCount') {
        // sE is touched by this drive only; every set flips its value (E[0] ^ 1 starts at 1 against the
        // initial 0), so each set is exactly one body run in any chunking and any pre-measurement history.
        // EVALS[0] counts the body runs the drive caused (the first run, at effect creation, is excluded).
        const E = new Int32Array(2);
        const sE = r.signal(0);
        r.effect(() => { E[1] = (E[1] + sE()) & 0x3FFFFFFF; EVALS[0] += 1; });
        EVALS[0] = 0;
        return (n) => { for (let i = 0; i < n; i++) { E[0] ^= 1; sE.set(E[0]); } };
    }
    throw new TypeError('w5Drive: no drive for counter ' + String(counter));
}

/* ---- the checks (each returns {opsDriven, wallMs, interrupted, values, failures[], pre?, post?}) ------ */

async function checkW1(run, target) {
    const r = openRegistry(run, 'W1');
    const ST = new Int32Array(2);   // [0] effect saw, [1] effect runs
    const a = r.signal(0), b = r.signal(0), noise = r.signal(0);
    r.effect(() => { ST[0] = a(); ST[1] = (ST[1] + 1) & 0x3FFFFFFF; });
    const c = r.computed(() => b() * 10);
    c();
    const d = await drive(run, 'W1', target, (n) => spinVersion(noise, n));
    const failures = [];
    let values = { interrupted: d.interrupted };
    if (!d.interrupted) {
        const runs0 = ST[1];
        a.set(1);
        b.set(1);
        const cv = c();
        const seen = ST[0], ran = ST[1] !== runs0;
        a.set(2);
        b.set(2);
        values = { seen, effectRan: ran, c: cv, recovery: { seen: ST[0], c: c() } };
        if (seen !== 1) failures.push('band-observed: the effect saw ' + seen + ' after ' + target + ' dormant writes (expected 1)');
        if (cv !== 10) failures.push('band-unobserved: c()=' + cv + ' after ' + target + ' dormant writes (expected 10)');
    }
    r.destroy();
    return Object.assign(d, { values, failures });
}

async function checkW2(run, target) {
    const r = openRegistry(run, 'W2');
    const ST = new Int32Array(1);
    const a = r.signal(0);
    const c = r.computed(() => a() * 10);
    r.effect(() => { ST[0] = c(); });
    r.batch(() => a.set(5));
    r.batch(() => a.set(7));   // the last capture: pre-batch value 5
    const noop = () => {};
    const batch = r.batch;
    const d = await drive(run, 'W2', target, (n) => { for (let i = 0; i < n; i++) batch(noop); });
    const failures = [];
    let values = { interrupted: d.interrupted };
    if (!d.interrupted) {
        r.batch(() => a.set(5));   // the epoch has come round to the capture's again
        const cv = c(), seen = ST[0];
        values = { a: a(), c: cv, seen };
        if (seen !== 50 || cv !== 50) failures.push('batchEpoch cycle: c()=' + cv + ' effect saw ' + seen + ' after ' + target + ' noop batches (expected 50 / 50)');
    }
    r.destroy();
    return Object.assign(d, { values, failures });
}

async function checkW3(run, target) {
    const r = openRegistry(run, 'W3');
    const signal = r.signal, dispose = r.dispose;
    const stale = r.signal('old');
    const slot = nodeOf(stale);
    r.dispose(stale);
    const d = await drive(run, 'W3', target, (n) => { for (let i = 0; i < n; i++) dispose(signal(0)); });
    const failures = [];
    let values = { interrupted: d.interrupted };
    if (!d.interrupted) {
        const victim = r.signal('innocent');
        const vNode = nodeOf(victim);
        const sameSlot = slot === undefined || vNode === undefined ? null : vNode === slot;
        let setThrew = null, disposeThrew = null;
        try { stale.set('WRITTEN-THROUGH-STALE-HANDLE'); } catch (e) { setThrew = String(e && e.message ? e.message : e).slice(0, 120); }
        const v1 = victim();
        try { r.dispose(stale); } catch (e) { disposeThrew = String(e && e.message ? e.message : e).slice(0, 120); }
        const alive = r.nodeId(victim) !== undefined;
        values = { sameSlot, retired: sameSlot === false, victim: String(v1).slice(0, 40), victimAlive: alive, staleSetThrew: setThrew, staleDisposeThrew: disposeThrew };
        if (v1 !== 'innocent') failures.push('stale set wrote through after ' + target + ' recycles: victim()=' + String(v1).slice(0, 40));
        if (!alive) failures.push('stale dispose after ' + target + ' recycles killed the resident');
    }
    r.destroy();
    return Object.assign(d, { values, failures });
}

async function checkW4(run, target) {
    const r = openRegistry(run, 'W4');
    const signal = r.signal, dispose = r.dispose, nodeId = r.nodeId;
    const old = [];
    for (let i = 0; i < W4_LIVE; i++) old.push(r.signal(i));
    W4S[0] = 0; W4S[1] = 0; W4S[2] = -1; W4S[3] = 0;
    const alloc0 = totalAllocations(r);   // outside the drive: the crossing's own witness
    const chunk = (n) => {
        for (let i = 0; i < n; i++) {
            const s = signal(0);
            if ((i & W4_SAMPLE_MASK) === W4_SAMPLE_MASK) {
                const id = nodeId(s);
                W4S[3] += 1;
                if (!(id >= 1 && id <= ID_MAX)) {
                    if (W4S[0] === 0) { W4S[1] = id; W4S[2] = DRIVE[0] + i; }
                    W4S[0] += 1;
                }
            }
            dispose(s);
        }
    };
    const d = await drive(run, 'W4', target, chunk);
    const witness = allocDelta(alloc0, totalAllocations(r));
    const failures = [];
    let values = { interrupted: d.interrupted, samples: W4S[3], badSamples: W4S[0] };
    if (!d.interrupted) {
        const fresh = [];
        for (let i = 0; i < W4_LIVE; i++) fresh.push(r.signal(i));
        const oldIds = old.map((h) => r.nodeId(h));
        const newIds = fresh.map((h) => r.nodeId(h));
        const bad = (id) => !(typeof id === 'number' && id >= 1 && id <= ID_MAX);
        const liveBad = oldIds.filter(bad).length + newIds.filter(bad).length;
        const unique = new Set(newIds).size === newIds.length;
        let expectedCollisions = 0;
        for (const id of newIds) if (oldIds.indexOf(id) !== -1) expectedCollisions++;
        values = {
            samples: W4S[3], badSamples: W4S[0], firstBadId: W4S[0] > 0 ? W4S[1] : null, firstBadAt: W4S[0] > 0 ? W4S[2] : null,
            liveBad, newUnique: unique, expectedCollisions,
            newIdRange: [Math.min.apply(null, newIds), Math.max.apply(null, newIds)],
        };
        if (W4S[0] > 0) failures.push('nodeId out of [1, 2^31-1]: ' + W4S[0] + ' of ' + W4S[3] + ' samples, first id ' + W4S[1] + ' at allocation ' + W4S[2]);
        if (liveBad > 0) failures.push(liveBad + ' live node id(s) out of [1, 2^31-1] after ' + target + ' allocations');
        if (!unique) failures.push('duplicate nodeId among the ' + W4_LIVE + ' nodes of the last window');
    }
    values.allocDelta = witness;
    r.destroy();
    return Object.assign(d, { values, failures, witness });
}

async function checkW5(run, counter, target) {
    const r = openRegistry(run, 'W5[' + counter + ']');
    const steps = w5Steps(r);
    const chunk = w5Drive(r, counter);
    const pre = await measureSide(steps, run.measureAllocs);
    const alloc0 = counter === 'nodeSeq' ? totalAllocations(r) : null;   // between the windows, never inside one
    const d = await drive(run, 'W5[' + counter + ']', target, chunk);
    const values = { interrupted: d.interrupted };
    let witness;
    if (counter === 'evalCount') { witness = EVALS[0]; values.bodyRuns = witness; }   // read before the post side
    if (counter === 'nodeSeq') { witness = allocDelta(alloc0, totalAllocations(r)); values.allocDelta = witness; }
    const post = d.interrupted ? null : await measureSide(steps, run.measureAllocs);
    r.destroy();
    return Object.assign(d, { values, failures: [], pre, post, witness });
}

/**
 * Warm every W5 step class on WARM_REGISTRIES throwaway registries through the real measurement path, so
 * the step and kernel call sites are already polymorphic when the first W5 check measures: otherwise the
 * first registry's create+dispose handle mint is optimised away (0.30 B/op) and every later one reads ~264.
 * The throwaway registries are destroyed AND tracked (lite-leak + WeakRef, label 'W5-warm') into the run's
 * witness, so the first W5 check's boundary counts them: a kept-alive warm registry fails that check's
 * retention (trackerSize / weakAlive != 0).
 */
async function warmW5(run) {
    for (let i = 0; i < WARM_REGISTRIES; i++) {
        const r = openRegistry(run, 'W5-warm');
        await measureSide(w5Steps(r), run.measureAllocs);
        r.destroy();
    }
}

/** One wrap record body from a check result + its boundary. Status is never greener than wraprules. */
function buildRecord(check, counter, res, boundary) {
    const target = WRAP_TARGETS[check][counter];
    const failures = res.failures.slice();
    // the tracker is run-wide: a check fails on what ITS boundary added (trackerDelta > 0) or on its own
    // witnessed registries (weakAlive), so one kept registry is blamed once, on the boundary that tracked it
    if (boundary.trackerDelta > 0 || boundary.weakAlive !== 0) {
        failures.push('retention: trackerSize=' + boundary.trackerSize + ' (+' + boundary.trackerDelta + ' at this boundary' +
            (boundary.warm > 0 ? "; this boundary also witnessed " + boundary.warm + " 'W5-warm' registries" : '') + ') weakAlive=' + boundary.weakAlive + ' after destroy + drain');
    }
    // a check with its own witness (W5[evalCount] body runs; W4 / W5[nodeSeq] the stats().totalAllocations
    // delta, null when unread) must reach the target on it too
    const crossed = !res.interrupted && res.opsDriven >= target && (res.witness === undefined || (typeof res.witness === 'number' && res.witness >= target));
    let pre = { bop: null }, post = { bop: null };
    if (check === 'W5') {
        const preC = res.pre.classes;
        const postC = res.post === null ? {} : res.post.classes;
        const pick = pickClass(preC, postC);
        const side = (x) => ({ baseline: x.baseline, control: x.control, controlOk: x.controlOk, pinned: x.pinned, capacity: x.capacity, discarded: x.discarded, unmeasured: x.unmeasured });
        pre = Object.assign({ bop: preC[pick.cls].bop, cls: pick.cls, classes: preC }, side(res.pre));
        const unmeasuredC = {};
        for (const name of W5_CLASSES) unmeasuredC[name] = { bop: null, transient: null, retained: null, window0: null };
        post = res.post === null
            ? { bop: null, cls: pick.cls, classes: unmeasuredC }
            : Object.assign({ bop: postC[pick.cls].bop, cls: pick.cls, classes: postC }, side(res.post));
    }
    const cross = crossRule({ opsDriven: res.opsDriven, target, crossed });
    const bop = check === 'W5' ? w5Rule({ pre: pre.bop, post: post.bop }) : null;
    let status = VERDICT.PASS;
    if (failures.length > 0 || (bop !== null && bop.verdict === VERDICT.FAIL)) status = VERDICT.FAIL;
    else if (cross.verdict === VERDICT.INCONCLUSIVE || (bop !== null && bop.verdict === VERDICT.INCONCLUSIVE)) status = VERDICT.INCONCLUSIVE;
    const values = Object.assign({}, res.values, { boundary, failures });
    return {
        rec: { check, counter, opsDriven: res.opsDriven, crossed, pre, post, values, wallMs: res.wallMs, status },
        why: failures.length > 0 ? failures.join('; ') : null,
    };
}

/* ---- REPR (report-only child) ---------------------------------------------------------------------- */

const REPR_PATH = fileURLToPath(new URL('./wrap-repr.mjs', import.meta.url));

function runRepr() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--allow-natives-syntax', '--expose-gc', REPR_PATH], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (b) => { out += b; });
        child.stderr.on('data', (b) => { err += b; });
        const timer = setTimeout(() => child.kill('SIGKILL'), REPR_TIMEOUT_MS);
        child.on('close', (code, sig) => {
            clearTimeout(timer);
            let result = null;
            try { result = JSON.parse(out.trim().split('\n').pop()); } catch (e) { result = null; }
            // a crash ends with "Node.js vX.Y.Z": keep the first line naming an Error, else the last line
            const lines = err.trim().split('\n');
            const errLine = lines.find((l) => /Error/.test(l));
            resolve({ exit: code, signal: sig, result, stderr: (errLine !== undefined ? errLine : lines[lines.length - 1]).slice(0, 240) || null });
        });
    });
}

/* ---- the run ------------------------------------------------------------------------------------------ */

function kernelVersion(dir) {
    try {
        const p = join(dir, 'package.json');
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).version || null : null;
    } catch (e) {
        return null;
    }
}

async function main() {
    const cfg = readConfig(process.env, { roster: ROSTER, scenarios: ALL_SCENARIOS, covOffSupported: COV_OFF_SUPPORTED, argv: process.argv.slice(2) });
    for (const k of BURN_IN_KEYS) {
        if (cfg.record[k].source !== 'default') configExit((k === 'SOAK_SMOKE' && cfg.record[k].source === 'argv' ? '--smoke' : k) + ' is a burn-in key (main.mjs); the wrap job would ignore it -- unset it (select checks with SOAK_WRAP)');
    }
    const semi = semiSpaceProblem(process.execArgv, newSpaceCapacity());
    if (semi !== null) configExit('the wrap job needs the pinned semi-space: ' + semi + ' (run: npm run soak:wrap)');

    const KM = await import('./kernel.mjs');   // the kernel loads HERE, through the SOAK_KERNEL seam
    if (KM.KERNEL_NEARWRAP !== undefined && KM.KERNEL_NEARWRAP !== null) configExit('the wrap job drives the real kernel; a NEARWRAP kernel is refused');
    const probe = KM.K.createRegistry({ maxNodes: MAX_NODES });
    for (const f of KERNEL_API) if (typeof probe[f] !== 'function') configExit('kernel ' + KM.KERNEL_FILES[0].path + ': createRegistry() lacks ' + f + '()');
    probe.destroy();

    const { buildHeader } = await import('./provenance.mjs');
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    const { measureAllocs } = await import('@zakkster/lite-gc-profiler');
    const { closeBoundary } = await import('./boundary.mjs');

    const header = buildHeader(cfg, {
        kind: 'wrap',
        engine: { name: 'lite', version: kernelVersion(KM.KERNEL_DIR), caps: null, files: KM.KERNEL_FILES.map((f) => ({ path: f.path, sha256: f.sha256 })) },
        laneRoster: [], lanes: [], scenarios: {}, oraclesNA: {}, genRules: [], divergences: null,
    });
    const selected = {};
    for (const c of cfg.wrap) selected[c] = WRAP_TARGETS[c];
    header.wrap = {
        checks: cfg.wrap.slice(), targets: selected, repr: cfg.repr,
        semiSpaceMB: SEMI_SPACE_MB, newSpaceCapacity: newSpaceCapacity(), chunk: CHUNK, maxNodes: MAX_NODES,
        w5: {
            classes: W5_CLASSES.slice(), bopFail: W5_BOP_FAIL, iter: W5_ITER, batches: W5_BATCHES, warmup: W5_WARMUP,
            nsK: { set: NS_K_SET, cycle: NS_K_CYCLE }, nsWindows: NS_WINDOWS, baselineMaxBytes: BASELINE_MAX_BYTES, warmRegistries: WARM_REGISTRIES,
            method: 'bop = max(transient new-space min over windows 1..n-1 minus the empty baseline at the same k, retained measureAllocs); box control >= bopFail',
        },
    };
    const t0 = performance.now();
    const stream = openStream(cfg.out !== null ? cfg.out : defaultOutPath('wrap', header.gitSha), t0, 'wrap');

    const run = { K: KM.K, t0, stop: null, tracker: null, witness: [], measureAllocs, warmed: false, trackerSeen: 0 };
    const ctx = { lane: null, cycle: null, world: null, worldSeed: null };
    const records = [], why = new Map();
    let repr = null;

    const summarize = (reason) => {
        const judged = wrapRule(records, cfg.wrap);
        let verdict;
        if (reason === 'fatal') verdict = VERDICT.FAIL;
        else if (reason === 'signal') verdict = judged.breaches.length > 0 ? VERDICT.FAIL : VERDICT.INCONCLUSIVE;
        else verdict = judged.verdict;
        const breaches = [];
        for (const b of judged.breaches) {
            const key = b.check + '/' + b.counter;
            const rec = records.find((x) => x.check === b.check && x.counter === b.counter);
            const line = breachLine(b, rec, why.get(key));
            protocol(line);
            breaches.push({ gate: 'wrap', check: b.check, counter: b.counter, label: b.label, detail: line.slice(line.indexOf(' detail=') + 8) });
        }
        const inconclusive = judged.causes.map(wrapCauseLine);
        if (reason !== 'end') inconclusive.push('soak: INCONCLUSIVE -- run interrupted before its end');
        for (const line of inconclusive) protocol(line);   // printed on a FAIL too, as main.mjs does
        const exitCode = EXIT_CODE[verdict];
        writeRecord(stream, 'summary', { reason, checks: cfg.wrap.slice(), records: records.length, breaches, inconclusive, repr, verdict, exitCode });
        return { verdict, exitCode };
    };
    const fatal = installFatalHandlers(stream, () => ctx, summarize);
    const onSignal = (sig) => {
        if (run.stop !== null) return;
        run.stop = 'signal';
        protocol('soak: NOTE -- ' + sig + ' received; closing the current check, then the summary');
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
        writeRecord(stream, 'header', header);
        run.tracker = createLeakTracker({ name: 'soak-wrap' });
        watchGc();
        outer:
        for (const check of cfg.wrap) {
            for (const counter of Object.keys(WRAP_TARGETS[check])) {
                if (run.stop !== null) break outer;
                const target = WRAP_TARGETS[check][counter];
                ctx.lane = check === 'W5' ? 'W5[' + counter + ']' : check;
                run.witness = [];
                let warm = 0;
                if (check === 'W5' && run.warmed !== true) { await warmW5(run); run.warmed = true; warm = WARM_REGISTRIES; }
                const res = check === 'W1' ? await checkW1(run, target)
                    : check === 'W2' ? await checkW2(run, target)
                    : check === 'W3' ? await checkW3(run, target)
                    : check === 'W4' ? await checkW4(run, target)
                    : await checkW5(run, counter, target);
                const witness = run.witness;
                run.witness = [];
                // the check's frame (registry, handles, steps) is gone: res holds plain data only
                const closed = await closeBoundary({ tracker: run.tracker, witness, profiler: null });
                const b = closed.boundary;
                // a non-count trackerSize is never a clean delta (null is not zero): NaN > 0 is false, so force it to 1
                const trackerDelta = Number.isSafeInteger(b.trackerSize) ? b.trackerSize - run.trackerSeen : 1;
                if (Number.isSafeInteger(b.trackerSize)) run.trackerSeen = b.trackerSize;
                const boundary = { trackerSize: b.trackerSize, trackerDelta, warm, weakAlive: b.weakAlive, forcedGcTries: b.forcedGcTries, drainMs: b.drainMs, residentMB: closed.memory.residentMB };
                const built = buildRecord(check, counter, res, boundary);
                const body = built.rec;
                records.push(Object.assign({}, body));
                if (built.why !== null) why.set(check + '/' + counter, built.why);
                writeRecord(stream, 'wrap', body);
                if (check === 'W5') {
                    for (const k of ['pre', 'post']) {
                        if (body[k].unmeasured) protocol('soak: NOTE -- wrap W5[' + counter + '] ' + k + ' unmeasured: ' + body[k].unmeasured);
                    }
                }
                stdoutLine('soak: HEARTBEAT check=' + ctx.lane + ' opsDriven=' + body.opsDriven + ' crossed=' + body.crossed + ' wallMs=' + body.wallMs +
                    (check === 'W5' ? ' class=' + body.post.cls + ' pre=' + body.pre.bop + ' post=' + body.post.bop : '') +
                    ' trackerSize=' + boundary.trackerSize + ' weakAlive=' + boundary.weakAlive + ' status=' + body.status + ' tS=' + r1((performance.now() - t0) / 1000));
            }
        }
        ctx.lane = null;
        if (cfg.repr && run.stop === null) {
            ctx.lane = 'REPR';
            repr = await runRepr();
            const x = repr.result;
            protocol('soak: NOTE -- repr ' + (x === null
                ? 'unavailable: exit=' + repr.exit + ' signal=' + repr.signal + ' ' + (repr.stderr || '')
                : 'natives=' + x.natives + ' sameMapPre=' + x.sameMapPre + ' sameMapPost=' + x.sameMapPost +
                  ' propRatio=' + x.propNs.ratio + ' churnRatio=' + x.churnNs.ratio + ' opsDriven=' + x.opsDriven));
            ctx.lane = null;
        }
        if (gcObserver !== null) gcObserver.disconnect();
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        const v = summarize(run.stop !== null ? run.stop : 'end');
        endLine(v.verdict, v.exitCode, stream.seq);
        process.exit(v.exitCode);
    } catch (e) {
        fatal('mainRejection', e);
    }
}

/** Run main() only when this file is the process entry (tests import the helpers above). */
function isEntry() {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntry()) {
    main().catch((e) => {
        protocol('soak: CRASH -- mainRejection before the stream opened: ' + (e && e.stack ? e.stack : String(e)));
        process.exit(1);
    });
}
