/**
 * C-RESET soak S2a (PLAN-C-RESET-soak TASK 6, ADDENDUM 1 / 2 / 2b): the adapter + config side of registry.reset().
 *
 *   contract.mjs   CAPS.reset [true, false] (CAP_KEYS), EXT_METHODS.reset ['reset']
 *   lite.mjs       caps.reset probed on the SAME throwaway registry as caps.snapshot (one createRegistry() per base
 *                  kernel); the (snapshot, reset) pair picks CAPS_LITE / CAPS_LITE_NO_SNAPSHOT / CAPS_LITE_NO_RESET /
 *                  CAPS_LITE_PRE_RESET
 *   lite-s3.mjs    world.reset() -> registry.reset(); the hook off is idempotent (D-S5: a cold done flag)
 *   lite-box.mjs   reset forwarded by the lite-s3 world spread; caps.reset is the base kernel's
 *   config.mjs     LATENCY_UNTIMED += 'reset' (b155: an unclassified world method CRASHes an armed open)
 *
 * The adapter modules are imported as namespaces, so on HEAD (cf5a78f: no reset surface) every row fails on its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as CT from '../bench/soak/adapters/contract.mjs';
import * as L from '../bench/soak/adapters/lite.mjs';
import * as S from '../bench/soak/adapters/lite-s3.mjs';
import * as B from '../bench/soak/adapters/lite-box.mjs';
import { K } from '../bench/soak/kernel.mjs';
import { LATENCY_METHODS, LATENCY_UNTIMED } from '../bench/soak/config.mjs';
import { LatencyLane } from '../bench/soak/latency.mjs';
import * as HP from '../bench/soak/controls/headpatched/Signal.js';
import * as RG from '../bench/soak/lanes/registry.mjs';
import * as LI from '../bench/soak/lanes/index.mjs';

const TREE = [
    ['lite', () => L.liteAdapter],
    ['lite-s3', () => S.liteS3Adapter],
    ['lite-box all', () => B.liteBoxAdapter],
    ['lite-box alt', () => B.liteBoxAltAdapter],
];
const WORLDS = TREE.slice(1);   // the adapters main loads (lite-s3 for SOAK_ENGINE=lite, lite-box): the reset world method

/** A small live graph: 2 signals, a computed over both, an effect over the computed (4 nodes, 3 links). */
function graphOn(w) {
    const a = w.signal(1);
    const b = w.signal(2);
    const c = w.computed(() => w.read(a) + w.read(b));
    w.effect(() => { w.read(c); });
}

/** A fixed op sequence (creation + a write) whose hook fires the rows count. */
function opsOn(w) {
    const d = w.signal(5);
    const e = w.computed(() => w.read(d) * 2);
    w.effect(() => { w.read(e); });
    w.set(d, 6);
}

/* ---- 1. contract ------------------------------------------------------------------------------------------- */

test('contract: CAPS.reset is [true, false] (frozen), CAP_KEYS lists reset last, EXT_METHODS.reset is [reset]', () => {
    assert.deepEqual(CT.CAPS.reset, [true, false]);
    assert.ok(Object.isFrozen(CT.CAPS.reset));
    assert.equal(CT.CAP_KEYS.length, 21);
    assert.equal(CT.CAP_KEYS[20], 'reset');
    assert.deepEqual(CT.EXT_METHODS.reset, ['reset']);
    assert.ok(Object.isFrozen(CT.EXT_METHODS.reset));
});

test('contract: validateAdapter accepts reset true / false, reports it missing or out of range', () => {
    const ad = (caps) => ({ name: 'x', version() {}, files() {}, open() {}, caps });
    assert.deepEqual(CT.validateAdapter(ad({ ...L.CAPS_LITE, reset: true })), []);
    assert.deepEqual(CT.validateAdapter(ad({ ...L.CAPS_LITE, reset: false })), []);
    const noReset = { ...L.CAPS_LITE };
    delete noReset.reset;
    assert.deepEqual(CT.validateAdapter(ad(noReset)), ['caps.reset is not declared']);
    assert.deepEqual(CT.validateAdapter(ad({ ...L.CAPS_LITE, reset: 'yes' })), ['caps.reset="yes" is not one of [true,false]']);
});

