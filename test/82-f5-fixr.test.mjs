// 82-f5-fixr.test.mjs -- A3 FIX-R (DIV-F5 / LEDGER #36), burst 107/108 batch B2; AUD-E2 (D-AUD-3, D-AUD-4) re-pin.
// F5: a pre-batch revert (set(x); ...; set(back)) must not restore the old version when a body (computed / effect
// recompute) that DIRECTLY subscribes to s ran between the capture and the revert -- that body saw the intermediate value.
// AUD-E2: the hot per-body counter is gone. The capture stores globalVersion (preBatchEvals); the revert is blocked iff a
// direct subscriber of s is mid-run (FLAG_COMPUTING) or has an evalVersion past that capture (cold revertBlocked).
// INDEPENDENT ORACLE: PLAN-A3 ASSERTIONS A1-A4 + ADDENDUM 1-3, PLAN-AUD-E2 TASKS 4-5 / ASSERTIONS A2 A4. Expected values are
// derived from the semantics (what a reader of s at batch close must see), never from a kernel run (R6b and the 8-direct-
// subscriber GC row pin values probed on the combined build, as the plan directs).
// Rows (each A1 / A2 row runs on signal() AND on signalBox()/computedBox(); the box rows are the red-first boxSet rows):
//   R1 R2 R3 R4 R5 R6b = REGRESSION F5 (red on the 0628127b build). G1 G2 G3 G4, GC rows, RETENTION rows = pins
//   (green before and after); GC / retention carry must-fail controls.
//   SRC-PIN: no evalCount token, exact fireRecompute body, revertBlocked(node) at exactly 2 call sites, the capture at 2.
//   D-4 8BIT: the old reduced-width scratch kernel is gone (no counter); the real kernel at N = 255 / 256 / 257 / 512 blocks.
// Kernel: LITE_SIGNAL_KERNEL (absolute path), default ../Signal.js. GC / retention rows need --expose-gc (else SKIP);
//   the GC lane runs --expose-gc --max-semi-space-size=4.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const { createRegistry } = await import(KPATH);
const HAVE_GC = typeof globalThis.gc === 'function';
const nap = (ms) => new Promise((res) => setTimeout(res, ms));

// ---- helpers: one world, two flavours ---------------------------------------
function mk(r, box, v, opts) {
    if (!box) { const s = r.signal(v, opts); return { get: s, set: s.set }; }
    const s = r.signalBox(v, opts); return { get: () => s.get(), set: (x) => s.set(x) };
}
function cmp(r, box, fn) {
    if (!box) return r.computed(fn);
    const c = r.computedBox(fn); return () => c.get();
}
const FLAVOURS = [['signal', false], ['box', true]];
function both(title, expectLabel, fn) {
    for (const [name, box] of FLAVOURS) it(title + ' [' + name + ']', () => { fn(box); });
}

