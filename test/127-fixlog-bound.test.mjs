// 127-fixlog-bound.test.mjs -- b242 XA1 B3: the cursor-repair log (fixLog) is bounded.
// Written from PLAN-XA1 ASSERTIONS A1-A4 (.handoff/b241/PLAN-XA1.md), NOT from running the head build. Oracle = the vendored frozen
// build test/fixtures/Signal-29731ff9.js (commit 2d2785d). Engine under test: env LS_ENGINE (abs path), default R/Signal.js.
// Every row names its must-fail builds: the FROZEN fixture (the bug) and/or a named CONTROL (a count-checked text edit of the engine
// under test, staged in os.tmpdir(); an anchor that does not match exactly once FAILS the row). Rows are expected RED on the frozen
// build; the head rows go green only once XA1 B1 lands. Heavy children run one at a time with --max-old-space-size=2048 (CI heap
// is smaller than a dev Mac). Retained-byte bounds are the plan's; no timing.
// Controls (PLAN-XA1 TASK 5): RF-DEL = repairCursor filter removed (the frozen line); RF-INV = its `!==` flipped to `===`;
// DF-DEL = dropCursors filter removed; TRUNC-DEL = `if (k === 1) fixLen = 0;` deleted; TRIM-D-DEL / TRIM-R-DEL = the
// `fixLog.length = 48;` of destroy() / reset() deleted; FLUSHCUR-DEL = destroy()'s `flushCur = null;` deleted.
// Deviation notes (measured by reasoning, see each row): the trim in reset()/destroy() and the k === 1 truncation make RF-DEL / DF-DEL
// invisible AFTER reset()/destroy() or in a depth-1 loop; their rows therefore read the heap BEFORE the trim, in a shape whose
// entries pile up inside one depth >= 2 frame (grow: afterFlush; d1 "deep" shape).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENG = process.env.LS_ENGINE || join(ROOT, "Signal.js");
const FROZ = join(HERE, "fixtures", "Signal-29731ff9.js");
const FROZW = join(HERE, "fixtures", "Watch-e0cf8a8d.js");
const FX = (n) => join(HERE, "fixtures", "b127", n);
const s8 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 8);
const engText = () => readFileSync(ENG, "utf8");
const frozText = () => readFileSync(FROZ, "utf8");
let seq = 0;
const load = (file) => import(pathToFileURL(file).href + "?b127=" + (seq++));

const STAGED = [];   // every staged dir; removed in the after() hook below
after(() => { for (const d of STAGED) rmSync(d, { recursive: true, force: true }); });
function stage(text, watch) {   // temp copy in os.tmpdir(); never touches R/Signal.js
    const dir = mkdtempSync(join(tmpdir(), "b127-")); STAGED.push(dir);
    writeFileSync(join(dir, "Signal.js"), text);
    copyFileSync(watch, join(dir, "Watch.js"));
    return join(dir, "Signal.js");
}
const stageEng = (text) => stage(text === undefined ? engText() : text, join(dirname(ENG), "Watch.js"));
const stageFroz = (text) => stage(text === undefined ? frozText() : text, FROZW);
// Count-checked text edit: `from` must match EXACTLY `n` times (default 1), else the row fails.
function plant(text, from, to, n = 1) {
    const c = text.split(from).length - 1;
    assert.equal(c, n, "anchor must match exactly " + n + " time(s), matched " + c + ": " + JSON.stringify(from.slice(0, 90)));
    return text.split(from).join(to);
}
const raw = (script, args, flags) => {
    const res = spawnSync(process.execPath, [...(flags || []), script, ...args], { encoding: "utf8", timeout: 300000, killSignal: "SIGKILL", maxBuffer: 1 << 28 });
    assert.equal(res.error, undefined, "child spawn error");
    assert.equal(res.signal, null, "child killed / timed out: " + res.signal + " " + String(res.stderr).slice(0, 300));
    assert.equal(res.status, 0, "child exit: " + String(res.stderr).slice(0, 400));
    return res;
};
const child = (script, args, flags) => JSON.parse(raw(script, args, flags).stdout.trim().split("\n").pop());
const t_diag = (m) => console.log("# " + m);
const HEAVY = ["--expose-gc", "--max-old-space-size=2048"];

