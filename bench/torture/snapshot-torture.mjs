/**
 * bench/torture/snapshot-torture.mjs -- snapshot() / restore() contract fuzz +
 * fail-closed battery + retention witness (snapshot/restore ships at 1.6.0).
 *
 * snapshot()/restore() is a COLD-path serialization pair the value oracles are
 * blind to: it walks the live pool into a plain object and rebuilds a fresh
 * registry from one. Three things can go silently wrong and none of them is a
 * value glitch, so this file asserts them directly:
 *
 *   1. THE CLEAN BIT. snapshot records, per node, whether its cached value is
 *      trustworthy (`clean` = pullComputed's short-circuit: a computed that was
 *      evaluated and not dirtied since). restore MUST honour it: a clean computed
 *      is restored with its cached value + deps and trusted (first read does NOT
 *      recompute); a dirty / never-evaluated one is restored UNCOMPUTED (first
 *      read recomputes + re-tracks). Enshrining a never-computed cache would make
 *      a `undefined` cache permanent; discarding a clean cache would recompute
 *      the whole graph on restore. We tie the recompute COUNTER of every restored
 *      body to the snapshot's own `clean` bit, over a seeded graph fuzz.
 *
 *   2. FAIL-CLOSED. A malformed snapshot or an unsettled graph must THROW, never
 *      build a half-wired registry that fails open later. Missing fn, duplicate
 *      id, dangling dep, bad owner, wrong shape, and snapshot-mid-flush/batch/
 *      track are each asserted to throw.
 *
 *   3. RETENTION. snapshot/restore DELIBERATELY allocate (a plain object out, a
 *      fresh registry in) -- so this is not a 0 B/op path and measureAllocs is
 *      the wrong instrument. The leak that WOULD matter is per-cycle retention:
 *      a restored registry, or a snapshot's closures, kept alive after the cycle.
 *      We run batches of snapshot->restore->drop, force GC between them, and
 *      assert the retained high-water does not climb batch over batch.
 *
 * Also: effects restore WITHOUT re-firing (state back, no side effect during
 * restore) and boxes round-trip as boxes.
 *
 * 1.6.0 rulings asserted here (PLAN-0s-a9, maintainer 2026-10-21):
 *   D-A  box nodes carry FLAG_BOX (128) from createNode: snapshot flags and the
 *        onGraphMutation op-1 flags read 160 (signalBox) / 129 (computedBox);
 *        callables never carry the bit.
 *   D-B  snapshot() throws "not settled" whenever ANY body is running, including
 *        under untrack() / createRoot() / runWithOwner() (which clear
 *        currentObserver -- the fork's guard alone misses them).
 *   D-C  restore() without config sizes the fresh registry from the snapshot:
 *        maxNodes max(1.5N + 16, 1024), maxLinks max(1.5L + 16, 4 x maxNodes);
 *        the source's onCapacityExceeded is NOT carried; opts.config wins.
 *   D-D  not captured: custom equals, effect schedulers (and onCleanup / hooks,
 *        pinned in test/76). The restored graph uses the defaults.
 * Plus: the top-level snapshot / restore exports drive the default registry.
 *
 * Floor: run.mjs floor 1.6.0 (the version the surface ships at). A registry
 * without snapshot/restore exits 77, which the runner escalates to a FAIL once
 * the engine version is >= 1.6.0.
 *
 * Exit code: 0 iff every contract held. 77 if the engine lacks snapshot (below
 * floor); 78 if the runtime lacks --expose-gc (retention witness needs it).
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 *
 * Usage: node --expose-gc bench/torture/snapshot-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { createReport, mulberry32, randInt, shuffle } from "./helpers/index.mjs";
import { createLeakTracker } from "@zakkster/lite-leak";

const { createRegistry, CapacityError } = Signal;
const reg = (opts) => createRegistry({ maxNodes: 8192, maxLinks: 32768, onCapacityExceeded: "grow", ...opts });

/* -- floor + environment gates --------------------------------------------- */

if (typeof reg().snapshot !== "function" || typeof reg().restore !== "function") {
    console.log("lite-signal snapshot torture -- SKIP: snapshot/restore require 1.6.0+");
    process.exit(77); // SKIP_EXIT -- escalated to FAIL by the runner at/above floor 1.6.0
}

const R = createReport("lite-signal snapshot torture -- clean-bit fuzz + fail-closed + retention");

/* ========================================================================== *
 * 1. ROUND-TRIP ORACLE FUZZ -- value correctness + clean-bit fidelity.
 *
 * Build a random DAG: signals with known values, then computeds each summing a
 * few EARLIER nodes + a constant (deterministic, so an independent oracle knows
 * every value). Read a random subset (forcing a clean cone). Snapshot. Restore
 * with bodies that COUNT their own invocations. Assert, per computed:
 *   value === oracle    (always)
 *   clean-in-snapshot  <=>  first read did NOT recompute (counter stayed 0)
 * ========================================================================== */

