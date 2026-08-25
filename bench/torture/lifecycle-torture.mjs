/**
 * bench/torture/lifecycle-torture.mjs -- createRoot detachment + destroy reset
 * (createRoot: 1.5.0+, destroy: 1.4.0+).
 *
 * Two load-bearing registry/root lifecycle primitives that a value oracle is
 * blind to: `createRoot` (detachment) and `destroy` (full reset). This file
 * asserts their DIRECT contracts.
 *
 * createRoot(fn): runs fn DETACHED -- no owner, no observer, no tracking. Nodes
 * created inside SURVIVE and the caller disposes them by hand:
 *   - an effect created in createRoot keeps reacting after the call returns
 *     (it was NOT auto-disposed the way an owner's child would be);
 *   - reads in fn's direct body form NO dependency edge into an enclosing observer
 *     (the createRoot pairing nulls the observer, same as runWithOwner);
 *   - fn's return value passes through; nesting composes.
 *
 * destroy(): a full registry reset -- every node's gen is bumped (so every
 * outstanding handle goes stale), all state cleared, free lists rebuilt:
 *   - after destroy, every prior handle is stale: nodeId/describe return
 *     undefined, and a stale .set() is a safe no-op (not a crash, and it drives
 *     no effect);
 *   - the registry is REUSABLE -- new signals/computeds/effects work normally;
 *   - destroy is idempotent, and leaves stats().activeNodes === 0.
 *
 * PORT NOTE (1.5.0). 1.5.0's owner surface is getOwner/runWithOwner/createRoot;
 * there is NO createScope. Scenario 2 (createRoot detaches even when nested) is
 * RE-TARGETED to nest the createRoot inside an r.effect(...) body, where
 * currentOwner is the enclosing effect (non-null). A createRoot that failed to
 * null currentOwner would ADOPT the inner effect into the enclosing effect and
 * cascade-dispose it on the effect's stop(); at top level currentOwner is
 * already null and the assertion would be vacuous, so the effect nesting is what
 * makes the detachment observable. 1.5.0 createRoot behaves as documented -- no
 * divergence from 1.4.4 observed.
 *
 * Exit code: 0 iff every lifecycle contract held.
 *
 * Usage: node --expose-gc bench/torture/lifecycle-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;
const reg = () => createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow" });

const HAS_ROOT = typeof reg().createRoot === "function";
const HAS_DESTROY = typeof reg().destroy === "function";

if (!HAS_ROOT && !HAS_DESTROY) {
    console.log("lite-signal lifecycle torture -- SKIP: neither createRoot nor destroy available");
    process.exit(77); // SKIP_EXIT — the runner escalates this to FAIL at/above the floor
}

const R = createReport("lite-signal lifecycle torture -- createRoot detachment + destroy reset");

/* -- createRoot: DETACHMENT (nodes survive; not auto-disposed) -------------- */
if (HAS_ROOT) {
    // 1. An effect created inside createRoot survives the call and keeps reacting.
    {
        const r = reg();
        const s = r.signal(0);
        let runs = 0;
        r.createRoot(() => { r.effect(() => { s(); runs++; }); });
        const base = runs;
        s.set(1);
        R.ok("root-survives", runs - base >= 1,
            "an effect created in createRoot did not survive the call (was auto-disposed like an owned child)");
        s.set(2);
        R.ok("root-survives", runs - base >= 2, "the detached effect stopped reacting");
    }

    // 2. createRoot DETACHES even when nested inside a live owner. Nesting it
    //    inside an EFFECT body is essential: at top level currentOwner is already
    //    null, so a broken detachment would be invisible. Inside an effect,
    //    currentOwner is that effect -- a createRoot that fails to null it would
    //    adopt its child into the effect, and the child would wrongly
    //    cascade-dispose when the effect is stopped.
    {
        const r = reg();
        const s = r.signal(0);
        let outerRuns = 0, rootRuns = 0;
        let rootChildStop = null;
        // The outer effect reads no signal -> runs once, never re-fires (which
        // would rebuild the root child and confuse the count).
        const outerStop = r.effect(() => {
            outerRuns++;
            r.createRoot(() => { rootChildStop = r.effect(() => { s(); rootRuns++; }); });
        });
        const rb = rootRuns;
        s.set(1);
        R.ok("root-detaches", rootRuns > rb, "the detached root child failed to react to a write");
        outerStop();                       // stop the enclosing effect
        const rb2 = rootRuns;
        s.set(2);
        R.ok("root-detaches", rootRuns - rb2 >= 1,
            "a createRoot child INSIDE an effect died when the effect was stopped -- createRoot did not detach (currentOwner not nulled)");
        if (rootChildStop) rootChildStop();
    }

    // 3. Return-value passthrough.
    {
        const r = reg();
        R.eq("root-return", r.createRoot(() => 42), 42, "createRoot did not pass through fn's return value");
        R.eq("root-return", r.createRoot(() => "x"), "x", "createRoot return passthrough wrong for a string");
    }

    // 4. Dep isolation: a read in the root body forms no edge into the enclosing
    //    observer (the createRoot pairing nulls the observer).
    {
        const r = reg();
        const trap = r.signal(0);
        let outerReruns = 0;
        const stop = r.effect(() => { outerReruns++; r.createRoot(() => { trap(); }); });
        const base = outerReruns;
        trap.set(1); trap.set(2); trap.set(3);
        R.eq("root-dep-isolation", outerReruns - base, 0,
            "a signal read only inside createRoot re-ran the enclosing effect -- a dep edge leaked");
        stop();
    }

    // 5. Nesting composes without crashing.
    {
        const r = reg();
        let ok = true;
        try {
            r.createRoot(() => { r.createRoot(() => { const e = r.effect(() => {}); e(); }); });
        } catch { ok = false; }
        R.ok("root-nesting", ok, "nested createRoot crashed");
    }
}

