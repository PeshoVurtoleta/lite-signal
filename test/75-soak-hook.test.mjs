// 75-soak-hook.test.mjs -- S3 rung R1 HOOK (burst 93; .handoff/PLAN-0s-s3-r1.md ASSERTIONS). Part 1 (batch R1a):
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
//   A1  seed fix: the remap pair is decided over the lane INDEX span (lanes/index.mjs laneSpan) and kept only when
//       both lanes are rostered (rosterRemapCollision); the header records it (provenance.mjs). Controls: the old
//       roster-SIZE formula misses the pair; a pair on an unrostered index inside the span is null (exactness).
//   A2  mirror.mjs + O8 units (oracles.mjs checkHookFire / checkMirror): each mirror problem detail fires alone on a
//       hand-built stream, a clean op1, op3, op2, op4, op5 stream is silent, rule I3 (op 2 drops SOURCE edges) holds on
//       the real tree kernel, and a delivery to an off'd listener is the DIV-F9 ghost shape.
// Part 2 (batch R1b):
//   A3  the HOOK lane (lanes/hook.mjs): roster / wiring, the generator rules (L0 at op 0, H2, 2..5 live, cov-off
//       LIFO), headpatched passes with one O8 per op, rev152 + tree are red with the DIV-F9 ghost, mirror-links has
//       teeth (op-4 deliveries dropped), exec fails closed on malformed hook ops, S1 lanes perform no O8.
//   A4  retention: 1000 HOOK worlds on lite-s3 over headpatched, lite-leak tracker.size() === 0 per 100-world block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { classify } from '../bench/soak/divergences.mjs';
import { K } from '../bench/soak/kernel.mjs';
import { buildHeader } from '../bench/soak/provenance.mjs';
import { remapCollision, seedFor, REMAP_PREIMAGE, CYCLE_LIMIT } from '../bench/soak/seeds.mjs';
import { LANE_INDEX, ROSTER, laneSpan, rosterRemapCollision, laneByName, ALL_SCENARIOS } from '../bench/soak/lanes/index.mjs';
import { Mirror, PROBLEM_CAP } from '../bench/soak/mirror.mjs';
import { checkHookFire, checkMirror, ORACLES, SIGS } from '../bench/soak/oracles.mjs';
import { runWorld, CHECK_NAMES } from '../bench/soak/exec.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import { liteS3Adapter, liteS3AdapterFor } from '../bench/soak/adapters/lite-s3.mjs';
import { ORACLE_CAPS } from '../bench/soak/adapters/contract.mjs';
import { oracleFamily } from '../bench/soak/gates.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_SEED = 0xC0FFEE;
const NAME_AT = Object.fromEntries(Object.entries(LANE_INDEX).map(([n, i]) => [i, n]));
// DIV-F9's shape (PLAN-0s-s3-r1.md TASK 8), literal
const DIV_F9 = new RegExp(JSON.parse(readFileSync(ROOT + 'bench/soak/divergences.json', 'utf8')).entries.find((e) => e.id === 'DIV-F9').shapes[0].detail);

/* ---- A1: the seed fix ---------------------------------------------------------------------------- */

test('A1 laneSpan is max LANE_INDEX + 1 of the roster, not its size; unknown or empty rosters throw', () => {
    assert.equal(laneSpan(['GRAPH', 'BATCH', 'ERROR', 'NEST', 'WIE']), 5, 'the S1 roster');
    assert.equal(laneSpan(ROSTER), 7, 'ROSTER (S1 + HOOK since R1b): 6 lanes, 7 indices');
    assert.equal(laneSpan(['GRAPH', 'SCHEDULER']), 9);
    assert.equal(laneSpan(['SNAPSHOT']), 14);
    assert.throws(() => laneSpan(['GRAPH', 'NOPE']), /no LANE_INDEX entry/);
    assert.throws(() => laneSpan([]), TypeError);
    assert.throws(() => laneSpan('GRAPH'), TypeError);
});

