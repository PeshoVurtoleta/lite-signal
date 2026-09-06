#!/usr/bin/env node
// @zakkster/lite-signal harness dispatcher -- one entry point for the
// run-on-demand probes that live loose in harness/. Zero-dep, ASCII-only.
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT License
//
// Each probe keeps its own file and its own node flags; this only routes a
// subcommand to the right spawn (mirrors fieldkit's own --child dispatch).
// Paths resolve from THIS file, so the cwd never matters.
//
// USAGE
//   node harness/run.mjs <command> [args...]
//   node harness/run.mjs all
//
// COMMANDS
//   field   [engineA] [engineB]   verify + cold-child A/B bench (fieldkit)
//   dispose                       signal() vs signalBox() vs alien creation cost
//   churn   [engine]              topology-churn-per-recompute (1.11 cone-cache gate)
//   owner   [engine]             async-gap owner-recycling hazard verdict
//   creation                      per-framework-per-process createComputations matrix
//   all                           field + dispose + churn, in sequence
//
// NOTES
//   * Default engine is this repo's ../Signal.js when no path is given.
//   * `dispose` and `creation` compare against alien-signals. It is NOT a
//     declared dependency; without it, `dispose` runs the two lite columns
//     only (FW=lite-callable,lite-box, set here) and `creation` needs it plus
//     LITE_V120_PATH to light the alien/v120 columns. `npm i -D alien-signals`
//     unlocks them.

import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(HERE, "..", "Signal.js");        // ../Signal.js
const NODE = process.execPath;

const COMMANDS = {
    field: {
        script: "fieldkit.mjs",
        flags: ["--expose-gc"],
        engineArg: true,          // default ENGINE appended if user gives none
    },
    dispose: {
        script: "dispose-recycle-box.mjs",
        flags: ["--expose-gc"],
        env: {FW: "lite-callable,lite-box"},
    },
    churn: {
        script: "churnprobe.mjs",
        flags: ["--expose-gc"],
        engineArg: true,
    },
    owner: {
        script: "owner-hazard-repro.mjs",
        flags: [],
        engineArg: true,
    },
    creation: {
        script: "creation-isolated.mjs",
        flags: ["--expose-gc"],
    },
    smoke: {
        script: "smoke.mjs",
        flags: [],                // 1.7: flushStrategy eager/sab/manual semantics; throws on regression
    },
    perf: {
        script: "perf-probe.mjs",
        flags: ["--expose-gc"],   // sBench update-group shape: eager vs sab, per scenario
    },
    burst: {
        script: "burst-dag.mjs",
        flags: ["--expose-gc"],
        engineArg: true,
    },
    pull: {
        script: "pull-stress.mjs",
        flags: ["--expose-gc"],
    },
    toe: {
        script: "toe-to-toe/toe-to-toe.mjs",
        flags: [],                // cross-version sweep; needs the PRIVATE engines/ dir (gitignored)
    },
};

// `smoke` first: it is the only command that ASSERTS (throws on a flushStrategy
// regression), so a broken engine fails fast before the long timed probes run.
const ORDER_ALL = ["smoke", "field", "dispose", "churn"];

function usage() {
    process.stdout.write(
        "harness dispatcher -- run-on-demand probes\n\n" +
        "  node harness/run.mjs <command> [args...]\n\n" +
        "  smoke                         1.7 flushStrategy semantics (eager/sab/manual); ASSERTS\n" +
        "  field   [engineA] [engineB]   verify + cold-child A/B bench\n" +
        "  dispose                       creation cost: signal vs signalBox vs alien\n" +
        "  churn   [engine]              topology-churn-per-recompute\n" +
        "  owner   [engine]              async-gap owner-recycling hazard verdict\n" +
        "  creation                      per-framework createComputations matrix\n" +
        "  perf                          sBench update-group shape: eager vs sab\n" +
        "  burst   [engine]              burst-shape characterization (strided vs contiguous)\n" +
        "  pull    [--maxDepth=..]       pull-mode depth + exact overflow point\n" +
        "  toe                           cross-version sweep (needs PRIVATE toe-to-toe/engines/)\n" +
        "  all                           smoke + field + dispose + churn\n"
    );
}

function runOne(name, extraArgs) {
    const spec = COMMANDS[name];
    const args = [...spec.flags, resolve(HERE, spec.script), ...extraArgs];
    if (spec.engineArg && extraArgs.length === 0) args.push(ENGINE);
    process.stdout.write(`\n== harness:${name} ==\n`);
    const r = spawnSync(NODE, args, {
        stdio: "inherit",
        env: spec.env ? {...process.env, ...spec.env} : process.env,
    });
    return r.status === null ? 1 : r.status;
}

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    process.exit(cmd ? 0 : 1);
}

if (cmd === "all") {
    for (const name of ORDER_ALL) {
        const code = runOne(name, []);
        if (code !== 0) {
            process.stderr.write(`\nharness:${name} exited ${code} -- stopping\n`);
            process.exit(code);
        }
    }
    process.exit(0);
}

if (!COMMANDS[cmd]) {
    process.stderr.write(`unknown command: ${cmd}\n\n`);
    usage();
    process.exit(1);
}

process.exit(runOne(cmd, rest));
