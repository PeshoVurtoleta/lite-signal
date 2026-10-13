/**
 * @zakkster/lite-signal soak -- the RSS sampler (SPEC-S2 group B TASK 1; LP section 7 "rss: p95 late quarter <=
 * band median x 1.75 + 16 MB (bounded decimating buffer)").
 *
 * PURE MODULE: no I/O, no process state, no clock. main.mjs (B-B3) pushes process.memoryUsage.rss() / 2^20 at
 * every world end; gates.mjs rssRule (B-B3) reads the per-cycle p95 values through p95() / bandMedian().
 *
 * Exports
 *   RSS_BUF = 256                the default sampler capacity (B-B3 moves the definition into config.mjs
 *                                CONSTANTS for the header gates block; this module then re-exports it)
 *   class RssSampler
 *     constructor(cap = RSS_BUF) cap: a power of two in [4, RSS_CAP_MAX]; anything else throws RangeError.
 *                                Allocates two Float64Array(cap) and one Float64Array(1) -- the ONLY allocations.
 *     push(mb) -> boolean        one sample (MB). Push i (0-based, counting every valid push) is STORED iff
 *                                i % stride === 0; true when stored. The stored push that FILLS the buffer
 *                                (count reaches cap) then compacts IN PLACE (keeps the even buffer indices, i.e.
 *                                the samples whose push index is a multiple of 2 x stride: count = cap / 2) and
 *                                doubles stride, before push returns. A non-number, NaN,
 *                                +-Infinity or negative mb throws TypeError / RangeError BEFORE any state write
 *                                (a byte-identical no-op); so does a push past PUSH_MAX (2^30 - 1) pushes.
 *     samples() -> number[]      a fresh Array copy of the stored samples, oldest first (allocates; readout only)
 *     stride                     getter: the current decimation stride (1, 2, 4, ...)
 *     count                      getter: stored samples (<= cap)
 *     pushes                     getter: valid push() calls since construction / reset()
 *     cap                        getter: the capacity
 *     p95() -> number            nearest-rank p95 of the STORED samples; NaN when none (fail closed). Sorts a
 *                                preallocated scratch copy; the RETURNED double is boxed (a HeapNumber) when the
 *                                method is not inlined -- once per call, cold readout only
 *     max() -> number            the max over EVERY valid push (stored or decimated); NaN when none (returns a
 *                                boxed double the same way)
 *     reset()                    back to the constructed state (stride 1, no samples), no allocation
 *   p95(arr) -> number           nearest-rank p95 of an Array / TypedArray of MB values (allocates one copy)
 *   bandMedian(arr) -> number    median (even length: mean of the two middle values) of the same input
 *   RSS_CAP_MAX = 65536, PUSH_MAX = 0x3FFFFFFF
 *
 * Invariant (the naive reference test/49 checks against): after pushes x_0 .. x_{n-1},
 *   samples() == [x_i for i in 0..n-1 if i % stride === 0], stride the smallest power of two keeping that
 *   list BELOW cap entries (count <= cap - 1 between calls: the cap-th slot is filled only transiently).
 *
 * Nearest rank: p95 of n sorted values is v[ceil(0.95 n) - 1], computed in integers as
 * floor((95 n + 99) / 100) (0.95 * n in floating point is not exact).
 *
 * Fail closed (null is not zero): the module functions return NaN for an empty input and for an input holding
 * ANY element that is not a finite number >= 0 (null, undefined, NaN, Infinity, a string, a negative); a wrong
 * container (not an Array or TypedArray) throws TypeError. The sampler refuses such values at push().
 *
 * Counters stay Smi: pushes is capped at PUSH_MAX (SPEC-B addendum 7); stride doubles only when a push fills
 * the buffer, at pushes = (cap - 1) x oldStride + 1 > 2 x oldStride for cap >= 4, so stride < pushes once it
 * leaves 1 (cap 2 would allow stride = 2 x pushes, past 2^30: refused); count < cap.
 * The max lives in a Float64Array slot, never a double field (zero-box law). The double argument of push()
 * is the caller's value. push() / reset() allocate nothing after construction; samples() allocates its Array;
 * p95() / max() allocate only the boxed return value (above).
 *
 * COLD module (one push per world end, one readout per lane-cycle).
 */

