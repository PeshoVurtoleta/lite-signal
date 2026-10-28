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
import { universe, CHECKS, GAPS, UNREACHABLE, TEST_ANCHORS, NOT_TEETH, audit, controlMatches } from '../bench/soak/teeth.mjs';
import { CONTROLS, CONTROL_NAMES, validSpec, staleAnchors, patch, buildKernel, LONG_RE, SHORT_RE, wrapJudge, BASES, verifyControls, LC_ITER_PATCH } from '../bench/soak/_mustfail.mjs';
import { GATES, oracleFamily, INCONCLUSIVE_CAUSES } from '../bench/soak/gates.mjs';
import { GATE_N, WARMUP_CYCLES, MIN_ACTIVE_CYCLES } from '../bench/soak/config.mjs';
import { SIGS } from '../bench/soak/oracles.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// GAPS may only shrink: never derive these from GAPS. A landing control removes its name here and decrements the max.
const GAPS_CEILING = [
    'P-TREE', 'P-NEST',
    'T-A1', 'T-A2', 'T-A3a', 'T-A3b', 'T-A3c', 'T-A4', 'T-A5a', 'T-A6', 'T-A7a', 'T-A7b',
    'T-d8pc-head',
    'T-OB-lying-adapter', 'T-OB-nested-close', 'totals-e2e',
    'T-O1c-err', 'T-O5-counts', 'T-O6-shape', 'T-no-lane', 'T-post-cycles', 'R-kernel-identity',
];
// 25 -> 24 at burst 39: P-INTERIM-ERROR-clean landed as a _mustfail control (A2-F21); 24 -> 23 at burst 87: T-mark landed;
// 23 -> 24 at burst 117 B3a r2: T-LC-iter is a PLANNED GAP (maintainer ruling D-b117-2; its row returns in burst 118);
// 24 -> 23 at burst 117 B3b: T-A5b landed as a _mustfail control (prea5, PLAN-A5b task 4); 23 -> 22 at burst 118 B2:
// T-LC-iter landed as a _mustfail control (D-b117-2 closed by the lifecycle 'lself' lane op, b118 B1)
const GAPS_MAX = 22;
// The universe ids whose only teeth are GAPS (the union of GAPS[].covers), exactly. Moving an id from CHECKS into a
// GAP's covers (a tooth quietly turned into a gap) fails until this literal is edited.
const GAP_COVERED = [
    'oracle:OB', 'sig:OB:batch-early-run', 'gate:totals', 'sig:O1c:computed-err-mismatch',
    'sig:O5:teardown-residue',
    'sig:O6:equals-mutated', 'sig:O6:escape-empty', 'cause:no-lane', 'cause:post-cycles',
];
// CHECKS holds at least this many ids (31 at burst 10; 34 at burst 27: gate:wrap, cause:wrap-crossing,
// cause:wrap-unmeasured; 35 at burst 68: lane:WIE; 36 at burst 81: gate:rss; 40 at burst 93: lane:HOOK, oracle:O8,
// sig:O8:ghost-listener, sig:O8:mirror-links; 47 at burst 112: lane:LIFECYCLE, oracle:O7 and the five sig:O7:* ids;
// 53 at burst 127 B5: lane:OWNER, oracle:OW, sig:OW:cleanup-order, sig:OW:callback-this, and (A6) sig:O5:node-count,
// sig:O5:kind-count).
// A dropped id is a lost tooth; raise it when one lands.
const CHECKS_MIN = 53;

const copy = (x) => structuredClone(x);
const live = (over) => audit(Object.assign({ controls: CONTROL_NAMES.slice(), ceiling: GAPS_CEILING.slice(), max: GAPS_MAX }, over || {}));
/** The mutant's problems must include `want` (a problem string, matched exactly, or a RegExp). */
function hasProblem(probs, want) {
    const ok = probs.some((p) => (typeof want === 'string' ? p === want : want.test(p)));
    assert.ok(ok, 'want ' + String(want) + ' in ' + JSON.stringify(probs));
}

/* ---- a. the live registry is consistent --------------------------------------------------------------- */

const coveredBy = (gaps) => [...new Set(Object.keys(gaps).flatMap((g) => gaps[g].covers))].sort();

test('teeth a: audit() on the live registry with CONTROL_NAMES, the literal 22-name GAPS ceiling and max 22 is []', () => {
    assert.equal(GAPS_CEILING.length, GAPS_MAX, 'the literal ceiling and its literal size agree');
    assert.deepEqual(live(), []);
});

test('teeth a: GAPS cover exactly the literal 9 ids; CHECKS holds >= 53 ids (a tooth never quietly becomes a gap)', () => {
    assert.equal(GAP_COVERED.length, 9);
    assert.deepEqual(coveredBy(GAPS), GAP_COVERED.slice().sort());
    assert.ok(Object.keys(CHECKS).length >= CHECKS_MIN, 'CHECKS ids ' + Object.keys(CHECKS).length + ' < ' + CHECKS_MIN);
    // T1: cause:interrupted deleted from CHECKS and appended to GAPS['T-post-cycles'].covers -- audit() stays []
    const c = copy(CHECKS), g = copy(GAPS);
    delete c['cause:interrupted'];
    g['T-post-cycles'].covers.push('cause:interrupted');
    // b119 B5: the orphan rule sees this T1 only because L-I1 / L-I2 were listed under cause:interrupted alone
    assert.deepEqual(live({ checks: c, gaps: g }), ['orphan control: L-I1', 'orphan control: L-I2']);
    assert.notDeepEqual(coveredBy(g), GAP_COVERED.slice().sort());
    assert.ok(Object.keys(c).length < CHECKS_MIN);
    // T1 whose controls stay listed elsewhere (L-REV-152 holds 13 more ids): audit() stays [] -- why the literals exist
    const c2 = copy(CHECKS), g2 = copy(GAPS);
    delete c2['oracle:O2'];
    g2['T-post-cycles'].covers.push('oracle:O2');
    assert.deepEqual(live({ checks: c2, gaps: g2 }), [], 'audit() alone cannot see T1 (why the literals exist)');
    assert.notDeepEqual(coveredBy(g2), GAP_COVERED.slice().sort());
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
    g['T-d8pc-head'].covers = ['gate:heap'];
    hasProblem(live({ gaps: g }), 'stale GAP: T-d8pc-head covers gate:heap, which has CHECKS');
    const c = copy(CHECKS);
    c['gate:heap'] = ['L-T-leak', 'T-d8pc-head'];
    hasProblem(live({ checks: c }), 'stale GAP: T-d8pc-head is a CHECKS control');
});

test('teeth b: GAPS may only shrink -- a GAP outside the ceiling, a ceiling naming a deleted GAP, a stale max', () => {
    // a new GAP (or one missing from the ceiling)
    const grown = copy(GAPS);
    grown['T-new'] = { why: 'x', until: 'y', covers: [] };
    const pg = live({ gaps: grown });
    hasProblem(pg, 'GAP T-new is not in the ceiling (GAPS may only shrink)');
    hasProblem(pg, 'GAPS holds 23 entries > max 22 (GAPS may only shrink)');
    hasProblem(live({ ceiling: GAPS_CEILING.filter((n) => n !== 'T-d8pc-head'), max: 21 }), 'GAP T-d8pc-head is not in the ceiling (GAPS may only shrink)');
    // the ceiling with an extra name
    hasProblem(live({ ceiling: GAPS_CEILING.concat(['T-gone']) }), 'ceiling lists T-gone, which is no GAP any more: shrink the ceiling literal');
    // a deleted GAP without shrinking the literals
    const shrunk = copy(GAPS);
    delete shrunk['P-TREE'];
    const ps = live({ gaps: shrunk });
    hasProblem(ps, 'ceiling lists P-TREE, which is no GAP any more: shrink the ceiling literal');
    hasProblem(ps, 'GAPS holds 21 entries < max 22: decrement the max literal');
    hasProblem(live({ ceiling: GAPS_CEILING.concat(['P-TREE']) }), 'ceiling lists a GAP twice');
});

