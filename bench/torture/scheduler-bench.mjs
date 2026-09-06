/**
 * bench/torture/scheduler-bench.mjs — async-scheduler stress soak.
 *
 * Not a benchmark — a soak. 1,500 effects all use a microtask scheduler, so
 * every change defers their re-run. Concurrent writes during those pending
 * microtask drains stress the queue's ABA guard and the scheduler-thunk
 * caching path. Exit code 0 iff zero errors AND post-teardown pool clean.
 *
 * 2026-08 audit, Phase 2 -- the DELIVERY-WEDGE witness. Every oracle here was
 * peek()-based: it proved storage, so a scheduler queue that silently stopped
 * DELIVERING (dropped thunks, wedged drain, gen-guard over-fire) passed
 * forever. Eight sentinel effects on the same microtask scheduler now record
 * the values they OBSERVE: each tick writes one sentinel, and the write must
 * be delivered by the start of the next tick's callback. That is the pinned
 * property: DELIVERY-BY-NEXT-TICK, not the microtask boundary itself -- any
 * event-loop turn queued before setImmediate(tick) (microtask or FIFO
 * macrotask) satisfies it, so a regression that merely moved delivery to a
 * later-but-still-prior turn passes by design; a dropped thunk or a wedged
 * drain cannot (mutant-verified both ways). Run counts are exact
 * at teardown: one delivery per write plus the (deferred) creation run.
 * Mid-run node/link high-water and post-GC heapUsed witnesses ride along, as
 * in the other soaks.
 *
 * Usage: node --expose-gc bench/torture/scheduler-bench.mjs
 */
import {performance} from "node:perf_hooks";
import {createRegistry} from "../../Signal.js";

const N_SIGNALS = 1000;
const N_EFFECTS = 1500;
const N_COMPUTEDS = 800;
const TOTAL = N_SIGNALS + N_EFFECTS + N_COMPUTEDS;
const SECONDS = Number(process.env.TORTURE_SECONDS || 10);
const OPS_PER_TICK = 2000;

const r = createRegistry({
    maxNodes: TOTAL * 2,
    maxLinks: TOTAL * 16,
    prealloc: "eager",
    onCapacityExceeded: "grow",
});

const randInt = (n) => (Math.random() * n) | 0;

const sigs = Array.from({length: N_SIGNALS}, () => r.signal(0));

const comps = new Array(N_COMPUTEDS);
for (let i = 0; i < N_COMPUTEDS; i++) {
    comps[i] = r.computed(() => {
        const reads = 1 + randInt(5);
        let acc = 0;
        for (let j = 0; j < reads; j++) acc += sigs[randInt(N_SIGNALS)]();
        return acc;
    });
}

function microtaskScheduler(fn) {
    queueMicrotask(fn);
}

// JIT sink. The accumulator loops below exist to make the engine do real work;
// without a live read of their result V8 is free to eliminate them and the soak
// measures nothing. A magic-constant guard (if (acc === N) console.log(...)) is
// wrong: those constants are REACHABLE and pollute stdout on a healthy run.
// Accumulating into a module-scoped int32 that is read at teardown keeps the
// stores live without ever printing.
let sink = 0;

const effectDis = new Array(N_EFFECTS);
for (let i = 0; i < N_EFFECTS; i++) {
    effectDis[i] = r.effect(
        () => {
            const reads = 1 + randInt(6);
            let acc = 0;
            for (let j = 0; j < reads; j++) {
                const t = randInt(3);
                if (t === 0) acc += sigs[randInt(N_SIGNALS)]();
                else if (t === 1) {
                    const c = comps[randInt(N_COMPUTEDS)];
                    if (c) acc += c();
                } else acc += sigs[randInt(N_SIGNALS)]();
            }
            sink = (sink + acc) | 0;
        },
        {scheduler: microtaskScheduler}
    );
}

/* -- sentinel delivery oracle (microtask-scheduled, observed values) -------- */
const N_SENTINELS = 8;
const sentSigs = new Array(N_SENTINELS);
const sentObserved = new Int32Array(N_SENTINELS);
const sentRuns = new Int32Array(N_SENTINELS);
const sentWrites = new Int32Array(N_SENTINELS);
const sentLast = new Int32Array(N_SENTINELS);
const sentDispose = new Array(N_SENTINELS);
for (let i = 0; i < N_SENTINELS; i++) {
    sentSigs[i] = r.signal(0);
    const k = i;
    sentDispose[i] = r.effect(
        () => { sentObserved[k] = sentSigs[k](); sentRuns[k]++; },
        {scheduler: microtaskScheduler}
    );
}
let sentinelFailTick = -1;
let sentinelGot = 0, sentinelWant = 0;
let pendingSentinel = -1, pendingValue = 0;

