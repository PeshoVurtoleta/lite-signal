// 13-owner-lazy-alloc.test.mjs — regression guard for the owner-adoption rule (1.2).
//
// Contract: a signal allocated lazily INSIDE a computed/effect must NOT be adopted by
// that owner, and therefore must NOT be disposed when the owner re-runs. Every lazy-
// allocation library depends on this — lite-store allocates a key's signal on first
// read (inside the reading computed), and lite-form allocates lazy fields the same way.
// Observers (computed/effect) MUST still be adopted and auto-disposed.
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

let r;
beforeEach(() => {
    r = createRegistry();
});

describe("owner adoption: plain signals are never owner-adopted", () => {
    it("a signal created inside a computed survives that computed's re-run", () => {
        const ext = r.signal(0);
        let inner = null;
        const c = r.computed(() => {
            ext();
            if (!inner) inner = r.signal(100);
            return inner();
        });
        let out;
        const w = r.effect(() => {
            out = c();
        });
        assert.equal(out, 100);
        ext.set(1);                                   // c re-runs
        assert.equal(inner(), 100, "inner was wiped by the owner re-run");
        inner.set(200);
        ext.set(2);
        assert.equal(c(), 200);
        w();
    });

    it("a signal created inside an effect survives that effect's re-run", () => {
        const ext = r.signal(0);
        let inner = null, seen;
        const w = r.effect(() => {
            ext();
            if (!inner) inner = r.signal(7);
            seen = inner();
        });
        assert.equal(seen, 7);
        inner.set(9);
        ext.set(1);
        assert.equal(seen, 9, "effect re-run disposed its lazily-created signal");
        w();
    });

    it("sibling lazy signals don't cross-wire under a short-circuit diamond (the lite-store shape)", () => {
        const ea = r.signal(""), eb = r.signal("");
        let sa = null, sb = null;
        const rea = r.computed(() => {
            ea();
            if (!sa) sa = r.signal("a0");
            return sa();
        });
        const reb = r.computed(() => {
            eb();
            if (!sb) sb = r.signal("b0");
            return sb();
        });
        const sink = r.computed(() => {
            if (rea() === "STOP") return "x";
            return reb();
        });
        let v;
        const w = r.effect(() => {
            v = sink();
        });
        ea.set("go");
        eb.set("go");                   // force both to allocate
        sa.set("A");
        sb.set("B");
        assert.equal(sa(), "A");
        assert.equal(sb(), "B", "lazy sibling signals cross-wired through the node pool");
        w();
    });
});

describe("owner adoption: observers ARE still auto-disposed", () => {
    it("nested effects are disposed on the outer's re-run (no accumulation)", () => {
        const a = r.signal(0), b = r.signal(0);
        let innerRuns = 0;
        const w = r.effect(() => {
            a();
            r.effect(() => {
                b();
                innerRuns++;
            });
        });
        const base = innerRuns;
        b.set(1);
        assert.ok(innerRuns > base, "live inner responds to b");
        a.set(1);                                     // outer re-runs → old inner disposed, new created
        const beforeB2 = innerRuns;
        b.set(2);
        assert.equal(innerRuns - beforeB2, 1, "exactly one live inner — old ones were disposed");
        w();
    });
});
