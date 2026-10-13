/**
 * test/45 -- the soak TEETH meta-test (SPEC-B v2 section 9 "Meta-test" items 1-7; S1cd TASK 10; addendum 9(a)/(b)).
 *
 * Imports the registry (bench/soak/teeth.mjs: CHECKS, GAPS, UNREACHABLE, TEST_ANCHORS, audit), the battery
 * (bench/soak/_mustfail.mjs: CONTROLS, CONTROL_NAMES, validSpec, staleAnchors, patch, LONG_RE, SHORT_RE) and the
 * protocol vocabulary (gates.mjs GATES, oracleFamily, INCONCLUSIVE_CAUSES; oracles.mjs SIGS); it copies none of
 * them (addendum 9a). The literals here are the shrink-only ones (meta item 6): the GAPS names and their count,
 * the universe ids GAPS cover, and the CHECKS id floor. A landing control deletes its GAP AND edits them; a new
 * GAP, an id moved from CHECKS into a GAP's covers, or a dropped CHECKS id fails here.
 *
 * Fast and deterministic: no child process, no kernel run. The mutants run on doctored COPIES of the registry
 * inputs (audit() takes universe / gates / checks / gaps / unreachable / testAnchors overrides); the real kernel
 * files are only read. Each mutant expects one specific problem string, so a check that stops firing goes red.
 *
 * Pairing (the orchestrator's B7 review check, made a test): EVERY control a CHECKS id maps to expects the
 * protocol text that id would print. oracle:<o> / sig:<o>:<s> -> a BREACH spec `oracle=<oracleFamily(o)>` (+ the
 * sig; a renamed family is told apart by the oracle's own SIGS[o]); lane:<L> -> a BREACH spec `lane=<L>`; a fail
 * gate -> `oracle=` (gate oracle) or `gate=<id>` (main.mjs BREACH gate line); the wrap gate -> a BREACH spec
 * `gate=wrap` (wrap.mjs BREACH line); an evidence gate and cause:<c> -> an INCONCLUSIVE spec or line starting with
 * the cause's static text (INCONCLUSIVE_CAUSES, rendered), or a test file whose TEST_ANCHORS list the cause; config
 * -> a cfg control expecting exit 2 and a `soak: CONFIG -- ` line; report -> a test file with TEST_ANCHORS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { universe, CHECKS, GAPS, UNREACHABLE, TEST_ANCHORS, audit, controlMatches } from '../bench/soak/teeth.mjs';
import { CONTROLS, CONTROL_NAMES, validSpec, staleAnchors, patch, LONG_RE, SHORT_RE, wrapJudge } from '../bench/soak/_mustfail.mjs';
import { GATES, oracleFamily, INCONCLUSIVE_CAUSES } from '../bench/soak/gates.mjs';
import { SIGS } from '../bench/soak/oracles.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// GAPS may only shrink: never derive these from GAPS. A landing control removes its name here and decrements the max.
const GAPS_CEILING = [
    'P-TREE', 'P-NEST',
    'T-A1', 'T-A2', 'T-A3a', 'T-A3b', 'T-A3c', 'T-A4', 'T-A5a', 'T-A5b', 'T-A6', 'T-A7a', 'T-A7b',
    'T-d8pc-head', 'T-mark', 'P-INTERIM-ERROR-clean',
    'T-OB-lying-adapter', 'T-OB-nested-close', 'totals-e2e',
    'T-O1c-err', 'T-O5-counts', 'T-O6-shape', 'T-no-lane', 'T-post-cycles', 'R-kernel-identity',
];
const GAPS_MAX = 25;
// The universe ids whose only teeth are GAPS (the union of GAPS[].covers), exactly. Moving an id from CHECKS into a
// GAP's covers (a tooth quietly turned into a gap) fails until this literal is edited.
const GAP_COVERED = [
    'oracle:OB', 'sig:OB:batch-early-run', 'gate:totals', 'sig:O1c:computed-err-mismatch',
    'sig:O5:node-count', 'sig:O5:kind-count', 'sig:O5:teardown-residue',
    'sig:O6:equals-mutated', 'sig:O6:escape-empty', 'cause:no-lane', 'cause:post-cycles',
];
// CHECKS holds at least this many ids (31 at burst 10; 34 at burst 27: gate:wrap, cause:wrap-crossing,
// cause:wrap-unmeasured). A dropped id is a lost tooth; raise it when one lands.
const CHECKS_MIN = 34;

const copy = (x) => structuredClone(x);
const live = (over) => audit(Object.assign({ controls: CONTROL_NAMES.slice(), ceiling: GAPS_CEILING.slice(), max: GAPS_MAX }, over || {}));
/** The mutant's problems must include `want` (a problem string, matched exactly, or a RegExp). */
function hasProblem(probs, want) {
    const ok = probs.some((p) => (typeof want === 'string' ? p === want : want.test(p)));
    assert.ok(ok, 'want ' + String(want) + ' in ' + JSON.stringify(probs));
}

/* ---- a. the live registry is consistent --------------------------------------------------------------- */

const coveredBy = (gaps) => [...new Set(Object.keys(gaps).flatMap((g) => gaps[g].covers))].sort();