/* -- mid-run high-water + post-GC heap witnesses ---------------------------- */
// Link maxima from the body shapes: effects <= 6 reads, computeds <= 5,
// sentinels 1 each (duplicate reads collapse). A deferred effect keeps its
// PREVIOUS run's links until its thunk fires -- same per-effect bound either
// way. Nodes can never exceed the built population.
const NODES_CEILING = TOTAL + N_SENTINELS * 2;
const LINKS_CEILING = N_EFFECTS * 6 + N_COMPUTEDS * 5 + N_SENTINELS;
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

// Value-correctness oracle. Liveness proves the scheduler saturation did not
// crash and the pool drained; it does not prove the signal values are right.
// The computeds read RANDOM signals per recompute, so only the signals are
// deterministically reproducible -- shadow mirrors each signal's last written
// value and peek() must always equal it (peek is synchronous even though the
// effects defer through the microtask scheduler). Allocated ONCE, outside the
// churn loop; the tick check reads a rotating WINDOW, no per-tick allocation.
const shadow = new Int32Array(N_SIGNALS);   // signals all start at 0
const ORACLE_WINDOW = 64;
let oracleCursor = 0;
let oracleMismatch = -1;
let oracleGot = 0;
let oracleWant = 0;
let oracleChecks = 0;

function checkOracle() {
    for (let k = 0; k < ORACLE_WINDOW; k++) {
        const i = (oracleCursor + k) % N_SIGNALS;
        const got = sigs[i].peek();
        if (got !== shadow[i] && oracleMismatch < 0) { oracleMismatch = i; oracleGot = got; oracleWant = shadow[i]; }
    }
    oracleCursor = (oracleCursor + ORACLE_WINDOW) % N_SIGNALS;
    oracleChecks++;
}

