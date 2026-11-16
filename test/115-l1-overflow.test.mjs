/**
 * L-1 (burst 189, batch B2): a stack overflow inside a cold first read must not wedge the graph.
 *
 * Oracle: PLAN-L1.md ADDENDUM b187 (A1-A6 + K1 rows), written independently of the fix. The fix under test is Q-L1-1 option A
 * (D-b187-2): K1 (FLAG_COMPUTING set late; the four cleanup halves set it inside their own try) + 4a (throwComputedError resets a
 * node that served a stack-overflow RangeError to the never-evaluated shape, by property reads only, no instanceof).
 *
 * Engine under test: ../Signal.js, or the absolute path in env L1_SIGNAL (the mutant battery). The E2 reference is ALWAYS
 * test/fixtures/Signal-f6ff4cf3.js, a byte copy of the frozen build b6cdeca / f6ff4cf3 (CI has no .handoff/); the "fixture identity"
 * row fails the file unless its sha256/8 is f6ff4cf3 (the children do not check it).
 *
 * Row labels: RED = fails on the E2 fixture, passes on the fixed build. PIN = same on both. Named mutants a row kills are in the title.
 *
 * Grid geometry (test/fixtures/l1-child.mjs, B0's tools/grid.mjs): fresh registry + chain per pad; the top read runs inside
 * leaf.apply(null, ARGS[o]), o = 0..255 extra 8-byte args walk the overflow point over every offset of the level stride.
 * Chain length N = 8000 (not B0's 60000): the stack holds ~2150 levels jitless, ~3200 default, so every pad still overflows; the wedged
 * list of one cell was measured IDENTICAL at N 60000 and N 8000 (b189 B2), and N 8000 is 8x cheaper.
 * KNOWN list: test/fixtures/l1-known-f6ff4cf3.json, generated from the fixture run, pinned for its node version.
 *
 * Children (spawnSync): --max-old-space-size pinned (CI heap ~2 GB), SIGKILL timeout, and a killed / crashed child FAILS its row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_PATH = process.env.L1_SIGNAL || fileURLToPath(new URL("../Signal.js", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/Signal-f6ff4cf3.js", import.meta.url));
const CHILD_PATH = fileURLToPath(new URL("./fixtures/l1-child.mjs", import.meta.url));
const KNOWN_PATH = fileURLToPath(new URL("./fixtures/l1-known-f6ff4cf3.json", import.meta.url));
// A build with Watch.js beside it loads by file URL; the vendored fixture (no Watch.js) loads from text with its one re-export line removed
// (count-checked), through a data: URL, like test/114's MEM child.
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';
async function loadBuild(p) {
    if (existsSync(dirname(p) + "/Watch.js")) return import(pathToFileURL(p).href);
    const parts = readFileSync(p, "utf8").split(WATCH_LINE);
    assert.equal(parts.length, 2, "Watch re-export line matched " + (parts.length - 1) + " times");
    return import("data:text/javascript;base64," + Buffer.from(parts[0] + parts[1], "utf8").toString("base64"));
}
const M = await loadBuild(ENGINE_PATH);
const { createRegistry } = M;

const V8MSG = "Maximum call stack size exceeded";
const JSCMSG = "Maximum call stack size exceeded.";
const N_GRID = 8000;
const CHILD_TIMEOUT = 240000;
const HEAP = "--max-old-space-size=1536";

const fixtureSha8 = createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex").slice(0, 8);
const KNOWN = JSON.parse(readFileSync(KNOWN_PATH, "utf8"));

function child(flags, mode, args) {
    const r = spawnSync(process.execPath, [...flags, HEAP, CHILD_PATH, mode, JSON.stringify(args)], { encoding: "utf8", timeout: CHILD_TIMEOUT, killSignal: "SIGKILL", maxBuffer: 1 << 26, env: process.platform === "win32" ? process.env : {} });
    if (r.error) assert.fail("child " + mode + " error: " + r.error.message);
    if (r.signal !== null) assert.fail("child " + mode + " killed by " + r.signal);
    if (r.status !== 0) assert.fail("child " + mode + " exit " + r.status + ": " + String(r.stderr).slice(-400));
    const lines = r.stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
}
// The pad pattern is a function of the child's initial stack position (environment size, exec path: measured, b189 B2), which moves every
// offset by a constant delta. The pinned list is therefore compared up to that one shift: some delta in [-128, 128] must make the
// observed wedged / not-wedged flag of EVERY pad o in the 256-pad window equal the pinned flag of pad o + delta, over >= 128 overlapping pads.
// A build whose wedged set has a different content (not merely a different phase) matches no delta.
function knownShift(observed, known) {
    const obs = new Set(observed), kn = new Set(known);
    for (let d = -128; d <= 128; d++) {
        let n = 0, ok = true;
        for (let o = 0; o < 256 && ok; o++) { const p = o + d; if (p < 0 || p > 255) continue; n++; if (obs.has(o) !== kn.has(p)) ok = false; }
        if (ok && n >= 128) return d;
    }
    return null;
}
const CELLS = [];
for (const cfg of ["R1", "R2", "R5", "R6"]) for (const api of ["call", "box"]) CELLS.push({ cfg, api, key: cfg + "." + api });

describe("fixture identity", () => {
    it("the vendored E2 fixture is f6ff4cf3", () => { assert.equal(fixtureSha8, "f6ff4cf3"); });
});

// A1 invariants (b190, PLAN-L1 ADDENDUM b190): the first pre-write walk's error-read count b0 depends on the child's stack phase, and a V8
// serve-call overflow can leave 1-2 chain nodes un-reset (each holds a distinct never-served RangeError, served once, no wrong value). So:
//   I1 a SECOND pre-write walk reads 0 errors / wrong values on every pad; I3 every first-walk bad read is a RangeError !== the top error.
// ---- A1: the grid. Engine: 0 wedged. Fixture: pinned KNOWN list (jitless). ----
describe("A1 [RED] grid: 256 pads per cell, R1/R2/R5/R6 x call/box (kills NORESET)", () => {
    for (const tier of [{ name: "jitless", flags: ["--jitless"] }, { name: "default", flags: [] }]) {
        for (const c of CELLS) {
            it("engine " + tier.name + " " + c.key + ": 0 wedged, every pre-write error read is a distinct never-served RangeError, a second pre-write walk reads 0 errors", () => {
                const o = child(tier.flags, "grid", { path: ENGINE_PATH, cfg: c.cfg, api: c.api, o0: 0, o1: 255, N: N_GRID, walk2: true });
                assert.ok(o.overflowed >= 250, "coverage floor: " + o.overflowed + " of 256 pads overflowed");
                assert.deepEqual(o.wedged, []);
                assert.equal(o.walk2Bad, 0, "bad reads in the SECOND pre-write walk: " + o.walk2Bad + " max/pad " + o.walk2Max + " pads " + JSON.stringify(o.walk2Pads) + " (first-walk maxBefore " + o.maxBefore + " " + JSON.stringify(o.before) + ")");
                assert.equal(o.w1Wrong + o.w1NotRange + o.w1Top, 0, "first-walk bad reads that are wrong values " + o.w1Wrong + ", non-RangeError " + o.w1NotRange + ", === top error " + o.w1Top + " pads " + JSON.stringify(o.w1BadPads) + " (maxBefore " + o.maxBefore + " " + JSON.stringify(o.before) + ")");
            });
        }
    }
    for (const c of CELLS) {
        it("E2 fixture jitless " + c.key + ": >= 1 wedged, the full wedged list equals KNOWN (up to the stack-base shift)", () => {
            const o = child(["--jitless"], "grid", { path: FIXTURE_PATH, cfg: c.cfg, api: c.api, o0: 0, o1: 255, N: N_GRID });
            assert.ok(o.overflowed >= 250, "coverage floor: " + o.overflowed);
            assert.ok(o.wedged.length >= 1, "no wedged pad on the E2 fixture");
            if (process.version === KNOWN.node) { const d = knownShift(o.wedged, KNOWN.cells[c.key]); assert.notEqual(d, null, "wedged list " + JSON.stringify(o.wedged) + " matches KNOWN under no shift"); }
            else console.log("# UNPINNED node " + process.version + " (KNOWN is for " + KNOWN.node + "): exact-list check skipped, >= 1 wedged checked");
        });
    }
});

// ---- A2: no sweep. ----
describe("A2 [RED] no sweep: overflow, write, ONE top read at pad 0 never serves the same error object", () => {
    for (const tier of [{ name: "jitless", flags: ["--jitless"] }, { name: "default", flags: [] }]) {
        for (const api of ["call", "box"]) {
            it("engine " + tier.name + " R1." + api + ": 0 of the overflowed pads serve the same error object", () => {
                const o = child(tier.flags, "grid", { path: ENGINE_PATH, cfg: "R1", api, o0: 0, o1: 255, N: N_GRID, nosweep: true });
                assert.ok(o.overflowed >= 250, "coverage floor: " + o.overflowed);
                assert.equal(o.sameCached, 0);
                assert.equal(o.wrongValue, 0);
            });
            it("E2 fixture " + tier.name + " R1." + api + ": every overflowed pad serves the same error object", () => {
                const o = child(tier.flags, "grid", { path: FIXTURE_PATH, cfg: "R1", api, o0: 0, o1: 255, N: N_GRID, nosweep: true });
                assert.ok(o.overflowed >= 250, "coverage floor: " + o.overflowed);
                assert.equal(o.sameCached, o.overflowed);
            });
        }
    }
});

// ---- A3: predicate rows (planted throws, no real overflow), one row per read path. ----
const PATHS = {
    "c()": (r, fn) => r.computed(fn),
    "box.get()": (r, fn) => { const b = r.computedBox(fn); return () => b.get(); },
    "c.peek()": (r, fn) => { const h = r.computed(fn); return () => h.peek(); },
    "box.peek()": (r, fn) => { const b = r.computedBox(fn); return () => b.peek(); }
};
function reads(pathName, make, n) {   // body runs / outcomes over n reads at ONE globalVersion (no write between)
    const r = createRegistry({ maxNodes: 64, prealloc: "lazy" });
    let runs = 0;
    const read = PATHS[pathName](r, () => { runs++; throw make(); });
    const out = [];
    for (let i = 0; i < n; i++) { try { out.push({ v: read() }); } catch (e) { out.push({ e }); } }
    return { runs, out };
}
const isCycleErr = (e) => e instanceof Error && String(e.message).startsWith("CycleError");
describe("A3 predicate rows: a RangeError carrying the V8 / JSC overflow message is never served from cache", () => {
    for (const p of Object.keys(PATHS)) {
        it("[RED] " + p + ": body throwing RangeError(V8 msg) runs 2x over 2 reads, each read throws it", () => {
            const o = reads(p, () => new RangeError(V8MSG), 2);
            assert.equal(o.runs, 2);
            for (const x of o.out) { assert.ok(x.e instanceof RangeError && x.e.message === V8MSG); }
            assert.notEqual(o.out[0].e, o.out[1].e, "two runs, two error objects");
        });
        it("[RED] " + p + ": JSC message (trailing period) also runs 2x (kills NOJSC)", () => {
            const o = reads(p, () => new RangeError(JSCMSG), 2);
            assert.equal(o.runs, 2);
        });
        it("[PIN] " + p + ": RangeError('x') runs 1x over 3 reads, the same error object each time (kills CTORONLY)", () => {
            const o = reads(p, () => new RangeError("x"), 3);
            assert.equal(o.runs, 1);
            assert.ok(o.out[0].e instanceof RangeError && o.out[0].e.message === "x");
            assert.equal(o.out[1].e, o.out[0].e); assert.equal(o.out[2].e, o.out[0].e);
        });
        it("[PIN] " + p + ": TypeError with the V8 message runs 1x over 3 reads", () => {
            const o = reads(p, () => new TypeError(V8MSG), 3);
            assert.equal(o.runs, 1);
            assert.equal(o.out[1].e, o.out[0].e);
        });
        it("[PIN] " + p + ": a RangeError SUBCLASS with the V8 message runs 1x (constructor === RangeError is exact; kills INSTANCEOF)", () => {
            class MyRange extends RangeError {}
            const o = reads(p, () => new MyRange(V8MSG), 3);
            assert.equal(o.runs, 1);
        });
        for (const [name, val] of [["null", null], ["undefined", undefined], ["7", 7]]) {
            it("[PIN] " + p + ": thrown " + name + " is cached as before (1 run over 3 reads, the same value thrown)", () => {
                const o = reads(p, () => val, 3);
                assert.equal(o.runs, 1);
                for (const x of o.out) { assert.ok("e" in x); assert.ok(Object.is(x.e, val)); }
            });
        }
    }
    it("[PIN] a spy on RangeError[Symbol.hasInstance] is called 0x by a planted-overflow read (kills INSTANCEOF)", () => {
        let calls = 0;
        const orig = Function.prototype[Symbol.hasInstance];
        Object.defineProperty(RangeError, Symbol.hasInstance, { value(x) { calls++; return orig.call(this, x); }, configurable: true });
        try { reads("c()", () => new RangeError(V8MSG), 2); } finally { delete RangeError[Symbol.hasInstance]; }
        assert.equal(calls, 0);
    });
    it("[PIN] a catching parent of a planted-overflow child: 1 parent run and 1 child run per write+read, never a CycleError (kills MARKREADER)", () => {
        const r = createRegistry({ maxNodes: 64, prealloc: "lazy" });
        const s = r.signal(0); let childRuns = 0, parentRuns = 0; const seen = [];
        const child = r.computed(() => { childRuns++; s(); throw new RangeError(V8MSG); });
        const parent = r.computed(() => { parentRuns++; try { return child(); } catch (e) { seen.push(e); return "caught"; } });
        for (let i = 1; i <= 4; i++) {
            s.set(i);
            assert.equal(parent(), "caught");
            assert.equal(parentRuns, i, "parent runs after cycle " + i);
            assert.equal(childRuns, i, "child runs after cycle " + i);
        }
        assert.equal(seen.length, 4);
        for (const e of seen) { assert.ok(e instanceof RangeError && e.message === V8MSG, "the parent saw " + String(e)); assert.ok(!isCycleErr(e)); }
    });
});

// ---- A4: restore after an overflow; the exact reset record. ----
describe("A4 [RED] restore(snapshot()) succeeds after every overflow pad; the chain is exactly never-evaluated (kills RESETEV, NOVERSION, NOHASERR)", () => {
    for (const tier of [{ name: "jitless", flags: ["--jitless"] }, { name: "default", flags: [] }]) {
        it("engine " + tier.name + " R1.call: 256 pads", () => {
            const o = child(tier.flags, "a4", { path: ENGINE_PATH, N: N_GRID, o0: 0, o1: 255 });
            assert.ok(o.overflowed >= 250, "coverage floor: " + o.overflowed);
            assert.deepEqual(o.snapThrew, []);
            assert.deepEqual(o.restoreFailed, [], o.restoreMsg);
            assert.deepEqual(o.readWrong, []);
            // The top node c[N-1] always serves the overflow to the caller through throwComputedError: its record must be EXACTLY the
            // never-evaluated shape {version 0, evalVersion 0, clean false, value undefined, flags without HAS_ERROR / COMPUTING and equal
            // to a never-evaluated computed's in the same registry}. Deeper nodes that served their error to a parent are reset the same way;
            // the deepest ~90 nodes of the stack (measured 87-96, indices just above the overflow point) hold a cached error that no read
            // served (the bottom-up walk of A1 re-evaluates them off their changed dependencies, 0 wedged); cap on those: 160 (E2 fixture:
            // every node of the ~2150-level stack, measured 2150).
            assert.deepEqual(o.topBad, [], "top record not reset on pads " + JSON.stringify(o.topBad.slice(0, 20)) + ": " + o.topWhy);
            assert.ok(o.maxBad <= 160, "non-reset chain records on one pad: " + o.maxBad + " " + JSON.stringify(o.why));
        });
    }
    it("must-fail control: an evalVersion-only reset (RESETEV shape) makes restore throw a TypeError", () => {
        const o = child([], "resetev", { path: FIXTURE_PATH });
        assert.equal(o.restore, "threw");
        assert.equal(o.type, "TypeError");
        assert.match(o.msg, /invalid evalVersion 0 at index \d+ \(version 1: a computed is evaluated iff its version is not 0\)/);
    });
});

// Tooth helper (CI18): spawn like child() but with the given flags, returning the raw result (child() fails any non-zero exit).
function childRaw(flags, mode, args) {
    return spawnSync(process.execPath, [...flags, HEAP, CHILD_PATH, mode, JSON.stringify(args)], { encoding: "utf8", timeout: CHILD_TIMEOUT, killSignal: "SIGKILL", maxBuffer: 1 << 26, env: process.platform === "win32" ? process.env : {} });
}
function assertRefuses(mode, args) {
    const r = childRaw(["--expose-gc"], mode, args);
    assert.equal(r.error, undefined);
    assert.equal(r.signal, null);
    assert.equal(r.status, 3, "exit " + r.status + " stdout " + String(r.stdout).slice(0, 200));
    assert.ok(String(r.stderr).includes("GC modes need --single-threaded"), String(r.stderr).slice(-300));
    assert.equal(String(r.stdout).trim(), "", "a JSON line was printed");
}

// ---- A5: GC. ----
describe("A5 GC: 10,000 planted-overflow serve-and-re-run cycles allocate what the E2 reference allocates", () => {
    it("B/op of the engine equals the E2 fixture's (same child, interleaved windows); maxMajor 0; control exceeds the reference", () => {
        // A pre-allocated RangeError(V8 msg) is thrown by the body; each cycle is set(i) then a read (a re-run + serve + reset on the
        // engine, a re-run + cache on E2). Windows start after gc() + a settle, so a 10,000-cycle window (< 1 MB) holds no scavenge;
        // a window that saw any collection is discarded and counted. Gate: |eng - ref| <= 1 B/op.
        // Must-fail control: the same engine loop plus one `new Array(4)` per run.
        // CI class 18 (b193): the child runs --single-threaded and sums the JS heap spaces only (new / old / large-object), not heapUsed. On node 24 the
        // window driver's own throw/catch loop is OSR-recompiled in every window and allocated 6-9 B/cycle in BOTH builds (a plain throw loop: 17-19 B/op).
        // Measured b193 local: ref = eng = 0.396 B/op (3,960 B per 10,000-cycle window) on node 24.22.3 and 26.8.2; ctl 80.4. codeMoved is reported only.
        const o = child(["--expose-gc", "--single-threaded"], "gc", { eng: ENGINE_PATH, ref: FIXTURE_PATH, cycles: 10000, rounds: 6 });
        assert.equal(o.windowMajors, 0);
        assert.ok(o.n[0] >= 3 && o.n[1] >= 3 && o.n[2] >= 3, "too few clean windows " + JSON.stringify(o.n) + " discarded " + o.discarded);
        assert.ok(Math.abs(o.eng - o.ref) <= 1, "engine " + o.eng + " B/op vs reference " + o.ref + " (codeMoved " + o.codeMoved + ", reported only)");
        assert.ok(o.ctl - o.ref >= 16, "control " + o.ctl + " B/op did not exceed the reference " + o.ref);
    });
});

describe("A5 tooth (CI18)", () => {
    it("A5 tooth: the gc child refuses to measure without --single-threaded (exit 3)", () => {
        assertRefuses("gc", { eng: ENGINE_PATH, ref: FIXTURE_PATH, cycles: 1000, rounds: 1 });
    });
});

// ---- A6: retention. ----
describe("A6 retention: 64 overflow pads, each disposed", () => {
    it("[PIN] activeNodes 0, activeLinks 0, tracker size 0 on every pad", () => {
        const o = child(["--expose-gc"], "ret", { path: ENGINE_PATH, N: N_GRID, pads: 64 });
        assert.equal(o.pads, 64); assert.equal(o.noOverflow, 0);
        assert.deepEqual(o.badNodes, []); assert.deepEqual(o.badLinks, []); assert.deepEqual(o.badTracker, []);
    });
    it("[RED] a WeakRef to the reset node's error is cleared after gc, the registry and node alive (kills NOVALUE)", () => {
        const o = child(["--expose-gc"], "ret", { path: ENGINE_PATH, N: 100, pads: 1 });
        assert.equal(o.refClearedPlanted, true);
    });
});

// ---- K1 rows (original plan A2). ----
describe("K1: re-run cleanups", () => {
    it("[PIN] a re-run cleanup that reads its own computed caches a CycleError; the next write recovers", () => {
        const r = createRegistry({ maxNodes: 64, prealloc: "lazy" });
        const s = r.signal(1); let bodyRuns = 0;
        const c = r.computed(() => { bodyRuns++; r.onCleanup(() => { c(); }); return s() * 10; });
        assert.equal(c(), 10);
        s.set(2);
        let err = null; try { c(); } catch (e) { err = e; }
        assert.ok(isCycleErr(err), "read after the write threw " + String(err));
        assert.equal(bodyRuns, 1, "the body is skipped when its re-run cleanup throws");
        s.set(3);
        assert.equal(c(), 30);
        assert.equal(bodyRuns, 2);
    });
    // Borrowed, hand-derived rows of test/110 S1 (a write inside a re-run cleanup is not lost); PIN, test/110 is unchanged.
    it("[PIN] a write inside a throwing re-run cleanup re-queues the effect: seen [0,11,15]", () => {
        const r = createRegistry();
        const s = r.signal(0); const seen = [];
        r.effect(() => { seen.push(s()); r.onCleanup(() => { s.set(s.peek() + 10); throw new Error("cl"); }); });
        assert.throws(() => s.set(1), /^Error: cl$/);
        assert.throws(() => s.set(5), /^Error: cl$/);
        assert.deepEqual(seen, [0, 11, 15]);
    });
    it("[PIN] a write inside a throwing re-run cleanup of a computed: read 1 throws 'ccl', read 2 === 11, 2 body runs", () => {
        const r = createRegistry();
        const s = r.signal(0); let runs = 0;
        const c = r.computed(() => { runs++; const v = s(); r.onCleanup(() => { s.set(s.peek() + 10); throw new Error("ccl"); }); return v; });
        assert.equal(c(), 0);
        s.set(1);
        assert.throws(() => c(), /^Error: ccl$/);
        assert.equal(c(), 11);
        assert.equal(runs, 2);
    });
});

// ---- K1 survivors of the B1a battery (b189 round 2): found by differential probes vs the baseline (live + 4a) ----
const em = (x) => (x && x.message ? String(x.message).slice(0, 25) : String(x));
describe("K1 cleanup halves set COMPUTING (kills NOSET-*) and clear it on a throw (kills NOCLEAR-*)", () => {
    it("[PIN] NOSET-rerunCleanupEffect: a re-run cleanup that re-enters its own effect gets a CycleError, never a nested run", () => {
        const r = createRegistry(); const s = r.signal(0); let thunk = null; const log = [];
        r.effect(() => { log.push("b" + s()); r.onCleanup(() => { log.push("c"); try { thunk(); log.push("nested-ok"); } catch (x) { log.push("cl-threw:" + em(x)); } }); }, { scheduler: (t) => { thunk = t; t(); } });
        try { s.set(1); } catch (x) { log.push("set-threw:" + em(x)); }
        assert.ok(log.includes("cl-threw:CycleError: Infinite effe"), log.join(","));
        assert.ok(!log.includes("nested-ok"), log.join(","));
    });
    it("[PIN] NOSET-firstRunCleanupE: a pre-run cleanup of a never-run effect that re-enters the effect gets a CycleError, never a nested run", () => {
        const r = createRegistry(); const s = r.signal(0); let pend = null; const log = [];
        const e = r.effect(() => { log.push("b" + s()); }, { scheduler: (t) => { pend = t; } });
        r.runWithOwner(e, () => r.onCleanup(() => { log.push("c"); try { pend(); log.push("nested-ok"); } catch (x) { log.push("cl-threw:" + em(x)); } }));
        pend();
        assert.deepEqual(log, ["c", "cl-threw:CycleError: Infinite effe", "b0"]);
    });
    it("[PIN] NOSET-firstRunCleanupC: a pre-run cleanup of a never-run computed that reads it gets a CycleError; the body runs once", () => {
        const r = createRegistry(); const log = []; let runs = 0;
        const c = r.computed(() => { runs++; return 7; });
        r.runWithOwner(c, () => r.onCleanup(() => { log.push("c"); try { log.push("v" + c()); } catch (x) { log.push("cl-threw:" + em(x)); } }));
        assert.equal(c(), 7);
        assert.deepEqual(log, ["c", "cl-threw:CycleError: Circular depe"]);
        assert.equal(runs, 1);
        assert.equal(c(), 7);
    });
    it("[RED] NOCLEAR-firstRunCleanupC: chain with a pre-run cleanup on every node, jitless 256 pads: 0 wedged", () => {
        const o = child(["--jitless"], "pre", { path: ENGINE_PATH, N: N_GRID });
        assert.ok(o.ovf >= 250, "coverage floor: " + o.ovf);
        assert.deepEqual(o.wedged, []);
    });
    it("[RED] NOCLEAR-firstRunCleanupE / SET-EARLY-E: never-run effect with a pre-run cleanup run at the stack limit (jitless, 24000 pads, 160 overflow): no effect left CycleError-stuck", () => {
        const o = child(["--jitless"], "effsweep", { path: ENGINE_PATH, span: 1500, args: 16 });
        assert.ok(o.ovf >= 100, "coverage floor: " + o.ovf + " overflowed of " + o.pads);   // measured 160
        assert.equal(o.stuck, 0);
        assert.deepEqual(o.other, {});
    });
});

// ---- B1b survivors (b190): the reset statements of the overflow arm on the box.get() / c.peek() / box.peek() paths ----
// A planted V8-message RangeError (no real overflow) is served through ONE path; the snapshot record of that node must then be EXACTLY the
// never-evaluated record of a fresh computed of the same kind in the same registry: value undefined, version 0, evalVersion 0, clean false,
// HAS_ERROR (16) clear, flags equal to the reference's. Expected values come from the spec (PLAN-L1 A4: "exactly never-evaluated"), not a run.
// restore(snapshot()) must then succeed (a version != 0 with evalVersion 0 is refused as invalid).
describe("B1b survivors: planted overflow served through one path leaves the exact never-evaluated record (snapshot + restore)", () => {
    const SNAP_PATHS = {
        "box.get()": { box: true, mk: (b) => () => b.get(), kills: "VALUE@PULL, FLAGS@PULL, VERSION@PULL" },
        "c.peek()": { box: false, mk: (h) => () => h.peek(), kills: "VALUE@PEEK, FLAGS@PEEK, VERSION@PEEK" },
        "box.peek()": { box: true, mk: (b) => () => b.peek(), kills: "VALUE@PEEK, FLAGS@PEEK, VERSION@PEEK" }
    };
    for (const p of Object.keys(SNAP_PATHS)) {
        const P = SNAP_PATHS[p];
        it("[RED] " + p + ": record is exactly never-evaluated, restore succeeds (kills " + P.kills + ")", () => {
            const r = createRegistry({ maxNodes: 64, prealloc: "lazy" });
            const s = r.signal(1);
            const mkc = (fn) => (P.box ? r.computedBox(fn) : r.computed(fn));
            const ref = mkc(() => 0);
            const h = mkc(() => { s(); throw new RangeError(V8MSG); });
            let thrown = null;
            try { P.mk(h)(); } catch (e) { thrown = e; }
            assert.ok(thrown instanceof RangeError && thrown.message === V8MSG, "the read threw " + String(thrown));
            const snap = r.snapshot();
            const rec = snap.nodes.find((n) => n.id === r.nodeId(h));
            const refRec = snap.nodes.find((n) => n.id === r.nodeId(ref));
            assert.equal(rec.value, undefined);
            assert.equal(rec.version, 0);
            assert.equal(rec.evalVersion, 0);
            assert.equal(rec.clean, false);
            assert.equal(rec.flags & 16, 0, "FLAG_HAS_ERROR must be clear, flags " + rec.flags);
            assert.equal(rec.flags, refRec.flags);
            const ids = { h: r.nodeId(h), s: r.nodeId(s), ref: r.nodeId(ref) };
            const H = {};
            r.restore(snap, { fnsById: { [ids.ref]: () => 0, [ids.h]: () => { H[ids.s](); throw new RangeError(V8MSG); } }, handles: H });
        });
    }
});

// ======================================================================================================================================
// B1b' (S-EPOCH): pre-walk + own-finally windows. Oracle: PLAN-L1.md ADDENDUM b191 (A7) + ADDENDUM b191-2 (A7.1 markEpoch, A8, A8w, A9, A9h,
// A10a-d, A11, A12, A13), written from the repro setups, never from the engine's output. Floor formula (4a''): (gv - 0x3FFFFFFF) | 0, 0 -> -1.
// Must-fail refs: A7 red on ce8c8fed (no guard, no floor); A8 / A9 / A9h / A11 / A12 red on FIXCOMP (guard, no floor). A10c / A10d / A10e / A10f are KNOWN
// rows (e / f: the two gv at the int32 wrap edge of the overflow branch; FLOOR(-0x40000001) = -2^31, FLOOR(-0x40000002) = 0x7FFFFFFF): the accepted residual of D-b191-3 (a frame whose markAtWalk equals the floor still stamps over the reset: value undefined, X runs 0).
// ======================================================================================================================================
const FLOOR = (gv) => { const m = (gv - 0x3FFFFFFF) | 0; return m === 0 ? -1 : m; };
const tryRead = (f) => { try { return { v: f() }; } catch (e) { return { e }; } };
const showRes = (x) => ("e" in x) ? "threw " + (x.e instanceof Error ? x.e.constructor.name + ":" + x.e.message.slice(0, 20) : String(x.e)) : "value " + String(x.v);
const recOf = (r, h) => r.snapshot().nodes.find((n) => n.id === r.nodeId(h));
const gvOf = (r) => r.snapshot().gv;
// a fresh RangeError (V8 message) the body made AFTER `old`: an instance of RangeError, not `old`, and the body's latest
function assertNewOverflow(x, old, latest, what) {
    assert.ok("e" in x, what + ": expected a throw, got " + showRes(x));
    assert.ok(x.e instanceof RangeError && x.e.message === V8MSG, what + ": threw " + showRes(x));
    assert.notEqual(x.e, old, what + ": must be a NEW instance, not the first cached error");
    assert.equal(x.e, latest, what + ": must be the body's latest error");
}

// ---- A7 (b190 repro-sever2): a read of X from a hook inside X's own refresh finally ----
function w7(kind, hook) {
    const r = createRegistry({ maxNodes: 64 });
    const s = r.signal(0), t = r.signal(0);
    const o = { r, s, t, runs: 0, bodyErr: null, hookErr: null, armed: false, offs: [] };
    const box = kind === "boxget" || kind === "boxpeek" || kind === "effbox";
    const body = () => { o.runs++; if (s() === 0) { t(); return 1; } throw (o.bodyErr = new RangeError(V8MSG)); };
    const X = box ? r.computedBox(body) : r.computed(body);
    o.X = X;
    o.rd = (kind === "peek" || kind === "boxpeek") ? () => X.peek() : box ? () => X.get() : () => X();
    if (hook === "disc") o.offs.push(r.observeObservers(t, { onDisconnect: () => { try { X.peek(); } catch (e) { o.hookErr = e; } } }));
    else if (hook === "unc") o.offs.push(r.observeObservers(t, { onDisconnect: () => { X(); } }));
    else if (hook === "op4") o.offs.push(r.onGraphMutation((op) => { if (op === 4 && o.armed) { o.armed = false; try { X.peek(); } catch (e) { o.hookErr = e; } } }));
    return o;
}
const A7ROWS = [["A7.1", "call"], ["A7.2", "peek"], ["A7.3", "boxget"], ["A7.4", "boxpeek"]];
describe("B1b' (S-EPOCH): pre-walk + own-finally windows", () => {
    for (const [id, kind] of A7ROWS) {
        it("[RED ce8c8fed] " + id + " " + kind + ": a hook's X.peek() inside X's own finally throws the body error; read1 throws it; runs 2; the next read re-runs (runs 3, NEW RangeError)", () => {
            const o = w7(kind, "disc");
            o.rd(); o.s.set(1);
            const r1 = tryRead(o.rd);
            const e0 = o.bodyErr;
            assert.ok("e" in r1, "read1 must throw, got " + showRes(r1));
            assert.equal(r1.e, e0);
            assert.equal(o.hookErr, e0, "the hook's X.peek() threw something else");
            assert.equal(o.runs, 2);
            if (id === "A7.1") assert.equal(recOf(o.r, o.X).markEpoch, (gvOf(o.r) - 0x3FFFFFFF) | 0);
            const r2 = tryRead(o.rd);
            assertNewOverflow(r2, e0, o.bodyErr, id + " read2");
            assert.equal(o.runs, 3);
        });
    }
    for (const [id, kind] of [["A7.5", "eff"], ["A7.6", "effbox"]]) {
        it("[RED ce8c8fed] " + id + " " + kind + ": the effect body's read of X (hook peek inside X's finally): the effect sees the body error, hook threw it, runs 2, next read runs 3 with a NEW RangeError", () => {
            const o = w7(kind, "disc"); const seen = [];
            const dispose = o.r.effect(() => { o.s(); const x = tryRead(o.rd); if ("e" in x) seen.push(x.e); else seen.push({ value: x.v }); });
            assert.deepEqual(seen, [{ value: 1 }]);
            o.s.set(1);
            assert.equal(seen.length, 2);
            const e0 = o.bodyErr;
            assert.equal(seen[1], e0, "the effect's read must throw the body error, saw " + String(seen[1] && seen[1].value));
            assert.equal(o.hookErr, e0);
            assert.equal(o.runs, 2);
            const r2 = tryRead(() => (kind === "eff" ? o.X() : o.X.get()));
            assertNewOverflow(r2, e0, o.bodyErr, id + " read2");
            assert.equal(o.runs, 3);
            dispose();
        });
    }
    it("[RED ce8c8fed] A7.7 op-4: onGraphMutation(op 4) peek inside X's own finally behaves as A7.1 (hook threw e0, read1 throws e0, runs 2, read2 NEW RangeError, runs 3)", () => {
        const o = w7("call", "op4");
        o.rd(); o.s.set(1);
        o.armed = true;
        const r1 = tryRead(o.rd);
        const e0 = o.bodyErr;
        assert.ok("e" in r1, "read1 must throw, got " + showRes(r1));
        assert.equal(r1.e, e0);
        assert.equal(o.hookErr, e0);
        assert.equal(o.runs, 2);
        const r2 = tryRead(o.rd);
        assertNewOverflow(r2, e0, o.bodyErr, "A7.7 read2");
        assert.equal(o.runs, 3);
    });
    it("[RED ce8c8fed] A7.8 uncaught hook (c()): read1 throws the body error through the hook's unwind; read2 at the same gv throws it AGAIN (runs 2); no new instance", () => {
        const o = w7("call", "unc");
        o.rd(); o.s.set(1);
        const r1 = tryRead(o.rd);
        const e0 = o.bodyErr;
        assert.ok("e" in r1, "read1 must throw, got " + showRes(r1));
        assert.equal(r1.e, e0);
        assert.equal(o.runs, 2);
        const r2 = tryRead(o.rd);
        assert.ok("e" in r2, "read2 must throw, got " + showRes(r2));
        assert.equal(r2.e, e0, "read2 must serve the same cached error (ce8c8fed: a new instance, runs 3)");
        assert.equal(o.runs, 2);
    });
    it("[PIN] A7 retention: every A7 world disposed + listeners off -> activeNodes 0, activeLinks 0", () => {
        for (const [kind, hook] of [["call", "disc"], ["peek", "disc"], ["boxget", "disc"], ["boxpeek", "disc"], ["call", "op4"], ["call", "unc"]]) {
            const o = w7(kind, hook); o.rd(); o.s.set(1); o.armed = true; tryRead(o.rd); tryRead(o.rd);
            for (const off of o.offs) off();
            o.r.dispose(o.X); o.r.dispose(o.s); o.r.dispose(o.t);
            const st = o.r.stats();
            assert.equal(st.activeNodes, 0, kind + "/" + hook + " activeNodes");
            assert.equal(st.activeLinks, 0, kind + "/" + hook + " activeLinks");
        }
    });
    it("[PIN] A7.1 / A8 retention: 64 cycles each -> tracker size 0 after gc, activeNodes 0, activeLinks 0", () => {
        const o = child(["--expose-gc"], "ret2", { path: ENGINE_PATH, cycles: 64 });
        assert.equal(o.cycles, 64);
        assert.deepEqual(o.badNodes, []); assert.deepEqual(o.badLinks, []); assert.deepEqual(o.badTracker, []);
    });

// ---- A8 (b191 repro-prewalk): X holds an UNSERVED cached overflow e0; a hook in a DEP's finally serves + resets X mid-pre-walk ----
function w8(how, withD2) {
    const r = createRegistry({ maxNodes: 64 });
    const s = r.signal(0), t = r.signal(0), k = r.signal(0), u = r.signal(0), w = r.signal(0);
    const o = { r, s, t, k, u, w, runs: 0, bodyErr: null, hookErr: null, e0: null, readX: true, wroteInHook: false };
    const box = how.startsWith("box");
    const D = r.computed(() => { t(); if (k() === 0) u(); return 0; });
    const D2 = r.computed(() => { w(); return 0; });
    const xb = () => { o.runs++; D(); if (withD2) D2(); if (s() === 1) throw (o.bodyErr = new RangeError(V8MSG)); return 1; };
    const X = box ? r.computedBox(xb) : r.computed(xb);
    o.X = X; o.D = D; o.D2 = D2;
    const rx = () => (box ? X.get() : X());
    const Y = r.computed(() => (o.readX ? rx() : 0));
    o.off = r.observeObservers(u, { onDisconnect: () => { try { if (withD2) { w.set(w.peek() + 1); o.wroteInHook = true; } X.peek(); } catch (e) { o.hookErr = e; } } });
    assert.equal(Y(), 1); o.readX = false; s.set(1); assert.equal(Y(), 0); o.e0 = o.bodyErr;
    o.rd = (how === "peek" || how === "boxpeek") ? () => X.peek() : rx;
    o.Y = Y;
    return o;
}
const A8HOWS = [["call", "c()"], ["peek", "c.peek()"], ["boxget", "box.get()"], ["boxpeek", "box.peek()"]];
    for (const [how, label] of A8HOWS) {
        it("[RED FIXCOMP] A8 " + label + ": hook inside a dep's finally threw e0; read1 throws a NEW error (runs 3); read2 another NEW error (runs 4); X ends exactly reset with the floor", () => {
            const o = w8(how, false);
            assert.equal(o.runs, 2);
            o.k.set(1);
            const r1 = tryRead(o.rd);
            const e1 = o.bodyErr;
            assert.equal(o.hookErr, o.e0, "the hook's X.peek() must throw the cached e0");
            assertNewOverflow(r1, o.e0, e1, "read1");
            assert.equal(o.runs, 3);
            const r2 = tryRead(o.rd);
            assertNewOverflow(r2, o.e0, o.bodyErr, "read2");
            assert.notEqual(r2.e, e1, "read2 must be another new instance");
            assert.equal(o.runs, 4);
            const rec = recOf(o.r, o.X);
            assert.equal(rec.evalVersion, 0); assert.equal(rec.version, 0); assert.equal(rec.value, undefined); assert.equal(rec.clean, false);
            assert.equal(rec.markEpoch, FLOOR(gvOf(o.r)));
        });
    }
    it("[PIN] A8 retention: 64 worlds disposed -> activeNodes 0, activeLinks 0 (tracker size covered by the ret2 child row)", () => {
        for (let i = 0; i < 64; i++) {
            const o = w8("call", false); o.k.set(1); tryRead(o.rd); tryRead(o.rd);
            o.off();
            for (const h of [o.Y, o.X, o.D, o.D2]) o.r.dispose(h);
            for (const h of [o.s, o.t, o.k, o.u, o.w]) o.r.dispose(h);
            const st = o.r.stats();
            if (st.activeNodes !== 0 || st.activeLinks !== 0) assert.fail("world " + i + " activeNodes " + st.activeNodes + " activeLinks " + st.activeLinks);
        }
    });
    it("[PIN, kills DECR] A8w: a write (w.set) inside the onDisconnect hook before the peek: hook threw e0, read1 runs 3 and throws a NEW error", () => {
        const o = w8("call", true);
        assert.equal(o.runs, 2);
        o.k.set(1);
        const r1 = tryRead(o.rd);
        assert.equal(o.wroteInHook, true, "the hook's write must be allowed (hookErr " + String(o.hookErr) + ")");
        assert.equal(o.hookErr, o.e0);
        assertNewOverflow(r1, o.e0, o.bodyErr, "A8w read1");
        assert.equal(o.runs, 3);
    });
    // ---- A9 (b191 windows.mjs W-disc + W-op4): 2 hooks x 3 hook reads x 4 outer paths = 24 rows ----
    function w9(how, hook, hread) {
        const r = createRegistry({ maxNodes: 64 });
        const s = r.signal(0), t = r.signal(0), k = r.signal(0), u = r.signal(0);
        const o = { r, runs: 0, bodyErr: null, e0: null, hooks: [], armed: false, readX: true };
        const box = how.startsWith("box");
        const D = r.computed(() => { t(); if (k() === 0) u(); return 0; });
        const xb = () => { o.runs++; D(); if (s() === 1) throw (o.bodyErr = new RangeError(V8MSG)); return 1; };
        const X = box ? r.computedBox(xb) : r.computed(xb);
        const Z = r.computed(() => (box ? X.get() : X()));
        const rx = () => (box ? X.get() : X());
        const hookRead = () => { try { o.hooks.push({ v: hread === "chain" ? Z.peek() : hread === "peek" ? X.peek() : rx() }); } catch (e) { o.hooks.push({ e }); } };
        if (hook === "disc") r.observeObservers(u, { onDisconnect: () => { if (o.armed) hookRead(); } });
        else r.onGraphMutation((op) => { if (op === 4 && o.armed) { o.armed = false; hookRead(); o.armed = true; } });
        const Y = r.computed(() => (o.readX ? rx() : 0));
        Y(); o.readX = false; s.set(1); Y(); o.e0 = o.bodyErr;
        o.armed = true; k.set(1);
        o.rd = (how === "peek" || how === "boxpeek") ? () => X.peek() : rx;
        return o;
    }
    for (const hook of ["disc", "op4"]) for (const hread of ["call", "peek", "chain"]) for (const how of ["call", "peek", "boxget", "boxpeek"]) {
        it("[RED FIXCOMP] A9 W-" + hook + "/" + hread + " outer " + how + ": the hook threw e0; read1 and read2 throw NEW errors; runs 4", () => {
            const o = w9(how, hook, hread);
            assert.equal(o.runs, 2);
            const r1 = tryRead(o.rd); const e1 = o.bodyErr;
            o.armed = false;
            assert.ok(o.hooks.length >= 1, "the hook never ran");
            assert.ok("e" in o.hooks[0], "the hook's read did not throw: value " + String(o.hooks[0].v));
            assert.equal(o.hooks[0].e, o.e0, "the hook must see the cached e0");
            assertNewOverflow(r1, o.e0, e1, "read1");
            const r2 = tryRead(o.rd);
            assertNewOverflow(r2, o.e0, o.bodyErr, "read2");
            assert.notEqual(r2.e, e1);
            assert.equal(o.runs, 4);
        });
    }
    // ---- A9h (repro-a9h): a serve of X from a DEP'S BODY during X's pre-walk ----
    for (const box of [false, true]) {
        it("[RED FIXCOMP] A9h " + (box ? "box" : "fn") + ": P's body peeks X mid-walk: P caught e0, read1 throws a NEW error, runs 3", () => {
            const r = createRegistry({ maxNodes: 64 });
            const s = r.signal(0), k = r.signal(0);
            let armed = false, readX = true, runs = 0, bodyErr = null, pCaught = null, X = null;
            const C = r.computed(() => { if (k() === 1) r.dispose(C); return 0; });
            const P = r.computed(() => { C(); if (armed) { try { X.peek(); } catch (e) { pCaught = e; } } return 0; });
            const xb = () => { runs++; P(); if (s() === 1) throw (bodyErr = new RangeError(V8MSG)); return 1; };
            X = box ? r.computedBox(xb) : r.computed(xb);
            const Y = r.computed(() => (readX ? (box ? X.get() : X()) : 0));
            assert.equal(Y(), 1); readX = false; s.set(1); assert.equal(Y(), 0);
            const e0 = bodyErr;
            assert.equal(runs, 2);
            armed = true; k.set(1);
            const r1 = tryRead(box ? () => X.get() : () => X());
            assert.equal(pCaught, e0, "P's peek must throw the cached e0");
            assertNewOverflow(r1, e0, bodyErr, "read1");
            assert.equal(runs, 3);
        });
    }
    // ---- A10: far-from-zero stamps. Every nonzero version / evalVersion / markEpoch is shifted by delta (|0), none may land on 0; gv is set. ----
    function shiftSnap(snap, delta, gv, over) {
        const nodes = snap.nodes.map((n) => {
            const m = Object.assign({}, n);
            for (const f of ["version", "evalVersion", "markEpoch"]) if (n[f] !== 0) { const x = (n[f] + delta) | 0; if (x === 0) throw new Error("shift landed on 0: " + f + " of node " + n.id); m[f] = x; }
            if (over && n.id === over.id) m.markEpoch = over.me;
            m.clean = m.evalVersion !== 0 && ((m.markEpoch - m.evalVersion) | 0) <= 0;
            return m;
        });
        return Object.assign({}, snap, { nodes, gv });
    }
    function simpleShifted(gv) {
        const r = createRegistry({ maxNodes: 64 });
        const s = r.signal(1), X = r.computed(() => { s(); throw new RangeError(V8MSG); });
        const snap = shiftSnap(r.snapshot(), (gv - r.snapshot().gv) | 0, gv);
        const H = {}, ids = { s: r.nodeId(s), X: r.nodeId(X) };
        const rr = createRegistry({ maxNodes: 8 }).restore(snap, { fnsById: { [ids.X]: () => { H[ids.s](); throw new RangeError(V8MSG); } }, handles: H });
        return { rr, X: H[ids.X] };
    }
    for (const [id, gv, want] of [["A10a", 0x3FFFFFFF, -1], ["A10b", -0x7FFFFF00, 0x40000101]]) {
        it("[RED FIXCOMP] " + id + ": a simple serve-and-reset at gv " + gv + " stamps markEpoch " + want + (id === "A10a" ? " (the 0 -> -1 guard; kills NOZERO)" : " (the int32 wrap; kills NOINT32)"), () => {
            const o = simpleShifted(gv);
            assert.equal(gvOf(o.rr), gv);
            const x = tryRead(() => o.X());
            assert.ok(x.e instanceof RangeError && x.e.message === V8MSG, showRes(x));
            assert.equal(gvOf(o.rr), gv);
            const rec = recOf(o.rr, o.X);
            assert.equal(rec.markEpoch, want);
            assert.equal(rec.evalVersion, 0); assert.equal(rec.version, 0); assert.equal(rec.clean, false);
        });
    }
    function ids8(o) { const n = (h) => o.r.nodeId(h); return { s: n(o.s), t: n(o.t), k: n(o.k), u: n(o.u), w: n(o.w), D: n(o.D), D2: n(o.D2), X: n(o.X), Y: n(o.Y) }; }
    function restore8(snap, ids, ctr) {
        const H = {};
        const fns = {
            [ids.D]: () => { H[ids.t](); if (H[ids.k]() === 0) H[ids.u](); return 0; },
            [ids.X]: () => { ctr.runs++; H[ids.D](); if (H[ids.s]() === 1) throw (ctr.bodyErr = new RangeError(V8MSG)); return 1; },
            [ids.D2]: () => { H[ids.w](); return 0; },
            [ids.Y]: () => 0
        };
        return { rr: createRegistry({ maxNodes: 8 }).restore(snap, { fnsById: fns, handles: H }), H };
    }
    for (const [id, gv, me] of [["A10c", 0x50000000, 0x10000001], ["A10d", -0x7FFFFF00, 0x40000101],
        ["A10e", -0x40000001, -0x80000000], ["A10f", -0x40000002, 0x7FFFFFFF]]) {
        it("[KNOWN] " + id + ": accepted residual (D-b191-3): markAtWalk equals the floor at gv " + gv + " -> read1 and read2 value undefined, X runs 0 (kills " + (id === "A10e" ? "BOUND (g <= -0x40000001 stores 2^31)" : id === "A10f" ? "BOUNDLO (g < -0x40000002 stores -0x80000001)" : "EPOCH0" + (id === "A10d" ? ", NOINT32" : "")) + ")", () => {
            const o = w8("call", false);
            o.k.set(1);
            const ids = ids8(o);
            const snap0 = o.r.snapshot();
            const xr = snap0.nodes.find((n) => n.id === ids.X);
            assert.equal(FLOOR(gv), me, "the floor of gv " + gv + " is the markEpoch under test");
            const ctr = { runs: 0, bodyErr: null };
            const { rr, H } = restore8(shiftSnap(snap0, (me - xr.markEpoch) | 0, gv, { id: ids.X, me }), ids, ctr);
            assert.equal(gvOf(rr), gv);
            assert.equal(recOf(rr, H[ids.X]).markEpoch, me);
            let hookErr = "unset";
            rr.observeObservers(H[ids.u], { onDisconnect: () => { try { H[ids.X].peek(); } catch (e) { hookErr = e; } } });
            const r1 = tryRead(() => H[ids.X]());
            const r2 = tryRead(() => H[ids.X]());
            assert.ok(hookErr !== "unset", "the hook never ran");
            assert.equal(hookErr, o.e0, "the nested hook peek serves the restored cached e0");
            assert.deepEqual([r1, r2], [{ v: undefined }, { v: undefined }], "read1 / read2: " + showRes(r1) + " / " + showRes(r2));
            assert.equal(ctr.runs, 0);
        });
    }
    // ---- A11: a linkless computed (no deps): the reset floor makes a later read re-run, then cache ----
    for (const [how, label] of A8HOWS) {
        it("[RED FIXCOMP] A11 " + label + ": body throws on run 1 then returns 7: reset record has the floor; read2 === 7 (runs 2); read3 === 7 (runs 2), clean true", () => {
            const r = createRegistry({ maxNodes: 64 });
            let runs = 0;
            const body = () => { runs++; if (runs === 1) throw new RangeError(V8MSG); return 7; };
            const box = how.startsWith("box");
            const X = box ? r.computedBox(body) : r.computed(body);
            const rd = (how === "peek" || how === "boxpeek") ? () => X.peek() : box ? () => X.get() : () => X();
            const r1 = tryRead(rd);
            assert.ok(r1.e instanceof RangeError && r1.e.message === V8MSG, showRes(r1));
            const rec = recOf(r, X);
            assert.equal(rec.evalVersion, 0); assert.equal(rec.version, 0); assert.equal(rec.clean, false); assert.equal(rec.value, undefined);
            assert.equal(rec.markEpoch, FLOOR(gvOf(r)));
            assert.deepEqual(tryRead(rd), { v: 7 }); assert.equal(runs, 2);
            assert.deepEqual(tryRead(rd), { v: 7 }); assert.equal(runs, 2);
            assert.equal(recOf(r, X).clean, true);
        });
    }
    // ---- A12: snapshot / restore of the reset record (after A8 call row read1) ----
    it("[RED FIXCOMP] A12: X's record after A8 read1 = {evalVersion 0, version 0, markEpoch floor, clean false, value undefined}; restore round-trips it; the next read throws a NEW RangeError (runs +1)", () => {
        const o = w8("call", false);
        o.k.set(1);
        const r1 = tryRead(o.rd);
        assert.ok(r1.e instanceof RangeError, showRes(r1));
        const snap = o.r.snapshot();
        const ids = ids8(o);
        const rec = snap.nodes.find((n) => n.id === ids.X);
        assert.equal(rec.evalVersion, 0); assert.equal(rec.version, 0); assert.equal(rec.clean, false); assert.equal(rec.value, undefined);
        assert.equal(rec.markEpoch, FLOOR(snap.gv));
        const ctr = { runs: 0, bodyErr: null };
        const { rr, H } = restore8(snap, ids, ctr);
        assert.deepEqual(recOf(rr, H[ids.X]), rec);
        const x = tryRead(() => H[ids.X]());
        assert.ok(x.e instanceof RangeError && x.e.message === V8MSG, showRes(x));
        assert.equal(x.e, ctr.bodyErr);
        assert.notEqual(x.e, o.e0); assert.notEqual(x.e, r1.e);
        assert.equal(ctr.runs, 1);
    });
    // ---- A13: GC (child): serve-and-reset cycles at far gv ----
    // Stat: per window (gc + settle, 10,000 cycles, no collection inside, else discarded) B/op = JS-heap-spaces delta / cycles (new / old / large-object; --single-threaded; CI class 18: see A5); per build the MEDIAN of
    // the clean windows over 6 rounds. noise = |ref - reftwin| (a second registry loop on the REFERENCE module, never the engine under test); gate |eng - ref| <= 1 + noise. The reference is
    // the vendored E2 fixture (CI has no .handoff/ FIXCOMP; both lack any per-cycle allocation). Must-fail control: the engine loop plus one
    // new Array(4) per run exceeds the reference by >= 16 B/op. Measured b193 local (node 24.22.3, 26.8.2): ref = eng = twin = reftwin = 0.396 B/op at both gv, ctl ~80.4.
    function a13(gv) {
        const o = child(["--expose-gc", "--single-threaded"], "gc2", { eng: ENGINE_PATH, ref: FIXTURE_PATH, cycles: 10000, rounds: 6, gv });
        assert.equal(o.windowMajors, 0);
        assert.ok(o.n[0] >= 3 && o.n[1] >= 3 && o.n[2] >= 3 && o.n[3] >= 3 && o.n[4] >= 3, "too few clean windows " + JSON.stringify(o.n) + " discarded " + o.discarded);
        const noise = Math.abs(o.ref - o.reftwin);
        assert.ok(noise < 8, "reference A/A noise " + noise + " B/op: a tolerance of 1 + noise would hide one 16 B box (D-b191-4)");
        assert.ok(o.ctl - o.ref >= 16, "control " + o.ctl + " did not exceed the reference " + o.ref);
        assert.ok(Math.abs(o.eng - o.ref) <= 1 + noise, "gv " + gv + ": engine " + o.eng + " B/op vs reference " + o.ref + " (A/A noise |ref - reftwin| " + noise + ", reftwin " + o.reftwin + ", engine twin (reported only) " + o.twin + ", codeMoved (reported only) " + o.codeMoved + ")");
    }
    it("A13 GC: 10,000 serve-and-reset cycles at gv 0x50000000 allocate what the E2 reference allocates (reference A/A twin noise); maxMajor 0; control exceeds the reference", () => { a13(0x50000000); });
    it("A13 tooth: the gc2 child refuses to measure without --single-threaded (exit 3)", () => {
        assertRefuses("gc2", { eng: ENGINE_PATH, ref: FIXTURE_PATH, cycles: 1000, rounds: 1, gv: 0x50000000 });
    });
    // D-b191-4: the D-b191-3 floor expression boxed 16 B/op per reset at gv < -0x40000001 (measured 16.03 vs 0.03).
    it("A13 GC: the same at gv -0x7FFFFF00 (the floor subtraction must stay int32)", () => { a13(-0x7FFFFF00); });
});

// Oracle: reviewer r1 repro (b191). The overflow arm reads v.constructor / v.message (user getters); a getter that disposes X and
// recycles its slot as s2 must not get s2 reset. Expected: X read throws the hostile object itself, s2() === 42 (the value given to signal()).
describe("B1b' fix: hostile getter recycles X (review r1)", () => {
    function hostileWorld(variant) {
        const r = createRegistry({ maxNodes: 64 });
        let X, s2 = null;
        const recycle = () => { if (s2 === null) { r.dispose(X); s2 = r.signal(42); } };
        const hostile = variant === "ctor"
            ? { get constructor() { recycle(); return RangeError; }, message: V8MSG }
            : { constructor: RangeError, get message() { recycle(); return V8MSG; } };
        X = r.computed(() => { throw hostile; });
        const pin = r.signal(0); void pin;
        // snapshot().nodes lists LIVE nodes only (free slots skipped), in pool order; the pin keeps a live node after X, so s2 ranks before it only in X's slot
        const xIdx = r.snapshot().nodes.findIndex((n) => n.id === r.nodeId(X));
        assert.ok(xIdx >= 0);
        let caught = "none";
        try { caught = X(); } catch (e) { caught = e; }
        assert.notEqual(s2, null, "the getter never ran");
        // the R1 rows have teeth only while the free list hands X's slot to s2: s2 must sit at X's old pool index
        const s2Idx = r.snapshot().nodes.findIndex((n) => n.id === r.nodeId(s2));
        assert.equal(s2Idx, xIdx, "s2 did not reuse X's slot (pool index " + s2Idx + " vs " + xIdx + ")");
        return { hostile, caught, s2 };
    }
    it("R1-ctor: constructor getter disposes X and recycles its slot: the read throws the hostile object, the new signal keeps 42", () => {
        const { hostile, caught, s2 } = hostileWorld("ctor");
        assert.strictEqual(caught, hostile);
        assert.strictEqual(s2(), 42);
    });
    it("R1-msg: message getter disposes X and recycles its slot: the read throws the hostile object, the new signal keeps 42", () => {
        const { hostile, caught, s2 } = hostileWorld("msg");
        assert.strictEqual(caught, hostile);
        assert.strictEqual(s2(), 42);
    });
});