test('A1 the remap pair always pairs lane L with L ^ 8 (REMAP_PREIMAGE & 15 === 8)', () => {
    assert.equal(REMAP_PREIMAGE & 15, 8);
});

// every named (L, L ^ 8) pair: a 2-lane roster, base = L (pA = lane L, cycle 0), pB = lane L ^ 8 >= roster length
const PAIRS = [];
for (let lo = 0; lo < 8; lo++) if (NAME_AT[lo] !== undefined && NAME_AT[lo ^ 8] !== undefined) PAIRS.push([lo, lo ^ 8]);

test('A1 rosterRemapCollision returns the pair whose lane index is >= the roster length; the old size formula misses it', () => {
    assert.ok(PAIRS.length >= 6, 'named pairs (0,8)..(5,13): ' + JSON.stringify(PAIRS));
    for (const [lo, hi] of PAIRS) {
        const roster = [NAME_AT[lo], NAME_AT[hi]];
        const cB = ((lo ^ REMAP_PREIMAGE) >>> 0) >>> 4;
        const want = { cycleA: 0, laneA: lo, cycleB: cB, laneB: hi };
        for (const cycles of [cB + 1, 0]) {
            const hit = rosterRemapCollision(lo, roster, cycles);
            assert.deepEqual(hit, want, roster.join('+') + ' cycles ' + cycles);
            assert.ok(hit.laneB >= roster.length, 'a lane >= the roster length');
            assert.equal(seedFor(lo, hit.laneA, hit.cycleA), seedFor(lo, hit.laneB, hit.cycleB), 'the pair really shares a seed');
            // control: the pre-R1 formula (roster SIZE as the lane count) reports no pair for the same run
            assert.equal(remapCollision(lo, roster.length, cycles), null, 'old formula, ' + roster.join('+'));
        }
        assert.equal(rosterRemapCollision(lo, roster, cB), null, 'control: one cycle short of cycleB');
    }
});

test('A1 exactness: a pair on an UNROSTERED index inside the span is null; rostering that index brings it back', () => {
    const RH = ROSTER;   // S1 + HOOK (R1b)
    // the plan literal: ROSTER + HOOK spans 7, so pair (5, 13) is outside the span already -> null
    assert.equal(rosterRemapCollision(5, RH, 0), null);
    assert.equal(rosterRemapCollision(13, RH, 0), null);
    // with teeth: + SNAPSHOT (13) spans 14, so the span check alone REPORTS (5, 13); index 5 (LIFECYCLE) holds no lane
    const RHS = RH.concat(['SNAPSHOT']);
    assert.equal(laneSpan(RHS), 14);
    assert.notEqual(remapCollision(5, laneSpan(RHS), 0), null, 'the span-only check sees the pair');
    assert.equal(rosterRemapCollision(5, RHS, 0), null, 'base 5: laneA 5 unrostered');
    assert.notEqual(remapCollision(13, laneSpan(RHS), 0), null);
    assert.equal(rosterRemapCollision(13, RHS, 0), null, 'base 13: roles swap, laneB 5 unrostered');
    // rostering LIFECYCLE turns both back on (the null above is the rostered-index rule, nothing else)
    const RHSL = RHS.concat(['LIFECYCLE']);
    assert.deepEqual(rosterRemapCollision(5, RHSL, 0), remapCollision(5, 14, 0));
    assert.deepEqual(rosterRemapCollision(13, RHSL, 0), remapCollision(13, 14, 0));
    // ROSTER + HOOK can never hold a pair (every pair has a lane >= 8): exhaustive over the 16 lane residues
    for (let r = 0; r < 16; r++) assert.equal(rosterRemapCollision(r, RH, 0), null, 'residue ' + r);
    assert.throws(() => rosterRemapCollision(0, ['GRAPH'], CYCLE_LIMIT + 1), RangeError);
});

const EXTRAS = { kind: 'burn-in', engine: { name: 'lite', version: null, caps: null, files: [] }, laneRoster: [], lanes: [], scenarios: {}, oraclesNA: {}, genRules: [], divergences: null };
const stubCfg = (seed, roster, cycles) => ({ requireProvenance: false, record: {}, mustFail: null, seed, roster, cycles });

