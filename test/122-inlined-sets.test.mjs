/**
 * b215 G2 TASK 1 (burst 220, unit G2 B1): the TurboFan inlined sets and the Maglev decision for the hot write / read paths, pinned per node version.
 *
 * Oracle: .handoff/b215/PLAN-b215.md GROUP 2 TASK 1 as amended by A-b220-5 = D-b220-1 "Deterministic flags" (supersedes ASSERTION 1's values and the
 * 1004 cap). Census: .handoff/b215/inlined-sets/census.txt (node v26.8.2, untimed, 3/3 identical): after b5289277 == before da5ddb86 in every mode.
 * Re-census b229 (U5 B2, .handoff/b228/u5b2/census-coded.txt, node v26.8.2, untimed, 3/3 identical) on 84068786 (the F-b224-1 pinned-slot fix): every
 * multiset, refusal reason and the Maglev line unchanged; read.set's existing opt code grew 636 -> 650, so READSET_EXISTING and the cap moved.
 * Flags: --no-concurrent-recompilation --single-threaded, NODE_OPTIONS stripped. Under these flags read.set gets its own TurboFan code before the hot
 * function compiles, so the hot function is offered read.set at 279 + 650 (its existing opt code's inlined bytes) = 929, x1.2 = 1114.8, truncated to
 * 1114 > 920: refused (b5289277: 279 + 636 = 915, cap 1098).
 * Fable's table (audit/2026-11-19-hotpath-fable: markDownstream / read.set inlined into hotSet, flushEffects refused, cap 1003) holds only under
 * concurrent flags, where compile order races (reads6 gave x4 / x8 / x12 / x16 over 10 runs) -- not a DETERMINISTIC-tier gate.
 *
 * Driver: fixtures/inlined-sets/driver.mjs (Fable driver2.mjs body verbatim, imports ./Signal.js), staged beside each build as test/118 stages its driver
 * (a build with Watch.js beside it is copied with it; the vendored fixture loses its one Watch re-export line, count-checked). Engine under test:
 * ../Signal.js, or the absolute path in env INLINED_SETS_SIGNAL (revert proof). RED reference: fixtures/Signal-f8dd50f8.js (1.5.2 = ec36ab8), identity row.
 * Pins apply only on PIN_KEY (v26.8.2, CI PIN_NODE); any other node prints REPORTED and skips the assertion. One node process at a time.
 * Row labels: PIN = measured value on the live engine; A/A = run-to-run identity; MUST-FAIL = the control misses the pin; REPORTED = printed only.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PIN_KEY = "v26.8.2";
const PINNED = process.version === PIN_KEY;
const DRIVER = fileURLToPath(new URL("./fixtures/inlined-sets/driver.mjs", import.meta.url));
const ENGINE_PATH = process.env.INLINED_SETS_SIGNAL || fileURLToPath(new URL("../Signal.js", import.meta.url));
if (process.env.INLINED_SETS_SIGNAL) console.log("# engine under test (INLINED_SETS_SIGNAL): " + ENGINE_PATH);
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/Signal-f8dd50f8.js", import.meta.url));
const CI_PATH = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';
const FLAGS = ["--no-concurrent-recompilation", "--single-threaded"];
const SPAWN = { encoding: "utf8", timeout: 300000, killSignal: "SIGKILL", maxBuffer: 1 << 28, env: { ...process.env, NODE_OPTIONS: "", NODE_V8_COVERAGE: undefined } };

// Measured on v26.8.2 (census.txt MODE sync; before da5ddb86 == after b5289277; b229 re-census on 84068786: the same sets, read.set existing 636 -> 650).
const PIN = {
    setLoop: { inl: { "flushEffects -> read.set": 1, "markDownstream -> read.set": 1 }, ref: {}, hot: "hotSet", sites: 1 },
    setTwo: { inl: { "flushEffects -> read.set": 1, "markDownstream -> read.set": 1 }, ref: {}, hot: "hotSet2", sites: 2 },
    reads6: { inl: { "read -> hotReads6": 8 }, ref: { "refreshComputed : exceeds bytecode limit": 4 } },   // 2 compiles of hotReads6 x 4
};
const READSET_SIZE = 279, READSET_EXISTING = 650;                 // the refused read.set candidate in the hot function (84068786; 279 / 636 on b5289277)
// 1114: V8 reserve_inline_budget_scale_factor 1.2 x 929 = 1114.8, truncated. Measured b229 (census-coded.txt, caps 1112..1117 x3): read.set -> hotSet
// absent at 1112 / 1113, present at 1114..1117, so V8 truncates (rounding up would give 1115). b5289277's 1.2 x 915 = 1098 was integral and proved neither.
const CAP = Math.trunc(1.2 * (READSET_SIZE + READSET_EXISTING));
const MAGLEV_READ = ["cannot inline {<SharedFunctionInfo read>}: big function, size (106) >= max-size (100)"];

function stage(buildPath) {
    const dir = mkdtempSync(join(tmpdir(), "b215-g2-inl-"));
    if (existsSync(dirname(buildPath) + "/Watch.js")) { copyFileSync(buildPath, join(dir, "Signal.js")); copyFileSync(dirname(buildPath) + "/Watch.js", join(dir, "Watch.js")); }
    else {
        const parts = readFileSync(buildPath, "utf8").split(WATCH_LINE);
        assert.equal(parts.length, 2, "Watch re-export line matched " + (parts.length - 1) + " times");
        writeFileSync(join(dir, "Signal.js"), parts[0] + parts[1]);
    }
    copyFileSync(DRIVER, join(dir, "driver.mjs"));
    return dir;
}
function trace(dir, kind, wl, extra = []) {
    const r = spawnSync(process.execPath, [...FLAGS, kind, ...extra, join(dir, "driver.mjs"), wl], { ...SPAWN, cwd: dir });
    if (r.error) assert.fail("probe error: " + r.error.message);
    assert.equal(r.signal, null, "probe killed by " + r.signal);
    assert.equal(r.status, 0, String(r.stderr).slice(-300));
    assert.match(r.stdout, new RegExp("^DRIVER2-CHK " + wl + " ", "m"));
    return String(r.stdout);
}
// Same parse as audit/2026-11-19-hotpath-fable/work/trsum.mjs's Inlining / Cannot consider / Budget regexes (its free-text note branch omitted), plus the refused read.set targets.
const nm = (s) => { const m = /<SharedFunctionInfo ?([^>]*)>/.exec(s); return m ? (m[1] || "(anon)") : "?"; };
function tf(dir, wl, extra) {
    const inl = {}, ref = {}, budgets = [], readSet = [];
    for (const s of trace(dir, "--trace-turbo-inlining", wl, extra).split("\n")) {
        let m;
        if ((m = /^Inlining (.*?) into (.*?)( \(inside try-block\))?$/.exec(s))) { const k = nm(m[1]) + " -> " + nm(m[2]); inl[k] = (inl[k] || 0) + 1; }
        else if ((m = /^Cannot consider (.*?) for inlining \(reason: (.*)\)/.exec(s))) { const k = nm(m[1]) + " : " + m[2]; ref[k] = (ref[k] || 0) + 1; }
        else if ((m = /^Budget used: (\d+)\/(\d+)/.exec(s))) budgets.push([+m[1], +m[2]]);
        else if ((m = /^\s+- target: .*<SharedFunctionInfo read\.set>\}, bytecode size: (\d+), existing opt code's inlined bytecode size: (\d+)$/.exec(s))) readSet.push(m[1] + "/" + m[2]);
    }
    return { inl, ref, budgets, readSet };
}
const mgRead = (dir) => trace(dir, "--trace-maglev-inlining", "sigReads10").split("\n").filter((s) => /<SharedFunctionInfo read>/.test(s))
    .map((s) => s.replace(/0x[0-9a-f]+ ?/g, "").replace(/\{\s*/g, "{").trim());
