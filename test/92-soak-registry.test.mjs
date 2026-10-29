// test/92-soak-registry.test.mjs -- burst 139, R5 batch B1a (PLAN-R5-registry-capacity.md PLAN BODY 1 TASKS 1-2, ASSERTIONS A-R2 / A-R5,
// RULED D-b139-1..3). Oracle: the O6 (v) contract (expectFromThrow + EXPECT_NEVER_ENTRY), model.destroyAll, the REGISTRY detectors,
// the lane generator and the live tree kernel through adapters/lite-s3.mjs. The REGISTRY lane is rostered since R5 B2a (b140); the
// KERNEL rows still drive it directly through runWorld's opts.laneOps (no main.mjs, no roster lookup).
// Groups: O6V (oracle), MODEL, DETECT, LANE (descriptor + generator), KERNEL (live Signal.js), RETENTION.
// Live-tree facts (.handoff/b139-evidence/r5/README.txt (c), b1a census): top-level destroy() is clean; destroy() in flight never
// throws the D2 contract throw, so every in-flight world fails O6 expected-escape-missing (DIV-F10), and an engine TypeError
// (a cleared flush-queue slot, D-b139-3) adds escape-TypeError when another effect is queued after the destroyer.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as O from '../bench/soak/oracles.mjs';
import { Model } from '../bench/soak/model.mjs';
import { Detectors, SCENARIOS } from '../bench/soak/scenarios.mjs';
import { REGISTRY, REG_EXPECT } from '../bench/soak/lanes/registry.mjs';
import { generateWorld, scriptJson } from '../bench/soak/gen.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import { seedFor, worldSeed } from '../bench/soak/seeds.mjs';
import { liteS3Adapter } from '../bench/soak/adapters/lite-s3.mjs';

const { checkEscape, expectFromThrow, EXPECT_NEVER_ENTRY, EXPECT_NONE, EXPECT_CYCLE } = O;
const sigs = (fs) => fs.map((f) => f.oracle + ':' + f.sig);
const ERR = (ctor, message) => ({ ctor, message });
const IN_FLIGHT = ['batch', 'body', 'computed'];
const REG_SCEN = ['destroy-top', 'destroy-in-flight', 'destroy-in-batch', 'destroy-in-body', 'destroy-in-computed', 'reuse-after-destroy'];
const CYCLE_SEED = seedFor(0xC0FFEE, 10, 0);
const D2 = JSON.parse(readFileSync(new URL('../bench/soak/divergences.json', import.meta.url), 'utf8')).entries.find((e) => e.id === 'DIV-D2-destroy-throws');

function script(ops) {
    return { genVersion: 1, lane: 'REGISTRY', seed: 1, large: false, covOff: null, flushPasses: null, ops };
}
const run = (s, opts) => runWorld(liteS3Adapter, s, Object.assign({ laneOps: REGISTRY.ops }, opts || {}));
const gen = (w, covOff) => generateWorld(REGISTRY, worldSeed(CYCLE_SEED, w), { steps: REGISTRY.worldShape.steps, covOff: covOff || null });
// 2 leaves, a computed over both, 2 effects (one over the computed, one over leaf 0)
const BASE = [
    { o: 'sig', i: 0, v: 1 }, { o: 'sig', i: 1, v: 2 },
    { o: 'comp', i: 2, spec: { k: 'sum', d: [0, 1], role: 'comp' } },
    { o: 'eff', i: 3, spec: { k: 'identity', d: [2], role: 'eff' } },
    { o: 'eff', i: 4, spec: { k: 'identity', d: [0], role: 'eff' } },
];

