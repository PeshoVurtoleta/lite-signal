/**
 * test/46 -- SoakReport (S1cd TASK 9, SPEC-B v2 section 9 row R-tamper x10, B5 assertions + review round 1).
 *
 * Every stream is generated AT TEST TIME by the real bench/soak/main.mjs on FROZEN kernels through SOAK_KERNEL
 * (amendment 11: never the live Signal.js): node_modules/lite-signal-1.5.2 (REV-152),
 * bench/soak/controls/headpatched, and scratch copies of headpatched (no controls.json pin; one throws a
 * deferred fatal; kscratch is also the SOAK_NEARWRAP base, D-B9 a).
 * No fixture stream is committed: the gates block and the calibrated constants move (B6), and a
 * stream is only valid against the code that judged it.
 *
 * Teeth: every check statement of SoakReport.mjs (one `bad(...)` / `refuse(...)` each) has a tamper below
 * that goes red when that statement alone is disabled. Honest streams (fatal, signal-interrupted, smoke,
 * mustfail, scratch kernel) prove the opposite direction: an honest stream is never labelled INTEGRITY.
 *
 * Release policy (burst 12, maintainer decision c: the full roster, at default volume, on a clean committed tree):
 * a release-size tree stream (8 lanes, the roster, x DEFAULT_CYCLES x DEFAULT_OPS) is too slow to generate here, so the ACCEPTED
 * path is proven on the exported PURE releaseRefusal() with the REAL REV-152 header relabelled as a tree run and
 * edited field by field (RELEASE table); the CLI rows prove the small honest streams refuse with the first class.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPS_MIN, MIN_ACTIVE_CYCLES, CHECK_P, DEFAULT_OPS, DEFAULT_CYCLES, SCHEMA_VERSION, SHAPE_EVERY, LATENCY_METHODS } from '../bench/soak/config.mjs';
import { COV_OFF_SUPPORTED, laneByName, ROSTER } from '../bench/soak/lanes/index.mjs';
import { applicability } from '../bench/soak/adapters/contract.mjs';
import { GATE_NAMES } from '../bench/soak/gates.mjs';
import { ORACLES } from '../bench/soak/oracles.mjs';
import { GAPS, CHECKS } from '../bench/soak/teeth.mjs';
import { BreachLog } from '../bench/soak/main.mjs';   // b103: the relabelled-tree row re-derives its BREACH entries
import { releaseRefusal, rssStride } from '../bench/soak/SoakReport.mjs';   // import runs no CLI: isEntry() guard
import { RssSampler } from '../bench/soak/rss.mjs';
import { failureRecord } from '../bench/soak/main.mjs';   // kernel-free on import (main.mjs header): no Signal.js loads
import { classify } from '../bench/soak/divergences.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOAK = join(ROOT, 'bench', 'soak');
const MAIN = join(SOAK, 'main.mjs');
const REPORT = join(SOAK, 'SoakReport.mjs');
const K_HP_DIR = join(SOAK, 'controls', 'headpatched');
const K_HP = join(K_HP_DIR, 'Signal.js');
const K_152 = join(ROOT, 'node_modules', 'lite-signal-1.5.2', 'Signal.js');
const SMALL = { SOAK_CYCLES: String(MIN_ACTIVE_CYCLES), SOAK_OPS: String(OPS_MIN) };
// A cycle that cannot finish before the kernel-armed event lands: ~2,000 worlds, ~30 yields (main yields every 64 worlds).
const LONG = { SOAK_CYCLES: String(MIN_ACTIVE_CYCLES), SOAK_OPS: '1000000' };
/**
 * Scratch-kernel tail: wrap the module's createRegistry binding (a function declaration: a mutable live binding
 * the adapter reads through the namespace) and run `action` on the 2nd registry, i.e. inside world 1 of cycle 0,
 * after the stream is open. The event fires at the next yield (world 63), mid-cycle, whatever the host load.
 */
const ARMED = 'test/46 ARMED';   // the kernel writes it to stderr when the armed event fires
const armAt2 = (action) => '\n;const __t46Reg = createRegistry; let __t46N = 0;\n' +
    'createRegistry = function (config) { if (++__t46N === 2) { process.stderr.write("' + ARMED + '\\n"); ' + action + ' } return __t46Reg(config); };\n';
const ARMED_KILL_MS = 60000;   // an arm that never fires fails here, not at the 240 s default
const PINS = JSON.parse(readFileSync(join(SOAK, 'parity.json'), 'utf8')).files;
const REG_IDS = JSON.parse(readFileSync(join(SOAK, 'divergences.json'), 'utf8')).entries.map((e) => e.id);

let TMP;
const S = {};   // name -> { path, status, recs, stderr }
const LIVE = new Set();   // gen() children still running: after() SIGKILLs them before it removes TMP
let tn = 0;

function soakEnv(keys) {
    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    return Object.assign(env, keys);
}
/**
 * Spawn main.mjs (async: the streams generate in parallel). Every path SETTLES the promise: a child that exits
 * without a stream (CONFIG exit, a kernel that throws at load), an unparsable stream or a spawn error rejects
 * with the child's stderr, so before() fails fast instead of hanging. killMs bounds the child (SIGKILL).
 * The handle stays in LIVE until 'close': when one generator rejects, its siblings are still writing into TMP.
 */
