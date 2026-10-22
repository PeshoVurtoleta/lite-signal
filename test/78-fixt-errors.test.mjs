// 78-fixt-errors.test.mjs -- A2 FIX-T (burst 101, batch B3): independent-oracle rows A1-A7 from
// .handoff/PLAN-0s-fixt.md ASSERTIONS + ADDENDUM (D1 cap CycleError cached; D2 #42 guard throws CycleError;
// D4 leaving an error is always a change, custom equals not called; A6 sized 1800 from fresh-process one-shot limits, ADDENDUM 10.2;
// A6b pins frames per cold level == 3; A1-A3 are live rows; A7 settles the GC window). Expected values come from the
// plan, never from running the implementation. LS_SIG=<path> runs the rows against another Signal.js build.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { measureAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

const SIG = process.env.LS_SIG ? pathToFileURL(process.env.LS_SIG).href : new URL('../Signal.js', import.meta.url).href;
const { createRegistry } = await import(SIG);
const HAVE_GC = typeof globalThis.gc === 'function';
const X = new Error('boom');

function tryRead(fn) { try { return { v: fn() }; } catch (e) { return { e }; } }

describe('A1 computed/effect catching a dep error (FIX-T D-H)', () => {
    it('A1 case 1: dep starts throwing after first eval; catching computed B reads "fallback" twice, B runs 2', () => {
        const r = createRegistry();
        const s = r.signal(false);
        const A = r.computed(() => { if (s()) throw X; return 1; });
        let bRuns = 0;
        const B = r.computed(() => { bRuns++; try { return A(); } catch { return 'fallback'; } });
        assert.equal(B(), 1);
        s.set(true);
        assert.equal(B(), 'fallback', 'after dep throws');
        assert.equal(B(), 'fallback', 'read again');
        assert.equal(bRuns, 2, 'B body ran exactly twice (first eval + one re-eval)');
    });

    it('A1 case 3: effect catching the computed error sees [1, "caught X"]; flush does not throw', () => {
        const r = createRegistry();
        const s = r.signal(false);
        const A = r.computed(() => { if (s()) throw X; return 1; });
        const seen = [];
        r.effect(() => { try { seen.push(A()); } catch (e) { seen.push(e === X ? 'caught X' : 'caught other'); } });
        assert.doesNotThrow(() => s.set(true));
        assert.deepEqual(seen, [1, 'caught X']);
    });

    it('A1 case 4: non-catching chain: A runs 2, C runs 2, all 3 reads throw X (same object)', () => {
        const r = createRegistry();
        const s = r.signal(false);
        let aRuns = 0, cRuns = 0;
        const A = r.computed(() => { aRuns++; if (s()) throw X; return 1; });
        const B = r.computed(() => A() + 1);
        const C = r.computed(() => { cRuns++; return B() + 1; });
        assert.equal(C(), 3);
        s.set(true);
        for (let i = 0; i < 3; i++) {
            const t = tryRead(() => C());
            assert.ok('e' in t, 'read ' + i + ' throws');
            assert.equal(t.e, X, 'read ' + i + ' throws the same object');
        }
        assert.equal(aRuns, 2, 'A runs 2');
        assert.equal(cRuns, 2, 'C runs 2');
    });
});

describe('A2 leaving an error is always a change (D-K, D4)', () => {
    function build(r, withEquals, counter) {
        const strict = r.signal(true);
        const opts = withEquals ? { equals: () => { counter.n++; return true; } } : undefined;
        const A = r.computed(() => { if (strict()) throw X; return X; }, opts);
        let bRuns = 0;
        const B = r.computed(() => { bRuns++; try { return A() === X ? 'value X' : 'other'; } catch { return 'caught'; } });
        const seen = [];
        r.effect(() => { try { seen.push('eff value ' + (A() === X)); } catch { seen.push('eff caught'); } });
        return { strict, A, B, seen, bRuns: () => bRuns };
    }
    for (const withEquals of [false, true]) {
        it('A2 err2val' + (withEquals ? ' with custom equals -> true (equals NOT called when leaving an error)' : ''), () => {
            const r = createRegistry();
            const counter = { n: 0 };
            const w = build(r, withEquals, counter);
            assert.equal(w.B(), 'caught');
            assert.equal(w.bRuns(), 1);
            assert.deepEqual(w.seen, ['eff caught']);
            const callsBefore = counter.n;
            w.strict.set(false);
            assert.equal(w.B(), 'value X', 'B leaves "caught"');
            assert.equal(w.bRuns(), 2, 'bRuns 1 -> 2');
            assert.equal(w.seen.length, 2, 'effect log +1 entry exactly');
            assert.deepEqual(w.seen, ['eff caught', 'eff value true']);
            assert.equal(counter.n, callsBefore, 'custom equals not called on the error -> value transition');
        });
    }
});

