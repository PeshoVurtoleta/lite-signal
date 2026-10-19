/**
 * @zakkster/lite-signal soak -- the DIVERGENCE REGISTRY (SPEC-B v2 section 4.4; S1cd task 5, amendments 5, 8).
 *
 *   validate(reg?, vocab?)  -> string[]   problems; [] = valid. Default: the loaded divergences.json and
 *                                         the vocabulary IMPORTED from the soak modules (never copied).
 *   classify(rec, opts?)    -> null | {known, tag, ids, findings, perFail}
 *   digest(text?)           -> sha256 hex of divergences.json (the header `divergences` field)
 *
 * classify input (one failing world; main.mjs builds it from runWorld's result):
 *   engine           string, e.g. 'lite'
 *   lane             roster lane name
 *   step, op         failure.step (integer) and failure.op
 *   fails            failure.fails: non-empty [{oracle, sig, detail}] (every oracle that fired on that step)
 *   scen             failure.scen: the step's scenario tags
 *   worldScen        the world's scenario names (keys of runWorld().scen with a count > 0)
 *   worldScenCounts  optional: runWorld().scen itself. An entry with priorScen needs it (absent -> no match)
 *   escape           optional: normalizeEscape(<the error the failing op's top-level call threw>), [] when it
 *                    returned. DIV-F22 needs it (absent -> no match): main captures it in its adapter wrapper.
 * opts.includeFixed  true for any named control kernel (header.controls.name !== null, pre- or post-fix): entries whose
 *                    fixedIn is set then explain too. Default false: on the tree a fixed finding is a regression.
 * opts.registry      optional registry object to classify against instead of divergences.json (tests, and an
 *                    engine rung's dv-proposed.json before it is merged). It is validated first; invalid throws.
 *
 * A shape holds when its pair matches, its anchored detail regex matches, and its optional clauses hold:
 *   with          a co-fail of the same step has one of these pairs
 *   sameBody      (boolean; requires with) when true, that co-fail must also name the SAME body: the leading
 *                 ref /^(?:body|effect)#(\d+)\b/ of both details is equal. A detail with no such ref (O6
 *                 'top-level read of #N', 'engine error escaped') never matches (fail closed). b70 DIV-F15
 *                 widening: an O1e effect-stale on the effect whose body escaped the TypeError in that step.
 *   scen          the step scen carries every one (all-of)
 *   worldScen     the world scen carries every one (all-of; a SHAPE-level narrowing, so one entry's shapes may
 *                 differ: burst 53 DIV-F6 widening, PLAN-F-b33-1 N19.3)
 *   notWorldScen  the world scen carries NONE of these (the negative clause; e.g. DIV-F6's standalone shapes
 *                 exclude revert-after-mid-read so a DIV-F5 world never also reads DIV-F6)
 * worldScen and notWorldScen, when present, must each be a non-empty duplicate-free array of known scenarios; a shape whose
 * worldScen and notWorldScen overlap, or whose notWorldScen names one of its entry's worldScen, can never hold
 * and makes the registry invalid (fail closed).
 *
 * Result: null unless EVERY fail is explained (fail closed: one unexplained fail makes the world unknown).
 * known = the explaining entry ids in registry order joined by '+'; tag = their findings joined by '+'
 * (e.g. 'F6+F22'). A wrong container TYPE throws TypeError; an unknown value just does not match.
 * classify throws while the loaded registry is invalid.
 *
 * DIV-F22 attribution (amendment 8): the replacing token is the escape leaf that is not the batch token.
 * It is the F6 pre-walk token when an O6 escape-computed fail of the same step names it ('unpredicted
 * escape <token>'): the world then also carries DIV-F6 and the tag is F6+F22. It is an effect-body escape
 * when it was predicted (no O6 escape-* fail in the step): tag F22. Note: in S1 an effect body only
 * re-throws computed tokens, so the decision is where the token was thrown (pre-walk vs body), not
 * leaf.origin. No replacing leaf, a non-SoakThrow leaf, or an escape-* fail naming no leaf -> null.
 *
 * COLD module. No engine import.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ORACLES, SIGS } from './oracles.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { ROSTER } from './lanes/index.mjs';
import { GEN_RULES } from './gen.mjs';

export const REGISTRY_URL = new URL('./divergences.json', import.meta.url);
export const KINDS = Object.freeze(['fix', 'contract', 'engine']);
export const ENGINES = Object.freeze(['lite']);
/** exec.mjs failure.op values: script ops plus the world-end and teardown pseudo-ops. */
export const OPS = Object.freeze(['sig', 'comp', 'eff', 'set', 'burst', 'read', 'stop', 'disp', 'batch', 'reg', 'off', 'arm', 'seq', 'end', 'teardown']);
/** Scenarios a step counts at most once (one cycle-bomb guard per op), so prior = count - inStep is exact. */
export const ONCE_PER_STEP = Object.freeze(['cycle-error-surfaces']);
export const ATTRIBUTIONS = Object.freeze(['batch-token-replaced']);

