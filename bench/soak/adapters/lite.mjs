/**
 * @zakkster/lite-signal soak -- the callable lite adapter (SPEC-B v2 section 3.2). The kernel is whatever
 * kernel.mjs loaded (SOAK_KERNEL seam), so a mutant or control drives the same adapter.
 *
 * One world = one fresh registry (G10: maxNodes 4096, grow), so a world replays exactly from
 * (lane, worldSeed). The adapter remembers every handle it hands out, so close() can dispose everything
 * and report the residue O5 checks (0 nodes, 0 links).
 *
 * liteAdapterFor(kernel) builds the same adapter over ANOTHER kernel module (anatomy.mjs: the counter-
 * instrumented shadow engine). It keeps name 'lite' and shares version / files / knownAs / caps with liteAdapter:
 * exec.mjs keys the O6 creation prediction on the lite family (isLiteFamily: lite, lite-box) + knownAs(), so a
 * shadow under a name outside that family (or with its own identity) would predict differently and diverge from
 * the oracle world. openWorld(kernel, opts) is the one world factory both use (liteAdapter = liteAdapterFor(K)).
 *
 * SNAPSHOT (R8 B1, PLAN-R8-snapshot.md CURRENT R8-13 / R8-15):
 *   world.snapshot() -> registry.snapshot()     world.nodeId(h) -> registry.nodeId(h)
 *   open({ ..., from })   from = a plain object with exactly the own keys registry, snap, fnsById, handles (else
 *                         TypeError, before any registry is built). The world's registry is then
 *                         restoreOf(kernel, cfg, from) instead of kernel.createRegistry(cfg): kernel.restoreRegistry(cfg,
 *                         from) when the kernel has one (the lite-s3 / lite-box shims), else from.registry.restore(snap,
 *                         { fnsById, handles, config: cfg }) -- the SAME cfg a fresh open sends (G10 maxNodes 4096 + grow,
 *                         maxFlushPasses). Every restored handle (from.handles[id], filled by restore) is pushed into the
 *                         world's handle list in ascending id order, so close() disposes it like a created one.
 *   caps.snapshot         per kernel: one throwaway registry is probed at the kernel's first liteAdapterFor() (snapshot()
 *                         and restore() both functions); with caps.reset (RESET below) it picks the caps object. A probe that
 *                         throws reads as false (the cap is unverified: the lane SKIPs, which is CONFIG for lite). The
 *                         result is cached per kernel object, and a wrapper kernel registered with snapshotProbeAs(shim,
 *                         kernel) (lite-box's facade shim) reads its base kernel's probe: ONE extra createRegistry() per
 *                         base kernel per process (test/46 armAt2 counts createRegistry calls).
 *
 * RESET (C-RESET soak S2a):
 *   caps.reset            read from the SAME throwaway registry as caps.snapshot (one probe, so still ONE extra
 *                         createRegistry() per base kernel): true when it exposes reset() as a function. A throwing probe
 *                         reads both caps false; cached per kernel, and a snapshotProbeAs() wrapper reads its base's.
 *                         The (snapshot, reset) pair picks one of four frozen caps objects: CAPS_LITE (true, true),
 *                         CAPS_LITE_NO_SNAPSHOT (false, true), CAPS_LITE_NO_RESET (true, false), CAPS_LITE_PRE_RESET (false,
 *                         false: a pre-1.6.0 control such as controls/headpatched). The world method reset() is
 *                         adapters/lite-s3.mjs's (beside destroy(): contract.mjs EXT_METHODS.reset), not openWorld's.
 *   liteAdapterFor(kernel, opts)   opts undefined, or exactly { broken: 'snapshot-refire' | 'snapshot-stale' } (else
 *                         TypeError): must-fail shapes for test/101 / test/102 rows only (R8-5: the _mustfail teeth are
 *                         kernel patches). 'snapshot-refire' calls each restored effect body (fnsById[id]) once, in id
 *                         order, before open() returns; 'snapshot-stale' makes world.snapshot() return a snapshot whose
 *                         first clean computed / computedBox record has markEpoch decremented.
 *
 * COLD module: never on a measured path (zero-box law: the adapter is not a hot body).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { K, KERNEL_FILES, KERNEL_DIR, KERNEL_KNOWN_AS, CONTROLS_ERROR } from '../kernel.mjs';
import { normalizeEscape } from '../kinds.mjs';
import { nearest } from '../config.mjs';

export const CAPS_LITE = Object.freeze({
    effects: 'sync', batch: 'native', untrack: true, disposeSignal: true, disposeComputed: true, stopEffect: true,
    childEffects: 'parent-run', effectErrors: 'aggregate', equality: 'is', links: 'stats', lifecycle: 'register',
    hook: true, scheduler: true, owner: true, destroy: true, recycle: true, counters32: true, capacity: true,
    box: false, snapshot: true, reset: true,
});

/** The caps of a lite kernel whose registry has reset() but no snapshot() / restore(). */
export const CAPS_LITE_NO_SNAPSHOT = Object.freeze({ ...CAPS_LITE, snapshot: false });

