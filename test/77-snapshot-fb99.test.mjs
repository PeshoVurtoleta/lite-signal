// 77-snapshot-fb99.test.mjs -- A9 round 6 (burst 100, batch B1): F-b99-1 red-first rows for
// .handoff/PLAN-0s-a9-f.md TASKS 1-5 + ADDENDUM 1-5 (D-L stamps copied, restoreSeededBody gone; D-M record
// evalVersion / markEpoch + snapshot gv; D-N Scan D dropped; D-O snapshot nextId). Every row must fail on the
// b100-before build. LS_SIG=<path> runs the rows against another Signal.js build (red-first log).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const SIG = process.env.LS_SIG ? pathToFileURL(process.env.LS_SIG).href : new URL("../Signal.js", import.meta.url).href;
const { createRegistry } = await import(SIG);

// Live vs restored: build(r, log) returns { handles, fns(log, H, R), script(H, r) }; the script runs on both and
// the logs (and a re-snapshot of both) must agree.
function pair(build) {
    const r = createRegistry(), logL = [];
    const W = build(r, logL);
    const snap = r.snapshot();
    const logR = [], H = {}, fnsById = {};
    let r2 = null;
    const R2H = {};
    const mk = W.fns(logR, () => R2H, () => r2);
    for (const k of Object.keys(mk)) fnsById[r.nodeId(W.handles[k])] = mk[k];
    r2 = r.restore(snap, { fnsById, handles: H });
    for (const k of Object.keys(W.handles)) R2H[k] = H[r.nodeId(W.handles[k])];
    assert.deepStrictEqual(r2.snapshot(), snap, "restored state re-snapshots exactly (stamps incl.)");
    const n0 = logL.length;
    W.script(W.handles, r); W.script(R2H, r2);
    return { snap, r, r2, live: logL.slice(n0), restored: logR };
}

describe("F-b99-1: restored effects keep live's stamps (DX units)", () => {
    test("g1766: effect absorbs its own write, dep re-read clean -> reverted batch write re-runs it", () => {
        const P = pair((r, log) => {
            const s = r.signal(1), x = r.signal(0);
            const c = r.computed(() => s() * 2);
            const e = r.effect(() => { log.push(c()); r.untrack(() => { if (s() < 2) s.set(2); }); });
            x.set(1);
            r.untrack(() => c());
            return {
                handles: { s, x, c, e },
                fns: (L, H, R) => ({ c: () => H().s() * 2, e: () => { L.push(H().c()); R().untrack(() => { if (H().s() < 2) H().s.set(2); }); } }),
                script: (H, rr) => { rr.batch(() => { H.s.set(3); H.s.set(2); }); },
            };
        });
        assert.deepEqual(P.live, [4]);
        assert.deepEqual(P.restored, P.live);
    });
    test("g558: dep left dirty (seeded), untracked re-read then reverted write re-runs the effect", () => {
        const P = pair((r, log) => {
            const s = r.signal(2), x = r.signal(0);
            const c = r.computed(() => s() * 2);
            const e = r.effect(() => { log.push(c() + s()); r.untrack(() => { if (s() < 4) s.set(4); }); });
            x.set(1);
            return {
                handles: { s, x, c, e },
                fns: (L, H, R) => ({ c: () => H().s() * 2, e: () => { L.push(H().c() + H().s()); R().untrack(() => { if (H().s() < 4) H().s.set(4); }); } }),
                script: (H, rr) => { rr.untrack(() => H.c()); rr.batch(() => { H.s.set(3); H.s.set(4); }); },
            };
        });
        assert.deepEqual(P.live, [12]);
        assert.deepEqual(P.restored, P.live);
    });
    test("g230: run order -- the stale-absorbed effect runs first, then again after another effect writes", () => {
        const P = pair((r, log) => {
            const s = r.signal(1), x = r.signal(0), u = r.signal(0);
            const c = r.computed(() => s() * 2);
            const e = r.effect(() => { log.push("e" + c()); r.untrack(() => { if (s() < 2) s.set(2); }); });
            const f = r.effect(() => { if (u() === 1) r.untrack(() => s.set(5)); });
            x.set(1);
            r.untrack(() => c());
            return {
                handles: { s, x, u, c, e, f },
                fns: (L, H, R) => ({ c: () => H().s() * 2, e: () => { L.push("e" + H().c()); R().untrack(() => { if (H().s() < 2) H().s.set(2); }); },
                    f: () => { if (H().u() === 1) R().untrack(() => H().s.set(5)); } }),
                script: (H, rr) => { rr.batch(() => { H.s.set(3); H.s.set(2); H.u.set(1); }); },
            };
        });
        assert.deepEqual(P.live, ["e4", "e10"]);
        assert.deepEqual(P.restored, P.live);
    });
});

