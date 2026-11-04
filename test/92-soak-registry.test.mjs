// test/92-soak-registry.test.mjs -- burst 139, R5 batch B1a (PLAN-R5-registry-capacity.md PLAN BODY 1 TASKS 1-2, ASSERTIONS A-R2 / A-R5,
// RULED D-b139-1..3). Oracle: the O6 (v) contract (expectFromThrow + EXPECT_NEVER_ENTRY), model.destroyAll, the REGISTRY detectors,
// the lane generator and the live tree kernel through adapters/lite-s3.mjs. The REGISTRY lane is rostered since R5 B2a (b140); the
// KERNEL rows still drive it directly through runWorld's opts.laneOps (no main.mjs, no roster lookup).
// Groups: O6V (oracle), MODEL, DETECT, LANE (descriptor + generator), KERNEL (live Signal.js), RESET (top-level rreset, b163
// C-RESET soak S3a: PLAN-C-RESET-soak TASK 8a + ADDENDUM 2 / 2b / 3; S0 facts b162-evidence/soak/SUMMARY.txt), RETENTION.
// Live-tree facts: top-level destroy() is clean; since 1.6.0 (C-RESET D-4, Signal.js 482a1d98) destroy() in flight throws the D2
// contract throw Error '[lite-signal] destroy: graph not settled (<reason>)' and leaves the graph intact, so every in-flight world
// is O6-clean against REG_EXPECT (DIV-F10 closed, fixedIn 1.6.0; b162 C-RESET soak S1). Before 1.6.0 (b139 B1a census) every
// in-flight world failed O6 expected-escape-missing, plus escape-TypeError (a cleared flush-queue slot, D-b139-3).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as O from '../bench/soak/oracles.mjs';
import { Model } from '../bench/soak/model.mjs';
import { Detectors, SCENARIOS } from '../bench/soak/scenarios.mjs';
import { REGISTRY, REG_EXPECT } from '../bench/soak/lanes/registry.mjs';
import { generateWorld, scriptJson } from '../bench/soak/gen.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import { seedFor, worldSeed } from '../bench/soak/seeds.mjs';
import { liteS3Adapter } from '../bench/soak/adapters/lite-s3.mjs';
import { applicability } from '../bench/soak/adapters/contract.mjs';
import { spawnSync } from 'node:child_process';

