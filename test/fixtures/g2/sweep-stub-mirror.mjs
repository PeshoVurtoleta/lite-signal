// STUB bench/mirror.mjs for test/136 (copied over mirror.mjs in a tmp copy of bench/). Prints one
// #STAMP line and one data row for FW x SCENARIO, as the real child does under ROWS_ONLY=1, with
// no engine. Values are identical for every engine and rep, and the time is constant (the
// sentinel is stable). STUB_TAMPER: "node" -> reflex-quant stamps another node; "captureId" ->
// reflex-quant stamps another captureId.
// Call-indexed knobs (1-based call = the STUB_COUNT_FILE length after this call's append; each
// exits 2 without STUB_COUNT_FILE, so a call-indexed knob never runs without STUB_COUNT_FILE):
//   STUB_TIME_AT="<call>:<text>[,...]"  that call prints <text> verbatim as its time column
//   STUB_NOROW_AT=<call>                that call prints its stamp but no data row
//   STUB_LOG_FILE=<path>                every call appends "<call>|<FW>|<SCENARIO>\n"
//   STUB_NODE_AT=<call>                 that call stamps another node (like the "sentinel" tamper)
import { appendFileSync, readFileSync } from "node:fs";
import { DYNAMIC_TESTS } from "./lib/mirror-config.mjs";
import { testColumn } from "./lib/title.mjs";
let calls = 0;
const timeAtRaw = process.env.STUB_TIME_AT, noRowRaw = process.env.STUB_NOROW_AT, logFile = process.env.STUB_LOG_FILE, nodeAtRaw = process.env.STUB_NODE_AT;
if (!process.env.STUB_COUNT_FILE && (timeAtRaw !== undefined || noRowRaw !== undefined || logFile !== undefined || nodeAtRaw !== undefined)) {
    console.error("stub: STUB_TIME_AT / STUB_NOROW_AT / STUB_LOG_FILE / STUB_NODE_AT need STUB_COUNT_FILE"); process.exit(2);
}
if (process.env.STUB_COUNT_FILE) { appendFileSync(process.env.STUB_COUNT_FILE, "x"); calls = readFileSync(process.env.STUB_COUNT_FILE, "utf8").length; }
const fw = process.env.FW, scenario = process.env.SCENARIO, tamper = process.env.STUB_TAMPER;
if (logFile !== undefined) appendFileSync(logFile, calls + "|" + fw + "|" + scenario + "\n");
let timeText = "5.00";
if (timeAtRaw !== undefined) {
    for (const part of timeAtRaw.split(",")) {
        const m = /^([1-9][0-9]*):(.+)$/.exec(part);
        if (!m) { console.error("stub: bad STUB_TIME_AT entry " + JSON.stringify(part)); process.exit(2); }
        if (Number(m[1]) === calls) timeText = m[2];
    }
}
if (noRowRaw !== undefined && !/^[1-9][0-9]*$/.test(noRowRaw)) { console.error("stub: bad STUB_NOROW_AT " + JSON.stringify(noRowRaw)); process.exit(2); }
const noRow = noRowRaw !== undefined && Number(noRowRaw) === calls;
if (nodeAtRaw !== undefined && !/^[1-9][0-9]*$/.test(nodeAtRaw)) { console.error("stub: bad STUB_NODE_AT " + JSON.stringify(nodeAtRaw)); process.exit(2); }
const nodeAt = nodeAtRaw !== undefined && Number(nodeAtRaw) === calls;
const cfg = DYNAMIC_TESTS.find((t) => t.name === scenario);
if (!cfg) { console.error("stub: unknown scenario " + scenario); process.exit(2); }
const SHA = "a".repeat(64);
const stamp = {
    kind: "bench-stamp/v1", date: "2026-11-23T12:00:00.000Z", protocol: "isolated-per-row", reps: 1,
    node: (tamper === "node" && fw === "reflex-quant") || (tamper === "sentinel" && calls === 25) || nodeAt ? "v1.0.0" : "v26.8.2", arch: "arm64", platform: "darwin", cpu: "Stub CPU",
    gcExposed: true, enginePath: "/x/Signal.js", engineSha256: SHA, harnessPath: "/x/mirror.mjs", harnessSha256: "b".repeat(64),
    config: { maxNodes: 1024, prealloc: "lazy" },
    extra: { ceiling_ms: 1500, quick: false, adapter: "destroy", scenario,
        captureId: tamper === "captureId" && fw === "reflex-quant" ? "20261123T120000Z-deadbeef" : process.env.CAPTURE_ID,
        refLibs: fw === "lite-signal" ? {} : { [fw]: "1.0.0" }, load1: 0.5 },
};
if (!(tamper === "sentinel-nostamp" && calls === 25)) console.log("#STAMP " + JSON.stringify(stamp));
const metrics = "nodesRecomputed=1000 nodesVisited=1000 edgesTraversed=4000 sinkReads=50 sum=777" + (fw === "lite-signal" ? " poolGrowths=0" : "");
if (!noRow) console.log([fw.padEnd(22), testColumn(cfg).padEnd(60), timeText.padEnd(8), metrics].join(" , "));
