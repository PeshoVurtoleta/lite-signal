// bench/vs-andrii.mjs -- join local mirror rows against an Andrii log and print the
// per-shape ratio table. THIS is the payoff of Session 2: "his numbers prove progress,
// mine show regressions" stops being an interpretation and becomes a mechanical diff
// that names the divergent row.
//
//   node bench/vs-andrii.mjs <local-mirror-output.txt> <andrii-log.txt> [engine=lite-signal] [andrii-engine]
//
// The local file's #STAMP (required) names the lite adapter's teardown (extra.adapter).
// "destroy" is Andrii's committed lite-signal adapter (fb10dd9 liteSignal.ts:46-49), so
// andrii-engine defaults to the local engine name. Any other teardown needs andrii-engine
// named explicitly, else exit 2. For "reset" the matching adapter is lite-signal-reset,
// which exists only in the maintainer's local copy of Andrii's repo (untracked
// src/frameworks/lite160/liteSignalReset.ts:20), not in his tracked tree (e3107157, fb10dd9).
//
// Both files are the 4-column CSV `framework , test , time , metrics`. We join local
// (engine, test) to his (andrii-engine, test), compare `time`, and -- critically --
// compare the counters in the metrics column. A time delta with MATCHING counters is a
// real speed difference on identical work; a time delta with DIFFERING counters means
// the shapes aren't the same workload and the comparison is void (the port drifted, or
// his suite changed).
//
// Rows join on joinKey (lib/title.mjs: first 60 chars, trimmed), because his log cuts the
// test column at 60 and the mirror does not. Exit codes: 2 = usage / unreadable file /
// stamp refusal; 1 = a row of a joined framework with no finite time,
// a join-key collision on either side, any WORK DIFFERS row, joined === 0, any
// local row with no andrii row (MIRROR_ONLY titles excepted, D-b251-1), or a MIRROR_ONLY
// title present on the andrii side; 0 = every other local row joined, no counters differ. Rows
// with no counters on either side print `n/a`, never `ok`: they prove nothing about work.

import { readFileSync } from "node:fs";
import { parseStampFromText } from "./lib/stamp.mjs";
import { joinKey } from "./lib/title.mjs";

const [, , localPath, andriiPath, engineArg, andriiEngineArg] = process.argv;
if (!localPath || !andriiPath) {
    console.error("usage: node bench/vs-andrii.mjs <local-mirror.txt> <andrii-log.txt> [engine] [andrii-engine]");
    process.exit(2);
}
// a missing / unreadable input is a usage error: exit 2 with one line, never a stack
function readText(path, side) {
    try {
        return readFileSync(path, "utf8");
    } catch (e) {
        console.error(`vs-andrii: cannot read the ${side} file ${path} (${(e && e.code) || e})`);
        process.exit(2);
    }
}
const ENGINE = (engineArg || "lite-signal").toLowerCase();

// the local stamp decides which of Andrii's adapters the local rows correspond to
const STAMP = parseStampFromText(readText(localPath, "local"));
if (!STAMP) {
    console.error(`vs-andrii: ${localPath} has no #STAMP line -- cannot tell which adapter produced it`);
    process.exit(2);
}
const ADAPTER = STAMP.extra?.adapter ?? "(not stamped)";
if (ADAPTER !== "destroy" && !andriiEngineArg) {
    console.error(`vs-andrii: the local stamp names teardown "${ADAPTER}"; Andrii's committed lite-signal adapter destroys.`);
    console.error("  Name the matching Andrii engine as the 4th argument [andrii-engine].");
    if (ADAPTER === "reset") {
        console.error("  For reset that is lite-signal-reset: only in the maintainer's local copy of Andrii's repo");
        console.error("  (untracked src/frameworks/lite160/liteSignalReset.ts:20), not in his tracked tree.");
    }
    process.exit(2);
}
const ANDRII_ENGINE = (andriiEngineArg || ENGINE).toLowerCase();

// parse a 4-col CSV file -> Map<joinKey(test), {time, counters}> for ONE framework.
// Both sides join on joinKey (60 chars, trimmed): his log cuts the test column at 60,
// the mirror never does. Two rows of that framework that share a key cannot be told
// apart in his log, so a collision is REFUSED (exit 1, both titles named), never resolved
// by letting the later row overwrite the earlier one.
const COUNTER_RE = /(nodesRecomputed|nodesVisited|edgesTraversed|sinkReads)=(\d+)/g;
function parse(path, framework, side) {
    const rows = new Map();
    for (const line of readText(path, side).split(/\r?\n/)) {
        if (line.startsWith("#") || !line.includes(",")) continue;
        const p = line.split(",").map((s) => s.trim());
        if (p.length < 3 || p[0] === "framework") continue;
        if (p[0].toLowerCase() !== framework) continue;
        const time = parseFloat(p[2]);
        if (!Number.isFinite(time)) { console.error(`vs-andrii: REFUSING -- ${side} ${framework} row "${p[1]}" has no finite time ("${p[2]}")`); process.exit(1); }
        const key = joinKey(p[1]);
        const prev = rows.get(key);
        if (prev) {
            console.error(`vs-andrii: REFUSING -- ${side} join-key collision for ${framework}: "${prev.test}" and "${p[1]}" share the key "${key}"`);
            process.exit(1);
        }
        const metrics = p.slice(3).join(",");
        const counters = {};
        let m; while ((m = COUNTER_RE.exec(metrics))) counters[m[1]] = Number(m[2]);
        rows.set(key, { framework: p[0], test: p[1], time, counters, capped: /SLOW\/CAPPED/.test(metrics) });
    }
    return rows;
}

