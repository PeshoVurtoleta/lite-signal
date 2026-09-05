/**
 * bench/torture/glitch-hunter.mjs — glitch freedom + wakeup accounting.
 *
 * oracle-fuzzer.mjs proves the engine SETTLES on the right values. That is not
 * the whole contract. Two failure modes survive a perfect value oracle:
 *
 *   GLITCHES — a transiently inconsistent read. In a diamond (s -> a, s -> b,
 *   {a,b} -> c) a naive engine can run `c` after `a` has been recomputed but
 *   before `b` has, so `c` briefly observes two different epochs of the same
 *   source. The final value is still correct once everything settles, so a
 *   settled-value oracle never sees it — but any effect that WROTE somewhere
 *   during that window (a DOM node, a log, a network call) already acted on a
 *   state that never logically existed.
 *
 *   SPURIOUS WAKEUPS — an effect re-running when nothing it reads has changed.
 *   Values stay correct, so again the oracle is blind; the cost is silent
 *   wasted work, and the usual cause is a dependency the engine failed to
 *   unsubscribe when a branch stopped being read. On a big graph that is the
 *   difference between O(changed) and O(everything).
 *
 * Both are checked here by instrumenting values with an epoch stamp and by
 * counting runs exactly, rather than by comparing settled output.
 *
 * Exit code: 0 iff no glitch was observed and every wakeup count was exact.
 *
 * Usage:
 *   node --expose-gc bench/torture/glitch-hunter.mjs
 *   GLITCH_SEEDS=2000 node --expose-gc bench/torture/glitch-hunter.mjs
 */

import { performance } from "node:perf_hooks";
import { createRegistry } from "../../Signal.js";
import { mulberry32 } from "./helpers/index.mjs";

const SEEDS = Number(process.env.GLITCH_SEEDS || 300);

const failures = [];
const fail = (name, detail) => failures.push({ name, detail });

/* ── 1. Glitch freedom on randomised diamonds ─────────────────────────────────
 *
 * Every leaf carries {epoch, v}. A batch bumps the epoch once and rewrites some
 * subset of leaves. Any derived node that observes two different epochs among
 * its inputs has caught the engine mid-propagation.
 */

function glitchSeed(seed) {
    const rnd = mulberry32(seed);
    const r = createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow" });

    const LEAVES = 6;
    let epoch = 1;
    const leaves = [];
    for (let i = 0; i < LEAVES; i++) leaves.push(r.signal({ epoch, v: i }));

    const observed = [];
    // A node whose inputs must always agree on epoch.
    const mkJoin = (deps) => r.computed(function () {
        let e = -1;
        let sum = 0;
        for (let i = 0; i < deps.length; i++) {
            const cell = deps[i]();
            if (e === -1) e = cell.epoch;
            else if (cell.epoch !== e) observed.push({ kind: "computed", saw: [e, cell.epoch] });
            sum = (sum + cell.v) | 0;
        }
        return { epoch: e, v: sum };
    });

    // Two tiers of joins over overlapping subsets -> genuine diamonds.
    const tier1 = [];
    for (let i = 0; i < 5; i++) {
        const deps = [];
        const n = 2 + ((rnd() * 3) | 0);
        for (let d = 0; d < n; d++) deps.push(leaves[(rnd() * LEAVES) | 0]);
        tier1.push(mkJoin(deps));
    }
    const tier2 = [];
    for (let i = 0; i < 4; i++) {
        const deps = [];
        const n = 2 + ((rnd() * 3) | 0);
        for (let d = 0; d < n; d++) deps.push(rnd() < 0.5 ? tier1[(rnd() * tier1.length) | 0] : leaves[(rnd() * LEAVES) | 0]);
        tier2.push(mkJoin(deps));
    }

    // Effects observe the same invariant from the push side.
    const stops = [];
    for (let i = 0; i < 4; i++) {
        const a = tier2[(rnd() * tier2.length) | 0];
        const b = tier1[(rnd() * tier1.length) | 0];
        stops.push(r.effect(function () {
            const x = a();
            const y = b();
            if (x.epoch !== y.epoch) observed.push({ kind: "effect", saw: [x.epoch, y.epoch] });
        }));
    }

    for (let op = 0; op < 40; op++) {
        // EVERY leaf moves to the new epoch inside one batch. An earlier draft
        // wrote a random subset, which meant an untouched leaf legitimately still
        // carried the previous epoch -- so a join reading one written and one
        // untouched leaf reported a "glitch" that was nothing of the kind. With
        // the whole frontier advanced atomically, any epoch disagreement an
        // observer sees can only be the engine caught mid-propagation.
        epoch++;
        r.batch(function () {
            for (let li = 0; li < LEAVES; li++) leaves[li].set({ epoch, v: (rnd() * 100) | 0 });
        });
        // Pull everything so lazily-evaluated nodes are forced to run too.
        for (const c of tier2) c();
        for (const c of tier1) c();
    }

    for (const s of stops) s();
    return observed;
}

