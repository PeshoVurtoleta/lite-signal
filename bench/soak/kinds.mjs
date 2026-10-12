/**
 * @zakkster/lite-signal soak -- body kinds: the USER CODE shared by the engine bodies and the model
 * (SPEC-B v2 section 4.2).
 *
 * evalKind(spec, read, id, ctx) is the one body function. exec.mjs calls it with a read that goes through
 * the engine; model.mjs calls it with a read that recurses over plain data. Only the read path differs, so
 * sharing it cannot hide an engine bug in the oracle: it holds no state between calls.
 *
 * Kinds (read ORDER is part of the contract; G4: a body never reads the same node twice):
 *   sum, identity, select   bench/torture/helpers/index.mjs (oracle-fuzzer.mjs reference kinds)
 *   cond                    read d[0]; if toNum > 50 and a second dep exists, read d[1] and return it
 *   hash                    h = 7; h = h * 31 + toNum(x) (int32) over every dep
 *   outer   (NEST)          read t, pre[], the inner computed (tracked or untracked), ACTION slot, then
 *                           post[] unless ctx.early
 *   inner   (NEST)          ACTION slot, then ic2 (if any), t, then x unless ctx.flip
 *   child   (NEST)          ACTION slot only; reads nothing
 * thr rule (computeds only): ((toNum(v) % 5 + 5) % 5) === 3 -> throw SoakThrow('computed', id)
 * (model-lane.mjs:24-25).
 *
 * Values are script codes (JSON-safe): a non-negative integer is itself; -(k+1) is VALUE_POOL[k];
 * EQ_BOMB_CODE is the sentinel that makes a throwing `equals` throw.
 *
 * COLD module.
 */

import { kindSum, kindIdentity, kindSelect, toNum, VALUE_POOL } from '../torture/helpers/index.mjs';

export { toNum, VALUE_POOL };

/**
 * A thrown body error. Deliberately NOT an Error subclass: capturing a stack per throw would dominate the
 * ERROR lane's cost, and an engine must propagate any thrown value. `token` identifies the escape
 * (origin:id), so O6 can compare escape SETS exactly and O1/O2 compare errors by token.
 */
export class SoakThrow {
    constructor(origin, id) {
        this.origin = origin;
        this.id = id;
        this.token = origin + ':' + id;
        this.message = 'SoakThrow:' + this.token;
    }
    toString() { return this.message; }
}

/** The marker an effect body that reads through try records in place of a thrown read. */
export const ERR = 'ERR';

/** A value never in VALUE_POOL or the int range: setting it makes a bomb `equals` throw. */
export const EQ_BOMB = Object.freeze({ eqBomb: true, toString() { return '#eqBomb'; } });
export const EQ_BOMB_CODE = -1000;

export function encodeValue(v) {
    if (v === EQ_BOMB) return EQ_BOMB_CODE;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && !Object.is(v, -0)) return v;
    for (let k = 0; k < VALUE_POOL.length; k++) if (Object.is(VALUE_POOL[k], v)) return -(k + 1);
    throw new TypeError('encodeValue: value outside the soak domain: ' + String(v));
}

export function decodeValue(code) {
    if (code === EQ_BOMB_CODE) return EQ_BOMB;
    if (code >= 0) return code;
    return VALUE_POOL[-code - 1];
}

/**
 * Flatten an escape into leaves: SoakThrow -> {origin, token}; AggregateError -> its errors, recursively;
 * anything else -> {ctor, message}. An AggregateError with NO errors is itself a leaf (never zero leaves:
 * zero leaves would read as "no escape", fail-open).
 */
export function normalizeEscape(err) {
    const out = [];
    const walk = (e, depth) => {
        if (e instanceof SoakThrow) { out.push({ origin: e.origin, token: e.token }); return; }
        if (depth < 8 && typeof AggregateError === 'function' && e instanceof AggregateError && Array.isArray(e.errors) && e.errors.length > 0) {
            for (const x of e.errors) walk(x, depth + 1);
            return;
        }
        const ctor = e !== null && e !== undefined && e.constructor && typeof e.constructor.name === 'string' ? e.constructor.name : typeof e;
        const message = e !== null && e !== undefined && e.message !== undefined ? String(e.message) : String(e);
        out.push({ ctor, message });
    };
    walk(err, 0);
    return out;
}

export const thrRule = (v) => ((toNum(v) % 5) + 5) % 5 === 3;

/** Same value for the oracles: SoakThrows compare by token, everything else by Object.is. */
export function sameValue(a, b) {
    const ea = a instanceof SoakThrow, eb = b instanceof SoakThrow;
    if (ea || eb) return ea && eb && a.token === b.token;
    return Object.is(a, b);
}

export function showValue(v) {
    if (v instanceof SoakThrow) return 'ERR(' + v.token + ')';
    if (Object.is(v, -0)) return '-0';
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
}

const NO_CTX = Object.freeze({ early: false, flip: false, action: null });

/**
 * Evaluate one body. `read(ref, untracked)` returns a value or throws. `ctx` carries the NEST mode
 * ({early, flip}) and, in the engine only, a one-shot `action`. The model passes no action.
 */
export function evalKind(spec, read, id, ctx) {
    const c = ctx === undefined || ctx === null ? NO_CTX : ctx;
    let v;
    switch (spec.k) {
        case 'sum': v = kindSum(spec.d, read); break;
        case 'identity': v = kindIdentity(spec.d, read); break;
        case 'select': v = kindSelect(spec.s, spec.d, read); break;
        case 'cond': {
            const a = read(spec.d[0]);
            v = (toNum(a) > 50 && spec.d.length > 1) ? read(spec.d[1]) : a;
            break;
        }
        case 'hash': {
            let h = 7;
            for (let i = 0; i < spec.d.length; i++) h = (Math.imul(h, 31) + toNum(read(spec.d[i]))) | 0;
            v = h;
            break;
        }
        case 'outer': {
            let acc = toNum(read(spec.t));
            for (let i = 0; i < spec.pre.length; i++) acc = (acc + toNum(read(spec.pre[i]))) | 0;
            if (spec.ic !== null) acc = (acc + toNum(read(spec.ic, spec.icU))) | 0;
            if (typeof c.action === "function") c.action();
            if (c.early) { v = acc; break; }
            for (let i = 0; i < spec.post.length; i++) acc = (acc + toNum(read(spec.post[i]))) | 0;
            v = acc;
            break;
        }
        case 'inner': {
            if (typeof c.action === "function") c.action();
            let acc = 0;
            if (spec.ic2 !== null) acc = toNum(read(spec.ic2));
            acc = (acc + toNum(read(spec.t))) | 0;
            if (spec.x !== null && !c.flip) acc = (acc + toNum(read(spec.x))) | 0;
            v = acc;
            break;
        }
        case 'child': {
            if (typeof c.action === "function") c.action();
            v = 0;
            break;
        }
        default:
            throw new TypeError('evalKind: unknown kind ' + spec.k);
    }
    if (spec.thr === true && thrRule(v)) throw new SoakThrow('computed', id);
    return v;
}

/** Every node a spec can read, all branches (static; used by the generator for I1, G5, G6 and cones). */
export function specRefs(spec) {
    switch (spec.k) {
        case 'select': return [spec.s].concat(spec.d);
        case 'outer': return [spec.t].concat(spec.pre, spec.ic === null ? [] : [spec.ic], spec.post);
        case 'inner': return (spec.ic2 === null ? [] : [spec.ic2]).concat([spec.t], spec.x === null ? [] : [spec.x]);
        case 'child': return [];
        default: return spec.d.slice();
    }
}