test('A1 header: seedRemapCollision is the rostered-index pair (provenance.mjs), null for the default S1 run', () => {
    const cB = (REMAP_PREIMAGE >>> 0) >>> 4;
    const h = buildHeader(stubCfg(0, ['GRAPH', 'SCHEDULER'], 0), EXTRAS);
    assert.deepEqual(h.seedRemapCollision, { cycleA: 0, laneA: 0, cycleB: cB, laneB: 8 });
    const h2 = buildHeader(stubCfg(3, ['NEST', 'RECYCLE'], cB + 1), EXTRAS);
    assert.deepEqual(h2.seedRemapCollision, { cycleA: 0, laneA: 3, cycleB: ((3 ^ REMAP_PREIMAGE) >>> 0) >>> 4, laneB: 11 });
    assert.equal(buildHeader(stubCfg(DEFAULT_SEED, ROSTER, 11), EXTRAS).seedRemapCollision, null);
    assert.equal(buildHeader(stubCfg(5, ROSTER.concat(['SNAPSHOT']), 0), EXTRAS).seedRemapCollision, null, 'exactness through the header');
});

/* ---- A2: mirror + O8 ----------------------------------------------------------------------------- */

const STATS = (links, nodes) => ({ activeLinks: links, activeNodes: nodes });
function run(stream) {
    const m = new Mirror();
    for (const [op, a, b] of stream) m.apply(op, a, b);
    return m;
}
const details = (fails) => fails.map((f) => f.oracle + '/' + f.sig + ': ' + f.detail);

test('A2 clean stream op1, op3, op2, op4, op5 is silent (mid-stream and at rest)', () => {
    const m = new Mirror();
    for (const e of [[1, 1, 32], [1, 2, 1], [1, 3, 2], [3, 1, 2], [3, 2, 3]]) assert.equal(m.apply(...e), true);
    assert.deepEqual(checkMirror(m, STATS(2, 3)), []);
    // dispose 2: op 2 first (drops 2 -> 3, I3), then its dep edge 1 -> 2 emits op 4; then a recompute on 3
    for (const e of [[2, 2, 1], [4, 1, 2], [5, 3, 0]]) assert.equal(m.apply(...e), true);
    assert.equal(m.edges, 0);
    assert.equal(m.nodes, 2);
    assert.deepEqual(checkMirror(m, STATS(0, 2)), []);
});


test('A2 every mirror problem detail fires ALONE on a hand-built stream', () => {
    const one = (stream, stats, want) => {
        assert.deepEqual(details(checkMirror(run(stream), stats)), ['O8/mirror-links: ' + want], JSON.stringify(stream));
    };
    // 1 op1 id outside [1, 2^31-1] (0, 2^31, a fraction, a non-number); 2^31-1 itself is a valid id
    one([[1, 0, 32]], STATS(0, 0), 'op1 id 0 outside [1, 2^31-1]');
    one([[1, 2 ** 31, 32]], STATS(0, 0), 'op1 id 2147483648 outside [1, 2^31-1]');
    one([[1, 1.5, 32]], STATS(0, 0), 'op1 id 1.5 outside [1, 2^31-1]');
    one([[1, '7', 32]], STATS(0, 0), 'op1 id string outside [1, 2^31-1]');
    assert.deepEqual(checkMirror(run([[1, 0x7fffffff, 32]]), STATS(0, 1)), []);
    // 2 op1 id already live
    one([[1, 4, 32], [1, 4, 32]], STATS(0, 1), 'op1 id 4 already live');
    // 3 op3 / op4 on a non-live id (either end of op3; op4's source; op4's target when no such edge)
    one([[1, 1, 32], [3, 1, 9]], STATS(0, 1), 'op3 on non-live id 9');
    one([[1, 1, 32], [3, 9, 1]], STATS(0, 1), 'op3 on non-live id 9');
    one([[1, 1, 32], [4, 9, 1]], STATS(0, 1), 'op4 on non-live id 9');
    one([[1, 1, 32], [4, 1, 9]], STATS(0, 1), 'op4 on non-live id 9');
    // a dead node's own dep edge is NOT a problem: op 2 fires before its dep op-4s (B0-7)
    assert.deepEqual(checkMirror(run([[1, 1, 32], [1, 2, 2], [3, 1, 2], [2, 2, 2], [4, 1, 2]]), STATS(0, 1)), []);
    // 4 op4 on an absent edge between live nodes (and a second op4 of a single edge)
    one([[1, 1, 32], [1, 2, 1], [4, 1, 2]], STATS(0, 2), 'op4 on absent edge 1 -> 2');
    one([[1, 1, 32], [1, 2, 1], [3, 1, 2], [4, 1, 2], [4, 1, 2]], STATS(0, 2), 'op4 on absent edge 1 -> 2');
    // 5 mirror edges != activeLinks
    one([[1, 1, 32], [1, 2, 1], [3, 1, 2]], STATS(2, 2), 'mirror edges 1 != activeLinks 2');
    // 6 mirror nodes != activeNodes
    one([[1, 1, 32], [1, 2, 1]], STATS(0, 3), 'mirror nodes 2 != activeNodes 3');
    // fail closed beyond the six: op 2 / op 5 on a non-live id, an unknown op
    one([[2, 3, 32]], STATS(0, 0), 'op2 on non-live id 3');
    one([[5, 3, 0]], STATS(0, 0), 'op5 on non-live id 3');
    one([[6, 1, 1]], STATS(0, 0), 'unknown op 6');
});