/* -- destroy: FULL REGISTRY RESET ------------------------------------------- */
if (HAS_DESTROY) {
    // 6. After destroy, every prior handle is stale.
    {
        const r = reg();
        const a = r.signal(1);
        const c = r.computed(() => a() * 2);
        r.effect(() => c());
        r.destroy();
        if (typeof r.nodeId === "function") {
            R.eq("post-destroy-stale", r.nodeId(a), undefined, "nodeId of a pre-destroy handle is still live (gen not bumped)");
        }
        if (typeof r.describe === "function") {
            R.eq("post-destroy-stale", r.describe(a), undefined, "describe of a pre-destroy handle still resolves");
        }
        // A stale .set() must be a safe no-op: no crash.
        let threw = null;
        try { a.set(999); } catch (e) { threw = e; }
        R.ok("post-destroy-stale", threw === null, `a stale .set() after destroy threw: ${threw && threw.message}`);
    }

    // 7. A stale handle drives NO effect after destroy.
    {
        const r = reg();
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { s(); runs++; });
        r.destroy();
        const base = runs;
        let threw = null;
        try { s.set(1); s.set(2); } catch (e) { threw = e; }
        R.ok("post-destroy-inert", threw === null, `stale writes after destroy threw: ${threw && threw.message}`);
        R.eq("post-destroy-inert", runs - base, 0, "an effect ran on a stale write after destroy");
    }

    // 8. The registry is REUSABLE after destroy.
    {
        const r = reg();
        r.signal(1); r.computed(() => 2); r.effect(() => {});
        r.destroy();
        let ok = false, threw = null;
        try {
            const b = r.signal(5);
            const c2 = r.computed(() => b() + 1);
            let seen = -1;
            r.effect(() => { seen = c2(); });
            b.set(10);
            ok = (c2() === 11) && (seen === 11 || seen === 6);   // effect delivered fresh
        } catch (e) { threw = e; }
        R.ok("post-destroy-reusable", threw === null, `rebuilding on a destroyed registry threw: ${threw && threw.message}`);
        R.ok("post-destroy-reusable", ok, "a rebuilt graph on a destroyed registry did not compute correctly");
    }

    // 9. destroy is idempotent.
    {
        const r = reg();
        r.signal(1);
        let threw = null;
        try { r.destroy(); r.destroy(); r.destroy(); } catch (e) { threw = e; }
        R.ok("destroy-idempotent", threw === null, `repeated destroy threw: ${threw && threw.message}`);
    }

    // 10. destroy after heavy churn returns the pool to a clean baseline (via stats).
    if (typeof reg().stats === "function") {
        const r = reg();
        for (let i = 0; i < 200; i++) {
            const s = r.signal(i);
            const c = r.computed(() => s() * 2);
            const stop = r.effect(() => c());
            if (i % 2 === 0) { stop(); r.dispose(c); r.dispose(s); }
        }
        r.destroy();
        const st = r.stats();
        // After destroy the live counts must be zero (everything returned to free).
        const active = (st.activeNodes !== undefined) ? st.activeNodes : (st.nodes !== undefined ? st.nodes : 0);
        R.eq("destroy-baseline", active | 0, 0, `destroy left ${active} live nodes; pool not fully reset`);
    }
}

const lifecycleSummary = [];
if (HAS_ROOT) lifecycleSummary.push("createRoot detaches (children survive, deps isolated)");
if (HAS_DESTROY) lifecycleSummary.push("destroy resets the pool and stales every handle");
process.exit(R.finish(lifecycleSummary.join("; ")));
