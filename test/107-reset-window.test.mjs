/**
 * test/107-reset-window.test.mjs -- PLAN-F198 TASK 5 (CI class 14: the reset-torture window was blind on node 22 / 24).
 *
 * Expected values come from the PLAN (SPEC + ASSERTIONS A3), not from running the helper:
 *  - gate: nan===0 && tainted<=cap && clean>=cycles-cap && max<=0 && minor===0 && major===0, cap 4, cycles 200.
 *  - taint space = /code|trusted/; alloc = every other space; ok = new_space AND old_space present.
 *  - delta per window = sum over alloc spaces of (c-b)-(b-a); the reduction row drives it with scripted
 *    v8.getHeapSpaceStatistics, so every expected number is hand-computed in the scenario table.
 *  - plants (new / tenure / old): clean median >= 4096 B (256 nodes x >= 16 B) and the gate FAILS; the HEAD
 *    new_space-only read of the old plant (Symbol() is old-space by type) has max <= 0; the clean body PASSES.
 * The plant and HEAD-read rows fail on the pre-fix new_space-only window; the rest pin the new helper
 * (regression pins: the helper did not exist before this unit).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(ROOT, 'bench', 'torture', 'helpers', 'heap-window.mjs');
const SIGNAL = join(ROOT, 'Signal.js');
const TORTURE = join(ROOT, 'bench', 'torture', 'reset-torture.mjs');
const { spaceLayout, snapSpaces, windowGate, TAINT_CAP } = await import(pathToFileURL(HELPER).href);

const SPAWN = { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' };

function runChild(src, label) {
    const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', src], SPAWN);
    assert.equal(r.signal, null, `${label}: killed by ${r.signal} (stderr ${r.stderr})`);
    assert.equal(r.status, 0, `${label}: exit ${r.status} (stderr ${r.stderr})`);
    const lines = r.stdout.trim().split('\n');
    let j;
    try { j = JSON.parse(lines[lines.length - 1]); } catch (e) { assert.fail(`${label}: bad JSON: ${r.stdout}`); }
    return j;
}

/* -- synthetic windowGate matrix (cycles 200, cap 4) ------------------------------------------------------ */

const CYC = 200;
const good = (o) => Object.assign({ nan: 0, tainted: 0, clean: CYC, max: 0, minor: 0, major: 0 }, o);

test('TAINT_CAP is 4', () => { assert.equal(TAINT_CAP, 4); });

test('windowGate: 4 tainted PASS, 5 tainted FAIL (cycles 200, cap 4)', () => {
    assert.equal(windowGate(good({}), CYC, 4), true);
    assert.equal(windowGate(good({ tainted: 4, clean: 196 }), CYC, 4), true);
    assert.equal(windowGate(good({ tainted: 5, clean: 195 }), CYC, 4), false);
});

test('windowGate: NaN anywhere FAILs', () => {
    assert.equal(windowGate(good({ nan: 1, clean: 199 }), CYC, 4), false);
    assert.equal(windowGate(good({ nan: 1, tainted: 2, clean: 197 }), CYC, 4), false);
});

test('windowGate: a minor or major GC FAILs, also with tainted windows present', () => {
    assert.equal(windowGate(good({ minor: 1 }), CYC, 4), false);
    assert.equal(windowGate(good({ major: 1 }), CYC, 4), false);
    assert.equal(windowGate(good({ tainted: 1, clean: 199, minor: 1 }), CYC, 4), false);
    assert.equal(windowGate(good({ tainted: 1, clean: 199, major: 1 }), CYC, 4), false);
});

test('windowGate: a positive clean max (+16 B) FAILs, max <= 0 passes', () => {
    assert.equal(windowGate(good({ max: 16 }), CYC, 4), false);
    assert.equal(windowGate(good({ max: 0 }), CYC, 4), true);
    assert.equal(windowGate(good({ max: -8 }), CYC, 4), true);
});

test('windowGate: clean < cycles - cap FAILs; NaN max (no clean window) FAILs', () => {
    assert.equal(windowGate(good({ clean: 195 }), CYC, 4), false);
    assert.equal(windowGate(good({ clean: 196 }), CYC, 4), true);
    assert.equal(windowGate(good({ clean: 0, max: Number.NaN }), CYC, 4), false);
});

/* -- spaceLayout / snapSpaces on the real names ------------------------------------------------------------ */