const ENTRY_KEYS = Object.freeze(['id', 'kind', 'finding', 'since', 'fixedIn', 'fixBy', 'decision', 'engines', 'lanes', 'oracles', 'sigs',
    'ops', 'scen', 'worldScen', 'priorScen', 'shapes', 'attribution', 'pending', 'conformanceCases', 'expectedThrow', 'description']);
const SHAPE_KEYS = Object.freeze(['pair', 'detail', 'with', 'sameBody', 'scen', 'worldScen', 'notWorldScen']);
const TOP_KEYS = Object.freeze(['schema', 'about', 'allowances', 'entries']);
const ALLOW_KEYS = Object.freeze(['genRules', 'structural', 'oracle']);

export const DEFAULT_VOCAB = Object.freeze({
    lanes: ROSTER, oracles: ORACLES, sigs: SIGS, scenarios: SCENARIOS, genRules: GEN_RULES, engines: ENGINES, ops: OPS,
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
/** A PLAIN object: prototype Object.prototype or null (as config.mjs checkCovOffSupported), never an array. */
const isPlain = (o) => {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return false;
    const p = Object.getPrototypeOf(o);
    return p === Object.prototype || p === null;
};
/** Read an OWN data property (never the prototype chain, never a getter); undefined when absent. */
function ownVal(o, k, where) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d === undefined) return undefined;
    if (!('value' in d)) throw new TypeError(where + ': ' + k + ' must be a data property, not an accessor');
    return d.value;
}
const isStrArr = (a) => Array.isArray(a) && a.every((s) => typeof s === 'string' && s.length > 0);
const nonEmptyStr = (s) => typeof s === 'string' && s.length > 0;

/** Is sig in oracle o's vocabulary (O6 escape-<x> is an open family; SIGS lists it as 'escape-*')? */
function sigOk(vocab, o, sig) {
    const list = vocab.sigs[o];
    if (!Array.isArray(list)) return false;
    if (list.indexOf(sig) !== -1 && sig !== 'escape-*') return true;
    return list.indexOf('escape-*') !== -1 && /^escape-[A-Za-z]+$/.test(sig) && list.indexOf(sig) === -1;
}

/** Strings no real oracle detail is; a detail regex that matches one is a broad matcher. */
export const DETAIL_PROBES = Object.freeze(['', 'x', ' ', '0', '#', 'zz', 'zz zz', 'q7 xv0 lk3 zp9 mw2 rt5 ny8 bc1 hd4 fg6 j']);

/**
 * Compile a shape's detail as a WHOLE-STRING matcher: the source must be the literal frame ^...$ with an
 * unescaped final $, the body must compile on its own (so a ')' cannot break out of the group), and it is
 * compiled as ^(?:body)$, so a top-level '|' cannot leave a branch unanchored. A regex that matches a
 * structure-free probe is rejected. Returns {re} or {error}. Used by validate AND compileShapes.
 */
