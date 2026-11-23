// b127 A2 child (run with --single-threaded --expose-gc; refuses without --single-threaded, exit 3). argv: engineFile shape(flat|deep)
// [children, default 4000]. Neon probe-d1-d2.mjs PROBE 1 logic.
// 4000 computeds, each reads 20 deps and disposes itself while its frame is live. flat: created straight in effect E (depth 2);
// deep: built in the effect's FIRST run (no flush pre-walk, which would refresh C at depth 1): E depth 1 reads computed C (depth 2), whose children run at depth 3 with restores at k = 2, so no k === 1 clear between them.
// Prints retained bytes (the JS heap space sum, js-heap.mjs) before destroy() (registry alive, effect stopped) and after destroy() (registry
// still referenced), and rep = the REPORTED code / heapUsed / per-space deltas at both points (CI class 21).
import { pathToFileURL } from "node:url";
import { guard, snap, rep } from "./js-heap.mjs";
guard("d1-child");
const [file, shape, nch] = process.argv.slice(2); const NCH = +(nch || 4000);
const S = await import(pathToFileURL(file).href);
const gc2 = () => { globalThis.gc(); globalThis.gc(); };
const reg = S.createRegistry({ onCapacityExceeded: "grow" });
const trig = reg.signal(0); const deps = []; for (let i = 0; i < 20; i++) deps.push(reg.signal(i));
globalThis.__deps = deps;
gc2(); const h0 = snap();
let seen = 0;
const body = () => { for (let i = 0; i < NCH; i++) { const c = reg.computed(() => { let sum = 0; for (let j = 0; j < deps.length; j++) sum += deps[j](); reg.dispose(c); return sum; }); seen += c(); } };
let stop;
if (shape === "deep") { const C = reg.computed(() => { body(); return 1; }); stop = reg.effect(() => { C(); }); }
else stop = reg.effect(() => { trig(); if (trig() === 0) return; body(); });
trig.set(1);
stop();
gc2(); const h1 = snap();
reg.destroy();
gc2(); const h2 = snap();
globalThis.__sink = reg;
process.stdout.write(JSON.stringify({ shape, preDestroyB: h1.js - h0.js, postDestroyB: h2.js - h0.js, seen, rep: { pre: rep(h0, h1), post: rep(h0, h2) } }) + "\n");
