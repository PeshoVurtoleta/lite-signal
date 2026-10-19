/**
 * @zakkster/lite-signal soak -- the BURN-IN entry (SPEC-B v2 sections 2, 3.3, 7, 8; S1c TASK 6).
 *
 *   node --expose-gc bench/soak/main.mjs [--smoke]        (npm run soak / npm run soak:smoke)
 *
 * One run = header, then cycles x lanes x worlds, then summary. Every lane-cycle plays worlds of its lane
 * (gen -> exec -> oracles) until SOAK_OPS ops ran, then closes a BOUNDARY (boundary.mjs: drop refs, forced-GC
 * drain, tracker.size() + WeakRef witness, memory after the drain) and writes ONE cycle record. The verdict
 * is re-derived from those records by gates.mjs (LaneGates + judgeRun): main never judges on its own.
 *
 * Records (jsonl.mjs, contiguous seq): header (provenance.mjs, REQUIRED_EXTRAS incl. the divergences
 * digest), cycle x (cycles x lanes), summary; a crash adds a fatal record. Cycle record field order, every
 * cycle: identity, volume, checks, skipTainted, failures, scenarios, throughput, memory, rss, boundary, gc.
 * rss (B-B3): one RssSampler (rss.mjs) per run, reset per lane-cycle, fed process.memoryUsage.rss() in MB at every
 * world end (before the boundary drain): {samples (stored count), p95MB, maxMB, stride}; gates.mjs rssRule reads
 * the post-warm-up p95MB values. Cold: <= 1 transient boxed double per world (the MB value passed to push).
 *
 * Failure records (amendment 13, B3 record obligations): one per failing world, at most FAIL_CAP per cycle
 * record (failureCounts and failingWorlds stay complete):
 *   {oracles[], sigs[], sig, known, tag, world, worldSeed, step, op, fails[], scen[], worldScen[],
 *    worldScenCounts{}, escape, replay, detail}
 *   oracles / fails[].oracle are ORACLE ids (O1c, O1e ...: the divergence registry keys on them);
 *   failureCounts keys are `<family>:<sig>` (gates.mjs oracleFamily: O1c/O1e -> O1, O7a -> O7). Never mixed.
 *   escape   the normalized leaves thrown by the OUTERMOST W.batch call of the failing step ([] when it
 *            returned normally), never a nested batch's; null when the failing op is not a batch op (S1:
 *            exec.mjs calls W.batch at top level only for op 'batch').
 *   known    divergences.classify(...).known (e.g. 'DIV-F21'), or null (unexplained).
 *
 * stderr protocol (fs.writeSync): BREACH (deduplicated by (family, lane, sig, known): an UNCLASSIFIED
 * failure with the same sig as a known one gets its own line), REPLAY (first per distinct (lane, family,
 * sig)), INCONCLUSIVE, SKIP, NOTE, CONFIG (exit 2), CRASH. stdout: HEARTBEAT lines, then the END sentinel
 * `soak: END verdict=<V> exit=<N> records=<R>` as the LAST line. A config error (and a SKIP on lite) is
 * verdict null: exit 2 with one `soak: CONFIG --` line, no record, no END line.
 *
 * Signals: SIGINT / SIGTERM finish the current lane-cycle early (its record is marked interrupted, its
 * boundary still runs), then write the summary with reason 'signal' -> INCONCLUSIVE (exit 3), or FAIL when
 * a failure was already seen. Worlds yield one macrotask every 64 worlds so a signal is seen.
 *
 * SOAK_REPLAY / SOAK_SHRINK only DISPATCH to replay.mjs / shrink.mjs (S1c batch B4); a missing module
 * exits 2 (fail closed: a replay request never runs a burn-in in its place).
 *
 * Kernel-free on import: the kernel (kernel.mjs, SOAK_KERNEL seam) loads only inside main(), so tests can
 * import tapAdapter / BreachLog / failureRecord without loading any Signal.js.
 *
 * COLD module: no hot body. Run totals live in gates.mjs Totals (Float64Array slots, exact to 2^53).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    readConfig, configExit, formatReplayKey, CYCLES_MAX, WARMUP_CYCLES, FAIL_CAP, DETAIL_MAX, VERDICT,
} from './config.mjs';
import {
    GATES, Totals, LaneGates, judgeRun, verdict as runVerdict, oracleFamily, totalsRule,
} from './gates.mjs';
import { RssSampler } from './rss.mjs';
import { classify, digest, REGISTRY_URL, REGISTRY_PROBLEMS } from './divergences.mjs';
import { CHECK_NAMES, SKIP_NAMES, runWorld } from './exec.mjs';
import { generateWorld, GEN_RULES } from './gen.mjs';
import { seedFor, worldSeed, selfCheckSeeds } from './seeds.mjs';
import { ROSTER, ALL_SCENARIOS, COV_OFF_SUPPORTED, laneByName, isLargeWorld } from './lanes/index.mjs';
import { openStream, writeRecord, protocol, stdoutLine, endLine, installFatalHandlers, defaultOutPath } from './jsonl.mjs';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const YIELD_MASK = 63;            // yield one macrotask every 64 worlds
const HEARTBEAT_MS = 5000;        // in-cycle heartbeat period (a heartbeat also closes every lane-cycle)
const SEED_SELF_CHECK_SPAN = 1024;
const ADAPTERS = Object.freeze({ lite: './adapters/lite.mjs' });

/* ---- the adapter tap ------------------------------------------------------------------------------ */

