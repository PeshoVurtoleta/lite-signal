// 73-soak-tmark.test.mjs -- the T-mark control + NOTE spec kind (burst 87, B-B4c, PLAN-0s-bb4c ASSERTIONS 1-2 + ADDENDUM 3).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// An INDEPENDENT ORACLE written from the plan text. Names assumed from the plan: _mustfail.mjs exports parseHead,
// hasToken, validSpec, buildKernel, CONTROLS and judgeMain (judgeMain is exported by B1; read through the namespace so
// an unexported name fails ITS test only); config.mjs exports MARK_DEDUPE_NOTE (= 0.99); anatomy.mjs openAnatomy.
// Expected counts are the deterministic 0a literals (.handoff/b87-evidence/B0/tmark-0a.txt, GRAPH worlds 0..31 of
// seedFor(0xC0FFEE, GRAPH.index, 0)); structural claims (stamp === edge, dedupe = stamp / edge) are recomputed.
// NO ratio >= 1.5 row (ruled out by ADDENDUM 3). Untimed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as MF from '../bench/soak/_mustfail.mjs';
import * as CFG from '../bench/soak/config.mjs';
import { openAnatomy } from '../bench/soak/anatomy.mjs';
import { liteAdapter } from '../bench/soak/adapters/lite.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import { laneByName } from '../bench/soak/lanes/index.mjs';
import { seedFor, worldSeed } from '../bench/soak/seeds.mjs';

const GRAPH = laneByName('GRAPH');
const CS = seedFor(0xC0FFEE, GRAPH.index, 0);
const scriptFor = (w) => generateWorld(GRAPH, worldSeed(CS, w), { large: false, covOff: null });
const control = () => {
    const c = MF.CONTROLS.find((x) => x.name === 'T-mark');
    assert.ok(c !== undefined, 'CONTROLS has a T-mark entry');
    return c;
};

/** Fold GRAPH worlds 0..31 through a fresh lane built from `source` (undefined = the live tree). */
function fold32(source) {
    const o = source === undefined ? openAnatomy() : openAnatomy({ source });
    assert.ok(o.lane !== null, 'lane available: ' + o.why);
    for (let w = 0; w < 32; w++) {
        const s = scriptFor(w);
        o.lane.shape(o.lane.adapter, s, runWorld(liteAdapter, s));
    }
    const j = o.lane.toJSON();
    assert.ok(j !== null, 'lane non-null: ' + o.lane.why);
    return j;
}

/* ---- ASSERTION 1 ------------------------------------------------------------------------------------ */

test('T-mark: MARK_DEDUPE_NOTE is 0.99', () => {
    assert.equal(CFG.MARK_DEDUPE_NOTE, 0.99);
});

test('T-mark: head GRAPH 0..31 -> 71529 stamps / 81913 edges, markDedupe < MARK_DEDUPE_NOTE', () => {
    const j = fold32();
    assert.equal(j.worlds, 32);
    assert.equal(j.counts.markStamp, 71529);
    assert.equal(j.counts.markEdge, 81913);
    assert.ok(j.markDedupe < CFG.MARK_DEDUPE_NOTE, 'head dedupe ' + j.markDedupe);
    assert.ok(Math.abs(j.markDedupe - 71529 / 81913) < 1e-9);
});

test('T-mark: the control\'s own patches -> mutant folds 32 worlds, stamp === edge === 111762, dedupe 1.000 >= MARK_DEDUPE_NOTE', () => {
    const j = fold32(MF.buildKernel(control()).src);
    assert.equal(j.worlds, 32);
    assert.equal(j.counts.markStamp, 111762);
    assert.equal(j.counts.markEdge, 111762);
    assert.equal(j.counts.markStamp, j.counts.markEdge);
    assert.equal(j.markDedupe, 1);
    assert.ok(j.markDedupe >= CFG.MARK_DEDUPE_NOTE);
});

test('T-mark must-fail: the control with patches [] (the plain tree) does NOT satisfy markStamp === markEdge', () => {
    const c = Object.assign({}, control(), { patches: [] });
    const j = fold32(MF.buildKernel(c).src);
    assert.notEqual(j.counts.markStamp, j.counts.markEdge);
    assert.ok(j.markDedupe < CFG.MARK_DEDUPE_NOTE);
});

/* ---- ASSERTION 2: the NOTE spec kind ---------------------------------------------------------------- */

