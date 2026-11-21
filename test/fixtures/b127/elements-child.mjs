// b127 A4 child for --trace-elements-transitions (NO natives flag). argv: engineFile. Sequence on ONE registry:
// grow / destroy / regrow / reset / regrow x3, where "grow" = the gc-child nested shape (C2 disposes 100 deps of the suspended C1: 300 log slots).
// mark() (mark.mjs) makes V8 print transitions located in mark.mjs before and after, so the test can cut the V8 line stream
// (V8 prints on its own stdio buffer; the child writes nothing to stdout) to exactly the window between the two markers.
import { pathToFileURL } from "node:url";
import { mark } from "./mark.mjs";
const S = await import(pathToFileURL(process.argv[2]).href);
const r = S.createRegistry({ maxNodes: 4096, maxLinks: 16384 });
function grow() {
    const a = r.signal(0), s0 = r.signal(0); const bs = [];
    for (let i = 0; i < 100; i++) bs.push(r.signal(i));
    let on = false;
    const C2 = r.computed(() => { a(); if (on) for (let i = 0; i < 100; i++) r.dispose(bs[i]); return 1; });
    const C1 = r.computed(() => { const v = a(); for (let i = 0; i < 100; i++) bs[i](); C2(); return v; });
    const E = r.effect(() => { s0(); C1(); });
    on = true; r.batch(() => { s0.set(1); a.set(1); });
    r.dispose(E); r.dispose(C1); r.dispose(C2); r.dispose(a); r.dispose(s0);
}
mark();
grow(); r.destroy(); grow(); r.reset(); grow(); grow(); grow();
mark();
process.stderr.write(JSON.stringify({ done: true, activeNodes: r.stats().activeNodes }) + "\n");
