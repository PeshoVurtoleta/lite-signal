/**
 * @zakkster/lite-signal soak -- NEARWRAP: a kernel derived from the pinned Signal.js with every census counter
 * preset to `ceiling - k` (SPEC-B addendum 9e; SPEC-S2 group A TASKS 1 and 7).
 *
 *   REWRITES  the census counters' initializer anchors (exactly-once each) and their bump witnesses
 *   derive    derive(src, {phase, k}) -> { text, rewrites[], baseSha256, derivedSha256 }
 *
 * The randomized lanes never run near a ceiling. NEARWRAP runs them, unchanged, on a kernel whose counters
 * start k steps below a crossing, so the wrap / rebase / retirement / id paths fire mid-script. Shipped code
 * gets no test hook: the kernel TEXT is rewritten at load (kernel.mjs, task 10), and the header records the
 * derived sha256 and the rewrite list.
 *
 * Invariant (TASK 1): each world is a fresh registry, so a preset equals "N real ops whose nodes all died".
 * That holds for the node stamps because createNode resets version, evalVersion and markEpoch to 0 and
 * dispose resets revertEpoch / preBatchVersion to 0 on every allocation, so no stamp outlives its node; it
 * holds for gen because a fresh-built slot preset to G is a slot recycled G times. The signed-distance order
 * invariant (`((a-b)|0) > 0`) is kept by construction: every stamp is assigned FROM the preset counter, so
 * every distance the engine takes is between two values of the same (preset) sequence. What a preset does
 * break is the 0 "unset" sentinel when the counter can reach 0 -- that is a FINDING, not a lane artifact.
 *
 * Phases (k = 1..K_LIMIT; config.mjs NEARWRAP_K_MAX caps it lower, task 9):
 *   sign  start 2^31 - k: the k-th bump crosses 2^31 (int32: to -2^31; float64: the Smi -> HeapNumber edge)
 *   zero  int32 start -k (== 2^32 - k mod 2^32): the k-th bump reaches 0, the "unset" sentinel value;
 *         float64 start 2^32 - k: the k-th bump crosses 2^32 (where an int32 counter would alias)
 * The arithmetic class of each counter is read from the source (its bump witness), never assumed.
 * Census completeness: every int32 `x = (x + 1) | 0` or 0-skipping `x = ((x + 1) | 0) || 1` bump in the source
 * (bare or as the right side of a chained `o.f = x = ...`) must be a census counter or one of
 * BOUNDED (live counts and depths, bounded by the node population or the JS stack, never near 2^31); any
 * other one is a counter the census missed -> SoakConfigError (tree / hp today: activeLinks, activeNodes,
 * batchDepth, lifecycleCount + the census counters; cursorDepth is bumped as `d + 1`, a Smi stack depth).
 * KNOWN GAP (reviewer nit): the guard sees `x` and `o.f` bumps only -- not `a.b.c` member bumps, nor `>>> 0` /
 * `& MASK` spellings. Today's census is exact for both kernels; a new spelling needs a guard update.
 *
 * ---- TASK 1 census (read-only; tree Signal.js sha256 bfd063e5 @ 8b9c013, headpatched fa2871f0) -----------
 * Line numbers are the base files' at the census; the ANCHORS below, not these numbers, are what derive uses.
 * Every tree number in this header is @ bfd063e5 (pre-F29), a dated record, not renumbered. F29 skips (head terms):
 * read.set 1447, boxSet 1552 (@ 0ed7c8e2), spelled `x = ((x + 1) | 0) || 1` (read.set chains it into
 * node.version); both spellings are int32 bump witnesses.
 *
 * Counters (closure `let` unless noted)      tree @ bfd063e5 (pre-F29): init / bump  headpatched: init / bump
 *   globalVersion  int32                     408 / 1445, 1550 `(v+1)|0`      400 / 1328, 1435 `(v+1)|0`
 *   batchEpoch     int32, 0 skipped          409 / 1760 + guard 1765         402 / 1646 + guard 1651
 *   nodeSeq        int32                     437 / 877                       410 / 834
 *   evalCount      float64, equality-only    absent                          401 / 1115, 1193 `++`
 *   statTotalAllocations  float64 `++`       398 / 857                       390 / 814
 *   statTotalDisposals    float64 `++`       399 / 835                       391 / 771
 *   gen (ReactiveNode field)                 112 / 817, 1947 `(gen+1)|0`     102 / 767, 1837 `gen+1` float64 (FIX-G)
 *                                            int32 (1947 = destroy's n.gen)
 *   destroy() resets globalVersion / batchEpoch / statTotal* (tree @ bfd063e5 1987-1993, hp 1877-1883): not rewritten
 *   (a destroyed registry is never reused by a lane; destroy is the end of a world).
 *
 * Signed-distance compares `((a-b)|0)`:
 *   tree @ bfd063e5 (pre-F29):
 *         1184 executeEffect  ((dep.version - evalVer)|0) > 0
 *         1260 pullComputed   ((node.markEpoch - node.evalVersion)|0) <= 0     (guarded: evalVersion !== 0)
 *         1277 pullComputed   ((dep.version - evalVer)|0) > 0
 *   hp    1080, 1154, 1167    the same three
 *         944  isOldStamp     d = (gv - st)|0; d > 2^30 || d < 0               (guarded: st === 0 -> false, 943)
 *         949  clampSweep     F = (gv - 2^30)|0                                (guarded: F 0 / -1 -> -2, 950)
 * `=== 0` / `!== 0` sentinel tests:
 *   tree @ bfd063e5 (pre-F29):
 *         1174 evalVersion !== 0 (executeEffect pre-walk)   1260 evalVersion !== 0 (clean short-circuit)
 *         1267 shouldRun = evalVersion === 0                1310 evalVersion === 0 || ... (equality cutoff bypass)
 *         1765 batchEpoch === 0 -> 1 (the counter skips its sentinel)
 *   hp    1072, 1154, 1160, 1197 (the same four)           1651 batchEpoch guard
 *         943 st === 0   950 F === 0 || F === -1   1329, 1436 (globalVersion & 0x1FFFFFFF) === 0 -> clampSweep
 * Equality compares against a stamp whose reset value is 0 (an implicit 0 sentinel):
 *   tree @ bfd063e5 (pre-F29):
 *         1059 markDownstream t.markEpoch !== gv     1252 pullComputed evalVersion === globalVersion
 *         1435/1441/1540/1546 revertEpoch !== / === batchEpoch (safe: batchEpoch never 0)
 *   hp    975, 1146, 1317/1324/1424/1431 (+ preBatchEvals === evalCount, float64, no sentinel)
 * gen / id: gen is equality-only (savedGen / birthGen / NODE_GEN / schedulerThunk); its only 0 is the
 *   `po !== null ? po.gen : 0` default, guarded by the null test. id has no sentinel test in either kernel.
 * Locals initialised from a census counter (all re-read per call, so a preset keeps them consistent):
 *   tree @ bfd063e5 (pre-F29):
 *         let shouldRun 1267; const gv 1047; evalVer 1176, 1270; savedGen 1172, 1266; birthGen 1412, 1476,
 *         1703; gen 1686; g 748; sg/tg 511; pg/pwg 444, 451, 1014-1015, 1365, 1571, 1799, 1831-1832, 1844-1845
 *   hp    let F 949; let shouldRun 1160; const gv 948, 963; evalVer 1074, 1163; savedGen 1113, 1191; birthGen
 *         1294, 1360, 1589; gen 1572; lcGens[] 441; lifecycle entry gen 1900
 *
 * FINDING F29 (both kernels; WITNESSED b17 by NEARWRAP zero:k; FIXED tree, SPEC-A A13; headpatched keeps it):
 *   globalVersion's bump had no 0-skip (batchEpoch's has), but evalVersion and markEpoch use 0 as "unset".
 *   The tree kernel now skips 0 at both bumps (read.set, boxSet), so (a)-(c) below are the headpatched control's.
 *   On the write that makes globalVersion 0:
 *   (a) pullComputed's fast path `evalVersion === globalVersion` (tree @ bfd063e5 1252, hp 1146) has no `!== 0` guard:
 *       a computed first read while globalVersion is 0 returns its unset cache without running its body or
 *       linking its deps -- a stale read that nothing downstream re-marks.
 *   (b) markDownstream's `t.markEpoch !== gv` (tree @ bfd063e5 1059, hp 975) skips every subscriber still at the reset
 *       markEpoch 0: that write marks / queues none of them (a lost notification for that write).
 *   (c) a node evaluated at globalVersion 0 stamps evalVersion 0 and reads as never evaluated (tree @ bfd063e5 1174,
 *       1260, 1267, 1310; hp 1072, 1154, 1160, 1197): conservative extra runs, equality cutoff bypassed.
 *
 * COLD module (runs once, at kernel load). Errors are SoakConfigError: config / kernel code maps them to exit 2.
 */

