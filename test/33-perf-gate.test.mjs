// Perf gate -- the standing, self-validating zero-GC judge for lite-signal (1.7.0).
//
// WHY THIS EXISTS. lite-signal MEASURES its zero-GC claim in many bespoke lanes
// (04-zero-gc, test/zgc/, 32-devtools-zerogc-probe, the mint-anatomy harness,
// VersionMatrix),
// but nothing JUDGES it with permanent, self-validating controls. This lane wires
// @zakkster/lite-perf-gate (devDependency only) as the standing verdict: five
// signals (scavenges / engine counters / retainedKB / oldGen / arrayBuffersKB),
// two scales (N and k*N), positive+negative+large detector controls on every run,
// and mustFail scenarios that keep the gate honest.
//
// GUARD (see BRIEF, and 04-zero-gc.test.mjs:26 for the resident hasGC pattern).
// zgcSuite() registers UNGUARDED node:test cases and its measure() THROWS without
// --expose-gc; and at the default 16MB semi-space (plain `npm run test:gc`) the
// positive control forces ~5 scavenges against its floor of 6 -> a false red. So
// the gate only executes for real when BOTH --expose-gc AND --max-semi-space-size=4
// are present, i.e. under `npm run test:gate`. Otherwise we emit ONE loud named
// skip (never a silent pass, never an unguarded zgcSuite call).

import {it} from "node:test";
import {zgcSuite} from "@zakkster/lite-perf-gate";
import {createRegistry} from "../Signal.js";

const hasGC = typeof globalThis.gc === "function";
const hasSemi = process.execArgv.includes("--max-semi-space-size=4");
const gateReady = hasGC && hasSemi;

// Warm INSIDE setup so hot() measures steady state. 20k passes takes every hot
// path past its re-track / cache-hit floor before the measurement window opens.
const WARM = 20000;

// Every scenario reads its OWN isolated registry's ledger. Global counters would
// fail closed (a foreign registry's churn would poison the delta), so statsOf is
// per-scenario, pointed at the registry built in that scenario's setup().
function eager(nodes, links) {
    return createRegistry({maxNodes: nodes, maxLinks: links, prealloc: "eager"});
}

