/**
 * @zakkster/lite-signal soak -- SoakReport: integrity re-derivation of one burn-in JSONL stream
 * (SPEC-B v2 sections 7-9, row R-tamper x10; S1cd TASK 9).
 *
 *   node bench/soak/SoakReport.mjs <stream.jsonl>           (npm run soak:report -- <stream.jsonl>)
 *
 * load -> integrity -> re-derive -> print. Nothing in the stream is trusted that can be re-derived: the run
 * verdict, every perLane entry, the INCONCLUSIVE lines and the gate breaches come from gates.mjs (LaneGates +
 * judgeRun, the code main.mjs judged with); the oracle BREACH entries are rebuilt with main.mjs's BreachLog;
 * every failure record's known/tag/failKnown comes from divergences.classify, every cycle and world seed from
 * seeds.mjs; the header `gates` block must equal this code's gatesBlock(). A field the checks read that is
 * missing or non-numeric fails CLOSED (absent is never 0, S12), and every record (plus its failure, fail,
 * boundary, memory, rss, latency (+ each latency.<method> entry), anatomy (+ anatomy.counts), gc, throughput and BREACH
 * sub-objects) must carry EXACTLY
 * the keys main/provenance emit:
 * an unknown key is `unknown-key`, a missing one `missing-key`. Header sub-objects (os, engine.caps, ...)
 * are not key-checked.
 *
 * Exit codes and lines (report lines on stdout, refusals on stderr):
 *   0  `soak:report: verdict <V> (consistent)`   the stream re-derives to its own verdict (any V, FAIL too)
 *      and is a release soak or a pinned control-kernel run (header.controls.name, re-verified here); a
 *      control run prints `soak:report: NOTE -- control kernel <name>, not release evidence` before the verdict
 *   1  `soak:report: INTEGRITY -- <class>: <detail>`   the first failing check, in the precedence below
 *   1  `soak:report: NOT A RELEASE SOAK -- <reason>: <detail>`   consistent (the verdict line is printed
 *      first) but not release evidence
 *   1  `soak:report: CRASH -- <stack>`   a report bug (never exit 0, never mistaken for INTEGRITY)
 *   2  `soak:report: CONFIG -- <msg>`   no path, an extra/unknown argument, a missing or unreadable file, or
 *      this tree's divergences.json is invalid (an environment problem, not a stream defect)
 *
 * INTEGRITY classes, in PRECEDENCE order (the first that fails is the one reported; within a class the
 * first record in stream order):
 *   parse, seq-invalid, seq-duplicate, seq-gap, record-type, unknown-key, header, summary-missing,
 *   summary-duplicate, fatal-after-summary, after-summary, fatal-placement,      (stream structure)
 *   gates-block, registry, control, header-lanes,                                (header vs this code)
 *   cycle-grid, cycle-field, scenario-counts, failure-count, failure-records, known-tag,   (cycles)
 *   totals, verdict, per-lane, inconclusive, breaches, missing-key               (summary vs re-derivation)
 *   malformed   a value that slipped past the field checks and made gates.mjs / classify throw
 * gates-block and registry cannot tell a tampered header from an honest stream recorded under different
 * code (B6 moves constants): both are refused, and the detail says so (SPEC-B :92).
 * NOT A RELEASE SOAK reasons, checked only on a consistent stream, in order:
 *   mustfail (SOAK_MUSTFAIL teeth knob, SPEC-B 5.1), smoke, non-lite (an engine other than lite, incl.
 *   PARTIAL skips), nearwrap (header.nearwrap non-null: a NEARWRAP kernel, refused on its own even when the
 *   kernel sha256 matches the pin), overridden-kernel (SOAK_KERNEL that is no pinned control), tree-parity (a tree-kernel run
 *   whose Signal.js / Watch.js sha256 differ from bench/soak/parity.json -- recorded under different code --
 *   or whose header parity was not ok); then, on a TREE run only (a pinned control kernel stops after
 *   overridden-kernel: it is never release evidence, and its NOTE line says so), the release policy
 *   (maintainer decision c, 2026-10-13: the full roster, at default volume, on a clean committed tree):
 *   lane-subset (the header.lanes that ran != header.laneRoster, or laneRoster != lanes/index.mjs ROSTER),
 *   volume (SOAK_OPS < config DEFAULT_OPS, or fewer than config DEFAULT_CYCLES COMPLETED cycles per lane:
 *   cycle records with interrupted false, the minimum over the lanes; a forever run, SOAK_CYCLES=0, counts the
 *   cycles it actually ran, like any other), provenance (gitSha not a commit sha, gitDirty !== false -- null
 *   is unknown, never clean -- or gitError non-null). The decision is the exported PURE releaseRefusal().
 *
 * Kernel identity (control class): kernel.override must agree with config SOAK_KERNEL (null <=> no override).
 * A plain override's resolved path must equal realpath(SOAK_KERNEL value) when that resolves on this host, or end
 * with the value (leading ./ ../ / stripped). kernel.mjs realpath-resolves the value, so a symlinked value
 * that does not resolve here (another host) is refused, fail closed.
 * A NEARWRAP run (header.nearwrap non-null; tree or override) loads the DERIVED pair kernel.mjs writes to
 * bench/soak/out/nearwrap/<derived7>-<watch7>/{Signal,Watch}.js, never the SOAK_KERNEL value itself:
 * nearwrap.derivedSha256 must equal kernel.files[0].sha256, the parent dir name must be the two sha256 prefixes
 * and kernel.files[1] its sibling Watch.js. On an override the base is read on THIS host: realpath(SOAK_KERNEL
 * value) and its sibling Watch.js (no suffix fallback: a value that does not resolve, or is not a regular file, is
 * refused, fail closed), and nearwrap.baseSha256 must equal the sha256 of the base's utf8-decoded text (the hash
 * nearwrap.mjs records), kernel.files[1].sha256 the raw-byte sha256 of the sibling Watch.js (the derived Watch.js
 * is a byte copy of it). Only then is the stream consistent, and refused as nearwrap.
 *
 * Teeth (SPEC-B addendum 9a): the hard gates and oracles whose only teeth are GAPS come from ./teeth.mjs
 * gapTeeth() by import (never copied); a consistent stream prints them on one stdout line
 * `soak:report: NOTE -- teeth GAP gate=<ids> oracle=<ids>` (`none` for an empty list), after the
 * `stream records=` line and before the verdict line, which stays the last stdout line (stdout order:
 * `stream records=`, teeth NOTE, control NOTE on a control run, verdict). REASONS is imported from gates.mjs;
 * DEFAULT_OPS / DEFAULT_CYCLES from config.mjs and ROSTER from lanes/index.mjs (never copied).
 * DEFERRED copied list: the RECORD_KEYS / SUB_KEYS tables copy the literal record shapes of main.mjs /
 * provenance.mjs / jsonl.mjs / boundary.mjs (no owner exports them). Since burst 13 main.mjs is not recut-pinned
 * (test/41's live smoke + large-world probe folds and parity.json guard it), so the export is merely not done
 * yet, no longer blocked. test/46's honest streams are the drift guard: a key added in main turns them red.
 *
 * RESIDUALS (not checked, stated plainly):
 *   - config keys beyond KNOWN_KEYS, engine.version, controls.error, parity.error and the gateHits names are
 *     read or passed through but not judged; header sub-objects (os, caps, ...) are not key-checked.
 *   - The kernel identity is SELF-REPORTED. A consistent forgery of a release-size scratch stream (full roster,
 *     default volume) as a tree run (override, SOAK_KERNEL, both kernel sha256, engine.files: five fields, plus
 *     gitSha / gitDirty / gitError when the scratch run was not on a clean committed tree) exits 0. The git
 *     fields are self-reported too. Signing / attestation of the stream is out of scope here: teeth.mjs GAP
 *     R-kernel-identity (S4).
 *   - A NEARWRAP derived pair is self-reported: derive(base) is never re-run here, so kernel.files[0] is
 *     trusted to be derive() of the verified base. Harmless: a nearwrap stream is always refused.
 *   - A TREE NEARWRAP run's baseSha256 and its derived Watch.js sha256 are self-reported (the base is the
 *     recording tree's Signal.js, not re-hashed here). Harmless: a nearwrap stream is always refused.
 *   - Release eligibility reads no verdict: a consistent release-size tree stream exits 0 whatever V it
 *     re-derives (FAIL too); the verdict line says which.
 *   - A forged BREACH entry with known null on a lane that has a capped cycle, for a family:sig that lane
 *     counted, is admitted: an unstored world could have produced it (the stream keeps FAIL_CAP per cycle).
 *   - Stale vs tampered: gates-block, registry and tree-parity cannot tell an honest stream recorded under
 *     other code from a forged one; they refuse both and say so.
 *   - The cycle rss sub-object (B-B3): only the post-warm-up rss.p95MB is judged (the rss gate, through
 *     LaneGates); warm-up rss and samples / maxMB / stride are key-checked but not judged.
 *   - The cycle latency sub-object (B-B4a, REPORT-ONLY): keyed by config.mjs LATENCY_METHODS, each entry
 *     {n, p50Ns, p99Ns, belowFloor}. Key-checked (an absent latency or entry is missing-key) and field-checked
 *     (cycle-field: counts, belowFloor <= n, each pXX null or a count, p50Ns <= p99Ns with p99Ns null -> p50Ns
 *     null; a present non-object latency or entry, or an absent field, fails cycle-field first); never judged.
 *   - The cycle anatomy sub-object (B-B4b, REPORT-ONLY): null, or {worlds, counts, markDedupe} with counts keyed by
 *     harness/visit-anchors.mjs NAMES (imported, never copied). Key-checked when an object (unknown / missing keys
 *     in anatomy and anatomy.counts); field-checked (cycle-field: a present value that is neither null nor an
 *     object, worlds a count >= 1, every present count a count, markStamp <= markEdge, markDedupe Object.is
 *     markStamp / markEdge, null when markEdge is 0); an absent key is missing-key's. Never judged; the counts
 *     are not re-derived (the shadow run is not replayed here).
 *
 * Imports are kernel-free (never kernel.mjs / provenance.mjs / adapters/lite.mjs). COLD module.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalize, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
    gatesBlock, writeLineSync, formatReplayKey, KNOWN_KEYS, SCHEMA_VERSION, GEN_VERSION, FAIL_CAP, WARMUP_CYCLES,
    CYCLES_MAX, EXIT_CODE, ENGINES_KNOWN, DEFAULT_OPS, DEFAULT_CYCLES, NEARWRAP_K_MAX, LATENCY_METHODS,
} from './config.mjs';
import { LaneGates, judgeRun, oracleFamily, GateInputError, REASONS } from './gates.mjs';
import { classify, digest, REGISTRY_URL, REGISTRY_PROBLEMS } from './divergences.mjs';
import { CHECK_NAMES, SKIP_NAMES } from './exec.mjs';
import { GEN_RULES } from './gen.mjs';
import { seedFor, worldSeed } from './seeds.mjs';
import { ROSTER, laneByName } from './lanes/index.mjs';
import { applicability } from './adapters/contract.mjs';
import { RECORD_TYPES, FATAL_KINDS } from './jsonl.mjs';
import { familyKeys, BreachLog } from './main.mjs';
import { gapTeeth } from './teeth.mjs';
import { NAMES as ANATOMY_NAMES } from '../../harness/visit-anchors.mjs';

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const json = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));   // the stream's view of a value (NaN -> null)
const uniq = (arr) => { const out = []; for (const x of arr) if (out.indexOf(x) === -1) out.push(x); return out; };
const TYPES = RECORD_TYPES['burn-in'];
// DEFERRED (see the file header): copies of the literal record shapes (main.mjs cycle / summary / failureRecord / BreachLog entry,
// provenance.mjs buildHeader, jsonl.mjs writeFatal + type/seq/tMs, boundary.mjs memory / gc).
const STAMP = ['type', 'seq', 'tMs'];
const RECORD_KEYS = {
    header: ['schemaVersion', 'genVersion', 'kind', 'pkgVersion', 'startedAt', 'gitSha', 'gitDirty', 'gitError', 'kernel', 'nearwrap', 'engine', 'parity',
        'controls', 'node', 'v8', 'execArgv', 'os', 'config', 'laneRoster', 'lanes', 'scenarios', 'oraclesNA', 'genRules', 'divergences',
        'mustfail', 'seedFormula', 'worldSeedFormula', 'seedRemapCollision', 'gates', 'timerFloorNs'].concat(STAMP),
    cycle: ['lane', 'laneIndex', 'cycle', 'warmup', 'seed', 'interrupted', 'worlds', 'largeWorlds', 'ops', 'opsByClass', 'checks', 'skipTainted',
        'failures', 'failureCounts', 'failingWorlds', 'scenarios', 'gateHits', 'throughput', 'memory', 'rss', 'latency', 'anatomy', 'boundary', 'gc'].concat(STAMP),
    summary: ['reason', 'cyclesRun', 'lanesRun', 'totals', 'perLane', 'breaches', 'inconclusive', 'skipped', 'smoke', 'verdict', 'exitCode'].concat(STAMP),
    fatal: ['kind', 'lane', 'cycle', 'world', 'worldSeed', 'message', 'stack'].concat(STAMP),
};
const SUB_KEYS = {
    failure: ['oracles', 'sigs', 'sig', 'known', 'tag', 'failKnown', 'world', 'worldSeed', 'step', 'op', 'fails', 'scen', 'worldScen', 'worldScenCounts',
        'escape', 'replay', 'detail'],
    fail: ['oracle', 'sig', 'detail'],
    boundary: ['lane', 'cycle', 'worlds', 'tracked', 'witnessed', 'trackerSize', 'weakAlive', 'forcedGcTries', 'drainMs', 'heapSampledAfterGc'],
    memory: ['heapUsedMB', 'arrayBuffersMB', 'residentMB', 'rssMB'],
    rss: ['samples', 'p95MB', 'maxMB', 'stride'],
    latency: LATENCY_METHODS.slice(),
    latencyEntry: ['n', 'p50Ns', 'p99Ns', 'belowFloor'],
    anatomy: ['worlds', 'counts', 'markDedupe'],
    anatomyCounts: ANATOMY_NAMES.slice(),
    gc: ['major', 'minor', 'maxPauseMs'],
    throughput: ['wallMs', 'opsPerSec'],
    breach: ['oracle', 'lane', 'sig', 'known', 'replay', 'scen', 'detail'],
    gateBreach: ['gate', 'lane', 'detail'],
};

class Integrity extends Error { constructor(cls, detail) { super(detail); this.cls = cls; } }
class Refusal extends Error { constructor(reason, detail) { super(detail); this.reason = reason; } }
/** Every check is ONE `bad('<class>', ...)` / `refuse(...)` STATEMENT; test/46 holds a tamper per statement. */
function bad(cls, detail) { throw new Integrity(cls, detail); }
function refuse(reason, detail) { throw new Refusal(reason, detail); }

