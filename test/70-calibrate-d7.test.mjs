// 70-calibrate-d7.test.mjs -- calibrate.mjs's D7 lane-only check + git status line split (b80 F1 / F2) + the
// --import-throughput reader (b92, rows I1..I7).
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
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kernelPath, laneOnlyProblems, porcelainLines, importThroughput, importCountsSame, busyNodeFrom, BUSY_NODE_PCT } from '../bench/soak/calibration/calibrate.mjs';

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

// ---- b92: --import-throughput (importThroughput / importCountsSame) ------------------------------------------
// HEAD's import loop read old.kernels.<k>.throughput.<lane>.opsPerSecPerCycle only: a doc that was ITSELF an
// --import-throughput run holds the string PENDING there (its timed data lives in old.throughputRun), so the
// R0 recut died with `cyc.slice` TypeError after 886 s. Rows I1..I7 are written from the b92 brief: (a) timed ->
// recomputed min / median / max, (b) chained -> old.throughputRun verbatim, (c) anything else throws; the file is
// shape-checked before the sweep (I7 spawns write() and needs it to die in seconds).

const LANE_COUNTS = (w) => ({ GRAPH: { worlds: w, ops: 10 * w, scenarios: 3, performed: 7, skipTainted: 0 } });
const RUN = {
    note: 'REPORTED tier, decides no gate: an earlier timed run of the same child loop (same seed / cycles / ops), held under quiet-lock; its counts were identical to kernels.*',
    date: '2026-10-19T02:53:24.490Z', gitHead: '45de5e1ac1cdf894f50580d50845b6ad9eaed49e', node: 'v26.8.2', cpu: 'Apple M4 Pro',
    loadavgBefore: [2.74, 2.79, 2.62], loadavgAfter: [5.95, 4.67, 3.65], busyNodeBefore: ['1540 0.0 node'], seconds: 891,
    timing: 'timed under quiet-lock, sequential children, one kernel at a time (REPORTED tier; decides no gate)',
    perKernel: {
        headpatched: { GRAPH: { opsPerSecPerCycle: [13733, 13544, 13503], min: 13503, median: 13544, max: 13733 } },
        tree: { WIE: { opsPerSecPerCycle: [10438, 10087, 10018, 10204], min: 10018, median: 10204, max: 10438 } },
    },
};
const PROV = {
    date: '2026-10-21T00:00:00.000Z', gitHead: 'abc', gitDirty: [], node: 'v26.8.2', v8: '14', cpu: 'Apple M4 Pro', host: 'h',
    loadavgBefore: [1, 1, 1], loadavgAfterTimed: [2, 2, 2], loadavgAfter: [3, 3, 3], busyNodeBefore: [], seconds: 900,
    timing: 'timed under quiet-lock, sequential children, one kernel at a time (REPORTED tier; decides no gate)', pinnedSha256: {},
};
const kern = (tp, w) => ({ kernel: 'k', knownAs: 'k', files: [], full: LANE_COUNTS(w), smoke: LANE_COUNTS(1), throughput: tp });
// the shape of the committed soak-calibration.json (an --import-throughput run): PENDING cells + throughputRun
const chained = () => ({
    provenance: { ...PROV, timing: 'PENDING (untimed run; throughput decides no gate)' },
    kernels: { headpatched: kern({ GRAPH: 'PENDING' }, 5), tree: kern({ WIE: 'PENDING' }, 5) },
    throughputRun: JSON.parse(JSON.stringify(RUN)),
});
const timedDoc = () => ({
    provenance: PROV,
    kernels: {
        headpatched: kern({ GRAPH: { opsPerSecPerCycle: [30, 10, 20, 40], min: 10, median: 30, max: 40 } }, 5),
        old: kern({ GRAPH: [{ opsPerSec: 7 }, { opsPerSec: 3 }, { opsPerSec: 5 }] }, 5),
    },
});
const throwsIT = (doc, re) => assert.throws(() => importThroughput(doc), (e) => e instanceof Error && re.test(e.message));

test('I1 chained input (PENDING cells + throughputRun) -> old.throughputRun verbatim, its own provenance', () => {
    // HEAD: TypeError (cannot read 'slice' of undefined) on the first PENDING cell
    const doc = chained();
    const want = JSON.stringify(doc.throughputRun);
    const r = importThroughput(doc);
    assert.equal(JSON.stringify(r), want);
    assert.equal(r.date, RUN.date);
    assert.equal(r.gitHead, RUN.gitHead);
    assert.equal(r.timing, RUN.timing);
    assert.notEqual(r, doc.throughputRun);
    assert.equal(JSON.stringify(doc.throughputRun), want);
});

