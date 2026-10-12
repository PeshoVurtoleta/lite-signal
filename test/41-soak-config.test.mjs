/**
 * test/41-soak-config.test.mjs -- the soak's fail-closed config (SPEC-B v2 section 9 T-cfg; lesson L1:
 * a bad SOAK_* value once ran zero work and PASSed).
 *
 * Every case spawns a fresh process and asserts: exit 2; exactly one stderr line, starting
 * `soak: CONFIG -- `; the did-you-mean hint where one applies; no BREACH/CRASH line; no stdout (no END
 * sentinel, no heartbeat); and NO output records (the SOAK_OUT file is never created).
 *
 * Entry: bench/soak/main.mjs once it exists; until then a tiny inline entry that runs the same startup
 * order (config -> kernel -> provenance -> stream). The positive control always uses the inline entry: the
 * same env minus the fault writes a header + summary and the END sentinel, which proves the "no records"
 * assertions are not vacuous. It ends INCONCLUSIVE (exit 3): no lane ran, and that is never a PASS.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as CFG from '../bench/soak/config.mjs';
import { PARITY_FILES } from '../bench/soak/parity.mjs';
// lanes/index.mjs is kernel-free (gen-side only): the cov-off universe is IMPORTED, never copied.
import { COV_OFF_SUPPORTED } from '../bench/soak/lanes/index.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOAK = join(ROOT, 'bench', 'soak');
const MAIN = join(SOAK, 'main.mjs');
const SOAK_URL = pathToFileURL(SOAK).href + '/';

// SPEC-B v2 section 5.1 (S1 roster + scenario ids). Used only by the inline entry; main.mjs brings its own.
const ROSTER = ['GRAPH', 'BATCH', 'ERROR', 'NEST'];
const SCENARIOS = [
    'diamond-write', 'dep-set-flip', 'deep-pull', 'second-invalidation', 'equality-cutoff', 'adversarial-equality', 'wide-mark',
    'revert-after-mid-read', 'revert-no-read', 'nested-close', 'throw-in-batch', 'effect-created-mid-batch', 'multi-write-same-signal',
    'throw-dep-effect-prewalk', 'throw-dep-computed-prewalk', 'recovery-after-throw', 'aggregate', 'throwing-equals', 'cycle-error-surfaces',
    'saved-cursor-hazard', 'live-cursor-hazard', 'child-first-run-dispose', 'nested-computed-dispose', 'untrack-dispose', 'outer-computed',
    'early-exit-after-dispose', 'lifecycle-callback-dispose', 'lifecycle-dispose-recycle', 'dispose-outer-observer',
];

const entrySrc = (baseUrl) => `
const BASE = ${JSON.stringify(baseUrl)};
const { readConfig } = await import(BASE + 'config.mjs');
const ROSTER = ${JSON.stringify(ROSTER)};
// -e entries see user args from argv[1]; main.mjs passes process.argv.slice(2)
const cfg = readConfig(process.env, { roster: ROSTER, scenarios: ${JSON.stringify(SCENARIOS)}, covOffSupported: ${JSON.stringify(COV_OFF_SUPPORTED)}, argv: process.argv.slice(1) });
await import(BASE + 'kernel.mjs');
const { buildHeader } = await import(BASE + 'provenance.mjs');
const J = await import(BASE + 'jsonl.mjs');
const header = buildHeader(cfg, {
    kind: 'burn-in', engine: { name: cfg.engine, version: null, caps: null, files: [] }, laneRoster: ROSTER,
    lanes: [], scenarios: {}, oraclesNA: {}, genRules: [], divergences: null,
});
const s = J.openStream(cfg.out !== null ? cfg.out : J.defaultOutPath('burn-in', header.gitSha), performance.now(), 'burn-in');
J.writeRecord(s, 'header', header);
J.protocol('soak: INCONCLUSIVE -- no lane ran (all skipped)');
J.writeRecord(s, 'summary', { reason: 'end', cyclesRun: 0, lanesRun: 0, verdict: 'INCONCLUSIVE', exitCode: 3 });
J.endLine('INCONCLUSIVE', 3, s.seq);
process.exitCode = 3;
`;
const ENTRY = entrySrc(SOAK_URL);

const KERNEL_ONLY_ENTRY = `await import(${JSON.stringify(SOAK_URL + 'kernel.mjs')});`;

const TMP = mkdtempSync(join(tmpdir(), 'soak-cfg-'));
after(() => { rmSync(TMP, { recursive: true, force: true }); });

// kernel fixtures
const HP = join(SOAK, 'controls', 'headpatched');
const NO_WATCH = join(TMP, 'nowatch');
mkdirSync(NO_WATCH);
copyFileSync(join(HP, 'Signal.js'), join(NO_WATCH, 'Signal.js'));
const WRONG_NAME = join(TMP, 'wrongname');
mkdirSync(WRONG_NAME);
copyFileSync(join(HP, 'Signal.js'), join(WRONG_NAME, 'Kernel.js'));
copyFileSync(join(HP, 'Watch.js'), join(WRONG_NAME, 'Watch.js'));
const NO_REG = join(TMP, 'noreg');
mkdirSync(NO_REG);
writeFileSync(join(NO_REG, 'Signal.js'), 'export const notARegistry = 1;\n');
writeFileSync(join(NO_REG, 'Watch.js'), 'export {};\n');

let outN = 0;
function run(caseEnv, { gc = true, entry = 'auto', extraEnv = {}, base = null, argv = [] } = {}) {
    const env = {};
    for (const k of Object.keys(process.env)) {
        if (k.toUpperCase().indexOf('SOAK_') === 0 || k.indexOf('GIT_') === 0 || k === 'NODE_OPTIONS' || k === 'NODE_TEST_CONTEXT') continue;
        env[k] = process.env[k];
    }
    const out = join(TMP, 'out-' + (outN++) + '.jsonl');
    Object.assign(env, { SOAK_OUT: out }, caseEnv, extraEnv);
    if (caseEnv.SOAK_OUT === undefined && Object.prototype.hasOwnProperty.call(caseEnv, 'SOAK_OUT')) delete env.SOAK_OUT;
    const flags = gc ? ['--expose-gc'] : [];
    const useMain = entry === 'auto' && base === null ? existsSync(MAIN) : false;
    const src = entry === 'kernel' ? KERNEL_ONLY_ENTRY : (base !== null ? entrySrc(base) : ENTRY);
    const args = useMain ? flags.concat([MAIN], argv) : flags.concat(['--input-type=module', '-e', src, '--'], argv);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0, out: env.SOAK_OUT };
}

function assertConfigExit(r, expect) {
    const lines = r.stderr.split('\n').filter((l) => l.length > 0);
    assert.equal(r.status, 2, 'exit 2, got ' + r.status + ' signal=' + r.signal + '\nstderr: ' + r.stderr + '\nstdout: ' + r.stdout);
    assert.equal(lines.length, 1, 'exactly one stderr line, got:\n' + r.stderr);
    assert.ok(lines[0].startsWith('soak: CONFIG -- '), 'CONFIG prefix: ' + lines[0]);
    for (const want of [].concat(expect)) assert.ok(lines[0].includes(want), 'expected "' + want + '" in: ' + lines[0]);
    assert.ok(!/soak: (BREACH|CRASH|END)/.test(r.stderr + r.stdout), 'no BREACH/CRASH/END');
    assert.equal(r.stdout, '', 'no stdout (no heartbeat, no END sentinel)');
    if (r.out !== undefined) assert.equal(existsSync(r.out), false, 'no output records: ' + r.out + ' must not exist');
    return lines[0];
}

test('positive control: the same entry with a valid env writes records and the END sentinel (exit 3, never PASS)', () => {
    const r = run({ SOAK_LANES: 'GRAPH', SOAK_KERNEL: join(HP, 'Signal.js'), SOAK_REQUIRE_PROVENANCE: '1' }, { entry: 'inline' });
    assert.equal(r.status, 3, r.stderr);
    assert.ok(existsSync(r.out), 'records written');
    const recs = readFileSync(r.out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(recs.map((x) => x.type), ['header', 'summary']);
    assert.deepEqual(recs.map((x) => x.seq), [0, 1]);
    const h = recs[0];
    assert.equal(h.controls.name, 'headpatched', 'controls.json identifies the frozen fixture');
    assert.equal(h.kernel.files.length, 2);
    assert.equal(h.kernel.files[0].sha256.slice(0, 8), 'fa2871f0');
    assert.equal(typeof h.gitSha, 'string');
    assert.deepEqual(h.config.SOAK_LANES, { value: ['GRAPH'], source: 'env' });
    assert.deepEqual(h.config.SOAK_OPS, { value: 100000, source: 'default' });
    assert.equal(h.gates.CHECK_P, 0.4);
    assert.equal(h.gates.VERDICT.PARTIAL, 'PARTIAL');
    assert.equal(h.gates.EXIT_CODE.PARTIAL, 0);
    assert.equal(h.seedRemapCollision, null, 'default base, 4 lanes, 11 cycles: the remap pair is out of reach');
    assert.equal(r.stdout.trim().split('\n').pop(), 'soak: END verdict=INCONCLUSIVE exit=3 records=2');
});

test('T-cfg SOAK_LANES=grpah: the exact line with the did-you-mean hint, in < 2 s', () => {
    const r = run({ SOAK_LANES: 'grpah' });
    const line = assertConfigExit(r, []);
    assert.equal(line, "soak: CONFIG -- SOAK_LANES: unknown lane 'grpah' (did you mean GRAPH?)");
    assert.ok(r.ms < 2000, 'took ' + r.ms + ' ms');
});

test('T-cfg lanes are case-sensitive: SOAK_LANES=graph is unknown, with a hint', () => {
    assertConfigExit(run({ SOAK_LANES: 'graph' }), ["unknown lane 'graph'", '(did you mean GRAPH?)']);
});

test('T-cfg unknown key SOAK_LANE -> did you mean SOAK_LANES', () => {
    assertConfigExit(run({ SOAK_LANE: 'GRAPH' }), ["unknown env key 'SOAK_LANE'", '(did you mean SOAK_LANES?)']);
});

test('T-cfg SOAK_DURATION is not a key: volume is set in operations', () => {
    assertConfigExit(run({ SOAK_DURATION: '45m' }), ['SOAK_DURATION is not a key', 'did you mean SOAK_OPS or SOAK_CYCLES?']);
});

test('T-cfg SOAK_CYCLES below the gate floor', () => {
    assertConfigExit(run({ SOAK_CYCLES: '5' }), ["SOAK_CYCLES='5'", '>= 11 (or 0)']);
});

test('T-cfg SOAK_OPS=0 and SOAK_OPS=abc', () => {
    assertConfigExit(run({ SOAK_OPS: '0' }), ["SOAK_OPS='0'", 'in [1000, ']);
    assertConfigExit(run({ SOAK_OPS: 'abc' }), ["SOAK_OPS='abc'"]);
});

test('T-cfg SOAK_SEED=-1 and SOAK_SEED=4294967296', () => {
    assertConfigExit(run({ SOAK_SEED: '-1' }), ["SOAK_SEED='-1'", 'uint32']);
    assertConfigExit(run({ SOAK_SEED: '4294967296' }), ["SOAK_SEED='4294967296'", 'uint32']);
});

test('T-cfg SOAK_SMOKE=yes (only 1 is accepted) and SOAK_SMOKE with SOAK_CYCLES', () => {
    assertConfigExit(run({ SOAK_SMOKE: 'yes' }), ["SOAK_SMOKE='yes'", 'exactly 1']);
    assertConfigExit(run({ SOAK_SMOKE: '1', SOAK_CYCLES: '11' }), ['SOAK_SMOKE fixes 3 cycles']);
});

test('T-cfg SOAK_KERNEL missing / wrong basename / no sibling Watch.js / no createRegistry', () => {
    assertConfigExit(run({ SOAK_KERNEL: join(TMP, 'absent', 'Signal.js') }), ['SOAK_KERNEL: kernel file not found']);
    assertConfigExit(run({ SOAK_KERNEL: join(WRONG_NAME, 'Kernel.js') }), ['must be named Signal.js']);
    assertConfigExit(run({ SOAK_KERNEL: join(NO_WATCH, 'Signal.js') }),
        ['SOAK_KERNEL: sibling Watch.js missing in', '(scratch kernels are a Signal.js + Watch.js directory pair)']);
    assertConfigExit(run({ SOAK_KERNEL: join(NO_REG, 'Signal.js') }), ['does not export createRegistry()']);
});

test('T-cfg SOAK_ENGINE=alein -> did you mean alien; SOAK_ENGINE=alien is not available in S1', () => {
    assertConfigExit(run({ SOAK_ENGINE: 'alein' }), ["unknown engine 'alein'", '(did you mean alien?)']);
    assertConfigExit(run({ SOAK_ENGINE: 'alien' }), ["engine 'alien' is not available in this build (available: lite)"]);
});

test('T-cfg SOAK_KERNEL with a non-lite SOAK_ENGINE (config, and kernel.mjs on its own)', () => {
    const env = { SOAK_ENGINE: 'polyfill', SOAK_KERNEL: join(HP, 'Signal.js') };
    assertConfigExit(run(env), ['SOAK_KERNEL is the lite-only kernel seam', "SOAK_ENGINE='polyfill'"]);
    assertConfigExit(run(env, { entry: 'kernel' }), ['SOAK_KERNEL is the lite-only kernel seam']);
});

test('T-cfg SOAK_REPLAY malformed', () => {
    assertConfigExit(run({ SOAK_REPLAY: 'GRAPH:x:y' }), ["SOAK_REPLAY='GRAPH:x:y'", '<LANE>:<cycle>:0x<seed>']);
    assertConfigExit(run({ SOAK_REPLAY: 'GRPAH:3:0x1f' }), ["SOAK_REPLAY: unknown lane 'GRPAH'", '(did you mean GRAPH?)']);
});

test('T-cfg SOAK_MUSTFAIL=cov-off:nope, a near-miss scenario, and a non cov-off mode', () => {
    assertConfigExit(run({ SOAK_MUSTFAIL: 'cov-off:nope' }), ["SOAK_MUSTFAIL: unknown scenario 'nope'"]);
    assertConfigExit(run({ SOAK_MUSTFAIL: 'cov-off:revert-after-mid-raed' }), ['(did you mean revert-after-mid-read?)']);
    assertConfigExit(run({ SOAK_MUSTFAIL: 'leak' }), ['must be cov-off:<scenario>']);
});

test('T-cfg SOAK_MUSTFAIL=cov-off:<scenario in SCENARIOS but not supported> exits 2 (S1c TASK 1; the old config parsed it)', () => {
    // diamond-write is a real GRAPH scenario, but no lane implements a switch that removes it: the old
    // parser accepted it and the run would have soaked normally under a header claiming a teeth knob.
    assert.ok(SCENARIOS.includes('diamond-write'), 'precondition: a known scenario');
    assert.ok(!Object.values(COV_OFF_SUPPORTED).some((l) => l.includes('diamond-write')), 'precondition: no lane supports it');
    assertConfigExit(run({ SOAK_MUSTFAIL: 'cov-off:diamond-write' }), ['SOAK_MUSTFAIL: cov-off:diamond-write is not supported on the selected lanes', '(supported: ']);
    // supported on NEST only: with SOAK_LANES=GRAPH it is outside the union of the SELECTED lanes
    assertConfigExit(run({ SOAK_LANES: 'GRAPH', SOAK_MUSTFAIL: 'cov-off:saved-cursor-hazard' }),
        ['cov-off:saved-cursor-hazard is not supported on the selected lanes GRAPH (supported: dep-set-flip, deep-pull)']);
});

test('cov-off: the union over the SELECTED lanes is accepted; every supported pair parses (positive control)', () => {
    for (const lane of ROSTER) {
        for (const scen of COV_OFF_SUPPORTED[lane]) {
            const c = P({ SOAK_LANES: lane, SOAK_MUSTFAIL: 'cov-off:' + scen });
            assert.deepEqual(c.mustFail, { mode: 'cov-off', scenario: scen }, lane + ' ' + scen);
        }
    }
    assert.deepEqual(P({ SOAK_LANES: 'GRAPH,NEST', SOAK_MUSTFAIL: 'cov-off:saved-cursor-hazard' }).mustFail.scenario, 'saved-cursor-hazard');
    // every scenario no roster lane supports is rejected with the default (all-lane) selection
    const all = new Set(Object.values(COV_OFF_SUPPORTED).flat());
    for (const scen of SCENARIOS) {
        if (all.has(scen)) assert.equal(P({ SOAK_MUSTFAIL: 'cov-off:' + scen }).mustFail.scenario, scen);
        else rejects({ SOAK_MUSTFAIL: 'cov-off:' + scen }, 'cov-off:' + scen + ' is not supported on the selected lanes');
    }
});

test('opts.covOffSupported is required and validated (a programmer error is a TypeError, never a silent accept)', () => {
    const base = { roster: ROSTER, scenarios: SCENARIOS, argv: [] };
    const bad = [undefined, null, [], 'GRAPH', Object.create({ GRAPH: [] }),
        { GRAPH: [], BATCH: [], ERROR: [] },                                   // a roster lane missing
        Object.assign({}, COV_OFF_SUPPORTED, { BOGUS: [] }),                   // a lane outside the roster
        Object.assign({}, COV_OFF_SUPPORTED, { GRAPH: 'dep-set-flip' }),       // not an array
        Object.assign({}, COV_OFF_SUPPORTED, { GRAPH: ['nope'] })];            // an unknown scenario
    for (const cos of bad) {
        assert.throws(() => CFG.parseConfig({}, Object.assign({ covOffSupported: cos }, base)), TypeError, String(JSON.stringify(cos)));
    }
    assert.equal(CFG.parseConfig({}, Object.assign({ covOffSupported: COV_OFF_SUPPORTED }, base)).mustFail, null);
});

test('OPS_MAX is 2^30 - 1 (Smi on every V8 build); formatReplayKey is the exact inverse of parseReplayKey', () => {
    assert.equal(CFG.OPS_MAX, 0x3FFFFFFF);
    assert.equal(CFG.gatesBlock().OPS_MAX, 0x3FFFFFFF, 'the header records it');
    rejects({ SOAK_OPS: String(2 ** 30) }, "SOAK_OPS='1073741824'");
    for (const [lane, cycle, seed] of [['BATCH', 7, 0x9a3f12c4], ['GRAPH', 0, 0], ['NEST', CFG.CYCLES_MAX - 1, 0xFFFFFFFF], ['ERROR', 12, 0x1f]]) {
        const key = CFG.formatReplayKey(lane, cycle, seed);
        assert.match(key, /^[A-Z]+:\d+:0x[0-9a-f]{1,8}$/);
        assert.deepEqual(CFG.parseReplayKey(key, ROSTER), { lane, cycle, seed }, key);
    }
    assert.equal(CFG.formatReplayKey('BATCH', 7, 0x9a3f12c4), 'BATCH:7:0x9a3f12c4');
    for (const args of [['batch', 1, 1], ['', 1, 1], [7, 1, 1], ['GRAPH', -1, 1], ['GRAPH', 1.5, 1], ['GRAPH', CFG.CYCLES_MAX, 1],
        ['GRAPH', 1, -1], ['GRAPH', 1, 2 ** 32], ['GRAPH', 1, 0.5], ['GRAPH', 1, NaN], ['GRAPH', NaN, 1], ['GRAPH', 1, '0x1f']]) {
        assert.throws(() => CFG.formatReplayKey(...args), /formatReplayKey/, JSON.stringify(args));
    }
});

test('T-cfg SOAK_OUT empty, SOAK_WRAP unknown check, SOAK_SHRINK without a replay key', () => {
    assertConfigExit(run({ SOAK_OUT: '' }), ["SOAK_OUT='' is not a path"]);
    assertConfigExit(run({ SOAK_WRAP: 'W6' }), ["SOAK_WRAP: unknown check 'W6'"]);
    assertConfigExit(run({ SOAK_SHRINK: '1' }), ['SOAK_SHRINK=1 needs a SOAK_REPLAY key']);
});

test('T-cfg missing --expose-gc exits 2 (lite-pick exited 1: L22)', () => {
    assertConfigExit(run({}, { gc: false }), ['--expose-gc is required']);
});

test('T-cfg SOAK_REQUIRE_PROVENANCE=1 with GIT_DIR=/nonexistent', () => {
    assertConfigExit(run({ SOAK_REQUIRE_PROVENANCE: '1' }, { extraEnv: { GIT_DIR: '/nonexistent' } }),
        ['SOAK_REQUIRE_PROVENANCE=1 but no git SHA']);
});

/* -- in-process matrix: boundaries, upper bounds, booleans (parseConfig is pure and throws) ------------- */