function fuzzRoundTrip(seed) {
    const rnd = mulberry32(seed);
    const NSIG = 20 + randInt(rnd, 40);
    const NCOMP = 40 + randInt(rnd, 80);

    const r = reg();
    // Parallel model, indexed by creation order (== a valid topological order,
    // since every dep points at an earlier node).
    const handles = [];   // live handles, build-time
    const oracle = [];     // expected current value per node
    const isComp = [];     // node is a computed?
    const depsOf = [];     // dep indices per node (empty for signals)
    const constOf = [];    // additive constant per computed

    for (let i = 0; i < NSIG; i++) {
        const v = randInt(rnd, 1000);
        handles.push(r.signal(v));
        oracle.push(v);
        isComp.push(false);
        depsOf.push([]);
        constOf.push(0);
    }
    for (let c = 0; c < NCOMP; c++) {
        const idx = handles.length;
        const nDeps = 1 + randInt(rnd, 3);
        const deps = [];
        for (let d = 0; d < nDeps; d++) deps.push(randInt(rnd, idx)); // any earlier node
        const k = randInt(rnd, 100);
        // Capture deps by value in the closure via the live-handle array.
        handles.push(r.computed(() => {
            let s = k;
            for (let d = 0; d < deps.length; d++) s += handles[deps[d]]();
            return s;
        }));
        let s = k;
        for (let d = 0; d < deps.length; d++) s += oracle[deps[d]];
        oracle.push(s);
        isComp.push(true);
        depsOf.push(deps);
        constOf.push(k);
    }

    // INDEPENDENT CLEAN ORACLE (E8). Expected cleanliness comes from this driver's
    // OWN op log, never from the snapshot. Spec: a computed is clean iff it has
    // been read (pulled) since the last write into its upstream cone. A write to
    // signal s dirties every computed reachable from s; a read of computed c
    // cleans c and every computed ancestor of c (c's body pulls all its deps).
    // A never-read computed is not clean. The op stream uses its own PRNG
    // (independent of the graph-shape stream above).
    const opRnd = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    const expClean = new Array(handles.length).fill(false);
    const compIdx = [];
    for (let i = 0; i < handles.length; i++) if (isComp[i]) compIdx.push(i);
    const nOps = 20 + randInt(opRnd, 60);
    let nWrites = 0, nReads = 0;
    for (let op = 0; op < nOps; op++) {
        if (randInt(opRnd, 100) < 35) {
            // WRITE a random signal to a guaranteed-different value.
            const si = randInt(opRnd, NSIG);
            const nv = oracle[si] + 1 + randInt(opRnd, 50);
            handles[si].set(nv);
            oracle[si] = nv;
            nWrites++;
            const hit = new Array(handles.length).fill(false);
            hit[si] = true;
            for (let i = NSIG; i < handles.length; i++) {
                let s2 = constOf[i], h = false;
                for (let d = 0; d < depsOf[i].length; d++) { s2 += oracle[depsOf[i][d]]; if (hit[depsOf[i][d]]) h = true; }
                oracle[i] = s2;
                if (h) { hit[i] = true; expClean[i] = false; }
            }
        } else {
            // READ a random computed; it and all its computed ancestors become clean.
            const ci = compIdx[randInt(opRnd, compIdx.length)];
            const got = handles[ci]();
            nReads++;
            R.eq("fuzz-preread", got, oracle[ci], `seed ${seed} node ${ci} pre-snapshot value`);
            const anc = new Array(handles.length).fill(false);
            anc[ci] = true;
            for (let i = ci; i >= NSIG; i--) {
                if (!anc[i]) continue;
                expClean[i] = true;
                for (let d = 0; d < depsOf[i].length; d++) anc[depsOf[i][d]] = true;
            }
        }
    }

    // Snapshot the settled graph.
    const snap = r.snapshot();
    R.eq("fuzz-shape", snap.v, 1, `seed ${seed} snapshot version`);
    R.ok("fuzz-shape", Array.isArray(snap.nodes) && snap.nodes.length === handles.length,
        `seed ${seed} snapshot node count ${snap.nodes && snap.nodes.length} != ${handles.length}`);

    // Map id -> clean bit and id -> record kind from the snapshot itself.
    const cleanById = new Map();
    for (const n of snap.nodes) cleanById.set(n.id, n.clean);
    // E8: the snapshot's clean bit must equal the op-log oracle, per computed.
    for (let i = 0; i < handles.length; i++) {
        if (!isComp[i]) continue;
        R.eq("fuzz-clean-oracle", snap.nodes[i].clean, expClean[i],
            `seed ${seed} node ${i} snapshot clean bit != op-log oracle`);
    }

    // Build restore bodies that count invocations, keyed by node id. We need
    // id<->index: snapshot preserves creation order, and restore preserves ids,
    // so we recover each node's index by matching its id to the build-time id.
    const idByIndex = snap.nodes.map((n) => n.id);       // index -> id (order preserved)
    const recompute = new Map();                          // id -> invocation count
    const handlesOut = {};                                // filled by restore
    const fnsById = {};
    for (let i = 0; i < handles.length; i++) {
        if (!isComp[i]) continue;
        const id = idByIndex[i];
        const deps = depsOf[i].map((d) => idByIndex[d]); // dep ids
        const k = constOf[i];
        recompute.set(id, 0);
        fnsById[id] = () => {
            recompute.set(id, recompute.get(id) + 1);
            let s = k;
            for (let d = 0; d < deps.length; d++) s += handlesOut[deps[d]]();
            return s;
        };
    }

    const restored = r.restore(snap, { fnsById, handles: handlesOut });

    // First read of every node, in creation order. Assert value + clean fidelity.
    let sawClean = 0, sawDirty = 0;
    for (let i = 0; i < handles.length; i++) {
        const id = idByIndex[i];
        const h = handlesOut[id];
        R.ok("fuzz-handle", typeof h === "function", `seed ${seed} restored handle ${id} missing`);
        const before = isComp[i] ? recompute.get(id) : 0;
        const got = h();
        R.eq("fuzz-value", got, oracle[i], `seed ${seed} restored node ${id} value`);
        if (isComp[i]) {
            const fired = recompute.get(id) - before;
            if (cleanById.get(id)) {
                sawClean++;
                R.eq("fuzz-clean", fired, 0,
                    `seed ${seed} CLEAN computed ${id} recomputed on first read (cache not trusted)`);
            } else {
                sawDirty++;
                R.eq("fuzz-dirty", fired, 1,
                    `seed ${seed} DIRTY computed ${id} did not recompute on first read (stale cache trusted)`);
            }
        }
    }

    // A propagation after restore must still be correct (the graph is live, not a
    // frozen snapshot): bump one signal and re-check a downstream computed.
    if (NSIG > 0 && NCOMP > 0) {
        const sigId = idByIndex[0];
        const delta = 7;
        handlesOut[sigId].set(oracle[0] + delta);
        // Re-derive the oracle for every computed depending (transitively) on sig 0.
        const newOracle = oracle.slice();
        newOracle[0] = oracle[0] + delta;
        for (let i = NSIG; i < handles.length; i++) {
            let s = constOf[i];
            for (const d of depsOf[i]) s += newOracle[d];
            newOracle[i] = s;
        }
        for (let i = 0; i < handles.length; i++) {
            R.eq("fuzz-postwrite", handlesOut[idByIndex[i]](), newOracle[i],
                `seed ${seed} node ${idByIndex[i]} after downstream write`);
        }
    }

    r.destroy();
    restored.destroy();
    return { sawClean, sawDirty, w: nWrites, rd: nReads };
}