/* ── 2. Wakeup accounting ─────────────────────────────────────────────────── */

function wakeupChecks() {
    const r = createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow" });

    // (a) An abandoned branch must be unsubscribed.
    {
        const cond = r.signal(true);
        const a = r.signal(1);
        const b = r.signal(2);
        let runs = 0;
        const stop = r.effect(function () { runs++; cond() ? a() : b(); });
        const afterInit = runs;
        b.set(99);                       // not read while cond is true
        if (runs !== afterInit) fail("dynamic-deps", `writing the unread branch woke the effect (${runs - afterInit} extra)`);
        cond.set(false);                 // now b is read, a is not
        const afterFlip = runs;
        a.set(50);                       // a is now the abandoned branch
        if (runs !== afterFlip) {
            fail("dynamic-deps", `after switching branches the OLD dependency still wakes the effect (${runs - afterFlip} extra)`);
        }
        b.set(100);                      // the live branch must still wake it
        if (runs !== afterFlip + 1) fail("dynamic-deps", `the live branch did not wake the effect exactly once`);
        stop();
    }

    // (b) One batch with many writes = at most one effect run.
    {
        const sigs = Array.from({ length: 8 }, (_, i) => r.signal(i));
        let runs = 0;
        const stop = r.effect(function () { runs++; for (const s of sigs) s(); });
        const base = runs;
        r.batch(function () { for (let i = 0; i < sigs.length; i++) sigs[i].set(i + 100); });
        if (runs !== base + 1) fail("batch-coalescing", `8 writes in one batch produced ${runs - base} runs, expected 1`);
        stop();
    }

    // (c) A no-op write must not wake anything.
    {
        const s = r.signal(7);
        let runs = 0;
        const stop = r.effect(function () { runs++; s(); });
        const base = runs;
        s.set(7);
        if (runs !== base) fail("no-op write", `rewriting the same value woke the effect ${runs - base} time(s)`);
        stop();
    }

    // (d) A diamond must wake its sink exactly once per source change.
    {
        const src = r.signal(1);
        const a = r.computed(function () { return src() * 2; });
        const b = r.computed(function () { return src() + 1; });
        let runs = 0;
        const stop = r.effect(function () { runs++; a(); b(); });
        const base = runs;
        src.set(2);
        if (runs !== base + 1) fail("diamond", `one source write produced ${runs - base} sink runs, expected 1`);
        stop();
    }

    // (e) untrack must not create a subscription.
    {
        const tracked = r.signal(1);
        const hidden = r.signal(1);
        let runs = 0;
        const stop = r.effect(function () { runs++; tracked(); r.untrack(function () { hidden(); }); });
        const base = runs;
        hidden.set(2);
        if (runs !== base) fail("untrack", `an untracked read still subscribed (${runs - base} extra runs)`);
        stop();
    }

    // (f) onCleanup: exactly once per re-run, before the new body, in reverse order.
    {
        const s = r.signal(0);
        const order = [];
        let cleanupCount = 0;
        const stop = r.effect(function () {
            const v = s();
            order.push("body" + v);
            r.onCleanup(function () { cleanupCount++; order.push("cleanupA" + v); });
            r.onCleanup(function () { order.push("cleanupB" + v); });
        });
        s.set(1);
        s.set(2);
        stop();
        // Each re-run must be preceded by exactly one cleanup pass of the prior run.
        const bodies = order.filter((x) => x.startsWith("body")).length;
        if (cleanupCount !== bodies) {
            fail("onCleanup", `${bodies} body runs but ${cleanupCount} cleanup passes`);
        }
        const firstA = order.indexOf("cleanupA0");
        // Intra-node order is REGISTRATION order (Signal.js iterates the cleanup
        // list forward). That is not documented as a guarantee, so this is a pin,
        // not a requirement: if it ever changes, this fires and the change gets
        // made deliberately instead of by accident. Note it differs from Solid,
        // where cleanups unwind LIFO -- worth stating in llms.txt either way.
        const firstB = order.indexOf("cleanupB0");
        if (firstA !== -1 && firstB !== -1 && firstA > firstB) {
            fail("onCleanup", `intra-node cleanup order changed from registration order to LIFO`);
        }
        if (firstA !== -1 && order.indexOf("body1") < firstA) {
            fail("onCleanup", `the new body ran before the previous run's cleanup`);
        }
    }

    // (h) Nested cleanups cascade deepest-first. THIS one is a documented
    // guarantee (Signal.js: "grandchild -> child -> outer", #238/#241/#243).
    {
        const s = r.signal(0);
        const order = [];
        const stop = r.effect(function () {
            s();
            r.onCleanup(function () { order.push("outer"); });
            r.effect(function () {
                r.onCleanup(function () { order.push("child"); });
                r.effect(function () {
                    r.onCleanup(function () { order.push("grandchild"); });
                });
            });
        });
        order.length = 0;
        stop();
        const gi = order.indexOf("grandchild");
        const ci = order.indexOf("child");
        const oi = order.indexOf("outer");
        if (gi === -1 || ci === -1 || oi === -1) {
            fail("cleanup-cascade", `a nested cleanup did not fire: ${JSON.stringify(order)}`);
        } else if (!(gi < ci && ci < oi)) {
            fail("cleanup-cascade", `expected grandchild -> child -> outer, got ${order.join(" -> ")}`);
        }
    }

    // (g) A disposed effect must never run again, even if a dep changes.
    {
        const s = r.signal(0);
        let runs = 0;
        const stop = r.effect(function () { runs++; s(); });
        stop();
        const after = runs;
        s.set(1);
        s.set(2);
        if (runs !== after) fail("dispose", `a disposed effect ran ${runs - after} more time(s)`);
    }
}

