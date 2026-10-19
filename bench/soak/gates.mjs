/**
 * @zakkster/lite-signal soak -- the GATES (SPEC-B v2 section 8; S1c TASK 3 with amendments 6 and 9).
 * PURE MODULE: no I/O, no process state, no clock. main.mjs streams cycle records into one LaneGates per
 * lane; SoakReport re-derives the same verdict from a JSONL stream with the same code.
 *
 * Gates are DATA (amendment 9 / SPEC-B addendum 9b). GATES = [{id, kind, check, pass, mustFail, teeth}]:
 *   id        the gate name (GATE_NAMES is derived from GATES, never a second list)
 *   kind      'fail' (a red gate is a FAIL, exit 1), 'evidence' (a red gate is INCONCLUSIVE, exit 3: the
 *             run lacks the evidence to judge, and no evidence never PASSes), 'startup' (a self-check
 *             main runs before any record; red -> exit 2) or 'wrap' (the S2 wrap job's gate, WRAP_GATE from
 *             wraprules.mjs: judged by wrap.mjs over its wrap records, never per burn-in lane)
 *   check     the pure rule: check(input) -> { verdict, ... }
 *   pass      inputs the rule must PASS (the green control, so a rule that always fails is caught too)
 *   mustFail  inputs the rule must NOT pass, each with its expected verdict. A gate and its must-fail
 *             control land in the same edit; test/42 runs both, and B7's teeth meta-test imports this list
 *   teeth     the end-to-end battery control (SPEC-B section 9) that trips the gate through main.mjs, or
 *             null when only the unit control exists yet (B7 then needs a GAPS entry or a control)
 *
 * Drift is judged PER LANE across cycles (the early/late split once compared different lanes,
 * 2026-09-26). Run totals live in Float64Array slots (Totals): a closure or field counter past 2^30
 * boxes on pointer-compressed V8 (SPEC-B addendum 7), and a `|0` accumulator wraps at 2^31.
 *
 * Boundaries (B3 contract): EVERY cycle, warm-up included, must carry a MEASURED boundary (main runs
 * closeBoundary after every lane-cycle). An unmeasured boundary anywhere FAILs retention (null is not
 * zero); only a BAD warm-up boundary is ignored, because retention counts bad post-warm-up boundaries.
 *
 * COLD module.
 */

import {
    GATE_N, WARMUP_CYCLES, HEAP_RATIO, HEAP_SLACK_MB, RETAIN_MAX, RETAIN_BAD_BOUNDARIES,
    SCEN_MIN, SCEN_MIN_SMOKE, CHECK_FLOOR, CHECK_FLOOR_SMOKE, TAINT_SKIP_MAX, VERDICT, EXIT_CODE,
} from './config.mjs';
import { CHECK_NAMES, SKIP_NAMES } from './exec.mjs';
import { WRAP_GATE } from './wraprules.mjs';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A malformed gate input (a harness bug or a tampered stream). main: fatal; SoakReport: INTEGRITY.
 * Module-wide split: malformed DATA (a cycle record, a rule input list, a lane result) -> GateInputError;
 * API misuse by the calling code (wrong constructor options, an unknown oracle or cause id, a non-array
 * where an array parameter is required, verdict() field types) -> TypeError / RangeError.
 */
export class GateInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GateInputError';
    }
}
function bad(msg) { throw new GateInputError(msg); }

/* ---- oracle families ------------------------------------------------------------------------------ */

// O1c/O1e are one family (O1), O7a is the S1 slice of O7, OB (batch-early-run, F5) is its own family.
// BREACH dedupe and failureCounts use the family.
const FAMILY = Object.freeze({ O1c: 'O1', O1e: 'O1', O2: 'O2', O4: 'O4', O5: 'O5', O6: 'O6', O7a: 'O7', OB: 'OB' });

/** The reporting family of an oracle id. An unknown id throws (fail closed: never a silent bucket). */
export function oracleFamily(oracle) {
    if (typeof oracle !== 'string' || !own(FAMILY, oracle)) throw new TypeError('oracleFamily: unknown oracle ' + String(oracle));
    return FAMILY[oracle];
}

/* ---- Totals: exact run counters in a Float64Array ------------------------------------------------- */

/**
 * Named exact counters, one Float64Array slot each (exact to 2^53). add() accepts only a safe non-negative
 * integer and throws if the sum would leave the exact range, so a total is never silently wrong.
 * ensure(name) grows the table (cold: failure keys are discovered while the run goes).
 */
