/**
 * bench/torture/capacity-torture.mjs — the fail-closed boundary.
 *
 * The engine's design law is fail-CLOSED: when a fixed pool is exhausted under
 * the "throw" policy it must throw CapacityError, and — the part that actually
 * matters — it must never let a WRONG value escape as a result. A half-built
 * computed that returns a partial sum would be far worse than a throw, because
 * the caller has no way to know the number is wrong.
 *
 * None of the other torture files runs a registry to exhaustion; they all use
 * `grow`, precisely so they can build big graphs. So the entire "throw" policy —
 * the one that ships as the DEFAULT — is untested by them. This file lives at
 * that boundary:
 *
 *   - the ceiling is exact (N slots means the (N+1)th throws, not the Nth);
 *   - the error is a CapacityError, on both the node pool and the link pool;
 *   - a read of a node whose construction hit the ceiling RE-THROWS rather than
 *     returning a partial value — the fail-closed guarantee at the read edge;
 *   - the registry remains internally consistent: after freeing a slot it can
 *     build and correctly evaluate a new small graph;
 *   - `grow` mode crosses the same boundary without throwing, up to the
 *     documented 16x link ceiling, and produces correct values throughout.
 *
 * A behaviour this file deliberately PINS rather than judges: a "throw" registry
 * does NOT roll back the partial links of the computed that overflowed it, so
 * the pool stays exhausted and subsequent builds also throw. For a fixed-budget
 * sandbox ("you exceeded your budget, you are done") that is defensible, and the
 * read edge stays fail-closed either way. It is pinned so that if it ever
 * CHANGES — to rollback, say — that is a deliberate decision reviewed against
 * this note, not an accident.
 *
 * Exit code: 0 iff the boundary held closed.
 *
 * Usage: node --expose-gc bench/torture/capacity-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { createReport } from "./helpers/index.mjs";

const { createRegistry, CapacityError } = Signal;
const R = createReport("lite-signal capacity torture — the fail-closed boundary");

const isCapacityError = (e) =>
    e instanceof CapacityError || (e && e.constructor && e.constructor.name === "CapacityError");

/* ── 1. The node ceiling is exact ─────────────────────────────────────────── */
{
    const CEIL = 16;
    const r = createRegistry({ maxNodes: CEIL, maxLinks: CEIL * 4, onCapacityExceeded: "throw" });
    const held = [];
    let made = 0;
    let err = null;
    try {
        for (let i = 0; i < CEIL * 4; i++) { held.push(r.signal(i)); made++; }
    } catch (e) { err = e; }
    R.ok("node-ceiling", err !== null, "a fixed node pool never threw");
    R.ok("node-ceiling", isCapacityError(err), `expected CapacityError, got ${err && err.constructor.name}`);
    R.eq("node-ceiling", made, CEIL, `pool of ${CEIL} admitted ${made} nodes before throwing`);
}

/* ── 2. The link ceiling throws too ───────────────────────────────────────── */
{
    const r = createRegistry({ maxNodes: 64, maxLinks: 8, onCapacityExceeded: "throw" });
    const sigs = Array.from({ length: 20 }, (_, i) => r.signal(i));
    let err = null;
    try {
        const c = r.computed(() => sigs.reduce((a, s) => a + s(), 0));
        c();
    } catch (e) { err = e; }
    R.ok("link-ceiling", err !== null, "exhausting the link pool did not throw");
    R.ok("link-ceiling", isCapacityError(err), `expected CapacityError, got ${err && err.constructor.name}`);
}

/* ── 3. A node that hit the ceiling mid-build RE-THROWS on read ────────────── */
{
    // The fail-closed guarantee at the read edge. The computed linked some of
    // its 20 sources before the 8-link pool ran out; reading it must NOT return
    // the partial sum of the sources it managed to link. It must throw.
    const r = createRegistry({ maxNodes: 64, maxLinks: 8, onCapacityExceeded: "throw" });
    const sigs = Array.from({ length: 20 }, (_, i) => r.signal(i + 1));
    let c = null;
    try { c = r.computed(() => sigs.reduce((a, s) => a + s(), 0)); c(); } catch { /* expected */ }

    if (c !== null) {
        let readResult = null;
        let readThrew = null;
        try { readResult = c(); } catch (e) { readThrew = e; }
        R.ok("fail-closed-read", readThrew !== null,
            `a half-built computed returned ${readResult} instead of throwing — a PARTIAL value escaped`);
        R.ok("fail-closed-read", isCapacityError(readThrew),
            `the half-built read threw ${readThrew && readThrew.constructor.name}, expected CapacityError`);
    } else {
        R.note("computed handle was not returned before the throw — read-edge case not reachable this build");
    }
}

