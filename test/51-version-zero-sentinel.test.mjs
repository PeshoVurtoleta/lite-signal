// F29 -- globalVersion must skip 0 (the "unset" sentinel of evalVersion / markEpoch).
// Independent oracle: expected values come from SPEC-F29 / the b17 witness scenarios (audit/2026-10-07/verification/f29),
// never from running the engine. Kernels are derived at test time (bench/soak/nearwrap.mjs derive) into mkdtemp dirs.
// Crossing write: kernel starts globalVersion at -k; scenario does f filler bumps then the trigger bump, so the trigger
// lands on gv == 0 iff f == k-1. Each scenario also runs at f = k-2 and f = k (localisation).
// batchEpochRevert (batch() already skips 0 for batchEpoch) writes twice per batch, so it bumps globalVersion too: on a
// full zero:k kernel it is gv-caused WRONG for k>=2 without the F29 fix (witnessed on the tree and headpatched alike),
// so (a) needs it correct on the FIXED full kernel; (c)/(d) assert it WRONG for k>=2. A "rest" kernel (globalVersion left
// at 1, every other counter preset) is an extra control in (b).
// Row count: 8 scenarios x 5 k = 40, minus c-effectStamp0 at k=1 (needs f>=1 at f=k-1=0) = 39 = 34 F29 + 5 batchEpoch per mode; call + box modes -> 78 = 68 F29 + 10 batchEpoch per kernel.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { derive } = await import(pathToFileURL(path.join(ROOT, 'bench/soak/nearwrap.mjs')).href);
const KS = [1, 2, 3, 5, 8];
const SKIP = 'if (!globalVersion) globalVersion = 1;';

function occurrences(s, t) { let n = 0, i = s.indexOf(t); while (i !== -1) { n++; i = s.indexOf(t, i + t.length); } return n; }

function filler(R, f) { const d = R.signal(-1); for (let i = 0; i < f; i++) d.set(i); return d; }
const SCEN = {
    'i-effect': (R, f) => {
        const s = R.signal(0); const seen = [];
        R.effect(() => { seen.push(s.get()); });
        filler(R, f);
        s.set(1); const a = seen.join(',');
        s.set(2); const b = seen.join(',');
        return { expected: '0,1|0,1,2', observed: a + '|' + b };
    },
    'i-viaComputed': (R, f) => {
        const s = R.signal(0); const c = R.computed(() => s.get() * 10); const seen = [];
        R.effect(() => { seen.push(c.get()); });
        filler(R, f);
        s.set(1); const a = seen.join(',');
        s.set(2); const b = seen.join(',');
        return { expected: '0,10|0,10,20', observed: a + '|' + b };
    },
    'i-batchLast': (R, f) => {
        const s = R.signal(0); const seen = [];
        R.effect(() => { seen.push(s.get()); });
        filler(R, f);
        R.batch(() => { s.set(1); });
        return { expected: '0,1', observed: seen.join(',') };
    },
    'ii-lazyTop': (R, f) => {
        const s = R.signal(5); const c = R.computed(() => s.get() * 2);
        const d = filler(R, f); d.set(-2);
        const v1 = c.get();
        s.set(6); const v2 = c.get();
        return { expected: '10|12', observed: String(v1) + '|' + String(v2) };
    },
    'ii-lazyInEffect': (R, f) => {
        const s = R.signal(5); const c = R.computed(() => s.get() * 2);
        const d = filler(R, f); d.set(-2);
        const seen = [];
        R.effect(() => { seen.push(c.get()); });
        s.set(6); s.set(7);
        return { expected: '10,12,14', observed: seen.map(String).join(',') };
    },
    'c-effectStamp0': (R, f) => {
        if (f < 1) return null;
        const s = R.signal(1); const log = [];
        const c = R.computed(() => { log.push('c'); return s.get() > 0; });
        R.effect(() => { log.push('E'); c.get(); });
        s.set(1.5);
        filler(R, f - 1);
        s.set(3);
        const at = log.length;
        s.set(4);   // c stays true: only the computed may re-run, never the effect
        return { expected: 'c', observed: log.slice(at).join('') || '-' };
    },
    'c-computedStamp0': (R, f) => {
        const s = R.signal(1); let runs = 0;
        const c = R.computed(() => s.get() > 0);
        R.effect(() => { runs++; c.get(); });
        const d = filler(R, f); d.set(-2);
        c.get();
        s.set(4);
        return { expected: 'runs=1', observed: 'runs=' + runs };
    },
    'batchEpochRevert': (R, f) => {
        const s = R.signal(0); let runs = 0;
        R.effect(() => { runs++; s.get(); });
        for (let j = 0; j < f + 3; j++) R.batch(() => { s.set(99); s.set(0); });
        return { expected: 'runs=1', observed: 'runs=' + runs };
    },
};
// Every scenario runs twice: 'call' (callable signal / computed: read.set) and 'box' (signalBox / computedBox: boxSet),
// the box mode driving BOTH the filler writes and the trigger write through box.set. Row name suffix '[box]'.
const F29 = Object.keys(SCEN).filter((n) => n !== 'batchEpochRevert').flatMap((n) => [n, n + '[box]']);
const MODES = ['call', 'box'];