export function compileDetail(src) {
    if (typeof src !== 'string' || src.length < 3 || src[0] !== '^' || src[src.length - 1] !== '$') return { error: 'detail must be an anchored regex source "^...$"' };
    let bs = 0;
    for (let k = src.length - 2; k >= 0 && src[k] === '\\'; k--) bs++;
    if ((bs & 1) === 1) return { error: 'detail must end with an unescaped $' };
    const body = src.slice(1, -1);
    let re;
    try { new RegExp(body); re = new RegExp('^(?:' + body + ')$'); } catch (e) { return { error: 'detail does not compile: ' + e.message }; }
    for (const p of DETAIL_PROBES) if (re.test(p)) return { error: 'detail matches the structure-free probe ' + JSON.stringify(p) + ' (broad matcher)' };
    return { re };
}

function anchoredRegex(src, where, out) {
    const c = compileDetail(src);
    if (c.error !== undefined) { out.push(where + ': ' + c.error); return null; }
    return c.re;
}

/** Validate a registry object. Returns every problem found (never throws on bad data). */
export function validate(reg, vocab) {
    const V = vocab === undefined ? DEFAULT_VOCAB : vocab;
    const out = [];
    const r = reg === undefined ? LOADED.reg : reg;
    if (!isObj(r)) return ['registry: not a plain object'];
    for (const k of Object.keys(r)) if (TOP_KEYS.indexOf(k) === -1) out.push('registry: unknown key ' + k);
    if (r.schema !== 1) out.push('registry: schema must be 1');
    if (!nonEmptyStr(r.about)) out.push('registry: about must be a non-empty string');
    if (!Array.isArray(r.entries)) { out.push('registry: entries must be an array'); return out; }

    const ids = new Map();
    for (let n = 0; n < r.entries.length; n++) {
        const e = r.entries[n];
        const w = 'entry[' + n + ']' + (isObj(e) && typeof e.id === 'string' ? ' ' + e.id : '');
        if (!isObj(e)) { out.push(w + ': not a plain object'); continue; }
        for (const k of Object.keys(e)) if (ENTRY_KEYS.indexOf(k) === -1) out.push(w + ': unknown key ' + k);
        for (const k of ENTRY_KEYS) if (!own(e, k)) out.push(w + ': missing key ' + k);
        if (typeof e.id !== 'string' || !/^DIV-[A-Za-z0-9.-]+$/.test(e.id)) out.push(w + ': id must match DIV-<name>');
        else if (ids.has(e.id)) out.push(w + ': duplicate id');
        else ids.set(e.id, e);
        if (KINDS.indexOf(e.kind) === -1) out.push(w + ': kind must be one of ' + KINDS.join('|'));
        for (const k of ['finding', 'since', 'decision', 'description']) if (!nonEmptyStr(e[k])) out.push(w + ': ' + k + ' must be a non-empty string');
        for (const k of ['fixedIn', 'fixBy', 'pending']) if (e[k] !== null && !nonEmptyStr(e[k])) out.push(w + ': ' + k + ' must be null or a non-empty string');
        for (const k of ['engines', 'lanes', 'oracles', 'sigs', 'ops', 'scen', 'worldScen', 'priorScen', 'conformanceCases']) {
            if (!Array.isArray(e[k]) || !e[k].every((s) => typeof s === 'string' && s.length > 0)) out.push(w + ': ' + k + ' must be a string array');
            else if (new Set(e[k]).size !== e[k].length) out.push(w + ': ' + k + ' has duplicates');
        }
        if (!Array.isArray(e.shapes)) { out.push(w + ': shapes must be an array'); continue; }
        if (!isStrArr(e.engines) || e.engines.length === 0) out.push(w + ': engines must be non-empty');
        else for (const x of e.engines) if (V.engines.indexOf(x) === -1) out.push(w + ': unknown engine ' + x);
        if (isStrArr(e.lanes)) for (const x of e.lanes) if (V.lanes.indexOf(x) === -1) out.push(w + ': unknown lane ' + x);
        if (isStrArr(e.oracles)) for (const x of e.oracles) if (V.oracles.indexOf(x) === -1) out.push(w + ': unknown oracle ' + x);
        if (isStrArr(e.ops)) for (const x of e.ops) if (V.ops.indexOf(x) === -1) out.push(w + ': unknown op ' + x);
        for (const k of ['scen', 'worldScen', 'priorScen']) if (isStrArr(e[k])) for (const x of e[k]) if (V.scenarios.indexOf(x) === -1) out.push(w + ': unknown ' + k + ' ' + x);
        if (isStrArr(e.priorScen)) for (const x of e.priorScen) {
            if (ONCE_PER_STEP.indexOf(x) === -1) out.push(w + ': priorScen ' + x + ' is not a once-per-step scenario');
            if (!isStrArr(e.worldScen) || e.worldScen.indexOf(x) === -1) out.push(w + ': priorScen ' + x + ' must also be in worldScen');
        }
        if (isStrArr(e.conformanceCases)) for (const p of e.conformanceCases) if (p[0] === '/' || p.indexOf('..') !== -1 || p.indexOf('audit/') === 0) out.push(w + ': conformance case must be an in-repo relative path: ' + p);
        if (e.expectedThrow !== null && !(isObj(e.expectedThrow) && nonEmptyStr(e.expectedThrow.ctor) && typeof e.expectedThrow.messagePrefix === 'string' && Object.keys(e.expectedThrow).length === 2)) {
            out.push(w + ': expectedThrow must be null or {ctor, messagePrefix}');
        }
        if (e.attribution !== null && ATTRIBUTIONS.indexOf(e.attribution) === -1) out.push(w + ': unknown attribution ' + e.attribution);
        if (e.attribution === 'batch-token-replaced' && !(isStrArr(e.sigs) && e.sigs.length === 1 && e.sigs[0] === 'expected-escape-missing' && e.oracles.length === 1 && e.oracles[0] === 'O6')) {
            out.push(w + ': attribution batch-token-replaced needs oracles [O6], sigs [expected-escape-missing]');
        }
        const matcher = isStrArr(e.lanes) && e.lanes.length > 0;
        if (!matcher) {
            for (const k of ['oracles', 'sigs', 'ops', 'scen', 'worldScen', 'priorScen']) if (isStrArr(e[k]) && e[k].length > 0) out.push(w + ': ' + k + ' is set but lanes is empty (a matcher needs lanes)');
            if (e.shapes.length > 0) out.push(w + ': shapes set but lanes is empty');
            if (e.attribution !== null) out.push(w + ': attribution set but lanes is empty');
            continue;
        }
        if (e.pending !== null) out.push(w + ': a matcher entry has pending set (pending is for entries without an S1 matcher)');
        if (!isStrArr(e.oracles) || e.oracles.length === 0 || !isStrArr(e.sigs) || e.sigs.length === 0) { out.push(w + ': a matcher needs oracles and sigs'); continue; }
        // no slack: every sig belongs to a listed oracle, every listed oracle has a sig, every valid pair has a shape
        const pairs = [];
        for (const o of e.oracles) for (const s of e.sigs) if (sigOk(V, o, s)) pairs.push(o + ':' + s);
        for (const s of e.sigs) if (!e.oracles.some((o) => sigOk(V, o, s))) out.push(w + ': sig ' + s + ' belongs to none of its oracles');
        for (const o of e.oracles) if (!e.sigs.some((s) => sigOk(V, o, s))) out.push(w + ': oracle ' + o + ' has none of its sigs');
        if (e.shapes.length === 0) out.push(w + ': a matcher needs at least one shape (an anchored detail per pair)');
        const covered = new Set();
        for (let j = 0; j < e.shapes.length; j++) {
            const sh = e.shapes[j];
            const sw = w + ' shape[' + j + ']';
            if (!isObj(sh)) { out.push(sw + ': not a plain object'); continue; }
            for (const k of Object.keys(sh)) if (SHAPE_KEYS.indexOf(k) === -1) out.push(sw + ': unknown key ' + k);
            if (pairs.indexOf(sh.pair) === -1) out.push(sw + ': pair ' + sh.pair + ' is not an oracle:sig pair of this entry');
            else covered.add(sh.pair);
            if (!own(sh, 'detail')) out.push(sw + ': detail is required');
            else anchoredRegex(sh.detail, sw, out);
            if (own(sh, 'with')) {
                if (!isStrArr(sh.with) || sh.with.length === 0) out.push(sw + ': with must be a non-empty string array');
                else for (const p of sh.with) {
                    const [o, s] = p.split(':');
                    if (V.oracles.indexOf(o) === -1 || !sigOk(V, o, s) || p.split(':').length !== 2) out.push(sw + ': with names an unknown pair ' + p);
                    if (p === sh.pair) out.push(sw + ': with names its own pair');
                }
            }
            if (own(sh, 'sameBody')) {
                if (typeof sh.sameBody !== 'boolean') out.push(sw + ': sameBody must be a boolean');
                if (!own(sh, 'with')) out.push(sw + ': sameBody requires with (the co-fail it pins to the same body)');
            }
            if (own(sh, 'scen') && (!isStrArr(sh.scen) || sh.scen.length === 0 || sh.scen.some((x) => V.scenarios.indexOf(x) === -1))) out.push(sw + ': scen must be known scenarios');
            for (const k of ['worldScen', 'notWorldScen']) {
                if (!own(sh, k)) continue;
                const a = sh[k];
                if (!isStrArr(a) || a.length === 0 || a.some((x) => V.scenarios.indexOf(x) === -1)) out.push(sw + ': ' + k + ' must be known scenarios');
                else if (new Set(a).size !== a.length) out.push(sw + ': ' + k + ' has duplicates');
            }
            if (isStrArr(sh.notWorldScen)) for (const x of sh.notWorldScen) {
                if (isStrArr(sh.worldScen) && sh.worldScen.indexOf(x) !== -1) out.push(sw + ': ' + x + ' is in both worldScen and notWorldScen (never holds)');
                if (isStrArr(e.worldScen) && e.worldScen.indexOf(x) !== -1) out.push(sw + ': notWorldScen ' + x + ' is in the entry worldScen (never holds)');
            }
        }
        for (const p of pairs) if (!covered.has(p)) out.push(w + ': pair ' + p + ' has no shape (broad matcher)');
    }

    // allowances: every generator rule is an allowance with an entry, or declared structural
    const A = r.allowances;
    if (!isObj(A)) { out.push('allowances: must be an object'); return out; }
    for (const k of Object.keys(A)) if (ALLOW_KEYS.indexOf(k) === -1) out.push('allowances: unknown key ' + k);
    const g = isObj(A.genRules) ? A.genRules : null;
    const st = isObj(A.structural) ? A.structural : null;
    if (g === null) out.push('allowances.genRules must be an object');
    if (st === null) out.push('allowances.structural must be an object');
    const referenced = new Set();
    if (g !== null && st !== null) {
        for (const rule of V.genRules) {
            if (!own(g, rule) && !own(st, rule)) out.push('orphan allowance: generator rule ' + rule + ' has no entry and is not declared structural');
            if (own(g, rule) && own(st, rule)) out.push('allowances: generator rule ' + rule + ' is both an allowance and structural');
        }
        for (const rule of Object.keys(g)) {
            if (V.genRules.indexOf(rule) === -1) out.push('orphan allowance: genRules.' + rule + ' is not a generator rule');
            if (!ids.has(g[rule])) out.push('orphan allowance: genRules.' + rule + ' -> ' + g[rule] + ' (no such entry)');
            else referenced.add(g[rule]);
        }
        for (const rule of Object.keys(st)) {
            if (V.genRules.indexOf(rule) === -1) out.push('allowances: structural.' + rule + ' is not a generator rule');
            if (!nonEmptyStr(st[rule])) out.push('allowances: structural.' + rule + ' needs a reason');
        }
    }
    if (!Array.isArray(A.oracle)) out.push('allowances.oracle must be an array');
    else {
        const aid = new Set();
        for (const a of A.oracle) {
            if (!isObj(a) || !nonEmptyStr(a.id)) { out.push('allowances.oracle: an allowance needs an id'); continue; }
            if (aid.has(a.id)) out.push('allowances.oracle: duplicate id ' + a.id);
            aid.add(a.id);
            if (!isStrArr(a.oracles) || a.oracles.length === 0 || a.oracles.some((o) => V.oracles.indexOf(o) === -1)) out.push('allowances.oracle ' + a.id + ': oracles must be known oracles');
            if (!ids.has(a.entry)) out.push('orphan allowance: oracle allowance ' + a.id + ' -> ' + a.entry + ' (no such entry)');
            else referenced.add(a.entry);
        }
    }
    // orphan entry: explains nothing (no matcher, nothing pending, no conformance case, no allowance)
    for (const [id, e] of ids) {
        const matcher = isStrArr(e.lanes) && e.lanes.length > 0;
        const conf = isStrArr(e.conformanceCases) && e.conformanceCases.length > 0;
        if (!matcher && e.pending === null && !conf && !referenced.has(id)) out.push('orphan entry: ' + id + ' has no matcher, no pending lane, no conformance case and no allowance');
    }
    return out;
}

