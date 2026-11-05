// 109-andrii-analyze.test.mjs -- PD-A TASK 5. Oracle: PLAN-PD-A A4 + the header contract of
// bench/andrii-analyze.mjs. Every expected number is hand-derived from the fixtures in
// test/fixtures/andrii/good-a (see the table below), never copied from a run.
// Set ANDRII_ANALYZE_PATH to point the whole file at a scratch mutant copy.
//
// good-a ranked rows (estimateMs; every unlisted adapter = the lite-signal value; interval = est/2 .. est*2):
//   r1: alien 1, lite-signal 2, 1.6 4, reset 6     r2: alien 2, lite-signal 2, 1.6 16, reset 8
//   r3 void (lite-signal-reset has no record), r4 void (alien validation "absent"), r5 capped (alien capped).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = process.env.ANDRII_ANALYZE_PATH || path.join(HERE, '..', 'bench', 'andrii-analyze.mjs');
const FX = path.join(HERE, 'fixtures', 'andrii');
const M = await import(pathToFileURL(MOD).href);
const { ADAPTERS, LAZY, EAGER, OVERALL, PAIRS, DEFAULTS, geomean, analyzeLeg, compareLegs,
  buildSummary, renderSummary, loadLeg } = M;

const CAND = '1.6.0-candidate+ce95c8d.d235e505';
const RESET = 'lite-signal-reset';
const ROOT = 'lite-signal-reset-root';   // removed adapter (D-b170-5): now an unexpected framework
const TMP = [];
const mk = () => { const d = mkdtempSync(path.join(tmpdir(), 'pda109-')); TMP.push(d); return d; };
after(() => { for (const d of TMP) rmSync(d, { recursive: true, force: true }); });
const an = (s, o) => analyzeLeg(s, { candidateVersion: CAND, ...o });
const near = (a, b, m) => assert.ok(Math.abs(a - b) <= 1e-12, (m || '') + ' got ' + a + ' want ' + b);
const raw = (d) => JSON.parse(readFileSync(path.join(FX, d, 'samples.json'), 'utf8'));
const leg = (d) => {
  const l = loadLeg(path.join(FX, d));
  return an(l.samples, { headerNode: l.headerNode, label: d });
};
function bad(fn, sub) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof Error);
    assert.ok(e.message.startsWith('andrii-analyze: '), 'prefix: ' + e.message);
    assert.ok(e.message.includes(sub), 'want "' + sub + '" in: ' + e.message);
    return true;
  });
}
const rec = (fw, name, est) => ({ id: fw + ' :: ' + name, framework: fw, name, validation: 'passed', capped: false,
  estimateMs: est, interval: { kind: 'round-median-range', lowMs: est / 2, highMs: est * 2 }, group: 'g', family: 'f',
  rounds: [est], wallMs: 1 });

test('constants: 7 adapters, groups, overall equals the 7', () => {
  assert.deepEqual([...LAZY], ['lite-signal', 'lite-signal-1.6', RESET, 'alien-signals']);
  assert.deepEqual([...EAGER],
    ['lite-signal-eager', 'lite-signal-eager-1.6', 'lite-signal-eager-reset', 'alien-signals']);
  assert.equal(OVERALL.length, 7);
  assert.equal(ADAPTERS.length, 7);
  assert.deepEqual([...ADAPTERS].sort(), [...new Set([...LAZY, ...EAGER])].sort());
  assert.ok(!OVERALL.includes(ROOT) && !ADAPTERS.includes(ROOT));
  assert.equal(M.DIAGNOSTIC, undefined);
  assert.deepEqual({ ...DEFAULTS }, { stableVersion: '1.5.2' });
  assert.deepEqual(PAIRS.compare.map((p) => p.join('/')), ['lite-signal-1.6/lite-signal',
    'lite-signal-eager-1.6/lite-signal-eager', 'lite-signal-reset/lite-signal-1.6',
    'lite-signal-eager-reset/lite-signal-eager-1.6']);
});

test('geomean: exact values', () => {
  near(geomean([2, 8]), 4);
  near(geomean([5]), 5);
  near(geomean([1, 2, 4]), 2);
  near(geomean([2, 1]), Math.SQRT2);
  near(geomean([0.25, 4]), 1);
});

