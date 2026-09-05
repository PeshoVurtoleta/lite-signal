// Real lite-devtools 1.1.0 boot against the 1.3.0 engine.
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

describe("lite-devtools 1.1.0 boots against the 1.3.0 engine", () => {
    it("imports resolve and the documented 1.2.0 export surface (21 functions) is exactly present", () => {
        const expected = [
            "capabilities", "inspect", "subscribers", "dependencies", "track",
            "monitor", "leakWatch", "report", "graph", "toDot", "toTree", "diff",
            "trace", "ownerTree", "findPath", "watchGraph", "profile",
            "serialize", "deserialize",
            // 1.2.0:
            "burstProfile", "watchAllocations",
        ];
        for (const name of expected) {
            assert.equal(typeof DT[name], "function", `devtools.${name} must be a function`);
        }
        // Surface-drift pin: any NEW exported function must be added to `expected`
        // above, or this test fails fast -- accidental new public surface is a
        // versioning concern that needs a doc + capabilities() entry.
        const actualFns = Object.keys(DT).filter((k) => typeof DT[k] === "function").sort();
        const expectedSorted = expected.slice().sort();
        assert.deepEqual(actualFns, expectedSorted,
            "devtools function-export set must match `expected` exactly; update both lists together");
    });

    it("capabilities() reports the 1.6.x feature surface (owners + mutationHook + burst)", () => {
        const caps = DT.capabilities();
        assert.equal(typeof caps, "object");
        assert.ok(caps !== null);
        assert.equal(caps.owners, true, "1.2.x+ engine has owner tree");
        assert.equal(caps.mutationHook, true, "1.2.1+ engine has onGraphMutation");
        assert.equal(caps.burst, true, "1.6+ engine has opcodes 6/7 + stats().flushPasses");
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

    it("monitor() returns an object usable by devtools UIs", () => {
        const m = DT.monitor();
        assert.ok(m !== null && typeof m === "object");
    });

    it("leakWatch() registers and stops cleanly without leaking the timer", () => {
        const watch = DT.leakWatch({ sampleMs: 50, growth: 1, onSample: () => {} });
        assert.equal(typeof watch, "object");
        assert.equal(typeof watch.stop, "function");
        watch.stop();   // CRITICAL: clears the setInterval handle
    });

    it("track() registers a lifecycle listener against a 1.3.0-built handle", () => {
        const s = SIG.signal(0);
        const events = [];
        const untrack = DT.track(s, (e) => events.push(e));
        assert.equal(typeof untrack, "function");
        const e = SIG.effect(() => { s(); });
        SIG.dispose(e);
        untrack();
        SIG.dispose(s);
    });

    it("ghost contract: heavy devtools introspection adds ZERO nodes to the graph", () => {
        const a = SIG.signal(1);
        const b = SIG.signal(2);
        const c = SIG.computed(() => a() + b());
        c();
        const before = SIG.stats();

        for (let i = 0; i < 25; i++) {
            DT.inspect(c);
            DT.subscribers(a);
            DT.dependencies(c);
            DT.graph([c]);
            DT.report([a, b, c]);
            DT.toTree(c);
            DT.ownerTree(c);
        }
        const after = SIG.stats();

        // Per Studio.js header: "[Studio] adds zero nodes and zero observers
        // to the graph it inspects" -- which is only true if devtools itself
        // doesn't add any. This test pins that.
        assert.equal(after.signals,   before.signals,   "ghost contract: signals delta must be 0");
        assert.equal(after.computeds, before.computeds, "ghost contract: computeds delta must be 0");
        assert.equal(after.effects,   before.effects,   "ghost contract: effects delta must be 0");

        SIG.dispose(c); SIG.dispose(b); SIG.dispose(a);
    });

    // ---- 1.2.0 surface ---------------------------------------------------------

    it("burstProfile(): non-null on 1.6+ engine, exposes the documented shape", () => {
        const bp = DT.burstProfile();
        assert.ok(bp !== null, "burstProfile() must not be null on engine with opcodes 6/7");
        assert.equal(typeof bp.stop, "function");
        assert.equal(typeof bp.passes, "function");
        assert.equal(typeof bp.perPass, "function");
        assert.equal(typeof bp.redundant, "function");
        assert.equal(typeof bp.shortCircuited, "function");
        assert.ok(bp.queued instanceof Map);
        assert.ok(bp.ran instanceof Map);
        bp.stop();
    });

    it("burstProfile(): opcodes 5/6/7 flow through hub on a multi-pass write-back", () => {
        // The multiPassProbe pattern from burst-dag.mjs: an effect that writes y
        // when x > 0 forces a second flush pass. Without correct op-6/op-7
        // dispatch the profile would show passes <= 1.
        const x = SIG.signal(0);
        const y = SIG.signal(0);
        const e1 = SIG.effect(() => { x(); y(); });
        const e2 = SIG.effect(() => { if (x() > 0) y.set(y.peek() + 1); });

        const bp = DT.burstProfile();
        x.set(1);                          // triggers pass 1 then a write-back -> pass 2
        const snap = bp.stop();
        assert.ok(snap.passes >= 2, `expected >= 2 flush passes for write-back, got ${snap.passes}`);
        assert.ok(snap.perPass.length >= 2, `perPass should record both passes, got ${JSON.stringify(snap.perPass)}`);
        assert.ok(snap.ran.size > 0, "op-5 (recompute) should have fired");
        assert.ok(snap.queued.size > 0, "op-7 (effect enqueue) should have fired");
        SIG.dispose(e2); SIG.dispose(e1); SIG.dispose(y); SIG.dispose(x);
    });

    it("burstProfile.shortCircuited(): uses `avoided`, not `wasted` (clean-read skip is correct engine behavior)", () => {
        // An effect whose dep version-bumps but whose VALUE is unchanged will
        // be enqueued (op 7) but the clean-read short-circuit skips the actual
        // run (no op 5). That's `avoided`, never `wasted`.
        const a = SIG.signal(1);
        const b = SIG.computed(() => a() === 1 ? "one" : "other");
        const e = SIG.effect(() => { b(); });

        const bp = DT.burstProfile();
        a.set(1);   // no value change -> clean-read short-circuit should engage
        a.set(1);
        const top = bp.shortCircuited(5);
        bp.stop();

        // Field name is the contract; old field `wasted` is forbidden (it mislabels
        // correct engine behavior).
        for (const row of top) {
            assert.equal(typeof row.avoided, "number", "shortCircuited() row must expose `avoided`");
            assert.ok(!("wasted" in row), "row must NOT expose legacy `wasted` field");
        }
        SIG.dispose(e); SIG.dispose(b); SIG.dispose(a);
    });

    it("watchAllocations(): sample shape pins all 10 documented keys", async () => {
        const a = SIG.signal(0);
        const c = SIG.computed(() => a() + 1);
        c();

        const samples = [];
        const ctl = DT.watchAllocations((s) => samples.push(s), {sampleMs: 30});

        // Drive a little work then wait for at least one sample.
        for (let i = 0; i < 50; i++) a.set(i);
        await new Promise((r) => setTimeout(r, 120));
        ctl.stop();

        assert.ok(samples.length >= 1, "expected at least one watchAllocations sample within 120ms");
        const s = samples[samples.length - 1];
        const expectedKeys = [
            "ts", "poolGrowthDelta", "allocDelta", "disposeDelta",
            "flushPassDelta", "recomputeDelta", "activeNodes", "activeLinks",
            "totalAllocations", "poolGrowths",
        ];
        for (const k of expectedKeys) {
            assert.ok(k in s, `watchAllocations sample must include key '${k}'`);
            assert.equal(typeof s[k], "number", `watchAllocations sample.${k} must be a number`);
        }

        SIG.dispose(c); SIG.dispose(a);
    });

    it("watchAllocations() pins the MOAT claim: steady-state reads -> allocDelta=0 + poolGrowthDelta=0", async () => {
        // Build a small chain, warm it, then drive 1000 reads through a settled
        // graph (NO new node creation, NO disposal). The engine's allocation
        // counters MUST stay flat: this is the property Studio's allocation
        // panel exists to display.
        const a = SIG.signal(1);
        const b = SIG.signal(2);
        const sum = SIG.computed(() => a() + b());
        const prod = SIG.computed(() => a() * b());
        const e = SIG.effect(() => { sum(); prod(); });

        // Warm-up.
        for (let i = 0; i < 100; i++) { a.set(i); b.set(i); }

        const samples = [];
        const ctl = DT.watchAllocations((s) => samples.push(s), {sampleMs: 30});

        // Steady-state writes through the warmed graph.
        for (let i = 0; i < 1000; i++) { a.set(i); b.set(i); }
        await new Promise((r) => setTimeout(r, 100));
        ctl.stop();

        // Look at the LAST sample (first-sample skew is a known soft spot;
        // post-warmup the moat claim must hold).
        const tail = samples[samples.length - 1];
        assert.equal(tail.allocDelta, 0,
            `MOAT: steady-state reads must not allocate; got allocDelta=${tail.allocDelta}`);
        assert.equal(tail.poolGrowthDelta, 0,
            `MOAT: settled pool must not grow; got poolGrowthDelta=${tail.poolGrowthDelta}`);

        SIG.dispose(e); SIG.dispose(prod); SIG.dispose(sum); SIG.dispose(b); SIG.dispose(a);
    });

    it("watchAllocations({recomputes:false}): no hook attached, recomputeDelta stays 0", async () => {
        const a = SIG.signal(0);
        const c = SIG.computed(() => a() + 1);
        const e = SIG.effect(() => { c(); });

        const samples = [];
        const ctl = DT.watchAllocations((s) => samples.push(s),
                                        {sampleMs: 30, recomputes: false});

        for (let i = 0; i < 200; i++) a.set(i);
        await new Promise((r) => setTimeout(r, 100));
        ctl.stop();

        assert.ok(samples.length >= 1);
        for (const s of samples) {
            assert.equal(s.recomputeDelta, 0,
                "with recomputes:false, the op-5 hook must NOT be attached -> recomputeDelta stays 0");
        }

        SIG.dispose(e); SIG.dispose(c); SIG.dispose(a);
    });

    it("watchAllocations({recomputes:true}): under load, recomputeDelta climbs (the work line)", async () => {
        const a = SIG.signal(0);
        const c = SIG.computed(() => a() + 1);
        const e = SIG.effect(() => { c(); });

        const samples = [];
        const ctl = DT.watchAllocations((s) => samples.push(s),
                                        {sampleMs: 30, recomputes: true});

        for (let i = 0; i < 500; i++) a.set(i);
        await new Promise((r) => setTimeout(r, 100));
        ctl.stop();

        const totalRecomputes = samples.reduce((sum, s) => sum + s.recomputeDelta, 0);
        assert.ok(totalRecomputes > 0,
            "under 500 source writes, the work line should climb (recomputeDelta sum > 0)");

        SIG.dispose(e); SIG.dispose(c); SIG.dispose(a);
    });

    it("hub cleanup: simultaneous burstProfile + watchAllocations + profile, all stop cleanly", async () => {
        // Hub multiplexing: every consumer adds to hubSubs; last-stop tears down
        // the engine onGraphMutation registration. If a consumer leaks, future
        // tests see phantom mutation traffic.
        const a = SIG.signal(0);
        const c = SIG.computed(() => a() + 1);
        const e = SIG.effect(() => { c(); });

        const bp = DT.burstProfile();
        const allocCtl = DT.watchAllocations(() => {}, {sampleMs: 30, recomputes: true});
        const pf = DT.profile();

        for (let i = 0; i < 100; i++) a.set(i);
        await new Promise((r) => setTimeout(r, 60));

        // Stop in interleaved order; none should throw.
        allocCtl.stop();
        bp.stop();
        pf.stop();
        // Idempotent: double-stop must be a safe no-op.
        allocCtl.stop();
        bp.stop();
        pf.stop();

        SIG.dispose(e); SIG.dispose(c); SIG.dispose(a);
    });

    it("hub: a subscriber that throws does NOT break sibling subscribers", () => {
        // Per Devtools.js comments: "a subscriber that throws here would unwind
        // through engine internals mid-operation". The try/catch in hubDispatch
        // is the guard; this test pins it.
        const a = SIG.signal(0);

        // Two consumers; the first throws on every event.
        const bp = DT.burstProfile();        // counts op 5/6/7
        const bp2 = DT.burstProfile();       // separate counter

        // Stash a profile() too, since its onSample is user-supplied and is the
        // most likely throw site in practice.
        let sawSample = 0;
        const pf = DT.profile({onSample: () => { sawSample++; throw new Error("boom"); }});

        // Drive a write that fires op 5 (recompute) into all three consumers.
        const c = SIG.computed(() => a() + 1);
        const e = SIG.effect(() => { c(); });
        a.set(1);
        a.set(2);

        const snap1 = bp.stop();
        const snap2 = bp2.stop();
        pf.stop();

        assert.ok(sawSample > 0, "the throwing subscriber must have fired before throwing");
        assert.ok(snap1.ran.size > 0,
            "sibling burstProfile #1 must still see op-5 events despite the throwing peer");
        assert.ok(snap2.ran.size > 0,
            "sibling burstProfile #2 must still see op-5 events despite the throwing peer");

        SIG.dispose(e); SIG.dispose(c); SIG.dispose(a);
    });
});

describe("studio 1.2.0 contract: imports from devtools are fully satisfied", () => {
    it("devtools exports the 11 symbols studio destructures (1.2.0 adds watchAllocations)", () => {
        // From Studio.js 1.2.0 header:
        //   import {graph, subscribers, dependencies, monitor, track, toDot,
        //           diff, capabilities, watchGraph, leakWatch, watchAllocations}
        //           from "@zakkster/lite-devtools";
        const expected = ["graph", "subscribers", "dependencies", "monitor", "track",
                          "toDot", "diff", "capabilities", "watchGraph", "leakWatch",
                          "watchAllocations"];
        for (const name of expected) {
            assert.equal(typeof DT[name], "function",
                         `studio depends on devtools.${name} -- must be exported as a function`);
        }
    });
});