const P = (env, argv = []) => CFG.parseConfig(env, { roster: ROSTER, scenarios: SCENARIOS, covOffSupported: COV_OFF_SUPPORTED, argv });
function rejects(env, want) {
    assert.throws(() => P(env), (e) => e instanceof CFG.SoakConfigError && e.message.includes(want),
        JSON.stringify(env) + ' must be rejected with "' + want + '"');
}

test('boundary pairs and upper bounds: SOAK_CYCLES, SOAK_OPS, SOAK_SEED', () => {
    rejects({ SOAK_CYCLES: '10' }, "SOAK_CYCLES='10'");
    assert.equal(P({ SOAK_CYCLES: '11' }).cycles, 11);
    const forever = P({ SOAK_CYCLES: '0' });
    assert.equal(forever.cycles, 0);
    assert.equal(forever.forever, true);
    assert.equal(P({ SOAK_CYCLES: String(CFG.CYCLES_MAX) }).cycles, CFG.CYCLES_MAX);
    rejects({ SOAK_CYCLES: String(CFG.CYCLES_MAX + 1) }, 'SOAK_CYCLES=');
    rejects({ SOAK_CYCLES: '1e3' }, 'SOAK_CYCLES=');
    rejects({ SOAK_OPS: String(CFG.OPS_MIN - 1) }, 'SOAK_OPS=');
    assert.equal(P({ SOAK_OPS: String(CFG.OPS_MIN) }).ops, CFG.OPS_MIN);
    assert.equal(P({ SOAK_OPS: String(CFG.OPS_MAX) }).ops, CFG.OPS_MAX);
    rejects({ SOAK_OPS: String(CFG.OPS_MAX + 1) }, 'SOAK_OPS=');
    rejects({ SOAK_OPS: '' }, 'SOAK_OPS=');
    assert.equal(P({ SOAK_SEED: '0' }).seed, 0);
    assert.equal(P({ SOAK_SEED: '4294967295' }).seed, 0xFFFFFFFF);
    assert.equal(P({ SOAK_SEED: '0xffffffff' }).seed, 0xFFFFFFFF);
    rejects({ SOAK_SEED: '4294967296' }, 'uint32');
    rejects({ SOAK_SEED: '0x100000000' }, 'uint32');
    rejects({ SOAK_SEED: '' }, 'uint32');
    rejects({ SOAK_REPLAY: 'GRAPH:' + CFG.CYCLES_MAX + ':0xff' }, 'out of range');
    assert.equal(P({ SOAK_REPLAY: 'GRAPH:' + (CFG.CYCLES_MAX - 1) + ':0xff' }).replay.cycle, CFG.CYCLES_MAX - 1);
    rejects({ SOAK_REPLAY: 'GRAPH:1:0xABC' }, '<LANE>:<cycle>:0x<seed>');
});

