// bench/andrii-analyze.mjs -- analysis of andrii-run.mjs legs (PLAN-PD-A TASK 4; 7 adapters per
// D-b170-5, the reset-root diagnostic is dropped).
// REPORTED tier: ranks and ratios for docs, never a gate inside npm test.
//
// CLI:  node bench/andrii-analyze.mjs --leg <dir> [--leg <dir2>] --out <dir>
//            [--candidate-version <v>] [--rounds 3] [--profile quick]
//   Each <dir> holds samples.json (C's BENCH_SAMPLES_FILE) and HEADER.txt (written by
//   andrii-run; REQUIRED). HEADER's single `node: vX` line joins the mixed-node check and its
//   single `build: <commit>-<sha8> candidate version <v>` line gives the candidate version;
//   --candidate-version, when given, must equal it, and two legs must agree. Writes
//   <out>/summary.md + <out>/summary.json. Exit 1 on any fatal input (nothing is written), on a
//   usage error, or when two legs carry different bundleSha256. Importing this module runs
//   nothing.
//
// Input format (single-process run, written by C/src/util/benchmark.ts saveTimingRecords
// :955-1016): top level {semantics, profile, policy {rounds, ...}, node, v8, platform, cpu,
// bundleSha256, packages {<framework>: {<package>: <version>}} (from each worker's
// dist/workers/<id>.packages.json, :945-953), sourceCommit, rows: (TimingRecord |
// FailedRecord)[]}. TimingRecord (:56-79): {id "<framework> :: <name>", framework, name,
// validation "passed"|"absent", capped bool, estimateMs (median of round medians, :879),
// interval {kind "round-median-range"|"median-order-statistic-95", lowMs, highMs} (absent on
// capped rows, :852-861), group, family, rounds[], wallMs}. FailedRecord (:108-118): {id,
// framework, name, title, status "failed", failure {kind, message}, group, family}. A
// merged multi-machine file (top-level `merged`, as in C/bench-results/latest.samples.json)
// is refused. The samples DO carry versions (samples.packages), so the version check runs here
// as well as in andrii-run.
//
// Adapters (exactly 7 per leg; any other framework is fatal):
//   LAZY  = lite-signal (1.5.2), lite-signal-1.6, lite-signal-reset, alien-signals
//   EAGER = lite-signal-eager (1.5.2), lite-signal-eager-1.6, lite-signal-eager-reset, alien-signals
//   OVERALL = ADAPTERS = the 7 adapters of LAZY + EAGER
//
// Row classes (a "row" = one scenario name across the 7 adapters):
//   void   -- some adapter has no record for it, or a record's validation is not "passed":
//             listed with the reason, excluded from everything.
//   capped -- complete and passed, but at least one adapter's record is capped: listed with
//             the capped adapters, excluded from every rank, geomean and ratio.
//   ranked -- everything else; every geomean / rank / ratio below is over ranked rows only.
//
// Fatal (analyzeLeg throws Error, message starts with 'andrii-analyze: '): not a plain object
// with a rows array; merged file; node missing or more than one node version among
// samples.node, opts.headerNode, row.node, row.machines[].node; opts.rounds / opts.profile
// given and different from policy.rounds / profile; a row without string framework / name;
// an unexpected framework; a FAILED row (status "failed"); a duplicate framework + name; a
// non-failed record whose estimateMs is not finite > 0, or whose interval bounds are not
// finite > 0 with lowMs <= highMs; an expected adapter absent from the rows or from
// samples.packages; lite-signal / lite-signal-eager not bundling @zakkster/lite-signal ==
// opts.stableVersion; any of the 4 candidate adapters not bundling == opts.candidateVersion;
// alien-signals not bundling alien-signals or bundling lite-signal; zero ranked rows; an
// unknown opts key (did-you-mean); opts.candidateVersion missing or not a string.
//
// Exported API (pure; no I/O except loadLeg):
//   ADAPTERS, LAZY, EAGER, OVERALL, PAIRS, DEFAULTS {stableVersion}
//   geomean(xs) -> number           exp(mean(ln x)); fatal on a non-array, empty, or any
//                                   element not finite > 0.
//   analyzeLeg(samples, opts?) -> LegResult
//       opts: {candidateVersion (REQUIRED), label?, stableVersion? ('1.5.2'), rounds?,
//              profile?, headerNode?}
//   compareLegs(a, b) -> CrossLeg   fatal when bundleSha256 differs or is missing.
//   buildSummary(legResults) -> Summary   (1 or 2 legs; 2 -> crossLeg = compareLegs)
//   renderSummary(summaryOrLeg) -> string (markdown; ratios printed with toFixed(8),
//                                   estimates with toFixed(6); a bare LegResult is wrapped)
//   loadLeg(dir) -> {samples, headerNode, candidateVersion}   reads <dir>/samples.json +
//                                   <dir>/HEADER.txt; fatal when either is missing or HEADER
//                                   lacks exactly one node: line / build ... candidate version line
//
// summary.json = Summary:
//   {tool: 'andrii-analyze', schema: 1, legs: LegResult[], crossLeg: CrossLeg | null}
// LegResult:
//   {label, node, v8, platform, cpu, bundleSha256, sourceCommit, rounds, profile,
//    packages: {<adapter>: <lite-signal or alien-signals version>},
//    adapters: string[7], recordsPerAdapter: {<adapter>: n},
//    rowsTotal, rowsRanked: string[], void: [{name, reason}], capped: [{name, adapters: []}],
//    rows: [{name, group, family, estimateMs: {<adapter>: ms}, lowMs: {..}, highMs: {..}}],
//    groups: {LAZY|EAGER|OVERALL: {members: string[], table: [{adapter, rank, toAlien,
//             toBest, wins}]}}           rank 1 = smallest toAlien (competition ranking on
//                                        exact ties); toAlien = geomean(est / est_alien);
//                                        toBest = geomean(est / min est in the group), the
//                                        upstream style; wins = rows where est == group min.
//    ratios: {<num>/<den>: Ratio} for PAIRS.compare (1.6 / 1.5.2, reset / 1.6 destroy)}
// Ratio: {num, den, geomean, min, max, rows: [{name, ratio, low, high}]}
//   ratio = est_num / est_den; low = lowMs_num / highMs_den; high = highMs_num / lowMs_den
//   (round-median range; a record without an interval uses estimateMs for both bounds).
// CrossLeg:
//   {legs: [labelA, labelB], nodes: [nodeA, nodeB], bundleSha256, rowsRankedBoth: n,
//    groups: {LAZY|EAGER|OVERALL: {orderA: string[], orderB: string[], identical: bool,
//             spearman: number (Pearson on the rank vectors; 1 when both are constant),
//             maxAbsDelta, deltas: {<adapter>: rankB - rankA}}}}
//
// Zero deps, node: builtins only.

