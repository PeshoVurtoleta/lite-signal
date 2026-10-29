// 91-l51-stale-update.test.mjs -- LEDGER #51 (burst 136, unit B1): sharedUpdate (signal s.update(fn); the resident may be a
// computed) had no gen guard, so a STALE handle (slot disposed, possibly re-seated) called fn with the slot's CURRENT resident value (or
// undefined for a dead slot / effect resident) and only THEN had the write dropped by set's gen guard.
// Ruling D-b135-1 (binding): a STALE handle's update(fn) returns undefined WITHOUT calling fn (like peek and boxUpdate).
// INDEPENDENT ORACLE from PLAN-L51-b136 A1 / A3 / A4 + D-b135-1; no value is copied from a kernel run.
// Slot reuse is PROVEN, not assumed: each scene runs in a registry whose maxNodes equals the live node count, so a
// re-seated node can only land in the one freed slot (asserted: activeNodes === cap and one more create throws CapacityError).
// RED-CHECK: R1-R6 and C6 are RED on the pre-fix build (HEAD aa154b6, Signal.js sha256/8 ec6d7156) and GREEN after the
// one-line guard. C1-C5, A3 and A4 rows are GREEN on both builds (C4 and C2/C3/C5 are regression pins; the A3 transient control
// and the A4 keep-alive control are the must-fail rows of their families).
// Kernel: LITE_SIGNAL_KERNEL (absolute path), default ../Signal.js. GC rows need --expose-gc (else SKIP).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const K = await import(KPATH);
const { createRegistry } = K;
const HAVE_GC = typeof globalThis.gc === 'function';
const CAP = 8;

const isCap = (e) => e instanceof Error && e.name === 'CapacityError';

// Build a tight scene on `api` (needs signal / computed / effect / dispose / stats). first() makes the handle that will
// go stale; each later maker re-seats the freed slot. Only signals / computeds are disposed (the last resident may be an
// effect). Returns { handles, fillers, effRuns } with an observer effect on the final resident when it is readable.
function scene(api, makers, observe) {
    const handles = [makers[0]()];
    const fillers = [];
    while (api.stats().activeNodes < CAP) fillers.push(api.signal(100 + fillers.length));
    assert.equal(api.stats().activeNodes, CAP, 'registry full');
    for (let i = 1; i < makers.length; i++) {
        api.dispose(handles[i - 1]);
        assert.equal(api.stats().activeNodes, CAP - 1, 'one slot freed');
        handles.push(makers[i]());
        assert.equal(api.stats().activeNodes, CAP, 'resident landed in the freed slot');
        assert.throws(() => api.signal(0), isCap, 'registry still full: the only free slot was the one re-seated');
    }
    const eff = { runs: 0 };
    const last = handles[handles.length - 1];
    if (observe) {
        api.dispose(fillers[0]);   // make room for the observer effect (its slot is NOT the re-seated one)
        api.effect(() => { eff.runs++; last(); });
        assert.equal(eff.runs, 1, 'observer ran once');
    }
    return { handles, fillers, eff };
}

// Stale call matrix for one scene: every handle except the last is stale.
function assertStale(sc, readResident, expectResident) {
    const hs = sc.handles;
    let calls = 0;
    for (let i = 0; i < hs.length - 1; i++) {
        const ret = hs[i].update(function (v) { calls++; return 999; });
        assert.equal(ret, undefined, 'stale update returns undefined');
    }
    assert.equal(calls, 0, 'fn must not be called for a stale handle (called ' + calls + 'x)');
    if (readResident) assert.equal(readResident(), expectResident, 'resident value unchanged');
    assert.equal(sc.eff.runs, 1, 'resident-dependent effect did not re-run');
}

