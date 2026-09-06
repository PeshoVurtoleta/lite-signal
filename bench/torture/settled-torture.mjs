/**
 * bench/torture/settled-torture.mjs -- the 1.11.0 onSettled lane: the
 * creation-time capability, pinned EXACTLY.
 *
 * 1.11.0 rebuilds onSettled (the ledger-#17 rejection) as a capability decided
 * ONCE at createRegistry: `{ settled: true }` selects a flushEffects variant
 * with a drain-complete tail; a default registry binds the verbatim plain
 * drain and pays nothing. onSettled(fn) -> unsubscribe; the callback fires
 * once per TOP-LEVEL, NON-EMPTY, CLEAN drain. This file gates the notification
 * contract engine-raw under adversarial geometry: exact settle counts across
 * all three flushStrategy builds, coalescing under batch/fan/cascade, the
 * negative space (empty / re-entrant / thrown drains), callback-throw
 * isolation, unsubscribe/subscribe DURING a fire, destroy, and long exact-count
 * soaks.
 *
 * CRITICAL SEMANTICS, established empirically before any assertion (probed on
 * the ported 1.11.0-preview engine, 2026-09-06):
 *   - "settled" means the graph actually quiesced: one fire per top-level
 *     drain that did work and exited cleanly. Cascades (effects writing
 *     signals during the drain) extend the SAME drain: still one fire.
 *   - effect CREATION runs the body directly (not through a drain): no settle.
 *   - an empty flush() and a zero-write batch() fire nothing.
 *   - a drain that throws propagates BEFORE the tail: no settle, and the next
 *     clean drain settles normally (the error buffer drained).
 *   - a THROWING settled callback is swallowed (observer, not control path):
 *     the write that triggered the drain never sees it, and sibling callbacks
 *     still fire.
 *   - callbacks fire in subscription order.
 *   - KNOWN SHARP EDGE (observed, deliberately NOT asserted either way):
 *     fireSettled iterates the live callbacks array while unsubscribe splices
 *     it, so a callback that unsubscribes ITSELF mid-fire shifts its next
 *     sibling into the visited slot -- that sibling silently misses THAT drain
 *     (delivery observed: [A(self-off), C] with B skipped; next drain [B, C]
 *     is clean). A mid-fire SUBSCRIBE lands in the growing array and is
 *     delivered in the SAME drain. Both are flagged upstream as candidate
 *     cold-path fixes (snapshot-free compaction); this file gates only the
 *     uncontested invariants around them: no crash, no corruption, exact
 *     recovery from the next drain on. If the engine adopts a fix, ADD the
 *     delivery assertions here deliberately.
 *
 * Falsifiability self-test (SETTLED_BREAK, never set by the runner):
 *   SETTLED_BREAK=phantom -- the counting harness invents one extra settle
 *                            after an empty flush (a phantom-notify defect):
 *                            the exact-count pins fail, exit 1.
 *   SETTLED_BREAK=lost    -- the harness swallows every 2nd observed settle (a
 *                            lost-notification defect): the exact-count pins
 *                            fail, exit 1.
 * Both live ONLY in the harness counter, never in the engine. Both verified to
 * exit 1 at build time.
 *
 * Exit code: 0 iff every pin held; 77 (SKIP) below the 1.11.0 surface.
 *
 * Usage: node bench/torture/settled-torture.mjs
 *        SETTLED_VOLUME=20000 node bench/torture/settled-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { createReport, SKIP_EXIT } from "./helpers/index.mjs";

const { createRegistry } = Signal;

/* -- surface gate ------------------------------------------------------------ */
{
    let hasCap = false;
    let gatedOff = false;
    try {
        const r = createRegistry({ maxNodes: 16, maxLinks: 32, settled: true });
        hasCap = typeof r.onSettled === "function";
        r.destroy();
        const d = createRegistry({ maxNodes: 16, maxLinks: 32 });
        try { d.onSettled(() => {}); } catch (_e) { gatedOff = true; }
        d.destroy();
    } catch (_e) { /* config rejected: pre-1.11.0 engine */ }
    if (!hasCap || !gatedOff) {
        console.log("lite-signal settled torture -- SKIP: onSettled capability requires 1.11.0+");
        process.exit(SKIP_EXIT);
    }
}

