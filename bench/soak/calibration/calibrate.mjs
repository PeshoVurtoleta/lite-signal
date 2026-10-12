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
 *          kernels      the BINDING cut: headpatched + 1.5.2 at DEFAULT_SEED, DEFAULT_CYCLES x DEFAULT_OPS, with
 *                       the smoke prefix; sequential children (the only timed part, REPORTED tier)
 *          mainCrossCheck  main.mjs --smoke AND the default main.mjs run, on BOTH kernels, fold
 *                       (foldMainRecords) to exactly kernels.<k>.smoke / .full; --write dies on any difference.
 *                       test/41 repeats the smoke half live.
 *          hollowVolume DEFAULT_CYCLES x OPS_MIN, both kernels (the smallest gated volume config accepts)
 *          covOff       every supported cov-off at the smoke shape on headpatched (hollow-evidence controls)
 *          seedSweep    SWEEP_SEEDS at the smoke shape, both kernels (REPORTED seed spread; binds nothing)
 *          covOffSweep  every cov-off at the smoke shape over COVOFF_SEEDS, both kernels (taint separation)
 *   node bench/soak/calibration/calibrate.mjs --child <kernel> --cycles C --ops O [--lanes L,..] [--cov-off s] [--timed]
 *        one kernel per process (kernel.mjs reads SOAK_KERNEL once, at import); one JSON line on stdout
 * The drift guard (test/41) re-measures the SMOKE cells only, through the real main.mjs; the full-shape cells
 * are not re-measured live (accepted LP design). PINNED shas are checked by the guard: a pinned file that
 * moves (gen, exec, oracles, lanes, main, this tool ...) turns it red with a "recut" message.
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
// The file hashes that pin "the generator and checker that cut this evidence" (provenance; the live
// re-measure in test/41 is the gate, a hash change alone is not).
const PINNED = Object.freeze([
    'bench/soak/gen.mjs', 'bench/soak/exec.mjs', 'bench/soak/oracles.mjs', 'bench/soak/model.mjs', 'bench/soak/scenarios.mjs',
    'bench/soak/seeds.mjs', 'bench/soak/lanes/index.mjs', 'bench/soak/lanes/graph.mjs', 'bench/soak/lanes/batch.mjs',
    'bench/soak/lanes/error.mjs', 'bench/soak/lanes/nest.mjs', 'bench/soak/adapters/lite.mjs', 'bench/soak/adapters/contract.mjs',
    'bench/soak/main.mjs', 'bench/soak/calibration/calibrate.mjs',
]);
export { PINNED };

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
    const { liteAdapter } = await import('../adapters/lite.mjs');
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
            const c = { worlds: 0, ops: 0, failingWorlds: 0, crashes: 0, checks: zero(CHECK_NAMES), skipTainted: zero(SKIP_NAMES), scenarios: {} };
            let smokeSnap = null;
            const wantSmoke = cycle < CFG.SMOKE_CYCLES;
            const t0 = timed ? performance.now() : 0;
            let w = 0;
            while (c.ops < ops) {
                const ws = worldSeed(cycleSeed, w);
                const script = generateWorld(desc, ws, { large: isLargeWorld(desc, w), covOff: laneCovOff });
                let r;
                try {
                    r = runWorld(liteAdapter, script);
                } catch (e) {
                    // main.mjs does not catch here either: a crash is a fatal run, never evidence (fail closed).
                    // `crashes` stays in the record so the drift guard (d) also rejects a doc that carries one.
                    die('crash: lane ' + name + ' cycle ' + cycle + ' world ' + w + ' seed 0x' + (ws >>> 0).toString(16) + ': ' + String(e && e.message));
                }
                c.worlds++;
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
 * with every JSONL record (recs null when none). Inherited SOAK_* keys are dropped: the run is the default smoke.
 */
export function runMainSmoke(kernelAbs) {
    return runMain(kernelAbs, true);
}

/** runMain(kernel, smoke): smoke = `--smoke`; otherwise the DEFAULT run (DEFAULT_CYCLES x DEFAULT_OPS, all lanes). */
export async function runMain(kernelAbs, smoke) {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'soak-calib-'));
    const out = join(dir, 'smoke.jsonl');
    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
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