const sorted = (o) => Object.fromEntries(Object.entries(o).sort());
const matchesSet = (got, wl) => JSON.stringify(sorted(got.inl)) === JSON.stringify(sorted(PIN[wl].inl)) && JSON.stringify(sorted(got.ref)) === JSON.stringify(sorted(PIN[wl].ref));
const matchesMaglev = (lines) => lines.length >= 1 && JSON.stringify([...new Set(lines)]) === JSON.stringify(MAGLEV_READ);
function refusal(got, wl) {   // read.set offered to the hot function at READSET_SIZE + READSET_EXISTING at every call site, never inlined into it
    const p = PIN[wl];
    return got.readSet.length === p.sites && got.readSet.every((x) => x === READSET_SIZE + "/" + READSET_EXISTING) && !(("read.set -> " + p.hot) in got.inl)
        && got.budgets.every(([, cap]) => cap === 920);
}
function gate(t, label, ok, detail) {
    if (!PINNED) { console.log("# REPORTED " + label + " on " + process.version + " (pins are " + PIN_KEY + " only): " + detail); return t.skip("REPORTED on " + process.version); }
    assert.ok(ok, label + ": " + detail);
}

let LIVE = null, FIX = null;
const memo = new Map();
const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
before(() => { LIVE = stage(ENGINE_PATH); FIX = stage(FIXTURE_PATH); });
after(() => { for (const d of [LIVE, FIX]) if (d) rmSync(d, { recursive: true, force: true }); });

