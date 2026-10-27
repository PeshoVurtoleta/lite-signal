// 76-snapshot.test.mjs -- A9 snapshot()/restore() INDEPENDENT ORACLE (burst 95, batch H-T; .handoff/PLAN-0s-a9.md
// task 4 + ASSERTIONS 1, 3, 4, 5 + rulings D-A..D-D). Written from the spec and the fork's 33-snapshot cases, not from
// the port's Signal.js. Cases 1-3, 5, 7-15, 18, 19 are the fork cases (title/import only); 4, 6, 16, 17 are adapted;
// N1-N10 are new. Every row must fail on the b95-before build (no snapshot export) -- red-first.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getHeapStatistics } from "node:v8";
import { GcProfiler, checkNoGc } from "@zakkster/lite-gc-profiler";
import { createLeakTracker } from "@zakkster/lite-leak";
import * as Sig from "../Signal.js";
import { createRegistry, CapacityError } from "../Signal.js";

const HAVE_GC = typeof globalThis.gc === "function";
const NOT_SETTLED = /not settled/;
// D-A flag values: callables 32 / 1 / 2, boxes carry FLAG_BOX (128): 160 / 129.
const F_SIGNAL = 32, F_COMPUTED = 1, F_EFFECT = 2, F_SIGNAL_BOX = 160, F_COMPUTED_BOX = 129;
// A dirty record whose stamps agree with the bit (b100, D-M): a mark landed one clock tick after the snapshot's
// last write (gv advanced, as a reverted write does), so markEpoch > evalVersion AND markEpoch <= gv, as live keeps it.
// (markEpoch = evalVersion + 1 alone can sit AHEAD of gv: the next write then stamps the same epoch and its mark
// walk stops there, which no live graph does.)
function dirtyRec(snap, n) { snap.gv = (snap.gv + 1) | 0 || 1; n.clean = false; n.markEpoch = snap.gv; return n; }


// snapshot/restore (1.6.0): in-process time-travel / undo.
// The oracle idea is ported from the serialize-spike proof-of-concept: build a
// random graph, snapshot, restore into a fresh registry with re-supplied fns,
// and cross-check every value + a follow-up propagation against a pure
// computation done with no engine involved.

function sortById(nodes) {
    return [...nodes].sort((x, y) => x.id - y.id);
}

// Pure oracle -- the same arithmetic done directly, no engine.
function pureOracle(a, b, c, bx) {
    const sum = a + b;
    const prod = b * c;
    const total = sum + prod;
    const cbx = bx * 2;
    return { sum, prod, total, cbx };
}

// Deterministic source graph: signals + computeds + boxes + an effect.
function buildSource(r, a0, b0, c0, bx0, onTotal) {
    const a = r.signal(a0), b = r.signal(b0), c = r.signal(c0);
    const sum = r.computed(() => a() + b());
    const prod = r.computed(() => b() * c());
    const total = r.computed(() => sum() + prod());
    const bx = r.signalBox(bx0);
    const cbx = r.computedBox(() => bx.get() * 2);
    const eff = r.effect(() => { onTotal(total()); });
    return { a, b, c, sum, prod, total, bx, cbx, eff };
}

// --- 1. 200-seed round-trip oracle -------------------------------------------

test("snapshot/restore: 200-seed round-trip oracle (value + version + propagation)", () => {
    let seed = 0x1234abcd | 0;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) % 50;

    for (let i = 0; i < 200; i++) {
        const a0 = rnd(), b0 = rnd(), c0 = rnd(), bx0 = rnd();
        const src = createRegistry();
        let srcEffVal = null;
        const h = buildSource(src, a0, b0, c0, bx0, (v) => { srcEffVal = v; });

        const o0 = pureOracle(a0, b0, c0, bx0);
        assert.equal(h.total(), o0.total);
        assert.equal(h.cbx.get(), o0.cbx);
        assert.equal(srcEffVal, o0.total);

        const ids = {
            a: src.nodeId(h.a), b: src.nodeId(h.b), c: src.nodeId(h.c),
            sum: src.nodeId(h.sum), prod: src.nodeId(h.prod), total: src.nodeId(h.total),
            bx: src.nodeId(h.bx), cbx: src.nodeId(h.cbx), eff: src.nodeId(h.eff),
        };
        const snap = src.snapshot();

        // Wire fnsById to the rebuilt graph via the handles out-param. The bodies
        // close over `H` and are only invoked after restore has populated it.
        const H = {};
        let restoreEffVal = null;
        const fnsById = {
            [ids.sum]: () => H[ids.a]() + H[ids.b](),
            [ids.prod]: () => H[ids.b]() * H[ids.c](),
            [ids.total]: () => H[ids.sum]() + H[ids.prod](),
            [ids.cbx]: () => H[ids.bx].get() * 2,
            [ids.eff]: () => { restoreEffVal = H[ids.total](); },
        };
        const r2 = src.restore(snap, { fnsById, handles: H });

        // Every value/version/kind/dep/owner matches: re-snapshot deep-equals.
        assert.deepEqual(sortById(r2.snapshot().nodes), sortById(snap.nodes));
        // D-M / D-O (b100): the whole snapshot round-trips, clock + next id + per-record stamps included.
        assert.deepStrictEqual(Object.keys(snap), ["v", "nodes", "gv", "nextId"]);
        for (const n of snap.nodes) assert.ok(Number.isInteger(n.evalVersion) && Number.isInteger(n.markEpoch), "stamps on record " + n.id);
        assert.deepStrictEqual(r2.snapshot(), snap, "snapshot(restore(s)) === s incl. gv / nextId / evalVersion / markEpoch");

        // Reads return restored values (cache hits); effect did NOT re-fire.
        assert.equal(H[ids.total](), o0.total);
        assert.equal(H[ids.cbx].get(), o0.cbx);
        assert.equal(restoreEffVal, null, "effect must not re-fire during restore");

        // A follow-up set() propagates identically to a direct computation.
        const na = a0 + 1 + rnd();      // guaranteed != a0 so total changes
        const nbx = bx0 + 1 + rnd();
        H[ids.a].set(na);
        H[ids.bx].set(nbx);
        const o1 = pureOracle(na, b0, c0, nbx);
        assert.equal(H[ids.total](), o1.total);
        assert.equal(H[ids.cbx].get(), o1.cbx);
        assert.equal(restoreEffVal, o1.total, "effect fires with the propagated value after a change");

        src.destroy();
        r2.destroy();
    }
});

// --- 2. fail-closed on a missing computed/effect fn --------------------------

test("snapshot/restore: fail-closed on a missing fn (named error, no silently-dead node)", () => {
    const src = createRegistry();
    const a = src.signal(2);
    const c = src.computed(() => a() * 3);
    c();
    const cId = src.nodeId(c);
    const snap = src.snapshot();

    // No fnsById at all -> the computed has no body.
    assert.throws(
        () => src.restore(snap, { fnsById: {} }),
        (err) => err instanceof Error &&
            err.message === "[lite-signal] restore: missing fn for id " + cId + " (computed)"
    );

    // Effect variant.
    const src2 = createRegistry();
    const s = src2.signal(1);
    const eff = src2.effect(() => { s(); });
    const effId = src2.nodeId(eff);
    const snap2 = src2.snapshot();
    assert.throws(
        () => src2.restore(snap2, { fnsById: {} }),
        (err) => err instanceof Error &&
            err.message === "[lite-signal] restore: missing fn for id " + effId + " (effect)"
    );
});

// --- 3. effects restore state but do NOT re-fire -----------------------------

test("snapshot/restore: effects restore state, do not re-fire, fire on next change", () => {
    const src = createRegistry();
    const s = src.signal(1);
    let srcFires = 0;
    const eff = src.effect(() => { s(); srcFires++; });
    assert.equal(srcFires, 1);   // ran once on creation

    const ids = { s: src.nodeId(s), eff: src.nodeId(eff) };
    const snap = src.snapshot();

    const H = {};
    let restoreFires = 0;
    const fnsById = { [ids.eff]: () => { H[ids.s](); restoreFires++; } };
    const r2 = src.restore(snap, { fnsById, handles: H });

    assert.equal(restoreFires, 0, "no side effect runs during restore");

    H[ids.s].set(2);
    assert.equal(restoreFires, 1, "effect fires on the next dependency change");
    H[ids.s].set(3);
    assert.equal(restoreFires, 2);
});

// --- 4. boxes round-trip (value + propagation, right handle form) ------------

test("snapshot/restore: signalBox + computedBox round-trip", () => {
    const src = createRegistry();
    const created = [];
    src.onGraphMutation((op, id, flags) => { if (op === 1) created.push([id, flags]); });
    const bx = src.signalBox(7);
    const cbx = src.computedBox(() => bx.get() + 1);
    assert.equal(cbx.get(), 8);
    // D-A: box nodes report 160 / 129 on op 1 (FLAG_BOX 128 set at createNode).
    assert.deepEqual(created.map((e) => e[1]), [F_SIGNAL_BOX, F_COMPUTED_BOX]);

    const bxId = src.nodeId(bx), cbxId = src.nodeId(cbx);
    const snap = src.snapshot();
    assert.equal(snap.nodes.find(n => n.id === bxId).kind, "signalBox");
    assert.equal(snap.nodes.find(n => n.id === cbxId).kind, "computedBox");

    const H = {};
    const r2 = src.restore(snap, {
        fnsById: { [cbxId]: () => H[bxId].get() + 1 },
        handles: H,
    });

    // Restored handles are boxes (get/set), not callables.
    assert.equal(typeof H[bxId].get, "function");
    assert.equal(typeof H[bxId].set, "function");
    assert.equal(H[bxId].get(), 7);
    assert.equal(H[cbxId].get(), 8);

    H[bxId].set(20);
    assert.equal(H[cbxId].get(), 21);
});

// --- 5. owner tree rebuilt from ids ------------------------------------------

test("snapshot/restore: owner tree rebuilt from ids", () => {
    const src = createRegistry();
    let child;
    const outer = src.effect(() => {
        child = src.computed(() => 42);
        child();   // read so it evaluates and is owner-adopted by `outer`
    });

    const outerId = src.nodeId(outer);
    const childId = src.nodeId(child);
    const snap = src.snapshot();
    assert.equal(snap.nodes.find(n => n.id === childId).ownerId, outerId);

    const H = {};
    const r2 = src.restore(snap, {
        fnsById: {
            [outerId]: () => { H[childId](); },
            [childId]: () => 42,
        },
        handles: H,
    });

    // Owner edge preserved through a re-snapshot.
    const r2snap = r2.snapshot();
    assert.equal(r2snap.nodes.find(n => n.id === childId).ownerId, outerId);

    // ...and observable through the live owner-tree walker.
    const owned = [];
    r2.forEachOwned(H[outerId], (d) => owned.push(d.id));
    assert.deepEqual(owned, [childId]);
});

// --- 6. retention: 1000 cycles return the live-node count to baseline --------

test("snapshot/restore: 1000 cycles leak no nodes (activeNodes baseline + lite-leak tracker 0 after gc)",
    { skip: HAVE_GC ? false : "needs --expose-gc" }, async () => {
    const src = createRegistry();
    const a = src.signal(1), b = src.signal(2);
    const sum = src.computed(() => a() + b());
    sum();
    const ids = { a: src.nodeId(a), b: src.nodeId(b), sum: src.nodeId(sum) };
    const baseline = src.stats().activeNodes;
    const snap = src.snapshot();
    const tracker = createLeakTracker({ name: "t76", onLeak() {}, onWarning() {} });

    const cycle = (i) => {
        const H = {};
        const r2 = src.restore(snap, {
            fnsById: { [ids.sum]: () => H[ids.a]() + H[ids.b]() },
            handles: H,
        });
        tracker.track(r2, null, i);
        tracker.track(H[ids.sum], null, i);
        assert.equal(r2.stats().activeNodes, baseline);
        assert.equal(H[ids.sum](), 3);
        r2.destroy();
        assert.equal(r2.stats().activeNodes, 0);
    };
    for (let i = 0; i < 1000; i++) cycle(i);

    assert.equal(src.stats().activeNodes, baseline, "source registry did not leak nodes");
    for (let k = 0; k < 3; k++) { globalThis.gc(); await new Promise((res) => setTimeout(res, 0)); }
    assert.equal(tracker.size(), 0, "no restored registry/handle is retained after destroy + gc");
});

// --- 7. BLOCKER 1: never-read computed rebuilds UNCOMPUTED --------------------

test("snapshot/restore: never-read computed recomputes (not enshrined undefined)", () => {
    const src = createRegistry();
    const s = src.signal(3);
    const c = src.computed(() => s() * 2);   // deliberately NOT read

    const sId = src.nodeId(s), cId = src.nodeId(c);
    const snap = src.snapshot();
    // The never-read computed reports its cache as not-clean and has no deps yet.
    const crec = snap.nodes.find(n => n.id === cId);
    assert.equal(crec.clean, false, "never-read computed must snapshot as not-clean");
    assert.deepEqual(crec.deps, [], "never-read computed has no dep edges yet");

    const H = {};
    const r2 = src.restore(snap, {
        fnsById: { [cId]: () => H[sId]() * 2 },
        handles: H,
    });

    // First read runs the body -> correct value, NOT the enshrined undefined.
    assert.equal(H[cId](), 6, "first read computes 6, not undefined");
    // ...and a subsequent dep set propagates (deps were re-tracked by that read).
    H[sId].set(4);
    assert.equal(H[cId](), 8, "dep set propagates after the recompute re-tracked deps");
});

// --- 8. BLOCKER 1: dirty (dep-set-without-re-read) recomputes fresh -----------

test("snapshot/restore: dirty computed (set without re-read) reads the fresh value", () => {
    const src = createRegistry();
    const s = src.signal(10);
    const c = src.computed(() => s() + 1);
    assert.equal(c(), 11);          // evaluate -> cache is clean at 11
    s.set(100);                     // mark dirty WITHOUT re-reading c

    const sId = src.nodeId(s), cId = src.nodeId(c);
    const snap = src.snapshot();
    const crec = snap.nodes.find(n => n.id === cId);
    assert.equal(crec.clean, false, "dirty computed must snapshot as not-clean");

    const H = {};
    const r2 = src.restore(snap, {
        fnsById: { [cId]: () => H[sId]() + 1 },
        handles: H,
    });

    // The restored read runs the body against the fresh dep value (101), not the
    // stale cached 11.
    assert.equal(H[cId](), 101, "dirty computed reads the fresh value after restore");
    H[sId].set(0);
    assert.equal(H[cId](), 1, "subsequent set still propagates");
});

// --- 9. BLOCKER 1: clean computed IS trusted (deps rebuilt, cache hit) --------

test("snapshot/restore: clean evaluated computed is a cache hit, then propagates", () => {
    const src = createRegistry();
    const s = src.signal(5);
    const c = src.computed(() => s() * 3);
    assert.equal(c(), 15);          // clean

    const sId = src.nodeId(s), cId = src.nodeId(c);
    const snap = src.snapshot();
    assert.equal(snap.nodes.find(n => n.id === cId).clean, true);

    let calls = 0;
    const H = {};
    const r2 = src.restore(snap, {
        fnsById: { [cId]: () => { calls++; return H[sId]() * 3; } },
        handles: H,
    });

    assert.equal(H[cId](), 15, "clean cache is trusted");
    assert.equal(calls, 0, "clean computed does not recompute on first read");
    H[sId].set(7);
    assert.equal(H[cId](), 21, "clean computed still propagates on a later set");
});

// --- 10. BLOCKER 1: snapshot mid-batch / mid-flush fails closed --------------

test("snapshot: throws when the graph is not settled (mid-batch)", () => {
    const src = createRegistry();
    const s = src.signal(1);
    assert.throws(
        () => src.batch(() => { s.set(2); src.snapshot(); }),
        (err) => err instanceof Error &&
            err.message === "[lite-signal] snapshot: graph not settled (flush/batch/track in progress)"
    );
});

test("snapshot: throws when called mid-flush (inside an effect)", () => {
    const src = createRegistry();
    const s = src.signal(1);
    let thrown = null;
    src.effect(() => {
        s();
        try { src.snapshot(); } catch (e) { thrown = e; }
    });
    // First run happened during creation (isFlushing false there); force a flush.
    s.set(2);
    assert.ok(thrown instanceof Error, "snapshot inside a flushing effect throws");
    assert.equal(thrown.message, "[lite-signal] snapshot: graph not settled (flush/batch/track in progress)");
});

test("snapshot: throws when called inside a compute body (mid-track)", () => {
    const src = createRegistry();
    const s = src.signal(1);
    let thrown = null;
    const c = src.computed(() => {
        s();
        try { src.snapshot(); } catch (e) { thrown = e; }
        return 0;
    });
    c();   // pull: runs the body, which is tracking deps -> snapshot must fail closed
    assert.ok(thrown instanceof Error, "snapshot inside a compute body throws");
    assert.equal(thrown.message, "[lite-signal] snapshot: graph not settled (flush/batch/track in progress)");
});

// --- 11. BLOCKER 2: duplicate id fails closed --------------------------------

test("restore: duplicate id fails closed", () => {
    const src = createRegistry();
    const a = src.signal(1);
    const b = src.signal(2);
    const snap = src.snapshot();
    // Corrupt the snapshot: two records share an id.
    snap.nodes[1].id = snap.nodes[0].id;
    const dupId = snap.nodes[0].id;
    assert.throws(
        () => src.restore(snap, {}),
        (err) => err instanceof Error &&
            err.message === "[lite-signal] restore: duplicate id " + dupId
    );
});

// --- 12. fail-closed battery: dangling dep id, bad owner id -------------------

test("restore: dangling dep id fails closed", () => {
    const src = createRegistry();
    const a = src.signal(1);
    const c = src.computed(() => a() + 1);
    c();
    const cId = src.nodeId(c);
    const snap = src.snapshot();
    // Point the computed at a non-existent dep.
    snap.nodes.find(n => n.id === cId).deps = [999999];
    assert.throws(
        () => src.restore(snap, { fnsById: { [cId]: () => 0 } }),
        (err) => err instanceof Error &&
            err.message === "[lite-signal] restore: dep id 999999 missing for id " + cId
    );
});

test("restore: bad owner id fails closed", () => {
    const src = createRegistry();
    let child;
    const outer = src.effect(() => { child = src.computed(() => 1); child(); });
    const childId = src.nodeId(child);
    const outerId = src.nodeId(outer);
    const snap = src.snapshot();
    snap.nodes.find(n => n.id === childId).ownerId = 888888;
    assert.throws(
        () => src.restore(snap, {
            fnsById: { [outerId]: () => { child(); }, [childId]: () => 1 },
        }),
        (err) => err instanceof Error &&
            err.message === "[lite-signal] restore: owner id 888888 missing for id " + childId
    );
});

// --- 13. NIT 2: a > 1024-node snapshot restores without CapacityError ---------