describe('A1 REGRESSION F5: a revert must not outlive a body that ran in the batch', () => {
    // s=1, c=s*10, effect E logs c.  batch{ s.set(2); c(); s.set(1) } -> c() === 10 and E log [10, 10]
    // (E is re-marked by the revert-as-write, so it re-runs once with the unchanged value 10; before: c() stuck at 20).
    both('R1 REGRESSION: computed read mid-batch, revert -> c() === 10, E log [10,10]', null, (box) => {
        const r = createRegistry();
        const s = mk(r, box, 1);
        const c = cmp(r, box, () => s.get() * 10);
        const L = [];
        r.effect(() => { L.push(c()); });
        r.batch(() => { s.set(2); c(); s.set(1); });
        assert.equal(c(), 10);
        assert.deepEqual(L, [10, 10]);
    });

    // R2: the same world as R1 but the assertion is on the value the later reader sees after a fresh write cycle; it
    // runs on both flavours so the boxSet revert guard (M4) is red here while the signal() row R1 stays green.
    both('R2 REGRESSION: after the batch a plain write still propagates (c() 10 -> 30 -> E sees 30)', null, (box) => {
        const r = createRegistry();
        const s = mk(r, box, 1);
        const c = cmp(r, box, () => s.get() * 10);
        const L = [];
        r.effect(() => { L.push(c()); });
        r.batch(() => { s.set(2); c(); s.set(1); });
        assert.equal(c(), 10);
        s.set(3);
        assert.equal(c(), 30);
        assert.equal(L[L.length - 1], 30);
    });

    // R3: an effect created mid-batch reads s=2; the revert must re-run it with 1 -> m = [2, 1] (before [2]).
    both('R3 REGRESSION: effect created mid-batch re-runs on the revert -> [2,1]', null, (box) => {
        const r = createRegistry();
        const s = mk(r, box, 1);
        const m = [];
        r.batch(() => { s.set(2); r.effect(() => { m.push(s.get()); }); s.set(1); });
        assert.deepEqual(m, [2, 1]);
    });

    // R4: conditional computed drops a dep mid-batch; after the revert it must be live again.
    both('R4 REGRESSION: conditional computed after revert: c() 1, then a.set(5) -> c() 5, E last 5', null, (box) => {
        const r = createRegistry();
        const flag = mk(r, box, true), a = mk(r, box, 1), b = mk(r, box, 100);
        const c = cmp(r, box, () => (flag.get() ? a.get() : b.get()));
        const L = [];
        r.effect(() => { L.push(c()); });
        r.batch(() => { flag.set(false); c(); flag.set(true); });
        assert.equal(c(), 1);
        a.set(5);
        assert.equal(c(), 5);
        assert.equal(L[L.length - 1], 5);
    });

    // R5: c throws when s === 2; read in try/catch mid-batch; revert -> c() === 10 (before: rethrows the cached error).
    both('R5 REGRESSION: computed that threw mid-batch recovers on the revert -> c() === 10', null, (box) => {
        const r = createRegistry();
        const s = mk(r, box, 1);
        const c = cmp(r, box, () => { if (s.get() === 2) throw new Error('two'); return s.get() * 10; });
        c();
        r.batch(() => { s.set(2); try { c(); } catch (e) { /* expected */ } s.set(1); });
        assert.equal(c(), 10);
    });

    // R6b (replaces R6, see B0-REPORT): the op-5 hook throws once during c's recompute inside the batch. AUD-E2: the
    // abandoned run keeps c's link to s (fireOp5 restores the context), c is stamped past the capture, so the revert is
    // blocked and the direct effect E on s re-runs -> E log [1, 1] (probed on the combined build; with revertBlocked
    // alone and no fireOp5 catch it is [1]: the links are severed and nothing is left to see).
    both('R6b REGRESSION: throwing op-5 hook inside the batch still blocks the revert -> E log [1,1]', null, (box) => {
        const r = createRegistry();
        const s = mk(r, box, 1);
        const c = cmp(r, box, () => s.get() * 10);
        c();
        const L = [];
        r.effect(() => { L.push(s.get()); });
        let armed = false;
        const off = r.onGraphMutation((op) => { if (op === 5 && armed) { armed = false; throw new Error('hook5'); } });
        r.batch(() => { s.set(2); armed = true; try { c(); } catch (e) { /* hook5 */ } s.set(1); });
        off();
        assert.deepEqual(L, [1, 1]);
    });
    both('R7 REGRESSION: a second write after the body does not re-arm the revert -> c() === 10, E log [10,10]', null, (box) => { const r = createRegistry(); const s = mk(r, box, 1); const c = cmp(r, box, () => s.get() * 10); const L = []; r.effect(() => { L.push(c()); }); r.batch(() => { s.set(2); c(); s.set(3); s.set(1); }); assert.equal(c(), 10); assert.deepEqual(L, [10, 10]); });
});

