// bench/aggregate.mjs -- microscope aggregator (bench protocol v3).
//
// Reads bench-runs/<engine>-rep<N>.txt (from run-all-bench.sh, one stamped process per
// engine per rep), medians per-scenario time and heap across reps, prints engines side
// by side + each lite build vs alien. Rewritten for v3:
//   - parses the v3 columns (median=, heapMed=, heapP95=), NOT the retired Dheap=;
//   - SCENARIOS is the SIX first-party shapes (the three impostors were deleted in F8);
//   - reuses the stamp guards so an inconsistent/under-counted merge is refused,
//     exactly like the mirror's aggregation. No falsely-averaged heap, no phantom rows.
//
//   node bench/aggregate.mjs            # aggregate whatever reps are on disk
//   node bench/aggregate.mjs --reps 10  # also assert exactly 10 reps per engine (F2)

import { readdirSync } from "node:fs";
import { ENGINE_KEYS, ENGINES } from "./frameworks.mjs";
import { loadRepFiles } from "./lib/collect.mjs";
import { assertStampsConsistent, assertRepCount } from "./lib/guards.mjs";
import { median } from "./lib/stats.mjs";

const SCENARIOS = ["KAIROS", "BROADCAST", "DEEP CHAIN", "MUX", "DYNAMIC DAG", "SELECTIVE DAG"];
const REF = "alien-signals";
const LABEL = Object.fromEntries(ENGINES.map((e) => [e.key, e.label || e.key]));

const repsArg = process.argv.indexOf("--reps");
const claimedReps = repsArg >= 0 ? Number(process.argv[repsArg + 1]) : null;

const TIME_RE = /median=\s*([\d.]+)ms/;
const HEAP_RE = /heapMed=\s*(-?[\d.]+)\s*KB/i;

// engines present on disk
const present = new Set();
for (const f of readdirSync("bench-runs")) { const m = f.match(/^(.+)-rep\d+\.txt$/); if (m) present.add(m[1]); }
const engines = ENGINE_KEYS.filter((k) => present.has(k));
if (!engines.length) { console.error("no bench-runs/<engine>-rep<N>.txt files"); process.exit(2); }

// parse one rep file -> { scenario: {time, heap} }
function parseRep(text) {
    const out = {}; let sc = null;
    for (const line of text.split("\n")) {
        for (const s of SCENARIOS) if (line.startsWith(s)) sc = s;
        const mm = line.match(TIME_RE), hm = line.match(HEAP_RE);
        if (mm && sc) { out[sc] = { time: parseFloat(mm[1]), heap: hm ? parseFloat(hm[1]) : null }; sc = null; }
    }
    return out;
}

// collect per engine with stamp guards
const meds = {}, heaps = {};
for (const eng of engines) {
    const files = loadRepFiles("bench-runs", eng);
    const consistent = assertStampsConsistent(files);
    if (!consistent.ok) { console.error(`REFUSING: ${eng}: ${consistent.reason}`); process.exit(1); }
    if (claimedReps != null) { const rc = assertRepCount(files, claimedReps, eng); if (!rc.ok) { console.error("REFUSING: " + rc.reason); process.exit(1); } }
    const per = {};
    for (const f of files) { const parsed = parseRep(f.text); for (const sc of SCENARIOS) if (parsed[sc]) (per[sc] ??= []).push(parsed[sc]); }
    meds[eng] = {}; heaps[eng] = {};
    for (const sc of SCENARIOS) if (per[sc]) { meds[eng][sc] = median(per[sc].map((x) => x.time)); heaps[eng][sc] = median(per[sc].map((x) => x.heap).filter((v) => v != null)); }
}

// print: engines side by side (time), then lite-vs-alien time + heap
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };
console.log(`microscope aggregate  (reps on disk; ${engines.length} engine(s))\n`);
console.log(pad("scenario", 16) + engines.map((e) => pad(LABEL[e], 14)).join(""));
for (const sc of SCENARIOS) console.log(pad(sc, 16) + engines.map((e) => pad((meds[e][sc] != null ? meds[e][sc].toFixed(2) + "ms" : "-"), 14)).join(""));

if (meds[REF]) {
    console.log(`\nvs ${REF} (time / heap; + = lite better):`);
    for (const eng of engines) {
        if (eng === REF) continue;
        console.log(`\n  ${LABEL[eng]}:`);
        for (const sc of SCENARIOS) {
            const lt = meds[eng][sc], at = meds[REF][sc], lh = heaps[eng][sc], ah = heaps[REF][sc];
            if (lt == null || at == null) continue;
            const dt = (at - lt) / at * 100;
            const dh = (ah && ah !== 0) ? (ah - lh) / ah * 100 : null;
            console.log(`    ${pad(sc, 16)} time ${(dt >= 0 ? "+" : "") + dt.toFixed(1)}%   heap ${dh == null ? "n/a" : (dh >= 0 ? "+" : "") + dh.toFixed(1) + "%"} (${lh?.toFixed(1)}KB vs ${ah?.toFixed(1)}KB)`);
        }
    }
}
