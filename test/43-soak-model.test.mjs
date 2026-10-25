/**
 * test/43-soak-model.test.mjs -- the soak's model, oracles and generator (SPEC-B v2 sections 4, 6, 14.8).
 *
 *   1. Naivety pin: bench/soak/model.mjs code carries no version / epoch / stamp / cache / dirty identifier
 *      and bumps no this.<field> counter; exec.mjs keeps no memo/cache field or module-level Map cache.
 *   2. Oracle sanity (S8, no tautologies): each S1 oracle (O1c, O1e, O2, O4, O5, O6, O7a) FIRES on a
 *      hand-built failing world and is SILENT on the passing twin. Pure: no engine is loaded.
 *   3. Model rules from TASK 0d (owner kill, disposed read, taint) on hand-built state.
 *   4. G0 determinism: the op script is a pure function of (lane, seed); distinct seeds differ.
 *   5. In-process mutant adapters on the frozen headpatched fixture: an engine that skips effect bodies
 *      (O4 never ran, O5), an escape with zero leaves (O6 escape-empty), the batch-token replacement rule.
 *   6. End to end through the real executor (child processes, SOAK_KERNEL seam): BATCH fires on the
 *      published 1.5.2 (F5, revert-after-mid-read) and is silent on the frozen headpatched fixture; NEST
 *      fires F15 on headpatched and its trigger-less twin (cov-off) is silent there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Model } from '../bench/soak/model.mjs';
import * as O from '../bench/soak/oracles.mjs';
import { SoakThrow, normalizeEscape } from '../bench/soak/kinds.mjs';
import { generateWorld, scriptJson } from '../bench/soak/gen.mjs';
import { LANES, ROSTER } from '../bench/soak/lanes/index.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOAK = join(ROOT, 'bench', 'soak');
const CAPS = { equality: 'is', childEffects: 'parent-run' };

/* -- 1. naivety pin -------------------------------------------------------------------------------------- */

function stripCommentsAndStrings(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
}

test('naivety pin: model.mjs code has no version/epoch/stamp/cache/dirty identifier', () => {
    const code = stripCommentsAndStrings(readFileSync(join(SOAK, 'model.mjs'), 'utf8'));
    const hits = code.match(/[A-Za-z_$][\w$]*/g).filter((id) => /version|epoch|stamp|cache|dirty/i.test(id));
    assert.deepEqual(hits, []);
});

// a pure-state counter is a version by another name: no `this.<field>++` / `+= 1` / `--` in the model
const COUNTER_RE = /(?:\+\+|--)\s*this\.[\w$]+|this\.[\w$]+(?:\[[^\]]*\])?\s*(?:\+\+|--|[+-]=\s*1\b)/g;

test('naivety pin: model.mjs bumps no this.<field> counter', () => {
    const code = stripCommentsAndStrings(readFileSync(join(SOAK, 'model.mjs'), 'utf8'));
    assert.deepEqual(code.match(COUNTER_RE) || [], []);
});

test('naivety pin (counter) has teeth', () => {
    const code = stripCommentsAndStrings('class M { f() { this.edits++; ++this.n; this.k += 1; this.ok = 2; nd.runs++; } }');
    assert.deepEqual(code.match(COUNTER_RE), ['this.edits++', '++this.n', 'this.k += 1']);
});

// exec.mjs may hold world state (handles, frames, queues) but no cache that outlives one check call
const EXEC_CACHE_RE = /this\.[\w$]*(?:memo|cache)[\w$]*\s*=(?!=)|^(?:const|let|var)\s+[\w$]+\s*=\s*new\s+(?:Weak)?Map\b/gim;

test('naivety pin: exec.mjs keeps no cache across check calls', () => {
    const code = stripCommentsAndStrings(readFileSync(join(SOAK, 'exec.mjs'), 'utf8'));
    assert.deepEqual(code.match(EXEC_CACHE_RE) || [], []);
});

test('naivety pin (exec cache) has teeth', () => {
    const code = stripCommentsAndStrings('const MEMO = new Map();\nclass X { f() { this.memoMap = null; this.valCache = 1; this.actions = new Map(); const m = new Map(); this.memo === 1; } }');
    assert.deepEqual(code.match(EXEC_CACHE_RE), ['const MEMO = new Map', 'this.memoMap =', 'this.valCache =']);
});

test('naivety pin has teeth: the same scan flags a planted identifier', () => {
    const code = stripCommentsAndStrings('// version in a comment is fine\nconst s = "dirty"; let evalVersion = 0;');
    const hits = code.match(/[A-Za-z_$][\w$]*/g).filter((id) => /version|epoch|stamp|cache|dirty/i.test(id));
    assert.deepEqual(hits, ['evalVersion']);
});

/* -- hand-built worlds ---------------------------------------------------------------------------------- */

/** s0 = 5, s1 = 2 (disposable), c2 = sum[s0], c3 = sum[c2, s1], e4 reads [c2] (try), e5 reads [s0, c3]. */
function world() {
    const m = new Model(CAPS);
    m.addSignal(0, 5, {});
    m.addSignal(1, 2, { dis: true });
    m.addComputed(2, { k: 'sum', d: [0] });
    m.addComputed(3, { k: 'sum', d: [2, 1] });
    m.addEffect(4, { k: 'sum', d: [2], try: true }, -1);
    m.addEffect(5, { k: 'sum', d: [0, 3], try: true }, -1);
    // what the engine observed on the last runs (as exec.mjs records it)
    m.n[2].links = [0]; m.n[2].seen = [{ r: 0, v: 5 }];
    m.n[3].links = [2, 1]; m.n[3].seen = [{ r: 2, v: 5 }, { r: 1, v: 2 }];
    m.n[4].links = [2]; m.n[4].seen = [{ r: 2, v: 5 }];
    m.n[5].links = [0, 3]; m.n[5].seen = [{ r: 0, v: 5 }, { r: 3, v: 7 }];
    return m;
}

const stats = (o) => Object.assign({ signals: 2, computeds: 2, effects: 2, activeNodes: 6, activeLinks: 6 }, o || {});

/* -- 2. oracle sanity ------------------------------------------------------------------------------------ */

test('O1c: silent on the right value, fires on a wrong value and on a wrong error', () => {
    const m = world();
    assert.equal(O.checkComputed(m, 3, 7, new Map()), null);
    assert.equal(O.checkComputed(m, 3, 8, new Map()).sig, 'computed-mismatch');
    assert.equal(O.checkComputed(m, 3, new SoakThrow('computed', 3), new Map()).sig, 'computed-err-mismatch');
    m.addComputed(6, { k: 'identity', d: [0], thr: true });   // thr: toNum(5) % 5 = 0 -> no throw
    m.setValue(0, 8);                                         // 8 % 5 = 3 -> throws
    assert.equal(O.checkComputed(m, 6, new SoakThrow('computed', 6), new Map()), null);
    assert.equal(O.checkComputed(m, 6, new SoakThrow('computed', 99), new Map()).sig, 'computed-err-mismatch');
});

test('O2: silent on a consistent read, fires on a glitch', () => {
    const m = world();
    assert.equal(O.checkRead(m, 3, 7, new Map(), 5), null);
    const f = O.checkRead(m, 3, 6, new Map(), 5);
    assert.equal(f.oracle, 'O2');
    assert.equal(f.sig, 'glitch');
});

test('O1e / O4: silent when the observation matches; stale when it ran, dead when it did not', () => {
    const m = world();
    assert.deepEqual(O.checkEffect(m, 5, false, new Map(), new Map()), { fail: null, o1e: 'done', o4: 'done' });
    assert.deepEqual(O.checkEffect(m, 5, true, new Map(), new Map()), { fail: null, o1e: 'done', o4: 'na' });
    m.setValue(0, 6);
    const stale = O.checkEffect(m, 5, true, new Map(), new Map()).fail;
    assert.deepEqual([stale.oracle, stale.sig], ['O1e', 'effect-stale']);
    const dead = O.checkEffect(m, 5, false, new Map(), new Map()).fail;
    assert.deepEqual([dead.oracle, dead.sig], ['O4', 'effect-dead']);
});

test('O4 on a tainted effect: checks live untainted inputs only', () => {
    const m = world();
    m.kill(1);                       // c3 read s1 -> c3 tainted -> e5 tainted transitively
    assert.equal(m.tainted(3, new Map()), true);
    assert.equal(m.tainted(5, new Map()), true);
    assert.deepEqual(O.checkEffect(m, 5, false, new Map(), new Map()), { fail: null, o1e: 'skip', o4: 'done' });   // s0 compared
    m.setValue(0, 9);                // a LIVE untainted input changed and the effect did not run
    assert.equal(O.checkEffect(m, 5, false, new Map(), new Map()).fail.sig, 'effect-dead');
    assert.deepEqual(O.checkEffect(m, 5, true, new Map(), new Map()), { fail: null, o1e: 'skip', o4: 'na' });
});