test('contract: validateWorld(w, caps, [reset]) demands world.reset only when the adapter declares the cap', () => {
    const w = S.liteS3Adapter.open({});
    try {
        const bare = { ...w };
        delete bare.reset;
        assert.deepEqual(CT.validateWorld(w, S.liteS3Adapter.caps, ['reset']), []);
        assert.deepEqual(CT.validateWorld(bare, S.liteS3Adapter.caps, ['reset']), ['world.reset must be a function (cap reset)']);
        assert.deepEqual(CT.validateWorld(bare, { ...S.liteS3Adapter.caps, reset: false }, ['reset']), [], 'a cap the adapter lacks is a SKIP');
    } finally { w.close(); }
});

/* ---- 2. caps.reset ------------------------------------------------------------------------------------------ */

test('caps.reset true on every tree adapter (live kernel); the four caps objects are frozen and differ only in snapshot / reset', () => {
    for (const [name, ad] of TREE) {
        assert.equal(ad().caps.reset, true, name);
        assert.deepEqual(CT.validateAdapter(ad()), [], name);
    }
    assert.equal(L.liteAdapter.caps, L.CAPS_LITE);
    assert.equal(S.liteS3Adapter.caps, L.CAPS_LITE, 'lite-s3 shares lite caps (identity)');
    assert.equal(B.liteBoxAdapter.caps, B.CAPS_LITE_BOX);
    assert.equal(B.CAPS_LITE_BOX.reset, true);
    assert.equal(L.CAPS_LITE.reset, true);
    assert.equal(L.CAPS_LITE.snapshot, true);
    assert.deepEqual(L.CAPS_LITE_NO_SNAPSHOT, { ...L.CAPS_LITE, snapshot: false });
    assert.deepEqual(L.CAPS_LITE_NO_RESET, { ...L.CAPS_LITE, reset: false });
    assert.deepEqual(L.CAPS_LITE_PRE_RESET, { ...L.CAPS_LITE, snapshot: false, reset: false });
    for (const c of [L.CAPS_LITE, L.CAPS_LITE_NO_SNAPSHOT, L.CAPS_LITE_NO_RESET, L.CAPS_LITE_PRE_RESET]) {
        assert.ok(Object.isFrozen(c));
        assert.deepEqual(Object.keys(c).sort(), CT.CAP_KEYS.slice().sort());
    }
});

test('caps.reset false: the headpatched control kernel (no reset()), a registry without reset, a throwing probe', () => {
    assert.equal(typeof HP.createRegistry().reset, 'undefined', 'fixture: headpatched has no reset()');
    assert.equal(L.liteAdapterFor(HP).caps, L.CAPS_LITE_PRE_RESET);
    assert.equal(S.liteS3AdapterFor(HP).caps.reset, false);
    const hb = B.liteBoxAdapterFor(HP, 'all').caps;
    assert.equal(hb.reset, false);
    assert.equal(hb.box, true);
    assert.deepEqual(CT.validateAdapter(L.liteAdapterFor(HP)), []);
    assert.deepEqual(CT.validateAdapter(B.liteBoxAdapterFor(HP, 'alt')), []);
    const noReset = { createRegistry(c) { const o = { ...K.createRegistry(c) }; delete o.reset; return o; } };
    assert.equal(L.liteAdapterFor(noReset).caps, L.CAPS_LITE_NO_RESET, 'snapshot kept, reset gone');
    const resetNotFn = { createRegistry(c) { return { ...K.createRegistry(c), reset: 1 }; } };
    assert.equal(L.liteAdapterFor(resetNotFn).caps.reset, false, 'a non-function reset is not the cap');
    const noSnapKeepsReset = { createRegistry(c) { const o = { ...K.createRegistry(c) }; delete o.snapshot; return o; } };
    assert.equal(L.liteAdapterFor(noSnapKeepsReset).caps, L.CAPS_LITE_NO_SNAPSHOT);
    assert.equal(L.liteAdapterFor({ createRegistry() { throw new Error('boom'); } }).caps, L.CAPS_LITE_PRE_RESET);
    assert.equal(L.liteAdapterFor({ createRegistry: K.createRegistry }).caps, L.CAPS_LITE);
});

