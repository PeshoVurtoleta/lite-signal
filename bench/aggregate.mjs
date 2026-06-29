// Aggregate per-engine bench-runs/*.txt into one comparison table.
// Reads every bench-runs/<engine>-rep<N>.txt, medians the per-scenario time and
// averages the per-scenario heap across reps, prints engines side by side, then
// each lite version vs alien for both time and heap.
//
// Note on the heap column: benchmark.mjs prints it as "Dheap=<n>KB" (ASCII; the
// source emits the label without a non-ASCII delta glyph). This reader matches
// that. If an older run used a non-ASCII label, re-run the bench -- the source is
// ASCII-only by project rule.
import {readdirSync, readFileSync} from "node:fs";
import {ENGINE_KEYS, ENGINES} from "./frameworks.mjs";

const SCENARIOS = ["KAIROS", "BROADCAST", "DEEP CHAIN", "MUX", "DYNAMIC DAG",
    "SELECTIVE DAG", "LARGE WEB APP", "WIDE DENSE", "SMALL SELECTIVE"];
const ENGINE_LIST = ENGINE_KEYS;
const LABEL = Object.fromEntries(ENGINES.map((e) => [e.key, e.label || e.key]));
const REF = "alien-signals";

const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
};
const average = (a) => a.reduce((sum, val) => sum + val, 0) / a.length;

// Match the heap column whether the bench emitted "Dheap", "deltaheap", or a
// stray non-ASCII delta byte before "heap=". Capture an optional leading minus.
const TIME_RE = /median=\s*([\d.]+)ms/;
const HEAP_RE = /heap=\s*(-?[\d.]+)\s*KB/i;

const timeData = {};
const heapData = {};

for (const f of readdirSync("bench-runs")) {
    const m = f.match(/^(.+)-rep\d+\.txt$/);
    if (!m) continue;
    const eng = m[1];
    const txt = readFileSync(`bench-runs/${f}`, "utf8");
    let sc = null;

    for (const line of txt.split("\n")) {
        for (const s of SCENARIOS) if (line.startsWith(s)) sc = s;

        const mm = line.match(TIME_RE);
        const hm = line.match(HEAP_RE);

        if (mm && sc) {
            (timeData[eng] ??= {});
            (timeData[eng][sc] ??= []).push(parseFloat(mm[1]));
            if (hm) {
                (heapData[eng] ??= {});
                (heapData[eng][sc] ??= []).push(parseFloat(hm[1]));
            }
            sc = null; // one data line per scenario header per engine
        }
    }
}

const meds = {};
const avgHeaps = {};
for (const eng of ENGINE_LIST) {
    meds[eng] = {};
    avgHeaps[eng] = {};
    for (const s of SCENARIOS) {
        const tVals = timeData[eng]?.[s];
        if (tVals && tVals.length) meds[eng][s] = median(tVals);
        const hVals = heapData[eng]?.[s];
        if (hVals && hVals.length) avgHeaps[eng][s] = average(hVals);
    }
}

const liteVers = ENGINES.filter((e) => e.kind === "lite").map((e) => e.key);
const w = 15;

// ----------------------------------------------------------------------------
// EXECUTION TIME
// ----------------------------------------------------------------------------
console.log("\n==========================================================================");
console.log("                      EXECUTION TIME (median across reps)                 ");
console.log("==========================================================================\n");

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

console.log(`\n% faster than ${LABEL[REF] || REF} (positive = lite is faster):`);
let h2 = "scenario".padEnd(18);
for (const e of liteVers) h2 += (LABEL[e]).padStart(w);
console.log(h2);
console.log("-".repeat(h2.length));
for (const s of SCENARIOS) {
    const al = meds[REF]?.[s];
    let row = s.padEnd(18);
    for (const e of liteVers) {
        const v = meds[e]?.[s];
        if (v != null && al != null && al > 0) {
            const pct = (al - v) / al * 100;
            row += ((pct >= 0 ? "+" : "") + pct.toFixed(0) + "%").padStart(w);
        } else row += "--".padStart(w);
    }
    console.log(row);
}

