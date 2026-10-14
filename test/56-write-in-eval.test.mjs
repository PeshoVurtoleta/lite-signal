// test/56-write-in-eval.test.mjs -- F-b33-1: a write made DURING an evaluation (a computed body writes a
// signal, or a computed's onCleanup writes one during the dependency pre-walk) must not be absorbed by a
// reader that already read the old value. The reader is flagged stale and re-runs in the same flush / read.
// Self-writes (direct or under untrack) stay absorbed. A write cycle that never settles throws CycleError
// where it forms (effect creation).
//
// Oracle: .handoff/PLAN-F-b33-1.md ASSERTION 1 + audit/2026-10-14/F-b33-1.md rows V1-V9, X1, X2 + the b33
// pre-walk lanes. Expected values are the spec's (V1 seen=10 runs=2, V7 D()=10, X1 D=1 a=1, b33-effect,
// b33-computed, X2 throws at creation, V8 / V9 a=1 runs=1). Rows without a spec number (V3, V6, V2, V5, NR,
// TS, S-*, b33-cleanup, nested-batch) are derived by hand in the comment on the row.
// Engine: F_B33_ENGINE (absolute path or file: URL), default ../Signal.js.
//
// RED on frozen head-7c65afd (a5c64df9), measured: V1, V3, V6, V7, X1, X2, b33-effect, b33-computed, b33-cleanup,
// nested-batch, S-dispose, CAP, BW, DR, X2R, F6K, F6K-after, KNOWN EQ, KNOWN ANC, KNOWN P2-eRuns. GREEN on it: V2, V5,
// V8, V9, NR, TS, S-recycle, RF, P2, P2c, P4, PC, W0, KNOWN P1, KNOWN P1b (log: .handoff/b44-evidence/helper-56-b45-frozen.txt).
// X2R is red there because the 2nd effect does not throw at creation.
// X2R's qskip2 teeth are proven by mutant M12 (qskip2 stripped), not by a5c64df9.
// RED on the B1 engine f2dd6edc (R1-REJECTED: false STALE from the node's own cleanups): P2, P2c, P4, PC, W0, DR, KNOWN P2-eRuns.
// F6K is a KNOWN pin (DIV-F6, open, fixBy A2): it asserts the CURRENT value (runs 1); the ideal is 2.
// KNOWN (N8) pins (maintainer 2026-10-14 "accept all three"): EQ (D-M1), P1 / P1b (D-M2), ANC + P2-eRuns (D-R3).
// Each asserts CURRENT behaviour. ANC + P2-eRuns are temporary tripwires that DELTA 4 flips (1.6.0 release blocker).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const ENGINE = process.env.F_B33_ENGINE ?? new URL('../Signal.js', import.meta.url).href;
const { createRegistry } = await import(ENGINE.startsWith('file:') ? ENGINE : pathToFileURL(ENGINE).href);

// Fresh registry per row; destroy() in a finally so a CycleError leftover queue never leaks.
function withReg(fn, cfg) {
    const r = createRegistry(cfg ?? { maxNodes: 256, onCapacityExceeded: 'grow' });
    try { fn(r); } finally { r.destroy(); }
}

