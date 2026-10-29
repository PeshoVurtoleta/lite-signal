/**
 * @zakkster/lite-signal soak -- SHRINK one failing world to a minimal op script (SPEC-B v2 sections 1, 2;
 * S1c TASK 8).
 *
 *   SOAK_REPLAY=<LANE>:<cycle>:0x<seed> SOAK_SHRINK=1 node --expose-gc bench/soak/shrink.mjs  (npm run soak:shrink)
 *   SOAK_REPLAY=... SOAK_SHRINK=1 node --expose-gc bench/soak/main.mjs                       (main dispatches here)
 *
 * TARGET. The key is located and played exactly as replay.mjs does (locateAndPlay: index solved, never
 * scanned; reachability forward-played against SOAK_OPS; unreachable -> exit 2, nothing written). The
 * target is the played world's failure as a SET of `<family>:<sig>` keys (main.mjs familyKeys). A world
 * that runs clean on this kernel has nothing to shrink: exit 3 (INCONCLUSIVE, never 0: no claim is made
 * about the failure the key once carried), and the artifacts below still record that (target []).
 *
 * PREDICATE. A candidate script reproduces iff runWorld() on a FRESH world (a new registry through the same
 * main.mjs tap) returns a failure whose familyKeys set EQUALS the target set. A throw (exec, model, kernel,
 * an invalid candidate), a clean run, a superset or a different sig is NOT a hit. Every run is counted; at
 * SHRINK_MAX_RUNS the budget is exhausted and every further test answers "no" (never a hit), so the result
 * is still a reproducing script, only possibly not minimal (budgetExhausted: true in the json).
 *
 * ALGORITHM (each accepted step strictly simplifies, so the loop terminates even without the budget):
 *   1. truncate after the failing step (exec stops there, so the tail never ran), verified by the predicate
 *   2. ddmin (Zeller and Hildebrandt, 1-minimal) over the top-level ops
 *   3. argument simplification, every site re-enumerated after each accepted change:
 *        lists    ddmin over batch / seq bodies (an empty batch body is legal), read.is, burst.vs and a body
 *                 spec's refs d / pre / post (>= 1 ref where the kind needs one)
 *        flags    drop chk (+cs), pull, u, thr, eq, dis, cyc, rank, role; a spec's thr, try, w (+inc)
 *        values   a value code -> 0, then 1, then v >> 1 (a pool / bomb code -> 0, 1)
 *        kinds    select / cond / hash -> sum over the same refs
 *   4. repeat 2-3 until a pass changes nothing (at most SHRINK_MAX_PASSES)
 *   A final CONFIRM run re-checks the minimal script; if it does not reproduce (a non-deterministic
 *   failure), the artifacts say confirmed: false and the exit is 3.
 *
 * ARTIFACTS (always written once the world was played, i.e. on exit 1 and exit 3):
 *   shrink-<LANE>-0x<seed>.json      {kind, key, lane, cycle, seed, world, worldSeed, large, covOff, target[],
 *                                     reproduced, confirmed, ops, subOps, opsOriginal, predicateRuns,
 *                                     maxRuns, budgetExhausted, passes, script, scriptDigest, genVersion,
 *                                     engine, kernel {url, files [{path, sha256}]}, node, createdAt}
 *   shrink-<LANE>-0x<seed>.test.mjs  a self-contained check: it runs the embedded minimal script through
 *                                     exec.mjs and the lite-s3 adapter (adapters/lite-s3.mjs liteS3Adapter: the
 *                                     S3 lanes' ops self-check, e.g. CAPACITY's capacity() echo; D-b143-1a; the
 *                                     kernel comes from the SOAK_KERNEL env seam, kernel.mjs; it takes NO
 *                                     argv) and exits 1 when the target reproduces, 0 when the
 *                                     script runs clean, 3 on a different failure, 2 on config or a harness
 *                                     throw: SOAK_KERNEL unset or not ABSOLUTE (amendment 11: never the live
 *                                     Signal.js), a soak module that fails to load (every import is dynamic,
 *                                     inside its try), an exec throw. Target [] = a world that was clean when
 *                                     shrunk: any failure is 1.
 *   <seed> is the key's seed exactly as the key prints it (0x + lower-case hex, no padding).
 *   Directory: bench/soak/out/ (git-ignored) by default; with SOAK_OUT=<path> both files go into
 *   dirname(<path>) and <path> itself is NOT created (a shrink writes no JSONL stream). Existing artifacts
 *   of the same key are overwritten. The emitted test imports the bench/soak modules by ABSOLUTE file URL
 *   and requires an ABSOLUTE SOAK_KERNEL, so it runs from wherever it is written and from any cwd.
 *
 * --emit-test (shrink.mjs argv only; config.mjs parseConfig args): ALSO a kernel-only
 *   shrink-<LANE>-0x<seed>.standalone.test.mjs beside the .test.mjs (emit.mjs: a node:test file importing node:*
 *   and the SOAK_KERNEL module only, asserting the failing oracle's model values; its exit contract is in
 *   emit.mjs). The json gains emitted, standalone (absolute path or null) and emitReason (null or why not),
 *   right before createdAt; the SHRINK line gains ` standalone=<path|->`. Exit 1 emitted; exit 3 as above with
 *   emitReason 'not-reproduced: ...' / 'unconfirmed: ...'; exit 2 refused (emit.mjs emittable, first match of
 *   lane / target / op / flag / key / kind / value / detail; every O6 lane is refused, D-b143-1b) with one
 *   `soak: CONFIG -- shrink --emit-test: no standalone test for <key>: <reason>` line and no END line. A key
 *   that does not emit leaves no standalone on disk (a stale one is deleted); the json and .test.mjs are
 *   written either way. Without the flag the json and stdout are byte-identical to a shrink without it.
 *
 * stdout: `soak: SHRINK -- ...` (key, ops, runs, paths), then `soak: END verdict=<FAIL|INCONCLUSIVE>
 * exit=<1|3> records=0` (no JSONL records). stderr: the target's BREACH lines (main.mjs BreachLog format).
 * Exit: 1 shrunk (the failure reproduced), 2 config / unreachable, 3 not reproducible, crash 1.
 * runShrink ALWAYS returns an integer 0..3 (replay.mjs asExitCode).
 *
 * Kernel-free on import (ddmin, simplification, emitTest and emit.mjs are pure). COLD module: no hot body.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODE, VERDICT, GEN_VERSION } from './config.mjs';
import { familyKeys } from './main.mjs';
import { runWorld } from './exec.mjs';
import { emittable, emitStandalone } from './emit.mjs';
import { protocol, stdoutLine, endLine } from './jsonl.mjs';
import { locateAndPlay, replayTap, writeBreaches, scriptDigest, asExitCode, cfgProblem, configCode, isEntryUrl, entry } from './replay.mjs';

export const SHRINK_MAX_RUNS = 5000;
export const SHRINK_MAX_PASSES = 16;

const clone = (x) => JSON.parse(JSON.stringify(x));
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/* ---- the run budget ------------------------------------------------------------------------------- */

