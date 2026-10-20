// 72-soak-anatomy.test.mjs -- the report-only anatomy lane (burst 86, B-B4b, PLAN-0s-bb4b ASSERTIONS 1-4).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// An INDEPENDENT ORACLE written from the plan text, never from anatomy.mjs. Surface assumed (PLAN TASKS 1-3):
//   openAnatomy({source}?) -> {lane, why}; lane = AnatomyLane { reset(), toJSON(), why, dir, adapter, shape(ad, script, r) };
//   foldCounts(VC, A) adds the 16-slot Int32 VC into the Float64 A slot by slot and returns an overflow boolean
//   (slot < 0 or >= 2^30); liteAdapterFor(kernel) -> frozen adapter named 'lite'.
// toJSON() -> { worlds, counts{12 visit-anchors NAMES}, markDedupe } | null. markDedupe = markStamp / markEdge (null on 0).
// Expected values are plan literals or structural identities (additivity, ratio recomputed from the counts, exact
// reference mulberry-free arithmetic); nothing is copied from a run.
// Rows that need main.mjs wiring (the smoke row lives in test/40) are not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAnatomy, AnatomyLane, foldCounts } from '../bench/soak/anatomy.mjs';
import { NAMES, EDITS } from '../harness/visit-anchors.mjs';
import { liteAdapter } from '../bench/soak/adapters/lite.mjs';
import { validateAdapter } from '../bench/soak/adapters/contract.mjs';
import { KERNEL_FILES } from '../bench/soak/kernel.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import { laneByName } from '../bench/soak/lanes/index.mjs';
import { seedFor, worldSeed } from '../bench/soak/seeds.mjs';

const GRAPH = laneByName('GRAPH');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CS = seedFor(0xC0FFEE, GRAPH.index, 0);
const scriptFor = (w) => generateWorld(GRAPH, worldSeed(CS, w), { large: false, covOff: null });
const open = () => { const o = openAnatomy(); assert.ok(o.lane !== null, 'lane available on the tree: ' + o.why); return o.lane; };

/** Play worlds [from, to) of the fixed GRAPH stream through the lane against its own shadow adapter. */
function drive(lane, from, to, adapter) {
    for (let w = from; w < to; w++) {
        const script = scriptFor(w);
        lane.shape(adapter === undefined ? lane.adapter : adapter, script, runWorld(liteAdapter, script));
    }
}
const counts = (lane) => { const j = lane.toJSON(); assert.ok(j !== null, 'lane non-null: ' + lane.why); return j; };

/* ---- ASSERTION 1: load / identity ---------------------------------------------------------------- */

test('anatomy load: tree -> lane non-null, dir removed, __VISIT__ deleted, adapter named lite with the base knownAs, contract-valid', () => {
    const o = openAnatomy();
    assert.ok(o.lane instanceof AnatomyLane, String(o.why));
    const a = o.lane.adapter;
    assert.equal(existsSync(o.lane.dir), false, 'the scratch dir is gone (rmSync in finally)');
    assert.equal(globalThis.__VISIT__, undefined);
    assert.equal(a.name, 'lite');
    assert.equal(a.knownAs(), liteAdapter.knownAs());
    assert.deepEqual(validateAdapter(a), []);
    assert.ok(Object.isFrozen(a));
});

test('anatomy load: a second openAnatomy gives an independent shadow engine (counts of one never leak to the other)', () => {
    const A = open(), B = open();
    drive(A, 0, 4);
    assert.equal(counts(A).worlds, 4);
    assert.equal(B.toJSON(), null, 'B ran nothing -> 0 worlds -> null');
});

