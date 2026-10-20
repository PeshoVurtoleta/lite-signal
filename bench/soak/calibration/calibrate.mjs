/**
 * @zakkster/lite-signal soak -- CALIBRATION (SPEC-B-S1cd TASK 11, SPEC-B v2 :612 item 9; burst 8 B6).
 * Tooling, not a test, not shipped. COLD module: no hot body.
 *
 * It replays main.mjs's lane-cycle loop WITHOUT the boundary (no drain, no tracker, no JSONL): for each
 * lane x cycle, worlds seedFor(seed, laneIndex, cycle) -> worldSeed(cycleSeed, w) -> generateWorld ->
 * runWorld until the lane-cycle ran >= ops ops (main.mjs:382, the same `while (ops < budget)` stop). Scenario
 * hits, PERFORMED checks and taint skips are DETERMINISTIC for (kernel, seed, lane, cycle, ops); the smoke
 * shape (SMOKE_CYCLES x SMOKE_OPS) is the PREFIX of cycles 0 .. SMOKE_CYCLES - 1 up to the first world that
 * reaches SMOKE_OPS, so one full pass records both. Wall time is REPORTED tier only and recorded only with
 * --timed (run that under quiet-lock); without it opsPerSec is the string PENDING.
 *
 *   node bench/soak/calibration/calibrate.mjs --write <out.json> [--timed] [--import-throughput <earlier.json>]
 *        the evidence file (soak-calibration.json):
 *          kernels      the cut, one child per kernel over the lanes it is BOUND to (LANE_KERNELS): the binding
 *                       kernels headpatched + 1.5.2 on every unlisted lane, a lane-only kernel on its lanes only;
 *                       DEFAULT_SEED, DEFAULT_CYCLES x DEFAULT_OPS, with the smoke prefix; sequential children (the
 *                       only timed part, REPORTED tier)
 *          mainCrossCheck  main.mjs --smoke AND the default main.mjs run, on EVERY kernel (SOAK_LANES = its bound
 *                       lanes), fold (foldMainRecords) to exactly kernels.<k>.smoke / .full; --write dies on any difference.
 *                       test/41 repeats the smoke half live.
 *          probe        PROBE (headpatched GRAPH, 11 x PROBE_OPS): the calibration child and main.mjs both run it;
 *                       --write dies unless the folds and largeWorldsPerCycle are equal and every cycle ran a
 *                       LARGE world. test/41 re-runs main.mjs on it live (main's large-world choice is gated live).
 *          hollowVolume DEFAULT_CYCLES x OPS_MIN, every kernel over its bound lanes (the smallest gated volume config
 *                       accepts); each row records failingWorlds (test/41 (e) counts full-length rows only)
 *          covOff       every supported cov-off at the smoke shape on the lane's first kernel (kernelsFor(lane)[0]:
 *                       headpatched for every unlisted lane and for NEST) (hollow-evidence controls)
 *          seedSweep    SWEEP_SEEDS at the smoke shape, every kernel over its bound lanes (REPORTED seed spread;
 *                       binds nothing)
 *          covOffSweep  every cov-off at the smoke shape over COVOFF_SEEDS, every kernel bound to the lane (taint
 *                       separation)
 *   node bench/soak/calibration/calibrate.mjs --child <kernel> --cycles C --ops O [--lanes L,..] [--cov-off s] [--timed]
 *        one kernel per process (kernel.mjs reads SOAK_KERNEL once, at import); one JSON line on stdout
 * The drift guard (test/41) re-measures the SMOKE cells and the PROBE through the real main.mjs; the full-shape
 * cells are not re-measured live (accepted LP design). PINNED shas are checked by the guard: a pinned file that
 * moves (gen, exec, oracles, lanes, kinds, the value pool ...) turns it red with a "recut" message. main.mjs and
 * this tool are NOT pinned (burst 13, SPEC-B-S1cd addendum 16): the live smoke + probe folds gate main's loop,
 * and pinning them made every edit of either a ~13-min recut. Residual: a main.mjs drift outside the smoke and
 * probe shapes is caught only at the next recut (its full-run cross-check).
 * Per-lane kernel map (b67 B2a, D7): a lane listed in LANE_KERNELS is cut ONLY on its kernels (WIE -> tree, the
 * working-tree engine: 1.5.2 predates the b33 fix and BREACHes WIE by design, DIV-B33); an unlisted lane runs on
 * every KERNELS id. A lane-only kernel is never a binding kernel (cut.bindingKernels stays KERNELS); --write dies
 * unless laneOnlyProblems is empty (test/41's D7 rule: the evidence is the kernel's own path with exactly its
 * Signal.js + Watch.js, each sha256 a string equal to an own parity.json entry; null is not a sha), and test/41
 * re-checks that pin. A lane's own descriptor file joins the pinned list only while the lane is rostered
 * (LANE_PINS, pinnedFor).
 * NEST -> headpatched, lite-1.5.2, tree (b74 D4): both binding kernels fail-stop EVERY NEST world (headpatched
 * 33885/33885 at 32.5 ops/world, 1.5.2 36726/36726 at 30.0, b71 cut), so tree (clean, 425.0 ops/world, b74 TASK 0b)
 * carries NEST's full-length evidence (test/41 (f)). headpatched stays first: covOff and the headpatched NEST
 * cov-off sweep are unchanged. ERROR stays on the binding kernels: it fail-stops on every kernel (tree 17039/17050,
 * b74 0b; DIV-F5 / F6 / F22), exempt from (f) only while one of those three is open (maintainer ruling b74).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, loadavg, hostname } from 'node:os';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export const KERNELS = Object.freeze({
    headpatched: 'bench/soak/controls/headpatched/Signal.js',
    'lite-1.5.2': 'node_modules/lite-signal-1.5.2/Signal.js',
});
// Lane-only kernels (b67 B2a, D7): cut only on the lanes LANE_KERNELS binds them to, never a binding kernel (not in
// KERNELS, so cut.bindingKernels is unchanged). tree = the working-tree engine; --write dies unless
// laneOnlyProblems (below: test/41's D7 rule) is empty.
export const LANE_ONLY_KERNELS = Object.freeze({ tree: 'Signal.js' });
// lane -> the kernels that cut it; an unlisted lane runs on every KERNELS id (never on a lane-only kernel).
// NEST (b74 D4): the binding kernels fail-stop every NEST world; tree carries its full-length cells (header).
export const LANE_KERNELS = Object.freeze({
    WIE: Object.freeze(['tree']),
    NEST: Object.freeze(['headpatched', 'lite-1.5.2', 'tree']),
});
/** The kernel ids that cut `lane` (a fresh array). */
export const kernelsFor = (lane) => (own(LANE_KERNELS, lane) ? LANE_KERNELS[lane].slice() : Object.keys(KERNELS));
/** The ROOT-relative path of kernel id `k`; an unknown id throws (fail closed). */
export function kernelPath(k) {
    if (own(KERNELS, k)) return KERNELS[k];
    if (own(LANE_ONLY_KERNELS, k)) return LANE_ONLY_KERNELS[k];
    throw new Error('calibrate: unknown kernel ' + k);
}
/** The lanes of `roster` (roster order) that kernel `k` cuts. */
export const lanesFor = (k, roster) => roster.filter((l) => kernelsFor(l).indexOf(k) !== -1);
/** The kernels some lane of `roster` binds: KERNELS ids first, then lane-only ids (stable order). */
export const kernelsOf = (roster) => Object.keys(KERNELS).concat(Object.keys(LANE_ONLY_KERNELS))
    .filter((k) => lanesFor(k, roster).length > 0);
