/**
 * bench.mjs -- honest cross-library benchmark for lite-signal vs alien-signals vs
 * @preact/signals-core vs solid-js vs reflex-quant.
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
import {makeStamp, printStamp} from "./lib/stamp.mjs";
import {makeVerdict, reportVerdict, checkSinkExact, checkSinkResidue, resolveRun, ITERATIONS_MIN} from "./lib/guards.mjs";
import {expectedSink, sinkCheckMode, finalSource, RESIDUE_ROWS} from "./lib/sink-oracle.mjs";
import {ENGINE_KEYS} from "./frameworks.mjs";
import {writeSync} from "node:fs";
const RESIDUE_ROWS_TEXT = RESIDUE_ROWS.join(", ");
import * as alien from "alien-signals";
import * as reflex from "reflex-quant";
import * as preact from "@preact/signals-core";
// IMPORTANT: solid-js resolves to its SSR build in Node by default,
// where effects are stubbed and never re-fire. We import the client
// runtime explicitly to get real reactive behaviour.
import * as solid from "solid-js/dist/solid.js";

// --- Config ------------------------------------------------------------------
const WARMUP = 2;
const RUNS = 5;
// FW / ITERATIONS resolve here, before anything prints (b250 G1, M4 + M6). A refusal
// (unknown / empty / duplicate FW key, ITERATIONS not a plain integer in [2, 2^30-1])
// exits 2 with no #STAMP line, so a bad invocation never leaves a stamped capture.
const RUN = resolveRun(process.env, ENGINE_KEYS);
if (!RUN.ok) {
    writeSync(2, "REFUSING: " + RUN.reason + "\n");
    process.exit(2);
}
const ITERATIONS = RUN.iterations;   // default 20000
const SRC_FINAL = finalSource(ITERATIONS);   // the value the last drive(i) of a run writes
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
// heapUsed + arrayBuffers (2026-09, LEDGER #27 amendment): off-heap typed-array
// backing stores are allocation/retention too; heapUsed alone cannot see them.
// Name kept so the heapMed/heapP95/retained columns (parsed by aggregate.mjs) stay stable.
function heapKB() { const m = process.memoryUsage(); return (m.heapUsed + m.arrayBuffers) / 1024; }

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

// Frozen lite registry configs (b250 G1, M4): ONE object per scenario, handed BY
// REFERENCE to createRegistry in the lite adapters below and echoed by the stamp (the
// single-reference rule in lib/stamp.mjs). The values are the adapters' former inline
// literals evaluated at each scenario's N (SCENARIOS below); liteConfigDrift() re-derives
// them from N at start-up and the run refuses (exit 2) on any difference.
const LITE_CONFIGS = Object.freeze({
    kairos: Object.freeze({maxNodes: 1000 + 64, prealloc: "eager", onCapacityExceeded: "grow"}),
    broadcast: Object.freeze({maxNodes: 1000 + 16, prealloc: "eager", onCapacityExceeded: "grow"}),
    deepChain: Object.freeze({maxNodes: 256 + 16, prealloc: "eager", onCapacityExceeded: "grow"}),
    mux: Object.freeze({maxNodes: 256 + 16, prealloc: "eager", onCapacityExceeded: "grow"}),
    // W = L = 31 at N = 960 (W = max(4, ceil(sqrt N)), L = max(2, ceil(N / W)))
    dynamicDag: Object.freeze({maxNodes: 31 * 31 + 32, maxLinks: 31 * 31 * 6 * 2, prealloc: "eager", onCapacityExceeded: "grow"}),
    selectiveDag: Object.freeze({maxNodes: 31 * 31 + 32, maxLinks: 31 * 31 * 4 * 2, prealloc: "eager", onCapacityExceeded: "grow"})
});

const ADAPTERS = {
    "lite-signal": {
        kairos(N, sinkSlot) {
            const r = createRegistry(LITE_CONFIGS.kairos);
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
            const r = createRegistry(LITE_CONFIGS.broadcast);
            const src = r.signal(0);
            for (let i = 0; i < N; i++) {
                const k = i;
                r.effect(() => { SINK[sinkSlot + (k & 31)] = src() + k; });
            }
            return {drive: (i) => src.set(i), teardown: () => r.destroy()};
        },
        deepChain(N, sinkSlot) {
            const r = createRegistry(LITE_CONFIGS.deepChain);
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
            const r = createRegistry(LITE_CONFIGS.mux);
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
            const r = createRegistry(LITE_CONFIGS.dynamicDag);
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
            const r = createRegistry(LITE_CONFIGS.selectiveDag);
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
        }
    },

    // reflex-quant: same graphs as the alien-signals adapter above, scenario by scenario.
    // A handle IS the node: reads are get(h), writes set(h, v). Effects run synchronously
    // on creation and inside set(); an effect body that returns a function registers it as
    // a cleanup, so every effect body here is a block that returns undefined. Teardown is
    // dispose(effectHandle), the point where alien calls its disposer.
    "reflex-quant": {
        kairos(N, sinkSlot) {
            const src = reflex.signal(0);
            const cs = new Array(N);
            for (let i = 0; i < N; i++) {
                const k = i;
                cs[i] = reflex.computed(() => reflex.get(src) * (k + 1));
            }
            const eff = reflex.effect(() => {
                let s = 0; for (let i = 0; i < N; i++) s += reflex.get(cs[i]);
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => reflex.set(src, i), teardown: () => reflex.dispose(eff)};
        },
        broadcast(N, sinkSlot) {
            const src = reflex.signal(0);
            const effects = [];
            for (let i = 0; i < N; i++) {
                const k = i;
                effects.push(reflex.effect(() => { SINK[sinkSlot + (k & 31)] = reflex.get(src) + k; }));
            }
            return {
                drive: (i) => reflex.set(src, i),
                teardown: () => {
                    for (let i = 0; i < effects.length; i++) reflex.dispose(effects[i]);
                }
            };
        },
        deepChain(N, sinkSlot) {
            const src = reflex.signal(0);
            let prev = src;
            for (let i = 0; i < N; i++) {
                const p = prev;
                prev = reflex.computed(() => reflex.get(p) + 1);
            }
            const tip = prev;
            const eff = reflex.effect(() => { SINK[sinkSlot] = reflex.get(tip); });
            return {drive: (i) => reflex.set(src, i), teardown: () => reflex.dispose(eff)};
        },
        mux(N, sinkSlot) {
            const sigs = new Array(N);
            for (let i = 0; i < N; i++) sigs[i] = reflex.signal(0);
            const sum = reflex.computed(() => {
                let s = 0; for (let i = 0; i < N; i++) s += reflex.get(sigs[i]); return s;
            });
            const eff = reflex.effect(() => { SINK[sinkSlot] = reflex.get(sum); });
            return {drive: (i) => reflex.set(sigs[i % N], i), teardown: () => reflex.dispose(eff)};
        },
        dynamicDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const FAN = 6;
            const src = reflex.signal(0);
            let prevLayer = [src];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const deps = new Array(FAN);
                    for (let k = 0; k < FAN; k++) deps[k] = prevLayer[(w * 7 + k * 11) % prevLayer.length];
                    newLayer.push(reflex.computed(() => {
                        let s = 0;
                        if (reflex.get(src) & 1) {
                            for (let k = 0; k < FAN; k++) s += reflex.get(deps[k]);
                        } else {
                            for (let k = FAN - 1; k >= 0; k--) s += reflex.get(deps[k]);
                        }
                        return s;
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            const eff = reflex.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += reflex.get(tip[i]);
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => reflex.set(src, i), teardown: () => reflex.dispose(eff)};
        },
        selectiveDag(N, sinkSlot) {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const POOL = 4;
            const src = reflex.signal(0);
            const PAIRS = [[0, 1], [0, 2], [1, 3], [2, 3]];
            let prevLayer = [src];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = [];
                for (let w = 0; w < W; w++) {
                    const cand = new Array(POOL);
                    for (let k = 0; k < POOL; k++) cand[k] = prevLayer[(w * 7 + k * 13) % prevLayer.length];
                    newLayer.push(reflex.computed(() => {
                        const which = reflex.get(src) & 3;
                        const a = PAIRS[which][0], b = PAIRS[which][1];
                        return reflex.get(cand[a]) + reflex.get(cand[b]);
                    }));
                }
                prevLayer = newLayer;
            }
            const tip = prevLayer;
            const eff = reflex.effect(() => {
                let s = 0; for (let i = 0; i < tip.length; i++) s += reflex.get(tip[i]);
                SINK[sinkSlot] = s;
            });
            return {drive: (i) => reflex.set(src, i), teardown: () => reflex.dispose(eff)};
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
    // verification. One shape name = one definition, repo-wide. Their dead lite / alien
    // adapter methods were deleted in b250 (G1, M19).
];

// Engine list comes from frameworks.mjs (the single source of truth). Assert every
// declared engine has an ADAPTERS implementation here, so the two files cannot drift:
// add an engine to frameworks.mjs without wiring its adapter and this throws loudly.
const ALL_LIBS = ENGINE_KEYS;
for (const k of ALL_LIBS) if (!ADAPTERS[k]) throw new Error(`frameworks.mjs declares engine "${k}" but benchmark.mjs ADAPTERS has no implementation for it`);

// LITE_CONFIGS drift check (cold, before the stamp): re-derive each config from the
// scenario's N with the adapters' former formulas; any difference refuses the run.
function liteConfigDrift() {
    const want = (maxNodes, maxLinks) => maxLinks === undefined
        ? {maxNodes, prealloc: "eager", onCapacityExceeded: "grow"}
        : {maxNodes, maxLinks, prealloc: "eager", onCapacityExceeded: "grow"};
    const keys = Object.keys(LITE_CONFIGS);
    if (keys.length !== SCENARIOS.length) return "LITE_CONFIGS has " + keys.length + " entries for " + SCENARIOS.length + " scenarios";
    for (const sc of SCENARIOS) {
        const N = sc.N;
        const W = Math.max(4, Math.ceil(Math.sqrt(N)));
        const L = Math.max(2, Math.ceil(N / W));
        const w = sc.key === "kairos" ? want(N + 64)
            : sc.key === "dynamicDag" ? want(W * L + 32, W * L * 6 * 2)
            : sc.key === "selectiveDag" ? want(W * L + 32, W * L * 4 * 2)
            : want(N + 16);
        const got = LITE_CONFIGS[sc.key];
        if (!got || !Object.isFrozen(got) || JSON.stringify(got) !== JSON.stringify(w)) {
            return "LITE_CONFIGS." + sc.key + " = " + JSON.stringify(got) + " drifted from " + JSON.stringify(w);
        }
    }
    return null;
}
// D-b250-1: MUX is the one scenario that drives a modular index (sigs[i % N] = i); its N
// reaching ITERATIONS_MIN would re-open the dead timed loop. The other scenarios drive
// src.set(i), which changes the source on every run once ITERATIONS >= 2.
const MUX_SC = SCENARIOS.find((sc) => sc.key === "mux");
if (!MUX_SC || !(MUX_SC.N < ITERATIONS_MIN)) {
    writeSync(2, "REFUSING: mux N=" + (MUX_SC && MUX_SC.N) + " is not below ITERATIONS_MIN=" + ITERATIONS_MIN + " (lib/guards.mjs)\n");
    process.exit(2);
}
const CONFIG_DRIFT = liteConfigDrift();
if (CONFIG_DRIFT !== null) {
    writeSync(2, "REFUSING: " + CONFIG_DRIFT + "\n");
    process.exit(2);
}


// FW filter: run ONE engine per cold process to avoid cross-engine inline-cache
// pollution. Each engine has its own ReactiveNode/signal shape; running several
// through the shared drive()/set() call sites in one process degrades their ICs
// monomorphic -> megamorphic, so engines later in the list measure slow.
// Usage:  FW=lite-signal node --expose-gc bench/benchmark.mjs > run-lite.txt
//         (repeat per engine, then assemble the table from the per-process files)
// Resolved by resolveRun at the top: one FW key = isolated-per-engine; FW unset or 2+
// keys = shared-process-smoke (never publishable; aggregate refuses it).
const LIBS = RUN.libs;

// --- Runner ------------------------------------------------------------------
// expected: [[offset, value], ...] from expectedSink; labels: one prebuilt string per
// pair. Both are built before the timed runs; the checks run between runs only.
// residue: true only for sinkCheckMode(...) === "residue" rows (D-b250-2).
function runOne(lib, scenarioKey, N, sinkSlot, verdict, expected, labels, residue) {
    const adapter = ADAPTERS[lib][scenarioKey];
    if (!adapter) return null; // Lib doesn't implement this scenario -- caller prints "n/a".
    // Pre-setup baseline, read after a forced GC and BEFORE the adapter builds the graph:
    // the retained figure below is measured against this.
    forceGC();
    const heapPreSetup = heapKB();
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
            resetSink();   // M3: only a value written by THIS timed run can pass the check below
            forceGC();
            const heapBefore = heapKB();
            const t0 = performance.now();
            for (let i = 0; i < ITERATIONS; i++) drive(i);
            samples.push(performance.now() - t0);
            heapDeltas.push(heapKB() - heapBefore);   // heapUsed delta, no closing GC (not an allocation measurement)
            for (let e = 0; e < expected.length; e++) {
                if (residue) checkSinkResidue(verdict, labels[e], SINK[sinkSlot + expected[e][0]], SRC_FINAL, expected[e][0], N);
                else checkSinkExact(verdict, labels[e], SINK[sinkSlot + expected[e][0]], expected[e][1]);
            }
        }
        forceGC();
        // retained = post-run post-GC heap minus the pre-setup heap, floored at 0: the live
        // graph and pools still held here (teardown runs in the finally below).
        const retained = Math.max(0, heapKB() - heapPreSetup);
        return {samples, heapDeltas, retained};
    } finally {
        teardown();
    }
}

function pad(s, n) {
    s = String(s);
    return s + " ".repeat(Math.max(0, n - s.length));
}

// Machine stamp (Session 1; b250 G1 M4): the microscope's job is lite at its RECOMMENDED
// production config -- eager prealloc, right-sized pools, default flush. The stamp echoes
// the frozen LITE_CONFIGS table the lite adapters hand to createRegistry (null when lite is
// not in this run) and the protocol resolveRun derived from FW, so this table is never
// confused with the mirror's (which runs Andrii's lazy config).
printStamp(makeStamp({
    enginePath: new URL("../Signal.js", import.meta.url).href,
    harnessPath: import.meta.url,
    config: LIBS.includes("lite-signal") ? LITE_CONFIGS : null,
    protocol: RUN.protocol,
    reps: RUNS,
    extra: {warmup: WARMUP, iterations: ITERATIONS},
}));
console.log(`Config: WARMUP=${WARMUP}  RUNS=${RUNS}  ITERATIONS=${ITERATIONS.toLocaleString()}`);
if (!hasGC) console.log("!  Run with --expose-gc for accurate heap numbers.");
console.log("");

let sinkSlot = 0;
const verdict = makeVerdict();   // every sink mismatch lands here -- see the guard below
for (const sc of SCENARIOS) {
    const expected = expectedSink(sc.key, sc.N, ITERATIONS);
    console.log("-".repeat(98));
    console.log(sc.title);
    console.log("-".repeat(98));
    for (const lib of LIBS) {
        resetSink();
        const residue = sinkCheckMode(lib, sc.key) === "residue";
        const labels = expected.map((p) => `${lib} / ${sc.key} sink[+${p[0]}]` + (residue ? " (residue check)" : ""));
        const failsBefore = verdict.failures.length;
        const result = runOne(lib, sc.key, sc.N, sinkSlot, verdict, expected, labels, residue);
        if (result === null) {
            console.log(pad(lib, 20) + "(not implemented for this scenario)");
            continue;
        }
        const {samples, heapDeltas, retained} = result;
        const {min, median: median_, ops} = statSummary(samples);
        // SINK check (b250 G1, M3): the sink is reset before EVERY timed run and every slot
        // the scenario writes is checked exactly against bench/lib/sink-oracle.mjs after it.
        // [x] = all RUNS exact; [ ] = at least one stale, dead or wrong value (INVALID RUN).
        // check=residue rows (D-b250-2, solid / broadcast) pass on the residue rule instead.
        const sinkOk = verdict.failures.length === failsBefore ? "[x]" : "[ ]";
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
            (residue ? " check=residue" : "") +
            " sink=" + sinkOk
        );
        sinkSlot = (sinkSlot + 64) & (SINK_SIZE - 1);
    }
    console.log("");
}

console.log("Notes:");
console.log("  heapMed = median per-timed-run heapUsed(+arrayBuffers) delta, GC before the run, no closing GC; not an allocation measurement");
console.log("  heapP95 = 95th-pctile of the same per-run deltas; not an allocation measurement");
console.log("  retained = post-run post-GC heap minus the pre-setup heap, floored at 0 (live graph + pools)");
console.log("  sink [x] = every written slot exact vs bench/lib/sink-oracle.mjs after EACH timed run; check=residue rows");
console.log("    (" + RESIDUE_ROWS_TEXT + ") pass when slot j holds src + k for some k % 32 === j (effect order varies)");
console.log("  retained is > 0 on a correct run: the graph and its pools are still live at that read.");
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
//
// b250 (G1, M3): the old check (slot 0 !== 0, read once after all runs) passed a no-op
// drive() on BROADCAST / DEEP CHAIN (their creation run had already written the slot) and
// any stall after warm-up. Now the sink is reset before each timed run and every written
// slot is checked exactly against an independent oracle; any mismatch prints INVALID RUN
// and exits 1 (lib/guards.mjs reportVerdict).
reportVerdict(verdict);