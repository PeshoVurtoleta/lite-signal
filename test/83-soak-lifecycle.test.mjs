// 83-soak-lifecycle.test.mjs -- S3 rung R2 LIFECYCLE + O7 (burst 110, batch H1; .handoff/PLAN-R2-lifecycle.md
// "O7 / lane rules", ASSERTIONS 2, ADDENDA A1/Q3). Written from the plan BEFORE the code exists: an oracle independent
// of the coder. Every expected sig / detail below is the plan's text; nothing was copied from a run.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
//
// CONTRACT: (assumptions the plan leaves open; coder / reviewer reconcile here, then change ONLY this block's users)
//   C1  model.mjs: Model#sinkCount(i, memo) -> number, Model#sinkSet(i, memo) -> Set<number> of observer indices;
//       memo is a Map; the reverse index is cached as memo.get('lc:sinks').
//   C2  oracles.mjs: ORACLES includes 'O7'; SIGS.O7 = the five sigs in S3-D5 order. checkLcFire(lc, r, kind) with kind
//       'onConnect' | 'onDisconnect' returns null or { oracle: 'O7', sig, detail }; it pushes kind to lc.regs[r].fires and,
//       when it does not fail, flips lc.regs[r].phase (a phase -1 registration takes the phase the fire implies).
//       checkLcRest(lc, model, memo, ran) returns an array of { sig, detail } and, for a phase -1 registration with no
//       fire, sets phase to (sinkCount > 0 ? 1 : 0). ran = Set of node indices that ran this op.
//   C3  LcState `lc` fields read by the oracles: lc.regs[r] = { r, target, live, phase (-1|0|1), fires: [kind...] since
//       the last rest, co: Set<r> (other live registrations that overlapped on the target since lastGood),
//       sibOff: null | { r, step } (an off of another registration ran on the same target since lastGood),
//       deadOff: null | { step } (an off ran on a dead target that died before this registration was created) };
//       lc.prev = Map<target, Set<observer>> = sinkSet at the previous rest (key absent = target did not exist then).
//       The model's own regs table (model.addReg / offReg) holds liveness for O7a (checkFire, already shipped).
//   C4  lanes/lifecycle.mjs exports LIFECYCLE (the descriptor, like HOOK in lanes/hook.mjs); not rostered yet, so it is
//       imported by path. ALL_SCENARIOS (scenarios.mjs via lanes/index.mjs) holds the lc-* scenario names.
//   C5  detail tails not spelled out by the plan are matched loosely: `onDisconnect while disconnected`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Model } from '../bench/soak/model.mjs';
import * as O from '../bench/soak/oracles.mjs';
import { LANE_INDEX, ALL_SCENARIOS } from '../bench/soak/lanes/index.mjs';
import { liteAdapter } from '../bench/soak/adapters/lite.mjs';
import { runWorld } from '../bench/soak/exec.mjs';

const CAPS = { childEffects: 'parent-run' };
const sigs = (fs) => fs.map((f) => f.sig);

// ---- hand-built worlds ----------------------------------------------------------------------------------------
// signal #0 (the target); `n` live effects #1..#n whose last run tracked #0; registration r1 on #0 in the model table.
function world(n, over = {}) {
    const m = new Model(CAPS);
    m.addSignal(0, 1, {});
    for (let k = 1; k <= n; k++) { m.addEffect(k, { role: 'eff' }); m.n[k].runs = 1; m.n[k].links = [0]; }
    m.addReg(1, 0);
    return Object.assign(m, over);
}
const reg = (over) => Object.assign({ r: 1, target: 0, live: true, phase: 0, fires: [], co: new Set(), sibOff: null, deadOff: null }, over);
const lcOf = (regs, prev) => ({ step: 12, regs: Object.assign([], ...regs.map((g) => ({ [g.r]: g }))), prev: new Map(prev) });
const rest = (m, regs, prev, ran = new Set()) => O.checkLcRest(lcOf(regs, prev), m, new Map(), ran);
const oneOf = (m, g, prev, ran) => rest(m, [g], prev, ran);

/* ---- metadata ------------------------------------------------------------------------------------------------ */

test('O7 oracle registry: ORACLES has O7, SIGS.O7 is the S3-D5 order, O7a unchanged', () => {
    assert.ok(O.ORACLES.includes('O7') && O.ORACLES.includes('O7a'));
    assert.deepEqual(O.SIGS.O7, ['spurious-connect', 'missed-disconnect', 'stale-off', 'spurious-disconnect', 'missed-connect']);
    assert.deepEqual(O.SIGS.O7a, ['dead-registration-fire']);
});

