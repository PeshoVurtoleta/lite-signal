// 123-broadcast-fix.test.mjs -- b215 G1 B2a: shape A (lazy cursor-repair log) + shape G (pre-walk already-fresh guard).
// Written from PLAN-b215 G1 ASSERTIONS 1-3 and the K4 / fail-closed semantics, NOT copied from the head build's output:
// rows 1a-1d are hand-derived (comment above each row); every other pinned list was measured on head b5289277 (node v26.8.2, untimed) and,
// PINS entries with fix: true are also deepEqual on the da5ddb86 fixture (afterDirty_* trivially: the fixture has no plant); 3b bounds head against the fixture. Engine under test: env LS_ENGINE (abs path),
// default R/Signal.js. Head-only rows are expected RED on the frozen before build (that red is the must-fail evidence).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { makeShapes } from "./fixtures/b123/shapes.mjs";
import { caseA, caseB, gtOvf, noclrOvf, noclrA, invariants, seq as seqIn, first, nest, destroyReuse, p6, noclrRR, G, gDel3b, s3Stale, afterDirty } from "./fixtures/b123/lower.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENG = process.env.LS_ENGINE || join(ROOT, "Signal.js");
const FIX = join(HERE, "fixtures", "Signal-da5ddb86.js");
const FIXW = join(HERE, "fixtures", "Watch-e0cf8a8d.js");
const s8 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 8);
let seq = 0;
const load = (file) => import(pathToFileURL(file).href + "?b123=" + (seq++));   // a load failure rejects -> the row FAILS
function stage(srcFile, text, watch) {   // temp copy in os.tmpdir(); never touches R/Signal.js
    const dir = mkdtempSync(join(tmpdir(), "b123-"));
    writeFileSync(join(dir, "Signal.js"), text);
    copyFileSync(watch || join(dirname(srcFile), "Watch.js"), join(dir, "Watch.js"));
    return join(dir, "Signal.js");
}
const T = "fixCursor(savedCur, d)";
// Count-checked plant: exactly 3 occurrences (one per site), one inside each of severStale / executeEffect / refreshComputed.
function plantText(text) {
    const pos = []; let i = -1; while ((i = text.indexOf(T, i + 1)) >= 0) pos.push(i);
    assert.equal(pos.length, 3, "plant: exactly 3 cold-arm `" + T + "` sites, found " + pos.length);
    const fn = { S: text.indexOf("function severStale("), E: text.indexOf("function executeEffect("), R: text.indexOf("function refreshComputed(") };
    for (const k in fn) assert.ok(fn[k] > 0, "plant: function " + k + " found");
    const site = pos.map((p) => Object.keys(fn).filter((k) => fn[k] <= p).sort((a, b) => fn[b] - fn[a])[0]);
    assert.deepEqual(site.slice().sort(), ["E", "R", "S"], "plant: one site in each of S / E / R");
    let out = "", last = 0;
    pos.forEach((p, k) => { out += text.slice(last, p) + "fixCursor(globalThis.__B123PL(\"" + site[k] + "\", savedCur), d)"; last = p + T.length; });
    return out + text.slice(last);
}
async function planted() {
    const f = stage(ENG, plantText(readFileSync(ENG, "utf8")));
    return load(f);
}
// b219: the plant also COUNTS every call per site (PL.cnt, never throws unless armed) and throws on its `at`-th armed call (default 1).
const PL = { armed: null, at: 1, fired: 0, calls: 0, cnt: { S: 0, E: 0, R: 0 } };
globalThis.__B123PL = (site, c) => { PL.cnt[site]++; if (site === PL.armed) { PL.calls++; if (PL.calls === PL.at) { PL.fired++; throw new RangeError("Maximum call stack size exceeded"); } } return c; };
async function run(shape) {
    const S = await planted(); PL.armed = null; PL.fired = 0; PL.calls = 0;
    const o = makeShapes(S, { arm: (s) => { PL.armed = s; } })[shape]();
    return { o, fired: PL.fired };
}
const OK = { thrown: null, thrown2: undefined, resetErr: null };

describe("b123 identity", () => {
    it("fixture Signal-da5ddb86.js is HEAD 46e301a Signal.js (sha256/8 da5ddb86) and its Watch is e0cf8a8d", () => {
        assert.equal(s8(FIX), "da5ddb86"); assert.equal(s8(FIXW), "e0cf8a8d");
        assert.equal(s8(join(HERE, "fixtures", "b123", "Signal-lsave-57f8beaa.js")), "57f8beaa");
        assert.ok(!/[^\x00-\x7F\u00D7\u00B5]/.test(readFileSync(FIX, "utf8")));
    });
    it("engine under test loads (a load failure is a FAIL)", async () => { const S = await load(ENG); assert.equal(typeof S.createRegistry, "function"); });
});