test("restore: large snapshot (> 1024 nodes) restores cleanly under the default 'throw' policy (D-C sizing)", () => {
    const N = 1500;
    const src = createRegistry({ maxNodes: 2048 });
    const sigs = [];
    for (let i = 0; i < N; i++) sigs.push(src.signal(i));
    const snap = src.snapshot();
    assert.ok(snap.nodes.length > 1024, "snapshot exceeds the default 1024 capacity");

    const H = {};
    const r2 = src.restore(snap, { handles: H });   // no config: sized from the snapshot
    assert.equal(r2.stats().activeNodes, N);
    const midId = src.nodeId(sigs[750]);
    assert.equal(H[midId](), 750);
    // D-C: link capacity = max(1.5L + 16, 4 x maxNodes); accessor = stats().linkPoolCapacity / nodePoolCapacity.
    const st = r2.stats();
    assert.ok(st.nodePoolCapacity >= N, "maxNodes sized from the snapshot");
    assert.equal(st.linkPoolCapacity, Math.max(Math.floor(1.5 * 0) + 16, 4 * st.nodePoolCapacity));
    r2.destroy();
});

test("restore: link capacity with edges is max(1.5L + 16, 4 x maxNodes) (D-C)", () => {
    // 2000 signals + 1000 computeds reading 2 signals each (all read -> clean -> deps captured): L = 2000.
    const src = createRegistry({ maxNodes: 4096 });
    const sigs = [];
    for (let i = 0; i < 2000; i++) sigs.push(src.signal(i));
    const cs = [];
    for (let i = 0; i < 1000; i++) { const x = sigs[2 * i], y = sigs[2 * i + 1]; const c = src.computed(() => x() + y()); c(); cs.push(c); }
    const snap = src.snapshot();
    let L = 0;
    for (const n of snap.nodes) L += n.deps.length;
    assert.equal(L, 2000);
    const H = {};
    const fnsById = {};
    for (let i = 0; i < 1000; i++) {
        const cid = src.nodeId(cs[i]), xi = src.nodeId(sigs[2 * i]), yi = src.nodeId(sigs[2 * i + 1]);
        fnsById[cid] = () => H[xi]() + H[yi]();
    }
    const r2 = src.restore(snap, { fnsById, handles: H });
    const st = r2.stats();
    assert.equal(st.activeNodes, 3000);
    assert.ok(st.nodePoolCapacity >= 3000);
    assert.equal(st.linkPoolCapacity, Math.max(Math.floor(1.5 * L) + 16, 4 * st.nodePoolCapacity));
    r2.destroy();
});

test("restore: small snapshot gets the 1024 / 4096 floor capacities (D-C)", () => {
    const src = createRegistry();
    src.signal(1);
    const r2 = src.restore(src.snapshot(), {});
    assert.equal(r2.stats().nodePoolCapacity, 1024);
    assert.equal(r2.stats().linkPoolCapacity, 4096);
    r2.destroy();
});

test("restore: opts.config override is honored", () => {
    const src = createRegistry();
    const a = src.signal(1);
    const snap = src.snapshot();
    const r2 = src.restore(snap, { config: { maxNodes: 64, prealloc: "eager" } });
    assert.equal(r2.stats().activeNodes, 1);
    assert.equal(r2.stats().nodePoolCapacity, 64, "explicit maxNodes honored");
    r2.destroy();
    // unknown config key is an error (createRegistry validates it), with a did-you-mean hint
    assert.throws(() => src.restore(snap, { config: { maxNode: 64 } }), (e) => e instanceof Error && /maxNode/.test(e.message));
});

// --- 14. NIT 3: REHYDRATE is not an enumerable own symbol --------------------

test("registry: REHYDRATE hook is not enumerable (not exposed via getOwnPropertySymbols)", () => {
    const r = createRegistry();
    assert.equal(typeof r.snapshot, "function", "snapshot exists (else this row is vacuous)");
    const syms = Object.getOwnPropertySymbols(r);
    const leaked = syms.filter(s => String(s).includes("rehydrate"));
    assert.equal(leaked.length, 0, "the private rehydrate symbol must not surface");
});

// --- 15. BLOCKER 1 oracle variant: computeds NOT pre-read --------------------

test("snapshot/restore: oracle variant that does NOT pre-read computeds", () => {
    let seed = 0x0badf00d | 0;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) % 50;

    for (let i = 0; i < 200; i++) {
        const a0 = rnd(), b0 = rnd(), c0 = rnd(), bx0 = rnd();
        const src = createRegistry();
        // Build the graph but DO NOT read any computed (no effect either -- an
        // effect would eagerly evaluate `total`). This exercises BLOCKER 1's
        // never-evaluated class across the whole graph.
        const a = src.signal(a0), b = src.signal(b0), c = src.signal(c0);
        const sum = src.computed(() => a() + b());
        const prod = src.computed(() => b() * c());
        const total = src.computed(() => sum() + prod());
        const bx = src.signalBox(bx0);
        const cbx = src.computedBox(() => bx.get() * 2);

        const ids = {
            a: src.nodeId(a), b: src.nodeId(b), c: src.nodeId(c),
            sum: src.nodeId(sum), prod: src.nodeId(prod), total: src.nodeId(total),
            bx: src.nodeId(bx), cbx: src.nodeId(cbx),
        };
        const snap = src.snapshot();
        // Every computed reports not-clean (never evaluated).
        for (const k of ["sum", "prod", "total", "cbx"]) {
            assert.equal(snap.nodes.find(n => n.id === ids[k]).clean, false);
        }

        const H = {};
        const fnsById = {
            [ids.sum]: () => H[ids.a]() + H[ids.b](),
            [ids.prod]: () => H[ids.b]() * H[ids.c](),
            [ids.total]: () => H[ids.sum]() + H[ids.prod](),
            [ids.cbx]: () => H[ids.bx].get() * 2,
        };
        const r2 = src.restore(snap, { fnsById, handles: H });

        const o0 = pureOracle(a0, b0, c0, bx0);
        // First reads run the bodies and return the CORRECT computed values.
        assert.equal(H[ids.total](), o0.total, "never-read total recomputes correctly");
        assert.equal(H[ids.cbx].get(), o0.cbx, "never-read cbx recomputes correctly");

        // A follow-up set() propagates identically to a direct computation.
        const na = a0 + 1 + rnd();
        const nbx = bx0 + 1 + rnd();
        H[ids.a].set(na);
        H[ids.bx].set(nbx);
        const o1 = pureOracle(na, b0, c0, nbx);
        assert.equal(H[ids.total](), o1.total);
        assert.equal(H[ids.cbx].get(), o1.cbx);

        src.destroy();
        r2.destroy();
    }
});

// ============================== new rows N1-N10 + exports + GC (ASSERTIONS 3, 4, 5) ===========================

// --- N1. D-B: snapshot() inside ANY running body throws, even under untrack/createRoot/runWithOwner ---------

test("N1 snapshot inside a body throws /not settled/ under untrack(), createRoot(), runWithOwner() (D-B)", () => {
    const r = createRegistry();
    const s = r.signal(1);
    const thrown = { untrack: null, root: null, rwo: null, plain: null, comp: null };
    const probe = (key, f) => { try { f(); } catch (e) { thrown[key] = e; } };
    r.effect(() => {
        s();
        probe("plain", () => r.snapshot());
        probe("untrack", () => r.untrack(() => r.snapshot()));
        probe("root", () => r.createRoot(() => r.snapshot()));
        const o = r.getOwner();
        probe("rwo", () => r.runWithOwner(o, () => r.snapshot()));
    });
    const c = r.computed(() => { probe("comp", () => r.untrack(() => r.snapshot())); return 0; });
    c();
    for (const k of Object.keys(thrown)) {
        assert.ok(thrown[k] instanceof Error, k + ": snapshot must throw inside a running body");
        assert.match(thrown[k].message, NOT_SETTLED, k);
    }
    // control: outside any body it works
    assert.equal(r.snapshot().v, 1);
});

// --- N2. runWithOwner adoption survives snapshot/restore --------------------------------------------------

test("N2 runWithOwner-adopted child keeps its owner through snapshot/restore", () => {
    const src = createRegistry();
    let handle = null;
    const outer = src.effect(() => { handle = src.getOwner(); });
    let child = null;
    src.runWithOwner(handle, () => { child = src.computed(() => 7); child(); });
    const outerId = src.nodeId(outer), childId = src.nodeId(child);
    const snap = src.snapshot();
    assert.equal(snap.nodes.find((n) => n.id === childId).ownerId, outerId, "adoption captured as ownerId");

    const H = {};
    const r2 = src.restore(snap, { fnsById: { [outerId]: () => {}, [childId]: () => 7 }, handles: H });
    assert.equal(r2.snapshot().nodes.find((n) => n.id === childId).ownerId, outerId);
    const owned = [];
    r2.forEachOwned(H[outerId], (d) => owned.push(d.id));
    assert.deepEqual(owned, [childId]);
    r2.destroy();
});

// --- N3. a scheduled effect is restored WITHOUT its scheduler (D-D) ----------------------------------------

test("N3 scheduled effect restores without the scheduler: synchronous re-run after one dep set", () => {
    const src = createRegistry();
    const s = src.signal(1);
    const queue = [];
    const eff = src.effect(() => { s(); }, { scheduler: (run) => { queue.push(run); } });
    while (queue.length) queue.shift()();    // drain the deferred first run
    const sId = src.nodeId(s), effId = src.nodeId(eff);
    const snap = src.snapshot();

    const H = {};
    let runs = 0;
    const r2 = src.restore(snap, { fnsById: { [effId]: () => { H[sId](); runs++; } }, handles: H });
    assert.equal(runs, 0, "0 runs on restore");
    H[sId].set(2);
    assert.equal(runs, 1, "ran synchronously (no scheduler carried)");
    assert.equal(queue.length, 0, "the source scheduler was never consulted");
    r2.destroy();
});

// --- N4. onCleanup registrations are not carried (D-D) ----------------------------------------------------

test("N4 last-run onCleanup is not carried into the restored registry", () => {
    const src = createRegistry();
    const s = src.signal(1);
    let cleanups = 0;
    const eff = src.effect(() => { s(); src.onCleanup(() => { cleanups++; }); });
    const sId = src.nodeId(s), effId = src.nodeId(eff);
    const snap = src.snapshot();
    const H = {};
    const r2 = src.restore(snap, { fnsById: { [effId]: () => { H[sId](); } }, handles: H });
    H[sId].set(2);
    H[sId].set(3);
    r2.destroy();
    assert.equal(cleanups, 0, "the original cleanup never runs from the restored graph");
    // control: the source effect still owns its cleanup and runs it on a re-run
    s.set(2);
    assert.equal(cleanups, 1);
});

// --- N5. custom equals is not carried (D-D) ---------------------------------------------------------------

test("N5 custom equals is not carried: the restored signal uses Object.is", () => {
    const src = createRegistry();
    const s = src.signal(1, { equals: () => true });   // never considers a write a change
    s.set(2);
    assert.equal(s(), 1, "control: source equals swallows the write");
    const sId = src.nodeId(s);
    const snap = src.snapshot();
    const H = {};
    const r2 = src.restore(snap, { handles: H });
    H[sId].set(2);
    assert.equal(H[sId](), 2, "restored signal applies the write (default Object.is)");
    r2.destroy();
});

// --- N6. D-A: op-1 / op-2 flags ----------------------------------------------------------------------------

test("N6 onGraphMutation op 1 / op 2 flags: callables 32 / 1 / 2, boxes 160 / 129", () => {
    const r = createRegistry();
    const ev = [];
    r.onGraphMutation((op, id, flags) => { if (op === 1 || op === 2) ev.push([op, flags]); });
    const s = r.signal(0);
    const c = r.computed(() => s());
    const stop = r.effect(() => { s(); });
    const bx = r.signalBox(0);
    const cbx = r.computedBox(() => bx.get());
    assert.deepEqual(ev, [[1, F_SIGNAL], [1, F_COMPUTED], [1, F_EFFECT], [1, F_SIGNAL_BOX], [1, F_COMPUTED_BOX]]);
    ev.length = 0;
    stop();
    r.dispose(c);
    r.dispose(s);
    r.dispose(cbx);
    r.dispose(bx);
    const flagsOf = (f) => ev.filter((e) => e[0] === 2 && e[1] === f).length;
    assert.equal(flagsOf(F_EFFECT), 1);
    assert.equal(flagsOf(F_COMPUTED), 1);
    assert.equal(flagsOf(F_SIGNAL), 1);
    assert.equal(flagsOf(F_COMPUTED_BOX), 1);
    assert.equal(flagsOf(F_SIGNAL_BOX), 1);
    assert.equal(ev.length, 5, "exactly one op 2 per node, no stray flags");
});

// --- N7. snapshot fires no hook events -----------------------------------------------------------------------

test("N7 snapshot() fires 0 onGraphMutation events", () => {
    const r = createRegistry();
    const s = r.signal(1);
    r.computed(() => s())();
    r.signalBox(2);
    let n = 0;
    r.onGraphMutation(() => { n++; });
    assert.equal(typeof r.snapshot, "function");
    r.snapshot();
    assert.equal(n, 0);
});

// --- N8. after destroy() ---------------------------------------------------------------------------------------

test("N8 snapshot after destroy() is { v: 1, nodes: [], gv, nextId } (the clock and the next id survive destroy)", () => {
    const r = createRegistry();
    r.signal(1);
    r.signalBox(2);
    r.destroy();
    assert.deepStrictEqual(r.snapshot(), { v: 1, nodes: [], gv: 1, nextId: 3 });
    assert.deepStrictEqual(createRegistry().snapshot(), { v: 1, nodes: [], gv: 1, nextId: 1 }, "fresh registry");
});

// --- N9. disposed ids are absent ---------------------------------------------------------------------------

test("N9 a disposed node's id is absent from the snapshot", () => {
    const r = createRegistry();
    const a = r.signal(1), b = r.signal(2);
    const c = r.computed(() => a() + b());
    c();
    const aId = r.nodeId(a), bId = r.nodeId(b), cId = r.nodeId(c);
    r.dispose(c);
    const ids = r.snapshot().nodes.map((n) => n.id);
    assert.ok(!ids.includes(cId), "disposed computed absent");
    assert.deepEqual(ids.sort((x, y) => x - y), [aId, bId].sort((x, y) => x - y));
});

// --- N10. mid-restore CapacityError --------------------------------------------------------------------------

test("N10 restore with config { maxNodes: 4 } of a 10-node snapshot throws CapacityError", () => {
    const src = createRegistry();
    for (let i = 0; i < 10; i++) src.signal(i);
    const snap = src.snapshot();
    assert.equal(snap.nodes.length, 10);
    assert.throws(() => src.restore(snap, { config: { maxNodes: 4 } }), (e) => e instanceof CapacityError);
});

// --- top-level exports ------------------------------------------------------------------------------------------

test("top-level snapshot / restore exports exist and round-trip on the default registry", () => {
    assert.equal(typeof Sig.snapshot, "function");
    assert.equal(typeof Sig.restore, "function");
    const snap = Sig.snapshot();
    assert.equal(snap.v, 1);
    assert.ok(Array.isArray(snap.nodes));
    const r2 = Sig.restore(snap, {});
    assert.equal(typeof r2.snapshot, "function");
    r2.destroy();
});

// --- ASSERTION 5: 2000-node snapshot, no config; restored effect run counts ------------------------------------

test("A5 2000-node snapshot restores without config: activeNodes 2000, no CapacityError", () => {
    const src = createRegistry({ maxNodes: 4096 });
    for (let i = 0; i < 2000; i++) src.signal(i);
    const r2 = src.restore(src.snapshot(), {});
    assert.equal(r2.stats().activeNodes, 2000);
    r2.destroy();
});

test("A5 restored effect runs 0x on restore, 1x after one dep set", () => {
    const src = createRegistry();
    const s = src.signal(0);
    let n = 0;
    const eff = src.effect(() => { s(); n++; });
    assert.equal(n, 1);
    const sId = src.nodeId(s), effId = src.nodeId(eff);
    const H = {};
    let runs = 0;
    const snap = src.snapshot();
    const r2 = src.restore(snap, { fnsById: { [effId]: () => { H[sId](); runs++; } }, handles: H });
    assert.equal(runs, 0);
    assert.deepStrictEqual(r2.snapshot(), snap, "the effect's stamps (evalVersion / markEpoch), the clock and the next id round-trip");
    H[sId].set(1);
    assert.equal(runs, 1);
    assert.equal(n, 1, "source effect untouched");
    r2.destroy();
});

// --- ASSERTION 5: seeded 32-bit-exact randomized re-snapshot deepEquals original (200 seeds, own key/op streams) -

