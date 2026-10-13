/**
 * @zakkster/lite-signal soak -- the lane-cycle BOUNDARY (SPEC-B v2 sections 1, 7; S1c TASK 4; port of
 * lite-pick benchmark/soak/boundary.mjs).
 *
 * ORDER MATTERS:
 *   1. yield one macrotask, so pending GC entries land in the profiler window
 *   2. workload GC stats from the profiler (REPORT-ONLY), read BEFORE any forced GC, so the harness's own
 *      forced GCs never pollute the workload major / pause numbers
 *   3. dropRefs(): the caller drops every reference to the cycle's worlds
 *   4. time-bounded forced-GC drain: gc(), then a yield, until tracker.size() === 0 AND every WeakRef
 *      witness is dead, or DRAIN_MS is spent. The first DRAIN_TRIES tries yield one macrotask; later tries
 *      sleep 10 ms so FinalizationRegistry callbacks can land (the 2026-10-05 finalizer-timing flake).
 *      tracker.size() is the AUTHORITY (TASK 0g: it decrements on finalization without untrack()); the
 *      WeakRef count is the second witness. A real leak never drains, it just spends the budget.
 *      Every gc() runs after the drain's last deref() of a witness: deref() pins a live target (KeepDuringJob)
 *      until the microtask checkpoint ends, so a macrotask tick separates countAlive() from the next gc() (the
 *      2026-10-13 flake: test/40 GRAPH cycle 0 read 1/1 after 139 tries, pinned by the harness itself).
 *   5. memory sample STRICTLY AFTER the last forced GC: residentMB = helpers.residentBytes() (heapUsed +
 *      arrayBuffers), the number the heap gate reads; heapUsedMB, arrayBuffersMB and rssMB are report-only
 *   6. one more yield (the forced GCs' entries land), then profiler.reset(): the next window is workload only
 *
 * COLD module: it runs once per lane-cycle.
 */

import { DRAIN_MS, DRAIN_TRIES } from './config.mjs';
import { residentBytes } from '../torture/helpers/index.mjs';

const MB = 1048576;
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Live WeakRef witnesses. deref() keeps a target alive until the current microtask checkpoint ends. */
export function countAlive(witness) {
    let n = 0;
    for (let i = 0; i < witness.length; i++) if (witness[i].deref() !== undefined) n++;
    return n;
}

/**
 * Close one lane-cycle.
 *   opts.tracker   a @zakkster/lite-leak tracker (size()); required
 *   opts.witness   an array of WeakRef (one per world registry); required, may be empty
 *   opts.dropRefs  zero-arg function that drops the caller's references; optional
 *   opts.profiler  a running GcProfiler (summary(), reset()) or null; its numbers are report-only
 *   opts.forceGc   the full-GC function; default globalThis.gc (missing -> throws: --expose-gc)
 *   opts.drainMs / opts.drainTries   default DRAIN_MS / DRAIN_TRIES (tests shorten them)
 *   opts.now       clock; default performance.now
 * Returns { boundary: {trackerSize, weakAlive, forcedGcTries, drainMs, heapSampledAfterGc},
 *           memory: {heapUsedMB, arrayBuffersMB, residentMB, rssMB}, gc: {major, minor, maxPauseMs} | null }.
 */
export async function closeBoundary(opts) {
    if (!opts || typeof opts !== 'object') throw new TypeError('closeBoundary: opts must be an object');
    const tracker = opts.tracker;
    if (!tracker || typeof tracker.size !== 'function') throw new TypeError('closeBoundary: opts.tracker must have size()');
    const witness = opts.witness;
    if (!Array.isArray(witness)) throw new TypeError('closeBoundary: opts.witness must be an array of WeakRef');
    for (const w of witness) if (!(w instanceof WeakRef)) throw new TypeError('closeBoundary: opts.witness holds a non-WeakRef');
    const dropRefs = opts.dropRefs;
    if (dropRefs !== undefined && dropRefs !== null && typeof dropRefs !== 'function') throw new TypeError('closeBoundary: opts.dropRefs must be a function');
    const profiler = opts.profiler === undefined ? null : opts.profiler;
    if (profiler !== null && (typeof profiler.summary !== 'function' || typeof profiler.reset !== 'function')) {
        throw new TypeError('closeBoundary: opts.profiler must be a GcProfiler (summary, reset) or null');
    }
    const forceGc = opts.forceGc === undefined ? globalThis.gc : opts.forceGc;
    if (typeof forceGc !== 'function') throw new Error('closeBoundary: gc() is not exposed (run node with --expose-gc)');
    const drainMs = opts.drainMs === undefined ? DRAIN_MS : opts.drainMs;
    const drainTries = opts.drainTries === undefined ? DRAIN_TRIES : opts.drainTries;
    if (!(Number.isFinite(drainMs) && drainMs >= 0)) throw new RangeError('closeBoundary: drainMs must be a finite number >= 0');
    if (!(Number.isInteger(drainTries) && drainTries >= 0)) throw new RangeError('closeBoundary: drainTries must be an integer >= 0');
    const now = opts.now === undefined ? () => performance.now() : opts.now;

    // 1-2) workload GC numbers, before any forced GC (report-only)
    await tick();
    let gc = null;
    if (profiler !== null) {
        const s = profiler.summary();
        gc = { major: s.gc.major, minor: s.gc.minor, maxPauseMs: r3(s.gc.maxMs) };
    }

    // 3) drop the cycle's references
    if (typeof dropRefs === 'function') dropRefs();

    // 4) time-bounded drain; always at least one forced GC. The trailing tick (a macrotask; a microtask yield
    //    is not enough) ends the microtask checkpoint, releasing countAlive()'s deref() pins before the next gc().
    let tries = 0;
    let size, alive;
    const t0 = now();
    for (;;) {
        forceGc();
        tries++;
        await (tries <= drainTries ? tick() : sleep(10));
        size = tracker.size();
        alive = countAlive(witness);
        if ((size === 0 && alive === 0) || !(now() - t0 < drainMs)) break;
        await tick();
    }
    const spent = Math.round((now() - t0) * 10) / 10;

    // 5) memory, strictly after the last forced GC
    if (tries < 1) throw new Error('closeBoundary: memory sampled before any forced GC');
    const resident = residentBytes();
    const mu = process.memoryUsage();
    const memory = { heapUsedMB: r3(mu.heapUsed / MB), arrayBuffersMB: r3(mu.arrayBuffers / MB), residentMB: r3(resident / MB), rssMB: r3(mu.rss / MB) };

    // 6) let the forced GCs' entries land, then start a clean workload window
    if (profiler !== null) {
        await tick();
        profiler.reset();
    }
    return {
        boundary: { trackerSize: size, weakAlive: alive, forcedGcTries: tries, drainMs: spent, heapSampledAfterGc: true },
        memory, gc,
    };
}
