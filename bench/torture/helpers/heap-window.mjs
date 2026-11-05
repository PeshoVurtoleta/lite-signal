/**
 * bench/torture/helpers/heap-window.mjs -- the all-space heap window instrument (PLAN-F198, D-b168-1 = Q-1 (A)).
 *
 * WHY ALL SPACES. A new_space-only window is blind on node 22 / 24: allocation-site PRETENURING moves an
 * escaping object literal whose objects survive the pre-window gc() into old_space (22: the {}-per-node
 * control read 0 B in every window), and an allocation that is old-space by TYPE (a Symbol) never touches
 * new_space on any version. The window therefore sums EVERY allocating space.
 *
 * TAINT. A JIT code installation inside a window grows code_space / trusted_space and drags up to ~3 KB of
 * new / old space with it (b198: max 2888 B; 0-2 tainted windows per 200-window run observed). A window in
 * which any taint space (name matching /code|trusted/) differs anywhere across its three snapshots is
 * TAINTED: excluded from min / median / max, counted, and capped (TAINT_CAP). Its GC entries still count.
 * A run with more than TAINT_CAP tainted windows, or fewer than cycles - TAINT_CAP clean ones, FAILS
 * (windowGate).
 *
 * Per window: snapshots a, b, c of space_used_size into preallocated Float64Arrays (a -> b is the empty
 * bracket: the statistics call's own allocation; b -> c brackets body()). Delta = sum over the alloc spaces
 * of (c - b) - (b - a). NaN (fail closed) when a snapshot is unverifiable: the space count changed, a value
 * is NaN, or the layout lacks new_space / old_space.
 */

import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import v8 from "node:v8";
import { flushAll } from "./index.mjs";

/** Most tainted (JIT-install) windows a gated run may exclude. */
export const TAINT_CAP = 4;

const GC_MAJOR = perfConstants.NODE_PERFORMANCE_GC_MAJOR;
const GC_INCREMENTAL = perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL;
const GC_WEAKCB = perfConstants.NODE_PERFORMANCE_GC_WEAKCB;
const TAINT_RE = /code|trusted/;

/**
 * Classify heap space names. Returns { names, taint, alloc, ok }: taint / alloc are index arrays into
 * `names` (taint = /code|trusted/, alloc = every other space); ok = new_space AND old_space are present.
 */
export function spaceLayout(names) {
    const taint = [], alloc = [];
    let hasNew = false, hasOld = false;
    for (let i = 0; i < names.length; i++) {
        const n = String(names[i]);
        if (TAINT_RE.test(n)) taint.push(i); else alloc.push(i);
        if (n === "new_space") hasNew = true;
        if (n === "old_space") hasOld = true;
    }
    return { names: Array.from(names, String), taint, alloc, ok: hasNew && hasOld };
}

/** Write each space's space_used_size into `out`. Returns the space count (a Smi), or -1 on a length mismatch. */
export function snapSpaces(out) {
    const s = v8.getHeapSpaceStatistics();
    if (s.length !== out.length) return -1;
    for (let i = 0; i < s.length; i++) out[i] = s[i].space_used_size;
    return s.length;
}

/**
 * Run warmup + cycles windows of body(). Per iteration k: before(k), gc(); gc(), t0, snapshots a / b,
 * body(), snapshot c, t1, then after(k). Returns { min, median, max } over the CLEAN measured windows
 * (NaN when none), nan (unverifiable windows), tainted, clean, taintMax (largest delta of a tainted window,
 * NaN when none), minor / major (GC entries whose startTime falls inside ANY measured window, tainted
 * included; kind fail-closed: every kind but MAJOR / INCREMENTAL / WEAKCB is minor) and forced (majors
 * outside the measured windows: the 2 forced collections per iteration).
 */
export async function measureWindows(body, opts) {
    const warmup = opts.warmup, cycles = opts.cycles, before = opts.before, after = opts.after;
    const layout = spaceLayout(v8.getHeapSpaceStatistics().map((x) => x.space_name));
    const NS = layout.names.length, alloc = layout.alloc, taint = layout.taint;
    const A = new Float64Array(NS), B = new Float64Array(NS), Cs = new Float64Array(NS);
    const T = new Float64Array(2 * cycles);
    const D = new Float64Array(cycles);
    const K = new Uint8Array(cycles);                    // 0 clean, 1 tainted, 2 unverifiable (NaN)
    const entries = [];
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            const kind = (e.detail !== undefined && e.detail !== null) ? e.detail.kind : e.kind;
            entries.push({ start: e.startTime, kind });
        }
    });
    obs.observe({ entryTypes: ["gc"] });
    for (let k = 0; k < warmup + cycles; k++) {
        if (before) before(k);
        globalThis.gc(); globalThis.gc();
        const t0 = performance.now();
        const ra = snapSpaces(A);
        const rb = snapSpaces(B);
        body();
        const rc = snapSpaces(Cs);
        const t1 = performance.now();
        if (k >= warmup) {
            const j = k - warmup;
            T[2 * j] = t0; T[2 * j + 1] = t1;
            let bad = !layout.ok || ra < 0 || rb < 0 || rc < 0;
            for (let i = 0; i < NS && !bad; i++) if (A[i] !== A[i] || B[i] !== B[i] || Cs[i] !== Cs[i]) bad = true;
            let d = 0;
            for (let i = 0; i < alloc.length; i++) { const x = alloc[i]; d += (Cs[x] - B[x]) - (B[x] - A[x]); }
            let tainted = false;
            for (let i = 0; i < taint.length; i++) {
                const x = taint[i];
                if (A[x] !== B[x] || B[x] !== Cs[x]) tainted = true;
            }
            D[j] = bad ? Number.NaN : d;
            K[j] = bad ? 2 : (tainted ? 1 : 0);
        }
        if (after) after(k);
    }
    await flushAll(); await flushAll();
    obs.disconnect();
    let minor = 0, major = 0, forced = 0;
    for (const e of entries) {
        let inside = false;
        for (let j = 0; j < cycles; j++) {
            if (e.start >= T[2 * j] && e.start <= T[2 * j + 1]) { inside = true; break; }
        }
        if (!inside) { if (e.kind === GC_MAJOR) forced++; continue; }
        if (e.kind === GC_MAJOR) major++;
        else if (e.kind === GC_INCREMENTAL || e.kind === GC_WEAKCB) continue;
        else minor++;                                    // minor, MinorMS, unknown: fail closed
    }
    let nan = 0, tainted = 0, clean = 0, taintMax = -Infinity;
    for (let j = 0; j < cycles; j++) {
        if (K[j] === 2) nan++;
        else if (K[j] === 1) { tainted++; if (D[j] > taintMax) taintMax = D[j]; }
        else clean++;
    }
    const sorted = new Float64Array(clean);
    for (let j = 0, n = 0; j < cycles; j++) if (K[j] === 0) sorted[n++] = D[j];
    sorted.sort();
    if (tainted === 0) taintMax = Number.NaN;
    const none = clean === 0;
    return {
        min: none ? Number.NaN : sorted[0],
        median: none ? Number.NaN : sorted[clean >> 1],
        max: none ? Number.NaN : sorted[clean - 1],
        nan, tainted, clean, taintMax, minor, major, forced,
    };
}

/** The window gate shared by reset() and the controls: one function, so a control proves its teeth. */
export function windowGate(w, cycles, cap) {
    return w.nan === 0 && w.tainted <= cap && w.clean >= cycles - cap && w.max <= 0 && w.minor === 0 && w.major === 0;
}