const tmps = [];
let TREE_SRC, WATCH_SRC, HP_SRC, HP_WATCH;
function mk(text, watch) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ls51-'));
    tmps.push(d);
    fs.writeFileSync(path.join(d, 'Signal.js'), text);
    fs.writeFileSync(path.join(d, 'Watch.js'), watch);
    fs.writeFileSync(path.join(d, 'package.json'), '{"type":"module"}\n');
    return import(pathToFileURL(path.join(d, 'Signal.js')).href);
}

function restOf(text, k) {
    const from = 'let globalVersion = ' + (-k) + ';';
    assert.equal(occurrences(text, from), 1, 'globalVersion initializer not rewritten exactly once');
    return text.replace(from, 'let globalVersion = 1;');
}
async function zeroRows(src, watch, k, tag) {
    const full = derive(src, { phase: 'zero', k }).text;
    return runK(await mk(full, watch), k, tag);
}

const retention = [];   // { tag, nodes, links, preNodes }
// Run all scenarios for one kernel module at one k. -> rows [{name, res:{f:{expected,observed}}, main, bad:[f], ok}]
// Tracked registry: records every signal / computed / effect the scenario creates (no createRoot is used by any
// scenario) so they can all be disposed and activeNodes / activeLinks read BEFORE destroy().
function track(R, mode) {
    const made = [];
    const box = mode === 'box';
    const T = {
        made,
        // call mode wraps the callable in {get,set}; box mode is the box itself
        signal: (v) => { const x = box ? R.signalBox(v) : R.signal(v); made.push(x); return box ? x : { get: x, set: x.set }; },
        computed: (fn) => { const x = box ? R.computedBox(fn) : R.computed(fn); made.push(x); return box ? x : { get: x }; },
        effect: (...a) => { const x = R.effect(...a); made.push(x); return x; },
        batch: (fn) => R.batch(fn),
    };
    return T;
}
function runK(K, k, tag, skipDispose) {
    const rows = [];
    for (const [name0, fn] of Object.entries(SCEN)) for (const mode of MODES) {
        const name = name0 + (mode === 'box' ? '[box]' : '');
        const res = {};
        for (const f of [k - 2, k - 1, k].filter((x) => x >= 0)) {
            const R = K.createRegistry();
            const TR = track(R, mode);
            let r;
            try { r = fn(TR, f); } catch (e) { r = { expected: '?', observed: 'THROW ' + (e && e.message) }; }
            const pre = R.stats().activeNodes;
            for (let i = TR.made.length - 1; i >= (skipDispose ? 1 : 0); i--) R.dispose(TR.made[i]);
            const st = R.stats();
            R.destroy();
            retention.push({ tag: tag + ':' + name + ':f' + f, nodes: st.activeNodes, links: st.activeLinks, pre: r === null ? -1 : pre });
            if (r !== null) res[f] = r;
        }
        const main = res[k - 1];
        if (main === undefined) continue;   // n/a: needs f>=1
        const bad = Object.keys(res).filter((f) => res[f].expected !== res[f].observed).map(Number);
        rows.push({ name, k, res, main, bad, ok: main.expected === main.observed });
    }
    return rows;
}
function deaf(K) {   // ii-lazyInEffect at k=3, f=2 (crossing on the unrelated write), then 1000 more writes
    const R = K.createRegistry();
    const s = R.signal(5); const c = R.computed(() => s() * 2);
    const d = R.signal(-1); d.set(0); d.set(1); d.set(-2);
    const seen = []; R.effect(() => { seen.push(c()); });
    s.set(6); s.set(7);
    for (let i = 0; i < 1000; i++) s.set(100 + i);
    const out = { len: seen.length, last: seen[seen.length - 1], head: seen.slice(0, 3).join(',') };
    R.destroy();
    return out;
}

