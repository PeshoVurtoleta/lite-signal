/**
 * test/48 -- the WRAP job's pure parts (SPEC-S2-groupA ASSERTIONS A1, A2, A5; SPEC-B addendum item 12).
 *
 * Written as an INDEPENDENT ORACLE from the plan's assertions, before/while the modules land: the expected values
 * come from the spec text (W5: FAIL iff post >= 8 AND post - pre >= 8, null -> INCONCLUSIVE; crossing targets
 * W1 2^31+1000, W2 2^32-2, W3 2^32-1, W4 2^31), never from running the modules. Unit level only: nothing here drives
 * 2^31 operations or runs a soak.
 *
 * ASSUMPTIONS about shapes the plan does not fix (a red here may be a wrong assumption, check the module first):
 *   - every rule returns an object with a string `verdict` in PASS | FAIL | INCONCLUSIVE (the gates.mjs idiom);
 *   - WRAP_GATE follows the GATES fixture shape: `pass` = array of inputs, `mustFail` = array of {input, expect},
 *     and `check` is a function (if it is absent, w5Rule is used as the rule);
 *   - wrapRule(records) takes the `wrap` records ({type:'wrap', check, counter, opsDriven, crossed, pre:{bop},
 *     post:{bop}, values, wallMs, status}, SPEC-B section 7) and returns the run-level verdict;
 *   - wrapStreamProblems(recs) returns an array of problems (empty = clean); the test compares problem COUNTS
 *     between a stream and its damaged twin, so it does not depend on the exact header fields;
 *   - each REWRITES entry exposes .anchor (string), .lhs, .ident, .counter, .required (shape taken from nearwrap.mjs after the
 *     reviewer ruling; the EXPECTED values - counts 6/7, start values - are from the spec/census, not from the code).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { w5Rule, crossRule, wrapRule, WRAP_GATE, wrapStreamProblems, W5_BOP_FAIL } from '../bench/soak/wraprules.mjs';
import * as WR from '../bench/soak/wraprules.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REWRITES, derive } from '../bench/soak/nearwrap.mjs';
import { SoakConfigError } from '../bench/soak/config.mjs';
import { spinVersion } from '../bench/torture/helpers/spin.mjs';
import { createRegistry } from '../Signal.js';

const SIGNAL_JS = fileURLToPath(new URL('../Signal.js', import.meta.url));
const HP_JS = fileURLToPath(new URL('../bench/soak/controls/headpatched/Signal.js', import.meta.url));
const SRC = readFileSync(SIGNAL_JS, 'utf8');
const HP_SRC = readFileSync(HP_JS, 'utf8');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const verdictOf = (r) => { assert.equal(typeof r, 'object'); assert.equal(typeof r.verdict, 'string', JSON.stringify(r)); return r.verdict; };

/* ---- W5 rule (A1) ----------------------------------------------------------------------------------- */

test('W5_BOP_FAIL is 8 B/op (spec: FAIL iff post >= 8; {pre 1, post 8.9} PASS pins it above 7.9)', () => {
    assert.equal(W5_BOP_FAIL, 8);
});

test('w5Rule: the stated unit must-fails and the boundary on both sides', () => {
    assert.equal(verdictOf(w5Rule({ pre: 0, post: 8 })), 'FAIL', 'A1: {pre 0, post 8} FAIL');
    assert.equal(verdictOf(w5Rule({ pre: 1, post: 8.9 })), 'PASS', 'A1: {pre 1, post 8.9} PASS (growth 7.9 < 8)');
    assert.equal(verdictOf(w5Rule({ pre: 0, post: null })), 'INCONCLUSIVE', 'A1: post null INCONCLUSIVE');
    // post just below the bound, pre 0: PASS; exactly at the bound: FAIL (>=).
    assert.equal(verdictOf(w5Rule({ pre: 0, post: W5_BOP_FAIL - 0.01 })), 'PASS');
    assert.equal(verdictOf(w5Rule({ pre: 0, post: W5_BOP_FAIL })), 'FAIL');
    // both conditions are required: high post with a high pre (growth < 8) passes, growth exactly 8 fails.
    assert.equal(verdictOf(w5Rule({ pre: 16, post: 23.99 })), 'PASS', 'post high but growth 7.99');
    assert.equal(verdictOf(w5Rule({ pre: 16, post: 24 })), 'FAIL', 'growth exactly 8 with post >= 8');
    // post below the bound never fails even for a negative-looking growth.
    assert.equal(verdictOf(w5Rule({ pre: 7, post: 0 })), 'PASS');
});

