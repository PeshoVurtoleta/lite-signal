// 44-soak-divergences.test.mjs -- the soak divergence registry (SPEC-B v2 section 4.4; S1cd task 5, amendments 5, 8).
//
// No kernel is loaded: every record below is a REAL failing-world record captured on the frozen kernels
// (seed 0xC0FFEE; bench/soak/calibration/f21-census.json), fed to classify as data. Each matcher has
// must-fail controls that change ONE thing (lane, world scen, sig, detail, token origin, missing evidence)
// and must classify null, so a broad matcher cannot hide a real regression.
//   1. the shipped registry validates; digest is the file's sha256
//   2. classify: each captured class -> its entry; near-misses -> null
//   3. DIV-F22 attribution: F6 pre-walk token -> F6+F22, effect-body escape -> F22
//   4. fixedIn: a fixed entry explains only with includeFixed (named control kernels)
//   5. validate: orphan entry, orphan allowance, broad matcher and schema must-fails
//   6. evidence files: conformance cases exist, the census parses and its F21 worlds carry a prior surface
//   7. round 2: whole-string detail regexes, prototype-free opts/records, the ONCE_PER_STEP generator pin

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, classify, digest, REGISTRY_PROBLEMS, DEFAULT_VOCAB, REGISTRY_URL } from '../bench/soak/divergences.mjs';
import { GEN_RULES } from '../bench/soak/gen.mjs';
import { ORACLES, SIGS } from '../bench/soak/oracles.mjs';
import { SCENARIOS } from '../bench/soak/scenarios.mjs';
import { ROSTER, LANES, isLargeWorld } from '../bench/soak/lanes/index.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import { seedFor, worldSeed } from '../bench/soak/seeds.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEXT = readFileSync(REGISTRY_URL, 'utf8');
const fresh = () => JSON.parse(TEXT);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- captured records (kernel, world seed @ step) ----------------------------------------------------
const REC = {
    // rev152 ERROR 0x7b17ec55@40 (also headpatched): F21
    F21: {
        engine: 'lite', lane: 'ERROR', step: 40, op: 'seq',
        fails: [{ oracle: 'O6', sig: 'escape-CycleError', detail: 'engine error escaped: Error: CycleError: Infinite effect loop detected.' }],
        scen: ['cycle-error-surfaces'],
        worldScen: ['cycle-error-surfaces', 'dep-set-flip', 'diamond-write', 'second-invalidation', 'throwing-equals'],
        worldScenCounts: { 'cycle-error-surfaces': 2, 'dep-set-flip': 3, 'diamond-write': 1, 'second-invalidation': 2, 'throwing-equals': 1 },
    },
    // headpatched ERROR 0xc15f1e33@187: F22, effect-body escape (replay escape [computed:10], predicted)
    F22: {
        engine: 'lite', lane: 'ERROR', step: 187, op: 'batch',
        fails: [{ oracle: 'O6', sig: 'expected-escape-missing', detail: 'predicted escape batch:187 x1 did not happen' }],
        scen: ['throw-in-batch'],
        worldScen: ['aggregate', 'cycle-error-surfaces', 'dep-set-flip', 'diamond-write', 'equality-cutoff', 'multi-write-same-signal', 'recovery-after-throw',
            'second-invalidation', 'throw-dep-computed-prewalk', 'throw-dep-effect-prewalk', 'throw-in-batch', 'throwing-equals'],
        escape: [{ origin: 'computed', token: 'computed:10' }],
    },
    // rev152 ERROR 0x42832b67@36: the 17th "F6+F22" world of the S1b table; identical on headpatched -> F22
    F22rev: {
        engine: 'lite', lane: 'ERROR', step: 36, op: 'batch',
        fails: [{ oracle: 'O6', sig: 'expected-escape-missing', detail: 'predicted escape batch:36 x1 did not happen' }],
        scen: ['throw-in-batch', 'dep-set-flip'],
        worldScen: ['cycle-error-surfaces', 'dep-set-flip', 'throw-in-batch', 'throwing-equals'],
        escape: [{ origin: 'computed', token: 'computed:20' }],
    },
    // rev152 ERROR 0xcea2a53d@31: F6 pre-walk token replaced the batch token. escape is DERIVED from the
    // escape-computed detail (not traced in the capture; DEFERRED replay confirms it)
    F6F22: {
        engine: 'lite', lane: 'ERROR', step: 31, op: 'batch',
        fails: [
            { oracle: 'O6', sig: 'escape-computed', detail: 'unpredicted escape computed:18' },
            { oracle: 'O6', sig: 'expected-escape-missing', detail: 'predicted escape batch:31 x1 did not happen' },
            { oracle: 'O4', sig: 'effect-dead', detail: 'effect#22 saw [#0=95,#21=95] model [#0=95,#21=ERR(computed:18)] (ran 0 times this op)' },
        ],
        scen: ['dep-set-flip', 'throw-dep-computed-prewalk', 'throw-in-batch'],
        worldScen: ['dep-set-flip', 'recovery-after-throw', 'throw-dep-computed-prewalk', 'throw-in-batch'],
        escape: [{ origin: 'computed', token: 'computed:18' }],
    },
    // rev152 ERROR 0x53c41559@76: F6
    F6: {
        engine: 'lite', lane: 'ERROR', step: 76, op: 'batch',
        fails: [
            { oracle: 'O6', sig: 'escape-computed', detail: 'unpredicted escape computed:13' },
            { oracle: 'O4', sig: 'effect-dead', detail: 'effect#26 saw [#21=8346155] model [#21=ERR(computed:13)] (ran 0 times this op)' },
        ],
        scen: ['throw-dep-effect-prewalk'],
        worldScen: ['adversarial-equality', 'cycle-error-surfaces', 'dep-set-flip', 'diamond-write', 'equality-cutoff', 'multi-write-same-signal',
            'recovery-after-throw', 'second-invalidation', 'throw-dep-effect-prewalk', 'throw-in-batch', 'throwing-equals'],
    },
    // rev152 ERROR 0x5a22a78c@32 and 0x92c29d17@40: fixed by headpatched; root cause proven in b53 (N19.2) -> DIV-F6 since N19.3
    O4solo: {
        engine: 'lite', lane: 'ERROR', step: 32, op: 'set',
        fails: [{ oracle: 'O4', sig: 'effect-dead', detail: 'effect#23 saw [#15=-0,#21=ERR(computed:18)] model [#15=-0,#21=undefined] (ran 0 times this op)' }],
        scen: ['recovery-after-throw', 'equality-cutoff'],
        worldScen: ['dep-set-flip', 'diamond-write', 'equality-cutoff', 'recovery-after-throw', 'throw-dep-computed-prewalk'],
    },
    CEMsolo: {
        engine: 'lite', lane: 'ERROR', step: 40, op: 'set',
        fails: [{ oracle: 'O1c', sig: 'computed-err-mismatch', detail: 'node#31 (hash) engine=ERR(computed:14) model=15449124' }],
        scen: ['recovery-after-throw'],
        worldScen: ['dep-set-flip', 'equality-cutoff', 'recovery-after-throw', 'second-invalidation', 'throw-dep-computed-prewalk', 'throw-in-batch'],
    },
    // rev152 BATCH 0x26b3e9d7@31 and 0xcec47fd0@38 (a later step's O1c), ERROR 0x8992029a@57: F5
    F5: {
        engine: 'lite', lane: 'BATCH', step: 31, op: 'batch',
        fails: [
            { oracle: 'O2', sig: 'glitch', detail: 'body#20 read #9 engine=undefined model=Infinity' },
            { oracle: 'O1e', sig: 'effect-stale', detail: 'effect#20 saw [#2=null,#9=undefined] model [#2=null,#9=Infinity]' },
            { oracle: 'O1c', sig: 'computed-mismatch', detail: 'node#9 (cond) engine=undefined model=Infinity' },
        ],
        scen: ['multi-write-same-signal', 'revert-no-read', 'adversarial-equality', 'dep-set-flip', 'revert-after-mid-read', 'nested-close', 'equality-cutoff', 'second-invalidation'],
        worldScen: ['adversarial-equality', 'dep-set-flip', 'diamond-write', 'equality-cutoff', 'multi-write-same-signal', 'nested-close', 'revert-after-mid-read',
            'revert-no-read', 'second-invalidation', 'throw-in-batch'],
    },
    F5later: {
        engine: 'lite', lane: 'BATCH', step: 38, op: 'set',
        fails: [{ oracle: 'O1c', sig: 'computed-mismatch', detail: 'node#16 (identity) engine=12 model=NaN' }],
        scen: ['second-invalidation', 'dep-set-flip'],
        worldScen: ['dep-set-flip', 'equality-cutoff', 'multi-write-same-signal', 'nested-close', 'revert-after-mid-read', 'revert-no-read', 'second-invalidation', 'throw-in-batch'],
    },
    F5err: {
        engine: 'lite', lane: 'ERROR', step: 57, op: 'batch',
        fails: [
            { oracle: 'O1c', sig: 'computed-err-mismatch', detail: 'node#31 (hash) engine=ERR(computed:31) model=420684' },
            { oracle: 'O1c', sig: 'computed-mismatch', detail: 'node#15 (select) engine=93 model=14' },
        ],
        scen: ['dep-set-flip', 'multi-write-same-signal', 'revert-after-mid-read', 'second-invalidation', 'throw-dep-computed-prewalk'],
        worldScen: ['dep-set-flip', 'diamond-write', 'equality-cutoff', 'multi-write-same-signal', 'recovery-after-throw', 'revert-after-mid-read',
            'second-invalidation', 'throw-dep-computed-prewalk'],
    },
    // rev152 NEST 0xaed1587a@30: F15 class; a1cand NEST 0xaed1587a@43: F7
    F15: {
        engine: 'lite', lane: 'NEST', step: 30, op: 'seq',
        fails: [
            { oracle: 'O6', sig: 'escape-TypeError', detail: "body#30 read #28: TypeError: Cannot set properties of null (setting 'headSub')" },
            { oracle: 'O5', sig: 'link-count', detail: 'activeLinks engine=24 expected=23 (slack 0)' },
        ],
        scen: ['child-first-run-dispose', 'saved-cursor-hazard', 'dep-set-flip'],
        worldScen: ['child-first-run-dispose', 'dep-set-flip', 'dispose-outer-observer', 'nested-computed-dispose', 'saved-cursor-hazard', 'untrack-dispose'],
    },
    F7: {
        engine: 'lite', lane: 'NEST', step: 43, op: 'seq',
        fails: [{ oracle: 'O7a', sig: 'dead-registration-fire', detail: 'onConnect fired for registration r3 on #51: target #51 disposed' }],
        scen: ['lifecycle-dispose-recycle'],
        worldScen: ['child-first-run-dispose', 'dep-set-flip', 'diamond-write', 'dispose-outer-observer', 'lifecycle-dispose-recycle', 'nested-computed-dispose',
            'saved-cursor-hazard', 'untrack-dispose'],
    },
};
const rec = (k, patch) => Object.assign(clone(REC[k]), patch || {});
const without = (a, x) => a.filter((s) => s !== x);
const known = (r, o) => { const c = classify(r, o); return c === null ? null : c.known; };
// DIV-F21 is FIXED (fixedIn 'A2-F21'): its matcher rows run as a named control kernel does (main / SoakReport pass
// includeFixed = controls.name !== null), so a near-miss null is the matcher's, never the fixedIn skip's
const FX = () => ({ includeFixed: true });
// DIV-F6 is FIXED too (fixedIn 'A2-FIX-T', b103): its matcher rows use these, for the same reason
const classifyFx = (r, o) => classify(r, Object.assign(FX(), o));
const knownFx = (r, o) => known(r, Object.assign(FX(), o));

