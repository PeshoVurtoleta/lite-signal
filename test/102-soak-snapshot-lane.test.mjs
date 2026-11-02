/**
 * test/102 -- R8 B2: the SNAPSHOT lane (lanes/snapshot.mjs), exec's sn hook / swapWorld / checks.OS and the 7 snapshot
 * scenarios (PLAN-R8-snapshot.md CURRENT R8-2, R8-3, R8-10, R8-12, R8-13, R8-19, R8-20; GROUP B ASSERTIONS 2-6 as
 * re-bound by CURRENT). The lane is UNROSTERED until R8 C1: every world here is driven through runWorld's opts.laneOps
 * (the pre-roster form test/92 / test/96 used), never through main.mjs.
 *
 * Rows: tree 200 seeded worlds x 400 steps (lite-s3, the SOAK_ENGINE=lite adapter) -> 0 failures, every snapshot
 * scenario > 0, checks.OS === the restore events counted HERE (a filled slot at the rest op), stats().nodePoolCapacity
 * 4096 + capacity().onCapacityExceeded 'grow' after every swap; teeth (liteAdapterFor(K, { broken })): 'snapshot-refire'
 * -> OS refire, 'snapshot-stale' -> OS roundtrip; R8-10 (a rest never reuses a node index; a must-fail generator that
 * rewinds Gen.next after a rest trips the same check); retention (child, --expose-gc): 3 cycles x 50 worlds with every
 * swapped-out registry and every snapshot tracked by lite-leak -> tracker.size() 0 per cycle, and a SnState.close()
 * mutant that keeps its slots -> size > 0; malformed op.s (8 values) and forbidden script shapes -> exec.unmodelled.
 * On HEAD acb9c5b the file fails at import (lanes/snapshot.mjs does not exist).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT, SnState, SNAP_EXPECT } from '../bench/soak/lanes/snapshot.mjs';
import { GRAPH } from '../bench/soak/lanes/graph.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import { runWorld, CHECK_NAMES } from '../bench/soak/exec.mjs';
import { SCENARIOS } from '../bench/soak/scenarios.mjs';
import { worldSeed } from '../bench/soak/seeds.mjs';
import { liteS3Adapter } from '../bench/soak/adapters/lite-s3.mjs';
import { liteBoxAdapter } from '../bench/soak/adapters/lite-box.mjs';
import { liteAdapterFor } from '../bench/soak/adapters/lite.mjs';
import { K } from '../bench/soak/kernel.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE = 0x5A4B0102 >>> 0;
const WORLDS = 200;
const SNAP_SCEN = ['snap-restore', 'restore-after-dispose', 'restore-recycled', 'restore-twice', 'snap-refused-batch', 'snap-refused-body', 'snap-untrack-ok'];
const gen = (w, desc) => generateWorld(desc || SNAPSHOT, worldSeed(BASE, w), { steps: 400 });

/** laneOps that count restore EVENTS (a filled slot at the rest op) and check the swapped world, test-side. */
function probeOps(st) {
    return {
        snap: SNAPSHOT.ops.snap,
        snapin: SNAPSHOT.ops.snapin,
        rest(x, op, k) {
            const slot = x.sn !== null && (op.s === 0 || op.s === 1) && !Object.is(op.s, -0) ? x.sn.slots[op.s] : null;
            const W0 = x.W;
            SNAPSHOT.ops.rest(x, op, k);
            st.sn = x.sn;
            if (slot === null) return;
            st.events++;
            if (x.W === W0) { st.noSwap++; return; }
            const s = x.W.registry.stats();
            if (s.nodePoolCapacity !== 4096) st.badCap.push(s.nodePoolCapacity);
            if (typeof x.W.capacity === 'function' && x.W.capacity().onCapacityExceeded !== 'grow') st.badPolicy++;
            if (typeof x.W.capacity !== 'function') st.noCapacityFn++;
            if (x.H.length !== slot.Hlen) st.badHlen++;
        },
    };
}

