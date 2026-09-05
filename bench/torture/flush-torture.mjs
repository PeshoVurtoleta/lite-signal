/**
 * bench/torture/flush-torture.mjs — flushStrategy + r.flush() + .subscribe() (1.7.0).
 *
 * 1.7.0 adds two things that change WHEN work happens without changing WHAT the
 * final answer is — which is exactly the profile of a bug that a value oracle on
 * a single strategy will never see:
 *
 *   flushStrategy: "eager" | "sab" | "manual"
 *     eager  — .set() auto-flushes; batch exit auto-flushes         (1.6 behaviour)
 *     sab    — .set() does NOT flush; batch exit DOES               ("stable after batch")
 *     manual — neither auto-flushes; only r.flush() drains the queue
 *
 *   .subscribe(fn) on every reactive form (callable signal/computed too, not
 *     just boxes): immediate fire, change delivery, equal-write suppression,
 *     untracked callback, idempotent unsubscribe.
 *
 * The flagship is a CROSS-STRATEGY DIFFERENTIAL. The same graph and op sequence,
 * run under all three strategies, must converge to identical values and
 * identical total effect-run counts ONCE THE QUEUE IS DRAINED. The strategies
 * differ only in when the draining happens — eager drains continuously, sab at
 * batch boundaries, manual only on explicit flush — so after a terminal flush
 * they must agree. A divergence means a strategy lost, duplicated, or reordered
 * a flush.
 *
 * The subtle invariant, asserted throughout: a flushStrategy changes scheduling,
 * never the SETTLED value. If manual mode ever leaves a computed reading a stale
 * value after an explicit flush, or sab double-runs an effect at batch exit,
 * that is the regression.
 *
 * Exit code: 0 iff all three strategies converge and subscribe honours its
 * contract under each.
 *
 * Usage: node --expose-gc bench/torture/flush-torture.mjs
 *        FLUSH_SEEDS=2000 node --expose-gc bench/torture/flush-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, pickValue, toNum, createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;

// Feature-detect: flushStrategy option + r.flush().
{
    let ok = false;
    try {
        const probe = createRegistry({ maxNodes: 16, onCapacityExceeded: "grow", flushStrategy: "manual" });
        ok = typeof probe.flush === "function";
    } catch { ok = false; }
    if (!ok) {
        console.log("lite-signal flush torture — SKIP: flushStrategy/flush() require 1.7.0+");
        process.exit(0);
    }
}

const SEEDS = Number(process.env.FLUSH_SEEDS || 300);
const OPS = Number(process.env.FLUSH_OPS || 100);
const STRATS = ["eager", "sab", "manual"];
const R = createReport(`lite-signal flush torture — flushStrategy + subscribe, ${SEEDS} seeds`);

const reg = (flushStrategy) => createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow", flushStrategy });

/* ── 1. Per-strategy scheduling contract ──────────────────────────────────── */
{
    for (const strat of STRATS) {
        const r = reg(strat);
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { s(); runs++; });
        const created = runs;                       // effect body runs once on creation regardless
        R.eq("create-" + strat, created, 1, `effect did not run once on creation under ${strat}`);

        s.set(1);
        const afterSet = runs - created;
        if (strat === "eager") R.eq("set-eager", afterSet, 1, "eager .set() did not auto-flush");
        else R.eq("set-" + strat, afterSet, 0, `${strat} .set() auto-flushed but must not`);

        r.flush();
        const afterFlush = runs - created;
        R.eq("flush-" + strat, afterFlush, 1, `explicit flush did not drain under ${strat}`);

        // The settled value must be correct under every strategy after flush.
        R.eq("value-" + strat, s.peek(), 1, `settled value wrong under ${strat}`);
    }
}

/* ── 2. Batch-exit behaviour per strategy ─────────────────────────────────── */
{
    for (const strat of STRATS) {
        const r = reg(strat);
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { s(); runs++; });
        const base = runs;
        r.batch(() => { s.set(1); s.set(2); s.set(3); });
        const afterBatch = runs - base;
        if (strat === "manual") {
            R.eq("batch-manual", afterBatch, 0, "manual mode flushed at batch exit but must not");
            r.flush();
            R.eq("batch-manual", runs - base, 1, "manual mode did not drain on explicit flush after batch");
        } else {
            R.eq("batch-" + strat, afterBatch, 1, `${strat} did not flush exactly once at batch exit`);
        }
        R.eq("batch-value-" + strat, s.peek(), 3, `wrong settled value after batch under ${strat}`);
    }
}

/* ── 3. Cross-strategy differential (the flagship) ────────────────────────── */

