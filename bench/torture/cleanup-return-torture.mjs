/**
 * bench/torture/cleanup-return-torture.mjs — effect cleanup return (1.8.0).
 *
 * 1.8.0 adds ONE behavioural change: an effect body may `return` a cleanup
 * function that runs before the next re-run and on dispose, composing with
 * imperative `onCleanup(fn)` in call order. No new export — the whole feature is
 * a `typeof` check on the effect body's return value inside `executeEffect`,
 * which is precisely the shape of change that regresses quietly: the existing
 * suite has zero cleanup-return coverage, so a subtle break passes it green.
 *
 * The contract, from the changelog, has four load-bearing claims, each a
 * separate regression surface:
 *
 *   1. TIMING — the returned cleanup runs before the next re-run and on dispose,
 *      exactly once per body run, never on the run that produced it.
 *
 *   2. COMPOSE ORDER — a returned cleanup is appended AFTER any imperative
 *      onCleanup(fn) registered in the same body, and the whole group fires in
 *      registration/call order (NOT reverse — this engine documents forward
 *      order, unlike Solid). This is the "single fn -> pair array -> push"
 *      append shared with onCleanup.
 *
 *   3. SELF-DISPOSE GUARD — a body that generation-advances mid-execution (self
 *      dispose, or disposing an owner that owns it) registers NOTHING from its
 *      return: by the time the return is inspected the slot may host a new
 *      resident, so the guard is `node.gen === savedGen`. But an imperative
 *      onCleanup registered BEFORE the self-dispose call still fires — that
 *      asymmetry is the subtle part.
 *
 *   4. COMPUTEDS ARE UNTOUCHED — a computed returning a function keeps that
 *      function as its VALUE. If the cleanup-return check ever leaks into the
 *      pull path, a computed-of-a-function silently loses its value.
 *
 * The flagship is a DIFFERENTIAL: `return fn` must be observationally identical
 * to `onCleanup(fn)` called as the last statement of the body. Two effects built
 * the two ways, driven by the same writes, must produce identical cleanup
 * sequences. Any divergence is a compose-order or timing regression.
 *
 * Skips on pre-1.8.0 (feature-detected by running a probe effect).
 *
 * Exit code: 0 iff every cleanup-return contract held.
 *
 * Usage: node --expose-gc bench/torture/cleanup-return-torture.mjs
 *        CLEANUP_SEEDS=2000 node --expose-gc bench/torture/cleanup-return-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;

// Feature-detect: does a returned function run as cleanup?
{
    let supported = false;
    try {
        const r = createRegistry({ maxNodes: 32, onCapacityExceeded: "grow" });
        const s = r.signal(0);
        let cleaned = false;
        const stop = r.effect(() => { s(); return () => { cleaned = true; }; });
        s.set(1);            // should trigger the returned cleanup before re-run
        stop();
        supported = cleaned;
    } catch { supported = false; }
    if (!supported) {
        console.log("lite-signal cleanup-return torture — SKIP: effect cleanup return requires 1.8.0+");
        process.exit(77); // SKIP_EXIT — the runner escalates this to FAIL at/above the floor
    }
}

const SEEDS = Number(process.env.CLEANUP_SEEDS || 400);
const R = createReport(`lite-signal cleanup-return torture — effect return cleanup, ${SEEDS} seeds`);
const reg = () => createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow" });

/* ── 1. Timing: before re-run, on dispose, once per run ───────────────────── */
{
    const r = reg();
    const s = r.signal(0);
    const log = [];
    const stop = r.effect(() => { const v = s(); log.push("body" + v); return () => log.push("clean" + v); });
    R.eq("timing", log.join(","), "body0", "the returned cleanup ran on the same run that produced it");
    s.set(1);
    R.eq("timing", log.join(","), "body0,clean0,body1", "cleanup did not run before the re-run, in order");
    s.set(2);
    R.eq("timing", log.join(","), "body0,clean0,body1,clean1,body2", "second re-run cleanup order wrong");
    stop();
    R.eq("timing", log.join(","), "body0,clean0,body1,clean1,body2,clean2", "dispose did not run the last cleanup");
}