{
    let totalClean = 0, totalDirty = 0, totalWrites = 0, totalReads = 0;
    const FLOOR_CLEAN = 896, FLOOR_DIRTY = 1616, FLOOR_WRITES = 576, FLOOR_READS = 1030; // measured 1121 / 2021 / 721 / 1288 (2026-10-21)
    const SEEDS = 40;
    for (let s = 1; s <= SEEDS; s++) {
        const { sawClean, sawDirty, w, rd } = fuzzRoundTrip(s * 0x9e37 + 1);
        totalClean += sawClean;
        totalDirty += sawDirty;
        totalWrites += w; totalReads += rd;
    }
    // Coverage: a fuzz that never produced BOTH a clean and a dirty restored
    // computed would assert the clean bit vacuously.
    // Floors ~80% of the minimum over 3 measured runs on the frozen engine
    // (2026-10-21; see .handoff/b96-evidence/H-E8/COVERAGE.md). The run is seeded.
    R.ok("fuzz-coverage", totalClean >= FLOOR_CLEAN, `CLEAN computeds ${totalClean} < floor ${FLOOR_CLEAN}`);
    R.ok("fuzz-coverage", totalDirty >= FLOOR_DIRTY, `DIRTY computeds ${totalDirty} < floor ${FLOOR_DIRTY}`);
    R.ok("fuzz-coverage", totalWrites >= FLOOR_WRITES, `writes ${totalWrites} < floor ${FLOOR_WRITES}`);
    R.ok("fuzz-coverage", totalReads >= FLOOR_READS, `reads ${totalReads} < floor ${FLOOR_READS}`);
    R.note(`COVERAGE clean=${totalClean} dirty=${totalDirty} writes=${totalWrites} reads=${totalReads}`);
    R.note(`round-trip fuzz: ${SEEDS} seeds, ${totalClean} clean + ${totalDirty} dirty restored computeds verified`);
}

/* ========================================================================== *
 * 2. FAIL-CLOSED BATTERY -- malformed snapshots + unsettled graph must throw.
 * ========================================================================== */

