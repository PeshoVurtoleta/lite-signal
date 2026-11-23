// b127 A2 child (run with --single-threaded --expose-gc; refuses without --single-threaded, exit 3). argv: engineFile N mode(grow|quad).
// Opus probe fixlog-growth.mjs logic.
// grow: ONE depth-2 frame (C, inside effect E) creates, reads and disposes N signals; quad adds N prebuilt computeds read per iteration.
// Prints one JSON line: retained bytes (the JS heap space sum, js-heap.mjs) after the flush (+5 clean writes) and after reset(), the staged
// fixCursor counters if present, and rep = the REPORTED code / heapUsed / per-space deltas at both points (CI class 21).
import { pathToFileURL } from "node:url";
import { guard, snap, rep } from "./js-heap.mjs";
guard("grow-child");
const [file, Ns, mode] = process.argv.slice(2); const N = +Ns;
globalThis.__FX = { calls: 0, iters: 0 };
const S = await import(pathToFileURL(file).href);
const gc2 = () => { globalThis.gc(); globalThis.gc(); };
const r = S.createRegistry({ maxNodes: 1 << 16 });
const Ds = []; const t = r.signal(0);
if (mode === "quad") for (let i = 0; i < N; i++) { const q = r.signal(i); Ds.push(r.computed(() => q() + 1)); }
let on = false;
const C = r.computed(() => { t(); if (on) for (let i = 0; i < N; i++) { const s = r.signal(0); s(); r.dispose(s); if (mode === "quad") Ds[i](); } return 1; });
r.effect(() => { t(); C(); });
gc2(); const h0 = snap();
on = true; t.set(1); on = false;
for (let i = 0; i < 5; i++) t.set(10 + i);
gc2(); const h1 = snap();
r.reset(); gc2(); const h2 = snap();
globalThis.__sink = r;
process.stdout.write(JSON.stringify({ N, mode, calls: globalThis.__FX.calls, iters: globalThis.__FX.iters, retainedAfterFlushB: h1.js - h0.js, retainedAfterResetB: h2.js - h0.js, rep: { flush: rep(h0, h1), reset: rep(h0, h2) } }) + "\n");
