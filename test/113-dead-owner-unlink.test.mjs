// 113-dead-owner-unlink.test.mjs -- ARG-E1 (PLAN-ARG-E1 ASSERTIONS A1-A7, W1-W2, T1-T6, H1-H5, O1-O2, GC, Retention).
// Two defects, one file:
//   F3  a dead (disposed-while-running) owner / observer stayed readable: isTracking() true, getOwner() a descriptor of the
//       recycled slot, onCleanup() attached a ghost cleanup to it, a forged descriptor could dispose a stranger.
//   F8  freeLink fired op 4 BEFORE the edge was unlinked; a throwing / mutating op-4 listener left a half-freed link. Fixed
//       order: unlink + pool push + activeLinks decrement, THEN op 4, THEN the 1->0 onDisconnect (catch arm: still fires 1->0,
//       then rethrows; a throwing onDisconnect replaces the op-4 error).
// INDEPENDENT ORACLE: every expected value is derived from the PLAN ASSERTIONS or by hand (comment per row); none is copied from a
// kernel run. A row that is a REGRESSION PIN (green on the frozen build too) says so; every other row is RED on the frozen
// build (e26168ce) and is marked todo until the fixing batch lands (the fixing batch's coder removes the todo).
// Values the plan leaves to the T0 probe are marked "T0 probe" with the frozen column in .handoff/arg/e1-t0/frozen-column.txt.
// Kernel: LITE_SIGNAL_KERNEL (absolute path), default ../Signal.js. GC / retention rows need --expose-gc (else SKIP).
// Env: E1_CUT_GOLDEN=1 cuts test/113-dead-owner-unlink.golden.json (run ONLY against the frozen build);
//      E1_PROBE_OUT=<file> dumps every row's actual / expected as JSON lines.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const { createRegistry, CapacityError } = await import(KPATH);
const HAVE_GC = typeof globalThis.gc === 'function';
const GOLDEN_URL = new URL('./113-dead-owner-unlink.golden.json', import.meta.url);
const PROBE_OUT = process.env.E1_PROBE_OUT;
if (PROBE_OUT) writeFileSync(PROBE_OUT, '');

// RED-first marker: set to '' by the fixing batch's coder (one edit), never per row.
const TODO = '';
const red = TODO ? { todo: TODO } : {};

// Row check: deepEqual + optional probe dump.
function eq(row, actual, expected) {
    if (PROBE_OUT) appendFileSync(PROBE_OUT, JSON.stringify({ row, actual: actual === undefined ? '__undefined__' : actual, expected: expected === undefined ? '__undefined__' : expected }) + '\n');
    assert.deepEqual(actual, expected, row);
}

const E = new Error('e1-op4');
const ED = new Error('e1-onDisconnect');
const N = 16; // maxNodes of the "tight" worlds (throw policy, so the pool is exactly N slots)

// ---------------------------------------------------------------------------------------------------------
// A rows: an OUTER computed is disposed while its body runs (it is COMPUTING, so its slot is pinned), then the body reads the
// trio (isTracking, getOwner, ghost cleanup). Disposers: nested computed / owned effect / op 3 / op 4 / op 5 / onConnect /
// onDisconnect listeners firing inside a nested frame of the outer body.
// Expected (dead outer): isTracking false, getOwner undefined, ghost cleanup never runs (0).
// Ghost: onCleanup(fn) in the dead body must be dropped; the slot is later recycled (pool exhausted) and its new resident
// disposed: a ghost cleanup would run then.
// ---------------------------------------------------------------------------------------------------------
function worldA(kind) {
    const r = createRegistry({ maxNodes: N });
    const tick = r.signal(0), g = r.signal(true), a = r.signal(1), s = r.signal(5), fresh = r.signal(7);
    const w = { r, tr: null, owner: null, ghost: 0, armed: false, outer: null, inner: null, caught: null, idOuter: 0, idInner: 0 };
    let go = false;
    const dropOuter = () => { if (w.armed) { w.armed = false; r.dispose(w.outer); } };
    if (kind === 'nested') w.inner = r.computed(() => { dropOuter(); return 0; });
    if (kind === 'op3' || kind === 'onConnect') w.inner = r.computed(() => fresh());
    if (kind === 'op4' || kind === 'op5') w.inner = r.computed(() => (g() ? a() : 0));
    if (kind === 'onDisconnect') w.inner = r.computed(() => (g() ? s() : 0));
    if (kind === 'onConnect') r.observeObservers(fresh, { onConnect: dropOuter });
    if (kind === 'onDisconnect') r.observeObservers(s, { onDisconnect: dropOuter });
    const idFresh = r.nodeId(fresh);
    if (w.inner) w.idInner = r.nodeId(w.inner);
    r.onGraphMutation((op, x, y) => {
        if (!w.armed) return;
        if (kind === 'op3' && op === 3 && x === idFresh) dropOuter();
        else if (kind === 'op4' && op === 4 && y === w.idInner) dropOuter();
        else if (kind === 'op5' && op === 5 && x === w.idInner) dropOuter();
    });
    w.outer = r.computed(() => {
        tick();
        if (!go) { if (kind === 'op4' || kind === 'op5' || kind === 'onDisconnect') w.inner(); return 1; }
        w.armed = true;
        if (kind === 'effect') r.effect(() => { dropOuter(); });
        else w.inner();
        w.tr = r.isTracking();
        w.owner = r.getOwner();
        r.onCleanup(() => { w.ghost++; });
        return 1;
    });
    w.idOuter = r.nodeId(w.outer);
    w.outer();
    go = true;
    if (kind === 'op4' || kind === 'onDisconnect') g.set(false);
    if (kind === 'op5') a.set(2);
    tick.set(1);
    w.outer();
    return w;
}
// Exhaust the free list so the pinned slot is recycled by one of the new nodes, then dispose them all.
function recycleAndDispose(w) {
    const hs = [];
    const k = N - w.r.stats().activeNodes;
    for (let i = 0; i < k; i++) hs.push(w.r.effect(() => {}));
    for (let i = 0; i < hs.length; i++) hs[i]();
}
const DISPOSERS = ['nested', 'effect', 'op3', 'op4', 'op5', 'onConnect', 'onDisconnect'];
for (const kind of DISPOSERS) {
    const row = kind === 'nested' ? 'A1' : 'A2/' + kind;
    describe('[' + row + '] dead outer (disposed by ' + kind + ' inside its body): the trio', () => {
        it('[' + row + '] isTracking() === false', red, () => { eq(row + ' isTracking', worldA(kind).tr, false); });
        it('[' + row + '] getOwner() === undefined', red, () => { eq(row + ' getOwner', worldA(kind).owner, undefined); });
        it('[' + row + '] onCleanup in the dead body is dropped: ghost cleanup runs 0 times on the recycled slot', red, () => {
            const w = worldA(kind);
            recycleAndDispose(w);
            eq(row + ' ghost', w.ghost, 0);
        });
    });
}

