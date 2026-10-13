/**
 * @zakkster/lite-signal soak -- the WRAP job's rules (SPEC-B v2 sections 5.2, 7, 8; SPEC-S2 group A TASK 4).
 * PURE MODULE: no I/O, no process state, no clock. wrap.mjs judges its records with these rules, gates.mjs
 * lists WRAP_GATE (task 8), and SoakReport re-derives a wrap stream's verdict with the same code.
 *
 *   W5_BOP_FAIL         the W5 B/op limit (re-exported from config.mjs: one constant, one place)
 *   W5_CLASSES          the 4 W5 step classes, in order (wrap.mjs measures each one pre and post)
 *   WRAP_TARGETS        check -> counter -> the drive count that witnesses the crossing (wrap.mjs drives to it)
 *   w5Rule              {pre, post} B/op -> FAIL iff post >= W5_BOP_FAIL AND post - pre >= W5_BOP_FAIL;
 *                       a missing measurement (null / NaN / not a number) is INCONCLUSIVE, never PASS
 *   crossRule           {opsDriven, target, crossed} -> PASS iff crossed === true AND opsDriven >= target
 *   wrapRule            every wrap record of a run -> { verdict, breaches[], causes[] }
 *   WRAP_GATE           the GATES fixture {id, kind, check, pass, mustFail, teeth} (check = wrapRule)
 *   wrapStreamProblems  a parsed wrap stream (record objects) -> problem strings ([] when consistent)
 *
 * A wrap record (section 7): {check, counter, opsDriven, crossed, pre: {bop}, post: {bop}, values, wallMs,
 * status} plus {type, seq, tMs}. A W5 record's pre / post also carry {cls, classes}: classes maps EVERY name of
 * W5_CLASSES to {bop} (a missing or unknown class is a shape problem, never a PASS), cls is the binding class
 * and bop = classes[cls].bop. `status` is wrap.mjs's own verdict for the check: the W1-W4 value
 * assertions (effect saw 1, c() = 10, stale set is a no-op ...) cannot be re-derived from a record, so a
 * recorded FAIL is taken as a FAIL; the crossing and the W5 B/op ARE re-derived (w5Rule over EVERY class, the
 * worst one decides), and a status that is greener than the re-derivation, or a binding class that is not
 * the worst class, is a stream problem.
 *
 * Causes carry {cause, check, counter}; gates.mjs INCONCLUSIVE_CAUSES (task 8) formats them:
 * 'wrap-crossing' -> `wrap <W> crossing unwitnessed`, 'wrap-unmeasured' -> `wrap W5[<c>] unmeasured`.
 *
 * Malformed input (a harness bug or a tampered stream) throws TypeError. This module does NOT import
 * gates.mjs: task 8 makes gates.mjs import WRAP_GATE from here, and a back-import would be an ESM cycle whose
 * GATES literal reads WRAP_GATE before it is initialised (TDZ) whenever wraprules.mjs is loaded first.
 *
 * COLD module. Crossing targets reach 2^32 - 1: they are plain safe integers here, never int32.
 */

import { W5_BOP_FAIL, WRAP_CHECKS, VERDICT, EXIT_CODE } from './config.mjs';
import { RECORD_TYPES, FATAL_KINDS } from './jsonl.mjs';

export { W5_BOP_FAIL };

/** The W5 step classes, in measurement order (wrap.mjs w5Steps builds them in this order). */
export const W5_CLASSES = Object.freeze(['set->effect', 'set->computed->effect', 'batch(set)', 'create+dispose']);

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const P = VERDICT.PASS, F = VERDICT.FAIL, I = VERDICT.INCONCLUSIVE;
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

function deepFreeze(o) {
    if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
}

/* ---- crossing targets ------------------------------------------------------------------------------ */

const TWO31 = 2147483648;
const TWO32 = 4294967296;

/**
 * The drive count that witnesses each crossing (section 5.2, ASSERTION A2). W5 re-drives every census
 * counter by its own op: globalVersion by writes (W1's drive), batchEpoch by noop batches (W2), gen by
 * recycles of one slot (W3), nodeSeq by signal()+dispose() (W4; the same drive crosses statTotalAllocations
 * and statTotalDisposals, F19, so W5[nodeSeq] carries the create+dispose class) and evalCount by effect body
 * runs. opsDriven counts the driving ops, not the counter's internal value.
 */
