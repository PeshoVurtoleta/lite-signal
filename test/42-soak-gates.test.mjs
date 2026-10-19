/**
 * test/42-soak-gates.test.mjs -- the soak gates, verdict, run totals, boundary and world-index search
 * (S1c batch B1: SPEC-B-S1cd TASKS 1-4, amendments 1, 6, 7, 9).
 *
 * Every gate is DATA (gates.mjs GATES). Each entry is run on its must-fail controls FIRST (each must
 * reach its expected non-PASS verdict), then on its green controls (each must PASS), so a rule that
 * always fails and a rule that never fails are both caught.
 *
 * Kernel-free: nothing here loads Signal.js (gen, lanes, seeds, gates and exec are kernel-free; the
 * boundary child imports only lite-leak and boundary.mjs). Amendment 11.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import * as G from '../bench/soak/gates.mjs';
import * as CFG from '../bench/soak/config.mjs';
import { ORACLES } from '../bench/soak/oracles.mjs';
import { CHECK_NAMES, SKIP_NAMES } from '../bench/soak/exec.mjs';
import { seedFor, worldSeed, findWorldIndex, fmix32, unfmix32 } from '../bench/soak/seeds.mjs';
import { LANES, isLargeWorld } from '../bench/soak/lanes/index.mjs';
import { generateWorld, scriptJson } from '../bench/soak/gen.mjs';
import { closeBoundary, countAlive } from '../bench/soak/boundary.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOAK = join(ROOT, 'bench', 'soak');

/* ---- GATES as data -------------------------------------------------------------------------------- */

test('GATES: every gate is red on each must-fail control FIRST, then green on each pass control', () => {
    assert.ok(G.GATES.length >= 7);
    for (const g of G.GATES) {
        assert.equal(typeof g.id, 'string', 'id');
        assert.equal(typeof g.check, 'function', g.id + ' check');
        assert.ok(['fail', 'evidence', 'startup', 'wrap'].includes(g.kind), g.id + ' kind');
        assert.ok(Array.isArray(g.mustFail) && g.mustFail.length >= 1, g.id + ': a gate ships with its must-fail control (amendment 9)');
        assert.ok(Array.isArray(g.pass) && g.pass.length >= 1, g.id + ': and a green control');
        assert.ok(Object.isFrozen(g) && Object.isFrozen(g.mustFail), g.id + ' frozen');
        for (const m of g.mustFail) {
            assert.notEqual(m.expect, 'PASS', g.id + ': a must-fail control never expects PASS');
            const r = g.check(m.input);
            assert.equal(r.verdict, m.expect, g.id + ' must-fail "' + m.why + '": got ' + JSON.stringify(r));
            if (g.kind === 'evidence') assert.equal(m.expect, 'INCONCLUSIVE', g.id + ': an evidence gate goes INCONCLUSIVE, never FAIL');
        }
        for (const input of g.pass) assert.equal(g.check(input).verdict, 'PASS', g.id + ' green control');
    }
});

test('GATE_NAMES is derived from GATES; REPORT_ONLY_GATES never overlaps it; INCONCLUSIVE causes format', () => {
    assert.deepEqual(G.GATE_NAMES, G.GATES.map((g) => g.id));
    assert.equal(new Set(G.GATE_NAMES).size, G.GATE_NAMES.length, 'unique ids');
    assert.deepEqual(G.GATE_NAMES, ['oracle', 'heap', 'rss', 'retention', 'coverage', 'check-floor', 'taint-skip', 'totals', 'wrap']);
    for (const r of G.REPORT_ONLY_GATES) assert.ok(!G.GATE_NAMES.includes(r), r + ' is report-only');
    assert.equal(G.inconclusiveLine('scenario', { lane: 'BATCH', scenario: 'revert-after-mid-read' }),
        'soak: INCONCLUSIVE -- scenario lane=BATCH missing=revert-after-mid-read', 'T-cov line (SPEC-B section 9)');
    assert.equal(G.inconclusiveLine('no-lane'), 'soak: INCONCLUSIVE -- no lane ran (all skipped)');
    assert.equal(G.inconclusiveLine('interrupted'), 'soak: INCONCLUSIVE -- run interrupted before its end');
    assert.equal(G.inconclusiveLine('post-cycles', { lane: 'GRAPH', post: 9, need: 10 }), 'soak: INCONCLUSIVE -- lane GRAPH ran 9 post-warm-up cycles < 10');
    // the wrap causes (S2): byte-identical to the lines wrap.mjs printed before task 8 moved them here (SPEC-B section 7)
    assert.equal(G.inconclusiveLine('wrap-crossing', { cause: 'wrap-crossing', check: 'W1', counter: 'globalVersion', label: 'W1' }), 'soak: INCONCLUSIVE -- wrap W1 crossing unwitnessed');
    assert.equal(G.inconclusiveLine('wrap-crossing', { label: 'W5[gen]' }), 'soak: INCONCLUSIVE -- wrap W5[gen] crossing unwitnessed');
    assert.equal(G.inconclusiveLine('wrap-unmeasured', { cause: 'wrap-unmeasured', check: 'W5', counter: 'evalCount', label: 'W5[evalCount]' }), 'soak: INCONCLUSIVE -- wrap W5[evalCount] unmeasured');
    assert.throws(() => G.inconclusiveLine('nope'), TypeError);
});

/* ---- ASSERTION: heap ------------------------------------------------------------------------------ */

test('ASSERTION heap: early median 10, late 13.1 -> FAIL; late 12.9 -> PASS; post 9 -> INCONCLUSIVE', () => {
    assert.equal(G.heapRule({ smoke: false, post: 10, earlyMedian: 10, lateMedian: 13.1 }).verdict, 'FAIL');
    assert.equal(G.heapRule({ smoke: false, post: 10, earlyMedian: 10, lateMedian: 12.9 }).verdict, 'PASS');
    const p9 = G.heapRule({ smoke: false, post: 9, earlyMedian: 10, lateMedian: 10 });
    assert.equal(p9.verdict, 'INCONCLUSIVE');
    assert.equal(p9.cause, 'post-cycles');
    assert.equal(G.heapRule({ smoke: true, post: 2, earlyMedian: 10, lateMedian: 99 }).verdict, 'SMOKE', 'smoke: drift gates -> SMOKE');
});

/* ---- LaneGates end to end on synthetic cycle records ---------------------------------------------- */

const ORA = ['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6'];
function rec(lane, cycle, over = {}) {
    const checks = {};
    for (const o of CHECK_NAMES) checks[o] = 1000;
    const skipTainted = {};
    for (const o of SKIP_NAMES) skipTainted[o] = 0;
    return Object.assign({
        lane, cycle, worlds: 250, ops: 100000, failingWorlds: 0, failureCounts: {}, checks, skipTainted,
        scenarios: { a: 8, b: 8 }, memory: { residentMB: 10 }, rss: { samples: 250, p95MB: 100, maxMB: 100, stride: 1 },
        boundary: { trackerSize: 0, weakAlive: 0 },
    }, over);
}
function laneRun(n, perCycle, opts = {}) {
    const L = new G.LaneGates({ lane: 'GRAPH', oracles: opts.oracles || ORA, required: ['a', 'b'] });
    for (let c = 0; c < n; c++) L.push(rec('GRAPH', c, perCycle(c)));
    return L.compute({ smoke: opts.smoke === true });
}

