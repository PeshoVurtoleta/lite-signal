/**
 * bench/torture/scheduler-bench.mjs — async-scheduler stress soak.
 *
 * Not a benchmark — a soak. 1,500 effects all use a microtask scheduler, so
 * every change defers their re-run. Concurrent writes during those pending
 * microtask drains stress the queue's ABA guard and the scheduler-thunk
 * caching path. Exit code 0 iff zero errors AND post-teardown pool clean.
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
            if (acc === 999_999_999) console.log("impossible");
        },
        {scheduler: microtaskScheduler}
    );
}

const baseline = r.stats();
let ops = 0;
let errors = 0;
let lastError = null;

function fuzzOp() {
    const mode = randInt(5);
    try {
        if (mode === 0) {
            sigs[randInt(N_SIGNALS)].set(randInt(1_000_000));
            ops++;
        } else if (mode === 1) {
            r.batch(() => {
                const writes = 1 + randInt(32);
                for (let i = 0; i < writes; i++) {
                    sigs[randInt(N_SIGNALS)].set(randInt(1_000_000));
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
            sigs[randInt(N_SIGNALS)].set(randInt(1_000_000));
            const c = comps[randInt(N_COMPUTEDS)];
            if (c) c();
            ops += 2;
        } else {
            const burst = 1 + randInt(64);
            for (let i = 0; i < burst; i++) {
                sigs[randInt(N_SIGNALS)].set(randInt(1_000_000));
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

    // Drain pending microtask-scheduled effects before we tear down, so any
    // late-firing trampoline runs against the gen-bound guard rather than a
    // half-torn-down graph.
    await0Pass(() => {
        for (let i = 0; i < N_EFFECTS; i++) effectDis[i] && effectDis[i]();
        for (let i = 0; i < N_COMPUTEDS; i++) comps[i] && r.dispose(comps[i]);

        const after = r.stats();
        console.log("scheduler-stress soak (microtask scheduler)");
        console.log("  duration:", elapsed.toFixed(3), "s");
        console.log("  ops:", ops.toLocaleString());
        console.log("  ops/sec:", perSec.toLocaleString(undefined, {maximumFractionDigits: 0}));
        console.log("  errors:", errors);
        console.log("  baseline activeNodes/activeLinks:", baseline.activeNodes, "/", baseline.activeLinks);
        console.log("  post-teardown activeNodes/activeLinks:", after.activeNodes, "/", after.activeLinks);

        let exitCode = 0;
        if (errors > 0) {
            console.error("  FAIL: errors > 0; first =", lastError && lastError.message);
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
        if (exitCode === 0) console.log("  PASS: zero errors, pool returned to baseline");
        process.exit(exitCode);
    });
}

function await0Pass(then) {
    // Yield through a tail-of-microtask + macrotask sequence to drain any
    // queued schedulers before we read the final stats.
    Promise.resolve().then(() => setImmediate(() => Promise.resolve().then(then)));
}

tick();