// A rejection test that passes on ANY throw is weak -- an unrelated TypeError
// would green it while the real fail-closed path rotted. `want` (a substring of
// the engine's own message) pins each case to the SPECIFIC rejection it targets.
function throws(scenario, fn, detail, want) {
    let msg = null;
    try { fn(); } catch (e) { msg = String(e && e.message != null ? e.message : e); }
    if (msg === null) { R.fail(scenario, detail + " (did not throw)"); return; }
    if (want && !msg.includes(want)) {
        R.fail(scenario, `${detail} (threw the wrong error: expected /${want}/, got "${msg}")`);
        return;
    }
    R.ok(scenario, true, detail);
}

{
    // A minimal valid snapshot: one signal, one computed depending on it.
    const build = () => {
        const r = reg();
        const s = r.signal(3);
        const c = r.computed(() => s() * 2);
        c(); // make it clean so it carries deps + a trusted value
        const snap = r.snapshot();
        r.destroy();
        return snap;
    };
    const sigId = () => build().nodes.find((n) => n.kind === "signal").id;
    const compId = () => build().nodes.find((n) => n.kind === "computed").id;

    // Missing fn for a computed.
    throws("fail-missing-fn", () => reg().restore(build(), { fnsById: {} }),
        "restore did not throw on a computed with no fn supplied", "missing fn");

    // Duplicate id.
    throws("fail-dup-id", () => {
        const snap = build();
        const dup = { ...snap.nodes[0], id: snap.nodes[1].id };
        snap.nodes.push(dup);
        const cid = compId();
        reg().restore(snap, { fnsById: { [cid]: () => 0 } });
    }, "restore did not throw on a duplicate node id", "duplicate id");

    // Dangling dep (computed points at an id that is not in the snapshot).
    throws("fail-dangling-dep", () => {
        const snap = build();
        const comp = snap.nodes.find((n) => n.kind === "computed");
        comp.deps = [999999];
        reg().restore(snap, { fnsById: { [comp.id]: () => 0 } });
    }, "restore did not throw on a dangling dep id", "dep id");

    // Bad owner (ownerId not present).
    throws("fail-bad-owner", () => {
        const snap = build();
        snap.nodes.find((n) => n.kind === "computed").ownerId = 888888;
        const cid = compId();
        reg().restore(snap, { fnsById: { [cid]: () => 0 } });
    }, "restore did not throw on a missing owner id", "owner id");

    // Wrong shape: not v:1.
    throws("fail-bad-version", () => reg().restore({ v: 2, nodes: [], gv: 1, nextId: 1 }, {}),
        "restore did not throw on an unknown snapshot version", "invalid snapshot");
    throws("fail-bad-nodes", () => reg().restore({ v: 1, nodes: "nope", gv: 1, nextId: 1 }, {}),
        "restore did not throw on a non-array nodes field", "invalid snapshot");

    R.note(`fail-closed battery: 6 malformed-input rejections asserted`);
}

{
    // Unsettled-graph guard: snapshot() must throw mid-batch, mid-flush, mid-track.
    // mid-batch.
    throws("guard-batch", () => {
        const r = reg();
        r.signal(0);
        r.batch(() => { r.snapshot(); });
    }, "snapshot did not throw inside a batch", "not settled");

    // mid-track (inside a computing computed body).
    throws("guard-track", () => {
        const r = reg();
        const s = r.signal(0);
        const c = r.computed(() => { s(); r.snapshot(); return 0; });
        c();
    }, "snapshot did not throw inside a tracking compute body", "not settled");

    // mid-flush (inside a running effect body -- isFlushing is set). The engine
    // buffers a throwing effect body and rethrows it out of the driving write, so
    // the guard's message travels inside that (possibly Aggregate) error.
    throws("guard-flush", () => {
        const r = reg();
        const s = r.signal(0);
        r.effect(() => { s(); r.snapshot(); });
        s.set(1); // drive a flush; the effect body calls snapshot mid-flush
    }, "snapshot did not throw inside a flush", "not settled");

    R.note(`unsettled-graph guard: batch / track / flush all rejected`);
}

{
    // D-B (1.6.0): untrack() / createRoot() / runWithOwner() clear currentObserver
    // inside a running body, so a currentObserver-only guard lets snapshot() walk a
    // torn graph. The FLAG_COMPUTING check in the walk must still reject it. The
    // probes run in an effect's FIRST run (created outside any flush, so isFlushing
    // is false and only the walk check can see it) and in a computed's body.
    const r = reg();
    const s = r.signal(0);
    const got = { untrack: null, root: null, rwo: null, compUntrack: null, compRoot: null };
    const probe = (k, f) => {
        try { f(); got[k] = "(no throw)"; } catch (e) { got[k] = String(e && e.message != null ? e.message : e); }
    };
    r.effect(() => {
        s();
        probe("untrack", () => r.untrack(() => r.snapshot()));
        probe("root", () => r.createRoot(() => r.snapshot()));
        const o = r.getOwner();
        probe("rwo", () => r.runWithOwner(o, () => r.snapshot()));
    });
    const c = r.computed(() => {
        s();
        probe("compUntrack", () => r.untrack(() => r.snapshot()));
        probe("compRoot", () => r.createRoot(() => r.snapshot()));
        return 0;
    });
    c();
    for (const k of Object.keys(got)) {
        R.ok("guard-escape", got[k] !== null && got[k].includes("not settled"),
            `snapshot under ${k} inside a running body did not throw "not settled" (got ${got[k]})`);
    }
    // Control: the same registry, settled, snapshots fine (the guard is not stuck).
    let settled = null;
    try { settled = r.snapshot(); } catch (e) { settled = null; }
    R.ok("guard-escape", settled !== null && settled.v === 1, "settled snapshot after the probes threw");
    r.destroy();
    R.note(`D-B guard: untrack / createRoot / runWithOwner inside effect + computed bodies all rejected`);
}

