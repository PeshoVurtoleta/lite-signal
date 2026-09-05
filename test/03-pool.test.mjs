// Pool behaviour, capacity policy, registry isolation, destroy semantics.
import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {createRegistry, CapacityError} from "../Signal.js";

describe("CapacityError", () => {
    it("'throw' policy throws on pool exhaustion", () => {
        const r = createRegistry({maxNodes: 4, onCapacityExceeded: "throw"});
        // Each effect+computed+signal consumes 1 node.
        r.signal(0);
        r.signal(0);
        r.signal(0);
        r.signal(0);
        assert.throws(() => r.signal(0), CapacityError);
    });

    it("CapacityError carries kind + capacity", () => {
        const r = createRegistry({maxNodes: 2});
        r.signal(0);
        r.signal(0);
        try {
            r.signal(0);
            assert.fail("expected throw");
        } catch (e) {
            assert.ok(e instanceof CapacityError);
            assert.equal(e.kind, "nodes");
            assert.equal(e.capacity, 2);
            assert.equal(e.name, "CapacityError");
        }
    });

    it("'grow' policy doubles node pool", () => {
        const r = createRegistry({maxNodes: 4, onCapacityExceeded: "grow"});
        for (let i = 0; i < 100; i++) r.signal(i);
        assert.equal(r.stats().signals, 100);
        assert(r.stats().nodePoolCapacity >= 128);
    });

    it("'grow' policy doubles link pool", () => {
        const r = createRegistry({maxNodes: 64, maxLinks: 4, onCapacityExceeded: "grow"});
        const sources = [];
        for (let i = 0; i < 32; i++) sources.push(r.signal(i));
        r.effect(() => { for (const s of sources) s(); });
        assert.equal(r.stats().activeLinks, 32);
        assert(r.stats().linkPoolCapacity >= 32);
    });

    it("'grow' policy still throws past the link ceiling", () => {
        const r = createRegistry({maxNodes: 1024, maxLinks: 4, onCapacityExceeded: "grow"});
        // Ceiling = 4 * 16 = 64. Try to need >64 links.
        const sources = [];
        for (let i = 0; i < 200; i++) sources.push(r.signal(i));
        assert.throws(() => {
            r.effect(() => { for (const s of sources) s(); });
        }, CapacityError);
    });
});

describe("pool reuse", () => {
    it("disposed effect node returns to the pool", () => {
        const r = createRegistry();
        const a = r.signal(0);

        const beforeCap = r.stats().nodePoolCapacity;
        const beforeActive = r.stats().activeNodes;

        for (let cycle = 0; cycle < 10; cycle++) {
            const handles = [];
            for (let i = 0; i < 100; i++) handles.push(r.effect(() => a()));
            for (const d of handles) d();
        }

        assert.equal(r.stats().activeNodes, beforeActive,
            "after balanced create/dispose, active count returns to baseline");
        assert.equal(r.stats().nodePoolCapacity, beforeCap,
            "pool should NOT have grown — recycling works");
    });

    it("disposed effect links go back to the link pool", () => {
        const r = createRegistry();
        const a = r.signal(0);
        const b = r.signal(0);
        const c = r.signal(0);

        const beforeLinkCap = r.stats().linkPoolCapacity;

        for (let cycle = 0; cycle < 50; cycle++) {
            const d = r.effect(() => { a(); b(); c(); });
            assert.equal(r.stats().activeLinks, 3, "one effect reading 3 signals = 3 links");
            d();
            assert.equal(r.stats().activeLinks, 0);
        }
        assert.equal(r.stats().linkPoolCapacity, beforeLinkCap,
            "link pool should NOT have grown over 50 cycles");
    });
});

describe("registry isolation", () => {
    it("two registries do not interfere", () => {
        const r1 = createRegistry();
        const r2 = createRegistry();

        const a1 = r1.signal(1);
        const a2 = r2.signal(100);

        let trace1 = 0, trace2 = 0;
        r1.effect(() => { trace1 = a1(); });
        r2.effect(() => { trace2 = a2(); });

        a1.set(2);
        assert.equal(trace1, 2);
        assert.equal(trace2, 100, "r2 unaffected by writes to r1");

        a2.set(200);
        assert.equal(trace1, 2);
        assert.equal(trace2, 200);
    });
});

