/**
 * @zakkster/lite-signal soak -- REPLAY one world of a burn-in (SPEC-B v2 sections 7, 8; S1c TASK 7).
 *
 *   SOAK_REPLAY=<LANE>:<cycle>:0x<seed> node --expose-gc bench/soak/replay.mjs     (npm run soak:replay)
 *   SOAK_REPLAY=... node --expose-gc bench/soak/main.mjs                            (main dispatches here)
 *
 * A replay key names a WORLD SEED, not a world index. The index is SOLVED, never scanned: seeds.mjs
 * findWorldIndex inverts worldSeed() in O(1) for world indices below a bound, then the key is checked for
 * REACHABILITY: the world is replayed only if the burn-in under THIS config (SOAK_SEED, SOAK_OPS,
 * SOAK_MUSTFAIL, the kernel) would really have played it. Anything else is `soak: CONFIG -- ...`, exit 2,
 * and no record: a replay request never plays a different world, and never runs a burn-in in its place.
 *
 * The bound (why `max` = SOAK_OPS). main.mjs plays world w of a lane-cycle only while the lane-cycle's op
 * count is below SOAK_OPS, and adds r.ops (exec.mjs runWorld: opsRun, incremented BEFORE each op is
 * applied, so a world that fails at its first op still adds 1; every lane's init() pushes >= 6 ops, so no
 * script is empty). Every played world therefore adds >= 1 op: when world w starts, ops >= w, and it
 * starts only if ops < SOAK_OPS, so w < SOAK_OPS. A world index >= SOAK_OPS is never played; findWorldIndex
 * is called with max = cfg.ops (<= OPS_MAX = 2^30 - 1, inside its [1, 2^32 - 1] domain).
 *
 * Reachability (exact). The index bound is necessary, not sufficient: worlds that fail stop early (exec
 * stops at the first failing op), so how many worlds a lane-cycle plays depends on the kernel. replay
 * FORWARD-PLAYS worlds 0..w-1 of the lane-cycle on the loaded kernel exactly as main does (same seeds,
 * large flags, cov-off, main.mjs tapAdapter with main's registry check; no retention tracking) and requires their ops sum to stay below SOAK_OPS; otherwise the
 * burn-in stops before world w -> unreachable, exit 2. Cost: at most ONE lane-cycle of burn-in (the loop
 * stops as soon as the sum reaches SOAK_OPS), i.e. what the burn-in itself paid to reach the key; no
 * generator-only shortcut is taken, so the prefix also warms the kernel as main's lane-cycle did. A forward
 * world that throws (a harness crash in the burn-in) also makes the key unreachable (exit 2).
 *
 * Other fail-closed checks: SOAK_LANES set explicitly without the key's lane; a fixed cycle count (smoke,
 * or SOAK_CYCLES set) that the key's cycle reaches; SOAK_WRAP / SOAK_REPR (S2 keys); a lane that would
 * SKIP on the engine; an invalid divergence registry. All exit 2 before any record.
 *
 * Stream (kind 'replay', jsonl.mjs): header (provenance.mjs, kind replay, REQUIRED_EXTRAS as main),
 * ONE replay record, summary. The replay record:
 *   {key, lane, laneIndex, cycle, seed, cycleSeed, world, worldSeed, large, covOff, worldsBefore, opsBefore,
 *    ops, scriptOps, genVersion, scriptDigest (sha256 of gen.mjs scriptJson), failure (main.mjs
 *    failureRecord) | null, familyKeys [`<family>:<sig>`], trace [op log, <= TRACE_MAX lines], traceTruncated}
 * stderr: one BREACH line per (family, sig) of a reproduced failure (main.mjs BreachLog format, no REPLAY
 * line). stdout: `soak: END verdict=<FAIL|PASS> exit=<1|0> records=3` as the last line.
 * Exit: 1 the world fails (the failure reproduced), 0 it runs clean, 2 config / unreachable, and a crash is
 * 1 (a crash is never PASS; SPEC 8). runReplay ALWAYS returns an integer 0..3 (asExitCode).
 *
 * Kernel-free on import: the adapter (and through it kernel.mjs and the SOAK_KERNEL seam) loads only inside
 * runReplay / runShrink, so tests import resolveReplay and the helpers without loading any Signal.js.
 *
 * COLD module: no hot body.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readConfig, configExit, formatReplayKey, ENGINES_AVAILABLE, VERDICT, EXIT_CODE } from './config.mjs';
import { tapAdapter, failureRecord, familyKeys, BreachLog } from './main.mjs';
import { seedFor, worldSeed, findWorldIndex } from './seeds.mjs';
import { generateWorld, scriptJson, GEN_VERSION, GEN_RULES } from './gen.mjs';
import { runWorld } from './exec.mjs';
import { ROSTER, ALL_SCENARIOS, COV_OFF_SUPPORTED, laneByName, isLargeWorld } from './lanes/index.mjs';
import { digest, REGISTRY_URL, REGISTRY_PROBLEMS } from './divergences.mjs';
import { openStream, writeRecord, writeFatal, protocol, endLine, defaultOutPath } from './jsonl.mjs';

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
export const TRACE_MAX = 4096;

/* ---- exit codes ----------------------------------------------------------------------------------- */

