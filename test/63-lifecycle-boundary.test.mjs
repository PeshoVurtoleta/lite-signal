// test/63-lifecycle-boundary.test.mjs -- burst 63 port of the b62 qa boundary probes (LEDGER #40), beyond test/62.
// Oracle: .handoff/PLAN-0v.md ASSERTIONS A1-A8 semantics (no expected value comes from a kernel run).
// White-box: every lane loads a scratch copy of the kernel with `lifecycleCount` injected into stats() (LC_ANCHOR,
// test/60 O5 / test/62 A7), optionally with the counter's START value rewritten (wrap crossing).
// No lane needs --expose-gc (the file has no gc dependency), so plain `npm test` runs all of it; nothing is skipped.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js. node:test only, no deps.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const LC_ANCHOR = '    function stats() {\n        return {\n';
const LC_DECL = '    let lifecycleCount = 0 | 0;\n';
const SRC = readFileSync(KPATH, 'utf8');
const dirs = [];
async function load(start) {
    assert.equal(SRC.split(LC_ANCHOR).length, 2, 'stats() anchor must occur exactly once');
    assert.equal(SRC.split(LC_DECL).length, 2, 'lifecycleCount decl must occur exactly once');
    let s = SRC.replace(LC_ANCHOR, () => LC_ANCHOR + '            lifecycleCount: lifecycleCount,\n');
    if (start !== undefined) s = s.replace(LC_DECL, () => '    let lifecycleCount = (' + start + ') | 0;\n');
    const dir = mkdtempSync(join(tmpdir(), 'lite63-')); dirs.push(dir);
    writeFileSync(join(dir, 'Signal.js'), s);
    copyFileSync(join(dirname(KPATH), 'Watch.js'), join(dir, 'Watch.js'));
    return import(join(dir, 'Signal.js') + '?s=' + String(start));
}
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const K = await load();

test('kernel under test', (t) => {
    t.diagnostic('kernel ' + KPATH + ' sha256 ' + createHash('sha256').update(SRC).digest('hex'));
});

const mk = (W = K, o) => W.createRegistry(o ?? { maxNodes: 256, onCapacityExceeded: 'grow' });
const ptrSym = (h) => Object.getOwnPropertySymbols(h).find((k) => typeof h[k] === 'object' && h[k] !== null);
const genSym = (h) => Object.getOwnPropertySymbols(h).find((k) => typeof h[k] === 'number');
const nodeOf = (h) => h[ptrSym(h)];
const counter = () => { const c = { n: 0, f: () => { c.n++; } }; return c; };
function reuse(r, slot, mkFn = () => r.signal(0)) {
    for (let i = 0; i < 4096; i++) { const s = mkFn(); if (nodeOf(s) === slot) return s; }
    throw new Error('slot never reused (precondition)');
}
function readThenStop(r, s) { const stop = r.effect(() => { s(); }); stop(); }
const lcOf = (r) => () => { const v = r.stats().lifecycleCount; assert.ok(Number.isInteger(v)); return v; };

describe('P1-P2 non-signal handles', () => {
    it('P1 computed handle: hooks fire for it live, are dropped on dispose, lc -> 0', () => {
        const r = mk(); const lc = lcOf(r); const c = counter(), d = counter();
        const cm = r.computed(() => 1); const n = nodeOf(cm);
        r.observeObservers(cm, { onConnect: c.f, onDisconnect: d.f });
        readThenStop(r, cm);
        assert.deepEqual([c.n, d.n, lc()], [1, 1, 1], 'control: live hooks fire on a computed');
        r.dispose(cm);
        assert.equal(lc(), 0);
        readThenStop(r, reuse(r, n));
        assert.deepEqual([c.n, d.n], [1, 1], 'stale computed hooks reached a signal resident');
        r.destroy();
    });
    it('P2 effect handle: registration accepted, stop() drops it, lc -> 0, resident clean', () => {
        const r = mk(); const lc = lcOf(r); const c = counter(), d = counter();
        const stop = r.effect(() => {}); const n = nodeOf(stop);
        r.observeObservers(stop, { onConnect: c.f, onDisconnect: d.f });
        assert.equal(lc(), 1);
        stop(); stop();
        assert.equal(lc(), 0, 'effect stop() (twice) must drop the entry exactly once');
        readThenStop(r, reuse(r, n));
        assert.equal(c.n + d.n, 0);
        r.destroy();
    });
});

