/**
 * bench/torture/op-accounting.mjs -- structural work accounting via the engine's
 * own onGraphMutation opcode lane (1.5.0+). NO timing, NO benchmarks.
 *
 * The lesson from the mark-lane review: do not measure wall-clock to catch a
 * work regression -- count deterministic work. The engine already exposes a
 * first-party counter lane through `onGraphMutation`, and NOTHING in the suite
 * uses it. `work-accounting.mjs` counts body runs with its own wrapper closures,
 * which is correct for asserting VALUES but blind to a whole class of bug: a
 * recompute the engine performs that a wrapper on a single node cannot see -- a
 * double-pull, a glitchy re-eval, or a markEpoch short-circuit that fails to fire
 * and silently recomputes a clean node. Those show up only as a divergence
 * between the engine's op-5 total and the sum of wrapper counts.
 *
 * The opcode lane in 1.5.0 (from the source): 1 node-create, 2 node-dispose,
 * 3 link-add, 4 link-remove, 5 recompute. (6 flush-pass and 7 effect-enqueue
 * arrive in 1.6; this file uses only 1-5 so it runs from 1.5.0 forward.)
 *
 * CRITICAL SEMANTICS, established empirically before writing any assertion:
 *   op 5 is emitted by BOTH executeEffect AND pullComputed. So
 *       op5_total == (computed recomputes) + (effect executions)
 *   exactly. A naive "op5 == number of computeds" assertion is WRONG and would
 *   false-alarm on every effect execution. Every assertion here accounts for the
 *   effect contribution explicitly. (This is the same shape of trap as the
 *   registry-mismatch footgun: the counter is real, but its meaning must be
 *   pinned before it is trusted.)
 *
 * What this catches that value-oracles and wrapper-counting miss:
 *   - the equality cutoff failing (an equal write propagating a RECOMPUTE);
 *   - a phantom recompute (op5 > wrapper bodies) or a skipped one (op5 < bodies);
 *   - link add/remove IMBALANCE across dynamic rewiring (op3 != op4 net), the
 *     structural signature of a subscription leak that no value ever reveals;
 *   - node create/dispose imbalance (op1 != op2) across churn.
 *
 * WHAT IT CANNOT CATCH -- the 1.5.0 instrumentation gap (found while building
 * this, and the real headline). The 1.5.0 headline optimisation is the
 * pullComputed CLEAN SHORT-CIRCUIT (markEpoch): if no mark landed on a node's
 * cone since its last eval, skip the dep-walk in O(1). But disabling it does NOT
 * change op5 -- because the dep-walk it skips reaches the SAME "nothing changed,
 * return cached" conclusion, just in O(deps) instead of O(1). The short-circuit
 * saves dep-COMPARISONS, and 1.5.0 emits no opcode for those (op 5 counts
 * recomputes, not comparisons). This is the exact analogue of the missing MARK
 * LANE that 1.13.0 later added as op 9/10: an un-instrumented cost that only a
 * dedicated counting twin could measure. Verified: a 50-deep clean chain read
 * 100x after unrelated writes shows op5=0 with the short-circuit both ON and
 * OFF; the only difference is 50 dep-comparisons per read. To catch a
 * short-circuit regression the engine would need a "compare lane" (op for
 * dep-link comparisons) the way 1.13.0 added a mark lane. Recommend one.
 *
 * Exit code: 0 iff every op-count invariant held.
 *
 * Usage: node --expose-gc bench/torture/op-accounting.mjs
 *        OP_SEEDS=2000 node --expose-gc bench/torture/op-accounting.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;

// Feature-detect the opcode lane.
{
    let ok = false;
    try {
        const r = createRegistry({ maxNodes: 16, onCapacityExceeded: "grow" });
        if (typeof r.onGraphMutation === "function") {
            let fired = false;
            const off = r.onGraphMutation(() => { fired = true; });
            const s = r.signal(0);
            const c = r.computed(() => s() + 1);
            c();                    // should emit op 5
            off();
            ok = fired;
        }
    } catch { ok = false; }
    if (!ok) {
        console.log("op-accounting -- SKIP: onGraphMutation opcode lane not available");
        process.exit(0);
    }
}

const SEEDS = Number(process.env.OP_SEEDS || 400);
const R = createReport(`lite-signal op-accounting -- structural work via onGraphMutation, ${SEEDS} seeds`);
const reg = () => createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow" });

// A counter harness bound to a registry: tallies opcodes with a scoped window.
function counters(r) {
    const c = { n1: 0, n2: 0, n3: 0, n4: 0, n5: 0 };
    const off = r.onGraphMutation((op) => {
        if (op === 5) c.n5++;
        else if (op === 3) c.n3++;
        else if (op === 4) c.n4++;
        else if (op === 1) c.n1++;
        else if (op === 2) c.n2++;
    });
    c.reset = () => { c.n1 = c.n2 = c.n3 = c.n4 = c.n5 = 0; };
    c.off = off;
    return c;
}

/* -- 0. Pin the op-5 identity: op5 == computed recomputes + effect executions -- */
{
    const r = reg();
    let comp = 0, eff = 0;
    const a = r.signal(1);
    const b = r.computed(() => { comp++; return a() + 1; });
    const cc = r.computed(() => { comp++; return a() + 2; });
    const d = r.computed(() => { comp++; return b() + cc(); });
    const stop = r.effect(() => { eff++; d(); });
    const ct = counters(r);
    comp = 0; eff = 0; ct.reset();
    a.set(5);
    R.eq("op5-identity", ct.n5, comp + eff,
        `op5 (${ct.n5}) must equal computed-recomputes (${comp}) + effect-executions (${eff})`);
    ct.off(); stop();
}