test('geomean: fail closed on [], 0, negative, NaN, Infinity, non-number, non-array', () => {
  bad(() => geomean([]), 'empty');
  bad(() => geomean([1, 0]), 'not finite > 0');
  bad(() => geomean([-1, 4]), 'not finite > 0');
  bad(() => geomean([NaN]), 'not finite > 0');
  bad(() => geomean([Infinity]), 'not finite > 0');
  bad(() => geomean(['2']), 'not finite > 0');
  bad(() => geomean('x'), 'needs an array');
  bad(() => geomean(undefined), 'needs an array');
});

test('A4 exact: {alien 1, lite 2} + {alien 2, lite 2} -> ratio-to-alien 1.414213562373095, md "1.41421356"', () => {
  const r = leg('good-a');
  const t = r.groups.LAZY.table.find((x) => x.adapter === 'lite-signal');
  near(t.toAlien, 1.414213562373095);
  assert.ok(renderSummary(r).includes('1.41421356'));
  assert.ok(renderSummary(buildSummary([r])).includes('1.41421356'));
});

test('row classes: void (missing, validation absent) and capped listed, excluded from ranks', () => {
  const r = leg('good-a');
  assert.equal(r.rowsTotal, 5);
  assert.deepEqual(r.rowsRanked, ['r1', 'r2']);
  assert.deepEqual(r.void.map((v) => v.name), ['r3', 'r4']);
  assert.ok(r.void[0].reason.includes('missing') && r.void[0].reason.includes(RESET));
  assert.ok(r.void[1].reason.includes('alien-signals=absent'));
  assert.deepEqual(r.capped, [{ name: 'r5', adapters: ['alien-signals'] }]);
  assert.deepEqual(r.rows.map((x) => x.name), ['r1', 'r2']);
  assert.equal(r.ratios['lite-signal-1.6/lite-signal'].rows.length, 2);
  const md = renderSummary(r);
  assert.ok(md.includes('- r3 -- missing: ' + RESET));
  assert.ok(md.includes('- r5 -- capped: alien-signals'));
});

test('group tables: exact toAlien, toBest, wins, competition ranks', () => {
  const r = leg('good-a');
  const lazy = r.groups.LAZY.table;
  assert.deepEqual(lazy.map((t) => [t.adapter, t.rank]),
    [['alien-signals', 1], ['lite-signal', 2], [RESET, 3], ['lite-signal-1.6', 4]]);
  const by = (g, a) => r.groups[g].table.find((t) => t.adapter === a);
  near(by('LAZY', 'alien-signals').toAlien, 1);
  near(by('LAZY', RESET).toAlien, Math.sqrt(24));       // (6/1)*(8/2)
  near(by('LAZY', 'lite-signal-1.6').toAlien, Math.sqrt(32)); // (4/1)*(16/2)
  near(by('LAZY', 'lite-signal').toBest, Math.SQRT2);   // (2/1)*(2/2)
  near(by('LAZY', RESET).toBest, Math.sqrt(24));        // (6/1)*(8/2): bests are 1 and 2
  assert.equal(by('LAZY', 'alien-signals').wins, 2);
  assert.equal(by('LAZY', 'lite-signal').wins, 1);      // r2 ties alien at 2
  assert.equal(by('LAZY', RESET).wins, 0);
  // EAGER: the three eager adapters are exactly tied at sqrt2 -> competition rank 2,2,2
  assert.deepEqual(r.groups.EAGER.table.map((t) => t.rank), [1, 2, 2, 2]);
  assert.equal(r.groups.EAGER.table[0].adapter, 'alien-signals');
  // OVERALL: 7 members, four tied at rank 2, then reset 6, 1.6 7
  const o = r.groups.OVERALL;
  assert.equal(o.members.length, 7);
  assert.equal(o.table.length, 7);
  assert.deepEqual(o.table.map((t) => t.rank), [1, 2, 2, 2, 2, 6, 7]);
  assert.equal(o.table[5].adapter, RESET);
  assert.equal(o.table[6].adapter, 'lite-signal-1.6');
});

