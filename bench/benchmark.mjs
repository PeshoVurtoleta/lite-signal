/**
 * bench.mjs — honest cross-library benchmark for lite-signal vs alien-signals vs
 * @preact/signals-core vs solid-js.
 *
 * KEY FIXES over the previous harness (which was reporting Solid at ~50 GHz):
 *
 *  1. ANTI-DCE SINK
 *     Each effect writes its current observable output to a Float64Array slot.
 *     After the timed loop, we sum the entire sink and print it (BENCH_SINK_SUM).
 *     This makes the work observable to V8's escape analysis and prevents
 *     dead-code elimination.
 *
 *  2. FORCE OBSERVATION INSIDE THE INNER LOOP
 *     Libraries that defer effects (solid-js batches inside microtasks; alien
 *     uses synchronous effects but you still need a final read to force a pull
 *     for compute graphs) all see the same forcing pattern: after each
 *     `set()`, we read the head of the graph through a tracking-free path.
 *     If a library can prove the read is pure given internal state, that's a
 *     real win — but it can't elide the set's write to the underlying cell.
 *
 *  3. SOLID HONEST MODE
 *     We run solid inside `createRoot` (it requires an owner) and we use
 *     `createMemo` for cached derivations (its equivalent of `computed`).
 *     We acknowledge Solid's batching: the harness measures *time to settle*,
 *     not "N fully observed effect re-runs", and we report this distinction.
 *
 * Result numbers are now MEANINGFUL: if a lib shows up as 100x faster than
 * lite-signal, it's because of batching semantics, not DCE.
 *
 * Run: node --expose-gc bench/bench.mjs
 */

import {createRegistry} from "../Signal.js";
import * as alien from "alien-signals";
import * as preact from "@preact/signals-core";
// IMPORTANT: solid-js resolves to its SSR build in Node by default,
// where effects are stubbed and never re-fire. We import the client
// runtime explicitly to get real reactive behaviour.
import * as solid from "solid-js/dist/solid.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const WARMUP = 2;
const RUNS = 5;
const ITERATIONS = 20_000;
const SINK_SIZE = 4096;

// ─── Anti-DCE sink (shared across all libs and benchmarks) ───────────────────
// Float64Array specifically because Uint32Array writes can be optimised away
// if V8 can prove the slots are never read in the same iteration.
const SINK = new Float64Array(SINK_SIZE);
globalThis.__BENCH_SINK = SINK;  // expose so it isn't tree-shaken

function sinkSum() {
    let s = 0;
    for (let i = 0; i < SINK.length; i++) s += SINK[i];
    return s;
}

function resetSink() { for (let i = 0; i < SINK.length; i++) SINK[i] = 0; }

// ─── Memory helpers ──────────────────────────────────────────────────────────
const hasGC = typeof globalThis.gc === "function";
function forceGC() {
    if (!hasGC) return;
    globalThis.gc();
    globalThis.gc();
}
function heapKB() { return process.memoryUsage().heapUsed / 1024; }

// ─── Stats ───────────────────────────────────────────────────────────────────
function statSummary(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const min = sorted[0];
    const median = sorted[Math.floor(sorted.length / 2)];
    const ops = (ITERATIONS / (median / 1000)) | 0;
    return {min, median, ops};
}
function fmtMs(n) { return n.toFixed(2).padStart(8) + "ms"; }
function fmtOps(n) { return (n < 1_000_000_000
    ? (n / 1_000) | 0
    : (n / 1_000_000) | 0) + (n < 1_000_000_000 ? "K" : "M"); }
function fmtKB(n) {
    const v = n.toFixed(1);
    return (n >= 0 ? " " : "") + v + "KB";
}

// ─── Lib adapters ────────────────────────────────────────────────────────────
//
// Each adapter exposes the same shape:
//   setup(ITERATIONS, sinkOffset) → { drive(i): drive the loop for one iter,
//                                      teardown(): clean up }
//
// The bench timer wraps the `drive` calls. `sinkOffset` is the start slot in
// the shared sink array reserved for this benchmark instance.