test('spaceLayout on the real v8 space names', () => {
    const names = v8.getHeapSpaceStatistics().map((x) => x.space_name);
    const L = spaceLayout(names);
    assert.equal(L.ok, true);
    const nameAt = (i) => names[i];
    assert.ok(L.alloc.map(nameAt).includes('new_space'));
    assert.ok(L.alloc.map(nameAt).includes('old_space'));
    const wantTaint = [];
    names.forEach((n, i) => { if (/code|trusted/.test(n)) wantTaint.push(i); });
    assert.deepEqual([...L.taint].sort((a, b) => a - b), wantTaint);
    assert.ok(L.taint.length >= 1, 'at least code_space is a taint space');
    assert.equal(L.taint.length + L.alloc.length, names.length, 'every space is taint xor alloc');
    for (const i of L.taint) assert.ok(/code|trusted/.test(names[i]));
    for (const i of L.alloc) assert.ok(!/code|trusted/.test(names[i]));
});

test('spaceLayout: ok is false when new_space or old_space is missing', () => {
    assert.equal(spaceLayout(['old_space', 'code_space']).ok, false);
    assert.equal(spaceLayout(['new_space', 'code_space']).ok, false);
    assert.equal(spaceLayout([]).ok, false);
    assert.equal(spaceLayout(['new_space', 'old_space']).ok, true);
    assert.deepEqual([...spaceLayout(['new_space', 'old_space', 'trusted_space', 'code_space']).taint], [2, 3]);
});

test('snapSpaces: count on a right-sized array, -1 on a length mismatch', () => {
    const n = v8.getHeapSpaceStatistics().length;
    const out = new Float64Array(n);
    assert.equal(snapSpaces(out), n);
    assert.ok(out.some((x) => x > 0));
    assert.equal(snapSpaces(new Float64Array(n + 1)), -1);
    assert.equal(snapSpaces(new Float64Array(n - 1)), -1);
});

/* -- measureWindows reduction, scripted statistics (child: needs --expose-gc) ------------------------------ */

// Space order: [new_space, old_space, code_space, trusted_space]. Call #0 is the layout read, then 3 per
// iteration (a, b, c). Base per snapshot: new 1000, old 5000, code 300, trusted 40.
const REDUCTION_SRC = `
import v8 from 'node:v8';
const { measureWindows } = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
const realStats = v8.getHeapSpaceStatistics;
const NAMES = ['new_space', 'old_space', 'code_space', 'trusted_space'];
const mk = (vals, names) => (names || NAMES).map((n, i) => ({ space_name: n, space_used_size: vals[i] }));
const CYC = 6;
async function run(fn, names, body) {
    let call = 0;
    v8.getHeapSpaceStatistics = () => {
        const c = call++;
        if (c === 0) return mk([1000, 5000, 300, 40], names);
        const j = Math.floor((c - 1) / 3), s = (c - 1) % 3;
        return fn(j, s);
    };
    try {
        return await measureWindows(body || (() => {}), { warmup: 0, cycles: CYC });
    } finally { v8.getHeapSpaceStatistics = realStats; }
}
const base = [1000, 5000, 300, 40];
const out = {};
// empty bracket +8 new, body +8 new: delta (8)-(8) = 0 in every window
out.zero = await run((j, s) => mk([1000 + 8 * s, 5000, 300, 40]));
// new_space 1000 / 1008 / 1024: (1024-1008)-(1008-1000) = 8 in every window
out.body8 = await run((j, s) => mk([1000 + (s === 2 ? 24 : (s === 1 ? 8 : 0)), 5000, 300, 40]));
// old_space +16 in window 2's c snapshot only, no taint change: untainted, max 16, min 0
out.old16 = await run((j, s) => mk([1000, 5000 + (j === 2 && s === 2 ? 16 : 0), 300, 40]));
// trusted_space changes in the empty bracket (a->b) of window 1 only: tainted, excluded
out.trustedEmpty = await run((j, s) => mk([1000, 5000, 300, 40 + (j === 1 && s >= 1 ? 8 : 0)]));
// code_space +4096 and old_space +512 in the body bracket of window 3: tainted, excluded from max
out.codeBody = await run((j, s) => mk([
    1000, 5000 + (j === 3 && s === 2 ? 512 : 0), 300 + (j === 3 && s === 2 ? 4096 : 0), 40]));
// windows 3..5 tainted (+512 old, code +8): median over CLEAN windows 0..2 stays 0
out.medTaint = await run((j, s) => mk([
    1000, 5000 + (j >= 3 && s === 2 ? 512 : 0), 300 + (j >= 3 && s === 2 ? 8 : 0), 40]));
// a real scavenge inside window 2, which the script taints: the minor still counts
let bk = 0;
const scav = () => { if (bk++ === 2) { let x = null; for (let i = 0; i < 2e6; i++) x = { i }; } };
out.minorTainted = await run((j, s) => mk([1000, 5000, 300, 40 + (j === 2 && s === 2 ? 8 : 0)]), undefined, scav);
// one snapshot with a different space count in window 4 -> unverifiable
out.lenMismatch = await run((j, s) => (j === 4 && s === 1) ? mk([1000, 5000, 300]) : mk(base));
// a NaN value in window 5
out.nanValue = await run((j, s) => mk([1000, 5000, 300, (j === 5 && s === 0) ? NaN : 40]));
// layout without old_space -> every window unverifiable
const N3 = ['new_space', 'code_space', 'trusted_space'];
out.noOld = await run((j, s) => mk([1000, 300, 40], N3), N3);
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' && v !== v) ? 'NaN' : v));
`;