/* ── 2. Compose order: imperative then returned, forward order ────────────── */
{
    const r = reg();
    const s = r.signal(0);
    const log = [];
    const stop = r.effect(() => {
        const v = s();
        r.onCleanup(() => log.push("A" + v));
        r.onCleanup(() => log.push("B" + v));
        return () => log.push("R" + v);
    });
    s.set(1);
    R.eq("compose", log.join(","), "A0,B0,R0", "compose order wrong: expected imperative A,B then returned R in forward order");
    stop();
    R.eq("compose", log.join(","), "A0,B0,R0,A1,B1,R1", "compose order wrong on dispose");
}
{
    // Reverse case: returned registered "first" conceptually (it's always last in
    // the body's execution), imperative after — still call order.
    const r = reg();
    const s = r.signal(0);
    const log = [];
    // A body cannot register the return before onCleanup (return is syntactically
    // last), so the only orderings are onCleanup-before-return. Verify a single
    // onCleanup + return is a 2-element group in the right order.
    const stop = r.effect(() => { const v = s(); r.onCleanup(() => log.push("imp" + v)); return () => log.push("ret" + v); });
    s.set(1);
    R.eq("compose-pair", log.join(","), "imp0,ret0", "single onCleanup + return did not fire imp then ret");
    stop();
}

/* ── 3. Self-dispose guard ────────────────────────────────────────────────── */
{
    // A body that disposes itself mid-execution: the imperative onCleanup
    // registered BEFORE the dispose fires; the RETURN does not (gen guard).
    const r = reg();
    const s = r.signal(0);
    const log = [];
    let stop;
    stop = r.effect(() => {
        const v = s();
        log.push("body" + v);
        r.onCleanup(() => log.push("imp" + v));
        if (v === 1) stop();                 // self-dispose mid-body
        return () => log.push("ret" + v);
    });
    s.set(1);
    R.ok("self-dispose", log.includes("imp1"), "imperative onCleanup before self-dispose did not fire");
    R.ok("self-dispose", !log.includes("ret1"), "the return of a self-disposed body was registered and fired (gen guard failed)");
    // No further runs.
    const snap = log.join(",");
    s.set(2);
    R.eq("self-dispose", log.join(","), snap, "a self-disposed effect ran again");
}
{
    // Disposing the OWNER mid-body (via createScope) must also suppress the return.
    if (typeof Signal.createScope === "function") {
        const r = reg();
        const s = r.signal(0);
        const log = [];
        let disposeScope;
        const outer = r.effect(() => {
            const v = s();
            if (v === 0) {
                disposeScope = r.createScope((d) => {
                    r.effect(() => {
                        log.push("inner" + v);
                        return () => log.push("innerClean" + v);
                    });
                    return d;
                });
            }
        });
        // dispose the scope; the inner effect's returned cleanup should run on that disposal
        disposeScope();
        R.ok("owner-dispose", log.includes("innerClean0"), "disposing the owning scope did not run the inner effect's returned cleanup");
        outer();
    }
}

/* ── 4. Computeds are untouched ───────────────────────────────────────────── */
{
    const r = reg();
    const a = r.signal(1);
    const c = r.computed(() => { const v = a(); return () => v * 10; });
    const fn = c();
    R.ok("computed-value", typeof fn === "function", "a computed returning a function lost its value");
    R.eq("computed-value", fn(), 10, "the computed's returned function was not its value");
    a.set(2);
    const fn2 = c();
    R.eq("computed-value", fn2(), 20, "the computed did not re-evaluate its function value");
    // And crucially: that function must NOT have been invoked as a cleanup.
    let invoked = 0;
    const c2 = r.computed(() => { a(); return () => { invoked++; }; });
    c2(); a.set(3); c2(); a.set(4); c2();
    R.eq("computed-value", invoked, 0, "a computed's returned function was invoked as if it were a cleanup");
}

/* ── 5. Non-function returns are ignored ──────────────────────────────────── */
{
    const r = reg();
    for (const ret of [42, "str", null, undefined, { }, [1, 2]]) {
        const s = r.signal(0);
        let threw = null;
        try {
            const stop = r.effect(() => { s(); return ret; });
            s.set(1);
            stop();
        } catch (e) { threw = e; }
        R.ok("non-function", threw === null, `returning ${JSON.stringify(ret)} threw: ${threw && threw.message}`);
    }
}