describe('[A3] forged handle: the dead outer\'s getOwner() descriptor must not dispose a stranger on the recycled slot', () => {
    function worldA3() {
        const r = createRegistry({ maxNodes: N });
        const tick = r.signal(0), s2 = r.signal(0);
        let go = false, forged;
        const inner = r.computed(() => { r.dispose(outer); return 0; });
        const outer = r.computed(() => { tick(); if (go) { inner(); forged = r.getOwner(); } return 1; });
        outer();
        go = true;
        tick.set(1);
        outer();
        // fillers (signals) exhaust the free list; the last node, a stranger effect, is the one seated on the recycled slot
        const k = N - r.stats().activeNodes;
        for (let i = 0; i < k - 1; i++) r.signal(i);
        let strangerRuns = 0;
        r.effect(() => { s2(); strangerRuns++; });
        if (forged !== undefined) r.dispose(forged);
        s2.set(1);
        return { effects: r.stats().effects, strangerRuns };
    }
    // Derivation: the stranger runs at creation (1) and once on s2.set(1) (2); it is the only effect alive (1).
    // Frozen: dispose(forged) kills the stranger: effects 0, runs 1.
    it('[A3] stats().effects === 1 (stranger alive)', red, () => { eq('A3 effects', worldA3().effects, 1); });
    it('[A3] strangerRuns === 2 (stranger re-ran on s2.set)', red, () => { eq('A3 strangerRuns', worldA3().strangerRuns, 2); });
});

describe('[A4] depth 2: inner disposes outer; mid stays live', () => {
    function worldA4() {
        const r = createRegistry({ maxNodes: N });
        const tick = r.signal(0);
        const o = { r, mid: null, outer: null, midTr: null, midOwnerId: null, tr: null, owner: null, ghost: 0 };
        let go = false;
        const inner = r.computed(() => { r.dispose(o.outer); return 0; });
        o.mid = r.computed(() => { inner(); o.midTr = r.isTracking(); const w = r.getOwner(); o.midOwnerId = w === undefined ? null : w.id; return 1; });
        o.outer = r.computed(() => {
            tick();
            if (go) { o.mid(); o.tr = r.isTracking(); o.owner = r.getOwner(); r.onCleanup(() => { o.ghost++; }); }
            return 1;
        });
        o.outer();
        go = true;
        tick.set(1);
        o.outer();
        return o;
    }
    // mid is alive: it sees itself (true, its own descriptor id). Pin (green on frozen); the flags test must not be inverted.
    it('[A4] mid isTracking() === true (pin)', () => { eq('A4 mid isTracking', worldA4().midTr, true); });
    it('[A4] mid getOwner().id === nodeId(mid) (pin)', () => { const o = worldA4(); eq('A4 mid owner', o.midOwnerId, o.r.nodeId(o.mid)); });
    it('[A4] outer isTracking() === false', red, () => { eq('A4 outer isTracking', worldA4().tr, false); });
    it('[A4] outer getOwner() === undefined', red, () => { eq('A4 outer getOwner', worldA4().owner, undefined); });
    it('[A4] outer ghost cleanup runs 0 times', red, () => {
        const o = worldA4();
        recycleAndDispose(o);
        eq('A4 ghost', o.ghost, 0);
    });
});

