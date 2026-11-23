// bench/aggregate.mjs -- microscope aggregator (bench protocol v3).
//
// Reads <dir>/<engine>-rep<N>.txt (from run-all-bench.sh, one stamped process per
// engine per rep), medians per-scenario time and heap across reps, prints engines side
// by side + each other engine vs alien. Rewritten for v3:
//   - parses the v3 columns (median=, heapMed=, heapP95=), NOT the retired Dheap=;
//   - SCENARIOS is the SIX first-party shapes (the three impostors were deleted in F8);
//   - reuses the stamp guards so an inconsistent/under-counted merge is refused,
//     exactly like the mirror's aggregation. No falsely-averaged heap, no phantom rows.
//
// Fail closed (M5). It prints "REFUSING: <reason>" and exits 1 when:
//   - <dir>/COMPLETE is absent or is not run-all-bench.sh's isolated-per-engine marker
//     (run-all-bench.sh writes it LAST, only when every process exited 0);
//   - <dir> holds a *.partial / *.tmp leftover, or a rep file of an engine COMPLETE
//     does not list;
//   - any rep file contains `sink=[ ]` or `INVALID RUN`, or has fewer than the six
//     scenario rows of its own engine marked `sink=[x]`;
//   - the per-engine rep counts are unequal, the rep numbers are not 1..N, or N differs
//     from COMPLETE.reps or from `--reps`;
//   - the stamps disagree within an engine, or across the union of all engines (engine
//     sha, protocol, host, harness sha, extra).
// A missing / unreadable <dir> or a bad argument exits 2 (usage). Heap is reported as raw
// KB only (a heap percentage over a near-zero / negative denominator is noise); a time
// percentage is printed only when the alien median is > 0.
//
//   node bench/aggregate.mjs                      # <script dir>/bench-runs
//   node bench/aggregate.mjs --dir path/to/runs   # another capture dir
//   node bench/aggregate.mjs --reps 10            # also assert exactly 10 reps per engine (F2)

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_KEYS, ENGINES } from "./frameworks.mjs";
import { parseStampFromText } from "./lib/stamp.mjs";
import { assertStampsConsistent, assertRepCount } from "./lib/guards.mjs";
import { median } from "./lib/stats.mjs";

const SCENARIOS = ["KAIROS", "BROADCAST", "DEEP CHAIN", "MUX", "DYNAMIC DAG", "SELECTIVE DAG"];
const REF = "alien-signals";
const LABEL = Object.fromEntries(ENGINES.map((e) => [e.key, e.label || e.key]));
const COMPLETE_KIND = "bench-capture-complete/v1";
const COMPLETE_WRITER = "run-all-bench.sh";
const COMPLETE_PROTOCOL = "isolated-per-engine";
const POS_INT = /^[1-9][0-9]*$/;

function usage(msg) { console.error("aggregate: " + msg); process.exit(2); }
function refuse(msg) { console.error("REFUSING: " + msg); process.exit(1); }

// ---- args (strict: unknown flag / missing value / non-integer reps = usage, exit 2) ----
let dir = join(dirname(fileURLToPath(import.meta.url)), "bench-runs");
let claimedReps = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== "--dir" && a !== "--reps") usage(`unknown argument '${a}' (known: --dir <path>, --reps <n>)`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
    if (a === "--dir") dir = resolve(v);
    else if (POS_INT.test(v)) claimedReps = Number(v);
    else usage(`--reps must be a positive integer (got '${v}')`);
}

// ---- dir listing (missing / unreadable dir = usage, no stack trace) ----
let names;
try { names = readdirSync(dir); }
catch (e) { usage(`cannot read capture dir ${dir} (${(e && e.code) || "error"})`); }