/* ── driver ───────────────────────────────────────────────────────────────── */

const t0 = performance.now();

let glitches = 0;
let firstGlitch = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    let observed;
    try {
        observed = glitchSeed(seed);
    } catch (err) {
        fail("glitch-seed-" + seed, "threw: " + err.message);
        continue;
    }
    if (observed.length > 0) {
        glitches += observed.length;
        if (firstGlitch === null) firstGlitch = { seed, sample: observed[0] };
    }
}
if (glitches > 0) {
    fail("glitch-freedom",
        `${glitches} inconsistent read(s); first at seed ${firstGlitch.seed} in a ${firstGlitch.sample.kind}, ` +
        `observing epochs ${firstGlitch.sample.saw.join(" and ")}`);
}

try {
    wakeupChecks();
} catch (err) {
    fail("wakeup-checks", "threw: " + err.message);
}

const dt = ((performance.now() - t0) / 1000).toFixed(2);
console.log(`lite-signal glitch hunter — ${SEEDS} diamond seeds + wakeup accounting (${dt}s)`);

if (failures.length === 0) {
    console.log("  PASS: no glitch observed, every wakeup count exact");
    process.exit(0);
}
console.error(`  FAIL: ${failures.length} violation(s)`);
for (const f of failures.slice(0, 10)) console.error(`    [${f.name}] ${f.detail}`);
process.exit(1);
