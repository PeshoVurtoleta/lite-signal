// 57-soak-creation-abort.test.mjs -- the soak model's creation-abort rule (burst 51, DELTA 4b T7).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// An INDEPENDENT ORACLE written from the planner assertions A1' / A2 / A4' (.handoff/b50-evidence/delta4b-v3-planner.md,
// .handoff/b49-evidence/delta4b-v2-planner.md), never from the implementation. The rule under test: on a lite kernel
// that is NOT a controls.json control, a write-cycle effect's CycleError surfaces at the effect's CREATION (e2 of the
// bomb pair); on a control it surfaces at the cyc:1 set. exec.mjs computes creationAbort from adapter.knownAs().
//
//   W_G7   the R2-M1 world with the same-op stops/disposes (inside divergences G7): .handoff/b50-evidence/t0-wg7-world.json
//   TEETH  W_G7 minus stop 38 and disp 36 (outside G7, e1 live at rest): t0-wg7-teeth-world.json
//
// Both worlds are inlined verbatim below (the evidence files are .handoff and may be absent in a clean checkout).
// Expected values: A1'/A2/A4' text, and the P1 probe numbers (t0-SUMMARY): on a non-control kernel e2's creation
// throws; on preb33 the set throws. TEETH on preb33: e1 (#38) last ran at a=506, e2 wrote 508 -> O1e
// "effect#38 saw [#36=506] model [#36=508]" (planner F1).
//
// Kernel binding: kernel.mjs reads SOAK_KERNEL once at import, so each row runs in a CHILD node process (the same
// seam test/43-46 use for end-to-end rows). live = no SOAK_KERNEL (the in-tree Signal.js); preb33 = the byte copy of
// frozen/head-7c65afd at bench/soak/controls/preb33/Signal.js. A missing kernel dir is a RED row, never a skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PREB33 = join(ROOT, 'bench', 'soak', 'controls', 'preb33', 'Signal.js');

const W_G7 = {
    genVersion: 1, lane: 'ERROR', seed: 1405359449, large: false, covOff: null, flushPasses: 8,
    ops: [{ o: 'seq', ops: [
        { o: 'sig', i: 36, v: 0 }, { o: 'sig', i: 37, v: 0 },
        { o: 'eff', i: 38, spec: { k: 'sum', d: [36], w: 37, inc: 1, try: true, role: 'bomb' } },
        { o: 'eff', i: 39, spec: { k: 'sum', d: [37], w: 36, inc: 1, try: true, role: 'bomb' } },
        { o: 'set', i: 36, v: 500, cyc: 1 },
        { o: 'stop', i: 38 }, { o: 'stop', i: 39 }, { o: 'disp', i: 36 }, { o: 'disp', i: 37 },
    ] }],
};
const TEETH = {
    genVersion: 1, lane: 'ERROR', seed: 1405359449, large: false, covOff: null, flushPasses: 8,
    ops: [{ o: 'seq', ops: [
        { o: 'sig', i: 36, v: 0 }, { o: 'sig', i: 37, v: 0 },
        { o: 'eff', i: 38, spec: { k: 'sum', d: [36], w: 37, inc: 1, try: true, role: 'bomb' } },
        { o: 'eff', i: 39, spec: { k: 'sum', d: [37], w: 36, inc: 1, try: true, role: 'bomb' } },
        { o: 'set', i: 36, v: 500, cyc: 1 },
        { o: 'stop', i: 39 }, { o: 'disp', i: 37 },
    ] }],
};
// W_G7 with effect 39 created inside a batch (pin (i): the unmodelled-creation-cycle throw must reach runWorld, not be
// swallowed by the batch guard). Same ops as W_G7, E39 wrapped in {o:'batch'}.
const E38 = { o: 'eff', i: 38, spec: { k: 'sum', d: [36], w: 37, inc: 1, try: true, role: 'bomb' } };
const E39 = { o: 'eff', i: 39, spec: { k: 'sum', d: [37], w: 36, inc: 1, try: true, role: 'bomb' } };
const W_BATCH = {
    genVersion: 1, lane: 'ERROR', seed: 1405359449, large: false, covOff: null, flushPasses: 8,
    ops: [{ o: 'seq', ops: [
        { o: 'sig', i: 36, v: 0 }, { o: 'sig', i: 37, v: 0 }, E38, { o: 'batch', body: [E39] },
        { o: 'set', i: 36, v: 500, cyc: 1 },
        { o: 'stop', i: 38 }, { o: 'stop', i: 39 }, { o: 'disp', i: 36 }, { o: 'disp', i: 37 },
    ] }],
};
// 4b-v2 (iii) inc rule: a pair with no inc (or inc 0) is not a write-cycle, so the set must not throw; failure null.
const W_NOINC = {
    genVersion: 1, lane: 'ERROR', seed: 1405359449, large: false, covOff: null, flushPasses: 8,
    ops: [{ o: 'seq', ops: [
        { o: 'sig', i: 36, v: 0 }, { o: 'sig', i: 37, v: 0 },
        { o: 'eff', i: 38, spec: { k: 'sum', d: [36], w: 37, try: true } },
        { o: 'eff', i: 39, spec: { k: 'sum', d: [37], w: 36, try: true } },
        { o: 'set', i: 36, v: 5 },
    ] }],
};
const W_INC0 = {
    genVersion: 1, lane: 'ERROR', seed: 1405359449, large: false, covOff: null, flushPasses: 8,
    ops: [{ o: 'seq', ops: [
        { o: 'sig', i: 36, v: 0 }, { o: 'sig', i: 37, v: 0 },
        { o: 'eff', i: 38, spec: { k: 'sum', d: [36], w: 37, inc: 0, try: true } },
        { o: 'eff', i: 39, spec: { k: 'sum', d: [37], w: 36, inc: 0, try: true } },
        { o: 'set', i: 36, v: 5 },
    ] }],
};
// An effect that reads signal 0 and writes nothing: no write-cycle exists in this world.
const PLAIN = {
    genVersion: 1, lane: 'ERROR', seed: 7, large: false, covOff: null, flushPasses: 8,
    ops: [{ o: 'sig', i: 0, v: 0 }, { o: 'eff', i: 1, spec: { k: 'sum', d: [0], inc: 1, role: 'plain' } }],
};