test('teeth a: audit() on the live registry with CONTROL_NAMES, the literal 25-name GAPS ceiling and max 25 is []', () => {
    assert.equal(GAPS_CEILING.length, GAPS_MAX, 'the literal ceiling and its literal size agree');
    assert.deepEqual(live(), []);
});

test('teeth a: GAPS cover exactly the literal 11 ids; CHECKS holds >= 34 ids (a tooth never quietly becomes a gap)', () => {
    assert.equal(GAP_COVERED.length, 11);
    assert.deepEqual(coveredBy(GAPS), GAP_COVERED.slice().sort());
    assert.ok(Object.keys(CHECKS).length >= CHECKS_MIN, 'CHECKS ids ' + Object.keys(CHECKS).length + ' < ' + CHECKS_MIN);
    // T1: cause:interrupted deleted from CHECKS and appended to GAPS['T-post-cycles'].covers -- audit() stays []
    const c = copy(CHECKS), g = copy(GAPS);
    delete c['cause:interrupted'];
    g['T-post-cycles'].covers.push('cause:interrupted');
    assert.deepEqual(live({ checks: c, gaps: g }), [], 'audit() alone cannot see T1 (why the literals exist)');
    assert.notDeepEqual(coveredBy(g), GAP_COVERED.slice().sort());
    assert.ok(Object.keys(c).length < CHECKS_MIN);
});

/* ---- b. audit() must-fail controls on doctored copies --------------------------------------------------- */

test('teeth b: an unknown gate id in the universe is uncovered; a CHECKS id outside the universe is drift', () => {
    hasProblem(live({ universe: universe().concat(['gate:fake']) }), 'uncovered: gate:fake has no CHECKS control, no GAP and no UNREACHABLE proof');
    const c = copy(CHECKS);
    c['oracle:O99'] = ['L-REV-152'];
    hasProblem(live({ checks: c }), 'CHECKS id oracle:O99 is not in the universe (drifted from the code)');
});

test('teeth b: a GAP that covers a CHECKS id is stale; a GAP named as a CHECKS control is stale', () => {
    const g = copy(GAPS);
    g['T-mark'].covers = ['gate:heap'];
    hasProblem(live({ gaps: g }), 'stale GAP: T-mark covers gate:heap, which has CHECKS');
    const c = copy(CHECKS);
    c['gate:heap'] = ['L-T-leak', 'T-mark'];
    hasProblem(live({ checks: c }), 'stale GAP: T-mark is a CHECKS control');
});

test('teeth b: GAPS may only shrink -- a GAP outside the ceiling, a ceiling naming a deleted GAP, a stale max', () => {
    // a new GAP (or one missing from the ceiling)
    const grown = copy(GAPS);
    grown['T-new'] = { why: 'x', until: 'y', covers: [] };
    const pg = live({ gaps: grown });
    hasProblem(pg, 'GAP T-new is not in the ceiling (GAPS may only shrink)');
    hasProblem(pg, 'GAPS holds 26 entries > max 25 (GAPS may only shrink)');
    hasProblem(live({ ceiling: GAPS_CEILING.filter((n) => n !== 'T-mark'), max: 24 }), 'GAP T-mark is not in the ceiling (GAPS may only shrink)');
    // the ceiling with an extra name
    hasProblem(live({ ceiling: GAPS_CEILING.concat(['T-gone']) }), 'ceiling lists T-gone, which is no GAP any more: shrink the ceiling literal');
    // a deleted GAP without shrinking the literals
    const shrunk = copy(GAPS);
    delete shrunk['P-TREE'];
    const ps = live({ gaps: shrunk });
    hasProblem(ps, 'ceiling lists P-TREE, which is no GAP any more: shrink the ceiling literal');
    hasProblem(ps, 'GAPS holds 24 entries < max 25: decrement the max literal');
    hasProblem(live({ ceiling: GAPS_CEILING.concat(['P-TREE']) }), 'ceiling lists a GAP twice');
});

test('teeth b: max must be the exact safe-integer GAPS size; NaN, a string and missing are problems, never a skip', () => {
    hasProblem(live({ max: NaN }), 'max must be a safe integer (the literal GAPS size), got NaN');
    hasProblem(live({ max: '25' }), 'max must be a safe integer (the literal GAPS size), got 25');
    hasProblem(live({ max: undefined }), 'max must be a safe integer (the literal GAPS size), got undefined');
    hasProblem(live({ max: 26 }), 'GAPS holds 25 entries < max 26: decrement the max literal');
    hasProblem(live({ max: 24 }), 'GAPS holds 25 entries > max 24 (GAPS may only shrink)');
    hasProblem(live({ ceiling: undefined }), 'ceiling must be the literal array of GAPS names (GAPS may only shrink), got undefined');
});

test('teeth b: controls missing, not an array or empty is a problem; audit() never defaults it', () => {
    const want = /^controls must be a non-empty array of control names \(the _mustfail CONTROL_NAMES\), got /;
    hasProblem(live({ controls: undefined }), want);
    hasProblem(live({ controls: 'L-REV-152' }), want);
    hasProblem(live({ controls: [] }), want);
    hasProblem(live({ controls: [1, 2] }), want);
    hasProblem(audit({ ceiling: GAPS_CEILING, max: GAPS_MAX }), want);
});

