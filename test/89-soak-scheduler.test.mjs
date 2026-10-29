// test/89-soak-scheduler.test.mjs -- burst 131, R4c batch H1 (PLAN-R4-recycle-sched.md TASK 3, contract O16).
// Oracle: the O16 interface contract (SIGS.O9 4th sig 'stale-thunk', ORACLES has 'O9', checkStaleThunk) and the T0 facts
// (.handoff/b131-evidence/r4c/T0-FACTS.md sections b + c; probe shapes of probe-sched.mjs). No value comes from running new code.
// Groups: REG, ORACLE (fires / silent), MALFORMED (TypeError matrix), KERNEL (tree facts), MUTANT (thunkgen built at runtime).
// ORACLE / REG rows are new (no prior export): they fail on the old code by call. KERNEL rows are regression pins of engine facts.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../bench/soak/oracles.mjs';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { ORACLES, SIGS } = O;
const BEFORE_SIG = fileURLToPath(new URL('../Signal.js', import.meta.url));
const BEFORE_WATCH = fileURLToPath(new URL('../Watch.js', import.meta.url));
const SRC = readFileSync(BEFORE_SIG, 'utf8');
const sha8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const count = (s, a) => s.split(a).length - 1;

describe('O9 registration (stale-thunk)', () => {
    it('SIGS.O9 deep-equals the four sigs; ORACLES includes O9', () => {
        assert.deepEqual(SIGS.O9, ['stale-write', 'stale-read', 'stale-dispose', 'stale-thunk']);
        assert.ok(ORACLES.includes('O9'));
    });
    it('SIGS.O9 has the same freeze state as its sibling entry', () => {
        assert.equal(Object.isFrozen(SIGS.O9), Object.isFrozen(SIGS.O8));
        assert.ok(Object.isFrozen(SIGS));
    });
    it('checkStaleThunk is exported as a function', () => assert.equal(typeof O.checkStaleThunk, 'function'));
});

const expectFind = (r) => {
    assert.notEqual(r, null);
    assert.equal(r.oracle, 'O9');
    assert.equal(r.sig, 'stale-thunk');
    assert.equal(typeof r.detail, 'string');
};

describe('ORACLE: checkStaleThunk', () => {
    const f = (...a) => O.checkStaleThunk(...a);
    it('ran === cur, curDead false -> null', () => assert.equal(f('t', 1, 1, false), null));
    it('zeros -> null', () => assert.equal(f('t', 0, 0, false), null));
    it('ran !== cur (body of another node) -> stale-thunk', () => expectFind(f('t', 0, 1, false)));
    it('ran !== cur (other direction) -> stale-thunk', () => expectFind(f('t', 2, 1, false)));
    it('curDead true, ran === cur -> stale-thunk', () => expectFind(f('t', 1, 1, true)));
    it('curDead true, ran !== cur -> stale-thunk', () => expectFind(f('t', 1, 2, true)));
});

