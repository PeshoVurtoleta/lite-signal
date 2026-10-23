// 81-l46-op3-throw.test.mjs -- LEDGER #46 (burst 106, batch B2): a throwing onConnect used to leave a LIVE edge with no
// op 3 (allocateLink's emit is skipped by the unwind), so the Mirror later saw 'op4 on absent edge'. Fix: fireConnect's
// finally emits op 3 for the surviving edge when the hook threw (after the restore, before the error propagates; #45's
// gen check still wins: a hook that removed an endpoint and then threw emits nothing). Q1 = (i): a throwing op-3 listener
// replaces the onConnect error (E2 wins).
// INDEPENDENT ORACLE from PLAN-46 ASSERTIONS 1-3, 5, 6 + ADDENDUM 1; nothing is copied from a kernel run.
// Expected values come from the op-stream contract (bench/soak/mirror.mjs): every live edge is announced by exactly one
// op 3; a removed edge is not announced.
// Node ids are derived from the handles (nodeId / the creation op), never hardcoded.
// Rows: R1 / R4 / R5 / R9b / DF = REGRESSION #46 (red-first: FAIL on the before build, PASS after).
//   R2 / R3 / R6 / R7 / R9a / R11 = regression pins (green before and after). GC / retention rows carry must-fail controls.
// Kernel: LITE_SIGNAL_KERNEL (absolute path), default ../Signal.js. GC rows need --expose-gc (else SKIP).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { Mirror } from '../bench/soak/mirror.mjs';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const { createRegistry } = await import(KPATH);
const HAVE_GC = typeof globalThis.gc === 'function';

// Preallocated errors (no allocation on the throw path under test).
const E1 = new Error('onConnect boom46');
const E2 = new Error('op3 listener boom46');

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
const op3All = (log) => log.filter((s) => s.startsWith('3:'));
const op34 = (log) => log.filter((s) => s.startsWith('3:') || s.startsWith('4:'));

// Probe world P (PLAN-46 ASSERTIONS): S, T signals; E effect: runs++; try { S() } catch (e) { c = e }; T().
// onConnect(S) throws E1 (hookMode 'throw'), or disposes S then throws ('disposeS'), always (not one-shot).
// opts.wire = false -> no listener at all. opts.tag -> extra per-op callback (gets sid via t.sid lazily).
function worldP(opts) {
    opts = opts || {};
    const r = createRegistry();
    const t = { r, runs: 0, c: null, hookCalls: 0 };
    const w = opts.wire === false ? null : wire(r, opts.tag ? (op, a, b) => opts.tag(t, op, a, b) : null);
    t.w = w;
    const S = r.signal(1), T = r.signal(2);
    t.S = S; t.T = T;
    t.sid = r.nodeId(S); t.tid = r.nodeId(T);
    r.observeObservers(S, { onConnect: () => {
        t.hookCalls++;
        if (opts.hook === 'disposeS') r.dispose(S);
        throw E1;
    } });
    const l0 = w ? w.log.length : 0;
    t.stop = r.effect(() => {
        t.runs++;
        try { S(); } catch (e) { t.c = e; }
        T();
    });
    t.eid = w ? Number(w.log[l0].slice(2)) : -1;
    return t;
}
const edgesEqLinks = (t, n, msg) => {
    assert.equal(t.w.mir.edges, n, (msg || '') + ' mirror edges');
    assert.equal(t.r.stats().activeLinks, n, (msg || '') + ' activeLinks');
};

