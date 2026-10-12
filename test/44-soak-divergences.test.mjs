// 44-soak-divergences.test.mjs -- the soak divergence registry (SPEC-B v2 section 4.4; S1cd task 5, amendments 5, 8).
//
// No kernel is loaded: every record below is a REAL failing-world record captured on the frozen kernels
// (seed 0xC0FFEE; bench/soak/calibration/f21-census.json), fed to classify as data. Each matcher has
// must-fail controls that change ONE thing (lane, world scen, sig, detail, token origin, missing evidence)
// and must classify null, so a broad matcher cannot hide a real regression.
//   1. the shipped registry validates; digest is the file's sha256
//   2. classify: each captured class -> its entry; near-misses -> null
//   3. DIV-F22 attribution: F6 pre-walk token -> F6+F22, effect-body escape -> F22
//   4. fixedIn: a fixed entry explains only with includeFixed (pre-fix control kernels)
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
    // rev152 ERROR 0x5a22a78c@32 and 0x92c29d17@40: fixed by headpatched, root cause unproven -> unclassified
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

test('DIV-F21 and DIV-F22 are temporary engine entries (amendments 5, 8)', () => {
    const by = new Map(fresh().entries.map((e) => [e.id, e]));
    for (const id of ['DIV-F21', 'DIV-F22']) {
        const e = by.get(id);
        assert.equal(e.kind, 'engine');
        assert.deepEqual(e.lanes, ['ERROR']);
        assert.equal(e.fixedIn, null);
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
    const c = classify(rec('F21'));
    assert.equal(c.known, 'DIV-F21');
    assert.equal(c.tag, 'F21');
    const noWorld = rec('F21');
    noWorld.worldScen = without(noWorld.worldScen, 'cycle-error-surfaces');
    assert.equal(classify(noWorld), null);
    assert.equal(classify(rec('F21', { lane: 'BATCH' })), null);
});

test('DIV-F21 near-misses classify null', () => {
    // no EARLIER surface: the only cycle-error-surfaces count is the failing step's own
    assert.equal(classify(rec('F21', { worldScenCounts: { 'cycle-error-surfaces': 1 } })), null);
    // no counts at all: priorScen cannot be proven
    const nc = rec('F21'); delete nc.worldScenCounts;
    assert.equal(classify(nc), null);
    // the step itself did not surface the bomb's CycleError
    assert.equal(classify(rec('F21', { scen: [] })), null);
    // a different CycleError message, a different sig, a different op, a different engine
    const msg = rec('F21'); msg.fails[0].detail = 'engine error escaped: Error: CycleError: flush passes exceeded';
    assert.equal(classify(msg), null);
    const sig = rec('F21'); sig.fails[0].sig = 'escape-TypeError';
    assert.equal(classify(sig), null);
    assert.equal(classify(rec('F21', { op: 'eff' })), null);
    assert.equal(classify(rec('F21', { engine: 'alien' })), null);
    // a second, unexplained fail in the same step makes the world unknown
    const extra = rec('F21'); extra.fails.push({ oracle: 'O5', sig: 'node-count', detail: 'activeNodes engine=9 model=8' });
    assert.equal(classify(extra), null);
});

test('DIV-F6: escape-computed (+ its O4) -> DIV-F6; near-misses -> null', () => {
    assert.equal(known(rec('F6')), 'DIV-F6');
    assert.equal(classify(rec('F6')).tag, 'F6');
    // a different lane, a different token origin in the escape
    assert.equal(classify(rec('F6', { lane: 'NEST' })), null);
    const eq = rec('F6'); eq.fails[0] = { oracle: 'O6', sig: 'escape-equals', detail: 'unpredicted escape equals:8' };
    assert.equal(classify(eq), null);
    const tok = rec('F6'); tok.fails[0].detail = 'unpredicted escape batch:76';
    assert.equal(classify(tok), null);
    // O4 effect-dead is matched only next to the F6 escape
    assert.equal(classify(rec('O4solo')), null);
    assert.equal(classify(rec('CEMsolo')), null);
});

test('DIV-F5: revert-after-mid-read worlds on BATCH and ERROR; near-misses -> null', () => {
    assert.equal(known(rec('F5')), 'DIV-F5');
    assert.equal(known(rec('F5later')), 'DIV-F5');
    assert.equal(known(rec('F5err')), 'DIV-F5');
    const noRevert = rec('F5later'); noRevert.worldScen = without(noRevert.worldScen, 'revert-after-mid-read');
    assert.equal(classify(noRevert), null);
    assert.equal(classify(rec('F5', { lane: 'GRAPH' })), null);
    // computed-err-mismatch needs the revert in the failing step itself
    const cem = rec('F5err'); cem.scen = without(cem.scen, 'revert-after-mid-read');
    assert.equal(classify(cem), null);
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
    const a = classify(rec('F6F22'));
    assert.equal(a.known, 'DIV-F6+DIV-F22');
    assert.equal(a.tag, 'F6+F22');
    assert.deepEqual(a.perFail, [['DIV-F6'], ['DIV-F22'], ['DIV-F6']]);
    const b = classify(rec('F22'));
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
    assert.equal(classify(rec('F6F22', { escape: [{ origin: 'computed', token: 'computed:99' }] })), null);
});

// ---- 4. fixedIn ----------------------------------------------------------------------------------------
test('a fixed entry explains only a pre-fix control kernel (includeFixed)', () => {
    const r = fresh();
    for (const e of r.entries) if (e.id === 'DIV-F21') e.fixedIn = 'A2';
    assert.deepEqual(validate(r), []);
    assert.equal(classify(rec('F21'), { registry: r }), null);
    assert.equal(known(rec('F21'), { registry: r, includeFixed: true }), 'DIV-F21');
    assert.equal(known(rec('F21'), { registry: fresh() }), 'DIV-F21');
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
    assert.equal(classify(rec('F21', { lane: 'NOPE' })), null);
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
    assert.throws(() => classify(rec('F6'), { registry: mutF6('^unpredicted escape computed:\\d+|.*$') }), /invalid/);
    // the shipped shapes are whole-string matchers: a detail with a suffix no longer matches
    const tail = rec('F6'); tail.fails[0].detail = 'unpredicted escape computed:13 and more';
    assert.equal(classify(tail), null);
    // the ^(?:...)$ wrapper itself: a narrow top-level alternation is legitimate, and it must NOT match a
    // detail that merely starts with the first branch (compiled as new RegExp(src) it would -> DIV-F6).
    // The second branch is 'kq7', not 'zz': 'zz' is a probe, so the wrapped form would be rejected.
    const alt = mutF6('^unpredicted escape computed:\\d+|kq7$');
    assert.deepEqual(validate(alt), []);
    assert.equal(classify(tail, { registry: alt }), null);
    assert.equal(known(rec('F6'), { registry: alt }), 'DIV-F6');
    // a structure-free length matcher is caught by the longer probes
    assert.ok(has(validate(mutF6('^.{2,}$')), /structure-free probe/));
    assert.ok(has(validate(mutF6('^[a-z0-9 ]{2,}$')), /structure-free probe/));
});

test('classify options and records are read from OWN data properties only (inherited -> TypeError)', () => {
    const r = fresh();
    for (const e of r.entries) if (e.id === 'DIV-F21') e.fixedIn = 'A2';
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
    assert.equal(classify(r), null, 'control: no own count -> null');
    Object.prototype['cycle-error-surfaces'] = 2;
    let got;
    try { got = classify(rec('F21', { worldScenCounts: {} })); } finally { delete Object.prototype['cycle-error-surfaces']; }
    assert.equal(got, null, 'an inherited count proved priorScen (fail open)');
    assert.equal(known(rec('F21')), 'DIV-F21', 'positive control after cleanup');
});

test('QA boundary DIV-F21 priorScen counts: 1 (own step only), 2, 2^31, 2^53 - 1 vs 0, -0, -1, NaN, 1.5, Infinity, "2", null', () => {
    const k = (c) => known(rec('F21', { worldScenCounts: { 'cycle-error-surfaces': c } }));
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
    assert.equal(known(rec('F21'), {}), 'DIV-F21', 'an empty opts object is the default');
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
    // O4solo's model carries no ERR(computed), so its detail regex rejects it before `with` is consulted.
    // This record keeps the real F6 O4 detail (model ERR(computed:13)) and drops only the escape-computed fail.
    const solo = rec('F6');
    solo.fails = solo.fails.filter((f) => f.oracle === 'O4');
    assert.equal(solo.fails.length, 1);
    assert.equal(classify(solo), null, 'O4 effect-dead was explained without its F6 escape');
    assert.equal(known(rec('F6')), 'DIV-F6', 'positive control');
});