// ---- COMPLETE marker (written last by run-all-bench.sh) ----
const completePath = join(dir, "COMPLETE");
if (!existsSync(completePath)) refuse(`${completePath} is absent -- the capture did not finish (run-all-bench.sh writes it last)`);
let complete = null;
try { complete = JSON.parse(readFileSync(completePath, "utf8")); } catch { refuse(`${completePath} is not valid JSON`); }
if (!complete || typeof complete !== "object" || complete.kind !== COMPLETE_KIND ||
    complete.writer !== COMPLETE_WRITER || complete.protocol !== COMPLETE_PROTOCOL) {
    refuse(`${completePath} is not a ${COMPLETE_WRITER} ${COMPLETE_PROTOCOL} ${COMPLETE_KIND} marker`);
}
if (!Number.isInteger(complete.reps) || complete.reps < 1) refuse(`COMPLETE.reps is not a positive integer`);
if (!Array.isArray(complete.engines) || complete.engines.length === 0 ||
    new Set(complete.engines).size !== complete.engines.length ||
    complete.engines.some((k) => !ENGINE_KEYS.includes(k))) {
    refuse(`COMPLETE.engines is not a non-empty list of unique frameworks.mjs keys`);
}

// ---- rep files on disk ----
const leftovers = names.filter((f) => f.endsWith(".partial") || f.endsWith(".tmp"));
if (leftovers.length) refuse(`${leftovers.length} leftover file(s) in the capture dir (e.g. ${leftovers[0]})`);
const repsOf = new Map();   // engine -> [rep number]
for (const f of names) {
    const m = f.match(/^(.+)-rep([1-9]\d*)\.txt$/);
    if (!m) { if (f.includes("-rep")) refuse(`rep file name ${f} is not <engine>-rep<N>.txt (N = 1, 2, ...)`); continue; }
    if (!complete.engines.includes(m[1])) refuse(`rep file ${f} belongs to an engine COMPLETE does not list`);
    if (!repsOf.has(m[1])) repsOf.set(m[1], []);
    repsOf.get(m[1]).push(Number(m[2]));
}
const engines = ENGINE_KEYS.filter((k) => complete.engines.includes(k));

// per-engine rep counts: each numbered 1..N with N === COMPLETE.reps (so all equal)
for (const eng of engines) {
    const reps = (repsOf.get(eng) || []).slice().sort((a, b) => a - b);
    if (reps.length !== complete.reps) refuse(`${eng}: ${reps.length} rep file(s) on disk but COMPLETE.reps=${complete.reps}`);
    for (let i = 0; i < reps.length; i++) if (reps[i] !== i + 1) refuse(`${eng}: rep numbers are not 1..${complete.reps}`);
}

const TIME_RE = /median=\s*([\d.]+)ms/;
const HEAP_RE = /heapMed=\s*(-?[\d.]+)\s*KB/i;

// parse one rep file -> { scenario: {time, heap} }. A row counts only for its own engine
// and only with a live sink (`sink=[x]`); INVALID RUN / any `sink=[ ]` is a refusal.
function parseRep(text, eng, name) {
    if (text.includes("INVALID RUN")) refuse(`${name}: INVALID RUN`);
    if (text.includes("sink=[ ]")) refuse(`${name}: dead sink (sink=[ ])`);
    const out = {}; let sc = null;
    for (const line of text.split("\n")) {
        for (const s of SCENARIOS) if (line.startsWith(s)) sc = s;
        const mm = line.match(TIME_RE), hm = line.match(HEAP_RE);
        if (mm && sc) {
            if (out[sc]) refuse(`${name}: duplicate ${sc} row`);
            if (line.startsWith(eng + " ") && line.includes("sink=[x]")) out[sc] = { time: parseFloat(mm[1]), heap: hm ? parseFloat(hm[1]) : null };
            sc = null;
        }
    }
    const have = SCENARIOS.filter((s) => out[s]).length;
    if (have < SCENARIOS.length) refuse(`${name}: ${have} of ${SCENARIOS.length} scenario rows (own engine, sink=[x])`);
    return out;
}

