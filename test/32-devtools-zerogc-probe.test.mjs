// Zero-GC probe on the Andrii-Volynets weak-group shapes, via lite-devtools 1.3.1.
//
// WHY THIS EXISTS. The reactive benchmark (bench/AndriiVolynetsReactiveBench.log)
// ranks lite-signal #4 overall but weak on the CREATION and UPDATE groups. The
// benchmark also proves (identical nodesRecomputed / edgesTraversed across the
// fast pack) that the algorithm and work-VOLUME are identical to alien-signals
// and reflex -- lite-signal's cost is per-node CPU, the deliberate price of the
// zero-GC object pool. The one thing that price must always buy back is ZERO
// heap growth on those same shapes. This test pins exactly that: run the shapes
// the benchmark calls slow, and assert the pool never grows its backing store
// (poolGrowths delta == 0) -- once through the engine's own counter, and once
// through devtools' watchAllocations() feed (the panel a consumer would wire).
//
// poolGrowths is the moat, NOT totalAllocations. `poolGrowths` bumps only when
// the pool must allocate a NEW backing block (real heap pressure). `allocDelta`
// / totalAllocations counts logical node ACQUISITIONS from the pool and SPIKES
// during creation by design -- asserting it were 0 would contradict the pool's
// own contract. So every assertion below is on poolGrowths / poolGrowthDelta.
//
// (Test-rig note: same single-engine-instance rewrite trick as test 25 -- see
// its header. watchAllocations() reads the module-global stats(), i.e. the
// default registry, so the feed workload runs there and is kept well under the
// default pool capacity so no legitimate growth can occur.)

import {describe, it, before} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import * as SIG from "../Signal.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function buildLocalDevtools() {
    const dtPath = fileURLToPath(import.meta.resolve("@zakkster/lite-devtools"));
    let src = readFileSync(dtPath, "utf8");
    const SPEC = /(["'])@zakkster\/lite-signal\1/g;
    if (!SPEC.test(src)) {
        throw new Error(
            "test 31: could not find the '@zakkster/lite-signal' import in Devtools.js to " +
            "rewrite -- update the SPEC so the probe shares this test's engine instance."
        );
    }
    SPEC.lastIndex = 0;
    src = src.replace(SPEC, `"../../Signal.js"`);
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
    const ViaDevtools = await import("../Signal.js");
    assert.strictEqual(
        SIG.createRegistry, ViaDevtools.createRegistry,
        "test 31 requires a single engine instance (see test 25 header)."
    );
});

// A registry pre-sized (eager) well above the working set, so any poolGrowths
// delta is a genuine zero-GC regression, never mere warmup.
function presized(nodes, links) {
    return SIG.createRegistry({maxNodes: nodes, maxLinks: links, prealloc: "eager"});
}

describe("zero-GC moat holds on the benchmark's weak-group shapes (via devtools counters)", () => {
    // ---- CREATION group (benchmark rank ~10; the widest gap) ----------------
    it("createComputations1to1: 2000 computeds off one signal grow the pool 0 times", () => {
        const r = presized(4096, 8192);
        const s = r.signal(0);
        const before = r.stats().poolGrowths;
        const arr = new Array(2000);
        for (let i = 0; i < 2000; i++) { arr[i] = r.computed(() => s() + 1); arr[i](); }
        const delta = r.stats().poolGrowths - before;
        assert.equal(delta, 0, `creation must not grow the pool; grew ${delta}x`);
        assert.equal(r.stats().activeNodes, 2001, "2000 computeds + 1 signal live");
    });

    it("createComputations1to8: fan-out creation grows the pool 0 times", () => {
        // one signal, 8 layers of 250 -> exercises heavier link creation too.
        const r = presized(4096, 32768);
        const s = r.signal(0);
        const before = r.stats().poolGrowths;
        for (let layer = 0; layer < 8; layer++) {
            for (let i = 0; i < 250; i++) { const c = r.computed(() => s() + layer); c(); }
        }
        const delta = r.stats().poolGrowths - before;
        assert.equal(delta, 0, `fan-out creation must not grow the pool; grew ${delta}x`);
    });

    // ---- UPDATE group (benchmark rank ~6) -----------------------------------
    it("updateComputations1to1: 100k stable updates grow the pool 0 times", () => {
        const r = presized(64, 128);
        const s = r.signal(0);
        const c = r.computed(() => s() + 1);
        let sink = 0;
        r.effect(() => { sink = c(); });
        const before = r.stats().poolGrowths;
        for (let i = 0; i < 100_000; i++) s.set(i);
        const delta = r.stats().poolGrowths - before;
        assert.equal(delta, 0, `stable updates must not grow the pool; grew ${delta}x`);
        assert.equal(sink, 100_000, "effect observed the final value");
    });

    // ---- DYNAMIC dependency churn (mux / unstable shapes) -------------------
    it("dynamic re-subscription: a mux toggling its source grows the pool 0 times", () => {
        const r = presized(64, 256);
        const pick = r.signal(0);
        const a = r.signal(10);
        const b = r.signal(20);
        // each recompute re-subscribes to a DIFFERENT source -> link churn, the
        // case where an unpooled engine leaks/reallocates links.
        const mux = r.computed(() => (pick() === 0 ? a() : b()));
        let sink = 0;
        r.effect(() => { sink = mux(); });
        const before = r.stats().poolGrowths;
        for (let i = 0; i < 50_000; i++) pick.set(i & 1);
        const delta = r.stats().poolGrowths - before;
        assert.equal(delta, 0, `dependency churn must recycle links, not grow the pool; grew ${delta}x`);
        assert.ok(sink === 10 || sink === 20, "mux settled on one branch");
    });
});

describe("devtools watchAllocations() reports a flat zero-GC line under create/dispose churn", () => {
    it("every sample shows poolGrowthDelta == 0 while allocDelta (acquisitions) climbs", async () => {
        // Runs on the DEFAULT registry (what watchAllocations samples). Bounded
        // create+dispose churn keeps the working set far under pool capacity, so
        // any poolGrowthDelta > 0 is a real regression. allocDelta is EXPECTED
        // to be > 0 -- that is the pool doing its job, not a leak.
        const samples = [];
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { try { feed.stop(); } catch (_) {} reject(new Error("watchAllocations delivered no samples in time")); }, 5000);
            const feed = DT.watchAllocations((p) => {
                samples.push(p);
                if (samples.length >= 4) { clearTimeout(timer); feed.stop(); resolve(); }
            }, {sampleMs: 15, recomputes: false});

            let round = 0;
            const churn = () => {
                const s = SIG.signal(0);
                const nodes = new Array(150);
                for (let i = 0; i < 150; i++) { nodes[i] = SIG.computed(() => s() + 1); nodes[i](); }
                for (let i = 0; i < 150; i++) SIG.dispose(nodes[i]);
                SIG.dispose(s);
                if (++round < 40) setTimeout(churn, 6);
            };
            churn();
        });

        assert.ok(samples.length >= 1, "watchAllocations must deliver at least one sample");
        for (const p of samples) {
            assert.equal(p.poolGrowthDelta, 0, "zero-GC moat: poolGrowthDelta must be 0 every sample");
        }
        // Sanity: the churn really was creating nodes (otherwise the flat line is
        // vacuous). At least one window must show acquisitions.
        assert.ok(samples.some((p) => p.allocDelta > 0),
            "allocDelta should climb under creation churn -- confirms the workload ran");
    });
});
