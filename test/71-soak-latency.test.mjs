// 71-soak-latency.test.mjs -- the report-only latency lane (burst 85, B-B4a, PLAN-0s-bb4a ASSERTIONS 1-3).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// An INDEPENDENT ORACLE written from the plan text, never from latency.mjs. Expected values: ASSERTION 1 literals
// (floorNs 40; 3 below + 97 x 1000 -> n 100 / belowFloor 3 / p50,p99 in [990,1010]; 60 below + 40 x 1000 -> p50 null,
// p99 in [990,1010]; empty -> {0,null,null,0}); the log-uniform check is compared with an exact sort (rank
// floor(0.99 * 9999)); transparency (ASSERTION 2) compares an armed run with an unwrapped run of the SAME generated
// world; GC (ASSERTION 3) measures in a --expose-gc child.
//
// Surface assumed (PLAN SPEC / TASK 3): `new LatencyLane({ floorNs })`, .wrap(adapter), .armed, .reset(),
// .toJSON() -> { <method>: { n, p50Ns, p99Ns, belowFloor } } keyed by config.mjs LATENCY_METHODS, .observe(method, ns).
// The "collapsed false" clause of ASSERTION 1 has no named field in the plan, so it is covered by the p99 accuracy bound.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LatencyLane } from '../bench/soak/latency.mjs';
import * as CFG from '../bench/soak/config.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import { tapAdapter } from '../bench/soak/main.mjs';
import { liteAdapter } from '../bench/soak/adapters/lite.mjs';
import { laneByName } from '../bench/soak/lanes/index.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import { seedFor, worldSeed } from '../bench/soak/seeds.mjs';

const GRAPH = laneByName('GRAPH');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const METHODS = () => { assert.ok(Array.isArray(CFG.LATENCY_METHODS), 'config.mjs exports LATENCY_METHODS'); return CFG.LATENCY_METHODS; };
const EMPTY = { n: 0, p50Ns: null, p99Ns: null, belowFloor: 0 };

/* ---- ASSERTION 1: observe() ---------------------------------------------------------------------- */

test('latency: config exports the fixed method list (PLAN task 2) and the lane keys its JSON by it', () => {
    assert.deepEqual(METHODS(), ['signal', 'computed', 'effect', 'set', 'read', 'peek', 'batch', 'untrack', 'dispose', 'lifecycle', 'settle', 'close']);
    assert.equal(CFG.SKETCH_ALPHA, 0.01);
    assert.deepEqual(Object.keys(new LatencyLane({ floorNs: 40 }).toJSON()), METHODS());
});

test('latency: empty lane -> every method {n 0, p50Ns null, p99Ns null, belowFloor 0}', () => {
    const j = new LatencyLane({ floorNs: 40 }).toJSON();
    for (const m of METHODS()) assert.deepEqual(j[m], EMPTY, m);
});

test('latency observe: 3 below floor (0, 10, 39.9) + 97 x 1000 -> n 100, belowFloor 3, p50/p99 in [990, 1010]', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    for (const v of [0, 10, 39.9]) lane.observe('set', v);
    for (let i = 0; i < 97; i++) lane.observe('set', 1000);
    const e = lane.toJSON().set;
    assert.equal(e.n, 100);
    assert.equal(e.belowFloor, 3);
    assert.ok(e.p50Ns >= 990 && e.p50Ns <= 1010, 'p50 ' + e.p50Ns);
    assert.ok(e.p99Ns >= 990 && e.p99Ns <= 1010, 'p99 ' + e.p99Ns);
    assert.equal(Number.isInteger(e.p50Ns) && Number.isInteger(e.p99Ns), true, 'pXX = Math.round(...)');
    for (const m of METHODS()) if (m !== 'set') assert.deepEqual(lane.toJSON()[m], EMPTY, m + ' untouched');
});

test('latency observe: 60 below + 40 x 1000 -> p50 null (rank in the below-floor mass; null is not zero), p99 in [990, 1010]', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    for (let i = 0; i < 60; i++) lane.observe('read', 5);
    for (let i = 0; i < 40; i++) lane.observe('read', 1000);
    const e = lane.toJSON().read;
    assert.equal(e.n, 100);
    assert.equal(e.belowFloor, 60);
    assert.equal(e.p50Ns, null);
    assert.ok(e.p99Ns >= 990 && e.p99Ns <= 1010, 'p99 ' + e.p99Ns);
});