test('LaneGates heap: medians come from the per-lane early/late windows; warm-up feeds no drift', () => {
    // 1 warm-up + 10 post: early window = post cycles 1..5, late = 6..10
    const red = laneRun(11, (c) => ({ memory: { residentMB: c === 0 ? 500 : (c <= 5 ? 10 : 13.1) } }));
    assert.equal(red.gates.heap.verdict, 'FAIL');
    assert.equal(red.status, 'FAIL');
    assert.equal(red.breaches[0].gate, 'heap');
    assert.deepEqual([red.drift.heap.early, red.drift.heap.late], [10, 13.1]);
    const green = laneRun(11, (c) => ({ memory: { residentMB: c <= 5 ? 10 : 12.9 } }));
    assert.equal(green.status, 'PASS', JSON.stringify(green.causes));
    const short = laneRun(10, () => ({}));
    assert.equal(short.postWarmup, 9);
    assert.equal(short.status, 'INCONCLUSIVE');
    assert.deepEqual(short.causes.map((c) => c.line), ['soak: INCONCLUSIVE -- lane GRAPH ran 9 post-warm-up cycles < 10']);
});

test('ASSERTION 2 rss end to end (pins gate id rss, drift.rss, breach, one cause line): FAIL on a 2x late p95, PASS at 190', () => {
    // 11 cycles = 1 warm-up + 10 post; band = first 5 post cycles (100), late = last floor(10/4)=2 cycles (200); limit 100 x 1.75 + 16 = 191
    const mk = (late) => (c) => ({ rss: { samples: 250, p95MB: c === 0 ? 900 : (c <= 5 ? 100 : (c >= 9 ? late : 150)), maxMB: 999, stride: 1 } });
    const red = laneRun(11, mk(200));
    assert.equal(red.gates.rss.verdict, 'FAIL');
    assert.equal(red.status, 'FAIL');
    assert.deepEqual([red.drift.rss.band, red.drift.rss.late, red.drift.rss.limit], [100, 200, 191]);
    assert.ok(red.breaches.some((b) => b.gate === 'rss'), JSON.stringify(red.breaches));
    const green = laneRun(11, mk(190));
    assert.equal(green.gates.rss.verdict, 'PASS', JSON.stringify(green.causes));
    assert.equal(green.status, 'PASS');
    // 10 cycles = 9 post: exactly one post-cycles cause line (heap and rss share it)
    const short = laneRun(10, () => ({}));
    assert.equal(short.status, 'INCONCLUSIVE');
    assert.deepEqual(short.causes.map((c) => c.line), ['soak: INCONCLUSIVE -- lane GRAPH ran 9 post-warm-up cycles < 10']);
});

test('LaneGates rss windows (D-B6): late = p95 of the last k = min(max(1, floor(post / 4)), 256) post cycles, ring-wrapped', () => {
    const at = (n, f) => laneRun(n, (c) => ({ rss: { samples: 250, p95MB: c === 0 ? 900 : (c <= 5 ? 100 : f(c, n - 1)), maxMB: 999, stride: 1 } }));
    // post 40 -> k 10 (cycles 31..40): one 250 in the window's FIRST slot FAILs (p95 of 10 = max; a median, k = 1 or a 5-cap passes)
    assert.equal(at(41, (c) => (c === 31 ? 250 : 150)).gates.rss.verdict, 'FAIL');
    // the cycle just before the window is not read (k = floor(post / 4) + 1 would FAIL)
    assert.equal(at(41, (c) => (c === 30 ? 999 : 150)).gates.rss.verdict, 'PASS');
    // post 300 -> k 75, ring wrapped (EarlyLate n 256): last 75 are 150, older 999 -> PASS (an unwrapped ring read or k = post FAILs)
    assert.equal(at(301, (c, post) => (c > post - 75 ? 150 : 999)).gates.rss.verdict, 'PASS');
    // post 1100 -> floor(post / 4) = 275, capped at RSS_BUF 256: last 256 are 150, the 19 before them 999 -> PASS (uncapped FAILs)
    assert.equal(at(1101, (c, post) => (c > post - 256 ? 150 : 999)).gates.rss.verdict, 'PASS');
});

test('LaneGates rss: rec.rss is read once post-warm-up; non-finite or negative p95MB is a GateInputError', () => {
    // pins the read-once contract for the new record key (mirrors the residentMB read-once rows)
    const L = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
    let reads = 0;
    for (let c = 0; c < 3; c++) {
        const r = rec('GRAPH', c);
        if (c > 0) Object.defineProperty(r, 'rss', { enumerable: true, get() { reads++; return { samples: 250, p95MB: 100, maxMB: 100, stride: 1 }; } });
        L.push(r);
    }
    assert.equal(reads, 2, 'one read per post-warm-up record, none for the warm-up');
    for (const bad of [NaN, Infinity, -1, -0.5, 'x', null]) {
        const L2 = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
        assert.throws(() => L2.push(rec('GRAPH', 1, { rss: { samples: 250, p95MB: bad, maxMB: 100, stride: 1 } })), G.GateInputError, 'p95MB ' + String(bad));
    }
});

test('LaneGates retention: 2 bad post-warm-up boundaries FAIL, 1 passes, a warm-up one is ignored, unmeasured FAILs', () => {
    const held = { boundary: { trackerSize: 1, weakAlive: 1 } };
    assert.equal(laneRun(11, (c) => (c === 3 || c === 7 ? held : {})).gates.retention.verdict, 'FAIL');
    assert.equal(laneRun(11, (c) => (c === 3 ? held : {})).gates.retention.verdict, 'PASS');
    assert.equal(laneRun(11, (c) => (c === 0 ? held : {})).gates.retention.verdict, 'PASS', 'warm-up boundary');
    assert.equal(laneRun(11, (c) => (c === 4 ? { boundary: { trackerSize: 0, weakAlive: 2 } } : {})).retention.badBoundaries, 1, 'weakAlive alone is bad');
    assert.equal(laneRun(11, (c) => (c === 5 ? { boundary: { trackerSize: null, weakAlive: 0 } } : {})).gates.retention.verdict, 'FAIL', 'null is not zero');
    assert.equal(laneRun(3, () => held, { smoke: true }).gates.retention.verdict, 'FAIL', 'retention stays hard in smoke');
});