test('teeth b: a CHECKS control that is no _mustfail control is unknown; a pattern that matches nothing is unknown', () => {
    const c = copy(CHECKS);
    c['gate:heap'] = ['L-T-leak', 'L-T-nope'];
    hasProblem(live({ checks: c }), 'unknown control L-T-nope');
    const d = copy(CHECKS);
    d['config'] = ['T-cfgx-*'];
    hasProblem(live({ checks: d }), 'unknown control T-cfgx-* (the pattern matches no control)');
    hasProblem(live({ controls: CONTROL_NAMES.filter((n) => n !== 'T-sever') }), 'unknown control T-sever');
});

test('teeth b: T-cfg-* with 15 of the 16 config controls fails the family floor; a family member CHECKS skips is unresolved', () => {
    const cfg = CONTROL_NAMES.filter((n) => n.indexOf('T-cfg-') === 0);
    assert.equal(cfg.length, 16, 'T-cfg x16 (SPEC-B 9)');
    hasProblem(live({ controls: CONTROL_NAMES.filter((n) => n !== cfg[0]) }), 'control family T-cfg-* holds 15 controls < 16');
    const c = copy(CHECKS);
    c['config'] = cfg.slice(1);
    hasProblem(live({ checks: c }), 'control ' + cfg[0] + ' is not resolved by CHECKS config');
});

/* ---- c. every gate's declared teeth is a CHECKS control of that gate ------------------------------------- */

test('teeth c: every non-null GATES[].teeth is in CHECKS gate:<id>; a gate with ghost teeth fails audit()', () => {
    let n = 0;
    for (const g of GATES) {
        if (g.teeth === null) continue;
        n++;
        assert.ok(Array.isArray(CHECKS['gate:' + g.id]) && CHECKS['gate:' + g.id].includes(g.teeth), 'gate ' + g.id + ' teeth ' + g.teeth);
        assert.ok(CONTROL_NAMES.includes(g.teeth), 'gate ' + g.id + ' teeth ' + g.teeth + ' is a _mustfail control');
    }
    assert.ok(n >= 4, 'gates with teeth: ' + n);
    const gates = GATES.map((g) => Object.assign({}, g, g.id === 'heap' ? { teeth: 'L-T-ghost' } : {}));
    hasProblem(live({ gates }), 'gate heap teeth L-T-ghost is missing from CHECKS gate:heap');
});

/* ---- d. the nightly partition ------------------------------------------------------------------------- */

test('teeth d: SHORT_RE ^(?!L-) and LONG_RE ^L- partition CONTROL_NAMES exactly; both batteries are non-empty', () => {
    assert.equal(String(LONG_RE), '/^L-/');
    assert.equal(String(SHORT_RE), '/^(?!L-)/');
    let long = 0, short = 0;
    for (const n of CONTROL_NAMES) {
        const l = LONG_RE.test(n), s = SHORT_RE.test(n);
        assert.ok(l !== s, n + ' must match exactly one of LONG_RE / SHORT_RE (long ' + l + ', short ' + s + ')');
        if (l) long++; else short++;
    }
    assert.equal(long + short, CONTROL_NAMES.length);
    assert.ok(long > 0 && short > 0, 'long ' + long + ' short ' + short);
    assert.equal(new Set(CONTROL_NAMES).size, CONTROL_NAMES.length, 'control names are unique');
});

/* ---- e. control shapes ---------------------------------------------------------------------------------- */

test('teeth e: validSpec is [] for every control; a malformed copy is not', () => {
    for (const c of CONTROLS) assert.deepEqual(validSpec(c), [], c.name);
    const a = copy(CONTROLS.find((c) => c.name === 'T-sever'));
    delete a.expect.exit;
    assert.ok(validSpec(a).includes('expect.exit'), JSON.stringify(validSpec(a)));
    const b = copy(CONTROLS.find((c) => c.name === 'T-cfg-lanes-typo'));
    b.expect.config = 'CONFIG -- nope';
    assert.ok(validSpec(b).includes('expect.config'), JSON.stringify(validSpec(b)));
    const m = copy(CONTROLS.find((c) => c.name === 'L-REV-152'));
    m.expect.specs = [];
    assert.ok(validSpec(m).includes('a match control needs >= 1 spec'), JSON.stringify(validSpec(m)));
});

/* ---- f. anchors --------------------------------------------------------------------------------------- */

