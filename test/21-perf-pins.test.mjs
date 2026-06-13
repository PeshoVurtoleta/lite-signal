// test/21-perf-pins.test.mjs — pins the v1.2.1 construction-shape invariants.
//
// These tests check the STRUCTURAL properties the 1.2.1 release establishes,
// so a future change that silently regresses (drops a gen-guard, mutates the
// signal shape, etc.) is caught at PR time, not at release time.
//
// The pins:
//   1. signal() returns a function with peek/set/update/subscribe + NODE_PTR/
//      NODE_GEN. Six own user props total. Lock the shape so a future
//      "let's move set to a shared method" change has to be explicit.
//   2. computed() returns a function with peek/subscribe + NODE_PTR/NODE_GEN.
//      Four own user props. Lock the shape symmetrically.
//   3. Detached `const {set} = signal()` keeps working (1.x stable feature).
//   4. read() returns undefined and stops tracking after dispose (1.2.1
//      birthGen guard).
//   5. set() is a no-op after dispose -- does NOT scribble on the recycled
//      slot or trigger downstream propagation (1.2.1 birthGen guard, the
//      latent ABA bug fix).
//   6. peek() returns undefined for stale handles (1.2.1 sharedSignalPeek /
//      sharedComputedPeek gen-check).
//
// Note: tests are standard JS only -- no --allow-natives-syntax required.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

const BUILTIN_FN_PROPS = new Set(["length", "name"]);
function userOwnProps(f) {
    const named = Object.getOwnPropertyNames(f).filter((p) => !BUILTIN_FN_PROPS.has(p));
    const sym = Object.getOwnPropertySymbols(f);
    return { named, sym, count: named.length + sym.length };
}

let r;
beforeEach(() => { r = createRegistry(); });

describe("v1.2.1 construction-shape pins", () => {
    it("signal() carries peek/set/update/subscribe + NODE_PTR/NODE_GEN (6 own user props)", () => {
        const s = r.signal(0);
        const { named, sym, count } = userOwnProps(s);
        assert.ok(named.includes("peek"), "signal.peek must be an own prop");
        assert.ok(named.includes("set"), "signal.set must be an own prop (preserves detached extraction)");
        assert.ok(named.includes("update"), "signal.update must be an own prop");
        assert.ok(named.includes("subscribe"), "signal.subscribe must be an own prop");
        assert.equal(sym.length, 2, "signal() must carry exactly 2 internal symbol props (NODE_PTR, NODE_GEN)");
        assert.equal(count, 6, "signal() must have exactly 6 own user props");
    });

    it("computed() carries peek/subscribe + NODE_PTR/NODE_GEN (4 own user props)", () => {
        const a = r.signal(1);
        const c = r.computed(() => a());
        const { named, sym, count } = userOwnProps(c);
        assert.ok(named.includes("peek"), "computed.peek must be an own prop");
        assert.ok(named.includes("subscribe"), "computed.subscribe must be an own prop");
        assert.ok(!named.includes("set"), "computed must NOT have set");
        assert.ok(!named.includes("update"), "computed must NOT have update");
        assert.equal(sym.length, 2, "computed() must carry exactly 2 internal symbol props (NODE_PTR, NODE_GEN)");
        assert.equal(count, 4, "computed() must have exactly 4 own user props");
    });

    it("detached `const {set} = signal()` extraction keeps working on a LIVE signal", () => {
        const s = r.signal(0);
        const { set } = s;
        set(42);
        assert.equal(s(), 42, "detached set() updated the signal");
        assert.strictEqual(s.set, set, "destructured set === the own-prop closure");
    });

    it("read() returns undefined and skips dep tracking on a stale handle (1.2.1 birthGen guard)", () => {
        const s = r.signal(7);
        const live1 = r.computed(() => s());
        assert.equal(live1(), 7);
        r.dispose(s);
        assert.equal(s(), undefined, "read() on disposed signal returns undefined");

        const s2 = r.signal("alpha");
        r.dispose(s2);
        const fresh = r.signal("beta");

        let fires = 0;
        const stop = r.effect(() => { s2(); fires++; });
        assert.equal(fires, 1, "effect ran once on setup");
        fresh.set("gamma");
        assert.equal(fires, 1, "stale read inside an effect must not subscribe to the recycled slot");
        stop();
    });

    it("set() on a stale signal is a no-op (1.2.1 ABA fix)", () => {
        const s1 = r.signal("alice");
        const { set: staleSetA } = s1;
        r.dispose(s1);
        staleSetA("MUTATED");
        assert.equal(s1(), undefined, "disposed slot's value must not be mutated by stale set");

        const s2 = r.signal("original");
        const { set: staleSetB } = s2;
        r.dispose(s2);
        const s3 = r.signal("new resident");
        staleSetB("ZOMBIE WRITE");
        assert.equal(s3(), "new resident", "recycled signal slot must not be corrupted by stale set");

        const s4 = r.signal(0);
        const { set: staleSetC } = s4;
        r.dispose(s4);
        const live = r.signal("LIVE");
        let effectFires = 0;
        const stop = r.effect(() => { live(); effectFires++; });
        assert.equal(effectFires, 1);
        staleSetC("STALE PROPAGATION");
        assert.equal(effectFires, 1, "stale set must not trigger downstream effects on a recycled slot");
        assert.equal(live(), "LIVE", "live signal must not be corrupted by stale set on a recycled slot");
        stop();
    });

    it("peek() returns undefined for stale handles (1.2.1 sharedSignalPeek / sharedComputedPeek gen check)", () => {
        const s = r.signal("alive");
        assert.equal(s.peek(), "alive");
        r.dispose(s);
        assert.equal(s.peek(), undefined, "peek() on disposed signal must return undefined");

        const a = r.signal("first");
        r.dispose(a);
        const b = r.signal("second");
        assert.equal(b.peek(), "second");
        assert.equal(a.peek(), undefined, "peek() through stale handle to recycled slot must be undefined");

        const sigC = r.signal(1);
        const c = r.computed(() => sigC() * 2);
        assert.equal(c.peek(), 2);
        r.dispose(c);
        assert.equal(c.peek(), undefined, "peek() on disposed computed must return undefined");
    });
});
