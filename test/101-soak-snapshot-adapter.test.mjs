/**
 * test/101 -- R8 B1: the soak adapters' snapshot / restore surface (PLAN-R8-snapshot.md CURRENT R8-1, R8-13, R8-15;
 * GROUP B tasks 1-3, ASSERTIONS 3 / 6 adapter parts).
 *
 *   world.snapshot() -> registry.snapshot(); world.nodeId(h) -> registry.nodeId(h)
 *   open({ from: { registry, snap, fnsById, handles } }) -> a world over the restored registry, built through the
 *     same cfg chain as a fresh open (maxNodes 4096 + grow; lite-s3 capacity merge + echo check; lite-box facade)
 *   caps.snapshot from a per-kernel probe; liteAdapterFor(kernel, { broken: 'snapshot-refire' | 'snapshot-stale' })
 *
 * The adapter modules are imported as namespaces, so on HEAD (no snapshot surface) every row fails on its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../bench/soak/adapters/lite.mjs';
import * as S from '../bench/soak/adapters/lite-s3.mjs';
import * as B from '../bench/soak/adapters/lite-box.mjs';
import { K } from '../bench/soak/kernel.mjs';
import * as HP from '../bench/soak/controls/headpatched/Signal.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const ADAPTERS = [
    ['lite', () => L.liteAdapter],
    ['lite-s3', () => S.liteS3Adapter],
    ['lite-box all', () => B.liteBoxAdapter],
    ['lite-box alt', () => B.liteBoxAltAdapter],
];

/* ---- a fixed graph: 3 signals, 3 computeds (c5 never read), 2 effects ----------------------------------- */

const KIND = ['s', 's', 's', 'c', 'c', 'c', 'e', 'e'];
const INIT = [1, 2, 'x'];

/** A tracked read of a callable or box handle, world-free (a refired body runs before open() returns its world). */
const rd = (h) => (typeof h === 'function' ? h() : h.get());

/** Bodies over get(i): the handle of graph index i in THIS world. */
function bodies(get, runs) {
    return [null, null, null,
        () => rd(get(0)) + rd(get(1)),
        () => rd(get(3)) * 2,
        () => String(rd(get(2))) + rd(get(4)),
        () => { runs[0]++; rd(get(4)); },
        () => { runs[0]++; rd(get(1)); }];
}

function build(ad, opts) {
    const W = { w: ad.open(opts) };
    const T = [];
    const runs = [0];
    const BD = bodies((i) => T[i], runs);
    for (let i = 0; i < KIND.length; i++) {
        T.push(KIND[i] === 's' ? W.w.signal(INIT[i]) : KIND[i] === 'c' ? W.w.computed(BD[i]) : W.w.effect(BD[i]));
    }
    W.w.read(T[3]);
    W.w.set(T[0], 5);                      // both effects ran; c3 / c4 re-evaluated -> clean
    return { W, T, runs };
}

/** snapshot src, open({ from }) on `ad`; registry defaults to src's own. */
function restoreFrom(ad, src, extra, registry) {
    const snap = src.W.w.snapshot();
    const ids = src.T.map((h) => src.W.w.nodeId(h));
    const W = { w: null };
    const H = {};
    const runs = [0];
    const BD = bodies((i) => H[ids[i]], runs);
    const fns = {};
    for (let i = 0; i < KIND.length; i++) if (BD[i] !== null) fns[ids[i]] = BD[i];
    const from = { registry: registry === undefined ? src.W.w.registry : registry, snap, fnsById: fns, handles: H };
    const runsAtOpen = [0];
    const prev = runs[0];
    W.w = ad.open({ ...(extra || {}), from });
    runsAtOpen[0] = runs[0] - prev;
    const T = ids.map((id) => H[id]);
    return { W, T, runs, snap, ids, H, runsAtOpen: runsAtOpen[0] };
}

/** A from.registry stand-in: the real registry's snapshot / restore, the restored registry traced on dispose. */
function tracedRegistry(real, seen) {
    return {
        snapshot: real.snapshot,
        restore(snap, o) {
            seen.config = { ...o.config };
            seen.restores++;
            const r = real.restore(snap, o);
            return { ...r, dispose(h) { seen.disposed.push(r.nodeId(h)); r.dispose(h); } };
        },
    };
}

/* ---- 1. caps ------------------------------------------------------------------------------------------------ */

