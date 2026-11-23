// STUB bench/mirror.mjs for test/136 (copied over mirror.mjs in a tmp copy of bench/). Prints one
// #STAMP line and one data row for FW x SCENARIO, as the real child does under ROWS_ONLY=1, with
// no engine. Values are identical for every engine and rep, and the time is constant (the
// sentinel is stable). STUB_TAMPER: "node" -> reflex-quant stamps another node; "captureId" ->
// reflex-quant stamps another captureId.
import { appendFileSync, readFileSync } from "node:fs";
import { DYNAMIC_TESTS } from "./lib/mirror-config.mjs";
import { testColumn } from "./lib/title.mjs";
let calls = 0;
if (process.env.STUB_COUNT_FILE) { appendFileSync(process.env.STUB_COUNT_FILE, "x"); calls = readFileSync(process.env.STUB_COUNT_FILE, "utf8").length; }
const fw = process.env.FW, scenario = process.env.SCENARIO, tamper = process.env.STUB_TAMPER;
const cfg = DYNAMIC_TESTS.find((t) => t.name === scenario);
if (!cfg) { console.error("stub: unknown scenario " + scenario); process.exit(2); }
const SHA = "a".repeat(64);
const stamp = {
    kind: "bench-stamp/v1", date: "2026-11-23T12:00:00.000Z", protocol: "isolated-per-row", reps: 1,
    node: (tamper === "node" && fw === "reflex-quant") || (tamper === "sentinel" && calls === 25) ? "v1.0.0" : "v26.8.2", arch: "arm64", platform: "darwin", cpu: "Stub CPU",
    gcExposed: true, enginePath: "/x/Signal.js", engineSha256: SHA, harnessPath: "/x/mirror.mjs", harnessSha256: "b".repeat(64),
    config: { maxNodes: 1024, prealloc: "lazy" },
    extra: { ceiling_ms: 1500, quick: false, adapter: "destroy", scenario,
        captureId: tamper === "captureId" && fw === "reflex-quant" ? "20261123T120000Z-deadbeef" : process.env.CAPTURE_ID,
        refLibs: fw === "lite-signal" ? {} : { [fw]: "1.0.0" }, load1: 0.5 },
};
if (!(tamper === "sentinel-nostamp" && calls === 25)) console.log("#STAMP " + JSON.stringify(stamp));
const metrics = "nodesRecomputed=1000 nodesVisited=1000 edgesTraversed=4000 sinkReads=50 sum=777" + (fw === "lite-signal" ? " poolGrowths=0" : "");
console.log([fw.padEnd(22), testColumn(cfg).padEnd(60), "5.00".padEnd(8), metrics].join(" , "));
