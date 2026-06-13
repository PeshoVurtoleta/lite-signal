// test/22-mutation-hook.test.mjs — pins for onGraphMutation (1.2.1)
//
// onGraphMutation is the keystone debug hook for push-based tooling
// (lite-devtools 1.1, lite-studio 1.1). Behaviour locked here:
//   - single nullable listener; setting replaces, unsub restores previous
//   - five opcodes: 1 create, 2 dispose, 3 link-add, 4 link-remove, 5 recompute
//   - payload is always (opcode, intA, intB) — no objects, no allocation
//   - fires synchronously inside the mutation point
//   - TypeError on non-function / non-null argument
//   - registered listener is called for cascading disposes too (owner-tree
//     cascade auto-disposes owned children, hook reports each)
//
// CONTRACT: listeners are observe-only -- must not throw, must not mutate.
// We don't test that contract directly (the engine doesn't enforce it; it's
// documented). We do test that the hook is fully isolated from the engine's
// own state (no leakage of mutationHook between registries).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

const OP_NODE_CREATE = 1;
const OP_NODE_DISPOSE = 2;
const OP_LINK_ADD = 3;
const OP_LINK_REMOVE = 4;
const OP_RECOMPUTE = 5;

let r;
beforeEach(() => { r = createRegistry(); });

describe("onGraphMutation: registration", () => {
    it("returns an unsubscribe function", () => {
        const unsub = r.onGraphMutation(() => {});
        assert.equal(typeof unsub, "function", "must return unsubscribe");
        unsub();
    });

    it("accepts null to clear and returns the prior unsub", () => {
        const events = [];
        const a = (op, x, y) => events.push(["A", op, x, y]);
        const unsubA = r.onGraphMutation(a);
        r.signal(1);   // A receives this

        const unsubClear = r.onGraphMutation(null);
        r.signal(2);   // no listener

        unsubClear();  // restores prior (A)
        r.signal(3);   // A receives this again

        assert.equal(events.length, 2, "A received two events (signal 1 and signal 3), not the cleared signal 2");
        unsubA();
    });

    it("throws TypeError when given a non-function, non-null argument", () => {
        assert.throws(() => r.onGraphMutation(42), TypeError);
        assert.throws(() => r.onGraphMutation("hook"), TypeError);
        assert.throws(() => r.onGraphMutation({}), TypeError);
    });

    it("multiple onGraphMutation calls stack: last set wins, unsub restores prior", () => {
        const events = [];
        const a = (op) => events.push(["A", op]);
        const b = (op) => events.push(["B", op]);

        const unsubA = r.onGraphMutation(a);
        r.signal(1);   // A fires

        const unsubB = r.onGraphMutation(b);
        r.signal(2);   // B fires (A replaced)

        unsubB();      // restores A
        r.signal(3);   // A fires again

        unsubA();      // restores null
        r.signal(4);   // nothing fires

        assert.deepEqual(events, [
            ["A", OP_NODE_CREATE],
            ["B", OP_NODE_CREATE],
            ["A", OP_NODE_CREATE],
        ], "stacked register/unregister follows LIFO");
    });

    it("isolated per registry (no cross-talk)", () => {
        const r2 = createRegistry();
        const events1 = [];
        const events2 = [];
        r.onGraphMutation((op) => events1.push(op));
        r2.onGraphMutation((op) => events2.push(op));

        r.signal(1);
        r2.signal(2);

        assert.equal(events1.length, 1, "r received only its own mutation");
        assert.equal(events2.length, 1, "r2 received only its own mutation");
    });
});