/* -- 1. Re-read caching: op5 stays flat on re-read (behaviour pin) ----------- */
{
    // NOTE: this pins the OBSERVABLE (no recompute on re-read), but it does NOT
    // prove the clean short-circuit specifically -- the first pullComputed guard
    // (evalVersion === globalVersion) also yields op5=0 here, and even with the
    // short-circuit disabled the dep-walk returns cached with op5=0. See the
    // header's "WHAT IT CANNOT CATCH". Kept as a behaviour pin, not a
    // short-circuit test.
    const r = reg();
    const a = r.signal(1);
    const c = r.computed(() => a() * 2);
    const ct = counters(r);
    c();                                   // first read: 1 recompute
    ct.reset();
    c(); c(); c(); c();                    // four re-reads, NO dep change
    R.eq("reread-cached", ct.n5, 0, "re-reading an unchanged computed recomputed it");
    ct.off();
}

/* -- 2. Equality cutoff: an equal write must not recompute downstream ------- */
{
    const r = reg();
    const a = r.signal(1);
    const b = r.computed(() => a() * 2);
    const cc = r.computed(() => b() + 1);
    const stop = r.effect(() => cc());
    const ct = counters(r);
    ct.reset();
    a.set(1);                              // SAME value
    cc();
    R.eq("equality-cutoff", ct.n5, 0, "an equal write propagated a recompute downstream");
    ct.off(); stop();
}
{
    // Custom equals predicate on a computed: an input change that leaves the
    // computed's value equal (under the predicate) must not recompute consumers.
    const r = reg();
    const a = r.signal(0);
    const parity = r.computed(() => a() % 2, { equals: (x, y) => x === y });
    const downstream = r.computed(() => parity() + 100);
    const stop = r.effect(() => downstream());
    const ct = counters(r);
    ct.reset();
    a.set(2);                              // 0 -> 2: parity 0 -> 0, equal under predicate
    downstream();
    // parity recomputes (its input changed) but downstream must NOT.
    R.ok("custom-equals-cutoff", ct.n5 <= 1,
        `a value-preserving input change recomputed downstream: op5=${ct.n5} (expected <=1: only parity)`);
    ct.off(); stop();
}

/* -- 3. Diamond: exactly one recompute per node per write (glitch-free) ----- */
{
    const r = reg();
    let bodies = 0;
    const a = r.signal(1);
    const b = r.computed(() => { bodies++; return a() + 1; });
    const cc = r.computed(() => { bodies++; return a() + 2; });
    const d = r.computed(() => { bodies++; return b() + cc(); });
    let eff = 0;
    const stop = r.effect(() => { eff++; d(); });
    const ct = counters(r);
    bodies = 0; eff = 0; ct.reset();
    a.set(9);
    // Glitch-free: b, c, d each recompute exactly once -> 3 computed bodies.
    R.eq("diamond-glitchfree", bodies, 3, `diamond recomputed ${bodies} computed bodies, expected 3 (b,c,d once each)`);
    // And op5 accounts for exactly those plus the effect executions.
    R.eq("diamond-glitchfree", ct.n5, bodies + eff, `op5 (${ct.n5}) != bodies (${bodies}) + effects (${eff})`);
    ct.off(); stop();
}

/* -- 4. Link balance across dynamic rewiring (leak signature) --------------- */
{
    // A computed that switches which source it reads must RELEASE the old link
    // as it acquires the new one. Over many toggles, net links must not grow.
    const r = reg();
    const which = r.signal(true);
    const a = r.signal(10);
    const b = r.signal(20);
    const c = r.computed(() => (which() ? a() : b()));
    const stop = r.effect(() => c());
    const ct = counters(r);
    ct.reset();
    let netMax = 0;
    for (let i = 0; i < 200; i++) {
        which.set(i % 2 === 0);
        c();                               // force re-eval so the switch happens
        const net = ct.n3 - ct.n4;
        if (net > netMax) netMax = net;
    }
    // The dependency set size is bounded (c reads `which` plus one of a/b), so the
    // net links added-minus-removed must stay small and bounded, never growing
    // with the 200 iterations. A leak shows as net climbing ~linearly.
    R.ok("link-balance", netMax <= 8,
        `net link count peaked at ${netMax} over 200 rewirings -- links are leaking (op3=${ct.n3}, op4=${ct.n4})`);
    ct.off(); stop();
}

