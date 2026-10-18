/**
 * @zakkster/lite-signal soak -- the MUST-FAIL battery (SPEC-B v2 section 9; S1cd TASK 10 with amendments 9, 9a,
 * 13 and 14). Port of lite-pick benchmark/soak/_mustfail.mjs (patch :49-63, token matching :153-169).
 *
 *   node bench/soak/_mustfail.mjs            the short battery: every control whose name matches ^(?!L-)
 *   node bench/soak/_mustfail.mjs --long     the long battery:  every control whose name matches ^L-
 *   MUSTFAIL_ONLY=<regex>                    narrow either battery to the matching names (an empty selection
 *                                            is an error, exit 2)
 *   MUSTFAIL_HEADS=1                         print, under each control, the head each spec matched
 *   MUSTFAIL_LIST=1                          build every control (every patch anchor is resolved, so a stale
 *                                            anchor throws: exit 1) and RUN NOTHING; print one JSON line per
 *                                            control, then {"end":true,"count":N}
 *
 * A gate that cannot fail is not a gate. Each control is a scratch kernel DIRECTORY (Signal.js + Watch.js; the
 * seam kernel.mjs requires the pair) copied from a pinned base and optionally mutated by exactly-once anchors,
 * driven through the REAL main.mjs via SOAK_KERNEL (spawnSync, --expose-gc, 30-minute timeout, piped stderr).
 * Nothing here calls a gate module directly.
 *
 * A control PASSES (OK) only when ALL of these hold; anything else is a MISS:
 *   - the base's sha256 pins verify first (controls.json for headpatched / rev152, parity.json for tree);
 *   - the exact exit code;
 *   - every spec matches ONE `soak: BREACH` or `soak: INCONCLUSIVE --` line (hasToken); every exact line is
 *     present; kind 'nobreach' sees ZERO BREACH lines; kind 'explained' sees >= 1 BREACH line and every one is
 *     an oracle BREACH whose known tag (split on '+') lies inside expect.known;
 *   - no `soak: CRASH` line anywhere;
 *   - the END sentinel is the last stdout line, its exit equals the child's, its records equal the stream's;
 *   - SoakReport re-derives the stream to `soak:report: verdict <V> (consistent)` with V = the END verdict
 *     (exit 0, or exit 1 with a `NOT A RELEASE SOAK` refusal: a scratch kernel, smoke or SOAK_MUSTFAIL run is
 *     consistent but never release evidence).
 * A wrap control (run 'wrap', S2) drives the REAL bench/soak/wrap.mjs instead, with wrap.mjs's own flag trio
 * (--expose-gc --min-semi-space-size=4 --max-semi-space-size=4, never GC_FLAGS) and SOAK_WRAP as its only env
 * key. It passes on the same exit / spec / line / CRASH / END checks, and wrapJudge replaces the SoakReport step
 * (SoakReport has no wrap-stream dispatch yet): wraprules.mjs wrapStreamProblems(stream) is [], wrapRule over the
 * stream's wrap records equals the END verdict, every wrap record's boundary reads trackerSize 0 / weakAlive 0,
 * and no INCONCLUSIVE line appears that the control does not expect. expect.extra.boundaries (the burn-in's
 * cycle-record count) is rejected on a wrap control.
 * A config control (run 'cfg') passes only with exit 2, exactly ONE stderr line EQUAL to its expected
 * `soak: CONFIG --` line (or starting with it, expect.configMatch 'prefix', for the two rows whose tail is not
 * spelled here: mustfail-unknown's code-derived hintOrList scenario list, provenance-no-sha's git error text), empty stdout (no heartbeat, no END) and no stream file.
 *
 * Exports (kernel-free, nothing runs on import; test/45 and teeth.mjs import them, never copy them):
 *   CONTROLS        frozen control data (CONTROL_NAMES derived from it)
 *   patch, patchAll exactly-once anchor patching (a count != 1 throws `stale anchor: <n> matches`)
 *   hasToken        one protocol line vs one spec
 *   validSpec       shape problems of one control ([] when valid)
 *   staleAnchors    the controls whose patches do not apply exactly once ([{name, error}], never throws)
 *   buildKernel     the patched Signal.js source of one control (+ its anchors' file:line)
 *   verifyControls  the sha256 pin check of every base
 *   BASES           base name -> { dir, pins, pinName }
 *   parseHead       one protocol line -> { kind, words, pairs } (the head hasToken matches)
 *   wrapJudge       the wrap-control stream checks (pure: problem strings of a parsed wrap stream)
 *   runControl      run ONE control: verifies its base pins itself unless the caller passes the problems map
 *                   of a verifyControls() it already ran; removes its scratch dir (and zero-commit copy) on return
 *   LONG_RE, SHORT_RE  the ^L- / ^(?!L-) partition of the battery
 *
 * COLD module (a battery driver).
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, copyFileSync, realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_ACTIVE_CYCLES, DEFAULT_OPS, OPS_MIN, OPS_MAX, SEMI_SPACE_MB } from './config.mjs';
import { wrapRule, wrapStreamProblems } from './wraprules.mjs';
import { inconclusiveLine } from './gates.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOAK = join(ROOT, 'bench', 'soak');
const MAIN = join(SOAK, 'main.mjs');
const WRAP = join(SOAK, 'wrap.mjs');
const REPORT = join(SOAK, 'SoakReport.mjs');
const NODE = process.execPath;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const REPORT_TIMEOUT_MS = 5 * 60 * 1000;
const GC_FLAGS = Object.freeze(['--expose-gc']);
// wrap.mjs's own flag trio (wrap.mjs semiSpaceProblem refuses any other semi-space setting, exit 2)
const WRAP_FLAGS = Object.freeze(['--expose-gc', '--min-semi-space-size=' + SEMI_SPACE_MB, '--max-semi-space-size=' + SEMI_SPACE_MB]);
const ARMED = 'mustfail ARMED';   // an armed scratch kernel writes this to stderr when its event fires
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ---- bases ---------------------------------------------------------------------------------------- */

/**
 * Every base a control can start from. A base is a Signal.js + Watch.js directory with sha256 pins:
 * headpatched, rev152 and preb33 are pinned by controls.json (by control name), tree by parity.json (red while
 * the live Signal.js is mid-edit, amendment 10). Only the wrap control L-WRAP-TREE (S2) uses tree; no main-run
 * control does until A1-A3 land (SPEC-B section 10.3): burst 39 measured the tree ERROR lane (11 x DEFAULT_OPS,
 * default seed) red on DIV-F5 / DIV-F6 / DIV-F22 and on known=none recovery-after-throw BREACHes. preb33 does NOT
 * avoid that picture (burst 52: preb33 ERROR shows the same F5 / F6 / F22 lines, and the known=none heads are
 * DIV-F6 since the burst 53 triage, PLAN-F-b33-1 N19); P-INTERIM-ERROR-clean runs on preb33 because it is the
 * post-F21 controls.json kernel (N17.2), so a DIV-F21 label there is a MISS.
 */
export const BASES = Object.freeze({
    headpatched: Object.freeze({ dir: join(SOAK, 'controls', 'headpatched'), pins: 'controls.json', pinName: 'headpatched' }),
    rev152: Object.freeze({ dir: join(ROOT, 'node_modules', 'lite-signal-1.5.2'), pins: 'controls.json', pinName: 'rev152' }),
    preb33: Object.freeze({ dir: join(SOAK, 'controls', 'preb33'), pins: 'controls.json', pinName: 'preb33' }),
    tree: Object.freeze({ dir: ROOT.replace(/[\\/]$/, ''), pins: 'parity.json', pinName: null }),
});