/** sha256 of the registry text (default: the file bytes). */
export function digest(text) {
    const t = text === undefined ? LOADED.text : text;
    if (typeof t !== 'string') throw new TypeError('digest: text must be a string');
    return createHash('sha256').update(t).digest('hex');
}

/* ---- classify ----------------------------------------------------------------------------------- */

/** Snapshot the record's OWN fields after the type checks (nothing is read through a prototype). */
function checkRecord(rec0) {
    if (!isPlain(rec0)) throw new TypeError('classify: record must be a plain object');
    const rec = {};
    for (const k of ['engine', 'lane', 'step', 'op', 'fails', 'scen', 'worldScen', 'worldScenCounts', 'escape']) rec[k] = ownVal(rec0, k, 'classify: record');
    if (typeof rec.engine !== 'string' || typeof rec.lane !== 'string' || typeof rec.op !== 'string') throw new TypeError('classify: engine, lane and op must be strings');
    if (!Number.isInteger(rec.step)) throw new TypeError('classify: step must be an integer');
    if (!Array.isArray(rec.fails) || rec.fails.length === 0) throw new TypeError('classify: fails must be a non-empty array');
    for (const f of rec.fails) if (!isPlain(f) || typeof f.oracle !== 'string' || typeof f.sig !== 'string' || typeof f.detail !== 'string') throw new TypeError('classify: each fail needs string oracle, sig and detail');
    if (!isStrArr(rec.scen)) throw new TypeError('classify: scen must be a string array');
    if (!isStrArr(rec.worldScen)) throw new TypeError('classify: worldScen must be a string array');
    if (rec.worldScenCounts !== undefined && !isPlain(rec.worldScenCounts)) throw new TypeError('classify: worldScenCounts must be a plain object');
    if (rec.escape !== undefined && !(Array.isArray(rec.escape) && rec.escape.every(isPlain))) throw new TypeError('classify: escape must be an array of plain leaves');
    return rec;
}

