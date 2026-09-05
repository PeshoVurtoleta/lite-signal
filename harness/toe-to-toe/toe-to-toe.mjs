import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// WHAT CHANGED vs the old sweep
//
// 1. ORDERING BIAS (the thermal artifact). The old loop ran ALL cold processes of
//    v15, then all of v16, ... then all of v112 -- so the newest engine always ran
//    LAST, after the machine had heated through the entire sweep. That is why
//    deepChain showed a MONOTONIC slowdown across 1.9 -> 1.10 -> 1.11, three engines
//    whose propagation bodies are sha256-IDENTICAL. Identical code cannot trend.
//    Now: round-robin. Each repetition runs every combo once, in a rotated order,
//    so thermal drift spreads across all columns instead of loading the last one.
//
// 2. SENTINEL. The 1.6.0 baseline is re-measured as a final column ("1.6.0-sentinel").
//    If sentinel != baseline by more than DRIFT_TOL, the machine drifted during the
//    run and the whole sweep is suspect -- the report says so loudly.
//
// 3. Duplicate 1.7.0-sab row removed; v112 added.
//
// 4. CAPABILITY COLUMNS. 1.11.0 (settled) and 1.12.0 (trace) are creation-time
//    capabilities that are OFF by default -- "zero cost when off" is proven by
//    byte-identical hot bodies. What was never measured is the cost when they are ON.
//    The *-on combos below run the SAME engine with the capability enabled, so the
//    delta against its own sab column is the honest price of the feature.
// ---------------------------------------------------------------------------

const COMBOS = [
    { label: "1.5.0",       engineDir: "v15",       mode: "eager"   },
    { label: "1.6.0",       engineDir: "v16",       mode: "eager"   },
    { label: "1.7.0-eager", engineDir: "v17-eager", mode: "eager"   },
    { label: "1.7.0-sab",   engineDir: "v17",       mode: "sab"     },
    { label: "1.8.0",       engineDir: "v18",       mode: "sab"     },
    { label: "1.9.0",       engineDir: "v19",       mode: "sab"     },
    { label: "1.10.0",      engineDir: "v110",      mode: "sab"     },
    { label: "1.11.0",      engineDir: "v111",      mode: "sab"     },
    { label: "1.12.0",      engineDir: "v112",      mode: "sab"     },
    // capability-ON columns (compare each against its own sab column above)
    { label: "1.11-settled", engineDir: "v111",     mode: "settled" },
    { label: "1.12-trace",   engineDir: "v112",     mode: "trace"   },
    // drift sentinel: same engine+mode as the 1.6.0 baseline, measured LAST
    { label: "1.6.0-sentinel", engineDir: "v16",    mode: "eager"   },
];

const BASELINE = "1.6.0";
const SENTINEL = "1.6.0-sentinel";
const DRIFT_TOL = 0.05;   // 5% -- beyond this the sweep is thermally suspect

// Core shapes run on every combo. The capability shapes (fanout64, churn) are the
// ones that actually exercise settled/trace; they run on every combo too so the
// capability-ON columns have a like-for-like sab column to be priced against.
const SCENARIOS = ["kairos", "broadcast", "deepChain", "mux", "upd1to1", "upd1to4", "fanout64", "churn"];

const COLD_PROCESSES = 3;

function runOne(combo, scenario) {
    const out = execFileSync(
        "node",
        ["--expose-gc", resolve(HERE, "runner.mjs"), combo.engineDir, combo.mode, scenario],
        { encoding: "utf8", cwd: HERE }
    );
    return JSON.parse(out.trim());
}

const allResults = {};
for (const sc of SCENARIOS) {
    allResults[sc] = {};
    for (const combo of COMBOS) allResults[sc][combo.label] = [];
}

