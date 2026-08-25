/**
 * bench/torture/graph-fuzzer.mjs — random-DAG soak test.
 *
 * Not a benchmark — a CRASH-DETECTION soak. Builds a 1,500-node random DAG
 * and runs ten seconds of mixed fuzz operations (leaf writes, batched writes,
 * mid/top/effect rewiring, nested batch + untrack reads). The ops/sec number
 * is reported for context only; what matters is the assertions at the end:
 *
 *   - zero thrown exceptions during the run
 *   - activeNodes / activeLinks return to (or below) the pre-fuzz baseline
 *     after a final settle pass — i.e. the dispose path is sound under churn
 *   - (2026-08 audit, Phase 2) mid-run activeNodes/activeLinks high-water
 *     stays under the topology's theoretical maxima -- the link-graveyard
 *     witness a post-teardown check is structurally blind to; post-GC
 *     heapUsed high-water stays within slack of the post-build baseline; and
 *     eight sync SENTINEL effects prove delivery (observed values, not
 *     peek() storage) with exact run counts
 *
 * Exit code: 0 on clean run, 1 on any error or stability assertion failure.
 *
 * Usage: node --expose-gc bench/torture/graph-fuzzer.mjs
 *
 * NOTE: uses an explicit registry with onCapacityExceeded:"grow" so the soak
 * shape (1,500 nodes) does not collide with the default 1,024-node ceiling.
 * The default top-level imports use a fixed-capacity default registry — the
 * top-level surface is for application code with bounded graphs, not soak.
 */
import {performance} from "node:perf_hooks";
import {createRegistry} from "../../Signal.js";

const N_BASE_SIGNALS = 500;
const N_INTERMEDIATE = 500;
const N_TOP_COMPUTEDS = 200;
const N_EFFECTS = 300;
const TOTAL_NODES = N_BASE_SIGNALS + N_INTERMEDIATE + N_TOP_COMPUTEDS + N_EFFECTS;
const SECONDS = Number(process.env.TORTURE_SECONDS || 10);
const OPS_PER_TICK = 2000;

const r = createRegistry({
    maxNodes: TOTAL_NODES * 2,
    maxLinks: TOTAL_NODES * 16,
    prealloc: "eager",
    onCapacityExceeded: "grow",
});

const randInt = (n) => (Math.random() * n) | 0;
const randBool = () => Math.random() < 0.5;

const leaves = Array.from({length: N_BASE_SIGNALS}, () => r.signal(0));
const mids = new Array(N_INTERMEDIATE);
const tops = new Array(N_TOP_COMPUTEDS);
const effectDis = new Array(N_EFFECTS);

// JIT sink. The accumulator loops below exist to make the engine do real work;
// without a live read of their result V8 is free to eliminate them and the soak
// measures nothing. A magic-constant guard (if (acc === N) console.log(...)) is
// wrong: those constants are REACHABLE and pollute stdout on a healthy run.
// Accumulating into a module-scoped int32 that is read at teardown keeps the
// stores live without ever printing.
let sink = 0;

function makeMid(i) {
    if (mids[i]) r.dispose(mids[i]);
    mids[i] = r.computed(() => {
        const reads = 1 + randInt(6);
        let acc = 0;
        for (let j = 0; j < reads; j++) {
            // Read leaves unconditionally when i===0 — no earlier mids exist
            // (the original "randInt(i || 1)" idiom self-loops on i=0).
            if (i === 0 || randBool()) acc += leaves[randInt(N_BASE_SIGNALS)]();
            else {
                const c = mids[randInt(i)];
                if (c) acc += c();
            }
        }
        return acc;
    });
}

function makeTop(i) {
    if (tops[i]) r.dispose(tops[i]);
    tops[i] = r.computed(() => {
        const reads = 1 + randInt(8);
        let acc = 0;
        for (let j = 0; j < reads; j++) {
            // When i===0 there are no earlier tops; route the would-be "top"
            // pick to a leaf or mid instead, never to ourselves.
            const pick = i === 0 ? randInt(2) : randInt(3);
            if (pick === 0) acc += leaves[randInt(N_BASE_SIGNALS)]();
            else if (pick === 1) {
                const c = mids[randInt(N_INTERMEDIATE)];
                if (c) acc += c();
            } else {
                const c = tops[randInt(i)];
                if (c) acc += c();
            }
        }
        return acc;
    });
}

