// test/60-null-opts-no-leak.test.mjs -- burst 61 (maintainer ruling): signal / computed / signalBox / computedBox /
// effect called with `opts === null` must throw a TypeError BEFORE allocating anything (opts read hoisted above
// createNode). Oracle: the ruling's ASSERTIONS N1-N5, not a kernel run. Counters are read via stats()
// (activeNodes, signals, computeds, effects), the same as test/59.
// RED on the frozen b61-before engine (rows N2/N3/N4: the node is allocated, then the opts read throws);
// N1 and N5 are controls / pins and may pass there.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const K = await import(KPATH);

test('kernel under test', (t) => {
    const sha = createHash('sha256').update(readFileSync(KPATH)).digest('hex');
    t.diagnostic('kernel ' + KPATH + ' sha256 ' + sha);
    assert.equal(typeof K.createRegistry, 'function');
});

// Each entry: [name, call(api, opts)]. `arg` is the first argument (initial value or fn).
const ENTRIES = [
    ['signal', (api, o) => api.signal(1, o)],
    ['computed', (api, o) => api.computed(() => 1, o)],
    ['signalBox', (api, o) => api.signalBox(1, o)],
    ['computedBox', (api, o) => api.computedBox(() => 1, o)],
    ['effect', (api, o) => api.effect(() => {}, o)],
];
const KEYS = ['activeNodes', 'signals', 'computeds', 'effects'];
const snap = (api) => { const s = api.stats(); return KEYS.map((k) => s[k]); };

