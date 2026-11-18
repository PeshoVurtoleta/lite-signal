/**
 * VersionMatrix sabotage-control tooth (b208, PLAN-PD-B tasks 2-4 as amended by .handoff/b208/PLAN-B.md).
 *
 * Oracle: the DELTA's exit-code contract (as ruled by D-QVM-2, b210), not the harness code. gate.mjs
 * --expect-fail maps the gate verdict FAIL (1) -> 0, NO EVIDENCE (3) -> 3 (control REFUSED: PENDING,
 * not blind) and PASS (0) -> 4 (ran with evidence, did not trip); a gate.mjs crash exits 1, never 0.
 * matrix.sh `judge <cand>` without CONTROL_LABEL exits with the candidate's gate status; with it, both
 * gates run and the precedence is: either gate 3 -> 3 (PENDING), else control 4 -> 4 (NO VERDICT),
 * else control any other non-zero (crash) -> 5, else the candidate's status. matrix.sh harness errors
 * (swap / npm pack / run.mjs) exit 5, never a 1 that reads as FAIL.
 *
 * Every row runs in its own tmp dir T holding COPIES of gate.mjs + matrix.sh, a fixture manifest and
 * fixture baselines (built from the tracked baselines/1.5.0/reactive-graph-mix.json); nothing touches
 * harness/VersionMatrix/baselines or its node_modules. VM121_SRC=<dir> points the copies at another
 * gate.mjs / matrix.sh pair (revert checks against the before copies and the named mutants).
 *
 * b209 (UNIT B', review r1 blockers 1-2 + D-b208-3 / D-b208-4): a missing argument is a usage error -> 2,
 * never a 1 (x); a CONTROL_LABEL equal to floor / rolling / candidate is refused like a missing engine (ix);
 * gate mode refuses CONTROL_LABEL -> 2 (xi) and its exit tail goes through judge, executed end to end with
 * a tgz-packing npm shim (xii); each sabotage plant fires on >= 1 real VM workload (xiii, REACH).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, rmSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VM = join(ROOT, 'harness', 'VersionMatrix');
const SRC = process.env.VM121_SRC ? resolve(process.env.VM121_SRC) : VM;
const BASE = JSON.parse(readFileSync(join(VM, 'baselines', '1.5.0', 'reactive-graph-mix.json'), 'utf8'));
const TOL = JSON.parse(readFileSync(join(VM, 'manifest.json'), 'utf8')).tolerances;
const TMP = [];
after(() => { for (const d of TMP) rmSync(d, { recursive: true, force: true }); });

const clone = () => JSON.parse(JSON.stringify(BASE));
const slow = () => { const c = clone(); c.frame.avg *= 1.5; return c; };      // frame.avg 1.5x rolling
const spread = () => { const c = clone(); c.evidence.spreadPct = 20; return c; }; // NO EVIDENCE (> 15%)
const sha = (ch) => ch.repeat(64);
// label -> [summary, engine sha]; floor fl / rolling ro carry the base numbers
const LABELS = {
    fl: () => [clone(), sha('a')], ro: () => [clone(), sha('b')],
    cand: () => [clone(), sha('c')],          // candidate PASS
    candfail: () => [slow(), sha('d')],       // candidate FAIL
    ctl: () => [slow(), sha('e')],            // control that trips (1.5x)
    ctlblind: () => [clone(), sha('f')],      // identical numbers, different sha: control blind
    ctlnoev: () => [spread(), sha('9')],      // spread 20%: NO EVIDENCE
    candnoev: () => [spread(), sha('8')],     // b210: candidate refused (spread 20%: NO EVIDENCE)
    ctlbad: () => ['{ "frame": ', sha('7')],  // b210: unparsable baseline JSON: gate.mjs crashes (exit 1)
};

function makeT({ modules = true } = {}) {
    const T = mkdtempSync(join(tmpdir(), 'vm121-'));
    TMP.push(T);
    copyFileSync(join(SRC, 'gate.mjs'), join(T, 'gate.mjs'));
    copyFileSync(join(SRC, 'matrix.sh'), join(T, 'matrix.sh'));
    writeFileSync(join(T, 'manifest.json'), JSON.stringify({ floor: 'fl', rolling: 'ro', workloads: ['reactive-graph-mix'], tolerances: TOL }, null, 2));
    for (const [label, mk] of Object.entries(LABELS)) {
        const [s, h] = mk();
        mkdirSync(join(T, 'baselines', label), { recursive: true });
        writeFileSync(join(T, 'baselines', label, 'reactive-graph-mix.json'), typeof s === 'string' ? s : JSON.stringify(s, null, 2));
        writeFileSync(join(T, 'baselines', label, 'engine.sha256'), h);
    }
    if (modules) symlinkSync(join(ROOT, 'node_modules'), join(T, 'node_modules'));   // @zakkster/lite-profiler
    return T;
}

function env(extra = {}) {
    const e = { ...process.env };
    delete e.CONTROL_LABEL; delete e.CONTROL_ENGINE; delete e.REPS;
    return { ...e, ...extra };
}
function run(T, cmd, args, extra) {
    const r = spawnSync(cmd, args, { cwd: T, env: env(extra), encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
    assert.equal(r.signal, null, `${cmd} ${args.join(' ')} killed by ${r.signal}`);
    return r;
}
const gate = (T, ...a) => run(T, process.execPath, ['gate.mjs', ...a]);
const judge = (T, cand, extra) => run(T, 'bash', ['matrix.sh', 'judge', cand], extra);
const tail = (r) => '\n--- stderr tail ---\n' + String(r.stderr).slice(-600) + String(r.stdout).slice(-200);

test('(i) gate: a control 1.5x rolling frame.avg trips: --expect-fail -> 0, plain -> 1', () => {
    const T = makeT();
    const x = gate(T, 'ctl', '--expect-fail');
    assert.equal(x.status, 0, 'expect-fail on a tripping control' + tail(x));
    const p = gate(T, 'ctl');
    assert.equal(p.status, 1, 'plain gate on the same control' + tail(p));
});

test('(ii) gate: identical numbers, different sha (gate PASS) under --expect-fail -> 4', () => {
    const T = makeT();
    const r = gate(T, 'ctlblind', '--expect-fail');
    assert.equal(r.status, 4, 'blind control' + tail(r));
});

test('(iii) gate: spread 20% (NO EVIDENCE) under --expect-fail -> 3 (control REFUSED, not blind; D-QVM-2)', () => {
    const T = makeT();
    const r = gate(T, 'ctlnoev', '--expect-fail');
    assert.equal(r.status, 3, 'NO EVIDENCE control' + tail(r));
    assert.match(String(r.stderr), /gate exit 3 -> exit 3 \(CONTROL REFUSED: NO EVIDENCE -> PENDING/, 'refused message' + tail(r));
});

test('(iv) judge: control trips + candidate PASS -> 0', () => {
    const T = makeT();
    const r = judge(T, 'cand', { CONTROL_LABEL: 'ctl' });
    assert.equal(r.status, 0, 'judge' + tail(r));
});

test('(v) judge: control blind -> 4 (overrides a candidate PASS)', () => {
    const T = makeT();
    const r = judge(T, 'cand', { CONTROL_LABEL: 'ctlblind' });
    assert.equal(r.status, 4, 'judge' + tail(r));
});

test('(vi) judge: control trips + candidate FAIL -> 1', () => {
    const T = makeT();
    const r = judge(T, 'candfail', { CONTROL_LABEL: 'ctl' });
    assert.equal(r.status, 1, 'judge' + tail(r));
});

test('(vii) judge: CONTROL_LABEL unset -> the plain gate codes 0 / 1 / 3', () => {
    const T = makeT();
    const a = judge(T, 'cand');
    assert.equal(a.status, 0, 'judge cand' + tail(a));
    const b = judge(T, 'candfail');
    assert.equal(b.status, 1, 'judge candfail' + tail(b));
    const c = judge(T, 'ctlnoev');
    assert.equal(c.status, 3, 'judge NO EVIDENCE' + tail(c));
});

// (xiv)-(xvii) D-QVM-2 (b210): judge with CONTROL_LABEL returns 3 / PENDING whenever either gate refused
// for lack of evidence; 4 stays reserved for a control that ran with evidence and did not trip; a control
// gate crash is a harness error (5). One row per arm; each asserts the exact status and the judge line.
const PENDING = (cst, ctl, l) => new RegExp(`judge: candidate gate exit ${cst}, control ${l} expect-fail exit ${ctl} -- NO EVIDENCE -> PENDING \\(exit 3\\)`);

test('(xiv) judge: refused candidate (NO EVIDENCE) + tripping control -> 3', () => {
    const T = makeT();
    const r = judge(T, 'candnoev', { CONTROL_LABEL: 'ctl' });
    assert.equal(r.status, 3, 'judge' + tail(r));
    assert.match(String(r.stderr), PENDING(3, 0, 'ctl'), 'PENDING line names both exits' + tail(r));
});

test('(xv) judge: candidate PASS + refused control (NO EVIDENCE) -> 3, not 4', () => {
    const T = makeT();
    const r = judge(T, 'cand', { CONTROL_LABEL: 'ctlnoev' });
    assert.equal(r.status, 3, 'judge' + tail(r));
    assert.match(String(r.stderr), PENDING(0, 3, 'ctlnoev'), 'PENDING line names both exits' + tail(r));
    assert.doesNotMatch(String(r.stderr), /NO VERDICT/, 'a refused control is not reported blind' + tail(r));
});

test('(xvi) judge precedence: refused candidate + blind control -> 3; candidate FAIL + refused control -> 3', () => {
    const T = makeT();
    const a = judge(T, 'candnoev', { CONTROL_LABEL: 'ctlblind' });
    assert.equal(a.status, 3, 'refused candidate + blind control' + tail(a));
    assert.match(String(a.stderr), PENDING(3, 4, 'ctlblind'), 'PENDING ahead of blind' + tail(a));
    const b = judge(T, 'candfail', { CONTROL_LABEL: 'ctlnoev' });
    assert.equal(b.status, 3, 'candidate FAIL + refused control' + tail(b));
    assert.match(String(b.stderr), PENDING(1, 3, 'ctlnoev'), 'PENDING ahead of the candidate FAIL' + tail(b));
    const c = judge(T, 'candnoev', { CONTROL_LABEL: 'ctlbad' }); assert.equal(c.status, 3, 'refused candidate + crashing control' + tail(c)); assert.match(String(c.stderr), PENDING(3, 1, 'ctlbad'), 'PENDING ahead of the crash arm' + tail(c));
});

test('(xvii) control gate crash (unparsable baseline): gate --expect-fail -> 1 (never 0); judge -> 5 (never 4)', () => {
    const T = makeT();
    const g = gate(T, 'ctlbad', '--expect-fail');
    assert.equal(g.status, 1, 'crashing control under --expect-fail' + tail(g));
    assert.match(String(g.stderr), /SyntaxError/, 'the crash is the JSON parse' + tail(g));
    assert.doesNotMatch(String(g.stderr), /expect-fail: control/, 'the crash bypasses the verdict mapping' + tail(g));
    const r = judge(T, 'cand', { CONTROL_LABEL: 'ctlbad' });
    assert.equal(r.status, 5, 'judge with a crashing control' + tail(r));
    assert.match(String(r.stderr), /judge: control ctlbad gate crashed \(expect-fail exit 1\) -- harness error \(exit 5\) \(candidate gate exit 0\)/, 'crash line' + tail(r));
    const u = judge(T, 'cand', { CONTROL_LABEL: '--x' }); assert.equal(u.status, 5, 'control gate usage exit 2' + tail(u)); assert.match(String(u.stderr), /judge: control --x gate crashed \(expect-fail exit 2\) -- harness error \(exit 5\) \(candidate gate exit 0\)/, 'crash line, exit 2' + tail(u));
});

test('(viii) gate-self: a failing npm (swap) is a harness error -> 5, never 1', () => {
    const T = makeT({ modules: false });   // no node_modules link: a swap that got past npm pack has nothing real to rm
    const shim = join(T, 'shim');
    mkdirSync(shim);
    writeFileSync(join(shim, 'npm'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(shim, 'npm'), 0o755);
    const r = run(T, 'bash', ['matrix.sh', 'gate-self', 'candx', join(T, 'no-such-engine.js')], { PATH: shim + ':' + process.env.PATH });
    assert.equal(r.status, 5, 'gate-self with npm exiting 1' + tail(r));
    assert.equal(existsSync(join(T, 'node_modules')), false, 'no node_modules appeared in T');
});

// npm shim in T/shim: records every call in T/npm-reached, then runs `body` (a reached npm under the
// ERR trap reads 5, so a row expecting 2 also sees a missed refusal; the marker proves it either way).
function npmShim(T, body = 'exit 1\n') {
    const shim = join(T, 'shim');
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'npm'), '#!/bin/sh\necho "$*" >> ' + JSON.stringify(join(T, 'npm-reached')) + '\n' + body);
    chmodSync(join(shim, 'npm'), 0o755);
    return { PATH: shim + ':' + process.env.PATH };
}

test('(ix) gate-self: CONTROL_LABEL without an existing CONTROL_ENGINE, or equal to floor / rolling / candidate -> 5 before any baseline is removed', () => {
    const cases = [
        { CONTROL_LABEL: 'ctl' }, { CONTROL_LABEL: 'ctl', CONTROL_ENGINE: '/no/such/engine.js' },
        // b209 blocker 2: an existing engine but a label that collides with floor / rolling / candidate
        { CONTROL_LABEL: 'fl', CONTROL_ENGINE: process.execPath }, { CONTROL_LABEL: 'ro', CONTROL_ENGINE: process.execPath },
        { CONTROL_LABEL: 'candx', CONTROL_ENGINE: process.execPath },
        // b209 r2 blocker 2: labels that ALIAS a baseline dir (./baselines/${label}; RO on case-insensitive APFS)
        { CONTROL_LABEL: 'ro/', CONTROL_ENGINE: process.execPath }, { CONTROL_LABEL: './ro', CONTROL_ENGINE: process.execPath },
        { CONTROL_LABEL: 'RO', CONTROL_ENGINE: process.execPath },
    ];
    for (const extra of cases) {
        const T = makeT({ modules: false });
        const r = run(T, 'bash', ['matrix.sh', 'gate-self', 'candx', join(T, 'no-such-engine.js')], { ...extra, ...npmShim(T) });
        assert.equal(r.status, 5, JSON.stringify(extra) + tail(r));
        assert.match(String(r.stderr), /needs CONTROL_ENGINE/, 'the control guard fired, not the swap ' + JSON.stringify(extra) + tail(r));
        assert.equal(existsSync(join(T, 'npm-reached')), false, 'npm reached ' + JSON.stringify(extra));
        for (const l of ['fl', 'ro', 'ctl']) assert.equal(existsSync(join(T, 'baselines', l, 'reactive-graph-mix.json')), true, `baselines/${l} kept ` + JSON.stringify(extra));
    }
});

test('(x) judge / gate / gate-self with a missing argument -> 2 (usage), never 1, npm never reached', () => {
    for (const args of [['judge'], ['gate'], ['gate-self'], ['gate-self', 'candx']]) {
        const T = makeT({ modules: false });
        const r = run(T, 'bash', ['matrix.sh', ...args], npmShim(T));
        assert.equal(r.status, 2, args.join(' ') + tail(r));
        assert.match(String(r.stderr), /usage: matrix\.sh /, 'usage message on stderr ' + args.join(' ') + tail(r));
        assert.equal(existsSync(join(T, 'npm-reached')), false, 'npm reached: ' + args.join(' '));
    }
});

test('(xi) gate + CONTROL_LABEL -> 2 before any capture: npm never reached, baselines untouched (D-b208-3)', () => {
    const T = makeT({ modules: false });
    const r = run(T, 'bash', ['matrix.sh', 'gate', 'cand'], { CONTROL_LABEL: 'ctl', CONTROL_ENGINE: process.execPath, ...npmShim(T) });
    assert.equal(r.status, 2, 'gate with CONTROL_LABEL' + tail(r));
    assert.match(String(r.stderr), /gate-self is the controlled run/, 'refusal message' + tail(r));
    assert.equal(existsSync(join(T, 'npm-reached')), false, 'npm reached');
    for (const l of ['fl', 'ro', 'cand', 'ctl']) {
        assert.equal(readFileSync(join(T, 'baselines', l, 'reactive-graph-mix.json'), 'utf8'), JSON.stringify(LABELS[l]()[0], null, 2), `baselines/${l} untouched`);
    }
});

// (xii) gate mode END TO END: a PATH npm shim packs a real tgz (package/Signal.js, extracted by the real
// tar) per label, stub run.mjs / aggregate.mjs (T holds copies) restore the fixture summary per label
// after capture_interleaved rm -rf's each label dir, and the exit tail is executed for real.
const GL = 'vm121-' + process.pid + '-';
const GLAB = { fl: GL + 'fl', ro: GL + 'ro', pass: GL + 'cand', fail: GL + 'candfail' };
after(() => {
    for (const f of readdirSync('/tmp')) if (f.startsWith('zakkster-lite-signal-' + GL) && f.endsWith('.tgz')) rmSync(join('/tmp', f), { force: true });
});
function makeGateT({ aggregateFails = false } = {}) {
    const T = mkdtempSync(join(tmpdir(), 'vm121-'));
    TMP.push(T);
    copyFileSync(join(SRC, 'gate.mjs'), join(T, 'gate.mjs'));
    copyFileSync(join(SRC, 'matrix.sh'), join(T, 'matrix.sh'));
    writeFileSync(join(T, 'manifest.json'), JSON.stringify({ floor: GLAB.fl, rolling: GLAB.ro, workloads: ['reactive-graph-mix'], tolerances: TOL }, null, 2));
    const fx = { [GLAB.fl]: clone(), [GLAB.ro]: clone(), [GLAB.pass]: clone(), [GLAB.fail]: slow() };
    for (const [label, s] of Object.entries(fx)) {
        mkdirSync(join(T, 'fixtures', label), { recursive: true });
        writeFileSync(join(T, 'fixtures', label, 'reactive-graph-mix.json'), JSON.stringify(s, null, 2));
    }
    // a REAL node_modules dir (never the repo symlink: swap rm -rf's node_modules/@zakkster/lite-signal)
    mkdirSync(join(T, 'node_modules', '@zakkster'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules', '@zakkster', 'lite-profiler'), join(T, 'node_modules', '@zakkster', 'lite-profiler'));
    writeFileSync(join(T, 'run.mjs'), '// vm121 stub run.mjs: the capture itself is not under test\n');
    writeFileSync(join(T, 'aggregate.mjs'), aggregateFails
        ? 'process.exit(1);\n'
        : "import { mkdirSync, copyFileSync } from 'node:fs';\nconst l = process.argv[2];\nmkdirSync('baselines/' + l, { recursive: true });\ncopyFileSync('fixtures/' + l + '/reactive-graph-mix.json', 'baselines/' + l + '/reactive-graph-mix.json');\n");
    const pk = 'ver="${2#@zakkster/lite-signal@}"\n' +
        '[ "$1" = pack ] && [ "$3" = --pack-destination ] && [ "$4" = /tmp ] || exit 1\n' +
        'd=$(mktemp -d ' + JSON.stringify(join(T, 'pk.XXXXXX')) + ') || exit 1\n' +
        'mkdir "$d/package" && printf \'// vm121 fixture engine %s\\n\' "$ver" > "$d/package/Signal.js" && tar -czf "/tmp/zakkster-lite-signal-$ver.tgz" -C "$d" package\n';
    return { T, path: npmShim(T, pk) };
}

test('(xii) gate mode end to end: candidate PASS -> 0, FAIL -> 1 (through the tail), aggregate failure -> 5', () => {
    const want = [[GLAB.pass, {}, 0], [GLAB.fail, {}, 1], [GLAB.pass, { aggregateFails: true }, 5]];
    for (const [cand, opt, code] of want) {
        const { T, path } = makeGateT(opt);
        const r = run(T, 'bash', ['matrix.sh', 'gate', cand], { REPS: '1', ...path });
        const what = cand + ' ' + JSON.stringify(opt);
        assert.equal(r.status, code, what + tail(r));
        const packs = readFileSync(join(T, 'npm-reached'), 'utf8');
        for (const l of [GLAB.fl, GLAB.ro, cand]) assert.match(packs, new RegExp('pack @zakkster/lite-signal@' + l + ' '), 'swap packed ' + l + ' (' + what + ')');
        if (code === 5) continue;
        assert.equal(readFileSync(join(T, 'node_modules', '@zakkster', 'lite-signal', 'Signal.js'), 'utf8'), '// vm121 fixture engine ' + cand + '\n', 'the last swap extracted the candidate tgz');
        for (const l of [GLAB.fl, GLAB.ro, cand]) assert.match(readFileSync(join(T, 'baselines', l, 'engine.sha256'), 'utf8'), /^[0-9a-f]{64}$/, 'engine.sha256 for ' + l);
        assert.match(String(r.stderr), code === 1 ? /GATE FAILED/ : /GATE PASSED/, what + tail(r));
    }
});

// (xiii) REACH (D-b208-4): each sabotage plant executes on >= 1 of the manifest workloads. Drives the REAL
// VM workload code (workloads/index.mjs get + lib/capture.mjs profile, as run.mjs does) against the frozen
// sabotage engine at a reduced WARMUP / MEASURE, untimed, one cold child per workload (as run.mjs: the
// engine node pool cap is per process); writes nothing into VM/baselines.
// VM121_SABOTAGE=<Signal.js> points it at another engine (the must-fail variant, plant 2 at pullComputed);
// set explicitly (even empty), a missing file FAILS. Unset, the row SKIPS (visibly) only where R/.handoff is
// absent (CI); with .handoff present a missing default engine FAILS.
const SABOTAGE = process.env.VM121_SABOTAGE !== undefined ? resolve(process.env.VM121_SABOTAGE)
    : join(ROOT, '.handoff', 'b169-evidence', 'vm', 'frozen', 'sabotage-24ac539-da5ddb86', 'Signal.js');
test('(xiii) REACH: the executeEffect plant and the refreshComputed plant each fire on >= 1 VM workload', { skip: process.env.VM121_SABOTAGE !== undefined || existsSync(join(ROOT, '.handoff')) ? false : 'no .handoff (not shipped; CI): ' + SABOTAGE }, (t) => {
    const workloads = JSON.parse(readFileSync(join(VM, 'manifest.json'), 'utf8')).workloads;
    const src = [
        "const [prof, cap, idx, eng, w] = JSON.parse(process.argv[1]);",
        "const { Profiler, summarize } = await import(prof);",
        "const { profile } = await import(cap);",
        "const { get } = await import(idx);",
        "const E = await import(eng);",
        "if (typeof E.__sabotageHits !== 'function') { console.log(JSON.stringify({ err: 'engine has no __sabotageHits()' })); process.exit(0); }",
        "const hits = () => E.__sabotageHits().split(',').map(Number);",
        "const a = hits(); profile(Profiler, summarize, get(w), E, { label: w, engine: 'reach' }, { WARMUP: 2, MEASURE: 4 }); const b = hits();",
        "console.log(JSON.stringify({ row: [w, b[0] - a[0], b[1] - a[1]] }));",
    ].join('\n');
    const out = { rows: [] };
    for (const w of workloads) {
        const argv = [import.meta.resolve('@zakkster/lite-profiler'), pathToFileURL(join(VM, 'lib', 'capture.mjs')).href,
            pathToFileURL(join(VM, 'workloads', 'index.mjs')).href, pathToFileURL(SABOTAGE).href, w];
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', src, JSON.stringify(argv)],
            { cwd: tmpdir(), encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
        assert.equal(r.signal, null, 'reach child killed by ' + r.signal + ' (' + w + ')');
        assert.equal(r.status, 0, 'reach child ' + w + tail(r));
        const o = JSON.parse(String(r.stdout).trim().split('\n').pop());
        assert.equal(o.err, undefined, o.err + ' (' + SABOTAGE + ')');
        out.rows.push(o.row);
    }
    for (const [w, e, rc] of out.rows) t.diagnostic(`reach ${w}: executeEffect=${e} refreshComputed=${rc}`);
    assert.equal(out.rows.length, workloads.length, 'every manifest workload ran');
    assert.ok(out.rows.some((x) => x[1] > 0), 'executeEffect plant fires on >= 1 workload: ' + JSON.stringify(out.rows));
    assert.ok(out.rows.some((x) => x[2] > 0), 'refreshComputed plant fires on >= 1 workload: ' + JSON.stringify(out.rows));
});