test('no reset-root anywhere in a result: no diagnostic section, no table member', () => {
  const r = leg('good-a');
  for (const g of ['LAZY', 'EAGER', 'OVERALL']) {
    assert.ok(!r.groups[g].members.includes(ROOT), g + ' members');
    assert.ok(!r.groups[g].table.some((t) => t.adapter === ROOT), g + ' table');
  }
  assert.equal(r.diagnostic, undefined);
  assert.equal(r.adapters.length, 7);
  assert.ok(!JSON.stringify(r).includes('reset-root'));
  assert.ok(!renderSummary(r).includes('reset-root'));
  assert.ok(!renderSummary(r).includes('DIAGNOSTIC'));
  assert.equal(r.recordsPerAdapter[RESET], 4);   // r1 r2 r4 r5 (r3 has none)
});

test('fatal: an 8th adapter lite-signal-reset-root is an unexpected framework', () => {
  const s = raw('good-a');
  s.rows.push(rec(ROOT, 'r1', 3));
  bad(() => an(s), 'unexpected adapter "lite-signal-reset-root"');
});

test('literal tooth: a record with capped ABSENT is not "capped:false" -> row is capped, not ranked', () => {
  const c = raw('good-a');
  delete c.rows.find((x) => x.framework === 'lite-signal' && x.name === 'r1').capped;
  const rc = an(c);
  assert.deepEqual(rc.rowsRanked, ['r2']);
  assert.deepEqual(rc.capped[0], { name: 'r1', adapters: ['lite-signal'] });
  const t = raw('good-a');
  t.rows.find((x) => x.framework === 'lite-signal' && x.name === 'r1').capped = null;
  assert.deepEqual(an(t).rowsRanked, ['r2']);
});

test('ratios 1.6/1.5.2 and reset/1.6 exact, with round ranges', () => {
  const r = leg('good-a');
  const a = r.ratios['lite-signal-1.6/lite-signal'];
  assert.deepEqual([a.num, a.den], ['lite-signal-1.6', 'lite-signal']);
  near(a.rows[0].ratio, 2);     // 4/2
  near(a.rows[1].ratio, 8);     // 16/2
  near(a.geomean, 4);
  near(a.min, 2);
  near(a.max, 8);
  // intervals are est/2..est*2: low = (4/2)/(2*2) = 0.5, high = (4*2)/(2/2) = 8
  near(a.rows[0].low, 0.5);
  near(a.rows[0].high, 8);
  near(r.ratios['lite-signal-eager-1.6/lite-signal-eager'].geomean, 1);
  const b = r.ratios[RESET + '/lite-signal-1.6'];
  near(b.rows[0].ratio, 1.5);   // 6/4
  near(b.rows[1].ratio, 0.5);   // 8/16
  near(b.geomean, Math.sqrt(0.75));
  near(r.ratios['lite-signal-eager-reset/lite-signal-eager-1.6'].geomean, 1);
  assert.equal(Object.keys(r.ratios).length, 4);
});

test('compareLegs: identical order -> identical true; differing order -> exact deltas and spearman', () => {
  const a = leg('good-a');
  const b = leg('good-b');
  const c = compareLegs(a, b);
  assert.deepEqual(c.legs, ['good-a', 'good-b']);
  assert.deepEqual(c.nodes, ['v22.1.0', 'v24.0.0']);
  assert.equal(c.bundleSha256, 'bundle-sha-fixture-0001');
  assert.equal(c.rowsRankedBoth, 2);
  for (const g of ['LAZY', 'EAGER', 'OVERALL']) {
    assert.equal(c.groups[g].identical, true, g);
    near(c.groups[g].spearman, 1);
    assert.equal(c.groups[g].maxAbsDelta, 0);
  }
  // alien made very slow in leg B: LAZY order becomes lite-signal, reset, 1.6, alien
  const s = raw('good-b');
  for (const x of s.rows) if (x.framework === 'alien-signals' && (x.name === 'r1' || x.name === 'r2')) {
    x.estimateMs = 1000; delete x.interval;
  }
  const b2 = an(s, { label: 'slowalien' });
  const c2 = compareLegs(a, b2);
  const l = c2.groups.LAZY;
  assert.equal(l.identical, false);
  assert.deepEqual(l.orderB, ['lite-signal', RESET, 'lite-signal-1.6', 'alien-signals']);
  assert.deepEqual(l.deltas, { 'lite-signal': -1, 'lite-signal-1.6': -1, [RESET]: -1, 'alien-signals': 3 });
  assert.equal(l.maxAbsDelta, 3);
  near(l.spearman, -0.2);   // Pearson of [2,4,3,1] and [1,3,2,4]: sxy -1, sxx = syy = 5
});

