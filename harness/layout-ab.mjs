#!/usr/bin/env node
// @zakkster/lite-signal layout A/B -- the instrument that caught #27.
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT License
//
// Any engine candidate that changes a DATA LAYOUT (pool representation, field
// set, allocation site) or claims a memory win runs through this before its
// numbers enter the ledger. It exists because the #27 link-SoA fork passed its
// own gates while costing +10-39% on four shapes, and reported a 33% memory win
// that was really 21-26%: its witness timed both engines in ONE process and
// measured memory with heapUsed, which cannot see ArrayBuffer backing stores.
//
// Three lanes, every cell in its OWN cold child process, A/B order alternated
// per rep (drift cancels instead of landing on whichever engine runs last):
//
//   1. SHAPES  -- ns/op on eight shapes: the propagation family (kairos, deep,
//      diamond, dynamic), the per-hop / effect-dense family that layout moves
//      hurt (mux, broadcast, fanout64), and creation churn. Median of reps, with
//      min..max per engine; a row is SEPARATED when the ranges do not overlap
//      AND the medians differ by >= 3% (SEP_FLOOR -- narrow few-rep ranges
//      separate on noise alone).
//   2. SWEEP   -- a resident graph (~4 links / node, the density regime) across
//      graph sizes 1e3..1e5, so a layout
//      trade is reported WITH its crossover (Law 4's size axis). A single-size
//      result, either side of the crossover, is a cherry-pick.
//   3. MEMORY  -- graph delta over an empty-process baseline as heapUsed PLUS
//      arrayBuffers, and forced full-GC time, under the lazy mirror config,
//      including both sides of two power-of-two link-count boundaries (65k/66k
//      and 130k/132k nodes at ~4 links per node) so doubling-growth sawtooths
//      are visible.
//
// NOT a gate: it prints evidence, exits 0 when every child succeeded and 1 if
// any child failed (fail closed -- a missing cell is never a quiet pass).
//
// USAGE
//   node harness/run.mjs layout [engineA] [engineB] [--reps=10] [--quick]
//   node --expose-gc harness/layout-ab.mjs [engineA] [engineB] [--reps=10] [--quick]
//   No engine: self-test (this repo's Signal.js vs itself). One engine: A is
//   this repo's Signal.js, B is the candidate.
//   Self-test: no engine (or the same engine twice) -- every ratio must read
//   ~1.00 and no row may be SEPARATED. If it is not, the host is too noisy.

import {pathToFileURL, fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import {performance} from "node:perf_hooks";
import os from "node:os";

const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);

// ---------------------------------------------------------------- child mode
if (argv[0] === "--child") {
    const [, enginePath, lane, shape, nArg] = argv;
    const E = await import(pathToFileURL(enginePath).href);
    if (typeof globalThis.gc !== "function") { process.stderr.write("child needs --expose-gc\n"); process.exit(2); }
    const out = lane === "mem" ? memCell(E, Number(nArg) | 0) : shapeCell(E, shape, Number(nArg) | 0);
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
}

