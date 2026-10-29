// test/93-soak-capacity.test.mjs -- burst 139, R5 batch B1b (PLAN-R5-registry-capacity.md PLAN BODY 2 TASKS 1-4 + 6, ASSERTIONS A-C1 /
// A-C4 / A-C5, RULED TASK 0 deviation). Oracle: the live tree kernel through adapters/lite-s3.mjs (A-C1 numbers from
// .handoff/b139-evidence/cap/README.txt (b)), the O6 checkEscape verdicts on fake worlds, the G12 generator rule and the exec open() seam.
// The CAPACITY lane is NOT rostered until R5 B2: the lane rows wire it through runWorld's opts.laneOps.
// Groups: GEN (G12 + determinism + no key elsewhere), DETECT, SEAM (exec open), JUDGE (fake worlds), FAILCLOSED, KERNEL (A-C1, live
// Signal.js), RETENTION (A-C4).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Detectors, SCENARIOS } from '../bench/soak/scenarios.mjs';
import { CAPACITY } from '../bench/soak/lanes/capacity.mjs';
import { REGISTRY } from '../bench/soak/lanes/registry.mjs';
import { ROSTER, laneByName } from '../bench/soak/lanes/index.mjs';
import { generateWorld, scriptJson } from '../bench/soak/gen.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import { seedFor, worldSeed } from '../bench/soak/seeds.mjs';
import { liteS3Adapter } from '../bench/soak/adapters/lite-s3.mjs';
import { liteAdapter } from '../bench/soak/adapters/lite.mjs';

const sigs = (fs) => fs.map((f) => f.oracle + ':' + f.sig);
const CAP_SCEN = ['node-cap-throw', 'link-cap-throw', 'link-ceiling-grow', 'grow-past-initial', 'reuse-at-edge'];
const CYCLE_SEED = seedFor(0xC0FFEE, 12, 0);
const gen = (w, covOff) => generateWorld(CAPACITY, worldSeed(CYCLE_SEED, w), { steps: CAPACITY.worldShape.steps, covOff: covOff || null });
const run = (s, opts, ad) => runWorld(ad || liteS3Adapter, s, Object.assign({ laneOps: CAPACITY.ops }, opts || {}));
const NODE_MSG = (n) => 'CapacityError: nodes capacity (' + n + ') exceeded.';
const LINK_MSG = (n) => 'CapacityError: links capacity (' + n + ') exceeded.';

function script(capacity, ops) {
    const s = { genVersion: 1, lane: 'CAPACITY', seed: 1, large: false, covOff: null, flushPasses: null };
    if (capacity !== undefined) s.capacity = capacity;
    s.ops = ops;
    return s;
}
// 3 leaves, a computed over two, an effect over the computed: 5 nodes / 3 links
const BASE = [
    { o: 'sig', i: 0, v: 1 }, { o: 'sig', i: 1, v: 2 }, { o: 'sig', i: 2, v: 3 },
    { o: 'comp', i: 3, spec: { k: 'sum', d: [0, 1], role: 'comp' } },
    { o: 'eff', i: 4, spec: { k: 'identity', d: [3], role: 'eff' } },
];
const T32 = { maxNodes: 32, maxLinks: 64, onCapacityExceeded: 'throw' };
const G32 = { maxNodes: 32, maxLinks: 32, onCapacityExceeded: 'grow' };

/** A lite-s3 adapter whose worlds pass through `wrap(world) -> overrides`. */
function fakeAdapter(wrap) {
    return Object.freeze({ ...liteS3Adapter, open(o) { const w = liteS3Adapter.open(o); return { ...w, ...wrap(w) }; } });
}
const FAKE = Object.freeze({ fake: true });
const isCap = (e) => e !== null && typeof e === 'object' && e.constructor !== undefined && e.constructor.name === 'CapacityError';

