// creation-anatomy-child.mjs
// Times ONE creation lane in this clean V8 process and emits JSON. One lane
// per process: mixing lanes would let one lane's hidden-class zoo pollute the
// next lane's ICs, and the whole point is attributing nanoseconds.
//
// REAL lanes execute the actual engines; MODEL lanes execute synthetic
// constructors that isolate one suspected cost stage of the callable signal's
// birth (see creation-anatomy.mjs for how the two kinds combine into an
// attribution). Every sample runs against a FRESH world (pre-sized registry
// for lite lanes -- the Phase 3 lesson from creation-isolated: an accumulating
// pool turns min-of-N into a growth-dodging filter).
//
// argv: lane     env: BENCH_RUNS, COUNT, ALIEN_PATH

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [, , LANE] = process.argv;
const BENCH_RUNS = parseInt(process.env.BENCH_RUNS || "6", 10);
const COUNT = parseInt(process.env.COUNT || "100000", 10);
const HERE = dirname(fileURLToPath(import.meta.url));

const emit = (obj) => process.stdout.write(JSON.stringify(obj));

if (!Number.isFinite(BENCH_RUNS) || BENCH_RUNS < 1 || !Number.isFinite(COUNT) || COUNT < 1) {
    emit({ lane: LANE, error: `BENCH_RUNS/COUNT must be positive integers (got "${process.env.BENCH_RUNS}"/"${process.env.COUNT}")` });
    process.exit(1);
}

const LITE_SIZES = { maxNodes: 1 << 18, maxLinks: 1 << 17, onCapacityExceeded: "grow" };

/* -- lane construction ------------------------------------------------------- */
// Each lane yields { make: () => world, run: (world, out) => void } where
// run() performs COUNT creations into out[] (a live array so V8 cannot dead-
// code the allocations away). world is rebuilt fresh per sample.
let lane = null;
let version = "n/a";

async function liteEngine() {
    const mod = await import(join(HERE, "../Signal.js"));
    version = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")).version + " (tree)";
    return mod;
}