function mulberry32(a) {
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test("A5 randomized graphs: re-snapshot of the restore deepEquals the original (200 seeds, coverage floor)", () => {
    const shape = mulberry32(0x5eed0001);   // graph-shape stream
    const ops = mulberry32(0x5eed0002);     // op / value stream (independent)
    let cov = { computed: 0, box: 0, cbox: 0, effect: 0, dirty: 0, owned: 0, edges: 0 };
    for (let seed = 0; seed < 200; seed++) {
        const r = createRegistry();
        const nodes = [];      // { h, kind, id, srcs: [indices into nodes] }
        const nSig = 2 + ((shape() * 4) | 0);
        for (let i = 0; i < nSig; i++) nodes.push({ kind: "signal", h: r.signal((ops() * 100) | 0), srcs: [] });
        const nBox = (shape() * 2) | 0;
        for (let i = 0; i < nBox; i++) { nodes.push({ kind: "signalBox", h: r.signalBox((ops() * 100) | 0), srcs: [] }); cov.box++; }
        const nCmp = 1 + ((shape() * 5) | 0);
        const readOf = (n) => (n.kind === "signal" ? n.h() : n.kind === "signalBox" ? n.h.get() : n.kind === "computedBox" ? n.h.get() : n.h());
        for (let i = 0; i < nCmp; i++) {
            const k = 1 + ((shape() * 2) | 0);
            const srcs = [];
            for (let j = 0; j < k; j++) srcs.push((shape() * nodes.length) | 0);
            const boxed = shape() < 0.25;
            const fn = () => { let t = 0; for (let j = 0; j < srcs.length; j++) t += readOf(nodes[srcs[j]]); return t | 0; };
            nodes.push({ kind: boxed ? "computedBox" : "computed", h: boxed ? r.computedBox(fn) : r.computed(fn), srcs, fn });
            cov.computed++; if (boxed) cov.cbox++; cov.edges += srcs.length;
        }
        for (let i = 0; i < nodes.length; i++) nodes[i].id = r.nodeId(nodes[i].h);
        // evaluate a random subset (clean), leave others never-read; dirty some by a write
        for (const n of nodes) if ((n.kind === "computed" || n.kind === "computedBox") && ops() < 0.6) readOf(n);
        if (shape() < 0.5) {
            const e = r.effect(() => { for (const n of nodes) if (n.kind === "computed") { n.h(); break; } });
            nodes.push({ kind: "effect", h: e, id: r.nodeId(e), srcs: [] }); cov.effect++;
        }
        if (ops() < 0.5) { const sg = nodes[0]; sg.h.set(((ops() * 100) | 0) + 1000); cov.dirty++; }
        const snap = r.snapshot();
        for (const n of snap.nodes) if (n.ownerId !== null) cov.owned++;
        const H = {};
        const fnsById = {};
        for (const n of nodes) {
            if (n.kind === "computed" || n.kind === "computedBox") {
                fnsById[n.id] = () => { let t = 0; for (let j = 0; j < n.srcs.length; j++) { const m = nodes[n.srcs[j]]; const hh = H[m.id]; t += (m.kind === "signal" || m.kind === "computed") ? hh() : hh.get(); } return t | 0; };
            } else if (n.kind === "effect") {
                fnsById[n.id] = () => { for (const m of nodes) if (m.kind === "computed") { H[m.id](); break; } };
            }
        }
        const r2 = r.restore(snap, { fnsById, handles: H });
        // D-L / D-M / D-O (b100): every record round-trips WHOLE -- a dirty evaluated computed is seeded with its value,
        // version and stamps, a never-read one stays uncomputed with its recorded zeros -- and so do gv and nextId.
        assert.deepStrictEqual(r2.snapshot(), snap, "seed " + seed);
        r.destroy(); r2.destroy();
    }
    // asserted coverage floor: the stream really exercised the feature classes
    assert.ok(cov.computed >= 200, "computeds " + cov.computed);
    assert.ok(cov.box >= 50 && cov.cbox >= 20, "boxes " + cov.box + "/" + cov.cbox);
    assert.ok(cov.effect >= 50, "effects " + cov.effect);
    assert.ok(cov.dirty >= 50, "dirty " + cov.dirty);
    assert.ok(cov.owned >= 0 && cov.edges >= 300, "edges " + cov.edges);
});

// --- ASSERTION 3: GC rows (0 B/op on a restored registry) ------------------------------------------------------

test("A3 10k signalBox.set + computedBox.get on a restored registry: 0 B/op, maxMajor 0 (tier: npm run test:gc)",
    { skip: HAVE_GC ? false : "needs --expose-gc" }, async () => {
    const src = createRegistry();
    const bx = src.signalBox(0);
    const cbx = src.computedBox(() => bx.get() + 1);
    cbx.get();
    const bxId = src.nodeId(bx), cbxId = src.nodeId(cbx);
    const H = {};
    const r2 = src.restore(src.snapshot(), { fnsById: { [cbxId]: () => H[bxId].get() + 1 }, handles: H });
    const rb = H[bxId], rc = H[cbxId];
    // hold a sink so the read is not dead code; Smi-range values so the cell never boxes
    let sink = 0;
    const step = (i) => { rb.set(i & 1023); sink = (sink + rc.get()) & 0xffff; };
    const empty = (i) => { sink = (sink + (i & 1023)) & 0xffff; };
    const keep = [];
    const boxer = (i) => { keep[i & 7] = [i, i]; };     // control: allocates an array per op
    const used = () => getHeapStatistics().used_heap_size;
    const WIN = 20000, WINDOWS = 8;
    const lane = (f) => {
        const out = [];
        for (let w = 0; w < WINDOWS; w++) {
            const a = used();
            for (let i = 0; i < WIN; i++) f(i);
            const b = used();
            out.push(b >= a ? (b - a) / WIN : null);   // a scavenge mid-window is "unmeasured", not zero
        }
        return out;
    };
    const minOf = (xs) => { let m = null; for (let w = 1; w < xs.length; w++) if (xs[w] !== null && (m === null || xs[w] < m)) m = xs[w]; return m; };
    for (let i = 0; i < 50000; i++) { step(i); empty(i); boxer(i); }
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 50));   // the pre-window gc's entry lands before the profiler starts
    const gcp = new GcProfiler().start();
    const base = minOf(lane(empty)), per = minOf(lane(step)), ctl = minOf(lane(boxer));
    await new Promise((r) => setTimeout(r, 50));   // GC entries arrive asynchronously: settle before summary()
    const sum = gcp.summary();
    const rep = checkNoGc(sum, { maxMajor: 0 });
    gcp.stop();
    assert.notEqual(base, null, "unmeasured baseline is not zero");
    assert.notEqual(per, null, "unmeasured is not zero");
    assert.ok(ctl !== null && ctl - base >= 8, "control must show an allocation (>= 8 B/op) or the lane is blind: " + ctl);
    assert.ok(per - base <= 0.05, "B/op " + (per - base));
    assert.equal(sum.gc.major, 0, "maxMajor 0");
    assert.ok(rep.ok, JSON.stringify(rep.violations));
    assert.ok(sink >= 0);
    r2.destroy();
});

test("A3 MUST-FAIL control: a globalThis.gc() inside the measured window -> checkNoGc rep.ok === false (tier: npm run test:gc)",
    { skip: HAVE_GC ? false : "needs --expose-gc" }, async () => {
    const r = createRegistry();
    const bx = r.signalBox(0);
    const cbx = r.computedBox(() => bx.get() + 1);
    let sink = 0;
    globalThis.gc();
    await new Promise((res) => setTimeout(res, 50));
    const gcp = new GcProfiler().start();
    for (let i = 0; i < 20000; i++) { bx.set(i & 1023); sink = (sink + cbx.get()) & 0xffff; }
    globalThis.gc();                                // the planted major GC the gate must see
    await new Promise((res) => setTimeout(res, 50));
    const sum = gcp.summary();
    const rep = checkNoGc(sum, { maxMajor: 0 });
    gcp.stop();
    assert.equal(rep.ok, false, "the gate is blind to a major GC in its window: " + JSON.stringify(sum.gc));
    assert.ok(sum.gc.major >= 1, "major " + sum.gc.major);
    assert.ok(sink >= 0);
    r.destroy();
});

// ==================================================================================================================
// A9 round 2 -- restore input law (burst 96, batch C1; REVIEW-b95 E1, E2, E3, E4, E9 + the null-record nit).
// Every row mutates a REAL snapshot() output; each NEW row must fail on the round-1 engine (8c0dc0b2). Rows marked
// "control" pass on both engines by design (they pin what the law must still accept).
describe("A9 round 2 -- restore input law", () => {
    const named = (re, T = Error) => (e) => e instanceof T && re.test(e.message);
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const recOf = (snap, id) => snap.nodes.find((n) => n.id === id);
    const twoSignals = () => { const r = createRegistry(); r.signal(1); r.signal(2); return { r, snap: r.snapshot() }; };
    const chain = () => {   // a <- c1 <- c2, both read (clean)
        const r = createRegistry();
        const a = r.signal(1);
        const c1 = r.computed(() => a() + 1);
        const c2 = r.computed(() => c1() * 2);
        c2();
        const aId = r.nodeId(a), c1Id = r.nodeId(c1), c2Id = r.nodeId(c2);
        return { r, aId, c1Id, c2Id, snap: r.snapshot(), fns: { [c1Id]: () => 0, [c2Id]: () => 0 } };
    };

    // --- E1 int law --------------------------------------------------------------------------------------------
    test("E1 ids {1, 1.5} throw (non-int id; no truncation into a duplicate)", () => {
        const { r, snap } = twoSignals();
        const bad = snap.nodes[0].id + 0.5;
        snap.nodes[1].id = bad;
        assert.throws(() => r.restore(snap, {}), named(new RegExp("^\\[lite-signal\\] restore: invalid id " + esc(bad) + " at index 1$"), TypeError));
    });
    test("E1 ids {1, 2**32+1} throw (outside int32)", () => {
        const { r, snap } = twoSignals();
        const bad = 2 ** 32 + snap.nodes[0].id;
        snap.nodes[1].id = bad;
        assert.throws(() => r.restore(snap, {}), named(new RegExp("invalid id " + esc(bad) + " at index 1$"), TypeError));
    });
    for (const bad of [NaN, -5, "toString", 0]) {
        test("E1 id " + JSON.stringify(String(bad)) + " throws", () => {
            const { r, snap } = twoSignals();
            snap.nodes[0].id = bad;
            assert.throws(() => r.restore(snap, {}), named(new RegExp("invalid id " + esc(bad) + " at index 0$"), TypeError));
        });
    }
    test("E1 NaN version throws", () => {
        const { r, snap } = twoSignals();
        snap.nodes[0].version = NaN;
        assert.throws(() => r.restore(snap, {}), named(/invalid version NaN at index 0$/, TypeError));
    });
    test("E1 control: a negative int32 version (wrapped clock) is accepted", () => {
        const { r, snap } = twoSignals();
        snap.nodes[0].version = -7;
        const H = {};
        r.restore(snap, { handles: H });
        assert.equal(Object.keys(H).length, 2);
    });
    test("E1 float dep id throws (named, not as a dangling dep)", () => {
        const { r, aId, c1Id, snap, fns } = chain();
        recOf(snap, c1Id).deps = [aId + 0.5];
        assert.throws(() => r.restore(snap, { fnsById: fns }), named(new RegExp("invalid dep id " + esc(aId + 0.5) + " at index \\d+$"), TypeError));
    });
    test("E1 float ownerId throws (named, not as a missing owner)", () => {
        const { r, snap } = twoSignals();
        snap.nodes[0].ownerId = 1.5;
        assert.throws(() => r.restore(snap, {}), named(/invalid ownerId 1\.5 at index 0$/, TypeError));
    });

    // --- E2 opts law -------------------------------------------------------------------------------------------
    test("E2 unknown key {handels:{}} throws with did-you-mean \"handles\"", () => {
        const { r, snap } = twoSignals();
        assert.throws(() => r.restore(snap, { handels: {} }), named(/"handels" is not a recognized option \(did you mean "handles"\?\)/, TypeError));
    });
    test("E2 Object.create({handles:{}}) throws; the inherited handles object stays empty", () => {
        const { r, snap } = twoSignals();
        const H = {};
        assert.throws(() => r.restore(snap, Object.create({ handles: H })), named(/plain object/, TypeError));
        assert.equal(Object.keys(H).length, 0);
    });
    test("E2 array opts throws", () => {
        const { r, snap } = twoSignals();
        assert.throws(() => r.restore(snap, []), named(/plain object/, TypeError));
    });
    test("E2 fnsById must be an object", () => {
        const { r, snap } = twoSignals();
        assert.throws(() => r.restore(snap, { fnsById: 5 }), named(/fnsById must be an object/, TypeError));
    });
    test("E2 an inherited fnsById body is never used (throws missing fn)", () => {
        const r = createRegistry();
        const a = r.signal(2);
        const c = r.computed(() => a() * 3);
        c();
        const cId = r.nodeId(c);
        const snap = r.snapshot();
        const fnsById = Object.create({ [cId]: () => 0 });
        assert.throws(() => r.restore(snap, { fnsById }), named(new RegExp("^\\[lite-signal\\] restore: missing fn for id " + cId + " \\(computed\\)$")));
    });

    // --- E4 structure ------------------------------------------------------------------------------------------
    test("E4 a signal record with deps throws", () => {
        const { r, snap } = twoSignals();
        snap.nodes[1].deps = [snap.nodes[0].id];
        assert.throws(() => r.restore(snap, {}), named(/has deps/));
    });
    test("E4 an effect as a dep source throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const c = r.computed(() => s() + 1);
        const e = r.effect(() => { s(); });
        c();
        const cId = r.nodeId(c), eId = r.nodeId(e);
        const snap = r.snapshot();
        recOf(snap, cId).deps = [eId];
        assert.throws(() => r.restore(snap, { fnsById: { [cId]: () => 0, [eId]: () => {} } }), named(/is an effect/));
    });
    const owned = () => {
        const r = createRegistry();
        const s = r.signal(1);
        let child;
        const outer = r.effect(() => { child = r.computed(() => 1); child(); });
        const childId = r.nodeId(child), outerId = r.nodeId(outer);
        return { r, sId: r.nodeId(s), childId, outerId, snap: r.snapshot(), fns: { [outerId]: () => {}, [childId]: () => 1 } };
    };
    test("E4 a signal as owner throws", () => {
        const { r, sId, childId, snap, fns } = owned();
        recOf(snap, childId).ownerId = sId;
        assert.throws(() => r.restore(snap, { fnsById: fns }), named(/is a signal/));
    });
    test("E4 a self-owner throws", () => {
        const { r, childId, snap, fns } = owned();
        recOf(snap, childId).ownerId = childId;
        assert.throws(() => r.restore(snap, { fnsById: fns }), named(/owns itself/));
    });
    test("E4 an owner cycle 1<->2 throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const e1 = r.effect(() => { s(); });
        const e2 = r.effect(() => { s(); });
        const e1Id = r.nodeId(e1), e2Id = r.nodeId(e2);
        const snap = r.snapshot();
        recOf(snap, e1Id).ownerId = e2Id;
        recOf(snap, e2Id).ownerId = e1Id;
        assert.throws(() => r.restore(snap, { fnsById: { [e1Id]: () => {}, [e2Id]: () => {} } }), named(/owner cycle/));
    });
    test("E4 (D-N) a live-built dep cycle among clean computeds is restored, not refused; reads match the live twin incl. its CycleError", () => {
        const r = createRegistry(), G = {};
        G.a = r.signal(1);
        G.c1 = r.computed(() => { try { G.c2(); } catch (e) {} return G.a() + 1; });
        G.c2 = r.computed(() => G.c1() * 2);
        assert.equal(G.c2(), 4);
        const aId = r.nodeId(G.a), c1Id = r.nodeId(G.c1), c2Id = r.nodeId(G.c2);
        const snap = r.snapshot();
        assert.equal(recOf(snap, c1Id).clean, true); assert.equal(recOf(snap, c2Id).clean, true);
        assert.ok(recOf(snap, c1Id).deps.includes(c2Id) && recOf(snap, c2Id).deps.includes(c1Id), "the snapshot holds the clean cycle c1 <-> c2");
        const H = {}, K = {};
        const r2 = r.restore(snap, { fnsById: { [c1Id]: () => { try { K.c2(); } catch (e) {} return K.a() + 1; }, [c2Id]: () => K.c1() * 2 }, handles: H });
        K.a = H[aId]; K.c1 = H[c1Id]; K.c2 = H[c2Id];
        assert.deepStrictEqual(r2.snapshot(), snap);
        assert.equal(K.c2(), 4, "clean: cache hit");
        const out = (f) => { try { return f(); } catch (e) { return e.constructor.name + ": " + e.message; } };
        G.a.set(5); K.a.set(5);
        const lv = out(() => G.c2());
        // FIX-T A1 / D2 = G-a (b102, LEDGER #42): the cyclic pre-walk throws CycleError at depth > nodePool.length
        // instead of overflowing the stack (b101-before: RangeError, the probe 0c class). D-N itself is unchanged.
        assert.match(lv, /^Error: CycleError: Circular/, "live throws the pre-walk CycleError (was RangeError until b101)");
        assert.equal(out(() => K.c2()), lv);
    });
    test("E4 control: a valid owner tree + clean chain still restores and propagates", () => {
        const { r, aId, c2Id, snap } = chain();
        const H = {};
        const fns = {};
        const ids = snap.nodes.map((n) => n.id);
        fns[ids[1]] = () => H[aId]() + 1;
        fns[ids[2]] = () => H[ids[1]]() * 2;
        r.restore(snap, { fnsById: fns, handles: H });
        assert.equal(H[c2Id](), 4);
        H[aId].set(5);
        assert.equal(H[c2Id](), 12);
        const o = owned();
        const H2 = {};
        o.r.restore(o.snap, { fnsById: o.fns, handles: H2 });
        assert.equal(Object.keys(H2).length, 3);
    });

    // --- E9 dangling deps on dirty / never-read computeds --------------------------------------------------------
    test("E9 a never-read computed with a dangling dep id throws", () => {
        const r = createRegistry();
        const a = r.signal(1);
        const c = r.computed(() => a() + 1);
        const cId = r.nodeId(c);
        const snap = r.snapshot();
        assert.equal(recOf(snap, cId).clean, false);
        recOf(snap, cId).deps = [999999];
        recOf(snap, cId).subPos = [0];   // D-J: matching length, so the dangling dep (not subPos) is the error
        assert.throws(() => r.restore(snap, { fnsById: { [cId]: () => 0 } }),
            named(new RegExp("^\\[lite-signal\\] restore: dep id 999999 missing for id " + cId + "$")));
    });
    test("E9 a dirty computed with a dangling dep id throws", () => {
        const r = createRegistry();
        const a = r.signal(1);
        const c = r.computed(() => a() + 1);
        c();
        a.set(5);
        const cId = r.nodeId(c);
        const snap = r.snapshot();
        assert.equal(recOf(snap, cId).clean, false);
        recOf(snap, cId).deps = [r.nodeId(a), 999999];
        recOf(snap, cId).subPos = [0, 0];   // D-J: matching length, so the dangling dep (not subPos) is the error
        assert.throws(() => r.restore(snap, { fnsById: { [cId]: () => 0 } }), named(/dep id 999999 missing for id/));
    });

    // --- E3 handles copied out only after success -------------------------------------------------------------------
    test("E3 a duplicate [S1,S2,S1] throws and opts.handles stays empty", () => {
        const { r, snap } = twoSignals();
        snap.nodes[2] = { ...snap.nodes[0] };
        const H = {};
        assert.throws(() => r.restore(snap, { handles: H }), named(/duplicate id/));
        assert.equal(Object.keys(H).length, 0);
    });
    test("E3 a mid-build CapacityError leaves opts.handles empty", () => {
        const r = createRegistry();
        for (let i = 0; i < 10; i++) r.signal(i);
        const snap = r.snapshot();
        const H = {};
        assert.throws(() => r.restore(snap, { handles: H, config: { maxNodes: 4 } }), (e) => e instanceof CapacityError);
        assert.equal(Object.keys(H).length, 0);
    });

    // --- null record nit --------------------------------------------------------------------------------------------
    test("a null record throws a NAMED TypeError", () => {
        const { r, snap } = twoSignals();
        snap.nodes[2] = null;
        assert.throws(() => r.restore(snap, {}), (e) => e instanceof TypeError &&
            e.message === "[lite-signal] restore: invalid record at index 2");
    });
});