export class Totals {
    constructor(names) {
        if (!Array.isArray(names)) throw new TypeError('Totals: names must be an array');
        this.names = [];
        this.ix = new Map();
        this.slot = new Float64Array(Math.max(4, names.length));
        for (const n of names) this.ensure(n);
    }
    ensure(name) {
        if (typeof name !== 'string' || name.length === 0) throw new TypeError('Totals: a slot name must be a non-empty string');
        const hit = this.ix.get(name);
        if (hit !== undefined) return hit;
        const i = this.names.length;
        if (i === this.slot.length) {
            const grown = new Float64Array(this.slot.length * 2);
            grown.set(this.slot);
            this.slot = grown;
        }
        this.names.push(name);
        this.ix.set(name, i);
        return i;
    }
    index(name) {
        const i = this.ix.get(name);
        if (i === undefined) throw new RangeError('Totals: unknown slot ' + String(name));
        return i;
    }
    add(name, n) {
        if (!(Number.isSafeInteger(n) && n >= 0)) throw new RangeError('Totals.add(' + name + '): ' + n + ' is not a safe non-negative integer');
        const i = this.index(name);
        const v = this.slot[i] + n;
        if (!(v <= Number.MAX_SAFE_INTEGER)) throw new RangeError('Totals.add(' + name + '): the total would leave the exact range (2^53)');
        this.slot[i] = v;
    }
    get(name) { return this.slot[this.index(name)]; }
    has(name) { return this.ix.has(name); }
    toJSON() {
        // defineProperty, not out[name] = v: a slot named "__proto__" (an own key of a JSON-parsed failureCounts)
        // would hit the Object.prototype setter and vanish from the report. A plain {} in names order (cold path).
        const out = {};
        for (let i = 0; i < this.names.length; i++) {
            Object.defineProperty(out, this.names[i], { value: this.slot[i], enumerable: true, writable: true, configurable: true });
        }
        return out;
    }
}

/* ---- EarlyLate: per-lane drift accumulator (O(1) memory) ------------------------------------------ */

/** The first N post-warm-up samples plus a ring of the last N (port of lite-pick gates.mjs EarlyLate). */
export class EarlyLate {
    constructor(n) {
        if (!(Number.isInteger(n) && n >= 1)) throw new RangeError('EarlyLate: n must be a positive integer');
        this.n = n;
        this.early = new Float64Array(n);
        this.earlyCount = 0;
        this.lateRing = new Float64Array(n);
        this.total = 0;   // one per lane-cycle: bounded by CYCLES_MAX (2^28), so it stays Smi
    }
    push(v) {
        if (this.earlyCount < this.n) this.early[this.earlyCount++] = v;
        this.lateRing[this.total % this.n] = v;
        this.total++;
    }
    get lateCount() { return this.total < this.n ? this.total : this.n; }
    earlyMedian() { return medianOf(this.early, this.earlyCount); }
    lateMedian() { return medianOf(this.lateRing, this.lateCount); }
}