test('w5Rule fails closed on garbage (null is not zero)', () => {
    assert.notEqual(verdictOf(w5Rule({ pre: 0, post: NaN })), 'PASS', 'NaN post');
    assert.notEqual(verdictOf(w5Rule({ pre: null, post: 20 })), 'PASS', 'null pre with a post above the bound');
    assert.notEqual(verdictOf(w5Rule({ pre: 0, post: undefined })), 'PASS', 'undefined post');
});

/* ---- crossing rule (A2) ----------------------------------------------------------------------------- */

const TARGETS = { W1: 2 ** 31 + 1000, W2: 2 ** 32 - 2, W3: 2 ** 32 - 1, W4: 2 ** 31 };

test('crossRule: target-1 is unwitnessed (INCONCLUSIVE), target with crossed is a witnessed crossing', () => {
    for (const [name, target] of Object.entries(TARGETS)) {
        const short = crossRule({ opsDriven: target - 1, target, crossed: true });
        assert.equal(verdictOf(short), 'INCONCLUSIVE', name + ' target-1');
        assert.match(JSON.stringify(short), /unwitnessed/i, name + ': the reason names the unwitnessed crossing');
        const ok = crossRule({ opsDriven: target, target, crossed: true });
        assert.equal(verdictOf(ok), 'PASS', name + ' at target');
        assert.match(JSON.stringify(ok), /crossed/i);
        assert.equal(verdictOf(crossRule({ opsDriven: target + 5, target, crossed: true })), 'PASS', name + ' past target');
        assert.equal(verdictOf(crossRule({ opsDriven: target, target, crossed: false })), 'INCONCLUSIVE', name + ': crossed false is never a pass');
    }
});

/* ---- WRAP_GATE through the rule --------------------------------------------------------------------- */

test('WRAP_GATE: every must-fail yields its stated verdict, every pass control PASSes, must-fails first', () => {
    assert.ok(Array.isArray(WRAP_GATE.mustFail) && WRAP_GATE.mustFail.length >= 1, 'a gate ships with its must-fail');
    assert.ok(Array.isArray(WRAP_GATE.pass) && WRAP_GATE.pass.length >= 1, 'and a green control');
    const rule = typeof WRAP_GATE.check === 'function' ? WRAP_GATE.check : w5Rule;
    for (const m of WRAP_GATE.mustFail) {
        assert.notEqual(m.expect, 'PASS', 'a must-fail never expects PASS');
        assert.equal(verdictOf(rule(m.input)), m.expect, 'must-fail ' + JSON.stringify(m.input));
    }
    for (const input of WRAP_GATE.pass) assert.equal(verdictOf(rule(input)), 'PASS', 'pass ' + JSON.stringify(input));
});

/* ---- wrapRule over records -------------------------------------------------------------------------- */

// The 9 (check, counter) pairs and their crossing targets, from the spec (SPEC-B 5.2 / ASSERTION A2): W1 2^31+1000,
// W2 2^32-2, W3 2^32-1, W4 2^31; W5 re-drives each census counter (globalVersion, batchEpoch, gen, nodeSeq by the
// W1-W4 drives, evalCount 2^31).
const PAIRS = [
    ['W1', 'globalVersion', 2 ** 31 + 1000], ['W2', 'batchEpoch', 2 ** 32 - 2], ['W3', 'gen', 2 ** 32 - 1], ['W4', 'nodeSeq', 2 ** 31],
    ['W5', 'globalVersion', 2 ** 31 + 1000], ['W5', 'batchEpoch', 2 ** 32 - 2], ['W5', 'gen', 2 ** 32 - 1], ['W5', 'nodeSeq', 2 ** 31], ['W5', 'evalCount', 2 ** 31],
];
const rec = (check, counter, ops, crossed, pre, post, status) => ({
    check, counter, opsDriven: ops, crossed, pre: { bop: pre }, post: { bop: post }, values: {}, wallMs: 1, status: status || 'PASS',
});
// DELTA 1: a W5 side carries all 4 step classes + the binding cls; expand a {bop} side so every class = bop.
const expand = (r) => {
    if (r.check !== 'W5') return r;
    const side = (x) => {
        if (x.classes) return x;
        const classes = {};
        for (const c of WR.W5_CLASSES) classes[c] = { bop: x.bop };
        return Object.assign({}, x, { cls: 'set->effect', classes });
    };
    return Object.assign({}, r, { pre: side(r.pre), post: side(r.post) });
};
const full = (patch) => PAIRS.map(([c, n, t]) => {
    const w5 = c === 'W5';
    return expand(Object.assign(rec(c, n, t, true, w5 ? 0 : null, w5 ? 0.4 : null), patch && patch[c + '/' + n] ? patch[c + '/' + n] : null));
});
const without = (key) => full().filter((r) => r.check + '/' + r.counter !== key);