test('measureWindows reduction on scripted statistics', () => {
    const o = runChild(REDUCTION_SRC, 'reduction');
    const f = (w) => ({ nan: w.nan, tainted: w.tainted, clean: w.clean });
    assert.deepEqual(f(o.zero), { nan: 0, tainted: 0, clean: 6 });
    assert.deepEqual([o.zero.min, o.zero.median, o.zero.max], [0, 0, 0]);
    assert.equal(windowGate(o.zero, 6, 0), true);
    assert.deepEqual([o.body8.min, o.body8.median, o.body8.max], [8, 8, 8]);
    assert.equal(windowGate(o.body8, 6, 0), false);
    assert.deepEqual(f(o.old16), { nan: 0, tainted: 0, clean: 6 });
    assert.equal(o.old16.max, 16);
    assert.equal(o.old16.min, 0);
    assert.equal(windowGate(o.old16, 6, 0), false);
    // trusted change in the empty bracket alone: tainted (1), 5 clean, clean max 0
    assert.deepEqual(f(o.trustedEmpty), { nan: 0, tainted: 1, clean: 5 });
    assert.equal(o.trustedEmpty.max, 0);
    assert.equal(windowGate(o.trustedEmpty, 6, 1), true);
    assert.equal(windowGate(o.trustedEmpty, 6, 0), false);
    assert.deepEqual(f(o.codeBody), { nan: 0, tainted: 1, clean: 5 });
    assert.equal(o.codeBody.max, 0);
    assert.deepEqual(f(o.lenMismatch), { nan: 1, tainted: 0, clean: 5 });
    assert.equal(windowGate(o.lenMismatch, 6, 4), false);
    assert.equal(o.nanValue.nan, 1);
    assert.equal(windowGate(o.nanValue, 6, 4), false);
    assert.equal(o.noOld.nan, 6);
    assert.equal(windowGate(o.noOld, 6, 4), false);
    assert.deepEqual(f(o.medTaint), { nan: 0, tainted: 3, clean: 3 });
    assert.deepEqual([o.medTaint.min, o.medTaint.median, o.medTaint.max], [0, 0, 0]);
    assert.deepEqual(f(o.minorTainted), { nan: 0, tainted: 1, clean: 5 });
    assert.ok(o.minorTainted.minor >= 1, `minor in a tainted window not counted: ${o.minorTainted.minor}`);
    assert.equal(windowGate(o.minorTainted, 6, 4), false);
});

/* -- child rows: plants on a real registry ---------------------------------------------------------------- */