test('A2 checkMirror drains the problem list (a second check is silent); the list is capped with a count line', () => {
    const m = run([[1, 0, 32]]);
    assert.equal(checkMirror(m, STATS(0, 0)).length, 1);
    assert.deepEqual(checkMirror(m, STATS(0, 0)), []);
    const big = run(Array.from({ length: PROBLEM_CAP + 3 }, () => [1, 0, 32]));
    const got = checkMirror(big, STATS(0, 0)).map((f) => f.detail);
    assert.equal(got.length, PROBLEM_CAP + 1);
    assert.equal(got[PROBLEM_CAP], '... 3 more mirror problems');
});

test('A2 I3: op 2 drops every edge where the node is SOURCE (its subscriber edges are freed silently)', () => {
    // hand-built: signal 1 feeds 2 and 3; disposing 1 emits ONLY op 2 (B0-7 "signal-dispose-with-2-subs" -> 2:1:32)
    const m = run([[1, 1, 32], [1, 2, 1], [1, 3, 2], [3, 1, 2], [3, 1, 3], [2, 1, 32]]);
    assert.equal(m.edges, 0);
    assert.equal(m.edgeCount(1, 2), 0);
    assert.deepEqual(checkMirror(m, STATS(0, 2)), []);
    // a target's edges survive its source's neighbour being disposed: only SOURCE edges of the disposed id go
    const m2 = run([[1, 1, 32], [1, 2, 1], [1, 3, 2], [3, 1, 2], [3, 2, 3], [2, 3, 2]]);
    assert.equal(m2.edgeCount(1, 2), 1, 'edge 1 -> 2 is not touched by disposing 3');
    assert.equal(m2.edgeCount(2, 3), 1, 'edge 2 -> 3 (3 is the TARGET) waits for its op 4');
});