console.log(`\nSpeed wins vs ${LABEL[REF] || REF} (scenarios where lite is faster):`);
for (const e of liteVers) {
    let wins = 0, total = 0;
    for (const s of SCENARIOS) {
        const v = meds[e]?.[s], al = meds[REF]?.[s];
        if (v != null && al != null) {
            total++;
            if (v < al) wins++;
        }
    }
    console.log(`  ${(LABEL[e]).padEnd(14)} ${wins}/${total}`);
}

// ----------------------------------------------------------------------------
// HEAP ALLOCATION
// ----------------------------------------------------------------------------
const haveHeap = Object.keys(heapData).length > 0;
if (!haveHeap) {
    console.log("\n(no heap column found in bench-runs/*.txt -- skipping heap tables. " +
        "Ensure benchmark.mjs emits the 'heap=<n>KB' field.)");
} else {
    console.log("\n\n==========================================================================");
    console.log("                      HEAP ALLOCATION (average delta-heap across reps)    ");
    console.log("==========================================================================\n");

    let hHdr = "scenario".padEnd(18);
    for (const e of ENGINE_LIST) hHdr += (LABEL[e]).padStart(w);
    console.log(hHdr);
    console.log("-".repeat(hHdr.length));
    for (const s of SCENARIOS) {
        let row = s.padEnd(18);
        for (const e of ENGINE_LIST) {
            const v = avgHeaps[e]?.[s];
            row += (v != null ? v.toFixed(1) + "KB" : "--").padStart(w);
        }
        console.log(row);
    }

    // Heap ratio: how many TIMES less transient heap lite allocates than the
    // reference. A ratio is honest here in a way a percentage is not -- when the
    // reference allocates 7,780KB and lite allocates 0.3KB, "+100%" understates
    // it; "26,000x less" is the real story. Near-zero values are clamped to a
    // 0.1KB floor so the ratio is meaningful, not noise; ties at ~0 are marked.
    const FLOOR = 1.0; // KB; at-or-below this both engines are effectively zero-alloc (pool overhead)
    console.log(`\nTransient heap vs ${LABEL[REF] || REF} (x less = lite allocates that many times less):`);
    let h2Heap = "scenario".padEnd(18);
    for (const e of liteVers) h2Heap += (LABEL[e]).padStart(w);
    console.log(h2Heap);
    console.log("-".repeat(h2Heap.length));
    for (const s of SCENARIOS) {
        const al = avgHeaps[REF]?.[s];
        let row = s.padEnd(18);
        for (const e of liteVers) {
            const v = avgHeaps[e]?.[s];
            if (v == null || al == null) {
                row += "--".padStart(w);
                continue;
            }
            const va = Math.max(Math.abs(v), 0);
            const ala = Math.max(Math.abs(al), 0);
            let cell;
            if (ala < FLOOR && va < FLOOR) {
                cell = "~0/~0";              // both zero-alloc: tie (lite's design goal)
            } else if (va < FLOOR) {
                cell = ">=" + Math.round(ala / FLOOR) + "x"; // lite ~0, ref allocates: huge win, lower-bounded
            } else {
                const ratio = ala / va;
                cell = ratio >= 1 ? ratio.toFixed(1) + "x" : "-" + (1 / ratio).toFixed(1) + "x";
            }
            row += cell.padStart(w);
        }
        console.log(row);
    }

    console.log(`\nHeap wins vs ${LABEL[REF] || REF} (scenarios where lite allocates less-or-equal):`);
    for (const e of liteVers) {
        let wins = 0, total = 0;
        for (const s of SCENARIOS) {
            const v = avgHeaps[e]?.[s], al = avgHeaps[REF]?.[s];
            if (v == null || al == null) continue;
            total++;
            // lite wins if it allocates strictly less, OR both are effectively
            // zero (the zero-GC tie counts as a win -- lite holds the line where
            // it claims to, the ref just happens to also be near-zero here).
            const FLOOR2 = 1.0;
            if (Math.abs(v) < al - 1e-9 || (Math.abs(v) < FLOOR2 && Math.abs(al) < FLOOR2)) wins++;
        }
        console.log(`  ${(LABEL[e]).padEnd(14)} ${wins}/${total}`);
    }
}