test('latency observe: a value exactly at the floor is NOT below it (S[0] < floor is the test)', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    lane.observe('peek', 40);
    assert.equal(lane.toJSON().peek.belowFloor, 0);
    assert.equal(lane.toJSON().peek.n, 1);
});

/* seeded 32-bit-exact PRNG (mulberry32) */
function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('latency observe: 10k log-uniform values in [1e3, 1e9] -> p99 within 1% of sorted[floor(0.99 x 9999)]; p50 likewise (exact sort reference)', () => {
    const rnd = prng(0x1A7E0001);
    const vals = [];
    const lane = new LatencyLane({ floorNs: 40 });
    for (let i = 0; i < 10000; i++) { const v = Math.exp(Math.log(1e3) + rnd() * (Math.log(1e9) - Math.log(1e3))); vals.push(v); lane.observe('effect', v); }
    vals.sort((a, b) => a - b);
    const e = lane.toJSON().effect;
    assert.equal(e.n, 10000);
    assert.equal(e.belowFloor, 0);
    const w99 = vals[Math.floor(0.99 * 9999)], w50 = vals[Math.floor(0.5 * 9999)];
    assert.ok(Math.abs(e.p99Ns - w99) <= 0.01 * w99 + 0.5, 'p99 ' + e.p99Ns + ' vs ' + w99);
    assert.ok(Math.abs(e.p50Ns - w50) <= 0.01 * w50 + 0.5, 'p50 ' + e.p50Ns + ' vs ' + w50);
});

test('latency reset(): after observations every method is back to n 0 / nulls; the lane is reusable', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    for (const m of METHODS()) { lane.observe(m, 1000); lane.observe(m, 3); }
    assert.ok(METHODS().every((m) => lane.toJSON()[m].n === 2));
    lane.reset();
    for (const m of METHODS()) assert.deepEqual(lane.toJSON()[m], EMPTY, m);
    lane.observe('close', 500);
    assert.equal(lane.toJSON().close.n, 1);
});

/* ---- ASSERTION 2: transparency ------------------------------------------------------------------- */

const tapOf = () => ({ escape: null, onOpen() {} });
const cycleSeed = seedFor(0x71A7E, GRAPH.index, 0);
const scriptFor = (w) => generateWorld(GRAPH, worldSeed(cycleSeed, w), { large: false, covOff: null });
const scrub = (r) => JSON.parse(JSON.stringify(r));

function play(adapterFor, w) {
    const tap = tapOf();
    const r = runWorld(tapAdapter(adapterFor(), tap), scriptFor(w));
    return { r: scrub(r), escape: tap.escape === null ? null : scrub(tap.escape) };
}

/** Test-local mutant: a wrapper that DROPS the second argument of every method (the must-fail control of the oracle). */
function dropB(adapter) {
    const open = function open(opts) {
        const raw = adapter.open(opts);
        const W = {};
        for (const k of Object.keys(raw)) { const f = raw[k]; W[k] = typeof f === 'function' ? function (a) { return f.call(raw, a); } : f; }
        return W;
    };
    return Object.freeze(Object.create(adapter, { open: { value: open, enumerable: true } }));
}

test('latency transparency: 64 seeds x GRAPH/BATCH/ERROR/NEST armed -> runWorld result and tap.escape deepStrictEqual the unwrapped run; every method but settle timed; escapes seen', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    const wrapped = lane.wrap(liteAdapter);
    const tot = {};
    for (const m of METHODS()) tot[m] = 0;
    let escapes = 0;
    for (const name of ['GRAPH', 'BATCH', 'ERROR', 'NEST']) {
        const L = laneByName(name);
        const cs = seedFor(0x71A7E, L.index, 0);
        for (let w = 0; w < 64; w++) {
            const sc = () => generateWorld(L, worldSeed(cs, w), { large: false, covOff: null });
            const run1 = (ad) => { const tap = tapOf(); const r = runWorld(tapAdapter(ad, tap), sc()); return { r: scrub(r), escape: tap.escape === null ? null : scrub(tap.escape) }; };
            const plain = run1(liteAdapter);
            lane.reset();
            lane.armed = true;
            const armed = run1(wrapped);
            lane.armed = false;
            assert.deepStrictEqual(armed, plain, name + ' world ' + w);
            if (plain.escape !== null && plain.escape.length !== 0) escapes++;
            const j = lane.toJSON();
            for (const m of METHODS()) tot[m] += j[m].n;
        }
    }
    assert.ok(METHODS().filter((m) => m !== 'settle').every((m) => tot[m] > 0), 'every method timed: ' + JSON.stringify(tot));
    assert.ok(escapes > 0, 'non-empty tap.escape seen: ' + escapes);
});

