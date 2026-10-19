// 67-soak-taint.test.mjs -- the soak taint-skip gate on the NEST lane (unit 0s-D6, batch B1a).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// Written from .handoff/PLAN-0s-d6.md ADDENDUM 1 + ADDENDUM 2 (A3', A4), never from the implementation.
//
//   P-NEST-TAINT-HALF  THE taint-skip must-fail (ADDENDUM 1 item 2). A preload patches Model.prototype.tainted
//                      to answer true for every odd node index, so roughly half of every skipping oracle's
//                      checks are skipped. On BOTH kernels the taint-skip gate must read INCONCLUSIVE, whatever
//                      the exit: live (full-length worlds, ~425 ops/world, exit 3) and headpatched (short worlds,
//                      ~33 ops/world, every world fails on DIV-F15, exit 1). World-length independent.
//   live NEST smoke    unpatched: the taint-skip gate passes (A3': max(O1c, O1e) skip ratio <= TAINT_SKIP_MAX
//                      0.35; b70 V1 measured O1c .125-.142 / O1e .218-.232), 0 failing worlds, 0 BREACH. On the
//                      pre-D6 exec.mjs (blanket in-flight frame taint) this case is RED (O1c ~.577 / O1e ~.434).
//
// Kernel binding: kernel.mjs reads SOAK_KERNEL once at import, so every case runs main.mjs in a CHILD node process.
// live = no SOAK_KERNEL; headpatched = bench/soak/controls/headpatched/Signal.js. A missing kernel is RED, never a
// skip. The gate is read twice: the `soak: INCONCLUSIVE -- taint-skip ...` stderr lines and the JSONL summary
// record (perLane.NEST.totals + causes) that main.mjs writes to SOAK_OUT.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SKIP_NAMES } from '../bench/soak/exec.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAIN = join(ROOT, 'bench', 'soak', 'main.mjs');
const MODEL = join(ROOT, 'bench', 'soak', 'model.mjs');
const HEADPATCHED = join(ROOT, 'bench', 'soak', 'controls', 'headpatched', 'Signal.js');
const SEED = '12648430';            // 0xC0FFEE, the REPORT seed of A3'
const TAINT_SKIP_MAX = 0.35;        // config.mjs TAINT_SKIP_MAX (D3: stays 0.35)
const SKIPPING = SKIP_NAMES;
const TAINT_LINE = new RegExp('^soak: INCONCLUSIVE -- taint-skip lane=NEST oracle=(' + SKIP_NAMES.join('|') + ') ratio=([0-9.]+) > 0\\.35$');

const TMP = mkdtempSync(join(tmpdir(), 'soak-taint-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// The preload: same module URL as main.mjs's own import of model.mjs, so the patch lands on the live class.
const HALF = join(TMP, 'half.mjs');
writeFileSync(HALF,
    "import { Model } from " + JSON.stringify(pathToFileURL(MODEL).href) + ";\n" +
    "const orig = Model.prototype.tainted;\n" +
    "if (typeof orig !== 'function') throw new Error('half.mjs: Model.prototype.tainted is not a function');\n" +
    "Model.prototype.tainted = function (i, tmemo) { return (i & 1) === 1 ? true : orig.call(this, i, tmemo); };\n");

function smoke(label, opts) {
    const out = join(TMP, label + '.jsonl');
    const env = Object.assign({}, process.env, { SOAK_LANES: 'NEST', SOAK_SEED: SEED, SOAK_OUT: out });
    for (const k of Object.keys(env)) if (k.startsWith('SOAK_') && k !== 'SOAK_LANES' && k !== 'SOAK_SEED' && k !== 'SOAK_OUT') delete env[k];
    if (opts.kernel !== undefined) env.SOAK_KERNEL = opts.kernel;
    const args = ['--expose-gc'];
    if (opts.half) args.push('--import', pathToFileURL(HALF).href);
    args.push(MAIN, '--smoke');
    const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 300000 });
    assert.equal(r.error, undefined, label + ': spawn error ' + r.error);
    assert.ok(existsSync(out), label + ': no JSONL at SOAK_OUT (exit ' + r.status + ')\n' + r.stderr);
    const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const sum = recs[recs.length - 1];
    assert.equal(sum.type, 'summary', label + ': last JSONL record is not the summary');
    const nest = sum.perLane && sum.perLane.NEST;
    assert.ok(nest && nest.totals, label + ': summary has no perLane.NEST.totals');
    const t = nest.totals;
    const ratio = {};
    for (const o of SKIPPING) {
        const perf = t.checks[o], skip = t.skipTainted[o];
        assert.ok(Number.isInteger(perf) && Number.isInteger(skip), label + ': ' + o + ' counts missing');
        ratio[o] = perf + skip === 0 ? 0 : skip / (perf + skip);
    }
    const lines = r.stderr.split('\n');
    const taintLines = lines.filter((l) => l.startsWith('soak: INCONCLUSIVE -- taint-skip '));
    const taintCauses = (nest.causes || []).filter((c) => c.startsWith('soak: INCONCLUSIVE -- taint-skip '));
    return { status: r.status, stderr: r.stderr, sum, t, ratio, taintLines, taintCauses };
}

