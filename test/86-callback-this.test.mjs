// test/86-callback-this.test.mjs -- burst 120, unit H1: LEDGER #48 (user callbacks were invoked with `this` = an internal
// engine object: node.computeFn() in executeEffect / refreshComputed, cleanup[i]() on the cleanup array, and
// node.scheduler(thunk) at effect() creation). Contract: every user body / scheduler / cleanup runs with this === undefined.
// Oracle: .handoff/PLAN-48-this.md TASK 8 + ASSERTIONS A1 (RED / PARITY split), A4 (GC row + must-fail control), A5
// (retention); no expected value is copied from a run of the new engine. RED rows must FAIL on the before build
// (98a481c / Signal.js 2f7974f3 = .handoff/b120-before) and pass after; PARITY / GC / retention rows pass on both.
// RED (12): computed init + re-run; computedBox init + re-run; effect init + re-run; scheduler initial schedule; onCleanup
// array of 2 and of 3; restored computed + restored effect; computed(new Function('return this')) -> globalThis.
// PARITY: later scheduler schedule (flush path); single onCleanup; G2 error CLASS only; G3 op-5 listener disposes the node.
// Rows that write this.x are guarded by `if (this !== undefined)` (strict ESM: undefined this would throw).
// Kernel: LITE_SIGNAL_KERNEL (absolute path), default ../Signal.js. GC rows need --expose-gc (else SKIP).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const { createRegistry } = await import(KPATH);
const HAVE_GC = typeof globalThis.gc === 'function';
const U = [undefined];

describe('RED: computed / computedBox / effect bodies run with this === undefined', () => {
    for (const kind of ['computed', 'computedBox']) {
        const mkc = () => {
            const r = createRegistry();
            const s = r.signal(1), seen = [];
            const c = r[kind](function () { if (this !== undefined) this.touched = 1; seen.push(this); return s() + 1; });
            const rd = () => (kind === 'computed' ? c() : c.get());
            return { s, seen, rd };
        };
        it('RED ' + kind + ' init run', () => {
            const { seen, rd } = mkc();
            assert.equal(rd(), 2);
            assert.deepEqual(seen, [undefined]);
        });
        it('RED ' + kind + ' re-run', () => {
            const { s, seen, rd } = mkc();
            assert.equal(rd(), 2);
            s.set(2);
            assert.equal(rd(), 3);
            assert.deepEqual(seen, [undefined, undefined], 'init run and re-run both see this === undefined');
        });
    }
    it('RED effect init run', () => {
        const r = createRegistry();
        const s = r.signal(1), seen = [];
        r.effect(function () { if (this !== undefined) this.touched = 1; seen.push(this); s(); });
        assert.deepEqual(seen, [undefined]);
    });
    it('RED effect re-run', () => {
        const r = createRegistry();
        const s = r.signal(1), seen = [];
        r.effect(function () { if (this !== undefined) this.touched = 1; seen.push(this); s(); });
        s.set(2);
        assert.deepEqual(seen, [undefined, undefined]);
    });
    it('RED computed(new Function("return this")) returns globalThis (sloppy body, this undefined -> global)', () => {
        const r = createRegistry();
        const c = r.computed(new Function('return this'));
        assert.equal(c(), globalThis);
    });
});

describe('scheduler this', () => {
    it('RED scheduler initial schedule at effect() creation sees this === undefined', () => {
        const r = createRegistry();
        const s = r.signal(1), seen = [], thunks = [];
        r.effect(function () { s(); }, { scheduler: function (run) { if (this !== undefined) this.touched = 1; seen.push(this); thunks.push(run); } });
        assert.equal(seen.length, 1, 'scheduler called once at creation');
        assert.equal(seen[0], undefined);
        thunks[0]();
    });
    it('PARITY later scheduler schedule (flush path) sees this === undefined', () => {
        const r = createRegistry();
        const s = r.signal(1), seen = [], thunks = [];
        r.effect(function () { s(); }, { scheduler: function (run) { seen.push(this); thunks.push(run); } });
        thunks[0]();
        s.set(2);
        assert.equal(seen.length, 2, 'scheduler called again on the dependency change');
        assert.equal(seen[1], undefined);
        thunks[1]();
    });
});