/** [where, object, allowed keys] for every key-checked object of every record (containers of the wrong type are skipped: later checks own them). */
function keyedObjects(recs) {
    const out = [];
    for (const r of recs) {
        if (!own(RECORD_KEYS, r.type)) continue;
        out.push(['seq ' + r.seq + ' ' + r.type, r, RECORD_KEYS[r.type]]);
        if (r.type === 'cycle') {
            for (const k of ['boundary', 'memory', 'rss', 'latency', 'gc', 'throughput']) if (isObj(r[k])) out.push(['seq ' + r.seq + ' cycle.' + k, r[k], SUB_KEYS[k]]);
            if (isObj(r.latency)) for (const m of LATENCY_METHODS) if (isObj(r.latency[m])) out.push(['seq ' + r.seq + ' cycle.latency.' + m, r.latency[m], SUB_KEYS.latencyEntry]);
            if (isObj(r.anatomy)) {
                out.push(['seq ' + r.seq + ' cycle.anatomy', r.anatomy, SUB_KEYS.anatomy]);
                if (isObj(r.anatomy.counts)) out.push(['seq ' + r.seq + ' cycle.anatomy.counts', r.anatomy.counts, SUB_KEYS.anatomyCounts]);
            }
            for (const f of Array.isArray(r.failures) ? r.failures : []) {
                if (!isObj(f)) continue;
                out.push(['seq ' + r.seq + ' failure world ' + f.world, f, SUB_KEYS.failure]);
                for (const x of Array.isArray(f.fails) ? f.fails : []) if (isObj(x)) out.push(['seq ' + r.seq + ' world ' + f.world + ' fail', x, SUB_KEYS.fail]);
            }
        }
        if (r.type === 'summary') for (const b of Array.isArray(r.breaches) ? r.breaches : []) if (isObj(b)) out.push(['summary breach', b, own(b, 'gate') ? SUB_KEYS.gateBreach : SUB_KEYS.breach]);
    }
    return out;
}