// D-b251-1: the mirror's two orphan shapes (mirror-config.mjs "linear chain - 1 source -
// pull (linear pull)" and "wide tree - 8 sources - pull (branchy pull)") have no row in
// Andrii's suite. Matched on joinKey of the exact emitted test column (testColumn of those
// configs). They print `mirror-only (no Andrii row)` and do not fail; any other unjoined
// local row still fails, and a MIRROR_ONLY title that DOES appear on Andrii's side fails
// too, so the list goes stale loudly.
const MIRROR_ONLY = Object.freeze([
    "8x64 - 1 sources - pull (linear chain - 1 source - pull (linear pull))",
    "64x4 - 8 sources - pull (wide tree - 8 sources - pull (branchy pull))",
]);
const MIRROR_ONLY_KEYS = new Set(MIRROR_ONLY.map(joinKey));

const local = parse(localPath, ENGINE, "local");

const andrii = parse(andriiPath, ANDRII_ENGINE, "andrii");

const pad = (s, n) => { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); };
console.log(`vs-andrii join: local engine="${ENGINE}" (protocol=${STAMP.protocol}, teardown=${ADAPTER}) vs andrii engine="${ANDRII_ENGINE}"`);
console.log(`  (local=${localPath}  andrii=${andriiPath})\n`);
console.log(pad("test", 46) + pad("local", 10) + pad("andrii", 10) + pad("delta", 10) + "counters");
console.log("-".repeat(96));

let joined = 0, countersMismatch = 0, noCounters = 0;
const unjoined = [], mirrorOnly = [], stale = [];
for (const t of MIRROR_ONLY) if (andrii.has(joinKey(t))) stale.push(t);
for (const [key, lrow] of local) {
    const arow = andrii.get(key);
    if (!arow) { (MIRROR_ONLY_KEYS.has(key) ? mirrorOnly : unjoined).push(lrow.test); continue; }
    joined++;
    // counter agreement -- the validity gate on the comparison itself. A row with no
    // counters on EITHER side (kairo / fan / mol / S rows) proves nothing about equal
    // work: it prints n/a, never ok.
    const keys = new Set([...Object.keys(lrow.counters), ...Object.keys(arow.counters)]);
    let cMatch = true;
    for (const k of keys) if (lrow.counters[k] !== arow.counters[k]) cMatch = false;
    let verdict;
    if (keys.size === 0) { noCounters++; verdict = "n/a (no counters: equal work unverified)"; }
    else if (cMatch) verdict = "ok";
    else { countersMismatch++; verdict = "!! WORK DIFFERS -- comparison void"; }
    const delta = ((arow.time - lrow.time) / arow.time) * 100;
    const cap = lrow.capped || arow.capped ? " [capped]" : "";
    console.log(
        pad(lrow.test.slice(0, 44), 46) +
        pad(lrow.time.toFixed(1), 10) +
        pad(arow.time.toFixed(1), 10) +
        pad((delta >= 0 ? "+" : "") + delta.toFixed(1) + "%", 10) +
        verdict + cap
    );
}
console.log("-".repeat(96));
console.log(`joined ${joined} row(s) on joinKey (local ${ENGINE} vs andrii ${ANDRII_ENGINE}); ${noCounters} n/a (no counters); ${andrii.size - joined} andrii row(s) with no local row.`);
for (const t of mirrorOnly) console.log(`mirror-only (no Andrii row): "${t}"`);
for (const t of stale) console.log(`!! MIRROR_ONLY title "${t}" HAS an andrii ${ANDRII_ENGINE} row -- the MIRROR_ONLY list is stale`);
for (const t of unjoined) console.log(`!! unjoined local row: "${t}" (key "${joinKey(t)}") has no andrii ${ANDRII_ENGINE} row`);
if (countersMismatch > 0) {
    console.log(`!! ${countersMismatch} row(s) had DIFFERING counters -- those shapes are not the same workload across the two files.`);
    console.log("   Either the port drifted from his suite, or his suite changed. Re-verify with mirror.mjs --self-verify.");
} else if (joined > noCounters) {
    console.log(`all ${joined - noCounters} joined row(s) WITH counters match (equal work counted; see the note below on what the times compare).`);
}
console.log("\nNote: comparing across hosts/protocols is only valid for the WITHIN-ROW lite-vs-lite reading of");
console.log("progress across versions on the SAME host. Cross-host absolute times are not comparable (stamp says which host).");

// fail closed: a void comparison, an empty join or a dropped local row is not a result
const failures = [];
if (countersMismatch > 0) failures.push(`${countersMismatch} row(s) WORK DIFFERS`);
if (joined === 0) failures.push("joined 0 rows");
if (unjoined.length > 0) failures.push(`${unjoined.length} local row(s) unjoined`);
if (stale.length > 0) failures.push(`${stale.length} MIRROR_ONLY title(s) found on the andrii side`);
if (failures.length > 0) {
    console.log("vs-andrii: FAIL -- " + failures.join("; "));
    process.exitCode = 1;
}
