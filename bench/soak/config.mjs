/**
 * @zakkster/lite-signal soak -- configuration (SPEC-B v2 section 8; port of lite-pick benchmark/soak/config.mjs).
 *
 * FAIL CLOSED: an invalid, out-of-range or unknown SOAK_* value is an error. The process exits 2 with ONE
 * `soak: CONFIG -- <message>` line on stderr, before any record is written. A bad value never falls back to
 * a default, and null is never treated as 0. An unknown key carries a did-you-mean hint.
 *
 * Every constant is defined ONCE in CONSTANTS and exported from it. gatesBlock() returns all of them for
 * the provenance header (lite-pick's header omitted four constants: digest section 3 GAP, lesson L20).
 *
 * COLD module: it runs once at startup.
 */

import { writeSync } from 'node:fs';

const CONSTANTS = Object.freeze({
    // cycles: N post-warm-up cycles on each side of the early/late split; floor = 2N + WARMUP (lite-pick S2:
    // an exact one-sided Mann-Whitney test cannot reach p < 0.01 with 3 per side; with 5 it reaches 1/252).
    GATE_N: 5,
    WARMUP_CYCLES: 1,
    MIN_ACTIVE_CYCLES: 11,
    DEFAULT_CYCLES: 11,
    // seeds.mjs packs (cycle << 4) | laneIndex into 32 bits, so cycle c and c + 2^28 would alias. A run has at
    // most 2^28 cycles (indices 0 .. 2^28 - 1); a forever run (SOAK_CYCLES=0) ends with reason 'end' at this
    // cap (main.mjs), and seedFor() throws past it. Policy: never wrap the cycle index.
    CYCLES_MAX: 1 << 28,
    // volume (PLAN 2.5: set in operations, never seconds). DEFAULT_OPS, SCEN_MIN(_SMOKE) and the evidence
    // floors below are CALIBRATED (S1d B6): evidence bench/soak/calibration/soak-calibration.json (tool
    // calibration/calibrate.mjs), drift guard test/41. Rarest required scenario at 11 x DEFAULT_OPS, seed
    // 0xC0FFEE, full-length cells (b74 D4: no failing world): 2724 hits (GRAPH deep-pull, both binding kernels;
    // tree NEST rarest 11388, lifecycle-callback-dispose, b74 TASK 0b) vs SCEN_MIN 8. SCEN_MIN's binding cell is
    // ERROR aggregate 22 (1.5.2; tree also 22, b74 0b), cut on FAIL-STOPPED worlds (1.5.2 17060/17071 failing, tree
    // 17039/17050): exempt from test/41 (f) only while DIV-F5 / F6 / F22 is open (fixBy A3 / A2 / A2), then ERROR is
    // recut on tree. Smoke: ERROR aggregate 2 vs SCEN_MIN_SMOKE 1 (same exemption).
    DEFAULT_OPS: 100000,
    OPS_MIN: 1000,
    // 2^30 - 1: SOAK_OPS is a per-lane-cycle counter target, so it stays inside [-2^30, 2^30 - 1] (Smi on
    // every V8 build, pointer-compressed included; SPEC-B addendum 7). Run totals live in a Float64Array.
    OPS_MAX: 0x3FFFFFFF,
    SMOKE_CYCLES: 3,
    SMOKE_OPS: 20000,
    DEFAULT_SEED: 0xC0FFEE,
    // checking
    CHECK_P: 0.4,
    WORLD_STEPS: 400,
    LARGE_WORLD_EVERY: 64,
    SHAPE_EVERY: 16,
    MAX_DEPTH: 200,
    // coverage and failures
    SCEN_MIN: 8,
    SCEN_MIN_SMOKE: 1,
    FAIL_CAP: 16,
    DETAIL_MAX: 240,
    // evidence floors (gates.mjs; S1c amendment 6), calibrated in S1d B6 (soak-calibration.json):
    //   CHECK_FLOOR      a lane's run must PERFORM at least this many checks of each applicable hard oracle
    //                    (taint skips never count); below it the lane is INCONCLUSIVE, never PASS. The least-
    //                    performed FULL-LENGTH cell (b74 D4: NEST cut on tree, 425.0 ops/world, 0 failing worlds;
    //                    b74 TASK 0b) is tree NEST O7a: 50367 at 11 x DEFAULT_OPS (5.0x the floor) and 2704 in
    //                    smoke (5.4x CHECK_FLOOR_SMOKE; test/41 (e): CHECK_FLOOR_SMOKE x 8 = 4000 >= 2704). The
    //                    headpatched / 1.5.2 NEST cells (O7a 41184 / 49458, smoke 2170 / 2618) fail-stop every
    //                    world at 32.5 / 30.0 ops/world: (c) still checks them, they bind no calibration. At
    //                    11 x OPS_MIN the full-length rows tree NEST O7a 672 and headpatched BATCH OB 8295 read
    //                    INCONCLUSIVE (fail-stopped rows: NEST 413 / 502, 1.5.2 BATCH 1789, ERROR OB 2152 / 1227).
    //                    One scalar for every oracle: only GRAPH (O5 14791, both binding kernels) and tree WIE
    //                    (O5 14323) clear it at 11 x OPS_MIN.
    //   TAINT_SKIP_MAX   per oracle that skips tainted nodes: skipped / (performed + skipped) above this is
    //                    hollow evidence -> INCONCLUSIVE. 0.35 kept (b70 D3). Full-length max (b74 TASK 0b) 0.2222
    //                    (tree NEST O1e at 11 x DEFAULT_OPS; smoke 0.2202). The fail-stopped headpatched NEST cells
    //                    read 0.0579 (O1c smoke, b71 recut; 8-seed smoke sweep 0.0663). The old design case
    //                    (headpatched NEST cov-off:saved-cursor-hazard O1c 0.43-0.44 trips) is VOID under b70 D6
    //                    V1: that ratio was ~80% blanket in-flight frame taint; V1 reads O1c 0.083-0.092 over 17
    //                    seeds (b70 D6 TASK 0 REPORT only; soak-calibration.json does not record O1c there); its
    //                    covOffSweep max oracle O1e 0.147-0.162 (1.5.2 0.125-0.133), so cov-off stays the COVERAGE
    //                    gate's case. The taint-skip must-fail is P-NEST-TAINT-HALF (test/67). Live NEST smoke
    //                    under V1 reads O1c 0.125-0.142 / O1e 0.218-0.232 over 9 seeds (b70 REPORT); the
    //                    late/early world-bucket ratio is REPORTED only.
    CHECK_FLOOR: 10000,
    CHECK_FLOOR_SMOKE: 500,
    TAINT_SKIP_MAX: 0.35,
    // memory (HEAP_* applies to residentBytes = heapUsed + arrayBuffers)
    HEAP_RATIO: 1.10,
    HEAP_SLACK_MB: 2,
    RSS_RATIO: 1.75,
    RSS_SLACK_MB: 16,
    // RSS_BUF (B-B3): the RssSampler capacity (rss.mjs re-exports it) AND the cap of the rss gate's late window,
    // k = min(max(1, floor(post / 4)), RSS_BUF) post-warm-up cycles (maintainer ruling D-B6, burst 81)
    RSS_BUF: 256,
    // retention
    DRAIN_MS: 2000,
    DRAIN_TRIES: 8,
    RETAIN_MAX: 0,
    RETAIN_BAD_BOUNDARIES: 2,
    // W5 (S2)
    W5_BOP_FAIL: 8,
    W5_ITER: 20000,
    W5_BATCHES: 8,
    W5_WARMUP: 20000,
    // WRAP job (S2 A-B2p task 9: were wrap.mjs locals; wrap.mjs and wrap-repr.mjs import them)
    SEMI_SPACE_MB: 4,             // pinned --min/--max-semi-space-size of the wrap job
    WRAP_CHUNK: 16777216,         // drive chunk 2^24: a Smi, <= 1 << 28 (spinVersion's contract)
    NS_K_CYCLE: 4096,             // transient window, create+dispose (~264 B/op handle mint x 4096 = 1.1 MB)
    WRAP_MAX_NODES: 64,           // every check fits a 64-node pool (SOAK.md appendix A)
    W4_SAMPLE_MASK: 0xFFFFF,      // W4 nodeId sampled every 2^20 allocations
    REPR_TIMEOUT_MS: 600000,
    BASELINE_MAX_BYTES: 8192,     // empty-step bytes per W5 window; above -> unmeasured
    // NEARWRAP (S2 task 9): SOAK_NEARWRAP=<sign|zero>:<k>, 1 <= k <= NEARWRAP_K_MAX (< WORLD_STEPS)
    NEARWRAP_K_MAX: 64,
    // seeds: lanes are packed into 4 bits of the seed input (seeds.mjs)
    ROSTER_MAX: 16,
    // did-you-mean: Levenshtein <= min(HINT_MAX_DIST, floor(len / 2)) (lite-pick uses <= 4 for keys)
    HINT_MAX_DIST: 4,
    // versions
    SCHEMA_VERSION: 2,
    GEN_VERSION: 1,
    // policy strings (recorded so a reader never has to guess)
    GC_MAJOR_POLICY: 'report-only: model lanes allocate by design; per-op 0 B/op is owned by test/32-perf-gate (ADR 0014 S1)',
    // verdicts (v2 section 8). PARTIAL is exit 0 but is never the string PASS. "No lane ran" is INCONCLUSIVE.
    VERDICT: Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE', SMOKE: 'SMOKE', PARTIAL: 'PARTIAL' }),
    EXIT_CODE: Object.freeze({ PASS: 0, FAIL: 1, CONFIG: 2, INCONCLUSIVE: 3, SMOKE: 0, PARTIAL: 0 }),
    // key universes
    ENGINES_KNOWN: Object.freeze(['lite', 'lite-box', 'alien', 'polyfill']),
    ENGINES_AVAILABLE: Object.freeze(['lite']),   // S1; S3 adds lite-box, S5 alien + polyfill
    WRAP_CHECKS: Object.freeze(['W1', 'W2', 'W3', 'W4', 'W5']),
    MUSTFAIL_MODES: Object.freeze(['cov-off']),
});

