// visit-anatomy.mjs
// Counts what the engine actually DOES per operation -- an Int32-counter-
// instrumented copy of ../Signal.js (or of the one file named by --engine)
// generated at RUN TIME from the current source (never a stale snapshot),
// driven by LCG-deterministic shapes. Where
// creation-anatomy decomposes the birth tax in nanoseconds, this decomposes
// the VISIT tax in exact structural counts: cursor hits vs link allocations,
// mark stamps vs edges walked, clean-short-circuit hits vs dep walks vs
// recomputes, equals dispatches.
//
// Every count is deterministic under the fixed LCG, so this file doubles as
// the ONLY pre-1.6 gate on the 1.5.0 clean short-circuit (`--verify`): the
// opcode lane has no compare/skip opcode until 1.6+, and a reverted
// short-circuit ships green through every timing gate on a quiet host. Here
// it collapses an EXACT counter.
//
// INSTRUMENTATION IS FAIL-CLOSED: each counter is injected at an exact anchor
// string with an expected occurrence count. If the engine's source drifts and
// an anchor vanishes (or multiplies), the tool refuses to run rather than
// reporting half-instrumented numbers. The instrumented copy is written to
// the system temp dir and imported from there; ../Signal.js is never touched.
// instrument(src) (./visit-anchors.mjs) is PURE (string in, string out, no
// fs): it reads no sibling file, so a frozen kernel is measured as exactly
// that one file.
//
// Usage: node harness/visit-anatomy.mjs             # report counters + rates
//        node harness/visit-anatomy.mjs --verify    # exact-count gate (exit 1 on drift)
//        ... --engine <Signal.js>                   # instrument THAT file instead of
//                                                   # ../Signal.js (unreadable -> exit 2)
//
// DIAGNOSTIC (default mode) -- the --verify pins are the one gate surface.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { I, instrument } from "./visit-anchors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// STRICT argv: `--verify` at most once, `--engine <file>` at most once,
// nothing else. A misspelt `--verfy` would otherwise run the diagnostic
// mode and exit 0 (no gate), and `--engine=<file>`, a positional or a second
// --engine would measure a different engine than the caller named. Every
// rejection exits 2 before anything is read or written.
const argFail = (msg) => { console.error(`visit-anatomy: ${msg}`); process.exit(2); };
let VERIFY = false;
let ENGINE_ARG = null;
for (let ai = 2; ai < process.argv.length; ai++) {
    const a = process.argv[ai];
    if (a === "--verify") {
        if (VERIFY) argFail(`duplicate argument "--verify"`);
        VERIFY = true;
    } else if (a === "--engine") {
        // The value must be present and not another flag -- a bare `--engine`
        // fails closed rather than silently measuring ../Signal.js under a
        // header that claims otherwise.
        if (ENGINE_ARG !== null) argFail(`duplicate argument "--engine" (exactly one engine per run)`);
        const v = process.argv[++ai];
        if (typeof v !== "string" || v === "" || v.startsWith("--")) argFail("--engine needs a Signal.js path");
        ENGINE_ARG = v;
    } else {
        argFail(`unknown argument ${JSON.stringify(a)} (did you mean ${a.startsWith("--v") ? "--verify" : "--engine <path>"}?)`);
    }
}

/* -- counter map + injection: ./visit-anchors.mjs --------------------------- */
// NAMES / EDITS / instrument() live there (pure, no fs); this file reads the
// engine, runs the shapes and owns the pins.

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const srcPath = ENGINE_ARG === null ? join(HERE, "../Signal.js") : ENGINE_ARG;
let src;
try { src = readFileSync(srcPath, "utf8"); } catch (e) {
    console.error(`visit-anatomy: cannot read engine ${srcPath} (${e.code || e.message})`);
    process.exit(2);
}
let gen;
try { gen = instrument(src); } catch (e) {
    if (Array.isArray(e.drift)) {
        console.error("visit-anatomy: INSTRUMENTATION ANCHORS DRIFTED -- refusing to run half-instrumented:");
        for (const m of e.drift) console.error("  " + m);
        console.error("Update the EDITS table against the current Signal.js before trusting any output.");
    } else {
        console.error(e.message);
    }
    process.exit(2);
}
const SRC_SHA = sha256(src);
const GEN_SHA = sha256(gen);

