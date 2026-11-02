/**
 * test/96 -- R7 group A: the lite-box adapter, the trace sink / tracer, the OT trace comparator (burst 144, R7-A1).
 *
 * Written from the plan (.handoff/PLAN-R7-box.md: CURRENT C-1, C-13..C-16, C-20, C-22; GROUP A INTERFACES;
 * ASSERTIONS A-1..A-5) and the census evidence (.handoff/r7-evidence/README.txt), not from the implementation.
 * The modules (adapters/lite-box.mjs, trace.mjs) are loaded dynamically so every row fails on its own until they land.
 *
 * Expected values: the C / E / X line examples are the scratch tracer's format (plan: "byte for byte"), derived by hand
 * from the format `C <m> <#ord|-|?kind> <args> = <res>`; the per-world line counts for worlds 0 and 1 of each lane are
 * the scratch tracer's counts on plain lite-s3 (an independent reference, census seeds: BASE 0xb1440012, cycleSeed =
 * seedFor(BASE, lane.index, 0), world w = worldSeed(cycleSeed, w)); the control diff index 120 is census README
 * "line 121, 1-based" (A-2).
 *
 * ASSUMPTIONS about names the plan leaves open (a rename in the coder's code is a one-line fix here):
 *   - makeTraceSink(opts) takes { keep: 'all' | [lo, hi] | undefined }; the sink exposes its line count as sink.n.
 *   - the box counters are read as world.boxCounts() -> { box, callable, crossRead } (C-16: the coder names it).
 *   - the sink byte size is the sum of byteLength over the typed arrays it owns (names not assumed).
 *   - adapter.mode is the echoed mode string.
 *   - A2's rows (checkTrace, W* teeth) are { todo: 'R7-A2' }; A2 removes the todo when exec / oracles land.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { K } from '../bench/soak/kernel.mjs';
import { liteS3Adapter } from '../bench/soak/adapters/lite-s3.mjs';
import { CAPS_LITE } from '../bench/soak/adapters/lite.mjs';
import { validateAdapter, validateWorld } from '../bench/soak/adapters/contract.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import * as ORC from '../bench/soak/oracles.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import { seedFor, worldSeed } from '../bench/soak/seeds.mjs';
import { laneByName, isLargeWorld } from '../bench/soak/lanes/index.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
let LB = null, LB_ERR = null, TR = null, TR_ERR = null;
try { LB = await import('../bench/soak/adapters/lite-box.mjs'); } catch (e) { LB_ERR = e; }
try { TR = await import('../bench/soak/trace.mjs'); } catch (e) { TR_ERR = e; }
const lb = () => {
    if (LB === null) assert.fail('adapters/lite-box.mjs does not load yet: ' + String(LB_ERR));
    return LB;
};
const tr = () => {
    if (TR === null) assert.fail('trace.mjs does not load yet: ' + String(TR_ERR));
    return TR;
};

const BASE = 0xB1440012 >>> 0;
const OPEN = { maxFlushPasses: 8 };
const isBox = (h) => typeof h !== 'function';

/** Run one script on `ad` over a keep-all trace; returns { sink, res, lines[] }. */
function traced(ad, script, keep) {
    const sink = tr().makeTraceSink({ keep: keep === undefined ? 'all' : keep });
    const res = runWorld(tr().traceAdapter(ad, sink), script);
    const lines = [];
    for (let i = 0; i < sink.n; i++) lines.push(tr().traceLine(sink, i));
    return { sink, res, lines };
}
const verdictOf = (r) => JSON.stringify({ failure: r.failure, checks: r.checks, skipTainted: r.skipTainted,
    scen: r.scen, gateHits: r.gateHits, ops: r.ops, opsByClass: r.opsByClass });
function scriptFor(laneName, w, cycle) {
    const desc = laneByName(laneName);
    const ws = worldSeed(seedFor(BASE, desc.index, cycle === undefined ? 0 : cycle), w);
    return { ws, script: generateWorld(desc, ws, { large: isLargeWorld(desc, w), covOff: null }) };
}

/* ---- 1. adapter contract -------------------------------------------------------------------------- */