// ---- 1. the shipped registry ---------------------------------------------------------------------------
test('the shipped registry validates against the imported vocabulary', () => {
    assert.deepEqual(REGISTRY_PROBLEMS, []);
    assert.deepEqual(validate(), []);
    assert.deepEqual(validate(fresh()), []);
    // imported, never copied (SPEC-B addendum 9a)
    assert.equal(DEFAULT_VOCAB.genRules, GEN_RULES);
    assert.equal(DEFAULT_VOCAB.oracles, ORACLES);
    assert.equal(DEFAULT_VOCAB.sigs, SIGS);
    assert.equal(DEFAULT_VOCAB.scenarios, SCENARIOS);
    assert.equal(DEFAULT_VOCAB.lanes, ROSTER);
});

test('digest is the sha256 of divergences.json and moves with one byte', () => {
    assert.equal(digest(), createHash('sha256').update(TEXT).digest('hex'));
    assert.match(digest(), /^[0-9a-f]{64}$/);
    assert.notEqual(digest(TEXT + ' '), digest());
    assert.throws(() => digest(42), TypeError);
});

test('DIV-F21 is fixed in A2-F21 (ruling D2); DIV-F22 stays a temporary engine entry (amendments 5, 8)', () => {
    const by = new Map(fresh().entries.map((e) => [e.id, e]));
    for (const [id, fixedIn] of [['DIV-F21', 'A2-F21'], ['DIV-F22', null]]) {
        const e = by.get(id);
        assert.equal(e.kind, 'engine');
        assert.deepEqual(e.lanes, ['ERROR']);
        assert.equal(e.fixedIn, fixedIn, id);
        assert.equal(e.fixBy, 'A2');
    }
    assert.deepEqual(by.get('DIV-F21').worldScen, ['cycle-error-surfaces']);
    assert.deepEqual(by.get('DIV-F22').oracles, ['O6']);
    assert.deepEqual(by.get('DIV-F22').sigs, ['expected-escape-missing']);
    assert.deepEqual(by.get('DIV-F22').worldScen, ['throw-in-batch']);
    for (const f of ['F1', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16']) {
        assert.ok(by.has(f === 'F1' ? 'DIV-F1-band' : 'DIV-' + f), 'missing entry for ' + f);
    }
    for (const id of ['DIV-D2-destroy-throws', 'DIV-D3-independent-registrations', 'DIV-D4-id-window', 'DIV-I3-op2']) assert.ok(by.has(id), id);
});

// ---- 2. classify ----------------------------------------------------------------------------------------
test('B2 assertion: an F21-shaped ERROR failure -> DIV-F21; without worldScen -> null; on BATCH -> null', () => {
    const c = classify(rec('F21'), FX());
    assert.equal(c.known, 'DIV-F21');
    assert.equal(c.tag, 'F21');
    const noWorld = rec('F21');
    noWorld.worldScen = without(noWorld.worldScen, 'cycle-error-surfaces');
    assert.equal(classify(noWorld, FX()), null);
    assert.equal(classify(rec('F21', { lane: 'BATCH' }), FX()), null);
});

test('DIV-F21 near-misses classify null', () => {
    // no EARLIER surface: the only cycle-error-surfaces count is the failing step's own
    assert.equal(classify(rec('F21', { worldScenCounts: { 'cycle-error-surfaces': 1 } }), FX()), null);
    // no counts at all: priorScen cannot be proven
    const nc = rec('F21'); delete nc.worldScenCounts;
    assert.equal(classify(nc, FX()), null);
    // the step itself did not surface the bomb's CycleError
    assert.equal(classify(rec('F21', { scen: [] }), FX()), null);
    // a different CycleError message, a different sig, a different op, a different engine
    const msg = rec('F21'); msg.fails[0].detail = 'engine error escaped: Error: CycleError: flush passes exceeded';
    assert.equal(classify(msg, FX()), null);
    const sig = rec('F21'); sig.fails[0].sig = 'escape-TypeError';
    assert.equal(classify(sig, FX()), null);
    assert.equal(classify(rec('F21', { op: 'eff' }), FX()), null);
    assert.equal(classify(rec('F21', { engine: 'alien' }), FX()), null);
    // a second, unexplained fail in the same step makes the world unknown
    const extra = rec('F21'); extra.fails.push({ oracle: 'O5', sig: 'node-count', detail: 'activeNodes engine=9 model=8' });
    assert.equal(classify(extra, FX()), null);
    assert.equal(known(rec('F21'), FX()), 'DIV-F21', 'positive control: the unchanged record matches');
});

test('DIV-F6: escape-computed (+ its O4) -> DIV-F6; near-misses -> null', () => {
    assert.equal(knownFx(rec('F6')), 'DIV-F6');
    assert.equal(classifyFx(rec('F6')).tag, 'F6');
    // a different lane, a different token origin in the escape
    assert.equal(classifyFx(rec('F6', { lane: 'NEST' })), null);
    const eq = rec('F6'); eq.fails[0] = { oracle: 'O6', sig: 'escape-equals', detail: 'unpredicted escape equals:8' };
    assert.equal(classifyFx(eq), null);
    const tok = rec('F6'); tok.fails[0].detail = 'unpredicted escape batch:76';
    assert.equal(classifyFx(tok), null);
    // O4 effect-dead is matched only next to the F6 escape
    // (b53 N19.3: O4solo, the standalone O4 with ERR(computed) on the engine side, is now DIV-F6; see the b53 rows below)
});

// b109 A3: DIV-F5 is FIXED (fixedIn A3-FIX-R); these matcher rows run as a named control kernel does (FX), so a near-miss
// null is the matcher's, never the fixedIn skip's. Q1 fell back (A1: the census found an engine=ERR( line that is a real
// F5 world), so the O1c shape is unchanged: the captured engine-side F5err still matches; F5errM (model-side ERR) is an extra case.
const F5errM = () => { const r = rec('F5err'); r.fails[0].detail = 'node#31 (hash) engine=420684 model=ERR(computed:31)'; return r; };
test('DIV-F5: revert-after-mid-read worlds on BATCH and ERROR; near-misses -> null', () => {
    assert.equal(knownFx(rec('F5')), 'DIV-F5');
    assert.equal(knownFx(rec('F5later')), 'DIV-F5');
    assert.equal(knownFx(rec('F5err')), 'DIV-F5');
    assert.equal(knownFx(F5errM()), 'DIV-F5');
    const noRevert = rec('F5later'); noRevert.worldScen = without(noRevert.worldScen, 'revert-after-mid-read');
    assert.equal(classifyFx(noRevert), null);
    assert.equal(classifyFx(rec('F5', { lane: 'GRAPH' })), null);
    // b103 R13.2: computed-err-mismatch no longer needs the revert in the failing step (the step-scen narrowing went;
    // the entry's own rule: the world scen is required, the step scen is not) -- the WORLD revert still binds
    const cem = rec('F5err'); cem.scen = without(cem.scen, 'revert-after-mid-read');
    assert.equal(knownFx(cem), 'DIV-F5');
    cem.worldScen = without(cem.worldScen, 'revert-after-mid-read');
    if (cem.worldScenCounts !== undefined) delete cem.worldScenCounts['revert-after-mid-read'];
    assert.equal(classifyFx(cem), null);
});

test('DIV-F15: the TypeError headSub class with saved-cursor-hazard; near-misses -> null', () => {
    assert.equal(known(rec('F15')), 'DIV-F15');
    const noHaz = rec('F15'); noHaz.scen = without(noHaz.scen, 'saved-cursor-hazard');
    assert.equal(classify(noHaz), null);
    // a silent link loss (P6) without the crash is a different shape
    const links = rec('F15'); links.fails = [links.fails[1]];
    assert.equal(classify(links), null);
    const other = rec('F15'); other.fails[0].detail = "body#30 read #28: TypeError: Cannot read properties of undefined (reading 'x')";
    assert.equal(classify(other), null);
    assert.equal(classify(rec('F15', { lane: 'ERROR' })), null);
});

// b70 DIV-F15 widening (maintainer ruling b70 #3): under the V1 frame taint, headpatched NEST 0xaed1587a@30 also
// reports O1e effect-stale on effect#30 = the body that escaped the TypeError in the same step (its `seen` is the
// prefix the crash cut). Matched only with an O6 escape-TypeError co-fail naming the SAME body #N (sameBody).
const F15_STALE = { oracle: 'O1e', sig: 'effect-stale', detail: 'effect#30 saw [#26=1,#27=undefined] model [#26=1,#27=undefined,#28=Infinity,#29=16]' };
const f15stale = (fn) => { const r = rec('F15'); r.fails.splice(1, 0, clone(F15_STALE)); if (fn) fn(r); return r; };
const TOP_LEVEL_F15 = "top-level read of #30: TypeError: Cannot set properties of null (setting 'headSub')";

test('b70 DIV-F15 widening: O1e effect-stale on the body that escaped the TypeError -> DIV-F15 (REPORT effect#30/body#30)', () => {
    const c = classify(f15stale());
    assert.notEqual(c, null);
    assert.equal(c.known, 'DIV-F15');
    assert.deepEqual(c.perFail.map((p) => p.slice()), [['DIV-F15'], ['DIV-F15'], ['DIV-F15']]);
});

test('b70 DIV-F15 widening must-fails: another effect#, no O6 co-fail, an O6 with no body ref -> known=none', () => {
    // a different effect than the O6 body that crashed: an independent stale effect is not the co-symptom
    assert.equal(classify(f15stale((r) => { r.fails[1].detail = r.fails[1].detail.replace('effect#30', 'effect#31'); })), null);
    // no O6 escape-TypeError in the step: a standalone stale effect (with or without the O5 line)
    assert.equal(classify(f15stale((r) => { r.fails = [r.fails[1]]; })), null);
    assert.equal(classify(f15stale((r) => { r.fails = [r.fails[1], r.fails[2]]; })), null);
    // the O6 'top-level read of #N' form names no body: sameBody fails closed (that O6 line alone still matches)
    assert.equal(classify(f15stale((r) => { r.fails[0].detail = TOP_LEVEL_F15; })), null);
    assert.equal(known(rec('F15', { fails: [{ oracle: 'O6', sig: 'escape-TypeError', detail: TOP_LEVEL_F15 }] })), 'DIV-F15');
});

test('DIV-F7: a fire for a disposed target; near-misses -> null', () => {
    assert.equal(known(rec('F7')), 'DIV-F7');
    const off = rec('F7'); off.fails[0].detail = 'onConnect fired for registration r3 on #51: registration off';
    assert.equal(classify(off), null);
    const other = rec('F7'); other.fails[0].detail = 'onConnect fired for registration r3 on #51: target #52 disposed';
    assert.equal(classify(other), null);
    assert.equal(classify(rec('F7', { lane: 'GRAPH' })), null);
});

// ---- 3. DIV-F22 ---------------------------------------------------------------------------------------
test('DIV-F22 attribution: F6 pre-walk token -> F6+F22, effect-body escape -> F22', () => {
    const a = classifyFx(rec('F6F22'));
    assert.equal(a.known, 'DIV-F6+DIV-F22');
    assert.equal(a.tag, 'F6+F22');
    assert.deepEqual(a.perFail, [['DIV-F6'], ['DIV-F22'], ['DIV-F6']]);
    const b = classifyFx(rec('F22'));
    assert.equal(b.known, 'DIV-F22');
    assert.equal(b.tag, 'F22');
    // the 17th S1b "F6+F22" world: predicted escape, same failure on headpatched -> F22
    assert.equal(classify(rec('F22rev')).tag, 'F22');
});

test('DIV-F22 must-fail controls (amendment 8)', () => {
    // the same failure without throw-in-batch -> null
    const noWorld = rec('F22'); noWorld.worldScen = without(noWorld.worldScen, 'throw-in-batch');
    assert.equal(classify(noWorld), null);
    const noStep = rec('F22'); noStep.scen = [];
    assert.equal(classify(noStep), null);
    // expected-escape-missing for a NON-batch token -> null
    const nb = rec('F22'); nb.fails[0].detail = 'predicted escape computed:10 x1 did not happen';
    assert.equal(classify(nb), null);
    // another op's batch token, a different lane, a different op
    const step = rec('F22'); step.fails[0].detail = 'predicted escape batch:12 x1 did not happen';
    assert.equal(classify(step), null);
    assert.equal(classify(rec('F22', { lane: 'BATCH' })), null);
    assert.equal(classify(rec('F22', { op: 'set' })), null);
    // no evidence of the replacing error, or nothing replaced it (a swallowed batch error is another defect)
    const ne = rec('F22'); delete ne.escape;
    assert.equal(classify(ne), null);
    assert.equal(classify(rec('F22', { escape: [] })), null);
    // the batch token did escape (inconsistent), an engine error replaced it, an equals token replaced it
    assert.equal(classify(rec('F22', { escape: [{ origin: 'batch', token: 'batch:187' }] })), null);
    assert.equal(classify(rec('F22', { escape: [{ ctor: 'TypeError', message: 'x' }] })), null);
    assert.equal(classify(rec('F22', { escape: [{ origin: 'equals', token: 'equals:8' }] })), null);
    // a different token origin: an unpredicted equals escape is not the F6 pre-walk
    const eq = rec('F22', { escape: [{ origin: 'equals', token: 'equals:8' }] });
    eq.fails.unshift({ oracle: 'O6', sig: 'escape-equals', detail: 'unpredicted escape equals:8' });
    assert.equal(classify(eq), null);
    // the escape-computed fail names a token that is not in this call's escape
    assert.equal(classifyFx(rec('F6F22', { escape: [{ origin: 'computed', token: 'computed:99' }] })), null);
});

// ---- 4. fixedIn ----------------------------------------------------------------------------------------
test('a fixed entry explains only with a named control kernel (includeFixed)', () => {
    const r = fresh();
    for (const e of r.entries) if (e.id === 'DIV-F21') e.fixedIn = 'A2-F21';
    assert.deepEqual(validate(r), []);
    assert.equal(classify(rec('F21'), { registry: r }), null);
    assert.equal(known(rec('F21'), { registry: r, includeFixed: true }), 'DIV-F21');
    // an unfixed copy (fixedIn null, the pre-A2-F21 registry) explains without includeFixed
    const u = fresh();
    for (const e of u.entries) if (e.id === 'DIV-F21') e.fixedIn = null;
    assert.equal(known(rec('F21'), { registry: u }), 'DIV-F21');
    // the REGISTRY side of the rule, on the REAL registry file (fixedIn A2-F21): these rows restate the rule
    // includeFixed = (controls.name !== null) themselves; a tree / scratch kernel (name null) -> null (a fixed finding
    // is a regression there), a pre-fix control kernel (headpatched, rev152) -> DIV-F21. The wiring itself (main.mjs
    // failureRecord, SoakReport checkCycles) is gated by test/46 'fixed-entry wiring: a NON-control headpatched copy'.
    assert.equal(classify(rec('F21')), null, 'the default registry with no opts');
    for (const [name, want] of [[null, null], ['headpatched', 'DIV-F21'], ['rev152', 'DIV-F21']]) {
        assert.equal(known(rec('F21'), { includeFixed: name !== null }), want, 'controls.name ' + String(name));
    }
    // DIV-F22 (fixedIn null) explains on every kernel
    for (const inc of [false, true]) assert.equal(known(rec('F22'), { includeFixed: inc }), 'DIV-F22');
    assert.throws(() => classify(rec('F21'), { includeFixed: 'yes' }), TypeError);
    assert.throws(() => classify(rec('F21'), { includefixed: true }), TypeError);
    const bad = fresh(); bad.entries.push(clone(bad.entries[0]));
    assert.throws(() => classify(rec('F21'), { registry: bad }), /invalid/);
});

test('classify: a wrong container TYPE throws, an unknown value is null', () => {
    assert.throws(() => classify(null), TypeError);
    assert.throws(() => classify([]), TypeError);
    assert.throws(() => classify(rec('F21', { fails: [] })), TypeError);
    assert.throws(() => classify(rec('F21', { step: '40' })), TypeError);
    assert.throws(() => classify(rec('F21', { worldScen: 'cycle-error-surfaces' })), TypeError);
    assert.throws(() => classify(rec('F21', { escape: 'computed:1' })), TypeError);
    assert.throws(() => classify(rec('F21'), 1), TypeError);
    assert.equal(classify(rec('F21', { lane: 'NOPE' }), FX()), null);
});

// ---- 5. validate must-fails ----------------------------------------------------------------------------
const has = (probs, re) => probs.some((p) => re.test(p));

test('B2 assertion: validate fails on an orphan entry', () => {
    const r = fresh();
    r.entries.push({
        id: 'DIV-orphan', kind: 'contract', finding: 'X1', since: '1.6.0', fixedIn: null, fixBy: null, decision: 'd', engines: ['lite'],
        lanes: [], oracles: [], sigs: [], ops: [], scen: [], worldScen: [], priorScen: [], shapes: [], attribution: null,
        pending: null, conformanceCases: [], expectedThrow: null, description: 'explains nothing',
    });
    assert.ok(has(validate(r), /^orphan entry: DIV-orphan/), validate(r).join('\n'));
    // the same entry with a pending lane is not an orphan (append-friendly)
    r.entries[r.entries.length - 1].pending = 'S3 somewhere';
    assert.deepEqual(validate(r), []);
    // an allowance-only entry becomes an orphan when its allowance goes away
    const s = fresh(); delete s.allowances.genRules.G4; s.allowances.structural.G4 = 'now structural';
    assert.ok(has(validate(s), /^orphan entry: DIV-G4-duplicate-read-links/));
});

test('B2 assertion: validate fails on an orphan allowance', () => {
    const a = fresh(); a.allowances.genRules.G4 = 'DIV-nope';
    assert.ok(has(validate(a), /^orphan allowance: genRules\.G4 -> DIV-nope/));
    const b = fresh(); delete b.allowances.structural.G6;
    assert.ok(has(validate(b), /^orphan allowance: generator rule G6/));
    // a generator rule added to gen.mjs without a registry decision
    const v = Object.assign({}, DEFAULT_VOCAB, { genRules: GEN_RULES.concat(['G11']) });
    assert.ok(has(validate(fresh(), v), /^orphan allowance: generator rule G11/));
    const c = fresh(); c.allowances.genRules.G99 = 'DIV-G5-deep-chain';
    assert.ok(has(validate(c), /^orphan allowance: genRules\.G99 is not a generator rule/));
    const d = fresh(); d.allowances.oracle[0].entry = 'DIV-gone';
    assert.ok(has(validate(d), /^orphan allowance: oracle allowance taint-skip/));
});

test('validate rejects a broad or malformed matcher', () => {
    const mut = (fn) => { const r = fresh(); fn(r.entries.find((e) => e.id === 'DIV-F15'), r); return validate(r); };
    assert.ok(has(mut((e) => { e.shapes.pop(); }), /pair O5:link-count has no shape \(broad matcher\)/));
    assert.ok(has(mut((e) => { e.shapes[0].detail = 'TypeError'; }), /anchored regex/));
    assert.ok(has(mut((e) => { e.shapes[0].detail = '^(unclosed$'; }), /does not compile/));
    assert.ok(has(mut((e) => { e.lanes.push('NOPE'); }), /unknown lane NOPE/));
    assert.ok(has(mut((e) => { e.sigs.push('glitch'); }), /sig glitch belongs to none of its oracles/));
    assert.ok(has(mut((e) => { e.scen.push('nope'); }), /unknown scen nope/));
    assert.ok(has(mut((e) => { e.priorScen.push('saved-cursor-hazard'); }), /not a once-per-step scenario/));
    assert.ok(has(mut((e) => { e.extra = 1; }), /unknown key extra/));
    assert.ok(has(mut((e) => { e.pending = 'x'; }), /a matcher entry has pending set/));
    assert.ok(has(mut((e, r) => { r.entries.push(clone(e)); }), /duplicate id/));
    assert.ok(has(mut((e) => { e.attribution = 'batch-token-replaced'; }), /needs oracles \[O6\], sigs \[expected-escape-missing\]/));
    assert.ok(has(mut((e) => { e.conformanceCases.push('audit/x.mjs'); }), /in-repo relative path/));
    assert.ok(has(mut((e) => { e.shapes[1].with = ['O6:escape-NOPE!']; }), /unknown pair/));
    assert.ok(has(validate({ schema: 2 }), /schema must be 1/));
    assert.deepEqual(validate([]), ['registry: not a plain object']);
});

test('b70 validate: sameBody is a boolean and requires with; the widened DIV-F15 keeps the no-slack rule', () => {
    const mut = (fn) => { const r = fresh(); fn(r.entries.find((e) => e.id === 'DIV-F15')); return validate(r); };
    const o1e = (e) => e.shapes.find((sh) => sh.pair === 'O1e:effect-stale');
    assert.ok(has(mut((e) => { o1e(e).sameBody = 'yes'; }), /sameBody must be a boolean/));
    assert.ok(has(mut((e) => { o1e(e).sameBody = 1; }), /sameBody must be a boolean/));
    assert.ok(has(mut((e) => { delete o1e(e).with; }), /sameBody requires with/));
    assert.deepEqual(mut((e) => { o1e(e).sameBody = false; }), []);
    assert.ok(has(mut((e) => { e.shapes.splice(e.shapes.indexOf(o1e(e)), 1); }), /pair O1e:effect-stale has no shape \(broad matcher\)/));
    assert.ok(has(mut((e) => { e.oracles.pop(); }), /sig effect-stale belongs to none of its oracles/));
});

test('the registry is append-friendly: a valid appended entry validates and classifies', () => {
    const r = fresh();
    r.entries.push({
        id: 'DIV-X1', kind: 'engine', finding: 'X1', since: '1.6.0', fixedIn: null, fixBy: 'A9', decision: 'd', engines: ['lite'],
        lanes: ['NEST'], oracles: ['O5'], sigs: ['node-count'], ops: [], scen: [], worldScen: [], priorScen: [],
        shapes: [{ pair: 'O5:node-count', detail: '^activeNodes engine=\\d+ model=\\d+$' }], attribution: null,
        pending: null, conformanceCases: [], expectedThrow: null, description: 'appended by a rung',
    });
    assert.deepEqual(validate(r), []);
    const x = { engine: 'lite', lane: 'NEST', step: 3, op: 'seq', fails: [{ oracle: 'O5', sig: 'node-count', detail: 'activeNodes engine=9 model=8' }], scen: [], worldScen: [] };
    assert.equal(known(x, { registry: r }), 'DIV-X1');
    assert.equal(classify(x), null);
});

// ---- 6. evidence --------------------------------------------------------------------------------------
test('every conformance case exists in the repo', () => {
    for (const e of fresh().entries) for (const p of e.conformanceCases) assert.ok(existsSync(join(ROOT, p)), e.id + ': ' + p);
});

test('the F21 census parses and every captured F21 world had an earlier surfaced CycleError', () => {
    const c = JSON.parse(readFileSync(join(ROOT, 'bench', 'soak', 'calibration', 'f21-census.json'), 'utf8'));
    assert.equal(c.schema, 1);
    assert.match(c.status, /UNRUN|PENDING|VERIFIED/);
    for (const k of ['rev152', 'headpatched']) {
        assert.ok(Array.isArray(c.f21.worlds[k]) && c.f21.worlds[k].length > 0, k);
        for (const w of c.f21.worlds[k]) assert.ok(w.cycleErrorSurfaces >= 2, k + ' ' + w.ws);
    }
});

// ---- 7. round 2 ---------------------------------------------------------------------------------------
test('a detail regex must match the WHOLE detail: lexical-only anchors are rejected', () => {
    const mutF6 = (src) => { const r = fresh(); r.entries.find((e) => e.id === 'DIV-F6').shapes[0].detail = src; return r; };
    // top-level alternation: compiled as ^(?:...)$ it matches every detail -> probe rejects it
    assert.ok(has(validate(mutF6('^unpredicted escape computed:\\d+|.*$')), /structure-free probe/));
    assert.ok(has(validate(mutF6('^.*$')), /structure-free probe/));
    assert.ok(has(validate(mutF6('^(?:)$')), /structure-free probe/));
    // the final $ is escaped (a literal dollar, not an anchor)
    assert.ok(has(validate(mutF6('^x\\$')), /unescaped \$/));
    // no $ at all
    assert.ok(has(validate(mutF6('^TypeError')), /anchored regex/));
    // a ')' that would break out of the (?:...) group: the body must compile on its own
    assert.ok(has(validate(mutF6('^a)|(?:zz.*$')), /does not compile/));
    // an even run of backslashes before $ leaves it unescaped: still valid
    assert.deepEqual(validate(mutF6('^unpredicted escape computed:\\d+\\\\$')), []);
    // the same broad matcher cannot enter through opts.registry (a dv-proposed.json)
    assert.throws(() => classifyFx(rec('F6'), { registry: mutF6('^unpredicted escape computed:\\d+|.*$') }), /invalid/);
    // the shipped shapes are whole-string matchers: a detail with a suffix no longer matches
    const tail = rec('F6'); tail.fails[0].detail = 'unpredicted escape computed:13 and more';
    assert.equal(classifyFx(tail), null);
    // the ^(?:...)$ wrapper itself: a narrow top-level alternation is legitimate, and it must NOT match a
    // detail that merely starts with the first branch (compiled as new RegExp(src) it would -> DIV-F6).
    // The second branch is 'kq7', not 'zz': 'zz' is a probe, so the wrapped form would be rejected.
    const alt = mutF6('^unpredicted escape computed:\\d+|kq7$');
    assert.deepEqual(validate(alt), []);
    assert.equal(classifyFx(tail, { registry: alt }), null);
    assert.equal(knownFx(rec('F6'), { registry: alt }), 'DIV-F6');
    // a structure-free length matcher is caught by the longer probes
    assert.ok(has(validate(mutF6('^.{2,}$')), /structure-free probe/));
    assert.ok(has(validate(mutF6('^[a-z0-9 ]{2,}$')), /structure-free probe/));
});

test('classify options and records are read from OWN data properties only (inherited -> TypeError)', () => {
    const r = fresh();
    for (const e of r.entries) if (e.id === 'DIV-F21') e.fixedIn = 'A2-F21';
    // chosen behaviour: an inherited option THROWS (never honoured, never silently ignored)
    assert.throws(() => classify(rec('F21'), Object.create({ includeFixed: true })), TypeError);
    assert.throws(() => classify(rec('F21'), Object.create({ registry: r })), TypeError);
    const getter = {}; Object.defineProperty(getter, 'includeFixed', { enumerable: true, get: () => true });
    assert.throws(() => classify(rec('F21'), getter), TypeError);
    assert.throws(() => classify(rec('F21'), new (class O { constructor() { this.includeFixed = true; } })()), TypeError);
    // a Symbol key and a non-enumerable unknown key are unknown options too
    assert.throws(() => classify(rec('F21'), { [Symbol('includeFixed')]: true }), TypeError);
    const hidden = {}; Object.defineProperty(hidden, 'includefixed', { enumerable: false, value: true });
    assert.throws(() => classify(rec('F21'), hidden), TypeError);
    // a null-prototype plain object is accepted and its OWN option is honoured
    const np = Object.assign(Object.create(null), { registry: r, includeFixed: true });
    assert.equal(known(rec('F21'), np), 'DIV-F21');
    assert.equal(classify(rec('F21'), Object.assign(Object.create(null), { registry: r })), null);
    // a record whose evidence sits on a prototype is rejected, not read
    const base = rec('F22'); const esc = base.escape; delete base.escape;
    assert.throws(() => classify(Object.assign(Object.create({ escape: esc }), base)), TypeError);
    assert.equal(classify(base), null);
    const fp = rec('F21'); fp.fails = [Object.create(fp.fails[0])];
    assert.throws(() => classify(fp), TypeError);
});

test('ONCE_PER_STEP pin: the generator puts at most one cycle trigger (cyc:1 set) in any top-level op', () => {
    // exec.mjs runs a guard with cycle=true only for a set with cyc === 1 (applied through seq recursion), and
    // scenarios.mjs counts cycle-error-surfaces at most once per such guard. DIV-F21's priorScen relies on
    // <= 1 per step; lanes/error.mjs puts exactly one trig in each cycle-bomb seq. This pins it.
    const countCyc = (op) => {
        let n = op.o === 'set' && op.cyc === 1 ? 1 : 0;
        if (Array.isArray(op.ops)) for (const x of op.ops) n += countCyc(x);
        if (Array.isArray(op.body)) for (const x of op.body) n += countCyc(x);
        return n;
    };
    for (const desc of LANES) {
        const cs = seedFor(0xC0FFEE, desc.index, 0);
        let total = 0;
        for (let w = 0; w < 200; w++) {
            const script = generateWorld(desc, worldSeed(cs, w), { large: isLargeWorld(desc, w) });
            for (const op of script.ops) {
                const n = countCyc(op);
                assert.ok(n <= 1, desc.name + ' world ' + w + ' has ' + n + ' cycle triggers in one op');
                if (n === 1) assert.equal(op.o, 'seq', desc.name + ': a cycle trigger outside a cycle-bomb seq');
                total += n;
            }
        }
        if (desc.name === 'ERROR') assert.ok(total > 0, 'ERROR generated no cycle-bomb: the pin would be vacuous');
        else assert.equal(total, 0, desc.name + ' generated a cycle trigger (G7: ERROR only)');
    }
});

// ---- QA burst 3b (2026-10-12): boundary matrix, appended -------------------------------------------------

test('QA adversarial: priorScen reads OWN counts only -- a polluted Object.prototype never proves an earlier surface', () => {
    // kills the "drop !own(c, s)" mutant of prior(): isPlain admits Object.prototype, whose inherited keys are not counts
    const r = rec('F21', { worldScenCounts: {} });
    assert.equal(classify(r, FX()), null, 'control: no own count -> null');
    Object.prototype['cycle-error-surfaces'] = 2;
    let got;
    try { got = classify(rec('F21', { worldScenCounts: {} }), FX()); } finally { delete Object.prototype['cycle-error-surfaces']; }
    assert.equal(got, null, 'an inherited count proved priorScen (fail open)');
    assert.equal(known(rec('F21'), FX()), 'DIV-F21', 'positive control after cleanup');
});

test('QA boundary DIV-F21 priorScen counts: 1 (own step only), 2, 2^31, 2^53 - 1 vs 0, -0, -1, NaN, 1.5, Infinity, "2", null', () => {
    const k = (c) => known(rec('F21', { worldScenCounts: { 'cycle-error-surfaces': c } }), FX());
    for (const c of [2, 3, 2 ** 30, 2 ** 31, 2 ** 32, 2 ** 53 - 1]) assert.equal(k(c), 'DIV-F21', 'count ' + c);
    for (const c of [1, 0, -0, -1, NaN, 1.5, Infinity, '2', null, undefined]) assert.equal(k(c), null, 'count ' + String(c));
});

test('QA boundary DIV-F22 step: 0, -0, 2^30, 2^31 - 1, 2^31, 2^32 - 1, 2^32, 2^53 - 1 match their own batch token; -1 and bad types do not', () => {
    const f22 = (step, tok) => {
        const r = rec('F22', { step });
        r.fails[0].detail = 'predicted escape batch:' + tok + ' x1 did not happen';
        return r;
    };
    for (const s of [0, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1]) assert.equal(known(f22(s, String(s))), 'DIV-F22', 'step ' + s);
    assert.equal(known(f22(-0, '0')), 'DIV-F22', '-0 is step 0');
    assert.equal(known(f22(2 ** 31, String(2 ** 31 - 1))), null, 'off by one below the 2^31 wrap');
    assert.equal(known(f22(2 ** 32, '0')), null, 'a uint32-wrapped token is another op');
    assert.equal(known(f22(-1, '-1')), null, 'a negative step names no batch token');
    for (const s of [NaN, 1.5, null, undefined, '187', Infinity]) {
        assert.throws(() => classify(rec('F22', { step: s })), TypeError, 'step ' + String(s));
    }
});

test('QA boundary classify: empty / null / undefined inputs throw; a repeated call is pure and its result is frozen', () => {
    for (const bad of [null, undefined, 0, '', [], rec('F21', { fails: [] }), rec('F21', { scen: [''] }), rec('F21', { worldScen: null })]) {
        assert.throws(() => classify(bad), TypeError);
    }
    assert.throws(() => classify(rec('F21'), null), TypeError);
    assert.equal(known(rec('F21'), {}), null, 'an empty opts object is the default (includeFixed false: DIV-F21 is fixed)');
    assert.equal(known(rec('F22'), {}), 'DIV-F22', 'an empty opts object is the default');
    const r = rec('F22');
    const a = classify(r), b = classify(r);
    assert.deepEqual(a, b);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.ids) && Object.isFrozen(a.perFail));
    assert.deepEqual(r, rec('F22'), 'classify never mutates its record');
    // duplicate fails: the same F22 fail twice is still explained, once per fail
    const dup = rec('F22');
    dup.fails.push(clone(dup.fails[0]));
    assert.equal(classify(dup).perFail.length, 2);
});

