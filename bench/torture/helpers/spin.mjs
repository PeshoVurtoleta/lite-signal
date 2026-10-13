/**
 * bench/torture/helpers/spin.mjs -- spinVersion, the real-write version driver.
 *
 * Moved out of bench/torture/wraparound-torture.mjs (its local `spin`, body verbatim) so the soak WRAP job
 * (bench/soak/wrap.mjs) and the wraparound torture drive globalVersion with the same bytes. It lives in its
 * own module, not in helpers/index.mjs: that file is in calibrate.mjs PINNED (SPEC-B addendum 12), so an
 * edit there forces a soak recut. The wraparound golden (SPEC-S2 group A TASK 0a) proves the move is
 * output-identical: PENDING gate burst.
 *
 * HOT BODY. The inner loop counter `i` is a Smi (< 1 << 28) and the loop allocates nothing. `done` and `n`
 * stay Smi only while n <= 1 << 28: a measured caller (wrap.mjs W5) passes a Smi chunk and keeps its drive
 * total in a Float64Array slot. wraparound-torture.mjs passes n up to 2^31 + 64 in an unmeasured window.
 */

/** Advance the registry's globalVersion by `n` REAL writes on a dedicated observer-free signal
 *  (markDownstream on an empty sub list). Chunked so the loop variable stays int32-friendly. */
export function spinVersion(sig, n) {
    let done = 0;
    while (done < n) {
        const chunk = Math.min(n - done, 1 << 28);
        for (let i = 0; i < chunk; i++) sig.set(i);
        done += chunk;
    }
}