/** Median of the first `count` values; NaN for an empty window (null is not zero: a NaN fails closed). */
export function medianOf(arr, count) {
    if (count === 0) return NaN;
    const a = Array.prototype.slice.call(arr, 0, count).sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* ---- the rules (pure; each is a GATES `check`) ---------------------------------------------------- */

const P = VERDICT.PASS, F = VERDICT.FAIL, I = VERDICT.INCONCLUSIVE, S = VERDICT.SMOKE;
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

/**
 * oracle (kind fail): any failing world, or any failure count, in the lane's run. Known divergences still
 * FAIL (they are tagged, not forgiven). `!(failingWorlds === 0)` fails closed on a missing count.
 */
export function oracleRule(input) {
    const fc = input.failureCounts;
    let failures = 0;
    let malformed = fc === null || typeof fc !== 'object';
    if (!malformed) for (const k of Object.keys(fc)) { if (!(Number.isSafeInteger(fc[k]) && fc[k] > 0)) malformed = true; else failures += fc[k]; }
    const red = malformed || !(input.failingWorlds === 0) || failures !== 0;
    return { verdict: red ? F : P, failingWorlds: input.failingWorlds, failures, detail: red ? 'failingWorlds=' + input.failingWorlds + ' failures=' + failures : '' };
}

/**
 * heap (kind fail): late median residentMB <= early median x HEAP_RATIO + HEAP_SLACK_MB. Active only at
 * post >= 2N post-warm-up cycles; below that a smoke run is SMOKE and any other run INCONCLUSIVE
 * ('post-cycles'). `!(late <= limit)` makes a NaN median a FAIL, never a PASS.
 */
export function heapRule(input) {
    const need = 2 * GATE_N;
    if (input.smoke === true) return { verdict: S, need, post: input.post };
    if (!(input.post >= need)) return { verdict: I, cause: 'post-cycles', need, post: input.post };
    const limit = input.earlyMedian * HEAP_RATIO + HEAP_SLACK_MB;
    const red = !(input.lateMedian <= limit);
    return {
        verdict: red ? F : P, early: r3(input.earlyMedian), late: r3(input.lateMedian), limit: r3(limit), post: input.post,
        detail: red ? 'late=' + r3(input.lateMedian) + 'MB > limit=' + r3(limit) + 'MB (early=' + r3(input.earlyMedian) + 'MB x ' + HEAP_RATIO + ' + ' + HEAP_SLACK_MB + ')' : '',
    };
}

/** One boundary's retention state: 'ok', 'bad' (something outlived its world) or 'unmeasured'. */
export function boundaryState(b) {
    if (b === null || typeof b !== 'object') return 'unmeasured';
    if (!(Number.isSafeInteger(b.trackerSize) && b.trackerSize >= 0)) return 'unmeasured';
    if (!(Number.isSafeInteger(b.weakAlive) && b.weakAlive >= 0)) return 'unmeasured';
    return b.trackerSize <= RETAIN_MAX && b.weakAlive <= RETAIN_MAX ? 'ok' : 'bad';
}

/**
 * retention (kind fail): tracker.size() > RETAIN_MAX or weakAlive > RETAIN_MAX after the drain at >=
 * RETAIN_BAD_BOUNDARIES post-warm-up boundaries. tracker.size() is the authority (TASK 0g: it decrements on
 * finalization), the WeakRef count the second witness. An unmeasured boundary on ANY cycle, warm-up
 * included, FAILs at once (null is not 0); only a BAD warm-up boundary is ignored. Hard in smoke too.
 */
export function retentionRule(input) {
    const red = !(input.unmeasured === 0) || !(input.bad < RETAIN_BAD_BOUNDARIES);
    return {
        verdict: red ? F : P, badBoundaries: input.bad, unmeasured: input.unmeasured,
        detail: red ? 'badBoundaries=' + input.bad + ' (limit ' + RETAIN_BAD_BOUNDARIES + ') unmeasured=' + input.unmeasured : '',
    };
}

/**
 * coverage (kind evidence): every applicable required scenario of the lane reached SCEN_MIN hits over the
 * whole run (SCEN_MIN_SMOKE in smoke; warm-up counts). A scenario below it -> INCONCLUSIVE ('scenario').
 */
export function coverageRule(input) {
    const min = input.smoke === true ? SCEN_MIN_SMOKE : SCEN_MIN;
    if (!Array.isArray(input.required)) bad('coverageRule: required must be an array');
    const counts = input.counts || {};
    const missing = [];
    for (const s of input.required) {
        const n = own(counts, s) ? counts[s] : 0;
        if (!(n >= min)) missing.push({ scenario: s, count: n });
    }
    return { verdict: missing.length === 0 ? P : I, min, missing };
}

/**
 * check-floor (kind evidence; amendment 6): the lane PERFORMED at least CHECK_FLOOR checks (smoke:
 * CHECK_FLOOR_SMOKE) of every applicable hard oracle. Taint skips are never counted as checks. An empty
 * oracle list is no evidence at all -> INCONCLUSIVE.
 */
export function checkFloorRule(input) {
    const floor = input.smoke === true ? CHECK_FLOOR_SMOKE : CHECK_FLOOR;
    if (!Array.isArray(input.oracles)) bad('checkFloorRule: oracles must be an array');
    const performed = input.performed || {};
    const below = [];
    for (const o of input.oracles) {
        const n = own(performed, o) ? performed[o] : undefined;
        if (!(n >= floor)) below.push({ oracle: o, performed: n === undefined ? null : n });
    }
    const empty = input.oracles.length === 0;
    return { verdict: below.length === 0 && !empty ? P : I, floor, below, empty };
}

/**
 * taint-skip (kind evidence; amendment 6): for each applicable oracle that skips tainted nodes, the skip
 * ratio skipped / (performed + skipped) stays <= TAINT_SKIP_MAX. 0/0 is NaN and fails closed. A count that
 * is missing or not a safe non-negative integer (null, -1, "50", 1.5, NaN, Infinity) reads as NaN, so the
 * oracle is over and the verdict INCONCLUSIVE (null is not zero; b73 D-T68); it never throws. The
 * threshold is PROVISIONAL until B6 calibrates it (config.mjs).
 */
export function taintSkipRule(input) {
    if (!Array.isArray(input.oracles)) bad('taintSkipRule: oracles must be an array');
    const performed = input.performed || {};
    const skipped = input.skipped || {};
    const over = [];
    const ratios = {};
    for (const o of input.oracles) {
        if (SKIP_NAMES.indexOf(o) === -1) continue;
        const p = own(performed, o) ? performed[o] : NaN;
        const k = own(skipped, o) ? skipped[o] : NaN;
        const pn = Number.isSafeInteger(p) && p >= 0 ? p : NaN;
        const kn = Number.isSafeInteger(k) && k >= 0 ? k : NaN;
        const ratio = kn / (pn + kn);
        ratios[o] = r3(ratio);
        if (!(ratio <= TAINT_SKIP_MAX)) over.push({ oracle: o, performed: p, skipped: k, ratio: r3(ratio) });
    }
    return { verdict: over.length === 0 ? P : I, max: TAINT_SKIP_MAX, ratios, over };
}

/**
 * totals (kind startup): the run-total accumulator is exact past 2^31. 3 x 2^30 must read 3221225472;
 * a `|0` (int32) accumulator reads -1073741824. main runs this before the first record.
 */
export function totalsRule(Ctor) {
    let got;
    try {
        const t = new Ctor(['x']);
        for (let i = 0; i < 3; i++) t.add('x', 2 ** 30);
        got = t.get('x');
    } catch (e) {
        return { verdict: F, got: null, error: String(e && e.message) };
    }
    return { verdict: got === 3221225472 ? P : F, got, want: 3221225472 };
}

// The must-fail control of `totals`: the accumulator S1c must never ship (int32 wrap at 2^31).
class PipeZeroTotals {
    constructor(names) { this.names = names.slice(); this.v = new Float64Array(names.length); }
    add(name, n) { const i = this.names.indexOf(name); this.v[i] = (this.v[i] + n) | 0; }
    get(name) { return this.v[this.names.indexOf(name)]; }
}

/* ---- GATES: every gate with its green and must-fail controls -------------------------------------- */

function deepFreeze(o) {
    if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
}

const HEAP_LIMIT_AT_10 = 10 * HEAP_RATIO + HEAP_SLACK_MB;
const TAINT_K = Math.floor(TAINT_SKIP_MAX * 1000);

export const GATES = Object.freeze([
    Object.freeze({
        id: 'oracle', kind: 'fail', check: oracleRule, teeth: 'L-REV-152',
        pass: deepFreeze([{ failingWorlds: 0, failureCounts: {} }]),
        mustFail: deepFreeze([
            { input: { failingWorlds: 1, failureCounts: { 'O1:computed-mismatch': 1 } }, expect: F, why: 'one failing world' },
            { input: { failingWorlds: 0, failureCounts: { 'O6:escape-computed': 2 } }, expect: F, why: 'a failure count with no failing world is still red' },
            { input: { failureCounts: {} }, expect: F, why: 'a missing failingWorlds is not zero' },
            { input: { failingWorlds: 1, failureCounts: { 'OB:batch-early-run': 1 } }, expect: F, why: 'an effect re-ran inside an open batch (OB, F5)' },
        ]),
    }),
    Object.freeze({
        id: 'heap', kind: 'fail', check: heapRule, teeth: 'L-T-leak',
        pass: deepFreeze([{ smoke: false, post: 2 * GATE_N, earlyMedian: 10, lateMedian: HEAP_LIMIT_AT_10 - 0.1 }]),
        mustFail: deepFreeze([
            { input: { smoke: false, post: 2 * GATE_N, earlyMedian: 10, lateMedian: HEAP_LIMIT_AT_10 + 0.1 }, expect: F, why: 'late above early x ratio + slack' },
            { input: { smoke: false, post: 2 * GATE_N, earlyMedian: 10, lateMedian: NaN }, expect: F, why: 'a NaN median fails closed' },
            { input: { smoke: false, post: 2 * GATE_N - 1, earlyMedian: 10, lateMedian: 10 }, expect: I, why: 'below the 2N active floor' },
        ]),
    }),
    Object.freeze({
        id: 'retention', kind: 'fail', check: retentionRule, teeth: 'L-T-retain',
        pass: deepFreeze([{ bad: RETAIN_BAD_BOUNDARIES - 1, unmeasured: 0 }]),
        mustFail: deepFreeze([
            { input: { bad: RETAIN_BAD_BOUNDARIES, unmeasured: 0 }, expect: F, why: 'retained at RETAIN_BAD_BOUNDARIES boundaries' },
            { input: { bad: 0, unmeasured: 1 }, expect: F, why: 'an unmeasured boundary is not a clean one' },
        ]),
    }),
    Object.freeze({
        id: 'coverage', kind: 'evidence', check: coverageRule, teeth: 'T-cov-BATCH',
        pass: deepFreeze([{ smoke: false, required: ['s'], counts: { s: SCEN_MIN } }, { smoke: true, required: ['s'], counts: { s: SCEN_MIN_SMOKE } }]),
        mustFail: deepFreeze([
            { input: { smoke: false, required: ['s'], counts: { s: SCEN_MIN - 1 } }, expect: I, why: 'below SCEN_MIN' },
            { input: { smoke: false, required: ['s'], counts: {} }, expect: I, why: 'never counted' },
        ]),
    }),
    Object.freeze({
        id: 'check-floor', kind: 'evidence', check: checkFloorRule, teeth: null,
        pass: deepFreeze([{ smoke: false, oracles: ['O1c', 'O5'], performed: { O1c: CHECK_FLOOR, O5: CHECK_FLOOR } },
            { smoke: true, oracles: ['O1c'], performed: { O1c: CHECK_FLOOR_SMOKE } }]),
        mustFail: deepFreeze([
            { input: { smoke: false, oracles: ['O1c', 'O5'], performed: { O1c: CHECK_FLOOR, O5: CHECK_FLOOR - 1 } }, expect: I, why: 'one oracle below the floor' },
            { input: { smoke: true, oracles: ['O1c'], performed: { O1c: CHECK_FLOOR_SMOKE - 1 } }, expect: I, why: 'below the smoke floor' },
            { input: { smoke: false, oracles: ['O7a'], performed: {} }, expect: I, why: 'a missing count is not zero checks passed' },
            { input: { smoke: false, oracles: [], performed: {} }, expect: I, why: 'no applicable oracle is no evidence' },
        ]),
    }),
    Object.freeze({
        id: 'taint-skip', kind: 'evidence', check: taintSkipRule, teeth: null,
        pass: deepFreeze([{ oracles: ['O1e', 'O5'], performed: { O1e: 1000 - TAINT_K, O5: 10 }, skipped: { O1e: TAINT_K } }]),
        mustFail: deepFreeze([
            { input: { oracles: ['O1e'], performed: { O1e: 1000 - TAINT_K - 1 }, skipped: { O1e: TAINT_K + 1 } }, expect: I, why: 'skip ratio above TAINT_SKIP_MAX' },
            { input: { oracles: ['O1c'], performed: { O1c: 0 }, skipped: { O1c: 0 } }, expect: I, why: '0/0 is not a ratio' },
            { input: { oracles: ['O4'], performed: { O4: 10 }, skipped: {} }, expect: I, why: 'a missing skip count is not zero' },
        ]),
    }),
    Object.freeze({
        id: 'totals', kind: 'startup', check: totalsRule, teeth: null,
        pass: Object.freeze([Totals]),
        mustFail: Object.freeze([Object.freeze({ input: PipeZeroTotals, expect: F, why: 'a |0 accumulator wraps at 2^31' })]),
    }),
    // S2 (task 8): the wrap job's gate, data owned by wraprules.mjs (no back-import: see its header)
    WRAP_GATE,
]);

/** Every gate id, derived from GATES (never a second list). */
export const GATE_NAMES = Object.freeze(GATES.map((g) => g.id));

/** Gates evaluated per lane by LaneGates.compute (totals is the startup self-check; wrap is judged by wrap.mjs). */
const LANE_GATES = Object.freeze(GATES.filter((g) => g.kind !== 'startup' && g.kind !== 'wrap').map((g) => g.id));

/**
 * Recorded but NEVER judged (SPEC-B section 8 report-only). None of them can make a run FAIL or
 * INCONCLUSIVE; per-op 0 B/op is owned by test/32-perf-gate (ADR 0014 S1). S2 adds DDSketch and REPR.
 */
export const REPORT_ONLY_GATES = Object.freeze(['throughput', 'shape', 'O3', 'gcMajor', 'gcPause']);

/**
 * Why a run can be INCONCLUSIVE (exit 3), cause id -> the text after `soak: INCONCLUSIVE -- `. The wrap
 * causes (S2, wraprules.mjs wrapRule causes {cause, check, counter, label}): a crossing unwitnessed (W1-W4,
 * label 'Wn') and a W5 B/op unmeasured (label 'W5[<counter>]').
 */
export const INCONCLUSIVE_CAUSES = Object.freeze({
    'interrupted': () => 'run interrupted before its end',
    'no-lane': () => 'no lane ran (all skipped)',
    'post-cycles': (a) => 'lane ' + a.lane + ' ran ' + a.post + ' post-warm-up cycles < ' + a.need,
    'scenario': (a) => 'scenario lane=' + a.lane + ' missing=' + a.scenario,
    'check-floor': (a) => 'checks lane=' + a.lane + ' oracle=' + a.oracle + ' performed=' + a.performed + ' < ' + a.floor,
    'taint-skip': (a) => 'taint-skip lane=' + a.lane + ' oracle=' + a.oracle + ' ratio=' + a.ratio + ' > ' + a.max,
    // guard: a lane whose status is INCONCLUSIVE but that recorded no cause still makes the run INCONCLUSIVE
    'lane-status': (a) => 'lane ' + a.lane + ' status INCONCLUSIVE with no recorded cause',
    'wrap-crossing': (a) => 'wrap ' + a.label + ' crossing unwitnessed',
    'wrap-unmeasured': (a) => 'wrap ' + a.label + ' unmeasured',
});

/** The full protocol line of one INCONCLUSIVE cause. An unknown cause throws. */
export function inconclusiveLine(cause, args) {
    if (!own(INCONCLUSIVE_CAUSES, cause)) throw new TypeError('inconclusiveLine: unknown cause ' + String(cause));
    return 'soak: INCONCLUSIVE -- ' + INCONCLUSIVE_CAUSES[cause](args || {});
}

/* ---- LaneGates: one lane's streaming accumulator -------------------------------------------------- */

function intField(rec, k, where) {
    const v = rec[k];
    if (!(Number.isSafeInteger(v) && v >= 0)) bad(where + ': ' + k + ' must be a safe non-negative integer, got ' + String(v));
    return v;
}
function countMap(obj, keys, where) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) bad(where + ' must be an object');
    for (const k of keys) {
        if (!own(obj, k)) bad(where + '.' + k + ' is missing (null is not zero)');
    }
    for (const k of Object.keys(obj)) {
        if (!(Number.isSafeInteger(obj[k]) && obj[k] >= 0)) bad(where + '.' + k + ' must be a safe non-negative integer, got ' + String(obj[k]));
    }
    return obj;
}

