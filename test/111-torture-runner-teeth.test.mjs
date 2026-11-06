// test/111-torture-runner-teeth.test.mjs -- teeth for bench/torture/run.mjs's verdict rules
// (audit 2026-11-06 B5 + S10, AUD-H2 TASKS 1-4).
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT License
//
// RULES PINNED
//   R1 floor key = max(package.json version, the surface Signal.d.ts DECLARES). With
//      package.json at 1.5.2 and reset/snapshot dropped from Signal.js, the two 1.6.0-floor
//      scenarios FAIL (old runner: green "0 passed, 2 skipped"), naming "declared 1.6.0".
//      Control: the same mutant with the 1.6.0 declarations removed from Signal.d.ts skips.
//   R2 Signal.d.ts or package.json unreadable -> exit 2 (old runner: warn / run, exit 0).
//   R3 a pass needs exit 0 AND a "  PASS: " line on the child's stdout (old runner: exit 0
//      alone). Control: the unedited scenario passes.
//
// HOW. Each row builds a scratch copy of the LIVE runner + helpers + the touched scenarios +
// Signal.js / Signal.d.ts / Watch.js / package.json (node_modules symlinked), applies ONE
// mutation, and spawns the runner. The repo itself is never edited. Every child: timeout +
// SIGKILL. No --experimental-strip-types or other version-gated flag (node 22 / 24 / 26).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredKey } from '../bench/torture/helpers/surface.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIOS = ['reset-torture.mjs', 'snapshot-torture.mjs', 'oracle-fuzzer.mjs'];
const MARKERS_160 = ['reset(): void;', 'snapshot(): Snapshot;', 'restore(snap: Snapshot'];
const dirs = [];

function copyTree() {
    const d = mkdtempSync(join(tmpdir(), 'lite-t111-'));
    dirs.push(d);
    mkdirSync(join(d, 'bench', 'torture'), { recursive: true });
    cpSync(join(ROOT, 'bench', 'torture', 'run.mjs'), join(d, 'bench', 'torture', 'run.mjs'));
    cpSync(join(ROOT, 'bench', 'torture', 'helpers'), join(d, 'bench', 'torture', 'helpers'), { recursive: true });
    for (const s of SCENARIOS) cpSync(join(ROOT, 'bench', 'torture', s), join(d, 'bench', 'torture', s));
    for (const f of ['Signal.js', 'Signal.d.ts', 'Watch.js', 'package.json']) cpSync(join(ROOT, f), join(d, f));
    symlinkSync(join(ROOT, 'node_modules'), join(d, 'node_modules'), 'dir');
    return d;
}

/** exact single-match replacement; a moved anchor is a test failure, never a silent no-op. */
function edit(d, file, from, to) {
    const p = join(d, file);
    const src = readFileSync(p, 'utf8');
    const n = src.split(from).length - 1;
    assert.equal(n, 1, `anchor in ${file} matched ${n} times: ${JSON.stringify(from)}`);
    writeFileSync(p, src.replace(from, () => to));
}

function prepend(d, scenario, line) {
    const p = join(d, 'bench', 'torture', scenario);
    writeFileSync(p, line + '\n' + readFileSync(p, 'utf8'));
}

