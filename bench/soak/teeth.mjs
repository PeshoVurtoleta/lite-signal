/**
 * @zakkster/lite-signal soak -- the TEETH REGISTRY (SPEC-B v2 section 9; S1cd TASK 10; addendum 9(a)/(b),
 * amendment 9a).
 *
 * Which must-fail control proves each judged id red, which ids have no control yet (GAPS, may only shrink),
 * and which ids no input can reach (UNREACHABLE, with a proof and an exactly-once anchor). Pure data plus pure
 * functions: importing it runs nothing, and it imports no control list. Consumers IMPORT these tables, never
 * copy them: test/45 (the meta-test; it passes _mustfail.mjs CONTROL_NAMES and its own literal GAPS ceiling and
 * size into audit()), SoakReport (the `NOTE -- teeth GAP` line), CI.
 *
 *   universe()   the judged ids, built by import from the code: lane:<ROSTER>, gate:<GATE_NAMES>,
 *                oracle:<ORACLES>, sig:<oracle>:<sig> (oracles.mjs SIGS), cause:<INCONCLUSIVE_CAUSES keys>,
 *                plus `config` and `report`.
 *   CHECKS       id -> [control names]. A name ending in `*` is a prefix pattern that must resolve to EVERY
 *                control of that prefix (T-cfg-*: the config controls); a name starting with `test/` is a test
 *                file whose anchors (TEST_ANCHORS) are checked instead of a _mustfail control.
 *   GAPS         control name -> { why (file:line), until, covers: [universe ids it stands in for] }.
 *                covers [] = a planned control outside this universe (pass controls, fix-minus-one, S2 lanes).
 *   UNREACHABLE  id -> { proof, anchor: { file, text } }; text occurs EXACTLY once in file.
 *   audit(opts)  the list of problems (empty = consistent). REQUIRED: controls (the _mustfail control names),
 *                ceiling (the literal GAPS name list) and max (its size); audit() never defaults them, so the
 *                ceiling lives in the test, not next to GAPS. Reads only the anchor files.
 *
 * NOT in the universe (each excluded on purpose):
 *   - REPORT_ONLY_GATES (gates.mjs:427): recorded, never judged; none can make a run FAIL or INCONCLUSIVE.
 *   - REASONS (gates.mjs:645): the verdict's input vocabulary (end / signal / fatal), a run fact and not a
 *     judgement; its outcomes are judged through cause:interrupted and test/46's verdict rows.
 *   - WRAP_CHECKS (config.mjs:140, W1-W5): the checks of ONE judged id, gate:wrap (wraprules.mjs WRAP_GATE, S2),
 *     not ids of their own. gate:wrap's teeth are L-REV-AUDIT-W5 (W5), L-WRAP-TREE (W1 / W3 / W4) and
 *     L-WRAP-W2-PREFIXR (W2, pre-FIX-R kernel prefixr); its causes cause:wrap-crossing / cause:wrap-unmeasured
 *     are held by test/48's quoted rows. The fix-minus-one controls T-A3b/T-A3c/T-A4/T-A7a/T-A7b stay GAPS.
 *   - SOAK_NEARWRAP (nearwrap.mjs, zero:k / sign:k): a kernel knob (it presets the census counters near a
 *     ceiling), not a judged id. Its end-to-end tooth is L-NW-hp-zero, a second lane:GRAPH control (headpatched at
 *     zero:8 breaches GRAPH through F29).
 *   - MUSTFAIL_MODES (config.mjs:106, cov-off): teeth knobs, the mechanism of the T-cov-* / P-NEST-TRIGGERLESS
 *     controls rather than a judged id; the parser is held by T-cfg-mustfail-unknown.
 *
 * COLD module. Kernel-free.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { GATES, GATE_NAMES, INCONCLUSIVE_CAUSES } from './gates.mjs';
import { ORACLES, SIGS } from './oracles.mjs';
import { ROSTER } from './lanes/index.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

function deepFreeze(o) {
    if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
}

/** Every judged id, derived by import (never a list). */
export function universe() {
    return ROSTER.map((n) => 'lane:' + n)
        .concat(GATE_NAMES.map((n) => 'gate:' + n))
        .concat(ORACLES.map((n) => 'oracle:' + n))
        .concat(...ORACLES.map((o) => (own(SIGS, o) ? SIGS[o] : []).map((g) => 'sig:' + o + ':' + g)))
        .concat(Object.keys(INCONCLUSIVE_CAUSES).map((n) => 'cause:' + n))
        .concat(['config', 'report']);
}

