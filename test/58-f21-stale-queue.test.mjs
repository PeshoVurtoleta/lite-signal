// test/58-f21-stale-queue.test.mjs -- F21 (LEDGER #35): a queued / scheduled node disposed and recycled
// while its stale queue entry is still pending.
//
// F21: disposeNode frees a QUEUED / scheduled node's slot; a new resident reuses it and the stale queue
// entry then ran the new resident (spurious run, double scheduler call, or a bogus "flush passes exceeded"
// CycleError at creation). The fix ("qskip2"): flushEffects runs a queue entry only if its node is still
// FLAG_QUEUED (scheduler branch and executeEffect branch alike). 0 B, no new flag bit.
//
// Oracle: .handoff/PLAN-F21.md PLANNER DELTA 2 (items 3-4, ASSERTION 2-3, O16-O19) + vectors; no expected value
// is copied from a kernel run except the KNOWN rows (measured HEAD numbers, D5) and the HEAD poolGrowths delta.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js with a sibling Watch.js), default ../Signal.js.
//
// RED-FIRST on HEAD 740edfc (proven): probe-f21 (a), P2_Afirst (b), P3 (c), P8 (c), d, D1 (f), rows 7 and 8 (e), PX3.
// PRESERVATION / KNOWN rows (green on HEAD and on the fix): P5, P7, P2_Bfirst, row 3, C1, C3, U1, R2-ABA, self-dispose,
// keep-QUEUED (deferred scheduler: one scheduler call per pending period), KNOWN R1, KNOWN R2.
// Mutants (DELTA 2 item 4) and the row that kills each:
//   Q1 no QUEUED test (= HEAD) ................. probe-f21
//   Q2 test on the executeEffect branch only ... P2_Afirst
//   Q3 test on the scheduler branch only ....... P3
//   Q4 (flags & (EFFECT|COMPUTING)) === EFFECT . P2_Afirst + D1
//   Q5 inverted polarity ....................... P7
// Review-b38 mutants (.handoff/frozen/review-b38/mut): M2 / M3 clear QUEUED at the scheduler call and M7
// re-push while QUEUED -> keep-QUEUED (M2 / M3 also KNOWN R1).
// C1 (N=1000 children, default registry) also guards against the rejected pinning design (fix3), which
// exhausted capacity.
// KNOWN rows are residuals R1 / R2, EQUAL TO HEAD (maintainer D5: documented, not fixed). They are pinned
// with the measured numbers so any change is visible:
//   R1 scheduled recycled resident legitimately queued in the window: scheduler 3 calls (ideal 2), body runs 2.
//   R2 unscheduled recycled resident runs early at the stale position; order "C0,C,M"; with a later write in
//      the same pass the body runs 3 (ideal 2), final value correct.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const { createRegistry } = await import(KPATH);

test('kernel under test', (t) => {
    const sha = createHash('sha256').update(readFileSync(KPATH)).digest('hex');
    t.diagnostic('kernel ' + KPATH + ' sha256 ' + sha);
    assert.equal(typeof createRegistry, 'function');
});

// poolGrowths deltas of rows 7 / 8, MEASURED on frozen HEAD 740edfc (DELTA 2: "delta = HEAD's"); the fix must not change them.
const HEAD_GROW7 = 0, HEAD_GROW8 = 0;

const tryMsg = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// Create signals until the free list is empty (free = nodePoolPopulation - activeNodes).
function exhaustFreeList(r) {
    const st = r.stats();
    let free = st.nodePoolPopulation - st.activeNodes;
    while (free-- > 0) r.signal(-1);
}

function p2Row(bFirst, label) {
    it(label, () => {
        const r = createRegistry({ maxFlushPasses: 8 });
        const s = r.signal(0), t = r.signal(0);
        let stopB = null, sched = 0, made = false; const order = [];
        const mkA = () => r.effect(() => { if (s() === 1) { order.push('A'); if (!made) { made = true; stopB(); r.effect(() => { t(); }, { scheduler: () => { sched++; order.push('S'); } }); } } });
        const mkB = () => r.effect(() => { if (s() === 1) order.push('B'); });
        if (bFirst) { stopB = mkB(); mkA(); } else { mkA(); stopB = mkB(); }
        s.set(1);
        // PLAN 1b: A first -> sched 1, order "A,S" (S called once at creation; B stopped before it ran).
        // Control (B first): B runs, then A stops it and creates S: "B,A,S", sched 1 (unchanged by the fix).
        assert.equal(sched, 1);
        assert.equal(order.join(','), bFirst ? 'B,A,S' : 'A,S');
        r.destroy();
    });
}

