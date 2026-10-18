// test/62-dispose-drops-lifecycle-hooks.test.mjs -- burst 62 (LEDGER #40): disposing a node must drop its
// observeObservers() lifecycle entry, so a pooled slot's next resident never inherits (or keeps alive) the dead
// node's onConnect / onDisconnect hooks; a stale off() must not delete the new resident's entry.
// Oracle: .handoff/PLAN-0v.md ASSERTIONS A1-A8 (no expected value comes from a kernel run).
// RED on the frozen b62-before engine (measured): A1, A3, A4, A5, A7, A8, D1. A2 / A6 are controls (GREEN on both).
// A9 is a regression pin (GREEN on b62-before and live: both off()s delete); it is red only on the off()-has-not-delete mutant.
// A7: lifecycleCount is closure-private, so it is read white-box: the test loads a scratch copy of the kernel with one
// stats() field injected (LC_ANCHOR, as test/60 O5 and test/61 B3 do). That lane runs WITHOUT --expose-gc.
// Slot reuse is proven white-box through the NODE_PTR symbol (as test/59 rows 10/11).
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js. A4 needs node --expose-gc.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const K = await import(KPATH);
const hasGc = typeof globalThis.gc === 'function';

test('kernel under test', (t) => {
    const sha = createHash('sha256').update(readFileSync(KPATH)).digest('hex');
    t.diagnostic('kernel ' + KPATH + ' sha256 ' + sha);
    assert.equal(typeof K.createRegistry, 'function');
});

const mk = () => K.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
const ptrSym = (h) => Object.getOwnPropertySymbols(h).find((k) => typeof h[k] === 'object' && h[k] !== null);
const nodeOf = (h) => h[ptrSym(h)];
const counter = () => { const c = { n: 0, f: () => { c.n++; } }; return c; };
// Allocate signals until the next signal() lands on `slot` (free-list drain, as test/59 row 11). Returns it.
function reuse(r, slot, mkFn = () => r.signal(0)) {
    for (let i = 0; i < 4096; i++) {
        const s = mkFn();
        if (nodeOf(s) === slot) return s;
    }
    throw new Error('slot never reused (precondition)');
}
function readThenStop(r, s) { const stop = r.effect(() => { s(); }); stop(); }

describe('A1 slot handoff', () => {
    it('hooks of a disposed node do not fire for the slot\'s next resident', () => {
        const r = mk(); const c1 = counter(), d1 = counter();
        const s1 = r.signal(0); const n1 = nodeOf(s1);
        r.observeObservers(s1, { onConnect: c1.f, onDisconnect: d1.f });
        r.dispose(s1);
        const s2 = reuse(r, n1);
        assert.equal(nodeOf(s2), n1, 'precondition: s2 reuses s1\'s pooled node');
        readThenStop(r, s2);
        assert.equal(c1.n, 0, 'stale onConnect fired');
        assert.equal(d1.n, 0, 'stale onDisconnect fired');
        r.destroy();
    });
});

describe('A2 positive control', () => {
    it('hooks registered on the new resident fire exactly once each', () => {
        const r = mk(); const c1 = counter(), d1 = counter(), c2 = counter(), d2 = counter();
        const s1 = r.signal(0); const n1 = nodeOf(s1);
        r.observeObservers(s1, { onConnect: c1.f, onDisconnect: d1.f });
        r.dispose(s1);
        const s2 = reuse(r, n1);
        r.observeObservers(s2, { onConnect: c2.f, onDisconnect: d2.f });
        const stop = r.effect(() => { s2(); });
        assert.equal(c2.n, 1); assert.equal(d2.n, 0);
        stop();
        assert.equal(d2.n, 1); assert.equal(c2.n, 1);
        r.destroy();
    });
});

describe('A3 owner cascade', () => {
    it('hooks of a node disposed by its owner do not reach the next resident', () => {
        const r = mk(); const c = counter(), d = counter();
        let s = null, n = null;
        // An effect owns computeds/effects (not plain signals), so the owned node is a computed.
        const stopOwner = r.effect(() => { s = r.computed(() => 0); n = nodeOf(s); r.observeObservers(s, { onConnect: c.f, onDisconnect: d.f }); });
        assert.ok(n);
        stopOwner();                                   // cascade-disposes the owned computed
        const s2 = reuse(r, n, () => r.computed(() => 0));
        assert.equal(nodeOf(s2), n, 'precondition: slot reused');
        readThenStop(r, s2);
        assert.equal(c.n, 0, 'stale onConnect fired');
        assert.equal(d.n, 0, 'stale onDisconnect fired');
        r.destroy();
    });
    it('same through a createRoot-owned effect scope', () => {
        const r = mk(); const c = counter(), d = counter();
        let s = null, n = null, stopOwner = null;
        r.createRoot(() => {
            stopOwner = r.effect(() => { s = r.computed(() => 0); n = nodeOf(s); r.observeObservers(s, { onConnect: c.f, onDisconnect: d.f }); });
        });
        stopOwner();
        const s2 = reuse(r, n, () => r.computed(() => 0));
        readThenStop(r, s2);
        assert.equal(c.n + d.n, 0, 'stale hooks fired via createRoot scope');
        r.destroy();
    });
});