test('lite-box adapter: frozen, name lite-box, mode echoed, lite-s3 identity, caps = CAPS_LITE + box:true', () => {
    for (const mode of ['all', 'alt']) {
        const ad = lb().liteBoxAdapterFor(K, mode);
        assert.ok(Object.isFrozen(ad), mode);
        assert.equal(ad.name, 'lite-box');
        assert.equal(ad.mode, mode);
        assert.equal(ad.version, liteS3Adapter.version);
        assert.equal(ad.files, liteS3Adapter.files);
        assert.equal(ad.knownAs, liteS3Adapter.knownAs);
        assert.deepEqual(ad.caps, { ...CAPS_LITE, box: true });
        assert.equal(typeof ad.open, 'function');
    }
    assert.deepEqual(lb().CAPS_LITE_BOX, { ...CAPS_LITE, box: true });
    assert.equal(lb().liteBoxAdapter.mode, 'all');
    assert.equal(lb().liteBoxAltAdapter.mode, 'alt');
    for (const a of [lb().liteBoxAdapter, lb().liteBoxAltAdapter]) {
        assert.ok(Object.isFrozen(a));
        assert.equal(a.name, 'lite-box');
    }
    const broken = lb().liteBoxAdapterFor(K, 'all', { broken: 'box-untracked' });
    assert.ok(Object.isFrozen(broken));
    assert.equal(broken.name, 'lite-box');
});

test('lite-box adapter: bad mode / bad opts -> TypeError (C-13: only box-untracked)', () => {
    const f = lb().liteBoxAdapterFor;
    for (const m of [undefined, null, 'ALL', 'none', '', 1, {}]) assert.throws(() => f(K, m), TypeError, String(m));
    assert.throws(() => f(K, 'all', { broken: 'x' }), TypeError);
    assert.throws(() => f(K, 'alt', { broken: 'get-peek' }), TypeError, 'the void scratch name');
    assert.throws(() => f(K, 'all', 'box-untracked'), TypeError);
    assert.throws(() => f(K, 'all', 42), TypeError);
    assert.throws(() => f({}, 'all'), TypeError, 'a kernel without createRegistry (lite-s3 door)');
});

test('lite-box adapter: passes the adapter / world contract (adapters/contract.mjs) like lite-s3', () => {
    assert.deepEqual(validateAdapter(liteS3Adapter), []);
    for (const mode of ['all', 'alt']) {
        const ad = lb().liteBoxAdapterFor(K, mode);
        assert.deepEqual(validateAdapter(ad), [], mode);
        const w = ad.open(OPEN);
        const need = ['hook', 'destroy', 'owner', 'capacity', 'scheduler', 'recycle'];
        assert.deepEqual(validateWorld(w, ad.caps, need), [], mode);
        w.close();
    }
});

/* ---- 2. box creation policy ----------------------------------------------------------------------- */

test("'all' mode: every signal and computed handle is a box (typeof !== 'function'); counters agree", () => {
    const w = lb().liteBoxAdapterFor(K, 'all').open(OPEN);
    const hs = [];
    for (let i = 0; i < 4; i++) hs.push(w.signal(i));
    const sig = hs[0];
    for (let i = 0; i < 3; i++) hs.push(w.computed(() => w.read(sig) + i));
    for (const h of hs) assert.ok(isBox(h), 'box');
    assert.equal(w.read(hs[4]), 0);
    w.set(sig, 5);
    assert.equal(w.read(hs[5]), 6);
    assert.equal(w.peek(hs[6]), 7);
    // ASSUMPTION: boxCounts() accessor (C-16)
    const c = w.boxCounts();
    assert.deepEqual(c, { box: 7, callable: 0, crossRead: 0 });
    w.close();
});

test("'alt' mode: box iff the 0-based signal+computed creation ordinal is odd; effects take no ordinal", () => {
    const w = lb().liteBoxAdapterFor(K, 'alt').open(OPEN);
    const kinds = [];
    const note = (h) => { kinds.push(isBox(h) ? 'box' : 'fn'); return h; };
    const s0 = note(w.signal(1));              // ordinal 0 -> callable
    const c1 = note(w.computed(() => w.read(s0) + 1));   // ordinal 1 -> box
    const e = w.effect(() => { w.read(s0); }); // no ordinal
    assert.equal(typeof e, 'function', 'effect handle is the lite-s3 effect handle, not counted');
    const s2 = note(w.signal(10));             // ordinal 2 -> callable (an effect in between did not shift it)
    const c3 = note(w.computed(() => w.read(s2) + w.read(c1))); // ordinal 3 -> box
    const s4 = note(w.signal(0));              // ordinal 4 -> callable
    const s5 = note(w.signal(0));              // ordinal 5 -> box
    assert.deepEqual(kinds, ['fn', 'box', 'fn', 'box', 'fn', 'box']);
    assert.equal(w.read(c3), 12);              // c3 = 10 + (1 + 1): box reads callable and box
    w.set(s4, 1); w.set(s5, 2);
    assert.equal(w.read(s4), 1);
    assert.equal(w.read(s5), 2);
    // ASSUMPTION: boxCounts() accessor (C-16); a computed box reading a callable signal is a cross-kind read
    const c = w.boxCounts();
    assert.deepEqual(c, { box: 3, callable: 3, crossRead: 2 });
    w.close();
});

