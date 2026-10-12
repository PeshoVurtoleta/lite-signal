/**
 * test/40-soak-infra.test.mjs -- the soak's evidence plumbing: parity pin CLI, JSONL stream + fatal path,
 * seed derivation (SPEC-B v2 sections 1, 7, 8). Every gate here is fail-closed; each case asserts the exact
 * exit code, never "0 or 1".
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStream, writeRecord, writeFatal, RECORD_TYPES } from '../bench/soak/jsonl.mjs';
import { fmix32, unfmix32, seedFor, worldSeed, selfCheckSeeds, remapCollision, REMAP_PREIMAGE, LANE_LIMIT, CYCLE_LIMIT } from '../bench/soak/seeds.mjs';
import { CYCLES_MAX, DEFAULT_SEED, ROSTER_MAX } from '../bench/soak/config.mjs';
import { PARITY_FILES } from '../bench/soak/parity.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOAK = join(ROOT, 'bench', 'soak');
const TMP = mkdtempSync(join(tmpdir(), 'soak-infra-'));
after(() => { rmSync(TMP, { recursive: true, force: true }); });

function node(args, opts = {}) {
    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, env, ...opts });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/* -- parity CLI --------------------------------------------------------------------------------------- */

let layoutN = 0;
/** A scratch repo layout: <dir>/{every PARITY_FILES entry, bench/soak/parity.mjs}, pinned and green. */
function parityLayout() {
    const dir = join(TMP, 'parity-' + (layoutN++));
    mkdirSync(join(dir, 'bench', 'soak'), { recursive: true });
    for (const f of PARITY_FILES) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        copyFileSync(join(ROOT, f), join(dir, f));
    }
    copyFileSync(join(SOAK, 'parity.mjs'), join(dir, 'bench', 'soak', 'parity.mjs'));
    const up = node([join(dir, 'bench', 'soak', 'parity.mjs'), '--update']);
    assert.equal(up.status, 0, up.stderr);
    return { dir, cli: join(dir, 'bench', 'soak', 'parity.mjs'), pin: join(dir, 'bench', 'soak', 'parity.json') };
}
const readPins = (L) => JSON.parse(readFileSync(L.pin, 'utf8'));

test('parity: a fresh pin checks OK (exit 0); the shipped parity.json is green', () => {
    const L = parityLayout();
    const r = node([L.cli]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp('^parity: OK \\(' + PARITY_FILES.length + ' files'));
    const live = node([join(SOAK, 'parity.mjs')]);
    assert.equal(live.status, 0, live.stderr);
});

test('parity: mismatch, missing file and an extra pinned file each exit 1', () => {
    const L1 = parityLayout();
    writeFileSync(join(L1.dir, 'Signal.js'), readFileSync(join(L1.dir, 'Signal.js'), 'utf8') + '\n// drift\n');
    let r = node([L1.cli]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /parity: FAIL -- Signal\.js sha256 [0-9a-f]{12} != pinned/);

    const L2 = parityLayout();
    unlinkSync(join(L2.dir, 'Watch.js'));
    r = node([L2.cli]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Watch\.js sha256 missing != pinned/);

    const L3 = parityLayout();
    const p = readPins(L3);
    p.files['README.md'] = 'a'.repeat(64);
    writeFileSync(L3.pin, JSON.stringify(p));
    r = node([L3.cli]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /README\.md is pinned but is not one of PARITY_FILES/);
});

test('parity: malformed pin files exit 2 (fail closed, never "nothing to compare = OK")', () => {
    const cases = [
        ['not JSON', '{"files": '],
        ['files is an array', JSON.stringify({ files: ['Signal.js'] })],
        ['top-level array', JSON.stringify([{ files: {} }])],
        ['no files key', JSON.stringify({ pins: {} })],
        ['non-string pin', null],
        ['pin is not sha256 hex', null],
    ];
    for (const [label, body] of cases) {
        const L = parityLayout();
        let text = body;
        if (label === 'non-string pin') { const p = readPins(L); p.files['Signal.js'] = 42; text = JSON.stringify(p); }
        if (label === 'pin is not sha256 hex') { const p = readPins(L); p.files['Watch.js'] = 'XYZ'; text = JSON.stringify(p); }
        writeFileSync(L.pin, text);
        const r = node([L.cli]);
        assert.equal(r.status, 2, label + ': ' + r.stderr);
        assert.match(r.stderr, /^parity: FAIL -- /, label);
    }
    const L = parityLayout();
    unlinkSync(L.pin);
    const r = node([L.cli]);
    assert.equal(r.status, 2, 'missing pin file: ' + r.stderr);
    assert.match(r.stderr, /cannot read .*parity\.json/);
    const bad = node([parityLayout().cli, '--updtae']);
    assert.equal(bad.status, 2, 'unknown argument');
});

test('parity: invoked through a SYMLINKED path it still runs the check (was a silent exit 0)', () => {
    const L = parityLayout();
    writeFileSync(join(L.dir, 'Signal.js'), '// drifted\n');
    const link = join(TMP, 'link-' + layoutN);
    symlinkSync(L.dir, link);
    const viaLink = node([join(link, 'bench', 'soak', 'parity.mjs')]);
    assert.equal(viaLink.status, 1, 'symlinked run must report the mismatch: ' + viaLink.stdout + viaLink.stderr);
    assert.match(viaLink.stderr, /parity: FAIL -- Signal\.js/);
    const viaReal = node([L.cli]);
    assert.equal(viaReal.status, 1);
});

/* -- jsonl ---------------------------------------------------------------------------------------------- */

test('jsonl: closed record types (no phantom checkpoint); a refused or failed write leaves seq and file unchanged', () => {
    for (const kind of Object.keys(RECORD_TYPES)) assert.equal(RECORD_TYPES[kind].indexOf('checkpoint'), -1, kind);
    const path = join(TMP, 'types.jsonl');
    const s = openStream(path, performance.now(), 'burn-in');
    writeRecord(s, 'header', { a: 1 });
    assert.throws(() => writeRecord(s, 'checkpoint', {}), /not a burn-in record/);
    assert.throws(() => writeRecord(s, 'wrap', {}), /not a burn-in record/);
    assert.throws(() => writeFatal(s, 'oops', {}, new Error('x')), /unknown fatal kind/);
    assert.throws(() => openStream(join(TMP, 'k.jsonl'), 0, 'checkpoint'), /unknown stream kind/);
    assert.equal(s.seq, 1);
    writeRecord(s, 'cycle', { c: 0 });
    const recs = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(recs.map((r) => [r.type, r.seq]), [['header', 0], ['cycle', 1]]);
    // a failed append (path is a directory) must not consume a seq number
    const broken = { path: TMP, t0: 0, kind: 'burn-in', seq: 7, summarized: false };
    assert.throws(() => writeRecord(broken, 'cycle', {}));
    assert.equal(broken.seq, 7);
});

const JSONL_URL = pathToFileURL(join(SOAK, 'jsonl.mjs')).href;
function fatalChild(mode, out) {
    const src = `
const J = await import(${JSON.stringify(JSONL_URL)});
const s = J.openStream(${JSON.stringify(out)}, performance.now(), 'burn-in');
J.writeRecord(s, 'header', {});
const mode = ${JSON.stringify(mode)};
const summarize = (reason) => {
    if (mode === 'reenter' && reason === 'fatal') process.emit('uncaughtException', new Error('nested'));
    if (mode === 'sumthrow') throw new Error('summary write failed');
    J.writeRecord(s, 'summary', { reason });
};
const fatal = J.installFatalHandlers(s, () => ({ lane: 'GRAPH', cycle: 3, world: 9, worldSeed: 0x1234 }), summarize);
if (mode === 'throw' || mode === 'reenter' || mode === 'sumthrow') setTimeout(() => { throw new Error('boom'); }, 0);
if (mode === 'reject') Promise.reject(new Error('rejected'));
if (mode === 'main') fatal('mainRejection', new Error('main failed'));
if (mode === 'clean') { summarize('end'); J.endLine('PASS', 0, s.seq); }
// mode 'lost': nothing -- the loop drains with no summary
`;
    return node(['--input-type=module', '-e', src]);
}

