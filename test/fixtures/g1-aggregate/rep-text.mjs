// Realistic rep-file text in the benchmark.mjs output format (stamp block, #STAMP line,
// six scenario blocks, notes). Shared by the aggregate fixtures and the runner stub.
// Format learned from the frozen benchmark.mjs printing code + stamp.mjs formatStamp.
export const SCENARIO_TITLES = [
    "KAIROS -- 1 source -> 1000 computeds -> 1 aggregating effect",
    "BROADCAST -- 1 source -> 1000 effects",
    "DEEP CHAIN -- 256-deep computed chain -> 1 effect",
    "MUX -- 256 inputs -> 1 sum computed -> 1 effect",
    "DYNAMIC DAG -- sqrt-layered, FAN=6 deps, read order flips each iter",
    "SELECTIVE DAG -- sqrt-layered, 4 candidates, 2 read per iter (set churn)",
];
const pad = (s, n) => { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); };
const fmtMs = (n) => n.toFixed(2).padStart(8) + "ms";

export function baseStamp(lib, over) {
    return Object.assign({
        kind: "bench-stamp/v1", date: "2026-11-23T00:00:00.000Z", protocol: "isolated-per-engine",
        reps: 5, node: "v22.0.0", arch: "arm64", platform: "darwin", cpu: "Fixture CPU", gcExposed: true,
        enginePath: "file:///fixture/Signal.js", engineSha256: "a".repeat(64),
        harnessPath: "file:///fixture/benchmark.mjs", harnessSha256: "b".repeat(64),
        config: lib === "lite-signal" ? { mode: "fixture" } : null,
        extra: { warmup: 2, iterations: 20000 },
    }, over || {});
}

// opts: { lib, times: number[6] (ms), sinks: string[6] (default "[x]"), stamp: object overrides,
//         dropRows: number (omit the last N scenario blocks), invalid: bool }
export function makeRepText(opts) {
    const { lib, times } = opts;
    const stamp = baseStamp(lib, opts.stamp);
    const L = [];
    L.push("# ==== BENCH STAMP v1 (machine-generated -- do not hand-edit) ====");
    L.push("# protocol    : " + stamp.protocol + "  reps=" + stamp.reps);
    L.push("# ================================================================");
    L.push("#STAMP " + JSON.stringify(stamp));
    L.push("Config: WARMUP=2  RUNS=5  ITERATIONS=20,000");
    L.push("");
    const n = 6 - (opts.dropRows || 0);
    for (let s = 0; s < n; s++) {
        L.push("-".repeat(98)); L.push(SCENARIO_TITLES[s]); L.push("-".repeat(98));
        const sink = (opts.sinks && opts.sinks[s]) || "[x]";
        L.push(pad(lib, 20) + "median=" + fmtMs(times[s]) + " min=" + fmtMs(times[s] * 0.9) +
            " ops/s=" + pad("1800K", 6) + " heapMed=" + pad(" 12.5KB", 9) + " heapP95=" + pad(" 14.0KB", 9) +
            " retained=" + pad(" 100.0KB", 9) + " sink=" + sink);
        L.push("");
    }
    L.push("Notes:");
    if (opts.invalid) {
        L.push("!".repeat(98));
        L.push("INVALID RUN -- 1 guard failure(s). These numbers are NOT publishable.");
        L.push("!".repeat(98));
    }
    return L.join("\n") + "\n";
}