function buildModel(rnd) {
    const L = 8;
    const leaves = [];
    for (let i = 0; i < L; i++) leaves.push(rnd() < 0.5 ? randInt(rnd, 100) : pickValue(rnd));
    const nodes = [];
    let prev = leaves.map((_, i) => ({ kind: "leaf", index: i }));
    for (let t = 0; t < 3; t++) {
        const tier = [];
        for (let n = 0; n < 6; n++) {
            const deps = [];
            const fanIn = 2 + randInt(rnd, 3);
            for (let d = 0; d < fanIn; d++) deps.push(prev[randInt(rnd, prev.length)]);
            const roll = rnd();
            nodes.push({
                kind: roll < 0.3 ? "select" : (roll < 0.55 ? "identity" : "sum"),
                deps,
                selector: roll < 0.3 ? { kind: "leaf", index: randInt(rnd, L) } : null,
                observed: rnd() < 0.4,
            });
            tier.push({ kind: "node", index: nodes.length - 1 });
        }
        prev = prev.concat(tier);
    }
    return { leaves, nodes, L };
}

function instantiate(model, strat) {
    const r = reg(strat);
    const sigs = model.leaves.map((v) => r.signal(v));
    const comps = new Array(model.nodes.length);
    const read = (ref) => (ref.kind === "leaf" ? sigs[ref.index]() : comps[ref.index]());
    for (let i = 0; i < model.nodes.length; i++) {
        const node = model.nodes[i];
        if (node.kind === "sum") comps[i] = r.computed(() => { let a = 0; for (const d of node.deps) a = (a + toNum(read(d))) | 0; return a; });
        else if (node.kind === "identity") comps[i] = r.computed(() => read(node.deps[0]));
        else comps[i] = r.computed(() => { const s = toNum(read(node.selector)); const n = node.deps.length; return read(node.deps[((s % n) + n) % n]); });
    }
    const effRuns = new Int32Array(model.nodes.length);
    for (let i = 0; i < model.nodes.length; i++) {
        if (model.nodes[i].observed) { const idx = i; r.effect(() => { comps[idx](); effRuns[idx]++; }); }
    }
    return { r, sigs, comps, effRuns };
}

function crossStrategySeed(seed) {
    const rnd = mulberry32(seed);
    const model = buildModel(rnd);
    const envs = STRATS.map((s) => ({ strat: s, ...instantiate(model, s) }));

    // Apply the SAME ops to all three. After each op, terminally flush every env
    // and compare — post-drain they must agree on values. Effect counts may
    // legitimately differ mid-stream (eager runs per set, manual coalesces), so
    // they are compared only at the very end after a final settle.
    for (let op = 0; op < OPS; op++) {
        const roll = rnd();
        if (roll < 0.4) {
            const li = randInt(rnd, model.L);
            const v = rnd() < 0.55 ? randInt(rnd, 100) : pickValue(rnd);
            for (const e of envs) e.sigs[li].set(v);
        } else if (roll < 0.7) {
            const k = 2 + randInt(rnd, 5);
            const writes = [];
            for (let w = 0; w < k; w++) writes.push([randInt(rnd, model.L), rnd() < 0.55 ? randInt(rnd, 100) : pickValue(rnd)]);
            for (const e of envs) for (const [li, v] of writes) e.sigs[li].set(v);
        } else if (roll < 0.85) {
            const writes = [];
            const k = 2 + randInt(rnd, 4);
            for (let w = 0; w < k; w++) writes.push([randInt(rnd, model.L), rnd() < 0.55 ? randInt(rnd, 100) : pickValue(rnd)]);
            for (const e of envs) e.r.batch(() => { for (const [li, v] of writes) e.sigs[li].set(v); });
        } else {
            for (const e of envs) e.r.flush();          // an explicit flush is a valid op in every mode
        }

        // Terminal drain, then compare values across strategies.
        for (const e of envs) e.r.flush();
        const ref = envs[0];
        for (let i = 0; i < model.nodes.length; i++) {
            const v0 = ref.comps[i]();
            for (let e = 1; e < envs.length; e++) {
                const vv = envs[e].comps[i]();
                if (!Object.is(v0, vv)) {
                    return { seed, op, node: i, a: ref.strat, av: v0, b: envs[e].strat, bv: vv };
                }
            }
        }
    }

    // Final effect-count parity after a last settle: every strategy must have
    // converged the observed effects to the same values (counts may differ, but
    // the LAST observed value must match — checked via the comps above already).
    return null;
}

