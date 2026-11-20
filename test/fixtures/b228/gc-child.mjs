// gc-child.mjs -- b230 U3 B2 A-ZGC (deterministic counts only; no timing). Run:
//   node --expose-gc --single-threaded --max-old-space-size=512 gc-child.mjs <engine Signal.js>
// JS heap spaces only; the diagnostic loop is WARMED (20000 clean + 20000 plant cycles) OUTSIDE every bracket; gc + settle before each
// window; per window: majors, scavenges, B/op = (h1 - h0) / cycles. The plant stores one 5-field object per cycle to MODULE scope
// (an object stored to a dead local is escape-eliminated after OSR). B/op comes from 1e4-cycle collection-free windows (a window
// with scavenges under-reads), scavenges from 1e5-cycle windows (b229 U2 correction; .handoff/b228/u2/out/new/gc-engine-*.json).
import { pathToFileURL } from "node:url";
import { getHeapSpaceStatistics } from "node:v8";
import { PerformanceObserver, constants as PC } from "node:perf_hooks";
if (typeof globalThis.gc !== "function" || !process.execArgv.includes("--single-threaded")) { console.error("need --expose-gc --single-threaded"); process.exit(3); }
const M = await import(pathToFileURL(process.argv[2]).href);
const JS = ["new_space", "old_space", "new_large_object_space", "large_object_space"];
const spaces = () => { let u = 0; for (const s of getHeapSpaceStatistics()) if (JS.includes(s.space_name)) u += s.space_used_size; return u; };
let majors = 0, scav = 0;
new PerformanceObserver((l) => { for (const en of l.getEntries()) { if (en.detail && en.detail.kind === PC.NODE_PERFORMANCE_GC_MAJOR) majors++; else scav++; } }).observe({ entryTypes: ["gc"] });
const tick = () => new Promise((res) => setTimeout(res, 15));
export let sink = null;   // module scope: the plant's store is observable
const r = M.createRegistry(); const s = r.signal(0); const c = r.computed(() => s() * 2);
let seen = 0; r.effect(() => { seen = (seen + c()) | 0; });   // int32: a sum past 2^31 would box (harness, not engine)
let i = 0;
const loop = (n, plant) => { for (let k = 0; k < n; k++) { s.set(++i); seen = (seen + c()) | 0; if (plant) sink = { a: i, b: i, c: i, d: i, e: i }; } };
loop(20000, false); loop(20000, true);
async function win(n, plant) { globalThis.gc(); await tick(); const sc0 = scav, mj0 = majors, h0 = spaces(); loop(n, plant); const h1 = spaces(); await tick(); return { bop: +((h1 - h0) / n).toFixed(4), scav: scav - sc0, major: majors - mj0 }; }
const eng = [], plant1e5 = [], plant1e4 = [];
for (let k = 0; k < 3; k++) { eng.push(await win(100000, false)); plant1e5.push(await win(100000, true)); plant1e4.push(await win(10000, true)); }
console.log(JSON.stringify({ node: process.version, eng, plant1e5, plant1e4, seenOk: seen !== 0 }));