describe('P3-P4 registration multiplicity / reuse', () => {
    it('P3 register twice on one node, dispose: one entry, lc 1 -> 0, both offs no-ops', () => {
        const r = mk(); const lc = lcOf(r); const a = counter(), b = counter();
        const s = r.signal(0); const n = nodeOf(s);
        const o1 = r.observeObservers(s, { onConnect: a.f }); const o2 = r.observeObservers(s, { onDisconnect: b.f });
        // A5a (b114): registrations are independent; the second is its own reg on the node's entry (lc still counts NODES -> 1).
        assert.equal(lc(), 1, 'second registration is its own reg on the same node (lc counts nodes)');
        r.dispose(s); assert.equal(lc(), 0);
        const s2 = reuse(r, n); const c2 = counter(); r.observeObservers(s2, { onConnect: c2.f });
        o1(); o2(); o1();
        assert.equal(lc(), 1, 'stale offs must not touch the new resident');
        readThenStop(r, s2);
        assert.deepEqual([a.n, b.n, c2.n], [0, 0, 1]);
        r.destroy();
    });
    it('P4 observe, dispose, reuse, observe, FIRST unobserve; then two more generations of stale offs', () => {
        const r = mk(); const lc = lcOf(r);
        const s1 = r.computed(() => 0); const n = nodeOf(s1);
        const off1 = r.observeObservers(s1, { onConnect: () => {} });
        r.dispose(s1);
        const s2 = reuse(r, n, () => r.computed(() => 0)); const c2 = counter();
        const off2 = r.observeObservers(s2, { onConnect: c2.f });
        off1(); assert.equal(lc(), 1, 'FIRST (stale) unobserve dropped the new resident');
        readThenStop(r, s2); assert.equal(c2.n, 1);
        r.dispose(s2); assert.equal(lc(), 0);
        const s3 = reuse(r, n); const c3 = counter(); const off3 = r.observeObservers(s3, { onConnect: c3.f });
        off1(); off2(); assert.equal(lc(), 1, 'stale offs two generations back');
        readThenStop(r, s3); assert.equal(c3.n, 1);
        off3(); assert.equal(lc(), 0);
        r.destroy();
    });
});

describe('P5-P7 dispose / destroy from inside callbacks', () => {
    it('P5 dispose the node from inside its own onConnect', () => {
        const r = mk(); const lc = lcOf(r); let s = null; let fired = 0;
        s = r.signal(0); const n = nodeOf(s);
        r.observeObservers(s, { onConnect: () => { fired++; r.dispose(s); } });
        const stop = r.effect(() => { s(); }); stop();
        assert.equal(fired, 1); assert.equal(lc(), 0);
        const c = counter(); readThenStop(r, reuse(r, n)); assert.equal(fired, 1, 'stale onConnect re-fired');
        r.destroy(); void c;
    });
    it('P6 dispose the node from inside its own onDisconnect', () => {
        const r = mk(); const lc = lcOf(r); let s = null; let fired = 0;
        s = r.signal(0); const n = nodeOf(s);
        r.observeObservers(s, { onDisconnect: () => { fired++; r.dispose(s); } });
        readThenStop(r, s);
        assert.equal(fired, 1); assert.equal(lc(), 0);
        readThenStop(r, reuse(r, n)); assert.equal(fired, 1);
        r.destroy();
    });
    it('P7 destroy() while an effect is mid-run (registered dep): lc 0 and the registry is usable', (t) => {
        const r = mk(); const lc = lcOf(r); const s = r.signal(0); let outcome = 'returned';
        r.observeObservers(s, { onConnect: () => {} });
        try { r.effect(() => { s(); r.destroy(); s(); }); } catch (e) { outcome = 'threw ' + (e && e.name); }
        t.diagnostic('P7 outcome: ' + outcome);
        assert.equal(lc(), 0, 'destroy mid-run left a lifecycle entry');
        const s2 = r.signal(0); const c = counter(); r.observeObservers(s2, { onConnect: c.f });
        readThenStop(r, s2); assert.equal(c.n, 1); assert.equal(lc(), 1);
        r.destroy(); assert.equal(lc(), 0);
    });
    it('P8 a computed disposing ITSELF mid-run (pinned-slot path) with hooks', () => {
        const r = mk(); const lc = lcOf(r); let cm = null; const c = counter();
        cm = r.computed(() => { r.dispose(cm); return 0; }); const n = nodeOf(cm);
        r.observeObservers(cm, { onConnect: c.f, onDisconnect: c.f });
        assert.equal(lc(), 1);
        cm();
        assert.equal(lc(), 0, 'pinned-path dispose did not drop');
        readThenStop(r, reuse(r, n)); assert.equal(c.n, 0);
        r.destroy();
    });
});