describe("F21 red-first", () => {
    it("(a) probe-f21: stale entry after a cycle abort does not break the next effect", () => {
        const r = createRegistry({ maxFlushPasses: 8 });
        const a = r.signal(0), b = r.signal(0);
        const e1 = r.effect(() => { b.set(a() + 1); });
        const e2 = r.effect(() => { a.set(b() + 1); });
        let cyc = null; try { a.set(500); } catch (e) { cyc = e.message; }
        e2(); e1(); r.dispose(a); r.dispose(b);
        const s1 = r.signal(1), w = r.signal(0);
        let runs = 0, err = null;
        try { r.effect(() => { runs++; w.set(s1() + 1); }); } catch (e) { err = e.message; }
        // Expected per PLAN ASSERTION 1a: the abort raises the cycle once; creation does not throw;
        // the new effect runs exactly once and is the only effect.
        assert.equal(cyc, 'CycleError: flush passes exceeded');
        assert.equal(err, null);
        assert.equal(runs, 1);
        assert.equal(r.stats().effects, 1);
        r.destroy();
    });

    p2Row(false, "P2_Afirst: same-pass recycle of a scheduled resident (A first) runs the scheduler once");

    it("(c) P8: test/19 shape on a fresh registry -- no creation-time error after a dead cycle", () => {
        const r = createRegistry();
        const a = r.signal(0), b = r.signal(0);
        const sA = r.effect(() => { const v = a(); if (v < 500) b.set(v + 1); });
        const sB = r.effect(() => { const v = b(); if (v < 500) a.set(v + 1); });
        let cyc = null; try { a.set(1); } catch (e) { cyc = e.message; }
        sB(); sA(); r.dispose(a); r.dispose(b);
        const s1 = r.signal(1), w = r.signal(0); let runs = 0, err = null;
        try { r.effect(() => { runs++; w.set(s1() + 1); }); } catch (e) { err = e.message; }
        assert.match(cyc, /flush passes exceeded/);
        assert.equal(err, null);          // PLAN 1c: err null
        assert.equal(r.stats().effects, 1); // PLAN 1c: effects 1
        assert.equal(runs, 1);
        r.destroy();
    });

    it("(c) P3: creation-time CycleError, then the next effect() is clean", () => {
        const r = createRegistry({ maxFlushPasses: 8 });
        const s1 = r.signal(1), w = r.signal(0);
        const go = r.signal(false), a = r.signal(0), b = r.signal(0);
        const e1 = r.effect(() => { if (go()) b.set(a() + 1); });
        const e3 = r.effect(() => { if (go()) a.set(b() + 1); });
        let createErr = null; try { r.effect(() => { go.set(true); }); } catch (e) { createErr = e.message; }
        e1(); e3();
        let runs = 0, err = null;
        try { r.effect(() => { runs++; w.set(s1() + 1); }); } catch (e) { err = e.message; }
        assert.match(createErr, /flush passes exceeded/); // PLAN 1c
        assert.equal(err, null);
        assert.equal(runs, 1);
        assert.equal(r.stats().effects, 1);
        r.destroy();
    });

    it("(d) cleanup re-queues the disposing node in a batch: a scheduled C recycling its slot is scheduled once", () => {
        const r = createRegistry();
        const d = r.signal(0), t = r.signal(0); let sched = 0;
        const stopB = r.effect(() => { d(); r.onCleanup(() => { d.set(99); }); });
        r.batch(() => { stopB(); r.effect(() => { t(); }, { scheduler: () => { sched++; } }); });
        // PLAN 1d: sched 1 (creation call only; the stale entry must not call C's scheduler again).
        assert.equal(sched, 1);
        r.destroy();
    });

    it("(e) row 7: free list exhausted, miss inside an open batch with a stale entry queued: scheduled once", () => {
        const r = createRegistry({ onCapacityExceeded: 'grow' });
        const s = r.signal(0), t = r.signal(0); let sched = 0;
        const stopB = r.effect(() => { s(); });
        exhaustFreeList(r);
        const g0 = r.stats().poolGrowths;
        r.batch(() => {
            s.set(1);                 // B queued
            stopB();                  // stale entry stays in the queue
            r.effect(() => { t(); }, { scheduler: () => { sched++; } }); // free list empty -> miss inside an open batch
        });
        // Row 7 (DELTA 2): no CapacityError (policy 'grow'), C's scheduler called once (creation only; the stale
        // entry must be skipped -> HEAD calls it twice), poolGrowths delta = HEAD's (measured on 740edfc).
        assert.equal(sched, 1);
        assert.equal(r.stats().poolGrowths - g0, HEAD_GROW7);
        r.destroy();
    });

    it("(e) row 8 MF1: a depth-0 scheduler mid-flush stops a queued B and creates a scheduled C with the free list exhausted", () => {
        const r = createRegistry({ onCapacityExceeded: 'grow' });
        const s = r.signal(0), t = r.signal(0); let sched = 0, stopB = null, sRuns = 0;
        r.effect(() => { s(); }, { scheduler: (run) => { if (sRuns++ === 0) { run(); return; } stopB(); r.effect(() => { t(); }, { scheduler: () => { sched++; } }); run(); } });
        stopB = r.effect(() => { s(); });
        exhaustFreeList(r);
        const g0 = r.stats().poolGrowths;
        s.set(1);
        // Row 8 (DELTA 2): S is queued before B; S's scheduler runs at depth 0 inside the flush, stops B (stale
        // entry pending), creates C with no free slot: no CapacityError (policy 'grow'), C scheduled once
        // (HEAD twice), poolGrowths delta = HEAD's (measured on 740edfc).
        assert.equal(sched, 1);
        assert.equal(r.stats().poolGrowths - g0, HEAD_GROW8);
        r.destroy();
    });

    it("(f) D1 thunk re-entry: a saved run() called while a new entry is pending, then stop + scheduled C", () => {
        const r = createRegistry();
        const s = r.signal(0), t = r.signal(0); let saved = null, sched = 0, sched2 = 0;
        const stop = r.effect(() => { s(); }, { scheduler: (run) => { sched++; saved = run; } });
        saved(); // first run
        r.batch(() => { s.set(1); saved(); stop(); r.effect(() => { t(); }, { scheduler: () => { sched2++; } }); });
        // PLAN 1f: sched2 1 (HEAD 2; mask-only fix 2; M4 2). Must-pass (D1 ruled (b)), no todo.
        assert.equal(sched2, 1);
        r.destroy();
    });

    it("PX3: onDisconnect re-queues a node inside stopE() in a batch; a scheduled C recycling the slot is scheduled once", () => {
        const r = createRegistry({ prealloc: 'eager' });
        const a = r.signal(0), b = r.signal(0); let sched = 0;
        const stopE = r.effect(() => { a(); b(); });
        r.observeObservers(a, { onDisconnect: () => b.set(b.peek() + 1) });
        r.batch(() => { stopE(); r.effect(() => {}, { scheduler: () => { sched++; } }); });
        // xprobe.mjs PX3 / ASSERTION 2: sched 1 (creation only). HEAD 2.
        assert.equal(sched, 1);
        r.destroy();
    });
});