test('compareLegs: bundleSha256 mismatch or missing is fatal', () => {
  const s = raw('good-b');
  s.bundleSha256 = 'other';
  bad(() => compareLegs(leg('good-a'), an(s)), 'bundleSha256 differs');
  delete s.bundleSha256;
  bad(() => compareLegs(leg('good-a'), an(s)), 'bundleSha256 missing');
  bad(() => compareLegs(null, leg('good-a')), 'compareLegs needs');
});

test('buildSummary: schema 1, 1 or 2 legs, crossLeg; 0 or 3 legs fatal', () => {
  const a = leg('good-a');
  const s1 = buildSummary([a]);
  assert.equal(s1.tool, 'andrii-analyze');
  assert.equal(s1.schema, 1);
  assert.equal(s1.crossLeg, null);
  const s2 = buildSummary([a, leg('good-b')]);
  assert.equal(s2.legs.length, 2);
  assert.notEqual(s2.crossLeg, null);
  assert.ok(renderSummary(s2).includes('Rank agreement'));
  bad(() => buildSummary([]), 'needs 1 or 2');
  bad(() => buildSummary([a, a, a]), 'needs 1 or 2');
});

test('fatal: an expected adapter absent (rows, and packages)', () => {
  const s = raw('good-a');
  s.rows = s.rows.filter((x) => x.framework !== 'alien-signals');
  bad(() => an(s), 'expected adapter alien-signals absent from the leg');
  const p = raw('good-a');
  delete p.packages['lite-signal-eager'];
  bad(() => an(p), 'expected adapter lite-signal-eager absent from samples.packages');
});

test('fatal: mixed node versions (row field, machines[], opts.headerNode, samples.node missing)', () => {
  const s = raw('good-a');
  s.rows[0].node = 'v20.0.0';
  bad(() => an(s), 'mixed node versions');
  const m = raw('good-a');
  m.rows[0].machines = [{ node: 'v18.0.0' }];
  bad(() => an(m), 'mixed node versions');
  bad(() => an(raw('good-a'), { headerNode: 'v20.0.0' }), 'mixed node versions');
  an(raw('good-a'), { headerNode: 'v22.1.0' });
  const n = raw('good-a');
  delete n.node;
  bad(() => an(n), 'samples.node missing');
});

test('fatal: FAILED row', () => {
  const s = raw('good-a');
  s.rows[3] = { id: 'x :: r1', framework: s.rows[3].framework, name: 'r1', title: 't', status: 'failed',
    failure: { kind: 'validation', message: 'boom' }, group: 'g', family: 'f' };
  bad(() => an(s), 'FAILED row');
  bad(() => an(s), 'boom');
});

test('fatal: doctored candidate version, doctored 1.5.2 version, opts mismatch', () => {
  const l = loadLeg(path.join(FX, 'bad-version'));
  bad(() => an(l.samples), 'lite-signal-1.6 bundles');
  bad(() => an(l.samples), 'expected ' + CAND);
  const s = raw('good-a');
  s.packages['lite-signal']['@zakkster/lite-signal'] = '1.5.1';
  bad(() => an(s), 'lite-signal bundles');
  bad(() => an(s), 'expected 1.5.2');
  const e = raw('good-a');
  e.packages['lite-signal-eager']['@zakkster/lite-signal'] = CAND;
  bad(() => an(e), 'lite-signal-eager bundles');
  bad(() => an(raw('good-a'), { candidateVersion: '1.6.0-other' }), 'expected 1.6.0-other');
  an(raw('good-a'), { candidateVersion: CAND, stableVersion: '1.5.2' });
  const a = raw('good-a');
  a.packages['alien-signals'] = { 'alien-signals': '3.0.0', '@zakkster/lite-signal': '1.5.2' };
  bad(() => an(a), 'alien-signals worker bundles');
  const w = raw('good-a');
  w.packages['alien-signals'] = { lodash: '1' };
  bad(() => an(w), 'does not bundle');
});

