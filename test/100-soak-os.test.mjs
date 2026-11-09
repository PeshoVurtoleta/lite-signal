// test/100-soak-os.test.mjs -- burst 154, R8 batch A1 (PLAN-R8-snapshot.md GROUP A tasks 1-4, ASSERTIONS 1-3; CURRENT
// R8-2 names, R8-12 semantics, R8-16 kernel mutants).
// Oracle: the INTERFACE contract of the OS exports of bench/soak/oracles.mjs (checkOsRoundtrip, checkOsModel,
// checkOsRefire, osCleanClass, checkOsCleanBit) and the engine facts of the R8 A0 census (.handoff/r8-evidence/A0/
// README.txt: 200 graphs, 0 roundtrip diffs, 0 body runs inside restore(), clean reads run 0 bodies). Exact values below
// come from the hand graph H (probed on the live Signal.js, sha256/8 ea0b64d1), not from a run of the new code.
// Groups: TREE (200 seeded graphs), MUTANT (16 single-field rows), MALFORMED (shape matrix), MODEL, REFIRE / CLEAN-BIT
// (truth table + TypeError matrix), KERNEL (live Signal.js vs the three A0 kernel mutants, rebuilt at runtime from the live
// file by one count-checked patch each), GC (child --expose-gc: 1e6 pass-path calls, minor 0, plus a must-fail control).
// Every row is new (no prior OS export): on HEAD the file fails at import (missing exports).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../bench/soak/oracles.mjs';
import { checkOsRoundtrip, checkOsModel, checkOsRefire, osCleanClass, checkOsCleanBit } from '../bench/soak/oracles.mjs';
import { Model } from '../bench/soak/model.mjs';
import { createRegistry } from '../Signal.js';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SIG_URL = new URL('../Signal.js', import.meta.url);
const WATCH_URL = new URL('../Watch.js', import.meta.url);
const ORACLES_URL = new URL('../bench/soak/oracles.mjs', import.meta.url);

const os = (sig, id, detail) => ({ oracle: 'OS', sig, id, detail });
const clone = (s) => structuredClone(s);

// ---- the hand graph H (keys a b c e o d f nv; ids 1..8 in that order) -------------------------------------------------
// a=3, b=5 signals; c = a+b (clean, markEpoch 3, observed by e); e effect reading c; o an effect reading nothing (never
// re-runs, so its owned child survives); d = a*10 created under o (owned: ownerId 5, ownerPos 0, clean, markEpoch 0);
// f = b*2 read once then b moved (dirty); nv = b+100 never read (never evaluated).
const KEYS = ['a', 'b', 'c', 'e', 'o', 'd', 'f', 'nv'];
function bodies(env) {
    const T = env.T, R = env.runs;
    return {
        c: () => { R.c++; return T.a() + T.b(); },
        e: () => { R.e++; T.c(); },
        o: () => { R.o++; },
        d: () => { R.d++; return T.a() * 10; },
        f: () => { R.f++; return T.b() * 2; },
        nv: () => { R.nv++; return T.b() + 100; },
    };
}
const newEnv = () => ({ T: {}, runs: { c: 0, e: 0, o: 0, d: 0, f: 0, nv: 0 } });
function buildH(createReg) {
    const r = createReg();
    const L = newEnv(), B = bodies(L), T = L.T;
    T.a = r.signal(1); T.b = r.signal(2);
    T.c = r.computed(B.c);
    T.e = r.effect(B.e);
    T.a.set(3);
    T.o = r.effect(B.o);
    T.d = r.runWithOwner(T.o, () => r.computed(B.d));
    T.d();
    T.f = r.computed(B.f);
    T.f();
    T.nv = r.computed(B.nv);
    T.b.set(5);
    const keyOfId = new Map();
    for (const k of KEYS) keyOfId.set(r.nodeId(T[k]), k);
    return { r, L, keyOfId };
}
const H = buildH(createRegistry);
const S = H.r.snapshot();
const recOf = (s, id) => s.nodes.find((n) => n.id === id);

/** One restore event on a kernel: S1 -> restore -> S2, body runs inside restore, first-read runs per computed. */
function restoreEvent(createReg) {
    const { r, keyOfId } = buildH(createReg);
    const S1 = r.snapshot();
    const R2 = newEnv(), B2 = bodies(R2);
    const fnsById = {};
    for (const rec of S1.nodes) if (rec.kind !== 'signal') fnsById[rec.id] = B2[keyOfId.get(rec.id)];
    const handles = {};
    const sum = () => R2.runs.c + R2.runs.e + R2.runs.o + R2.runs.d + R2.runs.f + R2.runs.nv;
    const before = sum();
    const r2 = r.restore(S1, { fnsById, handles });
    const refire = sum() - before;
    for (const rec of S1.nodes) R2.T[keyOfId.get(rec.id)] = handles[rec.id];
    const S2 = r2.snapshot();
    const clean = [];
    for (const rec of S1.nodes) {
        if (rec.kind !== 'computed' && rec.kind !== 'computedBox') continue;
        const k = keyOfId.get(rec.id), b0 = R2.runs[k];
        r2.untrack(() => R2.T[k]());
        clean.push(checkOsCleanBit('H', rec, R2.runs[k] - b0));
    }
    return { S1, S2, refire, roundtrip: checkOsRoundtrip(S1, S2), refireFail: checkOsRefire('H', refire), clean };
}

