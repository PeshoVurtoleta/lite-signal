// test/64-torture-mustfail.test.mjs -- burst 63 (PLAN-0w C1): must-fail control for test/torture.mjs.
// The torture gate is only a gate if a known-bad engine turns it red. This test copies the engine under test
// (LITE_SIGNAL_KERNEL, default ../Signal.js -- the WORKING-TREE engine, never git HEAD) into a temp dir together with
// Watch.js, package.json, test/torture.mjs, test/torture-judge.mjs (the slope verdict torture.mjs imports, b78)
// and a node_modules symlink, applies one text mutant, and runs `node --expose-gc <tmp>/test/torture.mjs` in a
// child process (the torture spawns its own --nest-lane child).
// Lanes (recipe: .handoff/b61-evidence/qa/mkmut.mjs; b61 signatures in scratch-{slow,lslow,val-new}.log):
//   live  -- unmutated: exit 0, GATE line ends `| ok`, every drain full, retention 0 (the control).
//   slow  -- every 1000th disposal the node is not pushed to the free list -> `free=` nodes short (b61: 811/1021n).
//   lslow -- every 1000th disposal the sub link is not pushed to the free list -> links short (b61: 4032/4095l).
//   val   -- disposal stops clearing node.value -> `retention=` alive >= 1 (b61: 1/966).
//   aset  -- read.set retains one { n } per 20 calls -> GATE `| alloc=` > 0 + a `set alloc fail attempt` line
//            (the phase-2b retention-slope lane's must-fail; since b78 Dhi is the 2nd-smallest odd batch, judgeSlope
//            in test/torture-judge.mjs). REPORTED (b122 census, PLAN-F7-A A9): Dlo 32,000 / Dhi 160,000 B at N=20.
//   aun   -- untrack retains one { n } per 20 calls -> `| alloc=` > 0 + an `untrack alloc fail attempt` line.
//            History: b72 ran 1 per 1000 calls (Dlo 640 / Dhi 3200; quiet teeth down to 1 per 1e5); the b122 census
//            saw a false pass at 1 per 1000 under load (max live spike 28,472 B), so the rate is 1 per 20 since b123.
//   tset  -- TB(40000) at the aset anchor: a transient 320 KB array in new_large_object_space every 40,000 set
//            calls (8.1 B/op, nothing retained) -> `  whole nest:` (mean >= 2 or minor >= 1) + `  nest lane:` (b123).
//   tcell -- TB(8000) (1.70 B/op, new_space) at the aun anchor (watch fires via untrack), the scheduler dispatch in
//            flushEffects (qs) and fireConnect / fireDisconnect past their no-registration return (mreg) ->
//            `  whole watch:` / `  whole qs:` / `  whole mreg:` (mean >= 0.4 or minor >= 1) + the legacy
//            `  watch lane:` / `  qs:` / `  mreg:` lines, and no nest cell (b123).
// The pure judge vectors (judgeWhole / classifyGcKind / countSpan of test/torture-judge.mjs) run first, no child.
// Each mutant must exit 1 AND print a GATE line ending `| FAIL` AND show its own signature (a crash also exits 1,
// so the exit code alone proves nothing). A child that prints no GATE line fails every lane (fail closed).
// A mutant whose anchor text does not occur EXACTLY once in the engine fails the test: re-anchor it, never skip it.
// M-OFF (drop the off() lifecycle delete) is EXCLUDED by design: since burst 62 disposal itself drops the
// lifecycle entry (test/62), so the torture cannot observe a missing off() delete. test/62 A9 covers off().
// DETERMINISTIC tier: verdicts are counts, not timings (maintainer ruling R2, b63). No --expose-gc needed here;
// the children always get it. Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js;
// Watch.js is taken from beside the kernel when present, else from the package root.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeWhole, classifyGcKind, countSpan, WHOLE_WINDOWS, WHOLE_FORCED, WHOLE_STALE_TOL } from './torture-judge.mjs';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? fileURLToPath(new URL('../Signal.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TORTURE = fileURLToPath(new URL('./torture.mjs', import.meta.url));
const JUDGE = fileURLToPath(new URL('./torture-judge.mjs', import.meta.url));
const WATCH = existsSync(join(dirname(KPATH), 'Watch.js')) ? join(dirname(KPATH), 'Watch.js') : join(ROOT, 'Watch.js');
const CHILD_TIMEOUT_MS = 60000;
const sha8 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8);

