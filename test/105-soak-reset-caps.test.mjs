/**
 * C-RESET soak S2a (PLAN-C-RESET-soak TASK 6, ADDENDUM 1 / 2 / 2b): the adapter + config side of registry.reset().
 *
 *   contract.mjs   CAPS.reset [true, false] (CAP_KEYS), EXT_METHODS.reset ['reset']
 *   lite.mjs       caps.reset probed on the SAME throwaway registry as caps.snapshot (one createRegistry() per base
 *                  kernel); the (snapshot, reset) pair picks CAPS_LITE / CAPS_LITE_NO_SNAPSHOT / CAPS_LITE_NO_RESET /
 *                  CAPS_LITE_PRE_RESET
 *   lite-s3.mjs    world.reset() -> registry.reset(); the hook off is idempotent (D-S5: a cold done flag)
 *   lite-box.mjs   reset forwarded by the lite-s3 world spread; caps.reset is the base kernel's
 *   config.mjs     LATENCY_UNTIMED += 'reset' (b155: an unclassified world method CRASHes an armed open)
 *
 * The adapter modules are imported as namespaces, so on HEAD (cf5a78f: no reset surface) every row fails on its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as CT from '../bench/soak/adapters/contract.mjs';
import * as L from '../bench/soak/adapters/lite.mjs';
import * as S from '../bench/soak/adapters/lite-s3.mjs';
import * as B from '../bench/soak/adapters/lite-box.mjs';
import { K } from '../bench/soak/kernel.mjs';
import { LATENCY_METHODS, LATENCY_UNTIMED } from '../bench/soak/config.mjs';
import { LatencyLane } from '../bench/soak/latency.mjs';
import * as HP from '../bench/soak/controls/headpatched/Signal.js';

const TREE = [
    ['lite', () => L.liteAdapter],
    ['lite-s3', () => S.liteS3Adapter],
    ['lite-box all', () => B.liteBoxAdapter],
    ['lite-box alt', () => B.liteBoxAltAdapter],
];
const WORLDS = TREE.slice(1);   // the adapters main loads (lite-s3 for SOAK_ENGINE=lite, lite-box): the reset world method

/** A small live graph: 2 signals, a computed over both, an effect over the computed (4 nodes, 3 links). */
function graphOn(w) {
    const a = w.signal(1);
    const b = w.signal(2);
    const c = w.computed(() => w.read(a) + w.read(b));
    w.effect(() => { w.read(c); });
}

/** A fixed op sequence (creation + a write) whose hook fires the rows count. */
function opsOn(w) {
    const d = w.signal(5);
    const e = w.computed(() => w.read(d) * 2);
    w.effect(() => { w.read(e); });
    w.set(d, 6);
}

/* ---- 1. contract ------------------------------------------------------------------------------------------- */

test('contract: CAPS.reset is [true, false] (frozen), CAP_KEYS lists reset last, EXT_METHODS.reset is [reset]', () => {
    assert.deepEqual(CT.CAPS.reset, [true, false]);
    assert.ok(Object.isFrozen(CT.CAPS.reset));
    assert.equal(CT.CAP_KEYS.length, 21);
    assert.equal(CT.CAP_KEYS[20], 'reset');
    assert.deepEqual(CT.EXT_METHODS.reset, ['reset']);
    assert.ok(Object.isFrozen(CT.EXT_METHODS.reset));
});

test('contract: validateAdapter accepts reset true / false, reports it missing or out of range', () => {
    const ad = (caps) => ({ name: 'x', version() {}, files() {}, open() {}, caps });
    assert.deepEqual(CT.validateAdapter(ad({ ...L.CAPS_LITE, reset: true })), []);
    assert.deepEqual(CT.validateAdapter(ad({ ...L.CAPS_LITE, reset: false })), []);
    const noReset = { ...L.CAPS_LITE };
    delete noReset.reset;
    assert.deepEqual(CT.validateAdapter(ad(noReset)), ['caps.reset is not declared']);
    assert.deepEqual(CT.validateAdapter(ad({ ...L.CAPS_LITE, reset: 'yes' })), ['caps.reset="yes" is not one of [true,false]']);
});

test('contract: validateWorld(w, caps, [reset]) demands world.reset only when the adapter declares the cap', () => {
    const w = S.liteS3Adapter.open({});
    try {
        const bare = { ...w };
        delete bare.reset;
        assert.deepEqual(CT.validateWorld(w, S.liteS3Adapter.caps, ['reset']), []);
        assert.deepEqual(CT.validateWorld(bare, S.liteS3Adapter.caps, ['reset']), ['world.reset must be a function (cap reset)']);
        assert.deepEqual(CT.validateWorld(bare, { ...S.liteS3Adapter.caps, reset: false }, ['reset']), [], 'a cap the adapter lacks is a SKIP');
    } finally { w.close(); }
});

/* ---- 2. caps.reset ------------------------------------------------------------------------------------------ */

