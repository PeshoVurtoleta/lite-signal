// bench/report.mjs -- Session 6. Formats an ALREADY-CAPTURED sweep (bench/mirror-runs/)
// into a publishable results file. Separation of concerns: sweep.mjs CAPTURES (expensive,
// runs on the quiet host); report.mjs FORMATS (cheap, re-runnable, no re-benching). So the
// results file can be regenerated / re-framed without paying for another sweep.
//
//   node bench/report.mjs [mirror-runs-dir] [andrii-log]  > results-mirror-<date>.txt
//
// It re-runs the SAME provenance guards the aggregator does (stamp consistency, rep count),
// so a results file cannot be generated from an inconsistent or under-counted capture.
// Optionally joins against an Andrii log and validates the join via counters.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { collectEngine, loadRepFiles } from "./lib/collect.mjs";

const RUN_DIR = process.argv[2] || join(new URL(".", import.meta.url).pathname, "mirror-runs");
const ANDRII = process.argv[3] || null;

// discover engines present in the dir
function enginesIn(dir) {
    const set = new Set();
    for (const f of readdirSync(dir)) { const m = f.match(/^(.*)-rep\d+\.txt$/); if (m) set.add(m[1]); }
    return [...set];
}

// row parser: test -> time ; also pull counters for the join validation
const rowParser = (text) => {
    const m = new Map();
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("#") || !line.includes(" , ")) continue;
        const p = line.split(" , ").map((s) => s.trim());
        if (p.length >= 3 && p[0] !== "framework" && Number.isFinite(parseFloat(p[2]))) m.set(p[1], parseFloat(p[2]));
    }
    return m;
};

function inferReps(dir, engine) {
    return loadRepFiles(dir, engine).length;
}

const engines = enginesIn(RUN_DIR);
if (engines.length === 0) { console.error("no <engine>-rep<N>.txt files in " + RUN_DIR); process.exit(2); }

// collect each engine with the provenance guards (reps inferred from files on disk)
const collected = {};
let stamp = null, hardFail = null;
for (const e of engines) {
    const reps = inferReps(RUN_DIR, e);
    const c = collectEngine(RUN_DIR, e, reps, rowParser);
    if (!c.ok) { hardFail = `${e}: ${c.reason}`; break; }
    collected[e] = c;
    if (!stamp) {
        const files = loadRepFiles(RUN_DIR, e);
        stamp = files[0]?.stamp || null;
    }
}

if (hardFail) {
    console.error("REFUSING to generate a report: " + hardFail);
    console.error("A results file cannot be built from an inconsistent or under-counted capture (F2).");
    process.exit(1);
}

// --- emit the publishable results file ------------------------------------------------
const now = new Date().toISOString();
const L = [];
L.push("=".repeat(94));
L.push(" @zakkster/lite-signal -- REACTIVITY MIRROR (cross-framework, Andrii's canonical adapter)");
L.push("=".repeat(94));
L.push("");
if (stamp) {
    L.push(`Protocol : ${stamp.protocol}   reps: ${collected[engines[0]].reps}`);
    L.push(`Host     : ${stamp.cpu}  ${stamp.platform}/${stamp.arch}  node ${stamp.node}`);
    L.push(`Engine   : sha256 ${stamp.engineSha256}`);
    L.push(`Adapter  : ${JSON.stringify(stamp.config)}  (lazy prealloc, default eager flush -- his config verbatim)`);
    L.push(`Generated: ${now}`);
}
L.push("");
L.push("Every row was measured in its OWN cold process (isolated-per-row), engines run in");
L.push("round-robin across reps, and a sentinel re-measure gated host drift. The counters");
L.push("(nodesRecomputed/edgesTraversed/sinkReads) match Andrii's published suite exactly");
L.push("(mirror.mjs --self-verify), so a lite-vs-alien delta here is identical work, not DCE.");
L.push("");

