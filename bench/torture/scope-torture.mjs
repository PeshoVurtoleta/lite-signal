/**
 * bench/torture/scope-torture.mjs — ownership, adoption and disposal (1.6.0).
 *
 * 1.6.0 adds `createScope` and hardens the disposal path. Both are lifetime
 * machinery, and lifetime bugs are the class a value oracle cannot see: the
 * graph settles on correct values right up until a disposed node is read, a
 * survivor is reaped, or a re-tracking cursor walks a freed link and crashes.
 *
 * This file targets exactly those, in three registers:
 *
 *   1. The 1.6.0 crash repro, fuzzed. The changelog fix is for disposing a
 *      source from inside an observer that linked it on the PREVIOUS run but has
 *      not re-read it on the CURRENT one — the cursor is parked on a link that
 *      disposal frees, and `severTail` then walks from freed memory. The exact
 *      repro is one scenario; a randomised generator that disposes live,
 *      linked-but-unread sources mid-flush is the rest, because an off-by-one in
 *      the cursor repair would survive the single hand-written case.
 *
 *   2. The `createScope` adoption contract, which is precise and load-bearing
 *      for the keyed-list / scene reconcilers it exists for: computeds and
 *      effects created in the scope are adopted and torn down by the single
 *      disposer; plain signals are NOT (the 1.2.0 ownership rule); the scope
 *      SURVIVES a re-run of the consumer effect that created it; and the owner
 *      counts as exactly one effect node so the `signals + computeds + effects
 *      === activeNodes` invariant holds.
 *
 *   3. Pool accounting under churn. A scope disposer that leaked one link per
 *      teardown, or double-freed one node, is invisible to every value and
 *      wakeup oracle — it shows up only as a pool that does not return to
 *      baseline. This uses a HARD-ceiling registry, because a growable pool
 *      turns a leak into an invisible bleed.
 *
 * Skips cleanly on engines without `createScope` (pre-1.6.0).
 *
 * Exit code: 0 iff disposal never crashed, adoption held, and the pool balanced.
 *
 * Usage: node --expose-gc bench/torture/scope-torture.mjs
 *        SCOPE_SEEDS=2000 node --expose-gc bench/torture/scope-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, soakRegistry, fixedRegistry, createReport } from "./helpers/index.mjs";

const { createRegistry, setDefaultRegistry } = Signal;
const createScope = Signal.createScope;

if (typeof createScope !== "function") {
    console.log("lite-signal scope torture — SKIP: createScope requires 1.6.0+");
    process.exit(0);
}

const SEEDS = Number(process.env.SCOPE_SEEDS || 300);
const R = createReport(`lite-signal scope torture — ownership + disposal, ${SEEDS} seeds`);

/* ── 1. The 1.6.0 disposal crash, exact repro ─────────────────────────────── */
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

/* ── 2. Fuzzed disposal-during-retracking ─────────────────────────────────── */

function disposalFuzz(seed) {
    const rnd = mulberry32(seed);
    const r = soakRegistry(createRegistry);

    // A pool of sources, and an observer whose dependency set changes every run
    // so that on any given run some sources are "linked last time, not read yet".
    const N = 12;
    const sources = Array.from({ length: N }, (_, i) => r.signal(i));
    const alive = new Array(N).fill(true);
    const gate = r.signal(0);
    let threw = null;

    try {
        r.effect(function () {
            const pick = gate() % N;
            // Read a rotating subset -> the complement is linked-from-before-but-unread.
            for (let k = 0; k < N; k++) {
                if (!alive[k]) continue;
                if (((k + pick) % 3) === 0) sources[k]();
            }
            // Occasionally dispose one of the CURRENTLY-unread-but-previously-linked
            // sources from inside the very observer that holds the parked cursor.
            if (gate() > 0) {
                const victim = (pick + 1) % N;
                if (alive[victim]) { r.dispose(sources[victim]); alive[victim] = false; }
            }
        });

        for (let step = 1; step <= 30; step++) {
            gate.set(step);
            // Also churn: write a random surviving source.
            const w = randInt(rnd, N);
            if (alive[w]) sources[w].set(step * 100 + w);
        }
    } catch (err) {
        threw = err;
    }
    return threw;
}

let fuzzCrashes = 0;
let firstCrash = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    const err = disposalFuzz(seed);
    if (err !== null) {
        fuzzCrashes++;
        if (firstCrash === null) firstCrash = { seed, err };
    }
}
if (fuzzCrashes > 0) {
    R.fail("disposal-fuzz",
        `${fuzzCrashes}/${SEEDS} seeds crashed disposing linked-but-unread sources mid-flush; ` +
        `first at seed ${firstCrash.seed}: ${firstCrash.err.message}`);
}

