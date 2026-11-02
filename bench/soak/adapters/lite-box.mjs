/**
 * @zakkster/lite-signal soak -- the lite-box FACADE adapter (R7 group A, burst 144; PLAN-R7-box.md C-13, C-16). The
 * same kernel as adapters/lite-s3.mjs, driven through the NON-CALLABLE 1.5 API (registry.signalBox / computedBox),
 * so a world can be replayed on both forms and the traces compared (trace.mjs, the OT oracle, B's twin runner).
 *
 *   liteBoxAdapterFor(kernel, mode, opts?)   mode 'all' -> every signal / computed the world creates is a box;
 *                                            'alt' -> a box when the per-world creation ordinal is ODD (ordinal =
 *                                            0-based count of signal + computed creations in this world; effects are
 *                                            never boxes and take no ordinal)
 *   opts                                     undefined, or exactly { broken: 'box-untracked' }: the must-fail control
 *                                            (a box read() goes through peek(), UNTRACKED). Anything else TypeError.
 *   liteBoxAdapter = (K, 'all'), liteBoxAltAdapter = (K, 'alt'); CAPS_LITE_BOX = { ...CAPS_LITE, box: true } (no soak
 *   code branches on caps.box).
 *
 * HOW (facade, census r7-evidence/README.txt: 0 diffs / 200): lite-s3's world is reused UNCHANGED. It is opened over
 * a shim kernel whose createRegistry returns a FACADE (Object.create(realRegistry)) overriding signal / computed (box
 * per mode) and effect (body kind marker, below). lite.mjs openWorld pushes every handle the facade returns into its
 * closure-private handles[], so its close() disposes the boxes too (dispose resolves NODE_PTR) -- nothing pinned is
 * copied, and every lite-s3 extension method comes along (w.registry IS the facade; the real registry's methods are
 * closures, so the prototype forward needs no this). The world overrides read() only: a box is not callable
 * (h.get()); peek / set / update are the same method names on both kinds and stay lite-s3's.
 *
 * world.boxCounts() -> { box, callable, crossRead } (C-16; box-interop reads it): box / callable = signal + computed
 * handles created per kind; crossRead = read() calls inside a computed / effect body (untrack included) whose handle
 * kind differs from the body owner's kind (effects count as callable). The counters live in one Int32Array per world
 * (int32: a world's op budget is far below 2^31). No other coverage counting.
 *
 * SNAPSHOT (R8 B1, D-b154-4 passthrough): shimKernel.restoreRegistry(cfg, from) restores through lite.mjs restoreOf
 * (from.registry is the old world's facade; its restore() is the real registry's, by prototype) and wraps the fresh
 * registry in a NEW facade with a fresh counter block (restored handles are not creations: boxCounts starts at 0, and
 * the restored bodies are the caller's fnsById, unmarked). world.snapshot() / nodeId() come from lite.mjs through the
 * facade's prototype. caps = { ...base.caps, box: true }, so caps.snapshot is the base kernel's cached probe
 * (lite.mjs snapshotProbeAs: no registry of its own is built for it; CAPS_LITE_BOX for K).
 *
 * Name 'lite-box'; version / files / knownAs are lite's (liteAdapterFor(kernel): the kernel's identity). exec.mjs
 * keys the O6 (iii) creation prediction on the lite family (A2: isLiteFamily). COLD module: never on a measured path.
 */

import { K } from '../kernel.mjs';
import { CAPS_LITE, restoreOf, snapshotProbeAs } from './lite.mjs';
import { liteS3AdapterFor } from './lite-s3.mjs';

export const CAPS_LITE_BOX = Object.freeze({ ...CAPS_LITE, box: true });

const MODES = Object.freeze(['all', 'alt']);
const OPT_KEYS = Object.freeze(['broken']);
const BROKEN = Object.freeze(['box-untracked']);

// Int32Array slots of one world's counter block
const C_ORD = 0;        // next signal + computed creation ordinal
const C_BOX = 1;
const C_CALLABLE = 2;
const C_CROSS = 3;
const C_CUR = 4;        // kind of the innermost running computed / effect body: 0 none, 1 callable, 2 box
const C_SLOTS = 5;
const KIND_CALLABLE = 1;
const KIND_BOX = 2;

/** facade registry -> its world's counter block (set in createRegistry, read once per open()). */
const COUNTERS = new WeakMap();

/** A plain object: not null, not an array, prototype Object.prototype or null. */
function isPlain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
}