const isCode = (c) => Number.isInteger(c) && c >= 0 && c <= 3;

/** One `soak: CONFIG -- <msg>` line; returns exit code 2 (the caller returns it, never process.exit). */
export function configCode(msg) {
    protocol('soak: CONFIG -- ' + msg);
    return EXIT_CODE.CONFIG;
}

/**
 * Run fn() (sync or async) and ALWAYS resolve to an integer exit code 0..3. A throw, or a return value
 * that is not an integer 0..3, is a CRASH: one `soak: CRASH --` line and exit 1 (a crash is never PASS or
 * INCONCLUSIVE). onCrash(err) may write a fatal record first; its own throw is swallowed.
 */
export async function asExitCode(name, fn, onCrash) {
    let code;
    try {
        code = await fn();
    } catch (e) {
        try { if (typeof onCrash === 'function') onCrash(e); } catch (e2) { /* the CRASH line below still lands */ }
        protocol('soak: CRASH -- ' + name + ': ' + (e && e.stack ? e.stack : String(e)));
        return EXIT_CODE.FAIL;
    }
    if (!isCode(code)) {
        protocol('soak: CRASH -- ' + name + ' computed ' + String(code) + ' (expected an exit code 0..3)');
        return EXIT_CODE.FAIL;
    }
    return code;
}

/* ---- the key -> world (pure, kernel-free) --------------------------------------------------------- */

/** A cfg problem string, or null. cfg must be a parseConfig() result carrying a replay key. */
export function cfgProblem(cfg) {
    if (cfg === null || typeof cfg !== 'object') return 'replay: no config (expected a parseConfig() result)';
    const k = cfg.replay;
    if (k === null || typeof k !== 'object') return 'replay: SOAK_REPLAY=<LANE>:<cycle>:0x<seed> is required';
    if (typeof k.lane !== 'string' || !Number.isInteger(k.cycle) || k.cycle < 0 || !Number.isInteger(k.seed) || k.seed < 0 || k.seed > 0xFFFFFFFF) {
        return 'replay: malformed replay key (expected config.mjs parseReplayKey output)';
    }
    if (!(Number.isInteger(cfg.seed) && cfg.seed >= 0 && cfg.seed <= 0xFFFFFFFF)) return 'replay: SOAK_SEED is not a uint32';
    if (!(Number.isInteger(cfg.ops) && cfg.ops >= 1)) return 'replay: SOAK_OPS is not a positive integer';
    if (!Array.isArray(cfg.lanes) || cfg.record === null || typeof cfg.record !== 'object') return 'replay: config has no lanes / record (expected a parseConfig() result)';
    if (!own(cfg.record, 'SOAK_LANES') || !own(cfg.record, 'SOAK_CYCLES') || !own(cfg.record, 'SOAK_WRAP')) return 'replay: config record is incomplete';
    if (cfg.record.SOAK_WRAP.source !== 'default') return 'SOAK_WRAP is read by wrap.mjs (S2), not by a replay; unset it';
    if (cfg.repr === true) return 'SOAK_REPR is an S2 (wrap.mjs) lane, not a replay; unset it';
    return null;
}

