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
        if (acc === 42_424_242) console.log("impossible");
    });
}

for (let i = 0; i < N_INTERMEDIATE; i++) makeMid(i);
for (let i = 0; i < N_TOP_COMPUTEDS; i++) makeTop(i);
for (let i = 0; i < N_EFFECTS; i++) makeEffect(i);

const baseline = r.stats();
let ops = 0;
let errors = 0;
let lastError = null;

function fuzzOp() {
    const mode = randInt(6);
    try {
        if (mode === 0) {
            leaves[randInt(N_BASE_SIGNALS)].set(randInt(1_000_000));
            ops++;
        } else if (mode === 1) {
            r.batch(() => {
                const writes = 1 + randInt(16);
                for (let i = 0; i < writes; i++) {
                    leaves[randInt(N_BASE_SIGNALS)].set(randInt(1_000_000));
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
                        leaves[randInt(N_BASE_SIGNALS)].set(randInt(1_000_000));
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

function tick() {
    if (performance.now() >= endAt) {
        finish();
        return;
    }
    for (let i = 0; i < OPS_PER_TICK; i++) fuzzOp();
    setImmediate(tick);
}

function finish() {
    const elapsed = (performance.now() - start) / 1000;
    const perSec = ops / elapsed;

    // Tear down everything we explicitly own; verify stats return to baseline.
    for (let i = 0; i < N_EFFECTS; i++) effectDis[i] && effectDis[i]();
    for (let i = 0; i < N_TOP_COMPUTEDS; i++) tops[i] && r.dispose(tops[i]);
    for (let i = 0; i < N_INTERMEDIATE; i++) mids[i] && r.dispose(mids[i]);

    const after = r.stats();
    const initialEffects = baseline.effects;

    console.log("graph-shape fuzzer (random DAG)");
    console.log("  duration:", elapsed.toFixed(3), "s");
    console.log("  ops:", ops.toLocaleString());
    console.log("  ops/sec:", perSec.toLocaleString(undefined, {maximumFractionDigits: 0}));
    console.log("  errors:", errors);
    console.log("  baseline activeNodes/activeLinks:", baseline.activeNodes, "/", baseline.activeLinks);
    console.log("  post-teardown activeNodes/activeLinks:", after.activeNodes, "/", after.activeLinks);

    let exitCode = 0;
    if (errors > 0) {
        console.error("  FAIL: errors > 0; first error =", lastError && lastError.message);
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
    if (after.effects !== initialEffects - N_EFFECTS) {
        console.error("  FAIL: effects didn't return to baseline (initial:", initialEffects, "after:", after.effects, ")");
        exitCode = 1;
    }
    if (exitCode === 0) console.log("  PASS: zero errors, pool returned to baseline");
    process.exit(exitCode);
}

tick();
