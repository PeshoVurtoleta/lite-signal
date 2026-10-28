// 74-soak-s3-seam.test.mjs -- the S3 shared seam (burst 92, rung R0; .handoff/PLAN-0s-s3-r0.md ASSERTIONS 3-5).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// Written from the plan text, not from the implementation. Expected values are the plan's literals:
//   3  decorator (adapters/lite-s3.mjs): a stats() pool capacity that does not echo the cfg -> open() throws
//      /capacity echo/; close() order ext-offs -> own-disposes -> inner-close, the decorator's lists empty by the
//      inner call; validateWorld(lite.mjs world, caps, ['hook']) reports hook, the decorator world reports nothing
//   4  retention: 1000 decorator worlds x (3 hooks + 2 scheduler effects), lite-leak, child --expose-gc. Phase A
//      (the plan literal): worlds dropped, registries tracked -> tracker.size() 0, close() residue 0. Phase B
//      (teeth for close()): registries HELD (small caps 64/64, b124), the 5 callbacks per world tracked ->
//      tracker.size() 0 proves close() released every hook listener and scheduler. Child heap bounded by
//      CHILD_HEAP_MB; must-fail rows m-offs (sizeB 3000) / m-disp (sizeB 2000) run the same child source.
//      GC counts are the S1 registry's per-world cost (lite.mjs measures the same) and are not a decorator property -- dropped by D-R0-GC.
//   5  seam: LANE_INDEX 14 distinct values < 16, GRAPH 0 .. WIE 4 unchanged; a lane-owned op 'zz' is dispatched,
//      an unowned op throws the old 'exec: unknown op <o>'; checkEscape(pred, got, true) is a TypeError; every
//      fixMinusOne GAP cites a SPEC-B line holding its own `| <id> |` row (the old 467-477 refs are red)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { K } from '../bench/soak/kernel.mjs';
import { liteAdapter, CAPS_LITE } from '../bench/soak/adapters/lite.mjs';
import { liteS3Adapter, liteS3AdapterFor } from '../bench/soak/adapters/lite-s3.mjs';
import { validateWorld, EXT_METHODS } from '../bench/soak/adapters/contract.mjs';
import { LANE_INDEX, LANES, ROSTER, checkLaneIndex, laneByName } from '../bench/soak/lanes/index.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import * as O from '../bench/soak/oracles.mjs';
import { GAPS } from '../bench/soak/teeth.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SPEC_B = join(ROOT, 'audit/2026-10-07/verification/SPEC-B.md');

/* ---- ASSERTION 3: the decorator ------------------------------------------------------------------ */

/** A kernel whose registry reports nodePoolCapacity off by `dn` (0 = honest). */
function lyingKernel(dn) {
    return {
        createRegistry(cfg) {
            const r = K.createRegistry(cfg);
            return { ...r, stats() { const s = r.stats(); return { ...s, nodePoolCapacity: s.nodePoolCapacity + dn }; } };
        },
    };
}

/** A kernel whose registry reports linkPoolCapacity off by `dl` (0 = honest). */
function lyingLinks(dl) { return { createRegistry(cfg) { const r = K.createRegistry(cfg); return { ...r, stats() { const s = r.stats(); return { ...s, linkPoolCapacity: s.linkPoolCapacity + dl }; } }; } }; }

test('lite-s3: a stats() capacity that does not echo the cfg fails closed at open(); an honest one opens', () => {
    assert.throws(() => liteS3AdapterFor(lyingKernel(1)).open({ maxFlushPasses: 8 }), /capacity echo/);
    assert.throws(() => liteS3AdapterFor(lyingKernel(1)).open({ capacity: { maxNodes: 32, maxLinks: 4, onCapacityExceeded: 'throw' } }), /capacity echo/);
    assert.throws(() => liteS3AdapterFor(lyingLinks(1)).open({ capacity: { maxNodes: 32, maxLinks: 4 } }), /capacity echo/);
    assert.equal(liteS3AdapterFor(lyingLinks(1)).open({}).capacity().maxLinks, 16385, 'maxLinks not sent: the echo reports stats()');
    const w = liteS3AdapterFor(lyingKernel(0)).open({ capacity: { maxNodes: 32, maxLinks: 4, onCapacityExceeded: 'throw' } });
    assert.deepEqual(w.capacity(), { maxNodes: 32, maxLinks: 4, onCapacityExceeded: 'throw' });
    assert.deepEqual(w.close(), { nodes: 0, links: 0, signals: 0, computeds: 0, effects: 0 });
});