/** G12 replay of a script: max live core nodes and the static link bound over every op prefix. */
function budget(s) {
    const live = new Map();
    let maxN = 0, maxL = 0;
    const walk = (op) => {
        if (op.o === 'seq') { for (const x of op.ops) walk(x); return; }
        if (op.o === 'sig') live.set(op.i, 0);
        else if (op.o === 'comp' || op.o === 'eff') live.set(op.i, op.spec.d.length);
        else if (op.o === 'stop' || op.o === 'disp') live.delete(op.i);
        let l = 0;
        for (const v of live.values()) l += v;
        if (live.size > maxN) maxN = live.size;
        if (l > maxL) maxL = l;
    };
    for (const op of s.ops) walk(op);
    return { maxN, maxL };
}

describe('GEN: G12 capacity cfg, budget, determinism', () => {
    it('descriptor: index 12, five required scenarios, needsCaps, covOff link-ceiling-grow -> no-ceiling, op cedge, frozen', () => {
        assert.equal(CAPACITY.name, 'CAPACITY');
        assert.equal(CAPACITY.index, 12);
        assert.deepEqual([...CAPACITY.required], CAP_SCEN);
        assert.deepEqual([...CAPACITY.needsCaps], ['capacity', 'links', 'disposeSignal', 'disposeComputed']);
        assert.deepEqual([...CAPACITY.hardOracles], ['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6']);
        assert.deepEqual({ ...CAPACITY.covOff }, { 'link-ceiling-grow': 'no-ceiling' });
        assert.deepEqual(Object.keys(CAPACITY.ops), ['cedge']);
        assert.ok(Object.isFrozen(CAPACITY) && Object.isFrozen(CAPACITY.ops));
        for (const s of CAP_SCEN) assert.ok(SCENARIOS.includes(s), s);
    });
    it('SCENARIOS: the CAPACITY ids come after the REGISTRY ids (appended last)', () => {
        const last = SCENARIOS.indexOf('reuse-after-destroy');
        assert.ok(last > 0);
        assert.deepEqual(SCENARIOS.slice(last + 1), CAP_SCEN);
    });
    it('G0 determinism: the same seed gives the same script; another seed differs', () => {
        assert.equal(scriptJson(gen(3)), scriptJson(gen(3)));
        assert.notEqual(scriptJson(gen(3)), scriptJson(gen(4)));
    });
    it('the capacity key sits after flushPasses, before ops; cfg values in their sets; all 8 cfgs over 200 worlds', () => {
        const seen = new Set();
        for (let w = 0; w < 200; w++) {
            const s = gen(w);
            assert.deepEqual(Object.keys(s), ['genVersion', 'lane', 'seed', 'large', 'covOff', 'flushPasses', 'capacity', 'ops']);
            const c = s.capacity;
            assert.deepEqual(Object.keys(c), ['maxNodes', 'maxLinks', 'onCapacityExceeded']);
            assert.ok(c.maxNodes === 32 || c.maxNodes === 64);
            assert.ok(c.maxLinks === c.maxNodes || c.maxLinks === 2 * c.maxNodes);
            assert.ok(c.onCapacityExceeded === 'throw' || c.onCapacityExceeded === 'grow');
            seen.add(c.maxNodes + '/' + c.maxLinks + '/' + c.onCapacityExceeded);
        }
        assert.equal(seen.size, 8);
    });
    it('G12 budget over 200 worlds: core live nodes <= maxNodes/2 - 2, static core links <= maxLinks/2', () => {
        for (let w = 0; w < 200; w++) {
            const s = gen(w);
            const b = budget(s);
            assert.ok(b.maxN <= s.capacity.maxNodes / 2 - 2, 'world ' + w + ' nodes ' + b.maxN);
            assert.ok(b.maxL <= s.capacity.maxLinks / 2, 'world ' + w + ' links ' + b.maxL);
        }
    });
    it('cedge ops: k by policy, reuse only on a throwing op; cov-off no-ceiling emits no ceil (and grow worlds remain)', () => {
        let ceil = 0, growW = 0;
        for (let w = 0; w < 60; w++) {
            for (const cov of [null, 'link-ceiling-grow']) {
                const s = gen(w, cov);
                const grow = s.capacity.onCapacityExceeded === 'grow';
                if (grow && cov !== null) growW++;
                for (const op of s.ops) {
                    if (op.o !== 'cedge') continue;
                    assert.ok(op.reuse === 0 || op.reuse === 1);
                    if (!grow) assert.ok(op.k === 'node' || op.k === 'link', op.k);
                    else assert.ok(op.k === 'node' || op.k === 'link' || op.k === 'ceil', op.k);
                    if (grow && op.k !== 'ceil') assert.equal(op.reuse, 0);
                    if (op.k === 'ceil') { assert.equal(cov, null); ceil++; }
                }
            }
        }
        assert.ok(ceil > 0 && growW > 0);
    });
    it('A-C5: no other lane carries a capacity key (every rostered lane but CAPACITY, 3 worlds each)', () => {
        // b140 B2a: REGISTRY is rostered now (no separate concat); CAPACITY is the one lane that carries the key
        const others = ROSTER.filter((l) => l !== 'CAPACITY');
        assert.ok(others.includes('REGISTRY') && others.length === ROSTER.length - 1);
        for (const desc of others.map(laneByName)) {
            for (let w = 0; w < 3; w++) {
                const s = generateWorld(desc, worldSeed(seedFor(0xC0FFEE, desc.index, 0), w), { steps: 60 });
                assert.equal(Object.hasOwn(s, 'capacity'), false, desc.name);
                assert.deepEqual(Object.keys(s), ['genVersion', 'lane', 'seed', 'large', 'covOff', 'flushPasses', 'ops'], desc.name);
            }
        }
    });
});

