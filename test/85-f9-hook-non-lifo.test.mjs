// test/85-f9-hook-non-lifo.test.mjs -- A5b (b116): onGraphMutation live-entry stack, off in ANY order (DIV-F9 / F9).
// Oracle: .handoff/PLAN-A5b-hook.md SPEC + ASSERTIONS 1, 4, 5 (+ ANSWERS); no expected value comes from a kernel run.
// Every delivery check deepEquals the FULL delivery list (never a filtered subset). Contract:
//   - single active listener = the newest LIVE registration; `null` registers a "clear" entry (nothing delivered while
//     it is the newest live entry);
//   - off removes ONLY its own entry, in any order, and is idempotent (a second off is a no-op);
//   - off or register inside a listener: the current call finishes, the NEXT fire point reads the new top;
//   - a listener throw propagates out of the fire point as today and leaves hookDepth restored (snapshot() works);
//   - a held off handle retains no listener; firing with offs done allocates nothing.
// Deliveries are counted on op 1 (node create) only: one r.signal() == exactly one op-1 event.
// Red-first: rows tagged [non-lifo] must FAIL on the pre-A5b engine (off restores the captured prev -> resurrection).
// GC / retention rows gate only under `npm run test:gc` (node --expose-gc), skipped otherwise (as test/84).
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js. node:test only, no deps.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLeakTracker } from '@zakkster/lite-leak';
import { GcProfiler } from '@zakkster/lite-gc-profiler';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const K = await import(KPATH + '?s=85');

test('kernel under test', (t) => {
    t.diagnostic('kernel ' + KPATH + ' sha256 ' + createHash('sha256').update(readFileSync(KPATH)).digest('hex'));
});

const mk = () => K.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
// Listener that logs tag on op 1 (node create) only.
const lis = (log, tag) => (op) => { if (op === 1) log.push(tag); };