test('caps.snapshot: true on every tree adapter; CAPS_LITE.snapshot true, CAPS_LITE_NO_SNAPSHOT the same caps with false', () => {
    for (const [name, ad] of ADAPTERS) assert.equal(ad().caps.snapshot, true, name);
    assert.equal(L.CAPS_LITE.snapshot, true);
    assert.deepEqual(L.CAPS_LITE_NO_SNAPSHOT, { ...L.CAPS_LITE, snapshot: false });
    assert.ok(Object.isFrozen(L.CAPS_LITE_NO_SNAPSHOT));
    assert.equal(S.liteS3Adapter.caps, L.liteAdapter.caps, 'lite-s3 shares lite caps (identity)');
    assert.equal(B.liteBoxAdapter.caps, B.CAPS_LITE_BOX);
    assert.deepEqual(B.CAPS_LITE_BOX, { ...L.CAPS_LITE, box: true });
});

test('caps.snapshot false: the headpatched control kernel (no snapshot()), a stub registry, a throwing probe', () => {
    assert.equal(typeof HP.createRegistry().snapshot, 'undefined', 'fixture: headpatched has no snapshot()');
    assert.equal(L.liteAdapterFor(HP).caps, L.CAPS_LITE_NO_SNAPSHOT);
    assert.equal(S.liteS3AdapterFor(HP).caps.snapshot, false);
    assert.equal(B.liteBoxAdapterFor(HP, 'all').caps.snapshot, false);
    assert.equal(B.liteBoxAdapterFor(HP, 'all').caps.box, true);
    const noRestore = { createRegistry(c) { const r = K.createRegistry(c); const o = { ...r }; delete o.restore; return o; } };
    assert.equal(L.liteAdapterFor(noRestore).caps.snapshot, false, 'snapshot() without restore() is not the cap');
    const noSnap = { createRegistry(c) { const r = K.createRegistry(c); const o = { ...r }; delete o.snapshot; return o; } };
    assert.equal(L.liteAdapterFor(noSnap).caps.snapshot, false);
    assert.equal(L.liteAdapterFor({ createRegistry() { throw new Error('boom'); } }).caps.snapshot, false);
    assert.equal(L.liteAdapterFor({ createRegistry: K.createRegistry }).caps, L.CAPS_LITE);
});

test('caps.snapshot probe: ONE createRegistry() per base kernel for lite + lite-s3 + lite-box all + alt (cached; the lite-box shim reads its base), none per open', () => {
    let n = 0;
    const kernel = { createRegistry(c) { n++; return K.createRegistry(c); } };
    const ads = [L.liteAdapterFor(kernel), S.liteS3AdapterFor(kernel), B.liteBoxAdapterFor(kernel, 'all'), B.liteBoxAdapterFor(kernel, 'alt'),
        L.liteAdapterFor(kernel, { broken: 'snapshot-stale' })];
    assert.equal(n, 1, 'test/46 armAt2 counts createRegistry calls: the probe adds exactly one per kernel');
    for (const ad of ads) assert.equal(ad.caps.snapshot, true);
    ads[0].open({}).close();
    assert.equal(n, 2, 'open() builds its own registry, no second probe');
    assert.throws(() => L.snapshotProbeAs(null, kernel), TypeError);
    assert.throws(() => L.snapshotProbeAs({}, 7), TypeError);
});

/* ---- 2. snapshot -> open({ from }) per adapter ------------------------------------------------------------ */