const srcCache = new Map();
function baseSource(base) {
    if (!own(BASES, base)) throw new TypeError('unknown base ' + String(base));
    if (!srcCache.has(base)) srcCache.set(base, readFileSync(join(BASES[base].dir, 'Signal.js'), 'utf8'));
    return srcCache.get(base);
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The sha256 pin check of each base in `bases`. Returns { ok, problems: {base: message} }. A mismatch is a MISS. */
export function verifyControls(bases) {
    const problems = {};
    let ctl = null, par = null;
    for (const b of bases) {
        try {
            const B = BASES[b];
            if (B === undefined) throw new Error('unknown base');
            let want;
            if (B.pins === 'controls.json') {
                if (ctl === null) ctl = JSON.parse(readFileSync(join(SOAK, 'controls.json'), 'utf8')).controls;
                const c = ctl.find((x) => x && x.name === B.pinName);
                if (!c) throw new Error('controls.json has no control ' + B.pinName);
                want = c.sha256;
            } else {
                if (par === null) par = JSON.parse(readFileSync(join(SOAK, 'parity.json'), 'utf8')).files;
                want = { 'Signal.js': par['Signal.js'], 'Watch.js': par['Watch.js'] };
            }
            for (const f of ['Signal.js', 'Watch.js']) {
                const got = sha256(join(B.dir, f));
                if (got !== want[f]) throw new Error(f + ' sha256 ' + got.slice(0, 12) + ' != pin ' + String(want[f]).slice(0, 12) + ' (' + B.pins + ')');
            }
        } catch (e) {
            problems[b] = String(e && e.message ? e.message : e);
        }
    }
    return { ok: Object.keys(problems).length === 0, problems };
}

/* ---- exactly-once patching ------------------------------------------------------------------------ */

function occurrences(src, anchor) {
    const at = [];
    if (typeof anchor !== 'string' || anchor.length === 0) throw new TypeError('patch: an anchor must be a non-empty string');
    for (let i = src.indexOf(anchor); i !== -1; i = src.indexOf(anchor, i + 1)) at.push(i);   // overlapping matches count
    return at;
}

/**
 * Apply every [anchor, replacement] pair to `src`. Each anchor is counted against the ORIGINAL source and must
 * occur exactly once (`stale anchor: <n> matches`); two anchors whose spans overlap throw. Replacements never
 * see each other's output.
 */
export function patchAll(src, pairs) {
    if (typeof src !== 'string') throw new TypeError('patchAll: src must be a string');
    if (!Array.isArray(pairs) || pairs.length === 0) throw new TypeError('patchAll: pairs must be a non-empty array of [anchor, replacement]');
    const spans = [];
    for (const p of pairs) {
        if (!Array.isArray(p) || p.length !== 2 || typeof p[1] !== 'string') throw new TypeError('patchAll: each pair is [anchor, replacement]');
        const at = occurrences(src, p[0]);
        if (at.length !== 1) throw new Error('stale anchor: ' + at.length + ' matches: ' + JSON.stringify(p[0].slice(0, 60)));
        spans.push({ from: at[0], to: at[0] + p[0].length, repl: p[1] });
    }
    spans.sort((a, b) => a.from - b.from);
    for (let i = 1; i < spans.length; i++) {
        if (spans[i].from < spans[i - 1].to) throw new Error('overlapping anchors at offsets ' + spans[i - 1].from + ' and ' + spans[i].from);
    }
    let out = '', pos = 0;
    for (const s of spans) { out += src.slice(pos, s.from) + s.repl; pos = s.to; }
    return out + src.slice(pos);
}

/** One exactly-once anchor (patchAll with one pair). */
export function patch(src, anchor, repl) {
    return patchAll(src, [[anchor, repl]]);
}

/* ---- spec matching -------------------------------------------------------------------------------- */

const BREACH_PFX = 'soak: BREACH ';
const INC_PFX = 'soak: INCONCLUSIVE -- ';

/** Parse a protocol line's head (text before ` detail=`) -> { kind, words: Set, pairs: Map(key -> [values]) } or null. */
export function parseHead(line) {
    let kind, rest;
    if (typeof line !== 'string') return null;
    if (line.startsWith(BREACH_PFX)) { kind = 'BREACH'; rest = line.slice(BREACH_PFX.length); }
    else if (line.startsWith(INC_PFX)) { kind = 'INCONCLUSIVE'; rest = line.slice(INC_PFX.length); }
    else return null;
    const d = rest.indexOf(' detail=');
    if (d !== -1) rest = rest.slice(0, d);
    else if (rest.startsWith('detail=')) rest = '';
    const words = new Set(), pairs = new Map();
    for (const t of rest.split(' ')) {
        if (t.length === 0) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) { words.add(t); continue; }
        const k = t.slice(0, eq);
        const vals = t.slice(eq + 1).split(',');
        pairs.set(k, (pairs.get(k) || []).concat(vals));
    }
    return { kind, words, pairs };
}

/**
 * Does ONE protocol line satisfy `spec`? A spec is space-separated tokens: an optional leading kind (BREACH, the
 * default, or INCONCLUSIVE), then
 *   k=v      the head carries key k and every comma entry of v is one of k's comma entries (scen=a,b needs both)
 *   k>=n     the head carries a numeric k >= n
 *   word     a bare head word (the INCONCLUSIVE cause: scenario, checks, taint-skip ...)
 * A spec with no constraint matches nothing (fail closed). Text after ` detail=` is never matched.
 */
export function hasToken(line, spec) {
    const h = parseHead(line);
    if (h === null || typeof spec !== 'string') return false;
    const toks = spec.split(' ').filter((t) => t.length > 0);
    let kind = 'BREACH';
    if (toks.length > 0 && (toks[0] === 'BREACH' || toks[0] === 'INCONCLUSIVE')) kind = toks.shift();
    if (toks.length === 0 || h.kind !== kind) return false;
    for (const t of toks) {
        const ge = t.indexOf('>=');
        const eq = t.indexOf('=');
        if (ge > 0) {
            const vals = h.pairs.get(t.slice(0, ge));
            const bound = Number(t.slice(ge + 2));
            if (!vals || !Number.isFinite(bound) || !vals.some((v) => Number(v) >= bound)) return false;
        } else if (eq > 0) {
            const vals = h.pairs.get(t.slice(0, eq));
            if (!vals) return false;
            for (const v of t.slice(eq + 1).split(',')) if (vals.indexOf(v) === -1) return false;
        } else if (!h.words.has(t)) return false;
    }
    return true;
}

/* ---- the controls ---------------------------------------------------------------------------------- */

const CYC = String(MIN_ACTIVE_CYCLES);   // 11: the active floor (2N + warm-up), so the drift gates are live

/**
 * Scratch-kernel tail (test/46 armAt2): rebind the module's createRegistry (a function declaration, a live
 * binding the adapter reads through the namespace) and run `action` on the 2nd registry the run opens, i.e.
 * inside world 1 of cycle 0, after the stream is open; main sees the signal at its next yield (world 63).
 */
const armAt2 = (action) => '\n;const __mfReg = createRegistry; let __mfN = 0;\n' +
    'createRegistry = function (config) { if (++__mfN === 2) { process.stderr.write("' + ARMED + '\\n"); ' + action + ' } return __mfReg(config); };\n';

// Anchors in bench/soak/controls/headpatched/Signal.js (line numbers as of controls.json sha fa2871f0; LIST
// mode prints the live line of every anchor).
// :782 createNode entry -- every node creation (the pool-growth sites :794/:797 fire once per 256 nodes of a
// fresh per-world registry, too rare to move the heap gate).
const A_CREATE_NODE = '    function createNode(value, flags) {\n        let node;\n';
// :1218 the recompute-end severTail (computed path, 20-space indent); :1120 is the effect-run end (16 spaces).
const A_SEVER = '                    severTail(node);\n                    node.flags &= ~FLAG_COMPUTING;\n';
// :1975 the createRegistry return (the public api object main tracks as world.registry).
const A_RETURN = '    return {getOwner, runWithOwner, signal, computed, effect, signalBox, computedBox, dispose, batch, untrack, createRoot, onCleanup, stats, destroy, isTracking, hasObservers, observeObservers, forEachObserver, forEachSource, forEachOwned, ownerOf, nodeId, describe, onGraphMutation};\n';

// amendment 13 (TASK 10 amended). headpatched is a PRE-fix controls.json kernel: DIV-F21 (fixedIn A2-F21) still
// explains there, because main / SoakReport classify with includeFixed = (controls.name !== null).
const KNOWN_INTERIM = Object.freeze(['DIV-F21', 'DIV-F22']);
// P-INTERIM-ERROR-clean (N17.2, N19.4): preb33 is a POST-F21 controls.json kernel (includeFixed true), so a DIV-F21
// label there is not in this list -> MISS (A3': zero DIV-F21 on preb33); only the still-open DIV-F5 / DIV-F6 /
// DIV-F22 (no FIX-R / FIX-T / A2 batch-error fix in preb33) may explain a BREACH.
const KNOWN_INTERIM_CLEAN = Object.freeze(['DIV-F5', 'DIV-F6', 'DIV-F22']);

function deepFreeze(o) {
    if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
}