/**
 * Streaming per-lane gate state. main.mjs pushes each cycle record of the lane in cycle order (0, 1, 2 ...)
 * and keeps no record array. A record must carry (SPEC-B section 7 cycle record, S1b counter shape):
 *   lane, cycle, worlds, ops, failingWorlds, failureCounts {"<family>:<sig>": n},
 *   checks {every exec CHECK_NAMES oracle: performed n}, skipTainted {every exec SKIP_NAMES oracle: n},
 *   scenarios {name: n}, memory.residentMB (after the drain), boundary {trackerSize, weakAlive}
 * A malformed record throws GateInputError (fail closed). Warm-up cycles (cycle < WARMUP_CYCLES) count
 * toward every total and do not feed the heap drift. Every cycle, warm-up included, must carry a measured
 * boundary: an unmeasured one FAILs retention; only a BAD warm-up boundary is ignored.
 * A re-entrant push (a record getter that pushes into this lane mid-fold) throws GateInputError; the guard
 * resets in a finally, so the next push folds normally.
 *   opts { lane, oracles: applicable hard oracles, required: applicable required scenarios }
 */
export class LaneGates {
    #busy = false;   // push re-entry guard (no allocation on the success path)

    constructor(opts) {
        if (!opts || typeof opts.lane !== 'string') throw new TypeError('LaneGates: opts.lane must be a lane name');
        if (!Array.isArray(opts.oracles) || !Array.isArray(opts.required)) throw new TypeError('LaneGates: opts.oracles and opts.required must be arrays');
        for (const o of opts.oracles) oracleFamily(o);
        this.lane = opts.lane;
        this.oracles = opts.oracles.slice();
        this.required = opts.required.slice();
        this.cycles = 0;
        this.post = 0;
        this.heap = new EarlyLate(GATE_N);
        this.bad = 0;
        this.unmeasured = 0;
        this.totals = new Totals(['worlds', 'ops', 'failingWorlds']);
        this.checks = new Totals(CHECK_NAMES);
        this.skips = new Totals(SKIP_NAMES);
        this.scen = new Totals(this.required);
        this.failures = new Totals([]);
    }