describe('H: the hand graph is the probed one (pins every literal below)', () => {
    it('ids, classes, gv, nextId', () => {
        assert.deepEqual(S.nodes.map((n) => n.id + ':' + n.kind), ['1:signal', '2:signal', '3:computed', '4:effect', '5:effect', '6:computed', '7:computed', '8:computed']);
        assert.deepEqual([S.gv, S.nextId], [3, 9]);
        assert.deepEqual([3, 6, 7, 8].map((id) => osCleanClass(recOf(S, id))), ['clean', 'clean', 'dirty', 'never']);
        const r6 = recOf(S, 6);
        assert.deepEqual([r6.flags, r6.value, r6.version, r6.ownerId, r6.ownerPos, r6.deps, r6.subPos, r6.evalVersion, r6.markEpoch], [1, 30, 2, 5, 0, [1], [1], 2, 0]);
        assert.equal(recOf(S, 3).markEpoch, 3);
    });
});

// ---- TREE: 200 seeded graphs (the A0 census generator, trimmed: same seeds, same op mix; plan shuffle = Fisher-Yates) --
function mulberry32(a) {
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function makeBody(spec, env) {
    const rd = (k) => (env.isBox[k] ? env.T[k].get() : env.T[k]());
    if (spec.kind === 'effect') {
        return function effBody() {
            env.runs[spec.key]++;
            let v = 0;
            for (const d of spec.deps) { try { v += rd(d); } catch (e) { v += 100; } }
            if (spec.child) {
                const ck = env.childKey();
                const cspec = { kind: 'computed', key: ck, deps: spec.deps.slice(0, 1), mod: 3, thr: false, cond: -1 };
                const ch = env.r.computed(makeBody(cspec, env));
                env.T[ck] = ch; env.isBox[ck] = false; env.onChild(ck, ch, cspec);
                if (spec.readChild) { try { v += ch(); } catch (e) { v += 1; } }
            }
            env.sink = v;
        };
    }
    return function compBody() {
        env.runs[spec.key]++;
        let v = 0;
        for (let i = 0; i < spec.deps.length; i++) {
            if (i === spec.cond && (v & 1) === 1) continue;
            try { v += rd(spec.deps[i]); } catch (e) { v += 50; }
        }
        if (spec.thr && v % 5 === 3) throw new Error('thr');
        return spec.mod > 0 ? v % spec.mod : v;
    };
}
/** Graph g: returns { S1, S2, refire } (S2 = the restored registry's snapshot before any read). */
function treeGraph(g) {
    const R = mulberry32((0x0E8A0 + g * 0x9E3779B1) | 0);
    const ri = (n) => Math.floor(R() * n);
    const r = createRegistry();
    const specs = {};
    const L = { r, T: [], isBox: [], runs: new Array(4096).fill(0), sink: 0, childKey: null, onChild: null };
    let nextKey = 0;
    const keyOfId = new Map();
    L.childKey = () => nextKey++;
    L.onChild = (ck, ch, cspec) => { keyOfId.set(r.nodeId(ch), ck); specs[ck] = cspec; };
    const sigKeys = [], depable = [], comps = [], effs = [], ownersAvail = [];
    const rdL = (k) => (L.isBox[k] ? L.T[k].get() : L.T[k]());
    const nS = 2 + ri(5), nC = 3 + ri(10), nE = 1 + ri(4);
    const plan = [];
    for (let i = 0; i < nS; i++) plan.push('s');
    for (let i = 0; i < nC; i++) plan.push('c');
    for (let i = 0; i < nE; i++) plan.push('e');
    // Fisher-Yates on R (b158). The A0 census shuffled with sort(() => R() - 0.5): the comparator call order is V8's
    // sort algorithm, so the population moved between Node majors (node 22 / 24 drew 2468 nodes, node 26 drew 2463).
    for (let i = plan.length - 1; i > 1; i--) { const j = 1 + ri(i); const t = plan[i]; plan[i] = plan[j]; plan[j] = t; }
    for (const p of plan) {
        const key = nextKey++;
        if (p === 's') {
            const box = R() < 0.3;
            L.T[key] = box ? r.signalBox(ri(10)) : r.signal(ri(10)); L.isBox[key] = box;
            sigKeys.push(key); depable.push(key);
            specs[key] = { kind: box ? 'signalBox' : 'signal', key };
        } else {
            const deps = [];
            const nd = 1 + ri(3);
            for (let i = 0; i < nd; i++) deps.push(depable[ri(depable.length)]);
            const owned = ownersAvail.length > 0 && R() < 0.3 ? ownersAvail[ri(ownersAvail.length)] : -1;
            const spec = p === 'c'
                ? { kind: R() < 0.3 ? 'computedBox' : 'computed', key, deps, mod: R() < 0.4 ? 2 + ri(3) : 0, thr: R() < 0.15, cond: nd > 1 && R() < 0.5 ? nd - 1 : -1 }
                : { kind: 'effect', key, deps, child: R() < 0.25, readChild: R() < 0.5 };
            specs[key] = spec;
            const mk = () => spec.kind === 'computedBox' ? r.computedBox(makeBody(spec, L)) : spec.kind === 'computed' ? r.computed(makeBody(spec, L)) : r.effect(makeBody(spec, L));
            L.T[key] = owned >= 0 ? r.runWithOwner(L.T[owned], mk) : mk();
            L.isBox[key] = spec.kind === 'computedBox';
            if (p === 'c') { comps.push(key); if (owned < 0) depable.push(key); ownersAvail.push(key); }
            else { effs.push(key); if (owned < 0) ownersAvail.push(key); }
        }
        keyOfId.set(r.nodeId(L.T[key]), key);
    }
    const nOps = 10 + ri(30);
    const isDep = new Set(); for (const k of comps.concat(effs)) for (const d of specs[k].deps) isDep.add(d);
    for (let o = 0; o < nOps; o++) {
        const x = R();
        if (x < 0.45) { const k = sigKeys[ri(sigKeys.length)]; L.T[k].set(ri(10)); }
        else if (x < 0.55) { const a = sigKeys[ri(sigKeys.length)], b = sigKeys[ri(sigKeys.length)]; r.batch(() => { L.T[a].set(ri(10)); L.T[b].set(ri(10)); }); }
        else if (x < 0.85) { const k = comps[ri(comps.length)]; if (r.nodeId(L.T[k]) !== undefined) { try { r.untrack(() => rdL(k)); } catch (e) { /* thr */ } } }
        else if (x < 0.92) {
            const cand = comps.concat(effs).filter((k) => !isDep.has(k) && r.nodeId(L.T[k]) !== undefined);
            if (cand.length > 0) r.dispose(L.T[cand[ri(cand.length)]]);
        } else {
            const key = nextKey++;
            const liveDep = depable.filter((d) => r.nodeId(L.T[d]) !== undefined);
            const spec = { kind: 'computed', key, deps: [liveDep[ri(liveDep.length)]], mod: 0, thr: false, cond: -1 };
            specs[key] = spec; isDep.add(spec.deps[0]); L.T[key] = r.computed(makeBody(spec, L)); L.isBox[key] = false; comps.push(key);
            keyOfId.set(r.nodeId(L.T[key]), key);
        }
    }
    const tail = ri(3); for (let i = 0; i < tail; i++) L.T[sigKeys[ri(sigKeys.length)]].set(ri(10));
    const S1 = r.snapshot();
    const R2 = { r: null, T: [], isBox: [], runs: new Array(4096).fill(0), sink: 0, childKey: null, onChild: () => {} };
    let nextKey2 = 100000;
    R2.childKey = () => nextKey2++;
    const fnsById = {};
    for (const rec of S1.nodes) {
        const key = keyOfId.get(rec.id);
        R2.isBox[key] = rec.kind === 'signalBox' || rec.kind === 'computedBox';
        if (rec.kind === 'computed' || rec.kind === 'computedBox' || rec.kind === 'effect') fnsById[rec.id] = makeBody(specs[key], R2);
    }
    const handles = {};
    const before = R2.runs.reduce((x, y) => x + y, 0);
    const r2 = r.restore(S1, { fnsById, handles });
    const refire = R2.runs.reduce((x, y) => x + y, 0) - before;
    const S2 = r2.snapshot();
    r.destroy(); r2.destroy();
    return { S1, S2, refire };
}

describe('TREE: 200 seeded graphs (ASSERTION 1)', () => {
    it('checkOsRoundtrip(S1, S2) null and checkOsRefire null on 200/200; the TREE population is exercised', () => {
        let nulls = 0, refireNulls = 0, nodes = 0, cleanMarked = 0, owned = 0;
        const kinds = {};
        for (let g = 0; g < 200; g++) {
            const { S1, S2, refire } = treeGraph(g);
            const f = checkOsRoundtrip(S1, S2);
            assert.equal(f, null, 'graph ' + g + ': ' + (f && f.detail));
            nulls++;
            if (checkOsRefire('g' + g, refire) === null) refireNulls++;
            nodes += S1.nodes.length;
            for (const n of S1.nodes) {
                kinds[n.kind] = (kinds[n.kind] || 0) + 1;
                if (n.ownerId !== null) owned++;
                if (n.clean && n.markEpoch !== 0 && n.kind !== 'effect') cleanMarked++;
            }
        }
        assert.equal(nulls, 200);
        assert.equal(refireNulls, 200);
        // b158 re-pin after the Fisher-Yates shuffle (probed on node v26.8.2); the A0 census-none.json (2463 nodes) used the
        // V8-order shuffle, so it no longer matches this population.
        assert.equal(nodes, 2465, 'TREE population (Fisher-Yates plan shuffle)');
        assert.deepEqual(kinds, { signal: 551, signalBox: 268, computed: 1088, computedBox: 286, effect: 272 });
        assert.equal(owned, 101);
        assert.ok(cleanMarked > 0, 'clean computeds with markEpoch != 0 exist (the M-OS-roundtrip tamper has a target)');
    });
    // b158: the sort(() => R() - 0.5) shuffle fails this row
    it('the population does not depend on the engine sort: graphs 0-49 with Array.prototype.sort replaced by a stable linear insertion sort deep-equal the unpatched S1', () => {
        const base = [];
        for (let g = 0; g < 50; g++) base.push(treeGraph(g).S1);
        const orig = Array.prototype.sort;
        const alt = [];
        Array.prototype.sort = function (cmp) {
            const c = cmp === undefined ? (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0) : cmp;
            for (let i = 1; i < this.length; i++) {
                const x = this[i]; let j = i - 1;
                while (j >= 0 && c(this[j], x) > 0) { this[j + 1] = this[j]; j--; }
                this[j + 1] = x;
            }
            return this;
        };
        try { for (let g = 0; g < 50; g++) alt.push(treeGraph(g).S1); } finally { Array.prototype.sort = orig; }
        assert.deepEqual(alt, base);
    });
});

// ---- MUTANT: 16 single-field rows on S (b side), each the right id + EXACT detail ------------------------------------
describe('MUTANT: 16 single-field differences (ASSERTION 1)', () => {
    const at6 = (s) => s.nodes[5];   // id 6, the owned clean computed
    const rows = [
        ['gv', (s) => { s.gv = 4; }, os('roundtrip', null, 'gv a=3 b=4')],
        ['nextId', (s) => { s.nextId = 10; }, os('roundtrip', null, 'nextId a=9 b=10')],
        ['id', (s) => { at6(s).id = 99; }, os('roundtrip', 6, 'node#6 record a=present b=absent')],
        ['kind', (s) => { at6(s).kind = 'computedBox'; }, os('roundtrip', 6, 'node#6 kind a="computed" b="computedBox"')],
        ['flags', (s) => { at6(s).flags = 3; }, os('roundtrip', 6, 'node#6 flags a=1 b=3')],
        ['value', (s) => { at6(s).value = 31; }, os('roundtrip', 6, 'node#6 value a=30 b=31')],
        ['version', (s) => { at6(s).version = 5; }, os('roundtrip', 6, 'node#6 version a=2 b=5')],
        ['clean', (s) => { at6(s).clean = false; }, os('roundtrip', 6, 'node#6 clean a=true b=false')],
        ['ownerId', (s) => { at6(s).ownerId = 4; }, os('roundtrip', 6, 'node#6 ownerId a=5 b=4')],
        ['ownerPos', (s) => { at6(s).ownerPos = 1; }, os('roundtrip', 6, 'node#6 ownerPos a=0 b=1')],
        ['deps', (s) => { at6(s).deps = [2]; }, os('roundtrip', 6, 'node#6 deps a=[1] b=[2]')],
        ['subPos', (s) => { at6(s).subPos = [0]; }, os('roundtrip', 6, 'node#6 subPos a=[1] b=[0]')],
        ['evalVersion', (s) => { at6(s).evalVersion = 1; }, os('roundtrip', 6, 'node#6 evalVersion a=2 b=1')],
        ['markEpoch', (s) => { at6(s).markEpoch = 1; }, os('roundtrip', 6, 'node#6 markEpoch a=0 b=1')],
        ['missing id', (s) => { s.nodes.splice(6, 1); }, os('roundtrip', 7, 'node#7 record a=present b=absent')],
        ['extra id', (s) => { s.nodes.push({ ...clone(s.nodes[7]), id: 42 }); }, os('roundtrip', 42, 'node#42 record a=absent b=present')],
    ];
    it('16 rows', () => assert.equal(rows.length, 16));
    for (const [name, mut, want] of rows) {
        it(name + ' -> ' + want.detail, () => {
            const b = clone(S);
            mut(b);
            assert.deepEqual(checkOsRoundtrip(S, b), want);
            assert.equal(checkOsRoundtrip(S, clone(S)), null, 'the unmutated twin passes');
        });
    }
    it('Object.is, no coercion: value 0 vs -0, 3 vs "3"; NaN equals NaN; node order is not judged', () => {
        const a = clone(S), b = clone(S);
        a.nodes[0].value = 0; b.nodes[0].value = -0;
        assert.deepEqual(checkOsRoundtrip(a, b), os('roundtrip', 1, 'node#1 value a=0 b=-0'));
        b.nodes[0].value = '0';
        assert.deepEqual(checkOsRoundtrip(a, b), os('roundtrip', 1, 'node#1 value a=0 b="0"'));
        a.nodes[0].value = NaN; b.nodes[0].value = NaN;
        assert.equal(checkOsRoundtrip(a, b), null);
        const c = clone(S); c.nodes.reverse();
        assert.equal(checkOsRoundtrip(S, c), null);
    });
    it('values are Object.is, never elementwise: the SAME [NaN] array on both sides -> null; [1] vs a separate [1] -> roundtrip', () => {
        const a = clone(S), b = clone(S);
        const same = [NaN];
        a.nodes[0].value = same; b.nodes[0].value = same;
        assert.equal(checkOsRoundtrip(a, b), null);
        a.nodes[0].value = [1]; b.nodes[0].value = [1];
        assert.deepEqual(checkOsRoundtrip(a, b), os('roundtrip', 1, 'node#1 value a=[1] b=[1]'));
    });
    it('first difference order: gv before nextId before a record; a.nodes order before ids only in b; detail cut to 240', () => {
        const b = clone(S); b.gv = 4; b.nextId = 10; at6(b).flags = 3;
        assert.equal(checkOsRoundtrip(S, b).detail, 'gv a=3 b=4');
        b.gv = 3;
        assert.equal(checkOsRoundtrip(S, b).detail, 'nextId a=9 b=10');
        b.nextId = 9; b.nodes[2].flags = 9; b.nodes.push({ ...clone(b.nodes[7]), id: 42 });
        assert.equal(checkOsRoundtrip(S, b).detail, 'node#3 flags a=1 b=9');
        const a = clone(S), c = clone(S);
        a.nodes[0].value = 'x'.repeat(400); c.nodes[0].value = 'y';
        const f = checkOsRoundtrip(a, c);
        assert.equal(f.detail.length, 240);
        assert.ok(f.detail.startsWith('node#1 value a="xxx') && f.detail.endsWith('...'));
    });
});

// ---- MALFORMED: 12 b-side rows + an a-side row; never null, never a throw --------------------------------------------
describe('MALFORMED: exact-key shape check (ASSERTION 1)', () => {
    const rows = [
        ['id -0', (s) => { s.nodes[5].id = -0; }, 'node[5] id -0'],
        ['id NaN', (s) => { s.nodes[5].id = NaN; }, 'node[5] id NaN'],
        ['id 1.5', (s) => { s.nodes[5].id = 1.5; }, 'node[5] id 1.5'],
        ['id 0', (s) => { s.nodes[5].id = 0; }, 'node[5] id 0'],
        ['id 2^31', (s) => { s.nodes[5].id = 2 ** 31; }, 'node[5] id 2147483648'],
        ['id "3"', (s) => { s.nodes[5].id = '3'; }, 'node[5] id "3"'],
        ['duplicate id', (s) => { s.nodes[5].id = 3; }, 'node[5] duplicate id 3'],
        ['unknown key', (s) => { s.nodes[5].zz = 1; }, 'node[5] unknown key zz'],
        ['missing markEpoch', (s) => { delete s.nodes[5].markEpoch; }, 'node[5] missing markEpoch'],
        ['deps/subPos length', (s) => { s.nodes[5].subPos = [1, 0]; }, 'node[5] deps/subPos length 1/2'],
        ['ownerPos 0 with ownerId null', (s) => { s.nodes[0].ownerPos = 0; }, 'node[0] ownerPos 0 with ownerId null'],
        ['v:2', (s) => { s.v = 2; }, 'v 2'],
    ];
    it('12 rows', () => assert.equal(rows.length, 12));
    for (const [name, mut, reason] of rows) {
        it(name + ' -> malformed b: ' + reason, () => {
            const b = clone(S);
            mut(b);
            assert.deepEqual(checkOsRoundtrip(S, b), os('roundtrip', null, 'malformed b: ' + reason));
        });
    }
    it('a side first: malformed a: gv -0 (b also malformed)', () => {
        const a = clone(S), b = clone(S);
        a.gv = -0; b.v = 2;
        assert.deepEqual(checkOsRoundtrip(a, b), os('roundtrip', null, 'malformed a: gv -0'));
    });
    it('more reasons: gv 0, nextId 1.5, kind, flags -0, clean 1, ownerPos -1 with an owner, deps id 0, subPos -1, missing / extra snapshot key, non-object, throwing getter', () => {
        const cases = [
            [(s) => { s.gv = 0; }, 'gv 0'],
            [(s) => { s.nextId = 1.5; }, 'nextId 1.5'],
            [(s) => { s.nodes[5].kind = 'memo'; }, 'node[5] kind "memo"'],
            [(s) => { s.nodes[5].flags = -0; }, 'node[5] flags -0'],
            [(s) => { s.nodes[5].clean = 1; }, 'node[5] clean 1'],
            [(s) => { s.nodes[5].ownerPos = -1; }, 'node[5] ownerPos -1 with ownerId 5'],
            [(s) => { s.nodes[5].ownerId = 2 ** 31; }, 'node[5] ownerId 2147483648'],
            [(s) => { s.nodes[5].deps = [0]; }, 'node[5] deps[0] 0'],
            [(s) => { s.nodes[5].subPos = [-1]; }, 'node[5] subPos[0] -1'],
            [(s) => { s.nodes[5].evalVersion = 2 ** 31; }, 'node[5] evalVersion 2147483648'],
            [(s) => { delete s.gv; }, 'missing gv'],
            [(s) => { s.extra = 1; }, 'unknown key extra'],
            [(s) => { s.nodes[5][Symbol('k')] = 1; }, 'node[5] unknown key symbol'],
            [(s) => { s.nodes[2] = null; }, 'node[2] not an object'],
            [(s) => { s.nodes = {}; }, 'nodes (object)'],
            [(s) => { Object.defineProperty(s.nodes[5], 'value', { enumerable: true, get() { throw new Error('boom'); } }); }, 'threw boom'],
        ];
        for (const [mut, reason] of cases) {
            const b = clone(S);
            mut(b);
            const f = checkOsRoundtrip(S, b);
            assert.deepEqual(f, os('roundtrip', null, 'malformed b: ' + reason));
        }
        assert.deepEqual(checkOsRoundtrip(S, null), os('roundtrip', null, 'malformed b: snapshot null'));
        assert.deepEqual(checkOsRoundtrip(undefined, S), os('roundtrip', null, 'malformed a: snapshot undefined'));
        const t = clone(S);
        Object.defineProperty(t, 'gv', { enumerable: true, get() { throw new Error('boom'); } });
        assert.deepEqual(checkOsRoundtrip(S, t), os('roundtrip', null, 'malformed b: threw boom'));
    });
    it('boundary ids pass the shape: 1 and 2^31 - 1', () => {
        const a = clone(S);
        a.nodes[7].id = 2 ** 31 - 1;
        assert.equal(checkOsRoundtrip(a, clone(a)), null);
    });
});

// ---- MODEL: checkOsModel(S, model copy, idOf) ------------------------------------------------------------------------
describe('MODEL: checkOsModel', () => {
    // model indices 0..7 = keys a b c e o d f nv; ids 1..8
    function mkModel() {
        const m = new Model({ childEffects: 'parent-run' });
        m.addSignal(0, 3, {}); m.addSignal(1, 5, {});
        m.addComputed(2, {}); m.addEffect(3, {}); m.addEffect(4, {}); m.addComputed(5, {}, 4); m.addComputed(6, {}); m.addComputed(7, {});
        return m;
    }
    const ids = () => Int32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    it('the matching model passes', () => assert.equal(checkOsModel(S, mkModel(), ids()), null));
    it('kind mismatch', () => {
        const idOf = ids(); idOf[0] = 3; idOf[2] = 1;
        assert.deepEqual(checkOsModel(S, mkModel(), idOf), os('roundtrip', 3, 'node#3 kind snap=computed model=s (model#0)'));
    });
    it('value mismatch (Object.is, no coercion)', () => {
        const m = mkModel(); m.n[1].v = 6;
        assert.deepEqual(checkOsModel(S, m, ids()), os('roundtrip', 2, 'node#2 value snap=5 model=6 (model#1)'));
        const m2 = mkModel(); m2.n[0].v = '3';
        assert.deepEqual(checkOsModel(S, m2, ids()), os('roundtrip', 1, 'node#1 value snap=3 model="3" (model#0)'));
    });
    it('count mismatch: a dead model node with its record still in the snapshot', () => {
        const m = mkModel(); m.n[7].live = false;
        const idOf = ids(); idOf[7] = -1;
        assert.deepEqual(checkOsModel(S, m, idOf), os('roundtrip', null, 'nodes 8 != live model nodes 7'));
    });
    it('two indices -> one id', () => {
        const idOf = ids(); idOf[1] = 1;
        assert.deepEqual(checkOsModel(S, mkModel(), idOf), os('roundtrip', 1, 'node#1 mapped by model#0 and model#1'));
    });
    it('a live node with idOf -1, or past idOf.length, has no node', () => {
        const idOf = ids(); idOf[7] = -1;
        assert.deepEqual(checkOsModel(S, mkModel(), idOf), os('roundtrip', null, 'model#7 (c) live but idOf -1 (no node)'));
        assert.deepEqual(checkOsModel(S, mkModel(), ids().subarray(0, 7)), os('roundtrip', null, 'model#7 (c) live but idOf -1 (no node)'));
    });
    it('an id with no record', () => {
        const idOf = ids(); idOf[7] = 99;
        assert.deepEqual(checkOsModel(S, mkModel(), idOf), os('roundtrip', 99, 'node#99 absent for model#7 (c)'));
    });
    it('a malformed snap reports, never throws', () => {
        const b = clone(S); b.v = 2;
        assert.deepEqual(checkOsModel(b, mkModel(), ids()), os('roundtrip', null, 'malformed snap: v 2'));
    });
    it('TypeError: non-Model, idOf not an Int32Array, a live idOf entry 0 / -2', () => {
        assert.throws(() => checkOsModel(S, {}, ids()), TypeError);
        assert.throws(() => checkOsModel(S, { n: mkModel().n }, ids()), TypeError);
        assert.throws(() => checkOsModel(S, null, ids()), TypeError);
        assert.throws(() => checkOsModel(S, mkModel(), [1, 2, 3, 4, 5, 6, 7, 8]), TypeError);
        assert.throws(() => checkOsModel(S, mkModel(), Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8])), TypeError);
        assert.throws(() => checkOsModel(S, mkModel(), Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8])), TypeError);
        const z = ids(); z[3] = 0;
        assert.throws(() => checkOsModel(S, mkModel(), z), /idOf\[3\] must be -1 or an id >= 1, got 0/);
        const n2 = ids(); n2[3] = -2;
        assert.throws(() => checkOsModel(S, mkModel(), n2), TypeError);
    });
});