test('anatomy load: ONE anchor drifted in `source` -> lane null, why /ANCHORS DRIFTED/, no throw, no dir left, __VISIT__ undefined', () => {
    const src = readFileSync(KERNEL_FILES[0].path, 'utf8');
    const anchor = EDITS[0][0];
    assert.equal(src.split(anchor).length - 1, EDITS[0][2], 'the tree carries the anchor the expected number of times');
    // exactly one anchor (EDITS[0]) loses a character; every other anchor still matches
    const drifted = src.replace(anchor, anchor.replace('FLAG_COMPUTED', 'FLAG_COMPUTEDX'));
    assert.notEqual(drifted, src);
    let o;
    assert.doesNotThrow(() => { o = openAnatomy({ source: drifted }); });
    assert.equal(o.lane, null);
    assert.match(String(o.why), /ANCHORS DRIFTED/);
    assert.equal(globalThis.__VISIT__, undefined);
});

test('anatomy load: a non-string-safe call never throws for an unavailable lane (source = "") -> lane null with a stated why', () => {
    let o;
    assert.doesNotThrow(() => { o = openAnatomy({ source: '' }); });
    assert.equal(o.lane, null);
    assert.equal(typeof o.why, 'string');
    assert.ok(o.why.length > 0);
});

/* ---- ASSERTION 2: counting ----------------------------------------------------------------------- */

test('anatomy counting: 32 GRAPH shape worlds -> worlds 32, pullTotal > 0, markEdge > 0, markStamp <= markEdge, markDedupe === markStamp / markEdge', () => {
    const lane = open();
    drive(lane, 0, 32);
    const j = counts(lane);
    assert.equal(j.worlds, 32);
    assert.deepEqual(Object.keys(j.counts), NAMES.slice());
    for (const n of NAMES) assert.ok(Number.isSafeInteger(j.counts[n]) && j.counts[n] >= 0, n);
    assert.ok(j.counts.pullTotal > 0, 'pullTotal ' + j.counts.pullTotal);
    assert.ok(j.counts.markEdge > 0, 'markEdge ' + j.counts.markEdge);
    assert.ok(j.counts.markStamp <= j.counts.markEdge);
    assert.ok(Object.is(j.markDedupe, j.counts.markStamp / j.counts.markEdge), 'markDedupe ' + j.markDedupe);
    assert.ok(j.counts.linkAlloc > 0 && j.counts.effectExec > 0, 'a GRAPH stream wires links and runs effects');
});

test('anatomy counting: counts(A then B) === counts(A) + counts(B) exactly, per name (VC.fill(0) between worlds); reset() starts clean', () => {
    const lane = open();
    drive(lane, 0, 16);
    const a = counts(lane);
    lane.reset();
    assert.equal(lane.toJSON(), null, 'reset -> 0 worlds');
    drive(lane, 16, 32);
    const b = counts(lane);
    lane.reset();
    drive(lane, 0, 16);
    drive(lane, 16, 32);
    const ab = counts(lane);
    assert.equal(ab.worlds, a.worlds + b.worlds);
    for (const n of NAMES) assert.equal(ab.counts[n], a.counts[n] + b.counts[n], n + ' additivity');
    // teeth: a world that is re-played must count TWICE (no cross-world carry or dedupe); mutant "no VC.fill(0)" makes the
    // second world see the first world's residue, so world W alone != W played after V minus V.
    lane.reset();
    drive(lane, 5, 6);
    const one = counts(lane);
    lane.reset();
    drive(lane, 5, 6);
    drive(lane, 5, 6);
    const two = counts(lane);
    for (const n of NAMES) assert.equal(two.counts[n], 2 * one.counts[n], n + ' same world twice');
});

test('anatomy counting MUST-FAIL: driving the lane on the PRIMARY kernel (uninstrumented) instead of the shadow counts nothing', () => {
    const lane = open();
    drive(lane, 0, 8, liteAdapter);
    const j = lane.toJSON();
    assert.ok(j !== null && j.worlds === 8, 'worlds are counted but...');
    for (const n of NAMES) assert.equal(j.counts[n], 0, n);
    assert.equal(j.markDedupe, null, 'markEdge 0 -> markDedupe null (not NaN)');
});

/* ---- ASSERTION 3: fail closed -------------------------------------------------------------------- */