import { createHash } from 'node:crypto';
import { SoakConfigError } from './config.mjs';

const TWO31 = 2147483648;
const TWO32 = 4294967296;
const K_LIMIT = 0x3FFFFFFF;   // structural: keeps every preset start inside int32 (config caps k far lower)
const PHASES = Object.freeze(['sign', 'zero']);
const OPT_KEYS = Object.freeze(['phase', 'k']);

const BOUNDED = Object.freeze(['activeLinks', 'activeNodes', 'batchDepth', 'cursorDepth', 'lifecycleCount']);

function fail(msg) { throw new SoakConfigError('NEARWRAP: ' + msg); }

/** Bump witnesses of the counter expressions `xs` (every bump site's spelling): which arithmetic class it uses. */
function bumps(...xs) {
    const int32 = [], float64 = [];
    for (const x of xs) {
        int32.push(x + ' = (' + x + ' + 1) | 0', x + ' = ((' + x + ' + 1) | 0) || 1');   // plain | F29 0-skip
        float64.push(x + '++', x + ' = ' + x + ' + 1', x + ' += 1');
    }
    return Object.freeze({ int32: Object.freeze(int32), float64: Object.freeze(float64) });
}

function entry(o) {
    o.anchor = o.lhs + ' = ' + o.init + ';';
    return Object.freeze(o);
}

