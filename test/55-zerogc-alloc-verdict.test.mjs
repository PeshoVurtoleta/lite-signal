/**
 * test/55-zerogc-alloc-verdict.test.mjs -- the zerogc byte witness verdict (burst 0b TASK 7, assertion 3).
 *
 * bench/torture/helpers/alloc-verdict.mjs maps one checkAllocs report to a step of the byte witness:
 * pass / fail / retry / inconclusive. Only an INVERTED-BRACKET inconclusive (bytesPerCall null, every
 * measured batch inverted, the run settled) is re-measured, up to ALLOC_ATTEMPTS; a measured 'fail' is never
 * retried; any other inconclusive (unsettled -- even all-inverted --, no memory channel) is a broken harness
 * and FAILs; an unknown verdict FAILs. byteWitnessLabel / churnNote / inconclusiveSuffix are the report text
 * zerogc-torture.mjs prints for each outcome; the wiring test pins that it prints exactly those.
 *
 * The fakes are scripted measure / check pairs with call counts, so "retried" and "stopped after one
 * measure" are counted, not inferred. One child process pins the gc-profiler semantics the mapping relies
 * on: a REAL measureAllocs result cloned into the all-inverted shape is a real checkAllocs 'inconclusive'
 * with reason 'bracket_inverted', and allocStep maps it to 'retry'. A wiring test proves zerogc-torture.mjs
 * goes through bytesWitness instead of its old `aRep.verdict === "pass"` gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOC_ATTEMPTS, allocStep, bytesWitness, byteWitnessLabel, churnNote, inconclusiveSuffix } from '../bench/torture/helpers/alloc-verdict.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VERDICT_URL = pathToFileURL(ROOT + 'bench/torture/helpers/alloc-verdict.mjs').href;
const ZEROGC = ROOT + 'bench/torture/zerogc-torture.mjs';

// alloc / report shapes as measureAllocs / checkAllocs (gc-profiler 1.16.0) return them, reduced to the read fields
const INV = { alloc: { bytesPerCall: null, invertedBatches: 8, settled: true, source: 'node' }, rep: { verdict: 'inconclusive' } };
const PASS = { alloc: { bytesPerCall: 0, invertedBatches: 0, settled: true, source: 'node' }, rep: { verdict: 'pass' } };
const FAIL = { alloc: { bytesPerCall: 56, invertedBatches: 0, settled: true, source: 'node' }, rep: { verdict: 'fail' } };
const UNSETTLED = { alloc: { bytesPerCall: 40, invertedBatches: 0, settled: false, source: 'node' }, rep: { verdict: 'inconclusive' } };
const NO_CHANNEL = { alloc: { bytesPerCall: null, invertedBatches: 0, settled: false, source: 'none' }, rep: { verdict: 'inconclusive' } };
// all measured batches inverted AND a batch lacked a finite reading: gc-profiler 1.16.0 still says 'bracket_inverted'
const INV_UNSETTLED = { alloc: { bytesPerCall: null, invertedBatches: 3, settled: false, source: 'node' }, rep: { verdict: 'inconclusive', reason: 'bracket_inverted' } };

/** A scripted measure / check pair: measure() returns script[i].alloc, check(alloc) returns its rep. */
function scripted(script) {
    const c = { measure: 0, check: 0, seen: [] };
    const measure = () => {
        if (c.measure >= script.length) throw new Error('measure called past the script (' + script.length + ')');
        return script[c.measure++].alloc;
    };
    const check = (alloc) => {
        c.seen.push(alloc);
        const s = script[c.check++];
        assert.equal(alloc, s.alloc, 'check() receives the alloc measure() just returned');
        return s.rep;
    };
    return { c, measure, check };
}

test('ALLOC_ATTEMPTS is 3', () => {
    assert.equal(ALLOC_ATTEMPTS, 3);
});

