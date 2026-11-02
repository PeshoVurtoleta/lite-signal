/**
 * test/99 -- R8 group C (C1): SNAPSHOT is rostered as lane 13 (burst 156, helper H). Written from the plan
 * (.handoff/PLAN-R8-snapshot.md CURRENT R8-1..R8-23, GROUP C task 6, ASSERTIONS 1, 4, 5) and the C0 / C1 evidence
 * (.handoff/r8-evidence/C0/README.txt (b) remap, C1/README.txt), NOT from copying a return value. Reference sources:
 *   - roster / index / span rows are literal plan values (14, 'SNAPSHOT', 13, span 14);
 *   - seedFor is re-derived with a local murmur3 fmix32 + the SEED_FORMULA text (seed 0 -> 0x9e3779b9);
 *   - the remap rows compare the 14-lane result with the 13-lane result (ROSTER minus SNAPSHOT) over the calibrate bases;
 *     the three cycle-0 diffs are the C0 (b) numbers (the 13-lane result is null at each); when the frozen 13-lane build
 *     (.handoff/r8-evidence/before-C-7548461, gitignored, absent on CI) is present, it is cross-checked too;
 *   - main rows: SOAK_LANES=SNAPSHOT --smoke seed 1 = 3 cycles x 45 worlds, snap-restore events 673 / 688 / 651 (2012),
 *     tracked === witnessed === worlds + events = 718 / 733 / 696 (C1 measured); child rows: default seed, 135 worlds, OS === events.
 * Every row fails on the pre-C1 tree EXCEPT three invariance rows that pin what R8 must not change (seedFor 0..13, remap at cycles 3 / 11, the 13-lane CONFIG control); the two frozen-build rows skip when the freeze is absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROSTER, LANE_INDEX, laneSpan, rosterRemapCollision } from '../bench/soak/lanes/index.mjs';
import { seedFor } from '../bench/soak/seeds.mjs';
import { COVOFF_SEEDS, SWEEP_SEEDS, summarize, foldMainRecords, runMainSmoke } from '../bench/soak/calibration/calibrate.mjs';
import { SKIP_NAMES } from '../bench/soak/exec.mjs';
import * as CFG from '../bench/soak/config.mjs';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HEAP = '--max-old-space-size=2048';   // CI heap is ~2 GB (b124)
const FROZEN = join(HERE, '.handoff', 'r8-evidence', 'before-C-7548461');
const LANES13 = ['GRAPH', 'BATCH', 'ERROR', 'NEST', 'WIE', 'HOOK', 'LIFECYCLE', 'OWNER', 'RECYCLE', 'SCHEDULER', 'REGISTRY', 'CAPACITY', 'BOX'];
const ROSTER13 = ROSTER.slice(0, 13);
const BASES = [CFG.DEFAULT_SEED].concat(SWEEP_SEEDS, COVOFF_SEEDS);
const SPAWN = { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 300000, killSignal: 'SIGKILL' };

// ---- 1. roster / index / span / seeds ----
test('R8 roster: 14 lanes, the first 13 unchanged, ROSTER[13] SNAPSHOT, LANE_INDEX.SNAPSHOT 13, laneSpan 14 (13-lane prefix span 13)', () => {
    assert.equal(ROSTER.length, 14);
    assert.deepEqual(ROSTER13, LANES13);
    assert.equal(ROSTER[13], 'SNAPSHOT');
    assert.equal(LANE_INDEX.SNAPSHOT, 13);
    assert.equal(laneSpan(ROSTER), 14);
    assert.equal(laneSpan(ROSTER13), 13);
});

test('R8 frozen 13-lane build (when present): its ROSTER equals ROSTER.slice(0, 13), span 13, seedFor identical for lane 0..13', { skip: !existsSync(FROZEN) && 'frozen build absent (gitignored .handoff)' }, async () => {
    const F = await import(pathToFileURL(join(FROZEN, 'bench/soak/lanes/index.mjs')).href);
    const FS = await import(pathToFileURL(join(FROZEN, 'bench/soak/seeds.mjs')).href);
    assert.deepEqual(F.ROSTER, ROSTER13);
    assert.equal(laneSpan(F.ROSTER), 13);
    for (const b of BASES) for (let i = 0; i <= 13; i++) for (let c = 0; c <= 10; c++) assert.equal(seedFor(b, i, c), FS.seedFor(b, i, c));
});

test('R8 seedFor(s, i, c) is fmix32((base ^ ((c << 4) | i)) >>> 0) (0 -> 0x9e3779b9) for lane index 0..13', () => {
    const fmix = (h) => {
        h >>>= 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0;
    };
    let n = 0;
    for (const b of [0xC0FFEE, 1, 0x9e3779b9, 0x1715609d, 0xd]) for (let i = 0; i <= 13; i++) for (const c of [0, 1, 2, 10]) {
        const s = fmix((b ^ ((c << 4) | i)) >>> 0);
        assert.equal(seedFor(b, i, c), s === 0 ? 0x9e3779b9 : s);
        n++;
    }
    assert.equal(n, 5 * 14 * 4);
});

// ---- 2. remap ----
test('R8 remap: rosterRemapCollision(14 lanes) deepEquals the 13-lane result at cycles 3 and 11 on every calibrate base', () => {
    for (const b of BASES) for (const c of [3, 11]) {
        assert.deepEqual(rosterRemapCollision(b, ROSTER, c), rosterRemapCollision(b, ROSTER13, c));
    }
});

test('R8 remap forever (cycles 0): exactly the C0 (b) diffs, full list pinned (13 lanes: null at each)', () => {
    const diff = [];
    for (let k = 0; k < BASES.length; k++) {
        const a = rosterRemapCollision(BASES[k], ROSTER, 0);
        const o = rosterRemapCollision(BASES[k], ROSTER13, 0);
        if (JSON.stringify(a) !== JSON.stringify(o)) diff.push({ base: BASES[k], a, o });
    }
    // SWEEP_SEEDS[4] and COVOFF_SEEDS[5] are the same base value 0x1715609d; COVOFF_SEEDS[11] is 0xd
    assert.equal(SWEEP_SEEDS[4], 0x1715609d); assert.equal(COVOFF_SEEDS[5], 0x1715609d); assert.equal(COVOFF_SEEDS[11], 0xd);
    assert.deepEqual(diff, [
        { base: 0x1715609d, a: { cycleA: 24204809, laneA: 13, cycleB: 31332766, laneB: 5 }, o: null },
        { base: 0x1715609d, a: { cycleA: 24204809, laneA: 13, cycleB: 31332766, laneB: 5 }, o: null },
        { base: 0xd, a: { cycleA: 0, laneA: 13, cycleB: 11489175, laneB: 5 }, o: null },
    ]);
});

test('R8 remap vs frozen 13-lane build (when present): identical at cycles 3 / 11, same diff at 0', { skip: !existsSync(FROZEN) && 'frozen build absent (gitignored .handoff)' }, async () => {
    const F = await import(pathToFileURL(join(FROZEN, 'bench/soak/lanes/index.mjs')).href);
    for (const b of BASES) {
        for (const c of [3, 11]) assert.deepEqual(rosterRemapCollision(b, ROSTER, c), F.rosterRemapCollision(b, F.ROSTER, c));
        assert.deepEqual(F.rosterRemapCollision(b, F.ROSTER, 0), rosterRemapCollision(b, ROSTER13, 0));
    }
});

// ---- 3. import cycle: both orders (b139) ----
const loadOrder = (first, second) => {
    const code = "await import('" + first + "'); await import('" + second + "'); " +
        "const I = await import('./bench/soak/lanes/index.mjs'); " +
        "const D = await import('./bench/soak/divergences.mjs'); " +
        "process.stdout.write(JSON.stringify([I.ROSTER.length, I.ROSTER[13], I.LANE_INDEX.SNAPSHOT, typeof D]));";
    return spawnSync(process.execPath, [HEAP, '--input-type=module', '-e', code], Object.assign({ cwd: HERE }, SPAWN));
};
test('import cycle: divergences.mjs first, then lanes/index.mjs -> loads, 14 lanes', () => {
    const r = loadOrder('./bench/soak/divergences.mjs', './bench/soak/lanes/index.mjs');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '[14,"SNAPSHOT",13,"object"]');
});
test('import cycle: lanes/index.mjs first, then divergences.mjs -> loads, 14 lanes', () => {
    const r = loadOrder('./bench/soak/lanes/index.mjs', './bench/soak/divergences.mjs');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '[14,"SNAPSHOT",13,"object"]');
});

// ---- 4. child fold == main fold ----
test('child SNAPSHOT smoke fold (3 x 20000) equals the main --smoke fold; OS === snap-restore events in both', async () => {
    const r = spawnSync(process.execPath, [HEAP, '--expose-gc', join(HERE, 'bench/soak/calibration/calibrate.mjs'), '--child', '--kernel', 'Signal.js', '--lanes', 'SNAPSHOT', '--cycles', '3', '--ops', '20000'],
        { cwd: HERE, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 300000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    const L = res.lanes.SNAPSHOT;
    assert.equal(L.index, 13);
    assert.deepEqual(L.oracles, ['OS']);
    for (const c of L.perCycle) { assert.equal(c.worlds, 45); assert.equal(c.checks.OS, c.scenarios['snap-restore']); assert.equal(c.failingWorlds, 0); }
    const child = summarize(res, SKIP_NAMES).smoke.SNAPSHOT;
    const m = await runMainSmoke(join(HERE, 'Signal.js'), ['SNAPSHOT']);
    assert.equal(m.status, 0);
    const recs = m.recs.filter((x) => x.lane === 'SNAPSHOT' && typeof x.worlds === 'number' && x.checks !== undefined);
    assert.equal(recs.length, 3);
    for (const x of recs) assert.equal(x.checks.OS, x.scenarios['snap-restore']);
    assert.deepEqual(child, foldMainRecords(L, recs, SKIP_NAMES));
    assert.equal(child.worlds, 135);
    assert.equal(child.failingWorlds, 0);
    assert.equal(child.performed.OS, child.scenarios['snap-restore']);
    assert.ok(child.performed.OS >= CFG.SNAP_FLOOR_SMOKE);
});

// ---- 5. main SOAK_LANES=SNAPSHOT --smoke seed 1 (run once, shared; a thrown error is cached too) ----
function cleanEnv(extra) {
    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    return Object.assign(env, extra);
}
function runMain(mainPath, cwd, envExtra) {
    const dir = mkdtempSync(join(tmpdir(), 'soak99-'));
    const out = join(dir, 'smoke.jsonl');
    try {
        const r = spawnSync(process.execPath, [HEAP, '--expose-gc', mainPath, '--smoke'], Object.assign({ cwd, env: cleanEnv(Object.assign({ SOAK_OUT: out }, envExtra)) }, SPAWN));
        let recs = [];
        try { recs = readFileSync(out, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)); } catch (e) { /* no stream: status says why */ }
        return { status: r.status, stderr: r.stderr, stdout: r.stdout, recs };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
