// test/84-lifecycle-independent.test.mjs -- A5a (b114): observeObservers registrations are INDEPENDENT (DIV-D3 / F7).
// Oracle: .handoff/PLAN-A5a-lifecycle.md ASSERTIONS 1-2 + the ANSWERS section (maintainer rulings OQ1-OQ5); no expected
// value comes from a kernel run. Every row asserts the FULL observed log (deepEqual of the whole sequence).
// Contract: each registration has its own phase; onConnect on the node's 0->1, onDisconnect on 1->0, per live
// registration, in REGISTRATION ORDER; a reg registered while the node is already observed starts "connected" (no
// retroactive onConnect; its onDisconnect fires at the next 1->0); off() removes only its own reg at once; an add during
// a fire skips that fire; dispose inside a callback stops the walk; lifecycleCount counts NODES with >= 1 live reg;
// throws: every live reg still fires, one error rethrown as-is, >= 2 -> AggregateError in registration order, op 3 once.
// White-box: lifecycleCount injected into stats() (LC_ANCHOR, as test/63). Rows named "control" must be green before A5a.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js. node:test only, no deps.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createLeakTracker } from '@zakkster/lite-leak';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const LC_ANCHOR = '    function stats() {\n        return {\n';
const SRC = readFileSync(KPATH, 'utf8');
const dirs = [];
async function load() {
    assert.equal(SRC.split(LC_ANCHOR).length, 2, 'stats() anchor must occur exactly once');
    const s = SRC.replace(LC_ANCHOR, () => LC_ANCHOR + '            lifecycleCount: lifecycleCount,\n');
    const dir = mkdtempSync(join(tmpdir(), 'lite84-')); dirs.push(dir);
    writeFileSync(join(dir, 'Signal.js'), s);
    if (existsSync(join(dirname(KPATH), 'Watch.js'))) copyFileSync(join(dirname(KPATH), 'Watch.js'), join(dir, 'Watch.js'));
    return import(join(dir, 'Signal.js') + '?s=84');
}
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const K = await load();

test('kernel under test', (t) => {
    t.diagnostic('kernel ' + KPATH + ' sha256 ' + createHash('sha256').update(SRC).digest('hex'));
});

const mk = () => K.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
const ptrSym = (h) => Object.getOwnPropertySymbols(h).find((k) => typeof h[k] === 'object' && h[k] !== null);
const nodeOf = (h) => h[ptrSym(h)];
const lcOf = (r) => () => { const v = r.stats().lifecycleCount; assert.ok(Number.isInteger(v)); return v; };
function readThenStop(r, s) { const stop = r.effect(() => { s(); }); stop(); }
function reuse(r, slot) {
    for (let i = 0; i < 4096; i++) { const s = r.signal(0); if (nodeOf(s) === slot) return s; }
    throw new Error('slot never reused (precondition)');
}
// Registration that logs 'tag.c' / 'tag.d' into log.
const logReg = (log, tag, extra) => ({
    onConnect: () => { log.push(tag + '.c'); if (extra && extra.c) extra.c(); },
    onDisconnect: () => { log.push(tag + '.d'); if (extra && extra.d) extra.d(); },
});