test('A2 I3 on the real tree kernel: the mirror of the hook stream equals stats() after each dispose shape', () => {
    const shapes = {
        'signal dispose, 2 subscribers': (r) => { const s = r.signal(1); const c = r.computed(() => s()); r.effect(() => { s(); c(); }); r.dispose(s); },
        'computed dispose': (r) => { const s = r.signal(1); const c = r.computed(() => s()); r.effect(() => { c(); }); r.dispose(c); },
        'effect stop': (r) => { const s = r.signal(1); const t = r.signal(2); const e = r.effect(() => { s(); t(); }); r.dispose(e); },
        'severTail': (r) => { const f = r.signal(true); const a = r.signal(1); const b = r.signal(2); r.effect(() => { if (f()) { a(); b(); } }); f.set(false); },
        'owned cascade': (r) => { const s = r.signal(1); const p = r.effect(() => { s(); const c = r.computed(() => s()); r.effect(() => { c(); }); }); s.set(2); r.dispose(p); },
    };
    for (const [name, fn] of Object.entries(shapes)) {
        const r = K.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
        const m = new Mirror();
        r.onGraphMutation((op, a, b) => { m.apply(op, a, b); });
        fn(r);
        const st = r.stats();
        assert.ok(m.events > 0, name + ': the hook fired');
        assert.deepEqual(details(checkMirror(m, st)), [], name);
        r.destroy();
    }
});

// L0 permanent, A = L1 live, B = L2 off'd at step 7 (non-LIFO: C above it), C = L3 off'd at step 9: the top live listener is A = L1
const STACK = () => [{ live: true, offStep: null }, { live: true, offStep: null }, { live: false, offStep: 7 }, { live: false, offStep: 9 }];

test('A2 checkHookFire: the top live listener is silent; an off\'d receiver is the DIV-F9 ghost shape', () => {
    assert.equal(checkHookFire(STACK(), 1, 3, 12), null);
    const g = checkHookFire(STACK(), 2, 1, 12);
    assert.deepEqual(g, { oracle: 'O8', sig: 'ghost-listener', detail: 'L2 received op1 after off at step 7 (expected L1)' });
    assert.match(g.detail, DIV_F9);
    assert.equal(checkHookFire(STACK(), 3, 5, 12).detail, 'L3 received op5 after off at step 9 (expected L1)');
});

test('A2 checkHookFire: a live NON-top receiver and an unknown index get details DIV-F9 does not match', () => {
    const lo = checkHookFire(STACK(), 0, 4, 12);
    assert.deepEqual(lo, { oracle: 'O8', sig: 'ghost-listener', detail: 'L0 received op4 at step 12 but L1 is the top live listener' });
    assert.doesNotMatch(lo.detail, DIV_F9);
    const un = checkHookFire(STACK(), 7, 2, 12);
    assert.equal(un.detail, 'L7 received op2 at step 12 but is not a subscribed listener');
    assert.doesNotMatch(un.detail, DIV_F9);
    // no live listener at all: any receiver is a ghost against 'none'
    const none = checkHookFire([{ live: false, offStep: 3 }], 0, 1, 4);
    assert.equal(none.detail, 'L0 received op1 after off at step 3 (expected none)');
});

const f9 = (detail, worldScen) => { const c = classify({ engine: 'lite', lane: 'HOOK', step: 40, op: 'sig', fails: [{ oracle: 'O8', sig: 'ghost-listener', detail }], scen: [], worldScen }); return c === null ? null : c.known; };
test('DIV-F9 (live registry, classify) explains only an off\'d receiver in a world with a non-LIFO off', () => {
    const NL = ['hook-non-lifo-off', 'hook-multi'];
    assert.equal(f9('L2 received op1 after off at step 7 (expected L1)', NL), 'DIV-F9');
    assert.equal(f9('L2 received op1 after off at step 7 (expected L1)', ['hook-multi']), null, 'no non-LIFO off in the world');
    assert.equal(f9('L0 received op4 at step 12 but L1 is the top live listener', NL), null, 'live non-top');
    assert.equal(f9('L0 received op1 after off at step 3 (expected none)', NL), null, 'expected none');
    assert.equal(f9('L7 received op2 at step 12 but is not a subscribed listener', NL), null, 'unsubscribed index');
});