describe('[A5] throwing op 4 in the inner epilogue; outer catches', () => {
    function worldA5() {
        const r = createRegistry({ maxNodes: N });
        const tick = r.signal(0), g = r.signal(true), a = r.signal(1);
        const o = { r, tr: null, owner: null, ghost: 0, caught: null };
        let go = false, armed = false;
        const inner = r.computed(() => (g() ? a() : 0));
        const idInner = r.nodeId(inner);
        o.outer = r.computed(() => {
            tick();
            if (!go) { inner(); return 1; }
            armed = true;
            try { inner(); } catch (e) { o.caught = e; }
            o.tr = r.isTracking();
            o.owner = r.getOwner();
            r.onCleanup(() => { o.ghost++; });
            return 1;
        });
        r.onGraphMutation((op, x, y) => { if (armed && op === 4 && y === idInner) { armed = false; r.dispose(o.outer); throw E; } });
        o.outer();
        go = true;
        g.set(false);
        tick.set(1);
        o.outer();
        return o;
    }
    it('[A5] the outer catches E (the listener error, identity) (pin)', () => { eq('A5 caught', worldA5().caught === E, true); });
    it('[A5] isTracking() === false', red, () => { eq('A5 isTracking', worldA5().tr, false); });
    it('[A5] getOwner() === undefined', red, () => { eq('A5 getOwner', worldA5().owner, undefined); });
    it('[A5] ghost cleanup runs 0 times', red, () => { const o = worldA5(); recycleAndDispose(o); eq('A5 ghost', o.ghost, 0); });
});

describe('[A6] [A7] reads and creations in a dead body', () => {
    function worldDeadBody(fn) {
        const r = createRegistry({ maxNodes: N });
        const tick = r.signal(0), z = r.signal(3);
        const o = { r };
        let go = false;
        const inner = r.computed(() => { r.dispose(outer); return 0; });
        const outer = r.computed(() => {
            tick();
            if (go) { inner(); fn(r, o, z); }
            return 1;
        });
        outer();
        go = true;
        tick.set(1);
        outer();
        return o;
    }
    // A6: Derivation: a dead observer links nothing: activeLinks unchanged across the read; z has no observers.
    // Regression pin: allocateLink refuses a dead observer on frozen too (cursor nulled by dropCursors).
    it('[A6] read in a dead body: activeLinks delta 0 (pin)', () => {
        const o = worldDeadBody((r, o2, z) => { const l0 = r.stats().activeLinks; z(); o2.delta = r.stats().activeLinks - l0; o2.hasObs = r.hasObservers(z); });
        eq('A6 delta', o.delta, 0);
    });
    it('[A6] read in a dead body: hasObservers(z) === false (pin)', () => {
        const o = worldDeadBody((r, o2, z) => { z(); o2.hasObs = r.hasObservers(z); });
        eq('A6 hasObservers', o.hasObs, false);
    });
    // A7: a computed / effect created in a dead body is unowned (dead owner adopts nothing; DV-A1-4). Pin.
    it('[A7] computed created in a dead body: ownerOf === undefined (pin)', () => {
        const o = worldDeadBody((r, o2) => { o2.c = r.computed(() => 1); o2.own = r.ownerOf(o2.c); });
        eq('A7 computed ownerOf', o.own, undefined);
    });
    it('[A7] effect created in a dead body: ownerOf === undefined (pin)', () => {
        const o = worldDeadBody((r, o2) => { o2.e = r.effect(() => {}); o2.own = r.ownerOf(o2.e); });
        eq('A7 effect ownerOf', o.own, undefined);
    });
});

// ---------------------------------------------------------------------------------------------------------
// W rows (depend on the maintainer ruling Q-E1-1 A; if it drops them the rows go).
// ---------------------------------------------------------------------------------------------------------
describe('[W1] [W2] runWithOwner owner disposed inside a nested computed frame (S10 shape)', () => {
    it('[W1] ownerOf(c) === undefined after the owner died and 4 signals took slots', red, () => {
        // Shape of .handoff/arg/w1-recycled-owner-probe.mjs: x idle computed; runWithOwner(x, ...): inner disposes x, 4 signals,
        // then computed c. Frozen: the first signal recycles x's slot; the frame restore re-seats it as currentOwner; c is adopted
        // by a recycled "signal" node (ownerOf(c).kind === 'signal'). Expected: c is unowned.
        const r = createRegistry();
        const x = r.computed(() => 1); x();
        const inner = r.computed(() => { r.dispose(x); return 0; });
        let c;
        r.runWithOwner(x, () => {
            inner();
            for (let i = 0; i < 4; i++) r.signal(i);
            c = r.computed(() => 2);
        });
        c();
        eq('W1 ownerOf', r.ownerOf(c), undefined);
    });
    function worldW2(policy) {
        // M = 4 slots: x, inner live; x idle-disposed in the scope. Frozen: x goes to the free list, the 3rd create (after 2
        // fillers) still finds a slot. With the scope pin x stays unusable: 2 fillers exhaust the pool, the 3rd create misses at
        // depth 0 inside the open scope: 'throw' -> CapacityError, 'grow' -> poolGrowths + 1.
        const cfg = policy === 'throw' ? { maxNodes: 4, onCapacityExceeded: 'throw' } : { maxNodes: 4, onCapacityExceeded: 'grow', prealloc: 'eager' };
        const r = createRegistry(cfg);
        const x = r.computed(() => 1); x();
        const inner = r.computed(() => { r.dispose(x); return 0; });
        const o = { r, err: null, growthsBefore: 0, growthsAfter: 0, afterScopeErr: null };
        r.runWithOwner(x, () => {
            inner();
            r.signal(0); r.signal(1);
            o.growthsBefore = r.stats().poolGrowths;
            try { r.signal(2); } catch (e) { o.err = e; }
            o.growthsAfter = r.stats().poolGrowths;
        });
        try { r.signal(3); } catch (e) { o.afterScopeErr = e; }
        return o;
    }
    it('[W2] throw policy: the depth-0 miss in the open scope throws CapacityError', red, () => {
        const o = worldW2('throw');
        eq('W2 throw err', o.err instanceof CapacityError, true);
    });
    it('[W2] grow policy: the depth-0 miss in the open scope grows the pool (poolGrowths +1)', red, () => {
        const o = worldW2('grow');
        eq('W2 grow err', o.err, null);
        eq('W2 grow delta', o.growthsAfter - o.growthsBefore, 1);
    });
    it('[W2] after the scope closes the pinned slot is usable again (throw policy: no error)', red, () => {
        // With the scope pin the slot is released at the next miss once scopeDepth is 0: inner, 2 fillers, pinned x = 4 slots,
        // the create after the scope succeeds. (Frozen: x was recycled in the scope, all 4 slots live: the create throws.)
        const o = worldW2('throw');
        eq('W2 after-scope err', o.afterScopeErr, null);
    });
});

