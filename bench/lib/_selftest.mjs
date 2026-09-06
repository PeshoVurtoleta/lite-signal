// bench/lib/_selftest.mjs -- proves the Session-1 infra works against the REAL engine
// and that each guard catches the exact incident it is named for. Run:
//   node --expose-gc bench/lib/_selftest.mjs
import { createRegistry } from "../../Signal.js";
import { makeStamp, formatStamp, formatStampLine, parseStampFromText, PROTOCOLS } from "./stamp.mjs";
import { summarizeSamples, median, primaryScore } from "./stats.mjs";
import * as G from "./guards.mjs";
import { buildSchedule, withSentinel, sentinelDrift } from "./schedule.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL " + msg); } };

// --- stats: median primary, matches aggregateReactive even-n rule -----------------
ok(median([3, 1, 2]) === 2, "median odd = middle");
ok(median([1, 2, 3, 4]) === 2.5, "median even = mean of middles (matches aggregateReactive)");
const s = summarizeSamples([10, 12, 11, 13, 100]);
ok(s.median === 12, "summarize median");
ok(s.min === 10 && s.max === 100, "summarize min/max");
ok(primaryScore([5, 5, 5]) === 5, "primaryScore is median");

// --- stamp: single-reference echo -- the config the stamp prints IS the one used ---
const LITE_CONFIG = Object.freeze({ maxNodes: 1 << 18, maxLinks: 1 << 21, prealloc: "eager", onCapacityExceeded: "grow", flushStrategy: "sab" });
const reg = createRegistry(LITE_CONFIG);       // same reference to both:
const stamp = makeStamp({
    enginePath: new URL("../../Signal.js", import.meta.url).href,
    harnessPath: import.meta.url,
    config: LITE_CONFIG,                        // <- identical object
    protocol: PROTOCOLS.PER_ROW,
    reps: 10,
});
ok(stamp.config.flushStrategy === "sab", "stamp echoes the LIVE config (sab), not a hand-typed 'eager'");
ok(/^[0-9a-f]{64}$/.test(stamp.engineSha256), "engine sha256 computed");
ok(/^[0-9a-f]{64}$/.test(stamp.harnessSha256), "harness sha256 computed");
// round-trip through text
const text = formatStamp(stamp) + "\n" + formatStampLine(stamp) + "\nsome , data , row\n";
const parsed = parseStampFromText(text);
ok(parsed && parsed.engineSha256 === stamp.engineSha256, "stamp survives text round-trip");
reg.destroy();

// --- guard 1: dead sink (the MUX 22,032K fiction) ---------------------------------
{
    const v = G.makeVerdict();
    G.checkDeadSink(v, "MUX/lite", 0);          // sink never written
    ok(!v.ok && /DEAD SINK/.test(v.failures[0]), "deadSink guard catches sink=0");
}
// --- guard 2: counter disagreement (F6 -- unequal work) ---------------------------
{
    const v = G.makeVerdict();
    G.checkCounterAgreement(v, "large web app", "edgesTraversed",
        [{ framework: "lite", value: 5891713 }, { framework: "alien", value: 5891713 }, { framework: "preact", value: 4200000 }]);
    ok(!v.ok && /COUNTER DISAGREEMENT/.test(v.failures[0]), "counter guard catches an engine doing less work");
    const v2 = G.makeVerdict();
    G.checkCounterAgreement(v2, "large web app", "edgesTraversed",
        [{ framework: "lite", value: 5891713 }, { framework: "alien", value: 5891713 }]);
    ok(v2.ok, "counter guard passes when work is equal");
}
// --- guard 3: checksum + guard 4: expected ---------------------------------------
{
    const v = G.makeVerdict();
    G.checkChecksum(v, "manyEffectsFromOneSource", [{ framework: "lite", checksum: 180075672000 }, { framework: "alien", checksum: 999 }]);
    ok(!v.ok && /CHECKSUM/.test(v.failures[0]), "checksum guard catches divergence");
    const v2 = G.makeVerdict();
    G.checkExpected(v2, "pure push", "lite", { sum: 5242355712, count: 910133 }, { sum: 5242355712, count: 910133 });
    ok(v2.ok, "expected guard passes on the real Andrii pure-push vector");
    const v3 = G.makeVerdict();
    G.checkExpected(v3, "pure push", "lite", { sum: 5242355712, count: 42 }, { sum: 5242355712, count: 910133 });
    ok(!v3.ok && /EXPECTED COUNT/.test(v3.failures[0]), "expected guard catches wrong count");
}
// --- aggregator: stamp consistency (F2) ------------------------------------------
{
    const base = { engineSha256: "a".repeat(64), protocol: PROTOCOLS.PER_ROW, cpu: "M4 Pro", node: "v22", arch: "arm64" };
    const good = [1, 2, 3].map((i) => ({ path: `rep${i}`, stamp: { ...base } }));
    ok(G.assertStampsConsistent(good).ok, "consistent stamps merge");
    const mixedEngine = [{ path: "a", stamp: { ...base } }, { path: "b", stamp: { ...base, engineSha256: "b".repeat(64) } }];
    ok(!G.assertStampsConsistent(mixedEngine).ok, "mixed engine hashes refused");
    const smoke = [{ path: "a", stamp: { ...base, protocol: PROTOCOLS.SMOKE } }];
    ok(!G.assertStampsConsistent(smoke).ok, "shared-process-smoke refused for publishable merge");
    const noStamp = [{ path: "a", stamp: null }];
    ok(!G.assertStampsConsistent(noStamp).ok, "missing stamp refused");
    ok(!G.assertRepCount(good, 10, "lite").ok, "rep-count guard catches 'median of 10' over 3 files (F2)");
    ok(G.assertRepCount(good, 3, "lite").ok, "rep-count guard passes when counts match");
}
// --- schedule: round-robin spreads the hot slot (F3) -----------------------------
{
    const steps = buildSchedule(["lite", "alien", "preact"], 3);
    ok(steps.length === 9, "schedule has engines*reps steps");
    // last position of each wave should NOT always be the same engine (that's the bias)
    const lastOfWave = [steps[2].engine, steps[5].engine, steps[8].engine];
    ok(new Set(lastOfWave).size > 1, "hot (last) slot rotates across waves, not pinned to one engine");
    const withSent = withSentinel(steps);
    ok(withSent[withSent.length - 1].sentinel === true, "sentinel appended");
    ok(sentinelDrift(100, 106).drifted === true, "6% sentinel delta flags drift");
    ok(sentinelDrift(100, 103).drifted === false, "3% sentinel delta is within tolerance");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} -- ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