test('lite-s3: open({capacity}) accepts only own keys maxNodes / maxLinks / onCapacityExceeded (TypeError otherwise)', () => {
    assert.throws(() => liteS3Adapter.open({ capacity: { maxNode: 32 } }), TypeError);
    assert.throws(() => liteS3Adapter.open({ capacity: [] }), TypeError);
    assert.throws(() => liteS3Adapter.open({ capacity: { [Symbol('x')]: 1 } }), TypeError);
    assert.throws(() => liteS3Adapter.open({ capacity: Object.create({ maxNodes: 32 }) }), TypeError);
    assert.deepEqual(liteS3Adapter.open({}).capacity(), { maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: 'grow' });
});

test('lite-s3: shares name / version / files / knownAs / caps with the lite adapter', () => {
    for (const k of ['name', 'version', 'files', 'knownAs', 'caps']) assert.equal(liteS3Adapter[k], liteAdapter[k], k);
    assert.ok(Object.isFrozen(liteS3Adapter));
    assert.throws(() => liteS3AdapterFor({}), TypeError);
});

/** A kernel that logs the close-time calls: hook offs, disposes (own vs inner) and stats(). */
function tracedKernel(log, own) {
    return {
        createRegistry(cfg) {
            const r = K.createRegistry(cfg);
            return {
                ...r,
                onGraphMutation(fn) { const off = r.onGraphMutation(fn); return () => { log.push('ext-off'); off(); }; },
                dispose(h) { log.push(own.has(h) ? 'own-dispose' : 'inner-dispose'); r.dispose(h); },
                stats() { log.push('stats'); return r.stats(); },
            };
        },
    };
}
const PHASE = { 'ext-off': 'ext-offs', 'own-dispose': 'own-disposes', 'inner-dispose': 'inner-close', stats: 'inner-close' };
const phases = (log) => log.map((e) => PHASE[e]).filter((p, i, a) => i === 0 || a[i - 1] !== p);

test('lite-s3: close() runs ext-offs, then own-disposes, then the inner close; its own lists are empty by then', () => {
    const log = [];
    const own = new Set();
    const w = liteS3AdapterFor(tracedKernel(log, own)).open({ maxFlushPasses: 8 });
    const s = w.signal(1);
    w.effect(() => { s(); });                                       // effect(fn): the inner S1 path (inner-dispose)
    const q = [];
    for (let i = 0; i < 2; i++) own.add(w.effect(() => { s(); }, { scheduler: (t) => { q.push(t); } }));
    for (let i = 0; i < 3; i++) w.hook(() => {});
    log.length = 0;
    const r = w.close();
    assert.deepEqual(phases(log), ['ext-offs', 'own-disposes', 'inner-close']);
    assert.equal(log.filter((e) => e === 'ext-off').length, 3);
    assert.equal(log.filter((e) => e === 'own-dispose').length, 2);
    assert.equal(log.filter((e) => e === 'inner-dispose').length, 2, 'the signal and the plain effect');
    assert.deepEqual(r, { nodes: 0, links: 0, signals: 0, computeds: 0, effects: 0 });
    log.length = 0;
    w.close();
    assert.ok(log.indexOf('ext-off') === -1 && log.indexOf('own-dispose') === -1, 'the decorator lists were emptied: ' + log.join(','));
});