// ---- anchors on the engine under test (post-B1 text, PLAN-XA1 SPEC; each count-checked to 1 by plant()) ----
const R_HEAD = "        if (cursorDepth > 1 && sLink.target !== currentObserver) { const n = fixLen; fixLog[n] = sLink; fixLog[n + 1] = nDep; fixLog[n + 2] = cursorDepth; fixLen = n + 3; }";
const R_FROZ = "        if (cursorDepth > 1) { const n = fixLen; fixLog[n] = sLink; fixLog[n + 1] = nDep; fixLog[n + 2] = cursorDepth; fixLen = n + 3; }";
const D_HEAD = "        if (cursorDepth > 1 && node !== currentObserver) {";
const D_FROZ = "        if (cursorDepth > 1) {";
const K1 = "        if (k === 1) fixLen = 0;\n";
const TRIM_D = "        fixLog.length = 48;\n        for (let i = 0; i < fixLog.length; i++) fixLog[i] = null;";
const TRIM_D_OFF = "        for (let i = 0; i < fixLog.length; i++) fixLog[i] = null;";
const TRIM_R = "finally { disposeDepth--; }\n        fixLog.length = 48;\n";
const TRIM_R_OFF = "finally { disposeDepth--; }\n";
const FC_ON = "        scopePinHead = null;   // SG2: scope pins likewise; armDepth is not zeroed here (R1bNZ)\n        flushCur = null;\n";
const FC_OFF = "        scopePinHead = null;   // SG2: scope pins likewise; armDepth is not zeroed here (R1bNZ)\n";
const CNT_FROM = "    function fixCursor(c, k) {\n        const n = fixLen;\n";
const CNT_TO = CNT_FROM + "        globalThis.__FX.calls++; globalThis.__FX.iters += n / 3;\n";
const counted = (text) => plant(text, CNT_FROM, CNT_TO);   // staged fixCursor call / scanned-entry counter
const RF_DEL = (t) => plant(t, R_HEAD, R_FROZ);
const RF_INV = (t) => plant(t, R_HEAD, R_HEAD.replace("!==", "==="));
const DF_DEL = (t) => plant(t, D_HEAD, D_FROZ);
const TRUNC_DEL = (t) => plant(t, K1, "");
const TRIM_D_DEL = (t) => plant(t, TRIM_D, TRIM_D_OFF);
const TRIM_R_DEL = (t) => plant(t, TRIM_R, TRIM_R_OFF);
const FLUSHCUR_DEL = (t) => plant(t, FC_ON, FC_OFF);

// ---- A1 shadow plant: the three inline restores (hot bodies, left byte-identical in the engine; only this STAGED copy is edited) ----
const RESTORE = "fixLen === 0 ? savedCur : (d === 0 ? (fixLen = 0, null) : (activeObserverCurrentDep = null, fixCursor(savedCur, d)))";
const RESTORE_SH = "fixLen === 0 ? globalThis.__SHchk(savedCur, d) : (d === 0 ? (fixLen = 0, globalThis.__SHchk(null, 0), null) : (activeObserverCurrentDep = null, fixCursor(globalThis.__SHchk(savedCur, d), d)))";
// filtered: side-log exactly the entries the head filters out (live-frame appends); all: side-log every depth > 1 append (control).
function shadow(text, all) {
    let t = plant(text, RESTORE, RESTORE_SH, 3);
    if (all) {
        t = plant(t, R_HEAD, "        if (cursorDepth > 1) globalThis.__SHadd(sLink, nDep, cursorDepth);\n" + R_HEAD);
        t = plant(t, D_HEAD, "        if (cursorDepth > 1) { for (let l = node.headDep; l !== null; l = l.nextDep) globalThis.__SHadd(l, null, cursorDepth); }\n" + D_HEAD);
    } else {
        t = plant(t, R_HEAD, R_HEAD + " else if (cursorDepth > 1) globalThis.__SHadd(sLink, nDep, cursorDepth);");
        t = plant(t, D_HEAD, "        if (cursorDepth > 1 && node === currentObserver) { for (let l = node.headDep; l !== null; l = l.nextDep) globalThis.__SHadd(l, null, cursorDepth); }\n" + D_HEAD);
    }
    return t;
}
const fuzz = (a, b, np, seed) => child(FX("fuzz-child.mjs"), [a, b, String(np), String(seed), "grow", "64", "256"]);