test('I2 timed input -> min / median / max per cell, provenance from old.provenance, field order fixed', () => {
    const r = importThroughput(timedDoc());
    assert.equal(JSON.stringify(r), JSON.stringify({
        note: RUN.note, date: PROV.date, gitHead: PROV.gitHead, node: PROV.node, cpu: PROV.cpu, loadavgBefore: PROV.loadavgBefore,
        loadavgAfter: PROV.loadavgAfter, busyNodeBefore: PROV.busyNodeBefore, seconds: PROV.seconds, timing: PROV.timing,
        perKernel: {
            headpatched: { GRAPH: { opsPerSecPerCycle: [30, 10, 20, 40], min: 10, median: 30, max: 40 } },
            old: { GRAPH: { opsPerSecPerCycle: [7, 3, 5], min: 3, median: 5, max: 7 } },
        },
    }));
});

test('I3 PENDING with no throughputRun (an untimed run) -> throws', () => {
    const doc = chained();
    delete doc.throughputRun;
    throwsIT(doc, /PENDING/);
    for (const tr of [null, {}, { ...RUN, perKernel: {} }, { ...RUN, perKernel: null }, 'PENDING']) {
        throwsIT({ ...chained(), throughputRun: tr }, /throughputRun/);
    }
});

test('I4 mixed or malformed shapes -> throws', () => {
    const mixed = timedDoc();
    mixed.kernels.old.throughput.NEST = 'PENDING';
    throwsIT(mixed, /mixed/);
    for (const cell of [null, 5, 'pending', {}, { opsPerSecPerCycle: [] }, { opsPerSecPerCycle: [1, null] }, { opsPerSecPerCycle: [1, -1] }, [{ opsPerSec: 'x' }], [], [null]]) {
        const d = timedDoc();
        d.kernels.headpatched.throughput.GRAPH = cell;
        throwsIT(d, /throughput/);
    }
    for (const doc of [null, [], {}, { kernels: {} }, { kernels: { a: null } }, { kernels: { a: { ...kern({}, 1) } } }]) throwsIT(doc, /kernel/);
    const noFull = timedDoc();
    delete noFull.kernels.old.full;
    throwsIT(noFull, /full, smoke/);
    const noProv = timedDoc();
    delete noProv.provenance;
    throwsIT(noProv, /provenance/);
    const badMedian = chained();
    badMedian.throughputRun.perKernel.headpatched.GRAPH.median = 1;
    throwsIT(badMedian, /not a timed cell/);
    const noDate = chained();
    delete noDate.throughputRun.date;
    throwsIT(noDate, /provenance/);
});

test('I5 importCountsSame: equal counts -> true; a count, a lane or a kernel missing -> false', () => {
    const old = chained();
    const same = { headpatched: kern({}, 5), tree: kern({}, 5), extra: kern({}, 9) };
    assert.equal(importCountsSame(old, same), true);
    assert.equal(importCountsSame(old, { ...same, tree: kern({}, 6) }), false);
    const noLane = { ...same, headpatched: { ...kern({}, 5), smoke: {} } };
    assert.equal(importCountsSame(old, noLane), false);
    assert.equal(importCountsSame(old, { headpatched: kern({}, 5) }), false);
    assert.equal(importCountsSame(old, null), false);
});

test('I6 write() checks the import before the sweep and dies on a count difference (static wiring)', () => {
    const src = readFileSync(CAL, 'utf8');
    const w = src.indexOf('async function write(');
    const it = src.indexOf('importRun = importThroughput(importOld)', w);
    assert.ok(w > 0 && it > w && it < src.indexOf('runChild(', w), 'importThroughput runs before the first child');
    assert.ok(src.includes('doc.throughputRun = importRun;\n'
        + "        if (!importCountsSame(importOld, kernels)) die('--import-throughput: the earlier run counted different numbers; it is not the same loop');"));
});

