// bench/inline-diff.mjs -- TurboFan + Maglev inlining-decision diff for ONE named hot function,
// FROZEN "before" build vs "after" build, on the same node binary.
//
//   node bench/inline-diff.mjs --before <frozen Signal.js> --after <Signal.js> --fn <name>
//                              [--runs 3] [--driver <path>] [--only-fn] [--out <dir>] [--concurrent]
//
// Tier: STATISTICAL / REPORTED. Tier-up timing (concurrent TurboFan) is load-sensitive, so this
// tool is NEVER wired into `npm test` / `verify`. Run it under the host quiet lock:
//   node ~/.claude/hooks/quiet-lock.mjs run "lite-signal inline-diff" -- node bench/inline-diff.mjs ...
//
// Method. Each build is copied into its own temp dir with the Watch.js that sits beside it and a
// driver (default: signal read / set / peek, computed, effect, batch hot paths; --driver <path> must
// import './Signal.js'). The driver runs --runs times per side (interleaved before / after) under
// `--trace-turbo-inlining` and under `--trace-maglev-inlining`. Each trace is normalized (addresses,
// node ids, call frequencies, callee bytecode sizes, timestamps) and reduced to decision lines. The
// DEFAULT scope is the WHOLE decision trace: a decision inside <fn>'s inlined body never names <fn>
// (TurboFan `Cannot consider X` and every Maglev line name only the callee; `Inlining X into Y` names
// the outermost unit). --only-fn narrows to lines naming `<SharedFunctionInfo <fn>>` -- callee-side
// only, blind to a change in <fn>'s own callees; the report line says so. Lines are compared as a
// MULTISET (`sort | uniq -c` semantics, never `sort -u`): a callee inlined at 2 sites before and at 1
// after is a DIFF. TurboFan compiles SYNCHRONOUSLY by default (`--no-concurrent-recompilation`, both
// sides): with concurrent recompilation a compile lands at a load-dependent point and the null control
// flakes (measured b131: sharedSignalPeek into step present 2/3 before runs at load1 ~10).
// --concurrent restores the V8 default; the null control then carries the whole noise burden.
// (Maglev tracing already forces synchronous Maglev: node prints "Concurrent maglev has been disabled".)
//
// Fail closed (NO-VERDICT, exit 2):
//   - guard: a run whose decision lines never name <fn> (anonymous closures never match);
//   - null control: the before runs are not all identical (before-vs-before), or the after runs are
//     not all identical -- inlining is then tier-up noise on this host, not a verdict;
//   - a child that exits non-zero, --runs < 2, an unknown option (did-you-mean), --before that
//     resolves to the live Signal.js, or a Watch.js beside --before that IS the live Watch.js (same
//     dev + inode: hard links and case variants included) -- the "before" must be a FROZEN copy.
// Verdict SAME exit 0, DIFF exit 1 (the multiset diff lines are printed), NO-VERDICT exit 2.
// --help prints this header and exits 2 (no verdict), never 0.
// Both sides spawn process.execPath with NODE_OPTIONS stripped; `node -v` + execPath are printed.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXIT = { SAME: 0, DIFF: 1, 'NO-VERDICT': 2 };
export const TIERS = ['turbo', 'maglev'];
const TIER_FLAG = { turbo: '--trace-turbo-inlining', maglev: '--trace-maglev-inlining' };
const RE_HEX = /0x[0-9a-fA-F]+/g;
const RE_TIME = /\b\d+(?:\.\d+)?\s?ms\b/g;
// keeps Inlining / Cannot consider / Not inlining / Not considering; drops "Inlining small function(s) at call site #N"
const RE_TURBO_KEEP = /^(?:Inlining 0x|Cannot consider |Not inlining |Not considering )/;
const RE_MAGLEV_KEEP = /^(?:== Inlining|greedy inlining|cannot inline)/;

// ---- pure logic (test/90 covers these on canned trace text; no V8 spawn) -------------------------

