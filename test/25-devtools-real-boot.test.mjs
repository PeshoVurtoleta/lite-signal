// Real lite-devtools 1.6.2 boot against the 1.7.0 engine.
//
// Setup note (test-rig quirk, NOT an engine bug). Because this repo's
// package.json declares name="@zakkster/lite-signal", the resolver maps any
// "@zakkster/lite-signal" specifier WITHIN the project to the project's own
// Signal.js -- but Devtools.js living in node_modules/@zakkster/lite-devtools/
// resolves the SAME specifier to the published copy in node_modules. Two module
// URLs => two module instances => two sets of module-private NODE_PTR/NODE_GEN
// symbols => a handle built by one engine is unrecognised by the other
// (inspect() reads it as stale, graph() walks nothing, observeObservers throws
// "not a reactive handle"). In a real consuming app both packages live in
// node_modules and resolve once, so this never happens.
//
// This file makes the test environment match that single-instance production
// model: at load time it copies the installed Devtools.js into a project-local
// probe dir and rewrites its bare "@zakkster/lite-signal" import to the project
// engine (../Signal.js), so Devtools and this test share ONE engine instance.
// If anything regresses to two instances, the precondition guard below fails
// fast with an actionable message instead of three cryptic handle errors.
//
// GROUND TRUTH (probed live, devtools 1.6.2 x engine 1.7.0-beta, 2026-09-06):
// 22 function exports + VERSION const "1.6.2"; capabilities() = exactly 13 keys
// { floor:"1.1.5", owners:T, mutationHook:T, burst:T, boxes:T, roots:T,
//   ownerCapture:T, scopes:T, flushControl:T, explicitDispose:T, statsKeys:14,
//   poolPopulation:T, cleanupReturn:F }; burstProfile() returns a LIVE handle
// { stop, passes, perPass, queued, ran, redundant, shortCircuited }; the 1.6.x
// devtools Symbol.dispose stamps hold (off[Symbol.dispose] === off for track,
// h[Symbol.dispose] === h.stop for the object handles).

