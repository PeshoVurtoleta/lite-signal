// 79-l44-read-reuse.test.mjs -- LEDGER #44 (burst 104, unit H1): a tracked read whose dependency link is new runs
// allocateLink, which can run user code (observeObservers onConnect, onGraphMutation op 3, onDisconnect fired by
// severing a stale tail link). If that hook disposes the node being read and re-seats its slot, the read must
// return undefined (never the new resident's value, never run the new resident's body).
// INDEPENDENT ORACLE from the planner ASSERTIONS A1 / A2 / A4 / A5; no value is copied from a kernel run.
// Slot reuse is PROVEN, not assumed: each row runs in a registry whose maxNodes equals the live node count at the
// moment of the hook, so the re-seated node can only land in the one freed slot (otherwise CapacityError, and the
// row fails because the hook did not complete).
// RED-CHECK: A1 / A2 computed rows red on the pre-fix build (sha 928f0e64); A2 signal rows are REGRESSION pins
// (green pre-fix), A1's same-kind row is their must-fail control. A4 / A5 green pre-fix.
// Kernel: LITE_SIGNAL_KERNEL (absolute path), default ../Signal.js. GC rows need --expose-gc (else SKIP).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GcProfiler, measureAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const { createRegistry } = await import(KPATH);
const HAVE_GC = typeof globalThis.gc === 'function';
const KINDS = ['signal', 'computed', 'signalBox', 'computedBox'];
const TRIGGERS = ['onConnect', 'op3', 'sever'];

// Per-kind factory. mk(r, label, counter) -> handle; rd(h) -> tracked read; counter.n counts body runs (computeds).
function mk(r, kind, val, counter) {
    switch (kind) {
        case 'signal': return r.signal(val);
        case 'computed': return r.computed(() => { counter.n++; return val; });
        case 'signalBox': return r.signalBox(val);
        default: return r.computedBox(() => { counter.n++; return val; });
    }
}
function rd(kind, h) { return (kind === 'signalBox' || kind === 'computedBox') ? h.get() : h(); }

// One scenario. cap: maxNodes (null = generous). reseat: true -> create D after dispose(S).
// Returns the evidence record. The effect runs once (onConnect / op3) or twice (sever, driven by signal t).
function scenario(kind, trigger, cap, reseat) {
    const r = createRegistry({ maxNodes: cap === null ? 64 : cap });
    const ctr = { n: 0 }, dctr = { n: 0 };
    const ev = { reads: [], hookFired: false, hookInRead: false, hookDone: false, hookErr: null, nodesAtHook: -1,
                 dRunsInRead: -1, D: null, r, kind, effRuns: 0, S: null };
    const S = ev.S = mk(r, kind, 'S-value', ctr);
    let inRead = false, armed = (trigger !== 'sever');
    const kill = () => {
        if (!armed) return; armed = false;
        ev.hookFired = true; ev.hookInRead = inRead; ev.nodesAtHook = r.stats().activeNodes;
        try {
            r.dispose(S);
            if (reseat) { ev.D = mk(r, kind, 'D-value', dctr); }
            ev.hookDone = true;
        } catch (e) { ev.hookErr = e; }
    };
    const t = r.signal(0);
    let A = null;
    if (trigger === 'onConnect') r.observeObservers(S, { onConnect: kill });
    else if (trigger === 'op3') r.onGraphMutation((op) => { if (op === 3 && inRead) kill(); });
    else { A = r.signal(0); r.observeObservers(A, { onDisconnect: kill }); }
    const stop = r.effect(() => {
        ev.effRuns++;
        const run2 = trigger === 'sever' && t() === 1;
        if (trigger === 'sever' && !run2) { A(); return; }   // run 1 reads A only
        if (trigger === 'sever') armed = true;               // run 2 reads S first: A's link is the stale tail
        else t();
        inRead = true;
        let v;
        try { v = rd(kind, S); } catch (e) { v = 'THREW ' + String(e); }
        inRead = false;
        ev.dRunsInRead = dctr.n;
        ev.reads.push(v);
    });
    if (trigger === 'sever') t.set(1);
    ev.t = t; ev.stop = stop; ev.dctr = dctr; ev.ctr = ctr;
    return ev;
}