/** Counts predicate runs. test(fn, arg) runs fn(arg) unless exhausted; an exhausted test answers false. */
export class Budget {
    constructor(max) {
        if (!(Number.isInteger(max) && max >= 1)) throw new RangeError('Budget: max must be an integer >= 1, got ' + String(max));
        this.max = max;
        this.runs = 0;
        this.exhausted = false;
    }
    test(fn, arg) {
        if (this.runs >= this.max) { this.exhausted = true; return false; }
        this.runs++;
        return fn(arg) === true;   // only a strict true is a hit
    }
}

/* ---- ddmin ---------------------------------------------------------------------------------------- */

/**
 * Zeller's ddmin: a 1-minimal sublist of `items` (order kept) for which pred(sublist) is true, assuming
 * pred(items) is true (not re-tested). min: the smallest legal length (0 lets it try the empty list once).
 * budget: a Budget (optional; a private one with SHRINK_MAX_RUNS otherwise). Returns a NEW array.
 */
export function ddmin(items, pred, opts) {
    const o = opts || {};
    const min = o.min === undefined ? 1 : o.min;
    if (!(Number.isInteger(min) && min >= 0)) throw new RangeError('ddmin: min must be a non-negative integer');
    const budget = o.budget || new Budget(SHRINK_MAX_RUNS);
    let cur = items.slice();
    if (min === 0 && cur.length > 0 && budget.test(pred, [])) return [];
    let n = 2;
    while (cur.length >= 2 && cur.length > min) {
        const len = cur.length;
        const size = Math.ceil(len / n);
        const parts = [];
        for (let s = 0; s < len; s += size) parts.push(cur.slice(s, s + size));
        let reduced = false;
        for (let k = 0; k < parts.length && !reduced; k++) {
            if (parts[k].length >= min && parts[k].length < len && budget.test(pred, parts[k])) { cur = parts[k]; n = 2; reduced = true; }
        }
        // with two parts the complements ARE the parts (already tried)
        for (let k = 0; k < parts.length && !reduced && parts.length > 2; k++) {
            const comp = [].concat(...parts.filter((_, j) => j !== k));
            if (comp.length >= min && budget.test(pred, comp)) { cur = comp; n = Math.max(n - 1, 2); reduced = true; }
        }
        if (!reduced) {
            if (n >= len || budget.exhausted) break;
            n = Math.min(len, n * 2);
        }
    }
    return cur;
}

