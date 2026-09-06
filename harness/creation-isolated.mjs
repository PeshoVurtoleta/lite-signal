// andrii-creation-isolated.mjs
// Per-framework-per-process runner. Each framework runs in its own node process
// so V8's IC sites can't go megamorphic from seeing multiple framework adapters.
// This is what Andrii's harness does via fork() per scenario.

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

const FRAMEWORKS = ["v120", "v121", "alien"];
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
      if (code !== 0) return reject(new Error(`child ${framework}/${row} exit ${code}: ${out}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`bad child output: ${out}`)); }
    });
  });
}

console.log(`Andrii sBench creation rows, ISOLATED (one process per framework per row)`);
console.log(`Node ${process.version}, BENCH_RUNS=${BENCH_RUNS}`);
console.log();

const results = {};
for (const row of ROWS) {
  results[row] = {};
  for (const fw of FRAMEWORKS) {
    const r = await runChild(fw, row);
    results[row][fw] = r;
  }
  const v120 = results[row].v120, v121 = results[row].v121, ali = results[row].alien;
  console.log(
    row.padEnd(32),
    "|",
    `v120 ${v120.min.toFixed(2).padStart(7)}ms`,
    "|",
    `v121 ${v121.min.toFixed(2).padStart(7)}ms`,
    "|",
    `ali ${ali.min.toFixed(2).padStart(7)}ms`,
    "|",
    `v120/ali ${(v120.min/ali.min).toFixed(2).padStart(6)}x`,
    "|",
    `v121/ali ${(v121.min/ali.min).toFixed(2).padStart(6)}x`,
    "|",
    `v121/v120 ${(v120.min/v121.min).toFixed(2).padStart(5)}x`,
  );
}

console.log();
console.log("--- per-sample detail ---");
for (const row of ROWS) {
  const v120 = results[row].v120, v121 = results[row].v121, ali = results[row].alien;
  console.log(`${row.padEnd(32)}  v120=[${v120.samples.map(s=>s.toFixed(1)).join(",")}]  v121=[${v121.samples.map(s=>s.toFixed(1)).join(",")}]  ali=[${ali.samples.map(s=>s.toFixed(2)).join(",")}]`);
}

function geoMean(xs) {
  return Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
}
const creationRows = ROWS.filter(r => r.startsWith("createComputations"));
const v120ratios = creationRows.map(r => results[r].v120.min / results[r].alien.min);
const v121ratios = creationRows.map(r => results[r].v121.min / results[r].alien.min);
console.log();
console.log(`creation group geo mean (vs alien) — v1.2.0: ${geoMean(v120ratios).toFixed(3)}x, v1.2.1: ${geoMean(v121ratios).toFixed(3)}x`);
console.log(`worksheet baseline (Andrii's MBP): 6.244x`);
console.log(`v120 createDataSignals/ali: ${(results.createDataSignals.v120.min/results.createDataSignals.alien.min).toFixed(2)}x  (worksheet: 1.22x)`);
console.log(`v121 createDataSignals/ali: ${(results.createDataSignals.v121.min/results.createDataSignals.alien.min).toFixed(2)}x`);