describe('DETECT: onCapEdge', () => {
    it('maps (kind, policy, threw, reused) to the five scenarios', () => {
        const D = new Detectors({});
        D.onCapEdge('node', 'throw', true, false);
        D.onCapEdge('link', 'throw', true, true);
        D.onCapEdge('ceil', 'grow', true, false);
        D.onCapEdge('node', 'grow', false, false);
        D.onCapEdge('node', 'throw', false, false);   // no throw: nothing
        D.onCapEdge('link', 'grow', false, false);    // no scenario
        assert.deepEqual({ ...D.counts }, { 'node-cap-throw': 1, 'link-cap-throw': 1, 'reuse-at-edge': 1, 'link-ceiling-grow': 1, 'grow-past-initial': 1 });
    });
    it('a bad kind / policy / flag throws TypeError', () => {
        const D = new Detectors({});
        for (const a of [['nodes', 'throw', true, false], ['node', 'Grow', true, false], ['node', 'throw', 1, false], ['node', 'throw', true, undefined]]) {
            assert.throws(() => D.onCapEdge(...a), TypeError, JSON.stringify(a));
        }
    });
});

describe('SEAM: exec passes capacity to open() only when the script carries it (TASK 3)', () => {
    it('no key -> open({ maxFlushPasses }) exactly; key -> open({ maxFlushPasses, capacity }) with the script object', () => {
        const calls = [];
        const spy = Object.freeze({ ...liteS3Adapter, open(o) { calls.push(o); return liteS3Adapter.open(o); } });
        runWorld(spy, script(undefined, BASE.slice(0, 1)), {});
        runWorld(spy, script(T32, BASE.slice(0, 1)), { laneOps: CAPACITY.ops });
        assert.deepEqual(Object.keys(calls[0]), ['maxFlushPasses']);
        assert.deepEqual(Object.keys(calls[1]), ['maxFlushPasses', 'capacity']);
        assert.deepEqual(calls[1].capacity, T32);
    });
});