test("lite-box close() disposes the boxes: the lite-s3 residue is {nodes 0, links 0} in both modes", () => {
    for (const mode of ['all', 'alt']) {
        const w = lb().liteBoxAdapterFor(K, mode).open(OPEN);
        const s = w.signal(1);
        const c = w.computed(() => w.read(s));
        w.effect(() => { w.read(c); });
        const r = w.close();
        assert.equal(r.nodes, 0, mode);
        assert.equal(r.links, 0, mode);
    }
});

/* ---- 3. trace sink + tracer ----------------------------------------------------------------------- */

const EXPECT_LINES = [
    'C signal - n:5 u = #0',
    'C set #0 n:7 = u',
    'C read #0  = n:7',
    'C computed -  = #1',
    'C read #1  = n:8',
    'E c0 d0',
    'C read #0  = n:7',
    'X c0 = n:8',
    'C effect -  = #2',
    'E e1 d0',
    'C read #0  = n:7',
    'X e1 = u',
    'C computed -  = #3',
];

function driveSmall(ad, sink) {
    const w = tr().traceAdapter(ad, sink).open(OPEN);
    const s = w.signal(5);
    w.set(s, 7);
    w.read(s);
    const c = w.computed(() => w.read(s) + 1);
    w.read(c);
    w.effect(() => { w.read(s); });
    const bad = w.computed(() => { throw new Error('boom'); });
    return { w, bad };
}

