// visit-anatomy.mjs
// Counts what the engine actually DOES per operation -- an Int32-counter-
// instrumented copy of ../Signal.js generated at RUN TIME from the current
// source (never a stale snapshot), driven by LCG-deterministic shapes. Where
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
//
// Usage: node harness/visit-anatomy.mjs             # report counters + rates
//        node harness/visit-anatomy.mjs --verify    # exact-count gate (exit 1 on drift)
//
// DIAGNOSTIC (default mode) -- the --verify pins are the one gate surface.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = process.argv.includes("--verify");

/* -- counter map -------------------------------------------------------------- */
const NAMES = [
    "cursorHit",      // 0  read fast path: cursor reused the existing link (x4 sites)
    "linkAlloc",      // 1  link actually WIRED (past allocateLink's abort + same-pass dedup)
    "linkFree",       // 2  freeLink entry (sever)
    "markStamp",      // 3  markDownstream stamped a node's markEpoch (first visit this write)
    "markEdge",       // 4  markDownstream walked one subscriber edge
    "scHit",          // 5  pullComputed CLEAN SHORT-CIRCUIT hit (the 1.5.0 markEpoch gate)
    "pullTotal",      // 6  pullComputed entries
    "pullCacheHit",   // 7  pullComputed same-globalVersion cache hit
    "recompute",      // 8  pullComputed actually re-ran the body
    "eqDispatch",     // 9  `const eq = node.equals` dispatch sites (x5 on 1.7.0)
    "effectExec",     // 10 executeEffect entries
    "depWalk",        // 11 dep-validation edges walked (pullComputed + executeEffect needsRun loops)
];
const IDX = Object.fromEntries(NAMES.map((n, i) => [i, n]));
const I = Object.fromEntries(NAMES.map((n, i) => [n, i]));

/* -- injection ---------------------------------------------------------------- */
// [anchor, replacement, expectedOccurrences]. Replacement PREPENDS the count
// so the anchor's own semantics are untouched.
const bump = (i) => `__VC[${i}]++; `;
const EDITS = [
    [`const FLAG_COMPUTED = 1 << 0;`,
        `const __VC = new Int32Array(16);\nglobalThis.__VISIT__ = __VC;\nconst FLAG_COMPUTED = 1 << 0;`, 1],
    [`activeObserverCurrentDep = expected.nextDep;`,
        `${bump(I.cursorHit)}activeObserverCurrentDep = expected.nextDep;`, 4],
    // linkAlloc counts links actually WIRED, not allocateLink calls: the entry
    // point aborts on dead targets and dedups same-pass re-reads before any
    // pool work (2026-08 review LOW: entry counting skewed the cursor-hit rate
    // on shapes that read one source twice in a pass).
    [`        let link;
        if (freeLinkHead === null) {`,
        `        ${bump(I.linkAlloc)}let link;
        if (freeLinkHead === null) {`, 1],
    // depWalk counts dep-validation EDGES in both walks (pullComputed's stale
    // check and executeEffect's needsRun check). THE fall-through witness
    // (2026-08 review HIGH): scHit counts short-circuit branch ENTRIES, so a
    // mutant that guts the branch BODY (drops its return, anchors intact)
    // keeps scHit green while every clean read silently pays the O(deps)
    // walk -- which this counter sees exactly.
    [`                const dep = link.source;
                if ((dep.flags & FLAG_COMPUTED) !== 0) pullComputed(dep);`,
        `                ${bump(I.depWalk)}const dep = link.source;
                if ((dep.flags & FLAG_COMPUTED) !== 0) pullComputed(dep);`, 2],
    // The tree's Watch.js would import the tree's UNINSTRUMENTED Signal.js --
    // a second counter-free engine silently reachable through E.watch. Strip
    // the re-export: any shape touching it crashes loudly instead.
    [`export {watch, when, whenAsync} from "./Watch.js";`,
        `// visit-anatomy: watch/when/whenAsync re-export STRIPPED (would bind a second, uninstrumented engine)`, 1],
    [`function freeLink(link, target, source) {`,
        `function freeLink(link, target, source) { ${bump(I.linkFree)}`, 1],
    [`                if (t.markEpoch !== gv) {`,
        `                ${bump(I.markEdge)}if (t.markEpoch !== gv) { ${bump(I.markStamp)}`, 1],
    [`if (node.evalVersion !== 0 && ((node.markEpoch - node.evalVersion) | 0) <= 0) {`,
        `if (node.evalVersion !== 0 && ((node.markEpoch - node.evalVersion) | 0) <= 0) { ${bump(I.scHit)}`, 1],
    [`function pullComputed(node) {`,
        `function pullComputed(node) { ${bump(I.pullTotal)}`, 1],
    [`        if (node.evalVersion === globalVersion) {`,
        `        if (node.evalVersion === globalVersion) { ${bump(I.pullCacheHit)}`, 1],
    [`runCleanup(node);   // CROSS-EDGE L3->L2: dispose owned children before recompute`,
        `${bump(I.recompute)}runCleanup(node);   // CROSS-EDGE L3->L2: dispose owned children before recompute`, 1],
    // 1.7.0 RE-ANCHOR (2026-09-06): the flushStrategy build-time closure split
    // duplicates the .set body (eager/deferred variants) and boxSet likewise,
    // so the 3 logical eq sites (set, boxSet, computed re-eval) now appear as
    // 5 source sites. Only ONE set/boxSet variant is instantiated per registry
    // (the ternary picks a closure at creation), so runtime counts -- and every
    // pin below -- are unchanged under the default eager strategy the shapes use.
    [`const eq = node.equals;`,
        `${bump(I.eqDispatch)}const eq = node.equals;`, 5],
    [`function executeEffect(node) {`,
        `function executeEffect(node) { ${bump(I.effectExec)}`, 1],
];

// markEdge counts EDGES WALKED, but the anchor sits inside the epoch check --
// correction: it must count every loop iteration. The anchor above prepends
// the edge bump BEFORE `if (t.markEpoch ...)`, which executes once per edge
// walked: correct.

const srcPath = join(HERE, "../Signal.js");
let src = readFileSync(srcPath, "utf8");
const missing = [];
for (const [anchor, replacement, expected] of EDITS) {
    const n = src.split(anchor).length - 1;
    if (n !== expected) { missing.push(`"${anchor.slice(0, 48)}..." found ${n}x, expected ${expected}x`); continue; }
    src = src.split(anchor).join(replacement);
}
if (missing.length) {
    console.error("visit-anatomy: INSTRUMENTATION ANCHORS DRIFTED -- refusing to run half-instrumented:");
    for (const m of missing) console.error("  " + m);
    console.error("Update the EDITS table against the current Signal.js before trusting any output.");
    process.exit(2);
}

// The generated copy lives outside the repo, so its relative sibling imports
// (./Watch.js) must be rewritten to absolute URLs back into the tree.
src = src.replace(/from "\.\/([^"]+)"/g, (_, rel) => `from ${JSON.stringify(pathToFileURL(join(HERE, "..", rel)).href)}`);

const genDir = mkdtempSync(join(tmpdir(), "visit-anatomy-"));
const genPath = join(genDir, "Signal.instrumented.mjs");
writeFileSync(genPath, src);
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
console.log(`engine: ../Signal.js @ ${JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")).version} (tree), instrumented copy in ${genDir}`);
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