describe('JUDGE: O6 verdicts on fake worlds', () => {
    it('no throw at the node cap (the engine CapacityError swallowed) -> O6 expected-escape-missing', () => {
        const ad = fakeAdapter((w) => ({ signal(v) { try { return w.signal(v); } catch (e) { if (isCap(e)) return FAKE; throw e; } }, dispose(h) { if (h !== FAKE) w.dispose(h); } }));
        const r = run(script(T32, BASE.concat([{ o: 'cedge', k: 'node', reuse: 0 }])), {}, ad);
        assert.equal(r.failure.step, BASE.length);
        assert.deepEqual(sigs(r.failure.fails), ['O6:expected-escape-missing']);
    });
    it('no throw at the link cap -> O6 expected-escape-missing', () => {
        const ad = fakeAdapter((w) => ({ read(h) { try { return w.read(h); } catch (e) { if (isCap(e)) return 0; throw e; } } }));
        const r = run(script(T32, BASE.concat([{ o: 'cedge', k: 'link', reuse: 0 }])), {}, ad);
        assert.deepEqual(sigs(r.failure.fails), ['O6:expected-escape-missing']);
    });
    it('wrong ctor at the cap -> escape-RangeError + expected-escape-missing', () => {
        const ad = fakeAdapter((w) => ({ signal(v) { try { return w.signal(v); } catch (e) { throw new RangeError(e.message); } } }));
        const r = run(script(T32, BASE.concat([{ o: 'cedge', k: 'node', reuse: 0 }])), {}, ad);
        assert.deepEqual(sigs(r.failure.fails), ['O6:escape-RangeError', 'O6:expected-escape-missing']);
    });
    it('right ctor, wrong message (another cap number) -> escape-CapacityError + expected-escape-missing', () => {
        class CapacityError extends Error {}
        const ad = fakeAdapter((w) => ({ signal(v) { try { return w.signal(v); } catch (e) { throw new CapacityError(NODE_MSG(31)); } } }));
        const r = run(script(T32, BASE.concat([{ o: 'cedge', k: 'node', reuse: 0 }])), {}, ad);
        assert.deepEqual(sigs(r.failure.fails), ['O6:escape-CapacityError', 'O6:expected-escape-missing']);
    });
    it('a throw under grow (below the ceiling) -> O6 escape-CapacityError at the fill', () => {
        class CapacityError extends Error {}
        let n = 0;
        const ad = fakeAdapter((w) => ({ signal(v) { if (++n === 20) throw new CapacityError(NODE_MSG(32)); return w.signal(v); } }));
        const r = run(script(G32, BASE.concat([{ o: 'cedge', k: 'node', reuse: 0 }])), {}, ad);
        assert.deepEqual(sigs(r.failure.fails), ['O6:escape-CapacityError']);
    });
    it('a missed second throw on the reuse leg -> expected-escape-missing (reuse-at-edge not counted)', () => {
        let caps = 0;
        const ad = fakeAdapter((w) => ({ signal(v) { try { return w.signal(v); } catch (e) { if (isCap(e) && ++caps === 2) return FAKE; throw e; } }, dispose(h) { if (h !== FAKE) w.dispose(h); } }));
        const r = run(script(T32, BASE.concat([{ o: 'cedge', k: 'node', reuse: 1 }])), {}, ad);
        assert.deepEqual(sigs(r.failure.fails), ['O6:expected-escape-missing']);
        assert.equal(r.scen['reuse-at-edge'], undefined);
    });
    it('grow-past-initial needs stats() growth >= 2x: a pool that reports 33 (or no stats) counts nothing', () => {
        for (const st of [33, undefined, NaN].map((c) => (w) => ({ ...w.stats(), nodePoolCapacity: c }))) {
            const ad = fakeAdapter((w) => ({ stats() { return st(w); } }));
            let r = null;
            try { r = run(script(G32, BASE.concat([{ o: 'cedge', k: 'node', reuse: 0 }])), {}, ad); } catch (e) { r = { threw: e }; }
            assert.equal(r.failure, null); assert.equal(r.scen['grow-past-initial'], undefined);
        }
    });
});