function gen(name, keys, argv = [], killMs = 240000) {
    const out = join(TMP, name + '.jsonl');
    return new Promise((resolve, reject) => {
        let err = '', settled = false, timer = null;
        const settle = (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (e) reject(e); else resolve();
        };
        let p;
        try {
            p = spawn(process.execPath, ['--expose-gc', MAIN].concat(argv), { env: soakEnv(Object.assign({ SOAK_OUT: out }, keys)), stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (e) { settle(e); return; }
        LIVE.add(p);
        p.stderr.on('data', (d) => { err += d; });
        timer = setTimeout(() => p.kill('SIGKILL'), killMs);
        p.on('error', (e) => { LIVE.delete(p); settle(new Error(name + ': spawn failed: ' + e.message)); });
        p.on('close', (status, signal) => {
            LIVE.delete(p);
            try {
                const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
                S[name] = { path: out, status, signal, recs, stderr: err };
                settle(null);
            } catch (e) {
                settle(new Error(name + ': no usable stream (exit ' + status + (signal ? ', ' + signal : '') + ', ' + e.message + '): ' + err.slice(0, 400)));
            }
        });
    });
}
const readRecs = (name) => S[name].recs.map((r) => JSON.parse(JSON.stringify(r)));
function write(recs) {
    const p = join(TMP, 'tamper-' + (tn++) + '.jsonl');
    writeFileSync(p, recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + (recs.length ? '\n' : ''));
    return p;
}
function tamper(name, fn) { const recs = readRecs(name); const out = fn(recs); return write(out === undefined ? recs : out); }
function report(args) {
    const r = spawnSync(process.execPath, [REPORT].concat(args), { encoding: 'utf8', timeout: 60000, env: soakEnv({}) });
    return { status: r.status, out: r.stdout.trim().split('\n').filter(Boolean), err: r.stderr.trim().split('\n').filter(Boolean) };
}
const renumber = (recs) => { recs.forEach((r, i) => { r.seq = i; }); return recs; };
const cyclesOf = (recs) => recs.filter((r) => r.type === 'cycle');
const summaryOf = (recs) => recs[recs.length - 1];
const withFailures = (recs) => cyclesOf(recs).find((c) => c.failures.length > 0);
const clone = (x) => JSON.parse(JSON.stringify(x));
/** Insert record r before index i, keep tMs non-decreasing, renumber. */
function insertAt(recs, i, r) { r.tMs = recs[i - 1].tMs; recs.splice(i, 0, r); return renumber(recs); }
const fatalRec = (kind) => ({ kind, lane: null, cycle: null, world: null, worldSeed: null, message: 'forged', stack: null, type: 'fatal', seq: 0, tMs: 0 });

function expectIntegrity(path, cls) {
    const r = report([path]);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.err.length, 1, JSON.stringify(r));
    assert.ok(r.err[0].startsWith('soak:report: INTEGRITY -- ' + cls + ': '), 'want class ' + cls + ', got: ' + r.err[0]);
    assert.ok(!r.out.some((l) => / \(consistent\)$/.test(l)), 'a tampered stream never prints a consistent verdict');
    return r;
}
function expectRefusal(path, reason) {
    const r = report([path]);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.equal(r.err.length, 1, JSON.stringify(r));
    assert.ok(r.err[0].startsWith('soak:report: NOT A RELEASE SOAK -- ' + reason + ': '), 'want reason ' + reason + ', got: ' + r.err[0]);
    assert.match(r.out[r.out.length - 1], /^soak:report: verdict \S+ \(consistent\)$/, 'a refusal follows a consistent verdict');
    return r;
}
function expectConsistent(name) {
    const r = report([S[name].path]);
    assert.equal(r.status, 0, JSON.stringify(r));
    assert.deepEqual(r.err, []);
    assert.equal(r.out[r.out.length - 1], 'soak:report: verdict ' + summaryOf(S[name].recs).verdict + ' (consistent)');
    return r;
}

before(async () => {
    TMP = mkdtempSync(join(tmpdir(), 'soak-report-'));
    const hpSrc = readFileSync(K_HP, 'utf8');
    for (const [dir, tail] of [['kscratch', '\n// test/46 scratch kernel: not a controls.json pin\n'],
        ['kfatal', armAt2('setImmediate(() => { throw new Error("test/46 deferred fatal"); });')],
        ['ksigint', armAt2('process.kill(process.pid, "SIGINT");')]]) {
        mkdirSync(join(TMP, dir));
        writeFileSync(join(TMP, dir, 'Signal.js'), hpSrc + tail);
        copyFileSync(join(K_HP_DIR, 'Watch.js'), join(TMP, dir, 'Watch.js'));
    }
    await Promise.all([
        gen('rev', Object.assign({ SOAK_KERNEL: K_152 }, SMALL)),
        gen('hp', Object.assign({ SOAK_KERNEL: K_HP, SOAK_LANES: 'GRAPH' }, SMALL)),
        gen('hperr', Object.assign({ SOAK_KERNEL: K_HP, SOAK_LANES: 'ERROR' }, SMALL)),
        gen('scratch', Object.assign({ SOAK_KERNEL: join(TMP, 'kscratch', 'Signal.js'), SOAK_LANES: 'GRAPH' }, SMALL)),
        // D-B9 (a): kernel.mjs derives kscratch into the content-addressed bench/soak/out/nearwrap/<d7>-<w7>/ pair
        gen('nwscratch', Object.assign({ SOAK_KERNEL: join(TMP, 'kscratch', 'Signal.js'), SOAK_NEARWRAP: 'zero:8',
            SOAK_LANES: 'GRAPH' }, SMALL)),
        gen('mustfail', Object.assign({ SOAK_KERNEL: K_HP, SOAK_LANES: 'GRAPH', SOAK_MUSTFAIL: 'cov-off:' + COV_OFF_SUPPORTED.GRAPH[0] }, SMALL)),
        gen('smoke', { SOAK_KERNEL: K_HP, SOAK_LANES: 'GRAPH' }, ['--smoke']),
        // B-B4b: the TREE kernel instruments (rev152 / headpatched anchors drift -> anatomy null), so the anatomy rows tamper this one
        gen('treesmoke', { SOAK_LANES: 'GRAPH' }, ['--smoke']),
        // B-B5 CLI rows: a small honest TREE run (no override): consistent, refused as NOT A RELEASE SOAK (exit 1)
        gen('treesmall', Object.assign({ SOAK_LANES: 'GRAPH' }, SMALL)),
        gen('fatal', Object.assign({ SOAK_KERNEL: join(TMP, 'kfatal', 'Signal.js'), SOAK_LANES: 'GRAPH' }, LONG), [], ARMED_KILL_MS),
        gen('sigint', Object.assign({ SOAK_KERNEL: join(TMP, 'ksigint', 'Signal.js'), SOAK_LANES: 'GRAPH' }, LONG), [], ARMED_KILL_MS),
    ]);
}, { timeout: 300000 });   // node:test has no default timeout: a stuck generator fails, never hangs
after(async () => {
    // a failed before() leaves sibling generators running: kill them and wait for 'close' (bounded) before rmSync
    const live = Array.from(LIVE);
    for (const p of live) p.kill('SIGKILL');
    await Promise.all(live.map((p) => new Promise((res) => { const t = setTimeout(res, 5000); p.once('close', () => { clearTimeout(t); res(); }); })));
    if (TMP) rmSync(TMP, { recursive: true, force: true });
});

/* ---- honest streams: consistent, never INTEGRITY ----------------------------------------------------- */

test('B5: the untampered REV-152 stream (1.5.2, 8 lanes, 11 cycles) -> exit 0, the control NOTE, `soak:report: verdict FAIL (consistent)` last', () => {
    const s = S.rev;
    assert.equal(s.status, 1, 'main judged 1.5.2 FAIL: ' + s.stderr.slice(0, 400));
    assert.equal(s.recs[0].controls.name, 'rev152');
    const r = expectConsistent('rev');
    assert.equal(r.out[r.out.length - 1], 'soak:report: verdict FAIL (consistent)');
    assert.match(r.out[0], /^soak:report: stream records=\d+ kernel=control:rev152 engine=lite lanes=GRAPH,BATCH,ERROR,NEST,WIE,HOOK,LIFECYCLE,OWNER cycles=\d+ /);
    assert.equal(r.out[r.out.length - 2], 'soak:report: NOTE -- control kernel rev152, not release evidence');
    assert.equal(r.out.filter((l) => l.indexOf('soak:report: NOTE -- control kernel ') === 0).length, 1, JSON.stringify(r.out));
});
test('B5: a clean headpatched GRAPH stream -> exit 0, its own verdict re-derived (consistent)', () => {
    // clean = no oracle failure. The verdict is NOT pinned: heap / retention can go red on a loaded host.
    assert.equal(summaryOf(S.hp.recs).totals.failingWorlds, 0, 'headpatched GRAPH has no failing world');
    expectConsistent('hp');
});
test('honest headpatched ERROR stream (DIV-F21/F22 failures, no capped cycle) -> exit 0, consistent', () => {
    assert.ok(summaryOf(S.hperr.recs).totals.failingWorlds > 0, 'the interim kernel still fails ERROR');
    expectConsistent('hperr');
});
/* ---- fixed-entry wiring (DIV-F21 fixedIn A2-F21): unit rows, no kernel run (N18.1) ---------------------------------
 * main.mjs failureRecord and SoakReport checkCycles classify with includeFixed = (controls.name !== null): on a
 * kernel that is no controls.json pin an F21 world is a regression (known null); on a named control kernel it reads
 * DIV-F21; and the report re-derives the same tag. The F21 shape is the DIV-F21 entry of divergences.json: engine
 * lite, lane ERROR, op seq, step+world scen cycle-error-surfaces, an EARLIER such step (count >= 2), O6
 * escape-CycleError with the 'Infinite effect loop detected.' detail. Red on: main includeFixed forced true,
 * SoakReport forced true / forced false / inverted, DIV-F21 fixedIn null. */
const F21_DETAIL = 'engine error escaped: Error: CycleError: Infinite effect loop detected.';
const F21_SCEN = 'cycle-error-surfaces';
function f21Input() {
    return {
        r: { failure: { step: 5, op: 'seq', scen: [F21_SCEN], fails: [{ oracle: 'O6', sig: 'escape-CycleError', detail: F21_DETAIL }] }, scen: { [F21_SCEN]: 2 } },
        ctx: { engine: 'lite', lane: 'ERROR', cycle: 0, world: 3, worldSeed: 1, escape: null },
    };
}
/** hperr (a controls.json kernel) with its last failing world rewritten to the F21 shape; known/tag/failKnown as given. */
function f21Stream(known, tag, nonControl) {
    return tamper('hperr', (recs) => {
        const cyc = cyclesOf(recs).filter((c) => c.failures.length > 0).pop();   // the LAST failing world: the first-world BREACH entries stay as they are
        const f = cyc.failures[cyc.failures.length - 1];
        const w = f.worldScenCounts;
        const fc = [cyc.failureCounts, summaryOf(recs).perLane.ERROR.failureCounts];   // the cycle's and the lane's tally
        const bump = (k, d) => { for (const o of fc) { o[k] = (o[k] || 0) + d; if (o[k] === 0) delete o[k]; } };
        bump(f.oracles[0] + ':' + f.sig, -1);   // failureCounts is per (oracle:sig) of each failing world's FIRST fail
        bump('O6:escape-CycleError', 1);
        Object.assign(f, {
            oracles: ['O6'], sigs: ['escape-CycleError'], sig: 'escape-CycleError', op: 'seq', detail: F21_DETAIL, scen: [F21_SCEN],
            fails: [{ oracle: 'O6', sig: 'escape-CycleError', detail: F21_DETAIL }], escape: null,
            known, tag, failKnown: [known],
        });
        w[F21_SCEN] = 2;
        summaryOf(recs).breaches.push({ oracle: 'O6', lane: 'ERROR', sig: 'escape-CycleError', known, replay: f.replay, scen: [F21_SCEN], detail: F21_DETAIL });
        if (f.worldScen.indexOf(F21_SCEN) === -1) f.worldScen.push(F21_SCEN);
        if (nonControl) {   // a scratch kernel: sha no controls.json pin, so controls.name null (override stays true)
            const h = recs[0];
            h.controls.name = null;
            h.kernel.files[0].sha256 = '0'.repeat(64);
            h.engine.files = h.kernel.files.map((x) => ({ path: x.path, sha256: x.sha256 }));
        }
    });
}
test('fixed-entry wiring (unit): failureRecord with no control kernel loaded -> the F21 world reads known null (a regression), not DIV-F21', () => {
    const { r, ctx } = f21Input();
    const rec = failureRecord(r, ctx);
    assert.equal(rec.known, null);
    assert.equal(rec.tag, null);
    assert.deepEqual(rec.failKnown, [null]);
});
test('fixed-entry wiring (unit): the same F21 record classifies DIV-F21 only with includeFixed true (registry fixedIn A2-F21)', () => {
    const { r, ctx } = f21Input();
    const rec = failureRecord(r, ctx);
    const crec = { engine: 'lite', lane: 'ERROR', step: 5, op: 'seq', fails: rec.fails, scen: [F21_SCEN], worldScen: [F21_SCEN], worldScenCounts: { [F21_SCEN]: 2 } };
    const on = classify(crec, { includeFixed: true });
    assert.ok(on !== null, 'the synthetic record is F21-shaped');
    assert.equal(on.known, 'DIV-F21');
    assert.equal(on.tag, 'F21');
    assert.equal(classify(crec, { includeFixed: false }), null);
    assert.equal(JSON.parse(readFileSync(join(SOAK, 'divergences.json'), 'utf8')).entries.find((e) => e.id === 'DIV-F21').fixedIn, 'A2-F21');
});
test('fixed-entry wiring (report): control kernel + F21 record tagged DIV-F21 -> consistent; tagged null -> known-tag INTEGRITY (includeFixed true)', () => {
    assert.ok(withFailures(S.hperr.recs), 'hperr has failing worlds');
    const ok = report([f21Stream('DIV-F21', 'F21', false)]);
    assert.equal(ok.status, 0, JSON.stringify(ok));
    assert.match(ok.out[ok.out.length - 1], /^soak:report: verdict \S+ \(consistent\)$/);
    const r = expectIntegrity(f21Stream(null, null, false), 'known-tag');
    assert.match(r.err[0], /known null re-derives as "DIV-F21"/);
});
test('fixed-entry wiring (report): NON-control kernel + F21 record tagged null -> consistent; tagged DIV-F21 -> known-tag INTEGRITY (includeFixed false)', () => {
    const ok = report([f21Stream(null, null, true)]);
    assert.equal(ok.err.filter((l) => l.indexOf('INTEGRITY') !== -1).length, 0, JSON.stringify(ok));
    assert.match(ok.out[ok.out.length - 1], /^soak:report: verdict \S+ \(consistent\)$/);
    const r = expectIntegrity(f21Stream('DIV-F21', 'F21', true), 'known-tag');
    assert.match(r.err[0], /known "DIV-F21" re-derives as null/);
});
/* ---- fixed-entry wiring, DIV-B33 (fixedIn F-b33-1; unit 0s B2, PLAN-0s-wie A3(iii)): unit rows, no kernel run ------
 * Two real preb33 WIE heads (burst 68 smoke 3 x 20000, .handoff/b68-evidence/b2b/preb33-wie-smoke.jsonl): world 0 step 22
 * O1e alone, and step 26 O2 + O1e; plus the preb33 O4 effect-dead world of the 11 x 100000 run (replay WIE:4:0x88c7b46b,
 * step 52; preb33-wie-full.err; DIV-B33 widened to O4 by maintainer ruling b68). On the tree kernel (no controls.json pin: includeFixed false) a WIE lost update is a
 * regression (known null -> a known=none BREACH, FAIL); on a named control kernel it reads DIV-B33. Red when DIV-B33 is
 * dropped from divergences.json, its fixedIn is cleared, or a shape loses its wie-stale-* world clause. */
const B33_ROWS = [
    { step: 22, op: 'eff', scen: ['wie-stale-effect'], counts: { 'wie-stale-effect': 1 },
        fails: [{ oracle: 'O1e', sig: 'effect-stale', detail: 'effect#22 saw [#21=0,#20=352] model [#21=352,#20=352]' }] },
    { step: 26, op: 'eff', scen: ['wie-stale-computed'], counts: { 'wie-write-before-read': 1, 'wie-stale-computed': 1 },
        fails: [{ oracle: 'O2', sig: 'glitch', detail: 'body#26 read #25 engine=213 model=426' }, { oracle: 'O1e', sig: 'effect-stale', detail: 'effect#26 saw [#25=213] model [#25=426]' }] },
    { step: 52, op: 'set', scen: ['wie-stale-computed', 'dep-set-flip', 'equality-cutoff', 'wie-prewalk', 'diamond-write'],
        counts: { 'equality-cutoff': 3, 'wie-prewalk': 7, 'dep-set-flip': 4, 'adversarial-equality': 1, 'second-invalidation': 2, 'wie-stale-computed': 1, 'diamond-write': 1 },
        fails: [{ oracle: 'O4', sig: 'effect-dead', detail: 'effect#28 saw [#27=1] model [#27=2] (ran 0 times this op)' }] },
];
test('fixed-entry wiring (unit): a WIE lost-update world on the tree kernel reads known null (FAIL), DIV-B33 only with includeFixed true', () => {
    const entry = JSON.parse(readFileSync(join(SOAK, 'divergences.json'), 'utf8')).entries.find((e) => e.id === 'DIV-B33');
    assert.ok(entry !== undefined, 'DIV-B33 is in divergences.json');
    assert.equal(entry.fixedIn, 'F-b33-1');
    assert.deepEqual(entry.lanes, ['WIE']);
    for (const b of B33_ROWS) {
        const r = { failure: { step: b.step, op: b.op, scen: b.scen, fails: b.fails }, scen: b.counts };
        const rec = failureRecord(r, { engine: 'lite', lane: 'WIE', cycle: 0, world: 0, worldSeed: 1, escape: null });
        assert.equal(rec.known, null, 'tree kernel: a regression, not DIV-B33 (step ' + b.step + ')');
        assert.equal(rec.tag, null);
        const crec = { engine: 'lite', lane: 'WIE', step: b.step, op: b.op, fails: rec.fails, scen: b.scen, worldScen: Object.keys(b.counts), worldScenCounts: b.counts };
        const on = classify(crec, { includeFixed: true });
        assert.ok(on !== null, 'the preb33 head is DIV-B33-shaped (step ' + b.step + ')');
        assert.equal(on.known, 'DIV-B33');
        assert.equal(on.tag, 'B33');
        assert.equal(classify(crec, { includeFixed: false }), null);
        // fail closed: the same fails in a world that counted no wie-stale-* write, or on another lane, stay unknown
        assert.equal(classify(Object.assign({}, crec, { worldScen: ['wie-write-before-read'], worldScenCounts: { 'wie-write-before-read': 1 } }), { includeFixed: true }), null);
        assert.equal(classify(Object.assign({}, crec, { lane: 'GRAPH' }), { includeFixed: true }), null);
    }
});
test('honest FATAL stream (scratch kernel, uncaught throw armed mid-cycle) -> consistent, then NOT A RELEASE SOAK -- overridden-kernel', () => {
    const recs = S.fatal.recs;
    assert.ok(S.fatal.stderr.indexOf(ARMED) !== -1, 'the armed throw fired: ' + S.fatal.stderr.slice(0, 400));
    assert.equal(S.fatal.status, 1, S.fatal.stderr.slice(0, 400));
    assert.equal(summaryOf(recs).reason, 'fatal');
    assert.equal(recs[recs.length - 2].type, 'fatal');
    assert.equal(recs[recs.length - 2].kind, 'uncaughtException');
    assert.equal(recs[recs.length - 2].lane, 'GRAPH', 'the throw landed inside a lane-cycle');
    assert.equal(recs[recs.length - 2].cycle, 0);
    const r = expectRefusal(S.fatal.path, 'overridden-kernel');
    assert.equal(r.out[r.out.length - 1], 'soak:report: verdict FAIL (consistent)');
});
test('honest SIGINT-interrupted stream (scratch kernel raises SIGINT in world 1 of cycle 0) -> consistent; the interrupted last cycle is accepted', () => {
    const recs = S.sigint.recs;
    assert.ok(S.sigint.stderr.indexOf(ARMED) !== -1, 'the armed SIGINT fired: ' + S.sigint.stderr.slice(0, 400));
    assert.equal(summaryOf(recs).reason, 'signal', S.sigint.stderr.slice(0, 400));
    const c = cyclesOf(recs);
    assert.equal(c.length, 1, 'the signal stops cycle 0 itself');
    assert.equal(c[0].interrupted, true, 'the SIGINT landed mid-cycle (interrupted=true reached)');
    const r = expectRefusal(S.sigint.path, 'overridden-kernel');
    assert.equal(r.out[r.out.length - 1], 'soak:report: verdict ' + summaryOf(recs).verdict + ' (consistent)');
});
test('honest scratch-kernel stream -> consistent, then NOT A RELEASE SOAK -- overridden-kernel (R-tamper 9)', () => {
    assert.equal(S.scratch.recs[0].kernel.override, true);
    assert.equal(S.scratch.recs[0].controls.name, null, 'the scratch kernel matches no control');
    const r = expectRefusal(S.scratch.path, 'overridden-kernel');
    assert.equal(r.out[r.out.length - 1], 'soak:report: verdict ' + summaryOf(S.scratch.recs).verdict + ' (consistent)');
});
const fileSha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
test('honest NEARWRAP scratch stream (SOAK_KERNEL + SOAK_NEARWRAP zero:8, D-B9 a) -> consistent, then NOT A RELEASE ' +
    'SOAK -- nearwrap (before overridden-kernel)', () => {
    const h = S.nwscratch.recs[0], f = h.kernel.files;
    assert.equal(h.kernel.override, true);
    assert.equal(h.controls.name, null, 'the derived kernel matches no control');
    const dir = f[0].path.replace(/\\/g, '/').split('/').slice(-2, -1)[0];
    assert.match(dir, /^[0-9a-f]{7}-[0-9a-f]{7}$/);
    assert.equal(dir, f[0].sha256.slice(0, 7) + '-' + f[1].sha256.slice(0, 7));
    assert.equal(h.nearwrap.derivedSha256, f[0].sha256, 'the loaded kernel IS the derived one');
    assert.equal(h.nearwrap.baseSha256, fileSha(join(TMP, 'kscratch', 'Signal.js')));
    assert.notEqual(h.nearwrap.baseSha256, h.nearwrap.derivedSha256);
    assert.equal(f[1].sha256, fileSha(join(TMP, 'kscratch', 'Watch.js')), 'the derived Watch.js is a byte copy');
    const r = expectRefusal(S.nwscratch.path, 'nearwrap');
    assert.match(r.err[0], /^soak:report: NOT A RELEASE SOAK -- nearwrap: zero:8 -- /);
    const v = summaryOf(S.nwscratch.recs).verdict;
    assert.equal(r.out[r.out.length - 1], 'soak:report: verdict ' + v + ' (consistent)');
});
test('honest SOAK_MUSTFAIL cov-off stream (SPEC-B 5.1) -> NOT A RELEASE SOAK -- mustfail', () => {
    assert.notEqual(S.mustfail.recs[0].mustfail, null);
    expectRefusal(S.mustfail.path, 'mustfail');
});
test('honest smoke stream -> `verdict <V> (consistent)` (SMOKE on a quiet host), then NOT A RELEASE SOAK -- smoke', () => {
    assert.equal(S.smoke.recs[0].config.SOAK_SMOKE.value, true);
    const r = expectRefusal(S.smoke.path, 'smoke');
    assert.equal(r.out[r.out.length - 1], 'soak:report: verdict ' + summaryOf(S.smoke.recs).verdict + ' (consistent)');
});

/* ---- the tree kernel: identity vs parity.json pins (review blocker 1) -------------------------------- */

/** The scratch stream relabelled as a tree run: override false, SOAK_KERNEL null, kernel sha set by sha(). */
function asTree(recs, sig, wat, parityOk) {
    const h = recs[0];
    h.kernel.override = false;
    h.config.SOAK_KERNEL = { value: null, source: 'default' };
    if (sig !== undefined) h.kernel.files[0].sha256 = sig;
    if (wat !== undefined) h.kernel.files[1].sha256 = wat;
    h.engine.files = h.kernel.files.map((f) => ({ path: f.path, sha256: f.sha256 }));
    if (parityOk !== undefined) h.parity.ok = parityOk;
}
test('a small GRAPH-only tree run at the parity.json pins, parity ok -> consistent, then NOT A RELEASE SOAK -- lane-subset (the first class), kernel=tree', () => {
    const r = expectRefusal(tamper('scratch', (recs) => asTree(recs, PINS['Signal.js'], PINS['Watch.js'], true)), 'lane-subset');
    assert.match(r.out[0], / kernel=tree /);
    assert.match(r.err[0], /ran GRAPH of the roster \["GRAPH","BATCH","ERROR","NEST","WIE","HOOK","LIFECYCLE","OWNER"\]/);
    assert.ok(!r.out.some((l) => l.indexOf('NOTE -- control kernel') !== -1), 'a tree run prints no control NOTE');
});
test('the full-roster REV-152 stream relabelled as a tree run at the pins (11 x OPS_MIN) -> NOT A RELEASE SOAK -- volume', () => {
    // a tree run classifies with includeFixed false: every 1.5.2 world a FIXED entry explains re-tags as known null there --
    // its WIE worlds (DIV-B33) and, since b103 (DIV-F6 fixed in A2-FIX-T), its F6 ERROR worlds (DIV-F6, DIV-F6+DIV-F22)
    // and, since b109 (DIV-F5 fixed in A3-FIX-R), its F5 BATCH/ERROR worlds
    // and, since b112 (DIV-F7 fixed in 0v-#40, DIV-F8 in A1.4), its F7 NEST / LIFECYCLE worlds
    // and, since b117 (DIV-F9 fixed in A5b, DIV-D3-independent-registrations in A5a), its F9 HOOK and D3 LIFECYCLE worlds
    // and, since b126 (DIV-48 fixed in b120-#48), its OWNER multi-cleanup callback-this worlds
    const FIXED_RE = /(^|\+)DIV-(B33|F5|F6|F7|F8|F9|48|D3-independent-registrations)(\+|$)/;
    const retag = (recs) => {
        for (const c of cyclesOf(recs)) for (const f of c.failures) if (FIXED_RE.test(String(f.known))) Object.assign(f, { known: null, tag: null, failKnown: f.fails.map(() => null) });
        // b103: a retagged F6+F22 world also moves its DIV-F22 line to known=null (the whole world is unknown on the tree),
        // so the oracle BREACH entries are re-derived from the retagged failures with main.mjs's BreachLog, as SoakReport
        // rebuilds them; gate entries and still-open-id entries no stored failure rebuilds (capped lanes) are kept
        const s = summaryOf(recs);
        const log = new BreachLog(() => {});
        for (const c of cyclesOf(recs)) for (const f of c.failures) log.noteWorld(f, c.lane, 'lite');
        const rebuilt = log.entries.map((e) => JSON.parse(JSON.stringify(e)));
        const key = (b) => BreachLog.key(b.oracle, b.lane, b.sig, b.known);
        const have = new Set(rebuilt.map(key));
        const isGate = (b) => Object.prototype.hasOwnProperty.call(b, 'gate');
        s.breaches = s.breaches.filter(isGate).concat(rebuilt,
            s.breaches.filter((b) => !isGate(b) && !FIXED_RE.test(String(b.known)) && !have.has(key(b))));
    };
    const r = expectRefusal(tamper('rev', (recs) => { recs[0].controls.name = null; asTree(recs, PINS['Signal.js'], PINS['Watch.js'], true); retag(recs); }), 'volume');
    assert.match(r.out[0], / kernel=tree engine=lite lanes=GRAPH,BATCH,ERROR,NEST,WIE,HOOK,LIFECYCLE,OWNER /);
    assert.match(r.err[0], new RegExp('SOAK_OPS ' + OPS_MIN + ' is not a count >= config DEFAULT_OPS ' + DEFAULT_OPS));
});

/* ---- release policy: the PURE releaseRefusal() on the real REV-152 header, field by field ------------- */

/** The REV-152 stream as a release-size clean tree run: relabelled tree at the pins, SOAK_OPS DEFAULT_OPS, clean git. */
function releaseBase() {
    const recs = readRecs('rev');
    recs[0].controls.name = null;
    asTree(recs, PINS['Signal.js'], PINS['Watch.js'], true);
    const h = recs[0];
    h.config.SOAK_OPS = { value: DEFAULT_OPS, source: 'default' };
    h.gitSha = '0123456789abcdef0123456789abcdef01234567';
    h.gitDirty = false;
    h.gitError = null;
    return { h, cycles: cyclesOf(recs) };
}
const lanesTo = (h, n) => { h.lanes = h.lanes.slice(0, n); h.config.SOAK_LANES = { value: ROSTER.slice(0, n), source: 'env' }; };
const dropLastCycle = (cycles) => cycles.slice(0, (DEFAULT_CYCLES - 1) * ROSTER.length);
/** A valid header.nearwrap (SPEC-S2 groupA ruling R1b): the exact NEARWRAP shape, sign:8. */
const NW = () => ({ phase: 'sign', k: 8, rewrites: [], baseSha256: 'a'.repeat(64), derivedSha256: 'b'.repeat(64) });
const RELEASE = [
    ['full roster, DEFAULT_OPS, DEFAULT_CYCLES completed, clean git', () => {}, null],
    ['header.nearwrap null (the base, stated)', (h) => { h.nearwrap = null; }, null],
    // R1c: a NEARWRAP kernel is its own release reason, even at the pins on an otherwise release-shaped stream
    ['a valid header.nearwrap sign:8 on the release-shaped stream at the pins', (h) => { h.nearwrap = NW(); }, 'nearwrap', /^sign:8 -- a NEARWRAP kernel/],
    ['precedence: nearwrap AND a Signal.js off the pin: nearwrap first', (h) => { h.nearwrap = NW(); h.kernel.files[0].sha256 = '1'.repeat(64); }, 'nearwrap', /^sign:8 /],
    ['SOAK_OPS above DEFAULT_OPS', (h) => { h.config.SOAK_OPS.value = DEFAULT_OPS * 2; }, null],
    ['a forever run (SOAK_CYCLES=0) that completed DEFAULT_CYCLES', (h) => { h.config.SOAK_CYCLES = { value: 0, source: 'env' }; }, null],
    ['a pinned control kernel (rev152), small and dirty: the tree policy does not apply', (h) => { h.controls.name = 'rev152'; h.config.SOAK_OPS.value = OPS_MIN; h.gitDirty = true; lanesTo(h, 1); }, null],
    ['SOAK_LANES GRAPH,BATCH,ERROR', (h) => lanesTo(h, 3), 'lane-subset', /^ran GRAPH,BATCH,ERROR of the roster/],
    ['a roster lane with status skip', (h) => { h.lanes[3].status = 'skip'; }, 'lane-subset', /^ran GRAPH,BATCH,ERROR,WIE,HOOK,LIFECYCLE,OWNER of the roster/],
    ['a laneRoster that is not lanes/index.mjs ROSTER (all of it ran)', (h) => { lanesTo(h, 3); h.laneRoster = ROSTER.slice(0, 3); }, 'lane-subset', /is not lanes\/index\.mjs ROSTER/],
    ['SOAK_OPS DEFAULT_OPS - 1', (h) => { h.config.SOAK_OPS.value = DEFAULT_OPS - 1; }, 'volume', new RegExp('^SOAK_OPS ' + (DEFAULT_OPS - 1) + ' is not a count >= config DEFAULT_OPS')],
    ['SOAK_OPS null (fail closed)', (h) => { h.config.SOAK_OPS.value = null; }, 'volume', /^SOAK_OPS null is not a count/],
    ['SOAK_OPS undefined (fail closed)', (h) => { h.config.SOAK_OPS.value = undefined; }, 'volume', /^SOAK_OPS undefined is not a count/],
    ['SOAK_OPS NaN (fail closed)', (h) => { h.config.SOAK_OPS.value = NaN; }, 'volume', /^SOAK_OPS null is not a count/],
    ['SOAK_OPS the string "200000" (never coerced)', (h) => { h.config.SOAK_OPS.value = String(DEFAULT_OPS * 2); }, 'volume', /^SOAK_OPS "200000" is not a count/],
    ['DEFAULT_CYCLES - 1 cycles', (h, c) => dropLastCycle(c), 'volume', new RegExp('^' + (DEFAULT_CYCLES - 1) + ' completed cycle\\(s\\) per lane < config DEFAULT_CYCLES ' + DEFAULT_CYCLES)],
    ['the last cycle interrupted (signal): it does not count', (h, c) => { c[c.length - 1].interrupted = true; }, 'volume', new RegExp('^' + (DEFAULT_CYCLES - 1) + ' completed')],
    ['a forever run (SOAK_CYCLES=0) stopped after DEFAULT_CYCLES - 1', (h, c) => { h.config.SOAK_CYCLES = { value: 0, source: 'env' }; return dropLastCycle(c); }, 'volume', /SOAK_CYCLES=0;/],
    ['gitSha null', (h) => { h.gitSha = null; }, 'provenance', /^gitSha null /],
    ['gitSha not a commit sha', (h) => { h.gitSha = 'HEAD'; }, 'provenance', /^gitSha "HEAD" /],
    ['gitSha abbreviated (7 hex)', (h) => { h.gitSha = 'abc1234'; }, 'provenance', /^gitSha "abc1234" /],
    ['gitSha 39 hex', (h) => { h.gitSha = 'a'.repeat(39); }, 'provenance', /^gitSha "a{39}" /],
    ['gitSha 41 hex', (h) => { h.gitSha = 'a'.repeat(41); }, 'provenance', /^gitSha "a{41}" /],
    ['gitSha upper-case 40 hex', (h) => { h.gitSha = 'A'.repeat(40); }, 'provenance', /^gitSha "A{40}" /],
    ['gitSha 64 hex (a sha256 repository)', (h) => { h.gitSha = 'b'.repeat(64); }, null],
    ['gitDirty true', (h) => { h.gitDirty = true; }, 'provenance', /^gitDirty true:/],
    ['gitDirty null (the probe failed: unknown, never clean)', (h) => { h.gitDirty = null; }, 'provenance', /^gitDirty null:/],
    ['gitError non-null', (h) => { h.gitError = 'fatal: x'; }, 'provenance', /^gitError "fatal: x"/],
    // precedence: tree-parity, lane-subset, volume, provenance
    ['precedence: a Signal.js off the pin AND a lane subset: tree-parity first', (h) => { h.kernel.files[0].sha256 = '1'.repeat(64); lanesTo(h, 1); }, 'tree-parity', /Signal\.js sha256 differs/],
    ['precedence: a lane subset AND OPS_MIN AND dirty: lane-subset first', (h) => { lanesTo(h, 2); h.config.SOAK_OPS.value = OPS_MIN; h.gitDirty = true; }, 'lane-subset', /^ran GRAPH,BATCH of/],
    ['precedence: OPS_MIN AND gitSha null: volume first', (h) => { h.config.SOAK_OPS.value = OPS_MIN; h.gitSha = null; }, 'volume', /^SOAK_OPS 1000 is not a count/],
];
for (const [name, edit, reason, detail] of RELEASE) {
    test('releaseRefusal: ' + name + ' -> ' + (reason === null ? 'null (release evidence)' : reason), () => {
        const b = releaseBase();
        const cycles = edit(b.h, b.cycles) || b.cycles;
        const got = releaseRefusal(b.h, cycles, PINS);
        if (reason === null) { assert.equal(got, null, JSON.stringify(got)); return; }
        assert.ok(got !== null, 'want ' + reason + ', got null');
        assert.equal(got.reason, reason, JSON.stringify(got));
        assert.match(got.detail, detail);
    });
}
test('releaseRefusal: the base really is the REV-152 header (8 lanes x DEFAULT_CYCLES completed, the roster by import)', () => {
    const b = releaseBase();
    assert.deepEqual(b.h.laneRoster, ROSTER.slice());
    assert.deepEqual(b.h.lanes.map((L) => L.status), ROSTER.map(() => 'run'));
    assert.equal(b.cycles.length, DEFAULT_CYCLES * ROSTER.length);
    assert.ok(b.cycles.every((c) => c.interrupted === false));
});

/* ---- one tamper per check statement ------------------------------------------------------------------ */

const I = (cls, detail) => ({ cls, detail });   // detail: when another statement of the same class would also fire
const flipLast = (hex) => hex.slice(0, -1) + (hex.slice(-1) === '0' ? '1' : '0');
const mirrorEngine = (h) => { h.engine.files = h.kernel.files.map((f) => ({ path: f.path, sha256: f.sha256 })); };
const R = (reason, detail) => ({ reason, detail });
// review r1 NITs 1-2: a nearwrap base dir under TMP holding Signal.js (made by mk) + kscratch's Watch.js; built once
const nwBases = {};
function nwBase(dir, mk) {
    const p = join(TMP, dir, 'Signal.js');
    if (nwBases[dir] === undefined) {
        mkdirSync(join(TMP, dir)); mk(p); copyFileSync(join(TMP, 'kscratch', 'Watch.js'), join(TMP, dir, 'Watch.js'));
        nwBases[dir] = p;
    }
    return p;
}
const fifoBase = () => nwBase('kfifo', (p) => { assert.equal(spawnSync('mkfifo', [p]).status, 0, 'mkfifo'); });
const nonUtf8Base = () => nwBase('knonutf8', (p) => writeFileSync(p, Buffer.concat([
    readFileSync(join(TMP, 'kscratch', 'Signal.js')), Buffer.from('// non-UTF-8 byte: '), Buffer.from([0xff]),
    Buffer.from('\n')])));
const fifoWatchBase = () => {
    const d = join(TMP, 'kfifow'), p = join(d, 'Signal.js');
    if (nwBases.kfifow === undefined) {
        mkdirSync(d); copyFileSync(join(TMP, 'kscratch', 'Signal.js'), p);
        assert.equal(spawnSync('mkfifo', [join(d, 'Watch.js')]).status, 0, 'mkfifo'); nwBases.kfifow = p;
    }
    return p;
};
const textSha = (p) => createHash('sha256').update(readFileSync(p, 'utf8'), 'utf8').digest('hex');
const TAMPERS = [
    // parse
    ['empty stream', 'rev', () => [], I('parse', /empty stream/)],
    ['a trailing garbage line', 'rev', (r) => { r.push('not json'); }, I('parse', /is not a JSON object record/)],
    // seq / record type / keys
    ['a missing seq field', 'rev', (r) => { delete r[4].seq; }, I('seq-invalid', /is not a non-negative integer/)],
    ['a duplicate seq', 'rev', (r) => { r[3].seq = 2; }, I('seq-duplicate', /repeats/)],
    ['R-tamper 3: seq gap', 'rev', (r) => { for (let i = 5; i < r.length; i++) r[i].seq += 1; }, I('seq-gap', /seq \d+, expected \d+/)],
    ['an unknown record type', 'rev', (r) => { r[2].type = 'checkpoint'; }, I('record-type', /is not a burn-in record/)],
    ['a missing tMs', 'rev', (r) => { delete r[2].tMs; }, I('record-type', /is not a time/)],
    ['tMs running backwards', 'rev', (r) => { r[3].tMs = 0; }, I('record-type', /runs backwards/)],
    ['an extra summary key', 'rev', (r) => { summaryOf(r).forged = 1; }, I('unknown-key', /summary carries an unknown key "forged"/)],
    ['an extra header key', 'rev', (r) => { r[0].forged = 1; }, I('unknown-key', /seq 0 header carries an unknown key "forged"/)],
    ['an extra failure-record key', 'rev', (r) => { withFailures(r).failures[0].forged = 1; }, I('unknown-key', /failure world \d+ carries an unknown key "forged"/)],
    ['an extra BREACH-entry key', 'rev', (r) => { summaryOf(r).breaches[0].forged = 1; }, I('unknown-key', /summary breach carries an unknown key "forged"/)],
    // header placement, summary, fatal
    ['record 0 is not the header', 'rev', (r) => { const h = r.shift(); h.tMs = r[0].tMs; r.splice(1, 0, h); return renumber(r); }, I('header', /record 0 is cycle, not the header/)],
    ['a second header', 'rev', (r) => insertAt(r, 1, clone(r[0])), I('header', /a second header at seq/)],
    ['R-tamper 8: drop the summary', 'rev', (r) => r.slice(0, -1), I('summary-missing', /no summary record/)],
    ['a second summary', 'rev', (r) => { const s = clone(summaryOf(r)); s.seq = r.length; r.push(s); }, I('summary-duplicate', /2 summary records/)],
    ['R-tamper 4: fatal after the summary', 'rev', (r) => { const f = fatalRec('uncaughtException'); f.seq = r.length; f.tMs = summaryOf(r).tMs; r.push(f); }, I('fatal-after-summary', /after the summary at seq/)],
    ['a record after the summary', 'rev', (r) => { const c = clone(cyclesOf(r)[0]); c.seq = r.length; c.tMs = summaryOf(r).tMs; r.push(c); }, I('after-summary', /record\(s\) after the summary/)],
    ['two fatal records', 'rev', (r) => { summaryOf(r).reason = 'fatal'; insertAt(r, r.length - 1, fatalRec('uncaughtException')); return insertAt(r, r.length - 1, fatalRec('uncaughtException')); }, I('fatal-placement', /2 fatal records/)],
    ['an unknown fatal kind', 'rev', (r) => { summaryOf(r).reason = 'fatal'; return insertAt(r, r.length - 1, fatalRec('bogus')); }, I('fatal-placement', /unknown fatal kind bogus/)],
    ['a fatal record not directly before the summary', 'rev', (r) => { summaryOf(r).reason = 'fatal'; return insertAt(r, r.length - 2, fatalRec('uncaughtException')); }, I('fatal-placement', /not directly before the summary/)],
    ['a fatal record with summary reason end', 'rev', (r) => insertAt(r, r.length - 1, fatalRec('uncaughtException')), I('fatal-placement', /a fatal record but summary reason end/)],
    ['summary reason fatal with no fatal record', 'rev', (r) => { summaryOf(r).reason = 'fatal'; }, I('fatal-placement', /without a fatal record/)],
    // header fields
    ['a header without mustfail', 'rev', (r) => { delete r[0].mustfail; }, I('header', /header\.mustfail is missing/)],
    ['a header of another stream kind', 'rev', (r) => { r[0].kind = 'wrap'; }, I('header', /kind wrap is not burn-in/)],
    ['an old-schema stream (schemaVersion 1)', 'rev', (r) => { r[0].schemaVersion = SCHEMA_VERSION - 1; }, I('header', /schemaVersion 1 != 2/)],
    // R1b: header.nearwrap is null or exactly the NEARWRAP shape; R1c: a valid one is refused as nearwrap
    ['header.nearwrap deleted', 'rev', (r) => { delete r[0].nearwrap; }, I('header', /header\.nearwrap must be null or exactly/)],
    ['header.nearwrap phase up', 'rev', (r) => { r[0].nearwrap = Object.assign(NW(), { phase: 'up' }); }, I('header', /header\.nearwrap must be null or exactly/)],
    ['header.nearwrap k 0', 'rev', (r) => { r[0].nearwrap = Object.assign(NW(), { k: 0 }); }, I('header', /header\.nearwrap must be null or exactly/)],
    ['header.nearwrap k 65 (> NEARWRAP_K_MAX)', 'rev', (r) => { r[0].nearwrap = Object.assign(NW(), { k: 65 }); }, I('header', /header\.nearwrap must be null or exactly/)],
    ['header.nearwrap without derivedSha256', 'rev', (r) => { const n = NW(); delete n.derivedSha256; r[0].nearwrap = n; }, I('header', /header\.nearwrap must be null or exactly/)],
    ['header.nearwrap with an extra key', 'rev', (r) => { r[0].nearwrap = Object.assign(NW(), { extra: 1 }); }, I('header', /header\.nearwrap must be null or exactly/)],
    // D-B9 (a): a valid-shaped nearwrap is only consistent on its own derived kernel (N1 first)
    ['a valid-shaped header.nearwrap sign:8 with fake shas on REV-152 (config SOAK_NEARWRAP sign:8)', 'rev', (r) => {
        r[0].nearwrap = NW(); r[0].config.SOAK_NEARWRAP = { value: { phase: 'sign', k: 8 }, source: 'env' };
    }, I('control', /nearwrap derivedSha256 b{64} is not the kernel Signal\.js sha256 /)],
    // review R1 blocker 1: header.nearwrap must agree with config SOAK_NEARWRAP (the SOAK_MUSTFAIL cross-check twin)
    ['config SOAK_NEARWRAP sign:8 but header.nearwrap null', 'rev', (r) => { r[0].config.SOAK_NEARWRAP = { value: { phase: 'sign', k: 8 }, source: 'env' }; }, I('header', /header\.nearwrap differs from config SOAK_NEARWRAP/)],
    ['config SOAK_NEARWRAP value garbage', 'rev', (r) => { r[0].config.SOAK_NEARWRAP = { value: 'garbage', source: 'env' }; }, I('header', /config SOAK_NEARWRAP value "garbage" is neither null nor \{phase, k\}/)],
    ['config SOAK_NEARWRAP null but a valid header.nearwrap', 'rev', (r) => { r[0].nearwrap = NW(); }, I('header', /header\.nearwrap differs from config SOAK_NEARWRAP/)],
    ['config SOAK_NEARWRAP sign:8 but header.nearwrap k 9', 'rev', (r) => { r[0].nearwrap = Object.assign(NW(), { k: 9 }); r[0].config.SOAK_NEARWRAP = { value: { phase: 'sign', k: 8 }, source: 'env' }; }, I('header', /header\.nearwrap differs from config SOAK_NEARWRAP/)],
    // release-reason order nearwrap before overridden-kernel: the honest nwscratch row. Honest shas on a path
    // that is not the derived <d7>-<w7>/ pair (the scratch kernel itself) -> N2
    ['a nearwrap header with honest shas on the scratch (non-derived) kernel path', 'scratch', (r) => {
        r[0].nearwrap = Object.assign(NW(), { derivedSha256: r[0].kernel.files[0].sha256 });
        r[0].config.SOAK_NEARWRAP = { value: { phase: 'sign', k: 8 }, source: 'env' };
    }, I('control',
        /nearwrap kernel files .* are not the derived pair [0-9a-f]{7}-[0-9a-f]{7}\/\{Signal,Watch\}\.js$/)],
    ['genVersion 2', 'rev', (r) => { r[0].genVersion = 2; }, I('header', /genVersion 2/)],
    ['genRules edited', 'rev', (r) => { r[0].genRules.pop(); }, I('header', /!= gen\.mjs GEN_RULES/)],
    ['config is not an object', 'rev', (r) => { r[0].config = []; }, I('header', /header\.config is not an object/)],
    ['config.SOAK_SEED deleted', 'rev', (r) => { delete r[0].config.SOAK_SEED; }, I('header', /config\.SOAK_SEED is missing/)],
    ['SOAK_SMOKE value not boolean', 'rev', (r) => { r[0].config.SOAK_SMOKE.value = 'yes'; }, I('header', /SOAK_SMOKE value yes is not a boolean/)],
    ['SOAK_CYCLES value not a count', 'rev', (r) => { r[0].config.SOAK_CYCLES.value = -1; }, I('header', /SOAK_CYCLES value -1 is not a count/)],
    ['SOAK_OPS value not a count', 'rev', (r) => { r[0].config.SOAK_OPS.value = 'x'; }, I('header', /SOAK_OPS value x is not a count/)],
    ['SOAK_SEED value not a uint32', 'rev', (r) => { r[0].config.SOAK_SEED.value = 2 ** 32; }, I('header', /SOAK_SEED value 4294967296 is not a uint32/)],
    ['SOAK_LANES value not an array', 'rev', (r) => { r[0].config.SOAK_LANES.value = 'GRAPH'; }, I('header', /SOAK_LANES value is not an array/)],
    ['SOAK_KERNEL value not a path', 'rev', (r) => { r[0].config.SOAK_KERNEL.value = 5; }, I('header', /SOAK_KERNEL value is neither/)],
    ['SOAK_ENGINE unknown', 'rev', (r) => { r[0].config.SOAK_ENGINE.value = 'alein'; r[0].engine.name = 'alein'; }, I('header', /is no known engine/)],
    ['engine.name differs from SOAK_ENGINE', 'rev', (r) => { r[0].engine.name = 'alien'; }, I('header', /engine\.name differs/)],
    ['engine.caps null', 'rev', (r) => { r[0].engine.caps = null; }, I('header', /engine\.caps is not an object/)],
    ['header.mustfail differs from config', 'rev', (r) => { r[0].mustfail = { mode: 'cov-off', scenario: 'x' }; }, I('header', /header\.mustfail differs/)],
    ['kernel.files with one entry', 'rev', (r) => { r[0].kernel.files.pop(); }, I('header', /header\.kernel must be/)],
    ['a kernel sha256 that is not hex', 'rev', (r) => { r[0].kernel.files[1].sha256 = 'x'; }, I('header', /kernel file entry malformed/)],
    ['controls without name', 'rev', (r) => { delete r[0].controls.name; }, I('header', /controls has no name/)],
    ['parity without ok', 'rev', (r) => { delete r[0].parity.ok; }, I('header', /parity has no ok/)],
    // header vs this code
    ['R-tamper 5: edit gates.CHECK_P', 'rev', (r) => { r[0].gates.CHECK_P = CHECK_P + 0.1; }, I('gates-block', /at CHECK_P \(tampered, or recorded under different code\)/)],
    ['a divergences digest of another registry', 'rev', (r) => { r[0].divergences = '0'.repeat(64); }, I('registry', /divergences digest differs/)],
    ['kernel.override true but SOAK_KERNEL null', 'scratch', (r) => { r[0].config.SOAK_KERNEL = { value: null, source: 'default' }; }, I('control', /override is true but config SOAK_KERNEL is null/)],
    ['kernel.override flipped false on a SOAK_KERNEL run (review repro)', 'scratch', (r) => { r[0].kernel.override = false; }, I('control', /override is false but config SOAK_KERNEL is /)],
    ['an override path that is not the SOAK_KERNEL value', 'scratch', (r) => { r[0].config.SOAK_KERNEL.value = '/elsewhere/Signal.js'; }, I('control', /is not the SOAK_KERNEL value/)],
    ['a kernel Watch.js renamed', 'rev', (r) => { r[0].kernel.files[1].path += '.bak'; }, I('control', /must be Signal\.js \+ Watch\.js/)],
    ['a forged control name (headpatched claims rev152)', 'hp', (r) => { r[0].controls.name = 'rev152'; }, I('control', /controls\.name rev152 does not match/)],
    ['rev152 relabelled as a tree run (review repro)', 'rev', (r) => { r[0].controls.name = null; asTree(r); }, I('control', /is control rev152 but controls\.name is null/)],
    ['engine.files differ from kernel.files', 'rev', (r) => { r[0].engine.files[0].sha256 = '0'.repeat(64); }, I('control', /engine\.files differ/)],
    // D-B9 (a) N1-N5: the honest nwscratch stream, one field forged per row (engine.files mirrored where moved)
    ['M1: nearwrap baseSha256 forged', 'nwscratch', (r) => { r[0].nearwrap.baseSha256 = 'a'.repeat(64); },
        I('control',
            /nearwrap baseSha256 a{64} is not the sha256 of the SOAK_KERNEL file .* on this host \([0-9a-f]{64}\)$/)],
    ['M2: nearwrap derivedSha256 last hex flipped', 'nwscratch', (r) => {
        r[0].nearwrap.derivedSha256 = flipLast(r[0].nearwrap.derivedSha256);
    }, I('control', /nearwrap derivedSha256 [0-9a-f]{64} is not the kernel Signal\.js sha256 [0-9a-f]{64}$/)],
    ['M3: nearwrap AND config SOAK_NEARWRAP null on the derived path (the plain override rule)', 'nwscratch', (r) => {
        r[0].nearwrap = null; r[0].config.SOAK_NEARWRAP = { value: null, source: 'default' };
    }, I('control',
        /kernel path .*\/soak\/out\/nearwrap\/[0-9a-f]{7}-[0-9a-f]{7}\/Signal\.js is not the SOAK_KERNEL value /)],
    ['M4: a SOAK_KERNEL base that does not resolve on this host', 'nwscratch', (r) => {
        r[0].config.SOAK_KERNEL.value = '/nonexistent-db9a/Signal.js';
    }, I('control',
        /nearwrap base SOAK_KERNEL \/nonexistent-db9a\/Signal\.js .* does not resolve on this host: .*closed\)$/)],
    // review r1 NIT 1: a base that is not a regular file is unresolvable, refused before any read (a FIFO hung it)
    ['M7: a SOAK_KERNEL base that is a FIFO, not a regular file', 'nwscratch', (r) => {
        r[0].config.SOAK_KERNEL.value = fifoBase();
    }, I('control', /nearwrap base SOAK_KERNEL \S+\/kfifo\/Signal\.js .* does not resolve on this host: .*closed\)$/)],
    ['M9: a SOAK_KERNEL base whose sibling Watch.js is a FIFO, not a regular file', 'nwscratch', (r) => {
        r[0].config.SOAK_KERNEL.value = fifoWatchBase();
    }, I('control', /nearwrap base SOAK_KERNEL \S+\/kfifow\/Signal\.js .* does not resolve on this host: .*closed\)$/)],
    // review r1 NIT 2: baseSha256 is the utf8-decoded text sha (as nearwrap.mjs records it), not the raw bytes
    ['M8: an honest base with a non-UTF-8 byte (baseSha256 = its utf8-decoded text sha)', 'nwscratch', (r) => {
        const p = nonUtf8Base();
        r[0].config.SOAK_KERNEL.value = p; r[0].nearwrap.baseSha256 = textSha(p);
    }, R('nearwrap', /^soak:report: NOT A RELEASE SOAK -- nearwrap: zero:8 -- /)],
    ['M5: kernel Watch.js sha256 last hex flipped (engine.files mirrored)', 'nwscratch', (r) => {
        r[0].kernel.files[1].sha256 = flipLast(r[0].kernel.files[1].sha256); mirrorEngine(r[0]);
    }, I('control', /kernel Watch\.js sha256 [0-9a-f]{64} is not the sha256 of the SOAK_KERNEL sibling Watch\.js /)],
    ['M6: kernel Watch.js moved out of the derived pair dir (engine.files mirrored)', 'nwscratch', (r) => {
        const w = r[0].kernel.files[1];
        w.path = w.path.replace(/Watch\.js$/, 'moved/Watch.js'); mirrorEngine(r[0]);
    }, I('control', /nearwrap kernel files .*\/moved\/Watch\.js are not the derived pair /)],
    ['laneRoster edited', 'rev', (r) => { r[0].laneRoster.push('X'); }, I('header-lanes', /laneRoster /)],
    ['SOAK_LANES out of roster order', 'rev', (r) => { r[0].config.SOAK_LANES.value.reverse(); }, I('header-lanes', /not a roster-ordered subset/)],
    ['header.lanes short of SOAK_LANES', 'rev', (r) => { r[0].lanes.pop(); }, I('header-lanes', /does not list exactly/)],
    ['header.lanes entry edited', 'rev', (r) => { r[0].lanes[0].missingCaps = ['x']; }, I('header-lanes', /header\.lanes\[0\] differs/)],
    ['a header that drops a required scenario', 'rev', (r) => { r[0].scenarios.ERROR.required.pop(); }, I('header-lanes', /header\.scenarios\.ERROR differs/)],
    ['header.oraclesNA edited', 'rev', (r) => { r[0].oraclesNA.GRAPH = ['O5']; }, I('header-lanes', /oraclesNA\.GRAPH differs/)],
    // cycle grid
    ['a 12th cycle record', 'hp', (r) => { const c = clone(cyclesOf(r).pop()); c.cycle += 1; return insertAt(r, r.length - 1, c); }, I('cycle-grid', /cycle records > \d+ cycles x 1 running lanes/)],
    ['R-tamper 1: delete a cycle (seq renumbered)', 'rev', (r) => { r.splice(r.indexOf(cyclesOf(r)[5]), 1); return renumber(r); }, I('cycle-grid', /a cycle record is missing or out of order/)],
    ['laneIndex edited', 'rev', (r) => { cyclesOf(r)[1].laneIndex = 0; }, I('cycle-grid', /laneIndex 0 != 1/)],
    ['warmup flag edited', 'rev', (r) => { cyclesOf(r)[0].warmup = false; }, I('cycle-grid', /warmup false does not match/)],
    ['interrupted not a boolean', 'rev', (r) => { cyclesOf(r)[0].interrupted = 0; }, I('cycle-grid', /interrupted is not a boolean/)],
    ['interrupted on a reason-end run', 'rev', (r) => { cyclesOf(r)[0].interrupted = true; }, I('cycle-grid', /interrupted outside a signal-stopped/)],
    ['R-tamper 1b: delete the LAST cycle of a reason-end run', 'rev', (r) => { const c = cyclesOf(r); r.splice(r.indexOf(c[c.length - 1]), 1); return renumber(r); }, I('cycle-grid', /reason end with \d+ cycle records, expected/)],
    ['summary.cyclesRun edited', 'rev', (r) => { summaryOf(r).cyclesRun += 1; }, I('cycle-grid', /summary\.cyclesRun/)],
    // cycle fields
    ['ops negative', 'rev', (r) => { cyclesOf(r)[2].ops = -1; }, I('cycle-field', /: ops = -1/)],
    ['largeWorlds > worlds', 'rev', (r) => { const c = cyclesOf(r)[0]; c.largeWorlds = c.worlds + 1; }, I('cycle-field', /largeWorlds exceed/)],
    ['failingWorlds > worlds', 'rev', (r) => { const c = cyclesOf(r)[0]; c.failingWorlds = c.worlds + 1; }, I('cycle-field', /failingWorlds exceed/)],
    ['a cycle seed edited', 'rev', (r) => { cyclesOf(r)[1].seed ^= 1; }, I('cycle-field', /is not seedFor/)],
    ['ops below SOAK_OPS on a not-interrupted cycle', 'hp', (r) => { cyclesOf(r)[3].ops = r[0].config.SOAK_OPS.value - 1; }, I('cycle-field', /vs SOAK_OPS \d+ with interrupted=false/)],
    ['a deleted counter (checks.O6 of one cycle)', 'rev', (r) => { delete cyclesOf(r)[2].checks.O6; }, I('cycle-field', /checks keys must be exactly/)],
    ['checks.O6 negative', 'rev', (r) => { cyclesOf(r)[2].checks.O6 = -1; }, I('cycle-field', /checks\.O6 = -1/)],
    ['opsByClass deleted', 'rev', (r) => { delete cyclesOf(r)[2].opsByClass; }, I('cycle-field', /opsByClass missing/)],
    ['gateHits value negative', 'rev', (r) => { cyclesOf(r)[2].gateHits.batchTokenEscaped = -1; }, I('cycle-field', /gateHits\.batchTokenEscaped = -1/)],
    ['opsByClass not summing to ops', 'rev', (r) => { const o = cyclesOf(r)[2].opsByClass; o[Object.keys(o)[0]] += 1; }, I('cycle-field', /opsByClass does not sum/)],
    ['memory.residentMB not a number', 'rev', (r) => { cyclesOf(r)[2].memory.residentMB = 'x'; }, I('cycle-field', /memory\.residentMB missing/)],
    ['boundary null', 'rev', (r) => { cyclesOf(r)[2].boundary = null; }, I('cycle-field', /boundary missing/)],
    ['boundary of another lane', 'rev', (r) => { cyclesOf(r)[2].boundary.lane = 'NEST'; }, I('cycle-field', /boundary belongs to NEST/)],
    ['boundary.worlds edited', 'rev', (r) => { cyclesOf(r)[2].boundary.worlds += 1; }, I('cycle-field', /boundary\.worlds/)],
    ['boundary.tracked negative', 'rev', (r) => { cyclesOf(r)[2].boundary.tracked = -1; }, I('cycle-field', /tracked\/witnessed not counts/)],
    ['boundary.trackerSize deleted', 'rev', (r) => { delete cyclesOf(r)[2].boundary.trackerSize; }, I('cycle-field', /trackerSize\/weakAlive missing/)],
    // scenario counts
    ['R-tamper 7: delete a cycle\'s scenario counts', 'rev', (r) => { delete cyclesOf(r).find((c) => c.lane === 'BATCH').scenarios; }, I('scenario-counts', /scenarios missing/)],
    ['a negative scenario count', 'rev', (r) => { const s = cyclesOf(r)[1].scenarios; s[Object.keys(s)[0]] = -1; }, I('scenario-counts', /scenarios\.\S+ = -1/)],
    ['R-tamper 7b: delete one scenario key that a stored failure world counted', 'rev', (r) => {
        const c = cyclesOf(r).find((x) => x.failures.some((f) => f.worldScen.length > 0));
        delete c.scenarios[c.failures.find((f) => f.worldScen.length > 0).worldScen[0]];
    }, I('scenario-counts', /> the cycle count/)],
    // failure counts
    ['failureCounts null', 'rev', (r) => { withFailures(r).failureCounts = null; }, I('failure-count', /failureCounts missing/)],
    ['R-tamper 2: zero a failure count', 'rev', (r) => { const c = withFailures(r); c.failureCounts[Object.keys(c.failureCounts)[0]] = 0; }, I('failure-count', /= 0 \(a counted key is >= 1\)/)],
    ['a failure count above failingWorlds', 'rev', (r) => { const c = withFailures(r); c.failureCounts[Object.keys(c.failureCounts)[0]] = c.failingWorlds + 1; }, I('failure-count', /\(counted once per world\)/)],
    ['failure counts summing below failingWorlds', 'rev', (r) => { const c = cyclesOf(r).find((x) => x.failingWorlds > 1); c.failureCounts = { [Object.keys(c.failureCounts)[0]]: 1 }; }, I('failure-count', /failureCounts sum \d+ < failingWorlds/)],
    ['a count below the stored failure records (uncapped cycle)', 'rev', (r) => { const [c, k] = uncappedKey(r); c.failureCounts[k] -= 1; }, I('failure-count', /but the stored failure records hold/)],
    ['a count above stored + uncapped worlds (uncapped cycle)', 'rev', (r) => { const [c, k] = uncappedKey(r); c.failureCounts[k] += 1; }, I('failure-count', /stored \+ \d+ uncapped worlds/)],
    // failure records
    ['failures not an array', 'rev', (r) => { withFailures(r).failures = {}; }, I('failure-records', /failures is not an array/)],
    ['a deleted failure record', 'rev', (r) => { withFailures(r).failures.pop(); }, I('failure-records', /expected min\(failingWorlds, FAIL_CAP\)/)],
    ['a failure step negative', 'rev', (r) => { withFailures(r).failures[0].step = -1; }, I('failure-records', /a failure record is malformed/)],
    ['failure records out of world order', 'rev', (r) => { const f = withFailures(r).failures; const t = f[0]; f[0] = f[1]; f[1] = t; }, I('failure-records', /out of order or out of range/)],
    ['failure.oracles edited', 'rev', (r) => { withFailures(r).failures[0].oracles = ['O2']; }, I('failure-records', /: oracles does not re-derive/)],
    ['failure.sigs edited', 'rev', (r) => { withFailures(r).failures[0].sigs = ['x']; }, I('failure-records', /: sigs does not re-derive/)],
    ['failure.sig edited', 'rev', (r) => { withFailures(r).failures[0].sig = 'x'; }, I('failure-records', /: sig does not re-derive/)],
    ['failure.detail edited', 'rev', (r) => { withFailures(r).failures[0].detail = 'x'; }, I('failure-records', /: detail does not re-derive/)],
    ['failure.worldSeed edited', 'rev', (r) => { withFailures(r).failures[0].worldSeed ^= 1; }, I('failure-records', /: worldSeed does not re-derive/)],
    ['failure.replay edited', 'rev', (r) => { withFailures(r).failures[0].replay = 'BATCH:0:0x1'; }, I('failure-records', /: replay does not re-derive/)],
    ['failure.worldScen edited', 'rev', (r) => { withFailures(r).failures[0].worldScen.pop(); }, I('failure-records', /: worldScen does not re-derive/)],
    ['an escape on a non-batch op', 'rev', (r) => { failureWhere(r, (f) => f.op !== 'batch').escape = []; }, I('failure-records', /escape on a non-batch op/)],
    ['an escape that is not an array', 'rev', (r) => { failureWhere(r, (f) => f.op === 'batch').escape = 'x'; }, I('failure-records', /must be null or an array/)],
    // known tags
    ['a failure classify refuses (scen not strings)', 'rev', (r) => { withFailures(r).failures[0].scen = [5]; }, I('known-tag', /classify refused the record/)],
    ['R-tamper 11: an edited `known` tag', 'rev', (r) => { const f = withFailures(r).failures[0]; f.known = f.known === 'DIV-F21' ? 'DIV-F5' : 'DIV-F21'; }, I('known-tag', /: known "/)],
    ['an edited `tag`', 'rev', (r) => { withFailures(r).failures[0].tag = 'F99'; }, I('known-tag', /: tag "F99"/)],
    ['an edited `failKnown`', 'rev', (r) => { withFailures(r).failures[0].failKnown[0] = 'DIV-F99'; }, I('known-tag', /: failKnown \[/)],
    // summary
    ['an edited summary total', 'rev', (r) => { summaryOf(r).totals.checks.O1c += 1; }, I('totals', /summary\.totals do not equal/)],
    // malformed (B7): every field check passes, but two GRAPH cycles of checks.O1c = 2^53 - 1 make gates.mjs Totals.add throw
    ['checks.O1c at 2^53 - 1 in two cycles of one lane (Totals leaves the exact range)', 'rev', (r) => { for (const c of cyclesOf(r).filter((x) => x.lane === 'GRAPH').slice(0, 2)) c.checks.O1c = Number.MAX_SAFE_INTEGER; }, I('malformed', /exact range \(2\^53\)/)],
    ['an unknown summary reason', 'rev', (r) => { summaryOf(r).reason = 'bogus'; }, I('verdict', /summary\.reason bogus/)],
    ['R-tamper 6: claimed PASS over a FAIL stream', 'rev', (r) => { const s = summaryOf(r); s.verdict = 'PASS'; s.exitCode = 0; }, I('verdict', /claims "PASS", its records re-derive "FAIL"/)],
    ['only exitCode edited 1 -> 0 (review repro)', 'rev', (r) => { summaryOf(r).exitCode = 0; }, I('verdict', /claims exit 0, its records re-derive 1/)],
    ['summary.smoke edited', 'rev', (r) => { summaryOf(r).smoke = true; }, I('verdict', /summary\.smoke differs/)],
    ['summary.lanesRun edited', 'rev', (r) => { summaryOf(r).lanesRun += 1; }, I('verdict', /summary\.lanesRun/)],
    ['summary.skipped edited', 'rev', (r) => { summaryOf(r).skipped.push({ lane: 'GRAPH' }); }, I('verdict', /summary\.skipped differs/)],
    ['summary.perLane null', 'rev', (r) => { summaryOf(r).perLane = null; }, I('per-lane', /summary\.perLane missing/)],
    ['a FAIL lane relabelled PASS (run verdict kept)', 'rev', (r) => { summaryOf(r).perLane.BATCH.status = 'PASS'; }, I('per-lane', /perLane\.BATCH does not re-derive/)],
    ['a forged INCONCLUSIVE line', 'rev', (r) => { summaryOf(r).inconclusive.push('soak: INCONCLUSIVE -- forged'); }, I('inconclusive', /inconclusive lines do not re-derive/)],
    // breaches (review blocker 2)
    ['summary.breaches not an array', 'rev', (r) => { summaryOf(r).breaches = {}; }, I('breaches', /summary\.breaches missing/)],
    ['a forged gate breach', 'rev', (r) => { summaryOf(r).breaches.push({ gate: 'heap', lane: 'GRAPH', detail: 'x' }); }, I('breaches', /gate breaches do not re-derive/)],
    ['a duplicated BREACH entry (review repro)', 'rev', (r) => { const b = summaryOf(r).breaches; b.push(clone(b[0])); }, I('breaches', /duplicate BREACH entry/)],
    ['a forged BREACH entry known DIV-F99 (review repro)', 'rev', (r) => { const b = summaryOf(r).breaches; b.push(Object.assign(clone(b[0]), { known: 'DIV-F99' })); }, I('breaches', /carries a known tag no registry entry can emit/)],
    ['a forged BREACH entry whose known id does not cover its lane (DIV-F21 on BATCH)', 'rev', (r) => { const b = summaryOf(r).breaches; const e = b.find((x) => x.lane === 'BATCH' && !Object.prototype.hasOwnProperty.call(x, 'gate')); b.push(Object.assign(clone(e), { known: 'DIV-F21' })); }, I('breaches', /a known id does not cover this lane/)],
    ['two oracle BREACH entries swapped (emission order)', 'rev', (r) => { const b = summaryOf(r).breaches; const t = b[0]; b[0] = b[1]; b[1] = t; }, I('breaches', /not in BreachLog emission order/)],
    ['a forged BREACH entry with no failure count', 'rev', (r) => { const b = summaryOf(r).breaches; b.push(Object.assign(clone(b[0]), { sig: 'nope', known: null })); }, I('breaches', /has no failure count/)],
    ['a deleted oracle BREACH entry', 'rev', (r) => { summaryOf(r).breaches.shift(); }, I('breaches', /has no BREACH entry/)],
    ['an edited BREACH replay (review repro)', 'rev', (r) => { summaryOf(r).breaches[0].replay = 'BATCH:0:0x1'; }, I('breaches', /does not re-derive \(replay\/scen\/detail/)],
    ['a forged BREACH entry on a lane with no capped cycle', 'hperr', (r) => {
        const s = summaryOf(r), lane = uncappedLane(r);
        const e = s.breaches.find((b) => b.lane === lane && !Object.prototype.hasOwnProperty.call(b, 'gate'));
        s.breaches.push(Object.assign(clone(e), { known: e.known === null ? REG_IDS[0] : null }));
    }, I('breaches', /matches no stored failure/)],
    // keys
    ['a deleted cycle.throughput', 'rev', (r) => { delete cyclesOf(r)[0].throughput; }, I('missing-key', /lacks "throughput"/)],
    // rss cycle key (B-B3a): pins the SoakReport key tables (RECORD_KEYS / SUB_KEYS) for the new key
    ['an extra key inside cycle.rss', 'rev', (r) => { cyclesOf(r)[0].rss.forged = 1; }, I('unknown-key', /carries an unknown key "forged"/)],
    ['a deleted cycle.rss', 'rev', (r) => { delete cyclesOf(r)[0].rss; }, I('missing-key', /lacks "rss"/)],
    // B-B5: SoakReport's every-cycle rss check fires (cycle-field) before LaneGates; the row's intent (a non-number p95MB is refused) is kept
    ['rss.p95MB not a number on cycle 2', 'rev', (r) => { cyclesOf(r).find((c) => c.cycle === 2).rss.p95MB = 'x'; }, I('cycle-field', /rss\.p95MB/)],
    // B-B5 (PLAN-0s-bb5 ASSERTION 1): every cycle is field-checked, warm-up included; one tamper per new bad() statement
    ['rss.p95MB not a number on the WARM-UP cycle 0', 'rev', (r) => { cyclesOf(r)[0].rss.p95MB = 'x'; }, I('cycle-field', /rss\.p95MB/)],
    ['rss.samples + 1', 'rev', (r) => { cyclesOf(r)[3].rss.samples += 1; }, I('cycle-field', /rss\.samples \/ rss\.stride/)],
    ['rss.stride 3 (not a power of 2)', 'rev', (r) => { cyclesOf(r)[3].rss.stride = 3; }, I('cycle-field', /rss\.samples \/ rss\.stride/)],
    ['rss.p95MB > rss.maxMB', 'rev', (r) => { const e = cyclesOf(r)[3].rss; e.p95MB = e.maxMB + 1; }, I('cycle-field', /p95MB <= maxMB/)],
    ['rss.samples 0 with p95MB 5 (no sample -> both null)', 'rev', (r) => { const e = cyclesOf(r)[0].rss; e.samples = 0; e.p95MB = 5; }, I('cycle-field', /rss\.samples 0 with/)],
    // anatomy.worlds upper bound floor((worlds - 1) / SHAPE_EVERY) + 1: one world over it
    ['anatomy.worlds = bound + 1', 'treesmoke', (r) => { const c = cyclesOf(r)[0]; c.anatomy.worlds = Math.floor((c.worlds - 1) / SHAPE_EVERY) + 2; }, I('cycle-field', /worlds/)],
    // tree twin of M3: a TREE run (no override, nearwrap null) whose kernel.files[0] parent dir is <sha7>-<sha7> of its own two shas
    ['M3 tree twin: a tree run whose kernel sits in a <sha7>-<sha7> pair dir', 'treesmoke', (r) => {
        const h = r[0], k = h.kernel.files;
        assert.equal(h.nearwrap, null); assert.equal(h.kernel.override, false); assert.equal(h.config.SOAK_NEARWRAP.value, null);
        const dir = join(SOAK, 'out', 'nearwrap', k[0].sha256.slice(0, 7) + '-' + k[1].sha256.slice(0, 7));
        k[0].path = join(dir, 'Signal.js'); k[1].path = join(dir, 'Watch.js'); mirrorEngine(h);
    }, I('control', /derived nearwrap pair dir/)],
    // b90 C3: the same twin with an UPPER-case <SHA7>-<SHA7> dir (sha256 values stay lower-case): inPairDir lower-cases
    // the dir, so a case-insensitive filesystem's spelling of the pair dir is still refused
    ['M3 tree twin: an UPPER-case <SHA7>-<SHA7> pair dir (sha256 values lower-case)', 'treesmoke', (r) => {
        const h = r[0], k = h.kernel.files;
        assert.equal(h.nearwrap, null); assert.equal(h.kernel.override, false); assert.equal(h.config.SOAK_NEARWRAP.value, null);
        const up = (k[0].sha256.slice(0, 7) + '-' + k[1].sha256.slice(0, 7)).toUpperCase();
        assert.match(up, /[A-F]/, 'the pair name must hold a hex letter, or upper-casing changes nothing');
        assert.match(k[0].sha256 + k[1].sha256, /^[0-9a-f]{128}$/);
        const dir = join(SOAK, 'out', 'nearwrap', up);
        k[0].path = join(dir, 'Signal.js'); k[1].path = join(dir, 'Watch.js'); mirrorEngine(h);
    }, I('control', /derived nearwrap pair dir/)],
    // latency cycle key (B-B4a, PLAN-0s-bb4a ASSERTION 4): key tables + the four cycle-field statements
    ['an extra key inside cycle.latency', 'rev', (r) => { cyclesOf(r)[0].latency.forged = 1; }, I('unknown-key', /carries an unknown key "forged"/)],
    ['an extra key inside cycle.latency.read', 'rev', (r) => { cyclesOf(r)[0].latency.read.forged = 1; }, I('unknown-key', /carries an unknown key "forged"/)],
    ['a deleted cycle.latency', 'rev', (r) => { delete cyclesOf(r)[0].latency; }, I('missing-key', /lacks "latency"/)],
    ['a deleted cycle.latency.read', 'rev', (r) => { delete cyclesOf(r)[0].latency.read; }, I('missing-key', /cycle\.latency lacks "read"/)],
    ['latency.read.belowFloor = n + 1', 'rev', (r) => { const e = cyclesOf(r)[0].latency.read; e.belowFloor = e.n + 1; }, I('cycle-field', /latency\.read\.belowFloor \d+ > n \d+/)],
    ['latency.read.p50Ns fractional (1.5)', 'rev', (r) => { cyclesOf(r)[0].latency.read.p50Ns = 1.5; }, I('cycle-field', /latency\.read\.p50Ns = 1\.5/)],
    ['latency.read p50Ns > p99Ns', 'rev', (r) => { const e = cyclesOf(r)[0].latency.read; e.p50Ns = 2000; e.p99Ns = 1000; }, I('cycle-field', /p50Ns 2000 with p99Ns 1000/)],
    ['latency.read p99Ns null with p50Ns 1000', 'rev', (r) => { const e = cyclesOf(r)[0].latency.read; e.p50Ns = 1000; e.p99Ns = null; }, I('cycle-field', /p50Ns 1000 with p99Ns null/)],
    ['latency.batch n 0 with p50Ns/p99Ns 1000', 'rev', (r) => { cyclesOf(r)[0].latency.batch = { n: 0, p50Ns: 1000, p99Ns: 1000, belowFloor: 0 }; }, I('cycle-field', /no timed mass/)],
    ['latency.read.n not a count (-1)', 'rev', (r) => { const e = cyclesOf(r)[0].latency.read; e.n = -1; e.belowFloor = 0; }, I('cycle-field', /counts/)],
    ['cycle.latency not an object', 'rev', (r) => { cyclesOf(r)[0].latency = 5; }, I('cycle-field', /latency is not an object/)],
    ['cycle.latency.read null', 'rev', (r) => { cyclesOf(r)[0].latency.read = null; }, I('cycle-field', /latency\.read is not an object/)],
    // anatomy cycle key (B-B4b, PLAN-0s-bb4b ASSERTION 5): key tables + the cycle-field statements (red until B2 lands SoakReport)
    ['an extra key inside cycle.anatomy', 'treesmoke', (r) => { cyclesOf(r)[0].anatomy.forged = 1; }, I('unknown-key', /carries an unknown key "forged"/)],
    ['an extra key inside cycle.anatomy.counts', 'treesmoke', (r) => { cyclesOf(r)[0].anatomy.counts.forged = 1; }, I('unknown-key', /carries an unknown key "forged"/)],
    ['a deleted cycle.anatomy', 'treesmoke', (r) => { delete cyclesOf(r)[0].anatomy; }, I('missing-key', /lacks "anatomy"/)],
    ['a deleted cycle.anatomy.counts.markEdge', 'treesmoke', (r) => { delete cyclesOf(r)[0].anatomy.counts.markEdge; }, I('missing-key', /lacks "markEdge"/)],
    ['anatomy.counts.markStamp > markEdge', 'treesmoke', (r) => { const a = cyclesOf(r)[0].anatomy; a.counts.markStamp = a.counts.markEdge + 1; a.markDedupe = a.counts.markStamp / a.counts.markEdge; }, I('cycle-field', /markStamp \d+ > markEdge/)],
    ['anatomy.markDedupe 0 with markEdge 0 (null is not zero)', 'treesmoke', (r) => { const a = cyclesOf(r)[0].anatomy; a.counts.markStamp = 0; a.counts.markEdge = 0; a.markDedupe = 0; }, I('cycle-field', /markDedupe/)],
    ['anatomy.markDedupe edited (does not re-derive as markStamp / markEdge)', 'treesmoke', (r) => { const a = cyclesOf(r)[0].anatomy; a.markDedupe = a.markDedupe === 0.5 ? 0.25 : 0.5; }, I('cycle-field', /markDedupe/)],
    ['anatomy.worlds 0', 'treesmoke', (r) => { cyclesOf(r)[0].anatomy.worlds = 0; }, I('cycle-field', /worlds/)],
    ['anatomy.counts.recompute fractional (1.5)', 'treesmoke', (r) => { cyclesOf(r)[0].anatomy.counts.recompute = 1.5; }, I('cycle-field', /recompute/)],
    ['cycle.anatomy not an object (5)', 'treesmoke', (r) => { cyclesOf(r)[0].anatomy = 5; }, I('cycle-field', /anatomy/)],
    // release refusals
    ['R-tamper 10: non-lite PARTIAL (engine alien, NEST skipped for a missing cap)', 'hp', nonLite, R('non-lite', /engine alien, skipped lanes NEST/)],
    ['a tree run under different code (scratch sha, review repro)', 'scratch', (r) => asTree(r), R('tree-parity', /tree Signal\.js sha256 differs from bench\/soak\/parity\.json: recorded under different code/)],
    ['a tree run whose Watch.js sha differs from the pin', 'scratch', (r) => asTree(r, PINS['Signal.js'], '1'.repeat(64), true), R('tree-parity', /tree Watch\.js sha256 differs/)],
    ['a tree run at the pins with parity not ok', 'scratch', (r) => asTree(r, PINS['Signal.js'], PINS['Watch.js'], false), R('tree-parity', /parity ok=false/)],
];

function failureWhere(recs, pred) {
    for (const c of cyclesOf(recs)) for (const f of c.failures) if (pred(f)) return f;
    throw new Error('test/46: no failure record matches');
}
/** An uncapped cycle (every failing world stored) and a key whose count can move by 1 without tripping the range checks. */
function uncappedKey(recs) {
    for (const c of cyclesOf(recs)) {
        if (c.failingWorlds === 0 || c.failures.length !== c.failingWorlds) continue;
        const fc = c.failureCounts, sum = Object.values(fc).reduce((a, b) => a + b, 0);
        const k = Object.keys(fc).find((x) => fc[x] >= 2 && fc[x] < c.failingWorlds && sum - 1 >= c.failingWorlds);
        if (k !== undefined) return [c, k];
    }
    throw new Error('test/46: the REV-152 stream has no uncapped cycle with a movable count');
}
/** A lane with failures but no capped cycle. */
function uncappedLane(recs) {
    const lanes = recs[0].config.SOAK_LANES.value;
    const lane = lanes.find((L) => {
        const cs = cyclesOf(recs).filter((c) => c.lane === L);
        return cs.some((c) => c.failingWorlds > 0) && cs.every((c) => c.failingWorlds === c.failures.length);
    });
    if (lane === undefined) throw new Error('test/46: every failing lane of this stream has a capped cycle');
    return lane;
}
function nonLite(recs) {
    const h = recs[0], s = summaryOf(recs);
    h.engine.name = 'alien';
    h.engine.caps.childEffects = 'no';
    h.config.SOAK_ENGINE = { value: 'alien', source: 'env' };
    h.config.SOAK_LANES = { value: ['GRAPH', 'NEST'], source: 'env' };
    const app = applicability(laneByName('NEST'), h.engine.caps);
    assert.equal(app.status, 'skip');
    h.lanes = [Object.assign({}, h.lanes[0], { engine: 'alien' }), { name: 'NEST', status: 'skip', missingCaps: app.missingCaps, engine: 'alien' }];
    h.scenarios.NEST = { required: app.requiredApplicable, optional: laneByName('NEST').optional.slice(), na: app.scenariosNA };
    h.oraclesNA.NEST = app.oraclesNA;
    s.skipped = [{ lane: 'NEST', missingCaps: app.missingCaps, engine: 'alien' }];
    s.perLane.NEST = { status: 'SKIP', missingCaps: app.missingCaps };
    if (s.verdict === 'PASS') s.verdict = 'PARTIAL';   // SPEC 8: a non-lite skip on an otherwise green run
}

for (const [name, base, fn, want] of TAMPERS) {
    test('tamper: ' + name + ' -> ' + (want.cls ? 'INTEGRITY -- ' + want.cls : 'NOT A RELEASE SOAK -- ' + want.reason), () => {
        const p = tamper(base, fn);
        if (want.cls) { const r = expectIntegrity(p, want.cls); if (want.detail) assert.match(r.err[0], want.detail); } else { const r = expectRefusal(p, want.reason); if (want.detail) assert.match(r.err[0], want.detail); }
    });
}

/* ---- B-B5 CLI: --html, --baseline, argv misuse (PLAN-0s-bb5 ASSERTION 2, ADDENDUM 1: exit = max(head, baseline)) ---- */
const blLines = (r) => r.out.filter((l) => l.indexOf('soak:report: baseline ') === 0);
const verdictLast = (r) => /^soak:report: verdict \S+ \(consistent\)$/.test(r.out[r.out.length - 1]);
function expectConfig(args, detail) {
    const r = report(args);
    assert.equal(r.status, 2, JSON.stringify(args) + ' ' + JSON.stringify(r));
    assert.equal(r.err.length, 1, JSON.stringify(r));
    assert.ok(r.err[0].startsWith('soak:report: CONFIG -- '), r.err[0]);
    if (detail) assert.match(r.err[0], detail);
    assert.deepEqual(r.out, []);
    return r;
}
test('B-B5: --html gives the same exit / stdout / stderr as the plain run, and the file holds exactly one class="banner', () => {
    const plain = report([S.treesmall.path]);
    assert.equal(plain.status, 1, 'a small honest tree run is consistent and refused (exit 1): ' + JSON.stringify(plain));
    const html = join(TMP, 'b5-plain.html');
    const r = report([S.treesmall.path, '--html', html]);
    assert.deepEqual(r, plain);
    assert.ok(existsSync(html), 'the html file is written');
    assert.equal(readFileSync(html, 'utf8').split('class="banner').length - 1, 1);
});
test('B-B5: --html is written for an INTEGRITY outcome too, with the same exit / stdout / stderr as the plain run', () => {
    const bad = tamper('rev', (r) => { cyclesOf(r)[3].rss.stride = 3; });
    const plain = report([bad]);
    const html = join(TMP, 'b5-integrity.html');
    const r = report([bad, '--html', html]);
    assert.equal(plain.status, 1);
    assert.deepEqual(r, plain);
    assert.equal(readFileSync(html, 'utf8').split('class="banner').length - 1, 1);
});
test('B-B5: argv misuse -> CONFIG exit 2 (one line, empty stdout): no value, given twice, unknown --x, html out == stream, html out == baseline', () => {
    const p = S.treesmall.path, h2 = join(TMP, 'b5-x1.html');
    expectConfig([p, '--html']);
    expectConfig([p, '--baseline']);
    expectConfig([p, '--html', h2, '--html', join(TMP, 'b5-x2.html')], /twice/);
    assert.ok(!existsSync(h2), 'a refused invocation writes no file');
    expectConfig([p, '--baseline', p, '--baseline', p], /twice/);
    expectConfig([p, '--htm', join(TMP, 'b5-x3.html')], /--htm/);
    expectConfig([p, '--html', p], /input stream/);
    expectConfig([p, '--baseline', S.hp.path, '--html', S.hp.path], /input stream/);
});
test('B-B5: --baseline with an override-kernel base -> REFUSED overridden, exit 2, on stdout (before the verdict) and stderr', () => {
    const r = report([S.treesmall.path, '--baseline', S.hp.path]);
    assert.equal(r.status, 2, JSON.stringify(r));
    assert.ok(verdictLast(r), 'the verdict stays the last stdout line');
    const b = blLines(r);
    assert.ok(b.length >= 1 && b.every((l) => /REFUSED/.test(l)), JSON.stringify(b));
    assert.ok(b.some((l) => /^soak:report: baseline REFUSED -- overridden/.test(l)), JSON.stringify(b));
    assert.ok(r.err.some((l) => /^soak:report: baseline REFUSED -- overridden/.test(l)), JSON.stringify(r.err));
});
test('B-B5: --baseline with a tampered (INTEGRITY) base -> REFUSED base-integrity, exit 2', () => {
    const base = tamper('treesmall', (r) => { cyclesOf(r)[2].rss.stride = 3; });
    const r = report([S.treesmall.path, '--baseline', base]);
    assert.equal(r.status, 2, JSON.stringify(r));
    assert.ok(verdictLast(r));
    assert.ok(blLines(r).some((l) => /^soak:report: baseline REFUSED -- base-integrity: /.test(l)), JSON.stringify(r.out));
    assert.ok(r.err.some((l) => /^soak:report: baseline REFUSED -- base-integrity: /.test(l)), JSON.stringify(r.err));
});
test('B-B5: a head failing INTEGRITY prints no baseline line (exit 1)', () => {
    const head = tamper('treesmall', (r) => { cyclesOf(r)[1].rss.samples += 1; });
    const r = report([head, '--baseline', S.treesmall.path]);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.ok(r.err[0].startsWith('soak:report: INTEGRITY -- cycle-field: '), r.err[0]);
    assert.equal(blLines(r).length, 0, JSON.stringify(r.out));
});
test('B-B5 D1: a tree-parity head vs itself -> baseline NOTE (all latency p99 null at OPS_MIN), a baseline line before the verdict, exit 1 (max of head and baseline), never PASS', () => {
    const r = report([S.treesmall.path, '--baseline', S.treesmall.path]);
    assert.equal(r.status, 1, JSON.stringify(r));
    assert.ok(verdictLast(r));
    const b = blLines(r);
    // PLAN ADDENDUM 4: one p99-unmeasured note per latency method (12), regressions 0
    assert.equal(b[0], 'soak:report: baseline NOTE regressions=0 notes=' + LATENCY_METHODS.length);
    assert.ok(!b.some((l) => / PASS/.test(l)), JSON.stringify(b));
    assert.ok(r.out.indexOf(b[0]) < r.out.length - 1, 'a baseline line precedes the verdict line');
    assert.ok(r.err.length >= 1 && /tree-parity|NOT A RELEASE SOAK/.test(r.err.join('\n')), JSON.stringify(r.err));
});

test('B-B5: --html write error (target is a directory) -> CONFIG exit 2, stdout unchanged', () => { const plain = report([S.treesmall.path]); const r = report([S.treesmall.path, '--html', TMP]); assert.equal(r.status, 2, JSON.stringify(r)); assert.deepEqual(r.out, plain.out); assert.ok(r.err.some((l) => /^soak:report: CONFIG -- cannot write --html /.test(l)), JSON.stringify(r.err)); });
test('B-B5 (r1 F4): rssStride(n) equals a real RssSampler replay (n pushes, as main.mjs feeds it) for n = 0..5000: .stride and .count', () => {
    let bad = null;
    for (let n = 0; n <= 5000 && bad === null; n++) {
        const smp = new RssSampler();
        for (let i = 0; i < n; i++) smp.push(100 + (i & 7));
        const st = rssStride(n);
        if (smp.stride !== st || smp.count !== Math.ceil(n / st)) bad = { n, stride: smp.stride, count: smp.count, rssStride: st };
    }
    assert.equal(bad, null, JSON.stringify(bad));
});
test('B-B5 (r1 F5): consistent head + tampered (INTEGRITY) base via --baseline --html -> the html banner is warn (the head\'s own lines), never bad', () => {
    const base = tamper('treesmall', (r) => { cyclesOf(r)[2].rss.stride = 3; });
    const html = join(TMP, 'b5-f5.html');
    const r = report([S.treesmall.path, '--baseline', base, '--html', html]);
    assert.equal(r.status, 2, JSON.stringify(r));
    const h = readFileSync(html, 'utf8');
    assert.ok(h.includes('class="banner warn"'), 'want the warn banner');
    assert.ok(!h.includes('class="banner bad"'), 'a red base never paints the head bad');
});

test('B7: the NOTE line names exactly the gates and oracles whose only teeth are GAPS (teeth.mjs, by import), between the stream line and the verdict', () => {
    const r = expectConsistent('hp');
    const covered = new Set();
    for (const k of Object.keys(GAPS)) for (const id of GAPS[k].covers) covered.add(id);
    const only = (id) => covered.has(id) && !Object.prototype.hasOwnProperty.call(CHECKS, id);
    const ids = (a) => (a.length > 0 ? a.join(',') : 'none');
    const gate = GATE_NAMES.filter((n) => only('gate:' + n)), oracle = ORACLES.filter((n) => only('oracle:' + n));
    const notes = r.out.filter((l) => l.indexOf('soak:report: NOTE -- teeth ') === 0);
    assert.equal(notes.length, 1, JSON.stringify(r.out));
    // hp is the headpatched CONTROL: stream line, teeth NOTE, control NOTE, verdict
    assert.equal(r.out.length, 4, JSON.stringify(r.out));
    assert.match(r.out[0], /^soak:report: stream records=/);
    assert.equal(r.out[1], 'soak:report: NOTE -- teeth GAP gate=' + ids(gate) + ' oracle=' + ids(oracle));
    assert.equal(r.out[2], 'soak:report: NOTE -- control kernel headpatched, not release evidence');
});

test('precedence: an edited CHECK_P AND a seq gap -> the earlier class (seq-gap); CHECK_P plus a claimed PASS -> gates-block', () => {
    expectIntegrity(tamper('rev', (recs) => { recs[0].gates.CHECK_P = CHECK_P + 0.1; summaryOf(recs).verdict = 'PASS'; for (let i = 5; i < recs.length; i++) recs[i].seq += 1; }), 'seq-gap');
    const r = expectIntegrity(tamper('rev', (recs) => { recs[0].gates.CHECK_P = CHECK_P + 0.1; summaryOf(recs).verdict = 'PASS'; }), 'gates-block');
    assert.match(r.err[0], /recorded under different code/, 'a gates-block mismatch may be an honest stale stream: the detail says so');
});
test('CONFIG: no path, two paths, an option, a missing file -> exit 2 with one `soak:report: CONFIG --` line', () => {
    for (const args of [[], [S.hp.path, S.hp.path], ['--help'], [join(TMP, 'nope.jsonl')]]) {
        const r = report(args);
        assert.equal(r.status, 2, JSON.stringify(args) + ' ' + JSON.stringify(r));
        assert.equal(r.err.length, 1);
        assert.ok(r.err[0].startsWith('soak:report: CONFIG -- '), r.err[0]);
        assert.deepEqual(r.out, []);
    }
});