test('LaneGates evidence: coverage, performed-only check floor and per-oracle taint-skip ratio -> INCONCLUSIVE lines', () => {
    const cov = laneRun(11, (c) => ({ scenarios: c === 0 ? { a: 7, b: 1 } : { a: 0 } }));
    assert.equal(cov.status, 'INCONCLUSIVE');
    assert.deepEqual(cov.scenarioMissing, ['a', 'b'], 'a = 7 < 8, b = 1 < 8 (warm-up counts toward totals)');
    // the floor counts PERFORMED checks only: 1000 skipped O1e checks never stand in for a performed one
    const floor = laneRun(11, () => ({ checks: Object.assign(rec('GRAPH', 0).checks, { O1e: 0 }), skipTainted: Object.assign(rec('GRAPH', 0).skipTainted, { O1e: 1000 }) }));
    assert.ok(floor.causes.some((c) => c.line === 'soak: INCONCLUSIVE -- checks lane=GRAPH oracle=O1e performed=0 < ' + CFG.CHECK_FLOOR), JSON.stringify(floor.causes));
    assert.ok(floor.causes.some((c) => c.cause === 'taint-skip' && c.oracle === 'O1e'), 'and its skip ratio is 1.0');
    // Synthetic ratios on both sides of TAINT_SKIP_MAX 0.35, calibrated in S1d B6 (bench/soak/calibration/
    // soak-calibration.json, headpatched fa2871f0, seed 0xC0FFEE, smoke shape): 0.44 / 0.26 are the S1d B6
    // (pre-V1) cov-off and clean-max values; the b71 recut reads sweep max 0.0663 (binding clean max 0.0579)
    // and the NEST cov-off is the coverage gate's case (b70 D6 V1). Counts x10 so every oracle clears CHECK_FLOOR
    // and only the taint gate decides; on the provisional 0.5 this row read PASS (over = []).
    const t = laneRun(11, () => ({ checks: Object.assign(rec('GRAPH', 0).checks, { O1c: 5600, O1e: 7400 }), skipTainted: Object.assign(rec('GRAPH', 0).skipTainted, { O1c: 4400, O1e: 2600 }) }));
    assert.equal(t.gates['check-floor'].verdict, 'PASS', 'precondition: only the taint gate decides');
    assert.deepEqual(t.gates['taint-skip'].over.map((o) => o.oracle), ['O1c']);
    assert.equal(t.status, 'INCONCLUSIVE');
    // O7a is not in the GRAPH oracle list, so a zero O7a count is no floor breach there
    assert.equal(laneRun(11, () => ({ checks: Object.assign(rec('GRAPH', 0).checks, { O7a: 0 }) })).status, 'PASS');
});

test('LaneGates oracle gate and failure totals; malformed records throw (fail closed), with no partial fold', () => {
    const r = laneRun(11, (c) => (c === 2 ? { failingWorlds: 1, failureCounts: { 'O6:escape-computed': 1 } } : {}));
    assert.equal(r.gates.oracle.verdict, 'FAIL');
    assert.deepEqual(r.failureCounts, { 'O6:escape-computed': 1 });
    assert.equal(r.breaches.length, 0, 'oracle failures carry their own BREACH lines (main)');
    const L = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a'] });
    const badRecs = [
        rec('BATCH', 0), rec('GRAPH', 1), rec('GRAPH', 0, { ops: -1 }), rec('GRAPH', 0, { worlds: 1.5 }),
        rec('GRAPH', 0, { checks: { O1c: 1 } }), rec('GRAPH', 0, { skipTainted: {} }), rec('GRAPH', 0, { failureCounts: { x: 'a' } }),
        rec('GRAPH', 0, { scenarios: null }),
    ];
    for (const b of badRecs) assert.throws(() => L.push(b), G.GateInputError, JSON.stringify(b).slice(0, 80));
    L.push(rec('GRAPH', 0));
    assert.throws(() => L.push(rec('GRAPH', 1, { memory: {} })), G.GateInputError, 'a post-warm-up record needs residentMB');
    assert.equal(L.cycles, 1, 'nothing folded from the rejected record');
    assert.throws(() => new G.LaneGates({ lane: 'GRAPH', oracles: ['O9'], required: [] }), TypeError);
});

/* ---- ASSERTION: verdict --------------------------------------------------------------------------- */

const green = { configError: null, engine: 'lite', skipped: [], sawFail: false, fatal: false, reason: 'end', forever: false, smoke: false, lanesRun: 4, inconclusive: [] };
const V = (over) => G.verdict(Object.assign({}, green, over));

test('ASSERTION verdict: SKIP on lite -> 2; non-lite SKIP otherwise green -> PARTIAL/0 (never PASS); fatal + signal -> FAIL/1', () => {
    const lite = V({ skipped: [{ lane: 'NEST', missingCaps: ['disposeSignal'] }] });
    assert.deepEqual([lite.verdict, lite.exitCode], [null, 2]);
    const partial = V({ engine: 'polyfill', skipped: [{ lane: 'NEST' }], lanesRun: 3 });
    assert.deepEqual([partial.verdict, partial.exitCode], ['PARTIAL', 0]);
    assert.notEqual(partial.verdict, 'PASS');
    const fs = V({ fatal: true, reason: 'signal' });
    assert.deepEqual([fs.verdict, fs.exitCode], ['FAIL', 1]);
});

test('verdict matrix: first match wins; interrupted, no lane, forever+signal, smoke; bad input throws', () => {
    assert.deepEqual([V({}).verdict, V({}).exitCode], ['PASS', 0]);
    assert.equal(V({ configError: 'x' }).exitCode, 2);
    assert.equal(V({ reason: 'fatal' }).verdict, 'FAIL');
    assert.equal(V({ sawFail: true, smoke: true, inconclusive: [{ cause: 'no-lane' }] }).verdict, 'FAIL', 'FAIL beats INCONCLUSIVE and SMOKE');
    const sig = V({ reason: 'signal' });
    assert.deepEqual([sig.verdict, sig.exitCode], ['INCONCLUSIVE', 3]);
    assert.deepEqual(sig.causes.map((c) => c.line), ['soak: INCONCLUSIVE -- run interrupted before its end']);
    assert.equal(V({ reason: 'signal', forever: true }).verdict, 'PASS', 'a signal ends a forever run normally');
    assert.equal(V({ lanesRun: 0, engine: 'polyfill', skipped: [{ lane: 'GRAPH' }] }).verdict, 'INCONCLUSIVE', 'no lane ran is never PASS or PARTIAL');
    assert.deepEqual([V({ smoke: true }).verdict, V({ smoke: true }).exitCode], ['SMOKE', 0]);
    assert.equal(V({ smoke: true, inconclusive: [{ cause: 'scenario', lane: 'GRAPH', scenario: 's' }] }).verdict, 'INCONCLUSIVE', 'coverage stays hard in smoke');
    for (const bad of [{ reason: 'END' }, { fatal: 0 }, { smoke: 'yes' }, { skipped: null }, { lanesRun: -1 }, { engine: '' }]) {
        assert.throws(() => V(bad), TypeError, JSON.stringify(bad));
    }
    const input = [{ cause: 'scenario', lane: 'GRAPH', scenario: 's' }];
    V({ inconclusive: input });
    assert.equal(input[0].line, undefined, 'verdict does not mutate its input');
});

