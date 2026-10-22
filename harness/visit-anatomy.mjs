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
// SHAPES: stable-deep, broadcast, branch-flip, unrelated-read,
// error-transparency, diamond (the 21 original pins), then cutoff-chain
// (equality cut-off), effect-fanin (effect pre-walk break), sc-reread (the
// short-circuit's evalVersion re-stamp), a19-pull-freed and a19-effect-freed
// (a pre-walk pull that frees the link the walk stands on: the A1.9
// LINK-FREED guards -- the `link.source !== dep || link.target !== node`
// checks in refreshComputed's pre-walk and in pullMoved -- plus a dep-walk count
// and a zero-retention witness) -- 16 more pins (37), then a19-pull-aba,
// a19-effect-aba, a19-effect-relink and a19-pull-relink (a pre-walk pull that
// disposes the READER itself, whose slot and link are recycled at once: the
// A1.9 disposed-reader guards -- `node.gen !== savedGen` after each pre-walk
// -- and each of the four halves of the two link checks alone: a recycled
// reader slot keeps the link's target (pcTargetOnly -> a19-pull-aba,
// pmTargetOnly -> a19-effect-aba), a same-source relink keeps its source
// (pcSourceOnly -> a19-pull-relink, pmSourceOnly -> a19-effect-relink)) --
// 24 more pins (61), each red on a named mutant or an integrity witness
// (aba: the slot really was recycled; zRuns: the stranger's body runs
// exactly twice per op -- genNoBump runs it a third time; linkGrowth: no
// link constructed after op 1 -- linkNoReuse; linkSame: the freed link is
// the one re-wired -- linkSecond; liveDelta).
// NOT pinned: eeNoStamp (executeEffect's no-run evalVersion stamp dropped)
// is equivalent on a correct engine except across the 2^31 band; current
// witness = F-b33-1 (a pre-walk pull that writes an earlier-checked signal
// dep is absorbed by that stamp -- a lost update on every engine since wt0;
// eeNoStamp shows the write one queueing late). A pin there would bless the
// bug.
//
// ERA NOTE: the a19-* pins describe the A1.9+ engine. An engine without the
// A1.9 guards MAY fail exactly a19-pull-freed.extra:fresh and
// a19-effect-freed.extra:reruns (ruling R1) plus any of the 24 pins of the
// four reader-disposed shapes (R1 extended, burst 33); whether it does
// depends on what else it lacks. wt0 (7f707ccd) passes the first 37: it also
// lacks A1 r4's gen check before the value write, so the self-disposed X
// still bumps its version and that moved version re-runs the reader before
// the walk reaches the freed link (wt0 with only that check added fails
// exactly those two pins). Of the 24 it fails exactly the four depWalk pins
// (no link-moved check: each reader walks one edge into its recycled
// successor's list). The tool does not check the engine's era: the
// expected-red set per kernel lives in
// bench/soak/calibration/golden/visit-anatomy.golden.json. Any other red pin,
// a SHAPE CRASH, or a liveDelta != 0, is an engine finding.
//
// LINK REUSE AND IDENTITY: the four link-check halves are only reachable
// because the link the reader's dispose frees is the very next link wired
// (the engine's link free list is LIFO), so it comes back with the same
// target or the same source. Both facts are witnessed, not assumed:
// linkGrowth 0 (no link constructed after op 1: every link came off the free
// list; linkNoReuse reads 39,936) and linkSame == OPS (the successor's first
// dep link IS the reader's freed link, compared as engine objects through
// node_ptr -> headDep; a free list that pushes the freed link second reads
// 0). If either goes red the half-check pins may have lost their teeth:
// re-run pcTargetOnly, pcSourceOnly, pmTargetOnly and pmSourceOnly.
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
        // The HINT is case- and dash-insensitive (`--VERIFY`, `-v`, `verify`
        // -> --verify; `--Engine`, `-e` -> --engine <path>); ACCEPTANCE stays
        // exact and case-sensitive -- every one of these still exits 2.
        const h = a.toLowerCase().replace(/^-+/, "");
        const hint = h.startsWith("v") ? "--verify" : h.startsWith("e") ? "--engine <path>" : "--verify or --engine <path>";
        argFail(`unknown argument ${JSON.stringify(a)} (did you mean ${hint}?)`);
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
// The reader-disposed shapes build their pools LAZILY (1024-link chunks on a
// free-list miss), so linkPoolPopulation is a link-reuse witness: after op 1
// every link they wire must come off the free list (linkGrowth 0). An eager
// pool hides a free list that never refills behind its 65,536 prebuilt links.
const LAZY = { maxNodes: 1 << 14, maxLinks: 1 << 16, prealloc: "lazy", onCapacityExceeded: "grow" };
// Retention witness for the create / dispose shapes: the five live gauges
// disposeNode / freeLink decrement (activeLinks, activeNodes, signals,
// computeds, effects), after minus before, summed as ABSOLUTE deltas so a
// leaked link cannot cancel a double-freed node. 0 = every node and link the
// loop made was released.
const LIVE = ["activeLinks", "activeNodes", "signals", "computeds", "effects"];
const liveDelta = (a, b) => LIVE.reduce((t, k) => t + Math.abs(b[k] - a[k]), 0);
// ABA witness for the *-aba / relink shapes: the node a handle points at, via
// the engine's own `node_ptr` symbol (an own property on every signal,
// computed and effect handle). Fails closed: a handle without it throws (a
// SHAPE CRASH), never compares undefined === undefined.
const ptr = (h) => {
    const k = Object.getOwnPropertySymbols(h).find((y) => y.description === "node_ptr");
    if (k === undefined) throw new Error("handle carries no node_ptr symbol");
    return h[k];
};
// Link-identity witness (linkSame): the first dep link of the node behind a
// handle -- the engine's own link object. Fails closed to undefined (never
// throws): a missing handle, node_ptr or headDep makes linkSame count 0.
const headDepOf = (h) => {
    try { const n = ptr(h); return n !== null && typeof n === "object" ? n.headDep : undefined; } catch { return undefined; }
};
const sameLink = (L, h) => typeof L === "object" && L !== null && headDepOf(h) === L;

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
    // EQUALITY CUT-OFF: s -> X = s() & 0 -> Y = X() + 1 -> effect. Every write
    // recomputes X, whose value never changes, so the `equals` cut-off keeps
    // X.version still: Y's pre-walk pulls X and stops (no Y recompute), and
    // the effect's pre-walk pulls Y and stops (no body run). Per write: one
    // recompute and three dep edges (E->Y, Y->X, X->s). A refreshComputed
    // pre-walk that re-runs after every computed pull recomputes Y too (2x);
    // an effect pre-walk that runs after every computed pull runs the body.
    "cutoff-chain": (report) => {
        const r = E.createRegistry(SIZES);
        const s = r.signal(0);
        const X = r.computed(() => s() & 0);
        const Y = r.computed(() => X() + 1);
        let effectBody = 0, sink = 0;
        r.effect(() => { effectBody++; sink = Y(); });
        effectBody = 0;                                            // count runs after creation only
        const OPS = 10_000;
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) s.set(i);
        report(OPS, diff(t0, snap()), { effectBody, sink });
    },
    // EFFECT FAN-IN: one effect over four signals a, b, c, d (read in that
    // order); each write moves a, the FIRST dep. executeEffect's pre-walk
    // must stop at the first moved dep: one edge walked per write, not four.
    "effect-fanin": (report) => {
        const r = E.createRegistry(SIZES);
        const a = r.signal(0), b = r.signal(1), c = r.signal(2), d = r.signal(3);
        let effectBody = 0, sink = 0;
        r.effect(() => { effectBody++; sink = a() + b() + c() + d(); });
        effectBody = 0;
        const OPS = 10_000;
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) a.set(i);
        report(OPS, diff(t0, snap()), { effectBody, sink });
    },
    // SHORT-CIRCUIT RE-STAMP: 8 primed computeds over 8 signals; each round
    // writes an UNRELATED signal, then reads every computed TWICE. The first
    // read takes the clean short-circuit, which re-stamps evalVersion to the
    // current globalVersion, so the second read is a same-version cache hit.
    // Without the re-stamp both reads take the short-circuit.
    "sc-reread": (report) => {
        const r = E.createRegistry(SIZES);
        const srcs = [];
        for (let i = 0; i < 8; i++) srcs.push(r.signal(i));
        const comps = [];
        for (let i = 0; i < 8; i++) { const s = srcs[i]; comps.push(r.computed(() => s() + i)); }
        const unrelated = r.signal(0);
        let acc = 0;
        for (let i = 0; i < 8; i++) acc += comps[i]();            // prime: first eval
        const OPS = 10_000;
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) {
            unrelated.set(i);
            for (let j = 0; j < 8; j++) { acc += comps[j](); acc += comps[j](); }
        }
        report(OPS, diff(t0, snap()), { sink: acc });
    },
    // A1.9 LINK FREED INSIDE refreshComputed's PRE-WALK: X disposes ITSELF from
    // its own body once s moves; Y reads X. Per op: fresh s / X / Y, prime Y,
    // write s, read Y. Y's pre-walk pulls X, X's recompute frees the X->Y
    // link the walk stands on, and the A1.9 guard must re-run Y (which now
    // reads the disposed X as undefined -> 1). Without the guard the walk
    // follows the freed link's nulled nextDep, ends "clean" and returns the
    // stale 0. liveDelta: every registry gauge (links, nodes, per kind) after
    // OPS create / dispose cycles minus before, summed as absolute values.
    "a19-pull-freed": (report) => {
        const r = E.createRegistry(SIZES);
        const OPS = 10_000;
        let fresh = 0;
        const st0 = r.stats();
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) {
            const s = r.signal(0);
            let X = null;
            X = r.computed(() => { if (s() !== 0) r.dispose(X); return 0; });
            const Y = r.computed(() => (X() === undefined ? 1 : 0));
            Y();                                                   // prime: X -> Y wired, both clean
            s.set(1);
            fresh += Y();
            r.dispose(Y);
            r.dispose(s);
        }
        const d = diff(t0, snap());
        report(OPS, d, { fresh, liveDelta: liveDelta(st0, r.stats()) });
    },
    // A1.9 LINK FREED INSIDE executeEffect's PRE-WALK: the same self-disposing
    // X, read by an effect. The write queues the effect; its pre-walk pulls X
    // (pullMoved), X's recompute frees the X->E link, and the effect must run
    // (reruns counts body runs after creation). Without the guard the walk
    // ends "clean" on the nulled nextDep and the effect never re-runs.
    "a19-effect-freed": (report) => {
        const r = E.createRegistry(SIZES);
        const OPS = 10_000;
        let reruns = 0;
        const st0 = r.stats();
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) {
            const s = r.signal(0);
            let X = null;
            X = r.computed(() => { if (s() !== 0) r.dispose(X); return 0; });
            let runs = 0;
            const stop = r.effect(() => { runs++; X(); });
            runs = 0;                                              // count runs after creation only
            s.set(1);
            reruns += runs;
            stop();
            r.dispose(s);
        }
        const d = diff(t0, snap());
        report(OPS, d, { reruns, liveDelta: liveDelta(st0, r.stats()) });
    },
    // A1.9 READER DISPOSED (AND RECYCLED) INSIDE refreshComputed's PRE-WALK (ABA):
    // Y reads X; once s moves, X's body disposes Y, creates Z (t1 + t2) and
    // reads it untracked. Y is in its pre-walk, not COMPUTING, so disposeNode
    // puts its slot straight on the LIFO free list: Z takes Y's node (aba) and
    // Z's first read reuses the freed X->Y link as t1->Z. Y's walk must see the
    // moved link, then the gen check must return before anything touches the
    // node -- now Z's. Witness: t1.set(2) and Z must read 2 (strangerOk), and
    // Z's body runs exactly twice per op (zRuns: its first eval + the witness
    // read). pcGenDrop runs the recycled node instead: Z is left COMPUTING and
    // its next read throws CycleError (counted in `cycle`, never strangerOk).
    // pcTargetOnly keeps walking Z's list (target is still the same node).
    // A pre-walk that never re-runs X (Z === null) is "not reached": no read,
    // no ptr(), so strangerOk / aba go red instead of the shape crashing.
    "a19-pull-aba": (report) => {
        const r = E.createRegistry(LAZY);
        const OPS = 10_000;
        let strangerOk = 0, cycle = 0, aba = 0, zRuns = 0, pop1 = 0, linkSame = 0;
        const st0 = r.stats();
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) {
            const s = r.signal(0), t1 = r.signal(0), t2 = r.signal(0);
            let Y = null, Z = null;
            const X = r.computed(() => {
                if (s() !== 0) {
                    r.dispose(Y);
                    Z = r.computed(() => { zRuns++; return t1() + t2(); });
                    r.untrack(() => Z());
                }
                return 0;
            });
            Y = r.computed(() => X() + 1);
            Y();                                                   // prime: X -> Y wired, both clean
            const L = headDepOf(Y);                                // the X->Y link the dispose frees
            s.set(1);
            Y();                                                   // the pre-walk pull disposes Y, recycles it as Z
            if (sameLink(L, Z)) linkSame++;                        // ...and Z's first dep IS that link (t1 -> Z)
            t1.set(2);
            if (Z !== null) {
                try { if (r.untrack(() => Z()) === 2) strangerOk++; } catch (e) {
                    if (!(e instanceof Error && e.message.startsWith("CycleError:"))) throw e;
                    cycle++;
                }
                if (ptr(Z) === ptr(Y)) aba++;
            }
            r.dispose(X); r.dispose(s); r.dispose(t1); r.dispose(t2);
            if (i === 1) pop1 = r.stats().linkPoolPopulation;
        }
        const d = diff(t0, snap());
        const st1 = r.stats();
        report(OPS, d, { strangerOk, cycle, aba, zRuns, linkSame, linkGrowth: st1.linkPoolPopulation - pop1, liveDelta: liveDelta(st0, st1) });
    },
    // A1.9 READER DISPOSED (AND RECYCLED) INSIDE executeEffect's PRE-WALK: the
    // same, with an effect as the reader; X's body calls the effect's own stop
    // handle. eeGenDrop runs the recycled node (Z left COMPUTING -> CycleError).
    "a19-effect-aba": (report) => {
        const r = E.createRegistry(LAZY);
        const OPS = 10_000;
        let strangerOk = 0, cycle = 0, aba = 0, zRuns = 0, pop1 = 0, linkSame = 0;
        const st0 = r.stats();
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) {
            const s = r.signal(0), t1 = r.signal(0), t2 = r.signal(0);
            let stopE = null, Z = null;
            const X = r.computed(() => {
                if (s() !== 0) {
                    stopE();
                    Z = r.computed(() => { zRuns++; return t1() + t2(); });
                    r.untrack(() => Z());
                }
                return 0;
            });
            stopE = r.effect(() => { X(); });
            const L = headDepOf(stopE);                            // the X->E link the stop frees
            s.set(1);                                              // the pre-walk pull stops E, recycles it as Z
            if (sameLink(L, Z)) linkSame++;                        // ...and Z's first dep IS that link (t1 -> Z)
            t1.set(2);
            if (Z !== null) {
                try { if (r.untrack(() => Z()) === 2) strangerOk++; } catch (e) {
                    if (!(e instanceof Error && e.message.startsWith("CycleError:"))) throw e;
                    cycle++;
                }
                if (ptr(Z) === ptr(stopE)) aba++;
            }
            r.dispose(X); r.dispose(s); r.dispose(t1); r.dispose(t2);
            if (i === 1) pop1 = r.stats().linkPoolPopulation;
        }
        const d = diff(t0, snap());
        const st1 = r.stats();
        report(OPS, d, { strangerOk, cycle, aba, zRuns, linkSame, linkGrowth: st1.linkPoolPopulation - pop1, liveDelta: liveDelta(st0, st1) });
    },
    // A1.9 LINK RECYCLED WITH THE SAME SOURCE (pullMoved's TARGET half): E reads
    // X; once s moves, X's body stops E, makes pad (takes E's slot: aba) and C2,
    // and creates an effect whose X() read reuses the freed X->E link L as
    // X -> T (same source, new target); its C2() read makes L.nextDep non-null.
    // X is COMPUTING, so that X() read throws CycleError inside T (caught). E's
    // pre-walk must see L's target moved and stop; pmSourceOnly (source-only
    // check) walks on into T's list (one more edge per op). pad is a computed,
    // so an engine that runs the recycled node runs a callable computeFn.
    "a19-effect-relink": (report) => {
        const r = E.createRegistry(LAZY);
        const OPS = 10_000;
        let aba = 0, pop1 = 0, linkSame = 0;
        const st0 = r.stats();
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) {
            const s = r.signal(0);
            let stopE = null, pad = null, C2 = null, stopT = null;
            const X = r.computed(() => {
                if (s() !== 0) {
                    stopE();
                    pad = r.computed(() => 0);
                    C2 = r.computed(() => 7);
                    stopT = r.effect(() => {
                        try { X(); } catch (e) {
                            if (!(e instanceof Error && e.message.startsWith("CycleError:"))) throw e;
                        }
                        C2();
                    });
                }
                return 0;
            });
            stopE = r.effect(() => { X(); });
            const L = headDepOf(stopE);                            // the X->E link the stop frees
            s.set(1);                                              // the pre-walk pull stops E, relinks L as X -> T
            if (sameLink(L, stopT)) linkSame++;                    // ...and T's first dep IS that link (X -> T)
            if (pad !== null && ptr(pad) === ptr(stopE)) aba++;
            r.dispose(X); r.dispose(s);
            if (stopT !== null) stopT();
            r.dispose(pad); r.dispose(C2);
            if (i === 1) pop1 = r.stats().linkPoolPopulation;
        }
        const d = diff(t0, snap());
        const st1 = r.stats();
        report(OPS, d, { aba, linkSame, linkGrowth: st1.linkPoolPopulation - pop1, liveDelta: liveDelta(st0, st1) });
    },
    // A1.9 LINK RECYCLED WITH THE SAME SOURCE inside refreshComputed's PRE-WALK
    // (the inline check's TARGET half): the effect-relink shape with a computed
    // reader. Y reads X; X's body disposes Y, makes pad (takes Y's slot) and
    // C2, and creates a computed T read untracked, whose X() read reuses the
    // freed X->Y link as X -> T and whose C2() read makes its nextDep non-null.
    // Y's walk must see the target moved; pcSourceOnly walks on into T's list.
    "a19-pull-relink": (report) => {
        const r = E.createRegistry(LAZY);
        const OPS = 10_000;
        let aba = 0, pop1 = 0, linkSame = 0;
        const st0 = r.stats();
        zero(); const t0 = snap();
        for (let i = 1; i <= OPS; i++) {
            const s = r.signal(0);
            let Y = null, pad = null, C2 = null, T = null;
            const X = r.computed(() => {
                if (s() !== 0) {
                    r.dispose(Y);
                    pad = r.computed(() => 0);
                    C2 = r.computed(() => 7);
                    T = r.computed(() => {
                        try { X(); } catch (e) {
                            if (!(e instanceof Error && e.message.startsWith("CycleError:"))) throw e;
                        }
                        return C2();
                    });
                    r.untrack(() => T());
                }
                return 0;
            });
            Y = r.computed(() => X() + 1);
            Y();                                                   // prime: X -> Y wired, both clean
            const L = headDepOf(Y);                                // the X->Y link the dispose frees
            s.set(1);
            Y();                                                   // the pre-walk pull disposes Y, relinks L as X -> T
            if (sameLink(L, T)) linkSame++;                        // ...and T's first dep IS that link (X -> T)
            if (pad !== null && ptr(pad) === ptr(Y)) aba++;
            r.dispose(T); r.dispose(X); r.dispose(s); r.dispose(pad); r.dispose(C2);
            if (i === 1) pop1 = r.stats().linkPoolPopulation;
        }
        const d = diff(t0, snap());
        const st1 = r.stats();
        report(OPS, d, { aba, linkSame, linkGrowth: st1.linkPoolPopulation - pop1, liveDelta: liveDelta(st0, st1) });
    },
};

