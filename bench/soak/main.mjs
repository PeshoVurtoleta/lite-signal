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
 * cycle: identity, volume, checks, skipTainted, failures, scenarios, throughput, memory, rss, latency, anatomy, boundary, gc.
 * rss (B-B3): one RssSampler (rss.mjs) per run, reset per lane-cycle, fed process.memoryUsage.rss() in MB at every
 * world end (before the boundary drain): {samples (stored count), p95MB, maxMB, stride}; gates.mjs rssRule reads
 * the post-warm-up p95MB values. Cold: <= 1 transient boxed double per world (the MB value passed to push).
 * latency (B-B4a, REPORT-ONLY): one LatencyLane (latency.mjs) per run, built from the header's timerFloorNs, its
 * wrapped adapter composed once under tapAdapter; reset per lane-cycle; armed on worlds (w & 15) === 8 only,
 * disarmed after the world loop and on the fatal path: {<LATENCY_METHODS entry>: {n, p50Ns, p99Ns, belowFloor}}.
 * Returning calls only (a throwing call is not timed); a null timerFloorNs leaves it disarmed (every n 0).
 * anatomy (B-B4b, REPORT-ONLY): engine lite only. ONE openAnatomy() lane per run (anatomy.mjs: the resolved kernel
 * instrumented with harness/visit-anchors.mjs and loaded as a SHADOW engine); unavailable (anchor drift, ...) or a
 * non-lite engine -> one run NOTE and anatomy null on every cycle. Worlds w % SHAPE_EVERY === 0 (16; disjoint from the
 * latency worlds) re-run a FRESH generateWorld() of the same world on the shadow, after the world's rss sample; the
 * shadow registries go into the same tracker under tag <lane>/anatomy with their OWN witness list and count (the
 * boundary drains both; measured also needs every shadow registry witnessed). Reset per lane-cycle:
 * {worlds, counts: {<visit-anchors NAMES>}, markDedupe} | null (+ one per-cycle NOTE with the why: divergent,
 * overflow, shadow threw, nothing folded).
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
 * `soak: END verdict=<V> exit=<N> records=<R>` as the LAST line. A config error (and a SKIP on a lite-family engine:
 * lite, lite-box) is verdict null: exit 2 with one `soak: CONFIG --` line, no record, no END line.
 *
 * Engines (R7 B2): loadAdapter('name[/mode]') maps an engine spec onto its adapter (ADAPTERS); SOAK_ENGINE picks the
 * primary. A TWIN lane (desc.twin, lanes/box.mjs) plays every world on the primary AND its contract.mjs TWINS twin
 * (twin.mjs runWorldTwin, the OT trace oracle). The twin's registries go into the same tracker under <lane>/twin with
 * their OWN witness list and count (twinTracked); no latency wrapper and no anatomy shape on a twin lane (C-11: the
 * anatomy lane stays lite-only). A pair run opens one world per side and runWorldTwin re-runs the pair once when the
 * traces differ, so a world opens 1 + (an OT fail ? 1 : 0) worlds per side: retention is measured only when the
 * primary AND the twin tracked + witnessed exactly that many. SOAK_MUSTFAIL=box-untracked builds the TWIN with
 * {broken: 'box-untracked'} (the primary stays clean); on a run whose selected lanes include no twin lane it is exit 2
 * (mustFailRefusal: "not supported on the selected lanes"). A SNAPSHOT world (R8-22) also opens one primary world per
 * successful restore (opensOf: + its own snap-restore count), so its expected tracked + witnessed count is 1 + that.
 *
 * Signals: SIGINT / SIGTERM finish the current lane-cycle early (its record is marked interrupted, its
 * boundary still runs), then write the summary with reason 'signal' -> INCONCLUSIVE (exit 3), or FAIL when
 * a failure was already seen. Worlds yield one macrotask every 64 worlds so a signal is seen.
 *
 * SOAK_REPLAY / SOAK_SHRINK only DISPATCH to replay.mjs / shrink.mjs (S1c batch B4); a missing module
 * exits 2 (fail closed: a replay request never runs a burn-in in its place).
 *
 * Kernel-free on import: the kernel (kernel.mjs, SOAK_KERNEL seam) loads only inside main(), so tests can
 * import tapAdapter / BreachLog / failureRecord without loading any Signal.js. latency.mjs (and its devDep
 * @zakkster/lite-sketch) also loads only inside main(), after the SOAK_REPLAY / SOAK_SHRINK dispatch.
 *
 * COLD module: no hot body. Run totals live in gates.mjs Totals (Float64Array slots, exact to 2^53).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    readConfig, configExit, formatReplayKey, CYCLES_MAX, WARMUP_CYCLES, FAIL_CAP, DETAIL_MAX, VERDICT, SKETCH_ALPHA, SHAPE_EVERY,
} from './config.mjs';
import {
    GATES, Totals, LaneGates, judgeRun, verdict as runVerdict, oracleFamily, totalsRule,
} from './gates.mjs';
import { RssSampler } from './rss.mjs';
import { classify, digest, REGISTRY_URL, REGISTRY_PROBLEMS } from './divergences.mjs';
import { CHECK_NAMES, SKIP_NAMES, runWorld } from './exec.mjs';
import { runWorldTwin } from './twin.mjs';
import { generateWorld, GEN_RULES } from './gen.mjs';
import { seedFor, worldSeed, selfCheckSeeds } from './seeds.mjs';
import { ROSTER, ALL_SCENARIOS, COV_OFF_SUPPORTED, laneByName, isLargeWorld, laneSpan } from './lanes/index.mjs';
import { openStream, writeRecord, protocol, stdoutLine, endLine, installFatalHandlers, defaultOutPath } from './jsonl.mjs';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const YIELD_MASK = 63;            // yield one macrotask every 64 worlds
const HEARTBEAT_MS = 5000;        // in-cycle heartbeat period (a heartbeat also closes every lane-cycle)
const SEED_SELF_CHECK_SPAN = 1024;
/** Engine name -> its adapter module (SOAK_ENGINE, and the name half of a contract.mjs TWINS spec). */
export const ADAPTERS = Object.freeze({ lite: './adapters/lite-s3.mjs', 'lite-box': './adapters/lite-box.mjs' });

