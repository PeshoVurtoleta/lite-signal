// 66-soak-wie.test.mjs -- the soak WRITE-IN-EVAL (WIE) lane, an INDEPENDENT ORACLE (unit 0s item 1, batch B3).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// Pins the SOAK-HARNESS versions of the F-b33-1 shapes of test/56-write-in-eval.test.mjs: a COMPUTED WRITER (a
// computed whose spec carries `w` [+ `inc`, + `wu: 1` = write wrapped in untrack]) written from
// .handoff/PLAN-0s-wie.md ADDENDUM 1 (item 3 B3) and the planner ASSERTIONS, never from the implementation.
// Expected values: the soak model is the oracle (it holds the spec value of every node). Which oracle trips on a
// stale engine follows the oracle's meaning: a stale EFFECT is O1e (effect-stale), a stale COMPUTED is O1c.
//
// Shape translation (a computed writer C = {k:'sum', d:[], w:A, inc:10} writes A = 0 + 10 = 10 each time it runs;
// a conditional writer C = {k:'sum', d:[S], w:A} writes A = S, so S=1 -> A=1, S=2 -> A=2, S=0 -> A=0 no-op):
//   V1   eff{a, C}              V2 (control) eff{C, a}       V3 eff{Y, C}, Y = sum(a)
//   V5   (control) Y = sum(a), eff{Y}, and a second EFFECT writer sets a
//   V6   V3 with wu:1           V7 D = sum(a, C), read D twice
//   lead-effect / lead-computed  the generator's stale-order reader [s, w, C], C = sum(s) w:a pre-pulled (pull:1), then a
//        top-level set of s: the acyclic post-creation lost update (#37). (The b33 pre-walk lost update is NOT
//        witnessable in v1, maintainer ruling b64: w := f(C out) re-runs the reader on any engine; needs v2.)
//   cov-prewalk  COVERAGE ONLY in v1 (the test/56 b33-effect shape, green on both kernels), not a lost-update witness
//   IF   eff{D} over the V7 D / C pair
//   V2u  V2 with wu:1: a NON-stale untracked write (counts wie-write-before-read, never wie-untrack)
//   W1   a computed writer with a bad target (own read set, non-signal, forward) -> exec fails closed ('exec: unmodelled')
//
// RED on the preb33 control kernel (frozen head-7c65afd): V1 V3 V6 V7 IF lead-effect lead-computed (test/56's V-rows red set,
// header lines 13-14; lead-* are the soak-only #37 witnesses). GREEN on live: all rows (0 failures). GREEN on BOTH: V2, V5, cov-prewalk.
// W1: live (and preb33: the throw is the harness's, before the engine is involved).
// Every live run also asserts the EXACT wie-* counter map (SCEN) of its row, so a counter swap (stale-* <->
// write-before-read) is caught. wie-untrack counts only when the write really ran inside untrack (wu writer).
// W1 has three fail-closed reasons, each pinned by its own regex: own transitive read set / not a signal /
// not an earlier node (forward or self target). Four more W1 rows: strTarget (w is the string '0'), self (w === i),
// negTarget (w -1) and fracTarget (w 0.5): only an integer 0 <= w < i reaches the read-set / signal arms.
// The not-a-signal arm has two rows: notSignal (a computed target) and notSignal2 (an effect target, read set disjoint).
// Generated: 200 worlds of the WIE lane on live: 0 failures, 0 unmodelled, the EXACT scenario counter map (GEN_SCEN).
//
// Kernel binding: kernel.mjs reads SOAK_KERNEL once at import, so every row runs in a CHILD node process (the test/57
// seam). live = no SOAK_KERNEL; preb33 = bench/soak/controls/preb33/Signal.js. A missing kernel is RED, never a skip.
// The WIE descriptor is imported from lanes/wie.mjs directly (it is not in ROSTER / laneByName).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PREB33 = join(ROOT, 'bench', 'soak', 'controls', 'preb33', 'Signal.js');
const SCENARIOS = ['wie-stale-effect', 'wie-stale-computed', 'wie-prewalk', 'wie-untrack', 'wie-write-before-read'];

const world = (ops) => ({ genVersion: 1, lane: 'WIE', seed: 660001, large: false, covOff: null, flushPasses: 8, ops });
const sig = (i, v) => ({ o: 'sig', i, v: v === undefined ? 0 : v });
const comp = (i, spec, x) => Object.assign({ o: 'comp', i, spec }, x);
const eff = (i, spec) => ({ o: 'eff', i, spec });
const rd = (...is) => ({ o: 'read', is });
const set = (i, v) => ({ o: 'set', i, v });
const WR = (w, extra) => Object.assign({ k: 'sum', d: [], w, inc: 10 }, extra);   // constant writer: writes 10
const CW = (s, w) => ({ k: 'sum', d: [s], w });                                    // conditional writer: writes the value of s

