// 104-destroy-release.test.mjs -- destroy() true shutdown: INDEPENDENT ORACLE (b159, batch B2).
// Oracle: .handoff/PLAN-C-RESET.md ASSERTIONS A5 (destroy half) + ADDENDUM 1 D-2 / D-3. Constructor values (maxNodes 256
// -> nodes 256 / links 1024; defaults 1024 / 4096; prealloc "lazy" maxNodes 512 -> ledger 512 / 2048, population 0,
// first allocation seats a 256 chunk) were probed on .handoff/b159-before/Signal.js. Rows that pass on the before-build
// are regression pins and say so. Retention rows need `node --expose-gc` (skipped otherwise).
// b161 r4: link-capacity rebase row = REVIEW-B1-r3 B-6 (test/103) / B-7 (test/104).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLeakTracker } from "@zakkster/lite-leak";
import { createRegistry } from "../Signal.js";

const HAVE_GC = typeof globalThis.gc === "function";
const nap = (ms) => new Promise((res) => setTimeout(res, ms));
const settle = async () => { globalThis.gc(); await nap(0); globalThis.gc(); };

function grown() {
    const r = createRegistry({ maxNodes: 256, onCapacityExceeded: "grow" });
    for (let i = 0; i < 2048; i++) r.signal(i);
    return r;
}

describe("A5/D-2 destroy() releases both pools", () => {
    test("precondition: growth to 2048 nodes (capacity 2048, 3 growths, population 2048)", () => {
        const s = grown().stats();
        assert.equal(s.nodePoolCapacity, 2048);
        assert.equal(s.nodePoolPopulation, 2048);
        assert.equal(s.poolGrowths, 3);
        assert.equal(s.activeNodes, 2048);
    });
    test("populations are 0 / 0 after destroy", () => {
        const r = grown();
        r.destroy();
        assert.equal(r.stats().nodePoolPopulation, 0);
        assert.equal(r.stats().linkPoolPopulation, 0);
    });
    test("capacities return to the constructor values 256 / 1024", () => {
        const r = grown();
        r.destroy();
        assert.equal(r.stats().nodePoolCapacity, 256);
        assert.equal(r.stats().linkPoolCapacity, 1024);
    });
    test("link pool grown to 16384 -> destroy rebases linkPoolCapacity to 1024 (nodePoolCapacity 256)", () => {
        const r = createRegistry({ maxNodes: 256, maxLinks: 1024, onCapacityExceeded: "grow" });
        const s = r.signal(0);
        const C = [];
        for (let i = 0; i < 200; i++) { const a = r.signal(i); C.push(r.computed(() => s() + a() + s() * 0)); }
        for (const c of C) c();
        for (let i = 0; i < 40; i++) r.effect(() => { for (const c of C) c(); });
        assert.equal(r.stats().linkPoolCapacity, 16384);
        assert.equal(r.stats().activeLinks, 8400);
        r.destroy();
        assert.equal(r.stats().linkPoolCapacity, 1024);
        assert.equal(r.stats().nodePoolCapacity, 256);
    });
    test("full stats after destroy: gauges and counters 0, pooledLinks == link capacity", () => {
        const r = grown();
        assert.equal(r.destroy(), undefined);
        assert.deepEqual(r.stats(), {
            signals: 0, computeds: 0, effects: 0, activeLinks: 0,
            pooledLinks: 1024, linkPoolCapacity: 1024, nodePoolCapacity: 256,
            nodePoolPopulation: 0, linkPoolPopulation: 0,
            activeNodes: 0, totalAllocations: 0, totalDisposals: 0, poolGrowths: 0,
        });
    });
    test("default registry: populations 0 / 0, capacities 1024 / 4096 after destroy", () => {
        const r = createRegistry();
        r.signal(1);
        r.destroy();
        const s = r.stats();
        assert.equal(s.nodePoolPopulation, 0);
        assert.equal(s.linkPoolPopulation, 0);
        assert.equal(s.nodePoolCapacity, 1024);
        assert.equal(s.linkPoolCapacity, 4096);
    });
    test("prealloc lazy maxNodes 512: after growth + destroy capacity 512 / 2048, populations 0 / 0", () => {
        const r = createRegistry({ prealloc: "lazy", maxNodes: 512, onCapacityExceeded: "grow" });
        for (let i = 0; i < 300; i++) r.signal(i);
        r.destroy();
        const s = r.stats();
        assert.equal(s.nodePoolCapacity, 512);
        assert.equal(s.linkPoolCapacity, 2048);
        assert.equal(s.nodePoolPopulation, 0);
        assert.equal(s.linkPoolPopulation, 0);
    });
    test("explicit maxLinks 300 / maxNodes 512 survive a destroy as the ledger values", () => {
        const r = createRegistry({ maxNodes: 512, maxLinks: 300, onCapacityExceeded: "grow" });
        r.signal(1);
        r.destroy();
        assert.equal(r.stats().nodePoolCapacity, 512);
        assert.equal(r.stats().linkPoolCapacity, 300);
        assert.equal(r.stats().nodePoolPopulation, 0);
        assert.equal(r.stats().linkPoolPopulation, 0);
    });
    test("destroyed registry stays usable and regrows lazily: a later signal() works, nodePoolPopulation === 256", () => {
        const r = grown();
        r.destroy();
        const s = r.signal(41);
        assert.equal(s(), 41);
        s.set(42);
        assert.equal(s(), 42);
        assert.equal(r.stats().nodePoolPopulation, 256);
        assert.equal(r.stats().nodePoolCapacity, 256);
        assert.equal(r.stats().activeNodes, 1);
        assert.equal(r.stats().totalAllocations, 1);
    });
    test("destroyed registry runs a full effect/computed graph again", () => {
        const r = grown();
        r.destroy();
        const a = r.signal(1), c = r.computed(() => a() * 2);
        const seen = [];
        r.effect(() => { seen.push(c()); });
        a.set(5);
        assert.deepEqual(seen, [2, 10]);
        assert.equal(r.stats().linkPoolPopulation > 0, true);
    });
    test("handles issued before destroy are dead (read undefined, set no-op)", () => {
        const r = createRegistry();
        const s = r.signal(1);
        r.destroy();
        assert.equal(s(), undefined);
        s.set(2);
        assert.equal(s(), undefined);
    });
});

