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
 * exec.mjs keys the O6 creation prediction on name === 'lite' + knownAs(), so a shadow under any other name (or
 * with its own identity) would predict differently and diverge from the oracle world. openWorld(kernel, opts) is
 * the one world factory both use (liteAdapter = liteAdapterFor(K)).
 *
 * COLD module: never on a measured path (zero-box law: the adapter is not a hot body).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { K, KERNEL_FILES, KERNEL_DIR, KERNEL_KNOWN_AS, CONTROLS_ERROR } from '../kernel.mjs';
import { normalizeEscape } from '../kinds.mjs';

export const CAPS_LITE = Object.freeze({
    effects: 'sync', batch: 'native', untrack: true, disposeSignal: true, disposeComputed: true, stopEffect: true,
    childEffects: 'parent-run', effectErrors: 'aggregate', equality: 'is', links: 'stats', lifecycle: 'register',
    hook: true, scheduler: true, owner: true, destroy: true, recycle: true, counters32: true, capacity: true,
    box: false, snapshot: false,
});

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

/** One world over `kernel` (a module namespace exporting createRegistry). The former liteAdapter.open() body. */
export function openWorld(kernel, opts) {
        const o = opts || {};
        const cfg = { maxNodes: 4096, onCapacityExceeded: 'grow' };
        if (o.maxFlushPasses !== undefined && o.maxFlushPasses !== null) cfg.maxFlushPasses = o.maxFlushPasses;
        const r = kernel.createRegistry(cfg);
        const handles = [];
        const offs = [];
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
 * createRegistry(). Frozen; name 'lite'; version / files / knownAs / caps are liteAdapter's own.
 */
export function liteAdapterFor(kernel) {
    if (kernel === null || (typeof kernel !== 'object' && typeof kernel !== 'function') || typeof kernel.createRegistry !== 'function') {
        throw new TypeError('lite adapter: liteAdapterFor(kernel) needs a kernel module exporting createRegistry()');
    }
    return Object.freeze({
        name: 'lite',
        version: kernelVersion,
        files,
        knownAs,
        caps: CAPS_LITE,
        open(opts) { return openWorld(kernel, opts); },
    });
}

export const liteAdapter = liteAdapterFor(K);