describe('O6V: expectFromThrow + EXPECT_NEVER_ENTRY (O6 (v))', () => {
    it('EXPECT_NEVER_ENTRY is frozen, prefix empty; expectFromThrow(null) is a frozen [EXPECT_NEVER_ENTRY]', () => {
        assert.ok(Object.isFrozen(EXPECT_NEVER_ENTRY));
        assert.equal(EXPECT_NEVER_ENTRY.prefix, '');
        const e = expectFromThrow(null);
        assert.ok(Object.isFrozen(e));
        assert.equal(e.length, 1);
        assert.equal(e[0], EXPECT_NEVER_ENTRY);
    });
    it('A-R2: null prediction, got [] -> exactly 1 failure (O6 expected-escape-missing)', () => {
        const r = checkEscape([], [], expectFromThrow(null));
        assert.deepEqual(sigs(r), ['O6:expected-escape-missing']);
    });
    it('A-R2: null prediction, got [Error] -> 2 failures (escape-Error + expected-escape-missing)', () => {
        assert.deepEqual(sigs(checkEscape([], [ERR('Error', 'boom')], expectFromThrow(null))), ['O6:escape-Error', 'O6:expected-escape-missing']);
    });
    it('NEVER absorbs nothing: a TypeError, a CycleError and an empty-message leaf all escape', () => {
        const n = expectFromThrow(null);
        assert.deepEqual(sigs(checkEscape([], [ERR('TypeError', "Cannot read properties of undefined (reading 'flags')")], n)), ['O6:escape-TypeError', 'O6:expected-escape-missing']);
        assert.deepEqual(sigs(checkEscape([], [ERR('Error', 'CycleError: x')], n)), ['O6:escape-CycleError', 'O6:expected-escape-missing']);
        assert.deepEqual(sigs(checkEscape([], [ERR('Error', '')], n)), ['O6:escape-Error', 'O6:expected-escape-missing']);
    });
    it('NEVER keeps token matching: a predicted token is still consumed, an unpredicted one escapes', () => {
        const n = expectFromThrow(null);
        assert.deepEqual(sigs(checkEscape(['t1'], [{ token: 't1', origin: 'effect' }], n)), ['O6:expected-escape-missing']);
        assert.deepEqual(sigs(checkEscape([], [{ token: 't2', origin: 'effect' }], n)), ['O6:escape-effect', 'O6:expected-escape-missing']);
    });
    it('EXPECT_NONE / EXPECT_CYCLE anchors unchanged (r5 checkescape-T0 rows)', () => {
        assert.deepEqual(sigs(checkEscape([], [], EXPECT_NONE)), []);
        assert.deepEqual(sigs(checkEscape([], [], EXPECT_CYCLE)), ['O6:expected-escape-missing']);
        assert.deepEqual(sigs(checkEscape([], [ERR('Error', 'boom')], EXPECT_NONE)), ['O6:escape-Error']);
        assert.deepEqual(sigs(checkEscape([], [ERR('Error', 'boom')], EXPECT_CYCLE)), ['O6:escape-Error', 'O6:expected-escape-missing']);
    });
    it('a filled expectedThrow absorbs exactly its ctor + prefix', () => {
        const e = expectFromThrow({ ctor: 'Error', messagePrefix: 'D2:' });
        assert.ok(Object.isFrozen(e) && Object.isFrozen(e[0]));
        assert.deepEqual(e, [{ id: 'expectedThrow', ctor: 'Error', prefix: 'D2:' }]);
        assert.deepEqual(sigs(checkEscape([], [ERR('Error', 'D2: destroy() in flight')], e)), []);
        assert.deepEqual(sigs(checkEscape([], [ERR('Error', 'other')], e)), ['O6:escape-Error', 'O6:expected-escape-missing']);
        assert.deepEqual(sigs(checkEscape([], [ERR('TypeError', 'D2: x')], e)), ['O6:escape-TypeError', 'O6:expected-escape-missing']);
        assert.deepEqual(sigs(checkEscape([], [], e)), ['O6:expected-escape-missing']);
    });
    it('malformed expectedThrow -> TypeError (messagePrefix "" included: fail closed)', () => {
        class Box { constructor() { this.ctor = 'Error'; this.messagePrefix = 'x'; } }
        const nullProto = Object.assign(Object.create(null), { ctor: 'Error', messagePrefix: 'x' });
        for (const bad of [undefined, 0, '', 'Error', [], [1, 2], { ctor: 'Error' }, { ctor: 'Error', messagePrefix: '' }, { ctor: '', messagePrefix: 'x' },
            { ctor: 'Error', messagePrefix: 'x', extra: 1 }, { ctor: 1, messagePrefix: 'x' }, { ctor: 'Error', messagePrefix: 7 }, { ctor: null, messagePrefix: 'x' }, new Box(), nullProto]) {
            assert.throws(() => expectFromThrow(bad), TypeError, 'expectFromThrow(' + (bad !== null && typeof bad === 'object' ? JSON.stringify(Object.assign({}, bad)) : typeof bad) + ')');
        }
    });
    it('checkEscape accepts the NEVER entry by identity only: a copy throws TypeError', () => {
        assert.throws(() => checkEscape([], [], [Object.assign({}, EXPECT_NEVER_ENTRY)]), TypeError);
        assert.throws(() => checkEscape([], [], [{ id: 'x', ctor: null, prefix: '' }]), TypeError);
    });
});

