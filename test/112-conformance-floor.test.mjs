// test/112-conformance-floor.test.mjs -- teeth for harness/conformance.mjs's case-count floors and
// KNOWN_FAIL accounting (audit 2026-11-06 S9, AUD-H2 TASKS 5-6).
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT License
//
// RULES PINNED (CONF_MIN 178 / BEH_MIN 18 = the real suite's counts, measured 2026-11-06)
//   F1 an engine run that executed < 178 conformance cases (pass + fail; skips do not count) or
//      recorded < 18 behavioral values -> exit 2 (old: an EMPTY suite printed "RESULT: PASS", exit 0).
//   F2 a KNOWN_FAIL key absent from a run -> exit 2.
//   F3 single-engine mode: a KNOWN_FAIL case that now passes -> exit 1 "CONTRACT CHANGE" (old: 0).
//   Control: exactly 178 + 18 with #179 failing -> exit 0 "RESULT: PASS".
//
// HOW. A generated fake suite (src/index.ts holding plain ESM) and a fake node_modules/.bin/vite-node:
// a sh script that runs THIS node with an --import hook loading *.ts files as ESM, so nothing
// depends on --experimental-strip-types (node 22 / 24 / 26 alike). conformance.mjs runs in place,
// read-only, against the repo's Signal.js. Every child: timeout + SIGKILL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONF = join(ROOT, 'harness', 'conformance.mjs');
const ENGINE = join(ROOT, 'Signal.js');
const CONF_MIN = 178;
const BEH_MIN = 18;
const K179 = '#179 computed self-increment: intra-run read-after-write values correct';
const dirs = [];

const HOOKS = `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function loadSync(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
        return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context);
}
export async function load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
        return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context);
}
`;
const REGISTER = `import * as mod from 'node:module';
import { loadSync } from './ts-hooks.mjs';
if (typeof mod.registerHooks === 'function') mod.registerHooks({ load: loadSync });
else mod.register('./ts-hooks.mjs', import.meta.url);
`;

/** conf = generic conformance cases; k179 = 'fail' | 'pass' | 'absent'; skipConf / skipBeh = extra skipped cases. */
function makeSuite({ conf = 0, beh = 0, k179 = 'absent', skipConf = 0, skipBeh = 0, unexpected = 0 } = {}) {
    const d = mkdtempSync(join(tmpdir(), 'lite-t112-'));
    dirs.push(d);
    mkdirSync(join(d, 'src'), { recursive: true });
    mkdirSync(join(d, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(d, 'ts-hooks.mjs'), HOOKS);
    writeFileSync(join(d, 'ts-register.mjs'), REGISTER);
    const vn = join(d, 'node_modules', '.bin', 'vite-node');
    writeFileSync(vn, `#!/bin/sh\nexec "${process.execPath}" --import "${pathToFileURL(join(d, 'ts-register.mjs')).href}" "$@"\n`);
    chmodSync(vn, 0o755);
    const L = ['export class SkipTest extends Error {}', 'const gen = {};', 'const genB = {};', 'const inner = {};'];
    L.push(`for (let i = 0; i < ${conf}; i++) gen['c' + i] = (fw) => { const s = fw.signal(i); const c = fw.computed(() => s.read() + 1); if (c.read() !== i + 1) throw new Error('c' + i); };`);
    L.push(`for (let i = 0; i < ${skipConf}; i++) gen['skip' + i] = () => { throw new SkipTest('skip'); };`);
    L.push(`for (let i = 0; i < ${unexpected}; i++) gen['bad' + i] = () => { throw new Error('unexpected'); };`);
    L.push(`for (let i = 0; i < ${beh}; i++) genB['b' + i] = (fw) => { const s = fw.signal(i); return s.read(); };`);
    L.push(`for (let i = 0; i < ${skipBeh}; i++) genB['bskip' + i] = () => { throw new SkipTest('skip'); };`);
    if (k179 === 'fail') L.push(`inner[${JSON.stringify(K179)}] = () => { throw new Error('absorption contract'); };`);
    if (k179 === 'pass') L.push(`inner[${JSON.stringify(K179)}] = () => {};`);
    if (k179 === 'skip') L.push(`inner[${JSON.stringify(K179)}] = () => { throw new SkipTest('skip'); };`);
    L.push(`export const testSuite = [`);
    L.push(`    { section: 'Gen', type: 'conformance', cases: gen },`);
    L.push(`    { section: 'Inner Write', type: 'conformance', cases: inner },`);
    L.push(`    { section: 'Behavior', type: 'behavioral', cases: genB },`);
    L.push(`];`);
    writeFileSync(join(d, 'src', 'index.ts'), L.join('\n') + '\n');
    return d;
}

function conformance(suite, engines = []) {
    const r = spawnSync(process.execPath, [CONF, ...engines], {
        cwd: ROOT, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1 << 24,
        env: { ...process.env, REACTIVE_SUITE_PATH: suite, NODE_OPTIONS: '' },
    });
    assert.equal(r.error, undefined, `spawn error: ${r.error && r.error.message}`);
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('control: exactly CONF_MIN (177 + #179 failing) + BEH_MIN behavioral -> exit 0 RESULT: PASS', () => {
    const r = conformance(makeSuite({ conf: CONF_MIN - 1, beh: BEH_MIN, k179: 'fail' }));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /conformance 177 pass \/ 1 fail \/ 0 skip, behavioral 18 recorded/);
    assert.match(r.out, /^RESULT: PASS$/m);
    assert.doesNotMatch(r.out, /FLOOR/);
});

test('F1: empty suite -> exit 2 (old: exit 0 RESULT: PASS)', () => {
    const r = conformance(makeSuite({}));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /FLOOR  conformance executed 0 < CONF_MIN 178/);
    assert.match(r.out, /FLOOR  behavioral recorded 0 < BEH_MIN 18/);
    assert.doesNotMatch(r.out, /RESULT: PASS/);
});

