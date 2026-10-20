/**
 * @zakkster/lite-signal soak -- the REPORT-ONLY latency lane (S2 group B, B-B4a; PLAN-0s-bb4a SPEC / TASK 3).
 *
 * Per-call latency of the adapter's world methods, recorded into one DDSketch (@zakkster/lite-sketch 1.2.0,
 * relative error config.mjs SKETCH_ALPHA = 0.01, default maxBins 2048) per entry of config.mjs LATENCY_METHODS.
 * The sketches are built ONCE per lane (once per run) and cleared by reset() (once per lane-cycle). It gates
 * nothing: gates.mjs lists 'latency' in REPORT_ONLY_GATES (B2).
 *
 *   const lat = new LatencyLane({ floorNs })   floorNs: the header's timerFloorNs (a finite number >= 0), or null
 *                                                (UNMEASURED: the lane stays disarmed and every entry reads n 0)
 *   lat.wrap(adapter) -> adapter'              once per run; a frozen delegate of `adapter` that overrides open()
 *   lat.armed = true | false                   main: (w & 15) === 8 before runWorld, false after the loop. A
 *                                                boolean only (TypeError otherwise); reads false while floorNs is null
 *   lat.floorNs                                the floor the lane was built with (number or null)
 *   lat.reset()                                clear every sketch (once per lane-cycle)
 *   lat.observe(method, ns)                    COLD test seam: record one value through the SAME rec() path
 *   lat.toJSON() -> { <method>: { n, p50Ns, p99Ns, belowFloor } }   keyed by LATENCY_METHODS, in order
 *
 * open() while UNARMED returns the raw world itself (15 of 16 worlds byte-identical). ARMED, it returns a PLAIN
 * delegate (own properties, never Object.create(raw): a world used as a prototype stayed reachable from V8
 * optimized code after its world died, main.mjs tapAdapter) holding every own key of the raw world: a
 * LATENCY_METHODS function becomes a timed wrapper, a LATENCY_UNTIMED function is bound to the raw world, any
 * other value is copied. A timed wrapper forwards (a, b) and times RETURNING calls only: a throwing call passes
 * through untouched and records nothing (maintainer ruling b85: no try/finally). Nested calls are timed too (a
 * read inside a computed's body is inside that computed's time).
 *
 * Fail closed, at every armed open, BEFORE the delegate is built: a function-valued key in neither list throws
 * TypeError `latency: unclassified world method <k>`; a function whose .length > 2 throws TypeError (the
 * wrapper forwards two arguments). A listed method the world lacks keeps its entry at n 0.
 *
 * Entry: n = sketch.count; belowFloor = sketch.zeroCount (a timed value below floorNs is recorded as 0: the
 * clock cannot resolve it); pXX = Math.round(sketch.quantile(q)), q = 0.5 / 0.99; a quantile whose rank falls
 * in the below-floor mass (0) or of an empty sketch (NaN) is null -- null is not zero. No collapse: the timed
 * range [1e-2, 1e13] ns spans < 1750 keys at alpha 0.01, inside the 2048-bin window.
 *
 * Allocation: the wrappers are closures built at the armed open (cold, once per armed world). An armed call
 * writes the duration into a Float64Array slot and records it with sketch.addFrom(S, 0) (the zero-box entry of
 * lite-sketch), so the recording path is 0 B/op; the two performance.now() reads per timed call are <= 4
 * transient boxes before tier-up, 2 in optimized code (a boxed double where the engine returns one). observe()
 * takes ns as an argument: a fractional value can box at that call boundary when V8 does not inline it (cold
 * seam, disclosed).
 *
 * COLD module: main.mjs (B2) imports it; replay.mjs and shrink.mjs never do. No I/O, no process state.
 */

import { DDSketch, VERSION as SKETCH_VERSION } from '@zakkster/lite-sketch';
import { SKETCH_ALPHA, LATENCY_METHODS, LATENCY_UNTIMED, nearest } from './config.mjs';