// A stub that makes the oracle FAIL: set() is a no-op, so the model and the engine disagree on the first write.
function noSet(adapter) {
    const open2 = function open2(opts) { const w = adapter.open(opts); return Object.assign(Object.create(null), w, { set() {} }); };
    return Object.freeze(Object.create(adapter, { open: { value: open2, enumerable: true } }));
}
const throwing = (adapter) => Object.freeze(Object.create(adapter, { open: { value: function open() { throw new Error('boom'); }, enumerable: true } }));

function failingWorld() {
    for (let w = 0; w < 64; w++) {
        const s = scriptFor(w);
        if (runWorld(noSet(liteAdapter), s).failure !== null) return w;
    }
    throw new Error('test/72: no GRAPH world in 0..63 fails under the no-op set stub');
}

test('anatomy fail-closed: shadow FAILS while the oracle passed -> toJSON null, why /divergent/; one good world before does not rescue it', () => {
    const w = failingWorld(), lane = open();
    drive(lane, 0, 2);
    const s = scriptFor(w), r = runWorld(liteAdapter, s);
    assert.equal(r.failure, null, 'oracle (primary) passes');
    lane.shape(noSet(lane.adapter), s, r);
    assert.equal(lane.toJSON(), null);
    assert.match(lane.why, /divergent/);
});

test('anatomy fail-closed: oracle FAILS while the shadow passes (D2, the reverse direction) -> null, /divergent/', () => {
    const lane = open();
    const s = scriptFor(0), r = runWorld(liteAdapter, s);
    const bad = Object.assign({}, r, { failure: { step: 0, op: 'x', fails: [], scen: [] } });
    lane.shape(lane.adapter, s, bad);
    assert.equal(lane.toJSON(), null);
    assert.match(lane.why, /divergent/);
});

test('anatomy fail-closed: ops differ by 1 (both pass) -> null, /divergent/', () => {
    const lane = open();
    const s = scriptFor(0), r = runWorld(liteAdapter, s);
    lane.shape(lane.adapter, s, Object.assign({}, r, { ops: r.ops + 1 }));
    assert.equal(lane.toJSON(), null);
    assert.match(lane.why, /divergent/);
});

test('anatomy fail-closed: BOTH fail -> the world is skipped (not divergent, not counted); the rest still reports', () => {
    const w = failingWorld(), lane = open();
    drive(lane, 0, 3);
    const s = scriptFor(w), rf = runWorld(noSet(liteAdapter), s);
    assert.notEqual(rf.failure, null);
    lane.shape(noSet(lane.adapter), s, rf);
    const j = counts(lane);
    assert.equal(j.worlds, 3, 'the both-fail world is skipped');
});

test('anatomy fail-closed: a shadow that THROWS -> null + a stated why, and the lane stays disabled for later good worlds', () => {
    const lane = open();
    const s = scriptFor(0), r = runWorld(liteAdapter, s);
    assert.doesNotThrow(() => lane.shape(throwing(lane.adapter), s, r));
    assert.equal(lane.toJSON(), null);
    assert.equal(typeof lane.why, 'string');
    assert.ok(lane.why.length > 0);
    drive(lane, 1, 5);
    assert.equal(lane.toJSON(), null, 'disabled for the run: later good worlds do not revive it');
});

test('B: throw then reset', () => {
    const lane = open();
    const s = scriptFor(0), r = runWorld(liteAdapter, s);
    lane.shape(throwing(lane.adapter), s, r);
    lane.reset();
    drive(lane, 1, 5);
    assert.equal(lane.toJSON(), null, 'reset() (the next lane-cycle) does not revive a lane disabled by a shadow throw');
});

test('A: anatomy fail-closed: a slot at 2^30 inside shape() -> toJSON null, why /overflow/ (nothing folded)', () => {
    const lane = open();
    drive(lane, 0, 2);
    const s = scriptFor(2), r = runWorld(liteAdapter, s);
    const hot = Object.freeze(Object.create(lane.adapter, { open: { value: function open(o) { const w = lane.adapter.open(o); lane.vc[6] = 2 ** 30; return w; }, enumerable: true } }));
    lane.shape(hot, s, r);
    assert.equal(lane.toJSON(), null);
    assert.match(lane.why, /overflow/);
});