function shapeCell(E, shape, n) {
    const SINK = new Float64Array(4096);
    const R = E.createRegistry({maxNodes: 1 << 18, maxLinks: 1 << 20, prealloc: "eager"});
    const {signal, computed, effect, dispose} = R;
    const shapes = {
        kairos() {
            const s = signal(0), cs = [];
            for (let i = 0; i < 1000; i++) cs.push(computed(() => s() + i));
            effect(() => { let t = 0; for (let i = 0; i < 1000; i++) t += cs[i](); SINK[0] = t; });
            return {iters: 2000, op: (i) => s.set(i)};
        },
        broadcast() {
            const s = signal(0);
            for (let i = 0; i < 1000; i++) effect(() => { SINK[i & 4095] = s() + i; });
            return {iters: 2000, op: (i) => s.set(i)};
        },
        fanout64() {
            const s = signal(0);
            for (let i = 0; i < 64; i++) effect(() => { SINK[i] = s() + i; });
            return {iters: 50000, op: (i) => s.set(i)};
        },
        deep() {
            const s = signal(0);
            let p = s;
            for (let i = 0; i < 256; i++) { const q = p; p = computed(() => q() + 1); }
            const tip = p;
            effect(() => { SINK[1] = tip(); });
            return {iters: 10000, op: (i) => s.set(i)};
        },
        mux() {
            const ins = [];
            for (let i = 0; i < 256; i++) ins.push(signal(i));
            const sum = computed(() => { let t = 0; for (let i = 0; i < 256; i++) t += ins[i](); return t; });
            effect(() => { SINK[2] = sum(); });
            return {iters: 10000, op: (i) => ins[i & 255].set(i)};
        },
        diamond() {
            const s = signal(0), tips = [];
            for (let k = 0; k < 100; k++) {
                const a = computed(() => s() + 1), b = computed(() => s() * 2), c = computed(() => s() - 1), d = computed(() => s() ^ 3);
                tips.push(computed(() => a() + b() + c() + d()));
            }
            effect(() => { let t = 0; for (let i = 0; i < 100; i++) t += tips[i](); SINK[3] = t; });
            return {iters: 5000, op: (i) => s.set(i)};
        },
        dynamic() {   // retrack every op: each computed swaps which 2 of 4 candidates it reads
            const src = signal(0), L = 30, W = 32, PAIRS = [[0, 1], [2, 3], [1, 2], [3, 0]];
            let prev = [];
            for (let w = 0; w < W; w++) prev.push(signal(w));
            for (let l = 0; l < L; l++) {
                const nl = [];
                for (let w = 0; w < W; w++) {
                    const cand = [prev[(w * 7) % W], prev[(w * 7 + 13) % W], prev[(w * 7 + 5) % W], prev[(w * 7 + 29) % W]];
                    nl.push(computed(() => { const p = PAIRS[src() & 3]; return cand[p[0]]() + cand[p[1]](); }));
                }
                prev = nl;
            }
            const tip = prev;
            effect(() => { let t = 0; for (let i = 0; i < W; i++) t += tip[i](); SINK[4] = t; });
            return {iters: 2000, op: (i) => src.set(i)};
        },
        churn() {   // mint a signal + computed + effect subgraph and dispose it, per op
            const root = signal(1);
            return {
                iters: 20000, op: (i) => {
                    const a = signal(i), c = computed(() => a() + root()), d = effect(() => { SINK[5] = c(); });
                    a.set(i + 1); d(); dispose(c); dispose(a);
                }
            };
        },
        resident() {   // 1 signal -> m1 computeds -> m2 effects x 7 deps (~4 links / node)
            const F = 7, m2 = (n - 1) >> 1, m1 = (n - 1) - m2, s = signal(0), cs = new Array(m1);
            for (let j = 0; j < m1; j++) cs[j] = computed(() => s() + j);
            for (let k = 0; k < m2; k++) {
                const deps = new Array(F);
                for (let t = 0; t < F; t++) deps[t] = cs[(k + t) % m1];
                effect(() => { let t = 0; for (let q = 0; q < F; q++) t += deps[q](); SINK[k & 4095] = t; });
            }
            return {iters: Math.max(60, (6e6 / n) | 0), op: (i) => s.set(i)};
        },
    };
    const {iters, op} = shapes[shape]();
    const RUNS = 7;
    let k = 1;
    for (let w = 0; w < 3; w++) for (let i = 0; i < iters; i++) op(k++);
    const t = [];
    for (let r = 0; r < RUNS; r++) {
        const t0 = performance.now();
        for (let i = 0; i < iters; i++) op(k++);
        t.push((performance.now() - t0) * 1e6 / iters);
    }
    t.sort((a, b) => a - b);
    let chk = 0;
    for (let i = 0; i < SINK.length; i++) chk += SINK[i];
    if (chk !== chk) throw new Error("sink NaN -- shape did not compute");
    return {nsPerOp: t[RUNS >> 1]};
}

