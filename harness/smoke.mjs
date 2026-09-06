import {
    createRegistry, signal, computed, effect, batch, dispose, stats, flush, onCleanup
} from "../Signal.js";

// === T1 -- eager mode (default) is byte-identical behavior ===
{
    let runs = 0;
    const a = signal(0);
    const c = computed(() => a() * 2);
    const e = effect(() => { c(); runs++; });
    console.log("T1: initial runs=", runs);  // 1
    a.set(1);
    console.log("T1: after set runs=", runs);  // 2 (eager: sync flush)
    a.set(2); a.set(3); a.set(4);
    console.log("T1: after 3 more sets runs=", runs, "(eager: should be 5)");
    if (runs !== 5) throw new Error("EAGER REGRESSION: expected 5, got " + runs);
    dispose(e); dispose(c); dispose(a);
}

// === T2 -- sab mode: writes outside batch DO NOT auto-flush ===
{
    const r = createRegistry({maxNodes: 1024, prealloc: "lazy", onCapacityExceeded: "grow", flushStrategy: "sab"});
    let runs = 0;
    const a = r.signal(0);
    const c = r.computed(() => a() * 2);
    const e = r.effect(() => { c(); runs++; });
    console.log("T2: initial runs=", runs);  // 1 (effect runs on creation)
    a.set(1);
    console.log("T2: after set (no batch) runs=", runs, "(sab: should still be 1 -- deferred)");
    if (runs !== 1) throw new Error("SAB REGRESSION: write should not auto-flush; got " + runs);
    // Many writes, still queued
    for (let i = 0; i < 1000; i++) a.set(i);
    console.log("T2: after 1000 writes runs=", runs, "(sab: should still be 1 -- dedup)");
    if (runs !== 1) throw new Error("SAB DEDUP BROKEN: got " + runs);
    // Batch exit flushes
    r.batch(() => { a.set(9999); });
    console.log("T2: after batch exit runs=", runs, "(sab: should be 2)");
    if (runs !== 2) throw new Error("SAB BATCH FLUSH BROKEN: got " + runs);
    r.destroy();
}

// === T3 -- manual mode: NOTHING auto-flushes; only r.flush() does ===
{
    const r = createRegistry({maxNodes: 1024, prealloc: "lazy", onCapacityExceeded: "grow", flushStrategy: "manual"});
    let runs = 0;
    const a = r.signal(0);
    const c = r.computed(() => a() * 2);
    const e = r.effect(() => { c(); runs++; });
    console.log("T3: initial runs=", runs);  // 1
    a.set(1);
    console.log("T3: after set runs=", runs, "(manual: should be 1)");
    if (runs !== 1) throw new Error("MANUAL REGRESSION (set): got " + runs);
    r.batch(() => { a.set(2); a.set(3); });
    console.log("T3: after batch runs=", runs, "(manual: should STILL be 1 -- no auto-flush at batch exit)");
    if (runs !== 1) throw new Error("MANUAL REGRESSION (batch): got " + runs);
    r.flush();
    console.log("T3: after r.flush() runs=", runs, "(manual: should be 2)");
    if (runs !== 2) throw new Error("MANUAL FLUSH BROKEN: got " + runs);
    r.destroy();
}

// === T4 -- sab pull semantics: computed reads ARE current even without flush ===
{
    const r = createRegistry({flushStrategy: "sab"});
    const a = r.signal(10);
    const c = r.computed(() => a() * 3);
    console.log("T4: initial c read =", c(), "(sab: should be 30)");
    a.set(20);
    // No batch. No effect. No flush. Lazy pull still works.
    console.log("T4: c read after set without flush =", c(), "(sab: should be 60 -- lazy pull)");
    if (c() !== 60) throw new Error("LAZY PULL BROKEN UNDER SAB");
    r.destroy();
}

// === T5 -- invalid flushStrategy throws ===
{
    try {
        createRegistry({flushStrategy: "bogus"});
        throw new Error("EXPECTED VALIDATION ERROR");
    } catch (e) {
        if (!e.message.includes("flushStrategy")) throw e;
        console.log("T5: validation rejects bogus strategy:", e.message);
    }
}

// === 1.8.0 -- effect cleanup return (Reflex pattern A) =======================
// The CHANGELOG deferred behavioral coverage for this to a later preview, so the
// flagship 1.8.0 feature shipped untested. These asserts are the interim pin:
// smoke runs first in `harness:all` and in `npm run verify`, so a regression in
// the cleanup-return contract fails in a second instead of reaching a publish.

// === T6 -- returned cleanup runs before the next re-run, and on dispose ===
{
    const order = [];
    const a = signal(0);
    const e = effect(() => {
        a();
        return () => order.push("cleanup");
    });
    if (order.length !== 0) throw new Error("T6: cleanup ran on first execution");
    a.set(1);
    if (order.length !== 1) throw new Error("T6: cleanup did not run before re-run, got " + order.length);
    dispose(e);
    if (order.length !== 2) throw new Error("T6: cleanup did not run on dispose, got " + order.length);
    console.log("T6: returned cleanup fires before re-run AND on dispose");
}

// === T7 -- returned cleanup composes with imperative onCleanup, in CALL ORDER ===
{
    const order = [];
    const a = signal(0);
    const e = effect(() => {
        a();
        onCleanup(() => order.push("imperative"));   // registered first
        return () => order.push("returned");         // appended after
    });
    a.set(1);
    const got = order.join(",");
    if (got !== "imperative,returned") throw new Error("T7: expected 'imperative,returned', got '" + got + "'");
    dispose(e);
    console.log("T7: returned cleanup composes with onCleanup in call order");
}

// === T8 -- non-function returns are ignored (no throw, no cleanup) ===
{
    const a = signal(0);
    for (const bogus of [42, "str", null, {x: 1}, undefined]) {
        const e = effect(() => { a(); return bogus; });
        a.set(a.peek() + 1);
        dispose(e);   // must not throw trying to call a non-function
    }
    console.log("T8: non-function returns ignored (number/string/null/object/undefined)");
}

// === T9 -- a computed returning a function keeps it as the VALUE (regression pin) ===
{
    const a = signal(1);
    const fn = () => "I am the value";
    const c = computed(() => { a(); return fn; });
    const got = c();
    if (typeof got !== "function") throw new Error("T9: computed lost its function value");
    if (got() !== "I am the value") throw new Error("T9: computed's function value was invoked as a cleanup");
    if (got !== fn) throw new Error("T9: computed did not return the identical function");
    console.log("T9: computed returning a function still treats it as the VALUE");
}

console.log("\nALL SMOKE TESTS PASSED");