test('bytesWitness [inv, inv, inv] -> inconclusive after exactly 3 measures', () => {
    const f = scripted([INV, INV, INV]);
    const r = bytesWitness(f.measure, f.check, ALLOC_ATTEMPTS);
    assert.equal(r.outcome, 'inconclusive');
    assert.equal(r.attempts, 3);
    assert.equal(r.budget, ALLOC_ATTEMPTS);
    assert.equal(f.c.measure, 3);
    assert.equal(f.c.check, 3);
    assert.equal(r.alloc, INV.alloc);
    assert.equal(r.rep, INV.rep);
});

test('bytesWitness [fail] -> fail after ONE measure: a measured fail is never retried', () => {
    const f = scripted([FAIL, PASS, PASS]);
    const r = bytesWitness(f.measure, f.check, ALLOC_ATTEMPTS);
    assert.deepEqual([r.outcome, r.attempts, f.c.measure, f.c.check], ['fail', 1, 1, 1]);
    assert.equal(r.alloc, FAIL.alloc);
    assert.equal(r.rep, FAIL.rep);
});

test('bytesWitness [inv, pass] -> pass on attempt 2; [inv, fail] -> fail on attempt 2', () => {
    const f = scripted([INV, PASS, FAIL]);
    const r = bytesWitness(f.measure, f.check, ALLOC_ATTEMPTS);
    assert.deepEqual([r.outcome, r.attempts, f.c.measure], ['pass', 2, 2]);
    assert.equal(r.alloc, PASS.alloc);
    const g = scripted([INV, FAIL, PASS]);
    const s = bytesWitness(g.measure, g.check, ALLOC_ATTEMPTS);
    assert.deepEqual([s.outcome, s.attempts, g.c.measure], ['fail', 2, 2]);
});

test('bytesWitness: an unsettled 40 B/call, a no-memory-channel and an UNSETTLED all-inverted inconclusive FAIL after exactly 1 measure', () => {
    for (const bad of [UNSETTLED, NO_CHANNEL, INV_UNSETTLED]) {
        const f = scripted([bad, PASS, PASS]);
        const r = bytesWitness(f.measure, f.check, ALLOC_ATTEMPTS);
        assert.deepEqual([r.outcome, r.attempts, f.c.measure], ['fail', 1, 1], JSON.stringify(bad.alloc));
        assert.equal(r.rep.verdict, 'inconclusive', 'the caller sees the inconclusive report it must label UNVERIFIABLE');
    }
});

test('bytesWitness budget 1: one inverted measure is inconclusive, never retried', () => {
    const f = scripted([INV, PASS]);
    const r = bytesWitness(f.measure, f.check, 1);
    assert.deepEqual([r.outcome, r.attempts, f.c.measure], ['inconclusive', 1, 1]);
});

test('bytesWitness: a budget that is not an integer >= 1 throws BEFORE the first measure', () => {
    for (const b of [0, -1, 1.5, NaN, Infinity, '3', null, undefined, 2 ** 31 + 0.5]) {
        const f = scripted([PASS]);
        assert.throws(() => bytesWitness(f.measure, f.check, b), RangeError, 'budget ' + String(b));
        assert.equal(f.c.measure, 0, 'no measure for budget ' + String(b));
    }
    assert.throws(() => bytesWitness(null, () => PASS.rep, 3), TypeError);
    assert.throws(() => bytesWitness(() => PASS.alloc, null, 3), TypeError);
});