test('judgeRun guard: an INCONCLUSIVE lane with no recorded cause still makes the run INCONCLUSIVE (lane-status)', () => {
    const base = { configError: null, engine: 'lite', skipped: [], reason: 'end', forever: false, smoke: false, fatal: false };
    const ok = laneRun(11, () => ({}));
    const bare = Object.assign({}, ok, { status: 'INCONCLUSIVE', causes: [] });
    const r = G.judgeRun(Object.assign({ lanes: [ok, bare] }, base));
    assert.deepEqual([r.verdict, r.exitCode], ['INCONCLUSIVE', 3], 'without the guard this run would PASS');
    assert.deepEqual(r.causes.map((c) => c.line), ['soak: INCONCLUSIVE -- lane GRAPH status INCONCLUSIVE with no recorded cause']);
    assert.throws(() => G.judgeRun(Object.assign({ lanes: [Object.assign({}, ok, { status: 'SMOKE' })] }, base)), G.GateInputError, 'unknown lane status');
    assert.throws(() => G.judgeRun(Object.assign({ lanes: [{ status: 'PASS' }] }, base)), G.GateInputError, 'not a compute result');
    assert.throws(() => G.judgeRun(Object.assign({ lanes: null }, base)), TypeError, 'a non-array lanes argument is API misuse');
});

test('check-floor uses the SMOKE floor in smoke: CHECK_FLOOR_SMOKE passes, one less is INCONCLUSIVE', () => {
    assert.ok(CFG.CHECK_FLOOR_SMOKE < CFG.CHECK_FLOOR, 'precondition: the smoke floor is lower');
    const at = (n) => G.checkFloorRule({ smoke: true, oracles: ['O1c'], performed: { O1c: n } }).verdict;
    assert.equal(at(CFG.CHECK_FLOOR_SMOKE), 'PASS', 'a mutant using CHECK_FLOOR in smoke fails here');
    assert.equal(at(CFG.CHECK_FLOOR_SMOKE - 1), 'INCONCLUSIVE');
    assert.equal(G.checkFloorRule({ smoke: false, oracles: ['O1c'], performed: { O1c: CFG.CHECK_FLOOR_SMOKE } }).verdict, 'INCONCLUSIVE', 'and the full floor outside smoke');
});

test('judgeRun folds lanes: a FAIL lane fails the run; an INCONCLUSIVE lane makes it INCONCLUSIVE', () => {
    const ok = laneRun(11, () => ({}));
    const redLane = laneRun(11, (c) => ({ memory: { residentMB: c <= 5 ? 10 : 50 } }));
    const base = { configError: null, engine: 'lite', skipped: [], reason: 'end', forever: false, smoke: false, fatal: false };
    assert.equal(G.judgeRun(Object.assign({ lanes: [ok, ok] }, base)).verdict, 'PASS');
    const r = G.judgeRun(Object.assign({ lanes: [ok, redLane] }, base));
    assert.deepEqual([r.verdict, r.exitCode, r.breaches[0].gate], ['FAIL', 1, 'heap']);
    assert.equal(G.judgeRun(Object.assign({ lanes: [ok, laneRun(10, () => ({}))] }, base)).verdict, 'INCONCLUSIVE');
    assert.equal(G.judgeRun(Object.assign({ lanes: [ok], extraFail: true }, base)).verdict, 'FAIL');
});

/* ---- ASSERTION: Totals ---------------------------------------------------------------------------- */

test('ASSERTION Totals: 3 x 2^30 sums to exactly 3221225472; the |0 must-fail control reads -1073741824', () => {
    const t = new G.Totals(['ops']);
    for (let i = 0; i < 3; i++) t.add('ops', 2 ** 30);
    assert.equal(t.get('ops'), 3221225472);
    assert.ok(t.slot instanceof Float64Array);
    let acc = 0;
    for (let i = 0; i < 3; i++) acc = (acc + 2 ** 30) | 0;
    assert.equal(acc, -1073741824, 'the |0 accumulator wraps');
    const ctl = G.GATES.find((g) => g.id === 'totals');
    assert.equal(ctl.check(ctl.mustFail[0].input).got, -1073741824);
    assert.throws(() => t.add('ops', -1), RangeError);
    assert.throws(() => t.add('ops', 0.5), RangeError);
    assert.throws(() => t.add('nope', 1), RangeError);
    const big = new G.Totals(['x']);
    big.add('x', Number.MAX_SAFE_INTEGER);
    assert.throws(() => big.add('x', 1), RangeError, 'exactness is never silently lost');
    const grow = new G.Totals([]);
    for (let i = 0; i < 40; i++) { grow.ensure('k' + i); grow.add('k' + i, i); }
    assert.equal(grow.get('k39'), 39);
    assert.equal(Object.keys(grow.toJSON()).length, 40);
});

test('oracleFamily: O1c/O1e -> O1, O7a -> O7, every S1 oracle maps, an unknown one throws', () => {
    assert.equal(G.oracleFamily('O1c'), 'O1');
    assert.equal(G.oracleFamily('O1e'), 'O1');
    assert.equal(G.oracleFamily('O7a'), 'O7');
    for (const o of ORACLES) assert.match(G.oracleFamily(o), /^O(?:[0-9]|B)$/, o);
    assert.equal(G.oracleFamily('OB'), 'OB');
    for (const o of CHECK_NAMES) G.oracleFamily(o);
    assert.throws(() => G.oracleFamily('O9'), TypeError);
    assert.throws(() => G.oracleFamily(undefined), TypeError);
});

test('EarlyLate: first N + a ring of the last N; an empty window is NaN (fails the heap gate closed)', () => {
    const el = new G.EarlyLate(3);
    assert.ok(Number.isNaN(el.earlyMedian()));
    for (const v of [1, 2, 3, 10, 20, 30, 40]) el.push(v);
    assert.equal(el.earlyMedian(), 2);
    assert.equal(el.lateMedian(), 30);
    assert.equal(G.heapRule({ smoke: false, post: 10, earlyMedian: NaN, lateMedian: 1 }).verdict, 'FAIL');
});

/* ---- ASSERTION: scripts-1000 golden digests --------------------------------------------------------- */

function digest(desc, base, n) {
    const cs = seedFor(base, desc.index, 0);
    const h = createHash('sha256');
    for (let w = 0; w < n; w++) {
        h.update(scriptJson(generateWorld(desc, worldSeed(cs, w), { large: isLargeWorld(desc, w), covOff: null })));
        h.update('\n');
    }
    return h.digest('hex');
}

test('ASSERTION the scripts-1000 digests are unchanged (golden cut from the S1b generator before any S1c edit)', () => {
    const golden = JSON.parse(readFileSync(join(SOAK, 'calibration', 'golden', 'scripts-1000.json'), 'utf8'));
    assert.equal(golden.worlds, 1000);
    assert.deepEqual(Object.keys(golden.digests), LANES.map((d) => d.name));
    for (const d of LANES) assert.equal(digest(d, Number(golden.base), golden.worlds), golden.digests[d.name], d.name);
    // must-fail control: the comparison has teeth (another base gives another digest)
    assert.notEqual(digest(LANES[0], 0xC0FFEF, 1000), golden.digests[LANES[0].name]);
});

