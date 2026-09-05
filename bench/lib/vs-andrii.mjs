// bench/vs-andrii.mjs -- join local mirror rows against an Andrii log and print the
// per-shape ratio table. THIS is the payoff of Session 2: "his numbers prove progress,
// mine show regressions" stops being an interpretation and becomes a mechanical diff
// that names the divergent row.
//
//   node bench/vs-andrii.mjs <local-mirror-output.txt> <andrii-log.txt> [engine=lite-signal]
//
// Both files are the 4-column CSV `framework , test , time , metrics`. We join on
// (framework, test), compare `time`, and -- critically -- compare the counters in the
// metrics column. A time delta with MATCHING counters is a real speed difference on
// identical work; a time delta with DIFFERING counters means the shapes aren't the same
// workload and the comparison is void (the port drifted, or his suite changed).

import { readFileSync } from "node:fs";

const [, , localPath, andriiPath, engineArg] = process.argv;
if (!localPath || !andriiPath) {
    console.error("usage: node bench/vs-andrii.mjs <local-mirror.txt> <andrii-log.txt> [engine]");
    process.exit(2);
}
const ENGINE = (engineArg || "lite-signal").toLowerCase();

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
console.log(`vs-andrii join for engine="${ENGINE}"  (local=${localPath}  andrii=${andriiPath})\n`);
console.log(pad("test", 46) + pad("local", 10) + pad("andrii", 10) + pad("delta", 10) + "counters");
console.log("-".repeat(96));

let joined = 0, countersMismatch = 0;
for (const [key, lrow] of local) {
    if (!key.startsWith(ENGINE + "\u0000")) continue;
    const arow = andrii.get(key);
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
console.log(`joined ${joined} row(s) on (framework,test).`);
if (countersMismatch > 0) {
    console.log(`!! ${countersMismatch} row(s) had DIFFERING counters -- those shapes are not the same workload across the two files.`);
    console.log("   Either the port drifted from his suite, or his suite changed. Re-verify with mirror.mjs --self-verify.");
} else if (joined > 0) {
    console.log("all joined rows did identical work (counters match) -- the time deltas are real, comparable engine differences.");
}
console.log("\nNote: comparing across hosts/protocols is only valid for the WITHIN-ROW lite-vs-lite reading of");
console.log("progress across versions on the SAME host. Cross-host absolute times are not comparable (stamp says which host).");