/* ── 3. createScope adoption contract ─────────────────────────────────────── */
{
    const r = soakRegistry(createRegistry);
    const base = r.stats().activeNodes;

    let effectRuns = 0;
    const dispose = r.createScope(function (d) {
        r.signal(0);                              // NOT adopted (plain signal)
        const c = r.computed(function () { return 1; });
        r.effect(function () { c(); effectRuns++; });
        return d;
    });

    const peak = r.stats().activeNodes - base;
    R.eq("adoption", peak, 4, "scope should hold signal + computed + effect + owner = 4 nodes");

    dispose();
    const after = r.stats().activeNodes - base;
    // The plain signal is orphaned (created directly, not adopted); everything
    // else — computed, effect, owner — is reaped.
    R.eq("adoption", after, 1, "dispose should reap the adopted computed, effect and owner, leaving only the orphan signal");
}

/* ── 4. The signals + computeds + effects === activeNodes invariant ───────── */
{
    const r = soakRegistry(createRegistry);
    const disposers = [];
    for (let i = 0; i < 50; i++) {
        disposers.push(r.createScope(function (d) {
            r.computed(function () { return i; });
            r.effect(function () {});
            return d;
        }));
    }
    const st = r.stats();
    R.eq("node-invariant", st.signals + st.computeds + st.effects, st.activeNodes,
        "the scope owner broke the signals+computeds+effects === activeNodes accounting");
    for (const d of disposers) d();
}

/* ── 5. A scope survives its creating consumer's re-run ───────────────────── */
{
    // The reconciler-critical property: a scope created inside an effect must
    // NOT be torn down when that effect re-runs. Otherwise a keyed list would
    // destroy and rebuild every row's subtree on every parent update.
    const r = soakRegistry(createRegistry);
    const trigger = r.signal(0);
    let innerRuns = 0;
    let scopeDisposer = null;
    const inner = r.signal(0);

    const consumer = r.effect(function () {
        trigger();
        if (scopeDisposer === null) {
            scopeDisposer = r.createScope(function (d) {
                r.effect(function () { inner(); innerRuns++; });
                return d;
            });
        }
    });

    const afterCreate = innerRuns;
    trigger.set(1);
    trigger.set(2);
    R.eq("scope-survival", innerRuns, afterCreate,
        "re-running the consumer re-ran or duplicated the adopted subtree");

    // The adopted effect is still live and still reacts to its own dependency.
    inner.set(99);
    R.ok("scope-survival", innerRuns > afterCreate, "the scope's effect stopped reacting after the consumer re-ran");

    scopeDisposer();
    const settled = innerRuns;
    inner.set(100);
    R.eq("scope-survival", innerRuns, settled, "the scope's effect ran after the scope was disposed");
    consumer();
}

/* ── 6. A scope created inside a scope is detached, not adopted ────────────── */
{
    // This is the SAME detach guarantee that lets a scope survive its consumer's
    // re-run, applied one level up: a scope is never adopted by an enclosing
    // scope. Its own disposer owns its lifetime. (An earlier draft asserted the
    // opposite — that the outer disposer should cascade into the inner scope —
    // which contradicts the documented contract.)
    const r = soakRegistry(createRegistry);
    const base = r.stats().activeNodes;
    let innerDisposer = null;

    const outer = r.createScope(function (d) {
        r.effect(function () {});                   // adopted by `outer`
        innerDisposer = r.createScope(function (d2) {
            r.effect(function () {});               // adopted by the INNER scope
            r.computed(function () { return 1; });
            return d2;
        });
        return d;
    });

    const peak = r.stats().activeNodes - base;
    outer();                                        // tears down only outer's own children
    const afterOuter = r.stats().activeNodes - base;
    R.ok("nested-detach", afterOuter > 0, "the inner scope was adopted by the outer — detach guarantee broken");
    R.ok("nested-detach", afterOuter < peak, "disposing the outer scope freed none of its own children");

    innerDisposer();                                // the inner scope's own disposer
    R.eq("nested-detach", r.stats().activeNodes - base, 0, "the inner disposer did not reap the inner subtree");

    let threw = null;
    try { outer(); innerDisposer(); } catch (err) { threw = err; }
    R.ok("nested-detach", threw === null, `a repeated dispose threw: ${threw && threw.message}`);
}

/* ── 7. Pool balance under scope churn (HARD ceiling) ─────────────────────── */

