// visit-anchors.mjs
// The instrumentation half of visit-anatomy.mjs, split out so the anchor
// table and the source rewrite can be imported (and parity-pinned) without
// running the workload. Nothing here touches the filesystem, the clock or
// the engine: instrument(src) maps one engine source string to its
// counter-instrumented copy, or throws.
//
// FAIL-CLOSED CONTRACT (unchanged by the split): every anchor must occur
// exactly its expected number of times, the source must not already carry
// the counters, and no module reference (see MODULE_REF for the exact forms)
// may survive -- otherwise instrument() throws and the caller refuses to run
// (visit-anatomy exits 2). A drift Error carries `.drift`, one
// "<anchor>..." found Nx, expected Mx line per drifted anchor, in the format
// the tool prints (CR / LF / U+2028 / U+2029 inside the 48-char label are
// escaped as \r / \n / \u2028 / \u2029, so every drift line is ONE line;
// the module-reference refusal escapes its quoted match the same way).
//
// Every exported table is frozen (NAMES, I, IDX, EDITS and each EDITS entry):
// an importer cannot retarget an anchor or a counter index for the next call.
// The module-reference check runs on a module-private RegExp (MODULE_REF_RE);
// the exported MODULE_REF is an informational frozen COPY, so mutating it
// (compile(), etc.) cannot change what instrument() refuses.

/* -- counter map -------------------------------------------------------------- */
export const NAMES = Object.freeze([
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
]);
export const IDX = Object.freeze(Object.fromEntries(NAMES.map((n, i) => [i, n])));
export const I = Object.freeze(Object.fromEntries(NAMES.map((n, i) => [n, i])));

/* -- injection ---------------------------------------------------------------- */
// [anchor, replacement, expectedOccurrences]. Replacement PREPENDS the count
// so the anchor's own semantics are untouched.
const bump = (i) => `__VC[${i}]++; `;
export const EDITS = Object.freeze([
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
        `                ${bump(I.markEdge)}if (t.markEpoch !== gv) { ${bump(I.markStamp)}`, 2],   // F-b33-1: markDownstream + its markDownstreamInEval twin
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
].map((e) => Object.freeze(e)));

// markEdge counts EDGES WALKED, but the anchor sits inside the epoch check --
// correction: it must count every loop iteration. The anchor above prepends
// the edge bump BEFORE `if (t.markEpoch ...)`, which executes once per edge
// walked: correct.

// The engine is single-file and zero-dependency: its one module reference
// (the ./Watch.js re-export) is stripped above, so ANY module reference left
// in the instrumented copy is drift. The specifier is never parsed (a relative
// one resolves against the copy's dir -- a crash in an empty temp dir, an
// uninstrumented sibling engine in a dir that holds one; a bare or absolute
// one loads a module the counters cannot see), so refuse on the keyword
// instead. Caught, with any run of whitespace, /* */ or // comments between
// the keyword and the next token (a // comment ends at ANY JS line
// terminator: LF, CR, U+2028 or U+2029 -- an LF-only pattern let
// `import //c<CR>("x")` load an uncounted module):
//   `import` followed by ( " ' ` . { or *   -- dynamic import(), bare
//       import "x", template import(`x`), import.meta (so new URL("x",
//       import.meta.url) too), import {a} / import * as ns
//   `from` followed by " or '               -- import a from "x",
//       export {a} / export * from "x" (escapes inside the specifier such as
//       ".\/x", "\x2e/x", "\u002e/x" do not matter: it is never read)
// Not after `from`: a backtick. A static specifier cannot be a template, and
// the engine's JSDoc says "from `x`" in prose (Signal.js:494, :654).
// NOT caught: code built at run time (eval / new Function over concatenated
// strings), process.getBuiltinModule(...), and realm patches to intrinsics
// (RegExp.prototype.exec, String.prototype.split / join,
// Function.prototype.call). NOTE (burst 33 ruling): instrument() calls the
// live RegExp.prototype.exec, split and join. Capturing exec at import would
// still leave split / join / call and anything patched BEFORE this module is
// imported open, so nothing is captured: an importer that patches the realm
// owns what instrument() returns.
// A future engine COMMENT that quotes an import (`import {x} from "y"`) is
// refused too -- intended: the fix is an EDITS strip, never a weaker pattern.
// instrument() uses MODULE_REF_RE, which is never exported. MODULE_REF is a
// frozen copy (same source and flags) for tests and tooling: it is
// informational only -- a frozen RegExp can still be re-pointed by
// RegExp.prototype.compile(), which is why no check reads it.
const MODULE_REF_RE = /\bimport\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n\r\u2028\u2029]*[\n\r\u2028\u2029]\s*)*[("'`.{*]|\bfrom\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n\r\u2028\u2029]*[\n\r\u2028\u2029]\s*)*["']/;
export const MODULE_REF = Object.freeze(new RegExp(MODULE_REF_RE));

// Every line this module emits stays ONE line: CR, LF and the two JS-only
// line terminators U+2028 / U+2029 (which JSON.stringify leaves raw) are
// escaped. Text without them is returned unchanged.
const oneLine = (t) => t.replace(/\r/g, "\\r").replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// PURE: engine source in, instrumented source out. Throws (never returns a
// half-instrumented string) on a non-string, on an already-instrumented
// source (every counter would double), on anchor drift (Error .drift = one
// line per drifted anchor) and on a surviving module reference (MODULE_REF_RE).
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
        if (n !== expected) {
            // oneLine() so a multi-line anchor (linkAlloc) still prints as ONE
            // drift line; single-line anchors print byte-identical to 2026-10-13.
            const label = oneLine(anchor.slice(0, 48));
            drift.push(`"${label}..." found ${n}x, expected ${expected}x`);
            continue;
        }
        out = out.split(anchor).join(replacement);
    }
    if (drift.length) {
        const e = new Error("visit-anatomy: INSTRUMENTATION ANCHORS DRIFTED -- refusing to run half-instrumented");
        e.drift = drift;
        throw e;
    }
    const ref = MODULE_REF_RE.exec(out);
    if (ref) {
        throw new Error(`visit-anatomy: module reference ${oneLine(JSON.stringify(ref[0]))} survives instrumentation -- the engine is single-file and zero-dependency, so any import / export-from / import() / import.meta left after the Watch.js strip is drift; refusing rather than load an uncounted module`);
    }
    return out;
}