// The child driver: one JSON config in T57_CFG, one JSON result line on stdout. Imports are inside the child so the
// kernel seam binds to the child's SOAK_KERNEL.
const DRIVER = `
const cfg = JSON.parse(process.env.T57_CFG);
const SOAK = new URL('file://' + cfg.root + '/bench/soak/');
const ex = await import(new URL('exec.mjs', SOAK));
const mn = await import(new URL('main.mjs', SOAK));
const { liteAdapter } = await import(new URL('adapters/lite.mjs', SOAK));
const keys = (r) => (r.failure === null ? null : r.failure.fails.map((f) => f.oracle + ':' + f.sig));
const tap = () => ({ escape: null, onOpen() {} });
const out = {};
function stubEffectThrows(base) {
    return Object.create(base, { open: { value(o) {
        const raw = base.open(o); const W = {};
        for (const k of Object.keys(raw)) W[k] = typeof raw[k] === 'function' ? raw[k].bind(raw) : raw[k];
        W.effect = () => { throw new Error('CycleError: flush passes exceeded'); };
        return W;
    } } });
}
try {
    if (cfg.mode === 'run') {
        const opts = cfg.protoOpts ? Object.create(cfg.protoOpts) : cfg.opts;   // protoOpts: the key lives on the PROTOTYPE only
        const r = ex.runWorld(mn.tapAdapter(liteAdapter, tap()), cfg.world, opts);
        out.keys = keys(r); out.ces = r.scen['cycle-error-surfaces']; out.detail = r.failure === null ? null : r.failure.fails.map((f) => f.detail);
    } else if (cfg.mode === 'stub') {
        const base = { name: 'lite', caps: liteAdapter.caps, files: () => liteAdapter.files(), version: liteAdapter.version,
            open: (o) => liteAdapter.open(o) };
        if (cfg.knownAs === 'undef') base.knownAs = () => undefined;
        else if (cfg.knownAs === 'empty') base.knownAs = () => '';
        else if (cfg.knownAs) base.knownAs = () => null;
        const ad = stubEffectThrows(Object.freeze(base));
        const r = ex.runWorld(ad, cfg.world, cfg.opts);
        out.keys = keys(r);
        if (r.failure !== null) {
            const rec = mn.failureRecord(r, { engine: 'lite', lane: 'ERROR', cycle: 0, world: 0, worldSeed: 1, escape: null });
            out.known = rec.known;
        }
    } else if (cfg.mode === 'loop') {
        const { createLeakTracker } = await import('@zakkster/lite-leak');
        const tracker = createLeakTracker({ name: 't57' });
        const residue = [];
        const spy = Object.create(liteAdapter, { open: { value(o) {
            const w = liteAdapter.open(o); const close = w.close;
            w.close = () => { const x = close.call(w); residue.push(x); return x; };
            return w;
        } } });
        const t = { escape: null, onOpen(w) { tracker.track(w.registry, null, 't57'); } };
        const ad = mn.tapAdapter(spy, t);
        let bad = 0, ces = 0;
        for (let i = 0; i < cfg.n; i++) {
            const r = ex.runWorld(ad, cfg.world);
            if (r.failure !== null) bad++;
            ces += r.scen['cycle-error-surfaces'] === 1 ? 1 : 0;
        }
        let size = tracker.size();
        for (let k = 0; k < 40 && size !== 0; k++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 10)); size = tracker.size(); }
        out.n = residue.length; out.bad = bad; out.ces = ces; out.size = size;
        out.badResidue = residue.filter((x) => x.nodes !== 0 || x.links !== 0).length;
    }
} catch (e) { out.threw = String(e && e.message ? e.message : e); out.stack = String(e && e.stack); }
process.stdout.write('T57 ' + JSON.stringify(out) + '\\n');
`;

