// bench/lib/stats.mjs -- ONE summarize for the whole repo.
//
// Ported from src_2 util/benchRepeat.ts `summarizeSamples`, semantics preserved:
//   - MEDIAN is the primary score (Andrii's `time` = stats.median), NOT min.
//     This kills F5 at the root: the old local `fastestTest` returned min-of-N,
//     which is a different statistic than every Andrii row it was compared to.
//   - Textbook median: average of the two middle values for even n, single middle
//     for odd. This matches BOTH Andrii's percentileSorted(0.5) AND the existing
//     aggregateReactive.mjs median (which resultsReactive.txt derives with n=10 ->
//     (s[4]+s[5])/2), so no published number shifts for a reason other than the
//     protocol changing.
//   - Full distribution retained (min/p75/p90/p95/p99/max/stddev/mad/iqr/cv) so the
//     CSV can carry p95/p99/cv exactly as Andrii's perfLogging does.

export function percentileSorted(sorted, p) {
    if (sorted.length === 0) throw new Error("percentileSorted: empty");
    if (sorted.length === 1) return sorted[0];
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx), w = idx - lo;
    return sorted[lo] * (1 - w) + sorted[hi] * w;
}

// Median matching aggregateReactive.mjs (even-n averages the two middles). Andrii's
// percentileSorted(0.5) agrees with this for the n we run, and this is the form the
// published tables were already derived with, so switching consumers to it is inert.
export function median(samples) {
    const s = [...samples].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return (s.length & 1) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summarizeSamples(samples) {
    if (!samples || samples.length === 0) {
        throw new Error("summarizeSamples: cannot summarize an empty sample set");
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const n = samples.length;
    const mean = samples.reduce((s, v) => s + v, 0) / n;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);
    const med = median(samples);
    const deviations = samples.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    return {
        min: sorted[0],
        median: med,
        mean,
        p75: percentileSorted(sorted, 0.75),
        p90: percentileSorted(sorted, 0.90),
        p95: percentileSorted(sorted, 0.95),
        p99: percentileSorted(sorted, 0.99),
        max: sorted[n - 1],
        stddev,
        mad: percentileSorted(deviations, 0.5),
        iqr: percentileSorted(sorted, 0.75) - percentileSorted(sorted, 0.25),
        cv: mean === 0 ? 0 : stddev / mean,
        samples: sorted,
    };
}

// The primary reporting score for a set of raw samples. Median, full stop.
// Everything downstream that wants "the number for this row" calls this.
export function primaryScore(samples) {
    return summarizeSamples(samples).median;
}