test('teeth f: staleAnchors(CONTROLS) is []; a one-byte anchor mutation is 0 matches, a duplicated anchor 2 matches', () => {
    assert.deepEqual(staleAnchors(CONTROLS), []);
    assert.ok(CONTROLS.some((c) => c.patches.length > 0), 'at least one control patches its kernel');
    const mut = copy(CONTROLS);
    const sever = mut.find((c) => c.name === 'T-sever');
    const a0 = sever.patches[0][0];
    sever.patches[0][0] = a0.replace('severTail', 'severTaiL');   // one byte
    assert.equal(sever.patches[0][0].length, a0.length);
    const s0 = staleAnchors(mut);
    assert.equal(s0.length, 1, JSON.stringify(s0));
    assert.equal(s0[0].name, 'T-sever');
    assert.match(s0[0].error, /^stale anchor: 0 matches: /);
    // the real headpatched base holds two severTail(node) call sites (:1120 and :1218): the short anchor is ambiguous
    const dup = copy(CONTROLS);
    dup.find((c) => c.name === 'T-sever').patches[0][0] = 'severTail(node);\n';
    const s2 = staleAnchors(dup);
    assert.equal(s2.length, 1, JSON.stringify(s2));
    assert.equal(s2[0].name, 'T-sever');
    assert.ok(s2[0].error.includes('2 matches'), s2[0].error);
    // patch() on injected text: once is fine, twice throws
    assert.equal(patch('a XY b', 'XY', 'Z'), 'a Z b');
    assert.throws(() => patch('a XY b' + 'a XY b', 'XY', 'Z'), /stale anchor: 2 matches/);
    assert.throws(() => patch('a b', 'XY', 'Z'), /stale anchor: 0 matches/);
});

/* ---- g. pairing: every control a CHECKS id maps to expects the text that id prints --------------------- */

const INC_PFX = 'soak: INCONCLUSIVE -- ';
const CFG_PFX = 'soak: CONFIG -- ';
const ARG = '@@arg@@';
const anyArgs = new Proxy({}, { get: () => ARG });
/** The static head of a cause's INCONCLUSIVE text: INCONCLUSIVE_CAUSES[c] rendered up to its first argument. */
function causeHead(c) {
    const t = INCONCLUSIVE_CAUSES[c](anyArgs);
    const i = t.indexOf(ARG);
    return i === -1 ? t : t.slice(0, i);
}
// An evidence gate's INCONCLUSIVE cause: its own id when INCONCLUSIVE_CAUSES has it, else the one below (judge code,
// gates.mjs LaneGates: coverage.missing -> 'scenario'). An evidence gate resolving to no cause is a problem.
const EVIDENCE_CAUSE = Object.freeze({ coverage: 'scenario' });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const sigOk = (tok, sig) => (sig.endsWith('*') ? tok.indexOf('sig=' + sig.slice(0, -1)) === 0 : tok === 'sig=' + sig);
/** BREACH specs of a control (a spec with no leading kind word is BREACH), as token arrays. */
const breachSpecs = (c) => c.expect.specs.map((s) => s.split(' ').filter((t) => t.length > 0)).filter((t) => t[0] !== 'INCONCLUSIVE' && t.length > 0).map((t) => (t[0] === 'BREACH' ? t.slice(1) : t));
/** INCONCLUSIVE texts a control expects (specs minus the kind word, lines minus the prefix). */
const incTexts = (c) => c.expect.specs.filter((s) => s.indexOf('INCONCLUSIVE ') === 0).map((s) => s.slice('INCONCLUSIVE '.length))
    .concat(c.expect.lines.filter((l) => l.indexOf(INC_PFX) === 0).map((l) => l.slice(INC_PFX.length)));
const incOk = (c, cause) => own(INCONCLUSIVE_CAUSES, cause) && incTexts(c).some((t) => t.indexOf(causeHead(cause)) === 0);

/** Why control `c` does not back CHECKS id `id` (null = it does). */
function unbacked(id, c, gates) {
    const parts = id.split(':');
    const kind = parts[0];
    if (kind === 'oracle' || kind === 'sig') {
        const o = parts[1];
        let fam;
        try { fam = oracleFamily(o); } catch (e) { return 'oracleFamily throws for ' + o; }
        // a sig id needs its own sig; an oracle whose family name differs from its id needs one of ITS sigs
        const sigs = kind === 'sig' ? [parts.slice(2).join(':')] : (fam !== o ? SIGS[o] : null);
        const ok = breachSpecs(c).some((t) => t.includes('oracle=' + fam) && (sigs === null || t.some((x) => sigs.some((s) => sigOk(x, s)))));
        return ok ? null : 'no BREACH spec naming oracle=' + fam + (sigs === null ? '' : ' with sig in ' + sigs.join('|'));
    }
    if (kind === 'lane') return breachSpecs(c).some((t) => t.includes('lane=' + parts[1])) ? null : 'no BREACH spec naming lane=' + parts[1];
    if (kind === 'gate') {
        const g = gates.find((x) => x.id === parts[1]);
        if (g === undefined) return 'no gate ' + parts[1];
        if (g.kind === 'fail') {
            const want = g.id === 'oracle' ? (t) => t.some((x) => x.indexOf('oracle=') === 0) : (t) => t.includes('gate=' + g.id);
            return breachSpecs(c).some(want) ? null : 'no BREACH spec naming ' + (g.id === 'oracle' ? 'an oracle=' : 'gate=' + g.id);
        }
        if (g.kind === 'evidence') {
            const cause = own(INCONCLUSIVE_CAUSES, g.id) ? g.id : EVIDENCE_CAUSE[g.id];
            if (cause === undefined) return 'evidence gate ' + g.id + ' resolves to no INCONCLUSIVE cause';
            return incOk(c, cause) ? null : 'no INCONCLUSIVE text starting ' + JSON.stringify(causeHead(cause));
        }
        // the wrap gate: wrap.mjs prints `soak: BREACH gate=wrap check=<W> counter=<c> ...`
        if (g.kind === 'wrap') return breachSpecs(c).some((t) => t.includes('gate=' + g.id)) ? null : 'no BREACH spec naming gate=' + g.id;
        return 'no pairing rule for a ' + g.kind + ' gate';
    }
    if (kind === 'cause') {
        if (!own(INCONCLUSIVE_CAUSES, parts[1])) return 'no INCONCLUSIVE cause ' + parts[1];
        return incOk(c, parts[1]) ? null : 'no INCONCLUSIVE text starting ' + JSON.stringify(causeHead(parts[1]));
    }
    if (id === 'config') {
        const e = c.expect;
        return c.run === 'cfg' && e.exit === 2 && typeof e.config === 'string' && e.config.indexOf(CFG_PFX) === 0 && e.config.length > CFG_PFX.length
            ? null : 'not a cfg control expecting exit 2 and a ' + JSON.stringify(CFG_PFX) + ' line';
    }
    return 'no pairing rule for id ' + id;
}