/* ---- simplification sites ------------------------------------------------------------------------- */

const OP_FLAGS = Object.freeze(['chk', 'pull', 'u', 'thr', 'eq', 'dis', 'cyc', 'rank', 'role']);
const SPEC_FLAGS = Object.freeze(['thr', 'try', 'w']);
const PLAIN_KINDS = Object.freeze(['sum', 'identity', 'select', 'cond', 'hash']);

/** Smaller value codes to try for code v (gen.mjs value(): >= 0 an int, < 0 a pool index, EQ_BOMB_CODE). */
export function simplerValues(v) {
    if (!Number.isInteger(v)) return [];
    const out = [];
    const add = (x) => { if (x !== v && out.indexOf(x) === -1) out.push(x); };
    if (v < 0) { add(0); add(1); return out; }   // pool and bomb codes: a plain small int is simpler
    add(0);
    if (v > 1) add(1);
    if (v > 3) add(v >> 1);
    return out;
}

function getAt(obj, path) { let x = obj; for (const k of path) x = x[k]; return x; }
function withAt(obj, path, val) {
    const c = clone(obj);
    if (path.length === 0) return val;
    let x = c;
    for (let i = 0; i < path.length - 1; i++) x = x[path[i]];
    x[path[path.length - 1]] = val;
    return c;
}

/**
 * Every simplification site of a script, in script order. A site is {kind: 'list', path, min} or
 * {kind: 'edit', path, cands: [replacement values]} (path from the script root). Pure.
 */
export function sites(script) {
    const out = [];
    const opSites = (op, p) => {
        if (op === null || typeof op !== 'object') return;
        for (const f of OP_FLAGS) {
            if (!own(op, f)) continue;
            const v = clone(op);
            delete v[f];
            if (f === 'chk') delete v.cs;
            out.push({ kind: 'edit', path: p, cands: [v] });
        }
        if (Number.isInteger(op.v) && (op.o === 'sig' || op.o === 'set' || op.o === 'arm')) {
            out.push({ kind: 'edit', path: p.concat('v'), cands: simplerValues(op.v) });
        }
        switch (op.o) {
            case 'burst':
                if (Array.isArray(op.vs)) {
                    out.push({ kind: 'list', path: p.concat('vs'), min: 1 });
                    op.vs.forEach((v, j) => out.push({ kind: 'edit', path: p.concat('vs', j), cands: simplerValues(v) }));
                }
                break;
            case 'read':
                if (Array.isArray(op.is)) out.push({ kind: 'list', path: p.concat('is'), min: 1 });
                break;
            case 'batch':
                if (Array.isArray(op.body)) {
                    out.push({ kind: 'list', path: p.concat('body'), min: 0 });
                    op.body.forEach((s, j) => opSites(s, p.concat('body', j)));
                }
                break;
            case 'seq':
                if (Array.isArray(op.ops)) {
                    out.push({ kind: 'list', path: p.concat('ops'), min: 1 });
                    op.ops.forEach((s, j) => opSites(s, p.concat('ops', j)));
                }
                break;
            case 'comp':
            case 'eff':
                if (op.spec !== null && typeof op.spec === 'object') specSites(op.spec, p.concat('spec'));
                break;
            default:
                break;
        }
    };
    const specSites = (spec, p) => {
        for (const f of SPEC_FLAGS) {
            if (!own(spec, f)) continue;
            const v = clone(spec);
            delete v[f];
            if (f === 'w') delete v.inc;
            out.push({ kind: 'edit', path: p, cands: [v] });
        }
        if (PLAIN_KINDS.indexOf(spec.k) !== -1 && Array.isArray(spec.d)) {
            out.push({ kind: 'list', path: p.concat('d'), min: 1 });
            if (spec.k === 'select' || spec.k === 'cond' || spec.k === 'hash') {
                const v = clone(spec);
                v.k = 'sum';
                delete v.s;
                out.push({ kind: 'edit', path: p, cands: [v] });
            }
        }
        if (spec.k === 'outer') {
            if (Array.isArray(spec.pre)) out.push({ kind: 'list', path: p.concat('pre'), min: 0 });
            if (Array.isArray(spec.post)) out.push({ kind: 'list', path: p.concat('post'), min: 0 });
        }
    };
    script.ops.forEach((op, k) => opSites(op, ['ops', k]));
    return out;
}