// INTERLEAVED: repetition-major, with the combo order rotated each rep so no engine
// is systematically measured on a hotter machine than another.
for (let cp = 0; cp < COLD_PROCESSES; cp++) {
    for (const sc of SCENARIOS) {
        for (let j = 0; j < COMBOS.length; j++) {
            const combo = COMBOS[(j + cp) % COMBOS.length];   // rotate
            try {
                allResults[sc][combo.label].push(runOne(combo, sc));
            } catch (e) {
                allResults[sc][combo.label].push({ error: e.message });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function median(arr) { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
const cell = (s) => String(s).padStart(14);
const HDR = "Scenario        | " + COMBOS.map(c => cell(c.label)).join(" | ");

console.log(`\n=== TOE-TO-TOE (median of ${COLD_PROCESSES} cold processes x 7 in-process samples; INTERLEAVED order) ===\n`);
console.log(HDR);
console.log("-".repeat(HDR.length));
for (const sc of SCENARIOS) {
    const row = [sc.padEnd(15)];
    for (const combo of COMBOS) {
        const runs = allResults[sc][combo.label];
        if (!runs.length || runs.some(r => r.error)) { row.push(cell("error")); continue; }
        row.push(cell(median(runs.flatMap(r => r.samples)).toFixed(2) + " ms"));
    }
    console.log(row.join(" | "));
}

console.log(`\n=== Speedup over ${BASELINE} baseline ===\n`);
console.log(HDR);
console.log("-".repeat(HDR.length));
for (const sc of SCENARIOS) {
    const row = [sc.padEnd(15)];
    const base = median(allResults[sc][BASELINE].flatMap(r => r.samples || []));
    for (const combo of COMBOS) {
        const runs = allResults[sc][combo.label];
        if (!runs.length || runs.some(r => r.error)) { row.push(cell("error")); continue; }
        row.push(cell((base / median(runs.flatMap(r => r.samples))).toFixed(2) + "x"));
    }
    console.log(row.join(" | "));
}

console.log("\n=== Noise (max/min ratio across the cold processes' medians) ===");
console.log("Higher = more inconsistency between cold runs. <1.10 = very stable.\n");
console.log(HDR);
console.log("-".repeat(HDR.length));
for (const sc of SCENARIOS) {
    const row = [sc.padEnd(15)];
    for (const combo of COMBOS) {
        const runs = allResults[sc][combo.label];
        if (!runs.length || runs.some(r => r.error)) { row.push(cell("error")); continue; }
        const meds = runs.map(r => r.median);
        row.push(cell((Math.max(...meds) / Math.min(...meds)).toFixed(2) + "x"));
    }
    console.log(row.join(" | "));
}

// --- capability price: what does the feature cost WHEN ON? -------------------
console.log("\n=== Capability cost when ON (vs the SAME engine with it off) ===");
console.log("settled: 1.11-settled vs 1.11.0 | trace: 1.12-trace vs 1.12.0. >1.00x = slower with it on.\n");
const PAIRS = [["1.11-settled", "1.11.0"], ["1.12-trace", "1.12.0"]];
const CHDR = "Scenario        | " + PAIRS.map(([on]) => cell(on)).join(" | ");
console.log(CHDR);
console.log("-".repeat(CHDR.length));
for (const sc of SCENARIOS) {
    const row = [sc.padEnd(15)];
    for (const [on, off] of PAIRS) {
        const a = allResults[sc][on], b = allResults[sc][off];
        if (!a.length || !b.length || a.some(r => r.error) || b.some(r => r.error)) { row.push(cell("error")); continue; }
        const ratio = median(a.flatMap(r => r.samples)) / median(b.flatMap(r => r.samples));
        row.push(cell(ratio.toFixed(2) + "x"));
    }
    console.log(row.join(" | "));
}

// --- drift sentinel ---------------------------------------------------------
console.log("\n=== Drift sentinel ===");
let drifted = false;
for (const sc of SCENARIOS) {
    const b = allResults[sc][BASELINE], s = allResults[sc][SENTINEL];
    if (!b.length || !s.length || b.some(r => r.error) || s.some(r => r.error)) continue;
    const ratio = median(s.flatMap(r => r.samples)) / median(b.flatMap(r => r.samples));
    const bad = Math.abs(ratio - 1) > DRIFT_TOL;
    if (bad) drifted = true;
    console.log(`  ${sc.padEnd(12)} sentinel/baseline = ${ratio.toFixed(3)}x ${bad ? "  <-- DRIFTED" : ""}`);
}
console.log(drifted
    ? "\n  WARNING: the sentinel moved more than 5% from the baseline it duplicates.\n  The machine drifted (thermal/background load) DURING this sweep -- version deltas\n  in this run are not trustworthy. Quiesce the machine and re-run.\n"
    : "\n  OK: sentinel matches baseline. Thermal conditions were stable across the sweep.\n");