test('latency transparency MUST-FAIL: a wrapper that drops arg b changes the result of at least one of the 64 seeds (the oracle can see a difference)', () => {
    let differing = 0;
    for (let w = 0; w < 64; w++) {
        const plain = play(() => liteAdapter, w);
        let bad;
        try { bad = play(() => dropB(liteAdapter), w); } catch (e) { differing++; continue; }
        try { assert.deepStrictEqual(bad, plain); } catch { differing++; }
    }
    assert.ok(differing > 0, 'the mutant went unnoticed on all 64 seeds');
});

test('latency: unarmed worlds record nothing (all n 0) and the open returns the raw world itself', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    const wrapped = lane.wrap(liteAdapter);
    for (let w = 0; w < 8; w++) play(() => wrapped, w);
    const j = lane.toJSON();
    for (const m of METHODS()) assert.deepEqual(j[m], EMPTY, m);
    let rawSeen = null;
    const probe = Object.freeze({ name: 'probe', open() { rawSeen = { signal(a) { return a; } }; return rawSeen; } });
    assert.equal(lane.wrap(probe).open(), rawSeen, 'unarmed open returns the raw world');
});

test('latency: a stub world with an unclassified method "frob" -> TypeError /unclassified world method frob/ at the first armed open', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    const stub = Object.freeze({ name: 'stub', open() { return { signal(a) { return a; }, frob(a) { return a; } }; } });
    const wrapped = lane.wrap(stub);
    lane.armed = true;
    assert.throws(() => wrapped.open(), (e) => e instanceof TypeError && /unclassified world method frob/.test(e.message));
});

test('latency: a listed method with length 3 -> TypeError at the armed open', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    const stub = Object.freeze({ name: 'stub', open() { return { set(a, b, c) { return a; } }; } });
    const wrapped = lane.wrap(stub);
    lane.armed = true;
    assert.throws(() => wrapped.open(), TypeError);
});

test('latency: LATENCY_UNTIMED names (normalizeEscape, stats, links) are classified, not rejected, and never timed', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    const stub = Object.freeze({ name: 'stub', open() { return { normalizeEscape(e) { return e; }, stats() { return 1; }, links() { return 2; }, registry: {} }; } });
    lane.armed = true;
    const w = lane.wrap(stub).open();
    assert.equal(w.stats(), 1);
    assert.equal(w.links(), 2);
    for (const m of METHODS()) assert.equal(lane.toJSON()[m].n, 0, m);
});

test('latency: a throwing call passes through untouched and is NOT timed (returning calls only)', () => {
    const lane = new LatencyLane({ floorNs: 1 });
    const boom = new Error('boom');
    const stub = Object.freeze({ name: 'stub', open() { return { set() { throw boom; }, read() { return 7; } }; } });
    lane.armed = true;
    const w = lane.wrap(stub).open();
    assert.throws(() => w.set(), (e) => e === boom);
    assert.equal(lane.toJSON().set.n, 0);
    assert.equal(w.read(), 7);
    assert.equal(lane.toJSON().read.n, 1);
});

/* ---- ASSERTION 3: GC ------------------------------------------------------------------------------ */