/** Scenario s surfaced in a step BEFORE the failing one (once-per-step scenarios only). */
function prior(rec, s) {
    const c = rec.worldScenCounts;
    if (c === undefined || !own(c, s) || !Number.isInteger(c[s])) return false;
    return c[s] - (rec.scen.indexOf(s) !== -1 ? 1 : 0) >= 1;
}

const ESC_RE = /^unpredicted escape (\S+)$/;
/** The body / effect a detail names first (sameBody); null when it names none (e.g. 'top-level read of #N'). */
const BODY_REF_RE = /^(?:body|effect)#(\d+)\b/;
const bodyRef = (d) => { const m = BODY_REF_RE.exec(d); return m === null ? null : m[1]; };
const BATCH_RE = /^predicted escape (batch:\d+) x1 did not happen$/;

/** DIV-F22: returns 'computed' (F6 pre-walk token), 'effect' (effect-body escape) or null. */
function batchReplacement(rec, f) {
    const m = BATCH_RE.exec(f.detail);
    if (m === null || m[1] !== 'batch:' + rec.step) return null;          // not the failing op's own batch token
    if (!Array.isArray(rec.escape)) return null;                           // no evidence of what replaced it
    if (rec.escape.some((l) => l.token === m[1])) return null;             // it did escape: inconsistent record
    const repl = rec.escape;
    if (repl.length === 0) return null;                                    // nothing replaced it: swallowed, not F22
    if (repl.some((l) => typeof l.token !== 'string')) return null;       // an engine error replaced it: another defect
    const named = [];
    for (const x of rec.fails) {
        if (x.oracle !== 'O6' || x.sig.indexOf('escape-') !== 0) continue;
        const e = ESC_RE.exec(x.detail);
        if (e === null) return null;                                       // an escape-* fail that is not a token escape
        named.push({ sig: x.sig, token: e[1] });
    }
    // predicted: an effect body escaped it. S1 effect bodies only re-throw computed tokens; 'effect' is admitted
    // for future lanes. An equals or batch token is not an effect-body escape.
    if (named.length === 0) return repl.every((l) => l.origin === 'computed' || l.origin === 'effect') ? 'effect' : null;
    for (const n of named) if (!repl.some((l) => l.token === n.token)) return null;   // names no leaf of this call
    return named.some((n) => n.sig === 'escape-computed' && n.token.indexOf('computed:') === 0) ? 'computed' : null;
}