// ---------------------------------------------------------------------------------------------------------
// R rows (ARG-E1 review round 1): the scope-pin edges. Shapes and expected values are the reviewer's.
// ---------------------------------------------------------------------------------------------------------
const R_E = new Error('e');
it('R1 fn throws: scope popped, frame-pinned slot released after (M17)', () => {
    const r = createRegistry({ maxNodes: 3, onCapacityExceeded: 'throw' });
    const own = r.computed(() => 1); own();
    assert.throws(() => r.runWithOwner(own, () => { throw R_E; }), /^Error: e$/);
    let c; c = r.computed(() => { r.dispose(c); return 1; }); c();
    r.signal(0);
    let err = null; try { r.signal(1); } catch (e) { err = e; }
    assert.equal(err, null);
});
it('R2 outer scope owner disposed inside a nested scope, frame restore (M18)', () => {
    const r = createRegistry();
    const x = r.computed(() => 1), y = r.computed(() => 2); x(); y();
    let c;
    const F = r.computed(() => { r.runWithOwner(y, () => { r.dispose(x); }); for (let i = 0; i < 4; i++) r.signal(i); return 0; });
    r.runWithOwner(x, () => { F(); c = r.computed(() => 2); });
    c();
    assert.equal(r.ownerOf(c), undefined);
});
it('R3 an unrelated node disposed in a scope is not pinned (M20)', () => {
    const r = createRegistry({ maxNodes: 3, onCapacityExceeded: 'throw' });
    const x = r.computed(() => 1); x();
    let err = null;
    r.runWithOwner(x, () => {
        const u = r.signal(0); r.signal(1);
        r.dispose(u);
        try { r.signal(2); } catch (e) { err = e; }
    });
    assert.equal(err, null);
});
for (const [name, mk] of [['undefined', () => undefined], ['forged', () => ({})], ['signal', (r) => r.signal(9)], ['disposed', (r) => { const d = r.computed(() => 1); d(); r.dispose(d); return d; }]]) {
    it('R4 no-owner scope (' + name + ') does not block a frame-pinned release (fix row)', () => {
        const r = createRegistry({ maxNodes: 3, onCapacityExceeded: 'throw' });
        const t = mk(r);
        let err = null, c;
        r.runWithOwner(t, () => {
            c = r.computed(() => { r.dispose(c); return 1; }); c();
            r.signal(0);
            if (name !== 'signal') r.signal(1);
            try { r.signal(2); } catch (e) { err = e; }
        });
        assert.equal(err, null);
    });
}
// R5, R6 (ARG-E1 review round 2): the false arm of the conditional push / pop (mutants MPOPU, MPUSHU).
for (const exit of ['throw', 'return']) {
    for (const [name, mk] of [['undefined', () => undefined], ['forged', () => ({})]]) {
        it('R5 no-owner scope (' + name + ', ' + exit + ') pops nothing: a frame-pinned slot is released after', () => {
            const r = createRegistry({ maxNodes: 3, onCapacityExceeded: 'throw' });
            let got = null;
            try { r.runWithOwner(mk(), () => { if (exit === 'throw') throw R_E; }); } catch (e) { got = e; }
            assert.equal(got, exit === 'throw' ? R_E : null);
            let c; c = r.computed(() => { r.dispose(c); return 1; }); c();
            r.signal(0); r.signal(1);
            let err = null; try { r.signal(2); } catch (e) { err = e; }
            assert.equal(err, null);
        });
    }
}
it('R6 a no-owner scope that throws inside a real scope leaves the real owner pinned', () => {
    const r = createRegistry();
    const x = r.computed(() => 1); x();
    const inner = r.computed(() => { r.dispose(x); return 0; });
    let c;
    r.runWithOwner(x, () => {
        try { r.runWithOwner(undefined, () => { throw R_E; }); } catch (e) { assert.equal(e, R_E); }
        inner();
        for (let i = 0; i < 4; i++) r.signal(i);
        c = r.computed(() => 2);
    });
    c();
    assert.equal(r.ownerOf(c), undefined);
});

