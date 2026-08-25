/**
 * bench/torture/oracle-fuzzer.mjs — differential CORRECTNESS fuzz.
 *
 * The other soaks in this directory answer two questions: did anything throw,
 * and did the pool come back to baseline. Both are liveness questions. None of
 * them reads a single value and asks whether it is RIGHT — so an engine that
 * returns stale values from every computed passes all three green. That is not
 * hypothetical: flipping the clean short-circuit in `pullComputed` from `<= 0`
 * to `<= 1` (a one-character off-by-one, exactly the kind of edit a perf tweak
 * makes) keeps the pool perfectly balanced, throws nothing, and is invisible to
 * graph-fuzzer, scheduler-bench and torture-soak alike. The unit suite catches
 * it — but only on small hand-written graphs.
 *
 * This file closes that gap: it drives a random DAG and compares EVERY computed
 * against an independent reference model that recomputes from the leaves with no
 * caching, no versioning and no short-circuit. Any disagreement is a correctness
 * bug, printed with the seed and the full operation log so it can be replayed.
 *
 * Checking is PROBABILISTIC (p = 0.4 per op, always once at seed end), not
 * after-every-op: a full re-pull after every operation means no node is ever
 * more than one write stale, which structurally masks the second-invalidation
 * class — a version-marking bug where the SECOND write into an already-dirty,
 * unpulled cone is dropped survives an always-check oracle because the cone is
 * never dirty twice. Skipped checks let staleness accumulate across several
 * writes before a check lands (the write-burst op drives 2-5 writes into one
 * cone with no intermediate CHECK; sync effect flushes still re-pull observed
 * cones between writes, so the unpulled-accumulation coverage lands on the
 * unobserved portion — batched multi-writes cover the observed cones).
 * checkAll also walks the nodes in a
 * fresh seeded-shuffled order per call, so sink-first recursive pulls are
 * exercised deterministically rather than only in creation order.
 *
 * The reference is deliberately dumb. It shares no code with the engine, so a
 * bug in the engine's invalidation cannot hide in the oracle too.
 *
 * Exit code: 0 iff every read matched the reference on every seed.
 *
 * Usage:
 *   node --expose-gc bench/torture/oracle-fuzzer.mjs
 *   ORACLE_SEEDS=2000 node --expose-gc bench/torture/oracle-fuzzer.mjs
 */

import { performance } from "node:perf_hooks";
import { createRegistry } from "../../Signal.js";
import { mulberry32, shuffle, VALUE_POOL, toNum } from "./helpers/index.mjs";

const SEEDS = Number(process.env.ORACLE_SEEDS || 400);

/** Per-op probability that a full differential check runs. See the header:
 *  always-checking masks staleness accumulation; never-checking finds bugs
 *  late with unusable logs. 0.4 keeps the expected gap between checks at
 *  ~2.5 ops while still checking ~48 times per seed. */
const CHECK_P = 0.4;

/**
 * Adversarial leaf values.
 *
 * An earlier draft of this file used integers only, and a mutant that swapped
 * the default equality from Object.is to `==` sailed through: on integers the
 * two agree. Equality is load-bearing here -- it is what decides whether a write
 * propagates at all -- so the value domain has to contain the pairs where the
 * candidate definitions disagree:
 *
 *   Object.is vs ===   differ on NaN (is: equal) and on -0/0 (is: distinct)
 *   ===       vs ==    differ on 0/"" /false/"0" and null/undefined
 *
 * Reaching those pairs needs an identity-preserving node shape too: a `sum`
 * node collapses -0 and 0 to the same total, so the mismatch is invisible
 * downstream. See the `identity` kind below.
 */
const pickValue = (rnd) => VALUE_POOL[(rnd() * VALUE_POOL.length) | 0];
const OPS_PER_SEED = Number(process.env.ORACLE_OPS || 120);

/* ── deterministic RNG: a failure is replayable from its seed alone ───────── */

/* ── the model ────────────────────────────────────────────────────────────────
 *
 * A graph is described as plain data BEFORE anything reactive is built, so the
 * reference evaluator can walk the same description without touching the
 * engine. Two node shapes, both chosen because they stress different paths:
 *
 *   sum    — reads every dependency, every time. Exercises the static fan-in
 *            path and wide invalidation cones.
 *   select — reads a selector, then reads exactly ONE dependency chosen by it.
 *            This is the dynamic-dependency case: the set of sources changes
 *            between evaluations, so the engine must unsubscribe from the branch
 *            it no longer reads. A stale subscription here is invisible to a
 *            crash-and-pool oracle but produces wrong values immediately.
 */