/** The pairing problems of `checks` against `controls` ([] = every mapped control backs its id). */
function pairing(checks, controls, gates) {
    const G = gates === undefined ? GATES : gates;
    const names = controls.map((c) => c.name);
    const probs = [];
    for (const id of Object.keys(checks)) {
        if (id === 'report') {
            for (const n of checks[id]) if (!(n.indexOf('test/') === 0 && own(TEST_ANCHORS, n))) probs.push('report: ' + n + ' is no test file with TEST_ANCHORS');
            continue;
        }
        for (const name of checks[id]) {
            if (name.indexOf('test/') === 0) {
                // a test file backs only a cause, and only when its TEST_ANCHORS list that cause by name (teeth h
                // then proves the file quotes it)
                const cause = id.indexOf('cause:') === 0 ? id.slice('cause:'.length) : null;
                if (cause === null) probs.push(id + ': ' + name + ' -- a test file backs only report and cause ids');
                else if (!(own(TEST_ANCHORS, name) && TEST_ANCHORS[name].includes(cause))) probs.push(id + ': ' + name + ' -- TEST_ANCHORS of ' + name + ' never lists ' + cause);
                continue;
            }
            const hits = controlMatches(name, names);
            if (hits.length === 0) { probs.push(id + ': ' + name + ' matches no control'); continue; }
            for (const cn of hits) {
                const why = unbacked(id, controls.find((x) => x.name === cn), G);
                if (why !== null) probs.push(id + ': ' + cn + ' -- ' + why);
            }
        }
    }
    return probs;
}

test('teeth g: every control each CHECKS id maps to expects that id\'s protocol text (all id kinds)', () => {
    assert.deepEqual(pairing(CHECKS, CONTROLS), []);
    const kinds = new Set(Object.keys(CHECKS).map((k) => k.split(':')[0]));
    assert.deepEqual([...kinds].sort(), ['cause', 'config', 'gate', 'lane', 'oracle', 'report', 'sig']);
    // the derived heads (by import, never copied) are the ones the battery specs use
    assert.equal(causeHead('scenario'), 'scenario lane=');
    assert.equal(causeHead('check-floor'), 'checks lane=');
    assert.equal(causeHead('taint-skip'), 'taint-skip lane=');
    assert.equal(causeHead('interrupted'), 'run interrupted before its end');
    for (const g of GATES) if (g.kind === 'evidence') assert.ok(own(INCONCLUSIVE_CAUSES, own(INCONCLUSIVE_CAUSES, g.id) ? g.id : EVIDENCE_CAUSE[g.id]), 'evidence gate ' + g.id + ' has a cause');
});