/**
 * Shrink `script` under pred (pred(script) must be true). failStep: the failing step index of the target
 * run (truncation; null to skip). Returns {script, passes}. Pure apart from pred.
 */
export function shrinkScript(script, pred, budget, failStep) {
    let cur = clone(script);
    if (Number.isInteger(failStep) && failStep >= 0 && failStep + 1 < cur.ops.length) {
        const t = withAt(cur, ['ops'], cur.ops.slice(0, failStep + 1));
        if (budget.test(pred, t)) cur = t;
    }
    let passes = 0;
    for (; passes < SHRINK_MAX_PASSES && !budget.exhausted; passes++) {
        const before = JSON.stringify(cur);
        const top = ddmin(cur.ops, (ops) => pred(withAt(cur, ['ops'], ops)), { min: 1, budget });
        if (top.length < cur.ops.length) cur = withAt(cur, ['ops'], top);
        let i = 0;
        let list = sites(cur);
        while (i < list.length && !budget.exhausted) {
            const s = list[i];
            let changed = false;
            if (s.kind === 'list') {
                const items = getAt(cur, s.path);
                const base = cur;
                const got = ddmin(items, (sub) => pred(withAt(base, s.path, sub)), { min: s.min, budget });
                if (got.length < items.length) { cur = withAt(cur, s.path, got); changed = true; }
            } else {
                for (const c of s.cands) {
                    const cand = withAt(cur, s.path, c);
                    if (budget.test(pred, cand)) { cur = cand; changed = true; break; }
                }
            }
            if (changed) list = sites(cur);   // paths may have moved; the site at i is re-examined
            else i++;
        }
        if (JSON.stringify(cur) === before) { passes++; break; }
    }
    return { script: cur, passes };
}

/** Top-level ops plus every nested batch / seq sub-op. */
export function countSubOps(ops) {
    let n = 0;
    for (const op of ops) {
        n++;
        if (op && Array.isArray(op.body)) n += countSubOps(op.body);
        if (op && op.o === 'seq' && Array.isArray(op.ops)) n += countSubOps(op.ops);
    }
    return n;
}

/* ---- the predicate -------------------------------------------------------------------------------- */

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.indexOf(x) !== -1);

/** One run of script on a FRESH world through the main.mjs tap: the runWorld() result, or null on a throw. */
export function makeRunner(adapter) {
    return (script) => {
        try {
            const { tap, ad } = replayTap(adapter);
            tap.escape = null;
            return runWorld(ad, script);
        } catch (e) {
            return null;
        }
    };
}

/** A runner result reproduces t (a familyKeys set): a failure with exactly that set; t [] = any failure. */
function reproduces(r, t) {
    if (r === null || typeof r !== 'object' || r.failure === null || r.failure === undefined) return false;
    if (t.length === 0) return true;   // a world clean when shrunk: any failure is the "target"
    return sameSet(familyKeys(r.failure.fails), t);
}

/**
 * The reproduction predicate for target (a familyKeys set): a FRESH world per run through the main.mjs tap.
 * A throw, a clean run or a different (family, sig) set is false; never a hit.
 */
export function makePredicate(adapter, target) {
    const t = target.slice();
    const run = makeRunner(adapter);
    return (script) => reproduces(run(script), t);
}

/* ---- artifacts ------------------------------------------------------------------------------------ */

/** Artifact paths for a key: {dir, json, test}. cfgOut: cfg.out (null = bench/soak/out/). */
export function artifactPaths(lane, seed, cfgOut) {
    const dir = cfgOut !== null && cfgOut !== undefined ? dirname(resolve(cfgOut)) : fileURLToPath(new URL('./out/', import.meta.url));
    const stem = 'shrink-' + lane + '-0x' + (seed >>> 0).toString(16);
    return { dir, json: join(dir, stem + '.json'), test: join(dir, stem + '.test.mjs') };
}