/* ---- findWorldIndex ------------------------------------------------------------------------------- */

function scan(base, lane, cycle, ws, max) {   // the independent oracle: a forward linear search
    const cs = seedFor(base, lane, cycle);
    for (let w = 0; w < max; w++) if (worldSeed(cs, w) === ws) return w;
    return -1;
}

test('findWorldIndex agrees with a forward scan (hits, misses, the bound) and validates its input', () => {
    const MAX = 4096;
    let x = 0x2545F491;
    for (let k = 0; k < 24; k++) {
        x = fmix32(x + k);
        const base = x, lane = k & 3, cycle = (x >>> 8) & 1023;
        const cs = seedFor(base, lane, cycle);
        const w = x % MAX;
        assert.equal(findWorldIndex(base, lane, cycle, worldSeed(cs, w), MAX), w);
        if (w > 0) assert.equal(findWorldIndex(base, lane, cycle, worldSeed(cs, w), w), -1, 'max is exclusive');
        assert.equal(findWorldIndex(base, lane, cycle, worldSeed(cs, w), w + 1), w);
        const probe = fmix32(x ^ 0x5bd1e995);
        assert.equal(findWorldIndex(base, lane, cycle, probe, MAX), scan(base, lane, cycle, probe, MAX), 'random seed');
    }
    assert.equal(findWorldIndex(0xC0FFEE, 0, 0, 0, 0xFFFFFFFF), -1, 'worldSeed never returns 0');
    for (const args of [[1, 0, 0, -1, 10], [1, 0, 0, 2 ** 32, 10], [1, 0, 0, 1.5, 10], [1, 0, 0, 1, 0], [1, 0, 0, 1, 2 ** 32], [1, 16, 0, 1, 10], [1, 0, -1, 1, 10]]) {
        assert.throws(() => findWorldIndex(...args), RangeError, JSON.stringify(args));
    }
});

test('findWorldIndex: the remap seed has two preimages and the smaller index wins (what a scan meets first)', () => {
    const REMAP = 0x9e3779b9;
    const wZero = 37;   // pick base so that world 37's input is 0 (its natural seed 0 remaps to REMAP)
    const cs = Math.imul(wZero + 1, 0x9e3779b9) >>> 0;
    const lane = 1, cycle = 2;
    const base = (unfmix32(cs) ^ ((cycle << 4) | lane)) >>> 0;
    assert.equal(seedFor(base, lane, cycle), cs, 'precondition: the constructed cycle seed');
    assert.equal(worldSeed(cs, wZero), REMAP);
    let inv = 0x9e3779b9;   // multiplicative inverse of 0x9e3779b9 mod 2^32 (Newton; independent of seeds.mjs)
    for (let i = 0; i < 5; i++) inv = Math.imul(inv, 2 - Math.imul(0x9e3779b9, inv)) >>> 0;
    assert.equal(Math.imul(inv, 0x9e3779b9) >>> 0, 1, 'precondition: the inverse');
    const natural = (Math.imul((unfmix32(REMAP) ^ cs) >>> 0, inv) >>> 0) - 1;
    assert.equal(worldSeed(cs, natural), REMAP, 'precondition: the natural preimage');
    assert.equal(findWorldIndex(base, lane, cycle, REMAP, 0xFFFFFFFF), Math.min(wZero, natural));
    assert.equal(findWorldIndex(base, lane, cycle, REMAP, 4096), scan(base, lane, cycle, REMAP, 4096));
});

/* ---- boundary ------------------------------------------------------------------------------------- */

test('closeBoundary order: profiler read before the first forced GC, memory after the last, reset after that', async () => {
    const log = [];
    let left = 3;
    const r = await closeBoundary({
        tracker: { size: () => left }, witness: [], dropRefs: () => log.push('drop'),
        profiler: { summary: () => { log.push('summary'); return { gc: { major: 0, minor: 2, maxMs: 0.5 } }; }, reset: () => log.push('reset') },
        forceGc: () => { log.push('gc'); left = Math.max(0, left - 1); }, drainMs: 1000, drainTries: 8,
    });
    assert.deepEqual(log, ['summary', 'drop', 'gc', 'gc', 'gc', 'reset']);
    assert.deepEqual(r.boundary, Object.assign({}, r.boundary, { trackerSize: 0, weakAlive: 0, forcedGcTries: 3, heapSampledAfterGc: true }));
    assert.deepEqual(r.gc, { major: 0, minor: 2, maxPauseMs: 0.5 });
    assert.ok(r.memory.residentMB > 0 && r.memory.heapUsedMB > 0);
    // a retained target spends the (short) budget and is reported, never hidden (a stepped clock: 5 ms per
    // read, so the try count never depends on host load)
    let clk = 0;
    const held = await closeBoundary({ tracker: { size: () => 1 }, witness: [], profiler: null, forceGc: () => {}, drainMs: 30, drainTries: 2, now: () => (clk += 5) });
    assert.equal(held.boundary.trackerSize, 1);
    assert.ok(held.boundary.drainMs >= 30 && held.boundary.forcedGcTries >= 3);
    assert.equal(held.gc, null);
    await assert.rejects(closeBoundary({ tracker: { size: () => 0 }, witness: [], forceGc: 'no' }), /--expose-gc/);
    await assert.rejects(closeBoundary({ tracker: { size: () => 0 }, witness: [{}], forceGc: () => {} }), TypeError);
    assert.equal(countAlive([new WeakRef({})]), 1);
});

test('closeBoundary with a real lite-leak tracker and real gc (child, --expose-gc): released -> 0/0, held -> 1/1', () => {
    const src = `
const { createLeakTracker } = await import('@zakkster/lite-leak');
const { closeBoundary } = await import(${JSON.stringify(pathToFileURL(join(SOAK, 'boundary.mjs')).href)});
const tracker = createLeakTracker({ name: 't42' });
let worlds = [];
const witness = [];
// allocate inside a function: a top-level loop temporary could stay in the suspended module frame
function fill() { for (let i = 0; i < 64; i++) { const o = { i }; tracker.track(o, () => {}, 'w'); witness.push(new WeakRef(o)); worlds.push(o); } }
fill();
const keep = worlds[5];
const a = await closeBoundary({ tracker, witness: witness.filter((w, i) => i !== 5), dropRefs: () => { worlds = null; }, profiler: null, drainMs: 300 });
const b = await closeBoundary({ tracker, witness, profiler: null, drainMs: 200 });
process.stdout.write(JSON.stringify({ a: a.boundary, b: b.boundary, keep: keep.i }));
`;
    const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', src], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.a.trackerSize, 1, 'the kept target is still tracked (size() is the authority)');
    assert.equal(o.a.weakAlive, 0, 'every released world was collected');
    assert.equal(o.b.weakAlive, 1, 'the WeakRef witness sees the kept one');
    assert.equal(o.b.trackerSize, 1);
    assert.equal(o.keep, 5);
});

