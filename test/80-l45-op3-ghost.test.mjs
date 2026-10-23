// 80-l45-op3-ghost.test.mjs -- LEDGER #45 (burst 105, batch B2): allocateLink emits op 3 after fireConnect ran the
// onConnect hook. If that hook removed the edge it had just been told about (disposed the source A/B, the target C, or
// the running observer D), the stream used to carry a GHOST op 3 for an edge that no longer exists. Fix: op 3 is only
// emitted for an edge that survived the hook (both endpoints' gens unchanged).
// INDEPENDENT ORACLE from PLAN-45 ASSERTIONS 1-4 + ADDENDUM 1 (maintainer rulings); nothing is copied from a kernel run.
// Expected values come from the op-stream contract (bench/soak/mirror.mjs): an op 3 needs both ends live; a removed
// edge must not be announced.
// Rows: A / B / C / D = GHOST rows (RED on e912e302 and 928f0e64, GREEN after the fix).
//   C-KNOWN pins the single op 4 left for an edge whose op 3 was never emitted (maintainer ruling Q1 = a, ADDENDUM 1.1).
//   N1-N4 = REGRESSION pins (green before and after). GC / retention rows = REGRESSION pins with their own must-fail controls.
// Kernel: LITE_SIGNAL_KERNEL (absolute path), default ../Signal.js. GC rows need --expose-gc (else SKIP).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { Mirror } from '../bench/soak/mirror.mjs';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const { createRegistry } = await import(KPATH);
const HAVE_GC = typeof globalThis.gc === 'function';

// Record the op stream (strings) and replay it into a Mirror. Install BEFORE creating any node.
function wire(r, tag) {
    const log = [], mir = new Mirror();
    r.onGraphMutation((op, a, b) => {
        mir.apply(op, a, b);
        log.push((op === 3 || op === 4) ? op + ':' + a + '->' + b : op + ':' + a);
        if (tag) tag(op, a, b);
    });
    return { log, mir };
}
const op3From = (log, id) => log.filter((s) => s.startsWith('3:' + id + '->'));
const op4From = (log, id) => log.filter((s) => s.startsWith('4:' + id + '->'));

// Triggers A / B: onConnect(S) disposes S itself (A also mints a new node D afterwards). One effect reads S.
function triggerAB(variant) {
    const r = createRegistry();
    const w = wire(r);
    const S = r.signal('S');
    const sid = r.nodeId(S);
    let D = null, armed = true;
    r.observeObservers(S, { onConnect: () => {
        if (!armed) return; armed = false;
        r.dispose(S);
        if (variant === 'A') D = r.signal('D');
    } });
    r.effect(() => { S(); });
    return { r, w, sid, D };
}
// Trigger C: onConnect(S) disposes the reading computed C (the TARGET), then mints X.
function triggerC() {
    const r = createRegistry();
    const w = wire(r);
    const S = r.signal('S');
    const sid = r.nodeId(S);
    let C = null, X = null, armed = true, thrown = null;
    r.observeObservers(S, { onConnect: () => {
        if (!armed) return; armed = false;
        r.dispose(C);
        X = r.signal('X');
    } });
    C = r.computed(() => S());
    const cid = r.nodeId(C);
    try { C(); } catch (e) { thrown = e; }
    return { r, w, sid, cid, X, thrown };
}
// Trigger D (ADDENDUM 1.3, gap2): the running observer is disposed by its own read's onConnect and a new effect is minted.
function triggerD() {
    const r = createRegistry();
    const w = wire(r);
    const S = r.signal(1), S2 = r.signal(10), go = r.signal(0);
    const sid = r.nodeId(S);
    let stop = null, runsNew = 0, runsOld = 0, armed = true;
    r.observeObservers(S, { onConnect: () => {
        if (!armed) return; armed = false;
        stop();
        r.effect(() => { runsNew++; });
    } });
    const l0 = w.log.length;
    stop = r.effect(() => { runsOld++; if (go()) { S(); S2(); } });
    go.set(1);
    const links = r.stats().activeLinks, n0 = runsNew, o0 = runsOld;
    S2.set(11);
    return { r, w, sid, eid: Number(w.log[l0].slice(2)), links, newRunsOnS2: runsNew - n0, oldRunsOnS2: runsOld - o0 };
}