const VOLUME = Number(process.env.SETTLED_VOLUME || 10000);
const BREAK = process.env.SETTLED_BREAK || "";
const R = createReport(`lite-signal settled torture -- onSettled creation-time capability, exact drain accounting, ${VOLUME}-cycle soak`);

/** Registry factory: throw-policy, pre-sized, settled ON unless told off. */
function reg(extra) {
    return createRegistry({ maxNodes: 4096, maxLinks: 16384, settled: true, ...extra });
}

/** Counting subscriber. SETTLED_BREAK fault injection lives ONLY here,
 *  proving the exact-count pins fire on a defective notification stream
 *  without ever touching the engine. */
function mkCounter(r) {
    const c = { n: 0, off: null };
    let lostGate = false;
    c.off = r.onSettled(() => {
        if (BREAK === "lost" && (lostGate = !lostGate)) return;
        c.n++;
    });
    /** Harness hook for the phantom mutant: call after an empty flush. */
    c.phantomTick = () => { if (BREAK === "phantom") c.n++; };
    return c;
}

/* -- 1. exact settle counts under all three flushStrategy builds ------------- */
{
    // eager (default): every bare write drains -> one settle per write.
    const r = reg();
    const s = r.signal(0);
    let runs = 0;
    r.effect(() => { s(); runs++; });
    const c = mkCounter(r);
    const W = 25;
    for (let i = 1; i <= W; i++) s.set(i);
    R.eq("strategy-eager", c.n, W, `eager: ${W} bare writes are ${W} top-level drains -> ${W} settles`);
    R.eq("strategy-eager", runs, 1 + W, "sanity: the effect ran once per drain plus creation");
    r.destroy();
}
{
    // sab: bare writes queue silently; only batch-exit (or explicit flush) drains.
    const r = reg({ flushStrategy: "sab" });
    const s = r.signal(0);
    r.effect(() => { s(); });
    const c = mkCounter(r);
    s.set(1); s.set(2); s.set(3);
    R.eq("strategy-sab", c.n, 0, "sab: bare writes must NOT drain, so no settle yet");
    r.flush();
    R.eq("strategy-sab", c.n, 1, "sab: the explicit flush is ONE drain -> exactly one settle");
    r.batch(() => { s.set(4); s.set(5); });
    R.eq("strategy-sab", c.n, 2, "sab: batch exit auto-flushes -> exactly one more settle");
    r.destroy();
}
{
    // manual: nothing auto-drains; only r.flush() with queued work settles.
    const r = reg({ flushStrategy: "manual" });
    const s = r.signal(0);
    r.effect(() => { s(); });
    const c = mkCounter(r);
    s.set(1);
    r.batch(() => { s.set(2); s.set(3); });
    R.eq("strategy-manual", c.n, 0, "manual: neither writes nor batch exit may drain");
    r.flush();
    R.eq("strategy-manual", c.n, 1, "manual: one explicit flush over the queued work -> one settle");
    r.flush();
    c.phantomTick();
    R.eq("strategy-manual", c.n, 1, "manual: a second, EMPTY flush must not settle");
    r.destroy();
}

/* -- 2. coalescing: fan, batch, cascade all read as ONE drain ---------------- */
{
    const K = 16;
    const r = reg();
    const s = r.signal(0);
    const runs = new Int32Array(K);
    for (let i = 0; i < K; i++) { const idx = i; r.effect(() => { s(); runs[idx]++; }); }
    const c = mkCounter(r);
    s.set(1);
    R.eq("coalesce-fan", c.n, 1, `${K} effects re-running in one drain must be ONE settle, not ${K}`);
    r.batch(() => { for (let w = 2; w <= 9; w++) s.set(w); });
    R.eq("coalesce-batch", c.n, 2, "an 8-write batch is one drain at exit -> exactly one more settle");
    r.destroy();
}
{
    // Cascade: a's effect writes b, b's effect writes cSig -- one top-level drain.
    const r = reg();
    const a = r.signal(0), b = r.signal(0), cSig = r.signal(0);
    let tail = 0;
    r.effect(() => { const v = a(); if (v > 0) b.set(v); });
    r.effect(() => { const v = b(); if (v > 0) cSig.set(v); });
    r.effect(() => { cSig(); tail++; });
    const c = mkCounter(r);
    a.set(7);
    R.eq("coalesce-cascade", c.n, 1, "a 3-stage cross-effect cascade is ONE top-level drain -> one settle");
    R.eq("coalesce-cascade", tail, 2, "sanity: the tail effect ran at creation + once via the cascade");
    r.destroy();
}