describe("D-N: a clean dep cycle live emits is restored, not refused (probe 0c)", () => {
    test("restore accepts; after s.set(1) the restored read fails like live (CycleError: Circular)", () => {
        const build = (r, H, out) => {
            const s = r.signal(0);
            const C = r.computed(() => { try { H.D(); } catch (e) { out.push("caught"); } return s(); });
            H.D = r.computed(() => C());
            H.s = s; H.C = C;
        };
        const r = createRegistry(), G = {}, out = [];
        build(r, G, out);
        assert.equal(G.C(), 0);
        const snap = r.snapshot();
        const cId = r.nodeId(G.C), dId = r.nodeId(G.D), sId = r.nodeId(G.s);
        assert.equal(snap.nodes.find((n) => n.id === cId).clean, true);
        assert.equal(snap.nodes.find((n) => n.id === dId).clean, true);
        const G2 = {}, out2 = [], K = {};
        const r2 = r.restore(snap, { fnsById: { [cId]: () => { try { G2.D(); } catch (e) { out2.push("caught"); } return G2.s(); }, [dId]: () => G2.C() }, handles: K });
        G2.s = K[sId]; G2.C = K[cId]; G2.D = K[dId];
        assert.equal(G2.C(), 0);
        G.s.set(1); G2.s.set(1);
        // FIX-T A1 / D2 = G-a (b102, LEDGER #42): the cyclic pre-walk throws CycleError (RangeError until b101).
        assert.throws(() => G.C(), (e) => !(e instanceof RangeError) && /^CycleError: Circular/.test(e.message));
        assert.throws(() => G2.C(), (e) => !(e instanceof RangeError) && /^CycleError: Circular/.test(e.message));
        assert.ok(r2);
    });
});

describe("D-M / D-O: clock, next id and stamps are recorded and restored exactly", () => {
    test("gv only: a reverted batch write moves the clock past every version; restored writes stamp like live", () => {
        const r = createRegistry();
        const a = r.signal(0), b = r.signal(0);
        r.batch(() => { a.set(1); a.set(0); });
        const snap = r.snapshot();
        assert.equal(typeof snap.gv, "number");
        assert.ok(snap.gv > Math.max(...snap.nodes.map((n) => n.version)));
        const H = {};
        const r2 = r.restore(snap, { fnsById: {}, handles: H });
        b.set(5); H[r.nodeId(b)].set(5);
        assert.deepEqual(r2.snapshot(), r.snapshot());
    });
    test("nextId: a node created after restore gets live's next id (disposed ids are not reused)", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const d1 = r.effect(() => { s(); }), d2 = r.effect(() => { s(); });
        d1(); d2();
        const snap = r.snapshot();
        assert.equal(typeof snap.nextId, "number");
        const r2 = r.restore(snap, { fnsById: {}, handles: {} });
        const nL = r.signal(0), nR = r2.signal(0);
        assert.equal(r2.nodeId(nR), r.nodeId(nL));
        assert.ok(r.nodeId(nL) > r.nodeId(s) + 1);
    });
    test("round trip: snapshot(restore(s)) deepStrictEquals s incl. gv / nextId / evalVersion / markEpoch (seeded dirty errored computed)", () => {
        const r = createRegistry();
        const s = r.signal(1), x = r.signal(0);
        const c = r.computed(() => { if (s() > 0) throw new Error("boom"); return s(); });
        const k = r.computed(() => x() + 1);
        assert.throws(() => c(), /boom/);
        const e = r.effect(() => { k(); });
        s.set(2); x.set(3); x.set(4);
        r.batch(() => { s.set(9); s.set(2); });
        const snap = r.snapshot();
        for (const key of ["gv", "nextId"]) assert.equal(typeof snap[key], "number", key);
        const cr = snap.nodes.find((n) => n.id === r.nodeId(c));
        assert.equal(cr.clean, false);
        assert.notEqual(cr.version, 0);
        assert.notEqual(cr.evalVersion, 0);
        assert.ok(((cr.markEpoch - cr.evalVersion) | 0) > 0);
        for (const n of snap.nodes) { assert.equal(typeof n.evalVersion, "number"); assert.equal(typeof n.markEpoch, "number"); }
        const fns = { [r.nodeId(c)]: () => 0, [r.nodeId(k)]: () => 0, [r.nodeId(e)]: () => {} };
        const r2 = r.restore(snap, { fnsById: fns, handles: {} });
        assert.deepStrictEqual(r2.snapshot(), snap);
    });
});