/* ── 6. Composition with the disposal-crash path ──────────────────────────── */
{
    // The 1.7/1.8 cursor-repair fix must compose with cleanup-return: an effect
    // that disposes a source it linked last run AND returns a cleanup.
    const r = reg();
    const gate = r.signal(true);
    const src = r.signal(1);
    const log = [];
    let threw = null;
    try {
        r.effect(() => {
            if (gate()) { src(); }
            else { r.dispose(src); }
            return () => log.push("cleanup");
        });
        gate.set(false);
    } catch (e) { threw = e; }
    R.ok("dispose-compose", threw === null, `dispose-linked-source + cleanup-return crashed: ${threw && threw.message}`);
    R.ok("dispose-compose", log.length >= 1, "the returned cleanup never ran across the dispose path");
}

/* ── 7. A throwing returned-cleanup must not eat sibling cleanups ─────────── */
{
    const r = reg();
    const s = r.signal(0);
    const safe = [];
    let sawError = false;
    const stop = r.effect(() => {
        const v = s();
        r.onCleanup(() => safe.push("safe" + v));
        return () => { throw new Error("cleanup boom"); };
    });
    try { s.set(1); } catch { sawError = true; }
    R.ok("throwing-cleanup", safe.includes("safe0"), "a sibling imperative cleanup was skipped because the returned cleanup threw");
    try { stop(); } catch { /* teardown */ }
}

/* ── 8. Differential: `return fn` == `onCleanup(fn)` as last statement ─────── */

function differentialSeed(seed) {
    const rnd = mulberry32(seed);

    // Two registries, two effects built the two ways, same writes. Their cleanup
    // sequences must be identical.
    const rr = reg();
    const rc = reg();
    const sr = rr.signal(0);
    const sc = rc.signal(0);
    const logReturn = [];
    const logImperative = [];

    // Randomly interleave 0..2 imperative onCleanups with the returned cleanup,
    // and mirror the imperative-equivalent exactly.
    const nImp = randInt(rnd, 3);

    const stopR = rr.effect(() => {
        const v = sr();
        for (let i = 0; i < nImp; i++) { const j = i; rr.onCleanup(() => logReturn.push(`imp${j}_${v}`)); }
        return () => logReturn.push(`ret_${v}`);
    });
    const stopC = rc.effect(() => {
        const v = sc();
        for (let i = 0; i < nImp; i++) { const j = i; rc.onCleanup(() => logImperative.push(`imp${j}_${v}`)); }
        rc.onCleanup(() => logImperative.push(`ret_${v}`));   // the return, as an imperative last statement
    });

    const writes = 3 + randInt(rnd, 6);
    for (let w = 0; w < writes; w++) {
        const v = 1 + randInt(rnd, 100);
        sr.set(v); sc.set(v);
    }
    stopR(); stopC();

    if (logReturn.length !== logImperative.length) {
        return { seed, reason: `length ${logReturn.length} vs ${logImperative.length}` };
    }
    for (let i = 0; i < logReturn.length; i++) {
        if (logReturn[i] !== logImperative[i]) {
            return { seed, reason: `at ${i}: return-style="${logReturn[i]}" imperative-style="${logImperative[i]}"` };
        }
    }
    return null;
}

let diffFail = 0;
let firstDiff = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    let bad;
    try { bad = differentialSeed(seed); }
    catch (err) { diffFail++; if (!firstDiff) firstDiff = { seed, reason: "threw: " + err.message }; continue; }
    if (bad) { diffFail++; if (!firstDiff) firstDiff = bad; }
}
if (diffFail > 0) {
    R.fail("differential", `${diffFail}/${SEEDS} seeds: 'return fn' diverged from 'onCleanup(fn)'; first seed ${firstDiff.seed}: ${firstDiff.reason}`);
}

// Note recorded during review: the self-dispose GEN GUARD (node.gen === savedGen
// in registerCleanupReturn) is defense-in-depth against a slot-recycle race that
// is not reachable from the public API — an effect cannot self-dispose during its
// FIRST body run in a way that recycles its slot before the return is inspected.
// Dropping the guard is therefore an INERT mutation (no differential catches it),
// which is correct: the guard should exist, but its trigger is unreachable, so no
// black-box test can exercise it. Flagged rather than faked.
R.note(`${SEEDS} differential seeds: 'return fn' vs 'onCleanup(fn)' as last statement`);
R.note("self-dispose gen-guard is unreachable defense-in-depth — see file footer");
process.exit(R.finish("cleanup-return honours timing, compose order, self-dispose guard, and leaves computeds untouched"));