export const WRAP_TARGETS = deepFreeze({
    W1: { globalVersion: TWO31 + 1000 },
    W2: { batchEpoch: TWO32 - 2 },
    W3: { gen: TWO32 - 1 },
    W4: { nodeSeq: TWO31 },
    W5: { globalVersion: TWO31 + 1000, batchEpoch: TWO32 - 2, gen: TWO32 - 1, nodeSeq: TWO31, evalCount: TWO31 },
});

/** The (check, counter) pairs a run selecting `checks` must record, in WRAP_CHECKS order. */
function expectedPairs(checks) {
    const out = [];
    for (const c of WRAP_CHECKS) {
        if (checks.indexOf(c) === -1) continue;
        for (const counter of Object.keys(WRAP_TARGETS[c])) out.push({ check: c, counter, target: WRAP_TARGETS[c][counter] });
    }
    return out;
}

function readChecks(checks, where) {
    if (checks === undefined) return WRAP_CHECKS.slice();
    if (!Array.isArray(checks) || checks.length === 0) throw new TypeError(where + ': checks must be a non-empty array of ' + WRAP_CHECKS.join('|'));
    for (const c of checks) if (WRAP_CHECKS.indexOf(c) === -1) throw new TypeError(where + ': unknown check ' + String(c) + ' (expected ' + WRAP_CHECKS.join('|') + ')');
    return checks;
}

/* ---- the rules --------------------------------------------------------------------------------------- */

/**
 * W5 B/op (section 5.2): FAIL iff post >= W5_BOP_FAIL AND post - pre >= W5_BOP_FAIL. A measurement that is
 * null (measureAllocs bytesPerCall === null), NaN or not a number is INCONCLUSIVE ('wrap-unmeasured'):
 * null is not zero, and an unmeasured window never PASSes.
 */
export function w5Rule(input) {
    if (!isObj(input)) throw new TypeError('w5Rule: input must be an object {pre, post}');
    const pre = input.pre, post = input.post;
    const okPre = typeof pre === 'number' && Number.isFinite(pre);
    const okPost = typeof post === 'number' && Number.isFinite(post);
    if (!okPre || !okPost) {
        return { verdict: I, cause: 'wrap-unmeasured', pre: okPre ? pre : null, post: okPost ? post : null, delta: null,
            detail: 'B/op unmeasured (pre=' + String(pre) + ' post=' + String(post) + ')' };
    }
    const delta = post - pre;
    const red = post >= W5_BOP_FAIL && delta >= W5_BOP_FAIL;
    return {
        verdict: red ? F : P, pre: r2(pre), post: r2(post), delta: r2(delta), limit: W5_BOP_FAIL,
        detail: red ? 'bop=' + post.toFixed(2) + ' pre=' + pre.toFixed(2) + ' (post and post-pre >= ' + W5_BOP_FAIL + ')' : '',
    };
}

/**
 * Crossing witness (section 5.2: "a crossing that was not witnessed -> INCONCLUSIVE"). PASS iff crossed is
 * exactly true AND opsDriven is a safe count >= target. Anything else -> INCONCLUSIVE ('wrap-crossing').
 * target is the caller's constant (WRAP_TARGETS): a non-positive or unsafe target is API misuse (TypeError).
 */
export function crossRule(input) {
    if (!isObj(input)) throw new TypeError('crossRule: input must be an object {opsDriven, target, crossed}');
    const t = input.target;
    if (!(Number.isSafeInteger(t) && t >= 1)) throw new TypeError('crossRule: target must be a positive safe integer, got ' + String(t));
    const ops = input.opsDriven;
    const witnessed = input.crossed === true && isCount(ops) && ops >= t;
    if (witnessed) return { verdict: P, crossed: true, opsDriven: ops, target: t, detail: '' };
    return { verdict: I, cause: 'wrap-crossing', crossed: input.crossed === true, opsDriven: isCount(ops) ? ops : null, target: t,
        detail: 'crossing unwitnessed: opsDriven=' + String(ops) + ' target=' + t + ' crossed=' + String(input.crossed) };
}