/**
 * D7 (b80 F1): the problems that keep lane-only kernel `k`'s child result `res` out of the cut, against
 * parity.json's `files` map `parity` -- test/41's D7 rule, mirrored: the evidence is kernelPath(k) with exactly
 * [kp, kp Signal.js -> Watch.js] as its files, and every file's sha256 is a string equal to an OWN parity entry
 * (null is not a sha). Pure, never throws on JSON-shaped input; [] = clean. Tags: `D7 kernel:` (k is not a
 * lane-only kernel; the only line), `D7 files:`, `D7 evidence:`, `D7 sha:` (one per entry).
 */
export function laneOnlyProblems(k, res, parity) {
    const p = [];
    const txt = (v) => (typeof v === 'string' ? v : v === null || (typeof v !== 'object' && typeof v !== 'function')
        ? String(v) : typeof v);
    if (typeof k !== 'string' || !own(LANE_ONLY_KERNELS, k)) {
        p.push('D7 kernel: ' + txt(k) + ' is not a lane-only kernel (LANE_ONLY_KERNELS)');
        return p;
    }
    const kp = LANE_ONLY_KERNELS[k], wantFiles = [kp, kp.replace(/Signal\.js$/, 'Watch.js')];
    const ro = res !== null && typeof res === 'object';
    const files = ro && Array.isArray(res.files) ? res.files : null;
    if (files === null || files.length === 0) {
        p.push('D7 files: kernel ' + k + ' lists no files; nothing to check against parity.json');
    }
    const got = files === null ? null : files.map((f) => (f !== null && typeof f === 'object' ? f.path : null));
    let gotJson = null;
    try { gotJson = JSON.stringify(got); } catch { gotJson = null; }   // unserializable = a difference (fail closed)
    const kern = ro ? res.kernel : undefined;
    if (kern !== kp || gotJson === null || gotJson !== JSON.stringify(wantFiles)) {
        p.push('D7 evidence: kernel ' + k + ' evidence is ' + txt(kern) + ' '
            + (gotJson === null ? 'unserializable' : gotJson) + ', not ' + kp + ' ' + JSON.stringify(wantFiles));
    }
    const po = parity !== null && typeof parity === 'object';
    for (const f of files === null ? [] : files) {
        const fo = f !== null && typeof f === 'object', fp = fo ? f.path : null, sha = fo ? f.sha256 : null;
        const want = po && typeof fp === 'string' && own(parity, fp) ? parity[fp] : null;
        if (typeof sha !== 'string' || sha !== want) {
            p.push('D7 sha: kernel ' + k + ' ' + txt(fp) + ' sha ' + txt(sha) + ' != parity.json ' + txt(want));
        }
    }
    return p;
}
// The file hashes that pin "the generator and checker that cut this evidence" (provenance; the live
// re-measure in test/41 is the gate, a hash change alone is not). kinds.mjs (the op-kind codes) and the torture
// helpers (VALUE_POOL: the value each code decodes to) shape every script; main.mjs and this tool are gated by
// the live smoke + probe folds instead (header).
const PINNED = Object.freeze([
    'bench/soak/gen.mjs', 'bench/soak/exec.mjs', 'bench/soak/oracles.mjs', 'bench/soak/model.mjs', 'bench/soak/scenarios.mjs',
    'bench/soak/seeds.mjs', 'bench/soak/lanes/index.mjs', 'bench/soak/lanes/graph.mjs', 'bench/soak/lanes/batch.mjs',
    'bench/soak/lanes/error.mjs', 'bench/soak/lanes/nest.mjs', 'bench/soak/adapters/lite.mjs', 'bench/soak/adapters/contract.mjs',
    'bench/soak/kinds.mjs', 'bench/torture/helpers/index.mjs', 'bench/soak/adapters/lite-s3.mjs',
]);
export { PINNED };
// A lane's own descriptor file is pinned only while the lane is rostered (b67 B2a Q2): pinning lanes/wie.mjs before
// the roster flip would turn (p) red with no cut to clear it.
export const LANE_PINS = Object.freeze({ WIE: 'bench/soak/lanes/wie.mjs' });
/** PINNED + the pins of the rostered lanes (roster order). */
export const pinnedFor = (roster) => PINNED.concat(roster.filter((l) => own(LANE_PINS, l)).map((l) => LANE_PINS[l]));

// The large-world probe (addendum 16): a GRAPH smoke cycle never reaches its first LARGE world (index 63), so the
// smoke fold cannot see main's large-world choice. 11 cycles: main REJECTS SOAK_CYCLES below MIN_ACTIVE_CYCLES
// (config.mjs parseIntKey, exit 2), so 11 is the smallest probe main runs (test/41 (q) pins the equality). ops: headpatched GRAPH at DEFAULT_SEED runs at most 28416 ops
// through world 62 over cycles 0-10 (burst 13 16.0c, deterministic count), so PROBE_OPS = ceil(1.15 x 28416 /
// 1000) x 1000 = 33000 makes every cycle run world 63 (and stop before world 127: one LARGE world per cycle).
export const PROBE = Object.freeze({ lane: 'GRAPH', kernel: 'headpatched', cycles: 11, ops: 33000 });

export const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function die(msg) {
    process.stderr.write('calibrate: ' + msg + '\n');
    process.exit(2);
}