test('I7 --write dies fast (exit 2, no output file) on a bad --import-throughput file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cal-b92-'));
    const pending = chained();
    delete pending.throughputRun;
    writeFileSync(join(dir, 'pending.json'), JSON.stringify(pending));
    writeFileSync(join(dir, 'junk.json'), '{not json');
    for (const [f, re] of [['pending.json', /PENDING/], ['junk.json', /not JSON/], ['absent.json', /unreadable/]]) {
        const out = join(dir, 'out-' + f);
        const r = spawnSync(process.execPath, [CAL, '--write', out, '--import-throughput', join(dir, f)], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
        assert.equal(r.status, 2, f + ' exit ' + r.status + ' ' + (r.stderr || '').slice(0, 400));
        assert.match(r.stderr, re, f);
        assert.equal(existsSync(out), false, f);
    }
});

test('I8 chained: throughputRun.perKernel must cover exactly old.kernels.*.throughput -> else throws', () => {
    const cell = { opsPerSecPerCycle: [1], min: 1, median: 1, max: 1 };
    for (const mut of [(d) => { d.throughputRun.perKernel.ghost = { GRAPH: cell }; }, (d) => { d.throughputRun.perKernel.tree.ZZZ = cell; },
        (d) => { delete d.throughputRun.perKernel.headpatched; }, (d) => { d.kernels.tree.throughput.NEST = 'PENDING'; }]) {
        const d = chained();
        mut(d);
        throwsIT(d, /cover exactly/);
    }
});

// ---- b118 FILLER 2a: busyNodeFrom (provenance.busyNodeBefore) -------------------------------------------------
// c3956e10 excluded only process.pid: the recut runs as `quiet-lock.mjs run -- node calibrate.mjs` (or under npm), so
// its own node launcher was reported as a busy OTHER node. Synthetic `ps -Ao pid=,ppid=,pcpu=,comm=` tables; self = 400.
const PS_ROW = (pid, ppid, pcpu, comm) => '  ' + pid + ' ' + ppid + '  ' + pcpu + ' ' + comm;
const PS_BASE = [
    PS_ROW(1, 0, '0.0', '/sbin/launchd'),
    PS_ROW(100, 1, '0.0', '/bin/zsh'),                    // the first non-node ancestor: the walk stops here
    PS_ROW(200, 100, '50.0', '/opt/homebrew/bin/node'),  // node grandparent (quiet-lock wrapper)
    PS_ROW(300, 200, '50.0', 'node'),                    // node parent (npm)
    PS_ROW(400, 300, '99.0', 'node'),                    // self
    PS_ROW(600, 1, '50.0', '/usr/local/bin/node'),       // unrelated busy node -> reported
    PS_ROW(700, 1, '5.0', 'node'),                       // unrelated node under the threshold
    PS_ROW(800, 1, '9,5', 'node'),                       // unparsable %CPU (comma locale) -> kept, fail closed
    PS_ROW(900, 1, '80.0', '/usr/bin/python3'),          // busy, not node
];

test('BN1 busyNodeFrom: self and its node launcher chain excluded; unrelated busy + unparsable %CPU reported', () => {
    // c3956e10 (self-only exclusion): also lists 200 and 300 -> red
    assert.equal(BUSY_NODE_PCT, 10);
    assert.deepEqual(busyNodeFrom(PS_BASE.join('\n') + '\n', 400, 300), ['600 50.0 /usr/local/bin/node', '800 9,5 node']);
    assert.deepEqual(busyNodeFrom('', 400, 300), []);
    for (const v of [undefined, null, 5]) assert.equal(busyNodeFrom(v, 400, 300), null, String(v));
});

test('BN2 busyNodeFrom: a busy node ABOVE the first non-node ancestor is still reported; a ppid cycle terminates', () => {
    const above = [PS_ROW(50, 1, '50.0', 'node')].concat(PS_BASE.map((l) => l.replace(/^ {2}100 1 /, '  100 50 ')));
    assert.equal(above.filter((l) => /^ {2}100 50 /.test(l)).length, 1, 'precondition: zsh 100 now sits under node 50');
    assert.deepEqual(busyNodeFrom(above.join('\n'), 400, 300), ['50 50.0 node', '600 50.0 /usr/local/bin/node', '800 9,5 node']);
    // the walk never loops: 300 <-> 200 parent cycle
    const cyc = PS_BASE.map((l) => l.replace(/^ {2}200 100 /, '  200 300 '));
    assert.equal(cyc.filter((l) => /^ {2}200 300 /.test(l)).length, 1, 'precondition: 200 and 300 are each other\'s parent');
    assert.deepEqual(busyNodeFrom(cyc.join('\n'), 400, 300), ['600 50.0 /usr/local/bin/node', '800 9,5 node']);
});