const RANK = { [P]: 0, [I]: 1, [F]: 2 };

/**
 * w5Rule over EVERY class of a shape-checked W5 record -> the worst result plus its class name (`cls`):
 * FAIL > INCONCLUSIVE > PASS; among FAILs the larger post - pre wins; otherwise the first in W5_CLASSES order.
 * Written independently of wrap.mjs pickClass: the checker never shares the producer's pick.
 */
function worstClass(rec) {
    let worst = null;
    for (const name of W5_CLASSES) {
        const rule = w5Rule({ pre: rec.pre.classes[name].bop, post: rec.post.classes[name].bop });
        if (worst === null || RANK[rule.verdict] > RANK[worst.verdict] ||
            (rule.verdict === F && worst.verdict === F && rule.delta > worst.delta)) {
            worst = Object.assign({ cls: name }, rule);
        }
    }
    return worst;
}

/** The label a cause / breach line uses: 'W1' for W1-W4, 'W5[<counter>]' for W5. */
function label(check, counter) { return check === 'W5' ? 'W5[' + counter + ']' : check; }

/**
 * Judge ONE wrap record against its target -> { verdict, crossing, bop|null }. Precedence: FAIL (a recorded
 * value failure or a W5 B/op breach) > INCONCLUSIVE (crossing unwitnessed, B/op unmeasured) > PASS, the
 * soak's verdict ladder (a FAIL is never softened to INCONCLUSIVE by missing evidence elsewhere). A W5 bop is
 * the WORST class's w5Rule result (worstClass), never the record's own binding class.
 */
function judge(rec, target) {
    const crossing = crossRule({ opsDriven: rec.opsDriven, target, crossed: rec.crossed });
    const bop = rec.check === 'W5' ? worstClass(rec) : null;
    let verdict = P;
    if (rec.status === F || (bop !== null && bop.verdict === F)) verdict = F;
    else if (rec.status === I || crossing.verdict === I || (bop !== null && bop.verdict === I)) verdict = I;
    return { verdict, crossing, bop };
}

const WRAP_KEYS = ['check', 'counter', 'opsDriven', 'crossed', 'pre', 'post', 'values', 'wallMs', 'status'];
const STATUSES = [P, F, I];

/** Shape problems of one wrap record ([] when well-formed). Unknown keys are the stream checker's business. */
function recordShape(rec) {
    const p = [];
    if (!isObj(rec)) return ['not an object'];
    for (const k of WRAP_KEYS) if (!own(rec, k)) p.push('missing ' + k);
    if (p.length !== 0) return p;
    if (!own(WRAP_TARGETS, rec.check)) p.push('unknown check ' + JSON.stringify(rec.check));
    else if (!own(WRAP_TARGETS[rec.check], rec.counter)) p.push('check ' + rec.check + ' has no counter ' + JSON.stringify(rec.counter));
    if (!(rec.opsDriven === null || isCount(rec.opsDriven))) p.push('opsDriven ' + String(rec.opsDriven) + ' is not a count or null');
    if (typeof rec.crossed !== 'boolean') p.push('crossed must be a boolean');
    for (const k of ['pre', 'post']) {
        if (!isObj(rec[k]) || !own(rec[k], 'bop')) p.push(k + ' must be an object {bop}');
        else if (!(rec[k].bop === null || typeof rec[k].bop === 'number')) p.push(k + '.bop must be a number or null');
    }
    if (!isObj(rec.values)) p.push('values must be an object');
    if (!(typeof rec.wallMs === 'number' && rec.wallMs >= 0)) p.push('wallMs ' + String(rec.wallMs) + ' is not a duration');
    if (STATUSES.indexOf(rec.status) === -1) p.push('status ' + JSON.stringify(rec.status) + ' is not ' + STATUSES.join('|'));
    if (rec.check === 'W5' && p.length === 0) w5Shape(rec, p);
    return p;
}