test('F1: CONF_MIN - 1 executed conformance (176 + #179) -> exit 2', () => {
    const r = conformance(makeSuite({ conf: CONF_MIN - 2, beh: BEH_MIN, k179: 'fail' }));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /FLOOR  conformance executed 177 < CONF_MIN 178/);
    assert.doesNotMatch(r.out, /FLOOR  behavioral/);
});

test('F1: a skipped conformance case is not executed (177 executed + 1 skip) -> exit 2', () => {
    const r = conformance(makeSuite({ conf: CONF_MIN - 2, skipConf: 1, beh: BEH_MIN, k179: 'fail' }));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /conformance 176 pass \/ 1 fail \/ 1 skip/);
    assert.match(r.out, /FLOOR  conformance executed 177 < CONF_MIN 178/);
});

test('F1: BEH_MIN - 1 behavioral -> exit 2; a skipped behavioral case does not count', () => {
    const r = conformance(makeSuite({ conf: CONF_MIN - 1, beh: BEH_MIN - 1, k179: 'fail' }));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /FLOOR  behavioral recorded 17 < BEH_MIN 18/);
    assert.doesNotMatch(r.out, /FLOOR  conformance/);
    const r2 = conformance(makeSuite({ conf: CONF_MIN - 1, beh: BEH_MIN - 1, skipBeh: 1, k179: 'fail' }));
    assert.equal(r2.status, 2, r2.out);
    assert.match(r2.out, /FLOOR  behavioral recorded 17 < BEH_MIN 18/);
});

test('F2: KNOWN_FAIL key absent (178 generic conformance, no #179) -> exit 2', () => {
    const r = conformance(makeSuite({ conf: CONF_MIN, beh: BEH_MIN, k179: 'absent' }));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /FLOOR  KNOWN_FAIL case missing from the run: Inner Write :: #179 /);
    assert.doesNotMatch(r.out, /FLOOR  conformance|FLOOR  behavioral/);
});

test('F2: KNOWN_FAIL key skipped (178 generic conformance, #179 SkipTest) -> exit 2', () => {
    const r = conformance(makeSuite({ conf: CONF_MIN, beh: BEH_MIN, k179: 'skip' }));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /FLOOR  KNOWN_FAIL case skipped/);
});

test('F3: single-engine, #179 passing -> exit 1 CONTRACT CHANGE (old: exit 0)', () => {
    const r = conformance(makeSuite({ conf: CONF_MIN - 1, beh: BEH_MIN, k179: 'pass' }));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /CONTRACT CHANGE  Inner Write :: #179 .* now passes/);
    assert.match(r.out, /^RESULT: FAIL$/m);
});

test('single-engine: an unexpected conformance failure at the floor -> exit 1 UNEXPECTED FAIL', () => {
    const r = conformance(makeSuite({ conf: CONF_MIN - 2, unexpected: 1, beh: BEH_MIN, k179: 'fail' }));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /UNEXPECTED FAIL  Gen :: bad0/);
});

test('F1 A/B mode: empty suite with two engines -> exit 2; at the floor -> exit 0 with 0 differences', () => {
    const r = conformance(makeSuite({}), [ENGINE, ENGINE]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /FLOOR  conformance executed 0 < CONF_MIN 178/);
    const r2 = conformance(makeSuite({ conf: CONF_MIN - 1, beh: BEH_MIN, k179: 'fail' }), [ENGINE, ENGINE]);
    assert.equal(r2.status, 0, r2.out);
    assert.match(r2.out, /PER-TEST DIFF  196 cases, 0 difference\(s\)/);
    const r3 = conformance(makeSuite({ conf: CONF_MIN - 2, beh: BEH_MIN, k179: 'fail' }), [ENGINE, ENGINE]);
    assert.equal(r3.status, 2, r3.out);
    assert.equal((r3.out.match(/FLOOR  conformance executed 177 < CONF_MIN 178/g) || []).length, 2);
});
