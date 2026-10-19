// test/64-torture-mustfail.test.mjs -- burst 63 (PLAN-0w C1): must-fail control for test/torture.mjs.
// The torture gate is only a gate if a known-bad engine turns it red. This test copies the engine under test
// (LITE_SIGNAL_KERNEL, default ../Signal.js -- the WORKING-TREE engine, never git HEAD) into a temp dir together with
// Watch.js, package.json, test/torture.mjs and a node_modules symlink, applies one text mutant, and runs
// `node --expose-gc <tmp>/test/torture.mjs` in a child process (the torture spawns its own --nest-lane child).
// Lanes (recipe: .handoff/b61-evidence/qa/mkmut.mjs; b61 signatures in scratch-{slow,lslow,val-new}.log):
//   live  -- unmutated: exit 0, GATE line ends `| ok`, every drain full, retention 0 (the control).
//   slow  -- every 1000th disposal the node is not pushed to the free list -> `free=` nodes short (b61: 811/1021n).
//   lslow -- every 1000th disposal the sub link is not pushed to the free list -> links short (b61: 4032/4095l).
//   val   -- disposal stops clearing node.value -> `retention=` alive >= 1 (b61: 1/966).
//   aset  -- read.set retains one { n } per 1000 calls -> GATE `| alloc=` > 0 + a `set alloc fail attempt` line
//            (b72: the phase-2b retention-slope lane's must-fail; 0.032 B/op, Dlo=640 Dhi=3200).
//   aun   -- untrack retains one { n } per 1000 calls -> `| alloc=` > 0 + an `untrack alloc fail attempt` line.
//            The alloc lanes catch down to 1 retained object per 1e5 steps (b72 teeth: N=100000 red, 200000 green).
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

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? fileURLToPath(new URL('../Signal.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TORTURE = fileURLToPath(new URL('./torture.mjs', import.meta.url));
const WATCH = existsSync(join(dirname(KPATH), 'Watch.js')) ? join(dirname(KPATH), 'Watch.js') : join(ROOT, 'Watch.js');
const CHILD_TIMEOUT_MS = 60000;
const sha8 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8);

// The alloc mutants' retainer: a module-free counter on globalThis, one { n } kept per 1000 calls.
const LEAK = 'globalThis.__t64N = (globalThis.__t64N | 0) + 1; if (globalThis.__t64N % 1000 === 0) ' +
    '(globalThis.__t64 || (globalThis.__t64 = [])).push({ n: globalThis.__t64N });\n';
// [anchor, replacement] -- slow / lslow / val verbatim from the b61 qa recipe.
const MUTANTS = {
    slow: ['            pinnedHead = node;\n        } else {\n            node.nextFree = freeNodeHead;',
        '            pinnedHead = node;\n        } else if ((statTotalDisposals % 1000) !== 999) {\n' +
            '            node.nextFree = freeNodeHead;'],
    lslow: ['            sLink.nextFree = freeLinkHead;\n            freeLinkHead = sLink;\n',
        '            if ((statTotalDisposals % 1000) !== 999) { sLink.nextFree = freeLinkHead;\n' +
            '            freeLinkHead = sLink; }\n'],
    val: ['        node.schedulerThunk = undefined;  // drop closure; recycle rebuilds it\n        node.value = undefined;\n',
        '        node.schedulerThunk = undefined;  // drop closure; recycle rebuilds it\n'],
    // b72: one retained object per 1000 calls (recipe: .handoff/b72-evidence/t64/teeth.mjs).
    aset: ['            markDownstream(node);\n            if (batchDepth === 0) flushEffects();\n        };\n        read.update = sharedUpdate;',
        '            ' + LEAK + '            markDownstream(node);\n            if (batchDepth === 0) flushEffects();\n' +
            '        };\n        read.update = sharedUpdate;'],
    aun: ['    function untrack(fn) {\n        const po = currentObserver, pg = po !== null ? po.gen : 0;\n        currentObserver = null;\n',
        '    function untrack(fn) {\n        const po = currentObserver, pg = po !== null ? po.gen : 0;\n        currentObserver = null;\n' +
            '        ' + LEAK],
};

test('kernel under test', (t) => {
    t.diagnostic('kernel ' + KPATH + ' sha256/8 ' + sha8(KPATH));
    t.diagnostic('watch ' + WATCH + ' sha256/8 ' + sha8(WATCH));
    t.diagnostic('torture ' + TORTURE + ' sha256/8 ' + sha8(TORTURE));
    assert.ok(existsSync(join(ROOT, 'node_modules')), 'package node_modules missing (npm install)');
});

// Build the scratch package, mutate, run the torture once. Never throws for a child failure: returns the facts.
function runLane(kind) {
    const dir = mkdtempSync(join(tmpdir(), 'lite-signal-t64-' + kind + '-'));
    try {
        mkdirSync(join(dir, 'test'));
        let src = readFileSync(KPATH, 'utf8');
        if (kind !== 'live') {
            const [a, b] = MUTANTS[kind];
            const n = src.split(a).length - 1;
            assert.equal(n, 1, 'mutant ' + kind + ': anchor occurs ' + n + 'x in ' + KPATH +
                ' (must be exactly 1) -- re-anchor the mutant in test/64, never skip it');
            src = src.split(a).join(b);  // literal: no $-patterns in b
        }
        writeFileSync(join(dir, 'Signal.js'), src);
        copyFileSync(WATCH, join(dir, 'Watch.js'));
        copyFileSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
        copyFileSync(TORTURE, join(dir, 'test', 'torture.mjs'));
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

    it('aset (read.set retains one object per 1000 calls): FAIL with alloc > 0 and a set alloc fail line', (t) => {
        const r = runLane('aset');
        t.diagnostic('aset ' + r.gate);
        const s = expectFail('aset', r);
        assert.ok(s.alloc > 0, 'aset signature: alloc=' + s.alloc + ' B/op must be > 0 -- ' + r.gate);
        assert.ok(/^ {2}set alloc fail attempt \d+: /m.test(r.stderr),
            'aset signature: no `set alloc fail attempt` line -- ' + describeRun('aset', r));
    });

    it('aun (untrack retains one object per 1000 calls): FAIL with alloc > 0 and an untrack alloc fail line', (t) => {
        const r = runLane('aun');
        t.diagnostic('aun ' + r.gate);
        const s = expectFail('aun', r);
        assert.ok(s.alloc > 0, 'aun signature: alloc=' + s.alloc + ' B/op must be > 0 -- ' + r.gate);
        assert.ok(/^ {2}untrack alloc fail attempt \d+: /m.test(r.stderr),
            'aun signature: no `untrack alloc fail attempt` line -- ' + describeRun('aun', r));
    });
});