test('QA teeth DIV-F6 `with`: the F6-shaped O4 effect-dead alone (no O6 escape-computed in the step) classifies null', () => {
    // (b53: O4solo is now DIV-F6 through the engine-side ERR shape; this record has the ERR on the MODEL side.)
    // This record keeps the real F6 O4 detail (model ERR(computed:13)) and drops only the escape-computed fail.
    const solo = rec('F6');
    solo.fails = solo.fails.filter((f) => f.oracle === 'O4');
    assert.equal(solo.fails.length, 1);
    assert.equal(classifyFx(solo), null, 'O4 effect-dead was explained without its F6 escape');
    assert.equal(knownFx(rec('F6')), 'DIV-F6', 'positive control');
});

// ---- 8. b53 N19.3: DIV-F6 widened to the pre-walk-throw stale-cache shapes -----------------------------
// REAL records, preb33 replays of ERROR 0x5a22a78c (cycle 0) and ERROR 0x1b56bf6a (cycle 4), embedded literally
// (replay-ERROR_*_0x*-preb33.jsonl, key `failure`); records (c) 0x4d02a6e8 and (d) 0x84b7e95f come from
// c-replay-ERROR_4_0x4d02a6e8-preb33.jsonl and c-replay-ERROR_7_0x84b7e95f-preb33.jsonl (same format). Expected values come from the ruling (PLAN N19.3), not from a run.
const B53 = {
    // head (a): standalone O4 effect-dead, the stale ERR(computed) on the engine ("saw") side, no O6
    a: {
        engine: 'lite', lane: 'ERROR', step: 32, op: 'set',
        fails: [{ oracle: 'O4', sig: 'effect-dead', detail: 'effect#23 saw [#15=-0,#21=ERR(computed:18)] model [#15=-0,#21=undefined] (ran 0 times this op)' }],
        scen: ['recovery-after-throw', 'equality-cutoff'],
        worldScen: ['diamond-write', 'throw-dep-computed-prewalk', 'dep-set-flip', 'recovery-after-throw', 'equality-cutoff'],
        worldScenCounts: { 'diamond-write': 1, 'throw-dep-computed-prewalk': 1, 'dep-set-flip': 3, 'recovery-after-throw': 1, 'equality-cutoff': 1 },
    },
    // head (c) ERROR 0x4d02a6e8@37 (cached-rethrow site, no throw-dep-computed-prewalk tag): standalone O4 effect-dead
    c: {
        engine: 'lite', lane: 'ERROR', step: 37, op: 'set',
        fails: [{ oracle: 'O4', sig: 'effect-dead', detail: 'effect#22 saw [#16=14,#17=14,#18=ERR(computed:13)] model [#16=14,#17=14,#18=14] (ran 0 times this op)' }],
        scen: ['recovery-after-throw', 'dep-set-flip', 'equality-cutoff'],
        worldScen: ['diamond-write', 'throwing-equals', 'equality-cutoff', 'dep-set-flip', 'second-invalidation', 'recovery-after-throw'],
        worldScenCounts: { 'diamond-write': 1, 'throwing-equals': 1, 'equality-cutoff': 3, 'dep-set-flip': 7, 'second-invalidation': 1, 'recovery-after-throw': 4 },
    },
    // head (d) ERROR 0x84b7e95f@63: standalone O1c computed-err-mismatch, engine=ERR(computed)
    d: {
        engine: 'lite', lane: 'ERROR', step: 63, op: 'batch',
        fails: [{ oracle: 'O1c', sig: 'computed-err-mismatch', detail: 'node#31 (sum) engine=ERR(computed:13) model=208570' }],
        scen: ['recovery-after-throw', 'second-invalidation'],
        worldScen: ['multi-write-same-signal', 'dep-set-flip', 'second-invalidation', 'throw-in-batch', 'recovery-after-throw'],
        worldScenCounts: { 'multi-write-same-signal': 1, 'dep-set-flip': 11, 'second-invalidation': 16, 'throw-in-batch': 3, 'recovery-after-throw': 4 },
        escape: [],
    },
    // head (b): O2 glitch + O1c computed-err-mismatch, engine=ERR(computed:N)
    b: {
        engine: 'lite', lane: 'ERROR', step: 119, op: 'set',
        fails: [
            { oracle: 'O2', sig: 'glitch', detail: 'body#42 read #41 engine=ERR(computed:13) model=7507424' },
            { oracle: 'O1c', sig: 'computed-err-mismatch', detail: 'node#42 (sum) engine=ERR(computed:13) model=ERR(computed:42)' },
        ],
        scen: ['recovery-after-throw', 'second-invalidation'],
        worldScen: ['diamond-write', 'second-invalidation', 'throwing-equals', 'dep-set-flip', 'equality-cutoff', 'multi-write-same-signal',
            'throw-dep-computed-prewalk', 'cycle-error-surfaces', 'throw-in-batch', 'recovery-after-throw'],
        worldScenCounts: { 'diamond-write': 13, 'second-invalidation': 43, 'throwing-equals': 5, 'dep-set-flip': 13, 'equality-cutoff': 6,
            'multi-write-same-signal': 1, 'throw-dep-computed-prewalk': 5, 'cycle-error-surfaces': 1, 'throw-in-batch': 5, 'recovery-after-throw': 12 },
    },
};
const b53 = (k, mut) => { const r = clone(B53[k]); if (mut) mut(r); return r; };
const dropWorld = (r, name) => { r.worldScen = without(r.worldScen, name); delete r.worldScenCounts[name]; return r; };
const addWorld = (r, name) => { r.worldScen.push(name); r.worldScenCounts[name] = 1; return r; };
const notF6 = (r) => { const c = classifyFx(r); return c === null || !c.known.includes('DIV-F6'); };

