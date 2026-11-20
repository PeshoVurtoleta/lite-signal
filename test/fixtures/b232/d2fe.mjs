// d2fe.mjs -- b232 (D-b231-1) OV-D2FE cell child. node --jitless d2fe.mjs <engine abs> <FE|FC> <k1> <k2> <grow|throw>
// Port of .handoff/b228/mutants/probe-d2fe.mjs (b231). ONE cell per process (both windows are first-call lazy-compile stack checks).
// A = the first-run arm at depth N - k1 (FE: deferred-scheduler effect; FC: computed read); B = the effS strand at N - k2
// (unpinOwn<-effectTail). Prints one JSON line {k1, A, B, gap:[n, end]}; the parent judges by the A and B SITES.
import { pathToFileURL } from "node:url";
const S = await import(pathToFileURL(process.argv[2]).href);
const ARM = process.argv[3], K1 = +process.argv[4], K2 = +process.argv[5], POL = process.argv[6];
function at(n, f) { if (n === 0) return f(); return at(n - 1, f); }
const noop = () => 0;
function limit() { let lo = 100, hi = 200000; while (lo < hi) { const mid = (lo + hi + 1) >> 1; let ok = true; try { at(mid, noop); } catch (e) { ok = false; } if (ok) lo = mid; else hi = mid - 1; } return lo; }
for (let i = 0; i < 3; i++) limit();
const frameFn = (ln) => { const m = /^\s*at (?:async )?(?:new )?(.*?)(?: \(.*)?$/.exec(ln); const n = m ? m[1] : ""; return n === "" || /^(file|node):|^\/|:\d+:\d+$/.test(n) ? "<anon>" : n.replace(/^(?:Object|Array|Function)\./, ""); };
const site = (e) => { const x = e && e.errors ? e.errors.find((q) => q instanceof RangeError) : e; return x instanceof RangeError ? String(x.stack).split("\n").slice(1, 3).map(frameFn).join("<-") : (e ? e.constructor.name : "none"); };
function gap(r) { const st0 = r.stats(), free0 = st0.nodePoolPopulation - st0.activeNodes; let c = 0; try { for (;;) { r.signal(0); c++; if (r.stats().nodePoolPopulation !== st0.nodePoolPopulation) break; if (c > free0 + 4) break; } } catch (e) { return [c - free0, e.constructor.name]; } return [c - free0, "grow"]; }
{ const r = S.createRegistry(); const t = r.signal(0); let h = null; h = r.effect(() => { if (t() === 1 && h) h(); }); t.set(1); }   // warm (no scope)
const r = S.createRegistry({ onCapacityExceeded: POL });
let sa = null;
if (ARM === "FE") { const q = []; const X = r.effect(() => {}, { scheduler: (run) => q.push(run) }); r.runWithOwner(X, () => r.onCleanup(() => {})); const N = limit(); try { at(N - K1, () => { try { q.shift()(); } catch (e) { sa = e; } }); } catch (e) { sa = sa || e; } }
else { const X = r.computed(() => 1); r.runWithOwner(X, () => r.onCleanup(() => {})); const N = limit(); try { at(N - K1, () => { try { X(); } catch (e) { sa = e; } }); } catch (e) { sa = sa || e; } }
const t = r.signal(0); const O = r.effect(() => {}); let h = null; h = r.effect(() => { if (t() === 1 && h) h(); });
let sb = null; { const N = limit(); try { at(N - K2, () => { try { r.runWithOwner(O, () => t.set(1)); } catch (e) { sb = e; } }); } catch (e) { sb = sb || e; } }
process.stdout.write(JSON.stringify({ k1: K1, A: sa === null ? "none" : site(sa), B: sb === null ? "none" : site(sb), gap: gap(r) }) + "\n");