test('caps.reset probe: shares caps.snapshot\'s ONE createRegistry() per base kernel (lite + lite-s3 + lite-box all + alt), none per open', () => {
    let n = 0;
    const kernel = { createRegistry(c) { n++; return K.createRegistry(c); } };
    const ads = [L.liteAdapterFor(kernel), S.liteS3AdapterFor(kernel), B.liteBoxAdapterFor(kernel, 'all'), B.liteBoxAdapterFor(kernel, 'alt')];
    assert.equal(n, 1);
    for (const ad of ads) { assert.equal(ad.caps.reset, true); assert.equal(ad.caps.snapshot, true); }
    let m = 0;
    const noReset = { createRegistry(c) { m++; const o = { ...K.createRegistry(c) }; delete o.reset; return o; } };
    const bds = [L.liteAdapterFor(noReset), S.liteS3AdapterFor(noReset), B.liteBoxAdapterFor(noReset, 'all')];
    assert.equal(m, 1);
    for (const ad of bds) { assert.equal(ad.caps.reset, false); assert.equal(ad.caps.snapshot, true); }
});

/* ---- 3. world.reset ----------------------------------------------------------------------------------------- */

test('world.reset() resets the registry: stats() gauges 0 after, close() residue 0 (lite-s3, lite-box all + alt)', () => {
    for (const [name, ad] of WORLDS) {
        const w = ad().open({});
        assert.equal(typeof w.reset, 'function', name);
        graphOn(w);
        const s0 = w.stats();
        assert.equal(s0.activeNodes, 4, name);
        assert.equal(s0.activeLinks, 3, name);
        w.reset();
        const s1 = w.stats();
        for (const k of ['signals', 'computeds', 'effects', 'activeNodes', 'activeLinks']) assert.equal(s1[k], 0, name + ' ' + k);
        assert.equal(s1.totalDisposals - s0.totalDisposals, 4, name + ' every live node disposed');
        assert.deepEqual(w.close(), { nodes: 0, links: 0, signals: 0, computeds: 0, effects: 0 }, name);
    }
});

test('world.reset forwards to registry.reset (not destroy): one call, and the registry stays usable after it', () => {
    for (const [name, ad] of WORLDS) {
        const w = ad().open({});
        const r = w.registry;
        const real = r.reset;
        let calls = 0;
        r.reset = function () { calls++; return real(); };
        try {
            graphOn(w);
            w.reset();
            assert.equal(calls, 1, name);
            const s = w.signal(7);
            assert.equal(w.read(s), 7, name);
            assert.equal(w.stats().activeNodes, 1, name);
        } finally {
            if (Object.hasOwn(r, 'reset') && Object.getPrototypeOf(r) !== Object.prototype) delete r.reset;
            else r.reset = real;
            w.close();
        }
    }
});

/* ---- 4. latency classification ------------------------------------------------------------------------------ */

test('LATENCY_UNTIMED lists reset; every function key of a lite-s3 / lite-box world is classified; an armed open passes reset through untimed', () => {
    assert.ok(LATENCY_UNTIMED.includes('reset'));
    assert.ok(!LATENCY_METHODS.includes('reset'));
    for (const [name, ad] of WORLDS) {
        const w = ad().open({});
        try {
            for (const k of Object.keys(w)) {
                if (typeof w[k] !== 'function') continue;
                assert.ok(LATENCY_METHODS.includes(k) || LATENCY_UNTIMED.includes(k), name + ': world method ' + k + ' unclassified');
            }
        } finally { w.close(); }
        const lane = new LatencyLane({ floorNs: 40 });
        lane.armed = true;
        const aw = lane.wrap(ad()).open({});
        try {
            graphOn(aw);
            aw.reset();
            assert.equal(aw.stats().activeNodes, 0, name);
        } finally { aw.close(); }
    }
});

