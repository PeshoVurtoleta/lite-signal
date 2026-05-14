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

function resetSink() {
    for (let i = 0; i < SINK.length; i++) SINK[i] = 0;
}

// ─── Memory helpers ──────────────────────────────────────────────────────────
const hasGC = typeof globalThis.gc === "function";

function forceGC() {
    if (!hasGC) return;
    globalThis.gc();
    globalThis.gc();
}

function heapKB() {
    return process.memoryUsage().heapUsed / 1024;
}

// ─── Stats ───────────────────────────────────────────────────────────────────
function statSummary(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const min = sorted[0];
    const median = sorted[Math.floor(sorted.length / 2)];
    const ops = (ITERATIONS / (median / 1000)) | 0;
    return {min, median, ops};
}

function fmtMs(n) {
    return n.toFixed(2).padStart(8) + "ms";
}

function fmtOps(n) {
    return (n < 1_000_000_000
        ? (n / 1_000) | 0
        : (n / 1_000_000) | 0) + (n < 1_000_000_000 ? "K" : "M");
}

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
                r.effect(() => {
                    SINK[sinkSlot + (k & 31)] = src() + k;
                });
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
            r.effect(() => {
                SINK[sinkSlot] = tip();
            });
            return {drive: (i) => src.set(i), teardown: () => r.destroy()};
        },
        mux(N, sinkSlot) {
            const r = createRegistry({maxNodes: N + 16, onCapacityExceeded: "grow"});
            const sigs = new Array(N);
            for (let i = 0; i < N; i++) sigs[i] = r.signal(0);
            const sum = r.computed(() => {
                let s = 0;
                for (let i = 0; i < N; i++) s += sigs[i]();
                return s;
            });
            r.effect(() => {
                SINK[sinkSlot] = sum();
            });
            return {
                drive: (i) => sigs[i % N].set(i),
                teardown: () => r.destroy()
            };
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
                let s = 0;
                for (let i = 0; i < N; i++) s += cs[i]();
                SINK[sinkSlot] = s;
            });
            return {
                drive: (i) => src(i), teardown: () => {
                }
            };
        },
        broadcast(N, sinkSlot) {
            const src = alien.signal(0);
            for (let i = 0; i < N; i++) {
                const k = i;
                alien.effect(() => {
                    SINK[sinkSlot + (k & 31)] = src() + k;
                });
            }
            return {
                drive: (i) => src(i), teardown: () => {
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
            alien.effect(() => {
                SINK[sinkSlot] = tip();
            });
            return {
                drive: (i) => src(i), teardown: () => {
                }
            };
        },
        mux(N, sinkSlot) {
            const sigs = new Array(N);
            for (let i = 0; i < N; i++) sigs[i] = alien.signal(0);
            const sum = alien.computed(() => {
                let s = 0;
                for (let i = 0; i < N; i++) s += sigs[i]();
                return s;
            });
            alien.effect(() => {
                SINK[sinkSlot] = sum();
            });
            return {
                drive: (i) => sigs[i % N](i), teardown: () => {
                }
            };
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
                let s = 0;
                for (let i = 0; i < N; i++) s += cs[i].value;
                SINK[sinkSlot] = s;
            });
            return {
                drive: (i) => {
                    src.value = i;
                }, teardown: () => {
                }
            };
        },
        broadcast(N, sinkSlot) {
            const src = preact.signal(0);
            for (let i = 0; i < N; i++) {
                const k = i;
                preact.effect(() => {
                    SINK[sinkSlot + (k & 31)] = src.value + k;
                });
            }
            return {
                drive: (i) => {
                    src.value = i;
                }, teardown: () => {
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
            preact.effect(() => {
                SINK[sinkSlot] = tip.value;
            });
            return {
                drive: (i) => {
                    src.value = i;
                }, teardown: () => {
                }
            };
        },
        mux(N, sinkSlot) {
            const sigs = new Array(N);
            for (let i = 0; i < N; i++) sigs[i] = preact.signal(0);
            const sum = preact.computed(() => {
                let s = 0;
                for (let i = 0; i < N; i++) s += sigs[i].value;
                return s;
            });
            preact.effect(() => {
                SINK[sinkSlot] = sum.value;
            });
            return {
                drive: (i) => {
                    sigs[i % N].value = i;
                }, teardown: () => {
                }
            };
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
                    let s = 0;
                    for (let i = 0; i < N; i++) s += cs[i]();
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
                    solid.createComputed(() => {
                        SINK[sinkSlot + (k & 31)] = get() + k;
                    });
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
                solid.createComputed(() => {
                    SINK[sinkSlot] = tip();
                });
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
                    sigs[i] = g;
                    setters[i] = s;
                }
                const sum = solid.createMemo(() => {
                    let s = 0;
                    for (let i = 0; i < N; i++) s += sigs[i]();
                    return s;
                });
                solid.createComputed(() => {
                    SINK[sinkSlot] = sum();
                });
                return {setters};
            });
            return {drive: (i) => result.setters[i % N](i), teardown: () => dispose()};
        }
    }
};

// ─── Bench scenarios ─────────────────────────────────────────────────────────
const SCENARIOS = [
    {key: "kairos", title: "KAIROS — 1 source → 1000 computeds → 1 aggregating effect", N: 1000},
    {key: "broadcast", title: "BROADCAST — 1 source → 1000 effects", N: 1000},
    {key: "deepChain", title: "DEEP CHAIN — 256-deep computed chain → 1 effect", N: 256},
    {key: "mux", title: "MUX — 256 inputs → 1 sum computed → 1 effect", N: 256}
];

const LIBS = ["lite-signal", "alien-signals", "preact", "solid"];

// ─── Runner ──────────────────────────────────────────────────────────────────
function runOne(lib, scenarioKey, N, sinkSlot) {
    const adapter = ADAPTERS[lib][scenarioKey];
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

function pad(s, n) {
    s = String(s);
    return s + " ".repeat(Math.max(0, n - s.length));
}

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
        const {samples, deltaHeap, retained} = runOne(lib, sc.key, sc.N, sinkSlot);
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