/* ---- stream structure ------------------------------------------------------------------------------ */

function parseStream(text) {
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) bad('parse', 'empty stream (no records)');
    const recs = [];
    for (let i = 0; i < lines.length; i++) {
        let r;
        try { r = JSON.parse(lines[i]); } catch (e) { r = undefined; }
        if (!isObj(r)) bad('parse', 'line ' + (i + 1) + ' is not a JSON object record');
        recs.push(r);
    }
    return recs;
}

function checkStructure(recs) {
    const seen = new Set();
    for (let i = 0; i < recs.length; i++) if (!isCount(recs[i].seq)) bad('seq-invalid', 'line ' + (i + 1) + ': seq ' + String(recs[i].seq) + ' is not a non-negative integer');
    for (let i = 0; i < recs.length; i++) { if (seen.has(recs[i].seq)) bad('seq-duplicate', 'line ' + (i + 1) + ': seq ' + recs[i].seq + ' repeats'); seen.add(recs[i].seq); }
    for (let i = 0; i < recs.length; i++) if (recs[i].seq !== i) bad('seq-gap', 'line ' + (i + 1) + ': seq ' + recs[i].seq + ', expected ' + i);
    let t = 0;
    for (const r of recs) {
        if (TYPES.indexOf(r.type) === -1) bad('record-type', 'seq ' + r.seq + ': type ' + String(r.type) + ' is not a burn-in record (' + TYPES.join('|') + ')');
        if (!(typeof r.tMs === 'number' && r.tMs >= 0)) bad('record-type', 'seq ' + r.seq + ': tMs ' + String(r.tMs) + ' is not a time');
        if (r.tMs < t) bad('record-type', 'seq ' + r.seq + ': tMs ' + r.tMs + ' runs backwards (previous ' + t + ')');
        t = r.tMs;
    }
    for (const [where, o, keys] of keyedObjects(recs)) for (const k of Object.keys(o)) if (keys.indexOf(k) === -1) bad('unknown-key', where + ' carries an unknown key ' + JSON.stringify(k));
    if (recs[0].type !== 'header') bad('header', 'record 0 is ' + recs[0].type + ', not the header');
    for (let i = 1; i < recs.length; i++) if (recs[i].type === 'header') bad('header', 'a second header at seq ' + i);
    const sums = recs.filter((r) => r.type === 'summary');
    if (sums.length === 0) bad('summary-missing', 'no summary record (a lost or truncated run is never judged)');
    if (sums.length > 1) bad('summary-duplicate', sums.length + ' summary records');
    const si = recs.indexOf(sums[0]);
    for (let i = si + 1; i < recs.length; i++) if (recs[i].type === 'fatal') bad('fatal-after-summary', 'fatal ' + String(recs[i].kind) + ' at seq ' + i + ' after the summary at seq ' + si);
    if (si !== recs.length - 1) bad('after-summary', (recs.length - 1 - si) + ' record(s) after the summary');
    const fatals = recs.filter((r) => r.type === 'fatal');
    const reason = sums[0].reason;
    if (fatals.length > 1) bad('fatal-placement', fatals.length + ' fatal records');
    if (fatals.length === 1 && FATAL_KINDS.indexOf(fatals[0].kind) === -1) bad('fatal-placement', 'unknown fatal kind ' + String(fatals[0].kind));
    if (fatals.length === 1 && recs.indexOf(fatals[0]) !== si - 1) bad('fatal-placement', 'the fatal record is not directly before the summary');
    if (fatals.length === 1 && reason !== 'fatal') bad('fatal-placement', 'a fatal record but summary reason ' + String(reason));
    if (fatals.length === 0 && reason === 'fatal') bad('fatal-placement', 'summary reason fatal without a fatal record');
    return { header: recs[0], summary: sums[0], cycles: recs.filter((r) => r.type === 'cycle'), fatal: fatals.length === 1 };
}

/* ---- header ---------------------------------------------------------------------------------------- */

const HEADER_NEEDS = ['schemaVersion', 'genVersion', 'kind', 'kernel', 'engine', 'parity', 'controls', 'config', 'laneRoster', 'lanes',
    'scenarios', 'oraclesNA', 'genRules', 'divergences', 'mustfail', 'gates'];

const NEARWRAP_KEYS = Object.freeze(['baseSha256', 'derivedSha256', 'k', 'phase', 'rewrites']);
const HEX64 = /^[0-9a-f]{64}$/;
/** header.nearwrap is exactly {phase: sign|zero, k: int 1..NEARWRAP_K_MAX, rewrites: [], baseSha256, derivedSha256: 64-hex}. */
function nearwrapShape(n) {
    return isObj(n) && isDeepStrictEqual(Object.keys(n).sort(), NEARWRAP_KEYS.slice()) && (n.phase === 'sign' || n.phase === 'zero') &&
        Number.isInteger(n.k) && n.k >= 1 && n.k <= NEARWRAP_K_MAX && Array.isArray(n.rewrites) &&
        typeof n.baseSha256 === 'string' && HEX64.test(n.baseSha256) && typeof n.derivedSha256 === 'string' && HEX64.test(n.derivedSha256);
}

function readHeader(h) {
    for (const k of HEADER_NEEDS) if (!own(h, k)) bad('header', 'header.' + k + ' is missing');
    if (h.kind !== 'burn-in') bad('header', 'kind ' + String(h.kind) + ' is not burn-in');
    if (h.schemaVersion !== SCHEMA_VERSION) bad('header', 'schemaVersion ' + String(h.schemaVersion) + ' != ' + SCHEMA_VERSION);
    if (h.genVersion !== GEN_VERSION) bad('header', 'genVersion ' + String(h.genVersion) + ' != ' + GEN_VERSION);
    if (!isDeepStrictEqual(h.genRules, GEN_RULES.slice())) bad('header', 'genRules ' + JSON.stringify(h.genRules) + ' != gen.mjs GEN_RULES');
    const c = h.config;
    if (!isObj(c)) bad('header', 'header.config is not an object');
    for (const k of KNOWN_KEYS) {
        if (!isObj(c[k]) || !own(c[k], 'value') || ['env', 'argv', 'default'].indexOf(c[k].source) === -1) bad('header', 'config.' + k + ' is missing or has no {value, source}');
    }
    const cfg = {
        smoke: c.SOAK_SMOKE.value, cycles: c.SOAK_CYCLES.value, ops: c.SOAK_OPS.value, seed: c.SOAK_SEED.value, lanes: c.SOAK_LANES.value,
        engine: c.SOAK_ENGINE.value, mustFail: c.SOAK_MUSTFAIL.value, kernel: c.SOAK_KERNEL.value,
    };
    if (typeof cfg.smoke !== 'boolean') bad('header', 'config SOAK_SMOKE value ' + String(cfg.smoke) + ' is not a boolean');
    if (!isCount(cfg.cycles)) bad('header', 'config SOAK_CYCLES value ' + String(cfg.cycles) + ' is not a count');
    if (!isCount(cfg.ops)) bad('header', 'config SOAK_OPS value ' + String(cfg.ops) + ' is not a count');
    if (!(isCount(cfg.seed) && cfg.seed <= 0xFFFFFFFF)) bad('header', 'config SOAK_SEED value ' + String(cfg.seed) + ' is not a uint32');
    if (!Array.isArray(cfg.lanes)) bad('header', 'config SOAK_LANES value is not an array');
    if (!(cfg.kernel === null || typeof cfg.kernel === 'string')) bad('header', 'config SOAK_KERNEL value is neither null nor a path');
    if (ENGINES_KNOWN.indexOf(cfg.engine) === -1) bad('header', 'SOAK_ENGINE ' + String(cfg.engine) + ' is no known engine');
    if (!(isObj(h.engine) && h.engine.name === cfg.engine)) bad('header', 'engine.name differs from SOAK_ENGINE ' + cfg.engine);
    if (!isObj(h.engine.caps)) bad('header', 'engine.caps is not an object');
    if (!isDeepStrictEqual(h.mustfail, cfg.mustFail)) bad('header', 'header.mustfail differs from config SOAK_MUSTFAIL');
    if (!(h.nearwrap === null || nearwrapShape(h.nearwrap))) bad('header', 'header.nearwrap must be null or exactly {phase, k, rewrites, baseSha256, derivedSha256}, got ' + JSON.stringify(h.nearwrap));
    const nwc = c.SOAK_NEARWRAP.value;
    if (!(nwc === null || (isObj(nwc) && isDeepStrictEqual(Object.keys(nwc).sort(), ['k', 'phase']) && (nwc.phase === 'sign' || nwc.phase === 'zero') &&
        Number.isInteger(nwc.k) && nwc.k >= 1 && nwc.k <= NEARWRAP_K_MAX))) bad('header', 'config SOAK_NEARWRAP value ' + JSON.stringify(nwc) + ' is neither null nor {phase, k}');
    if (!isDeepStrictEqual(nwc, h.nearwrap === null ? null : { phase: h.nearwrap.phase, k: h.nearwrap.k })) bad('header', 'header.nearwrap differs from config SOAK_NEARWRAP');
    const k = h.kernel;
    if (!isObj(k) || typeof k.override !== 'boolean' || !Array.isArray(k.files) || k.files.length !== 2) bad('header', 'header.kernel must be {override, files[2]}');
    for (const f of k.files) if (!isObj(f) || typeof f.path !== 'string' || !/^[0-9a-f]{64}$/.test(String(f.sha256))) bad('header', 'kernel file entry malformed');
    if (!(isObj(h.controls) && own(h.controls, 'name'))) bad('header', 'header.controls has no name');
    if (!(isObj(h.parity) && own(h.parity, 'ok'))) bad('header', 'header.parity has no ok');
    cfg.forever = cfg.cycles === 0;
    return cfg;
}