function argMap(a) {
    const o = {};
    for (let i = 0; i < a.length; i++) {
        const k = a[i];
        if (k === '--timed') { o.timed = true; continue; }
        if (!/^--[a-z-]+$/.test(k) || i + 1 >= a.length) die('bad argument ' + k);
        o[k.slice(2)] = a[++i];
    }
    return o;
}

/* ---- child: measure one kernel ------------------------------------------------------------------------ */

async function child(opts) {
    let kpath = resolve(ROOT, opts.kernel);
    if (existsSync(kpath) && statSync(kpath).isDirectory()) kpath = join(kpath, 'Signal.js');
    process.env.SOAK_KERNEL = kpath;
    const CFG = await import('../config.mjs');
    const { liteS3Adapter: liteAdapter } = await import('../adapters/lite-s3.mjs');
    const { validateAdapter, applicability } = await import('../adapters/contract.mjs');
    const { laneByName, isLargeWorld, ROSTER } = await import('../lanes/index.mjs');
    const { generateWorld } = await import('../gen.mjs');
    const { runWorld, CHECK_NAMES, SKIP_NAMES } = await import('../exec.mjs');
    const { seedFor, worldSeed } = await import('../seeds.mjs');
    const { KERNEL_FILES, KERNEL_KNOWN_AS } = await import('../kernel.mjs');

    const probs = validateAdapter(liteAdapter);
    if (probs.length) die('adapter invalid: ' + probs.join('; '));
    const cycles = Number(opts.cycles), ops = Number(opts.ops);
    if (!(Number.isSafeInteger(cycles) && cycles >= 1 && Number.isSafeInteger(ops) && ops >= 1)) die('--cycles and --ops must be positive integers');
    if (opts.seed !== undefined && !(/^(0x[0-9a-fA-F]{1,8}|\d{1,10})$/.test(opts.seed) && Number(opts.seed) <= 0xFFFFFFFF)) die('--seed must be a uint32 (decimal or 0x hex), got ' + opts.seed);
    const seed = opts.seed === undefined ? CFG.DEFAULT_SEED : Number(opts.seed) >>> 0;
    const lanes = opts.lanes === undefined ? ROSTER.slice() : opts.lanes.split(',');
    const covOff = opts['cov-off'] === undefined ? null : opts['cov-off'];
    const timed = opts.timed === true;
    const zero = (names) => { const o = {}; for (const n of names) o[n] = 0; return o; };

    const out = {
        kernel: relative(ROOT, kpath), knownAs: KERNEL_KNOWN_AS, files: KERNEL_FILES.map((f) => ({ path: relative(ROOT, f.path), sha256: f.sha256 })),
        seed, cycles, ops, smokeCycles: CFG.SMOKE_CYCLES, smokeOps: CFG.SMOKE_OPS, covOff, lanes: {},
    };
    for (const name of lanes) {
        const desc = laneByName(name);
        if (desc === null) die('unknown lane ' + name);
        const app = applicability(desc, liteAdapter.caps);
        if (app.status !== 'run') die('lane ' + name + ' SKIPs on lite');
        const laneCovOff = covOff !== null && own(desc.covOff, covOff) ? covOff : null;
        const perCycle = [];
        for (let cycle = 0; cycle < cycles; cycle++) {
            const cycleSeed = seedFor(seed, desc.index, cycle);
            const c = { worlds: 0, largeWorlds: 0, ops: 0, failingWorlds: 0, crashes: 0, checks: zero(CHECK_NAMES), skipTainted: zero(SKIP_NAMES), scenarios: {} };
            let smokeSnap = null;
            const wantSmoke = cycle < CFG.SMOKE_CYCLES;
            const t0 = timed ? performance.now() : 0;
            let w = 0;
            while (c.ops < ops) {
                const ws = worldSeed(cycleSeed, w);
                const large = isLargeWorld(desc, w);
                const script = generateWorld(desc, ws, { large, covOff: laneCovOff });
                let r;
                try {
                    r = runWorld(liteAdapter, script);
                } catch (e) {
                    // main.mjs does not catch here either: a crash is a fatal run, never evidence (fail closed).
                    // `crashes` stays in the record so the drift guard (d) also rejects a doc that carries one.
                    die('crash: lane ' + name + ' cycle ' + cycle + ' world ' + w + ' seed 0x' + (ws >>> 0).toString(16) + ': ' + String(e && e.message));
                }
                c.worlds++;
                if (large) c.largeWorlds++;
                c.ops += r.ops;
                if (r.failure !== null) c.failingWorlds++;
                for (const o of CHECK_NAMES) c.checks[o] += r.checks[o];
                for (const o of SKIP_NAMES) c.skipTainted[o] += r.skipTainted[o];
                for (const k of Object.keys(r.scen)) c.scenarios[k] = (own(c.scenarios, k) ? c.scenarios[k] : 0) + r.scen[k];
                w++;
                if (wantSmoke && smokeSnap === null && c.ops >= CFG.SMOKE_OPS) smokeSnap = JSON.parse(JSON.stringify(c));
            }
            if (timed) c.wallMs = Math.round((performance.now() - t0) * 10) / 10;
            if (wantSmoke) c.smoke = smokeSnap;
            perCycle.push(c);
        }
        out.lanes[name] = {
            index: desc.index, required: app.requiredApplicable.slice(), optional: desc.optional.slice(),
            oracles: desc.hardOracles.filter((o) => app.oraclesNA.indexOf(o) === -1), covOff: laneCovOff, perCycle,
        };
    }
    return out;
}

/* ---- summaries (pure; test/41 imports summarize) ------------------------------------------------------ */

/**
 * Fold per-cycle records of one lane into the gate-shaped run totals: scenario hits over the run (warm-up
 * counts, gates.mjs coverageRule), PERFORMED checks per oracle, taint skips and the per-oracle skip ratio
 * skipped / (performed + skipped) for every SKIP oracle (gates.mjs taintSkipRule).
 */
