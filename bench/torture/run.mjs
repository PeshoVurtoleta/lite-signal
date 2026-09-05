#!/usr/bin/env node
/**
 * bench/torture/run.mjs — one entry point for the whole torture suite.
 *
 * Replaces six separate `node --expose-gc bench/torture/<file>.mjs` invocations
 * (and the ad-hoc shell loops people were writing around them) with a single
 * runner that knows which scenarios exist, what each one costs, and how to
 * filter them.
 *
 * Each scenario stays a standalone executable module -- runnable directly when
 * you are iterating on one -- and the runner spawns them as child processes
 * rather than importing them. That is deliberate: several scenarios assert on
 * GLOBAL pool accounting and on the default registry, so running two of them in
 * one process would let the first one's residue poison the second's baseline.
 * Process isolation is the only way those assertions mean anything.
 *
 * Usage:
 *   node bench/torture/run.mjs                  # everything
 *   node bench/torture/run.mjs --group semantic # correctness only (fast, CI)
 *   node bench/torture/run.mjs --group soak     # resource soaks only
 *   node bench/torture/run.mjs oracle glitch    # substring match on names
 *   node bench/torture/run.mjs --list
 *   node bench/torture/run.mjs --seconds 30     # override soak duration
 *   node bench/torture/run.mjs --bail           # stop at the first failure
 *
 * Exit code: 0 iff every selected scenario exited 0.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Reserved child exit codes. Must match helpers/index.mjs.
 *  77 = engine below the scenario's floor (floor-escalated at/above it).
 *  78 = environment prerequisite missing (NEVER floor-escalated — the engine's
 *       floor says nothing about the host runtime). */
const SKIP_EXIT = 77;
const ENV_SKIP_EXIT = 78;

/**
 * `semantic` scenarios are deterministic, fast and assert on MEANING — values,
 * wakeups, work, ordering. They belong in CI on every commit.
 *
 * `soak` scenarios are wall-clock bound and assert on RESOURCES — nothing threw,
 * the pool came back. They belong in a nightly or pre-publish job; running them
 * per-commit buys little and costs minutes.
 *
 * `floor` is the engine version whose surface the scenario needs. A scenario
 * that SKIPs while the engine under test is AT or ABOVE its floor is a FAILURE,
 * not a skip: the feature exists at that version, so a skip can only mean a
 * dropped export or a broken feature-detect — the exact regression a skip used
 * to convert into silent green. (--lenient downgrades this to a plain skip.)
 */