export const RSS_BUF = 256;
export const RSS_CAP_MAX = 65536;
export const PUSH_MAX = 0x3FFFFFFF;

const isPow2 = (n) => Number.isInteger(n) && n >= 4 && n <= RSS_CAP_MAX && (n & (n - 1)) === 0;

/** Nearest-rank index (0-based) of p95 among n sorted values, n >= 1. */
function rankIndex(n) {
    return Math.floor((95 * n + 99) / 100) - 1;
}

export class RssSampler {
    constructor(cap = RSS_BUF) {
        if (!isPow2(cap)) throw new RangeError('RssSampler: cap must be a power of two in [4, ' + RSS_CAP_MAX + '], got ' + String(cap));
        this._cap = cap;
        this._buf = new Float64Array(cap);
        this._scratch = new Float64Array(cap);
        this._stat = new Float64Array(1);   // [0] running max over every valid push
        this._count = 0;
        this._pushes = 0;
        this._stride = 1;
        this._stat[0] = -Infinity;
    }

    get cap() { return this._cap; }
    get count() { return this._count; }
    get pushes() { return this._pushes; }
    get stride() { return this._stride; }

    push(mb) {
        if (typeof mb !== 'number') throw new TypeError('RssSampler.push: mb must be a number, got ' + typeof mb);
        if (!(mb >= 0 && mb < Infinity)) throw new RangeError('RssSampler.push: mb must be a finite number >= 0, got ' + String(mb));
        if (!(this._pushes < PUSH_MAX)) throw new RangeError('RssSampler.push: more than ' + PUSH_MAX + ' pushes (reset() per lane-cycle)');
        const i = this._pushes;
        this._pushes = i + 1;
        if (mb > this._stat[0]) this._stat[0] = mb;
        if (i % this._stride !== 0) return false;
        this._buf[this._count] = mb;
        this._count = this._count + 1;
        if (this._count === this._cap) {
            // full: keep the even buffer indices (push indices 0, 2s, 4s, ...), then the next stored push is
            // i + s = cap x s, a multiple of the new stride 2s, so the invariant holds
            const buf = this._buf, half = this._cap >> 1;
            for (let k = 0; k < half; k++) buf[k] = buf[k << 1];
            this._count = half;
            this._stride = this._stride * 2;
        }
        return true;
    }

    samples() {
        const out = new Array(this._count);
        for (let k = 0; k < this._count; k++) out[k] = this._buf[k];
        return out;
    }

    p95() {
        const n = this._count;
        if (n === 0) return NaN;
        const s = this._scratch, b = this._buf;
        for (let k = 0; k < n; k++) s[k] = b[k];
        for (let k = n; k < this._cap; k++) s[k] = Infinity;   // pads sort last; the rank stays inside [0, n)
        s.sort();
        return s[rankIndex(n)];
    }

    max() {
        return this._pushes === 0 ? NaN : this._stat[0];
    }

    reset() {
        this._count = 0;
        this._pushes = 0;
        this._stride = 1;
        this._stat[0] = -Infinity;
    }
}

/** A sorted Float64Array copy of arr, or null when arr is empty or holds a value that is not a finite number >= 0. */
function sortedCopy(arr, who) {
    if (!(Array.isArray(arr) || (ArrayBuffer.isView(arr) && !(arr instanceof DataView)))) {
        throw new TypeError(who + ': expected an Array or a TypedArray');
    }
    const n = arr.length;
    if (n === 0) return null;
    const s = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const v = arr[k];
        if (!(typeof v === 'number' && v >= 0 && v < Infinity)) return null;
        s[k] = v;
    }
    s.sort();
    return s;
}

/** Nearest-rank p95; NaN for an empty input or any value that is not a finite number >= 0. */
export function p95(arr) {
    const s = sortedCopy(arr, 'p95');
    return s === null ? NaN : s[rankIndex(s.length)];
}

/** Median (even length: mean of the two middle values); NaN for an empty input or any value that is not a finite number >= 0. */
export function bandMedian(arr) {
    const s = sortedCopy(arr, 'bandMedian');
    if (s === null) return NaN;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