// ==================================================================================================================
// A9 round 2 -- settle guards (burst 96, batch C2; REVIEW-b95 E5 / E10, maintainer rulings D-B2 + D-D2). snapshot()
// must refuse inside a dispose (cleanups, cascade, op-2 / op-4 listeners), inside any onGraphMutation listener, and
// while a scheduled effect run is pending. Each non-control row must fail on the C1 engine (f3142201).
describe("A9 round 2 -- settle guards", () => {
    const MSG_DISPOSE = "[lite-signal] snapshot: graph not settled (dispose in progress)";
    const MSG_HOOK = "[lite-signal] snapshot: graph not settled (onGraphMutation listener running)";
    const MSG_PENDING = "[lite-signal] snapshot: graph not settled (scheduled effect run pending)";
    const NO_THROW = { message: "(no throw)" };
    // Capture inside user code; assert outside (a throw from a cleanup would be re-routed).
    const trySnap = (r) => { try { r.snapshot(); return NO_THROW; } catch (e) { return e; } };
    const msgOf = (e) => (e === null ? "(never ran)" : e.message);

    // --- D-B2 disposeDepth --------------------------------------------------------------------------------------
    test("D-B2 snapshot() from onCleanup during a top-level effect dispose throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        let got = null;
        const eff = r.effect(() => { s(); r.onCleanup(() => { got = trySnap(r); }); });
        eff();
        assert.equal(msgOf(got), MSG_DISPOSE);
        assert.doesNotThrow(() => r.snapshot(), "settled again after the dispose");
    });
    test("D-B2 snapshot() from a child cleanup mid-cascade (createRoot, disposed via dispose(handle)) throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        let got = null;
        const outer = r.createRoot(() => r.effect(() => {
            r.effect(() => { s(); r.onCleanup(() => { got = trySnap(r); }); });
        }));
        r.dispose(outer);
        assert.equal(msgOf(got), MSG_DISPOSE);
    });
    test("D-B2 snapshot() from a child cleanup mid-cascade (outer effect's own dispose handle) throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        let got = null;
        const outer = r.effect(() => {
            r.effect(() => { s(); r.onCleanup(() => { got = trySnap(r); }); });
        });
        outer();
        assert.equal(msgOf(got), MSG_DISPOSE);
    });
    test("D-B2 snapshot() from an owned effect's cleanup while dispose(computed) cascades throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        let got = null;
        const c = r.computed(() => { r.effect(() => { r.onCleanup(() => { got = trySnap(r); }); }); return s(); });
        c();
        r.dispose(c);
        assert.equal(msgOf(got), MSG_DISPOSE);
    });
    test("D-B2 snapshot() from a restored effect's cleanup during its handle dispose throws", () => {
        const src = createRegistry();
        const s = src.signal(1);
        const eff = src.effect(() => { s(); });
        const sId = src.nodeId(s), effId = src.nodeId(eff);
        const H = {};
        let r2 = null, got = null;
        r2 = src.restore(src.snapshot(), { fnsById: { [effId]: () => { H[sId](); r2.onCleanup(() => { got = trySnap(r2); }); } }, handles: H });
        H[sId].set(2);                     // re-run registers the cleanup
        H[effId]();
        assert.equal(msgOf(got), MSG_DISPOSE);
        r2.destroy();
    });
    test("D-B2 snapshot() from a cleanup the throwing first run registered (effect() first-run-throw tail) throws", () => {
        const r = createRegistry();
        let got = null;
        assert.throws(() => r.effect(() => { r.onCleanup(() => { got = trySnap(r); }); throw new Error("boom"); }), /boom/);
        assert.equal(msgOf(got), MSG_DISPOSE);
    });
    test("D-B2 control: destroy() runs no cleanup and fires no listener (no snapshot can run inside it)", () => {
        const r = createRegistry();
        const s = r.signal(1);
        let cleanups = 0, events = 0;
        r.effect(() => { s(); r.onCleanup(() => { cleanups++; }); });
        r.onGraphMutation(() => { events++; });
        r.destroy();
        assert.equal(cleanups, 0);
        assert.equal(events, 0);
        assert.doesNotThrow(() => r.snapshot());
    });

    // --- D-B2 hookDepth ---------------------------------------------------------------------------------------
    test("D-B2 snapshot() from an onGraphMutation listener on op 2 (node-dispose) throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const eff = r.effect(() => { s(); });
        let got = null;
        const off = r.onGraphMutation((op) => { if (op === 2 && got === null) got = trySnap(r); });
        eff();
        off();
        assert.match(msgOf(got), NOT_SETTLED);
    });
    test("D-B2 snapshot() from an onGraphMutation listener on op 4 (link-remove) throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const eff = r.effect(() => { s(); });
        let got = null;
        const off = r.onGraphMutation((op) => { if (op === 4 && got === null) got = trySnap(r); });
        eff();
        off();
        assert.match(msgOf(got), NOT_SETTLED);
    });
    test("D-B2 snapshot() from an onGraphMutation listener on op 1 (top-level create: no dispose, no body) throws", () => {
        const r = createRegistry();
        let got = null;
        const off = r.onGraphMutation((op) => { if (op === 1 && got === null) got = trySnap(r); });
        r.signal(1);
        off();
        assert.equal(msgOf(got), MSG_HOOK);
    });
    test("D-B2 control: after the listener unsubscribes, snapshot() works again", () => {
        const r = createRegistry();
        let fired = 0;
        const off = r.onGraphMutation(() => { fired++; });
        r.signal(1);
        off();
        const before = fired;
        r.signal(2);
        assert.equal(fired, before, "unsubscribed listener no longer fires");
        assert.equal(r.snapshot().nodes.length, 2);
    });
    test("D-B2 control: stacked listeners unsubscribed in any order never resurrect a dead listener (A5b / DIV-F9)", () => {
        const r = createRegistry();
        const seen = [];
        const offA = r.onGraphMutation((op) => { if (op === 1) seen.push("A"); });
        const offB = r.onGraphMutation((op) => { if (op === 1) seen.push("B"); });
        r.signal(1);                       // B on top
        offA();                            // A is below the top: unlinked, B stays active
        r.signal(2);                       // still B
        offB();                            // B was the top; nothing live below it
        r.signal(3);                       // nothing delivered (A5b / DIV-F9: A stays dead)
        assert.deepEqual(seen, ["B", "B"]);
        assert.equal(r.snapshot().nodes.length, 3, "no listener running: settled");
        const offC = r.onGraphMutation(null);   // a null "clear" entry on an empty stack
        r.signal(4);
        offC();                            // nothing live below: still nothing
        r.signal(5);
        assert.deepEqual(seen, ["B", "B"]);
        assert.equal(r.snapshot().nodes.length, 5);
    });

    // --- D-D2 pending scheduled runs --------------------------------------------------------------------------
    test("D-D2 a QUEUED scheduled effect (re-run handed to its scheduler, not yet run) -> snapshot() throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const queue = [];
        r.effect(() => { s(); }, { scheduler: (run) => { queue.push(run); } });
        while (queue.length) queue.shift()();
        assert.doesNotThrow(() => r.snapshot(), "settled after the first run");
        s.set(2);
        assert.equal(queue.length, 1);
        assert.throws(() => r.snapshot(), (e) => e.message === MSG_PENDING);
    });
    test("D-D2 an effect whose FIRST scheduled run is pending -> snapshot() throws", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const queue = [];
        r.effect(() => { s(); }, { scheduler: (run) => { queue.push(run); } });
        assert.equal(queue.length, 1);
        assert.throws(() => r.snapshot(), (e) => e.message === MSG_PENDING);
    });
    test("D-D2 control: after the pending thunks run, snapshot() succeeds and restores live", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const queue = [];
        let srcRuns = 0;
        const eff = r.effect(() => { s(); srcRuns++; }, { scheduler: (run) => { queue.push(run); } });
        while (queue.length) queue.shift()();
        s.set(2);
        while (queue.length) queue.shift()();
        assert.equal(srcRuns, 2);
        const sId = r.nodeId(s), effId = r.nodeId(eff);
        const snap = r.snapshot();
        const rec = snap.nodes.find((n) => n.id === effId);
        assert.deepEqual(rec.deps, [sId], "the effect's deps survive (not inert)");
        const H = {};
        let runs = 0;
        const r2 = r.restore(snap, { fnsById: { [effId]: () => { H[sId](); runs++; } }, handles: H });
        assert.equal(runs, 0);
        H[sId].set(3);
        assert.equal(runs, 1);
        r2.destroy();
    });
});

// ==================================================================================================================
// A9 round 3 -- restore() pre-scan fixes + surviving-mutant rows (burst 97, batch C; REVIEW-b96 "ENGINE blockers
// (round 2)" R2-E1, R2-E2, R2-E3, R2-T, maintainer ruling D-F). Every non-control row must fail on the round-2
// engine (b97-before 15f49396); rows marked "control" pass on both engines by design.
describe("A9 round 3 -- restore pre-scan + mutant rows", () => {
    const named = (re, T = Error) => (e) => e instanceof T && re.test(e.message);
    const recOf = (snap, id) => snap.nodes.find((n) => n.id === id);
    const twoSignals = () => { const r = createRegistry(); r.signal(1); r.signal(2); return { r, snap: r.snapshot() }; };

    // --- R2-T: the three mutants that survived round 2 -------------------------------------------------------------
    test("R2-T HD-finally: a throwing onGraphMutation listener does not leave snapshot() refusing", () => {
        const r = createRegistry();
        const u = r.onGraphMutation(() => { throw new Error("L"); }); assert.throws(() => r.signal(1), /L/); u(); assert.doesNotThrow(() => r.snapshot());
    });
    test("R2-T DD-finally: a throwing onCleanup does not leave snapshot() refusing", () => {
        const r = createRegistry();
        const a = r.signal(1);
        const d = r.effect(() => { a(); r.onCleanup(() => { throw new Error("C"); }); }); assert.throws(() => d(), /C/); assert.doesNotThrow(() => r.snapshot());
    });
    test("R2-T E2-sym: Symbol-keyed restore options throw", () => {
        const r = createRegistry();
        const restore = (snap, opts) => r.restore(snap, opts);
        assert.throws(() => restore({ v: 1, nodes: [], gv: 1, nextId: 1 }, { [Symbol("x")]: 1 }), /Symbol keys/);
    });

    // --- R2-E1: a signal is never owned ------------------------------------------------------------------------
    const ownedSignal = (box) => {   // {1 signal}, {2 signal|signalBox}, {3 effect deps:[1]}; then 2.ownerId = 3
        const r = createRegistry();
        const s1 = r.signal(1);
        const s2 = box ? r.signalBox(2) : r.signal(2);
        const e = r.effect(() => { s1(); });
        const s1Id = r.nodeId(s1), s2Id = r.nodeId(s2), eId = r.nodeId(e);
        const snap = r.snapshot();
        recOf(snap, s2Id).ownerId = eId;
        return { r, s1Id, s2Id, eId, snap };
    };
    test("R2-E1 a signal record with an ownerId throws (never owned)", () => {
        const { r, s1Id, s2Id, eId, snap } = ownedSignal(false);
        const H = {};
        assert.throws(() => r.restore(snap, { fnsById: { [eId]: () => { H[s1Id](); } }, handles: H }),
            (e) => e instanceof Error && e.message === "[lite-signal] restore: signal id " + s2Id + " has an owner (a signal is never owned)");
        assert.equal(Object.keys(H).length, 0);
    });
    test("R2-E1 a signalBox record with an ownerId throws (never owned)", () => {
        const { r, s2Id, eId, snap } = ownedSignal(true);
        assert.throws(() => r.restore(snap, { fnsById: { [eId]: () => {} } }),
            (e) => e instanceof Error && e.message === "[lite-signal] restore: signalBox id " + s2Id + " has an owner (a signal is never owned)");
    });

    // --- D-G (b98, replaces the round-3 R2-E2 refusal): a non-clean computed under an effect / clean computed is
    // WIRED to its recorded deps and left UNCOMPUTED; restore never refuses it (snapshot() emits it on live graphs).
    test("D-G an effect depending on a clean:false computed restores WIRED; the computed stays uncomputed; the effect reacts", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const c = r.computed(() => s() + 1);
        const e = r.effect(() => { c(); });
        const sId = r.nodeId(s), cId = r.nodeId(c), eId = r.nodeId(e);
        const snap = r.snapshot();
        assert.equal(recOf(snap, cId).clean, true);
        dirtyRec(snap, recOf(snap, cId));                 // live-emittable stamps: marked after its last evaluation
        const H = {}, seen = []; let cRuns = 0;
        const r2 = r.restore(snap, { fnsById: { [cId]: () => { cRuns++; return H[sId]() + 1; }, [eId]: () => { seen.push(H[cId]()); } }, handles: H });
        assert.equal(cRuns, 0, "uncomputed: restore runs no body");
        assert.equal(recOf(r2.snapshot(), cId).clean, false, "still uncomputed after restore");
        assert.deepEqual(recOf(r2.snapshot(), cId).deps, [sId], "wired to its recorded deps");
        H[sId].set(5);
        assert.deepEqual(seen, [6], "the effect reacts through the wired dirty computed");
    });
    test("D-G a clean computed depending on a clean:false computed restores WIRED; the reader keeps its cache, then reacts", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const c1 = r.computed(() => s() + 1);
        const c2 = r.computed(() => c1() * 2);
        c2();
        const sId = r.nodeId(s), c1Id = r.nodeId(c1), c2Id = r.nodeId(c2);
        const snap = r.snapshot();
        assert.equal(recOf(snap, c2Id).clean, true);
        dirtyRec(snap, recOf(snap, c1Id));
        const H = {}; let c1Runs = 0;
        r.restore(snap, { fnsById: { [c1Id]: () => { c1Runs++; return H[sId]() + 1; }, [c2Id]: () => H[c1Id]() * 2 }, handles: H });
        assert.equal(c1Runs, 0);
        assert.equal(H[c2Id](), 4, "clean reader: cache hit");
        assert.equal(c1Runs, 0, "a cache hit pulls nothing");
        H[sId].set(5);
        assert.equal(H[c2Id](), 12, "the set reaches the clean reader through the wired dirty computed");
        assert.equal(c1Runs, 1);
    });
    test("R2-E2 control: a dirty computed depending on a dirty computed restores and reads fresh", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const c1 = r.computed(() => s() + 1);
        const c2 = r.computed(() => c1() * 2);
        c2();
        s.set(5);                          // both marked, neither re-read: clean:false, clean:false
        const sId = r.nodeId(s), c1Id = r.nodeId(c1), c2Id = r.nodeId(c2);
        const snap = r.snapshot();
        assert.equal(recOf(snap, c1Id).clean, false);
        assert.equal(recOf(snap, c2Id).clean, false);
        const H = {};
        r.restore(snap, { fnsById: { [c1Id]: () => H[sId]() + 1, [c2Id]: () => H[c1Id]() * 2 }, handles: H });
        assert.equal(H[c2Id](), 12);
        H[sId].set(7);
        assert.equal(H[c2Id](), 16);
    });

    // --- R2-E3: flags must be int32 on every record --------------------------------------------------------------
    for (const [label, bad, shown] of [["undefined", undefined, "undefined"], ["NaN", NaN, "NaN"], ["\"x\"", "x", "x"], ["1.5", 1.5, "1.5"], ["2**31", 2 ** 31, "2147483648"]]) {
        test("R2-E3 flags " + label + " throws invalid flags", () => {
            const { r, snap } = twoSignals();
            snap.nodes[0].flags = bad;
            assert.throws(() => r.restore(snap, {}), (e) => e instanceof TypeError &&
                e.message === "[lite-signal] restore: invalid flags " + shown + " at index 0");
        });
    }
    test("R2-E3 a missing flags key on a clean errored computed throws (no Error returned as a value)", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const c = r.computed(() => { if (s() > 0) throw new Error("E"); return 0; });
        assert.throws(() => c(), /E/);
        const cId = r.nodeId(c);
        const snap = r.snapshot();
        delete recOf(snap, cId).flags;
        const idx = snap.nodes.findIndex((n) => n.id === cId);
        assert.throws(() => r.restore(snap, { fnsById: { [cId]: () => 0 } }), named(new RegExp("invalid flags undefined at index " + idx + "$"), TypeError));
    });
    test("R2-E3 control: flags is read ONCE per record (a getter cannot pass the int check, then change; passes on the round-2 build by design)", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const c = r.computed(() => { if (s() > 0) throw new Error("E3-once"); return 0; });
        assert.throws(() => c(), /E3-once/);
        const sId = r.nodeId(s), cId = r.nodeId(c);
        const snap = r.snapshot();
        const live = recOf(snap, cId).flags;
        let reads = 0;
        Object.defineProperty(recOf(snap, cId), "flags", { get() { reads++; return reads === 1 ? live : 0; } });
        const H = {};
        r.restore(snap, { fnsById: { [cId]: () => H[sId]() * 10 }, handles: H });
        assert.equal(reads, 1, "flags getter reads");
        assert.throws(() => H[cId](), /E3-once/);
    });
    test("R2-E3 control: a live snapshot with a cached error (FLAG_HAS_ERROR) still rethrows after restore", () => {
        const r = createRegistry();
        const s = r.signal(1);
        const c = r.computed(() => { if (s() > 0) throw new Error("E3-cached"); return 0; });
        assert.throws(() => c(), /E3-cached/);
        const sId = r.nodeId(s), cId = r.nodeId(c);
        const snap = r.snapshot();
        const rec = recOf(snap, cId);
        assert.equal(rec.clean, true);
        assert.notEqual(rec.flags & 16, 0, "FLAG_HAS_ERROR (1 << 4) set in the live snapshot");
        const H = {};
        let bodyRuns = 0;
        r.restore(snap, { fnsById: { [cId]: () => { bodyRuns++; return H[sId]() * 10; } }, handles: H });
        assert.throws(() => H[cId](), /E3-cached/);
        assert.equal(bodyRuns, 0, "the cached error is a cache hit, not a recompute");
        H[sId].set(-1);
        assert.equal(H[cId](), -10);
    });

    // --- D-F: ids, dep ids and ownerIds are capped at 0x3FFFFFFF --------------------------------------------------
    test("D-F control (D-O): id 0x3FFFFFFF restores; the next created node takes the recorded nextId exactly (no maxId + 1) and works", () => {
        const { r, snap } = twoSignals();
        snap.nodes[1].id = 0x3FFFFFFF;
        snap.nextId = 0x40000000;                      // live-emittable: live's next id is past its largest id
        const H = {};
        const r2 = r.restore(snap, { handles: H });
        assert.equal(H[0x3FFFFFFF](), 2);
        const n = r2.signal(9);
        const nid = r2.nodeId(n);
        assert.equal(nid, 0x40000000, "next id is the recorded nextId (D-O), not maxId + 1");
        assert.notEqual(nid, snap.nodes[0].id);
        n.set(10);
        assert.equal(n(), 10);
        const ids = r2.snapshot().nodes.map((x) => x.id);
        assert.equal(new Set(ids).size, ids.length, "ids stay unique");
    });
    test("D-F id 0x40000000 throws invalid id", () => {
        const { r, snap } = twoSignals();
        snap.nodes[1].id = 0x40000000;
        assert.throws(() => r.restore(snap, {}), (e) => e instanceof TypeError &&
            e.message === "[lite-signal] restore: invalid id 1073741824 at index 1");
    });
    test("D-F id 0x7FFFFFFF throws invalid id (no int32 nodeSeq wrap)", () => {
        const { r, snap } = twoSignals();
        snap.nodes[1].id = 0x7FFFFFFF;
        assert.throws(() => r.restore(snap, {}), named(/invalid id 2147483647 at index 1$/, TypeError));
    });
    test("D-F dep id 0x40000000 throws invalid dep id", () => {
        const r = createRegistry();
        const a = r.signal(1);
        const c = r.computed(() => a() + 1);
        c();
        const cId = r.nodeId(c);
        const snap = r.snapshot();
        recOf(snap, cId).deps = [0x40000000];
        assert.throws(() => r.restore(snap, { fnsById: { [cId]: () => 0 } }), named(/invalid dep id 1073741824 at index \d+$/, TypeError));
    });
    test("D-F ownerId 0x40000000 throws invalid ownerId", () => {
        const { r, snap } = twoSignals();
        snap.nodes[0].ownerId = 0x40000000;
        assert.throws(() => r.restore(snap, {}), named(/invalid ownerId 1073741824 at index 0$/, TypeError));
    });

    // --- engine nit: listeners on op 3 (link-add) / op 5 (recompute) --------------------------------------------
    for (const op of [3, 5]) {
        test("control: snapshot() from an onGraphMutation listener on op " + op + " throws not settled", () => {
            const r = createRegistry();
            const s = r.signal(1);
            const c = r.computed(() => s() + 1);
            let got = null;
            const off = r.onGraphMutation((o) => { if (o === op && got === null) { try { r.snapshot(); got = "(no throw)"; } catch (e) { got = e.message; } } });
            c();
            off();
            assert.notEqual(got, null, "op " + op + " fired");
            assert.match(got, NOT_SETTLED);
        });
    }
});