const { checkEscape, expectFromThrow, EXPECT_NEVER_ENTRY, EXPECT_NONE, EXPECT_CYCLE } = O;
const sigs = (fs) => fs.map((f) => f.oracle + ':' + f.sig);
const ERR = (ctor, message) => ({ ctor, message });
const IN_FLIGHT = ['batch', 'body', 'computed'];
const REG_SCEN = ['destroy-top', 'destroy-in-flight', 'destroy-in-batch', 'destroy-in-body', 'destroy-in-computed', 'reuse-after-destroy', 'reset-top'];
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
    it('SCENARIOS lists the seven REGISTRY required ids', () => { for (const s of REG_SCEN) assert.ok(SCENARIOS.includes(s), s); });
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
    it('descriptor: index 10, seven required scenarios (reset-top last), covOff destroy-in-flight -> in-flight, ops rdestroy / rreset / rbuilt, frozen', () => {
        assert.equal(REGISTRY.name, 'REGISTRY');
        assert.equal(REGISTRY.index, 10);
        assert.deepEqual([...REGISTRY.required], REG_SCEN);
        assert.deepEqual({ ...REGISTRY.covOff }, { 'destroy-in-flight': 'in-flight' });
        assert.deepEqual(Object.keys(REGISTRY.ops).sort(), ['rbuilt', 'rdestroy', 'rreset']);
        assert.ok(Object.isFrozen(REGISTRY) && Object.isFrozen(REGISTRY.ops));
    });
    it('S3a descriptor fields: mix gains reset 4 (other weights kept); needsCaps unchanged (D-b163-3); scenCaps reset-top -> reset / owner / hook; hardOracles + O8 / OW; frozen', () => {
        assert.deepEqual({ ...REGISTRY.mix }, { set: 40, read: 16, mk: 12, stop: 8, destroy: 4, reset: 4 });
        assert.deepEqual([...REGISTRY.needsCaps], ['destroy', 'stopEffect', 'links']);
        assert.deepEqual([...REGISTRY.hardOracles], ['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O8', 'OW']);
        assert.deepEqual([...REGISTRY.optional], []);
        assert.deepEqual(JSON.parse(JSON.stringify(REGISTRY.scenCaps)), { 'reset-top': ['reset', 'owner', 'hook'] });
        for (const k of ['mix', 'needsCaps', 'hardOracles', 'required', 'scenCaps']) assert.ok(Object.isFrozen(REGISTRY[k]), k);
        assert.ok(Object.isFrozen(REGISTRY.scenCaps['reset-top']));
        // every needed / scenario cap is present on the lite-s3 adapter (the 1.6.0 tree): reset-top is required there
        for (const c of REGISTRY.needsCaps.concat(REGISTRY.scenCaps['reset-top'])) assert.ok(liteS3Adapter.caps[c] !== undefined && liteS3Adapter.caps[c] !== false && liteS3Adapter.caps[c] !== 'no', c);
        assert.deepEqual(applicability(REGISTRY, liteS3Adapter.caps), { status: 'run', missingCaps: [], oraclesNA: [], scenariosNA: [], requiredApplicable: REG_SCEN });
    });
    it('D-b163-3: on reset-less caps (reset false, or owner / hook false) the lane still RUNS and requiredApplicable drops reset-top only', () => {
        for (const k of ['reset', 'owner', 'hook']) {
            const caps = Object.assign({}, liteS3Adapter.caps, { [k]: false });
            const a = applicability(REGISTRY, caps);
            assert.equal(a.status, 'run', k);
            assert.deepEqual(a.missingCaps, [], k);
            assert.deepEqual(a.scenariosNA, ['reset-top'], k);
            assert.deepEqual(a.requiredApplicable, REG_SCEN.slice(0, 6), k);
        }
    });
    it('D-b163-1: SIGS.OW is [cleanup-order, callback-this, reset-cleanup] (frozen state as its siblings)', () => {
        assert.deepEqual(O.SIGS.OW, ['cleanup-order', 'callback-this', 'reset-cleanup']);
        assert.equal(Object.isFrozen(O.SIGS.OW), Object.isFrozen(O.SIGS.O8));
    });
    it('REG_EXPECT is expectFromThrow(DIV-D2-destroy-throws.expectedThrow), read from divergences.json', () => {
        assert.notEqual(D2, undefined);
        assert.deepEqual(REG_EXPECT, expectFromThrow(D2.expectedThrow));
        // b162 (C-RESET soak S1): the D2 row carries the guard throw; DIV-F10 is closed
        assert.deepEqual(D2.expectedThrow, { ctor: 'Error', messagePrefix: '[lite-signal] destroy: graph not settled' });
        assert.deepEqual(REG_EXPECT, [{ id: 'expectedThrow', ctor: 'Error', prefix: '[lite-signal] destroy: graph not settled' }]);
        assert.notEqual(REG_EXPECT[0], EXPECT_NEVER_ENTRY);
        assert.equal(D2.fixedIn, '1.6.0');
        assert.equal(D2.pending, null);
    });
    it('G0 determinism: the same seed gives the same script; another seed differs', () => {
        assert.equal(scriptJson(gen(3)), scriptJson(gen(3)));
        assert.notEqual(scriptJson(gen(3)), scriptJson(gen(4)));
    });
    it('60 worlds: every at seen; in-flight ops carry an int leaf + value 1..9 (batch n 1 | 2); each top destroy is followed by a rebuild closed by rbuilt, an in-flight one never (the graph stays)', () => {
        const seen = new Set();
        let top = 0, inFlight = 0;
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
                if (op.at === 'top') top++; else inFlight++;
                if (k + 1 < ops.length) {
                    const nx = ops[k + 1];
                    if (op.at === 'top') {
                        assert.equal(nx.o, 'seq');
                        assert.equal(nx.ops[nx.ops.length - 1].o, 'rbuilt');
                    } else assert.notEqual(nx.o, 'seq', JSON.stringify(op));
                }
            }
        }
        assert.deepEqual([...seen].sort(), ['batch', 'body', 'computed', 'top']);
        assert.deepEqual([top, inFlight], [387, 619], 'b163 S3a measured (60 worlds, CYCLE_SEED; MIX reset 4)');
    });
    it('60 worlds: every rreset is { o, at top, i a live leaf, t 0 | 1 | 2 } followed by a rebuild closed by rbuilt; t drawn 6:2:2, exact per-t counts', () => {
        const perT = [0, 0, 0];
        for (let w = 0; w < 60; w++) {
            const ops = gen(w).ops;
            for (let k = 0; k < ops.length; k++) {
                const op = ops[k];
                if (op.o !== 'rreset') continue;
                // the generator's own chk / cs bits follow (gen.mjs push)
                assert.deepEqual(Object.keys(op).slice(0, 4), ['o', 'at', 'i', 't'], JSON.stringify(op));
                for (const key of Object.keys(op).slice(4)) assert.ok(key === 'chk' || key === 'cs', JSON.stringify(op));
                assert.equal(op.at, 'top');
                assert.ok(Number.isInteger(op.i) && op.i >= 0, JSON.stringify(op));
                assert.ok(op.t === 0 || op.t === 1 || op.t === 2, JSON.stringify(op));
                perT[op.t]++;
                if (k + 1 < ops.length) {
                    assert.equal(ops[k + 1].o, 'seq');
                    assert.equal(ops[k + 1].ops[ops[k + 1].ops.length - 1].o, 'rbuilt');
                }
            }
        }
        assert.deepEqual(perT, [609, 231, 212], 'b163 S3a measured (60 worlds, CYCLE_SEED)');
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
        assert.deepEqual([top, reuse], [626, 625], 'b163 S3a measured (40 cov-off worlds; a rebuild after an rreset counts no reuse)');
    });
    it('default: 40 worlds pass (every in-flight rdestroy O6-clean vs REG_EXPECT; every top-level rreset O5 / O8 / OW clean); exact scenario + per-t counts, each t >= 1', () => {
        const tot = {};
        const perT = [0, 0, 0];
        const checks = { O8: 0, OW: 0 };
        const flat = (ops) => { for (const op of ops) { if (op.o === 'seq') flat(op.ops); else if (op.o === 'rreset') perT[op.t]++; } };
        for (let w = 0; w < 40; w++) {
            const sc = gen(w);
            flat(sc.ops);
            const r = run(sc);
            assert.equal(r.failure, null, 'world ' + w + ': ' + JSON.stringify(r.failure));
            assert.ok(r.checks.O5 > 0 && r.checks.O6 > 0);
            for (const s of REG_SCEN) tot[s] = (tot[s] || 0) + (r.scen[s] || 0);
            checks.O8 += r.checks.O8;
            checks.OW += r.checks.OW;
        }
        // b163 S3a measured (40 worlds, CYCLE_SEED); in-flight = batch + body + computed; one O8 + one OW check per rreset
        assert.deepEqual(tot, { 'destroy-top': 249, 'destroy-in-flight': 410, 'destroy-in-batch': 133, 'destroy-in-body': 144, 'destroy-in-computed': 133, 'reuse-after-destroy': 248, 'reset-top': 701 });
        assert.deepEqual(perT, [400, 162, 139]);
        for (const n of perT) assert.ok(n >= 1);
        assert.deepEqual(checks, { O8: 701, OW: 701 });
    });
    it('each in-flight shape (batch n 1 / 2, body, computed) is O6-clean and leaves the graph intact: the next set and read are clean, engine stats unchanged', () => {
        for (const [at, n] of [['batch', 1], ['batch', 2], ['body', 1], ['computed', 1]]) {
            let st = null;
            const laneOps = {
                rdestroy: (x, op, k) => {
                    REGISTRY.ops.rdestroy(x, op, k);
                    const s = x.W.stats();
                    st = [s.activeNodes, s.activeLinks, s.signals, s.computeds, s.effects, x.W.peek(x.H[0]), x.M.n[0].v, x.M.n[3].live];
                },
                rbuilt: REGISTRY.ops.rbuilt,
            };
            const r = run(script(BASE.concat([{ o: 'rdestroy', at, i: 0, v: 5, n }, { o: 'set', i: 0, v: 6 }, { o: 'read', is: [2] }, { o: 'rbuilt' }])), { laneOps });
            assert.equal(r.failure, null, at + ' n' + n + ': ' + JSON.stringify(r.failure));
            // 5 nodes / 4 links (the BASE graph, the private nodes disposed); leaf 0 holds 5 in the engine and the model
            assert.deepEqual(st, [5, 4, 2, 1, 2, 5, 5, true], at + ' n' + n);
            assert.deepEqual({ ...r.scen }, { 'destroy-in-flight': 1, ['destroy-in-' + at]: 1 }, at + ': no reuse-after-destroy (no destroy ran)');
        }
    });
    it('must-fail: REG_EXPECT forced to the never entry -> O6 escape-Error (the guard throw, exact reason) + expected-escape-missing', () => {
        const NEVER = expectFromThrow(null);
        const laneOps = {
            rdestroy: (x, op, k) => {
                x.guard = function (fn, cyc) { if (this.regExpect === REG_EXPECT) this.regExpect = NEVER; return Object.getPrototypeOf(this).guard.call(this, fn, cyc); };
                try { REGISTRY.ops.rdestroy(x, op, k); } finally { delete x.guard; }
            },
            rbuilt: REGISTRY.ops.rbuilt,
        };
        for (const [at, why] of [['batch', 'batch in progress'], ['body', 'flush in progress'], ['computed', 'flush in progress']]) {
            const r = run(script(BASE.concat([{ o: 'rdestroy', at, i: 0, v: 5, n: 1 }])), { laneOps });
            assert.notEqual(r.failure, null, at);
            assert.equal(r.failure.step, BASE.length);
            assert.deepEqual(r.failure.fails.map((f) => [f.oracle, f.sig, f.detail]), [
                ['O6', 'escape-Error', 'engine error escaped: Error: [lite-signal] destroy: graph not settled (' + why + ')'],
                ['O6', 'expected-escape-missing', 'predicted expectedThrow did not happen'],
            ], at);
        }
    });
    it('must-fail: the pre-b162 lane (model.destroyAll after an in-flight throw) -> O5 kind-count / node-count / link-count; the private nodes left alive -> O5', () => {
        const old = { rdestroy: (x, op, k) => { REGISTRY.ops.rdestroy(x, op, k); if (op.at !== 'top') x.M.destroyAll(); }, rbuilt: REGISTRY.ops.rbuilt };
        for (const at of IN_FLIGHT) {
            const r = run(script(BASE.concat([{ o: 'rdestroy', at, i: 0, v: 5, n: 1 }])), { laneOps: old });
            assert.notEqual(r.failure, null, at);
            assert.deepEqual(sigs(r.failure.fails), ['O5:kind-count', 'O5:node-count', 'O5:link-count'], at);
        }
        const keep = { rdestroy: (x, op, k) => { const d = x.W.dispose; x.W.dispose = () => {}; try { REGISTRY.ops.rdestroy(x, op, k); } finally { x.W.dispose = d; } }, rbuilt: REGISTRY.ops.rbuilt };
        for (const [at, nodes] of [['body', 'activeNodes engine=6 model=5'], ['computed', 'activeNodes engine=7 model=5']]) {
            const r = run(script(BASE.concat([{ o: 'rdestroy', at, i: 0, v: 5, n: 1 }])), { laneOps: keep });
            assert.notEqual(r.failure, null, at);
            assert.deepEqual(sigs(r.failure.fails), ['O5:kind-count', 'O5:node-count', 'O5:link-count'], at);
            assert.equal(r.failure.fails[1].detail, nodes, at);
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
    it('exec.regExpect never outlives the op (every rdestroy and rreset leaves it null)', () => {
        const seen = [];
        const laneOps = {
            rdestroy: (x, op, k) => { try { REGISTRY.ops.rdestroy(x, op, k); } finally { seen.push(x.regExpect); } },
            rreset: (x, op, k) => { try { REGISTRY.ops.rreset(x, op, k); } finally { seen.push(x.regExpect); } },
            rbuilt: REGISTRY.ops.rbuilt,
        };
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
    it('O6 (v) placement: REG_EXPECT reaches exactly the destroy guard (batch guard; setTop guard, never the creation or the private-dispose guard)', () => {
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
        assert.deepEqual(log, ['batch:REG', 'body:null', 'body:REG', 'body:null', 'computed:null', 'computed:REG', 'computed:null', 'top:null']);
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

// one top-level rreset on BASE, then a rebuild (leaf 5 + an effect over it) and a set: the S3a fixture rows
const RESET_TAIL = [{ o: 'seq', ops: [{ o: 'sig', i: 5, v: 3 }, { o: 'eff', i: 6, spec: { k: 'identity', d: [5], role: 'eff' } }, { o: 'rbuilt' }] }, { o: 'set', i: 5, v: 4 }];
const resetScript = (t, extra) => script(BASE.concat([Object.assign({ o: 'rreset', at: 'top', i: 0, t }, extra || {})], RESET_TAIL));
const withLane = (rreset) => ({ rdestroy: REGISTRY.ops.rdestroy, rreset, rbuilt: REGISTRY.ops.rbuilt });
const failRows = (r) => (r.failure === null ? null : r.failure.fails.map((f) => [f.oracle, f.sig, f.detail]));
// the lane run on a world patch (x.W member swapped for the one rreset, restored after)
const patched = (key, make) => withLane((x, op, k) => { const orig = x.W[key]; x.W[key] = make(orig, x); try { REGISTRY.ops.rreset(x, op, k); } finally { x.W[key] = orig; } });
// a SCRATCH COPY of lanes/registry.mjs (count-checked replacements: one match or throw), its relative imports made absolute
const SOAK_URL = new URL('../bench/soak/', import.meta.url);
async function scratchLane(edits) {
    let src = readFileSync(new URL('lanes/registry.mjs', SOAK_URL), 'utf8');
    const swap = (a, b) => { const n = src.split(a).length - 1; if (n !== 1) throw new Error('scratchLane: ' + n + ' matches for ' + a); src = src.replace(a, () => b); };
    swap("from '../kinds.mjs'", 'from ' + JSON.stringify(new URL('kinds.mjs', SOAK_URL).href));
    swap("from '../oracles.mjs'", 'from ' + JSON.stringify(new URL('oracles.mjs', SOAK_URL).href));
    swap("new URL('../divergences.json', import.meta.url)", 'new URL(' + JSON.stringify(new URL('divergences.json', SOAK_URL).href) + ')');
    for (const [a, b] of edits) swap(a, b);
    const dir = mkdtempSync(join(tmpdir(), 'soak92-s3a-'));
    try {
        const f = join(dir, 'registry-scratch.mjs');
        writeFileSync(f, src);
        return (await import(pathToFileURL(f).href)).REGISTRY;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// A6 (B4): the child runs the live lane (edits null) or a scratch copy (count-checked edits, imports absolute); it holds the
// last exec (as a long-lived exec would), so a lane field that keeps an escape stays reachable between cycles
const ROOT_DIR = new URL('../', import.meta.url);
function a6Run(edits) {
    const dir = mkdtempSync(join(tmpdir(), 'soak92-a6-'));
    try {
        let laneUrl = new URL('lanes/registry.mjs', SOAK_URL).href;
        if (edits !== null) {
            let src = readFileSync(new URL('lanes/registry.mjs', SOAK_URL), 'utf8');
            const swap = (a, b) => { const n = src.split(a).length - 1; if (n !== 1) throw new Error('a6Run: ' + n + ' matches for ' + a); src = src.replace(a, () => b); };
            swap("from '../kinds.mjs'", 'from ' + JSON.stringify(new URL('kinds.mjs', SOAK_URL).href));
            swap("from '../oracles.mjs'", 'from ' + JSON.stringify(new URL('oracles.mjs', SOAK_URL).href));
            swap("new URL('../divergences.json', import.meta.url)", 'new URL(' + JSON.stringify(new URL('divergences.json', SOAK_URL).href) + ')');
            for (const [a, b] of edits) swap(a, b);
            const f = join(dir, 'registry-a6.mjs');
            writeFileSync(f, src);
            laneUrl = pathToFileURL(f).href;
        }
        const src = [
            'const { REGISTRY } = await import(' + JSON.stringify(laneUrl) + ');',
            'const { runWorld } = await import(' + JSON.stringify(new URL('exec.mjs', SOAK_URL).href) + ');',
            'const { liteS3Adapter } = await import(' + JSON.stringify(new URL('adapters/lite-s3.mjs', SOAK_URL).href) + ');',
            "const { createLeakTracker } = await import('@zakkster/lite-leak');",
            "const tracker = createLeakTracker({ name: 't92-a6', onLeak() {}, onWarning() {} });",
            'let lastX = null, tracked = 0;',
            'const laneOps = { rdestroy: REGISTRY.ops.rdestroy, rbuilt: REGISTRY.ops.rbuilt, rreset: (x, op, k) => {',
            '    lastX = x;',
            '    const rs = x.W.reset, hk = x.W.hook;',
            "    x.W.hook = (fn) => { tracker.track(fn, null, 'census'); tracked++; return hk(fn); };",
            "    x.W.reset = () => { try { rs(); } catch (e) { tracker.track(e, null, 'esc'); tracked++; for (const t of e.errors) { tracker.track(t, null, 'tok'); tracked++; } throw e; } };",
            '    try { REGISTRY.ops.rreset(x, op, k); } finally { x.W.reset = rs; x.W.hook = hk; }',
            '} };',
            "const ops = [{ o: 'sig', i: 0, v: 1 }, { o: 'eff', i: 1, spec: { k: 'identity', d: [0], role: 'eff' } }];",
            'for (let r = 0; r < 100; r++) {',
            "    const a = 2 + 2 * r;",
            "    ops.push({ o: 'rreset', at: 'top', i: a - 2, t: 2 }, { o: 'seq', ops: [{ o: 'sig', i: a, v: 1 + (r % 9) }, { o: 'eff', i: a + 1, spec: { k: 'identity', d: [a], role: 'eff' } }, { o: 'rbuilt' }] });",
            '}',
            "const script = { genVersion: 1, lane: 'REGISTRY', seed: 1, large: false, covOff: null, flushPasses: null, ops };",
            'const nap = (ms) => new Promise((res) => setTimeout(res, ms));',
            'const sizes = [], fails = [];',
            'for (let c = 0; c < 5; c++) {',
            '    const r = runWorld(liteS3Adapter, script, { laneOps });',
            '    fails.push(r.failure);',
            '    for (let i = 0; i < 30 && tracker.size() > 0; i++) { globalThis.gc(); await nap(0); globalThis.gc(); await nap(10); }',
            '    sizes.push(tracker.size());',
            '}',
            'console.log(JSON.stringify({ sizes, fails, tracked, held: lastX !== null }));',
        ].join('\n');
        const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', src], { cwd: ROOT_DIR, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
        assert.equal(r.status, 0, 'a6 child exit ' + r.status + ' signal ' + r.signal + ' ' + r.stderr);
        return JSON.parse(r.stdout.trim().split('\n').pop());
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('RESET (S3a, TASK 8a): top-level rreset, private cleanup fixture t 0 / 1 / 2', () => {
    it('each t: the world passes; reset-top 1; one O8 + one OW check; census teed beside the lane: op-2 = s0.activeNodes + 2t, op-4 = s0.activeLinks - t, probe id = max + 1 (S0 facts)', () => {
        // probed b163 S3a on BASE (Signal.js 482a1d98): [s0 nodes, s0 links, op-2 during reset, op-4, probe op-1 id]
        const WANT = { 0: [7, 6, 7, 6, 8], 1: [7, 6, 9, 5, 8], 2: [8, 7, 12, 5, 9] };
        for (const t of [0, 1, 2]) {
            const tee = [];
            let s0 = null, on = false;
            const lane = withLane((x, op, k) => {
                const hk = x.W.hook, st = x.W.stats, rs = x.W.reset;
                let n = 0;
                x.W.stats = () => { const s = st(); if (n++ === 0) s0 = [s.activeNodes, s.activeLinks]; return s; };
                x.W.hook = (fn) => hk((o, a, b) => { if (on || o === 1) tee.push([o, a]); fn(o, a, b); });
                x.W.reset = () => { on = true; try { rs(); } finally { on = false; } };
                try { REGISTRY.ops.rreset(x, op, k); } finally { x.W.hook = hk; x.W.stats = st; x.W.reset = rs; }
            });
            const r = run(resetScript(t), { laneOps: lane });
            assert.equal(r.failure, null, 't=' + t + ': ' + JSON.stringify(r.failure));
            assert.deepEqual({ ...r.scen }, { 'reset-top': 1 }, 't=' + t + ': no reuse-after-destroy (no destroy ran)');
            assert.deepEqual([r.checks.O8, r.checks.OW], [1, 1]);
            const op2 = tee.filter((e) => e[0] === 2), op4 = tee.filter((e) => e[0] === 4), op1 = tee.filter((e) => e[0] === 1);
            assert.equal(op1.length, 1, 't=' + t + ': the probe is the only create after the hook');
            assert.deepEqual([s0[0], s0[1], op2.length, op4.length, op1[0][1]], WANT[t], 't=' + t);
            assert.equal(op2.length, s0[0] + 2 * t);
            assert.equal(op4.length, s0[1] - t);
            assert.ok(op1[0][1] > Math.max(...op2.map((e) => e[1])));
        }
    });
    it('the escape per t reaches the guard exactly as predicted: t=0 none, t=1 T_Q itself, t=2 AggregateError "reset: cleanups threw" [T_R, T_Q]', () => {
        const got = [];
        const lane = patched('reset', (rs) => () => { try { rs(); } catch (e) { got.push(e); throw e; } });
        for (const t of [0, 1, 2]) assert.equal(run(resetScript(t), { laneOps: lane }).failure, null, 't=' + t);
        assert.equal(got.length, 2);
        assert.equal(got[0].token, 'reset:Q');
        assert.ok(got[1] instanceof AggregateError);
        assert.equal(got[1].message, 'reset: cleanups threw');
        assert.deepEqual(got[1].errors.map((e) => e.token), ['reset:R', 'reset:Q']);
    });
    it('must-fail (a): world reset() made a no-op -> O5 node-count (+ kind-count, link-count), O8 op-2 count, OW cleanup log', () => {
        const r = run(resetScript(0), { laneOps: patched('reset', () => () => {}) });
        assert.notEqual(r.failure, null);
        assert.equal(r.failure.step, BASE.length);
        assert.deepEqual(failRows(r), [
            ['O5', 'kind-count', 'reset t=0: signals=2 != 0'],
            ['O5', 'node-count', 'reset t=0: activeNodes=7 != 0'],
            ['O5', 'link-count', 'reset t=0: activeLinks=6 != 0'],
            ['O8', 'mirror-links', 'reset t=0: op-2 count 0 != s0.activeNodes 7 + 2t'],
            ['OW', 'reset-cleanup', 'reset t=0: cleanup log [] != [Q,P]'],
        ]);
    });
    it('must-fail (b): the cleanup log check fed a wrong order (scratch copy: P logs first) -> OW reset-cleanup, nothing else', async () => {
        const L = await scratchLane([["W.onCleanup(() => { log.push('P'); });", "W.onCleanup(() => { log.unshift('P'); });"]]);
        for (const [t, want] of [[0, 'reset t=0: cleanup log [P,Q] != [Q,P]'], [1, 'reset t=1: cleanup log [P,Q] != [Q,P]'], [2, 'reset t=2: cleanup log [P,R,Q] != [R,Q,P]']]) {
            const r = run(resetScript(t), { laneOps: L.ops });
            assert.deepEqual(failRows(r), [['OW', 'reset-cleanup', want]], 't=' + t);
        }
        const ok = await scratchLane([]);
        for (const t of [0, 1, 2]) assert.equal(run(resetScript(t), { laneOps: ok.ops }).failure, null, 'unpatched scratch copy passes, t=' + t);
    });
    it('must-fail (c): the t=2 AggregateError rethrown as errs[0] -> OW reset-cleanup (+ O6 expected-escape-missing: T_Q lost)', () => {
        const lane = patched('reset', (rs) => () => { try { rs(); } catch (e) { if (e instanceof AggregateError) throw e.errors[0]; throw e; } });
        const r = run(resetScript(2), { laneOps: lane });
        assert.deepEqual(failRows(r), [
            ['O6', 'expected-escape-missing', 'predicted escape reset:Q x1 did not happen'],
            ['OW', 'reset-cleanup', 'reset t=2: want AggregateError, got T_R'],
        ]);
        assert.equal(run(resetScript(1), { laneOps: lane }).failure, null, 't=1 has no aggregate: the patch is inert there');
    });
    it('must-fail: the t=1 escape wrapped (new Error(T_Q.message)) -> O6 escape-Error + expected-escape-missing + OW reset-cleanup; a 1-element AggregateError -> OW reset-cleanup alone', () => {
        const wrap = patched('reset', (rs) => () => { try { rs(); } catch (e) { throw new Error(e.message); } });
        assert.deepEqual(failRows(run(resetScript(1), { laneOps: wrap })), [
            ['O6', 'escape-Error', 'engine error escaped: Error: SoakThrow:reset:Q'],
            ['O6', 'expected-escape-missing', 'predicted escape reset:Q x1 did not happen'],
            ['OW', 'reset-cleanup', 'reset t=1: want T_Q (identity), got Error: SoakThrow:reset:Q'],
        ]);
        const agg1 = patched('reset', (rs) => () => { try { rs(); } catch (e) { throw new AggregateError([e], 'reset: cleanups threw'); } });
        assert.deepEqual(failRows(run(resetScript(1), { laneOps: agg1 })), [['OW', 'reset-cleanup', 'reset t=1: want T_Q (identity), got AggregateError(1)']]);
    });
    it('must-fail (d): the op-2 census silenced (W.hook drops op 2) -> O8 mirror-links, nothing else', () => {
        const lane = patched('hook', (hk) => (fn) => hk((o, a, b) => { if (o !== 2) fn(o, a, b); }));
        for (const [t, n] of [[0, 7], [1, 7], [2, 8]]) {
            const r = run(resetScript(t), { laneOps: lane });
            assert.deepEqual(failRows(r), [['O8', 'mirror-links', 'reset t=' + t + ': op-2 count 0 != s0.activeNodes ' + n + ' + 2t']], 't=' + t);
        }
    });
    it('must-fail: op 4 silenced -> O8 mirror-links (the rule-I3 op-4 count); an extra op 2 per round 1 -> O8', () => {
        const no4 = patched('hook', (hk) => (fn) => hk((o, a, b) => { if (o !== 4) fn(o, a, b); }));
        assert.deepEqual(failRows(run(resetScript(0), { laneOps: no4 })), [['O8', 'mirror-links', 'reset t=0: op-4 count 0 != rule I3 6 (s0.activeLinks 6)']]);
        const dup2 = patched('hook', (hk) => (fn) => hk((o, a, b) => { fn(o, a, b); if (o === 2) fn(o, a, b); }));
        const r = run(resetScript(0), { laneOps: dup2 });
        assert.equal(r.failure.fails[0].oracle, 'O8');
        assert.equal(r.failure.fails[0].detail, 'reset t=0: op-2 count 14 != s0.activeNodes 7 + 2t');
    });
    it('rreset on a dead / absent leaf is a no-op (shrunk script); regExpect stays null', () => {
        for (const t of [0, 1, 2]) {
            const r = run(script(BASE.concat([{ o: 'rreset', at: 'top', i: 99, t }])));
            assert.equal(r.failure, null, 't=' + t);
            assert.equal(r.scen['reset-top'], undefined);
        }
        const seen = [];
        run(resetScript(2), { laneOps: withLane((x, op, k) => { try { REGISTRY.ops.rreset(x, op, k); } finally { seen.push(x.regExpect); } }) });
        assert.deepEqual(seen, [null]);
    });
    it('D-b163-3: an rreset on a reset-less world (caps reset / owner / hook false, or no world reset method) is a no-op: 0 fails, counts nothing, no reset ran', () => {
        const capsOff = (k) => Object.freeze(Object.assign({}, liteS3Adapter, { caps: Object.freeze(Object.assign({}, liteS3Adapter.caps, { [k]: false })) }));
        const noMethod = Object.freeze(Object.assign({}, liteS3Adapter, { open: (o) => { const w = liteS3Adapter.open(o); delete w.reset; return w; } }));
        for (const [name, ad] of [['reset', capsOff('reset')], ['owner', capsOff('owner')], ['hook', capsOff('hook')], ['no W.reset', noMethod]]) {
            for (const t of [0, 1, 2]) {
                let nodes = -1;
                const lane = withLane((x, op, k) => { REGISTRY.ops.rreset(x, op, k); nodes = x.W.stats().activeNodes; });
                const r = runWorld(ad, script(BASE.concat([{ o: 'rreset', at: 'top', i: 0, t }])), { laneOps: lane });
                assert.equal(r.failure, null, name + ' t=' + t + ': ' + JSON.stringify(r.failure));
                assert.deepEqual({ ...r.scen }, {}, name + ' t=' + t);
                assert.deepEqual([r.checks.O8, r.checks.OW], [0, 0], name + ' t=' + t);
                assert.equal(nodes, 5, name + ' t=' + t + ': the BASE graph is intact (no reset, no fixture)');
            }
        }
        // the malformed check still runs first on a reset-less world (fail closed)
        assert.throws(() => runWorld(capsOff('reset'), script(BASE.concat([{ o: 'rreset', at: 'top', i: 0, t: 3 }])), { laneOps: REGISTRY.ops }), /unmodelled registry op/);
    });
    // B3 (REVIEW-S3a-r1): one must-fail row per judgeReset check; nth patches the k-th call of a world member during the rreset
    const nth = (key, k, f) => patched(key, (o) => { let n = 0; return (...a) => { const v = o(...a); return n++ === k ? f(v) : v; }; });
    const firstOp2 = (flags) => patched('hook', (hk) => (fn) => { let first = true; return hk((o, a, b) => { if (o === 2 && first) { first = false; fn(o, a, flags); } else fn(o, a, b); }); });
    const reAgg = (mk) => patched('reset', (rs) => () => { try { rs(); } catch (e) { if (e instanceof AggregateError) throw mk(e); throw e; } });
    const B3 = [
        ['edge', 0, nth('stats', 0, (v) => ({ ...v, activeLinks: v.activeLinks + 1 })), ['O8', 'mirror-links', 'reset t=0: edge list 6 != s0.activeLinks 7']],
        ['dA', 0, nth('stats', 1, (v) => ({ ...v, totalAllocations: v.totalAllocations + 1 })), ['O5', 'node-count', 'reset t=0: totalAllocations +1 != +0']],
        ['dG', 0, nth('stats', 1, (v) => ({ ...v, poolGrowths: v.poolGrowths + 1 })), ['O5', 'node-count', 'reset t=0: poolGrowths +1 != +0']],
        ['dD', 0, nth('stats', 1, (v) => ({ ...v, totalDisposals: v.totalDisposals - 1 })), ['O5', 'node-count', 'reset t=0: totalDisposals +6 != s0.activeNodes 7']],
        ['rank0', 0, firstOp2(32), ['O8', 'mirror-links', 'reset t=0: op-2 kind ranks E < C < S drop 1 times (allowed 0)']],
        ['rankX', 0, firstOp2(0), ['O8', 'mirror-links', 'reset t=0: op-2 #0 id 6 flags 0x0 is not E / C / S']],
        ['probe', 0, patched('hook', (hk) => (fn) => hk((o, a, b) => { if (o !== 1) fn(o, a, b); })), ['O8', 'mirror-links', 'reset t=0: probe op-1 id -1 not > max op-2 id 7']],
        ['noid', 0, patched('nodeId', () => () => undefined), ['O8', 'mirror-links', 'reset t=0: op-4 count 6 != rule I3 -1 (s0.activeLinks 6)']],
        ['order', 2, reAgg((e) => new AggregateError([...e.errors].reverse(), e.message)), ['OW', 'reset-cleanup', 'reset t=2: AggregateError errors [T_Q, T_R] != [T_R, T_Q]']],
        ['msg', 2, reAgg((e) => new AggregateError(e.errors, '[lite-signal] reset: cleanups threw')), ['OW', 'reset-cleanup', 'reset t=2: AggregateError message "[lite-signal] reset: cleanups threw" != "reset: cleanups threw"']],
        ['d6', 2, reAgg((e) => new AggregateError(e.errors, '[lite-signal] reset: no progress')), ['OW', 'reset-cleanup', 'reset t=2: d6: [lite-signal] reset: no progress']],
    ];
    for (const [id, t, lane, row] of B3) {
        it('B3 must-fail ' + id + ': exactly one fail row ' + row[0] + ' ' + row[1], () => {
            assert.deepEqual(failRows(run(resetScript(t), { laneOps: lane })), [row]);
        });
    }
    it('A6 retention (child, --expose-gc): 5 cycles x 100 top-level rresets at t=2, lite-leak on each escape + its T tokens + the census listener: size() 0 after gc every cycle; the twin lane keeping x.lastEsc >= 1', () => {
        const a = a6Run(null);
        assert.deepEqual(a.fails, [null, null, null, null, null]);
        assert.equal(a.tracked, 2000, '5 x 100 x (census listener + AggregateError + T_R + T_Q)');
        assert.deepEqual(a.sizes, [0, 0, 0, 0, 0]);
        const m = a6Run([['    judgeReset(x, t, s0, s1, c, edges, log, threw, esc, TQ, TR);', '    judgeReset(x, t, s0, s1, c, edges, log, threw, esc, TQ, TR);\n    x.lastEsc = esc;']]);
        assert.equal(m.tracked, 2000);
        for (const n of m.sizes) assert.ok(n >= 1, 'twin (x.lastEsc) sizes ' + JSON.stringify(m.sizes));
    });
    it('malformed rreset -> unmodelled throw (fail closed); in flight is not modelled in S3a', () => {
        for (const bad of [{ at: 'batch', i: 0, t: 0 }, { at: 'body', i: 0, t: 0 }, { at: 'computed', i: 0, t: 0 }, { at: undefined, i: 0, t: 0 },
            { at: 'top', i: 0, t: 3 }, { at: 'top', i: 0, t: -1 }, { at: 'top', i: 0, t: '1' }, { at: 'top', i: 0, t: 1.5 }, { at: 'top', i: 0 },
            { at: 'top', i: '0', t: 0 }, { at: 'top', i: 0.5, t: 0 }]) {
            assert.throws(() => run(script(BASE.concat([Object.assign({ o: 'rreset' }, bad)]))), /unmodelled registry op/, JSON.stringify(bad));
        }
    });
    it('the rebuild after an rreset counts no reuse-after-destroy, even after an earlier destroy', () => {
        const rebuild = (a, b) => ({ o: 'seq', ops: [{ o: 'sig', i: a, v: 3 }, { o: 'eff', i: b, spec: { k: 'identity', d: [a], role: 'eff' } }, { o: 'rbuilt' }] });
        const r = run(script(BASE.concat([{ o: 'rdestroy', at: 'top' }, rebuild(5, 6), { o: 'rreset', at: 'top', i: 5, t: 1 }, rebuild(7, 8)])));
        assert.equal(r.failure, null, JSON.stringify(r.failure));
        assert.deepEqual({ ...r.scen }, { 'destroy-top': 1, 'reuse-after-destroy': 1, 'reset-top': 1 });
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
    it('each load order in a FRESH node process: no throw, ROSTER 14 lanes, laneSpan 14, REGISTRY_PROBLEMS []', async () => {
        const { spawnSync } = await import('node:child_process');
        const soak = new URL('../bench/soak/', import.meta.url).href;
        for (const [first, second] of [['lanes/index.mjs', 'divergences.mjs'], ['divergences.mjs', 'lanes/index.mjs']]) {
            const src = 'const a = await import(' + JSON.stringify(soak + first) + '); const b = await import(' +
                JSON.stringify(soak + second) + '); const idx = ' + (first === 'lanes/index.mjs' ? 'a' : 'b') + '; const div = ' +
                (first === 'lanes/index.mjs' ? 'b' : 'a') + '; console.log(JSON.stringify([idx.ROSTER.length, ' +
                'idx.laneSpan(idx.ROSTER), idx.ROSTER.includes("REGISTRY"), div.REGISTRY_PROBLEMS]));';
            const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
            assert.equal(r.status, 0, first + ' first: exit ' + r.status + ' ' + r.stderr);
            assert.deepEqual(JSON.parse(r.stdout.trim()), [14, 14, true, []], first + ' first');
        }
    });
});