describe('A3 #42 cycle guard throws CycleError (D2)', () => {
    it('A3 P0c: live C() after s.set(1) throws CycleError "Circular dependency detected.", not RangeError', () => {
        const r = createRegistry();
        const s = r.signal(0);
        let D;
        const C = r.computed(() => { try { D(); } catch { /* swallow: builds the C <-> D cycle */ } return s(); });
        D = r.computed(() => C());
        assert.equal(C(), 0);
        s.set(1);
        const t = tryRead(() => C());
        assert.ok('e' in t, 'C() throws');
        assert.ok(!(t.e instanceof RangeError), 'not a RangeError: ' + String(t.e).slice(0, 60));
        assert.match(String(t.e && t.e.message), /^CycleError: Circular dependency detected\./);
    });
    // LEDGER #42 residual (ADDENDUM 2 / 11 B3): the guard fires at depth > nodePool.length, so an eager pool above the
    // pre-walk stack limit overflows before the guard. Flips to CycleError if the guard ever bounds by the stack.
    it('KNOWN #42 residual: eager maxNodes 16384, the A3 P0c cycle still throws RangeError (guard bound is the pool)', () => {
        const r = createRegistry({ maxNodes: 16384 });
        const s = r.signal(0);
        let D;
        const C = r.computed(() => { try { D(); } catch { /* swallow: builds the C <-> D cycle */ } return s(); });
        D = r.computed(() => C());
        assert.equal(C(), 0);
        s.set(1);
        const t = tryRead(() => C());
        assert.ok('e' in t, 'C() throws');
        assert.ok(t.e instanceof RangeError, 'RangeError (stack overflows before depth > 16384): ' + String(t.e).slice(0, 60));
    });
});

describe('D1(b) the cap CycleError carries a version (ADDENDUM 11 B2)', () => {
    // X writes x from a foreign owner while go is true, so every re-pull re-invalidates it; past maxFlushPasses (8) the
    // cap branch caches CycleError as X's own error with version = globalVersion. X's value 'K' never changes, so the
    // version stamp is what makes Z re-run (zRuns 2) into X's cached error and rethrow the SAME object.
    it('D1(b): X() throws the cap CycleError; Z() rethrows the same object; zRuns 2', () => {
        const r = createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow', maxFlushPasses: 8 });
        const x = r.signal(0), go = r.signal(false);
        const X = r.computed(() => { const v = x(); if (go()) r.runWithOwner(undefined, () => x.set(v + 1)); return 'K'; });
        let zRuns = 0;
        const Z = r.computed(() => { zRuns++; return X() + '!'; });
        assert.equal(Z(), 'K!');
        go.set(true);
        const tx = tryRead(() => X());
        const tz = tryRead(() => Z());
        assert.ok('e' in tx, 'X() throws');
        assert.match(String(tx.e && tx.e.message), /^CycleError: computed keeps invalidating/);
        assert.ok('e' in tz, 'Z() throws');
        assert.equal(tz.e, tx.e, 'Z() rethrows the same object');
        assert.equal(zRuns, 2, 'zRuns 2');
    });
});