import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALIEN = 'alien-signals';
export const LITE_PKG = '@zakkster/lite-signal';
export const LAZY = Object.freeze(['lite-signal', 'lite-signal-1.6', 'lite-signal-reset', ALIEN]);
export const EAGER = Object.freeze(['lite-signal-eager', 'lite-signal-eager-1.6', 'lite-signal-eager-reset', ALIEN]);
export const OVERALL = Object.freeze(['lite-signal', 'lite-signal-eager', 'lite-signal-1.6', 'lite-signal-eager-1.6',
  'lite-signal-reset', 'lite-signal-eager-reset', ALIEN]);
export const ADAPTERS = OVERALL;
const STABLE_ADAPTERS = ['lite-signal', 'lite-signal-eager'];
const CANDIDATE_ADAPTERS = ['lite-signal-1.6', 'lite-signal-eager-1.6', 'lite-signal-reset', 'lite-signal-eager-reset'];
export const PAIRS = Object.freeze({
  compare: Object.freeze([
    ['lite-signal-1.6', 'lite-signal'],
    ['lite-signal-eager-1.6', 'lite-signal-eager'],
    ['lite-signal-reset', 'lite-signal-1.6'],
    ['lite-signal-eager-reset', 'lite-signal-eager-1.6'],
  ]),
});
export const DEFAULTS = Object.freeze({ stableVersion: '1.5.2' });
const OPT_KEYS = ['label', 'candidateVersion', 'stableVersion', 'rounds', 'profile', 'headerNode'];