/** W5 pre / post: {cls, classes} with all 4 W5_CLASSES, each {bop: number | null}; one binding cls. */
function w5Shape(rec, p) {
    for (const k of ['pre', 'post']) {
        const side = rec[k];
        if (W5_CLASSES.indexOf(side.cls) === -1) p.push(k + '.cls ' + JSON.stringify(side.cls) + ' is not one of ' + W5_CLASSES.join('|'));
        if (!isObj(side.classes)) { p.push(k + '.classes must be an object of the ' + W5_CLASSES.length + ' W5 classes'); continue; }
        for (const name of W5_CLASSES) {
            const c = side.classes[name];
            if (!own(side.classes, name)) p.push(k + '.classes is missing class ' + name);
            else if (!isObj(c) || !own(c, 'bop') || !(c.bop === null || typeof c.bop === 'number')) p.push(k + '.classes[' + name + '].bop must be a number or null');
        }
        for (const name of Object.keys(side.classes)) if (W5_CLASSES.indexOf(name) === -1) p.push(k + '.classes has an unknown class ' + JSON.stringify(name));
    }
    if (p.length === 0 && rec.pre.cls !== rec.post.cls) p.push('pre.cls ' + rec.pre.cls + ' != post.cls ' + rec.post.cls);
}

/**
 * The wrap gate over every wrap record of a run. `checks` = the SOAK_WRAP selection (default: all of
 * WRAP_CHECKS). Every selected (check, counter) pair must be recorded exactly once; a missing pair is
 * INCONCLUSIVE ('wrap-crossing' for W1-W4, 'wrap-unmeasured' for a W5 counter), never PASS. A record of an
 * unselected check, a duplicate pair or a malformed record throws TypeError. A W5 breach also carries the
 * WORST class (worstClass, never the record's binding class): cls and that class's raw pre / post bop.
 * -> { verdict, breaches: [{check, counter, label, detail, cls?, pre?, post?}], causes: [{cause, check, counter, label}] }
 */
export function wrapRule(records, checks) {
    if (!Array.isArray(records)) throw new TypeError('wrapRule: records must be an array');
    const sel = readChecks(checks, 'wrapRule');
    const want = expectedPairs(sel);
    const seen = new Map();
    for (const rec of records) {
        const shape = recordShape(rec);
        if (shape.length !== 0) throw new TypeError('wrapRule: malformed wrap record: ' + shape.join('; '));
        const key = rec.check + '/' + rec.counter;
        if (sel.indexOf(rec.check) === -1) throw new TypeError('wrapRule: record ' + key + ' belongs to an unselected check');
        if (seen.has(key)) throw new TypeError('wrapRule: duplicate wrap record ' + key);
        seen.set(key, rec);
    }
    const breaches = [], causes = [];
    for (const w of want) {
        const lb = label(w.check, w.counter);
        const rec = seen.get(w.check + '/' + w.counter);
        if (rec === undefined) {
            causes.push({ cause: w.check === 'W5' ? 'wrap-unmeasured' : 'wrap-crossing', check: w.check, counter: w.counter, label: lb });
            continue;
        }
        const j = judge(rec, w.target);
        if (j.verdict === F) {
            const b = { check: w.check, counter: w.counter, label: lb,
                detail: j.bop !== null && j.bop.verdict === F ? j.bop.detail : 'status FAIL recorded by the check' };
            if (j.bop !== null) {
                b.cls = j.bop.cls;
                b.pre = rec.pre.classes[j.bop.cls].bop;
                b.post = rec.post.classes[j.bop.cls].bop;
            }
            breaches.push(b);
        } else if (j.verdict === I) {
            if (j.crossing.verdict === I) causes.push({ cause: 'wrap-crossing', check: w.check, counter: w.counter, label: lb });
            if (j.bop !== null && j.bop.verdict === I) causes.push({ cause: 'wrap-unmeasured', check: w.check, counter: w.counter, label: lb });
            if (j.crossing.verdict !== I && (j.bop === null || j.bop.verdict !== I)) {
                causes.push({ cause: w.check === 'W5' ? 'wrap-unmeasured' : 'wrap-crossing', check: w.check, counter: w.counter, label: lb });
            }
        }
    }
    const verdict = breaches.length !== 0 ? F : causes.length !== 0 ? I : P;
    return { verdict, breaches, causes };
}