function gitHead() {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const s = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    return { head: r.status === 0 ? r.stdout.trim() : null, dirty: s.status === 0 ? s.stdout.trim().split('\n').filter((l) => l.length > 0) : null };
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

async function write(outPath, timed, importFrom) {
    const CFG = await import('../config.mjs');
    const { SKIP_NAMES } = await import('../exec.mjs');
    const { GEN_VERSION, GEN_RULES } = await import('../gen.mjs');
    const { COV_OFF_SUPPORTED } = await import('../lanes/index.mjs');
    const load0 = loadavg().map((x) => Math.round(x * 100) / 100);
    const busy0 = busyNode();
    const t0 = Date.now();
    const note = (m) => process.stderr.write('calibrate: ' + m + ' (' + Math.round((Date.now() - t0) / 1000) + ' s)\n');
    const base = ['--cycles', String(CFG.DEFAULT_CYCLES), '--ops', String(CFG.DEFAULT_OPS)].concat(timed ? ['--timed'] : []);
    // 1) the binding cut: both frozen kernels, DEFAULT_SEED, DEFAULT_CYCLES x DEFAULT_OPS, smoke prefix (sequential: timed)
    const kernels = {};
    const laneMeta = {};
    for (const k of Object.keys(KERNELS)) {
        const res = runChild(['--kernel', KERNELS[k]].concat(base));
        const s = summarize(res, SKIP_NAMES);
        const tp = {};
        for (const name of Object.keys(res.lanes)) {
            laneMeta[name] = { index: res.lanes[name].index, required: res.lanes[name].required, optional: res.lanes[name].optional, oracles: res.lanes[name].oracles };
            if (!timed) { tp[name] = 'PENDING'; continue; }
            const cyc = res.lanes[name].perCycle.map((c) => Math.round(c.ops / (c.wallMs / 1000)));
            const sorted = cyc.slice().sort((a, b) => a - b);
            tp[name] = { opsPerSecPerCycle: cyc, min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] };
        }
        kernels[k] = { kernel: res.kernel, knownAs: res.knownAs, files: res.files, full: s.full, smoke: s.smoke, throughput: tp };
        note(k + ' done');
    }
    const loadAfterTimed = loadavg().map((x) => Math.round(x * 100) / 100);
    // 2) main.mjs --smoke on headpatched: the calibration loop must equal main's loop, field for field
    // smoke AND the default full run, both kernels, concurrently (untimed). The full fold is the only check of
    // main's loop past the smoke prefix (a GRAPH smoke cycle never reaches its first LARGE world).
    const mainCheck = {};
    for (const sh of ['smoke', 'full']) {
        const mainRuns = await Promise.all(Object.keys(KERNELS).map((k) => runMain(join(ROOT, KERNELS[k]), sh === 'smoke')));
        mainCheck[sh] = {};
        Object.keys(KERNELS).forEach((k, i) => {
            const m = mainRuns[i];
            if (m.recs === null) die('main.mjs ' + sh + ' on ' + k + ' wrote no records (exit ' + m.status + '): ' + m.stderr.slice(0, 400));
            if (m.recs.some((r) => r.type === 'fatal')) die('main.mjs ' + sh + ' on ' + k + ' crashed');
            const cyc = m.recs.filter((r) => r.type === 'cycle');
            const lanes = [];
            for (const name of Object.keys(laneMeta)) {
                const f = foldMainRecords(laneMeta[name], cyc.filter((r) => r.lane === name), SKIP_NAMES);
                if (JSON.stringify(f) !== JSON.stringify(kernels[k][sh][name])) die('main.mjs ' + sh + ' on ' + k + ' disagrees with the calibration loop on lane ' + name);
                lanes.push(name);
            }
            mainCheck[sh][k] = { mainExit: m.status, lanesEqual: lanes };
        });
        note('main ' + sh + ' cross-check equal on ' + Object.keys(KERNELS).join(', '));
    }
    // 3) hollow volume: DEFAULT_CYCLES x OPS_MIN (the smallest gated volume config accepts), both kernels
    const hollowVolume = {};
    const hv = await runChildren(Object.keys(KERNELS).map((k) => ['--kernel', KERNELS[k], '--cycles', String(CFG.DEFAULT_CYCLES), '--ops', String(CFG.OPS_MIN)]), 2);
    Object.keys(KERNELS).forEach((k, i) => {
        hollowVolume[k] = {};
        for (const name of Object.keys(hv[i].lanes)) {
            const L = hv[i].lanes[name];
            const f = foldLane(L, L.perCycle, SKIP_NAMES);
            hollowVolume[k][name] = { cycles: f.cycles, ops: f.ops, worlds: f.worlds, performed: f.performed, worst: worstCells(L, f) };
        }
    });
    note('hollow volume done');
    // 4) hollow-evidence controls: every supported cov-off, smoke shape, headpatched
    const covList = [];
    for (const lane of Object.keys(COV_OFF_SUPPORTED)) for (const scen of COV_OFF_SUPPORTED[lane]) covList.push([lane, scen]);
    const cv = await runChildren(covList.map(([lane, scen]) => ['--kernel', KERNELS.headpatched, '--lanes', lane, '--cycles', String(CFG.SMOKE_CYCLES), '--ops', String(CFG.SMOKE_OPS), '--cov-off', scen]), 4);
    const covOff = {};
    covList.forEach(([lane, scen], i) => {
        const L = cv[i].lanes[lane];
        const f = foldLane(L, L.perCycle, SKIP_NAMES);
        covOff[lane + ':' + scen] = { lane, scenario: scen, kernel: 'headpatched', hits: f.scenarios[scen], ops: f.ops, worlds: f.worlds, performed: f.performed, skipTainted: f.skipTainted, taintRatio: f.taintRatio, worst: worstCells(L, f) };
    });
    note('cov-off controls done');
    // 5) seed sweep: smoke shape, SWEEP_SEEDS, both kernels (REPORTED: the binding cut is DEFAULT_SEED)
    const swList = [];
    for (const k of Object.keys(KERNELS)) for (const sd of SWEEP_SEEDS) swList.push([k, sd]);
    const sw = await runChildren(swList.map(([k, sd]) => ['--kernel', KERNELS[k], '--seed', String(sd), '--cycles', String(CFG.SMOKE_CYCLES), '--ops', String(CFG.SMOKE_OPS)]), 4);
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
    // 5b) cov-off seed sweep: every cov-off, smoke shape, COVOFF_SEEDS, both kernels (taint separation evidence)
    const coList = [];
    for (const k of Object.keys(KERNELS)) for (const [lane, scen] of covList) for (const sd of COVOFF_SEEDS) coList.push([k, lane, scen, sd]);
    const co = await runChildren(coList.map(([k, lane, scen, sd]) => ['--kernel', KERNELS[k], '--lanes', lane, '--seed', String(sd), '--cycles', String(CFG.SMOKE_CYCLES), '--ops', String(CFG.SMOKE_OPS), '--cov-off', scen]), 4);
    const covOffSweep = {
        shape: CFG.SMOKE_CYCLES + ' x ' + CFG.SMOKE_OPS, seeds: COVOFF_SEEDS.slice(),
        note: 'lite-1.5.2 NEST cov-off reads O1c ~0.25 (inside the clean band): the taint gate cannot separate it there; the coverage gate does (hits 0 < SCEN_MIN_SMOKE)',
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
    // 6) worst cells of the binding cut
    const worst = {};
    for (const k of Object.keys(kernels)) {
        worst[k] = { full: {}, smoke: {} };
        for (const sh of ['full', 'smoke']) for (const name of Object.keys(laneMeta)) worst[k][sh][name] = worstCells(laneMeta[name], kernels[k][sh][name]);
    }
    const git = gitHead();
    const pinned = {};
    for (const p of PINNED) pinned[p] = sha256File(join(ROOT, p));
    const doc = {
        schema: 1,
        task: 'SPEC-B-S1cd TASK 11 (burst 8 B6): soak calibration -- DEFAULT_OPS, SCEN_MIN(_SMOKE), CHECK_FLOOR(_SMOKE), TAINT_SKIP_MAX',
        tool: 'node bench/soak/calibration/calibrate.mjs --write ' + relative(ROOT, resolve(outPath)) + (timed ? ' --timed' : '') + (importFrom !== undefined ? ' --import-throughput <the earlier timed run>' : ''),
        guard: 'test/41-soak-config.test.mjs (B6 drift guard): config values == cut, every binding cell clears its constant, live smoke re-measure == kernels.headpatched.smoke',
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
        hollowVolume,
        covOff,
        seedSweep,
        covOffSweep,
    };
    if (importFrom !== undefined) {
        // throughput of an EARLIER timed run of this same child loop (REPORTED tier), kept with its own provenance
        const old = JSON.parse(readFileSync(importFrom, 'utf8'));
        const per = {};
        for (const k of Object.keys(old.kernels)) {
            per[k] = {};
            for (const name of Object.keys(old.kernels[k].throughput)) {
                const t = old.kernels[k].throughput[name];
                const cyc = Array.isArray(t) ? t.map((c) => c.opsPerSec) : t.opsPerSecPerCycle;
                const sorted = cyc.slice().sort((a, b) => a - b);
                per[k][name] = { opsPerSecPerCycle: cyc, min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] };
            }
        }
        const op = old.provenance;
        doc.throughputRun = {
            note: 'REPORTED tier, decides no gate: an earlier timed run of the same child loop (same seed / cycles / ops), held under quiet-lock; its counts were identical to kernels.*',
            date: op.date, gitHead: op.gitHead, node: op.node, cpu: op.cpu, loadavgBefore: op.loadavgBefore, loadavgAfter: op.loadavgAfter,
            busyNodeBefore: op.busyNodeBefore, seconds: op.seconds, timing: op.timing, perKernel: per,
        };
        // counts only (an older cut stored rounded ratios): worlds, ops, scenarios, performed, skipTainted
        const counts = (sh) => JSON.stringify(Object.keys(sh).map((n) => [n, sh[n].worlds, sh[n].ops, sh[n].scenarios, sh[n].performed, sh[n].skipTainted]));
        const same = Object.keys(old.kernels).every((k) => counts(old.kernels[k].full) === counts(kernels[k].full) && counts(old.kernels[k].smoke) === counts(kernels[k].smoke));
        if (!same) die('--import-throughput: the earlier run counted different numbers; it is not the same loop');
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