function fatal(msg) {
  throw new Error('andrii-analyze: ' + msg);
}

function lev(a, b) {
  const row = [];
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function didYouMean(key, keys) {
  let best = null;
  let bestD = Infinity;
  for (const k of keys) {
    const d = lev(key, k);
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= 3 ? ' (did you mean ' + best + '?)' : '';
}

function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
}

function isPos(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

export function geomean(xs) {
  if (!Array.isArray(xs)) fatal('geomean needs an array');
  if (xs.length === 0) fatal('geomean of an empty list');
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!isPos(xs[i])) fatal('geomean element ' + i + ' is not finite > 0: ' + String(xs[i]));
    s += Math.log(xs[i]);
  }
  return Math.exp(s / xs.length);
}

function competitionRanks(entries) {
  // entries: [{adapter, value}] -> Map adapter -> rank (1 = smallest; exact ties share)
  const sorted = [...entries].sort((x, y) => x.value - y.value || (x.adapter < y.adapter ? -1 : 1));
  const ranks = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const r = i > 0 && sorted[i].value === sorted[i - 1].value ? ranks.get(sorted[i - 1].adapter) : i + 1;
    ranks.set(sorted[i].adapter, r);
  }
  return ranks;
}

function ratioOf(num, den, rows) {
  const out = [];
  for (const r of rows) {
    out.push({
      name: r.name,
      ratio: r.estimateMs[num] / r.estimateMs[den],
      low: r.lowMs[num] / r.highMs[den],
      high: r.highMs[num] / r.lowMs[den],
    });
  }
  const vals = out.map((x) => x.ratio);
  return { num, den, geomean: geomean(vals), min: Math.min(...vals), max: Math.max(...vals), rows: out };
}