describe('R: stale handle update(fn) never calls fn (D-b135-1)', () => {
    it('R1 recycled SIGNAL resident (5): fn 1 -> 0', () => {
        const r = createRegistry({ maxNodes: CAP });
        const sc = scene(r, [() => r.signal(1), () => r.signal(5)], true);
        assertStale(sc, () => sc.handles[1].peek(), 5);
    });
    it('R2 recycled COMPUTED resident (5): fn 1 -> 0', () => {
        const r = createRegistry({ maxNodes: CAP });
        const sc = scene(r, [() => r.signal(1), () => r.computed(() => 5)], true);
        assertStale(sc, () => sc.handles[1].peek(), 5);
    });
    it('R3 dead slot (disposed, not reused): fn 1 (undefined) -> 0', () => {
        const r = createRegistry({ maxNodes: CAP });
        const S = r.signal(1);
        const other = r.signal(2);
        let runs = 0;
        r.effect(() => { runs++; other(); });
        r.dispose(S);
        let calls = 0;
        const ret = S.update(function (v) { calls++; return 7; });
        assert.equal(ret, undefined);
        assert.equal(calls, 0, 'fn called ' + calls + 'x for a dead handle');
        assert.equal(S.peek(), undefined);
        assert.equal(runs, 1);
    });
    it('R4 EFFECT resident in the slot: fn 1 (undefined) -> 0', () => {
        const r = createRegistry({ maxNodes: CAP });
        const S = r.signal(1);
        const fillers = [];
        while (r.stats().activeNodes < CAP) fillers.push(r.signal(100 + fillers.length));
        r.dispose(S);
        let bodyRuns = 0;
        const stop = r.effect(() => { bodyRuns++; fillers[0](); });
        assert.equal(r.stats().activeNodes, CAP, 'effect landed in the freed slot');
        assert.throws(() => r.signal(0), isCap, 'registry full: only the freed slot was available');
        let calls = 0;
        const ret = S.update(function (v) { calls++; return 7; });
        assert.equal(ret, undefined);
        assert.equal(calls, 0, 'fn called ' + calls + 'x with the effect resident');
        assert.equal(bodyRuns, 1, 'resident effect did not re-run');
        stop();
    });
    it('R5 two stale handles on a twice-recycled slot: 2 calls -> 0', () => {
        const r = createRegistry({ maxNodes: CAP });
        const sc = scene(r, [() => r.signal(1), () => r.signal(2), () => r.signal(5)], true);
        assert.equal(sc.handles.length, 3);
        assertStale(sc, () => sc.handles[2].peek(), 5);
    });
    it('R6 stale update(5) (non-function): no throw, returns undefined', () => {
        const r = createRegistry({ maxNodes: CAP });
        const sc = scene(r, [() => r.signal(1), () => r.signal(5)], true);
        let ret = 'unset';
        assert.doesNotThrow(() => { ret = sc.handles[0].update(5); });
        assert.equal(ret, undefined);
        assert.equal(sc.handles[1].peek(), 5);
        assert.equal(sc.eff.runs, 1);
    });
});

describe('C: controls (C1-C5 green on both builds; C6 red-first like R1)', () => {
    it('C1 live update(fn): fn called once with the current value, result set, this === undefined', () => {
        const r = createRegistry();
        const s = r.signal(10);
        const seen = [];
        let thisVal = 'unset';
        s.update(function (v) { seen.push(v); thisVal = this; return v + 5; });
        assert.deepEqual(seen, [10]);
        assert.equal(thisVal, undefined);
        assert.equal(s.peek(), 15);
        const c = r.computed(() => 1);   // computed handles have no set; live signal path only
        assert.equal(typeof c, 'function');
    });
    it('C2 live update(5) throws TypeError', () => {
        const s = createRegistry().signal(1);
        assert.throws(() => s.update(5), (e) => e instanceof TypeError);
    });
    it('C3 fn disposes its own signal: set dropped, no throw', () => {
        const r = createRegistry();
        const s = r.signal(1);
        let calls = 0;
        assert.doesNotThrow(() => s.update(function (v) { calls++; r.dispose(s); return v + 1; }));
        assert.equal(calls, 1);
        assert.equal(s.peek(), undefined, 'disposed, write dropped');
    });
    it('C4 stale signalBox update: fn not called, returns undefined (already guarded)', () => {
        const r = createRegistry({ maxNodes: CAP });
        const sc = scene(r, [() => r.signalBox(1), () => r.signalBox(5)], false);
        let calls = 0;
        const ret = sc.handles[0].update(function () { calls++; return 9; });
        assert.equal(ret, undefined);
        assert.equal(calls, 0);
        assert.equal(sc.handles[1].peek(), 5);
    });
    it('C5 detached update throws TypeError (class only)', () => {
        const s = createRegistry().signal(1);
        const { update } = s;
        assert.throws(() => update((v) => v), (e) => e instanceof TypeError);
    });
    it('C6 module-level signal via the default registry: stale update is red-first like R1', () => {
        assert.equal(typeof K.setDefaultRegistry, 'function');
        assert.equal(typeof K.signal, 'function');
        K.setDefaultRegistry(createRegistry({ maxNodes: CAP }));
        try {
            const api = { signal: K.signal, effect: K.effect, dispose: K.dispose, stats: K.stats };
            const sc = scene(api, [() => K.signal(1), () => K.signal(5)], true);
            assertStale(sc, () => sc.handles[1].peek(), 5);
        } finally { K.setDefaultRegistry(createRegistry()); }
    });
});