describe('FAILCLOSED: echo and malformed ops', () => {
    it('an echo that differs from the script cfg -> unmodelled', () => {
        const ad = fakeAdapter(() => ({ capacity() { return Object.freeze({ maxNodes: 64, maxLinks: 64, onCapacityExceeded: 'throw' }); } }));
        assert.throws(() => run(script(T32, BASE.concat([{ o: 'cedge', k: 'node', reuse: 0 }])), {}, ad), /unmodelled capacity op: echo/);
    });
    it('a world with no capacity() (adapters/lite.mjs) -> unmodelled', () => {
        assert.throws(() => run(script(T32, BASE.concat([{ o: 'cedge', k: 'node', reuse: 0 }])), {}, liteAdapter), /no capacity\(\) echo/);
    });
    it('a script with no capacity cfg -> unmodelled', () => {
        assert.throws(() => run(script(undefined, BASE.concat([{ o: 'cedge', k: 'node', reuse: 0 }]))), /no capacity cfg/);
    });
    it('malformed cedge -> unmodelled (k, reuse, ceil under throw, reuse on a no-throw op)', () => {
        const rows = [[T32, { k: 'nodes', reuse: 0 }], [T32, { k: 'node', reuse: 2 }], [T32, { k: 'node' }], [T32, { k: 'ceil', reuse: 0 }],
            [G32, { k: 'node', reuse: 1 }], [G32, { k: 'link', reuse: 1 }]];
        for (const [cap, bad] of rows) {
            assert.throws(() => run(script(cap, BASE.concat([Object.assign({ o: 'cedge' }, bad)]))), /unmodelled capacity op/, JSON.stringify(bad));
        }
    });
    it('a link fill that would reach the node cap under throw -> unmodelled (maxNodes 32, 24 core signals)', () => {
        const ops = [];
        for (let i = 0; i < 24; i++) ops.push({ o: 'sig', i, v: 1 });
        ops.push({ o: 'cedge', k: 'link', reuse: 0 });
        assert.throws(() => run(script({ maxNodes: 32, maxLinks: 64, onCapacityExceeded: 'throw' }, ops)), /private nodes/);
    });
});