/** The exact lite-sketch version this lane was verified against (package.json pins it exact). */
export const SKETCH_VERSION_REQUIRED = '1.2.0';
if (SKETCH_VERSION !== SKETCH_VERSION_REQUIRED) {
    throw new Error('latency: @zakkster/lite-sketch ' + SKETCH_VERSION_REQUIRED + ' required, loaded ' + String(SKETCH_VERSION));
}

const N_METHODS = LATENCY_METHODS.length;
const OPT_KEYS = Object.freeze(['floorNs']);

/** The ONE recording path (armed wrappers and observe). S[0] = the value in ns, S[1] = the floor in ns. */
function rec(sk, S) {
    if (S[0] < S[1]) sk.add(0);
    else sk.addFrom(S, 0);
}

/** A timed wrapper: closure slots f, raw, sk, S (no number cell). Returning calls only. */
function timed(f, raw, sk, S) {
    return function (a, b) {
        const t0 = performance.now();
        const v = f.call(raw, a, b);
        S[0] = (performance.now() - t0) * 1e6;
        rec(sk, S);
        return v;
    };
}

/** World-method functions whose parameter-list text passed paramsHidden() (allocates only on first sight). */
const ACCEPTED = new WeakSet();
const FN_TO_STRING = Function.prototype.toString;
/** The only characters a readable parameter-list head may hold; any other character refuses (unreadable). */
const SAFE_HEAD = /^[\w$\s,({}:]*$/;

/**
 * The parameter-list text of fn (its source up to the first `)` or `=>`) when it has a rest (`...`) or a default
 * (`=`) parameter -- Function.length counts neither, so a length <= 2 check alone accepts `(a, ...r)` and
 * `(a, b, c = 1)` -- else null. Refused as unreadable (that cut may not be the parameter list): a `[native code]`
 * source (bound / native function); and a head holding any character outside SAFE_HEAD (key, string, comment,
 * default, rest: the only ways a `)` can precede the list's own `)`). Refusing more is fail-closed.
 * Runs at arm() (once per armed world open, per function not yet ACCEPTED), never per timed call.
 */
function paramsHidden(fn) {
    const src = FN_TO_STRING.call(fn);
    if (src.indexOf('[native code]') !== -1) return src;
    const b = src.indexOf(')');
    const a = src.indexOf('=>');
    const end = b === -1 ? a : (a === -1 ? b : Math.min(a, b));
    const head = end === -1 ? src : src.slice(0, end);
    return SAFE_HEAD.test(head) ? null : head;
}

/** Classify every own key of an opened world (read-only scan), then build the plain delegate. */
function arm(raw, sks, S) {
    if (raw === null || typeof raw !== 'object') throw new TypeError('latency: adapter.open() returned a non-object world');
    const keys = Object.keys(raw);
    const vals = [];
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = raw[k];
        vals.push(v);
        if (typeof v !== 'function') continue;
        if (LATENCY_METHODS.indexOf(k) === -1 && LATENCY_UNTIMED.indexOf(k) === -1) {
            throw new TypeError('latency: unclassified world method ' + k + ' (config.mjs LATENCY_METHODS / LATENCY_UNTIMED)');
        }
        if (v.length > 2) {
            throw new TypeError('latency: world method ' + k + ' declares ' + v.length + ' parameters; the wrapper forwards at most 2');
        }
        if (!ACCEPTED.has(v)) {
            const hidden = paramsHidden(v);
            if (hidden !== null) {
                throw new TypeError('latency: world method ' + k + ' has a rest, default or unreadable parameter list (' + hidden.trim() + '); Function.length hides it and the wrapper forwards at most 2');
            }
            ACCEPTED.add(v);
        }
    }
    const T = {};
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = vals[i];
        if (typeof v !== 'function') { T[k] = v; continue; }
        const m = LATENCY_METHODS.indexOf(k);
        T[k] = m === -1 ? v.bind(raw) : timed(v, raw, sks[m], S);
    }
    return T;
}

/** A positive quantile, rounded; 0 (rank in the below-floor mass) or NaN (empty) -> null. */
function pNs(sk, q) {
    const v = sk.quantile(q);
    return v > 0 ? Math.round(v) : null;
}