/** A main-run control. */
function M(name, base, env, argv, expect, more) {
    return Object.assign({ name, run: 'main', base, env, argv, flags: GC_FLAGS.slice(), patches: [], arm: null, expect }, more || {});
}
/** A wrap control (S2): the real wrap.mjs, its flag trio, SOAK_WRAP the only env key, no argv / patch / arm. */
function W(name, base, env, expect) {
    return { name, run: 'wrap', base, env, argv: [], flags: WRAP_FLAGS.slice(), patches: [], arm: null, expect };
}
/** A config control: exit 2 with ONE `soak: CONFIG --` line, equal to `line` (or starting with it when more.prefix). */
function C(slug, env, line, more) {
    const { prefix, ...rest } = more || {};   // prefix: the line's tail is not spelled here, so match its start only
    return Object.assign({
        name: 'T-cfg-' + slug, run: 'cfg', base: 'headpatched', env, argv: [], flags: GC_FLAGS.slice(), patches: [], arm: null,
        kernel: 'scratch', repo: null,
        expect: { exit: 2, kind: 'nobreach', specs: [], lines: [], config: 'soak: CONFIG -- ' + line, configMatch: prefix === true ? 'prefix' : 'exact' },
    }, rest);
}

export const CONTROLS = deepFreeze([
    /* ---- long (^L-) ---- */
    // L-REV-152: the published 1.5.2 must FAIL on all four families (SPEC-B 9 table). BREACH line: main.mjs:191.
    M('L-REV-152', 'rev152', { SOAK_LANES: 'GRAPH,BATCH,ERROR,NEST', SOAK_CYCLES: CYC, SOAK_OPS: '20000' }, [], {
        exit: 1, kind: 'match', lines: [], specs: [
            'oracle=O1 lane=BATCH scen=revert-after-mid-read',   // F5
            'oracle=O6 lane=ERROR sig=escape-computed',          // F6
            'oracle=O7 lane=NEST sig=dead-registration-fire',    // F7 (O7a -> family O7, gates.mjs oracleFamily)
            'oracle=O6 lane=NEST scen=saved-cursor-hazard',      // F15 / F8
            // the unique teeth of O1c / O1e / O2 (orchestrator, B7 review round 1). Evidence: burst 9 run, 11 x 20k,
            // rev152 -- all 9 specs matched, heads (before detail=, scen/engine/replay omitted here):
            //   oracle=O1 lane=BATCH sig=computed-mismatch known=DIV-F5   (specs 1 and 5)
            //   oracle=O6 lane=ERROR sig=escape-computed known=DIV-F6
            //   oracle=O7 lane=NEST sig=dead-registration-fire known=DIV-F7
            //   oracle=O6 lane=NEST sig=escape-TypeError known=DIV-F15    (scen ...,saved-cursor-hazard,...)
            //   oracle=O1 lane=BATCH sig=effect-stale known=DIV-F5
            //   oracle=O2 lane=BATCH sig=glitch known=DIV-F5
            //   oracle=O4 lane=ERROR sig=effect-dead known=DIV-F6
            //   oracle=O6 lane=ERROR sig=expected-escape-missing known=DIV-F22
            // BreachLog keys on (family, lane, sig, known), so each sig is its own BREACH head (main.mjs:178-191).
            'oracle=O1 lane=BATCH sig=computed-mismatch',        // O1c
            'oracle=O1 lane=BATCH sig=effect-stale',             // O1e
            'oracle=O2 lane=BATCH sig=glitch',                   // O2
            // ERROR unique teeth (orchestrator, B7 review round 3). Evidence: burst 9 run, 11 x 20k, rev152 (heads
            // above); burst 9 review run, _dev-run 400 worlds: O4:effect-dead 359/400, O6:expected-escape-missing
            // 33/400. No known= token: the escape-missing line may carry DIV-F22 or a F6+F22 tag; either matches.
            'oracle=O4 lane=ERROR sig=effect-dead',
            'oracle=O6 lane=ERROR sig=expected-escape-missing',
        ],
    }),
    // L-REV-AUDIT: headpatched NEST (P7-P10 throw). The O5 link-count spec joins once calibration shows 3/3.
    M('L-REV-AUDIT', 'headpatched', { SOAK_LANES: 'NEST', SOAK_CYCLES: CYC, SOAK_OPS: String(DEFAULT_OPS) }, [], {
        exit: 1, kind: 'match', lines: [], specs: ['oracle=O6 lane=NEST scen=saved-cursor-hazard'],
    }),
    // L-WIE-preb33 (unit 0s B2, PLAN-0s-wie ADDENDUM 2 item 4): preb33 predates F-b33-1, so every WIE BREACH there is the
    // write-in-eval lost update, explained by the FIXED entry DIV-B33 (includeFixed: preb33 is a controls.json kernel).
    // 'explained' with specs [] would not pair lane:WIE (test/45 reads expect.specs), so the O1e head is spelled out.
    // Burst 68 smoke (3 x 20000, before DIV-B33 existed): heads O1e effect-stale, O2 glitch, O1c computed-mismatch, all
    // known=none (.handoff/b68-evidence/b2b/preb33-wie-smoke.err). L-REV-152 keeps its explicit 4-lane list (1.5.2).
    M('L-WIE-preb33', 'preb33', { SOAK_LANES: 'WIE', SOAK_CYCLES: CYC, SOAK_OPS: String(DEFAULT_OPS) }, [], {
        exit: 1, kind: 'explained', lines: [], specs: ['oracle=O1 lane=WIE sig=effect-stale'], known: ['DIV-B33'],
    }),
    // L-P-INTERIM (amendment 13): the interim pass control on GRAPH,BATCH -- exit 0, no BREACH, 22 clean boundaries.
    M('L-P-INTERIM', 'headpatched', { SOAK_LANES: 'GRAPH,BATCH', SOAK_CYCLES: CYC, SOAK_OPS: String(DEFAULT_OPS) }, [], {
        exit: 0, kind: 'nobreach', lines: [], specs: [], extra: { boundaries: 2 * MIN_ACTIVE_CYCLES, reason: 'end', verdict: 'PASS' },
    }),
    // L-P-INTERIM-ERROR (amendment 13): headpatched ERROR fails ONLY on the tolerated divergences F21 / F22.
    M('L-P-INTERIM-ERROR', 'headpatched', { SOAK_LANES: 'ERROR', SOAK_CYCLES: CYC, SOAK_OPS: String(DEFAULT_OPS) }, [], {
        exit: 1, kind: 'explained', lines: [], specs: [], known: KNOWN_INTERIM,
    }),
    // L-T-leak: every createNode pushes a 128-slot array to a global -> the heap drift gate (main.mjs:316 line).
    M('L-T-leak', 'headpatched', { SOAK_LANES: 'GRAPH', SOAK_CYCLES: CYC, SOAK_OPS: String(DEFAULT_OPS) }, [], {
        exit: 1, kind: 'match', lines: [], specs: ['gate=heap lane=GRAPH'],
    }, { patches: [[A_CREATE_NODE, A_CREATE_NODE + '        (globalThis.__soakLeak ||= []).push(new Array(128));   // MUSTFAIL L-T-leak\n']] }),
    // L-T-retain: every registry api is pushed to a global -> tracker.size() never drains (main.mjs:316 line).
    // Sized 11 x OPS_MIN: at 11 x DEFAULT_OPS the retained registries (~500 MB per GRAPH cycle) hit the V8 heap
    // limit at cycle 7 (burst 10 probe: residentMB=3534.27 after cycle 6, then "FATAL ERROR: Ineffective
    // mark-compacts near heap limit Allocation failed - JavaScript heap out of memory", SIGABRT, no END). The
    // gate needs only RETAIN_BAD_BOUNDARIES (2) bad post-warm-up boundaries; every boundary here is bad.
    // Burst 10 run at this size: END FAIL exit=1, retention badBoundaries=10 (trackerSize 3..33), and the heap
    // gate trips TOO (late 73.28 MB > limit 43.454 MB) -- accepted: the spec pins the retention line.
    M('L-T-retain', 'headpatched', { SOAK_LANES: 'GRAPH', SOAK_CYCLES: CYC, SOAK_OPS: String(OPS_MIN) }, [], {
        exit: 1, kind: 'match', lines: [], specs: ['gate=retention lane=GRAPH'],
    }, { patches: [[A_RETURN, A_RETURN.replace('    return {', '    const __soakApi = {') +
        '    (globalThis.__soakRegs ||= []).push(__soakApi);   // MUSTFAIL L-T-retain\n    return __soakApi;\n']] }),
    // L-I1 / L-I2: the kernel raises SIGINT / SIGTERM at its own process mid-cycle-0 -> INCONCLUSIVE, reason signal.
    // Lines: gates.mjs:377 (interrupted), main.mjs:340 (NOTE), the stream summary reason (main.mjs:466).
    M('L-I1', 'headpatched', { SOAK_LANES: 'GRAPH', SOAK_CYCLES: CYC, SOAK_OPS: String(DEFAULT_OPS) }, [], {
        exit: 3, kind: 'nobreach', specs: ['INCONCLUSIVE run interrupted before its end'],
        lines: ['soak: INCONCLUSIVE -- run interrupted before its end', 'soak: NOTE -- SIGINT received; closing the current lane-cycle, then the summary', ARMED],
        extra: { reason: 'signal', verdict: 'INCONCLUSIVE' },
    }, { arm: armAt2('process.kill(process.pid, "SIGINT");') }),
    M('L-I2', 'headpatched', { SOAK_LANES: 'GRAPH', SOAK_CYCLES: CYC, SOAK_OPS: String(DEFAULT_OPS) }, [], {
        exit: 3, kind: 'nobreach', specs: ['INCONCLUSIVE run interrupted before its end'],
        lines: ['soak: INCONCLUSIVE -- run interrupted before its end', 'soak: NOTE -- SIGTERM received; closing the current lane-cycle, then the summary', ARMED],
        extra: { reason: 'signal', verdict: 'INCONCLUSIVE' },
    }, { arm: armAt2('process.kill(process.pid, "SIGTERM");') }),
    // L-REV-AUDIT-W5 (S2, SPEC-S2-groupA DELTA 2 (c), MD4): headpatched W5 must breach evalCount past 2^31 (F16:
    // burst 25 full size, `soak: BREACH gate=wrap check=W5 counter=evalCount bop=32.00 detail=class=set->computed->effect
    // pre=0.00 (post and post-pre >= 8)`). W5 exits 1 on every kernel (W5[gen] / W5[nodeSeq] create+dispose), so the
    // exit code has no teeth: the evalCount spec at bop>=15 does. Its absence on tree / rev152 is the one-shot base-
    // swap must-fail of DELTA 2 (MD5; burst 27 record), not a control. ~250 s.
    W('L-REV-AUDIT-W5', 'headpatched', { SOAK_WRAP: 'W5' }, {
        exit: 1, kind: 'match', lines: [], specs: ['gate=wrap check=W5 counter=evalCount bop>=15'], extra: { verdict: 'FAIL' },
    }),
    // L-WRAP-TREE (S2): the tree kernel breaches W1-W4 in ONE spawn (burst 25 full size, every detail in .handoff/
    // HISTORY.md "Proposed A-B3a control specs"): W1 band-observed / band-unobserved, W2 batchEpoch cycle c()=70, W3
    // stale handle after 2^32 - 1 recycles, W4 nodeId out of [1, 2^31-1]. Matched by head only: the details flip
    // when A4 / A7 land (then this control is re-specced). ~2 min.
    W('L-WRAP-TREE', 'tree', { SOAK_WRAP: 'W1,W2,W3,W4' }, {
        exit: 1, kind: 'match', lines: [], specs: [
            'gate=wrap check=W1 counter=globalVersion',
            'gate=wrap check=W2 counter=batchEpoch',
            'gate=wrap check=W3 counter=gen',
            'gate=wrap check=W4 counter=nodeSeq',
        ],
    }),

    /* ---- short (^(?!L-)) ---- */
    // P-INTERIM-ERROR-clean (amendment 5, A2-F21; re-pointed N17.2, burst 52): L-P-INTERIM-ERROR's run on the
    // preb33 control, NO patches. preb33 is post-F21 (carries the A2-F21 qskip2 hunk) and pre-F-b33-1 (exec
    // creationAbort false: a write-cycle creation does not abort). preb33 is a controls.json kernel (includeFixed
    // true): an F21 world there would read known=DIV-F21, which KNOWN_INTERIM_CLEAN does not list -> MISS (A3' zero
    // DIV-F21 on preb33). MEASURED burst 52 (.handoff/b52-evidence/b2-mustfail-pinterim*.txt): MISS -- zero DIV-F21,
    // but preb33 ERROR shows the burst-39 tree picture: DIV-F5 x4 / DIV-F6 x2 / DIV-F22 x1 and three known=none
    // recovery-after-throw lines (2 heads). After the burst 53 triage (PLAN-F-b33-1 N19) those heads are DIV-F6 (the
    // COMPUTED pre-walk throw + equality cutoff; DIV-F6 widened), so the expected set is { exit 1, 'explained',
    // DIV-F5 / DIV-F6 / DIV-F22 }. RE-MEASURED burst 53: the widening unmasked 2 more known=none heads (main.mjs
    // prints one BREACH line per (family, lane, sig, known) and keeps FAIL_CAP = 16 records per cycle, so b52's first
    // known=none lines hid them; c-pinterim.txt MISS). Same bug via the CACHED-rethrow path, which the
    // throw-dep-computed-prewalk tagger misses (t2-SUMMARY.md, N19.6): DIV-F6's standalone shapes dropped that
    // clause and classify them; OK in .handoff/b53-evidence/c2-pinterim.txt. preb33 is frozen
    // without FIX-T (and FIX-R / the A2 batch-error fix), so its F5 / F6 / F22 lines never clear: this control stays
    // 'explained' at exit 1 permanently; a clean (exit 0, 'nobreach') control needs a FIX-T kernel. F21 teeth: test/58.
    M('P-INTERIM-ERROR-clean', 'preb33', { SOAK_LANES: 'ERROR', SOAK_CYCLES: CYC, SOAK_OPS: String(DEFAULT_OPS) }, [], {
        exit: 1, kind: 'explained', lines: [], specs: [], known: KNOWN_INTERIM_CLEAN,
    }),
    // P-NEST-TRIGGERLESS: NEST without its trigger must not false-fail. Lines: gates.mjs:380 (scenario),
    // gates.mjs:382 (taint-skip; B6: headpatched NEST cov-off O1c 0.43-0.44 > TAINT_SKIP_MAX 0.35).
    M('P-NEST-TRIGGERLESS', 'headpatched', { SOAK_LANES: 'NEST', SOAK_MUSTFAIL: 'cov-off:saved-cursor-hazard' }, ['--smoke'], {
        exit: 3, kind: 'nobreach', lines: ['soak: INCONCLUSIVE -- scenario lane=NEST missing=saved-cursor-hazard'],
        specs: ['INCONCLUSIVE scenario lane=NEST missing=saved-cursor-hazard', 'INCONCLUSIVE taint-skip lane=NEST oracle=O1c'],
    }),
    // T-cov-*: the coverage gate (gates.mjs:380), each at the smoke shape. BATCH's cov-off switch compares DECODED
    // values with Object.is (lanes/batch.mjs put, the test scenarios.mjs:236 counts a revert by), so it leaves 0
    // revert-after-mid-read hits per smoke run (burst 13; the code compare it replaced leaked 18 through the
    // VALUE_POOL aliases 0 / -1 and 1 / -3, which forced the 11 x OPS_MIN shape this control ran at until then).
    // ERROR on headpatched also carries the tolerated F21 / F22 (F21 through includeFixed: any named control kernel)
    // BREACHes (FAIL outranks INCONCLUSIVE, gates.mjs verdict), so T-cov-ERROR is 'explained' at exit 1 and still
    // needs its scenario line (amendment 13 deviation from the SPEC 9 row "exit 3, no BREACH").
    M('T-cov-BATCH', 'headpatched', { SOAK_LANES: 'BATCH', SOAK_MUSTFAIL: 'cov-off:revert-after-mid-read' }, ['--smoke'], {
        exit: 3, kind: 'nobreach', lines: [], specs: ['INCONCLUSIVE scenario lane=BATCH missing=revert-after-mid-read'],
    }),
    M('T-cov-GRAPH', 'headpatched', { SOAK_LANES: 'GRAPH', SOAK_MUSTFAIL: 'cov-off:dep-set-flip' }, ['--smoke'], {
        exit: 3, kind: 'nobreach', lines: [], specs: ['INCONCLUSIVE scenario lane=GRAPH missing=dep-set-flip'],
    }),
    M('T-cov-ERROR', 'headpatched', { SOAK_LANES: 'ERROR', SOAK_MUSTFAIL: 'cov-off:throw-dep-effect-prewalk' }, ['--smoke'], {
        exit: 1, kind: 'explained', known: KNOWN_INTERIM, lines: [], specs: ['INCONCLUSIVE scenario lane=ERROR missing=throw-dep-effect-prewalk'],
    }),
    // T-floor-BATCH: 11 x OPS_MIN performs BATCH OB 8295 < CHECK_FLOOR 10000 (config.mjs B6 note) -> gates.mjs:381.
    M('T-floor-BATCH', 'headpatched', { SOAK_LANES: 'BATCH', SOAK_CYCLES: CYC, SOAK_OPS: String(OPS_MIN) }, [], {
        exit: 3, kind: 'nobreach', lines: [], specs: ['INCONCLUSIVE checks lane=BATCH oracle=OB'],
    }),
    // T-sever: the recompute-end severTail is a no-op -> stale dep links -> O5 link-count (main.mjs:191 line).
    // The spec cannot tell the two severTail sites apart (removing the effect-run-end call at :1120 also reads
    // O5 link-count on GRAPH): ONLY the exactly-once anchor (20-space indent + FLAG_COMPUTING clear) pins :1218.
    M('T-sever', 'headpatched', { SOAK_LANES: 'GRAPH' }, ['--smoke'], {
        exit: 1, kind: 'match', lines: [], specs: ['oracle=O5 lane=GRAPH sig=link-count'],
    }, { patches: [[A_SEVER, '                    /* MUSTFAIL T-sever: severTail(node) removed */\n                    node.flags &= ~FLAG_COMPUTING;\n']] }),

    // T-cfg x16 (SPEC-B 9 row; the S5 row SOAK_ENGINE=polyfill + SOAK_KERNEL is not in S1). Lines cite their source.
    C('lanes-typo', { SOAK_LANES: 'grpah' }, "SOAK_LANES: unknown lane 'grpah' (did you mean GRAPH?)"),                 // config.mjs:375
    C('key-typo', { SOAK_LANE: 'GRAPH' }, "unknown env key 'SOAK_LANE' (did you mean SOAK_LANES?)"),                   // config.mjs:338
    C('cycles-below-floor', { SOAK_CYCLES: '5' }, "SOAK_CYCLES='5' must be an integer >= " + MIN_ACTIVE_CYCLES + ' (or 0)'),                  // config.mjs:218-224
    C('ops-zero', { SOAK_OPS: '0' }, "SOAK_OPS='0' must be an integer in [" + OPS_MIN + ', ' + OPS_MAX + ']'),                        // config.mjs:218-224
    C('ops-nan', { SOAK_OPS: 'abc' }, "SOAK_OPS='abc' must be an integer in [" + OPS_MIN + ', ' + OPS_MAX + ']'),                     // config.mjs:220
    C('seed-negative', { SOAK_SEED: '-1' }, "SOAK_SEED='-1' must be a uint32 (decimal or 0x hex)"),                   // config.mjs:229
    C('seed-overflow', { SOAK_SEED: '4294967296' }, "SOAK_SEED='4294967296' must be a uint32 in [0, 4294967295]"),    // config.mjs:231
    C('smoke-yes', { SOAK_SMOKE: 'yes' }, "SOAK_SMOKE='yes' must be exactly 1 (unset it to disable; 0/true/yes are rejected)"),   // config.mjs:236
    // kernel.mjs:38 / :41 / :46 -- the path in the line is the scratch path, filled in at run time (kernelLine)
    C('kernel-missing', { SOAK_LANES: 'GRAPH' }, 'SOAK_KERNEL: kernel file not found: ', { kernel: 'missing' }),
    C('kernel-basename', { SOAK_LANES: 'GRAPH' }, 'SOAK_KERNEL: the kernel file must be named Signal.js (got Kernel.js); Watch.js imports ./Signal.js', { kernel: 'basename' }),
    C('kernel-no-watch', { SOAK_LANES: 'GRAPH' }, 'SOAK_KERNEL: sibling Watch.js missing in ', { kernel: 'nowatch' }),
    // config.mjs:394 -- no SOAK_KERNEL (with one, config.mjs:388 the seam combination fires first)
    C('engine-typo', { SOAK_ENGINE: 'alein' }, "SOAK_ENGINE: unknown engine 'alein' (did you mean alien?)", { kernel: 'none' }),
    C('replay-malformed', { SOAK_REPLAY: 'GRAPH:x:y' }, "SOAK_REPLAY='GRAPH:x:y' must match <LANE>:<cycle>:0x<seed> (for example BATCH:7:0x9a3f12c4)"),   // config.mjs:269
    C('mustfail-unknown', { SOAK_MUSTFAIL: 'cov-off:nope' }, "SOAK_MUSTFAIL: unknown scenario 'nope'", { prefix: true }),   // + the scenario list               // config.mjs:432
    C('no-expose-gc', { SOAK_LANES: 'GRAPH' }, '--expose-gc is required (run: node --expose-gc bench/soak/main.mjs, or npm run soak)', { flags: [] }),   // config.mjs:454
    // provenance.mjs:126 -- a zero-commit repository copy (test/41 :269-301), never GIT_DIR (F6, amendment 14)
    C('provenance-no-sha', { SOAK_REQUIRE_PROVENANCE: '1', SOAK_LANES: 'GRAPH' }, 'SOAK_REQUIRE_PROVENANCE=1 but no git SHA is establishable (', { repo: 'zero-commit', prefix: true }),   // + git's own error text
]);