/* ---- 5. idempotent hook off (D-S5) -------------------------------------------------------------------------- */

test('lite-s3 hook off is idempotent on the live kernel: twice, after reset(), after destroy(); a later hook (newest on the listener stack) fires exactly as on a fresh world', () => {
    const fw = S.liteS3Adapter.open({});
    let base = 0;
    fw.hook(() => base++);
    opsOn(fw);
    fw.close();
    assert.ok(base > 0, 'fixture: the op sequence mutates the graph');
    for (const how of ['twice', 'reset', 'destroy']) {
        for (const [name, ad] of WORLDS) {
            if (how === 'destroy' && name !== 'lite-s3') continue;   // destroy() ends the registry: one adapter suffices
            const w = ad().open({});
            let stale = 0;
            const off = w.hook(() => stale++);
            graphOn(w);
            if (how === 'destroy') {
                w.destroy();
                assert.doesNotThrow(() => { off(); off(); }, name + ' destroy: off after destroy');
                assert.doesNotThrow(() => w.close(), name + ' destroy: close() after destroy');
                continue;
            }
            if (how === 'reset') w.reset();
            off();
            off();
            const before = stale;
            let x = 0;
            const offX = w.hook(() => x++);
            off();   // a stale off after a newer hook (the engine's listener stack): must not pop it
            opsOn(w);
            assert.equal(stale, before, name + ' ' + how + ': the off listener stays off');
            assert.equal(x, base, name + ' ' + how + ': a later hook fires once per mutation');
            offX();
            offX();
            assert.doesNotThrow(() => w.close(), name + ' ' + how + ': close() re-calls every off');
        }
    }
});

test('lite-s3 hook off reaches the engine off at most once (a kernel whose off throws on a 2nd call): off twice, then close()', () => {
    let engineOffs = 0;
    const strict = {
        createRegistry(c) {
            const r = K.createRegistry(c);
            return {
                ...r,
                onGraphMutation(fn) {
                    const off = r.onGraphMutation(fn);
                    let n = 0;
                    return () => { engineOffs++; if (++n > 1) throw new Error('engine off called twice'); off(); };
                },
            };
        },
    };
    const ad = S.liteS3AdapterFor(strict);
    const w = ad.open({});
    const offA = w.hook(() => {});
    w.hook(() => {});
    offA();
    assert.doesNotThrow(() => offA());
    assert.doesNotThrow(() => w.close(), 'close() skips the already-called off');
    assert.equal(engineOffs, 2, 'each engine off called exactly once (A by the caller, B by close())');
    const w2 = ad.open({});
    w2.hook(() => {});
    w2.reset();
    assert.doesNotThrow(() => w2.close());
    assert.equal(engineOffs, 3);
});

/* ---- 6. oracleScen: O8 / OW NA where reset-top is NA (b164 S3a-r3, D-b163-4) ---------------------------------- */

const DESTROY6 = ['destroy-top', 'destroy-in-flight', 'destroy-in-batch', 'destroy-in-body', 'destroy-in-computed', 'reuse-after-destroy'];
const RESET5 = ['reset-top', 'reset-in-flight', 'reset-in-batch', 'reset-in-body', 'reset-in-computed'];   // b164 S3b
const REG11 = DESTROY6.concat(RESET5);
/** A REGISTRY clone with fields overridden (the descriptor itself is frozen). */
const regWith = (o) => Object.assign({}, RG.REGISTRY, o);

test('oracleScen: REGISTRY declares O8 / OW -> [reset-top] (frozen, both lists frozen); no other ROSTER lane declares it', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(RG.REGISTRY.oracleScen)), { O8: ['reset-top'], OW: ['reset-top'] });
    assert.deepEqual(Object.keys(RG.REGISTRY.oracleScen), ['O8', 'OW']);
    assert.ok(Object.isFrozen(RG.REGISTRY.oracleScen) && Object.isFrozen(RG.REGISTRY.oracleScen.O8) && Object.isFrozen(RG.REGISTRY.oracleScen.OW));
    assert.deepEqual(LI.LANES.filter((d) => d.oracleScen !== undefined).map((d) => d.name), ['REGISTRY']);
});