describe('KERNEL (A-C1): live tree through lite-s3', () => {
    it('{32, throw}: 32 creates succeed, the 33rd throws exactly the node message; activeNodes 32; free 1 -> create ok -> next throws again', () => {
        const W = liteS3Adapter.open({ maxFlushPasses: null, capacity: { maxNodes: 32, onCapacityExceeded: 'throw' } });
        const hs = [];
        for (let k = 0; k < 32; k++) hs.push(W.signal(k));
        let e1 = null;
        try { W.signal(99); } catch (e) { e1 = e; }
        assert.ok(e1 !== null);
        assert.equal(e1.constructor.name, 'CapacityError');
        assert.equal(e1.message, NODE_MSG(32));
        assert.equal(W.stats().activeNodes, 32);
        W.dispose(hs.pop());
        assert.equal(W.stats().activeNodes, 31);
        hs.push(W.signal(7));
        assert.equal(W.stats().activeNodes, 32);
        assert.throws(() => W.signal(8), (e) => e.constructor.name === 'CapacityError' && e.message === NODE_MSG(32));
        const res = W.close();
        assert.equal(res.nodes, 0);
        assert.equal(res.links, 0);
    });
    it('grow, maxLinks 4: throws links capacity (64) at 64 active links; after disposal activeLinks 0', () => {
        const W = liteS3Adapter.open({ maxFlushPasses: null, capacity: { maxLinks: 4, onCapacityExceeded: 'grow' } });
        const ss = [];
        for (let k = 0; k < 5; k++) ss.push(W.signal(k));
        const cs = [];
        let err = null;
        for (let j = 0; j < 20 && err === null; j++) {
            const c = W.computed(() => { let t = 0; for (const s of ss) t += W.read(s); return t; });
            cs.push(c);
            try { W.read(c); } catch (e) { err = e; }
        }
        assert.ok(err !== null);
        assert.equal(err.constructor.name, 'CapacityError');
        assert.equal(err.message, LINK_MSG(64));
        assert.equal(W.stats().activeLinks, 64);
        for (let j = cs.length - 1; j >= 0; j--) W.dispose(cs[j]);
        assert.equal(W.stats().activeLinks, 0);
        assert.equal(W.close().links, 0);
    });
    it('grow, maxNodes 32: the 33rd node is created and the pool grows past 2x initial (TASK 0 deviation: 512, never asserted as 64)', () => {
        const W = liteS3Adapter.open({ maxFlushPasses: null, capacity: { maxNodes: 32, onCapacityExceeded: 'grow' } });
        for (let k = 0; k < 33; k++) W.signal(k);
        const s = W.stats();
        assert.equal(s.activeNodes, 33);
        assert.ok(s.nodePoolCapacity >= 64, String(s.nodePoolCapacity));
        assert.equal(W.close().nodes, 0);
    });
    it('every cedge kind on a hand script: no failure, its scenario counted', () => {
        const rows = [[T32, 'node', 0, 'node-cap-throw'], [T32, 'node', 1, 'reuse-at-edge'], [T32, 'link', 0, 'link-cap-throw'], [T32, 'link', 1, 'reuse-at-edge'],
            [G32, 'ceil', 0, 'link-ceiling-grow'], [G32, 'ceil', 1, 'reuse-at-edge'], [G32, 'node', 0, 'grow-past-initial']];
        for (const [cap, k, reuse, scen] of rows) {
            const r = run(script(cap, BASE.concat([{ o: 'cedge', k, reuse }, { o: 'set', i: 0, v: 5 }])));
            assert.equal(r.failure, null, k + '/' + reuse + ': ' + JSON.stringify(r.failure));
            assert.equal(r.scen[scen], 1, k + '/' + reuse);
        }
        const g = run(script(G32, BASE.concat([{ o: 'cedge', k: 'link', reuse: 0 }])));
        assert.equal(g.failure, null);
        for (const s of CAP_SCEN) assert.equal(g.scen[s], undefined, 'link under grow counts no scenario: ' + s);
    });
    it('60 generated worlds pass; all five scenarios seen; exec.regExpect null after every cedge', () => {
        const tot = Object.create(null);
        const left = [];
        const laneOps = { cedge: (x, op, k) => { try { CAPACITY.ops.cedge(x, op, k); } finally { left.push(x.regExpect); } } };
        for (let w = 0; w < 60; w++) {
            const r = run(gen(w), { laneOps });
            assert.equal(r.failure, null, 'world ' + w + ': ' + JSON.stringify(r.failure));
            for (const s of CAP_SCEN) tot[s] = (tot[s] || 0) + (r.scen[s] || 0);
        }
        for (const s of CAP_SCEN) assert.ok(tot[s] > 0, s);
        assert.ok(left.length > 60);
        for (const v of left) assert.equal(v, null);
    });
    it('cov-off link-ceiling-grow: 40 worlds pass, link-ceiling-grow never counted', () => {
        for (let w = 0; w < 40; w++) {
            const r = run(gen(w, 'link-ceiling-grow'));
            assert.equal(r.failure, null, 'world ' + w);
            assert.equal(r.scen['link-ceiling-grow'], undefined);
        }
    });
});

describe('RETENTION (A-C4): privates released every op, teardown residue 0', () => {
    it('1000 worlds: no failure (O5 at rest after every op = 0 privates; teardown residue nodes 0 / links 0 judged)', () => {
        let edges = 0;
        for (let w = 0; w < 1000; w++) {
            const s = gen(w);
            const r = run(s);
            assert.equal(r.failure, null, 'world ' + w + ': ' + JSON.stringify(r.failure));
            assert.equal(r.checks.O5, r.ops + 1, 'world ' + w + ': one O5 per op + the teardown');
            edges += r.opsByClass.cedge || 0;
        }
        assert.ok(edges > 1000, String(edges));
    });
});