// ---------------------------------------------------------------------------------------------------------------------
// A9 round 4 (burst 98, maintainer ruling D-G): restore() WIRES a non-clean computed that an effect / clean computed
// depends on, and leaves it UNCOMPUTED. Every row below is red on the round-3 build (refused) and every reaction row is
// red on the round-2 build (dead edge: 0 runs / stale value). Live repros: b97-evidence/review-docs/probe-selfwrite.mjs,
// review-code/e2-live-repro3.mjs, review-code/live-fuzz2.mjs (ported below with live-equivalence + self-writes).
describe("A9 round 4 -- D-G: dirty computeds under a reader restore wired + uncomputed", () => {
    const rec = (snap, id) => snap.nodes.find((n) => n.id === id);
    const bodyless = (snap) => { const f = {}; for (const x of snap.nodes) if (x.kind !== "signal" && x.kind !== "signalBox") f[x.id] = () => 0; return f; };

    test("D-G self-write pair: effect reads c then (untracked) writes c's source -> restored reacts live-equivalently", () => {
        const r = createRegistry(); const log = [];
        const s = r.signal(1); const c = r.computed(() => s() * 2);
        const e = r.effect(() => { log.push(c()); r.untrack(() => { if (s() < 2) s.set(2); }); });
        const sId = r.nodeId(s), cId = r.nodeId(c), eId = r.nodeId(e);
        const snap = r.snapshot();
        assert.equal(rec(snap, cId).clean, false); assert.deepEqual(rec(snap, cId).deps, [sId]);
        assert.equal(rec(snap, eId).clean, true); assert.deepEqual(rec(snap, eId).deps, [cId]);
        const H = {}, out = [];
        let r2 = null;
        r2 = r.restore(snap, { fnsById: { [cId]: () => H[sId]() * 2, [eId]: () => { out.push(H[cId]()); r2.untrack(() => { if (H[sId]() < 2) H[sId].set(2); }); } }, handles: H });
        const L0 = log.length;
        s.set(5); s.set(6); H[sId].set(5); H[sId].set(6);
        assert.deepEqual(log, [2, 10, 12]);
        assert.deepEqual(out, log.slice(L0));
    });

    // D-G -> D-H (b102, FIX-T, PLAN-0s-fixt ADDENDUM 7 task 9a; LEDGER #38/F6 D-H split pull): until b101 a dep that
    // threw in b's pre-walk threw OUT of the pre-walk, so b never re-ran and stayed dirty under a clean reader. Now
    // refreshComputed never throws: a caches its error, b re-runs (bRuns 2) and its body's read of a throws a's cached
    // error -- the SAME object -- which b caches as its own (b clean, errored). The restored twin seeds both errors and
    // re-runs nothing on read (D-I copies live state). RED on b101-before (b dirty, bRuns 1).
    for (const mode of ["computed reader", "effect reader"]) {
        test("D-H throwing-dep pair (" + mode + "): the dependent re-runs into the dep's cached error (same object); restored == live", () => {
            const n = { a: 0, b: 0 }, thrown = { a: [], b: [] };
            const build = (r, G, log) => {
                G.s = r.signal(0);
                G.a = r.computed(() => { n.a++; if (G.s() > 0) { const e = new Error("E"); thrown.a.push(e); throw e; } return G.s(); });
                G.b = r.computed(() => { n.b++; try { return G.a() + 1; } catch (e) { thrown.b.push(e); throw e; } });
                G.b(); G.s.set(1);
                if (mode === "computed reader") { G.rd = r.computed(() => { try { return G.b(); } catch (e) { return -1; } }); log.push(G.rd()); }
                else G.rd = r.effect(() => { try { log.push(G.b()); } catch (e) { log.push(-1); } });
            };
            const r = createRegistry(); const G = {}, log = [];
            build(r, G, log);
            assert.deepEqual(log, [-1], "the reader saw b throw");
            assert.deepEqual(n, { a: 2, b: 2 }, "b re-ran after a's pre-walk refresh (D-H: the pre-walk does not throw)");
            assert.equal(thrown.a.length, 1); assert.equal(thrown.b.length, 1);
            assert.strictEqual(thrown.b[0], thrown.a[0], "b's body read threw a's cached error, the same object");
            const caught = (f) => { try { f(); } catch (e) { return e; } return null; };
            assert.strictEqual(caught(() => G.b()), thrown.a[0], "live b() throws a's error object");
            assert.strictEqual(caught(() => G.a()), thrown.a[0]);
            assert.deepEqual(n, { a: 2, b: 2 }, "cached: the reads re-run nothing");
            const snap = r.snapshot();
            const bId = r.nodeId(G.b), rdId = r.nodeId(G.rd), sId = r.nodeId(G.s), aId = r.nodeId(G.a);
            assert.equal(rec(snap, bId).clean, true, "b is clean: it re-ran and cached the error (was dirty until b101)");
            assert.equal(rec(snap, aId).clean, true);
            assert.equal(rec(snap, rdId).clean, true); assert.ok(rec(snap, rdId).deps.includes(bId));
            const H = {}, out = [], m = { a: 0, b: 0 };
            const fns = { [aId]: () => { m.a++; if (H[sId]() > 0) throw new Error("E"); return H[sId](); }, [bId]: () => { m.b++; return H[aId]() + 1; } };
            fns[rdId] = mode === "computed reader" ? () => { try { return H[bId](); } catch (e) { return -1; } } : () => { try { out.push(H[bId]()); } catch (e) { out.push(-1); } };
            r.restore(snap, { fnsById: fns, handles: H });
            const eb = caught(() => H[bId]()), ea = caught(() => H[aId]());
            assert.ok(eb instanceof Error && eb.message === "E", "restored b throws the seeded error");
            assert.strictEqual(eb, ea, "restored b and a throw the same object, like live");
            assert.deepEqual(m, { a: 0, b: 0 }, "the restored twin re-runs nothing on read");
            const L0 = log.length;
            G.s.set(-5); H[sId].set(-5);
            if (mode === "computed reader") { log.push(G.rd()); out.push(H[rdId]()); }
            assert.deepEqual(out, log.slice(L0));
            assert.deepEqual(out, [-4], "the set reaches the reader");
        });
    }

    test("D-G computedBox as the dirty source AND as the clean dependent (an effect over it reacts)", () => {
        const r = createRegistry();
        const s = r.signalBox(1);
        const src = r.computedBox(() => s.get() + 1);
        const dep = r.computedBox(() => src.get() * 10);
        const seen = [];
        const e = r.effect(() => { seen.push(dep.get()); });
        const sId = r.nodeId(s), srcId = r.nodeId(src), depId = r.nodeId(dep), eId = r.nodeId(e);
        const snap = r.snapshot();
        assert.equal(rec(snap, srcId).flags, F_COMPUTED_BOX); assert.equal(rec(snap, depId).flags, F_COMPUTED_BOX);
        assert.equal(rec(snap, depId).clean, true);
        dirtyRec(snap, rec(snap, srcId));                   // dirty computedBox source under a clean computedBox dependent
        const H = {}, out = [];
        r.restore(snap, { fnsById: { [srcId]: () => H[sId].get() + 1, [depId]: () => H[srcId].get() * 10, [eId]: () => { out.push(H[depId].get()); } }, handles: H });
        assert.equal(H[depId].get(), 20, "clean computedBox dependent: cache hit");
        H[sId].set(4);
        assert.deepEqual(out, [50]);
        assert.equal(H[depId].get(), 50);
    });

    test("D-G re-snapshot after restore shows ONE link per edge (wired, then re-tracked by the first read: no double-link)", () => {
        const r = createRegistry();
        const s = r.signal(1), t = r.signal(2);
        const c = r.computed(() => s() + t());
        const e = r.effect(() => { c(); });
        const sId = r.nodeId(s), tId = r.nodeId(t), cId = r.nodeId(c), eId = r.nodeId(e);
        const snap = r.snapshot();
        dirtyRec(snap, rec(snap, cId));
        const H = {};
        const r2 = r.restore(snap, { fnsById: { [cId]: () => H[sId]() + H[tId](), [eId]: () => { H[cId](); } }, handles: H });
        assert.deepEqual(rec(r2.snapshot(), cId).deps, [sId, tId], "wired once, before any read");
        assert.deepEqual(rec(r2.snapshot(), eId).deps, [cId]);
        H[sId].set(3);                                 // effect re-runs: c's first read runs its body over the wired links
        const re = r2.snapshot();
        assert.deepEqual(rec(re, cId).deps, [sId, tId]);
        assert.deepEqual(rec(re, eId).deps, [cId]);
        assert.equal(rec(re, cId).clean, true);
        let runs = 0; r2.effect(() => { runs++; H[cId](); });
        H[tId].set(9); assert.equal(runs, 2, "one link per edge: one re-run per set");
    });

    // --- D-I (b98): a dirty, evaluated computed restores UNCOMPUTED but SEEDED with its recorded value + version,
    // so its first re-run compares like the live node (an unchanged value does not propagate). Red on r4a (D-G only).
    const selfWritePair = (r, mk, guard) => {
        const s = r.signal(1); const c = mk(s); const log = [];
        const e = r.effect(() => { try { log.push(c()); } catch (x) { log.push("E:" + x.message); } r.untrack(() => { if (s() < guard) s.set(guard); }); });
        return { s, c, e, log };
    };
    const restoreSelfWrite = (r, snap, ids, body, guard) => {
        const H = {}, out = []; let r2 = null;
        const fns = { [ids.c]: () => body(H[ids.s]), [ids.e]: () => { try { out.push(H[ids.c]()); } catch (x) { out.push("E:" + x.message); } r2.untrack(() => { if (H[ids.s]() < guard) H[ids.s].set(guard); }); } };
        r2 = r.restore(snap, { fnsById: fns, handles: H });
        return { H, out, r2 };
    };
    test("D-I over-reaction (F-b98-1): an unchanged first re-run of a seeded dirty computed does not run its reader (live 0, restored 0)", () => {
        const body = (s) => (s() > 0 ? 1 : 0);
        const r = createRegistry(); const L = selfWritePair(r, (s) => r.computed(() => body(s)), 2);
        const ids = { s: r.nodeId(L.s), c: r.nodeId(L.c), e: r.nodeId(L.e) };
        const snap = r.snapshot();
        assert.equal(rec(snap, ids.c).clean, false); assert.equal(rec(snap, ids.c).value, 1);
        const R = restoreSelfWrite(r, snap, ids, body, 2);
        const L0 = L.log.length;
        L.s.set(3); R.H[ids.s].set(3);
        assert.deepEqual(L.log.slice(L0), []); assert.deepEqual(R.out, []);
        L.s.set(-1); R.H[ids.s].set(-1);           // a real change still propagates
        assert.deepEqual(R.out, L.log.slice(L0)); assert.deepEqual(R.out, [0]);
    });
    test("D-I (a) control: a never-evaluated computed (version 0) is not seeded; its first read is a change, as live", () => {
        const r = createRegistry(); const s = r.signal(1); const c = r.computed(() => undefined);
        const sId = r.nodeId(s), cId = r.nodeId(c);
        const snap = r.snapshot();
        assert.equal(rec(snap, cId).version, 0); assert.equal(rec(snap, cId).clean, false);
        const H = {}; const r2 = r.restore(snap, { fnsById: { [cId]: () => { H[sId](); return undefined; } }, handles: H });
        let runs = 0; r2.effect(() => { runs++; H[cId](); });
        let liveRuns = 0; r.effect(() => { liveRuns++; c(); });
        assert.equal(runs, 1); assert.equal(liveRuns, 1);
        assert.notEqual(rec(r2.snapshot(), cId).version, 0, "the first run stamps a real version");
    });
    test("D-I2 (b): a dirty computed holding a recorded ERROR is seeded with its error bit; restored reacts exactly as live (F6 included)", () => {
        const body = (s) => { if (s() < 3) throw new Error("low"); return s(); };
        const r = createRegistry(); const L = selfWritePair(r, (s) => r.computed(() => body(s)), 2);
        const ids = { s: r.nodeId(L.s), c: r.nodeId(L.c), e: r.nodeId(L.e) };
        const snap = r.snapshot();
        assert.equal(rec(snap, ids.c).clean, false); assert.ok((rec(snap, ids.c).flags & 16) !== 0, "recorded error");
        const R = restoreSelfWrite(r, snap, ids, body, 2);
        const L0 = L.log.length;
        // A set may itself throw (the reader's pre-walk rethrows the dep error, F6): record it on both sides.
        const put = (h, v, log) => { try { h.set(v); } catch (x) { log.push("set!" + x.message); } };
        for (const v of [2, 1, 5, 5, 6]) { put(L.s, v, L.log); put(R.H[ids.s], v, R.out); }
        assert.deepEqual(R.out, L.log.slice(L0));
        assert.ok(R.out.length >= 1, "the reader reacted (or its set threw) on both sides");   // live today: ["set!low"] (F6)
    });
    test("D-I (c) the seeded value goes through Object.is (NaN -> NaN does not propagate)", () => {
        const body = (s) => (s() > 0 ? NaN : 1);
        const r = createRegistry(); const L = selfWritePair(r, (s) => r.computed(() => body(s)), 2);
        const ids = { s: r.nodeId(L.s), c: r.nodeId(L.c), e: r.nodeId(L.e) };
        const snap = r.snapshot();
        assert.ok(Number.isNaN(rec(snap, ids.c).value));
        const R = restoreSelfWrite(r, snap, ids, body, 2);
        const L0 = L.log.length;
        L.s.set(7); R.H[ids.s].set(7);
        assert.deepEqual(L.log.slice(L0), []); assert.deepEqual(R.out, []);
    });
    test("D-I (d) the seeded version is the recorded one: a clean reader over it stays a cache hit after an unchanged re-run; versions stay put", () => {
        const r = createRegistry();
        const s = r.signal(1); const d = r.computedBox(() => (s() > 0 ? 10 : 20));
        const rd = r.computed(() => d.get() + 1);
        rd();
        const sId = r.nodeId(s), dId = r.nodeId(d), rdId = r.nodeId(rd);
        const snap = r.snapshot();
        assert.equal(rec(snap, rdId).clean, true); assert.notEqual(rec(snap, dId).version, 0);
        dirtyRec(snap, rec(snap, dId));                      // the D-G shape: a dirty (evaluated) computedBox under a clean reader
        const H = {}; let rdRuns = 0, dRuns = 0;
        const r2 = r.restore(snap, { fnsById: { [dId]: () => { dRuns++; return H[sId]() > 0 ? 10 : 20; }, [rdId]: () => { rdRuns++; return H[dId].get() + 1; } }, handles: H });
        let liveRuns = 0; const lrd = r.computed(() => { liveRuns++; return d.get() + 1; }); lrd(); liveRuns = 0;
        s.set(9); H[sId].set(9);
        assert.equal(lrd(), 11); assert.equal(H[rdId](), 11);
        assert.equal(dRuns, 1, "the uncomputed body ran"); assert.equal(rdRuns, liveRuns); assert.equal(rdRuns, 0, "clean reader: cache hit");
        const re = r2.snapshot();
        assert.equal(rec(re, dId).version, rec(snap, dId).version, "seeded version kept (unchanged value)");
        assert.ok(((rec(re, dId).version - rec(re, rdId).version) | 0) <= 0, "seeded version <= the reader's");
        H[sId].set(-1); assert.equal(H[rdId](), 21); assert.equal(rdRuns, 1);
    });
    // --- D-I2 (b99): an ERRORED dirty computed is seeded too (value + version + FLAG_HAS_ERROR): restore copies the live
    // state and pullComputed decides. Rows compare restored against a live twin, so they hold before and after D-K.
    // D-I2 (P2) -> REGRESSION pin for LEDGER #43 (F-b101-1), CLOSED not-an-engine-bug (b107, evidence .handoff/b107-evidence/L43/).
    // The old harness (and the b101 probe) ran restored bodies that called the LIVE registry's untrack. untrack is
    // per-registry, so inside r2's effect the "untracked" s() read was TRACKED: r2 gained an s -> e link live lacked
    // and re-ran the effect at 6. With the RESTORED registry's untrack (r2, filled after restore returns) restored == live.
    // Original repro shape (LEDGER #43): s = signal(1); c = computed(() => { if (s() < 3) throw E;
    // return "ok"; }); effect(() => { try { c(); } catch {} untrack(() => { if (s() < 2) s.set(2); }); });
    // snapshot -> restore; set 5 then 6 on both: live runs the effect at 5 only (k = 1), restored at 5 AND 6 (k + 1).
    // set 5 then 6 on both: live runs the effect at 5 only; restored (own-registry untrack) matches. Evidence
    // .handoff/b107-evidence/L43/DIAGNOSIS.md.
    test("D-I2 REGRESSION #43 (closed, not an engine bug): a seeded errored computed leaving its error runs the restored effect exactly as live when restored bodies use the restored registry's untrack", () => {
        const E = new Error("low"); const body = (s) => { if (s() < 3) throw E; return "ok"; };
        const r = createRegistry(); const L = selfWritePair(r, (s) => r.computed(() => body(s)), 2);
        const ids = { s: r.nodeId(L.s), c: r.nodeId(L.c), e: r.nodeId(L.e) };
        const snap = r.snapshot();
        assert.equal(rec(snap, ids.c).clean, false); assert.ok((rec(snap, ids.c).flags & 16) !== 0, "recorded error");
        const R = restoreSelfWrite(r, snap, ids, body, 2);
        const L0 = L.log.length;
        L.s.set(5); R.H[ids.s].set(5);
        assert.deepEqual(L.log.slice(L0), ["ok"], "live: the effect runs once at 5");
        assert.deepEqual(R.out, ["ok"], "restored: once at 5, like live");
        L.s.set(6); R.H[ids.s].set(6);
        assert.deepEqual(L.log.slice(L0), ["ok"], "live: no re-run at 6 (c unchanged)");
        assert.deepEqual(R.out, L.log.slice(L0), "restored == live at 6 (no re-run)"); assert.deepEqual(R.out, ["ok"]);
    });
    // Row X (#43, A3): untrack is per-registry. A body that calls ANOTHER registry's untrack (r3) is not untracked in
    // its own registry: live tracks the s() read, and restore copies live (snapshot records the s -> e link), so the
    // restored twin tracks it too when its body also calls r3.untrack. Expected logs are by hand: set(5) runs the
    // effect once (c "ok"); set(6) re-runs it in BOTH because s is a tracked dep of e (live and restored).
    const foreignPair = (mkR3Untrack) => {
        const E = new Error("low"); const body = (s) => { if (s() < 3) throw E; return "ok"; };
        const r = createRegistry(), r3 = createRegistry();
        const s = r.signal(1), c = r.computed(() => body(s)), log = [];
        const e = r.effect(() => { try { log.push(c()); } catch (x) { log.push("E:" + x.message); } r3.untrack(() => { if (s() < 2) s.set(2); }); });
        const ids = { s: r.nodeId(s), c: r.nodeId(c) }, eId = r.nodeId(e);
        const snap = r.snapshot();
        const H = {}, out = []; let r2 = null;
        const un = (fn) => mkR3Untrack(r3, r2)(fn);
        const fns = { [ids.c]: () => body(H[ids.s]), [eId]: () => { try { out.push(H[ids.c]()); } catch (x) { out.push("E:" + x.message); } un(() => { if (H[ids.s]() < 2) H[ids.s].set(2); }); } };
        r2 = r.restore(snap, { fnsById: fns, handles: H });
        const rDeps = rec(r2.snapshot(), eId).deps;
        const L0 = log.length;
        s.set(5); H[ids.s].set(5);
        s.set(6); H[ids.s].set(6);
        return { live: log.slice(L0), restored: out, lDeps: rec(snap, eId).deps, rDeps, want: [ids.c, ids.s] };
    };
    test("D-I2 row X (#43): live and restored bodies BOTH call a third registry's untrack -> the read is tracked in both: restored run log == live's, and live re-ran at 6", () => {
        const R = foreignPair((r3) => r3.untrack);
        assert.deepEqual(R.live, ["ok", "ok"], "live: runs at 5 and again at 6 (the foreign untrack tracks s)");
        assert.deepEqual(R.restored, R.live);
        assert.deepEqual(R.lDeps, R.want); assert.deepEqual(R.rDeps, R.want, "restore copied the foreign-untrack s -> e link");
    });
    test("D-I2 row X control (#43): live uses r3.untrack but restored uses r2.untrack -> the logs DIVERGE (X can see the difference)", () => {
        const R = foreignPair((r3, r2) => r2.untrack);
        assert.deepEqual(R.live, ["ok", "ok"]); assert.deepEqual(R.restored, ["ok"], "own-registry untrack: s untracked, no run at 6");
        assert.notDeepEqual(R.restored, R.live);
    });
    test("D-I2 round-trip: snapshot(restore(s)) keeps a dirty errored computed's record (FLAG_HAS_ERROR, value, version)", () => {
        const body = (s) => { if (s() < 3) throw new Error("low"); return s(); };
        const r = createRegistry(); const L = selfWritePair(r, (s) => r.computed(() => body(s)), 2);
        const ids = { s: r.nodeId(L.s), c: r.nodeId(L.c), e: r.nodeId(L.e) };
        const snap = r.snapshot();
        assert.equal(rec(snap, ids.c).clean, false); assert.ok((rec(snap, ids.c).flags & 16) !== 0, "recorded error");
        const R = restoreSelfWrite(r, snap, ids, body, 2);
        assert.deepEqual(rec(R.r2.snapshot(), ids.c), rec(snap, ids.c));
    });
    // --- D-L (b100): a seeded dirty computed keeps its recorded stamps and its own body (the b98 one-shot first-run
    // wrapper is deleted), so its first read pre-walks like live. The receiver / gen rows below still hold.
    test("D-L a seeded dirty computed pre-walks like its live twin: an unchanged dep settles it with NO body run (run count + log equal)", () => {
        const r = createRegistry(), lv = [];
        const s = r.signal(1);
        const c1 = r.computed(() => (s() > 0 ? 1 : 0));
        const c2 = r.computed(() => { const v = c1(); lv.push(v); return v + 10; });
        c2(); s.set(2); r.untrack(() => c1());        // c2 marked dirty; c1 re-settles to the same value (version kept)
        const ids = { s: r.nodeId(s), c1: r.nodeId(c1), c2: r.nodeId(c2) };
        const snap = r.snapshot();
        const c2r = rec(snap, ids.c2);
        assert.equal(c2r.clean, false); assert.notEqual(c2r.evalVersion, 0); assert.ok(((c2r.markEpoch - c2r.evalVersion) | 0) > 0, "dirty by the stamps");
        const H = {}, rv = [];
        const r2 = r.restore(snap, { fnsById: { [ids.c1]: () => (H[ids.s]() > 0 ? 1 : 0), [ids.c2]: () => { const v = H[ids.c1](); rv.push(v); return v + 10; } }, handles: H });
        assert.deepStrictEqual(r2.snapshot(), snap, "seeded record kept whole (stamps incl.)");
        const L0 = lv.length;
        assert.deepEqual([c2(), H[ids.c2]()], [11, 11]);
        assert.deepEqual(rv, lv.slice(L0)); assert.deepEqual(rv, [], "the pre-walk settled it: no body run (D-I's evalVersion 0 forced one)");
        s.set(-1); H[ids.s].set(-1);
        assert.deepEqual([c2(), H[ids.c2]()], [10, 10]);
        assert.deepEqual(rv, lv.slice(L0)); assert.deepEqual(rv, [0]);
    });
    test("D-L seeded body keeps the receiver: a non-arrow seeded body sees the same `this` on its first and later runs, as live", () => {
        const r = createRegistry(); const s = r.signal(1); const liveThis = [];
        const c = r.computed(function () { liveThis.push(this); return s() > 0 ? 1 : 0; });
        const e = r.effect(() => { c(); r.untrack(() => { if (s() < 2) s.set(2); }); });
        const ids = { s: r.nodeId(s), c: r.nodeId(c), e: r.nodeId(e) };
        const snap = r.snapshot(); assert.equal(rec(snap, ids.c).clean, false, "seeded shape");
        s.set(-1); c();
        const H = {}, recv = [];
        r.restore(snap, { fnsById: { [ids.c]: function () { recv.push(this); return H[ids.s]() > 0 ? 1 : 0; }, [ids.e]: () => { H[ids.c](); } }, handles: H });
        H[ids.c](); H[ids.s].set(-1); H[ids.c]();
        assert.ok(liveThis.length >= 2 && recv.length >= 2, "live " + liveThis.length + " restored " + recv.length);
        assert.equal(liveThis[0], liveThis[1], "live: one receiver across runs");
        assert.equal(typeof recv[0], typeof liveThis[0]);
        // b120 LEDGER #48: bodies run with this === undefined (was: the internal node), live and restored alike.
        assert.equal(liveThis[0], undefined, "#48: live body this === undefined"); assert.equal(recv[0], undefined, "#48: restored body this === undefined");
        assert.equal(recv[0], recv[1], "restored: the first run gets the same receiver as later runs");
    });
    test("D-L gen check: a first run that destroy()s the registry and refills the slot leaves the new occupant untouched (every signal records clean:false)", () => {
        const r = createRegistry(); const s = r.signal(1);
        const c = r.computed(() => (s() > 0 ? 1 : 0)); const e = r.effect(() => { c(); r.untrack(() => { if (s() < 2) s.set(2); }); });
        const ids = { s: r.nodeId(s), c: r.nodeId(c), e: r.nodeId(e) };
        const snap = r.snapshot(); assert.equal(rec(snap, ids.c).clean, false, "seeded shape");
        const H = {}; let r2 = null;
        r2 = r.restore(snap, { fnsById: { [ids.c]: () => {
            r2.destroy();                                       // the only way a slot is reused inside a run (A1.8 pins otherwise)
            for (let i = 0; i < 8; i++) r2.signal(i).set(i + 100);   // refill: one of these takes the seeded node's slot
            return 1;
        }, [ids.e]: () => { H[ids.c](); } }, handles: H });
        H[ids.c]();
        const sigs = r2.snapshot().nodes.filter((n) => n.kind === "signal");
        assert.equal(sigs.length, 8);
        assert.deepEqual(sigs.filter((n) => n.clean !== false).map((n) => n.id), [], "a signal never records clean:true");
    });
    test("D-G (T2): a dep cycle through a WIRED dirty computed is live-emittable and restores live-equivalently (D-N: restore runs no cycle scan)", () => {
        const build = (r, G, log) => {
            G.s = r.signal(0);
            G.C = r.computed(() => { const v = G.s(); if (v > 0) { try { return G.D(); } catch (e) { return -1; } } return v; });
            G.D = r.computed(() => G.C() + 1);
            G.e = r.effect(() => { log.push(G.C()); });
            G.D(); G.s.set(1);                         // D's pre-walk hits CycleError, C catches: C clean [s,D], D dirty [C]
        };
        const drive = (G, log) => { G.s.set(2); G.s.set(0); log.push("D=" + G.D()); G.s.set(3); log.push("D=" + G.D()); };
        const r = createRegistry(); const G = {}, log = [];
        build(r, G, log);
        const snap = r.snapshot();
        const sId = r.nodeId(G.s), cId = r.nodeId(G.C), dId = r.nodeId(G.D), eId = r.nodeId(G.e);
        assert.equal(rec(snap, cId).clean, true); assert.deepEqual(rec(snap, cId).deps, [sId, dId]);
        assert.equal(rec(snap, dId).clean, false); assert.deepEqual(rec(snap, dId).deps, [cId]);
        const H = {}, G2 = {}, out = [];
        r.restore(snap, { fnsById: { [cId]: () => { const v = G2.s(); if (v > 0) { try { return G2.D(); } catch (e) { return -1; } } return v; }, [dId]: () => G2.C() + 1, [eId]: () => { out.push(G2.C()); } }, handles: H });
        G2.s = H[sId]; G2.C = H[cId]; G2.D = H[dId];
        const L0 = log.length;
        drive(G, log); drive(G2, out);
        assert.deepEqual(log.slice(L0), [0, "D=1", -1, "D=0"]);
        assert.deepEqual(out, log.slice(L0));
        // The b99 hand-written cycle (snap2) is gone: live cannot emit it (no gv / nextId / stamps), and a hand-written
        // snapshot live cannot emit is not a contract (ADDENDUM 3). A live-emittable CLEAN dep cycle restores like live
        // (incl. its CycleError; RangeError until b101): test/77 "D-N ... (probe 0c)" and the E4 (D-N) row above.
    });

    // LS_FUZZ_SEEDS=a,b,... overrides the fuzz seeds (b100 closing run: 12345,-1640531527,7,1013904223,2147483647).
    const SEEDS = process.env.LS_FUZZ_SEEDS ? process.env.LS_FUZZ_SEEDS.split(",").map((x) => Number(x) | 0) : [12345, 0x9E3779B9 | 0, 7];
    // LS_FUZZ_GRAPHS=<n> (default 400) scales every fuzz row below and its floors (closing runs use 4000).
    const FUZZ_G = Number(process.env.LS_FUZZ_GRAPHS) > 0 ? Number(process.env.LS_FUZZ_GRAPHS) | 0 : 400;
    const FK = FUZZ_G / 400;
    test("D-G seeded live fuzz: restore() never refuses a live snapshot (3 seeds x LS_FUZZ_GRAPHS, default 400) + coverage floors", () => {
        const tot = {};
        for (const seed of SEEDS) {
            const { cov, fails } = fuzzRoundTrip(createRegistry, seed, FUZZ_G);
            assert.equal(cov.restoreRefused, 0, "seed " + seed + ": " + fails.join(" / "));
            assert.ok(cov.restored >= 340 * FK, "seed " + seed + " restored " + cov.restored);
            for (const k in cov) tot[k] = (tot[k] | 0) + cov[k];
        }
        // Floors ~half the measured b98 totals: a fuzz that stops exercising a lane fails here.
        const floors = { dirtyUnderReader: 15, dirtyWithDeps: 400, caught: 600, thrown: 600, selfWrites: 2400, cachedErr: 12, owned: 1100, compBox: 1200, sigBox: 1200 };
        for (const k in floors) assert.ok(tot[k] >= floors[k] * FK, k + " = " + tot[k] + " < floor " + floors[k] * FK);
    });
    test("D-G seeded live fuzz, self-writes + D-G shapes, no throwing bodies (3 seeds incl. 12345 g250, full logs): restored runs live-equivalently", () => {
        let dur = 0, sw = 0, cmp = 0;
        for (const seed of SEEDS) {
            const { cov, fails } = fuzzRoundTrip(createRegistry, seed, FUZZ_G, { noThr: true, fullLogs: true });
            assert.equal(cov.restoreRefused, 0, fails.join(" / "));
            assert.equal(cov.mismatched, 0, "seed " + seed + ": " + fails.slice(0, 2).join(" / "));
            assert.equal(cov.structural, 0, "seed " + seed + ": " + fails.slice(0, 2).join(" / "));
            dur += cov.dirtyUnderReader; sw += cov.selfWrites; cmp += cov.compared;
        }
        assert.ok(dur >= 20 * FK, "dirtyUnderReader " + dur); assert.ok(sw >= 2600 * FK, "selfWrites " + sw); assert.ok(cmp >= 1150 * FK, "compared " + cmp);
    });
    // Graphs once pinned OUT of the asserted all-lanes row (b98 diagnosis): D-J (b99) fixed subscriber order, and D-L
    // (b100) seeds a dirty computed with its stamps, so its body pre-walks like live and reproduces live's F6 rethrow
    // (LEDGER #38, a LIVE bug fixed by D-H). No exclusion is left; the F6 graphs keep their own row below.
    const F6_GRAPHS = { 12345: [161], 7: [40] };         // a catching body sees a dep error from the pre-walk (LEDGER #38, D-H)
    test("D-G/D-I/D-J seeded live fuzz, all lanes, full logs, 3 seeds x LS_FUZZ_GRAPHS (no exclusion): restored runs live-equivalently", () => {
        let cmp = 0;
        for (const seed of SEEDS) {
            const { cov, fails } = fuzzRoundTrip(createRegistry, seed, FUZZ_G, { fullLogs: true });
            assert.equal(cov.restoreRefused, 0, "seed " + seed + ": " + fails.slice(0, 2).join(" / "));
            assert.equal(cov.mismatched, 0, "seed " + seed + ": " + fails.slice(0, 2).join(" / "));
            assert.equal(cov.structural, 0, "seed " + seed + ": " + fails.slice(0, 2).join(" / "));
            cmp += cov.compared;
        }
        assert.ok(cmp >= 1000 * FK, "compared " + cmp);
    });
    // b100: green since D-L (red on b100-before: both graphs mismatched); F6 itself stays a live bug (LEDGER #38, D-H).
    test("F6 graphs (12345 g161, 7 g40): restored settles live-equivalently, incl. live's F6 pre-walk rethrow (D-L)", () => {
        for (const seed of [12345, 7]) {
            const { cov, fails } = fuzzRoundTrip(createRegistry, seed, 400, { onlyG: F6_GRAPHS[seed] });
            assert.equal(cov.compared, 1); assert.equal(cov.mismatched, 0, fails.join(" / "));
        }
    });
    test("D-J subscriber order (0x9E3779B9 g317, the b98 finding; shrunk form = A1 below): restored runs live-equivalently, full logs + observer order", () => {
        const seed = 0x9E3779B9 | 0;
        const { cov, fails } = fuzzRoundTrip(createRegistry, seed, 318, { onlyG: [317], fullLogs: true });
        assert.equal(cov.compared, 1); assert.equal(cov.mismatched, 0, fails.join(" / ")); assert.equal(cov.structural, 0, fails.join(" / "));
    });
    // F-b99-1 fuzz red rows (b99 closing fuzz; fixed by b100 D-L / D-M / D-O): each graph ran differently restored than
    // live on b100-before (missed / extra effect runs, g2719 all-lanes: live "!T" vs restored "0"). Full logs + exact structure.
    for (const [seed, g, noThr] of [[12345, 1766, true], [271828183, 230, true], [271828183, 558, true], [1013904223, 3438, true],
        [2147483647, 1864, true], [2147483647, 2719, true], [2147483647, 2719, false]]) {
        test("F-b99-1 fuzz row: seed " + seed + " g" + g + (noThr ? " (noThr)" : " (all lanes)") + ": restored runs live-equivalently, full logs + exact structure", () => {
            const { cov, fails } = fuzzRoundTrip(createRegistry, seed, g + 1, { onlyG: [g], noThr, fullLogs: true });
            assert.equal(cov.restoreRefused, 0, fails.join(" / ")); assert.equal(cov.compared, 1);
            assert.equal(cov.mismatched, 0, fails.join(" / ")); assert.equal(cov.structural, 0, fails.join(" / "));
        });
    }
});