function makeEffect(i) {
    if (effectDis[i]) effectDis[i]();
    effectDis[i] = r.effect(() => {
        const reads = 1 + randInt(6);
        let acc = 0;
        for (let j = 0; j < reads; j++) {
            const t = randInt(3);
            if (t === 0) acc += leaves[randInt(N_BASE_SIGNALS)]();
            else if (t === 1) {
                const c = mids[randInt(N_INTERMEDIATE)];
                if (c) acc += c();
            } else {
                const c = tops[randInt(N_TOP_COMPUTEDS)];
                if (c) acc += c();
            }
        }
        sink = (sink + acc) | 0;
    });
}

for (let i = 0; i < N_INTERMEDIATE; i++) makeMid(i);
for (let i = 0; i < N_TOP_COMPUTEDS; i++) makeTop(i);
for (let i = 0; i < N_EFFECTS; i++) makeEffect(i);

/* -- sentinel delivery oracle (observed values, not peek storage) ----------- */
const N_SENTINELS = 8;
const sentSigs = new Array(N_SENTINELS);
const sentObserved = new Int32Array(N_SENTINELS);
const sentRuns = new Int32Array(N_SENTINELS);
const sentWrites = new Int32Array(N_SENTINELS);
const sentDispose = new Array(N_SENTINELS);
for (let i = 0; i < N_SENTINELS; i++) {
    sentSigs[i] = r.signal(0);
    const k = i;
    sentDispose[i] = r.effect(() => { sentObserved[k] = sentSigs[k](); sentRuns[k]++; });
}
let sentinelFailTick = -1;
let sentinelGot = 0, sentinelWant = 0;

/* -- mid-run high-water + post-GC heap witnesses ---------------------------- */
// Theoretical link maxima from the body shapes: mids read <= 6, tops <= 8,
// effects <= 6 (duplicate reads collapse to one link), sentinels 1 each.
// Rewires dispose before they create and sampling sits between ops, so nodes
// can never legitimately exceed the built population either.
const NODES_CEILING = TOTAL_NODES + N_SENTINELS * 2;
const LINKS_CEILING = N_INTERMEDIATE * 6 + N_TOP_COMPUTEDS * 8 + N_EFFECTS * 6 + N_SENTINELS;
let nodesHW = 0, linksHW = 0, hwBreachTick = -1;
const HEAP_SLACK_MB = 16;
const HEAP_SAMPLE_EVERY_MS = 1000;
const HAVE_GC = typeof globalThis.gc === "function";
let heapBase = -1, heapHW = -1, nextHeapSample = 0;
let tickCount = 0;

function sampleWitnesses(now) {
    const st = r.stats();
    if (st.activeNodes > nodesHW) nodesHW = st.activeNodes;
    if (st.activeLinks > linksHW) linksHW = st.activeLinks;
    if (hwBreachTick < 0 && (st.activeNodes > NODES_CEILING || st.activeLinks > LINKS_CEILING)) hwBreachTick = tickCount;
    if (HAVE_GC && now >= nextHeapSample) {
        globalThis.gc();
        const used = process.memoryUsage().heapUsed;
        if (used > heapHW) heapHW = used;
        nextHeapSample = now + HEAP_SAMPLE_EVERY_MS;
    }
}
if (HAVE_GC) { globalThis.gc(); heapBase = heapHW = process.memoryUsage().heapUsed; }

const baseline = r.stats();
let ops = 0;
let errors = 0;
let lastError = null;

// Value-correctness oracle. Liveness (nothing threw, pool drained) proves the
// graph did not CRASH; it does not prove the engine returned the RIGHT numbers.
// The leaves are the only deterministically reproducible nodes here -- the
// computeds pick their sources at random per recompute, so only the signals can
// be shadowed. shadow[i] mirrors leaves[i]'s last written value; peek() must
// always equal it. Allocated ONCE, outside the churn loop; the tick check reads
// a rotating WINDOW so the per-tick cost is bounded and no allocation occurs.
const shadow = new Int32Array(N_BASE_SIGNALS);   // leaves all start at 0
const ORACLE_WINDOW = 64;
let oracleCursor = 0;
let oracleMismatch = -1;      // first mismatching leaf index; -1 = clean
let oracleGot = 0;            // value + shadow captured AT detection
let oracleWant = 0;
let oracleChecks = 0;