test('allocStep: the whole mapping table (unknown verdict and a non-object report fail closed)', () => {
    const cases = [
        [PASS, 1, 3, 'pass'], [PASS, 3, 3, 'pass'],
        [FAIL, 1, 3, 'fail'], [FAIL, 3, 3, 'fail'],
        [INV, 1, 3, 'retry'], [INV, 2, 3, 'retry'], [INV, 3, 3, 'inconclusive'], [INV, 1, 1, 'inconclusive'],
        [UNSETTLED, 1, 3, 'fail'], [NO_CHANNEL, 1, 3, 'fail'],
        // every measured batch inverted but the run did not settle: gc-profiler says bracket_inverted, the witness FAILs
        [INV_UNSETTLED, 1, 3, 'fail'], [INV_UNSETTLED, 3, 3, 'fail'],
        [{ alloc: { bytesPerCall: null, invertedBatches: 3 }, rep: { verdict: 'inconclusive' } }, 1, 3, 'fail'],
        // partially inverted (a finite floor exists): the report's own verdict stands
        [{ alloc: { bytesPerCall: 0, invertedBatches: 3, settled: true }, rep: { verdict: 'pass' } }, 1, 3, 'pass'],
        // inverted batches but a finite floor and an inconclusive report: not the bracket case -> fail
        [{ alloc: { bytesPerCall: 2, invertedBatches: 3, settled: false }, rep: { verdict: 'inconclusive' } }, 1, 3, 'fail'],
        [{ alloc: INV.alloc, rep: { verdict: 'maybe' } }, 1, 3, 'fail'],
        [{ alloc: INV.alloc, rep: { verdict: undefined } }, 1, 3, 'fail'],
        [{ alloc: INV.alloc, rep: null }, 1, 3, 'fail'],
        [{ alloc: null, rep: { verdict: 'inconclusive' } }, 1, 3, 'fail'],
        [{ alloc: { bytesPerCall: null, invertedBatches: '8' }, rep: { verdict: 'inconclusive' } }, 1, 3, 'fail'],
    ];
    for (const [s, attempt, budget, want] of cases) {
        assert.equal(allocStep(s.rep, s.alloc, attempt, budget), want, JSON.stringify([s, attempt, budget]));
    }
    for (const [attempt, budget] of [[1, 0], [1, 1.5], [0, 3], [4, 3], [1.5, 3], [NaN, 3]]) {
        assert.throws(() => allocStep(PASS.rep, PASS.alloc, attempt, budget), RangeError, JSON.stringify([attempt, budget]));
    }
});

test('gc-profiler pin: a REAL measureAllocs result cloned all-inverted is a real checkAllocs inconclusive that allocStep retries', () => {
    const src = `
        import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';
        import { allocStep } from ${JSON.stringify(VERDICT_URL)};
        const SINK = new Int32Array(1);
        const real = measureAllocs((i) => { SINK[0] = i; }, { iterations: 1000, batches: 4, warmup: 1000 });
        const inv = Object.assign({}, real, {
            batchBytes: real.batchBytes.map(() => null), measuredBatches: 0, invertedBatches: real.batches,
            bytesPerCall: null, maxBytesPerCall: null,
        });
        const unsettled = Object.assign({}, real, { bytesPerCall: 40, maxBytesPerCall: 40, settled: false });
        const invRep = checkAllocs(inv, { maxBytesPerCall: 0 });
        const unRep = checkAllocs(unsettled, { maxBytesPerCall: 0 });
        console.log(JSON.stringify({
            realSettled: real.settled, invSettled: inv.settled,
            inv: { verdict: invRep.verdict, reason: invRep.reason, step1: allocStep(invRep, inv, 1, 3), step3: allocStep(invRep, inv, 3, 3) },
            un: { verdict: unRep.verdict, step1: allocStep(unRep, unsettled, 1, 3) },
        }));
    `;
    const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', src], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(o.realSettled, true, 'the real run settled (the clone keeps settled: every batch got a finite reading)');
    assert.equal(o.invSettled, true);
    assert.deepEqual(o.inv, { verdict: 'inconclusive', reason: 'bracket_inverted', step1: 'retry', step3: 'inconclusive' });
    assert.deepEqual(o.un, { verdict: 'inconclusive', step1: 'fail' }, 'gc-profiler reports an unsettled run inconclusive; the witness FAILs it');
});