describe("A9 round 5 -- D-J: subscriber order is recorded (subPos) and placed on restore", () => {
    const rec = (snap, id) => snap.nodes.find((n) => n.id === id);
    const obs = (r, h) => { const a = []; r.forEachObserver(h, (d) => a.push(d.id)); return a; };

    test("D-J A1 minimal: E1 (created first) reads s only from its 2nd run -> live subs(s) [E2, E1]; restored keeps that order and both self-writing effects log identically", () => {
        // Bodies read through G, so the same code drives the live and the restored graph.
        const bodies = (G, log) => ({
            e1: () => { if (G.t() === 0) { log.push("E1 idle"); return; } const v = G.s(); log.push("E1:" + v); G.r.untrack(() => { if (v % 3 === 1) G.s.set(v + 1); }); },
            e2: () => { const v = G.s(); log.push("E2:" + v); G.r.untrack(() => { if (v % 3 === 2) G.s.set(v + 1); }); },
        });
        const r = createRegistry(); const G = { r }, log = [];
        G.s = r.signal(0); G.t = r.signal(0);
        const B = bodies(G, log);
        const e1 = r.effect(B.e1), e2 = r.effect(B.e2);
        G.t.set(1);                                         // E1's 2nd run reads s: linked after E2
        const sId = r.nodeId(G.s), tId = r.nodeId(G.t), e1Id = r.nodeId(e1), e2Id = r.nodeId(e2);
        assert.ok(e1Id < e2Id, "E1 has the lower id");
        assert.deepEqual(obs(r, G.s), [e2Id, e1Id], "live subscriber order");
        const snap = r.snapshot();
        assert.deepEqual(rec(snap, e1Id).subPos, [0, 1]); assert.deepEqual(rec(snap, e2Id).subPos, [0]);
        const G2 = {}, log2 = [], B2 = bodies(G2, log2), H = {};
        const r2 = r.restore(snap, { fnsById: { [e1Id]: B2.e1, [e2Id]: B2.e2 }, handles: H });
        G2.r = r2; G2.s = H[sId]; G2.t = H[tId];
        assert.deepEqual(obs(r2, G2.s), [e2Id, e1Id], "restored subscriber order");
        const L0 = log.length;
        for (const v of [1, 2, 4, 5, 7, 0, 8]) { G.s.set(v); G2.s.set(v); }
        assert.deepEqual(log2, log.slice(L0), "full effect logs (run order included)");
        assert.deepEqual(obs(r2, G2.s), obs(r, G.s));
        assert.deepEqual(r2.snapshot(), r.snapshot(), "re-snapshot identical (values, versions, deps, subPos)");
    });

    test("D-J A2 two links to one source: N reads s, C (which reads s), s -> deps [s, C, s] round-trip; activeLinks == sum(deps); observer order live == restored before and after N drops its 2nd read", () => {
        const bodies = (G, log) => ({
            C: () => G.s() * 10,
            N: () => { const a = G.s(); const c = G.C(); if (a < 5) G.s(); log.push("N:" + (a + c)); },
            E: () => { log.push("E:" + G.s()); },
        });
        const r = createRegistry(); const G = {}, log = [];
        const B = bodies(G, log);
        G.s = r.signal(1); G.C = r.computed(B.C);
        const n = r.effect(B.N);                            // C is first evaluated INSIDE N: s subs [N, C, N]
        const e = r.effect(B.E);
        const sId = r.nodeId(G.s), cId = r.nodeId(G.C), nId = r.nodeId(n), eId = r.nodeId(e);
        assert.deepEqual(obs(r, G.s), [nId, cId, nId, eId], "live: two links from s to N");
        const snap = r.snapshot();
        assert.deepEqual(rec(snap, nId).deps, [sId, cId, sId]);
        assert.deepEqual(rec(snap, nId).subPos, [0, 0, 2]); assert.deepEqual(rec(snap, cId).subPos, [1]); assert.deepEqual(rec(snap, eId).subPos, [3]);
        const sum = snap.nodes.reduce((t, x) => t + x.deps.length, 0);
        assert.equal(r.stats().activeLinks, sum);
        const G2 = {}, log2 = [], B2 = bodies(G2, log2), H = {};
        const r2 = r.restore(snap, { fnsById: { [cId]: B2.C, [nId]: B2.N, [eId]: B2.E }, handles: H });
        G2.s = H[sId]; G2.C = H[cId];
        const re = r2.snapshot();
        assert.equal(rec(re, nId).deps.length, 3, "restored N keeps both links to s");
        assert.deepEqual(rec(re, nId).subPos, rec(snap, nId).subPos);
        assert.equal(r2.stats().activeLinks, sum, "activeLinks == sum(deps)");
        assert.deepEqual(obs(r2, G2.s), obs(r, G.s), "observer order before");
        const L0 = log.length;
        G.s.set(7); G2.s.set(7);                            // N re-runs and drops its 2nd read of s
        assert.deepEqual(obs(r2, G2.s), obs(r, G.s), "observer order after the 2nd read is severed");
        assert.equal(rec(r.snapshot(), nId).deps.length, 2);
        assert.deepEqual(log2, log.slice(L0));
        assert.equal(r2.stats().activeLinks, r.stats().activeLinks);
        G.s.set(2); G2.s.set(2);                            // and N takes the 2nd read back
        assert.deepEqual(obs(r2, G2.s), obs(r, G.s)); assert.deepEqual(log2, log.slice(L0));
    });

    // A3: malformed subPos fails closed (TypeError) before any handle or body is touched.
    const base = () => {   // s <- c1, s <- c2 (both read, clean): subs(s) = [c1, c2]
        const r = createRegistry(); const s = r.signal(1);
        const c1 = r.computed(() => s() + 1), c2 = r.computed(() => s() + 2); c1(); c2();
        const ids = { s: r.nodeId(s), c1: r.nodeId(c1), c2: r.nodeId(c2) };
        return { r, ids, snap: r.snapshot() };
    };
    const hole = () => { const a = []; a.length = 1; return a; };
    const A3 = [
        ["missing", (S, I) => { delete rec(S, I.c2).subPos; }, /invalid subPos at index \d+$/],
        ["null", (S, I) => { rec(S, I.c2).subPos = null; }, /invalid subPos at index \d+$/],
        ["not an array (array-like)", (S, I) => { rec(S, I.c2).subPos = { 0: 1, length: 1 }; }, /invalid subPos at index \d+$/],
        ["wrong length (short)", (S, I) => { rec(S, I.c2).subPos = []; }, /invalid subPos at index \d+$/],
        ["wrong length (long)", (S, I) => { rec(S, I.c2).subPos = [1, 0]; }, /invalid subPos at index \d+$/],
        ["a signal without subPos", (S, I) => { delete rec(S, I.s).subPos; }, /invalid subPos at index \d+$/],
        ["a signal with a non-empty subPos", (S, I) => { rec(S, I.s).subPos = [0]; }, /invalid subPos at index \d+$/],
        ["duplicate", (S, I) => { rec(S, I.c2).subPos = [0]; }, /duplicate subPos 0 at index \d+ \(source id \d+\)$/],
        ["out of range (p === n)", (S, I) => { rec(S, I.c1).subPos = [2]; rec(S, I.c2).subPos = [1]; }, /subPos 2 out of range at index \d+ \(source id \d+ has 2 subscribers\)$/],
        ["gap [0, 2], n = 2", (S, I) => { rec(S, I.c2).subPos = [2]; }, /subPos 2 out of range at index \d+ \(source id \d+ has 2 subscribers\)$/],
        ["non-integer 0.5", (S, I) => { rec(S, I.c2).subPos = [0.5]; }, /invalid subPos 0\.5 at index \d+$/],
        ["non-integer \"0\" (string)", (S, I) => { rec(S, I.c1).subPos = ["0"]; }, /invalid subPos 0 at index \d+$/],
        ["non-integer NaN", (S, I) => { rec(S, I.c2).subPos = [NaN]; }, /invalid subPos NaN at index \d+$/],
        ["non-integer (hole)", (S, I) => { rec(S, I.c2).subPos = hole(); }, /invalid subPos undefined at index \d+$/],
        ["non-integer 2**32 + 1", (S, I) => { rec(S, I.c2).subPos = [2 ** 32 + 1]; }, /invalid subPos 4294967297 at index \d+$/],
        ["negative -1", (S, I) => { rec(S, I.c2).subPos = [-1]; }, /invalid subPos -1 at index \d+$/],
    ];
    for (const [name, mutate, re] of A3) {
        test("D-J A3 malformed subPos (" + name + ") throws a TypeError; handles and bodies untouched", () => {
            const { r, ids, snap } = base();
            mutate(snap, ids);
            const H = {}; let calls = 0;
            const fns = { [ids.c1]: () => { calls++; return 0; }, [ids.c2]: () => { calls++; return 0; } };
            assert.throws(() => r.restore(snap, { fnsById: fns, handles: H }), (e) => e instanceof TypeError && re.test(e.message) && e.message.startsWith("[lite-signal] restore: "));
            assert.equal(Object.keys(H).length, 0, "handles untouched"); assert.equal(calls, 0, "no body ran");
        });
    }
    test("D-J A3 control: the unmutated base restores with subs(s) = [c1, c2]; a swapped permutation restores [c2, c1]", () => {
        const { r, ids, snap } = base();
        const H = {}; r.restore(snap, { fnsById: { [ids.c1]: () => 0, [ids.c2]: () => 0 }, handles: H });
        const r1 = H[ids.s] && createRegistry; assert.ok(r1);
        const seen = []; const { r: rb, ids: ib, snap: sb } = base();
        rec(sb, ib.c1).subPos = [1]; rec(sb, ib.c2).subPos = [0];
        const H2 = {}; const r2 = rb.restore(sb, { fnsById: { [ib.c1]: () => 0, [ib.c2]: () => 0 }, handles: H2 });
        r2.forEachObserver(H2[ib.s], (d) => seen.push(d.id));
        assert.deepEqual(seen, [ib.c2, ib.c1]);
    });
    test("D-J A3 subPos and each element are read ONCE (a getter cannot pass the check, then change)", () => {
        const { r, ids, snap } = base();
        let recReads = 0, elReads = 0;
        const arr = [0];
        Object.defineProperty(arr, 0, { get() { elReads++; return elReads === 1 ? 1 : 0; }, enumerable: true });
        Object.defineProperty(rec(snap, ids.c2), "subPos", { get() { recReads++; return arr; }, enumerable: true });
        const H = {}; const r2 = r.restore(snap, { fnsById: { [ids.c1]: () => 0, [ids.c2]: () => 0 }, handles: H });
        assert.equal(recReads, 1, "record.subPos read once"); assert.equal(elReads, 1, "element read once");
        assert.deepEqual(obs(r2, H[ids.s]), [ids.c1, ids.c2]);
    });
    test("D-J A3 error order: a bad dep id is reported before a bad subPos on the same record", () => {
        const { r, ids, snap } = base();
        rec(snap, ids.c2).deps = [1.5]; delete rec(snap, ids.c2).subPos;
        assert.throws(() => r.restore(snap, { fnsById: { [ids.c1]: () => 0, [ids.c2]: () => 0 } }), (e) => e instanceof TypeError && /invalid dep id 1\.5 at index \d+$/.test(e.message));
    });

    // ---- D-J6: owner order is recorded (ownerPos) and placed on restore ------------------------------------
    const own = (r, h) => { const a = []; r.forEachOwned(h, (d) => a.push(d.id)); return a; };
    test("D-J6 A5 owner slot reuse: D disposed, C2 (runWithOwner(P)) takes D's lower slot -> forEachOwned(P) [C2, C1] live and restored; cleanup order + dispose-id sequence on dispose(P) match live", () => {
        const mk = (G, clog) => ({ P: () => {}, kid: (tag) => () => { G.s(); G.r.onCleanup(() => clog.push(tag)); } });
        const r = createRegistry(); const G = { r }, clog = [];
        const B = mk(G, clog);
        G.s = r.signal(0);
        const P = r.effect(B.P);
        const D = r.runWithOwner(P, () => r.effect(B.kid("D")));
        const C1 = r.runWithOwner(P, () => r.effect(B.kid("C1")));
        const dId = r.nodeId(D);
        r.dispose(D);
        const C2 = r.runWithOwner(P, () => r.effect(B.kid("C2")));
        const pId = r.nodeId(P), c1Id = r.nodeId(C1), c2Id = r.nodeId(C2), sId = r.nodeId(G.s);
        assert.ok(dId < c1Id && c1Id < c2Id, "ids are monotonic");
        assert.deepEqual(own(r, P), [c2Id, c1Id], "live: newest child first");
        const snap = r.snapshot();
        const ix = (id) => snap.nodes.findIndex((n) => n.id === id);
        assert.ok(ix(c2Id) < ix(c1Id), "C2 reused D's lower pool slot (snapshot pool order puts it first)");
        assert.equal(rec(snap, c2Id).ownerPos, 0); assert.equal(rec(snap, c1Id).ownerPos, 1);
        assert.equal(rec(snap, pId).ownerPos, -1); assert.equal(rec(snap, sId).ownerPos, -1);
        const G2 = {}, clog2 = [], B2 = mk(G2, clog2), H = {};
        const r2 = r.restore(snap, { fnsById: { [pId]: B2.P, [c1Id]: B2.kid("C1"), [c2Id]: B2.kid("C2") }, handles: H });
        G2.r = r2; G2.s = H[sId];
        assert.deepEqual(own(r2, H[pId]), [c2Id, c1Id], "restored owner order");
        const oview = (S) => S.nodes.map((n) => n.id + ":" + n.ownerId + ":" + n.ownerPos).sort().join(" ");
        assert.equal(oview(r2.snapshot()), oview(snap), "re-snapshot ownerId / ownerPos identical");
        G.s.set(1); G2.s.set(1);                            // the kids re-run in both worlds: each registers its cleanup
        clog.length = 0; clog2.length = 0;
        const d1 = [], d2 = [];
        r.onGraphMutation((op, id) => { if (op === 2) d1.push(id); });
        r2.onGraphMutation((op, id) => { if (op === 2) d2.push(id); });
        r.dispose(P); r2.dispose(H[pId]);
        assert.deepEqual(clog, ["C2", "C1"], "live cascade runs the list head first");
        assert.deepEqual(clog2, clog, "restored cleanup order == live");
        assert.deepEqual([...d1].sort(), [pId, c1Id, c2Id].sort(), "live disposed P, C1, C2");
        assert.deepEqual(d2, d1, "restored dispose-id sequence == live");
    });

    // A3 for ownerPos: malformed ownerPos fails closed (TypeError) before any handle or body is touched.
    const obase = () => {   // P (effect) creates c1 then c2 in its body: owned(P) = [c2, c1]; s and P unowned
        const r = createRegistry(); const s = r.signal(1); let c1, c2;
        const P = r.effect(() => { c1 = r.computed(() => s() + 1); c2 = r.computed(() => s() + 2); c1(); c2(); });
        const ids = { s: r.nodeId(s), P: r.nodeId(P), c1: r.nodeId(c1), c2: r.nodeId(c2) };
        return { r, ids, snap: r.snapshot() };
    };
    const ofns = (I, bump) => ({ [I.P]: () => { bump(); }, [I.c1]: () => { bump(); return 0; }, [I.c2]: () => { bump(); return 0; } });
    const A3O = [
        ["missing", (S, I) => { delete rec(S, I.c2).ownerPos; }, /invalid ownerPos undefined at index \d+$/],
        ["missing on an unowned record", (S, I) => { delete rec(S, I.s).ownerPos; }, /invalid ownerPos undefined at index \d+$/],
        ["null", (S, I) => { rec(S, I.c2).ownerPos = null; }, /invalid ownerPos null at index \d+$/],
        ["boolean", (S, I) => { rec(S, I.c2).ownerPos = false; }, /invalid ownerPos false at index \d+$/],
        ["non-integer 0.5", (S, I) => { rec(S, I.c2).ownerPos = 0.5; }, /invalid ownerPos 0\.5 at index \d+$/],
        ["non-integer \"0\" (string)", (S, I) => { rec(S, I.c2).ownerPos = "0"; }, /invalid ownerPos 0 at index \d+$/],
        ["non-integer NaN", (S, I) => { rec(S, I.c2).ownerPos = NaN; }, /invalid ownerPos NaN at index \d+$/],
        ["non-integer 2**32 + 1", (S, I) => { rec(S, I.c2).ownerPos = 2 ** 32 + 1; }, /invalid ownerPos 4294967297 at index \d+$/],
        ["negative -2", (S, I) => { rec(S, I.c2).ownerPos = -2; }, /invalid ownerPos -2 at index \d+$/],
        ["-1 on an owned record", (S, I) => { rec(S, I.c2).ownerPos = -1; }, /invalid ownerPos -1 at index \d+ \(owned by id \d+\)$/],
        ["wrong for unowned (signal 0)", (S, I) => { rec(S, I.s).ownerPos = 0; }, /invalid ownerPos 0 at index \d+ \(no owner: expected -1\)$/],
        ["wrong for unowned (effect 1)", (S, I) => { rec(S, I.P).ownerPos = 1; }, /invalid ownerPos 1 at index \d+ \(no owner: expected -1\)$/],
        ["duplicate", (S, I) => { rec(S, I.c1).ownerPos = 0; }, /duplicate ownerPos 0 at index \d+ \(owner id \d+\)$/],
        ["out of range (p === n)", (S, I) => { rec(S, I.c2).ownerPos = 2; }, /ownerPos 2 out of range at index \d+ \(owner id \d+ has 2 owned children\)$/],
        ["gap [0, 2], n = 2", (S, I) => { rec(S, I.c1).ownerPos = 2; }, /ownerPos 2 out of range at index \d+ \(owner id \d+ has 2 owned children\)$/],
    ];
    for (const [name, mutate, re] of A3O) {
        test("D-J6 malformed ownerPos (" + name + ") throws a TypeError; handles and bodies untouched", () => {
            const { r, ids, snap } = obase();
            mutate(snap, ids);
            const H = {}; let calls = 0;
            assert.throws(() => r.restore(snap, { fnsById: ofns(ids, () => { calls++; }), handles: H }), (e) => e instanceof TypeError && re.test(e.message) && e.message.startsWith("[lite-signal] restore: "));
            assert.equal(Object.keys(H).length, 0, "handles untouched"); assert.equal(calls, 0, "no body ran");
        });
    }
    test("D-J6 ownerPos control: the unmutated base restores owned(P) = [c2, c1]; a swapped permutation restores [c1, c2]", () => {
        const a = obase(); assert.equal(rec(a.snap, a.ids.c2).ownerPos, 0); assert.equal(rec(a.snap, a.ids.c1).ownerPos, 1);
        const H = {}; const r2 = a.r.restore(a.snap, { fnsById: ofns(a.ids, () => {}), handles: H });
        assert.deepEqual(own(r2, H[a.ids.P]), [a.ids.c2, a.ids.c1]);
        const b = obase(); rec(b.snap, b.ids.c1).ownerPos = 0; rec(b.snap, b.ids.c2).ownerPos = 1;
        const H2 = {}; const r3 = b.r.restore(b.snap, { fnsById: ofns(b.ids, () => {}), handles: H2 });
        assert.deepEqual(own(r3, H2[b.ids.P]), [b.ids.c1, b.ids.c2]);
    });
    test("D-J6 ownerPos is read ONCE (a getter cannot pass the check, then change)", () => {
        const { r, ids, snap } = obase();
        let reads = 0;
        Object.defineProperty(rec(snap, ids.c2), "ownerPos", { get() { reads++; return reads === 1 ? 0 : 7; }, enumerable: true });
        const H = {}; const r2 = r.restore(snap, { fnsById: ofns(ids, () => {}), handles: H });
        assert.equal(reads, 1, "record.ownerPos read once");
        assert.deepEqual(own(r2, H[ids.P]), [ids.c2, ids.c1]);
    });
    test("D-J6 error order: a bad ownerId is reported before a bad ownerPos on the same record; an owner cycle keeps its own error", () => {
        const a = obase(); rec(a.snap, a.ids.c2).ownerId = 1.5; delete rec(a.snap, a.ids.c2).ownerPos;
        assert.throws(() => a.r.restore(a.snap, { fnsById: ofns(a.ids, () => {}) }), (e) => e instanceof TypeError && /invalid ownerId 1\.5 at index \d+$/.test(e.message));
        const b = obase(); rec(b.snap, b.ids.P).ownerId = b.ids.c1;   // P (ownerPos -1) now owned by its own child
        assert.throws(() => b.r.restore(b.snap, { fnsById: ofns(b.ids, () => {}) }), /owner cycle through id/);
        const c = obase(); rec(c.snap, c.ids.c2).ownerId = 888888;      // a missing owner, not an ownerPos error
        assert.throws(() => c.r.restore(c.snap, { fnsById: ofns(c.ids, () => {}) }), /owner id 888888 missing/);
    });
    test("D-J6 owner-order fuzz (owner slot reuse, 3 seeds x 300): forEachOwned order live == restored; cleanup order + dispose-id sequence of dispose-all match live", () => {
        let cmp = 0, reorder = 0;
        for (const seed of [12345, 0x9E3779B9 | 0, 7]) {
            const { cov, fails } = fuzzOwnerOrder(createRegistry, seed, 300);
            assert.equal(cov.restoreRefused, 0, "seed " + seed + ": " + fails.join(" / "));
            assert.equal(cov.structural, 0, "seed " + seed + ": " + fails.slice(0, 2).join(" / "));
            assert.equal(cov.mismatched, 0, "seed " + seed + ": " + fails.slice(0, 2).join(" / "));
            cmp += cov.compared; reorder += cov.poolReorder;
        }
        assert.ok(cmp >= 850, "compared " + cmp);
        assert.ok(reorder >= 300, "graphs whose live owner order differs from reverse pool order (the s2a-frozen bug's trigger) " + reorder);
    });
    test("D-J6 A6 retention: 200 snapshot -> restore -> dispose-all cycles over an owner-reuse graph; lite-leak tracker size 0 after gc EACH cycle",
        { skip: HAVE_GC ? false : "needs --expose-gc" }, async () => {
        const r = createRegistry(); const s = r.signal(1);
        const P = r.effect(() => {});
        const D = r.runWithOwner(P, () => r.effect(() => { s(); }));
        const C1 = r.runWithOwner(P, () => r.effect(() => { s(); }));
        r.dispose(D);
        const C2 = r.runWithOwner(P, () => r.computed(() => s() * 2)); C2();
        const I = { s: r.nodeId(s), P: r.nodeId(P), c1: r.nodeId(C1), c2: r.nodeId(C2) };
        const tracker = createLeakTracker({ name: "t76-dj6", onLeak() {}, onWarning() {} });
        const cycle = (i) => {
            const snap = r.snapshot();
            const H = {};
            const r2 = r.restore(snap, { fnsById: { [I.P]: () => {}, [I.c1]: () => { H[I.s](); }, [I.c2]: () => H[I.s]() * 2 }, handles: H });
            assert.deepEqual(own(r2, H[I.P]), [I.c2, I.c1]);
            assert.equal(r2.snapshot().nodes.length, snap.nodes.length);
            tracker.track(r2, null, i); tracker.track(H[I.P], null, i); tracker.track(H[I.c2], null, i); tracker.track(snap, null, i);
            r2.destroy();
            assert.equal(r2.stats().activeNodes, 0);
        };
        for (let i = 0; i < 200; i++) {
            cycle(i);
            for (let k = 0; k < 5 && tracker.size() !== 0; k++) { globalThis.gc(); await new Promise((res) => setTimeout(res, 0)); }
            assert.equal(tracker.size(), 0, "cycle " + i + ": tracker size after gc");
        }
        assert.deepEqual(own(r, P), [I.c2, I.c1], "source owner order untouched");
    });
});