describe("b127 identity", () => {
    it("fixture Signal-29731ff9.js is 2d2785d (sha256/8 29731ff9), its Watch is e0cf8a8d, ASCII only; the engine under test loads", async () => {
        assert.equal(s8(FROZ), "29731ff9"); assert.equal(s8(FROZW), "e0cf8a8d");
        assert.ok(!/[^\x00-\x7F\u00D7\u00B5]/.test(frozText()));
        const S = await load(ENG); assert.equal(typeof S.createRegistry, "function");
    });
});

// A1 -- premise: the live-frame filter never changes behavior. 300 programs per seed, depth <= 5, self / ancestor / sibling disposes
// under suspended frames, untrack, runWithOwner, createRoot, cleanup disposes (child fuzz-child.mjs, mulberry32 seeded 32-bit).
describe("A1 premise fuzz (seeds 12345 and 777, 300 programs each)", () => {
    for (const seed of [12345, 777]) {
        it("seed " + seed + ": head vs frozen 0 diffs in the full trace; A/A frozen vs frozen copy 0 diffs (coverage floor 10000 trace lines)", () => {
            const aa = fuzz(stageFroz(), stageFroz(), 300, seed);
            assert.equal(aa.diffs, 0, "A/A"); assert.ok(aa.traceLines > 10000, "A/A coverage floor: " + aa.traceLines);
            const hd = fuzz(stageFroz(), stageEng(), 300, seed);
            assert.equal(hd.diffs, 0, "head vs frozen first=" + JSON.stringify(hd.first)); assert.equal(hd.traceLines, aa.traceLines);
        });
        it("seed " + seed + ": shadow copy (filtered entries kept in a side log, matched at every restore) 0 hits, with >= 1 filtered entry recorded; shadow-all control >= 1 hit", () => {
            const sh = fuzz(stageFroz(), stageEng(shadow(engText(), false)), 300, seed);
            assert.equal(sh.diffs, 0, "shadow copy changed behavior: " + JSON.stringify(sh.first));
            assert.ok(sh.adds >= 1, "coverage floor: the filter must have dropped >= 1 entry in 300 programs (adds " + sh.adds + ")");
            assert.equal(sh.hits, 0, "a filtered entry matched a restored cursor");
            const al = fuzz(stageFroz(), stageEng(shadow(engText(), true)), 300, seed);
            assert.ok(al.adds >= sh.adds && al.hits >= 1, "shadow-all control must hit: hits " + al.hits + " adds " + al.adds);
        });
    }
    it("control RF-INV (repairCursor filter `!==` -> `===`): >= 1 diff in 300 programs (seed 12345, else 777); control RF-DEL (frozen line): 0 diffs", () => {
        let d = fuzz(stageFroz(), stageEng(RF_INV(engText())), 300, 12345).diffs;
        if (d === 0) d = fuzz(stageFroz(), stageEng(RF_INV(engText())), 300, 777).diffs;
        assert.ok(d >= 1, "RF-INV must diverge from the frozen build: " + d);
        assert.equal(fuzz(stageFroz(), stageEng(RF_DEL(engText())), 300, 12345).diffs, 0, "RF-DEL is the frozen line: no diff");
    });
});