// ---------------------------------------------------------------------------------------------------------
// F8 rows: op 4 fires AFTER the edge is gone.
// ---------------------------------------------------------------------------------------------------------
// Sever world: g, a; eff = effect(() => { if (g()) a(); }); g.set(false) severs the (a -> eff) edge via the epilogue.
function worldSever(opts) {
    const r = createRegistry();
    const g = r.signal(true), a = r.signal(1);
    const w = { r, g, a, conn: 0, disc: 0, got: null, runs: 0, listenerSeen: null };
    if (opts && opts.hooks) r.observeObservers(a, { onConnect() { w.conn++; }, onDisconnect() { w.disc++; if (opts.discThrows) throw ED; } });
    w.eff = r.effect(() => { w.runs++; if (g()) a(); });
    w.idA = r.nodeId(a);
    w.idEff = r.nodeId(w.eff);
    w.armed = true;
    r.onGraphMutation((op, x, y) => {
        if (!w.armed || op !== 4 || x !== w.idA) return;
        w.armed = false;
        if (opts && opts.on4) opts.on4(w, x, y);
        if (opts && opts.throws) throw E;
    });
    try { g.set(false); } catch (e) { w.got = e; }
    return w;
}

describe('[T1] throwing op 4 in a re-track sever', () => {
    // Derivation: the effect had links (g -> eff) and (a -> eff) = 2. After g.set(false) the (a -> eff) edge is severed; E
    // surfaces from the listener. Fixed order: the edge is gone BEFORE the listener: 1 link, a has no observer. Frozen: the
    // throw precedes the unlink: 2 links, a still observed, snapshot() throws (half-freed state).
    it('[T1] E surfaces (identity) (pin)', () => { eq('T1 got', worldSever({ throws: true }).got === E, true); });
    it('[T1] activeLinks === 1', red, () => { eq('T1 links', worldSever({ throws: true }).r.stats().activeLinks, 1); });
    it('[T1] hasObservers(a) === false', red, () => { const w = worldSever({ throws: true }); eq('T1 hasObservers', w.r.hasObservers(w.a), false); });
    it('[T1] snapshot() does not throw', red, () => {
        const w = worldSever({ throws: true });
        let err = null;
        try { w.r.snapshot(); } catch (e) { err = e; }
        eq('T1 snapshot err', err, null);
    });
});

describe('[T2] throwing op 4 in a dispose walk (deps a, b)', () => {
    function worldT2() {
        const r = createRegistry();
        const a = r.signal(1), b = r.signal(2);
        const w = { r, a, b, got: null, armed: true };
        const stop = r.effect(() => { a(); b(); });
        w.stop = stop;
        r.onGraphMutation((op) => { if (w.armed && op === 4) { w.armed = false; throw E; } });
        try { stop(); } catch (e) { w.got = e; }
        return w;
    }
    // Derivation: the walk frees (a -> eff) first, op 4 throws after that edge is gone; (b -> eff) is never reached.
    it('[T2] activeLinks === 1', red, () => { eq('T2 links', worldT2().r.stats().activeLinks, 1); });
    it('[T2] hasObservers(a) === false', red, () => { const w = worldT2(); eq('T2 a', w.r.hasObservers(w.a), false); });
    it('[T2] hasObservers(b) === true', () => {
        // pin: b's edge is not reached on frozen either (hook throws first), so b stays observed
        const w = worldT2(); eq('T2 b', w.r.hasObservers(w.b), true);
    });
    it('[T2] stats().effects === 1 (disposal aborted, node still counted)', () => {
        const w = worldT2(); eq('T2 effects', w.r.stats().effects, 1);
    });
    it('[T2] E surfaces (identity)', () => { eq('T2 got', worldT2().got === E, true); });
    // Re-dispose (T0 probe, frozen column): stop() again is a no-op (the handle's own latch; F9 is out of scope): no throw, state
    // unchanged. dispose(handle) walks again: here the hand-derived value is a clean teardown (a's edge is already gone, b's
    // is freed): effects 0, links 0, nothing observed. Frozen probe: effects 0, links 1 (the leaked a-edge), a still observed.
    it('[T2] stop() again does not throw (latch; pin)', () => {
        const w = worldT2();
        let err = null;
        try { w.stop(); } catch (e) { err = e; }
        eq('T2 stop-again err', err, null);
    });
    it('[T2] dispose(handle) after the throw: effects 0', () => {
        const w = worldT2(); w.r.dispose(w.stop);
        eq('T2 re-dispose effects', w.r.stats().effects, 0);
    });
    it('[T2] dispose(handle) after the throw: activeLinks 0', red, () => {
        const w = worldT2(); w.r.dispose(w.stop);
        eq('T2 re-dispose links', w.r.stats().activeLinks, 0);
    });
    it('[T2] dispose(handle) after the throw: a and b unobserved', red, () => {
        const w = worldT2(); w.r.dispose(w.stop);
        eq('T2 re-dispose [a, b]', [w.r.hasObservers(w.a), w.r.hasObservers(w.b)], [false, false]);
    });
});