test('closeBoundary deref KeepDuringJob pin (child, --expose-gc): a target held only at the FIRST gc drains to 0/0; held throughout stays 1/1', () => {
    // Regression for the 2026-10-13 flake (test/40 GRAPH cycle 0 read 1/1 after 139 forced GCs): countAlive()'s
    // deref() pins a live target until the job ends, so a gc() in the same job can never collect it.
    const src = `
const { createLeakTracker } = await import('@zakkster/lite-leak');
const { closeBoundary } = await import(${JSON.stringify(pathToFileURL(join(SOAK, 'boundary.mjs')).href)});
let holder = null;
// allocate inside a function: a top-level temporary could stay in the suspended module frame
function make(tracker, witness) { const o = { big: new Array(64).fill(1) }; tracker.track(o, () => {}, 'w'); witness.push(new WeakRef(o)); holder = o; }
const t1 = createLeakTracker({ name: 't42-pin-released' });
const w1 = [];
make(t1, w1);
let calls = 0;
const releaseAfterFirst = () => { gc(); if (++calls === 1) holder = null; };
const a = await closeBoundary({ tracker: t1, witness: w1, profiler: null, forceGc: releaseAfterFirst, drainMs: 2000, drainTries: 8 });
const t2 = createLeakTracker({ name: 't42-pin-held' });
const w2 = [];
make(t2, w2);
const b = await closeBoundary({ tracker: t2, witness: w2, profiler: null, drainMs: 200, drainTries: 8 });
process.stdout.write(JSON.stringify({ a: a.boundary, b: b.boundary, held: holder !== null, calls }));
`;
    const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', src], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.ok(o.a.forcedGcTries >= 2, 'the first gc ran with the holder live, so the drain needs a second: ' + r.stdout);
    assert.equal(o.a.weakAlive, 0, 'released after the first gc -> collected (no harness deref pin): ' + r.stdout);
    assert.equal(o.a.trackerSize, 0, 'and finalized (size() is the authority): ' + r.stdout);
    // teeth: the fix must not hide a real leak
    assert.equal(o.held, true);
    assert.equal(o.b.weakAlive, 1, 'a target held for the whole drain is still seen alive: ' + r.stdout);
    assert.equal(o.b.trackerSize, 1, r.stdout);
    assert.ok(o.b.drainMs >= 200, 'a held target spends the budget: ' + r.stdout);
});

/* ---- QA burst 3b (2026-10-12): boundary matrix, appended ------------------------------------------- */

test('QA boundary Totals: crosses 2^30 / 2^31 / 2^32 exactly, stops at 2^53 - 1, rejects -1 NaN 0.5 null undefined 2^53; -0 adds as +0', () => {
    for (const start of [2 ** 30 - 1, 2 ** 31 - 1, 2 ** 32 - 1]) {
        const t = new G.Totals(['x']);
        t.add('x', start);
        t.add('x', 1);
        t.add('x', 1);
        assert.equal(t.get('x'), start + 2, 'exact across the wrap above ' + start);
    }
    const t = new G.Totals(['x']);
    t.add('x', 2 ** 53 - 2);
    t.add('x', 1);
    assert.equal(t.get('x'), 2 ** 53 - 1);
    assert.throws(() => t.add('x', 1), RangeError, 'past 2^53 - 1 is not exact');
    assert.equal(t.get('x'), 2 ** 53 - 1, 'a refused add leaves the total untouched');
    t.add('x', 0);
    for (const n of [-1, NaN, 0.5, null, undefined, 2 ** 53, Infinity, '1']) {
        assert.throws(() => new G.Totals(['y']).add('y', n), RangeError, 'add(' + String(n) + ')');
    }
    const z = new G.Totals(['z']);
    z.add('z', -0);
    assert.ok(Object.is(z.get('z'), 0), '-0 never surfaces as a -0 total');
    assert.throws(() => z.add('nope', 1), RangeError, 'an unknown slot is not created by add');
    assert.throws(() => z.ensure(''), TypeError);
});

test('QA boundary Totals growth: N-1, N, N+1 slots around the initial 4 keep every value; a duplicate name is one slot', () => {
    const t = new G.Totals(['a', 'b', 'c']);
    for (const [i, n] of ['a', 'b', 'c'].entries()) t.add(n, 2 ** 31 + i);
    assert.equal(t.ensure('d'), 3);
    t.add('d', 2 ** 32);
    assert.equal(t.ensure('e'), 4, 'the 5th slot grows the Float64Array');
    t.add('e', 2 ** 53 - 1);
    assert.equal(t.ensure('a'), 0, 'ensure of an existing name returns its slot');
    assert.deepEqual(t.toJSON(), { a: 2 ** 31, b: 2 ** 31 + 1, c: 2 ** 31 + 2, d: 2 ** 32, e: 2 ** 53 - 1 });
    const dup = new G.Totals(['k', 'k', 'k']);
    dup.add('k', 1);
    assert.deepEqual(dup.toJSON(), { k: 1 });
    assert.deepEqual(new G.Totals([]).toJSON(), {}, 'empty');
});

test('QA adversarial Totals.toJSON: a slot named __proto__ (an own key of a JSON-parsed failureCounts) survives the report',
    () => {
        const t = new G.Totals(['a']);
        t.ensure('__proto__');
        t.add('__proto__', 7);
        assert.equal(t.get('__proto__'), 7);
        const j = t.toJSON();
        assert.ok(Object.prototype.hasOwnProperty.call(j, '__proto__'), 'toJSON lost the __proto__ slot');
        assert.equal(Object.getOwnPropertyDescriptor(j, '__proto__').value, 7, 'the own __proto__ slot carries the total');
        assert.deepEqual(Object.getOwnPropertyDescriptor(j, 'a'),
            { value: 0, writable: true, enumerable: true, configurable: true });
        assert.deepEqual(Object.getOwnPropertyDescriptor(j, '__proto__'),
            { value: 7, writable: true, enumerable: true, configurable: true });
        assert.equal(Object.getPrototypeOf(j), Object.prototype, 'a plain {} (an own data key, not a prototype swap or a null-proto object)');
        assert.equal(JSON.stringify(j), '{"a":0,"__proto__":7}', 'the report keeps the slot, in names order');
    });

test('QA boundary EarlyLate: the ring counter started just below 2^30, 2^31 and 2^32 crosses the wrap; n = 1 and an empty window', () => {
    for (const start of [2 ** 30 - 2, 2 ** 31 - 2, 2 ** 32 - 2]) {
        const e = new G.EarlyLate(3);
        e.total = start;
        for (const v of [1, 2, 3, 4]) e.push(v);
        assert.equal(e.lateMedian(), 3, 'late = median(2, 3, 4) from ' + start);
        assert.equal(e.earlyMedian(), 2, 'early = median(1, 2, 3)');
        assert.equal(e.total, start + 4);
    }
    const one = new G.EarlyLate(1);
    assert.ok(Number.isNaN(one.lateMedian()) && Number.isNaN(one.earlyMedian()), 'empty -> NaN (null is not zero)');
    one.push(5); one.push(-0);
    assert.equal(one.earlyMedian(), 5);
    assert.ok(Object.is(one.lateMedian(), -0) || one.lateMedian() === 0);
    for (const n of [0, -1, NaN, 1.5, null, undefined]) assert.throws(() => new G.EarlyLate(n), RangeError, 'EarlyLate(' + String(n) + ')');
});