/** Every control name, derived from CONTROLS. */
export const CONTROL_NAMES = Object.freeze(CONTROLS.map((c) => c.name));
export const LONG_RE = /^L-/;
export const SHORT_RE = /^(?!L-)/;

/* ---- shape check and anchor staleness ------------------------------------------------------------- */

const KINDS = Object.freeze(['match', 'nobreach', 'explained']);
const CFG_KERNELS = Object.freeze(['scratch', 'missing', 'basename', 'nowatch', 'none']);
const isStrArr = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.length > 0);

/** Shape problems of one control; [] when it is valid. */
export function validSpec(c) {
    const p = [];
    if (c === null || typeof c !== 'object') return ['not an object'];
    if (typeof c.name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(c.name)) p.push('name');
    if (c.run !== 'main' && c.run !== 'cfg' && c.run !== 'wrap') p.push('run must be main | cfg | wrap');
    if (!own(BASES, c.base)) p.push('base must be one of ' + Object.keys(BASES).join('|'));
    if (c.env === null || typeof c.env !== 'object') p.push('env');
    else for (const k of Object.keys(c.env)) if (k.indexOf('SOAK_') !== 0 || typeof c.env[k] !== 'string' || k === 'SOAK_KERNEL' || k === 'SOAK_OUT') p.push('env.' + k);
    if (!isStrArr(c.argv) && !(Array.isArray(c.argv) && c.argv.length === 0)) p.push('argv');
    if (!Array.isArray(c.flags) || !c.flags.every((f) => typeof f === 'string')) p.push('flags');
    if (!Array.isArray(c.patches) || !c.patches.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && x[0].length > 0 && typeof x[1] === 'string')) p.push('patches');
    if (c.arm !== null && typeof c.arm !== 'string') p.push('arm');
    const e = c.expect;
    if (e === null || typeof e !== 'object') return p.concat(['expect']);
    if (!(Number.isInteger(e.exit) && e.exit >= 0 && e.exit <= 3)) p.push('expect.exit');
    if (KINDS.indexOf(e.kind) === -1) p.push('expect.kind must be ' + KINDS.join('|'));
    if (!Array.isArray(e.specs) || !e.specs.every((s) => typeof s === 'string' && s.split(' ').filter((t) => t && t !== 'BREACH' && t !== 'INCONCLUSIVE').length > 0)) p.push('expect.specs');
    if (!Array.isArray(e.lines) || !e.lines.every((s) => typeof s === 'string' && s.length > 0)) p.push('expect.lines');
    if (e.kind === 'explained' && !(isStrArr(e.known) && e.known.length > 0)) p.push('expect.known (explained needs the tolerated ids)');
    if (e.kind !== 'explained' && e.known !== undefined) p.push('expect.known only belongs to kind explained');
    if (c.run === 'main' || c.run === 'wrap') {
        if (e.config !== undefined || e.configMatch !== undefined) p.push('expect.config belongs to run cfg');
        if (e.kind === 'match' && e.specs.length === 0) p.push('a match control needs >= 1 spec');
        if (e.kind === 'nobreach' && e.specs.length === 0 && e.lines.length === 0 && !(e.extra && e.exit === 0)) p.push('a nobreach control needs a spec, a line or a clean exit-0 extra');
        if (e.exit === 0 && e.kind !== 'nobreach') p.push('an exit-0 control must be nobreach');
        if (e.exit === 2) p.push('exit 2 is a config control (run cfg)');
    }
    if (c.run === 'wrap') {
        // wrap.mjs exits 2 on any burn-in key, argv or another semi-space setting: say so here, not as a MISS
        const ek = c.env !== null && typeof c.env === 'object' ? Object.keys(c.env) : [];
        if (!(ek.length === 1 && ek[0] === 'SOAK_WRAP')) p.push('a wrap control sets exactly one env key, SOAK_WRAP');
        if (!(Array.isArray(c.flags) && c.flags.length === WRAP_FLAGS.length && WRAP_FLAGS.every((f, i) => c.flags[i] === f))) p.push('a wrap control runs with flags ' + WRAP_FLAGS.join(' '));
        if (!(Array.isArray(c.argv) && c.argv.length === 0)) p.push('a wrap control takes no argv');
        if (c.arm !== null) p.push('a wrap control has no arm');
        if (e.kind === 'explained') p.push('a wrap control is match | nobreach (explained needs oracle BREACH lines)');
        if (e.extra !== null && typeof e.extra === 'object' && own(e.extra, 'boundaries')) p.push('expect.extra.boundaries is a burn-in cycle-record count; a wrap control checks every wrap boundary itself');
    } else if (c.run === 'cfg') {
        if (e.exit !== 2 || e.kind !== 'nobreach') p.push('a cfg control is exit 2, kind nobreach');
        if (typeof e.config !== 'string' || !e.config.startsWith('soak: CONFIG -- ') || e.config.length <= 'soak: CONFIG -- '.length) p.push('expect.config');
        if (e.configMatch !== 'exact' && e.configMatch !== 'prefix') p.push('expect.configMatch must be exact | prefix');
        if (CFG_KERNELS.indexOf(c.kernel) === -1) p.push('kernel must be ' + CFG_KERNELS.join('|'));
        if (c.repo !== null && c.repo !== 'zero-commit') p.push('repo');
        if (c.patches.length || c.arm !== null) p.push('a cfg control patches nothing');
    }
    if (e.extra !== undefined) {
        const x = e.extra;
        if (x === null || typeof x !== 'object') p.push('expect.extra');
        else for (const k of Object.keys(x)) if (['boundaries', 'reason', 'verdict'].indexOf(k) === -1) p.push('expect.extra.' + k);
    }
    return p;
}