/* -- report + verify ----------------------------------------------------------- */
const results = {};
// A shape that throws (a mutant engine, a broken shape) ends the run with ONE
// named stderr line and exit 1 -- never a raw stack, never a partial report.
// process.exit runs the exit hook above, so the temp dir is removed. The
// message stays on that one line: CR / LF / U+2028 / U+2029 are escaped. A
// thrown value that cannot be turned into text (a throwing toString / message
// getter, a null-prototype object, a hostile Proxy) still yields ONE line.
const oneLineMsg = (e) => {
    let t;
    try { t = String(e instanceof Error ? e.message : e); } catch { t = "<thrown value cannot be converted to a string>"; }
    return t.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
};
for (const [name, run] of Object.entries(SHAPES)) {
    try {
        run((ops, d, extra) => { results[name] = { ops, d, extra }; });
    } catch (e) {
        console.error(`visit-anatomy: SHAPE CRASH ${name}: ${oneLineMsg(e)}`);
        process.exit(1);
    }
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
        // --- B-B2b (2026-10-14): 16 pins, witnesses for the mutants that
        // survived the 21 above (S2 group B review). Each names its mutant.
        // Dep-validation walks stop at the first moved dep (pcNoBreak): the
        // diamond's join walks m1 only, branch-flip's computed walks sel only.
        ["diamond", "depWalk", 4 * OPS],
        ["branch-flip", "depWalk", 2 * OPS],
        // Equality cut-off: only X recomputes (a19True re-runs Y too), three
        // edges per write, and the effect body never runs (pmTrue runs it).
        ["cutoff-chain", "recompute", OPS],
        ["cutoff-chain", "depWalk", 3 * OPS],
        ["cutoff-chain", "extra:effectBody", 0],
        // Effect pre-walk stops at the first moved dep (eeNoBreak walks 4).
        ["effect-fanin", "depWalk", OPS],
        ["effect-fanin", "extra:effectBody", OPS],
        // The SC re-stamp: first read short-circuits, second is a cache hit
        // (scNoStamp: both short-circuit, zero cache hits).
        ["sc-reread", "scHit", 8 * OPS],
        ["sc-reread", "pullCacheHit", 8 * OPS],
        ["sc-reread", "recompute", 0],
        // A1.9 link-freed guards (a19False / pmFalse); a pre-A1.9 engine MAY
        // go red here (wt0 does not; see the header). Zero retention.
        ["a19-pull-freed", "extra:fresh", OPS],
        ["a19-pull-freed", "extra:liveDelta", 0],
        ["a19-effect-freed", "extra:reruns", OPS],
        ["a19-effect-freed", "extra:liveDelta", 0],
        // Fix round 1b (2026-10-14): the a19 shapes walk exactly two dep edges
        // per op (reader -> X, X -> s). A shape that never primes the reader
        // (or never reaches the freed link) walks a different count.
        ["a19-pull-freed", "depWalk", 2 * OPS],
        ["a19-effect-freed", "depWalk", 2 * OPS],
        // --- B-B2d (2026-10-14): 24 pins, the A1.9 disposed-READER guards
        // (`node.gen !== savedGen` after each pre-walk) and all four halves of
        // the two link-moved checks. The reader's slot and link are recycled
        // inside its own pre-walk (aba == OPS: the shape really reached the
        // ABA; linkGrowth 0 / linkSame: the freed link itself was re-wired,
        // see LINK REUSE AND IDENTITY above).
        // pcGenDrop -> pull-aba strangerOk 0; eeGenDrop -> effect-aba
        // strangerOk 0; genNoBump -> both zRuns 3x; depWalk 4x: pcTargetOnly
        // -> pull-aba, pmTargetOnly -> effect-aba, pmSourceOnly ->
        // effect-relink, pcSourceOnly -> pull-relink. Three dep edges per op
        // in each shape.
        ["a19-pull-aba", "depWalk", 3 * OPS],
        ["a19-pull-aba", "extra:strangerOk", OPS],
        ["a19-pull-aba", "extra:aba", OPS],
        ["a19-pull-aba", "extra:liveDelta", 0],
        ["a19-effect-aba", "depWalk", 3 * OPS],
        ["a19-effect-aba", "extra:strangerOk", OPS],
        ["a19-effect-aba", "extra:aba", OPS],
        ["a19-effect-aba", "extra:liveDelta", 0],
        ["a19-effect-relink", "depWalk", 3 * OPS],
        ["a19-effect-relink", "extra:aba", OPS],
        ["a19-effect-relink", "extra:liveDelta", 0],
        // Fix round 1b (burst 33): the pull-side same-source relink
        // (pcSourceOnly), the stranger's body-run count (genNoBump; unchanged
        // by the F-b33-1 fix prototype, so it blesses no lost update) and
        // the link-reuse witness on every reader-disposed shape.
        ["a19-pull-relink", "depWalk", 3 * OPS],
        ["a19-pull-relink", "extra:aba", OPS],
        ["a19-pull-relink", "extra:liveDelta", 0],
        ["a19-pull-aba", "extra:zRuns", 2 * OPS],
        ["a19-effect-aba", "extra:zRuns", 2 * OPS],
        ["a19-pull-aba", "extra:linkGrowth", 0],
        ["a19-effect-aba", "extra:linkGrowth", 0],
        ["a19-effect-relink", "extra:linkGrowth", 0],
        ["a19-pull-relink", "extra:linkGrowth", 0],
        // Fix round 2b (burst 33): link IDENTITY -- the link the reader's
        // dispose freed is the very link its successor wired first (linkSame;
        // linkSecond, a free list that pushes the freed link second, reads 0).
        ["a19-pull-aba", "extra:linkSame", OPS],
        ["a19-effect-aba", "extra:linkSame", OPS],
        ["a19-effect-relink", "extra:linkSame", OPS],
        ["a19-pull-relink", "extra:linkSame", OPS],
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