test('wrapRule: all 9 pairs honest -> PASS; the F16 leak FAILs; unwitnessed crossing / unmeasured W5 / a missing pair are INCONCLUSIVE', () => {
    assert.equal(verdictOf(wrapRule(full())), 'PASS');
    assert.equal(verdictOf(wrapRule(full({ 'W5/evalCount': { post: { bop: 16 } } }))), 'FAIL', 'headpatched evalCount 16 B/op (A1)');
    assert.equal(verdictOf(wrapRule(full({ 'W1/globalVersion': { opsDriven: 2 ** 31 + 999 } }))), 'INCONCLUSIVE', 'W1 target-1');
    assert.equal(verdictOf(wrapRule(full({ 'W5/evalCount': { post: { bop: null } } }))), 'INCONCLUSIVE', 'W5 post null');
    assert.equal(verdictOf(wrapRule(full({ 'W2/batchEpoch': { status: 'FAIL' } }))), 'FAIL', 'a recorded value failure');
});

test('wrapRule: a selected pair with no record never PASSes (crossing not witnessed -> INCONCLUSIVE); a `checks` selection narrows the pairs', () => {
    for (const [c, n] of PAIRS) assert.equal(verdictOf(wrapRule(without(c + '/' + n))), 'INCONCLUSIVE', 'missing ' + c + '/' + n);
    assert.equal(verdictOf(wrapRule([])), 'INCONCLUSIVE', 'no records at all');
    assert.equal(verdictOf(wrapRule([full()[0]], ['W1'])), 'PASS', 'only W1 selected and recorded');
    assert.equal(verdictOf(wrapRule([full()[0]], ['W1', 'W2'])), 'INCONCLUSIVE', 'W2 selected but not recorded');
});

/* ---- wrapStreamProblems ----------------------------------------------------------------------------- */

// Selection W1 + W5 -> records for W1/globalVersion and the five W5 counters. Exit codes per the spec: PASS 0, FAIL 1, INCONCLUSIVE 3.
const SEL_PAIRS = PAIRS.filter(([c]) => c === 'W1' || c === 'W5');
function clean() {
    const recs = [{ type: 'header', seq: 0, tMs: 0, kind: 'wrap', config: { SOAK_WRAP: { value: ['W1', 'W5'], source: 'env' } } }];
    SEL_PAIRS.forEach(([c, n, t], i) => recs.push(Object.assign({ type: 'wrap', seq: i + 1, tMs: 10 * (i + 1) }, expand(rec(c, n, t, true, c === 'W5' ? 0 : null, c === 'W5' ? 0.4 : null)))));
    recs.push({ type: 'summary', seq: recs.length, tMs: 1000, reason: 'end', verdict: 'PASS', exitCode: 0 });
    return recs;
}
const has = (probs, re) => probs.some((x) => re.test(x));

test('wrapStreamProblems: a CLEAN stream has 0 problems, then every doctored twin adds its named problem', () => {
    assert.deepEqual(wrapStreamProblems(clean()), [], 'clean first');
    assert.ok(has(wrapStreamProblems(clean().slice(0, -1)), /summary/), 'truncated: no summary');
    const foreign = clean(); foreign[2] = Object.assign({}, foreign[2], { type: 'cycle' });
    assert.ok(has(wrapStreamProblems(foreign), /type|cycle/), 'foreign record type');
    const nw = clean(); nw[0] = Object.assign({}, nw[0], { nearwrap: { phase: 'sign', k: 8 } });
    assert.ok(has(wrapStreamProblems(nw), /nearwrap/i), 'header.nearwrap set');
    const nosel = clean(); nosel[0] = { type: 'header', seq: 0, tMs: 0, kind: 'wrap', config: {} };
    assert.ok(has(wrapStreamProblems(nosel), /SOAK_WRAP/), 'no check selection');
    const swapped = clean(); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    assert.ok(has(wrapStreamProblems(swapped), /seq/), 'out of order');
    const gap = clean(); gap[3].seq = 99;
    assert.ok(has(wrapStreamProblems(gap), /seq/), 'non-contiguous seq');
    assert.ok(wrapStreamProblems([]).length >= 1, 'empty stream');
});