function churnPool() {
    // Fixed ceiling: a growable pool would hide a per-teardown link leak as an
    // invisible bleed instead of failing.
    const r = fixedRegistry(createRegistry, 4096, 16384);
    const prev = Signal.setDefaultRegistry ? null : null;   // registry is explicit; no global swap
    const base = r.stats();

    let threw = null;
    try {
        for (let round = 0; round < 200; round++) {
            const d = r.createScope(function (dispose) {
                const sig = r.signal(round);
                const a = r.computed(function () { return sig() * 2; });
                const b = r.computed(function () { return a() + 1; });
                r.effect(function () { b(); });
                r.effect(function () { a(); });
                return dispose;
            });
            d();
            // The orphaned plain signals accumulate by design; nodes we adopted
            // must come back every round.
        }
    } catch (err) {
        threw = err;
    }

    const end = r.stats();
    return { threw, base, end };
}

{
    const { threw, base, end } = churnPool();
    R.ok("pool-churn", threw === null,
        `scope churn exhausted a fixed pool — a teardown is leaking: ${threw && threw.message}`);
    // activeLinks must return to baseline: every link a scope built, it freed.
    R.eq("pool-churn", end.activeLinks, base.activeLinks,
        `activeLinks climbed from ${base.activeLinks} to ${end.activeLinks} over 200 scope rounds — leaked links`);
}

/* ── 8. runWithOwner re-attachment adopts into the scope owner ─────────────── */
if (typeof Signal.runWithOwner === "function" && typeof Signal.getOwner === "function") {
    const r = soakRegistry(createRegistry);
    let threw = null;
    let ranReattached = 0;
    try {
        // CRITICAL: getOwner / runWithOwner MUST be called as registry methods
        // (r.getOwner / r.runWithOwner), matching the registry that owns the
        // scope. The module-level Signal.getOwner() reads the DEFAULT registry's
        // current owner, which — since the scope lives in `r`, not the default —
        // is undefined; runWithOwner(undefined, fn) then runs `fn` ROOTED (a null
        // handle degrades to rooted execution, per the documented contract), so
        // the effect attaches to nothing and the scope disposer cannot reap it.
        // An earlier draft made exactly this mistake and misread the resulting
        // orphan as the engine failing to reap — it was the test using the wrong
        // registry. Pinned here so the correct behaviour stays asserted.
        let capturedOwner = null;
        const dispose = r.createScope(function (d) {
            capturedOwner = r.getOwner();
            return d;
        });
        R.ok("runWithOwner", capturedOwner !== undefined && capturedOwner !== null,
            "r.getOwner() inside a scope returned no owner handle");

        const inner = r.signal(0);
        r.runWithOwner(capturedOwner, function () {
            r.effect(function () { inner(); ranReattached++; });
        });
        const afterAttach = ranReattached;
        R.ok("runWithOwner", afterAttach > 0, "the re-attached effect never ran on creation");

        inner.set(1);
        R.ok("runWithOwner", ranReattached > afterAttach, "a re-attached effect did not react to its dependency");

        // The contract, now asserted rather than merely observed: disposing the
        // scope reaps an effect that was runWithOwner-attached to the scope owner.
        const settled = ranReattached;
        dispose();
        inner.set(2);
        R.eq("runWithOwner", ranReattached, settled,
            "an effect attached via runWithOwner survived its owner's disposal");
    } catch (err) { threw = err; }
    R.ok("runWithOwner", threw === null, `runWithOwner re-attachment threw: ${threw && threw.message}`);
} else {
    R.note("runWithOwner/getOwner not both present — re-attachment scenario skipped");
}

/* ── 8b. The registry-mismatch footgun is real and must degrade safely ────── */
if (typeof Signal.runWithOwner === "function" && typeof Signal.getOwner === "function") {
    // The mistake above, made deliberately: capture the owner via the WRONG
    // registry (the module default) and confirm it degrades to rooted execution
    // — no crash, no adoption — rather than corrupting either registry. This is
    // the safety net that made the earlier confusion merely a wrong test rather
    // than a crash.
    const r = soakRegistry(createRegistry);
    let threw = null;
    let ran = 0;
    try {
        let wrongOwner = null;
        const dispose = r.createScope(function (d) {
            wrongOwner = Signal.getOwner();   // DEFAULT registry — mismatched on purpose
            return d;
        });
        R.eq("mismatch-safety", wrongOwner, undefined,
            "Signal.getOwner() returned an owner for a scope that belongs to another registry");
        const inner = r.signal(0);
        r.runWithOwner(wrongOwner, function () {
            r.effect(function () { inner(); ran++; });
        });
        inner.set(1);
        R.ok("mismatch-safety", ran >= 1, "the rooted effect never ran");
        dispose();               // must not crash even though nothing was adopted
    } catch (err) { threw = err; }
    R.ok("mismatch-safety", threw === null, `a mismatched-registry owner handle crashed: ${threw && threw.message}`);
}

R.note(`${SEEDS} disposal-fuzz seeds + createScope adoption/survival/churn contracts`);
process.exit(R.finish("disposal never crashed, adoption held, and the pool balanced"));