test('lane metadata: LIFECYCLE index 5, ops, hard oracles, caps, covOff, required scenarios', async () => {
    const { LIFECYCLE: L } = await import('../bench/soak/lanes/lifecycle.mjs');
    assert.equal(LANE_INDEX.LIFECYCLE, 5);
    assert.equal(L.name, 'LIFECYCLE');
    assert.equal(L.index, 5);
    assert.deepEqual(Object.keys(L.ops), ['lreg', 'loff']);
    for (const o of ['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O7a', 'O7']) assert.ok(L.hardOracles.includes(o), o);
    assert.deepEqual([...L.needsCaps], ['lifecycle', 'disposeSignal']);
    assert.deepEqual(Object.keys(L.covOff), ['lc-two-regs']);
    assert.equal(L.covOff['lc-two-regs'], 'single-reg');
    assert.deepEqual([...L.required], ['lc-two-regs', 'lc-off-sibling', 'lc-late-off-recycle', 'lc-callback-dispose', 'lc-callback-register']);
    for (const s of L.required) assert.ok(ALL_SCENARIOS.includes(s), s + ' in scenarios.mjs');
    assert.ok(L.optional.includes('lc-callback-off-sibling'));
});

/* ---- sinkCount / sinkSet (L6, p4, distinct, liveness) -------------------------------------------------------- */

test('sinkCount: distinct LIVE observers of i; L6 (pull of an unobserved computed) = 1; never-pulled computed = 0', () => {
    const m = new Model(CAPS);
    m.addSignal(0, 1, {});
    m.addComputed(1, { role: 'comp' });
    // L6 / p4: the computed was pulled once at top level, no effect observes it -> it still holds a link to #0
    m.n[1].runs = 1; m.n[1].links = [0];
    assert.equal(m.sinkCount(0, new Map()), 1, 'L6: the pulled-but-unobserved computed is a sink of #0');
    assert.deepEqual([...m.sinkSet(0, new Map())], [1]);
    assert.equal(m.sinkCount(1, new Map()), 0, 'nobody reads the computed');
    // a never-pulled computed (links === null, lazy) counts nothing
    m.addComputed(2, { role: 'comp' });
    assert.equal(m.sinkCount(0, new Map()), 1);
    assert.equal(m.sinkCount(2, new Map()), 0);
    // a live effect over {0, computed 1}; a duplicate read of #0 counts the observer once
    m.addEffect(3, { role: 'eff' }); m.n[3].runs = 1; m.n[3].links = [0, 1, 0];
    assert.equal(m.sinkCount(0, new Map()), 2);
    assert.deepEqual([...m.sinkSet(0, new Map())].sort(), [1, 3]);
    assert.equal(m.sinkCount(1, new Map()), 1);
    // a disposed observer no longer counts
    m.n[3].live = false;
    assert.equal(m.sinkCount(0, new Map()), 1);
});

test('sinkCount: one reverse index per pass, cached as memo.get("lc:sinks")', () => {
    const m = world(2);
    const memo = new Map();
    assert.equal(m.sinkCount(0, memo), 2);
    assert.ok(memo.has('lc:sinks'), 'index cached after the first call');
    const idx = memo.get('lc:sinks');
    assert.equal(m.sinkCount(0, memo), 2);
    assert.equal(memo.get('lc:sinks'), idx, 'the same index object is reused inside one pass');
});

/* ---- O7 per-sig rows: failing world + passing twin ---------------------------------------------------------- */