for (const [name, ad] of ADAPTERS) {
    test(name + ': world.snapshot() / nodeId(h) forward to the registry; open({from}) restores ids, values, no body run', () => {
        const src = build(ad());
        const w = src.W.w;
        const ids = src.T.map((h) => w.nodeId(h));
        assert.deepEqual(ids, ids.map((_, i) => w.registry.nodeId(src.T[i])));
        assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.deepEqual(w.snapshot(), w.registry.snapshot());
        const r = restoreFrom(ad(), src);
        const w2 = r.W.w;
        assert.equal(r.runsAtOpen, 0, 'no effect body ran during open({from})');
        assert.deepEqual(w2.snapshot(), r.snap, 'snapshot(restore(S)) deepEquals S (taken before any read)');
        for (let i = 0; i < KIND.length; i++) {
            assert.notEqual(r.T[i], undefined, 'handles[' + r.ids[i] + '] filled');
            assert.equal(w2.nodeId(r.T[i]), r.ids[i], 'nodeId maps restored handle ' + i);
        }
        for (let i = 0; i < 6; i++) assert.equal(w2.peek(r.T[i]), w.peek(src.T[i]), 'value of node ' + i);
        assert.equal(w2.stats().nodePoolCapacity, 4096);
        if (typeof w2.capacity === 'function') assert.deepEqual(w2.capacity(), { maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: 'grow' });
        if (name.startsWith('lite-box')) assert.deepEqual(w2.boxCounts(), { box: 0, callable: 0, crossRead: 0 }, 'a restored world starts a fresh counter block');
        w2.set(r.T[0], 7);
        assert.equal(r.runs[0], 1, 'the effect reading c4 re-runs on the next write (c4 = (7 + 2) * 2)');
        assert.equal(w2.read(r.T[4]), 18);
        assert.deepEqual(w.close(), { nodes: 0, links: 0, signals: 0, computeds: 0, effects: 0 });
        assert.deepEqual(w2.close(), { nodes: 0, links: 0, signals: 0, computeds: 0, effects: 0 }, 'close() disposed every restored handle');
    });

    test(name + ': the restored registry is built with the open cfg (maxNodes 4096 + grow, maxFlushPasses) and close() disposes restored handles in id order', () => {
        const src = build(ad());
        const seen = { config: null, restores: 0, disposed: [] };
        const r = restoreFrom(ad(), src, { maxFlushPasses: 8 }, tracedRegistry(src.W.w.registry, seen));
        assert.equal(seen.restores, 1);
        assert.deepEqual(seen.config, { maxNodes: 4096, onCapacityExceeded: 'grow', maxFlushPasses: 8 });
        const w2 = r.W.w;
        for (let i = 0; i < 4100; i++) w2.signal(i);   // grow: past 4096 nodes without a CapacityError
        assert.ok(w2.stats().nodePoolCapacity > 4096, 'grow policy reached the restored registry');
        seen.disposed.length = 0;
        const res = w2.close();
        assert.equal(res.nodes, 0);
        const restored = seen.disposed.filter((id) => id <= 8);
        assert.deepEqual(restored, [8, 7, 6, 5, 4, 3, 2, 1], 'restored handles pushed in ascending id order (closed newest-first)');
        assert.deepEqual(src.W.w.close(), { nodes: 0, links: 0, signals: 0, computeds: 0, effects: 0 });
    });
}

test('restored handles are pushed in ascending id order even when pool-slot order differs (recycled slot)', () => {
    const w = L.liteAdapter.open({}); w.signal(1); const b = w.signal(2); w.signal(3); w.dispose(b); w.signal(4);
    const snap = w.snapshot();
    assert.deepEqual(snap.nodes.map((n) => n.id), [1, 4, 3], 'fixture: slot order is not id order');
    const seen = { config: null, restores: 0, disposed: [] };
    const w2 = L.liteAdapter.open({ from: { registry: tracedRegistry(w.registry, seen), snap, fnsById: {}, handles: {} } });
    w2.close();
    assert.deepEqual(seen.disposed, [4, 3, 1]);
    w.close();
});

test('lite-s3: open({capacity, from}) merges the capacity into the restore config and echo-checks the RESTORED registry', () => {
    const src = build(S.liteS3Adapter);
    const seen = { config: null, restores: 0, disposed: [] };
    const r = restoreFrom(S.liteS3Adapter, src, { capacity: { maxNodes: 64, maxLinks: 256, onCapacityExceeded: 'throw' } }, tracedRegistry(src.W.w.registry, seen));
    assert.deepEqual(seen.config, { maxNodes: 64, onCapacityExceeded: 'throw', maxLinks: 256 });
    assert.deepEqual(r.W.w.capacity(), { maxNodes: 64, maxLinks: 256, onCapacityExceeded: 'throw' });
    assert.equal(r.W.w.stats().nodePoolCapacity, 64);
    r.W.w.close();
    const lying = {
        snapshot: src.W.w.registry.snapshot,
        restore(snap, o) { const x = src.W.w.registry.restore(snap, o); return { ...x, stats() { const s = x.stats(); return { ...s, nodePoolCapacity: s.nodePoolCapacity + 1 }; } }; },
    };
    assert.throws(() => restoreFrom(S.liteS3Adapter, src, undefined, lying), /capacity echo/);
    assert.throws(() => restoreFrom(B.liteBoxAdapter, build(B.liteBoxAdapter), undefined, lying), /capacity echo/, 'lite-box rides the lite-s3 echo too');
    src.W.w.close();
});

