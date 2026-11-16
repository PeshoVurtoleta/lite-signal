/**
 * AUD-F group 1 (burst 196, batch B3): the hot-body bytecode budget. Every function TurboFan / Maglev inline into another must keep its bytecode length
 * within --max-inlined-bytecode-size (460 on node 22 / 24 / 26), so executeEffect (462 on the frozen build on node 26, L-1 crossed the cap) stays inlinable.
 *
 * Oracle: .handoff/audf/PLAN-AUDF-G1.md ASSERTIONS A1 + the TASK 0 (d) / (e) census (the BUDGET list = every Signal.js function in an `Inlining X into Y`
 * line of the default driver on node 26, plus executeEffect), written independently of the fix. Tooling: ../bench/bytecode-budget.sh (test/106 pins it).
 * Engine under test: ../Signal.js, or the absolute path in env AUDF_SIGNAL (the mutant battery). The RED reference is ALWAYS test/fixtures/Signal-5af14f0b.js
 * (frozen build 66e2f27 / 5af14f0b); the identity row fails the file unless its sha256/8 is 5af14f0b.
 *
 * Rows run one after another (each runs the script, one node probe at a time), POSIX only (the script is bash). DETERMINISTIC tier: a length is a property
 * of one node binary and one source text; the gate is pinned to this node's own version and any run-to-run change is NO-VERDICT, never OVER.
 * Row labels: RED = fails on the fixture, passes on the fixed build; PIN = same on both.
 * Named mutant killed: LISTDROP (the A1 RED / live rows).
 *
 * BUDGET (14 functions through the script + read.set measured raw, the script's fn regex refuses a dot): executeEffect, flushEffects, read (two closures),
 * read.set, markDownstream, batch (two), peekComputed, pullComputed, pullMoved, sharedComputedPeek, sharedSignalPeek, effectTail, runCleanupC, runCleanupE,
 * fireRecompute. refreshComputed (770 on v26, never inlined: a host, not an inlinee) is REPORTED only.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../bench/bytecode-budget.sh", import.meta.url));
const DRIVER = fileURLToPath(new URL("./fixtures/bytecode-budget/hot-driver.mjs", import.meta.url));
const ENGINE_PATH = process.env.AUDF_SIGNAL || fileURLToPath(new URL("../Signal.js", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/Signal-5af14f0b.js", import.meta.url));
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';
const CAP = 460;
const skip = process.platform === "win32" ? "bash script: POSIX hosts only" : false;
const SPAWN = { encoding: "utf8", timeout: 300000, killSignal: "SIGKILL", maxBuffer: 1 << 26 };

const GATED = ["executeEffect", "flushEffects", "read", "markDownstream", "batch", "peekComputed", "pullComputed", "pullMoved",
    "sharedComputedPeek", "sharedSignalPeek", "effectTail", "runCleanupC", "runCleanupE", "fireRecompute"];

// Stage one build as ./Signal.js beside a copy of the driver. A build with Watch.js beside it is copied with it; the vendored fixture loads with its one
// re-export line removed (count-checked): the line is not function bytecode.
function stage(buildPath) {
    const dir = mkdtempSync(join(tmpdir(), "audf-g1-hb-"));
    if (existsSync(dirname(buildPath) + "/Watch.js")) { copyFileSync(buildPath, join(dir, "Signal.js")); copyFileSync(dirname(buildPath) + "/Watch.js", join(dir, "Watch.js")); }
    else {
        const parts = readFileSync(buildPath, "utf8").split(WATCH_LINE);
        assert.equal(parts.length, 2, "Watch re-export line matched " + (parts.length - 1) + " times");
        writeFileSync(join(dir, "Signal.js"), parts[0] + parts[1]);
    }
    const drv = join(dir, "hot-driver.mjs");
    copyFileSync(DRIVER, drv);
    return { dir, drv };
}
function script(args, drv) {
    const r = spawnSync("bash", [SCRIPT, "--node", process.execPath, ...args, drv], SPAWN);
    if (r.error) assert.fail("script error: " + r.error.message);
    if (r.signal !== null) assert.fail("script killed by " + r.signal);
    return r;
}
const lensOf = (out, fn) => { const m = out.match(new RegExp("^  " + fn + ": (\\d+) match\\(es\\): ([0-9,]+)$", "m")); assert.ok(m, "no match line for " + fn + "\n" + out); return m[2].split(",").map(Number); };
const verdictOf = (out, fn) => { const m = out.match(new RegExp("^  " + fn + ": (WITHIN|OVER|REPORTED|NO-VERDICT) -- (.*)$", "m")); assert.ok(m, "no verdict line for " + fn + "\n" + out); return { v: m[1], why: m[2] }; };
// read.set cannot go through the script (a dotted name is refused): measure it raw. The header line names the function, the next `Bytecode length:` is its length.
function rawLens(drv, fn) {
    const r = spawnSync(process.execPath, ["--print-bytecode", "--print-bytecode-filter=" + fn, drv], { ...SPAWN, cwd: dirname(drv), env: { ...process.env, NODE_OPTIONS: "" } });
    if (r.error) assert.fail("raw probe error: " + r.error.message);
    assert.equal(r.status, 0, String(r.stderr).slice(-300));
    const out = String(r.stdout).split("\n"), lens = [];
    for (let i = 0; i < out.length; i++) {
        if (new RegExp("^\\[generated bytecode for function: " + fn.replace(".", "\\.") + " \\(").test(out[i])) {
            for (let j = i + 1; j < out.length && j < i + 12; j++) { const m = out[j].match(/^Bytecode length: (\d+)$/); if (m) { lens.push(Number(m[1])); break; } }
        }
    }
    return lens;
}

let LIVE = null, FIX = null;
before(() => { if (!skip) { LIVE = stage(ENGINE_PATH); FIX = stage(FIXTURE_PATH); } });
after(() => { for (const s of [LIVE, FIX]) if (s) rmSync(s.dir, { recursive: true, force: true }); });

describe("fixture identity", () => {
    it("the vendored RED reference is 5af14f0b", () => {
        assert.equal(createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex").slice(0, 8), "5af14f0b");
    });
});

describe("A1 hot-body bytecode budget (sequential, POSIX)", () => {
    it("this node's max-inlined-bytecode-size default is 460, else the budget below is a different question", { skip }, () => {
        const r = spawnSync(process.execPath, ["--v8-options"], { ...SPAWN, env: { ...process.env, NODE_OPTIONS: "" } });
        assert.equal(r.status, 0);
        const m = String(r.stdout).match(/^\s*--max-inlined-bytecode-size \([^\n]*\)\n\s*type: int\s+default: --max-inlined-bytecode-size=(\d+)\s*$/m);
        assert.ok(m, "the option line was not found in --v8-options");
        assert.equal(Number(m[1]), CAP);
    });
    it("[RED] engine (RED on node 26; on v22 / v24 the fixture's executeEffect is 451 / 453): every BUDGET inlinee is <= 460 (exit 0, every function WITHIN, every function found); read and batch have both closures (kills LISTDROP)", { skip }, () => {
        const r = script(["--max", GATED.map((f) => f + "=" + CAP).join(","), "--node-version", process.version], LIVE.drv);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /^VERDICT WITHIN$/m);
        for (const f of GATED) assert.equal(verdictOf(r.stdout, f).v, "WITHIN", f + ": " + verdictOf(r.stdout, f).why);
        // coverage floor: the report mode names every length (the gate line only says WITHIN); read / batch each have two closures of that name
        const rep = script(["--fn", "read,batch", "--node-version", process.version], LIVE.drv);
        assert.equal(rep.status, 0, rep.stdout + rep.stderr);
        assert.equal(lensOf(rep.stdout, "read").length, 2);
        assert.equal(lensOf(rep.stdout, "batch").length, 2);
    });
    it("[PIN] the gated list is exactly the BUDGET set (14 names, executeEffect and flushEffects included): a dropped entry fails (kills LISTDROP)", () => {
        // the BUDGET set of the header: executeEffect, flushEffects, read, markDownstream, batch, peekComputed, pullComputed, pullMoved,
        // sharedComputedPeek, sharedSignalPeek, effectTail, runCleanupC, runCleanupE, fireRecompute (read.set is measured raw, refreshComputed is REPORTED)
        assert.deepEqual(GATED, ["executeEffect", "flushEffects", "read", "markDownstream", "batch", "peekComputed", "pullComputed", "pullMoved",
            "sharedComputedPeek", "sharedSignalPeek", "effectTail", "runCleanupC", "runCleanupE", "fireRecompute"]);
    });
    it("[PIN] engine: read.set (measured raw) is <= 460 (279 on the fixture too)", { skip }, () => {
        const lens = rawLens(LIVE.drv, "read.set");
        assert.ok(lens.length >= 1, "read.set was not compiled / not found");
        for (const l of lens) assert.ok(l <= CAP, "read.set length " + l);
    });
    it("[REPORTED] engine: refreshComputed length (never inlined: a host, not gated)", { skip }, () => {
        const r = script(["--fn", "refreshComputed", "--node-version", process.version], LIVE.drv);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(verdictOf(r.stdout, "refreshComputed").v, "REPORTED");
        console.log("# REPORTED refreshComputed bytecode length(s) on " + process.version + ": " + lensOf(r.stdout, "refreshComputed").join(","));
    });
    it("[RED reference] fixture: executeEffect is OVER 460 (462 on node 26); skipped on a node major where the frozen executeEffect is <= 460 (v22: 451, v24: 453)", { skip }, (t) => {
        const rep = script(["--fn", "executeEffect", "--node-version", process.version], FIX.drv);
        assert.equal(rep.status, 0, rep.stdout + rep.stderr);
        const lens = lensOf(rep.stdout, "executeEffect");
        if (lens.every((l) => l <= CAP)) return t.skip("frozen executeEffect is " + lens.join(",") + " <= 460 on " + process.version);
        const r = script(["--max", "executeEffect=" + CAP, "--node-version", process.version], FIX.drv);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /^VERDICT OVER$/m);
        const v = verdictOf(r.stdout, "executeEffect");
        assert.equal(v.v, "OVER");
        if (process.version.startsWith("v26.")) assert.equal(v.why, "length(s) 462 > max 460");   // TASK 0 (d), node 26.3.1 and 26.8.2
    });
    it("[PIN] boundary control: max = measured length - 1 gives OVER (exit 1), max = measured length gives WITHIN (exit 0), for the live executeEffect", { skip }, () => {
        const rep = script(["--fn", "executeEffect", "--node-version", process.version], LIVE.drv);
        assert.equal(rep.status, 0, rep.stdout + rep.stderr);
        const lens = lensOf(rep.stdout, "executeEffect");
        assert.equal(lens.length, 1);
        const L = lens[0];
        const below = script(["--max", "executeEffect=" + (L - 1), "--node-version", process.version], LIVE.drv);
        assert.equal(below.status, 1, below.stdout + below.stderr);
        assert.equal(verdictOf(below.stdout, "executeEffect").v, "OVER");
        const at = script(["--max", "executeEffect=" + L, "--node-version", process.version], LIVE.drv);
        assert.equal(at.status, 0, at.stdout + at.stderr);
        assert.equal(verdictOf(at.stdout, "executeEffect").v, "WITHIN");
    });
});