test('every boolean key accepts exactly 1 (0, true, yes, TRUE and empty all exit 2)', () => {
    const keys = ['SOAK_SMOKE', 'SOAK_SHRINK', 'SOAK_REQUIRE_PROVENANCE', 'SOAK_REPR'];
    for (const k of keys) {
        for (const bad of ['0', 'true', 'yes', 'TRUE', '', ' 1']) rejects({ [k]: bad, SOAK_REPLAY: 'GRAPH:1:0x1' }, k + "='" + bad + "'");
        const ok = P({ [k]: '1', SOAK_REPLAY: 'GRAPH:1:0x1' });
        assert.equal(ok.record[k].value, true, k);
        assert.equal(ok.record[k].source, 'env', k);
    }
});

test('lists, engines and the smoke shape', () => {
    rejects({ SOAK_LANES: 'GRAPH,GRAPH' }, "duplicate entry 'GRAPH'");
    rejects({ SOAK_LANES: 'GRAPH,' }, 'empty entry');
    rejects({ SOAK_LANES: '' }, 'empty entry');
    assert.deepEqual(P({ SOAK_LANES: 'NEST,GRAPH' }).lanes, ['GRAPH', 'NEST']);
    rejects({ SOAK_ENGINE: '' }, "unknown engine ''");
    assert.equal(P({ SOAK_ENGINE: 'lite' }).engine, 'lite');
    rejects({ SOAK_WRAP: 'W1,W1' }, 'duplicate');
    const smoke = P({ SOAK_SMOKE: '1' });
    assert.deepEqual([smoke.cycles, smoke.ops], [CFG.SMOKE_CYCLES, CFG.SMOKE_OPS]);
    rejects({ SOAK_SMOKE: '1', SOAK_OPS: '50000' }, 'SOAK_SMOKE fixes 20000 ops');
    const d = P({});
    assert.deepEqual([d.cycles, d.ops, d.seed, d.engine, d.mustFail, d.replay], [11, 100000, 0xC0FFEE, 'lite', null, null]);
    for (const k of CFG.KNOWN_KEYS) assert.ok(d.record[k], 'record carries ' + k);
});