test('caps.reset true on every tree adapter (live kernel); the four caps objects are frozen and differ only in snapshot / reset', () => {
    for (const [name, ad] of TREE) {
        assert.equal(ad().caps.reset, true, name);
        assert.deepEqual(CT.validateAdapter(ad()), [], name);
    }
    assert.equal(L.liteAdapter.caps, L.CAPS_LITE);
    assert.equal(S.liteS3Adapter.caps, L.CAPS_LITE, 'lite-s3 shares lite caps (identity)');
    assert.equal(B.liteBoxAdapter.caps, B.CAPS_LITE_BOX);
    assert.equal(B.CAPS_LITE_BOX.reset, true);
    assert.equal(L.CAPS_LITE.reset, true);
    assert.equal(L.CAPS_LITE.snapshot, true);
    assert.deepEqual(L.CAPS_LITE_NO_SNAPSHOT, { ...L.CAPS_LITE, snapshot: false });
    assert.deepEqual(L.CAPS_LITE_NO_RESET, { ...L.CAPS_LITE, reset: false });
    assert.deepEqual(L.CAPS_LITE_PRE_RESET, { ...L.CAPS_LITE, snapshot: false, reset: false });
    for (const c of [L.CAPS_LITE, L.CAPS_LITE_NO_SNAPSHOT, L.CAPS_LITE_NO_RESET, L.CAPS_LITE_PRE_RESET]) {
        assert.ok(Object.isFrozen(c));
        assert.deepEqual(Object.keys(c).sort(), CT.CAP_KEYS.slice().sort());
    }
});

test('caps.reset false: the headpatched control kernel (no reset()), a registry without reset, a throwing probe', () => {
    assert.equal(typeof HP.createRegistry().reset, 'undefined', 'fixture: headpatched has no reset()');
    assert.equal(L.liteAdapterFor(HP).caps, L.CAPS_LITE_PRE_RESET);
    assert.equal(S.liteS3AdapterFor(HP).caps.reset, false);
    const hb = B.liteBoxAdapterFor(HP, 'all').caps;
    assert.equal(hb.reset, false);
    assert.equal(hb.box, true);
    assert.deepEqual(CT.validateAdapter(L.liteAdapterFor(HP)), []);
    assert.deepEqual(CT.validateAdapter(B.liteBoxAdapterFor(HP, 'alt')), []);
    const noReset = { createRegistry(c) { const o = { ...K.createRegistry(c) }; delete o.reset; return o; } };
    assert.equal(L.liteAdapterFor(noReset).caps, L.CAPS_LITE_NO_RESET, 'snapshot kept, reset gone');
    const resetNotFn = { createRegistry(c) { return { ...K.createRegistry(c), reset: 1 }; } };
    assert.equal(L.liteAdapterFor(resetNotFn).caps.reset, false, 'a non-function reset is not the cap');
    const noSnapKeepsReset = { createRegistry(c) { const o = { ...K.createRegistry(c) }; delete o.snapshot; return o; } };
    assert.equal(L.liteAdapterFor(noSnapKeepsReset).caps, L.CAPS_LITE_NO_SNAPSHOT);
    assert.equal(L.liteAdapterFor({ createRegistry() { throw new Error('boom'); } }).caps, L.CAPS_LITE_PRE_RESET);
    assert.equal(L.liteAdapterFor({ createRegistry: K.createRegistry }).caps, L.CAPS_LITE);
});

test('caps.reset probe: shares caps.snapshot\'s ONE createRegistry() per base kernel (lite + lite-s3 + lite-box all + alt), none per open', () => {
    let n = 0;
    const kernel = { createRegistry(c) { n++; return K.createRegistry(c); } };
    const ads = [L.liteAdapterFor(kernel), S.liteS3AdapterFor(kernel), B.liteBoxAdapterFor(kernel, 'all'), B.liteBoxAdapterFor(kernel, 'alt')];
    assert.equal(n, 1);
    for (const ad of ads) { assert.equal(ad.caps.reset, true); assert.equal(ad.caps.snapshot, true); }
    let m = 0;
    const noReset = { createRegistry(c) { m++; const o = { ...K.createRegistry(c) }; delete o.reset; return o; } };
    const bds = [L.liteAdapterFor(noReset), S.liteS3AdapterFor(noReset), B.liteBoxAdapterFor(noReset, 'all')];
    assert.equal(m, 1);
    for (const ad of bds) { assert.equal(ad.caps.reset, false); assert.equal(ad.caps.snapshot, true); }
});

/* ---- 3. world.reset ----------------------------------------------------------------------------------------- */

