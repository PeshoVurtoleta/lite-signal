// 70-calibrate-d7.test.mjs -- calibrate.mjs's D7 lane-only check + git status line split (b80 F1 / F2).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// Written from .handoff/PLAN-0s-g.md (TASK 6 rows + ASSERTIONS), not from calibrate.mjs's body. laneOnlyProblems
// must mirror test/41's D7 rule (the evidence is kernelPath(k) with exactly [Signal.js, Watch.js], each sha256 a
// string equal to an OWN parity.json entry; null is not a sha); porcelainLines must keep byte 0 of every line.
// Every row asserts the exact TAG list (the text before the first ':'), so a missing or extra line is red.
// HEAD's write() loop (`parityFiles[f.path] !== f.sha256` after `res.files.length === 0`) and HEAD's gitHead
// (`stdout.trim().split('\n')`) are the defects the row comments name. Untimed: P2 spawns ONE 1 x 1 child.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kernelPath, laneOnlyProblems, porcelainLines } from '../bench/soak/calibration/calibrate.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CAL = fileURLToPath(new URL('../bench/soak/calibration/calibrate.mjs', import.meta.url));
const P = JSON.parse(readFileSync(new URL('../bench/soak/parity.json', import.meta.url), 'utf8')).files;
const G0 = { path: 'Signal.js', sha256: P['Signal.js'] };
const G1 = { path: 'Watch.js', sha256: P['Watch.js'] };
const KP = kernelPath('tree');
const good = (files) => ({ kernel: KP, files });
const GOOD = good([G0, G1]);
const tags = (p) => p.map((l) => l.split(':')[0]);
const E = 'D7 evidence', S = 'D7 sha', F = 'D7 files', K = 'D7 kernel';

test('P1 the live parity-pinned tree evidence is clean', () => {
    assert.equal(typeof P['Signal.js'], 'string');
    assert.equal(typeof P['Watch.js'], 'string');
    assert.deepEqual(laneOnlyProblems('tree', GOOD, P), []);
});

test('P2 a real calibrate child for tree (WIE, 1 x 1) passes laneOnlyProblems', () => {
    // the same argv runChild builds (childArgs: SELF --child ...), env stripped of SOAK_* and NODE_TEST_CONTEXT
    const env = {};
    for (const k of Object.keys(process.env)) {
        if (/^soak_/i.test(k) || k === 'NODE_TEST_CONTEXT') continue;
        env[k] = process.env[k];
    }
    const argv = [CAL, '--child', '--kernel', KP, '--lanes', 'WIE', '--cycles', '1', '--ops', '1'];
    const r = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, env });
    assert.equal(r.status, 0, 'child exited ' + r.status + ': ' + String(r.stderr).slice(0, 2000));
    const res = JSON.parse(r.stdout);
    assert.equal(res.kernel, KP);
    assert.deepEqual(laneOnlyProblems('tree', res, P), []);
});

test('R0 a kernel that is not lane-only -> exactly one D7 kernel line', () => {
    // a guard the helper owns (HEAD's caller tested own(LANE_ONLY_KERNELS) itself); without it kp is undefined
    for (const k of ['headpatched', 'nope']) assert.deepEqual(tags(laneOnlyProblems(k, GOOD, P)), [K], k);
});

test('R1 an extra file with no sha -> evidence + sha', () => {
    // HEAD: parityFiles['extra.js'] (undefined) === f.sha256 (undefined) passed; an unhashed file joined the cut
    assert.deepEqual(tags(laneOnlyProblems('tree', good([G0, G1, { path: 'extra.js' }]), P)), [E, S]);
});

test('R2 an inherited parity map -> every sha line (own entries only)', () => {
    // defense in depth, not red on HEAD's reachable input (JSON.parse never builds an inherited map); HEAD's raw
    // parityFiles[f.path] lookup would accept inherited entries
    assert.deepEqual(tags(laneOnlyProblems('tree', GOOD, Object.create(P))), [S, S]);
});

test('R3 a prototype-key path -> evidence + sha, want is null', () => {
    // defense in depth (HEAD already flags the sha); a raw lookup would compare against Object.prototype members
    for (const path of ['__proto__', 'toString']) {
        const p = laneOnlyProblems('tree', good([G0, { path, sha256: G1.sha256 }]), P);
        assert.deepEqual(tags(p), [E, S], path);
        assert.ok(p[1].endsWith('parity.json null'), p[1]);
    }
});

test('R4 a missing / non-array files list or a null result -> files + evidence, never a throw', () => {
    // HEAD: res.files.length / for-of threw a TypeError (undefined, null, {}, 7, res null); 'Signal.js' iterated
    // its characters (undefined === undefined) and passed
    for (const files of [undefined, null, {}, 7, 'Signal.js']) {
        assert.deepEqual(tags(laneOnlyProblems('tree', good(files), P)), [F, E], String(files));
    }
    assert.deepEqual(tags(laneOnlyProblems('tree', null, P)), [F, E]);
});