/* -- 3. negative space: creation, empty, zero-write batch, thrown drain ------ */
{
    const r = reg();
    const s = r.signal(0);
    const c = mkCounter(r);
    r.effect(() => { s(); });
    R.eq("negative-creation", c.n, 0, "effect CREATION runs the body directly, not through a drain: no settle");
    r.flush();
    c.phantomTick();
    R.eq("negative-empty", c.n, 0, "an empty flush() must not settle");
    r.batch(() => {});
    R.eq("negative-empty-batch", c.n, 0, "a zero-write batch must not settle");
    s.set(1);
    R.eq("negative-then-real", c.n, 1, "the first real drain after the empties settles exactly once");
    r.destroy();
}
{
    const r = reg();
    const s = r.signal(0);
    let phase = 0;
    r.effect(() => { if (s() > 0 && phase === 0) throw new Error("boom"); });
    const c = mkCounter(r);
    let threw = false;
    try { s.set(1); } catch (_e) { threw = true; }
    R.ok("negative-thrown", threw, "precondition: the drain propagated the effect throw");
    R.eq("negative-thrown", c.n, 0, "a drain that threw must NOT settle (settled means clean quiescence)");
    phase = 1;
    s.set(2);
    R.eq("negative-recovery", c.n, 1, "the next CLEAN drain settles normally (error buffer drained)");
    r.destroy();
}
{
    // Re-entrant flush: an effect calling r.flush() mid-drain is a no-op inner
    // call (isFlushing); the top-level drain still settles exactly once.
    const r = reg();
    const s = r.signal(0);
    r.effect(() => { if (s() > 0) r.flush(); });
    const c = mkCounter(r);
    s.set(1);
    R.eq("reentrant", c.n, 1, "a re-entrant flush() inside the drain must not add a settle");
    r.destroy();
}

/* -- 4. callback isolation: a throwing observer never breaks the drain ------- */
{
    const r = reg();
    const s = r.signal(0);
    let runs = 0;
    r.effect(() => { s(); runs++; });
    const order = [];
    r.onSettled(() => { order.push("thrower"); throw new Error("observer boom"); });
    r.onSettled(() => order.push("after"));
    let writerThrew = false;
    try { s.set(1); } catch (_e) { writerThrew = true; }
    R.ok("cb-throw", !writerThrew, "a throwing settled callback must be swallowed, never reach the writer");
    R.eq("cb-throw", order.join(","), "thrower,after", "the sibling after a throwing callback must still fire, in order");
    R.eq("cb-throw", runs, 2, "sanity: the drain itself completed normally");
    s.set(2);
    R.eq("cb-throw", order.join(","), "thrower,after,thrower,after", "subsequent drains are unaffected");
    r.destroy();
}

/* -- 5. unsubscribe contract (incl. the mid-fire sharp edge, crash-only) ----- */
{
    const r = reg();
    const s = r.signal(0);
    r.effect(() => { s(); });
    let a = 0, b = 0;
    const offA = r.onSettled(() => a++);
    r.onSettled(() => b++);
    s.set(1);
    offA();
    offA(); // idempotent: the live-flag guard makes a double-off a no-op
    s.set(2);
    R.eq("unsub", a, 1, "an unsubscribed callback must stay silent from the next drain on");
    R.eq("unsub", b, 2, "the remaining callback keeps firing");
    r.destroy();
}
{
    // Self-unsubscribe DURING a fire: gate no-crash + exact recovery ONLY (the
    // same-drain sibling delivery is the flagged sharp edge -- see header).
    const r = reg();
    const s = r.signal(0);
    r.effect(() => { s(); });
    const seen = [];
    let offA = null;
    offA = r.onSettled(() => { seen.push("A"); offA(); });
    r.onSettled(() => seen.push("B"));
    r.onSettled(() => seen.push("C"));
    s.set(1);
    R.ok("unsub-mid-fire", seen[0] === "A", "the self-unsubscribing callback itself fired");
    R.ok("unsub-mid-fire", !seen.includes("A", 1), "A fired exactly once in the drain it left");
    seen.length = 0;
    s.set(2);
    R.eq("unsub-mid-fire", seen.join(","), "B,C",
        "RECOVERY: from the next drain on, exactly the surviving callbacks fire, in order");
    seen.length = 0;
    s.set(3);
    R.eq("unsub-mid-fire", seen.join(","), "B,C", "and the roster stays stable");
    r.destroy();
}
{
    // Subscribe DURING a fire: gate no-crash + all-subsequent-drains delivery
    // (same-drain delivery observed but deliberately un-asserted -- see header).
    const r = reg();
    const s = r.signal(0);
    r.effect(() => { s(); });
    let late = 0;
    let subscribed = false;
    r.onSettled(() => { if (!subscribed) { subscribed = true; r.onSettled(() => late++); } });
    s.set(1);
    const afterFirst = late;
    R.ok("sub-mid-fire", afterFirst === 0 || afterFirst === 1,
        "mid-fire subscribe must not corrupt the fire loop (0 or 1 same-drain fires only)");
    s.set(2);
    s.set(3);
    R.eq("sub-mid-fire", late - afterFirst, 2, "the mid-fire subscriber fires in every SUBSEQUENT drain");
    r.destroy();
}