test('the SOAK_ prefix is case-insensitive: a non-upper-case known key is an error naming the upper-case key', () => {
    rejects({ soak_lanes: 'grpah' }, "env key 'soak_lanes' must be upper-case (did you mean SOAK_LANES?)");
    rejects({ Soak_Require_Provenance: '1' }, 'did you mean SOAK_REQUIRE_PROVENANCE?');
    rejects({ soak_nope: '1' }, "unknown env key 'soak_nope'");
    assert.equal(P({ SOAKY: '1', MY_SOAK_LANES: 'x' }).lanes.length, 4, 'only the SOAK_ prefix is reserved');
});

test('did-you-mean is computed on the suffix: SOAK_X, SOAK_FOO and SOAK_TIME no longer "mean" SOAK_OPS', () => {
    for (const k of ['SOAK_X', 'SOAK_FOO', 'SOAK_TIME']) {
        assert.throws(() => P({ [k]: '1' }), (e) => e.message === "unknown env key '" + k + "'", k);
    }
    rejects({ SOAK_SEEDS: '1' }, '(did you mean SOAK_SEED?)');
    rejects({ SOAK_OP: '1' }, '(did you mean SOAK_OPS?)');
});

test('gatesBlock() keys equal the exported constants, value for value (L20: the header omits nothing)', () => {
    const block = CFG.gatesBlock();
    const exported = Object.keys(CFG).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k) && k !== 'KNOWN_KEYS').sort();
    assert.deepEqual(Object.keys(block).sort(), exported);
    for (const k of exported) assert.deepEqual(block[k], JSON.parse(JSON.stringify(CFG[k])), k);
    block.CHECK_P = 1;
    assert.equal(CFG.gatesBlock().CHECK_P, 0.4, 'a fresh copy each call');
});

