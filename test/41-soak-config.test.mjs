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
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as CFG from '../bench/soak/config.mjs';
import { PARITY_FILES } from '../bench/soak/parity.mjs';
import { derive as nwDerive } from '../bench/soak/nearwrap.mjs';
import { createHash } from 'node:crypto';
// lanes/index.mjs is kernel-free (gen-side only): the cov-off universe is IMPORTED, never copied.
import { COV_OFF_SUPPORTED } from '../bench/soak/lanes/index.mjs';
import { validate } from '../bench/soak/divergences.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOAK = join(ROOT, 'bench', 'soak');
const MAIN = join(SOAK, 'main.mjs');
const SOAK_URL = pathToFileURL(SOAK).href + '/';

// SPEC-B v2 section 5.1 (S1 roster + S3 R1 HOOK + S3 R2 LIFECYCLE + R3 OWNER + R4a RECYCLE + R4c SCHEDULER, scenario ids). Used only by the inline entry; main.mjs brings its own.
const ROSTER = ['GRAPH', 'BATCH', 'ERROR', 'NEST', 'WIE', 'HOOK', 'LIFECYCLE', 'OWNER', 'RECYCLE', 'SCHEDULER'];
const SCENARIOS = [
    'diamond-write', 'dep-set-flip', 'deep-pull', 'second-invalidation', 'equality-cutoff', 'adversarial-equality', 'wide-mark',
    'revert-after-mid-read', 'revert-no-read', 'nested-close', 'throw-in-batch', 'effect-created-mid-batch', 'multi-write-same-signal',
    'throw-dep-effect-prewalk', 'throw-dep-computed-prewalk', 'recovery-after-throw', 'aggregate', 'throwing-equals', 'cycle-error-surfaces',
    'saved-cursor-hazard', 'live-cursor-hazard', 'child-first-run-dispose', 'nested-computed-dispose', 'untrack-dispose', 'outer-computed',
    'early-exit-after-dispose', 'lifecycle-callback-dispose', 'lifecycle-dispose-recycle', 'dispose-outer-observer',
    'wie-stale-effect', 'wie-stale-computed', 'wie-prewalk', 'wie-untrack', 'wie-write-before-read',
    'hook-multi', 'hook-non-lifo-off', 'hook-mirror-dispose', 'hook-recompute',
    'lc-two-regs', 'lc-off-sibling', 'lc-late-off-recycle', 'lc-callback-dispose', 'lc-callback-register', 'lc-callback-off-sibling',
    'own-cascade', 'own-rerun', 'own-computed', 'cleanup-fifo', 'run-with-owner', 'run-with-dead-owner', 'root-detached',
    'signal-not-adopted',
    'stale-write-recycled', 'stale-peek-recycled', 'stale-read-recycled', 'stale-dispose-recycled', 'stale-dead-unrecycled', 'multi-gen',
    'thunk-after-dispose', 'thunk-recycled', 'pending-write', 'partial-drain', 'drain-all', 'hold-retry', 'fifo-delivery', 'lifo-delivery',
];
// unit 0s B2 (PLAN-0s-wie ADDENDUM 2 item 6): the two literals above are pinned to the code they stand in for
import { SCENARIOS as LIT_SCENARIOS_CODE } from '../bench/soak/scenarios.mjs';
import { ROSTER as LIT_ROSTER_CODE } from '../bench/soak/lanes/index.mjs';
test('the ROSTER (10 lanes, SCHEDULER 10th) and SCENARIOS (66 ids) literals equal lanes/index.mjs ROSTER and scenarios.mjs SCENARIOS', () => {
    assert.equal(ROSTER.length, 10);
    assert.equal(SCENARIOS.length, 66);
    assert.deepEqual(ROSTER, LIT_ROSTER_CODE.slice());
    assert.deepEqual(SCENARIOS, LIT_SCENARIOS_CODE.slice());
});

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
    assert.equal(h.seedRemapCollision, null, 'default base, 1 lane (GRAPH), 11 cycles: the remap pair is out of reach');
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
    assertConfigExit(run({ SOAK_MUSTFAIL: 'cov-off:diamond-write' }),
        ['SOAK_MUSTFAIL: cov-off:diamond-write is not supported on the selected lanes', '(supported: ']);
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