/* ========================================================================== *
 * 3. EFFECTS RESTORE WITHOUT RE-FIRING.
 * ========================================================================== */

{
    const r = reg();
    const s = r.signal(1);
    let fires = 0;
    r.effect(() => { s(); fires++; });
    R.eq("effect-setup", fires, 1, "effect did not run once on creation");
    const snap = r.snapshot();

    // Restore: the effect body counts into a SEPARATE counter. It must NOT run
    // during restore (state back, no side effect), then fire on the next change.
    let restoredFires = 0;
    const handlesOut = {};
    const effId = snap.nodes.find((n) => n.kind === "effect").id;
    const sId = snap.nodes.find((n) => n.kind === "signal").id;
    const restored = r.restore(snap, {
        fnsById: { [effId]: () => { handlesOut[sId](); restoredFires++; } },
        handles: handlesOut,
    });
    R.eq("effect-norefire", restoredFires, 0, "a restored effect re-fired during restore (must restore state, not re-run)");
    handlesOut[sId].set(2);
    R.eq("effect-refire", restoredFires, 1, "a restored effect did not fire on the next dependency change");

    r.destroy();
    restored.destroy();
}

/* ========================================================================== *
 * 4. BOXES ROUND-TRIP AS BOXES.
 * ========================================================================== */

function boxRoundTrip() {
    const r = reg();
    // D-A: op-1 flags carry FLAG_BOX (128) for boxes only (callables 32 / 1).
    const op1 = [];
    const unhook = r.onGraphMutation((op, id, flags) => { if (op === 1) op1.push(flags); });
    const ctlS = r.signal(1);
    const ctlC = r.computed(() => ctlS() + 1);
    const sb = r.signalBox(10);
    const cb = r.computedBox(() => sb.get() * 3);
    unhook();
    R.eq("box-flags", op1.join(","), "32,1,160,129", "onGraphMutation op-1 flags (signal, computed, signalBox, computedBox)");
    R.eq("box-setup", cb.get(), 30, "computedBox initial value");
    R.eq("box-setup", ctlC(), 2, "control computed initial value");
    const snap = r.snapshot();

    const kinds = new Set(snap.nodes.map((n) => n.kind));
    R.ok("box-kind", kinds.has("signalBox"), "signalBox not recorded as a distinct kind");
    R.ok("box-kind", kinds.has("computedBox"), "computedBox not recorded as a distinct kind");
    for (const n of snap.nodes) {
        const boxBit = (n.flags & 128) !== 0;
        const isBoxKind = n.kind === "signalBox" || n.kind === "computedBox";
        R.eq("box-flags", boxBit, isBoxKind, `snapshot record ${n.id} kind ${n.kind} flags ${n.flags}: FLAG_BOX bit`);
    }

    const sbRec = snap.nodes.find((n) => n.kind === "signalBox");
    const cbRec = snap.nodes.find((n) => n.kind === "computedBox");
    if (sbRec === undefined || cbRec === undefined) {
        R.fail("box-kind", "box records missing from the snapshot -- box round-trip not exercised");
        r.destroy();
        return;
    }
    const sbId = sbRec.id;
    const cbId = cbRec.id;
    const handlesOut = {};
    const ctlSId = snap.nodes.find((n) => n.kind === "signal").id;
    const ctlCId = snap.nodes.find((n) => n.kind === "computed").id;
    const restored = r.restore(snap, {
        fnsById: { [cbId]: () => handlesOut[sbId].get() * 3, [ctlCId]: () => handlesOut[ctlSId]() + 1 },
        handles: handlesOut,
    });
    // A restored box must be a box again (op-1 flags of the rebuild, via a re-snapshot).
    const reKinds = restored.snapshot().nodes.map((n) => n.kind + ":" + ((n.flags & 128) !== 0)).sort().join(",");
    R.eq("box-flags", reKinds, "computed:false,computedBox:true,signal:false,signalBox:true", "re-snapshot kinds + FLAG_BOX after restore");
    R.eq("box-value", handlesOut[sbId].get(), 10, "restored signalBox .get()");
    R.eq("box-value", handlesOut[cbId].get(), 30, "restored computedBox .get()");
    handlesOut[sbId].set(4);
    R.eq("box-live", handlesOut[cbId].get(), 12, "restored computedBox did not recompute after a box write");

    r.destroy();
    restored.destroy();
}
boxRoundTrip();

