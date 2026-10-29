/**
 * @zakkster/lite-signal soak -- the S3 DECORATOR adapter (S3-D1, R0). It wraps adapters/lite.mjs openWorld (which
 * stays byte-identical: it is calibration-pinned) and adds the S3 extension methods (contract.mjs EXT_METHODS) as
 * TOP-LEVEL world keys, forwarded to the world's own registry (w.registry):
 *
 *   hook(fn) -> off        registry.onGraphMutation(fn); the off is remembered for close()
 *   destroy()              registry.destroy()
 *   createRoot(fn), runWithOwner(h, fn), getOwner(), onCleanup(fn)   forwarded as they are
 *   effect(fn, opts)       opts undefined -> the inner effect(fn), the identical S1 path; otherwise
 *                          registry.effect(fn, opts) (own key scheduler only), the handle remembered for close()
 *   capacity()             the open-time capacity echo { maxNodes, maxLinks, onCapacityExceeded }
 *   update(h, fn)          h.update(fn), its return passed back (cap recycle; lanes/recycle.mjs rsupd, b137)
 *
 * open(opts): opts.capacity (own keys maxNodes / maxLinks / onCapacityExceeded, else TypeError) is merged OVER the
 * inner cfg by a shim kernel { createRegistry: cfg => kernel.createRegistry({...cfg, ...capacity}) }. Every world,
 * capacity or not, checks that stats() echoes the pool capacities it was built with (nodePoolCapacity, and
 * linkPoolCapacity when maxLinks was sent) and throws on a mismatch: a world the model does not describe never runs.
 * The policy is not visible in stats(); capacity() echoes the one sent.
 *
 * close(): the decorator's OWN lists first -- hook offs newest-first, then its own handles newest-first -- each
 * emptied, then the inner close() (whose residue is the world's).
 *
 * Every world method takes plain parameters, at most 2 (latency.mjs forwards two; no rest / default parameters).
 * Name 'lite' and version / files / knownAs / caps are liteAdapterFor(kernel)'s own (exec.mjs keys O6 (iii) on name
 * + knownAs()). Folded into lite.mjs at the next engine recut (S3-D1). COLD module.
 */

import { K } from '../kernel.mjs';
import { openWorld, liteAdapterFor } from './lite.mjs';

const CAPACITY_KEYS = Object.freeze(['maxNodes', 'maxLinks', 'onCapacityExceeded']);
const EFFECT_KEYS = Object.freeze(['scheduler']);

/** A plain object: not null, not an array, prototype Object.prototype or null. */
function isPlain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
}

/** opts.capacity as an own-key copy, or null when absent. TypeError on a non-plain object or an unknown key. */
function capacityOf(o) {
    if (!Object.hasOwn(o, 'capacity') || o.capacity === undefined) return null;
    const c = o.capacity;
    if (!isPlain(c)) throw new TypeError('lite-s3: open({ capacity }) must be a plain object');
    for (const k of Reflect.ownKeys(c)) {
        if (CAPACITY_KEYS.indexOf(k) === -1) throw new TypeError('lite-s3: open({ capacity }) key ' + String(k) + ' is not one of ' + CAPACITY_KEYS.join(', '));
    }
    const out = {};
    for (const k of CAPACITY_KEYS) if (Object.hasOwn(c, k)) out[k] = c[k];
    return out;
}

/** effect(fn, opts) opts: a plain object whose own keys are EFFECT_KEYS, scheduler a function. */
function checkEffectOpts(e) {
    if (!isPlain(e)) throw new TypeError('lite-s3: effect(fn, opts) opts must be a plain object');
    for (const k of Reflect.ownKeys(e)) {
        if (EFFECT_KEYS.indexOf(k) === -1) throw new TypeError('lite-s3: effect(fn, opts) key ' + String(k) + ' is not one of ' + EFFECT_KEYS.join(', '));
    }
    if (Object.hasOwn(e, 'scheduler') && typeof e.scheduler !== 'function') throw new TypeError('lite-s3: effect(fn, opts) scheduler must be a function');
}

/** One decorated world over `kernel`. */
function openS3World(kernel, opts) {
    const o = opts || {};
    const cap = capacityOf(o);
    let sent = null;
    const shim = { createRegistry(cfg) { sent = Object.assign({}, cfg, cap); return kernel.createRegistry(sent); } };
    const w = openWorld(shim, o);
    const r = w.registry;
    const s = r.stats();
    if (s.nodePoolCapacity !== sent.maxNodes || (sent.maxLinks !== undefined && s.linkPoolCapacity !== sent.maxLinks)) {
        throw new Error('lite-s3: unmodelled capacity echo -- sent maxNodes ' + sent.maxNodes + ' / maxLinks ' + sent.maxLinks +
            ', stats() reports nodePoolCapacity ' + s.nodePoolCapacity + ' / linkPoolCapacity ' + s.linkPoolCapacity);
    }
    const echo = Object.freeze({ maxNodes: s.nodePoolCapacity, maxLinks: s.linkPoolCapacity, onCapacityExceeded: sent.onCapacityExceeded });
    const handles = [];
    const offs = [];
    return {
        ...w,
        effect(fn, eopts) {
            if (eopts === undefined) return w.effect(fn);
            checkEffectOpts(eopts);
            const h = r.effect(fn, eopts);
            handles.push(h);
            return h;
        },
        hook(fn) { const off = r.onGraphMutation(fn); offs.push(off); return off; },
        destroy() { r.destroy(); },
        createRoot(fn) { return r.createRoot(fn); },
        runWithOwner(h, fn) { return r.runWithOwner(h, fn); },
        getOwner() { return r.getOwner(); },
        onCleanup(fn) { r.onCleanup(fn); },
        capacity() { return echo; },
        update(h, fn) { return h.update(fn); },
        close() {
            for (let i = offs.length - 1; i >= 0; i--) offs[i]();
            offs.length = 0;
            for (let i = handles.length - 1; i >= 0; i--) r.dispose(handles[i]);
            handles.length = 0;
            return w.close();
        },
    };
}

/**
 * The decorator over `kernel`. Throws TypeError (before building anything, via liteAdapterFor) when kernel exports
 * no createRegistry(). Frozen; name 'lite'; version / files / knownAs / caps shared with liteAdapterFor(kernel).
 */
export function liteS3AdapterFor(kernel) {
    const base = liteAdapterFor(kernel);
    return Object.freeze({
        name: base.name,
        version: base.version,
        files: base.files,
        knownAs: base.knownAs,
        caps: base.caps,
        open(opts) { return openS3World(kernel, opts); },
    });
}

export const liteS3Adapter = liteS3AdapterFor(K);