    push(rec) {
        if (this.#busy) bad('cycle record lane=' + this.lane + ': re-entrant push (a record getter pushed into this lane while a record was folding)');
        this.#busy = true;
        try {
            this.#fold(rec);
        } finally {
            this.#busy = false;
        }
    }

    /** One record's checks and fold (the body of push before the re-entry guard). */
    #fold(rec) {
        const where = 'cycle record lane=' + this.lane + ' cycle=' + (rec && rec.cycle);
        if (rec === null || typeof rec !== 'object') bad(where + ': not an object');
        if (rec.lane !== this.lane) bad(where + ': belongs to lane ' + String(rec.lane));
        if (rec.cycle !== this.cycles) bad(where + ': expected cycle ' + this.cycles + ' (records arrive in cycle order, none missing)');
        const worlds = intField(rec, 'worlds', where);
        const ops = intField(rec, 'ops', where);
        const fw = intField(rec, 'failingWorlds', where);
        const fc = countMap(rec.failureCounts, [], where + '.failureCounts');
        const checks = countMap(rec.checks, CHECK_NAMES, where + '.checks');
        const skips = countMap(rec.skipTainted, SKIP_NAMES, where + '.skipTainted');
        const scen = countMap(rec.scenarios, [], where + '.scenarios');
        const warm = rec.cycle < WARMUP_CYCLES;
        let resident = NaN;
        if (!warm) {
            resident = rec.memory && rec.memory.residentMB;
            if (!(typeof resident === 'number' && Number.isFinite(resident) && resident >= 0)) bad(where + ': memory.residentMB must be a finite MB value');
        }
        // all checks passed: fold (no partial fold on a malformed record)
        this.cycles++;
        this.totals.add('worlds', worlds);
        this.totals.add('ops', ops);
        this.totals.add('failingWorlds', fw);
        for (const k of Object.keys(fc)) {
            this.failures.ensure(k);
            this.failures.add(k, fc[k]);
        }
        for (const o of CHECK_NAMES) this.checks.add(o, checks[o]);
        for (const o of SKIP_NAMES) this.skips.add(o, skips[o]);
        for (const s of this.required) if (own(scen, s)) this.scen.add(s, scen[s]);
        const st = boundaryState(rec.boundary);
        if (st === 'unmeasured') this.unmeasured++;
        if (!warm) {
            this.post++;
            this.heap.push(resident);
            if (st === 'bad') this.bad++;
        }
    }

