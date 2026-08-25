/**
 * bench/torture/retrack-dispose-torture.mjs — dispose-during-retracking, gate-free.
 *
 * Hoisted from scope-torture.mjs sections 1-2 (2026-08 instrument audit). Those
 * sections need only signal/effect/dispose — all present since 1.4 — but lived
 * behind scope-torture's `createScope` feature gate, so the ENTIRE file skipped
 * on any pre-1.6 engine and the sharpest disposal hazard in the suite never
 * executed against the canonical 1.5.0 line. This file carries the same two
 * registers with no gate, plus the value oracle the originals lacked:
 *
 *   1. The exact crash repro: an observer disposing a source it linked on the
 *      PREVIOUS run but has not re-read on the CURRENT one — the re-tracking
 *      cursor is parked on a link that disposal frees, and `severTail` then
 *      walks from freed memory. One hand-written scenario.
 *
 *   2. The same hazard fuzzed: a rotating dependency subset guarantees that on
 *      any given run some sources are "linked last time, not read yet", and the
 *      observer disposes one of those mid-flush, across RETRACK_SEEDS seeds.
 *      An off-by-one in the cursor repair would survive the single hand-written
 *      case; it does not survive 300 randomized interleavings.
 *
 *      New here: a VALUE ORACLE. The original fuzz was crash-only — a cursor
 *      repair that silently dropped a live link (graph intact, values wrong)
 *      passed it. After every seed, each surviving source receives one more
 *      write and must read back exactly its model value, and the registry's
 *      activeNodes must equal the surviving-node count — so the fuzz now fails
 *      on silent link loss and on pool imbalance, not only on a crash.
 *
 * scope-torture.mjs keeps its copies for the 1.6+ engines (where they run
 * alongside the createScope contract); this file is the 1.4+ floor's coverage.
 *
 * Exit code: 0 iff disposal never crashed, every survivor read back its model
 * value, and the pool stayed balanced.
 *
 * Usage: node --expose-gc bench/torture/retrack-dispose-torture.mjs
 *        RETRACK_SEEDS=2000 node --expose-gc bench/torture/retrack-dispose-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, soakRegistry, createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;

const SEEDS = Number(process.env.RETRACK_SEEDS || 300);
const R = createReport(`lite-signal retrack-dispose torture — cursor hazard + value oracle, ${SEEDS} seeds`);

/* ── 1. The disposal crash, exact repro ───────────────────────────────────── */
{
    const r = soakRegistry(createRegistry);
    const gate = r.signal(true);
    const src = r.signal(1);
    let threw = null;
    try {
        r.effect(function () {
            if (gate()) src();            // run 1: link src
            else r.dispose(src);          // run 2: dispose src while the cursor is parked on its link
        });
        gate.set(false);
    } catch (err) { threw = err; }
    R.ok("dispose-linked-unread", threw === null,
        `disposing a linked-but-unread source crashed: ${threw && threw.message}`);
}

/* ── 2. Fuzzed disposal-during-retracking, with a value oracle ────────────── */