test('teeth g: must-fail -- oracle / sig / lane / gate / cause / config remaps to a control that prints something else', () => {
    const remap = (over) => Object.assign(copy(CHECKS), over);
    assert.deepEqual(pairing(remap({ 'oracle:O2': ['T-sever'] }), CONTROLS), ['oracle:O2: T-sever -- no BREACH spec naming oracle=O2']);
    assert.deepEqual(pairing(remap({ 'sig:O6:escape-*': ['T-sever'] }), CONTROLS), ['sig:O6:escape-*: T-sever -- no BREACH spec naming oracle=O6 with sig in escape-*']);
    // T2
    assert.deepEqual(pairing(remap({ 'gate:check-floor': ['L-REV-152'] }), CONTROLS), ['gate:check-floor: L-REV-152 -- no INCONCLUSIVE text starting "checks lane="']);
    // T3
    assert.deepEqual(pairing(remap({ 'lane:BATCH': ['T-sever'], 'cause:scenario': ['L-I1'] }), CONTROLS),
        ['lane:BATCH: T-sever -- no BREACH spec naming lane=BATCH', 'cause:scenario: L-I1 -- no INCONCLUSIVE text starting "scenario lane="']);
    assert.deepEqual(pairing(remap({ 'gate:heap': ['L-T-retain'] }), CONTROLS), ['gate:heap: L-T-retain -- no BREACH spec naming gate=heap']);
    assert.deepEqual(pairing(remap({ 'gate:oracle': ['L-T-leak'] }), CONTROLS), ['gate:oracle: L-T-leak -- no BREACH spec naming an oracle=']);
    assert.deepEqual(pairing(remap({ 'cause:interrupted': ['T-floor-BATCH'] }), CONTROLS), ['cause:interrupted: T-floor-BATCH -- no INCONCLUSIVE text starting "run interrupted before its end"']);
    assert.deepEqual(pairing(remap({ 'config': ['T-cfg-*', 'T-sever'] }), CONTROLS), ['config: T-sever -- not a cfg control expecting exit 2 and a "soak: CONFIG -- " line']);
    assert.deepEqual(pairing(remap({ 'report': ['L-REV-152'] }), CONTROLS), ['report: L-REV-152 is no test file with TEST_ANCHORS']);
    assert.deepEqual(pairing(remap({ 'gate:totals': ['T-sever'] }), CONTROLS), ['gate:totals: T-sever -- no pairing rule for a startup gate']);
    // a control that lost its spec / an evidence gate with no cause
    const ctl = copy(CONTROLS);
    const rev = ctl.find((x) => x.name === 'L-REV-152');
    rev.expect.specs = rev.expect.specs.filter((s) => s.indexOf('sig=effect-stale') === -1);
    assert.deepEqual(pairing(CHECKS, ctl), ['oracle:O1e: L-REV-152 -- no BREACH spec naming oracle=O1 with sig in effect-stale',
        'sig:O1e:effect-stale: L-REV-152 -- no BREACH spec naming oracle=O1 with sig in effect-stale']);
    assert.deepEqual(pairing(remap({ 'gate:fake': ['T-sever'] }), CONTROLS), ['gate:fake: T-sever -- no gate fake']);
    const gates = GATES.concat([{ id: 'novel', kind: 'evidence', teeth: null }]);
    assert.deepEqual(pairing(remap({ 'gate:novel': ['T-cov-BATCH'] }), CONTROLS, gates), ['gate:novel: T-cov-BATCH -- evidence gate novel resolves to no INCONCLUSIVE cause']);
    // the wrap gate: a control with no `gate=wrap` BREACH spec does not back it (one rule, kind 'wrap')
    assert.deepEqual(pairing(remap({ 'gate:wrap': ['L-WRAP-TREE', 'T-sever'] }), CONTROLS), ['gate:wrap: T-sever -- no BREACH spec naming gate=wrap']);
    const wctl = copy(CONTROLS);
    wctl.find((x) => x.name === 'L-REV-AUDIT-W5').expect.specs = ['oracle=O1 lane=GRAPH'];
    assert.deepEqual(pairing(CHECKS, wctl), ['gate:wrap: L-REV-AUDIT-W5 -- no BREACH spec naming gate=wrap']);
    // a cause backed by a test file: that file's TEST_ANCHORS must list the cause; a test file never backs a gate
    assert.deepEqual(pairing(remap({ 'cause:wrap-crossing': ['test/46-soak-report.test.mjs'] }), CONTROLS),
        ['cause:wrap-crossing: test/46-soak-report.test.mjs -- TEST_ANCHORS of test/46-soak-report.test.mjs never lists wrap-crossing']);
    assert.deepEqual(pairing(remap({ 'gate:heap': ['test/48-soak-wrap.test.mjs'] }), CONTROLS),
        ['gate:heap: test/48-soak-wrap.test.mjs -- a test file backs only report and cause ids']);
});

/* ---- h. test-file teeth ------------------------------------------------------------------------------- */

test('teeth h: every TEST_ANCHORS string occurs quoted in its test file; a missing class is a stale anchor', () => {
    for (const file of Object.keys(TEST_ANCHORS)) {
        const text = readFileSync(join(ROOT, file), 'utf8');
        for (const a of TEST_ANCHORS[file]) assert.ok(text.includes("'" + a + "'"), file + " never names '" + a + "'");
    }
    const t = copy(TEST_ANCHORS);
    t['test/46-soak-report.test.mjs'] = t['test/46-soak-report.test.mjs'].concat(['no-such-tamper']);
    hasProblem(live({ testAnchors: t }), "stale anchor: test/46-soak-report.test.mjs never names 'no-such-tamper'");
    const u = copy(TEST_ANCHORS);
    delete u['test/46-soak-report.test.mjs'];
    hasProblem(live({ testAnchors: u }), 'test teeth test/46-soak-report.test.mjs has no TEST_ANCHORS entry');
});

/* ---- i. UNREACHABLE anchors ----------------------------------------------------------------------------- */