function checkOracle() {
    for (let k = 0; k < ORACLE_WINDOW; k++) {
        const i = (oracleCursor + k) % N_BASE_SIGNALS;
        const got = leaves[i].peek();
        if (got !== shadow[i] && oracleMismatch < 0) { oracleMismatch = i; oracleGot = got; oracleWant = shadow[i]; }
    }
    oracleCursor = (oracleCursor + ORACLE_WINDOW) % N_BASE_SIGNALS;
    oracleChecks++;
}

function fuzzOp() {
    const mode = randInt(6);
    try {
        if (mode === 0) {
            const li = randInt(N_BASE_SIGNALS);
            const v = randInt(1_000_000);
            leaves[li].set(v); shadow[li] = v;
            ops++;
        } else if (mode === 1) {
            r.batch(() => {
                const writes = 1 + randInt(16);
                for (let i = 0; i < writes; i++) {
                    const li = randInt(N_BASE_SIGNALS);
                    const v = randInt(1_000_000);
                    leaves[li].set(v); shadow[li] = v;
                    ops++;
                }
            });
        } else if (mode === 2) {
            makeMid(randInt(N_INTERMEDIATE));
            ops++;
        } else if (mode === 3) {
            makeTop(randInt(N_TOP_COMPUTEDS));
            ops++;
        } else if (mode === 4) {
            makeEffect(randInt(N_EFFECTS));
            ops++;
        } else {
            r.batch(() => {
                let d = 1 + randInt(3);
                (function nested() {
                    if (--d < 0) return;
                    if (randBool()) {
                        const li = randInt(N_BASE_SIGNALS);
                        const v = randInt(1_000_000);
                        leaves[li].set(v); shadow[li] = v;
                        ops++;
                    }
                    r.untrack(() => {
                        const c = tops[randInt(N_TOP_COMPUTEDS)];
                        if (c) c();
                    });
                    nested();
                })();
            });
        }
    } catch (e) {
        errors++;
        if (!lastError) lastError = e;
    }
}

const start = performance.now();
const endAt = start + SECONDS * 1000;
sampleWitnesses(start);   // seed the high-water with the post-build state

function tick() {
    const now = performance.now();
    if (now >= endAt) {
        finish();
        return;
    }
    for (let i = 0; i < OPS_PER_TICK; i++) fuzzOp();
    checkOracle();
    // Sentinel: one sync write per tick, unique value, checked immediately.
    tickCount++;
    const k = tickCount % N_SENTINELS;
    sentSigs[k].set(tickCount);
    sentWrites[k]++;
    if (sentObserved[k] !== tickCount && sentinelFailTick < 0) {
        sentinelFailTick = tickCount; sentinelGot = sentObserved[k]; sentinelWant = tickCount;
    }
    sampleWitnesses(now);
    setImmediate(tick);
}