function disposalFuzz(seed) {
    const rnd = mulberry32(seed);
    const r = soakRegistry(createRegistry);

    // A pool of sources, and an observer whose dependency set changes every run
    // so that on any given run some sources are "linked last time, not read yet".
    const N = 12;
    const sources = Array.from({ length: N }, (_, i) => r.signal(i));
    const model = Array.from({ length: N }, (_, i) => i); // shadow of every write
    const alive = new Array(N).fill(true);
    const gate = r.signal(0);
    let threw = null;

    // BOUNDED, SEED-DEPENDENT disposal schedule, precomputed OUTSIDE the effect.
    // (The first draft disposed one victim on EVERY step: victims (step+1)%N for
    // steps 1..12 enumerate all N sources, so every seed killed everything by
    // step 12 and the survivor oracles below ran on an empty set -- a vacuous
    // PASS the 2026-08 review caught. A budget of 4..9 disposals over 30 steps
    // guarantees >= 3 survivors, and the per-seed schedule + victim offset make
    // the interleaving genuinely different per seed.)
    const disposeAtStep = new Array(31).fill(false);
    let budget = 4 + randInt(rnd, 6);           // 4..9 victims per seed
    for (let s = 1; s <= 30 && budget > 0; s++) {
        if (rnd() < 0.35) { disposeAtStep[s] = true; budget--; }
    }
    const victimOffset = randInt(rnd, N);

    try {
        r.effect(function () {
            const step = gate();
            const pick = step % N;
            // Read a rotating subset -> the complement is linked-from-before-but-unread.
            for (let k = 0; k < N; k++) {
                if (!alive[k]) continue;
                if (((k + pick) % 3) === 0) sources[k]();
            }
            // On scheduled steps, dispose one CURRENTLY-unread-but-previously-linked
            // source from inside the very observer that holds the parked cursor.
            if (step > 0 && disposeAtStep[step]) {
                const victim = (pick + 1 + victimOffset) % N;
                if (alive[victim]) { r.dispose(sources[victim]); alive[victim] = false; }
            }
        });

        for (let step = 1; step <= 30; step++) {
            gate.set(step);
            // Also churn: write a random surviving source, mirrored in the model.
            const w = randInt(rnd, N);
            if (alive[w]) { sources[w].set(step * 100 + w); model[w] = step * 100 + w; }
        }
    } catch (err) {
        threw = err;
    }
    if (threw !== null) return { threw };

    // VALUE ORACLE — a cursor repair that silently dropped or crossed a link
    // leaves the graph "intact" but wrong. Every survivor takes one more write
    // and must read back exactly its model value (top-level reads are
    // untracked, so the oracle itself cannot perturb the dependency sets).
    let valueBad = null;
    for (let k = 0; k < N; k++) {
        if (!alive[k]) continue;
        sources[k].set(model[k] + 7);
        model[k] += 7;
        const got = sources[k]();
        if (!Object.is(got, model[k])) { valueBad = `source[${k}]: expected ${model[k]}, got ${got}`; break; }
    }

    // POOL ORACLE — survivors + gate + the observer effect are the only nodes
    // that may remain; a double-free or a leaked victim shows up here.
    const surviving = alive.reduce((n, a) => n + (a ? 1 : 0), 0);
    const expectNodes = surviving + 2; // + gate + effect
    const gotNodes = r.stats().activeNodes;

    // NON-VACUITY GUARD — the disposal budget (max 9 of 12) structurally
    // guarantees survivors; if this ever reads 0 the oracle above asserted
    // nothing and the seed must FAIL rather than silently pass empty.
    return { threw: null, valueBad, expectNodes, gotNodes, surviving };
}

let fuzzCrashes = 0, valueFails = 0, poolFails = 0, vacuousSeeds = 0;
let minSurvivors = Infinity, survivorSum = 0;
let firstBad = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    const out = disposalFuzz(seed);
    if (out.threw) {
        fuzzCrashes++;
        if (firstBad === null) firstBad = { seed, detail: out.threw.message };
    } else if (out.valueBad) {
        valueFails++;
        if (firstBad === null) firstBad = { seed, detail: out.valueBad };
    } else if (out.gotNodes !== out.expectNodes) {
        poolFails++;
        if (firstBad === null) firstBad = { seed, detail: `activeNodes ${out.gotNodes}, expected ${out.expectNodes}` };
    } else if (out.surviving === 0) {
        vacuousSeeds++;
        if (firstBad === null) firstBad = { seed, detail: "0 survivors -- the value oracle asserted nothing" };
    }
    if (out.surviving !== undefined) {
        minSurvivors = Math.min(minSurvivors, out.surviving);
        survivorSum += out.surviving;
    }
}
R.ok("disposal-fuzz-crash", fuzzCrashes === 0,
    `${fuzzCrashes}/${SEEDS} seeds crashed disposing linked-but-unread sources mid-flush` +
    (firstBad ? `; first at seed ${firstBad.seed}: ${firstBad.detail}` : ""));
R.ok("disposal-fuzz-values", valueFails === 0,
    `${valueFails}/${SEEDS} seeds read a wrong survivor value after disposal churn` +
    (firstBad ? `; first at seed ${firstBad.seed}: ${firstBad.detail}` : ""));
R.ok("disposal-fuzz-pool", poolFails === 0,
    `${poolFails}/${SEEDS} seeds left the pool unbalanced after disposal churn` +
    (firstBad ? `; first at seed ${firstBad.seed}: ${firstBad.detail}` : ""));
R.ok("disposal-fuzz-nonvacuous", vacuousSeeds === 0 && minSurvivors >= 3,
    `oracle vacuity: ${vacuousSeeds} zero-survivor seeds, min survivors ${minSurvivors} ` +
    `(the 4..9 disposal budget must leave >= 3 of 12 alive so the value oracle always runs)`);

R.note(`${SEEDS} seeds x 30 steps; 12-source rotating subset; 4..9 seeded disposals/seed; ` +
    `survivors min ${minSurvivors} / avg ${(survivorSum / SEEDS).toFixed(1)}; oracle: survivor values + activeNodes`);

process.exit(R.finish("disposing linked-but-unread sources mid-flush never crashed, corrupted a survivor, or leaked a node"));