describe('MODEL: destroyAll', () => {
    it('kills every live node and turns every registration off; counts 0; a second call returns 0', () => {
        const M = new Model(liteS3Adapter.caps);
        M.addSignal(0, 1, {});
        M.addSignal(1, 2, {});
        M.addComputed(2, { k: 'sum', d: [0, 1], role: 'comp' }, -1);
        M.addEffect(3, { k: 'identity', d: [2], role: 'eff' }, -1);
        M.kill(1);
        M.addReg(0, 0);
        assert.equal(M.destroyAll(), 3);
        assert.deepEqual(M.counts(), { signals: 0, computeds: 0, effects: 0 });
        for (const nd of M.n) assert.equal(nd.live, false);
        assert.equal(M.regs[0].live, false);
        assert.equal(M.destroyAll(), 0);
    });
});

describe('DETECT: onRegDestroy / onRegReuse', () => {
    it('SCENARIOS lists the six REGISTRY ids', () => { for (const s of REG_SCEN) assert.ok(SCENARIOS.includes(s), s); });
    it('top counts destroy-top; an in-flight at counts destroy-in-flight + destroy-in-<at>', () => {
        const D = new Detectors({});
        D.onRegDestroy('top');
        for (const at of IN_FLIGHT) D.onRegDestroy(at);
        D.onRegReuse(3);
        assert.deepEqual({ ...D.counts }, { 'destroy-top': 1, 'destroy-in-flight': 3, 'destroy-in-batch': 1, 'destroy-in-body': 1, 'destroy-in-computed': 1, 'reuse-after-destroy': 1 });
    });
    it('a bad at / reuse count throws TypeError', () => {
        const D = new Detectors({});
        for (const at of [undefined, null, 'Top', 'flight', 'effect', 1]) assert.throws(() => D.onRegDestroy(at), TypeError);
        for (const n of [0, -1, 1.5, '1', null, NaN]) assert.throws(() => D.onRegReuse(n), TypeError);
        assert.deepEqual({ ...D.counts }, {});
    });
});

describe('LANE: descriptor + generator', () => {
    it('descriptor: index 10, six required scenarios, covOff destroy-in-flight -> in-flight, ops rdestroy / rbuilt, frozen', () => {
        assert.equal(REGISTRY.name, 'REGISTRY');
        assert.equal(REGISTRY.index, 10);
        assert.deepEqual([...REGISTRY.required], REG_SCEN);
        assert.deepEqual({ ...REGISTRY.covOff }, { 'destroy-in-flight': 'in-flight' });
        assert.deepEqual(Object.keys(REGISTRY.ops).sort(), ['rbuilt', 'rdestroy']);
        assert.ok(Object.isFrozen(REGISTRY) && Object.isFrozen(REGISTRY.ops));
    });
    it('REG_EXPECT is expectFromThrow(DIV-D2-destroy-throws.expectedThrow), read from divergences.json', () => {
        assert.notEqual(D2, undefined);
        assert.deepEqual(REG_EXPECT, expectFromThrow(D2.expectedThrow));
        if (D2.expectedThrow === null) assert.equal(REG_EXPECT[0], EXPECT_NEVER_ENTRY);
    });
    it('G0 determinism: the same seed gives the same script; another seed differs', () => {
        assert.equal(scriptJson(gen(3)), scriptJson(gen(3)));
        assert.notEqual(scriptJson(gen(3)), scriptJson(gen(4)));
    });
    it('60 worlds: every at seen; in-flight ops carry an int leaf + value 1..9 (batch n 1 | 2); each destroy is followed by a rebuild closed by rbuilt', () => {
        const seen = new Set();
        for (let w = 0; w < 60; w++) {
            const ops = gen(w).ops;
            for (let k = 0; k < ops.length; k++) {
                const op = ops[k];
                if (op.o !== 'rdestroy') continue;
                seen.add(op.at);
                if (op.at !== 'top') {
                    assert.ok(Number.isInteger(op.i) && Number.isInteger(op.v) && op.v >= 1 && op.v <= 9, JSON.stringify(op));
                    if (op.at === 'batch') assert.ok(op.n === 1 || op.n === 2);
                }
                if (k + 1 < ops.length) {
                    const nx = ops[k + 1];
                    assert.equal(nx.o, 'seq');
                    assert.equal(nx.ops[nx.ops.length - 1].o, 'rbuilt');
                }
            }
        }
        assert.deepEqual([...seen].sort(), ['batch', 'body', 'computed', 'top']);
    });
    it('cov-off destroy-in-flight: 60 worlds hold top destroys only (and some)', () => {
        let top = 0;
        for (let w = 0; w < 60; w++) for (const op of gen(w, 'destroy-in-flight').ops) if (op.o === 'rdestroy') { assert.equal(op.at, 'top'); top++; }
        assert.ok(top > 60, 'top destroys ' + top);
    });
});