export function normalizeTurbo(text) {
    const out = [];
    for (const raw of String(text).split('\n')) {
        const l = raw.replace(RE_HEX, '0x').replace(/#\d+/g, '#N')
            .replace(/frequency [0-9.eE+-]+/g, 'frequency F').replace(RE_TIME, 'T ms').trim();
        if (RE_TURBO_KEEP.test(l)) out.push(l);
    }
    return out;
}

export function normalizeMaglev(text) {
    const out = [];
    for (const raw of String(text).split('\n')) {
        const l = raw.replace(RE_HEX, '0x').replace(/frequency \([0-9.eE+-]+\)/g, 'frequency (F)')
            .replace(/(?<!max-)size \(\d+\)/g, 'size (S)').replace(RE_TIME, 'T ms').trim();
        if (RE_MAGLEV_KEEP.test(l)) out.push(l);
    }
    return out;
}

export function normalize(tier, text) {
    if (tier === 'turbo') return normalizeTurbo(text);
    if (tier === 'maglev') return normalizeMaglev(text);
    throw new Error('inline-diff: unknown tier ' + tier);
}

export function fnToken(fn) { return 'SharedFunctionInfo ' + fn + '>'; }

/** Guard: the decision lines must name <fn>, else the run is no evidence about <fn>. */
export function hasGuard(lines, fn) {
    const tok = fnToken(fn);
    for (const l of lines) if (l.includes(tok)) return true;
    return false;
}

/** Default: every decision line. onlyFn: lines naming <fn> only (callee-side only). */
export function scopeLines(lines, fn, onlyFn) {
    if (!onlyFn) return lines.slice();
    const tok = fnToken(fn);
    return lines.filter((l) => l.includes(tok));
}

/** Multiset: line -> count (`sort | uniq -c`). */
export function multiset(lines) {
    const m = new Map();
    for (const l of lines) m.set(l, (m.get(l) || 0) + 1);
    return m;
}

/** Sorted list of { line, before, after } where the counts differ. */
export function multisetDiff(a, b) {
    const ma = multiset(a), mb = multiset(b);
    const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort();
    const out = [];
    for (const k of keys) {
        const ca = ma.get(k) || 0, cb = mb.get(k) || 0;
        if (ca !== cb) out.push({ line: k, before: ca, after: cb });
    }
    return out;
}

/**
 * One tier's verdict. beforeRuns / afterRuns: arrays of NORMALIZED line arrays (one per run).
 * Returns { verdict, reason, diff, nullDiff }.
 */
export function tierVerdict({ fn, beforeRuns, afterRuns, onlyFn = false }) {
    const nv = (reason, nullDiff = []) => ({ verdict: 'NO-VERDICT', reason, diff: [], nullDiff });
    if (!Array.isArray(beforeRuns) || !Array.isArray(afterRuns) || beforeRuns.length < 2 || afterRuns.length !== beforeRuns.length) {
        return nv('null control needs >= 2 runs per side (equal counts)');
    }
    for (let k = 0; k < beforeRuns.length; k++) {
        if (!hasGuard(beforeRuns[k], fn)) return nv('no trace of ' + fnToken(fn) + ' in before run ' + (k + 1));
        if (!hasGuard(afterRuns[k], fn)) return nv('no trace of ' + fnToken(fn) + ' in after run ' + (k + 1));
    }
    const b = beforeRuns.map((r) => scopeLines(r, fn, onlyFn));
    const a = afterRuns.map((r) => scopeLines(r, fn, onlyFn));
    for (let k = 1; k < b.length; k++) {
        const d = multisetDiff(b[0], b[k]);
        if (d.length !== 0) return nv('null control: before run 1 vs before run ' + (k + 1) + ' differ (tier-up noise)', d);
    }
    for (let k = 1; k < a.length; k++) {
        const d = multisetDiff(a[0], a[k]);
        if (d.length !== 0) return nv('stability: after run 1 vs after run ' + (k + 1) + ' differ (tier-up noise)', d);
    }
    const diff = multisetDiff(b[0], a[0]);
    return { verdict: diff.length === 0 ? 'SAME' : 'DIFF', reason: diff.length === 0 ? 'identical multiset' : diff.length + ' line(s) differ', diff, nullDiff: [] };
}

/** NO-VERDICT dominates, then DIFF, then SAME. */
export function overallVerdict(tierResults) {
    const vs = Object.values(tierResults).map((t) => t.verdict);
    if (vs.length === 0 || vs.some((v) => v !== 'SAME' && v !== 'DIFF')) return 'NO-VERDICT';
    return vs.includes('DIFF') ? 'DIFF' : 'SAME';
}

export function exitCode(verdict) {
    return Object.prototype.hasOwnProperty.call(EXIT, verdict) ? EXIT[verdict] : EXIT['NO-VERDICT'];
}

export function formatDiff(diff) {
    return diff.map((d) => '  before=' + d.before + ' after=' + d.after + '  ' + d.line);
}

const OPTS = { before: 'path', after: 'path', fn: 'string', runs: 'int', driver: 'path', 'only-fn': 'bool', out: 'path', concurrent: 'bool', help: 'bool' };

function editDistance(a, b) {
    const dp = [];
    for (let i = 0; i <= a.length; i++) dp.push([i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return dp[a.length][b.length];
}

export function parseArgs(argv) {
    const o = { runs: 3, onlyFn: false, concurrent: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const t = argv[i];
        if (!t.startsWith('--')) throw new Error('inline-diff: unexpected argument "' + t + '"');
        const key = t.slice(2);
        if (!Object.prototype.hasOwnProperty.call(OPTS, key)) {
            let best = null, bd = 3;
            for (const k of Object.keys(OPTS)) { const d = editDistance(key, k); if (d < bd) { bd = d; best = k; } }
            throw new Error('inline-diff: unknown option --' + key + (best ? ' (did you mean --' + best + '?)' : ''));
        }
        if (OPTS[key] === 'bool') { o[key === 'only-fn' ? 'onlyFn' : key] = true; continue; }
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) throw new Error('inline-diff: --' + key + ' needs a value');
        if (OPTS[key] === 'int') {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 2 || n > 50) throw new Error('inline-diff: --runs must be an integer in [2, 50] (null control), got ' + v);
            o[key] = n;
        } else {
            o[key] = v;
        }
    }
    if (o.help) return o;
    for (const k of ['before', 'after', 'fn']) if (o[k] === undefined) throw new Error('inline-diff: --' + k + ' is required');
    if (!/^[A-Za-z_$][\w$.]*$/.test(o.fn)) throw new Error('inline-diff: --fn must be a NAMED function (e.g. read.set, sharedSignalPeek), got "' + o.fn + '"');
    return o;
}

/** Same file by dev + inode (catches symlinks, hard links, case variants); a missing path is not the same. */
export function sameFile(a, b) {
    let sa, sb;
    try { sa = statSync(a); sb = statSync(b); } catch { return false; }
    return sa.dev === sb.dev && sa.ino === sb.ino;
}

/** The "before" must be a frozen copy, never the live main file. */
export function assertNotLive(beforePath, livePath, label = '--before') {
    try { statSync(beforePath); } catch { throw new Error('inline-diff: ' + label + ' not found: ' + beforePath); }
    if (sameFile(beforePath, livePath)) throw new Error('inline-diff: ' + label + ' resolves to the LIVE ' + livePath + ' -- freeze a copy first');
}

/** Frozen build = a non-live Signal.js AND a non-live Watch.js beside it (Signal.js re-exports Watch.js). */
export function assertFrozenBuild(beforePath, liveDir) {
    assertNotLive(beforePath, join(liveDir, 'Signal.js'));
    assertNotLive(join(dirname(beforePath), 'Watch.js'), join(liveDir, 'Watch.js'), 'Watch.js beside --before');
}

// ---- CLI (spawns V8; never imported by npm test) ---------------------------------------------------

export const DEFAULT_DRIVER = `// inline-diff default driver: signal read / set / peek, computed, effect, batch hot paths.
import { signal, computed, effect, batch } from './Signal.js';
const a = signal(0), b = signal(1);
const c = computed(() => a() + b());
const d = computed(() => c() * 2);
const sink = new Int32Array(1);
effect(() => { sink[0] = (sink[0] + d()) | 0; });
function step(i) {
    a.set(i);
    b.set(i ^ 1);
    batch(() => { a.set(i + 1); b.set(i); });
    return (a.peek() + c.peek() + d()) | 0;
}
let acc = 0;
for (let i = 0; i < 300000; i++) acc = (acc + step(i)) | 0;
if (acc === 7 && sink[0] === 7) console.log('');
`;

const sha8 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8);