describe('A4 fail closed: an errored computed always throws the SAME object', () => {
    function errored() {
        const r = createRegistry();
        const s = r.signal(false);
        const c = r.computed(() => { if (s()) throw X; return 1; });
        const bc = r.computedBox(() => { if (s()) throw X; return 1; });
        c(); bc.get();
        s.set(true);
        return { r, c, bc };
    }
    const same = (fn, label) => { const t = tryRead(fn); assert.ok('e' in t, label + ' throws'); assert.equal(t.e, X, label + ' same object'); };
    it('A4 read / peek / box get / box peek (twice each: cached)', () => {
        const { c, bc } = errored();
        for (let i = 0; i < 2; i++) {
            same(() => c(), 'read'); same(() => c.peek(), 'peek');
            same(() => bc.get(), 'box get'); same(() => bc.peek(), 'box peek');
        }
    });
    it('A4 inside untrack and inside batch', () => {
        const { r, c, bc } = errored();
        same(() => r.untrack(() => c()), 'untrack read');
        same(() => r.untrack(() => bc.get()), 'untrack box get');
        same(() => r.batch(() => c()), 'batch read');
        same(() => r.batch(() => bc.peek()), 'batch box peek');
    });
});

describe('A5 gen hazard: a dep body disposes the parent during its pre-walk', () => {
    // Reaches the hazard: with maxNodes 8, D's re-run (inside the parent's pre-walk) disposes the parent and the next
    // computed Q takes the freed slot -- the slot IS reused. r.nodeId is a monotonic counter, not the slot index, so
    // Q's id never equals the parent's; the gen snapshot is what tells them apart. Q throws Y, so the recycled slot
    // holds HAS_ERROR(Y): a reader that skips the gen check rethrows Y. One row per reader: P() (the read closure),
    // P.peek(), Pb.get(), Pb.peek() (pullComputed).
    // closureBirthGen mutant (b102 NIT, `const g = node.gen` -> `const g = birthGen` in the read closure): EQUIVALENT
    // since LEDGER #44 (b104, PLAN-44 D1) -- the else arm re-checks `node.gen !== birthGen` after allocateLink, so g equals
    // birthGen whenever the refresh block is reached. It survives these rows by design; on b104-before it is killed by
    // test/79's A1 computed rows.
    for (const via of ['read', 'peek', 'box get', 'box peek']) {
        it('A5 ' + via + ': slot reused by a computed that throws Y: the read returns undefined, never throws Y', () => {
            const Y = new Error('Y');
            const r = createRegistry({ maxNodes: 8 });
            const s = r.signal(0);
            const box = via.startsWith('box');
            let P, Pb, Q = null;
            const D = r.computed(() => {
                const v = s();
                if (v === 1) {
                    r.dispose(box ? Pb : P);
                    Q = r.computed(() => { throw Y; });
                    try { Q(); } catch { /* Q now holds HAS_ERROR(Y) in the recycled slot */ }
                }
                return v;
            });
            if (box) { Pb = r.computedBox(() => D() + 1); assert.equal(Pb.get(), 1); }
            else { P = r.computed(() => D() + 1); assert.equal(P(), 1); }
            s.set(1);
            const read = via === 'read' ? () => P() : via === 'peek' ? () => P.peek() : via === 'box get' ? () => Pb.get() : () => Pb.peek();
            const t = tryRead(read);
            assert.ok(Q !== null, 'D re-ran and created Q');
            assert.ok(!('e' in t) || t.e !== Y, 'must never throw Y');
            assert.ok(!('e' in t), 'does not throw at all: ' + (t.e && String(t.e)));
            assert.equal(t.v, undefined);
        });
    }
});