function isPlainObject(o) {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return false;
    const p = Object.getPrototypeOf(o);
    return p === Object.prototype || p === null;
}

export class LatencyLane {
    #floorNs;
    #armed = false;
    #S = new Float64Array(2);
    #sk = [];

    /** opts: a plain object { floorNs } (required key; a finite number >= 0, or null = UNMEASURED). */
    constructor(opts) {
        if (!isPlainObject(opts)) throw new TypeError('latency: LatencyLane(opts) needs a plain object { floorNs }');
        if (Object.getOwnPropertySymbols(opts).length !== 0) throw new TypeError('latency: LatencyLane options take no Symbol keys');
        for (const k of Object.keys(opts)) {
            if (OPT_KEYS.indexOf(k) === -1) {
                const h = nearest(k, OPT_KEYS);
                throw new TypeError("latency: unknown option '" + k + "'" + (h === null ? ' (known: floorNs)' : ' (did you mean ' + h + '?)'));
            }
        }
        if (!Object.prototype.hasOwnProperty.call(opts, 'floorNs')) throw new TypeError('latency: LatencyLane needs floorNs (a number >= 0, or null)');
        const f = opts.floorNs;
        if (f !== null && !(typeof f === 'number' && f >= 0 && f < Infinity)) {
            throw new RangeError('latency: floorNs must be a finite number >= 0 or null, got ' + String(f));
        }
        this.#floorNs = f;
        this.#S[1] = f === null ? NaN : f;
        for (let i = 0; i < N_METHODS; i++) this.#sk.push(new DDSketch(SKETCH_ALPHA));
        Object.seal(this);
    }

    get floorNs() { return this.#floorNs; }

    get armed() { return this.#armed; }

    set armed(v) {
        if (typeof v !== 'boolean') throw new TypeError('latency: armed must be a boolean, got ' + String(v));
        this.#armed = v && this.#floorNs !== null;
    }

    /** A frozen delegate of `adapter` whose open() arms the world while the lane is armed. */
    wrap(adapter) {
        if (adapter === null || typeof adapter !== 'object' || typeof adapter.open !== 'function') {
            throw new TypeError('latency: wrap(adapter) needs an adapter with open()');
        }
        const lane = this;
        const open = function open(opts) {
            const raw = adapter.open(opts);
            return lane.#armed ? arm(raw, lane.#sk, lane.#S) : raw;
        };
        return Object.freeze(Object.create(adapter, { open: { value: open, enumerable: true } }));
    }

    /** Clear every sketch (once per lane-cycle). */
    reset() {
        for (let i = 0; i < N_METHODS; i++) this.#sk[i].clear();
    }

    /** COLD test seam: record `ns` for `method` through rec(). A bad method / value throws before any write. */
    observe(method, ns) {
        const i = LATENCY_METHODS.indexOf(method);
        if (i === -1) {
            const h = typeof method === 'string' ? nearest(method, LATENCY_METHODS) : null;
            throw new TypeError('latency: observe() unknown method ' + String(method) + (h === null ? '' : ' (did you mean ' + h + '?)'));
        }
        if (this.#floorNs === null) throw new TypeError('latency: observe() on an UNMEASURED lane (floorNs null)');
        if (!(typeof ns === 'number' && ns >= 0 && ns < Infinity)) throw new RangeError('latency: observe() ns must be a finite number >= 0, got ' + String(ns));
        const S = this.#S;
        S[0] = ns;
        rec(this.#sk[i], S);
    }

    /** { <method>: { n, p50Ns, p99Ns, belowFloor } } for every LATENCY_METHODS entry, in order. COLD. */
    toJSON() {
        const out = {};
        for (let i = 0; i < N_METHODS; i++) {
            const sk = this.#sk[i];
            out[LATENCY_METHODS[i]] = { n: sk.count, p50Ns: pNs(sk, 0.5), p99Ns: pNs(sk, 0.99), belowFloor: sk.zeroCount };
        }
        return out;
    }
}