// Seeded live round-trip fuzz (port of b97 review-code/live-fuzz2.mjs + live-equivalence + self-writes).
// fuzzRoundTrip(createRegistry, seed, graphs, knobs) -> { cov, fails }; knobs.noThr / noSW drop a lane,
// skipG / onlyG pick the graphs compared, onGraph is a diagnostic hook (b98-evidence/C/g317.mjs).
function fuzzRoundTrip(createRegistry, seed, graphs, knobs = {}) {
    let sA = seed | 0, sB = 0x7F4A7C15 ^ sA;
    const xsA = () => { sA ^= sA << 13; sA ^= sA >>> 17; sA ^= sA << 5; return sA >>> 0; };
    const cov = { graphs: 0, snapRefused: 0, restored: 0, restoreRefused: 0, dirtyUnderReader: 0, dirtyWithDeps: 0,
        cachedErr: 0, owned: 0, compBox: 0, sigBox: 0, caught: 0, thrown: 0, selfWrites: 0, compared: 0, mismatched: 0, structural: 0 };
    const fails = [];
    const show = (f) => { try { const v = f(); return typeof v === "number" ? v : String(v); } catch (e) { return "!" + String(e && e.message); } };
    // Body factories: every closure reads through env, so the SAME spec rebuilds against the restored handles.
    const mkComp = (sp, env) => () => {
        let acc = 0;
        for (let j = 0; j < sp.pick.length; j++) {
            if (sp.cond === 1 && j > 0 && (acc & 1) === 1) break;              // conditional read
            let v; try { v = env.R[sp.pick[j]](); } catch (e) { if (sp.thr === 0) throw e; env.cov.caught++; v = 0; }
            acc += (typeof v === "number" ? v : 0);
            if (sp.thr === 1 && acc === 3) { env.cov.thrown++; throw new Error("T"); }
        }
        return acc;
    };
    const mkEff = (sp, env) => {
        const body = mkComp(sp, env);
        return () => {
            let v; try { v = body(); } catch (e) { env.cov.caught++; v = 0; }
            env.logs[sp.ix].push(v); env.last[sp.ix] = v;
            if (sp.sw >= 0) {
                env.r.untrack(() => { if (!(env.R[sp.sw]() >= sp.w)) { env.cov.selfWrites++; env.W[sp.sw](sp.w); } });
            }
            if (sp.nest === 1) { const c = env.r.computed(mkChildC(sp, env, v)); if ((v & 1) === 0) { try { c(); } catch (e) {} } }
            if (sp.nest === 2) env.r.effect(mkChildE(sp, env));
        };
    };
    const mkChildC = (sp, env, v) => () => v + env.R[sp.pick[0]]();
    const mkChildE = (sp, env) => () => { try { env.R[sp.pick[0]](); } catch (e) {} };
    const reader = (h, box) => box ? () => h.get() : () => h();
    for (let g = 0; g < graphs; g++) {
        const r = createRegistry();
        const env = { r, R: [], W: [], logs: [], last: [], cov };
        const specs = [], sigIx = [], handles = [];
        const n = 4 + (xsA() % 18);
        for (let i = 0; i < n; i++) {
            const t = xsA() % 10;
            const sp = { ix: i, k: "", pick: [], cond: 0, thr: 0, sw: -1, w: 0, nest: 0, init: 0 };
            env.logs.push([]); env.last.push(0);
            if (t < 3 || i === 0) {
                sp.k = (xsA() & 1) === 1 ? "sb" : "s"; sp.init = xsA() % 5;
                const h = sp.k === "sb" ? r.signalBox(sp.init) : r.signal(sp.init);
                env.R[i] = reader(h, sp.k === "sb"); env.W[i] = (v) => h.set(v); sigIx.push(i); handles.push(h);
            } else {
                const m = 1 + (xsA() % 3);
                for (let j = 0; j < m; j++) sp.pick.push(xsA() % i);
                sp.cond = xsA() % 4; sp.thr = xsA() % 6; if (knobs.noThr && sp.thr < 2) sp.thr = 2;
                if (t < 7) {
                    sp.k = (xsA() & 1) === 1 ? "cb" : "c";
                    const h = sp.k === "cb" ? r.computedBox(mkComp(sp, env)) : r.computed(mkComp(sp, env));
                    env.R[i] = reader(h, sp.k === "cb"); handles.push(h);
                } else {
                    sp.k = "e"; sp.nest = xsA() % 3;
                    if ((xsA() % 3) === 0 && sigIx.length && !knobs.noSW) { sp.sw = sigIx[xsA() % sigIx.length]; sp.w = 2 + (xsA() % 4); }
                    env.R[i] = () => 0;
                    let h = null; try { h = r.effect(mkEff(sp, env)); } catch (e) {}
                    handles.push(h);
                }
            }
            specs.push(sp);
        }
        // Pre-snapshot ops (live only), then the post-snapshot script (replayed on BOTH worlds from the same seed).
        const script = (E, ops, rng) => {
            const out = [];
            for (let o = 0; o < ops; o++) {
                const t = rng() % 6;
                try {
                    if (t <= 2) { const k = sigIx[rng() % sigIx.length]; E.W[k](rng() % 5); }
                    else if (t === 3) { const k1 = sigIx[rng() % sigIx.length], v1 = rng() % 5, k2 = sigIx[rng() % sigIx.length], v2 = rng() % 5; E.r.batch(() => { E.W[k1](v1); E.W[k2](v2); }); }
                    else if (t === 4) { const k = rng() % specs.length; out.push(show(E.R[k])); }
                    else { const k = rng() % specs.length; out.push(show(() => E.r.untrack(E.R[k]))); }
                } catch (e) { out.push("op!" + String(e && e.message)); }
            }
            return out;
        };
        const xsB = () => { sB ^= sB << 13; sB ^= sB >>> 17; sB ^= sB << 5; return sB >>> 0; };
        script(env, 5 + (xsB() % 25), xsB);
        cov.graphs++;
        let snap;
        try { snap = r.snapshot(); } catch (e) { cov.snapRefused++; continue; }
        const idToIx = new Map();
        for (let i = 0; i < specs.length; i++) if (handles[i] !== null) idToIx.set(r.nodeId(handles[i]), i);
        const byId = new Map(); for (const x of snap.nodes) byId.set(x.id, x);
        const env2 = { r: null, R: [], W: [], logs: specs.map(() => []), last: env.last.slice(), cov: { caught: 0, thrown: 0, selfWrites: 0 } };
        const H = {}, fns = {};
        for (const x of snap.nodes) {
            const comp = x.kind === "computed" || x.kind === "computedBox";
            if (x.kind === "signalBox") cov.sigBox++;
            if (x.kind === "computedBox") cov.compBox++;
            if (comp && !x.clean && x.deps.length) cov.dirtyWithDeps++;
            if (comp && x.clean && (x.flags & 16)) cov.cachedErr++;
            for (const d of x.deps) {
                const s = byId.get(d);
                if ((s.kind === "computed" || s.kind === "computedBox") && !s.clean && (x.kind === "effect" || x.clean)) cov.dirtyUnderReader++;
            }
            if (x.kind === "signal" || x.kind === "signalBox") continue;
            const ix = idToIx.get(x.id);
            if (ix !== undefined) { fns[x.id] = specs[ix].k === "e" ? mkEff(specs[ix], env2) : mkComp(specs[ix], env2); continue; }
            cov.owned++;
            const oix = idToIx.get(x.ownerId);                   // a nest child: rebuilt from its owner's spec
            fns[x.id] = x.kind === "effect" ? mkChildE(specs[oix], env2) : mkChildC(specs[oix], env2, env.last[oix]);
        }
        let r2;
        try { r2 = r.restore(snap, { fnsById: fns, handles: H }); cov.restored++; }
        catch (e) { cov.restoreRefused++; if (fails.length < 5) fails.push("g" + g + " refused: " + e.message); continue; }
        env2.r = r2;
        for (let i = 0; i < specs.length; i++) {
            if (specs[i].k === "e") { env2.R[i] = () => 0; continue; }
            const h = H[r.nodeId(handles[i])];
            env2.R[i] = reader(h, specs[i].k === "sb" || specs[i].k === "cb");
            if (specs[i].k === "s" || specs[i].k === "sb") env2.W[i] = (v) => h.set(v);
        }
        // D-J structural lane: forEachObserver ids of every spec handle, live vs restored, compared IDENTICALLY
        // (links, duplicates and order) right after restore AND after the script: restore copies live's clock,
        // next id and stamps (D-L / D-M / D-O), so a restored dirty computed settles by the same pre-walk as live.
        // Ids above the snapshot's max are post-restore nodes; their ids may differ, so "n".
        // D-J6 owner lane: after "/", the forEachOwned ids of the same handle, compared EXACTLY (order included)
        // both right after restore and after the script: only effects own (nest children), an owner re-runs
        // exactly when its full log does, and every post-restore child id maps to "n" on both sides.
        let mx = 0; for (const x of snap.nodes) if (x.id > mx) mx = x.id;
        const hs2 = handles.map((h) => (h === null ? null : H[r.nodeId(h)]));
        const structOf = (rr, hs, uniq) => hs.map((h) => {
            if (h === null || h === undefined) return "-";
            const a = []; rr.forEachObserver(h, (d) => { const k = d.id > mx ? "n" : d.id; if (!uniq || k === "n" || !a.includes(k)) a.push(k); });
            const o = []; rr.forEachOwned(h, (d) => o.push(d.id > mx ? "n" : d.id));
            return a.join(",") + "/" + o.join(",");
        }).join("|");
        const st1 = structOf(r, handles, false), st2 = structOf(r2, hs2, false);
        const L0 = env.logs.map((l) => l.length);
        const ops = 10 + (xsA() % 20), seedOps = xsA() | 1;
        let q1 = seedOps, q2 = seedOps;
        const t1 = script(env, ops, () => { q1 ^= q1 << 13; q1 ^= q1 >>> 17; q1 ^= q1 << 5; return q1 >>> 0; });
        const t2 = script(env2, ops, () => { q2 ^= q2 << 13; q2 ^= q2 >>> 17; q2 ^= q2 << 5; return q2 >>> 0; });
        for (let i = 0; i < specs.length; i++) { t1.push(show(env.R[i])); t2.push(show(env2.R[i])); }
        // Settled-state digest: per effect, the value it last ran with (missed reactions show; extra same-value runs do not).
        // knobs.fullLogs compares every run instead (D-J: restore places subscriber order, so the run sequence matches).
        const dig = (E) => E.last.join("|");   // where each effect SETTLED (restored env.last is seeded from live)
        const lg1 = knobs.fullLogs ? env.logs.map((l, i) => l.slice(L0[i]).join(",")).join("|") : dig(env), lg2 = knobs.fullLogs ? env2.logs.map((l) => l.join(",")).join("|") : dig(env2);
        const a = t1.join(";") + "#" + lg1, b = t2.join(";") + "#" + lg2;
        if (knobs.onGraph) knobs.onGraph(g, specs, snap, a, b, idToIx);
        if (knobs.onlyG ? !knobs.onlyG.includes(g) : (knobs.skipG !== undefined && knobs.skipG.includes(g))) continue;
        cov.compared++;
        if (a !== b) { cov.mismatched++; if (fails.length < 5) fails.push("g" + g + " live " + a + " != restored " + b); }
        const st1b = st1 + "#" + structOf(r, handles, false), st2b = st2 + "#" + structOf(r2, hs2, false);
        if (st1b !== st2b) { cov.structural++; if (fails.length < 5) fails.push("g" + g + " observers live " + st1b + " != restored " + st2b); }
    }
    return { cov, fails };
}

