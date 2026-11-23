// b127 heap-delta helpers (b246 CI class 21). No import side effects: a child calls guard() itself, and test/127 imports this module
// in-process for the jsSum / codeSum unit row. Law (LEDGER class 18 + b245 amendment): a heap-delta GC row's child runs --single-threaded
// and refuses to measure otherwise (exit 3), and sums only the JS heap spaces (new, old, new-large, large-object); code / trusted space and
// heapUsed deltas are REPORTED only (heapUsed also counts compile output that a concurrent compiler can land inside the bracket: CI class 21).
import { getHeapSpaceStatistics } from "node:v8";

export const JS_SPACES = ["new_space", "old_space", "new_large_object_space", "large_object_space"];
export const CODE_SPACES = ["code_space", "trusted_space", "code_large_object_space", "trusted_large_object_space"];

export function guard(tag) {
    if (!process.execArgv.includes("--single-threaded")) {
        process.stderr.write(tag + ": heap-delta rows need --single-threaded\n");
        process.exit(3);
    }
}

// Fails closed: a JS space missing from the statistics throws (a partial sum would read low and pass a "retains less" bound).
export function jsSum(stats) {
    let u = 0;
    for (const n of JS_SPACES) {
        const s = stats.find((x) => x.space_name === n);
        if (s === undefined) throw new Error("js-heap: no heap space " + n);
        u += s.space_used_size;
    }
    return u;
}

// REPORTED only: the code / trusted spaces present on this V8 (absent ones count 0).
export function codeSum(stats) {
    let k = 0;
    for (const s of stats) if (CODE_SPACES.includes(s.space_name)) k += s.space_used_size;
    return k;
}

export function snap() {
    const hu = process.memoryUsage().heapUsed;
    const st = getHeapSpaceStatistics();
    const g = (n) => st.find((x) => x.space_name === n).space_used_size;
    return { js: jsSum(st), code: codeSum(st), hu, new: g("new_space"), old: g("old_space"), nlo: g("new_large_object_space"), lo: g("large_object_space") };
}

// REPORTED deltas b - a for every non-gated field.
export function rep(a, b) {
    return { code: b.code - a.code, hu: b.hu - a.hu, new: b.new - a.new, old: b.old - a.old, nlo: b.nlo - a.nlo, lo: b.lo - a.lo };
}