test('O4: a live effect whose body never ran fires (fail-closed); O5 charges its would-be links', () => {
    const m = world();
    m.addEffect(6, { k: 'sum', d: [0, 2], try: true }, -1);   // created, never ran (seen === null)
    const r = O.checkEffect(m, 6, false, new Map(), new Map());
    assert.deepEqual([r.fail.oracle, r.fail.sig, r.o4], ['O4', 'effect-dead', 'done']);
    assert.match(r.fail.detail, /never ran/);
    assert.equal(m.expectedLinks(new Map()), 8);              // 6 + the 2 sources its body would track
    assert.equal(O.checkCounts(m, stats({ effects: 3, activeNodes: 7, activeLinks: 6 }))[0].sig, 'link-count');
    m.kill(6);                                                // p3: a first run that threw disposes it -> exempt
    assert.deepEqual(O.checkEffect(m, 6, false, new Map(), new Map()), { fail: null, o1e: 'na', o4: 'na' });
});

test('performed vs skipped: an all-tainted world performs 0 effect checks', () => {
    const m = new Model(CAPS);
    m.addSignal(0, 1, { dis: true });
    m.addComputed(1, { k: 'sum', d: [0] });
    m.n[1].links = [0]; m.n[1].seen = [{ r: 0, v: 1 }];
    for (let e = 2; e < 6; e++) { m.addEffect(e, { k: 'identity', d: [1], try: true }, -1); m.n[e].links = [1]; m.n[e].seen = [{ r: 1, v: 1 }]; }
    m.kill(0);                                                // taints c1 and, through it, every effect
    let done = 0, skip = 0;
    for (let e = 2; e < 6; e++) {
        for (const ran of [false, true]) {
            const r = O.checkEffect(m, e, ran, new Map(), new Map());
            assert.equal(r.fail, null);
            for (const k of ['o1e', 'o4']) { if (r[k] === 'done') done++; if (r[k] === 'skip') skip++; }
        }
    }
    assert.equal(done, 0);
    assert.equal(skip, 12);                                   // 8 O1e skips + 4 O4 skips (ran=false)
});

test('O5: silent on matching counts and links; fires on each mismatch and on teardown residue', () => {
    const m = world();
    assert.equal(m.expectedLinks(), 6);
    assert.deepEqual(O.checkCounts(m, stats()), []);
    assert.equal(O.checkCounts(m, stats({ signals: 3, activeNodes: 7 }))[0].sig, 'kind-count');
    assert.ok(O.checkCounts(m, stats({ activeNodes: 5 })).some((f) => f.sig === 'node-count'));
    assert.equal(O.checkCounts(m, stats({ activeLinks: 7 }))[0].sig, 'link-count');
    assert.equal(O.checkCounts(m, stats({ activeLinks: 5 }))[0].sig, 'link-count');
    m.kill(1);                       // the link c3 -> s1 goes with s1 (p5)
    assert.deepEqual(O.checkCounts(m, stats({ signals: 1, activeNodes: 5, activeLinks: 5 })), []);
    assert.equal(O.checkTeardown({ nodes: 0, links: 0 }), null);
    assert.equal(O.checkTeardown({ nodes: 1, links: 0 }).sig, 'teardown-residue');
    assert.equal(O.checkTeardown(null).sig, 'teardown-residue');
});

test('O6: the escape set must equal the prediction', () => {
    const tok = (t) => ({ origin: t.split(':')[0], token: t });
    assert.deepEqual(O.checkEscape([], [], O.EXPECT_NONE), []);
    assert.deepEqual(O.checkEscape(['computed:4', 'computed:4'], [tok('computed:4'), tok('computed:4')], O.EXPECT_NONE), []);
    assert.equal(O.checkEscape([], [tok('computed:4')], O.EXPECT_NONE)[0].sig, 'escape-computed');               // F6
    assert.equal(O.checkEscape(['computed:4'], [tok('computed:4'), tok('computed:4')], O.EXPECT_NONE)[0].sig, 'escape-computed');
    assert.equal(O.checkEscape(['batch:3'], [], O.EXPECT_NONE)[0].sig, 'expected-escape-missing');
    assert.equal(O.checkEscape([], [{ ctor: 'TypeError', message: 'x' }], O.EXPECT_NONE)[0].sig, 'escape-TypeError');  // F15 / F8
    assert.deepEqual(O.checkEscape([], [{ ctor: 'Error', message: 'CycleError: flush passes exceeded' }], O.EXPECT_CYCLE), []);
    assert.equal(O.checkEscape([], [{ ctor: 'Error', message: 'CycleError: flush passes exceeded' }], O.EXPECT_NONE)[0].sig, 'escape-CycleError');
    assert.equal(O.checkEscape([], [], O.EXPECT_CYCLE)[0].sig, 'expected-escape-missing');
});

test('O7a: a live registration on a live target may fire; off() or a dead target may not', () => {
    const m = world();
    m.addReg(0, 1);
    m.addReg(1, 0);
    assert.equal(O.checkFire(m, 0, 'onConnect'), null);
    m.n[1].live = false; m.n[1].dying = true;                // mid-dispose: still allowed
    assert.equal(O.checkFire(m, 0, 'onDisconnect'), null);
    m.n[1].dying = false;
    assert.equal(O.checkFire(m, 0, 'onConnect').sig, 'dead-registration-fire');   // F7 (recycled slot)
    m.offReg(1);
    assert.equal(O.checkFire(m, 1, 'onConnect').sig, 'dead-registration-fire');
});

test('normalizeEscape: an AggregateError with no errors is one leaf, never zero', () => {
    assert.deepEqual(normalizeEscape(new AggregateError([], 'empty')), [{ ctor: 'AggregateError', message: 'empty' }]);
    const two = normalizeEscape(new AggregateError([new SoakThrow('computed', 1), new TypeError('x')], 'two'));
    assert.deepEqual(two, [{ origin: 'computed', token: 'computed:1' }, { ctor: 'TypeError', message: 'x' }]);
});

/* -- 3. model rules (TASK 0d) ---------------------------------------------------------------------------- */

test('model: owner rule kills children recursively; a disposed handle reads undefined; taint clears on a fresh run', () => {
    const m = new Model(CAPS);
    m.addSignal(0, 1, {});
    m.addEffect(1, { k: 'sum', d: [0] }, -1);
    m.addEffect(2, { k: 'child' }, 1);
    m.addEffect(3, { k: 'child' }, 2);
    assert.deepEqual(m.killChildren(1).sort(), [2, 3]);       // p1
    assert.equal(m.counts().effects, 1);
    m.n[1].links = [0]; m.n[1].seen = [{ r: 0, v: 1 }];
    m.kill(0);                                                // p5 + p8
    assert.equal(m.val(0, new Map()), undefined);
    assert.equal(m.tainted(1, new Map()), true);
    m.n[1].taint = false; m.n[1].seen = [{ r: 0, v: undefined }];   // a run entirely after the disposal
    assert.equal(m.tainted(1, new Map()), false);
    assert.equal(m.expectedLinks(new Map()), 0);
});

/* -- 4. G0 determinism ---------------------------------------------------------------------------------- */

test('G0: the script is a pure function of (lane, seed); distinct seeds differ', () => {
    assert.deepEqual(ROSTER, ['GRAPH', 'BATCH', 'ERROR', 'NEST', 'WIE', 'HOOK', 'LIFECYCLE']);
    for (const d of LANES) {
        for (const seed of [1, 0x9e3779b9, 0xdeadbeef]) {
            const a = scriptJson(generateWorld(d, seed, { steps: 120 }));
            const b = scriptJson(generateWorld(d, seed, { steps: 120 }));
            assert.equal(a, b, d.name + ' seed ' + seed);
        }
        assert.notEqual(scriptJson(generateWorld(d, 1, { steps: 120 })), scriptJson(generateWorld(d, 2, { steps: 120 })));
    }
});

/* -- 5. exec in-process on the frozen headpatched fixture (mutant adapters) ------------------------------ */

const HEADPATCHED_DIR = join(SOAK, 'controls', 'headpatched');
process.env.SOAK_KERNEL = join(HEADPATCHED_DIR, 'Signal.js');   // read once by kernel.mjs at its first import
const { liteAdapter } = await import('../bench/soak/adapters/lite.mjs');
const { runWorld } = await import('../bench/soak/exec.mjs');
const { laneByName } = await import('../bench/soak/lanes/index.mjs');