export function analyzeLeg(samples, opts) {
  const o = opts === undefined ? {} : opts;
  if (!isPlainObject(o)) fatal('opts must be a plain object');
  for (const k of Object.keys(o)) if (!OPT_KEYS.includes(k)) fatal('unknown opts key ' + JSON.stringify(k) + didYouMean(k, OPT_KEYS));
  const candidateVersion = o.candidateVersion;
  const stableVersion = o.stableVersion === undefined ? DEFAULTS.stableVersion : o.stableVersion;
  if (typeof candidateVersion !== 'string' || typeof stableVersion !== 'string') fatal('opts.candidateVersion (required) and opts.stableVersion must be strings');
  if (!isPlainObject(samples) || !Array.isArray(samples.rows)) fatal('samples must be an object with a rows array');
  if ('merged' in samples) fatal('merged multi-machine samples are not a leg');

  // node: one version per leg
  const nodes = new Set();
  if (typeof samples.node !== 'string' || !/^v\d+\.\d+\.\d+/.test(samples.node)) fatal('samples.node missing or malformed: ' + String(samples.node));
  nodes.add(samples.node);
  if (o.headerNode !== undefined) nodes.add(o.headerNode);
  for (const r of samples.rows) {
    if (r && typeof r === 'object') {
      if ('node' in r) nodes.add(r.node);
      if (Array.isArray(r.machines)) for (const m of r.machines) if (m && 'node' in m) nodes.add(m.node);
    }
  }
  if (nodes.size !== 1) fatal('mixed node versions in one leg: ' + [...nodes].map(String).join(', '));
  const policyRounds = samples.policy && samples.policy.rounds;
  if (o.rounds !== undefined && policyRounds !== o.rounds) fatal('policy.rounds ' + String(policyRounds) + ' != ' + o.rounds);
  if (o.profile !== undefined && samples.profile !== o.profile) fatal('profile ' + String(samples.profile) + ' != ' + o.profile);

  // records
  const byAdapter = new Map(ADAPTERS.map((a) => [a, new Map()]));
  const names = [];
  const seenName = new Set();
  for (const r of samples.rows) {
    if (!r || typeof r !== 'object' || typeof r.framework !== 'string' || typeof r.name !== 'string') {
      fatal('row without string framework / name: ' + JSON.stringify(r).slice(0, 120));
    }
    if (!byAdapter.has(r.framework)) fatal('unexpected adapter ' + JSON.stringify(r.framework) + ' (expected exactly ' + ADAPTERS.join(', ') + ')');
    if (r.status === 'failed') {
      const f = r.failure || {};
      fatal('FAILED row ' + (r.id || r.framework + ' :: ' + r.name) + ': ' + String(f.kind) + ': ' + String(f.message));
    }
    const m = byAdapter.get(r.framework);
    if (m.has(r.name)) fatal('duplicate row ' + r.framework + ' :: ' + r.name);
    if (!isPos(r.estimateMs)) fatal('row ' + r.framework + ' :: ' + r.name + ' estimateMs not finite > 0: ' + String(r.estimateMs));
    if (r.interval !== undefined) {
      const iv = r.interval;
      if (!iv || !isPos(iv.lowMs) || !isPos(iv.highMs) || iv.lowMs > iv.highMs) {
        fatal('row ' + r.framework + ' :: ' + r.name + ' interval malformed: ' + JSON.stringify(iv));
      }
    }
    m.set(r.name, r);
    if (!seenName.has(r.name)) { seenName.add(r.name); names.push(r.name); }
  }
  const recordsPerAdapter = {};
  for (const a of ADAPTERS) {
    recordsPerAdapter[a] = byAdapter.get(a).size;
    if (byAdapter.get(a).size === 0) fatal('expected adapter ' + a + ' absent from the leg');
  }

  // versions
  if (!isPlainObject(samples.packages)) fatal('samples carry no packages map');
  const packages = {};
  for (const a of ADAPTERS) {
    const pk = samples.packages[a];
    if (!isPlainObject(pk)) fatal('expected adapter ' + a + ' absent from samples.packages');
    if (a === ALIEN) {
      if (typeof pk[ALIEN] !== 'string') fatal(ALIEN + ' worker does not bundle ' + ALIEN + ': ' + JSON.stringify(pk));
      if (LITE_PKG in pk) fatal(ALIEN + ' worker bundles ' + LITE_PKG);
      packages[a] = pk[ALIEN];
      continue;
    }
    const want = STABLE_ADAPTERS.includes(a) ? stableVersion : candidateVersion;
    if (pk[LITE_PKG] !== want) fatal(a + ' bundles ' + LITE_PKG + ' ' + JSON.stringify(pk[LITE_PKG]) + ', expected ' + want);
    packages[a] = pk[LITE_PKG];
  }
  if (!CANDIDATE_ADAPTERS.every((a) => packages[a] === candidateVersion)) fatal('candidate adapters disagree on version');

  // row classes
  const voidRows = [];
  const cappedRows = [];
  const rows = [];
  for (const name of names) {
    const missing = ADAPTERS.filter((a) => !byAdapter.get(a).has(name));
    if (missing.length) { voidRows.push({ name, reason: 'missing: ' + missing.join(', ') }); continue; }
    const notPassed = ADAPTERS.filter((a) => byAdapter.get(a).get(name).validation !== 'passed');
    if (notPassed.length) {
      voidRows.push({ name, reason: 'validation not passed: ' + notPassed.map((a) => a + '=' + String(byAdapter.get(a).get(name).validation)).join(', ') });
      continue;
    }
    const capped = ADAPTERS.filter((a) => byAdapter.get(a).get(name).capped !== false);
    if (capped.length) { cappedRows.push({ name, adapters: capped }); continue; }
    const first = byAdapter.get(ALIEN).get(name);
    const row = { name, group: first.group, family: first.family, estimateMs: {}, lowMs: {}, highMs: {} };
    for (const a of ADAPTERS) {
      const rec = byAdapter.get(a).get(name);
      row.estimateMs[a] = rec.estimateMs;
      row.lowMs[a] = rec.interval ? rec.interval.lowMs : rec.estimateMs;
      row.highMs[a] = rec.interval ? rec.interval.highMs : rec.estimateMs;
    }
    rows.push(row);
  }
  if (rows.length === 0) fatal('no ranked rows (void ' + voidRows.length + ', capped ' + cappedRows.length + ')');

  // groups
  const groups = {};
  for (const [gname, members] of [['LAZY', LAZY], ['EAGER', EAGER], ['OVERALL', OVERALL]]) {
    const toAlien = new Map(members.map((a) => [a, []]));
    const toBest = new Map(members.map((a) => [a, []]));
    const wins = new Map(members.map((a) => [a, 0]));
    for (const r of rows) {
      let best = Infinity;
      for (const a of members) if (r.estimateMs[a] < best) best = r.estimateMs[a];
      for (const a of members) {
        toAlien.get(a).push(r.estimateMs[a] / r.estimateMs[ALIEN]);
        toBest.get(a).push(r.estimateMs[a] / best);
        if (r.estimateMs[a] === best) wins.set(a, wins.get(a) + 1);
      }
    }
    const entries = members.map((a) => ({ adapter: a, value: geomean(toAlien.get(a)) }));
    const ranks = competitionRanks(entries);
    const table = entries.map((e) => ({ adapter: e.adapter, rank: ranks.get(e.adapter), toAlien: e.value,
      toBest: geomean(toBest.get(e.adapter)), wins: wins.get(e.adapter) }));
    table.sort((x, y) => x.rank - y.rank || (x.adapter < y.adapter ? -1 : 1));
    groups[gname] = { members: [...members], table };
  }

  const ratios = {};
  for (const [n, d] of PAIRS.compare) ratios[n + '/' + d] = ratioOf(n, d, rows);

  return {
    label: o.label === undefined ? samples.node : String(o.label),
    node: samples.node,
    v8: samples.v8 === undefined ? null : samples.v8,
    platform: samples.platform === undefined ? null : samples.platform,
    cpu: samples.cpu === undefined ? null : samples.cpu,
    bundleSha256: samples.bundleSha256 === undefined ? null : samples.bundleSha256,
    sourceCommit: samples.sourceCommit === undefined ? null : samples.sourceCommit,
    rounds: policyRounds === undefined ? null : policyRounds,
    profile: samples.profile === undefined ? null : samples.profile,
    packages,
    adapters: [...ADAPTERS],
    recordsPerAdapter,
    rowsTotal: names.length,
    rowsRanked: rows.map((r) => r.name),
    void: voidRows,
    capped: cappedRows,
    rows,
    groups,
    ratios,
  };
}