test('teeth b: max must be the exact safe-integer GAPS size; NaN, a string and missing are problems, never a skip', () => {
    hasProblem(live({ max: NaN }), 'max must be a safe integer (the literal GAPS size), got NaN');
    hasProblem(live({ max: '22' }), 'max must be a safe integer (the literal GAPS size), got 22');
    hasProblem(live({ max: undefined }), 'max must be a safe integer (the literal GAPS size), got undefined');
    hasProblem(live({ max: 23 }), 'GAPS holds 22 entries < max 23: decrement the max literal');
    hasProblem(live({ max: 21 }), 'GAPS holds 22 entries > max 21 (GAPS may only shrink)');
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
/** BREACH specs of a control (a spec with no leading kind word is BREACH; INCONCLUSIVE and NOTE specs are skipped), as token arrays. */
const breachSpecs = (c) => c.expect.specs.map((s) => s.split(' ').filter((t) => t.length > 0)).filter((t) => t[0] !== 'INCONCLUSIVE' && t[0] !== 'NOTE' && t.length > 0).map((t) => (t[0] === 'BREACH' ? t.slice(1) : t));
/** INCONCLUSIVE texts a control expects (INCONCLUSIVE specs minus the kind word -- BREACH and NOTE specs are skipped -- lines minus the prefix). */
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
// b119 B5: its expect.extra.pass keeps only the checks `sel` runs (L-WRAP-TREE's ['W2'] is dropped from a W1 stream)
const WRAP_CTL = (sel) => {
    const c = copy(CONTROLS.find((x) => x.name === 'L-WRAP-TREE'));
    c.env.SOAK_WRAP = sel || 'W1';
    const pass = c.expect.extra.pass.filter((w) => c.env.SOAK_WRAP.split(',').includes(w));
    if (pass.length > 0) c.expect.extra.pass = pass;
    else delete c.expect.extra.pass;
    if (Object.keys(c.expect.extra).length === 0) delete c.expect.extra;
    return c;
};
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
    for (const n of ['L-REV-AUDIT-W5', 'L-WRAP-TREE', 'L-WRAP-W2-PREFIXR']) {
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

test('teeth j: the wrap control specs are pinned (MD4: W5 evalCount at bop>=15; W1 / W3 / W4 on the tree, W2 on prefixr)', () => {
    const w5 = CONTROLS.find((c) => c.name === 'L-REV-AUDIT-W5');
    assert.deepEqual([w5.base, w5.env, w5.expect.exit, w5.expect.kind, w5.expect.specs, w5.expect.extra],
        ['headpatched', { SOAK_WRAP: 'W5' }, 1, 'match', ['gate=wrap check=W5 counter=evalCount bop>=15'], { verdict: 'FAIL' }]);
    const tree = CONTROLS.find((c) => c.name === 'L-WRAP-TREE');
    assert.deepEqual([tree.base, tree.env, tree.expect],
        ['tree', { SOAK_WRAP: 'W1,W2,W3,W4' }, { exit: 1, kind: 'match', lines: [], specs: ['gate=wrap check=W1 counter=globalVersion',
            'gate=wrap check=W3 counter=gen', 'gate=wrap check=W4 counter=nodeSeq'], extra: { pass: ['W2'] } }]);
});

// b109 B1b (PLAN-A3-soak ADDENDUM A6, option (a)): A3 FIX-R (74ea021, Signal.js 0f75866f) closes W2 on the tree (live W2
// PASS, .handoff/b109-evidence/wrap/W2-live.txt), so W2's tooth moved to the frozen pre-FIX-R kernel prefixr (25784e5,
// Signal.js 0628127b: `BREACH gate=wrap check=W2 counter=batchEpoch ... c()=70 effect saw 70`, W2-0628127b.txt).
test('teeth j: A6 -- L-WRAP-TREE names no W2 BREACH spec (W2 still runs there); L-WRAP-W2-PREFIXR breaches W2 on the pinned pre-FIX-R kernel', () => {
    const tree = CONTROLS.find((c) => c.name === 'L-WRAP-TREE');
    assert.deepEqual(tree.env, { SOAK_WRAP: 'W1,W2,W3,W4' }, 'W2 still runs on the tree');
    assert.deepEqual(tree.expect.specs.filter((s) => s.split(' ').indexOf('check=W2') !== -1 || s.indexOf('batchEpoch') !== -1), [],
        'no W2 / batchEpoch spec on the tree: FIX-R closed W2 there');
    assert.deepEqual(tree.expect.extra, { pass: ['W2'] }, 'b119 B5: W2 PASS is asserted on the tree');
    const w2 = CONTROLS.find((c) => c.name === 'L-WRAP-W2-PREFIXR');
    assert.ok(w2, 'the pre-FIX-R W2 control exists');
    assert.ok(LONG_RE.test(w2.name) && !SHORT_RE.test(w2.name), 'long battery (2^32 - 2 noop batches)');
    assert.deepEqual([w2.run, w2.base, w2.env, w2.argv, w2.patches, w2.arm, w2.expect],
        ['wrap', 'prefixr', { SOAK_WRAP: 'W2' }, [], [], null, { exit: 1, kind: 'match', lines: [], specs: ['gate=wrap check=W2 counter=batchEpoch'], extra: { verdict: 'FAIL' } }]);
    assert.deepEqual(validSpec(w2), []);
    // the base is the controls.json kernel prefixr, both sha256 pins verified (a drifted copy is a MISS, never a skip)
    assert.ok(BASES.prefixr, 'prefixr is a _mustfail base');
    assert.deepEqual([BASES.prefixr.dir.slice(ROOT.length).split('\\').join('/'), BASES.prefixr.pins, BASES.prefixr.pinName],
        ['bench/soak/controls/prefixr', 'controls.json', 'prefixr']);
    const ctl = JSON.parse(readFileSync(join(ROOT, 'bench/soak/controls.json'), 'utf8')).controls.find((x) => x && x.name === 'prefixr');
    assert.ok(ctl, 'controls.json holds the prefixr control');
    assert.deepEqual([ctl.dir, ctl.version, ctl.sha256], ['bench/soak/controls/prefixr', '1.6.0-dev 25784e5', {
        'Signal.js': '0628127bc811edc50d864424bb57955291fc9632d3c3291856d10219d3cafa48',
        'Watch.js': '065f21bd9b3a29363e96eac35f1c6c2005bcc8bfdc56e8d4ed0155617fd29d80',
    }]);
    assert.deepEqual(verifyControls(['prefixr']), { ok: true, problems: {} });
});

// b117 B3b (PLAN-A5b task 4 + Q1 (a)): prea5 (767f808, Signal.js 0f75866f) is the frozen pre-A5 kernel, T-A5b's base.
test('teeth j: prea5 is a controls.json base (767f808), both sha256 pins verified; verifyControls holds prefixr and prea5', () => {
    assert.ok(BASES.prea5, 'prea5 is a _mustfail base');
    assert.deepEqual([BASES.prea5.dir.slice(ROOT.length).split('\\').join('/'), BASES.prea5.pins, BASES.prea5.pinName],
        ['bench/soak/controls/prea5', 'controls.json', 'prea5']);
    const ctl = JSON.parse(readFileSync(join(ROOT, 'bench/soak/controls.json'), 'utf8')).controls.find((x) => x && x.name === 'prea5');
    assert.ok(ctl, 'controls.json holds the prea5 control');
    assert.deepEqual([ctl.dir, ctl.version, ctl.sha256], ['bench/soak/controls/prea5', '1.6.0-dev 767f808', {
        'Signal.js': '0f75866f7085d68f24819092dc46623ba63bed8a9d14b24d0b52cf02a439ebd9',
        'Watch.js': '065f21bd9b3a29363e96eac35f1c6c2005bcc8bfdc56e8d4ed0155617fd29d80',
    }]);
    assert.deepEqual(verifyControls(['prefixr', 'prea5']), { ok: true, problems: {} });
});

// b117 B3b (PLAN-A5b task 4 + Q2): T-A5b (A5b's fix-minus-one, out of GAPS) breaches O8 ghost-listener on prea5,
// explained by DIV-F9; P-HOOK-TREE is the tree HOOK pass control (P-HOOK-HP's shape); P-HOOK-TREE-COVOFF stays (exit 3).
test('teeth j: T-A5b, P-HOOK-TREE and P-HOOK-TREE-COVOFF are pinned; T-A5b holds lane:HOOK / oracle:O8 / sig:O8:ghost-listener', () => {
    const t = CONTROLS.find((x) => x.name === 'T-A5b');
    assert.ok(t, 'the T-A5b control exists');
    assert.ok(SHORT_RE.test(t.name) && !LONG_RE.test(t.name), 'short battery');
    // HOOK only: no write-cycle lane on a named control (exec.mjs creationAbort false predicts the CycleError at cyc:1)
    assert.deepEqual([t.run, t.base, t.env, t.argv, t.patches, t.arm, t.expect.exit, t.expect.kind, t.expect.specs,
        t.expect.lines, t.expect.known],
        ['main', 'prea5', { SOAK_LANES: 'HOOK' }, ['--smoke'], [], null, 1, 'explained', ['oracle=O8 lane=HOOK sig=ghost-listener'], [],
            ['DIV-F9']]);
    assert.deepEqual(validSpec(t), []);
    assert.equal(Object.prototype.hasOwnProperty.call(GAPS, 'T-A5b'), false, 'T-A5b left GAPS');
    for (const id of ['lane:HOOK', 'oracle:O8', 'sig:O8:ghost-listener']) assert.ok(CHECKS[id].includes('T-A5b'), id + ' holds T-A5b');
    const hp = CONTROLS.find((x) => x.name === 'P-HOOK-HP');
    const pt = CONTROLS.find((x) => x.name === 'P-HOOK-TREE');
    assert.ok(hp && pt, 'P-HOOK-HP and P-HOOK-TREE exist');
    assert.deepEqual([pt.run, pt.base, pt.env, pt.argv, pt.patches, pt.arm, pt.expect],
        [hp.run, 'tree', hp.env, hp.argv, [], null, hp.expect]);
    assert.deepEqual(pt.expect, { exit: 0, kind: 'nobreach', lines: [], specs: [], extra: { boundaries: 11, reason: 'end', verdict: 'PASS' } });
    assert.deepEqual(validSpec(pt), []);
    const cv = CONTROLS.find((x) => x.name === 'P-HOOK-TREE-COVOFF');
    assert.ok(cv, 'P-HOOK-TREE-COVOFF stays');
    assert.deepEqual([cv.base, cv.env, cv.argv, cv.expect.exit, cv.expect.kind],
        ['tree', { SOAK_LANES: 'HOOK', SOAK_MUSTFAIL: 'cov-off:hook-non-lifo-off' }, ['--smoke'], 3, 'nobreach']);
});

test('teeth k: P-INTERIM-ERROR-clean is pinned: preb33 (no patches), ERROR at the control budget, explained by DIV-F5 / DIV-F6 / DIV-F22, short battery', () => {
    const c = CONTROLS.find((x) => x.name === 'P-INTERIM-ERROR-clean');
    assert.ok(c, 'the GAP landed as a _mustfail control');
    assert.ok(SHORT_RE.test(c.name) && !LONG_RE.test(c.name), 'short battery');
    const hp = CONTROLS.find((x) => x.name === 'L-P-INTERIM-ERROR');
    assert.deepEqual([c.run, c.base, c.env, c.argv, c.expect.exit, c.expect.kind, c.expect.specs, c.expect.lines, c.expect.known],
        ['main', 'preb33', hp.env, [], 1, 'explained', [], [], ['DIV-F5', 'DIV-F6', 'DIV-F22']]);
    assert.deepEqual(hp.expect.known, ['DIV-F21', 'DIV-F22'], 'the unpatched pre-fix control still tolerates F21 (includeFixed)');
    assert.equal(c.patches.length, 0, 'preb33 carries the A2-F21 hunk natively: no patch');
    const src = buildKernel(c).src;
    assert.equal(src.indexOf('if ((node.flags & FLAG_EFFECT) !== 0) executeEffect(node);\n                        }\n'), -1, 'the pre-fix flush run is gone');
    // the patched flush loop must BE the shipped A2-F21 fix, not only match QSKIP2's own strings: the whole
    // flushEffects `for (let i = 0; i < toRun; i++)` body of the live Signal.js and of the built kernel, comments and
    // whitespace stripped, are equal (a QUEUED test on one branch only, or any drift from the tree, is red)
    const H = 'for (let i = 0; i < toRun; i++) {';
    const loopBody = (text, who) => {
        assert.equal(text.split(H).length, 2, who + ' holds the flush loop header exactly once');
        const a = text.indexOf(H) + H.length;
        let d = 1, i = a;
        for (; d > 0 && i < text.length; i++) { if (text[i] === '{') d++; else if (text[i] === '}') d--; }
        assert.equal(d, 0, who + ': unbalanced flush loop');
        return text.slice(a, i - 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
    };
    const tree = loopBody(readFileSync(join(ROOT, 'Signal.js'), 'utf8'), 'Signal.js');
    assert.ok(tree.indexOf('if((node.flags&FLAG_QUEUED)!==0){') !== -1, 'the tree carries the A2-F21 QUEUED test');
    assert.equal(loopBody(src, 'P-INTERIM-ERROR-clean kernel'), tree);
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
    assert.deepEqual(wrapJudge(WRAP_CTL('W1,W2'), wrapStream(), 'FAIL', []), ['header SOAK_WRAP ["W1"] != control SOAK_WRAP ["W1","W2"]',
        'wrap W2 must PASS: no wrap record']);
});

/* ---- j. B5 (b119, PLAN-A3-soak ADDENDUM A6 follow-ups): W2 asserted PASS on the tree; extra.pass; orphans; prefixr -- */

const W2_BREACH = 'soak: BREACH gate=wrap check=W2 counter=batchEpoch detail=batchEpoch cycle: c()=70 effect saw 70 after 4294967294 noop batches (expected 50 / 50)';
/** A consistent SOAK_WRAP=W1,W2 stream: wrapStream's W1 FAIL record, then a W2 record (status PASS unless `over` edits it). */
function w2Stream(over) {
    return wrapStream((r) => {
        r[0].config.SOAK_WRAP.value = ['W1', 'W2'];
        r.splice(2, 0, { type: 'wrap', seq: 2, tMs: 2, check: 'W2', counter: 'batchEpoch', opsDriven: 4294967294, crossed: true, pre: { bop: null },
            post: { bop: null }, values: { boundary: { trackerSize: 0, trackerDelta: 0, weakAlive: 0 }, failures: [] }, wallMs: 1, status: 'PASS' });
        Object.assign(r[3], { seq: 3, tMs: 3, checks: ['W1', 'W2'], records: 2 });
        if (over) over(r);
    });
}

test('teeth j: B5 -- wrapJudge holds L-WRAP-TREE\'s extra.pass W2: a FAIL W2 record, a W2 BREACH line or no W2 record is a MISS; a passing W2 is []', () => {
    const ctl = WRAP_CTL('W1,W2');
    assert.deepEqual(ctl.expect.extra, { pass: ['W2'] });
    // (c) consistent, W2 PASS
    assert.deepEqual(wrapJudge(ctl, w2Stream(), 'FAIL', []), []);
    // (a) the W2 record FAILs (its own status; wrapStreamProblems accepts it: a value assertion failed)
    assert.deepEqual(wrapJudge(ctl, w2Stream((r) => { r[2].status = 'FAIL'; r[2].values.failures = ['batchEpoch cycle: c()=70 effect saw 70']; }), 'FAIL', []),
        ['wrap W2 must PASS: W2/batchEpoch status FAIL']);
    // a W2 BREACH line on stderr is refused even when the record reads PASS (judgeMain kind 'match' never refuses an extra BREACH)
    assert.deepEqual(wrapJudge(ctl, w2Stream(), 'FAIL', [W2_BREACH]), ['wrap W2 must PASS: BREACH line ' + W2_BREACH.slice(0, 140)]);
    // a BREACH of another check, or a W2 INCONCLUSIVE line, is not a W2 BREACH
    assert.deepEqual(wrapJudge(ctl, w2Stream(), 'FAIL', ['soak: BREACH gate=wrap check=W1 counter=globalVersion detail=band-observed']), []);
    // (b) no W2 record: exactly the pass problem when the selection holds no W2 ...
    const w1 = WRAP_CTL('W1');
    w1.expect.extra = { pass: ['W2'] };
    assert.deepEqual(wrapJudge(w1, wrapStream(), 'FAIL', []), ['wrap W2 must PASS: no wrap record']);
    // ... and alongside wrapRule's re-derived crossing cause when it does
    const gone = wrapJudge(ctl, w2Stream((r) => { r.splice(2, 1); Object.assign(r[2], { seq: 2, records: 1 }); }), 'INCONCLUSIVE', []);
    hasProblem(gone, 'wrap W2 must PASS: no wrap record');
    // a malformed pass (validSpec refuses it first) fails closed here too
    const bad = WRAP_CTL('W1,W2');
    bad.expect.extra.pass = 'W2';
    assert.deepEqual(wrapJudge(bad, w2Stream(), 'FAIL', []), ['expect.extra.pass is not an array']);
});

test('teeth j: B5 -- validSpec: extra.pass is wrap-only, a non-empty list of distinct W1..W5 in SOAK_WRAP and in no BREACH spec', () => {
    const tree = () => copy(CONTROLS.find((x) => x.name === 'L-WRAP-TREE'));
    assert.deepEqual(validSpec(tree()), []);
    const main = copy(CONTROLS.find((x) => x.name === 'T-sever'));
    main.expect.extra = { pass: ['W2'] };
    assert.deepEqual(validSpec(main), ['expect.extra.pass belongs to run wrap']);
    const cfg = copy(CONTROLS.find((x) => x.name === 'T-cfg-lanes-typo'));
    cfg.expect.extra = { pass: ['W2'] };
    assert.deepEqual(validSpec(cfg), ['expect.extra.pass belongs to run wrap']);
    const rows = [
        [['W6'], ['expect.extra.pass: "W6" is not one of W1..W5']],
        [['W2', 'W2'], ['expect.extra.pass lists W2 twice']],
        [[], ['expect.extra.pass must be a non-empty array of W1..W5']],
        ['W2', ['expect.extra.pass must be a non-empty array of W1..W5']],
        [['W5'], ['expect.extra.pass: W5 is not in env.SOAK_WRAP']],
        [['W1'], ['expect.extra.pass: W1 is also named by a BREACH spec (check=W1)']],
        [['W2', 'W3'], ['expect.extra.pass: W3 is also named by a BREACH spec (check=W3)']],
    ];
    for (const [pass, want] of rows) {
        const c = tree();
        c.expect.extra.pass = pass;
        assert.deepEqual(validSpec(c), want, JSON.stringify(pass));
    }
    // an INCONCLUSIVE spec naming the check is no contradiction (only BREACH specs breach)
    const inc = tree();
    inc.expect.specs = inc.expect.specs.concat(['INCONCLUSIVE gate=wrap check=W2']);
    assert.deepEqual(validSpec(inc), []);
});

test('teeth j: B5 -- audit(): every _mustfail control is under some CHECKS id or in NOT_TEETH (orphan control: <name>)', () => {
    assert.deepEqual(Object.keys(NOT_TEETH), ['L-P-INTERIM', 'L-P-INTERIM-ERROR', 'P-INTERIM-ERROR-clean', 'P-HOOK-HP', 'P-HOOK-TREE', 'P-LC-tree', 'T-mark', 'P-OWNER-TREE']);
    assert.ok(CHECKS['cause:scenario'].includes('P-HOOK-TREE-COVOFF'), 'the b93 HOOK cov-off scenario control is a cause:scenario tooth');
    assert.deepEqual(live({ controls: CONTROL_NAMES.concat(['X-orphan']) }), ['orphan control: X-orphan']);
    assert.deepEqual(live({ controls: CONTROL_NAMES.concat(['X-orphan']), notTeeth: Object.assign({}, NOT_TEETH, { 'X-orphan': 'a reason' }) }), []);
    assert.deepEqual(live({ notTeeth: {} }), Object.keys(NOT_TEETH).map((n) => 'orphan control: ' + n));
    const c = copy(CHECKS);
    c['cause:scenario'] = c['cause:scenario'].filter((n) => n !== 'P-HOOK-TREE-COVOFF');
    assert.deepEqual(live({ checks: c }), ['orphan control: P-HOOK-TREE-COVOFF']);
    // the allowlist itself fails closed: a gone control, a listed control, a reason that is not one line
    assert.deepEqual(live({ notTeeth: Object.assign({}, NOT_TEETH, { 'Y-gone': 'r' }) }), ['stale NOT_TEETH: Y-gone is no _mustfail control']);
    assert.deepEqual(live({ notTeeth: Object.assign({}, NOT_TEETH, { 'T-sever': 'r' }) }), ['stale NOT_TEETH: T-sever is a CHECKS control']);
    assert.deepEqual(live({ notTeeth: Object.assign({}, NOT_TEETH, { 'T-mark': 'two\nlines' }) }), ['NOT_TEETH T-mark must be a one-line reason']);
    assert.deepEqual(live({ notTeeth: Object.assign({}, NOT_TEETH, { 'T-cfg-lanes-typo': 'r' }) }), ['stale NOT_TEETH: T-cfg-lanes-typo is a CHECKS control']);
});

test('teeth j: B5 -- base prefixr is wrap-only (post-F-b33-1, pre-FIX-R); L-WRAP-W2-PREFIXR is valid', () => {
    const m = copy(CONTROLS.find((x) => x.name === 'T-sever'));
    m.base = 'prefixr';
    assert.deepEqual(validSpec(m), ['base prefixr is wrap-only']);
    const cfg = copy(CONTROLS.find((x) => x.name === 'T-cfg-lanes-typo'));
    cfg.base = 'prefixr';
    assert.deepEqual(validSpec(cfg), ['base prefixr is wrap-only']);
    assert.deepEqual(validSpec(CONTROLS.find((x) => x.name === 'L-WRAP-W2-PREFIXR')), []);
});

test('teeth l: L-WIE-rev152 is pinned: rev152 unpatched, preb33 WIE budget, DIV-B33, long; lane:WIE pair', () => {
    const c = CONTROLS.find((x) => x.name === 'L-WIE-rev152');
    assert.ok(c, 'the rev152 WIE control exists');
    assert.ok(LONG_RE.test(c.name) && !SHORT_RE.test(c.name), 'long battery');
    const preb33 = CONTROLS.find((x) => x.name === 'L-WIE-preb33');
    assert.ok(preb33, 'the preb33 WIE control exists');
    assert.deepEqual([c.run, c.base, c.env, c.argv, c.patches, c.arm, c.expect.exit, c.expect.kind, c.expect.specs,
        c.expect.lines, c.expect.known],
        ['main', 'rev152', preb33.env, [], [], null, 1, 'explained', ['oracle=O1 lane=WIE sig=effect-stale'], [],
            ['DIV-B33']]);
    assert.deepEqual(CHECKS['lane:WIE'], ['L-WIE-preb33', 'L-WIE-rev152']);
});

test('teeth m: gate:heap has two teeth, L-T-leak and L-T-graveyard (released links kept off the free list)', () => {
    assert.deepEqual(CHECKS['gate:heap'], ['L-T-leak', 'L-T-graveyard']);
    const g = CONTROLS.find((x) => x.name === 'L-T-graveyard');
    assert.ok(g, 'the graveyard control exists');
    assert.ok(LONG_RE.test(g.name) && !SHORT_RE.test(g.name), 'long battery');
    const leak = CONTROLS.find((x) => x.name === 'L-T-leak');
    assert.deepEqual([g.run, g.base, g.env, g.argv, g.arm, g.expect.exit, g.expect.kind, g.expect.specs,
        g.expect.lines], ['main', 'headpatched', leak.env, [], null, 1, 'match', ['gate=heap lane=GRAPH'], []]);
    assert.deepEqual(validSpec(g), []);
    assert.equal(g.patches.length, 1);
    // the patch removes freeLink's free-list return (the sub-walk still recycles ~1%) and keeps the activeLinks
    // decrement (stats / O5 stay consistent)
    const base = readFileSync(join(ROOT, 'bench/soak/controls/headpatched/Signal.js'), 'utf8');
    const src = buildKernel(g).src;
    const n = (t, s) => t.split(s).length - 1;
    const FREE = '        link.nextFree = freeLinkHead;\n        freeLinkHead = link;\n' +
        '        activeLinks = (activeLinks - 1) | 0;\n';
    assert.equal(n(base, FREE), 1, 'freeLink returns a link to its free list at one site');
    assert.equal(n(base, '            freeLinkHead = sLink;\n'), 1,
        'the disposeNodeInner sub-walk still recycles (~1%, b82 probe)');
    const GRAVE = '        (globalThis.__soakGrave ||= []).push(link);   // MUSTFAIL L-T-graveyard\n' +
        '        activeLinks = (activeLinks - 1) | 0;\n';
    assert.equal(src, base.replace(FREE, GRAVE), 'the graveyard kernel = base with exactly the freeLink push replaced');
    // its pairing is the heap gate's: a graveyard control that expects the rss line does not back gate:heap
    const ctl = copy(CONTROLS);
    ctl.find((x) => x.name === 'L-T-graveyard').expect.specs = ['gate=rss lane=GRAPH'];
    assert.deepEqual(pairing(CHECKS, ctl), ['gate:heap: L-T-graveyard -- no BREACH spec naming gate=heap']);
});

test('teeth m: L-T-rss starts late -- no retention inside the band window, retention before the late window', () => {
    const c = CONTROLS.find((x) => x.name === 'L-T-rss');
    assert.deepEqual([c.base, c.env.SOAK_LANES, c.env.SOAK_CYCLES, c.expect.exit, c.expect.kind, c.expect.specs],
        ['headpatched', 'GRAPH', String(MIN_ACTIVE_CYCLES), 1, 'match', ['gate=rss lane=GRAPH']]);
    assert.equal(c.patches.length, 1);
    const lines = buildKernel(c).src.split('\n');
    const at = lines.findIndex((l) => l.endsWith('// MUSTFAIL L-T-rss'));
    assert.ok(at > 0, 'the L-T-rss patch is in the kernel');
    const head = '    if ((globalThis.__soakRssN = (globalThis.__soakRssN | 0) + 1) > ';
    assert.ok(lines[at].startsWith(head) && lines[at].endsWith(') {   // MUSTFAIL L-T-rss'), lines[at]);
    const after = Number(lines[at].slice(head.length, lines[at].indexOf(')', head.length)));
    const buf = /^ {8}\(globalThis\.__soakRss \|\|= \[\]\)\.push\(Buffer\.allocUnsafeSlow\((\d+)\)\.fill\(0x5a\)\);$/
        .exec(lines[at + 1]);
    assert.ok(buf !== null, lines[at + 1]);
    assert.equal(lines[at + 2], '    }');
    assert.ok(lines[at + 3].startsWith('    return {getOwner, '), 'right before the createRegistry return');
    // one registry per world; b82 link-probe: 213 GRAPH worlds per DEFAULT_OPS cycle (a deterministic count)
    const perCycle = 213;
    assert.ok(Number.isSafeInteger(after) && after >= (WARMUP_CYCLES + GATE_N) * perCycle,
        'no retention before the band window (cycles 1..GATE_N) ends: ' + after);
    assert.ok(after <= (MIN_ACTIVE_CYCLES - 4) * perCycle,
        'retention starts >= 2 cycles before the late window: ' + after);
    // b82 measured: 512 KB MISSed (late 0.96 x the limit), 1.5 MB tripped gate=rss at 1.83 x: no smaller size is proven
    assert.ok(Number(buf[1]) >= 1572864, 'a per-registry buffer of >= 1.5 MB (the measured size): ' + buf[1]);
});

test('teeth n: L-NW-hp-zero is pinned: headpatched unpatched + SOAK_NEARWRAP=zero:8, GRAPH x 11 at 20000 ops, long; lane:GRAPH pair', () => {
    const c = CONTROLS.find((x) => x.name === 'L-NW-hp-zero');
    assert.ok(c, 'the NEARWRAP control exists');
    assert.ok(LONG_RE.test(c.name) && !SHORT_RE.test(c.name), 'long battery');
    // the spec is not keyed on known= / sig= (a DIV-F29 entry must not move it); every boundary drained, run to its end
    assert.deepEqual([c.run, c.base, c.env, c.argv, c.patches, c.arm, c.expect.exit, c.expect.kind, c.expect.specs,
        c.expect.lines, c.expect.extra],
        ['main', 'headpatched', { SOAK_LANES: 'GRAPH', SOAK_CYCLES: String(MIN_ACTIVE_CYCLES), SOAK_OPS: '20000', SOAK_NEARWRAP: 'zero:8' },
            [], [], null, 1, 'match', ['oracle=O1 lane=GRAPH'], [], { boundaries: MIN_ACTIVE_CYCLES, reason: 'end', verdict: 'FAIL' }]);
    assert.deepEqual(validSpec(c), []);
    assert.deepEqual(CHECKS['lane:GRAPH'], ['T-sever', 'L-NW-hp-zero', 'T-flushdrop']);
    // its pairing is lane:GRAPH's: a NEARWRAP control whose spec names another lane does not back lane:GRAPH
    const ctl = copy(CONTROLS);
    ctl.find((x) => x.name === 'L-NW-hp-zero').expect.specs = ['oracle=O1 lane=BATCH'];
    assert.deepEqual(pairing(CHECKS, ctl), ['lane:GRAPH: L-NW-hp-zero -- no BREACH spec naming lane=GRAPH']);
    // the fix-minus-one GAPS that NEARWRAP will run end to end say so (and only those); totals-e2e no longer waits
    // on it
    const NW = '; SOAK_NEARWRAP presets the counter near its ceiling, so the revert runs end to end once the fix lands';
    for (const g of ['T-A3b', 'T-A7a', 'T-A7b']) assert.ok(GAPS[g].why.endsWith(NW), g + ': ' + GAPS[g].why);
    const NW_GAPS = ['T-A3b', 'T-A7a', 'T-A7b'];
    for (const g of Object.keys(GAPS).filter((k) => !NW_GAPS.includes(k))) {
        assert.equal(GAPS[g].why.indexOf('SOAK_NEARWRAP'), -1, g + ': ' + GAPS[g].why);
    }
    assert.equal(GAPS['totals-e2e'].until, 'long soak (NEARWRAP presets engine counters, not run totals)');
});

test('teeth o: T-flushdrop is pinned: headpatched GRAPH smoke, flushEffects drops every 64th effect; lane / O4 / O1e pairs', () => {
    const c = CONTROLS.find((x) => x.name === 'T-flushdrop');
    assert.ok(c, 'the flush-drop control exists');
    assert.ok(SHORT_RE.test(c.name) && !LONG_RE.test(c.name), 'short battery');
    assert.deepEqual([c.run, c.base, c.env, c.argv, c.arm, c.expect.exit, c.expect.kind, c.expect.specs, c.expect.lines],
        ['main', 'headpatched', { SOAK_LANES: 'GRAPH' }, ['--smoke'], null, 1, 'match',
            ['oracle=O4 lane=GRAPH sig=effect-dead', 'oracle=O1 lane=GRAPH sig=effect-stale'], []]);
    assert.deepEqual(validSpec(c), []);
    assert.equal(c.patches.length, 1);
    // the anchor is the flushEffects non-scheduler run (28-space indent); the :1577 twin carries `node.gen === gen &&`
    const RUN = ' '.repeat(28) + 'if ((node.flags & FLAG_EFFECT) !== 0) executeEffect(node);\n';
    assert.equal(c.patches[0][0], RUN);
    const base = readFileSync(join(ROOT, 'bench/soak/controls/headpatched/Signal.js'), 'utf8');
    assert.equal(base.split(RUN).length - 1, 1, 'the flush-loop run occurs once in headpatched');
    const repl = c.patches[0][1];
    // one-off drop: every 64th flushed effect is skipped AND un-queued (executeEffect's FLAG_QUEUED clear), never wedged
    assert.ok(repl.indexOf('& 63) === 0) node.flags &= ~FLAG_QUEUED;') > 0, repl);
    assert.ok(repl.indexOf('else executeEffect(node);') > 0, repl);
    assert.equal(buildKernel(c).src, base.replace(RUN, repl), 'the kernel = base with exactly the flush-loop run replaced');
    for (const id of ['lane:GRAPH', 'oracle:O4', 'sig:O4:effect-dead', 'oracle:O1e', 'sig:O1e:effect-stale']) {
        assert.ok(CHECKS[id].includes('T-flushdrop'), id);
    }
    assert.deepEqual(pairing(CHECKS, CONTROLS), []);
    // must-fail: a flush-drop control whose specs name another lane does not back lane:GRAPH
    const ctl = copy(CONTROLS);
    const fd = ctl.find((x) => x.name === 'T-flushdrop');
    fd.expect.specs = fd.expect.specs.map((s) => s.replace('lane=GRAPH', 'lane=BATCH'));
    assert.deepEqual(pairing(CHECKS, ctl), ['lane:GRAPH: T-flushdrop -- no BREACH spec naming lane=GRAPH']);
});

/* ---- p. the LIFECYCLE teeth (b112 B5, PLAN-R2-lifecycle CONTROLS; b117 B3a, PLAN-A5a task 5 + D-b117-1/2; b118 B2) */

const O7 = (sig) => 'oracle=O7 lane=LIFECYCLE sig=' + sig + ' known=none';
const LC_ROWS = [
    // [name, the full-line anchor in the live Signal.js, the row's own sig (spec[0])]
    ['T-LC-dupconn', '            const f = r.onConnect;\n', O7('spurious-connect')],
    ['T-LC-dupdisc', '            const f = r.onDisconnect;\n', O7('spurious-disconnect')],
    ['T-LC-dropconn', '            const f = r.onConnect;\n', O7('missed-connect')],
    ['T-LC-dropdisc', '            const f = r.onDisconnect;\n', O7('missed-disconnect')],
    ['T-LC-offlive', '            if (!reg.live) return;\n', 'oracle=O6 lane=LIFECYCLE sig=escape-TypeError known=none'],
    ['T-LC-merge', '        if (e.tail !== null) e.tail.next = reg; else e.head = reg;\n', O7('missed-connect')],
    ['T-LC-iter', '            if (n !== null) n.prev = p; else le.tail = p;\n', O7('stale-off')],
];
const LC_GEN_STAMP = '            if (node.gen !== g) return;\n';
const LC_ENV = { SOAK_LANES: 'LIFECYCLE' };
const LC_COV_ENV = { SOAK_LANES: 'LIFECYCLE', SOAK_MUSTFAIL: 'cov-off:lc-two-regs' };

test('teeth p: the LIFECYCLE ids have teeth -- L-LC-preb33, P-LC-tree, T-cov-LIFECYCLE and seven one-line T-LC-* tree mutants; each pairs', () => {
    const NEW = ['lane:LIFECYCLE', 'oracle:O7', 'sig:O7:spurious-connect', 'sig:O7:spurious-disconnect', 'sig:O7:missed-connect',
        'sig:O7:missed-disconnect', 'sig:O7:stale-off'];
    const u = universe();
    for (const id of NEW) {
        assert.ok(u.includes(id), id + ' is a judged id');
        assert.ok(Array.isArray(CHECKS[id]) && CHECKS[id].length >= 1, id + ' has a CHECKS control');
    }
    assert.ok(CHECKS['sig:O7a:dead-registration-fire'].includes('L-LC-preb33'));
    assert.ok(CHECKS['sig:O7:stale-off'].includes('L-LC-preb33'));
    assert.ok(CHECKS['sig:O7:missed-connect'].includes('T-LC-merge'));
    assert.ok(CHECKS['sig:O7:stale-off'].includes('T-LC-merge'));
    for (const id of ['oracle:O6', 'sig:O6:escape-*']) assert.ok(CHECKS[id].includes('T-LC-offlive'), id + ' -> T-LC-offlive');
    assert.ok(!CHECKS['oracle:O7'].includes('T-LC-offlive'), 'T-LC-offlive heads O6, not O7');
    // D-b117-1: the gen-stamp mutant is equivalent -> no row; the stamp is UNREACHABLE with its exactly-once anchor
    assert.ok(!CONTROL_NAMES.includes('T-LC-offgen'));
    assert.ok(!Object.values(CHECKS).some((l) => l.includes('T-LC-offgen')));
    assert.deepEqual(UNREACHABLE['lc-off-gen-stamp'].anchor, { file: 'Signal.js', text: LC_GEN_STAMP });
    // D-b117-2 closed (b118 B2): T-LC-iter is a CONTROL, not a GAP -- the short-battery row runs LC_ITER_PATCH and backs
    // lane:LIFECYCLE, oracle:O7 and its measured head sig:O7:stale-off (MUSTFAIL_HEADS=1, .handoff/b118-evidence/b2/)
    assert.ok(!Object.prototype.hasOwnProperty.call(GAPS, 'T-LC-iter'), 'T-LC-iter left GAPS');
    assert.ok(CONTROL_NAMES.includes('T-LC-iter'));
    for (const id of ['lane:LIFECYCLE', 'oracle:O7', 'sig:O7:stale-off']) assert.ok(CHECKS[id].includes('T-LC-iter'), id + ' -> T-LC-iter');
    // OQ4 (A): P-LC-TRIGGERLESS is renamed T-cov-LIFECYCLE (the cause:scenario LIFECYCLE tooth); the name is gone
    assert.ok(CHECKS['cause:scenario'].includes('T-cov-LIFECYCLE'));
    assert.ok(!CONTROL_NAMES.includes('P-LC-TRIGGERLESS'));
    assert.ok(!Object.values(CHECKS).some((l) => l.includes('P-LC-TRIGGERLESS')));
    for (const n of ['L-LC-preb33'].concat(LC_ROWS.map((r) => r[0]))) assert.ok(CHECKS['lane:LIFECYCLE'].includes(n), 'lane:LIFECYCLE -> ' + n);
    for (const n of ['L-LC-preb33'].concat(LC_ROWS.filter((r) => r[2].indexOf('oracle=O7 ') === 0).map((r) => r[0]))) assert.ok(CHECKS['oracle:O7'].includes(n), 'oracle:O7 -> ' + n);
    // the pass / revert control: tree unpatched, the FULL lane (no cov-off: A5a made the tree clean of DIV-D3), exit 0
    const p = CONTROLS.find((x) => x.name === 'P-LC-tree');
    assert.ok(p && SHORT_RE.test(p.name));
    assert.deepEqual([p.run, p.base, p.env, p.argv, p.patches, p.arm, p.expect.exit, p.expect.kind, p.expect.lines, p.expect.specs, p.expect.extra],
        ['main', 'tree', LC_ENV, ['--smoke'], [], null, 0, 'nobreach', [], [], { verdict: 'SMOKE' }]);
    assert.deepEqual(validSpec(p), []);
    // the coverage tooth: the same tree lane at cov-off:lc-two-regs, exit 3 on the two measured scenario lines
    const t = CONTROLS.find((x) => x.name === 'T-cov-LIFECYCLE');
    assert.ok(t && SHORT_RE.test(t.name));
    assert.deepEqual([t.run, t.base, t.env, t.argv, t.patches, t.arm, t.expect.exit, t.expect.kind], ['main', 'tree', LC_COV_ENV, ['--smoke'], [], null, 3, 'nobreach']);
    assert.deepEqual(t.expect.lines, ['soak: INCONCLUSIVE -- scenario lane=LIFECYCLE missing=lc-two-regs', 'soak: INCONCLUSIVE -- scenario lane=LIFECYCLE missing=lc-off-sibling']);
    assert.deepEqual(t.expect.specs, ['INCONCLUSIVE scenario lane=LIFECYCLE missing=lc-two-regs']);
    // the preb33 row: unpatched, long, explained by exactly the two registry ids
    const l = CONTROLS.find((x) => x.name === 'L-LC-preb33');
    assert.ok(LONG_RE.test(l.name));
    assert.deepEqual([l.base, l.patches, l.expect.exit, l.expect.kind, l.expect.known], ['preb33', [], 1, 'explained', ['DIV-D3-independent-registrations', 'DIV-F7']]);
    assert.deepEqual(l.expect.specs, ['oracle=O7 lane=LIFECYCLE sig=stale-off', 'oracle=O7 lane=LIFECYCLE sig=dead-registration-fire']);
    // each mutant: one exactly-once full-line anchor in the live Signal.js, one line changed, P-LC-tree's shape
    // LC_ROWS is a hand list: it must name every T-LC-* row the registry holds, in order
    assert.deepEqual(CONTROLS.filter((x) => x.name.indexOf('T-LC-') === 0).map((x) => x.name), LC_ROWS.map((r) => r[0]));
    const base = readFileSync(join(ROOT, 'Signal.js'), 'utf8');
    for (const [name, anchor, head] of LC_ROWS) {
        const c = CONTROLS.find((x) => x.name === name);
        assert.ok(c && SHORT_RE.test(name), name + ' exists in the short battery');
        assert.deepEqual([c.run, c.base, c.env, c.argv, c.arm, c.expect.exit, c.expect.kind], ['main', 'tree', LC_ENV, ['--smoke'], null, 1, 'match'], name);
        assert.deepEqual(validSpec(c), [], name);
        assert.equal(c.patches.length, 1, name);
        assert.equal(c.patches[0][0], anchor, name + ' anchors the full line');
        assert.equal(base.split(anchor).length - 1, 1, name + ': the anchor occurs exactly once in Signal.js');
        assert.equal(buildKernel(c).src, base.replace(anchor, () => c.patches[0][1]), name + ': the kernel = Signal.js with exactly that line replaced');
        const a = base.split('\n'), b = buildKernel(c).src.split('\n');
        assert.equal(a.length, b.length, name + ': a one-line mutant');
        assert.equal(a.filter((x, i) => x !== b[i]).length, 1, name + ': exactly one line differs');
        assert.equal(c.expect.specs[0], head, name + ' heads its own sig');
        assert.ok(c.expect.specs.every((s) => s.endsWith(' known=none')), name + ': every head is the mutant\'s (the tree lane is clean)');
    }
    // the bare gen tests are ambiguous in Signal.js 2f7974f3: never an anchor (re-measured b117 B3a)
    assert.equal(base.split('node.gen === g').length - 1, 4);
    assert.equal(base.split('node.gen !== g').length - 1, 5);
    assert.equal(base.split(LC_GEN_STAMP).length - 1, 1, 'the UNREACHABLE gen-stamp line occurs exactly once');
    // T-LC-iter runs exactly the exported LC_ITER_PATCH (the LC_ROWS loop above proves it exactly-once and one-line)
    const iter = CONTROLS.find((x) => x.name === 'T-LC-iter');
    assert.deepEqual(iter.patches, [LC_ITER_PATCH.slice()]);
    assert.equal(base.split(LC_ITER_PATCH[0]).length - 1, 1, 'the LC_ITER_PATCH anchor occurs exactly once in Signal.js');
    assert.equal(patch(base, LC_ITER_PATCH[0], LC_ITER_PATCH[1]), buildKernel(iter).src);
    assert.deepEqual(pairing(CHECKS, CONTROLS), []);
    // must-fail: a T-LC row whose spec names another sig does not back its sig id; one naming another lane not lane:LIFECYCLE
    const ctl = copy(CONTROLS);
    const dc = ctl.find((x) => x.name === 'T-LC-dupconn');
    dc.expect.specs = ['oracle=O7 lane=LIFECYCLE sig=missed-connect known=none'];
    assert.deepEqual(pairing(CHECKS, ctl), ['sig:O7:spurious-connect: T-LC-dupconn -- no BREACH spec naming oracle=O7 with sig in spurious-connect']);
    dc.expect.specs = ['oracle=O7 lane=HOOK sig=spurious-connect known=none'];
    assert.deepEqual(pairing(CHECKS, ctl), ['lane:LIFECYCLE: T-LC-dupconn -- no BREACH spec naming lane=LIFECYCLE']);
    // must-fail: T-LC-iter's spec moved off its measured stale-off head no longer backs sig:O7:stale-off
    const ctl2 = copy(CONTROLS);
    ctl2.find((x) => x.name === 'T-LC-iter').expect.specs = [O7('missed-connect')];
    assert.deepEqual(pairing(CHECKS, ctl2), ['sig:O7:stale-off: T-LC-iter -- no BREACH spec naming oracle=O7 with sig in stale-off']);
    // must-fail: an anchor that occurs twice is stale (patchAll refuses it)
    const dup = copy(CONTROLS);
    dup.find((x) => x.name === 'T-LC-offlive').patches[0][0] = 'node.gen !== g';
    const sd = staleAnchors(dup);
    assert.equal(sd.length, 1, JSON.stringify(sd));
    assert.ok(sd[0].name === 'T-LC-offlive' && sd[0].error.includes('5 matches'), sd[0].error);
    // must-fail: the registry without the LIFECYCLE CHECKS leaves all seven ids uncovered
    const c2 = copy(CHECKS);
    for (const id of NEW) delete c2[id];
    const probs = live({ checks: c2 });
    for (const id of NEW) hasProblem(probs, 'uncovered: ' + id + ' has no CHECKS control, no GAP and no UNREACHABLE proof');
});

/* ---- q. the OWNER teeth (b127 B5, PLAN-R3-owner A1 / A2 / A5: five tree mutants, a pass control, two cov-off rows) -- */

const OW = (o, sig) => 'oracle=' + o + ' lane=OWNER sig=' + sig + ' known=none';
const OW_ROWS = [
    // [name, the anchor (full line(s)) in the live Signal.js, the mutant's replacement, the row's specs]
    ['T-owner-cascade', '        while ((child = node.firstOwned) !== null) {\n', '        while (false && (child = node.firstOwned) !== null) {\n',
        [OW('O5', 'node-count'), OW('O5', 'link-count'), OW('O5', 'kind-count')]],
    ['T-owner-cleanup', '            if (existing === undefined) currentOwner.cleanupFn = fn;\n',
        '            if (existing === undefined) { /* MUT cleanup: assignment dropped */ }\n', [OW('O4', 'effect-dead')]],
    ['T-owner-fifo', '            else for (let i = 0; i < cleanup.length; i++) { const fn = cleanup[i]; fn(); }\n',
        '            else for (let i = cleanup.length - 1; i >= 0; i--) { const fn = cleanup[i]; fn(); }\n', [OW('OW', 'cleanup-order')]],
    ['T-owner-outin', '        if (node.firstOwned !== null) disposeOwned(node);\n        if (node.cleanupFn !== undefined) runOwnCleanup(node);\n',
        '        if (node.cleanupFn !== undefined) runOwnCleanup(node);\n        if (node.firstOwned !== null) disposeOwned(node);\n', [OW('OW', 'cleanup-order')]],
    ['T-owner-this', '            else for (let i = 0; i < cleanup.length; i++) { const fn = cleanup[i]; fn(); }\n',
        '            else for (let i = 0; i < cleanup.length; i++) cleanup[i]();\n', [OW('OW', 'callback-this')]],
];
const OW_ENV = { SOAK_LANES: 'OWNER' };
const OW_COV_ENV = { SOAK_LANES: 'OWNER', SOAK_MUSTFAIL: 'cov-off:cleanup-fifo' };
const OW_COV_LINE = 'soak: INCONCLUSIVE -- scenario lane=OWNER missing=cleanup-fifo';

test('teeth q: the OWNER ids have teeth -- P-OWNER-TREE, T-cov-OWNER, P-OWNER-HP and five one-hunk T-owner-* tree mutants; each pairs', () => {
    const NEW = ['lane:OWNER', 'oracle:OW', 'sig:OW:cleanup-order', 'sig:OW:callback-this'];
    const u = universe();
    for (const id of NEW) {
        assert.ok(u.includes(id), id + ' is a judged id');
        assert.ok(Array.isArray(CHECKS[id]) && CHECKS[id].length >= 1, id + ' has a CHECKS control');
    }
    const names = OW_ROWS.map((r) => r[0]);
    assert.deepEqual(CHECKS['lane:OWNER'], names);
    assert.deepEqual(CHECKS['oracle:OW'], ['T-owner-fifo', 'T-owner-outin', 'T-owner-this']);
    assert.deepEqual(CHECKS['sig:OW:cleanup-order'], ['T-owner-fifo', 'T-owner-outin']);
    assert.deepEqual(CHECKS['sig:OW:callback-this'], ['T-owner-this']);
    for (const id of ['oracle:O5', 'sig:O5:link-count']) assert.ok(CHECKS[id].includes('T-owner-cascade'), id + ' -> T-owner-cascade');
    for (const id of ['oracle:O4', 'sig:O4:effect-dead']) assert.ok(CHECKS[id].includes('T-owner-cleanup'), id + ' -> T-owner-cleanup');
    // A6: T-owner-cascade is the measured red kernel of node-count / kind-count; GAP T-O5-counts covers teardown-residue only
    for (const id of ['sig:O5:node-count', 'sig:O5:kind-count']) assert.deepEqual(CHECKS[id], ['T-owner-cascade'], id);
    for (const n of ['T-cov-OWNER', 'P-OWNER-HP']) assert.ok(CHECKS['cause:scenario'].includes(n), 'cause:scenario -> ' + n);
    assert.equal(typeof NOT_TEETH['P-OWNER-TREE'], 'string');
    // the pass / revert control: tree unpatched, the FULL lane, exit 0 (A1: LANE_KERNELS.OWNER = ['tree'])
    const p = CONTROLS.find((x) => x.name === 'P-OWNER-TREE');
    assert.ok(p && SHORT_RE.test(p.name));
    assert.deepEqual([p.run, p.base, p.env, p.argv, p.patches, p.arm, p.expect.exit, p.expect.kind, p.expect.lines, p.expect.specs, p.expect.extra],
        ['main', 'tree', OW_ENV, ['--smoke'], [], null, 0, 'nobreach', [], [], { verdict: 'SMOKE' }]);
    assert.deepEqual(validSpec(p), []);
    // the coverage rows: tree (T-cov-OWNER) and headpatched (P-OWNER-HP, D-b124-1: a cov-off control, 0 BREACH), exit 3
    for (const [n, b] of [['T-cov-OWNER', 'tree'], ['P-OWNER-HP', 'headpatched']]) {
        const t = CONTROLS.find((x) => x.name === n);
        assert.ok(t && SHORT_RE.test(n), n);
        assert.deepEqual([t.run, t.base, t.env, t.argv, t.patches, t.arm, t.expect.exit, t.expect.kind, t.expect.lines, t.expect.specs],
            ['main', b, OW_COV_ENV, ['--smoke'], [], null, 3, 'nobreach', [OW_COV_LINE], ['INCONCLUSIVE scenario lane=OWNER missing=cleanup-fifo']], n);
        assert.deepEqual(validSpec(t), [], n);
    }
    // each mutant: an exactly-once anchor in the live Signal.js, the b125 mutant's exact text, P-OWNER-TREE's shape
    assert.deepEqual(CONTROLS.filter((x) => x.name.indexOf('T-owner-') === 0).map((x) => x.name), names, 'OW_ROWS names every T-owner-* row, in order');
    const base = readFileSync(join(ROOT, 'Signal.js'), 'utf8');
    for (const [name, anchor, repl, specs] of OW_ROWS) {
        const c = CONTROLS.find((x) => x.name === name);
        assert.ok(c && SHORT_RE.test(name), name + ' exists in the short battery');
        assert.deepEqual([c.run, c.base, c.env, c.argv, c.arm, c.expect.exit, c.expect.kind, c.expect.lines, c.expect.specs], ['main', 'tree', OW_ENV, ['--smoke'], null, 1, 'match', [], specs], name);
        assert.deepEqual(validSpec(c), [], name);
        assert.deepEqual(c.patches, [[anchor, repl]], name);
        assert.equal(base.split(anchor).length - 1, 1, name + ': the anchor occurs exactly once in Signal.js');
        const k = buildKernel(c).src;
        assert.equal(k, base.replace(anchor, () => repl), name + ': the kernel = Signal.js with exactly that hunk replaced');
        const a = base.split('\n'), b = k.split('\n');
        assert.equal(a.length, b.length, name + ': line count kept');
        assert.equal(a.filter((x, i) => x !== b[i]).length, anchor.split('\n').length - 1, name + ': only the anchored line(s) differ');
    }
    assert.deepEqual(pairing(CHECKS, CONTROLS), []);
    // must-fail: fifo's spec moved to callback-this no longer backs sig:OW:cleanup-order; a lane=HOOK spec not lane:OWNER
    const ctl = copy(CONTROLS);
    const ff = ctl.find((x) => x.name === 'T-owner-fifo');
    ff.expect.specs = [OW('OW', 'callback-this')];
    assert.deepEqual(pairing(CHECKS, ctl), ['sig:OW:cleanup-order: T-owner-fifo -- no BREACH spec naming oracle=OW with sig in cleanup-order']);
    ff.expect.specs = ['oracle=OW lane=HOOK sig=cleanup-order known=none'];
    assert.deepEqual(pairing(CHECKS, ctl), ['lane:OWNER: T-owner-fifo -- no BREACH spec naming lane=OWNER']);
    // must-fail: a T-owner row dropped from CHECKS is an orphan; the registry without the OWNER CHECKS leaves all four ids uncovered
    const c1 = copy(CHECKS);
    for (const id of Object.keys(c1)) c1[id] = c1[id].filter((n) => n !== 'T-owner-this');
    hasProblem(live({ checks: c1 }), 'orphan control: T-owner-this');
    const c2 = copy(CHECKS);
    for (const id of NEW) delete c2[id];
    const probs = live({ checks: c2 });
    for (const id of NEW) hasProblem(probs, 'uncovered: ' + id + ' has no CHECKS control, no GAP and no UNREACHABLE proof');
    // must-fail: a GAP that still covers node-count beside its CHECKS tooth is stale
    const g3 = copy(GAPS);
    g3['T-O5-counts'].covers = g3['T-O5-counts'].covers.concat(['sig:O5:node-count']);
    hasProblem(live({ gaps: g3 }), 'stale GAP: T-O5-counts covers sig:O5:node-count, which has CHECKS');
});