describe('A2 pins: reverts that must stay suppressed (green before and after)', () => {
    both('G1 pin: batch{s.set(2); s.set(1)} with no body between -> E log exactly [1]', null, (box) => {
        const r = createRegistry();
        const s = mk(r, box, 1);
        const L = [];
        r.effect(() => { L.push(s.get()); });
        r.batch(() => { s.set(2); s.set(1); });
        assert.deepEqual(L, [1]);
    });
    both('G2 pin: custom equals (floor) revert 2 -> 1.5 of 1 -> E log [1]', null, (box) => {
        const r = createRegistry();
        const s = mk(r, box, 1, { equals: (x, y) => Math.floor(x) === Math.floor(y) });
        const L = [];
        r.effect(() => { L.push(s.get()); });
        r.batch(() => { s.set(2); s.set(1.5); });
        assert.deepEqual(L, [1]);
    });
    both('G3 pin: nested batch, inner writes, outer reverts -> E log [1]', null, (box) => {
        const r = createRegistry();
        const s = mk(r, box, 1);
        const L = [];
        r.effect(() => { L.push(s.get()); });
        r.batch(() => { r.batch(() => { s.set(2); }); s.set(1); });
        assert.deepEqual(L, [1]);
    });
    both('G4 pin: unrelated body BEFORE the first write, then revert -> E log [1] (the p2 "iff")', null, (box) => {
        const r = createRegistry();
        const s = mk(r, box, 1), z = mk(r, box, 0);
        const u = cmp(r, box, () => z.get() + 1);
        const L = [];
        r.effect(() => { L.push(s.get()); });
        r.batch(() => { u(); s.set(2); s.set(1); });
        assert.deepEqual(L, [1]);
    });
});

// ---- A5 source pin + D-4 boundary rows ---------------------------------------
const SRC = readFileSync(KPATH, 'utf8');
const countOf = (needle) => SRC.split(needle).length - 1;

