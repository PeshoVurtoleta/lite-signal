/**
 * AUD-F group 2 (burst 198, batch B3'): a throwing run must not strand the QUEUED bit (F3 / F4), and the aggregate flush error
 * must come out in QUEUE order and be released (LEDGER #64).
 *
 * Oracle: .handoff/audf/PLAN-AUDF-G2.md ASSERTIONS R1-R8 + RULINGS D-b195-4 (L3 is a separate later unit, KNOWN here; LEDGER #66) +
 * D-b197-3 (the effect()-thunk try/catch repair is DROPPED: residual (a) is KNOWN, live == frozen G1, a later engine unit). Expected values are the
 * SPEC'S (new) and the exact probed tuples of the frozen G1 build and the live build (.handoff/audf/g2/b0r/B0R-REPORT.md). The R6 order is the
 * queue order measured by the no-throw order witness in TASK 0 (queue = [E2 scheduler, E3 body, E1 pre-walk]; the effect reached through a
 * computed is queued after the direct subscribers).
 *
 * Engine under test: ../Signal.js, or the absolute path in env AUDF_SIGNAL (the mutant battery). RED reference = test/fixtures/Signal-7386c610.js
 * (frozen G1, commit ca84b0a); R5 "old" = test/fixtures/Signal-5af14f0b.js (pre-G1). Neither fixture is read from .handoff/ (CI has none).
 *
 * Row labels in titles: LIVE rows assert the NEW tuple against the engine under test (they fail on frozen G1); OLD rows assert the OLD tuple
 * against the frozen fixture (proof the live row is red on the old code); PIN = same tuple on every build (regression pin); KNOWN = today's
 * behaviour pinned exactly, live and old.
 * Mutant map: R1/R2 -> M1 M2; R4 -> M2 M3; R5 -> M3; R6 -> M6; R6e -> SPLICEALL SPLICEP1; R7 -> M5; R1w -> GT0; test/117 KNOWN-G2 rows -> M4.
 * No todo, no skip: a wrong fixture hash FAILS its row. R7 runs in a child with --expose-gc (works under plain npm test); a child that lacks gc fails closed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLeakTracker } from "@zakkster/lite-leak";

const ENGINE_PATH = process.env.AUDF_SIGNAL || fileURLToPath(new URL("../Signal.js", import.meta.url));
const G1_PATH = fileURLToPath(new URL("./fixtures/Signal-7386c610.js", import.meta.url));
const PRE_PATH = fileURLToPath(new URL("./fixtures/Signal-5af14f0b.js", import.meta.url));
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';
async function loadBuild(p) {
    if (existsSync(dirname(p) + "/Watch.js")) return import(pathToFileURL(p).href);
    const parts = readFileSync(p, "utf8").split(WATCH_LINE);
    assert.equal(parts.length, 2, "Watch re-export line matched " + (parts.length - 1) + " times");
    return import("data:text/javascript;base64," + Buffer.from(parts[0] + parts[1], "utf8").toString("base64"));
}
const sha8 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 8);
const ME = await loadBuild(ENGINE_PATH);
const G1 = await loadBuild(G1_PATH);
const PRE = await loadBuild(PRE_PATH);

const PENDING = "[lite-signal] snapshot: graph not settled (scheduled effect run pending)";
const tryIt = (f) => { try { return f(); } catch (e) { return "THROW " + (e && e.message); } };
const snapOf = (r) => { try { r.snapshot(); return "ok"; } catch (e) { return e.message; } };
const caught = (f) => { try { f(); return null; } catch (e) { return e; } };

describe("fixture identity", () => {
    it("frozen G1 is 7386c610", () => { assert.equal(sha8(G1_PATH), "7386c610"); });
    it("pre-G1 is 5af14f0b", () => { assert.equal(sha8(PRE_PATH), "5af14f0b"); });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Shapes (ported from .handoff/audf/g2/probes). Each returns a plain tuple.
// ---------------------------------------------------------------------------------------------------------------------------------------
// R1 (p1 variant B): a throwing onDisconnect hook in a plain effect's flush pre-walk.
function shapeR1(M) {
    const r = M.createRegistry();
    const sel = r.signal(true), p = r.signal(1);
    let boom = true, runs = 0;
    r.observeObservers(p, { onDisconnect() { if (boom) throw new Error("onDisconnect boom"); } });
    const C = r.computed(() => sel() ? p() : -1);
    r.effect(() => { C(); runs++; });
    const t1 = tryIt(() => sel.set(false));
    boom = false;
    const before = runs;
    const t2 = tryIt(() => sel.set(true));
    const t3 = tryIt(() => p.set(10));
    const t4 = tryIt(() => sel.set(false));
    return { t1, runsAfterThrow: before, laterWritesThrew: [t2, t3, t4].some((x) => typeof x === "string" && x.startsWith("THROW")), runsAfter3Writes: runs, cNow: tryIt(() => C()), snap: snapOf(r) };
}
// R2 (p1 variant C): a sync scheduler that throws once during a flush.
function shapeR2(M) {
    const r = M.createRegistry();
    const s = r.signal(0);
    let runs = 0, boom = false, calls = 0;
    r.effect(() => { s(); runs++; }, { scheduler(run) { calls++; if (boom) throw new Error("scheduler boom"); run(); } });
    boom = true;
    const t1 = tryIt(() => s.set(1));
    boom = false;
    const before = runs, callsBefore = calls;
    tryIt(() => s.set(2));
    tryIt(() => s.set(3));
    return { t1, runsAfterThrow: before, runsAfter2Writes: runs, schedulerCallsAfter: calls - callsBefore, snap: snapOf(r) };
}
// R3 (residual a): DEFERRED scheduler, consume-once drain; pend() runs the thunk outside a flush and the pre-walk throws out of it.
function shapeR3(M) {
    const r = M.createRegistry();
    const sel = r.signal(true), p = r.signal(1);
    let boom = false, runs = 0, calls = 0, pending = null;
    const pend = () => { const f = pending; pending = null; if (f !== null) f(); };
    r.observeObservers(p, { onDisconnect() { if (boom) throw new Error("onDisconnect boom"); } });
    const C = r.computed(() => sel() ? p() : -1);
    r.effect(() => { C(); runs++; }, { scheduler(run) { calls++; pending = run; } });
    tryIt(pend);
    boom = true;
    tryIt(() => sel.set(false));
    const t1 = tryIt(pend);
    boom = false;
    const before = runs, callsBefore = calls;
    tryIt(() => sel.set(true)); tryIt(pend);
    tryIt(() => p.set(10)); tryIt(pend);
    return { t1, runsAfterThrow: before, runsAfter2Writes: runs, schedulerCallsAfter: calls - callsBefore, cNow: tryIt(() => C()), snap: snapOf(r) };
}
// R3b: pend() inside r.batch with the R4 stale-read body, then a throw on run 2.
function shapeR3b(M) {
    const r = M.createRegistry();
    const s = r.signal(0);
    let runs = 0, calls = 0, pending = null, wrote = false;
    const seen = [];
    const pend = () => { const f = pending; pending = null; if (f !== null) f(); };
    const K = r.computed(() => { const v = s(); if (v === 5 && !wrote) { wrote = true; s.set(6); } return v; });
    r.effect(() => { runs++; seen.push(s()); K(); if (runs === 2) throw new Error("boom"); }, { scheduler(run) { calls++; pending = run; } });
    tryIt(pend);
    tryIt(() => s.set(5));
    const callsBeforeBatch = calls;
    const tb = tryIt(() => r.batch(() => { pend(); }));
    const atClose = calls - callsBeforeBatch;
    const pendingAfterBatch = pending !== null;
    tryIt(pend);
    return { tb, schedulerCallsAtBatchClose: atClose, pendingAfterBatch, runs, seen, s: s.peek(), snap: snapOf(r) };
}
// n2 (store-throw): a deferred scheduler that STORES the thunk and then throws.
function shapeStore(M) {
    const r = M.createRegistry();
    const s = r.signal(0);
    let runs = 0, calls = 0, boom = false; const pend = []; const seen = [];
    r.effect(() => { runs++; seen.push(s()); }, { scheduler(run) { calls++; pend.push(run); if (boom) throw new Error("sched boom"); } });
    pend.shift()();
    boom = true; const t1 = tryIt(() => s.set(1)); boom = false;
    tryIt(() => s.set(2));
    const pendingBeforeDrain = pend.length;
    while (pend.length) tryIt(pend.shift());
    const mid = { runs, calls, seen: seen.slice(), snap: snapOf(r) };
    s.set(3); while (pend.length) tryIt(pend.shift());
    return { t1, pendingBeforeDrain, mid, end: { runs, calls, seen, snap: snapOf(r) } };
}
// (b): a depth-0 dispose recycles Y's slot into resident Z (QUEUED, live entry in the next pass); Y's stale entry serves Z early and that serve throws.
// Variants: SCHED = Z's sync scheduler throws once; PREWALK = Z's pre-walk pull of computed c throws once; BODY = Z's body throws once.
function shapeB(M, V) {
    const ok = (f) => { try { const v = f(); return v === undefined ? "ok" : v; } catch (e) { return "THROW " + (e && e.message); } };
    const r = M.createRegistry();
    const s = r.signal(0), w = r.signal(0);
    const log = [];
    let armed = false, zRuns = 0, zCalls = 0, zHandle = null, yHandle = null, recycled = null;
    const zSeen = [];
    const sel = r.signal(true);
    let discThrowOnce = false;
    r.observeObservers(w, { onDisconnect() { if (discThrowOnce) { discThrowOnce = false; throw new Error("onDisconnect boom"); } } });
    const c = r.computed(() => sel() ? w() : -1);
    let schedThrowOnce = false, bodyThrowOnce = false;
    const makeZ = () => {
        const opts = V === "SCHED" ? { scheduler(run) { zCalls++; log.push("Zsched"); if (schedThrowOnce) { schedThrowOnce = false; throw new Error("sched boom"); } run(); } } : undefined;
        return r.effect(() => {
            zRuns++; log.push("Z");
            if (V === "PREWALK") zSeen.push(c()); else zSeen.push(w());
            if (V === "BODY" && bodyThrowOnce) { bodyThrowOnce = false; throw new Error("body boom"); }
        }, opts);
    };
    r.effect(() => {
        s(); log.push("A");
        if (!armed) return;
        armed = false;
        const yId = ok(() => r.describe(yHandle).id);
        yHandle();
        r.runWithOwner(null, () => { zHandle = makeZ(); });
        const zId = ok(() => r.describe(zHandle).id);
        recycled = { yId, zId };
        if (V === "PREWALK") sel.set(false); else w.set(1);
        if (V === "SCHED") schedThrowOnce = true;
        if (V === "PREWALK") discThrowOnce = true;
        if (V === "BODY") bodyThrowOnce = true;
    });
    yHandle = r.effect(() => { s(); log.push("Y"); });
    log.length = 0;
    armed = true;
    const t1 = ok(() => s.set(1));
    const truth = () => V === "PREWALK" ? (sel.peek() ? w.peek() : -1) : w.peek();
    const stale = () => zSeen[zSeen.length - 1] !== truth();
    const atFlushEnd = { zRuns, zCalls, zSeen: zSeen.slice(), truth: truth(), stale: stale(), log: log.slice(), snap: snapOf(r) };
    log.length = 0;
    const t2 = ok(() => s.set(2));
    const afterUnrelated = { zRuns, zCalls, stale: stale(), log: log.slice(), snap: snapOf(r) };
    log.length = 0;
    const t3 = ok(() => V === "PREWALK" ? sel.set(true) : w.set(2));
    const afterNextChange = { zRuns, zCalls, zSeen: zSeen.slice(), truth: truth(), stale: stale(), log: log.slice(), snap: snapOf(r) };
    return { recycled, t1, atFlushEnd, t2, afterUnrelated, t3, afterNextChange };
}
// R4 (S3 regression guard).
function shapeR4(M) {
    const r = M.createRegistry();
    const s = r.signal(0);
    let runs = 0, wrote = false;
    const seen = [];
    const K = r.computed(() => { const v = s(); if (v === 5 && !wrote) { wrote = true; s.set(6); } return v; });
    r.effect(() => { runs++; seen.push(s()); K(); if (runs === 2) throw new Error("boom"); });
    let threw = null;
    try { s.set(5); } catch (e) { threw = e && e.message; }
    return { threw, runs, seen, s: s.peek(), snap: snapOf(r) };
}
// R5 (G1 x G2, Fable p4 EFFECT boom=true).
function shapeR5(M) {
    const r = M.createRegistry();
    const t = r.signal(0), a = r.signal(0), w = r.signal(0), b = r.signal(0);
    let first = true, boom = false; const seen = [];
    r.observeObservers(b, { onDisconnect() { if (boom) throw new Error("epilogue boom"); } });
    const K = r.computed(() => { const v = w(); if (v > 0) a.set(v); return v; });
    r.effect(() => { t(); const av = a(); K(); if (first) b(); seen.push(av); });
    first = false; boom = true;
    const t1 = tryIt(() => r.batch(() => { w.set(5); t.set(1); }));
    boom = false;
    return { t1, a: a.peek(), lastSeen: seen[seen.length - 1], runs: seen.length };
}
// R6 fixture: ONE registry with a pre-walk thrower E1, a scheduler thrower E2, a body thrower E3 on one trigger (creation order E1, E2, E3).
function makeR6(M) {
    const r = M.createRegistry();
    const sel = r.signal(true), p = r.signal(1);
    let boom = false, cur = null;
    r.observeObservers(p, { onDisconnect() { if (boom) throw cur[0]; } });
    const C = r.computed(() => sel() ? p() : -1);
    r.effect(() => { C(); });
    r.effect(() => { sel(); }, { scheduler(run) { if (boom) throw cur[1]; run(); } });
    r.effect(() => { sel(); if (boom) throw cur[2]; });
    function flush3(errs) {
        cur = errs; boom = true;
        const c = caught(() => sel.set(false));
        boom = false;
        const after = tryIt(() => sel.set(true));
        cur = null;
        return { c, after };
    }
    return { r, flush3 };
}
// R8 (c): a sync scheduler runs the thunk, writes a dependency, then throws.
function shapeR8c(M) {
    const r = M.createRegistry();
    const s = r.signal(0), d = r.signal(0);
    let runs = 0, sawD = -1, boom = false;
    r.effect(() => { runs++; s(); sawD = d(); }, { scheduler(run) { run(); if (boom) { boom = false; d.set(1); throw new Error("sched boom"); } } });
    boom = true;
    let threw = null; try { s.set(1); } catch (e) { threw = e && e.message; }
    const t = { threw, runs, sawD, snap: snapOf(r) };
    s.set(2);
    return { ...t, runsAfterNextWrite: runs, sawDAfterNextWrite: sawD, snapAfter: snapOf(r) };
}
// R8 (d): an effect re-queued for a stale read (evalVersion 0) whose sync scheduler throws on the next pass.
function shapeR8d(M) {
    const r = M.createRegistry();
    const s = r.signal(0);
    let runs = 0, calls = 0, wrote = false;
    const seen = [];
    const K = r.computed(() => { const v = s(); if (v === 5 && !wrote) { wrote = true; s.set(6); } return v; });
    r.effect(() => { runs++; seen.push(s()); K(); }, { scheduler(run) { calls++; if (calls === 3) throw new Error("sched boom"); run(); } });
    let threw = null; try { s.set(5); } catch (e) { threw = e && e.message; }
    const before = calls, runsBefore = runs;
    s.set(7); s.set(8);
    return { threw, runsAtThrow: runsBefore, seen, schedulerCallsAfter: calls - before, runsAfter2Writes: runs, snap: snapOf(r) };
}
// L3 (LEDGER #66): batch{ s.set(B); C(); s.set(D) } with equals(A, D) throwing; signal and signalBox forms.
function shapeL3(M, form) {
    const A = { t: "A" }, B = { t: "B" }, D = { t: "D" };
    const nm = (v) => (v && v.t) || String(v);
    const eq = (a, b) => { if ((a === A && b === D) || (a === D && b === A)) throw new Error("eq-AD-boom"); return Object.is(a, b); };
    const r = M.createRegistry();
    const s = form === "signal" ? r.signal(A, { equals: eq }) : r.signalBox(A, { equals: eq });
    const get = form === "signal" ? () => s() : () => s.get();
    const other = r.signal(0);
    const C = r.computed(() => "C(" + nm(get()) + ")");
    r.effect(() => { get(); });
    C();
    let cInBatch = null, threw = null;
    try { r.batch(() => { s.set(B); cInBatch = C(); s.set(D); }); } catch (e) { threw = e && e.message; }
    const sNow = nm(s.peek());
    const cAfter = tryIt(() => C());
    other.set(1);
    return { threw, sNow, cInBatch, cAfter, cAfterUnrelated: tryIt(() => C()) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("R1 p1 variant B: pre-walk throw must not strand the QUEUED bit (M1 DROP, M2 EQZERO)", () => {
    it("LIVE: {t1 THROW, runsAfterThrow 1, runsAfter3Writes 4, cNow -1, snap ok}", () => {
        assert.deepStrictEqual(shapeR1(ME), { t1: "THROW onDisconnect boom", runsAfterThrow: 1, laterWritesThrew: false, runsAfter3Writes: 4, cNow: -1, snap: "ok" });
    });
    it("OLD (frozen G1): runsAfter3Writes 1, snap pending", () => {
        assert.deepStrictEqual(shapeR1(G1), { t1: "THROW onDisconnect boom", runsAfterThrow: 1, laterWritesThrew: false, runsAfter3Writes: 1, cNow: -1, snap: PENDING });
    });
});

describe("R2 p1 variant C: a throwing sync scheduler must not strand the effect (M1, M2)", () => {
    it("LIVE: {runsAfterThrow 1, runsAfter2Writes 3, schedulerCallsAfter 2, snap ok}", () => {
        assert.deepStrictEqual(shapeR2(ME), { t1: "THROW scheduler boom", runsAfterThrow: 1, runsAfter2Writes: 3, schedulerCallsAfter: 2, snap: "ok" });
    });
    it("OLD (frozen G1): 1 / 0 calls / pending", () => {
        assert.deepStrictEqual(shapeR2(G1), { t1: "THROW scheduler boom", runsAfterThrow: 1, runsAfter2Writes: 1, schedulerCallsAfter: 0, snap: PENDING });
    });
});

describe("R3 KNOWN residual (a): a deferred thunk run outside a flush whose pre-walk throws strands the effect (G1-equal; later engine unit)", () => {
    const want = { t1: "THROW onDisconnect boom", runsAfterThrow: 1, runsAfter2Writes: 1, schedulerCallsAfter: 0, cNow: 10, snap: PENDING };
    it("KNOWN LIVE: runsAfter2Writes 1, 0 scheduler calls, snap pending", () => { assert.deepStrictEqual(shapeR3(ME), want); });
    it("KNOWN frozen G1: same tuple", () => { assert.deepStrictEqual(shapeR3(G1), want); });
});

describe("R3b pend() inside a batch, stale-read body, then a throw (regression pin, live and G1)", () => {
    const want = { tb: "THROW boom", schedulerCallsAtBatchClose: 1, pendingAfterBatch: true, runs: 3, seen: [0, 5, 6], s: 6, snap: "ok" };
    it("PIN live: exactly +1 scheduler call at batch close, the re-run happens", () => { assert.deepStrictEqual(shapeR3b(ME), want); });
    it("PIN frozen G1: same tuple", () => { assert.deepStrictEqual(shapeR3b(G1), want); });
});

describe("n2 store-throw: a second scheduler call in the same pending period, no double run (runs and seen identical)", () => {
    it("LIVE: pendingBeforeDrain 2, calls 3 / 4, runs 2 / 3, seen [0,2] / [0,2,3]", () => {
        assert.deepStrictEqual(shapeStore(ME), { t1: "THROW sched boom", pendingBeforeDrain: 2, mid: { runs: 2, calls: 3, seen: [0, 2], snap: "ok" }, end: { runs: 3, calls: 4, seen: [0, 2, 3], snap: "ok" } });
    });
    it("OLD (frozen G1): pendingBeforeDrain 1, calls 2 / 3, same runs and seen", () => {
        assert.deepStrictEqual(shapeStore(G1), { t1: "THROW sched boom", pendingBeforeDrain: 1, mid: { runs: 2, calls: 2, seen: [0, 2], snap: "ok" }, end: { runs: 3, calls: 3, seen: [0, 2, 3], snap: "ok" } });
    });
});

describe("(b) KNOWN: a recycled slot's stale entry serves a QUEUED resident early and the throw skips its live entry (M4 catch-arm clear)", () => {
    const rec = { yId: 6, zId: 7 };
    // exact probed tuples: .handoff/audf/g2/b0r/out/b.G1.txt (old) and b.U.txt (live)
    const L = {
        SCHED: { recycled: rec, t1: "THROW sched boom",
            atFlushEnd: { zRuns: 1, zCalls: 2, zSeen: [0], truth: 1, stale: true, log: ["A", "Zsched", "Z", "Zsched"], snap: "ok" }, t2: "ok",
            afterUnrelated: { zRuns: 1, zCalls: 2, stale: true, log: ["A"], snap: "ok" }, t3: "ok",
            afterNextChange: { zRuns: 2, zCalls: 3, zSeen: [0, 2], truth: 2, stale: false, log: ["Zsched", "Z"], snap: "ok" } },
        PREWALK: { recycled: rec, t1: "THROW onDisconnect boom",
            atFlushEnd: { zRuns: 1, zCalls: 0, zSeen: [0], truth: -1, stale: true, log: ["A", "Z"], snap: "ok" }, t2: "ok",
            afterUnrelated: { zRuns: 1, zCalls: 0, stale: true, log: ["A"], snap: "ok" }, t3: "ok",
            afterNextChange: { zRuns: 2, zCalls: 0, zSeen: [0, 0], truth: 0, stale: false, log: ["Z"], snap: "ok" } },
    };
    const O = {
        SCHED: { recycled: rec, t1: "THROW sched boom",
            atFlushEnd: { zRuns: 2, zCalls: 3, zSeen: [0, 1], truth: 1, stale: false, log: ["A", "Zsched", "Z", "Zsched", "Zsched", "Z"], snap: "ok" }, t2: "ok",
            afterUnrelated: { zRuns: 2, zCalls: 3, stale: false, log: ["A"], snap: "ok" }, t3: "ok",
            afterNextChange: { zRuns: 3, zCalls: 4, zSeen: [0, 1, 2], truth: 2, stale: false, log: ["Zsched", "Z"], snap: "ok" } },
        PREWALK: { recycled: rec, t1: "THROW onDisconnect boom",
            atFlushEnd: { zRuns: 2, zCalls: 0, zSeen: [0, -1], truth: -1, stale: false, log: ["A", "Z", "Z"], snap: "ok" }, t2: "ok",
            afterUnrelated: { zRuns: 2, zCalls: 0, stale: false, log: ["A"], snap: "ok" }, t3: "ok",
            afterNextChange: { zRuns: 3, zCalls: 0, zSeen: [0, -1, 0], truth: 0, stale: false, log: ["Z"], snap: "ok" } },
    };
    const BODY = { recycled: rec, t1: "THROW body boom",
        atFlushEnd: { zRuns: 2, zCalls: 0, zSeen: [0, 1], truth: 1, stale: false, log: ["A", "Z", "Z"], snap: "ok" }, t2: "ok",
        afterUnrelated: { zRuns: 2, zCalls: 0, stale: false, log: ["A"], snap: "ok" }, t3: "ok",
        afterNextChange: { zRuns: 3, zCalls: 0, zSeen: [0, 1, 2], truth: 2, stale: false, log: ["Z"], snap: "ok" } };
    for (const V of ["SCHED", "PREWALK"]) {
        it("KNOWN LIVE " + V + ": the early serve's throw skips Z's live entry; Z stays stale at flush end (snapshot ok) until its dep changes", () => { assert.deepStrictEqual(shapeB(ME, V), L[V]); });
        it("OLD (frozen G1) " + V + ": Z runs at its live entry, never stale", () => { assert.deepStrictEqual(shapeB(G1, V), O[V]); });
    }
    it("PIN BODY live: the body throw is after the QUEUED clear, nothing to skip", () => { assert.deepStrictEqual(shapeB(ME, "BODY"), BODY); });
    it("PIN BODY frozen G1: same tuple", () => { assert.deepStrictEqual(shapeB(G1, "BODY"), BODY); });
});

describe("R4 S3 regression guard: a stale-read re-queue survives the throw (M2 EQZERO, M3 ALWAYS; same tuple on old by design)", () => {
    const want = { threw: "boom", runs: 3, seen: [0, 5, 6], s: 6, snap: "ok" };
    it("LIVE", () => { assert.deepStrictEqual(shapeR4(ME), want); });
    it("PIN frozen G1", () => { assert.deepStrictEqual(shapeR4(G1), want); });
    it("PIN pre-G1 5af14f0b", () => { assert.deepStrictEqual(shapeR4(PRE), want); });
});

describe("R5 G1 x G2 cross tooth: epilogue throw with a stale read (M3 ALWAYS -> runs 2)", () => {
    it("LIVE: {t1 THROW epilogue boom, a 5, lastSeen 5, runs 3}", () => {
        assert.deepStrictEqual(shapeR5(ME), { t1: "THROW epilogue boom", a: 5, lastSeen: 5, runs: 3 });
    });
    it("OLD (pre-G1 5af14f0b): lastSeen 0, runs 2", () => {
        assert.deepStrictEqual(shapeR5(PRE), { t1: "THROW epilogue boom", a: 5, lastSeen: 0, runs: 2 });
    });
});

describe("R6 which error wins (LEDGER #64), errors pinned by identity in QUEUE order (M6 SPLICE-OFF1)", () => {
    for (const [label, M] of [["LIVE", ME], ["PIN frozen G1", G1]]) {
        it(label + " R6a: AggregateError 'Effects threw during flush', errors === [err2 sched, err3 body, err1 pre-walk]", () => {
            const { flush3 } = makeR6(M);
            const e = [new Error("err1 prewalk"), new Error("err2 scheduler"), new Error("err3 body")];
            const { c, after } = flush3(e);
            assert.ok(c instanceof AggregateError);
            assert.equal(c.message, "Effects threw during flush");
            assert.equal(c.errors.length, 3);
            assert.strictEqual(c.errors[0], e[1]);
            assert.strictEqual(c.errors[1], e[2]);
            assert.strictEqual(c.errors[2], e[0]);
            assert.equal(after, undefined);
        });
        it(label + " R6b: the next flush with 2 throwers is exactly [err4, err5]", () => {
            const { r, flush3 } = makeR6(M);
            flush3([new Error("a1"), new Error("a2"), new Error("a3")]);
            const t = r.signal(0);
            const e45 = [new Error("err4"), new Error("err5")];
            r.effect(() => { if (t() === 1) throw e45[0]; });
            r.effect(() => { if (t() === 1) throw e45[1]; });
            const c = caught(() => t.set(1));
            assert.ok(c instanceof AggregateError);
            assert.equal(c.message, "Effects threw during flush");
            assert.equal(c.errors.length, 2);
            assert.strictEqual(c.errors[0], e45[0]);
            assert.strictEqual(c.errors[1], e45[1]);
        });
        it(label + " R6c: a single thrower throws that same error (===), not an AggregateError", () => {
            const r = M.createRegistry();
            const u = r.signal(0), e6 = new Error("err6");
            r.effect(() => { if (u() === 1) throw e6; });
            const c = caught(() => u.set(1));
            assert.strictEqual(c, e6);
            assert.equal(c instanceof AggregateError, false);
        });
        it(label + " R6d: a pass-2 error comes after the pass-1 error even when the pass-2 effect was created first", () => {
            const r = M.createRegistry();
            const v = r.signal(0), w = r.signal(0);
            const eAB = [new Error("errA pass1"), new Error("errB pass2")];
            r.effect(() => { if (w() === 1) throw eAB[1]; });
            r.effect(() => { if (v() === 1) { w.set(1); throw eAB[0]; } });
            const c = caught(() => v.set(1));
            assert.ok(c instanceof AggregateError);
            assert.equal(c.message, "Effects threw during flush");
            assert.equal(c.errors.length, 2);
            assert.strictEqual(c.errors[0], eAB[0]);
            assert.strictEqual(c.errors[1], eAB[1]);
        });
    }
});

// R7: 32 cycles of the R6 3-thrower flush on one long-lived registry; every thrown error tracked by lite-leak (tag = a number, no cleanup).
// The measurement needs gc(), and npm test / CI run without --expose-gc, so it runs in a child started with --expose-gc (package convention,
// test/100-soak-os.test.mjs): the child prints ONE JSON line; the parent fails closed on a non-zero status, a signal, a spawn error or a timeout.
const nap = (ms) => new Promise((res) => setTimeout(res, ms));
const settle = async () => { globalThis.gc(); await nap(0); globalThis.gc(); };
async function shapeR7(M) {
    const { flush3 } = makeR6(M);
    const tracker = createLeakTracker({ name: "r7", onLeak() {}, onWarning() {} });
    let idc = 0;
    const hist = {};
    // one function per cycle so no error stays reachable from this async frame (the probe's cycle() shape)
    const cycle = () => {
        const errs = [new Error("c1"), new Error("c2"), new Error("c3")];
        for (const e of errs) tracker.track(e, null, ++idc);
        const { c } = flush3(errs);
        const n = c instanceof AggregateError ? c.errors.length : (c === null ? 0 : 1);
        hist[n] = (hist[n] || 0) + 1;
    };
    for (let k = 0; k < 32; k++) cycle();
    for (let i = 0; i < 30 && tracker.size() > 0; i++) { await settle(); await nap(10); }
    return { tracked: idc, size: tracker.size(), hist };
}
async function ctlR7() {
    const ctl = createLeakTracker({ name: "r7ctl", onLeak() {}, onWarning() {} });
    const HELD = [new Error("h1"), new Error("h2"), new Error("h3")];
    HELD.forEach((e, i) => ctl.track(e, null, i + 1));
    for (let i = 0; i < 5; i++) { await settle(); await nap(10); }
    return { size: ctl.size(), held: HELD.length };
}
const R7_CHILD = [
    'import assert from "node:assert/strict";',
    'import { readFileSync, existsSync } from "node:fs";',
    'import { dirname } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    "import { createLeakTracker } from " + JSON.stringify(import.meta.resolve("@zakkster/lite-leak")) + ";",
    "const WATCH_LINE = " + JSON.stringify(WATCH_LINE) + ";",
    'if (typeof globalThis.gc !== "function") { console.log(JSON.stringify({ error: "no gc" })); process.exit(3); }',
    "const tryIt = " + tryIt.toString(), "const caught = " + caught.toString(), loadBuild.toString(), "const nap = " + nap.toString(), "const settle = " + settle.toString(), makeR6.toString(), shapeR7.toString(), ctlR7.toString(),
    "const mode = process.argv[process.argv.length - 2], path = process.argv[process.argv.length - 1];",
    'const out = mode === "ctl" ? await ctlR7() : await shapeR7(await loadBuild(path));',
    "console.log(JSON.stringify(out));",
].join("\n");
function runR7(mode, path) {
    const r = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=256", "--input-type=module", "-e", R7_CHILD, mode, path],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 120000, killSignal: "SIGKILL" });
    assert.equal(r.error, undefined, "R7 child spawn error: " + (r.error && r.error.message));
    assert.equal(r.signal, null, "R7 child killed by signal " + r.signal + ": " + r.stderr);
    assert.equal(r.status, 0, "R7 child exit " + r.status + ": " + r.stderr + r.stdout);
    return JSON.parse(r.stdout.trim().split("\n").pop());
}
describe("R7 retention: thrown flush errors are released (M5 SLICE-NONULL -> size >= 3)", () => {
    it("must-fail control: 3 errors held in an array stay tracked (size 3)", () => {
        assert.deepStrictEqual(runR7("ctl", ""), { size: 3, held: 3 });
    });
    it("LIVE: 32 cycles, 96 tracked, 3 errors thrown every cycle, tracker.size() 0", () => {
        assert.deepStrictEqual(runR7("ME", ENGINE_PATH), { tracked: 96, size: 0, hist: { 3: 32 } });
    });
    it("OLD (frozen G1): E1 and E2 wedge after cycle 1, so 1 error per cycle (31) + 3 once; still size 0", () => {
        assert.deepStrictEqual(runR7("G1", G1_PATH), { tracked: 96, size: 0, hist: { 1: 31, 3: 1 } });
    });
});

// R1w (GT0): the catch-arm guard `evalVersion !== 0` must hold for a wrapped (negative int32) stamp. Shape = R1 on a registry restored with every
// stamp shifted past 2^31 (zeros stay 0; signal markEpoch stays 0). A `> 0` guard would skip the QUEUED clear and wedge the effect.
function shapeR1w(M) {
    const r0 = M.createRegistry();
    const sel0 = r0.signal(true), p0 = r0.signal(1);
    const C0 = r0.computed(() => sel0() ? p0() : -1);
    r0.effect(() => { C0(); });
    const snap = r0.snapshot();
    const sh = (v) => v === 0 ? 0 : ((v + 0x80000000) | 0) || 1;
    for (const n of snap.nodes) {
        n.version = sh(n.version); n.evalVersion = sh(n.evalVersion);
        if (n.kind !== "signal") n.markEpoch = (n.markEpoch + 0x80000000) | 0;
    }
    snap.gv = sh(snap.gv);
    const H = {};
    let runs = 0;
    const ids = snap.nodes.map((n) => n.id);
    const r = M.restore(snap, { handles: H, fnsById: { [ids[2]]: () => H[ids[0]]() ? H[ids[1]]() : -1, [ids[3]]: () => { H[ids[2]](); runs++; } } });
    const sel = H[ids[0]], pp = H[ids[1]];
    let boom = true;
    r.observeObservers(pp, { onDisconnect() { if (boom) throw new Error("onDisconnect boom"); } });
    const negative = snap.gv < 0 && snap.nodes[3].evalVersion < 0;
    const t1 = tryIt(() => sel.set(false));
    boom = false;
    const before = runs;
    tryIt(() => sel.set(true)); tryIt(() => pp.set(10)); tryIt(() => sel.set(false));
    return { negative, t1, runsAfterThrow: before, runsAfter3Writes: runs, snap: snapOf(r) };
}
describe("R1w wrap: the catch-arm guard holds for negative (post-2^31) stamps (GT0)", () => {
    it("LIVE: the throw leaves no stranded QUEUED bit on shifted stamps; 3 later writes run 3 times, snapshot ok", () => {
        assert.deepStrictEqual(shapeR1w(ME), { negative: true, t1: "THROW onDisconnect boom", runsAfterThrow: 0, runsAfter3Writes: 3, snap: "ok" });
    });
    it("OLD (frozen G1): the effect stays wedged, 0 runs, snapshot pending", () => {
        assert.deepStrictEqual(shapeR1w(G1), { negative: true, t1: "THROW onDisconnect boom", runsAfterThrow: 0, runsAfter3Writes: 0, snap: PENDING });
    });
});

// R6e (SPLICEALL, SPLICEP1): after an abnormal exit (CycleError, buffer nulled, count kept 3) the next 2-thrower flush's aggregate holds exactly 2 errors.
function shapeR6e(M) {
    const r = M.createRegistry();
    const x = r.signal(0), a = r.signal(0), b = r.signal(0), y = r.signal(0);
    let stop = true;
    for (let i = 0; i < 3; i++) r.effect(() => { if (x() > 0) throw new Error("T" + i); });
    r.effect(() => { const v = a(); if (!stop) b.set(v + 1); });
    r.effect(() => { const v = b(); if (!stop) a.set(v + 1); });
    for (let i = 0; i < 2; i++) r.effect(() => { if (y() > 0) throw new Error("U" + i); });
    stop = false;
    const c1 = caught(() => r.batch(() => { x.set(1); a.set(100); }));
    stop = true;
    const c = caught(() => y.set(1));
    return { t1: c1 && c1.message, t2: c && c.message, errs: c && c.errors ? c.errors.map((z) => z === null ? "null" : z === undefined ? "undef" : z.message) : null };
}
describe("R6e the aggregate tail removes exactly flushErrorCount errors after an abnormal exit (SPLICEALL, SPLICEP1)", () => {
    const want = { t1: "CycleError: flush passes exceeded", t2: "Effects threw during flush", errs: ["U0", "U1"] };
    it("PIN ME: aggregate errors are exactly [U0, U1]", () => { assert.deepStrictEqual(shapeR6e(ME), want); });
    it("PIN frozen G1: same tuple", () => { assert.deepStrictEqual(shapeR6e(G1), want); });
});

describe("R8 KNOWN residuals (full tuples)", () => {
    it("(c) LIVE: a sync scheduler that runs then writes a dep then throws loses one run; recovers on the next write", () => {
        assert.deepStrictEqual(shapeR8c(ME), { threw: "sched boom", runs: 2, sawD: 0, snap: "ok", runsAfterNextWrite: 3, sawDAfterNextWrite: 1, snapAfter: "ok" });
    });
    it("(c) OLD (frozen G1 / pre-G1): the run is kept, runs 3, sawD 1", () => {
        const want = { threw: "sched boom", runs: 3, sawD: 1, snap: "ok", runsAfterNextWrite: 4, sawDAfterNextWrite: 1, snapAfter: "ok" };
        assert.deepStrictEqual(shapeR8c(G1), want);
        assert.deepStrictEqual(shapeR8c(PRE), want);
    });
    const wantD = { threw: "sched boom", runsAtThrow: 2, seen: [0, 5], schedulerCallsAfter: 0, runsAfter2Writes: 2, snap: PENDING };
    it("(d) KNOWN LIVE: a stale-read re-queue whose scheduler throws on the next pass stays stranded", () => { assert.deepStrictEqual(shapeR8d(ME), wantD); });
    it("(d) KNOWN frozen G1: same tuple", () => { assert.deepStrictEqual(shapeR8d(G1), wantD); });
});

// LEDGER #66 / D-b195-4 A: L3 is a separate later engine unit; today's behaviour is pinned (the computed that saw B stays stale although s is D).
describe("L3 KNOWN (LEDGER #66): a throwing equals in a batch set-back leaves a reader stale", () => {
    const want = { threw: "eq-AD-boom", sNow: "D", cInBatch: "C(B)", cAfter: "C(B)", cAfterUnrelated: "C(B)" };
    for (const form of ["signal", "box"]) {
        it(form + " LIVE", () => { assert.deepStrictEqual(shapeL3(ME, form), want); });
        it(form + " frozen G1", () => { assert.deepStrictEqual(shapeL3(G1, form), want); });
    }
});