export const {
    GATE_N, WARMUP_CYCLES, MIN_ACTIVE_CYCLES, DEFAULT_CYCLES, CYCLES_MAX,
    DEFAULT_OPS, OPS_MIN, OPS_MAX, SMOKE_CYCLES, SMOKE_OPS, DEFAULT_SEED,
    CHECK_P, WORLD_STEPS, LARGE_WORLD_EVERY, SHAPE_EVERY, MAX_DEPTH,
    SCEN_MIN, SCEN_MIN_SMOKE, FAIL_CAP, DETAIL_MAX, CHECK_FLOOR, CHECK_FLOOR_SMOKE, TAINT_SKIP_MAX,
    HEAP_RATIO, HEAP_SLACK_MB, RSS_RATIO, RSS_SLACK_MB, RSS_BUF,
    DRAIN_MS, DRAIN_TRIES, RETAIN_MAX, RETAIN_BAD_BOUNDARIES,
    W5_BOP_FAIL, W5_ITER, W5_BATCHES, W5_WARMUP,
    SEMI_SPACE_MB, WRAP_CHUNK, NS_K_CYCLE, WRAP_MAX_NODES, W4_SAMPLE_MASK, REPR_TIMEOUT_MS, BASELINE_MAX_BYTES, NEARWRAP_K_MAX,
    ROSTER_MAX, HINT_MAX_DIST, SCHEMA_VERSION, GEN_VERSION, GC_MAJOR_POLICY,
    VERDICT, EXIT_CODE, ENGINES_KNOWN, ENGINES_AVAILABLE, WRAP_CHECKS, MUSTFAIL_MODES,
} = CONSTANTS;