describe('[T3] throwing op 4 in an allocateLink sever (reads g, a, b; re-run reads g, c)', () => {
    function worldT3() {
        const r = createRegistry();
        const g = r.signal(true), a = r.signal(1), b = r.signal(2), c = r.signal(3);
        const w = { r, g, a, b, c, got: null, armed: false };
        r.effect(() => { if (g()) { a(); b(); } else { c(); } });
        w.armed = true;
        r.onGraphMutation((op) => { if (w.armed && op === 4) { w.armed = false; throw E; } });
        try { g.set(false); } catch (e) { w.got = e; }
        return w;
    }
    // Derivation: 3 links before (g, a, b). The re-run reads g (cursor match), then c: the stale (a, b) tail is severed; the
    // first op 4 throws after its edge is gone. Plan ASSERTIONS: links 1, a / b / c all unobserved. Frozen: links 2.
    it('[T3] E surfaces (identity) (pin)', () => { eq('T3 got', worldT3().got === E, true); });
    it('[T3] activeLinks === 1', red, () => { eq('T3 links', worldT3().r.stats().activeLinks, 1); });
    it('[T3] hasObservers(a) === false', red, () => { const w = worldT3(); eq('T3 a', w.r.hasObservers(w.a), false); });
    it('[T3] hasObservers(b) === false (pin)', () => { const w = worldT3(); eq('T3 b', w.r.hasObservers(w.b), false); });
    it('[T3] hasObservers(c) === false', () => { const w = worldT3(); eq('T3 c', w.r.hasObservers(w.c), false); });
});

describe('[T4] [T5] throwing op 4 still fires the 1->0 onDisconnect', () => {
    it('[T4] [connects, disconnects] after a new subscriber === [2, 1]', red, () => {
        // Derivation: connect 1 (eff reads a). g.set(false): op 4 throws E; the catch arm still fires 1->0 (disc 1), then
        // rethrows. A new effect reading a is a 0->1 connect (2). Frozen: the edge is never freed: [1, 0].
        const w = worldSever({ hooks: true, throws: true });
        w.r.effect(() => { w.a(); });
        eq('T4 [conn, disc]', [w.conn, w.disc], [2, 1]);
    });
    it('[T4] E surfaces (pin)', () => { eq('T4 got', worldSever({ hooks: true, throws: true }).got === E, true); });
    it('[T5] op 4 and onDisconnect both throw: the onDisconnect error surfaces', red, () => {
        const w = worldSever({ hooks: true, throws: true, discThrows: true });
        eq('T5 got', w.got === ED, true);
    });
    it('[T5] onDisconnect ran once', red, () => {
        const w = worldSever({ hooks: true, throws: true, discThrows: true });
        eq('T5 disc', w.disc, 1);
    });
});

describe('[T6] [O2] the listener sees the edge already gone and pooled', () => {
    function worldObs() {
        const seen = {};
        const w = worldSever({ on4(w2) {
            seen.has = w2.r.hasObservers(w2.a);
            const st = w2.r.stats();
            seen.active = st.activeLinks;
            seen.pooled = st.pooledLinks;
            seen.cap = st.linkPoolCapacity;
        } });
        seen.final = w.r.stats();
        return seen;
    }
    // Derivation (O2): the effect had 2 links; inside op 4 of the last (a -> eff) edge the listener must see it gone:
    // hasObservers(a) false, activeLinks already decremented to 1. Frozen: true, 2.
    it('[O2] hasObservers(a) === false inside op 4', red, () => { eq('O2 has', worldObs().has, false); });
    it('[O2] activeLinks === 1 inside op 4 (post-decrement)', red, () => { eq('O2 active', worldObs().active, 1); });
    // T6: pooledLinks === linkPoolCapacity - activeLinks (d.ts / stats()); the link is back in the pool BEFORE the hook: at
    // the hook, pooled = cap - 1; a hook placed between the unlink and the pool push / decrement sees cap - 2 (off by one).
    it('[T6] pooledLinks === linkPoolCapacity - 1 inside op 4 (link already pooled)', red, () => {
        const s = worldObs();
        eq('T6 pooled', s.pooled, s.cap - 1);
    });
    it('[T6] after the sever, pooledLinks === linkPoolCapacity - 1 (same as inside the hook)', () => {
        // pin: the settled state is the same on frozen
        const s = worldObs();
        eq('T6 settled', s.final.pooledLinks, s.final.linkPoolCapacity - 1);
    });
});

describe('[H1-H5] the op-4 listener mutates the graph (regression pins: green on frozen via C10, the mutants are the teeth)', () => {
    it('[H1] hook disposes the source: onDisconnect 0, links 1', () => {
        // Derivation: dispose(a) drops a's lifecycle registrations (dropLifecycleHooks) before the 1->0 tail, so the tail fires
        // nothing; remaining link: (g -> eff).
        const w = worldSever({ hooks: true, on4: (w2) => { w2.r.dispose(w2.a); } });
        eq('H1 disc', w.disc, 0);
        eq('H1 links', w.r.stats().activeLinks, 1);
    });
    it('[H2] hook disposes the target: effects 0, links 0, onDisconnect 1', () => {
        // The running effect is disposed from the op-4 listener: its other link (g) goes too (0 links, 0 effects); a is still
        // alive, its last subscriber left: the 1->0 onDisconnect fires once.
        const w = worldSever({ hooks: true, on4: (w2) => { w2.r.dispose(w2.eff); } });
        eq('H2 effects', w.r.stats().effects, 0);
        eq('H2 links', w.r.stats().activeLinks, 0);
        eq('H2 disc', w.disc, 1);
    });
    it('[H3] hook disposes both: effects 0, links 0, onDisconnect 0', () => {
        const w = worldSever({ hooks: true, on4: (w2) => { w2.r.dispose(w2.a); w2.r.dispose(w2.eff); } });
        eq('H3 effects', w.r.stats().effects, 0);
        eq('H3 links', w.r.stats().activeLinks, 0);
        eq('H3 disc', w.disc, 0);
    });
    it('[H4] hook adds a new effect on the same source: links 2, [connects, disconnects] [1, 0]', () => {
        // The new effect reads a while the old edge is gone (a has no subscriber). The registration is still in phase 1
        // (connected): no second onConnect; at the tail a has a subscriber again: no onDisconnect. Links: (g -> eff), (a -> eff2).
        const w = worldSever({ hooks: true, on4: (w2) => { w2.r.effect(() => { w2.a(); }); } });
        eq('H4 links', w.r.stats().activeLinks, 2);
        eq('H4 [conn, disc]', [w.conn, w.disc], [1, 0]);
    });
    it('[H5] recycled source resident with a registration: the resident onDisconnect fires 0 times', () => {
        // The hook disposes a, then a new signal b takes a's pooled slot and registers onDisconnect (phase 0). The tail checks
        // the (recycled) object: headSub null, but the resident reg is in phase 0 -> no fire.
        let resident = 0;
        const w = worldSever({ hooks: true, on4: (w2) => {
            w2.r.dispose(w2.a);
            const b = w2.r.signal(9);
            w2.r.observeObservers(b, { onDisconnect() { resident++; } });
        } });
        eq('H5 resident', resident, 0);
        eq('H5 original disc', w.disc, 0);
    });
});