function findCommit(repo, rel, wantSha8) {
    const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const log = git(['log', '--format=%h', '-n', '50', 'HEAD', '--', rel]);
    if (log.status !== 0) return 'unknown (git log failed)';
    const cands = ['HEAD', ...log.stdout.split('\n').filter(Boolean)];
    for (const c of cands) {
        const s = spawnSync('git', ['-C', repo, 'show', c + ':' + rel], { maxBuffer: 64 << 20 });
        if (s.status === 0 && createHash('sha256').update(s.stdout).digest('hex').slice(0, 8) === wantSha8) {
            return c === 'HEAD' ? git(['rev-parse', '--short', 'HEAD']).stdout.trim() : c;
        }
    }
    return 'unknown (sha not in HEAD or the last 50 ' + rel + ' commits)';
}

function stage(build, driverSrc, root, side) {
    const dir = join(root, side);
    mkdirSync(dir);
    const watch = join(dirname(build), 'Watch.js');
    if (!existsSync(watch)) throw new Error('inline-diff: no Watch.js beside ' + build);
    copyFileSync(build, join(dir, 'Signal.js'));
    copyFileSync(watch, join(dir, 'Watch.js'));
    writeFileSync(join(dir, 'driver.mjs'), driverSrc);
    return join(dir, 'driver.mjs');
}

export function v8Flags(tier, concurrent) {
    const f = [TIER_FLAG[tier]];
    if (!concurrent) f.push('--no-concurrent-recompilation');
    return f;
}