describe('A5b non-LIFO off', () => {
    it('[non-lifo] 1: A,B,C registered; offA offC offB; then signal() -> 0 deliveries (old: 1 to A)', () => {
        const r = mk(); const log = [];
        const offA = r.onGraphMutation(lis(log, 'A')), offB = r.onGraphMutation(lis(log, 'B')), offC = r.onGraphMutation(lis(log, 'C'));
        r.signal(0);                        // C on top
        offA(); r.signal(0);                // still C
        offC(); r.signal(0);                // C gone: B is the newest live entry
        offB(); r.signal(0);                // nothing live
        assert.deepEqual(log, ['C', 'C', 'B']);
        r.signal(0);
        assert.deepEqual(log, ['C', 'C', 'B']);
        r.destroy();
    });
    it('[non-lifo] 1b: A,B,C ; offA offC offB back to back, then signal() -> 0 deliveries (old: 1 to A)', () => {
        const r = mk(); const log = [];
        const offA = r.onGraphMutation(lis(log, 'A')), offB = r.onGraphMutation(lis(log, 'B')), offC = r.onGraphMutation(lis(log, 'C'));
        offA(); offC(); offB();
        r.signal(0);
        assert.deepEqual(log, []);
        r.destroy();
    });
    it('[non-lifo] 2: A,B; offA offB; signal() -> 0 (old: A gets it)', () => {
        const r = mk(); const log = [];
        const offA = r.onGraphMutation(lis(log, 'A')), offB = r.onGraphMutation(lis(log, 'B'));
        offA(); offB();
        r.signal(0); r.signal(0);
        assert.deepEqual(log, []);
        r.destroy();
    });
    it('[non-lifo] 3: A,B,C; offB offC; signal() -> A only, B and C nothing (old: B)', () => {
        const r = mk(); const log = [];
        r.onGraphMutation(lis(log, 'A'));
        const offB = r.onGraphMutation(lis(log, 'B')), offC = r.onGraphMutation(lis(log, 'C'));
        offB(); offC();
        r.signal(0);
        assert.deepEqual(log, ['A']);
        r.destroy();
    });
    it('[pin] 3b: A,B ; offB (top) ; register C ; offC (top) ; one graph mutation -> exactly one delivery, to A (old: A too; M4 class: a top unlink must move hookTop)', () => {
        const r = mk(); const log = [];
        r.onGraphMutation(lis(log, 'A'));
        const offB = r.onGraphMutation(lis(log, 'B'));
        offB();
        const offC = r.onGraphMutation(lis(log, 'C'));
        offC();
        r.signal(0);
        assert.deepEqual(log, ['A']);
        r.destroy();
    });
    it('[non-lifo] 4: A, null, offA, offnull -> 0 deliveries after the null (old: A resurrected)', () => {
        const r = mk(); const log = [];
        const offA = r.onGraphMutation(lis(log, 'A'));
        r.signal(0);                        // A
        const offN = r.onGraphMutation(null);
        r.signal(0);                        // clear on top: nothing
        offA();
        r.signal(0);                        // clear still the newest live entry: nothing
        offN();
        r.signal(0);                        // no live entry: nothing
        assert.deepEqual(log, ['A']);
        r.destroy();
    });
    it('[non-lifo] 4b: A, null, B ; offnull -> B still top; offB -> A is the only live entry, so A', () => {
        const r = mk(); const log = [];
        r.onGraphMutation(lis(log, 'A'));
        const offN = r.onGraphMutation(null);
        const offB = r.onGraphMutation(lis(log, 'B'));
        r.signal(0);                        // B
        offN(); r.signal(0);                // B (null was below B)
        offB(); r.signal(0);                // A
        assert.deepEqual(log, ['B', 'B', 'A']);
        r.destroy();
    });
    it('5a (pin, green on old): double-off: A,B ; offB offB offA ; a repeated off never disturbs the top or resurrects', () => {
        const r = mk(); const log = [];
        const offA = r.onGraphMutation(lis(log, 'A')), offB = r.onGraphMutation(lis(log, 'B'));
        offB(); offB();
        r.signal(0);                        // A is top
        offA();
        r.signal(0);
        assert.deepEqual(log, ['A']);
        offB();                             // already unlinked: no-op
        offA();
        r.signal(0);
        assert.deepEqual(log, ['A']);
        r.destroy();
    });
    it('5b (pin, green on old): stale off after its entry is gone does not disturb a newer top: A,B ; offA ; C ; offA again ; C stays', () => {
        const r = mk(); const log = [];
        const offA = r.onGraphMutation(lis(log, 'A'));
        r.onGraphMutation(lis(log, 'B'));
        offA();
        const offC = r.onGraphMutation(lis(log, 'C'));
        offA();                             // no-op
        r.signal(0);
        offC();
        r.signal(0);                        // B is the remaining live entry
        assert.deepEqual(log, ['C', 'B']);
        r.destroy();
    });
    it('6 (pin, green on old): off-self mid-fire: top B offs itself inside its own call; that call completes; the next op goes to A', () => {
        const r = mk(); const log = []; let offB = null;
        r.onGraphMutation(lis(log, 'A'));
        offB = r.onGraphMutation((op) => { if (op === 1) { log.push('B.pre'); offB(); log.push('B.post'); } });
        r.signal(0);
        r.signal(0);
        assert.deepEqual(log, ['B.pre', 'B.post', 'A']);
        r.destroy();
    });
    it('7: register mid-fire: C registered inside B\'s call; B completes; the next op goes to C; offC -> B again', () => {
        const r = mk(); const log = []; let offC = null; let added = false;
        r.onGraphMutation(lis(log, 'A'));
        r.onGraphMutation((op) => {
            if (op !== 1) return;
            log.push('B.pre');
            if (!added) { added = true; offC = r.onGraphMutation(lis(log, 'C')); }
            log.push('B.post');
        });
        r.signal(0);                        // B runs, registers C
        r.signal(0);                        // C
        offC();
        r.signal(0);                        // B (still live)
        assert.deepEqual(log, ['B.pre', 'B.post', 'C', 'B.pre', 'B.post']);
        r.destroy();
    });
    it('[non-lifo] 7b: a listener offing a LOWER entry mid-fire: A,B ; B offs A ; next op B, then offB -> 0', () => {
        const r = mk(); const log = []; let offA = null, offB = null;
        offA = r.onGraphMutation(lis(log, 'A'));
        offB = r.onGraphMutation((op) => { if (op === 1) { log.push('B'); offA(); } });
        r.signal(0); r.signal(0);
        assert.deepEqual(log, ['B', 'B']);
        offB(); r.signal(0);
        assert.deepEqual(log, ['B', 'B']);
        r.destroy();
    });
    it('8: a throwing listener: the error propagates from the fire point as-is; snapshot() then succeeds (hookDepth restored)', () => {
        const r = mk(); const boom = new Error('boom'); let off = null;
        off = r.onGraphMutation((op) => { if (op === 1) throw boom; });
        let got = null;
        try { r.signal(0); } catch (e) { got = e; }
        assert.equal(got, boom);
        assert.doesNotThrow(() => r.snapshot());   // throwing entry still live, nothing running
        off();
        const off2 = r.onGraphMutation(() => {});
        assert.doesNotThrow(() => r.snapshot());
        off2();
        r.destroy();
    });
    it('8b: throw in the top listener with a lower live entry below: depth restored, snapshot() ok', () => {
        const r = mk(); const boom = new Error('boom2');
        r.onGraphMutation(() => {});
        r.onGraphMutation((op) => { if (op === 1) throw boom; });
        assert.throws(() => r.signal(0), (e) => e === boom);
        assert.doesNotThrow(() => r.snapshot());
        r.destroy();
    });
});