    /** Judge the lane. opts { smoke }. Returns the summary perLane entry plus causes and breach details. */
    compute(opts) {
        const smoke = opts !== undefined && opts.smoke === true;
        const failureCounts = this.failures.toJSON();
        const performed = this.checks.toJSON();
        const skipped = this.skips.toJSON();
        const gates = {
            'oracle': oracleRule({ failingWorlds: this.totals.get('failingWorlds'), failureCounts }),
            'heap': heapRule({ smoke, post: this.post, earlyMedian: this.heap.earlyMedian(), lateMedian: this.heap.lateMedian() }),
            'retention': retentionRule({ bad: this.bad, unmeasured: this.unmeasured }),
            'coverage': coverageRule({ smoke, required: this.required, counts: this.scen.toJSON() }),
            'check-floor': checkFloorRule({ smoke, oracles: this.oracles, performed }),
            'taint-skip': taintSkipRule({ oracles: this.oracles, performed, skipped }),
        };
        const causes = [];
        const breaches = [];
        let fail = false, inc = false;
        for (const id of LANE_GATES) {
            const g = gates[id];
            if (g.verdict === F) {
                fail = true;
                if (id !== 'oracle') breaches.push({ gate: id, lane: this.lane, detail: g.detail });   // oracle failures carry their own BREACH lines
            } else if (g.verdict === I) inc = true;
        }
        if (gates.heap.verdict === I) causes.push({ cause: 'post-cycles', lane: this.lane, post: this.post, need: gates.heap.need });
        for (const m of gates.coverage.missing) causes.push({ cause: 'scenario', lane: this.lane, scenario: m.scenario });
        for (const b of gates['check-floor'].below) causes.push({ cause: 'check-floor', lane: this.lane, oracle: b.oracle, performed: b.performed, floor: gates['check-floor'].floor });
        if (gates['check-floor'].empty) causes.push({ cause: 'check-floor', lane: this.lane, oracle: 'none', performed: 0, floor: gates['check-floor'].floor });
        for (const o of gates['taint-skip'].over) causes.push({ cause: 'taint-skip', lane: this.lane, oracle: o.oracle, ratio: o.ratio, max: TAINT_SKIP_MAX });
        for (const c of causes) c.line = inconclusiveLine(c.cause, c);
        const h = gates.heap;
        return {
            lane: this.lane,
            status: fail ? F : (inc ? I : P),
            cycles: this.cycles,
            postWarmup: this.post,
            totals: { worlds: this.totals.get('worlds'), ops: this.totals.get('ops'), failingWorlds: this.totals.get('failingWorlds'), checks: performed, skipTainted: skipped },
            failureCounts,
            scenarioMissing: gates.coverage.missing.map((m) => m.scenario),
            drift: { heap: { early: h.early === undefined ? null : h.early, late: h.late === undefined ? null : h.late, limit: h.limit === undefined ? null : h.limit, status: h.verdict } },
            retention: { badBoundaries: this.bad, unmeasured: this.unmeasured },
            gates, causes, breaches,
        };
    }
}