/**
 * Wrap an adapter so main sees every world it opens. tap = { onOpen(world) } is called with the RAW world
 * (main tracks world.registry in the leak tracker and a WeakRef witness). The returned adapter's worlds
 * delegate to the raw world (prototype chain) and override batch() only:
 *   tap.escape   set to [] when an OUTERMOST batch call starts; replaced by world.normalizeEscape(err)
 *                when THAT call throws. A nested batch call never touches it, so a nested throw that the
 *                outer call swallows or replaces is never reported as the step's escape.
 * The tap holds no reference to any world: retention measures the worlds, not the harness.
 */
export function tapAdapter(adapter, tap) {
    if (adapter === null || typeof adapter !== 'object' || typeof adapter.open !== 'function') throw new TypeError('tapAdapter: adapter must have open()');
    if (tap === null || typeof tap !== 'object' || typeof tap.onOpen !== 'function') throw new TypeError('tapAdapter: tap must have onOpen(world)');
    tap.escape = null;
    // defineProperty: a frozen adapter's own open() is non-writable, so a plain assignment on the
    // delegating object would throw; the override is an own property of the delegate.
    const open = function open(opts) {
        const raw = adapter.open(opts);
        tap.onOpen(raw);
        let depth = 0;
        const batch = function batch(fn) {
            const outer = depth === 0;
            if (outer) tap.escape = [];
            depth++;
            try {
                return raw.batch(fn);
            } catch (e) {
                if (outer) tap.escape = raw.normalizeEscape(e);
                throw e;
            } finally {
                depth--;
            }
        };
        // A PLAIN delegate (own bound methods), never Object.create(raw): a world used as a prototype
        // stayed reachable from V8 optimized code after its world died (warm-up boundary trackerSize 1-4).
        const W = {};
        for (const k of Object.keys(raw)) {
            const v = raw[k];
            W[k] = typeof v === 'function' ? v.bind(raw) : v;
        }
        W.batch = batch;
        return W;
    };
    return Object.freeze(Object.create(adapter, { open: { value: open, enumerable: true } }));
}

/* ---- failure records ------------------------------------------------------------------------------ */

const uniq = (arr) => { const out = []; for (const x of arr) if (out.indexOf(x) === -1) out.push(x); return out; };
// kernel.mjs KERNEL_KNOWN_AS (the header's controls.name), set by main() once the kernel has loaded; null until
// then and on every other path (replay / shrink / a test import): main.mjs stays kernel-free on import.
let kernelKnownAs = null;

/**
 * Build one failing world's record and classify it. r: runWorld() result with r.failure !== null.
 * ctx { engine, lane, cycle, world, worldSeed, escape (tap.escape) }. classify() is the divergence
 * registry (a malformed record throws there: a harness bug is a fatal, never a silent "unknown").
 */