// ---------------------------------------------------------------------------------------------------------
// O1: the op log + callback log of G1-G10, deepEqual to the golden cut from the FROZEN build (T0).
// Op-log lines: '1:id:flags' create, '2:id:flags' dispose, '3:src->tgt', '4:src->tgt', '5:id' recompute; 'cb:' lines are
// onConnect / onDisconnect callbacks, interleaved in call order.
// ---------------------------------------------------------------------------------------------------------
function recLog(r, log, act) {
    r.onGraphMutation((op, x, y) => {
        log.push(op === 3 || op === 4 ? op + ':' + x + '->' + y : op === 5 ? '5:' + x : op + ':' + x + ':' + y);
        if (act) act(op, x, y);
    });
}
const G = {
    G1(createReg) { // sever 2 stale edges
        const r = createReg(), log = []; recLog(r, log);
        const g = r.signal(true), a = r.signal(1), b = r.signal(2);
        r.effect(() => { if (g()) { a(); b(); } });
        g.set(false);
        return log;
    },
    G2(createReg) { // dispose an effect with 3 deps
        const r = createReg(), log = []; recLog(r, log);
        const a = r.signal(1), b = r.signal(2), c = r.signal(3);
        const stop = r.effect(() => { a(); b(); c(); });
        stop();
        return log;
    },
    G3(createReg) { // dispose a signal with 2 subs
        const r = createReg(), log = []; recLog(r, log);
        const a = r.signal(1);
        r.effect(() => { a(); });
        r.effect(() => { a(); });
        r.dispose(a);
        return log;
    },
    G4(createReg) { // computed chain, ops 3 / 4 / 5
        const r = createReg(), log = []; recLog(r, log);
        const a = r.signal(1);
        const c1 = r.computed(() => a() + 1);
        const c2 = r.computed(() => c1() * 2);
        const stop = r.effect(() => { c2(); });
        a.set(5);
        stop();
        c2();
        r.dispose(c2);
        return log;
    },
    G5(createReg) { // box
        const r = createReg(), log = []; recLog(r, log);
        const sb = r.signalBox(1);
        const cb = r.computedBox(() => sb.get() + 1);
        const stop = r.effect(() => { cb.get(); });
        sb.set(2);
        stop();
        r.dispose(cb);
        return log;
    },
    G6(createReg) { // onConnect / onDisconnect interleaved
        const r = createReg(), log = []; recLog(r, log);
        const a = r.signal(1), g = r.signal(true);
        r.observeObservers(a, { onConnect() { log.push('cb:connect'); }, onDisconnect() { log.push('cb:disconnect'); } });
        const e1 = r.effect(() => { if (g()) a(); });
        const e2 = r.effect(() => { a(); });
        g.set(false);
        e2();
        g.set(true);
        e1();
        return log;
    },
    G7(createReg) { // batch
        const r = createReg(), log = []; recLog(r, log);
        const g = r.signal(true), a = r.signal(1), b = r.signal(1);
        r.effect(() => { if (g()) { a(); b(); } });
        r.batch(() => { g.set(false); a.set(5); b.set(6); });
        return log;
    },
    G8(createReg) { // C10a shape: op-4 hook disposes link.source during a dispose walk
        const r = createReg(), log = [];
        const a = r.signal(0), b = r.signal(0);
        const stop = r.effect(() => { a(); b(); });
        const ida = r.nodeId(a);
        let armed = true;
        recLog(r, log, (op, x) => { if (armed && op === 4 && x === ida) { armed = false; r.dispose(a); } });
        stop();
        return log;
    },
    G9(createReg) { // C10b shape: op-4 hook disposes link.source during a severTail walk
        const r = createReg(), log = [];
        const g = r.signal(true), a = r.signal(0), b = r.signal(0);
        r.effect(() => { if (g()) { a(); b(); } });
        const ida = r.nodeId(a);
        let armed = true;
        recLog(r, log, (op, x) => { if (armed && op === 4 && x === ida) { armed = false; r.dispose(a); } });
        g.set(false);
        return log;
    },
    G10(createReg) { // reset
        const r = createReg(), log = []; recLog(r, log);
        const a = r.signal(1), b = r.signal(2);
        const c = r.computed(() => a() + b());
        r.effect(() => { c(); });
        r.observeObservers(a, { onDisconnect() { log.push('cb:disconnect'); } });
        r.reset();
        return log;
    },
};
function cutAll() {
    const out = {};
    for (const k of Object.keys(G)) out[k] = G[k](() => createRegistry());
    return out;
}
describe('[O1] op log + callback log of G1-G10 equal the golden cut from the frozen build', () => {
    const golden = process.env.E1_CUT_GOLDEN ? null : JSON.parse(readFileSync(GOLDEN_URL, 'utf8'));
    if (process.env.E1_CUT_GOLDEN) {
        it('[O1] cut golden (E1_CUT_GOLDEN)', () => {
            writeFileSync(GOLDEN_URL, JSON.stringify(cutAll(), null, 1) + '\n');
        });
        return;
    }
    it('[O1] golden has G1-G10, each non-empty', () => {
        eq('O1 keys', Object.keys(golden), Object.keys(G));
        for (const k of Object.keys(G)) assert.ok(golden[k].length > 0, k + ' empty');
    });
    for (const k of Object.keys(G)) {
        // pin: the ops / callbacks are state-independent lines, so the fix must not change them (mutant: swap op 4 and 1->0)
        it('[O1] ' + k + ' op + callback log === golden (pin)', () => { eq('O1 ' + k, G[k](() => createRegistry()), golden[k]); });
    }
});