/* ---- verdict -------------------------------------------------------------------------------------- */

export const REASONS = Object.freeze(['end', 'signal', 'fatal']);

/**
 * The run verdict (SPEC-B section 8, first match wins):
 *   config / expose-gc / provenance error            -> exit 2 (no verdict string)
 *   engine 'lite' with any SKIP (a roster bug)       -> exit 2
 *   sawFail (any FAIL gate or BREACH), fatal, or reason 'fatal' -> FAIL 1 (a crash is never PASS/INCONCLUSIVE)
 *   inconclusive causes, an interrupted run (reason != 'end', except a signal on a forever run), or no
 *   lane ran                                          -> INCONCLUSIVE 3
 *   smoke                                             -> SMOKE 0
 *   any SKIP (non-lite)                               -> PARTIAL 0 (never the string PASS)
 *   otherwise                                         -> PASS 0
 * input { configError: string|null, engine, skipped: [], sawFail, fatal, reason, forever, smoke, lanesRun,
 *         inconclusive: [cause objects] }. Returns { verdict, exitCode, why, causes }.
 */
export function verdict(input) {
    if (input === null || typeof input !== 'object') throw new TypeError('verdict: input must be an object');
    const { configError, engine, skipped, sawFail, fatal, reason, forever, smoke, lanesRun, inconclusive } = input;
    if (configError !== undefined && configError !== null) {
        return { verdict: null, exitCode: EXIT_CODE.CONFIG, why: 'config: ' + String(configError), causes: [] };
    }
    if (typeof engine !== 'string' || engine.length === 0) throw new TypeError('verdict: engine must be a name');
    if (!Array.isArray(skipped) || !Array.isArray(inconclusive)) throw new TypeError('verdict: skipped and inconclusive must be arrays');
    for (const [k, v] of [['sawFail', sawFail], ['fatal', fatal], ['forever', forever], ['smoke', smoke]]) {
        if (typeof v !== 'boolean') throw new TypeError('verdict: ' + k + ' must be a boolean, got ' + String(v));
    }
    if (REASONS.indexOf(reason) === -1) throw new TypeError('verdict: reason must be one of ' + REASONS.join('|') + ', got ' + String(reason));
    if (!(Number.isSafeInteger(lanesRun) && lanesRun >= 0)) throw new TypeError('verdict: lanesRun must be a non-negative integer');

    if (engine === 'lite' && skipped.length > 0) {
        return { verdict: null, exitCode: EXIT_CODE.CONFIG, why: 'engine lite must SKIP nothing (roster bug): ' + skipped.map((s) => (s && s.lane) || String(s)).join(','), causes: [] };
    }
    const causes = inconclusive.map((c) => (c.line === undefined ? Object.assign({}, c, { line: inconclusiveLine(c.cause, c) }) : c));
    if (reason !== 'end' && !(reason === 'signal' && forever)) causes.push({ cause: 'interrupted', line: inconclusiveLine('interrupted') });
    if (lanesRun === 0) causes.push({ cause: 'no-lane', line: inconclusiveLine('no-lane') });
    if (sawFail || fatal || reason === 'fatal') {
        return { verdict: F, exitCode: EXIT_CODE.FAIL, why: fatal || reason === 'fatal' ? 'fatal' : 'breach', causes };
    }
    if (causes.length > 0) return { verdict: I, exitCode: EXIT_CODE.INCONCLUSIVE, why: 'inconclusive', causes };
    if (smoke) return { verdict: S, exitCode: EXIT_CODE.SMOKE, why: 'smoke', causes };
    if (skipped.length > 0) return { verdict: VERDICT.PARTIAL, exitCode: EXIT_CODE.PARTIAL, why: 'skipped lanes on engine ' + engine, causes };
    return { verdict: P, exitCode: EXIT_CODE.PASS, why: 'all gates green', causes };
}