const unreachable = (reason) => Object.freeze({ unreachable: true, reason });

/**
 * Resolve cfg.replay to the world main would have played, or a fail-closed {unreachable: true, reason}.
 * Pure and kernel-free; the ops-budget half of reachability needs the kernel (forwardReach).
 * Returns {unreachable: false, key, lane, laneIndex, cycle, cycleSeed, worldSeed, world, large, covOff, bound}.
 */
export function resolveReplay(cfg) {
    const p = cfgProblem(cfg);
    if (p !== null) return unreachable(p);
    const key = cfg.replay;
    const desc = laneByName(key.lane);
    if (desc === null) return unreachable('lane ' + key.lane + ' is not in the roster');
    if (cfg.record.SOAK_LANES.source !== 'default' && cfg.lanes.indexOf(key.lane) === -1) {
        return unreachable('SOAK_LANES=' + cfg.lanes.join(',') + ' does not select the key\'s lane ' + key.lane);
    }
    // a FIXED cycle count (smoke, or SOAK_CYCLES set) that the key's cycle reaches: that run never played it.
    // With the default count the key may come from a longer run, so only CYCLES_MAX (config) applies.
    const fixedCycles = cfg.smoke === true || cfg.record.SOAK_CYCLES.source !== 'default';
    if (fixedCycles && cfg.forever !== true && !(key.cycle < cfg.cycles)) {
        return unreachable('cycle ' + key.cycle + ' is past this run\'s ' + cfg.cycles + ' cycles (0..' + (cfg.cycles - 1) + ')');
    }
    const bound = cfg.ops;   // see the module header: a played world index is always < SOAK_OPS
    const w = findWorldIndex(cfg.seed, desc.index, key.cycle, key.seed, bound);
    if (w === -1) {
        return unreachable('no world index < ' + bound + ' (SOAK_OPS) of lane-cycle ' + key.lane + ':' + key.cycle +
            ' has world seed 0x' + key.seed.toString(16) + ' under SOAK_SEED=0x' + (cfg.seed >>> 0).toString(16));
    }
    const covOff = cfg.mustFail !== null && cfg.mustFail !== undefined && own(desc.covOff, cfg.mustFail.scenario) ? cfg.mustFail.scenario : null;
    return Object.freeze({
        unreachable: false,
        key: formatReplayKey(key.lane, key.cycle, key.seed),
        lane: key.lane, laneIndex: desc.index, cycle: key.cycle,
        cycleSeed: seedFor(cfg.seed, desc.index, key.cycle),
        worldSeed: key.seed, world: w, large: isLargeWorld(desc, w), covOff, bound,
    });
}

/** The script main generates for world w of the resolved lane-cycle. Pure. */
export function scriptFor(res, w) {
    const desc = laneByName(res.lane);
    return generateWorld(desc, worldSeed(res.cycleSeed, w), { large: isLargeWorld(desc, w), covOff: res.covOff });
}

/** sha256 of the canonical script JSON (gen.mjs scriptJson). */
export function scriptDigest(script) {
    return createHash('sha256').update(scriptJson(script)).digest('hex');
}

/* ---- the engine (kernel loads here) --------------------------------------------------------------- */