/** Every constant, as a fresh plain object (the header's `gates` block). */
export function gatesBlock() {
    return JSON.parse(JSON.stringify(CONSTANTS));
}

/** Every SOAK_* key. Any other SOAK_* key is a typo: exit 2 with a did-you-mean hint. */
export const KNOWN_KEYS = Object.freeze([
    'SOAK_CYCLES', 'SOAK_OPS', 'SOAK_SEED', 'SOAK_LANES', 'SOAK_ENGINE', 'SOAK_KERNEL', 'SOAK_SMOKE',
    'SOAK_OUT', 'SOAK_REPLAY', 'SOAK_SHRINK', 'SOAK_REQUIRE_PROVENANCE', 'SOAK_MUSTFAIL', 'SOAK_WRAP', 'SOAK_REPR',
    'SOAK_NEARWRAP',
]);

const KNOWN_SUFFIXES = Object.freeze(KNOWN_KEYS.map((k) => k.slice(5)));

/** A config error. parseConfig throws it; readConfig turns it into exit 2. */
export class SoakConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SoakConfigError';
    }
}

/**
 * Write one line to fd 1 or 2 synchronously. A non-blocking pipe can refuse a write with EAGAIN; retry for
 * up to 2 s rather than drop the line (lite-pick's macOS pipe truncation, digest section 11).
 */