// ---- REFIRE / CLEAN-BIT (ASSERTION 2) --------------------------------------------------------------------------------
describe('REFIRE + CLEAN-BIT (ASSERTION 2)', () => {
    it('checkOsRefire: 0 -> null, 1 -> refire', () => {
        assert.equal(checkOsRefire('L', 0), null);
        assert.deepEqual(checkOsRefire('L', 1), { oracle: 'OS', sig: 'refire', detail: 'L: 1 body run(s) during restore (want 0)' });
    });
    it('7 TypeError rows', () => {
        for (const bad of [-0, -1, 1.5, NaN, 2 ** 53, '0']) assert.throws(() => checkOsRefire('L', bad), TypeError, String(bad));
        assert.throws(() => checkOsRefire(7, 0), /checkOsRefire: label must be a string, got 7/);
        assert.throws(() => checkOsRefire('L', -0), /runs must be an integer >= 0, got -0/);
    });
    const clean = recOf(S, 3), never = recOf(S, 8), dirty = recOf(S, 7);
    it('osCleanClass: clean / never / dirty, computedBox accepted, TypeError otherwise', () => {
        assert.deepEqual([osCleanClass(clean), osCleanClass(never), osCleanClass(dirty)], ['clean', 'never', 'dirty']);
        assert.equal(osCleanClass({ ...clean, kind: 'computedBox' }), 'clean');
        for (const bad of [recOf(S, 1), recOf(S, 4), null, undefined, 3, { kind: 'Computed' }]) assert.throws(() => osCleanClass(bad), TypeError);
    });
    it('osCleanClass fails closed on clean / evalVersion: missing, NaN, a string clean, evalVersion -0 -> TypeError; version is not read', () => {
        assert.throws(() => osCleanClass({ kind: 'computed' }), /osCleanClass: rec.clean must be a boolean and rec.evalVersion an int32 \(not -0\), got clean undefined, evalVersion undefined/);
        assert.throws(() => osCleanClass({ kind: 'computed', clean: false, evalVersion: NaN }), /got clean false, evalVersion NaN/);
        assert.throws(() => osCleanClass({ kind: 'computed', clean: 'true', evalVersion: 5 }), /got clean "true", evalVersion 5/);
        assert.throws(() => osCleanClass({ ...clean, evalVersion: -0 }), /got clean true, evalVersion -0/);
        assert.throws(() => checkOsCleanBit('L', { kind: 'computed' }, 7), TypeError);
        assert.equal(osCleanClass({ ...never, version: 7 }), 'never');
        assert.equal(osCleanClass({ ...dirty, version: 0 }), 'dirty');
    });
    it('truth table: clean/0 null, clean/1 fail, never/0 fail, never/1 null, dirty/0 null, dirty/1 null', () => {
        assert.equal(checkOsCleanBit('L', clean, 0), null);
        assert.deepEqual(checkOsCleanBit('L', clean, 1), { oracle: 'OS', sig: 'clean-bit', detail: 'L: clean node#3 ran 1 body run(s) on its first read (want 0)' });
        assert.deepEqual(checkOsCleanBit('L', never, 0), { oracle: 'OS', sig: 'clean-bit', detail: 'L: never-evaluated node#8 ran 0 body runs on its first read (want >= 1)' });
        assert.equal(checkOsCleanBit('L', never, 1), null);
        assert.equal(checkOsCleanBit('L', never, 2), null);
        assert.equal(checkOsCleanBit('L', dirty, 0), null);
        assert.equal(checkOsCleanBit('L', dirty, 1), null);
    });
    it('checkOsCleanBit TypeErrors: runs -0 / -1 / 1.5 / NaN / 2^53 / "0", label 7, rec a signal / effect / null', () => {
        for (const bad of [-0, -1, 1.5, NaN, 2 ** 53, '0']) assert.throws(() => checkOsCleanBit('L', clean, bad), TypeError, String(bad));
        assert.throws(() => checkOsCleanBit(7, clean, 0), /checkOsCleanBit: label must be a string, got 7/);
        for (const bad of [recOf(S, 1), recOf(S, 4), null]) assert.throws(() => checkOsCleanBit('L', bad, 0), TypeError);
    });
});