function memCell(E, n) {
    const mu = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage(); };
    const base = mu();
    const F = 7, m2 = (n - 1) >> 1, m1 = (n - 1) - m2;
    const r = E.createRegistry({maxNodes: 131072, maxLinks: 1048576, prealloc: "lazy", onCapacityExceeded: "grow"});
    const s = r.signal(0), cs = new Array(m1);
    for (let j = 0; j < m1; j++) cs[j] = r.computed(() => s() + j);
    for (let k = 0; k < m2; k++) {
        const deps = new Array(F);
        for (let t = 0; t < F; t++) deps[t] = cs[(k + t) % m1];
        r.effect(() => { for (let t = 0; t < F; t++) deps[t](); });
    }
    for (let i = 0; i < 50; i++) s.set(i + 1);
    const after = mu();
    const g = [];
    for (let i = 0; i < 9; i++) { const t0 = performance.now(); globalThis.gc(); g.push(performance.now() - t0); }
    g.sort((a, b) => a - b);
    const heap = after.heapUsed - base.heapUsed, ab = after.arrayBuffers - base.arrayBuffers;
    if (typeof s !== "function") throw new Error("unreachable: keeps the graph alive through measurement");
    return {heapMB: heap / 1048576, abMB: ab / 1048576, totalMB: (heap + ab) / 1048576, gcMs: g[4]};
}

// ---------------------------------------------------------------- parent mode
// Engines: none = self-test (repo Signal.js vs itself); one = repo vs candidate; two = A vs B.
const positional = argv.filter((a) => !a.startsWith("--"));
if (positional.length > 2) {
    process.stderr.write("usage: node --expose-gc harness/layout-ab.mjs [engineA] [engineB] [--reps=10] [--quick]\n");
    process.exit(2);
}
const REPO_ENGINE = resolve(fileURLToPath(new URL("..", import.meta.url)), "Signal.js");
const A = positional.length === 2 ? resolve(positional[0]) : REPO_ENGINE;
const B = positional.length === 0 ? REPO_ENGINE : resolve(positional[positional.length - 1]);
const QUICK = argv.includes("--quick");
const repArg = argv.find((a) => a.startsWith("--reps="));
const REPS = repArg ? Math.max(2, Number(repArg.slice(7)) | 0) : (QUICK ? 3 : 10);
const SHAPES = ["kairos", "broadcast", "fanout64", "deep", "mux", "diamond", "dynamic", "churn"];
const SWEEP = QUICK ? [1e3, 1e4, 1e5] : [1e3, 3e3, 1e4, 3e4, 1e5];
const MEM = QUICK ? [1e4, 1e5] : [1e4, 65000, 66000, 1e5, 130000, 132000];
let childFailures = 0;