test('world.reset() resets the registry: stats() gauges 0 after, close() residue 0 (lite-s3, lite-box all + alt)', () => {
    for (const [name, ad] of WORLDS) {
        const w = ad().open({});
        assert.equal(typeof w.reset, 'function', name);
        graphOn(w);
        const s0 = w.stats();
        assert.equal(s0.activeNodes, 4, name);
        assert.equal(s0.activeLinks, 3, name);
        w.reset();
        const s1 = w.stats();
        for (const k of ['signals', 'computeds', 'effects', 'activeNodes', 'activeLinks']) assert.equal(s1[k], 0, name + ' ' + k);
        assert.equal(s1.totalDisposals - s0.totalDisposals, 4, name + ' every live node disposed');
        assert.deepEqual(w.close(), { nodes: 0, links: 0, signals: 0, computeds: 0, effects: 0 }, name);
    }
});

test('world.reset forwards to registry.reset (not destroy): one call, and the registry stays usable after it', () => {
    for (const [name, ad] of WORLDS) {
        const w = ad().open({});
        const r = w.registry;
        const real = r.reset;
        let calls = 0;
        r.reset = function () { calls++; return real(); };
        try {
            graphOn(w);
            w.reset();
            assert.equal(calls, 1, name);
            const s = w.signal(7);
            assert.equal(w.read(s), 7, name);
            assert.equal(w.stats().activeNodes, 1, name);
        } finally {
            if (Object.hasOwn(r, 'reset') && Object.getPrototypeOf(r) !== Object.prototype) delete r.reset;
            else r.reset = real;
            w.close();
        }
    }
});

/* ---- 4. latency classification ------------------------------------------------------------------------------ */

test('LATENCY_UNTIMED lists reset; every function key of a lite-s3 / lite-box world is classified; an armed open passes reset through untimed', () => {
    assert.ok(LATENCY_UNTIMED.includes('reset'));
    assert.ok(!LATENCY_METHODS.includes('reset'));
    for (const [name, ad] of WORLDS) {
        const w = ad().open({});
        try {
            for (const k of Object.keys(w)) {
                if (typeof w[k] !== 'function') continue;
                assert.ok(LATENCY_METHODS.includes(k) || LATENCY_UNTIMED.includes(k), name + ': world method ' + k + ' unclassified');
            }
        } finally { w.close(); }
        const lane = new LatencyLane({ floorNs: 40 });
        lane.armed = true;
        const aw = lane.wrap(ad()).open({});
        try {
            graphOn(aw);
            aw.reset();
            assert.equal(aw.stats().activeNodes, 0, name);
        } finally { aw.close(); }
    }
});

/* ---- 5. idempotent hook off (D-S5) -------------------------------------------------------------------------- */

test('lite-s3 hook off is idempotent on the live kernel: twice, after reset(), after destroy(); a later hook (newest on the listener stack) fires exactly as on a fresh world', () => {
    const fw = S.liteS3Adapter.open({});
    let base = 0;
    fw.hook(() => base++);
    opsOn(fw);
    fw.close();
    assert.ok(base > 0, 'fixture: the op sequence mutates the graph');
    for (const how of ['twice', 'reset', 'destroy']) {
        for (const [name, ad] of WORLDS) {
            if (how === 'destroy' && name !== 'lite-s3') continue;   // destroy() ends the registry: one adapter suffices
            const w = ad().open({});
            let stale = 0;
            const off = w.hook(() => stale++);
            graphOn(w);
            if (how === 'destroy') {
                w.destroy();
                assert.doesNotThrow(() => { off(); off(); }, name + ' destroy: off after destroy');
                assert.doesNotThrow(() => w.close(), name + ' destroy: close() after destroy');
                continue;
            }
            if (how === 'reset') w.reset();
            off();
            off();
            const before = stale;
            let x = 0;
            const offX = w.hook(() => x++);
            off();   // a stale off after a newer hook (the engine's listener stack): must not pop it
            opsOn(w);
            assert.equal(stale, before, name + ' ' + how + ': the off listener stays off');
            assert.equal(x, base, name + ' ' + how + ': a later hook fires once per mutation');
            offX();
            offX();
            assert.doesNotThrow(() => w.close(), name + ' ' + how + ': close() re-calls every off');
        }
    }
});

test('lite-s3 hook off reaches the engine off at most once (a kernel whose off throws on a 2nd call): off twice, then close()', () => {
    let engineOffs = 0;
    const strict = {
        createRegistry(c) {
            const r = K.createRegistry(c);
            return {
                ...r,
                onGraphMutation(fn) {
                    const off = r.onGraphMutation(fn);
                    let n = 0;
                    return () => { engineOffs++; if (++n > 1) throw new Error('engine off called twice'); off(); };
                },
            };
        },
    };
    const ad = S.liteS3AdapterFor(strict);
    const w = ad.open({});
    const offA = w.hook(() => {});
    w.hook(() => {});
    offA();
    assert.doesNotThrow(() => offA());
    assert.doesNotThrow(() => w.close(), 'close() skips the already-called off');
    assert.equal(engineOffs, 2, 'each engine off called exactly once (A by the caller, B by close())');
    const w2 = ad.open({});
    w2.hook(() => {});
    w2.reset();
    assert.doesNotThrow(() => w2.close());
    assert.equal(engineOffs, 3);
});