// A2 -- GC budget / high-water.
describe("A2 GC budget", () => {
    // grow: one depth-2 frame disposes 200000 of its own signals. Plan: retained after reset(): head < 256 KB vs frozen >= 4 MB (measured 7.0 MB).
    it("opus grow N = 200000: retained after reset() head < 256 KB, frozen >= 4 MB; head also < 256 KB right after the flush", () => {
        const h = child(FX("grow-child.mjs"), [stageEng(), "200000", "grow"], HEAVY);
        const f = child(FX("grow-child.mjs"), [stageFroz(), "200000", "grow"], HEAVY);
        assert.ok(f.retainedAfterResetB >= 4 * 1024 * 1024, "frozen after reset " + f.retainedAfterResetB);
        assert.ok(h.retainedAfterResetB < 256 * 1024, "head after reset " + h.retainedAfterResetB + " (frozen " + f.retainedAfterResetB + ")");
        assert.ok(h.retainedAfterFlushB < 256 * 1024, "head after flush " + h.retainedAfterFlushB);
    });
    it("control RF-DEL (repairCursor filter removed): grow retains >= 4 MB right after the flush (the trim of reset() hides it later), head < 256 KB", () => {
        const c = child(FX("grow-child.mjs"), [stageEng(RF_DEL(engText())), "200000", "grow"], HEAVY);
        assert.ok(c.retainedAfterFlushB >= 4 * 1024 * 1024, "RF-DEL after flush " + c.retainedAfterFlushB);
    });
    it("neon d1 (flat shape: 4000 self-disposing computeds x 20 deps): retained after destroy() head <= 160 KB, frozen >= 1 MB (this child: frozen 1,559,968 B post-destroy, head -501,760 B)", () => {
        const h = child(FX("d1-child.mjs"), [stageEng(), "flat"], HEAVY);
        const f = child(FX("d1-child.mjs"), [stageFroz(), "flat"], HEAVY);
        assert.ok(f.postDestroyB >= 1024 * 1024, "frozen post-destroy " + f.postDestroyB);
        assert.ok(h.postDestroyB <= 160 * 1024, "head post-destroy " + h.postDestroyB + " (frozen " + f.postDestroyB + ")");
    });
    // deep shape: children at depth 3 under a depth-2 frame built in the effect's first run (no k === 1 clear between them). Measured on this host:
    // head ~230 KB (baseline of the shape), DF-DEL ~2.2 MB (frozen 2,174,240 equals DF-DEL); so the gate is the DIFFERENCE >= 1 MB, not the plan's absolute 160 KB.
    it("control DF-DEL (dropCursors filter removed): d1 deep shape (4000 x 20 deps) retains >= 1 MB more than head before destroy()", () => {
        const h = child(FX("d1-child.mjs"), [stageEng(), "deep", "4000"], HEAVY);
        assert.ok(h.preDestroyB < 1024 * 1024, "head deep pre-destroy " + h.preDestroyB);
        const c = child(FX("d1-child.mjs"), [stageEng(DF_DEL(engText())), "deep", "4000"], HEAVY);
        t_diag("DF-DEL " + c.preDestroyB + " head " + h.preDestroyB);
        assert.ok(c.preDestroyB - h.preDestroyB >= 1024 * 1024, "DF-DEL pre-destroy " + c.preDestroyB + " vs head " + h.preDestroyB);
    });
    // quad: 3000 prebuilt computeds read inside the frame, one self-disposing signal each. Hand check: frozen scans 1..N entries at the N k=2
    // restores (sum 1..N = N(N+1)/2) plus N at E's k=1 restore: 3000 x 3001 / 2 + 3000 = 4,504,500 = 3000 x 3003 / 2 (the plan's measured value).
    it("opus quad N = 3000: head 0 fixCursor calls; frozen scans exactly 4,504,500 entries", () => {
        const h = child(FX("grow-child.mjs"), [stageEng(counted(engText())), "3000", "quad"], HEAVY);
        const f = child(FX("grow-child.mjs"), [stageFroz(counted(frozText())), "3000", "quad"], HEAVY);
        assert.equal(f.iters, 4504500, "frozen scanned entries (calls " + f.calls + ")");
        assert.equal(h.calls, 0, "head fixCursor calls (iters " + h.iters + ")");
        assert.equal(h.iters, 0);
    });
});