test('b53 A1: head (a) -- standalone O4 effect-dead with the stale ERR(computed) on the engine side -> DIV-F6', () => {
    const c = classifyFx(b53('a'));
    assert.notEqual(c, null);
    assert.equal(c.known, 'DIV-F6');
    assert.deepEqual(c.perFail, [['DIV-F6']]);
    assert.equal(knownFx(rec('O4solo')), 'DIV-F6', 'the older captured 0x5a22a78c record (same shape) agrees');
});

test('b53 A2: head (b) -- O2 glitch + O1c computed-err-mismatch with engine=ERR(computed) -> every line DIV-F6', () => {
    const c = classifyFx(b53('b'));
    assert.notEqual(c, null);
    assert.equal(c.known, 'DIV-F6');
    assert.deepEqual(c.perFail, [['DIV-F6'], ['DIV-F6']]);
});

test('b53 A3: head (b) in a revert-after-mid-read world is NOT DIV-F6 (the F5 shapes stay F5 or unknown)', () => {
    assert.ok(notF6(b53('b', (r) => addWorld(r, 'revert-after-mid-read'))));
    assert.ok(notF6(b53('a', (r) => addWorld(r, 'revert-after-mid-read'))));
    assert.equal(knownFx(b53('b'), undefined), 'DIV-F6', 'positive control: the unmodified record');
});

