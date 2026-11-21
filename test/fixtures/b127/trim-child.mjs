// b127 A4 child (run with --expose-gc --max-old-space-size=2048). argv: engineFile mode(reset|destroy). The b123 3b shape (K = 10000):
// C2 (depth 3) disposes the suspended C1 (depth 2), which holds 10001 dep links -> 10001 logged drop entries (never read again).
// Then reset() or destroy(); the registry handle stays referenced; prints retained heap bytes (heapUsed after minus before the build).
import { pathToFileURL } from "node:url";
const [file, mode] = process.argv.slice(2);
const S = await import(pathToFileURL(file).href);
const gc2 = () => { globalThis.gc(); globalThis.gc(); };
const K = 10000; const r0 = S.createRegistry({ maxNodes: 40000, maxLinks: 120000 }); gc2(); const h0 = process.memoryUsage().heapUsed;
const trig = r0.signal(0), t = r0.signal(0); const sg = []; for (let i = 0; i < K; i++) sg.push(r0.signal(i)); let on = false;
const C2 = r0.computed(() => { trig(); if (on) r0.dispose(C1); return 1; });
const C1 = r0.computed(() => { let v = trig() + C2(); for (let i = 0; i < K; i++) v += sg[i](); return v; });
r0.effect(() => { trig(); C1(); t(); });
on = true; r0.batch(() => { trig.set(1); });
gc2(); let res = "ok";
try { if (mode === "reset") r0.reset(); else r0.destroy(); } catch (e) { res = e.name; }
globalThis.__sink = r0; globalThis.__sg = sg; gc2(); await new Promise((q) => setTimeout(q, 20)); gc2();
process.stdout.write(JSON.stringify({ mode, res, retained: process.memoryUsage().heapUsed - h0 }) + "\n");