/* -- spawned: end-to-end lower-case key, existing SOAK_OUT, strict required provenance ------------------ */

test('T-cfg soak_lanes=grpah (lower-case key) exits 2 instead of running every lane', () => {
    assertConfigExit(run({ soak_lanes: 'grpah' }), ["env key 'soak_lanes' must be upper-case (did you mean SOAK_LANES?)"]);
});

test('T-cfg an existing SOAK_OUT is never truncated: exit 2, file unchanged', () => {
    const out = join(TMP, 'existing.jsonl');
    writeFileSync(out, 'previous run\n');
    const r = run({ SOAK_OUT: out }, { entry: 'inline' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^soak: CONFIG -- SOAK_OUT: .* already exists/);
    assert.equal(r.stdout, '');
    assert.equal(readFileSync(out, 'utf8'), 'previous run\n');
});

// A copy of bench/soak inside the git-ignored bench/soak/out/, so git still sees the repository while the
// copy's parity.json / controls.json can be broken. ROOT of the copy = <copy>/ (it holds Signal.js + Watch.js).
function provenanceCopy() {
    mkdirSync(join(SOAK, 'out'), { recursive: true });
    const dir = mkdtempSync(join(SOAK, 'out', 'cfgtest-'));
    after(() => { rmSync(dir, { recursive: true, force: true }); });
    const soak = join(dir, 'bench', 'soak');
    mkdirSync(soak, { recursive: true });
    // The entry's runtime modules, plus EVERY parity-pinned file (the same rule as test/40 parityLayout), so
    // the copy cannot go stale when PARITY_FILES grows.
    const runtime = ['config.mjs', 'kernel.mjs', 'provenance.mjs', 'parity.mjs', 'seeds.mjs', 'jsonl.mjs', 'controls.json']
        .map((x) => 'bench/soak/' + x);
    for (const rel of new Set(runtime.concat(PARITY_FILES))) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        copyFileSync(join(ROOT, rel), join(dir, rel));
    }
    const up = spawnSync(process.execPath, [join(soak, 'parity.mjs'), '--update'], { encoding: 'utf8' });
    assert.equal(up.status, 0, up.stderr);
    return { dir, soak, base: pathToFileURL(soak).href + '/' };
}