function rankVector(table, members) {
  const m = new Map(table.map((t) => [t.adapter, t.rank]));
  return members.map((a) => m.get(a));
}

function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) * (x[i] - mx);
    syy += (y[i] - my) * (y[i] - my);
  }
  if (sxx === 0 && syy === 0) return 1;
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

export function compareLegs(a, b) {
  if (!a || !b || !a.groups || !b.groups) fatal('compareLegs needs two analyzeLeg results');
  if (typeof a.bundleSha256 !== 'string' || typeof b.bundleSha256 !== 'string') fatal('bundleSha256 missing in a leg');
  if (a.bundleSha256 !== b.bundleSha256) fatal('bundleSha256 differs across legs: ' + a.bundleSha256 + ' vs ' + b.bundleSha256);
  const both = a.rowsRanked.filter((n) => b.rowsRanked.includes(n)).length;
  const groups = {};
  for (const g of ['LAZY', 'EAGER', 'OVERALL']) {
    const members = a.groups[g].members;
    const ra = rankVector(a.groups[g].table, members);
    const rb = rankVector(b.groups[g].table, members);
    const deltas = {};
    let maxAbs = 0;
    for (let i = 0; i < members.length; i++) {
      deltas[members[i]] = rb[i] - ra[i];
      if (Math.abs(rb[i] - ra[i]) > maxAbs) maxAbs = Math.abs(rb[i] - ra[i]);
    }
    const orderA = a.groups[g].table.map((t) => t.adapter);
    const orderB = b.groups[g].table.map((t) => t.adapter);
    groups[g] = { orderA, orderB, identical: JSON.stringify(ra) === JSON.stringify(rb), spearman: pearson(ra, rb),
      maxAbsDelta: maxAbs, deltas };
  }
  return { legs: [a.label, b.label], nodes: [a.node, b.node], bundleSha256: a.bundleSha256, rowsRankedBoth: both, groups };
}