/* ========================================================================== *
 * 4b. D-C SIZING -- restore() without config sizes nodes AND links from the
 *     snapshot; the source policy is not carried; an explicit config wins.
 * ========================================================================== */

function restoreNoThrow(scenario, fn, detail) {
    try { return fn(); } catch (e) { R.fail(scenario, `${detail} (threw ${e && e.name}: ${e && e.message})`); return null; }
}

{
    // 2000 nodes: > the 1024 default maxNodes under the default 'throw' policy.
    const r = reg();
    const NS = 1000;
    const hs = [];
    for (let i = 0; i < NS; i++) hs.push(r.signal(i));
    for (let i = 0; i < NS; i++) { const a = hs[i]; hs.push(r.computed(() => a() + 1)); }
    for (let i = NS; i < hs.length; i++) hs[i]();
    const snap = r.snapshot();
    const fnsById = {};
    const H = {};
    for (let i = NS; i < snap.nodes.length; i++) {
        const dep = snap.nodes[i].deps[0];
        fnsById[snap.nodes[i].id] = () => H[dep]() + 1;
    }
    const r2 = restoreNoThrow("sizing-nodes", () => r.restore(snap, { fnsById, handles: H }),
        "2000-node snapshot restore without config");
    if (r2 !== null) {
        R.eq("sizing-nodes", r2.stats().activeNodes, 2000, "restored activeNodes");
        R.eq("sizing-nodes", H[snap.nodes[NS + 5].id](), 6, "restored computed value");
        r2.destroy();
    }
    r.destroy();
}

{
    // Link-heavy: 600 signals + 600 computeds x 14 deps = 8400 links. maxNodes sizes
    // to 1816, so the 4 x maxNodes floor (7264) alone is too small: only the
    // 1.5L + 16 term (12616) fits the rebuild.
    const r = reg();
    const NS = 600, DEPS = 14;
    const hs = [];
    for (let i = 0; i < NS; i++) hs.push(r.signal(i));
    for (let i = 0; i < NS; i++) {
        const ds = [];
        for (let d = 0; d < DEPS; d++) ds.push(hs[(i + d * 37) % NS]);
        hs.push(r.computed(() => { let t = 0; for (let d = 0; d < ds.length; d++) t += ds[d](); return t; }));
    }
    for (let i = NS; i < hs.length; i++) hs[i]();
    const snap = r.snapshot();
    let links = 0;
    for (const n of snap.nodes) links += n.deps.length;
    R.eq("sizing-links", links, NS * DEPS, "link-heavy snapshot edge count");
    const fnsById = {};
    const H = {};
    for (let i = NS; i < snap.nodes.length; i++) {
        const deps = snap.nodes[i].deps;
        fnsById[snap.nodes[i].id] = () => { let t = 0; for (let d = 0; d < deps.length; d++) t += H[deps[d]](); return t; };
    }
    const r2 = restoreNoThrow("sizing-links", () => r.restore(snap, { fnsById, handles: H }),
        "8400-link snapshot restore without config");
    if (r2 !== null) {
        R.eq("sizing-links", r2.stats().activeLinks, NS * DEPS, "restored activeLinks (clean computeds re-linked)");
        H[snap.nodes[0].id].set(1000);
        let want = 0;
        for (let d = 0; d < DEPS; d++) want += (0 + d * 37) % NS === 0 ? 1000 : (0 + d * 37) % NS;
        R.eq("sizing-links", H[snap.nodes[NS].id](), want, "restored link-heavy computed after a write");
        r2.destroy();
    }
    r.destroy();
}

{
    // Policy not carried: the source grows, the restored registry keeps the default
    // 'throw' policy and its own (snapshot-sized) capacity.
    const r = reg();
    r.signal(1);
    const snap = r.snapshot();
    const r2 = r.restore(snap);
    let err = null;
    try { for (let i = 0; i < 4096; i++) r2.signal(i); } catch (e) { err = e; }
    R.ok("sizing-policy", err instanceof CapacityError,
        `restored registry grew past its sized capacity (source 'grow' policy carried?) -- got ${err && err.name}`);
    r2.destroy();

    // An explicit config wins: maxNodes 4 cannot hold a 10-node snapshot.
    for (let i = 0; i < 9; i++) r.signal(i);
    const snap10 = r.snapshot();
    R.eq("sizing-config", snap10.nodes.length, 10, "10-node snapshot");
    let e2 = null, got = "unset";
    try { got = r.restore(snap10, { config: { maxNodes: 4 } }); } catch (e) { e2 = e; }
    R.ok("sizing-config", e2 instanceof CapacityError && got === "unset",
        `restore with config { maxNodes: 4 } of 10 nodes did not throw CapacityError (got ${e2 && e2.name})`);
    // The config still passes the createRegistry door: an unknown key throws.
    throws("sizing-config", () => r.restore(snap10, { config: { maxNodez: 64 } }),
        "restore with an unknown config key did not throw");
    r.destroy();
    R.note(`D-C sizing: 2000 nodes + 8400 links restored without config; policy not carried; config wins`);
}

