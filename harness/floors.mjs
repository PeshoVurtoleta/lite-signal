// floors.mjs
// Advisory competitive-floor dashboard for the CREATION lane: tree-vs-alien
// ratios per Andrii creation row, classified WITHIN / DRIFTING / OUTSIDE
// against recorded bands, with per-version history persisted to
// harness/floors-history.json.
//
// STRUCTURALLY NEVER A GATE -- this file always exits 0 (except when it
// cannot run at all). The denominator is a COMPETITOR'S moving number: an
// alien-signals release, a Node upgrade, or a different host shifts every
// ratio without lite changing a byte, so wiring these bands to an exit code
// would gate our releases on someone else's roadmap. The engine's own gates
// are bench/torture (structural) and harness/VersionMatrix (same-host
// timing); this dashboard exists to make competitive DRIFT visible early and
// to timestamp it against versions.
//
// Bands (recorded in the history file, editable): per row,
//   WITHIN   ratio <= band.within
//   DRIFTING ratio <= band.outside
//   OUTSIDE  beyond -- investigate (a lite regression, an alien improvement,
//            or a host change; the history rows disambiguate which).
//
// Usage: node harness/floors.mjs               # run, classify, append history
//        node harness/floors.mjs --no-record   # run + classify only
//        BENCH_RUNS=8 node harness/floors.mjs

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = join(HERE, "floors-history.json");
const NO_RECORD = process.argv.includes("--no-record");
const BENCH_RUNS = parseInt(process.env.BENCH_RUNS || "6", 10);

const ROWS = [
    "createDataSignals",
    "createComputations1to1",
    "createComputations2to1",
    "createComputations1to8",
    "createComputations1to1000",
];

// Default bands, used only when the history file has none yet. Calibrated
// 2026-08 (Apple M4 Pro, Node 26, alien 3.2.1) AGAINST THE DCE-FIXED child:
// with every created handle stored into a live sink, honest ratios land
// 2.3-5.2x per row (geomean ~3.4x). The pre-fix child let TurboFan elide
// alien's discarded creations, inflating ratios to 8-25x -- bands calibrated
// on those numbers would never fire. "within" sits ~1.5x above the observed
// honest ratio, "outside" ~2.5x; this dashboard flags DRIFT, not noise.
// Tighten per-row in floors-history.json as history accumulates.
const DEFAULT_BANDS = {
    createDataSignals: { within: 6, outside: 10 },
    createComputations1to1: { within: 7, outside: 12 },
    createComputations2to1: { within: 5, outside: 9 },
    createComputations1to8: { within: 4.5, outside: 8 },
    createComputations1to1000: { within: 6, outside: 10 },
};

function runChild(framework, row) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            "--expose-gc",
            join(HERE, "andrii-isolated-child.mjs"),
            framework, row,
        ], { env: { ...process.env, BENCH_RUNS: String(BENCH_RUNS) }, stdio: ["ignore", "pipe", "inherit"] });
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

const history = existsSync(HISTORY_PATH) ? JSON.parse(readFileSync(HISTORY_PATH, "utf8")) : { bands: DEFAULT_BANDS, entries: [] };
const bands = history.bands || DEFAULT_BANDS;

console.log("competitive floors -- tree vs alien, creation lane (ADVISORY; never exit-coded)");
console.log(`Node ${process.version}, BENCH_RUNS=${BENCH_RUNS}`);
console.log();

const ratios = {};
let treeVersion = null, alienVersion = null;
for (const row of ROWS) {
    const tree = await runChild("tree", row);
    if (tree.unavailable || tree.error) { console.error(`  FAIL: tree/${row}: ${tree.reason || tree.error}`); process.exit(2); }
    const alien = await runChild("alien", row);
    if (alien.unavailable) {
        console.log(`  ${row.padEnd(28)} n/a -- alien-signals not installed (npm --prefix bench install)`);
        continue;
    }
    if (alien.error) { console.error(`  FAIL: alien/${row}: ${alien.error}`); process.exit(2); }
    treeVersion = tree.version; alienVersion = alien.version;
    const ratio = tree.min / alien.min;
    ratios[row] = +ratio.toFixed(3);
    const b = bands[row] || { within: Infinity, outside: Infinity };
    const status = ratio <= b.within ? "WITHIN  " : ratio <= b.outside ? "DRIFTING" : "OUTSIDE ";
    console.log(
        `  ${row.padEnd(28)} ${ratio.toFixed(2).padStart(7)}x   ${status}` +
        `  (bands ${b.within}/${b.outside}; tree ${tree.min.toFixed(2)}ms, alien ${alien.min.toFixed(2)}ms)`
    );
}

const vals = Object.values(ratios);
if (vals.length) {
    const geo = Math.exp(vals.reduce((a, x) => a + Math.log(x), 0) / vals.length);
    console.log(`\n  geomean ${geo.toFixed(3)}x   tree=${treeVersion}  alien=${alienVersion}`);

    if (!NO_RECORD) {
        history.entries.push({
            date: new Date().toISOString(),
            tree: treeVersion,
            alien: alienVersion,
            node: process.version,
            cpu: (os.cpus()[0] || {}).model || "unknown",
            geomean: +geo.toFixed(3),
            ratios,
        });
        history.bands = bands;
        writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
        console.log(`  recorded -> ${HISTORY_PATH} (${history.entries.length} entr${history.entries.length === 1 ? "y" : "ies"})`);
    }
    if (history.entries.length > 1) {
        console.log("\n  history (last 5):");
        for (const e of history.entries.slice(-5)) {
            console.log(`    ${e.date.slice(0, 10)}  tree ${e.tree}  alien ${e.alien}  node ${e.node}  geomean ${e.geomean}x`);
        }
    }
}
process.exit(0);
