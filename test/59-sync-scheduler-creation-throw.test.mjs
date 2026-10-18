// test/59-sync-scheduler-creation-throw.test.mjs -- burst 59: a first-run throw that goes through a SYNCHRONOUS
// scheduler (or the scheduler itself throwing) must dispose the effect before the rethrow, as the no-scheduler path
// does; and a first run that throws `null` must rethrow null (not be swallowed).
//
// Oracle: .handoff/PLAN-0t.md ASSERTIONS 1-4, 6-8 (ADDENDUM A1 hoist, A2 throw-null). No expected value is read
// from a kernel run. Assertion 5 (torture ok 0 B/op gc 0/0; 7 hot-body sha256 identical to HEAD) is NOT here: it is
// torture.mjs + the per-function sha vectors in .handoff/b59-vectors.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js.
//
// RED on HEAD 7ab2149 / frozen 4b30d795 (rows 1, 2, 3, 4, 8):
//   1 X2 cycle (live 2nd effect after CycleError), 2 body throw via sync scheduler, 3 scheduler throws / non-function /
//   run-then-throw, 4 1000-cycle retention, 8 throw null (no-scheduler AND sync-scheduler).
// GREEN on both (controls / pins): row 6 controls, and row 7 (A1 hoist): the stranger-in-freed-slot row is only
//   killed by the mutant "task 2 without task 3" (the try/catch added but `const birthGen = node.gen` NOT hoisted),
//   never by HEAD, which has no catch around the scheduler.
//   9 (reviewer b60) no-throw self-dispose: stale handle must not dispose a slot-reuser. RED on the frozen engine
//   (birthGen captured after the first run), GREEN on the fixed one.
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

const mk = () => createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
const syncSched = (run) => run();
// Capture whatever is thrown, including null / undefined (a bare catch(e) cannot tell "no throw" from `throw null`).
function attempt(fn) {
    try { return { threw: false, val: undefined, ret: fn() }; } catch (e) { return { threw: true, val: e, ret: undefined }; }
}
const boom = new Error('boom');