describe('onCleanup this', () => {
    for (const n of [2, 3]) {
        it('RED onCleanup array of ' + n + ': every cleanup sees this === undefined', () => {
            const r = createRegistry();
            const s = r.signal(0), seen = [];
            r.effect(function () {
                s();
                for (let i = 0; i < n; i++) r.onCleanup(function () { if (this !== undefined) this.touched = 1; seen.push(this); });
            });
            s.set(1);   // re-run runs the n cleanups of run 1
            assert.equal(seen.length, n);
            for (let i = 0; i < n; i++) assert.equal(seen[i], undefined, 'cleanup ' + i);
        });
    }
    it('PARITY single onCleanup sees this === undefined', () => {
        const r = createRegistry();
        const s = r.signal(0), seen = [];
        r.effect(function () { s(); r.onCleanup(function () { seen.push(this); }); });
        s.set(1);
        assert.deepEqual(seen, U);
    });
});

describe('restored bodies (fnsById path)', () => {
    function restored(log) {
        const r = createRegistry();
        const s = r.signal(1);
        const c = r.computed(() => s() * 2);
        r.effect(() => { c(); });
        c();
        const sId = r.nodeId(s), cId = r.nodeId(c);
        const ids = r.snapshot().nodes.filter((n) => n.kind === 'effect').map((n) => n.id);
        assert.equal(ids.length, 1);
        const H = {}, R = {};
        const fnsById = {
            [cId]: function () { log.c.push(this); return R.s() * 2; },
            [ids[0]]: function () { log.e.push(this); R.c(); },
        };
        const r2 = r.restore(r.snapshot(), { fnsById, handles: H });
        R.s = H[sId]; R.c = H[cId];
        return { r2, s: H[sId] };
    }
    it('RED restored computed re-run sees this === undefined', () => {
        const log = { c: [], e: [] };
        const { s } = restored(log);
        s.set(5);
        assert.ok(log.c.length >= 1, 'restored computed body ran after the dependency changed');
        for (const t of log.c) assert.equal(t, undefined);
    });
    it('RED restored effect re-run sees this === undefined', () => {
        const log = { c: [], e: [] };
        const { s } = restored(log);
        s.set(5);
        assert.ok(log.e.length >= 1, 'restored effect body ran after the dependency changed');
        for (const t of log.e) assert.equal(t, undefined);
    });
});

describe('G2 error CLASS only (message text may change)', () => {
    it('PARITY computed(123) read throws TypeError', () => {
        const r = createRegistry();
        let cls = null;
        try { const c = r.computed(123); c(); } catch (e) { cls = e.constructor; }
        assert.equal(cls, TypeError);
    });
    it('PARITY effect scheduler: 1 throws TypeError', () => {
        const r = createRegistry();
        let cls = null;
        try { r.effect(() => {}, { scheduler: 1 }); } catch (e) { cls = e.constructor; }
        assert.equal(cls, TypeError);
    });
    it('PARITY onCleanup(5) followed by a 2nd cleanup throws TypeError (observed on the before build: a lone onCleanup(5) is accepted)', () => {
        const r = createRegistry();
        let cls = null;
        try { r.effect(() => { r.onCleanup(5); r.onCleanup(() => {}); }); } catch (e) { cls = e.constructor; }
        assert.equal(cls, TypeError);
    });
});

describe('G3 op-5 listener disposes the node being recomputed', () => {
    // Values below were OBSERVED on the before build 98a481c / Signal.js 2f7974f3 and must be identical after (the
    // computeFn load stays AFTER fireRecompute, so the op-5 hook still fires first and the body never runs).
    it('PARITY effect: dispose inside op 5 -> s.set throws TypeError, body not re-run, node gone', () => {
        const r = createRegistry();
        const s = r.signal(0);
        let runs = 0, armed = false, effId = -1, lastId = -1, stop = null, fired = 0, cls = null;
        r.onGraphMutation((op, a) => {
            if (op === 1) lastId = a;
            if (op === 5 && armed && a === effId) { armed = false; fired++; stop(); }
        });
        stop = r.effect(() => { s(); runs++; });
        effId = lastId; armed = true;
        try { s.set(1); } catch (e) { cls = e.constructor; }
        assert.equal(fired, 1);
        assert.equal(cls, TypeError);
        assert.equal(runs, 1, 'body did not run again');
        assert.equal(r.stats().activeNodes, 1, 'only the signal remains');
        s.set(2);
        assert.equal(runs, 1, 'disposed effect stays dead');
    });
    it('PARITY computed: dispose inside op 5 -> body not re-run, read gives undefined, no throw, node gone', () => {
        const r = createRegistry();
        const s = r.signal(0);
        let runs = 0, armed = false, cls = null, res = 'unset';
        const c = r.computed(() => { runs++; return s() + 1; });
        r.effect(() => { res = c(); });
        const cid = r.nodeId(c);
        assert.equal(res, 1);
        r.onGraphMutation((op, a) => { if (op === 5 && armed && a === cid) { armed = false; r.dispose(c); } });
        armed = true;
        try { s.set(1); } catch (e) { cls = e; }
        assert.equal(cls, null, 'no throw');
        assert.equal(runs, 1, 'computed body did not run again');
        assert.equal(res, undefined);
        assert.equal(r.stats().activeNodes, 2, 'signal + effect remain');
        assert.equal(r.nodeId(c), undefined);
    });
});

