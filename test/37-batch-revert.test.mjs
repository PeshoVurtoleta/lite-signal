// test/37-batch-revert.test.mjs -- A3 (F5 / F12 / F16 R-b): batch revert vs bodies that ran in the batch.
//
// Oracle: SPEC-A3-plan.md ASSERTIONS 1, 3 (in-process GC part) and 5. Every expected value is
// derived from the plan's cases, not from running a kernel.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js with a sibling Watch.js), default ../Signal.js.
//
// RED-CHECK STATUS: cases (a)-(e) and (g) were proven red on kernels/a1cand (still has F5); output in
// audit/2026-10-07/verification/golden-A3/red-37.a1cand.txt. The red-check MUST be repeated on
// golden-A3/before/Signal.js at A3 task 0 (and the todo removed by task 7). Until A3 lands
// those cases carry { todo: 'A3' } so npm test stays green.
// Cases (f), GC budget and retention are regression pins (green on before; no todo).
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
const TODO = { todo: 'A3' };

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
    it('(a) batch{a.set(1); c(); a.set(0)}: c() === 0 and seen === 0', TODO, () => {
        const f = fixture();
        let inside;
        f.r.batch(() => { f.a.set(1); inside = f.c(); f.a.set(0); });
        assert.equal(inside, 10, 'inside the batch c() sees a=1 -> 10');
        assert.equal(f.c(), 0, 'a is back to 0 -> 0*10');
        assert.equal(f.seen, 0, 'effect must observe the final state');
        f.stop();
    });

    it('(b) batch{a.set(1); effect(log a); a.set(0)}: log is [1, 0]', TODO, () => {
        const r = createRegistry();
        const a = r.signal(0);
        const log = [];
        let stop;
        r.batch(() => { a.set(1); stop = r.effect(() => { log.push(a()); }); a.set(0); });
        assert.deepEqual(log, [1, 0]);
        stop();
    });

    it('(c) effect writes then reads inside batch, then revert: log is [5, 0]', TODO, () => {
        const r = createRegistry();
        const a = r.signal(0);
        const log = [];
        let w = 0, stop;
        r.batch(() => {
            stop = r.effect(() => { if (!w) { w = 1; a.set(5); } log.push(a()); });
            a.set(0);
        });
        assert.deepEqual(log, [5, 0]);
        stop();
    });

    it('(d) nested computed read in an inner batch, outer revert: outer() === 1', TODO, () => {
        const r = createRegistry();
        const a = r.signal(0);
        const inner = r.computed(() => a());
        const outer = r.computed(() => inner() + 1);
        r.batch(() => { a.set(1); r.batch(() => outer()); a.set(0); });
        // a is 0 at the end -> inner 0 -> outer 1; the plan's expected value is outer() === 1.
        assert.equal(outer(), 1);
    });

    it('(e) onDisconnect writes b back inside a computed body: C() === 0 and b() === 0', TODO, () => {
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

    // DV-F5 coarseness: any body that ran in the batch disables later reverts, even an
    // unrelated one. Plan says delta 1; the before kernel reads 0 so this is red there.
    it('(g) DV-F5: batch{a.set(1); u(); a.set(0)} with u independent of a: effect delta 1', TODO, () => {
        const f = fixture();
        const z = f.r.signal(0);
        const u = f.r.computed(() => z() + 1);
        const before = f.runs;
        f.r.batch(() => { f.a.set(1); u(); f.a.set(0); });
        assert.equal(f.runs - before, 1);
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
describe('A3 retention: batch{s.set(obj_i); c(); s.set(base)} x 1000', () => {
    it('tracker.size() <= 1 each cycle; === 0 after dispose + gc', { skip: HAVE_GC ? false : 'needs --expose-gc' }, async () => {
        const r = createRegistry();
        const base = { base: true };
        const s = r.signal(base);
        const c = r.computed(() => s());
        const tracker = createLeakTracker({ name: 't37', onLeak() {}, onWarning() {} });
        let worst = 0;
        const cycle = (i) => {
            const obj = { i };
            tracker.track(obj, null, i);
            r.batch(() => { s.set(obj); c(); s.set(base); });
        };
        const settle = async () => { globalThis.gc(); await new Promise((res) => setTimeout(res, 0)); globalThis.gc(); };
        for (let i = 0; i < 1000; i++) {
            cycle(i);       // obj lives only inside cycle(): the async frame must not pin it
            // obj is now unreachable from the caller; only the engine may still hold it
            // (the latest recaptured intermediate).
            await settle();
            const n = tracker.size();
            if (n > worst) worst = n;
            assert.ok(n <= 1, 'cycle ' + i + ': tracker.size() = ' + n + ' > 1');
        }
        r.dispose(s);
        r.dispose(c);   // c.value may legitimately hold the last intermediate until read/disposed
        await settle();
        await settle();
        assert.equal(tracker.size(), 0, 'after dispose + gc nothing is retained');
        assert.ok(worst <= 1);
    });

    // Variant (spec shape; c() read inside the batch). On a1cand c() stays obj via F5, so the
    // holder is c.value; the A3 fix releases it -> todo.
    // Variant: a top-level c() read after each batch re-evaluates c to base and drops obj_i,
    // so NOTHING may still hold obj_i (not c, not s's batch capture). Strict === 0 every cycle.
    it('variant: after a top-level c() read, tracker.size() === 0 at the end of EVERY cycle', { todo: 'A3', skip: HAVE_GC ? false : 'needs --expose-gc' }, async () => {
        const r = createRegistry();
        const base = { base: true };
        const s = r.signal(base);
        const c = r.computed(() => s());
        const tracker = createLeakTracker({ name: 't37v', onLeak() {}, onWarning() {} });
        const cycle = (i) => {
            const obj = { i };
            tracker.track(obj, null, i);
            r.batch(() => { s.set(obj); c(); s.set(base); });
            if (c() !== base) throw new Error('c() must be base after the batch (cycle ' + i + ')');
        };
        for (let i = 0; i < 1000; i++) {
            cycle(i);
            globalThis.gc(); await new Promise((res) => setTimeout(res, 0)); globalThis.gc();
            await new Promise((res) => setImmediate(res)); globalThis.gc();
            assert.equal(tracker.size(), 0, 'cycle ' + i + ': obj_i is still retained');
        }
        r.dispose(s);
        r.dispose(c);
    });

    // Same without the in-batch c() read (no F5 trigger): isolates s's batch capture. Plain pin;
    // red on a mutant that captures the intermediate instead of the pre-batch value.
    it('variant-nobody: after a top-level c() read, tracker.size() === 0 at the end of EVERY cycle', { skip: HAVE_GC ? false : 'needs --expose-gc' }, async () => {
        const r = createRegistry();
        const base = { base: true };
        const s = r.signal(base);
        const c = r.computed(() => s());
        const tracker = createLeakTracker({ name: 't37v2', onLeak() {}, onWarning() {} });
        const cycle = (i) => {
            const obj = { i };
            tracker.track(obj, null, i);
            r.batch(() => { s.set(obj); s.set(base); });
            if (c() !== base) throw new Error('c() must be base after the batch (cycle ' + i + ')');
        };
        for (let i = 0; i < 1000; i++) {
            cycle(i);
            globalThis.gc(); await new Promise((res) => setTimeout(res, 0)); globalThis.gc();
            await new Promise((res) => setImmediate(res)); globalThis.gc();
            assert.equal(tracker.size(), 0, 'cycle ' + i + ': obj_i is still retained');
        }
        r.dispose(s);
        r.dispose(c);
    });
});