// D-J6 owner-order fuzz: 1-3 top-level owner effects; a random script creates leaf children (effects /
// read computeds) under a random owner via runWithOwner and disposes random children, so a LIFO free list
// hands a newer child a lower pool slot. Per graph: forEachOwned ids of every owner live vs restored (exact),
// then both worlds re-run every child (each registers an onCleanup), dispose every owner in order and compare
// the cleanup tags and the onGraphMutation op-2 (dispose) id sequence. cov.poolReorder counts graphs where some
// owner's live order differs from the reverse snapshot pool order (the order the s2a-frozen prepend restored).
function fuzzOwnerOrder(createRegistry, seed, graphs) {
    let q = seed | 0;
    const rng = () => { q ^= q << 13; q ^= q >>> 17; q ^= q << 5; return q >>> 0; };
    const cov = { graphs: 0, restored: 0, restoreRefused: 0, compared: 0, poolReorder: 0, mismatched: 0, structural: 0 };
    const fails = [];
    const body = (sp, E) => sp.k === "P" ? () => {} : sp.k === "e"
        ? () => { E.S[sp.sig](); E.r.onCleanup(() => E.clog.push(sp.tag)); }
        : () => { E.r.onCleanup(() => E.clog.push(sp.tag)); return E.S[sp.sig](); };
    for (let g = 0; g < graphs; g++) {
        const r = createRegistry();
        const env = { r, S: [], clog: [] };
        const nS = 1 + (rng() % 3);
        for (let i = 0; i < nS; i++) env.S.push(r.signal(i));
        const specs = [], hs = [];
        const nP = 1 + (rng() % 3);
        for (let i = 0; i < nP; i++) { const sp = { k: "P", owner: -1, sig: 0, tag: "P" + i }; specs.push(sp); hs.push(r.effect(body(sp, env))); }
        const ops = 6 + (rng() % 24);
        for (let o = 0; o < ops; o++) {
            const t = rng() % 3;
            const kids = []; for (let i = nP; i < specs.length; i++) if (hs[i] !== null) kids.push(i);
            if (t === 0 && kids.length !== 0) { const i = kids[rng() % kids.length]; r.dispose(hs[i]); hs[i] = null; continue; }
            const sp = { k: (rng() & 1) === 1 ? "e" : "c", owner: rng() % nP, sig: rng() % nS, tag: "k" + specs.length };
            specs.push(sp);
            hs.push(r.runWithOwner(hs[sp.owner], () => { if (sp.k === "e") return r.effect(body(sp, env)); const c = r.computed(body(sp, env)); c(); return c; }));
        }
        cov.graphs++;
        const snap = r.snapshot();
        const fns = {};
        const env2 = { r: null, S: [], clog: [] };
        for (let i = 0; i < specs.length; i++) if (hs[i] !== null) fns[r.nodeId(hs[i])] = body(specs[i], env2);
        const H = {};
        let r2;
        try { r2 = r.restore(snap, { fnsById: fns, handles: H }); cov.restored++; }
        catch (e) { cov.restoreRefused++; if (fails.length < 5) fails.push("g" + g + " refused: " + e.message); continue; }
        env2.r = r2;
        for (let i = 0; i < nS; i++) env2.S.push(H[r.nodeId(env.S[i])]);
        const hs2 = hs.map((h) => (h === null ? null : H[r.nodeId(h)]));
        const ownOf = (rr, list) => { const out = []; for (let i = 0; i < nP; i++) { const a = []; rr.forEachOwned(list[i], (d) => a.push(d.id)); out.push(a.join(",")); } return out.join("|"); };
        const o1 = ownOf(r, hs), o2 = ownOf(r2, hs2);
        for (let i = 0; i < nP; i++) {
            const pid = r.nodeId(hs[i]);
            const rev = snap.nodes.filter((x) => x.ownerId === pid).map((x) => x.id).reverse().join(",");
            const a = []; r.forEachOwned(hs[i], (d) => a.push(d.id));
            if (a.join(",") !== rev) { cov.poolReorder++; break; }
        }
        cov.compared++;
        if (o1 !== o2) { cov.structural++; if (fails.length < 5) fails.push("g" + g + " owned live " + o1 + " != restored " + o2); }
        // Re-run every child in both worlds (signals bumped, computeds read in spec order), then dispose-all.
        for (let i = 0; i < nS; i++) { env.S[i].set(10 + i); env2.S[i].set(10 + i); }
        for (let i = nP; i < specs.length; i++) if (hs[i] !== null && specs[i].k === "c") { hs[i](); hs2[i](); }
        env.clog.length = 0; env2.clog.length = 0;
        const d1 = [], d2 = [];
        r.onGraphMutation((op, id) => { if (op === 2) d1.push(id); });
        r2.onGraphMutation((op, id) => { if (op === 2) d2.push(id); });
        for (let i = 0; i < nP; i++) { r.dispose(hs[i]); r2.dispose(hs2[i]); }
        const a = env.clog.join(",") + "#" + d1.join(","), b = env2.clog.join(",") + "#" + d2.join(",");
        if (a !== b) { cov.mismatched++; if (fails.length < 5) fails.push("g" + g + " dispose live " + a + " != restored " + b); }
    }
    return { cov, fails };
}