const genDir = mkdtempSync(join(tmpdir(), "visit-anatomy-"));
const genPath = join(genDir, "Signal.instrumented.mjs");
writeFileSync(genPath, gen);
process.on("exit", () => { try { rmSync(genDir, { recursive: true, force: true }); } catch { /* best effort */ } });
const E = await import(pathToFileURL(genPath).href);
const VC = globalThis.__VISIT__;
if (!VC) { console.error("visit-anatomy: instrumented engine did not install counters"); process.exit(2); }

const snap = () => Array.from(VC);
const diff = (a, b) => a.map((v, i) => b[i] - v);
const zero = () => VC.fill(0);

/* -- deterministic workload shapes -------------------------------------------- */
function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 8) / 16777216; };
}
const SIZES = { maxNodes: 1 << 14, maxLinks: 1 << 16, prealloc: "eager", onCapacityExceeded: "grow" };

const SHAPES = {
    // Stable steady-state: deep chain x16 + tail effect, 10k writes. The
    // cursor should serve EVERY re-tracked read; zero link churn.
    "stable-deep": (report) => {
        const r = E.createRegistry(SIZES);
        const a = r.signal(0);
        let prev = a;
        for (let i = 0; i < 16; i++) { const p = prev; prev = r.computed(() => p() + 1); }
        let sink = 0; const tail = prev; r.effect(() => { sink = tail(); });
        const OPS = 10_000;
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) a.set(i);
        report(OPS, diff(t0, snap()), { sink });
    },
    // Broadcast: 1 source -> 128 computed+effect pairs, 10k writes. Marks and
    // effect runs dominate; per-write structural work is exactly flat.
    "broadcast": (report) => {
        const r = E.createRegistry(SIZES);
        const a = r.signal(0);
        const sinks = new Array(128).fill(0);
        for (let i = 0; i < 128; i++) { const k = i; const c = r.computed(() => a() + k); r.effect(() => { sinks[k] = c(); }); }
        const OPS = 10_000;
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) a.set(i);
        report(OPS, diff(t0, snap()), { sink: sinks[127] });
    },
    // Branch-flip retracking: the dynamic-DAG lane. Every flip severs one
    // branch's links and allocates the other's; the selector's own link is
    // the cursor's only hit.
    "branch-flip": (report) => {
        const r = E.createRegistry(SIZES);
        const sel = r.signal(0);
        const rnd = lcg(0x1234abcd);
        const a = [], b = [];
        for (let i = 0; i < 4; i++) { a.push(r.signal((rnd() * 1000) | 0)); b.push(r.signal((rnd() * 1000) | 0)); }
        const c = r.computed(() => {
            let t = 0;
            if (sel() & 1) { for (let j = 0; j < 4; j++) t += b[j](); }
            else { for (let j = 0; j < 4; j++) t += a[j](); }
            return t;
        });
        let sink = 0; r.effect(() => { sink = c(); });
        const OPS = 10_000;
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) sel.set(i & 1);
        report(OPS, diff(t0, snap()), { sink });
    },
    // THE markEpoch GATE SHAPE: 64 computeds over source-set A, all primed;
    // then 10k writes to an UNRELATED signal B, re-reading all 64 after each
    // write. No mark ever lands on the A-cone, so every re-read MUST take the
    // clean short-circuit: scHit == 64 * OPS exactly. An engine that lost the
    // short-circuit walks 64 dep lists per round instead -- scHit collapses
    // to 0 while every timing gate stays green on a quiet host.
    "unrelated-read": (report) => {
        const r = E.createRegistry(SIZES);
        const srcs = [];
        for (let i = 0; i < 8; i++) srcs.push(r.signal(i));
        const comps = [];
        for (let i = 0; i < 64; i++) { const s = srcs[i % 8]; comps.push(r.computed(() => s() + i)); }
        const unrelated = r.signal(0);
        let acc = 0;
        for (let i = 0; i < 64; i++) acc += comps[i]();          // prime: first eval
        const OPS = 10_000;
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) {
            unrelated.set(i);
            for (let j = 0; j < 64; j++) acc += comps[j]();
        }
        report(OPS, diff(t0, snap()), { sink: acc });
    },
    // ERROR TRANSPARENCY through the short-circuit (2026-08 review MED): the
    // SC block's FLAG_HAS_ERROR rethrow is part of the machinery the gate
    // covers, and no other shape primes a THROWN computed -- a mutant that
    // drops the rethrow (anchors intact) would make clean reads silently
    // RETURN the cached Error object as a value. Here: one poisoned computed,
    // primed, then re-read once per round after an unrelated write; every
    // read MUST throw the original error, via the SC path (no marks land).
    "error-transparency": (report) => {
        const r = E.createRegistry(SIZES);
        const boom = new Error("cached-poison");
        const poisoned = r.computed(() => { throw boom; });
        const unrelated = r.signal(0);
        try { poisoned(); } catch { /* prime: error cached, evalVersion stamped */ }
        const OPS = 10_000;
        let rethrows = 0, wrongValue = 0;
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) {
            unrelated.set(i);
            try { const v = poisoned(); void v; wrongValue++; } catch (e) { if (e === boom) rethrows++; }
        }
        report(OPS, diff(t0, snap()), { rethrows, wrongValue });
    },
    // DIAMOND: src -> m1,m2 -> join -> effect. The ONLY shape where a node is
    // reachable through TWO paths, so markEpoch dedup is load-bearing: per
    // write markDownstream walks 5 edges but stamps only 4 nodes (join's
    // second visit hits the epoch). The other shapes have single-path
    // topologies where stamps == edges BY SHAPE (2026-08 review MED) -- this
    // pin is the one that fails if the dedup regresses to redundant traversal.
    "diamond": (report) => {
        const r = E.createRegistry(SIZES);
        const src2 = r.signal(0);
        const m1 = r.computed(() => src2() + 1);
        const m2 = r.computed(() => src2() + 2);
        const join = r.computed(() => m1() + m2());
        let sink = 0; r.effect(() => { sink = join(); });
        const OPS = 10_000;
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) src2.set(i);
        report(OPS, diff(t0, snap()), { sink });
    },
};