const T_COV = ['T-cov-BATCH', 'T-cov-GRAPH', 'T-cov-ERROR'];
const TEST46 = 'test/46-soak-report.test.mjs';
const TEST48 = 'test/48-soak-wrap.test.mjs';
const TEST67 = 'test/67-soak-taint.test.mjs';

/** id -> the must-fail controls (by NAME; _mustfail.mjs CONTROLS owns them) that turn it red. */
export const CHECKS = deepFreeze({
    // A-B3b (burst 84): L-NW-hp-zero heads `oracle=O1 lane=GRAPH` (headpatched + SOAK_NEARWRAP=zero:8: F29, gV hits 0)
    // b89 (PLAN-0s-bb6 ADDENDUM 1): T-flushdrop (flushEffects drops every 64th effect) heads `oracle=O4 lane=GRAPH
    // sig=effect-dead` + `oracle=O1 lane=GRAPH sig=effect-stale` (2/2 smoke runs, .handoff/b89-evidence/flushdrop/)
    'lane:GRAPH': ['T-sever', 'L-NW-hp-zero', 'T-flushdrop'],
    'lane:BATCH': ['L-REV-152'],
    'lane:ERROR': ['L-REV-152'],
    'lane:NEST': ['L-REV-AUDIT', 'L-REV-152'],
    // unit 0s B2 (DIV-B33): preb33 predates the F-b33-1 write-in-eval fix, so its WIE lane heads
    // `oracle=O1 lane=WIE sig=effect-stale known=DIV-B33` (b65 census: O1e heads 9490 of 10000 preb33 worlds)
    // b75 (PLAN-0s-e TASK 5): the published 1.5.2 also predates F-b33-1 -- L-WIE-rev152, same O1e head, DIV-B33
    'lane:WIE': ['L-WIE-preb33', 'L-WIE-rev152'],
    // b93 S3 R1c (PLAN-0s-s3-r1 TASK 9): rev152 heads `oracle=O8 lane=HOOK sig=ghost-listener known=DIV-F9` (F9, LIFO-only
    // off); T-hook-mirror (headpatched, freeLink's op-4 hook fire removed) heads `oracle=O8 lane=HOOK sig=mirror-links`
    'lane:HOOK': ['L-REV-HOOK', 'T-hook-mirror'],
    'gate:oracle': ['L-REV-152'],
    // B-B3b (burst 82): a second heap tooth of another kind -- L-T-leak retains foreign arrays per createNode,
    // L-T-graveyard the engine's own released ReactiveLinks (freeLink never refills the free list)
    'gate:heap': ['L-T-leak', 'L-T-graveyard'],
    'gate:rss': ['L-T-rss'],
    'gate:retention': ['L-T-retain'],
    'gate:coverage': T_COV.slice(),
    'gate:check-floor': ['T-floor-BATCH'],
    // b71 (PLAN-0s-d6 ADDENDUM 1 item 2): under D6 V1 the headpatched NEST cov-off no longer trips taint-skip, so
    // P-NEST-TRIGGERLESS is the coverage gate's case only; THE taint-skip must-fail is P-NEST-TAINT-HALF (a gate id
    // takes a _mustfail control, never a test file: test/45 pairing)
    'gate:taint-skip': ['P-NEST-TAINT-HALF'],
    // L-REV-152 BATCH heads `oracle=O1 lane=BATCH sig=computed-mismatch` / `sig=effect-stale` and
    // `oracle=O2 lane=BATCH sig=glitch` (f21-census.json:96, every 1.5.2 BATCH world); the O1 family is told
    // apart by its sig (oracles.mjs:30-31)
    'oracle:O1c': ['L-REV-152'],
    'oracle:O1e': ['L-REV-152', 'T-flushdrop'],
    'oracle:O2': ['L-REV-152'],
    // L-REV-152 ERROR heads `oracle=O4 lane=ERROR sig=effect-dead` (f21-census.json:23-24) and
    // `oracle=O6 lane=ERROR sig=expected-escape-missing` (f21-census.json:25, :28-29)
    'oracle:O4': ['L-REV-152', 'T-flushdrop'],
    // a future second O5 tooth: rev152 / headpatched NEST also emit O5 link-count (the planned L-REV-AUDIT spec,
    // SPEC-B.md:454); not mapped until its 3/3 calibration lands
    'oracle:O5': ['T-sever'],
    'oracle:O6': ['L-REV-152'],
    'oracle:O7a': ['L-REV-152'],
    'oracle:O8': ['L-REV-HOOK', 'T-hook-mirror'],
    'sig:O1c:computed-mismatch': ['L-REV-152'],
    'sig:O1e:effect-stale': ['L-REV-152', 'T-flushdrop'],
    'sig:O2:glitch': ['L-REV-152'],
    'sig:O4:effect-dead': ['L-REV-152', 'T-flushdrop'],
    'sig:O6:expected-escape-missing': ['L-REV-152'],
    'sig:O5:link-count': ['T-sever'],
    'sig:O6:escape-*': ['L-REV-152'],   // `oracle=O6 lane=ERROR sig=escape-computed`
    'sig:O7a:dead-registration-fire': ['L-REV-152'],
    'sig:O8:ghost-listener': ['L-REV-HOOK'],
    'sig:O8:mirror-links': ['T-hook-mirror'],
    'cause:interrupted': ['L-I1', 'L-I2'],
    'cause:scenario': T_COV.concat(['P-NEST-TRIGGERLESS']),
    'cause:check-floor': ['T-floor-BATCH'],
    // test/67 drives the same patch on live AND headpatched NEST and checks each line is inconclusiveLine('taint-skip')
    'cause:taint-skip': ['P-NEST-TAINT-HALF', TEST67],
    // S2 wrap gate (wrap.mjs): W5 evalCount past 2^31 on headpatched; W1 / W3 / W4 on the tree kernel; W2 on prefixr (pre-FIX-R 25784e5, A6)
    'gate:wrap': ['L-REV-AUDIT-W5', 'L-WRAP-TREE', 'L-WRAP-W2-PREFIXR'],
    // no frozen kernel leaves a crossing unwitnessed or a W5 side unmeasured (burst 25: 0 INCONCLUSIVE on 3 kernels),
    // so the wrap causes' teeth are test/48 rows that drive wrapRule / inconclusiveLine to each cause by name
    'cause:wrap-crossing': [TEST48],
    'cause:wrap-unmeasured': [TEST48],
    'config': ['T-cfg-*'],
    'report': [TEST46],
});

