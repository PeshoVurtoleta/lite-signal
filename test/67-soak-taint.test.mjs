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
//   live NEST pin      the same child run (one run, memoised): the EXACT performed / skipTainted count of every
//                      skipping oracle at 0xC0FFEE (maintainer ruling b70). The ratio gate alone is blind to an
//                      over-taint (exec.mjs disposeIdx arm without its `sn.t === 'c'` test: O1e .22 -> .297, still
//                      <= 0.35); this pin is not. A legitimate change of exec / model / gen / lanes/nest moves it:
//                      re-pin from the failing message, with the reason in the commit.
//   V1 tainted() arm   in-process Exec vector (no child): an in-flight frame that read a LIVE computed which the
//                      kill taints, but never the victim itself, must end with taintRun true (exec.mjs disposeIdx
//                      `this.M.tainted(r, tm)` arm; b70: deleting that arm leaves every smoke count byte-identical).
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
import { SKIP_NAMES, runWorld } from '../bench/soak/exec.mjs';
import { TAINT_SKIP_MAX } from '../bench/soak/config.mjs';
import { inconclusiveLine } from '../bench/soak/gates.mjs';
import { Model } from '../bench/soak/model.mjs';
import { Detectors } from '../bench/soak/scenarios.mjs';
import { liteAdapter } from '../bench/soak/adapters/lite.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAIN = join(ROOT, 'bench', 'soak', 'main.mjs');
const MODEL = join(ROOT, 'bench', 'soak', 'model.mjs');
const HEADPATCHED = join(ROOT, 'bench', 'soak', 'controls', 'headpatched', 'Signal.js');
const SEED = '12648430';            // 0xC0FFEE, the REPORT seed of A3'
const SKIPPING = SKIP_NAMES;
// the literal 0\.35 is kept on purpose: the D3 test below pins TAINT_SKIP_MAX === 0.35, so the two cannot drift apart
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
    for (const l of res.taintLines) {
        const m = l.match(TAINT_LINE);
        assert.ok(m !== null, label + ': taint-skip line form: ' + l);
        // the line is gates.mjs's own text for the cause, by name (teeth.mjs TEST_ANCHORS: cause:taint-skip)
        assert.equal(l, inconclusiveLine('taint-skip', { lane: 'NEST', oracle: m[1], ratio: m[2], max: TAINT_SKIP_MAX }), label + ': not the taint-skip cause text');
    }
    assert.deepEqual(res.taintCauses, res.taintLines, label + ': summary perLane.NEST.causes taint-skip != stderr lines');
    assert.ok(res.sum.inconclusive.some((c) => c.startsWith('soak: INCONCLUSIVE -- taint-skip lane=NEST ')),
        label + ': summary.inconclusive has no taint-skip cause');
    // the patch skips ~half of the checks on both of the oracles the gate is cut on
    for (const o of ['O1c', 'O1e']) {
        assert.ok(res.ratio[o] > TAINT_SKIP_MAX, label + ': ' + o + ' ratio ' + res.ratio[o].toFixed(3) + ' <= 0.35');
        assert.ok(res.taintLines.some((l) => l.indexOf(' oracle=' + o + ' ') !== -1), label + ': no taint-skip line for ' + o);
    }
}

// One unpatched live NEST smoke child, shared by the A3' gate test and the exact-count pin (never a second run).
let LIVE = null;
const liveRun = () => (LIVE === null ? (LIVE = smoke('live', {})) : LIVE);

test('D3: TAINT_SKIP_MAX is config.mjs\'s constant and stays 0.35', () => {
    assert.equal(TAINT_SKIP_MAX, 0.35);
});

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
    const res = liveRun();
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

// b71 B2 T4: live NEST smoke @0xC0FFEE (SOAK_LANES=NEST, --smoke), perLane.NEST.totals, measured on the V1 exec.mjs.
// b117 B4 re-pin: the A5a/A5b engine (Signal.js 2f7974f3) moved O1c -100 / O1e -398 checks into skipTainted
// (+100 / +398); O2, O4, worlds and ops unchanged. Two identical live runs (.handoff/b117-evidence/b4/nest-run1.txt,
// nest-run2.txt). The old pin (O1c 804723 / 127174, O1e 990282 / 279682) is reproduced exactly on the 767f808
// kernel (SOAK_KERNEL=.handoff/b113-before/Signal.js, b117-evidence/b0/f-nest-smoke.txt + b4/nest-b113-before.txt).
const LIVE_PIN = Object.freeze({
    worlds: 144, ops: 61200,
    checks: Object.freeze({ O1c: 804623, O1e: 989884, O2: 220419, O4: 1149360 }),
    skipTainted: Object.freeze({ O1c: 127274, O1e: 280080, O2: 138, O4: 89124 }),
});