function buildModel(rnd, { leaves, tiers, perTier }) {
    const model = { leaves: [], nodes: [] };
    for (let i = 0; i < leaves; i++) {
        model.leaves.push({ id: "L" + i, value: rnd() < 0.5 ? (rnd() * 100) | 0 : pickValue(rnd) });
    }

    let prev = model.leaves.map((l, i) => ({ kind: "leaf", index: i }));
    for (let t = 0; t < tiers; t++) {
        const tier = [];
        for (let n = 0; n < perTier; n++) {
            const fanIn = 2 + ((rnd() * 3) | 0);
            const deps = [];
            for (let d = 0; d < fanIn; d++) deps.push(prev[(rnd() * prev.length) | 0]);
            const roll = rnd();
            const kind = roll < 0.30 ? "select" : (roll < 0.55 ? "identity" : "sum");
            const node = {
                kind,
                id: "T" + t + "N" + n,
                deps,
                // `select` needs a selector source; reuse a leaf so writes can steer it.
                selector: kind === "select" ? { kind: "leaf", index: (rnd() * leaves) | 0 } : null,
            };
            model.nodes.push(node);
            tier.push({ kind: "node", index: model.nodes.length - 1 });
        }
        // Later tiers may draw from ANY earlier tier, not just the one below,
        // so the graph is a genuine DAG with skip edges rather than a layer cake.
        prev = prev.concat(tier);
    }
    return model;
}

/**
 * Reference evaluator: naive, uncached, recursive. Recomputes the whole cone
 * every call. Slow on purpose — it has no versioning to get wrong.
 */
function reference(model, ref) {
    if (ref.kind === "leaf") return model.leaves[ref.index].value;
    const node = model.nodes[ref.index];
    if (node.kind === "sum") {
        let acc = 0;
        for (let i = 0; i < node.deps.length; i++) acc = (acc + toNum(reference(model, node.deps[i]))) | 0;
        return acc;
    }
    // Passes its dependency's value through UNTOUCHED, so -0 stays -0 and NaN
    // stays NaN. This is the shape that makes an equality bug observable; a sum
    // would normalise the difference away.
    if (node.kind === "identity") return reference(model, node.deps[0]);
    const sel = toNum(reference(model, node.selector));
    const chosen = node.deps[((sel % node.deps.length) + node.deps.length) % node.deps.length];
    return reference(model, chosen);
}

/* ── the engine build ─────────────────────────────────────────────────────── */

function buildLive(r, model) {
    const sigs = model.leaves.map((l) => r.signal(l.value));
    const comps = new Array(model.nodes.length);
    const read = (ref) => (ref.kind === "leaf" ? sigs[ref.index]() : comps[ref.index]());

    for (let i = 0; i < model.nodes.length; i++) {
        const node = model.nodes[i];
        if (node.kind === "sum") {
            comps[i] = r.computed(function () {
                let acc = 0;
                for (let d = 0; d < node.deps.length; d++) acc = (acc + toNum(read(node.deps[d]))) | 0;
                return acc;
            });
        } else if (node.kind === "identity") {
            comps[i] = r.computed(function () { return read(node.deps[0]); });
        } else {
            comps[i] = r.computed(function () {
                const sel = toNum(read(node.selector));
                const n = node.deps.length;
                return read(node.deps[((sel % n) + n) % n]);
            });
        }
    }
    return { sigs, comps };
}

/* ── one seed ─────────────────────────────────────────────────────────────── */