/** Test-file teeth: file -> strings that must each occur (quoted, '<s>') at least once. The R-tamper classes of test/46; the wrap causes of test/48; the taint-skip cause of test/67. */
export const TEST_ANCHORS = deepFreeze({
    [TEST46]: ['cycle-grid', 'failure-count', 'seq-gap', 'fatal-after-summary', 'gates-block', 'verdict',
        'scenario-counts', 'summary-missing', 'overridden-kernel', 'non-lite', 'known-tag', 'malformed'],
    // the wrap causes test/48 drives by name (CHECKS cause:wrap-*; test/45 pairs each cause with this list)
    [TEST48]: ['wrap-crossing', 'wrap-unmeasured'],
    // the taint-skip cause test/67 drives by name (P-NEST-TAINT-HALF on live + headpatched; CHECKS cause:taint-skip)
    [TEST67]: ['taint-skip'],
});

const SPEC = 'audit/2026-10-07/verification/SPEC-B.md';
const S1CD = 'audit/2026-10-07/verification/SPEC-B-S1cd-batches.md';
const F21 = 'bench/soak/calibration/f21-census.json';
const fixMinusOne = (row, until, more) => ({ why: 'fix-minus-one control; the engine fix has not landed, so there is no anchor to revert (' + SPEC + ':' + row + ')' + (more === undefined ? '' : '; ' + more), until, covers: [] });
const NEARWRAP_WHY = 'SOAK_NEARWRAP presets the counter near its ceiling, so the revert runs end to end once the fix lands';