const PLANT_SRC = `
import v8 from 'node:v8';
const { measureWindows, windowGate, TAINT_CAP } = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
const { createRegistry } = await import(${JSON.stringify(pathToFileURL(SIGNAL).href)});
const N_S = 64, N_C = 64, N_E = 128, NODES = 256, WARMUP = 20, CYCLES = 40;
const r = createRegistry({ maxNodes: 1024 });
const S = new Array(N_S).fill(null), C = new Array(N_C).fill(null);
let cl = 0; const onCl = () => { cl++; };
function build() {
    for (let i = 0; i < N_S; i++) S[i] = r.signal(i);
    for (let i = 0; i < N_C; i++) { const s = S[i]; C[i] = r.computed(() => s() + 1); }
    for (let i = 0; i < N_E; i++) { const c = C[i & (N_C - 1)]; r.effect(() => { c(); r.onCleanup(onCl); }); }
}
const SINK = new Array(NODES).fill(null);
const bodies = {
    clean: { body: () => { r.reset(); } },
    new:   {
        body: () => { r.reset(); for (let i = 0; i < NODES; i++) SINK[i] = { i }; },
        after: () => { SINK.fill(null); } },
    tenure:{ body: () => { r.reset(); for (let i = 0; i < NODES; i++) SINK[i] = { i }; } },
    old:   { body: () => { r.reset(); for (let i = 0; i < NODES; i++) SINK[i] = Symbol(); } },
};
// the HEAD read: new_space only, (m2-m1)-(m1-m0), as in the pre-fix reset-torture
function newSpaceUsed() {
    const s = v8.getHeapSpaceStatistics();
    for (let i = 0; i < s.length; i++) if (s[i].space_name === 'new_space') return s[i].space_used_size;
    return -1;
}
function headRead(body, before) {
    const D = [];
    for (let k = 0; k < WARMUP + CYCLES; k++) {
        before(k);
        globalThis.gc(); globalThis.gc();
        const m0 = newSpaceUsed(), m1 = newSpaceUsed();
        body();
        const m2 = newSpaceUsed();
        if (k >= WARMUP) D.push((m2 - m1) - (m1 - m0));
    }
    D.sort((a, b) => a - b);
    return { min: D[0], median: D[D.length >> 1], max: D[D.length - 1] };
}
const out = {};
for (const name of Object.keys(bodies)) {
    SINK.fill(null);
    const b = bodies[name];
    const w = await measureWindows(b.body, { warmup: WARMUP, cycles: CYCLES, before: build, after: b.after });
    out[name] = { w, gate: windowGate(w, CYCLES, TAINT_CAP) };
}
SINK.fill(null);
out.headOld = headRead(bodies.old.body, build);
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' && v !== v) ? 'NaN' : v));
`;

test('plants: new / tenure / old are seen (median >= 4096 B), gate FAILS; clean reset PASSES; '
    + 'HEAD read of the old plant is blind', () => {
    const o = runChild(PLANT_SRC, 'plants');
    for (const k of ['new', 'tenure', 'old']) {
        assert.ok(o[k].w.median >= 4096, `${k}: clean median ${o[k].w.median} < 4096`);
        assert.equal(o[k].gate, false, `${k}: gate passed an allocating body`);
    }
    assert.equal(o.clean.gate, true, `clean reset: gate failed ${JSON.stringify(o.clean.w)}`);
    assert.equal(o.clean.w.nan, 0);
    assert.ok(o.clean.w.max <= 0);
    assert.equal(o.clean.w.minor, 0);
    assert.equal(o.clean.w.major, 0);
    // the old code (new_space only) cannot see a Symbol() per node: Symbols are old-space by type
    assert.ok(o.headOld.median <= 0, `HEAD read of the old plant saw median ${o.headOld.median} B`);
});

/* -- wiring: reset-torture goes through the helper ------------------------------------------------------- */

test('reset-torture: a4 window and both controls go through measureWindows + windowGate from the helper', () => {
    const src = readFileSync(TORTURE, 'utf8');
    assert.match(src, /import\s*\{[^}]*\bmeasureWindows\b[^}]*\}\s*from\s*["'][^"']*helpers\/heap-window\.mjs["']/);
    assert.match(src, /import\s*\{[^}]*\bwindowGate\b[^}]*\}\s*from\s*["'][^"']*helpers\/heap-window\.mjs["']/);
    const calls = src.match(/\bmeasureWindows\(/g) || [];
    assert.ok(calls.length >= 3, `measureWindows called ${calls.length} times, want >= 3 (a4, control, control-old)`);
    assert.ok(!/function\s+newSpaceUsed\b/.test(src), 'the new_space-only reader is still defined');
    assert.ok(!/(const|function)\s+windowGate\b/.test(src), 'a local windowGate shadows the helper');
    assert.ok(!/function\s+windows\b/.test(src), 'the old windows() loop is still defined');
    assert.match(src, /control-old/);
    for (const id of ['a4-window', 'control', 'control-old']) {
        const re = new RegExp('R\\.(ok|eq)\\(\\s*["\'`]' + id + '["\'`][^;]*windowGate\\(');
        assert.match(src, re, `no ${id} row evaluates windowGate(`);
    }
    assert.match(src, /Symbol\(\)/);
});