let tree, hp, mutant, treeCtl, hpCtl;   // k -> rows
const T = { sites: {}, zero: {}, sign: {}, rest: {}, hpZero: {}, mutZero: {} };
let teethRows, treeDeaf, hpDeaf, treeCtlRows, mutatedOccurrences;

before(async () => {
    TREE_SRC = fs.readFileSync(path.join(ROOT, 'Signal.js'), 'utf8');
    WATCH_SRC = fs.readFileSync(path.join(ROOT, 'Watch.js'), 'utf8');
    HP_SRC = fs.readFileSync(path.join(ROOT, 'bench/soak/controls/headpatched/Signal.js'), 'utf8');
    HP_WATCH = fs.readFileSync(path.join(ROOT, 'bench/soak/controls/headpatched/Watch.js'), 'utf8');
    mutatedOccurrences = occurrences(TREE_SRC, SKIP);
    for (const k of KS) {
        T.zero[k] = (await zeroRows(TREE_SRC, WATCH_SRC, k, 'tree-zero-k' + k));
        if (k === 3) treeDeaf = deaf(await mk(derive(TREE_SRC, { phase: 'zero', k }).text, WATCH_SRC));
        const sgText = derive(TREE_SRC, { phase: 'sign', k }).text;
        T.sign[k] = runK(await mk(sgText, WATCH_SRC), k, 'tree-sign-k' + k);
        T.rest[k] = runK(await mk(restOf(derive(TREE_SRC, { phase: 'zero', k }).text, k), WATCH_SRC), k, 'tree-rest-k' + k);
        T.hpZero[k] = (await zeroRows(HP_SRC, HP_WATCH, k, 'hp-zero-k' + k));
        if (k === 3) hpDeaf = deaf(await mk(derive(HP_SRC, { phase: 'zero', k }).text, HP_WATCH));
        if (mutatedOccurrences === 2) {
            T.mutZero[k] = (await zeroRows(TREE_SRC.split(SKIP).join(''), WATCH_SRC, k, 'mut-zero-k' + k));
        }
    }
    if (mutatedOccurrences === 2) {
        // site-specific mutants: drop / move-above-the-bump exactly one of the two skips (1st = read.set, 2nd = boxSet)
        const at1 = TREE_SRC.indexOf(SKIP), at2 = TREE_SRC.indexOf(SKIP, at1 + 1);
        const del = (at) => TREE_SRC.slice(0, at) + TREE_SRC.slice(at + SKIP.length);
        const BUMP = 'globalVersion = (globalVersion + 1) | 0;';
        const mov = (at) => {   // put the skip on the line above the nearest preceding bump
            const b = TREE_SRC.lastIndexOf(BUMP, at);
            assert.ok(b !== -1 && at - b < 200, 'bump not found just above the skip');
            return TREE_SRC.slice(0, b) + SKIP + '\n' + TREE_SRC.slice(b, at) + TREE_SRC.slice(at + SKIP.length);
        };
        const defs = { delRead: del(at1), delBox: del(at2), movRead: mov(at1), movBox: mov(at2) };
        for (const k of KS) for (const [nm, text] of Object.entries(defs)) (T.sites[nm] ||= {})[k] = await zeroRows(text, WATCH_SRC, k, 'site-' + nm + '-k' + k);
    }
    const plain = await mk(TREE_SRC, WATCH_SRC);
    treeCtlRows = [];
    for (const k of KS) treeCtlRows.push(...runK(plain, k, 'tree-plain-k' + k));
    teethRows = runK(plain, 3, 'teeth', true);
});
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

const flat = (o) => KS.flatMap((k) => o[k] || []);
const describeWrong = (rows) => rows.filter((r) => !r.ok || r.bad.length).map((r) => r.name + '@k' + r.k + ' f=' + r.bad.join(',') + ' got ' + r.main.observed).join('; ');

