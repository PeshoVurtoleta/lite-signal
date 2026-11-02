/**
 * @zakkster/lite-signal soak -- world TRACES for the OT oracle (R7 group A, burst 144; PLAN-R7-box.md C-1, C-14,
 * C-15). traceAdapter(ad, sink) wraps every world method of an adapter and writes one line per call into a SINK, so
 * two engines (lite vs lite-box, B's twin runner) can be compared line by line.
 *
 * LINE FORMAT (byte-identical to the census prototype r7-evidence/trace-scratch.mjs):
 *   C <method> <#ordinal | - | ?kind> <encoded args> = <encoded result>      a world call that returned
 *   C <method> <#ordinal | - | ?kind> <encoded args> ! <escape JSON>         a world call that threw
 *   E <tag><k> d<depth>                                                      a body entered (computed c, effect e,
 *   X <tag><k> = <encoded result>  |  X <tag><k> ! <escape JSON>             batch b, untrack u, lifecycle on / off,
 *                                                                            createRoot r, runWithOwner o, onCleanup k,
 *                                                                            update p; k = per-world body counter)
 * A call line takes its index BEFORE the call runs (body lines inside it follow it) and its text after. Handles a
 * world returns get a per-world creation ordinal (#n); the WeakMap handle -> ordinal lives in the traced world's
 * closure and dies with it. Escapes go through the world's normalizeEscape. hook(fn) traces the hook call line only:
 * listener payloads are NOT traced (onGraphMutation op 1 / 2 flags carry FLAG_BOX by design). world.boxCounts (lite-box)
 * is forwarded untraced.
 *
 * SINK (C-1): makeTraceSink(opts?) -> { n, h1, h2, step, ... }. Every line is hashed into two Int32Array columns
 * (h1 FNV-1a 32, h2 a murmur-style 32-bit mix: 64 bits per line) plus an Int32Array step column (C-15: the step set
 * by setTraceStep when the line was written). Text is kept only for opts.keep: 'all', or a window [lo, hi) of line
 * indices; default none (hash-only: the sink holds no string). Columns grow x1.25 from 256 lines (12 B/line, so at
 * most 15 B/line + 3 KB), capped at MAX_LINES (RangeError). Read surface: sink.n, and sink.h1[i] / h2[i] / step[i]
 * for i < n (re-read the column after writes: growth replaces it). The sink holds numbers and strings only, never a
 * handle.
 *
 *   traceLine(sink, i) -> string | null     the kept text of line i (null: not kept, or i outside [0, n))
 *   appendTraceLine(sink, line)             append a line (C-14: the twin's `V <json>` verdict line)
 *   setTraceStep(sink, step)                the script step stamped on lines written from now on (int32). exec.mjs
 *                                           runWorld has no per-step hook: B's twin runner drives this.
 *   firstTraceDiff(a, b) -> index | -1      the first line whose (h1, h2) differ; equal prefixes of unequal length
 *                                           -> the shorter n; -1 when n and every hash agree (checkTrace calls it)
 *
 * Every export throws TypeError on a value that is not a sink from makeTraceSink. COLD module: never on a measured
 * path (the line strings are built per call by design).
 */

const NONE = Symbol('none');
const INIT_LINES = 256;
export const MAX_LINES = 1 << 24;
const KEEP_KEYS = Object.freeze(['keep']);

/** Every sink makeTraceSink built (fail closed on a look-alike). */
const SINKS = new WeakSet();

/** A plain object: not null, not an array, prototype Object.prototype or null. */
function isPlain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
}

const isInt31 = (x) => Number.isInteger(x) && x >= 0 && x <= 0x7FFFFFFF;

function checkSink(sink, who) {
    if (!SINKS.has(sink)) throw new TypeError('trace: ' + who + ' needs a sink from makeTraceSink()');
}

/** opts undefined | { keep: 'all' | [lo, hi) | undefined }. TypeError on anything else. */
export function makeTraceSink(opts) {
    let keepAll = false;
    let lo = 0;
    let hi = 0;
    if (opts !== undefined) {
        if (!isPlain(opts)) throw new TypeError('trace: makeTraceSink(opts) opts must be a plain object');
        for (const k of Reflect.ownKeys(opts)) {
            if (KEEP_KEYS.indexOf(k) === -1) {
                const hint = typeof k === 'string' ? ' (did you mean keep?)' : '';   // one valid key
                throw new TypeError('trace: makeTraceSink opts key ' + String(k) + ' is not one of ' + KEEP_KEYS.join(', ') + hint);
            }
        }
        const keep = opts.keep;
        if (keep === 'all') keepAll = true;
        else if (Array.isArray(keep)) {
            if (keep.length !== 2 || !isInt31(keep[0]) || !isInt31(keep[1]) || keep[0] > keep[1]) {
                throw new TypeError('trace: makeTraceSink keep window must be [lo, hi) with integers 0 <= lo <= hi');
            }
            lo = keep[0];
            hi = keep[1];
        } else if (keep !== undefined) {
            throw new TypeError('trace: makeTraceSink keep must be \'all\', [lo, hi) or undefined');
        }
    }
    const sink = {
        n: 0,
        h1: new Int32Array(INIT_LINES),
        h2: new Int32Array(INIT_LINES),
        step: new Int32Array(INIT_LINES),
        cur: 0,
        keepAll,
        lo,
        hi,
        kept: keepAll || hi > lo ? [] : null,
    };
    SINKS.add(sink);
    return sink;
}