export function failureRecord(r, ctx) {
    const f = r.failure;
    const worldScenCounts = {};
    for (const k of Object.keys(r.scen)) worldScenCounts[k] = r.scen[k];
    const worldScen = Object.keys(worldScenCounts).filter((k) => worldScenCounts[k] > 0);
    const fails = f.fails.map((x) => ({ oracle: x.oracle, sig: x.sig, detail: String(x.detail).slice(0, DETAIL_MAX) }));
    const escape = f.op === 'batch' && Array.isArray(ctx.escape) ? ctx.escape.map((l) => Object.assign({}, l)) : null;
    const crec = { engine: ctx.engine, lane: ctx.lane, step: f.step, op: f.op, fails, scen: f.scen.slice(), worldScen, worldScenCounts };
    if (escape !== null) crec.escape = escape;
    // a fixed registry entry (fixedIn set) explains only when includeFixed is true (any named controls.json kernel); on the tree or a scratch
    // kernel it is a regression. Same identity as the header's controls.name (provenance.mjs) and SoakReport.
    const cls = classify(crec, { includeFixed: kernelKnownAs !== null });
    return {
        oracles: uniq(fails.map((x) => x.oracle)),
        sigs: uniq(fails.map((x) => x.sig)),
        sig: fails[0].sig,
        known: cls === null ? null : cls.known,
        tag: cls === null ? null : cls.tag,
        // per fail, parallel to fails[]: the registry ids that explain THAT fail (classify perFail); all null
        // when the world is unexplained (a world is known only when every fail of its step is explained)
        failKnown: fails.map((x, i) => (cls === null ? null : cls.perFail[i].join('+'))),
        world: ctx.world,
        worldSeed: ctx.worldSeed,
        step: f.step,
        op: f.op,
        fails,
        scen: crec.scen,
        worldScen,
        worldScenCounts,
        escape,
        replay: formatReplayKey(ctx.lane, ctx.cycle, ctx.worldSeed),
        detail: fails[0].detail,
    };
}

/** failureCounts keys of one failing world: `<family>:<sig>`, each counted once per world. */
export function familyKeys(fails) {
    return uniq(fails.map((x) => oracleFamily(x.oracle) + ':' + x.sig));
}

/* ---- BREACH lines --------------------------------------------------------------------------------- */

/**
 * Oracle BREACH lines, deduplicated per run by (family, lane, sig, known). known is part of the key: an
 * unclassified failure (known null) whose sig equals a known one's still gets its own line, so a new
 * defect can never hide behind a tolerated divergence. write(line) receives every protocol line.
 */
export class BreachLog {
    constructor(write) {
        if (typeof write !== 'function') throw new TypeError('BreachLog: write must be a function');
        this.write = write;
        this.seen = new Set();
        this.replaySeen = new Set();
        this.entries = [];
    }
    static key(family, lane, sig, known) { return family + '|' + lane + '|' + sig + '|' + (known === null ? '-' : known); }
    /** Note one failing world (a failureRecord). Returns the number of NEW BREACH lines written. */
    noteWorld(rec, lane, engine) {
        let n = 0;
        if (rec.known !== null && !(Array.isArray(rec.failKnown) && rec.failKnown.length === rec.fails.length)) {
            throw new TypeError('BreachLog: a known world needs failKnown[] parallel to fails[]');
        }
        for (let i = 0; i < rec.fails.length; i++) {
            const f = rec.fails[i];
            const known = rec.known === null ? null : rec.failKnown[i];   // each fail carries its own tag
            const family = oracleFamily(f.oracle);
            const k = BreachLog.key(family, lane, f.sig, known);
            if (this.seen.has(k)) continue;
            this.seen.add(k);
            n++;
            this.entries.push({ oracle: family, lane, sig: f.sig, known, replay: rec.replay, scen: rec.scen.slice(), detail: f.detail });
            this.write('soak: BREACH oracle=' + family + ' lane=' + lane + ' sig=' + f.sig + ' known=' + (known === null ? 'none' : known) +
                ' scen=' + (rec.scen.length ? rec.scen.join(',') : '-') + ' engine=' + engine + ' replay=' + rec.replay + ' detail=' + f.detail);
            const rk = lane + '|' + family + '|' + f.sig;
            if (!this.replaySeen.has(rk)) {
                this.replaySeen.add(rk);
                this.write('soak: REPLAY SOAK_REPLAY=' + rec.replay);
            }
        }
        return n;
    }
    get size() { return this.entries.length; }
}

/* ---- the run -------------------------------------------------------------------------------------- */

const tick = () => new Promise((r) => setImmediate(r));
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const MB = 1048576;