describe('REGRESSION #46 red-first: a throwing onConnect still announces the live edge (op 3)', () => {
    it('REGRESSION #46 R1: P -> op3 subsequence [S->E, T->E]; error caught is E1; drain []; edges === activeLinks === 2', () => {
        const t = worldP();
        assert.equal(t.c, E1, 'the effect caught E1');
        assert.deepEqual(op3All(t.w.log), ['3:' + t.sid + '->' + t.eid, '3:' + t.tid + '->' + t.eid], JSON.stringify(t.w.log));
        assert.deepEqual(t.w.mir.drain(), []);
        edgesEqLinks(t, 2, 'R1');
    });
    it('REGRESSION #46 R4: P then stop(E) -> drain [] (no "op4 on absent edge"); edges === activeLinks === 0', () => {
        const t = worldP();
        t.stop();
        assert.deepEqual(t.w.mir.drain(), [], JSON.stringify(t.w.log));
        edgesEqLinks(t, 0, 'R4');
    });
    it('REGRESSION #46 R5: computed C = () => S() -> C() throws E1; op3 [S->C]; drain []; edges === activeLinks === 1', () => {
        const r = createRegistry();
        const w = wire(r);
        const S = r.signal(1);
        const sid = r.nodeId(S);
        r.observeObservers(S, { onConnect: () => { throw E1; } });
        const C = r.computed(() => S());
        const cid = r.nodeId(C);
        let got = null;
        try { C(); } catch (e) { got = e; }
        assert.equal(got, E1, 'error identity');
        assert.deepEqual(op3All(w.log), ['3:' + sid + '->' + cid], JSON.stringify(w.log));
        assert.deepEqual(w.mir.drain(), []);
        assert.equal(w.mir.edges, 1);
        assert.equal(r.stats().activeLinks, 1);
    });
    it('REGRESSION #46 R9b: not wedged -- once all subscribers are gone the next reader re-fires the throw and re-emits op 3; drain [] throughout', () => {
        const t = worldP();
        let c2 = null;
        const stop2 = t.r.effect(() => { try { t.S(); } catch (e) { c2 = e; } });
        assert.equal(t.hookCalls, 1, 'second reader did not re-fire onConnect (S already has a subscriber)');
        t.stop(); stop2();
        assert.deepEqual(t.w.mir.drain(), [], JSON.stringify(t.w.log));
        const before = op3From(t.w.log, t.sid).length;
        let c3 = null;
        t.r.effect(() => { try { t.S(); } catch (e) { c3 = e; } });
        assert.equal(t.hookCalls, 2, 'onConnect fired again for the first reader after all subs left');
        assert.equal(c3, E1);
        assert.equal(op3From(t.w.log, t.sid).length, before + 1, 'op 3 re-emitted: ' + JSON.stringify(t.w.log));
        assert.deepEqual(t.w.mir.drain(), []);
    });
    it('REGRESSION #46 DF (double fault, Q1 = i): op-3 listener throws E2 on the first op 3 from S -> E2 wins; edges stay live; later reads fine', () => {
        let fired = 0;
        const t = worldP({ tag: (tt, op, a) => { if (op === 3 && a === tt.sid && fired++ === 0) throw E2; } });
        assert.equal(t.c, E2, 'E2 (listener) replaces E1 (onConnect)');
        assert.deepEqual(t.w.mir.drain(), []);
        edgesEqLinks(t, 2, 'DF');
        t.T.set(3);
        assert.equal(t.runs, 2, 'effect not wedged: T.set re-ran it (kills restore-after-emit)');
        // a later effect on S still emits op 3 (S has a live subscriber, so no onConnect, no throw)
        const n0 = op3From(t.w.log, t.sid).length;
        t.r.effect(() => { t.S(); });
        assert.equal(op3From(t.w.log, t.sid).length, n0 + 1, JSON.stringify(t.w.log));
        assert.deepEqual(t.w.mir.drain(), []);
    });
});