// ---- mutants (begin) -- .handoff/b122-evidence/load-witness.mjs evaluates this block verbatim (keep it self-contained).
// The alloc mutants' retainer: a module-free counter on globalThis, one { n } kept per 20 calls (b123; was 1000).
const LEAK = 'globalThis.__t64N = (globalThis.__t64N | 0) + 1; if (globalThis.__t64N % 20 === 0) ' +
    '(globalThis.__t64 || (globalThis.__t64 = [])).push({ n: globalThis.__t64N });\n';
// The transient mutants' burst: one fresh n-element array every 40,000 calls, the previous one dropped (b123).
// 8 B per element: TB(8000) lands in new_space, TB(40000) in new_large_object_space (b122 A-T0.md P-lo).
const TB = (n) => 'globalThis.__t64c=(globalThis.__t64c|0)+1; if (globalThis.__t64c % 40000 === 0) ' +
    'globalThis.__t64s = new Array(' + n + ').fill(0);\n';
const A_SET = '            markDownstream(node);\n            if (batchDepth === 0) flushEffects();\n        };\n' +
    '        read.update = sharedUpdate;';
const A_UN = '    function untrack(fn) {\n        const po = currentObserver, pg = po !== null ? po.gen : 0;\n' +
    '        currentObserver = null;\n';
const A_SCHED = '                                scheduler(node.schedulerThunk);  // reuse cached thunk\n';
const A_CONN = '        const e = lifecycleMap.get(source);\n        if (e === undefined) return false;\n';
const A_DISC = '        if (e === undefined) return;\n        const po = currentObserver, pg = po !== null ? po.gen : 0;\n' +
    '        const g = node.gen;\n';
// kind -> list of [anchor, replacement] pairs; every anchor must occur exactly once in the kernel.
// slow / lslow / val verbatim from the b61 qa recipe.
const MUTANTS = {
    slow: [['            pinnedHead = node;\n        } else {\n            node.nextFree = freeNodeHead;',
        '            pinnedHead = node;\n        } else if ((statTotalDisposals % 1000) !== 999) {\n' +
            '            node.nextFree = freeNodeHead;']],
    lslow: [['            sLink.nextFree = freeLinkHead;\n            freeLinkHead = sLink;\n',
        '            if ((statTotalDisposals % 1000) !== 999) { sLink.nextFree = freeLinkHead;\n' +
            '            freeLinkHead = sLink; }\n']],
    val: [['        node.schedulerThunk = undefined;  // drop closure; recycle rebuilds it\n        node.value = undefined;\n',
        '        node.schedulerThunk = undefined;  // drop closure; recycle rebuilds it\n']],
    // b72 recipe (.handoff/b72-evidence/t64/teeth.mjs); rate 1 per 20 calls since b123.
    aset: [[A_SET, '            ' + LEAK + A_SET]],
    aun: [[A_UN, A_UN + '        ' + LEAK]],
    // b123: transient bursts, nothing retained past the next burst.
    tset: [[A_SET, '            ' + TB(40000) + A_SET]],
    tcell: [[A_UN, A_UN + '        ' + TB(8000)],
        [A_SCHED, '                                ' + TB(8000) + A_SCHED],
        [A_CONN, A_CONN + '        ' + TB(8000)],
        [A_DISC, A_DISC + '        ' + TB(8000)]],
};
// ---- mutants (end)

// Apply a mutant's pairs in order; each anchor must occur exactly once (else the row fails, never skips).
function mutate(src, kind) {
    const pairs = MUTANTS[kind];
    assert.ok(Array.isArray(pairs) && pairs.length > 0, 'unknown mutant ' + kind);
    for (const [a, b] of pairs) {
        const n = src.split(a).length - 1;
        assert.equal(n, 1, 'mutant ' + kind + ': anchor ' + JSON.stringify(a.slice(0, 60)) + ' occurs ' + n + 'x in ' +
            KPATH + ' (must be exactly 1) -- re-anchor the mutant in test/64, never skip it');
        src = src.split(a).join(b);  // literal: no $-patterns in b
    }
    return src;
}

