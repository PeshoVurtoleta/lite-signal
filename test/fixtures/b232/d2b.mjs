// d2b.mjs -- b232 (D-b231-1) OV-D2B / OV-SOLATE cell child. node --jitless d2b.mjs <engine abs> <none|RE|RC> <grow|throw> <k0> <k1>
// Port of .handoff/b228/mutants/probe-d2b.mjs (b231). One (arm, pol) per process: the windows are lazy-compile stack checks of
// scopeOwned's FIRST call (consumed once per process). Prints JSON {cells:[{k, site, armed, gap, end}]}; the parent judges by SITE.
// arm = one throwing re-run cleanup (RE effect / RC computed); strand = effect X disposes itself inside runWithOwner(O) entered at
// depth N - k (site "unpinOwn<-effectTail" = scopeOwned's first call overflows BEFORE the unlink); readout = depth-0 gap
// (creates - free0 until the pool grows): 1 = the stranded slot was handed out, 0 = releasePinned refused (CapacityError one early under "throw").
import { pathToFileURL } from "node:url";
const S = await import(pathToFileURL(process.argv[2]).href);
const ARM0 = process.argv[3], POL0 = process.argv[4], K0 = +process.argv[5], K1 = +process.argv[6];
function at(n, f) { if (n === 0) return f(); return at(n - 1, f); }
const noop = () => 0;
function limit() { let lo = 100, hi = 200000; while (lo < hi) { const mid = (lo + hi + 1) >> 1; let ok = true; try { at(mid, noop); } catch (e) { ok = false; } if (ok) lo = mid; else hi = mid - 1; } return lo; }
for (let i = 0; i < 3; i++) limit();
const frameFn = (ln) => { const m = /^\s*at (?:async )?(?:new )?(.*?)(?: \(.*)?$/.exec(ln); const n = m ? m[1] : ""; return n === "" || /^(file|node):|^\/|:\d+:\d+$/.test(n) ? "<anon>" : n.replace(/^(?:Object|Array|Function)\./, ""); };
const site = (e) => { const x = e && e.errors ? e.errors.find((q) => q instanceof RangeError) : e; return x instanceof RangeError ? String(x.stack).split("\n").slice(1, 3).map(frameFn).join("<-") : (e ? e.constructor.name : "none"); };
function gap(r) { const st0 = r.stats(), free0 = st0.nodePoolPopulation - st0.activeNodes; let c = 0; try { for (;;) { r.signal(0); c++; if (r.stats().nodePoolPopulation !== st0.nodePoolPopulation) break; if (c > free0 + 4) break; } } catch (e) { return { gap: c - free0, end: e.constructor.name }; } return { gap: c - free0, end: "grow" }; }
const ARM = {
    none: () => "-",
    RE: (r) => { const a = r.signal(0); let armed = false; r.effect(() => { a(); r.onCleanup(() => { if (armed) { armed = false; throw new Error("cRE"); } }); }); armed = true; try { a.set(1); } catch (e) { return site(e); } return "no-throw"; },
    RC: (r) => { const a = r.signal(0); let armed = false; const X = r.computed(() => { a(); r.onCleanup(() => { if (armed) { armed = false; throw new Error("cRC"); } }); return 1; }); X(); armed = true; a.set(1); try { X(); } catch (e) { return "read:" + site(e); } return "cached"; },
};
// WARM (b231): run the no-scope self-dispose shape once at shallow depth, so every function on the strand path is compiled EXCEPT
// scopeOwned (first called inside unpinOwn only when a scope is open). The strand cells are then the lazy-compile stack checks of
// scopeOwned's first call, thrown in unpinOwn's frame BEFORE the unlink (site "unpinOwn<-effectTail"; probe-d2-strand.mjs effS).
{ const r = S.createRegistry(); const t = r.signal(0); let h = null; h = r.effect(() => { if (t() === 1 && h) h(); }); t.set(1); ARM.RE(r); ARM.RC(r); }
const out = { node: process.version, cells: [] };
// One (arm, pol) per process (env D2_ARM / D2_POL): scopeOwned compiles at the first call that fits, after which no later cell strands.
const ARMS = [ARM0], POLS = [POL0];
for (const pol of POLS) for (const arm of ARMS) for (let k = K0; k <= K1; k++) {
    const r = S.createRegistry({ onCapacityExceeded: pol }); const a = ARM[arm](r);
    const t = r.signal(0); const O = r.effect(() => {}); let h = null; h = r.effect(() => { if (t() === 1 && h) h(); });
    const N = limit(); let s = null; try { at(N - k, () => { try { r.runWithOwner(O, () => t.set(1)); } catch (e) { s = e; } }); } catch (e) { s = s || e; }
    const st = s === null ? "none" : site(s); if (st === "none" || /^<anon><-at/.test(st)) continue;
    out.cells.push({ pol, arm, armed: a, k, site: st, ...gap(r) });
}
process.stdout.write(JSON.stringify(out));