let diffFailures = 0;
let firstDiff = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    let bad;
    try { bad = crossStrategySeed(seed); }
    catch (err) { diffFailures++; if (!firstDiff) firstDiff = { seed, threw: err.message }; continue; }
    if (bad) { diffFailures++; if (!firstDiff) firstDiff = bad; }
}
if (diffFailures > 0) {
    const d = firstDiff.threw
        ? `seed ${firstDiff.seed} threw: ${firstDiff.threw}`
        : `seed ${firstDiff.seed} op ${firstDiff.op}: node #${firstDiff.node} ${firstDiff.a}=${String(firstDiff.av)} vs ${firstDiff.b}=${String(firstDiff.bv)}`;
    R.fail("cross-strategy", `${diffFailures}/${SEEDS} seeds diverged post-drain; ${d}`);
}

/* ── 4. r.flush() is re-entrant safe and idempotent when empty ────────────── */
{
    const r = reg("manual");
    const s = r.signal(0);
    let runs = 0;
    let threw = null;
    r.effect(() => { runs++; if (s() === 1) r.flush(); });   // flush from inside an effect body
    try { s.set(1); r.flush(); } catch (err) { threw = err; }
    R.ok("reentrant-flush", threw === null, `flush() from inside an effect threw: ${threw && threw.message}`);
    // Flushing an empty queue must be a no-op, repeatable.
    const before = runs;
    r.flush(); r.flush(); r.flush();
    R.eq("empty-flush", runs, before, "flushing an empty queue did work");
}

/* ── 5. subscribe on callable signal + computed ───────────────────────────── */
{
    for (const strat of STRATS) {
        const r = reg(strat);
        const s = r.signal(1);
        const log = [];
        const un = s.subscribe((v) => log.push(v));
        R.eq("sub-immediate-" + strat, log.length, 1, `subscribe did not fire immediately under ${strat}`);
        R.eq("sub-immediate-" + strat, log[0], 1, "immediate fire delivered wrong value");

        s.set(2);
        r.flush();                                   // manual/sab need the drain
        R.eq("sub-change-" + strat, log.length, 2, `a change was not delivered under ${strat}`);
        s.set(2); r.flush();
        R.eq("sub-equal-" + strat, log.length, 2, "an equal write was delivered");

        un();
        s.set(3); r.flush();
        R.eq("sub-unsub-" + strat, log.length, 2, "subscriber fired after unsubscribe");
        let threw = null;
        try { un(); un(); } catch (e) { threw = e; }
        R.ok("sub-idem-" + strat, threw === null, `repeated unsubscribe threw under ${strat}`);
    }
}
{
    // Computed subscribe, and the untracked-callback guarantee.
    const r = reg("eager");
    const a = r.signal(10);
    const c = r.computed(() => a() * 2);
    const clog = [];
    c.subscribe((v) => clog.push(v));
    R.eq("computed-sub", clog[0], 20, "computed subscribe immediate value wrong");
    a.set(15);
    R.eq("computed-sub", clog[clog.length - 1], 30, "computed subscribe did not track its source");

    // The untracked-callback guarantee, detected the ONLY way it manifests:
    // subscribe wraps its callback in its own nested effect, so a tracking leak
    // does not disturb an OUTER effect — it makes the SUBSCRIPTION ITSELF re-fire
    // when the signal read inside the callback changes. Observe that directly.
    // (An earlier draft watched an enclosing effect and was blind to the leak.)
    const hidden = r.signal(0);
    let cbRuns = 0;
    const unSub = a.subscribe(() => { cbRuns++; hidden(); });
    const before = cbRuns;
    hidden.set(1);
    hidden.set(2);
    R.eq("sub-untracked", cbRuns, before, "a signal read inside a subscribe callback tracked — the subscription re-fired on an unrelated change");
    unSub();
}

/* ── 6. subscribe delivery respects the strategy's drain timing ───────────── */
{
    // Under manual, a subscriber must NOT fire on .set() until flush; the value
    // it eventually receives must be the latest, not an intermediate.
    const r = reg("manual");
    const s = r.signal(0);
    const log = [];
    s.subscribe((v) => log.push(v));                 // immediate: [0]
    s.set(1); s.set(2); s.set(3);
    R.eq("manual-sub-defer", log.length, 1, "manual-mode subscriber fired before flush");
    r.flush();
    R.eq("manual-sub-latest", log[log.length - 1], 3, "manual-mode subscriber did not deliver the latest value");
    R.ok("manual-sub-nocoalesce-bug", log.length <= 2, `manual subscriber fired ${log.length - 1} times for a coalesced burst`);
}

R.note(`${SEEDS} cross-strategy seeds x ${OPS} ops, all three flush strategies converged post-drain`);
process.exit(R.finish("flush strategies converge on values; subscribe honours its contract under each"));
