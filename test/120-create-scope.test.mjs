/**
 * createScope (1.6.0, burst b202 batch H1).
 *
 * Oracle: .handoff/cs/PLAN-b202.md ASSERTIONS 1-10 + .handoff/PROPOSAL-createScope.md s2 (C1-C17) and the rulings
 * D-CS-2 (honour a dispose() made while fn runs), D-CS-3 (typeof check up front), D-CS-4 (always a root), D-CS-7.
 * Expected values come from the contract / the probe rows R1..R26 (probe-semantics.mjs, observed values in
 * out/semantics2-M2.txt) and hand-counted graphs, never from running the engine under test.
 *
 * Engine under test: ../Signal.js, or the absolute path in env CS_ENGINE (the mutant battery runs this file alone
 * against mutant engine dirs). The same path is used for the import AND for the source-text rows.
 *
 * Row labels (probe ids R1..R26 in the titles). Named mutants a row kills are in its title / comment:
 * MU-NOUNTRACK, MU-WRAPCALLSNOTHING, MU-NODETACH, MU-NOSTAMP, MU-NOOUTERRESTORE, MU-NOOWNERRESTORE, DEFERDROP,
 * DEFERDROP-W, HONOURINTRY, FNCHECKDROP, FNCHECKLATE; D-DELTA-1 text rows (SS-NOPUSH is test/117 A10, unchanged).
 * Nothing timed; no GC-count assertions (retention is asserted by node counts only).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ENG = process.env.CS_ENGINE || new URL("../Signal.js", import.meta.url).pathname;
const S = await import(pathToFileURL(ENG).href);
const SRC = readFileSync(ENG, "utf8");

const R = () => S.createRegistry();
const g = (r) => { const s = r.stats(); return { a: s.activeNodes, e: s.effects, c: s.computeds, s: s.signals, l: s.activeLinks }; };
const balanced = (r) => { const st = r.stats(); assert.equal(st.totalAllocations - st.totalDisposals, st.activeNodes); };
const TYPE_MSG = "[lite-signal] createScope: fn must be a function";

describe("rc port (4 tests, test/29 of 1.6.0-rc)", () => {
    it("returns fn result, owner runs once, inner effects track and are owned", () => {
        const ext = S.signal(1);
        const base = S.stats();
        let runs = 0, innerVal, scopeDispose;
        const ret = S.createScope((d) => {
            scopeDispose = d;
            runs++;
            ext();                                  // DIRECT read in fn body -> must be untracked
            S.signal(10);                           // signals are never owner-adopted
            const c = S.computed(() => ext() * 2);
            S.effect(() => { innerVal = c(); });
            return "RESULT";
        });
        assert.equal(ret, "RESULT");
        assert.equal(runs, 1);
        assert.equal(innerVal, 2);
        const created = S.stats();
        assert.equal(created.activeNodes - base.activeNodes, 4, "owner-effect + inner-effect + computed + signal");
        assert.equal(created.effects - base.effects, 2);
        assert.equal(created.computeds - base.computeds, 1);
        assert.equal(created.signals - base.signals, 1);
        ext.set(5);
        assert.equal(runs, 1, "scope owner did not re-run");
        assert.equal(innerVal, 10, "inner effect re-ran: 5*2");
        scopeDispose();
        const after = S.stats();
        assert.equal(after.effects - base.effects, 0);
        assert.equal(after.computeds - base.computeds, 0);
        assert.equal(after.signals - base.signals, 1, "un-adopted signal survives");
        assert.equal(after.activeNodes - base.activeNodes, 1);
        const frozen = innerVal;
        ext.set(99);
        assert.equal(innerVal, frozen, "disposed inner effect does not re-run");
        assert.equal(after.totalAllocations - after.totalDisposals, after.activeNodes);
        S.dispose(ext);
    });

    it("scope created inside a consumer effect SURVIVES the consumer's re-run", () => {
        const ext = S.signal(0), trigger = S.signal(0);
        let consumerRuns = 0, innerRuns = 0, scopeDispose;
        const stopConsumer = S.effect(() => {
            trigger();
            consumerRuns++;
            if (consumerRuns === 1) {
                S.createScope((d) => { scopeDispose = d; S.effect(() => { ext(); innerRuns++; }); });
            }
        });
        assert.equal(consumerRuns, 1);
        assert.equal(innerRuns, 1);
        trigger.set(1);
        assert.equal(consumerRuns, 2);
        ext.set(123);
        assert.equal(innerRuns, 2, "inner effect survived the consumer re-run and still fires");
        scopeDispose();
        ext.set(456);
        assert.equal(innerRuns, 2, "after scope dispose the inner effect is gone");
        stopConsumer();
        S.dispose(ext); S.dispose(trigger);
    });

    it("dispose is idempotent and introspection-stamped", () => {
        const base = S.stats();
        let scopeDispose;
        S.createScope((d) => { scopeDispose = d; S.effect(() => {}); });
        const desc = S.describe(scopeDispose);
        assert.equal(desc.kind, "effect");
        scopeDispose();
        const afterFirst = S.stats().activeNodes;
        scopeDispose();
        assert.equal(S.stats().activeNodes, afterFirst);
        assert.equal(S.stats().activeNodes - base.activeNodes, 0);
    });

    it("smoke: signal -> computed -> effect still reacts", () => {
        const a = S.signal(2);
        const b = S.computed(() => a() + 1);
        let seen;
        const stop = S.effect(() => { seen = b(); });
        assert.equal(seen, 3);
        a.set(9);
        assert.equal(seen, 10);
        stop(); S.dispose(a);
    });
});

describe("createScope contract rows (ASSERTIONS 1-8, 10)", () => {
    // A1 / R1: kills MU-NOUNTRACK (direct read of ext tracked -> owner re-runs), MU-WRAPCALLSNOTHING (fn never called).
    it("R1 result, owner runs once, untracked direct read, owned nodes: deltas [4,2,1,1] then [1,0,0,1]", () => {
        const r = R(); const ext = r.signal(1); const b = g(r); let runs = 0, inner, d;
        const ret = r.createScope((dd) => {
            d = dd; runs++; ext(); r.signal(10);
            const c = r.computed(() => ext() * 2);
            r.effect(() => { inner = c(); });
            return "RES";
        });
        const mid = g(r);
        assert.equal(ret, "RES");
        assert.equal(runs, 1);
        assert.equal(inner, 2);
        assert.deepEqual([mid.a - b.a, mid.e - b.e, mid.c - b.c, mid.s - b.s], [4, 2, 1, 1]);
        ext.set(5);
        assert.equal(runs, 1);
        assert.equal(inner, 10);
        d();
        const af = g(r);
        assert.deepEqual([af.a - b.a, af.e - b.e, af.c - b.c, af.s - b.s], [1, 0, 0, 1]);
        balanced(r);
    });

    // A2 / R2: kills MU-NODETACH (scope adopted by the consumer dies with its re-run / dispose).
    it("R2 scope made in a consumer effect survives the consumer re-run AND dispose", () => {
        const r = R(); const ext = r.signal(0), trig = r.signal(0); let cr = 0, ir = 0, d;
        const stop = r.effect(() => { trig(); cr++; if (cr === 1) r.createScope((dd) => { d = dd; r.effect(() => { ext(); ir++; }); }); });
        assert.equal(ir, 1);
        trig.set(1);
        assert.equal(cr, 2);
        assert.equal(ir, 1, "re-run of the consumer did not re-run or recreate the scope");
        ext.set(1);
        assert.equal(ir, 2, "survived the consumer re-run");
        stop();
        ext.set(2);
        assert.equal(ir, 3, "survived the consumer dispose");
        d();
        ext.set(3);
        assert.equal(ir, 3);
    });

    // A2 / R25: kills MU-NODETACH for a computed enclosing owner.
    it("R25 scope made inside a computed body survives its re-run and disposal", () => {
        const r = R(); const s = r.signal(0), t = r.signal(0); let d, ir = 0, made = 0;
        const c = r.computed(() => { t(); if (made++ === 0) r.createScope((dd) => { d = dd; r.effect(() => { s(); ir++; }); }); return 1; });
        c(); t.set(1); c();
        assert.equal(made, 2);
        assert.equal(ir, 1);
        r.dispose(c);
        s.set(1);
        assert.equal(ir, 2, "survived the computed re-run and disposal");
        d();
        s.set(2);
        assert.equal(ir, 2);
    });

    // A3 / R3 + R6: kills MU-NOSTAMP.
    it("R3 introspection stamp: describe kind, forEachOwned, ownerOf(inner)", () => {
        const r = R(); let d, h;
        r.createScope((dd) => { d = dd; h = r.computed(() => 1); h(); });
        assert.equal(r.describe(d).kind, "effect");
        const owned = [];
        r.forEachOwned(d, (x) => owned.push(x.kind));
        assert.deepEqual(owned, ["computed"]);
        assert.equal(r.ownerOf(h).id, r.nodeId(d));
        assert.equal(typeof r.nodeId(d), "number");
    });

    // A3 / R6.
    it("R6 getOwner in fn = scope owner; isTracking false; runWithOwner adopts; onCleanup in fn runs on dispose", () => {
        const r = R(); let d, owner, trk; let cleaned = 0;
        r.createScope((dd) => { d = dd; owner = r.getOwner(); trk = r.isTracking(); r.onCleanup(() => cleaned++); });
        assert.equal(owner.id, r.nodeId(d));
        assert.equal(trk, false);
        let late;
        r.runWithOwner(owner, () => { late = r.effect(() => {}); });
        assert.equal(r.ownerOf(late).id, owner.id);
        const b = g(r); d(); const a = g(r);
        assert.equal(cleaned, 1);
        assert.equal(b.e - a.e, 2, "owner + late-adopted effect disposed");
    });

    it("R4 dispose idempotent, dispose(api) on the disposer", () => {
        const r = R(); const b = g(r); let d;
        r.createScope((dd) => { d = dd; r.effect(() => {}); });
        assert.equal(g(r).a - b.a, 2);
        r.dispose(d);
        assert.equal(g(r).a, b.a, "dispose(d) tears the scope down");
        d(); r.dispose(d);
        assert.equal(g(r).a, b.a);
        balanced(r);
    });

    // A8 / R4b: ABA. The slot of the disposed owner is recycled by `other`; a stale disposer must not touch it.
    it("R4b stale disposer after slot recycle never touches the new resident (precondition: same slot)", () => {
        const r = R(); let d; const s = r.signal(0);   // made BEFORE the scope so the effect below (not s) takes the freed slot
        r.createScope((dd) => { d = dd; });
        r.dispose(d);
        const ptrSym = Object.getOwnPropertySymbols(d).find((x) => x.description === "node_ptr");
        assert.notEqual(ptrSym, undefined, "disposer carries the node pointer stamp");
        let runs = 0;
        const other = r.effect(() => { s(); runs++; });   // takes the freed slot (LIFO pool)
        assert.equal(d[ptrSym].id, r.nodeId(other), "precondition: other really took d's slot");
        d(); r.dispose(d);
        s.set(1);
        assert.equal(runs, 2, "stale disposer must not touch the new resident");
        assert.notEqual(r.nodeId(other), undefined);
        assert.equal(r.nodeId(d), undefined);
        other();
    });

    it("R5 stats: owner counts as ONE effect; empty scope = 1 node, 0 links", () => {
        const r = R(); const b = g(r); let d;
        r.createScope((dd) => { d = dd; });
        const m = g(r);
        assert.deepEqual({ nodes: m.a - b.a, effects: m.e - b.e, links: m.l - b.l }, { nodes: 1, effects: 1, links: 0 });
        d();
        assert.equal(g(r).a - b.a, 0);
    });

    // R7 flipped to D-CS-2 (rc: silent no-op; now honoured).
    it("R7 dispose() synchronously inside fn is HONOURED after fn returns (D-CS-2)", () => {
        const r = R(); const b = g(r); let cl = 0;
        const ret = r.createScope((d) => { r.effect(() => {}); r.onCleanup(() => cl++); d(); return "x"; });
        assert.equal(ret, "x");
        assert.equal(g(r).a - b.a, 0);
        assert.equal(cl, 1);
    });

    it("R8 dispose(getOwner()) inside fn tears the scope down; later d() is a no-op", () => {
        const r = R(); const b = g(r); let d, threw = null;
        try { r.createScope((dd) => { d = dd; r.effect(() => {}); r.dispose(r.getOwner()); }); } catch (e) { threw = e.message; }
        assert.equal(threw, null);
        assert.equal(g(r).a - b.a, 0);
        d();
        assert.equal(g(r).a - b.a, 0);
        balanced(r);
    });

    it("R8b self-disposed scope: after slot recycle dispose(d) never touches the new resident (kills STAMPCURGEN)", () => {
        const r = R(); const s = r.signal(0); let d;
        r.createScope((dd) => { d = dd; r.dispose(r.getOwner()); });
        const sym = Object.getOwnPropertySymbols(d).find((x) => x.description === "node_ptr");
        let hit = null;
        for (let i = 0; i < 5000 && hit === null; i++) { const h = r.effect(() => { s(); }); if (h[sym] === d[sym]) hit = h; }
        assert.notEqual(hit, null, "precondition: d's slot was recycled");
        r.dispose(d); d();
        assert.notEqual(r.nodeId(hit), undefined);
    });

    it("R9 fn throws: same error object, nodes cascade, cleanup ran, no leak", () => {
        const r = R(); const b = g(r); const E = new Error("boom"); let caught; let cl = 0;
        try { r.createScope(() => { r.effect(() => {}); r.computed(() => 1)(); r.onCleanup(() => cl++); throw E; }); } catch (e) { caught = e; }
        assert.equal(caught, E);
        assert.equal(g(r).a - b.a, 0);
        assert.equal(cl, 1);
        balanced(r);
    });

    // A7 / R27: C9 under batch().
    it("R27 fn throws inside batch(): same error, cleanup 1, leftover 0, counters balance", () => {
        const r = R(); const b = g(r); const E = new Error("batched"); let caught = null; let cl = 0;
        try { r.batch(() => { r.createScope(() => { r.effect(() => {}); r.onCleanup(() => cl++); throw E; }); }); } catch (e) { caught = e; }
        assert.equal(caught, E);
        assert.equal(cl, 1);
        assert.equal(g(r).a - b.a, 0);
        balanced(r);
    });

    // R11 CONTRACT (D-CS-4): a nested scope is a root of its own.
    it("R11 nested scope inside fn is a separate root: survives the outer dispose, dies with its own disposer", () => {
        const r = R(); const s = r.signal(0); let od, idd, ir = 0;
        r.createScope((d) => { od = d; r.createScope((d2) => { idd = d2; r.effect(() => { s(); ir++; }); }); });
        od();
        s.set(1);
        assert.equal(ir, 2, "inner scope survived the outer dispose");
        idd();
        s.set(2);
        assert.equal(ir, 2);
    });

    // R12 CONTRACT (D-CS-4): also inside runWithOwner(scope owner).
    it("R12 createScope inside runWithOwner(scopeOwner) is still a separate root", () => {
        const r = R(); const s = r.signal(0); let od, ir = 0, owner, id2;
        r.createScope((d) => { od = d; owner = r.getOwner(); });
        r.runWithOwner(owner, () => { r.createScope((d2) => { id2 = d2; r.effect(() => { s(); ir++; }); }); });
        od();
        s.set(1);
        assert.equal(ir, 2, "inner scope not adopted by the outer owner");
        id2();
        s.set(2);
        assert.equal(ir, 2);
    });

    it("R13 reset() disposes every scope; old disposer is a no-op; a new scope works", () => {
        const r = R(); let d, cl = 0;
        r.createScope((dd) => { d = dd; r.effect(() => {}); r.onCleanup(() => cl++); });
        r.reset();
        assert.equal(r.stats().activeNodes, 0);
        assert.equal(cl, 1);
        d(); r.dispose(d);
        assert.equal(r.stats().activeNodes, 0);
        assert.equal(r.describe(d), undefined);
        let d2;
        r.createScope((dd) => { d2 = dd; r.effect(() => {}); });
        assert.equal(r.stats().activeNodes, 2);
        d2();
        assert.equal(r.stats().activeNodes, 0);
    });

    // C-RESET D-4 pinned: refusal inside fn; the throw cascades the scope.
    it("R14 reset() inside fn refuses with 'graph not settled'; nothing leaks", () => {
        const r = R(); let e1 = null;
        try { r.createScope(() => { r.reset(); }); } catch (e) { e1 = e; }
        assert.ok(e1 instanceof Error);
        assert.ok(e1.message.startsWith("[lite-signal] reset: graph not settled"), e1.message);
        assert.equal(r.stats().activeNodes, 0);
    });

    it("R15 snapshot(): owner kind effect, ownerId null, no deps; children carry ownerId = owner", () => {
        const r = R(); let d; const s = r.signal(1);
        r.createScope((dd) => { d = dd; const c = r.computed(() => s() + 1); r.effect(() => { c(); }); });
        const snap = r.snapshot(); const oid = r.nodeId(d);
        const own = snap.nodes.find((n) => n.id === oid);
        assert.equal(own.kind, "effect");
        assert.equal(own.ownerId, null);
        assert.equal(own.deps.length, 0);
        assert.deepEqual(snap.nodes.filter((n) => n.ownerId === oid).map((n) => n.kind), ["computed", "effect"]);
    });

    it("R16 snapshot() inside fn refuses with 'graph not settled'", () => {
        const r = R(); let e1 = null, n = null;
        try { r.createScope(() => { n = r.snapshot().nodes.length; }); } catch (e) { e1 = e; }
        assert.ok(e1 instanceof Error);
        assert.ok(e1.message.startsWith("[lite-signal] snapshot: graph not settled"), e1.message);
        assert.equal(n, null);
    });

    it("R17 restore(): owner needs a body ('missing fn for id N (effect)'); with bodies the owner keeps its restored child", () => {
        const r = R(); let d; const s = r.signal(1);
        r.createScope((dd) => { d = dd; r.effect(() => { s(); }); });
        const snap = r.snapshot(); const oid = r.nodeId(d);
        const eff = snap.nodes.find((n) => n.ownerId === oid);
        assert.throws(() => r.restore(snap, { fnsById: { [eff.id]: () => {} } }),
            (e) => e.message.startsWith("[lite-signal] restore: missing fn for id " + oid + " (effect)"));
        const r2 = r.restore(snap, { fnsById: { [oid]: () => {}, [eff.id]: () => {} } });
        assert.equal(r2.stats().activeNodes, 3, "signal + owner + child effect");
        assert.equal(r2.snapshot().nodes.filter((n) => n.ownerId === oid).length, 1);
    });

    it("R18 destroy(): disposer afterwards is a no-op (no throw)", () => {
        const r = R(); let d;
        r.createScope((dd) => { d = dd; r.effect(() => {}); });
        r.destroy();
        assert.doesNotThrow(() => { d(); r.dispose(d); });
    });

    it("R19 cross-registry: B.dispose(A's scope disposer) behaves like B.dispose(A's effect handle)", () => {
        const a = R(), b = R(); let d;
        a.createScope((dd) => { d = dd; a.effect(() => {}); });
        const stop = a.effect(() => {});
        assert.equal(a.stats().activeNodes, 3);
        b.dispose(stop);
        assert.equal(a.stats().activeNodes, 2, "canonical: a foreign function handle is invoked");
        b.dispose(d);
        assert.equal(a.stats().activeNodes, 0, "scope disposer matches the effect-handle contract");
    });

    it("R20 inside batch(): fn and inner effects run synchronously at creation", () => {
        const r = R(); const s = r.signal(1); const seen = [];
        r.batch(() => { r.createScope(() => { seen.push("fn"); r.effect(() => { seen.push("eff" + s()); }); }); seen.push("after"); });
        assert.deepEqual(seen, ["fn", "eff1", "after"]);
    });

    it("R21 disposing the scope from an inner effect's re-run is safe", () => {
        const r = R(); const s = r.signal(0); const b = g(r); let d, runs = 0;
        r.createScope((dd) => { d = dd; r.effect(() => { runs++; if (s() === 1) d(); }); });
        s.set(1);
        s.set(2);
        assert.equal(runs, 2);
        assert.equal(g(r).a - b.a, 0);
        balanced(r);
    });

    it("R22 top-level export binds the default registry", () => {
        const b = S.stats().activeNodes; let d;
        S.createScope((dd) => { d = dd; S.effect(() => {}); });
        assert.equal(S.stats().activeNodes - b, 2);
        d();
        assert.equal(S.stats().activeNodes, b);
    });

    // A4 / R23: kills MU-NOOUTERRESTORE (observer left null -> consumer stops tracking), MU-NOOWNERRESTORE (owner left null).
    it("R23 enclosing context restored: consumer keeps tracking and owning after createScope", () => {
        const r = R(); const t = r.signal(0); let runs = 0, trkAfter, d, child;
        const stop = r.effect(() => {
            runs++;
            if (runs === 1) r.createScope((dd) => { d = dd; });
            trkAfter = r.isTracking();
            t();
            if (runs === 1) child = r.computed(() => 1);
        });
        assert.equal(r.ownerOf(child).id, r.nodeId(stop));
        t.set(1);
        assert.equal(runs, 2, "consumer re-ran on a read made after createScope");
        assert.equal(trkAfter, true);
        stop(); d();
    });

    it("R24 cleanup order on dispose is inside-out", () => {
        const r = R(); const order = []; let d;
        r.createScope((dd) => { d = dd; r.onCleanup(() => order.push("scope")); r.effect(() => { r.onCleanup(() => order.push("inner")); }); });
        d();
        assert.deepEqual(order, ["inner", "scope"]);
    });

    it("R26 re-entrant d() from an inner cleanup during the scope's own dispose is balanced", () => {
        const r = R(); const b = g(r); let d;
        r.createScope((dd) => { d = dd; r.effect(() => { r.onCleanup(() => d()); }); });
        assert.doesNotThrow(() => d());
        assert.equal(g(r).a - b.a, 0);
        balanced(r);
    });

    // A10 retention: nodes only (no GC counts).
    it("retention: 3 rounds of 10000 createScope (1 inner effect) + d() leave 0 nodes per round", () => {
        const r = R();
        for (let round = 0; round < 3; round++) {
            const b = r.stats().activeNodes;
            for (let i = 0; i < 10000; i++) {
                let d;
                r.createScope((dd) => { d = dd; r.effect(() => {}); });
                d();
            }
            assert.equal(r.stats().activeNodes - b, 0, "round " + round);
            balanced(r);
        }
    });
});

describe("D-CS-2: dispose() while fn runs is honoured (A5; kills DEFERDROP, DEFERDROP-W)", () => {
    function scenario(kind) {
        const r = R(); const b = g(r); const log = []; let d0;
        const ret = r.createScope((d) => {
            d0 = d;
            r.onCleanup(() => log.push("scope"));
            r.effect(() => { r.onCleanup(() => log.push("inner")); });
            if (kind === "d") d();
            else if (kind === "api") r.dispose(d);
            else if (kind === "twice") { d(); d(); }
            log.push("fn-end");
            return "x";
        });
        log.push("returned");
        if (kind === "twice") d0();
        return { r, b, log, ret };
    }
    for (const kind of ["d", "api", "twice"]) {
        it("kind " + kind + ": returns fn value, 0 nodes left, order fn-end,inner,scope,returned", () => {
            const { r, b, log, ret } = scenario(kind);
            assert.equal(ret, "x");
            assert.equal(g(r).a - b.a, 0, "activeNodes delta 0");
            assert.deepEqual(log, ["fn-end", "inner", "scope", "returned"]);
            balanced(r);
        });
    }

    it("d() then throw E: same E, each cleanup exactly once, leftover 0", () => {
        const r = R(); const b = g(r); const E = new Error("after-d"); let caught = null; let c1 = 0, c2 = 0;
        try {
            r.createScope((d) => { r.onCleanup(() => c1++); r.effect(() => { r.onCleanup(() => c2++); }); d(); throw E; });
        } catch (e) { caught = e; }
        assert.equal(caught, E);
        assert.equal(c1, 1);
        assert.equal(c2, 1);
        assert.equal(g(r).a - b.a, 0);
        balanced(r);
    });

    it("describe(d) inside fn is undefined (stamp is set only after the owner's first run)", () => {
        const r = R(); let seen = "unset";
        r.createScope((d) => { seen = r.describe(d); });
        assert.equal(seen, undefined);
    });

    it("a cleanup throwing during the honoured disposal propagates from createScope (kills HONOURSWALLOW)", () => {
        const r = R(); const E = new Error("cl");
        assert.throws(() => r.createScope((d) => { r.onCleanup(() => { throw E; }); d(); return "v"; }), (e) => e === E);
    });

    it("R28d deferred disposal runs after the stamp (kills HONOURBEFORESTAMP)", () => {
        const run = (defer) => {
            const r = R(); let seen = "unset", d1;
            r.createScope((d) => { d1 = d; r.onCleanup(() => { seen = r.nodeId(d1); }); if (defer) d(); });
            if (!defer) d1();
            return seen;
        };
        const a = run(true), c = run(false);
        assert.equal(typeof c, "number");
        assert.equal(a, c);
    });

    // R28c: the deferred disposal runs in the same ambient context as a d() right after return (kills HONOURINTRY,
    // which would honour the request before createScope's finally restores the enclosing owner / observer).
    it("R28c onDisconnect hook of a deferred disposal sees the same getOwner()/isTracking() as a d() after return", () => {
        const run = (defer) => {
            const r = R(); const b = r.signal(0); const seen = []; let me = null, d1 = null;
            r.observeObservers(b, { onDisconnect() { seen.push({ owner: r.getOwner() === undefined ? null : r.getOwner().id, trk: r.isTracking() }); } });
            r.effect(() => {
                me = r.getOwner().id;
                r.createScope((d) => { d1 = d; r.effect(() => { b(); }); if (defer) d(); });
                if (!defer) d1();
            });
            return { seen, me };
        };
        const a = run(true), c = run(false);
        assert.equal(a.seen.length, 1, "hook fired once for the deferred disposal");
        assert.equal(c.seen.length, 1, "hook fired once for the d() after return");
        assert.deepEqual(a.seen, c.seen);
        assert.equal(a.seen[0].owner, a.me, "the hook runs in the enclosing consumer's owner context");
    });
});

describe("D-CS-3: non-function fn validated up front (A6; kills FNCHECKDROP, FNCHECKLATE)", () => {
    it("R28b [undefined, null, 42, 'f', {}] -> TypeError with the exact message; counters unchanged", () => {
        const r = R();
        for (const bad of [undefined, null, 42, "f", {}]) {
            const before = r.stats();
            assert.throws(() => r.createScope(bad), (e) => e instanceof TypeError && e.message === TYPE_MSG);
            const after = r.stats();
            assert.equal(after.totalAllocations, before.totalAllocations);
            assert.equal(after.activeNodes, before.activeNodes);
        }
    });

    it("R28b the refusal leaves the enclosing context intact (owner and observer)", () => {
        const r = R(); const t = r.signal(0); let me = null, child, trk, caught = null, runs = 0;
        r.effect(() => {
            runs++;
            me = r.getOwner().id;
            try { r.createScope(42); } catch (e) { caught = e; }
            child = r.computed(() => 1);
            trk = r.isTracking();
            t();
        });
        assert.ok(caught instanceof TypeError);
        assert.equal(r.ownerOf(child) === null ? null : r.ownerOf(child).id, me);
        assert.equal(trk, true);
        t.set(1);
        assert.equal(runs, 2, "consumer still tracks");
    });
});

describe("D-DELTA-1 and D-CS-7 (A9)", () => {
    function severSlice(src) {
        const i = src.indexOf("function severStale(node, stale) {");
        assert.notEqual(i, -1, "severStale present");
        const j = src.indexOf("\n    }\n", i);
        assert.notEqual(j, -1);
        return src.slice(i, j);
    }
    // Text row: severStale must NOT save the outer cursor; the push alone remains. Fails on the frozen build
    // (.handoff/cs/before/Signal.js has the `if (d !== 0) cursorStack[d] = activeObserverCurrentDep;` line).
    // SSSAVE-READD (re-adding that line) is an identity write -- cursorStack[d] already equals the live cursor --
    // EQUIVALENT by construction; only this text row kills it, never counted as a behaviour kill.
    it("severStale slice: 0 x `cursorStack[d] =` write, exactly 1 x `cursorDepth = d + 1`", () => {
        const body = severSlice(SRC);
        assert.equal((body.match(/cursorStack\[d\]\s*=(?!=)/g) || []).length, 0);
        assert.equal((body.match(/cursorDepth = d \+ 1/g) || []).length, 1);
    });

    // Precondition: both callers restore the live cursor from cursorStack[d] the statement before severStale.
    function precondOk(src) {
        const lines = src.split("\n");
        const call = "if (stale !== null) severStale(node, stale);";
        const prev = "activeObserverCurrentDep = d !== 0 ? cursorStack[d] : null;";
        let n = 0;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === call) {
                n++;
                if (i === 0 || lines[i - 1].trim() !== prev) return false;
            }
        }
        return n === 2;
    }
    it("precondition: exactly 2 severStale call sites, each right after the cursor restore", () => {
        assert.equal(precondOk(SRC), true);
    });
    it("precondition must-fail control: an inserted line between restore and call is detected", () => {
        const lines = SRC.split("\n");
        const k = lines.findIndex((l) => l.trim() === "if (stale !== null) severStale(node, stale);");
        assert.notEqual(k, -1);
        lines.splice(k, 0, "                void 0;");
        assert.equal(precondOk(lines.join("\n")), false);
    });

    // D-CS-7 kept createRoot's gen checks on the outer restore; the b202 search (mu-genrestore-search.mjs, shape i3) found a
    // killing shape, so MU-NOGENRESTORE (restore `currentOwner = pw; currentObserver = po;` without the `.gen ===` checks) is
    // NO LONGER declared equivalent. C disposes itself from a scope fn (pinned, gen moves at dispose); with the gen checks the
    // restore drops the dead C, so reset() inside C reports the "(untrack)" suffix; the mutant restores the dead C and the
    // message loses it.
    // OWNERGENDROP (`currentOwner = pw;` alone, the observer gen test kept) survives test/120 and is declared EQUIVALENT by the same
    // pinning argument (a dead pw stays pinned with flags 0; adoption, onCleanup and getOwner all test flags; runWithOwner + recycle
    // shapes did not kill it).
    it("D-CS-7 i3: computed disposed from a scope fn -> reset() inside it reports the exact refusal text (kills MU-NOGENRESTORE)", () => {
        const r = R(); let msg;
        const C = r.computed(() => {
            r.createScope(() => { r.dispose(C); });
            try { r.reset(); } catch (e) { msg = e.message; }
            return 1;
        });
        C();
        assert.equal(msg, "[lite-signal] reset: graph not settled (a computed / effect body is running (untrack))");
    });
});