test('anatomy fail-closed: foldCounts overflow flag -- a slot of 2^30 or -1 -> true; 2^30 - 1 and 0 -> false', () => {
    const A = new Float64Array(16);
    const VC = new Int32Array(16);
    assert.equal(foldCounts(VC, A), false);
    VC[4] = 2 ** 30 - 1;
    assert.equal(foldCounts(VC, A), false, 'the last in-range value');
    VC[4] = 2 ** 30;
    assert.equal(foldCounts(VC, A), true);
    VC[4] = -1;
    assert.equal(foldCounts(VC, A), true);
    VC[4] = 0;
    VC[11] = 2 ** 30;
    assert.equal(foldCounts(VC, A), true, 'the last counted slot is checked too');
});

test('anatomy fold: foldCounts adds slot by slot exactly (additivity; Float64 exact past 2^31)', () => {
    const A = new Float64Array(16);
    const VC = new Int32Array(16);
    for (let i = 0; i < 12; i++) VC[i] = (2 ** 30 - 1) - i;
    for (let k = 0; k < 4; k++) assert.equal(foldCounts(VC, A), false);
    for (let i = 0; i < 12; i++) assert.equal(A[i], 4 * ((2 ** 30 - 1) - i), 'slot ' + i);
});

test('C: anatomy load: globalThis.__VISIT__ already defined -> lane null, why /__VISIT__/, the foreign value untouched', () => {
    const foreign = new Int32Array(16);
    globalThis.__VISIT__ = foreign;
    let o;
    try { o = openAnatomy(); } finally { assert.equal(globalThis.__VISIT__, foreign); delete globalThis.__VISIT__; }
    assert.equal(o.lane, null);
    assert.match(o.why, /__VISIT__/);
});