describe("D-3 destroy() runs no cleanups, fires no op 2, clears the onGraphMutation stack", () => {
    function fixture() {
        const r = createRegistry();
        const ev = [], cleanups = [], disc = [];
        const off = r.onGraphMutation((op, a, b) => { ev.push([op, a, b]); });
        const a = r.signal(1);
        r.effect(() => { a(); r.onCleanup(() => { cleanups.push("e"); }); });
        r.observeObservers(a, { onDisconnect() { disc.push("a"); } });
        ev.length = 0;
        return { r, ev, cleanups, disc, off };
    }
    test("no cleanup ran (cleanups === [])", () => {
        const f = fixture();
        f.r.destroy();
        assert.deepEqual(f.cleanups, []);
    });
    test("no onDisconnect ran", () => {
        const f = fixture();
        f.r.destroy();
        assert.deepEqual(f.disc, []);
    });
    test("no op 2 fired (full event list during destroy is empty)", () => {
        const f = fixture();
        f.r.destroy();
        assert.deepEqual(f.ev, []);
    });
    test("the old listener is cleared: a signal() after destroy does not reach it", () => {
        const f = fixture();
        f.r.destroy();
        f.r.signal(1);
        assert.deepEqual(f.ev, []);
    });
    test("a held off() is a no-op afterwards and does not disturb a newer listener", () => {
        const f = fixture();
        f.r.destroy();
        const ev2 = [];
        f.r.onGraphMutation((op, a, b) => { ev2.push([op, a, b]); });
        assert.equal(f.off(), undefined);
        f.r.signal(1);
        assert.deepEqual(ev2, [[1, 3, 32]]);
        assert.deepEqual(f.ev, []);
    });
    test("listener registered after destroy sees the next op 1 with continuing id (probed: nodeSeq not reset)", () => {
        const r = createRegistry();
        r.signal(1); r.signal(2);
        r.destroy();
        const ev = [];
        r.onGraphMutation((op, a, b) => { ev.push([op, a, b]); });
        r.signal(3);
        assert.deepEqual(ev, [[1, 3, 32]]);
    });
});

describe("A5 retention after destroy (lite-leak tracker, needs --expose-gc)", () => {
    // Tracked values / closures are created inside a helper so no test frame holds the last one.
    function populate(r, tracker) {
        for (let i = 0; i < 2048; i++) {
            const v = { i };
            tracker.track(v, null, i);
            r.signal(v);
        }
        for (let i = 0; i < 128; i++) {
            const cl = { i: -i };
            tracker.track(cl, null, 5000 + i);
            r.effect(() => { r.onCleanup(() => cl); });
        }
    }
    test("destroy() after growth to 2048 nodes: tracker.size() === 0 after gc", { skip: !HAVE_GC }, async () => {
        const r = createRegistry({ maxNodes: 256, onCapacityExceeded: "grow" });
        const tracker = createLeakTracker({ name: "t104", onLeak() {}, onWarning() {} });
        populate(r, tracker);
        r.destroy();
        for (let i = 0; i < 30 && tracker.size() > 0; i++) { await settle(); await nap(10); }
        assert.equal(tracker.size(), 0);
        assert.equal(r.stats().nodePoolPopulation, 0);
        assert.equal(r.signal(1)(), 1);
        assert.equal(r.stats().nodePoolPopulation, 256);
    });
});

describe("A11 L2 destroy drops the free chain (nextFree)", () => {
    // WeakRef on each handle's internal node. 2048 signals, all disposed (free chain), newest handle held, destroy, gc:
    // exactly the held handle's node stays alive. Without the nextFree clear the held node reaches all 2048 (probe
    // .handoff/b159-evidence/b1-review/m7probe.mjs: 2048 on base and on mutant M7).
    function build(r) {
        const refs = [];
        const hs = [];
        for (let i = 0; i < 2048; i++) hs.push(r.signal(i));
        const ptr = Object.getOwnPropertySymbols(hs[0]).find((s) => typeof hs[0][s] === "object");
        for (const h of hs) refs.push(new WeakRef(h[ptr]));
        for (const h of hs) r.dispose(h);
        return { refs, held: hs[2047] };
    }
    test("exactly 1 node alive after destroy + gc with the newest disposed handle held", { skip: !HAVE_GC }, async () => {
        const r = createRegistry({ maxNodes: 256, onCapacityExceeded: "grow" });
        const { refs, held } = build(r);
        r.destroy();
        let alive = refs.length;
        for (let i = 0; i < 30 && alive > 1; i++) {
            await settle(); await nap(10);
            alive = 0; for (const w of refs) if (w.deref() !== undefined) alive++;
        }
        assert.equal(typeof held, "function");
        assert.equal(alive, 1);
    });
});