test('QA boundary findWorldIndex: w at 0, 1, 2^30 - 1, 2^30, 2^31 - 1, 2^31, 2^32 - 2; max = w excludes it, w + 1 finds it; bad max / ws throw', () => {
    const cs = seedFor(0xC0FFEE, 2, 0);
    for (const w of [0, 1, 2 ** 30 - 1, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 2]) {
        const ws = worldSeed(cs, w);
        assert.equal(findWorldIndex(0xC0FFEE, 2, 0, ws, 2 ** 32 - 1), w, 'w=' + w + ' at the widest bound');
        assert.equal(findWorldIndex(0xC0FFEE, 2, 0, ws, w + 1), w, 'w=' + w + ' with max = w + 1');
        if (w > 0) assert.equal(findWorldIndex(0xC0FFEE, 2, 0, ws, w), -1, 'max is exclusive at w=' + w);
    }
    for (const m of [0, -0, -1, NaN, 2 ** 32, 2 ** 53, 1.5, null, undefined]) {
        assert.throws(() => findWorldIndex(0xC0FFEE, 2, 0, 5, m), RangeError, 'max ' + String(m));
    }
    for (const s of [-1, NaN, 2 ** 32, 2 ** 53 - 1, 0.5, null, undefined]) {
        assert.throws(() => findWorldIndex(0xC0FFEE, 2, 0, s, 10), RangeError, 'ws ' + String(s));
    }
    assert.equal(findWorldIndex(0xC0FFEE, 2, 0, -0, 10), findWorldIndex(0xC0FFEE, 2, 0, 0, 10), '-0 is the uint32 0');
});

test('QA boundary LaneGates: zero records is not PASS; compute twice is idempotent; a 2^53-overflowing ops total throws, never wraps', () => {
    const empty = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] }).compute({ smoke: false });
    assert.notEqual(empty.status, 'PASS', 'a lane that ran nothing has no evidence');
    const L = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
    for (let c = 0; c < 11; c++) L.push(rec('GRAPH', c));
    const a = L.compute({ smoke: false });
    const b = L.compute({ smoke: false });
    assert.equal(a.status, 'PASS', JSON.stringify(a.causes));
    assert.deepEqual(b, a, 'compute is a read: a second call returns the same result');
    const big = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
    big.push(rec('GRAPH', 0, { ops: 2 ** 53 - 1 }));
    assert.throws(() => big.push(rec('GRAPH', 1, { ops: 1 })), RangeError);
    assert.throws(() => big.push(rec('GRAPH', 1, { ops: -1 })), G.GateInputError);
    assert.throws(() => big.push(rec('GRAPH', 1, { ops: NaN })), G.GateInputError);
    assert.throws(() => big.push(rec('GRAPH', 1, { memory: { residentMB: -0.5 } })), G.GateInputError);
    assert.throws(() => big.push(null), G.GateInputError);
    assert.throws(() => big.push(undefined), G.GateInputError);
});

test('QA adversarial LaneGates re-entrant push: a record getter that pushes the same cycle must not fold cycle 0 twice',
    () => {
        const L = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
        const outer = rec('GRAPH', 0);
        let fired = false;
        Object.defineProperty(outer, 'worlds', { enumerable: true, get() { if (!fired) { fired = true; L.push(rec('GRAPH', 0)); } return 250; } });
        let threw = false;
        let err = null;
        try { L.push(outer); } catch (e) { threw = true; err = e; }
        assert.equal(threw, true, 'a re-entrant push must throw (cycles=' + L.cycles + ')');
        assert.ok(err instanceof G.GateInputError && /re-entrant push/.test(err.message), 'GateInputError naming the re-entry: ' + String(err));
        assert.equal(L.cycles, 0, 'cycle 0 was folded ' + L.cycles + ' times (no partial fold on the refused record)');
        L.push(rec('GRAPH', 0));
        assert.equal(L.cycles, 1, 'the guard resets: a fresh push of cycle 0 folds once');
        assert.equal(L.totals.get('worlds'), 250);
    });

test('LaneGates re-entry guard is per lane: a record getter may push into a different lane', () => {
    const A = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
    const B = new G.LaneGates({ lane: 'BATCH', oracles: ORA, required: ['a', 'b'] });
    const outer = rec('GRAPH', 0);
    let fired = false;
    Object.defineProperty(outer, 'worlds', {
        enumerable: true,
        get() { if (!fired) { fired = true; B.push(rec('BATCH', 0)); } return 250; },
    });
    A.push(outer);
    assert.equal(A.cycles, 1);
    assert.equal(B.cycles, 1);
});

test('QA boundary judgeRun: empty lanes, null lane, duplicate lane result, status not in {PASS, FAIL, INCONCLUSIVE}', () => {
    const base = { engine: 'lite', skipped: [], reason: 'end', forever: false, smoke: false, configError: null, fatal: false };
    assert.equal(G.judgeRun({ ...base, configError: false, lanes: [] }).exitCode, 2, 'a non-null configError (even false) is a config error, never a pass');
    const none = G.judgeRun({ ...base, lanes: [] });
    assert.notEqual(none.verdict, 'PASS', 'no lane ran');
    assert.throws(() => G.judgeRun({ ...base, lanes: [null] }), G.GateInputError);
    assert.throws(() => G.judgeRun({ ...base, lanes: [undefined] }), G.GateInputError);
    assert.throws(() => G.judgeRun({ ...base, lanes: null }), TypeError);
    const L = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
    for (let c = 0; c < 11; c++) L.push(rec('GRAPH', c));
    const r = L.compute({ smoke: false });
    assert.equal(G.judgeRun({ ...base, lanes: [r, r] }).verdict, 'PASS');
    for (const s of ['SKIP', 'SMOKE', null, undefined, NaN]) {
        assert.throws(() => G.judgeRun({ ...base, lanes: [{ ...r, status: s }] }), G.GateInputError, 'status ' + String(s));
    }
});

/* ---- b76: a push is all-or-nothing (PLAN-0s-e2 TASK 5) --------------------------------------------- */

// Every observable fold field of one lane; a refused push must leave it byte-identical.
function laneState(L) {
    return JSON.stringify([L.cycles, L.post, L.bad, L.unmeasured, L.totals.toJSON(), L.checks.toJSON(),
        L.skips.toJSON(), L.scen.toJSON(), L.failures.toJSON(), L.failures.names.length, L.heap.total,
        L.heap.earlyCount, Array.from(L.heap.early), Array.from(L.heap.lateRing)]);
}
function freshLane() {
    const L = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
    L.push(rec('GRAPH', 0));
    return L;
}
const trapBoundary = () => new Proxy({ trackerSize: 0, weakAlive: 0 }, { get() { throw new Error('trap-b76'); } });