/** Does the realpath-resolved kernel path `p` come from the SOAK_KERNEL value `v`? (see the file header) */
function kernelPathMatches(p, v) {
    if (p === v) return true;
    try { if (realpathSync(v) === p) return true; } catch (e) { /* not resolvable on this host: fall back to the suffix rule */ }
    const tail = normalize(v).replace(/\\/g, '/').replace(/^(\.\.?\/)+/, '').replace(/^\/+/, '');
    return tail.length > 0 && p.replace(/\\/g, '/').endsWith('/' + tail);
}

/**
 * Raw-byte sha256 of a regular file on this host (the hash kernel.mjs records for Watch.js); throws when unreadable
 * or not a regular file (a FIFO or device would block or never end the read: fail closed, never hang).
 */
const fileSha256 = (path) => {
    if (!statSync(path).isFile()) throw new Error('not a file');
    return createHash('sha256').update(readFileSync(path)).digest('hex');
};
/** sha256 of a regular file's utf8-DECODED text (the nearwrap.mjs baseSha256: kernel.mjs reads the base as utf8). */
const textSha256 = (path) => {
    if (!statSync(path).isFile()) throw new Error('not a file');
    return createHash('sha256').update(readFileSync(path, 'utf8'), 'utf8').digest('hex');
};

/**
 * A NEARWRAP kernel (header.nearwrap non-null): kernel.files is the derived pair, not the SOAK_KERNEL value (see
 * the file header). On an override, the base and its sibling Watch.js are hashed here; bad() stays outside the try.
 */
function checkNearwrapKernel(n, k, value) {
    const sig = k.files[0], wat = k.files[1];
    const sp = sig.path.replace(/\\/g, '/'), at = sp.lastIndexOf('/'), dir = sp.slice(0, at + 1);
    const pair = sig.sha256.slice(0, 7) + '-' + wat.sha256.slice(0, 7);
    const pairOk = at > 0 && sp.slice(at + 1) === 'Signal.js' && dir.slice(0, -1).split('/').pop() === pair &&
        wat.path.replace(/\\/g, '/') === dir + 'Watch.js';
    if (n.derivedSha256 !== sig.sha256) {
        bad('control', 'nearwrap derivedSha256 ' + n.derivedSha256 + ' is not the kernel Signal.js sha256 ' +
            sig.sha256);
    }
    if (!pairOk) {
        bad('control', 'nearwrap kernel files ' + sig.path + ' + ' + wat.path + ' are not the derived pair ' +
            pair + '/{Signal,Watch}.js');
    }
    if (!k.override) return;
    let base = null, watch = null;
    try {
        const p = realpathSync(value);
        base = textSha256(p);
        watch = fileSha256(join(dirname(p), 'Watch.js'));
    } catch (e) { base = null; watch = null; }
    if (base === null || watch === null) {
        bad('control', 'nearwrap base SOAK_KERNEL ' + value + ' (or its sibling Watch.js) does not resolve on this ' +
            'host: baseSha256 unverifiable (fail closed)');
    }
    if (n.baseSha256 !== base) {
        bad('control', 'nearwrap baseSha256 ' + n.baseSha256 + ' is not the sha256 of the SOAK_KERNEL file ' + value +
            ' on this host (' + base + ')');
    }
    if (wat.sha256 !== watch) {
        bad('control', 'kernel Watch.js sha256 ' + wat.sha256 + ' is not the sha256 of the SOAK_KERNEL sibling ' +
            'Watch.js (' + watch + '), of which the derived one is a byte copy');
    }
}

function checkHeader(h, cfg, registryText) {
    if (!isDeepStrictEqual(h.gates, gatesBlock())) {
        const want = gatesBlock();
        const keys = uniq(Object.keys(want).concat(isObj(h.gates) ? Object.keys(h.gates) : []));
        const diff = keys.filter((x) => !isDeepStrictEqual(isObj(h.gates) ? h.gates[x] : undefined, want[x]));
        bad('gates-block', 'header gates differ from this code\'s gatesBlock() at ' + (diff.length ? diff.join(',') : 'the block itself') + ' (tampered, or recorded under different code)');
    }
    if (h.divergences !== digest(registryText)) bad('registry', 'header divergences digest differs from this tree\'s divergences.json (tampered, or recorded under a different registry; known tags cannot be re-derived)');
    // kernel identity: flag vs config vs path, then the controls.json pins
    const k = h.kernel;
    if (k.override && cfg.kernel === null) bad('control', 'kernel.override is true but config SOAK_KERNEL is null');
    if (!k.override && cfg.kernel !== null) bad('control', 'kernel.override is false but config SOAK_KERNEL is ' + cfg.kernel);
    if (h.nearwrap !== null) checkNearwrapKernel(h.nearwrap, k, cfg.kernel);   // the derived pair: N1-N5
    else if (k.override && !kernelPathMatches(k.files[0].path, cfg.kernel)) {
        bad('control', 'kernel path ' + k.files[0].path + ' is not the SOAK_KERNEL value ' + cfg.kernel);
    }
    const names = k.files.map((f) => f.path.split(/[\\/]/).pop());
    if (names[0] !== 'Signal.js' || names[1] !== 'Watch.js') bad('control', 'kernel files must be Signal.js + Watch.js, got ' + names.join(','));
    const ctl = JSON.parse(readFileSync(new URL('./controls.json', import.meta.url), 'utf8')).controls;
    const sh = k.files.map((f) => f.sha256);
    const match = ctl.filter((c) => c.sha256['Signal.js'] === sh[0] && c.sha256['Watch.js'] === sh[1]);
    if (h.controls.name !== null && !match.some((c) => c.name === h.controls.name)) bad('control', 'controls.name ' + String(h.controls.name) + ' does not match the kernel sha256 pins in controls.json');
    if (h.controls.name === null && match.length > 0) bad('control', 'the kernel is control ' + match[0].name + ' but controls.name is null');
    if (h.engine.name === 'lite' && !isDeepStrictEqual(h.engine.files, k.files.map((f) => ({ path: f.path, sha256: f.sha256 })))) bad('control', 'engine.files differ from kernel.files');
    // lanes: re-derive applicability from the recorded caps (lanes/index.mjs + adapters/contract.mjs)
    if (!isDeepStrictEqual(h.laneRoster, ROSTER.slice())) bad('header-lanes', 'laneRoster ' + JSON.stringify(h.laneRoster) + ' != ' + JSON.stringify(ROSTER));
    if (!isDeepStrictEqual(cfg.lanes, ROSTER.filter((n) => cfg.lanes.indexOf(n) !== -1))) bad('header-lanes', 'SOAK_LANES value is not a roster-ordered subset');
    if (!(Array.isArray(h.lanes) && h.lanes.length === cfg.lanes.length)) bad('header-lanes', 'header.lanes does not list exactly the SOAK_LANES lanes');
    const run = [], skipped = [];
    for (let i = 0; i < cfg.lanes.length; i++) {
        const name = cfg.lanes[i], desc = laneByName(name), app = applicability(desc, h.engine.caps);
        if (!isDeepStrictEqual(h.lanes[i], { name, status: app.status, missingCaps: app.missingCaps, engine: cfg.engine })) bad('header-lanes', 'header.lanes[' + i + '] differs from applicability(' + name + ')');
        if (!isDeepStrictEqual(own(h.scenarios, name) ? h.scenarios[name] : null, { required: app.requiredApplicable, optional: desc.optional.slice(), na: app.scenariosNA })) bad('header-lanes', 'header.scenarios.' + name + ' differs from the lane descriptor');
        if (!isDeepStrictEqual(own(h.oraclesNA, name) ? h.oraclesNA[name] : null, app.oraclesNA)) bad('header-lanes', 'header.oraclesNA.' + name + ' differs');
        if (app.status === 'skip') { skipped.push({ lane: name, missingCaps: app.missingCaps, engine: cfg.engine }); continue; }
        run.push({ name, desc, oracles: desc.hardOracles.filter((o) => app.oraclesNA.indexOf(o) === -1), required: app.requiredApplicable, recs: [] });
    }
    return { run, skipped };
}