test('live NEST smoke @0xC0FFEE: the exact performed and skipTainted counts of every skipping oracle (b70 ruling)', () => {
    const res = liveRun();
    assert.deepEqual(Object.keys(LIVE_PIN.checks), SKIPPING.slice(), 'the pin covers exactly the skipping roster');
    const got = { worlds: res.t.worlds, ops: res.t.ops, checks: {}, skipTainted: {} };
    for (const o of SKIPPING) { got.checks[o] = res.t.checks[o]; got.skipTainted[o] = res.t.skipTainted[o]; }
    assert.deepEqual(got, LIVE_PIN, 'live NEST smoke counts moved (got ' + JSON.stringify(got) + ')');
});

// The Exec prototype is not exported: capture the instance once through Detectors (it holds its exec as `x`).
function execProto() {
    const orig = Detectors.prototype.beginStep;
    let x = null;
    Detectors.prototype.beginStep = function () { if (x === null) x = this.x; return orig.call(this); };
    try {
        runWorld(liteAdapter, { genVersion: 1, lane: 'GRAPH', seed: 1, large: false, covOff: null, flushPasses: null, ops: [] });
    } finally {
        Detectors.prototype.beginStep = orig;
    }
    assert.ok(x !== null, 'no Exec captured through Detectors.beginStep');
    const P = Object.getPrototypeOf(x);
    assert.equal(typeof P.disposeIdx, 'function', 'the captured prototype has no disposeIdx');
    return P;
}

test('V1 tainted() arm: an in-flight frame that read a live computed the kill taints (not the victim) is tainted', () => {
    const P = execProto();
    // 0 S (victim) <- 1 C1 (its last run read S) <- 7 C7 (read C1); 2 S2 <- 3 C3 (untouched); 4..8 effects in flight
    const M = new Model({ childEffects: 'parent-run' });
    M.addSignal(0, 1, {});
    M.addComputed(1, {});
    M.n[1].seen = [{ r: 0, v: 1 }]; M.n[1].links = [0];
    M.addSignal(2, 2, {});
    M.addComputed(3, {});
    M.n[3].seen = [{ r: 2, v: 2 }]; M.n[3].links = [2];
    for (const e of [4, 5, 6, 8]) M.addEffect(e, {});
    M.addComputed(7, {});
    M.n[7].seen = [{ r: 1, v: 1 }]; M.n[7].links = [1];
    const x = Object.create(P);
    x.M = M;
    x.H = [{}, {}, {}, {}, {}, {}, {}, {}, {}];
    const disposed = [];
    x.D = { onDispose(j) { disposed.push(j); } };
    x.W = { dispose(h) { disposed.push(h === x.H[0] ? 'W0' : 'W?'); } };
    const frame = (i, seen) => ({ i, t: 'e', prev: null, reads: seen.map((e) => e.r), seen, taintRun: false });
    const viaComputed = frame(4, [{ r: 1, v: 1 }]);     // read C1 only: tainted by the tainted() arm
    const untouched = frame(5, [{ r: 3, v: 2 }]);       // read C3 only: not tainted by this disposal
    const direct = frame(6, [{ r: 0, v: 1 }]);          // read the victim: the dead arm
    const transitive = frame(8, [{ r: 7, v: 1 }]);      // read C7, which read C1: tainted() is transitive
    x.frames = [viaComputed, untouched, direct, transitive];
    P.disposeIdx.call(x, 0);
    assert.deepEqual(disposed, [0, 'W0'], 'D.onDispose then W.dispose of the victim');
    assert.equal(M.n[0].live, false, 'the victim is killed');
    assert.equal(M.n[1].taint, true, 'kill() taints C1 (its last run read the victim)');
    assert.equal(M.n[7].taint, false, 'C7 holds no own flag (transitive only)');
    assert.equal(viaComputed.taintRun, true, 'the frame that read the kill-tainted live computed C1 is tainted');
    assert.equal(transitive.taintRun, true, 'the frame that read C7 (-> C1) is tainted');
    assert.equal(direct.taintRun, true, 'the frame that read the victim is tainted');
    assert.equal(untouched.taintRun, false, 'the frame that read neither is not tainted by this disposal');
    assert.deepEqual(direct.reads, [], 'the victim is spliced out of the in-flight reads');
});
