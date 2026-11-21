// b127 A4 child. argv: engineFile cycles. Each cycle: the gc-child nested tree (300 log slots), dispose everything, then reset().
// Prints the sum of stats().activeNodes read after each cycle's disposes (liveNodes) and the final activeNodes.
import { pathToFileURL } from "node:url";
const S = await import(pathToFileURL(process.argv[2]).href);
const r = S.createRegistry({ maxNodes: 4096, maxLinks: 16384 });
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
let live = 0; const n = +process.argv[3];
for (let i = 0; i < n; i++) { live += cycle(); r.reset(); }
process.stdout.write(JSON.stringify({ cycles: n, liveNodes: live, activeNodes: r.stats().activeNodes }) + "\n");