describe("fixture identity", () => {
    it("the vendored RED reference is f8dd50f8 (1.5.2, ec36ab8)", () => {
        assert.equal(createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex").slice(0, 8), "f8dd50f8");
    });
});

describe("b215 G2 inlined sets (A-b220-5, deterministic flags, sequential)", () => {
    it("[PIN] CI PIN_NODE equals the pin key " + PIN_KEY, () => {
        const m = readFileSync(CI_PATH, "utf8").match(/^\s*PIN_NODE:\s*'([^']+)'\s*$/m);
        assert.ok(m, "PIN_NODE not found in ci.yml");
        assert.equal("v" + m[1], PIN_KEY);
    });
    for (const wl of ["setLoop", "setTwo"]) {
        it("[PIN] engine " + wl + ": inlined multiset {flushEffects -> read.set, markDownstream -> read.set}, no refusal line", (t) => {
            const g = once("live/" + wl, () => tf(LIVE, wl));
            gate(t, wl + " set", matchesSet(g, wl), JSON.stringify(g.inl) + " refused " + JSON.stringify(g.ref));
        });
        it("[PIN] engine " + wl + ": read.set refused by " + PIN[wl].hot + " at the 920 budget (offered at " + READSET_SIZE + " + existing " + READSET_EXISTING + ", x" + PIN[wl].sites + " site(s))", (t) => {
            const g = once("live/" + wl, () => tf(LIVE, wl));
            gate(t, wl + " read.set refusal", refusal(g, wl), "read.set targets " + JSON.stringify(g.readSet) + " inlined " + JSON.stringify(g.inl));
        });
    }
    it("[PIN] engine reads6: read -> hotReads6 x8 (2 compiles x 4), refreshComputed refused x4", (t) => {
        const g = once("live/reads6", () => tf(LIVE, "reads6"));
        gate(t, "reads6 set", matchesSet(g, "reads6"), JSON.stringify(g.inl) + " refused " + JSON.stringify(g.ref));
    });
    it("[PIN] engine Maglev (sigReads10): the signal read is refused, big function, size (106) >= max-size (100); never inlined", (t) => {
        const lines = once("live/mg", () => mgRead(LIVE));
        gate(t, "Maglev read", matchesMaglev(lines), lines.length + " decision line(s): " + JSON.stringify([...new Set(lines)]));
    });
    it("[A/A] engine setTwo run twice gives the same multiset and refusal targets", () => {
        const a = once("live/setTwo", () => tf(LIVE, "setTwo")), b = tf(LIVE, "setTwo");
        assert.deepEqual(sorted(b.inl), sorted(a.inl));
        assert.deepEqual(sorted(b.ref), sorted(a.ref));
        assert.deepEqual(b.readSet, a.readSet);
    });
    // setTwo is NOT asserted red on 1.5.2: under these flags the hot function inlines nothing on either build (read.set is refused there too, at 252 + 589),
    // so its {flushEffects, markDownstream} -> read.set multiset is equal; the 1.5.2 refusal numbers differ, which the revert proof records.
    it("[MUST-FAIL] fixture 1.5.2 misses the reads6 pin (read x6, pullComputed refused) and the Maglev pin (read inlined)", (t) => {
        const g = tf(FIX, "reads6"), lines = mgRead(FIX);
        if (!PINNED) { console.log("# REPORTED fixture reads6 " + JSON.stringify(g.inl) + " Maglev " + JSON.stringify([...new Set(lines)])); return t.skip("REPORTED on " + process.version); }
        assert.equal(matchesSet(g, "reads6"), false, "1.5.2 reads6 matched the pin: " + JSON.stringify(g.inl));
        assert.equal(matchesMaglev(lines), false, "1.5.2 Maglev matched the pin");
        assert.ok(lines.includes("== Inlining <SharedFunctionInfo read>"), "1.5.2 Maglev did not inline the signal read");
    });
    it("[MUST-FAIL] cap control setLoop: read.set -> hotSet absent at cap " + (CAP - 1) + ", present at " + CAP + " = trunc(1.2 x (" + READSET_SIZE + " + " + READSET_EXISTING + "))", (t) => {
        const lo = tf(LIVE, "setLoop", ["--max-inlined-bytecode-size-cumulative=" + (CAP - 1)]);
        const hi = tf(LIVE, "setLoop", ["--max-inlined-bytecode-size-cumulative=" + CAP]);
        const nlo = lo.inl["read.set -> hotSet"] || 0, nhi = hi.inl["read.set -> hotSet"] || 0;
        if (!PINNED) { console.log("# REPORTED cap " + (CAP - 1) + ":" + nlo + " " + CAP + ":" + nhi); return t.skip("REPORTED on " + process.version); }
        assert.equal(CAP, 1114);
        assert.equal(nlo, 0, "read.set inlined into hotSet below the cap");
        assert.equal(nhi, 1, "read.set not inlined into hotSet at the cap");
        assert.ok(hi.budgets.some(([, c]) => c === CAP), "the raised cap was not in effect");
    });
    it("[REPORTED] largest budget used per workload and headroom vs 920", () => {
        for (const wl of ["setLoop", "setTwo", "reads6"]) {
            const g = once("live/" + wl, () => tf(LIVE, wl));
            const mx = Math.max(0, ...g.budgets.map(([u]) => u));
            console.log("# REPORTED " + process.version + " " + wl + ": max budget used " + mx + " of 920, headroom " + (920 - mx));
        }
    });
});