/* ---- cycles ---------------------------------------------------------------------------------------- */

function checkCycles(cycles, cfg, lanes, summary, controlsName) {
    const n = lanes.run.length;
    const limit = cfg.forever ? CYCLES_MAX : cfg.cycles;
    if (cycles.length > limit * n) bad('cycle-grid', cycles.length + ' cycle records > ' + limit + ' cycles x ' + n + ' running lanes');
    for (let i = 0; i < cycles.length; i++) {
        const c = cycles[i], L = lanes.run[i % n], cyc = Math.floor(i / n);
        if (c.lane !== L.name || c.cycle !== cyc) bad('cycle-grid', 'seq ' + c.seq + ': lane ' + String(c.lane) + ' cycle ' + String(c.cycle) + ', expected ' + L.name + ' cycle ' + cyc + ' (a cycle record is missing or out of order)');
        if (c.laneIndex !== L.desc.index) bad('cycle-grid', 'seq ' + c.seq + ': laneIndex ' + String(c.laneIndex) + ' != ' + L.desc.index);
        if (c.warmup !== (cyc < WARMUP_CYCLES)) bad('cycle-grid', 'seq ' + c.seq + ': warmup ' + String(c.warmup) + ' does not match cycle ' + cyc);
        if (typeof c.interrupted !== 'boolean') bad('cycle-grid', 'seq ' + c.seq + ': interrupted is not a boolean');
        if (c.interrupted && !(summary.reason === 'signal' && i === cycles.length - 1)) bad('cycle-grid', 'seq ' + c.seq + ': interrupted outside a signal-stopped last cycle');
    }
    if (summary.reason === 'end' && !cfg.forever && cycles.length !== limit * n) bad('cycle-grid', 'reason end with ' + cycles.length + ' cycle records, expected ' + (limit * n));
    if (summary.cyclesRun !== cycles.length) bad('cycle-grid', 'summary.cyclesRun ' + String(summary.cyclesRun) + ' != ' + cycles.length + ' cycle records');

    for (const c of cycles) {
        const at = 'seq ' + c.seq + ' (' + c.lane + ' cycle ' + c.cycle + '): ';
        for (const k of ['worlds', 'largeWorlds', 'ops', 'failingWorlds']) if (!isCount(c[k])) bad('cycle-field', at + k + ' = ' + String(c[k]));
        if (c.largeWorlds > c.worlds) bad('cycle-field', at + 'largeWorlds exceed worlds');
        if (c.failingWorlds > c.worlds) bad('cycle-field', at + 'failingWorlds exceed worlds');
        if (c.seed !== seedFor(cfg.seed, c.laneIndex, c.cycle)) bad('cycle-field', at + 'seed ' + String(c.seed) + ' is not seedFor(SOAK_SEED, lane, cycle)');
        if (c.interrupted !== (c.ops < cfg.ops)) bad('cycle-field', at + 'ops ' + c.ops + ' vs SOAK_OPS ' + cfg.ops + ' with interrupted=' + c.interrupted);
        for (const [name, keys] of [['checks', CHECK_NAMES], ['skipTainted', SKIP_NAMES]]) {
            if (!isObj(c[name]) || !isDeepStrictEqual(Object.keys(c[name]).sort(), keys.slice().sort())) bad('cycle-field', at + name + ' keys must be exactly ' + keys.join(','));
            for (const k of keys) if (!isCount(c[name][k])) bad('cycle-field', at + name + '.' + k + ' = ' + String(c[name][k]));
        }
        for (const name of ['opsByClass', 'gateHits']) {
            if (!isObj(c[name])) bad('cycle-field', at + name + ' missing');
            for (const k of Object.keys(c[name])) if (!isCount(c[name][k])) bad('cycle-field', at + name + '.' + k + ' = ' + String(c[name][k]));
        }
        if (Object.values(c.opsByClass).reduce((a, b) => a + b, 0) !== c.ops) bad('cycle-field', at + 'opsByClass does not sum to ops');
        if (!isObj(c.memory) || !(Number.isFinite(c.memory.residentMB) && c.memory.residentMB >= 0)) bad('cycle-field', at + 'memory.residentMB missing');
        const b = c.boundary;
        if (!isObj(b)) bad('cycle-field', at + 'boundary missing');
        if (b.lane !== c.lane || b.cycle !== c.cycle) bad('cycle-field', at + 'boundary belongs to ' + String(b.lane) + ' cycle ' + String(b.cycle));
        if (b.worlds !== c.worlds) bad('cycle-field', at + 'boundary.worlds ' + String(b.worlds) + ' != worlds');
        if (!(isCount(b.tracked) && isCount(b.witnessed))) bad('cycle-field', at + 'boundary tracked/witnessed not counts');
        if (!own(b, 'trackerSize') || !own(b, 'weakAlive')) bad('cycle-field', at + 'boundary trackerSize/weakAlive missing (null is not zero)');
        // latency (B-B4a, report-only): an ABSENT latency / entry is missing-key's (later class); a present one is checked here
        const lat = own(c, 'latency') ? c.latency : null;
        for (const m of own(c, 'latency') ? LATENCY_METHODS : []) {
            if (isObj(lat) && !own(lat, m)) continue;
            const e = isObj(lat) ? lat[m] : null;
            if (!(isObj(e) && isCount(e.n) && isCount(e.belowFloor))) bad('cycle-field', at + (!isObj(lat) ? 'latency is not an object' : !isObj(e) ? 'latency.' + m + ' is not an object' : 'latency.' + m + ' n/belowFloor = ' + String(e.n) + '/' + String(e.belowFloor) + ' (counts)'));
            if (e.belowFloor > e.n) bad('cycle-field', at + 'latency.' + m + '.belowFloor ' + e.belowFloor + ' > n ' + e.n);
            for (const p of ['p50Ns', 'p99Ns']) if (!(e[p] === null || isCount(e[p]))) bad('cycle-field', at + 'latency.' + m + '.' + p + ' = ' + String(e[p]) + ' (null or a non-negative integer ns)');
            if (e.p50Ns !== null && !(e.p99Ns !== null && e.p50Ns <= e.p99Ns)) bad('cycle-field', at + 'latency.' + m + '.p50Ns ' + e.p50Ns + ' with p99Ns ' + e.p99Ns + ' (p50Ns <= p99Ns; p99Ns null -> p50Ns null)');
            if (e.n === e.belowFloor && (e.p50Ns !== null || e.p99Ns !== null)) bad('cycle-field', at + 'latency.' + m + ' has no timed mass above the floor but pXX non-null');
        }
        // anatomy (B-B4b, report-only): null, or an object; an ABSENT anatomy / key is missing-key's (later class)
        const an = own(c, 'anatomy') ? c.anatomy : null;
        if (an !== null && !isObj(an)) bad('cycle-field', at + 'anatomy is neither null nor an object: ' + String(an));
        if (an !== null && own(an, 'worlds') && !(isCount(an.worlds) && an.worlds >= 1)) bad('cycle-field', at + 'anatomy.worlds = ' + String(an.worlds) + ' (a count >= 1; no folded world is anatomy null)');
        if (an !== null && own(an, 'counts') && !isObj(an.counts)) bad('cycle-field', at + 'anatomy.counts is not an object');
        for (const n of an !== null && isObj(an.counts) ? ANATOMY_NAMES : []) {
            if (own(an.counts, n) && !isCount(an.counts[n])) bad('cycle-field', at + 'anatomy.counts.' + n + ' = ' + String(an.counts[n]) + ' (counts)');
        }
        const ac = an !== null && isObj(an.counts) && own(an.counts, 'markStamp') && own(an.counts, 'markEdge') ? an.counts : null;
        if (ac !== null && ac.markStamp > ac.markEdge) bad('cycle-field', at + 'anatomy.counts.markStamp ' + ac.markStamp + ' > markEdge ' + ac.markEdge);
        if (ac !== null && own(an, 'markDedupe') && !Object.is(an.markDedupe, ac.markEdge === 0 ? null : ac.markStamp / ac.markEdge)) bad('cycle-field', at + 'anatomy.markDedupe ' + String(an.markDedupe) + ' is not markStamp / markEdge (' + ac.markStamp + ' / ' + ac.markEdge + '; null when markEdge is 0)');
    }
    for (const c of cycles) {
        const at = 'seq ' + c.seq + ' (' + c.lane + ' cycle ' + c.cycle + '): ';
        if (!isObj(c.scenarios)) bad('scenario-counts', at + 'scenarios missing');
        for (const k of Object.keys(c.scenarios)) if (!isCount(c.scenarios[k])) bad('scenario-counts', at + 'scenarios.' + k + ' = ' + String(c.scenarios[k]));
        for (const f of Array.isArray(c.failures) ? c.failures : []) {
            for (const k of Object.keys(isObj(f) && isObj(f.worldScenCounts) ? f.worldScenCounts : {})) {
                if (!(f.worldScenCounts[k] <= (own(c.scenarios, k) ? c.scenarios[k] : 0))) bad('scenario-counts', at + 'world ' + f.world + ' counted ' + k + ' x' + f.worldScenCounts[k] + ' > the cycle count');
            }
        }
    }
    for (const c of cycles) {
        const at = 'seq ' + c.seq + ' (' + c.lane + ' cycle ' + c.cycle + '): ';
        const fc = c.failureCounts;
        if (!isObj(fc)) bad('failure-count', at + 'failureCounts missing');
        let sum = 0;
        for (const k of Object.keys(fc)) {
            if (!(isCount(fc[k]) && fc[k] > 0)) bad('failure-count', at + 'failureCounts["' + k + '"] = ' + String(fc[k]) + ' (a counted key is >= 1)');
            if (fc[k] > c.failingWorlds) bad('failure-count', at + 'failureCounts["' + k + '"] = ' + fc[k] + ' > failingWorlds ' + c.failingWorlds + ' (counted once per world)');
            sum += fc[k];
        }
        if (sum < c.failingWorlds) bad('failure-count', at + 'failureCounts sum ' + sum + ' < failingWorlds ' + c.failingWorlds);
        if (!Array.isArray(c.failures)) continue;   // failure-records reports it
        const stored = {};
        for (const f of c.failures) for (const k of familyKeys(isObj(f) && Array.isArray(f.fails) ? f.fails.filter((x) => isObj(x) && okOracle(x)) : [])) stored[k] = (stored[k] || 0) + 1;
        const unseen = c.failingWorlds - c.failures.length;
        for (const k of uniq(Object.keys(stored).concat(Object.keys(fc)))) {
            const s = stored[k] || 0, got = own(fc, k) ? fc[k] : 0;
            if (got < s) bad('failure-count', at + 'failureCounts["' + k + '"] = ' + got + ' but the stored failure records hold ' + s);
            if (got > s + unseen) bad('failure-count', at + 'failureCounts["' + k + '"] = ' + got + ' > ' + s + ' stored + ' + unseen + ' uncapped worlds');
        }
    }
    for (const c of cycles) {
        const at = 'seq ' + c.seq + ' (' + c.lane + ' cycle ' + c.cycle + '): ';
        if (!Array.isArray(c.failures)) bad('failure-records', at + 'failures is not an array');
        if (c.failures.length !== Math.min(c.failingWorlds, FAIL_CAP)) bad('failure-records', at + 'failures[] holds ' + c.failures.length + ', expected min(failingWorlds, FAIL_CAP)');
        let last = -1;
        for (const f of c.failures) {
            const shaped = isObj(f) && Number.isSafeInteger(f.world) && isCount(f.step) && typeof f.op === 'string' && Array.isArray(f.fails) && f.fails.length > 0 &&
                f.fails.every((x) => isObj(x) && okOracle(x) && typeof x.sig === 'string' && typeof x.detail === 'string') && Array.isArray(f.scen) && isObj(f.worldScenCounts);
            if (!shaped) bad('failure-records', at + 'a failure record is malformed');
            if (!(f.world > last && f.world < c.worlds)) bad('failure-records', at + 'world ' + f.world + ' is out of order or out of range');
            last = f.world;
            const ws = worldSeed(c.seed, f.world);
            const want = {
                oracles: uniq(f.fails.map((x) => x.oracle)), sigs: uniq(f.fails.map((x) => x.sig)), sig: f.fails[0].sig, detail: f.fails[0].detail,
                worldSeed: ws, replay: formatReplayKey(c.lane, c.cycle, ws), worldScen: Object.keys(f.worldScenCounts).filter((k) => f.worldScenCounts[k] > 0),
            };
            for (const k of Object.keys(want)) if (!isDeepStrictEqual(f[k], want[k])) bad('failure-records', at + 'world ' + f.world + ': ' + k + ' does not re-derive');
            if (f.op !== 'batch' && f.escape !== null) bad('failure-records', at + 'world ' + f.world + ': escape on a non-batch op');
            if (f.escape !== null && !Array.isArray(f.escape)) bad('failure-records', at + 'world ' + f.world + ': escape must be null or an array');
        }
    }
    for (const c of cycles) {
        for (const f of c.failures) {
            const crec = { engine: cfg.engine, lane: c.lane, step: f.step, op: f.op, fails: f.fails, scen: f.scen, worldScen: f.worldScen, worldScenCounts: f.worldScenCounts };
            if (f.escape !== null) crec.escape = f.escape;
            let cls;
            // includeFixed from the same identity main used (header controls.name = kernel.mjs KERNEL_KNOWN_AS)
            try { cls = classify(crec, { includeFixed: controlsName !== null }); } catch (e) { bad('known-tag', 'seq ' + c.seq + ' world ' + f.world + ': classify refused the record (' + e.message + ')'); }
            const want = { known: cls === null ? null : cls.known, tag: cls === null ? null : cls.tag, failKnown: f.fails.map((x, i) => (cls === null ? null : cls.perFail[i].join('+'))) };
            for (const k of Object.keys(want)) if (!isDeepStrictEqual(f[k], want[k])) bad('known-tag', 'seq ' + c.seq + ' world ' + f.world + ': ' + k + ' ' + JSON.stringify(f[k]) + ' re-derives as ' + JSON.stringify(want[k]));
        }
    }
}
function okOracle(x) { try { oracleFamily(x.oracle); return true; } catch (e) { return false; } }

