// test/88-soak-recycle.test.mjs -- burst 129, R4a batch H1 (PLAN-R4-recycle-sched.md TASK 3 + ASSERTIONS 2 + addenda O9-O11, M5).
// Oracle: the interface contract of bench/soak/oracles.mjs (O9: checkO9Read / checkO9Write / checkO9Dispose) and the T0 kernel
// facts (.handoff/b129-evidence/r4a/T0-FACTS.md, re-verified by .handoff/b129-evidence/r4a-h1/probe.mjs). No value is copied
// from a run of the new code. LEDGER #51 (stale update leaked the resident value to fn; M5 / D-b129-1) is PINNED since b137 (checkO9Update + adapter world.update rows at the end).
// Groups: REG, ORACLE (fires / silent), MALFORMED (TypeError matrix), KERNEL (live Signal.js), MUTANT (kernels built at runtime).
// Oracle rows are new (no prior O9 export): they fail on the old code by import. KERNEL rows are regression pins of engine facts.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../bench/soak/oracles.mjs';
import { createRegistry } from '../Signal.js';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liteS3Adapter } from '../bench/soak/adapters/lite-s3.mjs';
import { GcProfiler } from '@zakkster/lite-gc-profiler';

const { checkO9Read, checkO9Write, checkO9Dispose, ORACLES, SIGS } = O;
const SIG_URL = new URL('../Signal.js', import.meta.url);
const WATCH_URL = new URL('../Watch.js', import.meta.url);

const expectFind = (r, sig) => {
    assert.notEqual(r, null);
    assert.equal(r.oracle, 'O9');
    assert.equal(r.sig, sig);
    assert.equal(typeof r.detail, 'string');
};

describe('O9 registration', () => {
    it('ORACLES ends with O9 and SIGS.O9 is [stale-write, stale-read, stale-dispose, stale-thunk], SIGS frozen', () => {
        assert.equal(ORACLES[ORACLES.length - 1], 'O9');
        assert.deepEqual(SIGS.O9, ['stale-write', 'stale-read', 'stale-dispose', 'stale-thunk']);
        assert.ok(Object.isFrozen(SIGS));
    });
});

describe('ORACLE: checkO9Read', () => {
    it('stale peek returning 7 -> stale-read', () => expectFind(checkO9Read('peek', 7), 'stale-read'));
    it('stale read returning null -> stale-read (null is a value)', () => expectFind(checkO9Read('read', null), 'stale-read'));
    it('returning 0 -> stale-read', () => expectFind(checkO9Read('peek', 0), 'stale-read'));
    it('returning undefined -> null', () => assert.equal(checkO9Read('peek', undefined), null));
});

describe('ORACLE: checkO9Write', () => {
    it('resident changed (mism 1) -> stale-write', () => expectFind(checkO9Write('set', 1, 0), 'stale-write'));
    it('an effect ran (ran 1) -> stale-write', () => expectFind(checkO9Write('set', 0, 1), 'stale-write'));
    it('both -> stale-write', () => expectFind(checkO9Write('set', 3, 2), 'stale-write'));
    it('0 / 0 -> null', () => assert.equal(checkO9Write('set', 0, 0), null));
});

describe('ORACLE: checkO9Dispose', () => {
    it('activeNodes dropped by 1 -> stale-dispose', () => expectFind(checkO9Dispose('d', 5, 4, 3, 3, 0), 'stale-dispose'));
    it('activeNodes rose -> stale-dispose', () => expectFind(checkO9Dispose('d', 5, 6, 3, 3, 0), 'stale-dispose'));
    it('links moved -> stale-dispose', () => expectFind(checkO9Dispose('d', 5, 5, 3, 2, 0), 'stale-dispose'));
    it('liveUndef 1 -> stale-dispose', () => expectFind(checkO9Dispose('d', 5, 5, 3, 3, 1), 'stale-dispose'));
    it('nothing moved -> null', () => assert.equal(checkO9Dispose('d', 5, 5, 3, 3, 0), null));
    it('nothing moved at zero -> null', () => assert.equal(checkO9Dispose('d', 0, 0, 0, 0, 0), null));
});