/* ========================================================================== *
 * 4c. D-D NOT CAPTURED -- functions never enter the snapshot; the restored
 *     graph runs with the defaults (Object.is equality, synchronous effects).
 * ========================================================================== */

{
    const r = reg();
    const s = r.signal(1, { equals: () => true }); // swallows every write
    s.set(2);
    R.eq("not-captured", s(), 1, "control: source custom equals swallows the write");
    const queue = [];
    const e = r.effect(() => { s(); }, { scheduler: (run) => { queue.push(run); } });
    while (queue.length) queue.shift()();
    const sId = r.nodeId(s), eId = r.nodeId(e);
    const snap = r.snapshot();
    // D-J: subPos parallel to deps; D-J6: ownerPos; D-M (b100): evalVersion + markEpoch per record, gv + nextId on the snapshot.
    const KEYS = "clean,deps,evalVersion,flags,id,kind,markEpoch,ownerId,ownerPos,subPos,value,version";
    R.eq("not-captured", Object.keys(snap).join(","), "v,nodes,gv,nextId", "snapshot top-level keys (in order)");
    R.ok("not-captured", Number.isInteger(snap.gv) && snap.gv !== 0 && Number.isInteger(snap.nextId), `gv ${snap.gv} / nextId ${snap.nextId} not int32 (gv != 0)`);
    for (const n of snap.nodes) {
        R.eq("not-captured", Object.keys(n).sort().join(","), KEYS, `snapshot record ${n.id} keys (no fn / equals / scheduler)`);
    }
    const H = {};
    let runs = 0;
    const r2 = r.restore(snap, { fnsById: { [eId]: () => { H[sId](); runs++; } }, handles: H });
    H[sId].set(2);
    R.eq("not-captured", H[sId](), 2, "restored signal kept the custom equals (expected Object.is)");
    R.eq("not-captured", runs, 1, "restored effect did not re-run synchronously (scheduler carried?)");
    R.eq("not-captured", queue.length, 0, "the source scheduler was consulted by the restored graph");
    r2.destroy();
    r.destroy();
}

/* ========================================================================== *
 * 4d. TOP-LEVEL EXPORTS drive the default registry.
 * ========================================================================== */

{
    R.ok("exports", typeof Signal.snapshot === "function" && typeof Signal.restore === "function",
        "top-level snapshot / restore exports missing");
    if (typeof Signal.snapshot === "function" && typeof Signal.restore === "function") {
        const s = Signal.signal(41);
        const sId = Signal.nodeId(s);
        const snap = Signal.snapshot();
        R.ok("exports", snap.nodes.some((n) => n.id === sId && n.value === 41), "default-registry snapshot missed a default signal");
        const H = {};
        const r2 = Signal.restore(snap, { handles: H });
        R.eq("exports", H[sId](), 41, "default-registry restore value");
        R.ok("exports", r2 !== null && typeof r2.destroy === "function" && r2.snapshot !== Signal.snapshot,
            "restore did not return an independent registry");
        r2.destroy();
        Signal.dispose(s);
    }
}

/* ========================================================================== *
 * 5. RETENTION WITNESS -- snapshot/restore allocate; per-cycle retention must
 *    NOT climb. Force GC between batches and compare retained high-water.
 * ========================================================================== */

if (typeof globalThis.gc !== "function") {
    // The engine surface is present (we passed the floor gate), but the RUNTIME
    // lacks --expose-gc; a retention claim without a forced GC is noise, not a
    // pass. Environment skip -- never floor-escalated.
    console.log("lite-signal snapshot torture -- ENV SKIP: retention witness needs --expose-gc");
    console.log("    (contract + fail-closed sections above ran; rerun with --expose-gc for the full gate)");
    process.exit(78); // ENV_SKIP_EXIT
}

