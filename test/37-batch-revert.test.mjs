// test/37-batch-revert.test.mjs -- A3 (F5 / F12 / F16 R-b): batch revert vs bodies that ran in the batch.
//
// Oracle: SPEC-A3-plan.md ASSERTIONS 1, 3 (in-process GC part) and 5. Every expected value is
// derived from the plan's cases, not from running a kernel.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js with a sibling Watch.js), default ../Signal.js.
//
// RED-CHECK STATUS (b108, A3 FIX-R): cases (a)(b)(d)(e) are red on the 0628127b build (.handoff/b107-before) and green
// with the FIX-R bump; their todo is removed. (c) is a KNOWN row (maintainer Q3): an effect that writes s and then reads
// s in the SAME run is invisible to the per-node eval counter (the capture follows that run's bump), so the revert is
// suppressed -> [5]; the p2 ideal is [5,0]. (g') uses a direct reader of a (the old (g) fixture hid the blocked revert
// behind c's equality cutoff). Cases (f), GC budget and retention are regression pins (green on before; no todo).
// Existing pins that must stay green and are NOT copied here: test/19-v12-additions.test.mjs
// "pre-batch revert (v1.2.0)" (lines ~132-180) and test/17-reactivity.test.mjs line ~99.
// Run with --expose-gc for the GC and retention tests; without it they SKIP (never pass).
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getHeapSpaceStatistics } from 'node:v8';
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const { createRegistry } = await import(KPATH);
const HAVE_GC = typeof globalThis.gc === 'function';

test('kernel under test', (t) => {
    const sha = createHash('sha256').update(readFileSync(KPATH)).digest('hex');
    t.diagnostic('kernel ' + KPATH + ' sha256 ' + sha);
    assert.equal(typeof createRegistry, 'function');
});

// Fixture: a = signal(0), c = computed(a*10), effect seen = c().
function fixture() {
    const r = createRegistry();
    const a = r.signal(0);
    const c = r.computed(() => a() * 10);
    let seen = -1, runs = 0;
    const stop = r.effect(() => { runs++; seen = c(); });
    return { r, a, c, stop, get seen() { return seen; }, get runs() { return runs; } };
}