function child(engine, lane, shape, n) {
    const r = spawnSync(process.execPath, ["--expose-gc", SELF, "--child", engine, lane, shape, String(n)], {encoding: "utf8"});
    if (r.status !== 0) {
        childFailures++;
        process.stderr.write(`  ! child failed: ${lane}/${shape}/${n} on ${engine}: ${(r.stderr || "").split("\n")[0]}\n`);
        return null;
    }
    return JSON.parse(r.stdout);
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
// Effect-size floor. Non-overlapping ranges alone are not enough: at a few reps
// the ranges are narrow, and the 2026-09 self-test (same engine both sides,
// --quick) "separated" two rows at 1.2% and 0.6%. A row is SEPARATED only when
// the ranges do not overlap AND the medians differ by at least this much.
const SEP_FLOOR = 0.03;
const pad =(s, w) => { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; };

function abLane(label, cells, reps, metric) {
    // cells: [{key, shape, n}] -> {key: {A:[], B:[]}}
    const res = {};
    for (const c of cells) res[c.key] = {A: [], B: []};
    for (let rep = 1; rep <= reps; rep++) {
        for (const c of cells) {
            const order = (rep % 2) ? [["A", A], ["B", B]] : [["B", B], ["A", A]];
            for (const [tag, eng] of order) {
                const o = child(eng, "shape", c.shape, c.n);
                if (o) res[c.key][tag].push(o[metric]);
            }
        }
        process.stderr.write(`  ${label}: rep ${rep}/${reps}\n`);
    }
    return res;
}

function printAB(title, res) {
    console.log(title);
    console.log("  " + "row".padEnd(16) + pad("A med", 12) + pad("B med", 12) + pad("B/A", 8) + "  A[min..max]            B[min..max]            verdict");
    for (const [key, v] of Object.entries(res)) {
        if (!v.A.length || !v.B.length) { console.log("  " + key.padEnd(16) + "  MISSING CELLS"); continue; }
        const a = median(v.A), b = median(v.B);
        const aMin = Math.min(...v.A), aMax = Math.max(...v.A), bMin = Math.min(...v.B), bMax = Math.max(...v.B);
        const big = Math.abs(b / a - 1) >= SEP_FLOOR;
        const sep = !big ? `within noise (<${SEP_FLOOR * 100}%)` : bMin > aMax ? "SEPARATED (B slower)" : bMax < aMin ? "SEPARATED (B faster)" : "overlap";
        console.log("  " + key.padEnd(16) + pad(a.toFixed(1), 12) + pad(b.toFixed(1), 12) + pad((b / a).toFixed(3), 8) +
            "  " + ("[" + aMin.toFixed(0) + ".." + aMax.toFixed(0) + "]").padEnd(22) + " " + ("[" + bMin.toFixed(0) + ".." + bMax.toFixed(0) + "]").padEnd(22) + " " + sep);
    }
    console.log("");
}

console.log("== layout-ab -- cold-child A/B: shapes, size sweep, resident memory ==");
console.log(`host   ${os.cpus()[0] ? os.cpus()[0].model : "unknown"}  ${process.platform}/${process.arch}  node ${process.version}`);
console.log(`A      ${A}`);
console.log(`B      ${B}${A === B ? "   (SELF-TEST: every ratio must read ~1.00)" : ""}`);
console.log(`reps   ${REPS} per cell, one cold child per cell, A/B order alternated per rep`);
console.log("ratio  B/A of median ns/op (below 1 = B faster)\n");

const shapeRes = abLane("shapes", SHAPES.map((s) => ({key: s, shape: s, n: 0})), REPS, "nsPerOp");
printAB("SHAPES (ns/op)", shapeRes);

const sweepRes = abLane("sweep", SWEEP.map((n) => ({key: "resident " + n.toExponential(0), shape: "resident", n})), Math.max(3, Math.ceil(REPS * 0.6)), "nsPerOp");
printAB("SWEEP -- resident graph, ~4 links/node (ns per set)", sweepRes);
const sweepRatios = Object.entries(sweepRes).map(([k, v]) => [k, (v.A.length && v.B.length) ? median(v.B) / median(v.A) : NaN]);
let cross = null;
for (let i = 1; i < sweepRatios.length; i++) {
    const [k0, r0] = sweepRatios[i - 1], [k1, r1] = sweepRatios[i];
    if ((r0 - 1) * (r1 - 1) < 0) cross = `${k0} (${r0.toFixed(2)}) -> ${k1} (${r1.toFixed(2)})`;
}
const anyTrade = sweepRatios.some(([, r]) => Math.abs(r - 1) >= SEP_FLOOR);
console.log("CROSSOVER  " + (!anyTrade ? `no trade detected -- every sweep ratio is within +-${SEP_FLOOR * 100}%`
    : cross ? "B/A crosses 1.00 between " + cross : "none in the swept range -- the trade has one sign across 1e3..1e5") + "\n");

console.log("MEMORY -- lazy mirror config (131072 / 1048576, grow); graph delta over empty baseline");
console.log("  " + "nodes".padEnd(10) + pad("A heap", 9) + pad("A AB", 8) + pad("A total", 10) + pad("B heap", 9) + pad("B AB", 8) + pad("B total", 10) + pad("B vs A", 9) + pad("A gcMs", 9) + pad("B gcMs", 9));
for (const n of MEM) {
    const ma = child(A, "mem", "resident", n), mb = child(B, "mem", "resident", n);
    if (!ma || !mb) { console.log("  " + String(n).padEnd(10) + "  MISSING CELLS"); continue; }
    console.log("  " + String(n).padEnd(10) + pad(ma.heapMB.toFixed(1), 9) + pad(ma.abMB.toFixed(1), 8) + pad(ma.totalMB.toFixed(1), 10) +
        pad(mb.heapMB.toFixed(1), 9) + pad(mb.abMB.toFixed(1), 8) + pad(mb.totalMB.toFixed(1), 10) +
        pad(((mb.totalMB / ma.totalMB - 1) * 100).toFixed(0) + "%", 9) + pad(ma.gcMs.toFixed(2), 9) + pad(mb.gcMs.toFixed(2), 9));
}
console.log("\nMemory is heapUsed + arrayBuffers (MB); heapUsed alone cannot see typed-array columns.");
console.log("gcMs = median of 9 forced full gc() calls on the resident graph. One sample per cell.");
if (childFailures) { console.log(`\nFAIL CLOSED: ${childFailures} child cell(s) failed -- the evidence is incomplete.`); process.exit(1); }
process.exit(0);
