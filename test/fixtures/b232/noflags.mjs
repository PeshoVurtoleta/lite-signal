// noflags.mjs -- b232 (D-b231-1) OV-NOFLAGS cell child. node --jitless noflags.mjs <engine abs>
// Port of .handoff/b228/mutants/probe-noflags.mjs (b231), fresh process, fn pre-compiled. runWithOwner(liveX, FN) is entered at depth
// N - k, k = 0..400. Prints JSON {ranOk, ranThrew, notRan, cells:[{k, err, top}]}: cells = FN ran AND the call still threw a RangeError
// (only a call in runWithOwner's finally after FN returned can do that); the counts are the REACH evidence (the sweep crosses the edge).
import { pathToFileURL } from "node:url";
const S = await import(pathToFileURL(process.argv[2]).href);
function at(n, f) { if (n === 0) return f(); return at(n - 1, f); }
const noop = () => 0;
function limit() { let lo = 100, hi = 200000; while (lo < hi) { const mid = (lo + hi + 1) >> 1; let ok = true; try { at(mid, noop); } catch (e) { ok = false; } if (ok) lo = mid; else hi = mid - 1; } return lo; }
for (let i = 0; i < 3; i++) limit();
const r = S.createRegistry(); const X = r.effect(() => {}); r.runWithOwner(undefined, () => 0);   // warm runWithOwner with no owner (scoped false: never reaches the finally's call on any build)
let ran = false; const FN = () => { ran = true; return 5; }; FN();   // fn compiled at shallow depth: the only uncompiled call left on the path is the finally's
const cells = []; let ranOk = 0, notRan = 0;
for (let k = 0; k <= 400; k++) { ran = false; let e = null, ret; const N = limit();
  try { at(N - k, () => { try { ret = r.runWithOwner(X, FN); } catch (er) { e = er; } }); } catch (er) { e = e || er; }
  if (ran && e) cells.push({ k, err: e.constructor.name, top: String(e.stack).split("\n")[1].trim().split(" ")[1] }); else if (ran) ranOk++; else notRan++; }
process.stdout.write(JSON.stringify({ ranOk, ranThrew: cells.length, notRan, cells }));