/** The caps of a lite kernel whose registry has snapshot() / restore() but no reset(). */
export const CAPS_LITE_NO_RESET = Object.freeze({ ...CAPS_LITE, reset: false });

/** The caps of a lite kernel whose registry has neither snapshot() / restore() nor reset() (a pre-1.6.0 control). */
export const CAPS_LITE_PRE_RESET = Object.freeze({ ...CAPS_LITE, snapshot: false, reset: false });

/** probe bits -> caps object (bit 1 snapshot, bit 2 reset). */
const PROBE_SNAPSHOT = 1;
const PROBE_RESET = 2;
const CAPS_BY_PROBE = Object.freeze([CAPS_LITE_PRE_RESET, CAPS_LITE_NO_RESET, CAPS_LITE_NO_SNAPSHOT, CAPS_LITE]);

const FROM_KEYS = Object.freeze(['registry', 'snap', 'fnsById', 'handles']);
const OPT_KEYS = Object.freeze(['broken']);
const BROKEN = Object.freeze(['snapshot-refire', 'snapshot-stale']);

/** A plain object: not null, not an array, prototype Object.prototype or null. */
function isPlain(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
}

function hintOf(k, list) {
    const h = typeof k === 'string' ? nearest(k, list) : null;
    return h === null ? '' : ' (did you mean ' + h + '?)';
}

/**
 * liteAdapterFor opts -> the broken mode (null = clean). TypeError on anything but undefined |
 * { broken: 'snapshot-refire' | 'snapshot-stale' }. Exported for adapters/lite-s3.mjs (it forwards opts).
 */
export function snapshotBrokenOf(opts) {
    if (opts === undefined) return null;
    if (!isPlain(opts)) throw new TypeError('lite adapter: opts must be undefined or a plain object { broken }');
    for (const k of Reflect.ownKeys(opts)) {
        if (OPT_KEYS.indexOf(k) === -1) throw new TypeError('lite adapter: opts key ' + String(k) + ' is not one of ' + OPT_KEYS.join(', ') + hintOf(k, OPT_KEYS));
    }
    if (!Object.hasOwn(opts, 'broken')) throw new TypeError('lite adapter: opts must be { broken }; use undefined for a clean adapter');
    if (BROKEN.indexOf(opts.broken) === -1) {
        throw new TypeError('lite adapter: opts.broken ' + JSON.stringify(String(opts.broken)) + ' is not one of ' + BROKEN.join(', '));
    }
    return opts.broken;
}

/** open({ from }) -> from, or TypeError: a plain object with exactly FROM_KEYS, from.registry a registry. */
function checkFrom(from) {
    if (!isPlain(from)) throw new TypeError('lite adapter: open({ from }) must be a plain object { ' + FROM_KEYS.join(', ') + ' }');
    for (const k of Reflect.ownKeys(from)) {
        if (FROM_KEYS.indexOf(k) === -1) throw new TypeError('lite adapter: open({ from }) key ' + String(k) + ' is not one of ' + FROM_KEYS.join(', ') + hintOf(k, FROM_KEYS));
    }
    for (const k of FROM_KEYS) if (!Object.hasOwn(from, k)) throw new TypeError('lite adapter: open({ from }) is missing ' + k);
    const reg = from.registry;
    if (reg === null || typeof reg !== 'object' || typeof reg.snapshot !== 'function' || typeof reg.restore !== 'function') {
        throw new TypeError('lite adapter: open({ from }) from.registry is not a registry with snapshot() / restore()');
    }
    if (from.fnsById === null || typeof from.fnsById !== 'object') throw new TypeError('lite adapter: open({ from }) from.fnsById must be an object');
    if (from.handles === null || typeof from.handles !== 'object') throw new TypeError('lite adapter: open({ from }) from.handles must be an object');
    return from;
}