// TASK 0 (c) on the two frozen control kernels: headpatched delivers to the top live listener, rev152 to the off'd B
const CONTROL = {
    headpatched: ROOT + 'bench/soak/controls/headpatched/Signal.js',
    rev152: ROOT + 'node_modules/lite-signal-1.5.2/Signal.js',
};
for (const [kn, path] of Object.entries(CONTROL)) {
    test('A2 checkHookFire on ' + kn + ': L0, A, B, C, off B, off C, then op 1', async () => {
        const KK = await import(path);
        const r = KK.createRegistry({ maxNodes: 64, onCapacityExceeded: 'grow' });
        const stack = [];
        const got = [];
        const offs = [];
        for (let i = 0; i < 4; i++) {
            stack.push({ live: true, offStep: null });
            offs.push(r.onGraphMutation((op) => { got.push([i, op]); }));
        }
        offs[2](); stack[2].live = false; stack[2].offStep = 1;
        offs[3](); stack[3].live = false; stack[3].offStep = 2;
        r.signal(0);
        assert.equal(got.length, 1, 'exactly one listener receives op 1');
        const f = checkHookFire(stack, got[0][0], got[0][1], 3);
        if (kn === 'headpatched') assert.equal(f, null);
        else assert.equal(f.detail, 'L2 received op1 after off at step 1 (expected L1)');
        r.destroy();
    });
}

/* ---- A3: the HOOK lane (batch R1b) ---------------------------------------------------------------------------- */

const HOOK_DESC = laneByName('HOOK');
const HOOK_SEED = (w) => (Math.imul(w + 1, 0x9E3779B1) >>> 0);
const script = (ops) => ({ genVersion: 1, lane: 'HOOK', seed: 1, large: false, covOff: null, flushPasses: null, ops });
const flat = (ops, out) => { for (const op of ops) { if (op.o === 'seq') flat(op.ops, out); else out.push(op); } return out; };
const controlAdapter = async (kn) => liteS3AdapterFor(await import(CONTROL[kn]));
const fails = (r) => (r.failure === null ? [] : r.failure.fails);

test('A3 HOOK is rostered LAST at index 6, needs cap hook, hard oracle O8, the four required scenarios', () => {
    assert.equal(ROSTER[ROSTER.length - 1], 'HOOK');
    assert.equal(HOOK_DESC.index, 6);
    assert.deepEqual(HOOK_DESC.needsCaps, ['hook']);
    assert.ok(HOOK_DESC.hardOracles.includes('O8'));
    assert.deepEqual(HOOK_DESC.required, ['hook-multi', 'hook-non-lifo-off', 'hook-mirror-dispose', 'hook-recompute']);
    for (const s of HOOK_DESC.required) assert.ok(ALL_SCENARIOS.includes(s), s + ' in scenarios.mjs SCENARIOS');
    assert.deepEqual(SIGS.O8, ['ghost-listener', 'mirror-links']);
    assert.ok(ORACLES.includes('O8') && CHECK_NAMES.includes('O8'));
    assert.deepEqual(ORACLE_CAPS.O8, ['hook']);
    assert.equal(oracleFamily('O8'), 'O8');
    assert.deepEqual(Object.keys(HOOK_DESC.ops), ['hsub', 'hoff']);
});

test('A3 generator: op 0 subscribes L0 before any node; hoff never targets L0; 2..5 listeners live; offs mostly non-LIFO', () => {
    let nonLifo = 0, offs = 0;
    for (let w = 0; w < 200; w++) {
        const s = generateWorld(HOOK_DESC, HOOK_SEED(w), {});
        assert.deepEqual(s.ops[0], { o: 'hsub', l: 0 }, 'world ' + w + ': op 0 is hsub L0');
        let next = 0;
        const live = new Set();
        for (const op of flat(s.ops, [])) {
            if (op.o === 'hsub') {
                assert.equal(op.l, next++, 'hsub indices are fresh and ascending');
                live.add(op.l);
                assert.ok(live.size <= 5, 'world ' + w + ': at most 5 live listeners');
            } else if (op.o === 'hoff') {
                assert.notEqual(op.l, 0, 'world ' + w + ': hoff never targets L0 (H2)');
                assert.ok(live.has(op.l), 'hoff targets a live listener');
                assert.ok(live.size >= 3, 'world ' + w + ': an off never leaves fewer than 2 live');
                if (op.l !== Math.max(...live)) nonLifo++;
                live.delete(op.l);
                offs++;
            }
        }
        assert.ok(live.has(0) && live.size >= 2 && live.size <= 5);
    }
    assert.ok(offs > 0 && nonLifo > 0 && nonLifo < offs, 'non-LIFO ' + nonLifo + ' of ' + offs + ' offs');
});