/* ---- WRAP_GATE: the GATES fixture (task 8 appends it to gates.mjs GATES) ----------------------------- */

/** One W5 side (fixture only): every class 0 B/op unless `bops` names it; binding class `cls`. */
function w5Side(cls, bops) {
    const classes = {};
    for (const name of W5_CLASSES) classes[name] = { bop: own(bops, name) ? bops[name] : 0 };
    return { bop: classes[cls].bop, cls, classes };
}
/** A W5 {pre, post} patch (fixture only). */
function w5Pair(cls, pre, post) { return { pre: w5Side(cls, pre), post: w5Side(cls, post) }; }

/** A well-formed record that PASSes its pair (fixture only). */
function okRecord(check, counter, over) {
    const r = {
        check, counter, opsDriven: WRAP_TARGETS[check][counter], crossed: true,
        pre: { bop: null }, post: { bop: null }, values: {}, wallMs: 1, status: P,
    };
    if (check === 'W5') Object.assign(r, w5Pair(W5_CLASSES[0], {}, {}));
    if (over) for (const k of Object.keys(over)) r[k] = over[k];
    return r;
}
function okRun(patch) {
    const out = [];
    for (const w of expectedPairs(WRAP_CHECKS)) {
        const key = w.check + '/' + w.counter;
        if (patch && own(patch, key) && patch[key] === null) continue;   // drop the pair
        out.push(okRecord(w.check, w.counter, patch && own(patch, key) ? patch[key] : undefined));
    }
    return out;
}

export const WRAP_GATE = Object.freeze({
    id: 'wrap', kind: 'wrap', check: wrapRule, teeth: 'L-REV-AUDIT-W5',
    pass: deepFreeze([
        okRun(),
        okRun({ 'W5/evalCount': w5Pair('set->effect', { 'set->effect': 1 }, { 'set->effect': 8.9 }) }),   // post >= 8 but post - pre = 7.9 < 8
    ]),
    mustFail: deepFreeze([
        { input: okRun({ 'W5/evalCount': w5Pair('set->effect', { 'set->effect': 0 }, { 'set->effect': 8 }) }), expect: F, why: 'W5 post-crossing B/op at the limit (8 B/op, delta 8)' },
        { input: okRun({ 'W5/evalCount': w5Pair('set->effect', {}, { 'set->effect': null }) }), expect: I, why: 'W5 bytesPerCall null is unmeasured, not 0 B/op' },
        { input: okRun({ 'W5/evalCount': w5Pair('set->effect', { 'create+dispose': 264.57 }, { 'create+dispose': 296.48 }) }), expect: F,
            why: 'the binding class reads 0 -> 0 but create+dispose breaches (the mPick mutant): the worst class decides' },
        { input: okRun({ 'W5/nodeSeq': w5Pair('set->effect', {}, { 'batch(set)': null }) }), expect: I, why: 'an unmeasured non-binding class is INCONCLUSIVE, never PASS' },
        { input: okRun({ 'W1/globalVersion': { opsDriven: TWO31 + 1000 - 1 } }), expect: I, why: 'W1 drove target - 1 ops: crossing unwitnessed' },
        { input: okRun({ 'W3/gen': { crossed: false } }), expect: I, why: 'W3 opsDriven reached but crossed false' },
        { input: okRun({ 'W2/batchEpoch': { status: F } }), expect: F, why: 'a W2 value assertion failed (recorded status FAIL)' },
        { input: okRun({ 'W4/nodeSeq': null }), expect: I, why: 'a selected check left no record' },
        { input: okRun({ 'W1/globalVersion': { status: F }, 'W3/gen': null, 'W4/nodeSeq': null, 'W5/evalCount': null }), expect: F,
            why: 'an interrupted run (pairs missing) that recorded a FAIL is FAIL, not INCONCLUSIVE' },
        { input: okRun({ 'W5/nodeSeq': { opsDriven: null } }), expect: I, why: 'a null opsDriven is not a witnessed crossing' },
    ]),
});

/* ---- wrapStreamProblems: a wrap JSONL stream, re-derived ------------------------------------------- */