function runSeed(seed) {
    const rnd = mulberry32(seed);
    const model = buildModel(rnd, { leaves: 12, tiers: 4, perTier: 8 });
    const r = createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow" });
    const { sigs, comps } = buildLive(r, model);

    const log = [];
    const mismatches = [];

    // Effects give the push side of the engine something to do while we pull.
    // Their bodies are irrelevant; their presence is not — a graph with live
    // observers takes different invalidation paths than a pull-only one.
    const effectDisposers = [];
    for (let e = 0; e < 6; e++) {
        const target = (rnd() * comps.length) | 0;
        effectDisposers.push(r.effect(function () { comps[target](); }));
    }

    // Walk order is re-shuffled per call: pulling a deep sink FIRST forces the
    // recursive clean-check down the whole cone, where creation (topological)
    // order would have validated every dependency before reaching it.
    const order = model.nodes.map((_, i) => i);
    const checkAll = (label) => {
        shuffle(rnd, order);
        for (let k = 0; k < order.length; k++) {
            const i = order[k];
            const got = comps[i]();
            const want = reference(model, { kind: "node", index: i });
            if (!Object.is(got, want)) {
                mismatches.push({ label, node: model.nodes[i].id, kind: model.nodes[i].kind, got, want });
                return false;                       // one is enough; keep the log short
            }
        }
        return true;
    };

    if (!checkAll("initial")) return { seed, log, mismatches };

    for (let op = 0; op < OPS_PER_SEED; op++) {
        const roll = rnd();

        if (roll < 0.40) {
            const li = (rnd() * model.leaves.length) | 0;
            const v = rnd() < 0.55 ? (rnd() * 100) | 0 : pickValue(rnd);
            model.leaves[li].value = v;
            sigs[li].set(v);
            log.push(`set L${li}=${String(v)}${Object.is(v, -0) ? "(-0)" : ""}`);
        } else if (roll < 0.50) {
            // Write-burst: 2-5 consecutive writes into the SAME leaf with no
            // intermediate CHECK. Precision note: outside batch each set()
            // synchronously flushes the 6 installed effects, so cones those
            // effects observe ARE re-pulled between burst writes — the
            // "already-dirty, unpulled cone" condition holds for the
            // UNOBSERVED portion of the graph here, while observed cones get
            // their multi-write-without-pull coverage from the batch op
            // above. Only the LAST value must survive; a marker that
            // early-exits on "already dirty" without re-stamping serves the
            // first write's value on the unobserved cones.
            const li = (rnd() * model.leaves.length) | 0;
            const n = 2 + ((rnd() * 4) | 0);
            let v;
            for (let w = 0; w < n; w++) {
                v = rnd() < 0.55 ? (rnd() * 100) | 0 : pickValue(rnd);
                sigs[li].set(v);
            }
            model.leaves[li].value = v;
            log.push(`burst L${li} x${n} ->${String(v)}${Object.is(v, -0) ? "(-0)" : ""}`);
        } else if (roll < 0.65) {
            // Batched multi-write: the engine may coalesce, but the settled
            // values must match a reference that knows nothing about batching.
            const n = 2 + ((rnd() * 4) | 0);
            const writes = [];
            r.batch(function () {
                for (let w = 0; w < n; w++) {
                    const li = (rnd() * model.leaves.length) | 0;
                    const v = rnd() < 0.55 ? (rnd() * 100) | 0 : pickValue(rnd);
                    model.leaves[li].value = v;
                    sigs[li].set(v);
                    writes.push(`L${li}=${String(v)}${Object.is(v, -0) ? "(-0)" : ""}`);
                }
            });
            log.push(`batch{${writes.join(",")}}`);
        } else if (roll < 0.78) {
            // Write the SAME value back. A correct engine must not report a
            // change; an over-eager one recomputes but must still agree.
            const li = (rnd() * model.leaves.length) | 0;
            sigs[li].set(model.leaves[li].value);
            log.push(`rewrite L${li}`);
        } else if (roll < 0.88) {
            // Steer a selector so dynamic dependency sets actually move.
            const selNodes = model.nodes.filter((n) => n.kind === "select");
            if (selNodes.length > 0) {
                const node = selNodes[(rnd() * selNodes.length) | 0];
                const li = node.selector.index;
                const v = (rnd() * 100) | 0;
                model.leaves[li].value = v;
                sigs[li].set(v);
                log.push(`steer ${node.id} via L${li}=${v}`);
            }
        } else if (roll < 0.95) {
            // Read a random subset first, THEN check. Reading changes internal
            // eval bookkeeping, so interleaving reads with writes exercises the
            // short-circuit paths that a read-everything-every-time loop hides.
            const k = 1 + ((rnd() * 5) | 0);
            for (let i = 0; i < k; i++) comps[(rnd() * comps.length) | 0]();
            log.push(`partial-read x${k}`);
        } else {
            // Untracked read must not alter subsequent correctness.
            const target = (rnd() * comps.length) | 0;
            r.untrack(function () { comps[target](); });
            log.push(`untrack read ${target}`);
        }

        // Probabilistic: most ops leave the graph unchecked so staleness can
        // accumulate across several writes before a check lands (see header).
        if (rnd() < CHECK_P && !checkAll("after op " + op)) break;
    }

    // Always settle the seed with a full check — the tail of the op sequence
    // must not escape validation just because the last few rolls skipped it.
    if (mismatches.length === 0) checkAll("final");

    for (const d of effectDisposers) d();
    return { seed, log, mismatches };
}

/* ── driver ───────────────────────────────────────────────────────────────── */

const t0 = performance.now();
let failures = 0;
let firstFailure = null;
let checks = 0;

for (let seed = 1; seed <= SEEDS; seed++) {
    let result;
    try {
        result = runSeed(seed);
    } catch (err) {
        failures++;
        if (firstFailure === null) firstFailure = { seed, threw: err };
        continue;
    }
    checks += result.log.length;
    if (result.mismatches.length > 0) {
        failures++;
        if (firstFailure === null) firstFailure = result;
    }
}

const dt = ((performance.now() - t0) / 1000).toFixed(2);
console.log(`lite-signal oracle fuzzer — ${SEEDS} seeds x ${OPS_PER_SEED} ops (${dt}s)`);

if (failures === 0) {
    console.log(`  PASS: every computed matched the reference on all ${SEEDS} seeds (${checks.toLocaleString()} ops)`);
    process.exit(0);
}

console.error(`  FAIL: ${failures}/${SEEDS} seeds disagreed with the reference`);
if (firstFailure.threw) {
    console.error(`  seed ${firstFailure.seed} threw: ${firstFailure.threw.message}`);
} else {
    const m = firstFailure.mismatches[0];
    console.error(`  seed ${firstFailure.seed}: ${m.node} (${m.kind}) ${m.label}`);
    console.error(`    engine=${m.got}  reference=${m.want}`);
    console.error(`  replay log (all ${firstFailure.log.length} ops — checks are probabilistic, so the`);
    console.error(`  responsible op may be well before the failing check):`);
    for (const line of firstFailure.log) console.error(`    ${line}`);
}
process.exit(1);
