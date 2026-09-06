/**
 * bench/torture/helpers/index.mjs — shared torture infrastructure.
 *
 * Extracted because every soak had grown its own copy of the RNG, its own
 * registry boilerplate and its own bespoke pass/fail printing, which meant a
 * fix to any of them landed in one file and not the other five.
 *
 * Deliberately dependency-free and side-effect-free: importing this must not
 * touch the default registry, because several scenarios assert on global pool
 * accounting and an import that quietly allocated would poison the baseline.
 */

/* ── determinism ──────────────────────────────────────────────────────────── */

/**
 * Seeded PRNG. Every scenario draws from one of these so a failure is
 * reproducible from its seed alone — a torture file that cannot replay its own
 * failure is a bug report you cannot act on.
 */
export function mulberry32(seed) {
    let a = seed | 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Integer in [0, n). */
export const randInt = (rnd, n) => (rnd() * n) | 0;

/** Pick one element. */
export const pick = (rnd, arr) => arr[(rnd() * arr.length) | 0];

/** Fisher-Yates, in place, seeded. */
export function shuffle(rnd, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = (rnd() * (i + 1)) | 0;
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
}

/* ── adversarial value domain ─────────────────────────────────────────────── */

/**
 * Values chosen so that the candidate equality definitions DISAGREE:
 *
 *   Object.is vs ===   differ on NaN (is: equal) and -0/0 (is: distinct)
 *   ===       vs ==    differ on 0/""/false/"0" and null/undefined
 *
 * A fuzzer drawing only from integers cannot tell those definitions apart, and
 * equality is what decides whether a write propagates at all.
 */
export const VALUE_POOL = [0, -0, 1, -1, NaN, Infinity, -Infinity, "", "0", "1", null, undefined, false, true];

export const pickValue = (rnd) => VALUE_POOL[(rnd() * VALUE_POOL.length) | 0];

/** Total coercion to an int; NaN/undefined must not throw or produce NaN indices. */
export function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? (n | 0) : 0;
}

/* ── registries ───────────────────────────────────────────────────────────── */

/**
 * A registry sized for soak shapes.
 *
 * Torture graphs intentionally exceed the default 1,024-node ceiling, which is
 * sized for application code with bounded graphs. `grow` is correct HERE and
 * wrong in a leak test — see `fixedRegistry`.
 */
export function soakRegistry(createRegistry, opts = {}) {
    return createRegistry({
        maxNodes: opts.maxNodes || 8192,
        maxLinks: opts.maxLinks || 32768,
        prealloc: opts.prealloc,
        onCapacityExceeded: "grow",
        ...(opts.maxFlushPasses !== undefined ? { maxFlushPasses: opts.maxFlushPasses } : {}),
    });
}

/**
 * A registry with a HARD ceiling, for anything asserting on pool accounting.
 * A growable pool turns a hard leak into an invisible bleed: the numbers keep
 * climbing and nothing ever fails.
 */
export function fixedRegistry(createRegistry, maxNodes = 4096, maxLinks = 16384) {
    return createRegistry({ maxNodes, maxLinks, onCapacityExceeded: "throw" });
}

/* ── scenario harness ─────────────────────────────────────────────────────── */

/**
 * Collects failures instead of throwing on the first one, so a run reports every
 * broken invariant rather than only the earliest. Torture output is read once,
 * usually in CI, and "fix, rerun, discover the next one" is a slow loop.
 */
export function createReport(title) {
    const failures = [];
    const notes = [];
    const t0 = performance.now();

    return {
        /** Record a violation. */
        fail(scenario, detail) { failures.push({ scenario, detail }); },

        /** Assert strict equality (Object.is), recording rather than throwing. */
        eq(scenario, got, want, detail) {
            if (!Object.is(got, want)) {
                failures.push({ scenario, detail: `${detail}: expected ${fmt(want)}, got ${fmt(got)}` });
                return false;
            }
            return true;
        },

        ok(scenario, cond, detail) {
            if (!cond) { failures.push({ scenario, detail }); return false; }
            return true;
        },

        /** Contextual line printed on success — counts, throughput, coverage. */
        note(line) { notes.push(line); },

        get failureCount() { return failures.length; },

        /** Print and return an exit code. Never calls process.exit itself: the
         *  runner decides whether one failing scenario ends the whole run. */
        finish(passLine) {
            const dt = ((performance.now() - t0) / 1000).toFixed(2);
            console.log(`${title} (${dt}s)`);
            for (const n of notes) console.log(`    ${n}`);
            if (failures.length === 0) {
                console.log(`  PASS: ${passLine}`);
                return 0;
            }
            console.error(`  FAIL: ${failures.length} violation(s)`);
            const shown = failures.slice(0, 12);
            for (const f of shown) console.error(`    [${f.scenario}] ${f.detail}`);
            if (failures.length > shown.length) {
                console.error(`    ... and ${failures.length - shown.length} more`);
            }
            return 1;
        },
    };
}

function fmt(v) {
    if (Object.is(v, -0)) return "-0";
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
}

/* ── async ────────────────────────────────────────────────────────────────── */

/** Drain the microtask queue. */
export const flushMicrotasks = () => Promise.resolve().then(() => {});

/** Drain microtasks AND one macrotask turn, for schedulers built on timers. */
export const flushAll = () => new Promise((resolve) => setTimeout(resolve, 0));