// A valid base snapshot: signal s, clean computed c, dirty computed d, effect e.
function base() {
    const r = createRegistry();
    const s = r.signal(1);
    const c = r.computed(() => s() + 1);
    const d = r.computed(() => s() * 3);
    const e = r.effect(() => { c(); });
    d();
    s.set(2);
    const snap = r.snapshot();
    const id = { s: r.nodeId(s), c: r.nodeId(c), d: r.nodeId(d), e: r.nodeId(e) };
    const fnsById = { [id.c]: () => 0, [id.d]: () => 0, [id.e]: () => {} };
    return { r, snap, id, fnsById };
}
function refuses(mut, re) {
    const B = base();
    const snap = structuredClone(B.snap);
    const rec = (k) => snap.nodes.find((n) => n.id === B.id[k]);
    mut(snap, rec, B);
    const H = {};
    assert.throws(() => B.r.restore(snap, { fnsById: B.fnsById, handles: H }), (err) => err instanceof TypeError && re.test(err.message));
    assert.deepEqual(Object.keys(H), []);
}

describe("D-M / D-O validation: TypeError before build, handles untouched", () => {
    const INT = [undefined, null, "1", 1.5, NaN, 2 ** 31, -(2 ** 31) - 1];
    test("gv: required int32, never 0", () => {
        for (const v of INT) refuses((s) => { if (v === undefined) delete s.gv; else s.gv = v; }, /gv/);
        refuses((s) => { s.gv = 0; }, /gv/);
    });
    test("nextId: required int32", () => {
        for (const v of INT) refuses((s) => { if (v === undefined) delete s.nextId; else s.nextId = v; }, /nextId/);
        refuses((s) => { s.nextId = -0; }, /nextId/);   // live never emits -0 (a -0 id re-snapshots as 0)
    });
    test("evalVersion / markEpoch: required int32 on every record", () => {
        for (const f of ["evalVersion", "markEpoch"]) for (const k of ["s", "c", "d", "e"]) for (const v of INT) {
            refuses((s, rec) => { if (v === undefined) delete rec(k)[f]; else rec(k)[f] = v; }, new RegExp(f));
        }
    });
    test("relations: signal stamps 0; effect evalVersion != 0; computed (ev 0) iff (version 0); clean matches the stamps", () => {
        // Each mutation keeps the clean bit consistent with the stamps, so only the named relation can refuse it.
        refuses((s, rec) => { rec("s").evalVersion = 1; rec("s").markEpoch = 2; }, /a signal is never evaluated/);
        refuses((s, rec) => { rec("s").markEpoch = 1; }, /a signal is never marked/);
        refuses((s, rec) => { rec("e").evalVersion = 0; rec("e").clean = false; }, /an effect has finished a run/);
        refuses((s, rec) => { rec("d").evalVersion = 0; rec("d").clean = false; }, /a computed is evaluated iff/);
        refuses((s, rec) => { rec("c").version = 0; }, /a computed is evaluated iff/);
        refuses((s, rec) => { rec("d").clean = true; }, /clean/);
        refuses((s, rec) => { rec("c").clean = false; }, /clean/);
        refuses((s, rec) => { rec("e").markEpoch = (rec("e").evalVersion + 1) | 0; }, /clean/);
    });
    test("each field is read once (getter)", () => {
        const B = base();
        const snap = structuredClone(B.snap);
        const reads = { gv: 0, nextId: 0, evalVersion: 0, markEpoch: 0, clean: 0 };
        for (const f of ["gv", "nextId"]) { const v = snap[f]; Object.defineProperty(snap, f, { get() { reads[f]++; return v; }, enumerable: true }); }
        const cr = snap.nodes.find((n) => n.id === B.id.c);
        for (const f of ["evalVersion", "markEpoch", "clean"]) { const v = cr[f]; Object.defineProperty(cr, f, { get() { reads[f]++; return v; }, enumerable: true }); }
        B.r.restore(snap, { fnsById: B.fnsById, handles: {} });
        assert.deepEqual(reads, { gv: 1, nextId: 1, evalVersion: 1, markEpoch: 1, clean: 1 });
    });
    // b100 B2 (task 9): the full matrix with EXACT messages, plus the getter column -- a getter that returns the bad
    // value is read once and refused (no second read that could return a good value after the check).
    const MSG = {
        gv: /^\[lite-signal\] restore: invalid gv .+ \(expected an int32 other than 0\)$/,
        nextId: /^\[lite-signal\] restore: invalid nextId .+ \(expected an int32\)$/,
        evalVersion: /^\[lite-signal\] restore: invalid evalVersion .+ at index \d+$/,
        markEpoch: /^\[lite-signal\] restore: invalid markEpoch .+ at index \d+$/,
    };
    test("matrix: gv / nextId x {missing, null, \"1\", 1.5, NaN, 2^31, -2^31-1} -> exact TypeError; getter returning each is read once", () => {
        for (const f of ["gv", "nextId"]) for (const v of INT) {
            refuses((s) => { if (v === undefined) delete s[f]; else s[f] = v; }, MSG[f]);
            let reads = 0;
            refuses((s) => { Object.defineProperty(s, f, { get() { reads++; return v; }, enumerable: true, configurable: true }); }, MSG[f]);
            assert.equal(reads, 1, f + " getter returning " + String(v) + " read " + reads + "x");
        }
        let reads = 0;
        refuses((s) => { Object.defineProperty(s, "gv", { get() { reads++; return 0; }, enumerable: true }); }, MSG.gv);
        assert.equal(reads, 1);
    });
    test("matrix: evalVersion / markEpoch on every record kind x the same values -> exact TypeError; getter returning each is read once", () => {
        for (const f of ["evalVersion", "markEpoch"]) for (const k of ["s", "c", "d", "e"]) for (const v of INT) {
            refuses((s, rec) => { if (v === undefined) delete rec(k)[f]; else rec(k)[f] = v; }, MSG[f]);
            let reads = 0;
            refuses((s, rec) => { Object.defineProperty(rec(k), f, { get() { reads++; return v; }, enumerable: true, configurable: true }); }, MSG[f]);
            assert.equal(reads, 1, k + "." + f + " getter returning " + String(v) + " read " + reads + "x");
        }
    });
    test("must-accept: far-floor negative evalVersion, stamps modularly ahead of gv, nextId at or below max id", () => {
        const B = base();
        const snap = structuredClone(B.snap);
        const d = snap.nodes.find((n) => n.id === B.id.d);
        d.evalVersion = -0x3FFFFFF0; d.markEpoch = -0x3FFFFFF0 + 5;
        const c = snap.nodes.find((n) => n.id === B.id.c);
        c.evalVersion = (snap.gv + 1000) | 0; c.markEpoch = c.evalVersion;
        snap.nextId = 1;
        const r2 = B.r.restore(snap, { fnsById: B.fnsById, handles: {} });
        assert.deepStrictEqual(r2.snapshot(), snap);
        // Stamps across the int32 wrap: modular compare says dirty (me - ev wraps to +32), a plain me <= ev says clean.
        const snap3 = structuredClone(B.snap);
        const d3 = snap3.nodes.find((n) => n.id === B.id.d);
        d3.evalVersion = 0x7FFFFFF0; d3.markEpoch = -0x7FFFFFF0; d3.clean = false;
        assert.deepStrictEqual(B.r.restore(snap3, { fnsById: B.fnsById, handles: {} }).snapshot(), snap3);
        const snap2 = structuredClone(B.snap);
        snap2.gv = -5; snap2.nextId = -(2 ** 31);
        assert.deepStrictEqual(B.r.restore(snap2, { fnsById: B.fnsById, handles: {} }).snapshot(), snap2);
    });
});