/** Controls the SPEC asks for that do not exist yet. covers = the universe ids whose ONLY teeth this would be. */
export const GAPS = deepFreeze({
    'P-TREE': { why: 'pass control on the tree kernel: the tree is expected red until A1-A3 land (' + SPEC + ':511, section 10.3)', until: 'A1-A3', covers: [] },
    'P-NEST': { why: 'pass control tree/NEST: declared GAP; A1 cannot land until it is live and green (' + SPEC + ':511, :544)', until: 'A1', covers: [] },
    'T-A1': fixMinusOne(513, 'A1'),
    'T-A2': fixMinusOne(514, 'A2'),
    'T-A3a': fixMinusOne(515, 'A3'),
    'T-A3b': fixMinusOne(516, 'A3 + S2 wrap.mjs', NEARWRAP_WHY),
    'T-A3c': fixMinusOne(517, 'A3 + S2 wrap.mjs'),
    'T-A4': fixMinusOne(518, 'A4 + S2 wrap.mjs'),
    'T-A5a': fixMinusOne(519, 'A5 + S3 LIFECYCLE lane'),
    'T-A5b': fixMinusOne(520, 'A5 + S3 HOOK lane'),
    'T-A6': fixMinusOne(521, 'A6 + S3 REGISTRY lane'),
    'T-A7a': fixMinusOne(522, 'A7 + S2 wrap.mjs + S3 RECYCLE lane', NEARWRAP_WHY),
    'T-A7b': fixMinusOne(523, 'A7 + S2 wrap.mjs', NEARWRAP_WHY),
    'T-d8pc-head': { why: 'the d8-pc engine lane is placed in S2 (' + S1CD + ':7, amendment 4)', until: 'S2', covers: [] },
    'T-OB-lying-adapter': {
        why: 'OB fired in 0/6000 census worlds on headpatched, tree and 1.5.2 (bench/soak/calibration/ob-census.json); the red case is an adapter whose batch is fn => fn(), and main.mjs:276 loads only liteS3Adapter (adapters/lite-s3.mjs, the S3 decorator over the lite adapter; no second adapter seam)',
        until: 'S5 adapters', covers: ['oracle:OB', 'sig:OB:batch-early-run'],
    },
    'T-OB-nested-close': {
        why: 'exec.mjs:383 marks only the OUTERMOST close (depth 1); no in-tree kernel flushes at a nested batch close, so only a reviewer mutant kernel reaches exec.mjs:389 did(\'OB\') that way',
        until: 'a pinned nested-flush control kernel (controls.json)', covers: ['oracle:OB'],
    },
    'totals-e2e': {
        why: 'gates.mjs:355 totals has teeth null: its unit must-fail (PipeZeroTotals, gates.mjs:279) runs at startup, but an end-to-end red needs a run total past 2^31',
        until: 'long soak (NEARWRAP presets engine counters, not run totals)', covers: ['gate:totals'],
    },
    'T-O1c-err': {
        why: 'computed-err-mismatch fired in 4 unclassified 1.5.2 ERROR worlds of 4000 (' + F21 + ':32, seeds :37): too rare for a spec; no control pins it',
        until: 'a control kernel whose computed throws a different error', covers: ['sig:O1c:computed-err-mismatch'],
    },
    'T-O5-counts': {
        why: 'only link-count is seen on a frozen kernel (' + F21 + ':98, NEST 1.5.2; T-sever); node-count, kind-count and teardown-residue (oracles.mjs:34) have no known red kernel',
        until: 'a mutant kernel per count (node leak, kind flip, teardown residue)', covers: ['sig:O5:node-count', 'sig:O5:kind-count', 'sig:O5:teardown-residue'],
    },
    'T-O6-shape': {
        why: 'equals-mutated (exec.mjs:346) and escape-empty (exec.mjs:211) have no known red kernel; no census row names them',
        until: 'a mutant kernel (equals throw that still writes; an empty escape leaf list)', covers: ['sig:O6:equals-mutated', 'sig:O6:escape-empty'],
    },
    'T-no-lane': { why: 'lite with a SKIP exits 2 (gates.mjs:564) and SOAK_LANES never parses empty (config.mjs:242), so no-lane (gates.mjs:569) needs a non-lite engine', until: 'S5 adapters', covers: ['cause:no-lane'] },
    'T-post-cycles': { why: 'config.mjs:364 floors SOAK_CYCLES at MIN_ACTIVE_CYCLES, so post-cycles fires only on an interrupted or forever (SOAK_CYCLES=0) run stopped early; no control pins that line', until: 'a forever-run SIGINT control', covers: ['cause:post-cycles'] },
    'R-kernel-identity': { why: 'kernel identity is self-reported: a consistent 5-field forgery of a scratch stream as a tree run exits 0 (SoakReport.mjs:70 RESIDUALS); signing is out of scope', until: 'S4 stream signing', covers: [] },
});