let MAIN = null;
function mainSmoke() {
    if (MAIN === null) {
        try { MAIN = { ok: runMain(join(HERE, 'bench/soak/main.mjs'), HERE, { SOAK_LANES: 'SNAPSHOT', SOAK_SEED: '1' }) }; } catch (e) { MAIN = { err: e }; }
    }
    if (MAIN.err) throw MAIN.err;
    return MAIN.ok;
}
const boundariesOf = (recs) => recs.filter((x) => x.boundary !== undefined && x.boundary !== null).map((x) => x.boundary);

test('main SNAPSHOT --smoke seed 1: exit 0, verdict SMOKE, no UNMEASURED / BREACH / INCONCLUSIVE line', () => {
    const m = mainSmoke();
    assert.equal(m.status, 0, m.stderr);
    assert.equal(/UNMEASURED|BREACH|INCONCLUSIVE/.test(m.stderr), false, m.stderr);
    assert.match(m.stderr + m.stdout, /soak: END verdict=SMOKE exit=0 /);
});
test('main SNAPSHOT --smoke seed 1: 3 cycles x 45 worlds, checks.OS === snap-restore events (673 / 688 / 651 = 2012) >= SNAP_FLOOR_SMOKE, 0 failing', () => {
    const c = mainSmoke().recs.filter((x) => x.lane === 'SNAPSHOT' && typeof x.worlds === 'number' && x.checks !== undefined);
    assert.deepEqual(c.map((x) => x.cycle), [0, 1, 2]);
    assert.deepEqual(c.map((x) => x.worlds), [45, 45, 45]);
    assert.deepEqual(c.map((x) => x.scenarios['snap-restore']), [673, 688, 651]);
    assert.deepEqual(c.map((x) => x.checks.OS), [673, 688, 651]);
    assert.deepEqual(c.map((x) => x.failingWorlds), [0, 0, 0]);
    assert.ok(673 + 688 + 651 >= CFG.SNAP_FLOOR_SMOKE);
});
test('main SNAPSHOT --smoke seed 1: every boundary MEASURED: tracked === witnessed === worlds + events (718 / 733 / 696), trackerSize 0, weakAlive 0', () => {
    const bs = boundariesOf(mainSmoke().recs);
    assert.equal(bs.length, 3);
    assert.deepEqual(bs.map((b) => [b.lane, b.worlds, b.tracked, b.witnessed, b.trackerSize, b.weakAlive]),
        [['SNAPSHOT', 45, 718, 718, 0, 0], ['SNAPSHOT', 45, 733, 733, 0, 0], ['SNAPSHOT', 45, 696, 696, 0, 0]]);
});

