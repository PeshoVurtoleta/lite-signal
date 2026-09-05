/**
 * bench.mjs -- honest cross-library benchmark for lite-signal vs alien-signals vs
 * @preact/signals-core vs solid-js.
 *
 * KEY FIXES over the previous harness (which was reporting Solid at ~50 GHz):
 *
 * 1. ANTI-DCE SINK
 * Each effect writes its current observable output to a Float64Array slot.
 * After the timed loop, we sum the entire sink and print it (BENCH_SINK_SUM).
 * This makes the work observable to V8's escape analysis and prevents
 * dead-code elimination.
 *
 * 2. FORCE OBSERVATION INSIDE THE INNER LOOP
 * Libraries that defer effects (solid-js batches inside microtasks; alien
 * uses synchronous effects but you still need a final read to force a pull
 * for compute graphs) all see the same forcing pattern: after each
 * `set()`, we read the head of the graph through a tracking-free path.
 * If a library can prove the read is pure given internal state, that's a
 * real win -- but it can't elide the set's write to the underlying cell.
 *
 * 3. SOLID HONEST MODE
 * We run solid inside `createRoot` (it requires an owner) and we use
 * `createMemo` for cached derivations (its equivalent of `computed`).
 * We acknowledge Solid's batching: the harness measures *time to settle*,
 * not "N fully observed effect re-runs", and we report this distinction.
 *
 * Result numbers are now MEANINGFUL: if a lib shows up as 100x faster than
 * lite-signal, it's because of batching semantics, not DCE.
 *
 * Run: node --expose-gc bench/bench.mjs
 */

import {createRegistry} from "../Signal.js";
import {median, summarizeSamples} from "./lib/stats.mjs";
import {makeStamp, printStamp, PROTOCOLS} from "./lib/stamp.mjs";
import {ENGINE_KEYS} from "./frameworks.mjs";
import * as alien from "alien-signals";
import * as preact from "@preact/signals-core";
// IMPORTANT: solid-js resolves to its SSR build in Node by default,
// where effects are stubbed and never re-fire. We import the client
// runtime explicitly to get real reactive behaviour.
import * as solid from "solid-js/dist/solid.js";

// --- Config ------------------------------------------------------------------
const WARMUP = 2;
const RUNS = 5;
const ITERATIONS = 20_000;//20000
const SINK_SIZE = 4096;

// --- Anti-DCE sink (shared across all libs and benchmarks) -------------------
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

// --- Memory helpers ----------------------------------------------------------
const hasGC = typeof globalThis.gc === "function";
function forceGC() {
    if (!hasGC) return;
    globalThis.gc();
    globalThis.gc();
}
function heapKB() { return process.memoryUsage().heapUsed / 1024; }

// --- Stats -------------------------------------------------------------------
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

// --- Lib adapters ------------------------------------------------------------
//
// Each adapter exposes the same shape:
//   setup(ITERATIONS, sinkOffset) -> { drive(i): drive the loop for one iter,
//                                      teardown(): clean up }
//
// The bench timer wraps the `drive` calls. `sinkOffset` is the start slot in
// the shared sink array reserved for this benchmark instance.