import {describe, it, before} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import * as SIG from "../Signal.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Build a project-local Devtools whose engine import points at OUR Signal.js.
function buildLocalDevtools() {
    // Locate the installed Devtools source via its package specifier.
    const dtUrl = import.meta.resolve("@zakkster/lite-devtools");
    const dtPath = fileURLToPath(dtUrl);
    let src = readFileSync(dtPath, "utf8");

    // Rewrite the engine specifier to the project engine so both share one
    // instance. Matches both quote styles and the * as S / named-import forms.
    const ENGINE_REL = "../../Signal.js"; // probe lives at test/devtools-probe/
    const SPEC = /(["'])@zakkster\/lite-signal\1/g;
    if (!SPEC.test(src)) {
        throw new Error(
            "test 25: could not find the '@zakkster/lite-signal' import in Devtools.js to " +
            "rewrite. The Devtools engine import specifier changed -- update SPEC in " +
            "buildLocalDevtools() so the probe still shares this test's engine instance."
        );
    }
    SPEC.lastIndex = 0;
    src = src.replace(SPEC, `"${ENGINE_REL}"`);

    const probeDir = join(HERE, "devtools-probe");
    mkdirSync(probeDir, {recursive: true});
    const probeFile = join(probeDir, "Devtools.js");
    writeFileSync(probeFile, src, "utf8");
    return probeFile;
}

let DT;
before(async () => {
    const probeFile = buildLocalDevtools();
    DT = await import(probeFile);

    // PRECONDITION: Devtools and this test must share ONE engine instance.
    // If they don't, handles are not portable and the handle-taking tests
    // would fail with opaque errors -- so fail fast here with the fix.
    const ViaDevtools = await import("../Signal.js");
    assert.strictEqual(
        SIG.createRegistry, ViaDevtools.createRegistry,
        "test 25 requires a single engine instance: the Devtools probe must import " +
        "the same ../Signal.js this test uses. If this fails, the import-rewrite in " +
        "buildLocalDevtools() did not match the Devtools engine specifier."
    );
});

describe("lite-devtools 1.6.2 boots against the 1.7.0 engine", () => {
    it("imports resolve: all 22 documented functions + the VERSION const", () => {
        // 19 baseline + burstProfile/watchAllocations (1.3.x) + pendingEffects.
        const expected = [
            "capabilities", "inspect", "subscribers", "dependencies", "track",
            "monitor", "leakWatch", "report", "graph", "toDot", "toTree", "diff",
            "trace", "ownerTree", "findPath", "watchGraph", "profile",
            "serialize", "deserialize", "burstProfile", "watchAllocations",
            "pendingEffects",
        ];
        for (const name of expected) {
            assert.equal(typeof DT[name], "function", `devtools.${name} must be a function`);
        }
        const fns = Object.keys(DT).filter((k) => typeof DT[k] === "function");
        assert.equal(fns.length, expected.length,
            `devtools exports exactly ${expected.length} functions (got ${fns.length}: a new/removed ` +
            "export means this pairing pin is stale -- update the expected list deliberately)");
        // Three-place version sync: the devDep bump must travel with this test.
        assert.equal(DT.VERSION, "1.6.2", "devtools VERSION const pins the tested pairing");
    });

    // capabilities() is devtools' runtime probe of the engine it is bound to.
    // Asserting the FULL vector (values AND key set) turns it into a precise
    // fingerprint of the 1.7.0 surface: the 1.5 triad (boxes / roots /
    // ownerCapture), the 1.6 pair (scopes / burst), AND the 1.7 flushControl
    // must be present, while every 1.8+ feature (cleanupReturn) must be absent.
    // If a later engine feature is accidentally back-ported into this line, one
    // of these flags flips and this test catches it -- across the two-package
    // boundary, not from the engine's own introspection.
    it("capabilities() fingerprints EXACTLY the 1.7.0 surface (1.5+1.6+1.7 on, 1.8+ off)", () => {
        const caps = DT.capabilities();
        assert.equal(typeof caps, "object");
        assert.ok(caps !== null);

        // Exact key set -- a new capability key appearing (or one vanishing)
        // must be a deliberate re-pin, not a silent drift.
        assert.deepEqual(Object.keys(caps).sort(), [
            "boxes", "burst", "cleanupReturn", "explicitDispose", "floor",
            "flushControl", "mutationHook", "ownerCapture", "owners",
            "poolPopulation", "roots", "scopes", "statsKeys",
        ], "capabilities() key set drifted -- re-pin deliberately");

        assert.equal(caps.floor, "1.1.5", "devtools baseline floor");

        // Present in 1.7.0.
        assert.equal(caps.owners, true, "1.7.0 has the owner tree");
        assert.equal(caps.mutationHook, true, "1.7.0 has onGraphMutation");
        assert.equal(caps.boxes, true, "1.7.0 has signalBox / computedBox");
        assert.equal(caps.roots, true, "1.7.0 has createRoot");
        assert.equal(caps.ownerCapture, true, "1.7.0 has getOwner / runWithOwner");
        assert.equal(caps.explicitDispose, true, "1.7.0 has explicit dispose");
        assert.equal(caps.poolPopulation, true, "1.7.0 stats expose pool population");
        assert.equal(caps.scopes, true, "createScope ships in 1.6.0 -- scopes must read true");
        assert.equal(caps.burst, true, "the op 5/6/7 burst payload ships in 1.6.0 -- burst must read true");
        assert.equal(caps.statsKeys, 14, "1.7.0 stats() has exactly 14 keys (13 + flushPasses)");
        assert.equal(caps.flushControl, true,
            "flushStrategy + r.flush() ship in 1.7.0 -- flushControl must read true");

        // Absent until later engines -- graceful-degrade sentinels.
        assert.equal(caps.cleanupReturn, false, "effect-return cleanup is a 1.8 feature, must be absent in 1.7.0");
    });

    it("inspect() reports a live handle as non-stale, with sensible neighbourhood counts", () => {
        const a = SIG.signal(1);
        const c = SIG.computed(() => a() + 1);
        c();
        const info = DT.inspect(c);
        assert.equal(info.stale, false, "freshly-created live handle must not be stale");
        assert.equal(info.value, 2);
        assert.ok(info.sourceCount >= 1, "computed should report at least one source");
        SIG.dispose(c); SIG.dispose(a);
    });

    it("graph() walks a real reactive DAG and returns nodes", () => {
        const a = SIG.signal(1);
        const b = SIG.signal(2);
        const sum = SIG.computed(() => a() + b());
        const prod = SIG.computed(() => a() * b());
        const combined = SIG.computed(() => sum() + prod());
        combined();

        const g = DT.graph([combined]);
        assert.ok(g !== null && typeof g === "object");
        const nodeCount = Array.isArray(g.nodes) ? g.nodes.length
                       : g.nodes && typeof g.nodes.size === "number" ? g.nodes.size
                       : Object.keys(g.nodes || {}).length;
        assert.ok(nodeCount >= 3, "graph walked from combined must include at least combined+sum+prod");

        SIG.dispose(combined); SIG.dispose(sum); SIG.dispose(prod);
        SIG.dispose(b); SIG.dispose(a);
    });

    it("diff() returns an object describing the snapshot delta", () => {
        const a = SIG.signal(1);
        const c1 = SIG.computed(() => a());
        c1();
        const before = DT.graph([c1]);

        const c2 = SIG.computed(() => a() * 2);
        c2();
        const after = DT.graph([c1, c2]);

        const d = DT.diff(before, after);
        assert.ok(d !== null && typeof d === "object");

        SIG.dispose(c1); SIG.dispose(c2); SIG.dispose(a);
    });

    it("ownerTree() returns a { id, kind, value, owned } descriptor for a rooted effect", () => {
        // createRoot opens a detached ownership scope; an effect created inside
        // it becomes an owned child of that root. ownerTree walks that tree.
        let tree = null;
        SIG.createRoot(() => {
            const s = SIG.signal(5);
            const e = SIG.effect(() => { s(); });
            tree = DT.ownerTree(e);
        });
        assert.ok(tree !== null && typeof tree === "object", "ownerTree must return a descriptor");
        assert.equal(typeof tree.id, "number", "descriptor carries a numeric node id");
        assert.equal(tree.kind, "effect", "the walked node is the effect");
        assert.ok(Array.isArray(tree.owned), "descriptor carries an owned[] child array");
    });

    it("burstProfile() is LIVE on 1.7.0: stop() summarizes a batched burst exactly", () => {
        // On 1.5.0 this degraded to null. 1.6.0+ emits the op 6/7 flush payload,
        // so capabilities().burst is true and burstProfile() must hand back the
        // real handle. PROBED CONTRACT (1.6.2 x 1.6.0-rc): the counters
        // materialize in stop()'s returned summary { passes, perPass[], queued,
        // ran } -- they are NOT live reads on the handle -- and the accounting
        // is deterministic: effect creation contributes no flush pass, and a
        // 3-write batch coalesces to exactly one pass running exactly one
        // effect. Deeper coalescing torture is gated in
        // bench/torture/burst-profile-torture.mjs; this pins the boot contract.
        assert.equal(DT.capabilities().burst, true, "precondition: 1.7.0 carries the burst payload");
        const bp = DT.burstProfile();
        assert.ok(bp !== null && typeof bp === "object", "burstProfile() must return a live handle on 1.7.0");
        assert.equal(typeof bp.stop, "function");
        for (const k of ["passes", "perPass", "queued", "ran", "redundant", "shortCircuited"]) {
            assert.ok(k in bp, `burst handle carries documented field '${k}'`);
        }

        const s = SIG.signal(0);
        const e = SIG.effect(() => { s(); });                 // creation run: DIRECT, no flush pass
        SIG.batch(() => { s.set(1); s.set(2); s.set(3); });   // coalesces to ONE pass, ONE run
        const summary = bp.stop();
        assert.ok(summary !== null && typeof summary === "object",
            "stop() returns the burst summary (documented contract)");
        assert.equal(summary.passes, 1,
            "three batched writes must coalesce to exactly ONE observed flush pass");
        assert.deepEqual(summary.perPass, [1],
            "that pass must run exactly one effect (no redundant re-runs)");
        bp.stop();   // idempotent -- must not throw
        SIG.dispose(e); SIG.dispose(s);
    });

    it("Symbol.dispose (using) stamps: track's off is self-stamped, handles mirror stop",
       {skip: typeof Symbol.dispose !== "symbol" ? "Symbol.dispose absent on this Node" : false},
       () => {
        // devtools 1.6.x stamps Symbol.dispose across its stopper handles:
        // track() returns a bare function self-stamped (off[Symbol.dispose] ===
        // off); object handles mirror their idempotent stop. Dispose-then-stop
        // and stop-then-dispose are both no-ops.
        const s = SIG.signal(0);
        const off = DT.track(s, () => {});
        assert.equal(off[Symbol.dispose], off, "track off must be self-stamped, never a new closure");
        off[Symbol.dispose]();
        off();   // idempotent after dispose

        const feed = DT.watchAllocations(() => {}, {sampleMs: 50});
        assert.equal(feed[Symbol.dispose], feed.stop, "handle mirrors its stop onto Symbol.dispose");
        feed[Symbol.dispose]();
        feed.stop();   // idempotent after dispose
        SIG.dispose(s);
    });

    it("watchAllocations() returns an idempotent { stop } and leaks no timer", () => {
        // Steady-state allocation feed. Like leakWatch it samples off lite-time's
        // every() -- OUT of the reactive graph -- so it must hand back a stopper
        // that clears the sampler. Double-stop must be a safe no-op.
        const feed = DT.watchAllocations(() => {}, { sampleMs: 20, recomputes: true });
        assert.equal(typeof feed, "object");
        assert.equal(typeof feed.stop, "function");
        feed.stop();
        feed.stop();   // idempotent -- must not throw
    });

    it("monitor() returns an object usable by devtools UIs", () => {
        const m = DT.monitor();
        assert.ok(m !== null && typeof m === "object");
    });

    it("leakWatch() registers and stops cleanly without leaking the timer", () => {
        const watch = DT.leakWatch({ sampleMs: 50, growth: 1, onSample: () => {} });
        assert.equal(typeof watch, "object");
        assert.equal(typeof watch.stop, "function");
        watch.stop();   // CRITICAL: clears the sampler handle
    });

    it("track() registers a lifecycle listener against a 1.7.0-built handle", () => {
        const s = SIG.signal(0);
        const events = [];
        const untrack = DT.track(s, (e) => events.push(e));
        assert.equal(typeof untrack, "function");
        const e = SIG.effect(() => { s(); });
        SIG.dispose(e);
        untrack();
        SIG.dispose(s);
    });

    it("ghost contract: the ENTIRE read-side surface adds ZERO nodes to the graph", () => {
        const a = SIG.signal(1);
        const b = SIG.signal(2);
        const c = SIG.computed(() => a() + b());
        c();
        const before = SIG.stats();

        // Every non-perturbing helper, hammered. None may allocate a reactive
        // link or add an observer. This is devtools' headline contract ("adds
        // zero nodes and zero observers to the graph it inspects") pinned across
        // the whole surface, not just the four helpers the old sweep covered.
        // pendingEffects joins the sweep at 1.6.2 (queue read-out is read-only).
        const gBefore = DT.graph([c]);
        for (let i = 0; i < 25; i++) {
            DT.inspect(c);
            DT.subscribers(a);
            DT.dependencies(c);
            DT.graph([a, b, c]);
            DT.report([a, b, c]);
            DT.toTree(c);
            DT.toDot(gBefore);
            DT.ownerTree(c);
            DT.findPath(a, c);
            DT.serialize(gBefore);
            DT.diff(gBefore, gBefore);
            DT.pendingEffects();
        }
        const after = SIG.stats();

        // Per Studio.js header: "[Studio] adds zero nodes and zero observers
        // to the graph it inspects" -- which is only true if devtools itself
        // doesn't add any. This test pins that across the full read surface.
        assert.equal(after.signals,    before.signals,    "ghost contract: signals delta must be 0");
        assert.equal(after.computeds,  before.computeds,  "ghost contract: computeds delta must be 0");
        assert.equal(after.effects,    before.effects,    "ghost contract: effects delta must be 0");
        assert.equal(after.activeNodes, before.activeNodes, "ghost contract: activeNodes delta must be 0");
        assert.equal(after.activeLinks, before.activeLinks, "ghost contract: activeLinks delta must be 0");

        SIG.dispose(c); SIG.dispose(b); SIG.dispose(a);
    });
});

describe("studio 1.1.0 contract: imports from devtools are fully satisfied", () => {
    it("devtools exports the 10 symbols studio destructures", () => {
        // From Studio.js header:
        //   import {graph, subscribers, dependencies, monitor, track, toDot,
        //           diff, capabilities, watchGraph, leakWatch}
        //           from "@zakkster/lite-devtools";
        const expected = ["graph", "subscribers", "dependencies", "monitor", "track",
                          "toDot", "diff", "capabilities", "watchGraph", "leakWatch"];
        for (const name of expected) {
            assert.equal(typeof DT[name], "function",
                         `studio depends on devtools.${name} -- must be exported as a function`);
        }
    });
});
