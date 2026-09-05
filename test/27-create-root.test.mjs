// 27-create-root.test.mjs -- the 1.5.0 ownership escape hatch. createRoot(fn) runs
// fn in a detached scope: effects/computeds created directly in fn are NOT adopted by
// the enclosing owner (so they survive its re-runs/disposal), and reads in fn's direct
// body do not link the enclosing observer. Inner effect/computed bodies still establish
// their own scopes. This is the exact pattern lite-query's lazy query-watcher uses.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("createRoot (1.5.0)", () => {
    it("a watcher spawned inside a consumer effect via createRoot survives the consumer's re-run", () => {
        const trigger = r.signal(0);
        const watched = r.signal(0);
        let watcherRuns = 0;
        let disposer;
        const stopConsumer = r.effect(() => {
            trigger();                       // consumer depends on `trigger`
            if (disposer === undefined) {
                // Lazily spawn a long-lived watcher, detached from this consumer's ownership.
                disposer = r.createRoot(() => r.effect(() => { watcherRuns++; watched(); }));
            }
        });
        assert.equal(watcherRuns, 1, "watcher ran once on creation");

        trigger.set(1);                      // consumer re-runs; without createRoot this would dispose the watcher
        watched.set(1);
        assert.equal(watcherRuns, 2, "detached watcher survived the re-run and still fires");

        disposer();                          // caller owns the lifecycle
        watched.set(2);
        assert.equal(watcherRuns, 2, "explicit disposer stops the detached watcher");
        stopConsumer();
    });

    it("WITHOUT createRoot, a spawned effect is cascade-disposed on the consumer's re-run (the footgun)", () => {
        const trigger = r.signal(0);
        const watched = r.signal(0);
        let watcherRuns = 0;
        let spawned = false;
        r.effect(() => {
            trigger();
            if (!spawned) { spawned = true; r.effect(() => { watcherRuns++; watched(); }); }
        });
        assert.equal(watcherRuns, 1);

        trigger.set(1);                      // consumer re-runs -> cascade-disposes the OWNED watcher
        watched.set(1);
        assert.equal(watcherRuns, 1, "owned watcher was cascade-disposed and no longer fires");
    });

    it("returns whatever fn returns", () => {
        assert.equal(r.createRoot(() => 42), 42);
        const d = r.createRoot(() => r.effect(() => {}));
        assert.equal(typeof d, "function", "returns the inner effect's disposer");
        d();
    });

    it("detaches tracking: a read in fn's direct body does not link the enclosing observer", () => {
        const dep = r.signal(0);
        let outerRuns = 0;
        r.effect(() => {
            outerRuns++;
            r.createRoot(() => { dep(); });  // read directly in fn's body, not in an inner effect
        });
        assert.equal(outerRuns, 1);
        dep.set(1);                          // if tracking leaked, the outer effect would re-run
        assert.equal(outerRuns, 1, "outer effect did not re-run -> the read was untracked");
    });

    it("inner effect bodies inside createRoot still track their own dependencies", () => {
        const dep = r.signal(0);
        let innerRuns = 0;
        const d = r.createRoot(() => r.effect(() => { innerRuns++; dep(); }));
        assert.equal(innerRuns, 1);
        dep.set(1);
        assert.equal(innerRuns, 2, "inner effect tracked dep and re-ran");
        d();
    });

    it("works with box handles too (createRoot + computedBox watcher)", () => {
        const src = r.signalBox(1);
        let seen = [];
        const d = r.createRoot(() => {
            const doubled = r.computedBox(() => src.get() * 2);
            return doubled.subscribe(v => seen.push(v));
        });
        assert.deepEqual(seen, [2]);
        src.set(5);
        assert.deepEqual(seen, [2, 10], "detached box watcher still fires");
        d();
        src.set(9);
        assert.deepEqual(seen, [2, 10], "disposed after teardown");
    });

    it("top-level createRoot binds to the default registry", async () => {
        const top = await import("../Signal.js");
        const trigger = top.signal(0);
        let runs = 0;
        const disposer = top.createRoot(() => top.effect(() => { runs++; trigger(); }));
        assert.equal(runs, 1, "detached effect ran once on creation");
        trigger.set(1);
        assert.equal(runs, 2, "detached effect tracked its dep");
        disposer();
        trigger.set(2);
        assert.equal(runs, 2, "disposer stopped the detached effect");
        top.dispose(trigger);
    });
});