describe('A3 GC: live + stale update are zero-alloc', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    async function window(step, iters) {
        // one-time tiering / feedback survivors are finished BEFORE the measured window
        for (let i = 0; i < 300000; i++) step();
        globalThis.gc(); await sleep(20);
        for (let i = 0; i < 100000; i++) step();
        globalThis.gc(); await sleep(50);
        const gcp = new GcProfiler().start();
        const h0 = process.memoryUsage().heapUsed;
        for (let i = 0; i < iters; i++) step();
        await sleep(50);
        const sum = gcp.summary(); gcp.stop();
        globalThis.gc();
        return { minor: sum.gc.minor, major: sum.gc.major, grewBpo: (process.memoryUsage().heapUsed - h0) / iters };
    }
    function liveStale(liveFn, staleFn) {
        const r = createRegistry({ maxNodes: CAP });
        const sc = scene(r, [() => r.signal(1), () => r.signal(5)], false);
        const live = sc.handles[1], stale = sc.handles[0];
        let sink = 0;
        return () => { live.update(liveFn); const x = stale.update(staleFn); sink = (sink + (x === undefined ? 1 : 2)) | 0; return sink; };
    }
    it('A3 1e6 live s.update(v => (v+1)&1023) + 1e6 stale updates: minor 0, major 0, retained < 0.5 B/op', async () => {
        const step = liveStale((v) => (v + 1) & 1023, (v) => v);
        const m = await window(step, 1000000);
        console.log('A3 minor ' + m.minor + ' major ' + m.major + ' grewBpo ' + m.grewBpo);
        assert.equal(m.minor, 0, 'scavenge: transient per-update alloc');
        assert.equal(m.major, 0);
        assert.ok(m.grewBpo < 0.5, 'whole-window retained B/op ' + m.grewBpo);
    });
    let lastBox = null;   // sink: each [v] dies on the next op (v => [v] nests a RETAINED chain -> pretenured -> minor 0)
    it('A3 CONTROL (transient): fn stores [v] in a sink under 1e6 live updates -> minor >= 1, retained < 0.5 B/op', async () => {
        const step = liveStale((v) => { lastBox = [v]; return (v + 1) & 1023; }, (v) => v);
        const m = await window(step, 1000000);
        assert.ok(m.minor >= 1, 'transient control must scavenge: minor ' + m.minor);
        assert.ok(m.grewBpo < 0.5, 'control must be transient, not retained: ' + m.grewBpo);
    });
});

describe('A4 retention: 1000 x {create, dispose, recycle, stale update}', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    const settle = async () => { globalThis.gc(); await new Promise((res) => setTimeout(res, 0)); globalThis.gc(); };
    async function run(keepResident) {
        const r = createRegistry({ maxNodes: keepResident ? 2048 : 1 });
        const base = r.stats();
        const tracker = createLeakTracker({ name: 't91', onLeak() {}, onWarning() {} });
        const keep = [];
        // cycles run in a sync helper so no loop-local `obj` stays live in this async frame across the awaits
        const cycles = () => {
            for (let i = 0; i < 1000; i++) {
                const obj = { i };
                tracker.track(obj, null, i);
                const S = r.signal(obj);
                r.dispose(S);
                const D = r.signal(obj);   // recycles S's slot (cap 1: only the freed slot exists, else CapacityError)
                S.update(function (v) { return v; });   // stale update (obj reachable only via the nodes)
                if (keepResident) keep.push(D); else r.dispose(D);
            }
        };
        cycles();
        for (let i = 0; i < 30 && tracker.size() > 0 && !keepResident; i++) { await settle(); await new Promise((res) => setTimeout(res, 10)); }
        await settle(); await settle();
        const out = { size: tracker.size(), st: r.stats(), base, keep };
        return out;
    }
    it('A4 tracker.size() 0, activeNodes / activeLinks back to baseline', async () => {
        const o = await run(false);
        assert.equal(o.size, 0, 'tracker size');
        assert.equal(o.st.activeNodes - o.base.activeNodes, 0, 'activeNodes delta');
        assert.equal(o.st.activeLinks, o.base.activeLinks, 'activeLinks');
    });
    it('A4 CONTROL: keeping every resident alive -> tracker.size() 1000', async () => {
        const o = await run(true);
        assert.equal(o.size, 1000);
        assert.ok(o.keep.length === 1000);
    });
});
