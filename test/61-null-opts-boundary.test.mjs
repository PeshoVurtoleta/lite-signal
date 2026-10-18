// test/61-null-opts-boundary.test.mjs -- burst 61/62: boundary probes for the null-opts contract.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? new URL('../Signal.js', import.meta.url).pathname;
const K = await import(KPATH);

const ENTRIES = [
    ['signal', (api, o) => api.signal(1, o)],
    ['computed', (api, o) => api.computed(() => 1, o)],
    ['signalBox', (api, o) => api.signalBox(1, o)],
    ['computedBox', (api, o) => api.computedBox(() => 1, o)],
    ['effect', (api, o) => api.effect(() => {}, o)],
];
const KEYS = ['activeNodes', 'signals', 'computeds', 'effects', 'activeLinks', 'nodePoolPopulation', 'totalAllocations'];
const snap = (api) => { const s = api.stats(); return KEYS.map((k) => s[k]); };
const isCap = (e) => e instanceof Error && (e.name === 'CapacityError' || String(e.message).startsWith('CapacityError'));
const countOwned = (api, h) => { let n = 0; api.forEachOwned(h, () => { n++; }); return n; };

// B1: exact capacity under onCapacityExceeded:'throw'. maxNodes 1 and 8; free slots 0 (N occupied) and 1 (N-1).
for (const N of [1, 8]) {
    describe('B1 throw policy maxNodes=' + N, () => {
        for (const [name, call] of ENTRIES) {
            it(name + ': at N (full) null -> TypeError, not CapacityError; nothing moves', () => {
                const api = K.createRegistry({ maxNodes: N, onCapacityExceeded: 'throw' });
                try {
                    for (let i = 0; i < N; i++) api.signal(0);
                    assert.throws(() => api.signal(0), isCap, 'control: pool is full');
                    const before = snap(api);
                    for (let i = 0; i < 100; i++) assert.throws(() => call(api, null), TypeError);
                    assert.deepEqual(snap(api), before);
                    assert.throws(() => call(api, undefined), isCap, 'still full: null consumed no slot and grew nothing');
                    assert.deepEqual(snap(api), before);
                } finally { api.destroy(); }
            });
            it(name + ': at N-1 null x100 -> TypeError; exactly one real creation then fits, the next is CapacityError', () => {
                const api = K.createRegistry({ maxNodes: N, onCapacityExceeded: 'throw' });
                try {
                    for (let i = 0; i < N - 1; i++) api.signal(0);
                    const before = snap(api);
                    for (let i = 0; i < 100; i++) assert.throws(() => call(api, null), TypeError);
                    assert.deepEqual(snap(api), before);
                    const h = call(api, undefined);
                    assert.equal(api.stats().activeNodes, N);
                    assert.throws(() => call(api, undefined), isCap);
                    api.dispose(h); api.dispose(h);           // duplicate dispose is a no-op
                    assert.equal(api.stats().activeNodes, N - 1);
                } finally { api.destroy(); }
            });
        }
    });
}

// B2: null opts inside an effect body / computed body / createRoot / runWithOwner leaves no dangling owned child.
describe('B2 owner tree', () => {
    it('inside an effect body (first run and re-run): owned count unchanged by null calls; control +1 per real child', () => {
        const api = K.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
        try {
            const base = snap(api);
            const tick = api.signal(0);
            const seen = [];
            const e = api.effect(() => {
                tick();
                const me = api.getOwner();
                const n0 = countOwned(api, me), a0 = api.stats().activeNodes;
                let te = 0;
                for (const [, call] of ENTRIES) { try { call(api, null); } catch (x) { if (x instanceof TypeError) te++; } }
                const n1 = countOwned(api, me), a1 = api.stats().activeNodes;
                api.computed(() => 1);                  // control: an owned child is visible to the instrument
                const n2 = countOwned(api, me);
                seen.push([te, n1 - n0, a1 - a0, n2 - n1]);
            });
            tick.set(1);
            assert.deepEqual(seen, [[5, 0, 0, 1], [5, 0, 0, 1]]);
            api.dispose(e); api.dispose(tick);
            assert.deepEqual(snap(api).slice(0, 5), base.slice(0, 5));
        } finally { api.destroy(); }
    });
    it('inside a computed body (pull path): nothing allocated, owned count unchanged', () => {
        const api = K.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
        try {
            let rec = null;
            const c = api.computed(() => {
                const me = api.getOwner();
                const n0 = countOwned(api, me), a0 = api.stats().activeNodes;
                let te = 0;
                for (const [, call] of ENTRIES) { try { call(api, null); } catch (x) { if (x instanceof TypeError) te++; } }
                rec = [te, countOwned(api, me) - n0, api.stats().activeNodes - a0];
                return 7;
            });
            assert.equal(c(), 7);
            assert.deepEqual(rec, [5, 0, 0]);
            api.dispose(c);
            assert.equal(api.stats().activeNodes, 0);
        } finally { api.destroy(); }
    });
    it('inside createRoot and runWithOwner(owner): no node, no adopted child', () => {
        const api = K.createRegistry({ maxNodes: 256, onCapacityExceeded: 'grow' });
        try {
            let owner;
            const e = api.effect(() => { owner = api.getOwner(); });
            const before = snap(api);
            const o0 = countOwned(api, owner);
            api.createRoot(() => {
                for (const [, call] of ENTRIES) assert.throws(() => call(api, null), TypeError);
            });
            api.runWithOwner(owner, () => {
                for (const [, call] of ENTRIES) assert.throws(() => call(api, null), TypeError);
            });
            assert.deepEqual(snap(api), before);
            assert.equal(countOwned(api, owner), o0);
            api.runWithOwner(owner, () => { api.computed(() => 1); });   // control
            assert.equal(countOwned(api, owner), o0 + 1);
            api.dispose(e);
            assert.equal(api.stats().activeNodes, 0);
        } finally { api.destroy(); }
    });
});