/* ---- engines and twins ---------------------------------------------------------------------------- */

/**
 * Load the adapter of an engine spec 'name[/mode]' (kernel.mjs, the SOAK_KERNEL seam, loads here):
 *   'lite'                   adapters/lite-s3.mjs liteS3Adapter (no mode, no opts)
 *   'lite-box[/<mode>]'      adapters/lite-box.mjs liteBoxAdapterFor(K, mode, opts); a bare 'lite-box' is the
 *                            liteBoxAdapter itself (mode 'all', the SOAK_ENGINE=lite-box primary)
 * opts: undefined, or { broken: 'box-untracked' } (lite-box only; liteBoxAdapterFor validates it and the mode).
 * Throws TypeError on anything else -- a non-string spec, an empty name or mode, a second '/', a name with no adapter,
 * a mode or opts on lite, an unknown lite-box mode: fail closed, never a default engine.
 */
export async function loadAdapter(spec, opts) {
    if (typeof spec !== 'string') throw new TypeError('loadAdapter: spec must be a string name[/mode], got ' + typeof spec);
    const parts = spec.split('/');
    if (parts.length > 2 || parts[0] === '' || parts[parts.length - 1] === '') throw new TypeError("loadAdapter: malformed engine spec '" + spec + "' (expected name[/mode])");
    const name = parts[0];
    if (!own(ADAPTERS, name)) throw new TypeError("loadAdapter: no adapter for engine '" + name + "' (have: " + Object.keys(ADAPTERS).join(', ') + ')');
    if (name === 'lite') {
        if (parts.length === 2) throw new TypeError("loadAdapter: engine lite takes no mode (got '" + spec + "')");
        if (opts !== undefined) throw new TypeError('loadAdapter: engine lite takes no opts (the {broken} control is lite-box only)');
        return (await import(ADAPTERS.lite)).liteS3Adapter;
    }
    // ADAPTERS is frozen with exactly two names: this is lite-box
    const mod = await import(ADAPTERS[name]);
    const { K } = await import('./kernel.mjs');
    return mod.liteBoxAdapterFor(K, parts.length === 2 ? parts[1] : 'all', opts);
}