describe('A5a independent registrations', () => {
    it('core: A{c,d} and B{c,d}: [1,1,1,1]; offA; one more cycle A [1,1] B [2,2]; lc 1 -> 0 after offB', () => {
        const r = mk(); const lc = lcOf(r); const s = r.signal(0);
        const n = { ac: 0, ad: 0, bc: 0, bd: 0 };
        const offA = r.observeObservers(s, { onConnect: () => { n.ac++; }, onDisconnect: () => { n.ad++; } });
        const offB = r.observeObservers(s, { onConnect: () => { n.bc++; }, onDisconnect: () => { n.bd++; } });
        readThenStop(r, s);
        assert.deepEqual([n.ac, n.ad, n.bc, n.bd], [1, 1, 1, 1]);
        assert.equal(lc(), 1);
        offA();
        readThenStop(r, s);
        assert.deepEqual([n.ac, n.ad, n.bc, n.bd], [1, 1, 2, 2]);
        assert.equal(lc(), 1);
        offB(); assert.equal(lc(), 0);
        r.destroy();
    });
    it('FIFO: 3 regs fire in registration order on connect and on disconnect; full log', () => {
        const r = mk(); const s = r.signal(0); const log = [];
        r.observeObservers(s, logReg(log, 'A')); r.observeObservers(s, logReg(log, 'B')); r.observeObservers(s, logReg(log, 'C'));
        readThenStop(r, s);
        assert.deepEqual(log, ['A.c', 'B.c', 'C.c', 'A.d', 'B.d', 'C.d']);
        r.destroy();
    });
    it('lc counts NODES: two regs on one node -> 1; off one -> 1; off both -> 0; second node -> 2', () => {
        const r = mk(); const lc = lcOf(r); const s = r.signal(0), u = r.signal(0); const seen = [];
        const o1 = r.observeObservers(s, { onConnect: () => {} }); seen.push(lc());
        const o2 = r.observeObservers(s, { onDisconnect: () => {} }); seen.push(lc());
        const o3 = r.observeObservers(u, {}); seen.push(lc());
        o1(); seen.push(lc()); o2(); seen.push(lc()); o3(); seen.push(lc());
        assert.deepEqual(seen, [1, 1, 2, 2, 1, 0]);
        r.destroy();
    });
    it('control (already green before A5a): empty registration still registers: {} and no-arg opts count; a regs-with-callbacks node unaffected', () => {
        const r = mk(); const lc = lcOf(r); const a = r.signal(0), b = r.signal(0); const log = [];
        r.observeObservers(a, {}); r.observeObservers(b, undefined); r.observeObservers(b, logReg(log, 'X'));
        assert.equal(lc(), 2);
        readThenStop(r, b);
        assert.deepEqual(log, ['X.c', 'X.d']);
        r.destroy(); assert.equal(lc(), 0);
    });
    it('B0-2 mirror pair: rA does off(rB), rB does off(rA): no TypeError; rA fires once, rB 0 times', () => {
        const r = mk(); const s = r.signal(0); const log = []; let offA = null, offB = null;
        offA = r.observeObservers(s, { onConnect: () => { log.push('rA'); offB(); } });
        offB = r.observeObservers(s, { onConnect: () => { log.push('rB'); offA(); } });
        assert.doesNotThrow(() => readThenStop(r, s));
        assert.deepEqual(log, ['rA']);
        r.destroy();
    });
    it('off of a middle reg during the walk: A offs B; A and C fire, B never; later cycle A, C only', () => {
        const r = mk(); const s = r.signal(0); const log = []; let offB = null;
        r.observeObservers(s, logReg(log, 'A', { c: () => { offB(); } }));
        offB = r.observeObservers(s, logReg(log, 'B'));
        r.observeObservers(s, logReg(log, 'C'));
        readThenStop(r, s);
        assert.deepEqual(log, ['A.c', 'C.c', 'A.d', 'C.d']);
        readThenStop(r, s);
        assert.deepEqual(log, ['A.c', 'C.c', 'A.d', 'C.d', 'A.c', 'C.c', 'A.d', 'C.d']);
        r.destroy();
    });
    it('add-in-callback skipped: reg added during a fire is not fired by it; it starts connected, fires from the next cycle', () => {
        const r = mk(); const s = r.signal(0); const log = []; let added = false;
        r.observeObservers(s, { onConnect: () => {
            log.push('A.c');
            if (!added) { added = true; r.observeObservers(s, logReg(log, 'N')); }
        } });
        readThenStop(r, s);
        assert.deepEqual(log, ['A.c', 'N.d']);
        readThenStop(r, s);
        assert.deepEqual(log, ['A.c', 'N.d', 'A.c', 'N.c', 'N.d']);
        r.destroy();
    });
    it('control (already green before A5a): reg added while already observed starts connected: no retroactive onConnect; onDisconnect fires at the next 1->0', () => {
        const r = mk(); const s = r.signal(0); const log = [];
        const stop = r.effect(() => { s(); });
        r.observeObservers(s, logReg(log, 'L'));
        assert.deepEqual(log, []);
        stop();
        assert.deepEqual(log, ['L.d']);
        r.destroy();
    });
    it('control: single reg is transition-only; two cycles -> [c,d,c,d]; off stops it', () => {
        const r = mk(); const s = r.signal(0); const log = [];
        const off = r.observeObservers(s, logReg(log, 'S'));
        readThenStop(r, s); readThenStop(r, s);
        assert.deepEqual(log, ['S.c', 'S.d', 'S.c', 'S.d']);
        off(); readThenStop(r, s);
        assert.deepEqual(log, ['S.c', 'S.d', 'S.c', 'S.d']);
        r.destroy();
    });
    it('dispose-in-callback stops the walk: A disposes the node; B, C never fire; lc 0', () => {
        const r = mk(); const lc = lcOf(r); const log = []; const s = r.signal(0);
        r.observeObservers(s, logReg(log, 'A', { c: () => { r.dispose(s); } }));
        r.observeObservers(s, logReg(log, 'B')); r.observeObservers(s, logReg(log, 'C'));
        const stop = r.effect(() => { s(); }); stop();
        assert.deepEqual(log, ['A.c']);
        assert.equal(lc(), 0);
        r.destroy();
    });
    it('off twice is a no-op: offA twice leaves B live and lc 1; B still fires', () => {
        const r = mk(); const lc = lcOf(r); const s = r.signal(0); const log = [];
        const offA = r.observeObservers(s, logReg(log, 'A')); r.observeObservers(s, logReg(log, 'B'));
        offA(); offA();
        assert.equal(lc(), 1);
        readThenStop(r, s);
        assert.deepEqual(log, ['B.c', 'B.d']);
        r.destroy();
    });
    it('off() after dispose + slot re-seat is a no-op (gen stamp): the new resident keeps both its regs', () => {
        const r = mk(); const lc = lcOf(r); const s = r.signal(0); const n = nodeOf(s); const log = [];
        const o1 = r.observeObservers(s, logReg(log, 'old1')); const o2 = r.observeObservers(s, logReg(log, 'old2'));
        r.dispose(s); assert.equal(lc(), 0);
        const s2 = reuse(r, n);
        r.observeObservers(s2, logReg(log, 'N1')); r.observeObservers(s2, logReg(log, 'N2'));
        o1(); o2(); o1();
        assert.equal(lc(), 1);
        readThenStop(r, s2);
        assert.deepEqual(log, ['N1.c', 'N2.c', 'N1.d', 'N2.d']);
        r.destroy();
    });
    // H1 (REPORT blocker 1, probe P1): user code writing this.live must not corrupt the registration.
    it('H1 this-write: opts that set this.live in their callbacks still cycle [c,d,c,d]; off() -> lc 0', () => {
        const r = mk(); const lc = lcOf(r); const s = r.signal(0); const log = [];
        const off = r.observeObservers(s, {
            live: false,
            // The guard keeps the row strict-mode-safe on the fixed engine (this === undefined); the old engine (this = reg) still corrupts.
            onConnect() { if (this !== undefined) this.live = true; log.push('c'); },
            onDisconnect() { if (this !== undefined) this.live = false; log.push('d'); },
        });
        readThenStop(r, s); readThenStop(r, s);
        assert.deepEqual(log, ['c', 'd', 'c', 'd']);
        assert.equal(lc(), 1);
        off();
        assert.equal(lc(), 0);
        r.destroy();
    });
    // H2: callbacks are called with this === undefined (not the internal record), for every registration.
    it('H2 this === undefined in onConnect and onDisconnect of BOTH regs on one node', () => {
        const r = mk(); const s = r.signal(0); const seen = [];
        function mkReg(tag) {
            return {
                onConnect() { seen.push([tag + '.c', this === undefined, typeof this]); },
                onDisconnect() { seen.push([tag + '.d', this === undefined, typeof this]); },
            };
        }
        r.observeObservers(s, mkReg('A')); r.observeObservers(s, mkReg('B'));
        readThenStop(r, s);
        assert.deepEqual(seen, [
            ['A.c', true, 'undefined'], ['B.c', true, 'undefined'],
            ['A.d', true, 'undefined'], ['B.d', true, 'undefined'],
        ]);
        r.destroy();
    });
    // H3 (REPORT blocker 2, probe P4): kills M2 (reg.next = null in off): a fire walking through an off'd reg continues.
    it('self-off in its own onConnect: B, C still fire; later cycle B, C only', () => { const r = mk(); const lc = lcOf(r); const s = r.signal(0); const log = []; let offA = null; offA = r.observeObservers(s, logReg(log, 'A', { c: () => { offA(); } })); r.observeObservers(s, logReg(log, 'B')); r.observeObservers(s, logReg(log, 'C')); readThenStop(r, s); assert.deepEqual(log, ['A.c', 'B.c', 'C.c', 'B.d', 'C.d']); readThenStop(r, s); assert.deepEqual(log, ['A.c', 'B.c', 'C.c', 'B.d', 'C.d', 'B.c', 'C.c', 'B.d', 'C.d']); assert.equal(lc(), 1); r.destroy(); });
});