describe('GHOST rows: no op 3 for an edge an onConnect hook removed (LEDGER #45)', () => {
    for (const variant of ['A', 'B']) {
        it('GHOST ' + variant + ': onConnect disposes the source' + (variant === 'A' ? ' and mints D' : '') +
           ' -> no op 3 for it; Mirror clean; edges === activeLinks === 0', () => {
            const t = triggerAB(variant);
            assert.deepEqual(op3From(t.w.log, t.sid), [], 'ghost op 3 from retired source ' + t.sid + ': ' + JSON.stringify(t.w.log));
            assert.deepEqual(t.w.mir.drain(), [], 'mirror problems');
            assert.equal(t.w.mir.edges, 0, 'mirror edges');
            assert.equal(t.r.stats().activeLinks, 0, 'activeLinks');
            assert.equal(t.w.log.filter((s) => s.startsWith('3:')).length, 0, 'no op 3 at all in this world');
        });
    }
    it('GHOST C: onConnect disposes the target computed -> zero op 3 for it, exactly one op 4, activeLinks 0', () => {
        const t = triggerC();
        assert.deepEqual(op3From(t.w.log, t.sid), [], 'ghost op 3: ' + JSON.stringify(t.w.log));
        assert.deepEqual(op4From(t.w.log, t.sid), ['4:' + t.sid + '->' + t.cid], 'exactly one op 4 for the removed edge');
        assert.equal(t.r.stats().activeLinks, 0, 'activeLinks');
    });
    it('KNOWN C residual: the lone op 4 (edge whose op 3 was never emitted) makes the Mirror report exactly that op 4', () => {
        // Maintainer ruling Q1 = (a): known, documented, no follow-up unit. Mirror: op 4 on a live source whose target is
        // non-live and has no such edge -> 'op4 on non-live id <C>' (mirror.mjs op 4 branch). Nothing else.
        const t = triggerC();
        assert.deepEqual(t.w.mir.drain(), ['op4 on non-live id ' + t.cid]);
    });
    it('GHOST D: observer disposed by its own read\'s onConnect -> no op 3 from S, Mirror has no op3 problem', () => {
        const t = triggerD();
        assert.deepEqual(op3From(t.w.log, t.sid), [], 'ghost op 3: ' + JSON.stringify(t.w.log));
        const bad = t.w.mir.drain().filter((p) => p.startsWith('op3'));
        assert.deepEqual(bad, [], 'op3 mirror problems');
        assert.equal(t.links, t.w.mir.edges, 'mirror edges === activeLinks after the run');
    });
    it('KNOWN D residual: the lone op 4 for the S->effect edge (its op 3 never emitted) makes the Mirror report exactly that op 4', () => {
        // Same residual class as C (maintainer ruling Q1 = (a)): the disposed target here is the observer itself.
        const t = triggerD();
        assert.deepEqual(t.w.mir.drain(), ['op4 on non-live id ' + t.eid]);
    });
    it('REGRESSION D2: the minted effect never read S2, so S2 writes re-run neither the new nor the disposed effect', () => {
        const t = triggerD();
        assert.equal(t.newRunsOnS2, 0, 'new occupant re-ran on S2 (phantom edge)');
        assert.equal(t.oldRunsOnS2, 0, 'disposed effect re-ran');
    });
});