describe('F-b33-1 write during evaluation', () => {
    // V1: effect reads a, then pulls C which writes a=10. Fixed: the effect re-runs once, sees 10.
    it('V1 effect reads a, then pulls C (C writes a=10)', () => withReg((r) => {
        const a = r.signal(0);
        let runs = 0, seen = -1;
        const C = r.computed(() => { a.set(10); return 1; });
        r.effect(() => { runs++; seen = a(); C(); });
        assert.strictEqual(seen, 10);
        assert.strictEqual(a.peek(), 10);
        assert.strictEqual(runs, 2);
    }));

    // V2 control: C first, then a -- the write lands before the read; one run.
    it('V2 effect pulls C, then reads a', () => withReg((r) => {
        const a = r.signal(0);
        let runs = 0, seen = -1;
        const C = r.computed(() => { a.set(10); return 1; });
        r.effect(() => { runs++; C(); seen = a(); });
        assert.strictEqual(seen, 10);
        assert.strictEqual(runs, 1);
    }));

    // V3: effect reads Y=computed(a) first, then pulls C (writes a). Same shape as V1 through a computed:
    // by analogy with V1 the effect re-runs once (runs=2) and Y, a end at 10.
    it('V3 effect reads Y(a), then pulls C (writes a)', () => withReg((r) => {
        const a = r.signal(0);
        let runs = 0, y = -1;
        const Y = r.computed(() => a());
        const C = r.computed(() => { a.set(10); return 1; });
        r.effect(() => { runs++; y = Y(); C(); });
        assert.strictEqual(y, 10);
        assert.strictEqual(Y(), 10);
        assert.strictEqual(a.peek(), 10);
        assert.strictEqual(runs, 2);
    }));

    // V5 control: the writer is another EFFECT. Y's effect runs at creation (runs=1), then re-runs once
    // when the second effect writes a (runs=2) -- ordinary propagation.
    it('V5 control: write from an effect', () => withReg((r) => {
        const a = r.signal(0);
        let runs = 0, y = -1;
        const Y = r.computed(() => a());
        r.effect(() => { runs++; y = Y(); });
        r.effect(() => { a.set(10); });
        assert.strictEqual(y, 10);
        assert.strictEqual(a.peek(), 10);
        assert.strictEqual(runs, 2);
    }));

    // V6: as V3 with the write wrapped in untrack inside C (untrack keeps the writer identity).
    it('V6 write wrapped in untrack inside C', () => withReg((r) => {
        const a = r.signal(0);
        let runs = 0, y = -1;
        const Y = r.computed(() => a());
        const C = r.computed(() => { r.untrack(() => a.set(10)); return 1; });
        r.effect(() => { runs++; y = Y(); C(); });
        assert.strictEqual(y, 10);
        assert.strictEqual(Y(), 10);
        assert.strictEqual(runs, 2);
    }));

    // V7: a COMPUTED reads a, then pulls writer C: the stale value must not be cached.
    it('V7 computed reads a then pulls writer C', () => withReg((r) => {
        const a = r.signal(0);
        const C = r.computed(() => { a.set(10); return 1; });
        const D = r.computed(() => { const x = a(); C(); return x; });
        assert.strictEqual(D(), 10);
        assert.strictEqual(D(), 10);
        assert.strictEqual(a.peek(), 10);
    }));

    // V8 control: effect self-write is absorbed (documented): a=1, one run.
    it('V8 effect self-write (absorbed)', () => withReg((r) => {
        const a = r.signal(0);
        let runs = 0;
        r.effect(() => { runs++; const v = a(); if (v < 3) a.set(v + 1); });
        assert.strictEqual(a.peek(), 1);
        assert.strictEqual(runs, 1);
    }));

    // V9 control: self-write under untrack is absorbed too.
    it('V9 effect untracked self-write (absorbed)', () => withReg((r) => {
        const a = r.signal(0);
        let runs = 0;
        r.effect(() => { runs++; const v = a(); r.untrack(() => { if (v < 3) a.set(v + 1); }); });
        assert.strictEqual(a.peek(), 1);
        assert.strictEqual(runs, 1);
    }));

    // X1: a writer that writes a NEW value each evaluation. C is evaluated once (no deps), so after the
    // single stale re-pull D() = 1 and a = 1 (spec: D=1 a=1).
    it('X1 computed: writer never converges', () => withReg((r) => {
        const a = r.signal(0);
        let n = 0;
        const C = r.computed(() => { a.set(++n); return n; });
        const D = r.computed(() => { const x = a(); C(); return x; });
        assert.strictEqual(D(), 1);
        assert.strictEqual(a.peek(), 1);
    }));

    // X2: ping-pong effects. The cycle forms at the SECOND effect() call, which must throw CycleError.
    it('X2 ping-pong effects throw CycleError at creation', () => withReg((r) => {
        const a = r.signal(0), b = r.signal(0);
        r.effect(() => { const v = a(); if (v < 500) b.set(v + 1); });
        let caught = null;
        try { r.effect(() => { const v = b(); if (v < 500) a.set(v + 1); }); } catch (e) { caught = e; }
        assert.ok(caught !== null, 'second effect() must throw');
        assert.match(caught.message, /^CycleError:/);
    }));

    // b33-effect: pre-walk lane. E reads a then C; C's recompute (triggered by s) writes a inside E's
    // pre-walk pull. Spec: s=1 -> seen=10 runs=1; s=2 -> seen=20 runs=2 (runs counted from after creation).
    it('b33-effect pre-walk write reaches the effect', () => withReg((r) => {
        const s = r.signal(0), a = r.signal(0);
        const C = r.computed(() => { if (s() !== 0) a.set(s() * 10); return 0; });
        let seen = -1, runs = 0;
        r.effect(() => { runs++; seen = a() + C(); });
        runs = 0;
        s.set(1);
        assert.strictEqual(seen, 10);
        assert.strictEqual(runs, 1);
        s.set(2);
        assert.strictEqual(seen, 20);
        assert.strictEqual(runs, 2);
    }));

    // b33-computed: pull lane. Y reads a then C; C's recompute (s=1) writes a. Spec: Y=10, reread 10,
    // and still 10 after an unrelated write.
    it('b33-computed pull-walk write reaches the computed', () => withReg((r) => {
        const s = r.signal(0), a = r.signal(0);
        const C = r.computed(() => { if (s() !== 0) a.set(s() * 10); return 0; });
        const Y = r.computed(() => a() + C());
        Y();
        s.set(1);
        assert.strictEqual(Y(), 10);
        assert.strictEqual(Y(), 10);
        r.signal(0).set(1);
        assert.strictEqual(Y(), 10);
        assert.strictEqual(a.peek(), 10);
    }));

    // b33-cleanup: as b33-effect but the write is made by C's onCleanup (runs when C re-evaluates for s=1).
    // Hand-derived: a=10 after s=1, the effect must have seen it (seen = a + C = 10 + 0).
    it('b33-cleanup onCleanup write during the pre-walk', () => withReg((r) => {
        const s = r.signal(0), a = r.signal(0);
        const C = r.computed(() => {
            const v = s();
            r.onCleanup(() => { if (v === 0) a.set(10); });
            return 0;
        });
        let seen = -1;
        r.effect(() => { seen = a() + C(); });
        s.set(1);
        assert.strictEqual(a.peek(), 10);
        assert.strictEqual(seen, 10);
    }));

    // nested-batch: V1 shape, but the triggering write sits inside nested batches; the re-run lands at the
    // outermost batch end. The effect pulls C only when s===1 (C has no deps, so it is NOT in the pre-walk;
    // its first evaluation happens inside the body, after a() was read). Hand-derived: creation = 1 run;
    // batch end = 1 run (reads a=0, C writes a=10 -> stale) + 1 re-run (reads a=10) -> runs=3, seen=10.
    // (A variant where C is already a dep is pre-walk-detected on the frozen build too: not red-first.)
    it('nested-batch trigger inside nested r.batch', () => withReg((r) => {
        const s = r.signal(0), a = r.signal(0);
        const C = r.computed(() => { a.set(10); return 1; });
        let runs = 0, seen = -1;
        r.effect(() => { runs++; seen = a(); if (s() === 1) C(); });
        assert.strictEqual(runs, 1);
        r.batch(() => { r.batch(() => { s.set(1); }); });
        assert.strictEqual(seen, 10);
        assert.strictEqual(a.peek(), 10);
        assert.strictEqual(runs, 3);
    }));

    // NR: equal-cutoff no-run exit. s changes but c = (s > 5) stays 0 -> effect +0 runs; a real change +1.
    it('NR equal-value computed: no run, then a real change runs once', () => withReg((r) => {
        const s = r.signal(0);
        const c = r.computed(() => (s() > 5 ? 1 : 0));
        let runs = 0;
        r.effect(() => { runs++; c(); });
        assert.strictEqual(runs, 1);
        s.set(1);
        assert.strictEqual(runs, 1);
        s.set(10);
        assert.strictEqual(runs, 2);
    }));

    // TS: an effect body that throws after a stale read does not re-run; after the throwing run the body is
    // disarmed and the next unrelated set gives exactly +1 run (a leftover STALE flag would give +2).
    // (A throw during effect() creation disposes the effect, so the throwing run is a later one.)
    // Armed run, triggered by u: reads a, first-evaluates C (writes a=10 -> stale), reads u, throws.
    it('TS body throws after a stale read: no re-run, then +1 per set', () => withReg((r) => {
        const a = r.signal(0), u = r.signal(0);
        let arm = false, runs = 0;
        const C = r.computed(() => { a.set(10); return 1; });
        r.effect(() => { runs++; a(); u(); if (arm) { C(); throw new Error('boom'); } });
        assert.strictEqual(runs, 1);
        arm = true;
        try { u.set(1); } catch (e) { /* the body error surfaces */ }
        assert.strictEqual(runs, 2);
        arm = false;
        u.set(2);
        assert.strictEqual(runs, 3);
    }));

    // S-dispose: a computed disposes itself mid-repull (and writes a stale-making signal first). Hand-derived:
    // out reads a (0), pulls D which writes a=10 and disposes itself, returns 1; out is flagged stale, re-pulls,
    // reads a=10 and D() of a disposed node -> no throw, out() === 10. The registry must not be left stuck:
    // a fresh effect still runs exactly once per set afterwards.
    it('S-dispose computed disposes itself mid-repull', () => withReg((r) => {
        const a = r.signal(0);
        const D = r.computed(() => { a.set(10); r.dispose(D); return 1; });
        const out = r.computed(() => { const x = a(); D(); return x; });
        assert.strictEqual(out(), 10);
        assert.strictEqual(a.peek(), 10);
        const u = r.signal(0);
        let runs = 0;
        r.effect(() => { runs++; u(); });
        assert.strictEqual(runs, 1);
        u.set(1);
        assert.strictEqual(runs, 2);
        u.set(2);
        assert.strictEqual(runs, 3);
    }));

    // S-recycle: an effect is re-queued then disposed inside a batch, its slot is recycled into G; G must run
    // exactly once at creation and once per unrelated set (no spurious run from the stale queue entry).
    // The pool is a small 'throw' registry filled to capacity - 1, so E takes the last slot and G can only
    // be created by reusing E's slot (otherwise creation throws CapacityError).
    it('S-recycle queued-then-disposed effect slot recycled into G', () => withReg((r) => {
        const s = r.signal(0), u = r.signal(0);
        while (r.stats().activeNodes < r.stats().nodePoolCapacity - 1) r.signal(-1);
        const stopE = r.effect(() => { s(); });
        assert.strictEqual(r.stats().activeNodes, r.stats().nodePoolCapacity);
        let gRuns = 0;
        r.batch(() => {
            s.set(1);
            stopE();
            r.effect(() => { gRuns++; u(); });
        });
        assert.strictEqual(gRuns, 1);
        u.set(1);
        assert.strictEqual(gRuns, 2);
        u.set(2);
        assert.strictEqual(gRuns, 3);
    }, { maxNodes: 16, onCapacityExceeded: 'throw' }));

    // CAP (R1-B3): the computed re-pull cap. maxFlushPasses 3. D reads a, writes b, pulls C; C writes a from b:
    // the pair never settles. Spec: throws /^CycleError: computed keeps invalidating/ after D ran 4 times
    // (1 + maxFlushPasses re-pulls). Frozen: no stale mechanism, 1 run, no throw.
    it('CAP computed re-pull cap throws CycleError after 1 + maxFlushPasses runs', () => withReg((r) => {
        const a = r.signal(0), b = r.signal(0);
        let dr = 0;
        const C = r.computed(() => { a.set(b() + 1); return 0; });
        const D = r.computed(() => { dr++; const x = a(); b.set(x + 1); C(); return x; });
        assert.throws(() => D(), (e) => /^CycleError: computed keeps invalidating/.test(e.message));
        assert.strictEqual(dr, 4);
    }, { maxFlushPasses: 3 }));

    // BW (R1-M3): an effect created inside r.batch runs once inside the batch, and its stale requeue waits for
    // the batch end (no drain while batchDepth > 0): inBatch 1; after the batch runs 2, seen 10.
    it('BW stale requeue of an effect created in a batch waits for the batch end', () => withReg((r) => {
        const a = r.signal(0);
        let runs = 0, seen = -1, inBatch = -1;
        const C = r.computed(() => { a.set(10); return 1; });
        r.batch(() => { r.effect(() => { runs++; seen = a(); C(); }); inBatch = runs; });
        assert.strictEqual(inBatch, 1);
        assert.strictEqual(runs, 2);
        assert.strictEqual(seen, 10);
    }));

    // P2 (R1-B1): a computed's own onCleanup writes a signal the computed then reads. The write is made before
    // the body's first read, so it is seen, not stale: Y re-evaluates once (yruns 1), reads k=1, no throw.
    it('P2 computed own cleanup writes its dep (depth 1): seen, not stale', () => withReg((r) => {
        const k = r.signal(0), t = r.signal(0);
        let yruns = 0, out = -1;
        const Y = r.computed(() => { yruns++; t(); const v = k(); r.onCleanup(() => k.set(k.peek() + 1)); return v; });
        r.effect(() => { t(); out = Y(); });
        const y0 = yruns;
        t.set(1);
        assert.strictEqual(out, 1);
        assert.strictEqual(yruns - y0, 1);
        assert.strictEqual(k.peek(), 1);
    }));

    // P2c: as P2 with an idempotent reset cleanup (k.set(-1)): out -1, one Y run, k -1.
    it('P2c computed own cleanup resets its dep (depth 1): one run', () => withReg((r) => {
        const k = r.signal(0), t = r.signal(0);
        let yruns = 0, out = -9;
        const Y = r.computed(() => { yruns++; t(); const v = k(); r.onCleanup(() => k.set(-1)); return v; });
        r.effect(() => { t(); out = Y(); });
        const y0 = yruns;
        t.set(1);
        assert.strictEqual(out, -1);
        assert.strictEqual(yruns - y0, 1);
        assert.strictEqual(k.peek(), -1);
    }));

    // P4: an effect re-run at depth 1 (flushed inside Z's body) whose own cleanup writes the signal it reads:
    // exactly +1 run, k 1, Z() 0, no throw.
    it('P4 effect own cleanup writes its dep, run at depth 1', () => withReg((r) => {
        const k = r.signal(0), s = r.signal(0);
        let eruns = 0;
        r.effect(() => { eruns++; s(); k(); r.onCleanup(() => k.set(k.peek() + 1)); });
        const Z = r.computed(() => { s.set(1); return 0; });
        const e0 = eruns;
        assert.strictEqual(Z(), 0);
        assert.strictEqual(eruns - e0, 1);
        assert.strictEqual(k.peek(), 1);
    }));

    // PC: P4, but the cleanup that writes k belongs to an OWNED CHILD effect of E (disposed with E's re-run).
    it('PC owned child effect cleanup writes the parent dep, run at depth 1', () => withReg((r) => {
        const k = r.signal(0), s = r.signal(0);
        let eruns = 0;
        r.effect(() => {
            eruns++; s(); k();
            r.effect(() => { r.onCleanup(() => k.set(k.peek() + 1)); });
        });
        const Z = r.computed(() => { s.set(1); return 0; });
        const e0 = eruns;
        assert.strictEqual(Z(), 0);
        assert.strictEqual(eruns - e0, 1);
        assert.strictEqual(k.peek(), 1);
    }));

    // W0: depth 0. E's cleanup opens a frame (a throwaway computed) that writes k, which E reads: +1 run, k 1.
    it('W0 cleanup frame writes the effect dep at depth 0', () => withReg((r) => {
        const k = r.signal(0), t = r.signal(0);
        let eruns = 0;
        r.effect(() => {
            eruns++; t(); k();
            r.onCleanup(() => r.computed(() => { k.set(k.peek() + 1); return 0; })());
        });
        const e0 = eruns;
        t.set(1);
        assert.strictEqual(eruns - e0, 1);
        assert.strictEqual(k.peek(), 1);
    }));

    // RF: the re-pull floor keeps the equality cutoff. D's stale re-pull yields 7 again, so Q (reads D) does not
    // re-run: q stays 1 (Q's first evaluation only). D() 7, Q() 7.
    it('RF equality cutoff kept across a stale re-pull', () => withReg((r) => {
        const a = r.signal(0), s = r.signal(0);
        let q = 0;
        const C = r.computed(() => { if (s() !== 0) a.set(a.peek() + 1); return 0; });
        const D = r.computed(() => { a(); C(); return 7; });
        const Q = r.computed(() => { q++; return D(); });
        Q();
        r.batch(() => { s.set(1); a.set(5); });
        assert.strictEqual(D(), 7);
        assert.strictEqual(Q(), 7);
        assert.strictEqual(q, 1);
    }));

    // DR (R1-L1, probe p5 shape): destroy() inside a nested stale re-pull must not leave the re-pull counter
    // skewed. maxFlushPasses 3: the cap run count is 1 + 3 = 4 (spec: cap = maxFlushPasses nested re-pulls);
    // measured before and after a run that destroys the registry at its 3rd evaluation, it must still be 4.
    // (Frozen: no mechanism, 1 and 1; B1 engine: after = 6.)
    it('DR destroy inside a nested re-pull does not drift the cap', () => withReg((r) => {
        const capRuns = (k) => {
            const a = r.signal(0), b = r.signal(0);
            let dr = 0;
            const C = r.computed(() => { a.set(b() + 1); return 0; });
            const D = r.computed(() => { dr++; const x = a(); b.set(x + 1); C(); if (dr === k) r.destroy(); return x; });
            try { D(); } catch (e) { /* CycleError at the cap */ }
            return dr;
        };
        const before = capRuns(-1);
        capRuns(3);
        const after = capRuns(-1);
        assert.strictEqual(before, 4);
        assert.strictEqual(after, 4);
    }, { maxFlushPasses: 3 }));

    // X2R (DELTA 2 item 2, R2-B1 fix): a creation-time CycleError leaves the failed effect's queue entry behind;
    // qskip2 must skip it even after its slot is recycled. maxFlushPasses 8. The 2nd effect (a.set(b()+1)) throws at
    // creation. N is created BEFORE e1() is stopped, so N recycles the FAILED effect's slot (e1 is still live): the
    // leftover entry then points at N's slot, and only qskip2's FLAG_QUEUED check keeps it from running N spuriously.
    // After N: err null, runs 1, effects 2; e1() -> effects 1; s1.set(5) -> runs 2, w 6.
    // Teeth: red under M12 (qskip2 stripped: N creation throws "Infinite effect loop detected.", runs 1, w 1). On
    // a5c64df9 it is red only because the 2nd effect does not throw at creation (cyc null) -- not a qskip2 witness.
    it('X2R creation CycleError leftover entry does not run the recycled slot', () => withReg((r) => {
        const a = r.signal(0), b = r.signal(0), s1 = r.signal(0), w = r.signal(0);
        const e1 = r.effect(() => { const v = a(); if (v < 500) b.set(v + 1); });
        let cyc = null;
        try { r.effect(() => { a.set(b() + 1); }); } catch (e) { cyc = e; }
        assert.ok(cyc !== null, 'second effect() must throw');
        assert.match(cyc.message, /^CycleError:/);
        let runs = 0, err = null;
        try { r.effect(() => { runs++; w.set(s1() + 1); }); } catch (e) { err = e; }
        assert.strictEqual(err, null);
        assert.strictEqual(runs, 1);
        assert.strictEqual(r.stats().effects, 2);
        e1();
        assert.strictEqual(r.stats().effects, 1);
        s1.set(5);
        assert.strictEqual(runs, 2);
        assert.strictEqual(w.peek(), 6);
    }, { maxNodes: 256, onCapacityExceeded: 'grow', maxFlushPasses: 8 }));

    // F6K -- KNOWN DIV-F6 pin (open, fixBy A2). C writes x from a foreign owner (stale flag on C itself) while go
    // is true: the re-pull cap throws 'CycleError: computed keeps invalidating its own reads' inside E's pre-walk,
    // leaving E QUEUED with its entry consumed, so E never runs again. maxFlushPasses 8: x ends 9 (1 + 8 runs).
    // Asserts the CURRENT value runs === 1; the ideal is 2 (A2's DIV-F6 fix flips this row).
    it('F6K KNOWN DIV-F6: computed CycleError in the pre-walk strands the effect (runs 1, ideal 2)', () => withReg((r) => {
        const x = r.signal(0), go = r.signal(false);
        const C = r.computed(() => {
            const v = x();
            if (go()) r.runWithOwner(undefined, () => x.set(v + 1));
            return v;
        });
        let runs = 0;
        r.effect(() => { runs++; C(); });
        let msg = null;
        try { go.set(true); } catch (e) { msg = e.message; }
        assert.strictEqual(msg, 'CycleError: computed keeps invalidating its own reads');
        assert.strictEqual(x.peek(), 9);
        go.set(false);
        assert.strictEqual(runs, 1); // KNOWN DIV-F6: ideal 2
        assert.strictEqual(C(), 9);
    }, { maxNodes: 256, onCapacityExceeded: 'grow', maxFlushPasses: 8 }));

    // F6K-after: after a computed CycleError the re-pull counter is back at 0 (balanced by the finally), so a
    // fresh computed K may re-pull itself 7 times (1 + 7 = 8 runs, under the cap of 8) and return 7, no throw.
    it('F6K-after re-pull counter back to 0 after a computed CycleError', () => withReg((r) => {
        const y = r.signal(0);
        const P = r.computed(() => { const v = y(); r.runWithOwner(undefined, () => y.set(v + 1)); return v; });
        assert.throws(() => P(), (e) => /^CycleError: computed keeps invalidating/.test(e.message));
        const x = r.signal(0);
        let n = 0;
        const K = r.computed(() => {
            n++;
            const v = x();
            if (v < 7) r.runWithOwner(undefined, () => x.set(v + 1));
            return v;
        });
        assert.strictEqual(K(), 7);
        assert.strictEqual(n, 8);
    }, { maxNodes: 256, onCapacityExceeded: 'grow', maxFlushPasses: 8 }));

    // KNOWN (N8) EQ (D-M1, maintainer ruling 2026-10-14): a stale re-pull through an equality-cutoff computed D
    // (always 7) still re-runs its reader E2 once. Asserts the CURRENT value e2After 1; the ideal is 0 (values are
    // correct, D 7; <= +1 effect run per write wave). a5c64df9 gives 0 (no mechanism) -> red there.
    it('KNOWN (N8) EQ equality-cutoff re-pull over-runs the reader (e2After 1, ideal 0)', () => withReg((r) => {
        const a = r.signal(0), s = r.signal(0);
        const C = r.computed(() => { if (s() !== 0) a.set(a.peek() + 1); return 0; });
        const D = r.computed(() => { a(); C(); return 7; });
        let e2 = 0;
        r.effect(() => { e2++; D(); });
        const e0 = e2;
        s.set(1);
        assert.strictEqual(D(), 7);
        assert.strictEqual(e2 - e0, 1); // KNOWN (N8) D-M1: ideal 0
    }));

    // KNOWN (N8) P1 (D-M2): onConnect writes a signal the connecting reader already read; the write is absorbed as
    // the reader's own self-write (same as a5c64df9). Asserts CURRENT: runs 1, seen 0, a 10; the ideal is that the
    // write is seen (seen 10). Green on a5c64df9 too (unchanged behaviour).
    it('KNOWN (N8) P1 onConnect write absorbed as the reader self-write (seen 0, ideal 10)', () => withReg((r) => {
        const a = r.signal(0), src = r.signal(0);
        let runs = 0, seen = -1;
        r.observeObservers(src, { onConnect: () => a.set(10) });
        r.effect(() => { runs++; seen = a(); src(); });
        assert.strictEqual(runs, 1);
        assert.strictEqual(seen, 0); // KNOWN (N8) D-M2: ideal 10
        assert.strictEqual(a.peek(), 10);
    }));

    // KNOWN (N8) P1b (D-M2): computed form. D() caches 0 twice though a is 10; ideal is 10. Green on a5c64df9 too.
    it('KNOWN (N8) P1b onConnect write absorbed in a computed (D 0 twice, ideal 10)', () => withReg((r) => {
        const a = r.signal(0), src = r.signal(0);
        r.observeObservers(src, { onConnect: () => a.set(10) });
        const D = r.computed(() => { const x = a(); src(); return x; });
        assert.strictEqual(D(), 0); // KNOWN (N8) D-M2: ideal 10
        assert.strictEqual(D(), 0);
        assert.strictEqual(a.peek(), 10);
    }));

    // KNOWN (N8) ANC (D-R3): TEMPORARY TRIPWIRE that DELTA 4 will flip ("no STALE through an absorbing / COMPUTING
    // node"); a 1.6.0 RELEASE BLOCKER, never a shipped exception. E writes t then pulls Y; Y reads t and k and
    // self-writes k. Head flags E STALE through the absorbing Y and loops: effect() creation throws
    // /^CycleError: flush passes exceeded/ (a5c64df9: 1 run, no throw). Ideal: no throw, 1 run.
    it('KNOWN (N8) ANC effect creation throws CycleError through an absorbing computed (TRIPWIRE, DELTA 4 flips)', () => withReg((r) => {
        const t = r.signal(0), k = r.signal(0);
        const Y = r.computed(() => { t(); const v = k(); k.set(v + 1); return v; });
        assert.throws(
            () => r.effect(() => { t.set(t.peek() + 1); Y(); }),
            (e) => /^CycleError: flush passes exceeded/.test(e.message));
    }));

    // KNOWN (N8) P2-eRuns (D-R3, same tripwire family): computed Y's own cleanup writes its own dep k, Y pulled in E's
    // body; t.set(1) re-runs Y once (yruns 1, out 1, k 1) but E twice (eRunsAfter 2). Ideal 1; a5c64df9 gives 1.
    it('KNOWN (N8) P2-eRuns computed own cleanup write re-runs the reader effect twice (eRuns 2, ideal 1)', () => withReg((r) => {
        const k = r.signal(0), t = r.signal(0);
        let yruns = 0, eruns = 0, out = -1;
        const Y = r.computed(() => { yruns++; t(); const v = k(); r.onCleanup(() => k.set(k.peek() + 1)); return v; });
        r.effect(() => { eruns++; t(); out = Y(); });
        const y0 = yruns, e0 = eruns;
        t.set(1);
        assert.strictEqual(out, 1);
        assert.strictEqual(yruns - y0, 1);
        assert.strictEqual(k.peek(), 1);
        assert.strictEqual(eruns - e0, 2); // KNOWN (N8) D-R3: ideal 1
    }));
});