// Tight-cap run: probe with the generous cap to learn the live node count at hook time, then rerun with it.
function tight(kind, trigger, reseat) {
    const probe = scenario(kind, trigger, null, reseat);
    assert.ok(probe.hookFired, kind + '/' + trigger + ': probe hook fired (sever arm reachable)');
    return scenario(kind, trigger, probe.nodesAtHook, reseat);
}

describe('A1 dispose + reseat inside the read -> undefined, new resident untouched', () => {
    for (const kind of KINDS) for (const trigger of TRIGGERS) {
        it('A1 ' + kind + ' x ' + trigger, () => {
            const ev = tight(kind, trigger, true);
            assert.equal(ev.hookFired, true, 'hook fired');
            assert.equal(ev.hookInRead, true, 'hook fired INSIDE the read');
            assert.equal(ev.hookErr, null, 'hook completed without error (reseat landed in the freed slot): ' + ev.hookErr);
            assert.equal(ev.hookDone, true, 'hook done');
            assert.equal(ev.reads.length, 1, 'effect read once');
            assert.equal(ev.reads[0], undefined, 'read returns undefined');
            if (kind.startsWith('computed')) assert.equal(ev.dRunsInRead, 0, 'D body ran 0 times inside the read');
            // afterwards D works and a change to D does not re-run the effect
            assert.equal(rd(kind, ev.D), 'D-value', 'D readable after');
            const runsBefore = ev.effRuns;
            if (kind === 'signal' || kind === 'signalBox') {
                if (kind === 'signal') ev.D.set('D2'); else ev.D.set('D2');
                assert.equal(rd(kind, ev.D), 'D2', 'D change visible');
            }
            assert.equal(ev.effRuns, runsBefore, 'D change did not re-run the effect');
            ev.stop();
        });
    }
});

describe('A2 dispose only (no reseat): undefined, no throw', () => {
    for (const kind of KINDS) {
        const name = (kind === 'signal' || kind === 'signalBox')
            ? 'A2 REGRESSION: ' + kind + ' dispose-only (must-fail control = A1 same-kind rows)'
            : 'A2 ' + kind + ' dispose-only';
        it(name, () => {
            const ev = scenario(kind, 'onConnect', null, false);
            assert.equal(ev.hookFired, true, 'hook fired');
            assert.equal(ev.hookInRead, true, 'hook fired INSIDE the read');
            assert.equal(ev.hookErr, null, 'hook error ' + ev.hookErr);
            assert.equal(ev.reads.length, 1);
            assert.equal(ev.reads[0], undefined, 'no throw, no cached TypeError: ' + ev.reads[0]);
            // a later read of the dead handle is also undefined (no cached TypeError)
            assert.equal(rd(kind, ev.S), undefined, 'dead handle read');
            ev.stop();
        });
    }
});