test('b53 A4 (N19.6): dropping throw-dep-computed-prewalk from the world stays DIV-F6; dropping recovery-after-throw is NOT DIV-F6', () => {
    assert.equal(knownFx(b53('a', (r) => dropWorld(r, 'throw-dep-computed-prewalk'))), 'DIV-F6');
    assert.ok(notF6(b53('a', (r) => dropWorld(r, 'recovery-after-throw'))));
    assert.equal(knownFx(b53('b', (r) => dropWorld(r, 'throw-dep-computed-prewalk'))), 'DIV-F6');
    assert.ok(notF6(b53('b', (r) => dropWorld(r, 'recovery-after-throw'))));
    assert.equal(knownFx(b53('a')), 'DIV-F6', 'positive control');
});

test('b53 A5: an O4 effect-dead with ERR(computed) on the MODEL side only, standalone, is NOT DIV-F6 (pre-b53 behaviour)', () => {
    const r = b53('a');
    r.fails = [{ oracle: 'O4', sig: 'effect-dead', detail: 'effect#26 saw [#21=8346155] model [#21=ERR(computed:13)] (ran 0 times this op)' }];
    assert.equal(classifyFx(r), null);
});

test('b53 A6: DIV-F5-shaped records still classify DIV-F5 (including the model-side ERR(computed) F5errM with the prewalk scenarios present)', () => {
    assert.equal(knownFx(rec('F5')), 'DIV-F5');
    assert.equal(knownFx(rec('F5later')), 'DIV-F5');
    assert.equal(knownFx(rec('F5err')), 'DIV-F5');
    assert.equal(knownFx(F5errM()), 'DIV-F5');
    assert.equal(knownFx(rec('F5err')) === 'DIV-F6', false);
});

test('b53 near-miss: head (a) / (b) on another lane classify null', () => {
    assert.equal(classifyFx(b53('a', (r) => { r.lane = 'BATCH'; })), null);
    assert.equal(classifyFx(b53('b', (r) => { r.lane = 'NEST'; })), null);
});

test('b53 N19.6: heads (c) O4 and (d) O1c computed-err-mismatch (no throw-dep-computed-prewalk tag) -> DIV-F6; narrowing holds', () => {
    assert.equal(knownFx(b53('c')), 'DIV-F6');
    assert.equal(knownFx(b53('d')), 'DIV-F6');
    assert.equal(knownFx(rec('CEMsolo')), 'DIV-F6', 'the older captured standalone O1c (recovery-after-throw world, engine-side ERR)');
    for (const k of ['c', 'd']) {
        assert.ok(notF6(b53(k, (r) => dropWorld(r, 'recovery-after-throw'))), k + ' without recovery-after-throw');
        assert.ok(notF6(b53(k, (r) => addWorld(r, 'revert-after-mid-read'))), k + ' with revert-after-mid-read');
    }
    // a standalone O1c computed-err-mismatch with ERR on the MODEL side only is not the stale cache
    const m = b53('d'); m.fails[0].detail = 'node#31 (sum) engine=208570 model=ERR(computed:13)';
    assert.equal(classifyFx(m), null);
});


test('b53 validate: shape worldScen / notWorldScen fail closed; all-of / none-of hold', () => {
    const F6 = (r) => r.entries.find((e) => e.id === 'DIV-F6');
    const v = (fn) => { const r = fresh(); fn(F6(r).shapes[2], F6(r)); return validate(r); };
    for (const k of ['worldScen', 'notWorldScen']) {
        for (const bad of ['recovery-after-throw', [], ['no-such-scen'], null]) assert.ok(has(v((s) => { s[k] = bad; }), new RegExp(k + ' must be known scenarios')), k + ' ' + JSON.stringify(bad));
        assert.ok(has(v((s) => { s[k] = ['equality-cutoff', 'equality-cutoff']; }), new RegExp(k + ' has duplicates')));
    }
    assert.ok(has(v((s) => { s.notWorldScen = ['recovery-after-throw']; }), /in both worldScen and notWorldScen/));
    assert.ok(has(v((s, e) => { e.worldScen = ['revert-after-mid-read']; }), /is in the entry worldScen/));
    const all = fresh(); for (const s of F6(all).shapes) if (s.worldScen) s.worldScen = ['recovery-after-throw', 'equality-cutoff'];
    assert.equal(knownFx(b53('c'), { registry: all }), 'DIV-F6'); assert.equal(classifyFx(b53('d'), { registry: all }), null);
    const none = fresh(); for (const s of F6(none).shapes) if (s.notWorldScen) s.notWorldScen = ['revert-after-mid-read', 'throwing-equals'];
    assert.equal(knownFx(b53('d'), { registry: none }), 'DIV-F6'); assert.equal(classifyFx(b53('c'), { registry: none }), null);
});