/**
 * The twin adapter opts for a config mustFail (config.mjs parseConfig): { broken: 'box-untracked' } for
 * SOAK_MUSTFAIL=box-untracked, undefined for none or cov-off (a generator switch, not an adapter option).
 * TypeError on a mustFail that is not null / undefined / an object with a known mode (fail closed).
 */
export function twinOptsFor(mustFail) {
    if (mustFail === null || mustFail === undefined) return undefined;
    if (typeof mustFail !== 'object') throw new TypeError('twinOptsFor: mustFail must be null or a parseConfig() mustFail object');
    if (mustFail.mode === 'box-untracked') return { broken: 'box-untracked' };
    if (mustFail.mode === 'cov-off') return undefined;
    throw new TypeError('twinOptsFor: unknown mustFail mode ' + JSON.stringify(String(mustFail.mode)));
}

/**
 * Load the twin of engine (contract.mjs TWINS[engine]), built with twinOptsFor(mustFail): the box-untracked control
 * breaks the TWIN, never the primary. TypeError when engine has no own TWINS entry.
 */
export async function loadTwin(engine, mustFail) {
    const { TWINS } = await import('./adapters/contract.mjs');
    if (typeof engine !== 'string' || !own(TWINS, engine)) throw new TypeError('loadTwin: engine ' + String(engine) + ' has no twin (contract.mjs TWINS)');
    return loadAdapter(TWINS[engine], twinOptsFor(mustFail));
}

/**
 * SOAK_MUSTFAIL=box-untracked breaks the twin, so it needs a twin lane: the CONFIG message (config.mjs cov-off
 * wording) when no descriptor in descs has twin === true, else null. Any other mustFail -> null.
 */
export function mustFailRefusal(mustFail, descs) {
    if (mustFail === null || mustFail === undefined || mustFail.mode !== 'box-untracked') return null;
    for (const d of descs) if (d !== null && typeof d === 'object' && d.twin === true) return null;
    return 'SOAK_MUSTFAIL: box-untracked is not supported on the selected lanes ' + descs.map((d) => (d !== null && typeof d === 'object' ? d.name : String(d))).join(',') +
        ' (none of them is a twin lane)';
}

/**
 * One world of lane desc: exec.mjs runWorld on ad, or (desc.twin) twin.mjs runWorldTwin on ad + tad. TypeError on a
 * twin lane with no twin adapter (tad null): a twin lane never runs single-sided.
 */
export function runLaneWorld(desc, ad, tad, script) {
    if (desc === null || typeof desc !== 'object') throw new TypeError('runLaneWorld: desc must be a lane descriptor');
    if (desc.twin !== true) return runWorld(ad, script);
    if (tad === null || tad === undefined) throw new TypeError('runLaneWorld: twin lane ' + desc.name + ' has no twin adapter');
    return runWorldTwin(desc, ad, tad, script);
}

/**
 * The twin's tap for one lane-cycle: { ad, tap }. ad = tapAdapter(twinAd, tap); every twin world it opens is tracked
 * in tracker under <lane>/twin and witnessed in tap.witness (its OWN list; main concatenates it into closeBoundary),
 * tap.tracked counts them. A twin world with no registry throws TypeError (as the primary tap).
 */
export function openTwinTap(tracker, lane, twinAd) {
    const tap = {
        escape: null,
        witness: [],
        tracked: 0,
        onOpen(tw) {
            const reg = tw.registry;
            if (reg === null || (typeof reg !== 'object' && typeof reg !== 'function')) throw new TypeError('main: the twin world has no registry to track');
            tracker.track(reg, null, lane + '/twin');
            tap.witness.push(new WeakRef(reg));
            tap.tracked++;
        },
    };
    return { ad: tapAdapter(twinAd, tap), tap };
}