function runMany(ad, n, opts) {
    const st = { events: 0, noSwap: 0, badCap: [], badPolicy: 0, noCapacityFn: 0, badHlen: 0, sn: null };
    const agg = { fails: 0, os: 0, scen: Object.create(null), sigs: Object.create(null), judged: { clean: 0, never: 0, dirty: 0 }, worlds: 0, throws: [] };
    for (let w = 0; w < n; w++) {
        st.sn = null;
        let r;
        try { r = runWorld(ad, gen(w), { laneOps: probeOps(st), ...(opts || {}) }); } catch (e) { agg.throws.push(w + ': ' + e.message); continue; }
        agg.worlds++;
        agg.os += r.checks.OS;
        for (const k in r.scen) agg.scen[k] = (agg.scen[k] || 0) + r.scen[k];
        if (st.sn !== null) for (const c of ['clean', 'never', 'dirty']) agg.judged[c] += st.sn.judged[c];
        if (r.failure !== null) {
            agg.fails++;
            for (const f of r.failure.fails) { const key = f.oracle + ':' + f.sig; agg.sigs[key] = (agg.sigs[key] || 0) + 1; }
        }
    }
    return { st, agg };
}

/* ---- 1. surface ------------------------------------------------------------------------------------------------ */

test('surface: SCENARIOS 79 -> 86 with the 7 snapshot ids appended last; CHECK_NAMES ends OT, OS; the descriptor', () => {
    assert.equal(SCENARIOS.length, 86);
    assert.deepEqual(SCENARIOS.slice(79), SNAP_SCEN);
    assert.deepEqual(CHECK_NAMES.slice(-2), ['OT', 'OS']);
    assert.equal(CHECK_NAMES.length, 14);
    assert.equal(SNAPSHOT.name, 'SNAPSHOT');
    assert.equal(SNAPSHOT.index, 13);
    assert.equal(SNAPSHOT.twin, false);
    assert.deepEqual(SNAPSHOT.needsCaps, ['snapshot']);
    assert.deepEqual(SNAPSHOT.hardOracles, ['OS']);
    assert.deepEqual(SNAPSHOT.required, ['snap-restore']);
    assert.equal(SNAPSHOT.mix.GRAPH, undefined, 'R8-8: a plain lane, no sub-lane mix');
    assert.equal(SNAPSHOT.worldShape.largeEvery, 0);
    assert.deepEqual(Object.keys(SNAPSHOT.ops).sort(), ['rest', 'snap', 'snapin']);
    for (const s of SNAPSHOT.optional.concat(SNAPSHOT.required)) assert.ok(SCENARIOS.includes(s), s);
    assert.deepEqual(SNAP_EXPECT.map((e) => [e.ctor, e.prefix]), [['Error', '[lite-signal] snapshot: graph not settled']]);
});

test('a non-SNAPSHOT world keeps checks.OS 0 and exec.sn null (GRAPH, 5 worlds)', () => {
    for (let w = 0; w < 5; w++) {
        const r = runWorld(liteS3Adapter, gen(w, GRAPH), {});
        assert.equal(r.failure, null);
        assert.equal(r.checks.OS, 0);
        assert.deepEqual(Object.keys(r.checks), CHECK_NAMES.slice());
    }
});

/* ---- 2. tree --------------------------------------------------------------------------------------------------- */

test('tree: 200 worlds x 400 steps on lite-s3 -> 0 failures; every snapshot scenario > 0; checks.OS === restore events; 4096 + grow after every swap', () => {
    const { st, agg } = runMany(liteS3Adapter, WORLDS);
    assert.deepEqual(agg.throws, []);
    assert.equal(agg.worlds, WORLDS);
    assert.equal(agg.fails, 0, 'failing worlds: ' + JSON.stringify(agg.sigs));
    for (const s of SNAPSHOT.required) assert.ok(agg.scen[s] > 0, 'required ' + s);
    for (const s of SNAP_SCEN) assert.ok(agg.scen[s] > 0, s + ' = ' + agg.scen[s]);
    assert.ok(st.events > 0);
    assert.equal(agg.os, st.events, 'R8-3: checks.OS === restore events');
    assert.equal(agg.scen['snap-restore'], st.events, 'snap-restore counts every event');
    assert.equal(st.noSwap, 0, 'every event swapped the world');
    assert.deepEqual(st.badCap, [], 'stats().nodePoolCapacity 4096 after every swap');
    assert.equal(st.noCapacityFn, 0, 'lite-s3 world has capacity()');
    assert.equal(st.badPolicy, 0, "capacity().onCapacityExceeded 'grow' after every swap");
    assert.equal(st.badHlen, 0, 'H cut to Hlen after every swap');
    assert.ok(agg.judged.clean > 0 && agg.judged.never > 0, 'clean-bit judged both classes: ' + JSON.stringify(agg.judged));
});

