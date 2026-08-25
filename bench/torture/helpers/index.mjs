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
 *   Object.is vs ===       differ on NaN (is: equal) and -0/0 (is: distinct)
 *   ===       vs ==        differ on 0/""/false/"0" and null/undefined
 *   identity  vs structure REF_A/REF_B are distinct frozen objects with an
 *                          IDENTICAL data shape ({ ref: "X" }) -- an engine
 *                          that compared by structure (JSON, shallow-equal)
 *                          would coalesce a REF_A -> REF_B write; identity
 *                          equality must fire it, and a repeat of the SAME
 *                          reference must coalesce.
 *
 * A fuzzer drawing only from primitives cannot tell identity from structure,
 * and equality is what decides whether a write propagates at all. The two
 * references carry toString tags (invisible to JSON/shallow structure) so
 * replay logs stay unambiguous; toNum() coerces both to 0, keeping every
 * computed body's arithmetic deterministic.
 */
export const REF_A = Object.freeze({ ref: "X", toString() { return "#refA"; } });
export const REF_B = Object.freeze({ ref: "X", toString() { return "#refB"; } });
export const VALUE_POOL = [0, -0, 1, -1, NaN, Infinity, -Infinity, "", "0", "1", null, undefined, false, true, REF_A, REF_B];

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
 * Reserved exit code for a scenario that self-skips because the ENGINE is below
 * the scenario's version floor (its surface does not exist yet). The runner
 * distinguishes it from pass(0) and fail(everything else) so a skip can never
 * masquerade as a pass — and a skip while the engine is AT or ABOVE the
 * scenario's floor (an export that should exist but does not) is escalated to
 * a failure. 77 follows the automake convention.
 */
export const SKIP_EXIT = 77;

/**
 * Reserved exit code for an ENVIRONMENT-prerequisite skip (the runtime, not
 * the engine, lacks something — e.g. Symbol.dispose on Node < 20). NEVER
 * floor-escalated: the engine's floor says nothing about the host runtime, so
 * escalating this would fail a healthy engine on an old Node with an actively
 * misleading "dropped export" diagnosis.
 */
export const ENV_SKIP_EXIT = 78;

/**
 * Collects failures instead of throwing on the first one, so a run reports every
 * broken invariant rather than only the earliest. Torture output is read once,
 * usually in CI, and "fix, rerun, discover the next one" is a slow loop.
 */
export function createReport(title) {
    const failures = [];
    const notes = [];
    let asserts = 0;
    const t0 = performance.now();

    return {
        /** Record a violation. */
        fail(scenario, detail) { asserts++; failures.push({ scenario, detail }); },

        /** Assert strict equality (Object.is), recording rather than throwing. */
        eq(scenario, got, want, detail) {
            asserts++;
            if (!Object.is(got, want)) {
                failures.push({ scenario, detail: `${detail}: expected ${fmt(want)}, got ${fmt(got)}` });
                return false;
            }
            return true;
        },

        ok(scenario, cond, detail) {
            asserts++;
            if (!cond) { failures.push({ scenario, detail }); return false; }
            return true;
        },

        /** Contextual line printed on success — counts, throughput, coverage. */
        note(line) { notes.push(line); },

        get failureCount() { return failures.length; },
        get assertCount() { return asserts; },

        /** Print and return an exit code. Never calls process.exit itself: the
         *  runner decides whether one failing scenario ends the whole run.
         *
         *  A scenario that reaches finish() having asserted NOTHING is itself a
         *  failure (opts.minAsserts, default 1): a stale feature guard that
         *  bypasses every section would otherwise print PASS while gating
         *  nothing. A scenario that legitimately cannot run must exit SKIP_EXIT
         *  instead of reaching finish(). */
        finish(passLine, opts) {
            const minAsserts = (opts && opts.minAsserts) || 1;
            if (failures.length === 0 && asserts < minAsserts) {
                failures.push({
                    scenario: "harness",
                    detail: `scenario made ${asserts} assertion(s), expected >= ${minAsserts} — ` +
                        `every section was bypassed; a run that asserts nothing must SKIP, not PASS`,
                });
            }
            const dt = ((performance.now() - t0) / 1000).toFixed(2);
            console.log(`${title} (${dt}s)`);
            for (const n of notes) console.log(`    ${n}`);
            if (failures.length === 0) {
                console.log(`  PASS: ${passLine} [${asserts} asserts]`);
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