test('A3 generator cov-off:hook-non-lifo-off keeps every off LIFO (the top live listener)', () => {
    let offs = 0;
    for (let w = 0; w < 100; w++) {
        const s = generateWorld(HOOK_DESC, HOOK_SEED(w), { covOff: 'hook-non-lifo-off' });
        const live = new Set();
        for (const op of flat(s.ops, [])) {
            if (op.o === 'hsub') live.add(op.l);
            else if (op.o === 'hoff') { assert.equal(op.l, Math.max(...live), 'world ' + w + ': LIFO off'); live.delete(op.l); offs++; }
        }
    }
    assert.ok(offs > 0);
});

test('A3 HOOK on headpatched passes: one O8 per op, every required scenario reached, the decorator residue 0 / 0', async () => {
    const ad = await controlAdapter('headpatched');
    const scen = Object.create(null);
    for (let w = 0; w < 30; w++) {
        const r = runWorld(ad, generateWorld(HOOK_DESC, HOOK_SEED(w), {}));
        assert.equal(r.failure, null, 'world ' + w + ': ' + JSON.stringify(r.failure));
        assert.equal(r.checks.O8, r.ops, 'world ' + w + ': O8 performed once per op');
        for (const k of Object.keys(r.scen)) scen[k] = (scen[k] || 0) + r.scen[k];
    }
    for (const s of HOOK_DESC.required) assert.ok(scen[s] > 0, s + ' reached (' + scen[s] + ')');
});

for (const kn of ['rev152', 'tree']) {
    test('A3 HOOK on ' + kn + ' is red: O8 ghost-listener in the DIV-F9 shape after a non-LIFO off', async () => {
        const ad = kn === 'tree' ? liteS3Adapter : await controlAdapter(kn);
        let ghost = null, failed = 0;
        for (let w = 0; w < 30; w++) {
            const r = runWorld(ad, generateWorld(HOOK_DESC, HOOK_SEED(w), {}));
            if (r.failure === null) continue;
            failed++;
            const f = fails(r).find((x) => x.oracle === 'O8' && x.sig === 'ghost-listener');
            assert.ok(f, 'world ' + w + ': a ' + kn + ' failure is the ghost: ' + JSON.stringify(fails(r)));
            if (ghost === null) ghost = f;
        }
        assert.ok(failed > 0, kn + ': at least one of 30 worlds fails');
        assert.match(ghost.detail, DIV_F9);
    });
}

test('A3 mirror-links has teeth: a world.hook that drops op-4 deliveries fails O8 mirror-links on headpatched', async () => {
    const base = await controlAdapter('headpatched');
    const ad = Object.create(base, { open: { value(o) {
        const w = base.open(o);
        return Object.assign({}, w, { hook(fn) { return w.hook((op, a, b) => { if (op !== 4) fn(op, a, b); }); } });
    } } });
    let hit = null;
    for (let w = 0; w < 30 && hit === null; w++) {
        const r = runWorld(ad, generateWorld(HOOK_DESC, HOOK_SEED(w), {}));
        hit = fails(r).find((x) => x.oracle === 'O8' && x.sig === 'mirror-links') || null;
    }
    assert.ok(hit, 'mirror-links fired');
    assert.match(hit.detail, /^mirror edges \d+ != activeLinks \d+$/);
});

