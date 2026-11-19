// b123 ASSERTION 3 child (run with --expose-gc --single-threaded --max-old-space-size=256). argv: engineFile cycles
// A nested-dispose tree per cycle: E(d0) -> C1(d1) reads b1..b100 then C2(d2) disposes all 100 -> 100 logged fixes (300 slots > 48).
// Cycle 1 grows the log; cycles 2..N must not retain anything per cycle. Prints one JSON line.
import { pathToFileURL } from "node:url";
import { PerformanceObserver, constants } from "node:perf_hooks";
const S = await import(pathToFileURL(process.argv[2]).href);
const CYC = +process.argv[3];
if (process.argv[4] === "destroy") {   // b219 3b: 10,000 logged drop entries, destroy(), api held, gc; prints { destroy, retained }
    const gc2 = () => { globalThis.gc(); globalThis.gc(); };
    const K = 10000; const r0 = S.createRegistry({ maxNodes: 40000, maxLinks: 120000 }); gc2(); const h0 = process.memoryUsage().heapUsed;
    const trig = r0.signal(0), t = r0.signal(0); const sg = []; for (let i = 0; i < K; i++) sg.push(r0.signal(i)); let on = false;
    const C2 = r0.computed(() => { trig(); if (on) r0.dispose(C1); return 1; }); const C1 = r0.computed(() => { let v = trig() + C2(); for (let i = 0; i < K; i++) v += sg[i](); return v; });
    r0.effect(() => { trig(); C1(); t(); }); on = true; r0.batch(() => { trig.set(1); });
    gc2(); let res = "ok"; try { r0.destroy(); } catch (e) { res = e.name; }
    globalThis.__sink = r0; gc2(); await new Promise((q) => setTimeout(q, 20)); gc2();
    process.stdout.write(JSON.stringify({ destroy: res, retained: process.memoryUsage().heapUsed - h0 })); process.exit(0);
}
const r = S.createRegistry({ maxNodes: 4096, maxLinks: 16384 });
const gcs = { minor: 0, major: 0, other: 0 };
let counting = false;
new PerformanceObserver((l) => { if (!counting) return; for (const e of l.getEntries()) { const k = e.detail ? e.detail.kind : e.kind; if (k === constants.NODE_PERFORMANCE_GC_MINOR) gcs.minor++; else if (k === constants.NODE_PERFORMANCE_GC_MAJOR) gcs.major++; else gcs.other++; } }).observe({ entryTypes: ["gc"] });
globalThis.__sink = null;   // module-scope store: no dead-store elimination of anything the loop makes
function cycle() {
    const a = r.signal(0), s0 = r.signal(0); const bs = [];
    for (let i = 0; i < 100; i++) bs.push(r.signal(i));
    let on = false;
    const C2 = r.computed(() => { a(); if (on) for (let i = 0; i < 100; i++) r.dispose(bs[i]); return 1; });
    const C1 = r.computed(() => { const v = a(); for (let i = 0; i < 100; i++) bs[i](); C2(); return v; });
    const E = r.effect(() => { s0(); C1(); });
    on = true; r.batch(() => { s0.set(1); a.set(1); });
    r.dispose(E); r.dispose(C1); r.dispose(C2); r.dispose(a); r.dispose(s0);
    return r.stats().activeNodes;
}
cycle();                      // cycle 1: grows fixLog
for (let i = 0; i < 50; i++) cycle();   // warm
globalThis.gc(); globalThis.gc();
await new Promise((res) => setTimeout(res, 20));
const h0 = process.memoryUsage().heapUsed; counting = true;
let live = 0;
for (let i = 2; i <= CYC; i++) live += cycle();
globalThis.gc(); globalThis.gc();
const h1 = process.memoryUsage().heapUsed;
await new Promise((res) => setTimeout(res, 20)); counting = false;
process.stdout.write(JSON.stringify({ cycles: CYC - 1, liveNodesAfterCycles: live, retainedBytes: h1 - h0, gcs, activeNodes: r.stats().activeNodes }));