/**
 * Load and check the engine adapter for cfg.engine and the key's lane. Returns {adapter, app, error}; error
 * is a CONFIG message or null. Dynamic import: kernel.mjs reads SOAK_KERNEL here (and exits 2 itself on a
 * bad kernel path, before any record).
 */
// b103 F-b103-1: the loaded kernel's controls.json name (kernel.mjs KERNEL_KNOWN_AS) or null, set by loadEngine; recordOf
// passes it to failureRecord, so a replay on a named control kernel classifies with includeFixed exactly as main does.
let replayKnownAs = null;
export async function loadEngine(cfg, laneName) {
    if (cfg.engine !== 'lite' || ENGINES_AVAILABLE.indexOf(cfg.engine) === -1) return { adapter: null, app: null, error: 'SOAK_ENGINE: no adapter for ' + cfg.engine };
    const adMod = await import('./adapters/lite-s3.mjs');
    const adapter = adMod.liteS3Adapter;
    ({ KERNEL_KNOWN_AS: replayKnownAs } = await import('./kernel.mjs'));   // the adapter loaded it: no new load
    const { validateAdapter, applicability } = await import('./adapters/contract.mjs');
    const probs = validateAdapter(adapter);
    if (probs.length > 0) return { adapter: null, app: null, error: 'adapter ' + cfg.engine + ' is invalid: ' + probs.join('; ') };
    const app = applicability(laneByName(laneName), adapter.caps);
    if (app.status === 'skip') return { adapter: null, app, error: 'lane ' + laneName + ' needs cap ' + (app.missingCaps[0] || 'hardOracles') + ', absent on engine ' + cfg.engine };
    return { adapter, app, error: null };
}

/** A tapped adapter (main.mjs tapAdapter): main's onOpen registry check, no leak tracking (no retention). */
export function replayTap(adapter) {
    const tap = {
        escape: null,
        // main.mjs's onOpen check, without its leak tracker / WeakRef witness (replay measures no retention)
        onOpen(w) {
            const reg = w.registry;
            if (reg === null || (typeof reg !== 'object' && typeof reg !== 'function')) throw new TypeError('replay: the world has no registry to track (main.mjs throws here too)');
        },
    };
    return { tap, ad: tapAdapter(adapter, tap) };
}

/**
 * The ops-budget half of reachability (see the module header). Plays worlds 0..res.world-1 exactly as main
 * does and returns {reachable, worldsBefore, opsBefore, reason}.
 */
export function forwardReach(adapter, cfg, res) {
    const { tap, ad } = replayTap(adapter);
    let ops = 0;
    for (let w = 0; w < res.world; w++) {
        if (!(ops < cfg.ops)) {
            return { reachable: false, worldsBefore: w, opsBefore: ops, reason: 'the burn-in stops after world ' + (w - 1) + ' (' + ops + ' ops >= SOAK_OPS=' + cfg.ops + '); world ' + res.world + ' is past the ops budget' };
        }
        let r;
        try {
            const script = scriptFor(res, w);
            tap.escape = null;
            r = runWorld(ad, script);
        } catch (e) {
            return { reachable: false, worldsBefore: w, opsBefore: ops, reason: 'world ' + w + ' throws in the forward play (the burn-in crashes there): ' + String(e && e.message ? e.message : e).split('\n')[0] };
        }
        if (!(Number.isSafeInteger(r.ops) && r.ops >= 1)) {
            return { reachable: false, worldsBefore: w, opsBefore: ops, reason: 'world ' + w + ' reported ops=' + String(r.ops) + ' (expected an integer >= 1)' };
        }
        ops += r.ops;
    }
    if (!(ops < cfg.ops)) {
        return { reachable: false, worldsBefore: res.world, opsBefore: ops, reason: 'worlds 0..' + (res.world - 1) + ' already ran ' + ops + ' ops >= SOAK_OPS=' + cfg.ops + '; world ' + res.world + ' is past the ops budget' };
    }
    return { reachable: true, worldsBefore: res.world, opsBefore: ops, reason: null };
}