describe('KERNEL: live tree through lite-s3 (direct laneOps wiring)', () => {
    it('cov-off: 40 worlds pass (no failure, teardown residue judged 0), destroy-top and reuse-after-destroy counted', () => {
        let top = 0, reuse = 0;
        for (let w = 0; w < 40; w++) {
            const r = run(gen(w, 'destroy-in-flight'));
            assert.equal(r.failure, null, 'world ' + w + ': ' + JSON.stringify(r.failure));
            assert.ok(r.checks.O5 > 0 && r.checks.O6 > 0);
            top += r.scen['destroy-top'] || 0;
            reuse += r.scen['reuse-after-destroy'] || 0;
            assert.equal(r.scen['destroy-in-flight'], undefined);
        }
        assert.ok(top > 0 && reuse > 0, 'top ' + top + ' reuse ' + reuse);
    });
    it('default: 40 worlds each fail-stop at their first in-flight rdestroy with an explained O6 shape (DIV-F10 / D-b139-3)', () => {
        for (let w = 0; w < 40; w++) {
            const s = gen(w);
            const r = run(s);
            assert.notEqual(r.failure, null, 'world ' + w);
            const op = s.ops[r.failure.step];
            assert.equal(op.o, 'rdestroy');
            assert.ok(IN_FLIGHT.includes(op.at), op.at);
            const got = sigs(r.failure.fails).sort();
            assert.ok(got.includes('O6:expected-escape-missing'), got.join());
            for (const g of got) assert.ok(g === 'O6:expected-escape-missing' || (g === 'O6:escape-TypeError' && op.at !== 'batch'), 'world ' + w + ' ' + op.at + ': ' + got.join());
        }
    });
    it('destroy in batch (n 1 and 2): exactly O6 expected-escape-missing (DIV-F10 shape)', () => {
        for (const n of [1, 2]) {
            const r = run(script(BASE.concat([{ o: 'rdestroy', at: 'batch', i: 0, v: 5, n }])));
            assert.notEqual(r.failure, null);
            assert.equal(r.failure.step, BASE.length);
            assert.deepEqual(sigs(r.failure.fails), ['O6:expected-escape-missing']);
        }
    });
    it('top destroy then a rebuild: no failure, reuse-after-destroy counted once', () => {
        const ops = BASE.concat([{ o: 'rdestroy', at: 'top' }, { o: 'seq', ops: [{ o: 'sig', i: 5, v: 3 }, { o: 'eff', i: 6, spec: { k: 'identity', d: [5], role: 'eff' } }, { o: 'rbuilt' }] }, { o: 'set', i: 5, v: 4 }]);
        const r = run(script(ops));
        assert.equal(r.failure, null, JSON.stringify(r.failure));
        assert.equal(r.scen['destroy-top'], 1);
        assert.equal(r.scen['reuse-after-destroy'], 1);
    });
    it('rbuilt with no prior destroy counts nothing', () => {
        const r = run(script(BASE.concat([{ o: 'rbuilt' }])));
        assert.equal(r.failure, null);
        assert.equal(r.scen['reuse-after-destroy'], undefined);
    });
    it('an in-flight op on a dead / absent leaf is a no-op (shrunk script)', () => {
        for (const at of IN_FLIGHT) {
            const r = run(script(BASE.concat([{ o: 'rdestroy', at, i: 99, v: 5, n: 1 }])));
            assert.equal(r.failure, null, at);
            assert.equal(r.scen['destroy-in-flight'], undefined);
        }
    });
    it('exec.regExpect never outlives the op (every rdestroy leaves it null)', () => {
        const seen = [];
        const laneOps = { rdestroy: (x, op, k) => { try { REGISTRY.ops.rdestroy(x, op, k); } finally { seen.push(x.regExpect); } }, rbuilt: REGISTRY.ops.rbuilt };
        for (let w = 0; w < 10; w++) run(gen(w), { laneOps });
        assert.ok(seen.length >= 10);
        for (const v of seen) assert.equal(v, null);
    });
    it('malformed rdestroy -> unmodelled throw (fail closed)', () => {
        for (const bad of [{ at: 'flight' }, { at: undefined }, { at: 'body', i: 0, v: 0 }, { at: 'body', i: 0, v: 10 }, { at: 'body', i: 0, v: 1.5 },
            { at: 'computed', i: '0', v: 5 }, { at: 'batch', i: 0, v: 5, n: 3 }, { at: 'batch', i: 0, v: 5 }]) {
            assert.throws(() => run(script(BASE.concat([Object.assign({ o: 'rdestroy' }, bad)]))), /unmodelled registry op/, JSON.stringify(bad));
        }
    });
    it('O6 (v) placement: REG_EXPECT reaches exactly the destroy guard (batch guard; setTop guard, never the creation guard)', () => {
        const log = [];
        const laneOps = {
            rdestroy: (x, op, k) => {
                x.guard = function (fn, cyc) {
                    log.push(op.at + ':' + (this.regExpect === REG_EXPECT ? 'REG' : this.regExpect === null ? 'null' : 'other'));
                    return Object.getPrototypeOf(this).guard.call(this, fn, cyc);
                };
                try { REGISTRY.ops.rdestroy(x, op, k); } finally { delete x.guard; }
            },
            rbuilt: REGISTRY.ops.rbuilt,
        };
        for (const at of ['batch', 'body', 'computed']) run(script(BASE.concat([{ o: 'rdestroy', at, i: 0, v: 5, n: 1 }])), { laneOps });
        run(script(BASE.concat([{ o: 'rdestroy', at: 'top' }])), { laneOps });
        assert.deepEqual(log, ['batch:REG', 'body:null', 'body:REG', 'computed:null', 'computed:REG', 'top:null']);
    });
    it('guard() resets regExpect at entry: a nested guard and the next guard see null', () => {
        const seen = [];
        const laneOps = {
            rdestroy: (x) => {
                x.regExpect = REG_EXPECT;
                x.guard((g) => { seen.push(g.expect, x.regExpect); x.guard((h) => { seen.push(h.expect); }); });
                x.guard((g) => { seen.push(g.expect); });
            },
            rbuilt: REGISTRY.ops.rbuilt,
        };
        run(script(BASE.concat([{ o: 'rdestroy', at: 'top' }])), { laneOps });
        assert.deepEqual(seen, [REG_EXPECT, null, null, null]);
    });
});