export function foldLane(lane, recs, skipNames) {
    const t = { cycles: recs.length, worlds: 0, ops: 0, failingWorlds: 0, crashes: 0, scenarios: {}, performed: {}, skipTainted: {}, taintRatio: {}, scenarioMinPerCycle: {} };
    for (const c of recs) {
        t.worlds += c.worlds; t.ops += c.ops; t.failingWorlds += c.failingWorlds; t.crashes += c.crashes;
        for (const k of Object.keys(c.checks)) t.performed[k] = (own(t.performed, k) ? t.performed[k] : 0) + c.checks[k];
        for (const k of Object.keys(c.skipTainted)) t.skipTainted[k] = (own(t.skipTainted, k) ? t.skipTainted[k] : 0) + c.skipTainted[k];
    }
    for (const s of lane.required.concat(lane.optional)) {
        let sum = 0, min = Infinity;
        for (const c of recs) {
            const n = own(c.scenarios, s) ? c.scenarios[s] : 0;
            sum += n;
            if (n < min) min = n;
        }
        t.scenarios[s] = sum;
        t.scenarioMinPerCycle[s] = min;
    }
    // exact, as gates.mjs taintSkipRule computes it (never rounded)
    for (const o of skipNames) t.taintRatio[o] = t.skipTainted[o] / (t.performed[o] + t.skipTainted[o]);
    return t;
}

/** Fold main.mjs cycle records of one lane (record order = cycle order) exactly like the calibration loop. */
export function foldMainRecords(lane, recs, skipNames) {
    const rows = recs.map((r) => ({ worlds: r.worlds, ops: r.ops, failingWorlds: r.failingWorlds, crashes: 0, checks: r.checks, skipTainted: r.skipTainted, scenarios: r.scenarios }));
    return foldLane(lane, rows, skipNames);
}

/**
 * Spawn `main.mjs --smoke` on one kernel (async), into a fresh temp SOAK_OUT. Resolves { status, recs, stderr }
 * with every JSONL record (recs null when none). Inherited SOAK_* keys are dropped: the run is the default smoke,
 * on SOAK_LANES = lanes.join(',') when `lanes` is given (a kernel's bound lanes, lanesFor).
 */
export function runMainSmoke(kernelAbs, lanes) {
    return runMain(kernelAbs, true, lanes === undefined ? undefined : { SOAK_LANES: lanes.join(',') });
}

/**
 * runMain(kernel, smoke, extraEnv): smoke = `--smoke`; otherwise the DEFAULT run (DEFAULT_CYCLES x DEFAULT_OPS, all
 * lanes) unless extraEnv sets SOAK_* keys (applied after the inherited SOAK_* keys are dropped).
 */