function mutant(patch) {
    return Object.assign({}, liteAdapter, { open(o) { const w = liteAdapter.open(o); return Object.assign({}, w, patch(w)); } });
}
const sigsOf = (r) => (r.failure === null ? [] : r.failure.fails.map((f) => f.oracle + ':' + f.sig));

test('mutant: an engine that never runs every 5th effect body is caught (O4 never ran)', () => {
    const empty = mutant((w) => { let n = 0; return { effect: (fn) => w.effect(++n % 5 === 0 ? () => {} : fn) }; });
    const seen = new Set();
    for (const lane of ['GRAPH', 'BATCH']) {
        let failing = 0;
        for (let s = 1; s <= 20; s++) {
            const script = generateWorld(laneByName(lane), s, { steps: 60 });
            assert.equal(runWorld(liteAdapter, script).failure, null, lane + ' seed ' + s + ' must pass unmutated');
            const r = runWorld(empty, script);
            if (r.failure !== null) failing++;
            for (const x of sigsOf(r)) seen.add(x);
        }
        assert.equal(failing, 20, lane);
    }
    assert.ok(seen.has('O4:effect-dead'), [...seen].join(','));
});

test('mutant: an escape that normalizes to zero leaves fails O6 escape-empty', () => {
    const script = { genVersion: 1, lane: 'GRAPH', seed: 1, large: false, covOff: null, flushPasses: null,
        ops: [{ o: 'sig', i: 0, v: 1 }, { o: 'set', i: 0, v: 2 }] };
    assert.equal(runWorld(liteAdapter, script).failure, null);
    const bad = mutant((w) => ({ set: () => { throw new AggregateError([], 'empty'); }, normalizeEscape: () => [] }));
    assert.deepEqual(sigsOf(runWorld(bad, script)), ['O6:escape-empty']);
});

test('O6 batch rule: the batch token is always predicted; a close-flush error that replaces it fails (F22)', () => {
    const base = [{ o: 'sig', i: 0, v: 0 }, { o: 'comp', i: 1, spec: { k: 'identity', d: [0], thr: true } }];
    const eff = { o: 'eff', i: 2, spec: { k: 'sum', d: [1] } };   // naked: rethrows computed:1
    const thr = { o: 'batch', body: [{ o: 'set', i: 0, v: 8 }], thr: 1 };   // 8 % 5 = 3 -> c1 throws
    const mk = (ops) => ({ genVersion: 1, lane: 'ERROR', seed: 1, large: false, covOff: null, flushPasses: null, ops });
    // the lost-error world: batch(() => { set; throw BATCH }) and the close-flush effect throws -> only
    // computed:1 escapes on every current kernel; the batch token is LOST
    const lost = runWorld(liteAdapter, mk(base.concat([eff, thr])));
    assert.notEqual(lost.failure, null, 'a lost batch error must fail O6');
    assert.deepEqual(sigsOf(lost), ['O6:expected-escape-missing']);
    assert.match(lost.failure.fails[0].detail, /batch:/);
    assert.deepEqual(lost.gateHits, { batchTokenEscaped: 0 });
    // no throwing effect: the token escapes, as predicted
    const escaped = runWorld(liteAdapter, mk(base.concat([thr])));
    assert.equal(escaped.failure, null, JSON.stringify(escaped.failure));
    assert.deepEqual(escaped.gateHits, { batchTokenEscaped: 1 });
});

test('never-ran effect: O4 owns it, O5 skips it in the same pass and the record says alsoImplies O5', () => {
    const lazy = mutant((w) => { let n = 0; return { effect: (fn) => w.effect(++n % 5 === 0 ? () => {} : fn) }; });
    const script = generateWorld(laneByName('BATCH'), 3, { steps: 60 });
    const r = runWorld(lazy, script);
    assert.notEqual(r.failure, null);
    const o4 = r.failure.fails.find((f) => f.oracle === 'O4');
    assert.ok(o4 && /never ran/.test(o4.detail), JSON.stringify(r.failure));
    assert.deepEqual(o4.alsoImplies, ['O5']);
    assert.ok(!r.failure.fails.some((f) => f.oracle === 'O5' && f.sig === 'link-count'), JSON.stringify(r.failure));
    const m = world();
    m.addEffect(6, { k: 'sum', d: [0, 2], try: true }, -1);
    assert.deepEqual(O.checkCounts(m, stats({ effects: 3, activeNodes: 7 }), new Set([6])), []);
});

/* -- 6. end to end through exec (child processes) -------------------------------------------------------- */

const REV152 = join(ROOT, 'node_modules', 'lite-signal-1.5.2');
const HEADPATCHED = join(SOAK, 'controls', 'headpatched');