/* ---- summary --------------------------------------------------------------------------------------- */

function checkSummary(s, cycles, cfg, lanes, fatal, registry) {
    for (const c of cycles) lanes.run[lanes.run.findIndex((L) => L.name === c.lane)].recs.push(c);
    const computed = [], perLane = {};
    const tot = { worlds: 0, ops: 0, checks: {}, skipTainted: {}, failingWorlds: 0 };
    for (const o of CHECK_NAMES) tot.checks[o] = 0;
    for (const o of SKIP_NAMES) tot.skipTainted[o] = 0;
    for (const L of lanes.run) {
        const g = new LaneGates({ lane: L.name, oracles: L.oracles, required: L.required });
        for (const c of L.recs) g.push(c);   // a GateInputError here is INTEGRITY malformed (report())
        for (const c of L.recs) {
            tot.worlds += c.worlds; tot.ops += c.ops; tot.failingWorlds += c.failingWorlds;
            for (const o of CHECK_NAMES) tot.checks[o] += c.checks[o];
            for (const o of SKIP_NAMES) tot.skipTainted[o] += c.skipTainted[o];
        }
        if (g.cycles === 0) { perLane[L.name] = { status: 'INCONCLUSIVE', cycles: 0, notRun: true }; continue; }
        const r = g.compute({ smoke: cfg.smoke });
        computed.push(r);
        perLane[L.name] = {
            status: r.status, cycles: r.cycles, postWarmup: r.postWarmup, totals: r.totals, failureCounts: r.failureCounts,
            scenarioMissing: r.scenarioMissing, drift: r.drift, retention: r.retention, causes: r.causes.map((x) => x.line),
        };
    }
    for (const k of lanes.skipped) perLane[k.lane] = { status: 'SKIP', missingCaps: k.missingCaps };
    if (!isDeepStrictEqual(s.totals, tot)) bad('totals', 'summary.totals do not equal the sum of the cycle records');
    if (REASONS.indexOf(s.reason) === -1) bad('verdict', 'summary.reason ' + String(s.reason));
    const v = judgeRun({ configError: null, engine: cfg.engine, lanes: computed, skipped: lanes.skipped, reason: s.reason, forever: cfg.forever, smoke: cfg.smoke, fatal, extraFail: tot.failingWorlds > 0 });
    if (s.verdict !== v.verdict) bad('verdict', 'the stream claims ' + JSON.stringify(s.verdict) + ', its records re-derive ' + JSON.stringify(v.verdict));
    if (s.exitCode !== v.exitCode) bad('verdict', 'the stream claims exit ' + JSON.stringify(s.exitCode) + ', its records re-derive ' + v.exitCode);
    if (s.smoke !== cfg.smoke) bad('verdict', 'summary.smoke differs from config SOAK_SMOKE');
    if (s.lanesRun !== computed.length) bad('verdict', 'summary.lanesRun ' + String(s.lanesRun) + ' != ' + computed.length);
    if (!isDeepStrictEqual(s.skipped, lanes.skipped)) bad('verdict', 'summary.skipped differs from the header lanes');
    if (!isObj(s.perLane)) bad('per-lane', 'summary.perLane missing');
    for (const k of uniq(Object.keys(perLane).concat(Object.keys(s.perLane)))) if (!isDeepStrictEqual(s.perLane[k], json(perLane[k]))) bad('per-lane', 'perLane.' + k + ' does not re-derive');
    if (!isDeepStrictEqual(s.inconclusive, v.causes.map((c) => c.line))) bad('inconclusive', 'summary.inconclusive lines do not re-derive');
    checkBreaches(s, cycles, cfg, v, perLane, registry);
    return v;
}