function shapeHolds(rec, f, sh) {
    if (sh.pair !== f.oracle + ':' + f.sig) return false;
    if (!sh.re.test(f.detail)) return false;
    if (sh.scen !== undefined) for (const s of sh.scen) if (rec.scen.indexOf(s) === -1) return false;
    if (sh.worldScen !== undefined) for (const s of sh.worldScen) if (rec.worldScen.indexOf(s) === -1) return false;
    if (sh.notWorldScen !== undefined) for (const s of sh.notWorldScen) if (rec.worldScen.indexOf(s) !== -1) return false;
    if (sh.with !== undefined) {
        // sameBody: the co-fail must name the same body #N as f; either detail without a ref -> no match (fail closed)
        const ref = sh.sameBody === true ? bodyRef(f.detail) : null;
        if (sh.sameBody === true && ref === null) return false;
        let ok = false;
        for (const p of sh.with) for (const x of rec.fails) {
            if (x === f || x.oracle + ':' + x.sig !== p) continue;
            if (sh.sameBody === true && bodyRef(x.detail) !== ref) continue;
            ok = true;
        }
        if (!ok) return false;
    }
    return true;
}

/** Does entry e explain fail f of record rec? Returns false, true, or the F22 origin string. */
function explains(e, shapes, rec, f, includeFixed) {
    if (e.lanes.length === 0) return false;
    if (e.fixedIn !== null && includeFixed !== true) return false;
    if (e.engines.indexOf(rec.engine) === -1 || e.lanes.indexOf(rec.lane) === -1) return false;
    if (e.oracles.indexOf(f.oracle) === -1 || e.sigs.indexOf(f.sig) === -1) return false;
    if (e.ops.length > 0 && e.ops.indexOf(rec.op) === -1) return false;
    for (const s of e.scen) if (rec.scen.indexOf(s) === -1) return false;
    for (const s of e.worldScen) if (rec.worldScen.indexOf(s) === -1) return false;
    for (const s of e.priorScen) if (!prior(rec, s)) return false;
    if (!shapes.get(e.id).some((sh) => shapeHolds(rec, f, sh))) return false;
    if (e.attribution === 'batch-token-replaced') {
        const origin = batchReplacement(rec, f);
        return origin === null ? false : origin;
    }
    return true;
}