// ASSERTION 1 -- overflow fails closed. Hand derivation (K4 + the cold arm): the planted RangeError is thrown at the
// `fixCursor(savedCur, d)` call AFTER `activeObserverCurrentDep = null`, so the live cursor is null and the frame's epilogue
// (severStale) is skipped. A skipped sever leaves the frame's unread dep tail in place (list kept, not freed, not leaked);
// a null cursor makes later reads of the outer frame no-ops on its old tail (the tail it did not re-read is kept).
describe("ASSERTION 1 overflow fails closed (planted, once, count-checked)", () => {
    it("1a -R: C2 (d2) ends with unread tail x and disposes b; overflow at C2's restore: hit 1, no TypeError, C2 keeps [a,x], C1 keeps its unread tail, next write re-tracks exact, reset ok", async () => {
        const { o, fired } = await run("R");
        assert.equal(fired, 1);
        assert.equal(o.thrown2, undefined, "next write threw");
        assert.deepEqual(o.before, { C1: ["a", "C2", "b", "c", "d"], C2: ["a", "x"], E: ["s", "C1"] });
        assert.deepEqual([o.thrown, o.resetErr, o.audit[0] === o.audit[1]], [null, null, true]);
        assert.deepEqual(o.log, ["RangeError"]);
        assert.deepEqual(o.C1, ["a", "C2", "c", "d"]); assert.deepEqual(o.C2, ["a", "x"]); assert.deepEqual(o.E, ["s", "C1"]);
        assert.deepEqual(o.after, { C1: ["a", "C2", "c", "d"], C2: ["a", "x"], E: ["s", "C1"] });
    });
    it("1b -E: effect X (run at depth 2 inside C1, ends with tail y) disposes b; overflow at X's restore", async () => {
        const { o, fired } = await run("E");
        assert.equal(fired, 1);
        assert.equal(o.thrown2, undefined, "next write threw");
        assert.deepEqual([o.thrown, o.resetErr, o.audit[0] === o.audit[1], o.log], [null, null, true, ["RangeError"]]);
        assert.deepEqual([o.C1, o.X, o.E], [["a", "c", "d"], ["a", "y"], ["s", "C1"]]);
        assert.deepEqual(o.after, { C1: ["a", "c", "d"], X: ["a", "y"], E: ["s", "C1"] });
    });
    it("1c -S: severStale's onDisconnect disposes b of the suspended frame E then throws mid-walk; overflow at the S restore", async () => {
        const { o, fired } = await run("S");
        assert.equal(fired, 1);
        assert.equal(o.thrown2, undefined, "next write threw");
        // w was severed before its hook ran, w2 (the rest of the walk) is kept; E drops b (disposed) and keeps [a,C1,c]
        assert.deepEqual([o.thrown, o.resetErr, o.audit[0] === o.audit[1], o.log], [null, null, true, ["RangeError"]]);
        assert.deepEqual([o.C1, o.E], [["a", "w2"], ["a", "C1", "c"]]);
        assert.deepEqual(o.after, { C1: ["a", "w", "w2"], E: ["a", "C1", "c"] });
    });
    it("1d dirty log: the overflow at C2's restore leaves an entry above d; C1's restore still applies it to the outer E cursor (E keeps [s,C1,c], no dup, audit equal)", async () => {
        const { o, fired } = await run("Rd");
        assert.equal(fired, 1);
        assert.equal(o.thrown2, undefined, "next write threw");
        assert.deepEqual([o.thrown, o.resetErr, o.audit[0] === o.audit[1], o.log], [null, null, true, ["RangeError"]]);
        assert.deepEqual([o.C1, o.C2, o.E], [["a", "C2"], ["a", "x"], ["s", "C1", "c"]]);
        assert.deepEqual(o.after, { C1: ["a", "C2"], C2: ["a", "x"], E: ["s", "C1", "c"] });
    });
    // A-b217-1: an entry applied to frame k is lowered to k; a later frame at depth k+1 whose savedCur is the entry's recycled link is NOT repaired.
    // Input = the engine reviewer's case 2b (lower.mjs caseB). Expected trace measured (head === fixture); the mechanism is in the comment in lower.mjs:
    // E's phase-1 rerun logs the fix for s (E's cursor), D then re-walks the recycled link at depth 1 and K (depth 2) saves it: with the
    // entry lowered K's restore leaves it alone (D's 2nd run completes: D() = g1 3 + K 104 + f 10 = 117 in the direct read).
    // The same value is pinned on the da5ddb86 fixture. MU-NOLOWER (drop `fixLog[i + 2] = k;`) measured: [.., undefined, "run:9", 117, ..] (the
    // "run:9" line moves after the set), so it is killed by this row.
    const CASE_B = ["run:3", "run:230", undefined, "run:9", undefined, 117, "run:13", undefined, "L8 N9", "reset L0"];
    it("1e lowered entry: case 2b (recycled link re-walked at depth 1, K entered at depth 2 with savedCur === X) head AND fixture give the exact trace, ending reset L0 (kills MU-NOLOWER)", async () => {
        assert.deepEqual(caseB(await load(ENG)), CASE_B, "head");
        assert.deepEqual(caseB(await load(stageFix())), CASE_B, "fixture da5ddb86");
    });

    // 1f / 1h (A-b217-10 = D-b217-1 "Invariant + head pin"; 1h = PLAN A-b218-2): REACH MATRIX .handoff/b218/matrix cells P2 x MU-GT and
    // P2 x MU-NOCLR0. The row runs the input on the planted engine (plant hit exactly 1), then checks the fixture-free invariants of
    // lower.mjs invariants() BEFORE reset (subscriptions == last-run reads per effect; activeLinks == sum of forEachSource over every
    // handle, every effect included; one re-run per source write; reset() ok), then pins the exact trace MEASURED on head b5289277
    // (node v26.8.2; .handoff/b218/stage2/measure.mjs; the matrix probe traces minus the "fired" line and the tail; set() returns undefined).
    async function ovfRow(input) {
        const S = await planted(); PL.armed = null; PL.fired = 0; PL.calls = 0;
        const o = input(S, (s) => { PL.armed = s; });
        const trace = o.out.slice();
        assert.deepEqual([PL.fired, PL.calls], [1, 1], "plant hit exactly once");
        const inv = invariants(o);
        assert.deepEqual(inv.subs, [], "subscription set == last-run read set");
        assert.equal(inv.links[0], inv.links[1], "activeLinks vs the sum of forEachSource over every handle");
        assert.deepEqual(inv.once, [], "one re-run per source write");
        assert.deepEqual(inv.comp, [], "computed clause (no computeds in this input)");
        assert.equal(inv.reset, null, "reset()");
        return trace;
    }
    // MU-GT measured: E's sources [C2,trig] != last run [C2,s2,trig], activeLinks 8 vs sum 7, "E ran 0x on s2", run:122 missing.
    const GT_OVF = ["run:103", "run:117/RangeError", undefined, "run:122", undefined, "run:126", "run:127", 119, "run:131", undefined];
    it("1f dirty log left at level 2 by the overflow, a later frame at k === level with its cursor on the recycled link (gtOvf): invariants hold, exact head trace (kills MU-GT)", async () => {
        assert.deepEqual(await ovfRow(gtOvf), GT_OVF, "exact head trace");
    });
    // Precondition (the stale link X is reused as E2's u link): links are not visible through the public API (forEachSource yields
    // nodes, snapshot() carries no link identity), so no in-row check exists. Evidence it bites: the battery's MU-NOCLR0 result on this
    // row and the matrix pads 1..3 (X not reused: no diff). MU-NOCLR0 measured: E's sources [C1,trig] != last run [C1,t,trig],
    // activeLinks 7 == sum 7, "E ran 0x on t", "E:7" missing.
    const NOCLR_OVF = ["E2:1", "E:4", "E:3/RangeError", undefined, "E2:5", undefined, "E2:18", undefined, "E:7", undefined, "E2:19", undefined];
    it("1h stale entry across depth-0 trees after an overflow at the depth-1 restore (noclrOvf): invariants hold, exact head trace (kills MU-NOCLR0 without the GC lane)", async () => {
        assert.deepEqual(await ovfRow(noclrOvf), NOCLR_OVF, "exact head trace");
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// ASSERTION 2 -- shape G (pre-walk already-fresh guard) + differential fuzz + must-fail controls
const LSAVE = join(HERE, "fixtures", "b123", "Signal-lsave-57f8beaa.js");
const FUZZ = join(HERE, "fixtures", "b123", "fuzz-child.mjs");
const GCCH = join(HERE, "fixtures", "b123", "gc-child.mjs");
const fixText = () => readFileSync(FIX, "utf8");
const stageFix = () => stage(FIX, fixText(), FIXW);
const stageEng = (text) => stage(ENG, text === undefined ? readFileSync(ENG, "utf8") : text);
function child(args, flags) {
    const res = spawnSync(process.execPath, [...(flags || []), ...args], { encoding: "utf8", timeout: 180000, killSignal: "SIGKILL", maxBuffer: 1 << 26 });
    assert.equal(res.error, undefined, "child spawn error");
    assert.equal(res.signal, null, "child killed / timed out: " + res.signal + " " + String(res.stderr).slice(0, 300));
    assert.equal(res.status, 0, "child exit: " + String(res.stderr).slice(0, 400));
    return JSON.parse(res.stdout.trim().split("\n").pop());
}
const fuzz = (a, b, np, seed, pol, mn, ml) => child([FUZZ, a, b, String(np), String(seed), pol, String(mn || 64), String(ml || 256)]);

// Prewalk probe: the B0 method (R/audit/2026-11-19-hotpath-fable/work/probe-prewalk.mjs): count refreshComputed entries and
// already-fresh returns per write on a layered 8 x 64 graph, 50 writes after 3 settling writes.
const CNT_FROM = "    function refreshComputed(node, depth) {\n        if (node.evalVersion === globalVersion) return;";
const CNT_TO = "    function refreshComputed(node, depth) {\n        const C = globalThis.__b123cnt; C.calls++;\n        if (node.evalVersion === globalVersion) { C.fresh++; return; }";
async function prewalk(srcFile, srcText, watch, fanIn, build) {
    assert.equal(srcText.split(CNT_FROM).length - 1, 1, "count plant: exactly 1 refreshComputed entry anchor");
    const f = stage(srcFile, srcText.replace(CNT_FROM, CNT_TO), watch);
    globalThis.__b123cnt = { calls: 0, fresh: 0 };
    const M = await load(f);
    const r = M.createRegistry({ maxNodes: 1 << 16, maxLinks: 1 << 18 });
    const src = []; for (let i = 0; i < 64; i++) src.push(r.signal(i));
    if (build) { const w = build(r); for (let i = 0; i < 3; i++) w(i); const C = globalThis.__b123cnt; C.calls = 0; C.fresh = 0; for (let i = 0; i < 50; i++) w(100 + i); r.destroy(); return { calls: C.calls / 50, fresh: C.fresh / 50 }; }
    let prev = src;
    for (let l = 0; l < 8; l++) {
        const cur = [];
        for (let i = 0; i < 64; i++) { const ins = []; for (let k = 0; k < fanIn; k++) ins.push(prev[(i + k) % 64]); cur.push(r.computed(() => { let t = 0; for (let k = 0; k < ins.length; k++) t += ins[k](); return t; })); }
        prev = cur;
    }
    const last = prev; let sink = 0;
    r.effect(() => { let t = 0; for (let i = 0; i < last.length; i++) t += last[i](); sink = t; });
    for (let i = 0; i < 3; i++) src[0].set(i);
    const C = globalThis.__b123cnt; C.calls = 0; C.fresh = 0;
    for (let i = 0; i < 50; i++) src[0].set(100 + i);
    r.destroy();
    return { calls: C.calls / 50, fresh: C.fresh / 50 };
}
describe("ASSERTION 2 G + fuzz + controls", () => {
    // Source: R/.handoff/b215/evidence/prewalk.log (B0, 46e301a / da5ddb86, node v26.8.2): before 316 / 119 (fanIn 4), 750 / 385 (fanIn 8).
    it("2-before: the frozen fixture makes 316 / 750 calls with 119 / 385 already-fresh returns per write (B0 pin; guards the probe itself)", async () => {
        assert.deepEqual(await prewalk(FIX, fixText(), FIXW, 4), { calls: 316, fresh: 119 });
        assert.deepEqual(await prewalk(FIX, fixText(), FIXW, 8), { calls: 750, fresh: 385 });
    });
    // Expected head values: the research build t5-shapea-G (Fable fable-hotpath-8: pG calls 197.0 / 365.0, already-fresh 0).
    it("2a G: already-fresh pre-walk calls head 0 (before > 0); layered calls head 197 (fanIn 4) / 365 (fanIn 8)", async () => {
        assert.deepEqual(await prewalk(ENG, readFileSync(ENG, "utf8"), join(dirname(ENG), "Watch.js"), 4), { calls: 197, fresh: 0 });
        assert.deepEqual(await prewalk(ENG, readFileSync(ENG, "utf8"), join(dirname(ENG), "Watch.js"), 8), { calls: 365, fresh: 0 });
    });
    // Effect-site G (hand derivation): s -> c -> {E1, E2}. Per write E1's pre-walk refreshes c (1 call, body runs); E2's pre-walk then
    // meets c already fresh: before makes that call (2 calls, 1 already-fresh return); with G at the executeEffect pre-walk it is skipped (1 call, 0 fresh).
    const twoEffects = (r) => { const s = r.signal(0); const c = r.computed(() => s() + 1); r.effect(() => { c(); }); r.effect(() => { c(); }); return (v) => s.set(v); };
    it("2g-before: two effects on one computed: fixture makes 2 calls with 1 already-fresh return per write", async () => {
        assert.deepEqual(await prewalk(FIX, fixText(), FIXW, 0, twoEffects), { calls: 2, fresh: 1 });
    });
    it("2g G at the executeEffect pre-walk: two effects on one computed: head makes 1 call, 0 already-fresh returns per write (kills MU-NOG-E)", async () => {
        assert.deepEqual(await prewalk(ENG, readFileSync(ENG, "utf8"), join(dirname(ENG), "Watch.js"), 0, twoEffects), { calls: 1, fresh: 0 });
    });
    it("2b fuzz head vs fixture: 0 diffs / 2000 programs x {grow (seed 777), throw (seed 4242)}; A/A (fixture vs a copy) 0", () => {
        for (const [seed, pol] of [[777, "grow"], [4242, "throw"]]) {
            const aa = fuzz(stageFix(), stageFix(), 2000, seed, pol);
            assert.equal(aa.diffs, 0, "A/A " + pol); assert.ok(aa.traceLines > 100000, "A/A coverage floor");
            const hd = fuzz(stageFix(), stageEng(), 2000, seed, pol);
            assert.equal(hd.diffs, 0, "head vs fixture " + pol + " first=" + JSON.stringify(hd.first)); assert.equal(hd.traceLines, aa.traceLines);
        }
    });
    // maxNodes 20 / maxLinks 30 make capacity events real (the 64 / 256 default is inert: 0 catches, 0 growths). Pins: fixture run, node v26.8.2.
    it("2c capacity fuzz (maxNodes 20, maxLinks 30, 300 programs, seed 12345): grow = 46 pool growths, throw = 387 CapacityError catches (284 distinct); head vs fixture 0 diffs", () => {
        const g = fuzz(stageFix(), stageEng(), 300, 12345, "grow", 20, 30);
        assert.equal(g.diffs, 0, "grow first=" + JSON.stringify(g.first)); assert.equal(g.A.growths, 46); assert.equal(g.B.growths, 46);
        const t = fuzz(stageFix(), stageEng(), 300, 12345, "throw", 20, 30);
        assert.equal(t.diffs, 0, "throw first=" + JSON.stringify(t.first)); assert.deepEqual([t.A.catches, t.A.distinct], [387, 284]); assert.deepEqual([t.B.catches, t.B.distinct], [387, 284]);
    });
    // Research: Opus A/drv fuzz-nested, C vs lsave 7 / 300 divergent (seed 12345, first program 49); reproduced here on the fixture.
    it("2d must-fail control lsave (local save, no depth counter): 7 / 300 divergent from the fixture, first program 49, under grow and throw", () => {
        for (const pol of ["grow", "throw"]) {
            const f = child([FUZZ, stageFix(), stage(LSAVE, readFileSync(LSAVE, "utf8"), FIXW), "300", "12345", pol, "64", "256"]);
            assert.equal(f.diffs, 7, pol); assert.equal(f.first.p, 49, pol);
        }
    });
    it("2e must-fail control MU-NOLOG (A-b216-1: delete repairCursor's whole `if (cursorDepth > 1) { ... fixLen = n + 3; }` block): fuzz diverges from the fixture (>= 1 / 300)", () => {
        const text = readFileSync(ENG, "utf8"); const a = "if (cursorDepth > 1) { const n = fixLen; fixLog[n] = sLink; fixLog[n + 1] = nDep; fixLog[n + 2] = cursorDepth; fixLen = n + 3; }";
        assert.equal(text.split(a).length - 1, 1, "NOLOG anchor: exactly 1 match");
        const f = fuzz(stageFix(), stageEng(text.replace(a, "")), 300, 12345, "grow");
        assert.ok(f.diffs >= 1, "MU-NOLOG must diverge: " + f.diffs);
    });
    // A-b216-2: the --jitless real-overflow sweep (same child, same cells) on the fixture and on the engine: every cell classified,
    // and the engine's CORRUPT cells are a subset of the fixture's (pre-existing: freeLink -> repairCursor entry, at:R k=385..387).
    it("2f --jitless sweep (k 0..450, at + atp, shapes R E S Rd R+ E+ S+): every cell classified; engine CORRUPT cells subset of fixture CORRUPT cells", { skip: "A-b216-5: out of the gate until the site-set oracle is rebuilt (next burst)" }, () => {
        const SW = join(HERE, "fixtures", "b123", "sweep-child.mjs");
        const cells = (eng) => {
            const res = spawnSync(process.execPath, ["--jitless", "--stack-size=984", SW], { encoding: "utf8", timeout: 240000, killSignal: "SIGKILL", maxBuffer: 1 << 28,
                env: { ...process.env, B123_ENGINE: eng, B123_LINES: "[]", B123_KMAX: "450" } });
            assert.equal(res.error, undefined, "sweep spawn error"); assert.equal(res.signal, null, "sweep killed / timed out: " + res.signal);
            assert.equal(res.status, 0, "sweep exit: " + String(res.stderr).slice(0, 300));
            const out = JSON.parse(res.stdout); const corrupt = new Set(), census = {};
            assert.deepEqual(Object.keys(out).length, 14, "2 recursion shapes x 7 shapes");
            for (const key in out) {
                assert.equal(out[key].length, 451, key + ": every k swept");
                for (const x of out[key]) {
                    let cls;
                    if (x.err || !x.o) cls = "SETUPERR";
                    else if (x.other.filter((z) => z !== "Error:hook").length || x.o.audit[0] !== x.o.audit[1] || x.o.resetErr !== null) cls = "CORRUPT";
                    else cls = x.ranges > 0 ? "OVERFLOW" : "NORMAL";
                    assert.notEqual(cls, "SETUPERR", key + " k" + x.k + ": unclassified cell " + String(x.err));
                    census[cls] = (census[cls] || 0) + 1;
                    if (cls === "CORRUPT") corrupt.add(key + "@" + x.k);
                }
            }
            return { corrupt, census };
        };
        const b = cells(stageFix()), h = cells(stageEng());
        assert.ok(b.census.NORMAL > 0 && b.census.OVERFLOW > 0, "sweep covers success and overflow: " + JSON.stringify(b.census));
        for (const c of h.corrupt) assert.ok(b.corrupt.has(c), "new CORRUPT cell on the engine: " + c);
        assert.deepEqual([...b.corrupt].sort(), ["at:R@385", "at:R@386", "at:R@387"], "before CORRUPT cells (B2a-sweep.txt)");
    });
});

// ASSERTION 3 -- GC budget. The nested-dispose tree logs 100 entries (300 slots > 48): cycle 1 grows fixLog. The tree itself
// allocates handles every cycle (signals are created), so "0 scavenges" is not attainable; the gate is what cycles 2..1000
// RETAIN (a log that never clears, MU-NOCLR0, retains ~2.4 KB per cycle) and equality of GC counts with the fixture.
describe("ASSERTION 3 GC", () => {
    const FL = ["--expose-gc", "--single-threaded", "--max-old-space-size=256"];
    it("3a cycles 2..1000 retain < 131072 B total, end with 0 live nodes, and trigger the same scavenge count as the fixture", (t) => {
        const b = child([GCCH, stageFix(), "1000"], FL), h = child([GCCH, stageEng(), "1000"], FL);
        t.diagnostic("retained " + h.retainedBytes + " fixture " + b.retainedBytes);   // before the asserts: the battery records it (A-b217-5)
        assert.equal(h.cycles, 999); assert.equal(h.liveNodesAfterCycles, 0); assert.equal(h.activeNodes, 0);
        assert.ok(h.retainedBytes < 131072, "retained " + h.retainedBytes + " (fixture " + b.retainedBytes + ")");
        assert.ok(b.gcs.major >= 2 && h.gcs.major >= 2, "GC observer measured nothing");
        assert.equal(h.gcs.minor, b.gcs.minor, "minor GCs head vs fixture");
    });
});

// ASSERTION 1 (A-b217-4; b218 NIT) -- fixLog census. MU-NONULLCHK (drop fixCursor's `c !== null && `) is EQUIVALENT by construction:
// slots i % 3 === 0 below fixLen are written only from sLink (dereferenced in freeLink, never null) and the headDep loop's l (non-null),
// so a null c never matches a logged link (REACH MATRIX: nullLink 0 on 33 inputs). The census covers EVERY line that mentions fixLog:
// lines whose trimmed text starts with "//" are dropped (comment-only); every other line is whitespace-normalised and kept WHOLE (no
// trailing-comment stripping, so a "//" inside a string cannot hide a store). The sorted list must deepEqual the reviewed whitelist.
function fixLogLines(text) {
    return text.split("\n").filter((l) => l.includes("fixLog")).map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => !l.startsWith("//")).sort();
}
const FIXLOG_LINES = [
    "const fixLog = [];",
    "for (let i = 0; i < 48; i++) fixLog.push(null);",
    "if (cursorDepth > 1) { const n = fixLen; fixLog[n] = sLink; fixLog[n + 1] = nDep; fixLog[n + 2] = cursorDepth; fixLen = n + 3; }",
    "const n = fixLen; fixLog[n] = l; fixLog[n + 1] = null; fixLog[n + 2] = cursorDepth; fixLen = n + 3;",
    "for (let i = 0; i < fixLog.length; i++) fixLog[i] = null;",
    "if (fixLog[i + 2] > k) {",
    "if (c !== null && fixLog[i] === c) c = fixLog[i + 1];",
    "fixLog[i + 2] = k;",
].sort();
// The 4 forms that evaded the b217 regex census (engine review r2): each staged copy adds one line and must fail.
const EVADE = ["fixLog[n + 3] = null;", "fixLog[n]=null;", "fixLog.fill(null, 0, n);", "const u = \"//\"; fixLog[n] = null;"];
describe("ASSERTION 1 fixLog census", () => {
    it("1g every code line mentioning fixLog equals the whitelist (8 lines); staged copies adding each of the 4 r2 evading forms fail the census", () => {
        const text = readFileSync(ENG, "utf8");
        assert.deepEqual(fixLogLines(text), FIXLOG_LINES);
        const a = "    function repairCursor(sLink, nDep) {\n";
        assert.equal(text.split(a).length - 1, 1, "control anchor: exactly 1 match");
        // b219 (A-b218-5 NIT): destroy()'s `fixLen = 0;` must directly follow the null loop. In-row control: a copy without it fails the pin.
        const destroyTail = (tx) => { const ls = tx.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => l && !l.startsWith("//")); const i = ls.indexOf("for (let i = 0; i < fixLog.length; i++) fixLog[i] = null;"); return i < 0 ? null : ls[i + 1]; };
        assert.equal(destroyTail(text), "fixLen = 0;", "destroy: fixLen = 0; follows the null loop");
        const tail2 = "        for (let i = 0; i < fixLog.length; i++) fixLog[i] = null;\n        fixLen = 0;\n";
        assert.equal(text.split(tail2).length - 1, 1, "destroy tail control anchor: exactly 1 match");
        assert.notEqual(destroyTail(text.replace(tail2, () => "        for (let i = 0; i < fixLog.length; i++) fixLog[i] = null;\n")), "fixLen = 0;", "control (no fixLen = 0;) must fail the pin");
        for (const form of EVADE) {
            const mut = text.replace(a, () => "        " + form + "\n" + a);
            assert.notEqual(mut, text, "control changed the text: " + form);
            assert.notDeepEqual(fixLogLines(mut), FIXLOG_LINES, "control must fail the census: " + form);
        }
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// b219 STEP B (A-b219-3 / -4): rows that kill the ruled survivors of the mechanical mutant sweep (.handoff/b219/sweep, a2/A, a2/B).
// Inputs live in fixtures/b123/lower.mjs (ported from the A2 helpers' corpora). PINS = the exact head trace (JSON strings / values) and the
// cumulative per-site cold-arm call counts, MEASURED on head b5289277 (stepB/gen-pins.mjs); fix: true = the same input on the da5ddb86
// fixture (unplanted, arm() a no-op) gives the identical trace, asserted below. A trace pinned for an armed input (arm: seq_*_s1 / _r2,
// first_R_r2, noclrRR) is head-only: the fixture has no plant site. In the "head never arms" rows (1k) the plant never fires on head
// ("fired 0"); a mutant that takes the cold arm at depth 0 calls the plant, which then throws once and the trace moves.
const PINS = {
    "seq_SER_s1": { o: [4,null,"hook:4",null,"E1:4","E1:4",null,"C0:4",null,"C0:4","Nn:3","Nn:5",null,"Nn:13",null,"fired 0","E1:1004","E1:2004","E1:3004","Nn:2013","Nn:4013","Nn:6013","Nn:8013","Nn:10013","links 20/sum20","clause []","reset L0"], cnt: {"S":0,"E":0,"R":4}, fix: false },
    "seq_SRE_s1": { o: [4,null,"hook:4",null,"C0:4",null,"C0:4","E2:4","E2:4",null,"Nn:3","Nn:5",null,"Nn:13",null,"fired 0","E2:1004","E2:2004","E2:3004","Nn:2013","Nn:4013","Nn:6013","Nn:8013","Nn:10013","links 20/sum20","clause []","reset L0"], cnt: {"S":0,"E":0,"R":4}, fix: false },
    "seq_RES_r2": { o: ["C0:4",null,"C0:4","E1:4","E1:4",null,4,null,"hook:4",null,"Nn:3","Nn:5",null,"Nn:13",null,"fired 0","E1:1004","E1:2004","E1:3004","Nn:2013","Nn:4013","Nn:6013","Nn:8013","Nn:10013","links 20/sum20","clause []","reset L0"], cnt: {"S":0,"E":0,"R":4}, fix: false },
    "seq_RSE_r2": { o: ["C0:4",null,"C0:4",4,null,"hook:4",null,"E2:4","E2:4",null,"Nn:3","Nn:5",null,"Nn:13",null,"fired 0","E2:1004","E2:2004","E2:3004","Nn:2013","Nn:4013","Nn:6013","Nn:8013","Nn:10013","links 20/sum20","clause []","reset L0"], cnt: {"S":0,"E":0,"R":4}, fix: false },
    "first_R_r2": { o: ["C0:4",null,"C0:4","fired 0","links 4/sum4","clause []","reset L0"], cnt: {"S":0,"E":0,"R":1}, fix: false },
    "seq_RES_none": { o: ["C0:4",null,"C0:4","E1:4","E1:4",null,4,null,"hook:4",null,"Nn:3","Nn:5",null,"Nn:13",null,"fired 0","E1:1004","E1:2004","E1:3004","Nn:2013","Nn:4013","Nn:6013","Nn:8013","Nn:10013","links 20/sum20","clause []","reset L0"], cnt: {"S":0,"E":0,"R":4}, fix: true },
    "nest_dirtyE_none": { o: ["Ein:4","Ein:4",null,1,"fired 0","Ein:1004","Ein:2004","Ein:3004","links 4/sum4","clause []","reset L0"], cnt: {"S":0,"E":1,"R":1}, fix: true },
    "nest_dirtyR_none": { o: ["C0:4",null,"C0:4",1,"fired 0","links 5/sum5","clause [\"outer src C0in != last \"]","reset L0"], cnt: {"S":0,"E":0,"R":2}, fix: true },
    "nest_dirtyS_none": { o: [4,null,"hook:4",null,1,"fired 0","links 6/sum6","clause [\"outer src X0in != last \"]","reset L0"], cnt: {"S":1,"E":0,"R":2}, fix: true },
    "nest_clean_none": { o: ["Nin:3","Nin:5",null,"Nin:13",null,1,"fired 0","Nin:2013","Nin:4013","Nin:6013","Nin:8013","Nin:10013","links 7/sum7","clause []","reset L0"], cnt: {"S":0,"E":0,"R":0}, fix: true },
    "destroyReuse_R": { o: ["C0:4",null,"C0:4","destroyed","C0:4",null,"C0:4","after:3","{\"signals\":2,\"computeds\":2,\"effects\":0,\"activeLinks\":4,\"pooledLinks\":16380,\"linkPoolCapacity\":16384,\"nodePoolCapacity\":4096,\"nodePoolPopulation\":256,\"linkPoolPopulation\":1024,\"activeNodes\":4,\"totalAllocations\":5,\"totalDisposals\":1,\"poolGrowths\":0}"], cnt: {"S":0,"E":0,"R":2}, fix: true },
    "destroyReuse_E": { o: ["E0:4","E0:4",null,"destroyed","E1:4","E1:4",null,"after:3","{\"signals\":2,\"computeds\":1,\"effects\":1,\"activeLinks\":4,\"pooledLinks\":16380,\"linkPoolCapacity\":16384,\"nodePoolCapacity\":4096,\"nodePoolPopulation\":256,\"linkPoolPopulation\":1024,\"activeNodes\":4,\"totalAllocations\":5,\"totalDisposals\":1,\"poolGrowths\":0}"], cnt: {"S":0,"E":0,"R":2}, fix: true },
    "destroyReuse_S": { o: [4,null,"hook:4",null,"destroyed",4,null,"hook:4",null,"after:4","{\"signals\":5,\"computeds\":2,\"effects\":1,\"activeLinks\":5,\"pooledLinks\":16379,\"linkPoolCapacity\":16384,\"nodePoolCapacity\":4096,\"nodePoolPopulation\":256,\"linkPoolPopulation\":1024,\"activeNodes\":8,\"totalAllocations\":9,\"totalDisposals\":1,\"poolGrowths\":0}"], cnt: {"S":0,"E":0,"R":4}, fix: true },
    "p6Caught": { o: ["run:25","run:1025",null,"run:1031",null,"run:36",null,"L10 N8","reset L0"], cnt: {"S":0,"E":0,"R":3}, fix: true },
    "p6Uncaught": { o: ["run:25","run:12/boom",null,"run:18/boom",null,"run:36",null,"L10 N8","reset L0"], cnt: {"S":1,"E":0,"R":3}, fix: true },
    "caseA": { o: ["run:6","run:5",null,"run:11",null,"run:13",null,"L6 N5","reset L0"], cnt: {"S":0,"E":0,"R":2}, fix: true },
    "G_eff": { o: ["E:2","E:20",null,"E:22",null,"E:24",null,"E:26",null,"E:28",null,"E:30",null,"#RUNS C:7,E:7","E:2030","{\"subs\":[],\"links\":[2,2],\"once\":[\"C/s c:1,0\"],\"reset\":\"ok L0\"}"], cnt: {"S":0,"E":0,"R":0}, fix: true },
    "G_cc": { o: [3,21,23,25,27,29,31,"#RUNS C1:7,C2:7","{\"subs\":[],\"links\":[2,2],\"once\":[\"C1/s c:1,0\"],\"reset\":\"ok L0\"}"], cnt: {"S":0,"E":0,"R":0}, fix: true },
    "G_effcc": { o: ["E:3","E:21",null,"E:23",null,"E:25",null,"E:27",null,"E:29",null,"E:31",null,"#RUNS C1:7,C2:7,E:7","E:2031","{\"subs\":[],\"links\":[3,3],\"once\":[\"C1/s c:1,0\"],\"reset\":\"ok L0\"}"], cnt: {"S":0,"E":0,"R":0}, fix: true },
    "G_del3b": { o: ["C2body:1","E:4","E:2",null,null,null,"#RUNS C1:3,C2:1,E:2","C2body:1003","E:1002","{\"subs\":[],\"links\":[4,4],\"once\":[\"C1/s c:1,0\",\"C2/t c:1,0\",\"E/w e:1\"],\"reset\":\"ok L0\"}"], cnt: {"S":0,"E":0,"R":0}, fix: true },
    "S3": { o: ["E1:6","E1:5",null,0,"E2:0","E2:undefined",null,null,null,"#RUNS G:2,D:2,C:2,E1:2,Pm:2,E2:2","E1:2005","E1:4005","E1:5005","E1:7005","{\"subs\":[\"Pm []!=[\\\"G\\\"]\"],\"links\":[7,7],\"once\":[\"D/trig c:1,0\",\"C/trig c:1,0\",\"E1/s3 e:1\",\"E1/trig e:1\"],\"reset\":\"ok L0\"}"], cnt: {"S":0,"E":0,"R":3}, fix: true },
    "afterDirty_R": { o: ["{\"S\":0,\"E\":0,\"R\":0}"], cnt: {"S":0,"E":0,"R":1}, fix: true },
    "afterDirty_E": { o: ["{\"S\":0,\"E\":0,\"R\":0}"], cnt: {"S":0,"E":0,"R":1}, fix: true },
    "afterDirty_S": { o: ["{\"S\":0,\"E\":0,\"R\":0}"], cnt: {"S":0,"E":0,"R":2}, fix: true },
    "noclrRR_p0": { o: ["[\"C2:1\",\"C0:4\",\"C0:3/RangeError\",\"C2:5\",\"C2:18\",\"C0:7\",\"C2:19\",\"C0:11\"]","{\"subs\":[],\"links\":[8,8],\"once\":[],\"comp\":[],\"reset\":null}"], cnt: {"S":0,"E":0,"R":1}, fix: false },
    "noclrRR_p1": { o: ["[\"C2:1\",\"C0:4\",\"C0:3/RangeError\",\"C2:5\",\"C2:18\",\"C0:7\",\"C2:19\",\"C0:11\"]","{\"subs\":[],\"links\":[8,8],\"once\":[],\"comp\":[],\"reset\":null}"], cnt: {"S":0,"E":0,"R":1}, fix: false },
    "noclrRR_p2": { o: ["[\"C2:1\",\"C0:4\",\"C0:3/RangeError\",\"C2:5\",\"C2:18\",\"C0:7\",\"C2:19\",\"C0:11\"]","{\"subs\":[],\"links\":[8,8],\"once\":[],\"comp\":[],\"reset\":null}"], cnt: {"S":0,"E":0,"R":1}, fix: false },
    "noclrRR_p3": { o: ["[\"C2:1\",\"C0:4\",\"C0:3/RangeError\",\"C2:5\",\"C2:18\",\"C0:7\",\"C2:19\",\"C0:11\"]","{\"subs\":[],\"links\":[8,8],\"once\":[],\"comp\":[],\"reset\":null}"], cnt: {"S":0,"E":0,"R":1}, fix: false },
};
const IN = {
    seq_SER_s1: (S, c) => seqIn(S, c, "SER", "s1"), seq_SRE_s1: (S, c) => seqIn(S, c, "SRE", "s1"),
    seq_RES_r2: (S, c) => seqIn(S, c, "RES", "r2"), seq_RSE_r2: (S, c) => seqIn(S, c, "RSE", "r2"), first_R_r2: (S, c) => first(S, c, "R", "r2"),
    seq_RES_none: (S, c) => seqIn(S, c, "RES", "none"),
    nest_dirtyE_none: (S, c) => nest(S, c, "dirtyE", "none"), nest_dirtyR_none: (S, c) => nest(S, c, "dirtyR", "none"), nest_dirtyS_none: (S, c) => nest(S, c, "dirtyS", "none"), nest_clean_none: (S, c) => nest(S, c, "clean", "none"),
    destroyReuse_R: (S, c) => destroyReuse(S, c, "R"), destroyReuse_E: (S, c) => destroyReuse(S, c, "E"), destroyReuse_S: (S, c) => destroyReuse(S, c, "S"),
    p6Caught: (S, c) => p6(S, c, true), p6Uncaught: (S, c) => p6(S, c, false), caseA: (S) => caseA(S),
    G_eff: (S, c) => G(S, c, "eff", 2147483644), G_cc: (S, c) => G(S, c, "cc", 2147483644), G_effcc: (S, c) => G(S, c, "effcc", 2147483644), G_del3b: (S, c) => gDel3b(S, c),
    S3: (S, c) => s3Stale(S, c, { act: "self", two: true, pad: 0, after: false, drop: true, dup: false }),
    afterDirty_R: (S, c) => afterDirty(S, c, "R"), afterDirty_E: (S, c) => afterDirty(S, c, "E"), afterDirty_S: (S, c) => afterDirty(S, c, "S"),
};
for (let p = 0; p < 4; p++) IN["noclrRR_p" + p] = (S, c) => { const o = noclrRR(S, c, p); return [JSON.stringify(o.out), JSON.stringify(invariants(o))]; };
async function lrow(id) {   // head (planted, counting) run of one input; returns { o, cnt, fired }
    const S = await planted(); PL.armed = null; PL.at = 1; PL.fired = 0; PL.calls = 0; PL.cnt = { S: 0, E: 0, R: 0 };
    const ctl = { arm: (s, at) => { PL.armed = s; if (s !== null) { PL.at = at || 1; PL.calls = 0; } }, fired: () => PL.fired, cnt: () => ({ ...PL.cnt }) };
    const o = JSON.parse(JSON.stringify(IN[id](S, ctl)));   // undefined set() results become null, as in PINS
    return { o, cnt: { ...PL.cnt }, fired: PL.fired, calls: PL.calls };
}
async function fixRow(id) { const S = await load(stageFix()); return JSON.parse(JSON.stringify(IN[id](S, { arm() {}, fired: () => 0, cnt: () => ({ S: 0, E: 0, R: 0 }) }))); }
async function pinned(id) {   // head trace === PINS[id].o, and (fix: true) the da5ddb86 fixture gives the same trace
    const r = await lrow(id);
    assert.deepEqual(r.o, PINS[id].o, id + " head trace");
    if (PINS[id].fix) assert.deepEqual(await fixRow(id), PINS[id].o, id + " fixture da5ddb86");
    return r;
}
describe("b219 STEP B rows (kill the ruled sweep survivors)", () => {
    // 1j NOCLR0R (A-b218-5; sweep refreshComputed-L2472-DEL-2): noclrOvf with the depth-0 frame a top-level computed C0 and E2 a computed C2.
    // Invariants (links, once, COMPUTED clause: every computed's sources === its last completed run, a write re-runs it once, reset) + the exact head trace.
    // Without the depth-0 clear at the refreshComputed site C0 loses its t link ("C0:3/RangeError" twice, links 7/7).
    it("1j stale entry across depth-0 computed trees after an overflow at the depth-1 restore (noclrRR pads 0..3): invariants incl the computed clause, exact head trace (kills NOCLR0R)", async () => {
        for (let p = 0; p < 4; p++) {
            const id = "noclrRR_p" + p; const r = await lrow(id);
            assert.deepEqual([r.fired, r.calls], [1, 1], id + " plant hit exactly once");
            assert.deepEqual(r.o, PINS[id].o, id);
            const inv = JSON.parse(r.o[1]);
            assert.deepEqual([inv.subs, inv.once, inv.comp, inv.reset], [[], [], [], null], id + " invariants");
            assert.equal(inv.links[0], inv.links[1], id + " activeLinks vs sum");
        }
    });
    // 1k depth-0 arm rows (kill severStale-L1183 / refreshComputed-L2472 CMP-9, NUM-4, LOG-4, TERN-4): head never takes the cold arm at depth 0 on these
    // inputs (the plant armed at the S / R site never fires: "fired 0"); a mutant of the `d === 0 ?` arm calls the plant, which throws once.
    it("1k depth-0 arm: S-site (seq SER / SRE, plant armed S call 1) and R-site (seq RES / RSE, first R, plant armed R call 2) head traces never fire the plant", async () => {
        for (const id of ["seq_SER_s1", "seq_SRE_s1", "seq_RES_r2", "seq_RSE_r2", "first_R_r2"]) { const r = await pinned(id); assert.equal(r.fired, 0, id + " head never fires the plant"); }
        await pinned("seq_RES_none");
    });
    // 1l harness-artifact pins: the nest_dirtyR / nest_dirtyS pinned "clause [outer src ... != last ...]" lines (outer-frame reads recorded by the harness audit, not an engine claim).
    // 1l first tree (kill TAIL-L4004-NUM-1 / -2): a fresh registry's first dirty tree nested inside an outer computed (nest_dirtyE / R / S), and the same tree after destroy() on a used registry (destroyReuse).
    it("1l first-tree rows: nest_dirtyE / R / S on a fresh registry and destroyReuse R / E / S (after destroy()): exact head trace, same on the fixture (kills TAIL-L4004-NUM-1/-2)", async () => {
        for (const id of ["nest_dirtyE_none", "nest_dirtyR_none", "nest_dirtyS_none", "nest_clean_none", "destroyReuse_R", "destroyReuse_E", "destroyReuse_S"]) await pinned(id);
    });
    // 1m harness-artifact pin: the S3 input's `Pm []!=["G"]` entry (Pm's live sources [] vs the harness's recorded last-run reads ["G"], after G disposes itself) is pinned as-is.
    // 1m stale slot (kill dropCursors-L1215-DEL-2): tree 1 leaves a stale link in fixLog slot 0; tree 2's self-dispose of G must OVERWRITE it, else G's restore nulls Pm's live cursor.
    it("1m stale slot after a dirty tree: S3 (G disposes itself while Pm's cursor sits on the recycled link): exact head trace, same on the fixture (kills dropCursors-L1215-DEL-2)", async () => {
        await pinned("S3");
    });
    // 1n G across the int32 wrap (kill executeEffect-L2240-CMP-9 / refreshComputed-L2400-CMP-9 / executeEffect-L2240-DEL-3): clock seeded with snapshot() + restore({ ...snap, gv: 2147483644 }), 6 writes cross 2^31-1.
    it("1n pre-walk guard G: wrap rows G_eff / G_cc / G_effcc (gv 2147483644) and the break row G_del3b (C2 body runs once, not twice): exact head trace, same on the fixture", async () => {
        for (const id of ["G_eff", "G_cc", "G_effcc", "G_del3b"]) await pinned(id);
        assert.equal(PINS.G_del3b.o.filter((x) => String(x).startsWith("C2body:")).length, 2, "G_del3b: C2 body lines (1 initial + 1 after the write to t), none from the dropped re-pull");
    });
    // 1i (A-b219-4 = D-b219-1): per-site CALL counts of the cold-arm `fixCursor(savedCur, d)` (counting, non-throwing plant). Spec: a nested tree with no
    // logged fix and the first tree after a dirty tree of each root kind (effect / top-level computed / depth-0 severStale) and after destroy() make 0 calls
    // (the fast arm `fixLen === 0 ? savedCur` / the depth-0 clear); a logged fix makes >= 1 call at its site (reach). The other pins are the exact head counts.
    it("1i cold-arm call counts: 0 for a clean nested tree and for the clean tree after a dirty R / E / S tree; >= 1 where a fix is logged; exact head counts elsewhere", async () => {
        const clean = await lrow("nest_clean_none"); assert.deepEqual(clean.cnt, { S: 0, E: 0, R: 0 }, "clean nested tree");
        for (const k of ["R", "E", "S"]) { const r = await lrow("afterDirty_" + k); assert.deepEqual(JSON.parse(r.o[0]), { S: 0, E: 0, R: 0 }, "clean tree after dirty " + k); }
        assert.ok((await lrow("nest_dirtyE_none")).cnt.E >= 1, "reach E site (nested effect with a logged fix)");
        assert.ok((await lrow("nest_dirtyS_none")).cnt.S >= 1, "reach S site");
        assert.ok((await lrow("first_R_r2")).cnt.R >= 1, "reach R site");
        for (const id of ["nest_clean_none", "nest_dirtyE_none", "nest_dirtyR_none", "nest_dirtyS_none", "p6Caught", "p6Uncaught", "caseA", "seq_RES_none", "destroyReuse_R", "destroyReuse_E", "destroyReuse_S", "afterDirty_R", "afterDirty_E", "afterDirty_S", "S3"])
            assert.deepEqual((await lrow(id)).cnt, PINS[id].cnt, id + " per-site call counts");
    });
    // 1o (A-b219-7 attempt (a), fixCursor-L4009-CMP-5 `i < n` -> `i <= n`): tree 1 logs TWO entries (C1 disposes s0 then s) and the planted overflow at C1's
    // restore leaves both unlowered at level 2; the depth-0 restore clears fixLen, slots 3..5 keep (X, link(t), 2). Tree 2: E2's u link takes X, C3's re-run logs
    // exactly ONE entry (slot 0, fixLen 3) and C3's restore (k = 1) runs with E2's cursor === X: `<=` also reads the stale slots 3..5 (level 2 > 1, link === c) and
    // redirects E2's cursor into E's list: E loses its t subscription and the "E:7" run (mutant measured: subs / once / links 8 vs 9). Head trace measured on b5289277.
    // The computed clause is pinned, not asserted empty: on head it reports "C3 ran 2x then 2x on h" because the audit's write to h re-enters E2, which writes h again.
    it("1o stale unlowered entry exactly at slot fixLen (noclrA): plant hit 1, invariants, exact head trace (kills fixCursor-L4009-CMP-5)", async () => {
        const S = await planted(); PL.armed = null; PL.at = 1; PL.fired = 0; PL.calls = 0;
        const o = noclrA(S, (s) => { PL.armed = s; });
        const trace = JSON.parse(JSON.stringify(o.out));
        assert.deepEqual([PL.fired, PL.calls], [1, 1], "plant hit exactly once");
        const inv = invariants(o);
        assert.deepEqual(trace, ["E2:16", "E:9", "E:3/RangeError", null, "E2:20", null, "E2:25", null, "E:7", null, "E2:26", null], "exact head trace");
        assert.deepEqual([inv.subs, inv.once, inv.reset], [[], [], null], "subscription set == last-run read set; one re-run per write; reset");
        assert.equal(inv.links[0], inv.links[1], "activeLinks vs the sum of forEachSource");
        assert.deepEqual(inv.comp, ["C3 ran 2x then 2x on h"], "computed clause (pinned head artifact)");
    });
    // 3b (A-b219-3, destroy-L3242 CMP-1 / -3 / -4, DEL-1, DEL-2, LOG-1): destroy() releases the logged links. gc-child mode destroy: a registry logs 10,000 drop
    // entries (30,000 slots), destroy(), the api is held, gc: retained bytes (heapUsed after minus heapUsed before building; negative = the pools were released).
    // Measured (node v26.8.2, --expose-gc --single-threaded, 3 identical repeats): head -15150144, da5ddb86 fixture (no log) -15424168, head without the null loop
    // -14350400. So head retains 274024 B more than the fixture (the grown fixLog array itself) and a missing null loop 1074 KB more: the bound is 600000.
    // Teeth: the battery's MU-NONULLLOOP / sweep destroy-L3242-DEL-1 / DEL-2 (loop deleted) are killed by this row. (Comparing against the fixture, not a
    // staged copy of the engine under test, keeps the row independent of mutants that change what is logged: those are ruled behaviourally inert, A-b219-5.)
    it("3b destroy releases the logged links: 10,000 logged entries, destroy(), api held: head retains < 600000 B more than the da5ddb86 fixture", () => {
        const FL = ["--expose-gc", "--single-threaded", "--max-old-space-size=512"];
        const h = child([GCCH, stageEng(), "0", "destroy"], FL), f = child([GCCH, stageFix(), "0", "destroy"], FL);
        assert.equal(h.destroy, "ok"); assert.equal(f.destroy, "ok");
        assert.ok(h.retained - f.retained < 600000, "head retained " + h.retained + " vs fixture " + f.retained + " (diff " + (h.retained - f.retained) + ")");
    });
});