const TYPES = RECORD_TYPES.wrap;
const STAMP = ['type', 'seq', 'tMs'];

/**
 * Every consistency problem of a parsed wrap stream (an array of record objects, in file order), as strings;
 * [] when the stream is consistent. Never throws on stream content (a malformed stream is a list of problems).
 * Checks: contiguous seq from 0, non-decreasing tMs, record types of the wrap kind, one header first with
 * kind 'wrap' and no NEARWRAP kernel (header.nearwrap absent or null: the wrap job drives the real kernel),
 * a SOAK_WRAP selection in header.config, one summary last, fatal placement, every wrap record's shape and
 * keys, each record's status no greener than its re-derived crossing / W5 B/op, a W5 binding class equal to
 * worstClass's whenever the worst verdict is not PASS (ties: the first in W5_CLASSES order, on the producer --
 * wrap.mjs pickClass -- and here alike; a milder FAIL bound under a larger FAIL is a problem too), bop =
 * classes[cls].bop on both sides (one problem line per record), and the summary verdict and
 * exitCode equal to the re-derivation (reason 'end': wrapRule; 'fatal': FAIL; 'signal': FAIL if any
 * well-formed selected record judges FAIL, else INCONCLUSIVE -- the burn-in ladder, a FAIL is never softened).
 */