/**
 * Oracle BREACH entries, both directions. main's BreachLog saw EVERY failing world; the stream keeps the first
 * FAIL_CAP per cycle, so the log rebuilt from the stored failures is exact up to the first capped cycle of a lane:
 *   - stream entries are unique by BreachLog.key, `known` is null or '+'-joined registry ids, and the
 *     family:sig is counted in the lane's failureCounts;
 *   - every rebuilt entry exists; one rebuilt before its lane's first capped cycle must equal the stream's
 *     (replay, scen, detail) -- no unstored world can have preceded it;
 *   - a stream entry no stored failure produces is admitted only on a lane with a capped cycle.
 */
function checkBreaches(s, cycles, cfg, v, perLane, registry) {
    const ids = registry.map((e) => e.id);
    if (!Array.isArray(s.breaches)) bad('breaches', 'summary.breaches missing');
    const gate = s.breaches.filter((b) => own(b, 'gate')), orc = s.breaches.filter((b) => !own(b, 'gate'));
    if (!isDeepStrictEqual(gate, json(v.breaches))) bad('breaches', 'gate breaches do not re-derive');
    const byKey = new Map();
    for (const b of orc) {
        const key = BreachLog.key(b.oracle, b.lane, b.sig, b.known);
        if (byKey.has(key)) bad('breaches', 'duplicate BREACH entry ' + key);
        byKey.set(key, b);
        if (!(b.known === null || (typeof b.known === 'string' && b.known.split('+').every((id) => ids.indexOf(id) !== -1)))) bad('breaches', 'BREACH ' + key + ' carries a known tag no registry entry can emit');
        if (b.known !== null && !b.known.split('+').every((id) => fits(registry[ids.indexOf(id)], b))) bad('breaches', 'BREACH ' + key + ': a known id does not cover this lane / oracle family / sig');
        const fc = own(perLane, b.lane) ? perLane[b.lane].failureCounts : null;
        if (!(fc && own(fc, b.oracle + ':' + b.sig))) bad('breaches', 'BREACH ' + b.oracle + ':' + b.sig + ' on ' + String(b.lane) + ' has no failure count');
    }
    const log = new BreachLog(() => {});
    const capped = new Set(), exact = new Set();
    for (const c of cycles) {
        const before = log.entries.length;
        for (const f of c.failures) log.noteWorld(f, c.lane, cfg.engine);
        if (!capped.has(c.lane)) for (let i = before; i < log.entries.length; i++) exact.add(log.entries[i]);
        if (c.failingWorlds > c.failures.length) capped.add(c.lane);
    }
    const rebuilt = new Set();
    for (const e of log.entries) {
        const key = BreachLog.key(e.oracle, e.lane, e.sig, e.known);
        rebuilt.add(key);
        if (!byKey.has(key)) bad('breaches', 'stored failure ' + e.replay + ' has no BREACH entry ' + key);
        if (exact.has(e) && !isDeepStrictEqual(byKey.get(key), json(e))) bad('breaches', 'BREACH ' + key + ' does not re-derive (replay/scen/detail of its first world ' + e.replay + ')');
    }
    for (const [key, b] of byKey) if (!rebuilt.has(key) && !capped.has(b.lane)) bad('breaches', 'BREACH ' + key + ' matches no stored failure, and lane ' + String(b.lane) + ' has no capped cycle');
    // emission order: the exact entries are first occurrences, so the stream lists them in the rebuilt order
    const exactKeys = log.entries.filter((e) => exact.has(e)).map((e) => BreachLog.key(e.oracle, e.lane, e.sig, e.known));
    const streamExact = orc.map((b) => BreachLog.key(b.oracle, b.lane, b.sig, b.known)).filter((k) => exactKeys.indexOf(k) !== -1);
    if (!isDeepStrictEqual(streamExact, exactKeys)) bad('breaches', 'oracle BREACH entries are not in BreachLog emission order');
}

/** Can registry entry e explain BREACH entry b? (its lanes, an oracle of b's family, b's sig) */
function fits(e, b) {
    return e.lanes.indexOf(b.lane) !== -1 && e.sigs.indexOf(b.sig) !== -1 && e.oracles.some((o) => okOracle({ oracle: o }) && oracleFamily(o) === b.oracle);
}

/* ---- release eligibility --------------------------------------------------------------------------- */

/**
 * The release decision, PURE (no file, env or clock): h = a header that passed readHeader + checkHeader, cycles =
 * the stream's cycle records, pins = bench/soak/parity.json `files`. Returns null (release evidence, or a pinned
 * control kernel: report() prints its NOTE line) or { reason, detail }, the FIRST refusal in the order of the file
 * header. Every check is ONE refuse() statement; test/46 holds a row per statement.
 */
export function releaseRefusal(h, cycles, pins) {
    try {
        releaseChecks(h, cycles, pins);
        return null;
    } catch (e) {
        if (e instanceof Refusal) return { reason: e.reason, detail: e.message };
        throw e;
    }
}