test('fatal: unexpected adapter', () => {
  const s = raw('good-a');
  s.rows.push(rec('rogue-signals', 'r1', 1));
  bad(() => an(s), 'unexpected adapter "rogue-signals"');
});

test('fatal: the merged multi-machine format is refused', () => {
  const s = raw('good-a');
  s.merged = { machines: 2 };
  bad(() => an(s), 'merged');
});

test('fatal: rounds / profile mismatch, matching accepted', () => {
  bad(() => an(raw('good-a'), { rounds: 5 }), 'policy.rounds 3 != 5');
  bad(() => an(raw('good-a'), { profile: 'full' }), 'profile quick != full');
  const r = an(raw('good-a'), { rounds: 3, profile: 'quick' });
  assert.equal(r.rounds, 3);
  assert.equal(r.profile, 'quick');
});

test('fatal: unknown opts key with did-you-mean; non-object opts', () => {
  bad(() => an(raw('good-a'), { candidateVersoin: CAND }), 'unknown opts key "candidateVersoin"');
  bad(() => an(raw('good-a'), { candidateVersoin: CAND }), 'did you mean candidateVersion');
  bad(() => an(raw('good-a'), { bogus: 1 }), 'unknown opts key "bogus"');
  bad(() => analyzeLeg(raw('good-a'), []), 'opts must be a plain object');
});

test('fatal: malformed samples and records', () => {
  bad(() => an(null), 'rows array');
  bad(() => an({ node: 'v22.1.0' }), 'rows array');
  const z = raw('good-a'); z.rows[0].estimateMs = 0;
  bad(() => an(z), 'estimateMs not finite > 0');
  const n = raw('good-a'); n.rows[0].estimateMs = NaN;
  bad(() => an(n), 'estimateMs not finite > 0');
  const i = raw('good-a'); i.rows[0].interval = { kind: 'k', lowMs: 5, highMs: 1 };
  bad(() => an(i), 'interval malformed');
  const d = raw('good-a'); d.rows.push({ ...d.rows[0] });
  bad(() => an(d), 'duplicate row');
  const f = raw('good-a'); delete f.rows[0].framework;
  bad(() => an(f), 'without string framework / name');
  const k = raw('good-a'); delete k.packages;
  bad(() => an(k), 'no packages');
});

test('fatal: zero ranked rows', () => {
  const s = raw('good-a');
  s.rows = s.rows.filter((x) => x.name === 'r3' || x.name === 'r4');
  bad(() => an(s), 'no ranked rows');
});

test('loadLeg: reads samples + HEADER node + build version; every missing/bad piece fatal', () => {
  const l = loadLeg(path.join(FX, 'good-b'));
  assert.equal(l.headerNode, 'v24.0.0');
  assert.equal(l.candidateVersion, CAND);
  assert.equal(l.samples.node, 'v24.0.0');
  bad(() => loadLeg(path.join(FX, 'nope')), 'no samples.json');
  const t = mk();
  writeFileSync(path.join(t, 'samples.json'), '{}');
  bad(() => loadLeg(t), 'no HEADER.txt');
  writeFileSync(path.join(t, 'HEADER.txt'), 'nothing here\n');
  bad(() => loadLeg(t), 'needs exactly one node: line');
  writeFileSync(path.join(t, 'HEADER.txt'), 'node: v22.1.0\n');
  bad(() => loadLeg(t), 'needs exactly one build:');
  const B = 'build: ce95c8d-d235e505 candidate version ' + CAND + '\n';
  writeFileSync(path.join(t, 'HEADER.txt'), 'node: v22.1.0\n' + B + B);
  bad(() => loadLeg(t), 'needs exactly one build:');
  writeFileSync(path.join(t, 'HEADER.txt'), 'node: v22.1.0\nnode: v22.1.0\n' + B);
  bad(() => loadLeg(t), 'needs exactly one node: line');
  writeFileSync(path.join(t, 'HEADER.txt'), 'node: v22.1.0\n' + B);
  assert.equal(loadLeg(t).candidateVersion, CAND);
  writeFileSync(path.join(t, 'samples.json'), '{oops');
  bad(() => loadLeg(t), 'unreadable');
});