function assertTaintTrips(label, res) {
    assert.notEqual(res.status, 0, label + ': exit 0 -- the taint-skip gate did not trip');
    assert.notEqual(res.status, 2, label + ': exit 2 (config refusal), not a soak verdict\n' + res.stderr);
    assert.ok(res.taintLines.length >= 1, label + ': no `soak: INCONCLUSIVE -- taint-skip` stderr line\n' + res.stderr);
    for (const l of res.taintLines) assert.match(l, TAINT_LINE, label + ': taint-skip line form');
    assert.deepEqual(res.taintCauses, res.taintLines, label + ': summary perLane.NEST.causes taint-skip != stderr lines');
    assert.ok(res.sum.inconclusive.some((c) => c.startsWith('soak: INCONCLUSIVE -- taint-skip lane=NEST ')),
        label + ': summary.inconclusive has no taint-skip cause');
    // the patch skips ~half of the checks on both of the oracles the gate is cut on
    for (const o of ['O1c', 'O1e']) {
        assert.ok(res.ratio[o] > TAINT_SKIP_MAX, label + ': ' + o + ' ratio ' + res.ratio[o].toFixed(3) + ' <= 0.35');
        assert.ok(res.taintLines.some((l) => l.indexOf(' oracle=' + o + ' ') !== -1), label + ': no taint-skip line for ' + o);
    }
}

test('P-NEST-TAINT-HALF trips the taint-skip gate on the LIVE kernel (full-length worlds)', () => {
    const res = smoke('half-live', { half: true });
    assertTaintTrips('half-live', res);
    assert.equal(res.status, 3, 'half-live: expected INCONCLUSIVE exit 3\n' + res.stderr);
    assert.equal(res.sum.verdict, 'INCONCLUSIVE');
    assert.ok(res.t.ops / res.t.worlds > 300, 'half-live: worlds are not full length (' + (res.t.ops / res.t.worlds) + ' ops/world)');
});

test('P-NEST-TAINT-HALF trips the taint-skip gate on the HEADPATCHED kernel (short failing worlds)', () => {
    assert.ok(existsSync(HEADPATCHED), 'headpatched control kernel missing: ' + HEADPATCHED);
    const res = smoke('half-headpatched', { half: true, kernel: HEADPATCHED });
    assertTaintTrips('half-headpatched', res);
    assert.ok(res.t.failingWorlds > 0, 'half-headpatched: the control kernel failed no world');
    assert.ok(res.t.ops / res.t.worlds < 100, 'half-headpatched: worlds are not short (' + (res.t.ops / res.t.worlds) + ' ops/world)');
});

test('unpatched live NEST smoke passes the taint-skip gate (A3\': max(O1c, O1e) <= 0.35), 0 failing, 0 BREACH', () => {
    const res = smoke('live', {});
    assert.deepEqual(res.taintLines, [], 'live: taint-skip tripped\n' + res.taintLines.join('\n'));
    assert.deepEqual(res.taintCauses, [], 'live: summary carries a taint-skip cause');
    for (const o of SKIPPING) {
        assert.ok(res.t.checks[o] > 0, 'live: oracle ' + o + ' performed no check');
        assert.ok(res.ratio[o] <= TAINT_SKIP_MAX, 'live: ' + o + ' skip ratio ' + res.ratio[o].toFixed(3) + ' > 0.35');
    }
    assert.equal(res.t.failingWorlds, 0, 'live: failing worlds');
    assert.deepEqual(res.sum.breaches, [], 'live: BREACH records');
    assert.equal(res.status, 0, 'live: exit ' + res.status + '\n' + res.stderr);
    assert.equal(res.sum.verdict, 'SMOKE');
});