// Reference model of the TARGET semantics: delivery goes to the newest live entry (null kind = nobody).
function refTop(entries) {
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].live) return entries[i].kind;
    return null;
}
function perms(a) {
    if (a.length <= 1) return [a.slice()];
    const out = [];
    for (let i = 0; i < a.length; i++) {
        const rest = a.slice(0, i).concat(a.slice(i + 1));
        for (const p of perms(rest)) out.push([a[i]].concat(p));
    }
    return out;
}
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('A5b reference-model sweeps', () => {
    it('exhaustive: 4 entries [A, null, B, C] x all 24 off orders (a signal() before the first off and after every off, full list vs model)', () => {
        let rows = 0;
        for (const order of perms([0, 1, 2, 3])) {
            const r = mk(); const log = [];
            const kinds = ['A', null, 'B', 'C'];
            const offs = kinds.map((k) => r.onGraphMutation(k === null ? null : lis(log, k)));
            const model = kinds.map((k) => ({ kind: k, live: true }));
            const want = [];
            const probe = () => { r.signal(0); const t = refTop(model); if (t !== null) want.push(t); rows++; };
            probe();
            for (const i of order) { offs[i](); model[i].live = false; probe(); }
            assert.deepEqual(log, want, 'order ' + order.join(','));
            r.destroy();
        }
        assert.equal(rows, 24 * 5);
    });
    it('exhaustive: 3 listeners x all 6 off orders x one double-off after each off', () => {
        let rows = 0;
        for (const order of perms([0, 1, 2])) {
            const r = mk(); const log = [];
            const kinds = ['A', 'B', 'C'];
            const offs = kinds.map((k) => r.onGraphMutation(lis(log, k)));
            const model = kinds.map((k) => ({ kind: k, live: true }));
            const want = [];
            for (const i of order) {
                offs[i](); model[i].live = false;
                offs[i]();                  // idempotent
                r.signal(0); const t = refTop(model); if (t !== null) want.push(t); rows++;
            }
            assert.deepEqual(log, want, 'order ' + order.join(','));
            r.destroy();
        }
        assert.equal(rows, 18);
    });
    it('seeded random: 300 seeds x 40 interleaved register/null/off/fire steps vs the model; independent op and key streams; coverage floor', () => {
        let nonTopOff = 0, nullRegs = 0, fires = 0, staleOffs = 0;
        for (let seed = 1; seed <= 300; seed++) {
            const pick = mulberry32(Math.imul(seed, 2654435761));       // op-kind stream
            const sel = mulberry32((seed ^ 0x9E3779B9) >>> 0);          // which-entry stream
            const r = mk(); const log = []; const want = [];
            const entries = [];                                         // model entries {kind, live, off}
            let tag = 0;
            for (let step = 0; step < 40; step++) {
                const u = pick();
                if (u < 0.25 || entries.length === 0) {
                    const isNull = pick() < 0.2;
                    const kind = isNull ? null : 't' + (tag++);
                    const off = r.onGraphMutation(isNull ? null : lis(log, kind));
                    entries.push({ kind, live: true, off });
                    if (isNull) nullRegs++;
                } else if (u < 0.65) {
                    const e = entries[(sel() * entries.length) | 0];
                    if (!e.live) staleOffs++;
                    else if (e !== entries.filter((x) => x.live).pop()) nonTopOff++;
                    e.off(); e.live = false;
                } else {
                    r.signal(0); fires++;
                    const t = refTop(entries); if (t !== null) want.push(t);
                }
            }
            assert.deepEqual(log, want, 'seed ' + seed);
            r.destroy();
        }
        // Coverage floor: counts are of the generator's stream, not of engine output.
        assert.ok(nonTopOff >= 300, 'nonTopOff ' + nonTopOff);
        assert.ok(nullRegs >= 300, 'nullRegs ' + nullRegs);
        assert.ok(staleOffs >= 300, 'staleOffs ' + staleOffs);
        assert.ok(fires >= 2000, 'fires ' + fires);
    });
});