test('jsonl: uncaughtException / unhandledRejection / mainRejection / lostRun -> fatal + summary + CRASH + END, exit 1', () => {
    for (const [mode, kind] of [['throw', 'uncaughtException'], ['reject', 'unhandledRejection'], ['main', 'mainRejection'], ['lost', 'lostRun']]) {
        const out = join(TMP, 'fatal-' + mode + '.jsonl');
        const r = fatalChild(mode, out);
        assert.equal(r.status, 1, mode + ': ' + r.stderr);
        const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.deepEqual(recs.map((x) => x.type), ['header', 'fatal', 'summary'], mode);
        assert.deepEqual(recs.map((x) => x.seq), [0, 1, 2], mode);
        assert.equal(recs[1].kind, kind);
        assert.deepEqual([recs[1].lane, recs[1].cycle, recs[1].world, recs[1].worldSeed], ['GRAPH', 3, 9, 0x1234]);
        assert.equal(recs[2].reason, 'fatal');
        const err = r.stderr.trim().split('\n');
        assert.equal(err.length, 1, mode + ' one protocol line: ' + r.stderr);
        assert.ok(err[0].startsWith('soak: CRASH -- ' + kind + ': '), err[0]);
        assert.equal(r.stdout.trim().split('\n').pop(), 'soak: END verdict=FAIL exit=1 records=3', mode);
    }
});

test('jsonl: a re-entrant fatal is absorbed -- one fatal record, the outer handler still writes summary + END', () => {
    const out = join(TMP, 'fatal-reenter.jsonl');
    const r = fatalChild('reenter', out);
    assert.equal(r.status, 1, r.stderr);
    const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(recs.map((x) => x.type), ['header', 'fatal', 'summary']);
    assert.match(r.stdout, /soak: END verdict=FAIL exit=1 records=3\n$/);
});

test('jsonl: a run that writes its summary never trips lostRun (control), and an existing SOAK_OUT is never truncated', () => {
    const out = join(TMP, 'fatal-clean.jsonl');
    const r = fatalChild('clean', out);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(recs.map((x) => x.type), ['header', 'summary']);
    const again = fatalChild('clean', out);
    assert.equal(again.status, 2, again.stderr);
    assert.match(again.stderr, /^soak: CONFIG -- SOAK_OUT: .* already exists; refusing to overwrite/);
    assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 2, 'previous stream intact');
});

/* -- seeds ---------------------------------------------------------------------------------------------- */

test('seeds: self-check passes for every roster size 1..16 and rejects 0, 17 and a bad span', () => {
    assert.equal(ROSTER_MAX, LANE_LIMIT);
    for (let n = 1; n <= LANE_LIMIT; n++) {
        assert.equal(selfCheckSeeds(DEFAULT_SEED, n), null, 'lanes=' + n);
        assert.equal(selfCheckSeeds(0, n), null, 'base 0, lanes=' + n);
    }
    assert.match(selfCheckSeeds(DEFAULT_SEED, 0), /does not fit/);
    assert.match(selfCheckSeeds(DEFAULT_SEED, 17), /does not fit/);
    assert.match(selfCheckSeeds(DEFAULT_SEED, 4, 0), /cycle span 0/);
    assert.match(selfCheckSeeds(DEFAULT_SEED, 4, CYCLE_LIMIT + 1), /cycle span/);
});

test('seeds: the cycle index never wraps (c and c + 2^28 would alias): seedFor throws at the cap; CYCLES_MAX equals it', () => {
    assert.equal(CYCLES_MAX, CYCLE_LIMIT);
    assert.equal(typeof seedFor(1, 3, CYCLE_LIMIT - 1), 'number');
    for (const bad of [CYCLE_LIMIT, -1, 1.5, NaN]) assert.throws(() => seedFor(1, 0, bad), RangeError, String(bad));
    for (const bad of [LANE_LIMIT, -1]) assert.throws(() => seedFor(1, bad, 0), RangeError, 'lane ' + bad);
    assert.throws(() => worldSeed(1, -1), RangeError);
    // the aliasing the cap prevents is real: without it, (cycle << 4) drops bit 28
    assert.equal(((CYCLE_LIMIT) << 4) >>> 0, 0);
});

test('seeds: seed 0 is remapped; world seeds of one lane-cycle are distinct', () => {
    assert.equal(fmix32(0), 0);
    assert.equal(seedFor(0, 0, 0), 0x9e3779b9);
    const cs = seedFor(DEFAULT_SEED, 2, 5);
    const seen = new Set();
    for (let w = 0; w < 65536; w++) seen.add(worldSeed(cs, w));
    assert.equal(seen.size, 65536);
});

test('seeds: the only possible collision (the remap value) cannot occur in the default self-check span', () => {
    // fmix32 is a bijection, so the self-check can only fire if some input maps to 0 (remapped to
    // 0x9e3779b9) AND the natural preimage of 0x9e3779b9 is also an input. Invert fmix32 and show it is not.
    const inv = (a) => { let x = a; for (let i = 0; i < 5; i++) x = Math.imul(x, 2 - Math.imul(a, x)) >>> 0; return x >>> 0; };
    const unfmix = (h) => {
        h >>>= 0;
        h ^= h >>> 16;
        h = Math.imul(h, inv(0xc2b2ae35)) >>> 0;
        h ^= (h >>> 13) ^ (h >>> 26);
        h = Math.imul(h >>> 0, inv(0x85ebca6b)) >>> 0;
        h ^= h >>> 16;
        return h >>> 0;
    };
    for (const x of [1, 0xdeadbeef, 0x9e3779b9, 0xffffffff]) assert.equal(fmix32(unfmix(x)), x, 'inverse is exact');
    const pre = unfmix(0x9e3779b9);
    const span = 1024 << 4;   // packed (cycle << 4) | lane for the default 1024-cycle self-check
    const zeroReachable = (DEFAULT_SEED >>> 0) < span;
    const remapReachable = ((pre ^ DEFAULT_SEED) >>> 0) < span;
    assert.ok(!(zeroReachable && remapReachable));
});

test('jsonl: summarize() throwing after the fatal record landed -- END still counts what was written (records=2)', () => {
    const out = join(TMP, 'fatal-sumthrow.jsonl');
    const r = fatalChild('sumthrow', out);
    assert.equal(r.status, 1, r.stderr);
    const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(recs.map((x) => x.type), ['header', 'fatal']);
    const err = r.stderr.trim().split('\n');
    assert.equal(err.length, 2, r.stderr);
    assert.ok(err[0].startsWith('soak: CRASH -- fatal-handler write failed: Error: summary write failed'), err[0]);
    assert.ok(err[1].startsWith('soak: CRASH -- uncaughtException: Error: boom'), err[1]);
    assert.equal(r.stdout.trim().split('\n').pop(), 'soak: END verdict=FAIL exit=1 records=2');
});

test('seeds: unfmix32 inverts fmix32 exactly, both ways', () => {
    for (const x of [0, 1, 0x9e3779b9, 0xdeadbeef, 0xffffffff, 0x0af4f978]) {
        assert.equal(fmix32(unfmix32(x)), x >>> 0);
        assert.equal(unfmix32(fmix32(x)), x >>> 0);
    }
    assert.equal(fmix32(REMAP_PREIMAGE), 0x9e3779b9);
});