describe('REGRESSION pins R2 R3 R6 R7 R9a R11 (green before and after)', () => {
    it('R2: P, then T.set -> runs === 2 (the finally restored the observer context)', () => {
        const t = worldP();
        assert.equal(t.runs, 1);
        t.T.set(3);
        assert.equal(t.runs, 2);
    });
    it('R3: P, then S.set -> effect re-runs once; no new op 3 / op 4; drain []', () => {
        const t = worldP();
        const n34 = op34(t.w.log).length;
        t.S.set(5);
        assert.equal(t.runs, 2);
        assert.equal(op34(t.w.log).length, n34, JSON.stringify(t.w.log));
        assert.deepEqual(t.w.mir.drain(), []);
    });
    it('R6b: hook disposes S, mints D into the recycled slot, then throws -> no op 3 from D (gen, not flags); drain []; edges === activeLinks === 1', () => {
        const r = createRegistry(); const w = wire(r);
        const S = r.signal(1), T = r.signal(2);
        let D = null, c = null;
        r.observeObservers(S, { onConnect: () => { r.dispose(S); D = r.signal(9); throw E1; } });
        r.effect(() => { try { S(); } catch (e) { c = e; } T(); });
        assert.equal(c, E1);
        assert.deepEqual(op3From(w.log, r.nodeId(D)), [], JSON.stringify(w.log));
        assert.deepEqual(w.mir.drain(), []);
        assert.equal(w.mir.edges, 1);
        assert.equal(r.stats().activeLinks, 1);
    });
    it('R6: hook disposes S then throws -> no op 3 from S (#45 wins); drain []; edges === activeLinks === 1 (T->E)', () => {
        const t = worldP({ hook: 'disposeS' });
        assert.equal(t.c, E1);
        assert.deepEqual(op3From(t.w.log, t.sid), [], JSON.stringify(t.w.log));
        assert.deepEqual(t.w.mir.drain(), []);
        edgesEqLinks(t, 1, 'R6');
    });
    it('R7: hook disposes the target computed C then throws -> no op 3 from S; KNOWN residual: full drain is exactly the lone op 4; activeLinks 0', () => {
        const r = createRegistry();
        const w = wire(r);
        const S = r.signal(1);
        const sid = r.nodeId(S);
        let C = null;
        r.observeObservers(S, { onConnect: () => { r.dispose(C); throw E1; } });
        C = r.computed(() => S());
        const cid = r.nodeId(C);
        let got = null;
        try { C(); } catch (e) { got = e; }
        // (whether C() itself rethrows after disposing itself is not in the spec; not asserted)
        void got;
        assert.deepEqual(op3From(w.log, sid), [], JSON.stringify(w.log));
        // PLAN-45 ADDENDUM 1.1 (Q1 = a): the removed edge's op 4 has no op 3 -> exactly this one problem, FULL drain.
        assert.deepEqual(w.mir.drain(), ['op4 on non-live id ' + cid]);
        assert.equal(r.stats().activeLinks, 0);
    });
    it('R9a: after P a new effect on S links with op 3 and no onConnect call; drain []', () => {
        const t = worldP();
        let nid = -1;
        const l0 = t.w.log.length;
        t.r.effect(() => { t.S(); });
        nid = Number(t.w.log[l0].slice(2));
        assert.equal(t.hookCalls, 1);
        assert.deepEqual(op3From(t.w.log, t.sid).slice(-1), ['3:' + t.sid + '->' + nid], JSON.stringify(t.w.log));
        assert.deepEqual(t.w.mir.drain(), []);
    });
    it('R11: no op-3 listener installed -> the throwing onConnect propagates exactly E1', () => {
        const t = worldP({ wire: false });
        assert.equal(t.c, E1);
        assert.equal(t.runs, 1);
        t.T.set(3);
        assert.equal(t.runs, 2);
        const r = createRegistry();
        const S = r.signal(1);
        r.observeObservers(S, { onConnect: () => { throw E1; } });
        const C = r.computed(() => S());
        assert.throws(() => C(), (e) => e === E1);
    });
});

