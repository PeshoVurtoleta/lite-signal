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
    it("imports resolve and all 19 documented exports are functions", () => {
        const expected = [
            "capabilities", "inspect", "subscribers", "dependencies", "track",
            "monitor", "leakWatch", "report", "graph", "toDot", "toTree", "diff",
            "trace", "ownerTree", "findPath", "watchGraph", "profile",
            "serialize", "deserialize",
        ];
        for (const name of expected) {
            assert.equal(typeof DT[name], "function", `devtools.${name} must be a function`);
        }
    });

    it("capabilities() reports the 1.2.x feature surface (owner tree + mutation hook)", () => {
        const caps = DT.capabilities();
        assert.equal(typeof caps, "object");
        assert.ok(caps !== null);
        assert.equal(caps.owners, true, "1.2.x engine has owner tree");
        assert.equal(caps.mutationHook, true, "1.2.1+ engine has onGraphMutation");
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