describe('A3 F5: revert must not outlive a body that ran in the batch', () => {
    it('(a) batch{a.set(1); c(); a.set(0)}: c() === 0 and seen === 0', () => {
        const f = fixture();
        let inside;
        f.r.batch(() => { f.a.set(1); inside = f.c(); f.a.set(0); });
        assert.equal(inside, 10, 'inside the batch c() sees a=1 -> 10');
        assert.equal(f.c(), 0, 'a is back to 0 -> 0*10');
        assert.equal(f.seen, 0, 'effect must observe the final state');
        f.stop();
    });

    it('(b) batch{a.set(1); effect(log a); a.set(0)}: log is [1, 0]', () => {
        const r = createRegistry();
        const a = r.signal(0);
        const log = [];
        let stop;
        r.batch(() => { a.set(1); stop = r.effect(() => { log.push(a()); }); a.set(0); });
        assert.deepEqual(log, [1, 0]);
        stop();
    });

    // KNOWN (maintainer Q3, LEDGER line pending): p2 ideal is [5, 0]; the R-node counter cannot see the in-body read of s
    // that follows the effect's own write (the capture happens after that run's bump), so the revert is suppressed.
    // Pinned as the full observed list (deepEqual); if this turns [5,0] the residual was fixed: re-rule the row.
    it('(c) KNOWN: effect writes then reads inside batch, then revert: log is [5] (ideal [5, 0])', () => {
        const r = createRegistry();
        const a = r.signal(0);
        const log = [];
        let w = 0, stop;
        r.batch(() => {
            stop = r.effect(() => { if (!w) { w = 1; a.set(5); } log.push(a()); });
            a.set(0);
        });
        assert.deepEqual(log, [5]);
        stop();
    });

    it('(d) nested computed read in an inner batch, outer revert: outer() === 1', () => {
        const r = createRegistry();
        const a = r.signal(0);
        const inner = r.computed(() => a());
        const outer = r.computed(() => inner() + 1);
        r.batch(() => { a.set(1); r.batch(() => outer()); a.set(0); });
        // a is 0 at the end -> inner 0 -> outer 1; the plan's expected value is outer() === 1.
        assert.equal(outer(), 1);
    });

    it('(e) onDisconnect writes b back inside a computed body: C() === 0 and b() === 0', () => {
        const r = createRegistry();
        const b = r.signal(0), x = r.signal(0);
        const C = r.computed(() => { const v = b(); if (v === 0) x(); return v; });
        const stop = r.effect(() => { C(); });             // keeps C (and its x link) live
        r.observeObservers(x, { onDisconnect: () => b.set(0) });
        r.batch(() => { b.set(1); C(); });
        assert.equal(C(), 0);
        assert.equal(b(), 0);
        stop();
    });

    it('(f) batch{a.set(1); a.set(0)} with no body in between: effect delta 0 (pin)', () => {
        const f = fixture();
        // The fixture effect reads a through c, whose equality cutoff hides a missing revert;
        // a direct reader of a gives the pin teeth (it re-runs iff the revert is lost).
        let direct = 0;
        const stopD = f.r.effect(() => { direct++; f.a(); });
        const before = f.runs, dBefore = direct;
        f.r.batch(() => { f.a.set(1); f.a.set(0); });
        assert.equal(f.runs - before, 0, 'plain revert still suppresses the effect');
        assert.equal(direct - dBefore, 0, 'and the direct reader of a');
        assert.equal(f.seen, 0);
        stopD();
        f.stop();
    });

    // DV-F5 coarseness: any body that ran in the batch disables later reverts, even an unrelated one (the p2 rule is
    // per node: a body that ran AFTER the node's capture blocks that node's revert). A DIRECT reader of a shows it: the
    // blocked revert re-runs it once (delta 1; before the fix the revert is silent: 0). The fixture effect reads a only
    // through c = a*10, whose equality cutoff hides the blocked revert (c recomputes 0 == 0): fixture delta 0.
    it("(g') DV-F5: batch{a.set(1); u(); a.set(0)} with u independent of a: direct reader delta 1, fixture delta 0", () => {
        const f = fixture();
        const z = f.r.signal(0);
        const u = f.r.computed(() => z() + 1);
        let direct = 0;
        const stopD = f.r.effect(() => { direct++; f.a(); });
        const before = f.runs, dBefore = direct;
        f.r.batch(() => { f.a.set(1); u(); f.a.set(0); });
        assert.equal(direct - dBefore, 1, 'direct reader re-runs once (blocked revert)');
        assert.equal(f.runs - before, 0, 'fixture effect hidden by c equality cutoff');
        assert.equal(f.seen, 0);
        stopD();
        f.stop();
    });
});

// ---- GC (assertion 3, in-process part) -----------------------------------
function newSpaceUsed() {
    const sp = getHeapSpaceStatistics();
    for (let i = 0; i < sp.length; i++) if (sp[i].space_name === 'new_space') return sp[i].space_used_size;
    return -1;
}

describe('A3 GC: batch{set; read; revert}', () => {
    it('2e5 runs <= 0.05 B/op (steady min), maxMajor 0 [budget pin]', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
        const r = createRegistry();
        const a = r.signal(0);
        const c = r.computed(() => a() * 10);
        let sink = 0;
        const stop = r.effect(() => { sink = (sink + c()) & 0x3FFFFFFF; });
        const body = () => { a.set(1); c(); a.set(0); };      // hoisted: no per-run closure
        const step = () => { r.batch(body); };
        const empty = () => { sink = (sink + 1) & 0x3FFFFFFF; };
        const BOX = ['tagged'];
        let k = 0;
        const boxStep = () => { BOX[0] = ++k + 0.5; };          // control: one HeapNumber per op, must read >= 8
        const K = 20000, W = 10;                                // 10 x 2e4 = 2e5 runs
        const lane = (fn) => {
            const per = [];
            for (let w = 0; w < W; w++) {
                const t0 = newSpaceUsed();
                for (let i = 0; i < K; i++) fn();
                const t1 = newSpaceUsed();
                per.push(t1 >= t0 ? (t1 - t0) / K : null);      // null: a scavenge hit the window
            }
            return per;
        };
        const minOver = (per, base) => {
            let m = null;
            for (let w = 1; w < per.length; w++) {              // window 0 may be unoptimized
                if (per[w] === null || base[w] === null) continue;
                const v = per[w] - base[w];
                if (m === null || v < m) m = v;
            }
            return m === null ? null : Math.max(0, m);
        };
        for (let i = 0; i < 50000; i++) { step(); empty(); boxStep(); }
        globalThis.gc();
        const gcp = new GcProfiler().start();
        const base = lane(empty);
        const per = lane(step);
        const ctl = lane(boxStep);
        const rep = checkNoGc(gcp.summary(), { maxMajor: 0 });
        gcp.stop();
        stop();
        const bop = minOver(per, base), cop = minOver(ctl, base);
        assert.notEqual(bop, null, 'unmeasured is not zero: every window hit a scavenge');
        assert.ok(cop !== null && cop >= 8, 'control must show a box (>= 8 B/op) or the lane is blind: ' + cop);
        assert.ok(bop <= 0.05, 'B/op ' + bop + ' > 0.05');
        assert.equal(gcp.summary().gc.major, 0, 'maxMajor 0');
        assert.ok(rep, 'checkNoGc report');
    });
});