test('wrapStreamProblems: a summary greener than the re-derivation is a problem; FAIL records are never softened', () => {
    // a W5 breach (post 16 B/op, pre 0) recorded honestly as FAIL, summary claiming PASS
    const bad = clean(); const i = bad.findIndex((r) => r.counter === 'evalCount');
    bad[i] = expand(Object.assign({}, bad[i], { post: { bop: 16 }, status: 'FAIL' }));
    assert.ok(has(wrapStreamProblems(bad), /summary.*verdict/), 'summary PASS over a FAIL record');
    // the honest version (summary FAIL, exit 1) is clean
    const honest = clean(); honest[i] = bad[i]; honest[honest.length - 1] = Object.assign({}, honest[honest.length - 1], { verdict: 'FAIL', exitCode: 1 });
    assert.deepEqual(wrapStreamProblems(honest), [], 'honest FAIL stream');
    // a record whose status says PASS while its B/op breaches
    const lie = clean(); lie[i] = expand(Object.assign({}, lie[i], { post: { bop: 16 } }));
    assert.ok(has(wrapStreamProblems(lie), /status/), 'status PASS over a breaching B/op');
    // signal-interrupted AFTER a FAIL record: the run stays FAIL, so a summary downgraded to INCONCLUSIVE is a problem
    const sig = clean(); sig[i] = bad[i];
    sig[sig.length - 1] = Object.assign({}, sig[sig.length - 1], { reason: 'signal', verdict: 'INCONCLUSIVE', exitCode: 3 });
    assert.ok(has(wrapStreamProblems(sig), /verdict/), 'signal after FAIL must stay FAIL');
    // control: a signal stream with no FAIL record is honestly INCONCLUSIVE
    const sigOk = clean().slice(0, 3); sigOk.push({ type: 'summary', seq: 3, tMs: 1000, reason: 'signal', verdict: 'INCONCLUSIVE', exitCode: 3 });
    assert.ok(!has(wrapStreamProblems(sigOk), /summary.*verdict/), 'signal without a FAIL: INCONCLUSIVE is honest');
});

/* ---- NEARWRAP derive (A5) --------------------------------------------------------------------------- */

const KERNELS = [['tree', SRC, 6], ['headpatched', HP_SRC, 7]];
const present = (src) => REWRITES.filter((r) => src.split(r.anchor).length - 1 >= 1);
const identRe = (id) => new RegExp('(^|[^A-Za-z0-9_$])' + id + '(?![A-Za-z0-9_$])');
const countOf = (src, a) => src.split(a).length - 1;
const thrownConfig = (fn) => { try { fn(); } catch (e) { return e instanceof SoakConfigError; } return false; };

test('REWRITES: on each kernel every present anchor matches exactly once; an absent required:false counter is absent entirely', () => {
    for (const [name, src, count] of KERNELS) {
        for (const r of REWRITES) {
            const n = countOf(src, r.anchor);
            if (r.required === false && n === 0) { assert.ok(!identRe(r.ident).test(src), name + ': ' + r.counter + ' identifier must not appear'); continue; }
            assert.equal(n, 1, name + ' anchor ' + r.counter);
        }
        assert.equal(present(src).length, count, name + ' census count (tree 6, headpatched 7)');
    }
});