test('required provenance admits no unknown: dirty state, parity or controls unknown -> exit 2 (control: intact copy passes)', () => {
    const C = provenanceCopy();
    const env = { SOAK_REQUIRE_PROVENANCE: '1', SOAK_LANES: 'GRAPH' };
    const okRun = run(env, { base: C.base });
    assert.equal(okRun.status, 3, 'intact copy: ' + okRun.stderr);

    const idx = join(TMP, 'index-is-a-dir');
    mkdirSync(idx, { recursive: true });
    assertConfigExit(run(env, { base: C.base, extraEnv: { GIT_INDEX_FILE: idx } }), ['git dirty state is unknown']);

    const pins = readFileSync(join(C.soak, 'parity.json'), 'utf8');
    writeFileSync(join(C.soak, 'parity.json'), '{"files": [1]}');
    assertConfigExit(run(env, { base: C.base }), ['parity is unknown']);
    writeFileSync(join(C.soak, 'parity.json'), pins);

    unlinkSync(join(C.soak, 'controls.json'));
    assertConfigExit(run(env, { base: C.base }), ['control kernels are unknown']);
    const lenient = run({ SOAK_LANES: 'GRAPH' }, { base: C.base });
    assert.equal(lenient.status, 3, 'without SOAK_REQUIRE_PROVENANCE the unknown is recorded, not fatal: ' + lenient.stderr);
});