export function buildSummary(legResults) {
  if (!Array.isArray(legResults) || legResults.length < 1 || legResults.length > 2) fatal('buildSummary needs 1 or 2 leg results');
  return { tool: 'andrii-analyze', schema: 1, legs: legResults,
    crossLeg: legResults.length === 2 ? compareLegs(legResults[0], legResults[1]) : null };
}

function f8(x) {
  return x.toFixed(8);
}

function ratioTable(lines, title, ratio) {
  lines.push('', '#### ' + title, '');
  lines.push('geomean ' + f8(ratio.geomean) + ' (per-row min ' + f8(ratio.min) + ', max ' + f8(ratio.max) + ', ' + ratio.rows.length + ' rows)', '');
  lines.push('| row | ' + ratio.num + ' / ' + ratio.den + ' | round range |', '|---|---:|---|');
  for (const r of ratio.rows) lines.push('| ' + r.name + ' | ' + f8(r.ratio) + ' | ' + f8(r.low) + '..' + f8(r.high) + ' |');
}

export function renderSummary(summaryOrLeg) {
  const s = summaryOrLeg && Array.isArray(summaryOrLeg.legs) ? summaryOrLeg : buildSummary([summaryOrLeg]);
  const lines = ['# Andrii js-reactivity-benchmark rerun -- summary (REPORTED)', ''];
  lines.push('Ranks within each table, not absolute times. Ratios are geomeans over ranked rows (complete, all',
    'validation "passed", none capped), over the 7 adapters.');
  for (const leg of s.legs) {
    lines.push('', '## Leg ' + leg.label, '');
    lines.push('- node ' + leg.node + ', v8 ' + leg.v8 + ', ' + leg.platform + ', cpu ' + leg.cpu);
    lines.push('- bundleSha256 ' + leg.bundleSha256 + ', sourceCommit ' + leg.sourceCommit + ', rounds ' + leg.rounds + ', profile ' + leg.profile);
    lines.push('- packages: ' + leg.adapters.map((a) => a + '=' + leg.packages[a]).join(', '));
    lines.push('- rows: total ' + leg.rowsTotal + ', ranked ' + leg.rowsRanked.length + ', void ' + leg.void.length + ', capped ' + leg.capped.length);
    lines.push('- records per adapter: ' + leg.adapters.map((a) => a + '=' + leg.recordsPerAdapter[a]).join(', '));
    for (const g of ['LAZY', 'EAGER', 'OVERALL']) {
      lines.push('', '### ' + g + (g === 'OVERALL' ? ' (all 7 adapters)' : ''), '');
      lines.push('| rank | adapter | geomean / alien | geomean / best (upstream style) | row wins |', '|---:|---|---:|---:|---:|');
      for (const t of leg.groups[g].table) lines.push('| ' + t.rank + ' | ' + t.adapter + ' | ' + f8(t.toAlien) + ' | ' + f8(t.toBest) + ' | ' + t.wins + ' |');
    }
    lines.push('', '### 1.6 vs 1.5.2 and reset vs 1.6 destroy (per row, round range)');
    for (const k of Object.keys(leg.ratios)) ratioTable(lines, k, leg.ratios[k]);
    lines.push('', '### Void rows (excluded)', '');
    if (leg.void.length === 0) lines.push('none');
    for (const v of leg.void) lines.push('- ' + v.name + ' -- ' + v.reason);
    lines.push('', '### Capped rows (listed, not ranked)', '');
    if (leg.capped.length === 0) lines.push('none');
    for (const c of leg.capped) lines.push('- ' + c.name + ' -- capped: ' + c.adapters.join(', '));
  }
  if (s.crossLeg) {
    const x = s.crossLeg;
    lines.push('', '## Rank agreement ' + x.legs[0] + ' (' + x.nodes[0] + ') vs ' + x.legs[1] + ' (' + x.nodes[1] + ')', '');
    lines.push('bundleSha256 ' + x.bundleSha256 + ' (identical); rows ranked in both legs: ' + x.rowsRankedBoth, '');
    lines.push('| group | identical | spearman | max abs rank delta | order ' + x.nodes[0] + ' | order ' + x.nodes[1] + ' |', '|---|---|---:|---:|---|---|');
    for (const g of ['LAZY', 'EAGER', 'OVERALL']) {
      const c = x.groups[g];
      lines.push('| ' + g + ' | ' + (c.identical ? 'yes' : 'NO') + ' | ' + f8(c.spearman) + ' | ' + c.maxAbsDelta + ' | ' + c.orderA.join(' > ') + ' | ' + c.orderB.join(' > ') + ' |');
    }
  }
  return lines.join('\n') + '\n';
}