// Spec start values: sign phase 2^31 - k; zero phase int32 -k, float64 2^32 - k. Arithmetic class per the census:
// globalVersion / batchEpoch / nodeSeq int32; evalCount / statTotal* float64; gen int32 on the tree, float64 on headpatched (FIX-G).
const ARITH = (name, counter) => (['evalCount', 'statTotalAllocations', 'statTotalDisposals'].includes(counter) || (counter === 'gen' && name === 'headpatched') ? 'float64' : 'int32');
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('derive(): per-counter start values (sign 2^31-k; zero int32 -k / float64 2^32-k), counts 6 / 7, shas, determinism', () => {
    const k = 8;
    for (const [name, src, count] of KERNELS) {
        for (const phase of ['sign', 'zero']) {
            const d = derive(src, { phase, k });
            assert.notEqual(d.text, src);
            assert.equal(d.rewrites.length, count, name + '/' + phase + ' rewrite count');
            assert.match(d.baseSha256, /^[0-9a-f]{64}$/); assert.match(d.derivedSha256, /^[0-9a-f]{64}$/);
            assert.equal(d.baseSha256, sha256(src)); assert.equal(d.derivedSha256, sha256(d.text));
            assert.equal(derive(src, { phase, k }).derivedSha256, d.derivedSha256, 'pure function');
            for (const r of present(src)) {
                const arith = ARITH(name, r.counter);
                const want = phase === 'sign' ? 2 ** 31 - k : (arith === 'int32' ? -k : 2 ** 32 - k);
                const m = new RegExp(escRe(r.lhs) + ' = (-?\\d+);').exec(d.text);
                assert.ok(m, name + '/' + phase + ' ' + r.counter + ' initializer rewritten');
                assert.equal(Number(m[1]), want, name + '/' + phase + ' ' + r.counter + ' start');
            }
        }
    }
    assert.notEqual(derive(SRC, { phase: 'sign', k: 8 }).derivedSha256, derive(SRC, { phase: 'sign', k: 9 }).derivedSha256, 'k is part of the derivation');
    assert.notEqual(derive(SRC, { phase: 'sign', k: 8 }).derivedSha256, derive(SRC, { phase: 'zero', k: 8 }).derivedSha256, 'phase is part of the derivation');
});

test('derive(): an anchor removed or duplicated throws SoakConfigError on BOTH kernels (control: intact src does not)', () => {
    for (const [name, src] of KERNELS) {
        assert.doesNotThrow(() => derive(src, { phase: 'sign', k: 8 }), name + ' intact');
        for (const r of present(src)) {
            assert.ok(thrownConfig(() => derive(src.replace(r.anchor, ''), { phase: 'sign', k: 8 })), name + ' removed ' + r.counter);
            assert.ok(thrownConfig(() => derive(src + '\n' + r.anchor + '\n', { phase: 'sign', k: 8 })), name + ' duplicated ' + r.counter);
        }
    }
});

test('derive(): option validation throws SoakConfigError (k 0, -1, 1.5, 2^30, unknown key, bad phase, non-object)', () => {
    const bad = [{ phase: 'sign', k: 0 }, { phase: 'sign', k: -1 }, { phase: 'sign', k: 1.5 }, { phase: 'sign', k: 2 ** 30 }, { phase: 'sign', k: NaN },
        { phase: 'sign', k: 8, extra: 1 }, { phase: 'x', k: 8 }, { k: 8 }, null, [], 'sign'];
    for (const o of bad) assert.ok(thrownConfig(() => derive(SRC, o)), 'opts ' + JSON.stringify(o));
    assert.doesNotThrow(() => derive(SRC, { phase: 'zero', k: 1 }));
    assert.ok(thrownConfig(() => derive('', { phase: 'sign', k: 8 })), 'empty source');
});

test('derive(): an injected uncensused `foo = (foo + 1) | 0` int32 bump trips the stale-census check', () => {
    for (const [name, src] of KERNELS) {
        assert.ok(thrownConfig(() => derive(src + '\nlet foo = 0;\nfoo = (foo + 1) | 0;\n', { phase: 'sign', k: 8 })), name);
    }
});

test('derive(): an injected uncensused 0-skip bump (`((x + 1) | 0) || 1`: plain, chained, member) trips the stale-census check', () => {
    // F29 spelling; the 0-skip branch of nearwrap uncensused() must see each form (a branch-deleted mutant is red)
    const forms = [
        '\nlet foo = 0;\nfoo = ((foo + 1) | 0) || 1;\n',
        '\nlet foo = 0;\nconst o = { v: 0 };\no.v = foo = ((foo + 1) | 0) || 1;\n',
        '\nconst o = { cnt: 0 };\no.cnt = ((o.cnt + 1) | 0) || 1;\n',
    ];
    for (const [name, src] of KERNELS) {
        for (const f of forms) {
            let msg = null;
            try { derive(src + f, { phase: 'sign', k: 8 }); } catch (e) { msg = e; }
            assert.ok(msg !== null && thrownConfig(() => { throw msg; }), name + ' throws SoakConfigError for ' + JSON.stringify(f));
            assert.match(String(msg.message), /stale census/, name + ' ' + JSON.stringify(f));
        }
    }
});