/**
 * Worlds a lane world opened per side (the EXPECTED tracked / witnessed count; never read from the tap): 1, plus the
 * twin re-run (twin.mjs) when the result carries an OT fail, plus one per SNAPSHOT restore (R8-22, C0 finding): every
 * successful restore opens one more world through the tapped adapter (lanes/snapshot.mjs opRest x.ad.open({ from })).
 * The restore count is the lane's own per-world record r.scen['snap-restore'] (scenarios.mjs onSnap 'rest'): it is
 * counted once per rest whose open() RETURNED, after the swap, and never when open() throws (opRest returns before
 * onSnap; the tap's onOpen never ran either, tapAdapter calls it after adapter.open returns). An absent key = no rest
 * ran (D.counts keeps no zero entries; only lanes/snapshot.mjs counts it). A present count that is not a safe integer
 * >= 1, or a restore on a twin lane (unmodelled: its twin re-run would open restores on the twin side too), returns
 * NaN: tracked === opens fails -> UNMEASURED -> retention FAIL (fail closed).
 */
function opensOf(desc, r) {
    let n = 1;
    if (desc.twin === true && r.failure !== null) {
        const fs = r.failure.fails;
        for (let i = 0; i < fs.length; i++) if (fs[i].oracle === 'OT') { n = 2; break; }
    }
    const sc = r.scen;
    if (sc === null || typeof sc !== 'object') return NaN;
    if (!Object.prototype.hasOwnProperty.call(sc, 'snap-restore')) return n;
    const k = sc['snap-restore'];
    if (!(Number.isSafeInteger(k) && k >= 1) || desc.twin === true) return NaN;
    return n + k;
}

/* ---- the adapter tap ------------------------------------------------------------------------------ */