/**
 * The registry restored from `from` over the cfg chain: kernel.restoreRegistry(cfg, from) when the kernel (a shim)
 * has one, else from.registry.restore(snap, { fnsById, handles, config: cfg }).
 */
export function restoreOf(kernel, cfg, from) {
    if (typeof kernel.restoreRegistry === 'function') return kernel.restoreRegistry(cfg, from);
    return from.registry.restore(from.snap, { fnsById: from.fnsById, handles: from.handles, config: cfg });
}

/** The snapshot's node ids, ascending (restore validated them: unique int32 ids). */
function idsOf(snap) {
    const nodes = snap.nodes;
    const ids = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) ids[i] = nodes[i].id;
    return ids.sort((a, b) => a - b);
}

/** 'snapshot-stale': the first clean computed / computedBox record gets markEpoch - 1 (int32). */
function staleOf(snap) {
    const nodes = snap.nodes;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.clean === true && (n.kind === 'computed' || n.kind === 'computedBox')) { n.markEpoch = (n.markEpoch - 1) | 0; break; }
    }
    return snap;
}

/** kernel -> its cached probe bits (PROBE_SNAPSHOT | PROBE_RESET); wrapper kernel -> the base kernel whose probe it reads. */
const PROBE_BITS = new WeakMap();
const PROBE_AS = new WeakMap();

/**
 * Register `shim` (a wrapper kernel whose registries forward snapshot / restore and reset to `kernel`'s) to read
 * `kernel`'s caps.snapshot + caps.reset probe bits instead of probing a registry of its own. COLD; TypeError on a
 * non-object argument.
 */
export function snapshotProbeAs(shim, kernel) {
    if (shim === null || typeof shim !== 'object' || kernel === null || (typeof kernel !== 'object' && typeof kernel !== 'function')) {
        throw new TypeError('lite adapter: snapshotProbeAs(shim, kernel) needs two kernel objects');
    }
    PROBE_AS.set(shim, kernel);
}

/**
 * caps.snapshot + caps.reset probe: one throwaway registry exposes snapshot() and restore() (PROBE_SNAPSHOT) and
 * reset() (PROBE_RESET). A throw reads as 0 (both false). Cached.
 */
function probeBits(kernel) {
    const base = PROBE_AS.get(kernel);
    if (base !== undefined) return probeBits(base);
    const hit = PROBE_BITS.get(kernel);
    if (hit !== undefined) return hit;
    let bits = 0;
    try {
        const r = kernel.createRegistry();
        if (r !== null && typeof r === 'object') {
            if (typeof r.snapshot === 'function' && typeof r.restore === 'function') bits |= PROBE_SNAPSHOT;
            if (typeof r.reset === 'function') bits |= PROBE_RESET;
        }
    } catch {
        bits = 0;
    }
    PROBE_BITS.set(kernel, bits);
    return bits;
}

function kernelVersion() {
    for (const p of [join(KERNEL_DIR, 'package.json')]) {
        if (!existsSync(p)) continue;
        try { return String(JSON.parse(readFileSync(p, 'utf8')).version); } catch { return null; }
    }
    return null;
}

/** Escape normalization is engine-agnostic and lives in kinds.mjs (kernel-free, unit-tested). */
export { normalizeEscape };

function files() { return KERNEL_FILES; }

/**
 * The loaded kernel's controls.json name (kernel.mjs KERNEL_KNOWN_AS), or null for the tree / a scratch
 * kernel. exec.mjs keys the O6 creation prediction on it (exec stays kernel-free on import). Fails closed:
 * an unreadable controls.json throws, never reads as "not a control". ONE function object, shared by every
 * adapter liteAdapterFor() builds (a shadow engine reports the base kernel's identity).
 */