// 1. set-propagate -- llms.txt "set O(downstream) zero alloc after warm-up".
//    1 signal -> 8 computeds -> 1 effect; flush is synchronous (no scheduler in
//    the default path), so hot = signal.set() runs the whole cone in-window.
const setPropagate = {
    name: "set-propagate (1 signal -> 8 computeds -> 1 effect, sync flush)",
    setup() {
        const r = eager(128, 256);
        const s = r.signal(0);
        const cs = new Array(8);
        for (let i = 0; i < 8; i++) cs[i] = r.computed(() => s() + i);
        const st = {r, s, cs, sink: 0};
        r.effect(() => {
            let a = 0;
            for (let i = 0; i < 8; i++) a += cs[i]();
            st.sink = a;
        });
        for (let i = 0; i < WARM; i++) s.set(i);
        return st;
    },
    hot(st, n) {
        const s = st.s;
        for (let i = 0; i < n; i++) s.set(i);
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 2. computed-cache-hit -- llms.txt "computed cache hit zero alloc".
//    No dep change between reads: every read is a version-compare short-circuit.
const computedCacheHit = {
    name: "computed-cache-hit (read with no dep change)",
    setup() {
        const r = eager(64, 64);
        const s = r.signal(1);
        const c = r.computed(() => s() + 1);
        const st = {r, c, sink: 0};
        for (let i = 0; i < WARM; i++) st.sink += c();
        return st;
    },
    hot(st, n) {
        const c = st.c;
        let x = 0;
        for (let i = 0; i < n; i++) x += c();
        st.sink = x;
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 3. computed-recompute-stable -- llms.txt "computed recompute with stable dep
//    structure". Set a dep then read: recompute, but the dep SET never changes,
//    so no link is allocated after warm-up.
const computedRecomputeStable = {
    name: "computed-recompute-stable (set dep then read, stable structure)",
    setup() {
        const r = eager(64, 64);
        const s = r.signal(0);
        const c = r.computed(() => s() + 1);
        const st = {r, s, c, sink: 0};
        for (let i = 0; i < WARM; i++) {
            s.set(i);
            st.sink += c();
        }
        return st;
    },
    hot(st, n) {
        // Overwrite (not accumulate): summing c()'s growing return past ~2^30
        // boxes a HeapNumber PER OP in the scenario itself -- a measurement
        // artifact, not the engine. The bounded sink keeps the value a Smi so
        // the only thing measured is the engine's recompute path.
        const s = st.s, c = st.c;
        for (let i = 0; i < n; i++) {
            s.set(i);
            st.sink = c();
        }
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 4. effect-rerun-stable -- llms.txt "effect re-run with stable dep order".
//    One signal -> one effect; each set re-runs the effect, which re-tracks the
//    SAME single dep in the SAME order -> link is reused, nothing allocated.
const effectRerunStable = {
    name: "effect-rerun-stable (set dep so a warmed effect re-runs)",
    setup() {
        const r = eager(64, 64);
        const s = r.signal(0);
        const st = {r, s, sink: 0};
        r.effect(() => { st.sink = s(); });
        for (let i = 0; i < WARM; i++) s.set(i);
        return st;
    },
    hot(st, n) {
        const s = st.s;
        for (let i = 0; i < n; i++) s.set(i);
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 5. peek -- llms.txt "peek O(1) zero alloc". An untracked O(1) read.
const peek = {
    name: "peek (O(1) untracked read)",
    setup() {
        const r = eager(64, 64);
        const s = r.signal(42);
        const st = {r, s, sink: 0};
        for (let i = 0; i < WARM; i++) st.sink += s.peek();
        return st;
    },
    hot(st, n) {
        const s = st.s;
        let x = 0;
        for (let i = 0; i < n; i++) x += s.peek();
        st.sink = x;
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 6. batch-flush -- 3 sets per batch, one synchronous flush at batch end.
//    The batch body is allocated ONCE in setup and reused every op (a per-op
//    closure would be a scenario-side allocation, not an engine one).
const batchFlush = {
    name: "batch-flush (batch of 3 sets, sync flush at batch end)",
    setup() {
        const r = eager(64, 64);
        const a = r.signal(0), b = r.signal(0), c = r.signal(0);
        const st = {r, a, b, c, v: 0, sink: 0};
        r.effect(() => { st.sink = a() + b() + c(); });
        st.body = () => {
            const v = st.v;
            st.a.set(v);
            st.b.set(v + 1);
            st.c.set(v + 2);
        };
        for (let i = 0; i < WARM; i++) { st.v = i; r.batch(st.body); }
        return st;
    },
    hot(st, n) {
        const r = st.r, body = st.body;
        for (let i = 0; i < n; i++) { st.v = i; r.batch(body); }
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// 7. box-set-propagate -- the 1.5.0 box surface (signalBox / computedBox) shares
//    the same read/write hot path. Same shape as set-propagate through boxes.
const boxSetPropagate = {
    name: "box-set-propagate (signalBox -> 8 computedBox -> 1 effect)",
    setup() {
        const r = eager(128, 256);
        const s = r.signalBox(0);
        const cs = new Array(8);
        for (let i = 0; i < 8; i++) { cs[i] = r.computedBox(() => s.get() + i); cs[i].get(); }
        const st = {r, s, cs, sink: 0};
        r.effect(() => {
            let a = 0;
            for (let i = 0; i < 8; i++) a += cs[i].get();
            st.sink = a;
        });
        for (let i = 0; i < WARM; i++) s.set(i);
        return st;
    },
    hot(st, n) {
        const s = st.s;
        for (let i = 0; i < n; i++) s.set(i);
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// mustFail -- permanent negative controls. Each MUST trip the gate; if either
// ever passes, the gate has gone blind and the whole lane is a lie.

// (a) per-op object allocator: {x,y,z,w} into a bounded ring so it escapes and
//     dies young (defeats escape analysis + pretenuring). Trips signal 1
//     (scavenges). Its statsOf reads a live but idle registry so the engine
//     counters stay 0-delta -- the ONLY signal that trips is the honest one.
const mustFailAlloc = {
    name: "MUSTFAIL per-op object allocator ({x,y,z,w})",
    setup() {
        const r = eager(64, 64);
        return {r, ring: new Array(64).fill(null)};
    },
    hot(st, n) {
        const ring = st.ring;
        for (let i = 0; i < n; i++) ring[i & 63] = {x: i, y: i + 1, z: i + 2, w: i + 3};
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

// (b) per-op signal()+dispose churn -- the documented 264 B/op creation path.
//     signal() mints a fresh callable handle every op (the pooled node recycles,
//     the handle does not), so scavenges scale AND totalAllocations climbs by n.
//     It is the documented non-zero path, which is exactly what makes it a
//     truthful control.
const mustFailChurn = {
    name: "MUSTFAIL signal()+dispose churn (264 B/op)",
    setup() {
        const r = createRegistry({maxNodes: 64, maxLinks: 64, prealloc: "eager", onCapacityExceeded: "grow"});
        return {r};
    },
    hot(st, n) {
        const r = st.r;
        for (let i = 0; i < n; i++) {
            const s = r.signal(0);
            r.dispose(s);
        }
    },
    statsOf: (st) => st.r.stats(),
    teardown: (st) => st.r.destroy(),
};

if (!gateReady) {
    it("perf gate", {skip: "requires npm run test:gate (node --expose-gc --max-semi-space-size=4)"}, () => {});
} else {
    zgcSuite({
        scenarios: [
            setPropagate,
            computedCacheHit,
            computedRecomputeStable,
            effectRerunStable,
            peek,
            batchFlush,
            boxSetPropagate,
        ],
        // The engine-ledger witness beside V8's -- every claimed-zero path must
        // acquire no node, dispose none, and grow no pool during the window.
        counters: {totalAllocations: 0, totalDisposals: 0, poolGrowths: 0},
        // At least two permanent negative controls. Both MUST trip the gate.
        mustFail: [mustFailAlloc, mustFailChurn],
        // Thresholds: lite-perf-gate DEFAULTS, untouched (maxScavenges 2,
        // maxRetainedKB 64, maxOldGen 0, maxArrayBuffersKB 64). A claimed-zero
        // path that cannot meet defaults is a FINDING, not a config knob.
    });
}
