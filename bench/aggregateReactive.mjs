// Aggregate per-engine bench-reactive-runs/*.txt into one comparison table.
// Reads every bench-reactive-runs/<engine>-rep<N>.txt, medians each engine's
// per-test median across reps, prints engines side by side + each lite version
// vs alien (% ahead + win count).
//
// Mirrors aggregate.mjs, but adapted to the REACTIVE harness output format:
//   - benchmarkReactive.mjs emits one line per test:  "<test name>   <N>ms"
//     (no "median=" token, no scenario-header-then-dataline like benchmark.mjs).
//   - The test set is NOT a fixed list — it's discovered from the files, so new
//     tests added to the reactive harness show up automatically.
// Engine list / labels come from the SINGLE source of truth: frameworks.mjs
// (the reactive subset).
import {readdirSync, readFileSync} from "node:fs";
import {keysFor, ENGINES} from "./frameworks.mjs";

const RUN_DIR = "bench-reactive-runs";
const ENGINE_LIST = keysFor("reactive");
const LABEL = Object.fromEntries(ENGINES.map((e) => [e.key, e.label || e.key]));
const REF = "alien-signals";   // the reference engine to compare lite builds against

const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
};

// Parse a reactive data line: "<test name>   <number>ms<trailing spaces>".
// The test name may contain spaces and ':' — so match the trailing "<num>ms"
// and take everything before it as the (trimmed) name.
const ROW = /^(.*?)\s{2,}([\d.]+)ms\s*$/;

// data[engine][test] = [median-of-run per rep]
const data = {};
const allTests = [];        // discovered test order (first file wins the ordering)
const seenTest = new Set();

let files;
try {
    files = readdirSync(RUN_DIR);
} catch {
    console.error(`No ${RUN_DIR}/ directory. Run the reactive harness per-engine first, e.g.:`);
    console.error(`  FW=lite-signal node --expose-gc bench/benchmarkReactive.mjs > ${RUN_DIR}/lite-signal-rep1.txt`);
    process.exit(1);
}

for (const f of files) {
    const m = f.match(/^(.+)-rep\d+\.txt$/);
    if (!m) continue;
    const eng = m[1];
    const txt = readFileSync(`${RUN_DIR}/${f}`, "utf8");
    for (const line of txt.split("\n")) {
        const mm = line.match(ROW);
        if (!mm) continue;
        const test = mm[1].trim();
        const val = parseFloat(mm[2]);
        if (!Number.isFinite(val)) continue;
        (data[eng] ?? = {});
        (data[eng][test] ?? = []).push(val);
        if (!seenTest.has(test)) {
            seenTest.add(test);
            allTests.push(test);
        }
    }
}

// Median each engine's per-test samples across reps.
const meds = {};
for (const eng of ENGINE_LIST) {
    meds[eng] = {};
    for (const t of allTests) {
        const vals = data[eng]?.[t];
        if (vals && vals.length) meds[eng][t] = median(vals);
    }
}

// Only show engines that actually produced data (skip ones with no run files).
const present = ENGINE_LIST.filter((e) => data[e] && Object.keys(data[e]).length);
if (present.length === 0) {
    console.error(`No parseable runs found in ${RUN_DIR}/.`);
    process.exit(1);
}

const repCount = (e) => {
    const anyTest = Object.values(data[e] || {})[0];
    return anyTest ? anyTest.length : 0;
};
console.log(`Reactive aggregate — ${present.length} engines, ${allTests.length} tests, reps per engine: ` +
    present.map((e) => `${LABEL[e]}=${repCount(e)}`).join(", "));
console.log();

// ── Main table: absolute medians, engines side by side ──
const NAMEW = Math.max(20, ...allTests.map((t) => t.length)) + 2;
const COLW = 13;
let hdr = "test".padEnd(NAMEW);
for (const e of present) hdr += (LABEL[e]).padStart(COLW);
console.log(hdr);
console.log("-".repeat(hdr.length));
for (const t of allTests) {
    let row = t.padEnd(NAMEW);
    for (const e of present) {
        const v = meds[e]?.[t];
        row += (v != null ? v.toFixed(2) + "ms" : "--").padStart(COLW);
    }
    console.log(row);
}

// ── % ahead of the reference (positive = lite faster) ──
const liteVers = present.filter((e) => e !== REF);
if (meds[REF] && liteVers.length) {
    console.log(`\n% ahead of ${LABEL[REF] || REF} (positive = lite faster):`);
    let h2 = "test".padEnd(NAMEW);
    for (const e of liteVers) h2 += (LABEL[e]).padStart(COLW);
    console.log(h2);
    console.log("-".repeat(h2.length));
    for (const t of allTests) {
        const ref = meds[REF]?.[t];
        let row = t.padEnd(NAMEW);
        for (const e of liteVers) {
            const v = meds[e]?.[t];
            if (v != null && ref != null && ref > 0) {
                const pct = (ref - v) / ref * 100;
                row += ((pct >= 0 ? "+" : "") + pct.toFixed(0) + "%").padStart(COLW);
            } else row += "--".padStart(COLW);
        }
        console.log(row);
    }

    // ── Win count vs reference ──
    console.log(`\nWins vs ${LABEL[REF] || REF} (tests where lite is faster):`);
    for (const e of liteVers) {
        let wins = 0, total = 0;
        for (const t of allTests) {
            const ref = meds[REF]?.[t], v = meds[e]?.[t];
            if (v != null && ref != null) {
                total++;
                if (v < ref) wins++;
            }
        }
        console.log(`  ${(LABEL[e]).padEnd(14)} ${wins}/${total}`);
    }
} else {
    console.log(`\n(no ${REF} run found — skipping the vs-reference comparison)`);
}