describe('A4 GC: tracked reads are zero-alloc', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    // reuse arm: an effect re-runs reading an existing dep (link reused). link arm: dep set flips each run so the
    // read allocates a fresh link (the other dep is dropped by the tail sever). One step = one effect re-run = 1 read.
    function reuseStep(kind) {
        const r = createRegistry();
        const ctr = { n: 0 };
        const S = mk(r, kind, 1, ctr), t = r.signal(0);
        let sink = 0, runs = 0;
        r.effect(() => { runs++; t(); const v = rd(kind, S); sink = (sink + (v | 0)) | 0; });
        let k = 0;
        const step = () => { t.set(++k); };
        step.runs = () => runs; step.sink = () => sink;
        return step;
    }
    function linkStep(kind) {
        const r = createRegistry();
        const ctr = { n: 0 };
        const X = mk(r, kind, 1, ctr), Y = mk(r, kind, 2, ctr), t = r.signal(0);
        let sink = 0, runs = 0;
        r.effect(() => { runs++; const v = (t() & 1) === 0 ? rd(kind, X) : rd(kind, Y); sink = (sink + (v | 0)) | 0; });
        let k = 0;
        const step = () => { t.set(++k); };
        step.runs = () => runs; step.sink = () => sink;
        return step;
    }
    async function check(step, iters, batches = 4) {
        // Tiering / feedback / code-object survivors are one-time (~10 KB, seen as 0.098 B/op over 1e5): finish them
        // BEFORE the measured window -- long warm-up on the same step, a forced gc, then a second warm-up round.
        for (let i = 0; i < 300000; i++) step();
        globalThis.gc();
        await new Promise((res) => setTimeout(res, 20));
        for (let i = 0; i < 100000; i++) step();
        globalThis.gc();
        const m = measureAllocs(step, { iterations: iters, batches, warmup: 20000 });
        assert.notEqual(m.bytesPerCall, null, 'unmeasured is not zero');
        globalThis.gc();
        await new Promise((res) => setTimeout(res, 50));
        const gcp = new GcProfiler().start();
        const h0 = process.memoryUsage().heapUsed;
        for (let i = 0; i < 1000000; i++) step();
        await new Promise((res) => setTimeout(res, 50));
        const sum = gcp.summary(); gcp.stop();
        globalThis.gc(); const grewBpo = (process.memoryUsage().heapUsed - h0) / 1000000;
        assert.equal(sum.gc.minor, 0, 'scavenge in 1e6 reads: transient per-read alloc');
        assert.ok(grewBpo < 0.5, 'whole-window retained B/op ' + grewBpo);
        assert.ok(step.runs() > iters * 4, 'effect really re-ran per step: ' + step.runs());
        assert.ok(step.sink() !== 0, 'reads returned numbers');
        // Per-batch heap deltas carry a few KB of harness/JIT noise in random batches (seen 4-58 KB per 1e5 reads, not per
        // read). Per-read allocation would show in EVERY batch, so the link arm uses the MIN of 12 measured batches
        // (a control lane with NO tracked read shows the same 4-53 KB noise, probed).
        let minB = Infinity;
        for (const b of m.batchBytes) if (b !== null && b < minB) minB = b;
        assert.ok(minB !== Infinity, 'at least one measured batch');
        return { minBpo: minB / iters, bpo: m.bytesPerCall, major: sum.gc.major, minor: sum.gc.minor, grewBpo };
    }
    for (const kind of KINDS) {
        it('A4 ' + kind + ' reuse arm 1e6 reads: B/op <= 0.01, maxMajor 0', async () => {
            const res = await check(reuseStep(kind), 1000000);
            console.log('A4 reuse ' + kind + ' B/op ' + res.bpo + ' major ' + res.major + ' minor ' + res.minor + ' grewBpo ' + res.grewBpo);
            assert.ok(res.bpo <= 0.01, 'B/op ' + res.bpo);
            assert.equal(res.major, 0, 'maxMajor 0');
        });
        it('A4 ' + kind + ' allocateLink arm 1e5 reads: B/op <= 0.01, maxMajor 0', async () => {
            const res = await check(linkStep(kind), 100000, 12);
            console.log('A4 link  ' + kind + ' minBatch B/op ' + res.minBpo + ' (median ' + res.bpo + ') major ' + res.major);
            assert.ok(res.minBpo <= 0.01, 'min-batch B/op ' + res.minBpo);
            assert.equal(res.major, 0, 'maxMajor 0');
        });
    }
    it('A4 CONTROL (transient): per-read throwaway object under 1e6 steps -> scavenges (minor > 0)', async () => {
        const r = createRegistry();
        const S2 = r.signal(1), t2 = r.signal(0);
        let tsink = null;
        r.effect(() => { t2(); tsink = { v: S2() + 0.5 }; });
        let k = 0;
        for (let i = 0; i < 50000; i++) t2.set(++k);
        globalThis.gc();
        await new Promise((res) => setTimeout(res, 50));
        const gcp = new GcProfiler().start();
        for (let i = 0; i < 1000000; i++) t2.set(++k);
        await new Promise((res) => setTimeout(res, 50));
        const sum = gcp.summary(); gcp.stop();
        assert.ok(tsink !== null);
        assert.ok(sum.gc.minor > 0, 'transient control must scavenge: minor ' + sum.gc.minor);
    });
    it('A4 CONTROL: an allocating-per-read lane measures > 1 B/op', () => {
        const r = createRegistry();
        const S = r.signal(1), t = r.signal(0);
        let sink = null;
        const keep = [];   // measureAllocs counts what survives its forced gc, so the control retains each object
        let runs = 0;
        r.effect(() => { t(); keep.push({ v: S() + 0.5, w: [1] }); sink = keep; runs++; });   // fresh retained object per read
        let k = 0;
        const step = () => { t.set(++k); };
        for (let i = 0; i < 20000; i++) step();
        globalThis.gc();
        const m = measureAllocs(step, { iterations: 100000, batches: 4, warmup: 5000 });
        assert.notEqual(m.bytesPerCall, null);
        assert.ok(runs > 100000, 'control effect really re-ran: ' + runs);
        assert.ok(m.bytesPerCall > 1, 'control B/op ' + m.bytesPerCall);
        assert.ok(sink !== null);
    });
});