/** Line number (1-based) of the start of `anchor` in `src`, or null. */
const lineOf = (src, anchor) => { const i = src.indexOf(anchor); return i === -1 ? null : src.slice(0, i).split('\n').length; };

/**
 * The scratch Signal.js source of one control: its base, every patch (exactly-once, counted on the base), then
 * its arm tail. Throws on a stale anchor. Returns { src, anchors: [{file, line}] }.
 */
export function buildKernel(c) {
    const base = baseSource(c.base);
    const anchors = c.patches.map((p) => ({ file: BASES[c.base].dir.slice(ROOT.length) + sep + 'Signal.js', line: lineOf(base, p[0]) }));
    let src = c.patches.length > 0 ? patchAll(base, c.patches) : base;
    if (c.arm !== null) src += c.arm;
    return { src, anchors };
}

/** The controls whose patches do not apply exactly once. Never throws: [{name, error}]. */
export function staleAnchors(controls) {
    const out = [];
    for (const c of controls) {
        try { buildKernel(c); } catch (e) { out.push({ name: c && c.name, error: String(e && e.message ? e.message : e) }); }
    }
    return out;
}

/* ---- running --------------------------------------------------------------------------------------- */

// Every scratch dir of a RUNNING control (runControl removes its own in a finally; the CLI's exit / signal hook
// sweeps whatever a killed run left).
const cleanups = [];
function scratch(name) {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'litesignal-mustfail-' + name.replace(/[^A-Za-z0-9-]/g, '') + '-')));
    cleanups.push(d);
    return d;
}
function removeDir(d) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    const i = cleanups.indexOf(d);
    if (i !== -1) cleanups.splice(i, 1);
}
function cleanupAll() {
    while (cleanups.length) removeDir(cleanups[cleanups.length - 1]);
}