function finish() {
    const elapsed = (performance.now() - start) / 1000;
    const perSec = ops / elapsed;

    // Tear down everything we explicitly own; verify stats return to baseline.
    for (let i = 0; i < N_EFFECTS; i++) effectDis[i] && effectDis[i]();
    for (let i = 0; i < N_TOP_COMPUTEDS; i++) tops[i] && r.dispose(tops[i]);
    for (let i = 0; i < N_INTERMEDIATE; i++) mids[i] && r.dispose(mids[i]);
    for (let i = 0; i < N_SENTINELS; i++) { sentDispose[i](); r.dispose(sentSigs[i]); }

    const after = r.stats();
    const initialEffects = baseline.effects;

    console.log("graph-shape fuzzer (random DAG)");
    console.log("  duration:", elapsed.toFixed(3), "s");
    console.log("  ops:", ops.toLocaleString());
    console.log("  ops/sec:", perSec.toLocaleString(undefined, {maximumFractionDigits: 0}));
    console.log("  errors:", errors);
    console.log("  baseline activeNodes/activeLinks:", baseline.activeNodes, "/", baseline.activeLinks);
    console.log("  post-teardown activeNodes/activeLinks:", after.activeNodes, "/", after.activeLinks);
    console.log("  mid-run high-water nodes/links:", nodesHW, "/", linksHW,
        "(ceilings", NODES_CEILING, "/", LINKS_CEILING + ")");
    console.log("  post-GC heapUsed: base", (heapBase / 1048576).toFixed(1), "MB, high-water",
        (heapHW / 1048576).toFixed(1), "MB", HAVE_GC ? "" : "(UNAVAILABLE)");

    // Final full oracle sweep -- every leaf, not just the sampled window.
    for (let i = 0; i < N_BASE_SIGNALS; i++) {
        const got = leaves[i].peek();
        if (got !== shadow[i] && oracleMismatch < 0) { oracleMismatch = i; oracleGot = got; oracleWant = shadow[i]; }
    }
    console.log("  oracle checks:", oracleChecks, "-> value mismatches:", oracleMismatch < 0 ? 0 : 1);

    let exitCode = 0;
    if (errors > 0) {
        console.error("  FAIL: errors > 0; first error =", lastError && lastError.message);
        exitCode = 1;
    }
    if (oracleMismatch >= 0) {
        console.error("  FAIL: value oracle -- leaf", oracleMismatch, "read", oracleGot,
            "but shadow model says", oracleWant);
        exitCode = 1;
    }
    // After teardown only signals (leaves) should still be alive. Computeds +
    // effects should be back to the pre-fuzz baseline (minus any leaves we
    // didn't dispose — we leave the leaves alive on purpose).
    const expectedNodesFloor = N_BASE_SIGNALS;
    if (after.activeNodes > expectedNodesFloor + 8) {
        console.error("  FAIL: activeNodes leak — expected ≤", expectedNodesFloor + 8, "got", after.activeNodes);
        exitCode = 1;
    }
    if (after.effects !== initialEffects - N_EFFECTS - N_SENTINELS) {
        console.error("  FAIL: effects didn't return to baseline (initial:", initialEffects, "after:", after.effects, ")");
        exitCode = 1;
    }
    if (ops > 0 && sink === 0) {
        console.error("  FAIL: JIT sink never advanced -- the work loops were optimised away");
        exitCode = 1;
    }
    if (hwBreachTick >= 0 || nodesHW > NODES_CEILING || linksHW > LINKS_CEILING) {
        console.error("  FAIL: mid-run high-water exceeded the topology ceiling (tick", hwBreachTick + ") --",
            "nodes", nodesHW, ">", NODES_CEILING, "or links", linksHW, ">", LINKS_CEILING,
            "-- retained graph garbage invisible to the post-teardown check");
        exitCode = 1;
    }
    if (!HAVE_GC) {
        console.error("  FAIL: heap witness unverifiable -- run with --expose-gc");
        exitCode = 1;
    } else if (heapHW - heapBase > HEAP_SLACK_MB * 1048576) {
        console.error("  FAIL: post-GC heapUsed grew", ((heapHW - heapBase) / 1048576).toFixed(1),
            "MB >", HEAP_SLACK_MB, "MB slack -- retention the pool counters cannot see");
        exitCode = 1;
    }
    if (sentinelFailTick >= 0) {
        console.error("  FAIL: sentinel delivery -- tick", sentinelFailTick, "wrote", sentinelWant,
            "but the observing effect recorded", sentinelGot, "(sync flush did not deliver)");
        exitCode = 1;
    }
    for (let i = 0; i < N_SENTINELS; i++) {
        if (sentRuns[i] !== sentWrites[i] + 1) {
            console.error("  FAIL: sentinel", i, "ran", sentRuns[i], "times for", sentWrites[i],
                "writes (+1 creation) -- delivery count drifted");
            exitCode = 1;
            break;
        }
    }
    if (exitCode === 0) console.log("  PASS: zero errors, pool returned to baseline, high-water + heap + delivery witnesses clean");
    process.exit(exitCode);
}

tick();