// A3 -- truncation at depth 1. Hand derivation: child i logs ONE entry (its c2 link to a, target c2 != live c3, depth 3). Frozen never
// clears inside the depth-1 frame, so c3's restore (k = 2) and c2's restore (k = 1) each scan i + 1 entries: sum ~ 2 * N^2 / 2 = 4,000,000
// for N = 2000 (>= 2,000,000). With the k === 1 clear each restore scans <= 1 entry: <= 2 * N = 4000 (<= 8000).
describe("A3 truncation", () => {
    const N = 2000;
    const expectTrace = Array.from({ length: N }, (_, i) => i + 2 * i + 7);   // c2 = a + b + c3 = i + 2i + 7, derived from the shape
    it("head <= 8000 total scans; frozen >= 2,000,000; trace equals the hand-derived values and frozen's", () => {
        const h = child(FX("trunc-child.mjs"), [stageEng(counted(engText())), String(N)]);
        const f = child(FX("trunc-child.mjs"), [stageFroz(counted(frozText())), String(N)]);
        assert.ok(f.iters >= 2000000, "frozen scans " + f.iters);
        assert.ok(h.iters <= 8000, "head scans " + h.iters + " (calls " + h.calls + ")");
        assert.deepEqual(f.trace, expectTrace, "frozen trace vs hand-derived");
        assert.deepEqual(h.trace, f.trace, "head trace vs frozen");
        assert.deepEqual([h.activeNodes, h.activeLinks], [f.activeNodes, f.activeLinks], "final stats vs frozen");
    });
    it("control TRUNC-DEL (`if (k === 1) fixLen = 0;` deleted): >= 2,000,000 scans, trace unchanged", () => {
        const c = child(FX("trunc-child.mjs"), [stageEng(counted(TRUNC_DEL(engText()))), String(N)]);
        assert.ok(c.iters >= 2000000, "TRUNC-DEL scans " + c.iters);
        assert.deepEqual(c.trace, expectTrace);
    });
});