test('seeds: remapCollision is exact for any span -- a crafted colliding base, verified by seedFor, and its controls', () => {
    // base 0: packed 0 (cycle 0, lane 0) hashes to 0 and is remapped; packed REMAP_PREIMAGE hashes to the
    // remap value naturally. The pair is reachable iff cycles > REMAP_PREIMAGE >>> 4 and lanes > its lane.
    const cB = REMAP_PREIMAGE >>> 4, lB = REMAP_PREIMAGE & 15;
    const hit = remapCollision(0, lB + 1, cB + 1);
    assert.deepEqual(hit, { cycleA: 0, laneA: 0, cycleB: cB, laneB: lB });
    assert.equal(seedFor(0, hit.laneA, hit.cycleA), seedFor(0, hit.laneB, hit.cycleB), 'the two (lane, cycle) really share a seed');
    assert.equal(seedFor(0, hit.laneA, hit.cycleA), 0x9e3779b9);
    assert.equal(remapCollision(0, lB + 1, cB), null, 'control: one cycle short of cycleB');
    assert.equal(remapCollision(0, lB, cB + 1), null, 'control: lane index lB is outside a roster of lB lanes');
    assert.deepEqual(remapCollision(0, lB + 1, 0), hit, 'forever (0) means every cycle below CYCLE_LIMIT');
    // any base: a full 16-lane forever run always contains the pair; check it on the default base
    const d = remapCollision(DEFAULT_SEED, 16, 0);
    assert.notEqual(d, null);
    assert.equal(seedFor(DEFAULT_SEED, d.laneA, d.cycleA), seedFor(DEFAULT_SEED, d.laneB, d.cycleB));
    assert.notDeepEqual([d.laneA, d.cycleA], [d.laneB, d.cycleB]);
    // the S1 default run (4 lanes, 11 cycles, base 0xC0FFEE) cannot reach it
    assert.equal(remapCollision(DEFAULT_SEED, 4, 11), null);
    // the mirror base: base = PRE makes PRE the REMAPPED input and 0 the natural one, so the A and B roles
    // swap; the pA domain check alone decides lanes = 1 (pA lane 8 is out of a 1-lane roster)
    assert.equal(remapCollision(REMAP_PREIMAGE, 1, 11), null);
    assert.deepEqual(remapCollision(REMAP_PREIMAGE, lB + 1, cB + 1), { cycleA: cB, laneA: lB, cycleB: 0, laneB: 0 });
    // the forever edge: this base puts pB on the LAST cycle index (2^28 - 1); forever must include it, a
    // span of CYCLE_LIMIT - 1 must not
    const edge = 0xf50b0688;
    assert.equal(((edge ^ REMAP_PREIMAGE) >>> 0) >>> 4, CYCLE_LIMIT - 1);
    const fe = remapCollision(edge, lB + 1, 0);
    assert.notEqual(fe, null);
    assert.equal(fe.cycleB, 268435455);
    assert.equal(seedFor(edge, fe.laneA, fe.cycleA), seedFor(edge, fe.laneB, fe.cycleB));
    assert.equal(remapCollision(edge, lB + 1, CYCLE_LIMIT - 1), null);
    // a non-colliding control near the crafted one: flipping base bit 31 moves both packed values out of reach
    assert.equal(remapCollision(0x80000000, lB + 1, cB + 1), null);
    assert.throws(() => remapCollision(0, 0, 11), RangeError);
    assert.throws(() => remapCollision(0, 4, CYCLE_LIMIT + 1), RangeError);
});

test('seeds: on small spans remapCollision agrees with the exhaustive selfCheckSeeds scan, each domain check isolated (200 bases)', () => {
    // selfCheckSeeds enumerates every (lane, cycle) of a span and reports any shared seed; remapCollision
    // decides the same question analytically. On spans the scan can afford (<= 64 cycles) the pair is never
    // reachable (its two cycles XOR to PRE >>> 4 = 0xaf4f97), so a POSITIVE cannot occur here; positives are
    // pinned by the seedFor-verified cases above. What this test does pin is each domain check on its own:
    // bases are drawn so that ONE of the two packed values lands inside the domain, on both sides --
    //   coin = 1: base = p           -> pA = p in range, pB = p ^ PRE out of range (pB check decides)
    //   coin = 0: base = p ^ PRE     -> pB = p in range, pA out of range           (pA check decides)
    // A remapCollision that skipped either check would report a pair the exhaustive scan does not see.
    let x = 0x2545f491;
    const next = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; };
    let y = 0x9e3779b1;
    const coin = () => { y ^= y << 13; y ^= y >>> 17; y ^= y << 5; return (y >>> 0) & 1; };
    const sides = [0, 0];
    const decisive = [0, 0];
    for (let i = 0; i < 200; i++) {
        const lanes = 1 + (next() % 16);
        const span = 1 + (next() % 64);
        const c = coin();
        const p = next() % (span << 4);
        const base = (p ^ (c ? 0 : REMAP_PREIMAGE)) >>> 0;
        sides[c]++;
        if ((p & 15) < lanes) decisive[c]++;   // the in-range packed value is really in the domain
        const analytic = remapCollision(base, lanes, span);
        const scan = selfCheckSeeds(base, lanes, span);
        assert.equal(analytic === null, scan === null, 'base 0x' + base.toString(16) + ' lanes ' + lanes + ' span ' + span);
    }
    assert.ok(sides[0] >= 50 && sides[1] >= 50, 'both sides drawn: ' + sides);
    assert.ok(decisive[0] >= 25 && decisive[1] >= 25, 'each domain check decides at least 25 draws: ' + decisive);
});

/* -- QA boundary matrix (S1a + S1b QA, 2026-10-11) ----------------------------------------------------------
 * Added by qa, oracle-independent of the coder: every case below was shown to FAIL on a hand-made mutant of
 * the code it guards (scratch copy, never the live tree). The mutant is named in each test's comment.
 */

const CFGQ = await import('../bench/soak/config.mjs');
const LQ = await import('../bench/soak/lanes/index.mjs');
const PQ = (env, argv = []) => CFGQ.parseConfig(env, { roster: LQ.ROSTER, scenarios: LQ.ALL_SCENARIOS, covOffSupported: LQ.COV_OFF_SUPPORTED, argv });
const rejectsQ = (env, label) => assert.throws(() => PQ(env), (e) => e instanceof CFGQ.SoakConfigError, label || JSON.stringify(env));

