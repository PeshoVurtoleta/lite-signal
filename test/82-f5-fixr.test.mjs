// 82-f5-fixr.test.mjs -- A3 FIX-R (DIV-F5 / LEDGER #36), burst 107/108 batch B2.
// F5: a pre-batch revert (set(x); ...; set(back)) must not restore the old version when a body (computed / effect
// recompute) ran between the capture and the revert -- that body saw the intermediate value. The fix counts body runs
// (evalCount, masked to 30 bits, bumped first in fireRecompute) and stores it per node at the capture (preBatchEvals).
// INDEPENDENT ORACLE: PLAN-A3 ASSERTIONS A1-A4 + ADDENDUM 1-3 (D-3, D-4, D-5, Q3). Expected values are derived from the
// semantics (what a reader of s at batch close must see), never from a kernel run.
// Rows (each A1 / A2 row runs on signal() AND on signalBox()/computedBox(); the box rows are the red-first boxSet rows):
//   R1 R2 R3 R4 R5 R6b + SRC-PIN + 8BIT (N=255 / 257 / 256 / 512 + control) = REGRESSION F5 (red on the 0628127b build).
//   G1 G2 G3 G4, GC rows, RETENTION rows = pins (green before and after); GC / retention carry must-fail controls.
// 8-BIT ROW: derives a scratch kernel from the source under test with the bump mask narrowed to 0xff; pins the KNOWN
//   30-bit mask boundary (a revert slips only after exactly k * 2^width body runs between capture and revert; falls back
//   to the pre-fix F5 behaviour). On a build without the masked bump it fails closed (the derive step throws).
// Kernel: LITE_SIGNAL_KERNEL (absolute path), default ../Signal.js. GC / retention rows need --expose-gc (else SKIP);
//   the GC lane runs --expose-gc --max-semi-space-size=4.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
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

    // R6b (replaces R6, see B0-REPORT): the op-5 hook throws once during c's recompute inside the batch. A DIRECT effect E
    // on s must be re-run by the revert (the throwing recompute still counts as an observation: the bump precedes the
    // hook) -> E log [1, 1]. Before: [1]. Red when the bump follows the hook call (M7).
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

// ---- A5 source pin + D-4 8-bit boundary row ---------------------------------
const BUMP = 'evalCount = (evalCount + 1) & 0x3fffffff';
const SRC = readFileSync(KPATH, 'utf8');

describe('A5 SRC-PIN REGRESSION: the 30-bit mask on the bump is pinned', () => {
    it('fireRecompute holds exactly one masked bump, as its first statement; no other evalCount assignment', () => {
        // every write form to evalCount, excluding the `let` declaration
        const writes = SRC.match(/(?<!let\s)\bevalCount\s*(?:=(?!=)|\+\+|--|\+=|-=|\|=|&=|\^=|<<=|>>=)|(?:\+\+|--)\s*evalCount\b/g) || [];
        assert.equal(writes.length, 1, 'exactly one write to evalCount besides the let: ' + JSON.stringify(writes));
        assert.equal(SRC.split(BUMP).length - 1, 1, 'exactly one `' + BUMP + '`');
        assert.equal(SRC.split(/\blet evalCount = 0\b/).length - 1, 1, 'exactly one `let evalCount = 0`');
        const f = SRC.indexOf('function fireRecompute(');
        const b = SRC.indexOf(BUMP);
        assert.ok(f >= 0, 'fireRecompute exists');
        assert.ok(b > f, 'the bump is inside/after fireRecompute');
        const between = SRC.slice(f, b);
        assert.ok(!/function\s/.test(between.slice(8)) && !/[};]/.test(between), 'the bump is the first statement of fireRecompute (before the op-5 hook)');
    });
});

let derived = null, deriveErr = null;
function deriveKernel(width) {
    if (!isAbsolute(KPATH)) throw new Error('kernel path must be absolute: ' + KPATH);
    // Relative specifiers: only the sibling './Watch.js' is allowed (copied next to the scratch kernel); any other fails closed.
    const rel = SRC.match(/(?:from|import)\s*\(?\s*['"]\.{1,2}\/[^'"]*['"]/g) || [];
    for (const m of rel) if (!/['"]\.\/Watch\.js['"]/.test(m)) throw new Error('kernel has an unexpected relative import ' + m + ' (fail closed)');
    const n = SRC.split(BUMP).length - 1;
    if (n !== 1) throw new Error('expected exactly one `' + BUMP + '` in the kernel, found ' + n + ' (fail closed)');
    const out = SRC.split(BUMP).join('evalCount = (evalCount + 1) & ' + width);
    const a = SRC.split('\n'), b = out.split('\n');
    assert.equal(a.length, b.length, 'line count unchanged');
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    assert.equal(diff, 1, 'derived source differs in exactly one line');
    const dir = mkdtempSync(join(tmpdir(), 'lite-signal-fixr8-'));
    writeFileSync(join(dir, 'Signal.js'), out);
    if (rel.length > 0) writeFileSync(join(dir, 'Watch.js'), readFileSync(join(dirname(KPATH), 'Watch.js')));
    return pathToFileURL(join(dir, 'Signal.js')).href;
}
try { derived = deriveKernel('0xff'); } catch (e) { deriveErr = e; }

// World (D-4): s=1, c=s*10, effect E on c; batch{ s.set(2); c(); N-1 runs of u; s.set(1) } -> exactly N body runs between
// the capture of s (at s.set(2)) and its revert. 8-bit counter: equal after N = 256 / 512 (revert slips = pre-fix F5,
// c() === 20); N = 255 / 257 differ (blocked, c() === 10).
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
describe('D-4 8BIT REGRESSION: the mask boundary on a reduced-width (0xff) scratch kernel', () => {
    const cases = [[255, 10], [257, 10], [256, 20], [512, 20]];
    for (const [N, want] of cases) {
        it('N=' + N + ': c() === ' + want + (want === 10 ? ' (blocked)' : ' (KNOWN slip at k*2^8 runs = pre-fix F5)'), async () => {
            if (deriveErr) throw deriveErr;
            const mod = await import(derived);
            assert.equal(await ninetyN(mod.createRegistry, N), want);
        });
    }
    it('CONTROL REGRESSION: the real kernel at N=256 -> c() === 10 (30-bit mask blocks)', async () => {
        assert.equal(await ninetyN(createRegistry, 256), 10);
    });
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