/* ---- spinVersion ------------------------------------------------------------------------------------ */

// The version counter is not exposed by the API, so the oracle is observable writes: a signal that starts at -1 and is
// spun with set(0..n-1) changes on EVERY write, so an effect on it runs once initially plus once per write.
// n is small: chunking at 1<<28 is not reachable at unit level.
test('spinVersion(sig, n) performs exactly n real writes (effect on the spun signal runs 1 + n times)', () => {
    for (const n of [0, 1, 2, 1000, 70001]) {
        const r = createRegistry();
        const sig = r.signal(-1);
        let runs = 0;
        r.effect(() => { sig(); runs++; });
        assert.equal(runs, 1);
        spinVersion(sig, n);
        assert.equal(runs, 1 + n, 'n=' + n);
        if (n > 0) assert.equal(sig(), n - 1, 'last write wins');
        r.destroy();
    }
});

/* ---- DELTA 1 (burst 22, A-B2T): the W5 verdict is the WORST of the 4 step classes (D1) ---------------------- */

// Class names from the spec text (SPEC-S2-groupA DELTA 1 task 11a): the 4 W5 step classes.
const mkClasses = (over) => {
    const o = {};
    for (const c of WR.W5_CLASSES) o[c] = { bop: over && over[c] !== undefined ? over[c] : 0 };
    return o;
};
// A W5/evalCount record. preO / postO: class -> bop overrides (null = unmeasured). cls = the binding class.
function w5rec(cls, preO, postO, status, drop) {
    const pc = mkClasses(preO), qc = mkClasses(postO);
    if (drop) { delete pc[drop]; delete qc[drop]; }
    return {
        check: 'W5', counter: 'evalCount', opsDriven: 2 ** 31, crossed: true,
        pre: { bop: pc[cls] ? pc[cls].bop : 0, cls, classes: pc }, post: { bop: qc[cls] ? qc[cls].bop : 0, cls, classes: qc },
        values: {}, wallMs: 1, status,
    };
}
// A W5-only run: the other four W5 counters honest (all classes 0 -> 0), evalCount = `target`.
function w5Run(target) {
    return ['globalVersion', 'batchEpoch', 'gen', 'nodeSeq', 'evalCount'].map((n) => n === 'evalCount' ? target
        : Object.assign(w5rec('set->effect', null, null, 'PASS'), { counter: n, opsDriven: WR.WRAP_TARGETS.W5[n] }));
}
function w5Stream(target, verdict) {
    const recs = [{ type: 'header', seq: 0, tMs: 0, kind: 'wrap', config: { SOAK_WRAP: { value: ['W5'], source: 'env' } } }];
    w5Run(target).forEach((r, i) => recs.push(Object.assign({ type: 'wrap', seq: i + 1, tMs: 10 * (i + 1) }, r)));
    recs.push({ type: 'summary', seq: recs.length, tMs: 1000, reason: 'end', verdict, exitCode: verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3 });
    return recs;
}
// D1: binding class set->effect 0 -> 0 while create+dispose 264.57 -> 296.48 (delta 31.91 >= 8, post >= 8 -> FAIL by w5Rule).
const D1_PRE = { 'create+dispose': 264.57 }, D1_POST = { 'create+dispose': 296.48 };

test('D1: W5_CLASSES is exported with the 4 step classes in order', () => {
    assert.deepEqual([...WR.W5_CLASSES], ['set->effect', 'set->computed->effect', 'batch(set)', 'create+dispose']);
});

test('D1: a W5 record whose worst class (create+dispose 264.57 -> 296.48) breaches is judged FAIL although the binding class is clean', () => {
    const bad = w5Run(w5rec('set->effect', D1_PRE, D1_POST, 'PASS'));
    assert.equal(verdictOf(wrapRule(bad, ['W5'])), 'FAIL', 'worst class drives the verdict');
});

test('D1: wrapStreamProblems flags the non-worst binding class: exactly 1 problem, naming the record', () => {
    const probs = wrapStreamProblems(w5Stream(w5rec('set->effect', D1_PRE, D1_POST, 'PASS'), 'FAIL'));
    assert.equal(probs.length, 1, JSON.stringify(probs));
    assert.match(probs[0], /wrap seq 5/, 'names the record (evalCount is the 5th wrap record, seq 5)');
    assert.match(probs[0], /binding class set->effect \(PASS\) is not the worst class create\+dispose \(FAIL\)/);
});