/**
 * The census counters (TASK 1). Each entry rewrites ONE initializer: `anchor` (= lhs + ' = ' + init + ';') must
 * occur exactly once (0 or 2+ -> SoakConfigError) and becomes lhs + ' = ' + start + ';'. `required: false`
 * (evalCount) may be absent from a kernel, but only if its identifier appears NOWHERE in the source; a kernel that uses the counter without the anchor
 * is a stale census, not a skip. The bump witnesses decide int32 vs float64: exactly one class must be present.
 */
export const REWRITES = Object.freeze([
    entry({ counter: 'globalVersion', required: true, lhs: 'let globalVersion', init: '1', ident: 'globalVersion', bumps: bumps('globalVersion') }),
    entry({ counter: 'batchEpoch', required: true, lhs: 'let batchEpoch', init: '1', ident: 'batchEpoch', bumps: bumps('batchEpoch') }),
    entry({ counter: 'nodeSeq', required: true, lhs: 'let nodeSeq', init: '1 | 0', ident: 'nodeSeq', bumps: bumps('nodeSeq') }),
    // headpatched only (FIX-R); absent from the tree kernel, where the identifier must not appear at all
    entry({ counter: 'evalCount', required: false, lhs: 'let evalCount', init: '0', ident: 'evalCount', bumps: bumps('evalCount') }),
    entry({ counter: 'statTotalAllocations', required: true, lhs: 'let statTotalAllocations', init: '0', ident: 'statTotalAllocations', bumps: bumps('statTotalAllocations') }),
    entry({ counter: 'statTotalDisposals', required: true, lhs: 'let statTotalDisposals', init: '0', ident: 'statTotalDisposals', bumps: bumps('statTotalDisposals') }),
    // gen lives on nodes: the rewrite targets the ReactiveNode constructor (its doc line pins the site).
    // Bump sites: disposeNode `node.gen`, destroy `n.gen`.
    entry({
        counter: 'gen', required: true, init: '0', ident: 'gen', bumps: bumps('node.gen', 'n.gen'),
        lhs: '/** Recycle generation: bumped on dispose, used to invalidate stale scheduler closures and disposer handles. */\n        this.gen',
    }),
]);

/** int32 `x = (x + 1) | 0` / `x = ((x + 1) | 0) || 1` bumps (a property bump `o.f` names `f`) that are neither census nor BOUNDED. */
function uncensused(src) {
    const known = REWRITES.map((r) => r.counter).concat(BOUNDED);
    const re = /(^|[^\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?) = (?:\(\2 \+ 1\) \| 0|\(\(\2 \+ 1\) \| 0\) \|\| 1)/g;
    const out = [];
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        const name = m[2].slice(m[2].lastIndexOf('.') + 1);
        if (known.indexOf(name) === -1 && out.indexOf(name) === -1) out.push(name);
    }
    return out;
}

/** Every start offset of `anchor` in `src`; overlapping matches count (_mustfail.mjs `occurrences`). */
function occurrences(src, anchor) {
    const at = [];
    for (let i = src.indexOf(anchor); i !== -1; i = src.indexOf(anchor, i + 1)) at.push(i);
    return at;
}