/**
 * Wrap an adapter so main sees every world it opens. tap = { onOpen(world) } is called with the world the wrapped
 * adapter's open() returns: the RAW world, or on an armed latency world (main composes tapAdapter(lat.wrap(adapter),
 * tap)) the latency delegate, which carries the same registry object (main tracks world.registry in the leak
 * tracker and a WeakRef witness). The returned adapter's worlds
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
 * ctx { engine, lane, cycle, world, worldSeed, escape (tap.escape), kernelKnownAs? }. kernelKnownAs (optional OWN key; b103
 * F-b103-1): the kernel's controls.json name or null, as kernel.mjs KERNEL_KNOWN_AS reports it (replay.mjs passes it);
 * absent = this main run's own identity. Anything but null or a non-empty string throws TypeError (fail closed). classify() is the divergence
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
    const knownAs = Object.prototype.hasOwnProperty.call(ctx, 'kernelKnownAs') ? ctx.kernelKnownAs : kernelKnownAs;
    if (knownAs !== null && (typeof knownAs !== 'string' || knownAs === '')) throw new TypeError('failureRecord: ctx.kernelKnownAs must be null or a controls.json kernel name');
    const cls = classify(crec, { includeFixed: knownAs !== null });
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
    const mfRefusal = mustFailRefusal(cfg.mustFail, cfg.lanes.map(laneByName));
    if (mfRefusal !== null) configExit(mfRefusal);

    // startup gates (kind 'startup', gates.mjs) and self-checks: red -> exit 2 before any record
    for (const g of GATES) {
        if (g.kind !== 'startup') continue;
        const res = g.id === 'totals' ? totalsRule(Totals) : null;
        if (res === null) configExit('startup gate ' + g.id + ' has no runner in main.mjs');
        if (res.verdict !== VERDICT.PASS) configExit('startup gate ' + g.id + ' is red: ' + JSON.stringify(res));
    }
    // the INDEX span (S3 R1), a superset of the rostered indices: the scan fails closed on any pair inside it
    const seedProblem = selfCheckSeeds(cfg.seed, laneSpan(cfg.roster), cfg.forever ? SEED_SELF_CHECK_SPAN : Math.min(cfg.cycles, SEED_SELF_CHECK_SPAN));
    if (seedProblem !== null) configExit('seed self-check: ' + seedProblem);
    if (REGISTRY_PROBLEMS.length > 0) configExit('divergences.json is invalid: ' + REGISTRY_PROBLEMS[0]);
    const divDigest = digest(readFileSync(REGISTRY_URL, 'utf8'));

    // the engine (the kernel loads HERE, through the SOAK_KERNEL seam)
    if (!own(ADAPTERS, cfg.engine)) configExit('SOAK_ENGINE: no adapter for ' + cfg.engine);
    const adapter = await loadAdapter(cfg.engine);
    const { validateAdapter, applicability } = await import('./adapters/contract.mjs');
    const probs = validateAdapter(adapter);
    if (probs.length > 0) configExit('adapter ' + cfg.engine + ' is invalid: ' + probs.join('; '));
    // the latency lane (B-B4a) loads HERE, after the replay / shrink dispatch: replay.mjs and shrink.mjs import this
    // module's helpers and never load latency.mjs or its devDep. A missing / wrong lite-sketch is exit 2, no record.
    let LatencyLane = null;
    try {
        ({ LatencyLane } = await import('./latency.mjs'));
    } catch (e) {
        configExit('latency lane unavailable (bench/soak/latency.mjs needs the exact devDep @zakkster/lite-sketch 1.2.0; npm ci): ' +
            String(e && e.message ? e.message : e).split('\n')[0]);
    }
    // the anatomy lane (B-B4b) loads here too (lite only; anatomy.mjs imports kernel.mjs + the lite adapter): a module
    // that fails to load is exit 2, no record. An instrumentation that fails is NOT: openAnatomy() reports it (NOTE).
    let openAnatomy = null;
    if (cfg.engine === 'lite') {
        try {
            ({ openAnatomy } = await import('./anatomy.mjs'));
        } catch (e) {
            configExit('anatomy lane unavailable (bench/soak/anatomy.mjs failed to load): ' + String(e && e.message ? e.message : e).split('\n')[0]);
        }
    }

    // applicability (SPEC 3.3): a lite SKIP or a requested lane that would SKIP is exit 2
    const lanesHdr = [], scenHdr = {}, naHdr = {}, skipped = [], run = [];
    for (const name of cfg.lanes) {
        const desc = laneByName(name);
        const app = applicability(desc, adapter.caps, cfg.engine);
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
    // the twin (R7 C-3): loaded only when a lane that runs is a twin lane (applicability skipped every twin lane of an
    // engine with no TWINS entry); SOAK_MUSTFAIL=box-untracked breaks it (twinOptsFor), never the primary
    let twinAd = null;
    if (run.some((L) => L.desc.twin === true)) {
        twinAd = await loadTwin(cfg.engine, cfg.mustFail);
        const tprobs = validateAdapter(twinAd);
        if (tprobs.length > 0) configExit('twin adapter of ' + cfg.engine + ' is invalid: ' + tprobs.join('; '));
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

    let lat = null;
    try {
        writeRecord(stream, 'header', header);
        // latency (B-B4a): ONE lane + ONE wrapped adapter per run. failureRecord / breaches keep adapter.name.
        lat = new LatencyLane({ floorNs: header.timerFloorNs });
        const latAdapter = lat.wrap(adapter);
        protocol(header.timerFloorNs === null
            ? 'soak: NOTE -- latency UNMEASURED: timerFloorNs null'
            : 'soak: NOTE -- latency report-only: worlds w%16=8, alpha=' + SKETCH_ALPHA + ', floorNs=' + header.timerFloorNs + ', returning calls only');
        // anatomy (B-B4b): ONE shadow lane per run; null = every cycle's anatomy is null (the NOTE says why)
        let anat = null;
        if (openAnatomy === null) {
            protocol('soak: NOTE -- anatomy n/a: engine=' + cfg.engine + ' (the lite kernel only)');
        } else {
            const an = openAnatomy();
            anat = an.lane;
            protocol(anat === null
                ? 'soak: NOTE -- ' + an.why
                : 'soak: NOTE -- anatomy report-only: worlds w%' + SHAPE_EVERY + '=0 re-run on a counter-instrumented shadow engine');
        }
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
                const ad = tapAdapter(latAdapter, tap);
                // the shadow registries: same tracker, their OWN witness list and count (tracked === opens stays the oracle's)
                let sWitness = [];
                const stap = {
                    escape: null,
                    onOpen(sw) {
                        const reg = sw.registry;
                        if (reg === null || (typeof reg !== 'object' && typeof reg !== 'function')) throw new TypeError('main: the shadow world has no registry to track');
                        tracker.track(reg, null, L.name + '/anatomy');
                        sWitness.push(new WeakRef(reg));
                    },
                };
                const sad = anat === null ? null : tapAdapter(anat.adapter, stap);
                // the twin registries (twin lanes only): same tracker, their OWN witness list and count (openTwinTap)
                const tw = desc.twin === true ? openTwinTap(tracker, L.name, twinAd) : null;
                let opens = 0;   // worlds opened per side (opensOf): the tracked / witnessed / twinTracked target
                ctx.lane = L.name; ctx.cycle = cycle;
                const tc = performance.now();
                let w = 0;
                let script = null, r = null;
                rssSampler.reset();
                lat.reset();
                if (anat !== null) anat.reset();
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
                    lat.armed = (w & 15) === 8;
                    r = runLaneWorld(desc, ad, tw === null ? null : tw.ad, script);
                    opens += opensOf(desc, r);
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
                    if (sad !== null && tw === null && w % SHAPE_EVERY === 0) anat.shape(sad, generateWorld(desc, ws, { large, covOff }), r);
                    w++;
                }
                lat.armed = false;
                const wallMs = performance.now() - tc;
                const interrupted = ct.get('ops') < cfg.ops;   // a signal stopped it short of SOAK_OPS
                ctx.world = null; ctx.worldSeed = null;
                const witnessed = witness.length;
                const closed = await closeBoundary({
                    tracker, witness: tw === null ? witness.concat(sWitness) : witness.concat(sWitness, tw.tap.witness), profiler,
                    dropRefs: () => { script = null; r = null; },
                });
                witness = null;
                sWitness = null;
                const twinTracked = tw === null ? null : tw.tap.tracked;
                const twinWitnessed = tw === null ? null : tw.tap.witness.length;
                if (tw !== null) tw.tap.witness = null;
                const ops = ct.get('ops');
                // A FRESH boundary object per lane-cycle, bound to it (lane, cycle). Retention is measured only
                // when every world of the cycle was tracked AND witnessed; otherwise trackerSize / weakAlive
                // are null = UNMEASURED, which FAILs retention (gates.mjs boundaryState; amendment 13). The shadow
                // registries need no count conjunct: one stap.onOpen tracks AND witnesses each (a count check was a
                // tautology); a leaked shadow registry is caught by retention (test/40 row E, 'main: SHADOWLEAK').
                const worldsRun = ct.get('worlds');
                const cb = closed.boundary;
                // opens === worldsRun on every non-twin lane but SNAPSHOT (+ its restore opens, opensOf); a twin lane also needs
                // twinTracked === twinWitnessed === opens
                const twinOk = tw === null || (twinTracked === opens && twinWitnessed === opens);
                const measured = tracked === opens && witnessed === opens && twinOk && Number.isSafeInteger(cb.trackerSize) && Number.isSafeInteger(cb.weakAlive);
                const boundary = {
                    lane: L.name, cycle, worlds: worldsRun, tracked, witnessed,
                    trackerSize: measured ? cb.trackerSize : null, weakAlive: measured ? cb.weakAlive : null,
                    forcedGcTries: cb.forcedGcTries, drainMs: cb.drainMs, heapSampledAfterGc: cb.heapSampledAfterGc,
                };
                if (!measured) protocol('soak: NOTE -- boundary lane=' + L.name + ' cycle=' + cycle + ' UNMEASURED: worlds=' + worldsRun + ' tracked=' + tracked + ' witnessed=' + witnessed +
                    (tw === null ? '' : ' opens=' + opens + ' twinTracked=' + twinTracked + ' twinWitnessed=' + twinWitnessed));
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
                    latency: lat.toJSON(),
                    anatomy: anat === null ? null : anat.toJSON(),
                    boundary,
                    gc: closed.gc,
                };
                if (anat !== null && rec.anatomy === null) protocol('soak: NOTE -- anatomy lane=' + L.name + ' cycle=' + cycle + ' null: ' + anat.why);
                // T-mark (_mustfail.mjs) reads this line; report-only, the stream record is unchanged. null prints null.
                else if (rec.anatomy !== null) protocol('soak: NOTE -- shape[' + L.name + '] markDedupe=' + (rec.anatomy.markDedupe === null ? 'null' : rec.anatomy.markDedupe.toFixed(3)) + ' cycle=' + cycle + ' worlds=' + rec.anatomy.worlds);
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
        if (lat !== null) lat.armed = false;
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