/* -- report + verify ----------------------------------------------------------- */
const results = {};
for (const [name, run] of Object.entries(SHAPES)) {
    run((ops, d, extra) => { results[name] = { ops, d, extra }; });
}

console.log("visit anatomy -- exact structural counters per shape (instrumented engine, LCG-deterministic)");
// Content hashes, not a path / version / temp dir: the header is identical
// for identical bytes, so a capture is a golden and a different engine (or a
// different EDITS table) differs on this line even when every count agrees.
console.log(`engine: Signal.js sha256 ${SRC_SHA} instrumented sha256 ${GEN_SHA}`);
console.log();
const COLS = ["cursorHit", "linkAlloc", "linkFree", "markStamp", "markEdge", "scHit", "pullTotal", "pullCacheHit", "recompute", "eqDispatch", "effectExec", "depWalk"];
console.log("  " + "shape".padEnd(16) + COLS.map((c) => c.padStart(13)).join(""));
for (const [name, { d }] of Object.entries(results)) {
    console.log("  " + name.padEnd(16) + COLS.map((c) => String(d[I[c]]).padStart(13)).join(""));
}
console.log();
console.log("per-op rates (counter / ops):");
for (const [name, { ops, d }] of Object.entries(results)) {
    const cells = COLS.map((c) => (d[I[c]] / ops).toFixed(2).padStart(13));
    console.log("  " + name.padEnd(16) + cells.join(""));
}
console.log();
for (const [name, { d }] of Object.entries(results)) {
    const hits = d[I.cursorHit], alloc = d[I.linkAlloc];
    const rate = hits + alloc > 0 ? (hits / (hits + alloc) * 100).toFixed(1) : "n/a";
    console.log(`  ${name.padEnd(16)} cursor-hit rate ${String(rate).padStart(6)}%   ` +
        `short-circuit ${d[I.scHit]} of ${d[I.pullTotal]} pulls   marks/edges ${d[I.markStamp]}/${d[I.markEdge]}`);
}