function releaseChecks(h, cycles, pins) {
    const val = (k) => h.config[k].value;
    const mustFail = val('SOAK_MUSTFAIL'), engine = val('SOAK_ENGINE');
    const skipped = h.lanes.filter((L) => L.status === 'skip').map((L) => L.name);
    if (mustFail !== null) refuse('mustfail', 'SOAK_MUSTFAIL=' + mustFail.mode + ':' + mustFail.scenario + ' is a teeth knob');
    if (val('SOAK_SMOKE') !== false) refuse('smoke', 'a smoke run sits below the gate floor by design');
    if (engine !== 'lite') refuse('non-lite', 'engine ' + engine + (skipped.length ? ', skipped lanes ' + skipped.join(',') : ''));
    if (h.nearwrap !== null) refuse('nearwrap', h.nearwrap.phase + ':' + h.nearwrap.k + ' -- a NEARWRAP kernel (census counters preset near a ceiling) is never release evidence');
    if (h.controls.name === null && h.kernel.override) refuse('overridden-kernel', 'SOAK_KERNEL=' + h.kernel.files[0].path + ' is no pinned control (controls.json)');
    if (h.controls.name !== null) return;   // a pinned control: never release evidence (its NOTE line), the tree policy below does not apply
    if (h.kernel.files[0].sha256 !== pins['Signal.js']) refuse('tree-parity', 'the tree Signal.js sha256 differs from bench/soak/parity.json: recorded under different code (stale) or tampered');
    if (h.kernel.files[1].sha256 !== pins['Watch.js']) refuse('tree-parity', 'the tree Watch.js sha256 differs from bench/soak/parity.json: recorded under different code (stale) or tampered');
    if (h.parity.ok !== true) refuse('tree-parity', 'the tree kernel ran with parity ok=' + String(h.parity.ok));
    // release policy (maintainer decision c, 2026-10-13): the full roster, at default volume, on a clean committed tree
    const ran = h.lanes.filter((L) => L.status === 'run').map((L) => L.name);
    if (!isDeepStrictEqual(ran, h.laneRoster)) refuse('lane-subset', 'ran ' + (ran.length ? ran.join(',') : 'no lane') + ' of the roster ' + JSON.stringify(h.laneRoster) + ' (a release soak runs every lane)');
    if (!isDeepStrictEqual(h.laneRoster, ROSTER.slice())) refuse('lane-subset', 'laneRoster ' + JSON.stringify(h.laneRoster) + ' is not lanes/index.mjs ROSTER ' + JSON.stringify(ROSTER));
    const ops = val('SOAK_OPS'), done = completedCycles(ran, cycles);
    if (!(Number.isSafeInteger(ops) && ops >= DEFAULT_OPS)) refuse('volume', 'SOAK_OPS ' + JSON.stringify(ops) + ' is not a count >= config DEFAULT_OPS ' + DEFAULT_OPS);
    if (!(done >= DEFAULT_CYCLES)) refuse('volume', done + ' completed cycle(s) per lane < config DEFAULT_CYCLES ' + DEFAULT_CYCLES + ' (SOAK_CYCLES=' + String(val('SOAK_CYCLES')) + '; an interrupted cycle does not count, a forever run counts the cycles it ran)');
    if (!(typeof h.gitSha === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(h.gitSha))) refuse('provenance', 'gitSha ' + JSON.stringify(h.gitSha) + ' is not a commit sha (unknown is never release evidence)');
    if (h.gitDirty !== false) refuse('provenance', 'gitDirty ' + String(h.gitDirty) + ': a release soak runs on a clean committed tree (null = the probe failed, unknown)');
    if (h.gitError !== null) refuse('provenance', 'gitError ' + JSON.stringify(h.gitError));
}

/** The completed cycles per lane: cycle records with interrupted false, the minimum over `lanes` (0 for none). */
function completedCycles(lanes, cycles) {
    let min = -1;
    for (const name of lanes) {
        let n = 0;
        for (const c of cycles) if (isObj(c) && c.lane === name && c.interrupted === false) n++;
        if (min === -1 || n < min) min = n;
    }
    return min === -1 ? 0 : min;
}

/** report()'s door: reads this tree's pins (an unreadable parity.json is a corrupted checkout: CRASH) and decides. */
function checkRelease(h, cycles) {
    const pins = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url), 'utf8')).files;
    return releaseRefusal(h, cycles, pins);
}

/* ---- the remaining keys ---------------------------------------------------------------------------- */

function checkMissingKeys(recs) {
    for (const [where, o, keys] of keyedObjects(recs)) for (const k of keys) if (!own(o, k)) bad('missing-key', where + ' lacks ' + JSON.stringify(k) + ' (absent is never 0)');
}

/** Judge one stream. Returns { exitCode, out: [stdout lines], err: [stderr lines] }. Pure apart from reading files. */
export function report(path) {
    const config = (msg) => ({ exitCode: EXIT_CODE.CONFIG, out: [], err: ['soak:report: CONFIG -- ' + msg] });
    if (REGISTRY_PROBLEMS.length > 0) return config('this tree\'s divergences.json is invalid: ' + REGISTRY_PROBLEMS[0]);
    let text, registryText;
    try { text = readFileSync(path, 'utf8'); } catch (e) { return config('cannot read ' + path + ': ' + (e && e.code ? e.code : String(e))); }
    try { registryText = readFileSync(REGISTRY_URL, 'utf8'); } catch (e) { return config('cannot read divergences.json: ' + String(e && e.code)); }
    const registry = JSON.parse(registryText).entries;
    const out = [];
    try {
        const recs = parseStream(text);
        const st = checkStructure(recs);
        const cfg = readHeader(st.header);
        const lanes = checkHeader(st.header, cfg, registryText);
        checkCycles(st.cycles, cfg, lanes, st.summary, st.header.controls.name);
        const v = checkSummary(st.summary, st.cycles, cfg, lanes, st.fatal, registry);
        checkMissingKeys(recs);
        const kernel = st.header.controls.name !== null ? 'control:' + st.header.controls.name : (st.header.kernel.override ? 'override' : 'tree');
        out.push('soak:report: stream records=' + recs.length + ' kernel=' + kernel + ' engine=' + cfg.engine + ' lanes=' + cfg.lanes.join(',') + ' cycles=' + st.summary.cyclesRun + ' failingWorlds=' + st.summary.totals.failingWorlds + ' reason=' + st.summary.reason);
        const gap = gapTeeth(), ids = (a) => (a.length > 0 ? a.join(',') : 'none');
        out.push('soak:report: NOTE -- teeth GAP gate=' + ids(gap.gate) + ' oracle=' + ids(gap.oracle));
        const rel = checkRelease(st.header, st.cycles);
        if (st.header.controls.name !== null) out.push('soak:report: NOTE -- control kernel ' + st.header.controls.name + ', not release evidence');
        out.push('soak:report: verdict ' + v.verdict + ' (consistent)');
        if (rel !== null) return { exitCode: 1, out, err: ['soak:report: NOT A RELEASE SOAK -- ' + rel.reason + ': ' + rel.detail] };
        return { exitCode: 0, out, err: [] };
    } catch (e) {
        if (e instanceof Integrity) return { exitCode: 1, out, err: ['soak:report: INTEGRITY -- ' + e.cls + ': ' + e.message] };
        // a malformed value that slipped past the field checks is still a stream defect, never a pass
        if (e instanceof GateInputError || e instanceof TypeError || e instanceof RangeError) return { exitCode: 1, out, err: ['soak:report: INTEGRITY -- malformed: ' + e.message] };
        return { exitCode: 1, out, err: ['soak:report: CRASH -- ' + (e && e.stack ? e.stack : String(e))] };
    }
}

function isEntry() {
    if (!process.argv[1]) return false;
    try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntry()) {
    const args = process.argv.slice(2);
    let r;
    if (args.length !== 1 || args[0].indexOf('-') === 0) {
        r = { exitCode: EXIT_CODE.CONFIG, out: [], err: ['soak:report: CONFIG -- usage: node bench/soak/SoakReport.mjs <stream.jsonl> (exactly one path; got ' + args.length + ' argument(s)' + (args.length ? ': ' + args.join(' ') : '') + ')'] };
    } else r = report(args[0]);
    for (const l of r.out) writeLineSync(1, l);
    for (const l of r.err) writeLineSync(2, l.replace(/\r?\n/g, ' | '));
    process.exitCode = r.exitCode;
}