// mutants: DEC_RE widened to /^\s*\+?\d+\s*$/ (padded / signed volume keys accepted); `has` without the
// `env[k] !== undefined` arm (an undefined value parsed as the string 'undefined')
test('qa config: SOAK_CYCLES / SOAK_OPS edges -- 0/10/11, 999/1000/OPS_MAX, padded, signed, exponent, hex and 2^31..2^53 strings', () => {
    rejectsQ({ SOAK_CYCLES: '10' });
    assert.equal(PQ({ SOAK_CYCLES: '11' }).cycles, 11);
    assert.equal(PQ({ SOAK_CYCLES: '0' }).cycles, 0);
    assert.equal(PQ({ SOAK_CYCLES: '011' }).cycles, 11, 'decimal, never octal');
    for (const raw of [' 11', '11 ', '+11', '-0', '-1', '11.0', '1e1', '0x0B', '', 'NaN', 'Infinity', '\u00A011', '\uFF11\uFF11']) rejectsQ({ SOAK_CYCLES: raw }, 'SOAK_CYCLES=' + JSON.stringify(raw));
    assert.equal(PQ({ SOAK_CYCLES: String(CFGQ.CYCLES_MAX) }).cycles, CFGQ.CYCLES_MAX);
    for (const raw of [String(CFGQ.CYCLES_MAX + 1), '2147483648', '4294967296', '9007199254740991', '9007199254740992', '9007199254740993']) rejectsQ({ SOAK_CYCLES: raw }, 'SOAK_CYCLES=' + raw);
    rejectsQ({ SOAK_OPS: '999' });
    assert.equal(PQ({ SOAK_OPS: '1000' }).ops, 1000);
    // SPEC-B addendum 7: soak-internal counters stay <= 0x3FFFFFFF (31-bit Smi on pointer-compressed V8)
    assert.ok(Number.isInteger(CFGQ.OPS_MAX) && CFGQ.OPS_MAX >= 1000 && CFGQ.OPS_MAX <= 0x3FFFFFFF, 'OPS_MAX ' + CFGQ.OPS_MAX + ' must stay Smi-safe');
    assert.equal(PQ({ SOAK_OPS: String(CFGQ.OPS_MAX) }).ops, CFGQ.OPS_MAX);
    assert.equal(PQ({ SOAK_OPS: String(CFGQ.OPS_MAX - 1) }).ops, CFGQ.OPS_MAX - 1);
    for (const raw of [String(CFGQ.OPS_MAX + 1), String(2 ** 30), '2147483647', '2147483648', '4294967295', '4294967296', '9007199254740991', '9007199254740992', '0', '-0', ' 1000', '1000 ', '+1000', '1e3', '1000.0']) rejectsQ({ SOAK_OPS: raw }, 'SOAK_OPS=' + raw);
    // an undefined value is UNSET (default, source default), never the string 'undefined'
    const u = PQ({ SOAK_OPS: undefined, SOAK_CYCLES: undefined });
    assert.equal(u.ops, CFGQ.DEFAULT_OPS);
    assert.equal(u.record.SOAK_OPS.source, 'default');
    // an inherited (prototype) key is not an env key
    assert.equal(PQ(Object.create({ SOAK_OPS: '5' })).ops, CFGQ.DEFAULT_OPS);
});

// mutants: parseSeed without the `v > 0xFFFFFFFF` range arm (4294967296 >>> 0 = seed 0); SEED_RE \d{1,11}
test('qa config: SOAK_SEED edges -- 0, 2^30, 2^31-1, 2^31, 2^32-1 exact; 2^32, 2^53-1, 2^53, -1, -0, padded, 11 digits rejected', () => {
    for (const [raw, v] of [['0', 0], ['0x0', 0], ['00', 0], ['1073741824', 2 ** 30], ['2147483647', 2 ** 31 - 1],
        ['2147483648', 2 ** 31], ['0x80000000', 2 ** 31], ['4294967295', 2 ** 32 - 1], ['0xFFFFFFFF', 2 ** 32 - 1], ['0xffffffff', 2 ** 32 - 1]]) {
        const c = PQ({ SOAK_SEED: raw });
        assert.equal(c.seed, v, 'SOAK_SEED=' + raw);
        assert.equal(c.record.SOAK_SEED.source, 'env');
    }
    for (const raw of ['4294967296', '0x100000000', '9007199254740991', '9007199254740992', '-1', '-0', '0X10', '0x', ' 1', '1 ',
        '+1', '00000000001', '1.0', '1e3', 'NaN']) rejectsQ({ SOAK_SEED: raw }, 'SOAK_SEED=' + raw);
    assert.equal(PQ({}).seed, CFGQ.DEFAULT_SEED);
});

// mutant: the case-insensitive prefix scan dropped (`if (key.indexOf('SOAK_') !== 0 ...) continue`)
test('qa config: case-variant keys -- every lower/mixed-case known key exits 2, also next to its upper-case twin', () => {
    for (const k of CFGQ.KNOWN_KEYS) {
        for (const variant of [k.toLowerCase(), k[0] + k.slice(1).toLowerCase(), 'soak_' + k.slice(5)]) {
            if (variant === k) continue;
            assert.throws(() => PQ({ [variant]: '1' }), new RegExp("env key '" + variant + "' must be upper-case \\(did you mean " + k + '\\?\\)'), variant);
            assert.throws(() => PQ({ [k]: '1', [variant]: '1' }), /must be upper-case/, k + ' + ' + variant);
        }
    }
});

// mutant: worldSeed bound `w < 0xFFFFFFFF` -> `w <= 0xFFFFFFFF`; seedFor without the 0 -> REMAP arm
test('qa seeds: wrap-point bases keep every (lane, cycle) seed distinct and nonzero; world index and cycle edges', () => {
    for (const base of [0, 2 ** 30 - 1, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1]) {
        assert.equal(selfCheckSeeds(base, LANE_LIMIT, 256), null, 'base ' + base);
        for (let li = 0; li < LANE_LIMIT; li++) assert.notEqual(seedFor(base, li, CYCLE_LIMIT - 1), 0);
    }
    // base 0 at (lane 0, cycle 0) is the packed input whose fmix32 is 0: it must be remapped, never 0
    assert.equal(fmix32(0), 0);
    assert.equal(seedFor(0, 0, 0), 0x9e3779b9);
    assert.equal(seedFor(2 ** 32, 1, 1), seedFor(0, 1, 1), 'the base is uint32 (config rejects 2^32 before it gets here)');
    const cs = seedFor(DEFAULT_SEED, 0, 0);
    assert.equal(typeof worldSeed(cs, 0xFFFFFFFE), 'number');
    for (const w of [0xFFFFFFFF, 2 ** 32, 2 ** 53, -1, NaN, 1.5, Infinity]) assert.throws(() => worldSeed(cs, w), RangeError, 'world ' + w);
    for (const c of [CYCLE_LIMIT, 2 ** 31, 2 ** 32, -1, NaN]) assert.throws(() => seedFor(0, 0, c), RangeError, 'cycle ' + c);
    for (const li of [LANE_LIMIT, -1, NaN, 2 ** 31]) assert.throws(() => seedFor(0, li, 0), RangeError, 'lane ' + li);
    // a run of worlds across the uint32 edge of the world counter: the last legal 4 indices stay distinct
    const tail = new Set([0xFFFFFFFB, 0xFFFFFFFC, 0xFFFFFFFD, 0xFFFFFFFE, 0].map((w) => worldSeed(cs, w)));
    assert.equal(tail.size, 5);
});

// mutants: writeRecord appending in two parts (a type prefix, then the rest: a throwing body leaves a torn
// line); `stream.seq++` moved before the append
test('qa jsonl: an unserializable body (BigInt, cycle, throwing toJSON) leaves no torn line and no seq gap', () => {
    const path = join(TMP, 'qa-torn.jsonl');
    const s = openStream(path, performance.now(), 'burn-in');
    writeRecord(s, 'header', { a: 1 });
    const before = readFileSync(path, 'utf8');
    const cyc = {}; cyc.self = cyc;
    for (const body of [{ big: 1n }, cyc, { toJSON() { throw new Error('nope'); } }]) {
        assert.throws(() => writeRecord(s, 'cycle', body));
        assert.equal(s.seq, 1);
        assert.equal(readFileSync(path, 'utf8'), before, 'file unchanged byte for byte');
    }
    writeRecord(s, 'cycle', { ok: true });
    const recs = readFileSync(path, 'utf8').split('\n');
    assert.equal(recs.pop(), '', 'the stream ends on a newline');
    assert.deepEqual(recs.map((l) => JSON.parse(l).seq), [0, 1]);
});

// mutant: as above (two-part append); the kill is an uncatchable SIGKILL, so no handler can tidy up
test('qa jsonl: SIGKILL mid-stream leaves a complete, contiguous prefix and no END sentinel (an incomplete run, never a PASS)', () => {
    const out = join(TMP, 'qa-kill.jsonl');
    const src = `
const J = await import(${JSON.stringify(JSONL_URL)});
const s = J.openStream(${JSON.stringify(out)}, performance.now(), 'burn-in');
J.installFatalHandlers(s, () => ({}), () => { J.writeRecord(s, 'summary', { reason: 'fatal' }); });
J.writeRecord(s, 'header', { pad: 'x'.repeat(4096) });
for (let c = 0; c < 64; c++) J.writeRecord(s, 'cycle', { cycle: c, pad: 'y'.repeat(4096) });
process.kill(process.pid, 'SIGKILL');
`;
    const r = node(['--input-type=module', '-e', src]);
    assert.equal(r.status, null, 'killed by a signal');
    assert.ok(!/soak: END/.test(r.stdout), 'no END sentinel after a SIGKILL');
    const lines = readFileSync(out, 'utf8').split('\n');
    assert.equal(lines.pop(), '', 'the last record is complete');
    const recs = lines.map((l) => JSON.parse(l));
    assert.equal(recs.length, 65);
    recs.forEach((x, k) => assert.equal(x.seq, k));
    assert.ok(!recs.some((x) => x.type === 'summary'), 'no summary: a reader must classify the stream as interrupted');
});