/* -- 6. destroy: live subscriptions die silently ----------------------------- */
{
    const r = reg();
    const s = r.signal(0);
    r.effect(() => { s(); });
    const c = mkCounter(r);
    s.set(1);
    R.eq("destroy", c.n, 1, "precondition: settled before destroy");
    r.destroy();
    let threw = false;
    try { r.flush(); } catch (_e) { threw = true; }
    R.ok("destroy", !threw, "flush() on a destroyed registry stays a quiet no-op");
    R.eq("destroy", c.n, 1, "no settle can fire after destroy (nothing can drain)");
    r.destroy(); // double-destroy stays safe
    R.note("destroy retains settledCallbacks (bounded, freed with the registry) -- flagged upstream vs nodeNames' explicit clear");
}

/* -- 7. exact-count soaks: steady writes + batch storm ----------------------- */
{
    const r = reg();
    const s = r.signal(0);
    let runs = 0;
    r.effect(() => { s(); runs++; });
    const c = mkCounter(r);
    for (let i = 1; i <= VOLUME; i++) s.set(i);
    R.eq("soak-steady", c.n, VOLUME, `${VOLUME} write->drain cycles must be EXACTLY ${VOLUME} settles`);
    R.eq("soak-steady", runs, 1 + VOLUME, "sanity: one body run per drain plus creation");
    const batches = 1000;
    const before = c.n;
    for (let i = 0; i < batches; i++) {
        r.batch(() => { s.set(i * 8 + 1); s.set(i * 8 + 2); s.set(i * 8 + 3); s.set(i * 8 + 4); });
    }
    R.eq("soak-batch", c.n - before, batches, `${batches} 4-write batches must be EXACTLY ${batches} settles`);
    r.destroy();
    R.note(`soak volume: ${VOLUME} steady cycles + ${batches} batches, all exact`);
}

/* -- 8. the capability is additive: default-build behavior is unchanged ------ */
{
    // Same script on a default and a settled registry: identical effect
    // delivery. The settled build may only ADD notifications, never change
    // the drain the effects see (the plain body is byte-identical by
    // construction; this is the runtime witness).
    const script = (r) => {
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { s(); runs++; });
        for (let i = 1; i <= 50; i++) s.set(i);
        r.batch(() => { s.set(100); s.set(101); });
        return runs;
    };
    const plain = createRegistry({ maxNodes: 256, maxLinks: 1024 });
    const settled = reg();
    settled.onSettled(() => {});
    const rp = script(plain);
    const rs = script(settled);
    R.eq("additive", rs, rp, "a settled registry must deliver effects EXACTLY like a default one");
    plain.destroy(); settled.destroy();
}

process.exit(R.finish(
    "onSettled exact: per-strategy drain accounting, fan/batch/cascade coalescing, clean-quiescence negatives, observer isolation, mid-fire safety, destroy, soaks",
    // Reviewer-tightened floor: exactly the shipped assert count, so a harness
    // path that silently drops ANY assert trips the floor (was 30).
    { minAsserts: 39 }
));
