// creation-isolated.mjs
// Andrii sBench creation rows, one node process per framework per row (IC
// isolation, same as Andrii's fork-per-scenario). Drives
// andrii-isolated-child.mjs and renders lite-vs-alien creation ratios.
//
// 2026-08 audit Phase 3 repairs: frameworks are "npm" (installed
// @zakkster/lite-signal), "tree" (../Signal.js working tree) and "alien"
// (alien-signals, resolved through bench/node_modules) -- the old
// "v120"/"v121" labels imported OTHER versions than they claimed. Every
// result row carries the child's RESOLVED version string. A missing
// competitor renders n/a (the ratios just vanish); a missing or smoke-failing
// LITE framework is a hard failure. Growth-contaminated samples (the pool
// grew inside a timed body) are flagged loudly instead of silently shaping
// min().
//
// This is a DIAGNOSTIC instrument for the weak-side program, never a gate:
// cross-framework numbers are positioning context (bench/sweep.mjs REPS=30 is
// the publishable runner); the gates live in bench/torture and VersionMatrix.
//
// Usage: node harness/creation-isolated.mjs
//        BENCH_RUNS=8 node harness/creation-isolated.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROWS = [
    "createDataSignals",
    "createComputations0to1",
    "createComputations1to1",
    "createComputations2to1",
    "createComputations4to1",
    "createComputations1000to1",
    "createComputations1to2",
    "createComputations1to4",
    "createComputations1to8",
    "createComputations1to1000",
];

const FRAMEWORKS = ["npm", "tree", "alien"];
const LITE_FRAMEWORKS = new Set(["npm", "tree"]);
const BENCH_RUNS = parseInt(process.env.BENCH_RUNS || "4", 10);

function runChild(framework, row) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            "--expose-gc",
            fileURLToPath(new URL("./andrii-isolated-child.mjs", import.meta.url)),
            framework,
            row,
        ], {
            env: { ...process.env, BENCH_RUNS: String(BENCH_RUNS) },
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
            reject(new Error(`child ${framework}/${row} exit ${code}: ${out.slice(0, 400)}`));
        });
    });
}

console.log("Andrii sBench creation rows, ISOLATED (one process per framework per row)");
console.log(`Node ${process.version}, BENCH_RUNS=${BENCH_RUNS}`);

const versions = {};          // framework -> resolved version string
const unavailable = {};       // framework -> reason
const results = {};
let failed = 0;
let growthFlags = 0;

for (const row of ROWS) {
    results[row] = {};
    for (const fw of FRAMEWORKS) {
        if (unavailable[fw]) continue;                     // already known-absent
        const r = await runChild(fw, row);
        if (r.error) {
            console.error(`  FAIL [${fw}/${row}]: ${r.error}`);
            failed++;
            continue;
        }
        if (r.unavailable) {
            if (LITE_FRAMEWORKS.has(fw)) {
                console.error(`  FAIL: lite framework "${fw}" is unavailable -- ${r.reason}`);
                failed++;
            } else {
                console.log(`  note: ${fw} not installed here (${r.reason.split("\n")[0]}) -- rendering n/a`);
            }
            unavailable[fw] = r.reason;
            continue;
        }
        versions[fw] = r.version;
        results[row][fw] = r;
        if (r.growth && r.growth.some((g) => g > 0)) {
            growthFlags++;
            console.error(`  ! growth-contaminated sample(s) [${fw}/${row}]: pool grew inside the timed body (${r.growth.join(",")}) -- resize LITE_SIZES before trusting this row`);
        }
    }
}

console.log();
console.log("resolved versions: " + FRAMEWORKS.map((f) => `${f}=${versions[f] || "n/a"}`).join("  "));
console.log();

const fmt = (r) => (r ? `${r.min.toFixed(2).padStart(7)}ms` : "    n/a");
const ratio = (a, b) => (a && b ? (a.min / b.min).toFixed(2).padStart(6) + "x" : "   n/a");

for (const row of ROWS) {
    const npm = results[row].npm, tree = results[row].tree, ali = results[row].alien;
    console.log(
        row.padEnd(28), "|",
        `npm ${fmt(npm)}`, "|",
        `tree ${fmt(tree)}`, "|",
        `alien ${fmt(ali)}`, "|",
        `npm/alien ${ratio(npm, ali)}`, "|",
        `tree/alien ${ratio(tree, ali)}`, "|",
        `npm/tree ${ratio(npm, tree)}`,
    );
}

console.log();
console.log("--- per-sample detail (min is reported; growth flags mark pool growth inside a timed body) ---");
for (const row of ROWS) {
    const cells = FRAMEWORKS
        .filter((f) => results[row][f])
        .map((f) => {
            const r = results[row][f];
            const g = r.growth && r.growth.some((x) => x > 0) ? " GREW" : "";
            return `${f}=[${r.samples.map((s) => s.toFixed(2)).join(",")}]${g}`;
        });
    console.log(`${row.padEnd(28)}  ${cells.join("  ")}`);
}

function geoMean(xs) {
    return Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
}
const creationRows = ROWS.filter((r) => r.startsWith("createComputations"));
if (results[creationRows[0]].alien) {
    for (const fw of ["npm", "tree"]) {
        if (!results[creationRows[0]][fw]) continue;
        const ratios = creationRows.map((r) => results[r][fw].min / results[r].alien.min);
        console.log();
        console.log(`${fw} (${versions[fw]}) creation-group geomean vs alien ${versions.alien}: ${geoMean(ratios).toFixed(3)}x`);
        const ds = results.createDataSignals;
        if (ds[fw] && ds.alien) console.log(`${fw} createDataSignals vs alien: ${(ds[fw].min / ds.alien.min).toFixed(2)}x`);
    }
} else {
    console.log();
    console.log("alien-signals unavailable -- no competitive ratios (install it in bench/: npm --prefix bench install)");
}

if (failed) { console.error(`\n${failed} framework failure(s)`); process.exit(1); }
if (growthFlags) console.error(`\nnote: ${growthFlags} growth-contaminated row(s) flagged above -- numbers are shown but not trustworthy for those rows`);
process.exit(0);