describe('A5 SRC-PIN REGRESSION (AUD-E2): the hot body-run counter is gone', () => {
    it('no `evalCount` token anywhere in the source (code or comment)', () => {
        assert.equal((SRC.match(/\bevalCount\b/g) || []).length, 0);
    });
    it('fireRecompute is exactly `if (mutationHook !== null) fireOp5(node);` and fireOp5 restores the context then rethrows', () => {
        assert.equal(countOf('function fireRecompute(node) { if (mutationHook !== null) fireOp5(node); }'), 1);
        assert.equal(countOf('function fireOp5(node) { try { mutationHook(5, node.id, 0); } catch (e) { activeObserverCurrentDep = null; throw e; } }'), 1);
        assert.equal(countOf('function fireRecompute('), 1);
    });
    it('`revertBlocked(node)` has exactly 2 call sites (read.set, boxSet) plus its definition; the capture `preBatchEvals = globalVersion` appears exactly 2 times', () => {
        assert.equal(countOf('!revertBlocked(node)'), 2);
        assert.equal((SRC.match(/\brevertBlocked\(/g) || []).length, 3, 'definition + 2 calls');
        assert.equal(countOf('function revertBlocked(node)'), 1);
        assert.equal(countOf('preBatchEvals = globalVersion'), 2);
    });
});

// World (D-4): s=1, c=s*10, effect E on c; batch{ s.set(2); c(); N-1 runs of u; s.set(1) }. c is a direct subscriber of s
// that ran after the capture, so the revert is blocked at every N (no counter, no wrap): c() === 10. N = 256 is the
// CONTROL carried over from the 30-bit-mask era; 255 / 257 / 512 are the old 8-bit boundary neighbours.
async function ninetyN(createReg, N) {
    const r = createReg();
    const s = r.signal(1), z = r.signal(0);
    const u = r.computed(() => z() + 1);
    u();
    const c = r.computed(() => s() * 10);
    r.effect(() => { c(); });
    r.batch(() => { s.set(2); c(); for (let i = 1; i < N; i++) { z.set(i); u(); } s.set(1); });
    return c();
}
describe('D-4 8BIT REGRESSION: the revert stays blocked at every body-run count', () => {
    for (const N of [255, 257, 512]) {
        it('N=' + N + ' on the real kernel: c() === 10 (blocked)', async () => {
            assert.equal(await ninetyN(createRegistry, N), 10);
        });
    }
    it('CONTROL REGRESSION: the real kernel at N=256 -> c() === 10 (blocked)', async () => {
        assert.equal(await ninetyN(createRegistry, 256), 10);
    });
});

// WRAP (serial compare): the revert test is a signed int32 difference, so it must hold when globalVersion sits just below
// 2^31 and the reader's evalVersion is stamped past the wrap. Ideal (semantics): the reader ran after the capture, so the
// revert is blocked -> inside 20, c() 10. A plain `evalVersion > g0` compare reads the wrapped stamp as older -> [20, 20].
describe('D-4 WRAP REGRESSION: revert blocked across the int32 version wrap', () => {
    for (const [name, box] of FLAVOURS) {
        it('wrap [' + name + ']: gv 0x7FFFFFFE, versions 0x7FFFFFFD; batch{s.set(2); z.set(1..3); c(); s.set(1)} -> [20, 10]', () => {
            const src = createRegistry();
            const s0 = box ? src.signalBox(1) : src.signal(1);
            const z0 = src.signal(0);
            const c0 = box ? src.computedBox(() => s0.get() * 10) : src.computed(() => s0() * 10);
            if (box) c0.get(); else c0();
            const snap = src.snapshot();
            const G = 0x7FFFFFFE;
            snap.gv = G;
            for (const n of snap.nodes) {
                if (n.version !== 0) n.version = G - 1;
                if (n.evalVersion !== 0) n.evalVersion = G - 1;
                if (n.markEpoch !== 0) n.markEpoch = G - 1;
            }
            const H = {}, hs = {}, fnsById = {};
            for (const n of snap.nodes) if (n.kind !== 'signal') fnsById[n.id] = box ? () => H.s.get() * 10 : () => H.s() * 10;
            const r = src.restore(snap, { fnsById, handles: hs });
            const ids = snap.nodes.map((n) => n.id);
            H.s = hs[ids[0]];
            const z = hs[ids[1]], c = hs[ids[2]];
            const rc = box ? () => c.get() : c;
            let inside;
            r.batch(() => { H.s.set(2); z.set(1); z.set(2); z.set(3); inside = rc(); H.s.set(1); });
            assert.deepEqual([inside, rc()], [20, 10]);
        });
    }
});

// ---- A3 GC rows -------------------------------------------------------------
describe('A3 GC: 1e6 x batch{s.set(2); c(); s.set(1)} (minor 0, major 0, retained < 0.5 B/op)', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    function stepper(box, ctl) {
        const r = createRegistry();
        let sink = 0;
        let cycle, keep = [null];
        if (box) {
            const s = r.signalBox(1), c = r.computedBox(() => s.get() * 10);
            r.effect(() => { sink = (sink + c.get()) & 0x3fffffff; });
            const body = ctl ? () => { s.set(2); c.get(); s.set(1); keep[0] = [sink & 1]; } : () => { s.set(2); c.get(); s.set(1); };
            cycle = () => r.batch(body);
        } else {
            const s = r.signal(1), c = r.computed(() => s() * 10);
            r.effect(() => { sink = (sink + c()) & 0x3fffffff; });
            const body = ctl ? () => { s.set(2); c(); s.set(1); keep[0] = [sink & 1]; } : () => { s.set(2); c(); s.set(1); };
            cycle = () => r.batch(body);
        }
        return cycle;
    }
    async function window(cycle, n) {
        for (let i = 0; i < 20000; i++) cycle();
        globalThis.gc(); globalThis.gc(); await nap(20);
        const gcp = new GcProfiler().start();
        const h0 = process.memoryUsage().heapUsed;
        for (let i = 0; i < n; i++) cycle();
        const h1 = process.memoryUsage().heapUsed;
        await nap(50);
        const sum = gcp.summary(); gcp.stop();
        return { minor: sum.gc.minor, major: sum.gc.major, bpo: (h1 - h0) / n };
    }
    for (const [name, box] of FLAVOURS) {
        it(name + ': minor 0, major 0, < 0.5 B/op', async () => {
            const m = await window(stepper(box, false), 1000000);
            assert.equal(m.minor, 0, 'minor GCs');
            assert.equal(m.major, 0, 'major GCs');
            assert.ok(m.bpo < 0.5, 'B/op ' + m.bpo);
        });
    }
    it('CONTROL (transient): one throwaway 1-element array per cycle -> minor > 0 (lane not blind)', async () => {
        const m = await window(stepper(false, true), 1000000);
        assert.ok(m.minor > 0, 'control minor ' + m.minor);
    });
});

