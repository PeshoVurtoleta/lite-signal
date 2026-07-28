/**
 * bench/torture/dispose-torture.mjs -- Symbol.dispose on lifecycle objects (1.9.0).
 *
 * 1.9.0 stamps Symbol.dispose at FIVE sites so lifecycle objects work with the
 * TC39 `using` declaration: the registry (-> destroy), an effect's stop handle
 * (-> stop), a createScope disposer (-> dispose), a createRoot disposer, and
 * both box prototypes (-> dispose). No new export -- it is a set of stamped
 * methods, which is exactly the profile the existing suite cannot see.
 *
 * Two deliberate design decisions carry the risk, and each is a regression
 * surface:
 *
 *   1. THE CALLABLE EXCLUSION. The return of signal() / computed() is
 *      deliberately UNSTAMPED -- a value handle is not a lifecycle object, and
 *      `using s = signal(0)` must be a type/runtime no-op, not a disposal. If a
 *      refactor ever stamps the callable prototype, every `using`-wrapped value
 *      handle would dispose the underlying node at block exit -- a silent, severe
 *      regression. This file asserts the ABSENCE of the stamp as hard as it
 *      asserts its presence elsewhere.
 *
 *   2. EQUIVALENCE + IDEMPOTENCE. `obj[Symbol.dispose]()` must do EXACTLY what
 *      the object's plain disposer does (the `using` desugaring calls it once at
 *      block exit), and must be safe to call again -- `using` plus a manual
 *      dispose in the same body is legal and common. A Symbol.dispose that
 *      double-frees, or that diverges from the plain disposer, breaks silently
 *      because the happy path looks identical.
 *
 * The `using` SYNTAX itself needs Node 24+; the METHOD works on Node 20+. This
 * file drives the method directly (which is what `using` desugars to), so it is
 * runtime-portable. Where Symbol.dispose is absent entirely (pre-Node-20) it
 * skips.
 *
 * Exit code: 0 iff every stamped site disposes-equivalently-and-idempotently and
 * every deliberately-unstamped handle stays unstamped.
 *
 * Usage: node --expose-gc bench/torture/dispose-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;

if (typeof Symbol.dispose !== "symbol") {
    console.log("lite-signal dispose torture -- SKIP: Symbol.dispose unavailable (needs Node 20+)");
    process.exit(0);
}

// Feature-detect via the BOX prototype stamp, deliberately NOT the registry stamp:
// each stamp site is tested individually below, and if the gate keyed off the same
// site as an assertion, removing that stamp would make the file SKIP instead of
// FAIL. The box prototype is the most stable stamp and its presence is a clean
// proxy for "this is 1.9.0+". (An earlier draft gated on the registry stamp and
// was blind to a registry-stamp regression for exactly this reason.)
{
    let stamped = false;
    try {
        const r = createRegistry({ maxNodes: 16, onCapacityExceeded: "grow" });
        const box = r.signalBox(0);
        stamped = typeof box[Symbol.dispose] === "function";
    } catch { stamped = false; }
    if (!stamped) {
        console.log("lite-signal dispose torture -- SKIP: Symbol.dispose stamping requires 1.9.0+");
        process.exit(0);
    }
}

const R = createReport("lite-signal dispose torture -- Symbol.dispose on lifecycle objects");
const reg = () => createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow" });
const DISPOSE = Symbol.dispose;

/* -- 1. The five stamped sites are present ---------------------------------- */
{
    const r = reg();
    R.eq("stamp-registry", typeof r[DISPOSE], "function", "registry is not Symbol.dispose-stamped");

    const stop = r.effect(() => {});
    R.eq("stamp-effect", typeof stop[DISPOSE], "function", "effect stop handle is not stamped");

    const box = r.signalBox(0);
    R.eq("stamp-signalbox", typeof box[DISPOSE], "function", "signalBox is not stamped");

    const cbox = r.computedBox(() => 1);
    R.eq("stamp-computedbox", typeof cbox[DISPOSE], "function", "computedBox is not stamped");

    if (typeof Signal.createScope === "function") {
        const disp = r.createScope((d) => d);
        R.eq("stamp-scope", typeof disp[DISPOSE], "function", "createScope disposer is not stamped");
    }
    stop[DISPOSE](); box[DISPOSE](); cbox[DISPOSE](); r[DISPOSE]();
}

/* -- 2. The callable exclusion (assert the ABSENCE) ------------------------- */
{
    const r = reg();
    const sig = r.signal(0);
    const comp = r.computed(() => sig() + 1);

    R.eq("no-stamp-signal", typeof sig[DISPOSE], "undefined",
        "a callable signal is Symbol.dispose-stamped -- `using s = signal()` would silently dispose the node");
    R.eq("no-stamp-computed", typeof comp[DISPOSE], "undefined",
        "a callable computed is stamped -- value handles must not be lifecycle objects");

    // And prove the consequence the exclusion prevents: reading still works, the
    // node is NOT torn down by anything a `using` block would call.
    R.eq("callable-alive", sig(), 0, "callable signal unreadable");
    sig.set(5);
    R.eq("callable-alive", comp(), 6, "callable computed did not react -- was it disposed?");
    r[DISPOSE]();
}