describe("destroy()", () => {
    it("clears all state", () => {
        const r = createRegistry();
        const a = r.signal(1);
        r.effect(() => a());
        r.computed(() => a() * 2);
        assert(r.stats().activeNodes > 0);

        r.destroy();
        assert.equal(r.stats().signals, 0);
        assert.equal(r.stats().computeds, 0);
        assert.equal(r.stats().effects, 0);
        assert.equal(r.stats().activeNodes, 0);
        assert.equal(r.stats().activeLinks, 0);
    });

    it("makes outstanding dispose() handles safe no-ops", () => {
        const r = createRegistry();
        const a = r.signal(1);
        const d1 = r.effect(() => a());
        const d2 = r.effect(() => a());

        r.destroy();
        // These must not corrupt the free list.
        assert.doesNotThrow(() => d1());
        assert.doesNotThrow(() => d2());
        assert.doesNotThrow(() => d1()); // double-call after destroy

        // Registry must still be usable.
        const b = r.signal(99);
        let last;
        r.effect(() => { last = b(); });
        assert.equal(last, 99);
        b.set(100);
        assert.equal(last, 100);
    });

    it("registry remains usable after destroy", () => {
        const r = createRegistry();
        const a = r.signal(1);
        r.effect(() => a());
        a.set(2);

        r.destroy();

        const b = r.signal(50);
        const c = r.computed(() => b() * 2);
        assert.equal(c(), 100);
        b.set(5);
        assert.equal(c(), 10);
    });
});

// --- 1.3.0: lazy prealloc + growable pools ---------------------------------
describe("prealloc: lazy (1.3.0)", () => {
    it("destroy() on a never-allocated lazy registry is a clean no-op", () => {
        // Empty-pool teardown path: with nothing ever constructed, both pools
        // are length 0, so destroy() takes the freeHead = null branch rather
        // than rebuilding a free list. Must not throw; stats stay at baseline.
        const r = createRegistry({prealloc: "lazy"});
        assert.equal(r.stats().activeNodes, 0);
        assert.equal(r.stats().activeLinks, 0);
        assert.doesNotThrow(() => r.destroy());
        assert.equal(r.stats().activeNodes, 0);
        assert.equal(r.stats().activeLinks, 0);
        // Still usable afterwards (lazy construction kicks in on first demand).
        const a = r.signal(1);
        const c = r.computed(() => a() * 3);
        assert.equal(c(), 3);
        a.set(4);
        assert.equal(c(), 12);
    });

    it("constructs on demand and reaches the same steady state as eager", () => {
        const r = createRegistry({prealloc: "lazy", maxNodes: 1024, maxLinks: 4096});
        const a = r.signal(2);
        const b = r.signal(3);
        const sum = r.computed(() => a() + b());
        let seen;
        r.effect(() => { seen = sum(); });
        assert.equal(seen, 5);
        a.set(10);
        assert.equal(seen, 13);
        // Active counts reflect exactly what was built; nothing leaked.
        assert.equal(r.stats().signals, 2);
        assert.equal(r.stats().computeds, 1);
        assert.equal(r.stats().effects, 1);
    });
});

describe("onCapacityExceeded: grow (1.3.0)", () => {
    it("extends both pools past the initial ledger without throwing", () => {
        const r = createRegistry({maxNodes: 4, maxLinks: 8, prealloc: "lazy", onCapacityExceeded: "grow"});
        const sigs = [];
        for (let i = 0; i < 40; i++) sigs.push(r.signal(i));
        const c = r.computed(() => sigs.reduce((acc, s) => acc + s(), 0));
        let runs = 0;
        r.effect(() => { c(); runs++; });
        sigs[0].set(1000);
        assert.ok(runs >= 2);
        // Ledger doubled past the initial capacities.
        assert.ok(r.stats().nodePoolCapacity > 4, "node ledger grew");
        assert.ok(r.stats().linkPoolCapacity > 8, "link ledger grew");
    });

    it("link growth is bounded by the maxLinks * 16 ceiling", () => {
        const r = createRegistry({maxNodes: 64, maxLinks: 4, onCapacityExceeded: "grow"});
        // Hard ceiling for links is maxLinks * 16 = 64. A fan-in wider than that
        // must surface a CapacityError("links") rather than growing unbounded.
        assert.throws(() => {
            const leaves = [];
            for (let i = 0; i < 80; i++) leaves.push(r.signal(i));
            r.effect(() => { for (const s of leaves) s(); });
        }, (e) => e instanceof CapacityError && e.kind === "links");
    });
});