test('D: anatomy load: the kernel file changed after load -> lane null, why /changed since load/', () => {
    const dir = mkdtempSync(join(tmpdir(), 't72-k-'));
    try {
        copyFileSync(join(ROOT, 'Signal.js'), join(dir, 'Signal.js'));
        copyFileSync(join(ROOT, 'Watch.js'), join(dir, 'Watch.js'));
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { appendFileSync } from 'node:fs';
const { openAnatomy } = await import('./bench/soak/anatomy.mjs');
appendFileSync(process.env.SOAK_KERNEL, '\\n// edited after load\\n');
const o = openAnatomy();
process.stdout.write(JSON.stringify({ lane: o.lane === null, why: o.why }));
`], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { SOAK_KERNEL: join(dir, 'Signal.js') }), timeout: 60000 });
        assert.equal(r.status, 0, r.stderr);
        const o = JSON.parse(r.stdout);
        assert.equal(o.lane, true);
        assert.match(o.why, /changed since load/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---- ASSERTION 4: GC ------------------------------------------------------------------------------ */

function child(src) {
    const r = spawnSync(process.execPath, ['--expose-gc', '--max-semi-space-size=64', '--min-semi-space-size=64', '--input-type=module', '-e', src],
        { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('anatomy GC: foldCounts slope (delta(64 x 2^14 calls) - delta(2^14 calls)) / (63 x 2^14) |.| <= 0.01 B/op; a TRANSIENT allocating control >= 32 B/op', () => {
    const o = child(`
import { foldCounts } from './bench/soak/anatomy.mjs';
const N = 1 << 14;
const A = new Float64Array(16), VC = new Int32Array(16);
for (let i = 0; i < 12; i++) VC[i] = i + 1;
const run = (fn, n) => { gc(); gc(); const b = process.memoryUsage().heapUsed; fn(n); return process.memoryUsage().heapUsed - b; };
const real = (n) => { for (let i = 0; i < n; i++) foldCounts(VC, A); };
for (let i = 0; i < 200000; i++) foldCounts(VC, A);
const d1 = run(real, N), d16 = run(real, 64 * N);
// control: a fresh 4-field object per call, dropped at once (transient; typed arrays are under-counted by heapUsed); 16 x 2^14 x >= 32 B stays inside the 64 MB semi-space
const sink = new Array(8).fill(null);   // escapes the allocation (no scalar replacement); only 8 survive, the rest is transient
const bad = (n) => { for (let i = 0; i < n; i++) { sink[i & 7] = { a: i, b: 2, c: 3, d: 4 }; foldCounts(VC, A); } };
const c1 = run(bad, N), c16 = run(bad, 16 * N);
process.stdout.write(JSON.stringify({ slope: (d16 - d1) / (63 * N), ctl: (c16 - c1) / (15 * N) }));
`);
    console.log('anatomy foldCounts GC slope B/op: ' + o.slope + ' (control ' + o.ctl + ')');
    assert.ok(Math.abs(o.slope) <= 0.01, 'slope B/op ' + o.slope);
    assert.ok(o.ctl >= 32, 'the transient control must show, got ' + o.ctl);
});

test('anatomy GC: 3 cycles x 16 shadow worlds under lite-leak, forced drain -> tracker.size() 0 and 0 live WeakRefs each cycle; a retaining control keeps >= 16', () => {
    const o = child(`
import { createLeakTracker } from '@zakkster/lite-leak';
import { openAnatomy } from './bench/soak/anatomy.mjs';
import { runWorld } from './bench/soak/exec.mjs';
import { tapAdapter } from './bench/soak/main.mjs';
import { liteAdapter } from './bench/soak/adapters/lite.mjs';
import { laneByName } from './bench/soak/lanes/index.mjs';
import { generateWorld } from './bench/soak/gen.mjs';
import { seedFor, worldSeed } from './bench/soak/seeds.mjs';
const GRAPH = laneByName('GRAPH');
const { lane } = openAnatomy();
if (lane === null) throw new Error('lane unavailable');
const tracker = createLeakTracker({ name: 't72' });
let keep = null;
let witness = [];
const alive = () => { let n = 0; for (const w of witness) if (w.deref() !== undefined) n++; return n; };
function cycle(c, retain) {
    lane.reset();
    const hold = [];
    const tap = { escape: null, onOpen(w) { tracker.track(w.registry, null, 'S'); witness.push(new WeakRef(w.registry)); if (retain) hold.push(w.registry); } };
    const sad = tapAdapter(lane.adapter, tap);
    for (let w = 0; w < 16; w++) {
        const s = generateWorld(GRAPH, worldSeed(seedFor(72, GRAPH.index, c), w), { large: false, covOff: null });
        lane.shape(sad, s, runWorld(liteAdapter, s));
    }
    if (retain) keep = hold;
    return lane.toJSON() !== null;
}
async function drain() {
    for (let t = 0; t < 40 && (tracker.size() !== 0 || alive() !== 0); t++) { gc(); await new Promise((r) => setTimeout(r, 20)); }
    return [tracker.size(), alive()];
}
const sizes = [], lives = [];
let reported = true;
for (let c = 0; c < 3; c++) {
    reported = cycle(c, false) && reported;
    const [s, a] = await drain();
    sizes.push(s); lives.push(a);
}
witness = [];
cycle(9, true);
await drain();
const ctl = tracker.size();
process.stdout.write(JSON.stringify({ sizes, lives, ctl, reported }));
`);
    assert.deepEqual(o.sizes, [0, 0, 0]);
    assert.deepEqual(o.lives, [0, 0, 0]);
    assert.equal(o.reported, true, 'the lane really counted the shadow worlds');
    assert.ok(o.ctl >= 16, 'the retaining control must be seen, got ' + o.ctl);
});

test('anatomy load (b88 NIT): an inherited Object.prototype.source = junk does not leak into openAnatomy({}) -> non-null lane (HEAD: UNAVAILABLE)', () => {
    Object.prototype.source = 'junk, not a kernel';
    let o;
    try { o = openAnatomy({}); } finally { delete Object.prototype.source; }
    assert.ok(o.lane !== null, 'lane available despite the polluted prototype: ' + o.why);
    assert.equal(globalThis.__VISIT__, undefined);
});