function child(flags, src) {
    const r = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', src],
        { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

const BIG_SEMI = ['--expose-gc', '--max-semi-space-size=64', '--min-semi-space-size=64'];

/* b122 F7 (c): a GC-COUNT window replaces the heapUsed slope (b118 read -0.0172 B/op under load: JIT code / metadata of
 * the tier-up landed in the short window, t71-attrib.txt). A 1 MB semi-space (S = 1,048,576 B) means any young
 * allocation A forces >= floor(A / S) GCs, so N = 4e6 ops with 0 events bounds observe() below S / N = 0.262 B/op.
 * --single-threaded makes the tier-up depend on the call budget only, not on host load. The window counts EVERY
 * event kind (a major would also hide young allocation). minorsOf fails closed: any gcType not a known major /
 * incremental / weak-callback pass counts as a minor ('MinorMarkSweep' is the --minor-ms kind on node v26.8.2).
 * .handoff/b122-evidence/witness-t71.mjs loads this block (minorsOf .. GC_SRC) from this file's text: keep it
 * self-contained. */
function minorsOf(stats) {
    let m = 0;
    for (const e of stats) if (e.gcType !== 'MarkSweepCompact' && e.gcType !== 'IncrementalMarking' && e.gcType !== 'ProcessWeakCallbacks') m++;
    return m;
}
const windowOk = (stats) => stats.length === 0;
const GC_KINDS = ['Scavenge', 'MinorMarkSweep', 'MarkSweepCompact', 'IncrementalMarking', 'ProcessWeakCallbacks'];
const GC_FLAGS = ['--expose-gc', '--single-threaded', '--min-semi-space-size=1', '--max-semi-space-size=1'];
const GC_SRC = `
import v8 from 'node:v8';
import { LatencyLane } from './bench/soak/latency.mjs';
${minorsOf.toString()}
if (typeof v8.GCProfiler !== 'function' || typeof gc !== 'function') throw new Error('t71: v8.GCProfiler and gc() are required');
const lane = new LatencyLane({ floorNs: 40 });
const BOX = ['tagged'];
let sink = null;
const real = (n) => { for (let i = 0; i < n; i++) lane.observe('set', 50 + (i & 1023)); };
// controls: one 16 B HeapNumber per op (a double stored into a tagged array) / one 32 B object per op
const box = (n) => { for (let i = 0; i < n; i++) { lane.observe('set', 50 + (i & 1023)); BOX[0] = i + 0.5; } };
const obj = (n) => { for (let i = 0; i < n; i++) { lane.observe('set', 50 + (i & 1023)); sink = { i }; } };
const win = (fn, n) => { gc(); const p = new v8.GCProfiler(); p.start(); fn(n); return p.stop().statistics; };
for (let i = 0; i < 200000; i++) lane.observe('set', 50 + (i & 1023));
real(200000); box(200000); obj(200000);
const N = 4000000;
const r = win(real, N), b = win(box, N), o = win(obj, N);
const kinds = (s) => s.map((e) => e.gcType);
process.stdout.write(JSON.stringify({ N, flags: process.execArgv.filter((a) => a.startsWith('--') && a !== '--input-type=module'), real: kinds(r), boxMinors: minorsOf(b), objMinors: minorsOf(o),
    boxKinds: [...new Set(kinds(b))], objKinds: [...new Set(kinds(o))], used: sink !== null && BOX[0] !== 'tagged' }));
`;

/* b125 (FILLER 38): CONTROL FLOORS from measurement (node v26.8.2 darwin, 3 runs this round, load1 7.1): the 16 B/op box
 * control counted 61 minors and the 32 B/op object control 122 (= 16N / S and 32N / S); at a 2 MB semi-space they count
 * 30 / 61 (b125 must-fail run). The old floors (32) proved only <= 2,000,000 B per minor (0.5 B/op);
 * at 2 MB the old object floor passed (61 >= 32). Floors 55 / 110 (~90%) fail a 2 MB semi-space, so they
 * PROVE <= 16 x 4e6 / 55 = 1,163,637 B per minor: resolution <= 16 / 55 = 0.291 B/op (nominal S / N = 0.262 B/op). */
const BOX_FLOOR = 55, OBJ_FLOOR = 110;

test('latency GC: observe() allocates nothing -- 0 GC events (any kind, v8.GCProfiler) over N = 4e6 ops in a 1 MB semi-space, --single-threaded (resolution 0.262 B/op; floor-proven <= 0.291 B/op); TRANSIENT 16 B/op box and 32 B/op object controls count >= 55 / >= 110 minors', () => {
    const o = child(GC_FLAGS, GC_SRC);
    console.log('latency GC window: real events ' + JSON.stringify(o.real) + ' | box control minors ' + o.boxMinors + ' ' + JSON.stringify(o.boxKinds) +
        ' | object control minors ' + o.objMinors + ' ' + JSON.stringify(o.objKinds));
    assert.deepEqual(o.flags, GC_FLAGS, 'the child runs under the pinned flags');
    assert.equal(o.N, 4000000);
    assert.equal(o.used, true);
    for (const k of [...o.real, ...o.boxKinds, ...o.objKinds]) assert.ok(GC_KINDS.includes(k), 'unknown gcType ' + k + ' (fail closed)');
    assert.ok(o.boxMinors >= BOX_FLOOR, 'the 16 B/op box control must count >= ' + BOX_FLOOR + ' minors, got ' + o.boxMinors);
    assert.ok(o.objMinors >= OBJ_FLOOR, 'the 32 B/op object control must count >= ' + OBJ_FLOOR + ' minors, got ' + o.objMinors);
    assert.ok(windowOk(o.real), 'observe() window saw GC events ' + JSON.stringify(o.real));
});

test('latency GC: 32 armed worlds x 3 cycles under lite-leak -> tracker size 0 after forced GC each cycle', () => {
    const o = child(BIG_SEMI, `
import { createLeakTracker } from '@zakkster/lite-leak';
import { LatencyLane } from './bench/soak/latency.mjs';
import { runWorld } from './bench/soak/exec.mjs';
import { tapAdapter } from './bench/soak/main.mjs';
import { liteAdapter } from './bench/soak/adapters/lite.mjs';
import { laneByName } from './bench/soak/lanes/index.mjs';
const GRAPH = laneByName('GRAPH');
import { generateWorld } from './bench/soak/gen.mjs';
import { seedFor, worldSeed } from './bench/soak/seeds.mjs';
const tracker = createLeakTracker({ name: 't71' });
const lane = new LatencyLane({ floorNs: 40 });
const ad = (tap) => tapAdapter(lane.wrap(liteAdapter), tap);
const sizes = [];
let ns = 0;
function cycle(c) {
    const tap = { escape: null, onOpen(w) { tracker.track(w.registry, null, 'G'); } };
    const a = ad(tap);
    lane.reset();
    lane.armed = true;
    for (let w = 0; w < 32; w++) runWorld(a, generateWorld(GRAPH, worldSeed(seedFor(71, GRAPH.index, c), w), { large: false, covOff: null }));
    lane.armed = false;
    const j = lane.toJSON();
    for (const k of Object.keys(j)) ns += j[k].n;
}
for (let c = 0; c < 3; c++) {
    cycle(c);
    for (let t = 0; t < 40 && tracker.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 20)); }
    sizes.push(tracker.size());
}
process.stdout.write(JSON.stringify({ sizes, ns }));
`);
    assert.deepEqual(o.sizes, [0, 0, 0]);
    assert.ok(o.ns > 0, 'the armed worlds were actually measured');
});

test('latency: a missing lite-sketch -> exit 2, soak: CONFIG -- latency lane unavailable, no output path created', () => {
    const dir = mkdtempSync(join(tmpdir(), 't71-'));
    const out = join(dir, 'out');
    const hook = "export async function resolve(s, c, n) { if (s === '@zakkster/lite-sketch') throw new Error('hidden by test'); return n(s, c); }";
    const reg = "import{register}from'node:module';register(" + JSON.stringify('data:text/javascript,' + encodeURIComponent(hook)) + ");";
    const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'data:text/javascript,' + encodeURIComponent(reg), 'bench/soak/main.mjs'],
        { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { SOAK_SMOKE: '1', SOAK_LANES: 'GRAPH', SOAK_OUT: out }) });
    try {
        assert.equal(r.status, 2, r.stdout + r.stderr);
        assert.ok((r.stderr + r.stdout).includes('soak: CONFIG -- latency lane unavailable'), r.stderr);
        assert.equal(existsSync(out), false, 'no output created');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('latency GC MUST-FAIL (b122, pure): minorsOf counts Scavenge, MinorMarkSweep (--minor-ms on node v26.8.2) and an Unknown kind as minors, never MarkSweepCompact / IncrementalMarking / ProcessWeakCallbacks; windowOk rejects any event, a weak-callback pass included', () => {
    for (const k of ['Scavenge', 'MinorMarkSweep', 'Unknown']) assert.equal(minorsOf([{ gcType: k }]), 1, k);
    for (const k of ['MarkSweepCompact', 'IncrementalMarking', 'ProcessWeakCallbacks']) assert.equal(minorsOf([{ gcType: k }]), 0, k);
    assert.equal(windowOk([{ gcType: 'ProcessWeakCallbacks' }]), false);
    assert.equal(windowOk([]), true);
    assert.ok(GC_KINDS.includes('MinorMarkSweep') && !GC_KINDS.includes('Unknown'), 'the fail-closed kind list');
});

test('latency (b88 NIT): a listed method with a rest parameter (a, ...r) -> TypeError at the armed open (HEAD accepts: length 1)', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    const stub = Object.freeze({ name: 'stub', open() { return { set(a, ...r) { return a; } }; } });
    lane.armed = true;
    assert.throws(() => lane.wrap(stub).open(), TypeError);
});

test('latency (b88 NIT): a listed method with a default parameter (a, b, c = 1) -> TypeError at the armed open (HEAD accepts: length 2)', () => {
    const lane = new LatencyLane({ floorNs: 40 });
    const stub = Object.freeze({ name: 'stub', open() { return { set(a, b, c = 1) { return a; } }; } });
    lane.armed = true;
    assert.throws(() => lane.wrap(stub).open(), TypeError);
});

/* ---- b88 r1 F1: paramsHidden reads the parameter list up to the first `)` or `=>`; [native code] is refused ---- */

const armOpen = (fn) => {
    const lane = new LatencyLane({ floorNs: 40 });
    const stub = Object.freeze({ name: 'stub', open() { return { set: fn }; } });
    lane.armed = true;
    return () => lane.wrap(stub).open();
};
const REFUSED_F1 = [
    ['function (a, {x} = {}, c, d) {} (length 1)', function (a, {x} = {}, c, d) {}],
    ['({x} = {}, ...r) => 0 (length 0)', ({x} = {}, ...r) => 0],
    ['(a /* { */, ...r) => 0 (length 1)', (a /* { */, ...r) => 0],
    ['a .bind(null) of a rest-param function (length 1)', (function (a, ...r) { return a; }).bind(null)],
    ['a .bind(null) of a default-param function (length 1)', (function (a, b = 1) { return a; }).bind(null)],
];
for (const [name, fn] of REFUSED_F1) {
    test('latency (b88 r1 F1): a listed method ' + name + ' -> TypeError at the armed open (the `{`-cut / native-skip paramsHidden accepts it)', () => {
        assert.ok(fn.length <= 2, 'Function.length alone does not refuse it: ' + fn.length);
        assert.throws(armOpen(fn), (e) => e instanceof TypeError && /rest, default or unreadable parameter list/.test(e.message));
    });
}
const ACCEPTED_F1 = [
    ['(a, b) => a', (a, b) => a],
    ['x => x', (x) => x],
    ['({a}) => a', ({a}) => a],
    ['function (a) { const q = 1; return a; }', function (a) { const q = 1; return a; }],
];
for (const [name, fn] of ACCEPTED_F1) {
    test('latency (b88 r1 F1 control): a listed method ' + name + ' is ACCEPTED at the armed open and stays callable', () => {
        const w = armOpen(fn)();
        assert.equal(typeof w.set, 'function');
        const arg = { a: 7 };
        assert.equal(w.set(arg, 8), fn(arg, 8), 'the wrapper forwards the call unchanged');
    });
}

/* ---- b90 C2 (b88 r2 NITs): the first `)` sits inside a computed key or a comment, so the cut misses the `...` ---- */
const keyOf = (x) => x;
const REFUSED_R2 = [
    ['[keyOf(\'set\')](a, ...r) {} (computed-key method, length 1)', ({ [keyOf('set')](a, ...r) { return a; } }).set],
    ['(a /* ) */, ...r) => 0 (length 1)', (a /* ) */, ...r) => 0],
    ['async[keyOf(\'set\')](a, ...r) {} (no-space async computed key, length 1)', ({ async[keyOf('set')](a, ...r) { return a; } }).set],
    ['\')\'(a, ...r) {} (string-literal key holding a paren, length 1)', ({ ')'(a, ...r) { return a; } })[')']],
    ['({ [keyOf(\'q\')]: x }, ...r) => 0 (computed key in a destructuring pattern, length 1)', ({ [keyOf('q')]: x }, ...r) => 0],
];
for (const [name, fn] of REFUSED_R2) {
    test('latency (b90 C2): a listed method ' + name + ' -> TypeError at the armed open (the first-`)` cut accepts it)', () => {
        assert.ok(fn.length <= 2, 'Function.length alone does not refuse it: ' + fn.length);
        assert.throws(armOpen(fn), (e) => e instanceof TypeError && /rest, default or unreadable parameter list/.test(e.message));
    });
}
const ACCEPTED_R2 = [
    ['(a, b) => a (plain arrow)', (a, b) => a],
    ['set(a, b) { return a; } (plain method)', ({ set(a, b) { return a; } }).set],
];
for (const [name, fn] of ACCEPTED_R2) {
    test('latency (b90 C2 control): a listed method ' + name + ' is ACCEPTED at the armed open (no over-refusal)', () => {
        const w = armOpen(fn)();
        assert.equal(typeof w.set, 'function');
        const arg = { a: 7 };
        assert.equal(w.set(arg, 8), fn(arg, 8), 'the wrapper forwards the call unchanged');
    });
}