test('R5 the wrong or an absent res.kernel -> evidence', () => {
    // HEAD never read res.kernel: a child cut on another engine with tree's files passed
    const files = [G0, G1];
    assert.deepEqual(tags(laneOnlyProblems('tree', { kernel: kernelPath('headpatched'), files }, P)), [E]);
    assert.deepEqual(tags(laneOnlyProblems('tree', { files }, P)), [E]);
});

test('R6 the file list is exactly [Signal.js, Watch.js] in order', () => {
    // HEAD never checked the path list: a missing Watch.js, a reorder, a duplicate and an unlisted 'watch.js'
    // (undefined === undefined) all passed
    for (const files of [[G0], [G1, G0], [G0, G1, G0]]) {
        assert.deepEqual(tags(laneOnlyProblems('tree', good(files), P)), [E], JSON.stringify(files));
    }
    assert.deepEqual(tags(laneOnlyProblems('tree', good([G0, { path: 'watch.js' }]), P)), [E, S]);
});

test('R7 null is not a sha, even where parity has no entry', () => {
    // defense in depth (HEAD flags it: undefined !== null); a `sha !== want` test alone would pass null === null
    const p1 = { 'Signal.js': P['Signal.js'] };
    assert.deepEqual(tags(laneOnlyProblems('tree', good([G0, { path: 'Watch.js', sha256: null }]), p1)), [S]);
});

test('R8 a non-object entry -> evidence + sha, never a throw', () => {
    // HEAD: f.path on a null entry threw a TypeError; a string entry passed (undefined === undefined)
    for (const e of [null, 'Watch.js']) {
        assert.deepEqual(tags(laneOnlyProblems('tree', good([G0, e]), P)), [E, S], String(e));
    }
});

test('R9 an empty file list -> files + evidence', () => {
    // HEAD died on the files line too; the evidence line is new
    assert.deepEqual(tags(laneOnlyProblems('tree', good([]), P)), [F, E]);
});

test('R10 no parity map -> every sha line, never a throw', () => {
    // HEAD: parityFiles[f.path] on undefined threw a TypeError
    assert.deepEqual(tags(laneOnlyProblems('tree', GOOD, undefined)), [S, S]);
});

test('U pure: deep-frozen inputs, a fresh [] per call, inputs unchanged', () => {
    const deepFreeze = (o) => {
        for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
        return Object.freeze(o);
    };
    const res = deepFreeze(JSON.parse(JSON.stringify(GOOD)));
    const par = deepFreeze(JSON.parse(JSON.stringify(P)));
    const res0 = JSON.stringify(res), par0 = JSON.stringify(par);
    let prev = null, bad = 0;
    for (let i = 0; i < 10000; i++) {
        const p = laneOnlyProblems('tree', res, par);
        if (!Array.isArray(p) || p.length !== 0 || p === prev) bad++;
        prev = p;
    }
    assert.equal(bad, 0);
    assert.equal(JSON.stringify(res), res0);
    assert.equal(JSON.stringify(par), par0);
});

test('Q1 porcelainLines keeps byte 0 of every line', () => {
    // HEAD: stdout.trim() ate line 0's leading space (' M' -> 'M')
    const l = porcelainLines(' M bench/soak/calibration/calibrate.mjs\n M bench/soak/config.mjs\n?? BRIEF.md\n');
    assert.deepEqual(l, [' M bench/soak/calibration/calibrate.mjs', ' M bench/soak/config.mjs', '?? BRIEF.md']);
    assert.equal(l[0].slice(0, 2), ' M');
});

test('Q2 an empty stdout -> []', () => {
    assert.deepEqual(porcelainLines(''), []);
});

test('Q3 one trailing CR per line is stripped', () => {
    // HEAD: a CRLF stdout kept '\r' on every line but the last
    assert.deepEqual(porcelainLines(' M a\r\n?? b\r\n'), [' M a', '?? b']);
});

test('Q4 a non-string stdout -> null, never a throw', () => {
    // HEAD: stdout.trim() on a non-string threw a TypeError
    for (const v of [undefined, null, 5]) assert.equal(porcelainLines(v), null, String(v));
});

test('W write() dies on laneOnlyProblems and gitHead uses porcelainLines (static wiring)', () => {
    // b80 r1 NIT (reviewer literal): no row drives write() or gitHead; mutants `d7.length > 1`, the die line deleted
    // and `porcelainLines(s.stdout.trim())` all survived rows P1..Q4. Static pin on the two call sites.
    const src = readFileSync(CAL, 'utf8');
    assert.ok(src.includes("const d7 = laneOnlyProblems(k, res, parityFiles);\n"
        + "            if (d7.length > 0) die(d7.join('; '));"));
    assert.ok(src.includes('dirty: s.status === 0 ? porcelainLines(s.stdout) : null'));
});