/* ── 4. The registry is still consistent after a capacity throw ───────────── */
{
    // Exhaust the NODE pool (not links), free a slot, and confirm a fresh small
    // graph builds and evaluates correctly. A capacity throw must leave the
    // registry usable, not corrupt.
    const r = createRegistry({ maxNodes: 8, maxLinks: 64, onCapacityExceeded: "throw" });
    const held = [];
    try { for (let i = 0; i < 100; i++) held.push(r.signal(i)); } catch { /* expected */ }

    r.dispose(held[0]);
    r.dispose(held[1]);
    r.dispose(held[2]);

    let value = null;
    let threw = null;
    try {
        const a = r.signal(10);
        const b = r.signal(20);
        const c = r.computed(() => a() + b());
        value = c();
    } catch (e) { threw = e; }
    R.ok("post-throw-usable", threw === null, `the registry was unusable after a capacity throw: ${threw && threw.message}`);
    R.eq("post-throw-usable", value, 30, "a computed built after a capacity throw returned the wrong value");
}

/* ── 5. Write propagation survives a capacity throw ───────────────────────── */
{
    const r = createRegistry({ maxNodes: 8, maxLinks: 64, onCapacityExceeded: "throw" });
    const held = [];
    try { for (let i = 0; i < 100; i++) held.push(r.signal(i)); } catch { /* expected */ }
    for (let i = 0; i < 5; i++) r.dispose(held[i]);

    let runs = 0;
    let threw = null;
    try {
        const x = r.signal(1);
        const stop = r.effect(() => { x(); runs++; });
        x.set(2);
        stop();
    } catch (e) { threw = e; }
    R.ok("post-throw-propagation", threw === null, `propagation broke after a capacity throw: ${threw && threw.message}`);
    R.eq("post-throw-propagation", runs, 2, "an effect did not re-run after a capacity throw");
}

/* ── 6. Overflow leaves the pool exhausted (PINNED, not judged) ───────────── */
{
    // Documented expectation for a fixed-budget sandbox: a "throw" registry does
    // not roll back the overflowing computed's partial links, so the pool stays
    // full and the next build also throws. If this ever changes to rollback,
    // this pin fires and the change is reviewed deliberately.
    const r = createRegistry({ maxNodes: 64, maxLinks: 8, onCapacityExceeded: "throw" });
    const sigs = Array.from({ length: 20 }, (_, i) => r.signal(i));
    try { const c = r.computed(() => sigs.reduce((a, s) => a + s(), 0)); c(); } catch { /* expected */ }

    const linksAfter = r.stats().activeLinks;
    R.ok("overflow-no-rollback", linksAfter > 0,
        "the overflowing computed's links were rolled back — behaviour changed from the pinned expectation");
    R.note(`after link overflow, activeLinks stayed at ${linksAfter} (no rollback — pinned; see file header)`);
}

/* ── 7. grow mode crosses the boundary without throwing ───────────────────── */
{
    // The same graph that exhausts a fixed pool must build under "grow", produce
    // correct values, and stay correct as it grows past the initial capacity.
    const r = createRegistry({ maxNodes: 8, maxLinks: 8, onCapacityExceeded: "grow" });
    let value = null;
    let threw = null;
    try {
        const sigs = Array.from({ length: 40 }, (_, i) => r.signal(i));
        const c = r.computed(() => sigs.reduce((a, s) => a + s(), 0));
        value = c();
    } catch (e) { threw = e; }
    R.ok("grow-crosses", threw === null, `grow mode threw crossing its initial capacity: ${threw && threw.message}`);
    R.eq("grow-crosses", value, 40 * 39 / 2, "grow mode produced the wrong sum after growing");
    R.ok("grow-crosses", r.stats().poolGrowths > 0, "grow mode never actually grew — the test did not cross the boundary");
}