// ---- 8b. b103 B5 (PLAN-0s-fixt TASK 12): DIV-F6 FIXED by FIX-T (0878c6b) -----------------------------------
// The DIV-F6 matcher rows above run as a named control kernel does (classifyFx / knownFx = includeFixed true), so
// their near-miss nulls stay the matcher's, never the fixedIn skip's. This row pins the fixed state itself.
test('DIV-F6 is fixed in A2-FIX-T (b103): the tree classifies every F6 shape null (a regression there); a named control kernel explains it', () => {
    const e = fresh().entries.find((x) => x.id === 'DIV-F6');
    assert.equal(e.kind, 'fix');
    assert.equal(e.fixedIn, 'A2-FIX-T');
    assert.equal(e.fixBy, 'A2');
    for (const k of ['F6', 'O4solo', 'CEMsolo']) {
        assert.equal(classify(rec(k)), null, k + ': the default (tree: controls.name null)');
        assert.equal(classify(rec(k), { includeFixed: false }), null, k + ': includeFixed false');
        assert.equal(known(rec(k), FX()), 'DIV-F6', k + ': a named control kernel (preb33, rev152)');
    }
    for (const k of ['a', 'b', 'c', 'd']) {
        assert.equal(classify(b53(k)), null, 'b53 head ' + k + ' on the tree');
        assert.equal(known(b53(k), FX()), 'DIV-F6', 'b53 head ' + k + ' on a control kernel');
    }
    // amendment 8: a computed (pre-walk) replacing token needs F6, so the F6+F22 world is unknown on the tree, not F22
    assert.equal(classify(rec('F6F22')), null);
    assert.equal(classifyFx(rec('F6F22')).tag, 'F6+F22');
    // an unfixed copy (fixedIn null: the pre-b103 registry) explains without includeFixed
    const u = fresh(); for (const x of u.entries) if (x.id === 'DIV-F6') x.fixedIn = null;
    assert.equal(known(rec('F6'), { registry: u }), 'DIV-F6');
});

// b103 R13.2 (PLAN-0s-fixt ADDENDUM 13, triage .handoff/b103-evidence/T1/): ERROR:7:0x8999219f on the tree (FIX-T unmasked
// it; red on 1.5.2 too) is the OPEN F5 bug. Its O1c computed-err-mismatch shape used to require the STEP scen
// revert-after-mid-read, against the entry's own description (the world scen is required, the step scen is not).
const B103_F5 = {"engine":"lite","lane":"ERROR","step":255,"op":"stop","scen":["second-invalidation","dep-set-flip","recovery-after-throw"],"fails":[{"oracle":"O2","sig":"glitch","detail":"body#13 read #12 engine=-620903596 model=438374991"},{"oracle":"O1c","sig":"computed-mismatch","detail":"node#13 (cond) engine=-620903596 model=438374991"},{"oracle":"O1c","sig":"computed-err-mismatch","detail":"node#53 (cond) engine=-620903596 model=ERR(computed:53)"}],"worldScen":["diamond-write","equality-cutoff","dep-set-flip","second-invalidation","throw-in-batch","throwing-equals","throw-dep-effect-prewalk","recovery-after-throw","throw-dep-computed-prewalk","cycle-error-surfaces","multi-write-same-signal","revert-after-mid-read"],"worldScenCounts":{"diamond-write":39,"equality-cutoff":25,"dep-set-flip":147,"second-invalidation":161,"throw-in-batch":13,"throwing-equals":15,"throw-dep-effect-prewalk":22,"recovery-after-throw":88,"throw-dep-computed-prewalk":18,"cycle-error-surfaces":2,"multi-write-same-signal":6,"revert-after-mid-read":1}};
test('b103 R13.2 + b109 A3: the ERROR:7:0x8999219f record (O2 glitch + O1c computed-mismatch + O1c computed-err-mismatch) -> DIV-F5 on a control kernel; DIV-F5 is FIXED in A3-FIX-R', () => {
    const c = classifyFx(clone(B103_F5));
    assert.notEqual(c, null, 'every line of the triage world is explained');
    assert.equal(c.known, 'DIV-F5');
    assert.deepEqual(c.perFail.map((p) => p.slice()), [['DIV-F5'], ['DIV-F5'], ['DIV-F5']]);
    const e = fresh().entries.find((x) => x.id === 'DIV-F5');
    assert.equal(e.fixedIn, 'A3-FIX-R'); assert.equal(e.fixBy, 'A3');
    assert.ok(e.shapes.every((s) => !Object.prototype.hasOwnProperty.call(s, 'scen')), 'no DIV-F5 shape narrows on the step scen');
    // the entry worldScen still binds: the same lines in a world without revert-after-mid-read -> null
    const nw = clone(B103_F5); nw.worldScen = without(nw.worldScen, 'revert-after-mid-read'); delete nw.worldScenCounts['revert-after-mid-read'];
    assert.equal(classifyFx(nw), null);
    // the computed-err-mismatch line alone (the head that read known=none) -> DIV-F5
    const solo = clone(B103_F5); solo.fails = [solo.fails[2]];
    assert.equal(knownFx(solo), 'DIV-F5');
});

// b109 A3 (PLAN-A3-soak TASK 4; assertion A3): FIX-R (74ea021) closed DIV-F5 -- on the tree an F5 shape is a regression
// (known=none), a named control kernel (includeFixed) still explains it. Red on the HEAD registry (fixedIn null: the
// default classify returned DIV-F5).
test('b109 A3: DIV-F5 is fixed in A3-FIX-R: the tree classifies every F5 shape null; a named control kernel explains it', () => {
    const e = fresh().entries.find((x) => x.id === 'DIV-F5');
    assert.equal(e.kind, 'fix');
    assert.equal(e.fixedIn, 'A3-FIX-R');
    assert.equal(e.fixBy, 'A3');
    const recs = { F5: rec('F5'), F5later: rec('F5later'), F5err: rec('F5err'), F5errM: F5errM(), B103_F5: clone(B103_F5) };
    for (const k of Object.keys(recs)) {
        assert.equal(classify(clone(recs[k])), null, k + ': the default (tree: controls.name null)');
        assert.equal(classify(clone(recs[k]), { includeFixed: false }), null, k + ': includeFixed false');
        assert.equal(known(clone(recs[k]), FX()), 'DIV-F5', k + ': a named control kernel (preb33, rev152)');
    }
    // an unfixed copy (fixedIn null: the pre-b109 registry) explains without includeFixed
    const u = fresh(); for (const x of u.entries) if (x.id === 'DIV-F5') x.fixedIn = null;
    for (const k of Object.keys(recs)) assert.equal(known(clone(recs[k]), { registry: u }), 'DIV-F5', k + ': unfixed copy');
    // a copy without DIV-F5 explains nothing (control for the registry copy)
    const gone = fresh(); gone.entries = gone.entries.filter((x) => x.id !== 'DIV-F5');
    assert.equal(classifyFx(clone(B103_F5), { registry: gone }), null);
});

// b109 A1 fallback (Q1): the census (.handoff/b109-evidence/soak/0f-census.txt) found ONE known=DIV-F5 engine=ERR( line on
// preb33 and rev152 (world 0x8992029a, step 57), so the O1c detail is NOT narrowed: an engine-side ERR line in a
// revert-after-mid-read world still classifies DIV-F5 on a control kernel (a real F5 world), null on the tree. Inlined verbatim from .handoff/b109-evidence/soak/0f-ERROR-preb33.jsonl line 1329 (rev152 line 1329 is byte-identical).
const A1_ENGERR = {"engine":"lite","lane":"ERROR","step":57,"op":"batch","fails":[{"oracle":"O1c","sig":"computed-err-mismatch","detail":"node#31 (hash) engine=ERR(computed:31) model=420684"},{"oracle":"O1c","sig":"computed-mismatch","detail":"node#15 (select) engine=93 model=14"}],"scen":["dep-set-flip","multi-write-same-signal","revert-after-mid-read","second-invalidation","throw-dep-computed-prewalk"],"worldScen":["dep-set-flip","recovery-after-throw","diamond-write","equality-cutoff","second-invalidation","multi-write-same-signal","revert-after-mid-read","throw-dep-computed-prewalk"],"worldScenCounts":{"dep-set-flip":15,"recovery-after-throw":2,"diamond-write":1,"equality-cutoff":1,"second-invalidation":12,"multi-write-same-signal":1,"revert-after-mid-read":1,"throw-dep-computed-prewalk":1},"escape":[]};
test('b109 A1 fallback: the engine=ERR( O1c line (census world 0x8992029a) is DIV-F5 under FX and null on the tree; a lookahead registry copy would drop it', () => {
    assert.equal(known(clone(A1_ENGERR), FX()), 'DIV-F5');
    assert.deepEqual(classifyFx(clone(A1_ENGERR)).perFail.map((p) => p.slice()), [['DIV-F5'], ['DIV-F5']]);
    assert.equal(classify(clone(A1_ENGERR)), null, 'the tree: DIV-F5 is fixed');
    assert.equal(classify(clone(A1_ENGERR), { includeFixed: false }), null);
    // must-fail control: the Q1 lookahead detail in a registry copy turns that line into known=none
    const la = fresh();
    const sh = la.entries.find((x) => x.id === 'DIV-F5').shapes.find((x) => x.pair === 'O1c:computed-err-mismatch');
    sh.detail = '^node#\\d+ \\(\\w+\\) engine=(?!ERR\\().* model=.*$';
    assert.equal(classifyFx(clone(A1_ENGERR), { registry: la }), null, 'lookahead copy: the census line is unexplained');
    assert.equal(knownFx(F5errM(), { registry: la }), 'DIV-F5', 'positive control: model-side ERR still matches');
    // the shipped detail is the plain one (no lookahead)
    const shipped = fresh().entries.find((x) => x.id === 'DIV-F5').shapes.find((x) => x.pair === 'O1c:computed-err-mismatch');
    assert.equal(shipped.detail, '^node#\\d+ \\(\\w+\\) engine=.* model=.*$');
});

