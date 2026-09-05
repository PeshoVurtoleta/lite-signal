// trend.mjs
// Cross-SIBLING creation trend: runs the Andrii creation rows against every
// LiteSignal version folder that exists next to this repo (the 1.5.0-1.9.0
// pre-release engines plus this tree), one process per (version, row), and
// flags >10% hops between ADJACENT versions -- answering "which version
// introduced this cost" BEFORE a forward-port commits to it.
//
// The update/read/write lanes already have their cross-version gate
// (harness/VersionMatrix, same-host medians with tolerances); creation is the
// lane that had nothing, and it is also the weakest competitive axis -- so
// this tool watches exactly that lane across the sibling line.
//
// ADVISORY: flags are printed, exit is 0 unless a sibling fails to run at
// all. Timing hops on a diagnostic run are leads, not verdicts -- confirm a
// flagged hop with the flagged version's own VersionMatrix + torture before
// acting on it.
//
// Usage: node harness/trend.mjs
//        BENCH_RUNS=8 node harness/trend.mjs
//        TREND_ROWS=createDataSignals,createComputations1to1 node harness/trend.mjs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_RUNS = parseInt(process.env.BENCH_RUNS || "6", 10);
const HOP_PCT = Number(process.env.TREND_HOP_PCT || 10);

const ROWS = process.env.TREND_ROWS
    ? process.env.TREND_ROWS.split(",").map((s) => s.trim())
    : ["createDataSignals", "createComputations1to1", "createComputations1to8", "createComputations1to1000"];

// The sibling line, oldest first. This tree (../) is the canonical engine;
// the version folders carry the pre-release 1.6-1.9 engines.
const CANDIDATES = [
    { label: "canonical", dir: join(HERE, "..") },
    { label: "1.6.0", dir: join(HERE, "../../LiteSignal1.6.0") },
    { label: "1.7.0", dir: join(HERE, "../../LiteSignal1.7.0") },
    { label: "1.8.0", dir: join(HERE, "../../LiteSignal1.8.0") },
    { label: "1.9.0", dir: join(HERE, "../../LiteSignal1.9.0") },
];

const SIBS = CANDIDATES.filter((c) => existsSync(join(c.dir, "Signal.js")));
if (SIBS.length < 2) {
    console.error(`trend: only ${SIBS.length} engine(s) found -- a trend needs at least 2 sibling versions`);
    for (const c of CANDIDATES) console.error(`  ${existsSync(join(c.dir, "Signal.js")) ? "found  " : "missing"} ${c.dir}`);
    process.exit(2);
}

function runChild(engineDir, row) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            "--expose-gc",
            join(HERE, "andrii-isolated-child.mjs"),
            "tree", row,
        ], {
            env: { ...process.env, BENCH_RUNS: String(BENCH_RUNS), LITE_TREE_PATH: join(engineDir, "Signal.js") },
            stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.on("exit", (code) => {
            // A child that FAILS (smoke oracle, bad row) exits 1 AFTER emitting
            // its error JSON -- parse it so the runner's per-row accounting and
            // n/a rendering actually run (2026-08 review: rejecting on any
            // nonzero exit made every error path dead code and one bad child
            // aborted the whole matrix). Reject only on unparseable output.
            try {
                const parsed = JSON.parse(out);
                // Fail CLOSED: a nonzero exit whose JSON claims neither error
                // nor unavailability must not resolve as a success row.
                if (code !== 0 && !parsed.error && !parsed.unavailable) parsed.error = `child exit ${code} with no error field`;
                return resolve(parsed);
            } catch { /* not JSON */ }
            reject(new Error(`child ${engineDir}/${row} exit ${code}: ${out.slice(0, 400)}`));
        });
    });
}

console.log(`creation trend across the sibling line -- min-of-${BENCH_RUNS}, one process per (version, row)`);
console.log(`Node ${process.version}; hop threshold ${HOP_PCT}% between adjacent versions`);
console.log();

const results = {};       // row -> [{label, version, min}]
const versions = {};
for (const row of ROWS) {
    results[row] = [];
    for (const sib of SIBS) {
        const r = await runChild(sib.dir, row);
        if (r.unavailable || r.error) { console.error(`  FAIL: ${sib.label}/${row}: ${r.reason || r.error}`); process.exit(2); }
        versions[sib.label] = r.version;
        results[row].push({ label: sib.label, version: r.version, min: r.min });
    }
}

console.log("engines: " + SIBS.map((s) => `${s.label}=${versions[s.label]}`).join("  "));
console.log();
console.log("  " + "row".padEnd(28) + SIBS.map((s) => s.label.padStart(12)).join("") + "   hops");

let flagged = 0;
for (const row of ROWS) {
    const cells = results[row].map((r) => (r.min.toFixed(2) + "ms").padStart(12));
    const hops = [];
    for (let i = 1; i < results[row].length; i++) {
        const prev = results[row][i - 1], cur = results[row][i];
        const pct = (cur.min / prev.min - 1) * 100;
        if (Math.abs(pct) > HOP_PCT) {
            hops.push(`${prev.label}->${cur.label} ${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`);
            flagged++;
        }
    }
    console.log("  " + row.padEnd(28) + cells.join("") + (hops.length ? "   ! " + hops.join(", ") : ""));
}

console.log();
if (flagged) {
    console.log(`${flagged} hop(s) over ${HOP_PCT}% flagged -- confirm each against that version's own VersionMatrix + torture before acting`);
} else {
    console.log(`no hop over ${HOP_PCT}% between adjacent versions`);
}
process.exit(0);