/* -- argv: config.mjs is the only parser; --smoke is the one door ------------------------------------- */

test('argv: --smoke equals SOAK_SMOKE=1; any other argument, a duplicate or a conflicting SOAK_SMOKE is rejected', () => {
    const s = P({}, ['--smoke']);
    assert.deepEqual([s.smoke, s.cycles, s.ops], [true, CFG.SMOKE_CYCLES, CFG.SMOKE_OPS]);
    assert.deepEqual(s.record.SOAK_SMOKE, { value: true, source: 'argv' });
    assert.deepEqual(P({ SOAK_SMOKE: '1' }, ['--smoke']).record.SOAK_SMOKE, { value: true, source: 'argv' }, '--smoke is the door even when SOAK_SMOKE=1 agrees');
    for (const bad of ['0', 'yes', 'true', '']) {
        assert.throws(() => P({ SOAK_SMOKE: bad }, ['--smoke']), /--smoke conflicts with SOAK_SMOKE/, bad);
    }
    assert.throws(() => P({}, ['--smoke', '--smoke']), /duplicate argument '--smoke'/);
    for (const a of ['--smok', 'smoke', '--SMOKE', '--lanes=GRAPH', '-s', '']) {
        assert.throws(() => P({}, [a]), (e) => e instanceof CFG.SoakConfigError && e.message.startsWith("unknown argument '" + a + "'"), a);
    }
    assert.throws(() => P({}, ['--smoke', 'extra']), /unknown argument 'extra'/);
    assert.throws(() => P({ SOAK_CYCLES: '11' }, ['--smoke']), (e) => e.message.startsWith('--smoke fixes 3 cycles'));
    assert.throws(() => P({ SOAK_OPS: '50000' }, ['--smoke']), (e) => e.message.startsWith('--smoke fixes 20000 ops'));
    assert.throws(() => P({ SOAK_SMOKE: '1', SOAK_OPS: '50000' }, ['--smoke']), (e) => e.message.startsWith('--smoke fixes 20000 ops'));
    assert.throws(() => P({ SOAK_SMOKE: '1', SOAK_OPS: '50000' }), (e) => e.message.startsWith('SOAK_SMOKE fixes 20000 ops'));
    assert.throws(() => CFG.parseConfig({}, { roster: ROSTER, scenarios: SCENARIOS, covOffSupported: COV_OFF_SUPPORTED }), TypeError, 'argv is required');
});

test('T-cfg argv end to end: --bogus and --smoke with SOAK_SMOKE=0 exit 2; --smoke alone runs as smoke', () => {
    assertConfigExit(run({}, { argv: ['--bogus'] }), ["unknown argument '--bogus'"]);
    assertConfigExit(run({ SOAK_SMOKE: '0' }, { argv: ['--smoke'] }), ["--smoke conflicts with SOAK_SMOKE='0'"]);
    const r = run({ SOAK_LANES: 'GRAPH' }, { entry: 'inline', argv: ['--smoke'] });
    assert.equal(r.status, 3, r.stderr);
    const h = JSON.parse(readFileSync(r.out, 'utf8').split('\n')[0]);
    assert.deepEqual(h.config.SOAK_SMOKE, { value: true, source: 'argv' });
    assert.deepEqual(h.config.SOAK_OPS, { value: CFG.SMOKE_OPS, source: 'default' });
});

/* -- gitDirty counts untracked, non-ignored files ---------------------------------------------------- */

