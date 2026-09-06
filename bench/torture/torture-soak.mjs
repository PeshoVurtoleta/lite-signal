/**
 * bench/torture/torture-soak.mjs — high-volume churn soak.
 *
 * Not a benchmark — a soak. Continuously writes, rewires effects, and
 * rewires computeds against a 7,500-node graph for five seconds. The
 * ops/sec is contextual; the assertion is that nothing crashes and that
 * after teardown the pool returns to its leaf-only baseline.
 *
 * Exit code: 0 on clean run, 1 on any error or stability assertion failure.
 *
 * Usage: node --expose-gc bench/torture/torture-soak.mjs
 *
 * NOTE: uses an explicit registry with onCapacityExceeded:"grow". The
 * top-level surface uses a fixed-capacity default registry (1,024 nodes),
 * which the soak shape would blow through on creation.
 *
 * The uploaded original had a known bug: computedDis was wired to a no-op
 * comment ("if you expose dispose, call it here") even though dispose IS
 * exposed — so computeds leaked across rewires. Fixed below.
 */
import {performance} from "node:perf_hooks";
import {createRegistry} from "../../Signal.js";

const N_SIGNALS = 2500;
const N_EFFECTS = 2500;
const N_COMPUTEDS = 2500;
const TOTAL = N_SIGNALS + N_EFFECTS + N_COMPUTEDS;
const SECONDS = Number(process.env.TORTURE_SECONDS || 5);

const r = createRegistry({
    maxNodes: TOTAL * 2,
    maxLinks: TOTAL * 16,
    prealloc: "eager",
    onCapacityExceeded: "grow",
});

const randInt = (n) => (Math.random() * n) | 0;

const sigs = Array.from({length: N_SIGNALS}, () => r.signal(0));
const effects = new Array(N_EFFECTS);
const effectDis = new Array(N_EFFECTS);
const computeds = new Array(N_COMPUTEDS);

// JIT sink. The accumulator loops below exist to make the engine do real work;
// without a live read of their result V8 is free to eliminate them and the soak
// measures nothing. A magic-constant guard (if (acc === N) console.log(...)) is
// wrong: those constants are REACHABLE and pollute stdout on a healthy run.
// Accumulating into a module-scoped int32 that is read at teardown keeps the
// stores live without ever printing.
let sink = 0;

function makeEffect(i) {
    if (effectDis[i]) effectDis[i]();
    const stop = r.effect(() => {
        const reads = 1 + randInt(8);
        let acc = 0;
        for (let j = 0; j < reads; j++) {
            const t = randInt(3);
            if (t === 0) acc += sigs[randInt(N_SIGNALS)]();
            else if (t === 1) {
                const c = computeds[randInt(N_COMPUTEDS)];
                if (c) acc += c();
            } else acc += sigs[randInt(N_SIGNALS)]();
        }
        sink = (sink + acc) | 0;
    });
    effects[i] = stop;
    effectDis[i] = stop;
}

function makeComputed(i) {
    // FIXED: properly dispose the old computed (the original had a no-op
    // comment "if you expose dispose, call it here").
    if (computeds[i]) r.dispose(computeds[i]);
    computeds[i] = r.computed(() => {
        const reads = 1 + randInt(6);
        let acc = 0;
        for (let j = 0; j < reads; j++) acc += sigs[randInt(N_SIGNALS)]();
        return acc;
    });
}

for (let i = 0; i < N_COMPUTEDS; i++) makeComputed(i);
for (let i = 0; i < N_EFFECTS; i++) makeEffect(i);

const baseline = r.stats();
let ops = 0;
let errors = 0;
let lastError = null;

// Value-correctness oracle. Liveness proves the churn did not crash; it does not
// prove the values are right. The computeds here read RANDOM signals per
// recompute, so only the signals are deterministically reproducible -- shadow
// mirrors each signal's last written value and peek() must always equal it.
// Allocated ONCE, outside the churn loop; the tick check reads a rotating WINDOW
// so there is no per-tick allocation and the cost stays bounded.
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

const start = performance.now();
const endAt = start + SECONDS * 1000;

function stepChunk() {
    for (let k = 0; k < 2000; k++) {
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
                makeEffect(randInt(N_EFFECTS));
                ops++;
            } else if (mode === 3) {
                r.untrack(() => makeComputed(randInt(N_COMPUTEDS)));
                ops++;
            } else {
                r.batch(() => {
                    const si = randInt(N_SIGNALS);
                    const v = randInt(1_000_000);
                    sigs[si].set(v); shadow[si] = v;
                    makeEffect(randInt(N_EFFECTS));
                    makeComputed(randInt(N_COMPUTEDS));
                    ops += 3;
                });
            }
        } catch (e) {
            errors++;
            if (!lastError) lastError = e;
        }
    }
}

function tick() {
    if (performance.now() >= endAt) {
        finish();
        return;
    }
    stepChunk();
    checkOracle();
    setImmediate(tick);
}

function finish() {
    const elapsed = (performance.now() - start) / 1000;
    const perSec = ops / elapsed;

    for (let i = 0; i < N_EFFECTS; i++) effectDis[i] && effectDis[i]();
    for (let i = 0; i < N_COMPUTEDS; i++) computeds[i] && r.dispose(computeds[i]);

    const after = r.stats();

    console.log("torture soak (high-volume churn)");
    console.log("  duration:", elapsed.toFixed(3), "s");
    console.log("  ops:", ops.toLocaleString());
    console.log("  ops/sec:", perSec.toLocaleString(undefined, {maximumFractionDigits: 0}));
    console.log("  errors:", errors);
    console.log("  baseline activeNodes/activeLinks:", baseline.activeNodes, "/", baseline.activeLinks);
    console.log("  post-teardown activeNodes/activeLinks:", after.activeNodes, "/", after.activeLinks);

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
    if (exitCode === 0) console.log("  PASS: zero errors, pool returned to baseline");
    process.exit(exitCode);
}

tick();
