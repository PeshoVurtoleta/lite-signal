// 68-soak-taint-boundary.test.mjs -- boundary rows of the soak taint-skip gate (unit 0s-D6 qa, burst 72).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// Written from .handoff/PLAN-0s-d6.md A3' ("max(O1c, O1e) <= 0.35", inclusive) and gates.mjs's own contract
// ("0/0 is NaN and fails closed"), never from the implementation. test/67 pins the live run, D3 and the HALF
// control; test/42 holds one synthetic row each side (0.44 / 0.26). Unwitnessed until here: the EXACT 0.35 edge,
// one count past it, totals that cross 2^31 / 2^32 / 2^53-1 on the way, and the fail-closed inputs.
// Revert-red: `<=` -> `<`, `0.35` -> `0.75`, and `!(r <= max)` -> `r > max` each turn rows here red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../bench/soak/gates.mjs';
import { CHECK_NAMES, SKIP_NAMES } from '../bench/soak/exec.mjs';
import { TAINT_SKIP_MAX } from '../bench/soak/config.mjs';

const rule = (p, k, oracles = ['O1c']) => G.taintSkipRule({ oracles, performed: { O1c: p }, skipped: { O1c: k } });
const over = (r) => r.over.map((o) => o.oracle);

test('exact edge: 7/20 == 0.35 passes (inclusive); one more skipped check is over', () => {
    assert.equal(TAINT_SKIP_MAX, 0.35);
    assert.equal(7 / 20, TAINT_SKIP_MAX, 'precondition: 7/20 is the same double as 0.35');
    assert.deepEqual(over(rule(13, 7)), [], '13 performed / 7 skipped = 0.35 exactly');
    assert.equal(rule(13, 7).verdict, 'PASS');
    assert.deepEqual(over(rule(13, 8)), ['O1c']);
    assert.equal(rule(13, 8).verdict, 'INCONCLUSIVE');
    assert.deepEqual(over(rule(1, 0)), [], '0 skipped');
    assert.deepEqual(over(rule(0, 1)), ['O1c'], 'all skipped = 1.0');
});

test('scaled edge at N = 2^30, 2^31-1, 2^31, 2^32-1, 2^32, 2^48: 7N/20N passes, (7N+1)/20N is over', () => {
    for (const N of [2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 48]) {
        assert.deepEqual(over(rule(13 * N, 7 * N)), [], 'N=' + N + ' at the edge');
        assert.deepEqual(over(rule(13 * N - 1, 7 * N + 1)), ['O1c'], 'N=' + N + ' one count past the edge');
    }
    // performed + skipped == 2^53 - 1 and 2^53: still a ratio, never a wrap to a small or negative value
    const T = 2 ** 53 - 1;
    assert.deepEqual(over(rule(T - Math.floor(T * 0.3), Math.floor(T * 0.3))), []);
    assert.deepEqual(over(rule(2 ** 52, 2 ** 52)), ['O1c'], '2^53 total, ratio 0.5');
});

test('LaneGates totals cross 2^31 and 2^32 on the way and still judge the exact edge (counters started near 2^30)', () => {
    const base = 2 ** 28;   // per cycle 20 x 2^28 = 5 x 2^30; 11 cycles -> totals pass 2^31, 2^32 (55 x 2^30)
    const run = (extra) => {
        const L = new G.LaneGates({ lane: 'GRAPH', oracles: ['O1c', 'O1e'], required: [] });
        for (let c = 0; c < 11; c++) {
            const checks = {}; for (const o of CHECK_NAMES) checks[o] = 1000;
            const skipTainted = {}; for (const o of SKIP_NAMES) skipTainted[o] = 0;
            checks.O1c = 13 * base - (c === 10 ? extra : 0);
            skipTainted.O1c = 7 * base + (c === 10 ? extra : 0);
            L.push({ lane: 'GRAPH', cycle: c, worlds: 1, ops: 1, failingWorlds: 0, failureCounts: {}, checks, skipTainted,
                scenarios: {}, memory: { residentMB: 10 }, boundary: { trackerSize: 0, weakAlive: 0 } });
        }
        return L.compute({ smoke: false }).gates['taint-skip'];
    };
    const edge = run(0);
    assert.deepEqual(edge.over, [], 'totals 143 x 2^28 / 77 x 2^28 = 0.35 exactly');
    assert.equal(edge.ratios.O1c, 0.35);
    assert.deepEqual(run(1).over.map((o) => o.oracle), ['O1c'], 'one count past the edge at a 2^32+ total');
});

test('fail closed: 0/0, a missing key, undefined, NaN and -0/0 are over (null is not zero)', () => {
    assert.deepEqual(over(rule(0, 0)), ['O1c'], '0/0');
    assert.ok(Number.isNaN(rule(0, 0).ratios.O1c));
    assert.deepEqual(over(G.taintSkipRule({ oracles: ['O1c'], performed: {}, skipped: { O1c: 0 } })), ['O1c'], 'performed key missing');
    assert.deepEqual(over(G.taintSkipRule({ oracles: ['O1c'], performed: { O1c: 5 }, skipped: {} })), ['O1c'], 'skipped key missing');
    assert.deepEqual(over(G.taintSkipRule({ oracles: ['O1c'] })), ['O1c'], 'no count maps at all');
    assert.deepEqual(over(rule(undefined, 1)), ['O1c']);
    assert.deepEqual(over(rule(5, NaN)), ['O1c']);
    assert.deepEqual(over(rule(0, -0)), ['O1c'], '-0/0 is NaN');
    assert.deepEqual(over(rule(5, -0)), [], '-0 skipped of 5 is a zero ratio');
    assert.throws(() => G.taintSkipRule({ oracles: null }), /oracles must be an array/);
    assert.throws(() => G.taintSkipRule({ oracles: undefined }), /oracles must be an array/);
});

test('roster: only skipping oracles are judged; empty roster passes; a duplicated oracle is judged each time', () => {
    assert.deepEqual(G.taintSkipRule({ oracles: [], performed: {}, skipped: {} }).over, []);
    assert.deepEqual(over(G.taintSkipRule({ oracles: ['O5', 'O7a'], performed: {}, skipped: {} })), [], 'non-SKIP oracles never read');
    assert.deepEqual(over(rule(0, 1, ['O1c', 'O1c'])), ['O1c', 'O1c']);
});

// Adversarial (qa b72): the exported rule trusts its counts. LaneGates.push validates every count first
// (countMap: safe non-negative integers), so main.mjs cannot reach these; a direct caller can.
test('QA adversarial taintSkipRule: a null skipped count must not read as zero skips', { todo: 'DEFECT gates.mjs taintSkipRule: null skipped with 100 performed -> ratio null/(100+null) = 0 -> PASS (null is not zero)' }, () => {
    assert.deepEqual(over(rule(100, null)), ['O1c']);
});
test('QA adversarial taintSkipRule: a negative or string skipped count must fail closed', { todo: 'DEFECT gates.mjs taintSkipRule: skipped -1 -> ratio -0.0101 PASS; skipped "50" -> string concat 100+"50" -> ratio 0.004975 PASS' }, () => {
    assert.deepEqual(over(rule(100, -1)), ['O1c']);
    assert.deepEqual(over(rule(100, '50')), ['O1c']);
});