test('b76 R1 LaneGates: a boundary getter that pushes cycle 1 or 2 into its own lane leaves the outer record un-folded',
    () => {
        for (const inner of [1, 2]) {
            const L = freshLane();
            const pre = laneState(L);
            const outer = rec('GRAPH', 1);
            let fired = false;
            Object.defineProperty(outer, 'boundary', {
                enumerable: true,
                get() {
                    if (!fired) { fired = true; L.push(rec('GRAPH', inner)); }
                    return { trackerSize: 0, weakAlive: 0 };
                },
            });
            assert.throws(() => L.push(outer), /re-entrant push/, 'inner cycle ' + inner);
            assert.equal(laneState(L), pre, 'inner cycle ' + inner + ': the refused outer record half-folded');
            L.push(rec('GRAPH', 1));
            assert.equal(L.cycles, 2);
            assert.equal(L.totals.get('worlds'), 500);
            assert.equal(L.post, 1);
            assert.equal(L.heap.total, 1);
        }
    });

test('b76 R2 LaneGates: a boundary Proxy whose get trap throws leaves the record un-folded; a re-push folds', () => {
    const L = freshLane();
    const pre = laneState(L);
    assert.throws(() => L.push(rec('GRAPH', 1, { boundary: trapBoundary() })), /trap-b76/);
    assert.equal(laneState(L), pre, 'the refused record half-folded');
    L.push(rec('GRAPH', 1));
    assert.equal(L.cycles, 2);
    assert.equal(L.totals.get('worlds'), 500);
});

test('b76 R3 LaneGates: a count-map getter / ownKeys trap is read once, so a later throw never lands mid-fold', () => {
    const La = freshLane();
    const outerA = rec('GRAPH', 1);
    let reads = 0;
    Object.defineProperty(outerA.checks, 'O1c', {
        enumerable: true,
        get() { if (++reads >= 3) throw new Error('read-' + reads); return 7; },
    });
    La.push(outerA);
    assert.equal(La.cycles, 2, 'folds once');
    assert.equal(La.checks.get('O1c'), 1007);
    const Lb = freshLane();
    let calls = 0;
    const fc = new Proxy({ 'O1:x': 2 }, {
        ownKeys(t) { if (++calls === 2) throw new Error('ownKeys-2'); return Reflect.ownKeys(t); },
    });
    Lb.push(rec('GRAPH', 1, { failureCounts: fc }));
    assert.equal(Lb.cycles, 2, 'folds once');
    assert.deepEqual(Lb.failures.toJSON(), { 'O1:x': 2 });
});

test('b76 R4 LaneGates: 100 refused cycle-1 pushes (2^53 overflow, empty failure key, trap) leave the lane as it was',
    () => {
        const L = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
        L.push(rec('GRAPH', 0, { ops: 2 ** 53 - 1 }));
        const pre = laneState(L);
        for (let i = 0; i < 100; i++) {
            const k = i % 3;
            if (k === 0) assert.throws(() => L.push(rec('GRAPH', 1, { ops: 1 })), /exact range \(2\^53\)/);
            else if (k === 1) {
                const r = rec('GRAPH', 1, { ops: 0, failureCounts: { 'O1:y': 1, '': 1 } });
                assert.throws(() => L.push(r), TypeError);
            } else assert.throws(() => L.push(rec('GRAPH', 1, { ops: 0, boundary: trapBoundary() })), /trap-b76/);
            assert.equal(laneState(L), pre, 'refused push ' + i + ' (kind ' + k + ') half-folded');
        }
        assert.equal(L.cycles, 1);
        assert.equal(L.failures.names.length, 0);
        L.push(rec('GRAPH', 1, { ops: 0 }));
        assert.equal(L.cycles, 2);
    });

test('b76 R5 LaneGates: checks / skips / scenario 2^53, read once, warm on this.cycles, hidden keys, dup required',
    () => {
        const big = 2 ** 53 - 1;
        for (const [m, k] of [['checks', 'O1c'], ['skipTainted', SKIP_NAMES[0]], ['scenarios', 'a']]) {
            const L = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
            const r0 = rec('GRAPH', 0);
            r0[m][k] = big;
            L.push(r0);
            const pre = laneState(L);
            const r1 = rec('GRAPH', 1);
            r1[m][k] = 1;
            assert.throws(() => L.push(r1), /exact range \(2\^53\)/, m);
            assert.equal(laneState(L), pre, m + ': the refused record half-folded');
        }
        const L2 = freshLane();
        const r2 = rec('GRAPH', 1);
        for (const [m, k] of [['checks', 'O1c'], ['scenarios', 'a']]) {
            let n = 0;
            Object.defineProperty(r2[m], k, {
                enumerable: true, get() { if (++n >= 2) throw new Error('reread-' + m); return 7; },
            });
        }
        L2.push(r2);
        assert.equal(L2.checks.get('O1c'), 1007);
        assert.equal(L2.scen.get('a'), 15);
        const L3 = freshLane();
        const r3 = rec('GRAPH', 1);
        Object.defineProperty(r3.checks, 'O1c', { value: 5, enumerable: false });
        Object.defineProperty(r3.scenarios, 'a', { value: 5, enumerable: false });
        L3.push(r3);
        assert.equal(L3.checks.get('O1c'), 1005);
        assert.equal(L3.scen.get('a'), 13);
        const L4 = freshLane();
        const r4 = rec('GRAPH', 1, { memory: { residentMB: NaN } });
        let reads = 0;
        Object.defineProperty(r4, 'cycle', { enumerable: true, get() { return ++reads <= 2 ? 1 : 0; } });
        assert.throws(() => L4.push(r4), /residentMB/);
        assert.equal(L4.cycles, 1);
        assert.throws(() => new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'a'] }), TypeError);
    });

test('b79 B1 LaneGates: boundary.trackerSize / weakAlive, rec.cycle and rec.memory are read once (a 2nd read throws)',
    () => {
        const once = (o, k, v) => {
            let n = 0;
            Object.defineProperty(o, k, {
                enumerable: true, get() { if (++n >= 2) throw new Error('reread-' + k); return v; },
            });
            return o;
        };
        const L = new G.LaneGates({ lane: 'GRAPH', oracles: ORA, required: ['a', 'b'] });
        for (let c = 0; c < 2; c++) {
            const r = rec('GRAPH', c);
            once(r.boundary, 'trackerSize', 0);
            once(r.boundary, 'weakAlive', 0);
            once(r, 'cycle', c);
            once(r, 'memory', { residentMB: 10 });
            L.push(r);
        }
        assert.equal(L.cycles, 2, 'both records fold');
        assert.equal(L.post, 1, 'cycle 1 (post-warm-up) read memory.residentMB');
        assert.equal(L.unmeasured, 0);
        assert.equal(L.bad, 0);
        assert.equal(G.boundaryState(once(once({}, 'trackerSize', 1), 'weakAlive', 0)), 'bad');
        assert.equal(G.boundaryState(once(once({}, 'trackerSize', 0), 'weakAlive', 0)), 'ok');
        assert.equal(G.boundaryState(once(once({}, 'trackerSize', 0), 'weakAlive', -1)), 'unmeasured');
    });