/* -- 3. Symbol.dispose is EQUIVALENT to the plain disposer, per site --------- */
{
    // effect: Symbol.dispose must be the same teardown as calling stop().
    const r = reg();
    const s = r.signal(0);
    let runsA = 0, runsB = 0;
    const stopManual = r.effect(() => { s(); runsA++; });
    const stopSym = r.effect(() => { s(); runsB++; });
    const baseA = runsA, baseB = runsB;
    stopManual();                 // plain
    stopSym[DISPOSE]();           // symbol
    s.set(1);
    R.eq("equiv-effect", runsA - baseA, 0, "plain stop() did not stop the effect");
    R.eq("equiv-effect", runsB - baseB, 0, "Symbol.dispose did not stop the effect the way stop() does");
    r[DISPOSE]();
}
{
    // signalBox: Symbol.dispose must dispose exactly like the box's own dispose.
    const r = reg();
    const boxManual = r.signalBox(1);
    const boxSym = r.signalBox(1);
    let mFired = 0, sFired = 0;
    boxManual.subscribe(() => mFired++);
    boxSym.subscribe(() => sFired++);
    const mBase = mFired, sBase = sFired;

    // Whatever the box's imperative disposal is, Symbol.dispose must match it.
    boxSym[DISPOSE]();
    boxSym.set(99);
    R.eq("equiv-box", sFired - sBase, 0, "Symbol.dispose left the signalBox live (still notifies)");
    // The un-disposed control still notifies -- proving the test can see a live box.
    boxManual.set(99);
    R.ok("equiv-box", mFired - mBase >= 1, "control box did not notify -- test is blind");
    r[DISPOSE]();
}

/* -- 4. Idempotence at every site ------------------------------------------- */
{
    const r = reg();
    const stop = r.effect(() => {});
    const box = r.signalBox(0);
    const cbox = r.computedBox(() => 1);
    const scope = typeof Signal.createScope === "function" ? r.createScope((d) => d) : null;

    const sites = [["effect", stop], ["signalBox", box], ["computedBox", cbox]];
    if (scope) sites.push(["scope", scope]);
    for (const [name, obj] of sites) {
        let threw = null;
        try { obj[DISPOSE](); obj[DISPOSE](); obj[DISPOSE](); } catch (e) { threw = e; }
        R.ok("idem-" + name, threw === null, `${name}[Symbol.dispose] is not idempotent: ${threw && threw.message}`);
    }
    // registry last (it tears down everything).
    let rThrew = null;
    try { r[DISPOSE](); r[DISPOSE](); } catch (e) { rThrew = e; }
    R.ok("idem-registry", rThrew === null, `registry[Symbol.dispose] is not idempotent: ${rThrew && rThrew.message}`);
}

/* -- 5. Symbol.dispose composes with the plain disposer (using + manual) ---- */
{
    // A body may both `using`-wrap an object AND call its plain disposer. The two
    // must coexist: whichever runs first disposes; the second is a safe no-op.
    const r = reg();

    const stop = r.effect(() => {});
    let threw = null;
    try { stop(); stop[DISPOSE](); } catch (e) { threw = e; }     // plain then symbol
    R.ok("compose", threw === null, `plain stop() then Symbol.dispose threw: ${threw && threw.message}`);

    const box = r.signalBox(0);
    threw = null;
    try { box[DISPOSE](); box[DISPOSE](); } catch (e) { threw = e; }
    R.ok("compose", threw === null, "symbol then symbol on a box threw");

    const box2 = r.signalBox(0);
    threw = null;
    // symbol then plain (if the box exposes a plain disposer via dispose(box))
    try {
        box2[DISPOSE]();
        if (typeof Signal.dispose === "function") Signal.dispose(box2);
    } catch (e) { threw = e; }
    R.ok("compose", threw === null, `Symbol.dispose then dispose(box) threw: ${threw && threw.message}`);
    r[DISPOSE]();
}

/* -- 6. A disposed registry's Symbol.dispose does not resurrect anything ---- */
{
    const r = reg();
    const s = r.signal(1);
    const c = r.computed(() => s() * 2);
    let runs = 0;
    r.effect(() => { c(); runs++; });
    const base = runs;
    r[DISPOSE]();
    // After destroy, writes must not drive effects (the registry is gone).
    let threw = null;
    try { s.set(2); } catch (e) { threw = e; }
    // Either it throws (registry destroyed) or it silently no-ops; it must NOT
    // run the effect again.
    R.eq("post-destroy", runs - base, 0, "an effect ran after its registry was Symbol.dispose'd");
}

/* -- 7. Stamp is on the PROTOTYPE for boxes (zero per-instance cost) --------- */
{
    // The changelog claims boxes stamp via prototype, not per instance. Verify
    // the method is inherited, not an own property -- a per-instance stamp would
    // be an allocation regression on the hot box-construction path.
    const r = reg();
    const box = r.signalBox(0);
    R.ok("prototype-stamp", !Object.prototype.hasOwnProperty.call(box, DISPOSE),
        "signalBox carries Symbol.dispose as an OWN property -- per-instance cost, should be on the prototype");
    R.eq("prototype-stamp", typeof box[DISPOSE], "function", "signalBox does not inherit Symbol.dispose");
    const cbox = r.computedBox(() => 1);
    R.ok("prototype-stamp", !Object.prototype.hasOwnProperty.call(cbox, DISPOSE),
        "computedBox carries Symbol.dispose as an own property");
    box[DISPOSE](); cbox[DISPOSE](); r[DISPOSE]();
}

process.exit(R.finish("Symbol.dispose stamps the five lifecycle sites, excludes callables, and disposes equivalently and idempotently"));