// B3: observeObservers on a stale handle: the stale-handle TypeError comes first; opts never read; no entry.
const LC_ANCHOR = '    function stats() {\n        return {\n';
test('B3 observeObservers(staleHandle, null | throwing getter): stale TypeError first, lifecycleCount unchanged, recycled slot inherits nothing', async () => {
    const src = readFileSync(KPATH, 'utf8');
    assert.equal(src.split(LC_ANCHOR).length, 2);
    const dir = mkdtempSync(join(tmpdir(), 'ls61-'));
    try {
        writeFileSync(join(dir, 'Signal.js'), src.replace(LC_ANCHOR, () => LC_ANCHOR + '            lifecycleCount: lifecycleCount,\n'));
        copyFileSync(join(dirname(KPATH), 'Watch.js'), join(dir, 'Watch.js'));
        const W = await import(join(dir, 'Signal.js'));
        const api = W.createRegistry({ maxNodes: 1, onCapacityExceeded: 'throw' });   // one slot: s2 MUST recycle s's slot
        try {
            const s = api.signal(0);
            api.dispose(s);
            let getterRan = 0;
            const bad = { get onConnect() { getterRan++; throw new RangeError('c'); } };
            const msg = /not a reactive handle/;
            assert.throws(() => api.observeObservers(s, null), (e) => e instanceof TypeError && msg.test(e.message));
            assert.throws(() => api.observeObservers(s, bad), (e) => e instanceof TypeError && msg.test(e.message));
            const s2 = api.signal(0);                    // LIFO: recycles the slot s held
            assert.deepEqual([api.stats().activeNodes, api.stats().nodePoolPopulation], [1, 1], 'control: s2 lives in the slot s held');
            assert.throws(() => api.observeObservers(s, null), (e) => e instanceof TypeError && msg.test(e.message));
            assert.throws(() => api.observeObservers(s, bad), (e) => e instanceof TypeError && msg.test(e.message));
            assert.equal(getterRan, 0, 'opts are never read for a stale handle');
            assert.equal(api.stats().lifecycleCount, 0);
            assert.equal(api.hasObservers(s2), false);
            // non-handle inputs: same TypeError, no entry
            for (const h of [null, undefined, 0, -0, NaN, 2 ** 31, '', {}, () => {}]) {
                assert.throws(() => api.observeObservers(h, null), TypeError);
            }
            assert.equal(api.stats().lifecycleCount, 0);
            api.dispose(s2);
        } finally { api.destroy(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// B4 adversarial: a THROWING opts getter (not null) and a RE-ENTRANT getter at exact capacity.
describe('B4 adversarial opts getters', () => {
    const GETTER = { signal: 'equals', computed: 'equals', signalBox: 'equals', computedBox: 'equals', effect: 'scheduler' };
    for (const [name, call] of ENTRIES) {
        it(name + ': throwing ' + GETTER[name] + ' getter at full capacity -> getter error (not CapacityError), nothing moves', () => {
            const api = K.createRegistry({ maxNodes: 2, onCapacityExceeded: 'throw' });
            try {
                api.signal(0); api.signal(0);
                const before = snap(api);
                const o = Object.defineProperty({}, GETTER[name], { get() { throw new RangeError('g'); } });
                assert.throws(() => call(api, o), RangeError);
                assert.deepEqual(snap(api), before);
            } finally { api.destroy(); }
        });
        it(name + ': re-entrant getter takes the last slot -> outer CapacityError, only the inner node lives', () => {
            const api = K.createRegistry({ maxNodes: 2, onCapacityExceeded: 'throw' });
            try {
                api.signal(0);
                let inner;
                const o = Object.defineProperty({}, GETTER[name], { get() { inner = api.signal(0); return undefined; } });
                assert.throws(() => call(api, o), isCap);
                assert.equal(api.stats().activeNodes, 2);
                api.dispose(inner);
                assert.equal(api.stats().activeNodes, 1);
            } finally { api.destroy(); }
        });
        it(name + ': falsy primitive opts (0, -0, NaN, false, "") are accepted like {} and allocate one node', () => {
            const api = K.createRegistry({ maxNodes: 16, onCapacityExceeded: 'throw' });
            try {
                for (const o of [0, -0, NaN, false, '']) {
                    const h = call(api, o);
                    assert.equal(api.stats().activeNodes, 1);
                    api.dispose(h);
                    assert.equal(api.stats().activeNodes, 0);
                }
            } finally { api.destroy(); }
        });
    }
});