describe('A4 retention (needs --expose-gc)', { skip: hasGc ? false : 'requires node --expose-gc' }, () => {
    const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise((res) => setTimeout(res, 5)); globalThis.gc(); } };
    // Build the refs in a non-inlined frame so no stack slot keeps them alive.
    function setup(r, how) {
        const hooks = { onConnect: () => 1, onDisconnect: () => 2 };
        const refs = [new WeakRef(hooks), new WeakRef(hooks.onConnect), new WeakRef(hooks.onDisconnect)];
        if (how === 'dispose') {
            const s = r.signal(0); r.observeObservers(s, hooks); r.dispose(s);
        } else {
            const stop = r.effect(() => { const s = r.computed(() => 0); r.observeObservers(s, hooks); });
            stop();
        }
        return refs;
    }
    it('control: a live object stays alive and a dropped one dies under gc', async () => {
        let live = { a: 1 }; let dead = { b: 2 };
        const rl = new WeakRef(live), rd = new WeakRef(dead); dead = null;
        await settle();
        assert.equal(rd.deref(), undefined, 'gc + WeakRef must be able to collect');
        assert.notEqual(rl.deref(), undefined, 'live ref must survive');
        assert.equal(live.a, 1);
    });
    for (const how of ['dispose', 'owner-cascade']) {
        it('hooks object and closures are collectable after ' + how, async () => {
            const r = mk();
            const refs = setup(r, how);
            await settle();
            // refs[0] (the hooks object) is non-gating: observeObservers copies the functions and never keeps the object.
            assert.deepEqual(refs.slice(1).map((w) => w.deref() === undefined), [true, true], 'hook closures retained by the registry');
            r.destroy();
        });
    }
});

describe('A5 stale off()', () => {
    it('off() from a disposed node does not delete the new resident\'s entry', () => {
        const r = mk(); const c1 = counter(), c2 = counter();
        const s1 = r.signal(0); const n1 = nodeOf(s1);
        const off1 = r.observeObservers(s1, { onConnect: c1.f });
        r.dispose(s1);
        const s2 = reuse(r, n1);
        r.observeObservers(s2, { onConnect: c2.f });
        off1();
        readThenStop(r, s2);
        assert.equal(c2.n, 1, 'stale off() unregistered the new resident');
        assert.equal(c1.n, 0);
        r.destroy();
    });
});

describe('A6 off() semantics', () => {
    it('off() on a live node unregisters; twice is a no-op; after dispose does not throw', () => {
        const r = mk(); const c = counter();
        const s = r.signal(0);
        const off = r.observeObservers(s, { onConnect: c.f });
        off(); off();
        readThenStop(r, s);
        assert.equal(c.n, 0);
        const s3 = r.signal(0); const off3 = r.observeObservers(s3, { onConnect: c.f });
        r.dispose(s3);
        assert.doesNotThrow(() => { off3(); off3(); });
        r.destroy();
    });
});