/* ── 8. grow correctness under repeated growth ────────────────────────────── */
{
    // Grow across several chunk boundaries and verify propagation is intact the
    // whole way — a growth that dropped a link would surface as a stale read.
    const r = createRegistry({ maxNodes: 8, maxLinks: 8, onCapacityExceeded: "grow" });
    const sigs = [];
    const comps = [];
    let threw = null;
    try {
        for (let i = 0; i < 60; i++) {
            const s = r.signal(i);
            sigs.push(s);
            comps.push(r.computed(() => s() * 2));
        }
        // Read all, mutate all, read all — correctness across the grown pool.
        for (let i = 0; i < comps.length; i++) {
            if (comps[i]() !== i * 2) { threw = new Error(`stale at ${i} before mutation`); break; }
        }
        if (threw === null) {
            for (let i = 0; i < sigs.length; i++) sigs[i].set(i + 1000);
            for (let i = 0; i < comps.length; i++) {
                if (comps[i]() !== (i + 1000) * 2) { threw = new Error(`stale at ${i} after mutation`); break; }
            }
        }
    } catch (e) { threw = e; }
    R.ok("grow-correctness", threw === null, `grow mode lost correctness across growth: ${threw && threw.message}`);
}

/* -- 9. grow mode still has a ceiling: the 16x link limit ------------------- */
{
    // "grow" is not unbounded. Link growth is capped at maxLinks * 16 (confirmed
    // against 1.8.0 Signal.js:285 `const maxLinkLimit = currentLinkCapacity * 16;`
    // and :444 `if (linkPool.length >= maxLinkLimit) throw new CapacityError("links", maxLinkLimit);`).
    // At the ceiling grow becomes a fail-CLOSED throw exactly like "throw" mode: a
    // CapacityError on the link pool, and the read edge re-throws rather than
    // leaking a partial sum. This pins that growth terminates AT the ceiling -- the
    // pool reaches 16x and not one chunk over. Observed on 1.8.0: multiplier 16, so
    // maxLinks 8 -> ceiling 128; no divergence from 1.4.4.
    const MAXLINKS = 8;
    const CEIL = MAXLINKS * 16;   // 128
    const r = createRegistry({ maxLinks: MAXLINKS, onCapacityExceeded: "grow" });
    // A single computed with more sources than the ceiling can hold: 200 > 128.
    const sigs = Array.from({ length: 200 }, (_, i) => r.signal(i + 1));
    let c = null;
    let err = null;
    try { c = r.computed(() => sigs.reduce((a, s) => a + s(), 0)); c(); } catch (e) { err = e; }

    R.ok("grow-ceiling", err !== null, "grow mode never hit its 16x link ceiling -- growth is unbounded");
    R.ok("grow-ceiling", isCapacityError(err), `expected CapacityError at the ceiling, got ${err && err.constructor.name}`);
    R.eq("grow-ceiling", err && err.kind, "links", "the ceiling error was not a links CapacityError");
    R.eq("grow-ceiling", err && err.capacity, CEIL, `ceiling capacity was ${err && err.capacity}, expected ${CEIL}`);

    // Growth terminated EXACTLY at the ceiling: the link ledger reached 16x and
    // stopped there, not one chunk over. linkPoolCapacity mirrors the physical
    // pool length (128, not 129+).
    const st = r.stats();
    R.eq("grow-ceiling", st.linkPoolCapacity, CEIL,
        `link pool grew to ${st.linkPoolCapacity}, expected it to terminate AT ${CEIL}`);
    R.ok("grow-ceiling", st.activeLinks <= CEIL,
        `activeLinks ${st.activeLinks} exceeded the ceiling ${CEIL}`);

    // Fail-closed read: the computed that overflowed the ceiling must re-throw,
    // never return the partial sum of the sources it managed to link.
    if (c !== null) {
        let readResult = null;
        let readThrew = null;
        try { readResult = c(); } catch (e) { readThrew = e; }
        R.ok("grow-ceiling", readThrew !== null,
            `a ceiling-overflowed computed returned ${readResult} instead of throwing -- a PARTIAL value escaped`);
        R.ok("grow-ceiling", isCapacityError(readThrew),
            `the ceiling read threw ${readThrew && readThrew.constructor.name}, expected CapacityError`);
    }
}

process.exit(R.finish("the fail-closed boundary held: throws where it must, no partial value ever escaped"));
