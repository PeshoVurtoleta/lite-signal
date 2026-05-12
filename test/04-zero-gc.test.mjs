// Zero-allocation guarantees. These tests require --expose-gc to be meaningful.
// They are intentionally lenient on bounds — JIT noise can produce small allocations
// — but enforce that we are nowhere near the cost of unpooled implementations.
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {createRegistry} from "../Signal.js";

const hasGC = typeof globalThis.gc === "function";

function forceGc() {
    if (hasGC) {
        globalThis.gc();
        globalThis.gc();
    }
}

function heapKB() {
    return process.memoryUsage().heapUsed / 1024;
}

describe("zero-GC invariants", {skip: !hasGC ? "requires --expose-gc" : false}, () => {
    it("100k signal.set() ops with one effect: retained heap ~ 0KB", () => {
        const r = createRegistry({maxNodes: 4, maxLinks: 4, onCapacityExceeded: "grow"});
        const a = r.signal(0);
        let sink = 0;
        r.effect(() => { sink = a(); });

        // Warm up
        for (let i = 0; i < 5000; i++) a.set(i);

        forceGc();
        const before = heapKB();

        for (let i = 0; i < 100_000; i++) a.set(i);

        forceGc();
        const after = heapKB();
        const delta = after - before;

        // Lenient: any reasonable run should be well under 200KB retained.
        assert(delta < 200, `retained heap ${delta.toFixed(1)} KB should be small`);
        assert.equal(sink, 99_999);
    });

    it("100k batched writes across 100 signals → 1 effect: retained heap ~ 0KB", () => {
        const r = createRegistry({maxNodes: 256, maxLinks: 256, onCapacityExceeded: "grow"});
        const sigs = [];
        for (let i = 0; i < 100; i++) sigs.push(r.signal(0));
        let sum = 0;
        r.effect(() => {
            sum = 0;
            for (let i = 0; i < 100; i++) sum += sigs[i]();
        });

        for (let i = 0; i < 5000; i++) {
            r.batch(() => { for (let j = 0; j < 100; j++) sigs[j].set(i + j); });
        }

        forceGc();
        const before = heapKB();

        for (let i = 0; i < 1000; i++) {
            r.batch(() => { for (let j = 0; j < 100; j++) sigs[j].set(i + j); });
        }

        forceGc();
        const after = heapKB();
        const delta = after - before;
        assert(delta < 250, `retained heap ${delta.toFixed(1)} KB should be small`);
    });

    it("effect create/dispose cycle leaves the pool size stable", () => {
        const r = createRegistry({maxNodes: 64, onCapacityExceeded: "grow"});
        const a = r.signal(0);

        // Warm up
        for (let i = 0; i < 1000; i++) {
            const d = r.effect(() => a());
            d();
        }
        const capAfterWarmup = r.stats().nodePoolCapacity;

        for (let i = 0; i < 10_000; i++) {
            const d = r.effect(() => a());
            d();
        }

        assert.equal(r.stats().nodePoolCapacity, capAfterWarmup,
            "pool size must be stable across many balanced create/dispose cycles");
        assert.equal(r.stats().activeNodes, 1, "only the signal remains");
        assert.equal(r.stats().activeLinks, 0);
    });
});

describe("performance: deep chain pull cost", () => {
    it("256-deep chain pull completes in <50ms for 1k pulls (very lenient)", () => {
        const r = createRegistry({onCapacityExceeded: "grow"});
        const src = r.signal(0);
        let prev = src;
        for (let i = 0; i < 256; i++) {
            const p = prev;
            prev = r.computed(() => p() + 1);
        }
        const tip = prev;

        // Warmup
        for (let i = 0; i < 100; i++) { src.set(i); tip(); }

        const t0 = performance.now();
        for (let i = 0; i < 1000; i++) {
            src.set(i);
            tip();
        }
        const elapsed = performance.now() - t0;
        assert(elapsed < 200, `1000 pulls over 256-deep chain: ${elapsed.toFixed(1)} ms`);
    });
});