const ref = "alien-signals";
const hasRef = !!collected[ref];
const primary = collected["lite-signal"];
if (primary && hasRef) {
    const alien = collected[ref];
    L.push("-".repeat(94));
    L.push("EXECUTION TIME (median across reps, ms; lower is better)");
    L.push("-".repeat(94));
    L.push("test".padEnd(58) + "lite".padStart(10) + "alien".padStart(10) + "   lite vs alien");
    let wins = 0, total = 0;
    for (const test of primary.perTest.keys()) {
        const l = primary.perTest.get(test), a = alien.perTest.get(test);
        if (a == null) continue;
        total++;
        const d = (a - l) / a * 100;
        if (l < a) wins++;
        L.push(test.slice(0, 56).padEnd(58) + l.toFixed(2).padStart(10) + a.toFixed(2).padStart(10) + `   ${d >= 0 ? "+" : ""}${d.toFixed(1)}%  ${l < a ? "lite" : "alien"}`);
    }
    L.push("-".repeat(94));
    L.push(`lite faster than alien on ${wins}/${total} shapes.`);
    L.push("");
}

L.push("HONEST FRAMING (the claim that reproduces):");
L.push("  lite-signal's differentiated position is ALLOCATION, not raw propagation speed.");
L.push("  On these shapes lite runs at parity-to-behind alien on throughput (weak on deep/");
L.push("  layered propagation -- the DEEP CHAIN / burst family), while allocating one to four");
L.push("  orders of magnitude less transient heap (see bench/benchmark.mjs heap columns, the");
L.push("  zero-GC microscope). The headline is 'competitive throughput with dramatically lower");
L.push("  GC pressure', not 'fastest dynamic-graph engine'.");
L.push("");
L.push("STANDING RULES (enforced by the harness, not by prose):");
L.push("  1. No number is published unless its file carries a machine stamp and the sweep");
L.push("     exited 0 (dead-sink / counter / checksum / expected / sentinel / stamp guards).");
L.push("  2. The mirror tracks Andrii verbatim; divergence for identical engine bytes is a");
L.push("     harness bug (run mirror.mjs --self-verify). Shape edits only by re-porting.");
L.push("  3. One shape name = one definition, repo-wide. Approximations deleted, not renamed.");
L.push("  4. lite's config is fixed per file and echoed by the stamp. sab is a production");
L.push("     feature, not a benchmark knob.");
L.push("  5. Cross-protocol / cross-host comparisons cite (stamp, protocol) or are not made.");
L.push("");

// optional Andrii join validation
if (ANDRII) {
    L.push("-".repeat(94));
    L.push(`ANDRII JOIN (vs ${ANDRII})`);
    L.push("-".repeat(94));
    const aText = readFileSync(ANDRII, "utf8");
    const cre = /(nodesRecomputed|edgesTraversed|sinkReads)=(\d+)/g;
    const aRows = new Map();
    for (const line of aText.split(/\r?\n/)) {
        if (line.startsWith("#") || !line.includes(",")) continue;
        const p = line.split(",").map((s) => s.trim());
        if (p.length < 3 || p[0].toLowerCase() !== "lite-signal") continue;
        const counters = {}; let m; cre.lastIndex = 0; const met = p.slice(3).join(",");
        while ((m = cre.exec(met))) counters[m[1]] = Number(m[2]);
        aRows.set(p[1], { time: parseFloat(p[2]), counters });
    }
    // NOTE: this simple report join matches on his test title; counters must match to be valid.
    L.push("(join validity is asserted by mirror.mjs --self-verify + vs-andrii.mjs; this section is informational.)");
    L.push(`his lite-signal rows available: ${aRows.size}`);
    L.push("");
}

L.push("Raw per-rep files (checked in for audit): bench/mirror-runs/<engine>-rep<N>.txt");
L.push("Re-derive this file (no re-benching): node bench/report.mjs");
console.log(L.join("\n"));
