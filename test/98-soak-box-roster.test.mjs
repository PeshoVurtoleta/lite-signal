/**
 * test/98 -- R7 group C (C1 part): BOX is rostered (burst 151, helper H). Written from the plan
 * (.handoff/PLAN-R7-box.md: CURRENT C-31, C-35, C-37, C-38, C-39; ASSERTIONS C-A1, C-A4) and the C1 reviewer mutants m3 / m6
 * (.handoff/r7-evidence/C1/README.txt), NOT from copying a return value. Reference sources:
 *   - the roster / index rows are literal plan values (13, 'BOX', 9, span 13);
 *   - seedFor is re-derived with a local murmur3 fmix32 + the SEED_FORMULA text (seed 0 -> 0x9e3779b9);
 *   - the remap rows compare the 13-lane result with the 12-lane result (ROSTER minus BOX) over the 25 base entries of
 *     COVOFF_SEEDS + SWEEP_SEEDS; the three cycle-0 collisions are the plan's C-31 / C-37 numbers;
 *   - the main / child rows are probed values (b151 probe, tree Signal.js ea0b64d1): BOX --smoke = 3 cycles of
 *     51 / 49 / 50 worlds (150), OT performed === worlds, failing 9 / 3 / 8, every BREACH O6 DIV-F22; child
 *     `--cycles 1 --ops 1000` = 3 worlds, 1099 ops, OT 3, box-trace-equal 3, box-interop 9306.
 * Every row fails on the pre-C1 tree (no BOX in ROSTER / CHECK_NAMES, no OT, no twin in the child / dev driver).
 * Env SOAK98_ROOT (default: this repo) points the CHILD-PROCESS rows at another bench copy: that is how the teeth
 * (a deliberately broken scratch copy) are shown; the in-process rows always use this tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROSTER, LANE_INDEX, laneSpan, rosterRemapCollision } from '../bench/soak/lanes/index.mjs';
import { seedFor } from '../bench/soak/seeds.mjs';
import { COVOFF_SEEDS, SWEEP_SEEDS, summarize, foldMainRecords, runMainSmoke } from '../bench/soak/calibration/calibrate.mjs';
import { SKIP_NAMES } from '../bench/soak/exec.mjs';

const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = process.env.SOAK98_ROOT ? resolve(process.env.SOAK98_ROOT) : HERE;
const HEAP = '--max-old-space-size=2048';   // CI heap is ~2 GB (b124)
const BASES = COVOFF_SEEDS.concat(SWEEP_SEEDS);
const ROSTER12 = ROSTER.slice(0, 12);
const ROSTER13 = ROSTER.slice(0, 13);   // R8 C2b: the pre-SNAPSHOT roster (the old 13-lane prefix)

// ---- 1. C-A1 roster / index / span / seeds ----
test('C-A1: ROSTER has 14 lanes, ROSTER[12] is BOX, ROSTER[13] is SNAPSHOT, LANE_INDEX.BOX is 9, LANE_INDEX.SNAPSHOT 13, laneSpan 14 (13- and 12-lane span 13)', () => {
    assert.equal(ROSTER.length, 14);
    assert.equal(ROSTER[12], 'BOX');
    assert.equal(ROSTER[13], 'SNAPSHOT');
    assert.equal(LANE_INDEX.BOX, 9);
    assert.equal(LANE_INDEX.SNAPSHOT, 13);
    assert.equal(laneSpan(ROSTER), 14);     // R8: SNAPSHOT (index 13) is the max index + 1
    assert.equal(laneSpan(ROSTER13), 13);
    assert.equal(laneSpan(ROSTER12), 13);   // C-37: laneSpan 13 for both old rosters
    assert.equal(ROSTER12.includes('BOX'), false);
    assert.equal(ROSTER13.includes('SNAPSHOT'), false);
});

test('C-A1: seedFor(s, i, c) is fmix32((base ^ ((c << 4) | i)) >>> 0) (0 -> 0x9e3779b9) for lane index 0..13', () => {
    const fmix = (h) => {
        h >>>= 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0;
    };
    let n = 0;
    for (const b of [0xC0FFEE, 1, 0x9e3779b9]) for (let i = 0; i <= 13; i++) for (const c of [0, 1, 2, 10]) {
        const s = fmix((b ^ ((c << 4) | i)) >>> 0);
        assert.equal(seedFor(b, i, c), s === 0 ? 0x9e3779b9 : s);
        n++;
    }
    assert.equal(n, 3 * 14 * 4);
});

// ---- 2. C-31 / C-37 remap ----
test('C-31: rosterRemapCollision(13 lanes) deepEquals the 12-lane result at cycles 3 and 11 on all 25 base entries', () => {
    assert.equal(BASES.length, 25);
    for (const b of BASES) for (const c of [3, 11]) {
        assert.deepEqual(rosterRemapCollision(b, ROSTER13, c), rosterRemapCollision(b, ROSTER12, c));
    }
});

// R8 C2b (C0 evidence (b)): the 14-lane roster equals the old 13-lane prefix at cycles 3 and 11 on all 27 base entries
// (the BASES here are 25 values in this file's enumeration; C0 counted 27 cells over its own seed lists)
test('R8 C-31: rosterRemapCollision(14 lanes) deepEquals the 13-lane result at cycles 3 and 11 on every base entry', () => {
    for (const b of BASES) for (const c of [3, 11]) {
        assert.deepEqual(rosterRemapCollision(b, ROSTER, c), rosterRemapCollision(b, ROSTER13, c));
    }
});

test('C-31/C-37 forever (cycles 0): exactly 3 base entries differ from the 12-lane result, and they are the pinned BOX collisions', () => {
    const diff = [];
    for (let k = 0; k < BASES.length; k++) {
        const b = BASES[k];
        const a = rosterRemapCollision(b, ROSTER13, 0);
        const o = rosterRemapCollision(b, ROSTER12, 0);
        if (JSON.stringify(a) !== JSON.stringify(o)) diff.push({ k, b, a, o });
    }
    assert.equal(diff.length, 3);
    // 0x9e3779b9 is COVOFF_SEEDS[1] AND SWEEP_SEEDS[0] (two entries, one value); 0x11 is COVOFF_SEEDS[15]
    assert.deepEqual(diff.map((d) => d.b), [0x9e3779b9, 0x11, 0x9e3779b9]);
    assert.equal(COVOFF_SEEDS[1], 0x9e3779b9); assert.equal(COVOFF_SEEDS[15], 0x11); assert.equal(SWEEP_SEEDS[0], 0x9e3779b9);
    for (const d of diff) assert.equal(d.o, null);   // 12 lanes: no collision
    assert.deepEqual(diff[0].a, { cycleA: 165902235, laneA: 9, cycleB: 155990028, laneB: 1 });
    assert.deepEqual(diff[2].a, diff[0].a);
    assert.deepEqual(diff[1].a, { cycleA: 1, laneA: 1, cycleB: 11489174, laneB: 9 });
});

// R8 C2b (C0 evidence (b)): SNAPSHOT (index 13) pairs with LIFECYCLE (index 5) at cycles 0; the values below were probed with
// rosterRemapCollision over this file's 25 BASES (COVOFF_SEEDS ++ SWEEP_SEEDS) and match C0: 3 entries differ from the 13-lane
// result (SWEEP_SEEDS[4] and COVOFF_SEEDS[5] are one value 0x1715609d; COVOFF_SEEDS[11] is 0xd). The 13-lane result is null there.
test('R8 C-31 forever (cycles 0): exactly 3 base entries differ from the 13-lane result, and they are the pinned SNAPSHOT(13) vs LIFECYCLE(5) collisions', () => {
    const diff = [];
    for (let k = 0; k < BASES.length; k++) {
        const b = BASES[k];
        const a = rosterRemapCollision(b, ROSTER, 0);
        const o = rosterRemapCollision(b, ROSTER13, 0);
        if (JSON.stringify(a) !== JSON.stringify(o)) diff.push({ k, b, a, o });
    }
    assert.equal(diff.length, 3);
    assert.deepEqual(diff.map((d) => d.b), [0x1715609d, 0xd, 0x1715609d]);
    assert.equal(COVOFF_SEEDS[5], 0x1715609d); assert.equal(COVOFF_SEEDS[11], 0xd); assert.equal(SWEEP_SEEDS[4], 0x1715609d);
    for (const d of diff) assert.equal(d.o, null);   // 13 lanes: no collision
    assert.deepEqual(diff[0].a, { cycleA: 24204809, laneA: 13, cycleB: 31332766, laneB: 5 });
    assert.deepEqual(diff[2].a, diff[0].a);
    assert.deepEqual(diff[1].a, { cycleA: 0, laneA: 13, cycleB: 11489175, laneB: 5 });
});

// ---- 3. import cycle: both orders (b139 TDZ lesson) ----
const loadOrder = (first, second) => {
    const code = "await import('" + first + "'); await import('" + second + "'); " +
        "const I = await import('./bench/soak/lanes/index.mjs'); " +
        "const D = await import('./bench/soak/divergences.mjs'); " +
        "process.stdout.write(JSON.stringify([I.ROSTER.length, I.ROSTER[13], I.LANE_INDEX.SNAPSHOT, typeof D]));";
    return spawnSync(process.execPath, [HEAP, '--input-type=module', '-e', code], { cwd: HERE, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
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

// ---- 4. m3: calibrate child runs the TWIN ----
const childRun = (cycles, ops) => {
    const r = spawnSync(process.execPath, [HEAP, join(ROOT, 'bench/soak/calibration/calibrate.mjs'), '--child', '--kernel', 'Signal.js', '--lanes', 'BOX', '--cycles', String(cycles), '--ops', String(ops)],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
};
test('m3: calibrate child `--cycles 1 --ops 1000` on Signal.js, lane BOX: 3 worlds, OT === worlds === 3, box-trace-equal 3, ops 1099', () => {
    const res = childRun(1, 1000);
    const L = res.lanes.BOX;
    assert.equal(L.index, 9);
    assert.deepEqual(L.oracles, ['OT']);
    const c = L.perCycle[0];
    assert.equal(c.worlds, 3);
    assert.equal(c.checks.OT, c.worlds);   // the twin really ran: a plain runWorld child leaves OT at 0
    assert.equal(c.checks.OT, 3);
    assert.equal(c.scenarios['box-trace-equal'], 3);
    assert.equal(c.scenarios['box-interop'], 9306);
    assert.equal(c.ops, 1099);
    assert.equal(c.failingWorlds, 1);
});

test('m3 / C-A2: child BOX smoke fold (cycles 3 x 20000) equals the main --smoke fold: 150 worlds, OT 150, failing 20', async () => {
    const res = childRun(3, 20000);
    for (const c of res.lanes.BOX.perCycle) assert.equal(c.checks.OT, c.worlds);
    assert.deepEqual(res.lanes.BOX.perCycle.map((c) => c.worlds), [51, 49, 50]);
    const child = summarize(res, SKIP_NAMES).smoke.BOX;
    const m = await runMainSmoke(join(ROOT, 'Signal.js'), ['BOX']);
    assert.equal(m.status, 1);   // DIV-F22 BREACH only
    const recs = m.recs.filter((r) => r.lane === 'BOX' && typeof r.worlds === 'number' && r.checks !== undefined);
    assert.equal(recs.length, 3);
    const mainFold = foldMainRecords(res.lanes.BOX, recs, SKIP_NAMES);
    assert.deepEqual(child, mainFold);
    assert.equal(child.worlds, 150);
    assert.equal(child.performed.OT, 150);
    assert.equal(child.failingWorlds, 20);
});

// ---- 5. m6: _dev-run drives the twin ----
test('m6: _dev-run.mjs Signal.js BOX 3 -> twin ran: checks performed OT === 3 === worlds, 1 failing world O6 DIV-F22 shape', () => {
    const r = spawnSync(process.execPath, [HEAP, '--expose-gc', join(ROOT, 'bench/soak/_dev-run.mjs'), 'Signal.js', 'BOX', '3'], { cwd: ROOT, timeout: 300000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 1, r.stderr);   // exit 1 = a failing world (DIV-F22)
    const w = /worlds=(\d+) /.exec(r.stdout);
    assert.equal(Number(w[1]), 3);
    const checks = JSON.parse(/checks performed (\{.*\})/.exec(r.stdout)[1]);
    assert.equal(checks.OT, 3);
    assert.equal(checks.OT, Number(w[1]));
    assert.match(r.stdout, /failingWorlds=1 /);
    assert.match(r.stdout, /FAIL +1 +O6:expected-escape-missing/);
});

// ---- 6. C-A4 + C-38/C-39: main SOAK_LANES=BOX --smoke on the tree ----
let MAIN = null;
function mainSmoke(envExtra) {
    if (envExtra === undefined && MAIN !== null) return MAIN;
    const dir = mkdtempSync(join(tmpdir(), 'soak98-'));
    const out = join(dir, 'smoke.jsonl');
    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    env.SOAK_LANES = 'BOX'; env.SOAK_OUT = out;
    if (envExtra !== undefined) for (const k of Object.keys(envExtra)) env[k] = envExtra[k];
    let r, recs;
    try {
        // bounded: SIGKILL (main.mjs traps SIGTERM), so a hung child fails this row (status null, JSONL absent
        // or partial) instead of hanging the suite
        r = spawnSync(process.execPath, [HEAP, '--expose-gc', join(HERE, 'bench/soak/main.mjs'), '--smoke'], { cwd: HERE, env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 300000, killSignal: 'SIGKILL' });
        recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    const res = { status: r.status, stderr: r.stderr, stdout: r.stdout, recs, cyc: recs.filter((x) => x.lane === 'BOX' && typeof x.worlds === 'number' && x.checks !== undefined) };
    if (envExtra === undefined) MAIN = res;
    return res;
}
test('C-38/C-39 per-world floor: BOX --smoke prints no INCONCLUSIVE line; its only BREACH lines are known=DIV-F22; verdict FAIL exit 1', () => {
    const m = mainSmoke();
    assert.equal(m.status, 1);
    assert.equal(/INCONCLUSIVE/.test(m.stderr), false, m.stderr);
    const breaches = m.stderr.split('\n').filter((l) => l.indexOf('soak: BREACH') === 0);
    assert.equal(breaches.length, 1);   // probed: one O6 line (first-seen, deduped by noteWorld)
    for (const l of breaches) { assert.match(l, / oracle=O6 lane=BOX sig=expected-escape-missing known=DIV-F22 /); }
    assert.match(m.stderr + m.stdout, /soak: END verdict=FAIL exit=1 /);
});
test('C-A2/C-39: BOX smoke cycles are 51 / 49 / 50 worlds (150 >= BOX_WORLD_FLOOR_SMOKE 70), OT === worlds each, failing 9 / 3 / 8', () => {
    const c = mainSmoke().cyc;
    assert.deepEqual(c.map((x) => x.worlds), [51, 49, 50]);
    assert.deepEqual(c.map((x) => x.checks.OT), [51, 49, 50]);
    assert.deepEqual(c.map((x) => x.failingWorlds), [9, 3, 8]);
    assert.deepEqual(c.map((x) => x.cycle), [0, 1, 2]);
});
test('C-A4/C-35: every BOX boundary is MEASURED (no UNMEASURED NOTE), tracked === witnessed === worlds, trackerSize 0, weakAlive 0', () => {
    const m = mainSmoke();
    assert.equal(/UNMEASURED/.test(m.stderr), false, m.stderr);   // unmeasured iff tracked/witnessed/twinTracked/twinWitnessed !== opens
    const bs = m.recs.filter((x) => x.boundary !== undefined && x.boundary !== null).map((x) => x.boundary);
    assert.equal(bs.length, 3);
    const worlds = [51, 49, 50];
    bs.forEach((b, i) => {
        assert.equal(b.lane, 'BOX');
        assert.equal(b.worlds, worlds[i]);
        assert.equal(b.tracked, worlds[i]);
        assert.equal(b.witnessed, worlds[i]);
        assert.equal(b.trackerSize, 0);   // null would be UNMEASURED
        assert.equal(b.weakAlive, 0);
    });
    assert.equal(/HEARTBEAT lane=BOX cycle=2 worlds=50 .* trackerSize=0 weakAlive=0 /.test(m.stderr + m.stdout), true);
});

// ---- 7. C-A4/C-35 teeth (b152, Review B): the twin bookkeeping must be MEASURED, not merely absent-of-NOTE ----
const boundariesOf = (recs) => recs.filter((x) => x.boundary !== undefined && x.boundary !== null).map((x) => x.boundary);
test('C-A4/C-35 tooth (M7: opensOf always 1): SOAK_MUSTFAIL=box-untracked still measures every boundary, no UNMEASURED, exact tuples', () => {
    const m = mainSmoke({ SOAK_MUSTFAIL: 'box-untracked' });
    assert.equal(/UNMEASURED/.test(m.stderr), false, m.stderr);
    const bs = boundariesOf(m.recs);
    assert.deepEqual(bs.map((b) => [b.worlds, b.tracked, b.witnessed, b.trackerSize, b.weakAlive]),
        [[51, 102, 102, 0, 0], [49, 98, 98, 0, 0], [50, 100, 100, 0, 0]]);   // twin re-runs double the opens (reviewer-measured on head)
});
test('C-A4/C-35 tooth (M6: twin witness concat dropped): a retained twin registry shows weakAlive 51/49/50 and trackerSize 51/100/150, BREACH gate=retention', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak98-m6-'));
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
        const find = 'tap.witness.push(new WeakRef(reg));';
        const src = readFileSync(cli, 'utf8');
        assert.equal(src.split(find).length, 2, 'the patch anchor occurs exactly once: ' + find);
        writeFileSync(cli, src.replace(find, find + ' (globalThis.__tleak ||= []).push(reg);'));
        const out = join(dir, 'smoke.jsonl');
        const env = {};
        for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
        env.SOAK_LANES = 'BOX'; env.SOAK_OUT = out;
        const r = spawnSync(process.execPath, [HEAP, '--expose-gc', cli, '--smoke'], { cwd: dir, env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 300000, killSignal: 'SIGKILL' });
        const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const bs = boundariesOf(recs);
        assert.deepEqual(bs.map((b) => [b.worlds, b.weakAlive, b.trackerSize]), [[51, 51, 51], [49, 49, 100], [50, 50, 150]], r.stderr);
        assert.match(r.stderr, /^soak: BREACH gate=retention lane=BOX /m);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