describe('P9-P11 iteration / re-entrancy / duplicates', () => {
    it('P9 dispose-during-iteration: each onDisconnect disposes every other registered dep mid dep-walk', () => {
        const r = mk(); const lc = lcOf(r); const ss = []; let fired = 0;
        const killAll = () => { fired++; for (const x of ss) r.dispose(x); };
        for (let i = 0; i < 5; i++) { const s = r.signal(i); r.observeObservers(s, { onDisconnect: killAll }); ss.push(s); }
        const stop = r.effect(() => { for (const x of ss) x(); });
        assert.equal(lc(), 5);
        stop();
        assert.equal(fired, 1, 'only the first 1->0 fires; the rest were disposed (no disconnect for the dead)');
        assert.equal(lc(), 0); assert.equal(r.stats().activeNodes, 0); assert.equal(r.stats().activeLinks, 0);
        r.destroy();
    });
    it('P10 re-entrant registration + write from inside onConnect, then dispose', () => {
        const r = mk(); const lc = lcOf(r); const c2 = counter(); let s = null, first = 0;
        s = r.signal(0); const n = nodeOf(s);
        r.observeObservers(s, { onConnect: () => { first++; r.observeObservers(s, { onConnect: c2.f }); s.set(first); } });
        readThenStop(r, s);
        assert.equal(lc(), 1); assert.equal(s(), 1);
        // A5a (b114): the reg added inside the first fire is independent and skipped by that fire; cycle 2 fires both (first 2, c2 1; the first reg's second-cycle set(2) makes s() 2).
        readThenStop(r, s); assert.deepEqual([first, c2.n], [2, 1], 're-entrant registration is an independent reg (fires from cycle 2; onConnect not replaced)');
        assert.equal(s(), 2);
        r.dispose(s); assert.equal(lc(), 0);
        // A5a (b114): no stale fire after dispose + reuse; counts stay [2, 1].
        readThenStop(r, reuse(r, n)); assert.deepEqual([first, c2.n], [2, 1]);
        r.destroy();
    });
    it('P11 duplicate dispose / stop / off never drives lc below 0', () => {
        const r = mk(); const lc = lcOf(r);
        const s = r.signal(0); const off = r.observeObservers(s, {});
        r.dispose(s); r.dispose(s); off(); off();
        const stop = r.effect(() => {}); const off2 = r.observeObservers(stop, undefined);
        stop(); stop(); r.dispose(stop); off2();
        assert.equal(lc(), 0);
        const keep = r.signal(0); r.observeObservers(keep, { onConnect: () => {} });
        r.dispose(s); off(); off2(); assert.equal(lc(), 1, 'stale duplicates touched a live entry');
        r.destroy(); assert.equal(lc(), 0);
    });
    it('P12 opts empty / undefined / null', () => {
        const r = mk(); const lc = lcOf(r);
        const a = r.signal(0), b = r.signal(0), c = r.signal(0);
        r.observeObservers(a, {}); r.observeObservers(b, undefined);
        assert.throws(() => r.observeObservers(c, null), TypeError);
        assert.equal(lc(), 2);
        r.dispose(a); r.dispose(b); r.dispose(c);
        assert.equal(lc(), 0);
        r.destroy();
    });
    it('P13 stale off() across destroy(): the re-seated slot\'s new entry survives', () => {
        const r = mk(); const lc = lcOf(r);
        const s1 = r.signal(0); const n = nodeOf(s1); const off1 = r.observeObservers(s1, { onConnect: () => {} });
        r.destroy(); assert.equal(lc(), 0);
        const s2 = reuse(r, n); const c2 = counter(); r.observeObservers(s2, { onConnect: c2.f });
        off1(); assert.equal(lc(), 1);
        readThenStop(r, s2); assert.equal(c2.n, 1);
        r.destroy();
    });
});

describe('P14 capacity boundary N-1 / N / N+1 (throw policy)', () => {
    it('fill every slot with a registered signal, N+1 throws, dispose all -> lc 0, refill clean', () => {
        const r = mk(K, { maxNodes: 16, onCapacityExceeded: 'throw' }); const lc = lcOf(r); const c = counter();
        const N = r.stats().nodePoolPopulation; const ss = [];
        for (let i = 0; i < N; i++) {
            const s = r.signal(i); r.observeObservers(s, { onConnect: c.f, onDisconnect: c.f }); ss.push(s);
        }
        assert.equal(lc(), N);
        assert.throws(() => r.signal(0));
        assert.throws(() => r.observeObservers(r.signal, {}), TypeError);
        assert.equal(lc(), N, 'failed N+1 moved the count');
        for (const s of ss) r.dispose(s);
        assert.equal(lc(), 0);
        const fresh = []; for (let i = 0; i < N - 1; i++) fresh.push(r.signal(i));
        const stop = r.effect(() => { for (const s of fresh) s(); }); stop();
        assert.equal(c.n, 0, 'a refilled slot inherited hooks');
        r.destroy();
    });
});

