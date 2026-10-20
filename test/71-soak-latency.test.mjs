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

function child(src) {
    const r = spawnSync(process.execPath, ['--expose-gc', '--max-semi-space-size=64', '--min-semi-space-size=64', '--input-type=module', '-e', src],
        { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('latency GC: observe() slope (delta(N) - delta(N/10)) / 0.9N <= 0.01 B/op, N = 1e6 (a fixed offset is not per-op); a per-op allocating control must exceed it', () => {
    const o = child(`
import { LatencyLane } from './bench/soak/latency.mjs';
const lane = new LatencyLane({ floorNs: 40 });
const run = (fn, n) => { gc(); gc(); const b = process.memoryUsage().heapUsed; fn(n); return process.memoryUsage().heapUsed - b; };
const real = (n) => { for (let i = 0; i < n; i++) lane.observe('set', 50 + (i & 1023)); };
for (let i = 0; i < 200000; i++) lane.observe('set', 50 + (i & 1023));
const N = 1000000;
const d1 = run(real, N / 10), d8 = run(real, N);
// control: one TRANSIENT small object per op (both windows fit the pinned 64 MB semi-space, so no scavenge hides it)
let sink;
const bad = (n) => { for (let i = 0; i < n; i++) { lane.observe('set', 50 + (i & 1023)); sink = { i }; } };
const c1 = run(bad, N / 10), c2 = run(bad, N);
process.stdout.write(JSON.stringify({ slope: (d8 - d1) / (0.9 * N), ctl: (c2 - c1) / (0.9 * N) }));
`);
    console.log('latency GC slope B/op: ' + o.slope + ' (control ' + o.ctl + ')');
    assert.ok(o.slope <= 0.01, 'slope B/op ' + o.slope);
    assert.ok(o.ctl > 8, 'the allocating control must exceed the bound, got ' + o.ctl);
});

test('latency GC: 32 armed worlds x 3 cycles under lite-leak -> tracker size 0 after forced GC each cycle', () => {
    const o = child(`
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