describe('REGRESSION N1-N4: op 3 still fires when the edge survives the hook', () => {
    it('N1 order: onConnect first, then op 3', () => {
        const r = createRegistry();
        const seq = [];
        const w = wire(r, (op, a, b) => { if (op === 3) seq.push('3:' + a + '->' + b); });
        const S = r.signal(1);
        r.observeObservers(S, { onConnect: () => { seq.push('connect'); } });
        r.effect(() => { S(); });
        const sid = r.nodeId(S);
        assert.equal(seq.length, 2, JSON.stringify(seq));
        assert.equal(seq[0], 'connect');
        assert.ok(seq[1].startsWith('3:' + sid + '->'), seq[1]);
        assert.deepEqual(w.mir.drain(), []);
        assert.equal(w.mir.edges, r.stats().activeLinks);
        assert.equal(r.stats().activeLinks, 1);
    });
    it('N2: onConnect disposing an UNRELATED node keeps op 3', () => {
        const r = createRegistry();
        const w = wire(r);
        const S = r.signal(1), U = r.signal(2);
        let armed = true;
        r.observeObservers(S, { onConnect: () => { if (armed) { armed = false; r.dispose(U); } } });
        r.effect(() => { S(); });
        assert.equal(op3From(w.log, r.nodeId(S)).length, 1, JSON.stringify(w.log));
        assert.deepEqual(w.mir.drain(), []);
        assert.equal(r.stats().activeLinks, 1);
    });
    it('N3: a throwing onConnect emits no op 3 and the error propagates (not wedged)', () => {
        const r = createRegistry();
        const w = wire(r);
        const S = r.signal(1);
        let armed = true;
        r.observeObservers(S, { onConnect: () => { if (armed) { armed = false; throw new Error('boom45'); } } });
        const C = r.computed(() => S());
        assert.throws(() => C(), /boom45/);
        assert.deepEqual(op3From(w.log, r.nodeId(S)), [], 'no op 3 for the throwing connect: ' + JSON.stringify(w.log));
        assert.deepEqual(w.mir.drain().filter((p) => p.startsWith('op3')), []);
        // not wedged: a fresh effect reading S (hook now quiet) links and emits op 3 normally
        r.effect(() => { S(); });
        assert.equal(op3From(w.log, r.nodeId(S)).length, 1, JSON.stringify(w.log));
    });
    it('N4: a link created INSIDE the hook emits its op 3 before the outer one', () => {
        const r = createRegistry();
        const order = [];
        const w = wire(r, (op, a, b) => { if (op === 3) order.push(a); });
        const S = r.signal(1), T = r.signal(2);
        let armed = true;
        r.observeObservers(S, { onConnect: () => { if (armed) { armed = false; r.effect(() => { T(); }); } } });
        r.effect(() => { S(); });
        const sid = r.nodeId(S), tid = r.nodeId(T);
        assert.deepEqual(order, [tid, sid], 'inner (T) op 3 first, then outer (S): ' + JSON.stringify(w.log));
        assert.deepEqual(w.mir.drain(), []);
    });
});