// b109 A2 (PLAN-A3-soak assertion A2): the 10 TASK 0c live records (ERROR failures on the tree, FIX-R in; evidence
// .handoff/b109-evidence/soak/0c-live.jsonl, inlined verbatim -- they are ~1 KB each, nothing trimmed) are all DIV-F22.
const LIVE_0C = [
    {"engine":"lite","lane":"ERROR","step":391,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:391 x1 did not happen"}],"scen":["throw-in-batch","equality-cutoff","throw-dep-effect-prewalk"],"worldScen":["dep-set-flip","diamond-write","multi-write-same-signal","throw-in-batch","equality-cutoff","throwing-equals","second-invalidation","cycle-error-surfaces","recovery-after-throw","throw-dep-effect-prewalk","revert-after-mid-read","throw-dep-computed-prewalk","adversarial-equality","aggregate"],"worldScenCounts":{"dep-set-flip":251,"diamond-write":85,"multi-write-same-signal":16,"throw-in-batch":19,"equality-cutoff":90,"throwing-equals":18,"second-invalidation":344,"cycle-error-surfaces":5,"recovery-after-throw":120,"throw-dep-effect-prewalk":47,"revert-after-mid-read":1,"throw-dep-computed-prewalk":8,"adversarial-equality":1,"aggregate":4},"escape":[{"origin":"computed","token":"computed:71"}]},
    {"engine":"lite","lane":"ERROR","step":315,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:315 x1 did not happen"}],"scen":["throw-in-batch","dep-set-flip","throw-dep-computed-prewalk","throw-dep-effect-prewalk"],"worldScen":["throw-in-batch","dep-set-flip","recovery-after-throw","throwing-equals","diamond-write","equality-cutoff","second-invalidation","throw-dep-effect-prewalk","adversarial-equality","multi-write-same-signal","revert-after-mid-read","cycle-error-surfaces","throw-dep-computed-prewalk","aggregate"],"worldScenCounts":{"throw-in-batch":18,"dep-set-flip":249,"recovery-after-throw":56,"throwing-equals":20,"diamond-write":66,"equality-cutoff":81,"second-invalidation":90,"throw-dep-effect-prewalk":13,"adversarial-equality":2,"multi-write-same-signal":7,"revert-after-mid-read":1,"cycle-error-surfaces":4,"throw-dep-computed-prewalk":13,"aggregate":1},"escape":[{"origin":"computed","token":"computed:48"}]},
    {"engine":"lite","lane":"ERROR","step":272,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:272 x1 did not happen"}],"scen":["throw-in-batch","throw-dep-computed-prewalk","dep-set-flip","equality-cutoff","throw-dep-effect-prewalk","aggregate"],"worldScen":["throwing-equals","throw-dep-effect-prewalk","second-invalidation","dep-set-flip","recovery-after-throw","multi-write-same-signal","equality-cutoff","throw-in-batch","diamond-write","throw-dep-computed-prewalk","revert-after-mid-read","aggregate"],"worldScenCounts":{"throwing-equals":14,"throw-dep-effect-prewalk":97,"second-invalidation":146,"dep-set-flip":209,"recovery-after-throw":78,"multi-write-same-signal":8,"equality-cutoff":76,"throw-in-batch":11,"diamond-write":71,"throw-dep-computed-prewalk":11,"revert-after-mid-read":1,"aggregate":1},"escape":[{"origin":"computed","token":"computed:14"},{"origin":"computed","token":"computed:14"}]},
    {"engine":"lite","lane":"ERROR","step":389,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:389 x1 did not happen"}],"scen":["throw-in-batch","dep-set-flip","throw-dep-effect-prewalk","equality-cutoff"],"worldScen":["throwing-equals","dep-set-flip","diamond-write","second-invalidation","throw-in-batch","multi-write-same-signal","equality-cutoff","throw-dep-effect-prewalk","recovery-after-throw","cycle-error-surfaces","throw-dep-computed-prewalk","revert-after-mid-read","aggregate"],"worldScenCounts":{"throwing-equals":18,"dep-set-flip":262,"diamond-write":77,"second-invalidation":192,"throw-in-batch":20,"multi-write-same-signal":15,"equality-cutoff":51,"throw-dep-effect-prewalk":41,"recovery-after-throw":63,"cycle-error-surfaces":5,"throw-dep-computed-prewalk":6,"revert-after-mid-read":1,"aggregate":1},"escape":[{"origin":"computed","token":"computed:38"}]},
    {"engine":"lite","lane":"ERROR","step":101,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:101 x1 did not happen"}],"scen":["throw-in-batch","throw-dep-effect-prewalk","dep-set-flip"],"worldScen":["multi-write-same-signal","equality-cutoff","throw-dep-effect-prewalk","dep-set-flip","diamond-write","recovery-after-throw","throwing-equals","second-invalidation","throw-in-batch","revert-after-mid-read","adversarial-equality","throw-dep-computed-prewalk"],"worldScenCounts":{"multi-write-same-signal":3,"equality-cutoff":12,"throw-dep-effect-prewalk":5,"dep-set-flip":43,"diamond-write":8,"recovery-after-throw":7,"throwing-equals":2,"second-invalidation":11,"throw-in-batch":4,"revert-after-mid-read":1,"adversarial-equality":1,"throw-dep-computed-prewalk":1},"escape":[{"origin":"computed","token":"computed:13"}]},
    {"engine":"lite","lane":"ERROR","step":379,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:379 x1 did not happen"}],"scen":["throw-in-batch","dep-set-flip","throw-dep-effect-prewalk","recovery-after-throw"],"worldScen":["throwing-equals","diamond-write","dep-set-flip","second-invalidation","cycle-error-surfaces","aggregate","equality-cutoff","recovery-after-throw","multi-write-same-signal","throw-dep-effect-prewalk","throw-in-batch","adversarial-equality","revert-no-read","revert-after-mid-read","throw-dep-computed-prewalk"],"worldScenCounts":{"throwing-equals":21,"diamond-write":43,"dep-set-flip":230,"second-invalidation":172,"cycle-error-surfaces":5,"aggregate":8,"equality-cutoff":74,"recovery-after-throw":73,"multi-write-same-signal":9,"throw-dep-effect-prewalk":48,"throw-in-batch":15,"adversarial-equality":2,"revert-no-read":1,"revert-after-mid-read":1,"throw-dep-computed-prewalk":3},"escape":[{"origin":"computed","token":"computed:67"}]},
    {"engine":"lite","lane":"ERROR","step":362,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:362 x1 did not happen"}],"scen":["throw-in-batch","equality-cutoff","dep-set-flip","second-invalidation"],"worldScen":["throw-dep-effect-prewalk","second-invalidation","dep-set-flip","diamond-write","recovery-after-throw","throw-in-batch","equality-cutoff","cycle-error-surfaces","throwing-equals","multi-write-same-signal","adversarial-equality","throw-dep-computed-prewalk","revert-after-mid-read"],"worldScenCounts":{"throw-dep-effect-prewalk":76,"second-invalidation":195,"dep-set-flip":250,"diamond-write":77,"recovery-after-throw":84,"throw-in-batch":21,"equality-cutoff":104,"cycle-error-surfaces":3,"throwing-equals":21,"multi-write-same-signal":7,"adversarial-equality":1,"throw-dep-computed-prewalk":5,"revert-after-mid-read":1},"escape":[{"origin":"computed","token":"computed:11"}]},
    {"engine":"lite","lane":"ERROR","step":273,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:273 x1 did not happen"}],"scen":["throw-in-batch","dep-set-flip","throw-dep-effect-prewalk","recovery-after-throw","second-invalidation","throw-dep-computed-prewalk"],"worldScen":["throw-in-batch","second-invalidation","dep-set-flip","diamond-write","throw-dep-effect-prewalk","recovery-after-throw","equality-cutoff","throwing-equals","multi-write-same-signal","revert-after-mid-read","cycle-error-surfaces","aggregate","throw-dep-computed-prewalk","adversarial-equality"],"worldScenCounts":{"throw-in-batch":12,"second-invalidation":79,"dep-set-flip":153,"diamond-write":39,"throw-dep-effect-prewalk":44,"recovery-after-throw":93,"equality-cutoff":34,"throwing-equals":11,"multi-write-same-signal":5,"revert-after-mid-read":1,"cycle-error-surfaces":2,"aggregate":2,"throw-dep-computed-prewalk":26,"adversarial-equality":2},"escape":[{"origin":"computed","token":"computed:11"}]},
    {"engine":"lite","lane":"ERROR","step":425,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:425 x1 did not happen"}],"scen":["throw-in-batch","dep-set-flip","recovery-after-throw","throw-dep-effect-prewalk"],"worldScen":["dep-set-flip","diamond-write","second-invalidation","equality-cutoff","throw-in-batch","throwing-equals","multi-write-same-signal","revert-after-mid-read","throw-dep-effect-prewalk","recovery-after-throw","adversarial-equality","cycle-error-surfaces","throw-dep-computed-prewalk"],"worldScenCounts":{"dep-set-flip":215,"diamond-write":105,"second-invalidation":228,"equality-cutoff":82,"throw-in-batch":20,"throwing-equals":16,"multi-write-same-signal":6,"revert-after-mid-read":1,"throw-dep-effect-prewalk":28,"recovery-after-throw":66,"adversarial-equality":2,"cycle-error-surfaces":4,"throw-dep-computed-prewalk":2},"escape":[{"origin":"computed","token":"computed:111"}]},
    {"engine":"lite","lane":"ERROR","step":392,"op":"batch","fails":[{"oracle":"O6","sig":"expected-escape-missing","detail":"predicted escape batch:392 x1 did not happen"}],"scen":["equality-cutoff","throw-in-batch","second-invalidation"],"worldScen":["dep-set-flip","recovery-after-throw","diamond-write","throwing-equals","multi-write-same-signal","equality-cutoff","throw-dep-effect-prewalk","throw-in-batch","second-invalidation","cycle-error-surfaces","revert-after-mid-read","aggregate","throw-dep-computed-prewalk","adversarial-equality"],"worldScenCounts":{"dep-set-flip":391,"recovery-after-throw":97,"diamond-write":73,"throwing-equals":19,"multi-write-same-signal":6,"equality-cutoff":103,"throw-dep-effect-prewalk":42,"throw-in-batch":16,"second-invalidation":237,"cycle-error-surfaces":2,"revert-after-mid-read":1,"aggregate":3,"throw-dep-computed-prewalk":5,"adversarial-equality":1},"escape":[{"origin":"computed","token":"computed:46"}]},
];
test('b109 A2: the 10 TASK 0c live ERROR records are DIV-F22 on the tree (includeFixed false); no DIV-F22 -> known=none', () => {
    assert.equal(LIVE_0C.length, 10);
    for (let k = 0; k < LIVE_0C.length; k++) {
        const c = classify(clone(LIVE_0C[k]), { includeFixed: false });
        assert.notEqual(c, null, 'record ' + k);
        assert.equal(c.known, 'DIV-F22', 'record ' + k);
        assert.deepEqual(c.perFail.map((p) => p.slice()), c.perFail.map(() => ['DIV-F22']), 'record ' + k + ' perFail');
    }
    const noF22 = fresh(); noF22.entries = noF22.entries.filter((x) => x.id !== 'DIV-F22');
    for (let k = 0; k < LIVE_0C.length; k++) assert.equal(classify(clone(LIVE_0C[k]), { includeFixed: false, registry: noF22 }), null, 'control ' + k);
});

// b109 A3 pair: the pre-fix 0c records (FIX-R not in: the F5 bug present) are unexplained on the tree (a regression) and
// DIV-F5 on a control kernel (inlined verbatim from .handoff/b109-evidence/soak/0c-before.jsonl).
const BEFORE_0C = [
    {"engine":"lite","lane":"ERROR","step":139,"op":"batch","fails":[{"oracle":"O2","sig":"glitch","detail":"body#20 read #10 engine=103 model=121"},{"oracle":"O1c","sig":"computed-mismatch","detail":"node#20 (identity) engine=103 model=121"},{"oracle":"O1e","sig":"effect-stale","detail":"effect#31 saw [#20=103,#18=66,#21=309349] model [#20=121,#18=66,#21=326647]"}],"scen":["multi-write-same-signal","revert-after-mid-read","throw-in-batch","dep-set-flip","equality-cutoff","second-invalidation"],"worldScen":["dep-set-flip","diamond-write","multi-write-same-signal","throw-in-batch","equality-cutoff","throwing-equals","second-invalidation","cycle-error-surfaces","recovery-after-throw","throw-dep-effect-prewalk","revert-after-mid-read"],"worldScenCounts":{"dep-set-flip":34,"diamond-write":20,"multi-write-same-signal":9,"throw-in-batch":8,"equality-cutoff":27,"throwing-equals":10,"second-invalidation":60,"cycle-error-surfaces":2,"recovery-after-throw":16,"throw-dep-effect-prewalk":6,"revert-after-mid-read":1},"escape":[{"origin":"batch","token":"batch:139"}]},
    {"engine":"lite","lane":"ERROR","step":101,"op":"batch","fails":[{"oracle":"O2","sig":"glitch","detail":"body#24 read #18 engine=Infinity model=-1"},{"oracle":"O1e","sig":"effect-stale","detail":"effect#24 saw [#11=#refA,#21=Infinity,#18=Infinity] model [#11=#refA,#21=Infinity,#18=-1]"},{"oracle":"O1c","sig":"computed-mismatch","detail":"node#18 (select) engine=Infinity model=-1"}],"scen":["dep-set-flip","multi-write-same-signal","revert-after-mid-read","throw-in-batch","equality-cutoff"],"worldScen":["throw-in-batch","dep-set-flip","recovery-after-throw","throwing-equals","diamond-write","equality-cutoff","second-invalidation","throw-dep-effect-prewalk","adversarial-equality","multi-write-same-signal","revert-after-mid-read"],"worldScenCounts":{"throw-in-batch":6,"dep-set-flip":54,"recovery-after-throw":13,"throwing-equals":1,"diamond-write":17,"equality-cutoff":24,"second-invalidation":18,"throw-dep-effect-prewalk":5,"adversarial-equality":1,"multi-write-same-signal":1,"revert-after-mid-read":1},"escape":[{"origin":"batch","token":"batch:101"}]},
    {"engine":"lite","lane":"ERROR","step":189,"op":"batch","fails":[{"oracle":"O1c","sig":"computed-mismatch","detail":"node#15 (cond) engine=42 model=37"}],"scen":["multi-write-same-signal","revert-after-mid-read","dep-set-flip","equality-cutoff","second-invalidation"],"worldScen":["throwing-equals","throw-dep-effect-prewalk","second-invalidation","dep-set-flip","recovery-after-throw","multi-write-same-signal","equality-cutoff","throw-in-batch","diamond-write","throw-dep-computed-prewalk","revert-after-mid-read"],"worldScenCounts":{"throwing-equals":8,"throw-dep-effect-prewalk":32,"second-invalidation":84,"dep-set-flip":118,"recovery-after-throw":50,"multi-write-same-signal":7,"equality-cutoff":47,"throw-in-batch":5,"diamond-write":42,"throw-dep-computed-prewalk":5,"revert-after-mid-read":1},"escape":[]},
    {"engine":"lite","lane":"ERROR","step":344,"op":"batch","fails":[{"oracle":"O2","sig":"glitch","detail":"body#38 read #21 engine=46 model=false"},{"oracle":"O1e","sig":"effect-stale","detail":"effect#73 saw [#51=ERR(computed:38),#18=6,#46=65] model [#51=299,#18=6,#46=65]"}],"scen":["dep-set-flip","multi-write-same-signal","revert-after-mid-read","equality-cutoff","throw-dep-effect-prewalk"],"worldScen":["throwing-equals","dep-set-flip","diamond-write","second-invalidation","throw-in-batch","multi-write-same-signal","equality-cutoff","throw-dep-effect-prewalk","recovery-after-throw","cycle-error-surfaces","throw-dep-computed-prewalk","revert-after-mid-read"],"worldScenCounts":{"throwing-equals":17,"dep-set-flip":199,"diamond-write":63,"second-invalidation":154,"throw-in-batch":18,"multi-write-same-signal":13,"equality-cutoff":42,"throw-dep-effect-prewalk":22,"recovery-after-throw":38,"cycle-error-surfaces":4,"throw-dep-computed-prewalk":3,"revert-after-mid-read":1},"escape":[]},
    {"engine":"lite","lane":"ERROR","step":86,"op":"batch","fails":[{"oracle":"O2","sig":"glitch","detail":"body#29 read #18 engine=true model=undefined"},{"oracle":"O1e","sig":"effect-stale","detail":"effect#29 saw [#18=true] model [#18=undefined]"},{"oracle":"O1c","sig":"computed-mismatch","detail":"node#36 (sum) engine=24 model=23"}],"scen":["multi-write-same-signal","revert-after-mid-read","throw-in-batch","second-invalidation"],"worldScen":["multi-write-same-signal","equality-cutoff","throw-dep-effect-prewalk","dep-set-flip","diamond-write","recovery-after-throw","throwing-equals","second-invalidation","throw-in-batch","revert-after-mid-read"],"worldScenCounts":{"multi-write-same-signal":3,"equality-cutoff":7,"throw-dep-effect-prewalk":3,"dep-set-flip":29,"diamond-write":5,"recovery-after-throw":3,"throwing-equals":2,"second-invalidation":7,"throw-in-batch":3,"revert-after-mid-read":1},"escape":[{"origin":"batch","token":"batch:86"}]},
    {"engine":"lite","lane":"ERROR","step":153,"op":"set","fails":[{"oracle":"O2","sig":"glitch","detail":"body#20 read #16 engine=Infinity model=NaN"},{"oracle":"O1c","sig":"computed-mismatch","detail":"node#16 (identity) engine=Infinity model=NaN"}],"scen":["throw-dep-effect-prewalk","second-invalidation","dep-set-flip"],"worldScen":["throwing-equals","diamond-write","dep-set-flip","second-invalidation","cycle-error-surfaces","aggregate","equality-cutoff","recovery-after-throw","multi-write-same-signal","throw-dep-effect-prewalk","throw-in-batch","adversarial-equality","revert-no-read","revert-after-mid-read"],"worldScenCounts":{"throwing-equals":7,"diamond-write":11,"dep-set-flip":41,"second-invalidation":51,"cycle-error-surfaces":3,"aggregate":6,"equality-cutoff":7,"recovery-after-throw":10,"multi-write-same-signal":6,"throw-dep-effect-prewalk":5,"throw-in-batch":5,"adversarial-equality":1,"revert-no-read":1,"revert-after-mid-read":1}},
    {"engine":"lite","lane":"ERROR","step":356,"op":"batch","fails":[{"oracle":"O2","sig":"glitch","detail":"body#41 read #12 engine=72 model=76"},{"oracle":"O1e","sig":"effect-stale","detail":"effect#41 saw [#12=72,#32=230] model [#12=76,#32=230]"},{"oracle":"O1c","sig":"computed-mismatch","detail":"node#12 (sum) engine=72 model=76"}],"scen":["multi-write-same-signal","revert-after-mid-read","second-invalidation"],"worldScen":["throw-dep-effect-prewalk","second-invalidation","dep-set-flip","diamond-write","recovery-after-throw","throw-in-batch","equality-cutoff","cycle-error-surfaces","throwing-equals","multi-write-same-signal","adversarial-equality","throw-dep-computed-prewalk","revert-after-mid-read"],"worldScenCounts":{"throw-dep-effect-prewalk":71,"second-invalidation":182,"dep-set-flip":231,"diamond-write":77,"recovery-after-throw":75,"throw-in-batch":20,"equality-cutoff":94,"cycle-error-surfaces":3,"throwing-equals":20,"multi-write-same-signal":7,"adversarial-equality":1,"throw-dep-computed-prewalk":5,"revert-after-mid-read":1},"escape":[]},
    {"engine":"lite","lane":"ERROR","step":80,"op":"batch","fails":[{"oracle":"O1c","sig":"computed-mismatch","detail":"node#29 (sum) engine=141 model=76"},{"oracle":"O2","sig":"glitch","detail":"body#19 read #14 engine=65 model=\"0\""}],"scen":["multi-write-same-signal","revert-after-mid-read","second-invalidation"],"worldScen":["throw-in-batch","second-invalidation","dep-set-flip","diamond-write","throw-dep-effect-prewalk","recovery-after-throw","equality-cutoff","throwing-equals","multi-write-same-signal","revert-after-mid-read"],"worldScenCounts":{"throw-in-batch":5,"second-invalidation":6,"dep-set-flip":18,"diamond-write":7,"throw-dep-effect-prewalk":8,"recovery-after-throw":6,"equality-cutoff":4,"throwing-equals":2,"multi-write-same-signal":2,"revert-after-mid-read":1},"escape":[]},
    {"engine":"lite","lane":"ERROR","step":100,"op":"batch","fails":[{"oracle":"O2","sig":"glitch","detail":"body#24 read #13 engine=8866 model=8773"},{"oracle":"O1e","sig":"effect-stale","detail":"effect#24 saw [#15=-1,#13=8866,#19=90] model [#15=-1,#13=8773,#19=90]"},{"oracle":"O1c","sig":"computed-mismatch","detail":"node#13 (hash) engine=8866 model=8773"}],"scen":["multi-write-same-signal","revert-after-mid-read"],"worldScen":["dep-set-flip","diamond-write","second-invalidation","equality-cutoff","throw-in-batch","throwing-equals","multi-write-same-signal","revert-after-mid-read"],"worldScenCounts":{"dep-set-flip":16,"diamond-write":3,"second-invalidation":20,"equality-cutoff":3,"throw-in-batch":1,"throwing-equals":1,"multi-write-same-signal":2,"revert-after-mid-read":1},"escape":[]},
    {"engine":"lite","lane":"ERROR","step":182,"op":"batch","fails":[{"oracle":"O2","sig":"glitch","detail":"body#17 read #14 engine=226257 model=210881"},{"oracle":"O1e","sig":"effect-stale","detail":"effect#24 saw [#17=226349] model [#17=210973]"},{"oracle":"O1c","sig":"computed-mismatch","detail":"node#37 (sum) engine=226368 model=210992"}],"scen":["multi-write-same-signal","revert-after-mid-read","second-invalidation","dep-set-flip"],"worldScen":["dep-set-flip","recovery-after-throw","diamond-write","throwing-equals","multi-write-same-signal","equality-cutoff","throw-dep-effect-prewalk","throw-in-batch","second-invalidation","cycle-error-surfaces","revert-after-mid-read"],"worldScenCounts":{"dep-set-flip":92,"recovery-after-throw":15,"diamond-write":21,"throwing-equals":10,"multi-write-same-signal":5,"equality-cutoff":29,"throw-dep-effect-prewalk":8,"throw-in-batch":6,"second-invalidation":48,"cycle-error-surfaces":1,"revert-after-mid-read":1},"escape":[]},
];
test('b109 A3: the pre-fix 0c records classify null on the tree and DIV-F5 on a control kernel', () => {
    assert.equal(BEFORE_0C.length, 10);
    for (let k = 0; k < BEFORE_0C.length; k++) {
        assert.equal(classify(clone(BEFORE_0C[k])), null, 'tree ' + k);
        assert.equal(known(clone(BEFORE_0C[k]), FX()), 'DIV-F5', 'control kernel ' + k);
    }
});