// ---------------------------------------------------------------------------------------------------------
// GC: a no-op listener, 1e5 severs -> 0 B/op (test/81 pattern; needs --expose-gc, else SKIP).
// ---------------------------------------------------------------------------------------------------------
const nap = (ms) => new Promise((res) => setTimeout(res, ms));
describe('[GC] a no-op op-4 listener over 1e5 severs allocates nothing', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    function stepper() {
        const r = createRegistry();
        let ops = 0;
        r.onGraphMutation(() => { ops++; });
        const g = r.signal(true), a = r.signal(1);
        r.effect(() => { if (g()) a(); });
        let k = 0;
        const step = () => { g.set((++k & 1) === 0); }; // odd step: g false (sever), even step: g true (relink)
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
    it('[GC] 1e5 severs (2e5 steps): major 0, minor 0, retained < 0.5 B/op, listener really counted ops', async () => {
        const s = stepper();
        const ops0 = s.ops();
        const m = await window(s, 200000);
        assert.ok(s.ops() - ops0 > 400000, 'listener counted ops (each sever = op 4, each relink = op 3, each run = op 5)');
        eq('GC major', m.major, 0);
        eq('GC minor', m.minor, 0);
        assert.ok(m.grewBpo < 0.5, 'retained B/op ' + m.grewBpo);
    });
    it('[GC] CONTROL (transient): a throwaway 32-slot array per step in a 64-slot ring -> minor > 0', async () => {
        const s = stepper();
        const ring = new Array(64).fill(null);
        let j = 0;
        const step = () => { s(); ring[j] = new Array(32).fill(j); j = (j + 1) & 63; };
        const m = await window(step, 200000);
        assert.ok(m.minor > 0, 'transient control minor ' + m.minor);
    });
    it('[GC] CONTROL (retained): one kept {} per step -> growth >= 8 B/op', async () => {
        const s = stepper();
        const keep = [];
        const step = () => { s(); keep.push({ v: keep.length }); };
        const m = await window(step, 100000);
        assert.ok(m.grewBpo >= 8, 'control growth B/op ' + m.grewBpo);
    });
});

// ---------------------------------------------------------------------------------------------------------
// Retention: 1000 dead-owner onCleanup cycles. The cleanup closes over a tracked payload; the dropped cleanup must not retain it.
// Frozen: the ghost cleanup sits on the pinned slot, so the payloads stay reachable (size > 0: T0 probe).
// ---------------------------------------------------------------------------------------------------------
describe('[Retention] 1000 dead-owner onCleanup cycles return the leak tracker to size() === 0', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    async function run(keep) {
        const tr = createLeakTracker({ name: 'e1-retention', onLeak() {}, onWarning() {} });
        const r = createRegistry({ maxNodes: 4096 });
        const held = [];
        const tick = r.signal(0);
        // payloads are created inside the sync helper so no frame of this async function holds the last one
        function cycle(i) {
            const pay = { i };
            tr.track(pay, null, 'pay' + i);
            if (keep) held.push(pay);
            let go = false;
            const inner = r.computed(() => { r.dispose(outer); return 0; });
            const outer = r.computed(() => { tick(); if (go) { inner(); r.onCleanup(() => { pay.i++; }); } return 1; });
            outer();
            go = true;
            tick.set(i + 1);
            outer();
            r.dispose(inner);
        }
        for (let i = 0; i < 1000; i++) cycle(i);
        let n = tr.size();
        for (let t = 0; t < 40 && n !== 0; t++) { globalThis.gc(); await nap(10); n = tr.size(); }
        return { n, held };
    }
    it('[Retention] tracker.size() === 0 after gc (frozen: > 0, T0 probe)', red, async () => {
        const o = await run(false);
        eq('Retention size', o.n, 0);
    });
    it('[Retention] CONTROL: payloads held by the test stay tracked (size 1000)', async () => {
        const o = await run(true);
        eq('Retention control', o.n, 1000);
        eq('Retention control held', o.held.length, 1000);
    });
});