{
    const BATCH = 200;      // snapshot->restore cycles per batch
    const BATCHES = 5;
    const GRAPH = 300;      // nodes per cycle

    function oneCycle() {
        const r = reg();
        const sigs = [];
        for (let i = 0; i < GRAPH / 3; i++) sigs.push(r.signal(i));
        const comps = [];
        for (let i = 0; i < GRAPH - sigs.length; i++) {
            const a = sigs[i % sigs.length];
            const b = comps.length ? comps[i % comps.length] : sigs[0];
            comps.push(r.computed(() => a() + b()));
        }
        for (const c of comps) c(); // settle -> clean
        const snap = r.snapshot();
        const idByIndex = snap.nodes.map((n) => n.id);
        const fnsById = {};
        const handlesOut = {};
        // Rebuild bodies by structural position (signals first, then computeds).
        for (let i = sigs.length; i < snap.nodes.length; i++) {
            const rec = snap.nodes[i];
            const aId = idByIndex[(i - sigs.length) % sigs.length];
            const bIdx = (i - sigs.length);
            const bId = bIdx > 0 ? idByIndex[sigs.length + (bIdx % bIdx)] : idByIndex[0];
            fnsById[rec.id] = () => handlesOut[aId]() + handlesOut[bId]();
        }
        const restored = r.restore(snap, { fnsById, handles: handlesOut });
        if (restored.stats().activeNodes !== GRAPH) liveMismatch++;
        r.destroy();
        restored.destroy();
        if (restored.stats().activeNodes !== 0) liveMismatch++;
    }
    let liveMismatch = 0;

    // Warm the JIT + let one-time lazy allocations settle before the first mark.
    for (let i = 0; i < BATCH; i++) oneCycle();
    globalThis.gc(); globalThis.gc();

    const highWater = [];
    for (let b = 0; b < BATCHES; b++) {
        for (let i = 0; i < BATCH; i++) oneCycle();
        globalThis.gc(); globalThis.gc();
        highWater.push(process.memoryUsage().heapUsed);
    }
    R.eq("retention", liveMismatch, 0,
        "cycles whose restored registry did not hold GRAPH nodes, or kept active nodes after destroy()");

    // Retention is a leak iff the retained heap grows monotonically batch over
    // batch. Compare the last batch's high-water to the first: a healthy pair of
    // cold paths returns the whole cycle to GC, so any drift is noise, not
    // accumulation. Allow generous slack (2 MB) for allocator fragmentation and
    // deopt caches; a real per-cycle leak at 200*5 cycles would dwarf it.
    const first = highWater[0];
    const last = highWater[highWater.length - 1];
    const growthMB = (last - first) / (1024 * 1024);
    const SLACK_MB = 2;
    R.ok("retention", growthMB < SLACK_MB,
        `retained heap climbed ${growthMB.toFixed(2)} MB across ${BATCHES} batches of ${BATCH} cycles ` +
        `(>= ${SLACK_MB} MB slack) -- snapshot or restore is retaining per cycle`);
    R.note(`retention witness: ${BATCHES}x${BATCH} cycles @ ${GRAPH} nodes, heap drift ${growthMB.toFixed(2)} MB (slack ${SLACK_MB} MB)`);
    R.note(`high-water MB: ${highWater.map((h) => (h / 1048576).toFixed(1)).join(" -> ")}`);
}

// A6 (b100): restore + destroy x100 under a lite-leak tracker -- every restored registry is collected (size() -> 0).
// The cleanup and the tag are module-level constants: neither closes over the tracked registry. Nothing calls
// untrack(): a size() that returns to 0 is the finalizer path, i.e. every dropped registry was COLLECTED, so each
// one reports through onLeak exactly once (100 reports = 100 collections; a retained registry keeps size() > 0).
const LEAK_NOOP = () => {};
{
    const leaks = [];
    const tracker = createLeakTracker({ name: "snapshot-restore", onLeak: (x) => leaks.push(x.kind + ":" + String(x.tag)) });
    let cycles = 0;
    const leakCycle = (i) => {
        const r = reg();
        const s = r.signal(i);
        const c = r.computed(() => s() * 2);
        const e = r.effect(() => { c(); });
        s.set(i + 1); r.batch(() => { s.set(i + 7); s.set(i + 1); });
        const sId = r.nodeId(s), cId = r.nodeId(c), eId = r.nodeId(e);
        const H = {};
        const r2 = r.restore(r.snapshot(), { fnsById: { [cId]: () => H[sId]() * 2, [eId]: () => { H[cId](); } }, handles: H });
        H[sId].set(i + 2);
        tracker.track(r2, LEAK_NOOP, "restored");
        r2.destroy(); r.destroy();
        cycles++;
    };
    for (let i = 0; i < 100; i++) leakCycle(i);
    const before = tracker.size();
    for (let k = 0; k < 20 && tracker.size() > 0; k++) { globalThis.gc(); await new Promise((res) => setTimeout(res, 25)); }
    R.eq("retention", cycles, 100, "restore + destroy cycles run");
    R.eq("retention", before, 100, "tracker saw every restored registry before GC");
    R.eq("retention", tracker.size(), 0, "restored registries still alive after restore + destroy x100 + GC (lite-leak tracker.size())");
    R.eq("retention", leaks.length, 100, "finalizer reports (one per collected registry)");
    R.note(`lite-leak witness: restore + destroy x${cycles}, tracker.size() ${before} -> ${tracker.size()}`);
}

process.exit(R.finish("snapshot/restore contract + fail-closed + retention all held", { minAsserts: 50 }));