function grow(sink) {
    const cap = sink.h1.length;
    if (!(cap < MAX_LINES)) throw new RangeError('trace: sink is full (' + MAX_LINES + ' lines)');
    const nc = Math.min(MAX_LINES, cap + (cap >> 2));
    const a = new Int32Array(nc); a.set(sink.h1); sink.h1 = a;
    const b = new Int32Array(nc); b.set(sink.h2); sink.h2 = b;
    const s = new Int32Array(nc); s.set(sink.step); sink.step = s;
}

/** Reserve the next line index (stamped with the current step); its text arrives with fill(). */
function reserve(sink) {
    if (sink.n === sink.h1.length) grow(sink);
    const i = sink.n++;
    sink.step[i] = sink.cur;
    return i;
}

/** Hash `line` into slot i; keep its text when i is kept. */
function fill(sink, i, line) {
    let a = 0x811c9dc5 | 0;
    let b = (0x9747b28c ^ line.length) | 0;
    for (let k = 0; k < line.length; k++) {
        const ch = line.charCodeAt(k);
        a = Math.imul(a ^ ch, 0x01000193);
        b = Math.imul(b ^ ch, 0x5bd1e995);
        b ^= b >>> 15;
    }
    b ^= b >>> 13;
    b = Math.imul(b, 0x5bd1e995);
    b ^= b >>> 15;
    sink.h1[i] = a;
    sink.h2[i] = b;
    if (sink.kept !== null) {
        if (sink.keepAll) sink.kept[i] = line;
        else if (i >= sink.lo && i < sink.hi) sink.kept[i - sink.lo] = line;
    }
}

function put(sink, line) { fill(sink, reserve(sink), line); }

export function appendTraceLine(sink, line) {
    checkSink(sink, 'appendTraceLine');
    if (typeof line !== 'string') throw new TypeError('trace: appendTraceLine(sink, line) line must be a string');
    put(sink, line);
}

export function setTraceStep(sink, step) {
    checkSink(sink, 'setTraceStep');
    if (!Number.isInteger(step) || step < -0x80000000 || step > 0x7FFFFFFF) throw new TypeError('trace: setTraceStep step must be an int32');
    sink.cur = step | 0;
}

export function traceLine(sink, i) {
    checkSink(sink, 'traceLine');
    if (!Number.isInteger(i) || i < 0 || i >= sink.n || sink.kept === null) return null;
    let s;
    if (sink.keepAll) s = sink.kept[i];
    else if (i >= sink.lo && i < sink.hi) s = sink.kept[i - sink.lo];
    return typeof s === 'string' ? s : null;
}

export function firstTraceDiff(a, b) {
    checkSink(a, 'firstTraceDiff');
    checkSink(b, 'firstTraceDiff');
    const n = a.n < b.n ? a.n : b.n;
    const a1 = a.h1, a2 = a.h2, b1 = b.h1, b2 = b.h2;
    for (let i = 0; i < n; i++) if (a1[i] !== b1[i] || a2[i] !== b2[i]) return i;
    return a.n === b.n ? -1 : n;
}

function encVal(v, ordOf, depth) {
    const t = typeof v;
    if (v === undefined) return 'u';
    if (v === null) return 'null';
    if (t === 'number') return Object.is(v, -0) ? 'n:-0' : 'n:' + String(v);
    if (t === 'string') return 's:' + JSON.stringify(v);
    if (t === 'boolean') return 'b:' + v;
    if (t === 'bigint') return 'g:' + v;
    if (t === 'symbol') return 'y:' + String(v.description);
    if (t === 'function' || t === 'object') {
        const o = ordOf(v);
        if (o !== -1) return '#' + o;
        if (t === 'function') return 'fn';
        if (v instanceof Error) return 'err:' + v.constructor.name + ':' + JSON.stringify(String(v.message));
        if ((depth | 0) > 3) return 'obj..';
        if (Array.isArray(v)) return '[' + v.map((x) => encVal(x, ordOf, (depth | 0) + 1)).join(',') + ']';
        const ks = Object.keys(v).sort();
        return '{' + ks.map((k) => k + ':' + encVal(v[k], ordOf, (depth | 0) + 1)).join(',') + '}';
    }
    return '?' + t;
}