describe('MALFORMED: TypeError matrix', () => {
    const BAD = [-0, NaN, 1.5, -1, '1', null, undefined, Infinity, 2 ** 53, Object(1)];
    const nm = (v) => (Object.is(v, -0) ? '-0' : typeof v + ' ' + String(v));
    const TE = /^TypeError: checkO9(Read|Write|Dispose): /;
    const BADL = [7, null, undefined, {}, [], -0];
    it('checkO9Read: bad labels', () => { for (const l of BADL) assert.throws(() => checkO9Read(l, undefined), TE); });
    it('checkO9Write: bad labels', () => { for (const l of BADL) assert.throws(() => checkO9Write(l, 0, 0), TE); });
    it('checkO9Dispose: bad labels', () => { for (const l of BADL) assert.throws(() => checkO9Dispose(l, 1, 1, 1, 1, 0), TE); });
    for (const v of BAD) {
        it('checkO9Write mism = ' + nm(v), () => assert.throws(() => checkO9Write('w', v, 0), TE));
        it('checkO9Write ran = ' + nm(v), () => assert.throws(() => checkO9Write('w', 0, v), TE));
        for (let pos = 1; pos <= 5; pos++) {
            it('checkO9Dispose count #' + pos + ' = ' + nm(v), () => {
                const a = [1, 1, 1, 1, 0];
                a[pos - 1] = v;
                assert.throws(() => checkO9Dispose('d', ...a), TE);
            });
        }
    }
    it('fail closed even when the bad count would otherwise hide a finding', () => {
        assert.throws(() => checkO9Write('w', 1, NaN), TE);
        assert.throws(() => checkO9Write('w', NaN, 1), TE);
        assert.throws(() => checkO9Dispose('d', 1, 2, 1, 1, NaN), TE);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Scenario driver: works on any kernel module (live or mutant). Facts (T0 b, LIFO free list): dispose a handle, the next
// create of any kind takes its slot. Returns observations; the callers feed the oracles.
const mkReg = (K) => K.createRegistry({ maxNodes: 4096, onCapacityExceeded: 'grow' });
const mkResident = (r, kind, src, onRun) => {
    if (kind === 'signal') return r.signal(5);
    if (kind === 'computed') { const c = r.computed(() => src() + 2); c(); return c; }   // src 3 -> 5
    return r.effect(() => { src(); onRun(); });
};
// stale SIGNAL handle (kind 'signal' staleKind) recycled into `kind`; watcher effect on the resident when it is a value node
const staleSignalCase = (K, kind) => {
    const r = mkReg(K);
    const src = r.signal(3);
    const stale = r.signal(1);
    r.dispose(stale);
    let runs = 0;
    const res = mkResident(r, kind, src, () => { runs++; });
    let watcher = null;
    if (kind !== 'effect') watcher = r.effect(() => { res(); runs++; });
    assert.equal(ptrOf(res), ptrOf(stale), 'resident took the stale slot (LIFO)');
    runs = 0;
    return { r, src, stale, res, kind, getRuns: () => runs, resetRuns: () => { runs = 0; }, watcher };
};
const ptrOf = (h) => h[Object.getOwnPropertySymbols(h).find((y) => y.description === 'node_ptr')];
const residentPeek = (c) => (c.kind === 'effect' ? undefined : c.res.peek());

const KINDS = ['signal', 'computed', 'effect'];

const readRows = (K, label) => {
    for (const kind of KINDS) {
        it(label + ': stale peek/read -> undefined, resident ' + kind, () => {
            const c = staleSignalCase(K, kind);
            assert.equal(checkO9Read('peek', c.stale.peek()), null);
            assert.equal(checkO9Read('read', c.stale()), null);
            assert.equal(c.stale.peek(), undefined);
        });
    }
};

describe('KERNEL: stale-handle facts on live Signal.js', () => {
    readRows({ createRegistry }, 'live');

    for (const kind of KINDS) {
        it('stale set: resident ' + kind + ' unchanged, 0 effect runs', () => {
            const c = staleSignalCase({ createRegistry }, kind);
            const before = residentPeek(c);
            c.resetRuns();
            c.stale.set(99);
            const mism = kind === 'effect' ? 0 : (c.res.peek() === before ? 0 : 1);
            assert.equal(checkO9Write('set', mism, c.getRuns()), null);
            if (kind !== 'effect') assert.equal(c.res.peek(), 5);
            // resident still live: a source change still reaches it
            c.src.set(11);
            if (kind === 'computed') assert.equal(c.res.peek(), 13);
            if (kind === 'effect') assert.equal(c.getRuns(), 1);
        });
        it('stale r.dispose(h): stats unchanged, resident ' + kind + ' alive', () => {
            const c = staleSignalCase({ createRegistry }, kind);
            const s0 = c.r.stats();
            c.r.dispose(c.stale);
            const s1 = c.r.stats();
            let liveUndef = 0;
            if (kind !== 'effect' && c.res.peek() === undefined) liveUndef++;
            assert.equal(checkO9Dispose('d', s0.activeNodes, s1.activeNodes, s0.activeLinks, s1.activeLinks, liveUndef), null);
            assert.equal(s1.activeNodes, s0.activeNodes);
            assert.equal(s1.activeLinks, s0.activeLinks);
            c.resetRuns();
            c.src.set(11);
            if (kind === 'effect') assert.equal(c.getRuns(), 1, 'effect resident still runs');
            else assert.equal(c.res.peek(), kind === 'signal' ? 5 : 13);
        });
    }

    it('stale computed handle recycled into signal/computed/effect: read/peek undefined, dispose no-op', () => {
        for (const kind of KINDS) {
            const r = mkReg({ createRegistry });
            const src = r.signal(3);
            const stale = r.computed(() => src() + 1);
            r.dispose(stale);
            const res = mkResident(r, kind, src, () => {});
            assert.equal(ptrOf(res), ptrOf(stale), kind + ' took the stale slot');
            const s0 = r.stats();
            assert.equal(checkO9Read('peek', stale.peek()), null);
            assert.equal(checkO9Read('read', stale()), null);
            r.dispose(stale);
            const s1 = r.stats();
            assert.equal(checkO9Dispose('d', s0.activeNodes, s1.activeNodes, s0.activeLinks, s1.activeLinks, 0), null);
            if (kind !== 'effect') assert.equal(res.peek(), 5);
        }
    });

    it('stale effect handle recycled: dispose is a no-op, resident effect keeps running', () => {
        const r = mkReg({ createRegistry });
        const src = r.signal(3);
        const stale = r.effect(() => { src(); });
        r.dispose(stale);
        let runs = 0;
        const res = r.effect(() => { src(); runs++; });
        assert.equal(ptrOf(res), ptrOf(stale), 'effect took the stale slot');
        runs = 0;
        const s0 = r.stats();
        r.dispose(stale);
        stale();
        const s1 = r.stats();
        assert.equal(checkO9Dispose('d', s0.activeNodes, s1.activeNodes, s0.activeLinks, s1.activeLinks, 0), null);
        src.set(4);
        assert.equal(runs, 1);
        assert.equal(typeof res, 'function');
    });

    it('stale set on a dead UNRECYCLED signal handle is silent', () => {
        const r = mkReg({ createRegistry });
        const src = r.signal(3);
        let runs = 0;
        r.effect(() => { src(); runs++; });
        const h = r.signal(1);
        r.dispose(h);
        const s0 = r.stats();
        runs = 0;
        h.set(9);
        assert.equal(checkO9Write('set', 0, runs), null);
        assert.equal(checkO9Read('peek', h.peek()), null);
        assert.equal(checkO9Read('read', h()), null);
        r.dispose(h);
        const s1 = r.stats();
        assert.equal(checkO9Dispose('d', s0.activeNodes, s1.activeNodes, s0.activeLinks, s1.activeLinks, 0), null);
    });

    it('multi-gen A: one slot recycled 2x (signal x3), 2 stale handles, live h2 keeps 5', () => {
        const r = mkReg({ createRegistry });
        const h0 = r.signal(1);
        r.dispose(h0);
        const h1 = r.signal(2);
        r.dispose(h1);
        const h2 = r.signal(5);
        assert.ok(ptrOf(h0) === ptrOf(h2) && ptrOf(h1) === ptrOf(h2), 'one slot, 3 generations');
        let runs = 0;
        r.effect(() => { h2(); runs++; });
        runs = 0;
        const s0 = r.stats();
        for (const h of [h0, h1]) {
            assert.equal(checkO9Read('peek', h.peek()), null);
            assert.equal(checkO9Read('read', h()), null);
            h.set(99);
            r.dispose(h);
        }
        const s1 = r.stats();
        assert.equal(checkO9Write('set', h2.peek() === 5 ? 0 : 1, runs), null);
        assert.equal(checkO9Dispose('d', s0.activeNodes, s1.activeNodes, s0.activeLinks, s1.activeLinks, h2.peek() === undefined ? 1 : 0), null);
        assert.equal(h2.peek(), 5);
    });

    it('multi-gen B across kinds: signal -> computed -> live effect in one slot', () => {
        const r = mkReg({ createRegistry });
        const src = r.signal(3);
        const h0 = r.signal(1);
        r.dispose(h0);
        const h1 = r.computed(() => src() + 1);
        r.dispose(h1);
        let runs = 0;
        const e = r.effect(() => { src(); runs++; });
        assert.ok(ptrOf(h0) === ptrOf(h1) && ptrOf(h1) === ptrOf(e), 'one slot: signal -> computed -> effect');
        runs = 0;
        const s0 = r.stats();
        h0.set(99);
        assert.equal(checkO9Write('set', 0, runs), null);
        assert.equal(checkO9Read('peek', h0.peek()), null);
        assert.equal(checkO9Read('read', h0()), null);
        assert.equal(checkO9Read('peek', h1.peek()), null);
        assert.equal(checkO9Read('read', h1()), null);
        r.dispose(h0);
        r.dispose(h1);
        const s1 = r.stats();
        assert.equal(checkO9Dispose('d', s0.activeNodes, s1.activeNodes, s0.activeLinks, s1.activeLinks, 0), null);
        src.set(4);
        assert.equal(runs, 1, 'effect still alive');
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// MUTANTS: kernels built at runtime from the live Signal.js text (count-checked anchors), imported from a tmpdir.
const SRC = readFileSync(fileURLToPath(SIG_URL), 'utf8');
const count = (s, a) => s.split(a).length - 1;
const ANCHORS = {
    setgen: ['        read.set = (value) => {\n            if (node.gen !== birthGen) return;\n', '        read.set = (value) => {\n            /* MUT */\n'],
    readgen: ['        if (this[NODE_GEN] !== node.gen) return undefined;   // stale handle: slot recycled (ABA guard, matches read())\n', ''],
    dispgen: ['        if (api[NODE_GEN] !== node.gen) return;\n', ''],
};
let mutSeq = 0;
const buildMutant = async (id) => {
    const [anchor, repl] = ANCHORS[id];
    assert.equal(count(SRC, anchor), 1, id + ' anchor must occur exactly once');
    const dir = mkdtempSync(join(tmpdir(), 'h1-rc-' + id + '-'));
    try {
        writeFileSync(join(dir, 'Signal.js'), SRC.replace(anchor, () => repl));
        copyFileSync(fileURLToPath(WATCH_URL), join(dir, 'Watch.js'));
        const K = await import(pathToFileURL(join(dir, 'Signal.js')).href + '?m=' + (++mutSeq));
        return K;
    } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('MUTANT: the oracles have teeth on the engine', () => {
    it('anchors occur exactly once in the live Signal.js', () => {
        for (const id of Object.keys(ANCHORS)) assert.equal(count(SRC, ANCHORS[id][0]), 1, id);
    });
    it('control: the unmutated copy path is clean (no finding on a recycled signal/computed/effect)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'h1-rc-ctl-'));
        try {
            writeFileSync(join(dir, 'Signal.js'), SRC);
            copyFileSync(fileURLToPath(WATCH_URL), join(dir, 'Watch.js'));
            const K = await import(pathToFileURL(join(dir, 'Signal.js')).href + '?m=ctl');
            for (const kind of KINDS) {
                const c = staleSignalCase(K, kind);
                assert.equal(checkO9Read('peek', c.stale.peek()), null);
                c.stale.set(99);
                assert.equal(checkO9Write('set', kind === 'effect' ? 0 : (c.res.peek() === 5 ? 0 : 1), c.getRuns()), null);
            }
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('T-RC-setgen -> stale-write (resident changes, effect runs) for signal and computed-hosting slots', async () => {
        const K = await buildMutant('setgen');
        // signal resident: the stale set overwrites 5 with 99 and wakes the watcher (T0 d: resident 5 -> 99 + 1 run)
        const c = staleSignalCase(K, 'signal');
        c.stale.set(99);
        const mism = c.res.peek() === 5 ? 0 : 1;
        expectFind(checkO9Write('set', mism, c.getRuns()), 'stale-write');
        assert.equal(mism, 1);
        assert.equal(c.getRuns(), 1);
    });
    it('T-RC-setgen -> stale-write on the signal-resident multi-gen shape', async () => {
        const K = await buildMutant('setgen');
        const r = mkReg(K);
        const h0 = r.signal(1); r.dispose(h0);
        const h1 = r.signal(2); r.dispose(h1);
        const h2 = r.signal(5);
        let runs = 0;
        r.effect(() => { h2(); runs++; });
        runs = 0;
        h1.set(99);
        expectFind(checkO9Write('set', h2.peek() === 5 ? 0 : 1, runs), 'stale-write');
    });

    it('T-RC-readgen -> stale-read on a stale SIGNAL peek recycled into a signal', async () => {
        const K = await buildMutant('readgen');
        const c = staleSignalCase(K, 'signal');
        expectFind(checkO9Read('peek', c.stale.peek()), 'stale-read');
        assert.equal(c.stale.peek(), 5);
    });
    it('T-RC-readgen -> stale-read on a stale SIGNAL peek recycled into a computed', async () => {
        const K = await buildMutant('readgen');
        const c = staleSignalCase(K, 'computed');
        expectFind(checkO9Read('peek', c.stale.peek()), 'stale-read');
        assert.equal(c.stale.peek(), 5);
    });
    it('T-RC-readgen leaves read() guarded (T0 S5): read stays undefined', async () => {
        const K = await buildMutant('readgen');
        const c = staleSignalCase(K, 'signal');
        assert.equal(checkO9Read('read', c.stale()), null);
    });

    for (const stale of ['signal', 'computed', 'effect']) {
        it('T-RC-dispgen -> stale-dispose via r.dispose(stale ' + stale + ') into a signal resident', async () => {
            const K = await buildMutant('dispgen');
            const r = mkReg(K);
            const src = r.signal(3);
            const h = stale === 'signal' ? r.signal(1) : stale === 'computed' ? r.computed(() => src() + 1) : r.effect(() => { src(); });
            r.dispose(h);
            const res = r.signal(5);
            const s0 = r.stats();
            r.dispose(h);
            const s1 = r.stats();
            const liveUndef = res.peek() === undefined ? 1 : 0;
            expectFind(checkO9Dispose('d', s0.activeNodes, s1.activeNodes, s0.activeLinks, s1.activeLinks, liveUndef), 'stale-dispose');
            assert.equal(s1.activeNodes, s0.activeNodes - 1);
        });
    }
});

// ---------------------------------------------------------------------------------------------------------------------
// burst 130 H3: RcState teardown + the stateOf fail-closed guard (reviewer mutants LM3 / LM2 survived every earlier gate).
// Oracle: the lane header contract (close() nulls the whole ring of RING = 8 handles + 8 kinds and never throws; a state
// whose slot replay is ahead of exec.H fails closed with "slot replay ahead of exec.H"). Values are the spec's, not a run's.
import { RcState, RECYCLE } from '../bench/soak/lanes/recycle.mjs';

describe('RECYCLE lane: RcState teardown and the stateOf guard (b130 H3)', () => {
    it('close() nulls all 16 ring entries (hs + hk) after the ring is filled; a second close() does not throw', () => {
        const rc = new RcState();
        assert.equal(rc.hs.length, 8);
        assert.equal(rc.hk.length, 8);
        for (let j = 0; j < 8; j++) { rc.hs[j] = function stale() {}; rc.hk[j] = 'sce'[j % 3]; }
        rc.close();
        for (let j = 0; j < 8; j++) { assert.equal(rc.hs[j], null, 'hs[' + j + ']'); assert.equal(rc.hk[j], null, 'hk[' + j + ']'); }
        assert.doesNotThrow(() => rc.close());
        assert.doesNotThrow(() => rc.close());
    });
    it('close() on one RcState does not touch another (no shared ring across states)', () => {
        const a = new RcState(), b = new RcState();
        b.hs[3] = function keep() {}; b.hk[3] = 's';
        a.hs[3] = function drop() {}; a.hk[3] = 'c';
        a.close();
        assert.equal(typeof b.hs[3], 'function');
        assert.equal(b.hk[3], 's');
    });
    it('state reused by a later world (slot replay ahead of exec.H) fails closed with the unmodelled finding', () => {
        const rc = new RcState();
        // world 1: the replay catches up with a 5-entry H (holes = no nodes; only H.length matters)
        const x1 = { rc, H: new Array(5), unmodelled: null };
        assert.throws(() => RECYCLE.ops.rdisp(x1, { s: 99 }), /ring index/);   // stateOf ran first: seen is now 5
        assert.equal(rc.seen, 5);
        // world 2 reuses the same state with a shorter H (LM2: one RcState shared across worlds)
        const x2 = { rc, H: new Array(2), unmodelled: null };
        assert.throws(() => RECYCLE.ops.rdisp(x2, { s: 0 }), /slot replay ahead of exec\.H \(5 > 2\)/);
        assert.ok(x2.unmodelled instanceof Error);
        assert.match(x2.unmodelled.message, /unmodelled recycle op: slot replay ahead of exec\.H/);
    });
    it('each world gets its own fresh RcState from stateOf (x.rc = null at world start; a bad ring index ends the op after stateOf)', () => {
        const x1 = { rc: null, H: new Array(5), unmodelled: null };
        assert.throws(() => RECYCLE.ops.rdisp(x1, { s: 99 }), /ring index/);
        assert.ok(x1.rc instanceof RcState);
        assert.equal(x1.rc.seen, 5);
        const x2 = { rc: null, H: new Array(2), unmodelled: null };
        assert.throws(() => RECYCLE.ops.rdisp(x2, { s: 99 }), /ring index/);   // not the replay-ahead guard: world 2 starts clean
        assert.ok(x2.rc instanceof RcState);
        assert.notEqual(x2.rc, x1.rc);
        assert.equal(x2.rc.seen, 2);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// b137 B3 (PLAN-b137 A1 / A2 / A5; D-b135-1: a STALE signal handle's update(fn) returns undefined WITHOUT calling fn).
// Expected values come from the plan assertions, never from a run. Rows fail on the old engine (fn called once).
describe('ORACLE: checkO9Update (b137 A1)', () => {
    const chk = (...a) => O.checkO9Update(...a);
    it('("u", 0, undefined) -> null', () => assert.equal(chk('u', 0, undefined), null));
    it('fn called once (1, undefined) -> stale-write', () => expectFind(chk('u', 1, undefined), 'stale-write'));
    it('fn not called but returned 5 -> stale-write', () => expectFind(chk('u', 0, 5), 'stale-write'));
    it('fn not called but returned null -> stale-write (null is a value)', () => expectFind(chk('u', 0, null), 'stale-write'));
    const TU = /^TypeError: checkO9Update: /;
    const nm = (v) => (Object.is(v, -0) ? '-0' : typeof v + ' ' + String(v));
    for (const v of [-1, 1.5, NaN, '1', -0]) it('calls = ' + nm(v) + ' throws TypeError', () => assert.throws(() => chk('u', v, undefined), TU));
    for (const l of [7, null, undefined, {}, [], -0]) it('bad label ' + nm(l) + ' throws TypeError', () => assert.throws(() => chk(l, 0, undefined), TU));
});

describe('ADAPTER: world.update on a stale signal handle (b137 A2)', () => {
    const KINDS3 = ['signal', 'computed', 'effect', 'dead'];
    for (const kind of KINDS3) {
        it('stale signal handle, slot ' + (kind === 'dead' ? 'dead (unrecycled)' : 'recycled to ' + kind) + ': fn 0 calls, undefined, resident unchanged', () => {
            const w = liteS3Adapter.open();
            try {
                const src = w.signal(3);
                const stale = w.signal(1);
                w.dispose(stale);
                let runs = 0;
                let res = null;
                if (kind === 'signal') res = w.signal(5);
                else if (kind === 'computed') { res = w.computed(() => w.read(src) + 2); w.read(res); }
                else if (kind === 'effect') res = w.effect(() => { w.read(src); runs++; });
                if (res !== null) assert.equal(ptrOf(res), ptrOf(stale), 'resident took the stale slot (LIFO)');
                runs = 0;
                let calls = 0;
                const countingFn = (v) => { calls++; return 99; };
                const got = w.update(stale, countingFn);
                assert.equal(calls, 0, 'fn must not be called');
                assert.equal(got, undefined);
                assert.equal(checkO9UpdateOrFail('u', calls, got), null);
                if (kind === 'signal' || kind === 'computed') assert.equal(w.peek(res), 5);
                if (kind === 'effect') assert.equal(runs, 0, 'resident effect did not run');
            } finally { w.close(); }
        });
    }
});
const checkO9UpdateOrFail = (l, c, g) => O.checkO9Update(l, c, g);

describe('ADAPTER GC: 1e6 stale world.update (b137 A5)', { skip: typeof globalThis.gc === 'function' ? false : 'needs --expose-gc' }, () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    // same window shape as test/91 A3: warm + gc first, then measure minor GC count and whole-window heap growth
    async function window(step, iters) {
        for (let i = 0; i < 300000; i++) step();
        globalThis.gc(); await sleep(20);
        for (let i = 0; i < 100000; i++) step();
        globalThis.gc(); await sleep(50);
        const gcp = new GcProfiler().start();
        const h0 = process.memoryUsage().heapUsed;
        for (let i = 0; i < iters; i++) step();
        await sleep(50);
        const sum = gcp.summary(); gcp.stop();
        globalThis.gc();
        return { minor: sum.gc.minor, grewBpo: (process.memoryUsage().heapUsed - h0) / iters };
    }
    const mk = (fn) => {
        const w = liteS3Adapter.open();
        const stale = w.signal(1);
        w.dispose(stale);
        w.signal(5);
        let sink = 0;
        return () => { const x = w.update(stale, fn); sink = (sink + (x === undefined ? 1 : 2)) | 0; return sink; };
    };
    const pure = (v) => v;
    it('1e6 stale updates: minor 0, < 0.5 B/op whole-window', async () => {
        const m = await window(mk(pure), 1000000);
        assert.equal(m.minor, 0, 'scavenge: transient per-update alloc');
        assert.ok(m.grewBpo < 0.5, 'B/op ' + m.grewBpo);
    });
    // CONTROL: fn would allocate transiently into a sink IF it were called; on a LIVE handle it must trip the profiler.
    let lastBox = null;
    it('CONTROL (transient sink, live handle): minor >= 1 and growth < 0.5 B/op', async () => {
        const w = liteS3Adapter.open();
        const live = w.signal(1);
        // [v] (~16-32 B) x 1e6 calls > the 16 MB semi-space: a transient this size must scavenge
        const fn = (v) => { lastBox = [v]; return (v + 1) & 1023; };
        const step = () => { w.update(live, fn); };
        const m = await window(step, 1000000);
        assert.ok(m.minor >= 1, 'control must scavenge: minor ' + m.minor);
        assert.ok(m.grewBpo < 0.5, 'control must be transient, not retained: ' + m.grewBpo);
    });
});