const ROWS = {
    V1: [sig(0), comp(1, WR(0)), eff(2, { k: 'sum', d: [0, 1] })],
    V2: [sig(0), comp(1, WR(0)), eff(2, { k: 'sum', d: [1, 0] })],
    V3: [sig(0), comp(1, { k: 'sum', d: [0] }), comp(2, WR(0)), eff(3, { k: 'sum', d: [1, 2] })],
    V5: [sig(0), comp(1, { k: 'sum', d: [0] }), eff(2, { k: 'sum', d: [1] }), eff(3, { k: 'sum', d: [], w: 0, inc: 10 })],
    V6: [sig(0), comp(1, { k: 'sum', d: [0] }), comp(2, WR(0, { wu: 1 })), eff(3, { k: 'sum', d: [1, 2] })],
    V7: [sig(0), comp(1, WR(0)), comp(2, { k: 'sum', d: [0, 1] }), rd(2), rd(2)],
    // lead (the generator's stale-order reader [s, w, C], C pre-pulled, then a top-level set of s): the acyclic
    // post-creation lost update. C = sum(s) writes a := s; the reader reads s, a, then pulls C, whose write lands
    // after the reader read a.
    'lead-effect': [sig(0), sig(1), comp(2, CW(0, 1), { pull: 1 }), eff(3, { k: 'sum', d: [0, 1, 2] }), set(0, 5)],
    'lead-computed': [sig(0), sig(1), comp(2, CW(0, 1), { pull: 1 }), comp(3, { k: 'sum', d: [0, 1, 2] }), rd(3), set(0, 5), rd(3)],
    // COVERAGE ONLY in v1 (not a lost-update witness): the pre-walk write shape of test/56 b33-effect. With
    // w := f(C's out) the reader re-runs through C on any engine, so it is green on both kernels (v2: an
    // output-independent write value or a cleanup write is needed to witness the b33 pre-walk lost update).
    'cov-prewalk': [sig(0), sig(1), comp(2, CW(0, 1)), eff(3, { k: 'sum', d: [1, 2] }), set(0, 1), set(0, 2)],
    IF: [sig(0), comp(1, WR(0)), comp(2, { k: 'sum', d: [0, 1] }), eff(3, { k: 'sum', d: [2] })],
    // non-stale untracked write: V2 order (eff reads C first) with the write wrapped in untrack
    V2u: [sig(0), comp(1, WR(0, { wu: 1 })), eff(2, { k: 'sum', d: [1, 0] })],
};
// W1: writer target 0 is read by the writer itself (direct) / through Y (transitive).
const W1 = {
    direct: [sig(0), comp(1, { k: 'sum', d: [0], w: 0, inc: 1 }), rd(1)],
    transitive: [sig(0), comp(1, { k: 'sum', d: [0] }), comp(2, { k: 'sum', d: [1], w: 0, inc: 1 }), rd(2)],
    // target is a computed (not a signal)
    notSignal: [sig(0), comp(1, { k: 'sum', d: [0] }), comp(2, { k: 'sum', d: [0], w: 1, inc: 1 }), rd(2)],
    // target is an EFFECT (not a signal), outside the writer's read set {2}: with the not-a-signal check dropped the
    // read-set arm cannot catch it (a target IN the read set still throws 'not a signal' there, via the message ternary)
    notSignal2: [sig(0), eff(1, { k: 'sum', d: [0] }), sig(2), comp(3, { k: 'sum', d: [2], w: 1, inc: 1 }), rd(3)],
    // target is a later node (forward reference)
    forward: [sig(0), comp(1, { k: 'sum', d: [0], w: 2, inc: 1 }), sig(2), rd(1)],
    // target is not an integer (string)
    strTarget: [sig(0), comp(1, { k: 'sum', d: [0], w: '0', inc: 1 }), rd(1)],
    // target is the writer itself (w === i)
    self: [sig(0), comp(1, { k: 'sum', d: [0], w: 1, inc: 1 }), rd(1)],
    // target is negative / fractional (only an integer 0 <= w < i reaches the next arm)
    negTarget: [sig(0), comp(1, { k: 'sum', d: [0], w: -1, inc: 1 }), rd(1)],
    fracTarget: [sig(0), sig(1), comp(2, { k: 'sum', d: [1], w: 0.5, inc: 1 }), rd(2)],
};
const W1_RE = {
    direct: /own transitive read set/, transitive: /own transitive read set/, notSignal: /not a signal/,
    notSignal2: /not a signal/,
    forward: /not an earlier node/, strTarget: /not an earlier node/, self: /not an earlier node/,
    negTarget: /not an earlier node/, fracTarget: /not an earlier node/,
};

