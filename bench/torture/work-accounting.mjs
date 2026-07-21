/**
 * bench/torture/work-accounting.mjs -- does the engine do the MINIMUM work?
 *
 * The other files in this directory answer "did it crash", "did the pool
 * balance", "is the value right" and "did the right things wake up". One class
 * still slips through all of them: doing the correct thing too many times.
 *
 * Disabling the eval memo in `pullComputed` (a one-line edit) leaves every
 * value correct, every wakeup count correct and the pool perfectly balanced --
 * it just recomputes bodies that did not need recomputing. graph-fuzzer,
 * scheduler-bench, torture-soak, oracle-fuzzer and glitch-hunter are all blind
 * to it. On a wide graph that is the difference between O(changed) and
 * O(everything), which is the entire value proposition of a pull engine with
 * versioned short-circuits.
 *
 * So this file counts BODY EXECUTIONS. Every computed and effect increments a
 * counter, and each scenario asserts an exact expected count derived from the
 * topology, not from a previous run. Exact, not "roughly" -- an upper bound
 * that tracks the implementation is a pin that ratchets, and ratchets rot.
 *
 * Where the minimum is genuinely a judgement call (a diamond may legitimately
 * evaluate its sink once or twice depending on scheduling discipline), the
 * scenario says so and asserts the weaker property it actually relies on.
 *
 * Exit code: 0 iff every scenario did exactly the expected amount of work.
 *
 * Usage: node --expose-gc bench/torture/work-accounting.mjs
 */

import { performance } from "node:perf_hooks";
import { createRegistry } from "../../Signal.js";

const failures = [];
const check = (name, got, want, note) => {
    if (got !== want) failures.push(`[${name}] ${note}: expected ${want} body run(s), got ${got}`);
};

const newRegistry = () => createRegistry({ maxNodes: 8192, maxLinks: 32768, onCapacityExceeded: "grow" });

/* -- 1. An untouched subgraph must not be recomputed ------------------------ */
{
    const r = newRegistry();
    const a = r.signal(1);
    const b = r.signal(1);
    let aRuns = 0;
    let bRuns = 0;
    const ca = r.computed(function () { aRuns++; return a() * 2; });
    const cb = r.computed(function () { bRuns++; return b() * 2; });
    ca(); cb();
    const a0 = aRuns, b0 = bRuns;

    a.set(2);
    ca(); cb();
    check("isolation", aRuns - a0, 1, "writing `a` should recompute only ca");
    check("isolation", bRuns - b0, 0, "writing `a` must not recompute cb");
}

/* -- 2. Re-reading a settled computed is free ------------------------------- */
{
    const r = newRegistry();
    const s = r.signal(1);
    let runs = 0;
    const c = r.computed(function () { runs++; return s() + 1; });
    c();
    const base = runs;
    for (let i = 0; i < 50; i++) c();
    check("read-memo", runs - base, 0, "50 reads with no intervening write");
}

/* -- 3. A write that changes nothing must not recompute downstream ---------- */
{
    const r = newRegistry();
    const s = r.signal(5);
    let runs = 0;
    const c = r.computed(function () { runs++; return s() * 2; });
    c();
    const base = runs;
    s.set(5);
    c();
    check("no-op-write", runs - base, 0, "rewriting the identical value");
}

/* -- 4. An equal-valued computed must not propagate ------------------------- */
{
    // s changes, so `mid` MUST re-run -- but its output is unchanged, so `top`
    // has nothing to react to. Cutting propagation on value equality (not just
    // on dirtiness) is what makes deep chains cheap.
    const r = newRegistry();
    const s = r.signal(2);
    let midRuns = 0;
    let topRuns = 0;
    const mid = r.computed(function () { midRuns++; return s() > 0; });
    const top = r.computed(function () { topRuns++; return mid() ? "yes" : "no"; });
    top();
    const m0 = midRuns, t0 = topRuns;
    s.set(7);                       // still > 0 -> mid's value is unchanged
    top();
    check("equality-cutoff", midRuns - m0, 1, "mid must re-run (its source changed)");
    check("equality-cutoff", topRuns - t0, 0, "top must NOT re-run (its input is unchanged)");
}