// ---- Retention (assertion 5) ---------------------------------------------
// retentionCensus (b122 F7-B TASK 1): a REACHABILITY census, not a finalizer count. tracker.size() counts live
// FinalizationRegistry registrations and only drops when V8's cleanup task has run, so a per-cycle size() read races the
// event loop. Each cycle runs in a non-async cycle(i) (the async frame never holds obj_i) and returns a WeakRef; after one
// event-loop turn (ends the job, so KeepDuringJob releases the WeakRef targets) a synchronous gc() clears every dead
// target and a compacting deref() sweep counts the live obj_i exactly, independent of task order. Every obj_i the step
// drops is transient garbage the census must not count (the real rows passing are the transient negative control); the
// MUST-FAIL row retains (keep-all). After dispose: endLive from one more sweep, then tracker.size() must converge to it
// within a hard cap of 50 event-loop turns (bounded: a stuck registration ends with rounds === 50, never a hang).
// Returns { firstBad (first cycle with n > limit, else -1), firstBadN, worst, endLive, trackerEnd, rounds }.
async function retentionCensus(C, keep, step, limit, dispose) {
    const tracker = createLeakTracker({ name: 't37c', onLeak() {}, onWarning() {} });
    const refs = [];
    const turn = () => new Promise((res) => setImmediate(res));
    const sweep = () => {
        let w = 0;
        for (let k = 0; k < refs.length; k++) if (refs[k].deref() !== undefined) refs[w++] = refs[k];
        refs.length = w;
        return w;
    };
    const cycle = (i) => {
        const obj = { i };
        tracker.track(obj, null, i);
        if (keep) keep.push(obj);
        step(obj, i);
        return new WeakRef(obj);
    };
    let firstBad = -1, firstBadN = 0, worst = 0;
    for (let i = 0; i < C; i++) {
        refs.push(cycle(i));
        await turn();
        globalThis.gc();
        const n = sweep();
        if (n > worst) worst = n;
        if (firstBad === -1 && n > limit) { firstBad = i; firstBadN = n; }
    }
    dispose();
    await turn();
    globalThis.gc();
    const endLive = sweep();
    let rounds = 0;
    for (; rounds < 50 && tracker.size() !== endLive; rounds++) { await turn(); globalThis.gc(); }
    return { firstBad, firstBadN, worst, endLive, trackerEnd: tracker.size(), rounds };
}

// Fixture: s = signal(base), c = computed(s()); dispose drops both (c.value may hold the last intermediate until then).
// The batch bodies are hoisted and read obj_i from a slot cleared after the batch. Measured b122 (node v26.8.2): with a
// per-cycle closure capturing obj_i (the old row shape) the census saw a stray live obj_i near cycles 410/510 in all
// three rows, holder outside the engine path (the tracker removed: same); hoisted, 0 strays in 3/3 full-file runs.
// Suspected holder (not proven): a tier-up compile job specialized on that closure context.
function retentionFixture() {
    const r = createRegistry();
    const base = { base: true };
    const s = r.signal(base);
    const c = r.computed(() => s());
    const slot = [null];
    const bodyRead = () => { s.set(slot[0]); c(); s.set(base); };
    const bodyNoRead = () => { s.set(slot[0]); s.set(base); };
    return {
        r, base, s, c,
        batchRead: (obj) => { slot[0] = obj; r.batch(bodyRead); slot[0] = null; },
        batchNoRead: (obj) => { slot[0] = obj; r.batch(bodyNoRead); slot[0] = null; },
        dispose: () => { r.dispose(s); r.dispose(c); },
    };
}