function dev(args) {
    const env = {};
    for (const k of Object.keys(process.env)) if (k.indexOf('SOAK_') !== 0 && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    const r = spawnSync(process.execPath, ['--expose-gc', join(SOAK, '_dev-run.mjs')].concat(args), { encoding: 'utf8', timeout: 120000, env });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('e2e: BATCH fires F5 on 1.5.2 and is silent on headpatched', () => {
    assert.ok(existsSync(join(REV152, 'Signal.js')), 'the exact 1.5.2 alias devDependency must be installed');
    const bad = dev([REV152, 'BATCH', '40']);
    assert.equal(bad.status, 1, bad.out);
    assert.match(bad.out, /FAIL .*(O1c:computed-mismatch|O1e:effect-stale).*revert-after-mid-read/);
    const good = dev([HEADPATCHED, 'BATCH', '40']);
    assert.equal(good.status, 0, good.out);
    assert.match(good.out, /failingWorlds=0 crashes=0/);
    assert.match(good.out, /missing required: none/);
});

test('e2e: NEST fires F15 on headpatched; its trigger-less twin is silent', () => {
    const bad = dev([HEADPATCHED, 'NEST', '40']);
    assert.equal(bad.status, 1, bad.out);
    assert.match(bad.out, /FAIL .*O6:escape-TypeError .*saved-cursor-hazard/);
    const quiet = dev([HEADPATCHED, 'NEST', '40', '0xC0FFEE', 'cov-off:saved-cursor-hazard']);
    assert.equal(quiet.status, 0, quiet.out);
    assert.match(quiet.out, /failingWorlds=0 crashes=0/);
    assert.match(quiet.out, /\n\s+0  saved-cursor-hazard/);
});

/* -- 7. QA boundary matrix (S1a + S1b QA, 2026-10-11) ----------------------------------------------------------
 * Added by qa, oracle-independent of the coder: every case below was shown to FAIL on a hand-made mutant of
 * the code it guards (scratch copy, never the live tree). The mutant is named in each test's comment.
 */

const qfs = await import('node:fs');
const qos = await import('node:os');
const { pathToFileURL: qToUrl } = await import('node:url');
const { createHash: qHash } = await import('node:crypto');
const vm = await import('node:vm');
const { MAX_DEPTH } = await import('../bench/soak/gen.mjs');
const qScript = (ops, lane) => ({ genVersion: 1, lane: lane || 'GRAPH', seed: 1, large: false, covOff: null, flushPasses: null, ops });
const ZERO_CHECKS = { O1c: 0, O1e: 0, O2: 0, O4: 0, O5: 0, O6: 0, O7a: 0, O7: 0, OB: 0, O8: 0 };
const ZERO_SKIPS = { O1c: 0, O1e: 0, O2: 0, O4: 0 };

// mutants (kinds.mjs normalizeEscape): `e.errors.length > 0` -> `> 1` (a one-leaf AggregateError stays
// wrapped, so its token is never matched); the `depth < 8` cap removed (a self-containing AggregateError
// recurses until RangeError)
test('qa normalizeEscape: AggregateError with 0 / 1 / 2 / 3 nested leaves, the depth cap, a cycle, null, undefined, a foreign realm', () => {
    const t = (n) => new SoakThrow('effect', n);
    const leaf = (n) => ({ origin: 'effect', token: 'effect:' + n });
    assert.deepEqual(normalizeEscape(new AggregateError([], 'e0')), [{ ctor: 'AggregateError', message: 'e0' }]);
    assert.deepEqual(normalizeEscape(new AggregateError([t(1)], 'e1')), [leaf(1)], 'one leaf is unwrapped');
    assert.deepEqual(normalizeEscape(new AggregateError([t(1), t(2)], 'e2')), [leaf(1), leaf(2)], 'order kept');
    assert.deepEqual(normalizeEscape(new AggregateError([t(1), new AggregateError([t(2), t(3)])])), [leaf(1), leaf(2), leaf(3)]);
    assert.deepEqual(normalizeEscape(t(4)), [leaf(4)]);
    // the predicted single token matches through a one-leaf AggregateError; an empty one is an engine escape
    assert.deepEqual(O.checkEscape(['effect:1'], normalizeEscape(new AggregateError([t(1)])), O.EXPECT_NONE), []);
    assert.equal(O.checkEscape([], normalizeEscape(new AggregateError([])), O.EXPECT_NONE)[0].sig, 'escape-AggregateError');
    // depth: 8 wrappers unwrap, the 9th level is reported as a leaf (fail closed: an unexpected escape)
    let e8 = t(9); for (let i = 0; i < 8; i++) e8 = new AggregateError([e8], 'L' + i);
    assert.deepEqual(normalizeEscape(e8), [leaf(9)]);
    let e9 = t(9); for (let i = 0; i < 9; i++) e9 = new AggregateError([e9], 'L' + i);
    assert.deepEqual(normalizeEscape(e9), [{ ctor: 'AggregateError', message: 'L0' }]);
    // adversarial: an AggregateError that contains itself terminates
    const self = new AggregateError([t(5)], 'self');
    self.errors.push(self);
    const out = normalizeEscape(self);
    assert.ok(out.length >= 2 && out.length <= 2 ** 9, 'bounded: ' + out.length);
    assert.deepEqual(out[0], leaf(5));
    assert.deepEqual(normalizeEscape(null), [{ ctor: 'object', message: 'null' }]);
    assert.deepEqual(normalizeEscape(undefined), [{ ctor: 'undefined', message: 'undefined' }]);
    const odd = new AggregateError([t(6)], 'odd');
    odd.errors = 'not an array';
    assert.deepEqual(normalizeEscape(odd), [{ ctor: 'AggregateError', message: 'odd' }]);
    // another realm's AggregateError is not unwrapped: it surfaces as an engine escape, never as silence
    const foreign = vm.runInNewContext('new AggregateError([1, 2], "x")');
    assert.deepEqual(normalizeEscape(foreign), [{ ctor: 'AggregateError', message: 'x' }]);
});

// mutants (exec.mjs): readCheck counting did('O1c') BEFORE the taint test (a skipped check counted as
// performed); atRest `else if (r[o] === 'skip')` -> `else` ('na' counted as a taint skip)
test('qa counters at 0: empty world, single signal / effect / computed, and the taint skip, exact per oracle', () => {
    const empty = runWorld(liteAdapter, qScript([]));
    assert.equal(empty.failure, null);
    assert.equal(empty.ops, 0);
    assert.deepEqual(empty.checks, Object.assign({}, ZERO_CHECKS, { O5: 1 }), 'only the teardown O5 (7b F4)');
    assert.deepEqual(empty.skipTainted, ZERO_SKIPS);
    assert.deepEqual(Object.keys(empty.scen), [], 'no scenario counted');
    const one = (ops) => runWorld(liteAdapter, qScript(ops));
    const sig = one([{ o: 'sig', i: 0, v: 1 }]);
    assert.equal(sig.failure, null);
    assert.deepEqual(sig.checks, Object.assign({}, ZERO_CHECKS, { O5: 2, O6: 1 }));   // O5: at rest + teardown (7b F4)
    assert.deepEqual(sig.skipTainted, ZERO_SKIPS);
    const eff = one([{ o: 'eff', i: 0, spec: { k: 'child' } }]);
    assert.equal(eff.failure, null);
    assert.deepEqual(eff.checks, Object.assign({}, ZERO_CHECKS, { O1e: 1, O5: 2, O6: 1 }));   // O5: at rest + teardown (7b F4)
    assert.deepEqual(eff.skipTainted, ZERO_SKIPS, 'an effect that ran this op is O4 n/a, not a taint skip');
    const comp = one([{ o: 'comp', i: 0, spec: { k: 'sum', d: [] } }, { o: 'read', is: [0] }]);
    assert.equal(comp.failure, null);
    assert.equal(comp.checks.O1c, 2, 'the read op + the world-end check');
    assert.deepEqual(comp.skipTainted, ZERO_SKIPS);
    // taint: c1 read s0, s0 disposed -> every later O1c on c1 is a SKIP (3 reads + the world-end check)
    const taint = one([{ o: 'sig', i: 0, v: 1, dis: 1 }, { o: 'comp', i: 1, spec: { k: 'sum', d: [0] } }, { o: 'read', is: [1] },
        { o: 'disp', i: 0 }, { o: 'read', is: [1] }, { o: 'read', is: [1] }, { o: 'read', is: [1] }]);
    assert.equal(taint.failure, null);
    assert.equal(taint.checks.O1c, 1, 'only the read before the disposal is performed');
    assert.deepEqual(taint.skipTainted, Object.assign({}, ZERO_SKIPS, { O1c: 4 }));
});

// mutants (exec.mjs): did() / skipped() without the `< COUNTER_CAP` guard. The counters START just below
// the cap (0x3FFFFFFF, SPEC-B addendum 7) so the run crosses it for real; a counter that starts at 0 never
// would. Exec is reached through a scratch copy of exec.mjs whose only change is an appended export.
test('qa counters near the cap: checks and taint skips saturate at 0x3FFFFFFF (Smi on 31-bit V8), never past it', async () => {
    const SOAK_URL = qToUrl(SOAK).href + '/';
    const src = qfs.readFileSync(join(SOAK, 'exec.mjs'), 'utf8')
        .replace(/from '\.\.\//g, "from '" + SOAK_URL + '../').replace(/from '\.\//g, "from '" + SOAK_URL);
    assert.equal(/from '\./.test(src), false, 'every relative import rewritten');
    const dir = qfs.mkdtempSync(join(qos.tmpdir(), 'soak-qa-exec-'));
    try {
        const file = join(dir, 'exec-qa.mjs');
        qfs.writeFileSync(file, src + '\nexport { Exec as __QaExec };\n');
        const { __QaExec } = await import(qToUrl(file).href);
        const CAP = 0x3FFFFFFF;
        const script = qScript([{ o: 'sig', i: 0, v: 1, dis: 1 }, { o: 'comp', i: 1, spec: { k: 'sum', d: [0] } }, { o: 'read', is: [1] },
            { o: 'disp', i: 0 }, { o: 'read', is: [1] }, { o: 'read', is: [1] }, { o: 'read', is: [1] }]);
        const ref = runWorld(liteAdapter, script);   // the per-world increments, from the shipped module
        const x = new __QaExec(liteAdapter, script, {});
        for (const k of Object.keys(x.checks)) x.checks[k] = CAP - 2;
        for (const k of Object.keys(x.skipTainted)) x.skipTainted[k] = CAP - 2;
        const r = x.run();
        assert.equal(r.failure, null);
        for (const [got, inc] of [[r.checks, ref.checks], [r.skipTainted, ref.skipTainted]]) {
            for (const k of Object.keys(got)) {
                assert.equal(got[k], Math.min(CAP, CAP - 2 + inc[k]), k + ' (+' + inc[k] + ')');
                assert.ok(got[k] <= CAP, k + ' left the 31-bit Smi range: ' + got[k]);
            }
        }
        assert.ok(ref.checks.O5 >= 3 && ref.skipTainted.O1c >= 3, 'the run really crosses the cap on O5 and the O1c skip');
    } finally {
        qfs.rmSync(dir, { recursive: true, force: true });
    }
});

// mutant (lanes/graph.mjs:65): the large-world chain built 201 deep (G5 is enforced only by this literal; gen.mjs
// exports MAX_DEPTH but never checks it)
test('qa G5 max depth: large GRAPH worlds reach exactly MAX_DEPTH and never exceed it; one such world runs clean', () => {
    assert.equal(MAX_DEPTH, 200);
    const depthOfScript = (script) => {
        const depth = new Map();
        let mx = 0;
        const walk = (op) => {
            if (op.o === 'comp') {
                const sp = op.spec;
                const refs = sp.k === 'select' ? [sp.s].concat(sp.d)
                    : sp.k === 'outer' ? [sp.t].concat(sp.pre, sp.ic === null ? [] : [sp.ic], sp.post)
                        : sp.k === 'inner' ? (sp.ic2 === null ? [] : [sp.ic2]).concat([sp.t], sp.x === null ? [] : [sp.x])
                            : sp.k === 'child' ? [] : sp.d;
                let m = 0;
                for (const r of refs) m = Math.max(m, depth.get(r) || 0);
                depth.set(op.i, m + 1);
                mx = Math.max(mx, m + 1);
            }
            if (Array.isArray(op.ops)) op.ops.forEach(walk);
            if (Array.isArray(op.body)) op.body.forEach(walk);
        };
        script.ops.forEach(walk);
        return mx;
    };
    let reached = 0;
    for (let s = 1; s <= 6; s++) {
        const d = depthOfScript(generateWorld(laneByName('GRAPH'), s, { large: true }));
        assert.ok(d <= MAX_DEPTH, 'GRAPH large seed ' + s + ' depth ' + d);
        if (d === MAX_DEPTH) reached++;
    }
    assert.equal(reached, 6, 'every large GRAPH world builds the full-depth chain (N, not N-1)');
    for (const lane of ROSTER) {
        for (let s = 1; s <= 20; s++) assert.ok(depthOfScript(generateWorld(laneByName(lane), s)) <= MAX_DEPTH, lane + ' seed ' + s);
    }
    const big = generateWorld(laneByName('GRAPH'), 7, { large: true });
    assert.equal(depthOfScript(big), MAX_DEPTH);
    const r = runWorld(liteAdapter, big);
    assert.equal(r.failure, null, JSON.stringify(r.failure));
    assert.ok(r.checks.O1c > 0 && r.checks.O5 > 0);
});

// mutants (exec.mjs): the round-2 allowance restored in guard() -- `if (g.batchTok !== null && g.thrown.length
// === 0) pred.push(g.batchTok)` (a lost batch error passes when an effect error escaped instead); runBatch not
// setting g.batchTok (the batch token escapes unpredicted)
test('qa nested batch: a batch inside a batch that throws -- token predicted and escaped; lost token (F22 shape) still fails', () => {
    const base = [{ o: 'sig', i: 0, v: 0 }, { o: 'sig', i: 1, v: 0 }, { o: 'eff', i: 2, spec: { k: 'sum', d: [0, 1] } }];
    const outerThrows = runWorld(liteAdapter, qScript(base.concat([{ o: 'batch', thr: 1, body: [{ o: 'set', i: 0, v: 4 },
        { o: 'batch', body: [{ o: 'set', i: 1, v: 6 }, { o: 'read', is: [0, 1] }] }] }]), 'BATCH'));
    assert.equal(outerThrows.failure, null, JSON.stringify(outerThrows.failure));
    assert.deepEqual(outerThrows.gateHits, { batchTokenEscaped: 1 });
    const deep = runWorld(liteAdapter, qScript(base.concat([{ o: 'batch', body: [{ o: 'batch', body: [{ o: 'batch', body: [{ o: 'set', i: 1, v: 7 }] }] }] }]), 'BATCH'));
    assert.equal(deep.failure, null, JSON.stringify(deep.failure));
    assert.deepEqual(deep.gateHits, { batchTokenEscaped: 0 });
    // the write that makes c1 throw sits in the INNER batch; the outer batch throws; the close flush throws
    // computed:1 through the naked effect, and every current kernel loses the batch token (F22)
    const lost = runWorld(liteAdapter, qScript([{ o: 'sig', i: 0, v: 0 }, { o: 'comp', i: 1, spec: { k: 'identity', d: [0], thr: true } },
        { o: 'eff', i: 2, spec: { k: 'sum', d: [1] } }, { o: 'batch', thr: 1, body: [{ o: 'batch', body: [{ o: 'set', i: 0, v: 8 }] }] }], 'ERROR'));
    assert.deepEqual(sigsOf(lost), ['O6:expected-escape-missing']);
    assert.match(lost.failure.fails[0].detail, /batch:/);
});

// mutant (gen.mjs Gen constructor): `this.seed = (seed ^ process.pid) >>> 0` -- deterministic inside one process,
// different in the next; and `mulberry32(this.seed & 0xFFFF)` (distinct seeds collide)
test('qa determinism (SPEC-B 14.8): 1,000 seeds per lane hash identically in a second process; every seed distinct', () => {
    const seeds = [];
    for (let s = 0; s < 995; s++) seeds.push(s);
    seeds.push(2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 2, 2 ** 32 - 1);
    assert.equal(seeds.length, 1000);
    const GEN_URL = qToUrl(join(SOAK, 'gen.mjs')).href;
    const LANES_URL = qToUrl(join(SOAK, 'lanes', 'index.mjs')).href;
    const digestSrc = `
const { generateWorld, scriptJson } = await import(${JSON.stringify(GEN_URL)});
const { LANES } = await import(${JSON.stringify(LANES_URL)});
const { createHash } = await import('node:crypto');
const seeds = ${JSON.stringify(seeds)};
const out = {};
for (const d of LANES) {
    const all = createHash('sha256');
    const per = new Set();
    for (const s of seeds) {
        const sc = generateWorld(d, s);
        all.update(scriptJson(sc));
        per.add(createHash('sha256').update(JSON.stringify(sc.ops)).digest('hex'));
    }
    out[d.name] = { all: all.digest('hex'), distinct: per.size };
}
process.stdout.write(JSON.stringify(out));
`;
    const runChild = () => {
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', digestSrc], { encoding: 'utf8', timeout: 120000 });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
    };
    const a = runChild();
    // this process is the second one
    const b = {};
    for (const d of LANES) {
        const all = qHash('sha256');
        const per = new Set();
        for (const s of seeds) {
            const sc = generateWorld(d, s);
            assert.equal(sc.seed, s >>> 0);
            all.update(scriptJson(sc));
            // distinctness on the OPS alone: the script also carries its seed, which would make any two differ
            per.add(qHash('sha256').update(JSON.stringify(sc.ops)).digest('hex'));
        }
        b[d.name] = { all: all.digest('hex'), distinct: per.size };
    }
    assert.deepEqual(Object.keys(a), ROSTER);
    for (const lane of ROSTER) {
        assert.equal(a[lane].all, b[lane].all, lane + ': the op-script digest differs across processes');
        assert.equal(b[lane].distinct, 1000, lane + ': distinct seeds must give distinct op lists');
    }
});

/* -- 7b S1ab-fix: QA burst 3 findings 1, 2, 3, 4, 6, 7 (each red on the pre-fix module) ----------------- */

test('7b F1 normalizeEscape never throws: null prototype, throwing getters, toPrimitive, revoked Proxy, bad errors getter', () => {
    const U = '<unprintable>';
    // unchanged paths
    assert.deepEqual(normalizeEscape(null), [{ ctor: 'object', message: 'null' }]);
    assert.deepEqual(normalizeEscape(undefined), [{ ctor: 'undefined', message: 'undefined' }]);
    assert.deepEqual(normalizeEscape(new RangeError('r')), [{ ctor: 'RangeError', message: 'r' }]);
    assert.deepEqual(normalizeEscape(7), [{ ctor: 'Number', message: '7' }]);
    // null prototype: no constructor to name -> typeof; no toString -> UNPRINTABLE
    assert.deepEqual(normalizeEscape(Object.create(null)), [{ ctor: 'object', message: U }]);
    const np = Object.create(null); np.message = 'm';
    assert.deepEqual(normalizeEscape(np), [{ ctor: 'object', message: 'm' }]);
    // throwing getters
    const gm = { get message() { throw new Error('boom'); } };
    assert.deepEqual(normalizeEscape(gm), [{ ctor: 'Object', message: U }]);
    const gc = { get constructor() { throw new Error('boom'); }, message: 'x' };
    assert.deepEqual(normalizeEscape(gc), [{ ctor: 'object', message: 'x' }]);
    const gn = { constructor: { get name() { throw new Error('boom'); } }, message: 'y' };
    assert.deepEqual(normalizeEscape(gn), [{ ctor: 'object', message: 'y' }]);
    const tp = { [Symbol.toPrimitive]() { throw new Error('boom'); } };
    assert.deepEqual(normalizeEscape(tp), [{ ctor: 'Object', message: U }]);
    const mp = { message: { toString() { throw new Error('boom'); } } };
    assert.deepEqual(normalizeEscape(mp), [{ ctor: 'Object', message: U }]);
    // revoked Proxy: instanceof itself throws -> one leaf
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    assert.deepEqual(normalizeEscape(proxy), [{ ctor: 'object', message: U }]);
    // AggregateError whose errors getter throws -> one leaf, no partial leaves
    const ae = new AggregateError([new SoakThrow('effect', 1)], 'agg');
    Object.defineProperty(ae, 'errors', { get() { throw new Error('boom'); } });
    assert.deepEqual(normalizeEscape(ae), [{ ctor: 'object', message: U }]);
    // a nested bad leaf degrades only itself
    const ok = new AggregateError([new SoakThrow('effect', 2), Object.create(null)], 'agg');
    assert.deepEqual(normalizeEscape(ok), [{ origin: 'effect', token: 'effect:2' }, { ctor: 'object', message: U }]);
    for (const leaf of [normalizeEscape(proxy)[0], normalizeEscape(Object.create(null))[0]]) assert.equal(O.escapeSig(leaf), 'escape-object');
});

test('7b F2 generateWorld steps: undefined -> 400, 0 -> zero steps, NaN / negative / fractional / null throw RangeError', () => {
    const d = laneByName('GRAPH');
    assert.equal(scriptJson(generateWorld(d, 5)), scriptJson(generateWorld(d, 5, { steps: 400 })));
    assert.equal(scriptJson(generateWorld(d, 5, {})), scriptJson(generateWorld(d, 5, { steps: undefined })));
    const zero = generateWorld(d, 5, { steps: 0 });
    const full = generateWorld(d, 5, { steps: 400 });
    assert.ok(zero.ops.length < full.ops.length, 'steps 0 ran ' + zero.ops.length + ' ops, 400 steps ran ' + full.ops.length);
    // steps 0 is the init prefix of every longer script
    assert.deepEqual(full.ops.slice(0, zero.ops.length), zero.ops);
    for (const bad of [NaN, -1, 1.5, null, '5', Infinity]) {
        assert.throws(() => generateWorld(d, 5, { steps: bad }), RangeError, 'steps ' + String(bad));
    }
});

test('7b F3 GRAPH large chain length comes from gen.mjs MAX_DEPTH (single source of truth, no literal)', () => {
    const src = readFileSync(join(SOAK, 'lanes', 'graph.mjs'), 'utf8');
    assert.match(src, /import \{[^}]*\bMAX_DEPTH\b[^}]*\} from '\.\.\/gen\.mjs';/);
    const code = stripCommentsAndStrings(src);
    assert.equal(/\b200\b/.test(code), false, 'a literal 200 is left in graph.mjs code');
    assert.match(code, /g\.large \? MAX_DEPTH :/);
});

test('7b F4 the teardown residue check is counted in checks.O5 (one per world, on top of the at-rest O5)', () => {
    assert.equal(liteAdapter.caps.links, 'stats', 'the at-rest O5 runs once per op on this adapter');
    const ops = [{ o: 'sig', i: 0, v: 1, dis: 1 }, { o: 'comp', i: 1, spec: { k: 'sum', d: [0] } }, { o: 'read', is: [1] }];
    const r = runWorld(liteAdapter, qScript(ops));
    assert.equal(r.failure, null);
    assert.equal(r.checks.O5, ops.length + 1, 'at-rest O5 per op (' + ops.length + ') + 1 teardown');
    const empty = runWorld(liteAdapter, qScript([]));
    assert.equal(empty.failure, null);
    assert.equal(empty.checks.O5, 1, 'a world with no ops still performs the teardown O5');
});

// F6 (PLAN-F5-F6 task 10, option b): gitInfo scrubs the five repo-LOCATING vars from its child env at CALL time.
// W = a clean throwaway repository, Y = a second one, DIRTY, with a different SHA. One row per scrubbed key points
// that ONE key at Y's matching location; gitInfo(W) must not move. The rows iterate a list of their own, never
// GIT_SCRUB_ENV, so dropping a key from the scrub turns exactly that row red.
// mutants: drop one key from GIT_SCRUB_ENV (5 rows, one each); the HEAD provenance.mjs (no scrub, no root seam)
test('7b F6 gitInfo ignores GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_COMMON_DIR / GIT_OBJECT_DIRECTORY: it reports the tree it was asked for', async (t) => {
    const { gitInfo, GIT_SCRUB_ENV } = await import('../bench/soak/provenance.mjs');
    const KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];
    const tmp = qfs.mkdtempSync(join(qos.tmpdir(), 'soak-qa-f6-'));
    // every git this test spawns: no inherited GIT_* var, no global or system config, a fixed identity
    const genv = {};
    for (const k of Object.keys(process.env)) if (k.indexOf('GIT_') !== 0) genv[k] = process.env[k];
    Object.assign(genv, { GIT_CONFIG_GLOBAL: join(tmp, 'no-global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'soak-qa', GIT_AUTHOR_EMAIL: 'soak-qa@invalid', GIT_COMMITTER_NAME: 'soak-qa', GIT_COMMITTER_EMAIL: 'soak-qa@invalid' });
    const git = (cwd, args) => {
        const r = spawnSync('git', args, { cwd, env: genv, encoding: 'utf8' });
        assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
        return r.stdout.trim();
    };
    const repo = (name, body) => {
        const dir = join(tmp, name);
        qfs.mkdirSync(dir);
        git(dir, ['init', '-q', '--initial-branch=soakqa']);
        qfs.writeFileSync(join(dir, 'a.mjs'), body);
        git(dir, ['update-index', '--add', 'a.mjs']);
        const commit = git(dir, ['commit-tree', '--no-gpg-sign', '-m', name, git(dir, ['write-tree'])]);
        git(dir, ['update-ref', 'refs/heads/soakqa', commit]);
        return { dir, sha: commit };
    };
    // the env gitInfo inherits for this test: process.env minus GIT_*, no global or system config
    const saved = {};
    const own = Object.keys(process.env).filter((k) => k.indexOf('GIT_') === 0).concat(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'], KEYS);
    for (const k of own) saved[k] = process.env[k];
    const restore = () => { for (const k of own) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
    try {
        for (const k of own) delete process.env[k];
        process.env.GIT_CONFIG_GLOBAL = genv.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_NOSYSTEM = '1';
        const W = repo('W', 'export const w = 1;\n');
        const Y = repo('Y', 'export const y = 2;\n');
        qfs.writeFileSync(join(Y.dir, 'a.mjs'), 'export const y = 3;\n');   // Y: tracked change + untracked file
        qfs.writeFileSync(join(Y.dir, 'b.mjs'), 'export const b = 1;\n');
        assert.notEqual(W.sha, Y.sha);
        assert.notEqual(git(Y.dir, ['status', '--porcelain']), '', 'control: Y is dirty');
        const AT = { GIT_DIR: join(Y.dir, '.git'), GIT_WORK_TREE: Y.dir, GIT_INDEX_FILE: join(Y.dir, '.git', 'index'),
            GIT_COMMON_DIR: join(Y.dir, '.git'), GIT_OBJECT_DIRECTORY: join(Y.dir, '.git', 'objects') };

        await t.test('GIT_SCRUB_ENV is frozen and is exactly the five repo-locating keys', () => {
            assert.equal(Object.isFrozen(GIT_SCRUB_ENV), true);
            assert.deepEqual(GIT_SCRUB_ENV.slice(), KEYS);
        });
        const base = gitInfo(W.dir);
        await t.test('base: gitInfo(W) is W, clean', () => {
            assert.deepEqual(base, { sha: W.sha, dirty: false, error: null });
            assert.deepEqual(gitInfo(Y.dir), { sha: Y.sha, dirty: true, error: null }, 'control: the seam reads Y as Y');
        });
        for (const k of KEYS) {
            await t.test(k + ' pointed at Y: gitInfo(W) does not move', () => {
                process.env[k] = AT[k];
                try {
                    assert.deepEqual(gitInfo(W.dir), base, k + '=' + AT[k] + ' made gitInfo(W) describe another tree');
                    assert.equal(process.env[k], AT[k], 'the scrub must not mutate the caller\'s env');
                } finally { delete process.env[k]; }
            });
        }
        // The way an inherited var really arrives: ALREADY in the env when provenance.mjs loads (a module-load
        // snapshot of process.env would pass the rows above and fail open here).
        const PROV = new URL('../bench/soak/provenance.mjs', import.meta.url).href;
        for (const k of KEYS) {
            await t.test(k + ' pointed at Y before provenance.mjs loads (child process): gitInfo(W) does not move', () => {
                const r = spawnSync(process.execPath, ['--input-type=module', '-e',
                    'const { gitInfo } = await import(' + JSON.stringify(PROV) + '); process.stdout.write(JSON.stringify(gitInfo(' + JSON.stringify(W.dir) + ')));'],
                { cwd: ROOT, env: { ...genv, [k]: AT[k] }, encoding: 'utf8' });
                assert.equal(r.status, 0, r.stderr);
                assert.deepEqual(JSON.parse(r.stdout), base, k + '=' + AT[k] + ' inherited at load made gitInfo(W) describe another tree');
            });
        }
        await t.test('default root: with every key pointed at Y, gitInfo() reports THIS repository', (st) => {
            const want = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', env: genv });
            if (want.status !== 0) { st.skip('no git repository at ROOT: nothing to relocate'); return; }
            for (const k of KEYS) process.env[k] = AT[k];
            try {
                const g = gitInfo();
                assert.equal(g.sha, want.stdout.trim(), 'gitInfo described another tree: ' + JSON.stringify(g));
                assert.equal(g.error, null);
            } finally { for (const k of KEYS) delete process.env[k]; }
        });
    } finally {
        restore();
        qfs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('7b F7 writeRecord refuses a second summary record, before any write', async () => {
    const { openStream, writeRecord } = await import('../bench/soak/jsonl.mjs');
    const dir = qfs.mkdtempSync(join(qos.tmpdir(), 'soak-qa-jsonl-'));
    try {
        const path = join(dir, 's.jsonl');
        const st = openStream(path, performance.now(), 'burn-in');
        writeRecord(st, 'header', {});
        writeRecord(st, 'summary', { verdict: 'PASS' });
        assert.throws(() => writeRecord(st, 'summary', { verdict: 'FAIL' }), /second summary/);
        assert.equal(st.seq, 2);
        const lines = qfs.readFileSync(path, 'utf8').trim().split('\n');
        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[1]).verdict, 'PASS');
        writeRecord(st, 'fatal', {});   // a fatal after the summary stays writable (installFatalHandlers relies on it)
        assert.equal(st.seq, 3);
    } finally {
        qfs.rmSync(dir, { recursive: true, force: true });
    }
});

test('7b F3 behaviour: every large GRAPH world builds ONE linked chain of exactly MAX_DEPTH nodes; normal worlds 0 or 16..24', () => {
    const d = laneByName('GRAPH');
    const chainOf = (script) => {
        const ids = new Set();
        let len = 0, linked = true;
        for (const op of script.ops) {
            if (op.o !== 'comp' || op.spec.role !== 'chain') continue;
            // link k reads link k-1 (sum also reads the base leaf), so the chain depth is its length
            if (len > 0 && !op.spec.d.some((x) => ids.has(x))) linked = false;
            ids.add(op.i);
            len++;
        }
        return { len, linked };
    };
    for (let s = 1; s <= 8; s++) {
        const c = chainOf(generateWorld(d, s, { large: true }));
        assert.equal(c.len, MAX_DEPTH, 'large seed ' + s + ' chain length');
        assert.equal(c.linked, true, 'large seed ' + s + ' chain is one linked run');
    }
    for (let s = 1; s <= 40; s++) {
        const n = chainOf(generateWorld(d, s)).len;
        assert.ok(n === 0 || (n >= 16 && n <= 24), 'normal seed ' + s + ' chain length ' + n);
    }
});

/* ==== F5 (burst 7d, PLAN-F5-F6 TASK 7): the HARD oracle OB, sig batch-early-run ============================== */
/*
 * An effect that ALREADY ran must not re-run while a batch is open (exec batchDepth > 0); the first run of an
 * effect created inside a batch is synchronous by design (p2). OB is PERFORMED once per outermost batch whose
 * close-flush re-ran >= 1 effect. The lying adapter delegates every WORLD_METHODS method to the lite world and
 * overrides only batch (fn => fn()); it never spreads the world object. Revert-check (old exec, burst 7d task 0):
 * the lying adapter passes 64/64 BATCH worlds there (failure null), so these tests are red on the old exec.
 * Mutants (scratch copies): the OB check moved out of the `runs > 0` branch (F5 A2 red); OB dropped from
 * lanes/batch or lanes/error hardOracles, CHECK_NAMES, ORACLE_CAPS or the oracle gate's mustFail (F5 wiring red).
 */

const { WORLD_METHODS: f5Methods, ORACLE_CAPS: f5OracleCaps, applicability: f5Applicability } = await import('../bench/soak/adapters/contract.mjs');
const { CHECK_NAMES: f5CheckNames, SKIP_NAMES: f5SkipNames } = await import('../bench/soak/exec.mjs');
const { GATES: f5Gates, oracleFamily: f5Family } = await import('../bench/soak/gates.mjs');
const { seedFor: f5SeedFor, worldSeed: f5WorldSeed } = await import('../bench/soak/seeds.mjs');
const { isLargeWorld: f5IsLarge } = await import('../bench/soak/lanes/index.mjs');

/** A delegating adapter: every world method forwards to the lite world; `over(w)` replaces some of them. */
function f5Adapter(over) {
    return {
        name: liteAdapter.name, caps: liteAdapter.caps,
        version: () => liteAdapter.version(), files: () => liteAdapter.files(),
        knownAs: () => liteAdapter.knownAs(),
        open(o) {
            const w = liteAdapter.open(o);
            const out = {};
            for (const m of f5Methods) out[m] = (...a) => w[m](...a);
            const patch = over(w);
            for (const m of Object.keys(patch)) out[m] = patch[m];
            return out;
        },
    };
}
const f5Lying = f5Adapter(() => ({ batch: (fn) => fn() }));
const f5A1 = [{ o: 'sig', i: 0, v: 0 }, { o: 'eff', i: 1, spec: { k: 'sum', d: [0] } },
    { o: 'batch', body: [{ o: 'set', i: 0, v: 1 }, { o: 'set', i: 0, v: 2 }] }];
const f5A2 = [{ o: 'sig', i: 0, v: 0 },
    { o: 'batch', body: [{ o: 'set', i: 0, v: 1 }, { o: 'eff', i: 1, spec: { k: 'sum', d: [0] } }, { o: 'set', i: 0, v: 2 }] }];

test('F5 A1: one deferred re-run is one performed OB on lite; the lying adapter fails OB at the batch step', () => {
    let bodies = 0;
    const counting = f5Adapter((w) => ({ effect: (fn) => w.effect(() => { bodies++; return fn(); }) }));
    const lite = runWorld(counting, qScript(f5A1, 'BATCH'));
    assert.equal(lite.failure, null, JSON.stringify(lite.failure));
    assert.equal(lite.checks.OB, 1);
    assert.equal(bodies, 2, 'eff#1 ran at creation and once at the batch close');
    const lying = runWorld(f5Lying, qScript(f5A1, 'BATCH'));
    assert.notEqual(lying.failure, null, 'a batch that defers nothing must fail OB');
    assert.equal(lying.failure.step, 2);
    assert.deepEqual(lying.failure.fails.map((f) => ({ oracle: f.oracle, sig: f.sig })), [{ oracle: 'OB', sig: 'batch-early-run' }]);
    assert.match(lying.failure.fails[0].detail, /^effect#1 re-ran inside an open batch \(depth 1\)$/);
    assert.equal(lying.checks.OB, 0, 'nothing re-ran in a close-flush: no OB performed');
});

test('F5 A2: an effect created inside a batch runs its first body there (allowed); its deferred re-run counts OB', () => {
    const r = runWorld(liteAdapter, qScript(f5A2, 'BATCH'));
    assert.equal(r.failure, null, JSON.stringify(r.failure));
    assert.equal(r.checks.OB, 1);
    // a batch with nothing to defer is not evidence: no-op batch, writes nobody reads
    const quiet = runWorld(liteAdapter, qScript([{ o: 'sig', i: 0, v: 0 }, { o: 'batch', body: [] }, { o: 'batch', body: [{ o: 'set', i: 0, v: 3 }] }], 'BATCH'));
    assert.equal(quiet.failure, null, JSON.stringify(quiet.failure));
    assert.equal(quiet.checks.OB, 0);
});

test('F5 A3: 64 BATCH worlds -- lite: 0 OB fails and >= 1 performed OB per world; lying: 64/64 fail OB', () => {
    const d = laneByName('BATCH');
    const cs = f5SeedFor(0xC0FFEE, d.index, 0);
    let liteOk = 0, lyingOB = 0, minOB = Infinity;
    for (let w = 0; w < 64; w++) {
        const script = generateWorld(d, f5WorldSeed(cs, w), { large: f5IsLarge(d, w) });
        const a = runWorld(liteAdapter, script);
        if (a.failure === null) liteOk++;
        if (a.checks.OB < minOB) minOB = a.checks.OB;
        const b = runWorld(f5Lying, script);
        if (b.failure !== null && b.failure.fails.some((f) => f.oracle === 'OB' && f.sig === 'batch-early-run')) lyingOB++;
    }
    assert.equal(liteOk, 64);
    assert.ok(minOB >= 1, 'min performed OB per world ' + minOB);
    assert.equal(lyingOB, 64);
});

test('F5 wiring: OB is a check name (not a skip name), an oracle with its sig, a BATCH and ERROR hard oracle, needs cap batch, family OB', () => {
    assert.ok(f5CheckNames.includes('OB'), 'CHECK_NAMES');
    assert.ok(!f5SkipNames.includes('OB'), 'OB skips nothing: not a SKIP_NAMES oracle');
    assert.ok(O.ORACLES.includes('OB'));
    assert.deepEqual(O.SIGS.OB, ['batch-early-run']);
    assert.deepEqual(O.checkBatchRun(3, 2), { oracle: 'OB', sig: 'batch-early-run', detail: 'effect#3 re-ran inside an open batch (depth 2)' });
    assert.ok(laneByName('BATCH').hardOracles.includes('OB'), 'BATCH hardOracles (the check floor counts it)');
    // burst 13 (addendum 16 task 2): ERROR batches close-flush too, so OB is a hard ERROR oracle (the check floor counts it)
    assert.ok(laneByName('ERROR').hardOracles.includes('OB'), 'ERROR hardOracles (the check floor counts it)');
    for (const lane of ['GRAPH', 'NEST']) assert.ok(!laneByName(lane).hardOracles.includes('OB'), lane + ': OB runs, no floor');
    assert.deepEqual(f5OracleCaps.OB, ['batch']);
    // contract.mjs ORACLE_CAPS: OB is N/A on an adapter without the batch cap, for BATCH and ERROR alike
    for (const lane of ['BATCH', 'ERROR']) {
        assert.ok(f5Applicability(laneByName(lane), Object.assign({}, liteAdapter.caps, { batch: 'no' })).oraclesNA.includes('OB'), lane);
        assert.ok(!f5Applicability(laneByName(lane), liteAdapter.caps).oraclesNA.includes('OB'), lane);
    }
    assert.equal(f5Family('OB'), 'OB');
    const gate = f5Gates.find((g) => g.id === 'oracle');
    const ob = gate.mustFail.filter((m) => Object.keys(m.input.failureCounts || {}).some((k) => k.indexOf('OB:') === 0));
    assert.equal(ob.length, 1, 'the oracle gate carries an OB must-fail control (amendment 9)');
    assert.equal(gate.check(ob[0].input).verdict, ob[0].expect);
    assert.notEqual(gate.check(ob[0].input).verdict, gate.check(gate.pass[0]).verdict);
});

/*
 * Burst 13 (addendum 16 task 5): the BATCH cov-off switch is closed. lanes/batch.mjs put compares DECODED values with
 * Object.is, the test scenarios.mjs onBatchWrite counts a revert by; the code compare it replaced leaked 18 hits over
 * this exact prefix (VALUE_POOL aliases 0 / -1 and 1 / -3). The smoke prefix of main / calibrate: DEFAULT_SEED,
 * cycles 0..SMOKE_CYCLES-1, each until SMOKE_OPS ops, on headpatched (in-process, the section 5 kernel).
 * Mutant (scratch copy): `v === st.pre.get(s)` back in put -> covOff hits 18, red.
 */
const { SMOKE_CYCLES: b13Cycles, SMOKE_OPS: b13Ops, DEFAULT_SEED: b13Seed } = await import('../bench/soak/config.mjs');

function b13SmokeHits(covOff) {
    const desc = laneByName('BATCH');
    let hits = 0, ops = 0, worlds = 0;
    for (let cycle = 0; cycle < b13Cycles; cycle++) {
        const cs = f5SeedFor(b13Seed, desc.index, cycle);
        let c = 0;
        for (let w = 0; c < b13Ops; w++) {
            const r = runWorld(liteAdapter, generateWorld(desc, f5WorldSeed(cs, w), { large: f5IsLarge(desc, w), covOff }));
            c += r.ops; worlds++;
            hits += r.scen['revert-after-mid-read'] || 0;
        }
        ops += c;
    }
    return { hits, ops, worlds };
}

test('B13 BATCH cov-off revert-after-mid-read: the smoke prefix on headpatched counts 0 hits; covOff null counts > 0', () => {
    const off = b13SmokeHits('revert-after-mid-read');
    const on = b13SmokeHits(null);
    assert.ok(off.worlds > 0 && off.ops >= b13Cycles * b13Ops, JSON.stringify(off));
    assert.equal(off.hits, 0, 'cov-off leaks revert-after-mid-read: ' + JSON.stringify(off));
    assert.ok(on.hits > 0, 'the trigger is live without the cov-off (teeth): ' + JSON.stringify(on));
});

// mutant (exec.mjs runBody): `if (this.effReruns < COUNTER_CAP)` dropped -- the per-world re-run counter leaves
// the 31-bit Smi range. Scratch copy of exec.mjs with an appended export, as in the qa counter-cap test.
test('F5 effReruns saturates at 0x3FFFFFFF; a saturated counter never fakes a performed OB', async () => {
    const SOAK_URL = qToUrl(SOAK).href + '/';
    const src = qfs.readFileSync(join(SOAK, 'exec.mjs'), 'utf8')
        .replace(/from '\.\.\//g, "from '" + SOAK_URL + '../').replace(/from '\.\//g, "from '" + SOAK_URL);
    const dir = qfs.mkdtempSync(join(qos.tmpdir(), 'soak-f5-exec-'));
    try {
        const file = join(dir, 'exec-f5.mjs');
        qfs.writeFileSync(file, src + '\nexport { Exec as __F5Exec };\n');
        const { __F5Exec } = await import(qToUrl(file).href);
        const CAP = 0x3FFFFFFF;
        const script = qScript(f5A1.concat([{ o: 'set', i: 0, v: 5 }, { o: 'set', i: 0, v: 6 }]), 'BATCH');   // 3 re-runs
        const x = new __F5Exec(liteAdapter, script, {});
        x.effReruns = CAP - 1;   // the batch-close re-run is the crossing: a real witness, counted once
        const r = x.run();
        assert.equal(r.failure, null, JSON.stringify(r.failure));
        assert.equal(x.effReruns, CAP, 'three re-runs from CAP - 1 stop at CAP');
        assert.equal(r.checks.OB, 1);
        const y = new __F5Exec(liteAdapter, script, {});
        y.effReruns = CAP;
        const s = y.run();
        assert.equal(s.failure, null, JSON.stringify(s.failure));
        assert.equal(y.effReruns, CAP);
        assert.equal(s.checks.OB, 0, 'the batch close re-ran eff#1, but the saturated counter cannot witness it: fewer checks, never a fake one');
    } finally {
        qfs.rmSync(dir, { recursive: true, force: true });
    }
});

// mutant (exec.mjs runBatch): the `this.closeMark >= 0` guard dropped -- closeMark stays -1 when the engine never
// invokes the batch callback, so `effReruns > closeMark` would count a performed OB with no batch close witnessed.
test('F5 a batch whose callback never ran performs no OB (closeMark stays -1: no witness, no check)', () => {
    const silent = f5Adapter(() => ({ batch: () => {} }));   // never calls fn: the body never runs, model untouched
    const r = runWorld(silent, qScript(f5A1.concat([{ o: 'set', i: 0, v: 7 }, { o: 'batch', body: [{ o: 'set', i: 0, v: 9 }] }]), 'BATCH'));
    assert.equal(r.failure, null, JSON.stringify(r.failure));
    assert.equal(r.checks.OB, 0, 'no callback ran, so no close-flush was witnessed');
    assert.equal(runWorld(liteAdapter, qScript(f5A1, 'BATCH')).checks.OB, 1, 'control: the same world on lite performs OB');
});

/* ==== 7d nit 1 (burst 10, S1d B7c): the two OB closeMark test-pin survivors ================================= */

const f5Eff = [{ o: 'sig', i: 0, v: 0 }, { o: 'eff', i: 1, spec: { k: 'sum', d: [0] } }];
const f5Set = (v) => ({ o: 'batch', body: [{ o: 'set', i: 0, v }] });

// mutant (exec.mjs runBatch): closeMark set only when the callback RETURNS (moved out of the inner finally) -- a
// throwing callback leaves closeMark -1, so the close-flush re-run of eff#1 is never witnessed.
test('F5 a batch whose callback throws after a write still witnesses its close-flush: checks.OB === 1', () => {
    const r = runWorld(liteAdapter, qScript(f5Eff.concat([{ o: 'batch', body: [{ o: 'set', i: 0, v: 1 }], thr: 1 }]), 'BATCH'));
    assert.equal(r.failure, null, JSON.stringify(r.failure));
    assert.equal(r.checks.OB, 1, 'the batch token escaped, the engine still flushed eff#1 at the close: one performed OB');
});

// mutant (exec.mjs runBatch): the `this.closeMark = -1` reset dropped -- batch 1's mark survives into batch 2,
// whose skipped callback then reads batch 1's close-flush re-run as its own performed OB.
test('F5 closeMark resets between batches: an adapter that skips only its 2nd batch callback counts OB on batches 1 and 3 only', () => {
    const skip2 = f5Adapter((w) => { let n = 0; return { batch: (fn) => (++n === 2 ? undefined : w.batch(fn)) }; });
    const seq = [f5Set(1), f5Set(2), f5Set(3)];
    const want = [1, 1, 2];   // cumulative OB after batch 1, 2, 3
    for (let k = 1; k <= 3; k++) {
        const r = runWorld(skip2, qScript(f5Eff.concat(seq.slice(0, k)), 'BATCH'));
        assert.equal(r.failure, null, 'after batch ' + k + ': ' + JSON.stringify(r.failure));
        assert.equal(r.checks.OB, want[k - 1], 'cumulative OB after batch ' + k);
    }
});