/* -- 5. A diamond evaluates each node once per settled change --------------- */
{
    const r = newRegistry();
    const src = r.signal(1);
    let aRuns = 0, bRuns = 0, sinkRuns = 0;
    const a = r.computed(function () { aRuns++; return src() * 2; });
    const b = r.computed(function () { bRuns++; return src() + 10; });
    const sink = r.computed(function () { sinkRuns++; return a() + b(); });
    sink();
    const a0 = aRuns, b0 = bRuns, s0 = sinkRuns;
    src.set(2);
    sink();
    check("diamond", aRuns - a0, 1, "left arm");
    check("diamond", bRuns - b0, 1, "right arm");
    check("diamond", sinkRuns - s0, 1, "sink must evaluate once, not once per arm");
}

/* -- 6. A batch collapses N writes into one pass ---------------------------- */
{
    const r = newRegistry();
    const sigs = Array.from({ length: 10 }, (_, i) => r.signal(i));
    let runs = 0;
    const c = r.computed(function () {
        runs++;
        let acc = 0;
        for (const s of sigs) acc += s();
        return acc;
    });
    c();
    const base = runs;
    r.batch(function () { for (let i = 0; i < sigs.length; i++) sigs[i].set(i + 100); });
    c();
    check("batch", runs - base, 1, "10 writes inside one batch");
}

/* -- 7. Deep chains cost O(depth), not O(depth^2) --------------------------- */
{
    const r = newRegistry();
    const DEPTH = 200;
    const s = r.signal(1);
    const counts = new Array(DEPTH).fill(0);
    let prev = s;
    const chain = [];
    for (let i = 0; i < DEPTH; i++) {
        const idx = i;
        const p = prev;
        const c = r.computed(function () { counts[idx]++; return p() + 1; });
        chain.push(c);
        prev = c;
    }
    chain[DEPTH - 1]();
    const before = counts.reduce((x, y) => x + y, 0);
    s.set(2);
    chain[DEPTH - 1]();
    const total = counts.reduce((x, y) => x + y, 0) - before;
    check("deep-chain", total, DEPTH, `one write through a ${DEPTH}-deep chain`);
}

/* -- 8. A wide fan-out touches only the changed cone ------------------------ */
{
    const r = newRegistry();
    const WIDTH = 100;
    const hot = r.signal(0);
    const cold = r.signal(0);
    let hotRuns = 0, coldRuns = 0;
    const hots = [], colds = [];
    for (let i = 0; i < WIDTH; i++) {
        hots.push(r.computed(function () { hotRuns++; return hot() + i; }));
        colds.push(r.computed(function () { coldRuns++; return cold() + i; }));
    }
    for (const c of hots) c();
    for (const c of colds) c();
    const h0 = hotRuns, c0 = coldRuns;
    hot.set(1);
    for (const c of hots) c();
    for (const c of colds) c();
    check("fan-out", hotRuns - h0, WIDTH, "the changed cone");
    check("fan-out", coldRuns - c0, 0, "the untouched cone must stay cold");
}

/* -- 9. A dynamic branch stops paying for the branch it abandoned ----------- */
{
    const r = newRegistry();
    const cond = r.signal(true);
    const a = r.signal(1);
    const b = r.signal(2);
    let aRuns = 0, bRuns = 0, sinkRuns = 0;
    const ca = r.computed(function () { aRuns++; return a() * 2; });
    const cb = r.computed(function () { bRuns++; return b() * 2; });
    const sink = r.computed(function () { sinkRuns++; return cond() ? ca() : cb(); });
    sink();
    cond.set(false);
    sink();                                   // now reading cb only
    const a0 = aRuns, s0 = sinkRuns;
    a.set(99);                                // the abandoned branch
    sink();
    check("dynamic-branch", aRuns - a0, 0, "writing the abandoned branch must not recompute it");
    check("dynamic-branch", sinkRuns - s0, 0, "...nor wake the sink");
}

/* -- 10. An unobserved computed is not evaluated eagerly -------------------- */
{
    const r = newRegistry();
    const s = r.signal(1);
    let runs = 0;
    r.computed(function () { runs++; return s() * 2; });   // never read
    s.set(2);
    s.set(3);
    check("laziness", runs, 0, "a computed nobody reads must never run");
}

/* -- driver ----------------------------------------------------------------- */

const t0 = performance.now();
const dt = ((performance.now() - t0) / 1000).toFixed(2);
console.log(`lite-signal work accounting -- 10 topologies, exact body-run counts (${dt}s)`);
if (failures.length === 0) {
    console.log("  PASS: every scenario did exactly the minimum work");
    process.exit(0);
}
console.error(`  FAIL: ${failures.length} scenario(s) did the wrong amount of work`);
for (const f of failures) console.error("    " + f);
process.exit(1);