export function writeLineSync(fd, text) {
    const buf = Buffer.from(text + '\n', 'utf8');
    let off = 0;
    const t0 = Date.now();
    while (off < buf.length) {
        try {
            off += writeSync(fd, buf, off, buf.length - off);
        } catch (e) {
            if (!e || e.code !== 'EAGAIN' || Date.now() - t0 > 2000) throw e;
        }
    }
}

/** Print `soak: CONFIG -- <msg>` synchronously and exit 2. No record has been written at this point. */
export function configExit(msg) {
    writeLineSync(2, 'soak: CONFIG -- ' + msg);
    process.exit(EXIT_CODE.CONFIG);
}

/** Levenshtein distance (lite-pick config.mjs:72). Cold and tiny. */
export function editDistance(a, b) {
    const m = a.length, n = b.length;
    const d = new Array(n + 1);
    for (let j = 0; j <= n; j++) d[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = d[0];
        d[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = d[j];
            d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
            prev = tmp;
        }
    }
    return d[n];
}

/**
 * The closest entry of `list` to `word`, or null. Case-folded comparison (so `grpah` finds GRAPH), but the
 * match itself stays case-sensitive: `graph` is still an unknown lane. The bound scales with the word so a
 * short typo never "means" an unrelated short name.
 */
export function nearest(word, list) {
    const w = String(word).toLowerCase();
    const bound = Math.min(HINT_MAX_DIST, Math.floor(w.length / 2));
    let best = null, bestD = Infinity;
    for (const k of list) {
        const dd = editDistance(w, String(k).toLowerCase());
        if (dd < bestD) { bestD = dd; best = k; }
    }
    return bestD <= bound ? best : null;
}

function hint(word, list) {
    const h = nearest(word, list);
    return h === null ? '' : ' (did you mean ' + h + '?)';
}

/** The did-you-mean hint when one is close, otherwise the full list (so the line stays exact and short). */
function hintOrList(word, list, label) {
    const h = hint(word, list);
    return h !== '' ? h : ' (' + label + ': ' + list.join(', ') + ')';
}

function fail(msg) { throw new SoakConfigError(msg); }

const DEC_RE = /^\d+$/;
const SEED_RE = /^(0x[0-9a-fA-F]{1,8}|\d{1,10})$/;
const REPLAY_RE = /^([A-Z]+):(\d+):0x([0-9a-f]{1,8})$/;
const NEARWRAP_RE = /^(sign|zero):[1-9]\d*$/;

function parseIntKey(name, raw, min, max, allowZero) {
    const range = allowZero ? 'an integer >= ' + min + ' (or 0)' : 'an integer in [' + min + ', ' + max + ']';
    if (!DEC_RE.test(raw)) fail(name + "='" + raw + "' must be " + range);
    const v = Number(raw);
    if (!Number.isSafeInteger(v)) fail(name + "='" + raw + "' must be " + range);
    if (allowZero && v === 0) return 0;
    if (v < min || v > max) fail(name + "='" + raw + "' must be " + range);
    return v;
}

function parseSeed(name, raw) {
    if (!SEED_RE.test(raw)) fail(name + "='" + raw + "' must be a uint32 (decimal or 0x hex)");
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) fail(name + "='" + raw + "' must be a uint32 in [0, 4294967295]");
    return v >>> 0;
}

function parseOne(name, raw) {
    if (raw !== '1') fail(name + "='" + raw + "' must be exactly 1 (unset it to disable; 0/true/yes are rejected)");
    return true;
}