export function wrapStreamProblems(recs) {
    const p = [];
    if (!Array.isArray(recs) || recs.length === 0) return ['the stream has no records'];
    for (let i = 0; i < recs.length; i++) if (!isObj(recs[i])) return ['record ' + i + ' is not an object'];
    for (let i = 0; i < recs.length; i++) if (recs[i].seq !== i) { p.push('seq: record ' + i + ' has seq ' + String(recs[i].seq) + ', expected ' + i); break; }
    let t = 0;
    for (const r of recs) {
        if (TYPES.indexOf(r.type) === -1) p.push('type: seq ' + String(r.seq) + ' type ' + String(r.type) + ' is not a wrap record (' + TYPES.join('|') + ')');
        if (!(typeof r.tMs === 'number' && r.tMs >= t)) p.push('tMs: seq ' + String(r.seq) + ' tMs ' + String(r.tMs) + ' is not a non-decreasing time');
        else t = r.tMs;
    }
    const h = recs[0];
    if (h.type !== 'header') p.push('header: record 0 is ' + String(h.type) + ', not the header');
    for (let i = 1; i < recs.length; i++) if (recs[i].type === 'header') p.push('header: a second header at seq ' + i);
    let checks = null;
    if (h.type === 'header') {
        if (h.kind !== 'wrap') p.push('header: kind ' + JSON.stringify(h.kind) + ' is not wrap');
        if (own(h, 'nearwrap') && h.nearwrap !== null) p.push('header: a wrap stream must not run a NEARWRAP kernel (header.nearwrap is set)');
        const sel = isObj(h.config) && isObj(h.config.SOAK_WRAP) ? h.config.SOAK_WRAP.value : undefined;
        if (sel === undefined) p.push('header: header.config.SOAK_WRAP.value is missing (the check selection is never guessed)');
        else {
            try { checks = readChecks(sel, 'header.config.SOAK_WRAP.value'); } catch (e) { p.push('header: ' + e.message); }
        }
    }
    const sums = recs.filter((r) => r.type === 'summary');
    const fatals = recs.filter((r) => r.type === 'fatal');
    if (sums.length !== 1) p.push('summary: ' + sums.length + ' summary records (exactly one; a lost run is never judged)');
    else if (recs.indexOf(sums[0]) !== recs.length - 1) p.push('summary: ' + (recs.length - 1 - recs.indexOf(sums[0])) + ' record(s) after the summary');
    if (fatals.length > 1) p.push('fatal: ' + fatals.length + ' fatal records');
    for (const f of fatals) if (FATAL_KINDS.indexOf(f.kind) === -1) p.push('fatal: unknown fatal kind ' + String(f.kind));
    const s = sums.length === 1 ? sums[0] : null;
    if (s !== null && fatals.length === 1 && recs.indexOf(fatals[0]) !== recs.indexOf(s) - 1) p.push('fatal: the fatal record is not directly before the summary');
    if (s !== null && fatals.length === 1 && s.reason !== 'fatal') p.push('fatal: a fatal record but summary reason ' + String(s.reason));
    if (s !== null && fatals.length === 0 && s.reason === 'fatal') p.push('fatal: summary reason fatal without a fatal record');

    const wraps = recs.filter((r) => r.type === 'wrap');
    let wellFormed = true;
    const seen = new Set();
    for (const r of wraps) {
        const where = 'wrap seq ' + String(r.seq) + ': ';
        for (const k of Object.keys(r)) if (WRAP_KEYS.indexOf(k) === -1 && STAMP.indexOf(k) === -1) p.push(where + 'unknown key ' + JSON.stringify(k));
        const shape = recordShape(r);
        if (shape.length !== 0) { wellFormed = false; for (const x of shape) p.push(where + x); continue; }
        const key = r.check + '/' + r.counter;
        if (seen.has(key)) { wellFormed = false; p.push(where + 'duplicate record ' + key); continue; }
        seen.add(key);
        if (checks !== null && checks.indexOf(r.check) === -1) { wellFormed = false; p.push(where + r.check + ' is not in the SOAK_WRAP selection'); continue; }
        // judge() folds the recorded status in, so `derived` can only be as green as the status or redder
        const j = judge(r, WRAP_TARGETS[r.check][r.counter]);
        const derived = j.verdict;
        const why = [];
        if (r.check === 'W5') {
            const cls = r.pre.cls;
            const bind = w5Rule({ pre: r.pre.classes[cls].bop, post: r.post.classes[cls].bop });
            if (j.bop.verdict !== P && cls !== j.bop.cls) {
                why.push('binding class ' + cls + ' (' + bind.verdict + ') is not the worst class ' + j.bop.cls + ' (' + j.bop.verdict + ')');
            }
            for (const k of ['pre', 'post']) {
                if (r[k].bop !== r[k].classes[cls].bop) why.push(k + '.bop ' + String(r[k].bop) + ' != ' + k + '.classes[' + cls + '].bop ' + String(r[k].classes[cls].bop));
            }
        }
        if (r.status === P && derived !== P) why.push('status PASS but the re-derivation is ' + derived);
        if (r.status === I && derived === F) why.push('status INCONCLUSIVE but the re-derivation is FAIL');
        if (why.length !== 0) p.push(where + key + ' ' + why.join('; '));
    }

    if (s !== null) {
        if (STATUSES.indexOf(s.verdict) === -1) p.push('summary: verdict ' + JSON.stringify(s.verdict) + ' is not ' + STATUSES.join('|'));
        else if (s.exitCode !== EXIT_CODE[s.verdict]) p.push('summary: exitCode ' + String(s.exitCode) + ' != ' + EXIT_CODE[s.verdict] + ' for verdict ' + s.verdict);
        let want = null;
        if (s.reason === 'fatal') want = F;
        else if (s.reason === 'signal') {
            // the burn-in ladder (gates.mjs verdict, main.mjs): an interrupted run that saw a FAIL is FAIL, never
            // softened to INCONCLUSIVE; with no FAIL it lacks evidence -> INCONCLUSIVE
            want = I;
            for (const r of wraps) {
                if (recordShape(r).length !== 0 || (checks !== null && checks.indexOf(r.check) === -1)) continue;
                if (judge(r, WRAP_TARGETS[r.check][r.counter]).verdict === F) { want = F; break; }
            }
        }
        else if (s.reason === 'end') {
            if (wellFormed && checks !== null) {
                try { want = wrapRule(wraps.map(stripStamp), checks).verdict; } catch (e) { p.push('summary: ' + e.message); }
            }
        } else p.push('summary: reason ' + JSON.stringify(s.reason) + ' is not end|signal|fatal');
        if (want !== null && s.verdict !== want) p.push('summary: verdict ' + String(s.verdict) + ' != re-derived ' + want);
    }
    return p;
}

function stripStamp(r) {
    const o = {};
    for (const k of WRAP_KEYS) o[k] = r[k];
    return o;
}