function knownAs() {
    if (CONTROLS_ERROR !== null) throw new Error('lite adapter: kernel identity unknown -- ' + CONTROLS_ERROR);
    return KERNEL_KNOWN_AS;
}

/**
 * One world over `kernel` (a module namespace exporting createRegistry). The former liteAdapter.open() body.
 * broken: null / undefined (clean) or a snapshotBrokenOf() mode.
 */
export function openWorld(kernel, opts, broken) {
        const o = opts || {};
        const from = o.from === undefined ? null : checkFrom(o.from);
        const cfg = { maxNodes: 4096, onCapacityExceeded: 'grow' };
        if (o.maxFlushPasses !== undefined && o.maxFlushPasses !== null) cfg.maxFlushPasses = o.maxFlushPasses;
        const r = from === null ? kernel.createRegistry(cfg) : restoreOf(kernel, cfg, from);
        const handles = [];
        const offs = [];
        if (from !== null) {
            const ids = idsOf(from.snap);
            for (let i = 0; i < ids.length; i++) {
                const h = from.handles[ids[i]];
                if (h === undefined) throw new Error('lite adapter: restore left no handle for node id ' + ids[i]);
                handles.push(h);
            }
            if (broken === 'snapshot-refire') {
                const nodes = from.snap.nodes;
                for (let i = 0; i < ids.length; i++) {
                    for (let j = 0; j < nodes.length; j++) {
                        if (nodes[j].id === ids[i] && nodes[j].kind === 'effect') { const fn = from.fnsById[ids[i]]; fn(); break; }
                    }
                }
            }
        }
        const stale = broken === 'snapshot-stale';
        return {
            registry: r,
            signal(v, sopts) { const h = sopts === undefined ? r.signal(v) : r.signal(v, sopts); handles.push(h); return h; },
            set(h, v) { h.set(v); },
            read(h) { return h(); },
            peek(h) { return h.peek(); },
            computed(fn) { const h = r.computed(fn); handles.push(h); return h; },
            effect(fn) { const h = r.effect(fn); handles.push(h); return h; },
            batch(fn) { return r.batch(fn); },
            untrack(fn) { return r.untrack(fn); },
            dispose(h) { r.dispose(h); },
            settle() {},
            stats() { return r.stats(); },
            links() { return r.stats().activeLinks; },
            lifecycle(h, cbs) { const off = r.observeObservers(h, cbs); offs.push(off); return off; },
            snapshot() { return stale ? staleOf(r.snapshot()) : r.snapshot(); },
            nodeId(h) { return r.nodeId(h); },
            normalizeEscape,
            close() {
                for (let i = 0; i < offs.length; i++) offs[i]();
                for (let i = handles.length - 1; i >= 0; i--) r.dispose(handles[i]);
                const s = r.stats();
                return { nodes: s.activeNodes, links: s.activeLinks, signals: s.signals, computeds: s.computeds, effects: s.effects };
            },
        };
}

/**
 * The lite adapter over `kernel`. Throws TypeError (before building anything) when kernel exports no
 * createRegistry() or opts is not undefined | { broken: 'snapshot-refire' | 'snapshot-stale' }. Frozen; name 'lite';
 * version / files / knownAs are liteAdapter's own; caps per the kernel's probe: CAPS_LITE, CAPS_LITE_NO_SNAPSHOT (no
 * snapshot() / restore()), CAPS_LITE_NO_RESET (no reset()) or CAPS_LITE_PRE_RESET (neither).
 */
export function liteAdapterFor(kernel, opts) {
    if (kernel === null || (typeof kernel !== 'object' && typeof kernel !== 'function') || typeof kernel.createRegistry !== 'function') {
        throw new TypeError('lite adapter: liteAdapterFor(kernel) needs a kernel module exporting createRegistry()');
    }
    const broken = snapshotBrokenOf(opts);
    return Object.freeze({
        name: 'lite',
        version: kernelVersion,
        files,
        knownAs,
        caps: CAPS_BY_PROBE[probeBits(kernel)],
        open(o) { return openWorld(kernel, o, broken); },
    });
}

export const liteAdapter = liteAdapterFor(K);
