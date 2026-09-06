import { execFileSync } from "node:child_process";
const COMBOS = [
    { label: "1.5.0",       engineDir: "v15", mode: "eager" },
    { label: "1.6.0",       engineDir: "v16", mode: "eager" },
    { label: "1.7.0-eager", engineDir: "v17", mode: "eager" },
    { label: "1.7.0-sab",   engineDir: "v17", mode: "sab"   },
];
const COLD = parseInt(process.env.COLD || "3", 10);
const BENCH_RUNS = parseInt(process.env.BENCH_RUNS || "10", 10);
const TESTS = [
    "updateComputations1to1", "updateComputations2to1", "updateComputations4to1",
    "updateComputations1000to1", "updateComputations1to2", "updateComputations1to4",
    "updateComputations1to1000",
];

function runOne(combo) {
    const out = execFileSync("node", ["--expose-gc", "sbench-runner.mjs", combo.engineDir, combo.mode],
        { encoding: "utf8", cwd: process.cwd(), env: { ...process.env, BENCH_RUNS: String(BENCH_RUNS) }});
    return JSON.parse(out.trim());
}

const all = {};
for (const combo of COMBOS) {
    all[combo.label] = [];
    for (let cp = 0; cp < COLD; cp++) {
        process.stderr.write(`[${combo.label}] cold ${cp+1}/${COLD}... `);
        const t0 = Date.now();
        all[combo.label].push(runOne(combo));
        process.stderr.write(`${((Date.now()-t0)/1000).toFixed(1)}s\n`);
    }
}

function median(arr) { const s = [...arr].sort((a,b)=>a-b); return s[Math.floor((s.length-1)/2)]; }

console.log(`\n=== sBench update group (Andrii verbatim, ${BENCH_RUNS} BENCH_RUNS × ${COLD} cold processes) ===\n`);
const hdr = "Test                       | " + COMBOS.map(c => c.label.padStart(12)).join(" | ");
console.log(hdr);
console.log("-".repeat(hdr.length));
for (const t of TESTS) {
    const row = [t.padEnd(26)];
    for (const combo of COMBOS) {
        // Aggregate all samples from all cold processes for this test+combo
        const allSamples = all[combo.label].flatMap(run => run.results[t].samples);
        const med = median(allSamples);
        row.push((med.toFixed(2) + " ms").padStart(12));
    }
    console.log(row.join(" | "));
}

console.log(`\n=== Speedup vs 1.6.0 ===\n`);
console.log(hdr);
console.log("-".repeat(hdr.length));
for (const t of TESTS) {
    const row = [t.padEnd(26)];
    const base = median(all["1.6.0"].flatMap(r => r.results[t].samples));
    for (const combo of COMBOS) {
        const med = median(all[combo.label].flatMap(r => r.results[t].samples));
        row.push(((base/med).toFixed(2) + "x").padStart(12));
    }
    console.log(row.join(" | "));
}

console.log(`\n=== Noise (max/min of per-cold-process medians) ===\n`);
console.log(hdr);
console.log("-".repeat(hdr.length));
for (const t of TESTS) {
    const row = [t.padEnd(26)];
    for (const combo of COMBOS) {
        const meds = all[combo.label].map(r => r.results[t].median);
        const noise = Math.max(...meds) / Math.min(...meds);
        row.push((noise.toFixed(2) + "x").padStart(12));
    }
    console.log(row.join(" | "));
}

console.log(`\n=== Min-of-mins (cleanest signal -- best cache state) ===\n`);
console.log(hdr);
console.log("-".repeat(hdr.length));
for (const t of TESTS) {
    const row = [t.padEnd(26)];
    for (const combo of COMBOS) {
        const allSamples = all[combo.label].flatMap(run => run.results[t].samples);
        const min = Math.min(...allSamples);
        row.push((min.toFixed(2) + " ms").padStart(12));
    }
    console.log(row.join(" | "));
}