test('lite-s3: effect(fn, {scheduler}) forwards the scheduler; effect(fn, opts) rejects unknown keys', () => {
    const w = liteS3Adapter.open({ maxFlushPasses: 8 });
    const s = w.signal(1);
    const q = [];
    let runs = 0;
    w.effect(() => { s(); runs++; }, { scheduler: (t) => { q.push(t); } });
    assert.deepEqual([runs, q.length], [0, 1], 'the first run is handed to the scheduler too');
    s.set(2);
    assert.deepEqual([runs, q.length], [0, 1], 'one scheduler call per pending period');
    q[0]();
    assert.deepEqual([runs, q.length], [1, 1]);
    s.set(3);
    assert.deepEqual([runs, q.length], [1, 2]);
    assert.throws(() => w.effect(() => {}, { schedular: () => {} }), TypeError);
    assert.throws(() => w.effect(() => {}, { scheduler: 1 }), TypeError);
    assert.throws(() => w.effect(() => {}, null), TypeError);
    assert.throws(() => w.effect(() => {}, Object.create({ scheduler() {} })), TypeError);   // no own keys: only the isPlain check rejects it
    assert.deepEqual(w.close(), { nodes: 0, links: 0, signals: 0, computeds: 0, effects: 0 });
});

test('validateWorld: needsCaps [hook] -> the lite.mjs world reports hook, the decorator world nothing; 1-arg call unchanged', () => {
    const lw = liteAdapter.open({ maxFlushPasses: 8 });
    const dw = liteS3Adapter.open({ maxFlushPasses: 8 });
    assert.ok(validateWorld(lw, CAPS_LITE, ['hook']).some((p) => p.indexOf('hook') !== -1));
    assert.deepEqual(validateWorld(dw, CAPS_LITE, ['hook']), []);
    assert.deepEqual(validateWorld(dw, CAPS_LITE, Object.keys(EXT_METHODS)), []);
    assert.deepEqual(validateWorld(lw), []);
    assert.deepEqual(validateWorld(dw), []);
    assert.deepEqual(validateWorld(lw, { ...CAPS_LITE, hook: false }, ['hook']), [], 'a cap the adapter lacks is a SKIP, not a world defect');
    assert.throws(() => validateWorld(lw, CAPS_LITE), TypeError);
    assert.throws(() => validateWorld(lw, CAPS_LITE, ['hok']), TypeError);
    lw.close();
    dw.close();
});

test('lite-s3: every world method takes <= 2 plain parameters (latency.mjs forwards at most two)', () => {
    const w = liteS3Adapter.open({ maxFlushPasses: 8 });
    for (const [k, v] of Object.entries(w)) {
        if (typeof v !== 'function') continue;
        assert.ok(v.length <= 2, k + ' length ' + v.length);
        const head = String(v).slice(0, String(v).indexOf(')') + 1);
        assert.ok(head.indexOf('...') === -1 && head.indexOf('=') === -1, k + ' has a rest / default parameter: ' + head);
    }
    for (const m of ['hook', 'destroy', 'createRoot', 'runWithOwner', 'getOwner', 'onCleanup', 'capacity']) assert.equal(typeof w[m], 'function', m);
    w.close();
});

/* ---- ASSERTION 4: retention ------------------------------------------------------------------------ */
// Phase B opens every HELD world with SMALL_CAPS (a world uses 1 signal + 2 effects). Measured (U1-measure, node v26.8.2,
// b124): a held used+closed registry costs what a fresh one does, 2425.6 KB at the default caps (maxNodes 4096 /
// maxLinks 16384, eager pools, ~120 B/slot), scaling with the caps (2048/8192 1199.5 KB, 64/64 21.2 KB); 200 held =
// 473.7 MB, so 1000 held = ~2369 MB: the old child OOMs at --max-old-space-size=2048, passes at 3072, and macos-latest
// node 24 ci OOM'd it from its first run (9097cf0) on. Phase A (1000 dropped default-cap worlds): heap delta -0.7 MB.
// Phase A keeps the default caps.
// CHILD_HEAP_MB bounds the child heap below CI's (~7x the measured ~34 MB end heap), so a heap regression of this
// class OOMs locally first; the b124 old src (default-cap phase B) OOMs under it.
// Must-fail rows, through the same child source (argv[1]; 'none' = the gated path):
//   m-offs  the kernel's onGraphMutation returns a no-op off -> every hook stays listed: sizeB 3000 (3 x 1000)
//   m-disp  the kernel's dispose skips scheduler-effect handles -> each scheduler stays reachable from the held
//           registry's node pool: sizeB 2000 (2 x 1000); both effects stay live -> residue 1 per world, A and B