const SPEC = 'NOTE shape[GRAPH] markDedupe>=0.99';
const line = (v) => 'soak: NOTE -- shape[GRAPH] markDedupe=' + v + ' cycle=1 worlds=3';

test('NOTE spec: =1.000 matches; =0.918 and =null do not', () => {
    assert.equal(MF.hasToken(line('1.000'), SPEC), true);
    assert.equal(MF.hasToken(line('0.918'), SPEC), false);
    assert.equal(MF.hasToken(line('null'), SPEC), false);
});

test('NOTE spec: a BREACH spec never matches a NOTE line, a NOTE spec never matches a BREACH line', () => {
    assert.equal(MF.hasToken(line('1.000'), 'BREACH shape[GRAPH] markDedupe>=0.99'), false);
    assert.equal(MF.hasToken(line('1.000'), 'shape[GRAPH] markDedupe>=0.99'), false);
    const breach = 'soak: BREACH shape[GRAPH] markDedupe=1.000 cycle=1 worlds=3 detail=x';
    assert.equal(MF.hasToken(breach, SPEC), false);
    assert.equal(MF.hasToken(breach, 'BREACH shape[GRAPH] markDedupe>=0.99'), true, 'sanity: the BREACH kind still parses');
});

test('NOTE spec: judging [1.000] is clean of spec problems, [1.000, 0.918] reports an extra problem (every line must pass)', () => {
    assert.equal(typeof MF.judgeMain, 'function', 'judgeMain exported');
    const c = control();
    const judge = (errs) => {
        const problems = [], matched = [];
        MF.judgeMain(c, { status: 0 }, errs, [], '/nonexistent-stream', problems, matched);
        return problems;
    };
    const good = judge([line('1.000'), line('1.000')]);
    const bad = judge([line('1.000'), line('0.918')]);
    assert.ok(bad.length > good.length, 'bad ' + JSON.stringify(bad) + ' vs good ' + JSON.stringify(good));
    assert.ok(bad.some((p) => /NOTE|markDedupe|0\.918|spec/.test(p) && !/END|sentinel/.test(p)), JSON.stringify(bad));
});

test('NOTE spec: validSpec rejects a NOTE spec with no >= token, accepts the T-mark control', () => {
    const c = control();
    assert.deepEqual(MF.validSpec(c), []);
    const mk = (spec) => Object.assign({}, c, { expect: Object.assign({}, c.expect, { specs: [spec] }) });
    assert.ok(MF.validSpec(mk('NOTE shape[GRAPH]')).length > 0);
    assert.ok(MF.validSpec(mk('NOTE shape[GRAPH] markDedupe=1.000')).length > 0);
    assert.ok(MF.validSpec(mk('NOTE')).length > 0);
    assert.ok(MF.validSpec(mk(' NOTE shape[GRAPH] markDedupe>=0.99')).length > 0, 'a leading space would dispatch the NOTE spec as a one-line BREACH-style match');
});

test('NOTE spec must-fail: 3 GRAPH cycle records (+1 DEEP) need exactly 3 shape[GRAPH] lines -- 2 lines is the count problem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b87-tmark-'));
    try {
        const out = join(dir, 's.jsonl');
        const recs = [{ type: 'header' }, { type: 'cycle', lane: 'GRAPH', cycle: 0 }, { type: 'cycle', lane: 'DEEP', cycle: 0 },
            { type: 'cycle', lane: 'GRAPH', cycle: 1 }, { type: 'cycle', lane: 'GRAPH', cycle: 2 }, { type: 'summary' }];
        writeFileSync(out, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
        const so = ['soak: END verdict=SMOKE exit=0 records=' + recs.length];
        const judge = (errs) => {
            const problems = [];
            MF.judgeMain(control(), { status: 0 }, errs, so, out, problems, []);
            return problems.filter((p) => p.indexOf('stream cycle record') !== -1);
        };
        const l = (k) => 'soak: NOTE -- shape[GRAPH] markDedupe=1.000 cycle=' + k + ' worlds=3';
        assert.deepEqual(judge([l(0), l(1), l(2)]), [], 'one line per GRAPH cycle record is no count problem');
        const two = judge([l(0), l(2)]);
        assert.equal(two.length, 1, JSON.stringify(two));
        assert.match(two[0], /selected 2 line\(s\) != 3 stream cycle record\(s\) of lane GRAPH/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