// A4 -- trim and retention.
describe("A4 trim / retention", () => {
    const tr = (text, mode) => child(FX("trim-child.mjs"), [text, mode], HEAVY).retained;
    it("3b shape K = 10000 then reset(): head retains >= 200,000 B less than frozen; control TRIM-R-DEL within 50,000 B of frozen", () => {
        const f = tr(stageFroz(), "reset"), h = tr(stageEng(), "reset");
        assert.ok(f - h >= 200000, "frozen " + f + " head " + h + " diff " + (f - h));
        const c = tr(stageEng(TRIM_R_DEL(engText())), "reset");
        assert.ok(Math.abs(c - f) <= 50000, "TRIM-R-DEL " + c + " vs frozen " + f);
    });
    it("3b shape K = 10000 then destroy(): head retains >= 200,000 B less than frozen; control TRIM-D-DEL within 50,000 B of frozen", () => {
        const f = tr(stageFroz(), "destroy"), h = tr(stageEng(), "destroy");
        assert.ok(f - h >= 200000, "frozen " + f + " head " + h + " diff " + (f - h));
        const c = tr(stageEng(TRIM_D_DEL(engText())), "destroy");
        assert.ok(Math.abs(c - f) <= 50000, "TRIM-D-DEL " + c + " vs frozen " + f);
    });
    // Elements-kind probe, primary form: V8's own trace, window cut by mark.mjs transitions (V8 prints on its own stdio buffer).
    // The window also holds the pre-existing activeQueue PACKED_SMI -> PACKED lines in markDownstream (the frozen build prints them too), so the
    // assertion is on the fixLog sites only (destroy / reset / repairCursor / dropCursors / fixCursor); a pin below keeps the filter honest.
    const FIXFN = /in [~*]?(destroy|reset|repairCursor|dropCursors|fixCursor)\+/;
    const trans = (text) => {
        const res = raw(FX("elements-child.mjs"), [text], ["--trace-elements-transitions"]);
        const ls = res.stdout.split("\n"), ms = [];
        ls.forEach((l, i) => { if (l.includes("mark.mjs")) ms.push(i); });
        assert.ok(ms.length >= 2, "--trace-elements-transitions printed no mark.mjs marker lines (use the %HasFastPackedElements fallback row): " + ms.length + " of " + ls.length + " lines");
        const all = ls.slice(ms[0] + 1, ms[ms.length - 1]).filter((l) => l.includes("Signal.js"));
        return { all, fix: all.filter((l) => FIXFN.test(l)) };
    };
    it("NON-REGRESSION PIN (its frozen red is anchor-only; D-b240-7) elements probe (grow / destroy / regrow / reset / regrow x3, --trace-elements-transitions): 0 transitions on fixLog; every other Signal.js line is markDownstream (frozen shows the same); control (`fixLog[60] = null` after each trim) >= 1 HOLEY fixLog line", () => {
        const h = trans(stageEng()), f = trans(stageFroz());
        assert.deepEqual(h.fix, [], "head fixLog transitions");
        assert.ok(f.all.length >= 1 && f.all.every((l) => l.includes("markDownstream")), "frozen window: only markDownstream lines: " + JSON.stringify(f.all.slice(0, 3)));
        assert.ok(h.all.every((l) => l.includes("markDownstream")), "head window holds a non-markDownstream Signal.js line: " + JSON.stringify(h.all.filter((l) => !l.includes("markDownstream")).slice(0, 3)));
        const c = trans(stageEng(plant(engText(), "fixLog.length = 48;", "fixLog.length = 48; fixLog[60] = null;", 2)));
        assert.ok(c.fix.filter((l) => l.includes("HOLEY")).length >= 1, "control must print a HOLEY fixLog transition: " + JSON.stringify(c.all.slice(0, 3)));
    });
    // Fallback form (the plan's): staged copy exposes fixLog; %HasFastPackedElements under --allow-natives-syntax. Also pins the trim length.
    const EXPOSE_FROM = "    for (let i = 0; i < 48; i++) fixLog.push(null);\n";
    const packed = (text) => child(FX("packed-child.mjs"), [stageEng(plant(text, EXPOSE_FROM, EXPOSE_FROM + "    globalThis.__FIXLOG = fixLog;\n"))], ["--allow-natives-syntax"]).steps;
    it("elements fallback: the log is packed after every step and is 48 long after destroy() and reset(); control (`fixLog[60] = null` after the trim) is not packed", () => {
        const s = packed(engText());
        assert.deepEqual(s.map((x) => x.name), ["start", "grow1", "destroy", "regrow1", "reset", "regrow2", "regrow3", "regrow4"]);
        assert.ok(s.every((x) => x.packed), "head log not packed: " + JSON.stringify(s));
        assert.equal(s[0].len, 48); assert.ok(s[1].len >= 300, "grow1 length " + s[1].len);   // the nested tree logs 100 entries = 300 slots
        assert.equal(s[2].len, 48, "after destroy"); assert.equal(s[4].len, 48, "after reset");
        const c = packed(plant(engText(), "fixLog.length = 48;", "fixLog.length = 48; fixLog[60] = null;", 2));
        assert.ok(c.some((x) => !x.packed), "control must be non-packed: " + JSON.stringify(c));
    });
    it("1000 nest / dispose / reset cycles end with liveNodes 0 and activeNodes 0 (regression pin: the frozen build passes too)", () => {
        const h = child(FX("cycles-child.mjs"), [stageEng(), "1000"]);
        assert.deepEqual([h.cycles, h.liveNodes, h.activeNodes], [1000, 0, 0]);
    });
    // Heap snapshot: delta = ReactiveNode instances (flush + destroy build) - (same build, no flush). Shape "live": the effect is NOT stopped before
    // destroy() (stop() disposes the node, which nulls flushCur itself: shape "stop" shows delta 0 on every build). flushCur still names the last
    // flushed entry when the flush ends; frozen destroy() leaves it, so the node stays reachable: +1. Head nulls it: 0.
    it("heap-snapshot ReactiveNode count after one flush + destroy() (effect left live): head delta 0, frozen +1; control FLUSHCUR-DEL +1", () => {
        const delta = (text) => child(FX("snap-child.mjs"), [text, "flush", "live"], HEAVY).count - child(FX("snap-child.mjs"), [text, "ref", "live"], HEAVY).count;
        assert.equal(delta(stageFroz()), 1, "frozen");
        assert.equal(delta(stageEng()), 0, "head");
        assert.equal(delta(stageEng(FLUSHCUR_DEL(engText()))), 1, "FLUSHCUR-DEL");
    });
});