describe('A5a throws (OQ1 = A)', () => {
    const E1 = new Error('boom1'), E2 = new Error('boom2'), E3 = new Error('boom3');
    const op3Log = (r) => { const l = []; r.onGraphMutation((op, a, b) => { if (op === 3) l.push(a + '->' + b); }); return l; };
    function readC(r, S) { const C = r.computed(() => S()); let got = null; try { C(); } catch (e) { got = e; } return { C, got }; }
    it('reg1 throws on connect: reg2 still fires; the single error is rethrown as-is (identity); op 3 exactly once', () => {
        const r = mk(); const ops = op3Log(r); const log = []; const S = r.signal(1);
        r.observeObservers(S, { onConnect: () => { log.push('A'); throw E1; } });
        r.observeObservers(S, { onConnect: () => { log.push('B'); } });
        const { C, got } = readC(r, S);
        assert.equal(got, E1);
        assert.deepEqual(log, ['A', 'B']);
        assert.deepEqual(ops, [r.nodeId(S) + '->' + r.nodeId(C)]);
        r.destroy();
    });
    it('two throws on connect (with a quiet reg between): AggregateError, .errors === [E1, E3] in order; all 3 fire; op 3 once', () => {
        const r = mk(); const ops = op3Log(r); const log = []; const S = r.signal(1);
        r.observeObservers(S, { onConnect: () => { log.push('A'); throw E1; } });
        r.observeObservers(S, { onConnect: () => { log.push('B'); } });
        r.observeObservers(S, { onConnect: () => { log.push('C'); throw E3; } });
        const { C, got } = readC(r, S);
        assert.ok(got instanceof AggregateError, 'got ' + got);
        assert.equal(got.errors.length, 2);
        assert.equal(got.errors[0], E1); assert.equal(got.errors[1], E3);
        assert.deepEqual(log, ['A', 'B', 'C']);
        assert.deepEqual(ops, [r.nodeId(S) + '->' + r.nodeId(C)]);
        r.destroy();
    });
    it('three throws on connect: .errors in registration order [E1, E2, E3]', () => {
        const r = mk(); const S = r.signal(1);
        r.observeObservers(S, { onConnect: () => { throw E1; } });
        r.observeObservers(S, { onConnect: () => { throw E2; } });
        r.observeObservers(S, { onConnect: () => { throw E3; } });
        const { got } = readC(r, S);
        assert.ok(got instanceof AggregateError);
        assert.deepEqual(got.errors, [E1, E2, E3]);
        r.destroy();
    });
    it('reg1 throws on disconnect: reg2 onDisconnect still fires; error surfaces from stop() as-is', () => {
        const r = mk(); const S = r.signal(1); const log = [];
        r.observeObservers(S, { onDisconnect: () => { log.push('A.d'); throw E1; } });
        r.observeObservers(S, { onDisconnect: () => { log.push('B.d'); } });
        const stop = r.effect(() => { S(); });
        let got = null; try { stop(); } catch (e) { got = e; }
        assert.deepEqual(log, ['A.d', 'B.d']);
        assert.equal(got, E1);
        r.destroy();
    });
});