async function dispatch(cfg) {
    const file = cfg.shrink ? 'shrink.mjs' : 'replay.mjs';
    const name = cfg.shrink ? 'runShrink' : 'runReplay';
    const url = new URL('./' + file, import.meta.url);
    if (!existsSync(fileURLToPath(url))) {
        configExit((cfg.shrink ? 'SOAK_SHRINK' : 'SOAK_REPLAY') + ': bench/soak/' + file + ' is not built yet (S1c batch B4); refusing to run a burn-in in its place');
    }
    const mod = await import(url.href);
    if (typeof mod[name] !== 'function') configExit('bench/soak/' + file + ' does not export ' + name + '()');
    const code = await mod[name](cfg);
    // fail closed: only an exit code main knows (0 PASS/SMOKE/PARTIAL, 1 FAIL, 2 CONFIG, 3 INCONCLUSIVE)
    if (!(Number.isInteger(code) && code >= 0 && code <= 3)) {
        protocol('soak: CRASH -- ' + name + ' returned ' + String(code) + ' (expected an exit code 0..3)');
        process.exit(1);
    }
    process.exit(code);
}

async function main() {
    const cfg = readConfig(process.env, { roster: ROSTER, scenarios: ALL_SCENARIOS, covOffSupported: COV_OFF_SUPPORTED, argv: process.argv.slice(2) });
    if (cfg.replay !== null) return dispatch(cfg);
    // S2 keys: wrap.mjs owns them. Set on the burn-in, they would be silently ignored -> exit 2.
    if (cfg.record.SOAK_WRAP.source !== 'default') configExit('SOAK_WRAP is read by wrap.mjs (S2), not by the burn-in; unset it');
    if (cfg.repr) configExit('SOAK_REPR is an S2 (wrap.mjs) lane, not built yet; unset it');

    // startup gates (kind 'startup', gates.mjs) and self-checks: red -> exit 2 before any record
    for (const g of GATES) {
        if (g.kind !== 'startup') continue;
        const res = g.id === 'totals' ? totalsRule(Totals) : null;
        if (res === null) configExit('startup gate ' + g.id + ' has no runner in main.mjs');
        if (res.verdict !== VERDICT.PASS) configExit('startup gate ' + g.id + ' is red: ' + JSON.stringify(res));
    }
    const seedProblem = selfCheckSeeds(cfg.seed, cfg.roster.length, cfg.forever ? SEED_SELF_CHECK_SPAN : Math.min(cfg.cycles, SEED_SELF_CHECK_SPAN));
    if (seedProblem !== null) configExit('seed self-check: ' + seedProblem);
    if (REGISTRY_PROBLEMS.length > 0) configExit('divergences.json is invalid: ' + REGISTRY_PROBLEMS[0]);
    const divDigest = digest(readFileSync(REGISTRY_URL, 'utf8'));

    // the engine (the kernel loads HERE, through the SOAK_KERNEL seam)
    if (!own(ADAPTERS, cfg.engine)) configExit('SOAK_ENGINE: no adapter for ' + cfg.engine);
    const adMod = await import(ADAPTERS[cfg.engine]);
    const adapter = adMod.liteAdapter;
    const { validateAdapter, applicability } = await import('./adapters/contract.mjs');
    const probs = validateAdapter(adapter);
    if (probs.length > 0) configExit('adapter ' + cfg.engine + ' is invalid: ' + probs.join('; '));

    // applicability (SPEC 3.3): a lite SKIP or a requested lane that would SKIP is exit 2
    const lanesHdr = [], scenHdr = {}, naHdr = {}, skipped = [], run = [];
    for (const name of cfg.lanes) {
        const desc = laneByName(name);
        const app = applicability(desc, adapter.caps);
        lanesHdr.push({ name, status: app.status, missingCaps: app.missingCaps, engine: cfg.engine });
        scenHdr[name] = { required: app.requiredApplicable, optional: desc.optional.slice(), na: app.scenariosNA };
        naHdr[name] = app.oraclesNA;
        if (app.status === 'skip') {
            skipped.push({ lane: name, missingCaps: app.missingCaps, engine: cfg.engine });
            if (cfg.record.SOAK_LANES.source !== 'default') configExit('lane ' + name + ' needs cap ' + (app.missingCaps[0] || 'hardOracles') + ', absent on engine ' + cfg.engine);
            continue;
        }
        const oracles = desc.hardOracles.filter((o) => app.oraclesNA.indexOf(o) === -1);
        run.push({ name, desc, gates: new LaneGates({ lane: name, oracles, required: app.requiredApplicable }) });
    }
    if (skipped.length > 0) {
        const pre = runVerdict({ configError: null, engine: cfg.engine, skipped, sawFail: false, fatal: false, reason: 'end', forever: cfg.forever, smoke: cfg.smoke, lanesRun: run.length, inconclusive: [] });
        if (pre.verdict === null) configExit(pre.why);
    }

    const { buildHeader } = await import('./provenance.mjs');
    // provenance.mjs imports kernel.mjs statically, so this import loads nothing new: the same KERNEL_KNOWN_AS
    // the header records as controls.name decides classify's includeFixed (failureRecord)
    ({ KERNEL_KNOWN_AS: kernelKnownAs } = await import('./kernel.mjs'));
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    const { GcProfiler } = await import('@zakkster/lite-gc-profiler');
    const { closeBoundary } = await import('./boundary.mjs');

    const header = buildHeader(cfg, {
        kind: 'burn-in',
        engine: { name: adapter.name, version: adapter.version(), caps: adapter.caps, files: adapter.files() },
        laneRoster: ROSTER.slice(), lanes: lanesHdr, scenarios: scenHdr, oraclesNA: naHdr, genRules: GEN_RULES.slice(),
        divergences: divDigest,
    });
    const t0 = performance.now();
    const stream = openStream(cfg.out !== null ? cfg.out : defaultOutPath('burn-in', header.gitSha), t0, 'burn-in');
    for (const s of skipped) protocol('soak: SKIP -- lane=' + s.lane + ' cap=' + s.missingCaps.join(',') + ' engine=' + s.engine);

    const ctx = { lane: null, cycle: null, world: null, worldSeed: null };
    const runTotals = new Totals(['worlds', 'ops', 'failingWorlds'].concat(CHECK_NAMES.map((o) => 'checks.' + o), SKIP_NAMES.map((o) => 'skipTainted.' + o)));
    const breaches = new BreachLog(protocol);
    let cyclesRun = 0;
    let fatalSeen = false;

    const summarize = (reason) => {
        if (reason === 'fatal') fatalSeen = true;
        const computed = [], perLane = {};
        for (const L of run) {
            if (L.gates.cycles === 0) { perLane[L.name] = { status: VERDICT.INCONCLUSIVE, cycles: 0, notRun: true }; continue; }
            const c = L.gates.compute({ smoke: cfg.smoke });
            computed.push(c);
            perLane[L.name] = {
                status: c.status, cycles: c.cycles, postWarmup: c.postWarmup, totals: c.totals, failureCounts: c.failureCounts,
                scenarioMissing: c.scenarioMissing, drift: c.drift, retention: c.retention, causes: c.causes.map((x) => x.line),
            };
        }
        for (const s of skipped) perLane[s.lane] = { status: 'SKIP', missingCaps: s.missingCaps };
        const v = judgeRun({
            configError: null, engine: cfg.engine, lanes: computed, skipped, reason, forever: cfg.forever, smoke: cfg.smoke,
            fatal: fatalSeen, extraFail: breaches.size > 0,
        });
        const gateBreaches = [];
        for (const b of v.breaches) {
            gateBreaches.push(b);
            protocol('soak: BREACH gate=' + b.gate + ' lane=' + b.lane + ' detail=' + b.detail);
        }
        const inconclusive = v.causes.map((c) => c.line);
        for (const line of inconclusive) protocol(line);
        const tot = runTotals.toJSON();
        const checks = {}, skips = {};
        for (const o of CHECK_NAMES) checks[o] = tot['checks.' + o];
        for (const o of SKIP_NAMES) skips[o] = tot['skipTainted.' + o];
        writeRecord(stream, 'summary', {
            reason, cyclesRun, lanesRun: computed.length,
            totals: { worlds: tot.worlds, ops: tot.ops, checks, skipTainted: skips, failingWorlds: tot.failingWorlds },
            perLane,
            breaches: breaches.entries.concat(gateBreaches),
            inconclusive, skipped, smoke: cfg.smoke,
            verdict: v.verdict, exitCode: v.exitCode,
        });
        return v;
    };
    const fatal = installFatalHandlers(stream, () => ctx, summarize);

    let stopReason = null;
    const onSignal = (sig) => {
        if (stopReason !== null) return;
        stopReason = 'signal';
        protocol('soak: NOTE -- ' + sig + ' received; closing the current lane-cycle, then the summary');
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    try {
        writeRecord(stream, 'header', header);
        const tracker = createLeakTracker({ name: 'soak' });
        const profiler = new GcProfiler().start();
        const rssSampler = new RssSampler();   // one per run (two Float64Array(RSS_BUF)); reset per lane-cycle
        let lastBeat = performance.now();
        const limit = cfg.forever ? CYCLES_MAX : cfg.cycles;

        outer:
        for (let cycle = 0; cycle < limit; cycle++) {
            for (const L of run) {
                if (stopReason !== null) break outer;
                const desc = L.desc;
                const cycleSeed = seedFor(cfg.seed, desc.index, cycle);
                const covOff = cfg.mustFail !== null && own(desc.covOff, cfg.mustFail.scenario) ? cfg.mustFail.scenario : null;
                const ct = new Totals(['worlds', 'largeWorlds', 'ops', 'failingWorlds'].concat(CHECK_NAMES.map((o) => 'c.' + o), SKIP_NAMES.map((o) => 's.' + o)));
                const opsByClass = new Totals([]);
                const scen = new Totals([]);
                const gateHits = new Totals([]);
                const failureCounts = new Totals([]);
                const failures = [];
                let witness = [];
                let tracked = 0;
                const tap = {
                    escape: null,
                    onOpen(w) {
                        const reg = w.registry;
                        if (reg === null || (typeof reg !== 'object' && typeof reg !== 'function')) throw new TypeError('main: the world has no registry to track');
                        tracker.track(reg, null, L.name);
                        witness.push(new WeakRef(reg));
                        tracked++;
                    },
                };
                const ad = tapAdapter(adapter, tap);
                ctx.lane = L.name; ctx.cycle = cycle;
                const tc = performance.now();
                let w = 0;
                let script = null, r = null;
                rssSampler.reset();
                while (ct.get('ops') < cfg.ops && stopReason === null) {
                    if ((w & YIELD_MASK) === YIELD_MASK) {
                        await tick();
                        if (performance.now() - lastBeat >= HEARTBEAT_MS) {
                            lastBeat = performance.now();
                            stdoutLine('soak: HEARTBEAT lane=' + L.name + ' cycle=' + cycle + ' worlds=' + w + ' ops=' + ct.get('ops') + ' tS=' + r1((lastBeat - t0) / 1000));
                        }
                        if (stopReason !== null) break;
                    }
                    const ws = worldSeed(cycleSeed, w);
                    const large = isLargeWorld(desc, w);
                    ctx.world = w; ctx.worldSeed = ws;
                    script = generateWorld(desc, ws, { large, covOff });
                    tap.escape = null;
                    r = runWorld(ad, script);
                    ct.add('worlds', 1);
                    if (large) ct.add('largeWorlds', 1);
                    ct.add('ops', r.ops);
                    for (const k of Object.keys(r.opsByClass)) { opsByClass.ensure(k); opsByClass.add(k, r.opsByClass[k]); }
                    for (const o of CHECK_NAMES) ct.add('c.' + o, r.checks[o]);
                    for (const o of SKIP_NAMES) ct.add('s.' + o, r.skipTainted[o]);
                    for (const k of Object.keys(r.scen)) { scen.ensure(k); scen.add(k, r.scen[k]); }
                    for (const k of Object.keys(r.gateHits)) { gateHits.ensure(k); gateHits.add(k, r.gateHits[k]); }
                    if (r.failure !== null) {
                        ct.add('failingWorlds', 1);
                        const rec = failureRecord(r, { engine: adapter.name, lane: L.name, cycle, world: w, worldSeed: ws, escape: tap.escape });
                        for (const k of familyKeys(rec.fails)) { failureCounts.ensure(k); failureCounts.add(k, 1); }
                        if (failures.length < FAIL_CAP) failures.push(rec);
                        breaches.noteWorld(rec, L.name, adapter.name);
                    }
                    rssSampler.push(process.memoryUsage.rss() / MB);
                    w++;
                }
                const wallMs = performance.now() - tc;
                const interrupted = ct.get('ops') < cfg.ops;   // a signal stopped it short of SOAK_OPS
                ctx.world = null; ctx.worldSeed = null;
                const witnessed = witness.length;
                const closed = await closeBoundary({
                    tracker, witness, profiler,
                    dropRefs: () => { script = null; r = null; },
                });
                witness = null;
                const ops = ct.get('ops');
                // A FRESH boundary object per lane-cycle, bound to it (lane, cycle). Retention is measured only
                // when every world of the cycle was tracked AND witnessed; otherwise trackerSize / weakAlive
                // are null = UNMEASURED, which FAILs retention (gates.mjs boundaryState; amendment 13).
                const worldsRun = ct.get('worlds');
                const cb = closed.boundary;
                const measured = tracked === worldsRun && witnessed === worldsRun && Number.isSafeInteger(cb.trackerSize) && Number.isSafeInteger(cb.weakAlive);
                const boundary = {
                    lane: L.name, cycle, worlds: worldsRun, tracked, witnessed,
                    trackerSize: measured ? cb.trackerSize : null, weakAlive: measured ? cb.weakAlive : null,
                    forcedGcTries: cb.forcedGcTries, drainMs: cb.drainMs, heapSampledAfterGc: cb.heapSampledAfterGc,
                };
                if (!measured) protocol('soak: NOTE -- boundary lane=' + L.name + ' cycle=' + cycle + ' UNMEASURED: worlds=' + worldsRun + ' tracked=' + tracked + ' witnessed=' + witnessed);
                const checks = {}, skipTainted = {};
                for (const o of CHECK_NAMES) checks[o] = ct.get('c.' + o);
                for (const o of SKIP_NAMES) skipTainted[o] = ct.get('s.' + o);
                const rec = {
                    lane: L.name, laneIndex: desc.index, cycle, warmup: cycle < WARMUP_CYCLES, seed: cycleSeed, interrupted,
                    worlds: ct.get('worlds'), largeWorlds: ct.get('largeWorlds'), ops, opsByClass: opsByClass.toJSON(),
                    checks, skipTainted,
                    failures, failureCounts: failureCounts.toJSON(), failingWorlds: ct.get('failingWorlds'),
                    scenarios: scen.toJSON(), gateHits: gateHits.toJSON(),
                    throughput: { wallMs: r1(wallMs), opsPerSec: wallMs > 0 ? Math.round(ops / (wallMs / 1000)) : null },
                    memory: closed.memory,
                    rss: { samples: rssSampler.count, p95MB: r3(rssSampler.p95()), maxMB: r3(rssSampler.max()), stride: rssSampler.stride },
                    boundary,
                    gc: closed.gc,
                };
                writeRecord(stream, 'cycle', rec);
                cyclesRun++;
                L.gates.push(rec);
                runTotals.add('worlds', rec.worlds);
                runTotals.add('ops', ops);
                runTotals.add('failingWorlds', rec.failingWorlds);
                for (const o of CHECK_NAMES) runTotals.add('checks.' + o, checks[o]);
                for (const o of SKIP_NAMES) runTotals.add('skipTainted.' + o, skipTainted[o]);
                lastBeat = performance.now();
                stdoutLine('soak: HEARTBEAT lane=' + L.name + ' cycle=' + cycle + ' worlds=' + rec.worlds + ' ops=' + ops + ' failingWorlds=' + rec.failingWorlds +
                    ' trackerSize=' + rec.boundary.trackerSize + ' weakAlive=' + rec.boundary.weakAlive + ' residentMB=' + rec.memory.residentMB + ' tS=' + r1((lastBeat - t0) / 1000));
            }
        }
        profiler.stop();
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        // inside the try: a throw while judging or summarizing is a fatal (fatal record, summary, CRASH,
        // END FAIL exit=1), never a bare entry-level crash without a sentinel
        const v = summarize(stopReason !== null ? stopReason : 'end');
        endLine(v.verdict === null ? 'null' : v.verdict, v.exitCode, stream.seq);
        process.exit(v.exitCode);
    } catch (e) {
        fatal('mainRejection', e);
    }
}

/** Run main() only when this file is the process entry (tests import the helpers above). */
function isEntry() {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntry()) {
    main().catch((e) => {
        protocol('soak: CRASH -- mainRejection before the stream opened: ' + (e && e.stack ? e.stack : String(e)));
        process.exit(1);
    });
}