// mutant: isEntry() comparing process.argv[1] with fileURLToPath(import.meta.url) WITHOUT realpathSync
test('qa parity: a symlink to the CLI FILE (not the directory) still runs the check; --preserve-symlinks-main fails closed', () => {
    const L = parityLayout();
    const ext = join(TMP, 'qa-filelink-' + layoutN);
    mkdirSync(ext);
    const link = join(ext, 'soak-parity.mjs');
    symlinkSync(L.cli, link);
    const ok = node([link]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^parity: OK \(/);
    writeFileSync(join(L.dir, 'bench', 'soak', 'gen.mjs'), readFileSync(join(L.dir, 'bench', 'soak', 'gen.mjs'), 'utf8') + '// drift\n');
    const bad = node([link]);
    assert.equal(bad.status, 1, 'via a file symlink: ' + bad.stdout + bad.stderr);
    assert.match(bad.stderr, /parity: FAIL -- bench\/soak\/gen\.mjs sha256/);
    assert.equal(bad.stdout, '', 'no OK line on a mismatch');
    // keeping the link path as the module URL moves ROOT to the link's grandparent: no pins there -> exit 2
    const pres = node(['--preserve-symlinks-main', link]);
    assert.notEqual(pres.status, 0, 'never a silent OK: ' + pres.stdout + pres.stderr);
    assert.ok(!/parity: OK/.test(pres.stdout));
});

// mutants: GIT_STATUS_ARGS with --untracked-files=no; the probe reading `git diff --quiet` (tracked only)
test('qa provenance: untracked files inside a new nested directory, or with a space or newline in the name, read dirty', () => {
    const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    assert.ok(gitDir.length > 0, 'a git repository');
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    const W = join(TMP, 'qa-gitwork');
    mkdirSync(W);
    const arch = spawnSync('git', ['archive', 'HEAD'], { cwd: top, maxBuffer: 1 << 28 });
    assert.equal(arch.status, 0, String(arch.stderr));
    assert.equal(spawnSync('tar', ['-x', '-C', W], { input: arch.stdout }).status, 0);
    const genv = {};
    for (const k of Object.keys(process.env)) if (k.indexOf('GIT_') !== 0 && k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') genv[k] = process.env[k];
    Object.assign(genv, { GIT_DIR: gitDir, GIT_WORK_TREE: W, GIT_INDEX_FILE: join(TMP, 'qa-gitwork.index'),
        GIT_CONFIG_GLOBAL: join(TMP, 'qa-no-global'), GIT_CONFIG_NOSYSTEM: '1' });
    assert.equal(spawnSync('git', ['read-tree', 'HEAD'], { cwd: W, env: genv }).status, 0);
    const PROV_URL = pathToFileURL(join(SOAK, 'provenance.mjs')).href;
    const probe = () => {
        const r = spawnSync(process.execPath, ['--input-type=module', '-e',
            'const { gitInfo } = await import(' + JSON.stringify(PROV_URL) + '); process.stdout.write(JSON.stringify(gitInfo()));'],
        { cwd: ROOT, env: genv, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
    };
    assert.equal(probe().dirty, false, 'control: the archived HEAD tree is clean');
    mkdirSync(join(W, 'bench', 'soak', 'qa-empty-dir'), { recursive: true });
    assert.equal(probe().dirty, false, 'an empty untracked directory is not content (git tracks files)');
    const cases = [join('bench', 'soak', 'qa-new', 'deeper', 'x.mjs'), join('bench', 'soak', 'qa name.mjs'), join('bench', 'soak', 'qa\nnl.mjs')];
    for (const rel of cases) {
        mkdirSync(dirname(join(W, rel)), { recursive: true });
        writeFileSync(join(W, rel), 'export const q = 1;\n');
        assert.equal(probe().dirty, true, JSON.stringify(rel) + ' must make the tree dirty');
        unlinkSync(join(W, rel));
        rmSync(join(W, 'bench', 'soak', 'qa-new'), { recursive: true, force: true });
        assert.equal(probe().dirty, false, 'control after removing ' + JSON.stringify(rel));
    }
});

/* -- main.mjs: the burn-in entry (S1c B3, SPEC-B-S1cd task 6 + amendment 13) ---------------------------------
 * Every soak run here uses a FROZEN kernel through SOAK_KERNEL (amendment 11), never the live Signal.js:
 * bench/soak/controls/headpatched (L-P-INTERIM / L-REV-AUDIT control) and node_modules/lite-signal-1.5.2
 * (L-REV-152, the published 1.5.2 alias). The full-size runs (11 x DEFAULT_OPS) belong to the B7 battery.
 */

const MAIN = join(SOAK, 'main.mjs');
const MQ = await import('../bench/soak/main.mjs');
const EXQ = await import('../bench/soak/exec.mjs');
const PRQ = await import('../bench/soak/provenance.mjs');
const DVQ = await import('../bench/soak/divergences.mjs');
const K_HP = join(SOAK, 'controls', 'headpatched', 'Signal.js');
const K_152 = join(ROOT, 'node_modules', 'lite-signal-1.5.2', 'Signal.js');
let soakN = 0;

/** Spawn main.mjs with exactly these SOAK_* keys (every inherited SOAK_* key is dropped) and a fresh SOAK_OUT. */
function soakEnv(keys) {
    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    const out = join(TMP, 'main-' + (soakN++) + '.jsonl');
    return { env: Object.assign(env, { SOAK_OUT: out }, keys), out };
}
function soak(keys, argv = []) {
    const { env, out } = soakEnv(keys);
    const r = spawnSync(process.execPath, ['--expose-gc', MAIN].concat(argv), { encoding: 'utf8', timeout: 300000, env });
    const recs = existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter((l) => l.length).map((l) => JSON.parse(l)) : [];
    const breach = r.stderr.split('\n').filter((l) => l.indexOf('soak: BREACH oracle=') === 0);
    return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, recs, breach, out };
}
const lastLine = (s) => s.trim().split('\n').pop();
const memo = (fn) => { let v; return () => (v === undefined ? (v = fn()) : v); };
const smokeGraph = memo(() => soak({ SOAK_LANES: 'GRAPH', SOAK_KERNEL: K_HP }, ['--smoke']));

test('main: headpatched GRAPH soak:smoke -> exit 0, last line END verdict=SMOKE exit=0 records=5, seq 0..4', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['soak:smoke'], 'node --expose-gc bench/soak/main.mjs --smoke', 'this test spawns exactly the npm script');
    const r = smokeGraph();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastLine(r.stdout), 'soak: END verdict=SMOKE exit=0 records=5');
    assert.deepEqual(r.recs.map((x) => x.seq), [0, 1, 2, 3, 4]);
    assert.deepEqual(r.recs.map((x) => x.type), ['header', 'cycle', 'cycle', 'cycle', 'summary']);
    assert.equal(r.breach.length, 0, r.stderr);
    const s = r.recs[4];
    assert.equal(s.reason, 'end');
    assert.equal(s.verdict, 'SMOKE');
    assert.equal(s.exitCode, 0);
    assert.equal(s.perLane.GRAPH.status, 'PASS');
    assert.equal(r.recs[0].controls.name, 'headpatched', 'the frozen control kernel, never the live tree');
});