test('tree: 50 worlds on lite-box (facade restoreRegistry) -> 0 failures, checks.OS === events', () => {
    const { st, agg } = runMany(liteBoxAdapter, 50);
    assert.deepEqual(agg.throws, []);
    assert.equal(agg.fails, 0, JSON.stringify(agg.sigs));
    assert.ok(st.events > 0);
    assert.equal(agg.os, st.events);
    assert.equal(st.noSwap, 0);
    assert.deepEqual(st.badCap, []);
});

/* ---- 3. teeth -------------------------------------------------------------------------------------------------- */

test("teeth: liteAdapterFor(K, { broken: 'snapshot-refire' }) fails with OS refire in >= 1 of the 200 worlds", () => {
    const { agg } = runMany(liteAdapterFor(K, { broken: 'snapshot-refire' }), WORLDS);
    assert.deepEqual(agg.throws, []);
    assert.ok(agg.sigs['OS:refire'] >= 1, JSON.stringify(agg.sigs));
});

test("teeth: liteAdapterFor(K, { broken: 'snapshot-stale' }) fails with OS roundtrip in >= 1 of the 200 worlds", () => {
    const { agg } = runMany(liteAdapterFor(K, { broken: 'snapshot-stale' }), WORLDS);
    assert.deepEqual(agg.throws, []);
    assert.ok(agg.sigs['OS:roundtrip'] >= 1, JSON.stringify(agg.sigs));
});

/* ---- 4. R8-10: a rest never reuses a node index ----------------------------------------------------------------- */

/** Every created node index of a script, in script order (sig / comp / eff, through seq and batch bodies). */
function created(ops, out) {
    for (const op of ops) {
        if (op.o === 'sig' || op.o === 'comp' || op.o === 'eff') out.push(op.i);
        else if (op.o === 'seq') created(op.ops, out);
        else if (op.o === 'batch') created(op.body, out);
    }
    return out;
}

/** The first creation (after >= 1 rest) whose index is not past every index created before it, or null. */
function reuseAfterRest(script) {
    let max = -1, rested = false;
    const walk = (ops) => {
        for (const op of ops) {
            if (op.o === 'rest') rested = true;
            if (op.o === 'sig' || op.o === 'comp' || op.o === 'eff') {
                if (op.i <= max) return { i: op.i, max, rested };
                max = op.i;
            } else if (op.o === 'seq' || op.o === 'batch') { const r = walk(op.o === 'seq' ? op.ops : op.body); if (r !== null) return r; }
        }
        return null;
    };
    return walk(script.ops);
}