// AUD-E2 A2: the revert path with 8 direct subscribers and no body between the writes: nothing may allocate.
describe('A3b GC (AUD-E2): 2e5 x batch{s.set(2); s.set(1)} with 8 direct subscribers (minor 0, major 0)', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    const keep = [null];
    function stepper(ctl) {
        const r = createRegistry();
        const s = r.signal(1);
        let sink = 0;
        for (let k = 0; k < 8; k++) r.effect(() => { sink = (sink + s()) & 0x3fffffff; });
        const body = ctl ? () => { s.set(2); s.set(1); keep[0] = [sink & 1, 1, 2, 3, 4, 5, 6, 7]; } : () => { s.set(2); s.set(1); };
        return () => r.batch(body);
    }
    async function window(cycle, n) {
        for (let i = 0; i < 20000; i++) cycle();
        globalThis.gc(); globalThis.gc(); await nap(20);
        const gcp = new GcProfiler().start();
        for (let i = 0; i < n; i++) cycle();
        await nap(50);
        const sum = gcp.summary(); gcp.stop();
        return { minor: sum.gc.minor, major: sum.gc.major };
    }
    it('8 direct subscribers: minor 0, major 0', async () => {
        const m = await window(stepper(false), 200000);
        assert.equal(m.minor, 0, 'minor GCs');
        assert.equal(m.major, 0, 'major GCs');
    });
    it('CONTROL (transient): one throwaway 8-element array per cycle -> minor > 0 (lane not blind)', async () => {
        const m = await window(stepper(true), 200000);
        assert.ok(m.minor > 0, 'control minor ' + m.minor);
    });
});

// ---- A4 retention -----------------------------------------------------------
describe('A4 retention: 10000 x createRegistry / R3 / destroy', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    const settle = async () => { globalThis.gc(); await nap(0); globalThis.gc(); };
    async function run(hold) {
        const tracker = createLeakTracker({ name: 't82', onLeak() {}, onWarning() {} });
        const refs = [];
        let held = null;
        // The cycle body lives in a sync function: no payload stays in this async frame's registers.
        const cycle = (i) => {
            const obj = { i };
            refs.push(new WeakRef(obj));
            tracker.track(obj, null, i);
            const r = createRegistry();
            const base = { base: true };
            const s = r.signal(base);
            const m = [];
            r.batch(() => { s.set(obj); r.effect(() => { m.push(s()); }); s.set(base); });
            if (m.length !== 2 || m[0] !== obj || m[1] !== base) throw new Error('R3 shape wrong in cycle ' + i);
            if (hold && i === 0) held = r; else r.destroy();
        };
        for (let i = 0; i < 10000; i++) cycle(i);
        const alive = () => { let n = 0; for (let i = 0; i < refs.length; i++) if (refs[i].deref() !== undefined) n++; return n; };
        for (let i = 0; i < 20 && (tracker.size() > (hold ? 1 : 0) || alive() > (hold ? 1 : 0)); i++) { await settle(); await nap(10); }
        await settle(); await settle();
        return { size: tracker.size(), alive: alive(), held };
    }
    it('destroy releases everything: tracker.size() === 0 and weakAlive 0', async () => {
        const o = await run(false);
        assert.equal(o.size, 0, 'tracker.size()');
        assert.equal(o.alive, 0, 'weakAlive');
    });
    it('CONTROL: holding one registry (no destroy) -> tracker.size() === 1, weakAlive 1', async () => {
        const o = await run(true);
        assert.equal(o.size, 1);
        assert.equal(o.alive, 1);
        assert.ok(o.held);
    });
});