/** Ids no input can reach, each with a proof and an anchor that must occur EXACTLY once. */
export const UNREACHABLE = deepFreeze({
    'cause:lane-status': {
        proof: 'judgeRun adds lane-status only for an INCONCLUSIVE lane with zero causes. LaneGates.compute sets INCONCLUSIVE only from an I gate, and every I gate pushes a cause: heap I -> post-cycles, coverage I iff missing[] non-empty -> scenario, check-floor I iff below[] non-empty or empty -> check-floor, taint-skip I iff over[] non-empty -> taint-skip; oracle and retention never return I. A fail-closed guard, kept.',
        anchor: { file: 'bench/soak/gates.mjs', text: "if (L.status === I && L.causes.length === 0) causes.push({ cause: 'lane-status', lane: L.lane });" },
    },
    'replay-ops-guard': {
        proof: 'replay.mjs imports runWorld statically from exec.mjs (no adapter can replace it); Exec.run counts each op (exec.mjs:143 opsRun++) BEFORE applying it (:146), so a world that returns has ops >= 1, a throwing one is caught above the guard, and every lane init pushes >= 6 ops (lanes/nest.mjs:117, the smallest).',
        anchor: { file: 'bench/soak/replay.mjs', text: 'if (!(Number.isSafeInteger(r.ops) && r.ops >= 1)) {' },
    },
    'report-crash': {
        proof: 'unreachable from argv or a stream: every throw report() can meet there is Integrity / Refusal (bad / refuse), GateInputError, TypeError or RangeError (gates.mjs, Totals, built-ins on a bad type), all mapped before CRASH, and classify\'s plain Errors are caught as known-tag. Reachable only from a corrupted checkout (controls.json / parity.json unreadable or unparsable in checkHeader / checkRelease) or a report bug (untested).',
        anchor: { file: 'bench/soak/SoakReport.mjs', text: "return { exitCode: 1, out, err: ['soak:report: CRASH -- '" },
    },
    'report-registry-config': {
        proof: 'unreachable from argv or a stream: REGISTRY_PROBLEMS is computed at import from this tree\'s divergences.json (divergences.mjs REGISTRY_URL, module-relative). Reachable only from a corrupted checkout (untested).',
        anchor: { file: 'bench/soak/SoakReport.mjs', text: 'if (REGISTRY_PROBLEMS.length > 0) return config(' },
    },
});

/** Does control `name` (or prefix pattern `X-*`) name something in `controls`? Returns the matches. */
export function controlMatches(name, controls) {
    if (name.endsWith('*')) {
        const pre = name.slice(0, -1);
        return controls.filter((c) => c.startsWith(pre));
    }
    return controls.indexOf(name) === -1 ? [] : [name];
}

/**
 * The hard gates and oracles whose only teeth are GAPS: { gate: [GATE_NAMES order], oracle: [ORACLES order] }
 * (an id a GAP covers that has no CHECKS entry). SoakReport prints it on its NOTE line.
 */