function parseList(name, raw) {
    const parts = raw.split(',').map((s) => s.trim());
    if (parts.length === 0 || parts.some((s) => s.length === 0)) fail(name + "='" + raw + "' has an empty entry");
    const seen = new Set();
    for (const p of parts) {
        if (seen.has(p)) fail(name + ": duplicate entry '" + p + "'");
        seen.add(p);
    }
    return parts;
}

/**
 * Parse a SOAK_NEARWRAP value `<sign|zero>:<k>` (no leading zero, 1 <= k <= NEARWRAP_K_MAX). Throws
 * SoakConfigError. Shared by parseConfig and kernel.mjs (which derives the kernel at import). -> frozen {phase, k}.
 */
export function parseNearwrap(raw) {
    if (typeof raw !== 'string' || !NEARWRAP_RE.test(raw)) fail("SOAK_NEARWRAP='" + String(raw) + "' must be sign:<k> or zero:<k> (k a decimal integer in [1, " + NEARWRAP_K_MAX + '])');
    const i = raw.indexOf(':');
    const k = Number(raw.slice(i + 1));
    if (!(Number.isSafeInteger(k) && k <= NEARWRAP_K_MAX)) fail("SOAK_NEARWRAP='" + raw + "': k must be in [1, " + NEARWRAP_K_MAX + '] (NEARWRAP_K_MAX)');
    return Object.freeze({ phase: raw.slice(0, i), k });
}

/**
 * Parse a replay key `<LANE>:<cycle>:0x<seed>` (v2 section 8). Throws SoakConfigError. The lane must be in
 * `roster`; keys are valid only within one GEN_VERSION (the header records it).
 */
export function parseReplayKey(raw, roster) {
    const m = REPLAY_RE.exec(raw);
    if (m === null) fail("SOAK_REPLAY='" + raw + "' must match <LANE>:<cycle>:0x<seed> (for example BATCH:7:0x9a3f12c4)");
    if (roster.indexOf(m[1]) === -1) fail("SOAK_REPLAY: unknown lane '" + m[1] + "'" + hintOrList(m[1], roster, 'roster'));
    const cycle = Number(m[2]);
    if (!Number.isSafeInteger(cycle) || cycle >= CYCLES_MAX) fail("SOAK_REPLAY: cycle '" + m[2] + "' out of range [0, " + (CYCLES_MAX - 1) + ']');
    return Object.freeze({ lane: m[1], cycle, seed: parseInt(m[3], 16) >>> 0 });
}

/**
 * Format a replay key `<LANE>:<cycle>:0x<seed>`, the exact inverse of parseReplayKey (lower-case hex, no
 * padding). Fail closed: a lane that is not upper-case letters, a cycle outside [0, CYCLES_MAX) or a seed
 * that is not a uint32 throws; a key that could not be parsed back is never printed.
 */
export function formatReplayKey(lane, cycle, seed) {
    if (typeof lane !== 'string' || !/^[A-Z]+$/.test(lane)) throw new TypeError('formatReplayKey: lane must be upper-case letters, got ' + String(lane));
    if (!(Number.isInteger(cycle) && cycle >= 0 && cycle < CYCLES_MAX)) throw new RangeError('formatReplayKey: cycle ' + cycle + ' outside [0, ' + CYCLES_MAX + ')');
    if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xFFFFFFFF)) throw new RangeError('formatReplayKey: seed ' + seed + ' is not a uint32');
    return lane + ':' + cycle + ':0x' + seed.toString(16);
}

/**
 * Validate opts.covOffSupported: a plain object with exactly one key per roster lane, each an array of
 * scenario ids from opts.scenarios (lanes/index.mjs COV_OFF_SUPPORTED). A programmer error -> TypeError.
 */
function checkCovOffSupported(cos, roster, scenarios) {
    const proto = cos !== null && typeof cos === 'object' ? Object.getPrototypeOf(cos) : undefined;
    if (proto === undefined || Array.isArray(cos) || (proto !== Object.prototype && proto !== null)) {
        throw new TypeError('parseConfig: opts.covOffSupported must be a plain object lane -> [scenario] (lanes/index.mjs COV_OFF_SUPPORTED)');
    }
    const keys = Object.keys(cos);
    for (const k of keys) if (roster.indexOf(k) === -1) throw new TypeError('parseConfig: opts.covOffSupported has a lane outside the roster: ' + k);
    for (const lane of roster) {
        const list = cos[lane];
        if (!Array.isArray(list)) throw new TypeError('parseConfig: opts.covOffSupported.' + lane + ' must be an array (empty when the lane supports no cov-off)');
        for (const s of list) {
            if (scenarios.indexOf(s) === -1) throw new TypeError('parseConfig: opts.covOffSupported.' + lane + ' names an unknown scenario: ' + String(s));
        }
    }
}