/** Classify one failing world. See the header for the record contract. */
export function classify(rec, opts) {
    // opts: a PLAIN object read through OWN data properties only. An option inherited from a prototype
    // (Object.create({includeFixed: true})) THROWS TypeError: it is never honoured and never silently ignored.
    let optFixed, optReg;
    if (opts !== undefined) {
        if (!isPlain(opts)) throw new TypeError('classify: opts must be a plain object (prototype Object.prototype or null)');
        // Reflect.ownKeys: a Symbol or non-enumerable key is an unknown option too, never a silent pass
        for (const k of Reflect.ownKeys(opts)) if (k !== 'includeFixed' && k !== 'registry') throw new TypeError('classify: unknown option ' + String(k) + ' (includeFixed | registry)');
        optFixed = ownVal(opts, 'includeFixed', 'classify: opts');
        optReg = ownVal(opts, 'registry', 'classify: opts');
    }
    if (optFixed !== undefined && typeof optFixed !== 'boolean') throw new TypeError('classify: includeFixed must be a boolean');
    let reg = LOADED.reg, shapes = LOADED.shapes;
    if (optReg !== undefined) {
        const probs = validate(optReg);
        if (probs.length > 0) throw new Error('classify: opts.registry is invalid: ' + probs[0]);
        reg = optReg;
        shapes = compileShapes(reg);
    } else if (LOADED.problems.length > 0) {
        throw new Error('classify: divergences.json is invalid: ' + LOADED.problems[0]);
    }
    rec = checkRecord(rec);
    const includeFixed = optFixed === true;
    const entries = reg.entries;
    const used = new Set();
    const perFail = [];
    let origin = null;
    for (const f of rec.fails) {
        const hit = [];
        for (const e of entries) {
            const r = explains(e, shapes, rec, f, includeFixed);
            if (r === false) continue;
            hit.push(e.id);
            if (typeof r === 'string') origin = r;
        }
        if (hit.length === 0) return null;
        for (const id of hit) used.add(id);
        perFail.push(Object.freeze(hit));
    }
    const ids = entries.filter((e) => used.has(e.id)).map((e) => e.id);
    const findings = entries.filter((e) => used.has(e.id)).map((e) => e.finding);
    // amendment 8: a computed (pre-walk) replacing token must come with F6, an effect-body one must not
    if (origin === 'computed' && findings.indexOf('F6') === -1) return null;
    if (origin === 'effect' && findings.indexOf('F6') !== -1) return null;
    return Object.freeze({
        known: ids.join('+'), tag: findings.join('+'), ids: Object.freeze(ids), findings: Object.freeze(findings), perFail: Object.freeze(perFail),
    });
}

