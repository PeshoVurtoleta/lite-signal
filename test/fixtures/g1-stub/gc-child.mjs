// A5 GC child: run with node --expose-gc --allow-natives-syntax (parse-time feature, only ever spawned so).
// argv[2] = absolute guards.mjs path, argv[3] = "pass" | "control", argv[4] = "exact" | "residue".
// Prints one JSON line {gcEntries, failures, status, mask}. 1e5 warm calls, force TurboFan, gc(), then 1e6 observed calls.
// The zero-allocation claim is about OPTIMIZED code: the benchmark's cold between-run call site may box
// (outside the timed window, before the next run's forceGC). Until runLoop is optimized the double `x`
// boxes a HeapNumber per call, so the row's verdict would depend on host load; hence the forced tier-up.
// mask = status bits that a calibration function gains when TurboFan-optimized (layout differs per V8):
// the parent asserts (status & mask) === mask and mask !== 0 BEFORE trusting gcEntries.
import { PerformanceObserver } from "node:perf_hooks";
const { checkSinkExact, checkSinkResidue, makeVerdict } = await import(process.argv[2]);
const kind = process.argv[4] || "exact";
const mode = process.argv[3];
const v = makeVerdict();
const vals = new Float64Array(64);
for (let i = 0; i < 64; i++) vals[i] = 10009499500 + i * 3;   // non-Smi doubles, like real sinks
function runLoop(n) {
    for (let i = 0; i < n; i++) {
        const x = vals[i & 63];
        if (kind === "residue") checkSinkResidue(v, "solid / broadcast (residue check)", 263 + ((i & 15) << 5), 256, 7, 1000);
        else checkSinkExact(v, "lite-signal / kairos", x, x);
        if (mode === "control") globalThis.__keep = "ctl-" + i + "-" + x;   // fresh string per call
    }
}
function cal(a) { return a + 1; }
%PrepareFunctionForOptimization(cal); cal(1); cal(2);
const calBefore = %GetOptimizationStatus(cal);
%OptimizeFunctionOnNextCall(cal); cal(3);
const mask = %GetOptimizationStatus(cal) & ~calBefore;
%PrepareFunctionForOptimization(runLoop);
runLoop(100000);
%OptimizeFunctionOnNextCall(runLoop); runLoop(1);
const status = %GetOptimizationStatus(runLoop);
globalThis.gc(); globalThis.gc();
let gcEntries = 0;
const obs = new PerformanceObserver((l) => { gcEntries += l.getEntries().length; });
obs.observe({ entryTypes: ["gc"] });
runLoop(1000000);
// GC entries are queued from a native callback: yield the loop before reading them.
await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => setImmediate(r));
gcEntries += obs.takeRecords().length;
obs.disconnect();
console.log(JSON.stringify({ gcEntries, failures: v.failures.length, status, mask }));