test('teeth i: every UNREACHABLE anchor occurs exactly once; a mutated anchor (0) and an ambiguous one (many) are stale', () => {
    for (const id of Object.keys(UNREACHABLE)) {
        const { file, text } = UNREACHABLE[id].anchor;
        assert.equal(readFileSync(join(ROOT, file), 'utf8').split(text).length - 1, 1, id + ' in ' + file);
    }
    const u = copy(UNREACHABLE);
    u['replay-ops-guard'].anchor.text = u['replay-ops-guard'].anchor.text.replace('>= 1', '>= 2');
    hasProblem(live({ unreachable: u }), 'stale anchor: UNREACHABLE replay-ops-guard text occurs 0 times in bench/soak/replay.mjs (want exactly 1)');
    const v = copy(UNREACHABLE);
    v['cause:lane-status'].anchor.text = 'if (';
    hasProblem(live({ unreachable: v }), /^stale anchor: UNREACHABLE cause:lane-status text occurs ([2-9]|\d\d+) times in bench\/soak\/gates\.mjs \(want exactly 1\)$/);
    const w = copy(UNREACHABLE);
    delete w['report-crash'].proof;
    hasProblem(live({ unreachable: w }), 'UNREACHABLE report-crash must be {proof, anchor: {file, text}}');
});

/* ---- j. wrap controls (S2): shape and the wrap judge on forged streams ---------------------------------- */

/** L-WRAP-TREE narrowed to `sel` (default W1), the selection the forged streams below record. */
const WRAP_CTL = (sel) => { const c = copy(CONTROLS.find((x) => x.name === 'L-WRAP-TREE')); c.env.SOAK_WRAP = sel || 'W1'; return c; };
/** A consistent wrap stream (SOAK_WRAP=W1): header, one W1 record that FAILs on its value assertion, summary. */
function wrapStream(over) {
    const recs = [
        { type: 'header', seq: 0, tMs: 0, kind: 'wrap', nearwrap: null, config: { SOAK_WRAP: { value: ['W1'], source: 'env' } } },
        { type: 'wrap', seq: 1, tMs: 1, check: 'W1', counter: 'globalVersion', opsDriven: 2147484648, crossed: true, pre: { bop: null }, post: { bop: null },
            values: { boundary: { trackerSize: 0, trackerDelta: 0, weakAlive: 0 }, failures: ['band-observed'] }, wallMs: 1, status: 'FAIL' },
        { type: 'summary', seq: 2, tMs: 2, reason: 'end', checks: ['W1'], records: 1, breaches: [], inconclusive: [], repr: null, verdict: 'FAIL', exitCode: 1 },
    ];
    if (over) over(recs);
    return recs;
}

test('teeth j: the wrap controls are long, run wrap.mjs with its flag trio and only SOAK_WRAP; validSpec refuses a burn-in shape', () => {
    for (const n of ['L-REV-AUDIT-W5', 'L-WRAP-TREE']) {
        const c = CONTROLS.find((x) => x.name === n);
        assert.ok(c && c.run === 'wrap' && LONG_RE.test(n), n);
        assert.deepEqual(c.flags, ['--expose-gc', '--min-semi-space-size=4', '--max-semi-space-size=4'], n);
        assert.deepEqual(validSpec(c), [], n);
    }
    const a = WRAP_CTL();
    a.flags = ['--expose-gc'];
    assert.ok(validSpec(a).includes('a wrap control runs with flags --expose-gc --min-semi-space-size=4 --max-semi-space-size=4'), JSON.stringify(validSpec(a)));
    const b = WRAP_CTL();
    b.expect.extra = { boundaries: 22 };
    assert.ok(validSpec(b).includes('expect.extra.boundaries is a burn-in cycle-record count; a wrap control checks every wrap boundary itself'), JSON.stringify(validSpec(b)));
    const e = WRAP_CTL();
    e.env = { SOAK_WRAP: 'W1', SOAK_LANES: 'GRAPH' };
    assert.ok(validSpec(e).includes('a wrap control sets exactly one env key, SOAK_WRAP'), JSON.stringify(validSpec(e)));
    const v = WRAP_CTL();
    v.argv = ['--smoke'];
    assert.ok(validSpec(v).includes('a wrap control takes no argv'), JSON.stringify(validSpec(v)));
    const m = WRAP_CTL();
    m.arm = '\n;process.kill(process.pid, "SIGINT");\n';
    assert.ok(validSpec(m).includes('a wrap control has no arm'), JSON.stringify(validSpec(m)));
    const k = WRAP_CTL();
    k.expect.kind = 'explained';
    k.expect.known = ['DIV-F21'];
    assert.ok(validSpec(k).includes('a wrap control is match | nobreach (explained needs oracle BREACH lines)'), JSON.stringify(validSpec(k)));
});