/**
 * Parse the SOAK_* environment. Pure: throws SoakConfigError, never exits.
 *   opts.roster     lane names, in roster order (lanes/index.mjs ROSTER); required
 *   opts.scenarios  every scenario id the roster can count (for cov-off); required
 *   opts.covOffSupported  lane -> [scenario] whose cov-off switch is implemented (lanes/index.mjs
 *                   COV_OFF_SUPPORTED); required. cov-off:<s> is accepted only when s is in the UNION over
 *                   the SELECTED lanes: a known scenario no selected lane can switch off would run as a
 *                   plain soak while the header claims a teeth knob (exit 2)
 *   opts.argv       the entry's user arguments (main.mjs: process.argv.slice(2)); required. This module is
 *                   the ONLY argv parser: the one accepted argument is --smoke (equal to SOAK_SMOKE=1, for
 *                   the env-prefix-free npm script); anything else exits 2.
 * Returns a frozen config with `record` = {KEY: {value, source: 'env' | 'argv' | 'default'}} for every known key.
 */
export function parseConfig(env, opts) {
    if (!opts || !Array.isArray(opts.roster) || opts.roster.length === 0) throw new TypeError('parseConfig: opts.roster must be a non-empty array');
    if (!Array.isArray(opts.scenarios)) throw new TypeError('parseConfig: opts.scenarios must be an array');
    if (!Array.isArray(opts.argv)) throw new TypeError('parseConfig: opts.argv must be an array (main.mjs: process.argv.slice(2))');
    const roster = opts.roster;
    if (roster.length > ROSTER_MAX) fail('roster has ' + roster.length + ' lanes; seeds.mjs packs at most ' + ROSTER_MAX);
    checkCovOffSupported(opts.covOffSupported, roster, opts.scenarios);

    // 1) unknown keys first, so a typo never gets a silent default (lite-pick L1). The SOAK_ prefix is
    //    matched case-insensitively: soak_lanes=... is a typo of SOAK_LANES, never an ignored variable.
    for (const key of Object.keys(env)) {
        const up = key.toUpperCase();
        if (up.indexOf('SOAK_') !== 0 || KNOWN_KEYS.indexOf(key) !== -1) continue;
        if (KNOWN_KEYS.indexOf(up) !== -1) fail("env key '" + key + "' must be upper-case (did you mean " + up + '?)');
        if (up === 'SOAK_DURATION') fail('SOAK_DURATION is not a key: volume is set in operations, never seconds (PLAN 2.5) -- did you mean SOAK_OPS or SOAK_CYCLES?');
        // did-you-mean on the suffix: on the full key the shared SOAK_ prefix made every short typo "mean" SOAK_OPS.
        const h = nearest(up.slice(5), KNOWN_SUFFIXES);
        fail("unknown env key '" + key + "'" + (h === null ? '' : ' (did you mean SOAK_' + h + '?)'));
    }
    // 2) argv: exactly one door, --smoke. Any other argument is an error, never an ignored flag.
    let argvSmoke = false;
    for (const a of opts.argv) {
        if (a !== '--smoke') fail("unknown argument '" + a + "' (the only argument is --smoke; everything else is a SOAK_* env key)");
        if (argvSmoke) fail("duplicate argument '--smoke'");
        argvSmoke = true;
    }
    const has = (k) => Object.prototype.hasOwnProperty.call(env, k) && env[k] !== undefined;
    const record = {};
    const put = (k, value, isEnv) => { record[k] = { value, source: isEnv ? 'env' : 'default' }; return value; };

    if (argvSmoke && has('SOAK_SMOKE') && env.SOAK_SMOKE !== '1') {
        fail("--smoke conflicts with SOAK_SMOKE='" + env.SOAK_SMOKE + "' (--smoke equals SOAK_SMOKE=1)");
    }
    const smoke = argvSmoke
        ? (record.SOAK_SMOKE = { value: true, source: 'argv' }).value   // --smoke is the door even when SOAK_SMOKE=1 agrees
        : put('SOAK_SMOKE', has('SOAK_SMOKE') ? parseOne('SOAK_SMOKE', env.SOAK_SMOKE) : false, has('SOAK_SMOKE'));
    // Smoke is a FIXED shape (v2 section 8: 3 cycles x 20,000 ops), so neither volume key may change it.
    // The error names the door that was used (--smoke wins the name when both agree).
    const door = argvSmoke ? '--smoke' : 'SOAK_SMOKE';
    if (smoke && has('SOAK_CYCLES')) fail(door + ' fixes ' + SMOKE_CYCLES + ' cycles; drop SOAK_CYCLES (a smoke run sits below the gate floor by design)');
    if (smoke && has('SOAK_OPS')) fail(door + ' fixes ' + SMOKE_OPS + ' ops per lane-cycle; drop SOAK_OPS');

    const cycles = put('SOAK_CYCLES', has('SOAK_CYCLES')
        ? parseIntKey('SOAK_CYCLES', env.SOAK_CYCLES, MIN_ACTIVE_CYCLES, CYCLES_MAX, true)
        : (smoke ? SMOKE_CYCLES : DEFAULT_CYCLES), has('SOAK_CYCLES'));
    const ops = put('SOAK_OPS', has('SOAK_OPS')
        ? parseIntKey('SOAK_OPS', env.SOAK_OPS, OPS_MIN, OPS_MAX, false)
        : (smoke ? SMOKE_OPS : DEFAULT_OPS), has('SOAK_OPS'));
    const seed = put('SOAK_SEED', has('SOAK_SEED') ? parseSeed('SOAK_SEED', env.SOAK_SEED) : DEFAULT_SEED, has('SOAK_SEED'));

    let lanes = roster.slice();
    if (has('SOAK_LANES')) {
        const req = parseList('SOAK_LANES', env.SOAK_LANES);
        for (const nm of req) {
            if (roster.indexOf(nm) === -1) fail("SOAK_LANES: unknown lane '" + nm + "'" + hintOrList(nm, roster, 'roster'));
        }
        lanes = roster.filter((nm) => req.indexOf(nm) !== -1);
    }
    put('SOAK_LANES', lanes, has('SOAK_LANES'));

    // SOAK_KERNEL is the lite-only seam: check the combination BEFORE engine availability (v2 section 3.1).
    if (has('SOAK_KERNEL') && env.SOAK_KERNEL === '') fail("SOAK_KERNEL='' is not a path");
    const kernel = put('SOAK_KERNEL', has('SOAK_KERNEL') ? env.SOAK_KERNEL : null, has('SOAK_KERNEL'));
    let engine = 'lite';
    if (has('SOAK_ENGINE')) {
        engine = env.SOAK_ENGINE;
        if (kernel !== null && engine !== 'lite') {
            fail("SOAK_KERNEL is the lite-only kernel seam; it cannot be combined with SOAK_ENGINE='" + engine + "'");
        }
        if (has('SOAK_NEARWRAP') && engine !== 'lite') {
            fail("SOAK_NEARWRAP derives the lite kernel; it cannot be combined with SOAK_ENGINE='" + engine + "'");
        }
        if (ENGINES_KNOWN.indexOf(engine) === -1) {
            fail("SOAK_ENGINE: unknown engine '" + engine + "'" + hintOrList(engine, ENGINES_KNOWN, 'engines'));
        }
        if (ENGINES_AVAILABLE.indexOf(engine) === -1) {
            fail("SOAK_ENGINE: engine '" + engine + "' is not available in this build (available: " + ENGINES_AVAILABLE.join(', ') + ')');
        }
    }
    put('SOAK_ENGINE', engine, has('SOAK_ENGINE'));

    if (has('SOAK_OUT') && env.SOAK_OUT === '') fail("SOAK_OUT='' is not a path");
    const out = put('SOAK_OUT', has('SOAK_OUT') ? env.SOAK_OUT : null, has('SOAK_OUT'));

    const replay = put('SOAK_REPLAY', has('SOAK_REPLAY') ? parseReplayKey(env.SOAK_REPLAY, roster) : null, has('SOAK_REPLAY'));
    const shrink = put('SOAK_SHRINK', has('SOAK_SHRINK') ? parseOne('SOAK_SHRINK', env.SOAK_SHRINK) : false, has('SOAK_SHRINK'));
    if (shrink && replay === null) fail('SOAK_SHRINK=1 needs a SOAK_REPLAY key to shrink');
    const requireProvenance = put('SOAK_REQUIRE_PROVENANCE', has('SOAK_REQUIRE_PROVENANCE')
        ? parseOne('SOAK_REQUIRE_PROVENANCE', env.SOAK_REQUIRE_PROVENANCE) : false, has('SOAK_REQUIRE_PROVENANCE'));
    const repr = put('SOAK_REPR', has('SOAK_REPR') ? parseOne('SOAK_REPR', env.SOAK_REPR) : false, has('SOAK_REPR'));

    let wrap = WRAP_CHECKS.slice();
    if (has('SOAK_WRAP')) {
        const req = parseList('SOAK_WRAP', env.SOAK_WRAP);
        for (const w of req) {
            if (WRAP_CHECKS.indexOf(w) === -1) fail("SOAK_WRAP: unknown check '" + w + "'" + hintOrList(w, WRAP_CHECKS, 'checks'));
        }
        wrap = WRAP_CHECKS.filter((w) => req.indexOf(w) !== -1);
    }
    put('SOAK_WRAP', wrap, has('SOAK_WRAP'));

    let mustFail = null;
    if (has('SOAK_MUSTFAIL')) {
        const raw = env.SOAK_MUSTFAIL;
        const i = raw.indexOf(':');
        const mode = i === -1 ? raw : raw.slice(0, i);
        if (MUSTFAIL_MODES.indexOf(mode) === -1 || i === -1) {
            fail("SOAK_MUSTFAIL='" + raw + "' must be cov-off:<scenario>");
        }
        const scen = raw.slice(i + 1);
        if (opts.scenarios.indexOf(scen) === -1) {
            fail("SOAK_MUSTFAIL: unknown scenario '" + scen + "'" + hintOrList(scen, opts.scenarios, 'scenarios'));
        }
        const supported = [];
        for (const nm of lanes) for (const s of opts.covOffSupported[nm]) if (supported.indexOf(s) === -1) supported.push(s);
        if (supported.indexOf(scen) === -1) {
            fail("SOAK_MUSTFAIL: cov-off:" + scen + ' is not supported on the selected lanes ' + lanes.join(',') +
                (supported.length === 0 ? ' (none of them implements a cov-off switch)' : ' (supported: ' + supported.join(', ') + ')'));
        }
        mustFail = Object.freeze({ mode, scenario: scen });
    }
    put('SOAK_MUSTFAIL', mustFail, has('SOAK_MUSTFAIL'));
    const nearwrap = put('SOAK_NEARWRAP', has('SOAK_NEARWRAP') ? parseNearwrap(env.SOAK_NEARWRAP) : null, has('SOAK_NEARWRAP'));

    return Object.freeze({
        cycles, forever: cycles === 0, ops, seed, lanes: Object.freeze(lanes), smoke, engine, kernel, out, replay, shrink,
        requireProvenance, repr, wrap: Object.freeze(wrap), mustFail, nearwrap, roster: Object.freeze(roster.slice()),
        record: Object.freeze(record),
    });
}

/** Fail closed when gc() is not exposed (lite-pick exited 1 here; L22: it is a config error, exit 2). */
export function requireExposeGc() {
    if (typeof globalThis.gc !== 'function') configExit('--expose-gc is required (run: node --expose-gc bench/soak/main.mjs, or npm run soak)');
}

/** parseConfig + requireExposeGc, exiting 2 with one `soak: CONFIG --` line on any error. */
export function readConfig(env, opts) {
    let cfg;
    try {
        cfg = parseConfig(env, opts);
    } catch (e) {
        if (e instanceof SoakConfigError) configExit(e.message);
        throw e;
    }
    requireExposeGc();
    return cfg;
}