test('candidateVersion is a required option', () => {
  bad(() => analyzeLeg(raw('good-a')), 'candidateVersion');
  bad(() => analyzeLeg(raw('good-a'), { candidateVersion: 5 }), 'must be strings');
});

function cli(args) {
  return spawnSync(process.execPath, [MOD, ...args], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
}

test('CLI: two good legs -> exit 0, summary.md + summary.json (schema 1)', () => {
  const out = path.join(mk(), 'out');
  const r = cli(['--leg', path.join(FX, 'good-a'), '--leg', path.join(FX, 'good-b'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(j.schema, 1);
  assert.equal(j.tool, 'andrii-analyze');
  assert.deepEqual(j.legs.map((x) => x.label), ['good-a', 'good-b']);
  assert.notEqual(j.crossLeg, null);
  near(j.legs[0].groups.LAZY.table.find((t) => t.adapter === 'lite-signal').toAlien, Math.SQRT2);
  assert.ok(readFileSync(path.join(out, 'summary.md'), 'utf8').includes('1.41421356'));
});

test('CLI: a doctored leg -> exit 1, nothing written; usage errors exit 1', () => {
  const out = path.join(mk(), 'out');
  const r = cli(['--leg', path.join(FX, 'good-a'), '--leg', path.join(FX, 'bad-version'), '--out', out]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.startsWith('andrii-analyze: '), r.stderr);
  assert.equal(existsSync(out), false);
  // mixed node: HEADER.txt says another node than samples.node
  const t = mk();
  const d = path.join(t, 'leg');
  mkdirSync(d);
  writeFileSync(path.join(d, 'samples.json'), readFileSync(path.join(FX, 'good-a', 'samples.json')));
  writeFileSync(path.join(d, 'HEADER.txt'), 'node: v20.9.9\nbuild: ce95c8d-d235e505 candidate version ' + CAND + '\n');
  const r2 = cli(['--leg', d, '--out', path.join(t, 'o2')]);
  assert.equal(r2.status, 1);
  assert.ok(r2.stderr.includes('mixed node versions'), r2.stderr);
  assert.equal(existsSync(path.join(t, 'o2')), false);
  // HEADER.txt is required
  const nh = path.join(t, 'nohdr');
  mkdirSync(nh);
  writeFileSync(path.join(nh, 'samples.json'), readFileSync(path.join(FX, 'good-a', 'samples.json')));
  const r3 = cli(['--leg', nh, '--out', path.join(t, 'o3')]);
  assert.equal(r3.status, 1);
  assert.ok(r3.stderr.includes('no HEADER.txt'), r3.stderr);
  // --candidate-version must equal HEADER's build line
  const r4 = cli(['--leg', path.join(FX, 'good-a'), '--candidate-version', '1.6.0-other',
    '--out', path.join(t, 'o4')]);
  assert.equal(r4.status, 1);
  assert.ok(r4.stderr.includes('candidate version ' + CAND), r4.stderr);
  assert.equal(existsSync(path.join(t, 'o4')), false);
  const ok = cli(['--leg', path.join(FX, 'good-a'), '--candidate-version', CAND, '--out', path.join(t, 'o5')]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(cli(['--leg', path.join(FX, 'good-a')]).status, 1);
  assert.equal(cli(['--bogus', 'x']).status, 1);
  assert.equal(readdirSync(FX).sort().join(), 'bad-version,good-a,good-b');
});

test('importing the module runs nothing (no stdout, no stderr)', () => {
  const code = 'await import(' + JSON.stringify(pathToFileURL(MOD).href) + ')';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});
