/**
 * test/47 -- CI workflow oracle (S4-min, SPEC-B item 11 "program addendum 17", checks C1-C14, assertion A1).
 *
 * An INDEPENDENT oracle for .github/workflows/{ci,soak-nightly}.yml, written from the spec text only.
 * It carries (1) a fail-closed YAML-SUBSET parser (throws on tabs, CR, non-ASCII, anchors/aliases, flow maps and
 * sequences, `>` scalars, `|+`, document markers, duplicate keys, anything it does not understand; `|` and `|-`
 * block scalars are supported because run: blocks need them), (2) a PURE workflowProblems(files) returning
 * problem strings "Cn: ...", and (3) tests: the parser, the real files (must be [] -- RED on HEAD while the files
 * are missing: that is this gate's teeth, assertion A1), a clean in-test fixture pair, and one doctored copy per
 * check that must name exactly its own family.
 *
 * Assumptions where the spec is silent (everything else is strict):
 *  - The ptree step is the step with `id: ptree`; its `run:` text is run through `bash -eo pipefail` (the GitHub
 *    default for `shell: bash`) with cwd = a temp repo root that holds bench/soak/teeth.mjs and with GITHUB_OUTPUT
 *    set to a file; the verdict is read from a `gap=true|false` line in that file. "Fail closed" = non-zero exit.
 *  - Matrix cells are computed from matrix.os x matrix.node block lists plus matrix.include entries; `exclude`
 *    is rejected. An ubuntu-* label counts as "ubuntu"; node values compare as strings ('22', '24', '26').
 *  - The test job's setup-node must read matrix.node; the gates job's setup-node must read env.PIN_NODE.
 *  - Flow style (`branches: [a, b]`) is a parse error by design, so the workflows must use block lists.
 *  - "Soak step" = a step whose run matches `npm run soak` / `npm run soak:smoke` / SOAK_SMOKE / bench/soak/main.mjs.
 *  - The burn-in soak step must read SOAK_CYCLES / SOAK_OPS from `inputs.cycles` / `inputs.ops` via env (any
 *    fallback expression is tolerated).
 *  - Job-level `permissions` is tolerated only when every value is `read`. The `npm ci` step carries
 *    timeout-minutes <= 10. Required commands (C8): test job npm ci / npm test / torture:semantic / torture.mjs,
 *    gates test:gate, burn-in soak:report, teeth soak:teeth, teeth-long soak:teeth:long; gates holds a
 *    `::warning::` echo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CYCLES, DEFAULT_OPS, KNOWN_KEYS } from '../bench/soak/config.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WF_DIR = join(ROOT, '.github', 'workflows');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------------------------
// YAML subset parser (fail closed)
// ---------------------------------------------------------------------------------------------------------------

const BAD_START = new Set(['&', '*', '{', '[', '>', '!', '%', '@', '`']);

export function parseYaml(text) {
    if (typeof text !== 'string') throw new Error('yaml: not a string');
    if (text.indexOf('\t') >= 0) throw new Error('yaml: tab character');
    if (text.indexOf('\r') >= 0) throw new Error('yaml: CR character');
    if (/[^\x00-\x7f]/.test(text)) throw new Error('yaml: non-ASCII character');
    const ents = text.split('\n').map((s, k) => {
        const t = s.trimStart();
        return { s, n: k + 1, ind: s.length - t.length, txt: t.trimEnd(), blank: t.trim() === '' || t.startsWith('#') };
    });
    const N = ents.length;
    const fail = (e, m) => { throw new Error('yaml line ' + e.n + ': ' + m); };
    const skip = (i) => { while (i < N && ents[i].blank) i++; return i; };
    const isSeq = (e) => e.txt === '-' || e.txt.startsWith('- ');

    function quoted(t, e) { // t starts with a quote; returns {val, end}
        const q = t[0];
        let out = '';
        let i = 1;
        for (;;) {
            if (i >= t.length) fail(e, 'unterminated quoted scalar');
            const c = t[i];
            if (q === "'") {
                if (c === "'") { if (t[i + 1] === "'") { out += "'"; i += 2; continue; } return { val: out, end: i + 1 }; }
                out += c; i++;
            } else {
                if (c === '"') return { val: out, end: i + 1 };
                if (c === '\\') {
                    const d = t[i + 1];
                    if (d === '"' || d === '\\' || d === '/') out += d;
                    else if (d === 'n') out += '\n';
                    else fail(e, 'unsupported escape \\' + d);
                    i += 2; continue;
                }
                out += c; i++;
            }
        }
    }
    function tail(rest, e) { const r = rest.trim(); if (r !== '' && !r.startsWith('#') && !/^\s+#/.test(rest)) fail(e, 'junk after quoted scalar'); }
    function split(t, e) { // map entry -> {key, rest} or null
        if (t[0] === '"' || t[0] === "'") {
            const { val, end } = quoted(t, e);
            const a = t.slice(end).trimStart();
            if (a[0] === ':' && (a.length === 1 || a[1] === ' ')) return { key: val, rest: a.slice(1).trim() };
            return null;
        }
        for (let i = 0; i < t.length; i++) {
            if (t[i] === ':' && (i + 1 === t.length || t[i + 1] === ' ')) {
                const key = t.slice(0, i).trim();
                if (key === '') fail(e, 'empty key');
                if (BAD_START.has(key[0]) || key[0] === '|' || key[0] === '-' && key.length === 1) fail(e, 'bad key start');
                if (/\s#/.test(key)) fail(e, 'comment in key');
                return { key, rest: t.slice(i + 1).trim() };
            }
        }
        return null;
    }
    function scalar(rest, e) {
        let r = rest;
        if (r.startsWith('#')) return null;
        if (BAD_START.has(r[0])) fail(e, 'unsupported construct at "' + r[0] + '" (anchor/alias/flow/folded/tag)');
        if (r[0] === '"' || r[0] === "'") { const { val, end } = quoted(r, e); tail(r.slice(end), e); return val; }
        if (r[0] === '-' && (r.length === 1 || r[1] === ' ')) fail(e, 'sequence in scalar position');
        const c = r.search(/\s#/);
        if (c >= 0) r = r.slice(0, c).trimEnd();
        if (/: |:$/.test(r)) fail(e, 'mapping value in plain scalar');
        if (r === 'true') return true;
        if (r === 'false') return false;
        if (r === 'null' || r === '~') return null;
        if (/^-?\d+$/.test(r)) return Number(r);
        return r;
    }
    // value after "key:" or "- " at index i; parentInd = column of the key (or of the dash)
    function value(rest, i, parentInd) { // -> [v, nextIndex]
        const e = ents[i];
        if (rest[0] === '|') {
            const m = /^\|(-?)\s*(#.*)?$/.exec(rest);
            if (!m) fail(e, 'unsupported block scalar header "' + rest + '"');
            let j = i + 1;
            const body = [];
            let bi = -1;
            for (; j < N; j++) {
                const x = ents[j];
                if (x.s.trim() === '') { body.push(''); continue; }
                if (x.ind <= parentInd) break;
                if (bi < 0) bi = x.ind;
                if (x.ind < bi) fail(x, 'block scalar under-indented');
                body.push(x.s.slice(bi).trimEnd());
            }
            while (body.length && body[body.length - 1] === '') body.pop();
            return [body.join('\n') + (m[1] === '-' ? '' : '\n'), j];
        }
        return [scalar(rest, e), i + 1];
    }
    function nested(i, ind) { // block after an empty value; returns [v, next]
        const j = skip(i + 1);
        if (j < N && (ents[j].ind > ind || (ents[j].ind === ind && isSeq(ents[j])))) return node(j, ents[j].ind);
        return [null, i + 1];
    }
    function node(i, ind) {
        const e = ents[i];
        if (e.txt.startsWith('---') || e.txt.startsWith('...')) fail(e, 'document marker');
        return isSeq(e) ? seq(i, ind) : map(i, ind);
    }
    function map(i, ind) {
        const obj = Object.create(null);
        for (;;) {
            i = skip(i);
            if (i >= N || ents[i].ind < ind) break;
            const e = ents[i];
            if (e.ind > ind) fail(e, 'unexpected indentation');
            if (e.txt.startsWith('---') || e.txt.startsWith('...')) fail(e, 'document marker');
            if (isSeq(e)) break;
            const kv = split(e.txt, e);
            if (!kv) fail(e, 'not a mapping entry: "' + e.txt + '"');
            if (kv.key in obj) fail(e, 'duplicate key ' + kv.key);
            let v;
            if (kv.rest === '' || kv.rest.startsWith('#')) [v, i] = nested(i, ind);
            else [v, i] = value(kv.rest, i, ind);
            obj[kv.key] = v;
        }
        return [obj, i];
    }
    function seq(i, ind) {
        const arr = [];
        for (;;) {
            i = skip(i);
            if (i >= N || ents[i].ind < ind) break;
            const e = ents[i];
            if (e.ind > ind) fail(e, 'unexpected indentation');
            if (!isSeq(e)) break;
            const body = e.txt.slice(1);
            const rest = body.trimStart();
            const childInd = e.ind + 1 + (body.length - rest.length);
            if (rest === '' || rest.startsWith('#')) {
                const [v, nx] = nested(i, ind);
                arr.push(v); i = nx;
            } else if (rest.startsWith('- ')) {
                ents[i] = { ...e, ind: childInd, txt: rest };
                const [v, nx] = seq(i, childInd); arr.push(v); i = nx;
            } else if (split(rest, e)) {
                ents[i] = { ...e, ind: childInd, txt: rest };
                const [v, nx] = map(i, childInd); arr.push(v); i = nx;
            } else {
                const [v, nx] = value(rest, i, ind);
                arr.push(v); i = nx;
            }
        }
        return [arr, i];
    }
    const first = skip(0);
    if (first >= N) throw new Error('yaml: empty document');
    const [root, end] = node(first, ents[first].ind);
    const rest = skip(end);
    if (rest < N) fail(ents[rest], 'unparsed content');
    return root;
}

// ---------------------------------------------------------------------------------------------------------------
// workflowProblems (pure apart from the memoised ptree run)
// ---------------------------------------------------------------------------------------------------------------

const EXPECTED_FILES = ['ci.yml', 'soak-nightly.yml'];
const EXPECTED_JOBS = { 'ci.yml': ['gates', 'test'], 'soak-nightly.yml': ['burn-in', 'teeth', 'teeth-long'] };
const BUDGET = { 'ci.yml': { test: 30, gates: 30 }, 'soak-nightly.yml': { 'burn-in': 90, teeth: 60, 'teeth-long': 120 } };
const DECLARED_CELLS = ['macos-latest|24', 'ubuntu|22', 'ubuntu|24', 'ubuntu|26'];
const DECLARED_NODE = '26.8.2';
const KEYED = "${{ steps.ptree.outputs.gap == 'true' }}";
const SOAK_RE = /npm run soak(?::smoke)?(?![\w:.-])|SOAK_SMOKE|bench\/soak\/main\.mjs/;
const cmdRe = (c) => new RegExp('(^|[\\s;&|(])' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w:.-])');

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const stepsOf = (job) => (isObj(job) && Array.isArray(job.steps) ? job.steps.filter(isObj) : []);
const runOf = (s) => (typeof s.run === 'string' ? s.run : '');
const envOf = (x) => (isObj(x) && isObj(x.env) ? x.env : {});
const NEEDPAR_RE = /npm run soak:teeth(?::long)?(?![\w:.-])/;
// C16 floors: v5 of upload-artifact still runs on node20; maintainer requirement 2026-10-13: no Node-20 actions.
const ACTION_FLOORS = { 'actions/checkout': 5, 'actions/setup-node': 5, 'actions/upload-artifact': 6 };
const GATING = [cmdRe('npm test'), cmdRe('npm run torture:semantic'), cmdRe('node --expose-gc test/torture.mjs'), cmdRe('npm run soak:parity'),
    cmdRe('npm run test:gate'), cmdRe('npm run soak:teeth'), cmdRe('npm run soak:teeth:long'), cmdRe('npm run soak:report')];
const FALLBACK_CYCLES = "${{ inputs.cycles || '33' }}";
const FALLBACK_OPS = "${{ inputs.ops || '200000' }}";
const SNIPPET_IDS = new Set(['ptree', 'volume', 'smoke-report']);
const CANON = new Set(['npm test', 'npm run torture:semantic', 'node --expose-gc test/torture.mjs', 'npm run soak:parity', 'npm run test:gate',
    'npm run soak:report -- "$SOAK_OUT"', 'npm run soak']);
const TEETH = {
    teeth: 'mkdir -p "$RUNNER_TEMP/teeth"\nnpm run soak:teeth 2>&1 | tee "$RUNNER_TEMP/teeth/soak-teeth.log"',
    'teeth-long': 'mkdir -p "$RUNNER_TEMP/teeth-long"\nnpm run soak:teeth:long 2>&1 | tee "$RUNNER_TEMP/teeth-long/soak-teeth-long.log"',
};
// Pinned package.json script TEXT of every script a gating step runs (11d). A change to what `npm test` (etc.) runs needs a
// reviewed test/47 edit; do not "fix" this table to follow package.json without that review.
const SCRIPT_PINS = {
    'test': "node --test --test-reporter=spec 'test/*.test.mjs'",
    'torture:semantic': 'node bench/torture/run.mjs --group semantic',
    'soak:parity': 'node bench/soak/parity.mjs',
    'test:gate': 'node --expose-gc --max-semi-space-size=4 --test test/32-perf-gate.test.mjs',
    'soak': 'node --expose-gc bench/soak/main.mjs',
    'soak:report': 'node bench/soak/SoakReport.mjs',
    'soak:teeth': 'node bench/soak/_mustfail.mjs',
    'soak:teeth:long': 'node bench/soak/_mustfail.mjs --long',
};
const TOP_KEYS = ['name', 'on', 'permissions', 'defaults', 'env', 'concurrency', 'jobs'];
// 'if' and 'continue-on-error' at job level are owned by C17 / C9; step-level 'shell' by C17 (so each hole reports once).
const JOB_KEYS = ['name', 'runs-on', 'timeout-minutes', 'strategy', 'env', 'steps', 'if', 'continue-on-error'];
const STEP_KEYS = ['name', 'id', 'if', 'uses', 'with', 'run', 'env', 'timeout-minutes', 'continue-on-error', 'shell'];
const WARN_RE = /^echo "::warning::[^"$`\\\n]*"$/;
// sha256 of the two real workflow files (11e). Any workflow edit turns the real-files test red until a REVIEWED test/47 edit
// re-pins these (same policy as SCRIPT_PINS); the semantic checks C1-C18 then judge the new content.
const WORKFLOW_PINS = {
    'ci.yml': '6af9960dc998b89c9ac0ef16c38c5fc68919da14d2633b976f2e856885e55c12',
    'soak-nightly.yml': '007658a6d11a8a876017a577b43fddcc5ab780da327b188e3df4228a02b6381a',
};
const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const SOAK_OUT_PIN = { 'ci.yml': '${{ runner.temp }}/soak-out/smoke.jsonl', 'soak-nightly.yml': '${{ runner.temp }}/soak-out/burn-in.jsonl' };
const GATE_CMDS = ['npm test', 'npm run torture:semantic', 'node --expose-gc test/torture.mjs', 'npm run soak:parity', 'npm run test:gate'];
// Pinned step sequence per job, by kind (11d; order derived from 11 / 11a / 11b). Warning steps are position-free (spec silent),
// at most one, only in ci gates / burn-in. ptree and volume are an unordered pair (11a only says volume precedes the soak step).
const SEQ = {
    'ci.yml': {
        test: ['checkout', 'setup', 'install', 'npm test', 'npm run torture:semantic', 'node --expose-gc test/torture.mjs'],
        gates: ['checkout', 'setup', 'install', 'npm run soak:parity', 'npm run test:gate', 'ptree', 'soak', 'smoke-report', 'upload'],
    },
    'soak-nightly.yml': {
        'burn-in': ['checkout', 'setup', 'install', 'npm run soak:parity', ['ptree', 'volume'], 'soak', 'report', 'upload'],
        teeth: ['checkout', 'setup', 'install', 'npm run soak:parity', 'teeth', 'upload'],
        'teeth-long': ['checkout', 'setup', 'install', 'npm run soak:parity', 'teeth', 'upload'],
    },
};
const SOAK_ID = { 'ci.yml': { gates: 'smoke' }, 'soak-nightly.yml': { 'burn-in': 'soak' } };
function kindOf(s) {
    if (typeof s.uses === 'string') {
        if (s.uses.startsWith('actions/checkout')) return 'checkout';
        if (s.uses.startsWith('actions/setup-node')) return 'setup';
        if (s.uses.startsWith('actions/upload-artifact')) return 'upload';
        return 'uses:' + s.uses;
    }
    if (SNIPPET_IDS.has(s.id)) return s.id;
    const r = runOf(s);
    if (isSoak(s)) return 'soak';
    if (isReport(s)) return 'report';
    if (NEEDPAR_RE.test(r)) return 'teeth';
    for (const c of GATE_CMDS) if (cmdRe(c).test(r)) return c;
    if (r.trim() === 'npm ci') return 'install';
    if (WARN_RE.test(r.trim())) return 'warning';
    return 'other: ' + r.split('\n')[0].slice(0, 50);
}
function seqMatch(kinds, exp) {
    let i = 0;
    for (const e of exp) {
        if (Array.isArray(e)) { if (kinds.slice(i, i + e.length).sort().join() !== [...e].sort().join()) return false; i += e.length; }
        else { if (kinds[i] !== e) return false; i++; }
    }
    return i === kinds.length;
}
const isReport = (s) => cmdRe('npm run soak:report').test(runOf(s));
const isGating = (s) => s.id === 'ptree' || s.id === 'volume' || GATING.some((r) => r.test(runOf(s)));
const needsParity = (s) => isSoak(s) || NEEDPAR_RE.test(runOf(s));
const isSoak = (s) => SOAK_RE.test(runOf(s)) || 'SOAK_SMOKE' in envOf(s);
const norm = (v) => String(v).replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/\s+/g, '');
const alwaysIf = (s) => s.if !== undefined && norm(s.if) === 'always()';
const asList = (x) => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);

const ptreeCache = new Map();
/** Run the ptree snippet against temp GAPS modules (spec C9 meaning). Returns problem strings. */
export function ptreeMeaning(snippet) {
    if (ptreeCache.has(snippet)) return ptreeCache.get(snippet);
    const out = [];
    const cases = [
        ['GAPS = {} -> gap=false', 'export const GAPS = {};\n', 'false'],
        ['GAPS = {P-TREE} -> gap=true', "export const GAPS = { 'P-TREE': { why: 'x', until: 'y', covers: ['P-TREE'] } };\n", 'true'],
        ['module throws -> non-zero exit', "throw new Error('boom');\n", 'fail'],
        ['module has no GAPS -> non-zero exit', 'export const OTHER = 1;\n', 'fail'],
        ['teeth.mjs missing -> non-zero exit', null, 'fail'],
    ];
    for (const [label, mod, want] of cases) {
        const dir = mkdtempSync(join(tmpdir(), 'ptree-'));
        try {
            if (mod !== null) { mkdirSync(join(dir, 'bench', 'soak'), { recursive: true }); writeFileSync(join(dir, 'bench', 'soak', 'teeth.mjs'), mod); }
            writeFileSync(join(dir, 'snippet.sh'), snippet);
            writeFileSync(join(dir, 'gh-output.txt'), '');
            const r = spawnSync('bash', ['-eo', 'pipefail', join(dir, 'snippet.sh')], {
                cwd: dir, encoding: 'utf8', timeout: 30000,
                env: { ...process.env, GITHUB_OUTPUT: join(dir, 'gh-output.txt') },
            });
            const o = readFileSync(join(dir, 'gh-output.txt'), 'utf8');
            if (want === 'fail') {
                if (r.status === 0) out.push('C9: ptree snippet fails open (' + label + '): exit 0');
            } else {
                const other = want === 'true' ? 'false' : 'true';
                if (r.status !== 0) out.push('C9: ptree snippet (' + label + '): exit ' + r.status);
                else if (!new RegExp('^gap=' + want + '$', 'm').test(o) || new RegExp('^gap=' + other + '$', 'm').test(o)) {
                    out.push('C9: ptree snippet wrong verdict (' + label + '): ' + JSON.stringify(o));
                }
            }
        } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    ptreeCache.set(snippet, out);
    return out;
}

const memo = new Map();
function inTemp(fn) { const dir = mkdtempSync(join(tmpdir(), 'wf47-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
const cleanEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^SOAK_/i.test(k)) delete e[k]; return e; };

/** C17 smoke-report meaning (11b). Stub `npm` first on PATH prints REAL SoakReport line formats (SoakReport.mjs:18-25, 575-579:
 *  verdict line on stdout; NOT A RELEASE SOAK / INTEGRITY / CONFIG lines on stderr) and exits with a given code. */
export function smokeReportMeaning(snippet) {
    const key = 'smoke\0' + snippet;
    if (memo.has(key)) return memo.get(key);
    const V = 'soak:report: verdict PASS (consistent)';
    const cases = [
        ['exit 0 PASS verdict', V, '', 0, true],
        ['exit 0 FAIL verdict (consistent)', 'soak:report: verdict FAIL (consistent)', '', 0, true],
        ['exit 1 NOT A RELEASE SOAK -- smoke', V, 'soak:report: NOT A RELEASE SOAK -- smoke: SOAK_SMOKE=1 run', 1, true],
        ['exit 1 INTEGRITY', V, 'soak:report: INTEGRITY -- summary-missing: no summary record', 1, false],
        ['exit 1 NOT A RELEASE SOAK -- volume', V, 'soak:report: NOT A RELEASE SOAK -- volume: cycles 3 < 11', 1, false],
        ['exit 1 CRASH', '', 'soak:report: CRASH -- Error: x', 1, false],
        ['exit 1 smoke text without the soak:report: prefix', V, 'NOT A RELEASE SOAK -- smoke: SOAK_SMOKE=1 run', 1, false],
        ['exit 1 a different reason sharing the prefix (smokey)', V, 'soak:report: NOT A RELEASE SOAK -- smokey: x', 1, false],
        ['exit 2 CONFIG', '', 'soak:report: CONFIG -- no path', 2, false],
        ['exit 2 with the smoke line', V, 'soak:report: NOT A RELEASE SOAK -- smoke: x', 2, false],
        ['exit 3', '', '', 3, false],
        ['exit 1 smoke refusal AND an INTEGRITY line', V, 'soak:report: NOT A RELEASE SOAK -- smoke: x\nsoak:report: INTEGRITY -- summary-missing: y', 1, false],
    ];
    const out = [];
    for (const [label, so, se, code, pass] of cases) {
        inTemp((dir) => {
            mkdirSync(join(dir, 'bin'));
            writeFileSync(join(dir, 'bin', 'npm'), '#!/bin/sh\n[ -n "$STUB_OUT" ] && printf \'%s\\n\' "$STUB_OUT"\n[ -n "$STUB_ERR" ] && printf \'%s\\n\' "$STUB_ERR" >&2\nexit "$STUB_CODE"\n', { mode: 0o755 });
            writeFileSync(join(dir, 'snippet.sh'), snippet);
            const r = spawnSync('bash', ['-eo', 'pipefail', join(dir, 'snippet.sh')], {
                cwd: dir, encoding: 'utf8', timeout: 30000,
                env: { ...cleanEnv(), PATH: join(dir, 'bin') + ':' + process.env.PATH, SOAK_OUT: join(dir, 'out'), STUB_OUT: so, STUB_ERR: se, STUB_CODE: String(code) },
            });
            if ((r.status === 0) !== pass) out.push('C17: smoke-report snippet ' + (pass ? 'rejects' : 'accepts') + ' [' + label + '] (exit ' + r.status + ')');
        });
    }
    memo.set(key, out);
    return out;
}

/** C11 volume-guard meaning (11b). cwd = a temp root with a stub bench/soak/config.mjs. */
export function volumeMeaning(snippet) {
    const key = 'vol\0' + snippet;
    if (memo.has(key)) return memo.get(key);
    const GOOD = 'export const DEFAULT_CYCLES = 11;\nexport const DEFAULT_OPS = 100000;\n';
    const runIt = (cfg, c, o) => inTemp((dir) => {
        if (cfg !== null) { mkdirSync(join(dir, 'bench', 'soak'), { recursive: true }); writeFileSync(join(dir, 'bench', 'soak', 'config.mjs'), cfg); }
        writeFileSync(join(dir, 'snippet.sh'), snippet);
        const env = cleanEnv();
        if (c !== undefined) env.SOAK_CYCLES = c;
        if (o !== undefined) env.SOAK_OPS = o;
        return spawnSync('bash', ['-eo', 'pipefail', join(dir, 'snippet.sh')], { cwd: dir, encoding: 'utf8', timeout: 30000, env }).status;
    });
    const out = [];
    const cases = [
        ['33/200000', GOOD, '33', '200000', true], ['11/100000', GOOD, '11', '100000', true],
        ['cycles 0', GOOD, '0', '200000', false], ['cycles 10', GOOD, '10', '200000', false], ['cycles abc', GOOD, 'abc', '200000', false],
        ['cycles 033', GOOD, '033', '200000', false], ['cycles empty', GOOD, '', '200000', false], ['cycles unset', GOOD, undefined, '200000', false],
        ['ops 50000', GOOD, '33', '50000', false], ['ops 1e6', GOOD, '33', '1e6', false], ['ops 0', GOOD, '33', '0', false], ['ops unset', GOOD, '33', undefined, false],
        ['config throws', "throw new Error('boom');\n", '33', '200000', false],
        ['config non-integer floors', "export const DEFAULT_CYCLES = 'x';\nexport const DEFAULT_OPS = 1e5 + 0.5;\n", '33', '200000', false],
        ['config exports nothing', 'export const OTHER = 1;\n', '33', '200000', false],
        ['config missing', null, '33', '200000', false],
    ];
    for (const [label, cfg, c, o, pass] of cases) {
        const st = runIt(cfg, c, o);
        if ((st === 0) !== pass) out.push('C11: volume snippet ' + (pass ? 'rejects' : 'accepts') + ' [' + label + '] (exit ' + st + ')');
    }
    memo.set(key, out);
    return out;
}

export function workflowProblems(files, opts = {}) {
    const scripts = opts.scripts || PKG.scripts;
    const npmrc = opts.npmrc !== undefined ? opts.npmrc : existsSync(join(ROOT, '.npmrc'));
    const P = [];
    const names = Object.keys(files).sort();
    for (const n of EXPECTED_FILES) if (!names.includes(n)) P.push('C1: missing workflow file ' + n);
    for (const n of names) if (!EXPECTED_FILES.includes(n)) P.push('C1: unexpected workflow file ' + n);
    for (const n of names) if (/pull_request_target/.test(String(files[n]))) P.push('C13: pull_request_target in ' + n);

    for (const [k, v] of Object.entries(SCRIPT_PINS)) if (scripts[k] !== v) P.push('C8: package.json script ' + k + ' is ' + JSON.stringify(scripts[k]) + ', pinned ' + JSON.stringify(v));
    if (npmrc) P.push('C15: a repo .npmrc is present (npm config can silently change what the gates run)');
    if (opts.pins) for (const [pn, want] of Object.entries(opts.pins)) if (pn in files && sha256(String(files[pn])) !== want) P.push('C19: ' + pn + ' sha256 ' + sha256(String(files[pn])) + ' != pinned ' + want);
    const docs = {};
    for (const n of EXPECTED_FILES) {
        if (!(n in files)) continue;
        try { docs[n] = parseYaml(files[n]); if (!isObj(docs[n])) throw new Error('top level is not a mapping'); }
        catch (e) { P.push('PARSE: ' + n + ': ' + e.message); }
    }
    const ptrees = {};
    for (const n of Object.keys(docs)) {
        const d = docs[n];
        const jobs = isObj(d.jobs) ? d.jobs : {};
        const top = envOf(d);
        const tag = (c, m) => P.push(c + ': ' + n + ': ' + m);

        // C2 job set
        const have = Object.keys(jobs).sort();
        if (have.join(',') !== EXPECTED_JOBS[n].join(',')) tag('C2', 'jobs [' + have + '] != [' + EXPECTED_JOBS[n] + ']');

        // C3 timeouts
        for (const [jn, budget] of Object.entries(BUDGET[n])) {
            if (!(jn in jobs)) continue;
            const t = jobs[jn]['timeout-minutes'];
            if (typeof t !== 'number' || !(t > 0 && t <= budget)) tag('C3', 'job ' + jn + ' timeout-minutes ' + t + ' not in (0, ' + budget + ']');
        }
        for (const [jn, job] of Object.entries(jobs)) for (const s of stepsOf(job)) {
            if ('timeout-minutes' in s && !(Number.isInteger(s['timeout-minutes']) && s['timeout-minutes'] >= 1)) tag('C3', 'job ' + jn + ' step timeout-minutes must be an integer >= 1');
            if (/(^|\s)npm ci(\s|$)/.test(runOf(s)) && !(typeof s['timeout-minutes'] === 'number' && s['timeout-minutes'] <= 10)) tag('C3', 'job ' + jn + ' npm ci step lacks timeout-minutes <= 10');
        }

        // C4 checkout
        for (const [jn, job] of Object.entries(jobs)) for (const s of stepsOf(job)) {
            if (typeof s.uses === 'string' && s.uses.startsWith('actions/checkout')) {
                const w = isObj(s.with) ? s.with : {};
                if (!(w['fetch-depth'] === 0 || w['fetch-depth'] === '0')) tag('C4', 'job ' + jn + ' checkout fetch-depth is not 0');
                if (!(w['persist-credentials'] === false || w['persist-credentials'] === 'false')) tag('C4', 'job ' + jn + ' checkout persist-credentials is not false');
            }
        }

        // C5 permissions + shell
        if (!isObj(d.permissions) || Object.keys(d.permissions).join() !== 'contents' || d.permissions.contents !== 'read') tag('C5', 'permissions must be exactly contents: read');
        if (!(isObj(d.defaults) && isObj(d.defaults.run) && d.defaults.run.shell === 'bash')) tag('C5', 'defaults.run.shell must be bash');
        for (const [jn, job] of Object.entries(jobs)) {
            if (isObj(job) && 'permissions' in job && !(isObj(job.permissions) && Object.values(job.permissions).every((v) => v === 'read'))) tag('C5', 'job ' + jn + ' permissions beyond read');
        }

        // C6 matrix (ci.yml test job)
        if (n === 'ci.yml' && jobs.test) {
            const st = jobs.test.strategy;
            const m = isObj(st) ? st.matrix : undefined;
            if (!isObj(st) || st['fail-fast'] !== false) tag('C6', 'strategy.fail-fast must be false');
            if (!isObj(m)) tag('C6', 'no matrix');
            else {
                if ('exclude' in m) tag('C6', 'matrix.exclude not allowed');
                const cells = new Set();
                const key = (os, nd) => (String(os).startsWith('ubuntu') ? 'ubuntu' : String(os)) + '|' + String(nd);
                if ('os' in m && 'node' in m) for (const o of asList(m.os)) for (const v of asList(m.node)) cells.add(key(o, v));
                for (const inc of asList(m.include)) if (isObj(inc)) cells.add(key(inc.os, inc.node));
                const got = [...cells].sort();
                if (got.join(',') !== DECLARED_CELLS.join(',')) tag('C6', 'matrix cells [' + got + '] != [' + DECLARED_CELLS + ']');
            }
            if (!stepsOf(jobs.test).some((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node') && isObj(s.with) && /matrix\.node/.test(String(s.with['node-version'])))) tag('C6', 'test job setup-node must use matrix.node');
        }

        // C7 PIN_NODE
        const sn = top.PIN_NODE;
        if (typeof sn !== 'string' || !/^\d+\.\d+\.\d+$/.test(sn)) tag('C7', 'env.PIN_NODE ' + JSON.stringify(sn) + ' is not an exact x.y.z string');
        else if (sn !== DECLARED_NODE) tag('C7', 'env.PIN_NODE ' + sn + ' != ' + DECLARED_NODE);
        if (n === 'ci.yml' && jobs.gates && !stepsOf(jobs.gates).some((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node') && isObj(s.with) && /env\.PIN_NODE/.test(String(s.with['node-version'])))) tag('C7', 'gates job setup-node must use env.PIN_NODE');

        // C8 npm scripts + MUSTFAIL_ONLY + required commands
        if (/MUSTFAIL_ONLY/.test(files[n])) tag('C8', 'MUSTFAIL_ONLY present');
        const jobRuns = {};
        for (const [jn, job] of Object.entries(jobs)) {
            jobRuns[jn] = stepsOf(job).map(runOf).join('\n');
            for (const m of jobRuns[jn].matchAll(/npm run (?:-s |--silent )?([^\s;&|]+)/g)) {
                if (!(m[1] in PKG.scripts)) tag('C8', 'job ' + jn + ' runs npm run ' + m[1] + ' which is not a package.json script');
            }
        }
        const need = n === 'ci.yml'
            ? { test: ['npm ci', 'npm test', 'npm run torture:semantic', 'node --expose-gc test/torture.mjs'], gates: ['npm run test:gate'] }
            : { 'burn-in': ['npm run soak:report'], teeth: ['npm run soak:teeth'], 'teeth-long': ['npm run soak:teeth:long'] };
        for (const [jn, cmds] of Object.entries(need)) if (jn in jobs) for (const c of cmds) if (!cmdRe(c).test(jobRuns[jn])) tag('C8', 'job ' + jn + ' lacks required command ' + c);

        // C9 continue-on-error + ptree
        const soakJob = n === 'ci.yml' ? 'gates' : 'burn-in';
        for (const [jn, job] of Object.entries(jobs)) {
            if (isObj(job) && 'if' in job) tag('C17', 'job ' + jn + ' has a job-level if:');
            if (isObj(job) && 'continue-on-error' in job) tag('C9', 'job ' + jn + ' has job-level continue-on-error');
            const st = stepsOf(job);
            st.forEach((s, idx) => {
                const has = 'continue-on-error' in s;
                const soak = isSoak(s);
                if (has && !soak) tag('C9', 'job ' + jn + ' continue-on-error on a non-soak step');
                if (has && soak && String(s['continue-on-error']).trim() !== KEYED) tag('C9', 'job ' + jn + ' continue-on-error is not keyed exactly to ' + KEYED);
                if (soak && !has && jn === soakJob) tag('C9', 'job ' + jn + ' soak step lacks the keyed continue-on-error');
                if (soak && jn === soakJob && !st.slice(0, idx).some((x) => x.id === 'ptree')) tag('C9', 'job ' + jn + ' soak step not preceded by the ptree step');
            });
        }
        const pt = jobs[soakJob] ? stepsOf(jobs[soakJob]).filter((s) => s.id === 'ptree') : [];
        if (jobs[soakJob] && pt.length !== 1) tag('C9', 'job ' + soakJob + ' needs exactly one step with id ptree');
        else if (pt.length === 1) {
            ptrees[n] = runOf(pt[0]);
            if (!/GITHUB_OUTPUT/.test(ptrees[n]) || !/bench\/soak\/teeth\.mjs/.test(ptrees[n])) tag('C9', 'ptree snippet must import bench/soak/teeth.mjs and write $GITHUB_OUTPUT');
        }
        if (n === 'ci.yml' && jobs.gates && !/::warning::/.test(jobRuns.gates)) tag('C9', 'gates job has no ::warning:: step');

        // C10 uploads
        for (const [jn, job] of Object.entries(jobs)) for (const s of stepsOf(job)) {
            if (typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact')) {
                if (!alwaysIf(s)) tag('C10', 'job ' + jn + ' upload-artifact step lacks if: always()');
                if (jn === 'burn-in' && !(isObj(s.with) && s.with['if-no-files-found'] === 'error')) tag('C10', 'burn-in upload lacks if-no-files-found: error');
            }
        }
        if (n === 'soak-nightly.yml' && jobs['burn-in']) {
            const bi = stepsOf(jobs['burn-in']);
            if (!bi.some((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact'))) tag('C10', 'burn-in has no upload-artifact step');
        }
        for (const jn of ['teeth', 'teeth-long']) if (n === 'soak-nightly.yml' && jobs[jn] && !stepsOf(jobs[jn]).some((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact'))) tag('C10', 'job ' + jn + ' uploads no logs');

        // C11 release-shaped burn-in + volume defaults
        if (n === 'soak-nightly.yml') {
            const bj = jobs['burn-in'];
            const ss = bj ? stepsOf(bj).filter(isSoak) : [];
            if (bj && ss.length === 0) tag('C2', 'burn-in has no soak step');
            if (bj) {
                // assumption: the volume guard is the burn-in step with `id: volume`; it must read SOAK_CYCLES / SOAK_OPS and precede the soak step
                const st = stepsOf(bj);
                for (const x of st) {
                    const e = envOf(x);
                    if ('SOAK_CYCLES' in e && String(e.SOAK_CYCLES) !== FALLBACK_CYCLES) tag('C11', 'burn-in step env SOAK_CYCLES must be exactly ' + FALLBACK_CYCLES);
                    if ('SOAK_OPS' in e && String(e.SOAK_OPS) !== FALLBACK_OPS) tag('C11', 'burn-in step env SOAK_OPS must be exactly ' + FALLBACK_OPS);
                }
                if (!(33 >= DEFAULT_CYCLES) || !(200000 >= DEFAULT_OPS)) tag('C11', 'fallbacks 33 / 200000 are below config DEFAULT_CYCLES / DEFAULT_OPS');
                const gi = st.findIndex((x) => x.id === 'volume');
                const si = st.findIndex(isSoak);
                if (gi < 0) tag('C11', 'burn-in has no volume guard step (id: volume)');
                else {
                    if (si >= 0 && gi > si) tag('C11', 'burn-in volume guard comes after the soak step');
                    const gr = runOf(st[gi]);
                    if (!/SOAK_CYCLES/.test(gr) || !/SOAK_OPS/.test(gr)) tag('C11', 'burn-in volume guard does not check SOAK_CYCLES and SOAK_OPS');
                }
            }
            for (const s of ss) {
                const env = { ...top, ...envOf(bj), ...envOf(s) };
                if (String(env.SOAK_REQUIRE_PROVENANCE) !== '1') tag('C11', 'burn-in soak step SOAK_REQUIRE_PROVENANCE must be 1');
                for (const k of Object.keys(env)) if (/^SOAK_(LANES|KERNEL|SMOKE|MUSTFAIL)/.test(k)) tag('C11', 'burn-in soak step env has ' + k);
                if (/SOAK_(LANES|KERNEL|SMOKE|MUSTFAIL)/.test(runOf(s))) tag('C11', 'burn-in soak step run mentions a non-release variable');
                if (String(env.SOAK_CYCLES) !== FALLBACK_CYCLES) tag('C11', 'burn-in SOAK_CYCLES must be exactly ' + FALLBACK_CYCLES);
                if (String(env.SOAK_OPS) !== FALLBACK_OPS) tag('C11', 'burn-in SOAK_OPS must be exactly ' + FALLBACK_OPS);
            }
            const inp = isObj(d.on) && isObj(d.on.workflow_dispatch) && isObj(d.on.workflow_dispatch.inputs) ? d.on.workflow_dispatch.inputs : {};
            for (const [k, floor, nm] of [['cycles', DEFAULT_CYCLES, 'DEFAULT_CYCLES'], ['ops', DEFAULT_OPS, 'DEFAULT_OPS']]) {
                const dv = isObj(inp[k]) ? Number(inp[k].default) : NaN;
                if (!(dv >= floor)) tag('C11', 'dispatch input ' + k + ' default ' + (isObj(inp[k]) ? inp[k].default : undefined) + ' < ' + nm + ' ' + floor);
            }
        }

        // C12 untrusted expressions in run
        for (const [jn, job] of Object.entries(jobs)) for (const s of stepsOf(job)) {
            const r = runOf(s);
            if (/\$\{\{[^}]*\binputs\./.test(r) || /github\.event/.test(r)) tag('C12', 'job ' + jn + ' run: interpolates inputs / github.event');
        }

        // C13 triggers
        const on = d.on;
        if (!isObj(on)) tag('C13', 'on: must be a mapping');
        else if (n === 'ci.yml') {
            const br = isObj(on.push) ? asList(on.push.branches).map(String).sort() : [];
            if (br.join(',') !== '1.6.0-dev,main') tag('C13', 'push.branches [' + br + '] != [1.6.0-dev,main]');
            if (!('pull_request' in on)) tag('C13', 'missing pull_request');
            if (!('workflow_dispatch' in on)) tag('C13', 'missing workflow_dispatch');
        } else {
            if (!asList(on.schedule).some((x) => isObj(x) && x.cron === '0 4 * * *')) tag('C13', "missing schedule cron '0 4 * * *'");
            if (!('workflow_dispatch' in on)) tag('C13', 'missing workflow_dispatch');
            const br = isObj(on.push) ? asList(on.push.branches).map(String) : [];
            if (br.join(',') !== '1.6.0-dev') tag('C13', 'push.branches [' + br + '] != [1.6.0-dev]');
        }

        // C2 extension: the soak step itself must exist (ci gates smoke, burn-in soak)
        if (n === 'ci.yml' && jobs.gates && !stepsOf(jobs.gates).some(isSoak)) tag('C2', 'gates job has no smoke step');
        // gates smoke-stream soak:report: presence by `id: smoke-report` (C2); content is judged by behaviour (C17)
        if (n === 'ci.yml' && jobs.gates && !stepsOf(jobs.gates).some((x) => x.id === 'smoke-report')) tag('C2', 'gates job has no step with id smoke-report');

        // C13 concurrency pin: ci cancels, nightly never cancels
        if (!isObj(d.concurrency) || d.concurrency['cancel-in-progress'] !== (n === 'ci.yml')) tag('C13', 'concurrency.cancel-in-progress must be ' + (n === 'ci.yml'));

        // C15 allow-list: every env key (workflow / job / step) is PIN_NODE or a config KNOWN_KEYS entry (NODE_OPTIONS, npm_config_*, NODE_TEST_* can silently skip tests)
        const envScopes = [['workflow', top]];
        for (const [jn, job] of Object.entries(jobs)) {
            envScopes.push(['job ' + jn, envOf(job)]);
            for (const s of stepsOf(job)) envScopes.push(['job ' + jn + ' step', envOf(s)]);
        }
        for (const [where, e] of envScopes) for (const k of Object.keys(e)) if (k !== 'PIN_NODE' && !KNOWN_KEYS.includes(k)) tag('C15', where + ' env key ' + k + ' is not PIN_NODE or a config KNOWN_KEYS entry');

        // C16 action allow-list + major floors
        for (const [jn, job] of Object.entries(jobs)) for (const s of stepsOf(job)) {
            if (s.uses === undefined) continue;
            const m = /^(actions\/[a-z-]+)@v(\d+)$/.exec(String(s.uses));
            if (!m || !(m[1] in ACTION_FLOORS)) tag('C16', 'job ' + jn + ' uses ' + s.uses + ' (not an allowed action@vN)');
            else if (Number(m[2]) < ACTION_FLOORS[m[1]]) tag('C16', 'job ' + jn + ' uses ' + s.uses + ' below floor v' + ACTION_FLOORS[m[1]]);
        }

        // C17 strict gating steps (11b: exact text for one-command steps, behaviour for snippet steps)
        for (const [jn, job] of Object.entries(jobs)) for (const s of stepsOf(job)) {
            if ('shell' in s) tag('C17', 'job ' + jn + ' step-level shell: is forbidden');
            const soakStep = isSoak(s);
            if (!isGating(s) && !soakStep) continue;
            const r = runOf(s);
            if (!SNIPPET_IDS.has(s.id) && EXPECTED_JOBS[n].includes(jn)) {
                const t = r.trim();
                const ok = NEEDPAR_RE.test(r) ? t === TEETH[jn] : CANON.has(t);
                if (!ok) tag('C17', 'job ' + jn + ' gating step text is not canonical: ' + JSON.stringify(t.slice(0, 80)));
            }
            if (isReport(s)) { if (!alwaysIf(s)) tag('C17', 'job ' + jn + ' soak:report step must be exactly if: always()'); }
            else if ('if' in s) tag('C17', 'job ' + jn + ' gating step has an if: (' + r.split('\n')[0] + ')');
            if ('continue-on-error' in s && !soakStep) tag('C17', 'job ' + jn + ' gating step has continue-on-error');
            if (/\|\|\s*(true|:)(?![\w])/.test(r) || /set \+e|set \+o pipefail/.test(r)) tag('C17', 'job ' + jn + ' gating step swallows failure (' + r.split('\n')[0] + ')');
        }
        if (n === 'ci.yml' && jobs.gates) {
            const sr = stepsOf(jobs.gates).filter((x) => x.id === 'smoke-report');
            if (sr.length === 1) P.push(...smokeReportMeaning(runOf(sr[0])).map((m) => m + ' [ci.yml]'));
        }
        if (n === 'soak-nightly.yml' && jobs['burn-in']) {
            const vs = stepsOf(jobs['burn-in']).filter((x) => x.id === 'volume');
            if (vs.length === 1) P.push(...volumeMeaning(runOf(vs[0])).map((m) => m + ' [soak-nightly.yml]'));
        }

        // C13 trigger keys: no path / branch / tag filters beyond the declared ones
        if (isObj(d.on)) {
            const allowed = n === 'ci.yml' ? ['push', 'pull_request', 'workflow_dispatch'] : ['push', 'schedule', 'workflow_dispatch'];
            for (const k of Object.keys(d.on)) if (!allowed.includes(k)) tag('C13', 'unexpected trigger ' + k);
            if (isObj(d.on.push)) for (const k of Object.keys(d.on.push)) if (k !== 'branches') tag('C13', 'push.' + k + ' is not allowed (only branches)');
            if ('pull_request' in d.on && d.on.pull_request !== null && !(isObj(d.on.pull_request) && Object.keys(d.on.pull_request).length === 0)) tag('C13', 'pull_request must have no keys');
            for (const x of asList(d.on.schedule)) if (isObj(x)) for (const k of Object.keys(x)) if (k !== 'cron') tag('C13', 'schedule.' + k + ' is not allowed (only cron)');
            const wd = d.on.workflow_dispatch;
            if (isObj(wd)) {
                for (const k of Object.keys(wd)) if (k !== 'inputs' || n === 'ci.yml') tag('C13', 'workflow_dispatch.' + k + ' is not allowed');
                if (isObj(wd.inputs) && Object.keys(wd.inputs).sort().join() !== 'cycles,ops') tag('C13', 'workflow_dispatch inputs must be exactly cycles and ops');
            }
        }

        // C18 closed-world schema (11d)
        {
            const t18 = (m) => tag('C18', m);
            for (const k of Object.keys(d)) if (!TOP_KEYS.includes(k)) t18('unexpected top-level key ' + k);
            for (const k of ['name', 'on', 'concurrency', 'jobs']) if (!(k in d)) t18('missing top-level key ' + k);
            if (isObj(d.defaults)) {
                for (const k of Object.keys(d.defaults)) if (k !== 'run') t18('defaults.' + k + ' not allowed');
                if (isObj(d.defaults.run)) for (const k of Object.keys(d.defaults.run)) if (k !== 'shell') t18('defaults.run.' + k + ' not allowed');
            }
            if (isObj(d.env)) for (const k of Object.keys(d.env)) if (k !== 'PIN_NODE') t18('workflow env key ' + k + ' not allowed');
            for (const [jn, job] of Object.entries(jobs)) {
                if (!isObj(job)) { t18('job ' + jn + ' is not a mapping'); continue; }
                for (const k of Object.keys(job)) if (!JOB_KEYS.includes(k)) t18('job ' + jn + ' key ' + k + ' not allowed');
                const isCiTest = n === 'ci.yml' && jn === 'test';
                if (job['runs-on'] !== (isCiTest ? '${{ matrix.os }}' : 'ubuntu-latest')) t18('job ' + jn + ' runs-on ' + JSON.stringify(job['runs-on']) + ' is not pinned');
                if ('strategy' in job && !isCiTest) t18('job ' + jn + ' must not have a strategy');
                if (!Array.isArray(job.steps)) { t18('job ' + jn + ' steps is not a list'); continue; }
                const kinds = [];
                let warns = 0;
                for (const st of job.steps) {
                    if (!isObj(st)) { t18('job ' + jn + ' has a non-mapping step'); continue; }
                    for (const k of Object.keys(st)) if (!STEP_KEYS.includes(k)) t18('job ' + jn + ' step key ' + k + ' not allowed');
                    const w = isObj(st.with) ? st.with : {};
                    const k = kindOf(st);
                    if (k === 'warning') {
                        warns++;
                        const sid = (SOAK_ID[n] || {})[jn];
                        if (!sid) t18('job ' + jn + ' must not have a ::warning:: step');
                        else if (st.if !== "steps." + sid + ".outcome == 'failure'") t18('job ' + jn + " warning step if: must be steps." + sid + ".outcome == 'failure'");
                        for (const x of Object.keys(st)) if (!['name', 'if', 'run'].includes(x)) t18('job ' + jn + ' warning step key ' + x + ' not allowed');
                        continue;
                    }
                    kinds.push(k);
                    if (k === 'checkout' && Object.keys(w).sort().join() !== 'fetch-depth,persist-credentials') t18('job ' + jn + ' checkout with must be exactly fetch-depth + persist-credentials');
                    if (k === 'setup') {
                        for (const x of Object.keys(w)) if (!['node-version', 'cache'].includes(x)) t18('job ' + jn + ' setup-node with.' + x + ' not allowed');
                        if ('cache' in w && w.cache !== 'npm') t18('job ' + jn + ' setup-node cache must be npm');
                        const want = isCiTest ? '${{ matrix.node }}' : '${{ env.PIN_NODE }}';
                        if (w['node-version'] !== want) t18('job ' + jn + ' setup-node node-version must be exactly ' + want);
                    }
                    if (k === 'upload') {
                        for (const x of Object.keys(w)) if (!['name', 'path', 'if-no-files-found', 'retention-days'].includes(x)) t18('job ' + jn + ' upload with.' + x + ' not allowed');
                        if ('retention-days' in w && !(typeof w['retention-days'] === 'number' && w['retention-days'] >= 7)) t18('job ' + jn + ' upload retention-days must be >= 7');
                    }
                    if (k === 'soak' && (SOAK_ID[n] || {})[jn] !== undefined && st.id !== SOAK_ID[n][jn]) t18('job ' + jn + ' soak step id must be ' + SOAK_ID[n][jn]);
                    if (/GITHUB_(ENV|PATH)/.test(runOf(st))) t18('job ' + jn + ' run mentions GITHUB_ENV / GITHUB_PATH');
                }
                // `if:` only on warning, upload and soak:report steps
                job.steps.forEach((st) => { if (isObj(st) && 'if' in st && !['warning', 'upload', 'report', 'smoke-report'].includes(kindOf(st))) t18('job ' + jn + ' step has an if: but is not a warning / upload / soak:report step'); });
                // warning sits between its soak step and that soak's report step
                const allKinds = job.steps.filter(isObj).map(kindOf);
                const wi = allKinds.indexOf('warning');
                if (wi >= 0) {
                    const si = allKinds.indexOf('soak');
                    const ri = allKinds.findIndex((x) => x === 'report' || x === 'smoke-report');
                    if (!(si >= 0 && ri > si && wi > si && wi < ri)) t18('job ' + jn + ' warning step must sit between the soak step and its report step');
                }
                // SOAK_OUT of the soak / report pair: same exact value
                if (SOAK_ID[n] && SOAK_ID[n][jn]) {
                    for (const st of job.steps.filter(isObj)) {
                        const kk = kindOf(st);
                        if (kk === 'soak' || kk === 'report' || kk === 'smoke-report') {
                            const eff = { ...envOf(job), ...envOf(st) }.SOAK_OUT;
                            if (eff !== SOAK_OUT_PIN[n]) t18('job ' + jn + ' ' + kk + ' step SOAK_OUT is ' + JSON.stringify(eff) + ', pinned ' + SOAK_OUT_PIN[n]);
                        }
                    }
                }
                if (warns > 1) t18('job ' + jn + ' has more than one ::warning:: step');
                const exp = (SEQ[n] || {})[jn];
                if (exp && !seqMatch(kinds, exp)) t18('job ' + jn + ' step sequence [' + kinds + '] != pinned [' + exp.map((e) => (Array.isArray(e) ? '{' + e + '}' : e)) + ']');
            }
        }

        // C14 parity before every soak step
        for (const [jn, job] of Object.entries(jobs)) {
            const st = stepsOf(job);
            st.forEach((s, idx) => {
                if (needsParity(s) && !st.slice(0, idx).some((x) => cmdRe('npm run soak:parity').test(runOf(x)))) tag('C14', 'job ' + jn + ' soak / teeth step not preceded by npm run soak:parity');
            });
        }
    }
    // C9 cross-file + meaning
    if (EXPECTED_FILES.every((f) => f in ptrees)) {
        if (ptrees['ci.yml'] !== ptrees['soak-nightly.yml']) P.push('C9: ptree snippet differs between ci.yml and soak-nightly.yml');
    }
    const seen = new Set();
    for (const f of Object.keys(ptrees)) if (!seen.has(ptrees[f])) { seen.add(ptrees[f]); P.push(...ptreeMeaning(ptrees[f]).map((m) => m + ' [' + f + ']')); }
    // C7 equality
    if (docs['ci.yml'] && docs['soak-nightly.yml'] && envOf(docs['ci.yml']).PIN_NODE !== envOf(docs['soak-nightly.yml']).PIN_NODE) P.push('C7: PIN_NODE differs between ci.yml and soak-nightly.yml');
    return P;
}

const families = (p) => [...new Set(p.map((x) => x.split(':')[0]))].sort();

// ---------------------------------------------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------------------------------------------

test('parser: good input (maps, nested seqs, quotes, comments, block scalars, same-indent seq)', () => {
    const y = [
        '# lead comment',
        'name: x  # trailing',
        'on:',
        '  push:',
        '    branches:',
        '      - main',
        '      - 1.6.0-dev',
        '  pull_request:',
        'items:',
        '- a',
        '- k: 1',
        '  j: "two: 2"',
        '- \'it\'\'s\'',
        'n: 30',
        'f: false',
        'run1: |',
        '  line one',
        '',
        '    indented',
        'run2: |-',
        '  solo',
        'after: ${{ a.b == \'c\' }}',
        '',
    ].join('\n');
    assert.deepEqual(JSON.parse(JSON.stringify(parseYaml(y))), {
        name: 'x',
        on: { push: { branches: ['main', '1.6.0-dev'] }, pull_request: null },
        items: ['a', { k: 1, j: 'two: 2' }, "it's"],
        n: 30, f: false,
        run1: 'line one\n\n  indented\n',
        run2: 'solo',
        after: "${{ a.b == 'c' }}",
    });
});

const REJECT = [
    ['tab', 'a:\n\tb: 1\n'],
    ['carriage return', 'a: 1\r\nb: 2\r\n'],
    ['non-ASCII', 'a: caf\u00e9\n'],
    ['anchor', 'a: &x 1\n'],
    ['alias', 'a: *x\n'],
    ['flow map', 'a: {b: 1}\n'],
    ['flow seq', 'a: [1, 2]\n'],
    ['folded scalar >', 'a: >\n  text\n'],
    ['folded scalar >-', 'a: >-\n  text\n'],
    ['keep scalar |+', 'a: |+\n  text\n'],
    ['document marker start', '---\na: 1\n'],
    ['document marker mid', 'a: 1\n---\nb: 2\n'],
    ['duplicate key', 'a: 1\na: 2\n'],
    ['bad indentation', 'a: 1\n  b: 2\n'],
    ['plain scalar with ": "', 'a: b: c\n'],
    ['unterminated quote', "a: 'x\n"],
    ['junk after quote', "a: 'x' y\n"],
    ['not a mapping entry', 'a: 1\nplain\n'],
    ['tag', 'a: !!str 1\n'],
    ['empty document', '# nothing\n'],
];
for (const [label, y] of REJECT) test('parser: rejects ' + label, () => assert.throws(() => parseYaml(y), /yaml/));

// ---------------------------------------------------------------------------------------------------------------
// Real files (A1: RED on HEAD -- the files do not exist yet, so C1 fires)
// ---------------------------------------------------------------------------------------------------------------

function loadReal() {
    const out = {};
    if (!existsSync(WF_DIR)) return out;
    for (const f of readdirSync(WF_DIR)) out[f] = readFileSync(join(WF_DIR, f), 'utf8');
    return out;
}

test('A1: the real .github/workflows files have no problems and match their sha256 pins (red on HEAD: C1 files missing)', () => {
    assert.deepEqual(workflowProblems(loadReal(), { pins: WORKFLOW_PINS }), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Fixture: a minimal VALID pair, independent of the real files
// ---------------------------------------------------------------------------------------------------------------

const PTREE = String.raw`node --input-type=module -e "
import { appendFileSync } from 'node:fs';
const { GAPS } = await import('./bench/soak/teeth.mjs');
if (GAPS === null || typeof GAPS !== 'object') throw new Error('GAPS missing');
const gap = Object.keys(GAPS).includes('P-TREE');
appendFileSync(process.env.GITHUB_OUTPUT, 'gap=' + gap + '\n');
"
`;
const ind = (t, n) => t.split('\n').map((l) => (l === '' ? l : ' '.repeat(n) + l)).join('\n');
const CHECKOUT = `      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
`;
const SETUP = (v) => `      - uses: actions/setup-node@v7
        with:
          node-version: ${v}
`;
const VOLUME = String.raw`node --input-type=module -e "
const { DEFAULT_CYCLES, DEFAULT_OPS } = await import('./bench/soak/config.mjs');
const ok = (v) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
const c = process.env.SOAK_CYCLES;
const o = process.env.SOAK_OPS;
if (!Number.isInteger(DEFAULT_CYCLES) || !Number.isInteger(DEFAULT_OPS)) throw new Error('bad floors');
if (!ok(c) || !ok(o) || Number(c) < DEFAULT_CYCLES || Number(o) < DEFAULT_OPS) { console.error('volume below the release floor'); process.exit(1); }
"
`;
const PTREE_STEP = `      - id: ptree
        run: |
${ind(PTREE, 10)}`;

function fixture() {
    const ci = `name: ci
on:
  push:
    branches:
      - main
      - 1.6.0-dev
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
defaults:
  run:
    shell: bash
env:
  PIN_NODE: '26.8.2'
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: \${{ matrix.os }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        os:
          - ubuntu-latest
        node:
          - '22'
          - '24'
          - '26'
        include:
          - os: macos-latest
            node: '24'
    steps:
${CHECKOUT}${SETUP('${{ matrix.node }}')}      - name: install
        run: npm ci
        timeout-minutes: 10
      - run: npm test
      - run: npm run torture:semantic
      - run: node --expose-gc test/torture.mjs
  gates:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      SOAK_OUT: \${{ runner.temp }}/soak-out/smoke.jsonl
    steps:
${CHECKOUT}${SETUP('${{ env.PIN_NODE }}')}      - name: install
        run: npm ci
        timeout-minutes: 10
      - run: npm run soak:parity
      - run: npm run test:gate
${PTREE_STEP}      - id: smoke
        continue-on-error: \${{ steps.ptree.outputs.gap == 'true' }}
        env:
          SOAK_SMOKE: '1'
        run: npm run soak
      - name: warn
        if: steps.smoke.outcome == 'failure'
        run: echo "::warning::smoke red while P-TREE is a GAP"
      - id: smoke-report
        if: always()
        run: |
          out=$(npm run soak:report -- "$SOAK_OUT" 2>&1) && rc=0 || rc=$?
          echo "$out"
          if [ "$rc" -eq 0 ]; then exit 0; fi
          if printf '%s' "$out" | grep -qE 'soak:report: (INTEGRITY|CRASH|CONFIG) --'; then exit 1; fi
          if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -qF 'soak:report: NOT A RELEASE SOAK -- smoke:'; then exit 0; fi
          exit 1
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: smoke
          path: \${{ env.SOAK_OUT }}
`;
    const nightly = `name: soak-nightly
on:
  schedule:
    - cron: '0 4 * * *'
  workflow_dispatch:
    inputs:
      cycles:
        description: cycles
        default: '33'
      ops:
        description: ops
        default: '200000'
  push:
    branches:
      - 1.6.0-dev
permissions:
  contents: read
defaults:
  run:
    shell: bash
env:
  PIN_NODE: '26.8.2'
concurrency:
  group: nightly-\${{ github.ref }}
  cancel-in-progress: false
jobs:
  burn-in:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      SOAK_OUT: \${{ runner.temp }}/soak-out/burn-in.jsonl
    steps:
${CHECKOUT}${SETUP('${{ env.PIN_NODE }}')}      - name: install
        run: npm ci
        timeout-minutes: 10
      - run: npm run soak:parity
${PTREE_STEP}      - id: volume
        env:
          SOAK_CYCLES: \${{ inputs.cycles || '33' }}
          SOAK_OPS: \${{ inputs.ops || '200000' }}
        run: |
${ind(VOLUME, 10)}      - id: soak
        continue-on-error: \${{ steps.ptree.outputs.gap == 'true' }}
        env:
          SOAK_REQUIRE_PROVENANCE: '1'
          SOAK_CYCLES: \${{ inputs.cycles || '33' }}
          SOAK_OPS: \${{ inputs.ops || '200000' }}
        run: npm run soak
      - name: report
        if: always()
        run: npm run soak:report -- "$SOAK_OUT"
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: burn-in
          path: \${{ env.SOAK_OUT }}
          if-no-files-found: error
  teeth:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
${CHECKOUT}${SETUP('${{ env.PIN_NODE }}')}      - name: install
        run: npm ci
        timeout-minutes: 10
      - run: npm run soak:parity
      - run: |
          mkdir -p "$RUNNER_TEMP/teeth"
          npm run soak:teeth 2>&1 | tee "$RUNNER_TEMP/teeth/soak-teeth.log"
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: teeth
          path: \${{ runner.temp }}/teeth
  teeth-long:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
${CHECKOUT}${SETUP('${{ env.PIN_NODE }}')}      - name: install
        run: npm ci
        timeout-minutes: 10
      - run: npm run soak:parity
      - run: |
          mkdir -p "$RUNNER_TEMP/teeth-long"
          npm run soak:teeth:long 2>&1 | tee "$RUNNER_TEMP/teeth-long/soak-teeth-long.log"
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: teeth-long
          path: \${{ runner.temp }}/teeth-long
`;
    return { 'ci.yml': ci, 'soak-nightly.yml': nightly };
}

/** Exactly-once anchor (or exactly `count` times): 0 or wrong count throws, so a stale mutation cannot pass silently. */
function rep(text, from, to, count = 1) {
    const n = text.split(from).length - 1;
    if (n !== count) throw new Error('anchor matched ' + n + ' times (want ' + count + '): ' + JSON.stringify(from));
    return text.split(from).join(to);
}
/** Edit only inside one job's text segment (jobs are two-space-indented keys under jobs:). */
function inJob(t, name, next, from, to, count = 1) {
    const a = t.indexOf('\n  ' + name + ':\n');
    const b = next ? t.indexOf('\n  ' + next + ':\n') : t.length;
    if (a < 0 || b < a) throw new Error('job segment not found: ' + name);
    return t.slice(0, a) + rep(t.slice(a, b), from, to, count) + t.slice(b);
}
const withFile = (f, name, fn) => ({ ...f, [name]: fn(f[name]) });

test('fixture: the clean pair parses and has no problems', () => {
    assert.deepEqual(workflowProblems(fixture()), []);
});

test('rep(): an anchor that matches 0 or 2+ times throws (A1 anchor)', () => {
    assert.throws(() => rep('abc', 'zzz', 'y'), /matched 0/);
    assert.throws(() => rep('aa', 'a', 'b'), /matched 2/);
});

// ---------------------------------------------------------------------------------------------------------------
// One+ doctored copy per check: must name exactly its own family
// ---------------------------------------------------------------------------------------------------------------

const CI = 'ci.yml';
const NT = 'soak-nightly.yml';
const GAPLINE = "const gap = Object.keys(GAPS).includes('P-TREE');";
const THROWLINE = "if (GAPS === null || typeof GAPS !== 'object') throw new Error('GAPS missing');\n";

const CASES = [
    ['C1', 'extra workflow file soak-ab.yml', (f) => ({ ...f, 'soak-ab.yml': 'name: x\n' })],
    ['C1', 'ci.yml deleted', (f) => { const g = { ...f }; delete g[CI]; return g; }],
    ['C1', 'xengine.yml added', (f) => ({ ...f, 'xengine.yml': 'name: x\n' })],
    ['C2', 'extra wrap job', (f) => withFile(f, CI, (t) => t + '  wrap:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    steps:\n      - run: echo hi\n')],
    ['C2', 'teeth-long job renamed', (f) => withFile(f, NT, (t) => rep(t, '  teeth-long:\n', '  teeth-longer:\n'))],
    ['C2', 'ci gates job dropped to a different name', (f) => withFile(f, CI, (t) => rep(t, '  gates:\n', '  gate:\n'))],
    ['C3', 'ci test timeout 31', (f) => withFile(f, CI, (t) => rep(t, '    runs-on: ${{ matrix.os }}\n    timeout-minutes: 30\n', '    runs-on: ${{ matrix.os }}\n    timeout-minutes: 31\n'))],
    ['C3', 'burn-in timeout removed', (f) => withFile(f, NT, (t) => rep(t, '    timeout-minutes: 90\n', ''))],
    ['C3', 'teeth-long timeout 121', (f) => withFile(f, NT, (t) => rep(t, '    timeout-minutes: 120\n', '    timeout-minutes: 121\n'))],
    ['C3', 'npm ci step timeout 11 (gates)', (f) => withFile(f, CI, (t) => rep(t, '        timeout-minutes: 10\n', '        timeout-minutes: 11\n', 2))],
    ['C4', 'fetch-depth 1', (f) => withFile(f, CI, (t) => rep(t, 'fetch-depth: 0', 'fetch-depth: 1', 2))],
    ['C4', 'persist-credentials true', (f) => withFile(f, NT, (t) => rep(t, 'persist-credentials: false', 'persist-credentials: true', 3))],
    ['C4', 'persist-credentials removed', (f) => withFile(f, CI, (t) => rep(t, '          persist-credentials: false\n', '', 2))],
    ['C5', 'contents: write', (f) => withFile(f, CI, (t) => rep(t, 'contents: read', 'contents: write'))],
    ['C5', 'shell sh', (f) => withFile(f, NT, (t) => rep(t, 'shell: bash', 'shell: sh'))],
    ['C5', 'defaults removed', (f) => withFile(f, CI, (t) => rep(t, 'defaults:\n  run:\n    shell: bash\n', ''))],
    ['C6', 'Node 26 cell dropped', (f) => withFile(f, CI, (t) => rep(t, "          - '26'\n", ''))],
    ['C6', 'macos cell on Node 22', (f) => withFile(f, CI, (t) => rep(t, "            node: '24'\n", "            node: '22'\n"))],
    ['C6', 'fail-fast true', (f) => withFile(f, CI, (t) => rep(t, 'fail-fast: false', 'fail-fast: true'))],
    ['C6', 'extra Node 20 cell', (f) => withFile(f, CI, (t) => rep(t, "          - '22'\n", "          - '20'\n          - '22'\n"))],
    ['C7', 'ci PIN_NODE major only', (f) => withFile(f, CI, (t) => rep(t, "PIN_NODE: '26.8.2'", "PIN_NODE: '26'"))],
    ['C7', 'nightly PIN_NODE differs', (f) => withFile(f, NT, (t) => rep(t, "PIN_NODE: '26.8.2'", "PIN_NODE: '26.8.3'"))],
    ['C7', 'PIN_NODE removed from nightly', (f) => withFile(f, NT, (t) => rep(t, "env:\n  PIN_NODE: '26.8.2'\nconcurrency:", 'concurrency:'))],
    ['C8', 'unknown npm script', (f) => withFile(f, CI, (t) => rep(t, 'while P-TREE is a GAP"', 'while P-TREE is a GAP"; npm run bogus:script'))],
    ['C8', 'MUSTFAIL_ONLY present', (f) => withFile(f, CI, (t) => rep(t, 'while P-TREE is a GAP"', 'while P-TREE is a GAP"; echo MUSTFAIL_ONLY'))],
    ['C8', 'npm test step removed', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', ''))],
    ['C9', 'continue-on-error on a non-soak step (npm test is also gating: C17)', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', '      - run: npm test\n        continue-on-error: true\n')), ['C17', 'C9']],
    ['C9', 'continue-on-error not keyed (true)', (f) => withFile(f, CI, (t) => rep(t, "${{ steps.ptree.outputs.gap == 'true' }}", 'true'))],
    ['C9', 'burn-in soak step loses its continue-on-error', (f) => withFile(f, NT, (t) => rep(t, "        continue-on-error: ${{ steps.ptree.outputs.gap == 'true' }}\n", ''))],
    ['C9', 'job-level continue-on-error', (f) => withFile(f, NT, (t) => rep(t, '  teeth:\n    runs-on: ubuntu-latest\n', '  teeth:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n'))],
    ['C9', 'ptree snippet differs between files', (f) => withFile(f, CI, (t) => rep(t, GAPLINE, GAPLINE + ' // x'))],
    ['C9', 'ptree meaning: gap never true (both files)', (f) => ({ [CI]: rep(f[CI], GAPLINE, GAPLINE.replace(';', ' && false;')), [NT]: rep(f[NT], GAPLINE, GAPLINE.replace(';', ' && false;')) })],
    ['C9', 'ptree meaning: fail-open when GAPS is missing (both files)', (f) => ({ [CI]: rep(f[CI], THROWLINE, '').replace('keys(GAPS)', 'keys(GAPS || {})'), [NT]: rep(f[NT], THROWLINE, '').replace('keys(GAPS)', 'keys(GAPS || {})') })],
    ['C9', 'ptree step id missing in ci', (f) => withFile(f, CI, (t) => rep(t, '      - id: ptree\n', '      - name: probe\n'))],
    ['C10', 'ci upload without if: always()', (f) => withFile(f, CI, (t) => rep(t, '        if: always()\n        with:\n          name: smoke\n', '        with:\n          name: smoke\n'))],
    ['C10', 'burn-in upload if-no-files-found warn', (f) => withFile(f, NT, (t) => rep(t, 'if-no-files-found: error', 'if-no-files-found: warn'))],
    ['C10', 'teeth upload if: success()', (f) => withFile(f, NT, (t) => rep(t, '        if: always()\n        with:\n          name: teeth\n', '        if: success()\n        with:\n          name: teeth\n'))],
    ['C11', 'SOAK_REQUIRE_PROVENANCE 0', (f) => withFile(f, NT, (t) => rep(t, "SOAK_REQUIRE_PROVENANCE: '1'", "SOAK_REQUIRE_PROVENANCE: '0'"))],
    ['C11', 'SOAK_LANES set', (f) => withFile(f, NT, (t) => rep(t, "          SOAK_REQUIRE_PROVENANCE: '1'\n", "          SOAK_REQUIRE_PROVENANCE: '1'\n          SOAK_LANES: GRAPH\n"))],
    ['C11', 'SOAK_KERNEL set', (f) => withFile(f, NT, (t) => rep(t, "          SOAK_REQUIRE_PROVENANCE: '1'\n", "          SOAK_REQUIRE_PROVENANCE: '1'\n          SOAK_KERNEL: x\n"))],
    ['C11', 'SOAK_SMOKE set on burn-in', (f) => withFile(f, NT, (t) => rep(t, "          SOAK_REQUIRE_PROVENANCE: '1'\n", "          SOAK_REQUIRE_PROVENANCE: '1'\n          SOAK_SMOKE: '1'\n"))],
    ['C11', 'cycles default below DEFAULT_CYCLES', (f) => withFile(f, NT, (t) => rep(t, "        default: '33'\n", `        default: '${DEFAULT_CYCLES - 1}'\n`))],
    ['C11', 'ops default 50000', (f) => withFile(f, NT, (t) => rep(t, "        default: '200000'\n", "        default: '50000'\n"))],
    ['C11', 'SOAK_OPS not from inputs.ops', (f) => withFile(f, NT, (t) => rep(t, "          SOAK_OPS: ${{ inputs.ops || '200000' }}\n        run: npm run soak\n", "          SOAK_OPS: '200000'\n        run: npm run soak\n"))],
    ['C12', 'inputs interpolated into run', (f) => withFile(f, CI, (t) => rep(t, 'while P-TREE is a GAP"', 'while P-TREE is a GAP"; echo ${{ inputs.cycles }}'))],
    ['C12', 'github.event interpolated into run', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', '      - run: echo ${{ github.event.head_commit.message }}\n      - run: npm test\n'))],
    ['C13', 'ci push branch master', (f) => withFile(f, CI, (t) => rep(t, '      - main\n', '      - master\n'))],
    ['C13', 'ci pull_request removed', (f) => withFile(f, CI, (t) => rep(t, '  pull_request:\n', ''))],
    ['C13', 'ci pull_request_target', (f) => withFile(f, CI, (t) => rep(t, '  pull_request:\n', '  pull_request:\n  pull_request_target:\n'))],
    ['C13', 'ci workflow_dispatch removed', (f) => withFile(f, CI, (t) => rep(t, '  workflow_dispatch:\n', ''))],
    ['C13', 'nightly cron changed', (f) => withFile(f, NT, (t) => rep(t, "'0 4 * * *'", "'5 4 * * *'"))],
    ['C13', 'nightly push trigger removed', (f) => withFile(f, NT, (t) => rep(t, '  push:\n    branches:\n      - 1.6.0-dev\n', ''))],
    ['C14', 'burn-in parity removed', (f) => withFile(f, NT, (t) => rep(t, '        timeout-minutes: 10\n      - run: npm run soak:parity\n      - id: ptree', '        timeout-minutes: 10\n      - id: ptree'))],
    ['C14', 'gates parity moved after the smoke step', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm run soak:parity\n', '') + '      - run: npm run soak:parity\n')],
    ['C2', 'ci smoke step deleted', (f) => withFile(f, CI, (t) => rep(t, "      - id: smoke\n        continue-on-error: ${{ steps.ptree.outputs.gap == 'true' }}\n        env:\n          SOAK_SMOKE: '1'\n        run: npm run soak\n", ''))],
    ['C2', 'ci gates smoke report step deleted', (f) => withFile(f, CI, (t) => rep(t, t.slice(t.indexOf('      - id: smoke-report\n'), t.indexOf('      - uses: actions/upload-artifact')), ''))],
    ['C13', 'ci concurrency cancel-in-progress false', (f) => withFile(f, CI, (t) => rep(t, 'cancel-in-progress: true', 'cancel-in-progress: false'))],
    ['C13', 'nightly concurrency cancel-in-progress true', (f) => withFile(f, NT, (t) => rep(t, 'cancel-in-progress: false', 'cancel-in-progress: true'))],
    ['C13', 'nightly concurrency removed', (f) => withFile(f, NT, (t) => rep(t, 'concurrency:\n  group: nightly-${{ github.ref }}\n  cancel-in-progress: false\n', ''))],
    ['C14', 'parity removed from teeth job', (f) => withFile(f, NT, (t) => rep(t, '      - run: npm run soak:parity\n      - run: |\n          mkdir -p "$RUNNER_TEMP/teeth"\n', '      - run: |\n          mkdir -p "$RUNNER_TEMP/teeth"\n'))],
    ['C14', 'parity removed from teeth-long job', (f) => withFile(f, NT, (t) => rep(t, '      - run: npm run soak:parity\n      - run: |\n          mkdir -p "$RUNNER_TEMP/teeth-long"\n', '      - run: |\n          mkdir -p "$RUNNER_TEMP/teeth-long"\n'))],
    ['C15', 'SOAK_NODE at workflow level', (f) => withFile(f, CI, (t) => rep(t, "env:\n  PIN_NODE: '26.8.2'\n", "env:\n  PIN_NODE: '26.8.2'\n  SOAK_NODE: '26.8.2'\n"))],
    ['C15', 'typo SOAK_DURATON in burn-in soak env', (f) => withFile(f, NT, (t) => rep(t, "          SOAK_REQUIRE_PROVENANCE: '1'\n", "          SOAK_REQUIRE_PROVENANCE: '1'\n          SOAK_DURATON: '1'\n"))],
    ['C15', 'lower-case soak_ops job env', (f) => withFile(f, NT, (t) => rep(t, '  teeth:\n    runs-on: ubuntu-latest\n', '  teeth:\n    runs-on: ubuntu-latest\n    env:\n      soak_ops: 1\n'))],
    ['C16', 'checkout@v4', (f) => withFile(f, CI, (t) => rep(t, 'actions/checkout@v7', 'actions/checkout@v4', 2))],
    ['C16', 'upload-artifact@v5', (f) => withFile(f, CI, (t) => rep(t, 'actions/upload-artifact@v7', 'actions/upload-artifact@v5'))],
    ['C16', 'setup-node@v4 (nightly)', (f) => withFile(f, NT, (t) => rep(t, 'actions/setup-node@v7', 'actions/setup-node@v4', 3))],
    ['C16', 'unknown action actions/cache', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', '      - uses: actions/cache@v7\n      - run: npm test\n'))],
    ['C17', 'soak:report || true (burn-in)', (f) => withFile(f, NT, (t) => rep(t, 'run: npm run soak:report -- "$SOAK_OUT"', 'run: npm run soak:report -- "$SOAK_OUT" || true'))],
    ['C17', 'teeth tee || true', (f) => withFile(f, NT, (t) => rep(t, 'tee "$RUNNER_TEMP/teeth/soak-teeth.log"', 'tee "$RUNNER_TEMP/teeth/soak-teeth.log" || true'))],
    ['C17', 'if: never on npm test', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', "      - run: npm test\n        if: github.event_name == 'never'\n"))],
    ['C17', 'if: never on soak:teeth', (f) => withFile(f, NT, (t) => rep(t, '      - run: |\n          mkdir -p "$RUNNER_TEMP/teeth"\n', "      - if: github.event_name == 'never'\n        run: |\n          mkdir -p \"$RUNNER_TEMP/teeth\"\n"))],
    ['C17', 'set +e in a gating run', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', '      - run: set +e; npm test\n'))],
    ['C17', 'set +o pipefail in teeth-long', (f) => withFile(f, NT, (t) => rep(t, '          npm run soak:teeth:long 2>&1', '          set +o pipefail; npm run soak:teeth:long 2>&1'))],
    ['C17', '|| : on torture', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm run torture:semantic\n', '      - run: "npm run torture:semantic || :"\n'))],
    ['C17', 'soak:report not always (burn-in)', (f) => withFile(f, NT, (t) => rep(t, '      - name: report\n        if: always()\n', '      - name: report\n'))],
    ['C17', 'continue-on-error on soak:parity (also trips C9: non-soak step)', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm run soak:parity\n', '      - run: npm run soak:parity\n        continue-on-error: true\n')), ['C17', 'C9']],
    ['C17', 'smoke-report accepts bare text without the soak:report: prefix', (f) => withFile(f, CI, (t) => rep(t, "'soak:report: NOT A RELEASE SOAK -- smoke:'", "'NOT A RELEASE SOAK -- smoke'"))],
    ['C17', 'smoke-report accepts any reason sharing the prefix', (f) => withFile(f, CI, (t) => rep(t, "-- smoke:'", "-- smoke'"))],
    ['C17', 'smoke-report -eq 0 -> -le 1', (f) => withFile(f, CI, (t) => rep(t, '[ "$rc" -eq 0 ]', '[ "$rc" -le 1 ]'))],
    ['C17', 'smoke-report INTEGRITY|CRASH|CONFIG clause dropped', (f) => withFile(f, CI, (t) => rep(t, "          if printf '%s' \"$out\" | grep -qE 'soak:report: (INTEGRITY|CRASH|CONFIG) --'; then exit 1; fi\n", ''))],
    ['C17', 'job-level if on ci test job', (f) => withFile(f, CI, (t) => rep(t, '    runs-on: ${{ matrix.os }}\n    timeout-minutes: 30\n', "    runs-on: ${{ matrix.os }}\n    if: github.event_name == 'never'\n    timeout-minutes: 30\n"))],
    ['C17', 'job-level if on nightly teeth job', (f) => withFile(f, NT, (t) => rep(t, '  teeth:\n    runs-on: ubuntu-latest\n', "  teeth:\n    runs-on: ubuntu-latest\n    if: github.event_name == 'never'\n"))],
    ['C15', 'workflow env NODE_OPTIONS', (f) => withFile(f, CI, (t) => rep(t, "env:\n  PIN_NODE: '26.8.2'\n", "env:\n  PIN_NODE: '26.8.2'\n  NODE_OPTIONS: '--test-skip-pattern=.'\n"))],
    ['C15', 'step env npm_config_script_shell on npm test', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', '      - env:\n          npm_config_script_shell: /usr/bin/true\n        run: npm test\n'))],
    ['C15', 'job env NODE_TEST_CONTEXT', (f) => withFile(f, CI, (t) => rep(t, '      SOAK_OUT: ${{ runner.temp }}/soak-out/smoke.jsonl\n', '      SOAK_OUT: ${{ runner.temp }}/soak-out/smoke.jsonl\n      NODE_TEST_CONTEXT: child\n'))],
    ['C13', 'push.paths block list', (f) => withFile(f, CI, (t) => rep(t, '      - 1.6.0-dev\n  pull_request:\n', "      - 1.6.0-dev\n    paths:\n      - 'docs/**'\n  pull_request:\n"))],
    ['C13', 'push.tags', (f) => withFile(f, CI, (t) => rep(t, '      - 1.6.0-dev\n  pull_request:\n', '      - 1.6.0-dev\n    tags:\n      - v1\n  pull_request:\n'))],
    ['C13', 'pull_request paths-ignore', (f) => withFile(f, CI, (t) => rep(t, '  pull_request:\n', '  pull_request:\n    paths-ignore:\n      - docs\n'))],
    ['C13', 'pull_request branches-ignore', (f) => withFile(f, CI, (t) => rep(t, '  pull_request:\n', '  pull_request:\n    branches-ignore:\n      - main\n'))],
    ['C13', 'pull_request tags', (f) => withFile(f, CI, (t) => rep(t, '  pull_request:\n', '  pull_request:\n    tags:\n      - v1\n'))],
    ['C13', 'nightly push.paths', (f) => withFile(f, NT, (t) => rep(t, '  push:\n    branches:\n      - 1.6.0-dev\n', '  push:\n    branches:\n      - 1.6.0-dev\n    paths:\n      - docs\n'))],
    ['C13', 'nightly schedule extra key', (f) => withFile(f, NT, (t) => rep(t, "    - cron: '0 4 * * *'\n", "    - cron: '0 4 * * *'\n      timezone: UTC\n"))],
    ['C13', 'nightly extra dispatch input', (f) => withFile(f, NT, (t) => rep(t, '      ops:\n', '      extra:\n        default: x\n      ops:\n'))],
    ['C18', 'job-level defaults shell bash {0} on teeth', (f) => withFile(f, NT, (t) => inJob(t, 'teeth', 'teeth-long', '    timeout-minutes: 60\n', '    timeout-minutes: 60\n    defaults:\n      run:\n        shell: bash {0}\n'))],
    ['C18', 'defaults.run.working-directory', (f) => withFile(f, CI, (t) => rep(t, 'defaults:\n  run:\n    shell: bash\n', 'defaults:\n  run:\n    shell: bash\n    working-directory: harness/ProfilerTools\n'))],
    ['C18', 'step working-directory on npm test', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', '      - working-directory: harness/ProfilerTools\n        run: npm test\n'))],
    ['C18', 'checkout ref', (f) => withFile(f, CI, (t) => rep(t, '          persist-credentials: false\n', '          persist-credentials: false\n          ref: v1.5.2\n', 2))],
    ['C18', 'job container', (f) => withFile(f, NT, (t) => inJob(t, 'teeth', 'teeth-long', '    timeout-minutes: 60\n', '    timeout-minutes: 60\n    container: node:20\n'))],
    ['C18', 'extra step writing GITHUB_ENV', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', "      - run: echo 'npm_config_script_shell=/usr/bin/true' >> \"$GITHUB_ENV\"\n      - run: npm test\n"))],
    ['C18', 'extra step appending to GITHUB_PATH', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', '      - run: echo "$PWD/evil" >> "$GITHUB_PATH"\n      - run: npm test\n'))],
    ['C18', 'setup-node matrix.nodes || 20', (f) => withFile(f, CI, (t) => rep(t, 'node-version: ${{ matrix.node }}', "node-version: ${{ matrix.nodes || '20' }}"))],
    ['C18', 'setup-node matrix.nodeX', (f) => withFile(f, CI, (t) => rep(t, 'node-version: ${{ matrix.node }}', 'node-version: ${{ matrix.nodeX }}'))],
    ['C18', 'setup-node env.PIN_NODE_X', (f) => withFile(f, CI, (t) => rep(t, 'node-version: ${{ env.PIN_NODE }}', 'node-version: ${{ env.PIN_NODE_X }}'))],
    ['C18', 'second setup-node with 20', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', "      - uses: actions/setup-node@v7\n        with:\n          node-version: '20'\n      - run: npm test\n"))],
    ['C18', "setup-node 'lts/*' on teeth", (f) => withFile(f, NT, (t) => inJob(t, 'teeth', 'teeth-long', 'node-version: ${{ env.PIN_NODE }}', "node-version: 'lts/*'"))],
    ['C18', "setup-node '22' on burn-in", (f) => withFile(f, NT, (t) => inJob(t, 'burn-in', 'teeth', 'node-version: ${{ env.PIN_NODE }}', "node-version: '22'"))],
    ['C18', 'upload retention-days 0', (f) => withFile(f, CI, (t) => rep(t, '          name: smoke\n', '          name: smoke\n          retention-days: 0\n'))],
    ['C18', 'upload with unknown key', (f) => withFile(f, CI, (t) => rep(t, '          name: smoke\n', '          name: smoke\n          overwrite: true\n'))],
    ['C18', 'extra top-level key', (f) => withFile(f, CI, (t) => rep(t, 'name: ci\n', 'name: ci\nrun-name: x\n'))],
    ['C18', 'runs-on self-hosted', (f) => withFile(f, NT, (t) => inJob(t, 'teeth', 'teeth-long', '    runs-on: ubuntu-latest\n', '    runs-on: self-hosted\n'))],
    ['C18', 'job needs', (f) => withFile(f, NT, (t) => inJob(t, 'teeth', 'teeth-long', '    timeout-minutes: 60\n', '    timeout-minutes: 60\n    needs: burn-in\n'))],
    ['C18', 'warning step with the wrong if', (f) => withFile(f, CI, (t) => rep(t, "        if: steps.smoke.outcome == 'failure'\n", '        if: always()\n'))],
    ['C18', 'warning step with an extra command', (f) => withFile(f, CI, (t) => rep(t, 'while P-TREE is a GAP"', 'while P-TREE is a GAP"; exit 0'))],
    ['C18', 'second setup-node cache key other than npm', (f) => withFile(f, CI, (t) => rep(t, 'node-version: ${{ env.PIN_NODE }}\n', 'node-version: ${{ env.PIN_NODE }}\n          cache: yarn\n'))],
    ['C18', 'extra uncategorised step in teeth', (f) => withFile(f, NT, (t) => inJob(t, 'teeth', 'teeth-long', '      - run: npm run soak:parity\n', '      - run: npm run soak:parity\n      - run: echo hi\n'))],
    ['C18', 'warning text with $(...)', (f) => withFile(f, CI, (t) => rep(t, 'while P-TREE is a GAP"', 'while $(id) is a GAP"'))],
    ['C18', 'warning text with backticks', (f) => withFile(f, CI, (t) => rep(t, 'while P-TREE is a GAP"', 'while `id` is a GAP"'))],
    ['C18', 'warning text with ${!v}', (f) => withFile(f, CI, (t) => rep(t, 'while P-TREE is a GAP"', 'while ${!v} is a GAP"'))],
    ['C18', 'warning step after the smoke-report step', (f) => withFile(f, CI, (t) => { const w = t.slice(t.indexOf('      - name: warn\n'), t.indexOf('      - id: smoke-report\n')); return rep(rep(t, w, ''), '      - uses: actions/upload-artifact', w + '      - uses: actions/upload-artifact'); })],
    ['C18', 'if: false on the test job setup-node', (f) => withFile(f, CI, (t) => rep(t, '      - uses: actions/setup-node@v7\n        with:\n          node-version: ${{ matrix.node }}\n', '      - uses: actions/setup-node@v7\n        if: false\n        with:\n          node-version: ${{ matrix.node }}\n'))],
    ['C18', 'if: always() on checkout', (f) => withFile(f, CI, (t) => rep(t, '      - uses: actions/checkout@v7\n', '      - uses: actions/checkout@v7\n        if: always()\n', 2))],
    ['C18', 'burn-in report points at a committed golden stream', (f) => withFile(f, NT, (t) => rep(t, '      - name: report\n        if: always()\n', '      - name: report\n        if: always()\n        env:\n          SOAK_OUT: bench/soak/calibration/golden/good.jsonl\n'))],
    ['C18', 'smoke soak / smoke-report SOAK_OUT mismatch', (f) => withFile(f, CI, (t) => rep(t, '      - id: smoke-report\n        if: always()\n', '      - id: smoke-report\n        if: always()\n        env:\n          SOAK_OUT: ${{ runner.temp }}/soak-out/other.jsonl\n'))],
    ['C3', 'step timeout-minutes 0', (f) => withFile(f, CI, (t) => rep(t, '        timeout-minutes: 10\n', '        timeout-minutes: 0\n', 2))],
    ['C17', 'smoke-report ends with exit 0', (f) => withFile(f, CI, (t) => rep(t, '          exit 1\n', '          exit 0\n'))],
    ['C17', 'test:gate || echo flaky', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm run test:gate\n', '      - run: npm run test:gate || echo flaky\n'))],
    ['C17', 'test:gate || exit 0', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm run test:gate\n', '      - run: npm run test:gate || exit 0\n'))],
    ['C17', 'test:gate wrapped in if ! ...; then echo red; fi', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm run test:gate\n', '      - run: if ! npm run test:gate; then echo red; fi\n'))],
    ['C17', 'shell: bash {0} on soak:teeth', (f) => withFile(f, NT, (t) => rep(t, '      - run: |\n          mkdir -p "$RUNNER_TEMP/teeth"\n', '      - shell: bash {0}\n        run: |\n          mkdir -p "$RUNNER_TEMP/teeth"\n'))],
    ['C17', 'run: echo npm test', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', '      - run: echo npm test\n'))],
    ['C17', 'npm test with --test-skip-pattern', (f) => withFile(f, CI, (t) => rep(t, '      - run: npm test\n', '      - run: npm test -- --test-skip-pattern=.\n'))],
    ['C17', 'soak step with an extra argument', (f) => withFile(f, NT, (t) => rep(t, '        run: npm run soak\n', '        run: npm run soak -- --smoke\n', 1))],
    ['C11', 'volume: >= floor replaced by >= 0', (f) => withFile(f, NT, (t) => rep(t, 'Number(c) < DEFAULT_CYCLES', 'Number(c) < 0'))],
    ['C2', 'ci smoke-report id missing', (f) => withFile(f, CI, (t) => rep(t, '      - id: smoke-report\n', '      - name: smoke report\n')), ['C17', 'C2']],
    ['C11', 'volume: regex accepts leading zeros / empty', (f) => withFile(f, NT, (t) => rep(t, '/^(0|[1-9][0-9]*)$/', '/^[0-9]*$/'))],
    ['C11', 'volume: import failure swallowed by .catch', (f) => withFile(f, NT, (t) => rep(t, "await import('./bench/soak/config.mjs');", "await import('./bench/soak/config.mjs').catch(() => ({ DEFAULT_CYCLES: 0, DEFAULT_OPS: 0 }));"))],
    ['C11', 'volume: ops floor dropped', (f) => withFile(f, NT, (t) => rep(t, ' || Number(o) < DEFAULT_OPS', ''))],
    ['C11', "fallbacks || '3' (both occurrences)", (f) => withFile(f, NT, (t) => rep(t, "inputs.cycles || '33'", "inputs.cycles || '3'", 2))],
    ['C11', "ops fallback changed in guard only", (f) => withFile(f, NT, (t) => rep(t, "inputs.ops || '200000'", "inputs.ops || '2000'", 2))],
    ['C11', 'volume guard missing', (f) => withFile(f, NT, (t) => rep(t, t.slice(t.indexOf('      - id: volume\n'), t.indexOf('      - id: soak\n')), ''))],
    ['C11', 'volume guard after the soak step', (f) => withFile(f, NT, (t) => { const g = t.slice(t.indexOf('      - id: volume\n'), t.indexOf('      - id: soak\n')); return rep(rep(t, g, ''), '      - name: report\n', g + '      - name: report\n'); })],
];

for (const [fam, label, mutate, fams] of CASES) {
    test(fam + ' must-fail: ' + label, () => {
        const clean = fixture();
        assert.deepEqual(workflowProblems(clean), [], 'fixture must be clean first');
        const p = workflowProblems(mutate(clean));
        assert.ok(p.some((x) => x.startsWith(fam + ':')), 'expected a ' + fam + ' problem, got: ' + JSON.stringify(p));
        // C18 (closed-world schema) may echo any shape-changing mutation; every other family must be exact.
        const want = fams || [fam];
        const got = want.includes('C18') ? families(p) : families(p).filter((x) => x !== 'C18');
        assert.deepEqual(got, want, 'only ' + fam + ' may fire: ' + JSON.stringify(p));
    });
}

test('coverage floor: every check family C1-C17 has at least one must-fail case', () => {
    const seen = new Set(CASES.map((c) => c[0]));
    for (let i = 1; i <= 17; i++) assert.ok(seen.has('C' + i), 'no must-fail case for C' + i);
});

test('parse failure in a workflow is reported, not thrown (fail closed)', () => {
    const p = workflowProblems(withFile(fixture(), CI, (t) => rep(t, '  pull_request:\n', '  pull_request: {}\n')));
    assert.ok(p.some((x) => x.startsWith('PARSE: ci.yml')), JSON.stringify(p));
});

test('C8: a changed package.json script text is a problem (pinned literals)', () => {
    const p = workflowProblems(fixture(), { scripts: { ...PKG.scripts, test: 'node --test --test-skip-pattern=. test/*.test.mjs' } });
    assert.deepEqual(families(p), ['C8']);
    assert.match(p[0], /script test is/);
});

test('C15: a repo .npmrc is a problem', () => {
    assert.deepEqual(families(workflowProblems(fixture(), { npmrc: true })), ['C15']);
});

test('the real package.json scripts match the pins and no .npmrc exists', () => {
    for (const [k, v] of Object.entries(SCRIPT_PINS)) assert.equal(PKG.scripts[k], v, k);
    assert.equal(existsSync(join(ROOT, '.npmrc')), false);
});

test('C19: the pinned sha256 of the real workflow files; a 1-byte change is a problem (fixture pins)', () => {
    const fx = fixture();
    const pins = { 'ci.yml': sha256(fx['ci.yml']), 'soak-nightly.yml': sha256(fx['soak-nightly.yml']) };
    assert.deepEqual(workflowProblems(fx, { pins }), []);
    const p = workflowProblems(withFile(fx, CI, (t) => t.replace('name: ci\n', 'name: cj\n')), { pins });
    assert.deepEqual(families(p), ['C19']);
});

test('C19: a 1-byte change in a copy of each REAL workflow file is a problem', () => {
    const real = loadReal();
    for (const n of EXPECTED_FILES) {
        assert.ok(n in real, n + ' missing');
        const p = workflowProblems({ ...real, [n]: real[n] + ' ' }, { pins: WORKFLOW_PINS });
        assert.ok(p.some((x) => x.startsWith('C19: ' + n)), JSON.stringify(p));
    }
});