export function gapTeeth(gaps, checks) {
    const G = gaps === undefined ? GAPS : gaps;
    const C = checks === undefined ? CHECKS : checks;
    const covered = new Set();
    for (const k of Object.keys(G)) for (const id of G[k].covers) covered.add(id);
    const only = (id) => covered.has(id) && !own(C, id);
    return { gate: GATE_NAMES.filter((n) => only('gate:' + n)), oracle: ORACLES.filter((n) => only('oracle:' + n)) };
}

function countIn(text, needle) {
    let n = 0;
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
    return n;
}

/**
 * Prefix families of controls: every control whose name starts with the prefix must be resolved by that id's
 * CHECKS, and the family holds at least `min` controls (T-cfg x16: SPEC-B.md:462).
 */
const FAMILIES = deepFreeze({ 'T-cfg-': { id: 'config', min: 16 } });

const isNames = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.length > 0);

/**
 * Audit the registry. opts:
 *   REQUIRED  controls: [the _mustfail control names]; ceiling: [the literal GAPS names]; max: their count (a safe
 *             integer). Missing or malformed is a problem, never a skipped check; never defaulted from this file.
 *   optional  universe, gates, checks, gaps, unreachable, testAnchors, root (defaults: the live tables / repo root;
 *             for mutation tests).
 * Returns an array of problem strings (empty = consistent).
 */