describe('A5a F-b: fireDisconnect restores currentObserver', () => {
    it('inner effect stopped inside E body fires A.onDisconnect there; B read after it stays tracked (write B re-runs E)', () => {
        const r = mk(); const log = []; const A = r.signal(0), B = r.signal(0), flag = r.signal(0);
        r.observeObservers(A, logReg(log, 'A'));
        let innerStop = r.effect(() => { A(); });
        let runs = 0;
        r.effect(() => {
            runs++; flag();
            if (innerStop !== null) { const st = innerStop; innerStop = null; st(); }   // A 1->0 inside E's body
            B();
        });
        assert.deepEqual(log, ['A.c', 'A.d']);
        assert.equal(runs, 1);
        B.set(1);
        assert.equal(runs, 2, 'B was untracked: onDisconnect left currentObserver null');
        flag.set(1);
        assert.equal(runs, 3);
        r.destroy();
    });
});

const HAVE_GC = typeof globalThis.gc === 'function';
const nap = (ms) => new Promise((res) => setTimeout(res, ms));
describe('A5a F-a RETENTION: dispose drops every registration and its callbacks (offs kept, never called)', { skip: HAVE_GC ? false : 'needs --expose-gc' }, () => {
    const settle = async () => { globalThis.gc(); await nap(0); globalThis.gc(); };
    async function run(nodes, doDispose) {
        const r = mk();
        const tracker = createLeakTracker({ name: 't84', onLeak() {}, onWarning() {} });
        const offs = [], sigs = [];
        for (let i = 0; i < nodes; i++) {
            const s = r.signal(0); sigs.push(s);
            for (let k = 0; k < 3; k++) {
                const obj = { i, k }; tracker.track(obj, null, i * 3 + k);
                offs.push(r.observeObservers(s, { onConnect: () => { void obj; }, onDisconnect: () => { void obj; } }));
            }
        }
        if (doDispose) for (const s of sigs) r.dispose(s);
        sigs.length = 0;
        for (let i = 0; i < 30 && tracker.size() > 0 && doDispose; i++) { await settle(); await nap(10); }
        await settle(); await settle();
        const size = tracker.size(); void offs.length;
        return size;
    }
    it('1 node x 3 regs: tracker.size() 0 after dispose + gc', async () => { assert.equal(await run(1, true), 0); });
    it('100 nodes x 3 regs: tracker.size() 0 after dispose + gc', async () => { assert.equal(await run(100, true), 0); });
    it('CONTROL (must-fail shape): no dispose -> all 300 closures stay retained (size === 300)', async () => { assert.equal(await run(100, false), 300); });
});