test('main: retention -- trackerSize === 0 and weakAlive === 0 on all 3 boundaries (warm-up included)', () => {
    const cyc = smokeGraph().recs.filter((x) => x.type === 'cycle');
    assert.equal(cyc.length, 3);
    for (const c of cyc) {
        assert.equal(c.boundary.trackerSize, 0, 'cycle ' + c.cycle + ' ' + JSON.stringify(c.boundary));
        assert.equal(c.boundary.weakAlive, 0, 'cycle ' + c.cycle + ' ' + JSON.stringify(c.boundary));
        assert.ok(c.boundary.forcedGcTries >= 1);
        assert.ok(c.worlds > 0, 'the boundary witnessed real worlds');
        // every world of THIS cycle was tracked and witnessed (an untracked world would read 0/0 for free)
        assert.equal(c.boundary.tracked, c.worlds, 'tracked === worlds, cycle ' + c.cycle);
        assert.equal(c.boundary.witnessed, c.worlds, 'witnessed === worlds, cycle ' + c.cycle);
        assert.equal(c.boundary.worlds, c.worlds);
        assert.equal(c.boundary.cycle, c.cycle, 'a fresh boundary bound to its own cycle, never a reused one');
        assert.equal(c.boundary.lane, c.lane);
    }
    assert.deepEqual(smokeGraph().recs[4].perLane.GRAPH.retention, { badBoundaries: 0, unmeasured: 0 });
});

test('main: record obligations -- header extras + divergences digest; cycle checks, skipTainted, memory.residentMB, boundary in order', () => {
    const r = smokeGraph();
    const h = r.recs[0];
    for (const k of PRQ.REQUIRED_EXTRAS) assert.ok(Object.prototype.hasOwnProperty.call(h, k) && h[k] !== null, 'header.' + k);
    assert.equal(h.kind, 'burn-in');
    assert.equal(h.divergences, DVQ.digest(), 'header digest = sha256 of divergences.json');
    assert.deepEqual(h.lanes, [{ name: 'GRAPH', status: 'run', missingCaps: [], engine: 'lite' }]);
    for (const c of r.recs.filter((x) => x.type === 'cycle')) {
        const keys = Object.keys(c);
        const at = ['lane', 'cycle', 'checks', 'skipTainted', 'failures', 'memory', 'boundary'].map((k) => keys.indexOf(k));
        assert.ok(at.every((i) => i !== -1), 'every field present: ' + keys);
        for (let i = 1; i < at.length; i++) assert.ok(at[i - 1] < at[i], 'field order: ' + keys);
        assert.deepEqual(Object.keys(c.checks), EXQ.CHECK_NAMES.slice());
        assert.deepEqual(Object.keys(c.skipTainted), EXQ.SKIP_NAMES.slice());
        for (const k of EXQ.CHECK_NAMES) assert.ok(Number.isSafeInteger(c.checks[k]) && c.checks[k] >= 0);
        assert.ok(Number.isFinite(c.memory.residentMB) && c.memory.residentMB > 0);
        assert.equal(c.boundary.heapSampledAfterGc, true);
        assert.equal(c.warmup, c.cycle === 0);
        assert.equal(c.interrupted, false);
    }
});

test('main: SIGINT after the first heartbeat -> exit 3, summary reason signal, END verdict=INCONCLUSIVE', async () => {
    const { spawn } = await import('node:child_process');
    const { env, out } = soakEnv({ SOAK_LANES: 'GRAPH', SOAK_KERNEL: K_HP, SOAK_CYCLES: '11', SOAK_OPS: '20000' });
    const child = spawn(process.execPath, ['--expose-gc', MAIN], { env });
    let stdout = '', stderr = '', sent = false;
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
        stdout += d;
        if (!sent && /soak: HEARTBEAT /.test(stdout)) { sent = true; child.kill('SIGINT'); }
    });
    const [code, sig] = await new Promise((res) => child.on('close', (c, s) => res([c, s])));
    assert.ok(sent, 'a heartbeat was seen: ' + stdout);
    assert.equal(sig, null, 'main handles SIGINT itself (never killed by it)');
    assert.equal(code, 3, stderr);
    const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const s = recs[recs.length - 1];
    assert.equal(s.type, 'summary');
    assert.equal(s.reason, 'signal');
    assert.equal(s.verdict, 'INCONCLUSIVE');
    assert.ok(s.cyclesRun < 11, 'interrupted early: ' + s.cyclesRun);
    for (const c of recs.filter((x) => x.type === 'cycle')) assert.equal(c.interrupted, c.ops < 20000, 'interrupted = the lane-cycle stopped short of SOAK_OPS');
    assert.match(stderr, /soak: INCONCLUSIVE -- run interrupted before its end/);
    assert.equal(lastLine(stdout), 'soak: END verdict=INCONCLUSIVE exit=3 records=' + recs.length);
});

test('main: BreachLog -- an unclassified failure with the same sig as a known one still gets its own BREACH line', () => {
    const lines = [];
    const log = new MQ.BreachLog((l) => lines.push(l));
    const rec = (known, oracle = 'O1c', sig = 'computed-mismatch') => ({ known, failKnown: [known], replay: 'BATCH:0:0x1', scen: ['mid-read'], fails: [{ oracle, sig, detail: 'd' }] });
    assert.equal(log.noteWorld(rec('DIV-F5'), 'BATCH', 'lite'), 1);
    assert.equal(log.noteWorld(rec(null), 'BATCH', 'lite'), 1, 'same (family, lane, sig), known null: a NEW line');
    assert.equal(log.noteWorld(rec(null, 'O1e'), 'BATCH', 'lite'), 0, 'O1e is family O1: deduplicated');
    assert.equal(log.noteWorld(rec('DIV-F5'), 'BATCH', 'lite'), 0);
    assert.equal(log.noteWorld(rec(null), 'ERROR', 'lite'), 1, 'another lane: a new line');
    const b = lines.filter((l) => l.indexOf('soak: BREACH') === 0);
    assert.deepEqual(b.map((l) => / known=(\S+)/.exec(l)[1]), ['DIV-F5', 'none', 'none']);
    assert.match(b[1], /^soak: BREACH oracle=O1 lane=BATCH sig=computed-mismatch known=none scen=mid-read engine=lite replay=BATCH:0:0x1 detail=d$/);
    assert.equal(lines.filter((l) => l.indexOf('soak: REPLAY') === 0).length, 2, 'one REPLAY per distinct (lane, family, sig)');
    assert.equal(log.size, 3);
    // each fail's BREACH carries ITS OWN tag (classify perFail), not the world's joined one
    const per = [];
    const log2 = new MQ.BreachLog((l) => per.push(l));
    log2.noteWorld({ known: 'DIV-F6+DIV-F22', failKnown: ['DIV-F6', 'DIV-F22'], replay: 'ERROR:0:0x2', scen: [],
        fails: [{ oracle: 'O6', sig: 'escape-computed', detail: 'a' }, { oracle: 'O6', sig: 'expected-escape-missing', detail: 'b' }] }, 'ERROR', 'lite');
    assert.deepEqual(per.filter((l) => l.indexOf('soak: BREACH') === 0).map((l) => / sig=(\S+) known=(\S+)/.exec(l).slice(1).join(' ')),
        ['escape-computed DIV-F6', 'expected-escape-missing DIV-F22']);
    assert.throws(() => log2.noteWorld({ known: 'DIV-F5', replay: 'x', scen: [], fails: [{ oracle: 'O1c', sig: 's', detail: '' }] }, 'BATCH', 'lite'), TypeError, 'a known world without failKnown fails closed');
});