describe('59: sync-scheduler creation throw disposes the effect', () => {
    // ASSERTION 1: X2 shape (b57 q1-creation-cycle.mjs), A first, then B with scheduler run=>run().
    it('1 X2 cycle: CycleError at creation leaves no live second effect', () => {
        const r = mk();
        const a = r.signal(0), b = r.signal(0);
        let e2 = 0;
        r.effect(() => { const v = a(); if (v < 500) b.set(v + 1); });
        const res = attempt(() => r.effect(() => { e2++; const v = b(); if (v < 500) a.set(v + 1); }, { scheduler: syncSched }));
        assert.equal(res.threw, true, 'effect() must throw');
        assert.match(String(res.val && res.val.message), /CycleError: flush passes exceeded/);
        const before = e2;
        b.set(1000);
        assert.equal(e2 - before, 0, 'disposed effect B must not run on an outside write');
        assert.equal(r.stats().effects, 1, 'only A is left');
        r.destroy();
    });

    // ASSERTION 2: body throws via sync scheduler.
    it('2 body throw via sync scheduler: rethrown, effect disposed, links released', () => {
        const r = mk();
        const dep = r.signal(0);
        const base = r.stats();
        let runs = 0;
        const res = attempt(() => r.effect(() => { runs++; dep(); throw boom; }, { scheduler: syncSched }));
        assert.equal(res.threw, true);
        assert.equal(res.val, boom);
        const st = r.stats();
        assert.equal(st.effects, 0);
        assert.equal(st.activeLinks, base.activeLinks);
        assert.equal(r.hasObservers(dep), false);
        const before = runs;
        dep.set(1);
        assert.equal(runs - before, 0, 'dep write adds 0 runs');
        r.destroy();
    });

    // ASSERTION 3: scheduler-itself throw, non-function scheduler, run-then-throw.
    describe('3 scheduler-side throws', () => {
        const cases = [
            ['scheduler throws boom', () => ({ scheduler: () => { throw boom; } }), (e) => assert.equal(e, boom), 0],
            ['truthy non-function scheduler (1) -> TypeError', () => ({ scheduler: 1 }), (e) => assert.ok(e instanceof TypeError), 0],
            ['run() then throw boom (body ran once)', null, (e) => assert.equal(e, boom), 1],
        ];
        for (const [label, optsFn, check, bodyRuns] of cases) {
            it(label, () => {
                const r = mk();
                const dep = r.signal(0);
                const base = r.stats();
                let runs = 0;
                const opts = optsFn !== null ? optsFn() : { scheduler: (run) => { run(); throw boom; } };
                const res = attempt(() => r.effect(() => { runs++; dep(); }, opts));
                assert.equal(res.threw, true);
                check(res.val);
                assert.equal(runs, bodyRuns);
                const st = r.stats();
                assert.equal(st.effects, 0);
                assert.equal(st.activeNodes, base.activeNodes);
                assert.equal(st.activeLinks, base.activeLinks);
                assert.equal(r.hasObservers(dep), false);
                r.destroy();
            });
        }
    });

    // ASSERTION 4: retention -- 1000 cycles of row 2 on ONE registry (HEAD: effects 1000).
    it('4 retention: 1000 failed creations leave nothing behind', () => {
        const r = mk();
        const dep = r.signal(0);
        const base = r.stats();
        for (let i = 0; i < 1000; i++) {
            const res = attempt(() => r.effect(() => { dep(); throw boom; }, { scheduler: syncSched }));
            assert.equal(res.val, boom);
        }
        const st = r.stats();
        assert.equal(st.effects, 0);
        assert.equal(st.activeNodes, base.activeNodes);
        assert.equal(st.activeLinks, base.activeLinks);
        r.destroy();
    });

    // ASSERTION 5 (torture 0 B/op gc 0/0; hot-body sha256 identical to HEAD) is not a unit test: see
    // torture.mjs and .handoff/b59-vectors/hot-bodies.json.

    // ASSERTION 6: controls (green on HEAD and on the fix).
    describe('6 controls', () => {
        it('no-scheduler first-run throw is disposed', () => {
            const r = mk();
            const dep = r.signal(0);
            const res = attempt(() => r.effect(() => { dep(); throw boom; }));
            assert.equal(res.val, boom);
            assert.equal(r.stats().effects, 0);
            assert.equal(r.hasObservers(dep), false);
            r.destroy();
        });
        it('array-queue scheduler: function handle, effects 1; after a deferred throw a write re-schedules', () => {
            const r = mk();
            const dep = r.signal(0);
            const q = [];
            const h = r.effect(() => { if (dep() === 1) throw boom; }, { scheduler: (run) => { q.push(run); } });
            assert.equal(typeof h, 'function');
            assert.equal(r.stats().effects, 1);
            assert.equal(q.length, 1);
            q.shift()();                       // deferred first run: no throw
            dep.set(1);
            assert.equal(q.length, 1, 'write schedules once');
            assert.throws(() => q.shift()(), (e) => e === boom);   // deferred run throws
            dep.set(2);
            assert.equal(q.length, 1, 'effect still subscribed: the next write re-schedules');
            assert.equal(r.stats().effects, 1);
            r.destroy();
        });
        it('queueMicrotask scheduler: function handle, effects 1', () => {
            const r = mk();
            const dep = r.signal(0);
            const h = r.effect(() => { dep(); }, { scheduler: (run) => queueMicrotask(run) });
            assert.equal(typeof h, 'function');
            assert.equal(r.stats().effects, 1);
            r.destroy();
        });
        it('sync scheduler, no throw: live, 1 re-run per write', () => {
            const r = mk();
            const dep = r.signal(0);
            let runs = 0;
            const h = r.effect(() => { runs++; dep(); }, { scheduler: syncSched });
            assert.equal(typeof h, 'function');
            assert.equal(runs, 1);
            dep.set(1); assert.equal(runs, 2);
            dep.set(2); assert.equal(runs, 3);
            assert.equal(r.stats().effects, 1);
            r.destroy();
        });
        it('swallowing scheduler: handle returned, effect live', () => {
            const r = mk();
            const dep = r.signal(0);
            let runs = 0, first = true;
            const h = r.effect(() => { runs++; dep(); if (first) { first = false; throw boom; } },
                { scheduler: (run) => { try { run(); } catch (e) { /* swallowed */ } } });
            assert.equal(typeof h, 'function');
            assert.equal(r.stats().effects, 1);
            dep.set(1);
            assert.equal(runs, 2, 'live effect re-runs');
            r.destroy();
        });
    });

    // ASSERTION 7 (A1): the self-disposed effect's slot is reused by a stranger BEFORE the scheduler throws; the
    // dispose-then-rethrow tail must not kill the stranger (needs `birthGen` hoisted above the first run).
    // Must-fail mutant: the try/catch without the hoist. HEAD passes (no catch). Not vacuous: the pointer equality
    // of the stranger and the self-disposed effect's slot is asserted first.
    it('7 stranger in the freed slot survives the creation-throw dispose', () => {
        const r = mk();
        let ownerDesc = null, s = null, sameSlot = null, idDiffers = null;
        const res = attempt(() => r.effect(() => {
            ownerDesc = r.getOwner();
            r.dispose(ownerDesc);                     // self-dispose inside the first run
        }, {
            scheduler: (run) => {
                run();
                // The self-disposed effect was COMPUTING, so its slot is PINNED (Signal.js disposeNode: pinnedHead), not on
                // the free list. Free-list size = population - activeNodes - 1 pinned slot. Exhaust exactly that, so the
                // next allocation misses and nodeMiss releases the pinned slot (cursorDepth 0 after run()).
                const st = r.stats();
                let free = st.nodePoolPopulation - st.activeNodes - 1;
                while (free-- > 0) r.signal(-1);
                s = r.signal(7);
                // same slot: the node pointer (the one object-valued symbol on a handle) is identical
                const sym = Object.getOwnPropertySymbols(ownerDesc).find((k) => typeof ownerDesc[k] === 'object' && ownerDesc[k] !== null);
                sameSlot = sym !== undefined && s[sym] === ownerDesc[sym];
                idDiffers = r.nodeId(ownerDesc) === undefined;   // stale descriptor no longer resolves
                throw boom;
            },
        }));
        assert.equal(sameSlot, true, 'precondition: the stranger must land in the self-disposed effect slot');
        assert.equal(idDiffers, true);
        assert.equal(res.threw, true);
        assert.equal(res.val, boom);
        assert.equal(s(), 7, 'stranger survives');
        s.set(8);
        assert.equal(s(), 8);
        assert.equal(s.peek(), 8);
        r.destroy();
    });

    // ROW 9 (reviewer b60): an effect that disposes itself in its first run, NO throw. A new node lands in its freed
    // slot; the returned handle (called, or passed to dispose) must not destroy that node (needs birthGen hoisted).
    // Oracle: spec statement "that handle is stale: calling it or dispose(h) is a no-op". Expected s() === 8, signals unchanged.
    describe('9 no-throw self-dispose: stale handle must not dispose a slot-reuser', () => {
        for (const sched of ['no scheduler', 'sync scheduler']) {
            for (const via of ['call', 'dispose']) {
                it(sched + ', via ' + via, () => {
                    const r = mk();
                    let own = null;
                    const opts = sched === 'sync scheduler' ? { scheduler: syncSched } : undefined;
                    const h = r.effect(() => { own = r.getOwner(); r.dispose(own); }, opts);
                    const st = r.stats();
                    let free = st.nodePoolPopulation - st.activeNodes - 1;   // pinned slot is not on the free list
                    while (free-- > 0) r.signal(-1);
                    const s = r.signal(7);
                    const sym = Object.getOwnPropertySymbols(own).find((k) => typeof own[k] === 'object' && own[k] !== null);
                    assert.equal(sym !== undefined && s[sym] === own[sym], true, 'precondition: s took the effect slot');
                    const signals = r.stats().signals;
                    if (via === 'call') h(); else r.dispose(h);
                    s.set(8);
                    assert.equal(s(), 8, 'slot-reuser survives the stale handle');
                    assert.equal(r.stats().signals, signals);
                    r.destroy();
                });
            }
        }
    });

    // ASSERTION 8 (A2): `throw null` is rethrown (HEAD: swallowed + handle returned without a scheduler; rethrown but left live through a sync one), effect disposed.
    describe('8 throw null', () => {
        it('no-scheduler path', () => {
            const r = mk();
            const dep = r.signal(0);
            const res = attempt(() => r.effect(() => { dep(); throw null; }));
            assert.equal(res.threw, true, 'effect() must throw');
            assert.equal(res.val, null);
            assert.equal(r.stats().effects, 0);
            assert.equal(r.hasObservers(dep), false);
            r.destroy();
        });
        it('sync-scheduler path', () => {
            const r = mk();
            const dep = r.signal(0);
            const res = attempt(() => r.effect(() => { dep(); throw null; }, { scheduler: syncSched }));
            assert.equal(res.threw, true, 'effect() must throw');
            assert.equal(res.val, null);
            assert.equal(r.stats().effects, 0);
            assert.equal(r.hasObservers(dep), false);
            r.destroy();
        });
        // `throw undefined`: a sentinel (res.threw) tells "threw undefined" from "did not throw".
        it('throw undefined, no-scheduler path', () => {
            const r = mk();
            const dep = r.signal(0);
            const res = attempt(() => r.effect(() => { dep(); throw undefined; }));
            assert.equal(res.threw, true, 'effect() must throw');
            assert.equal(res.val, undefined);
            assert.equal(r.stats().effects, 0);
            r.destroy();
        });
        it('throw undefined, sync-scheduler path', () => {
            const r = mk();
            const dep = r.signal(0);
            const res = attempt(() => r.effect(() => { dep(); throw undefined; }, { scheduler: syncSched }));
            assert.equal(res.threw, true, 'effect() must throw');
            assert.equal(res.val, undefined);
            assert.equal(r.stats().effects, 0);
            r.destroy();
        });
    });
});
