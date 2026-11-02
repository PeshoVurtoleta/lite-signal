/**
 * test/97 -- R7 group B (B1 part): the twin runner, the BOX lane descriptor, applicability's engine arg, the lite-box
 * config surface (burst 148, helper).
 *
 * Written from the plan (.handoff/PLAN-R7-box.md: CURRENT C-1, C-3, C-13, C-14, C-27, C-30; ASSERTIONS B-2, B-3) and the
 * census seeds (BASE 0xb1440012, cycle 0, world w = worldSeed(seedFor(BASE, lane.index, 0), w)). Reference values:
 *   - ops / opsByClass / gateHits / skipTainted / failure of a twin result are compared with a PLAIN runWorld of the
 *     same script on the primary adapter (an independent run, no twin involved);
 *   - counts (20 worlds, ERROR 17 failing, must-fail 20/20, world 0 first diff at trace index 121 = census README
 *     "trace line 121", test/96 A-2 asserts index 121) are the plan's ASSERTIONS B-2 / A-2 numbers, re-probed by this helper on the landed code (b148 probe:
 *     17 ERROR fails O6:expected-escape-missing, 0 elsewhere; BOX lane picks ERROR 7 GRAPH 6 BATCH 4 WIE 2 NEST 1,
 *     6 failing, 0 OT);
 *   - the BOX pick is re-derived here from the world seed (seed % 5 over GRAPH, BATCH, ERROR, NEST, WIE);
 *   - the old config messages are the pre-B1 literals (git HEAD config.mjs).
 * B-4 (main.mjs twin tap) and B-5 (CLI) are B2 and not covered. Every row fails on the pre-B1 tree because twin.mjs,
 * lanes/box.mjs, TWINS, the 3rd applicability arg, the lite-box engine and the two scenario names do not exist there.
 * Modules that are new are loaded dynamically, so one missing module fails its rows, not the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { K } from '../bench/soak/kernel.mjs';
import { liteS3Adapter } from '../bench/soak/adapters/lite-s3.mjs';
import { liteBoxAltAdapter, liteBoxAdapterFor } from '../bench/soak/adapters/lite-box.mjs';
import * as CT from '../bench/soak/adapters/contract.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import { seedFor, worldSeed } from '../bench/soak/seeds.mjs';
import { laneByName, isLargeWorld, LANE_INDEX, ROSTER } from '../bench/soak/lanes/index.mjs';
import { SCENARIOS } from '../bench/soak/scenarios.mjs';
import { parseConfig, SoakConfigError, MUSTFAIL_MODES, ENGINES_AVAILABLE } from '../bench/soak/config.mjs';

let TW = null, TW_ERR = null, BX = null, BX_ERR = null;
try { TW = await import('../bench/soak/twin.mjs'); } catch (e) { TW_ERR = e; }
try { BX = await import('../bench/soak/lanes/box.mjs'); } catch (e) { BX_ERR = e; }
const twin = () => { if (TW === null) assert.fail('twin.mjs does not load: ' + String(TW_ERR)); return TW.runWorldTwin; };
const BOX = () => { if (BX === null) assert.fail('lanes/box.mjs does not load: ' + String(BX_ERR)); return BX.BOX; };

const BASE = 0xB1440012 >>> 0;
const W = 20;
const SUBN = ['GRAPH', 'BATCH', 'ERROR', 'NEST', 'WIE'];
const scriptOf = (desc, w) => generateWorld(desc, worldSeed(seedFor(BASE, desc.index, 0), w), { large: isLargeWorld(desc, w), covOff: null });
const brokenAd = (mode) => liteBoxAdapterFor(K, mode, { broken: 'box-untracked' });
const GOLD = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/r7-b0-applicability.json', import.meta.url)), 'utf8'));
const sigs = (f) => f.fails.map((q) => q.oracle + ':' + q.sig);

// ---- 1. runWorldTwin over the census: 5 sub-lanes x 20 worlds, lite vs lite-box/alt ----
const CENSUS = {};
function census(name) {
    if (CENSUS[name] === undefined) {
        const desc = laneByName(name);
        const rows = [];
        for (let w = 0; w < W; w++) {
            const script = scriptOf(desc, w);
            rows.push({ script, plain: runWorld(liteS3Adapter, script), t: twin()(desc, liteS3Adapter, liteBoxAltAdapter, script) });
        }
        CENSUS[name] = rows;
    }
    return CENSUS[name];
}
const EXPECT_PRIM_FAILS = { GRAPH: 0, BATCH: 0, ERROR: 17, NEST: 0, WIE: 0 };   // B-2; ERROR = DIV-F22 O6

for (const name of SUBN) {
    test('B-2 ' + name + ': 20 census worlds, checks.OT === 1 on every world, no OT failure, box-trace-equal 1', () => {
        const rows = census(name);
        assert.equal(rows.length, W);
        for (const { t } of rows) {
            assert.equal(t.checks.OT, 1);
            assert.equal(t.scen['box-trace-equal'], 1);
            assert.ok(t.failure === null || !t.failure.fails.some((q) => q.oracle === 'OT'));
        }
    });
    test('B-2 ' + name + ': result ops / opsByClass / gateHits / skipTainted / trace / checks(minus OT) come from the primary; failure equals the plain primary failure', () => {
        for (const { plain, t } of census(name)) {
            assert.equal(t.ops, plain.ops);
            assert.deepEqual(t.opsByClass, plain.opsByClass);
            assert.deepEqual(t.gateHits, plain.gateHits);
            assert.deepEqual(t.skipTainted, plain.skipTainted);
            assert.equal(t.trace, plain.trace);
            const { OT, ...rest } = t.checks;
            const { OT: _p, ...plainRest } = plain.checks;
            assert.equal(_p, 0, 'a non-twin world books OT 0'); assert.deepEqual(rest, plainRest);
            assert.deepEqual(t.failure, plain.failure);   // clean + equal -> null; dirty + equal -> the primary failure untouched
            for (const k of Object.keys(plain.scen)) assert.equal(t.scen[k], plain.scen[k], k);
        }
    });
    test('B-2 ' + name + ': ' + EXPECT_PRIM_FAILS[name] + '/20 worlds fail (primary failures only)', () => {
        const fails = census(name).filter((r) => r.t.failure !== null);
        assert.equal(fails.length, EXPECT_PRIM_FAILS[name]);
        for (const r of fails) assert.deepEqual(sigs(r.t.failure), ['O6:expected-escape-missing']);
    });
}
test('B-2 box-interop: lite vs lite-box/alt reads across kinds in every census world (20/20 per sub-lane), a count > 0 under the Smi cap', () => {
    for (const name of SUBN) for (const { t } of census(name)) {
        assert.equal(Number.isInteger(t.scen['box-interop']), true);
        assert.ok(t.scen['box-interop'] > 0 && t.scen['box-interop'] <= 0x3FFFFFFF);
    }
});
test('B-2 box-interop is absent (key not present) when neither side is a box world; box-trace-equal still 1', () => {
    const desc = laneByName('GRAPH');
    const t = twin()(desc, liteS3Adapter, liteS3Adapter, scriptOf(desc, 0));
    assert.equal(Object.hasOwn(t.scen, 'box-interop'), false);
    assert.equal(t.scen['box-trace-equal'], 1);
    assert.equal(t.checks.OT, 1);
    assert.equal(t.failure, null);
});

// ---- 2. must-fail twin {broken:'box-untracked'} and the failure rule both ways ----
for (const mode of ['alt', 'all']) {
    test('B-2 must-fail: GRAPH vs lite-box/' + mode + ' {broken:box-untracked} -> 20/20 worlds with the single failure OT:trace-diff', () => {
        const desc = laneByName('GRAPH');
        const brk = brokenAd(mode);
        for (let w = 0; w < W; w++) {
            const t = twin()(desc, liteS3Adapter, brk, scriptOf(desc, w));
            assert.notEqual(t.failure, null, 'world ' + w);
            assert.deepEqual(sigs(t.failure), ['OT:trace-diff'], 'world ' + w);   // clean primary -> OT is the only fail
            assert.deepEqual(t.failure.scen, []);
            assert.equal(t.checks.OT, 1);
            assert.equal(Object.hasOwn(t.scen, 'box-trace-equal'), false);   // traces differ
            assert.ok(t.failure.fails[0].at >= 0);
        }
    });
}
test('B-2 must-fail world 0 (alt): first diff at trace index 121 (census-20 traceAt; test/96 A-2), detail in the C-27 format, step/op from the step column', () => {
    const desc = laneByName('GRAPH');
    const sc = scriptOf(desc, 0);
    const t = twin()(desc, liteS3Adapter, brokenAd('alt'), sc);
    const f = t.failure.fails[0];
    assert.equal(f.oracle, 'OT');
    assert.equal(f.sig, 'trace-diff');
    assert.equal(f.at, 121);
    assert.match(f.detail, /^line 121 \(n \d+ \/ \d+\): a=/);
    assert.equal(f.detail.length, 240);   // C-27: cut to 240 (side a is a long stats() line, so b= falls past the cut)
    assert.ok(f.detail.includes('"'), 'the re-run keeps text for the window, so a side is JSON text (not only h:hash)');
    assert.equal(Number.isInteger(t.failure.step), true);
    assert.ok(t.failure.step >= 0 && t.failure.step < sc.ops.length);
    assert.equal(t.failure.op, sc.ops[t.failure.step].o);
});
test('failure rule: dirty primary + diff -> the OT failure is APPENDED to the primary fails (step/op/scen of the primary kept)', () => {
    const desc = laneByName('ERROR');
    let hit = 0;
    for (const { script, plain } of census('ERROR')) {
        if (plain.failure === null) continue;
        hit++;
        const t = twin()(desc, liteS3Adapter, brokenAd('alt'), script);
        assert.deepEqual(sigs(t.failure), ['O6:expected-escape-missing', 'OT:trace-diff']);
        assert.equal(t.failure.step, plain.failure.step);
        assert.equal(t.failure.op, plain.failure.op);
        assert.deepEqual(t.failure.scen, plain.failure.scen);
        assert.deepEqual(t.failure.fails[0], plain.failure.fails[0]);
        if (hit === 3) break;
    }
    assert.equal(hit, 3);
});
test('failure rule: clean primary + equal traces -> failure null (GRAPH world 0)', () => {
    assert.equal(census('GRAPH')[0].t.failure, null);
});

// ---- 3. opts forwarding ----
test('opts are forwarded to the primary run: opts.trace === true gives the primary trace array; creationAbort of a wrong type throws as in runWorld', () => {
    const desc = laneByName('GRAPH');
    const sc = scriptOf(desc, 0);
    const t = twin()(desc, liteS3Adapter, liteBoxAltAdapter, sc, { trace: true });
    const plain = runWorld(liteS3Adapter, sc, { trace: true });
    assert.equal(Array.isArray(t.trace), true);
    assert.deepEqual(t.trace, plain.trace);
    assert.throws(() => twin()(desc, liteS3Adapter, liteBoxAltAdapter, sc, { creationAbort: 'x' }), TypeError);
});

// ---- 4. malformed input matrix ----
test('runWorldTwin fail-closed: a non-descriptor desc throws TypeError (null, undefined, "", 5, {}, {name: 5}, [])', () => {
    const desc = laneByName('GRAPH');
    const sc = scriptOf(desc, 0);
    for (const bad of [null, undefined, '', 5, {}, { name: 5 }, [], 'GRAPH']) {
        assert.throws(() => twin()(bad, liteS3Adapter, liteBoxAltAdapter, sc), TypeError, String(bad));
    }
});
test('runWorldTwin fail-closed: ad and twinAd must be adapters (null, undefined, "", 5, {}, {open: 1}, a function)', () => {
    const desc = laneByName('GRAPH');
    const sc = scriptOf(desc, 0);
    for (const bad of [null, undefined, '', 5, {}, { open: 1 }, () => 0]) {
        assert.throws(() => twin()(desc, bad, liteBoxAltAdapter, sc), /ad must be an adapter/, 'ad ' + String(bad));
        assert.throws(() => twin()(desc, liteS3Adapter, bad, sc), /twinAd must be an adapter/, 'twinAd ' + String(bad));
    }
});
test('runWorldTwin fail-closed: script must be a gen script (null, undefined, "", 5, {}, {ops: "x"}) and its lane must equal desc.name', () => {
    const desc = laneByName('GRAPH');
    for (const bad of [null, undefined, '', 5, {}, { ops: 'x', lane: 'GRAPH' }, []]) {
        assert.throws(() => twin()(desc, liteS3Adapter, liteBoxAltAdapter, bad), TypeError, String(bad));
    }
    const other = scriptOf(laneByName('BATCH'), 0);
    assert.throws(() => twin()(desc, liteS3Adapter, liteBoxAltAdapter, other), /script lane BATCH is not desc GRAPH/);
    assert.throws(() => twin()(laneByName('BATCH'), liteS3Adapter, liteBoxAltAdapter, scriptOf(desc, 0)), /script lane GRAPH is not desc BATCH/);
});

// ---- 5. TWINS / applicability (B-3) ----
test('TWINS: exactly { lite: "lite-box/alt", "lite-box": "lite-box/alt" }, frozen', () => {
    assert.deepEqual({ ...CT.TWINS }, { lite: 'lite-box/alt', 'lite-box': 'lite-box/alt' });
    assert.equal(Object.isFrozen(CT.TWINS), true);
});
test('ORACLE_CAPS.OT is [] (OT needs no caps), so OT is never in oraclesNA on any caps', () => {
    assert.deepEqual(CT.ORACLE_CAPS.OT, []);
    assert.equal(CT.applicability(BOX(), GOLD.caps, 'lite').oraclesNA.includes('OT'), false);
    assert.equal(CT.applicability(BOX(), {}, 'lite').oraclesNA.includes('OT'), false);
    for (const e of ['lite', 'lite-box', 'nope', undefined]) assert.equal(CT.applicability(BOX(), GOLD.caps, e).oraclesNA.includes('OT'), false);
});
test('B-3 applicability(BOX, caps, engine): lite / lite-box -> run; "nope", undefined -> skip with missingCaps ["twin"]', () => {
    for (const e of ['lite', 'lite-box']) {
        const a = CT.applicability(BOX(), GOLD.caps, e);
        assert.equal(a.status, 'run', e);
        assert.deepEqual(a.missingCaps, [], e);
    }
    for (const e of ['nope', undefined]) {
        const a = CT.applicability(BOX(), GOLD.caps, e);
        assert.equal(a.status, 'skip', String(e));
        assert.deepEqual(a.missingCaps, ['twin'], String(e));
    }
    assert.deepEqual(CT.applicability(BOX(), GOLD.caps).missingCaps, ['twin']);   // 2-arg form = no engine
});
test('applicability engine arg fail-closed: non-string / inherited-key engines never match TWINS (null, 5, {}, [], "", "toString", "__proto__", "constructor", "Lite")', () => {
    for (const e of [null, 5, {}, [], '', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 'Lite', 'lite-box/alt', true]) {
        const a = CT.applicability(BOX(), GOLD.caps, e);
        assert.equal(a.status, 'skip', String(e));
        assert.deepEqual(a.missingCaps, ['twin'], String(e));
    }
});
test('B-3 the 12 pre-BOX ROSTER lanes (ROSTER minus BOX) deepEqual the B0 golden, with and without the engine arg (engine is not read for non-twin lanes)', () => {
    assert.deepEqual(GOLD.lanes.map((l) => l.lane), ROSTER.slice(0, 12));
    assert.equal(GOLD.lanes.length, 12);
    for (const { lane, res } of GOLD.lanes) {
        const d = laneByName(lane);
        assert.equal(d.twin === true, false, lane);
        assert.deepEqual(CT.applicability(d, GOLD.caps), res, lane);
        for (const e of ['lite', 'lite-box', 'nope', undefined, 5, null]) assert.deepEqual(CT.applicability(d, GOLD.caps, e), res, lane + ' ' + String(e));
    }
});

// ---- 6. the BOX descriptor and the lane ----
test('BOX descriptor: name, twin, hardOracles ["OT"], required pair, covOff {}, worldShape.steps 400 / largeEvery 0, frozen, no ops', () => {
    const b = BOX();
    assert.equal(b.name, 'BOX');
    assert.equal(b.twin, true);
    assert.deepEqual([...b.hardOracles], ['OT']);
    assert.deepEqual([...b.required], ['box-trace-equal', 'box-interop']);
    assert.deepEqual({ ...b.covOff }, {});
    assert.equal(b.worldShape.steps, 400);
    assert.equal(b.worldShape.largeEvery, 0);
    assert.deepEqual({ ...b.mix }, { GRAPH: 1, BATCH: 1, ERROR: 1, NEST: 1, WIE: 1 });
    assert.equal(b.flushPasses, null);
    assert.equal(Object.isFrozen(b), true);
    assert.equal(typeof b.init, 'function');
    assert.equal(typeof b.step, 'function');
    assert.equal(Object.hasOwn(b, 'ops'), false);
    for (const c of ['batch', 'disposeSignal', 'childEffects', 'untrack']) assert.ok(b.needsCaps.includes(c), c);
    assert.equal(b.needsCaps.length, 4);
    for (const s of ['box-trace-equal', 'box-interop']) assert.equal(b.optional.includes(s), false, 'required names are not repeated in optional');
});
test('BOX is rostered last (ROSTER[12]) and has LANE_INDEX 9', () => {
    assert.equal(ROSTER.indexOf('BOX'), 12, 'R7 C1: BOX is ROSTER[12], rostered last');
    assert.equal(LANE_INDEX.BOX, 9);
});
test('scenarios.mjs lists box-trace-equal and box-interop as the last two ids', () => {
    assert.deepEqual(SCENARIOS.slice(-2), ['box-trace-equal', 'box-interop']);
    assert.equal(SCENARIOS.length, 79);
});
test('BOX script = the picked sub-lane script on the same seed (pick = seed % 5 over GRAPH, BATCH, ERROR, NEST, WIE), lane name BOX; the pick draws nothing from the stream', () => {
    const b = BOX();
    const cs = seedFor(BASE, LANE_INDEX.BOX, 0);
    const picks = {};
    for (let w = 0; w < W; w++) {
        const ws = worldSeed(cs, w);
        const sub = SUBN[ws % 5];
        picks[sub] = (picks[sub] || 0) + 1;
        const bs = generateWorld(b, ws, { large: false, covOff: null });
        const ss = generateWorld(laneByName(sub), ws, { large: false, covOff: null });
        assert.equal(bs.lane, 'BOX');
        assert.deepEqual({ ...bs, lane: sub }, ss, 'world ' + w);
    }
    assert.deepEqual(picks, { ERROR: 7, GRAPH: 6, WIE: 2, NEST: 1, BATCH: 4 });
});
test('BOX lane: step(g) before init(g) throws (fail closed)', () => {
    assert.throws(() => BOX().step({ seed: 1 }), /step\(g\) before init\(g\)/);
    assert.throws(() => BOX().step({}), Error);
});
test('BOX lane worlds (20, lite vs lite-box/alt): 6 fail, all by the picked sub-lane own failure (ERROR O6), 0 OT failures, box-trace-equal 20', () => {
    const b = BOX();
    const cs = seedFor(BASE, LANE_INDEX.BOX, 0);
    let fail = 0, ot = 0, eq = 0;
    for (let w = 0; w < W; w++) {
        const ws = worldSeed(cs, w);
        const sc = generateWorld(b, ws, { large: false, covOff: null });
        const t = twin()(b, liteS3Adapter, liteBoxAltAdapter, sc);
        const plain = runWorld(liteS3Adapter, sc);
        assert.deepEqual(t.failure, plain.failure, 'world ' + w);
        assert.equal(t.checks.OT, 1);
        if (t.failure !== null) { fail++; assert.deepEqual(sigs(t.failure), ['O6:expected-escape-missing']); assert.equal(SUBN[ws % 5], 'ERROR'); }
        if (t.failure !== null && t.failure.fails.some((q) => q.oracle === 'OT')) ot++;
        if (t.scen['box-trace-equal'] === 1) eq++;
    }
    assert.equal(fail, 6);
    assert.equal(ot, 0);
    assert.equal(eq, 20);
});

// ---- 7. config: ENGINES_AVAILABLE and SOAK_MUSTFAIL ----
const OPTS = { roster: ROSTER.slice(), scenarios: SCENARIOS.slice(), covOffSupported: Object.fromEntries(ROSTER.map((n) => [n, Object.keys(laneByName(n).covOff)])), argv: [] };
const cfgOf = (env) => parseConfig(env, OPTS);
const cfgMsg = (env) => { try { cfgOf(env); } catch (e) { assert.ok(e instanceof SoakConfigError, String(e)); return e.message; } return null; };

test('config: ENGINES_AVAILABLE is exactly [lite, lite-box]; SOAK_ENGINE=lite-box is accepted, alien is refused naming both', () => {
    assert.deepEqual([...ENGINES_AVAILABLE], ['lite', 'lite-box']);
    assert.equal(cfgOf({ SOAK_ENGINE: 'lite-box' }).engine, 'lite-box');
    assert.equal(cfgOf({ SOAK_ENGINE: 'lite' }).engine, 'lite');
    assert.equal(cfgOf({}).engine, 'lite');
    assert.equal(cfgMsg({ SOAK_ENGINE: 'alien' }), "SOAK_ENGINE: engine 'alien' is not available in this build (available: lite, lite-box)");
    assert.equal(cfgMsg({ SOAK_ENGINE: 'lite-bo' }).startsWith("SOAK_ENGINE: unknown engine 'lite-bo'"), true);
});
test('config: SOAK_KERNEL / SOAK_NEARWRAP stay lite-only even for lite-box (the seam is not the box engine)', () => {
    assert.match(cfgMsg({ SOAK_ENGINE: 'lite-box', SOAK_KERNEL: '/x/Signal.js' }), /SOAK_KERNEL is the lite-only kernel seam; it cannot be combined with SOAK_ENGINE='lite-box'/);
    assert.match(cfgMsg({ SOAK_ENGINE: 'lite-box', SOAK_NEARWRAP: '1' }), /SOAK_NEARWRAP derives the lite kernel; it cannot be combined with SOAK_ENGINE='lite-box'/);
});
test('config: MUSTFAIL_MODES is [cov-off, box-untracked]; bare SOAK_MUSTFAIL=box-untracked -> frozen { mode: "box-untracked", scenario: null }', () => {
    assert.deepEqual([...MUSTFAIL_MODES], ['cov-off', 'box-untracked']);
    const c = cfgOf({ SOAK_MUSTFAIL: 'box-untracked' });
    assert.deepEqual({ ...c.mustFail }, { mode: 'box-untracked', scenario: null });
    assert.equal(Object.isFrozen(c.mustFail), true);
    assert.equal(cfgOf({}).mustFail, null);
});
test('config: box-untracked takes no scenario -- "box-untracked:x", "box-untracked:", "box-untracked:cov-off" are refused with the exact message', () => {
    for (const raw of ['box-untracked:x', 'box-untracked:', 'box-untracked:reuse-at-edge', 'box-untracked::']) {
        assert.equal(cfgMsg({ SOAK_MUSTFAIL: raw }), "SOAK_MUSTFAIL='" + raw + "' must be the bare token box-untracked (it takes no scenario)", raw);
    }
});
test('config: near-miss tokens are NOT box-untracked ("Box-untracked", " box-untracked", "box-untracked " , "box", "") and keep the old cov-off refusal', () => {
    for (const raw of ['Box-untracked', ' box-untracked', 'box-untracked ', 'box', '', 'box-untrack', 'box_untracked']) {
        assert.equal(cfgMsg({ SOAK_MUSTFAIL: raw }), "SOAK_MUSTFAIL='" + raw + "' must be cov-off:<scenario>", JSON.stringify(raw));
    }
});
test('config: every pre-B1 cov-off input keeps its byte-identical message (HEAD literals)', () => {
    assert.equal(cfgMsg({ SOAK_MUSTFAIL: 'cov-off' }), "SOAK_MUSTFAIL='cov-off' must be cov-off:<scenario>");
    assert.equal(cfgMsg({ SOAK_MUSTFAIL: 'foo:bar' }), "SOAK_MUSTFAIL='foo:bar' must be cov-off:<scenario>");
    assert.equal(cfgMsg({ SOAK_MUSTFAIL: 'cov-off:diamond-writ' }).startsWith("SOAK_MUSTFAIL: unknown scenario 'diamond-writ' (did you mean"), true);
    assert.equal(cfgMsg({ SOAK_MUSTFAIL: 'cov-off:diamond-write' }).startsWith('SOAK_MUSTFAIL: cov-off:diamond-write is not supported on the selected lanes '), true);
    // a valid cov-off still parses to { mode: 'cov-off', scenario }
    const lane = ROSTER.find((n) => Object.keys(laneByName(n).covOff).length > 0);
    const scen = Object.keys(laneByName(lane).covOff)[0];
    assert.deepEqual({ ...cfgOf({ SOAK_LANES: lane, SOAK_MUSTFAIL: 'cov-off:' + scen }).mustFail }, { mode: 'cov-off', scenario: scen });
});
test('config (C-30): SOAK_CYCLES=1 is refused (>= 11), 11 and 0 accepted -- pinned for the BOX cycle census', () => {
    assert.match(cfgMsg({ SOAK_CYCLES: '1' }), /SOAK_CYCLES='1' must be an integer >= 11/);
    assert.equal(cfgOf({ SOAK_CYCLES: '11' }).cycles, 11);
    assert.equal(cfgOf({ SOAK_CYCLES: '0' }).forever, true);
});

const GRAPH_D = laneByName('GRAPH');
const GRAPH_SCRIPT = scriptOf(GRAPH_D, 0);
const GRAPH_BROKEN = brokenAd('alt');
test('R1 re-run that does not reproduce the diff keeps the hash-only OT failure (fail closed)', () => {
    let calls = 0;
    const flaky = Object.assign({}, liteBoxAltAdapter, { open(o) { calls++; return calls === 1 ? GRAPH_BROKEN.open(o) : liteBoxAltAdapter.open(o); } });
    const t = twin()(GRAPH_D, liteS3Adapter, flaky, GRAPH_SCRIPT);
    assert.equal(calls, 2);
    assert.notEqual(t.failure, null);
    assert.deepEqual(t.failure.fails.map((q) => q.oracle + ':' + q.sig + '@' + q.at), ['OT:trace-diff@121']);
    assert.ok(t.failure.fails[0].detail.endsWith(' (re-run: equal)'), t.failure.fails[0].detail);
    assert.equal(t.scen['box-trace-equal'], undefined);
});
test('R2 the verdict line is in both sinks: world-0 detail counts it (n 20394 / 124)', () => {
    const t = twin()(GRAPH_D, liteS3Adapter, GRAPH_BROKEN, GRAPH_SCRIPT);
    assert.ok(t.failure.fails[0].detail.startsWith('line 121 (n 20394 / 124): '), t.failure.fails[0].detail.slice(0, 40));
});
test('R3 a teardown-only diff maps to step ops.length, op end', () => {
    const tw = Object.assign({}, liteBoxAltAdapter, { open(o) { const w = liteBoxAltAdapter.open(o); const c = w.close; return Object.assign(Object.create(w), { close() { c.call(w); throw new Error('r3 close'); } }); } });
    const t = twin()(GRAPH_D, liteS3Adapter, tw, GRAPH_SCRIPT);
    assert.notEqual(t.failure, null);
    assert.equal(t.failure.step, GRAPH_SCRIPT.ops.length);
    assert.equal(t.failure.op, 'end');
});

// ======================================================================================================
// R7 B2 (burst 149, helper): main.mjs twin surface, replay / shrink twin lanes, B-4 retention, B-5 emitTest.
// Expected strings are the plan's wording / main.mjs doc-comment contract (C-3, C-33..C-35, B-4, B-5); the B-4 counts are
// the coder's b4-probe numbers (3 cycles x 20 BOX worlds, seedFor(0xb1440012, 9, cycle)), re-derived here by the
// same tracker / twin-tap pieces (an independent run of main's pieces, not main's own lane loop).
// ======================================================================================================
const MN = await import('../bench/soak/main.mjs');
const RP = await import('../bench/soak/replay.mjs');
const SH = await import('../bench/soak/shrink.mjs');
const { createLeakTracker } = await import('@zakkster/lite-leak');
const { closeBoundary } = await import('../bench/soak/boundary.mjs');
const LBX = await import('../bench/soak/adapters/lite-box.mjs');
const { vmGc } = await (async () => {
    const v8 = await import('node:v8'); const vm = await import('node:vm');
    v8.setFlagsFromString('--expose-gc');
    return { vmGc: typeof globalThis.gc === 'function' ? globalThis.gc : vm.runInNewContext('gc') };
})();
const rejects = async (fn, re) => { let err = null; try { await fn(); } catch (e) { err = e; } assert.ok(err instanceof TypeError, 'TypeError expected'); assert.equal(err.message, re); };
const throwsTE = (fn, msg) => assert.throws(fn, (e) => e instanceof TypeError && e.message === msg);

test('B2 loadAdapter: lite -> liteS3Adapter; lite-box -> mode all (canonical fields); lite-box/alt -> mode alt', async () => {
    assert.equal(await MN.loadAdapter('lite'), liteS3Adapter);
    const b = await MN.loadAdapter('lite-box');
    const strip = (a) => ({ name: a.name, mode: a.mode, version: a.version, knownAs: a.knownAs, caps: a.caps });
    assert.deepEqual(strip(b), strip(LBX.liteBoxAdapter));
    assert.equal(b.mode, 'all');
    const alt = await MN.loadAdapter('lite-box/alt');
    assert.deepEqual([alt.name, alt.mode], ['lite-box', 'alt']);
    assert.deepEqual(MN.ADAPTERS, { lite: './adapters/lite-s3.mjs', 'lite-box': './adapters/lite-box.mjs' });
});
test('B2 loadAdapter: fail-closed TypeError messages (exact)', async () => {
    const mal = (s) => "loadAdapter: malformed engine spec '" + s + "' (expected name[/mode])";
    await rejects(() => MN.loadAdapter(5), 'loadAdapter: spec must be a string name[/mode], got number');
    await rejects(() => MN.loadAdapter(undefined), 'loadAdapter: spec must be a string name[/mode], got undefined');
    for (const s of ['', '/x', 'lite-box/', 'a/b/c']) await rejects(() => MN.loadAdapter(s), mal(s));
    await rejects(() => MN.loadAdapter('nope'), "loadAdapter: no adapter for engine 'nope' (have: lite, lite-box)");
    await rejects(() => MN.loadAdapter('lite/alt'), "loadAdapter: engine lite takes no mode (got 'lite/alt')");
    await rejects(() => MN.loadAdapter('lite', {}), 'loadAdapter: engine lite takes no opts (the {broken} control is lite-box only)');
    await rejects(() => MN.loadAdapter('lite-box/zzz'), 'lite-box: mode must be one of all, alt, got "zzz"');
    await rejects(() => MN.loadAdapter('lite-box', { broken: 'x' }), 'lite-box: opts.broken "x" is not one of box-untracked');
    await rejects(() => MN.loadAdapter('lite-box', 5), "lite-box: opts must be undefined or a plain object { broken: 'box-untracked' }");
    await rejects(() => MN.loadAdapter('lite-box', []), "lite-box: opts must be undefined or a plain object { broken: 'box-untracked' }");
});
test('B2 loadTwin (C-3): lite and lite-box both load lite-box/alt; unknown / undefined engine -> TypeError', async () => {
    for (const e of ['lite', 'lite-box']) { const t = await MN.loadTwin(e, null); assert.deepEqual([t.name, t.mode], ['lite-box', 'alt'], e); }
    const tb = await MN.loadTwin('lite', { mode: 'box-untracked' });
    assert.deepEqual([tb.name, tb.mode], ['lite-box', 'alt']);
    await rejects(() => MN.loadTwin('nope'), 'loadTwin: engine nope has no twin (contract.mjs TWINS)');
    await rejects(() => MN.loadTwin(undefined), 'loadTwin: engine undefined has no twin (contract.mjs TWINS)');
});
test('B2 twinOptsFor: box-untracked -> {broken}; cov-off / null / undefined -> undefined; bad input throws (exact)', () => {
    assert.deepEqual(MN.twinOptsFor({ mode: 'box-untracked' }), { broken: 'box-untracked' });
    assert.equal(MN.twinOptsFor({ mode: 'cov-off' }), undefined);
    assert.equal(MN.twinOptsFor(null), undefined);
    assert.equal(MN.twinOptsFor(undefined), undefined);
    throwsTE(() => MN.twinOptsFor('x'), 'twinOptsFor: mustFail must be null or a parseConfig() mustFail object');
    throwsTE(() => MN.twinOptsFor({ mode: 'q' }), 'twinOptsFor: unknown mustFail mode "q"');
});
test('B2 mustFailRefusal: the message WITHOUT the "soak: CONFIG -- " prefix; null when a twin lane is selected or mode differs', () => {
    const mf = { mode: 'box-untracked' };
    assert.equal(MN.mustFailRefusal(mf, [laneByName('GRAPH')]), 'SOAK_MUSTFAIL: box-untracked is not supported on the selected lanes GRAPH (none of them is a twin lane)');
    assert.equal(MN.mustFailRefusal(mf, [laneByName('GRAPH'), laneByName('ERROR')]), 'SOAK_MUSTFAIL: box-untracked is not supported on the selected lanes GRAPH,ERROR (none of them is a twin lane)');
    assert.equal(MN.mustFailRefusal(mf, [BOX()]), null);
    assert.equal(MN.mustFailRefusal(mf, [laneByName('GRAPH'), BOX()]), null);
    assert.equal(MN.mustFailRefusal({ mode: 'cov-off' }, [laneByName('GRAPH')]), null);
    assert.equal(MN.mustFailRefusal(null, [laneByName('GRAPH')]), null);
});
test('B2 runLaneWorld: twin lane without a twin adapter and a null desc -> TypeError (exact)', () => {
    const script = generateWorld(BOX(), worldSeed(seedFor(BASE, LANE_INDEX.BOX, 0), 0), { large: false, covOff: null });
    throwsTE(() => MN.runLaneWorld(BOX(), liteS3Adapter, null, script), 'runLaneWorld: twin lane BOX has no twin adapter');
    throwsTE(() => MN.runLaneWorld(null, liteS3Adapter, null, script), 'runLaneWorld: desc must be a lane descriptor');
});
test('B2 openTwinTap: a twin world with no registry -> TypeError (exact); a good world is tracked and witnessed', () => {
    const tracker = createLeakTracker({ name: 't97' });
    const tw = MN.openTwinTap(tracker, 'BOX', liteBoxAltAdapter);
    throwsTE(() => tw.tap.onOpen({ registry: null }), 'main: the twin world has no registry to track');
    assert.equal(tw.tap.tracked, 0);
    const reg = {};
    tw.tap.onOpen({ registry: reg });
    assert.equal(tw.tap.tracked, 1);
    assert.equal(tw.tap.witness.length, 1);
    assert.equal(tracker.size(), 1);
});

// B-4: a lane-cycle through main's pieces. Returns the per-cycle row.
async function boxCycle(cycle, mustFail, worlds) {
    const BOXD = BOX();
    const primary = await MN.loadAdapter('lite');
    const twinAd = await MN.loadTwin('lite', mustFail);
    const tracker = createLeakTracker({ name: 'b4' });
    const witness = [];
    let tracked = 0;
    const tap = { escape: null, onOpen(pw) { tracker.track(pw.registry, null, 'BOX'); witness.push(new WeakRef(pw.registry)); tracked++; } };
    const ad = MN.tapAdapter(primary, tap);
    const tw = MN.openTwinTap(tracker, 'BOX', twinAd);
    let script = null, r = null, failing = 0, ot = 0, eq = 0, interop = 0, opens = 0;
    for (let w = 0; w < worlds; w++) {
        script = generateWorld(BOXD, worldSeed(seedFor(BASE, LANE_INDEX.BOX, cycle), w), { large: false, covOff: null });
        tap.escape = null;
        r = MN.runLaneWorld(BOXD, ad, tw.ad, script);
        opens++;
        if (r.failure !== null) { failing++; if (r.failure.fails.some((f) => f.oracle === 'OT')) { ot++; opens++; } }
        if (r.scen['box-trace-equal'] === 1) eq++;
        if ((r.scen['box-interop'] | 0) > 0) interop++;
    }
    const before = tracker.size();
    const wit = witness.concat(tw.tap.witness);
    const closed = await closeBoundary({ tracker, witness: wit, forceGc: vmGc, dropRefs: () => { script = null; r = null; } });
    return { worlds, opens, tracked, witnessed: witness.length, twinTracked: tw.tap.tracked, twinWitnessed: tw.tap.witness.length, before,
        after: closed.boundary.trackerSize, weakAlive: closed.boundary.weakAlive, failing, ot, eq, interop };
}
test('B-4 retention: 3 cycles x 20 BOX worlds -> tracked = witnessed = twinTracked = twinWitnessed = 20, tracker 40 -> 0, OT 0', async () => {
    const FAILING = [6, 1, 2];   // coder b4-probe (evidence B2/b4-probe.out): failing worlds per cycle
    for (let c = 0; c < 3; c++) {
        const row = await boxCycle(c, null, 20);
        assert.deepEqual(row, { worlds: 20, opens: 20, tracked: 20, witnessed: 20, twinTracked: 20, twinWitnessed: 20, before: 40, after: 0, weakAlive: 0,
            failing: FAILING[c], ot: 0, eq: 20, interop: 20 }, 'cycle ' + c);
    }
});
test('B-4 / C-35: an OT-failing world (twin {broken: box-untracked}) opens 2 worlds per side; opens = worlds + OT fails, boundary measured', async () => {
    const row = await boxCycle(0, { mode: 'box-untracked' }, 6);
    assert.ok(row.ot >= 1, 'coverage floor: at least one OT-failing world, got ' + row.ot);
    assert.equal(row.opens, row.worlds + row.ot);
    assert.equal(row.tracked, row.opens);
    assert.equal(row.witnessed, row.opens);
    assert.equal(row.twinTracked, row.opens);
    assert.equal(row.twinWitnessed, row.opens);
    assert.equal(row.before, 2 * row.opens);
});

// R7 C2b: BOX is rostered (C1), so the twin-lane replay / shrink / emitTest rows below run (the NOT_YET skip guards are gone).
test('B2 replay: a non-twin lane ignores the twin arg (forwardReach GRAPH world 1, reachable)', () => {
    const g = { lane: 'GRAPH', world: 1, cycleSeed: seedFor(BASE, LANE_INDEX.GRAPH, 0), covOff: null };
    const r = RP.forwardReach(liteS3Adapter, { ops: 1000000 }, g, null);
    assert.equal(r.reachable, true);
    assert.equal(r.worldsBefore, 1);
    assert.equal(r.reason, null);
});
test('B2 replay: a twin lane played without its twin -> TypeError (exact)', () => {
    const res = { lane: 'BOX', world: 1, cycleSeed: seedFor(BASE, LANE_INDEX.BOX, 0), covOff: null };
    const msg = 'replay: twin lane BOX needs its twin adapter (loadEngine)';
    throwsTE(() => RP.playWorld(liteS3Adapter, res, undefined, null), msg);
    throwsTE(() => RP.forwardReach(liteS3Adapter, { ops: 1000000 }, res, undefined), msg);
});
test('B2 shrink: makePredicate on a twin lane without a twin is never a hit; with a twin the failing target hits', async () => {
    const BOXD = BOX();
    const twinAd = await MN.loadTwin('lite', null);
    let hit = null;
    for (let w = 0; w < 20 && hit === null; w++) {
        const s = generateWorld(BOXD, worldSeed(seedFor(BASE, LANE_INDEX.BOX, 0), w), { large: false, covOff: null });
        const r = SH.makeRunner(liteS3Adapter, twinAd)(s);
        if (r !== null && r.failure !== null) hit = { s, keys: MN.familyKeys(r.failure.fails) };
    }
    assert.ok(hit !== null, 'cycle 0 has failing BOX worlds (6 of 20, b4-probe)');
    assert.equal(SH.makePredicate(liteS3Adapter, hit.keys, null)(hit.s), false);
    assert.equal(SH.makePredicate(liteS3Adapter, hit.keys, undefined)(hit.s), false);
    assert.equal(SH.makeRunner(liteS3Adapter, null)(hit.s), null);
    assert.equal(SH.makePredicate(liteS3Adapter, hit.keys, twinAd)(hit.s), true);
});
const einfo = (lane, engine) => ({ lane, engine, key: lane + ':0:0x1', target: [], ops: 1, opsOriginal: 1, script: { lane, ops: [] } });
test('B-5 emitTest: a lite non-twin lane has no runWorldTwin / loadTwin and keeps the plain runWorld line', () => {
    const g = SH.emitTest(einfo('GRAPH', 'lite'));
    assert.equal(g.includes('runWorldTwin'), false);
    assert.equal(g.includes('loadTwin'), false);
    assert.ok(g.includes('ex.runWorld(mn.tapAdapter(liteAdapter, tap), SCRIPT)'));
});
test('B-5 emitTest: a twin lane emits a runWorldTwin call + loadTwin + MUSTFAIL', () => {
    const t = SH.emitTest(einfo('BOX', 'lite'), { mustFail: null });
    assert.ok(t.includes('tw.runWorldTwin(lanes.laneByName(SCRIPT.lane)'), 'twin call');
    assert.ok(t.includes('await mn.loadTwin(ENGINE, MUSTFAIL)'));
    assert.ok(t.includes('const MUSTFAIL = null;'));
    const m = SH.emitTest(einfo('BOX', 'lite'), { mustFail: { mode: 'box-untracked' } });
    assert.ok(m.includes('const MUSTFAIL = {"mode":"box-untracked"};'));
});