// collect per engine with stamp guards, then the union stamp check
const meds = {}, heaps = {};
const all = [];
for (const eng of engines) {
    const files = [];
    for (let r = 1; r <= complete.reps; r++) {
        const name = `${eng}-rep${r}.txt`;
        const path = join(dir, name);
        let text;
        try { text = readFileSync(path, "utf8"); } catch (e) { refuse(`${name}: unreadable (${(e && e.code) || "error"})`); }
        if (text.split(/\r?\n/).filter((l) => l.startsWith("#STAMP ")).length !== 1) refuse(`${name}: expected exactly one #STAMP line`);
        files.push({ path, name, text, stamp: parseStampFromText(text) });
    }
    const consistent = assertStampsConsistent(files);
    if (!consistent.ok) refuse(`${eng}: ${consistent.reason}`);
    if (claimedReps != null) { const rc = assertRepCount(files, claimedReps, eng); if (!rc.ok) refuse(rc.reason); }
    const per = {};
    for (const f of files) { const parsed = parseRep(f.text, eng, f.name); for (const sc of SCENARIOS) (per[sc] ??= []).push(parsed[sc]); }
    meds[eng] = {}; heaps[eng] = {};
    for (const sc of SCENARIOS) {
        meds[eng][sc] = median(per[sc].map((x) => x.time));
        const hs = per[sc].map((x) => x.heap);
        heaps[eng][sc] = hs.every((v) => Number.isFinite(v)) ? median(hs) : null;
    }
    for (const f of files) all.push(f);
}
const union = assertStampsConsistent(all);
if (!union.ok) refuse(`across engines: ${union.reason}`);
if (union.protocol !== COMPLETE_PROTOCOL) refuse(`stamp protocol ${union.protocol} differs from COMPLETE.protocol ${COMPLETE_PROTOCOL}`);
const harnessShas = new Set(all.map((f) => f.stamp.harnessSha256));
if (harnessShas.size !== 1 || typeof all[0].stamp.harnessSha256 !== "string") {
    refuse(`across engines: ${harnessShas.size} distinct harness sha256 -- different harnesses, refusing to merge`);
}
if (typeof all[0].stamp.engineSha256 !== "string") refuse("across engines: no engine sha256 in the stamps (LEDGER:482)");
if (all.some((f) => f.stamp.gcExposed !== true)) refuse("a rep was captured without --expose-gc");
const extras = new Set(all.map((f) => JSON.stringify(f.stamp.extra ?? null)));
if (extras.size !== 1) refuse(`across engines: ${extras.size} distinct stamp extra blocks (${[...extras].join(" | ")})`);

// print: engines side by side (time), then each engine vs alien time + raw heap KB
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };
const W = Math.max(14, ...engines.map((e) => LABEL[e].length + 2));
console.log(`microscope aggregate  (${complete.reps} rep(s) per engine; ${engines.length} engine(s))\n`);
console.log((pad("scenario", 16) + engines.map((e) => pad(LABEL[e], W)).join("")).trimEnd());
for (const sc of SCENARIOS) console.log((pad(sc, 16) + engines.map((e) => pad(meds[e][sc].toFixed(2) + "ms", W)).join("")).trimEnd());

const kb = (v) => (v == null ? "n/a" : v.toFixed(1) + "KB");
if (meds[REF]) {
    console.log(`\nvs ${REF} (time; + = the named engine faster than ${REF}; heap is raw KB, no percentage):`);
    for (const eng of engines) {
        if (eng === REF) continue;
        console.log(`\n  ${LABEL[eng]}:`);
        for (const sc of SCENARIOS) {
            const lt = meds[eng][sc], at = meds[REF][sc], lh = heaps[eng][sc], ah = heaps[REF][sc];
            const dt = at > 0 ? (at - lt) / at * 100 : null;
            console.log(`    ${pad(sc, 16)} time ${dt == null ? "n/a" : (dt >= 0 ? "+" : "") + dt.toFixed(1) + "%"}   heap (${kb(lh)} vs ${kb(ah)})`);
        }
    }
}