// expected failing oracles on preb33 (sorted 'oracle:sig' list), per the oracle semantics above (stale effect = O1e,
// stale computed = O1c).
const RED = {
    V1: ['O1e:effect-stale'], V3: ['O1e:effect-stale'], V6: ['O1e:effect-stale'],
    // IF: the effect's body read of D is stale (O1e) and the same read is a glitch against the model (O2).
    IF: ['O1e:effect-stale', 'O2:glitch'],
    V7: ['O1c:computed-mismatch'],
    'lead-effect': ['O1e:effect-stale'], 'lead-computed': ['O1c:computed-mismatch'],
};
const GREEN_BOTH = ['V2', 'V2u', 'V5', 'cov-prewalk'];
// exact wie-* scenario counters of one live run of each row (which counter fires, not just that the run is green)
const SCEN = {
    V1: { 'wie-stale-effect': 1 }, V2: { 'wie-write-before-read': 1 }, V2u: { 'wie-write-before-read': 1 },
    V3: { 'wie-stale-effect': 1 }, V5: {},
    V6: { 'wie-stale-effect': 1, 'wie-untrack': 1 }, V7: { 'wie-stale-computed': 1 },
    'lead-effect': { 'wie-stale-effect': 1 }, 'lead-computed': { 'wie-stale-computed': 1 },
    'cov-prewalk': { 'wie-prewalk': 2 }, IF: { 'wie-stale-computed': 1 },
};

const DRIVER = `
const cfg = JSON.parse(process.env.T66_CFG);
const SOAK = new URL('file://' + cfg.root + '/bench/soak/');
const ex = await import(new URL('exec.mjs', SOAK));
const mn = await import(new URL('main.mjs', SOAK));
const { liteAdapter } = await import(new URL('adapters/lite.mjs', SOAK));
const keys = (r) => (r.failure === null ? null : r.failure.fails.map((f) => f.oracle + ':' + f.sig).sort());
const tap = () => ({ escape: null, onOpen() {} });
const out = {};
try {
    if (cfg.mode === 'run') {
        const r = ex.runWorld(mn.tapAdapter(liteAdapter, tap()), cfg.world, {});
        out.keys = keys(r); out.detail = r.failure === null ? null : r.failure.fails.map((f) => f.detail);
        out.scen = {}; for (const k of Object.keys(r.scen)) if (k.startsWith('wie-')) out.scen[k] = r.scen[k];
    } else if (cfg.mode === 'gen') {
        const { WIE } = await import(new URL('lanes/wie.mjs', SOAK));
        const { generateWorld } = await import(new URL('gen.mjs', SOAK));
        const { seedFor, worldSeed } = await import(new URL('seeds.mjs', SOAK));
        const cs = seedFor(cfg.base, WIE.index, 0);
        out.index = WIE.index; out.bad = 0; out.unmodelled = 0; out.other = []; out.scen = {}; out.firstBad = null;
        for (let w = 0; w < cfg.n; w++) {
            const script = generateWorld(WIE, worldSeed(cs, w), { large: false, covOff: null });
            let r;
            try { r = ex.runWorld(mn.tapAdapter(liteAdapter, tap()), script, {}); }
            catch (e) {
                const m = String(e && e.message ? e.message : e);
                if (m.startsWith('exec: unmodelled')) out.unmodelled++; else out.other.push(m.slice(0, 200));
                continue;
            }
            if (r.failure !== null) { out.bad++; if (out.firstBad === null) out.firstBad = { w, keys: keys(r), detail: r.failure.fails.map((f) => f.detail) }; }
            for (const k of Object.keys(r.scen)) out.scen[k] = (out.scen[k] || 0) + r.scen[k];
        }
    }
} catch (e) { out.threw = String(e && e.message ? e.message : e); out.stack = String(e && e.stack); }
process.stdout.write('T66 ' + JSON.stringify(out) + '\\n');
`;