test('a kernel with restoreRegistry(cfg, from) is used instead of from.registry.restore', () => {
    const calls = [];
    const kernel = {
        createRegistry: K.createRegistry,
        restoreRegistry(cfg, from) { calls.push({ ...cfg }); return from.registry.restore(from.snap, { fnsById: from.fnsById, handles: from.handles, config: cfg }); },
    };
    const ad = L.liteAdapterFor(kernel);
    const src = build(ad);
    const r = restoreFrom(ad, src);
    assert.deepEqual(calls, [{ maxNodes: 4096, onCapacityExceeded: 'grow' }]);
    assert.equal(r.W.w.read(r.T[4]), 14);
    r.W.w.close();
    src.W.w.close();
});

/* ---- 3. malformed from / opts ------------------------------------------------------------------------------ */

for (const [name, ad] of ADAPTERS) {
    test(name + ': open({from}) TypeError before any registry is built -- non-plain, extra key, missing snap, non-registry', () => {
        const src = build(ad());
        const snap = src.W.w.snapshot();
        const real = src.W.w.registry;
        let restores = 0;
        const reg = { snapshot: real.snapshot, restore(s, o) { restores++; return real.restore(s, o); } };
        const ok = () => ({ registry: reg, snap, fnsById: {}, handles: {} });
        class Box { constructor() { Object.assign(this, ok()); } }
        const bad = [
            ['non-plain (array)', [reg, snap, {}, {}]],
            ['non-plain (class instance)', new Box()],
            ['null', null],
            ['extra key', { ...ok(), config: {} }],
            ['missing snap', (() => { const f = ok(); delete f.snap; return f; })()],
            ['non-registry ({})', { ...ok(), registry: {} }],
            ['non-registry (no restore)', { ...ok(), registry: { snapshot: real.snapshot } }],
            ['fnsById null', { ...ok(), fnsById: null }],
            ['handles 0', { ...ok(), handles: 0 }],
            ['Symbol key', { ...ok(), [Symbol('x')]: 1 }],
        ];
        for (const [label, from] of bad) {
            assert.throws(() => ad().open({ from }), TypeError, label);
        }
        assert.equal(restores, 0, 'no restore() reached');
        assert.throws(() => ad().open({ from: { ...ok(), handle: {} } }), /did you mean handles/);
        src.W.w.close();
    });
}

test('liteAdapterFor / liteS3AdapterFor opts: undefined or exactly { broken: snapshot-refire | snapshot-stale }, else TypeError', () => {
    for (const f of [(o) => L.liteAdapterFor(K, o), (o) => S.liteS3AdapterFor(K, o)]) {
        assert.throws(() => f({ broken: 'x' }), TypeError);
        assert.throws(() => f({ broken: 'snapshot-refire', y: 1 }), TypeError);
        assert.throws(() => f([]), TypeError);
        assert.throws(() => f(null), TypeError);
        assert.throws(() => f({}), TypeError);
        assert.throws(() => f({ brokn: 'snapshot-stale' }), /did you mean broken/);
        assert.equal(f(undefined).caps, L.CAPS_LITE);
        assert.equal(f({ broken: 'snapshot-refire' }).caps, L.CAPS_LITE);
        assert.equal(f({ broken: 'snapshot-stale' }).name, 'lite');
    }
    assert.throws(() => L.liteAdapterFor({}, { broken: 'x' }), /createRegistry/, 'kernel check first');
});

/* ---- 4. broken modes (test/101 / test/102 rows only) ------------------------------------------------------- */

test('broken snapshot-refire: every restored effect body runs once during open({from}); the clean adapter runs none', () => {
    for (const ad of [L.liteAdapterFor(K, { broken: 'snapshot-refire' }), S.liteS3AdapterFor(K, { broken: 'snapshot-refire' })]) {
        const src = build(ad);
        const r = restoreFrom(ad, src);
        assert.equal(r.runsAtOpen, 2, 'two effects, one run each');
        r.W.w.close();
        src.W.w.close();
    }
    const src = build(L.liteAdapter);
    assert.equal(restoreFrom(L.liteAdapter, src).runsAtOpen, 0);
});