describe('RETENTION (A-R5): destroy + close leaves nothing', () => {
    it('lite-s3 world: destroy() at rest then close() -> residue nodes 0 / links 0, stats 0 / 0', () => {
        const W = liteS3Adapter.open({ maxFlushPasses: null });
        const s = W.signal(1);
        const c = W.computed(() => W.read(s) + 1);
        W.effect(() => { W.read(c); });
        W.destroy();
        const st = W.stats();
        assert.equal(st.activeNodes, 0);
        assert.equal(st.activeLinks, 0);
        const res = W.close();
        assert.equal(res.nodes, 0);
        assert.equal(res.links, 0);
    });
});

describe('ROSTER import smoke (b140 B2a): divergences.mjs <-> lanes/index.mjs -> lanes/registry.mjs, no TDZ cycle', () => {
    it('each load order in a FRESH node process: no throw, ROSTER 12 lanes, laneSpan 13, REGISTRY_PROBLEMS []', async () => {
        const { spawnSync } = await import('node:child_process');
        const soak = new URL('../bench/soak/', import.meta.url).href;
        for (const [first, second] of [['lanes/index.mjs', 'divergences.mjs'], ['divergences.mjs', 'lanes/index.mjs']]) {
            const src = 'const a = await import(' + JSON.stringify(soak + first) + '); const b = await import(' +
                JSON.stringify(soak + second) + '); const idx = ' + (first === 'lanes/index.mjs' ? 'a' : 'b') + '; const div = ' +
                (first === 'lanes/index.mjs' ? 'b' : 'a') + '; console.log(JSON.stringify([idx.ROSTER.length, ' +
                'idx.laneSpan(idx.ROSTER), idx.ROSTER.includes("REGISTRY"), div.REGISTRY_PROBLEMS]));';
            const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 60000 });
            assert.equal(r.status, 0, first + ' first: exit ' + r.status + ' ' + r.stderr);
            assert.deepEqual(JSON.parse(r.stdout.trim()), [12, 13, true, []], first + ' first');
        }
    });
});
