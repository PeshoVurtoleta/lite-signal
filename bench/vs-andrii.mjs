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

import { readFileSync } from "node:fs";
import { parseStampFromText } from "./lib/stamp.mjs";

const [, , localPath, andriiPath, engineArg, andriiEngineArg] = process.argv;
if (!localPath || !andriiPath) {
    console.error("usage: node bench/vs-andrii.mjs <local-mirror.txt> <andrii-log.txt> [engine] [andrii-engine]");
    process.exit(2);
}
const ENGINE = (engineArg || "lite-signal").toLowerCase();
// the local stamp decides which of Andrii's adapters the local rows correspond to
const STAMP = parseStampFromText(readFileSync(localPath, "utf8"));
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

// parse a 4-col CSV file -> Map<"framework\u0000test", {time, counters}>
const COUNTER_RE = /(nodesRecomputed|nodesVisited|edgesTraversed|sinkReads)=(\d+)/g;
function parse(path) {
    const rows = new Map();
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (line.startsWith("#") || !line.includes(",")) continue;
        const p = line.split(",").map((s) => s.trim());
        if (p.length < 3 || p[0] === "framework") continue;
        const time = parseFloat(p[2]);
        if (!Number.isFinite(time)) continue;
        const metrics = p.slice(3).join(",");
        const counters = {};
        let m; while ((m = COUNTER_RE.exec(metrics))) counters[m[1]] = Number(m[2]);
        rows.set(p[0].toLowerCase() + "\u0000" + p[1], { framework: p[0], test: p[1], time, counters, capped: /SLOW\/CAPPED/.test(metrics) });
    }
    return rows;
}

const local = parse(localPath);
const andrii = parse(andriiPath);

const pad = (s, n) => { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); };
console.log(`vs-andrii join: local engine="${ENGINE}" (protocol=${STAMP.protocol}, teardown=${ADAPTER}) vs andrii engine="${ANDRII_ENGINE}"`);
console.log(`  (local=${localPath}  andrii=${andriiPath})\n`);
console.log(pad("test", 46) + pad("local", 10) + pad("andrii", 10) + pad("delta", 10) + "counters");
console.log("-".repeat(96));

let joined = 0, countersMismatch = 0;
for (const [key, lrow] of local) {
    if (!key.startsWith(ENGINE + "\u0000")) continue;
    const arow = andrii.get(ANDRII_ENGINE + "\u0000" + lrow.test);
    if (!arow) continue;
    joined++;
    // counter agreement -- the validity gate on the comparison itself
    const keys = new Set([...Object.keys(lrow.counters), ...Object.keys(arow.counters)]);
    let cMatch = true;
    for (const k of keys) if (lrow.counters[k] !== arow.counters[k]) cMatch = false;
    if (!cMatch) countersMismatch++;
    const delta = ((arow.time - lrow.time) / arow.time) * 100;
    const cap = lrow.capped || arow.capped ? " [capped]" : "";
    console.log(
        pad(lrow.test.slice(0, 44), 46) +
        pad(lrow.time.toFixed(1), 10) +
        pad(arow.time.toFixed(1), 10) +
        pad((delta >= 0 ? "+" : "") + delta.toFixed(1) + "%", 10) +
        (cMatch ? "ok" : "!! WORK DIFFERS -- comparison void") + cap
    );
}
console.log("-".repeat(96));
console.log(`joined ${joined} row(s) on test (local ${ENGINE} vs andrii ${ANDRII_ENGINE}).`);
if (countersMismatch > 0) {
    console.log(`!! ${countersMismatch} row(s) had DIFFERING counters -- those shapes are not the same workload across the two files.`);
    console.log("   Either the port drifted from his suite, or his suite changed. Re-verify with mirror.mjs --self-verify.");
} else if (joined > 0) {
    console.log("all joined rows have matching counters (equal work counted; see the note below on what the times compare).");
}
console.log("\nNote: comparing across hosts/protocols is only valid for the WITHIN-ROW lite-vs-lite reading of");
console.log("progress across versions on the SAME host. Cross-host absolute times are not comparable (stamp says which host).");