/** Play the resolved world once, through the tap, as main does. Returns {script, r, escape}. */
export function playWorld(adapter, res, opts) {
    const { tap, ad } = replayTap(adapter);
    const script = scriptFor(res, res.world);
    tap.escape = null;
    const r = runWorld(ad, script, opts);
    return { script, r, escape: tap.escape };
}

/** main.mjs failureRecord for the played world (null when it ran clean). */
export function recordOf(adapter, res, played) {
    if (played.r.failure === null) return null;
    return failureRecord(played.r, { engine: adapter.name, lane: res.lane, cycle: res.cycle, world: res.world, worldSeed: res.worldSeed, escape: played.escape, kernelKnownAs: replayKnownAs });
}

/** BREACH lines of a failure record (main.mjs BreachLog format), without BreachLog's REPLAY line. */
export function writeBreaches(rec, lane, engine) {
    const log = new BreachLog((line) => { if (line.indexOf('soak: REPLAY ') !== 0) protocol(line); });
    log.noteWorld(rec, lane, engine);
    return log.entries;
}

/** The provenance header extras for a single-lane run, mirroring main.mjs:280-285. */
export async function headerFor(cfg, adapter, app, laneName) {
    const desc = laneByName(laneName);
    const { buildHeader } = await import('./provenance.mjs');
    return buildHeader(cfg, {
        kind: 'replay',
        engine: { name: adapter.name, version: adapter.version(), caps: adapter.caps, files: adapter.files() },
        laneRoster: ROSTER.slice(),
        lanes: [{ name: laneName, status: app.status, missingCaps: app.missingCaps, engine: cfg.engine }],
        scenarios: { [laneName]: { required: app.requiredApplicable, optional: desc.optional.slice(), na: app.scenariosNA } },
        oraclesNA: { [laneName]: app.oraclesNA },
        genRules: GEN_RULES.slice(),
        divergences: digest(readFileSync(REGISTRY_URL, 'utf8')),
    });
}

/**
 * Resolve, load the engine, check reachability and play the world. Shared by runReplay and runShrink.
 * Returns {code} (2: a CONFIG line was written) or {code: null, res, adapter, app, reach, played, rec}.
 */
export async function locateAndPlay(cfg, opts) {
    const p = cfgProblem(cfg);
    if (p !== null) return { code: configCode(p) };
    if (REGISTRY_PROBLEMS.length > 0) return { code: configCode('divergences.json is invalid: ' + REGISTRY_PROBLEMS[0]) };
    const res = resolveReplay(cfg);
    if (res.unreachable) return { code: configCode('SOAK_REPLAY=' + keyText(cfg) + ' is unreachable: ' + res.reason) };
    const eng = await loadEngine(cfg, res.lane);
    if (eng.error !== null) return { code: configCode(eng.error) };
    const reach = forwardReach(eng.adapter, cfg, res);
    if (!reach.reachable) return { code: configCode('SOAK_REPLAY=' + res.key + ' is unreachable: ' + reach.reason) };
    const played = playWorld(eng.adapter, res, opts);
    const rec = recordOf(eng.adapter, res, played);
    return { code: null, res, adapter: eng.adapter, app: eng.app, reach, played, rec };
}

function keyText(cfg) {
    const k = cfg.replay;
    try { return formatReplayKey(k.lane, k.cycle, k.seed); } catch { return String(k && k.lane) + ':?'; }
}

/* ---- runReplay ------------------------------------------------------------------------------------ */