function setPkgVersion(d, v) {
    const p = join(d, 'package.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    j.version = v;
    writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
}

function stripDecl160(d) {
    const p = join(d, 'Signal.d.ts');
    let t = readFileSync(p, 'utf8');
    for (const m of MARKERS_160) {
        assert.ok(t.includes(m), `Signal.d.ts lacks marker ${m}`);
        t = t.split(m).join('/* removed by test/111 */');
    }
    writeFileSync(p, t);
}

function runner(d, names) {
    const r = spawnSync(process.execPath, [join(d, 'bench', 'torture', 'run.mjs'), ...names], {
        cwd: d, encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL', maxBuffer: 1 << 26,
        env: { ...process.env, TORTURE_TIMEOUT_MS: '240000', NODE_OPTIONS: '' },
    });
    assert.equal(r.error, undefined, `runner spawn error: ${r.error && r.error.message}`);
    const out = r.stdout || '';
    const err = r.stderr || '';
    return {
        status: r.status, out, err,
        rows: out.split('\n').filter((l) => /^  (pass|skip|FAIL)  /.test(l)),
        summary: (out.match(/^  (\d+ passed, \d+ skipped, \d+ failed) in /m) || ['', ''])[1],
    };
}

test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('surface: declaredKey(live Signal.d.ts) === 1006000; lite-signal-1.5.2 d.ts === 1005000; non-string -1; empty 0', () => {
    assert.equal(declaredKey(readFileSync(join(ROOT, 'Signal.d.ts'), 'utf8')), 1006000);
    const old = join(ROOT, 'node_modules', 'lite-signal-1.5.2', 'Signal.d.ts');
    assert.ok(existsSync(old), 'node_modules/lite-signal-1.5.2/Signal.d.ts missing (devDependency alias)');
    assert.equal(declaredKey(readFileSync(old, 'utf8')), 1005000);
    for (const bad of [null, undefined, 0, 1006000, {}, Buffer.from('reset(): void;')]) assert.equal(declaredKey(bad), -1);
    assert.equal(declaredKey(''), 0);
    // one missing 1.6.0 marker drops the row; the 1.5.0 row still matches
    const live = readFileSync(join(ROOT, 'Signal.d.ts'), 'utf8');
    for (const m of MARKERS_160) assert.equal(declaredKey(live.split(m).join('')), 1005000, `without ${m}`);
});

test('R1 (A1): package 1.5.2 + reset/snapshot exports dropped -> exit 1, both 1.6.0-floor scenarios FAIL naming "declared 1.6.0"', () => {
    const d = copyTree();
    setPkgVersion(d, '1.5.2');
    edit(d, 'Signal.js', '        reset,\n        isTracking,', '        isTracking,');
    edit(d, 'Signal.js', '        snapshot,\n        restore\n    };', '    };');
    const r = runner(d, ['reset-torture', 'snapshot-torture']);
    assert.equal(r.status, 1, r.out + r.err);
    assert.match(r.summary, /^0 passed, 0 skipped, 2 failed$/);
    assert.equal(r.rows.length, 2);
    for (const row of r.rows) {
        assert.match(row, /^  FAIL  semantic  (snapshot|reset)-torture  \(skipped, but engine package 1\.5\.2, declared 1\.6\.0 \(Signal\.d\.ts\) >= floor 1\.6\.0 -- /);
    }
    assert.match(r.out, /^  floors: package 1\.5\.2, declared 1\.6\.0 \(Signal\.d\.ts\)$/m);
});

test('R1 control: same mutant with the 1.6.0 declarations removed from Signal.d.ts -> exit 0, 2 skipped (floor 1.6.0)', () => {
    const d = copyTree();
    setPkgVersion(d, '1.5.2');
    edit(d, 'Signal.js', '        reset,\n        isTracking,', '        isTracking,');
    edit(d, 'Signal.js', '        snapshot,\n        restore\n    };', '    };');
    stripDecl160(d);
    const r = runner(d, ['reset-torture', 'snapshot-torture']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.summary, /^0 passed, 2 skipped, 0 failed$/);
    assert.deepEqual(r.rows.map((l) => l.replace(/\s+$/, '')), [
        '  skip  semantic  snapshot-torture  (floor 1.6.0)',
        '  skip  semantic  reset-torture  (floor 1.6.0)',
    ]);
    assert.match(r.out, /^  floors: package 1\.5\.2, declared 1\.5\.0 \(Signal\.d\.ts\)$/m);
});

test('R1 prepend form: process.exit(77) in reset-torture with package 1.5.2 -> FAIL (declared 1.6.0); exit(77) in oracle-fuzzer still FAILs', () => {
    const d = copyTree();
    setPkgVersion(d, '1.5.2');
    prepend(d, 'reset-torture.mjs', 'process.exit(77);');
    prepend(d, 'oracle-fuzzer.mjs', 'process.exit(77);');
    const r = runner(d, ['reset-torture', 'oracle-fuzzer']);
    assert.equal(r.status, 1, r.out + r.err);
    assert.match(r.summary, /^0 passed, 0 skipped, 2 failed$/);
    assert.match(r.out, /^  FAIL  semantic  reset-torture  \(skipped, but engine package 1\.5\.2, declared 1\.6\.0 \(Signal\.d\.ts\) >= floor 1\.6\.0 -- /m);
    assert.match(r.out, /^  FAIL  semantic  oracle-fuzzer  \(skipped, but engine package 1\.5\.2, declared 1\.6\.0 \(Signal\.d\.ts\) >= floor 1\.4\.0 -- /m);
});

test('R2: Signal.d.ts deleted -> exit 2 "cannot derive engine surface; failing closed", no scenario runs', () => {
    const d = copyTree();
    rmSync(join(d, 'Signal.d.ts'));
    const r = runner(d, ['reset-torture']);
    assert.equal(r.status, 2, r.out + r.err);
    assert.match(r.err, /cannot derive engine surface; failing closed \(package\.json version: \d+\.\d+\.\d+, Signal\.d\.ts: unreadable\)/);
    assert.equal(r.rows.length, 0);
    assert.equal(r.summary, '');
});

test('R2: package.json deleted -> exit 2; package.json version unparseable -> exit 2', () => {
    const d = copyTree();
    rmSync(join(d, 'package.json'));
    const r = runner(d, ['reset-torture']);
    assert.equal(r.status, 2, r.out + r.err);
    assert.match(r.err, /cannot derive engine surface; failing closed \(package\.json version: unreadable, Signal\.d\.ts: 1\.6\.0\)/);
    assert.equal(r.rows.length, 0);
    const d2 = copyTree();
    setPkgVersion(d2, 'next');
    const r2 = runner(d2, ['reset-torture']);
    assert.equal(r2.status, 2, r2.out + r2.err);
    assert.match(r2.err, /cannot derive engine surface; failing closed \(package\.json version: unreadable, /);
});

test('R3 (A2): oracle-fuzzer with process.exit(0) prepended -> exit 1 "exit 0 without a PASS: line"', () => {
    const d = copyTree();
    prepend(d, 'oracle-fuzzer.mjs', 'process.exit(0);');
    const r = runner(d, ['oracle-fuzzer']);
    assert.equal(r.status, 1, r.out + r.err);
    assert.match(r.summary, /^0 passed, 0 skipped, 1 failed$/);
    assert.deepEqual(r.rows.map((l) => l.replace(/\s+$/, '')), ['  FAIL  semantic  oracle-fuzzer  (exit 0 without a PASS: line)']);
});

test('R3: a PASS: line on stderr, or without the two-space indent, is not a pass', () => {
    const d = copyTree();
    prepend(d, 'oracle-fuzzer.mjs', 'console.error("  PASS: on stderr"); console.log("PASS: unindented"); process.exit(0);');
    const r = runner(d, ['oracle-fuzzer']);
    assert.equal(r.status, 1, r.out + r.err);
    assert.deepEqual(r.rows.map((l) => l.replace(/\s+$/, '')), ['  FAIL  semantic  oracle-fuzzer  (exit 0 without a PASS: line)']);
});

test('R3 control: unedited oracle-fuzzer -> exit 0, "1 passed", its PASS: line echoed from the temp file', () => {
    const d = copyTree();
    const r = runner(d, ['oracle-fuzzer']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.summary, /^1 passed, 0 skipped, 0 failed$/);
    assert.match(r.out, /^  PASS: every computed matched the reference on all \d+ seeds/m);
    assert.deepEqual(r.rows.map((l) => l.replace(/\s+$/, '')), ['  pass  semantic  oracle-fuzzer']);
});