function fuzzOp() {
    const mode = randInt(5);
    try {
        if (mode === 0) {
            const si = randInt(N_SIGNALS);
            const v = randInt(1_000_000);
            sigs[si].set(v); shadow[si] = v;
            ops++;
        } else if (mode === 1) {
            r.batch(() => {
                const writes = 1 + randInt(32);
                for (let i = 0; i < writes; i++) {
                    const si = randInt(N_SIGNALS);
                    const v = randInt(1_000_000);
                    sigs[si].set(v); shadow[si] = v;
                    ops++;
                }
            });
        } else if (mode === 2) {
            r.untrack(() => {
                const reads = 1 + randInt(16);
                for (let i = 0; i < reads; i++) {
                    const c = comps[randInt(N_COMPUTEDS)];
                    if (c) c();
                    ops++;
                }
            });
        } else if (mode === 3) {
            const si = randInt(N_SIGNALS);
            const v = randInt(1_000_000);
            sigs[si].set(v); shadow[si] = v;
            const c = comps[randInt(N_COMPUTEDS)];
            if (c) c();
            ops += 2;
        } else {
            const burst = 1 + randInt(64);
            for (let i = 0; i < burst; i++) {
                const si = randInt(N_SIGNALS);
                const v = randInt(1_000_000);
                sigs[si].set(v); shadow[si] = v;
                ops++;
            }
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
    // LAST tick's sentinel write must have been delivered before this tick's
    // callback ran -- every turn queued before setImmediate(tick) (the
    // microtask drain included) has had its chance. A miss here is a WEDGE
    // or a drop, never a race.
    if (pendingSentinel >= 0 && sentObserved[pendingSentinel] !== pendingValue && sentinelFailTick < 0) {
        sentinelFailTick = tickCount; sentinelGot = sentObserved[pendingSentinel]; sentinelWant = pendingValue;
    }
    if (now >= endAt) {
        finish();
        return;
    }
    for (let i = 0; i < OPS_PER_TICK; i++) fuzzOp();
    checkOracle();
    // Sentinel: one write per tick, unique value, delivery checked next tick.
    tickCount++;
    const k = tickCount % N_SENTINELS;
    sentSigs[k].set(tickCount);
    sentWrites[k]++; sentLast[k] = tickCount;
    pendingSentinel = k; pendingValue = tickCount;
    sampleWitnesses(now);
    setImmediate(tick);
}

function finish() {
    const elapsed = (performance.now() - start) / 1000;
    const perSec = ops / elapsed;

    // Drain pending microtask-scheduled effects before we tear down, so any
    // late-firing trampoline runs against the gen-bound guard rather than a
    // half-torn-down graph.
    await0Pass(() => {
        // Final sentinel sweep BEFORE teardown: every queued thunk has drained,
        // so each sentinel must have OBSERVED its last written value, and the
        // delivery count must be exact (one run per write + the deferred
        // creation run; one write per tick means coalescing cannot occur).
        let sentFinalMiss = -1, sentCountDrift = -1;
        for (let i = 0; i < N_SENTINELS; i++) {
            if (sentObserved[i] !== sentLast[i] && sentFinalMiss < 0) sentFinalMiss = i;
            if (sentRuns[i] !== sentWrites[i] + 1 && sentCountDrift < 0) sentCountDrift = i;
        }
        for (let i = 0; i < N_EFFECTS; i++) effectDis[i] && effectDis[i]();
        for (let i = 0; i < N_COMPUTEDS; i++) comps[i] && r.dispose(comps[i]);
        for (let i = 0; i < N_SENTINELS; i++) { sentDispose[i](); r.dispose(sentSigs[i]); }

        const after = r.stats();
        console.log("scheduler-stress soak (microtask scheduler)");
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

        // Final full oracle sweep -- every signal, not just the sampled window.
        for (let i = 0; i < N_SIGNALS; i++) {
            const got = sigs[i].peek();
            if (got !== shadow[i] && oracleMismatch < 0) { oracleMismatch = i; oracleGot = got; oracleWant = shadow[i]; }
        }
        console.log("  oracle checks:", oracleChecks, "-> value mismatches:", oracleMismatch < 0 ? 0 : 1);

        let exitCode = 0;
        if (errors > 0) {
            console.error("  FAIL: errors > 0; first =", lastError && lastError.message);
            exitCode = 1;
        }
        if (oracleMismatch >= 0) {
            console.error("  FAIL: value oracle -- signal", oracleMismatch, "read", oracleGot,
                "but shadow model says", oracleWant);
            exitCode = 1;
        }
        if (after.activeNodes > N_SIGNALS + 8) {
            console.error("  FAIL: activeNodes leak — expected ≤", N_SIGNALS + 8, "got", after.activeNodes);
            exitCode = 1;
        }
        if (after.activeLinks !== 0) {
            console.error("  FAIL: activeLinks != 0 after teardown:", after.activeLinks);
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
            console.error("  FAIL: sentinel delivery wedge -- tick", sentinelFailTick, "wrote", sentinelWant,
                "but by the next tick the observing effect had recorded", sentinelGot,
                "(the microtask drain between ticks did not deliver the thunk)");
            exitCode = 1;
        }
        if (sentFinalMiss >= 0) {
            console.error("  FAIL: sentinel", sentFinalMiss, "never observed its final value",
                sentLast[sentFinalMiss], "-- recorded", sentObserved[sentFinalMiss], "after the full drain");
            exitCode = 1;
        }
        if (sentCountDrift >= 0) {
            console.error("  FAIL: sentinel", sentCountDrift, "ran", sentRuns[sentCountDrift], "times for",
                sentWrites[sentCountDrift], "writes (+1 creation) -- a thunk was dropped or double-fired");
            exitCode = 1;
        }
        if (exitCode === 0) console.log("  PASS: zero errors, pool returned to baseline, high-water + heap + delivery witnesses clean");
        process.exit(exitCode);
    });
}

function await0Pass(then) {
    // Yield through a tail-of-microtask + macrotask sequence to drain any
    // queued schedulers before we read the final stats.
    Promise.resolve().then(() => setImmediate(() => Promise.resolve().then(then)));
}

// Drain the deferred CREATION runs before the first tick: a write landing while
// the creation thunk is still queued coalesces with it (one run for two
// causes), which is correct engine behavior but would make the sentinels'
// exact one-run-per-write accounting undercount by one.
await0Pass(tick);