/* ---- load once (cold) --------------------------------------------------------------------------- */

function compileShapes(reg) {
    const m = new Map();
    for (const e of reg.entries) {
        m.set(e.id, e.shapes.map((sh) => {
            const c = compileDetail(sh.detail);
            if (c.error !== undefined) throw new Error('divergences: ' + e.id + ' ' + sh.pair + ': ' + c.error);   // validate ran first
            return { pair: sh.pair, re: c.re, with: sh.with, sameBody: sh.sameBody, scen: sh.scen, worldScen: sh.worldScen, notWorldScen: sh.notWorldScen };
        }));
    }
    return m;
}

function deepFreeze(o) {
    if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
}

function load() {
    let text = null, reg = null;
    const problems = [];
    try { text = readFileSync(REGISTRY_URL, 'utf8'); } catch (e) { problems.push('cannot read divergences.json: ' + e.message); }
    if (text !== null) {
        try { reg = JSON.parse(text); } catch (e) { problems.push('divergences.json is not JSON: ' + e.message); }
    }
    const L = { text, reg, problems, shapes: new Map() };
    if (reg !== null) {
        for (const p of validate(reg)) problems.push(p);
        if (problems.length === 0) {
            L.shapes = compileShapes(reg);
            deepFreeze(reg);
        }
    }
    return L;
}

const LOADED = load();
/** Problems of the loaded registry ([] = valid). */
export const REGISTRY_PROBLEMS = Object.freeze(LOADED.problems.slice());