const asciiJson = (x) => JSON.stringify(x).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** The emitted .test.mjs source (pure). Imports the bench/soak modules by absolute file URL. */
export function emitTest(info) {
    const u = (f) => JSON.stringify(new URL('./' + f, import.meta.url).href);
    return [
        '// GENERATED by bench/soak/shrink.mjs (lite-signal soak, S1c TASK 8). Do not edit: re-run the shrink.',
        '// key ' + info.key + '  target ' + (info.target.length ? info.target.join(',') : '(none: clean when shrunk)') + '  ops ' + info.ops + ' (from ' + info.opsOriginal + ')',
        '// Run: SOAK_KERNEL=/abs/dir/Signal.js node <this file>   (no arguments; SOAK_KERNEL is required and ABSOLUTE)',
        '// Exit: 1 the target failure reproduces, 0 the script runs clean, 3 a different failure, 2 config or a harness',
        '// throw (unset / relative SOAK_KERNEL, a module that fails to load, an exec throw). Never 1 by accident:',
        '// every soak module loads inside the try below, so a failed import is 2, not "reproduced".',
        "import { writeSync } from 'node:fs';",
        "import { isAbsolute } from 'node:path';",
        '',
        'const KEY = ' + JSON.stringify(info.key) + ';',
        'const TARGET = ' + asciiJson(info.target) + ';',
        'const SCRIPT = ' + asciiJson(info.script) + ';',
        "const say = (fd, s) => writeSync(fd, 'shrink-test: ' + s + '\\n');",
        'if (process.argv.length > 2) { say(2, \'CONFIG -- this test takes no arguments (set SOAK_KERNEL instead)\'); process.exit(2); }',
        'const K = process.env.SOAK_KERNEL;',
        "if (K === undefined || K === '') { say(2, 'CONFIG -- SOAK_KERNEL is required (an absolute path to a frozen <dir>/Signal.js; a soak run never uses the live Signal.js)'); process.exit(2); }",
        "if (!isAbsolute(K)) { say(2, 'CONFIG -- SOAK_KERNEL must be an absolute path (got ' + K + '): a relative one would resolve against the cwd'); process.exit(2); }",
        'let r, liteAdapter, familyKeys;',
        'try {',
        '    const ex = await import(' + u('exec.mjs') + ');',
        '    const mn = await import(' + u('main.mjs') + ');',
        '    liteAdapter = (await import(' + u('adapters/lite-s3.mjs') + ')).liteS3Adapter;',
        '    familyKeys = mn.familyKeys;',
        '    const tap = { escape: null, onOpen() {} };',
        '    r = ex.runWorld(mn.tapAdapter(liteAdapter, tap), SCRIPT);',
        '} catch (e) {',
        "    say(2, 'CRASH -- ' + (e && e.stack ? e.stack : String(e)));",
        '    process.exit(2);',
        '}',
        "const kernel = liteAdapter.files().map((f) => f.sha256.slice(0, 12)).join(',');",
        'if (r.failure === null) { say(1, \'CLEAN key=\' + KEY + \' kernel=\' + kernel); process.exit(0); }',
        'const got = familyKeys(r.failure.fails);',
        'const hit = TARGET.length === 0 || (got.length === TARGET.length && got.every((k) => TARGET.indexOf(k) !== -1));',
        "say(1, (hit ? 'REPRODUCED' : 'DIFFERENT') + ' key=' + KEY + ' step=' + r.failure.step + ' got=' + got.join(',') + ' target=' + TARGET.join(',') + ' kernel=' + kernel);",
        'process.exit(hit ? 1 : 3);',
        '',
    ].join('\n');
}

/* ---- runShrink ------------------------------------------------------------------------------------ */

