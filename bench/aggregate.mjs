// Aggregate per-engine bench-runs/*.txt into one comparison table.
// Reads every bench-runs/<engine>-rep<N>.txt, medians each engine's per-scenario
// median across reps, prints engines side by side + each lite version vs alien.
import {readdirSync, readFileSync} from "node:fs";

import {ENGINE_KEYS, ENGINES} from "./frameworks.mjs";

const SCENARIOS = ["KAIROS", "BROADCAST", "DEEP CHAIN", "MUX", "DYNAMIC DAG",
    "SELECTIVE DAG", "LARGE WEB APP", "WIDE DENSE", "SMALL SELECTIVE"];
const ENGINE_LIST = ENGINE_KEYS;
const LABEL = Object.fromEntries(ENGINES.map((e) => [e.key, e.label || e.key]));

const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
};

// data[engine][scenario] = [median-of-run per rep]
const data = {};
for (const f of readdirSync("bench-runs")) {
    const m = f.match(/^(.+)-rep\d+\.txt$/);
    if (!m) continue;
    const eng = m[1];
    const txt = readFileSync(`bench-runs/${f}`, "utf8");
    const lines = txt.split("\n");
    let sc = null;
    for (const line of lines) {
        for (const s of SCENARIOS) if (line.startsWith(s)) sc = s;
        const mm = line.match(/median=\s*([\d.]+)ms/);
        if (mm && sc) {
            (data[eng] ??= {});
            (data[eng][sc] ??= []).push(parseFloat(mm[1]));
            sc = null; // each scenario header is followed by exactly one data line per engine
        }
    }
}

const meds = {};
for (const eng of ENGINE_LIST) {
    meds[eng] = {};
    for (const s of SCENARIOS) {
        const vals = data[eng]?.[s];
        if (vals && vals.length) meds[eng][s] = median(vals);
    }
}

// Table
const w = 13;
let hdr = "scenario".padEnd(18);
for (const e of ENGINE_LIST) hdr += (LABEL[e]).padStart(w);
console.log(hdr);
console.log("-".repeat(hdr.length));
for (const s of SCENARIOS) {
    let row = s.padEnd(18);
    for (const e of ENGINE_LIST) {
        const v = meds[e]?.[s];
        row += (v != null ? v.toFixed(1) + "ms" : "--").padStart(w);
    }
    console.log(row);
}

// Each lite version vs alien (% ahead; positive = lite faster)
console.log("\n% ahead of alien-signals (positive = lite faster):");
const liteVers = ENGINES.filter((e) => e.kind === "lite").map((e) => e.key);
let h2 = "scenario".padEnd(18);
for (const e of liteVers) h2 += (LABEL[e]).padStart(w);
console.log(h2);
console.log("-".repeat(h2.length));
for (const s of SCENARIOS) {
    const al = meds["alien-signals"]?.[s];
    let row = s.padEnd(18);
    for (const e of liteVers) {
        const v = meds[e]?.[s];
        if (v != null && al != null) {
            const pct = (al - v) / al * 100;
            row += ((pct >= 0 ? "+" : "") + pct.toFixed(0) + "%").padStart(w);
        } else row += "--".padStart(w);
    }
    console.log(row);
}

// Win count per version
console.log("\nWins vs alien (scenarios where lite is faster):");
for (const e of liteVers) {
    let wins = 0, total = 0;
    for (const s of SCENARIOS) {
        const v = meds[e]?.[s], al = meds["alien-signals"]?.[s];
        if (v != null && al != null) {
            total++;
            if (v < al) wins++;
        }
    }
    console.log(`  ${(LABEL[e]).padEnd(14)} ${wins}/${total}`);
}