const SCENARIOS = [
    { name: "oracle-fuzzer", group: "semantic", file: "oracle-fuzzer.mjs", floor: "1.4.0", about: "values vs an independent reference evaluator" },
    { name: "glitch-hunter", group: "semantic", file: "glitch-hunter.mjs", floor: "1.4.0", about: "glitch freedom + exact wakeup accounting" },
    { name: "work-accounting", group: "semantic", file: "work-accounting.mjs", floor: "1.4.0", about: "minimum body-execution counts" },
    { name: "concurrent-storm", group: "semantic", file: "concurrent-storm.mjs", floor: "1.4.0", about: "reentrancy, nesting, flush ordering" },
    { name: "scheduler-storm", group: "semantic", file: "scheduler-storm.mjs", floor: "1.4.0", about: "deferred execution, ABA thunks, coalescing" },
    { name: "box-torture", group: "semantic", file: "box-torture.mjs", floor: "1.5.0", about: "signalBox/computedBox interop + surface (1.5.0+)" },
    { name: "scope-torture", group: "semantic", file: "scope-torture.mjs", floor: "1.6.0", about: "createScope adoption + disposal-crash fuzz (1.6.0+)" },
    { name: "retrack-dispose-torture", group: "semantic", file: "retrack-dispose-torture.mjs", floor: "1.4.0", about: "dispose-during-retracking cursor hazard + seeded disposal fuzz" },
    { name: "owner-torture", group: "semantic", file: "owner-torture.mjs", floor: "1.5.0", about: "getOwner/runWithOwner capture-restore + ABA degradation" },
    { name: "async-torture", group: "semantic", file: "async-torture.mjs", floor: "1.4.0", about: "watch/when/whenAsync contracts + fuzz" },
    { name: "capacity-torture", group: "semantic", file: "capacity-torture.mjs", floor: "1.4.0", about: "fail-closed pool boundary + CapacityError + the 16x grow ceiling" },
    { name: "error-torture", group: "semantic", file: "error-torture.mjs", floor: "1.4.0", about: "throwing effect bodies: per-effect buffering, AggregateError, buffer drain" },
    { name: "contract-torture", group: "semantic", file: "contract-torture.mjs", floor: "1.4.0", about: "throw-inside-batch, write-inside-computed, equals contract under churn" },
    { name: "interop-torture", group: "semantic", file: "interop-torture.mjs", floor: "1.4.0", about: "multi-registry isolation + destroy() staleness degradation" },
    { name: "deep-chain-torture", group: "semantic", file: "deep-chain-torture.mjs", floor: "1.4.0", about: "pullComputed recursion fail-closed (RangeError) vs iterative push path" },
    { name: "flush-torture", group: "semantic", file: "flush-torture.mjs", floor: "1.7.0", about: "flushStrategy eager/sab/manual + subscribe (1.7.0+)" },
    { name: "cleanup-return-torture", group: "semantic", file: "cleanup-return-torture.mjs", floor: "1.8.0", about: "effect cleanup return + compose order (1.8.0+)" },
    { name: "dispose-torture", group: "semantic", file: "dispose-torture.mjs", floor: "1.9.0", about: "Symbol.dispose / using on lifecycle objects (1.9.0+)" },
    { name: "zerogc-torture", group: "semantic", file: "zerogc-torture.mjs", floor: "1.4.0", about: "zero-GC hot path via measureAllocs/measureOps + stats counters; ZEROGC_BREAK self-test" },
    { name: "op-accounting", group: "semantic", file: "op-accounting.mjs", floor: "1.4.0", about: "structural work via onGraphMutation opcode lane" },
    { name: "introspect-torture", group: "semantic", file: "introspect-torture.mjs", floor: "1.4.0", about: "describe/forEach*/hasObservers/ownerOf + ABA gen-stamp guard" },
    { name: "lifecycle-torture", group: "semantic", file: "lifecycle-torture.mjs", floor: "1.4.0", about: "createRoot detachment + destroy registry reset" },
    { name: "graph-fuzzer", group: "soak", file: "graph-fuzzer.mjs", floor: "1.4.0", about: "1.5k-node random DAG churn" },
    { name: "scheduler-bench", group: "soak", file: "scheduler-bench.mjs", floor: "1.4.0", about: "microtask scheduler saturation" },
    { name: "torture-soak", group: "soak", file: "torture-soak.mjs", floor: "1.4.0", about: "7.5k-node continuous rewiring" },
    { name: "wraparound-torture", group: "soak", file: "wraparound-torture.mjs", floor: "1.4.0", about: "2^31 dormancy band at full distance (opt-in: TORTURE_WRAPAROUND=1, ~30s)" },
];

/* ── engine version (for floor enforcement) ───────────────────────────────── */

/** major.minor.patch as a comparable number; prerelease tags are IGNORED on
 *  purpose — a 1.6.0-beta engine carries the 1.6.0 surface, so its floors
 *  apply. Returns -1 when the version cannot be read (floors then disabled,
 *  loudly). */
function versionKey(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
    if (!m) return -1;
    return (+m[1]) * 1e6 + (+m[2]) * 1e3 + (+m[3]);
}

let engineVersion = null;
try {
    engineVersion = JSON.parse(readFileSync(join(HERE, "../../package.json"), "utf8")).version;
} catch (_) { /* handled below */ }
const engineKey = versionKey(engineVersion);

/* ── argv ─────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
let group = null;
let seconds = null;
let bail = false;
let list = false;
let lenient = false;
const patterns = [];

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--group" || a === "-g") group = argv[++i];
    else if (a === "--seconds" || a === "-s") seconds = argv[++i];
    else if (a === "--bail" || a === "-b") bail = true;
    else if (a === "--list" || a === "-l") list = true;
    else if (a === "--lenient") lenient = true;
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a.startsWith("-")) { console.error(`unknown flag: ${a}\n`); usage(); process.exit(2); }
    else patterns.push(a);
}

function usage() {
    console.log(`lite-signal torture runner

  node bench/torture/run.mjs [flags] [name-substring ...]

  --group, -g <semantic|soak>   only that group
  --seconds, -s <n>             soak duration (default 10; semantic ignores it)
  --bail, -b                    stop at the first failing scenario
  --lenient                     a skip at/above the engine's floor stays a skip
                                (default: it FAILS — the feature should exist)
  --list, -l                    show scenarios and exit
  --help, -h                    this

  Env:
    TORTURE_TIMEOUT_MS          per-scenario wall clock cap (default 300000);
                                a scenario that exceeds it FAILS as "timeout"
                                instead of hanging the run forever

  Groups:
    semantic  deterministic, fast, asserts on MEANING      -> run in CI
    soak      wall-clock bound, asserts on RESOURCES       -> run nightly`);
}

if (list) {
    for (const s of SCENARIOS) console.log(`  ${s.group.padEnd(9)} ${s.name.padEnd(22)} ${s.about}`);
    process.exit(0);
}

let selected = SCENARIOS;
if (group !== null) {
    if (group !== "semantic" && group !== "soak") {
        console.error(`unknown group "${group}" — expected "semantic" or "soak"`);
        process.exit(2);
    }
    selected = selected.filter((s) => s.group === group);
}
if (patterns.length > 0) {
    selected = selected.filter((s) => patterns.some((p) => s.name.includes(p)));
}
if (selected.length === 0) {
    console.error("no scenarios matched");
    process.exit(2);
}

/* ── run ──────────────────────────────────────────────────────────────────── */

