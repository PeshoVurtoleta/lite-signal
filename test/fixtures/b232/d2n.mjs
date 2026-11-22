// d2n.mjs -- b245 XA6 TASK 4 (D-b240-7) OV-D2N cell child. node --jitless d2n.mjs <engine abs> <FE|FC|RE|RC> <grow|throw> <k0> <k1>
// d2b.mjs with NORMAL-exit arms (port of .handoff/b245/xa6/probe/d2n.mjs, B0): each arm's cleanup runs and does NOT throw, so the arm
// leaves through its `armDepth--;   // R1bNZ: normal exit` line (FE firstRunCleanupE, FC firstRunCleanupC, RE rerunCleanupEffect,
// RC rerunCleanupComputed). Then the effS strand sweep k0..k1 (site "unpinOwn<-effectTail" = scopeOwned's FIRST call overflows inside
// unpinOwn before the unlink; one (arm, pol) per process, the window is consumed once) and the depth-0 gap readout (creates - free0
// until the pool grows): 1 / 0 CapacityError = coded; 0 / -1 = the arm left armDepth at 1, so releasePinned refused the stranded slot.
// armed = "<arm>:<cleanup runs>" (the cleanup executed; "<arm>:threw:<site>" if the arm itself threw). Prints JSON {cells:[...]}; the
// parent judges by SITE. Argument errors throw with the "stage: " prefix (the battery's ANCHOR filter, LEDGER #82 (5)).
import { pathToFileURL } from "node:url";
const ARM0 = process.argv[3], POL0 = process.argv[4], K0 = +process.argv[5], K1 = +process.argv[6];
if (!["FE", "FC", "RE", "RC"].includes(ARM0)) throw new Error("stage: d2n: unknown arm " + ARM0);
if (POL0 !== "grow" && POL0 !== "throw") throw new Error("stage: d2n: unknown policy " + POL0);
if (!Number.isInteger(K0) || !Number.isInteger(K1) || K0 > K1) throw new Error("stage: d2n: bad k range " + process.argv[5] + ".." + process.argv[6]);
const S = await import(pathToFileURL(process.argv[2]).href);
function at(n, f) { if (n === 0) return f(); return at(n - 1, f); }
const noop = () => 0;
function limit() { let lo = 100, hi = 200000; while (lo < hi) { const mid = (lo + hi + 1) >> 1; let ok = true; try { at(mid, noop); } catch (e) { ok = false; } if (ok) lo = mid; else hi = mid - 1; } return lo; }
for (let i = 0; i < 3; i++) limit();
const frameFn = (ln) => { const m = /^\s*at (?:async )?(?:new )?(.*?)(?: \(.*)?$/.exec(ln); const n = m ? m[1] : ""; return n === "" || /^(file|node):|^\/|:\d+:\d+$/.test(n) ? "<anon>" : n.replace(/^(?:Object|Array|Function)\./, ""); };
const site = (e) => { const x = e && e.errors ? e.errors.find((q) => q instanceof RangeError) : e; return x instanceof RangeError ? String(x.stack).split("\n").slice(1, 3).map(frameFn).join("<-") : (e ? e.constructor.name : "none"); };
function gap(r) { const st0 = r.stats(), free0 = st0.nodePoolPopulation - st0.activeNodes; let c = 0; try { for (;;) { r.signal(0); c++; if (r.stats().nodePoolPopulation !== st0.nodePoolPopulation) break; if (c > free0 + 4) break; } } catch (e) { return { gap: c - free0, end: e.constructor.name }; } return { gap: c - free0, end: "grow" }; }
let runs = 0; const cb = () => { runs++; };
const ARM = {
    // RE: effect re-run with a cleanup -> runCleanupE -> rerunCleanupEffect, normal exit (3rd anchor)
    RE: (r) => { runs = 0; const a = r.signal(0); r.effect(() => { a(); r.onCleanup(cb); }); try { a.set(1); } catch (e) { return "RE:threw:" + site(e); } return "RE:" + runs; },
    // RC: computed re-run with a cleanup -> runCleanupC -> rerunCleanupComputed, normal exit (4th anchor)
    RC: (r) => { runs = 0; const a = r.signal(0); const X = r.computed(() => { a(); r.onCleanup(cb); return 1; }); X(); a.set(1); try { X(); } catch (e) { return "RC:threw:" + site(e); } return "RC:" + runs; },
    // FE: deferred-scheduler effect, cleanup attached before its first run -> rerunCleanupEffect -> firstRunCleanupE, normal exit (1st)
    FE: (r) => { runs = 0; const q = []; const X = r.effect(() => {}, { scheduler: (run) => q.push(run) }); r.runWithOwner(X, () => r.onCleanup(cb)); try { q.shift()(); } catch (e) { return "FE:threw:" + site(e); } return "FE:" + runs; },
    // FC: never-evaluated computed, cleanup attached first -> rerunCleanupComputed -> firstRunCleanupC, normal exit (2nd)
    FC: (r) => { runs = 0; const X = r.computed(() => 1); r.runWithOwner(X, () => r.onCleanup(cb)); try { X(); } catch (e) { return "FC:threw:" + site(e); } return "FC:" + runs; },
};
// WARM: the no-scope self-dispose shape + all four normal arms at shallow depth (no scope open: scopeOwned stays uncompiled).
{ const r = S.createRegistry(); const t = r.signal(0); let h = null; h = r.effect(() => { if (t() === 1 && h) h(); }); t.set(1); ARM.RE(r); ARM.RC(r); ARM.FE(r); ARM.FC(r); }
const out = { node: process.version, cells: [] };
for (let k = K0; k <= K1; k++) {
    const r = S.createRegistry({ onCapacityExceeded: POL0 }); const a = ARM[ARM0](r);
    const t = r.signal(0); const O = r.effect(() => {}); let h = null; h = r.effect(() => { if (t() === 1 && h) h(); });
    const N = limit(); let s = null; try { at(N - k, () => { try { r.runWithOwner(O, () => t.set(1)); } catch (e) { s = e; } }); } catch (e) { s = s || e; }
    const st = s === null ? "none" : site(s); if (st === "none" || /^<anon><-at/.test(st)) continue;
    out.cells.push({ pol: POL0, arm: ARM0, armed: a, k, site: st, ...gap(r) });
}
process.stdout.write(JSON.stringify(out));