test('gitDirty: clean -> false; repo-ignored -> false; one untracked .mjs -> true, whatever user/env config says', () => {
    // Scratch work tree = `git archive HEAD` (from the TOP LEVEL: in a subdirectory, git archive packs only
    // that subdirectory), paired with this repository's object store and a SCRATCH index (GIT_DIR /
    // GIT_WORK_TREE / GIT_INDEX_FILE). Nothing is written to the real index or history. Global and system
    // config are neutralised for the CONTROL rows; the hostile rows then inject config that hides files.
    const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    assert.ok(gitDir.length > 0, 'a git repository');
    const W = join(TMP, 'gitwork');
    mkdirSync(W);
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    const arch = spawnSync('git', ['archive', 'HEAD'], { cwd: top, maxBuffer: 1 << 28 });
    assert.equal(arch.status, 0, String(arch.stderr));
    const tar = spawnSync('tar', ['-x', '-C', W], { input: arch.stdout });
    assert.equal(tar.status, 0, String(tar.stderr));
    const genv = {};
    for (const k of Object.keys(process.env)) if (k.indexOf('GIT_') !== 0 && k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') genv[k] = process.env[k];
    Object.assign(genv, {
        GIT_DIR: gitDir, GIT_WORK_TREE: W, GIT_INDEX_FILE: join(TMP, 'gitwork.index'),
        GIT_CONFIG_GLOBAL: join(TMP, 'no-global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    });
    const rt = spawnSync('git', ['read-tree', 'HEAD'], { cwd: W, env: genv, encoding: 'utf8' });
    assert.equal(rt.status, 0, rt.stderr);
    const probe = (extra = {}) => {
        const r = spawnSync(process.execPath, ['--input-type=module', '-e',
            'const { gitInfo } = await import(' + JSON.stringify(SOAK_URL + 'provenance.mjs') + '); process.stdout.write(JSON.stringify(gitInfo()));'],
        { cwd: ROOT, env: { ...genv, ...extra }, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
    };
    const plainStatus = (extra = {}) => spawnSync('git', ['status', '--porcelain'], { cwd: W, env: { ...genv, ...extra }, encoding: 'utf8' }).stdout.trim();

    const clean = probe();
    assert.equal(typeof clean.sha, 'string');
    assert.equal(clean.dirty, false, 'control: the archived HEAD tree is clean');
    // A REPOSITORY ignore rule (a self-ignoring out/.gitignore, standing in for /bench/soak/out/ in the
    // tracked .gitignore, which HEAD predates) keeps the provenanceCopy location clean.
    mkdirSync(join(W, 'bench', 'soak', 'out', 'cfgtest-x'), { recursive: true });
    writeFileSync(join(W, 'bench', 'soak', 'out', '.gitignore'), '*\n');
    writeFileSync(join(W, 'bench', 'soak', 'out', 'cfgtest-x', 'model.mjs'), 'export const x = 1;\n');
    assert.equal(probe().dirty, false, 'a repo-ignored path (bench/soak/out/) stays clean');
    writeFileSync(join(W, 'bench', 'soak', 'model.mjs'), 'export const x = 1;\n');
    assert.equal(probe().dirty, true, 'one untracked, non-ignored .mjs makes the tree dirty');

    // Hostile config rows. Each one really hides the file from a plain `git status --porcelain` (asserted),
    // and the probe must still read dirty.
    const hidesUntracked = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'status.showUntrackedFiles', GIT_CONFIG_VALUE_0: 'no' };
    const excludes = join(TMP, 'hostile-excludes');
    writeFileSync(excludes, '/bench/soak/model.mjs\n');
    const excludesEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludes };
    const globalCfg = join(TMP, 'hostile-global-gitconfig');
    writeFileSync(globalCfg, '[core]\n\texcludesFile = ' + excludes + '\n[status]\n\tshowUntrackedFiles = no\n');
    const globalEnv = { GIT_CONFIG_GLOBAL: globalCfg };
    for (const [label, extra] of [['status.showUntrackedFiles=no (env config)', hidesUntracked],
        ['core.excludesFile listing the file (env config)', excludesEnv],
        ['global gitconfig with both', globalEnv]]) {
        assert.equal(plainStatus(extra), '', label + ': the hostile config really hides the file from plain git status');
        assert.equal(probe(extra).dirty, true, label + ': gitDirty must still be true');
    }
});

// ---- QA burst 3b (2026-10-12): boundary matrix, appended -------------------------------------------------

test('QA boundary SOAK_OPS: OPS_MIN - 1, OPS_MIN, 2^30 - 1 accepted at the edges; 2^31 - 1, 2^31, 2^32, 2^53, -1, -0, NaN, empty rejected', () => {
    assert.equal(P({ SOAK_OPS: String(CFG.OPS_MIN) }).ops, CFG.OPS_MIN);
    assert.equal(P({ SOAK_OPS: String(2 ** 30 - 1) }).ops, 2 ** 30 - 1);
    for (const v of [CFG.OPS_MIN - 1, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1, 2 ** 53, -1, '-0', 'NaN', '', ' ', '1e5', '0x400', 'null', 'undefined']) {
        assert.throws(() => P({ SOAK_OPS: String(v) }), CFG.SoakConfigError, 'SOAK_OPS=' + String(v));
    }
});

test('QA boundary formatReplayKey: cycle 0 and CYCLES_MAX - 1, seed 0 and 2^32 - 1 round-trip; CYCLES_MAX, -1, -0 seed, 2^32, NaN throw or normalise', () => {
    for (const [cycle, seed] of [[0, 0], [CFG.CYCLES_MAX - 1, 0xFFFFFFFF], [1, 2 ** 31], [2 ** 27, 2 ** 30]]) {
        const key = CFG.formatReplayKey('GRAPH', cycle, seed);
        assert.deepEqual(CFG.parseReplayKey(key, ROSTER), { lane: 'GRAPH', cycle, seed }, key);
    }
    assert.equal(CFG.formatReplayKey('GRAPH', -0, -0), 'GRAPH:0:0x0', '-0 formats as 0');
    for (const [c, s] of [[CFG.CYCLES_MAX, 0], [-1, 0], [NaN, 0], [0, 2 ** 32], [0, -1], [0, NaN], [0.5, 0], [null, 0], [0, undefined]]) {
        assert.throws(() => CFG.formatReplayKey('GRAPH', c, s), RangeError, 'cycle ' + String(c) + ' seed ' + String(s));
    }
    for (const lane of ['', 'graph', null, undefined, 'GR1']) assert.throws(() => CFG.formatReplayKey(lane, 0, 0), TypeError, 'lane ' + String(lane));
});