test('teeth j: wrapJudge is [] on a consistent stream; a forged trackerSize 1 / weakAlive null, a lying END, an unexpected INCONCLUSIVE each MISS', () => {
    assert.deepEqual(wrapJudge(WRAP_CTL(), wrapStream(), 'FAIL', []), []);
    // G4: one retained registry at a wrap boundary
    assert.deepEqual(wrapJudge(WRAP_CTL(), wrapStream((r) => { r[1].values.boundary.trackerSize = 1; }), 'FAIL', []),
        ['wrap W1/globalVersion boundary trackerSize=1 weakAlive=0 (want 0 / 0)']);
    assert.deepEqual(wrapJudge(WRAP_CTL(), wrapStream((r) => { r[1].values.boundary.weakAlive = null; }), 'FAIL', []),
        ['wrap W1/globalVersion boundary trackerSize=0 weakAlive=null (want 0 / 0)']);
    assert.deepEqual(wrapJudge(WRAP_CTL(), wrapStream((r) => { delete r[1].values.boundary; }), 'FAIL', []),
        ['wrap W1/globalVersion boundary trackerSize=undefined weakAlive=undefined (want 0 / 0)']);
    // the END line disagrees with wrapRule over the records
    assert.deepEqual(wrapJudge(WRAP_CTL(), wrapStream(), 'PASS', []), ['wrapRule verdict FAIL != END verdict PASS']);
    // an INCONCLUSIVE the control does not expect (stderr, or only in the summary)
    const inc = 'soak: INCONCLUSIVE -- wrap W1 crossing unwitnessed';
    assert.deepEqual(wrapJudge(WRAP_CTL(), wrapStream(), 'FAIL', [inc]), ['unexpected INCONCLUSIVE: ' + inc]);
    assert.deepEqual(wrapJudge(WRAP_CTL(), wrapStream((r) => { r[2].inconclusive = [inc]; }), 'FAIL', []), ['unexpected INCONCLUSIVE: ' + inc]);
    const ok = WRAP_CTL();
    ok.expect.specs = ok.expect.specs.concat(['INCONCLUSIVE wrap W1 crossing unwitnessed']);
    assert.deepEqual(wrapJudge(ok, wrapStream(), 'FAIL', [inc]), []);
    // the stream's own consistency (wraprules.mjs wrapStreamProblems) and the run's end
    const lie = wrapJudge(WRAP_CTL(), wrapStream((r) => { r[2].verdict = 'PASS'; r[2].exitCode = 0; }), 'FAIL', []);
    assert.ok(lie.some((p) => p.indexOf('wrap stream: ') === 0), JSON.stringify(lie));
    assert.ok(wrapJudge(WRAP_CTL(), wrapStream((r) => { r[2].reason = 'signal'; }), 'FAIL', []).includes('wrap summary reason signal != end'));
    assert.ok(wrapJudge(WRAP_CTL(), wrapStream((r) => { r.splice(1, 1); r[1].seq = 1; }), 'INCONCLUSIVE', []).includes('wrap stream: no wrap record'));
});

test('teeth j: the wrap control specs are pinned (MD4: W5 evalCount at bop>=15; W1-W4 each by its counter)', () => {
    const w5 = CONTROLS.find((c) => c.name === 'L-REV-AUDIT-W5');
    assert.deepEqual([w5.base, w5.env, w5.expect.exit, w5.expect.kind, w5.expect.specs, w5.expect.extra],
        ['headpatched', { SOAK_WRAP: 'W5' }, 1, 'match', ['gate=wrap check=W5 counter=evalCount bop>=15'], { verdict: 'FAIL' }]);
    const tree = CONTROLS.find((c) => c.name === 'L-WRAP-TREE');
    assert.deepEqual([tree.base, tree.env, tree.expect.exit, tree.expect.kind, tree.expect.specs],
        ['tree', { SOAK_WRAP: 'W1,W2,W3,W4' }, 1, 'match', ['gate=wrap check=W1 counter=globalVersion', 'gate=wrap check=W2 counter=batchEpoch',
            'gate=wrap check=W3 counter=gen', 'gate=wrap check=W4 counter=nodeSeq']]);
});

test('teeth j: wrapJudge re-derives the INCONCLUSIVE causes from the records (never only what the child printed); the header selection is the control\'s', () => {
    // SOAK_WRAP W1,W4 with no W4 record and nothing printed: wrapRule re-derives `wrap W4 crossing unwitnessed`
    const forged = wrapStream((r) => { r[0].config.SOAK_WRAP.value = ['W1', 'W4']; r[2].checks = ['W1', 'W4']; });
    const line = 'soak: INCONCLUSIVE -- wrap W4 crossing unwitnessed';
    assert.deepEqual(wrapJudge(WRAP_CTL('W1,W4'), forged, 'FAIL', []),
        ['INCONCLUSIVE re-derived by wrapRule but never printed: ' + line, 'unexpected INCONCLUSIVE: ' + line]);
    // printed but not expected: still a MISS; printed and expected: clean
    assert.deepEqual(wrapJudge(WRAP_CTL('W1,W4'), forged, 'FAIL', [line]), ['unexpected INCONCLUSIVE: ' + line]);
    const ok = WRAP_CTL('W1,W4');
    ok.expect.specs = ok.expect.specs.concat(['INCONCLUSIVE wrap W4 crossing unwitnessed']);
    assert.deepEqual(wrapJudge(ok, forged, 'FAIL', [line]), []);
    // the stream ran another selection than the control asked for
    assert.deepEqual(wrapJudge(WRAP_CTL('W1,W2'), wrapStream(), 'FAIL', []), ['header SOAK_WRAP ["W1"] != control SOAK_WRAP ["W1","W2"]']);
});