describe("onGraphMutation: opcode emission", () => {
    it("emits OP_NODE_CREATE (1) with (id, flags) on signal/computed/effect creation", () => {
        const events = [];
        r.onGraphMutation((op, a, b) => { if (op === OP_NODE_CREATE) events.push([a, b]); });

        const s = r.signal(0);     // FLAG_SIGNAL = 32
        const c = r.computed(() => s());  // FLAG_COMPUTED = 1
        const stop = r.effect(() => { s(); });   // FLAG_EFFECT = 2

        // We can't assert exact IDs (they depend on registry-internal sequence),
        // but we can assert there were exactly 3 create events with the right flag patterns.
        assert.equal(events.length, 3, "3 create events fired");
        const flagsObserved = events.map((e) => e[1]).sort((a, b) => a - b);
        assert.deepEqual(flagsObserved, [1, 2, 32], "flags: computed=1, effect=2, signal=32");
        stop();
    });

    it("emits OP_NODE_DISPOSE (2) with (id, flags) for every node disposed (including cascade)", () => {
        const events = [];
        r.onGraphMutation((op, a, b) => { if (op === OP_NODE_DISPOSE) events.push([a, b]); });

        // Owner tree cascade: an effect creates inner computeds; disposing the effect
        // cascades to dispose the children. Hook reports the parent AND each child.
        const s = r.signal(1);
        const stop = r.effect(() => {
            r.computed(() => s() + 1);
            r.computed(() => s() * 2);
        });

        assert.equal(events.length, 0, "no dispose events yet");
        stop();
        assert.ok(events.length >= 3, "outer effect + 2 inner computeds disposed (>= 3 events)");
    });

    it("emits OP_LINK_ADD (3) with (source.id, target.id) when a dependency is recorded", () => {
        const events = [];
        r.onGraphMutation((op, a, b) => { if (op === OP_LINK_ADD) events.push([a, b]); });

        const s = r.signal(0);
        const sId = r.nodeId(s);
        const c = r.computed(() => s());
        const cId = r.nodeId(c);
        c();    // triggers the link add: source=s, target=c

        // Exactly one OP_LINK_ADD with source=sId, target=cId
        const links = events.filter(([source, target]) => source === sId && target === cId);
        assert.equal(links.length, 1, "exactly one link s->c was added");
    });

    it("emits OP_LINK_REMOVE (4) when a link is freed (dependency change or dispose)", () => {
        const events = [];
        r.onGraphMutation((op, a, b) => { if (op === OP_LINK_REMOVE) events.push([a, b]); });

        // Set up: computed reads two sources, then flips to read only one.
        // The dropped source's link gets freed by severTail.
        const cond = r.signal(true);
        const a = r.signal(10);
        const b = r.signal(20);
        const aId = r.nodeId(a);
        const c = r.computed(() => (cond() ? a() : b()));
        const cId = r.nodeId(c);
        c();   // initial deps: cond, a -- link a->c exists
        assert.equal(events.length, 0, "no removes yet");

        cond.set(false);
        c();   // re-eval: reads cond, then b. a is severed.
        const removedAtoC = events.filter(([source, target]) => source === aId && target === cId);
        assert.ok(removedAtoC.length >= 1, "link a->c was removed when dep set flipped to b");
    });

    it("emits OP_RECOMPUTE (5) with (id, 0) on every effect re-run / computed re-eval", () => {
        const events = [];
        r.onGraphMutation((op, a, b) => { if (op === OP_RECOMPUTE) events.push([a, b]); });

        const s = r.signal(1);
        const c = r.computed(() => s() * 2);
        const cId = r.nodeId(c);
        c();   // computeFn runs the first time (recompute event for cId)
        s.set(2);
        c();   // re-eval; another recompute event

        const recomputesForC = events.filter(([id, payload]) => id === cId && payload === 0);
        assert.ok(recomputesForC.length >= 2, "recompute fired on initial eval and re-eval");
    });

    it("hook fires synchronously inside the mutation point (events arrive before the caller returns)", () => {
        const events = [];
        let seenBeforeReturn = false;
        r.onGraphMutation((op) => { events.push(op); seenBeforeReturn = events.length > 0; });

        r.signal(1);   // sync mutation: by the time signal() returns, event must already be in array
        assert.equal(events.length, 1);
        assert.equal(seenBeforeReturn, true, "listener saw its own event mid-mutation");
    });

    it("payload is always exactly 3 integers (opcode, intA, intB) - no objects", () => {
        const types = new Set();
        r.onGraphMutation((op, a, b) => {
            types.add(typeof op);
            types.add(typeof a);
            types.add(typeof b);
        });
        const s = r.signal(1);
        const c = r.computed(() => s());
        c();
        r.dispose(c);
        r.dispose(s);

        assert.deepEqual([...types], ["number"], "every payload arg is a plain number");
    });
});