test('spurious-connect (fire): onConnect while phase 1 fires; the phase-0 twin is silent and flips to 1', () => {
    const lc = lcOf([reg({ r: 3, phase: 1 })], []);
    const f = O.checkLcFire(lc, 3, 'onConnect');
    assert.equal(f.sig, 'spurious-connect');
    assert.match(f.detail, /^r3 on #0: onConnect while connected$/);
    const lc0 = lcOf([reg({ r: 3, phase: 0 })], []);
    assert.equal(O.checkLcFire(lc0, 3, 'onConnect'), null);
    assert.equal(lc0.regs[3].phase, 1, 'phase flips on a legal fire');
});

test('spurious-disconnect (fire): onDisconnect while phase 0 fires; the phase-1 twin is silent and flips to 0', () => {
    const lc = lcOf([reg({ r: 4, phase: 0 })], []);
    const f = O.checkLcFire(lc, 4, 'onDisconnect');
    assert.equal(f.sig, 'spurious-disconnect');
    assert.match(f.detail, /^r4 on #0: onDisconnect while disconnected$/);
    const lc1 = lcOf([reg({ r: 4, phase: 1 })], []);
    assert.equal(O.checkLcFire(lc1, 4, 'onDisconnect'), null);
    assert.equal(lc1.regs[4].phase, 0);
});

test('spurious-connect / spurious-disconnect (rest, rule a): a fire on a quiet target; ran-member and new-target twins silent', () => {
    // quiet connected target: sinkSet {1} equals the previous rest's, nobody ran, target existed
    const m1 = world(1);
    const prev1 = [[0, new Set([1])]];
    const fc = oneOf(m1, reg({ phase: 1, fires: ['onConnect'] }), prev1);
    assert.deepEqual(sigs(fc), ['spurious-connect']);
    assert.match(fc[0].detail, /on a quiet target \(sinks 1\)$/);
    assert.match(fc[0].detail, /^r1 on #0: onConnect on a quiet target/);
    // twin: a sink member ran this op (it may legitimately have retracked) -> silent
    assert.deepEqual(oneOf(m1, reg({ phase: 1, fires: ['onConnect'] }), prev1, new Set([1])), []);
    // twin: the target did not exist at the last rest -> silent
    assert.deepEqual(oneOf(m1, reg({ phase: 1, fires: ['onConnect'] }), []), []);
    // twin: no fire at all -> silent
    assert.deepEqual(oneOf(m1, reg({ phase: 1, fires: [] }), prev1), []);
    // quiet disconnected target
    const m0 = world(0);
    const fd = oneOf(m0, reg({ phase: 0, fires: ['onDisconnect'] }), [[0, new Set()]]);
    assert.deepEqual(sigs(fd), ['spurious-disconnect']);
    assert.match(fd[0].detail, /onDisconnect on a quiet target \(sinks 0\)$/);
    assert.deepEqual(oneOf(m0, reg({ phase: 0, fires: [] }), [[0, new Set()]]), []);
    // the sig follows the FIRST fired kind
    const fm = oneOf(m1, reg({ phase: 1, fires: ['onDisconnect', 'onConnect'] }), prev1);
    assert.deepEqual(sigs(fm), ['spurious-disconnect']);
});

test('missed-connect: sinks > 0 at rest but the registration is disconnected; the connected twin is silent', () => {
    const m = world(2);
    const prev = [[0, new Set()]];   // sinkSet changed since the last rest, so rule (a) is not in play
    const f = oneOf(m, reg({ phase: 0 }), prev);
    assert.deepEqual(sigs(f), ['missed-connect']);
    assert.match(f[0].detail, /^r1 on #0: disconnected at rest, sinks 2$/);
    assert.deepEqual(oneOf(m, reg({ phase: 1 }), prev), []);
});

test('missed-disconnect: sinks 0 at rest but the registration is connected; the disconnected twin is silent', () => {
    const m = world(0);
    const prev = [[0, new Set([1])]];
    const f = oneOf(m, reg({ phase: 1 }), prev);
    assert.deepEqual(sigs(f), ['missed-disconnect']);
    assert.match(f[0].detail, /^r1 on #0: connected at rest, sinks 0$/);
    assert.deepEqual(oneOf(m, reg({ phase: 0 }), prev), []);
});

test('stale-off: a phase mismatch after an off of a sibling registration (and the matching twin is silent)', () => {
    const m = world(1);
    const prev = [[0, new Set()]];
    const g = reg({ phase: 0, sibOff: { r: 2, step: 7 } });
    const f = oneOf(m, g, prev);
    assert.deepEqual(sigs(f), ['stale-off']);
    assert.match(f[0].detail, /^r1 on #0: disconnected at rest, sinks 1 after off of r2 on #0 \(sibling\) at step 7$/);
    assert.deepEqual(oneOf(m, reg({ phase: 1, sibOff: { r: 2, step: 7 } }), prev), [], 'phase matches: nothing owed');
    // the connected-at-rest direction also reports stale-off
    const f0 = oneOf(world(0), reg({ phase: 1, sibOff: { r: 2, step: 7 } }), [[0, new Set([1])]]);
    assert.deepEqual(sigs(f0), ['stale-off']);
    assert.match(f0[0].detail, /connected at rest, sinks 0 after off of r2 on #0 \(sibling\) at step 7$/);
});

test('stale-off (dead target variant): an off on a target that died before this registration was created', () => {
    const m = world(1);
    const f = oneOf(m, reg({ phase: 0, deadOff: { step: 9 } }), [[0, new Set()]]);
    assert.deepEqual(sigs(f), ['stale-off']);
    assert.match(f[0].detail, /\(dead target\) at step 9$/);
    assert.deepEqual(oneOf(m, reg({ phase: 1, deadOff: { step: 9 } }), [[0, new Set()]]), [], 'twin: phase matches');
});

/* ---- precedence, co-registered suffix, adoption -------------------------------------------------------------- */

test('co-registered suffix: appended to missed-* when another live registration overlapped; absent without it', () => {
    const m = world(1);
    const prev = [[0, new Set()]];
    const f = oneOf(m, reg({ phase: 0, co: new Set([2]) }), prev);
    assert.deepEqual(sigs(f), ['missed-connect']);
    assert.match(f[0].detail, /^r1 on #0: disconnected at rest, sinks 1 \(co-registered r2\)$/);
    const fd = oneOf(world(0), reg({ phase: 1, co: new Set([2]) }), [[0, new Set([1])]]);
    assert.deepEqual(sigs(fd), ['missed-disconnect']);
    assert.match(fd[0].detail, / \(co-registered r2\)$/);
    assert.doesNotMatch(oneOf(m, reg({ phase: 0 }), prev)[0].detail, /co-registered/, 'twin: no overlap, no suffix');
});

test('precedence: stale-off (case c) wins over missed-* (case b) and over the co-registered suffix; one failure per registration', () => {
    const m = world(1);
    const prev = [[0, new Set()]];
    const both = oneOf(m, reg({ phase: 0, co: new Set([2]), sibOff: { r: 2, step: 5 } }), prev);
    assert.deepEqual(sigs(both), ['stale-off'], 'sibling variant');
    assert.doesNotMatch(both[0].detail, /co-registered/);
    const dead = oneOf(m, reg({ phase: 0, co: new Set([2]), deadOff: { step: 6 } }), prev);
    assert.deepEqual(sigs(dead), ['stale-off'], 'dead-target variant');
    assert.doesNotMatch(dead[0].detail, /co-registered/);
    // each registration is judged on its own: r1 stale-off, r2 plain missed-connect, in one pass
    const two = rest(m, [reg({ r: 1, phase: 0, sibOff: { r: 2, step: 5 } }), reg({ r: 2, phase: 0 })], prev);
    assert.deepEqual(sigs(two).sort(), ['missed-connect', 'stale-off']);
});

test('registration made inside a callback starts phase-free (-1): its first fire sets the phase, no failure either way', () => {
    const a = lcOf([reg({ r: 5, phase: -1 })], []);
    assert.equal(O.checkLcFire(a, 5, 'onConnect'), null, 'a connect from -1 is not spurious');
    assert.equal(a.regs[5].phase, 1);
    const b = lcOf([reg({ r: 5, phase: -1 })], []);
    assert.equal(O.checkLcFire(b, 5, 'onDisconnect'), null, 'a disconnect from -1 is not spurious');
    assert.equal(b.regs[5].phase, 0);
});

test('phase -1 with no fire by the next rest adopts the model phase (stated weakness) and reports nothing', () => {
    const on = lcOf([reg({ r: 5, phase: -1 })], [[0, new Set()]]);
    assert.deepEqual(O.checkLcRest(on, world(2), new Map(), new Set()), []);
    assert.equal(on.regs[5].phase, 1, 'sinks 2 -> adopts connected');
    const off = lcOf([reg({ r: 5, phase: -1 })], [[0, new Set([1])]]);
    assert.deepEqual(O.checkLcRest(off, world(0), new Map(), new Set()), []);
    assert.equal(off.regs[5].phase, 0, 'sinks 0 -> adopts disconnected');
});

/* ---- target dispose, O7a ------------------------------------------------------------------------------------- */

test('target dispose ends a registration: no disconnect owed at rest, whatever the phase', () => {
    const m = world(0);
    m.n[0].live = false;   // the target was disposed (L4: no callback owed; #40 drops the entry)
    assert.deepEqual(oneOf(m, reg({ phase: 1 }), [[0, new Set([1])]]), []);
    assert.deepEqual(oneOf(m, reg({ phase: 0 }), [[0, new Set([1])]]), []);
});

test('O7a dead-registration-fire: a fire after target dispose is O7a (not O7); the live twin is silent', () => {
    const m = world(1);
    assert.equal(O.checkFire(m, 1, 'onConnect'), null, 'twin: live registration on a live target');
    m.n[0].live = false;
    const f = O.checkFire(m, 1, 'onDisconnect');
    assert.equal(f.oracle, 'O7a');
    assert.equal(f.sig, 'dead-registration-fire');
    assert.match(f.detail, /^onDisconnect fired for registration r1 on #0: target #0 disposed$/);
    // the lane gates O7 behind O7a: checkLcFire is only called after checkFire passes, so the dead fire never heads O7
    assert.notEqual(f.oracle, 'O7');
});

test('O7a: a fire after the registration is off is O7a "registration off"', () => {
    const m = world(1);
    m.offReg(1);
    const f = O.checkFire(m, 1, 'onConnect');
    assert.equal(f.sig, 'dead-registration-fire');
    assert.match(f.detail, /registration off$/);
});

/* ---- generator rule (Q3 / A1): callbacks never throw ---------------------------------------------------------- */

test('Q3: a throwing lifecycle callback escapes as O6 escape-TypeError (reported, not swallowed); an unmodelled action throws', async () => {
    const { LIFECYCLE: L } = await import('../bench/soak/lanes/lifecycle.mjs');
    const script = (act) => ({ genVersion: 1, lane: 'LIFECYCLE', seed: 1, large: false, covOff: null, flushPasses: null, ops: [{o:'sig',i:0,v:1},{o:'sig',i:1,v:2},{o:'sig',i:2,v:3},{o:'sig',i:3,v:4},{o:'seq',ops:[{o:'lreg',r:0,i:0,a:act},{o:'eff',i:4,spec:{k:'sum',d:[0,1,2],try:true}}]}] });
    const res = runWorld(liteAdapter, script({on:1,k:'set',x:4,v:7}), { laneOps: L.ops });
    assert.equal(res.failure.fails[0].oracle, 'O6');
    assert.equal(res.failure.fails[0].sig, 'escape-TypeError');
    assert.throws(() => runWorld(liteAdapter, script({on:2,k:'disp',x:2}), { laneOps: L.ops }), /unmodelled lifecycle op/);
    const throwing = { ...liteAdapter, open(o) { const w = liteAdapter.open(o); return { ...w, dispose() { throw new TypeError('injected dispose'); } }; } };
    const sw = runWorld(throwing, script({ on: 1, k: 'disp', x: 2 }), { laneOps: L.ops }).failure; assert.equal(sw.fails[0].oracle, 'O6'); assert.match(sw.fails[0].detail, /^lifecycle callback r0 onConnect: TypeError: injected dispose/);
});

/* ---- gate-teeth rows (round 1) --------------------------------------------------------------------------------- */

test('X1: rule a -- a ran non-reader keeps the target quiet; a ran direct reader un-quiets it', () => {
    const m = world(1); m.addSignal(2, 1, {}); m.addEffect(3, { k: 'sum', d: [2] }); m.n[3].runs = 1; m.n[3].links = [2]; m.addEffect(4, { k: 'sum', d: [0] }); m.n[4].runs = 1; m.n[4].links = []; const prev = [[0, new Set([1])]];
    assert.deepEqual(sigs(oneOf(m, reg({ phase: 1, fires: ['onConnect'] }), prev, new Set([3]))), ['spurious-connect']);
    assert.deepEqual(oneOf(m, reg({ phase: 1, fires: ['onConnect'] }), prev, new Set([4])), []);
});

test('X2: quiet rule compares the sink SET, not its size', () => {
    assert.deepEqual(oneOf(world(1), reg({ phase: 1, fires: ['onConnect'] }), [[0, new Set([7])]]), []);
});

test('X3: checkLcFire records the fire so rule a sees it', () => {
    const lc = lcOf([reg({ phase: 0 })], [[0, new Set([1])]]); assert.equal(O.checkLcFire(lc, 1, 'onConnect'), null); assert.deepEqual(lc.regs[1].fires, ['onConnect']); assert.deepEqual(sigs(O.checkLcRest(lc, world(1), new Map(), new Set())), ['spurious-connect']);
});

test('X4: sibOff beats deadOff in the stale-off detail', () => {
    const f = oneOf(world(1), reg({ phase: 0, sibOff: { r: 2, step: 5 }, deadOff: { r: 3, d: 9, step: 6 } }), [[0, new Set()]]); assert.deepEqual(sigs(f), ['stale-off']); assert.match(f[0].detail, /\(sibling\) at step 5$/);
});

test('X5: a never-ran live effect counts its evalBody reads in sinkCount', () => {
    const m = new Model(CAPS); m.addSignal(0, 1, {}); m.addEffect(1, { k: 'sum', d: [0] }); assert.equal(m.n[1].links, null); assert.equal(m.sinkCount(0, new Map()), 1);
});

/* ---- B2d generator rows (b111, PLAN-R2 AD5): the armed actions reach L7a and L8c -------------------------------- */

// 40 default-rule worlds of the census cycle (seedFor(0xC0FFEE, LIFECYCLE, 0)); `seqs` = every armed cbarm seq.
async function armedSeqs(covOff) {
    const { LIFECYCLE: L } = await import('../bench/soak/lanes/lifecycle.mjs');
    const { generateWorld } = await import('../bench/soak/gen.mjs');
    const { seedFor, worldSeed } = await import('../bench/soak/seeds.mjs');
    const cyc = seedFor(0xC0FFEE, L.index, 0);
    const worlds = [];
    for (let w = 0; w < 40; w++) {
        const sc = generateWorld(L, worldSeed(cyc, w), { covOff });
        worlds.push(sc.ops.filter((o) => o.o === 'seq' && o.ops.some((s) => s.o === 'lreg' && s.a !== undefined)).map((o) => o.ops));
    }
    return { L, worlds };
}
const armedOf = (q) => q.filter((s) => s.o === 'lreg' && s.a !== undefined);
const effOf = (q) => q.find((s) => s.o === 'eff');
// A standalone script from one generated seq: node and registration ids renumbered from 0 (exec needs fresh ids).
function seqScript(q) {
    const nm = new Map(), rm = new Map();
    for (const s of q) if (s.o === 'sig' || s.o === 'eff') nm.set(s.i, nm.size);
    for (const s of q) if (s.o === 'lreg') rm.set(s.r, rm.size);
    const n = (i) => nm.get(i), r = (i) => rm.get(i);
    const ops = q.map((s) => {
        if (s.o === 'sig') return { ...s, i: n(s.i) };
        if (s.o === 'eff') return { ...s, i: n(s.i), spec: { ...s.spec, d: s.spec.d.map(n) } };
        if (s.o === 'stop') return { ...s, i: n(s.i) };
        if (s.o !== 'lreg') throw new Error('seqScript: unexpected op ' + s.o);
        const a = s.a === undefined ? undefined : (s.a.k === 'loff' ? { ...s.a, r: r(s.a.r) } : { ...s.a, x: n(s.a.x) });
        return a === undefined ? { ...s, r: r(s.r), i: n(s.i) } : { ...s, r: r(s.r), i: n(s.i), a };
    });
    return { genVersion: 1, lane: 'LIFECYCLE', seed: 1, large: false, covOff: null, flushPasses: null, ops: [{ o: 'seq', ops }] };
}

test('B2d L7a: an on-0 disp arm disposes the stop walk\'s NEXT link (E.d[1]) in most worlds; the L7b twin stays; on 1 never', async () => {
    const { worlds } = await armedSeqs(null);
    let next = 0, later = 0, on1Next = 0, wNext = 0;
    for (const w of worlds) {
        let hit = false;
        for (const q of w) {
            for (const g of armedOf(q)) {
                if (g.a.k !== 'disp') continue;
                const e = effOf(q);
                assert.equal(e.spec.d[0], g.i, 'the armed registration sits on E\'s first read');
                assert.equal(e.spec.d.length, 3);
                const stopped = q.some((s) => s.o === 'stop' && s.i === e.i);
                assert.equal(stopped, g.a.on === 0, 'on 0 <=> E is stopped in the same seq');
                if (g.a.on === 1) { if (g.a.x === e.spec.d[1]) on1Next++; continue; }
                if (g.a.x === e.spec.d[1]) { next++; hit = true; } else if (g.a.x === e.spec.d[2]) later++;
                else assert.fail('on-0 disp victim is not a later read of E');
            }
        }
        if (hit) wNext++;
    }
    assert.ok(wNext >= 30, 'worlds with the L7a next-link arm: ' + wNext + '/40');
    assert.ok(later > 0 && next > later, 'next ' + next + ' vs non-adjacent ' + later);
    assert.equal(on1Next, 0);
});

test('B2d L8c: the loff arm is a mirror pair on one fresh target, A first (A offs B, B offs A); cov-off never emits it', async () => {
    const { worlds } = await armedSeqs(null);
    let wPair = 0;
    for (const w of worlds) {
        let hit = false;
        for (const q of w) {
            const gs = armedOf(q);
            if (!gs.some((g) => g.a.k === 'loff')) continue;
            assert.equal(q.filter((s) => s.o === 'lreg').length, 2, 'exactly the pair, no unarmed sibling');
            assert.equal(gs.length, 2, 'both registrations armed');
            const [A, B] = gs;
            assert.ok(A.a.k === 'loff' && B.a.k === 'loff' && A.a.on === B.a.on);
            assert.ok(A.i === B.i && B.r === A.r + 1 && q.indexOf(A) < q.indexOf(B), 'A registered first on the same target');
            assert.equal(A.a.r, B.r, 'A offs the later B (L8c)');
            assert.equal(B.a.r, A.r, 'B offs the earlier A (the overwrite-kernel twin)');
            assert.equal(effOf(q).spec.d[0], A.i);
            hit = true;
        }
        if (hit) wPair++;
    }
    assert.ok(wPair >= 30, 'worlds with the L8c mirror pair: ' + wPair + '/40');
    const off = await armedSeqs('lc-two-regs');
    assert.ok(off.worlds.flat().length > 0, 'cov-off armed seqs checked');
    for (const w of off.worlds) for (const q of w) assert.equal(q.filter((s) => s.o === 'lreg').length, 1, 'single-reg: one registration per armed seq');
});

test('B2d fire is certain on the tree (overwrite) kernel: the generated L7a and L8c seqs run their action, no failure', async () => {
    const { L, worlds } = await armedSeqs(null);
    const all = worlds.flat();
    const q7 = all.find((q) => armedOf(q).some((g) => g.a.k === 'disp' && g.a.on === 0 && g.a.x === effOf(q).spec.d[1]));
    const q8 = all.find((q) => armedOf(q).some((g) => g.a.k === 'loff'));
    assert.ok(q7 !== undefined && q8 !== undefined, 'both shapes generated');
    const r7 = runWorld(liteAdapter, seqScript(q7), { laneOps: L.ops });
    assert.equal(r7.failure, null);
    assert.equal(r7.scen['lc-callback-dispose'], 1);
    const r8 = runWorld(liteAdapter, seqScript(q8), { laneOps: L.ops });
    assert.equal(r8.failure, null);
    assert.equal(r8.scen['lc-callback-off-sibling'], 1, 'exactly one of the mirror pair fires and offs its sibling');
});

test('B2d G0: the shadow applies every armed disp victim and both offs of the mirror pair (40 worlds)', async () => {
    const { LIFECYCLE: L } = await import('../bench/soak/lanes/lifecycle.mjs'); const { Gen } = await import('../bench/soak/gen.mjs'); const { seedFor, worldSeed } = await import('../bench/soak/seeds.mjs');
    let n7 = 0, n8 = 0;
    for (let w = 0; w < 40; w++) { const g = new Gen(L, worldSeed(seedFor(0xC0FFEE, L.index, 0), w), {}); g.large = false; L.init(g);
        for (let s = 0; s < 400; s++) { const k = g.ops.length; L.step(g); const o = g.ops[k]; if (o === undefined || o.o !== 'seq') continue;
            for (const r of o.ops) if (r.o === 'lreg' && r.a !== undefined && r.a.k === 'disp') { n7++; assert.equal(g.M.n[r.a.x].live, false, 'disp victim live in the shadow'); }
            else if (r.o === 'lreg' && r.a !== undefined && r.a.k === 'loff') { n8++; assert.equal(g.M.regs[r.r].live, false, 'pair reg live in the shadow'); } } }
    assert.ok(n7 >= 100 && n8 >= 100, 'disp ' + n7 + ' loff ' + n8);
});

/* ---- B2e generator rows (b111, PLAN-R2 AD6): the L7c retrack trim (early-exit 'outer' body, this shape only) ------ */

// An L7c op is { seq [ { seq build }, arm ] } (lanes/lifecycle.mjs trimOps); `trims` = every one, per world.
const isTrim = (o) => o.o === 'seq' && o.ops.length === 2 && o.ops[0].o === 'seq' && o.ops[1].o === 'arm';
async function trimSeqs(covOff) {
    const { LIFECYCLE: L } = await import('../bench/soak/lanes/lifecycle.mjs');
    const { generateWorld } = await import('../bench/soak/gen.mjs');
    const { seedFor, worldSeed } = await import('../bench/soak/seeds.mjs');
    const cyc = seedFor(0xC0FFEE, L.index, 0);
    const worlds = [];
    for (let w = 0; w < 40; w++) worlds.push(generateWorld(L, worldSeed(cyc, w), { covOff }).ops.filter(isTrim));
    return { L, worlds };
}
// A standalone script from one L7c op: node and registration ids renumbered from 0 (exec needs fresh ids).
function trimScript(o) {
    const q = o.ops[0].ops, arm = o.ops[1];
    const nm = new Map(), rm = new Map();
    for (const s of q) if (s.o === 'sig' || s.o === 'eff') nm.set(s.i, nm.size);
    for (const s of q) if (s.o === 'lreg') rm.set(s.r, rm.size);
    const n = (i) => nm.get(i), r = (i) => rm.get(i);
    const ops = q.map((s) => {
        if (s.o === 'sig') return { ...s, i: n(s.i) };
        if (s.o === 'eff') return { ...s, i: n(s.i), spec: { ...s.spec, t: n(s.spec.t), pre: s.spec.pre.map(n), post: s.spec.post.map(n) } };
        if (s.o !== 'lreg') throw new Error('trimScript: unexpected op ' + s.o);
        return s.a === undefined ? { ...s, r: r(s.r), i: n(s.i) } : { ...s, r: r(s.r), i: n(s.i), a: { ...s.a, x: n(s.a.x) } };
    });
    return { genVersion: 1, lane: 'LIFECYCLE', seed: 1, large: false, covOff: null, flushPasses: null,
        ops: [{ o: 'seq', ops: [{ o: 'seq', ops }, { ...arm, O: n(arm.O), t: n(arm.t) }] }] };
}

test('B2e L7c: the trim arm drops three consecutive reads [a, b, c] and a\'s on-0 disp kills b, the NEXT dropped link', async () => {
    const { worlds } = await trimSeqs(null);
    let wTrim = 0, n = 0;
    for (const w of worlds) {
        if (w.length > 0) wTrim++;
        for (const o of w) {
            n++;
            const q = o.ops[0].ops, arm = o.ops[1];
            const sigs = q.filter((s) => s.o === 'sig'), regs = q.filter((s) => s.o === 'lreg'), es = q.filter((s) => s.o === 'eff');
            assert.equal(sigs.length, 4, 'fresh t, a, b, c');
            assert.equal(es.length, 1);
            const E = es[0];
            assert.equal(E.spec.k, 'outer');
            assert.deepEqual(E.spec.pre, [], 'nothing read between t and the dropped run');
            assert.equal(E.spec.ic, null);
            assert.equal(E.spec.t, sigs[0].i);
            assert.deepEqual(E.spec.post, [sigs[1].i, sigs[2].i, sigs[3].i], 'post = a, b, c: fresh, consecutive, all dropped');
            assert.equal(regs.length, 3, 'one registration on each dropped source');
            assert.deepEqual(regs.map((g) => g.i), E.spec.post);
            assert.deepEqual(regs[0].a, { on: 0, k: 'disp', x: E.spec.post[1] }, 'a\'s onDisconnect disposes b (adjacent, not c)');
            assert.ok(regs[1].a === undefined && regs[2].a === undefined, 'b and c unarmed');
            assert.ok(!q.some((s) => s.o === 'stop' || s.o === 'disp'), 'the walk is the trim, not a stop');
            assert.deepEqual([arm.O, arm.early, arm.t, arm.x, arm.at, arm.child, arm.reg, arm.flip, arm.pull], [E.i, 1, E.spec.t, -1, -1, -1, -1, -1, 0]);
            assert.ok(Number.isInteger(arm.v) && arm.v >= 0 && arm.v !== sigs[0].v, 'the write changes t, so E re-runs');
        }
    }
    assert.ok(wTrim >= 25, 'worlds with the L7c trim arm: ' + wTrim + '/40');
    const off = await trimSeqs('lc-two-regs');
    assert.ok(off.worlds.flat().length > 0, 'cov-off still generates L7c (one registration per target)');
});

test('B2e L7c G0: the shadow applies E\'s early mode, t\'s write and b\'s death; it predicts E\'s post-trim reads [t]', async () => {
    const { LIFECYCLE: L } = await import('../bench/soak/lanes/lifecycle.mjs'); const { Gen } = await import('../bench/soak/gen.mjs'); const { seedFor, worldSeed } = await import('../bench/soak/seeds.mjs');
    const { decodeValue } = await import('../bench/soak/kinds.mjs');
    let n = 0;
    for (let w = 0; w < 40; w++) {
        const g = new Gen(L, worldSeed(seedFor(0xC0FFEE, L.index, 0), w), {}); g.large = false; L.init(g);
        for (let s = 0; s < 400; s++) {
            const k = g.ops.length; L.step(g); const o = g.ops[k]; if (o === undefined || !isTrim(o)) continue;
            n++;
            const E = o.ops[0].ops.find((x) => x.o === 'eff'), arm = o.ops[1], [a, b, c] = E.spec.post;
            const M = g.M, memo = new Map();
            assert.equal(M.n[E.i].mode.early, true, 'early mode in the shadow');
            assert.ok(Object.is(M.n[arm.t].v, decodeValue(arm.v)), 't written in the shadow');
            assert.equal(M.n[b].live, false, 'victim b dead in the shadow');
            assert.deepEqual(M.evalBody(E.i, memo).seen.map((x) => x.r), [arm.t], 'E reads [t] after the trim');
            assert.deepEqual([M.sinkCount(a, memo), M.sinkCount(c, memo)], [0, 0], 'a and c disconnected');
            assert.ok(M.sinkSet(arm.t, memo).has(E.i), 'E still observes t');
        }
    }
    assert.ok(n >= 40, 'L7c ops ' + n);
});

test('B2e L7c fire is certain on the tree kernel: every generated trim runs a\'s disp, model == engine (no failure)', async () => {
    const { L, worlds } = await trimSeqs(null);
    const all = worlds.flat();
    assert.ok(all.length >= 40);
    for (const o of all) {
        const r = runWorld(liteAdapter, trimScript(o), { laneOps: L.ops });
        assert.equal(r.failure, null);
        assert.equal(r.scen['lc-callback-dispose'], 1);
    }
});