function runTrace(tier, driver, concurrent) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, [...v8Flags(tier, concurrent), driver], { cwd: dirname(driver), env, encoding: 'utf8', maxBuffer: 512 << 20 });
    if (r.status !== 0) throw new Error('inline-diff: driver exited ' + r.status + ' (' + tier + '): ' + String(r.stderr).slice(0, 400));
    return r.stdout + '\n' + r.stderr;
}

function main(argv) {
    let o;
    try { o = parseArgs(argv); } catch (e) { process.stderr.write(e.message + '\nVERDICT NO-VERDICT\n'); return EXIT['NO-VERDICT']; }
    if (o.help) { process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith('//'))).join('\n') + '\n'); return EXIT['NO-VERDICT']; }
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const live = join(repo, 'Signal.js');
    const before = resolve(o.before), after = resolve(o.after);
    let tmp = null;
    try {
        assertFrozenBuild(before, repo);
        if (!existsSync(after)) throw new Error('inline-diff: --after not found: ' + after);
        let driverSrc = DEFAULT_DRIVER, driverName = 'default';
        if (o.driver !== undefined) {
            driverSrc = readFileSync(resolve(o.driver), 'utf8');
            driverName = resolve(o.driver);
            if (!/['"]\.\/Signal\.js['"]/.test(driverSrc)) throw new Error("inline-diff: --driver must import './Signal.js'");
        }
        const bSha = sha8(before), aSha = sha8(after);
        const lines = [];
        const say = (s) => { lines.push(s); process.stdout.write(s + '\n'); };
        say('inline-diff  node ' + process.version + '  execPath ' + process.execPath + '  (same binary both sides, NODE_OPTIONS stripped)');
        say('before ' + before + '  commit ' + findCommit(repo, 'Signal.js', bSha) + '  sha256/8 ' + bSha);
        say('after  ' + after + '  sha256/8 ' + aSha + (sameFile(after, live) ? '  (live)' : ''));
        say('fn ' + o.fn + '  runs ' + o.runs + '  driver ' + driverName + '  scope ' + (o.onlyFn ? 'callee-side only: lines naming ' + fnToken(o.fn) : 'all decision lines (guard on ' + fnToken(o.fn) + ')') +
            '  v8 flags ' + v8Flags('turbo', o.concurrent).slice(1).concat('<trace flag>').join(' '));
        tmp = mkdtempSync(join(tmpdir(), 'inline-diff-'));
        const dB = stage(before, driverSrc, tmp, 'before');
        const dA = stage(after, driverSrc, tmp, 'after');
        const res = {};
        for (const tier of TIERS) {
            const bRuns = [], aRuns = [];
            for (let k = 0; k < o.runs; k++) {
                bRuns.push(normalize(tier, runTrace(tier, dB, o.concurrent)));
                aRuns.push(normalize(tier, runTrace(tier, dA, o.concurrent)));
            }
            if (o.out !== undefined) {
                mkdirSync(resolve(o.out), { recursive: true });
                for (let k = 0; k < o.runs; k++) {
                    for (const [side, runs] of [['before', bRuns], ['after', aRuns]]) {
                        const ms = [...multiset(scopeLines(runs[k], o.fn, o.onlyFn))].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
                        writeFileSync(join(resolve(o.out), o.fn + '.' + tier + '.' + side + '.' + (k + 1) + '.txt'),
                            ms.map(([l, c]) => String(c).padStart(4) + ' ' + l).join('\n') + '\n');
                    }
                }
            }
            const t = tierVerdict({ fn: o.fn, beforeRuns: bRuns, afterRuns: aRuns, onlyFn: o.onlyFn });
            res[tier] = t;
            say('--- ' + tier + ': ' + t.verdict + ' -- ' + t.reason + '  (scoped lines before/after run 1: ' +
                scopeLines(bRuns[0], o.fn, o.onlyFn).length + '/' + scopeLines(aRuns[0], o.fn, o.onlyFn).length + ')');
            for (const l of formatDiff(t.nullDiff)) say(l);
            for (const l of formatDiff(t.diff)) say(l);
        }
        const v = overallVerdict(res);
        say('VERDICT ' + v + '  (turbo ' + res.turbo.verdict + ', maglev ' + res.maglev.verdict + ')');
        if (o.out !== undefined) writeFileSync(join(resolve(o.out), o.fn + '.report.txt'), lines.join('\n') + '\n');
        return exitCode(v);
    } catch (e) {
        process.stderr.write(e.message + '\nVERDICT NO-VERDICT\n');
        return EXIT['NO-VERDICT'];
    } finally {
        if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    }
}

if (process.argv[1] && basename(process.argv[1]) === 'inline-diff.mjs' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = main(process.argv.slice(2));
}