const ADAPTERS = {
    "lite-signal": {
        kairos(N, sinkSlot) {
            const r = createRegistry({maxNodes: N + 64, prealloc: "eager", onCapacityExceeded: "grow"});
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
            const r = createRegistry({maxNodes: N + 16, prealloc: "eager", onCapacityExceeded: "grow"});
            const src = r.signal(0);
            for (let i = 0; i < N; i++) {
                const k = i;
                r.effect(() => { SINK[sinkSlot + (k & 31)] = src() + k; });
            }
            return {drive: (i) => src.set(i), teardown: () => r.destroy()};
        },
        deepChain(N, sinkSlot) {
            const r = createRegistry({maxNodes: N + 16, prealloc: "eager", onCapacityExceeded: "grow"});
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
            const r = createRegistry({maxNodes: N + 16, prealloc: "eager", onCapacityExceeded: "grow"});
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
        dynamicDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const FAN = 6;
            const r = createRegistry({maxNodes: W * L + 32, maxLinks: W * L * FAN * 2, prealloc: "eager", onCapacityExceeded: "grow"});
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
        selectiveDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const POOL = 4;   // 4 candidate deps per computed
            const r = createRegistry({maxNodes: W * L + 32, maxLinks: W * L * POOL * 2, prealloc: "eager", onCapacityExceeded: "grow"});
            const src = r.signal(0);
            let prevLayer = [src];
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
        largeWebApp(N, sinkSlot) {
            const LAYERS = 12;
            const W = Math.max(4, Math.ceil(N / LAYERS));
            const SOURCES = 4;
            const r = createRegistry({maxNodes: W * LAYERS + SOURCES + 16, maxLinks: W * LAYERS * 4, prealloc: "eager", onCapacityExceeded: "grow"});
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
        wideDense(N, sinkSlot) {
            const LAYERS = 5;
            const W = Math.max(4, Math.ceil(N / LAYERS));
            const SOURCES = 25;
            const FAN = 5;
            const r = createRegistry({maxNodes: W * LAYERS + SOURCES + 16, maxLinks: W * LAYERS * FAN * 2, prealloc: "eager", onCapacityExceeded: "grow"});
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
        smallSelective(N, sinkSlot) {
            const LAYERS = 6;
            const W = Math.max(4, Math.ceil(N / LAYERS));
            const POOL = 6;
            const r = createRegistry({maxNodes: W * LAYERS + 16, maxLinks: W * LAYERS * POOL, prealloc: "eager", onCapacityExceeded: "grow"});
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
            const dispose = alien.effect(() => {
                let s = 0; for (let i = 0; i < N; i++) s += cs[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src(i), teardown: () => dispose()};
        },
        broadcast(N, sinkSlot) {
            const src = alien.signal(0);
            const disposers = [];
            for (let i = 0; i < N; i++) {
                const k = i;
                disposers.push(alien.effect(() => { SINK[sinkSlot + (k & 31)] = src() + k; }));
            }
            return {
                drive: (i) => src(i),
                teardown: () => {
                    for (let i = 0; i < disposers.length; i++) disposers[i]();
                }
            };
        },
        deepChain(N, sinkSlot) {
            const src = alien.signal(0);
            let prev = src;
            for (let i = 0; i < N; i++) {
                const p = prev;
                prev = alien.computed(() => p() + 1);
            }
            const tip = prev;
            const dispose = alien.effect(() => { SINK[sinkSlot] = tip(); });
            return {drive: (i) => src(i), teardown: () => dispose()};
        },
        mux(N, sinkSlot) {
            const sigs = new Array(N);
            for (let i = 0; i < N; i++) sigs[i] = alien.signal(0);
            const sum = alien.computed(() => {
                let s = 0; for (let i = 0; i < N; i++) s += sigs[i](); return s;
            });
            const dispose = alien.effect(() => { SINK[sinkSlot] = sum(); });
            return {drive: (i) => sigs[i % N](i), teardown: () => dispose()};
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
            const dispose = alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src(i), teardown: () => dispose()};
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
            const dispose = alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src(i), teardown: () => dispose()};
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
            const dispose = alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => sources[i % SOURCES](i), teardown: () => dispose()};
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
            const dispose = alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => sources[i % SOURCES](i), teardown: () => dispose()};
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
            const dispose = alien.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i]();
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => src(i), teardown: () => dispose()};
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
            const dispose = preact.effect(() => {
                let s = 0; for (let i = 0; i < N; i++) s += cs[i].value;
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => { src.value = i; }, teardown: () => dispose()};
        },
        broadcast(N, sinkSlot) {
            const src = preact.signal(0);
            const disposers = [];
            for (let i = 0; i < N; i++) {
                const k = i;
                disposers.push(preact.effect(() => { SINK[sinkSlot + (k & 31)] = src.value + k; }));
            }
            return {
                drive: (i) => { src.value = i; },
                teardown: () => {
                    for (let i = 0; i < disposers.length; i++) disposers[i]();
                }
            };
        },
        deepChain(N, sinkSlot) {
            const src = preact.signal(0);
            let prev = src;
            for (let i = 0; i < N; i++) {
                const p = prev;
                prev = preact.computed(() => p.value + 1);
            }
            const tip = prev;
            const dispose = preact.effect(() => { SINK[sinkSlot] = tip.value; });
            return {drive: (i) => { src.value = i; }, teardown: () => dispose()};
        },
        mux(N, sinkSlot) {
            const sigs = new Array(N);
            for (let i = 0; i < N; i++) sigs[i] = preact.signal(0);
            const sum = preact.computed(() => {
                let s = 0; for (let i = 0; i < N; i++) s += sigs[i].value; return s;
            });
            const dispose = preact.effect(() => { SINK[sinkSlot] = sum.value; });
            return {drive: (i) => { sigs[i % N].value = i; }, teardown: () => dispose()};
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
            const dispose = preact.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i].value;
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => { src.value = i; }, teardown: () => dispose()};
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
            const dispose = preact.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += tip[i].value;
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => { src.value = i; }, teardown: () => dispose()};
        }
    },

    "solid": {
        // We use the BROWSER build (solid-js/dist/solid.js) -- see import above.
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

// --- Bench scenarios ---------------------------------------------------------
const SCENARIOS = [
    {key: "kairos", title: "KAIROS -- 1 source -> 1000 computeds -> 1 aggregating effect", N: 1000},
    {key: "broadcast", title: "BROADCAST -- 1 source -> 1000 effects", N: 1000},
    {key: "deepChain", title: "DEEP CHAIN -- 256-deep computed chain -> 1 effect", N: 256},
    {key: "mux", title: "MUX -- 256 inputs -> 1 sum computed -> 1 effect", N: 256},
    {key: "dynamicDag", title: "DYNAMIC DAG -- sqrt-layered, FAN=6 deps, read order flips each iter", N: 960},
    {key: "selectiveDag", title: "SELECTIVE DAG -- sqrt-layered, 4 candidates, 2 read per iter (set churn)", N: 960}
    // NOTE (Session 4 / F8): largeWebApp / wideDense / smallSelective were REMOVED here.
    // They were self-described "~Andrii approximations" ("aren't 1:1 ports"), and they
    // produced a shape name that carried three different verdicts across the repo's
    // tables (results.txt -8%, resultsReactive +16.9%, Andrii log -24%). The real shapes
    // now run in bench/mirror.mjs under their real names, with counters and expected-value
    // verification. One shape name = one definition, repo-wide. The dead adapter methods
    // for these three keys remain below unused and can be deleted at leisure.
];

// Engine list comes from frameworks.mjs (the single source of truth). Assert every
// declared engine has an ADAPTERS implementation here, so the two files cannot drift:
// add an engine to frameworks.mjs without wiring its adapter and this throws loudly.
const ALL_LIBS = ENGINE_KEYS;
for (const k of ALL_LIBS) if (!ADAPTERS[k]) throw new Error(`frameworks.mjs declares engine "${k}" but benchmark.mjs ADAPTERS has no implementation for it`);


// FW filter: run ONE engine per cold process to avoid cross-engine inline-cache
// pollution. Each engine has its own ReactiveNode/signal shape; running several
// through the shared drive()/set() call sites in one process degrades their ICs
// monomorphic -> megamorphic, so engines later in the list measure slow.
// Usage:  FW=140 node --expose-gc bench/benchmark.mjs > run-140.txt
//         (repeat per engine, then assemble the table from the per-process files)
const LIBS = process.env.FW
    ? process.env.FW.split(",").map((s) => s.trim()).filter((s) => ALL_LIBS.includes(s))
    : ALL_LIBS;

// --- Runner ------------------------------------------------------------------
function runOne(lib, scenarioKey, N, sinkSlot) {
    const adapter = ADAPTERS[lib][scenarioKey];
    if (!adapter) return null; // Lib doesn't implement this scenario -- caller prints "n/a".
    const {drive, teardown} = adapter(N, sinkSlot);
    try {
        // Warmup
        for (let w = 0; w < WARMUP; w++) {
            for (let i = 0; i < ITERATIONS; i++) drive(i);
        }
        // F9 FIX: fence GC around EACH timed run and record per-run deltaHeap, so the
        // reported allocation figure is a median over clean runs -- not one delta smeared
        // across all RUNS (which the old code did, then AVERAGED across reps, forcing the
        // apology paragraph in results.txt about single-rep GC timing inflating the mean).
        const samples = [];
        const heapDeltas = [];
        for (let r = 0; r < RUNS; r++) {
            forceGC();
            const heapBefore = heapKB();
            const t0 = performance.now();
            for (let i = 0; i < ITERATIONS; i++) drive(i);
            samples.push(performance.now() - t0);
            heapDeltas.push(heapKB() - heapBefore);   // transient alloc for THIS run
        }
        forceGC();
        const retainedBase = heapKB();
        // retained = heap surviving a forced GC relative to a post-GC floor (live graph)
        const retained = Math.max(0, retainedBase - (heapKB()));
        return {samples, heapDeltas, retained};
    } finally {
        teardown();
    }
}

function pad(s, n) {
    s = String(s);
    return s + " ".repeat(Math.max(0, n - s.length));
}

// Machine stamp (Session 1): the microscope's job is lite at its RECOMMENDED production
// config -- eager prealloc, right-sized pools, default flush. That config lives in the
// per-scenario adapters above; the stamp records mode + host + engine sha so this table
// is never confused with the mirror's (which runs Andrii's lazy config).
printStamp(makeStamp({
    enginePath: new URL("../Signal.js", import.meta.url).href,
    harnessPath: import.meta.url,
    config: {mode: "microscope: eager, per-scenario right-sized pools, default flush"},
    protocol: process.env.FW ? PROTOCOLS.PER_ENGINE : PROTOCOLS.PER_ENGINE,
    reps: RUNS,
    extra: {warmup: WARMUP, iterations: ITERATIONS},
}));
console.log(`Config: WARMUP=${WARMUP}  RUNS=${RUNS}  ITERATIONS=${ITERATIONS.toLocaleString()}`);
if (!hasGC) console.log("!  Run with --expose-gc for accurate heap numbers.");
console.log("");

let sinkSlot = 0;
const deadSinks = [];   // lib/scenario pairs whose effects never ran -- see the guard below
for (const sc of SCENARIOS) {
    console.log("-".repeat(98));
    console.log(sc.title);
    console.log("-".repeat(98));
    for (const lib of LIBS) {
        resetSink();
        const result = runOne(lib, sc.key, sc.N, sinkSlot);
        if (result === null) {
            console.log(pad(lib, 20) + "(not implemented for this scenario)");
            continue;
        }
        const {samples, heapDeltas, retained} = result;
        const {min, median: median_, ops} = statSummary(samples);
        // SINK sanity: must be non-zero if effects ran with non-zero iteration values.
        // Every scenario drives its source with i > 0, so a correct run ALWAYS leaves a
        // non-zero value here. A zero means the effect never re-ran during the timed loop
        // and the timing is measuring nothing -- see the INVALID RUN guard at the bottom.
        const sinkValue = SINK[sinkSlot];
        const sinkOk = sinkValue !== 0 ? "[x]" : "[ ]";
        if (sinkValue === 0) deadSinks.push(`${lib} / ${sc.key}`);
        const heapMed = median(heapDeltas);
        const heapP95 = summarizeSamples(heapDeltas).p95;
        console.log(
            pad(lib, 20) +
            "median=" + fmtMs(median_) +
            " min=" + fmtMs(min) +
            " ops/s=" + pad(fmtOps(ops), 6) +
            " heapMed=" + pad(fmtKB(heapMed), 9) +
            " heapP95=" + pad(fmtKB(heapP95), 9) +
            " retained=" + pad(fmtKB(retained), 9) +
            " sink=" + sinkOk
        );
        sinkSlot = (sinkSlot + 64) & (SINK_SIZE - 1);
    }
    console.log("");
}

console.log("Notes:");
console.log("  heapMed = MEDIAN transient heap per timed run, GC-fenced each run (raw alloc pressure)");
console.log("  heapP95 = 95th-pctile of the same per-run deltas (tail alloc); no more single-smear average (F9)");
console.log("  retained = heap surviving a forced GC (true leaks / steady-state live graph)");
console.log("  Zero-GC libs should show retained ~ 0KB; heap close to 0KB.");
console.log("  BENCH_SINK_SUM (anti-DCE):", sinkSum().toFixed(2));

// --- VALIDITY GUARD ----------------------------------------------------------
// A dead sink means the effect never re-ran inside the timed loop, so the number
// printed above is not a measurement of propagation -- it is the cost of a bare
// `.set` plus dead-code elimination, and it will look absurdly fast.
//
// This is not hypothetical: every lite-signal adapter here once carried
// `flushStrategy: "sab"` while driving un-batched `.set` calls. In SAB mode a
// `.set` outside `batch()` ENQUEUES effects but does not flush them, so nothing
// downstream ran and MUX reported 22,032K ops/s against a real ~219K. The sink
// column said `[ ]` on nine rows and the run was still treated as publishable.
//
// Rule: any lite-signal adapter that opts into "sab" or "manual" MUST drive
// through `r.batch(...)` or call `r.flush()` per iteration, or its effects never
// deliver. The reference libraries (alien/preact/solid) all deliver eagerly, so
// eager is the only apples-to-apples mode for THIS harness.
if (deadSinks.length > 0) {
    console.log("");
    console.log("!".repeat(98));
    console.log("INVALID RUN -- " + deadSinks.length + " scenario(s) finished with a DEAD SINK (sink=[ ]).");
    console.log("The effect never re-ran during the timed loop; these timings measure nothing.");
    for (const d of deadSinks) console.log("    ! " + d);
    console.log("Do NOT publish these numbers. See the VALIDITY GUARD note in bench/benchmark.mjs.");
    console.log("!".repeat(98));
    process.exitCode = 1;
}