describe("F21 preservation and mutant rows", () => {
    p2Row(true, "P2_Bfirst (control, preservation): B runs before A stops it");

    it("row 3 (b) unscheduled same-pass recycle (KNOWN R2 class = HEAD): C body runs exactly 2, order C0,C,M", () => {
        const r = createRegistry({ maxFlushPasses: 8 });
        const s = r.signal(0), u = r.signal(0);
        const order = []; let stopB = null, made = false;
        r.effect(() => { // A
            if (s() === 1 && !made) {
                made = true; stopB();
                r.effect(() => { u(); order.push(order.includes('C0') ? 'C' : 'C0'); });
                u.set(1);
            }
        });
        stopB = r.effect(() => { s(); }); // B
        r.effect(() => { if (s() === 1) order.push('M'); }); // M
        s.set(1);
        // DELTA 2 item 3 task 4: C runs exactly twice (creation + one legit re-run); the legit re-run happens early
        // at the stale entry's position (KNOWN R2 class, same as HEAD): "C0,C,M". Preservation row.
        assert.equal(order.filter((x) => x !== 'M').length, 2);
        assert.equal(order.join(','), 'C0,C,M');
        r.destroy();
    });

    // Kills M2 / M3 (clear QUEUED just before / after the scheduler call) and M7 (re-push while QUEUED in markDownstream).
    // Oracle (hand-derived): scheduler calls = creation + one per pending period (writes 1,2 share one period);
    // body runs = creation + one per thunk run (2 after the first drain, 3 after the second; HEAD agrees).
    it("a scheduled effect keeps QUEUED until its thunk runs (one scheduler call per pending period)", () => {
        const r = createRegistry(); const s = r.signal(0);
        let sched = 0, runs = 0, last = null; const pend = [];
        r.effect(() => { last = s(); runs++; }, { scheduler: (run) => { sched++; pend.push(run); } });
        for (const f of pend.splice(0)) f();            // creation run: sched 1, runs 1
        s.set(1); s.set(2);                              // two writes while the thunk is held: ONE scheduler call
        assert.equal(sched, 2);
        for (const f of pend.splice(0)) f();            // one thunk run reads the latest value
        assert.equal(runs, 2);
        assert.equal(last, 2);
        s.set(3); for (const f of pend.splice(0)) f();  // new pending period
        assert.equal(sched, 3);
        assert.equal(runs, 3);
        assert.equal(last, 3);
        r.destroy();
    });

    it("P5: a live cycle re-raises 'flush passes exceeded' on every later write", () => {
        const r = createRegistry({ maxFlushPasses: 8 });
        const a = r.signal(0), b = r.signal(0), q = r.signal(0);
        r.effect(() => { b.set(a() + 1); }); r.effect(() => { a.set(b() + 1); });
        assert.match(tryMsg(() => a.set(500)), /flush passes exceeded/);
        assert.match(tryMsg(() => q.set(1)), /flush passes exceeded/);
        assert.match(tryMsg(() => q.set(2)), /flush passes exceeded/);
        r.destroy();
    });

    it("P7: a bystander queued at the abort runs exactly once on the next write, then 0", () => {
        const r = createRegistry({ maxFlushPasses: 8 });
        const a = r.signal(0), b = r.signal(0), q = r.signal(0); let lr = 0;
        const x1 = r.effect(() => { b.set(a() + 1); }); const x2 = r.effect(() => { a.set(b() + 1); });
        r.effect(() => { a(); lr++; });
        assert.match(tryMsg(() => a.set(500)), /flush passes exceeded/);
        x1(); x2(); const at = lr; q.set(1); const n1 = lr - at; q.set(2);
        assert.equal(n1, 1);
        assert.equal(lr - at - n1, 0);
        r.destroy();
    });

    it("U1 (mutant row, green on HEAD): parent + 64 children recreated every pass never grows the pool (pool must stay bounded)", () => {
        const r = createRegistry({ onCapacityExceeded: 'grow' }); const s = r.signal(0);
        r.effect(() => { s(); for (let i = 0; i < 64; i++) r.effect(() => { s(); }); });
        for (let i = 0; i < 10; i++) s.set(s() + 1);
        const g0 = r.stats().poolGrowths;
        for (let i = 0; i < 1000; i++) s.set(s() + 1);
        assert.equal(r.stats().poolGrowths - g0, 0); // PLAN DELTA 1(c): delta 0 after a 10-write warm-up
        r.destroy();
    });

    it("R2-ABA (preservation): a cleanup that disposes its own effect, then misses at depth 0, never runs the stranger", () => {
        const r = createRegistry();
        const s = r.signal(0);
        let stop = null, X = null, runs = 0;
        stop = r.effect(() => {
            runs++; s();
            r.onCleanup(() => {
                stop();
                const st = r.stats();
                let free = st.nodePoolPopulation - st.activeNodes - 1;   // -1: the pinned slot
                while (free-- > 0) r.signal(-1);
                X = r.signal(5);                                        // free-list miss at depth 0
            });
        });
        // Derivation (test/35 R2-ABA): runs stays 1 (re-run stops before the body); X is an ordinary signal = 5.
        assert.equal(tryMsg(() => s.set(1)), null);
        assert.equal(runs, 1);
        assert.equal(X(), 5);
        assert.equal(r.describe(X).kind, "signal");
        r.destroy();
    });

    it("self-dispose while COMPUTING: the body finishes, the effect never re-runs, a new effect works", () => {
        const r = createRegistry();
        const s = r.signal(0); let stop = null, eRuns = 0, xRuns = 0;
        stop = r.effect(() => { eRuns++; if (s() === 1) stop(); });
        s.set(1);                 // e runs (2) and disposes itself
        r.effect(() => { s(); xRuns++; });
        s.set(2);
        // Derivation: e runs at creation and on s=1 only (2). X runs at creation (1) and on s=2 (2).
        assert.equal(eRuns, 2);
        assert.equal(xRuns, 2);
        r.destroy();
    });

    it("C1 (preservation; red on fix3): parent + N=1000 children reading the same source, default registry, no CapacityError", () => {
        const r = createRegistry();
        const s = r.signal(0); let runs = 0;
        r.effect(() => { s(); for (let i = 0; i < 1000; i++) r.effect(() => { s(); runs++; }); });
        // reviewer probe cap.mjs C1: HEAD and qskip2 do not throw; the pinning design (fix3) exhausted capacity.
        assert.equal(tryMsg(() => s.set(1)), null);
        assert.equal(tryMsg(() => s.set(2)), null);
        assert.equal(tryMsg(() => s.set(3)), null);
        // Each write destroys the old 1000 children and recreates 1000: they run once at creation.
        // Creation 1000 + 3 writes x 1000 = 4000 child body runs (stale entries of disposed children never run).
        assert.equal(runs, 4000);
        r.destroy();
    });

    it("C3 (preservation): scheduled effects disposed in a batch with a pending entry, then the pool refills, no throw", () => {
        const r = createRegistry(); const s = r.signal(0);
        r.effect(() => { s(); });
        const stops = []; for (let i = 0; i < 500; i++) stops.push(r.effect(() => {}, { scheduler: (run) => run() }));
        const fill = [];
        while (r.stats().nodePoolPopulation < 1024 || r.stats().activeNodes < 1024) { fill.push(r.signal(0)); if (fill.length > 2000) break; }
        for (let i = 0; i < 100; i++) r.dispose(fill.pop());
        // cap.mjs C3 shape: 500 disposed in the batch + 600 new signals fit in 1024 minus live nodes: no throw.
        assert.equal(tryMsg(() => r.batch(() => { s.set(1); for (const d of stops) d(); for (let i = 0; i < 600; i++) r.signal(0); })), null);
        r.destroy();
    });
});