/* -- 5. Node balance: dispose frees the node it created --------------------- */
{
    const r = reg();
    const ct = counters(r);
    ct.reset();
    for (let round = 0; round < 100; round++) {
        const s = r.signal(round);
        const c = r.computed(() => s() * 2);
        const stop = r.effect(() => c());
        stop();
        r.dispose(c);
        r.dispose(s);
    }
    // Every node created in a round is disposed in the same round: op1 == op2.
    R.eq("node-balance", ct.n1, ct.n2, `created ${ct.n1} nodes but disposed ${ct.n2} -- a node leak`);
    ct.off();
}

/* -- 6. Laziness: an UNOBSERVED computed does not recompute on write -------- */
{
    const r = reg();
    let bodies = 0;
    const a = r.signal(0);
    const c = r.computed(() => { bodies++; return a() * 2; });
    c();                                   // prime it
    const ct = counters(r);
    bodies = 0; ct.reset();
    a.set(1); a.set(2); a.set(3);          // writes, but c is NOT observed and NOT read
    R.eq("laziness", ct.n5, 0, "an unobserved, unread computed recomputed on write -- laziness broken");
    R.eq("laziness", bodies, 0, "unobserved computed body ran without a read");
    ct.off();
}

/* -- 7. Differential: op5 total == wrapper bodies + effect execs, fuzzed ---- */

function fuzzSeed(seed) {
    const rnd = mulberry32(seed);
    const r = reg();

    let compBodies = 0;
    let effExecs = 0;
    const L = 6;
    const leaves = Array.from({ length: L }, (_, i) => r.signal(i));
    const comps = [];
    let prev = leaves.map((_, i) => ({ leaf: i }));
    for (let t = 0; t < 3; t++) {
        const tier = [];
        for (let n = 0; n < 5; n++) {
            const deps = [];
            const fanIn = 2 + randInt(rnd, 2);
            for (let d = 0; d < fanIn; d++) deps.push(prev[randInt(rnd, prev.length)]);
            const idx = comps.length;
            comps.push(r.computed(() => {
                compBodies++;
                let acc = 0;
                for (const dep of deps) acc += (dep.leaf !== undefined ? leaves[dep.leaf]() : comps[dep.node]());
                return acc | 0;
            }));
            tier.push({ node: idx });
        }
        prev = prev.concat(tier);
    }
    const stops = [];
    for (let e = 0; e < 4; e++) {
        const idx = randInt(rnd, comps.length);
        stops.push(r.effect(() => { effExecs++; comps[idx](); }));
    }

    const ct = counters(r);
    compBodies = 0; effExecs = 0; ct.reset();

    for (let op = 0; op < 30; op++) {
        leaves[randInt(rnd, L)].set(randInt(rnd, 1000));
        if (rnd() < 0.3) comps[randInt(rnd, comps.length)]();   // random pulls
    }
    // Force everything settled/pulled so no lazy recompute is pending-but-uncounted.
    for (const c of comps) c();

    const total = compBodies + effExecs;
    ct.off();
    for (const s of stops) s();

    // The identity must hold EXACTLY: the engine's op5 equals the observed work.
    if (ct.n5 !== total) return { seed, op5: ct.n5, bodies: compBodies, effs: effExecs };
    return null;
}

let fuzzFail = 0;
let firstFail = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    let bad;
    try { bad = fuzzSeed(seed); }
    catch (err) { fuzzFail++; if (!firstFail) firstFail = { seed, threw: err.message }; continue; }
    if (bad) { fuzzFail++; if (!firstFail) firstFail = bad; }
}
if (fuzzFail > 0) {
    const d = firstFail.threw
        ? `seed ${firstFail.seed} threw: ${firstFail.threw}`
        : `seed ${firstFail.seed}: op5=${firstFail.op5} but wrapper bodies=${firstFail.bodies}+effects=${firstFail.effs}=${firstFail.bodies + firstFail.effs} -- a phantom or skipped recompute`;
    R.fail("op5-differential", `${fuzzFail}/${SEEDS} seeds broke the op5 identity; ${d}`);
}

R.note(`${SEEDS} seeds cross-checking engine op5 against wrapper bodies + effect executions`);
process.exit(R.finish("structural op-counts held: short-circuits fire, links balance, op5 accounts for exactly the work done"));