const GENS = [-1, 0, -0, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1, 2 ** 53, -(2 ** 31)];
describe('P15 gen matrix: stale off() captured at gen V, slot re-seated across (V+1)|0', () => {
    for (const V of GENS) {
        it('V = ' + (Object.is(V, -0) ? '-0' : String(V)), () => {
            const r = mk(); const lc = lcOf(r);
            const s0 = r.signal(0); const n = nodeOf(s0); r.dispose(s0); n.gen = V;
            const s1 = reuse(r, n); assert.ok(Object.is(s1[genSym(s1)], V), 'precondition: handle stamped with V');
            const c1 = counter(); const off1 = r.observeObservers(s1, { onConnect: c1.f });
            r.dispose(s1); assert.equal(lc(), 0);
            assert.equal(n.gen, (V + 1) | 0);
            const s2 = reuse(r, n); const c2 = counter(); r.observeObservers(s2, { onConnect: c2.f });
            off1(); assert.equal(lc(), 1, 'stale off() across the wrap dropped the stranger');
            readThenStop(r, s2); assert.deepEqual([c1.n, c2.n], [0, 1]);
            r.destroy();
        });
    }
    it('V = NaN: handle can never validate -> observeObservers fails closed, lc unchanged', () => {
        const r = mk(); const lc = lcOf(r);
        const s0 = r.signal(0); const n = nodeOf(s0); r.dispose(s0); n.gen = NaN;
        const s1 = reuse(r, n);
        assert.throws(() => r.observeObservers(s1, { onConnect: () => {} }), TypeError);
        assert.equal(lc(), 0);
        r.destroy();
    });
    it('real wrap crossing: start gen 2^31-3, 6 dispose/reuse generations, every stale off replayed each step', () => {
        const r = mk(); const lc = lcOf(r);
        const s0 = r.signal(0); const n = nodeOf(s0); r.dispose(s0); n.gen = 2 ** 31 - 3;
        const offs = []; const seen = [];
        for (let k = 0; k < 6; k++) {
            const s = reuse(r, n); seen.push(n.gen); const c = counter();
            offs.push(r.observeObservers(s, { onConnect: c.f }));
            for (let j = 0; j < offs.length - 1; j++) offs[j]();
            assert.equal(lc(), 1, 'gen ' + n.gen);
            readThenStop(r, s); assert.equal(c.n, 1);
            r.dispose(s); assert.equal(lc(), 0);
        }
        assert.deepEqual(seen, [2147483645, 2147483646, 2147483647, -2147483648, -2147483647, -2147483646]);
        r.destroy();
    });
    it('ADVERSARIAL (characterization, not a gate): 2^32-recycle ABA -- stale off() whose gen equals the resident\'s', (t) => {
        const r = mk(); const lc = lcOf(r);
        const s1 = r.signal(0); const n = nodeOf(s1); const g = n.gen;
        const off1 = r.observeObservers(s1, { onConnect: () => {} });
        r.dispose(s1);
        const s2 = reuse(r, n); n.gen = g; s2[genSym(s2)] = g;          // simulate 2^32 recycles: gen aliases
        r.observeObservers(s2, { onConnect: () => {} });
        off1();
        t.diagnostic('ABA: lc after aliased stale off = ' + lc() + ' (1 = guarded, 0 = aliased; same 32-bit limit as liveNode)');
        r.destroy();
    });
});

describe('P16 lifecycleCount START just below the int32 wrap (white-box START rewrite)', () => {
    for (const START of [2 ** 30 - 1, 2 ** 31 - 3, 2 ** 31 - 2, 2 ** 31 - 1]) {
        it('START = ' + START + ': register/dispose round-trips return to START exactly; resident clean', async () => {
            const W = await load(START); const r = mk(W); const lc = lcOf(r);
            assert.equal(lc(), START | 0);
            const c = counter(); const ss = [];
            for (let i = 0; i < 3; i++) { const s = r.signal(i); r.observeObservers(s, { onConnect: c.f }); ss.push(s); }
            assert.equal(lc(), (START + 3) | 0, 'crossed');
            const n0 = nodeOf(ss[0]);
            for (const s of ss) r.dispose(s);
            assert.equal(lc(), START | 0, 'dispose did not return the counter across the wrap');
            readThenStop(r, reuse(r, n0)); assert.equal(c.n, 0);
            r.destroy(); assert.equal(lc(), START | 0);
        });
    }
});

// P17 (REPORT blocker 3, probe P6): kills M3 (no gen stamp). START = -1: lifecycleCount wraps to 0 with an entry live.
describe('P17 START = -1 (white-box)', () => {
    it('P17 START = -1: dispose skips the drop (count 0, entry live); the kept off() is a no-op', async () => { const W = await load(-1); const r = mk(W); const lc = lcOf(r); const s = r.signal(0); const off = r.observeObservers(s, {}); assert.equal(lc(), 0); r.dispose(s); off(); assert.equal(lc(), 0, 'off() of a disposed node moved the counter'); r.destroy(); });
});
