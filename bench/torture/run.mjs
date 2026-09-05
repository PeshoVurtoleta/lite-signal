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

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `semantic` scenarios are deterministic, fast and assert on MEANING — values,
 * wakeups, work, ordering. They belong in CI on every commit.
 *
 * `soak` scenarios are wall-clock bound and assert on RESOURCES — nothing threw,
 * the pool came back. They belong in a nightly or pre-publish job; running them
 * per-commit buys little and costs minutes.
 */
const SCENARIOS = [
    { name: "oracle-fuzzer", group: "semantic", file: "oracle-fuzzer.mjs", about: "values vs an independent reference evaluator" },
    { name: "glitch-hunter", group: "semantic", file: "glitch-hunter.mjs", about: "glitch freedom + exact wakeup accounting" },
    { name: "work-accounting", group: "semantic", file: "work-accounting.mjs", about: "minimum body-execution counts" },
    { name: "concurrent-storm", group: "semantic", file: "concurrent-storm.mjs", about: "reentrancy, nesting, flush ordering" },
    { name: "scheduler-storm", group: "semantic", file: "scheduler-storm.mjs", about: "deferred execution, ABA thunks, coalescing" },
    { name: "box-torture", group: "semantic", file: "box-torture.mjs", about: "signalBox/computedBox interop + surface (1.5.0+)" },
    { name: "scope-torture", group: "semantic", file: "scope-torture.mjs", about: "createScope adoption + disposal-crash fuzz (1.6.0+)" },
    { name: "owner-torture", group: "semantic", file: "owner-torture.mjs", about: "getOwner/runWithOwner capture-restore + ABA degradation (1.6.0+)" },
    { name: "async-torture", group: "semantic", file: "async-torture.mjs", about: "watch/when/whenAsync contracts + fuzz" },
    { name: "capacity-torture", group: "semantic", file: "capacity-torture.mjs", about: "fail-closed pool boundary + CapacityError + the 16x grow ceiling" },
    { name: "error-torture", group: "semantic", file: "error-torture.mjs", about: "throwing effect bodies: per-effect buffering, AggregateError, buffer drain" },
    { name: "deep-chain-torture", group: "semantic", file: "deep-chain-torture.mjs", about: "pullComputed recursion fail-closed (RangeError) vs iterative push path" },
    { name: "flush-torture", group: "semantic", file: "flush-torture.mjs", about: "flushStrategy eager/sab/manual + subscribe (1.7.0+)" },
    { name: "cleanup-return-torture", group: "semantic", file: "cleanup-return-torture.mjs", about: "effect cleanup return + compose order (1.8.0+)" },
    { name: "dispose-torture", group: "semantic", file: "dispose-torture.mjs", about: "Symbol.dispose / using on lifecycle objects (1.9.0+)" },
    { name: "zerogc-torture", group: "semantic", file: "zerogc-torture.mjs", about: "zero-GC hot path via measureAllocs/measureOps + stats counters; ZEROGC_BREAK self-test" },
    { name: "op-accounting", group: "semantic", file: "op-accounting.mjs", about: "structural work via onGraphMutation opcode lane" },
    { name: "introspect-torture", group: "semantic", file: "introspect-torture.mjs", about: "describe/forEach*/hasObservers/ownerOf + ABA gen-stamp guard" },
    { name: "lifecycle-torture", group: "semantic", file: "lifecycle-torture.mjs", about: "createRoot detachment + destroy registry reset" },
    { name: "graph-fuzzer", group: "soak", file: "graph-fuzzer.mjs", about: "1.5k-node random DAG churn" },
    { name: "scheduler-bench", group: "soak", file: "scheduler-bench.mjs", about: "microtask scheduler saturation" },
    { name: "torture-soak", group: "soak", file: "torture-soak.mjs", about: "7.5k-node continuous rewiring" },
];

/* ── argv ─────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
let group = null;
let seconds = null;
let bail = false;
let list = false;
const patterns = [];

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--group" || a === "-g") group = argv[++i];
    else if (a === "--seconds" || a === "-s") seconds = argv[++i];
    else if (a === "--bail" || a === "-b") bail = true;
    else if (a === "--list" || a === "-l") list = true;
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
  --list, -l                    show scenarios and exit
  --help, -h                    this

  Groups:
    semantic  deterministic, fast, asserts on MEANING      -> run in CI
    soak      wall-clock bound, asserts on RESOURCES       -> run nightly`);
}

if (list) {
    for (const s of SCENARIOS) console.log(`  ${s.group.padEnd(9)} ${s.name.padEnd(18)} ${s.about}`);
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

const results = [];
const t0 = performance.now();

for (const scenario of selected) {
    const child = spawnSync(
        process.execPath,
        ["--expose-gc", join(HERE, scenario.file)],
        { stdio: "inherit", env }
    );
    const code = child.status === null ? 1 : child.status;
    results.push({ name: scenario.name, group: scenario.group, code });
    if (code !== 0 && bail) {
        console.error(`\n  bailing: ${scenario.name} exited ${code}`);
        break;
    }
}

const dt = ((performance.now() - t0) / 1000).toFixed(1);
const failed = results.filter((r) => r.code !== 0);

console.log(`\n${"─".repeat(64)}`);
for (const r of results) {
    console.log(`  ${r.code === 0 ? "pass" : "FAIL"}  ${r.group.padEnd(9)} ${r.name}`);
}
const skipped = selected.length - results.length;
console.log(
    `  ${results.length - failed.length}/${results.length} passed in ${dt}s` +
    (skipped > 0 ? ` (${skipped} not run — bailed)` : "")
);

process.exit(failed.length === 0 ? 0 : 1);