// --- 1.4.0: cumulative lifecycle counters on stats() ------------------------
describe("lifecycle counters (1.4.0)", () => {
    it("stats() reports the 14-key 1.6 shape with all counters initially 0", () => {
        const r = createRegistry();
        const s = r.stats();
        const expected = [
            "signals", "computeds", "effects",
            "activeNodes", "activeLinks", "pooledLinks",
            "nodePoolCapacity", "linkPoolCapacity",
            "nodePoolPopulation", "linkPoolPopulation",
            "totalAllocations", "totalDisposals", "poolGrowths",
            "flushPasses"    // 1.6: burst/flush counter (gated on the mutation hook -> zero-cost when detached)
        ];
        const keys = Object.keys(s);
        assert.equal(keys.length, 14, "stats() exposes exactly 14 keys (1.6 base + 1.4.5 population) on 1.6");
        for (const k of expected) {
            assert.ok(k in s, `stats() must expose '${k}'`);
        }
        // Counters start at zero on a fresh registry.
        assert.equal(s.totalAllocations, 0);
        assert.equal(s.totalDisposals, 0);
        assert.equal(s.poolGrowths, 0);
        assert.equal(s.flushPasses, 0);
    });

    it("totalAllocations counts every node acquire (signal, computed, effect)", () => {
        const r = createRegistry();
        assert.equal(r.stats().totalAllocations, 0);
        const a = r.signal(1);
        assert.equal(r.stats().totalAllocations, 1, "after 1 signal");
        const b = r.signal(2);
        assert.equal(r.stats().totalAllocations, 2, "after 2 signals");
        const c = r.computed(() => a() + b());
        c();
        assert.equal(r.stats().totalAllocations, 3, "after adding 1 computed");
        const e = r.effect(() => c());
        assert.equal(r.stats().totalAllocations, 4, "after adding 1 effect");
        // Reading does not allocate; counter must not move.
        a(); b(); c();
        assert.equal(r.stats().totalAllocations, 4, "reads do not increment totalAllocations");
        r.dispose(e); r.dispose(c); r.dispose(b); r.dispose(a);
    });

    it("totalDisposals counts every node dispose", () => {
        const r = createRegistry();
        const a = r.signal(1);
        const b = r.signal(2);
        const c = r.computed(() => a() + b());
        c();
        const e = r.effect(() => c());
        assert.equal(r.stats().totalDisposals, 0, "no disposals yet");
        r.dispose(e);
        assert.equal(r.stats().totalDisposals, 1, "after disposing the effect");
        r.dispose(c);
        assert.equal(r.stats().totalDisposals, 2, "after disposing the computed");
        r.dispose(b);
        r.dispose(a);
        assert.equal(r.stats().totalDisposals, 4, "after disposing both signals");
    });

    it("totalAllocations - totalDisposals === activeNodes across mixed churn", () => {
        const r = createRegistry();
        // Invariant must hold at every quiescent point through a mixed build/teardown.
        const check = (label) => {
            const s = r.stats();
            assert.equal(
                s.totalAllocations - s.totalDisposals,
                s.activeNodes,
                `${label}: alloc(${s.totalAllocations}) - disp(${s.totalDisposals}) === activeNodes(${s.activeNodes})`
            );
        };
        check("start");
        const a = r.signal(1);                          check("after 1 signal");
        const b = r.signal(2);                          check("after 2 signals");
        const c = r.computed(() => a() + b()); c();     check("after adding computed");
        const e = r.effect(() => c());                  check("after adding effect");
        r.dispose(e);                                   check("after disposing effect");
        r.dispose(c);                                   check("after disposing computed");
        // Cycle a few transient signals to exercise the recycle path.
        for (let i = 0; i < 5; i++) {
            const t = r.signal(i);
            r.dispose(t);
        }
        check("after transient signal churn");
        r.dispose(a); r.dispose(b);                     check("after final teardown");
    });

    it("poolGrowths increments when a 'grow' policy crosses the ledger", () => {
        const r = createRegistry({maxNodes: 4, maxLinks: 16, onCapacityExceeded: "grow"});
        assert.equal(r.stats().poolGrowths, 0, "starts at 0");
        // 4 signals fit within the initial ledger -- no growth required.
        const fit = [];
        for (let i = 0; i < 4; i++) fit.push(r.signal(i));
        assert.equal(r.stats().poolGrowths, 0, "still 0 while within initial ledger");
        // 5th signal forces a node-pool growth chunk -> poolGrowths must bump.
        const overflow = r.signal(99);
        assert.ok(r.stats().poolGrowths >= 1, "poolGrowths bumps on first ledger crossing");
        // The grown capacity is reflected in nodePoolCapacity.
        assert.ok(r.stats().nodePoolCapacity > 4, "nodePoolCapacity grew past the initial ledger");
    });

    it("poolGrowths stays 0 on a right-sized eager pool, and destroy() resets all three", () => {
        const r = createRegistry({maxNodes: 128, maxLinks: 512, prealloc: "eager"});
        // Build a graph well within the eager pool -- no growth should occur.
        const sigs = [];
        for (let i = 0; i < 50; i++) sigs.push(r.signal(i));
        const c = r.computed(() => sigs.reduce((acc, s) => acc + s(), 0));
        c();
        r.effect(() => c());
        const before = r.stats();
        assert.equal(before.poolGrowths, 0, "right-sized eager pool: no growth");
        assert.ok(before.totalAllocations > 0, "totalAllocations should be > 0 before destroy");
        // destroy() resets all three cumulative counters.
        r.destroy();
        const after = r.stats();
        assert.equal(after.totalAllocations, 0, "destroy() resets totalAllocations");
        assert.equal(after.totalDisposals, 0, "destroy() resets totalDisposals");
        assert.equal(after.poolGrowths, 0, "destroy() resets poolGrowths");
    });
});