export function loadLeg(dir) {
  const p = path.join(dir, 'samples.json');
  if (!existsSync(p)) fatal('no samples.json in ' + dir);
  let samples;
  try { samples = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { fatal('samples.json unreadable in ' + dir + ': ' + e.message); }
  const h = path.join(dir, 'HEADER.txt');
  if (!existsSync(h)) fatal('no HEADER.txt in ' + dir);
  const text = readFileSync(h, 'utf8');
  const nodeLines = [...text.matchAll(/^node: (\S+)$/gm)];
  if (nodeLines.length !== 1) fatal('HEADER.txt in ' + dir + ' needs exactly one node: line, has ' + nodeLines.length);
  const buildLines = [...text.matchAll(/^build: [0-9a-f]{7,40}-[0-9a-f]{8} candidate version (\S+)$/gm)];
  if (buildLines.length !== 1) fatal('HEADER.txt in ' + dir + ' needs exactly one build: ... candidate version line, has ' + buildLines.length);
  return { samples, headerNode: nodeLines[0][1], candidateVersion: buildLines[0][1] };
}

const CLI_FLAGS = ['--leg', '--out', '--candidate-version', '--rounds', '--profile'];

function cli(argv) {
  const legs = [];
  let out = null;
  let candidateVersion = null;
  let rounds = 3;
  let profile = 'quick';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!CLI_FLAGS.includes(a)) fatal('unknown argument ' + JSON.stringify(a) + didYouMean(a, CLI_FLAGS));
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) fatal(a + ' needs a value');
    if (a === '--leg') legs.push(path.resolve(v));
    else if (a === '--out') out = path.resolve(v);
    else if (a === '--candidate-version') candidateVersion = v;
    else if (a === '--profile') profile = v;
    else {
      rounds = Number(v);
      if (!Number.isInteger(rounds) || rounds < 1) fatal('--rounds must be a positive integer');
    }
  }
  if (legs.length < 1 || legs.length > 2) fatal('give one or two --leg <dir>');
  if (!out) fatal('--out <dir> is required');
  const loaded = legs.map((dir) => ({ dir, ...loadLeg(dir) }));
  for (const l of loaded) {
    if (candidateVersion !== null && l.candidateVersion !== candidateVersion) {
      fatal('candidate version ' + l.candidateVersion + ' in ' + l.dir + '/HEADER.txt != ' + candidateVersion);
    }
    candidateVersion = l.candidateVersion;
  }
  const results = loaded.map((l) => analyzeLeg(l.samples, { label: path.basename(l.dir), candidateVersion, rounds, profile,
    headerNode: l.headerNode }));
  const summary = buildSummary(results);
  const md = renderSummary(summary);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(path.join(out, 'summary.md'), md);
  process.stdout.write('andrii-analyze: wrote ' + path.join(out, 'summary.md') + ' + summary.json (' +
    results.map((r) => r.label + ' ' + r.node + ' ranked ' + r.rowsRanked.length + ' void ' + r.void.length +
      ' capped ' + r.capped.length).join('; ') + ')\n');
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch (e) {
    return false;
  }
}

if (isMain()) {
  try {
    cli(process.argv.slice(2));
  } catch (e) {
    process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
    process.exitCode = 1;
  }
}