test('main: tapAdapter -- escape is what the OUTERMOST batch threw, never a nested batch\'s; [] when it returned', () => {
    const fake = Object.freeze({
        name: 'fake',
        open() {
            let d = 0;
            return {
                registry: { id: 'reg' },
                batch(fn) { d++; const my = d; try { return fn(); } catch (e) { throw { tag: 'replaced@' + my }; } finally { d--; } },
                normalizeEscape(e) { return [{ origin: 'batch', token: String(e.tag) }]; },
                peek() { return 7; },
            };
        },
    });
    const opened = [];
    const tap = { onOpen(w) { opened.push(w); } };
    const W = MQ.tapAdapter(fake, tap).open({});
    assert.equal(opened.length, 1);
    assert.equal(W.registry, opened[0].registry, 'the raw world (and its registry) is what the tap sees');
    assert.equal(W.peek(), 7, 'other methods delegate');
    assert.equal(Object.getPrototypeOf(W), Object.prototype, 'a plain delegate: a world is never used as a prototype');
    assert.throws(() => W.batch(() => W.batch(() => { throw { tag: 'inner' }; })));
    assert.deepEqual(tap.escape, [{ origin: 'batch', token: 'replaced@1' }], 'the outer call, not replaced@2');
    W.batch(() => { try { W.batch(() => { throw { tag: 'swallowed' }; }); } catch { /* the outer body swallows it */ } });
    assert.deepEqual(tap.escape, [], 'a nested throw the outer call swallowed is not the escape');
    assert.throws(() => W.batch(() => { throw { tag: 'x' }; }));
    W.batch(() => 1);
    assert.deepEqual(tap.escape, [], 'every outermost call starts a fresh escape');
});

test('main: failureRecord -- oracle ids in fails, families in failureCounts; escape only for a batch op', () => {
    const r = { failure: { step: 3, op: 'set', fails: [{ oracle: 'O1c', sig: 'computed-mismatch', detail: 'x' }, { oracle: 'O1e', sig: 'computed-mismatch', detail: 'y' }], scen: ['a'] }, scen: { a: 1, b: 0, c: 2 } };
    const f = MQ.failureRecord(r, { engine: 'lite', lane: 'GRAPH', cycle: 2, world: 5, worldSeed: 0xabc, escape: [{ origin: 'batch', token: 'batch:3' }] });
    assert.deepEqual(f.oracles, ['O1c', 'O1e']);
    assert.deepEqual(f.sigs, ['computed-mismatch']);
    assert.equal(f.sig, 'computed-mismatch');
    assert.equal(f.escape, null, 'op set: no outermost batch call in this step');
    assert.deepEqual(f.worldScen, ['a', 'c']);
    assert.deepEqual(f.worldScenCounts, { a: 1, b: 0, c: 2 });
    assert.equal(f.replay, 'GRAPH:2:0xabc');
    assert.equal(f.known, null);
    assert.deepEqual(f.failKnown, [null, null]);
    for (const k of ['step', 'op', 'fails', 'scen', 'worldScen', 'worldScenCounts', 'escape', 'known']) assert.ok(Object.prototype.hasOwnProperty.call(f, k), k);
    assert.deepEqual(MQ.familyKeys(f.fails), ['O1:computed-mismatch']);
    r.failure.op = 'batch';
    assert.deepEqual(MQ.failureRecord(r, { engine: 'lite', lane: 'GRAPH', cycle: 0, world: 0, worldSeed: 1, escape: [{ origin: 'batch', token: 'batch:3' }] }).escape, [{ origin: 'batch', token: 'batch:3' }]);
});

test('main: a config error exits 2 with verdict null -- one CONFIG line, no record, no END line', () => {
    const r = soak({ SOAK_LANES: 'grpah', SOAK_KERNEL: K_HP });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, "soak: CONFIG -- SOAK_LANES: unknown lane 'grpah' (did you mean GRAPH?)\n");
    assert.equal(r.stdout, '');
    assert.equal(existsSync(r.out), false, 'no stream file');
    const g = spawnSync(process.execPath, [MAIN], { encoding: 'utf8', env: soakEnv({ SOAK_LANES: 'GRAPH', SOAK_KERNEL: K_HP }).env });
    assert.equal(g.status, 2, 'missing --expose-gc');
    assert.match(g.stderr, /^soak: CONFIG -- --expose-gc is required/);
});

test('main: SOAK_REPLAY / SOAK_SHRINK dispatch -- a missing replay.mjs / shrink.mjs exits 2, never runs a burn-in', () => {
    const dir = join(TMP, 'main-dispatch');
    mkdirSync(join(dir, 'bench'), { recursive: true });
    cpSync(SOAK, join(dir, 'bench', 'soak'), { recursive: true, filter: (p) => !/[\\/](out|replay\.mjs|shrink\.mjs)$/.test(p) });
    cpSync(join(ROOT, 'bench', 'torture', 'helpers'), join(dir, 'bench', 'torture', 'helpers'), { recursive: true });
    const cli = join(dir, 'bench', 'soak', 'main.mjs');
    for (const [keys, file] of [[{ SOAK_REPLAY: 'GRAPH:0:0x1' }, 'replay.mjs'], [{ SOAK_REPLAY: 'GRAPH:0:0x1', SOAK_SHRINK: '1' }, 'shrink.mjs']]) {
        const { env, out } = soakEnv(Object.assign({ SOAK_KERNEL: K_HP }, keys));
        const r = spawnSync(process.execPath, ['--expose-gc', cli], { encoding: 'utf8', timeout: 60000, env });
        assert.equal(r.status, 2, file + ': ' + r.stderr);
        assert.match(r.stderr, new RegExp('^soak: CONFIG -- SOAK_(REPLAY|SHRINK): bench/soak/' + file.replace('.', '\\.') + ' is not built yet'));
        assert.equal(r.stdout, '', 'no heartbeat: no burn-in ran');
        assert.equal(existsSync(out), false);
    }
});