const nap = (ms) => new Promise((res) => setTimeout(res, ms));
describe('GC: link alloc/free cycles stay zero-alloc (hot-path pin)', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    // One step = one effect re-run flipping X <-> Y: allocateLink for the new dep, the old one freed by the tail sever.
    // With hooks=true both X and Y carry an onConnect, so every cycle goes through fireConnect (was0 true each time).
    function stepper(hooks) {
        const r = createRegistry();
        const X = r.signal(1), Y = r.signal(2), t = r.signal(0);
        if (hooks) { r.observeObservers(X, { onConnect() {} }); r.observeObservers(Y, { onConnect() {} }); }
        let sink = 0, k = 0;
        r.effect(() => { sink = (sink + ((t() & 1) === 0 ? X() : Y())) | 0; });
        const step = () => { t.set(++k); };
        step.sink = () => sink;
        return step;
    }
    // Window: 1e6 cycles of a zero-alloc step cannot fill the semi-space; any per-cycle allocation of >= ~16 B would.
    async function window(step, n) {
        for (let i = 0; i < 300000; i++) step();
        globalThis.gc(); await nap(20);
        for (let i = 0; i < 100000; i++) step();
        globalThis.gc(); await nap(50);
        const gcp = new GcProfiler().start();
        const h0 = process.memoryUsage().heapUsed;
        for (let i = 0; i < n; i++) step();
        await nap(50);
        const sum = gcp.summary(); gcp.stop();
        globalThis.gc();
        return { minor: sum.gc.minor, grewBpo: (process.memoryUsage().heapUsed - h0) / n };
    }
    it('no hooks (lifecycleCount 0, mutationHook null): 1e6 cycles -> minor 0, retained < 0.5 B/op', async () => {
        const s = stepper(false);
        const m = await window(s, 1000000);
        assert.equal(m.minor, 0, 'scavenges');
        assert.ok(m.grewBpo < 0.5, 'retained B/op ' + m.grewBpo);
        assert.ok(s.sink() !== 0);
    });
    it('hooks on (onConnect on both deps, nothing disposed): 1e5 cycles -> minor 0, retained < 0.5 B/op', async () => {
        const s = stepper(true);
        const m = await window(s, 100000);
        assert.equal(m.minor, 0, 'scavenges');
        assert.ok(m.grewBpo < 0.5, 'retained B/op ' + m.grewBpo);
    });
    it('CONTROL (transient): one throwaway {} per cycle in a ring -> minor > 0', async () => {
        const s = stepper(false);
        const ring = new Array(64).fill(null);
        let i = 0;
        const step = () => { s(); ring[i++ & 63] = { v: i }; };
        const m = await window(step, 1000000);
        assert.ok(m.minor > 0, 'control must scavenge: minor ' + m.minor);
    });
    it('CONTROL (retained): one kept {} per cycle -> whole-window growth >= 8 B/op', async () => {
        const s = stepper(false);
        const keep = [];
        const step = () => { s(); keep.push({ v: keep.length }); };
        const m = await window(step, 200000);
        assert.ok(keep.length > 200000);
        assert.ok(m.grewBpo >= 8, 'control growth B/op ' + m.grewBpo);
    });
});

describe('RETENTION: 1000 x trigger-A cycles leak nothing', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    const settle = async () => { globalThis.gc(); await nap(0); globalThis.gc(); };
    async function run(keepD) {
        const r = createRegistry({ maxNodes: 4096 });
        const base = r.stats();
        const tracker = createLeakTracker({ name: 't80', onLeak() {}, onWarning() {} });
        const kept = [];
        for (let i = 0; i < 1000; i++) {
            const obj = { i };
            tracker.track(obj, null, i);
            const S = r.signal(obj);
            let D = null, armed = true;
            const off = r.observeObservers(S, { onConnect: () => {
                if (!armed) return; armed = false;
                r.dispose(S); D = r.signal(obj);
            } });
            const stop = r.effect(() => { S(); });
            stop();
            if (typeof off === 'function') off();
            if (keepD) kept.push(D); else r.dispose(D);
        }
        for (let i = 0; i < 30 && tracker.size() > 0 && !keepD; i++) { await settle(); await nap(10); }
        await settle(); await settle();
        const out = { size: tracker.size(), st: r.stats(), base, kept };
        return out;
    }
    it('tracker.size() 0 after gc; activeLinks / activeNodes back to baseline', async () => {
        const o = await run(false);
        assert.equal(o.size, 0, 'tracker size');
        assert.equal(o.st.activeLinks, o.base.activeLinks, 'activeLinks');
        assert.equal(o.st.activeNodes, o.base.activeNodes, 'activeNodes');
    });
    it('CONTROL: skipping dispose(D) -> tracker.size() 1000', async () => {
        const o = await run(true);
        assert.equal(o.size, 1000);
        assert.equal(o.kept.length, 1000);
    });
});