const TARGETS = [
    ['fresh createRegistry()', () => K.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' }), (api) => api.destroy()],
    ['module-level default exports', () => K, () => {}],
];

for (const [tname, make, done] of TARGETS) {
    describe('60: null opts allocates nothing -- ' + tname, () => {
        for (const [name, call] of ENTRIES) {
            describe(name, () => {
                it('N1 opts === null throws TypeError', () => {
                    const api = make();
                    try { assert.throws(() => call(api, null), TypeError); } finally { done(api); }
                });
                it('N2 the throwing call leaves node count and signals/computeds/effects counters unchanged', () => {
                    const api = make();
                    try {
                        const before = snap(api);
                        assert.throws(() => call(api, null), TypeError);
                        assert.deepEqual(snap(api), before);
                    } finally { done(api); }
                });
                it('N3 a normal creation afterwards works and dispose frees it', () => {
                    const api = make();
                    try {
                        const before = snap(api);
                        assert.throws(() => call(api, null), TypeError);
                        const h = call(api, undefined);
                        assert.equal(api.stats().activeNodes, before[0] + 1);
                        api.dispose(h);
                        assert.deepEqual(snap(api), before);
                    } finally { done(api); }
                });
                it('N4 100 null-opts calls accumulate nothing', () => {
                    const api = make();
                    try {
                        const before = snap(api);
                        for (let i = 0; i < 100; i++) assert.throws(() => call(api, null), TypeError);
                        assert.deepEqual(snap(api), before);
                    } finally { done(api); }
                });
                it('N5 controls: opts undefined and {} still work (+1 node each, freed by dispose)', () => {
                    const api = make();
                    try {
                        const before = snap(api);
                        const a = call(api, undefined), b = call(api, {});
                        assert.equal(api.stats().activeNodes, before[0] + 2);
                        api.dispose(a); api.dispose(b);
                        assert.deepEqual(snap(api), before);
                    } finally { done(api); }
                });
            });
        }
        // N5 value-level controls: default equals (Object.is) and no scheduler (effect body runs synchronously).
        it('N5 {} keeps default equals and no scheduler', () => {
            const api = make();
            try {
                const s = api.signal(1, {});
                let n = 0;
                const e = api.effect(() => { s(); n++; }, {});
                assert.equal(n, 1, 'no scheduler: first run is synchronous');
                s.set(1);
                assert.equal(n, 1, 'default equals: same value is not a change');
                s.set(2);
                assert.equal(n, 2);
                api.dispose(e); api.dispose(s);
            } finally { done(api); }
        });
    });
}

// ---- observeObservers(handle, opts) (b61 ruling): opts is read BEFORE the lifecycle entry is created. ----
// Black-box note: lifecycleMap / lifecycleCount are closure-private and no stats() field exposes them, and a hook-less
// entry left by `opts === null` is behaviorally invisible. The null case is witnessed white-box by O5 (below); O1/O3/O4 pin
// the null contract (throw, no accumulation, controls) and O2 uses the one observable leak: opts whose onDisconnect
// getter throws AFTER onConnect was readable. On
// the old code the entry (already holding onConnect) is left behind and fires on the next 0->1 observer connect.
for (const [tname, make, done] of TARGETS) {
    describe('60: observeObservers null/bad opts leaks no lifecycle entry -- ' + tname, () => {
        it('O1 opts === null throws TypeError', () => {
            const api = make();
            try { const s = api.signal(0); assert.throws(() => api.observeObservers(s, null), TypeError); } finally { done(api); }
        });
        it('O2 a throwing opts read leaves no hooked entry: no hook fires on a later connect', () => {
            const api = make();
            try {
                const s = api.signal(0);
                let fired = 0;
                const bad = { onConnect: () => { fired++; }, get onDisconnect() { throw new RangeError('x'); } };
                assert.throws(() => api.observeObservers(s, bad), RangeError);
                const e = api.effect(() => { s(); });          // 0 -> 1 observers
                api.dispose(e);                                 // 1 -> 0
                assert.equal(fired, 0, 'no inherited onConnect from the failed call');
                api.dispose(s);
            } finally { done(api); }
        });
        it('O3 100 null-opts calls: still TypeError each time, and a real subscription afterwards behaves', () => {
            const api = make();
            try {
                const s = api.signal(0);
                for (let i = 0; i < 100; i++) assert.throws(() => api.observeObservers(s, null), TypeError);
                let c = 0, d = 0;
                const off = api.observeObservers(s, { onConnect: () => { c++; }, onDisconnect: () => { d++; } });
                const e = api.effect(() => { s(); });
                assert.equal(c, 1);
                api.dispose(e);
                assert.equal(d, 1);
                off();
                const e2 = api.effect(() => { s(); });
                api.dispose(e2);
                assert.equal(c, 1, 'unsubscribed: no more hooks');
                api.dispose(s);
            } finally { done(api); }
        });
        it('O4 controls: undefined and {} work, return an unsubscribe', () => {
            const api = make();
            try {
                const s = api.signal(0);
                const a = api.observeObservers(s, undefined), b = api.observeObservers(s, {});
                assert.equal(typeof a, 'function'); assert.equal(typeof b, 'function');
                a(); b();
                api.dispose(s);
            } finally { done(api); }
        });
    });
}

// O5 (white-box): lifecycleCount is closure-private and a hook-less entry is behaviorally invisible, so a scratch copy
// of the kernel under test with `lifecycleCount` injected into the registry's stats() is the only witness.
const LC_ANCHOR = '    function stats() {\n        return {\n';
test('O5 white-box: a throwing observeObservers opts read (null, or either getter) leaves lifecycleCount unchanged', async () => {
    const src = readFileSync(KPATH, 'utf8');
    assert.equal(src.split(LC_ANCHOR).length, 2, 'stats() anchor must occur exactly once');
    const dir = mkdtempSync(join(tmpdir(), 'ls60-'));
    try {
        writeFileSync(join(dir, 'Signal.js'), src.replace(LC_ANCHOR, () => LC_ANCHOR + '            lifecycleCount: lifecycleCount,\n'));
        copyFileSync(join(dirname(KPATH), 'Watch.js'), join(dir, 'Watch.js'));
        const W = await import(join(dir, 'Signal.js'));
        const api = W.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
        try {
            const s = api.signal(0);
            assert.equal(api.stats().lifecycleCount, 0);
            const off = api.observeObservers(s, {});
            assert.equal(api.stats().lifecycleCount, 1, 'control: the instrument sees a live entry');
            off();
            assert.equal(api.stats().lifecycleCount, 0);
            const bad = [null, { get onConnect() { throw new RangeError('c'); } },
                { onConnect() {}, get onDisconnect() { throw new RangeError('d'); } }];
            for (const o of bad) {
                assert.throws(() => api.observeObservers(s, o));
                assert.equal(api.stats().lifecycleCount, 0);
            }
        } finally { api.destroy(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