test('D1: the same record under a PASS summary gives exactly 2 problems (class binding + summary verdict)', () => {
    const probs = wrapStreamProblems(w5Stream(w5rec('set->effect', D1_PRE, D1_POST, 'PASS'), 'PASS'));
    assert.equal(probs.length, 2, JSON.stringify(probs));
    assert.ok(probs.some((x) => /wrap seq 5/.test(x) && /binding class set->effect \(PASS\) is not the worst class create\+dispose \(FAIL\)/.test(x)), 'class-binding line names the record');
    assert.ok(probs.some((x) => /summary: verdict PASS != re-derived FAIL/.test(x)), 'summary line');
});

test('D1 control: the same record with cls = create+dispose and status FAIL has no class-binding problem', () => {
    const probs = wrapStreamProblems(w5Stream(w5rec('create+dispose', D1_PRE, D1_POST, 'FAIL'), 'FAIL'));
    assert.deepEqual(probs, []);
});

test('D1: worst-class order FAIL > INCONCLUSIVE > PASS (null bop is INCONCLUSIVE, never PASS)', () => {
    const inc = w5Run(w5rec('set->effect', null, { 'batch(set)': null }, 'PASS'));
    assert.equal(verdictOf(wrapRule(inc, ['W5'])), 'INCONCLUSIVE', 'one class unmeasured, others PASS');
    const both = w5Run(w5rec('set->effect', { 'create+dispose': 0 }, { 'batch(set)': null, 'create+dispose': 20 }, 'PASS'));
    assert.equal(verdictOf(wrapRule(both, ['W5'])), 'FAIL', 'FAIL + INCONCLUSIVE -> FAIL');
    const ok = w5Run(w5rec('set->effect', null, null, 'PASS'));
    assert.equal(verdictOf(wrapRule(ok, ['W5'])), 'PASS', 'control: all four classes 0 -> 0');
});

for (const missing of WR.W5_CLASSES) {
    test('D1: a W5 record missing class ' + missing + ' is never PASS', () => {
        const r = w5rec('set->effect', null, null, 'PASS', missing);
        let v;
        try { v = verdictOf(wrapRule(w5Run(r), ['W5'])); } catch (e) { v = e instanceof TypeError ? 'THROWS' : 'OTHER'; }
        assert.ok(v === 'THROWS' || v === 'FAIL' || v === 'INCONCLUSIVE', 'got ' + v);
        const probs = wrapStreamProblems(w5Stream(r, 'PASS'));
        assert.ok(probs.length >= 1, 'stream problem for a record missing a class');
    });
}