describe('MALFORMED: checkStaleThunk TypeError matrix', () => {
    const BAD = [-0, NaN, 1.5, -1, '1', null, undefined, Infinity, 2 ** 53, Object(1)];
    const nm = (v) => (Object.is(v, -0) ? '-0' : typeof v + ' ' + String(v));
    const TE = /^TypeError: checkStaleThunk: /;
    const call = (...a) => () => O.checkStaleThunk(...a);
    for (const l of [7, null, undefined, {}, [], -0]) it('bad label ' + nm(l), () => assert.throws(call(l, 1, 1, false), TE));
    for (const v of BAD) {
        it('cur = ' + nm(v), () => assert.throws(call('t', v, 1, false), TE));
        it('ran = ' + nm(v), () => assert.throws(call('t', 1, v, false), TE));
    }
    for (const v of [0, 1, 'true', null, undefined]) it('curDead = ' + nm(v), () => assert.throws(call('t', 1, 1, v), TE));
    it('fail closed even when a bad count would hide a finding', () => {
        assert.throws(call('t', 1, NaN, true), TE);
        assert.throws(call('t', NaN, 1, true), TE);
        assert.throws(call('t', 1, 2, 'true'), TE);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Kernel scenario (probe-sched.mjs 'srec' shape): FIFO queue, every scheduled effect has its own scheduler fn.
const CFG = { maxNodes: 4096, onCapacityExceeded: 'grow' };
const ptr = (h) => h[Object.getOwnPropertySymbols(h).find((y) => y.description === 'node_ptr')];
const world = (K) => {
    const r = K.createRegistry(CFG);
    const q = [];
    const runs = {};
    const eff = (tag, src) => {
        runs[tag] = 0;
        return r.effect(() => { src(); runs[tag]++; }, { scheduler: function (run) { q.push({ tag, run }); } });
    };
    const drain = () => {   // FIFO; log "X->Y+n" = delivering X's thunk ran Y's body n times
        const log = [];
        while (q.length) {
            const e = q.shift();
            const b = { ...runs };
            e.run();
            const d = Object.keys(runs).filter((k) => runs[k] !== b[k]).map((k) => k + '+' + (runs[k] - b[k]));
            log.push(e.tag + '->' + (d.length ? d.join('&') : '0'));
        }
        return log;
    };
    return { r, q, runs, eff, drain };
};
const srec = (K, phase) => {
    const w = world(K);
    const s = w.r.signal(0);
    const A = w.eff('A', s);
    if (phase === 'rerun') { w.drain(); s.set(1); }   // A's re-run thunk is the pending one
    const pa = ptr(A);
    let B = null;
    w.r.batch(() => { A(); B = w.eff('B', s); });   // dispose pended A, scheduled successor B reuses A's slot
    const sameSlot = ptr(B) === pa;
    const queue = w.q.map((e) => e.tag).join(',');
    const log = w.drain();
    const out = { sameSlot, queue, log, A: w.runs.A, B: w.runs.B };
    w.r.destroy?.();
    return out;
};

// T0 b (FIFO dead-before-successor): queue A,B -> [A->0, B->B+1]. Counts: first-run A 0 / B 1; rerun A 1 / B 1.
const EXPECT_TREE = {
    'first-run': { sameSlot: true, queue: 'A,B', log: ['A->0', 'B->B+1'], A: 0, B: 1 },
    'rerun': { sameSlot: true, queue: 'A,B', log: ['A->0', 'B->B+1'], A: 1, B: 1 },
};
// T0 c (tree-thunkgen): dead A's delivery runs B's pending body [A->B+1, B->0]; body totals unchanged.
const EXPECT_MUT = {
    'first-run': { sameSlot: true, queue: 'A,B', log: ['A->B+1', 'B->0'], A: 0, B: 1 },
    'rerun': { sameSlot: true, queue: 'A,B', log: ['A->B+1', 'B->0'], A: 1, B: 1 },
};

let seq = 0;
const load = async (text, id) => {
    const dir = mkdtempSync(join(tmpdir(), 'h1-sch-' + id + '-'));
    try {
        writeFileSync(join(dir, 'Signal.js'), text);
        copyFileSync(BEFORE_WATCH, join(dir, 'Watch.js'));
        return await import(pathToFileURL(join(dir, 'Signal.js')).href + '?m=' + (++seq));
    } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('KERNEL: dead scheduled thunk on the frozen tree (ea0b64d1)', () => {
    it('frozen tree sha256/8 is ea0b64d1', () => assert.equal(sha8(SRC), 'ea0b64d1'));
    for (const phase of ['first-run', 'rerun']) {
        it('srec ' + phase + ': dead A delivers no body, successor B runs its own', async () => {
            const K = await load(SRC, 'ctl-' + phase);
            assert.deepEqual(srec(K, phase), EXPECT_TREE[phase]);
        });
    }
    it('dead thunk with an unscheduled-effect resident runs nothing', async () => {
        const K = await load(SRC, 'ctl-unsched');
        const w = world(K);
        const s = w.r.signal(0);
        const A = w.eff('A', s);
        const pa = ptr(A);
        A();
        let runsB = 0;
        const B = w.r.effect(() => { s(); runsB++; });
        assert.equal(ptr(B), pa, 'B took the slot');
        runsB = 0;
        assert.deepEqual(w.drain(), ['A->0']);
        assert.equal(runsB, 0);
        assert.equal(w.runs.A, 0);
    });
});

const ANCHOR = '                    if (node.gen === gen && (node.flags & FLAG_EFFECT) !== 0) executeEffect(node);\n';
const REPL = '                    if ((node.flags & FLAG_EFFECT) !== 0) executeEffect(node);\n';

describe('MUTANT: thunkgen (drop `node.gen === gen && `) is caught by the stale-thunk shape', () => {
    it('anchor occurs exactly once; mutant sha256/8 is f5b90744', () => {
        assert.equal(count(SRC, ANCHOR), 1);
        assert.equal(sha8(SRC.replace(ANCHOR, () => REPL)), 'f5b90744');
    });
    for (const phase of ['first-run', 'rerun']) {
        it('srec ' + phase + ': dead A delivery runs successor B body (A->B+1, B->0)', async () => {
            const K = await load(SRC.replace(ANCHOR, () => REPL), 'thunkgen-' + phase);
            const got = srec(K, phase);
            assert.deepEqual(got, EXPECT_MUT[phase]);
            assert.notDeepEqual(got.log, EXPECT_TREE[phase].log);
            // O16: cur = index of the delivered node (A = 0, B = 1), ran = index of the node whose body ran; A was disposed.
            // Both come from the observed first delivery log entry, so a tree log [A->0] yields ran undefined (TypeError, not a pass).
            const [cur, ran] = got.log[0].split('->').map((x) => ({ A: 0, B: 1 })[x[0]]);
            expectFind(O.checkStaleThunk('srec-' + phase, cur, ran, true));
        });
    }
});

// =====================================================================================================================
// burst 133, R4c DELTA (M7 = D-b132-1), batch H1: rows from PLAN-R4c-delta-b133.md ASSERTIONS 2 (i)-(ix) / tasks D1-D5.
// Every expected value comes from the spec text (counts and sums hand-derived in the comments), never from a run.
// "FAILS OLD" = fails on the frozen pre-delta code (by reasoning); "PIN" = regression pin of a mutant-survivor intent.
// The ScState rows drive the lane class with a minimal exec stub (real Model + real Detectors; engine calls stubbed).
// =====================================================================================================================
const SCH_URL = pathToFileURL(fileURLToPath(new URL('../bench/soak/lanes/scheduler.mjs', import.meta.url))).href;
const { ScState, POLICY, policyOf, MAX_NODES, SCHEDULER } = await import(SCH_URL);
const { Model } = await import('../bench/soak/model.mjs');
const { Detectors, SCENARIOS } = await import('../bench/soak/scenarios.mjs');

const OPS = SCHEDULER.ops;
const SPEC = (d) => ({ k: 'sum', d: [d], role: 'sc' });

// Stub world. Nodes: signals 0,1,2; computed 3; scheduled effects 5,6,7; plain effect 8; scheduled effect 9 (model only, no H).
const mkWorld = (policy) => {
    const fails = [];
    const dids = {};
    const x = {
        M: new Model({}), H: [], sc: null, unmodelled: null, script: { seed: 1 }, batchDepth: 0, fails, dids,
        did(o) { dids[o] = (dids[o] || 0) + 1; },
        failF(f) { fails.push(f); },
        guard(fn) { fn(); },
        setTop() {},
        disposeIdx(j) { x.M.n[j].live = false; },
        runBody() {},
        W: { batch(fn) { fn(); }, effect() { return {}; } },
    };
    x.D = new Detectors(x);
    for (let k = 0; k < 3; k++) { x.M.addSignal(k, k + 1, {}); x.H[k] = {}; }
    x.M.addComputed(3, SPEC(0)); x.H[3] = {};
    for (const [k, sch] of [[5, 1], [6, 1], [7, 1], [8, 0], [9, 1]]) { x.M.addEffect(k, SPEC(0), -1, sch); if (k !== 9) x.H[k] = {}; }
    x.sc = new ScState(x, policy);
    return x;
};
const noop = () => {};
const pushed = (x, ...is) => { for (const i of is) x.sc.push(i, noop); };

describe('R4c delta (i): checkScheduledBody (D1)', () => {
    const f = (...a) => O.checkScheduledBody(...a);
    it('inDelivery true -> null (FAILS OLD: no export)', () => assert.equal(f('t', 3, true), null));
    it('inDelivery false -> the exact O9 stale-thunk shape', () => {
        const r = f('lbl', 7, false);
        assert.equal(r.oracle, 'O9');
        assert.equal(r.sig, 'stale-thunk');
        assert.equal(typeof r.detail, 'string');
        assert.ok(r.detail.includes('lbl: scheduled effect #7 ran its body outside any delivery'), r.detail);
    });
    it('ran = 0 is valid', () => assert.equal(f('t', 0, true), null));
    const TE = /^TypeError: checkScheduledBody: /;
    const nm = (v) => (Object.is(v, -0) ? '-0' : typeof v + ' ' + String(v));
    for (const v of [-1, -0, 1.5, NaN, '1', null, undefined, Infinity, 2 ** 53]) {
        it('ran = ' + nm(v) + ' -> TypeError', () => assert.throws(() => f('t', v, true), TE));
    }
    for (const v of [1, 0, null, undefined, {}, [], -0]) it('label = ' + nm(v) + ' -> TypeError', () => assert.throws(() => f(v, 1, true), TE));
    for (const v of [0, 1, undefined, null, 'true']) it('inDelivery = ' + nm(v) + ' -> TypeError', () => assert.throws(() => f('t', 1, v), TE));
    it('a bad ran fails closed even when inDelivery is false', () => assert.throws(() => f('t', -1, false), TE));
});

describe('R4c delta (ii): a body outside any delivery (D2)', () => {
    it('depth-1 sch-1 effect body outside a delivery -> exactly 1 stale-thunk, O9 did +1, st.outside +1 (FAILS OLD)', () => {
        const x = mkWorld(0);
        x.sc.onBody(5, 1);
        assert.equal(x.fails.length, 1);
        assert.equal(x.fails[0].oracle, 'O9');
        assert.equal(x.fails[0].sig, 'stale-thunk');
        assert.ok(x.fails[0].detail.includes('scheduled effect #5 ran its body outside any delivery'), x.fails[0].detail);
        assert.ok(x.fails[0].detail.includes('FIFO'), 'label names the policy: ' + x.fails[0].detail);
        assert.equal(x.dids.O9, 1);
        assert.equal(x.sc.st.outside, 1);
        x.sc.onBody(6, 1);
        assert.equal(x.fails.length, 2);
        assert.equal(x.dids.O9, 2);
        assert.equal(x.sc.st.outside, 2);
    });
    it('the label names each policy', () => {
        for (const p of [0, 1, 2]) {
            const x = mkWorld(p);
            x.sc.onBody(5, 1);
            assert.ok(x.fails[0].detail.includes(POLICY[p]), POLICY[p] + ': ' + x.fails[0].detail);
        }
    });
    it('sch-0 effect / computed / depth 2 / non-node / signal outside a delivery -> 0 fails, no O9 did', () => {
        const x = mkWorld(0);
        x.sc.onBody(8, 1);    // plain effect
        x.sc.onBody(3, 1);    // computed
        x.sc.onBody(5, 2);    // depth 2
        x.sc.onBody(99, 1);   // no such node
        x.sc.onBody(0, 1);    // signal
        assert.equal(x.fails.length, 0);
        assert.equal(x.dids.O9, undefined);
        assert.equal(x.sc.st.outside, 0);
    });
    it('after close() (x === null) onBody is silent and never throws', () => {
        const x = mkWorld(0);
        const sc = x.sc;
        sc.close();
        assert.doesNotThrow(() => sc.onBody(5, 1));
        assert.equal(x.fails.length, 0);
    });
});

describe('R4c delta (iii)/(iv)/(v): judged path, silent 2nd body, dlv flag (D2)', () => {
    it('(iii) PIN mutant A: a computed at depth 1, then another effect j != cur in one delivery -> 1 fail', () => {
        const x = mkWorld(0);
        x.sc.push(5, () => { x.sc.onBody(3, 1); x.sc.onBody(6, 1); });
        x.sc.deliverOne();
        assert.equal(x.fails.length, 1);
        assert.equal(x.fails[0].sig, 'stale-thunk');
        assert.equal(x.dids.O9, 1);
        assert.equal(x.sc.st.outside | 0, 0, 'inside a delivery: never counted outside');
    });
    it('(iii) a depth-2 body does not consume the judgement either', () => {
        const x = mkWorld(0);
        x.sc.push(5, () => { x.sc.onBody(6, 2); x.sc.onBody(6, 1); });
        x.sc.deliverOne();
        assert.equal(x.fails.length, 1);
    });
    it('(iii) computed then the delivered effect: judged once, 0 fails', () => {
        const x = mkWorld(0);
        x.sc.push(5, () => { x.sc.onBody(3, 1); x.sc.onBody(5, 1); });
        x.sc.deliverOne();
        assert.equal(x.fails.length, 0);
        assert.equal(x.dids.O9, 1);
    });
    it('(iv) PIN mutant G: cur body then a 2nd depth-1 sch-1 body k != cur -> 0 fails (silent), judged once', () => {
        const x = mkWorld(0);
        x.sc.push(5, () => { x.sc.onBody(5, 1); x.sc.onBody(6, 1); x.sc.onBody(7, 1); });
        x.sc.deliverOne();
        assert.equal(x.fails.length, 0);
        assert.equal(x.dids.O9, 1);
        assert.equal(x.sc.st.outside | 0, 0);
    });
    it('(v) dlv is 1 inside a delivery and 0 after it returns; the next sch-1 body fails (FAILS OLD)', () => {
        const x = mkWorld(0);
        let inside = -1;
        x.sc.push(5, () => { inside = x.sc.dlv; x.sc.onBody(5, 1); });
        assert.equal(x.sc.dlv, 0);
        x.sc.deliverOne();
        assert.equal(inside, 1);
        assert.equal(x.sc.dlv, 0);
        assert.equal(x.fails.length, 0);
        x.sc.onBody(5, 1);
        assert.equal(x.fails.length, 1);
        assert.equal(x.fails[0].sig, 'stale-thunk');
    });
    it('(v) a delivery that THROWS leaves dlv 0 and cur -1; the next sch-1 body fails (FAILS OLD)', () => {
        const x = mkWorld(0);
        x.sc.push(5, () => { throw new Error('boom'); });
        assert.throws(() => x.sc.deliverOne(), /boom/);
        assert.equal(x.sc.dlv, 0);
        assert.equal(x.sc.cur, -1);
        x.sc.onBody(6, 1);
        assert.equal(x.fails.length, 1);
    });
});

describe('R4c delta (vi): fifo-delivery / lifo-delivery under each policy (D2 + D4)', () => {
    const drainAll = (x) => { let g = 0; while (x.sc.size > 0) { if (++g > 100) throw new Error('drain bound'); x.sc.deliverOne(); } };
    // 3 queued (5, 6, 7), drain all. Hand-derived (older, younger) AFTER the pop, over the remaining entries:
    //   FIFO pops the head: (0,2) (0,1) (0,0) -> fifo-delivery on the first two = 2, lifo 0.
    //   LIFO pops the tail: (2,0) (1,0) (0,0) -> lifo-delivery = 2, fifo 0.
    //   HOLD: every entry's first pop only re-queues; each delivery is a retried one -> neither, hold-retry 3.
    it('FIFO: fifo-delivery 2, lifo-delivery 0, hold-retry 0 (FAILS OLD)', () => {
        const x = mkWorld(0);
        pushed(x, 5, 6, 7);
        drainAll(x);
        assert.equal(x.D.counts['fifo-delivery'], 2);
        assert.equal(x.D.counts['lifo-delivery'], undefined);
        assert.equal(x.D.counts['hold-retry'], undefined);
    });
    it('LIFO: lifo-delivery 2, fifo-delivery 0, hold-retry 0 (FAILS OLD)', () => {
        const x = mkWorld(1);
        pushed(x, 5, 6, 7);
        drainAll(x);
        assert.equal(x.D.counts['lifo-delivery'], 2);
        assert.equal(x.D.counts['fifo-delivery'], undefined);
        assert.equal(x.D.counts['hold-retry'], undefined);
    });
    it('HOLD: fifo-delivery 0, lifo-delivery 0, hold-retry 3', () => {
        const x = mkWorld(2);
        pushed(x, 5, 6, 7);
        drainAll(x);
        assert.equal(x.D.counts['fifo-delivery'], undefined);
        assert.equal(x.D.counts['lifo-delivery'], undefined);
        assert.equal(x.D.counts['hold-retry'], 3);
    });
    it('a single queued thunk (0,0) counts neither, under every policy', () => {
        for (const p of [0, 1, 2]) {
            const x = mkWorld(p);
            pushed(x, 5);
            drainAll(x);
            assert.equal(x.D.counts['fifo-delivery'], undefined, 'policy ' + p);
            assert.equal(x.D.counts['lifo-delivery'], undefined, 'policy ' + p);
        }
    });
    it('policyOf(seed) is in 0..2 and all three policies occur over seeds 1..64', () => {
        const seen = new Set();
        for (let s = 1; s <= 64; s++) { const p = policyOf(s); assert.ok(p === 0 || p === 1 || p === 2); seen.add(p); }
        assert.equal(seen.size, 3);
    });
    it('SCENARIOS: 66 names, fifo-delivery and lifo-delivery directly after hold-retry (D4)', () => {
        assert.equal(SCENARIOS.length, 66);
        const k = SCENARIOS.indexOf('hold-retry');
        assert.ok(k >= 0);
        assert.equal(SCENARIOS[k + 1], 'fifo-delivery');
        assert.equal(SCENARIOS[k + 2], 'lifo-delivery');
    });
    it('SCHEDULER.required has 8 keys: the six old ones then fifo-delivery, lifo-delivery', () => {
        assert.deepEqual(SCHEDULER.required.slice(0, 6), ['thunk-after-dispose', 'thunk-recycled', 'pending-write', 'partial-drain', 'drain-all', 'hold-retry']);
        assert.equal(SCHEDULER.required.length, 8);
        assert.ok(SCHEDULER.required.includes('fifo-delivery') && SCHEDULER.required.includes('lifo-delivery'));
    });
});

describe('R4c delta: Detectors.onScDeliver 5-arg contract (D4)', () => {
    const w = (size) => { const x = mkWorld(0); x.sc.size = size; return x; };
    it('older 0, younger >= 1, not retried -> fifo-delivery only', () => {
        const x = w(3);
        x.D.onScDeliver(5, false, false, 0, 3);
        assert.equal(x.D.counts['fifo-delivery'], 1);
        assert.equal(x.D.counts['lifo-delivery'], undefined);
    });
    it('younger 0, older >= 1, not retried -> lifo-delivery only', () => {
        const x = w(3);
        x.D.onScDeliver(5, false, false, 3, 0);
        assert.equal(x.D.counts['lifo-delivery'], 1);
        assert.equal(x.D.counts['fifo-delivery'], undefined);
    });
    it('older >= 1 and younger >= 1 (middle) -> neither; 0 / 0 -> neither', () => {
        const x = w(3);
        x.D.onScDeliver(5, false, false, 1, 2);
        x.sc.size = 0;
        x.D.onScDeliver(5, false, false, 0, 0);
        assert.deepEqual(Object.keys(x.D.counts), []);
    });
    it('retried -> neither fifo nor lifo, but hold-retry', () => {
        const x = w(3);
        x.D.onScDeliver(5, false, true, 0, 3);
        x.D.onScDeliver(5, false, true, 3, 0);
        assert.equal(x.D.counts['fifo-delivery'], undefined);
        assert.equal(x.D.counts['lifo-delivery'], undefined);
        assert.equal(x.D.counts['hold-retry'], 2);
    });
    const TE_INT = /^TypeError: onScDeliver: older \/ younger must be integers >= 0/;
    for (const bad of [-1, -0, 1.5, NaN, '1', null, undefined, Infinity]) {
        const nm = Object.is(bad, -0) ? '-0' : typeof bad + ' ' + String(bad);
        it('older = ' + nm + ' -> TypeError', () => assert.throws(() => w(3).D.onScDeliver(5, false, false, bad, 3), TE_INT));
        it('younger = ' + nm + ' -> TypeError', () => assert.throws(() => w(3).D.onScDeliver(5, false, false, 0, bad), TE_INT));
    }
    it('older + younger !== the queued count -> TypeError', () => {
        const re = /^TypeError: onScDeliver: older \+ younger must equal the queued count/;
        assert.throws(() => w(3).D.onScDeliver(5, false, false, 1, 1), re);
        assert.throws(() => w(3).D.onScDeliver(5, false, false, 2, 2), re);
        assert.throws(() => w(0).D.onScDeliver(5, false, false, 0, 1), re);
        assert.doesNotThrow(() => w(3).D.onScDeliver(5, false, false, 1, 2));
    });
    it('a malformed call counts nothing (fail closed before any count)', () => {
        const x = w(3);
        assert.throws(() => x.D.onScDeliver(5, false, false, 0, 1));
        assert.deepEqual(Object.keys(x.D.counts), []);
    });
});

// Exec is reached through a scratch copy of exec.mjs with an appended export (the test/43 technique).
const SOAK_DIR = fileURLToPath(new URL('../bench/soak/', import.meta.url));
const loadExec = async () => {
    const SOAK_URL = pathToFileURL(SOAK_DIR).href;
    const src = readFileSync(join(SOAK_DIR, 'exec.mjs'), 'utf8')
        .replace(/from '\.\.\//g, "from '" + SOAK_URL + '../').replace(/from '\.\//g, "from '" + SOAK_URL);
    const dir = mkdtempSync(join(tmpdir(), 'h1-sch-exec-'));
    try {
        const file = join(dir, 'exec-h1.mjs');
        writeFileSync(file, src + '\nexport { Exec as __H1Exec };\n');
        return (await import(pathToFileURL(file).href)).__H1Exec;
    } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('R4c delta (vii): close() and exec.scClosed (D2 + D5)', () => {
    it('close() on 3 queued: size 0, every ringT null, x null, dlv 0, no throw (PIN mutant E)', () => {
        const x = mkWorld(0);
        pushed(x, 5, 6, 7);
        assert.equal(x.sc.size, 3);
        assert.doesNotThrow(() => x.sc.close());
        assert.equal(x.sc.size, 0);
        for (let j = 0; j < x.sc.ringT.length; j++) assert.equal(x.sc.ringT[j], null, 'ringT[' + j + ']');
        assert.equal(x.sc.x, null);
        assert.equal(x.sc.dlv, 0);
    });
    it('scClosed: a clean closed ScState leaves unmodelled null; size 1 / x set / a function in ringT[5] -> unmodelled (FAILS OLD)', async () => {
        const Exec = await loadExec();
        assert.equal(typeof Exec.prototype.scClosed, 'function');
        const x = mkWorld(0);
        pushed(x, 5, 6, 7);
        x.sc.close();
        const clean = { sc: x.sc, unmodelled: null };
        assert.doesNotThrow(() => Exec.prototype.scClosed.call(clean));
        assert.equal(clean.unmodelled, null);
        const PRE = 'exec: SCHEDULER close(): ';
        const bad = (mut) => {
            const y = mkWorld(0);
            y.sc.close();
            mut(y.sc);
            const e = { sc: y.sc, unmodelled: null };
            assert.doesNotThrow(() => Exec.prototype.scClosed.call(e), 'scClosed never throws');
            assert.ok(e.unmodelled instanceof Error);
            assert.ok(e.unmodelled.message.startsWith(PRE), e.unmodelled.message);
        };
        bad((sc) => { sc.size = 1; });
        bad((sc) => { sc.ringT[5] = () => {}; });
        bad((sc) => { sc.x = {}; });
    });
});

const { liteS3Adapter } = await import('../bench/soak/adapters/lite-s3.mjs');
const { generateWorld } = await import('../bench/soak/gen.mjs');
const { runWorld } = await import('../bench/soak/exec.mjs');
const { seedFor, worldSeed } = await import('../bench/soak/seeds.mjs');
describe('R4c delta (vii) run() wiring: a dirty close() fails the world closed (D5)', () => {
    const script = generateWorld(SCHEDULER, worldSeed(seedFor(0xC0FFEE, SCHEDULER.index, 0), 0), { covOff: null });
    // sabotage: close() is wrapped to leave ringT[7] set; failAt: the lane op number that plants a failF
    const laneOps = (sabotage, failAt) => {
        let done = false, n = 0;
        const o = {};
        for (const k of Object.keys(SCHEDULER.ops)) o[k] = (x, op, st) => {
            const r = SCHEDULER.ops[k](x, op, st);
            if (!done && x.sc !== null && sabotage) { done = true; const c = x.sc.close; x.sc.close = function () { c.call(this); this.ringT[7] = c; }; }
            if (++n === failAt) x.failF({ oracle: 'O9', sig: 'stale-thunk', detail: 'planted' });
            return r;
        };
        return o;
    };
    const RE = /^Error: exec: SCHEDULER close\(\): ringT\[7\] not null/;
    it('control: the clean world passes', () => assert.equal(runWorld(liteS3Adapter, script, { laneOps: laneOps(false, -1) }).failure, null));
    it('dirty close() -> run() throws exec: SCHEDULER close(): (FAILS OLD)', () => {
        assert.throws(() => runWorld(liteS3Adapter, script, { laneOps: laneOps(true, -1) }), RE);
    });
    it('dirty close() on an already-failed world -> still throws (FAILS OLD)', () => {
        assert.throws(() => runWorld(liteS3Adapter, script, { laneOps: laneOps(true, 3) }), RE);
    });
    it('control: the planted fail alone fails the world (the already-failed path is real)', () => {
        const r = runWorld(liteS3Adapter, script, { laneOps: laneOps(false, 3) });
        assert.notEqual(r.failure, null);
        assert.equal(r.failure.fails[0].detail, 'planted');
    });
});

describe('R4c delta (ix) wrong kind on a dead / no-handle node (D3, review r1)', () => {
    const WK = (op, i, t) => (e) => e.message.startsWith('exec: unmodelled scheduler op: ' + op + ' #' + i + ' is a ' + t);
    it('swrite on a DEAD effect -> unmodelled', () => {
        const x = mkWorld(0); x.M.n[6].live = false;
        assert.throws(() => OPS.swrite(x, { o: 'swrite', i: 6, v: 5 }), WK('swrite', 6, 'e'));
    });
    it('swrite on a no-handle effect -> unmodelled', () => {
        const x = mkWorld(0);
        assert.throws(() => OPS.swrite(x, { o: 'swrite', i: 9, v: 5 }), WK('swrite', 9, 'e'));
    });
    it('sdisp on a DEAD computed -> unmodelled', () => {
        const x = mkWorld(0); x.M.n[3].live = false;
        assert.throws(() => OPS.sdisp(x, { o: 'sdisp', i: 3 }), WK('sdisp', 3, 'c'));
    });
    it('sdisp on a DEAD signal -> unmodelled', () => {
        const x = mkWorld(0); x.M.n[1].live = false;
        assert.throws(() => OPS.sdisp(x, { o: 'sdisp', i: 1 }), WK('sdisp', 1, 's'));
    });
    it('srec on a LIVE no-handle sch-0 effect -> unmodelled', () => {
        const x = mkWorld(0); x.H[8] = undefined;
        assert.throws(() => OPS.srec(x, { o: 'srec', i: 8, ci: 20, spec: SPEC(0) }), WK('srec', 8, 'e'));
    });
});

describe('R4c delta (viii): exec.scEnd must-fail (PIN)', () => {
    it('pend[0] = 1 -> unmodelled "exec: SCHEDULER world end: pend[0] = 1"; a plain Array pend -> TypeError; short pend -> TypeError', async () => {
        const Exec = await loadExec();
        const M = { n: [{}, {}, {}] };
        const run = (pend) => { const e = { sc: { pend }, M, unmodelled: null }; Exec.prototype.scEnd.call(e); return e.unmodelled; };
        const p = new Int32Array(8);
        assert.equal(run(p), null);
        p[0] = 1;
        const u = run(p);
        assert.ok(u instanceof Error);
        assert.ok(u.message.startsWith('exec: SCHEDULER world end: pend[0] = 1'), u.message);
        p.fill(0); p[2] = 1;   // last node index: kills a `k < n - 1` loop mutant
        const u2 = run(p);
        assert.ok(u2 instanceof Error && u2.message.startsWith('exec: SCHEDULER world end: pend[2] = 1'), String(u2 && u2.message));
        assert.ok(run([0, 0, 0]) instanceof TypeError);
        assert.ok(run(new Int32Array(2)) instanceof TypeError);
    });
});

describe('R4c delta (ix): lane ops fail closed on a bad index / wrong kind / -0 (D3 + D5)', () => {
    const PRE = (op) => 'exec: unmodelled scheduler op: ' + op + ' i ';
    const BADI = [1.5, -1, -0, MAX_NODES, '3', undefined];
    const nm = (v) => (Object.is(v, -0) ? '-0' : typeof v + ' ' + String(v));
    const OPS_ARGS = {
        swrite: (i) => ({ o: 'swrite', i, v: 5 }),
        sdisp: (i) => ({ o: 'sdisp', i }),
        srec: (i) => ({ o: 'srec', i, ci: 20, spec: SPEC(0) }),
    };
    for (const op of ['swrite', 'sdisp', 'srec']) {
        for (const i of BADI) {
            it(op + ' i = ' + nm(i) + ' -> unmodelled with the D3 prefix (FAILS OLD)', () => {
                const x = mkWorld(0);
                assert.throws(() => OPS[op](x, OPS_ARGS[op](i)), (e) => e.message.startsWith(PRE(op)) && (!Object.is(i, -0) || e.message.startsWith(PRE(op) + '-0')));
                assert.ok(x.unmodelled instanceof Error);
                assert.equal(x.fails.length, 0);
            });
        }
    }
    it('absent / dead / no-handle nodes keep the silent return (swrite, sdisp): 0 fails, no throw', () => {
        const x = mkWorld(0);
        x.M.n[1].live = false;      // dead signal
        x.M.n[6].live = false;      // dead effect
        for (const o of [OPS_ARGS.swrite(50), OPS_ARGS.swrite(1), OPS_ARGS.sdisp(50), OPS_ARGS.sdisp(6), OPS_ARGS.sdisp(9)]) {
            assert.doesNotThrow(() => OPS[o.o](x, o), JSON.stringify(o));
        }
        assert.equal(x.unmodelled, null);
        assert.equal(x.fails.length, 0);
    });
    it('srec on an absent index does not throw and fails nothing', () => {
        const x = mkWorld(0);
        assert.doesNotThrow(() => OPS.srec(x, OPS_ARGS.srec(50)));
        assert.equal(x.unmodelled, null);
        assert.equal(x.fails.length, 0);
    });
    it('swrite on a non-signal (effect 5, computed 3, effect 8) -> unmodelled "swrite #i is a <t>"', () => {
        for (const [i, t] of [[5, 'e'], [3, 'c'], [8, 'e']]) {
            const x = mkWorld(0);
            assert.throws(() => OPS.swrite(x, OPS_ARGS.swrite(i)), (e) => e.message.startsWith('exec: unmodelled scheduler op: swrite #' + i + ' is a ' + t), 'swrite #' + i);
        }
    });
    it('sdisp on a live non-effect (signal 0, computed 3) -> unmodelled "sdisp #i is a <t>"', () => {
        for (const [i, t] of [[0, 's'], [3, 'c']]) {
            const x = mkWorld(0);
            assert.throws(() => OPS.sdisp(x, OPS_ARGS.sdisp(i)), (e) => e.message.startsWith('exec: unmodelled scheduler op: sdisp #' + i + ' is a ' + t), 'sdisp #' + i);
        }
    });
    it('srec on a LIVE node that is not an sch-1 effect (signal, computed, sch-0 effect) -> unmodelled "srec #i is a <t>" (O18 b)', () => {
        for (const [i, t] of [[0, 's'], [3, 'c'], [8, 'e']]) {
            const x = mkWorld(0);
            assert.throws(() => OPS.srec(x, OPS_ARGS.srec(i)), (e) => e.message.startsWith('exec: unmodelled scheduler op: srec #' + i + ' is a ' + t), 'srec #' + i);
            assert.equal(x.M.n[20], undefined, 'nothing created');
        }
    });
    it('screate: sch -0 and ci -0 -> unmodelled (FAILS OLD); sch 1 / 0 still fine', () => {
        const mk = (ci, sch) => ({ o: 'screate', ci, spec: SPEC(0), sch });
        assert.throws(() => OPS.screate(mkWorld(0), mk(20, -0)), /^Error: exec: unmodelled scheduler op: /);
        assert.throws(() => OPS.screate(mkWorld(0), mk(-0, 1)), /^Error: exec: unmodelled scheduler op: /);
        assert.doesNotThrow(() => OPS.screate(mkWorld(0), mk(20, 1)));
        assert.doesNotThrow(() => OPS.screate(mkWorld(0), mk(21, 0)));
    });
    it('sdrain n = -0 -> unmodelled (FAILS OLD); n = 0 and n = 4 fine', () => {
        assert.throws(() => OPS.sdrain(mkWorld(0), { o: 'sdrain', n: -0 }), /^Error: exec: unmodelled scheduler op: /);
        assert.doesNotThrow(() => OPS.sdrain(mkWorld(0), { o: 'sdrain', n: 0 }));
        assert.doesNotThrow(() => OPS.sdrain(mkWorld(0), { o: 'sdrain', n: 4 }));
    });
    it('Model.addEffect sch = -0 -> TypeError mentioning "got -0" (FAILS OLD); 0 / 1 / undefined accepted', () => {
        const m = new Model({});
        assert.throws(() => m.addEffect(0, SPEC(0), -1, -0), (e) => e instanceof TypeError && e.message.includes('got -0'));
        for (const s of [0, 1, undefined]) assert.doesNotThrow(() => m.addEffect(1, SPEC(0), -1, s));
    });
});

describe('b137 76a: SCHEDULER needsCaps recycle (O9 caps)', () => {
    it('an adapter with scheduler but no recycle SKIPs SCHEDULER, never runs it with O9 dropped (FAILS OLD)', async () => {
        const { applicability } = await import('../bench/soak/adapters/contract.mjs');
        const caps = liteS3Adapter.caps;
        const app = applicability(SCHEDULER, { ...caps, recycle: false });
        assert.equal(app.status, 'skip');
        assert.deepEqual(app.missingCaps, ['recycle']);
        assert.ok(!applicability(SCHEDULER, caps).oraclesNA.includes('O9'));
    });
});