describe("F21 KNOWN residuals (HEAD-equal, D5; pinned so any change is visible)", () => {
    it("KNOWN R1: recycled SCHEDULED resident legitimately queued in the window: scheduler 3 calls (ideal 2), body runs 2", () => {
        const r = createRegistry(); const s = r.signal(0), u = r.signal(0);
        let stopB = null, sched = 0, runs = 0, made = false; const pending = [];
        r.effect(() => { if (s() === 1 && !made) { made = true; stopB();
            r.effect(() => { u(); runs++; }, { scheduler: (run) => { sched++; if (sched === 1) run(); else pending.push(run); } });
            u.set(1); } });
        stopB = r.effect(() => { s(); });
        s.set(1); const schedAfter = sched; for (const f of pending.splice(0)) f();
        // vectors/resid.mjs, measured on HEAD 740edfc: sched 3 (ideal 2), runs 2. The fix keeps HEAD's numbers.
        assert.equal(schedAfter, 3);
        assert.equal(runs, 2);
        r.destroy();
    });

    it("KNOWN R2: unscheduled recycled resident runs early at the stale position; a later same-pass write re-queues it: runs 3 (ideal 2), last 2", () => {
        const r = createRegistry(); const s = r.signal(0), u = r.signal(0);
        let stopB = null, runs = 0, made = false, last = null;
        r.effect(() => { if (s() === 1 && !made) { made = true; stopB(); r.effect(() => { last = u(); runs++; }); u.set(1); } });
        stopB = r.effect(() => { s(); });
        r.effect(() => { if (s() === 1) u.set(2); });
        s.set(1);
        // vectors/resid2.mjs, measured on HEAD 740edfc: runs 3 (ideal 2), final value 2 (correct).
        assert.equal(runs, 3);
        assert.equal(last, 2);
        r.destroy();
    });
});