// Parity-style must-fail: the pre-change wraprules (git 3235728) accepts the D1 record (PASS, no problems), so the tests above fail on old code.
let FROZEN_SRC = null;
try { FROZEN_SRC = execFileSync('git', ['show', '3235728:bench/soak/wraprules.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { FROZEN_SRC = null; }
test('D1 must-fail on old code: the pre-change wraprules (git 3235728) judges the D1 record PASS with [] problems',
    { skip: FROZEN_SRC !== null ? false : 'git or commit 3235728 unavailable (shallow or non-git checkout)' }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'b22-frozen-'));
        try {
            const here = (f) => pathToFileURL(fileURLToPath(new URL('../bench/soak/' + f, import.meta.url))).href;
            const src = FROZEN_SRC.replace("'./config.mjs'", "'" + here('config.mjs') + "'").replace("'./jsonl.mjs'", "'" + here('jsonl.mjs') + "'");
            const f = join(dir, 'wraprules-before.mjs');
            writeFileSync(f, src);
            const OLD = await import(pathToFileURL(f).href);
            const old = w5Stream(w5rec('set->effect', D1_PRE, D1_POST, 'PASS'), 'PASS');
            assert.equal(verdictOf(OLD.wrapRule(w5Run(w5rec('set->effect', D1_PRE, D1_POST, 'PASS')), ['W5'])), 'PASS');
            assert.deepEqual(OLD.wrapStreamProblems(old), []);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

/* ---- R1 additions: the binding check, tie-break, doctored twins, breach cls/pre/post (contract C1, C2) ---- */

test('D1(b): status FAIL, binding set->effect 0->0, worst create+dispose 264.57->296.48: exactly 1 problem, the binding line', () => {
    const probs = wrapStreamProblems(w5Stream(w5rec('set->effect', D1_PRE, D1_POST, 'FAIL'), 'FAIL'));
    assert.equal(probs.length, 1, JSON.stringify(probs));
    assert.match(probs[0], /binding class set->effect \(PASS\) is not the worst class create\+dispose \(FAIL\)/);
});

test('D1(c): milder FAIL bound (set->effect 0->10) while create+dispose 264.57->296.48 is worse: exactly 1 binding problem', () => {
    const probs = wrapStreamProblems(w5Stream(w5rec('set->effect', Object.assign({}, D1_PRE), Object.assign({ 'set->effect': 10 }, D1_POST), 'FAIL'), 'FAIL'));
    assert.equal(probs.length, 1, JSON.stringify(probs));
    assert.match(probs[0], /binding class set->effect \(FAIL\) is not the worst class create\+dispose \(FAIL\)/);
});

test('D1(d): tie between two FAIL classes (equal post - pre): binding the LATER one in W5_CLASSES order is flagged, the earlier is not', () => {
    const post = { 'set->computed->effect': 20, 'batch(set)': 20 };   // both 0 -> 20: equal delta 20, first in order wins
    const later = wrapStreamProblems(w5Stream(w5rec('batch(set)', null, post, 'FAIL'), 'FAIL'));
    assert.equal(later.length, 1, JSON.stringify(later));
    assert.match(later[0], /binding class batch\(set\) \(FAIL\) is not the worst class set->computed->effect \(FAIL\)/);
    assert.deepEqual(wrapStreamProblems(w5Stream(w5rec('set->computed->effect', null, post, 'FAIL'), 'FAIL')), [], 'earlier binding: clean');
});

test('D1(e): doctored twins of a clean FAIL record each add exactly one named problem', () => {
    const base = () => w5Stream(w5rec('create+dispose', D1_PRE, D1_POST, 'FAIL'), 'FAIL');
    assert.deepEqual(wrapStreamProblems(base()), [], 'control');
    const doctor = (fn) => { const st = base(); const r = st[5]; r.pre = JSON.parse(JSON.stringify(r.pre)); r.post = JSON.parse(JSON.stringify(r.post)); fn(r); return wrapStreamProblems(st); };
    const a = doctor((r) => { r.pre.bop = 1; });
    assert.equal(a.length, 1, JSON.stringify(a)); assert.match(a[0], /pre\.bop .* != pre\.classes\[/);
    const b = doctor((r) => { r.post.bop = 1; });
    assert.equal(b.length, 1, JSON.stringify(b)); assert.match(b[0], /post\.bop .* != post\.classes\[/);
    // pre.cls != post.cls: all-zero PASS record so no bop mismatch or verdict change rides along
    const st = w5Stream(w5rec('set->effect', null, null, 'PASS'), 'PASS');
    st[5].post = Object.assign({}, st[5].post, { cls: 'batch(set)' });
    const c = wrapStreamProblems(st);
    assert.equal(c.length, 1, JSON.stringify(c)); assert.match(c[0], /pre\.cls|post\.cls/);
    const d = doctor((r) => { r.pre.classes.x = { bop: 0 }; });
    assert.equal(d.length, 1, JSON.stringify(d)); assert.match(d[0], /"x"|unknown class/i);
});

test('D1(f): a wrapRule W5 breach carries the worst class cls/pre/post (create+dispose, 264.57, 296.48)', () => {
    const r = wrapRule(w5Run(w5rec('set->effect', D1_PRE, D1_POST, 'PASS')), ['W5']);
    assert.equal(r.verdict, 'FAIL');
    const b = r.breaches.find((x) => x.counter === 'evalCount');
    assert.ok(b, 'evalCount breach present');
    assert.equal(b.cls, 'create+dispose');
    assert.equal(b.pre, 264.57);
    assert.equal(b.post, 296.48);
});

test('D1: breachLine names the WORST class (bop=296.48 detail=class=create+dispose), not the binding one', async () => {
    const mod = await import('../bench/soak/wrap.mjs');
    const rec = w5rec('set->effect', D1_PRE, D1_POST, 'PASS');
    const run = w5Run(rec);
    const b = wrapRule(run, ['W5']).breaches.find((x) => x.counter === 'evalCount');
    assert.ok(b, 'evalCount breach present');
    const line = mod.breachLine(b, rec);
    assert.match(line, /bop=296\.48 detail=class=create\+dispose /);
    assert.doesNotMatch(line, /class=set->effect/);
});