describe('A6 deep acyclic chain does not trip the #42 guard or the stack', () => {
    // N = 1800: below the fresh-process one-shot recursion limits measured in .handoff/b102-evidence/B1fix/a6-oneshot.txt
    // (node v26.8.2: live ~1984, b102-before ~1654, b101-before ~2120); 1800 passes live and b101, fails b102-before.
    // The warmed bisection over-reads the limit by ~400, so the one-shot numbers are the source (ADDENDUM 10.2).
    it('A6 chain of 1800 computeds (grow): leaf write + read throws nothing', () => {
        const r = createRegistry({ onCapacityExceeded: 'grow' });
        const s = r.signal(0);
        let prev = r.computed(() => s());
        const N = 1800;
        for (let i = 1; i < N; i++) { const p = prev; prev = r.computed(() => p() + 1); }
        assert.equal(prev(), N - 1);
        s.set(5);
        assert.equal(prev(), 5 + N - 1);
    });
    // A6b: deterministic tooth. Spec: a cold read costs exactly 3 stack frames per computed level (ADDENDUM 10.2);
    // the b102 wrapper-without-inline build costs 4.
    it('A6b cold read costs exactly 3 frames per computed level', () => {
        const prevLimit = Error.stackTraceLimit;
        let stack = '';
        try {
            Error.stackTraceLimit = 50;
            const r = createRegistry();
            const s = r.signal(1);
            const c0 = r.computed(function lvl0() { try { throw new Error('probe'); } catch (e) { stack = e.stack; } return s(); });
            const c1 = r.computed(function lvl1() { return c0() + 1; });
            const c2 = r.computed(function lvl2() { return c1() + 1; });
            c2();
        } finally {
            Error.stackTraceLimit = prevLimit;
        }
        const lines = stack.split('\n').slice(1).map((l) => l.trim());
        const idx = (n) => lines.findIndex((l) => new RegExp('^at (\\S+\\.)?' + n + ' ').test(l));
        const i0 = idx('lvl0'), i1 = idx('lvl1'), i2 = idx('lvl2');
        assert.ok(i0 >= 0 && i1 > i0 && i2 > i1, 'frames found: ' + [i0, i1, i2]);
        assert.equal(i1 - i0, 3, 'lvl1 - lvl0');
        assert.equal(i2 - i1, 3, 'lvl2 - lvl1');
    });
});

describe('A7 GC', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    it('A7 1e6 cached-error reads: 0 B/op, maxMajor 0', async () => {
        const r = createRegistry();
        const s = r.signal(false);
        const c = r.computed(() => { if (s()) throw X; return 1; });
        c(); s.set(true);
        try { c(); } catch { /* first read caches the error */ }
        const step = () => { try { c(); } catch (e) { if (e !== X) throw e; } };
        for (let i = 0; i < 50000; i++) step();
        globalThis.gc();
        // B/op: measureAllocs forces gc() between batches, so it runs OUTSIDE the GC window. 1e6 reads: a one-off
        // ~8-11 KB event would cross 0.05 B/op at 1e5 (ADDENDUM 10.4).
        const m = measureAllocs(step, { iterations: 1000000, batches: 4, warmup: 20000 });
        assert.notEqual(m.bytesPerCall, null, 'unmeasured is not zero');
        assert.ok(m.bytesPerCall <= 0.05, 'B/op ' + m.bytesPerCall);
        globalThis.gc();
        await new Promise((res) => setTimeout(res, 50));
        // GC window: plain steps, no forced gc inside; settle before summary() because GC entries arrive late.
        const gcp = new GcProfiler().start();
        for (let i = 0; i < 100000; i++) step();
        await new Promise((res) => setTimeout(res, 50));
        const sum = gcp.summary(); gcp.stop();
        assert.equal(sum.gc.major, 0, 'maxMajor 0');
    });
    it('A7 1e4 dirty re-walks of the case-4 chain: 0 B/op', () => {
        const r = createRegistry();
        const s = r.signal(0);
        const A = r.computed(() => { if (s() < 0) throw X; return 1; });
        const B = r.computed(() => A() + 1);
        const C = r.computed(() => B() + 1);
        C();
        let k = 0;
        const step = () => { s.set(-1 - (k++ & 1023)); try { C(); } catch (e) { if (e !== X) throw e; } };
        for (let i = 0; i < 20000; i++) step();
        globalThis.gc();
        const m = measureAllocs(step, { iterations: 10000, batches: 4, warmup: 5000 });
        assert.notEqual(m.bytesPerCall, null, 'unmeasured is not zero');
        assert.ok(m.bytesPerCall <= 0.05, 'B/op ' + m.bytesPerCall);
    });
    it('A7 1000 create / error / catch / dispose cycles -> tracker.size() 0', async () => {
        const r = createRegistry();
        const tracker = createLeakTracker({ name: 't78', onLeak() {}, onWarning() {} });
        const settle = async () => { globalThis.gc(); await new Promise((res) => setTimeout(res, 0)); globalThis.gc(); };
        const cycle = (i) => {
            const obj = { i };
            tracker.track(obj, null, i);
            const c = r.computed(() => { void obj; throw X; });
            try { c(); } catch (e) { if (e !== X) throw e; }
            r.dispose(c);
        };
        for (let i = 0; i < 1000; i++) cycle(i);
        await settle(); await settle();
        assert.equal(tracker.size(), 0);
    });
});