// ---- 6. CONFIG: a kernel without snapshot cannot run the full roster ----
const K_152 = join(HERE, 'node_modules', 'lite-signal-1.5.2', 'Signal.js');
test('CONFIG: the 1.5.2 kernel (no snapshot) on the FULL roster -> exit 2, `must SKIP nothing` naming SNAPSHOT, never PARTIAL', () => {
    const r = runMain(join(HERE, 'bench/soak/main.mjs'), HERE, { SOAK_KERNEL: K_152 });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /soak: CONFIG -- engine lite must SKIP nothing \(roster bug\): SNAPSHOT\n/);
    assert.equal(/PARTIAL/.test(r.stderr + r.stdout), false);
});
test('CONFIG: the same kernel with SOAK_LANES = the other 13 does not hit the refusal (killed once the run is under way)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak99-c-'));
    try {
        const child = spawn(process.execPath, [HEAP, '--expose-gc', join(HERE, 'bench/soak/main.mjs'), '--smoke'],
            { cwd: HERE, env: cleanEnv({ SOAK_KERNEL: K_152, SOAK_LANES: LANES13.join(','), SOAK_OUT: join(dir, 'o.jsonl') }), stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '', done = false;
        const verdict = await new Promise((res) => {
            const bail = setTimeout(() => { child.kill('SIGKILL'); res('timeout'); }, 120000);
            child.on('exit', (code) => { clearTimeout(bail); res('exit ' + code); });
            child.stderr.on('data', (d) => {
                err += d;
                // the roster check precedes any lane run: a BREACH / NOTE line proves it passed
                if (!done && /soak: (NOTE|BREACH)/.test(err)) { done = true; clearTimeout(bail); child.kill('SIGKILL'); res('running'); }
                if (/soak: CONFIG/.test(err)) { done = true; clearTimeout(bail); child.kill('SIGKILL'); res('config'); }
            });
        });
        assert.equal(verdict, 'running', err.slice(0, 500));
        assert.equal(/must SKIP nothing|soak: CONFIG/.test(err), false, err.slice(0, 500));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 7. retention tooth: opensOf blind to restore opens -> UNMEASURED + retention FAIL ----
test('tooth: a scratch main.mjs whose opensOf ignores restore opens -> UNMEASURED boundaries + BREACH gate=retention lane=SNAPSHOT, exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak99-t-'));
    try {
        mkdirSync(join(dir, 'bench', 'torture'), { recursive: true });
        cpSync(join(HERE, 'bench', 'soak'), join(dir, 'bench', 'soak'), { recursive: true, filter: (p) => !/[\\/](out|replay\.mjs|shrink\.mjs)$/.test(p) });
        cpSync(join(HERE, 'bench', 'torture', 'helpers'), join(dir, 'bench', 'torture', 'helpers'), { recursive: true });
        mkdirSync(join(dir, 'harness'), { recursive: true });
        copyFileSync(join(HERE, 'harness', 'visit-anchors.mjs'), join(dir, 'harness', 'visit-anchors.mjs'));
        copyFileSync(join(HERE, 'Signal.js'), join(dir, 'Signal.js'));
        copyFileSync(join(HERE, 'Watch.js'), join(dir, 'Watch.js'));
        symlinkSync(join(HERE, 'node_modules'), join(dir, 'node_modules'));
        const cli = join(dir, 'bench', 'soak', 'main.mjs');
        const find = "if (!Object.prototype.hasOwnProperty.call(sc, 'snap-restore')) return n;";
        const src = readFileSync(cli, 'utf8');
        assert.equal(src.split(find).length, 2, 'the patch anchor occurs exactly once: ' + find);
        writeFileSync(cli, src.replace(find, 'return n;'));
        const r = runMain(cli, dir, { SOAK_LANES: 'SNAPSHOT', SOAK_SEED: '1' });
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, /UNMEASURED/);
        assert.match(r.stderr, /^soak: BREACH gate=retention lane=SNAPSHOT /m);
        assert.deepEqual(boundariesOf(r.recs).map((b) => [b.tracked, b.trackerSize, b.weakAlive]), [[718, null, null], [733, null, null], [696, null, null]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- 8. retention tooth 2 (ASSERTION 4, second clause): a retained swapped-out world -> trackerSize / weakAlive 1, BREACH gate=retention ----
function execTooth(replacement) {
    const dir = mkdtempSync(join(tmpdir(), 'soak99-e-'));
    try {
        mkdirSync(join(dir, 'bench', 'torture'), { recursive: true });
        cpSync(join(HERE, 'bench', 'soak'), join(dir, 'bench', 'soak'), { recursive: true, filter: (p) => !/[\\/](out|replay\.mjs|shrink\.mjs)$/.test(p) });
        cpSync(join(HERE, 'bench', 'torture', 'helpers'), join(dir, 'bench', 'torture', 'helpers'), { recursive: true });
        mkdirSync(join(dir, 'harness'), { recursive: true });
        copyFileSync(join(HERE, 'harness', 'visit-anchors.mjs'), join(dir, 'harness', 'visit-anchors.mjs'));
        copyFileSync(join(HERE, 'Signal.js'), join(dir, 'Signal.js'));
        copyFileSync(join(HERE, 'Watch.js'), join(dir, 'Watch.js'));
        symlinkSync(join(HERE, 'node_modules'), join(dir, 'node_modules'));
        const ex = join(dir, 'bench', 'soak', 'exec.mjs');
        const find = '        const old = this.W;\n';
        const src = readFileSync(ex, 'utf8');
        assert.equal(src.split(find).length, 2, 'the patch anchor occurs exactly once: ' + find);
        writeFileSync(ex, src.replace(find, () => replacement(find)));
        return runMain(join(dir, 'bench', 'soak', 'main.mjs'), dir, { SOAK_LANES: 'SNAPSHOT', SOAK_SEED: '1' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('tooth: exec.mjs keeps the last swapped-out world (globalThis.__kept) -> MEASURED, trackerSize 1 / weakAlive 1 per boundary, BREACH gate=retention, exit 1', () => {
    const r = execTooth((find) => '        const old = this.W; globalThis.__kept = old;\n');
    assert.equal(r.status, 1, r.stderr);
    assert.equal(/UNMEASURED/.test(r.stderr), false, r.stderr);
    assert.match(r.stderr, /^soak: BREACH gate=retention lane=SNAPSHOT detail=badBoundaries=2 \(limit 2\) unmeasured=0$/m);
    assert.deepEqual(boundariesOf(r.recs).map((b) => [b.tracked, b.trackerSize, b.weakAlive]), [[718, 1, 1], [733, 1, 1], [696, 1, 1]]);
});