test('R8-10: over 200 scripts every created index is unique and past every earlier one, rests included; a rewinding generator trips it', () => {
    let rests = 0, after = 0;
    for (let w = 0; w < WORLDS; w++) {
        const s = gen(w);
        const idx = created(s.ops, []);
        assert.equal(new Set(idx).size, idx.length, 'world ' + w + ' reuses an index');
        assert.equal(reuseAfterRest(s), null, 'world ' + w);
        let seen = false;
        const walk = (ops) => { for (const op of ops) { if (op.o === 'rest') { rests++; seen = true; } else if (seen && (op.o === 'sig' || op.o === 'comp' || op.o === 'eff')) after++; else if (op.o === 'seq') walk(op.ops); } };
        walk(s.ops);
    }
    assert.ok(rests > 0 && after > 0, 'rests ' + rests + ', creations after a rest ' + after);
    // must-fail: a generator that rewinds Gen.next to the restored model's length after a rest reuses indices
    const REWIND = Object.freeze({
        ...SNAPSHOT,
        step(g) {
            const n = g.ops.length;
            SNAPSHOT.step(g);
            if (g.ops.length > n && g.ops[g.ops.length - 1].o === 'rest') g.next = g.M.n.length;
        },
    });
    let hits = 0;
    for (let w = 0; w < 20; w++) if (reuseAfterRest(gen(w, REWIND)) !== null) hits++;
    assert.ok(hits >= 1, 'the rewinding generator reuses an index in >= 1 of 20 worlds (got ' + hits + ')');
});

/* ---- 5. retention (child, --expose-gc) -------------------------------------------------------------------------- */

const RETENTION_SRC = `
import { createLeakTracker } from '@zakkster/lite-leak';
import { SNAPSHOT, SnState } from './bench/soak/lanes/snapshot.mjs';
import { generateWorld } from './bench/soak/gen.mjs';
import { runWorld } from './bench/soak/exec.mjs';
import { worldSeed } from './bench/soak/seeds.mjs';
import { liteS3Adapter } from './bench/soak/adapters/lite-s3.mjs';
const MUTANT = process.argv[process.argv.length - 1] === 'mutant';
if (MUTANT) SnState.prototype.close = function () { this.armed = false; };   // keeps its slots
const tr = createLeakTracker({ name: 't102' });
const settle = async () => {
    for (let t = 0; t < 40 && tr.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 20)); }
    return tr.size();
};
const held = [];   // every world's SnState stays reachable: only close() can release its slots
let tracked = 0, fails = 0;
const ops = {
    snapin: SNAPSHOT.ops.snapin,
    snap(x, op, k) { SNAPSHOT.ops.snap(x, op, k); const sl = x.sn.slots[op.s]; if (sl !== null) { tr.track(sl.snap, null, 'snap'); tr.track(sl.mc, null, 'mc'); tracked += 2; } },
    rest(x, op, k) { const reg = x.W.registry; const W0 = x.W; SNAPSHOT.ops.rest(x, op, k); if (x.W !== W0) { tr.track(reg, null, 'old-registry'); tracked++; } },
};
const sizes = [];
gc();
for (let cycle = 0; cycle < 3; cycle++) {
    for (let w = 0; w < 50; w++) {
        let sn = null;
        const r = runWorld(liteS3Adapter, generateWorld(SNAPSHOT, worldSeed(0x102 + cycle, w), { steps: 400 }), { laneOps: { ...ops, snap(x, op, k) { ops.snap(x, op, k); sn = x.sn; } } });
        if (r.failure !== null) fails++;
        if (sn !== null) held.push(sn);
    }
    sizes.push(await settle());
}
console.log(JSON.stringify({ sizes, tracked, fails, held: held.length, mutant: MUTANT }));
`;