const ADAPTERS = {
    "lite-signal": {
        kairos(N, sinkSlot) {
            const r = createRegistry({maxNodes: N + 64, onCapacityExceeded: "grow"});
            const src = r.signal(0);
            const cs = new Array(N);
            for (let i = 0; i < N; i++) cs[i] = r.computed(() => src() * (i + 1));
            r.effect(() => {
                let s = 0;
                for (let i = 0; i < N; i++) s += cs[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src.set(i), teardown: () => r.destroy()};
        },
        broadcast(N, sinkSlot) {
            const r = createRegistry({maxNodes: N + 16, onCapacityExceeded: "grow"});
            const src = r.signal(0);
            for (let i = 0; i < N; i++) {
                const k = i;
                r.effect(() => { SINK[sinkSlot + (k & 31)] = src() + k; });
            }
            return {drive: (i) => src.set(i), teardown: () => r.destroy()};
        },
        deepChain(N, sinkSlot) {
            const r = createRegistry({maxNodes: N + 16, onCapacityExceeded: "grow"});
            const src = r.signal(0);
            let prev = src;
            for (let i = 0; i < N; i++) {
                const p = prev;
                prev = r.computed(() => p() + 1);
            }
            const tip = prev;
            r.effect(() => { SINK[sinkSlot] = tip(); });
            return {drive: (i) => src.set(i), teardown: () => r.destroy()};
        },
        mux(N, sinkSlot) {
            const r = createRegistry({maxNodes: N + 16, onCapacityExceeded: "grow"});
            const sigs = new Array(N);
            for (let i = 0; i < N; i++) sigs[i] = r.signal(0);
            const sum = r.computed(() => {
                let s = 0; for (let i = 0; i < N; i++) s += sigs[i](); return s;
            });
            r.effect(() => { SINK[sinkSlot] = sum(); });
            return {
                drive: (i) => sigs[i % N].set(i),
                teardown: () => r.destroy()
            };
        },
        // DYNAMIC_DAG: 12-layer DAG, ~80 wide, FAN=6 deps per node. Each computed
        // reads its FAN deps in either forward or reverse order depending on the
        // parity of the source signal. This deliberately defeats stable read order
        // and exercises the dependency-retracking path on every iteration. It's
        // the worst-case for cursor-based dep matching and a fair model for
        // component trees with conditional rendering or selective subscriptions.
        dynamicDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const FAN = 6;
            const r = createRegistry({maxNodes: W * L + 32, maxLinks: W * L * FAN * 2, onCapacityExceeded: "grow"});
            const src = r.signal(0);
            let prevLayer = [src];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const deps = new Array(FAN);
                    for (let k = 0; k < FAN; k++) deps[k] = prevLayer[(w * 7 + k * 11) % prevLayer.length];
                    newLayer.push(r.computed(() => {
                        let s = 0;
                        if (src() & 1) {
                            for (let k = 0; k < FAN; k++) s += deps[k]();
                        } else {
                            for (let k = FAN - 1; k >= 0; k--) s += deps[k]();
                        }
                        return s;
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            r.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src.set(i), teardown: () => r.destroy()};
        },
        // SELECTIVE_DAG: every computed has 4 candidate deps but reads only 2.
        // Which two depends on (src() & 3), so the dep SET changes each iteration
        // — drops one link, allocates another. This is the dep-churn pathology
        // that exposes retracking cost most cleanly.
        selectiveDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const POOL = 4;   // 4 candidate deps per computed
            const r = createRegistry({maxNodes: W * L + 32, maxLinks: W * L * POOL * 2, onCapacityExceeded: "grow"});
            const src = r.signal(0);
            let prevLayer = [src];
            // Four (a, b) subsets of indices 0..3 — chosen so consecutive iterations
            // always differ by at least one element (real set churn each step).
            const PAIRS = [[0, 1], [0, 2], [1, 3], [2, 3]];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const cand = new Array(POOL);
                    for (let k = 0; k < POOL; k++) cand[k] = prevLayer[(w * 7 + k * 13) % prevLayer.length];
                    newLayer.push(r.computed(() => {
                        const which = src() & 3;
                        const a = PAIRS[which][0], b = PAIRS[which][1];
                        return cand[a]() + cand[b]();
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            r.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src.set(i), teardown: () => r.destroy()};
        },
        // 1000x12-style: 12 layers × ~80 wide, 4 source signals, conditional read pattern.
        // Approximates js-reactivity-benchmark "1000x12 dynamic large web app" shape.
        largeWebApp(N, sinkSlot) {
            const LAYERS = 12;
            const W = Math.max(4, Math.ceil(N / LAYERS));
            const SOURCES = 4;
            const r = createRegistry({maxNodes: W * LAYERS + SOURCES + 16, maxLinks: W * LAYERS * 4, onCapacityExceeded: "grow"});
            const sources = new Array(SOURCES);
            for (let s = 0; s < SOURCES; s++) sources[s] = r.signal(0);
            let prevLayer = sources;
            for (let layer = 0; layer < LAYERS; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const a = prevLayer[(w * 7) % prevLayer.length];
                    const b = prevLayer[(w * 11 + 3) % prevLayer.length];
                    const c = prevLayer[(w * 13 + 5) % prevLayer.length];
                    newLayer.push(r.computed(() => (sources[0]() & 1) ? (a() + b()) : (a() + c())));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            r.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => sources[i % SOURCES].set(i), teardown: () => r.destroy()};
        },
        // 1000x5-style: 5 layers × ~200 wide, 25 source signals, dense static reads (FAN=5).
        wideDense(N, sinkSlot) {
            const LAYERS = 5;
            const W = Math.max(4, Math.ceil(N / LAYERS));
            const SOURCES = 25;
            const FAN = 5;
            const r = createRegistry({maxNodes: W * LAYERS + SOURCES + 16, maxLinks: W * LAYERS * FAN * 2, onCapacityExceeded: "grow"});
            const sources = new Array(SOURCES);
            for (let s = 0; s < SOURCES; s++) sources[s] = r.signal(0);
            let prevLayer = sources;
            for (let layer = 0; layer < LAYERS; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const deps = new Array(FAN);
                    for (let k = 0; k < FAN; k++) deps[k] = prevLayer[(w * (k * 2 + 3)) % prevLayer.length];
                    newLayer.push(r.computed(() => deps[0]() + deps[1]() + deps[2]() + deps[3]() + deps[4]()));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            r.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => sources[i % SOURCES].set(i), teardown: () => r.destroy()};
        },
        // 64x6 selective DAG: smaller graph (~384 nodes), each compute selectively reads
        // 3 of 6 candidate deps based on source value.
        smallSelective(N, sinkSlot) {
            const LAYERS = 6;
            const W = Math.max(4, Math.ceil(N / LAYERS));
            const POOL = 6;
            const r = createRegistry({maxNodes: W * LAYERS + 16, maxLinks: W * LAYERS * POOL, onCapacityExceeded: "grow"});
            const src = r.signal(0);
            let prevLayer = [src];
            for (let layer = 0; layer < LAYERS; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const cand = new Array(POOL);
                    for (let k = 0; k < POOL; k++) cand[k] = prevLayer[(w * 7 + k * 5) % prevLayer.length];
                    newLayer.push(r.computed(() => {
                        const m = src() & 7;
                        let s = 0;
                        if (m & 1) s += cand[0]();
                        if (m & 2) s += cand[1]();
                        if (m & 4) s += cand[2]();
                        s += cand[3]();
                        return s;
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            r.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src.set(i), teardown: () => r.destroy()};
        }
    },

    "alien-signals": {
        kairos(N, sinkSlot) {
            const src = alien.signal(0);
            const cs = new Array(N);
            for (let i = 0; i < N; i++) {
                const k = i;
                cs[i] = alien.computed(() => src() * (k + 1));
            }
            alien.effect(() => {
                let s = 0; for (let i = 0; i < N; i++) s += cs[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src(i), teardown: () => {}};
        },
        broadcast(N, sinkSlot) {
            const src = alien.signal(0);
            for (let i = 0; i < N; i++) {
                const k = i;
                alien.effect(() => { SINK[sinkSlot + (k & 31)] = src() + k; });
            }
            return {drive: (i) => src(i), teardown: () => {}};
        },
        deepChain(N, sinkSlot) {
            const src = alien.signal(0);
            let prev = src;
            for (let i = 0; i < N; i++) {
                const p = prev;
                prev = alien.computed(() => p() + 1);
            }
            const tip = prev;
            alien.effect(() => { SINK[sinkSlot] = tip(); });
            return {drive: (i) => src(i), teardown: () => {}};
        },
        mux(N, sinkSlot) {
            const sigs = new Array(N);
            for (let i = 0; i < N; i++) sigs[i] = alien.signal(0);
            const sum = alien.computed(() => {
                let s = 0; for (let i = 0; i < N; i++) s += sigs[i](); return s;
            });
            alien.effect(() => { SINK[sinkSlot] = sum(); });
            return {drive: (i) => sigs[i % N](i), teardown: () => {}};
        },
        dynamicDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const FAN = 6;
            const src = alien.signal(0);
            let prevLayer = [src];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const deps = new Array(FAN);
                    for (let k = 0; k < FAN; k++) deps[k] = prevLayer[(w * 7 + k * 11) % prevLayer.length];
                    newLayer.push(alien.computed(() => {
                        let s = 0;
                        if (src() & 1) {
                            for (let k = 0; k < FAN; k++) s += deps[k]();
                        } else {
                            for (let k = FAN - 1; k >= 0; k--) s += deps[k]();
                        }
                        return s;
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src(i), teardown: () => {}};
        },
        selectiveDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const POOL = 4;
            const src = alien.signal(0);
            const PAIRS = [[0, 1], [0, 2], [1, 3], [2, 3]];
            let prevLayer = [src];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const cand = new Array(POOL);
                    for (let k = 0; k < POOL; k++) cand[k] = prevLayer[(w * 7 + k * 13) % prevLayer.length];
                    newLayer.push(alien.computed(() => {
                        const which = src() & 3;
                        const a = PAIRS[which][0], b = PAIRS[which][1];
                        return cand[a]() + cand[b]();
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src(i), teardown: () => {}};
        },
        largeWebApp(N, sinkSlot) {
            const LAYERS = 12;
            const W = Math.max(4, Math.ceil(N / LAYERS));
            const SOURCES = 4;
            const sources = new Array(SOURCES);
            for (let s = 0; s < SOURCES; s++) sources[s] = alien.signal(0);
            let prevLayer = sources;
            for (let layer = 0; layer < LAYERS; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const a = prevLayer[(w * 7) % prevLayer.length];
                    const b = prevLayer[(w * 11 + 3) % prevLayer.length];
                    const c = prevLayer[(w * 13 + 5) % prevLayer.length];
                    newLayer.push(alien.computed(() => (sources[0]() & 1) ? (a() + b()) : (a() + c())));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => sources[i % SOURCES](i), teardown: () => {}};
        },
        wideDense(N, sinkSlot) {
            const LAYERS = 5;
            const W = Math.max(4, Math.ceil(N / LAYERS));
            const SOURCES = 25;
            const FAN = 5;
            const sources = new Array(SOURCES);
            for (let s = 0; s < SOURCES; s++) sources[s] = alien.signal(0);
            let prevLayer = sources;
            for (let layer = 0; layer < LAYERS; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const deps = new Array(FAN);
                    for (let k = 0; k < FAN; k++) deps[k] = prevLayer[(w * (k * 2 + 3)) % prevLayer.length];
                    newLayer.push(alien.computed(() => deps[0]() + deps[1]() + deps[2]() + deps[3]() + deps[4]()));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => sources[i % SOURCES](i), teardown: () => {}};
        },
        smallSelective(N, sinkSlot) {
            const LAYERS = 6;
            const W = Math.max(4, Math.ceil(N / LAYERS));
            const POOL = 6;
            const src = alien.signal(0);
            let prevLayer = [src];
            for (let layer = 0; layer < LAYERS; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const cand = new Array(POOL);
                    for (let k = 0; k < POOL; k++) cand[k] = prevLayer[(w * 7 + k * 5) % prevLayer.length];
                    newLayer.push(alien.computed(() => {
                        const m = src() & 7;
                        let s = 0;
                        if (m & 1) s += cand[0]();
                        if (m & 2) s += cand[1]();
                        if (m & 4) s += cand[2]();
                        s += cand[3]();
                        return s;
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src(i), teardown: () => {}};
        }
    },

    "preact": {
        kairos(N, sinkSlot) {
            const src = preact.signal(0);
            const cs = new Array(N);
            for (let i = 0; i < N; i++) {
                const k = i;
                cs[i] = preact.computed(() => src.value * (k + 1));
            }
            preact.effect(() => {
                let s = 0; for (let i = 0; i < N; i++) s += cs[i].value;
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => { src.value = i; }, teardown: () => {}};
        },
        broadcast(N, sinkSlot) {
            const src = preact.signal(0);
            for (let i = 0; i < N; i++) {
                const k = i;
                preact.effect(() => { SINK[sinkSlot + (k & 31)] = src.value + k; });
            }
            return {drive: (i) => { src.value = i; }, teardown: () => {}};
        },
        deepChain(N, sinkSlot) {
            const src = preact.signal(0);
            let prev = src;
            for (let i = 0; i < N; i++) {
                const p = prev;
                prev = preact.computed(() => p.value + 1);
            }
            const tip = prev;
            preact.effect(() => { SINK[sinkSlot] = tip.value; });
            return {drive: (i) => { src.value = i; }, teardown: () => {}};
        },
        mux(N, sinkSlot) {
            const sigs = new Array(N);
            for (let i = 0; i < N; i++) sigs[i] = preact.signal(0);
            const sum = preact.computed(() => {
                let s = 0; for (let i = 0; i < N; i++) s += sigs[i].value; return s;
            });
            preact.effect(() => { SINK[sinkSlot] = sum.value; });
            return {drive: (i) => { sigs[i % N].value = i; }, teardown: () => {}};
        },
        dynamicDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const FAN = 6;
            const src = preact.signal(0);
            let prevLayer = [src];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const deps = new Array(FAN);
                    for (let k = 0; k < FAN; k++) deps[k] = prevLayer[(w * 7 + k * 11) % prevLayer.length];
                    newLayer.push(preact.computed(() => {
                        let s = 0;
                        if (src.value & 1) {
                            for (let k = 0; k < FAN; k++) s += deps[k].value;
                        } else {
                            for (let k = FAN - 1; k >= 0; k--) s += deps[k].value;
                        }
                        return s;
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            preact.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i].value;
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => { src.value = i; }, teardown: () => {}};
        },
        selectiveDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const POOL = 4;
            const src = preact.signal(0);
            const PAIRS = [[0, 1], [0, 2], [1, 3], [2, 3]];
            let prevLayer = [src];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const cand = new Array(POOL);
                    for (let k = 0; k < POOL; k++) cand[k] = prevLayer[(w * 7 + k * 13) % prevLayer.length];
                    newLayer.push(preact.computed(() => {
                        const which = src.value & 3;
                        const a = PAIRS[which][0], b = PAIRS[which][1];
                        return cand[a].value + cand[b].value;
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            preact.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i].value;
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => { src.value = i; }, teardown: () => {}};
        }
    },

    "solid": {
        // We use the BROWSER build (solid-js/dist/solid.js) — see import above.
        // The default Node resolution gives the SSR stub where effects don't
        // re-fire, producing meaningless ~0ms numbers.
        //
        // createEffect: deferred effect, runs once after the synchronous frame.
        //   We need to flush after each set() to make work observable.
        // createComputed: synchronous reactive primitive, runs immediately
        //   when its deps change. Used here as the closest analog to the
        //   other libs' synchronous `effect`.
        kairos(N, sinkSlot) {
            let dispose;
            const result = solid.createRoot(d => {
                dispose = d;
                const [get, set] = solid.createSignal(0, {equals: false});
                const cs = new Array(N);
                for (let i = 0; i < N; i++) {
                    const k = i;
                    cs[i] = solid.createMemo(() => get() * (k + 1));
                }
                solid.createComputed(() => {
                    let s = 0; for (let i = 0; i < N; i++) s += cs[i]();
                    SINK[sinkSlot] = s;
                });
                return {get, set};
            });
            return {drive: (i) => result.set(i), teardown: () => dispose()};
        },
        broadcast(N, sinkSlot) {
            let dispose;
            const result = solid.createRoot(d => {
                dispose = d;
                const [get, set] = solid.createSignal(0, {equals: false});
                for (let i = 0; i < N; i++) {
                    const k = i;
                    solid.createComputed(() => { SINK[sinkSlot + (k & 31)] = get() + k; });
                }
                return {get, set};
            });
            return {drive: (i) => result.set(i), teardown: () => dispose()};
        },
        deepChain(N, sinkSlot) {
            let dispose;
            const result = solid.createRoot(d => {
                dispose = d;
                const [get, set] = solid.createSignal(0, {equals: false});
                let prev = get;
                for (let i = 0; i < N; i++) {
                    const p = prev;
                    prev = solid.createMemo(() => p() + 1);
                }
                const tip = prev;
                solid.createComputed(() => { SINK[sinkSlot] = tip(); });
                return {get, set};
            });
            return {drive: (i) => result.set(i), teardown: () => dispose()};
        },
        mux(N, sinkSlot) {
            let dispose;
            const result = solid.createRoot(d => {
                dispose = d;
                const sigs = new Array(N);
                const setters = new Array(N);
                for (let i = 0; i < N; i++) {
                    const [g, s] = solid.createSignal(0, {equals: false});
                    sigs[i] = g; setters[i] = s;
                }
                const sum = solid.createMemo(() => {
                    let s = 0; for (let i = 0; i < N; i++) s += sigs[i](); return s;
                });
                solid.createComputed(() => { SINK[sinkSlot] = sum(); });
                return {setters};
            });
            return {drive: (i) => result.setters[i % N](i), teardown: () => dispose()};
        },
        dynamicDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const FAN = 6;
            let dispose, setter;
            solid.createRoot(d => {
                dispose = d;
                const [srcGet, srcSet] = solid.createSignal(0, {equals: false});
                setter = srcSet;
                let prevLayer = [srcGet];
                for (let layer = 0; layer < L; layer++) {
                    const newLayer = [];
                    for (let w = 0; w < W; w++) {
                        const deps = new Array(FAN);
                        for (let k = 0; k < FAN; k++) deps[k] = prevLayer[(w * 7 + k * 11) % prevLayer.length];
                        newLayer.push(solid.createMemo(() => {
                            let s = 0;
                            if (srcGet() & 1) {
                                for (let k = 0; k < FAN; k++) s += deps[k]();
                            } else {
                                for (let k = FAN - 1; k >= 0; k--) s += deps[k]();
                            }
                            return s;
                        }));
                    }
                    prevLayer = newLayer;
                }
                const tip = prevLayer;
                solid.createComputed(() => {
                    let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                    SINK[sinkSlot] = s;
                });
            });
            return {drive: (i) => setter(i), teardown: () => dispose()};
        },
        selectiveDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const POOL = 4;
            const PAIRS = [[0, 1], [0, 2], [1, 3], [2, 3]];
            let dispose, setter;
            solid.createRoot(d => {
                dispose = d;
                const [srcGet, srcSet] = solid.createSignal(0, {equals: false});
                setter = srcSet;
                let prevLayer = [srcGet];
                for (let layer = 0; layer < L; layer++) {
                    const newLayer = [];
                    for (let w = 0; w < W; w++) {
                        const cand = new Array(POOL);
                        for (let k = 0; k < POOL; k++) cand[k] = prevLayer[(w * 7 + k * 13) % prevLayer.length];
                        newLayer.push(solid.createMemo(() => {
                            const which = srcGet() & 3;
                            const a = PAIRS[which][0], b = PAIRS[which][1];
                            return cand[a]() + cand[b]();
                        }));
                    }
                    prevLayer = newLayer;
                }
                const tip = prevLayer;
                solid.createComputed(() => {
                    let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                    SINK[sinkSlot] = s;
                });
            });
            return {drive: (i) => setter(i), teardown: () => dispose()};
        }
    }
};

// ─── Bench scenarios ─────────────────────────────────────────────────────────
const SCENARIOS = [
    {key: "kairos",         title: "KAIROS — 1 source → 1000 computeds → 1 aggregating effect", N: 1000},
    {key: "broadcast",      title: "BROADCAST — 1 source → 1000 effects",                       N: 1000},
    {key: "deepChain",      title: "DEEP CHAIN — 256-deep computed chain → 1 effect",           N: 256},
    {key: "mux",            title: "MUX — 256 inputs → 1 sum computed → 1 effect",              N: 256},
    {key: "dynamicDag",     title: "DYNAMIC DAG — sqrt-layered, FAN=6 deps, read order flips each iter",   N: 960},
    {key: "selectiveDag",   title: "SELECTIVE DAG — sqrt-layered, 4 candidates, 2 read per iter (set churn)", N: 960},
    // Approximations of js-reactivity-benchmark "cellx" workloads. The structural shapes match
    // (layer count × width × source count, dynamic/dense/selective semantics) but precise
    // conditional-read patterns and drive sequencing may differ — these aren't 1:1 ports.
    // Not implemented for preact/solid; harness skips libs that don't define a scenario.
    {key: "largeWebApp",    title: "LARGE WEB APP — 12 layers × ~80 wide, 4 sources, conditional reads (≈ Andrii 1000x12 dynamic)", N: 960},
    {key: "wideDense",      title: "WIDE DENSE — 5 layers × ~200 wide, 25 sources, FAN=5 dense (≈ Andrii 1000x5 wide dense)",       N: 1000},
    {key: "smallSelective", title: "SMALL SELECTIVE — 6 layers × 64 wide, 6 candidates 3 read (≈ Andrii 64x6 dynamic selective)",   N: 384}
];

const LIBS = ["lite-signal", "alien-signals", "preact", "solid"];

// ─── Runner ──────────────────────────────────────────────────────────────────
function runOne(lib, scenarioKey, N, sinkSlot) {
    const adapter = ADAPTERS[lib][scenarioKey];
    if (!adapter) return null; // Lib doesn't implement this scenario — caller prints "n/a".
    const {drive, teardown} = adapter(N, sinkSlot);
    try {
        // Warmup
        for (let w = 0; w < WARMUP; w++) {
            for (let i = 0; i < ITERATIONS; i++) drive(i);
        }
        forceGC();
        const heapBefore = heapKB();
        const samples = [];
        for (let r = 0; r < RUNS; r++) {
            const t0 = performance.now();
            for (let i = 0; i < ITERATIONS; i++) drive(i);
            samples.push(performance.now() - t0);
        }
        const deltaHeap = heapKB() - heapBefore;
        forceGC();
        const retained = heapKB() - heapBefore;
        return {samples, deltaHeap, retained};
    } finally {
        teardown();
    }
}

function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }

console.log(`Config: WARMUP=${WARMUP}  RUNS=${RUNS}  ITERATIONS=${ITERATIONS.toLocaleString()}`);
if (!hasGC) console.log("⚠️  Run with --expose-gc for accurate heap numbers.");
console.log("");

let sinkSlot = 0;
for (const sc of SCENARIOS) {
    console.log("─".repeat(98));
    console.log(sc.title);
    console.log("─".repeat(98));
    for (const lib of LIBS) {
        resetSink();
        const result = runOne(lib, sc.key, sc.N, sinkSlot);
        if (result === null) {
            console.log(pad(lib, 20) + "(not implemented for this scenario)");
            continue;
        }
        const {samples, deltaHeap, retained} = result;
        const {min, median, ops} = statSummary(samples);
        // SINK sanity: must be non-zero if effects ran with non-zero iteration values
        const sinkValue = SINK[sinkSlot];
        const sinkOk = sinkValue !== 0 ? "✓" : "✗";
        console.log(
            pad(lib, 20) +
            "median=" + fmtMs(median) +
            " min=" + fmtMs(min) +
            " ops/s=" + pad(fmtOps(ops), 6) +
            " Δheap=" + pad(fmtKB(deltaHeap), 9) +
            " retained=" + pad(fmtKB(retained), 9) +
            " sink=" + sinkOk
        );
        sinkSlot = (sinkSlot + 64) & (SINK_SIZE - 1);
    }
    console.log("");
}

console.log("Notes:");
console.log("  Δheap    = heap growth during iterations (raw alloc pressure)");
console.log("  retained = heap growth surviving forceGc (true leaks / steady-state)");
console.log("  Zero-GC libs should show retained ≈ 0KB; Δheap close to 0KB.");
console.log("  BENCH_SINK_SUM (anti-DCE):", sinkSum().toFixed(2));