// F6: gitInfo scrubs the repo-LOCATING GIT_* vars (GIT_SCRUB_ENV), so a provenance test reaches another tree only
// through a real throwaway repository. Every git spawned here runs with no inherited GIT_* var, no global or system
// config and a fixed identity; commits go through plumbing (no hooks, no signing, no user config).
function gitEnv() {
    const env = {};
    for (const k of Object.keys(process.env)) {
        if (k.indexOf('GIT_') !== 0 && k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') {
            env[k] = process.env[k];
        }
    }
    return Object.assign(env, { GIT_CONFIG_GLOBAL: join(TMP, 'no-global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'soak-cfg', GIT_AUTHOR_EMAIL: 'soak-cfg@invalid', GIT_COMMITTER_NAME: 'soak-cfg', GIT_COMMITTER_EMAIL: 'soak-cfg@invalid' });
}
function git(cwd, args) {
    const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
    assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
    return r.stdout.trim();
}
/** One plumbing commit of every non-ignored file under `dir` (an initialised repository) on HEAD. Returns the SHA. */
function gitCommitAll(dir) {
    git(dir, ['add', '-A']);
    const sha = git(dir, ['commit-tree', '--no-gpg-sign', '-m', 'soak cfg test', git(dir, ['write-tree'])]);
    git(dir, ['update-ref', 'HEAD', sha]);
    return sha;
}

test('T-cfg SOAK_REQUIRE_PROVENANCE=1 in a repository with zero commits: no git SHA (control: one commit -> exit 3)', () => {
    // GIT_DIR=/nonexistent no longer reaches gitInfo (F6). A provenanceCopy that is its OWN repository, with no
    // commit, has no HEAD to resolve.
    const C = provenanceCopy();
    git(C.dir, ['init', '-q']);
    const env = { SOAK_REQUIRE_PROVENANCE: '1', SOAK_LANES: 'GRAPH' };
    assertConfigExit(run(env, { base: C.base }), ['SOAK_REQUIRE_PROVENANCE=1 but no git SHA']);
    const sha = gitCommitAll(C.dir);
    const ok = run(env, { base: C.base });
    assert.equal(ok.status, 3, 'control, one commit: ' + ok.stderr);
    assert.equal(JSON.parse(readFileSync(ok.out, 'utf8').split('\n')[0]).gitSha, sha, 'control: the header stamps the copy\'s own commit');
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
    assert.equal(P({ SOAKY: '1', MY_SOAK_LANES: 'x' }).lanes.length, 10, 'only the SOAK_ prefix is reserved');
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
    // the copy cannot go stale when PARITY_FILES grows. b93: provenance.mjs imports lanes/index.mjs, whose kinds.mjs
    // reaches the torture value pool (bench/torture/helpers/index.mjs, not a parity file).
    const runtime = ['config.mjs', 'kernel.mjs', 'nearwrap.mjs', 'provenance.mjs', 'parity.mjs', 'seeds.mjs', 'jsonl.mjs', 'controls.json']
        .map((x) => 'bench/soak/' + x).concat(['bench/torture/helpers/index.mjs']);
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

    // Dirty state unknown: a COMMITTED nested copy (its own repository) whose index is a DIRECTORY, so git status
    // fails while rev-parse HEAD still works (F6: an inherited GIT_INDEX_FILE no longer reaches gitInfo).
    const N = provenanceCopy();
    git(N.dir, ['init', '-q']);
    const nSha = gitCommitAll(N.dir);
    const nOk = run(env, { base: N.base });
    assert.equal(nOk.status, 3, 'control, nested copy with its index intact: ' + nOk.stderr);
    const nHead = JSON.parse(readFileSync(nOk.out, 'utf8').split('\n')[0]);
    assert.deepEqual([nHead.gitSha, nHead.gitDirty, nHead.gitError], [nSha, false, null], 'control: the header describes the nested copy');
    const index = join(N.dir, '.git', 'index');
    rmSync(index);
    mkdirSync(index);
    assertConfigExit(run(env, { base: N.base }), ['git dirty state is unknown']);

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
    // W = a throwaway repository committed via plumbing (F6: gitInfo scrubs GIT_DIR / GIT_WORK_TREE /
    // GIT_INDEX_FILE, so the probe reaches W only through the code-only gitInfo(root) seam). Its tracked
    // .gitignore carries /bench/soak/out/, like this repository's. Global and system config are neutralised for
    // the CONTROL rows; the hostile rows then inject config (inherited by gitInfo: GIT_CONFIG_* are not
    // scrubbed) that hides files.
    const W = join(TMP, 'gitwork');
    mkdirSync(join(W, 'bench', 'soak'), { recursive: true });
    const genv = gitEnv();
    git(W, ['init', '-q']);
    writeFileSync(join(W, '.gitignore'), '/bench/soak/out/\n');
    writeFileSync(join(W, 'bench', 'soak', 'a.mjs'), 'export const a = 1;\n');
    const sha = gitCommitAll(W);
    const probe = (extra = {}) => {
        const r = spawnSync(process.execPath, ['--input-type=module', '-e',
            'const { gitInfo } = await import(' + JSON.stringify(SOAK_URL + 'provenance.mjs') + '); process.stdout.write(JSON.stringify(gitInfo(' + JSON.stringify(W) + ')));'],
        { cwd: ROOT, env: { ...genv, ...extra }, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
    };
    const plainStatus = (extra = {}) => spawnSync('git', ['status', '--porcelain'], { cwd: W, env: { ...genv, ...extra }, encoding: 'utf8' }).stdout.trim();

    assert.deepEqual(probe(), { sha, dirty: false, error: null }, 'control: the committed throwaway tree is clean');
    // A REPOSITORY ignore rule (/bench/soak/out/ in W's tracked .gitignore) keeps the provenanceCopy location clean.
    mkdirSync(join(W, 'bench', 'soak', 'out', 'cfgtest-x'), { recursive: true });
    writeFileSync(join(W, 'bench', 'soak', 'out', 'cfgtest-x', 'model.mjs'), 'export const x = 1;\n');
    assert.equal(probe().dirty, false, 'a repo-ignored path (bench/soak/out/) stays clean');
    writeFileSync(join(W, 'bench', 'soak', 'cfgtest-untracked.mjs'), 'export const x = 1;\n');
    assert.equal(plainStatus(), '?? bench/soak/cfgtest-untracked.mjs', 'control: plain git status sees the file');
    assert.equal(probe().dirty, true, 'one untracked, non-ignored .mjs makes the tree dirty');

    // Positive control: env config (GIT_CONFIG_*) still REACHES gitInfo (amendment 14: only the repo-locating vars
    // are scrubbed). A malformed GIT_CONFIG_COUNT makes every git fail; a probe that scrubbed it would return a SHA
    // and leave the hostile rows below passing vacuously.
    const reach = probe({ GIT_CONFIG_COUNT: '1' });
    assert.equal(reach.sha, null, 'GIT_CONFIG_COUNT must reach gitInfo: ' + JSON.stringify(reach));
    assert.match(String(reach.error), /GIT_CONFIG_KEY_0/);

    // Hostile config rows. Each one really hides the file from a plain `git status --porcelain` (asserted),
    // and the probe must still read dirty.
    const hidesUntracked = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'status.showUntrackedFiles', GIT_CONFIG_VALUE_0: 'no' };
    const excludes = join(TMP, 'hostile-excludes');
    writeFileSync(excludes, '/bench/soak/cfgtest-untracked.mjs\n');
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

// ---- S1d B6 (burst 8): the calibration drift guard (SPEC-B-S1cd TASK 11; the lite-pick LP pattern) -------
//
// bench/soak/calibration/soak-calibration.json is the evidence for DEFAULT_OPS, SCEN_MIN(_SMOKE),
// CHECK_FLOOR(_SMOKE) and TAINT_SKIP_MAX; calibration/calibrate.mjs cut it. calibrationProblems(doc, C, shaOf)
// is the static seam (pure: doc, constants and a file-hash function in, problem strings out), so every
// must-fail runs on a copy:
//   (a) the cut matches config: seed, cycles, ops, smoke shape, OPS_MIN, GEN_VERSION, CHECK_P, WORLD_STEPS,
//       LARGE_WORLD_EVERY; doc.constants == config (a constant never moves while the JSON stays stale); the
//       binding kernels are calibrate.mjs KERNELS; the roster and each lane's required scenarios / oracles
//   (p) every PINNED file (gen, exec, oracles, lanes, adapters, kinds, the torture value pool) and every binding
//       kernel file still has the sha it had at the cut; a moved file is red with the recut command. main.mjs and
//       calibrate.mjs are NOT pinned (addendum 16): the live smoke + probe folds below gate main's loop
//   (b) every required scenario on every binding kernel: >= SCEN_MIN at full, >= SCEN_MIN_SMOKE in smoke
//   (c) every applicable oracle's PERFORMED count: >= CHECK_FLOOR at full, >= CHECK_FLOOR_SMOKE in smoke
//   (d) every applicable skip ratio, computed EXACTLY from the counts as gates.mjs does, <= TAINT_SKIP_MAX
//       (full and smoke); the stored ratio equals it; no crash in the binding cut
//   (e) the gates are not toothless (b74 D4: global over kernelsOf(roster), FULL-LENGTH cells only -- failingWorlds 0,
//       worlds > 0): at DEFAULT_CYCLES x OPS_MIN at least one full-length hollowVolume row falls below CHECK_FLOOR;
//       CHECK_FLOOR_SMOKE >= 1/8 of the least full-length smoke cell; every clean sweep cell's skip ratio stays at or
//       below TAINT_SKIP_MAX (the headpatched NEST cov-off sweep must hold exactly COVOFF_SEEDS; its skip ratio is
//       REPORTED only since b70 D6 V1 -- it was ~80% blanket frame taint; PLAN-0s-d6 ADDENDUM 1 item 2: the
//       taint-skip must-fail is P-NEST-TAINT-HALF in test/67, cov-off stays the coverage gate's case);
//       every covOff cell and every covOffSweep cell (each kernel on the lanes it cuts, lanesFor) has hits
//       < SCEN_MIN_SMOKE (a cov-off switch that leaks hits lets the hollow run clear coverage)
//   (f) b74 D4: every rostered lane has FULL-LENGTH evidence: >= 1 kernel of kernelsFor(lane) whose full AND smoke
//       cells both have failingWorlds 0 (a count: null is not zero) and worlds > 0. A fail-stopped cell (every world
//       fails early: headpatched NEST 33885/33885 at 32.5 ops/world) confounds every length-dependent count (O7a, the
//       rare scenarios, taint). TWO exemptions: ERROR (maintainer ruling b74), only while DIV-F22 is open
//       (fixedIn === null) in bench/soak/divergences.json (b103 R13.3: DIV-F6, closed in A2-FIX-T, left the set; b109:
//       DIV-F5, closed in A3-FIX-R, left it; the 'b103 (f)' row pins ruled set == open set); closed (or absent) is
//       red (cut ERROR on tree, drop the exemption). LIFECYCLE was exempt while DIV-D3-independent-registrations was
//       open (b111 A1 Q1); b117: DIV-D3 fixedIn A5a, so LIFECYCLE left the set and needs full-length evidence like
//       every other lane. An exemption set other than exactly {ERROR: [DIV-F22]} is red
//   (q) doc.probe is the calibrate.mjs PROBE (lane, kernel, cycles, ops); PROBE.cycles === MIN_ACTIVE_CYCLES (main
//       rejects SOAK_CYCLES below it); every one of the probe's cycles ran >= 1 LARGE world
// Per-lane kernel map (b67 B2a, D7): every kernel x lane check runs kernel-major over calibrate.mjs kernelsOf(roster),
// each kernel on the lanes it is bound to (lanesFor); doc.kernels keys == kernelsOf (a); a cell on a lane its kernel
// does not cut is red (a); a lane-only kernel (tree: NEST, WIE) must carry parity.json's shas (p) and gets (a) (p)
// (b)-(d), the clean-sweep taint check and, since b74 D4, the global full-length (e) hollow / smoke-floor checks.
// The live check spawns the REAL main.mjs --smoke on every kernel of kernelsOf(roster) (headpatched, lite-1.5.2,
// tree; each on its lanesFor) and main.mjs on PROBE (all four concurrently) and folds their cycle records, which must equal kernels.<k>.smoke and probe.fold exactly: the
// JSON was not hand-edited and neither main nor gen / exec / oracles drifted. Only the smoke cells and the
// probe are re-measured live; the full-shape cells are not (accepted LP design: (p) pins the gen-side code that
// cut them, and a recut dies unless the DEFAULT main.mjs run folds to kernels.<k>.full too). A GRAPH smoke
// cycle (~45 worlds) never reaches its first LARGE world (index 63); the probe (11 x 33000 ops, ~70 worlds a
// cycle) runs exactly one, so a drift in main's large-world choice turns the live probe fold red.

import { LANES as B6_LANES, ROSTER as B6_ROSTER } from '../bench/soak/lanes/index.mjs';
import { SKIP_NAMES as B6_SKIP_NAMES } from '../bench/soak/exec.mjs';
import { KERNELS as B6_KERNELS, PINNED as B6_PINNED, PROBE as B6_PROBE, COVOFF_SEEDS as B6_COVOFF_SEEDS, sha256File as b6Sha, foldMainRecords, runMainSmoke, runMainProbe } from '../bench/soak/calibration/calibrate.mjs';
import {
    LANE_ONLY_KERNELS as B6_LANE_ONLY, kernelsFor as b6KernelsFor, kernelsOf as b6KernelsOf, lanesFor as b6LanesFor,
    kernelPath as b6KernelPath, pinnedFor as b6PinnedFor, LANE_PINS as B6_LANE_PINS,
} from '../bench/soak/calibration/calibrate.mjs';
import { WIE as B6_WIE } from '../bench/soak/lanes/wie.mjs';

const B6_JSON = join(SOAK, 'calibration', 'soak-calibration.json');
const B6_DOC = JSON.parse(readFileSync(B6_JSON, 'utf8'));
// parity.json files: a lane-only kernel's evidence must be this engine (D7: tree's Signal.js / Watch.js shas)
const B6_PARITY_FILES = JSON.parse(readFileSync(join(SOAK, 'parity.json'), 'utf8')).files;
const B6_RECUT = 'recut: node bench/soak/calibration/calibrate.mjs --write bench/soak/calibration/soak-calibration.json (~13 min, untimed), then review the JSON diff';
const b6Copy = (x) => JSON.parse(JSON.stringify(x));
const b6Has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const b6ShaOf = (rel) => { try { return b6Sha(join(ROOT, rel)); } catch { return null; } };
const B6_CONST_KEYS = ['DEFAULT_OPS', 'SMOKE_OPS', 'SCEN_MIN', 'SCEN_MIN_SMOKE', 'CHECK_FLOOR', 'CHECK_FLOOR_SMOKE', 'TAINT_SKIP_MAX'];

const B6_PROBE_KEYS = ['lane', 'kernel', 'cycles', 'ops'];
const b6Count = (n) => Number.isSafeInteger(n) && n >= 0;   // null / undefined / NaN are not a count (null is not zero)
// a cov-off sweep cell list must hold exactly COVOFF_SEEDS, in order (no duplicate, missing or extra seed)
const b6SeedsOk = (cells) => JSON.stringify(cells.map((c) => (c || {}).seed)) === JSON.stringify(B6_COVOFF_SEEDS);
// (f) b74 D4: a full-length cell ran every world to its end (no world failed) -- counts, never null
const b6FullLength = (f) => f !== null && typeof f === 'object' && b6Count(f.failingWorlds) && f.failingWorlds === 0
    && b6Count(f.worlds) && f.worlds > 0;
// the ONE (f) exemption the maintainer ruled (b74): ERROR, while one of these divergences is open
// b103 R13.3: DIV-F6 dropped (fixed, A2-FIX-T); b109: DIV-F5 dropped (fixed, A3-FIX-R); b111 A1 Q1: + LIFECYCLE while DIV-D3 is open;
// b117: LIFECYCLE dropped (DIV-D3 fixed, A5a)
const B6_F_EXEMPT_RULED = '{"ERROR":["DIV-F22"]}';
const B6_F_EXEMPT = Object.freeze(JSON.parse(B6_F_EXEMPT_RULED));
const B6_DIVS = JSON.parse(readFileSync(join(SOAK, 'divergences.json'), 'utf8'));
// the ids of `ids` still open in a divergences doc: an entry with fixedIn === null (absent = closed: fail closed)
const b6DivOpen = (ids, divs) => {
    const es = divs !== null && typeof divs === 'object' && Array.isArray(divs.entries) ? divs.entries : [];
    return (Array.isArray(ids) ? ids : []).filter((id) => es.some((e) => e !== null && typeof e === 'object' && e.id === id && e.fixedIn === null));
};
// a lane exempt from (f) right now (b6Min feeds its fail-stopped cells while this holds: SCEN_MIN's ERROR binding)
const b6FExempt = (lane, divs = B6_DIVS, exempt = B6_F_EXEMPT) => b6Has(exempt, lane) && b6DivOpen(exempt[lane], divs).length > 0;

function calibrationProblems(doc, C, shaOf = b6ShaOf, probe = B6_PROBE, lanes = B6_LANES, parity = B6_PARITY_FILES, divs = B6_DIVS, exempt = B6_F_EXEMPT) {
    const p = [];
    const names = lanes.map((d) => d.name);
    const ks = b6KernelsOf(names);   // kernel-major: binding kernels, then lane-only kernels some lane binds
    const cut = doc.cut || {};
    for (const [k, want] of [['seed', C.DEFAULT_SEED], ['cycles', C.DEFAULT_CYCLES], ['ops', C.DEFAULT_OPS], ['smokeCycles', C.SMOKE_CYCLES],
        ['smokeOps', C.SMOKE_OPS], ['opsMin', C.OPS_MIN], ['genVersion', C.GEN_VERSION], ['checkP', C.CHECK_P], ['worldSteps', C.WORLD_STEPS],
        ['largeWorldEvery', C.LARGE_WORLD_EVERY]]) {
        if (cut[k] !== want) p.push('(a) cut.' + k + '=' + cut[k] + ' != config ' + want + '; ' + B6_RECUT);
    }
    for (const k of B6_CONST_KEYS) {
        const got = b6Has(doc.constants, k) ? doc.constants[k] : null;
        if (got !== C[k]) p.push('(a) constants.' + k + '=' + got + ' != config ' + C[k] + ' (a constant moved without a recut); ' + B6_RECUT);
    }
    if (JSON.stringify(cut.bindingKernels) !== JSON.stringify(Object.keys(B6_KERNELS))) p.push('(a) cut.bindingKernels ' + JSON.stringify(cut.bindingKernels) + ' != calibrate.mjs KERNELS ' + JSON.stringify(Object.keys(B6_KERNELS)));
    const dk = Object.keys(doc.kernels || {});
    if (JSON.stringify(dk) !== JSON.stringify(ks)) {
        p.push('(a) doc.kernels ' + JSON.stringify(dk) + ' != calibrate.mjs kernels ' + JSON.stringify(ks) + '; ' + B6_RECUT);
    }
    const dl = Object.keys(doc.lanes || {});
    if (JSON.stringify(dl) !== JSON.stringify(names)) p.push('(a) lanes ' + dl + ' != roster ' + names);
    for (const d of lanes) {
        const L = (doc.lanes || {})[d.name];
        if (!L) continue;
        if (JSON.stringify(L.required) !== JSON.stringify(d.required)) p.push('(a) ' + d.name + ' required scenarios changed since the cut; ' + B6_RECUT);
        if (JSON.stringify(L.oracles) !== JSON.stringify(d.hardOracles)) p.push('(a) ' + d.name + ' hard oracles changed since the cut; ' + B6_RECUT);
    }
    const pins = (doc.provenance || {}).pinnedSha256 || {};
    if (JSON.stringify(Object.keys(pins)) !== JSON.stringify(b6PinnedFor(names))) {
        p.push('(p) the pinned file list changed since the cut; ' + B6_RECUT);
    }
    for (const f of Object.keys(pins)) if (shaOf(f) !== pins[f]) p.push('(p) ' + f + ' moved since the cut; ' + B6_RECUT);
    for (const k of ks) {
        const bound = b6LanesFor(k, names);
        const K = (doc.kernels || {})[k];
        if (!K) { p.push('(a) kernel ' + k + ' has no evidence'); continue; }
        // b79 C2: a file shaOf cannot read (null) is red even when the evidence says null (null is not a sha);
        // a non-object entry is a (p) line, never a TypeError
        for (const f of Array.isArray(K.files) ? K.files : []) {
            const fo = f !== null && typeof f === 'object', fp = fo ? f.path : null, cur = shaOf(fp);
            if (cur === null || cur !== (fo ? f.sha256 : null)) {
                p.push('(p) kernel file ' + fp + ' moved since the cut; ' + B6_RECUT);
            }
        }
        if (!(Array.isArray(K.files) && K.files.length > 0)) p.push('(p) kernel ' + k + ' lists no files; ' + B6_RECUT);
        // D7: a lane-only kernel's evidence is the parity-pinned engine (null is not a sha: an unlisted file is red)
        if (b6Has(B6_LANE_ONLY, k)) {
            const kp = b6KernelPath(k), wantFiles = [kp, kp.replace(/Signal\.js$/, 'Watch.js')];
            const got = Array.isArray(K.files)
                ? K.files.map((f) => (f !== null && typeof f === 'object' ? f.path : null)) : null;
            if (K.kernel !== kp || JSON.stringify(got) !== JSON.stringify(wantFiles)) {
                p.push('(p) kernel ' + k + ' evidence is ' + K.kernel + ' ' + JSON.stringify(got) + ', not '
                    + JSON.stringify(wantFiles) + '; ' + B6_RECUT);
            }
            for (const f of Array.isArray(K.files) ? K.files : []) {
                const fo = f !== null && typeof f === 'object', fp = fo ? f.path : null, fsha = fo ? f.sha256 : null;
                const want = b6Has(parity, fp) ? parity[fp] : null;
                if (fsha === null || fsha !== want) {
                    p.push('(p) kernel ' + k + ' ' + fp + ' sha ' + fsha + ' != parity.json ' + want + '; ' + B6_RECUT);
                }
            }
        }
        for (const d of lanes) {
            if (bound.indexOf(d.name) === -1) continue;   // a lane this kernel does not cut (calibrate.mjs LANE_KERNELS)
            for (const [sh, scenMin, floor] of [['full', C.SCEN_MIN, C.CHECK_FLOOR], ['smoke', C.SCEN_MIN_SMOKE, C.CHECK_FLOOR_SMOKE]]) {
                const f = (K[sh] || {})[d.name];
                const at = k + ' ' + sh + ' ' + d.name;
                if (!f) { p.push('(a) ' + at + ' missing'); continue; }
                // b79 C5: the cell ran the cut's cycles (full = cut.cycles, smoke = cut.smokeCycles); a count only
                const cyc = f.cycles, wantCyc = sh === 'full' ? cut.cycles : cut.smokeCycles;
                if (!(b6Count(cyc) && cyc === wantCyc)) {
                    p.push('(a) ' + at + ' cycles=' + cyc + ' != cut.' + (sh === 'full' ? 'cycles' : 'smokeCycles')
                        + ' ' + wantCyc + '; ' + B6_RECUT);
                }
                if (f.crashes !== 0) p.push('(d) ' + at + ' crashes=' + f.crashes);
                for (const s of d.required) {
                    const n = b6Has(f.scenarios, s) ? f.scenarios[s] : null;
                    if (!(n >= scenMin)) p.push('(b) ' + at + ' ' + s + '=' + n + ' < ' + scenMin);
                }
                for (const o of d.hardOracles) {
                    const n = b6Has(f.performed, o) ? f.performed[o] : null;
                    if (!(n >= floor)) p.push('(c) ' + at + ' ' + o + ' performed=' + n + ' < ' + floor);
                    if (B6_SKIP_NAMES.indexOf(o) === -1) continue;
                    const k2 = b6Has(f.skipTainted, o) ? f.skipTainted[o] : NaN;
                    const r = k2 / (n + k2);   // exact, as gates.mjs taintSkipRule
                    if (!(r <= C.TAINT_SKIP_MAX)) p.push('(d) ' + at + ' ' + o + ' taint=' + r + ' > ' + C.TAINT_SKIP_MAX);
                    if (!(b6Has(f.taintRatio, o) && f.taintRatio[o] === r)) p.push('(d) ' + at + ' ' + o + ' stored ratio ' + (f.taintRatio || {})[o] + ' != exact ' + r);
                }
            }
        }
        // a cell on a lane this kernel does not cut (WIE on pre-b33 1.5.2): the map decides, never the JSON
        for (const sh of ['full', 'smoke']) for (const lane of Object.keys(K[sh] || {})) {
            if (bound.indexOf(lane) !== -1) continue;
            const by = names.indexOf(lane) === -1 ? [] : b6KernelsFor(lane);
            const why = ': a cell no calibrate.mjs binding cuts (lane ' + lane + ' -> ' + JSON.stringify(by) + '); ';
            p.push('(a) ' + k + ' ' + sh + ' ' + lane + why + B6_RECUT);
        }
        const clean = ((doc.seedSweep || {}).cells || {});
        for (const d of lanes) if (bound.indexOf(d.name) !== -1) for (const c of clean[k + ':' + d.name] || []) {
            if (!(c.maxTaint.ratio <= C.TAINT_SKIP_MAX)) p.push('(e) ' + k + ' clean sweep ' + d.name + ' seed ' + c.seed + ' taint ' + c.maxTaint.ratio + ' > ' + C.TAINT_SKIP_MAX);
        }
    }
    // (e) hollow volume + the smoke floor (b74 D4): global over kernelsOf(roster), each kernel on its bound lanes,
    // FULL-LENGTH rows / cells only (a fail-stopped count is short because worlds fail, not because the volume is low)
    let hollowAny = false, smokeMin = Infinity;
    for (const k of ks) for (const d of lanes) {
        if (b6LanesFor(k, names).indexOf(d.name) === -1) continue;
        const h = ((doc.hollowVolume || {})[k] || {})[d.name];
        const lp = b6FullLength(h) && h.worst && h.worst.leastPerformed ? h.worst.leastPerformed.performed : null;
        if (b6Count(lp) && lp < C.CHECK_FLOOR) hollowAny = true;
        const f = ((((doc.kernels || {})[k] || {}).smoke) || {})[d.name];
        if (!b6FullLength(f)) continue;
        for (const o of d.hardOracles) if (b6Has(f.performed, o) && f.performed[o] < smokeMin) smokeMin = f.performed[o];
    }
    if (!hollowAny) {
        p.push('(e) no full-length lane at ' + C.DEFAULT_CYCLES + ' x OPS_MIN falls below CHECK_FLOOR=' + C.CHECK_FLOOR
            + ' (the floor is hollow; a hollowVolume row counts only with failingWorlds 0)');
    }
    if (!(C.CHECK_FLOOR_SMOKE * 8 >= smokeMin)) {
        p.push('(e) CHECK_FLOOR_SMOKE=' + C.CHECK_FLOOR_SMOKE + ' is below 1/8 of the least full-length smoke cell ' + smokeMin);
    }
    // (f) b74 D4: every rostered lane has full-length evidence on some kernel that cuts it (header); ERROR is exempt
    // only while DIV-F22 is open (b109: DIV-F5 closed; b117: the LIFECYCLE exemption ended with DIV-D3, fixed A5a), and
    // the exemption set is exactly the ruled one
    // second literal on purpose: editing B6_F_EXEMPT_RULED (the default source only) alone is red; fail closed
    // -- a non-object exempt (null) is red, never a TypeError
    // b79 C1: each ruled lane's list (exempt.ERROR) is read ONCE and compared + printed element by
    // element (an indexed loop: no JSON.stringify, toJSON or iterator on it), so a toJSON-spoofed ['DIV-F7'] is red and
    // its line shows ["DIV-F7"]
    const exK = exempt !== null && typeof exempt === 'object' ? Reflect.ownKeys(exempt) : null;
    // b109: DIV-F5 closed in A3-FIX-R; b117: LIFECYCLE (tied to DIV-D3 since b111 A1 Q1) left with DIV-D3 fixed in A5a
    const exRuled = { ERROR: ['DIV-F22'] };
    const exElt = (v) => (typeof v === 'string' ? '"' + v + '"'
        : v !== null && (typeof v === 'object' || typeof v === 'function') ? '<' + typeof v + '>' : String(v));
    let exOk = true, exS = '', exR = '';
    for (const lane of Object.keys(exRuled)) {
        const exE = exK === null ? null : exempt[lane];
        const want = exRuled[lane];
        const exA = Array.isArray(exE), exN = exA ? exE.length : -1;
        if (exN !== want.length) exOk = false;
        let s = '';
        for (let i = 0; i < exN && i < 8; i++) {   // each element read once; at most 8 shown
            const v = exE[i];
            if (v !== want[i]) exOk = false;
            s += (i === 0 ? '' : ',') + exElt(v);
        }
        exS += ' ' + lane + '=' + (exA ? '[' + s + (exN > 8 ? ',... (' + exN + ')' : '') + ']' : exElt(exE));
        exR += ' ' + lane + '=' + JSON.stringify(want);
    }
    if (JSON.stringify(exK) !== JSON.stringify(Object.keys(exRuled)) || !exOk) {
        const shown = exK === null ? 'null' : JSON.stringify(exK.map(String)) + exS;
        p.push('(f) the exemption set ' + shown + ' != ' + JSON.stringify(Object.keys(exRuled)) + exR
            + ' (maintainer rulings b74: ERROR tied to DIV-F22 while open, b103 R13.3 dropped DIV-F6, b109 dropped DIV-F5;'
            + ' b111 A1 Q1 tied LIFECYCLE to DIV-D3-independent-registrations; b117: DIV-D3 fixed in A5a, LIFECYCLE left)');
    }
    for (const d of lanes) {
        let ok = false;
        const ev = [];
        for (const k of b6KernelsFor(d.name)) {
            const K = (doc.kernels || {})[k] || {};
            const cells = ['full', 'smoke'].map((sh) => [sh, (K[sh] || {})[d.name]]);
            if (cells.every(([, f]) => b6FullLength(f))) ok = true;
            for (const [sh, f] of cells) {
                ev.push(k + ' ' + sh + ' ' + (f !== null && typeof f === 'object'
                    ? f.failingWorlds + '/' + f.worlds + ' failing, ' + (f.ops / f.worlds).toFixed(1) + ' ops/world' : 'missing'));
            }
        }
        if (b6Has(exempt, d.name)) {
            if (b6DivOpen(exempt[d.name], divs).length > 0) { if (!ok) continue; }
            else {
                p.push('(f) ' + d.name + ': the exemption expired (' + JSON.stringify(exempt[d.name]) + ' all closed or absent in divergences.json):'
                    + ' cut ' + d.name + ' on tree (calibrate.mjs LANE_KERNELS) and drop the exemption; ' + B6_RECUT);
            }
        }
        if (!ok) p.push('(f) ' + d.name + ': no full-length evidence -- ' + ev.join('; '));
    }
    const cov = (((doc.covOffSweep || {}).cells || {})['headpatched:NEST:saved-cursor-hazard']) || [];
    if (!b6SeedsOk(cov)) p.push('(e) the headpatched NEST cov-off sweep seeds ' + JSON.stringify(cov.map((c) => (c || {}).seed)) + ' != COVOFF_SEEDS');
    // b71 (PLAN-0s-d6 ADDENDUM 1 item 2): no taint-skip leg on the cov-off sweep (V1 reads it at ~0.09; REPORTED only)
    // (e) a cov-off must switch its scenario off: every covOff cell; every covOffSweep cell, each kernel on its lanes
    for (const { name: lane, covOff } of lanes) for (const scen of Object.keys(covOff)) {
        const c = (doc.covOff || {})[lane + ':' + scen];
        if (!c) { p.push('(e) cov-off ' + lane + ':' + scen + ' has no evidence; ' + B6_RECUT); continue; }
        if (!(b6Count(c.hits) && c.hits < C.SCEN_MIN_SMOKE)) p.push('(e) cov-off ' + lane + ':' + scen + ' hits=' + c.hits + ' >= SCEN_MIN_SMOKE ' + C.SCEN_MIN_SMOKE + ' (the cov-off switch leaks: the hollow run clears coverage)');
    }
    for (const k of ks) for (const { name: lane, covOff } of lanes) for (const scen of Object.keys(covOff)) {
        if (b6LanesFor(k, names).indexOf(lane) === -1) continue;   // a lane this kernel does not cut
        const key = k + ':' + lane + ':' + scen;
        const cells = (((doc.covOffSweep || {}).cells || {})[key]) || [];
        if (!b6SeedsOk(cells)) p.push('(e) the ' + key + ' cov-off sweep seeds ' + JSON.stringify(cells.map((c) => (c || {}).seed)) + ' != COVOFF_SEEDS');
        for (const c of cells) if (!(b6Count(c.hits) && c.hits < C.SCEN_MIN_SMOKE)) p.push('(e) cov-off sweep ' + key + ' seed ' + c.seed + ' hits=' + c.hits + ' >= SCEN_MIN_SMOKE ' + C.SCEN_MIN_SMOKE + ' (the cov-off switch leaks)');
    }
    // (q) the large-world probe evidence is the PROBE calibrate.mjs runs, at main's minimum cycle count
    for (const k of B6_PROBE_KEYS) if (!b6Has(probe, k)) p.push('(q) calibrate.mjs PROBE has no ' + k);
    const pr = doc.probe;
    if (pr === null || typeof pr !== 'object') p.push('(q) no probe evidence (doc.probe); ' + B6_RECUT);
    else {
        for (const k of B6_PROBE_KEYS) if (!b6Has(probe, k) || pr[k] !== probe[k]) p.push('(q) probe.' + k + '=' + pr[k] + ' != calibrate.mjs PROBE.' + k + '=' + (probe || {})[k] + '; ' + B6_RECUT);
        const lw = pr.largeWorldsPerCycle;
        if (!(Array.isArray(lw) && lw.length === (probe || {}).cycles && lw.every((n) => Number.isSafeInteger(n) && n >= 1))) p.push('(q) probe.largeWorldsPerCycle ' + JSON.stringify(lw) + ': every one of PROBE.cycles=' + (probe || {}).cycles + ' cycles must run a LARGE world');
        if (pr.fold === null || typeof pr.fold !== 'object') p.push('(q) probe.fold missing; ' + B6_RECUT);
    }
    if (!(b6Has(probe, 'cycles') && probe.cycles === C.MIN_ACTIVE_CYCLES)) p.push('(q) PROBE.cycles=' + (probe || {}).cycles + ' != MIN_ACTIVE_CYCLES ' + C.MIN_ACTIVE_CYCLES + ' (main rejects SOAK_CYCLES below MIN_ACTIVE_CYCLES: the probe shape is not what main runs)');
    return p;
}

const B6_C = Object.freeze(Object.assign({}, CFG));
const b6With = (over) => Object.assign({}, B6_C, over);

// the binding minima, read from the evidence (never typed in): mutants sit one step past them. b74 D4: full-length
// cells only, plus the cells of a lane (f) exempts right now (ERROR, while DIV-F22 is open: its fail-stopped
// cells keep feeding SCEN_MIN's binding, ERROR aggregate, until the ERROR recut). A missing cell is (a)'s, not b6Min's.
function b6Min(sh, pick) {
    let best = null;
    for (const k of b6KernelsOf(B6_ROSTER)) for (const d of B6_LANES) {
        if (b6LanesFor(k, B6_ROSTER).indexOf(d.name) === -1) continue;   // a lane this kernel does not cut
        const f = ((B6_DOC.kernels[k] || {})[sh] || {})[d.name];
        if (!(b6FullLength(f) || (f && b6FExempt(d.name)))) continue;
        for (const [name, n] of pick(d, f)) if (best === null || n < best.n) best = { k, lane: d.name, name, n };
    }
    return best;
}
const B6_SCEN_FULL = b6Min('full', (d, f) => d.required.map((s) => [s, f.scenarios[s]]));
const B6_SCEN_SMOKE = b6Min('smoke', (d, f) => d.required.map((s) => [s, f.scenarios[s]]));
const B6_PERF_FULL = b6Min('full', (d, f) => d.hardOracles.map((o) => [o, f.performed[o]]));
const B6_PERF_SMOKE = b6Min('smoke', (d, f) => d.hardOracles.map((o) => [o, f.performed[o]]));
let B6_TAINT_MAX = 0;
for (const k of b6KernelsOf(B6_ROSTER)) for (const d of B6_LANES) for (const sh of ['full', 'smoke']) {
    if (b6LanesFor(k, B6_ROSTER).indexOf(d.name) === -1) continue;
    const f = ((B6_DOC.kernels[k] || {})[sh] || {})[d.name];
    if (!f) continue;   // a missing cell (a JSON cut before b74 D4) is (a)'s problem
    for (const o of d.hardOracles) if (B6_SKIP_NAMES.indexOf(o) !== -1) B6_TAINT_MAX = Math.max(B6_TAINT_MAX, f.taintRatio[o]);
}
const B6_COV = B6_DOC.covOffSweep.cells['headpatched:NEST:saved-cursor-hazard'].map((c) => c.maxTaint.ratio);

// main.mjs --smoke on every kernel of the roster (kernelsOf), each on SOAK_LANES = its bound lanes (lanesFor),
// concurrently, folded per lane (cached: one set of spawns per file)
let b6Live = null;
function b6LiveRun() {
    b6ProbeRun();   // the probe child runs concurrently with the smoke runs
    if (b6Live === null) {
        const ks = b6KernelsOf(B6_ROSTER);
        b6Live = Promise.all(ks.map((k) => runMainSmoke(join(ROOT, b6KernelPath(k)), b6LanesFor(k, B6_ROSTER)))).then((runs) => {
            const out = {};
            ks.forEach((k, i) => {
                const m = runs[i];
                assert.ok(m.recs !== null, 'main.mjs --smoke on ' + k + ' wrote no records (exit ' + m.status + '): ' + m.stderr.slice(0, 400));
                assert.ok(!m.recs.some((r) => r.type === 'fatal'), 'main.mjs --smoke on ' + k + ' crashed');
                assert.equal(m.recs[m.recs.length - 1].type, 'summary', 'main.mjs --smoke on ' + k + ' reached its summary');
                const cyc = m.recs.filter((r) => r.type === 'cycle');
                out[k] = {};
                for (const lane of b6LanesFor(k, B6_ROSTER)) {
                    out[k][lane] = foldMainRecords(B6_DOC.lanes[lane], cyc.filter((r) => r.lane === lane), B6_SKIP_NAMES);
                }
            });
            return out;
        });
    }
    return b6Live;
}
// main.mjs on PROBE (headpatched GRAPH, 11 x PROBE.ops), started together with the smoke runs (cached)
// the run shape a probe must have: records, no fatal, the summary last, exit 0 with verdict PASS (pure: must-fail seam)
const b6ProbeRunProblems = (m) => {
    if (m.recs === null || m.recs.length === 0) return ['no records (exit ' + m.status + '): ' + String(m.stderr).slice(0, 400)];
    const out = [];
    if (m.recs.some((r) => r.type === 'fatal')) out.push('crashed (a fatal record)');
    const last = m.recs[m.recs.length - 1];
    if (last.type !== 'summary') out.push('last record is ' + last.type + ', not the summary');
    if (m.status !== 0) out.push('exit ' + m.status + ' != 0');
    if (last.verdict !== 'PASS' || last.exitCode !== 0) out.push('summary verdict ' + last.verdict + ' exitCode ' + last.exitCode + ' != PASS 0');
    return out;
};
let b6Probe = null;
function b6ProbeRun() {
    if (b6Probe === null) {
        b6Probe = runMainProbe().then((m) => {
            assert.deepEqual(b6ProbeRunProblems(m), [], 'main.mjs probe run shape');
            const cyc = m.recs.filter((r) => r.type === 'cycle');
            return {
                raw: m, cycles: cyc.length, lanes: cyc.map((r) => r.lane),
                largeWorldsPerCycle: cyc.map((r) => r.largeWorlds),
                boundaries: cyc.map((r) => [r.boundary.trackerSize, r.boundary.weakAlive]),
                fold: foldMainRecords(B6_DOC.lanes[B6_PROBE.lane], cyc, B6_SKIP_NAMES),
            };
        });
        b6Probe.catch(() => {});   // started early: its own test awaits (and reports) the rejection
    }
    return b6Probe;
}
const b6ProbeMismatch = (docProbe, live) => {
    const out = [];
    if (docProbe === null || typeof docProbe !== 'object') return ['no doc.probe (the JSON predates the probe; recut)'];
    if (JSON.stringify(live.largeWorldsPerCycle) !== JSON.stringify(docProbe.largeWorldsPerCycle)) out.push('largeWorldsPerCycle ' + JSON.stringify(live.largeWorldsPerCycle) + ' != ' + JSON.stringify(docProbe.largeWorldsPerCycle));
    if (JSON.stringify(live.fold) !== JSON.stringify(docProbe.fold)) out.push('fold');
    return out;
};
const b6LiveMismatch = (doc, live) => {
    const out = [];
    for (const k of Object.keys(live)) for (const lane of b6LanesFor(k, B6_ROSTER)) {
        if (JSON.stringify(live[k][lane]) !== JSON.stringify(((doc.kernels[k] || {}).smoke || {})[lane])) out.push(k + ':' + lane);
    }
    return out;
};

test('B6 drift guard: the calibration evidence clears every calibrated constant (a, p, b-e); the binding cells are what the report says', () => {
    assert.deepEqual(calibrationProblems(B6_DOC, B6_C), []);
    assert.deepEqual(B6_DOC.cut.bindingKernels, Object.keys(B6_KERNELS));
    // B6 assertion: >= 8 hits per required scenario per lane at 11 x DEFAULT_OPS and >= 1 in smoke
    assert.ok(B6_SCEN_FULL.n >= 8 && B6_SCEN_SMOKE.n >= 1, JSON.stringify([B6_SCEN_FULL, B6_SCEN_SMOKE]));
    assert.equal(B6_DOC.cut.ops * B6_DOC.cut.cycles, 11 * CFG.DEFAULT_OPS);
});

test('B6 drift guard must-fail: each constant one step past its evidence, a moved cut / pin / constant, an edited JSON, a hollow gate -> red', () => {
    // a mutant must add a NEW problem with its tag: a problem the evidence already carries (a stale JSON awaiting
    // its recut) is not the mutant's red
    const before = calibrationProblems(B6_DOC, B6_C);
    const red = (doc, C, tag, why, shaOf, probe, divs, exempt) => {
        const got = calibrationProblems(doc, C, shaOf, probe, undefined, undefined, divs, exempt);
        assert.ok(got.some((x) => x.indexOf(tag) === 0 && before.indexOf(x) === -1), why + ': expected a new ' + tag + ' problem, got ' + JSON.stringify(got));
    };
    red(B6_DOC, b6With({ SCEN_MIN: B6_SCEN_FULL.n + 1 }), '(b)', 'SCEN_MIN above the rarest full cell ' + B6_SCEN_FULL.name);
    red(B6_DOC, b6With({ SCEN_MIN_SMOKE: B6_SCEN_SMOKE.n + 1 }), '(b)', 'SCEN_MIN_SMOKE above the rarest smoke cell');
    red(B6_DOC, b6With({ CHECK_FLOOR: B6_PERF_FULL.n + 1 }), '(c)', 'CHECK_FLOOR above the least-performed full cell ' + B6_PERF_FULL.lane + ' ' + B6_PERF_FULL.name);
    red(B6_DOC, b6With({ CHECK_FLOOR_SMOKE: B6_PERF_SMOKE.n + 1 }), '(c)', 'CHECK_FLOOR_SMOKE above the least-performed smoke cell');
    red(B6_DOC, b6With({ TAINT_SKIP_MAX: B6_TAINT_MAX - 1e-9 }), '(d)', 'TAINT_SKIP_MAX below the clean max ratio');
    // the taint-skip teeth are live (test/67 P-NEST-TAINT-HALF, ADDENDUM 1 item 2); statically, a moved value is stale
    red(B6_DOC, b6With({ TAINT_SKIP_MAX: 0.5 }), '(a)', 'TAINT_SKIP_MAX moved off the D3 0.35 without a recut');
    red(B6_DOC, b6With({ DEFAULT_OPS: CFG.DEFAULT_OPS / 2 }), '(a)', 'DEFAULT_OPS moved without a recut');
    red(B6_DOC, b6With({ SMOKE_OPS: CFG.SMOKE_OPS + 1 }), '(a)', 'SMOKE_OPS moved');
    red(B6_DOC, b6With({ DEFAULT_SEED: CFG.DEFAULT_SEED + 1 }), '(a)', 'seed moved');
    red(B6_DOC, b6With({ GEN_VERSION: CFG.GEN_VERSION + 1 }), '(a)', 'generator version moved');
    red(B6_DOC, b6With({ CHECK_FLOOR: 100 }), '(e)', 'a floor no hollow run can fall below');
    red(B6_DOC, b6With({ CHECK_FLOOR_SMOKE: 1 }), '(e)', 'a smoke floor far below the clean cells');
    red(B6_DOC, b6With({ CHECK_FLOOR_SMOKE: Math.ceil(B6_PERF_SMOKE.n / 8) - 1 }), '(e)', 'CHECK_FLOOR_SMOKE x 8 one step below the least full-length smoke cell ' + B6_PERF_SMOKE.lane);
    red(B6_DOC, b6With({ CHECK_FLOOR: CFG.CHECK_FLOOR - 1 }), '(a)', 'a constant moved inside its margin, JSON not recut');
    red(B6_DOC, B6_C, '(p)', 'kinds.mjs moved since the cut', (rel) => (rel === 'bench/soak/kinds.mjs' ? 'f'.repeat(64) : b6ShaOf(rel)));
    red(B6_DOC, B6_C, '(p)', 'the torture VALUE_POOL moved since the cut', (rel) => (rel === 'bench/torture/helpers/index.mjs' ? 'f'.repeat(64) : b6ShaOf(rel)));
    // main.mjs and calibrate.mjs are gated live (smoke + probe folds), not pinned: a moved sha is no static problem
    assert.equal(B6_PINNED.indexOf('bench/soak/main.mjs'), -1, 'main.mjs is not pinned');
    assert.equal(B6_PINNED.indexOf('bench/soak/calibration/calibrate.mjs'), -1, 'calibrate.mjs is not pinned');
    const base = calibrationProblems(B6_DOC, B6_C);
    for (const f of ['bench/soak/main.mjs', 'bench/soak/calibration/calibrate.mjs']) {
        assert.deepEqual(calibrationProblems(B6_DOC, B6_C, (rel) => (rel === f ? 'f'.repeat(64) : b6ShaOf(rel))), base, f + ' moved: no static problem');
    }
    // (q): the probe evidence must be the PROBE main runs at its minimum cycle count
    const { ops: _dropOps, ...probeNoOps } = B6_PROBE;
    red(B6_DOC, B6_C, '(q)', 'an entry removed from PROBE', b6ShaOf, probeNoOps);
    red(B6_DOC, B6_C, '(q)', 'PROBE.cycles 10 (main rejects SOAK_CYCLES below 11)', b6ShaOf, Object.assign({}, B6_PROBE, { cycles: 10 }));
    red(B6_DOC, b6With({ MIN_ACTIVE_CYCLES: CFG.MIN_ACTIVE_CYCLES + 1 }), '(q)', 'MIN_ACTIVE_CYCLES moved off PROBE.cycles');
    const noProbe = b6Copy(B6_DOC);
    delete noProbe.probe;
    red(noProbe, B6_C, '(q)', 'an old JSON without doc.probe');
    if (b6Has(B6_DOC, 'probe')) {
        const p2 = b6Copy(B6_DOC);
        delete p2.probe.ops;
        red(p2, B6_C, '(q)', 'an entry removed from doc.probe');
        const p3 = b6Copy(B6_DOC);
        p3.probe.largeWorldsPerCycle[B6_PROBE.cycles - 1] = 0;
        red(p3, B6_C, '(q)', 'a probe cycle that ran no LARGE world');
    }
    // (e): a cov-off cell with hits at SCEN_MIN_SMOKE (the leaking switch); a BATCH sweep cell likewise; null is not 0
    const leak = b6Copy(B6_DOC);
    leak.covOff['GRAPH:dep-set-flip'].hits = CFG.SCEN_MIN_SMOKE;
    red(leak, B6_C, '(e)', 'a covOff cell with hits >= SCEN_MIN_SMOKE');
    for (const k of b6KernelsFor('BATCH')) {
        const sw = b6Copy(B6_DOC);
        sw.covOffSweep.cells[k + ':BATCH:revert-after-mid-read'][3].hits = CFG.SCEN_MIN_SMOKE;
        red(sw, B6_C, '(e)', k + ' BATCH covOffSweep cell with hits >= SCEN_MIN_SMOKE');
    }
    const nul = b6Copy(B6_DOC);
    nul.covOff['NEST:saved-cursor-hazard'].hits = null;
    red(nul, B6_C, '(e)', 'a null cov-off hit count is not zero');
    // the sweep must hold exactly COVOFF_SEEDS: a duplicated seed (17 x DEFAULT_SEED) or an extra cell is red
    for (const key of ['headpatched:BATCH:revert-after-mid-read', 'headpatched:NEST:saved-cursor-hazard', 'lite-1.5.2:GRAPH:deep-pull']) {
        const dup = b6Copy(B6_DOC);
        for (const c of dup.covOffSweep.cells[key]) c.seed = B6_COVOFF_SEEDS[0];
        red(dup, B6_C, '(e)', key + ': every sweep seed = 0xC0FFEE (duplicated seed)');
        const extra = b6Copy(B6_DOC);
        extra.covOffSweep.cells[key].push(b6Copy(extra.covOffSweep.cells[key][0]));
        red(extra, B6_C, '(e)', key + ': an 18th sweep cell');
    }
    // every cov-off sweep (not only BATCH) is hit-checked on every kernel that cuts its lane (lanesFor)
    const gHit = b6Copy(B6_DOC);
    gHit.covOffSweep.cells['lite-1.5.2:ERROR:throw-dep-effect-prewalk'][0].hits = CFG.SCEN_MIN_SMOKE;
    red(gHit, B6_C, '(e)', 'an ERROR cov-off sweep cell with hits >= SCEN_MIN_SMOKE');
    red(B6_DOC, B6_C, '(p)', 'a binding kernel file moved', (rel) => (rel === B6_DOC.kernels['lite-1.5.2'].files[0].path ? null : b6ShaOf(rel)));
    // b79 C2: an unreadable kernel file whose evidence sha is null (null === null is not a match), and a null entry
    const nope = b6Copy(B6_DOC);
    nope.kernels['lite-1.5.2'].files.push({ path: 'nope.js', sha256: null });
    red(nope, B6_C, '(p) kernel file nope.js moved', 'an unreadable kernel file with evidence sha256 null');
    const nulF = b6Copy(B6_DOC);
    nulF.kernels['lite-1.5.2'].files = [null];
    red(nulF, B6_C, '(p) kernel file null moved', 'files [null]: a (p) line, never a TypeError');
    const nulT = b6Copy(B6_DOC); nulT.kernels.tree.files = [null];
    red(nulT, B6_C, '(p) kernel tree null sha null', 'tree files [null]');
    const lowered = b6Copy(B6_DOC);
    lowered.kernels[B6_SCEN_FULL.k].full[B6_SCEN_FULL.lane].scenarios[B6_SCEN_FULL.name] = CFG.SCEN_MIN - 1;
    red(lowered, B6_C, '(b)', 'evidence edited below SCEN_MIN');
    const gone = b6Copy(B6_DOC);
    delete gone.kernels.headpatched.full.NEST.performed.O7a;
    red(gone, B6_C, '(c)', 'a missing performed count is not zero (null is not zero)');
    const shrunk = b6Copy(B6_DOC);
    shrunk.lanes.BATCH.required = shrunk.lanes.BATCH.required.slice(1);
    red(shrunk, B6_C, '(a)', 'a required scenario the evidence never measured');
    const crashed = b6Copy(B6_DOC);
    crashed.kernels.headpatched.smoke.GRAPH.crashes = 1;
    red(crashed, B6_C, '(d)', 'a crash in the binding cut');
    // b79 C5: a cell cut at other cycles than the cut -> exactly one new (a) line; smoke too; null is not a count
    const cyc10 = b6Copy(B6_DOC);
    cyc10.kernels.headpatched.full.GRAPH.cycles = 10;
    assert.deepEqual(calibrationProblems(cyc10, B6_C).filter((x) => before.indexOf(x) === -1),
        ['(a) headpatched full GRAPH cycles=10 != cut.cycles ' + B6_DOC.cut.cycles + '; ' + B6_RECUT]);
    const cycS = b6Copy(B6_DOC);
    cycS.kernels['lite-1.5.2'].smoke.BATCH.cycles = B6_DOC.cut.smokeCycles + 1;
    red(cycS, B6_C, '(a) lite-1.5.2 smoke BATCH cycles=', 'a smoke cell off cut.smokeCycles');
    const cycN = b6Copy(B6_DOC);   // cut.cycles and every full cell's cycles absent: undefined is not a count
    delete cycN.cut.cycles;
    for (const k of Object.keys(cycN.kernels)) for (const l of Object.keys(cycN.kernels[k].full)) {
        delete cycN.kernels[k].full[l].cycles;
    }
    red(cycN, B6_C, '(a) headpatched full GRAPH cycles=undefined', 'no cycles on the cut nor on any full cell');
    const one = b6Copy(B6_DOC);
    one.cut.bindingKernels = ['headpatched'];
    red(one, B6_C, '(a)', 'a binding kernel dropped from the evidence (J5)');
    const stale = b6Copy(B6_DOC);
    stale.constants.TAINT_SKIP_MAX = 0.5;
    red(stale, B6_C, '(a)', 'doc.constants stale against config');
    const rounded = b6Copy(B6_DOC);
    rounded.kernels.headpatched.full.NEST.taintRatio.O1c = Math.round(rounded.kernels.headpatched.full.NEST.taintRatio.O1c * 1e4) / 1e4;
    red(rounded, B6_C, '(d)', 'a rounded stored ratio is not the exact one');
    // (f) b74 D4: NEST's full-length evidence is tree's (headpatched + 1.5.2 fail-stop every NEST world)
    const fFull = b6Copy(B6_DOC);
    fFull.kernels.tree.full.NEST.failingWorlds = 1;
    red(fFull, B6_C, '(f) NEST', 'one failing world in the tree full NEST cell');
    const fNull = b6Copy(B6_DOC);
    fNull.kernels.tree.smoke.NEST.failingWorlds = null;
    red(fNull, B6_C, '(f) NEST', 'a null failingWorlds in the tree smoke NEST cell (null is not zero)');
    const fGone = b6Copy(B6_DOC);   // the pre-b74 shape: NEST cut on the fail-stopped binding kernels only
    delete fGone.kernels.tree.full.NEST;
    delete fGone.kernels.tree.smoke.NEST;
    red(fGone, B6_C, '(f) NEST', 'no tree NEST cells (the HEAD-shaped JSON)');
    // (f) the ERROR exemption: it holds while DIV-F22 is open (b109: DIV-F5 is closed in A3-FIX-R); closed or absent -> red
    // F_IDS: the ids the registry manipulations below close / delete; EX_IDS: the ruled exemption set (F22 only)
    const F_IDS = ['DIV-F5', 'DIV-F22'];
    const EX_IDS = ['DIV-F22'];
    const D3_IDS = ['DIV-D3-independent-registrations'];   // b117: the ENDED LIFECYCLE exemption (b111 A1 Q1; DIV-D3 fixed A5a)
    const closeDivs = (ids) => { const d = b6Copy(B6_DIVS); for (const e of d.entries) if (ids.indexOf(e.id) !== -1) e.fixedIn = 'A2'; return d; };
    red(B6_DOC, B6_C, '(f) ERROR: the exemption expired', 'DIV-F5 / F22 both closed (the exemption expired: recut ERROR)', b6ShaOf, B6_PROBE, closeDivs(F_IDS));
    const absent = b6Copy(B6_DIVS);
    absent.entries = absent.entries.filter((e) => F_IDS.indexOf(e.id) === -1);
    red(B6_DOC, B6_C, '(f) ERROR: the exemption expired', 'DIV-F5 / F22 absent from divergences.json (absent is not open)', b6ShaOf, B6_PROBE, absent);
    const oneOpen = calibrationProblems(B6_DOC, B6_C, b6ShaOf, B6_PROBE, undefined, undefined, closeDivs(['DIV-F5']));
    assert.deepEqual(oneOpen.filter((x) => x.indexOf('(f) ERROR') === 0), [], 'control: DIV-F22 alone open keeps ERROR exempt');
    // b103 R13.3 (PLAN-0s-fixt ADDENDUM 13): DIV-F6 is CLOSED (fixedIn A2-FIX-T) and left the ruled set; the ruled set is
    // exactly the OPEN set of the shipped registry, and the pre-R13.3 three-id set is red
    assert.equal(B6_DIVS.entries.find((e) => e.id === 'DIV-F6').fixedIn, 'A2-FIX-T');
    assert.equal(B6_DIVS.entries.find((e) => e.id === 'DIV-F5').fixedIn, 'A3-FIX-R', 'b109: DIV-F5 closed');
    assert.deepEqual(B6_F_EXEMPT.ERROR, ['DIV-F22'], 'b109 (f): the ruled set');
    assert.deepEqual(b6DivOpen(B6_F_EXEMPT.ERROR, B6_DIVS), B6_F_EXEMPT.ERROR, 'b103 (f): ruled set == open set');
    // b117 (PLAN-b117-soak TASK 3, A5a): DIV-D3 is CLOSED (fixedIn A5a), so LIFECYCLE left the exemption set: the ruled
    // set is ERROR only, a fail-stopped LIFECYCLE cell is red like any lane's, and re-adding {LIFECYCLE: [DIV-D3]} is red
    assert.deepEqual(Reflect.ownKeys(B6_F_EXEMPT), ['ERROR'], 'b117 (f): the ruled set has no LIFECYCLE');
    assert.equal(B6_DIVS.entries.find((e) => e.id === D3_IDS[0]).fixedIn, 'A5a', 'b117: DIV-D3 fixed in A5a');
    assert.deepEqual(b6DivOpen(D3_IDS, B6_DIVS), [], 'b117 (f): DIV-D3 is not open');
    assert.equal(b6FExempt('LIFECYCLE'), false, 'b117 (f): LIFECYCLE is not exempt');
    // fixture: the tree LIFECYCLE cells made full-length, so these rows never ride on the pre-A5a cut (7520/7704
    // failing worlds, red until the recut); fOf = the (f) problems of a doc / registry / exemption set
    const fOf = (doc, divs, exempt) => calibrationProblems(doc, B6_C, b6ShaOf, B6_PROBE, undefined, undefined, divs, exempt).filter((x) => x.indexOf('(f)') === 0);
    const lcFull = b6Copy(B6_DOC);
    for (const sh of ['full', 'smoke']) lcFull.kernels.tree[sh].LIFECYCLE.failingWorlds = 0;
    assert.deepEqual(fOf(lcFull, B6_DIVS, B6_F_EXEMPT), [], 'control: full-length tree LIFECYCLE cells + the ruled set are clean');
    assert.deepEqual(fOf(lcFull, B6_DIVS, { ERROR: EX_IDS.slice() }), [], 'control: a fresh copy of the ruled set is clean');
    // re-adding the ended exemption is red twice: not the ruled set, and DIV-D3 is closed (or absent): it expired
    for (const [why, divs] of [['DIV-D3 closed (A5a)', B6_DIVS], ['DIV-D3 absent', Object.assign(b6Copy(B6_DIVS), { entries: B6_DIVS.entries.filter((e) => e.id !== D3_IDS[0]) })]]) {
        const readd = fOf(lcFull, divs, { ERROR: EX_IDS.slice(), LIFECYCLE: D3_IDS.slice() });
        assert.ok(readd.some((x) => x.indexOf('(f) the exemption set ["ERROR","LIFECYCLE"] ERROR=["DIV-F22"] != ["ERROR"] ERROR=["DIV-F22"] ') === 0), 'b117 re-added {LIFECYCLE: [DIV-D3]}, ' + why + ': ' + JSON.stringify(readd));
        assert.ok(readd.some((x) => x.indexOf('(f) LIFECYCLE: the exemption expired (["DIV-D3-independent-registrations"] ') === 0), 'b117 re-added exemption expired, ' + why + ': ' + JSON.stringify(readd));
    }
    red(B6_DOC, B6_C, '(f) the exemption set ', 'b111 shape: LIFECYCLE tied to another divergence', b6ShaOf, B6_PROBE, B6_DIVS, { ERROR: EX_IDS.slice(), LIFECYCLE: ['DIV-F7'] });
    // a fail-stopped LIFECYCLE cell is red now; with DIV-D3 reopened (fixedIn null) the old exemption hid it (the rule that ended)
    const lcStop = b6Copy(lcFull);
    lcStop.kernels.tree.full.LIFECYCLE.failingWorlds = 1;
    const NOFL = '(f) LIFECYCLE: no full-length evidence -- tree full 1/' + lcStop.kernels.tree.full.LIFECYCLE.worlds + ' failing';
    assert.ok(fOf(lcStop, B6_DIVS, B6_F_EXEMPT).some((x) => x.indexOf(NOFL) === 0), 'b117: one failing tree LIFECYCLE world is red');
    const d3Open = b6Copy(B6_DIVS);
    for (const e of d3Open.entries) if (e.id === D3_IDS[0]) e.fixedIn = null;
    assert.ok(!fOf(lcStop, d3Open, { ERROR: EX_IDS.slice(), LIFECYCLE: D3_IDS.slice() }).some((x) => x.indexOf(NOFL) === 0), 'control: the b111 exemption (DIV-D3 open) skipped the fail-stopped cell');
    red(B6_DOC, B6_C, '(f) the exemption set ', 'b103: the pre-R13.3 set {ERROR: [DIV-F5, DIV-F6, DIV-F22]}', b6ShaOf, B6_PROBE, B6_DIVS, { ERROR: ['DIV-F5', 'DIV-F6', 'DIV-F22'] });
    // b109 A4: the pre-A3-FIX-R set {ERROR: [DIV-F5, DIV-F22]} is red (DIV-F5 is closed; ruled set == open set)
    red(B6_DOC, B6_C, '(f) the exemption set ["ERROR"] ERROR=["DIV-F5","DIV-F22"] != ', 'b109: the pre-A3-FIX-R set {ERROR: [DIV-F5, DIV-F22]}', b6ShaOf, B6_PROBE, B6_DIVS, { ERROR: F_IDS.slice() });
    // (f) b6DivOpen: only fixedIn === null is open; a missing fixedIn key or '' is closed, so the exemption expires
    // (a `== null` or `!e.fixedIn` open test would keep ERROR exempt on a malformed registry: fail open)
    const noKey = b6Copy(B6_DIVS);
    for (const e of noKey.entries) if (F_IDS.indexOf(e.id) !== -1) delete e.fixedIn;
    red(B6_DOC, B6_C, '(f) ERROR: the exemption expired',
        'fixedIn deleted on DIV-F5 / F22 (a missing key is not open)', b6ShaOf, B6_PROBE, noKey);
    const noKeyV = validate(noKey);
    assert.ok(noKeyV.some((x) => /missing key fixedIn/.test(x)),
        'validate() names the missing fixedIn key: ' + JSON.stringify(noKeyV));
    const emptyFx = b6Copy(B6_DIVS);
    for (const e of emptyFx.entries) if (F_IDS.indexOf(e.id) !== -1) e.fixedIn = '';
    red(B6_DOC, B6_C, '(f) ERROR: the exemption expired',
        "fixedIn '' on DIV-F5 / F22 (an empty string is not open)", b6ShaOf, B6_PROBE, emptyFx);
    // (f) the structural exemption check fails closed: a null exempt is a '(f)' problem, never a TypeError
    red(B6_DOC, B6_C, '(f) the exemption set ', 'exempt = null (a non-object exemption set)',
        b6ShaOf, B6_PROBE, B6_DIVS, null);
    // (f) the exemption set must be exactly the ruled one: a second lane, or another divergence id -> red
    red(B6_DOC, B6_C, '(f)', 'NEST added to the exemption', b6ShaOf, B6_PROBE, B6_DIVS, { ERROR: EX_IDS.slice(), NEST: ['DIV-F15'] });
    red(B6_DOC, B6_C, '(f)', 'the ERROR exemption tied to a never-closing divergence', b6ShaOf, B6_PROBE, B6_DIVS, { ERROR: ['DIV-F7'] });
    const hidden = { ERROR: EX_IDS.slice() };   // a non-enumerable own key is still an exemption (b6Has is hasOwnProperty)
    Object.defineProperty(hidden, 'GRAPH', { value: ['DIV-F7'] });
    red(B6_DOC, B6_C, '(f) the exemption set ', 'a non-enumerable GRAPH key on the exemption set',
        b6ShaOf, B6_PROBE, B6_DIVS, hidden);
    const hiddenP = calibrationProblems(B6_DOC, B6_C, b6ShaOf, B6_PROBE, undefined, undefined, B6_DIVS, hidden);
    assert.ok(hiddenP.some((x) => x.indexOf('(f) the exemption set ["ERROR","GRAPH"]') === 0),
        'the (f) line names the hidden key (not the JSON of its enumerable keys): ' + JSON.stringify(hiddenP));
    // b79 C1: ERROR compared element by element: a toJSON serialising the ruled ids does not hide ['DIV-F7'], and
    // the line prints the real elements; a trailing 4th slot (undefined), or an array-like with the ruled ids -> red
    const spoof = { ERROR: Object.assign(['DIV-F7'], { toJSON: () => EX_IDS.slice() }) };
    red(B6_DOC, B6_C, '(f) the exemption set ', 'a toJSON-spoofed ERROR list', b6ShaOf, B6_PROBE, B6_DIVS, spoof);
    const spoofP = calibrationProblems(B6_DOC, B6_C, b6ShaOf, B6_PROBE, undefined, undefined, B6_DIVS, spoof);
    assert.ok(spoofP.some((x) => x.indexOf('(f) the exemption set ["ERROR"] ERROR=["DIV-F7"] != ') === 0),
        'the (f) line shows the real elements, not the toJSON: ' + JSON.stringify(spoofP));
    red(B6_DOC, B6_C, '(f) the exemption set ', 'a trailing undefined 2nd slot on ERROR', b6ShaOf, B6_PROBE, B6_DIVS,
        { ERROR: EX_IDS.concat([undefined]) });
    red(B6_DOC, B6_C, '(f) the exemption set ', 'an array-like (not an Array) ERROR', b6ShaOf, B6_PROBE, B6_DIVS,
        { ERROR: { 0: 'DIV-F22', length: 1 } });
    // (e) b74 D4: a hollowVolume row counts only when full-length; every row failing -> the floor reads hollow
    const hvFail = b6Copy(B6_DOC);
    for (const k of Object.keys(hvFail.hollowVolume)) for (const l of Object.keys(hvFail.hollowVolume[k])) hvFail.hollowVolume[k][l].failingWorlds = 1;
    red(hvFail, B6_C, '(e)', 'every hollowVolume row failing (no full-length row below CHECK_FLOOR)');
});

test('B6 per-lane kernel map: WIE cut on tree only (D7); a stray cell, a missing or off-parity lane-only kernel -> red', () => {
    // the map (calibrate.mjs): an unlisted lane runs on every binding kernel; a lane's pin joins only when rostered
    // after the roster flip (b68 B2b): roster4 = the pre-flip roster (the 4 S1 lanes), roster5 = the live one
    const roster4 = B6_ROSTER.filter((l) => l !== 'WIE' && l !== 'HOOK' && l !== 'LIFECYCLE' && l !== 'OWNER' && l !== 'RECYCLE' && l !== 'SCHEDULER');
    const roster5 = B6_ROSTER.slice();
    assert.deepEqual(b6KernelsFor('WIE'), ['tree']);
    // S3 R1 (b93): HOOK was cut on headpatched only (DIV-F9 ghost-listener reddened lite-1.5.2 and tree); b117: DIV-F9
    // fixed in A5b, the tree passes HOOK; D-b120-1 (b121 #48 recut): tree joins, headpatched first (covOff), 1.5.2 off
    assert.deepEqual(b6KernelsFor('HOOK'), ['headpatched', 'tree']);
    // S3 R2 (b111 A1 Q1): LIFECYCLE is cut on tree only; b117: DIV-D3 fixed in A5a, no (f) exemption (full-length evidence)
    assert.deepEqual(b6KernelsFor('LIFECYCLE'), ['tree']);
    // R3 (b126 B3; D-b124-1 = PLAN-R3-owner A1): OWNER is cut on tree only: the frozen controls headpatched / rev152 carry
    // DIV-48 (fixed b120-#48 on the tree) in every OWNER world; P-OWNER-TREE is the pass control, P-OWNER-HP a cov-off control
    assert.deepEqual(b6KernelsFor('OWNER'), ['tree']);
    // R4a (b130 B3); b137 D-b137-1: RECYCLE is cut on tree only: the frozen controls carry DIV-51 in every RECYCLE world
    assert.deepEqual(b6KernelsFor('RECYCLE'), ['tree']);
    // R4c (b134 B3; D-b128-3): SCHEDULER is cut on every kernel too, headpatched first (covOff)
    assert.deepEqual(b6KernelsFor('SCHEDULER'), ['headpatched', 'lite-1.5.2', 'tree']);
    assert.deepEqual(b6LanesFor('headpatched', roster5), roster4.concat(['HOOK', 'SCHEDULER']));
    assert.deepEqual(b6KernelsFor('GRAPH'), Object.keys(B6_KERNELS));
    // b74 D4: NEST is cut on headpatched (first: covOff), 1.5.2 and tree; ERROR stays on the binding kernels
    assert.deepEqual(b6KernelsFor('NEST'), Object.keys(B6_KERNELS).concat(['tree']));
    assert.deepEqual(b6KernelsFor('ERROR'), Object.keys(B6_KERNELS));
    assert.deepEqual(b6KernelsOf(['GRAPH', 'BATCH', 'ERROR']), Object.keys(B6_KERNELS));
    assert.deepEqual(b6KernelsOf(roster4), Object.keys(B6_KERNELS).concat(['tree']));
    assert.deepEqual(b6KernelsOf(roster5), Object.keys(B6_KERNELS).concat(['tree']));
    assert.deepEqual(b6LanesFor('tree', roster5), ['NEST', 'WIE', 'HOOK', 'LIFECYCLE', 'OWNER', 'RECYCLE', 'SCHEDULER']);
    assert.deepEqual(b6LanesFor('lite-1.5.2', roster5), roster4.concat(['SCHEDULER']));
    assert.equal(b6KernelPath('tree'), 'Signal.js');
    assert.throws(() => b6KernelPath('nope'), /unknown kernel nope/);
    assert.deepEqual(b6PinnedFor(roster4), B6_PINNED);
    assert.equal(b6PinnedFor(roster4).length, 17);   // S3 R0: + adapters/lite-s3.mjs; S3 R1 (b93): + mirror.mjs
    // b137 76b: every lane pin is parity-pinned too (an edited lane file must move parity.json, not only the cut);
    // LANE_PINS only: PINNED's bench/torture/helpers/index.mjs is deliberately not a parity file (:437)
    for (const f of Object.values(B6_LANE_PINS)) assert.ok(PARITY_FILES.includes(f), f);
    assert.deepEqual(b6PinnedFor(roster5).slice(17), ['bench/soak/lanes/wie.mjs', 'bench/soak/lanes/hook.mjs', 'bench/soak/lanes/lifecycle.mjs', 'bench/soak/lanes/owner.mjs', 'bench/soak/lanes/recycle.mjs', 'bench/soak/lanes/scheduler.mjs']);
    // A2 (the real roster): a WIE cell on lite-1.5.2 is a cell no binding cuts -> exactly one new problem
    const base = calibrationProblems(B6_DOC, B6_C);
    const a2 = b6Copy(B6_DOC);
    a2.kernels['lite-1.5.2'].full.WIE = b6Copy(a2.kernels['lite-1.5.2'].full.GRAPH);
    const a2Got = calibrationProblems(a2, B6_C).filter((x) => base.indexOf(x) === -1);
    assert.deepEqual(a2Got, ['(a) lite-1.5.2 full WIE: a cell no calibrate.mjs binding cuts (lane WIE -> ["tree"]); ' + B6_RECUT]);
    // A3 (the WIE roster, live since the roster flip): tree carries WIE exactly at the floors, clean control
    const lanes5 = B6_LANES;
    const cell = (scenMin, floor, cycles) => {
        const c = { cycles, worlds: 1, ops: 1, failingWorlds: 0, crashes: 0, scenarios: {}, performed: {}, skipTainted: {}, taintRatio: {} };
        for (const s of B6_WIE.required) c.scenarios[s] = scenMin;
        for (const o of B6_WIE.hardOracles) {
            c.performed[o] = floor;
            if (B6_SKIP_NAMES.indexOf(o) !== -1) { c.skipTainted[o] = 0; c.taintRatio[o] = 0; }
        }
        return c;
    };
    const doc5 = b6Copy(B6_DOC);
    const W = B6_WIE;
    doc5.lanes.WIE = { index: 4, required: W.required.slice(), optional: W.optional.slice(), oracles: W.hardOracles.slice() };
    doc5.provenance.pinnedSha256['bench/soak/lanes/wie.mjs'] = b6ShaOf('bench/soak/lanes/wie.mjs');
    doc5.kernels.tree = {
        kernel: 'Signal.js', knownAs: null,
        files: ['Signal.js', 'Watch.js'].map((path) => ({ path, sha256: B6_PARITY_FILES[path] })),
        // the recut NEST cells kept (b74 D4: tree cuts NEST too); WIE at the floors
        full: Object.assign(b6Copy(B6_DOC.kernels.tree.full),
            { WIE: cell(B6_C.SCEN_MIN, B6_C.CHECK_FLOOR, B6_DOC.cut.cycles) }),
        smoke: Object.assign(b6Copy(B6_DOC.kernels.tree.smoke),
            { WIE: cell(B6_C.SCEN_MIN_SMOKE, B6_C.CHECK_FLOOR_SMOKE, B6_DOC.cut.smokeCycles) }),
    };
    // D-b120-1 (b121): tree cuts HOOK too; its HOOK cells and HOOK cov-off sweep rows stand in from headpatched's (b121
    // U1 pre-check: the tree:HOOK smoke cell folds field for field to headpatched:HOOK), so the control needs no recut
    for (const sz of ['full', 'smoke']) doc5.kernels.tree[sz].HOOK = b6Copy(B6_DOC.kernels.headpatched[sz].HOOK);
    for (const key of Object.keys(B6_DOC.covOffSweep.cells)) {
        if (key.startsWith('headpatched:HOOK:')) doc5.covOffSweep.cells['tree' + key.slice(11)] = b6Copy(B6_DOC.covOffSweep.cells[key]);
    }
    const cp5 = (doc) => calibrationProblems(doc, B6_C, b6ShaOf, B6_PROBE, lanes5);
    assert.deepEqual(cp5(doc5), [], 'control: the synthetic WIE roster with tree at the floors is clean');
    // + WIE cells on lite-1.5.2 (pre-b33: DIV-B33 by design) -> exactly the full + smoke lines
    const stray = b6Copy(doc5);
    stray.kernels['lite-1.5.2'].full.WIE = b6Copy(doc5.kernels.tree.full.WIE);
    stray.kernels['lite-1.5.2'].smoke.WIE = b6Copy(doc5.kernels.tree.smoke.WIE);
    const why = ': a cell no calibrate.mjs binding cuts (lane WIE -> ["tree"]); ' + B6_RECUT;
    assert.deepEqual(cp5(stray), ['(a) lite-1.5.2 full WIE' + why, '(a) lite-1.5.2 smoke WIE' + why]);
    // no tree evidence -> the kernel-key line and the missing-evidence line
    const noTree = b6Copy(doc5);
    delete noTree.kernels.tree;
    const noTreeGot = cp5(noTree);
    const keyLine = '(a) doc.kernels ["headpatched","lite-1.5.2"] != calibrate.mjs kernels ["headpatched","lite-1.5.2","tree"]; '
        + B6_RECUT;
    assert.ok(noTreeGot.includes(keyLine), JSON.stringify(noTreeGot));
    assert.ok(noTreeGot.includes('(a) kernel tree has no evidence'), JSON.stringify(noTreeGot));
    // a tree file off parity.json (D7) -> (p)
    const off = b6Copy(doc5);
    off.kernels.tree.files[0].sha256 = 'f'.repeat(64);
    const offGot = cp5(off);
    const offLine = '(p) kernel tree Signal.js sha ' + 'f'.repeat(64) + ' != parity.json ' + B6_PARITY_FILES['Signal.js'] + '; '
        + B6_RECUT;
    assert.ok(offGot.includes(offLine), JSON.stringify(offGot));
    // the evidence must BE the tree's Signal.js + Watch.js: wrong cut, empty, partial, or another kernel's path -> (p)
    const evLine = (doc) => cp5(doc).filter((x) => x.startsWith('(p) kernel tree evidence is '));
    assert.deepEqual(evLine(doc5), [], 'control: tree evidence is the tree files');
    const pre = b6Copy(doc5);   // (a) a doc cut on the pre-b33 control copies (their shas are real, just the wrong engine)
    pre.kernels.tree.kernel = 'bench/soak/controls/preb33/Signal.js';
    pre.kernels.tree.files = ['bench/soak/controls/preb33/Signal.js', 'bench/soak/controls/preb33/Watch.js']
        .map((path) => ({ path, sha256: b6ShaOf(path) }));
    const none = b6Copy(doc5);   // (b)
    none.kernels.tree.files = [];
    const part = b6Copy(doc5);   // (c)
    part.kernels.tree.files = part.kernels.tree.files.filter((f) => f.path === 'Watch.js');
    const old = b6Copy(doc5);    // (d) kernel names the 1.5.2 path, files untouched
    old.kernels.tree.kernel = b6KernelPath('lite-1.5.2');
    for (const [name, d] of [['pre-b33 cut', pre], ['no files', none], ['Watch.js only', part], ['1.5.2 kernel path', old]]) {
        assert.equal(evLine(d).length, 1, name + ': ' + JSON.stringify(cp5(d)));
    }
    // (b) no files: the evidence line and the lists-no-files line, nothing else
    assert.deepEqual(cp5(none), ['(p) kernel tree lists no files; ' + B6_RECUT,
        '(p) kernel tree evidence is Signal.js [], not ["Signal.js","Watch.js"]; ' + B6_RECUT]);
    // (e) an extra file with no parity.json key (real sha, so only the null-is-not-a-sha rule can catch it)
    const extra = b6Copy(doc5);
    extra.kernels.tree.files.push({ path: 'package.json', sha256: b6ShaOf('package.json') });
    const extraLine = '(p) kernel tree package.json sha ' + b6ShaOf('package.json') + ' != parity.json null; ' + B6_RECUT;
    assert.ok(cp5(extra).includes(extraLine), JSON.stringify(cp5(extra)));
    // a kernel whose files is not a non-empty array lists no files -> (p)
    const abc = b6Copy(B6_DOC);
    abc.kernels.headpatched.files = 'abc';
    const abcGot = calibrationProblems(abc, B6_C);
    assert.ok(abcGot.includes('(p) kernel headpatched lists no files; ' + B6_RECUT), JSON.stringify(abcGot));
});

test('B6 drift guard live: main.mjs --smoke on every kernelsOf(roster) kernel folds to exactly kernels.<k>.smoke', async () => {
    const live = await b6LiveRun();
    assert.deepEqual(Object.keys(live), b6KernelsOf(B6_ROSTER));
    assert.deepEqual(b6LiveMismatch(B6_DOC, live), []);
    // must-fail: hand edits that still clear every constant are caught only by the re-measure (J1 and its twin)
    for (const k of Object.keys(B6_KERNELS)) {
        const edited = b6Copy(B6_DOC);
        edited.kernels[k].smoke.ERROR.scenarios.aggregate += 1;
        assert.deepEqual(calibrationProblems(edited, B6_C), [], 'precondition: the static checks cannot see this edit');
        assert.deepEqual(b6LiveMismatch(edited, live), [k + ':ERROR'], k);
    }
});

test('B6 drift guard live probe: main.mjs on PROBE runs a LARGE world every cycle and folds to exactly doc.probe.fold', async () => {
    const live = await b6ProbeRun();
    assert.equal(live.cycles, B6_PROBE.cycles, 'one cycle record per PROBE cycle');
    assert.ok(live.lanes.every((l) => l === B6_PROBE.lane), JSON.stringify(live.lanes));
    assert.ok(live.largeWorldsPerCycle.every((n) => n >= 1), 'every probe cycle ran a LARGE world: ' + JSON.stringify(live.largeWorldsPerCycle));
    assert.deepEqual(live.boundaries, live.boundaries.map(() => [0, 0]), 'every probe boundary: trackerSize 0, weakAlive 0');
    assert.deepEqual(b6ProbeMismatch(B6_DOC.probe, live), []);
    // must-fail twin: a hand edit of the probe fold is caught by the re-measure
    const edited = b6Copy(B6_DOC.probe);
    edited.fold.ops += 1;
    assert.deepEqual(b6ProbeMismatch(edited, live), ['fold'], 'fold.ops + 1 must mismatch');
    // must-fail twins of the run shape: a forced non-zero exit, a non-PASS verdict, a record after the summary
    const raw = (f) => { const m = b6Copy(live.raw); f(m); return b6ProbeRunProblems(m); };
    assert.deepEqual(raw((m) => { m.status = 1; }), ['exit 1 != 0']);
    assert.deepEqual(raw((m) => { m.recs[m.recs.length - 1].verdict = 'FAIL'; }), ['summary verdict FAIL exitCode 0 != PASS 0']);
    assert.deepEqual(raw((m) => { m.recs.push(m.recs[1]); }), ['last record is cycle, not the summary', 'summary verdict undefined exitCode undefined != PASS 0']);
});

test('B6 TAINT_SKIP_MAX: every clean cell at or below it; the NEST cov-off (every NEST kernel, 17 seeds) is left to coverage (b70 D6 V1)', () => {
    assert.ok(B6_TAINT_MAX <= CFG.TAINT_SKIP_MAX, JSON.stringify([B6_TAINT_MAX, CFG.TAINT_SKIP_MAX]));
    assert.equal(B6_COV.length, 17);
    // under V1 the cov-off skip ratio is no taint tooth (ADDENDUM 1 item 2; REPORTED in covOffSweep): coverage catches
    // it on every NEST kernel (0 hits); the taint-skip must-fail is test/67 P-NEST-TAINT-HALF
    for (const k of b6KernelsFor('NEST')) {
        for (const c of B6_DOC.covOffSweep.cells[k + ':NEST:saved-cursor-hazard']) assert.ok(c.hits < CFG.SCEN_MIN_SMOKE, k + ' ' + JSON.stringify(c));
    }
});

/* ---- S2 A-B2p (DELTA 1 task 9 / 10, assertions D3 + D4): SCHEMA_VERSION 2, SOAK_NEARWRAP, header.nearwrap ---- */

const NW_REPORT = join(SOAK, 'SoakReport.mjs');
const NW_WRAP = join(SOAK, 'wrap.mjs');
const nwRecs = (out) => readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('D3 schema: SCHEMA_VERSION is 2; a default header carries schemaVersion 2, nearwrap null, config.SOAK_NEARWRAP {null, default}', () => {
    assert.equal(CFG.SCHEMA_VERSION, 2);
    assert.ok(CFG.KNOWN_KEYS.includes('SOAK_NEARWRAP'));
    assert.deepEqual(P({}).record.SOAK_NEARWRAP, { value: null, source: 'default' });
    assert.equal(P({}).nearwrap, null);
    const r = run({ SOAK_LANES: 'GRAPH', SOAK_KERNEL: join(HP, 'Signal.js') }, { entry: 'inline' });
    assert.equal(r.status, 3, r.stderr);
    const h = nwRecs(r.out)[0];
    assert.equal(h.schemaVersion, 2);
    assert.ok(Object.prototype.hasOwnProperty.call(h, 'nearwrap'), 'header.nearwrap is present');
    assert.equal(h.nearwrap, null);
    assert.deepEqual(h.config.SOAK_NEARWRAP, { value: null, source: 'default' });
    for (const k of ['SEMI_SPACE_MB', 'WRAP_CHUNK', 'NS_K_CYCLE', 'WRAP_MAX_NODES', 'W4_SAMPLE_MASK', 'REPR_TIMEOUT_MS', 'BASELINE_MAX_BYTES', 'NEARWRAP_K_MAX']) {
        assert.equal(h.gates[k], CFG[k], 'gates.' + k);
    }
    assert.deepEqual([CFG.SEMI_SPACE_MB, CFG.WRAP_CHUNK, CFG.NS_K_CYCLE, CFG.WRAP_MAX_NODES, CFG.W4_SAMPLE_MASK, CFG.REPR_TIMEOUT_MS, CFG.BASELINE_MAX_BYTES, CFG.NEARWRAP_K_MAX],
        [4, 2 ** 24, 4096, 64, 0xFFFFF, 600000, 8192, 64]);
});

test('D4 SOAK_NEARWRAP: sign:0, sign:65, up:8, sign:08 (and empty, zero:-1, sign:8 with a space) exit 2 in config AND in kernel.mjs alone', () => {
    for (const bad of ['sign:0', 'sign:65', 'up:8', 'sign:08', '', 'zero:-1', 'sign: 8', 'sign:8 ']) {
        rejects({ SOAK_NEARWRAP: bad }, "SOAK_NEARWRAP='" + bad + "'");
    }
    rejects({ SOAK_NEARWRAP: 'sign:65' }, 'k must be in [1, 64]');
    for (const bad of ['sign:0', 'sign:65', 'up:8', 'sign:08']) {
        assertConfigExit(run({ SOAK_NEARWRAP: bad }), ["SOAK_NEARWRAP='" + bad + "'"]);
        assertConfigExit(run({ SOAK_NEARWRAP: bad }, { entry: 'kernel' }), ["SOAK_NEARWRAP='" + bad + "'"]);
    }
    // positive control: the edges parse
    assert.deepEqual(P({ SOAK_NEARWRAP: 'sign:1' }).nearwrap, { phase: 'sign', k: 1 });
    assert.deepEqual(P({ SOAK_NEARWRAP: 'zero:64' }).record.SOAK_NEARWRAP, { value: { phase: 'zero', k: 64 }, source: 'env' });
});

test('D4 NEARWRAP sign:8 end to end: header.nearwrap.derivedSha256 == kernel.files[0].sha256; soak:report exits 1 NOT A RELEASE SOAK -- nearwrap, never 0', () => {
    const r = run({ SOAK_NEARWRAP: 'sign:8', SOAK_LANES: 'GRAPH', SOAK_CYCLES: '11', SOAK_OPS: '20000' }, { extraEnv: {} });
    assert.ok(r.status === 0 || r.status === 1, 'the run completes (exit ' + r.status + ')\n' + r.stderr);
    const h = nwRecs(r.out)[0];
    assert.equal(h.schemaVersion, 2);
    assert.equal(h.nearwrap.phase, 'sign');
    assert.equal(h.nearwrap.k, 8);
    assert.equal(h.nearwrap.derivedSha256, h.kernel.files[0].sha256, 'the loaded kernel IS the derived one');
    assert.notEqual(h.nearwrap.derivedSha256, h.nearwrap.baseSha256);
    assert.ok(h.nearwrap.rewrites.length >= 3 && h.nearwrap.rewrites.every((x) => x.to === String(x.arith === 'mask30' ? 2 ** 30 - 8 : 2 ** 31 - 8)), JSON.stringify(h.nearwrap.rewrites));
    assert.equal(h.kernel.override, false);
    assert.deepEqual(h.config.SOAK_NEARWRAP, { value: { phase: 'sign', k: 8 }, source: 'env' });
    const rep = spawnSync(process.execPath, [NW_REPORT, r.out], { encoding: 'utf8', timeout: 60000 });
    assert.equal(rep.status, 1, rep.stderr);
    assert.match(rep.stderr, /^soak:report: NOT A RELEASE SOAK -- nearwrap: sign:8 -- /m, 'the NEARWRAP reason fires first (before tree-parity)');
});

test('D4 SOAK_NEARWRAP with a non-lite SOAK_ENGINE exits 2 (config, and kernel.mjs on its own)', () => {
    const env = { SOAK_NEARWRAP: 'sign:8', SOAK_ENGINE: 'polyfill' };
    assertConfigExit(run(env), ['SOAK_NEARWRAP derives the lite kernel', "SOAK_ENGINE='polyfill'"]);
    assertConfigExit(run(env, { entry: 'kernel' }), ['SOAK_NEARWRAP derives the lite kernel', "SOAK_ENGINE='polyfill'"]);
});

test('D4 the wrap job refuses a NEARWRAP kernel: wrap.mjs with SOAK_NEARWRAP=zero:63 exits 2 before anything is derived or written', () => {
    const src = readFileSync(join(ROOT, 'Signal.js'), 'utf8');
    const d = nwDerive(src, { phase: 'zero', k: 63 });
    const wsha = createHash('sha256').update(readFileSync(join(ROOT, 'Watch.js'))).digest('hex');
    const NWROOT = join(SOAK, 'out', 'nearwrap');
    const nwDir = join(NWROOT, d.derivedSha256.slice(0, 7) + '-' + wsha.slice(0, 7));
    // any folder named for this derived kernel, under any naming scheme (<sha7> or <sha7>-<watch sha7>)
    const derivedDirs = () => (existsSync(NWROOT) ? readdirSync(NWROOT) : []).filter((n) => n.indexOf(d.derivedSha256.slice(0, 7)) === 0);
    for (const n of derivedDirs()) rmSync(join(NWROOT, n), { recursive: true, force: true });

    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_OPTIONS' && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    const out = join(TMP, 'nw-wrap.jsonl');
    Object.assign(env, { SOAK_NEARWRAP: 'zero:63', SOAK_WRAP: 'W1', SOAK_OUT: out });
    const w = spawnSync(process.execPath, ['--expose-gc', '--min-semi-space-size=4', '--max-semi-space-size=4', NW_WRAP], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(w.status, 2, w.stderr);
    assert.match(w.stderr, /^soak: CONFIG -- the wrap job drives the real kernel; a NEARWRAP kernel is refused$/m);
    assert.doesNotMatch(w.stderr, /semi-space/, 'the pure-config NEARWRAP refusal fires before the semi-space probe');
    assert.equal(existsSync(out), false, 'no stream');
    assert.equal(existsSync(nwDir), false, 'no derived kernel written: ' + nwDir);
    assert.deepEqual(derivedDirs(), [], 'no derived kernel written under any name');
});

/* ---- 0b TASK 6 (assertions 1 + 2): refusal order, and a version-independent semi-space band ------------ */

// wrap.mjs refuses pure-config faults (burn-in keys, SOAK_NEARWRAP) BEFORE it probes the environment: a NEARWRAP
// run on a host without the semi-space trio (node 22 CI, `node --expose-gc wrap.mjs`) must see the NEARWRAP line,
// never the semi-space one. The band is (4 MB - 4 MB/16, 4 MB]: node 24/26 read 4 MB - 256 B, node 22 reads
// 4 MB - 70,656 B (4123648), and the nearest wrong pin (--max-semi-space-size=3 or 5) is a whole MB away.
const wrapEnv = (caseEnv) => {
    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_OPTIONS' && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    return Object.assign(env, caseEnv);
};

test('0b semiSpaceProblem: the 4 MB band is (4194304 - 262144, 4194304] on every node major; every flag-vector reason is unchanged', async () => {
    const { semiSpaceProblem } = await import(pathToFileURL(NW_WRAP).href);
    const F = ['--min-semi-space-size=4', '--max-semi-space-size=4'];
    const capLine = (c) => 'new_space capacity ' + c + ' B is not the pinned 4 MB semi-space';
    // in band: the node 22 reading (4123648 = 4 MB - 70,656 B), the node 24/26 reading (4194048), both edges
    for (const c of [3932161, 4123648, 4128768, 4128769, 4194048, 4194304]) assert.equal(semiSpaceProblem(F, c), null, 'cap ' + c);
    for (const c of [1048512, 2097152, 3932160, 4194305, 8388608]) assert.equal(semiSpaceProblem(F, c), capLine(c), 'cap ' + c);
    assert.equal(semiSpaceProblem(F, -1), 'v8.getHeapSpaceStatistics() reports no new_space');
    // the flag parse is unchanged: every reason byte-identical to HEAD cf956bd (an in-band capacity never rescues a bad flag)
    const flagVectors = [
        [[], '--min-semi-space-size=4 is not in execArgv'],
        [['--min-semi-space-size=4'], '--max-semi-space-size=4 is not in execArgv'],
        [['--max-semi-space-size=4'], '--min-semi-space-size=4 is not in execArgv'],
        [['--min-semi-space-size=4', '--max-semi-space-size=8'], '--max-semi-space-size=8 is not 4'],
        [['--min_semi_space_size=4', '--max_semi_space_size=4'], null],
        [['--min-semi-space-size=4', '--max-semi-space-size'], '--max-semi-space-size= is not 4'],
        [['--min-semi-space-size=04', '--max-semi-space-size=4'], '--min-semi-space-size=04 is not 4'],
    ];
    for (const [flags, want] of flagVectors) {
        assert.equal(semiSpaceProblem(flags, 4194048), want, JSON.stringify(flags));
        assert.equal(semiSpaceProblem(flags, 4123648), want, JSON.stringify(flags) + ' at the node 22 capacity');
    }
});

test('0b the wrap job refuses SOAK_NEARWRAP before the semi-space probe: NEARWRAP + --expose-gc only exits 2 on the NEARWRAP line', () => {
    const src = readFileSync(join(ROOT, 'Signal.js'), 'utf8');
    const d = nwDerive(src, { phase: 'zero', k: 63 });
    const NWROOT = join(SOAK, 'out', 'nearwrap');
    const derivedDirs = () => (existsSync(NWROOT) ? readdirSync(NWROOT) : []).filter((n) => n.indexOf(d.derivedSha256.slice(0, 7)) === 0);
    for (const n of derivedDirs()) rmSync(join(NWROOT, n), { recursive: true, force: true });
    const out = join(TMP, 'nw-wrap-gconly.jsonl');
    const w = spawnSync(process.execPath, ['--expose-gc', NW_WRAP], { cwd: ROOT, env: wrapEnv({ SOAK_NEARWRAP: 'zero:63', SOAK_WRAP: 'W1', SOAK_OUT: out }), encoding: 'utf8', timeout: 60000 });
    assert.equal(w.status, 2, w.stderr);
    assert.equal(w.stderr, 'soak: CONFIG -- the wrap job drives the real kernel; a NEARWRAP kernel is refused\n');
    assert.equal((w.stderr.match(/semi-space/g) || []).length, 0, 'no semi-space line');
    assert.equal(w.stdout, '');
    assert.equal(existsSync(out), false, 'no stream');
    assert.deepEqual(derivedDirs(), [], 'no derived kernel written under any name');
});

// --expose-gc stays on: without it readConfig refuses first ('--expose-gc is required'), which would not reach the probe
test('0b control: without SOAK_NEARWRAP and without the semi-space flags the wrap job still exits 2 on the semi-space probe', () => {
    const out = join(TMP, 'wrap-noflags.jsonl');
    const w = spawnSync(process.execPath, ['--expose-gc', NW_WRAP], { cwd: ROOT, env: wrapEnv({ SOAK_WRAP: 'W1', SOAK_OUT: out }), encoding: 'utf8', timeout: 60000 });
    assert.equal(w.status, 2, w.stderr);
    assert.equal(w.stderr, 'soak: CONFIG -- the wrap job needs the pinned semi-space: --min-semi-space-size=4 is not in execArgv (run: npm run soak:wrap)\n');
    assert.equal(w.stdout, '');
    assert.equal(existsSync(out), false, 'no stream');
});