export function audit(opts) {
    const o = opts || {};
    const uni = o.universe === undefined ? universe() : o.universe;
    const gates = o.gates === undefined ? GATES : o.gates;
    const checks = o.checks === undefined ? CHECKS : o.checks;
    const gaps = o.gaps === undefined ? GAPS : o.gaps;
    const unreachable = o.unreachable === undefined ? UNREACHABLE : o.unreachable;
    const testAnchors = o.testAnchors === undefined ? TEST_ANCHORS : o.testAnchors;
    const root = o.root === undefined ? ROOT : o.root;
    const probs = [];
    const read = (file) => { try { return readFileSync(join(root, file), 'utf8'); } catch (e) { return null; } };
    const controls = isNames(o.controls) && o.controls.length > 0 ? o.controls : null;
    if (controls === null) probs.push('controls must be a non-empty array of control names (the _mustfail CONTROL_NAMES), got ' + typeof o.controls);
    const ceiling = isNames(o.ceiling) ? o.ceiling : null;
    if (ceiling === null) probs.push('ceiling must be the literal array of GAPS names (GAPS may only shrink), got ' + typeof o.ceiling);
    else if (new Set(ceiling).size !== ceiling.length) probs.push('ceiling lists a GAP twice');
    if (!Number.isSafeInteger(o.max)) probs.push('max must be a safe integer (the literal GAPS size), got ' + String(o.max));

    const gapCovers = new Set();
    for (const g of Object.keys(gaps)) {
        const e = gaps[g];
        if (!(e && typeof e.why === 'string' && e.why.length > 0 && typeof e.until === 'string' && Array.isArray(e.covers))) { probs.push('GAP ' + g + ' must be {why, until, covers[]}'); continue; }
        for (const id of e.covers) gapCovers.add(id);
    }
    // 1. every judged id has teeth, a GAP or an unreachability proof
    for (const id of uni) {
        if (!own(checks, id) && !gapCovers.has(id) && !own(unreachable, id)) probs.push('uncovered: ' + id + ' has no CHECKS control, no GAP and no UNREACHABLE proof');
    }
    // 2. CHECKS speaks only of the code's ids (universe drift) and never names nothing
    for (const id of Object.keys(checks)) {
        if (uni.indexOf(id) === -1) probs.push('CHECKS id ' + id + ' is not in the universe (drifted from the code)');
        if (!(isNames(checks[id]) && checks[id].length > 0)) probs.push('CHECKS ' + id + ' lists no control');
    }
    // 3. stale GAPS; the ceiling is EXACTLY the GAPS names and max EXACTLY their count (a landing edits the test literal)
    const used = new Set();
    for (const id of Object.keys(checks)) if (isNames(checks[id])) for (const c of checks[id]) used.add(c);
    for (const g of Object.keys(gaps)) {
        const e = gaps[g];
        if (used.has(g)) probs.push('stale GAP: ' + g + ' is a CHECKS control');
        if (controls !== null && controls.indexOf(g) !== -1) probs.push('stale GAP: ' + g + ' is a _mustfail control');
        for (const id of (e && Array.isArray(e.covers) ? e.covers : [])) {
            if (uni.indexOf(id) === -1) probs.push('GAP ' + g + ' covers ' + id + ', which is not in the universe');
            else if (own(checks, id)) probs.push('stale GAP: ' + g + ' covers ' + id + ', which has CHECKS');
        }
        if (ceiling !== null && ceiling.indexOf(g) === -1) probs.push('GAP ' + g + ' is not in the ceiling (GAPS may only shrink)');
    }
    if (ceiling !== null) for (const g of ceiling) if (!own(gaps, g)) probs.push('ceiling lists ' + g + ', which is no GAP any more: shrink the ceiling literal');
    const n = Object.keys(gaps).length;
    if (Number.isSafeInteger(o.max)) {
        if (!(n <= o.max)) probs.push('GAPS holds ' + n + ' entries > max ' + o.max + ' (GAPS may only shrink)');
        else if (n !== o.max) probs.push('GAPS holds ' + n + ' entries < max ' + o.max + ': decrement the max literal');
    }
    // 4. every gate's declared teeth is a CHECKS control of that gate
    for (const g of gates) {
        if (g.teeth === null) continue;
        const list = own(checks, 'gate:' + g.id) ? checks['gate:' + g.id] : [];
        if (!(Array.isArray(list) && list.indexOf(g.teeth) !== -1)) probs.push('gate ' + g.id + ' teeth ' + String(g.teeth) + ' is missing from CHECKS gate:' + g.id);
    }
    // 5. control names resolve; a pattern resolves to its whole family; test-file teeth keep their anchors
    for (const name of used) {
        if (name.indexOf('test/') === 0) {
            if (!own(testAnchors, name)) { probs.push('test teeth ' + name + ' has no TEST_ANCHORS entry'); continue; }
            const text = read(name);
            if (text === null) { probs.push('test teeth ' + name + ' cannot be read'); continue; }
            for (const a of testAnchors[name]) if (countIn(text, "'" + a + "'") === 0) probs.push('stale anchor: ' + name + ' never names \'' + a + '\'');
        } else if (controls !== null && controlMatches(name, controls).length === 0) {
            probs.push('unknown control ' + name + (name.endsWith('*') ? ' (the pattern matches no control)' : ''));
        }
    }
    if (controls !== null) {
        for (const pre of Object.keys(FAMILIES)) {
            const id = FAMILIES[pre].id;
            const fam = controls.filter((c) => c.indexOf(pre) === 0);
            if (!(fam.length >= FAMILIES[pre].min)) probs.push('control family ' + pre + '* holds ' + fam.length + ' controls < ' + FAMILIES[pre].min);
            const list = isNames(checks[id]) ? checks[id] : [];
            const got = new Set();
            for (const name of list) for (const c of controlMatches(name, controls)) got.add(c);
            for (const c of fam) if (!got.has(c)) probs.push('control ' + c + ' is not resolved by CHECKS ' + id);
        }
    }
    // 6. UNREACHABLE: a proof and an exactly-once anchor
    for (const id of Object.keys(unreachable)) {
        const u = unreachable[id];
        if (!(u && typeof u.proof === 'string' && u.proof.length > 0 && u.anchor && typeof u.anchor.file === 'string' && typeof u.anchor.text === 'string' && u.anchor.text.length > 0)) {
            probs.push('UNREACHABLE ' + id + ' must be {proof, anchor: {file, text}}');
            continue;
        }
        const text = read(u.anchor.file);
        const k = text === null ? -1 : countIn(text, u.anchor.text);
        if (k !== 1) probs.push('stale anchor: UNREACHABLE ' + id + ' text occurs ' + (k === -1 ? 'nowhere (file unreadable)' : k + ' times') + ' in ' + u.anchor.file + ' (want exactly 1)');
    }
    return probs;
}