test('broken snapshot-stale: world.snapshot() differs from registry.snapshot() at exactly the first clean computed markEpoch (- 1)', () => {
    for (const ad of [L.liteAdapterFor(K, { broken: 'snapshot-stale' }), S.liteS3AdapterFor(K, { broken: 'snapshot-stale' })]) {
        const src = build(ad);
        const a = src.W.w.snapshot();
        const b = src.W.w.registry.snapshot();
        const diffs = [];
        for (let i = 0; i < b.nodes.length; i++) {
            for (const k of Object.keys(b.nodes[i])) if (!Object.is(a.nodes[i][k], b.nodes[i][k]) && !Array.isArray(b.nodes[i][k])) diffs.push(b.nodes[i].id + '.' + k + ' ' + a.nodes[i][k] + ' ' + b.nodes[i][k]);
        }
        const first = b.nodes.find((n) => n.clean && (n.kind === 'computed' || n.kind === 'computedBox'));
        assert.deepEqual(diffs, [first.id + '.markEpoch ' + ((first.markEpoch - 1) | 0) + ' ' + first.markEpoch]);
        assert.equal(a.gv, b.gv);
        assert.equal(a.nextId, b.nextId);
        src.W.w.close();
    }
    const src = build(L.liteAdapter);
    assert.deepEqual(src.W.w.snapshot(), src.W.w.registry.snapshot(), 'the clean adapter returns the registry snapshot as is');
});

/* ---- 5. retention (child, --expose-gc) ---------------------------------------------------------------------- */

const RETENTION_SRC = `
import { createLeakTracker } from '@zakkster/lite-leak';
import { liteAdapter } from './bench/soak/adapters/lite.mjs';
import { liteS3Adapter } from './bench/soak/adapters/lite-s3.mjs';
import { liteBoxAdapter } from './bench/soak/adapters/lite-box.mjs';
const tr = createLeakTracker({ name: 't101' });
const settle = async () => {
    for (let t = 0; t < 40 && tr.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 20)); }
    return tr.size();
};
function world(ad, held) {
    const w = ad.open({});
    const a = w.signal(1), b = w.signal(2);
    const c = w.computed(() => w.read(a) + w.read(b));
    const e = w.effect(() => { w.read(c); });
    const snap = w.snapshot();
    const ids = [w.nodeId(a), w.nodeId(b), w.nodeId(c), w.nodeId(e)];
    const H = {};
    const W = { w: null };
    const fnsById = {};
    fnsById[ids[2]] = () => W.w.read(H[ids[0]]) + W.w.read(H[ids[1]]);
    fnsById[ids[3]] = () => { W.w.read(H[ids[2]]); };
    W.w = ad.open({ from: { registry: w.registry, snap, fnsById, handles: H } });
    tr.track(w.registry, null, 'old');
    tr.track(W.w.registry, null, 'new');
    tr.track(snap, null, 'snap');
    if (held !== null) held.push(w.registry);
    w.close();
    W.w.set(H[ids[0]], 3);
    const v = W.w.read(H[ids[2]]);
    const res = W.w.close();
    return v === 5 && res.nodes === 0 && res.links === 0;
}
const sizes = [];
let worlds = 0, bad = 0;
gc();
for (let cycle = 0; cycle < 3; cycle++) {
    for (const ad of [liteAdapter, liteS3Adapter, liteBoxAdapter]) {
        for (let i = 0; i < 50; i++) { worlds++; if (!world(ad, null)) bad++; }
    }
    sizes.push(await settle());
}
const held = [];
for (let i = 0; i < 4; i++) world(liteAdapter, held);
const control = await settle();
console.log(JSON.stringify({ sizes, worlds, bad, control, held: held.length }));
`;

test('retention: 3 cycles x 50 worlds x (lite, lite-s3, lite-box) snapshot + restore -> tracker.size() 0 per cycle; held-registry control > 0', () => {
    const args = ['--expose-gc', '--max-old-space-size=256', '--input-type=module', '-e', RETENTION_SRC];
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
    const tail = String(r.stderr || '').split('\n').slice(-12).join('\n');
    assert.ok(r.status === 0 && r.signal === null, 'child exit ' + r.status + ' sig ' + r.signal + '\n' + tail);
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(o.worlds, 450);
    assert.equal(o.bad, 0, 'every restored world read 5 and closed to 0 nodes / 0 links');
    assert.deepEqual(o.sizes, [0, 0, 0], 'tracker.size() at each cycle close');
    assert.equal(o.held, 4);
    assert.equal(o.control, 4, 'control: the 4 held old registries stay tracked');
});