test('kernel under test', (t) => {
    t.diagnostic('kernel ' + KPATH + ' sha256/8 ' + sha8(KPATH));
    t.diagnostic('watch ' + WATCH + ' sha256/8 ' + sha8(WATCH));
    t.diagnostic('torture ' + TORTURE + ' sha256/8 ' + sha8(TORTURE));
    t.diagnostic('judge ' + JUDGE + ' sha256/8 ' + sha8(JUDGE));
    assert.ok(existsSync(join(ROOT, 'node_modules')), 'package node_modules missing (npm install)');
});

// Build the scratch package, mutate, run the torture once. Never throws for a child failure: returns the facts.
function runLane(kind) {
    const dir = mkdtempSync(join(tmpdir(), 'lite-signal-t64-' + kind + '-'));
    try {
        mkdirSync(join(dir, 'test'));
        let src = readFileSync(KPATH, 'utf8');
        if (kind !== 'live') src = mutate(src, kind);
        writeFileSync(join(dir, 'Signal.js'), src);
        copyFileSync(WATCH, join(dir, 'Watch.js'));
        copyFileSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
        copyFileSync(TORTURE, join(dir, 'test', 'torture.mjs'));
        copyFileSync(JUDGE, join(dir, 'test', 'torture-judge.mjs'));   // torture.mjs imports it (b78)
        symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const r = spawnSync(process.execPath, ['--expose-gc', join(dir, 'test', 'torture.mjs')],
            { cwd: dir, env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
        const out = r.stdout ?? '';
        const gate = out.split('\n').find((l) => l.startsWith('GATE ')) ?? null;
        return { status: r.status, signal: r.signal, error: r.error, gate, stdout: out, stderr: r.stderr ?? '' };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// Parse the signature fields off the GATE line; null when a field is absent (caller fails closed).
// alloc = the phase-2b field (the first `| alloc=`); 'unmeasured' parses as NaN (never 0, never > 0).
function sig(gate) {
    const al = /\| alloc=([0-9.e+-]+|unmeasured) B\/op/.exec(gate);
    const ret = /\bretention=(\d+)\/(\d+)\b/.exec(gate);
    const fr = /\bfree=(\d+)\/(\d+)n,(?:(\d+)\/(\d+)l|unmeasured)/.exec(gate);
    return {
        alloc: al ? (al[1] === 'unmeasured' ? NaN : +al[1]) : null,
        alive: ret ? +ret[1] : null, refs: ret ? +ret[2] : null,
        nDrained: fr ? +fr[1] : null, nTotal: fr ? +fr[2] : null,
        lDrained: fr && fr[3] !== undefined ? +fr[3] : null, lTotal: fr && fr[4] !== undefined ? +fr[4] : null,
    };
}

function describeRun(kind, r) {
    return kind + ': status=' + r.status + ' signal=' + r.signal + (r.error ? ' error=' + r.error.message : '') +
        '\n  gate=' + r.gate + '\n  stderr(tail)=' + r.stderr.slice(-1500);
}

// Every lane needs the child to have produced a GATE line; a crash / missing --expose-gc / bad path is red here.
function assertGate(kind, r) {
    assert.ok(r.gate !== null, 'no GATE line from the torture child (crashed or never reached the gate) -- ' +
        describeRun(kind, r));
}

let liveSig = null;
function liveTotals() {
    assert.ok(liveSig !== null, 'live lane did not produce totals (it must run and pass first)');
    return liveSig;
}

// ---- pure judge vectors (b123 T5, PLAN-F7-A ASSERTION 5 + FILLER 16 window edges): no child process ----
const Z = () => [0, 0, 0, 0, 0, 0, 0, 0, 0];
const S0 = () => ({ minor: 0, major: 0, unknown: 0, ignored: 0 });
const C0 = (o = {}) => ({ cell: S0(), base: S0(), forcedSeen: WHOLE_FORCED, ...o });
const at = (a, i, v) => { a[i] = v; return a; };
const all = (v) => Array(9).fill(v);
const jw = (per, base = Z(), counts = C0(), budget = 0.05) => judgeWhole(per, base, counts, budget);
const isPass = (r) => r.measured === true && r.pass === true;
const isFail = (r) => r.measured === true && r.pass === false;
const isUnm = (r) => r.measured === false && r.pass === false && r.mean === null;   // window shape / values
const isUnc = (r) => r.measured === false && r.pass === false;   // span counts (the mean itself is computable)
function runVectors(rows) {
    const bad = rows.filter((v) => v[1] !== true).map((v) => v[0]);
    assert.deepEqual(bad, [], 'judge vectors failed: ' + bad.join(' | '));
}

describe('torture judge vectors (pure, test/torture-judge.mjs)', () => {
    it('judgeWhole window edges: window 0 ignored, windows 1..8 averaged against the budget', () => {
        assert.equal(WHOLE_WINDOWS, 9, 'WHOLE_WINDOWS');
        assert.equal(WHOLE_FORCED, 12, 'WHOLE_FORCED');
        const r8 = jw(at(Z(), 8, 0.41));
        assert.equal(r8.mean, 0.05125, 'per[8]=0.41 mean');
        runVectors([
            ['all zero passes', isPass(jw(Z()))],
            ['per[0]=100 alone passes', isPass(jw(at(Z(), 0, 100)))],
            ['per[8]=0.41 alone fails (mean 0.05125)', isFail(r8)],
            ['per[8]=0.40 passes (mean 0.05 = budget)', isPass(jw(at(Z(), 8, 0.40)))],
            ['per[1]=0.41 fails', isFail(jw(at(Z(), 1, 0.41)))],
            ['the mean is net of the baseline', isPass(jw(at(Z(), 3, 0.41), at(Z(), 3, 0.41)))],
            ['per length 8 unmeasured', isUnm(jw(Z().slice(1)))],
            ['per length 10 unmeasured', isUnm(jw([...Z(), 0]))],
            ['base length 8 unmeasured', isUnm(jw(Z(), Z().slice(1)))],
            ['null at window 4 unmeasured, nulls=1', (() => { const r = jw(at(Z(), 4, null)); return isUnm(r) && r.nulls === 1; })()],
            ['null at window 0 measured', isPass(jw(at(Z(), 0, null)))],
            ['base null at window 8 unmeasured', isUnm(jw(Z(), at(Z(), 8, null)))],
        ]);
    });

    it('judgeWhole malformed per entries are unmeasured; -0 counts as 0; bad counts fail closed', () => {
        runVectors([
            ['per non-array unmeasured', isUnm(jw({ length: 9 }))],
            ['per typed array unmeasured', isUnm(jw(new Float64Array(9)))],
            ['per NaN unmeasured', isUnm(jw(at(Z(), 2, NaN)))],
            ['per Infinity unmeasured', isUnm(jw(at(Z(), 2, Infinity)))],
            ['per -1 unmeasured', isUnm(jw(at(Z(), 2, -1)))],
            ["per '0' unmeasured", isUnm(jw(at(Z(), 2, '0')))],
            ['per undefined unmeasured', isUnm(jw(at(Z(), 2, undefined)))],
            ['per -0 counts as 0', isPass(jw(at(Z(), 2, -0)))],
            ['cell minor 1 fails', isFail(jw(Z(), Z(), C0({ cell: { ...S0(), minor: 1 } })))],
            ['cell major 1 fails', isFail(jw(Z(), Z(), C0({ cell: { ...S0(), major: 1 } })))],
            ['cell unknown 1 fails', isFail(jw(Z(), Z(), C0({ cell: { ...S0(), unknown: 1 } })))],
            ['base minor 1 fails', isFail(jw(Z(), Z(), C0({ base: { ...S0(), minor: 1 } })))],
            ['base major 1 fails', isFail(jw(Z(), Z(), C0({ base: { ...S0(), major: 1 } })))],
            ['base unknown 1 fails', isFail(jw(Z(), Z(), C0({ base: { ...S0(), unknown: 1 } })))],
            ['cell ignored 5 passes', isPass(jw(Z(), Z(), C0({ cell: { ...S0(), ignored: 5 } })))],
            ['forcedSeen 11 fails', isFail(jw(Z(), Z(), C0({ forcedSeen: 11 })))],
            ["forcedSeen '12' unmeasured", isUnc(jw(Z(), Z(), C0({ forcedSeen: '12' })))],
            ['counts null unmeasured', isUnc(jw(Z(), Z(), null))],
            ['cell minor -1 unmeasured', isUnc(jw(Z(), Z(), C0({ cell: { ...S0(), minor: -1 } })))],
            ['cell minor NaN unmeasured', isUnc(jw(Z(), Z(), C0({ cell: { ...S0(), minor: NaN } })))],
            ['budget NaN fails', jw(Z(), Z(), C0(), NaN).pass === false],
        ]);
    });

    it('judgeWhole stale base: a baseline whose min window 1..8 exceeds the cell min by > WHOLE_STALE_TOL is unmeasured', () => {
        assert.equal(WHOLE_STALE_TOL, 0.005, 'WHOLE_STALE_TOL');
        runVectors([
            ['per all 0.0892 + base all 0.0908 (b123 witness, 2 quanta) -> measured, pass', (() => {
                const r = jw(all(0.0892), all(0.0908)); return isPass(r) && r.staleBase === false && r.mean === 0; })()],
            ['base min = cell min + 0.0051 -> stale', (() => {
                const r = jw(all(0.0892), all(0.0892 + 0.0051)); return isUnm(r) && r.staleBase === true; })()],
            ['base min = cell min + 0.0049 -> measured', (() => {
                const r = jw(all(0.0892), all(0.0892 + 0.0049)); return isPass(r) && r.staleBase === false; })()],
            ['per all 0.0892 + base all 0.1452 -> unmeasured, staleBase', (() => {
                const r = jw(all(0.0892), all(0.1452)); return isUnm(r) && r.staleBase === true; })()],
            ['equal windows pass', (() => { const r = jw(all(0.0892), all(0.0892)); return isPass(r) && r.staleBase === false; })()],
            ['one cell window below the base min -> stale', (() => {
                const r = jw(at(all(0.0892), 5, 0.07), all(0.0892)); return isUnm(r) && r.staleBase === true; })()],
            ['cell window 0 below the base is ignored', isPass(jw(at(all(0.0892), 0, 0.01), all(0.0892)))],
            ['a null window is not stale (unmeasured by nulls)', (() => {
                const r = jw(at(all(0.0892), 4, null), all(0.1452)); return isUnm(r) && r.staleBase === false; })()],
        ]);
    });

    it('classifyGcKind: 1, 2 minor; 4 major; 8, 16 ignored; anything else unknown (and an unknown fails a span)', () => {
        runVectors([
            ['kind 1 minor', classifyGcKind(1) === 'minor'], ['kind 2 minor', classifyGcKind(2) === 'minor'],
            ['kind 4 major', classifyGcKind(4) === 'major'],
            ['kind 8 ignored', classifyGcKind(8) === 'ignored'], ['kind 16 ignored', classifyGcKind(16) === 'ignored'],
            ...[0, 3, 32, undefined, '1', NaN].map((k) => [(typeof k === 'string' ? "kind '" + k + "' (string)" : 'kind ' + String(k)) +
                ' unknown', classifyGcKind(k) === 'unknown']),
            ['an unknown kind in the cell span fails judgeWhole', (() => {
                const c = countSpan([5], [32], 1, 0, 10);
                return c !== null && c.unknown === 1 && isFail(jw(Z(), Z(), C0({ cell: c })));
            })()],
        ]);
    });

    it('countSpan: entries at t0 and t1 count, t0 - 1e-9 does not; malformed input -> null', () => {
        const T = new Float64Array([10, 20, 30, 40]);
        const K = [1, 2, 4, 32];
        runVectors([
            ['entry at t0 counts', countSpan(T, K, 4, 20, 25)?.minor === 1],
            ['entry at t1 counts', countSpan(T, K, 4, 15, 30)?.major === 1 && countSpan(T, K, 4, 15, 30)?.minor === 1],
            ['entry at t0 - 1e-9 does not count', countSpan(T, K, 4, 20 + 1e-9, 25)?.minor === 0],
            ['entry at t1 + 1e-9 does not count', countSpan(T, K, 4, 0, 40 - 1e-9)?.unknown === 0],
            ['kind 32 in span is unknown', countSpan(T, K, 4, 0, 100)?.unknown === 1],
            ['NaN time is unknown in every span', countSpan(new Float64Array([NaN]), [1], 1, 0, 1)?.unknown === 1],
            ['n limits the read', countSpan(T, K, 2, 0, 100)?.major === 0],
            ['n > length -> null', countSpan(T, K, 5, 0, 100) === null],
            ['n 1.5 -> null', countSpan(T, K, 1.5, 0, 100) === null],
            ['t0 > t1 -> null', countSpan(T, K, 4, 5, 1) === null],
            ['t0 NaN -> null', countSpan(T, K, 4, NaN, 1) === null],
            ['t1 Infinity -> null', countSpan(T, K, 4, 0, Infinity) === null],
        ]);
    });
});

describe('torture must-fail control', () => {
    it('live: exit 0, GATE ends | ok, drains full, retention 0', (t) => {
        const r = runLane('live');
        t.diagnostic('live ' + r.gate);
        assertGate('live', r);
        assert.equal(r.status, 0, 'live torture must exit 0 -- ' + describeRun('live', r));
        assert.ok(r.gate.endsWith('| ok'), 'live GATE must end `| ok` -- ' + describeRun('live', r));
        const s = sig(r.gate);
        assert.ok(s.alive !== null && s.nDrained !== null && s.lDrained !== null,
            'live GATE line lacks retention= / free=...n,...l fields (parser out of date?) -- ' + r.gate);
        assert.equal(s.alive, 0, 'live retention alive');
        assert.equal(s.alloc, 0, 'live phase-2b alloc must read 0 B/op -- ' + r.gate);
        assert.ok(s.refs > 0 && s.nTotal > 0 && s.lTotal > 0, 'live totals must be positive -- ' + r.gate);
        assert.equal(s.nDrained, s.nTotal, 'live node drain must be full');
        assert.equal(s.lDrained, s.lTotal, 'live link drain must be full');
        liveSig = s;
    });

    const expectFail = (kind, r) => {
        assertGate(kind, r);
        assert.equal(r.status, 1, kind + ' torture must exit 1 -- ' + describeRun(kind, r));
        assert.ok(r.gate.endsWith('| FAIL'), kind + ' GATE must end `| FAIL` -- ' + describeRun(kind, r));
        const s = sig(r.gate);
        assert.ok(s.alive !== null && s.nDrained !== null, kind + ' GATE lacks retention= / free= -- ' + r.gate);
        return s;
    };

    it('slow (node free-list leak every 1000th disposal): FAIL with free= nodes short', (t) => {
        const r = runLane('slow');
        t.diagnostic('slow ' + r.gate);
        const s = expectFail('slow', r);
        const L = liveTotals();
        assert.equal(s.nTotal, L.nTotal, 'slow node total must match live');
        assert.ok(s.nDrained < s.nTotal, 'slow signature: free nodes ' + s.nDrained + '/' + s.nTotal + ' must be short');
    });

    it('lslow (link free-list leak every 1000th disposal): FAIL with free= links short', (t) => {
        const r = runLane('lslow');
        t.diagnostic('lslow ' + r.gate);
        const s = expectFail('lslow', r);
        const L = liveTotals();
        assert.ok(s.lDrained !== null, 'lslow signature: link drain unmeasured -- ' + r.gate);
        assert.equal(s.lTotal, L.lTotal, 'lslow link total must match live');
        assert.ok(s.lDrained < s.lTotal, 'lslow signature: free links ' + s.lDrained + '/' + s.lTotal + ' must be short');
    });

    it('val (disposal keeps node.value): FAIL with retention alive >= 1', (t) => {
        const r = runLane('val');
        t.diagnostic('val ' + r.gate);
        const s = expectFail('val', r);
        const L = liveTotals();
        assert.equal(s.refs, L.refs, 'val retention refs must match live');
        assert.ok(s.alive >= 1, 'val signature: retention alive ' + s.alive + '/' + s.refs + ' must be >= 1');
    });

    it('aset (read.set retains one object per 20 calls): FAIL with alloc > 0 and a set alloc fail line', (t) => {
        const r = runLane('aset');
        t.diagnostic('aset ' + r.gate);
        const s = expectFail('aset', r);
        assert.ok(s.alloc > 0, 'aset signature: alloc=' + s.alloc + ' B/op must be > 0 -- ' + r.gate);
        assert.ok(/^ {2}set alloc fail attempt \d+: /m.test(r.stderr),
            'aset signature: no `set alloc fail attempt` line -- ' + describeRun('aset', r));
    });

    it('aun (untrack retains one object per 20 calls): FAIL with alloc > 0 and an untrack alloc fail line', (t) => {
        const r = runLane('aun');
        t.diagnostic('aun ' + r.gate);
        const s = expectFail('aun', r);
        assert.ok(s.alloc > 0, 'aun signature: alloc=' + s.alloc + ' B/op must be > 0 -- ' + r.gate);
        assert.ok(/^ {2}untrack alloc fail attempt \d+: /m.test(r.stderr),
            'aun signature: no `untrack alloc fail attempt` line -- ' + describeRun('aun', r));
    });

    // b123: the whole-run cells. `  whole <cell>: mean=<x|unmeasured(..)> B/op minor=<n|null> ...` on stderr;
    // an unmeasured mean or a null count parses as NaN (never meets a bound: fail closed).
    const wholeLines = (stderr) => {
        const m = {};
        for (const x of stderr.matchAll(/^ {2}whole (\w+): mean=(\S+) B\/op minor=(\S+) /gm)) {
            m[x[1]] = { mean: /^[0-9.]+$/.test(x[2]) ? +x[2] : NaN, minor: /^\d+$/.test(x[3]) ? +x[3] : NaN, line: x[0] };
        }
        return m;
    };
    const hot = (w, meanMin) => w !== undefined && (w.mean >= meanMin || w.minor >= 1);

    it('tset (TB(40000) at read.set: 320 KB in new_large_object_space per 40,000 calls): FAIL with whole nest + nest lane', (t) => {
        const r = runLane('tset');
        t.diagnostic('tset ' + r.gate);
        expectFail('tset', r);
        const w = wholeLines(r.stderr);
        t.diagnostic('tset whole ' + Object.keys(w).map((c) => w[c].line).join(' || '));
        assert.ok(hot(w.nest, 2), 'tset signature: `  whole nest:` needs mean >= 2 or minor >= 1 -- ' + describeRun('tset', r));
        assert.match(r.stderr, /^ {2}nest lane: /m, 'tset signature: no legacy `  nest lane:` line -- ' + describeRun('tset', r));
    });

    it('tcell (TB(8000) at untrack, scheduler dispatch, lifecycle fires): FAIL with whole watch / qs / mreg, no nest', (t) => {
        const r = runLane('tcell');
        t.diagnostic('tcell ' + r.gate);
        expectFail('tcell', r);
        const w = wholeLines(r.stderr);
        t.diagnostic('tcell whole ' + Object.keys(w).map((c) => w[c].line).join(' || '));
        for (const c of ['watch', 'qs', 'mreg']) {
            assert.ok(hot(w[c], 0.4), 'tcell signature: `  whole ' + c + ':` needs mean >= 0.4 or minor >= 1 -- ' +
                describeRun('tcell', r));
        }
        assert.match(r.stderr, /^ {2}watch lane: /m, 'tcell signature: no legacy `  watch lane:` line');
        assert.match(r.stderr, /^ {2}qs: /m, 'tcell signature: no legacy `  qs:` line');
        assert.match(r.stderr, /^ {2}mreg: /m, 'tcell signature: no legacy `  mreg:` line');
        assert.equal(w.nest, undefined, 'tcell must leave the nest cell green -- ' + (w.nest ? w.nest.line : ''));
        assert.doesNotMatch(r.stderr, /^ {2}nest lane: /m, 'tcell must not print `  nest lane:`');
    });
});