if (VERIFY) {
    // EXACT pins, calibrated against 1.5.0 and the fixed shapes above. Every
    // one is a deterministic structural fact; a mismatch is an engine-behavior
    // change, never noise. Update DELIBERATELY with the engine version that
    // changes the contract.
    const OPS = 10_000;
    const PINS = [
        // The 1.5.0 clean short-circuit: every one of the 64 re-reads per
        // round short-circuits -- THE pre-1.6 markEpoch gate.
        ["unrelated-read", "scHit", 64 * OPS],
        // ...and none of them recomputes, walks a mark, or -- the
        // fall-through witness -- validates a single dependency edge. A
        // mutant that guts the SC body (return dropped, anchors intact)
        // keeps scHit green and explodes THIS counter instead.
        ["unrelated-read", "depWalk", 0],
        ["unrelated-read", "recompute", 0],
        ["unrelated-read", "markStamp", 0],
        ["unrelated-read", "linkAlloc", 0],
        // Error transparency through the SC path: every post-prime read of a
        // poisoned computed rethrows the ORIGINAL error (never a value), and
        // it does so via the short-circuit, without recomputing.
        ["error-transparency", "extra:rethrows", OPS],
        ["error-transparency", "extra:wrongValue", 0],
        ["error-transparency", "scHit", OPS],
        ["error-transparency", "recompute", 0],
        // Diamond: dedup is load-bearing -- 5 edges walked, 4 nodes stamped
        // per write (join's second visit hits the epoch and is NOT re-pushed).
        ["diamond", "markEdge", 5 * OPS],
        ["diamond", "markStamp", 4 * OPS],
        ["diamond", "recompute", 3 * OPS],
        ["diamond", "effectExec", OPS],
        // Steady deep chain: the cursor serves every re-tracked read; the
        // graph never churns a link.
        ["stable-deep", "linkAlloc", 0],
        ["stable-deep", "linkFree", 0],
        // Branch-flip: exactly 4 links severed + 4 allocated per flip, and
        // the selector's link is the only cursor hit of each retrack.
        ["branch-flip", "linkAlloc", 4 * OPS],
        ["branch-flip", "linkFree", 4 * OPS],
        ["branch-flip", "recompute", OPS],
        // Broadcast: every write stamps all 256 targets (128 computeds + 128
        // effects) through exactly 256 edges -- no redundant traversal.
        ["broadcast", "markStamp", 256 * OPS],
        ["broadcast", "markEdge", 256 * OPS],
        ["broadcast", "effectExec", 128 * OPS],
    ];
    let bad = 0;
    console.log();
    for (const [shape, counter, want] of PINS) {
        const got = counter.startsWith("extra:")
            ? results[shape].extra[counter.slice(6)]
            : results[shape].d[I[counter]];
        if (got !== want) {
            console.error(`  VERIFY FAIL: ${shape}.${counter} = ${got.toLocaleString()}, pinned ${want.toLocaleString()}`);
            bad++;
        }
    }
    if (bad) {
        console.error(`\nVERIFY FAILED: ${bad} exact-count pin(s) drifted -- the engine's structural behavior changed`);
        process.exit(1);
    }
    console.log(`  VERIFY PASSED: ${PINS.length} exact structural pins hold (incl. the clean-short-circuit gate)`);
}
process.exit(0);