/** The traced adapter: ad's name / version / files / knownAs / caps (and mode, when ad has one); open() traces. */
export function traceAdapter(ad, sink) {
    if (ad === null || typeof ad !== 'object' || typeof ad.open !== 'function') throw new TypeError('trace: traceAdapter(ad, sink) ad must be an adapter');
    checkSink(sink, 'traceAdapter');
    const out = {
        name: ad.name,
        version: ad.version,
        files: ad.files,
        knownAs: ad.knownAs,
        caps: ad.caps,
        open(o) {
            const w = ad.open(o);
            const ords = new WeakMap();
            let next = 0;
            let depth = 0;
            let bodyN = 0;
            const ordOf = (h) => { const n = ords.get(h); return n === undefined ? -1 : n; };
            const enc = (v) => encVal(v, ordOf, 0);
            const esc = (e) => { try { return JSON.stringify(w.normalizeEscape(e)); } catch (e2) { return 'unnormalizable:' + String(e2 && e2.message); } };
            const kindOf = (h) => (typeof h === 'function' ? 'callable' : (typeof h === 'object' && h !== null ? 'box' : 'none'));
            const wrapBody = (tag, fn) => {
                if (typeof fn !== 'function') return fn;
                const id = tag + bodyN++;
                return function (...a) {
                    put(sink, 'E ' + id + ' d' + depth);
                    depth++;
                    let r;
                    try { r = fn.apply(this, a); } catch (e) { depth--; put(sink, 'X ' + id + ' ! ' + esc(e)); throw e; }
                    depth--;
                    put(sink, 'X ' + id + ' = ' + enc(r));
                    return r;
                };
            };
            const call = (m, h, argsEnc, thunk, makesHandle) => {
                const ho = h === NONE ? '-' : (ordOf(h) === -1 ? '?' + kindOf(h) : '#' + ordOf(h));
                const line = 'C ' + m + ' ' + ho + ' ' + argsEnc;
                const at = reserve(sink);
                let r;
                try { r = thunk(); } catch (e) {
                    fill(sink, at, line + ' ! ' + esc(e));
                    throw e;
                }
                if (makesHandle && (typeof r === 'function' || (typeof r === 'object' && r !== null)) && !ords.has(r)) ords.set(r, next++);
                fill(sink, at, line + ' = ' + enc(r));
                return r;
            };
            const tw = {
                registry: w.registry,
                signal: (v, s) => call('signal', NONE, enc(v) + ' ' + (s === undefined ? 'u' : '{' + Object.keys(s).sort().join(',') + '}'), () => (s === undefined ? w.signal(v) : w.signal(v, s)), true),
                set: (h, v) => call('set', h, enc(v), () => w.set(h, v), false),
                read: (h) => call('read', h, '', () => w.read(h), false),
                peek: (h) => call('peek', h, '', () => w.peek(h), false),
                computed: (fn) => call('computed', NONE, '', () => w.computed(wrapBody('c', fn)), true),
                effect: (fn, eo) => call('effect', NONE, eo === undefined ? '' : 'opts', () => (eo === undefined ? w.effect(wrapBody('e', fn)) : w.effect(wrapBody('e', fn), eo)), true),
                batch: (fn) => call('batch', NONE, '', () => w.batch(wrapBody('b', fn)), false),
                untrack: (fn) => call('untrack', NONE, '', () => w.untrack(wrapBody('u', fn)), false),
                dispose: (h) => call('dispose', h, '', () => w.dispose(h), false),
                settle: () => call('settle', NONE, '', () => w.settle(), false),
                stats: () => call('stats', NONE, '', () => w.stats(), false),
                links: () => call('links', NONE, '', () => w.links(), false),
                lifecycle: (h, cbs) => call('lifecycle', h, '', () => w.lifecycle(h, {
                    onConnect: wrapBody('on', cbs && cbs.onConnect), onDisconnect: wrapBody('off', cbs && cbs.onDisconnect),
                }), true),
                normalizeEscape: (e) => w.normalizeEscape(e),
                close: () => call('close', NONE, '', () => w.close(), false),
                // S3 extension methods (contract.mjs EXT_METHODS): forwarded + traced; hook listener payloads are not
                hook: (fn) => call('hook', NONE, '', () => w.hook(fn), false),
                destroy: () => call('destroy', NONE, '', () => w.destroy(), false),
                createRoot: (fn) => call('createRoot', NONE, '', () => w.createRoot(wrapBody('r', fn)), false),
                runWithOwner: (h, fn) => call('runWithOwner', h, '', () => w.runWithOwner(h, wrapBody('o', fn)), false),
                getOwner: () => call('getOwner', NONE, '', () => w.getOwner(), false),
                onCleanup: (fn) => call('onCleanup', NONE, '', () => w.onCleanup(wrapBody('k', fn)), false),
                capacity: () => call('capacity', NONE, '', () => w.capacity(), false),
                update: (h, fn) => call('update', h, '', () => w.update(h, wrapBody('p', fn)), false),
            };
            if (typeof w.boxCounts === 'function') tw.boxCounts = () => w.boxCounts();
            return tw;
        },
    };
    if (Object.hasOwn(ad, 'mode')) out.mode = ad.mode;
    return Object.freeze(out);
}