function child(kernel, cfg) {
    const env = Object.assign({}, process.env, { T57_CFG: JSON.stringify(Object.assign({ root: ROOT.replace(/\/$/, '') }, cfg)) });
    delete env.SOAK_KERNEL; delete env.SOAK_ENGINE; delete env.SOAK_NEARWRAP;
    if (kernel !== null) env.SOAK_KERNEL = kernel;
    const p = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', DRIVER], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
    const line = (p.stdout || '').split('\n').find((l) => l.startsWith('T57 '));
    assert.ok(line, 'child gave no result line; status ' + p.status + '\nstderr: ' + (p.stderr || '').slice(0, 600) + '\nstdout: ' + (p.stdout || '').slice(0, 300));
    return JSON.parse(line.slice(4));
}
const needPreb33 = () => assert.ok(existsSync(PREB33), 'control kernel missing: ' + PREB33 + ' (B2 creates it; a missing control is red, not a skip)');

test('A1p-a: W_G7 on the live kernel (creationAbort default) -> failure null, cycle-error-surfaces 1', () => {
    const o = child(null, { mode: 'run', world: W_G7 });
    assert.equal(o.threw, undefined, o.threw);
    assert.equal(o.keys, null, JSON.stringify(o.detail));
    assert.equal(o.ces, 1);
});

test('A1p-b: W_G7 on the preb33 control -> failure null, cycle-error-surfaces 1 (surfaces at the set)', () => {
    needPreb33();
    const o = child(PREB33, { mode: 'run', world: W_G7 });
    assert.equal(o.threw, undefined, o.threw);
    assert.equal(o.keys, null, JSON.stringify(o.detail));
    assert.equal(o.ces, 1);
});