function child(kernel, cfg) {
    const env = Object.assign({}, process.env, { T66_CFG: JSON.stringify(Object.assign({ root: ROOT.replace(/\/$/, '') }, cfg)) });
    delete env.SOAK_KERNEL; delete env.SOAK_ENGINE; delete env.SOAK_NEARWRAP;
    if (kernel !== null) env.SOAK_KERNEL = kernel;
    const p = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', DRIVER], { cwd: ROOT, env, encoding: 'utf8', timeout: 240000 });
    const line = (p.stdout || '').split('\n').find((l) => l.startsWith('T66 '));
    assert.ok(line, 'child gave no result line; status ' + p.status + '\nstderr: ' + (p.stderr || '').slice(0, 600) + '\nstdout: ' + (p.stdout || '').slice(0, 300));
    return JSON.parse(line.slice(4));
}
const needPreb33 = () => assert.ok(existsSync(PREB33), 'control kernel missing: ' + PREB33 + ' (a missing control is red, not a skip)');

for (const name of Object.keys(RED)) {
    test('WIE ' + name + ': live -> 0 failures', () => {
        const o = child(null, { mode: 'run', world: world(ROWS[name]) });
        assert.equal(o.threw, undefined, o.threw);
        assert.equal(o.keys, null, JSON.stringify(o.detail));
        const k = SCEN[name] === undefined ? null : SCEN[name];
        assert.notEqual(k, null, 'no SCEN entry for ' + name);
        assert.deepEqual(o.scen, k, 'wie-* counters of ' + name);
    });
    test('WIE ' + name + ': preb33 -> RED, failing oracles exactly ' + JSON.stringify(RED[name]), () => {
        needPreb33();
        const o = child(PREB33, { mode: 'run', world: world(ROWS[name]) });
        assert.equal(o.threw, undefined, o.threw);
        assert.deepEqual(o.keys, RED[name], JSON.stringify(o.detail));
    });
}

for (const name of GREEN_BOTH) {
    test('WIE ' + name + ' (control): green on live AND preb33', () => {
        needPreb33();
        for (const k of [null, PREB33]) {
            const o = child(k, { mode: 'run', world: world(ROWS[name]) });
            assert.equal(o.threw, undefined, o.threw);
            assert.equal(o.keys, null, (k === null ? 'live ' : 'preb33 ') + JSON.stringify(o.detail));
            if (k === null) {
                const e = SCEN[name] === undefined ? null : SCEN[name];
                assert.notEqual(e, null, 'no SCEN entry for ' + name);
                assert.deepEqual(o.scen, e, 'wie-* counters of ' + name);
            }
        }
    });
}

for (const kind of Object.keys(W1)) {
    test('WIE W1 (' + kind + '): a computed writer with an unmodelled target -> exec: unmodelled (fail closed), live', () => {
        const o = child(null, { mode: 'run', world: world(W1[kind]) });
        assert.equal(typeof o.threw, 'string', 'expected runWorld to throw, got ' + JSON.stringify(o));
        assert.match(o.threw, /^exec: unmodelled/);
        assert.match(o.threw, W1_RE[kind]);
    });
}

// GEN_SCEN: the exact scenario counter map of the 200 generated worlds (base 0xC0FFEE, live kernel), CUT by running
// the HEAD generator on these inputs (b79 B4: .handoff/b79-evidence/B4/cut-e1.mjs + cut-e1.log), never guessed. The
// literals depend on gen.mjs / exec.mjs / scenarios.mjs (and lanes/wie.mjs, seeds.mjs) AND on the engine: a
// calibration recut, a generator / harness change or an engine change RE-CUTS them (same script, same inputs).
const GEN_SCEN = {
    'wie-stale-effect': 14081, 'wie-stale-computed': 8062, 'wie-prewalk': 286609, 'wie-untrack': 5517,
    'wie-write-before-read': 1193,
    'equality-cutoff': 49415, 'second-invalidation': 169436, 'dep-set-flip': 39709, 'diamond-write': 26359,
    'adversarial-equality': 590,
};
test('WIE generated: 200 worlds on live -> 0 failures, 0 unmodelled, no other throw, exact scenario counter map', () => {
    const o = child(null, { mode: 'gen', base: 0xC0FFEE, n: 200 });
    assert.equal(o.threw, undefined, o.threw);
    assert.equal(o.index, 4, 'WIE.index');
    assert.deepEqual(o.other, [], 'non-unmodelled throws');
    assert.equal(o.unmodelled, 0, 'unmodelled worlds');
    assert.equal(o.bad, 0, JSON.stringify(o.firstBad));
    assert.deepEqual(o.scen, GEN_SCEN, 'scenario counters of the 200 generated worlds (re-cut on a gen / exec / scenarios / engine change)');
    for (const s of SCENARIOS) assert.ok(GEN_SCEN[s] >= 1, 'GEN_SCEN never counts ' + s + ' (a re-cut must still cover every wie-* scenario)');
});