// ---- KERNEL: one real-engine must-fail per check (A0 tampers -> R8-16 kernel mutants) --------------------------------
// Each mutant is rebuilt from the LIVE Signal.js by one count-checked patch (so the row runs in CI, where .handoff/ is
// absent); when the A0 kernel copy exists it must be byte-identical to the rebuilt one.
const MUTANTS = {
    'M-OS-roundtrip': [
        '                    node.evalVersion = evs[i];   // D-M: the recorded stamps\n                    node.markEpoch = mes[i];\n',
        '                    node.evalVersion = evs[i];   // D-M: the recorded stamps\n',
    ],
    'M-OS-refire': [
        '                disposeFn[NODE_GEN] = birthGen;\n                handle = disposeFn;\n',
        '                disposeFn[NODE_GEN] = birthGen;\n                handle = disposeFn;\n                try { fn(); } catch (e) { /* M-OS-refire */ }\n',
    ],
    'M-OS-clean': [
        '                    node.evalVersion = evs[i];   // D-M: the recorded stamps\n',
        '                    node.evalVersion = 0;   // M-OS-clean\n',
    ],
};
const TMP = mkdtempSync(join(tmpdir(), 'lite-soak-os-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const LIVE_SRC = readFileSync(SIG_URL, 'utf8');
async function loadMutant(name) {
    const [from, to] = MUTANTS[name];
    const n = LIVE_SRC.split(from).length - 1;
    assert.equal(n, 1, name + ': patch site must match exactly once, got ' + n);
    const src = LIVE_SRC.replace(from, () => to);
    // A0 kernels re-cut on Signal.js 91c507df (the ARG-E1 F3 / F8 engine) by ARG-E1 B3 (== test/45 SNAP_ROWS shas); the e26168ce cut (AUD-E2b B2) is A0/kernels-e26168ce/, the ca39e1f4 cut (AUD-E1 B2b) is
    // A0/kernels-ca39e1f4/, the c8f6cd1e cut (b176 B2b) A0/kernels-c8f6cd1e/, the d235e505 cut (b165 G2) A0/kernels-d235e505/,
    // the ea0b64d1 cut A0/kernels-ea0b64d1/
    const a0 = join(ROOT, '.handoff', 'r8-evidence', 'A0', 'kernels', name, 'Signal.js');
    if (existsSync(a0)) assert.equal(src, readFileSync(a0, 'utf8'), name + ': rebuilt kernel differs from the A0 copy');
    const dir = mkdtempSync(join(TMP, name + '-'));
    writeFileSync(join(dir, 'Signal.js'), src);
    copyFileSync(WATCH_URL, join(dir, 'Watch.js'));
    return (await import(pathToFileURL(join(dir, 'Signal.js')).href)).createRegistry;
}

describe('KERNEL: one real-engine must-fail per check (ASSERTION 2)', () => {
    it('live Signal.js twin: roundtrip null, refire 0 -> null, every clean-bit null', () => {
        const ev = restoreEvent(createRegistry);
        assert.equal(ev.roundtrip, null);
        assert.equal(ev.refire, 0);
        assert.equal(ev.refireFail, null);
        assert.deepEqual(ev.clean, [null, null, null, null]);
    });
    it('M-OS-roundtrip (markEpoch not copied on clean records) -> roundtrip node#3 markEpoch a=3 b=0', async () => {
        const ev = restoreEvent(await loadMutant('M-OS-roundtrip'));
        assert.deepEqual(ev.roundtrip, os('roundtrip', 3, 'node#3 markEpoch a=3 b=0'));
        assert.equal(ev.refireFail, null);
    });
    it('M-OS-refire (restore runs each effect body) -> refire 2 (effects e and o)', async () => {
        const ev = restoreEvent(await loadMutant('M-OS-refire'));
        assert.equal(ev.refire, 2);
        assert.deepEqual(ev.refireFail, { oracle: 'OS', sig: 'refire', detail: 'H: 2 body run(s) during restore (want 0)' });
        assert.equal(ev.roundtrip, null, 'the refire mutant moves no snapshot field');
    });
    it('M-OS-clean (evalVersion 0 on clean records) -> clean-bit on node#3 and node#6, roundtrip evalVersion', async () => {
        const ev = restoreEvent(await loadMutant('M-OS-clean'));
        assert.deepEqual(ev.clean, [
            { oracle: 'OS', sig: 'clean-bit', detail: 'H: clean node#3 ran 1 body run(s) on its first read (want 0)' },
            { oracle: 'OS', sig: 'clean-bit', detail: 'H: clean node#6 ran 1 body run(s) on its first read (want 0)' },
            null, null,
        ]);
        assert.deepEqual(ev.roundtrip, os('roundtrip', 3, 'node#3 clean a=true b=false'));
    });
});

// ---- GC (ASSERTION 3): a child under --expose-gc; 1e6 pass-path calls each, plus a fresh-{} control -----------------
const GC_CHILD = `
import * as O from ${JSON.stringify(ORACLES_URL.href)};
import { GcProfiler } from ${JSON.stringify(import.meta.resolve('@zakkster/lite-gc-profiler'))};
if (typeof globalThis.gc !== 'function') { console.log(JSON.stringify({ error: 'no gc' })); process.exit(3); }
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const base = { kind: 'computed', flags: 1, value: 5, version: 2, ownerId: null, ownerPos: -1, deps: [1], subPos: [0], markEpoch: 2 };
const CLEAN = Object.freeze({ ...base, id: 3, clean: true, evalVersion: 2 });
const NEVER = Object.freeze({ ...base, id: 8, clean: false, evalVersion: 0, markEpoch: 0 });
const DIRTY = Object.freeze({ ...base, id: 7, clean: false, evalVersion: 2, markEpoch: 3 });
const RECS = [CLEAN, NEVER, DIRTY];
let sink = 0, i = 0, lastBox = null;
const steps = {
    refire: () => { i = (i + 1) | 0; sink = (sink + (O.checkOsRefire('L', 0) === null ? 1 : 2)) | 0; },
    cleanBit: () => {
        i = (i + 1) | 0;
        const k = i % 3;
        const runs = k === 0 ? 0 : k === 1 ? 1 + (i & 3) : (i & 1);
        sink = (sink + (O.checkOsCleanBit('L', RECS[k], runs) === null ? 1 : 2)) | 0;
    },
    cleanClass: () => { i = (i + 1) | 0; sink = (sink + O.osCleanClass(RECS[i % 3]).length) | 0; },
    control: () => { i = (i + 1) | 0; lastBox = { v: i }; sink = (sink + (O.checkOsRefire('L', 0) === null ? lastBox.v & 1 : 2)) | 0; },
};
async function window(step, iters) {
    for (let k = 0; k < 300000; k++) step();
    globalThis.gc(); await sleep(20);
    for (let k = 0; k < 100000; k++) step();
    globalThis.gc(); await sleep(50);
    const gcp = new GcProfiler().start();
    const h0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < iters; k++) step();
    await sleep(50);
    const sum = gcp.summary(); gcp.stop();
    globalThis.gc();
    return { minor: sum.gc.minor, major: sum.gc.major, grewBpo: (process.memoryUsage().heapUsed - h0) / iters };
}
const out = {};
for (const name of ['refire', 'cleanBit', 'cleanClass', 'control']) out[name] = await window(steps[name], 1000000);
out.sink = sink;
console.log(JSON.stringify(out));
`;
describe('GC: pass paths allocate nothing (ASSERTION 3)', () => {
    let res = null, err = null;
    const run = () => {
        if (res !== null || err !== null) return;
        const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', GC_CHILD], { cwd: ROOT, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
        if (r.status !== 0) { err = new Error('gc child exit ' + r.status + ' signal ' + r.signal + ': ' + r.stderr); return; }
        res = JSON.parse(r.stdout.trim().split('\n').pop());
    };
    for (const name of ['refire', 'cleanBit', 'cleanClass']) {
        it(name + ': 1e6 calls, minor 0, major 0, retained growth < 0.5 B/op', () => {
            run();
            if (err !== null) throw err;
            const m = res[name];
            assert.equal(m.minor, 0, name + ' scavenged: transient per-call alloc ' + JSON.stringify(m));
            assert.equal(m.major, 0, name + ' major ' + JSON.stringify(m));
            assert.ok(m.grewBpo < 0.5, name + ' B/op ' + m.grewBpo);
        });
    }
    it('CONTROL (a fresh {} per call into a sink, same harness): minor >= 1, transient (growth < 0.5 B/op)', () => {
        run();
        if (err !== null) throw err;
        const m = res.control;
        assert.ok(m.minor >= 1, 'control must scavenge: ' + JSON.stringify(m));
        assert.ok(m.grewBpo < 0.5, 'control must be transient, not retained: ' + m.grewBpo);
    });
});