describe('A5 retention: 1000 x {create, hook reseat, effect read, dispose all}', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    const settle = async () => { globalThis.gc(); await new Promise((res) => setTimeout(res, 0)); globalThis.gc(); };
    async function run(kind, skipDisposeD) {
        const r = createRegistry({ maxNodes: skipDisposeD ? 2048 : 16 });
        const base = r.stats();
        const tracker = createLeakTracker({ name: 't79', onLeak() {}, onWarning() {} });
        let reseats = 0;
        for (let i = 0; i < 1000; i++) {
            const obj = { i };
            tracker.track(obj, null, i);
            const ctr = { n: 0 };
            const S = mk(r, kind, obj, ctr);
            let D = null, armed = true;
            const off = r.observeObservers(S, { onConnect: () => {
                if (!armed) return; armed = false;
                r.dispose(S); D = mk(r, kind, obj, ctr); reseats++;
            } });
            const stop = r.effect(() => { rd(kind, S); });
            stop();
            if (typeof off === 'function') off();
            if (!skipDisposeD) r.dispose(D);
            // `obj` is held only by D's closure/value; the control keeps D (and its slot) alive
            if (skipDisposeD) { if (i === 0) globalThis.__l44keep = []; }
            if (skipDisposeD) { globalThis.__l44keep.push(D); }
        }
        // FinalizationRegistry callbacks arrive late: settle until the tracker drains (bounded), not a fixed count.
        for (let i = 0; i < 30 && tracker.size() > 0 && !skipDisposeD; i++) await settle(), await new Promise((res) => setTimeout(res, 10));
        await settle(); await settle();
        const out = { size: tracker.size(), st: r.stats(), base, reseats };
        return out;
    }
    for (const kind of KINDS) {
        it('A5 ' + kind + ': tracker.size() 0, activeLinks / nodes back to baseline', async () => {
            const o = await run(kind, false);
            assert.equal(o.reseats, 1000, 'every iteration reseated');
            assert.equal(o.size, 0, 'tracker size');
            assert.equal(o.st.activeLinks, o.base.activeLinks, 'activeLinks baseline');
            assert.equal(o.st.activeNodes, o.base.activeNodes, 'activeNodes baseline');
        });
    }
    it('A5 CONTROL: skipping dispose(D) (D kept alive) -> tracker.size() 1000', async () => {
        globalThis.__l44keep = [];
        const o = await run('signal', true);
        globalThis.__l44keep = null;
        assert.equal(o.size, 1000);
    });
});
