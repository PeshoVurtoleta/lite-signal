// Isolated OOM worker for the createRegistry validation suite.
//
// Run as: node --max-old-space-size=256 test/NN-config-oom.child.mjs <case>
//
// Before the 1.4.5-backport fix, each of these configs ran an unbounded
// eager-construction loop and killed the process with an uncatchable SIGABRT
// ("Ineffective mark-compacts near heap limit") -- NOT a throw. This worker
// asserts the fixed engine throws a NAMED TypeError and exits cleanly under a
// 256 MB heap cap; a regression reappears as a non-zero exit / signal death the
// parent test detects.
import { createRegistry } from "../Signal.js";

const CASES = {
    "maxNodes:Infinity": { maxNodes: Infinity },
    "maxNodes:1e9": { maxNodes: 1e9 },
    "maxLinks:Infinity": { maxLinks: Infinity },
};

const key = process.argv[2];

// Spawn-only worker. On 1.8.0/1.9.0 the bare `node --test` discovery treats every
// .mjs under test/ as a test file and runs it with NO arguments; with no case to
// run, no-op cleanly (natural exit 0) and let the parent suite drive it via
// spawnSync with an explicit case. A provided-but-unknown case is still a hard error.
if (key !== undefined) {
    const cfg = CASES[key];
    if (cfg === undefined) {
        console.error("unknown case: " + key);
        process.exit(2);
    }
    try {
        createRegistry(cfg);
        console.error("FAIL: createRegistry(" + key + ") did not throw");
        process.exit(1);
    } catch (e) {
        if (e instanceof TypeError && /^createRegistry: "(maxNodes|maxLinks)"/.test(e.message)) {
            console.log("OK " + key + " :: " + e.message);
            process.exit(0);
        }
        console.error("FAIL: wrong error for " + key + " :: " + e.name + " " + e.message);
        process.exit(1);
    }
}
