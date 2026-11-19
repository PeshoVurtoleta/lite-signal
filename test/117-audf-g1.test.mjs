/**
 * AUD-F group 1 (burst 196, batch B3): the run epilogue (severStale) must unwind first, then sever, and a throwing sever hook must not strand
 * the graph or lose a stale read.
 *
 * Oracle: .handoff/audf/PLAN-AUDF-G1.md ASSERTIONS A2-A9 + RULINGS b195 (D-b195-2 (a), D-b195-3), written independently of the fix; the p4 / A8 / A9
 * goldens are the TASK 0 values of the frozen build (evidence/golden-before.txt, evidence/a8a9-golden.mjs), the fixed-build values are the SPEC'S.
 * Engine under test: ../Signal.js, or the absolute path in env AUDF_SIGNAL (the mutant battery). The RED reference is ALWAYS
 * test/fixtures/Signal-5af14f0b.js, a byte copy of the frozen build 66e2f27 / 5af14f0b (CI has no .handoff/); the "fixture identity" row
 * fails the file unless its sha256/8 is 5af14f0b (the children do not check it).
 *
 * Row labels: RED = fails on the fixture, passes on the fixed build. PIN = same on both. KNOWN / REPORTED as stated in the title.
 * Every row is a hard row: RED engine rows fail on the fixture; the fixture-side rows assert the BROKEN values.
 * Named mutants (PLAN TASK 6) a row kills are in its title.
 *
 * Children (spawnSync): --max-old-space-size pinned, SIGKILL timeout, a killed / crashed child FAILS its row. The A2 sweep runs --jitless.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_PATH = process.env.AUDF_SIGNAL || fileURLToPath(new URL("../Signal.js", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/Signal-5af14f0b.js", import.meta.url));
const CHILD_PATH = fileURLToPath(new URL("./fixtures/audf-g1-child.mjs", import.meta.url));
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';
async function loadBuild(p) {
    if (existsSync(dirname(p) + "/Watch.js")) return import(pathToFileURL(p).href);
    const parts = readFileSync(p, "utf8").split(WATCH_LINE);
    assert.equal(parts.length, 2, "Watch re-export line matched " + (parts.length - 1) + " times");
    return import("data:text/javascript;base64," + Buffer.from(parts[0] + parts[1], "utf8").toString("base64"));
}
const ME = await loadBuild(ENGINE_PATH);
const MF = await loadBuild(FIXTURE_PATH);

const CHILD_TIMEOUT = 240000;
const HEAP = "--max-old-space-size=1536";
const fixtureSha8 = createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex").slice(0, 8);

function childRaw(flags, mode, args) {
    return spawnSync(process.execPath, [...flags, HEAP, CHILD_PATH, mode, JSON.stringify(args)], { encoding: "utf8", timeout: CHILD_TIMEOUT, killSignal: "SIGKILL", maxBuffer: 1 << 26, env: process.platform === "win32" ? process.env : {} });
}
function child(flags, mode, args) {
    const r = childRaw(flags, mode, args);
    if (r.error) assert.fail("child " + mode + " error: " + r.error.message);
    if (r.signal !== null) assert.fail("child " + mode + " killed by " + r.signal);
    if (r.status !== 0) assert.fail("child " + mode + " exit " + r.status + ": " + String(r.stderr).slice(-400));
    const lines = r.stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
}

describe("fixture identity", () => {
    it("the vendored RED reference is 5af14f0b", () => { assert.equal(fixtureSha8, "5af14f0b"); });
});

const grab = (f) => { try { f(); return { threw: false }; } catch (e) { return { threw: true, e }; } };
const msg = (x) => (x && x.threw ? String(x.e && x.e.message) : "no throw");

// ======================================================================================================================================
// A3 (p4 shape, audit/2026-11-16/work/fable-5.2/p4-epilogue-stale.mjs): a throwing 1->0 hook in the run epilogue must not lose the stale-read re-run.
// Setup: reader deps [t, a, K, b]; K (a computed) writes `a` while the reader is mid-run (a stale read); run 2 drops b (a stale tail), its
// onDisconnect throws when armed. Values below: boom=false = TASK 0 golden (PIN); boom=true live = the SPEC (D-b195-2 (a): the re-run happens, a is 5 at the
// last run, the throw still reaches the caller); the RED tuple = the TASK 0 golden of the frozen build.
// ======================================================================================================================================
function p4Effect(M, boomOn) {
    const r = M.createRegistry();
    const t = r.signal(0), a = r.signal(0), w = r.signal(0), b = r.signal(0);
    let first = true, boom = false; const seen = [];
    r.observeObservers(b, { onDisconnect() { if (boom) throw new Error("epilogue boom"); } });
    const K = r.computed(() => { const v = w(); if (v > 0) a.set(v); return v; });
    r.effect(() => { t(); const av = a(); K(); if (first) b(); seen.push(av); });
    first = false; boom = boomOn;
    const x = grab(() => r.batch(() => { w.set(5); t.set(1); }));
    boom = false;
    const out = { a: a.peek(), lastSeen: seen[seen.length - 1], runs: seen.length };
    if (x.threw) out.t1 = "THROW " + x.e.message;
    return out;
}
function p4Computed(M, boomOn) {
    const r = M.createRegistry();
    const t = r.signal(0), a = r.signal(0), w = r.signal(0), b = r.signal(0), other = r.signal(0);
    let first = true, boom = false, runs = 0;
    r.observeObservers(b, { onDisconnect() { if (boom) throw new Error("epilogue boom"); } });
    const K = r.computed(() => { const v = w(); if (v > 0) a.set(v); return v; });
    const C = r.computed(() => { runs++; t(); const av = a(); K(); if (first) b(); return av; });
    const rd = () => { try { return C(); } catch (e) { return "THROW " + e.message; } };
    C(); first = false; boom = boomOn;
    r.batch(() => { w.set(5); t.set(1); });
    const read1 = rd();
    boom = false;
    const read2 = rd();
    other.set(1);
    const read3AfterUnrelatedWrite = rd();
    return { a: a.peek(), read1, read2, read3AfterUnrelatedWrite, runs };
}
describe("A3 p4 shape: a throwing epilogue hook keeps the stale-read re-run", () => {
    for (const [nm, M] of [["engine", ME], ["fixture", MF]]) {
        it("[PIN] " + nm + " boom=false EFFECT {a 5, lastSeen 5, runs 3}", () => { assert.deepEqual(p4Effect(M, false), { a: 5, lastSeen: 5, runs: 3 }); });
        it("[PIN] " + nm + " boom=false COMPUTED {a 5, read1 5, read2 5, read3AfterUnrelatedWrite 5, runs 3}" + (nm === "engine" ? " (kills SS-CONSUMEALWAYS)" : ""), () => { assert.deepEqual(p4Computed(M, false), { a: 5, read1: 5, read2: 5, read3AfterUnrelatedWrite: 5, runs: 3 }); });
    }
    it("[RED] engine boom=true EFFECT: the throw reaches the caller AND the re-run saw a = 5 (lastSeen 5, runs 3) (kills SS-NOCONSUME, SS-ARMSWAP)", () => {
        assert.deepEqual(p4Effect(ME, true), { t1: "THROW epilogue boom", a: 5, lastSeen: 5, runs: 3 });
    });
    it("[RED] engine boom=true COMPUTED: read1 THROWS (the flag is consumed on the throw arm only), read2 5, read3 5, runs 3 (kills SS-NOCONSUME, SS-ARMSWAP)", () => {
        assert.deepEqual(p4Computed(ME, true), { a: 5, read1: "THROW epilogue boom", read2: 5, read3AfterUnrelatedWrite: 5, runs: 3 });
    });
    it("[RED reference] fixture boom=true EFFECT: lastSeen 0, runs 2 (TASK 0 golden: the stale read is lost)", () => {
        assert.deepEqual(p4Effect(MF, true), { t1: "THROW epilogue boom", a: 5, lastSeen: 0, runs: 2 });
    });
    it("[RED reference] fixture boom=true COMPUTED: read2 0, read3AfterUnrelatedWrite 0, runs 2 (TASK 0 golden)", () => {
        assert.deepEqual(p4Computed(MF, true), { a: 5, read1: "THROW epilogue boom", read2: 0, read3AfterUnrelatedWrite: 0, runs: 2 });
    });
});

// ======================================================================================================================================
// A4: the body throws E1 and the epilogue (a 1->0 onDisconnect on a dep the run dropped) throws E2 -> the caller gets E2; the graph is clean after.
// ======================================================================================================================================
function afterState(r) {
    const x = r.signal(0); let n = 0;
    const d = r.effect(() => { x(); n++; });
    x.set(1);
    d();
    let reset = "ok"; try { r.reset(); } catch (e) { reset = String(e.message); }
    return { isTracking: r.isTracking(), owner: r.getOwner() === undefined ? "undefined" : "set", newEffectRuns: n, reset };
}
const CLEAN_AFTER = { isTracking: false, owner: "undefined", newEffectRuns: 2, reset: "ok" };
function a4Effect(M) {
    const r = M.createRegistry();
    const t = r.signal(0), b = r.signal(0); const E1 = new Error("E1"), E2 = new Error("E2");
    let first = true, boom = false;
    r.observeObservers(b, { onDisconnect() { if (boom) throw E2; } });
    r.effect(() => { t(); if (first) b(); else throw E1; });
    first = false; boom = true;
    const x = grab(() => t.set(1));
    boom = false;
    return { E1, E2, x, after: afterState(r) };
}
function a4Computed(M) {
    const r = M.createRegistry();
    const t = r.signal(0), b = r.signal(0); const E1 = new Error("E1"), E2 = new Error("E2");
    let first = true, boom = false;
    r.observeObservers(b, { onDisconnect() { if (boom) throw E2; } });
    const C = r.computed(() => { t(); if (first) { b(); return 1; } throw E1; });
    C(); first = false; t.set(1); boom = true;
    const x = grab(() => C());
    boom = false;
    return { E1, E2, x, after: afterState(r) };
}
// Scheduler worlds (A4b / A5): a scheduler effect (K writes `a` mid-run = a stale read), its thunk run OUTSIDE a flush and batch. The scheduler records the
// thunk; with `autorun` set it also runs the thunk at once (so a re-queue drained by requeueStaleEffect runs the re-run inside the scheduler call).
function schedWorld(M, rerunThrows) {
    const r = M.createRegistry();
    const t = r.signal(0), a = r.signal(0), w = r.signal(0), b = r.signal(0);
    const E2 = new Error("E2"), E3 = new Error("E3");
    let first = true, boom = false, runs = 0, lastSeen = -1, calls = 0, autorun = false, pend = null;
    r.observeObservers(b, { onDisconnect() { if (boom) throw E2; } });
    const K = r.computed(() => { const v = w(); if (v > 0) a.set(v); return v; });
    r.effect(() => { runs++; t(); const av = a(); K(); if (first) b(); if (rerunThrows && runs === 3) throw E3; lastSeen = av; },
        { scheduler: (th) => { calls++; pend = th; if (autorun) { autorun = false; th(); } } });
    if (pend !== null) { const th = pend; pend = null; th(); }   // the first run, handed to the scheduler by effect()
    first = false;
    r.batch(() => { w.set(5); t.set(1); });                       // the scheduler records the thunk (autorun off): QUEUED, not yet run
    if (pend === null) assert.fail("the scheduler was not handed the thunk");
    const calls0 = calls, runs0 = runs;
    boom = true; autorun = true;
    const x = grab(() => pend());
    boom = false; autorun = false;
    let snap = "ok"; try { r.snapshot(); } catch (e) { snap = String(e.message); }
    return { E2, E3, x, schedulerCallsDuringThunk: calls - calls0, runsDuringThunk: runs - runs0, lastSeen, snap, after: afterState(r) };
}
describe("A4 the body throws E1, the epilogue throws E2: the caller gets E2; the graph is clean (kills SS-NOFIN)", () => {
    for (const [nm, M] of [["engine", ME], ["fixture", MF]]) {
        it("[PIN] " + nm + " effect: t.set(1) throws E2 (not E1); isTracking false, owner undefined, a new effect runs 2x, reset ok", () => {
            const o = a4Effect(M);
            assert.ok(o.x.threw, "no throw");
            assert.strictEqual(o.x.e, o.E2, "caller got " + msg(o.x));
            assert.deepEqual(o.after, CLEAN_AFTER);
        });
        it("[PIN] " + nm + " computed: the read throws E2 (not E1); the same clean state", () => {
            const o = a4Computed(M);
            assert.ok(o.x.threw, "no throw");
            assert.strictEqual(o.x.e, o.E2, "caller got " + msg(o.x));
            assert.deepEqual(o.after, CLEAN_AFTER);
        });
    }
    // D-b195-2 (a): the stale-read re-run is drained inside the throwing epilogue, outside any flush; its error replaces the epilogue's.
    it("[RED] engine both-throw (scheduler thunk, stale read, epilogue throws E2, the drained re-run throws E3): the caller gets E3, the scheduler is called once, runs 3; graph clean", () => {
        const o = schedWorld(ME, true);
        assert.ok(o.x.threw, "no throw");
        assert.strictEqual(o.x.e, o.E3, "caller got " + msg(o.x));
        assert.equal(o.schedulerCallsDuringThunk, 1);
        assert.equal(o.runsDuringThunk, 2);
        assert.deepEqual(o.after, CLEAN_AFTER);
    });
    it("[RED reference] fixture both-throw: the caller gets E2, no re-run (scheduler 0 calls, runs 1)", () => {
        const o = schedWorld(MF, true);
        assert.ok(o.x.threw, "no throw");
        assert.strictEqual(o.x.e, o.E2, "caller got " + msg(o.x));
        assert.equal(o.schedulerCallsDuringThunk, 0);
        assert.equal(o.runsDuringThunk, 1);
    });
});

// ======================================================================================================================================
// A5 (D-b195-2 (a)): a scheduler effect whose thunk runs outside a flush, a stale read, the epilogue throws E2: the scheduler is called again before the
// throw returns, the re-run saw a = 5, snapshot() is ok.
// ======================================================================================================================================
describe("A5 scheduler effect, thunk outside a flush: requeueStaleEffect drains through the scheduler", () => {
    it("[RED] engine: the thunk throws E2; the scheduler was called exactly once more (its thunk ran: runs +2, lastSeen 5); snapshot ok; graph clean", () => {
        const o = schedWorld(ME, false);
        assert.ok(o.x.threw, "no throw");
        assert.strictEqual(o.x.e, o.E2, "caller got " + msg(o.x));
        assert.equal(o.schedulerCallsDuringThunk, 1);
        assert.equal(o.runsDuringThunk, 2);
        assert.equal(o.lastSeen, 5);
        assert.equal(o.snap, "ok");
        assert.deepEqual(o.after, CLEAN_AFTER);
    });
    it("[RED reference] fixture: the thunk throws E2; 0 scheduler calls, runs +1, lastSeen 0 (the stale read is lost)", () => {
        const o = schedWorld(MF, false);
        assert.ok(o.x.threw, "no throw");
        assert.strictEqual(o.x.e, o.E2, "caller got " + msg(o.x));
        assert.equal(o.schedulerCallsDuringThunk, 0);
        assert.equal(o.runsDuringThunk, 1);
        assert.equal(o.lastSeen, 0);
    });
});

// ======================================================================================================================================
// A8 PIN (TASK 0 golden, evidence/a8a9-golden.mjs): a 1->0 hook running in the epilogue sees isTracking() false and getOwner() = the run's own node; a write
// the hook makes to an already-read dep is absorbed by the run (markDownstreamInEval treats the owner as the writer). Kills SS-NOCOMPUTING. (SS-NOOBS, dropping `currentObserver = node;` from severStale, is NOT killed here: observeObservers
// hooks do not read; it is killed by the op-4 onGraphMutation rows below, A8b.)
// ======================================================================================================================================
function ownerTag(r, selfId) { const o = r.getOwner(); return o === undefined ? "undefined" : (o.id === selfId ? "self" : "other"); }
function a8Effect(M) {
    const r = M.createRegistry();
    const t = r.signal(0), w = r.signal(0), b = r.signal(0);
    let first = true, runs = 0, selfId = -1, lastW = -1; const hook = [];
    r.observeObservers(b, { onDisconnect() { hook.push({ isTracking: r.isTracking(), owner: ownerTag(r, selfId) }); w.set(w.peek() + 1); } });
    const eh = r.effect(() => { runs++; t(); lastW = w(); if (first) b(); });
    selfId = r.nodeId(eh);
    first = false;
    const x = grab(() => t.set(1));
    let snap = "ok"; try { r.snapshot(); } catch (e) { snap = String(e.message); }
    return { threw: x.threw, hook, runs, lastW, w: w.peek(), after: { isTracking: r.isTracking(), owner: r.getOwner() === undefined ? "undefined" : "set", links: r.stats().activeLinks }, snap };
}
function a8Computed(M) {
    const r = M.createRegistry();
    const t = r.signal(0), w = r.signal(0), b = r.signal(0);
    let first = true, runs = 0, selfId = -1; const hook = [];
    r.observeObservers(b, { onDisconnect() { hook.push({ isTracking: r.isTracking(), owner: ownerTag(r, selfId) }); w.set(w.peek() + 1); } });
    const C = r.computed(() => { runs++; t(); w(); if (first) b(); return w.peek(); });
    selfId = r.nodeId(C);
    const v0 = C(); first = false; t.set(1);
    const v1 = C(), v2 = C();
    return { v0, v1, v2, hook, runs, w: w.peek(), after: { isTracking: r.isTracking(), owner: r.getOwner() === undefined ? "undefined" : "set", links: r.stats().activeLinks } };
}
describe("A8 PIN: the epilogue hook's context and the self-write absorption", () => {
    for (const [nm, M] of [["engine", ME], ["fixture", MF]]) {
        it("[PIN] " + nm + " effect: hook sees isTracking false, owner = self; the hook's write of w (0 -> 1) is absorbed: runs 2, lastW 0, snapshot ok", () => {
            assert.deepEqual(a8Effect(M), { threw: false, hook: [{ isTracking: false, owner: "self" }], runs: 2, lastW: 0, w: 1, after: { isTracking: false, owner: "undefined", links: 2 }, snap: "ok" });
        });
        it("[PIN] " + nm + " computed: hook context identical; v0 0, v1 0, v2 1, runs 3", () => {
            assert.deepEqual(a8Computed(M), { v0: 0, v1: 0, v2: 1, hook: [{ isTracking: false, owner: "self" }], runs: 3, w: 1, after: { isTracking: false, owner: "undefined", links: 2 } });
        });
    }
});

// ======================================================================================================================================
// A8b PIN (D-DELTA-2, fable-5.2-delta-1): the context an onGraphMutation op-4 listener sees during the frame-epilogue sever. Kills SS-NOOBS: with
// `currentObserver = node;` dropped from severStale a listener READ is not tracked (isTracking false, no link to the probe, no re-run on its write).
// Shapes from the prototype audit/2026-11-17/work/fable-5.2-delta/ssnoobs-row.mjs; the values are the live tuple (isTracking true: the sever runs
// with the node as observer and owner; the effect case subscribes the listener's read of `probe`, so links 2 and one re-run on the probe write).
// ======================================================================================================================================
function a8bEffect(M) {
    const r = M.createRegistry();
    const t = r.signal(0), b = r.signal(0), probe = r.signal(0);
    let first = true, runs = 0, selfId = -1; const seen = [];
    const E = r.effect(() => { runs++; t(); if (first) b(); });
    selfId = r.nodeId(E);
    r.onGraphMutation((op) => { if (op === 4) { seen.push({ isTracking: r.isTracking(), owner: ownerTag(r, selfId) }); probe(); } });
    first = false;
    t.set(1);
    const links = r.stats().activeLinks;
    const before = runs; probe.set(1);
    return { seen, links, rerunOnProbeWrite: runs - before, after: { isTracking: r.isTracking(), owner: ownerTag(r, selfId) } };
}
function a8bComputed(M) {
    const r = M.createRegistry();
    const t = r.signal(0), b = r.signal(0);
    let first = true, selfId = -1; const seen = [];
    const C = r.computed(() => { t(); if (first) b(); return 1; });
    selfId = r.nodeId(C);
    C();
    r.onGraphMutation((op) => { if (op === 4) seen.push({ isTracking: r.isTracking(), owner: ownerTag(r, selfId) }); });
    first = false; t.set(1); C();
    return { seen, after: { isTracking: r.isTracking(), owner: ownerTag(r, selfId) } };
}
describe("A8b PIN: the op-4 onGraphMutation listener's context in the epilogue sever (kills SS-NOOBS)", () => {
    it("[PIN] engine effect: two op-4 events (the sever, then the re-run that drops the listener's probe link), each isTracking true, owner self; links 2; 1 re-run on probe write", () => {
        assert.deepEqual(a8bEffect(ME), { seen: [{ isTracking: true, owner: "self" }, { isTracking: true, owner: "self" }], links: 2, rerunOnProbeWrite: 1, after: { isTracking: false, owner: "undefined" } });
    });
    it("[PIN] engine computed: one op-4 event, isTracking true, owner self", () => {
        assert.deepEqual(a8bComputed(ME), { seen: [{ isTracking: true, owner: "self" }], after: { isTracking: false, owner: "undefined" } });
    });
});

// ======================================================================================================================================
// A9 PIN (TASK 0 golden): an effect that disposes itself mid-body (run 2) after dropping a dep. Kills FIN-STALEOUT.
// ======================================================================================================================================
function a9(M) {
    const r = M.createRegistry();
    const t = r.signal(0), b = r.signal(0);
    const base = r.stats().activeLinks;
    let first = true, runs = 0, dispose = null;
    dispose = r.effect(() => { runs++; t(); if (!first) { dispose(); return; } b(); });
    const created = r.stats().activeLinks;
    first = false;
    const x = grab(() => t.set(1));
    const st = r.stats();
    const y = grab(() => { t.set(2); b.set(1); });
    let snap = "ok"; try { r.snapshot(); } catch (e) { snap = String(e.message); }
    let reset = "ok"; try { r.reset(); } catch (e) { reset = String(e.message); }
    return { res: x.threw, base, created, after: st.activeLinks, activeNodes: st.activeNodes, runs, res2: y.threw, isTracking: r.isTracking(), owner: r.getOwner() === undefined ? "undefined" : "set", snap, reset };
}
describe("A9 PIN: self-dispose mid-body after dropping a dep", () => {
    for (const [nm, M] of [["engine", ME], ["fixture", MF]]) {
        it("[PIN] " + nm + ": no throw; activeLinks 0 -> 2 -> 0; runs 2; later writes ok; snapshot ok; reset ok", () => {
            assert.deepEqual(a9(M), { res: false, base: 0, created: 2, after: 0, activeNodes: 2, runs: 2, res2: false, isTracking: false, owner: "undefined", snap: "ok", reset: "ok" });
        });
    }
});

// ======================================================================================================================================
// A10 (nested sever; kills SS-NOPUSH, which test/110 A1.3 -- the in-frame case -- does not reach): severStale saves the outer cursor in a local (savedCur)
// and pushes its own depth (cursorDepth = d + 1). Without the push cursorDepth stays at d during the walk, so in (a) (d = 1) repairCursor, which logs a fix
// only while cursorDepth > 1, logs nothing when a walk hook frees the outer frame's saved cursor, and the restore hands that saved cursor back unrepaired.
// b220 G1 B2b (.handoff/b220/b2b/t7-mutants.txt, engine b5289277): SS-NOPUSH is KILLED by row (a) only; row (b) passes under it and stays a behaviour pin.
// Values are hand-derived from the graph shape (links 6 -> 4: C drops b, E drops z; the runs / seen list from the write sequence), not copied from a run.
// HALF-FREED classifier: stats().activeLinks must equal the per-node sums of forEachSource and of forEachObserver.
// ======================================================================================================================================
function tri(r, hs) { let src = 0, obs = 0; for (const h of hs) { r.forEachSource(h, () => { src++; }); r.forEachObserver(h, () => { obs++; }); } return { src, obs, links: r.stats().activeLinks }; }
// (a) E reads t, C, z, w. Run 2 (batch: t, s): E's body reads C at cursor depth 1 -> C re-runs and drops b -> severStale(C) at d = 1 saves E's live cursor (restored by C's
// own frame; the link to z, the next after C) in savedCur and pushes depth 2; b's 1->0 hook disposes z, freeing E's link to z while it is that saved cursor (repairCursor logs
// the fix at depth 2; severStale's restore applies it through fixCursor). E then does not read z (gone) and reads w.
function a10a(M) {
    const r = M.createRegistry();
    const t = r.signal(0), s = r.signal(0), b = r.signal(0), z = r.signal(0), w = r.signal(0);
    let first = true, gone = false, runs = 0; const seen = [];
    r.observeObservers(b, { onDisconnect() { if (!first && !gone) { gone = true; r.dispose(z); } } });
    const C = r.computed(() => { s(); if (first) b(); return 1; });
    const E = r.effect(() => { runs++; t(); C(); if (!gone) z(); seen.push(w()); });
    const hs = [t, s, b, z, w, C, E];
    const l0 = tri(r, hs);
    first = false;
    const x1 = grab(() => r.batch(() => { t.set(1); s.set(1); }));
    const l1 = tri(r, hs);
    const x2 = grab(() => w.set(7));
    const x3 = grab(() => t.set(2));
    let snap = "ok"; try { r.snapshot(); } catch (e) { snap = String(e.message); }
    const l2 = tri(r, hs);
    let reset = "ok"; try { r.reset(); } catch (e) { reset = String(e.message); }
    return { x1, x2, x3, runs, seen, l0, l1, l2, bObs: r.hasObservers(b), snap, reset };
}
// (b) E (depth 0) reads t, b, c on run 1 and only t on run 2: severStale(E) at d = 0 walks b then c. b's 1->0 hook creates and runs a nested effect (a nested
// frame inside the walk). The nested frame's exit must hand the walk its cursor back: c must still be severed. (Does not kill SS-NOPUSH on b5289277, see above.)
function a10b(M) {
    const r = M.createRegistry();
    const t = r.signal(0), b = r.signal(0), c = r.signal(0), n = r.signal(0);
    let first = true, nested = 0, runs = 0, ne = null;
    r.observeObservers(b, { onDisconnect() { if (!first && ne === null) ne = r.effect(() => { nested++; n(); }); } });
    const E = r.effect(() => { runs++; t(); if (first) { b(); c(); } });
    const l0 = tri(r, [t, b, c, n, E]);
    first = false;
    const x1 = grab(() => t.set(1));
    const l1 = tri(r, [t, b, c, n, E, ne]);
    const bObs = r.hasObservers(b), cObs = r.hasObservers(c);
    const x2 = grab(() => t.set(2));
    let snap = "ok"; try { r.snapshot(); } catch (e) { snap = String(e.message); }
    const l2 = tri(r, [t, b, c, n, E]);   // E's re-run disposed its owned nested effect (runCleanupE): only E.t is left
    let reset = "ok"; try { r.reset(); } catch (e) { reset = String(e.message); }
    return { x1, x2, runs, nested, l0, l1, bObs, cObs, l2, snap, reset };
}
// (c) kills SS-D0NULL: after a nested sever at d > 0 the finally restores the OUTER frame's cursor (savedCur; through fixCursor when the fix log is non-empty); null
// leaves E unable to sever its own stale w. (b220 G1 B2b: KILLED by this row on b5289277, .handoff/b220/b2b/t7-mutants.txt.)
// E reads y, C, then w (only while s == 0), q. batch(y, s): C re-runs at d = 1 and severs x; E (s now 1) skips w, so w must be severed: links 6 -> 4, w.set no re-run.
// Hand-derived: l0 = E.{y,C,w,q} 4 + C.{s,x} 2 = 6; l1 = E.{y,C,q} 3 + C.{s} 1 = 4; runs: 1 initial + 1 (batch) = 2; w.set -> 2; q.set -> 3.
function a10c(M) {
    const r = M.createRegistry();
    const s = r.signal(0), x = r.signal(1), y = r.signal(2), w = r.signal(3), q = r.signal(4);
    const C = r.computed(() => (s() === 0 ? x() : 0));
    let runs = 0;
    r.effect(() => { runs++; y(); C(); if (s.peek() === 0) w(); q(); });
    const l0 = r.stats().activeLinks;
    r.batch(() => { y.set(20); s.set(1); });
    const l1 = r.stats().activeLinks, runs1 = runs;
    w.set(30); const runsW = runs;
    q.set(40); const runsQ = runs;
    return { l0, l1, runs1, runsW, runsQ };
}
describe("A10 nested sever: the walk's cursor push (row (a) kills SS-NOPUSH)", () => {
    const OK = { threw: false };
    const TRI6 = { src: 6, obs: 6, links: 6 }, TRI4 = { src: 4, obs: 4, links: 4 };
    for (const [nm, M] of [["engine", ME], ["fixture", MF]]) {
        it("[PIN] " + nm + " (a) the walk hook frees the outer frame's saved cursor: no throw, runs 4, seen [0,0,7,7], activeLinks 6 -> 4 = the forEachSource / forEachObserver sums, snapshot + reset ok", () => {
            assert.deepEqual(a10a(M), { x1: OK, x2: OK, x3: OK, runs: 4, seen: [0, 0, 7, 7], l0: TRI6, l1: TRI4, l2: TRI4, bObs: false, snap: "ok", reset: "ok" });
        });
        it("[PIN] " + nm + " (c) nested sever at d = 1 restores the outer cursor (kills SS-D0NULL): links 6 -> 4, runs 2, w.set no re-run (2), q.set re-runs (3)", () => {
            assert.deepEqual(a10c(M), { l0: 6, l1: 4, runs1: 2, runsW: 2, runsQ: 3 });
        });
        it("[PIN] " + nm + " (b) a nested effect run inside the walk: the walk still severs b and c (links 3 -> 2: E.t + nested.n; 1 after E re-runs and disposes it), runs 3, nested 1, neither b nor c observed", () => {
            const o = a10b(M);
            assert.deepEqual(o, { x1: OK, x2: OK, runs: 3, nested: 1, l0: { src: 3, obs: 3, links: 3 }, l1: { src: 2, obs: 2, links: 2 }, bObs: false, cObs: false, l2: { src: 1, obs: 1, links: 1 }, snap: "ok", reset: "ok" });
        });
    }
});

// ======================================================================================================================================
// A2: the --jitless sweep (45 depths x 32 pads = 1440 cells per shape, plain + computed): an effect re-run at the stack limit; classify the registry after.
// STUCK = isTracking() true | getOwner() !== undefined | reset() refuses "body is running" | woke 0 under "flush/batch/track in progress".
// KNOWN-G2 = pending, woke 0, reset ok: asserted 0 on the engine and > 0 on frozen G1 (7386c610) by the KNOWN-G2 rows below (AUD-F group 2, batch B3'). HALF-FREED = the walked source-link sum differs from the
// observer-link sum or stats().activeLinks. Kills FIN-CALLFIRST-E (plain shape) and FIN-CALLFIRST-C (computed shape).
// Measured wall time of one child: ~0.5 s (reported by the child as ms).
// ======================================================================================================================================
const SWEEP = (path, shape) => child(["--jitless"], "sweep", { path, shape, below: 40, pads: 32 });
describe("A2 sweep (--jitless, 1440 cells per shape)", () => {
    for (const shape of ["plain", "computed"]) {
        it("[RED] engine " + shape + ": STUCK 0, no unknown class, HALF-FREED 0 (kills FIN-CALLFIRST-" + (shape === "plain" ? "E" : "C") + ")", () => {
            const o = SWEEP(ENGINE_PATH, shape);
            assert.equal(o.cells, 1440);
            assert.ok(o.walkMin.nodes >= (shape === "plain" ? 4 : 5), "coverage floor (HALF walk found the nodes): " + JSON.stringify(o.walkMin));
            assert.deepEqual(o.unknown, [], "unknown class");
            assert.equal(o.byClass.STUCK || 0, 0, "STUCK cells: " + (o.byClass.STUCK || 0));
            assert.equal(o.halfFreed, 0, JSON.stringify(o.halfExamples));
            console.log("# REPORTED engine " + shape + " KNOWN-G2 (group 2 asserts it 0 in the next row): " + (o.byClass["KNOWN-G2"] || 0) + "; classes " + JSON.stringify(o.byClass) + "; " + o.ms + " ms");
        });
        it("[RED reference] fixture " + shape + ": STUCK >= 1 (TASK 0: 32), no unknown class, HALF-FREED 0 (TASK 0: 0)", () => {
            const o = SWEEP(FIXTURE_PATH, shape);
            assert.equal(o.cells, 1440);
            assert.deepEqual(o.unknown, [], "unknown class");
            assert.ok((o.byClass.STUCK || 0) >= 1, "no STUCK cell on the fixture: " + JSON.stringify(o.byClass));
            assert.equal(o.halfFreed, 0, JSON.stringify(o.halfExamples));
            console.log("# REPORTED fixture " + shape + " STUCK " + o.byClass.STUCK + " KNOWN-G2 " + (o.byClass["KNOWN-G2"] || 0) + " classes " + JSON.stringify(o.byClass) + " " + o.ms + " ms");
        });
    }
    // KNOWN-G2 (AUD-F G2 F3/F4): engine must be 0; frozen G1 (commit ca84b0a, measured plain 52 / computed 204 on node v26.8.2; count is node-dependent) > 0. Kills M4 UNQ3.
    const G1_PATH = fileURLToPath(new URL("./fixtures/Signal-7386c610.js", import.meta.url));
    for (const shape of ["plain", "computed"]) {
        it("[RED] engine " + shape + ": KNOWN-G2 0 (AUD-F G2 F3/F4)", () => {
            const o = SWEEP(ENGINE_PATH, shape);
            assert.equal(o.cells, 1440);
            assert.equal(o.byClass["KNOWN-G2"] || 0, 0, JSON.stringify(o.byClass));
        });
        it("[RED reference] frozen G1 " + shape + ": KNOWN-G2 > 0", () => {
            assert.equal(createHash("sha256").update(readFileSync(G1_PATH)).digest("hex").slice(0, 8), "7386c610");
            const o = SWEEP(G1_PATH, shape);
            assert.equal(o.cells, 1440);
            assert.ok((o.byClass["KNOWN-G2"] || 0) > 0, "no KNOWN-G2 cell on frozen G1: " + JSON.stringify(o.byClass));
        });
    }
    for (const [nm, path] of [["engine", ENGINE_PATH], ["fixture", FIXTURE_PATH]]) for (const shape of ["plain", "computed"]) {
        it("[PIN] A7 per-cell " + nm + " " + shape + ": every overflow cell, dispose everything then create one signal -> activeNodes 1 (the fixture passes too)", () => {
            const o = SWEEP(path, shape);
            assert.equal(o.ret.bad, 0, JSON.stringify(o.ret));
            assert.ok(o.ret.checked >= 1300, "overflow cells checked " + o.ret.checked);
        });
    }
    it("[PIN] must-fail control of the HALF-FREED classifier: a planted src != obs and a planted src != activeLinks classify HALF-FREED, an agreeing triple does not", () => {
        const o = SWEEP(FIXTURE_PATH, "plain");
        assert.deepEqual(o.ctl, { srcNeObs: true, srcNeLinks: true, agree: true });
    });
});

// ======================================================================================================================================
// A6 GC: 10,000 conditional-dep flips (one of two effects drops x on every flip, a computed too: severStale runs on every flip, no throw) allocate 0 B/op, maxMajor 0.
// Single child, --single-threaded, JS heap spaces only (CI class 18, as test/115 A5); windows after gc + settle, any window with a collection discarded.
// Must-fail control (same child): one module-scope-stored object per flip must exceed the engine by >= 16 B/op. Kills SS-ALLOC.
// ======================================================================================================================================
describe("A6 GC: 0 B/op on conditional-dep flips (kills SS-ALLOC)", () => {
    it("[PIN] engine B/op 0 over 10,000-flip windows; maxMajor 0; the planted-allocation control exceeds it by >= 16 B/op", () => {
        const o = child(["--expose-gc", "--single-threaded"], "gc", { eng: ENGINE_PATH, ref: FIXTURE_PATH, cycles: 10000, rounds: 6 });
        assert.equal(o.windowMajors, 0);
        assert.ok(o.n[0] >= 3 && o.n[1] >= 3 && o.n[2] >= 3, "too few clean windows " + JSON.stringify(o.n) + " discarded " + o.discarded);
        console.log("# REPORTED A6 B/op: engine " + o.eng + " fixture " + o.ref + " control " + o.ctl);
        // Measured 0.3592 B/op for engine AND fixture (the window driver's own noise, as test/115 A5: 0.396); not zero in the child, so test/115's stated tolerance:
        // engine within 1 B/op of the fixture (no per-flip allocation: a 16 B box per flip would read ~16+) and under 1 B/op absolute.
        assert.ok(Math.abs(o.eng - o.ref) <= 1 && o.eng < 1, "engine " + o.eng + " B/op vs fixture " + o.ref);
        assert.ok(o.ctl - o.eng >= 16, "control " + o.ctl + " did not exceed the engine " + o.eng);
    });
    it("A6 tooth: the gc child refuses to measure without --single-threaded (exit 3)", () => {
        const r = childRaw(["--expose-gc"], "gc", { eng: ENGINE_PATH, ref: FIXTURE_PATH, cycles: 1000, rounds: 1 });
        assert.equal(r.error, undefined); assert.equal(r.signal, null);
        assert.equal(r.status, 3, "exit " + r.status);
        assert.ok(String(r.stderr).includes("GC modes need --single-threaded"));
        assert.equal(String(r.stdout).trim(), "");
    });
});

// ======================================================================================================================================
// A7 retention: 200 cycles of (registry, conditional effect + computed, an epilogue hook that throws once, dispose everything) -> tracker size 0, activeLinks 0.
// (The per-overflow-cell "dispose all, one signal -> activeNodes 1" row is in A2 above.)
// ======================================================================================================================================
describe("A7 retention", () => {
    it("[PIN] engine: 200 cycles, the hook threw once per cycle, activeLinks 0 / activeNodes 0 every cycle, tracker size 0 after gc", () => {
        const o = child(["--expose-gc"], "ret", { path: ENGINE_PATH, cycles: 200 });
        assert.equal(o.cycles, 200);
        assert.equal(o.hookThrows, 200);
        assert.deepEqual(o.badOther, []);
        assert.deepEqual(o.badLinks, []);
        assert.deepEqual(o.badNodes, []);
        assert.equal(o.trackerLeft, 0);
    });
});