// --expose-gc is required, not optional: several scenarios force collection to
// settle finalizers, and without it they would silently degrade to asserting
// nothing rather than failing loudly.
const env = { ...process.env };
if (seconds !== null) env.TORTURE_SECONDS = String(seconds);

// Per-scenario wall-clock cap. A livelocked flush loop is exactly the class of
// regression the scheduler tortures exist to catch — it must map to a FAIL, not
// to a CI job hanging until an outer timeout kills the whole run opaquely.
// The cap scales with a requested soak duration (--seconds): a legitimate
// 600-second soak must not be killed by a 300-second default. The floor is
// applied ONLY when --seconds was passed -- an explicit TORTURE_TIMEOUT_MS is
// otherwise authoritative, however small (a 1 ms cap must actually fire).
const BASE_TIMEOUT_MS = Number(process.env.TORTURE_TIMEOUT_MS) > 0
    ? Number(process.env.TORTURE_TIMEOUT_MS) : 300_000;
const SOAK_MS = seconds !== null && Number(seconds) > 0 ? Number(seconds) * 1000 : 0;
const TIMEOUT_MS = SOAK_MS > 0 ? Math.max(BASE_TIMEOUT_MS, SOAK_MS * 2 + 60_000) : BASE_TIMEOUT_MS;

if (engineKey < 0) {
    console.error("  warning: could not read the engine version from package.json — floor enforcement disabled");
}

const results = [];
const t0 = performance.now();

for (const scenario of selected) {
    const child = spawnSync(
        process.execPath,
        ["--expose-gc", join(HERE, scenario.file)],
        { stdio: "inherit", env, timeout: TIMEOUT_MS, killSignal: "SIGKILL" }
    );

    // Three-state protocol: 0 = pass, SKIP_EXIT = skip, anything else = fail.
    // A timeout (spawnSync kills the child; status null, signal set) is a fail.
    let status; // "pass" | "skip" | "fail"
    let detail = "";
    if (child.error && child.error.code === "ETIMEDOUT") {
        status = "fail";
        detail = `timeout after ${TIMEOUT_MS} ms`;
    } else if (child.status === ENV_SKIP_EXIT) {
        // Environment skip: the RUNTIME lacks a prerequisite. Unconditional
        // skip — the floor gates the engine's surface, not the host's.
        status = "skip";
        detail = "environment prerequisite missing";
    } else if (child.status === SKIP_EXIT) {
        // A skip is only legitimate BELOW the scenario's floor. At or above it
        // the feature exists by contract, so the skip means a dropped export or
        // a broken feature-detect — the regression this protocol exists to stop.
        const floorKey = versionKey(scenario.floor);
        if (engineKey >= 0 && floorKey >= 0 && engineKey >= floorKey && !lenient) {
            status = "fail";
            detail = `skipped, but engine ${engineVersion} >= floor ${scenario.floor} — ` +
                `the surface should exist; a dropped export cannot be a green skip`;
        } else {
            status = "skip";
            detail = `floor ${scenario.floor}`;
        }
    } else if (child.status === 0) {
        status = "pass";
    } else {
        status = "fail";
        detail = child.status === null
            ? `killed (${child.signal || child.error && child.error.message || "unknown"})`
            : `exit ${child.status}`;
    }

    results.push({ name: scenario.name, group: scenario.group, status, detail });
    if (status === "fail" && bail) {
        console.error(`\n  bailing: ${scenario.name} — ${detail}`);
        break;
    }
}

const dt = ((performance.now() - t0) / 1000).toFixed(1);
const passed = results.filter((r) => r.status === "pass");
const skippedRuns = results.filter((r) => r.status === "skip");
const failed = results.filter((r) => r.status === "fail");

console.log(`\n${"─".repeat(64)}`);
for (const r of results) {
    const tag = r.status === "pass" ? "pass" : r.status === "skip" ? "skip" : "FAIL";
    console.log(`  ${tag}  ${r.group.padEnd(9)} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
const notRun = selected.length - results.length;
console.log(
    `  ${passed.length} passed, ${skippedRuns.length} skipped, ${failed.length} failed in ${dt}s` +
    (notRun > 0 ? ` (${notRun} not run — bailed)` : "")
);

process.exit(failed.length === 0 ? 0 : 1);
