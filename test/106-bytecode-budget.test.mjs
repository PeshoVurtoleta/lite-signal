// test/106-bytecode-budget.test.mjs -- bench/bytecode-budget.sh (vendored from LiteUtils: the build of
// src/bytecode-budget.sh + lib/*.sh, byte-identical to LiteUtils' generated root copy).
// Three groups: (a) the script's own --self-test (canned text + a fake node; no V8 bytecode spawn);
// (b) must-fail script mutants (each patched copy must turn the self-test red); (c) real report / gate runs of
// THIS node on a tiny driver written to a temp dir. The (c) rows pin properties that hold on every node major
// (count, the gate boundary at the measured length, the version refusal); the exact lengths are pinned only on
// v26.8.2, where they equal the LiteUtils fixture census (add 6, dup 6,19). DETERMINISTIC tier.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'bytecode-budget.sh');
const CHECKS = 49;   // every ok line of --self-test without --fixtures; a new check moves this literal
const SPAWN = { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' };

const skip = process.platform === 'win32' ? 'bash script: POSIX hosts only' : false;

function run(path, args) { return spawnSync('bash', [path, ...args], SPAWN); }
// Async twin of run(): detached child, whole process group SIGKILLed at the per-spawn cap (no orphans).
function runAsync(path, args, tmp, capMs = SPAWN.timeout) {
    return new Promise((resolve) => {
        const env = tmp ? { ...process.env, TMPDIR: tmp } : process.env;
        const c = spawn('bash', [path, ...args], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', done = false;
        c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
        c.stdout.on('data', (d) => { stdout += d; });
        c.stderr.on('data', (d) => { stderr += d; });
        const fin = (status, signal) => {
            if (done) return;
            done = true; clearTimeout(t); resolve({ status, signal, stdout, stderr });
        };
        const t = setTimeout(() => {
            try { process.kill(-c.pid, 'SIGKILL'); } catch { /* group already gone */ }
            fin(null, 'SIGKILL');
        }, capMs);
        c.on('error', () => fin(null, 'error'));
        c.on('close', (code, sig) => fin(code, sig));
    });
}
function okCount(out) { return (out.match(/^ok {3}/gm) || []).length; }

// A copy of the script in a temp dir, with ONE exact edit (must match exactly once, else the row is invalid).
function variant(dir, name, from, to) {
    const src = readFileSync(SCRIPT, 'utf8');
    const n = src.split(from).length - 1;
    assert.equal(n, 1, `mutant ${name}: anchor must match exactly once, matched ${n}`);
    const p = join(dir, `${name}.sh`);
    writeFileSync(p, src.replace(from, () => to));
    chmodSync(p, 0o755);
    return p;
}

// ---- (0) vendored-copy pin: bench/bytecode-budget.sh = LiteUtils c21b4b0; bump on every re-vendor ----
const SCRIPT_SHA256 = 'c3dc777266d063e643270fbfe8abe20fadecd4d61ca3d5fbd94442541f501166';   // prefix c3dc7772
function pinOk(buf) { return createHash('sha256').update(buf).digest('hex') === SCRIPT_SHA256; }
test('bytecode-budget.sh sha256 pin (LiteUtils c21b4b0; bump on every re-vendor)', () => {
    assert.ok(pinOk(readFileSync(SCRIPT)), 'bench/bytecode-budget.sh differs from the pinned LiteUtils c21b4b0 copy');
});
test('bytecode-budget.sh sha256 pin has teeth: a one-byte change to a copy fails the compare', () => {
    const b = Buffer.from(readFileSync(SCRIPT));
    b[b.length >> 1] ^= 1;
    assert.equal(pinOk(b), false);
    assert.equal(pinOk(Buffer.concat([readFileSync(SCRIPT), Buffer.from('\n')])), false);
});

test('runAsync cap: a hung script and its child are SIGKILLed as a group (no orphan)', { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r1-cap-'));
    let gpid = 0;
    try {
        const pf = join(dir, 'gpid.txt');
        const sh = join(dir, 'hang.sh');
        writeFileSync(sh, `"${process.execPath}" -e 'for(;;){}' & echo $! >"${pf}"\nwait\n`);
        chmodSync(sh, 0o755);
        const t0 = Date.now();
        const r = await runAsync(sh, [], dir, 2000);   // resolves { status, signal, stdout, stderr }
        assert.deepEqual([r.status, r.signal], [null, 'SIGKILL']);
        assert.ok(Date.now() - t0 < 60000, 'cap 2000 honoured: ' + (Date.now() - t0) + ' ms');
        gpid = Number(readFileSync(pf, 'utf8').trim());
        assert.ok(Number.isSafeInteger(gpid) && gpid > 0, 'grandchild pid: ' + gpid);
        let alive = true;
        for (let i = 0; i < 50 && alive; i++) {
            try { process.kill(gpid, 0); await new Promise((res) => setTimeout(res, 100)); }
            catch { alive = false; }   // ESRCH: dead
        }
        assert.equal(alive, false, 'grandchild ' + gpid + ' survived the runAsync cap');
    } finally {
        if (gpid > 0) { try { process.kill(gpid, 'SIGKILL'); } catch { /* already dead */ } }
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---- (a) self-test ----
test('bytecode-budget --self-test: every check passes', { skip }, () => {
    const r = run(SCRIPT, ['--self-test']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^self-test: all checks passed$/m);
    assert.doesNotMatch(r.stdout, /^FAIL /m);
    assert.equal(okCount(r.stdout), CHECKS);
});

test('bytecode-budget --self-test: an unmodified copy outside the repo passes (baseline for the mutants)', { skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-base-'));
    try {
        const r = run(variant(dir, 'baseline', '#!/usr/bin/env bash\n', '#!/usr/bin/env bash\n'), ['--self-test']);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(okCount(r.stdout), CHECKS);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- (b) must-fail mutants of the self-test ----
const MUTANTS = [
    ['gt-to-ge', '(( l > max ))', '(( l >= max ))', 'gate: a length equal to the max is WITHIN'],
    ['version-check-off', 'if [[ -n "$WANT_VER" && "$GOT_VER" != "$WANT_VER" ]]; then', 'if false; then',
        'node version mismatch -> exit 2 before any probe'],
    ['null-control-off', 'if [[ "$line" != "$first" ]]; then JWHY="null control', 'if false; then JWHY="null control',
        'null control: run 2 with a changed length -> NO-VERDICT'],
    ['worst-order-swapped', 'for a in NO-VERDICT OVER;', 'for a in OVER NO-VERDICT;', 'worst: NO-VERDICT > OVER > WITHIN'],
    ['exact-name-to-prefix', 'want = (s == fn); n += want', 'want = (index(s, fn) == 1); n += want', 'count: exact name'],
    ['bad-header-ignored', 'bad = n - good;', 'bad = 0;', "not followed by 'Bytecode length: N' is counted bad"],
    ['cap-off', ' && length($3) <= 9 {', ' {', 'a length has 1..9 digits'],
    ['fn-regex-allows-dot', "FN_RE='^[A-Za-z_$][A-Za-z0-9_$]*(", "FN_RE='^[A-Za-z_$][A-Za-z0-9_$.]*(", 'fn names: '],
];
function mutantOf(name) { return MUTANTS.find((m) => m[0] === name); }
// Rows run concurrently (each ~5 s of bash; serial cost grows with host load). TMPDIR is the row's own dir.
describe('bytecode-budget --self-test mutants', { concurrency: true }, () => {
for (const [name, from, to, failing] of MUTANTS) {
    it(`bytecode-budget --self-test MUST FAIL on mutant ${name}`, { skip }, async () => {
        const dir = mkdtempSync(join(tmpdir(), `bb-${name}-`));
        try {
            const r = await runAsync(variant(dir, name, from, to), ['--self-test'], dir);
            assert.equal(r.status, 1, `mutant ${name} survived: ${r.stdout}${r.stderr}`);
            assert.match(r.stdout, /^self-test: \d+ check\(s\) FAILED$/m);
            assert.ok(r.stdout.split('\n').some((l) => l.startsWith('FAIL ') && l.includes(failing)),
                `mutant ${name}: expected a FAIL line naming "${failing}"\n${r.stdout}`);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
}
});

// ---- (c) real runs of this node on a tiny driver ----
// bbAdd: one function; bbTwin: two distinct functions of one name (both gated); bbLazy: defined, never called.
const DRIVER_SRC = [
    'function bbAdd(a, b) { return a + b; }',
    'const bbTwinA = (function () { function bbTwin(x) { return x + 1; } return bbTwin; })();',
    'const bbTwinB = (function () { function bbTwin(x) { let y = x; y = y * 2; y = y + 3; return y - x; } return bbTwin; })();',
    'function bbLazy(x) { return x + 42; }',
    'let acc = 0;',
    'for (let r = 0; r < 3; r++) acc += bbAdd(r, 1) + bbTwinA(r) + bbTwinB(r);',
    'if (acc === -1) console.log(bbLazy(acc));',
    '',
].join('\n');

function withDriver(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'bb-real-'));
    try {
        const drv = join(dir, 'driver.mjs');
        writeFileSync(drv, DRIVER_SRC);
        return fn(dir, drv);
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
function lens(out, fn) {
    const m = out.match(new RegExp('^  ' + fn + ': (\\d+) match\\(es\\): ([0-9,]+)$', 'm'));
    assert.ok(m, `no match line for ${fn}\n${out}`);
    return { n: Number(m[1]), lens: m[2].split(',').map(Number) };
}
function report(script, drv) {
    return run(script, ['--node', process.execPath, '--fn', 'bbAdd,bbTwin', drv]);
}
function gate(script, drv, max, ver = process.version) {
    return run(script, ['--node', process.execPath, '--max', max, '--node-version', ver, drv]);
}

test('bytecode-budget real report: bbAdd 1 match, bbTwin 2 distinct matches, both REPORTED (exit 0)', { skip }, () => {
    withDriver((dir, drv) => {
        const r = report(SCRIPT, drv);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /^VERDICT REPORTED$/m);
        assert.match(r.stdout, /^  bbAdd: REPORTED -- 1 match\(es\), not gated$/m);
        assert.match(r.stdout, /^  bbTwin: REPORTED -- 2 match\(es\), not gated$/m);
        const a = lens(r.stdout, 'bbAdd'), t = lens(r.stdout, 'bbTwin');
        assert.equal(a.n, 1); assert.equal(a.lens.length, 1);
        assert.equal(t.n, 2); assert.equal(t.lens.length, 2);
        assert.ok(t.lens[0] < t.lens[1], `bbTwin lengths in compile order, the short body first: ${t.lens}`);
        assert.ok(a.lens[0] > 0);
    });
});

test('bytecode-budget real report on node v26.8.2: exact lengths bbAdd 6, bbTwin 6,19 (LiteUtils fixture census)',
    { skip: skip || (process.version !== 'v26.8.2' ? 'lengths pinned for node v26.8.2 only, this is ' + process.version : false) }, () => {
        withDriver((dir, drv) => {
            const r = report(SCRIPT, drv);
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.deepEqual(lens(r.stdout, 'bbAdd').lens, [6]);
            assert.deepEqual(lens(r.stdout, 'bbTwin').lens, [6, 19]);
        });
    });

test('bytecode-budget real gate: max = the measured length is WITHIN (exit 0), max - 1 is OVER (exit 1)', { skip }, () => {
    withDriver((dir, drv) => {
        const r0 = report(SCRIPT, drv);
        assert.equal(r0.status, 0, r0.stdout + r0.stderr);
        const L = lens(r0.stdout, 'bbAdd').lens[0], T = Math.max(...lens(r0.stdout, 'bbTwin').lens);
        const w = gate(SCRIPT, drv, `bbAdd=${L},bbTwin=${T}`);
        assert.equal(w.status, 0, w.stdout + w.stderr);
        assert.match(w.stdout, /^VERDICT WITHIN$/m);
        assert.ok(w.stdout.includes(`  bbAdd: WITHIN -- every length <= max ${L}\n`), w.stdout);
        assert.ok(w.stdout.includes(`  bbTwin: WITHIN -- every length <= max ${T}\n`), w.stdout);
        const o = gate(SCRIPT, drv, `bbAdd=${L},bbTwin=${T - 1}`);
        assert.equal(o.status, 1, o.stdout + o.stderr);
        assert.match(o.stdout, /^VERDICT OVER$/m);
        assert.ok(o.stdout.includes(`  bbTwin: OVER -- length(s) ${T} > max ${T - 1}\n`), o.stdout);
    });
});

test('bytecode-budget real gate: a node-version mismatch and a never-compiled fn are NO-VERDICT (exit 2)', { skip }, () => {
    withDriver((dir, drv) => {
        const v = gate(SCRIPT, drv, 'bbAdd=999', 'v0.0.0');
        assert.equal(v.status, 2, v.stdout + v.stderr);
        // <bin> is the script's own absolute resolution of --node, so only its shape is pinned
        assert.ok(v.stdout.split('\n').some((l) => /^  bbAdd: NO-VERDICT -- node version mismatch: \/\S+ --version is /.test(l)
            && l.endsWith(` --version is ${process.version}, the maxima are for v0.0.0`)), v.stdout);
        assert.doesNotMatch(v.stdout, /match\(es\)/);   // refused before any probe
        const z = gate(SCRIPT, drv, 'bbLazy=999');
        assert.equal(z.status, 2, z.stdout + z.stderr);
        assert.match(z.stdout, /^  bbLazy: NO-VERDICT -- no function named 'bbLazy' in run 1 /m);
    });
});

// The real gate rows have teeth: a script mutant flips each of their verdicts.
test('bytecode-budget real gate MUST FAIL on mutant gt-to-ge (max = measured length reads OVER, exit 1)', { skip }, () => {
    withDriver((dir, drv) => {
        const r0 = report(SCRIPT, drv);
        assert.equal(r0.status, 0, r0.stdout + r0.stderr);
        const L = lens(r0.stdout, 'bbAdd').lens[0];
        const r = gate(variant(dir, 'gt-to-ge', mutantOf('gt-to-ge')[1], mutantOf('gt-to-ge')[2]), drv, `bbAdd=${L}`);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /^VERDICT OVER$/m);
    });
});

test('bytecode-budget real gate MUST FAIL on mutant version-check-off (v0.0.0 maxima gate instead of NO-VERDICT)', { skip }, () => {
    withDriver((dir, drv) => {
        const m = mutantOf('version-check-off');
        const p = variant(dir, m[0], m[1], m[2]);
        const r = gate(p, drv, 'bbAdd=999', 'v0.0.0');
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /^VERDICT WITHIN$/m);
    });
});