test('A3 exec fails closed: hoff L0 (H2), an hsub after a node exists, a reused hsub index', async () => {
    const ad = await controlAdapter('headpatched');
    assert.throws(() => runWorld(ad, script([{ o: 'hsub', l: 0 }, { o: 'hoff', l: 0 }])), /H2: L0 is permanent/);
    assert.throws(() => runWorld(ad, script([{ o: 'sig', i: 0, v: 1 }, { o: 'hsub', l: 0 }])), /the mirror cannot see them/);
    assert.throws(() => runWorld(ad, script([{ o: 'hsub', l: 0 }, { o: 'hsub', l: 0 }])), /not a fresh listener index/);
    assert.throws(() => runWorld(ad, script([{ o: 'hsub', l: 0 }, { o: 'hoff', l: 1.5 }])), /not a listener index/);
    // a gap (a shrunk-away hsub) is a never-live entry; an hoff of it is a no-op
    const r = runWorld(ad, script([{ o: 'hsub', l: 0 }, { o: 'hsub', l: 2 }, { o: 'hoff', l: 1 }, { o: 'sig', i: 0, v: 1 }, { o: 'hoff', l: 2 }, { o: 'sig', i: 1, v: 2 }]));
    assert.equal(r.failure, null, JSON.stringify(r.failure));
    assert.equal(r.checks.O8, 6);
});

test('A3 S1 lanes never perform O8 (checks.O8 present and 0: D-b93-D1)', () => {
    for (const name of ['GRAPH', 'BATCH', 'ERROR', 'NEST', 'WIE']) {
        const r = runWorld(liteS3Adapter, generateWorld(laneByName(name), HOOK_SEED(3), { steps: 60 }));
        assert.ok(Object.hasOwn(r.checks, 'O8'), name);
        assert.equal(r.checks.O8, 0, name);
    }
});

/* ---- A4: retention (a child with --expose-gc: npm test runs without it) ------------------------------------- */

const A4_DRIVER = `
const R = process.env.T75_ROOT;
const { createLeakTracker } = await import('@zakkster/lite-leak');
const KK = await import(R + 'bench/soak/controls/headpatched/Signal.js');
const { liteS3AdapterFor } = await import(R + 'bench/soak/adapters/lite-s3.mjs');
const { laneByName } = await import(R + 'bench/soak/lanes/index.mjs');
const { generateWorld } = await import(R + 'bench/soak/gen.mjs');
const { runWorld } = await import(R + 'bench/soak/exec.mjs');
const base = liteS3AdapterFor(KK);
const tracker = createLeakTracker({ name: 't75' });
let worlds = 0, listeners = 0;
const ad = Object.create(base, { open: { value(o) {
    const w = base.open(o);
    tracker.track(w.registry, null, 'registry');
    worlds++;
    return Object.assign({}, w, { hook(fn) { tracker.track(fn, null, 'listener'); listeners++; return w.hook(fn); } });
} } });
const desc = laneByName('HOOK');
const sizes = [];
let bad = 0;
for (let b = 0; b < 10; b++) {
    for (let k = 0; k < 100; k++) {
        const r = runWorld(ad, generateWorld(desc, (Math.imul(b * 100 + k + 1, 0x85EBCA6B) >>> 0), { steps: 120 }));
        if (r.failure !== null) bad++;
    }
    let size = tracker.size();
    for (let t = 0; t < 40 && size !== 0; t++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 10)); size = tracker.size(); }
    sizes.push(size);
}
process.stdout.write('T75 ' + JSON.stringify({ worlds, listeners, bad, sizes }) + '\\n');
`;

test('A4 1000 HOOK worlds on lite-s3 (headpatched): lite-leak tracker.size() === 0 after every 100-world block', () => {
    const env = Object.assign({}, process.env, { T75_ROOT: ROOT });
    delete env.SOAK_KERNEL; delete env.SOAK_ENGINE; delete env.SOAK_NEARWRAP;
    const p = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', A4_DRIVER], { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 });
    const line = (p.stdout || '').split('\n').find((l) => l.startsWith('T75 '));
    assert.ok(line, 'child gave no result line; status ' + p.status + '\nstderr: ' + (p.stderr || '').slice(0, 600));
    const o = JSON.parse(line.slice(4));
    assert.equal(o.worlds, 1000);
    assert.ok(o.listeners >= 2000, 'every world subscribed >= 2 listeners (' + o.listeners + ')');
    assert.equal(o.bad, 0, 'headpatched HOOK worlds pass');
    assert.deepEqual(o.sizes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});
