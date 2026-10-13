// visit-anchors.mjs
// The instrumentation half of visit-anatomy.mjs, split out so the anchor
// table and the source rewrite can be imported (and parity-pinned) without
// running the workload. Nothing here touches the filesystem, the clock or
// the engine: instrument(src) maps one engine source string to its
// counter-instrumented copy, or throws.
//
// FAIL-CLOSED CONTRACT (unchanged by the split): every anchor must occur
// exactly its expected number of times, the source must not already carry
// the counters, and no quoted relative import (see RELATIVE_IMPORT for the
// exact forms) may survive -- otherwise instrument() throws and the caller
// refuses to run (visit-anatomy exits 2). A drift
// Error carries `.drift`, one "<anchor>..." found Nx, expected Mx line per
// drifted anchor, in the format the tool prints.

/* -- counter map -------------------------------------------------------------- */
export const NAMES = [
    "cursorHit",      // 0  read fast path: cursor reused the existing link (x4 sites)
    "linkAlloc",      // 1  link actually WIRED (past allocateLink's abort + same-pass dedup)
    "linkFree",       // 2  freeLink entry (sever)
    "markStamp",      // 3  markDownstream stamped a node's markEpoch (first visit this write)
    "markEdge",       // 4  markDownstream walked one subscriber edge
    "scHit",          // 5  pullComputed CLEAN SHORT-CIRCUIT hit (the 1.5.0 markEpoch gate)
    "pullTotal",      // 6  pullComputed entries
    "pullCacheHit",   // 7  pullComputed same-globalVersion cache hit
    "recompute",      // 8  pullComputed actually re-ran the body
    "eqDispatch",     // 9  `const eq = node.equals` dispatch sites (x3)
    "effectExec",     // 10 executeEffect entries
    "depWalk",        // 11 dep-validation edges walked (pullComputed + executeEffect needsRun loops)
];
export const IDX = Object.fromEntries(NAMES.map((n, i) => [i, n]));
export const I = Object.fromEntries(NAMES.map((n, i) => [n, i]));

/* -- injection ---------------------------------------------------------------- */
// [anchor, replacement, expectedOccurrences]. Replacement PREPENDS the count
// so the anchor's own semantics are untouched.
const bump = (i) => `__VC[${i}]++; `;
export const EDITS = [
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
    // SINGLE-LINE anchor (2026-10): the A1.9 link-freed guards rewrote the
    // line AFTER the dep load differently in each walk (a pullMoved() call in
    // executeEffect, a block in pullComputed), so the old two-line anchor
    // found 0x and the tool refused to run. The load itself is still the
    // first statement of each loop body, once per edge walked -- the same
    // count. The occurrence check (2x) fails closed if either walk drops or
    // reshapes this exact 16-space line, or if a third walk reuses it
    // verbatim; a third walk written at a DIFFERENT indentation (or with a
    // different variable name) passes instrument() and its edges are NOT
    // counted.
    [`                const dep = link.source;`,
        `                ${bump(I.depWalk)}const dep = link.source;`, 2],
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
    [`const eq = node.equals;`,
        `${bump(I.eqDispatch)}const eq = node.equals;`, 3],
    [`function executeEffect(node) {`,
        `function executeEffect(node) { ${bump(I.effectExec)}`, 1],
];

// markEdge counts EDGES WALKED, but the anchor sits inside the epoch check --
// correction: it must count every loop iteration. The anchor above prepends
// the edge bump BEFORE `if (t.markEpoch ...)`, which executes once per edge
// walked: correct.

// A relative specifier left after the edits would resolve against the temp
// dir (a crash) or, rewritten back into a tree, bind a SECOND engine the
// counters cannot see. The only one the engine has (./Watch.js) is stripped
// above; a new one is drift, so refuse instead of rewriting it. Caught:
// `from "./`, `import("./` and bare `import "./` (either quote, ./ or ../).
// NOT caught: a template-literal import(`./x`) or new URL("./x",
// import.meta.url). Like any unrewritten specifier they resolve against the
// copy's dir: they fail when reached in visit-anatomy's empty temp dir, and
// would bind a sibling only in a caller dir that holds one.
export const RELATIVE_IMPORT = /\bfrom\s*["']\.{1,2}\/|\bimport\s*\(\s*["']\.{1,2}\/|\bimport\s*["']\.{1,2}\//;

// PURE: engine source in, instrumented source out. Throws (never returns a
// half-instrumented string) on a non-string, on an already-instrumented
// source (every counter would double), on anchor drift (Error .drift = one
// line per drifted anchor) and on a surviving relative import.
export function instrument(src) {
    if (typeof src !== "string") {
        throw new TypeError(`visit-anatomy: instrument(src) needs the engine source as a string, got ${src === null ? "null" : typeof src}`);
    }
    if (src.includes("__VC")) {
        throw new Error("visit-anatomy: source is already instrumented (__VC present) -- refusing to count twice");
    }
    let out = src;
    const drift = [];
    for (const [anchor, replacement, expected] of EDITS) {
        const n = out.split(anchor).length - 1;
        if (n !== expected) { drift.push(`"${anchor.slice(0, 48)}..." found ${n}x, expected ${expected}x`); continue; }
        out = out.split(anchor).join(replacement);
    }
    if (drift.length) {
        const e = new Error("visit-anatomy: INSTRUMENTATION ANCHORS DRIFTED -- refusing to run half-instrumented");
        e.drift = drift;
        throw e;
    }
    const rel = RELATIVE_IMPORT.exec(out);
    if (rel) {
        throw new Error(`visit-anatomy: relative import ${JSON.stringify(rel[0])} survives instrumentation -- unrewritten, it resolves against the copy's dir: a crash in an empty temp dir, an uninstrumented sibling module if that dir has one`);
    }
    return out;
}
