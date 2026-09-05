// Zero-GC gate.  Run:  node --expose-gc zero-gc-gate.mjs
// (Re-execs itself with --max-semi-space-size=4 for sharp sensitivity.)
// Exit 0 = every steady-state scenario forces 0 scavenges AND the detector was
// validated against a known-allocating control. Exit 1 = allocation found.
// Exit 2 = detector failed self-validation (untrusted).
//
// CLAIM (precise): writing through an ALREADY-BUILT reactive graph allocates
// nothing — no closures/arrays/boxing on set / pull / flush; node & link churn
// is absorbed by the pool. Node CREATION is NOT claimed zero-GC: the callable
// API allocates 2 closures per signal, even a box allocates its wrapper. The
// pool removes internal NODE allocation, not the public HANDLE; the churn
// scenario proves the node recycles (pool never grows) via exact counters.

import { fileURLToPath } from "node:url";

if (!process.env.__ZGC_CHILD) {
  const { spawnSync } = await import("node:child_process");
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, ["--expose-gc", "--max-semi-space-size=4", self],
    { stdio: "inherit", env: { ...process.env, __ZGC_CHILD: "1" } });
  process.exit(r.status ?? 1);
}

const { measureScenario } = await import("./zgc-core.mjs");
const {
  ctrlPositive, ctrlNegative, steadyScenarios, churnBox,
  steadyPass, keepAlive, MAX_SCAVENGES,
} = await import("./zgc-scenarios.mjs");

function line(r) {
  return `${r.name}\n    scavenges  N:${String(r.minorLo).padStart(3)}  ${r.k}N:${String(r.minorHi).padStart(3)}` +
    `   poolGrowth Δ ${String(r.poolGrowthDelta_hi).padStart(3)}` +
    `   nodeAlloc Δ ${String(r.allocDelta_hi).padStart(9)}` +
    `   activeΔ ${String(r.activeDelta_hi).padStart(3)}` +
    `   retained ${r.retainedKB_hi.toFixed(0)}KB`;
}

const N = 200000, k = 8;
console.log(`Zero-GC gate — scavenge scaling (N=${N}, ${k}N=${k * N}); a zero-alloc window forces no young-gen GC.\n`);

const pos = await measureScenario(ctrlPositive, { N, k });
const neg = await measureScenario(ctrlNegative, { N, k });
console.log("== controls (prove the detector works) ==");
console.log(line(pos)); console.log(line(neg)); console.log("");

const detectorOK = pos.minorHi > MAX_SCAVENGES + 3 && neg.minorHi <= MAX_SCAVENGES;
if (!detectorOK) {
  console.log(`!! DETECTOR VALIDATION FAILED: positive forced ${pos.minorHi} scavenges (need >${MAX_SCAVENGES + 3}), ` +
    `negative ${neg.minorHi} (need <=${MAX_SCAVENGES}). Result not trustworthy.`);
  process.exit(2);
}
console.log(`detector validated: allocating control forced ${pos.minorHi} scavenges, no-op forced ${neg.minorHi}.\n`);

console.log("== steady-state scenarios (the zero-GC claim) ==");
const steady = [];
for (const sc of steadyScenarios) steady.push(await measureScenario(sc, { N, k }));
for (const r of steady) console.log(line(r));

console.log("\n== node recycling under churn (pool claim, via exact counters) ==");
const churn = await measureScenario(churnBox, { N, k });
console.log(line(churn));

const failures = steady.filter((r) => !steadyPass(r));
const churnRecycles = churn.poolGrowthDelta_hi === 0 && churn.activeDelta_hi === 0;

console.log("\n" + "=".repeat(72));
for (const r of steady) console.log(`  ${steadyPass(r) ? "PASS" : "FAIL"}  ${r.name}  (${r.minorHi} scavenges over ${(k * N).toLocaleString()} updates)`);
console.log(`  ${churnRecycles ? "OK  " : "WARN"}  churn: pool grew ${churn.poolGrowthDelta_hi}x over ${churn.allocDelta_hi.toLocaleString()} node allocations, net nodes ${churn.activeDelta_hi} (recycled). Handle allocates by design — signalBox is lightest.`);
console.log("=".repeat(72));

if (globalThis.__neverTrue) console.log(keepAlive());

if (failures.length === 0 && churnRecycles) {
  console.log(`\nZERO-GC GATE: PASS — ${steady.length}/${steady.length} steady-state scenarios force 0 scavenges and pull 0 nodes; pool recycles under churn.`);
  process.exit(0);
} else {
  const why = [...failures.map((f) => `${f.name} (${f.minorHi} scavenges)`), ...(churnRecycles ? [] : ["pool grew under churn"])];
  console.log(`\nZERO-GC GATE: FAIL — ${why.join("; ")}`);
  process.exit(1);
}
