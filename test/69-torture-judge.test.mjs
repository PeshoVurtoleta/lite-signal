// 69-torture-judge.test.mjs -- the slope judge shared by the torture set / untrack / QS lanes (b78 F-T64-ASET).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// Written from .handoff/PLAN-0s-f-t64.md (TASK 1 + ASSERTIONS 1-3), never from test/torture-judge.mjs. The
// vectors and the old-rule (ord 1) golden numbers are INLINED as literals (copied from the dev-only, gitignored
// .handoff/b78-before/judge-vectors.mjs + judge-golden.json; CI has no .handoff/). The ord-2 numbers below were
// derived by hand from the arrays (lo = min even index; hi = 2nd-smallest odd index; pass iff hi <= lo).
// Revert-red: SLOPE_ORD = 1 -> V1 red; lo = 2nd-smallest even -> V3 red; no entry validation -> F rows red;
// an own min loop back in alRead / qsRead -> the wiring row red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SLOPE_ORD, judgeSlope } from './torture-judge.mjs';

const rep = (pair, n) => { const o = []; for (let i = 0; i < n; i++) o.push(...pair); return o; };
const V = {
    V1: [1536, 3200, 640, 3200, 640, 3200, 640, 640, 640, 11144, 640, 3200, 640, 3200, 640, 3200],
    V2: [640, 3200, 640, 3200, 640, 3200, 27688, 3200, 640, 3200, 640, 3200, 640, 3200, 640, 3200],
    V3: [640, 3200, ...rep([9536, 3200], 7)],
    V4: [0, 32, 0, 32, 0, 32, 0, 32, 32, 32, 0, 32, 0, 32, 0, 32],
    V4g: rep([0, 32, 0, 0], 4),
    L1: [null, 0, 6336, 6336, 6336, 6336, 16, 0, 16, 27912, 0, 0, 16, 0, 27048, 24208],
    L2: new Array(16).fill(16),
    L3: [0, 0, 0, 0, 0, 32024, 0, 0, 27688, 0, 0, 0, 0, 0, 0, 0],
    C1: [17504, 6336, 6400, 6352, 16, 6336, 16, 0, 16, 28824, 0, 6336, 27048, 6336, 6352, 6424],
    B1: [640, 3200, 640, 640, 640, 3200, 640, 640, 640, 3200, 640, 3200, 640, 3200, 640, 3200],
    F1: [0, 0, 0, null, 0, null, 0, null, 0, null, 0, null, 0, 0, 0, 0],
    FNaN: [0, 0, 0, NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    FNeg: [0, 0, 0, -16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    FStr: [0, 0, 0, '0', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    FUnd: [0, 0, 0, undefined, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    CTL: [1296, 6400, ...rep([1280, 6400], 7)],
};
// Old rule (ord 1), HEAD alRead verbatim, valid-entry vectors: [lo, hi, nLo, nHi, pass].
const GOLD_AL = {
    V1: [640, 640, 8, 8, true], V2: [640, 3200, 8, 8, false], V3: [640, 3200, 8, 8, false],
    V4: [0, 32, 8, 8, false], V4g: [0, 0, 8, 8, true], L1: [0, 0, 7, 8, true], L2: [16, 16, 8, 8, true],
    L3: [0, 0, 8, 8, true], C1: [0, 0, 8, 8, true], B1: [640, 640, 8, 8, true], F1: [0, 0, 8, 3, false],
    CTL: [1280, 6400, 8, 8, false],
};
// HEAD qsRead pmin / nPair (valid-entry vectors): [pmin, nPair].
const GOLD_QS = {
    V1: [0, 8], V2: [-24488, 8], V3: [-6336, 8], V4: [0, 8], V4g: [0, 8], L1: [-2840, 7], L2: [0, 8],
    L3: [-27688, 8], C1: [-20712, 8], B1: [0, 8], F1: [0, 3], CTL: [5104, 8],
};
const NEW = { // ord 2 verdicts, hand-derived
    V1: 'FAIL', V2: 'FAIL', V3: 'FAIL', V4: 'FAIL', V4g: 'PASS', L1: 'PASS', L2: 'PASS', L3: 'PASS',
    C1: 'FAIL', B1: 'PASS', F1: 'UNMEASURED', FNaN: 'UNMEASURED', FNeg: 'UNMEASURED', FStr: 'UNMEASURED',
    FUnd: 'UNMEASURED', CTL: 'FAIL',
};
const verdict = (r) => (!r.measured ? 'UNMEASURED' : r.pass ? 'PASS' : 'FAIL');

test('SLOPE_ORD is 2', () => { assert.equal(SLOPE_ORD, 2); });

test('ord 1 reproduces the HEAD judge on every valid-entry vector (golden literals)', () => {
    for (const k of Object.keys(GOLD_AL)) {
        const r = judgeSlope(V[k], true, 1);
        assert.deepEqual([r.lo, r.hi, r.nLo, r.nHi, r.pass], GOLD_AL[k], k + ' al');
        assert.deepEqual([r.pmin, r.nPair], GOLD_QS[k], k + ' qs');
    }
});

test('ord 2 (default) gives the planned verdict on every vector', () => {
    for (const k of Object.keys(V)) {
        assert.equal(verdict(judgeSlope(V[k], true)), NEW[k], k + ' default');
        assert.equal(verdict(judgeSlope(V[k], true, 2)), NEW[k], k + ' ord 2');
    }
});

test('TEETH V1 (the b77 false pass): ord 2 lo 640 hi 3200 hiMin 640 FAIL; ord 1 passes it', () => {
    const r = judgeSlope(V.V1, true);
    assert.equal(r.lo, 640);
    assert.equal(r.hi, 3200);
    assert.equal(r.hiMin, 640);
    assert.equal(r.measured, true);
    assert.equal(r.pass, false);
    assert.equal(judgeSlope(V.V1, true, 1).pass, true, 'old rule: the b77 false pass');
});

test('pins: C1 old PASS new FAIL; B1 two odd dips PASS (documented blind spot); V3/V4/V4g/L rows', () => {
    assert.equal(judgeSlope(V.C1, true, 1).pass, true);
    assert.equal(judgeSlope(V.C1, true).pass, false, 'C1 trade-off: a pass needs two clean odd batches');
    assert.equal(judgeSlope(V.B1, true).pass, true, 'blind spot: two odd dips in one attempt');
    assert.equal(judgeSlope(V.V3, true).pass, false, 'guards a "2nd-smallest even" variant');
    assert.equal(judgeSlope(V.V4, true).pass, false);
    assert.equal(judgeSlope(V.V4g, true).pass, true);
    const l1 = judgeSlope(V.L1, true);
    assert.deepEqual([l1.lo, l1.hi, l1.nLo, l1.pass], [0, 0, 7, true]);
    assert.equal(judgeSlope(V.L2, true).pass, true);
    assert.equal(judgeSlope(V.L3, true).pass, true);
});

test('fail closed: ok must be exactly true', () => {
    for (const ok of [false, 'true', 1, undefined, null]) {
        const r = judgeSlope(V.L2, ok);
        assert.equal(r.measured, false, String(ok));
        assert.equal(r.pass, false, String(ok));
    }
    assert.equal(judgeSlope(V.L2, true).measured, true);
});

test('fail closed: bad entries and too few batches are unmeasured, never a pass', () => {
    for (const k of ['F1', 'FNaN', 'FNeg', 'FStr', 'FUnd']) {
        const r = judgeSlope(V[k], true);
        assert.equal(r.measured, false, k);
        assert.equal(r.pass, false, k);
    }
    assert.equal(judgeSlope(V.F1, true).nHi, 3);
    const inf = V.L2.slice(); inf[3] = Infinity;
    const r = judgeSlope(inf, true);
    assert.equal(r.measured, false, 'Infinity slot');
    assert.equal(r.pass, false);
    const mk = (nEven) => V.L2.map((x, i) => ((i & 1) === 0 && i >= 2 * nEven ? null : x));
    assert.equal(judgeSlope(mk(4), true).measured, true, 'nLo 4 is enough');
    assert.equal(judgeSlope(mk(3), true).measured, false, 'nLo 3');
});

test('fail closed: non-arrays never throw and are never measured', () => {
    const objs = [null, undefined, { length: 16 }, new Float64Array(16), 'abcdefghijklmnop', 16];
    for (const o of objs) {
        let r;
        assert.doesNotThrow(() => { r = judgeSlope(o, true); });
        assert.equal(r.measured, false);
        assert.equal(r.pass, false);
    }
});

test('ord other than 1 or 2 throws RangeError', () => {
    for (const o of [3, 0, '2', -1, 1.5, NaN]) {
        assert.throws(() => judgeSlope(V.L2, true, o), RangeError, String(o));
    }
});

test('QS control vector: pmin 5104, nPair 8', () => {
    const r = judgeSlope(V.CTL, true);
    assert.equal(r.pmin, 5104);
    assert.equal(r.nPair, 8);
});

// ---- wiring: test/torture.mjs must use the shared judge and carry no private copy of the rule ----
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
const callArgs = (s, at) => { // top-level comma count inside the call starting at s[at] == '('
    let d = 0, commas = 0;
    for (let i = at; i < s.length; i++) {
        const c = s[i];
        if (c === '(' || c === '[' || c === '{') d++;
        else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) return commas; }
        else if (c === ',' && d === 1) commas++;
    }
    return -1;
};
const wiringProblems = (raw) => {
    const s = strip(raw), bad = [];
    if (!/import\s*\{[^}]*\bjudgeSlope\b[^}]*\}\s*from\s*['"]\.\/torture-judge\.mjs['"]/.test(s)) bad.push('import');
    const calls = [...s.matchAll(/\bjudgeSlope\s*\(/g)];
    if (calls.length !== 2) bad.push('call count ' + calls.length);
    for (const m of calls) if (callArgs(s, m.index + m[0].length - 1) !== 1) bad.push('third argument / arity');
    if (/\bhi\s*<=\s*at\.lo\b/.test(s)) bad.push('hi <= at.lo');
    if (/\bv\s*<\s*hi\b|\bhi\s*>\s*v\b|\bhi\s*=\s*v\b/.test(s)) bad.push('own min loop');
    return bad;
};

test('wiring: test/torture.mjs imports and calls judgeSlope twice, default ord, no private rule', () => {
    const src = readFileSync(new URL('./torture.mjs', import.meta.url), 'utf8');
    assert.deepEqual(wiringProblems(src), []);
    const s = strip(src);
    assert.ok(s.includes('const ok = r.settled && endOk && steps === AL_STEPS && fires === AL_STEPS;'), 'al ok');
    assert.ok(s.includes('const ok = r.settled && endOk && steps === QS_STEPS;'), 'qs ok');
    assert.equal((s.match(/\.\.\.judgeSlope\(r\.batchBytes, ok\) \};/g) || []).length, 2, 'judge result last');
    assert.equal((s.match(/if \(at\.pass\) (setPass|unPass|qsPass) = at;/g) || []).length, 3, 'pass sites');
    assert.equal(/\.pass\s*=[^=]/.test(s), false, 'no pass override');
});

test('wiring check has teeth: the HEAD alRead shape and a 3-arg call are flagged', () => {
    const head = `function alRead(r) { let hi = null; for (let b = 0; b < n; b++) { const v = r[b];
        else { nHi++; if (hi === null || v < hi) hi = v; } } }
        if (at.measured && at.hi <= at.lo) setPass = at;`;
    const bad = wiringProblems(head);
    for (const k of ['import', 'call count 0', 'hi <= at.lo', 'own min loop']) assert.ok(bad.includes(k), k);
    const three = "import { judgeSlope } from './torture-judge.mjs';\n" +
        'const a = judgeSlope(r.batchBytes, ok, 1); const b = judgeSlope(r.batchBytes, ok);';
    assert.ok(wiringProblems(three).includes('third argument / arity'));
    const good = "import { judgeSlope } from './torture-judge.mjs';\n" +
        'const a = judgeSlope(r.batchBytes, ok); const b = judgeSlope(x.y(1, 2), z && w);';
    assert.deepEqual(wiringProblems(good), []);
});

// ---- purity ----
test('purity: torture-judge.mjs has no imports and no top-level side effects', () => {
    const s = strip(readFileSync(new URL('./torture-judge.mjs', import.meta.url), 'utf8'));
    assert.equal(/^\s*import\b|\bimport\s*\(|\brequire\s*\(/m.test(s), false, 'no import');
    for (const line of s.split('\n')) {
        if (line === '' || /^\s/.test(line) || /^[})\]]/.test(line)) continue; // body or closer
        assert.match(line, /^(export\s+)?(const|let|function|async\s+function)\b|^export\s*\{/, 'top-level: ' + line);
    }
    assert.equal(/\b(process|console|globalThis|setTimeout)\b/.test(s), false, 'no host access');
});