function retention(mode) {
    const args = ['--expose-gc', '--max-old-space-size=512', '--input-type=module', '-e', RETENTION_SRC, mode];
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
    const tail = String(r.stderr || '').split('\n').slice(-12).join('\n');
    assert.ok(r.status === 0 && r.signal === null, 'child exit ' + r.status + ' sig ' + r.signal + '\n' + tail);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('retention: 3 cycles x 50 worlds, every swapped-out registry + snapshot + model copy tracked -> size 0 per cycle; a slot-keeping SnState.close() -> size > 0', () => {
    const ok = retention('clean');
    assert.equal(ok.mutant, false);
    assert.equal(ok.fails, 0);
    assert.equal(ok.held, 150, 'every world reached a snap');
    assert.ok(ok.tracked > 300, 'tracked ' + ok.tracked);
    assert.deepEqual(ok.sizes, [0, 0, 0], 'tracker.size() at each cycle close');
    const bad = retention('mutant');
    assert.equal(bad.mutant, true);
    assert.ok(bad.sizes[0] > 0 && bad.sizes[2] > 0, 'the slot-keeping close() retains: ' + JSON.stringify(bad.sizes));
});

/* ---- 6. fail closed ---------------------------------------------------------------------------------------------- */

const SCRIPT = (ops, extra) => ({ genVersion: 1, lane: 'SNAPSHOT', seed: 1, large: false, covOff: null, flushPasses: null, ...(extra || {}), ops });
const BASE_OPS = () => [{ o: 'sig', i: 0, v: 1 }, { o: 'comp', i: 1, spec: { k: 'identity', d: [0] } }, { o: 'eff', i: 2, spec: { k: 'identity', d: [1] } }];
const runS = (s, laneOps) => runWorld(liteS3Adapter, s, { laneOps: laneOps || SNAPSHOT.ops });

test('checkOsModel tooth', () => { const tamper = { ...SNAPSHOT.ops, rest(x, op, k) { const sl = x.sn.slots[op.s]; if (sl !== null) sl.mc.n[0].v = 99; SNAPSHOT.ops.rest(x, op, k); } }; const r = runS(SCRIPT([{ o: 'sig', i: 0, v: 1 }, { o: 'comp', i: 1, spec: { k: 'identity', d: [0] } }, { o: 'snap', s: 1 }, { o: 'rest', s: 1 }]), tamper); assert.ok(r.failure !== null && r.failure.fails.some((f) => f.oracle === 'OS' && f.sig === 'roundtrip' && /value snap=1 model=99/.test(f.detail))); });

test('R8-19 whole-pass counter tooth: a never-read computed refreshed as a dep by an earlier read in the same pass counts its run', () => {
    let slot = null;
    const peekOps = { ...SNAPSHOT.ops, rest(x, op, k) { slot = x.sn.slots[op.s]; SNAPSHOT.ops.rest(x, op, k); } };
    const r = runS(SCRIPT([{ o: 'sig', i: 0, v: 1 }, { o: 'comp', i: 1, spec: { k: 'identity', d: [0] } }, { o: 'comp', i: 2, spec: { k: 'identity', d: [0] } }, { o: 'disp', i: 1 }, { o: 'comp', i: 3, spec: { k: 'identity', d: [2] } }, { o: 'snap', s: 0 }, { o: 'rest', s: 0 }]), peekOps);
    assert.equal(r.failure, null, r.failure === null ? '' : JSON.stringify(r.failure.fails));
    assert.equal(r.checks.OS, 1);
    assert.ok(slot !== null);
    const nodes = slot.snap.nodes, idOf = slot.idOf;
    const at3 = nodes.findIndex((n) => n.id === idOf[3]), at2 = nodes.findIndex((n) => n.id === idOf[2]);
    assert.ok(at3 !== -1 && at2 !== -1 && at3 < at2, 'premise: computed #3 precedes its dep #2 in S1 order (' + at3 + ' < ' + at2 + ')');
    for (const j of [at3, at2]) { assert.equal(nodes[j].clean, false); assert.equal(nodes[j].evalVersion, 0); }
});

test('malformed op.s: -0, -1, 2, 1.5, NaN, "0", null, undefined -> exec.unmodelled (8 rows on snap) + rest / snapin rows', () => {
    const bad = [-0, -1, 2, 1.5, NaN, '0', null, undefined];
    for (const s of bad) {
        const op = { o: 'snap' };
        if (s !== undefined) op.s = s;
        assert.throws(() => runS(SCRIPT(BASE_OPS().concat([op]))), /exec: unmodelled snapshot op: snap slot s /, 'snap s=' + String(s));
    }
    assert.throws(() => runS(SCRIPT(BASE_OPS().concat([{ o: 'snap', s: 0 }, { o: 'rest', s: -0 }]))), /unmodelled snapshot op: rest slot s -0/);
    assert.throws(() => runS(SCRIPT(BASE_OPS().concat([{ o: 'snapin', s: 2, where: 'batch' }]))), /unmodelled snapshot op: snapin slot s 2/);
    assert.throws(() => runS(SCRIPT(BASE_OPS().concat([{ o: 'snapin', s: 0, where: 'flush' }]))), /snapin where "flush"/);
    // the honest twins run clean
    const r = runS(SCRIPT(BASE_OPS().concat([{ o: 'snap', s: 1 }, { o: 'set', i: 0, v: 2 }, { o: 'rest', s: 1 }, { o: 'snapin', s: 0, where: 'body' }])));
    assert.equal(r.failure, null);
    assert.equal(r.checks.OS, 1);
    assert.equal(r.scen['snap-restore'], 1);
    assert.equal(r.scen['snap-refused-body'], 1);
});

test('forbidden script shapes -> exec.unmodelled at the first SNAPSHOT op (allowlist), lane state / live registration at any op', () => {
    const rows = [
        ['reg', [{ o: 'reg', r: 0, i: 0 }]],
        ['off', [{ o: 'off', r: 0 }]],
        ['arm', [{ o: 'arm', O: 2, t: 0, v: 3, x: -1, child: -1, reg: -1, at: -1, flip: -1 }]],
        ['hsub', [{ o: 'hsub' }]],
        ['lreg', [{ o: 'lreg' }]],
        ['ocreate', [{ o: 'oroot' }]],
        ['rcstale', [{ o: 'rset' }]],
        ['ssched', [{ o: 'seff' }]],
        ['cnode', [{ o: 'cnode' }]],
        ['nested in seq', [{ o: 'seq', ops: [{ o: 'reg', r: 0, i: 0 }] }]],
        ['eq signal', [{ o: 'sig', i: 9, v: 1, eq: 1 }]],
        ['computed writer', [{ o: 'comp', i: 9, spec: { k: 'identity', d: [0], w: 0 } }]],
    ];
    for (const [label, tail] of rows) {
        assert.throws(() => runS(SCRIPT(BASE_OPS().concat([{ o: 'snap', s: 0 }], tail))), /exec: unmodelled snapshot op: /, label);
    }
    assert.throws(() => runS(SCRIPT(BASE_OPS().concat([{ o: 'snap', s: 0 }]), { capacity: { maxNodes: 64, maxLinks: 64, onCapacityExceeded: 'grow' } })), /capacity key/);
    for (const k of ['lc', 'hk', 'ow', 'rc', 'sc']) {
        const laneOps = { ...SNAPSHOT.ops, snap(x, op, kk) { x[k] = {}; try { SNAPSHOT.ops.snap(x, op, kk); } finally { x[k] = null; } } };
        assert.throws(() => runS(SCRIPT(BASE_OPS().concat([{ o: 'snap', s: 0 }])), laneOps), /lane state set/, k);
    }
    const regOps = { ...SNAPSHOT.ops, snap(x, op, kk) { x.M.addReg(0, 0); SNAPSHOT.ops.snap(x, op, kk); } };
    assert.throws(() => runS(SCRIPT(BASE_OPS().concat([{ o: 'snap', s: 0 }])), regOps), /live registration r0/);
    // a rest of an empty slot is a no-op (a shrunk script), not an event
    const r = runS(SCRIPT(BASE_OPS().concat([{ o: 'rest', s: 0 }])));
    assert.equal(r.failure, null);
    assert.equal(r.checks.OS, 0);
});

test('SnState: onBody counts only while armed; close() nulls both slots and the counter', () => {
    const sn = new SnState();
    sn.onBody(0);
    assert.equal(sn.total, 0);
    sn.cnt = new Int32Array(3);
    sn.armed = true;
    sn.onBody(1); sn.onBody(1); sn.onBody(7);
    assert.deepEqual(Array.from(sn.cnt), [0, 2, 0]);
    assert.equal(sn.total, 3);
    sn.slots[0] = {}; sn.slots[1] = {};
    sn.close();
    assert.deepEqual(sn.slots, [null, null]);
    assert.equal(sn.cnt, null);
    assert.equal(sn.armed, false);
});