test('wiring: zerogc-torture.mjs gates its byte witness through bytesWitness, never on aRep.verdict === "pass"', () => {
    const s = readFileSync(ZEROGC, 'utf8');
    assert.match(s, /^import \{[^}]*\bbytesWitness\b[^}]*\} from "\.\/helpers\/alloc-verdict\.mjs";$/m);
    assert.match(s, /^import \{[^}]*\bbyteWitnessLabel\b[^}]*\bchurnNote\b[^}]*\binconclusiveSuffix\b[^}]*\} from "\.\/helpers\/alloc-verdict\.mjs";$/m);
    // the call itself: the measureAllocs / checkAllocs closures and the ALLOC_ATTEMPTS budget (not a comment)
    assert.match(s, /\n {4}const w = bytesWitness\(\s*\(\) => measureAllocs\(fn, \{ iterations: ITER, warmup: WARMUP \}\),\s*\(alloc\) => checkAllocs\(alloc, \{ maxBytesPerCall \}\),\s*ALLOC_ATTEMPTS\);\n/);
    // the outcome is reported through byteWitnessLabel, verbatim: inconclusive counted, ok / note as labelled
    assert.match(s, /\n {4}const lab = byteWitnessLabel\(name, w, steady, maxBytesPerCall\);\n {4}bytesInconclusive \+= lab\.inconclusive;\n {4}if \(lab\.ok !== null\) R\.ok\(name, lab\.ok, lab\.detail\);\n {4}if \(lab\.note !== null\) R\.note\(lab\.note\);\n/);
    assert.match(s, /\n {4}return \{ s0, s1, bytes: w\.outcome \};\n/);
    assert.match(s, /const \{ s0, s1 \} = gateAllocAndGc\(name, st, RULES\.maxBytesPerCall, true\);/, 'steady scenarios name the scavenge window');
    assert.match(s, /const \{ s0, s1, bytes \} = gateAllocAndGc\(name, st, CHURN_BYTES_FLOOR, false\);/);
    assert.match(s, /\n {4}R\.note\(churnNote\(name, bytes, CHURN_BYTES_FLOOR\)\);\n/);
    assert.ok(s.includes('R.finish("the steady-state hot path retained 0 bytes and forced 0 major GCs; node churn leaked nothing" +\n    inconclusiveSuffix(bytesInconclusive))'), 'the pass line is byte-identical + the suffix');
    // the counter: declared 0, incremented only by the label, read only by the suffix
    assert.match(s, /^let bytesInconclusive = 0;$/m);
    assert.equal(s.match(/bytesInconclusive/g).length, 3);
    // no second, hand-built copy of the report text
    assert.doesNotMatch(s, /aRep\.verdict === "pass"/);
    assert.doesNotMatch(s, /["`][^"`\n]*(retained < |INCONCLUSIVE:|UNVERIFIABLE|byte witness: pass)/, 'no such string literal');
    assert.equal(s.match(/\bR\.ok\(name, /g).length, 3, 'R.ok(name, ...): the byte label, checkNoGc, the nursery window -- no other');
});

/* ---- the report text (byteWitnessLabel / churnNote / inconclusiveSuffix) ----------------------------------- */

const W = (outcome, attempts, alloc, rep) => ({ outcome, attempts, budget: 3, alloc, rep });

test('byteWitnessLabel pass: ok, no detail, no note, nothing counted', () => {
    assert.deepEqual(byteWitnessLabel('steady-deep', W('pass', 1, PASS.alloc, PASS.rep), true, 0),
        { ok: true, detail: null, note: null, inconclusive: 0 });
});

test('byteWitnessLabel pass after a retry: ok plus the attempt note', () => {
    assert.deepEqual(byteWitnessLabel('churn-box', W('pass', 2, PASS.alloc, PASS.rep), false, 1),
        { ok: true, detail: null, note: 'churn-box -- byte witness: pass on attempt 2/3', inconclusive: 0 });
});

test('byteWitnessLabel fail: a measured fail is an R.ok(false) with the HEAD message + the attempt', () => {
    assert.deepEqual(byteWitnessLabel('injected', W('fail', 1, { bytesPerCall: 32, invertedBatches: 0, settled: true }, { verdict: 'fail' }), true, 0),
        { ok: false, detail: 'retained 32 B/call vs floor 0 (verdict fail, attempt 1/3)', note: null, inconclusive: 0 });
    assert.deepEqual(byteWitnessLabel('injected', W('fail', 2, { bytesPerCall: 32, invertedBatches: 2, settled: true }, { verdict: 'fail' }), true, 0).detail,
        'retained 32 B/call vs floor 0 (verdict fail, 2 inverted batch(es), attempt 2/3)');
});

test('byteWitnessLabel UNVERIFIABLE fail: an inconclusive report the witness failed, and an unknown outcome', () => {
    assert.deepEqual(byteWitnessLabel('steady-wide', W('fail', 1, UNSETTLED.alloc, UNSETTLED.rep), true, 0),
        { ok: false, detail: 'UNVERIFIABLE: retained 40 B/call vs floor 0 (verdict inconclusive, UNSETTLED, attempt 1/3)', note: null, inconclusive: 0 });
    assert.equal(byteWitnessLabel('churn-plain', W('fail', 1, INV_UNSETTLED.alloc, INV_UNSETTLED.rep), false, 1).detail,
        'UNVERIFIABLE: retained null B/call vs floor 1 (verdict inconclusive, UNSETTLED, 3 inverted batch(es), attempt 1/3)');
    const odd = byteWitnessLabel('x', W('retry', 1, PASS.alloc, PASS.rep), true, 0);
    assert.equal(odd.ok, false, 'an outcome the mapping does not know fails closed');
    assert.match(odd.detail, /^UNVERIFIABLE: /);
    assert.throws(() => byteWitnessLabel('x', null, true, 0), TypeError);
});

test('byteWitnessLabel inconclusive: a NOTE (no R.ok), counted once; steady names the scavenge window, churn does not', () => {
    assert.deepEqual(byteWitnessLabel('steady-batch', W('inconclusive', 3, INV.alloc, INV.rep), true, 0), {
        ok: null, detail: null, inconclusive: 1,
        note: 'steady-batch -- INCONCLUSIVE: byte witness unmeasured after 3 attempts (every batch bracket inverted); not a FAIL -- gated on exact counters + scavenge/nursery window',
    });
    assert.deepEqual(byteWitnessLabel('churn-plain', W('inconclusive', 3, INV.alloc, INV.rep), false, 1), {
        ok: null, detail: null, inconclusive: 1,
        note: 'churn-plain -- INCONCLUSIVE: byte witness unmeasured after 3 attempts (every batch bracket inverted); not a FAIL -- gated on exact counters',
    });
});

test('churnNote: the retained-bytes claim only on pass (HEAD text); counters-only otherwise', () => {
    assert.equal(churnNote('churn-box', 'pass', 1), 'churn-box -- ok: retained < 1 B/call (sub-object floor), poolGrowths delta 0, activeNodes returned to baseline');
    assert.equal(churnNote('churn-box', 'fail', 1), 'churn-box -- counters ok: poolGrowths delta 0, activeNodes returned to baseline');
    assert.equal(churnNote('churn-box', 'inconclusive', 1), 'churn-box -- counters ok: poolGrowths delta 0, activeNodes returned to baseline (byte witness INCONCLUSIVE)');
    assert.doesNotMatch(churnNote('churn-box', 'bogus', 1), /retained/);
});

test('inconclusiveSuffix: "" at 0 (the PASS line stays byte-identical), the count otherwise; a bad count throws', () => {
    assert.equal(inconclusiveSuffix(0), '');
    assert.equal(inconclusiveSuffix(1), ' (byte witness INCONCLUSIVE on 1 scenario(s))');
    assert.equal(inconclusiveSuffix(7), ' (byte witness INCONCLUSIVE on 7 scenario(s))');
    for (const n of [-1, 1.5, NaN, '1', null, undefined]) assert.throws(() => inconclusiveSuffix(n), RangeError, String(n));
});