describe('F29 globalVersion 0-sentinel', () => {
    test('(a) tree zero:k -- 78 rows (39 call + 39 box) all correct, deaf probe 1003 runs', () => {
        const rows = flat(T.zero);
        assert.equal(rows.length, 78);
        assert.equal(rows.filter((r) => r.name.startsWith('batchEpochRevert')).length, 10);
        assert.equal(rows.filter((r) => !r.name.startsWith('batchEpochRevert')).length, 68);   // 34 call + 34 box
        assert.equal(describeWrong(rows), '');
        assert.equal(treeDeaf.len, 1003);
        assert.equal(treeDeaf.head, '10,12,14');
        assert.equal(treeDeaf.last, 2 * 1099);   // last write s.set(100+999) -> 1099 * 2
    });

    test('(b) controls -- tree sign:k and the underived tree are correct', () => {
        const sg = flat(T.sign);
        assert.equal(sg.length, 78);
        assert.equal(describeWrong(sg), '');
        const rs = flat(T.rest);
        assert.equal(rs.length, 78);
        assert.equal(describeWrong(rs), '');   // rest kernel: other counters preset, gv at 1
        assert.equal(treeCtlRows.length, 78);   // all k at gv start 1: each row is just a plain-engine scenario run
        assert.equal(describeWrong(treeCtlRows), '');
    });

    test('(c) MUST-FAIL headpatched zero:k -- every F29 scenario WRONG for >= 1 k, batchEpochRevert WRONG for k>=2', () => {
        const rows = flat(T.hpZero);
        assert.equal(rows.length, 78);
        for (const n of F29) {
            const w = rows.filter((r) => r.name === n && !r.ok);
            assert.ok(w.length >= 1, n + ' never WRONG on headpatched (control lost its teeth)');
        }
        // batchEpochRevert is gv-caused: correct at k=1, WRONG at k>=2 (b17 witness)
        for (const r of rows.filter((r) => r.name.startsWith('batchEpochRevert'))) assert.equal(r.ok, r.k === 1, 'batchEpochRevert k=' + r.k);
        assert.notEqual(hpDeaf.len, 1003);   // the permanently deaf effect
    });

    test('(d) MUST-FAIL mutant -- tree source minus the 2 skips behaves like the headpatched control', () => {
        assert.equal(mutatedOccurrences, 2, 'expected the skip text exactly twice (read.set + boxSet)');
        const rows = flat(T.mutZero);
        assert.equal(rows.length, 78);
        for (const n of F29) {
            assert.ok(rows.some((r) => r.name === n && !r.ok), n + ' never WRONG on the mutant');
        }
        for (const r of rows.filter((r) => r.name.startsWith('batchEpochRevert'))) assert.equal(r.ok, r.k === 1, 'batchEpochRevert k=' + r.k);
        // same WRONG pattern as (c)
        const pat = (rs) => rs.filter((r) => !r.ok).map((r) => r.name + '@' + r.k).sort().join(',');
        assert.equal(pat(rows), pat(flat(T.hpZero)));
    });

    test('(d2) MUST-FAIL site mutants -- each skip alone is driven behaviourally (delete and move-above)', () => {
        assert.equal(mutatedOccurrences, 2);
        const isBox = (r) => r.name.endsWith('[box]');
        for (const nm of ['delRead', 'movRead', 'delBox', 'movBox']) {
            const rows = flat(T.sites[nm]);
            assert.equal(rows.length, 78, nm);
            const wrong = rows.filter((r) => !r.ok);
            const own = nm.endsWith('Read') ? wrong.filter((r) => !isBox(r)) : wrong.filter(isBox);
            const other = nm.endsWith('Read') ? wrong.filter(isBox) : wrong.filter((r) => !isBox(r));
            // each F29 scenario of the mutated site must be WRONG for >= 1 k; the other site's rows stay correct
            for (const n of F29.filter((n) => isBox({ name: n }) === !nm.endsWith('Read'))) {
                assert.ok(own.some((r) => r.name === n), nm + ': ' + n + ' never WRONG');
            }
            assert.deepEqual(other.map((r) => r.name + '@' + r.k), [], nm + ': other site must stay correct');
        }
    });

    test('(e) retention -- dispose everything, then activeNodes === 0 and activeLinks === 0 BEFORE destroy()', () => {
        // teeth: skipping the first dispose must leave nodes behind on every scenario that built a graph
        const built = retention.filter((r) => r.tag.startsWith('teeth')).filter((r) => r.pre > 0);
        assert.ok(built.length >= 7);
        assert.ok(built.every((r) => r.nodes > 0), 'skipped dispose not detected: ' + JSON.stringify(built.filter((r) => r.nodes === 0).slice(0, 3)));
        // control kernels first, then everything
        const ctl = retention.filter((r) => r.tag.startsWith('hp-zero') || r.tag.startsWith('tree-plain'));
        assert.ok(ctl.length >= 100);
        assert.ok(ctl.every((r) => r.nodes === 0 && r.links === 0), 'control kernel leaked');
        assert.ok(ctl.every((r) => r.pre > 0 || r.pre === -1), 'scenario built no graph');
        const real = retention.filter((r) => !r.tag.startsWith('teeth'));
        assert.deepEqual(real.filter((r) => r.nodes !== 0 || r.links !== 0), []);
        assert.ok(real.length >= 500, 'coverage floor, got ' + real.length);
    });
});