const CHILD_HEAP_MB = 256;
const RETENTION_SRC = `
import { createLeakTracker } from '@zakkster/lite-leak';
import { K } from './bench/soak/kernel.mjs';
import { liteS3Adapter, liteS3AdapterFor } from './bench/soak/adapters/lite-s3.mjs';
const MUTANT = process.argv[1];
const SMALL_CAPS = { maxNodes: 64, maxLinks: 64 };
function mutantKernel(m) {
    return {
        createRegistry(cfg) {
            const r = K.createRegistry(cfg);
            if (m === 'm-offs') return { ...r, onGraphMutation(fn) { r.onGraphMutation(fn); return () => {}; } };
            const sch = new WeakSet();
            return {
                ...r,
                effect(fn, o) { const h = o === undefined ? r.effect(fn) : r.effect(fn, o); if (o !== undefined) sch.add(h); return h; },
                dispose(h) { if (!sch.has(h)) r.dispose(h); },
            };
        },
    };
}
let A = null;
if (MUTANT === 'none') A = liteS3Adapter;
else if (MUTANT === 'm-offs' || MUTANT === 'm-disp') A = liteS3AdapterFor(mutantKernel(MUTANT));
else throw new Error('t74 child: unknown mutant ' + MUTANT);
const settle = async (tr) => { for (let t = 0; t < 40 && tr.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 20)); } return tr.size(); };
function world(i, tr, held) {
    const w = held === null ? A.open({ maxFlushPasses: 8 }) : A.open({ maxFlushPasses: 8, capacity: SMALL_CAPS });
    if (held === null) tr.track(w.registry, null, 'registry');
    else held.push(w.registry);
    const s = w.signal(i);
    const q = [];
    for (let j = 0; j < 3; j++) { const fn = () => {}; if (held !== null) tr.track(fn, null, 'hook'); w.hook(fn); }
    for (let j = 0; j < 2; j++) {
        const sch = (t) => { q.push(t); };
        if (held !== null) tr.track(sch, null, 'scheduler');
        w.effect(() => { s(); }, { scheduler: sch });
    }
    s.set(i + 1);
    for (const t of q) t();
    const r = w.close();
    return r.nodes === 0 && r.links === 0 ? 0 : 1;
}
const ta = createLeakTracker({ name: 't74-a' });
let residueA = 0;
gc();
await new Promise((r) => setTimeout(r, 20));
for (let i = 0; i < 1000; i++) residueA += world(i, ta, null);
const sizeA = await settle(ta);
const tb = createLeakTracker({ name: 't74-b' });
const held = [];
let residueB = 0;
for (let i = 0; i < 1000; i++) residueB += world(i, tb, held);
const sizeB = await settle(tb);
const heapMB = Math.round(process.memoryUsage().heapUsed / 1048576);
console.log(JSON.stringify({ mutant: MUTANT, sizeA, residueA, sizeB, residueB, held: held.length, heapMB }));
`;
const retention = new Map();
function retentionRun(mutant) {
    if (retention.has(mutant)) return retention.get(mutant);
    const r = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=' + CHILD_HEAP_MB, '--input-type=module', '-e', RETENTION_SRC, mutant],
        { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const err = String(r.stderr || '');
    const oom = /heap out of memory|near heap limit/.test(err) ? ' -- HEAP OOM over CHILD_HEAP_MB ' + CHILD_HEAP_MB : '';
    const tail = err.split('\n').filter((l) => !/^\s*\d+: 0x/.test(l)).slice(-12).join('\n');   // native stack frames dropped
    assert.ok(r.status === 0 && r.signal === null, 'retention child (' + mutant + ', --max-old-space-size=' + CHILD_HEAP_MB + ') exit ' + r.status +
        ' signal ' + r.signal + (r.error ? ' error ' + r.error.message : '') + oom + '\nstderr tail:\n' + tail);
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    retention.set(mutant, o);
    return o;
}

test('lite-s3 retention: 1000 worlds x (3 hooks + 2 scheduler effects) -> tracker.size() 0 and residue 0, dropped and held (child, --expose-gc, bounded heap)', () => {
    const o = retentionRun('none');
    assert.equal(o.mutant, 'none');
    assert.equal(o.residueA, 0, 'close() residue, phase A');
    assert.equal(o.sizeA, 0, 'phase A: registries still reachable after the worlds were dropped');
    assert.equal(o.held, 1000);
    assert.equal(o.residueB, 0, 'close() residue, phase B');
    assert.equal(o.sizeB, 0, 'phase B: hook listeners / schedulers still reachable from a held registry after close(): ' + o.sizeB);
});

test('lite-s3 retention must-fail: close() whose hook offs are no-ops -> sizeB 3000 (every hook fn stays listed)', () => {
    const o = retentionRun('m-offs');
    assert.equal(o.mutant, 'm-offs');
    assert.deepEqual([o.sizeA, o.residueA, o.held, o.residueB], [0, 0, 1000, 0], 'phase A sane; the offs do not move node / link counts');
    assert.equal(o.sizeB, 3000, '3 tracked hook fns x 1000 held registries');
});

test('lite-s3 retention must-fail: close() that never disposes the scheduler effects -> sizeB 2000 (schedulers held by the node pool)', () => {
    const o = retentionRun('m-disp');
    assert.equal(o.mutant, 'm-disp');
    assert.deepEqual([o.sizeA, o.residueA, o.held, o.residueB], [0, 1000, 1000, 1000], 'phase A collectible; both effects stay live -> residue 1 per world');
    assert.equal(o.sizeB, 2000, '2 tracked schedulers x 1000 held registries');
});

/* ---- ASSERTION 5: the seam ------------------------------------------------------------------------- */

test('LANE_INDEX: the reserved literal (S3-D6), 14 distinct values < 16, roster indices from it', () => {
    assert.deepEqual({ ...LANE_INDEX }, {
        GRAPH: 0, BATCH: 1, ERROR: 2, NEST: 3, WIE: 4, LIFECYCLE: 5, HOOK: 6, OWNER: 7, SCHEDULER: 8, BOX: 9, REGISTRY: 10,
        RECYCLE: 11, CAPACITY: 12, SNAPSHOT: 13,
    });
    assert.ok(Object.isFrozen(LANE_INDEX));
    const v = Object.values(LANE_INDEX);
    assert.equal(new Set(v).size, 14);
    assert.ok(v.every((x) => Number.isInteger(x) && x >= 0 && x < 16));
    assert.deepEqual(ROSTER, ['GRAPH', 'BATCH', 'ERROR', 'NEST', 'WIE', 'HOOK', 'LIFECYCLE', 'OWNER'], 'R3 appends OWNER, last');
    for (const d of LANES) assert.equal(d.index, LANE_INDEX[d.name], d.name);
    assert.equal(laneByName('WIE').index, 4);
});

test('checkLaneIndex: missing roster name / duplicate value / value >= 16 throw; the live table passes', () => {
    assert.doesNotThrow(() => checkLaneIndex(LANE_INDEX, ROSTER));
    assert.throws(() => checkLaneIndex({ GRAPH: 0 }, ['GRAPH', 'BATCH']), /BATCH/);
    assert.throws(() => checkLaneIndex({ GRAPH: 0, BATCH: 0 }, ['GRAPH', 'BATCH']), /duplicates/);
    assert.throws(() => checkLaneIndex({ GRAPH: 0, BATCH: 16 }, ['GRAPH', 'BATCH']), RangeError);
    assert.throws(() => checkLaneIndex({ GRAPH: 0, BATCH: 1.5 }, ['GRAPH', 'BATCH']), RangeError);
});

/** A short GRAPH world with one extra op appended. */
function scriptWith(op) {
    const s = generateWorld(laneByName('GRAPH'), 0xC0FFEE, { steps: 6 });
    return { ...s, ops: s.ops.concat([op]) };
}

test('exec: a lane-owned op is dispatched to ops[o](exec, op, k); an unowned op throws the old message', () => {
    const op = { o: 'zz', x: 7 };
    const script = scriptWith(op);
    const seen = [];
    const res = runWorld(liteAdapter, script, { laneOps: { zz(exec, o, k) { seen.push([typeof exec.W.signal, o, k]); } } });
    assert.deepEqual(seen, [['function', op, script.ops.length - 1]]);
    assert.equal(res.failure, null);
    assert.throws(() => runWorld(liteAdapter, script, {}), { message: 'exec: unknown op zz' });
    assert.throws(() => runWorld(liteAdapter, script, { laneOps: { yy() {} } }), { message: 'exec: unknown op zz' });
    assert.throws(() => runWorld(liteAdapter, scriptWith({ o: 'toString' }), { laneOps: { yy() {} } }), { message: 'exec: unknown op toString' });
    assert.throws(() => runWorld(liteAdapter, script, { laneOps: { sig() {} } }), TypeError, 'a lane op cannot shadow a core op');
    assert.throws(() => runWorld(liteAdapter, script, { laneOps: { zz: 1 } }), TypeError);
});

test('checkEscape(pred, got, expect[]): a non-array expect is a TypeError; EXPECT_NONE / EXPECT_CYCLE frozen', () => {
    for (const bad of [true, false, undefined, null, {}]) assert.throws(() => O.checkEscape([], [], bad), /expect must be an array/);
    assert.ok(Object.isFrozen(O.EXPECT_NONE) && Object.isFrozen(O.EXPECT_CYCLE) && Object.isFrozen(O.EXPECT_CYCLE[0]));
    assert.deepEqual(O.checkEscape([], [], O.EXPECT_CYCLE), [{ oracle: 'O6', sig: 'expected-escape-missing', detail: 'predicted CycleError did not happen' }]);
    const two = [{ ctor: 'Error', message: 'CycleError: a' }, { ctor: 'Error', message: 'CycleError: b' }];
    assert.equal(O.checkEscape([], two, O.EXPECT_CYCLE).length, 1, 'an entry absorbs at most one leaf');
    assert.equal(O.checkEscape([], two, O.EXPECT_CYCLE)[0].sig, 'escape-CycleError');
    const ce = [{ id: 'CapacityError', ctor: 'CapacityError', prefix: 'CapacityError:' }];
    assert.deepEqual(O.checkEscape([], [{ ctor: 'CapacityError', message: 'CapacityError: nodes capacity (32) exceeded.' }], ce), []);
    assert.equal(O.checkEscape([], [{ ctor: 'Error', message: 'CapacityError: x' }], ce)[0].sig, 'escape-Error', 'ctor is matched');
});

test('teeth: the fixMinusOne GAPs are exactly these 10 (T-A5b left GAPS for CHECKS in b117) and each cites a SPEC-B.md:<n> line', () => {
    const rows = Object.entries(GAPS).filter(([, g]) => g.why.indexOf('fix-minus-one control') === 0);
    assert.deepEqual(rows.map(([id]) => id), ['T-A1', 'T-A2', 'T-A3a', 'T-A3b', 'T-A3c', 'T-A4', 'T-A5a', 'T-A6', 'T-A7a', 'T-A7b']);
    for (const [id, g] of rows) assert.ok(/SPEC-B\.md:(\d+)\)/.test(g.why), id + ': no SPEC-B line ref');
});

test('teeth: every fixMinusOne GAP cites a SPEC-B line that holds its own | <id> | row', { skip: existsSync(SPEC_B) ? false : 'SPEC-B.md lives under the gitignored audit/ (.gitignore:18); its line refs are checkable only in the maintainer checkout' }, () => {
    const rows = Object.entries(GAPS).filter(([, g]) => g.why.indexOf('fix-minus-one control') === 0);
    const spec = readFileSync(SPEC_B, 'utf8').split('\n');
    for (const [id, g] of rows) {
        const m = /SPEC-B\.md:(\d+)\)/.exec(g.why);
        assert.ok(m !== null, id + ': no SPEC-B line ref');
        const line = spec[Number(m[1]) - 1];
        assert.ok(line !== undefined && line.indexOf('| ' + id + ' |') !== -1, id + ' -> SPEC-B:' + m[1] + ' reads: ' + line);
    }
});