/** Shrink cfg.replay. Always resolves to an integer exit code 0..3 (see the module header). */
export async function runShrink(cfg) {
    return asExitCode('runShrink', async () => {
        const p = cfgProblem(cfg);
        if (p !== null) return configCode(p);
        if (cfg.shrink !== true) return configCode('runShrink: SOAK_SHRINK=1 is required');
        const L = await locateAndPlay(cfg);
        if (L.code !== null) return L.code;
        const { res, adapter, played, rec } = L;
        const original = played.script;
        const target = rec === null ? [] : familyKeys(rec.fails);
        const budget = new Budget(SHRINK_MAX_RUNS);
        let minimal = original, passes = 0, confirmed = false, confirmRun = null;
        if (rec !== null) {
            writeBreaches(rec, res.lane, adapter.name);
            const run = makeRunner(adapter);
            const t = target.slice();
            const pred = (script) => reproduces(run(script), t);   // makePredicate(adapter, target)
            const out = shrinkScript(original, pred, budget, played.r.failure.step);
            minimal = out.script;
            passes = out.passes;
            confirmRun = run(minimal);   // the CONFIRM run (counted below, outside the budget); emittable() reads it
            confirmed = reproduces(confirmRun, t);
        }
        const { KERNEL_URL, KERNEL_FILES } = await import('./kernel.mjs');
        const paths = artifactPaths(res.lane, res.worldSeed, cfg.out);
        const info = {
            kind: 'shrink', key: res.key, lane: res.lane, cycle: res.cycle, seed: cfg.seed, world: res.world, worldSeed: res.worldSeed,
            large: res.large, covOff: res.covOff, target, reproduced: rec !== null, confirmed,
            ops: minimal.ops.length, subOps: countSubOps(minimal.ops), opsOriginal: original.ops.length,
            predicateRuns: budget.runs + (rec !== null ? 1 : 0), maxRuns: SHRINK_MAX_RUNS, budgetExhausted: budget.exhausted, passes,
            script: minimal, scriptDigest: scriptDigest(minimal), genVersion: GEN_VERSION,
            engine: adapter.name, kernel: { url: KERNEL_URL, files: KERNEL_FILES.map((f) => ({ path: f.path, sha256: f.sha256 })) },
            node: process.version,
        };
        // --emit-test: the standalone verdict goes into the json right before createdAt (absent without the flag)
        const stdPath = paths.test.slice(0, paths.test.length - '.test.mjs'.length) + '.standalone.test.mjs';
        let stdSrc = null, refused = null;
        if (cfg.emitTest === true) {
            let reason = null;
            if (rec === null) reason = 'not-reproduced: ' + res.key + ' runs clean on this kernel';
            else if (!confirmed) reason = 'unconfirmed: the minimal script did not reproduce on the confirm run';
            else {
                const e = emittable(info, confirmRun);
                if (e.ok) stdSrc = emitStandalone(info, e.expect);
                else reason = refused = e.reason;
            }
            info.emitted = stdSrc !== null;
            info.standalone = stdSrc !== null ? stdPath : null;
            info.emitReason = reason;
        }
        info.createdAt = new Date().toISOString();
        mkdirSync(paths.dir, { recursive: true });
        writeFileSync(paths.json, JSON.stringify(info, null, 2) + '\n');
        writeFileSync(paths.test, emitTest(info));
        if (cfg.emitTest === true) {
            if (stdSrc !== null) writeFileSync(stdPath, stdSrc);
            else rmSync(stdPath, { force: true });   // a key that does not emit leaves no stale standalone
        }
        const ok = rec !== null && confirmed;
        if (rec === null) protocol('soak: INCONCLUSIVE -- shrink: ' + res.key + ' runs clean on this kernel; nothing to shrink');
        else if (!confirmed) protocol('soak: INCONCLUSIVE -- shrink: the minimal script of ' + res.key + ' did not reproduce on the confirm run (non-deterministic failure)');
        stdoutLine('soak: SHRINK -- key=' + res.key + ' target=' + (target.length ? target.join(',') : '-') + ' ops=' + info.ops + ' subOps=' + info.subOps +
            ' from=' + info.opsOriginal + ' runs=' + info.predicateRuns + '/' + SHRINK_MAX_RUNS + (budget.exhausted ? ' budget=exhausted' : '') +
            ' json=' + paths.json + ' test=' + paths.test +
            (cfg.emitTest === true ? ' standalone=' + (stdSrc !== null ? stdPath : '-') : ''));
        if (refused !== null) {
            return configCode('shrink --emit-test: no standalone test for ' + res.key + ': ' + refused);
        }
        const verdict = ok ? VERDICT.FAIL : VERDICT.INCONCLUSIVE;
        const code = ok ? EXIT_CODE.FAIL : EXIT_CODE.INCONCLUSIVE;
        endLine(verdict, code, 0);
        return code;
    });
}

if (isEntryUrl(import.meta.url)) {
    entry('shrink.mjs', true, runShrink).catch((e) => {
        protocol('soak: CRASH -- shrink.mjs entry: ' + (e && e.stack ? e.stack : String(e)));
        process.exit(1);
    });
}