try {
    if (LANE === "signal" || LANE === "signalBox" || LANE === "computed" || LANE === "computedBox") {
        const mod = await liteEngine();
        const boxed = LANE.endsWith("Box");
        const isComputed = LANE.startsWith("computed");
        lane = {
            make: () => {
                const r = mod.createRegistry(LITE_SIZES);
                if (boxed && typeof r.signalBox !== "function") throw new Error("engine lacks signalBox");
                // computed lanes read one shared source (standard 1-dep shape
                // on first pull; creation stays lazy).
                const src = boxed ? r.signalBox(1) : r.signal(1);
                return { r, src };
            },
            run: (w, out) => {
                const { r, src } = w;
                if (isComputed) {
                    // ONE FRESH CLOSURE PER OP, same as the alien-computed
                    // lane and the Andrii ground-truth rows (2026-08 review:
                    // passing one shared body function skipped the per-op
                    // closure allocation the alien lane pays, understating
                    // lite's computed birth tax in every cross-lane read).
                    if (boxed) for (let i = 0; i < COUNT; i++) out[i] = r.computedBox(() => src.get());
                    else for (let i = 0; i < COUNT; i++) out[i] = r.computed(() => src());
                } else {
                    if (boxed) for (let i = 0; i < COUNT; i++) out[i] = r.signalBox(i);
                    else for (let i = 0; i < COUNT; i++) out[i] = r.signal(i);
                }
            },
            stats: (w) => w.r.stats(),
        };
    } else if (LANE === "alien-signal" || LANE === "alien-computed") {
        const benchRequire = createRequire(join(HERE, "../bench/package.json"));
        const resolved = process.env.ALIEN_PATH || benchRequire.resolve("alien-signals");
        const alien = await import("file://" + resolved);
        version = (() => {
            let dir = dirname(resolved);
            for (let i = 0; i < 6; i++) {
                try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version; }
                catch { dir = dirname(dir); }
            }
            return "unknown";
        })();
        lane = LANE === "alien-signal"
            ? { make: () => ({}), run: (_w, out) => { for (let i = 0; i < COUNT; i++) out[i] = alien.signal(i); } }
            : {
                make: () => ({ src: alien.signal(1) }),
                run: (w, out) => { const s = w.src; for (let i = 0; i < COUNT; i++) out[i] = alien.computed(() => s()); },
            };
    } else if (LANE === "model-pool-write") {
        // MODEL: the pool-acquire floor -- pop a preconstructed node object off
        // a free list and stamp the 6 lifetime fields, exactly createNode's
        // recycle path, with no handle construction at all.
        class Node {
            constructor() {
                this.value = 0; this.flags = 0; this.version = 0; this.evalVersion = 0;
                this.markEpoch = 0; this.id = 0; this.equals = null; this.nextFree = null;
            }
        }
        lane = {
            make: () => {
                const pool = new Array(COUNT + 8);
                for (let i = 0; i < pool.length; i++) pool[i] = new Node();
                for (let i = 0; i < pool.length - 1; i++) pool[i].nextFree = pool[i + 1];
                return { head: pool[0], pool };
            },
            run: (w, out) => {
                let seq = 0;
                for (let i = 0; i < COUNT; i++) {
                    const node = w.head; w.head = node.nextFree; node.nextFree = null;
                    node.value = i; node.flags = 32; node.version = 0; node.evalVersion = 0;
                    node.markEpoch = 0; node.id = seq++; node.equals = Object.is;
                    out[i] = node;
                }
            },
        };
    } else if (LANE === "model-closures" || LANE === "model-closures-stamps") {
        // MODEL: two closures per creation (read + set over a shared captured
        // node), WITHOUT / WITH the six property stamps the callable signal
        // adds (4 named + 2 symbol-keyed). The delta between these two lanes
        // is the function-object shape-transition tax in isolation -- the
        // audit's prime suspect for the birth gap.
        const SYM_A = Symbol("node_ptr"), SYM_B = Symbol("node_gen");
        const sharedPeek = function () { return 0; };
        const sharedUpdate = function () { };
        const sharedSubscribe = function () { };
        const withStamps = LANE === "model-closures-stamps";
        lane = {
            make: () => ({}),
            run: (_w, out) => {
                for (let i = 0; i < COUNT; i++) {
                    const node = { value: i, gen: 0 };
                    const birthGen = node.gen;
                    const read = () => (node.gen !== birthGen ? undefined : node.value);
                    const set = (v) => { if (node.gen === birthGen) node.value = v; };
                    if (withStamps) {
                        read.peek = sharedPeek;
                        read.set = set;
                        read.update = sharedUpdate;
                        read.subscribe = sharedSubscribe;
                        read[SYM_A] = node;
                        read[SYM_B] = node.gen;
                    } else {
                        // keep `set` alive without stamping it onto read
                        node.setter = set;
                    }
                    out[i] = read;
                }
            },
        };
    } else if (LANE === "model-object-handle") {
        // MODEL: the box shape -- Object.create(sharedProto) + the 2 symbol
        // fields, no closures, no named stamps. signalBox minus the engine.
        const SYM_A = Symbol("node_ptr"), SYM_B = Symbol("node_gen");
        const PROTO = { get() { return this[SYM_A].value; }, set(v) { this[SYM_A].value = v; } };
        lane = {
            make: () => ({}),
            run: (_w, out) => {
                for (let i = 0; i < COUNT; i++) {
                    const node = { value: i, gen: 0 };
                    const box = Object.create(PROTO);
                    box[SYM_A] = node;
                    box[SYM_B] = node.gen;
                    out[i] = box;
                }
            },
        };
    } else {
        emit({ lane: LANE, error: "unknown lane " + LANE });
        process.exit(1);
    }
} catch (err) {
    emit({ lane: LANE, unavailable: true, reason: err.message });
    process.exit(0);
}

/* -- measure ------------------------------------------------------------------ */
// Warm ONCE per process (JIT state persists across samples; shapes are
// identical because warmup runs the same full-size body), then time
// BENCH_RUNS samples, each against a fresh world.
const sink = new Array(COUNT);
for (let round = 0; round < 3; round++) lane.run(lane.make(), sink);

function sample() {
    const timed = lane.make();
    globalThis.gc?.();
    const g0 = lane.stats ? lane.stats(timed).poolGrowths : 0;
    const t0 = performance.now();
    lane.run(timed, sink);
    const t1 = performance.now();
    const grew = lane.stats ? lane.stats(timed).poolGrowths - g0 : 0;
    globalThis.gc?.();
    return { ms: t1 - t0, grew };
}

const samples = [];
const growth = [];
for (let i = 0; i < BENCH_RUNS; i++) { const r = sample(); samples.push(r.ms); growth.push(r.grew); }

emit({
    lane: LANE,
    version,
    count: COUNT,
    samples,
    growth,
    min: Math.min(...samples),
    nsPerOp: Math.min(...samples) * 1e6 / COUNT,
    sinkKind: typeof sink[0],   // liveness read: the creations cannot be dead-coded
});