const HAVE_GC = typeof globalThis.gc === 'function';
const nap = (ms) => new Promise((res) => setTimeout(res, ms));
const settle = async () => { globalThis.gc(); await nap(0); globalThis.gc(); };

describe('A5b RETENTION (gated: needs --expose-gc / npm run test:gc)', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    async function slide(cycles, doOff) {
        const r = mk();
        const tracker = createLeakTracker({ name: 't85', onLeak() {}, onWarning() {} });
        const offs = [];                       // every off handle is HELD to the end
        let prevOff = null;
        for (let i = 0; i < cycles; i++) {
            const obj = { i }; tracker.track(obj, null, i);
            const off = r.onGraphMutation((op) => { void obj; void op; });
            offs.push(off);
            if (doOff && prevOff !== null) prevOff();    // off the OLDER one: sliding window of 1 live entry
            prevOff = off;
        }
        if (doOff) prevOff();                  // off the last one too: nothing live
        for (let i = 0; i < 30 && tracker.size() > 0 && doOff; i++) { await settle(); await nap(10); }
        await settle(); await settle();
        const size = tracker.size(); void offs.length;
        return size;
    }
    it('10000 sliding-window cycles (register new, off older), handles held: tracker.size() === 0 after gc', async () => {
        assert.equal(await slide(10000, true), 0);
    });
    it('CONTROL (must-fail shape): no offs -> all 100 listeners stay retained (size === 100)', async () => {
        assert.equal(await slide(100, false), 100);
    });
});

describe('A5b 0 B/op fire (gated: needs --expose-gc / npm run test:gc)', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    // 5 live listeners then 2 NON-top offs; the effect re-run fires op 5 on every set().
    async function window(ctl, n) {
        const r = mk();
        const s = r.signal(0); let sink = 0;
        r.effect(() => { sink = (sink + s()) & 0x3fffffff; });
        const cnt = new Int32Array(1); const keep = [null];
        const body = ctl ? (op) => { cnt[0]++; keep[0] = [op]; } : () => { cnt[0]++; };
        const offs = [];
        for (let i = 0; i < 5; i++) offs.push(r.onGraphMutation(i === 4 ? body : () => {}));
        offs[1](); offs[2]();
        for (let i = 1; i <= 20000; i++) s.set(i);       // warm
        globalThis.gc(); globalThis.gc(); await nap(20);
        cnt[0] = 0;
        const gcp = new GcProfiler().start();
        const h0 = process.memoryUsage().heapUsed;
        for (let i = 1; i <= n; i++) s.set(20000 + i);
        const h1 = process.memoryUsage().heapUsed;
        await nap(50);
        const sum = gcp.summary(); gcp.stop();
        return { minor: sum.gc.minor, major: sum.gc.major, bpo: (h1 - h0) / n, delivered: cnt[0] };
    }
    it('5 live listeners, 2 non-top offs done, 1e5 set(): minor 0, maxMajor 0, < 0.5 B/op, the top listener actually fired', async () => {
        const m = await window(false, 100000);
        assert.ok(m.delivered >= 100000, 'delivered ' + m.delivered);   // >= 1 op-5 per re-run
        assert.equal(m.minor, 0, 'minor GCs');
        assert.equal(m.major, 0, 'major GCs');
        assert.ok(m.bpo < 0.5, 'B/op ' + m.bpo);
    });
    it('CONTROL (transient): the top listener allocates a 1-element array per call -> minor > 0 (lane not blind)', async () => {
        const m = await window(true, 1000000);
        assert.ok(m.minor > 0, 'control minor ' + m.minor);
    });
});