function countIdent(src, ident) {
    const re = new RegExp('(^|[^A-Za-z0-9_$])' + ident + '(?![A-Za-z0-9_$])', 'g');
    let n = 0;
    while (re.exec(src) !== null) n++;
    return n;
}

function arithOf(src, rw) {
    const has = (list) => list.some((tok) => occurrences(src, tok).length !== 0);
    const i32 = has(rw.bumps.int32), f64 = has(rw.bumps.float64);
    if (i32 === f64) fail('stale census: ' + rw.counter + ' has ' + (i32 ? 'both int32 and float64' : 'no recognised') + ' bump (expected one of ' + rw.bumps.int32.concat(rw.bumps.float64).join(' | ') + ')');
    return i32 ? 'int32' : 'float64';
}

function startOf(arith, phase, k) {
    if (phase === 'sign') return TWO31 - k;
    return arith === 'int32' ? -k : TWO32 - k;
}

function readOpts(opts) {
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts) || Object.getPrototypeOf(opts) !== Object.prototype) {
        fail('options must be a plain object {phase, k}');
    }
    if (Object.getOwnPropertySymbols(opts).length !== 0) fail('options must not carry Symbol keys');
    for (const key of Object.keys(opts)) if (OPT_KEYS.indexOf(key) === -1) fail('unknown option ' + JSON.stringify(key) + ' (expected one of ' + OPT_KEYS.join(', ') + ')');
    if (PHASES.indexOf(opts.phase) === -1) fail('phase must be one of ' + PHASES.join('|') + ', got ' + JSON.stringify(opts.phase));
    if (!(Number.isSafeInteger(opts.k) && opts.k >= 1 && opts.k <= K_LIMIT)) fail('k must be an integer in [1, ' + K_LIMIT + '], got ' + String(opts.k));
    return { phase: opts.phase, k: opts.k };
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Derive the NEARWRAP kernel text from a base Signal.js source. Every applicable REWRITES anchor must occur
 * exactly once in `src` (counted against the ORIGINAL source, like _mustfail.mjs patchAll; replacements never
 * see each other's output); spans never overlap. The replacement only changes the initializer literal, so the
 * derived text has the base's line numbers.
 * -> { text, rewrites: [{counter, arith, line, from, to}] (REWRITES order; line = the rewritten line, 1-based),
 *      baseSha256, derivedSha256 } (sha256 hex of the utf8 base and derived texts)
 */
export function derive(src, opts) {
    if (typeof src !== 'string' || src.length === 0) fail('the base kernel source must be a non-empty string');
    const { phase, k } = readOpts(opts);
    const missed = uncensused(src);
    if (missed.length !== 0) fail('stale census: int32 counter(s) outside REWRITES and BOUNDED: ' + missed.join(', '));
    const spans = [], rewrites = [];
    for (const rw of REWRITES) {
        const anchor = rw.anchor;
        const at = occurrences(src, anchor);
        if (at.length === 0 && !rw.required) {
            const uses = countIdent(src, rw.ident);
            if (uses !== 0) fail('stale census: ' + rw.counter + ' appears ' + uses + ' time(s) but its initializer anchor is missing: ' + JSON.stringify(anchor.slice(0, 60)));
            continue;
        }
        if (at.length !== 1) fail('stale anchor: ' + at.length + ' matches: ' + JSON.stringify(anchor.slice(0, 60)));
        const arith = arithOf(src, rw);
        const start = String(startOf(arith, phase, k));
        const from = at[0];
        let line = 1;
        for (let i = src.indexOf('\n'); i !== -1 && i < from + rw.lhs.lastIndexOf('\n') + 1; i = src.indexOf('\n', i + 1)) line++;
        spans.push({ from, to: from + anchor.length, repl: rw.lhs + ' = ' + start + ';' });
        rewrites.push({ counter: rw.counter, arith, line, from: rw.init, to: start });
    }
    spans.sort((a, b) => a.from - b.from);
    for (let i = 1; i < spans.length; i++) {
        if (spans[i].from < spans[i - 1].to) fail('overlapping anchors at offsets ' + spans[i - 1].from + ' and ' + spans[i].from);
    }
    let text = '', pos = 0;
    for (const s of spans) { text += src.slice(pos, s.from) + s.repl; pos = s.to; }
    text += src.slice(pos);
    return { text, rewrites, baseSha256: sha256(src), derivedSha256: sha256(text) };
}