/**
 * Judge a run from its computed lanes (LaneGates.compute results). input { configError, engine, lanes,
 * skipped, reason, forever, smoke, fatal, extraFail (a BREACH outside the lane gates) }.
 * Errors: `lanes` not an array is API misuse -> TypeError; a lane entry that is not a compute result or
 * carries an unknown status is malformed DATA -> GateInputError (SoakReport: INTEGRITY).
 */
export function judgeRun(input) {
    const lanes = input.lanes;
    if (!Array.isArray(lanes)) throw new TypeError('judgeRun: lanes must be an array of LaneGates.compute results');
    let sawFail = input.extraFail === true;
    const causes = [];
    const breaches = [];
    for (const L of lanes) {
        if (L === null || typeof L !== 'object' || !Array.isArray(L.causes) || !Array.isArray(L.breaches)) {
            bad('judgeRun: a lane is not a LaneGates.compute result');
        }
        if (L.status !== P && L.status !== F && L.status !== I) bad('judgeRun: lane ' + L.lane + ' has unknown status ' + String(L.status));
        if (L.status === F) sawFail = true;
        for (const c of L.causes) causes.push(c);
        // fail closed: an INCONCLUSIVE lane never passes the run, even when it recorded no cause
        if (L.status === I && L.causes.length === 0) causes.push({ cause: 'lane-status', lane: L.lane });
        for (const b of L.breaches) breaches.push(b);
    }
    const v = verdict({
        configError: input.configError, engine: input.engine, skipped: input.skipped, sawFail, fatal: input.fatal,
        reason: input.reason, forever: input.forever, smoke: input.smoke, lanesRun: lanes.length, inconclusive: causes,
    });
    v.breaches = breaches;
    return v;
}
