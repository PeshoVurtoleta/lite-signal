// Shared negative control for test/32-perf-gate.test.mjs, and the child entry of
// its tier-independence witness. NOT a test file: the npm test glob is
// 'test/*.test.mjs', which neither matches this name nor descends into fixtures/.
//
// WHY. @zakkster/lite-perf-gate 1.4.2's stock controlNegative runs
// `a += (i * 3) ^ i` on an UNBOUNDED accumulator: `a` leaves the Smi range, so in
// the interpreter / Sparkplug tiers every iteration allocates a HeapNumber; only
// Maglev / TurboFan keep it unboxed. When tier-up lags (a contended CI runner)
// the 8N window runs unoptimized and the "zero-allocation" control scavenges.
// b125 CI evidence: gates job, run 40599429786 (c864ddf), "negative control
// forced 12 scavenges (need <=2)", stock CONTROL- lo 0 hi 12; same failure on
// f941aa6 and 3ef853a. Local probe, N=200000 k=8, --max-semi-space-size=4:
// default tiers stock lo 0 hi 0; --no-opt --no-maglev stock lo 1 hi 12. The
// body below is an XOR accumulator that never leaves int32 (at the gate's
// 8N = 1.6M every operand, and so `a`, stays below 2^23). b125 r2 re-measure,
// same order as the probe: lo 0 hi 0 at default tiers, --no-opt,
// --no-opt --no-maglev and --no-opt --no-maglev --no-sparkplug. The r1 body
// `a = (a + x) | 0` overflowed int32 before the `| 0` (801 times over 8N) and
// boxed below Maglev: heapUsed +12,848 B over the XOR body at 8N.
//
// The ONE definition: test/32 imports NEGATIVE_INT32 for zgcSuite, and the
// witness child below measures this same object, so the two cannot drift.
//
// Child mode (only when this file is the process entry):
//   node --expose-gc --max-semi-space-size=4 --no-opt --no-maglev \
//        --max-old-space-size=256 test/fixtures/perf-gate-negctrl.mjs
// prints ONE JSON line {flags, stock:{minorLo,minorHi,majorHi},
// int32:{minorLo,minorHi,majorHi}} and exits 0; any missing precondition exits 2.

import {realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {measure, controlNegative} from "@zakkster/lite-perf-gate";

export const NEGATIVE_INT32 = {
    name: "CONTROL- int32 pure arithmetic (tier-independent)",
    setup() {
        return {acc: 0};
    },
    hot(s, n) {
        let a = s.acc | 0;
        for (let i = 0; i < n; i++) a ^= (i * 3) ^ i;
        s.acc = a;
    },
};

export const WITNESS_FLAGS = ["--expose-gc", "--max-semi-space-size=4", "--no-opt", "--no-maglev"];

function isEntry() {
    const argv1 = process.argv[1];
    if (typeof argv1 !== "string" || argv1.length === 0) return false;
    try {
        return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

function pick(r) {
    return {minorLo: r.minorLo, minorHi: r.minorHi, majorHi: r.majorHi};
}

if (isEntry()) {
    // Fail closed: the witness means nothing unless the tiers it claims are off.
    if (typeof globalThis.gc !== "function") {
        process.stderr.write("perf-gate-negctrl: --expose-gc missing\n");
        process.exit(2);
    }
    for (const f of WITNESS_FLAGS) {
        if (!process.execArgv.includes(f)) {
            process.stderr.write("perf-gate-negctrl: flag missing: " + f + "\n");
            process.exit(2);
        }
    }
    const opts = {N: 200000, k: 8};
    const stock = await measure(controlNegative, opts);
    const int32 = await measure(NEGATIVE_INT32, opts);
    process.stdout.write(JSON.stringify({
        flags: process.execArgv.slice(),
        stock: pick(stock),
        int32: pick(int32),
    }) + "\n");
}
