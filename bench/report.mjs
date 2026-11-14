// bench/report.mjs -- Session 6. Formats an ALREADY-CAPTURED sweep (bench/mirror-runs/)
// into a publishable results file. Separation of concerns: sweep.mjs CAPTURES (expensive,
// runs on the quiet host); report.mjs FORMATS (cheap, re-runnable, no re-benching). So the
// results file can be regenerated / re-framed without paying for another sweep.
//
//   node bench/report.mjs [mirror-runs-dir] [andrii-log]  > results-mirror-<date>.txt
//
// It re-runs the SAME provenance guards the aggregator does (stamp consistency, rep count),
// so a results file cannot be generated from an inconsistent or under-counted capture.
// Optionally lists the lite-signal rows of an Andrii log (informational: it checks no
// counters; the counter join is bench/vs-andrii.mjs). The protocol prose comes from the
// stamp, so a per-engine capture is never described as per-row. It refuses (exit 1) a
// dir without the COMPLETE marker the writers leave on exit 0, a marker that disagrees
// with the stamps or the files, and unequal rep counts across engines (D-b187-4).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { collectEngine, loadRepFiles } from "./lib/collect.mjs";

const RUN_DIR = process.argv[2] || join(new URL(".", import.meta.url).pathname, "mirror-runs");
const ANDRII = process.argv[3] || null;
const DIR_LABEL = process.argv[2] || "bench/mirror-runs";

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

// completion marker (D-b187-4): sweep.mjs / run-all-mirror.sh write it LAST, on exit 0 only
let marker = null;
try { marker = JSON.parse(readFileSync(join(RUN_DIR, "COMPLETE"), "utf8")); } catch (e) { marker = null; }
if (!marker || typeof marker !== "object") {
    console.error(`REFUSING to generate a report: no readable COMPLETE marker in ${RUN_DIR} -- the capture did not finish with exit 0.`);
    process.exit(1);
}

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

// what the protocol id says about how the rows were measured; an unknown id gets no prose
const PROTOCOL_PROSE = {
    "isolated-per-row": [
        "Protocol isolated-per-row: every (engine, row) was measured in its OWN cold process,",
        "so no row inherits JIT state or heap from another row.",
    ],
    "isolated-per-engine": [
        "Protocol isolated-per-engine: each rep file is ONE cold process per engine that ran",
        "all rows in a fixed order; rows share that process's JIT state and heap, so a row's",
        "time can depend on the rows before it.",
    ],
};
// every engine's rep count, printed in the header and required equal
const repCounts = engines.map((e) => `${e}=${collected[e]?.reps}`).join(" ");
if (!hardFail) {
    const counts = new Set(engines.map((e) => collected[e].reps));
    const protos = new Set(engines.map((e) => collected[e].protocol));
    const sameEngines = Array.isArray(marker.engines) && marker.engines.length === engines.length && engines.every((e) => marker.engines.includes(e));
    if (counts.size > 1) hardFail = `unequal rep counts across engines (${repCounts})`;
    else if (protos.size > 1 || marker.protocol !== [...protos][0]) hardFail = `COMPLETE marker protocol "${marker.protocol}" != stamp protocol(s) ${[...protos].join(", ")}`;
    else if (marker.reps !== [...counts][0] || !sameEngines) hardFail = `COMPLETE marker (reps=${marker.reps}, engines=${JSON.stringify(marker.engines)}) != files on disk (${repCounts})`;
}
if (!hardFail && stamp && !Object.hasOwn(PROTOCOL_PROSE, stamp.protocol)) {
    hardFail = `unknown protocol "${stamp.protocol}" in the stamp -- no description of how these rows were measured`;
}

if (hardFail) {
    console.error("REFUSING to generate a report: " + hardFail);
    console.error("A results file cannot be built from an inconsistent or under-counted capture (F2).");
    process.exit(1);
}

// --- emit the publishable results file ------------------------------------------------
// rule 1 states what was actually checked, per protocol (D-b187-4)
const RULE1 = {
    "isolated-per-row": [
        "  1. Built only from a dir with the COMPLETE marker sweep.mjs writes on a clean exit 0:",
        "     every child returned a stamp and a row within SWEEP_TIMEOUT_MS, exited 0 and printed no",
        "     #GUARD line, each engine's stamps agree (engine sha, protocol, host) over REPS",
        "     files, and the sentinel re-measure stayed within DRIFT_TOL. The mirror's counter /",
        "     checksum agreement guards compare engines inside ONE process, so with one engine",
        "     per child they check nothing here.",
    ],
    "isolated-per-engine": [
        "  1. Built only from a dir with the COMPLETE marker run-all-mirror.sh writes after every",
        "     FW=<engine> mirror.mjs process exited 0. No sentinel ran, and the mirror's counter /",
        "     checksum agreement guards compare engines inside ONE process, so with one engine",
        "     per process they check nothing here.",
    ],
};
const now = new Date().toISOString();
const L = [];
L.push("=".repeat(94));
L.push(" @zakkster/lite-signal -- REACTIVITY MIRROR (cross-framework)");
L.push("=".repeat(94));
L.push("");
if (stamp) {
    L.push(`Protocol : ${stamp.protocol}   reps: ${repCounts}`);
    L.push(`Host     : ${stamp.cpu}  ${stamp.platform}/${stamp.arch}  node ${stamp.node}`);
    L.push(`Engine   : sha256 ${stamp.engineSha256}`);
    L.push(`Adapter  : ${JSON.stringify(stamp.config)}  teardown=${stamp.extra?.adapter ?? "(not stamped)"}`);
    L.push(`Generated: ${now}`);
}
L.push("");
if (stamp) for (const line of PROTOCOL_PROSE[stamp.protocol]) L.push(line);
L.push("This file checks no counters against Andrii's log, and neither mirror.mjs --self-verify");
L.push("nor bench/vs-andrii.mjs runs as part of a capture: run them separately.");
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
for (const line of RULE1[stamp.protocol]) L.push(line);
L.push("     report.mjs itself checked: the marker (protocol, reps, engines vs the files), one");
L.push("     engine sha / protocol / host per engine, and equal rep counts across engines.");
L.push("  2. The mirror is a port of Andrii's suite, not a copy; a counter divergence for");
L.push("     identical engine bytes is a harness bug (run mirror.mjs --self-verify). Shape");
L.push("     edits only by re-porting.");
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

L.push(`Raw per-rep files: ${DIR_LABEL}/<engine>-rep<N>.txt`);
L.push(`Re-derive this file (no re-benching): node bench/report.mjs ${DIR_LABEL}`);
console.log(L.join("\n"));