test('oracleScen: REGISTRY on CAPS_LITE_PRE_RESET / CAPS_LITE_NO_RESET -> oraclesNA exactly [O8, OW], ' +
    'scenariosNA the 5 reset ids, the 6 destroy ids, run', () => {
    for (const [k, caps] of [['PRE_RESET', L.CAPS_LITE_PRE_RESET], ['NO_RESET', L.CAPS_LITE_NO_RESET]]) {
        assert.deepEqual(CT.applicability(RG.REGISTRY, caps),
            { status: 'run', missingCaps: [], oraclesNA: ['O8', 'OW'], scenariosNA: RESET5,
                requiredApplicable: DESTROY6 }, k);
        for (const e of ['lite', 'lite-box', undefined]) assert.deepEqual(CT.applicability(RG.REGISTRY, caps, e).oraclesNA, ['O8', 'OW'], k + ' ' + String(e));
    }
});

test('oracleScen: REGISTRY on CAPS_LITE (reset runs) -> O8 / OW stay hard: oraclesNA [], scenariosNA [], all 11 ' +
    'required', () => {
    const a = CT.applicability(RG.REGISTRY, L.CAPS_LITE);
    assert.deepEqual(a, { status: 'run', missingCaps: [], oraclesNA: [], scenariosNA: [], requiredApplicable: REG11 });
    assert.equal(a.oraclesNA.indexOf('O8'), -1);
    assert.equal(a.oraclesNA.indexOf('OW'), -1);
});

test('oracleScen order: caps-derived part in ORACLE_CAPS key order, rule-derived appended in hardOracles order (owner false -> [OW, O8]; hook false -> [O8, OW])', () => {
    assert.deepEqual(CT.applicability(RG.REGISTRY, { ...L.CAPS_LITE, owner: false }).oraclesNA, ['OW', 'O8']);
    assert.deepEqual(CT.applicability(RG.REGISTRY, { ...L.CAPS_LITE, hook: false }).oraclesNA, ['O8', 'OW']);
    assert.deepEqual(CT.applicability(RG.REGISTRY, { ...L.CAPS_LITE, reset: false }).oraclesNA, ['O8', 'OW']);
    // hardOracles order, not oracleScen key order
    const rev = regWith({ oracleScen: { OW: ['reset-top'], O8: ['reset-top'] } });
    assert.deepEqual(CT.applicability(rev, L.CAPS_LITE_PRE_RESET).oraclesNA, ['O8', 'OW']);
});

test('oracleScen rule is EVERY, not some: an oracle with one applicable listed scenario stays hard (O8 [reset-top, destroy-top] on PRE_RESET)', () => {
    const d = regWith({ oracleScen: { O8: ['reset-top', 'destroy-top'], OW: ['reset-top'] } });
    assert.deepEqual(CT.applicability(d, L.CAPS_LITE_PRE_RESET).oraclesNA, ['OW']);
    const both = regWith({ oracleScen: { O8: ['destroy-top', 'reset-top'] } });
    assert.deepEqual(CT.applicability(both, L.CAPS_LITE_PRE_RESET).oraclesNA, []);
});

test('oracleScen: a lane whose only hard oracles are rule-NA skips (hardLeft empty); an absent / undefined oracleScen is the frozen contract', () => {
    const d = regWith({ hardOracles: ['O8', 'OW'] });
    assert.deepEqual(CT.applicability(d, L.CAPS_LITE_PRE_RESET),
        { status: 'skip', missingCaps: [], oraclesNA: ['O8', 'OW'], scenariosNA: RESET5,
            requiredApplicable: DESTROY6 });
    assert.equal(CT.applicability(d, L.CAPS_LITE).status, 'run');
    const none = regWith({ oracleScen: undefined });
    assert.deepEqual(CT.applicability(none, L.CAPS_LITE_PRE_RESET).oraclesNA, []);
});