describe('A3 retention: batch{s.set(obj_i); c(); s.set(base)} x 1000', () => {
    it('live obj_i <= 1 each cycle (WeakRef census after gc, exact); 0 after dispose; tracker.size() converges within 50 rounds', { skip: HAVE_GC ? false : 'needs --expose-gc' }, async (t) => {
        const f = retentionFixture();
        // the engine may still hold the latest recaptured intermediate: limit 1
        const step = f.batchRead;
        const res = await retentionCensus(1000, null, step, 1, f.dispose);
        t.diagnostic('census ' + JSON.stringify(res));
        assert.equal(res.firstBad, -1, 'cycle ' + res.firstBad + ': ' + res.firstBadN + ' live obj_i > 1');
        assert.ok(res.worst <= 1, 'worst ' + res.worst);
        assert.equal(res.endLive, 0, 'after dispose + gc no obj_i is reachable');
        assert.equal(res.trackerEnd, 0, 'tracker.size() did not converge to 0 within 50 rounds: ' + JSON.stringify(res));
    });

    // MUST-FAIL control (retained): the census must SEE retention. keep-all holds every obj_i, so cycle 1 is the first
    // with 2 live (> limit 1), all 8 survive dispose, and tracker.size() already equals endLive (0 rounds).
    it('MUST-FAIL: keep-all (C=8) -> firstBad 1 n 2, worst 8, endLive 8, trackerEnd 8, rounds 0', { skip: HAVE_GC ? false : 'needs --expose-gc' }, async (t) => {
        const f = retentionFixture();
        const keep = [];
        const step = f.batchRead;
        const res = await retentionCensus(8, keep, step, 1, f.dispose);
        t.diagnostic('census ' + JSON.stringify(res));
        assert.deepEqual(res, { firstBad: 1, firstBadN: 2, worst: 8, endLive: 8, trackerEnd: 8, rounds: 0 });
        assert.equal(keep.length, 8);
    });

    // Variant (spec shape; c() read inside the batch). Before FIX-R c() stayed obj via F5 (holder: c.value).
    // Variant: a top-level c() read after each batch re-evaluates c to base and drops obj_i,
    // so NOTHING may still hold obj_i (not c, not s's batch capture). Strict === 0 every cycle.
    it('variant: after a top-level c() read, live obj_i === 0 at the end of EVERY cycle (WeakRef census); tracker.size() converges to 0', { skip: HAVE_GC ? false : 'needs --expose-gc' }, async (t) => {
        const f = retentionFixture();
        const step = (obj, i) => {
            f.batchRead(obj);
            if (f.c() !== f.base) throw new Error('c() must be base after the batch (cycle ' + i + ')');
        };
        const res = await retentionCensus(1000, null, step, 0, f.dispose);
        t.diagnostic('census ' + JSON.stringify(res));
        assert.equal(res.worst, 0, 'cycle ' + res.firstBad + ': obj_i is still retained (' + res.firstBadN + ' live)');
        assert.equal(res.endLive, 0);
        assert.equal(res.trackerEnd, 0, 'tracker.size() did not converge to 0 within 50 rounds: ' + JSON.stringify(res));
    });

    // Same without the in-batch c() read (no F5 trigger): isolates s's batch capture. Plain pin;
    // red on a mutant that captures the intermediate instead of the pre-batch value.
    it('variant-nobody: after a top-level c() read, live obj_i === 0 at the end of EVERY cycle (WeakRef census); tracker.size() converges to 0', { skip: HAVE_GC ? false : 'needs --expose-gc' }, async (t) => {
        const f = retentionFixture();
        const step = (obj, i) => {
            f.batchNoRead(obj);
            if (f.c() !== f.base) throw new Error('c() must be base after the batch (cycle ' + i + ')');
        };
        const res = await retentionCensus(1000, null, step, 0, f.dispose);
        t.diagnostic('census ' + JSON.stringify(res));
        assert.equal(res.worst, 0, 'cycle ' + res.firstBad + ': obj_i is still retained (' + res.firstBadN + ' live)');
        assert.equal(res.endLive, 0);
        assert.equal(res.trackerEnd, 0, 'tracker.size() did not converge to 0 within 50 rounds: ' + JSON.stringify(res));
    });
});