/** opts -> the broken mode (null = clean). TypeError on anything but undefined | { broken: 'box-untracked' }. */
function brokenOf(opts) {
    if (opts === undefined) return null;
    if (!isPlain(opts)) throw new TypeError('lite-box: opts must be undefined or a plain object { broken: \'box-untracked\' }');
    for (const k of Reflect.ownKeys(opts)) {
        if (OPT_KEYS.indexOf(k) === -1) {
            const hint = typeof k === 'string' ? ' (did you mean broken?)' : '';   // one valid key
            throw new TypeError('lite-box: opts key ' + String(k) + ' is not one of ' + OPT_KEYS.join(', ') + hint);
        }
    }
    if (!Object.hasOwn(opts, 'broken')) throw new TypeError('lite-box: opts must be { broken: \'box-untracked\' }; use undefined for a clean adapter');
    if (BROKEN.indexOf(opts.broken) === -1) {
        throw new TypeError('lite-box: opts.broken ' + JSON.stringify(String(opts.broken)) + ' is not one of ' + BROKEN.join(', '));
    }
    return opts.broken;
}

/** A body marked with its owner's kind for crossRead (the kernel calls bodies as (0, fn)(): no args, no this). */
function marked(c, kind, fn) {
    if (typeof fn !== 'function') return fn;
    return function () {
        const prev = c[C_CUR];
        c[C_CUR] = kind;
        try { return fn(); } finally { c[C_CUR] = prev; }
    };
}

/**
 * The facade adapter over `kernel`. Throws TypeError before building anything: a kernel without createRegistry(),
 * a mode outside MODES, bad opts.
 */
export function liteBoxAdapterFor(kernel, mode, opts) {
    if (kernel === null || (typeof kernel !== 'object' && typeof kernel !== 'function') || typeof kernel.createRegistry !== 'function') {
        throw new TypeError('lite-box: liteBoxAdapterFor(kernel) needs a kernel module exporting createRegistry()');
    }
    if (MODES.indexOf(mode) === -1) throw new TypeError('lite-box: mode must be one of ' + MODES.join(', ') + ', got ' + JSON.stringify(String(mode)));
    const broken = brokenOf(opts);
    const all = mode === 'all';
    const facadeOf = (real) => {
        const c = new Int32Array(C_SLOTS);
        const facade = Object.create(real);
        facade.signal = function (v, sopts) {
            const box = all || (c[C_ORD] & 1) === 1;
            c[C_ORD]++;
            if (box) {
                c[C_BOX]++;
                return sopts === undefined ? real.signalBox(v) : real.signalBox(v, sopts);
            }
            c[C_CALLABLE]++;
            return sopts === undefined ? real.signal(v) : real.signal(v, sopts);
        };
        facade.computed = function (fn, copts) {
            const box = all || (c[C_ORD] & 1) === 1;
            c[C_ORD]++;
            if (box) {
                c[C_BOX]++;
                const bfn = marked(c, KIND_BOX, fn);
                return copts === undefined ? real.computedBox(bfn) : real.computedBox(bfn, copts);
            }
            c[C_CALLABLE]++;
            const cfn = marked(c, KIND_CALLABLE, fn);
            return copts === undefined ? real.computed(cfn) : real.computed(cfn, copts);
        };
        facade.effect = function (fn, eopts) {
            const efn = marked(c, KIND_CALLABLE, fn);
            return eopts === undefined ? real.effect(efn) : real.effect(efn, eopts);
        };
        COUNTERS.set(facade, c);
        return facade;
    };
    const shimKernel = {
        createRegistry(cfg) { return facadeOf(kernel.createRegistry(cfg)); },
        restoreRegistry(cfg, from) { return facadeOf(restoreOf(kernel, cfg, from)); },
    };
    snapshotProbeAs(shimKernel, kernel);   // the facade inherits snapshot / restore: read the base kernel's probe
    const base = liteS3AdapterFor(shimKernel);
    const caps = base.caps === CAPS_LITE ? CAPS_LITE_BOX : Object.freeze({ ...base.caps, box: true });
    return Object.freeze({
        name: 'lite-box',
        mode,
        version: base.version,
        files: base.files,
        knownAs: base.knownAs,
        caps,
        open(o) {
            const w = base.open(o);
            const c = COUNTERS.get(w.registry);
            if (c === undefined) throw new Error('lite-box: world registry is not this adapter\'s facade');
            return {
                ...w,
                read(h) {
                    const cur = c[C_CUR];
                    if (typeof h === 'function') {
                        if (cur === KIND_BOX) c[C_CROSS]++;
                        return h();
                    }
                    if (cur === KIND_CALLABLE) c[C_CROSS]++;
                    return broken === null ? h.get() : h.peek();
                },
                boxCounts() { return { box: c[C_BOX], callable: c[C_CALLABLE], crossRead: c[C_CROSS] }; },
            };
        },
    });
}

export const liteBoxAdapter = liteBoxAdapterFor(K, 'all');
export const liteBoxAltAdapter = liteBoxAdapterFor(K, 'alt');