test('oracleScen absent: GRAPH / HOOK on CAPS_LITE_PRE_RESET deepEqual the frozen pre-b164 contract result (literals derived on b164-before)', () => {
    const by = (n) => LI.LANES.find((d) => d.name === n);
    assert.deepEqual(CT.applicability(by('GRAPH'), L.CAPS_LITE_PRE_RESET), { status: 'run', missingCaps: [], oraclesNA: [], scenariosNA: [], requiredApplicable: ['diamond-write', 'dep-set-flip', 'deep-pull', 'second-invalidation', 'equality-cutoff', 'adversarial-equality'] });
    assert.deepEqual(CT.applicability(by('HOOK'), L.CAPS_LITE_PRE_RESET), { status: 'run', missingCaps: [], oraclesNA: [], scenariosNA: [], requiredApplicable: ['hook-multi', 'hook-non-lifo-off', 'hook-mirror-dispose', 'hook-recompute'] });
    // every lane without oracleScen: oraclesNA is exactly the caps-only formula (an independent oracle, not the new code)
    const capsOnly = (caps) => Object.keys(CT.ORACLE_CAPS).filter((o) => CT.ORACLE_CAPS[o].some((c) => !CT.hasCap(caps, c)));
    const CASES = [L.CAPS_LITE, L.CAPS_LITE_PRE_RESET, L.CAPS_LITE_NO_RESET, { ...L.CAPS_LITE, owner: false }, { ...L.CAPS_LITE, hook: false }];
    for (const d of LI.LANES) {
        if (d.oracleScen !== undefined) continue;
        for (const caps of CASES) assert.deepEqual(CT.applicability(d, caps).oraclesNA, capsOnly(caps), d.name);
    }
});

test('oracleScen fail closed: not a plain object -> TypeError (null, array, number, string, function, Map, Object.create({}), Symbol key); a null-prototype map is accepted', () => {
    const NOT = /^applicability: REGISTRY\.oracleScen is not a plain object$/;
    for (const v of [null, [], [['O8', ['reset-top']]], 5, 'O8', () => {}, new Map(), Object.create({ O8: ['reset-top'] }), new (class X {})(), true]) {
        assert.throws(() => CT.applicability(regWith({ oracleScen: v }), L.CAPS_LITE), (e) => e instanceof TypeError && NOT.test(e.message), String(v));
    }
    assert.throws(() => CT.applicability(regWith({ oracleScen: { O8: ['reset-top'], [Symbol('s')]: ['reset-top'] } }), L.CAPS_LITE), (e) => e instanceof TypeError && /^applicability: REGISTRY\.oracleScen is not a plain object \(Symbol key\)$/.test(e.message));
    const np = Object.assign(Object.create(null), { O8: ['reset-top'], OW: ['reset-top'] });
    assert.deepEqual(CT.applicability(regWith({ oracleScen: np }), L.CAPS_LITE_PRE_RESET).oraclesNA, ['O8', 'OW']);
});

test('oracleScen fail closed: a key not in hardOracles -> TypeError (O9, OT, OB; a non-enumerable O9)', () => {
    for (const k of ['O9', 'OT', 'OB']) {
        assert.throws(() => CT.applicability(regWith({ oracleScen: { [k]: ['reset-top'] } }), L.CAPS_LITE), (e) => e instanceof TypeError && new RegExp('^applicability: REGISTRY\\.oracleScen\\.' + k + ' is not in hardOracles$').test(e.message), k);
    }
    const hidden = { OW: ['reset-top'] };
    Object.defineProperty(hidden, 'O9', { value: ['reset-top'], enumerable: false });
    assert.throws(() => CT.applicability(regWith({ oracleScen: hidden }), L.CAPS_LITE), (e) => e instanceof TypeError && /^applicability: REGISTRY\.oracleScen\.O9 is not in hardOracles$/.test(e.message));
});