describe('A4 GC: function-body bodies are zero-alloc', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    function mkStep(alloc) {
        const r = createRegistry();
        const s = r.signal(0);
        let sink = 0, keep = null, runs = 0;
        const c = r.computed(function () { const v = s(); if (alloc) keep = {}; return v + 1; });
        r.effect(function () { runs++; sink = (sink + c()) | 0; });
        let k = 0;
        const step = () => { s.set(++k); };
        step.runs = () => runs; step.sink = () => sink; step.keep = () => keep;
        return step;
    }
    async function window(step, n) {
        for (let i = 0; i < 300000; i++) step();   // finish tiering / feedback one-time costs before the window
        globalThis.gc();
        await new Promise((res) => setTimeout(res, 50));
        const r0 = step.runs();
        const gcp = new GcProfiler().start();
        const h0 = process.memoryUsage().heapUsed;
        for (let i = 0; i < n; i++) step();
        const bop = (process.memoryUsage().heapUsed - h0) / n;   // read before any await: valid only when minor === 0
        const ran = step.runs() - r0;
        await new Promise((res) => setTimeout(res, 50));
        const sum = gcp.summary(); gcp.stop();
        return { minor: sum.gc.minor, bop, ran };
    }
    it('A4 2e5 writes (computed recompute + effect re-run): minor === 0, window B/op < 1', async () => {
        const step = mkStep(false);
        const m = await window(step, 200000);
        assert.equal(m.ran, 200000, 'effect re-ran once per window write');
        assert.ok(step.sink() !== 0);
        assert.equal(m.minor, 0, 'scavenges in the window');
        assert.ok(m.bop < 1, 'window B/op ' + m.bop);
    });
    it('A4 CONTROL (must-fail): a body allocating {} per run is seen (minor > 0 or B/op >= 8)', async () => {
        const step = mkStep(true);
        const m = await window(step, 200000);
        assert.ok(step.keep() !== null);
        assert.ok(m.minor > 0 || m.bop >= 8, 'control must be seen: minor ' + m.minor + ' B/op ' + m.bop);
    });
});

describe('A5 retention: 100 x {function computed, effect with 3 onCleanup, scheduler effect}', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    const settle = async () => { globalThis.gc(); await new Promise((res) => setTimeout(res, 0)); globalThis.gc(); };
    it('A5 tracker.size() 0 and active nodes back to baseline', async () => {
        const r = createRegistry();
        const base = r.stats().activeNodes;
        const tracker = createLeakTracker({ name: 't86', onLeak() {}, onWarning() {} });
        for (let i = 0; i < 100; i++) {
            const obj = { i };
            tracker.track(obj, null, i);
            const s = r.signal(0);
            const c = r.computed(function () { s(); return obj.i; });
            const stop1 = r.effect(function () {
                c(); s();
                r.onCleanup(function () { obj.i; });
                r.onCleanup(function () { obj.i; });
                r.onCleanup(function () { obj.i; });
            });
            const stop2 = r.effect(function () { s(); obj.i; }, { scheduler: function (run) { run(); } });
            s.set(1);
            stop1(); stop2(); r.dispose(c); r.dispose(s);
        }
        for (let i = 0; i < 30 && tracker.size() > 0; i++) { await settle(); await new Promise((res) => setTimeout(res, 10)); }
        await settle(); await settle();
        assert.equal(tracker.size(), 0, 'tracker size');
        assert.equal(r.stats().activeNodes, base, 'activeNodes baseline');
    });
});