/** The inherited env minus every SOAK_* key (the control's keys are the only ones), NODE_OPTIONS and the test context. */
function childEnv(keys, dropGit) {
    const env = {};
    for (const k of Object.keys(process.env)) {
        if (k.toUpperCase().indexOf('SOAK_') === 0 || k === 'NODE_OPTIONS' || k === 'NODE_TEST_CONTEXT') continue;
        if (dropGit && k.indexOf('GIT_') === 0) continue;
        env[k] = process.env[k];
    }
    return Object.assign(env, keys);
}

/** Write a Signal.js + Watch.js directory. */
function writeKernelDir(dir, signalSrc, base, signalName) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, signalName || 'Signal.js'), signalSrc);
    copyFileSync(join(BASES[base].dir, 'Watch.js'), join(dir, 'Watch.js'));
}

/** A zero-commit repository copy of the soak layout (test/41 :269-301): its own .git with no HEAD. */
function zeroCommitDir(name) {
    const outDir = join(SOAK, 'out');
    mkdirSync(outDir, { recursive: true });
    const dir = realpathSync(mkdtempSync(join(outDir, 'mustfail-' + name.replace(/[^A-Za-z0-9-]/g, '') + '-')));
    cleanups.push(dir);
    return dir;
}
/** Fill a zeroCommitDir (the caller already owns the path, so a throw here still leaves it removable). */
function zeroCommitCopy(dir) {
    // entry by entry: cpSync refuses to copy a directory into its own subdirectory (out/), filter or not
    for (const ent of readdirSync(SOAK)) if (ent !== 'out') cpSync(join(SOAK, ent), join(dir, 'bench', 'soak', ent), { recursive: true });
    // kinds.mjs imports ../torture/helpers/index.mjs (the only import that leaves bench/soak)
    cpSync(join(ROOT, 'bench', 'torture', 'helpers'), join(dir, 'bench', 'torture', 'helpers'), { recursive: true });
    for (const f of ['Signal.js', 'Watch.js', 'package.json']) copyFileSync(join(ROOT, f), join(dir, f));
    const genv = childEnv({ GIT_CONFIG_GLOBAL: join(dir, 'no-global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, true);
    const r = spawnSync('git', ['init', '-q'], { cwd: dir, env: genv, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git init failed: ' + String(r.stderr || r.error));
    return dir;
}

const END_RE = /^soak: END verdict=(\S+) exit=(\d+) records=(\d+)$/;
const lines = (s) => String(s || '').split('\n').filter((l) => l.length > 0);

/**
 * Run one control. Returns { ok, status, problems[], secs, first }. pinProblems: the `problems` map of a
 * verifyControls() the caller already ran over this control's base; when it is omitted the pins are verified
 * HERE (an unverified base is never run). A pin mismatch is a MISS. The control's scratch dir and its zero-commit
 * copy are removed before this returns, whatever happened.
 */
export function runControl(c, pinProblems) {
    const t0 = Date.now();
    const problems = [];
    const matched = [];   // [{spec, head}]: the first protocol line each spec matched (MUSTFAIL_HEADS=1 prints them)
    let r = null;
    const fin = () => ({ ok: problems.length === 0, matched, status: r === null ? null : (r.status === null ? -1 : r.status), problems, secs: Math.round((Date.now() - t0) / 1000), first: r === null ? '' : firstLine(r) });
    const shape = validSpec(c);
    if (shape.length > 0) { problems.push('malformed control: ' + shape.join('; ')); return fin(); }
    let pins = pinProblems;
    if (pins === undefined) pins = verifyControls([c.base]).problems;
    if (pins === null || typeof pins !== 'object') { problems.push('pinProblems must be a verifyControls().problems map'); return fin(); }
    if (own(pins, c.base)) { problems.push('base ' + c.base + ' pin MISS: ' + pins[c.base]); return fin(); }
    let dir = null, repo = null;
    try {
        dir = scratch(c.name);
        const out = join(dir, 'run.jsonl');
        const kdir = join(dir, 'kernel');
        const keys = Object.assign({}, c.env, { SOAK_OUT: out });
        let main = c.run === 'wrap' ? WRAP : MAIN;
        let configLine = c.expect.config;
        if (c.run === 'main' || c.run === 'wrap' || c.kernel === 'scratch') {
            writeKernelDir(kdir, buildKernel(c).src, c.base);
            keys.SOAK_KERNEL = join(kdir, 'Signal.js');
        } else if (c.kernel === 'missing') {
            keys.SOAK_KERNEL = join(kdir, 'Signal.js');   // the directory is never created
            configLine += keys.SOAK_KERNEL;
        } else if (c.kernel === 'basename') {
            writeKernelDir(kdir, baseSource(c.base), c.base, 'Kernel.js');
            keys.SOAK_KERNEL = join(kdir, 'Kernel.js');
        } else if (c.kernel === 'nowatch') {
            mkdirSync(kdir, { recursive: true });
            writeFileSync(join(kdir, 'Signal.js'), baseSource(c.base));
            keys.SOAK_KERNEL = join(kdir, 'Signal.js');
            configLine += kdir + ' (scratch kernels are a Signal.js + Watch.js directory pair)';
        }
        if (c.run === 'cfg' && c.repo === 'zero-commit') {
            repo = zeroCommitDir(c.name);   // assigned BEFORE the copy: the finally removes it even if the copy throws
            zeroCommitCopy(repo);
            main = join(repo, 'bench', 'soak', 'main.mjs');
        }
        r = spawnSync(NODE, c.flags.concat([main], c.argv), {
            cwd: ROOT, env: childEnv(keys, c.repo === 'zero-commit'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 256 * 1024 * 1024, timeout: RUN_TIMEOUT_MS,
        });
        if (r.error) problems.push('spawn: ' + r.error.message);
        const status = r.status === null ? -1 : r.status;
        const err = lines(r.stderr), so = lines(r.stdout);
        if (status !== c.expect.exit) problems.push('exit ' + status + (r.signal ? ' (' + r.signal + ')' : '') + ' != ' + c.expect.exit);
        if (/^soak: CRASH/m.test(r.stderr) || /^soak: CRASH/m.test(r.stdout)) problems.push('CRASH line');
        if (c.run === 'cfg') {
            if (err.length !== 1) problems.push('expected ONE stderr line, got ' + err.length);
            const exact = c.expect.configMatch === 'exact';
            if (!(err.length > 0 && (exact ? err[0] === configLine : err[0].startsWith(configLine)))) {
                problems.push('CONFIG line: want ' + (exact ? 'exactly ' : 'prefix ') + JSON.stringify(configLine) + ', got ' + JSON.stringify(err[0] || ''));
            }
            if (so.length !== 0) problems.push('stdout not empty (heartbeat / END on a config exit)');
            if (existsSync(out)) problems.push('a stream file was written on a config exit');
            return fin();
        }
        judgeMain(c, r, err, so, out, problems, matched);
    } catch (e) {
        problems.push('harness: ' + String(e && e.stack ? e.stack.split('\n')[0] : e));
    } finally {
        if (repo !== null) removeDir(repo);
        if (dir !== null) removeDir(dir);
    }
    return fin();
}

/** A protocol line's head: the text before ` detail=` (the part hasToken matches). */
const headOf = (l) => { const d = l.indexOf(' detail='); return d === -1 ? l : l.slice(0, d); };

function judgeMain(c, r, err, so, out, problems, matched) {
    const e = c.expect;
    for (const sp of e.specs) {
        const hit = err.find((l) => hasToken(l, sp));
        if (hit === undefined) problems.push('no line matches spec [' + sp + ']');
        else matched.push({ spec: sp, head: headOf(hit) });
    }
    for (const l of e.lines) if (err.indexOf(l) === -1) problems.push('missing line ' + JSON.stringify(l));
    const breach = err.filter((l) => l.startsWith(BREACH_PFX));
    if (e.kind === 'nobreach' && breach.length > 0) problems.push(breach.length + ' BREACH line(s) on a nobreach control: ' + breach[0].slice(0, 140));
    if (e.kind === 'explained') {
        if (breach.length === 0) problems.push('explained control saw no BREACH');
        for (const l of breach) {
            const h = parseHead(l);
            const known = h.pairs.get('known');
            if (!h.pairs.has('oracle') || !known || known.length !== 1 || !known[0].split('+').every((id) => e.known.indexOf(id) !== -1)) {
                problems.push('unexplained BREACH: ' + l.slice(0, 160));
                break;
            }
        }
    }
    // END sentinel: the last stdout line, consistent with the exit and the stream
    const last = so.length ? so[so.length - 1] : '';
    const m = END_RE.exec(last);
    if (m === null) { problems.push('no END sentinel as the last stdout line: ' + JSON.stringify(last.slice(0, 100))); return; }
    if (Number(m[2]) !== (r.status === null ? -1 : r.status)) problems.push('END exit=' + m[2] + ' != child exit');
    let recs = [];
    try { recs = readFileSync(out, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l)); } catch (x) { problems.push('stream unreadable: ' + x.message); return; }
    if (recs.length !== Number(m[3])) problems.push('END records=' + m[3] + ' != stream ' + recs.length);
    const summary = recs.length ? recs[recs.length - 1] : null;
    if (!summary || summary.type !== 'summary') problems.push('stream does not end with its summary');
    const x = e.extra;
    if (x && x.reason !== undefined && !(summary && summary.reason === x.reason)) problems.push('summary reason ' + String(summary && summary.reason) + ' != ' + x.reason);
    if (x && x.verdict !== undefined && m[1] !== x.verdict) problems.push('END verdict ' + m[1] + ' != ' + x.verdict);
    if (c.run === 'wrap') {
        // replaces the boundaries + SoakReport steps below (SoakReport has no wrap-stream dispatch: INTEGRITY)
        for (const q of wrapJudge(c, recs, m[1], err)) problems.push(q);
        return;
    }
    if (x && x.boundaries !== undefined) {
        const cyc = recs.filter((q) => q.type === 'cycle');
        if (cyc.length !== x.boundaries) problems.push('boundaries ' + cyc.length + ' != ' + x.boundaries);
        const dirty = cyc.filter((q) => !(q.boundary && q.boundary.trackerSize === 0 && q.boundary.weakAlive === 0));
        if (dirty.length) problems.push(dirty.length + ' boundary(ies) with trackerSize/weakAlive != 0, first ' + dirty[0].lane + ':' + dirty[0].cycle + ' ' + JSON.stringify(dirty[0].boundary));
    }
    // SoakReport re-derivation (spawned: the real CLI, isolated from this process)
    const rep = spawnSync(NODE, [REPORT, out], { cwd: ROOT, env: childEnv({}, false), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: REPORT_TIMEOUT_MS });
    const want = 'soak:report: verdict ' + m[1] + ' (consistent)';
    const rout = lines(rep.stdout), rerr = lines(rep.stderr);
    if (rout.indexOf(want) === -1) problems.push('SoakReport did not print ' + JSON.stringify(want) + ': ' + (rerr[0] || rout[rout.length - 1] || '').slice(0, 160));
    else if (!(rep.status === 0 || (rep.status === 1 && rerr.length === 1 && rerr[0].startsWith('soak:report: NOT A RELEASE SOAK -- ')))) problems.push('SoakReport exit ' + rep.status + ': ' + (rerr[0] || '').slice(0, 160));
}

/**
 * The stream checks of a wrap control (run 'wrap'). Pure (test/45 drives it on forged streams): c = the
 * control, recs = the parsed stream records in file order, endVerdict = the END line's verdict, err = the
 * child's stderr lines. Returns problem strings ([] = the stream backs the control). Fail closed:
 *   - wraprules.mjs wrapStreamProblems(recs) must be [] (its own re-derivation, independent of wrap.mjs);
 *   - the header's SOAK_WRAP selection equals the control's c.env.SOAK_WRAP (the run judged what was asked);
 *   - the summary reason is 'end' (or the control's extra.reason), and at reason 'end' wrapRule over the wrap
 *     records with the header's SOAK_WRAP selection equals endVerdict (a throw is a problem);
 *   - >= 1 wrap record, and EVERY wrap record's values.boundary reads trackerSize === 0 and weakAlive === 0
 *     (a missing or non-zero value is a problem: null is not zero);
 *   - INCONCLUSIVE, re-derived and printed: every cause wrapRule re-derives from the records (a missing pair, an
 *     unwitnessed crossing, an unmeasured W5 side) renders through gates.mjs inconclusiveLine and must have been
 *     printed (stderr or summary.inconclusive); and every INCONCLUSIVE line, printed or re-derived, must be one
 *     the control expects (an INCONCLUSIVE spec matches it, or it is in expect.lines). The oracle is the stream's
 *     records, never only what the child chose to print: an unexpected cause never rides along under a FAIL.
 */
export function wrapJudge(c, recs, endVerdict, err) {
    const p = [];
    if (!Array.isArray(recs) || recs.length === 0) return ['wrap stream: no records'];
    for (const q of wrapStreamProblems(recs)) p.push('wrap stream: ' + q);
    const e = c.expect, x = e.extra;
    const head = recs[0];
    const sum = recs[recs.length - 1];
    const wraps = recs.filter((r) => r !== null && typeof r === 'object' && r.type === 'wrap');
    if (wraps.length === 0) p.push('wrap stream: no wrap record');
    const reason = sum !== null && typeof sum === 'object' ? sum.reason : undefined;
    const wantReason = x && x.reason !== undefined ? x.reason : 'end';
    if (reason !== wantReason) p.push('wrap summary reason ' + String(reason) + ' != ' + wantReason);
    const sel = head && head.config && head.config.SOAK_WRAP ? head.config.SOAK_WRAP.value : undefined;
    const want = c.env && typeof c.env.SOAK_WRAP === 'string' ? c.env.SOAK_WRAP.split(',').map((w) => w.trim()) : null;
    if (!(Array.isArray(sel) && want !== null && sel.length === want.length && sel.every((w, i) => w === want[i]))) {
        p.push('header SOAK_WRAP ' + JSON.stringify(sel) + ' != control SOAK_WRAP ' + JSON.stringify(want));
    }
    let derived = [];
    try {
        const j = wrapRule(wraps, sel);
        if (reason === 'end' && j.verdict !== endVerdict) p.push('wrapRule verdict ' + j.verdict + ' != END verdict ' + String(endVerdict));
        derived = j.causes.map((q) => inconclusiveLine(q.cause, q));
    } catch (z) { p.push('wrapRule: ' + z.message); }
    for (const r of wraps) {
        const b = r.values && r.values.boundary;
        if (!(b && b.trackerSize === 0 && b.weakAlive === 0)) {
            p.push('wrap ' + String(r.check) + '/' + String(r.counter) + ' boundary trackerSize=' + String(b && b.trackerSize) + ' weakAlive=' + String(b && b.weakAlive) + ' (want 0 / 0)');
        }
    }
    const incSpecs = e.specs.filter((sp) => sp.split(' ')[0] === 'INCONCLUSIVE');
    const expected = (l) => e.lines.indexOf(l) !== -1 || incSpecs.some((sp) => hasToken(l, sp));
    const inc = (Array.isArray(err) ? err : []).filter((l) => l.startsWith(INC_PFX));
    if (sum && Array.isArray(sum.inconclusive)) for (const l of sum.inconclusive) if (inc.indexOf(l) === -1) inc.push(l);
    for (const l of derived) {
        if (inc.indexOf(l) === -1) {
            p.push('INCONCLUSIVE re-derived by wrapRule but never printed: ' + l.slice(0, 140));
            inc.push(l);
        }
    }
    for (const l of inc) if (!expected(l)) p.push('unexpected INCONCLUSIVE: ' + String(l).slice(0, 140));
    return p;
}

function firstLine(r) {
    const m = String(r.stderr || '').match(/^soak: (CRASH|BREACH|CONFIG|INCONCLUSIVE) .*/m);
    return m ? m[0].slice(0, 120) : '';
}

/* ---- CLI ------------------------------------------------------------------------------------------- */

function select(long) {
    const raw = process.env.MUSTFAIL_ONLY;
    const only = raw === undefined ? null : new RegExp(raw);
    const part = long ? LONG_RE : SHORT_RE;
    return CONTROLS.filter((c) => part.test(c.name) && (only === null || only.test(c.name)));
}

let HEADS = false;
function cli() {
    const args = process.argv.slice(2);
    for (const a of args) if (a !== '--long') { process.stderr.write("_mustfail: unknown argument '" + a + "' (the only argument is --long)\n"); return 2; }
    const long = args.length > 0;
    if (process.env.MUSTFAIL_LIST !== undefined && process.env.MUSTFAIL_LIST !== '1') {
        process.stderr.write("_mustfail: MUSTFAIL_LIST='" + process.env.MUSTFAIL_LIST + "' must be exactly 1\n");
        return 2;
    }
    const LIST = process.env.MUSTFAIL_LIST === '1';
    if (process.env.MUSTFAIL_HEADS !== undefined && process.env.MUSTFAIL_HEADS !== '1') {
        process.stderr.write("_mustfail: MUSTFAIL_HEADS='" + process.env.MUSTFAIL_HEADS + "' must be exactly 1\n");
        return 2;
    }
    HEADS = process.env.MUSTFAIL_HEADS === '1';
    let sel;
    try {
        // LIST builds the WHOLE battery (both partitions), narrowed only by MUSTFAIL_ONLY
        sel = LIST ? CONTROLS.filter((c) => process.env.MUSTFAIL_ONLY === undefined || new RegExp(process.env.MUSTFAIL_ONLY).test(c.name)) : select(long);
    } catch (e) {
        process.stderr.write('_mustfail: MUSTFAIL_ONLY is not a regex: ' + e.message + '\n');
        return 2;
    }
    if (sel.length === 0) { process.stderr.write('_mustfail: the selection is empty\n'); return 2; }
    for (const c of sel) {
        const bad = validSpec(c);
        if (bad.length) { process.stderr.write('_mustfail: control ' + c.name + ' is malformed: ' + bad.join('; ') + '\n'); return 1; }
    }
    if (LIST) {
        // build EVERY mutant before printing anything: a stale anchor exits 1 with no partial listing
        const built = new Map();
        for (const c of sel) {
            if (!(c.run === 'main' || c.run === 'wrap' || c.kernel === 'scratch')) { built.set(c.name, []); continue; }
            try { built.set(c.name, buildKernel(c).anchors); } catch (e) {
                process.stderr.write('_mustfail: ' + c.name + ': ' + e.message + '\n');
                return 1;
            }
        }
        for (const c of sel) {
            const anchors = built.get(c.name);
            process.stdout.write(JSON.stringify({
                name: c.name, run: c.run, base: c.base, long: LONG_RE.test(c.name), env: c.env, argv: c.argv, flags: c.flags,
                kind: c.expect.kind, exit: c.expect.exit, specs: c.expect.specs, lines: c.expect.lines,
                config: c.expect.config === undefined ? null : c.expect.config, configMatch: c.expect.configMatch || null, known: c.expect.known || null, anchors,
                arm: c.arm !== null,
            }) + '\n');
        }
        process.stdout.write(JSON.stringify({ end: true, count: sel.length }) + '\n');
        return 0;
    }
    const bases = [];
    for (const c of sel) if (bases.indexOf(c.base) === -1) bases.push(c.base);
    const pins = verifyControls(bases);
    for (const b of Object.keys(pins.problems)) process.stdout.write('  PIN  ' + b + ': ' + pins.problems[b] + '\n');
    let ok = 0, miss = 0;
    for (const c of sel) {
        const res = runControl(c, pins.problems);
        if (res.ok) ok++; else miss++;
        process.stdout.write('  ' + (res.ok ? 'OK  ' : 'MISS') + ' ' + c.name.padEnd(28) + ' exit=' + res.status + ' want=' + c.expect.exit + ' ' + res.secs + 's' +
            (res.ok ? '' : '  <<< ' + res.problems.join(' | ') + (res.first ? ' || first: ' + res.first : '')) + '\n');
        if (HEADS) for (const m of res.matched) process.stdout.write('       [' + m.spec + '] -> ' + m.head + '\n');
    }
    process.stdout.write(ok + ' OK / ' + miss + ' MISS\n');
    return miss === 0 ? 0 : 1;
}

/** Run the CLI only when this file is the process entry (test/45 and teeth.mjs import the exports above). */
function isEntry() {
    if (!process.argv[1]) return false;
    try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntry()) {
    process.on('exit', cleanupAll);
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { cleanupAll(); process.exit(130); });
    let code;
    try { code = cli(); } finally { cleanupAll(); }
    process.exitCode = code;
}