describe('A7 zero-cost gate (white-box, no gc needed)', () => {
    const LC_ANCHOR = '    function stats() {\n        return {\n';
    it('A7 white-box: lifecycleCount returns to 0 after dispose / cascade / destroy / teardown-registration, no off()', async () => {
        const src = readFileSync(KPATH, 'utf8');
        assert.equal(src.split(LC_ANCHOR).length, 2, 'stats() anchor must occur exactly once');
        const dir = mkdtempSync(join(tmpdir(), 'ls62-'));
        try {
            writeFileSync(join(dir, 'Signal.js'), src.replace(LC_ANCHOR, () => LC_ANCHOR + '            lifecycleCount: lifecycleCount,\n'));
            copyFileSync(join(dirname(KPATH), 'Watch.js'), join(dir, 'Watch.js'));
            const W = await import(join(dir, 'Signal.js'));
            const r = W.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
            const lc = () => r.stats().lifecycleCount;
            const nop = () => {};
            try {
                assert.equal(lc(), 0);
                const ss = []; for (let i = 0; i < 20; i++) { const s = r.signal(i); r.observeObservers(s, { onConnect: nop }); ss.push(s); }
                assert.equal(lc(), 20, 'control: the instrument sees live entries');
                for (const s of ss) r.dispose(s);
                assert.equal(lc(), 0, 'dispose(api) with no off()');
                const keep = r.signal(0); r.observeObservers(keep, { onConnect: nop });
                r.dispose(r.signal(0));
                assert.equal(lc(), 1, 'disposing an unregistered node must not move the count');
                r.dispose(keep);
                assert.equal(lc(), 0);
                const stop = r.effect(() => { const c = r.computed(() => 0); r.observeObservers(c, { onConnect: nop }); });
                assert.equal(lc(), 1); stop();
                assert.equal(lc(), 0, 'owner cascade with no off()');
                const s1 = r.signal(0); const n1 = nodeOf(s1); const off1 = r.observeObservers(s1, { onConnect: nop });
                r.dispose(s1);
                let s2 = null; for (let i = 0; i < 4096 && s2 === null; i++) { const s = r.signal(0); if (nodeOf(s) === n1) s2 = s; }
                assert.ok(s2, 'precondition: slot reused');
                const off2 = r.observeObservers(s2, { onConnect: nop });
                off1(); assert.equal(lc(), 1, 'stale off() must not drop the new resident');
                off2(); assert.equal(lc(), 0);
                let t = null, regs = 0;
                t = r.computed(() => { r.onCleanup(() => { r.observeObservers(t, { onConnect: nop }); regs++; }); return 0; });
                t(); r.dispose(t);
                assert.equal(regs, 1, 'coverage: registered inside its own teardown');
                assert.equal(lc(), 0, 'teardown registration dropped');
                for (let i = 0; i < 4; i++) r.observeObservers(r.signal(i), { onConnect: nop });
                assert.equal(lc(), 4);
                r.destroy();
                assert.equal(lc(), 0, 'destroy() with no off()');
            } finally { r.destroy(); }
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('A9 off() really deletes (white-box, no gc needed; regression pin, GREEN on b62-before and live)', () => {
    // Kills the mutant `lifecycleMap.delete(node)` -> `lifecycleMap.has(node)` inside off(): the count drops but the
    // entry (the hooks) stays, so once another registration keeps lifecycleCount != 0 the removed hooks fire again.
    const LC_ANCHOR = '    function stats() {\n        return {\n';
    it('A9 hooks removed by off() never fire while another registration keeps lifecycleCount at 1', async () => {
        const src = readFileSync(KPATH, 'utf8');
        assert.equal(src.split(LC_ANCHOR).length, 2, 'stats() anchor must occur exactly once');
        const dir = mkdtempSync(join(tmpdir(), 'ls62-'));
        try {
            const inj = LC_ANCHOR + '            lifecycleCount: lifecycleCount,\n';
            writeFileSync(join(dir, 'Signal.js'), src.replace(LC_ANCHOR, () => inj));
            copyFileSync(join(dirname(KPATH), 'Watch.js'), join(dir, 'Watch.js'));
            const W = await import(join(dir, 'Signal.js') + '?a9');
            const r = W.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
            try {
                const h1 = counter(), h2 = counter();
                const s1 = r.signal(0), s2 = r.signal(0);
                const off1 = r.observeObservers(s1, { onConnect: h1.f, onDisconnect: h1.f });
                assert.equal(r.stats().lifecycleCount, 1, 'control: one live registration');
                off1();
                assert.equal(r.stats().lifecycleCount, 0, 'off() drops the count');
                r.observeObservers(s2, { onConnect: h2.f, onDisconnect: h2.f });
                assert.equal(r.stats().lifecycleCount, 1, 'only s2 is registered');
                readThenStop(r, s1);
                assert.equal(h1.n, 0, 'hooks removed by off() fired (entry not deleted)');
                assert.equal(h2.n, 0, 'h2 is on an unread signal');
            } finally { r.destroy(); }
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('A8 hooks registered during teardown', () => {
    // Owned nodes are computeds. Both creation orders are exercised, since the cascade order decides whether the
    // dying node is still live when the teardown code runs (if not, observeObservers throws and nothing registers).
    for (const targetFirst of [true, false]) {
        it('registered from a cleanup running inside the cascade (target created ' + (targetFirst ? 'first' : 'last') + ')', () => {
            const r = mk(); const c = counter(), d = counter();
            let target = null, tn = null;
            const reg = () => { try { r.observeObservers(target, { onConnect: c.f, onDisconnect: d.f }); } catch (_) { /* already dead */ } };
            const stopOwner = r.effect(() => {
                if (targetFirst) { target = r.computed(() => 0); tn = nodeOf(target); }
                r.effect(() => { r.onCleanup(reg); });
                if (!targetFirst) { target = r.computed(() => 0); tn = nodeOf(target); }
            });
            stopOwner();
            const s2 = reuse(r, tn, () => r.computed(() => 0));
            readThenStop(r, s2);
            assert.equal(c.n + d.n, 0, 'teardown-registered hooks reached the next resident');
            r.destroy();
        });
    }
    it('A8 own cleanup registers on the dying node itself (coverage asserted)', () => {
        const r = mk(); const c = counter(), d = counter(); let regs = 0, target = null;
        const reg = () => { r.observeObservers(target, { onConnect: c.f, onDisconnect: d.f }); regs++; };
        target = r.computed(() => { r.onCleanup(reg); return 0; });
        const tn = nodeOf(target);
        target();
        assert.equal(regs, 0, 'precondition: nothing registered before teardown');
        r.dispose(target);
        assert.equal(regs, 1, 'coverage: observeObservers ran (no throw) inside the dying node\'s own cleanup');
        const s2 = reuse(r, tn, () => r.computed(() => 0));
        readThenStop(r, s2);
        assert.equal(c.n + d.n, 0, 'teardown-registered hooks reached the next resident');
        r.destroy();
    });
    it('A8 a dep\'s onDisconnect (fired by the dying node\'s dep walk) registers on the dying node (coverage asserted)', () => {
        const r = mk(); const c = counter(), d = counter(); let regs = 0, target = null;
        const reg = () => { r.observeObservers(target, { onConnect: c.f, onDisconnect: d.f }); regs++; };
        const dep = r.signal(0);
        r.observeObservers(dep, { onDisconnect: reg });
        target = r.computed(() => dep());
        const tn = nodeOf(target);
        target();
        assert.equal(regs, 0, 'precondition');
        r.dispose(target);
        assert.equal(regs, 1, 'coverage: dep onDisconnect ran inside the dying node\'s dep walk');
        const s2 = reuse(r, tn, () => r.computed(() => 0));
        readThenStop(r, s2);
        assert.equal(c.n + d.n, 0, 'teardown-registered hooks reached the next resident');
        r.destroy();
    });
    it('registered from an onDisconnect of a dep of a computed being disposed', () => {
        const r = mk(); const c = counter(), d = counter();
        const dep = r.signal(0);
        let target = null, tn = null;
        const reg = () => { try { r.observeObservers(target, { onConnect: c.f, onDisconnect: d.f }); } catch (_) { /* already dead */ } };
        r.observeObservers(dep, { onDisconnect: reg });
        const owner = r.effect(() => {
            const comp = r.computed(() => dep());
            target = r.computed(() => 0); tn = nodeOf(target);
            r.effect(() => { comp(); });
        });
        owner();                                        // dep loses its last observer during the cascade
        const s2 = reuse(r, tn, () => r.computed(() => 0));
        readThenStop(r, s2);
        assert.equal(c.n + d.n, 0, 'teardown-registered hooks reached the next resident');
        r.destroy();
    });
});

describe('D1 destroy() drops lifecycle hooks', () => {
    // The registry stays usable after destroy() (pool kept, free list rebuilt); slot reuse is proven via NODE_PTR.
    it('(a) old hooks do not reach the next resident of a slot after destroy(); new hooks fire 1/1', () => {
        const r = mk(); const c1 = counter(), d1 = counter(), c2 = counter(), d2 = counter();
        const s1 = r.signal(0); const n1 = nodeOf(s1);
        r.observeObservers(s1, { onConnect: c1.f, onDisconnect: d1.f });
        r.destroy();
        const s2 = reuse(r, n1);
        assert.equal(nodeOf(s2), n1, 'precondition: slot reused after destroy');
        readThenStop(r, s2);
        assert.equal(c1.n, 0, 'stale onConnect fired after destroy');
        assert.equal(d1.n, 0, 'stale onDisconnect fired after destroy');
        r.observeObservers(s2, { onConnect: c2.f, onDisconnect: d2.f });
        readThenStop(r, s2);
        assert.equal(c2.n, 1); assert.equal(d2.n, 1);
        r.destroy();
    });
    describe('(b) retention (needs --expose-gc)', { skip: hasGc ? false : 'requires node --expose-gc' }, () => {
        const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise((res) => setTimeout(res, 5)); globalThis.gc(); } };
        function setup(r) {
            const hooks = { onConnect: () => 1, onDisconnect: () => 2 };
            const refs = [new WeakRef(hooks), new WeakRef(hooks.onConnect), new WeakRef(hooks.onDisconnect)];
            const s = r.signal(0); r.observeObservers(s, hooks);
            r.destroy();
            return refs;
        }
        it('control: live stays, dropped dies', async () => {
            let live = { a: 1 }; let dead = { b: 2 };
            const rl = new WeakRef(live), rd = new WeakRef(dead); dead = null;
            await settle();
            assert.equal(rd.deref(), undefined);
            assert.notEqual(rl.deref(), undefined); assert.equal(live.a, 1);
        });
        it('hooks object and closures are collectable after destroy()', async () => {
            const r = mk();
            const refs = setup(r);
            await settle();
            // refs[0] (the hooks object) is non-gating, as in A4.
            assert.deepEqual(refs.slice(1).map((w) => w.deref() === undefined), [true, true], 'hook closures retained after destroy');
        });
    });
});