test('oracleScen fail closed: a key in hardOracles but not an ORACLE_CAPS oracle -> TypeError (OZ, toString, constructor)', () => {
    for (const k of ['OZ', 'toString', 'constructor']) {
        const d = regWith({ hardOracles: RG.REGISTRY.hardOracles.concat([k]), oracleScen: { [k]: ['reset-top'] } });
        assert.throws(() => CT.applicability(d, L.CAPS_LITE), (e) => e instanceof TypeError && new RegExp('^applicability: REGISTRY\\.oracleScen\\.' + k + ' is not an ORACLE_CAPS oracle$').test(e.message), k);
    }
});

test('oracleScen fail closed: a value that is not a non-empty array -> TypeError ([], string, array-like, null, undefined, a Set)', () => {
    for (const v of [[], 'reset-top', { 0: 'reset-top', length: 1 }, null, undefined, new Set(['reset-top'])]) {
        assert.throws(() => CT.applicability(regWith({ oracleScen: { O8: ['reset-top'], OW: v } }), L.CAPS_LITE), (e) => e instanceof TypeError && /^applicability: REGISTRY\.oracleScen\.OW is not a non-empty array$/.test(e.message), String(v));
    }
});

test('oracleScen fail closed: a scenario id not in required / optional -> TypeError (typo, unknown, number, undefined, another lane\'s scenario)', () => {
    for (const [s, shown] of [['reset-tp', '"reset-tp"'], ['nope', '"nope"'], [7, '7'], [undefined, 'undefined'], ['diamond-write', '"diamond-write"']]) {
        const re = new RegExp('^applicability: REGISTRY\\.oracleScen\\.O8 scenario ' + shown.replace(/[-"]/g, '\\$&') + ' is not in required / optional$');
        assert.throws(() => CT.applicability(regWith({ oracleScen: { O8: ['reset-top', s] } }), L.CAPS_LITE), (e) => e instanceof TypeError && re.test(e.message), String(s));
    }
});

// b164 S3b B1 (S3a-r3 NIT): kills mutant R6 `const scen = desc.required;` (an optional id would throw)
test('oracleScen ids come from required AND optional: O8 [reset-top, x-opt] on PRE_RESET -> oraclesNA [OW]', () => {
    const d = regWith({ optional: ['x-opt'], oracleScen: { O8: ['reset-top', 'x-opt'], OW: ['reset-top'] } });
    assert.deepEqual(CT.applicability(d, L.CAPS_LITE_PRE_RESET).oraclesNA, ['OW']);
});

// b164 S3b B2 (S3a-r3 NIT): the rule runs on the validated copy, so an accessor cannot swap a list after the check
test('oracleScen read ONCE: an accessor O8 giving [reset-top] then [] -> on CAPS_LITE oraclesNA [] (O8 hard), 1 ' +
    'read', () => {
    let reads = 0;
    const os = { OW: ['reset-top'] };
    Object.defineProperty(os, 'O8', { enumerable: true, get: () => (reads++ === 0 ? ['reset-top'] : []) });
    assert.deepEqual(CT.applicability(regWith({ oracleScen: os }), L.CAPS_LITE).oraclesNA, []);
    assert.equal(reads, 1);
});

test('oracleScen fail closed: a scenario listed twice in one list -> TypeError (adjacent and split); the same scenario in two lists is fine', () => {
    for (const v of [['reset-top', 'reset-top'], ['destroy-top', 'reset-top', 'destroy-top']]) {
        const dup = v[0] === 'reset-top' ? 'reset-top' : 'destroy-top';
        const re = new RegExp('^applicability: REGISTRY\\.oracleScen\\.O8 lists scenario "' + dup + '" twice$');
        assert.throws(() => CT.applicability(regWith({ oracleScen: { O8: v } }), L.CAPS_LITE), (e) => e instanceof TypeError && re.test(e.message), v.join(','));
    }
    assert.deepEqual(CT.applicability(regWith({ oracleScen: { O8: ['reset-top'], OW: ['reset-top'] } }), L.CAPS_LITE_NO_RESET).oraclesNA, ['O8', 'OW']);
});