export async function runMain(kernelAbs, smoke, extraEnv) {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'soak-calib-'));
    const out = join(dir, 'smoke.jsonl');
    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    if (extraEnv !== undefined) for (const k of Object.keys(extraEnv)) env[k] = extraEnv[k];
    env.SOAK_KERNEL = kernelAbs;
    env.SOAK_OUT = out;
    const p = spawn(process.execPath, ['--expose-gc', join(ROOT, 'bench/soak/main.mjs')].concat(smoke ? ['--smoke'] : []), { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const status = await new Promise((res) => p.on('close', (c) => res(c)));
    let recs = null;
    try { recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { recs = null; }
    rmSync(dir, { recursive: true, force: true });
    return { status, recs, stderr: err };
}

/** main.mjs on PROBE (SOAK_LANES / SOAK_CYCLES / SOAK_OPS from PROBE, the PROBE kernel); resolves like runMain. */
export function runMainProbe() {
    return runMain(join(ROOT, KERNELS[PROBE.kernel]), false, { SOAK_LANES: PROBE.lane, SOAK_CYCLES: String(PROBE.cycles), SOAK_OPS: String(PROBE.ops) });
}

/** Full and smoke summaries of one child result. */
export function summarize(res, skipNames) {
    const full = {}, smoke = {};
    for (const name of Object.keys(res.lanes)) {
        const L = res.lanes[name];
        full[name] = foldLane(L, L.perCycle, skipNames);
        const sm = L.perCycle.slice(0, res.smokeCycles).map((c) => c.smoke);
        if (sm.length === res.smokeCycles && sm.every((c) => c !== null && c !== undefined)) smoke[name] = foldLane(L, sm, skipNames);
    }
    return { full, smoke };
}

/* ---- driver ------------------------------------------------------------------------------------------- */

function childArgs(args) {
    return { cmd: process.execPath, argv: [SELF, '--child'].concat(args), opts: { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, env: Object.assign({}, process.env, { SOAK_KERNEL: undefined }) } };
}

function runChild(args) {
    const c = childArgs(args);
    const r = spawnSync(c.cmd, c.argv, c.opts);
    if (r.status !== 0) die('child ' + args.join(' ') + ' exited ' + r.status + ': ' + (r.stderr || '').slice(0, 2000));
    return JSON.parse(r.stdout);
}

/** Untimed children in parallel (never used for a timed measurement). */
async function runChildren(list, width) {
    const { spawn } = await import('node:child_process');
    const out = new Array(list.length);
    let next = 0;
    const one = () => new Promise((res) => {
        const i = next++;
        if (i >= list.length) { res(false); return; }
        const c = childArgs(list[i]);
        const p = spawn(c.cmd, c.argv, { cwd: c.opts.cwd, env: c.opts.env });
        let so = '', se = '';
        p.stdout.on('data', (d) => { so += d; });
        p.stderr.on('data', (d) => { se += d; });
        p.on('close', (code) => {
            if (code !== 0) die('child ' + list[i].join(' ') + ' exited ' + code + ': ' + se.slice(0, 2000));
            out[i] = JSON.parse(so);
            res(true);
        });
    });
    const lane = async () => { while (await one()) { /* next */ } };
    const ws = [];
    for (let k = 0; k < width; k++) ws.push(lane());
    await Promise.all(ws);
    return out;
}

/**
 * The lines of `git status --porcelain` stdout (b80 F2): split on '\n', ONE trailing '\r' stripped per line, empty
 * lines dropped, never trimmed (byte 0 of a line is the index status: ' M' keeps its space). Non-string -> null.
 */
export function porcelainLines(stdout) {
    if (typeof stdout !== 'string') return null;
    const out = [];
    for (const raw of stdout.split('\n')) {
        const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (l.length > 0) out.push(l);
    }
    return out;
}

function gitHead() {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const s = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    return { head: r.status === 0 ? r.stdout.trim() : null, dirty: s.status === 0 ? porcelainLines(s.stdout) : null };
}

function busyNode() {
    const r = spawnSync('ps', ['-Ao', 'pid,pcpu,comm'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout.split('\n').filter((l) => /node/.test(l) && !l.includes(String(process.pid))).map((l) => l.trim().replace(/\s+/g, ' '));
}

/** Worst cells of one folded lane: rarest required scenario, least-performed applicable oracle, highest skip ratio. */
export function worstCells(lane, f) {
    let req = null, ora = null, tnt = null;
    for (const s of lane.required) if (req === null || f.scenarios[s] < req.hits) req = { scenario: s, hits: f.scenarios[s] };
    for (const o of lane.oracles) if (ora === null || f.performed[o] < ora.performed) ora = { oracle: o, performed: f.performed[o] };
    for (const o of Object.keys(f.taintRatio)) if (lane.oracles.indexOf(o) !== -1 && (tnt === null || f.taintRatio[o] > tnt.ratio)) tnt = { oracle: o, ratio: f.taintRatio[o] };
    return { rarestRequired: req, leastPerformed: ora, maxTaint: tnt };
}

// Alternative seeds for the smoke-shape sweep (golden-ratio multiples; DEFAULT_SEED is the binding cut).
export const SWEEP_SEEDS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8].map((i) => (i * 0x9E3779B9) >>> 0));
// The cov-off sweep: DEFAULT_SEED (0xC0FFEE), the 8 sweep seeds, and the plain seeds 11..18 (17 seeds).
export const COVOFF_SEEDS = Object.freeze([0xC0FFEE].concat(SWEEP_SEEDS, [11, 12, 13, 14, 15, 16, 17, 18]));

/**
 * write() step 2b, the large-world probe: the calibration child and main.mjs on PROBE, concurrently (untimed).
 * Dies unless main exited 0 with a PASS summary as its last record, both folds and both largeWorldsPerCycle lists
 * are equal, every cycle ran >= 1 LARGE world and every main boundary read trackerSize 0 / weakAlive 0. Returns doc.probe.
 */
export async function probeStep(skipNames) {
    const [kids, m] = await Promise.all([
        runChildren([['--kernel', KERNELS[PROBE.kernel], '--lanes', PROBE.lane, '--cycles', String(PROBE.cycles), '--ops', String(PROBE.ops)]], 1),
        runMainProbe(),
    ]);
    const L = kids[0].lanes[PROBE.lane];
    const fold = foldLane(L, L.perCycle, skipNames);
    const largeWorldsPerCycle = L.perCycle.map((c) => c.largeWorlds);
    if (m.recs === null) die('main.mjs probe wrote no records (exit ' + m.status + '): ' + m.stderr.slice(0, 400));
    if (m.recs.some((r) => r.type === 'fatal')) die('main.mjs probe crashed');
    const last = m.recs[m.recs.length - 1];
    if (last.type !== 'summary') die('main.mjs probe: the last record is ' + last.type + ', not the summary');
    if (m.status !== 0 || last.verdict !== 'PASS' || last.exitCode !== 0) die('main.mjs probe: exit ' + m.status + ' verdict ' + last.verdict + ' exitCode ' + last.exitCode + ', want exit 0 PASS');
    const cyc = m.recs.filter((r) => r.type === 'cycle');
    if (cyc.length !== PROBE.cycles || cyc.some((r) => r.lane !== PROBE.lane)) die('main.mjs probe wrote ' + cyc.length + ' cycle records, want ' + PROBE.cycles + ' on ' + PROBE.lane);
    const mainFold = foldMainRecords(L, cyc, skipNames);
    const mainLarge = cyc.map((r) => r.largeWorlds);
    if (JSON.stringify(mainFold) !== JSON.stringify(fold)) die('main.mjs probe disagrees with the calibration loop on lane ' + PROBE.lane);
    if (JSON.stringify(mainLarge) !== JSON.stringify(largeWorldsPerCycle)) die('probe largeWorldsPerCycle: main ' + JSON.stringify(mainLarge) + ' != calibration ' + JSON.stringify(largeWorldsPerCycle));
    if (largeWorldsPerCycle.length !== PROBE.cycles || !largeWorldsPerCycle.every((n) => n >= 1)) die('probe: a cycle ran no LARGE world ' + JSON.stringify(largeWorldsPerCycle) + '; raise PROBE.ops (never below world 63)');
    for (const r of cyc) if (r.boundary.trackerSize !== 0 || r.boundary.weakAlive !== 0) die('probe cycle ' + r.cycle + ' boundary trackerSize=' + r.boundary.trackerSize + ' weakAlive=' + r.boundary.weakAlive);
    return { lane: PROBE.lane, kernel: PROBE.kernel, cycles: PROBE.cycles, ops: PROBE.ops, largeWorldsPerCycle, fold };
}

/* ---- --import-throughput: an earlier run's REPORTED throughput (pure; throws, write() dies) ------------- */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// a timed per-cycle list: non-empty, every entry a finite rate >= 0 (null is not zero)
const isRates = (cyc) => Array.isArray(cyc) && cyc.length > 0 && cyc.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
const rateCell = (cyc) => {
    const sorted = cyc.slice().sort((a, b) => a - b);
    return { opsPerSecPerCycle: cyc, min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] };
};

/**
 * The doc.throughputRun block --import-throughput writes, from an earlier calibration doc `old` (b92). Throws an
 * Error (fail closed: never a doc that silently loses REPORTED throughput) unless exactly one case holds:
 *   (a) TIMED: every old.kernels.<k>.throughput.<lane> is a timed cell ({ opsPerSecPerCycle: [..] }, or the older
 *       [{ opsPerSec }, ..]) -> perKernel min / median / max recomputed, provenance from old.provenance;
 *   (b) CHAINED: every cell is the string PENDING (old was itself an --import-throughput run) and
 *       old.throughputRun.perKernel holds timed cells -> old.throughputRun carried forward VERBATIM (the original
 *       timed run's own date / gitHead / timing; never relabelled as a later run).
 * Anything else throws: PENDING with no throughputRun, PENDING mixed with timed cells, a malformed cell, a
 * carried cell whose min / median / max disagree with its own list. Every old kernel must carry full + smoke
 * objects: importCountsSame compares their counts with the new cut at the end of write().
 */
export function importThroughput(old) {
    if (!isObj(old) || !isObj(old.kernels) || Object.keys(old.kernels).length === 0) throw new Error('no non-empty kernels object');
    let timedCells = 0, pendingCells = 0;
    const per = {};
    for (const k of Object.keys(old.kernels)) {
        const K = old.kernels[k];
        if (!isObj(K) || !isObj(K.full) || !isObj(K.smoke) || !isObj(K.throughput) || Object.keys(K.throughput).length === 0) {
            throw new Error('kernel ' + k + ': want full, smoke and a non-empty throughput object');
        }
        per[k] = {};
        for (const name of Object.keys(K.throughput)) {
            const t = K.throughput[name];
            if (t === 'PENDING') { pendingCells++; continue; }
            const cyc = Array.isArray(t) ? t.map((c) => (isObj(c) ? c.opsPerSec : undefined)) : isObj(t) ? t.opsPerSecPerCycle : undefined;
            if (!isRates(cyc)) throw new Error('kernel ' + k + ' lane ' + name + ': throughput is neither PENDING nor a timed cell');
            timedCells++;
            per[k][name] = rateCell(cyc);
        }
    }
    if (timedCells > 0 && pendingCells > 0) throw new Error(timedCells + ' timed and ' + pendingCells + ' PENDING throughput cells (mixed shape)');
    if (timedCells > 0) {
        const op = old.provenance;
        if (!isObj(op)) throw new Error('timed throughput with no provenance object');
        return {
            note: 'REPORTED tier, decides no gate: an earlier timed run of the same child loop (same seed / cycles / ops), held under quiet-lock; its counts were identical to kernels.*',
            date: op.date, gitHead: op.gitHead, node: op.node, cpu: op.cpu, loadavgBefore: op.loadavgBefore, loadavgAfter: op.loadavgAfter,
            busyNodeBefore: op.busyNodeBefore, seconds: op.seconds, timing: op.timing, perKernel: per,
        };
    }
    const tr = old.throughputRun;
    if (!isObj(tr) || !isObj(tr.perKernel) || Object.keys(tr.perKernel).length === 0) {
        throw new Error('every throughput cell is PENDING and there is no throughputRun.perKernel to carry forward (an untimed run holds no throughput)');
    }
    if (typeof tr.date !== 'string' || typeof tr.timing !== 'string') throw new Error('throughputRun has no date / timing provenance');
    for (const k of Object.keys(tr.perKernel)) {
        const P = tr.perKernel[k];
        if (!isObj(P) || Object.keys(P).length === 0) throw new Error('throughputRun.perKernel.' + k + ' is not a non-empty object');
        for (const name of Object.keys(P)) {
            const c = P[name];
            if (!isObj(c) || !isRates(c.opsPerSecPerCycle) || JSON.stringify(rateCell(c.opsPerSecPerCycle)) !== JSON.stringify(c)) {
                throw new Error('throughputRun.perKernel.' + k + '.' + name + ' is not a timed cell');
            }
        }
    }
    // the carried run covers exactly the PENDING cells: a kernel / lane outside old.kernels was never counts-checked
    const cells = (o, f) => JSON.stringify(Object.keys(o).sort().map((k) => [k, Object.keys(f(o[k])).sort()]));
    if (cells(tr.perKernel, (P) => P) !== cells(old.kernels, (K) => K.throughput)) throw new Error('throughputRun.perKernel does not cover exactly the kernels / lanes of old.kernels.*.throughput');
    return JSON.parse(JSON.stringify(tr));
}

/**
 * True when every kernel of the earlier doc `old` counted exactly what the new cut `kernels` counted, full and smoke
 * (counts only, an older cut stored rounded ratios: worlds, ops, scenarios, performed, skipTainted). A kernel of
 * `old` missing from `kernels` is a difference.
 */
export function importCountsSame(old, kernels) {
    const counts = (sh) => JSON.stringify(Object.keys(sh).map((n) => (isObj(sh[n]) ? [n, sh[n].worlds, sh[n].ops, sh[n].scenarios, sh[n].performed, sh[n].skipTainted] : [n])));
    const ok = (a) => isObj(a) && isObj(a.full) && isObj(a.smoke);
    return isObj(old) && isObj(old.kernels) && isObj(kernels) && Object.keys(old.kernels).every((k) => ok(old.kernels[k]) && own(kernels, k) && ok(kernels[k])
        && counts(old.kernels[k].full) === counts(kernels[k].full) && counts(old.kernels[k].smoke) === counts(kernels[k].smoke));
}

async function write(outPath, timed, importFrom) {
    // --import-throughput is read and shape-checked FIRST (fail fast, before the ~15 min sweep); its counts are
    // compared with this cut at the end (importCountsSame needs the new kernels)
    let importOld = null, importRun = null;
    if (importFrom !== undefined) {
        try { importOld = JSON.parse(readFileSync(importFrom, 'utf8')); } catch (e) { die('--import-throughput ' + importFrom + ': unreadable or not JSON: ' + String(e && e.message)); }
        try { importRun = importThroughput(importOld); } catch (e) { die('--import-throughput ' + importFrom + ': ' + String(e && e.message)); }
    }
    const CFG = await import('../config.mjs');
    const { SKIP_NAMES } = await import('../exec.mjs');
    const { GEN_VERSION, GEN_RULES } = await import('../gen.mjs');
    const { COV_OFF_SUPPORTED, ROSTER } = await import('../lanes/index.mjs');
    // every step runs kernel-major over kernelsOf(ROSTER), each kernel on its bound lanes only (header)
    const KS = kernelsOf(ROSTER);
    const bound = (k) => lanesFor(k, ROSTER);
    const lanesArg = (k) => ['--lanes', bound(k).join(',')];
    const parityFiles = JSON.parse(readFileSync(join(ROOT, 'bench/soak/parity.json'), 'utf8')).files;
    const load0 = loadavg().map((x) => Math.round(x * 100) / 100);
    const busy0 = busyNode();
    const t0 = Date.now();
    const note = (m) => process.stderr.write('calibrate: ' + m + ' (' + Math.round((Date.now() - t0) / 1000) + ' s)\n');
    const base = ['--cycles', String(CFG.DEFAULT_CYCLES), '--ops', String(CFG.DEFAULT_OPS)].concat(timed ? ['--timed'] : []);
    // 1) the cut: every kernel over its bound lanes, DEFAULT_SEED, DEFAULT_CYCLES x DEFAULT_OPS, smoke prefix
    // (sequential: timed)
    const kernels = {};
    const meta = {};
    for (const k of KS) {
        const res = runChild(['--kernel', kernelPath(k)].concat(lanesArg(k), base));
        // D7: a lane-only kernel's cells are evidence only for the parity-pinned engine (laneOnlyProblems:
        // test/41's D7 rule)
        if (own(LANE_ONLY_KERNELS, k)) {
            const d7 = laneOnlyProblems(k, res, parityFiles);
            if (d7.length > 0) die(d7.join('; '));
        }
        const s = summarize(res, SKIP_NAMES);
        const tp = {};
        for (const name of Object.keys(res.lanes)) {
            const L = res.lanes[name];
            meta[name] = { index: L.index, required: L.required, optional: L.optional, oracles: L.oracles };
            if (!timed) { tp[name] = 'PENDING'; continue; }
            const cyc = res.lanes[name].perCycle.map((c) => Math.round(c.ops / (c.wallMs / 1000)));
            const sorted = cyc.slice().sort((a, b) => a - b);
            tp[name] = { opsPerSecPerCycle: cyc, min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] };
        }
        kernels[k] = { kernel: res.kernel, knownAs: res.knownAs, files: res.files, full: s.full, smoke: s.smoke, throughput: tp };
        note(k + ' done');
    }
    // doc.lanes in roster order, whichever kernel cut the lane
    const laneMeta = {};
    for (const name of ROSTER) {
        if (!own(meta, name)) die('lane ' + name + ' was cut on no kernel');
        laneMeta[name] = meta[name];
    }
    const loadAfterTimed = loadavg().map((x) => Math.round(x * 100) / 100);
    // 2) main.mjs: the calibration loop must equal main's loop, field for field
    // smoke AND the default full run, every kernel on SOAK_LANES = its bound lanes, concurrently (untimed). The full
    // fold is the only check of main's loop past the smoke prefix (a GRAPH smoke cycle never reaches its first LARGE world).
    const mainCheck = {};
    for (const sh of ['smoke', 'full']) {
        const lanesEnv = (k) => ({ SOAK_LANES: bound(k).join(',') });
        const mainRuns = await Promise.all(KS.map((k) => runMain(join(ROOT, kernelPath(k)), sh === 'smoke', lanesEnv(k))));
        mainCheck[sh] = {};
        KS.forEach((k, i) => {
            const m = mainRuns[i];
            if (m.recs === null) die('main.mjs ' + sh + ' on ' + k + ' wrote no records (exit ' + m.status + '): ' + m.stderr.slice(0, 400));
            if (m.recs.some((r) => r.type === 'fatal')) die('main.mjs ' + sh + ' on ' + k + ' crashed');
            const cyc = m.recs.filter((r) => r.type === 'cycle');
            const lanes = [];
            for (const name of bound(k)) {
                const f = foldMainRecords(laneMeta[name], cyc.filter((r) => r.lane === name), SKIP_NAMES);
                if (JSON.stringify(f) !== JSON.stringify(kernels[k][sh][name])) die('main.mjs ' + sh + ' on ' + k + ' disagrees with the calibration loop on lane ' + name);
                lanes.push(name);
            }
            mainCheck[sh][k] = { mainExit: m.status, lanesEqual: lanes };
        });
        note('main ' + sh + ' cross-check equal on ' + KS.join(', '));
    }
    // 2b) the large-world probe: main's loop past world 63 (the smoke never gets there), equal to the calibration loop
    const probe = await probeStep(SKIP_NAMES);
    note('probe equal: largeWorldsPerCycle ' + JSON.stringify(probe.largeWorldsPerCycle));
    // 3) hollow volume: DEFAULT_CYCLES x OPS_MIN (the smallest gated volume config accepts), every kernel, bound lanes
    const hollowVolume = {};
    const hvArgs = ['--cycles', String(CFG.DEFAULT_CYCLES), '--ops', String(CFG.OPS_MIN)];
    const hv = await runChildren(KS.map((k) => ['--kernel', kernelPath(k)].concat(lanesArg(k), hvArgs)), 2);
    KS.forEach((k, i) => {
        hollowVolume[k] = {};
        for (const name of Object.keys(hv[i].lanes)) {
            const L = hv[i].lanes[name];
            const f = foldLane(L, L.perCycle, SKIP_NAMES);
            hollowVolume[k][name] = { cycles: f.cycles, ops: f.ops, worlds: f.worlds, failingWorlds: f.failingWorlds, performed: f.performed, worst: worstCells(L, f) };
        }
    });
    note('hollow volume done');
    // 4) hollow-evidence controls: every supported cov-off, smoke shape, the lane's first kernel (headpatched if unlisted)
    const covList = [];
    for (const lane of Object.keys(COV_OFF_SUPPORTED)) for (const scen of COV_OFF_SUPPORTED[lane]) covList.push([lane, scen]);
    const smokeArgs = ['--cycles', String(CFG.SMOKE_CYCLES), '--ops', String(CFG.SMOKE_OPS)];
    const cv = await runChildren(covList.map(([lane, scen]) => ['--kernel', kernelPath(kernelsFor(lane)[0]), '--lanes', lane]
        .concat(smokeArgs, ['--cov-off', scen])), 4);
    const covOff = {};
    covList.forEach(([lane, scen], i) => {
        const L = cv[i].lanes[lane];
        const f = foldLane(L, L.perCycle, SKIP_NAMES);
        covOff[lane + ':' + scen] = {
            lane, scenario: scen, kernel: kernelsFor(lane)[0], hits: f.scenarios[scen], ops: f.ops, worlds: f.worlds,
            performed: f.performed, skipTainted: f.skipTainted, taintRatio: f.taintRatio, worst: worstCells(L, f),
        };
    });
    note('cov-off controls done');
    // 5) seed sweep: smoke shape, SWEEP_SEEDS, every kernel over its bound lanes (REPORTED: the binding cut is DEFAULT_SEED)
    const swList = [];
    for (const k of KS) for (const sd of SWEEP_SEEDS) swList.push([k, sd]);
    const sw = await runChildren(swList.map(([k, sd]) => ['--kernel', kernelPath(k)]
        .concat(lanesArg(k), ['--seed', String(sd)], smokeArgs)), 4);
    const seedSweep = { shape: CFG.SMOKE_CYCLES + ' x ' + CFG.SMOKE_OPS, seeds: SWEEP_SEEDS.slice(), cells: {} };
    swList.forEach(([k, sd], i) => {
        for (const name of Object.keys(sw[i].lanes)) {
            const L = sw[i].lanes[name];
            const f = foldLane(L, L.perCycle, SKIP_NAMES);
            const key = k + ':' + name;
            if (!own(seedSweep.cells, key)) seedSweep.cells[key] = [];
            seedSweep.cells[key].push(Object.assign({ seed: sd }, worstCells(L, f)));
        }
    });
    note('seed sweep done');
    // 5b) cov-off seed sweep: every cov-off, smoke shape, COVOFF_SEEDS, every kernel bound to the lane (taint separation)
    const coList = [];
    for (const k of KS) for (const [lane, scen] of covList) {
        if (bound(k).indexOf(lane) !== -1) for (const sd of COVOFF_SEEDS) coList.push([k, lane, scen, sd]);
    }
    const co = await runChildren(coList.map(([k, lane, scen, sd]) => ['--kernel', kernelPath(k), '--lanes', lane]
        .concat(['--seed', String(sd)], smokeArgs, ['--cov-off', scen])), 4);
    const covOffSweep = {
        shape: CFG.SMOKE_CYCLES + ' x ' + CFG.SMOKE_OPS, seeds: COVOFF_SEEDS.slice(),
        note: 'NEST cov-off on every kernel bound to NEST is the coverage gate\'s case since b70 D6 V1 (its skip ratio is REPORTED in cells[].maxTaint; no taint tooth): the coverage gate catches it (hits 0 < SCEN_MIN_SMOKE)',
        cells: {},
    };
    coList.forEach(([k, lane, scen, sd], i) => {
        const L = co[i].lanes[lane];
        const f = foldLane(L, L.perCycle, SKIP_NAMES);
        const key = k + ':' + lane + ':' + scen;
        if (!own(covOffSweep.cells, key)) covOffSweep.cells[key] = [];
        covOffSweep.cells[key].push({ seed: sd, hits: f.scenarios[scen], maxTaint: worstCells(L, f).maxTaint });
    });
    note('cov-off sweep done');
    // 6) worst cells of the cut, every kernel over its bound lanes
    const worst = {};
    for (const k of Object.keys(kernels)) {
        worst[k] = { full: {}, smoke: {} };
        for (const sh of ['full', 'smoke']) for (const name of bound(k)) {
            worst[k][sh][name] = worstCells(laneMeta[name], kernels[k][sh][name]);
        }
    }
    const git = gitHead();
    const pinned = {};
    for (const p of pinnedFor(ROSTER)) pinned[p] = sha256File(join(ROOT, p));
    const doc = {
        schema: 1,
        task: 'SPEC-B-S1cd TASK 11 (burst 8 B6): soak calibration -- DEFAULT_OPS, SCEN_MIN(_SMOKE), CHECK_FLOOR(_SMOKE), TAINT_SKIP_MAX',
        tool: 'node bench/soak/calibration/calibrate.mjs --write ' + relative(ROOT, resolve(outPath)) + (timed ? ' --timed' : '') + (importFrom !== undefined ? ' --import-throughput <the earlier timed run>' : ''),
        guard: 'test/41-soak-config.test.mjs (B6 drift guard): config values == cut, every binding cell clears its constant, live smoke re-measure == kernels.<k>.smoke, live main.mjs probe fold == probe.fold',
        cut: {
            seed: CFG.DEFAULT_SEED, cycles: CFG.DEFAULT_CYCLES, ops: CFG.DEFAULT_OPS, smokeCycles: CFG.SMOKE_CYCLES, smokeOps: CFG.SMOKE_OPS, opsMin: CFG.OPS_MIN,
            genVersion: GEN_VERSION, genRules: GEN_RULES.slice(), checkP: CFG.CHECK_P, worldSteps: CFG.WORLD_STEPS, largeWorldEvery: CFG.LARGE_WORLD_EVERY,
            bindingKernels: Object.keys(KERNELS),
        },
        constants: {
            DEFAULT_OPS: CFG.DEFAULT_OPS, SMOKE_OPS: CFG.SMOKE_OPS, SCEN_MIN: CFG.SCEN_MIN, SCEN_MIN_SMOKE: CFG.SCEN_MIN_SMOKE,
            CHECK_FLOOR: CFG.CHECK_FLOOR, CHECK_FLOOR_SMOKE: CFG.CHECK_FLOOR_SMOKE, TAINT_SKIP_MAX: CFG.TAINT_SKIP_MAX,
        },
        lanes: laneMeta,
        provenance: {
            date: new Date(t0).toISOString(), gitHead: git.head, gitDirty: git.dirty, node: process.version, v8: process.versions.v8,
            cpu: cpus()[0] && cpus()[0].model, host: hostname(), loadavgBefore: load0, loadavgAfterTimed: loadAfterTimed, loadavgAfter: loadavg().map((x) => Math.round(x * 100) / 100),
            busyNodeBefore: busy0, seconds: Math.round((Date.now() - t0) / 1000),
            timing: timed ? 'timed under quiet-lock, sequential children, one kernel at a time (REPORTED tier; decides no gate)' : 'PENDING (untimed run; throughput decides no gate)',
            pinnedSha256: pinned,
        },
        worst,
        kernels,
        mainCrossCheck: { note: 'main.mjs --smoke and the default main.mjs run fold to exactly kernels.<k>.smoke / .full; checked at --write time (it dies on a difference); test/41 repeats the smoke half live; this field gates nothing', smoke: mainCheck.smoke, full: mainCheck.full },
        probe,
        hollowVolume,
        covOff,
        seedSweep,
        covOffSweep,
    };
    if (importFrom !== undefined) {
        // throughput of an EARLIER timed run of this same child loop (REPORTED tier), kept with its own provenance
        // (importThroughput, read at the start: a chained import carries the original timed run forward verbatim)
        doc.throughputRun = importRun;
        if (!importCountsSame(importOld, kernels)) die('--import-throughput: the earlier run counted different numbers; it is not the same loop');
    }
    writeFileSync(outPath, JSON.stringify(doc, null, 1) + '\n');
    note('wrote ' + outPath);
}

/* ---- entry -------------------------------------------------------------------------------------------- */

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
    const a = process.argv.slice(2);
    const mode = a.shift();
    if (mode === '--child') {
        const o = argMap(a);
        const res = await child(o);
        process.stdout.write(JSON.stringify(res) + '\n');
    } else if (mode === '--write') {
        const o = argMap(a.slice(1));
        if (a.length < 1) die('--write <out.json> [--timed] [--import-throughput <earlier.json>]');
        await write(a[0], o.timed === true, o['import-throughput']);
    } else {
        die('usage: calibrate.mjs --write <out.json> [--timed] [--import-throughput <earlier.json>] | --child ...');
    }
}
