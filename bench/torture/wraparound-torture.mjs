/**
 * bench/torture/wraparound-torture.mjs — the 2^31 dormancy band, at FULL
 * DISTANCE (opt-in).
 *
 * The engine versions with 32-bit modular arithmetic: `globalVersion` wraps
 * through `| 0` and staleness is the SIGNED difference
 * `((dep.version - evalVersion) | 0) > 0` (same discipline for markEpoch).
 * Signed-diff recency is exact while the gap between a node's last evaluation
 * and its dependency's version is under 2^31. At and beyond it, the diff
 * ALIASES negative — and this scenario pins exactly what that means on the
 * shipped engine, measured first with an accelerated version-jump probe and
 * confirmed here by really spinning globalVersion ~2.1 billion steps
 * (~10s per band crossing on the 2026 reference host):
 *
 *   THE BAND (dormancy gap in [2^31-1, 2^32)): the FIRST dependency write
 *   after the dormancy is silently absorbed — the computed's pull
 *   short-circuits on the aliased diff and serves the stale cache. OBSERVED
 *   cones are hit HARDER: the effect is marked and queued, but
 *   executeEffect's dep-validation walk sees the same aliased diff and skips
 *   the body entirely -- the write is fully invisible downstream, not even a
 *   stale re-run. Raw signal reads are unaffected (signals store values
 *   directly). RECOVERY is automatic and one-shot: the stale
 *   pull re-stamps evalVersion to the current globalVersion, so the NEXT
 *   write propagates normally.
 *
 *   BELOW THE BAND (gap <= 2^31-17 measured; boundary at 2^31-1): exact.
 *
 * These are pins of ACTUAL behavior, not endorsements: a future engine that
 * closes the band (uint32 compare epochs, dormancy re-stamping, 53-bit
 * versions) will trip the band pins and must flip them DELIBERATELY, with
 * this header rewritten. Until then the honest contract is: "indefinite
 * uptime" is crash-true and value-true for any node pulled at least once per
 * 2^31 global writes; a node dormant past that loses exactly the first
 * post-dormancy write.
 *
 * OPT-IN: ~30s of real spinning. Runs only with TORTURE_WRAPAROUND=1; exits
 * 78 (environment skip — never floor-escalated) otherwise.
 *
 * Usage: TORTURE_WRAPAROUND=1 node --expose-gc bench/torture/wraparound-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { createReport, ENV_SKIP_EXIT } from "./helpers/index.mjs";

if (process.env.TORTURE_WRAPAROUND !== "1") {
    console.log("lite-signal wraparound torture -- SKIP: opt-in soak (set TORTURE_WRAPAROUND=1; ~30s of real version spinning)");
    process.exit(ENV_SKIP_EXIT);
}

const { createRegistry } = Signal;
const R = createReport("lite-signal wraparound torture -- the 2^31 dormancy band at full distance");

const BAND = 0x80000000;           // 2^31
const UNDER = BAND - 64;           // safely below the boundary
const OVER = BAND + 64;            // safely inside the band

/** Advance the registry's globalVersion by `n` REAL writes on a dedicated
 *  observer-free signal (markDownstream on an empty sub list; ~4.7 ns/write
 *  measured). Chunked so the loop variable stays int32-friendly. */
function spin(sig, n) {
    let done = 0;
    while (done < n) {
        const chunk = Math.min(n - done, 1 << 28);
        for (let i = 0; i < chunk; i++) sig.set(i);
        done += chunk;
    }
}

/* -- 1. below the band: exact at 2^31 - 65 dormancy ------------------------- */
{
    const t0 = performance.now();
    const r = createRegistry();
    const spinner = r.signal(0);
    const s = r.signal(10);
    let runs = 0;
    const c = r.computed(() => { runs++; return s() * 2; });
    c();                                       // evalVersion stamped; dormancy starts
    spin(spinner, UNDER);
    s.set(11);
    R.eq("below-band", c(), 22, "a write after 2^31-65 dormancy was lost -- the safe band shrank");
    R.eq("below-band", runs, 2, "recompute count wrong below the band");
    R.note(`below-band -- ok: ${UNDER.toLocaleString()} real spins, fresh delivery (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

/* -- 2. the band, unobserved: first write absorbed, second recovers --------- */
{
    const t0 = performance.now();
    const r = createRegistry();
    const spinner = r.signal(0);
    const s = r.signal(10);
    let runs = 0;
    const c = r.computed(() => { runs++; return s() * 2; });
    c();
    spin(spinner, OVER);
    s.set(11);                                  // the absorbed write
    const v1 = c();
    R.eq("band-unobserved", v1, 20,
        "PIN CHANGED: a write after 2^31+63 dormancy DELIVERED -- the aliasing band closed; " +
        "if this is a deliberate engine fix, flip these pins and rewrite the header");
    R.eq("band-unobserved", runs, 1, "the band pull recomputed -- aliasing behavior changed");
    s.set(12);                                  // recovery: evalVersion was re-stamped by the stale pull
    R.eq("band-unobserved", c(), 24, "the SECOND write after the band did not recover -- the one-shot-loss contract broke");
    R.eq("band-unobserved", runs, 2, "recovery recompute count wrong");
    R.note(`band-unobserved -- pinned: first post-dormancy write absorbed, second recovers (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

/* -- 3. the band, OBSERVED: write invisible downstream, then recovery ------- */
{
    const t0 = performance.now();
    const r = createRegistry();
    const spinner = r.signal(0);
    const s = r.signal(10);
    let runs = 0, seen = -1, effRuns = 0;
    const c = r.computed(() => { runs++; return s() * 2; });
    r.effect(() => { seen = c(); effRuns++; });
    spin(spinner, OVER);
    const eff0 = effRuns;
    s.set(11);
    // Full-distance truth (the accelerated probe could not distinguish this):
    // the effect body does NOT run -- executeEffect's needsRun walk hits the
    // same aliased diff and skips. The write is invisible downstream.
    R.eq("band-observed", effRuns, eff0,
        "PIN CHANGED: the effect BODY ran inside the band -- the dep-validation aliasing closed; flip deliberately");
    R.eq("band-observed", seen, 20,
        "PIN CHANGED: an observed cone delivered a FRESH value inside the band -- the aliasing closed; flip deliberately");
    s.set(12);
    R.eq("band-observed", seen, 24, "the observed cone did not recover on the second write");
    R.ok("band-observed", effRuns > eff0, "the recovery write did not re-run the effect body");
    R.note(`band-observed -- pinned: the write is fully invisible downstream (body skipped), second write recovers (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

/* -- 4. raw signals are immune (values stored directly) --------------------- */
{
    const r = createRegistry();
    const spinner = r.signal(0);
    const s = r.signal(10);
    spin(spinner, 1 << 20);                     // token spin; immunity is structural
    s.set(11);
    R.eq("raw-signal", s(), 11, "a raw signal read lost a write -- signals must be version-independent");
    R.eq("raw-signal", s.peek(), 11, "peek lost a write");
}

process.exit(R.finish("the 2^31 dormancy band is pinned at full distance: exact below, one-shot absorb + recover inside"));