test('main: headpatched ERROR (smoke) -> exit 1, every BREACH carries known in {DIV-F21, DIV-F22} (L-P-INTERIM-ERROR, reduced)', () => {
    const r = soak({ SOAK_LANES: 'ERROR', SOAK_KERNEL: K_HP }, ['--smoke']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(lastLine(r.stdout), 'soak: END verdict=FAIL exit=1 records=5');
    assert.ok(r.breach.length >= 1, 'the interim kernel still trips F21/F22 on ERROR');
    for (const l of r.breach) assert.match(l, /^soak: BREACH oracle=O\d lane=ERROR sig=\S+ known=DIV-F2[12] /, l);
    const fails = r.recs.filter((x) => x.type === 'cycle').flatMap((c) => c.failures);
    assert.ok(fails.length >= 1);
    for (const f of fails) assert.ok(f.known === 'DIV-F21' || f.known === 'DIV-F22', JSON.stringify(f).slice(0, 400));
    assert.ok(fails.some((f) => f.op === 'batch' && Array.isArray(f.escape) && f.escape.length > 0), 'F22 worlds carry the outermost-batch escape');
});

test('main: 1.5.2 (smoke, 4 lanes) -> exit 1 with the four L-REV-152 BREACH heads; failure records keep ids and families apart', () => {
    const r = soak({ SOAK_KERNEL: K_152 }, ['--smoke']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.recs[0].controls.name, 'rev152');
    assert.equal(lastLine(r.stdout), 'soak: END verdict=FAIL exit=1 records=' + r.recs.length);
    const err = r.breach.join('\n');
    assert.match(err, /^soak: BREACH oracle=O1 lane=BATCH sig=\S+ known=\S+ scen=\S*revert-after-mid-read/m, 'F5');
    assert.match(err, /^soak: BREACH oracle=O6 lane=ERROR sig=escape-computed /m, 'F6');
    assert.match(err, /^soak: BREACH oracle=O7 lane=NEST sig=dead-registration-fire /m, 'F7');
    assert.match(err, /^soak: BREACH oracle=O6 lane=NEST sig=\S+ known=\S+ scen=\S*saved-cursor-hazard/m, 'F15');
    const keys = [];
    for (const c of r.recs.filter((x) => x.type === 'cycle')) {
        for (const k of Object.keys(c.failureCounts)) { assert.match(k, /^O[1-7]:[a-z][\w-]*$/, 'family keys only: ' + k); keys.push(k); }
        for (const f of c.failures) {
            for (const k of ['step', 'op', 'fails', 'scen', 'worldScen', 'worldScenCounts', 'escape', 'oracles', 'sigs', 'sig', 'known']) assert.ok(Object.prototype.hasOwnProperty.call(f, k), k);
            for (const x of f.fails) assert.ok(EXQ.CHECK_NAMES.indexOf(x.oracle) !== -1, 'oracle ids in fails: ' + x.oracle);
            assert.equal(f.escape === null, f.op !== 'batch', 'escape only for a batch op');
        }
    }
    assert.ok(keys.length >= 4);
});

/** A scratch copy of bench/soak (+ torture helpers, node_modules link). patch: [from, to] applied once to main.mjs; files: {name: text}. */
function scratchSoak(name, patch, files) {
    const dir = join(TMP, 'main-scratch-' + name);
    mkdirSync(join(dir, 'bench'), { recursive: true });
    cpSync(SOAK, join(dir, 'bench', 'soak'), { recursive: true, filter: (p) => !/[\\/](out|replay\.mjs|shrink\.mjs)$/.test(p) });
    cpSync(join(ROOT, 'bench', 'torture', 'helpers'), join(dir, 'bench', 'torture', 'helpers'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    const cli = join(dir, 'bench', 'soak', 'main.mjs');
    if (patch) {
        const src = readFileSync(cli, 'utf8');
        assert.equal(src.split(patch[0]).length, 2, 'the patch anchor occurs exactly once: ' + patch[0]);
        writeFileSync(cli, src.replace(patch[0], patch[1]));
    }
    for (const f of Object.keys(files || {})) writeFileSync(join(dir, 'bench', 'soak', f), files[f]);
    return cli;
}

test('main: a replay / shrink module that returns no exit code 0..3 -> CRASH line, exit 1 (never a silent 0)', () => {
    for (const [ret, label] of [['undefined', 'undefined'], ['7', '7'], ['1.5', '1.5'], ["'0'", '0']]) {
        const cli = scratchSoak('ret-' + label.replace(/\W/g, '_'), null, { 'replay.mjs': 'export async function runReplay(cfg) { return ' + ret + '; }\n' });
        const { env } = soakEnv({ SOAK_KERNEL: K_HP, SOAK_REPLAY: 'GRAPH:0:0x1' });
        const r = spawnSync(process.execPath, ['--expose-gc', cli], { encoding: 'utf8', timeout: 60000, env });
        assert.equal(r.status, 1, 'runReplay returned ' + ret + ': ' + r.stderr);
        assert.equal(r.stderr, 'soak: CRASH -- runReplay returned ' + label + ' (expected an exit code 0..3)\n');
    }
    const ok = scratchSoak('ret-3', null, { 'replay.mjs': 'export async function runReplay(cfg) { return 3; }\n' });
    const r3 = spawnSync(process.execPath, ['--expose-gc', ok], { encoding: 'utf8', timeout: 60000, env: soakEnv({ SOAK_KERNEL: K_HP, SOAK_REPLAY: 'GRAPH:0:0x1' }).env });
    assert.equal(r3.status, 3, 'control: a valid code passes through');
});

test('main: a throw while summarizing goes down the fatal path -- fatal record, summary, CRASH, END verdict=FAIL exit=1', () => {
    const cli = scratchSoak('sum-throw', ["const summarize = (reason) => {", "const summarize = (reason) => { if (reason === 'end') throw new Error('injected summarize failure');"]);
    const { env, out } = soakEnv({ SOAK_KERNEL: K_HP, SOAK_LANES: 'GRAPH' });
    const r = spawnSync(process.execPath, ['--expose-gc', cli, '--smoke'], { encoding: 'utf8', timeout: 300000, env });
    assert.equal(r.status, 1, r.stderr);
    const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(recs.map((x) => x.type), ['header', 'cycle', 'cycle', 'cycle', 'fatal', 'summary']);
    assert.equal(recs[4].kind, 'mainRejection');
    assert.match(recs[4].message, /injected summarize failure/);
    assert.equal(recs[5].reason, 'fatal');
    assert.match(r.stderr, /soak: CRASH -- mainRejection: Error: injected summarize failure/);
    assert.ok(!/before the stream opened/.test(r.stderr));
    assert.equal(lastLine(r.stdout), 'soak: END verdict=FAIL exit=1 records=6');
});

test('main: retention must-fail -- a registry leaked behind main\'s back FAILs end to end (BREACH gate=retention)', () => {
    // the leak holds w.registry itself, independently of what main tracks: only a gate that measures the
    // REAL registry sees it (a tracked throwaway wrapper or a dropped witness would read 0/0 and pass)
    const cli = scratchSoak('leak', ['onOpen(w) {', 'onOpen(w) { (globalThis.__leak ||= []).push(w.registry);']);
    const { env, out } = soakEnv({ SOAK_KERNEL: K_HP, SOAK_LANES: 'GRAPH' });
    const r = spawnSync(process.execPath, ['--expose-gc', cli, '--smoke'], { encoding: 'utf8', timeout: 300000, env });
    assert.equal(r.status, 1, r.stderr);
    assert.match(lastLine(r.stdout), /^soak: END verdict=FAIL exit=1 records=5$/);
    assert.match(r.stderr, /^soak: BREACH gate=retention lane=GRAPH /m);
    const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const cyc = recs.filter((x) => x.type === 'cycle');
    assert.equal(cyc.length, 3);
    let cum = 0;
    for (const c of cyc) {
        cum += c.worlds;
        assert.equal(c.boundary.cycle, c.cycle);
        assert.equal(c.boundary.weakAlive, c.worlds, 'this cycle\'s witness: every world still alive, cycle ' + c.cycle);
        assert.equal(c.boundary.trackerSize, cum, 'the tracker is run-wide: cumulative worlds, cycle ' + c.cycle);
    }
    assert.equal(recs[4].perLane.GRAPH.retention.badBoundaries, 2);
    assert.equal(recs[4].verdict, 'FAIL');
});

test('main: failureRecord -- failKnown is per fail, in fail order (two fails explained by two registry entries)', () => {
    // 1.5.2 ERROR world (smoke run, step 31): the F6 pre-walk token replaced the batch token (F6+F22)
    const r = {
        failure: { step: 31, op: 'batch', scen: ['dep-set-flip', 'throw-dep-computed-prewalk', 'throw-in-batch'], fails: [
            { oracle: 'O6', sig: 'escape-computed', detail: 'unpredicted escape computed:18' },
            { oracle: 'O6', sig: 'expected-escape-missing', detail: 'predicted escape batch:31 x1 did not happen' },
            { oracle: 'O4', sig: 'effect-dead', detail: 'effect#22 saw [#0=95,#21=95] model [#0=95,#21=ERR(computed:18)] (ran 0 times this op)' },
        ] },
        scen: { 'dep-set-flip': 2, 'recovery-after-throw': 2, 'throw-dep-computed-prewalk': 1, 'throw-in-batch': 1 },
    };
    const f = MQ.failureRecord(r, { engine: 'lite', lane: 'ERROR', cycle: 0, world: 0, worldSeed: 1, escape: [{ origin: 'computed', token: 'computed:18' }] });
    assert.equal(f.known, 'DIV-F6+DIV-F22');
    assert.deepEqual(f.failKnown, ['DIV-F6', 'DIV-F22', 'DIV-F6']);
});