test('trace: C / E / X line format (hand-derived from the scratch tracer), keep all', () => {
    const sink = tr().makeTraceSink({ keep: 'all' });
    const { w, bad } = driveSmall(lb().liteBoxAdapterFor(K, 'all'), sink);
    assert.equal(sink.n, EXPECT_LINES.length);
    for (let i = 0; i < EXPECT_LINES.length; i++) assert.equal(tr().traceLine(sink, i), EXPECT_LINES[i], 'line ' + i);
    assert.throws(() => w.read(bad));
    // escape forms: the C line ends '! <json>', the body's X line ends '! <json>'
    assert.match(tr().traceLine(sink, 13), /^C read #3 {2}! \[/);
    assert.equal(tr().traceLine(sink, 14), 'E c2 d0');
    assert.match(tr().traceLine(sink, 15), /^X c2 ! \[/);
    assert.equal(sink.n, 16);
    assert.equal(tr().traceLine(sink, 16), null, 'past the end');
    assert.equal(tr().traceLine(sink, -1), null);
});

test('trace: lite-box and lite-s3 give the same lines for a mixed script (all and alt)', () => {
    const ref = tr().makeTraceSink({ keep: 'all' });
    driveSmall(liteS3Adapter, ref);
    for (const mode of ['all', 'alt']) {
        const sink = tr().makeTraceSink({ keep: 'all' });
        driveSmall(lb().liteBoxAdapterFor(K, mode), sink);
        assert.equal(sink.n, ref.n, mode);
        for (let i = 0; i < ref.n; i++) {
            assert.equal(tr().traceLine(sink, i), tr().traceLine(ref, i), mode + ' line ' + i);
        }
    }
});

test('trace: traceLine is null when a line is not kept; default sink keeps nothing but counts', () => {
    const sink = tr().makeTraceSink();
    driveSmall(lb().liteBoxAdapterFor(K, 'all'), sink);
    assert.equal(sink.n, EXPECT_LINES.length);
    for (let i = 0; i < sink.n; i++) assert.equal(tr().traceLine(sink, i), null, 'line ' + i);
});

test('trace: keep [lo, hi) keeps exactly that window', () => {
    const sink = tr().makeTraceSink({ keep: [3, 7] });
    driveSmall(lb().liteBoxAdapterFor(K, 'all'), sink);
    for (let i = 0; i < EXPECT_LINES.length; i++) {
        const want = i >= 3 && i < 7 ? EXPECT_LINES[i] : null;
        assert.equal(tr().traceLine(sink, i), want, 'line ' + i);
    }
});

test('trace: appendTraceLine adds one line (n + 1) at the next index, kept or hashed per the window', () => {
    const all = tr().makeTraceSink({ keep: 'all' });
    driveSmall(lb().liteBoxAdapterFor(K, 'all'), all);
    const n0 = all.n;
    tr().appendTraceLine(all, 'V {"failure":null}');
    assert.equal(all.n, n0 + 1);
    assert.equal(tr().traceLine(all, n0), 'V {"failure":null}');
    const none = tr().makeTraceSink();
    tr().appendTraceLine(none, 'V x');
    assert.equal(none.n, 1);
    assert.equal(tr().traceLine(none, 0), null);
    const win = tr().makeTraceSink({ keep: [0, 1] });
    tr().appendTraceLine(win, 'a'); tr().appendTraceLine(win, 'b');
    assert.equal(win.n, 2);
    assert.equal(tr().traceLine(win, 0), 'a');
    assert.equal(tr().traceLine(win, 1), null);
});

test('trace: hook listener payloads are not traced (only the hook call line); name / caps forwarded', () => {
    const ad = lb().liteBoxAdapterFor(K, 'all');
    const sink = tr().makeTraceSink({ keep: 'all' });
    const tad = tr().traceAdapter(ad, sink);
    assert.equal(tad.name, 'lite-box');
    assert.equal(tad.knownAs, ad.knownAs);
    assert.equal(tad.caps, ad.caps);
    assert.equal(tad.version, ad.version);
    assert.equal(tad.files, ad.files);
    const w = tad.open(OPEN);
    const s = w.signal(1);
    let fired = 0;
    w.hook(() => { fired++; });
    w.signal(2);   // a node creation fires onGraphMutation; a plain value set does not
    assert.ok(fired > 0, 'the hook listener ran');
    assert.equal(sink.n, 3, 'signal, hook, signal -- nothing from the listener payloads');
    assert.match(tr().traceLine(sink, 1), /^C hook /);
});

/* ---- 4. A-2: census replay (2 worlds per lane) ---------------------------------------------------- */

// [lane, world 0 seed, world 0 lines, world 1 seed, world 1 lines, failing] on plain lite-s3 (see header).
const REPLAY = [
    ['GRAPH', 0x9bddefbd, 20393, 0x27ff23be, 11766, 0],
    ['BATCH', 0x7a95f1a3, 24491, 0x3c2c64ca, 27457, 0],
    ['ERROR', 0x53491534, 827, 0xed80354d, 7799, 2],      // DIV-F22 under lite-s3 too (README: 17/20 fail on all three)
    ['NEST', 0x8e62601c, 10095, 0xa4371d05, 10517, 0],
    ['WIE', 0x7f161d31, 53803, 0x7872ec5e, 38162, 0],
];

for (const [lane, s0, n0, s1, n1, failing] of REPLAY) {
    // ERROR: HEAD exec throws 'unmodelled cycle set' for an adapter named lite-box (C-20) until A2's isLiteFamily
    const opt = lane === 'ERROR' ? { todo: 'R7-A2' } : {};
    test('A-2 replay ' + lane + ': lite-s3 vs lite-box all / alt -> identical lines and verdict', opt, () => {
        const want = [[s0, n0], [s1, n1]];
        let fails = 0;
        for (let w = 0; w < 2; w++) {
            const { ws, script } = scriptFor(lane, w);
            assert.equal(ws, want[w][0], 'census seed, world ' + w);
            const a = traced(liteS3Adapter, script);
            assert.equal(a.sink.n, want[w][1], 'reference line count, world ' + w);
            if (a.res.failure !== null) fails++;
            for (const mode of ['all', 'alt']) {
                const b = traced(lb().liteBoxAdapterFor(K, mode), script);
                assert.equal(b.sink.n, a.sink.n, mode + ' line count, world ' + w);
                let at = -1;
                for (let i = 0; i < a.lines.length; i++) if (a.lines[i] !== b.lines[i]) { at = i; break; }
                assert.equal(at, -1, mode + ' first differing line, world ' + w + (at === -1 ? '' :
                    ': ' + a.lines[at] + ' | ' + b.lines[at]));
                assert.equal(verdictOf(b.res), verdictOf(a.res), mode + ' verdict, world ' + w);
            }
        }
        assert.equal(fails, failing, 'failing worlds on lite-s3 of the 2');
    });
}

test('A-2 must-fail: box-untracked on GRAPH diffs from lite-s3 (world 0 at line 121), fails the oracles', () => {
    const broken = lb().liteBoxAdapterFor(K, 'all', { broken: 'box-untracked' });
    let diffs = 0;
    let first = null;
    for (let w = 0; w < 2; w++) {
        const { script } = scriptFor('GRAPH', w);
        const a = traced(liteS3Adapter, script);
        const b = traced(broken, script);
        let at = -1;
        const n = Math.max(a.lines.length, b.lines.length);
        for (let i = 0; i < n; i++) if (a.lines[i] !== b.lines[i]) { at = i; break; }
        if (at !== -1 || verdictOf(a.res) !== verdictOf(b.res)) diffs++;
        if (w === 0) { first = at; assert.notEqual(b.res.failure, null, 'world 0 fails the oracles'); }
    }
    assert.ok(diffs >= 1, 'at least one diff');
    assert.equal(first, 121, 'census-20.json traceAt: first diff of world 0x9bddefbd, stats() activeLinks 4 vs 0');
});

/* ---- 5. A-4: retention (child, --expose-gc) ------------------------------------------------------- */

const RETENTION_SRC = `
import { createLeakTracker } from '@zakkster/lite-leak';
import { K } from './bench/soak/kernel.mjs';
import { runWorld } from './bench/soak/exec.mjs';
import { generateWorld } from './bench/soak/gen.mjs';
import { seedFor, worldSeed } from './bench/soak/seeds.mjs';
import { laneByName } from './bench/soak/lanes/index.mjs';
import { liteBoxAdapterFor } from './bench/soak/adapters/lite-box.mjs';
const tr = createLeakTracker({ name: 't96' });
const settle = async () => {
    for (let t = 0; t < 40 && tr.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 20)); }
    return tr.size();
};
const tap = (ad) => ({ ...ad, open(o) { const w = ad.open(o); tr.track(w.registry, null, 'r'); return w; } });
const desc = laneByName('GRAPH');
const sizes = [];
let worlds = 0, bad = 0;
gc();
await new Promise((r) => setTimeout(r, 20));
for (let cycle = 0; cycle < 3; cycle++) {
    for (const mode of ['all', 'alt']) {
        const ad = tap(liteBoxAdapterFor(K, mode));
        for (let w = 0; w < 4; w++) {
            const ws = worldSeed(seedFor(0xB1440012, desc.index, cycle), w);
            const r = runWorld(ad, generateWorld(desc, ws, { large: false, covOff: null }));
            worlds++;
            if (r.failure !== null) bad++;
        }
        sizes.push(await settle());
    }
}
// skip-close control: open, build a graph, keep the WORLD alive and never close it
const held = [];
const ad = tap(liteBoxAdapterFor(K, 'all'));
for (let i = 0; i < 4; i++) {
    const w = ad.open({ maxFlushPasses: 8 });
    const s = w.signal(i);
    w.computed(() => w.read(s));
    held.push(w);
}
const control = await settle();
console.log(JSON.stringify({ sizes, worlds, bad, control, held: held.length }));
`;

test('A-4 retention: 3 cycles x 4 worlds x (all, alt) -> tracker.size() 0 per cycle; skip-close control > 0', () => {
    lb();
    const args = ['--expose-gc', '--max-old-space-size=256', '--input-type=module', '-e', RETENTION_SRC];
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const tail = String(r.stderr || '').split('\n').slice(-12).join('\n');
    assert.ok(r.status === 0 && r.signal === null, 'child exit ' + r.status + ' sig ' + r.signal + '\n' + tail);
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(o.worlds, 24);
    assert.equal(o.bad, 0, 'every world teardown / oracle clean (failure null)');
    assert.deepEqual(o.sizes, [0, 0, 0, 0, 0, 0], 'tracker.size() after each (cycle, mode) close');
    assert.equal(o.held, 4);
    assert.ok(o.control > 0, 'control: unclosed held worlds stay tracked, got ' + o.control);
});

/* ---- 6. A-5: hash-only sink, parity --------------------------------------------------------------- */

function sinkBytes(sink) {
    let b = 0;
    for (const k of Object.keys(sink)) {
        const v = sink[k];
        if (ArrayBuffer.isView(v)) b += v.byteLength;
    }
    return b;
}

test('A-5 hash-only sink: byteLength <= 16 B/line + 4096 and 0 kept strings over one world', () => {
    const { script } = scriptFor('GRAPH', 0);
    const sink = tr().makeTraceSink();
    const res = runWorld(tr().traceAdapter(lb().liteBoxAdapterFor(K, 'all'), sink), script);
    assert.equal(res.failure, null);
    assert.equal(sink.n, 20393, 'reference line count of GRAPH world 0 (A-2 table)');
    const bytes = sinkBytes(sink);
    assert.ok(bytes > 0, 'the sink owns typed-array columns');
    assert.ok(bytes <= 16 * sink.n + 4096, bytes + ' B for ' + sink.n + ' lines');
    let kept = 0;
    for (let i = 0; i < sink.n; i++) if (tr().traceLine(sink, i) !== null) kept++;
    assert.equal(kept, 0, 'kept strings');
    for (const k of Object.keys(sink)) {
        assert.ok(!Array.isArray(sink[k]) || sink[k].length === 0, 'no string array: ' + k);
    }
});

test('X6 parity via parity.json: Signal.js, adapters/lite.mjs, adapters/lite-s3.mjs full sha256', () => {
    const PIN = JSON.parse(readFileSync(join(ROOT, 'bench/soak/parity.json'), 'utf8')).files;
    for (const f of ['Signal.js', 'bench/soak/adapters/lite.mjs', 'bench/soak/adapters/lite-s3.mjs']) {
        assert.equal(createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex'), PIN[f], f);
    }
});

/* ---- 7. batch A2 rows (todo until exec / oracles land) -------------------------------------------- */

const LIT = (n) => {
    const s = tr().makeTraceSink({ keep: 'all' });
    for (let i = 0; i < n; i++) tr().appendTraceLine(s, 'L' + i);
    return s;
};

test('A-1 checkTrace: equal 5/5 -> null; differ at 3 -> at 3; lengths 5 vs 4 -> at 4; hash-only same verdicts',
    { todo: 'R7-A2' }, () => {
        assert.equal(ORC.checkTrace(LIT(5), LIT(5)), null);
        const d = LIT(5);
        const e = tr().makeTraceSink({ keep: 'all' });
        for (let i = 0; i < 5; i++) tr().appendTraceLine(e, i === 3 ? 'DIFF' : 'L' + i);
        const f = ORC.checkTrace(d, e);
        assert.equal(f.oracle, 'OT');
        assert.equal(f.sig, 'trace-diff');
        assert.equal(f.at, 3);
        assert.equal(typeof f.detail, 'string');
        const g = ORC.checkTrace(LIT(5), LIT(4));
        assert.equal(g.at, 4);
        assert.equal(g.sig, 'trace-diff');
        // hash-only sinks give the same verdicts
        const h = (n, bad) => {
            const s = tr().makeTraceSink();
            for (let i = 0; i < n; i++) tr().appendTraceLine(s, i === bad ? 'DIFF' : 'L' + i);
            return s;
        };
        assert.equal(ORC.checkTrace(h(5, -1), h(5, -1)), null);
        assert.equal(ORC.checkTrace(h(5, -1), h(5, 3)).at, 3);
        assert.equal(ORC.checkTrace(h(5, -1), h(4, -1)).at, 4);
        assert.throws(() => ORC.checkTrace([], []), TypeError, 'non-sink');
    });

test('A-3 teeth: W* (ERROR world 3, seed 0x5075c290) under lite-box -> failure null; verdict equals lite',
    { todo: 'R7-A2' }, () => {
        const desc = laneByName('ERROR');
        const ws = worldSeed(seedFor(BASE, desc.index, 0), 3);
        assert.equal(ws, 0x5075c290, 'C-20 seed');
        const script = generateWorld(desc, ws, { large: isLargeWorld(desc, 3), covOff: null });
        const lite = runWorld(liteS3Adapter, script);
        for (const mode of ['all', 'alt']) {
            // HEAD exec THROWS 'unmodelled cycle set' here (C-20)
            const box = runWorld(lb().liteBoxAdapterFor(K, mode), script);
            assert.equal(box.failure, null, mode);
            assert.equal(verdictOf(box), verdictOf(lite), mode + ' verdict equals lite');
        }
    });

/* ---- 8. review r1 additions (X1-X5) --------------------------------------------------------------- */

test('X1 firstTraceDiff on hash-only sinks: one-char diffs (first / middle / last) at the same length', () => {
    const TR = tr();
    const base = ['C read #0  = n:7', 'C set #1 n:2 = u', 'X c3 = n:8'];
    for (let li = 0; li < base.length; li++) {
        for (const pos of [0, base[li].length >> 1, base[li].length - 1]) {
            const alt = base[li].slice(0, pos) + (base[li][pos] === 'Z' ? 'Y' : 'Z') + base[li].slice(pos + 1);
            const a = TR.makeTraceSink(), b = TR.makeTraceSink();
            for (let i = 0; i < base.length; i++) {
                TR.appendTraceLine(a, base[i]);
                TR.appendTraceLine(b, i === li ? alt : base[i]);
            }
            assert.equal(TR.firstTraceDiff(a, b), li, li + '/' + pos);
            assert.notEqual(a.h1[li], b.h1[li], 'h1 ' + li + '/' + pos);
            assert.notEqual(a.h2[li], b.h2[li], 'h2 ' + li + '/' + pos);
        }
    }
    const e1 = TR.makeTraceSink(), e2 = TR.makeTraceSink(), e3 = TR.makeTraceSink();
    for (const l of base) { TR.appendTraceLine(e1, l); TR.appendTraceLine(e2, l); }
    TR.appendTraceLine(e3, base[0]); TR.appendTraceLine(e3, base[1]);
    assert.equal(TR.firstTraceDiff(e1, e2), -1);
    assert.equal(TR.firstTraceDiff(e1, e3), 2);
    assert.equal(TR.firstTraceDiff(e3, e1), 2);
    const p = TR.makeTraceSink(), q = TR.makeTraceSink();
    TR.appendTraceLine(p, 'a'); TR.appendTraceLine(q, 'a');
    q.h2[0] ^= 1; assert.equal(TR.firstTraceDiff(p, q), 0, 'h2 alone');
    q.h2[0] ^= 1; q.h1[0] ^= 1; assert.equal(TR.firstTraceDiff(p, q), 0, 'h1 alone');
});

test('X2 box-untracked control on hash-only sinks: firstTraceDiff 121 (GRAPH world 0); alt -> -1', () => {
    const TR = tr();
    const { script } = scriptFor('GRAPH', 0);
    const a = TR.makeTraceSink(), b = TR.makeTraceSink(), c = TR.makeTraceSink();
    runWorld(TR.traceAdapter(liteS3Adapter, a), script);
    runWorld(TR.traceAdapter(lb().liteBoxAdapterFor(K, 'all', { broken: 'box-untracked' }), b), script);
    runWorld(TR.traceAdapter(lb().liteBoxAdapterFor(K, 'alt'), c), script);
    assert.equal(TR.firstTraceDiff(a, b), 121);
    assert.equal(TR.firstTraceDiff(a, c), -1);
});

test('X3 setTraceStep stamps the step column of every later line (append and traced call)', () => {
    const TR = tr();
    const s = TR.makeTraceSink();
    TR.setTraceStep(s, 7); TR.appendTraceLine(s, 'x');
    const w = TR.traceAdapter(lb().liteBoxAdapterFor(K, 'all'), s).open(OPEN);
    TR.setTraceStep(s, -3); w.signal(1);
    assert.deepEqual([s.n, s.step[0], s.step[1]], [2, 7, -3]);
});

test('X4 boxCounts exact: alt, s0 callable, c1 box, an effect reading only c1', () => {
    const w = lb().liteBoxAdapterFor(K, 'alt').open(OPEN);
    const s0 = w.signal(1); const c1 = w.computed(() => w.read(s0) + 1);
    w.effect(() => { w.read(c1); });
    assert.deepEqual(w.boxCounts(), { box: 1, callable: 1, crossRead: 2 });
    w.close();
});

test('X5 opts matrix: unknown key, {}, null, [], prototype-borne broken -> TypeError; did-you-mean', () => {
    for (const o of [{}, { broken: 'box-untracked', x: 1 }, null, [], Object.create({ broken: 'box-untracked' })]) {
        assert.throws(() => lb().liteBoxAdapterFor(K, 'all', o), TypeError, JSON.stringify(o));
    }
    assert.throws(() => lb().liteBoxAdapterFor(K, 'all', { broken: 'box-untracked', x: 1 }), /did you mean broken/);
});