const nap = (ms) => new Promise((res) => setTimeout(res, ms));
describe('GC: the throw path (preallocated E1, counter listener) stays allocation-free', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    // One step = t flips; odd -> the effect reads S (S has no other subscriber -> fireConnect -> onConnect throws E1,
    // caught inside the effect, op 3 counted); even -> the effect skips S and the edge is severed. Nothing allocates.
    // Before-build throw-path minor count: 0/0/0 over 1e5 cycles x3 (.handoff/b106-evidence/L46/gc-throw-before.txt);
    // re-measured at 1e6 steps on b106-before: see .handoff/b106-evidence/t81/r2.txt (value below: minor 0 at 1e6 steps on b106-before, confirmed by r2.txt section b).
    const BEFORE_MINOR = 0;
    function stepper() {
        const r = createRegistry();
        let ops = 0;
        r.onGraphMutation(() => { ops++; });
        const S = r.signal(1), t = r.signal(0);
        r.observeObservers(S, { onConnect() { throw E1; } });
        let sink = 0, k = 0;
        r.effect(() => { if ((t() & 1) === 1) { try { S(); } catch (e) { sink = (sink + 1) | 0; } } });
        const step = () => { t.set(++k); };
        step.sink = () => sink;
        step.ops = () => ops;
        return step;
    }
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
        return { minor: sum.gc.minor, major: sum.gc.major, grewBpo: (process.memoryUsage().heapUsed - h0) / n };
    }
    it('GC-2: 5e5 throwing-connect cycles (1e6 steps) -> major 0, retained < 0.5 B/op', async () => {
        const s = stepper();
        const m = await window(s, 1000000);
        assert.ok(s.sink() > 0, 'the throw path really ran');
        assert.ok(s.ops() > 0, 'listener really counted ops');
        assert.equal(m.major, 0, 'major GCs');
        assert.ok(m.grewBpo < 0.5, 'retained B/op ' + m.grewBpo);
    });
    it('GC-2 minor pin: 5e5 throwing-connect cycles (1e6 steps) == before-build figure (0)', async () => {
        const s = stepper();
        const m = await window(s, 1000000);
        assert.equal(m.minor, BEFORE_MINOR, 'scavenges vs before');
    });
    it('CONTROL (transient): one throwaway [a, b] per throw cycle in a 64-slot ring -> minor > 0', async () => {
        const s = stepper();
        const ring = new Array(64).fill(null);
        let j = 0, k = 0;
        const step = () => { s(); if ((k++ & 1) === 1) { ring[j] = [j, 1]; j = (j + 1) & 63; } };
        const m = await window(step, 1000000);
        assert.ok(m.minor > 0, 'transient control minor ' + m.minor);
    });
    it('CONTROL (retained): one kept {} per throw cycle -> whole-window growth >= 8 B/op', async () => {
        const s = stepper();
        const keep = [];
        const step = () => { s(); keep.push({ v: keep.length }); };
        const m = await window(step, 200000);
        assert.ok(keep.length > 200000);
        assert.ok(m.grewBpo >= 8, 'control growth B/op ' + m.grewBpo);
    });
});

describe('RETENTION: 1000 x P cycles leak nothing', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    const settle = async () => { globalThis.gc(); await nap(0); globalThis.gc(); };
    async function run(keepS) {
        const r = createRegistry({ maxNodes: 4096 });
        const mir = new Mirror();
        r.onGraphMutation((op, a, b) => { mir.apply(op, a, b); });
        const base = r.stats();
        // Payload liveness is counted with WeakRefs (same oracle as lite-leak's tracker.size()): an inline loop in this async
        // frame kept exactly the LAST payload alive (async-frame register retention); the sync-function form below reads 0
        // on lite-leak's tracker too.
        const refs = [];
        const kept = [];
        // The cycle body lives in a sync function so no payload stays in this async frame's registers.
        const cycle = (i) => {
            const obj = { i };
            refs.push(new WeakRef(obj));
            const S = r.signal(obj);
            const off = r.observeObservers(S, { onConnect: () => { throw E1; } });
            const stop = r.effect(() => { try { S(); } catch (e) { /* E1 */ } });
            stop();
            if (typeof off === 'function') off();
            if (keepS) kept.push(S); else r.dispose(S);
        };
        for (let i = 0; i < 1000; i++) cycle(i);
        const live = () => { let n = 0; for (let i = 0; i < refs.length; i++) if (refs[i].deref() !== undefined) n++; return n; };
        for (let i = 0; i < 30 && live() > 0 && !keepS; i++) { await settle(); await nap(10); }
        await settle(); await settle();
        return { size: live(), st: r.stats(), base, kept, edges: mir.edges };
    }
    it('payloads collected (live count 0) after gc; activeLinks / activeNodes at baseline; mirror edges 0', async () => {
        const o = await run(false);
        assert.equal(o.size, 0, 'live payloads');
        assert.equal(o.st.activeLinks, o.base.activeLinks, 'activeLinks');
        assert.equal(o.st.activeNodes, o.base.activeNodes, 'activeNodes');
        assert.equal(o.edges, 0, 'mirror edges');
    });
    it('CONTROL: skipping dispose(S) -> live payload count 1000', async () => {
        const o = await run(true);
        assert.equal(o.size, 1000);
        assert.equal(o.kept.length, 1000);
    });
});