test('A1p-c: live + opts.creationAbort false -> runWorld throws /^exec: unmodelled cycle set: signal#36/ at the trigger', () => {
    const o = child(null, { mode: 'run', world: W_G7, opts: { creationAbort: false } });
    assert.match(String(o.threw), /^exec: unmodelled cycle set: signal#36/, 'got ' + JSON.stringify(o));
});

test('A1p-d: preb33 + opts.creationAbort true -> failures exactly [O6:expected-escape-missing]', () => {
    needPreb33();
    const o = child(PREB33, { mode: 'run', world: W_G7, opts: { creationAbort: true } });
    assert.equal(o.threw, undefined, o.threw);
    assert.deepEqual(o.keys, ['O6:expected-escape-missing']);
});

test('A1p-e: teeth world (outside G7) on preb33 -> failures exactly [O1e:effect-stale] with the P1 message', () => {
    needPreb33();
    const o = child(PREB33, { mode: 'run', world: TEETH });
    assert.equal(o.threw, undefined, o.threw);
    assert.deepEqual(o.keys, ['O1e:effect-stale']);
    assert.match(o.detail[0], /effect#38 saw \[#36=506\] model \[#36=508\]/);
});

test('A2-a: stub lite adapter (knownAs null) whose effect() throws a CycleError with NO write-cycle -> [O6:escape-CycleError], unclassified', () => {
    const o = child(null, { mode: 'stub', knownAs: true, world: PLAIN });
    assert.equal(o.threw, undefined, o.threw);
    assert.deepEqual(o.keys, ['O6:escape-CycleError']);
    assert.equal(o.known, null, 'classify() must not explain it');
});

test('A2-b: a lite adapter with no knownAs -> the Exec ctor throws (fail closed)', () => {
    const o = child(null, { mode: 'stub', knownAs: false, world: PLAIN });
    assert.equal(typeof o.threw, 'string', 'expected a throw, got ' + JSON.stringify(o));
    assert.match(o.threw, /^exec: lite adapter has no knownAs\(\)/);
});

test('A2-d: exec.mjs:78 -- a lite knownAs() returning undefined or "" -> the Exec ctor throws (neither null nor a control name)', () => {
    for (const bad of ['undef', 'empty']) {
        const o = child(null, { mode: 'stub', knownAs: bad, world: PLAIN });
        assert.equal(typeof o.threw, 'string', 'knownAs ' + bad + ' must throw, got ' + JSON.stringify(o));
        assert.match(o.threw, /^exec: lite adapter knownAs\(\) must return null or a control name/);
    }
});

test('A2-e: exec.mjs:70 -- creationAbort set on the PROTOTYPE of opts is not read (own key only): no throw', () => {
    const o = child(null, { mode: 'run', world: PLAIN, protoOpts: { creationAbort: 1 } });
    assert.equal(o.threw, undefined, 'an inherited creationAbort must be ignored, got ' + o.threw);
    assert.equal(o.keys, null, JSON.stringify(o.detail));
});

test('A1p-f: pin (i) -- effect creation inside a batch hits the unmodelled cycle -> runWorld throws /^exec: unmodelled creation cycle: effect#39/ (not an O6 escape)', () => {
    const o = child(null, { mode: 'run', world: W_BATCH });
    assert.equal(typeof o.threw, 'string', 'expected runWorld to throw, got ' + JSON.stringify(o));
    assert.match(o.threw, /^exec: unmodelled creation cycle: effect#39/);
});

test('A1p-g: inc rule -- W_G7 pair with inc removed -> failure null (no write-cycle, nothing expected to throw)', () => {
    const o = child(null, { mode: 'run', world: W_NOINC });
    assert.equal(o.threw, undefined, o.threw);
    assert.equal(o.keys, null, JSON.stringify(o.detail));
});

test('A1p-h: inc rule -- W_G7 pair with inc 0, then set 36 = 5 -> failure null', () => {
    const o = child(null, { mode: 'run', world: W_INC0 });
    assert.equal(o.threw, undefined, o.threw);
    assert.equal(o.keys, null, JSON.stringify(o.detail));
});

test('A2-c: opts.creationAbort must be a boolean -> 1, "true", null, {} throw; true and false do not', () => {
    for (const bad of [1, 'true', null, {}]) {
        const o = child(null, { mode: 'run', world: PLAIN, opts: { creationAbort: bad } });
        assert.equal(typeof o.threw, 'string', 'creationAbort ' + JSON.stringify(bad) + ' must throw, got ' + JSON.stringify(o));
        assert.match(o.threw, /^exec: opts\.creationAbort must be a boolean/);
    }
    for (const ok of [true, false]) {
        const o = child(null, { mode: 'run', world: PLAIN, opts: { creationAbort: ok } });
        assert.equal(o.threw, undefined, 'creationAbort ' + ok + ' threw: ' + o.threw);
    }
});

test('A4p: 200 x runWorld(W_G7) on live -> close() residue 0 nodes / 0 links every cycle, tracker.size() 0 after', () => {
    const o = child(null, { mode: 'loop', world: W_G7, n: 200 });
    assert.equal(o.threw, undefined, o.threw);
    assert.equal(o.n, 200, 'close() ran once per world');
    assert.equal(o.bad, 0, 'every world clean');
    assert.equal(o.ces, 200, 'cycle-error-surfaces 1 every world');
    assert.equal(o.badResidue, 0);
    assert.equal(o.size, 0, 'tracker.size() after forced gc');
});
