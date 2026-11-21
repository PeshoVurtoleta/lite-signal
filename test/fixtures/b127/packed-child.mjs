// b127 A4 FALLBACK child (run with --allow-natives-syntax). argv: engineFile. The engine copy is staged to expose its log as
// globalThis.__FIXLOG. Same sequence as elements-child.mjs; after each step records { len, packed } of the log
// (packed = %HasFastPackedElements). Prints one JSON line.
import { pathToFileURL } from "node:url";
const S = await import(pathToFileURL(process.argv[2]).href);
const r = S.createRegistry({ maxNodes: 4096, maxLinks: 16384 });
const L = globalThis.__FIXLOG;
const steps = [];
const snap = (name) => steps.push({ name, len: L.length, packed: !!%HasFastPackedElements(L) });
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
snap("start");
grow(); snap("grow1"); r.destroy(); snap("destroy"); grow(); snap("regrow1"); r.reset(); snap("reset");
grow(); snap("regrow2"); grow(); snap("regrow3"); grow(); snap("regrow4");
process.stdout.write(JSON.stringify({ steps }) + "\n");
