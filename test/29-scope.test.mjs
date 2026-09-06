import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, computed, effect, createScope, dispose, describe, stats } from "../Signal.js";

test("createScope: returns fn result, owner runs once, inner effects track + are owned", () => {
    const ext = signal(1);
    const base = stats();
    let runs = 0, innerVal, scopeDispose;

    const ret = createScope((d) => {
        scopeDispose = d;
        runs++;
        ext();                                  // DIRECT read in fn body -> must be untracked
        const localSig = signal(10);            // signal: engine never owner-adopts these
        const c = computed(() => ext() * 2);     // computed: owned by the scope, tracks ext
        effect(() => { innerVal = c(); });       // effect: owned, tracks c
        return "RESULT";
    });

    assert.equal(ret, "RESULT");                 // returns whatever fn returns
    assert.equal(runs, 1);
    assert.equal(innerVal, 2);                   // inner effect ran (ext=1 -> c=2)

    const created = stats();
    assert.equal(created.activeNodes - base.activeNodes, 4, "owner-effect + inner-effect + computed + signal");
    assert.equal(created.effects - base.effects, 2, "owner effect + inner effect both counted");
    assert.equal(created.computeds - base.computeds, 1);
    assert.equal(created.signals - base.signals, 1);

    // owner never re-runs on ext change (its direct read was untracked); inner effect DOES
    ext.set(5);
    assert.equal(runs, 1, "scope owner did not re-run");
    assert.equal(innerVal, 10, "inner effect re-ran: 5*2");

    // dispose cascades the owned computed + effect (and the owner); the un-adopted signal remains
    scopeDispose();
    const after = stats();
    assert.equal(after.effects - base.effects, 0, "both effects cascade-disposed");
    assert.equal(after.computeds - base.computeds, 0, "computed cascade-disposed");
    assert.equal(after.signals - base.signals, 1, "un-adopted signal survives (engine never owns signals)");
    assert.equal(after.activeNodes - base.activeNodes, 1, "only the un-adopted signal remains");

    // disposed inner effect no longer fires
    const frozen = innerVal;
    ext.set(99);
    assert.equal(innerVal, frozen, "disposed inner effect does not re-run");

    // the pinned stats invariant still holds
    assert.equal(after.totalAllocations - after.totalDisposals, after.activeNodes,
        "totalAllocations - totalDisposals === activeNodes");

    dispose(ext);
});

test("createScope: scope created inside a consumer effect SURVIVES the consumer's re-run", () => {
    // This is the property a list/scene reconciler relies on: per-item scopes are
    // created from inside the reconcile driver effect, and must NOT be cascade-disposed
    // when the driver re-runs.
    const ext = signal(0);
    const trigger = signal(0);
    let consumerRuns = 0, innerRuns = 0, scopeDispose;

    const stopConsumer = effect(() => {
        trigger();                               // consumer tracks trigger
        consumerRuns++;
        if (consumerRuns === 1) {
            createScope((d) => {
                scopeDispose = d;
                effect(() => { ext(); innerRuns++; });   // inner effect in the detached scope
            });
        }
    });

    assert.equal(consumerRuns, 1);
    const innerAtCreate = innerRuns;             // ran once

    trigger.set(1);                               // re-run the consumer
    assert.equal(consumerRuns, 2, "consumer re-ran");

    ext.set(123);                                 // would do nothing if the scope had been cascade-disposed
    assert.ok(innerRuns > innerAtCreate, "detached scope's inner effect survived the consumer re-run and still fires");

    scopeDispose();
    const before = innerRuns;
    ext.set(456);
    assert.equal(innerRuns, before, "after scope dispose, the inner effect is gone");
    stopConsumer();
    dispose(ext); dispose(trigger);
});

test("createScope: dispose is idempotent and introspection-stamped", () => {
    const base = stats();
    let scopeDispose;
    createScope((d) => { scopeDispose = d; effect(() => {}); });
    const desc = describe(scopeDispose);          // stamp must resolve the disposer to the owner effect
    assert.ok(desc && desc.kind === "effect", "scope disposer is introspection-stamped to its owner effect");
    scopeDispose();
    const afterFirst = stats().activeNodes;
    scopeDispose();                               // second call: no-op, no throw
    assert.equal(stats().activeNodes, afterFirst, "double-dispose is a safe no-op");
    assert.equal(stats().activeNodes - base.activeNodes, 0, "scope fully torn down");
});

test("smoke: signal -> computed -> effect still reacts (additive change didn't break the engine)", () => {
    const a = signal(2);
    const b = computed(() => a() + 1);
    let seen;
    const stop = effect(() => { seen = b(); });
    assert.equal(seen, 3);
    a.set(9);
    assert.equal(seen, 10);
    stop(); dispose(a);
});
