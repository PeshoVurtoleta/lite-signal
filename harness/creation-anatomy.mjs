// creation-anatomy.mjs
// DECOMPOSES the callable signal's birth tax -- the weakest competitive axis
// (Andrii creation group; see harness/creation-isolated.mjs for the ground
// truth this tool explains). One lane per child process (IC isolation), fresh
// pre-sized world per sample.
//
// REAL lanes (actual engines):
//   signal / signalBox / computed / computedBox   ../Signal.js (tree)
//   alien-signal / alien-computed                 alien-signals via bench/
//
// MODEL lanes (synthetic constructors isolating one suspected stage):
//   model-pool-write        pool pop + 6 lifetime-field writes (createNode's
//                           recycle path, no handle at all) -- the floor
//   model-closures          2 closures over a captured node, no stamps
//   model-closures-stamps   + the six property stamps (4 named + 2 symbol)
//                           the callable adds -- the prime-suspect delta
//   model-object-handle     Object.create(proto) + 2 symbol fields (the box
//                           shape without the engine)
//
// ATTRIBUTION (printed at the end):
//   callable-handle tax   = signal - signalBox            (real, engine-level)
//   stamp tax (model)     = closures-stamps - closures    (shape transitions)
//   closure tax (model)   = closures - object-handle      (2 closures vs 1 obj)
//   pool floor (model)    = pool-write                    (bookkeeping minimum)
//   alien reference       = alien-signal                  (what "cheap" means)
//
// Model lanes are MODELS: they bound and rank the stages, they do not add up
// to the real number exactly (the engine interleaves these costs with owner
// wiring, stats counters and the equals branch). When the model ranking and
// the real deltas agree, the attribution is trustworthy; when they diverge,
// trust the REAL deltas and treat the model as a hypothesis to refine.
//
// DIAGNOSTIC ONLY -- never a gate. Gates live in bench/torture + VersionMatrix.
//
// Usage: node harness/creation-anatomy.mjs
//        BENCH_RUNS=10 COUNT=200000 node harness/creation-anatomy.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const LANES = [
    "model-pool-write",
    "model-object-handle",
    "model-closures",
    "model-closures-stamps",
    "signalBox",
    "signal",
    "computedBox",
    "computed",
    "alien-signal",
    "alien-computed",
];

const BENCH_RUNS = parseInt(process.env.BENCH_RUNS || "6", 10);
const COUNT = parseInt(process.env.COUNT || "100000", 10);

function runChild(laneName) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            "--expose-gc",
            fileURLToPath(new URL("./creation-anatomy-child.mjs", import.meta.url)),
            laneName,
        ], {
            env: { ...process.env, BENCH_RUNS: String(BENCH_RUNS), COUNT: String(COUNT) },
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
            reject(new Error(`child ${laneName} exit ${code}: ${out.slice(0, 400)}`));
        });
    });
}

console.log("creation anatomy -- one lane per process, fresh world per sample");
console.log(`Node ${process.version}, BENCH_RUNS=${BENCH_RUNS}, COUNT=${COUNT.toLocaleString()}`);
console.log();

const R = {};
let failed = 0;
for (const laneName of LANES) {
    const r = await runChild(laneName);
    if (r.error) { console.error(`  FAIL [${laneName}]: ${r.error}`); failed++; continue; }
    if (r.unavailable) { console.log(`  ${laneName.padEnd(22)} n/a (${r.reason.split("\n")[0]})`); continue; }
    R[laneName] = r;
    const grew = r.growth && r.growth.some((g) => g > 0) ? "  ! POOL GREW in a timed body" : "";
    console.log(
        `  ${laneName.padEnd(22)} ${r.nsPerOp.toFixed(1).padStart(8)} ns/op   ` +
        `min ${r.min.toFixed(2).padStart(7)}ms  samples [${r.samples.map((s) => s.toFixed(2)).join(",")}]` +
        (r.version !== "n/a" ? `  (${r.version})` : "") + grew
    );
}

const ns = (l) => (R[l] ? R[l].nsPerOp : null);
const delta = (a, b) => (ns(a) !== null && ns(b) !== null ? ns(a) - ns(b) : null);
const show = (label, v, note) =>
    console.log(`  ${label.padEnd(26)} ${v === null ? "     n/a" : v.toFixed(1).padStart(8) + " ns"}  ${note}`);

console.log();
console.log("attribution (ns per creation):");
show("callable-handle tax", delta("signal", "signalBox"), "REAL: signal - signalBox (the function handle vs the box)");
show("stamp tax (model)", delta("model-closures-stamps", "model-closures"), "MODEL: six property stamps on a function object");
show("closure tax (model)", delta("model-closures", "model-object-handle"), "MODEL: two closures vs one prototyped object");
show("pool floor (model)", ns("model-pool-write"), "MODEL: pool pop + lifetime-field writes, no handle");
show("computed-handle tax", delta("computed", "computedBox"), "REAL: computed - computedBox");
show("box vs alien (signal)", delta("signalBox", "alien-signal"), "REAL: what remains after removing the callable handle");
show("alien reference", ns("alien-signal"), "REAL: alien.signal creation");
show("alien computed ref", ns("alien-computed"), "REAL: alien.computed creation (lazy, like ours)");

if (ns("signal") !== null && ns("alien-signal") !== null) {
    console.log();
    console.log(`  signal/alien ratio: ${(ns("signal") / ns("alien-signal")).toFixed(2)}x   ` +
        `signalBox/alien: ${(ns("signalBox") / ns("alien-signal")).toFixed(2)}x`);
}
if (failed) { console.error(`\n${failed} lane failure(s)`); process.exit(1); }
process.exit(0);