/** Replay cfg.replay. Always resolves to an integer exit code 0..3 (see the module header). */
export async function runReplay(cfg) {
    let stream = null;
    const onCrash = (e) => {
        if (stream === null || stream.summarized) return;
        writeFatal(stream, 'mainRejection', {}, e);
        writeRecord(stream, 'summary', { reason: 'fatal', verdict: VERDICT.FAIL, exitCode: EXIT_CODE.FAIL });
        endLine(VERDICT.FAIL, EXIT_CODE.FAIL, stream.seq);
    };
    return asExitCode('runReplay', async () => {
        const L = await locateAndPlay(cfg, { trace: true });
        if (L.code !== null) return L.code;
        const { res, adapter, app, reach, played, rec } = L;
        const header = await headerFor(cfg, adapter, app, res.lane);
        const t0 = performance.now();
        stream = openStream(cfg.out !== null ? cfg.out : defaultOutPath('replay', header.gitSha), t0, 'replay');
        writeRecord(stream, 'header', header);
        const keys = rec === null ? [] : familyKeys(rec.fails);
        const trace = Array.isArray(played.r.trace) ? played.r.trace : [];
        writeRecord(stream, 'replay', {
            key: res.key, lane: res.lane, laneIndex: res.laneIndex, cycle: res.cycle, seed: cfg.seed, cycleSeed: res.cycleSeed,
            world: res.world, worldSeed: res.worldSeed, large: res.large, covOff: res.covOff,
            worldsBefore: reach.worldsBefore, opsBefore: reach.opsBefore,
            ops: played.r.ops, scriptOps: played.script.ops.length, genVersion: GEN_VERSION, scriptDigest: scriptDigest(played.script),
            failure: rec, familyKeys: keys,
            trace: trace.slice(0, TRACE_MAX), traceTruncated: trace.length > TRACE_MAX,
        });
        if (rec !== null) writeBreaches(rec, res.lane, adapter.name);
        const verdict = rec === null ? VERDICT.PASS : VERDICT.FAIL;
        const exitCode = rec === null ? EXIT_CODE.PASS : EXIT_CODE.FAIL;
        writeRecord(stream, 'summary', { reason: 'end', reproduced: rec !== null, familyKeys: keys, verdict, exitCode });
        endLine(verdict, exitCode, stream.seq);
        return exitCode;
    }, onCrash);
}

/* ---- process entry -------------------------------------------------------------------------------- */

/** True when `metaUrl`'s file is the process entry (main.mjs isEntry, parameterized). */
export function isEntryUrl(metaUrl) {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
    } catch {
        return false;
    }
}

/**
 * The entry door shared by replay.mjs and shrink.mjs: config.mjs parses, run(cfg) runs, the code exits.
 * --emit-test is a shrink door only (needShrink); replay.mjs keeps the default ['--smoke'].
 */
export async function entry(name, needShrink, run) {
    const cfg = readConfig(process.env, {
        roster: ROSTER, scenarios: ALL_SCENARIOS, covOffSupported: COV_OFF_SUPPORTED, argv: process.argv.slice(2),
        args: needShrink ? ['--smoke', '--emit-test'] : ['--smoke'],
    });
    if (cfg.replay === null) configExit(name + ' needs SOAK_REPLAY=<LANE>:<cycle>:0x<seed> (a key from a burn-in REPLAY line)');
    if (needShrink && !cfg.shrink) configExit(name + ' needs SOAK_SHRINK=1 (npm run soak:shrink); for a plain replay use bench/soak/replay.mjs');
    if (!needShrink && cfg.shrink) configExit('SOAK_SHRINK=1 is bench/soak/shrink.mjs (npm run soak:shrink), not ' + name);
    const code = await run(cfg);
    if (!isCode(code)) {
        protocol('soak: CRASH -- ' + name + ' returned ' + String(code) + ' (expected an exit code 0..3)');
        process.exit(1);
    }
    process.exit(code);
}

if (isEntryUrl(import.meta.url)) {
    entry('replay.mjs', false, runReplay).catch((e) => {
        protocol('soak: CRASH -- replay.mjs entry: ' + (e && e.stack ? e.stack : String(e)));
        process.exit(1);
    });
}
