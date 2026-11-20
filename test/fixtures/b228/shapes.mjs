// shapes.mjs -- b230 U3 B1 (F-b224-1 ALL3x). Drivers PORTED from the b225-b227 research files
// (.handoff/research/pinned-slots/census.mjs, r1c/census-r1c.mjs, r1c/haz0.mjs, scope/census-scope.mjs, r1d/R0/sched2.mjs,
// r1d/R7/r7b.mjs). Each takes an engine MODULE (E, loaded from a path by test/124) and returns the tuple
//   { iters, ce, pool, hw, reached, log }
// iters = completed iterations; ce = iteration at which a CapacityError stopped the row (null = none); pool =
// stats().nodePoolPopulation; hw = high-water of (pinnedHead + scopePinHead) length; reached = pin events (a slot disposed
// while running or while scope-owned) -- or the row's own reach counter, named per driver; log = the row's checksum / text.
// hw / pins / unpins come from the stage.mjs counter hooks (globalThis.__B230); a row against an engine without the hooks
// gets hw undefined and its tuple deepEqual fails (never skips).
const H = () => globalThis.__B230;
const hreset = () => { const h = H(); h.pins = 0; h.unpins = 0; h.hw = 0; for (const k of Object.keys(h.hit)) h.hit[k] = 0; };
const hget = () => { const h = H(); return { pins: h.pins, unpins: h.unpins, hw: h.hw }; };
let ck = 0, nf = 0;
const fold = (v) => { nf++; const x = typeof v === "number" ? (v | 0) : v === undefined ? 0x55aa : 0x77; ck = Math.imul(ck ^ x, 16777619) >>> 0; };
const num = (v) => typeof v === "number" ? v : v === undefined ? -1 : -2;
const exp = (f) => { try { return f(); } catch (e) { if (e && e.name === "CapacityError") throw e; fold(0x1111); return undefined; } };
const ERR = new Error("p7throw");
const N = 5000;

// ---- census.mjs patterns (REGR) ----
export const REGR = {};
const P = REGR;
P.P1 = (r, s) => (i) => { const h = { c: null }; h.c = r.computed(() => { fold(s()); const inner = r.computed(() => { fold(s()); r.dispose(h.c); return 1; }); return inner() + 1; }); fold(h.c()); };
P.P2 = (r, s) => (i) => { let c = null; c = r.computed(() => { const v = s(); fold(v); r.dispose(c); return v + (i & 7); }); fold(c()); };
P.P2e = (r, s) => ({ wrap: "effect", it: P.P2(r, s) });
P.P2c = (r, s) => ({ wrap: "computed", it: P.P2(r, s) });
const p3 = (r, s) => { const b = { d: null, t: null }; b.d = r.effect(() => { fold(s()); b.d(); }, { scheduler: (run) => { b.t = run; } }); if (b.t) b.t(); else fold(0x3333); };
P.P3 = (r, s) => (i) => p3(r, s);
P.P3c = (r, s) => (i) => { const w = r.computed(() => { fold(s()); p3(r, s); return 2; }); fold(w()); r.dispose(w); };
P.P4 = (r, s) => (i) => { const h = { c: null }; h.c = r.computed(() => { fold(s()); const p = r.computed(() => { fold(s()); const c = r.computed(() => { fold(s()); r.dispose(h.c); return 1; }); return c() + 1; }); return p() + 1; }); fold(h.c()); };
P.P5u = (r, s) => (i) => { let c = null; c = r.computed(() => { const v = s(); fold(v); r.untrack(() => r.dispose(c)); return v + 1; }); fold(c()); };
P.P5r = (r, s) => (i) => { let c = null; c = r.computed(() => { const v = s(); fold(v); r.createRoot(() => r.dispose(c)); return v + 2; }); fold(c()); };
P.P5b = (r, s) => ({ wrap: "batch", it: P.P1(r, s) });
P.P6 = (r, s) => { r.effect(() => fold(s())); return P.P1(r, s); };
for (const k of [1, 64, 512]) P["P6w" + k] = (r, s) => { r.effect(() => fold(s())); const f = P.P1(r, s); return (i) => { f(i); if ((i % k) === k - 1) s.set(i & 1023); }; };
P.P7 = (r, s) => (i) => { const O = r.computed(() => { fold(s()); return r.getOwner(); }); const h = O(); fold(h === undefined ? 0 : 1);
  r.runWithOwner(h, () => { r.dispose(O); const x = r.computed(() => s() + 3); fold(x()); r.dispose(x); }); };
P["P-REUSE"] = (r, s) => (i) => { let c = null; c = r.computed(() => { const v = s(); fold(v); r.dispose(c); const n = r.computed(() => s() + 1); const w = n(); fold(w); r.dispose(n); return v + w; }); fold(c()); };
P["P-NEST"] = (r, s) => (i) => { const h = { c: null }; h.c = r.computed(() => { fold(s()); const inner = r.computed(() => { fold(s()); r.dispose(h.c); return 1; }); const a = inner(); const n = r.computed(() => s() + 2); const b = n(); fold(b); r.dispose(n); return a + b; }); fold(h.c()); };
P["P-NEST2"] = (r, s) => (i) => { const h = { c: null }; h.c = r.computed(() => { fold(s()); const inner = r.computed(() => { fold(s()); r.dispose(h.c); return 1; }); const a = inner(); const n1 = r.computed(() => s() + 2); const n2 = r.computed(() => s() + 5); const b = n1() + n2(); fold(b); r.dispose(n1); r.dispose(n2); return a + b; }); fold(h.c()); };

// ---- census-scope.mjs patterns (SCOPE; P7 is REGR's) ----
export const SCOPE = {};
const S = SCOPE;
const owner = (r, s) => { const O = r.computed(() => { fold(s()); return r.getOwner(); }); const h = O(); fold(h === undefined ? 0 : 1); return [O, h]; };
S.P7 = P.P7;
S.P7e = (r, s) => ({ wrap: "effect", it: P.P7(r, s) });
S.P7run = (r, s) => (i) => { const h = { X: null };
  h.X = r.computed(() => { const v = s(); fold(v); const own = r.getOwner(); r.runWithOwner(own, () => { r.dispose(h.X); });
    const a = r.computed(() => s() + 1), b = r.computed(() => s() + 2); const w = a() + b(); fold(w); r.dispose(a); r.dispose(b); return v + w; });
  fold(h.X()); };
S.P7enc = (r, s) => { const t = r.signal(0); return (i) => { const h = { X: null, arm: false };
  h.X = r.computed(() => { const v = t(); fold(v); if (h.arm) r.dispose(h.X); return r.getOwner(); });
  const own = h.X(); fold(own === undefined ? 0 : 1); t.set(i + 1);
  r.runWithOwner(own, () => { h.arm = true; const o2 = h.X(); fold(o2 === undefined ? 0 : 1); const z = r.computed(() => s() + 4); fold(z()); r.dispose(z); }); }; };
S.P7nest = (r, s) => (i) => { const [O, h] = owner(r, s);
  r.runWithOwner(h, () => { r.runWithOwner(h, () => { r.dispose(O); }); const y = r.computed(() => s() + 6); fold(y()); r.dispose(y); }); };
S.P7cross = (r, s) => (i) => { const [O, hO] = owner(r, s); const [Y, hY] = owner(r, s);
  r.runWithOwner(hO, () => { r.runWithOwner(hY, () => { r.dispose(O); }); const z = r.computed(() => s() + 7); fold(z()); r.dispose(z); });
  r.dispose(Y); };
S.P7throw = (r, s) => (i) => { const [O, h] = owner(r, s); let got = null;
  try { r.runWithOwner(h, () => { r.dispose(O); throw ERR; }); } catch (e) { got = e; }
  fold(got === ERR ? 1 : 2); const x = r.computed(() => s() + 3); fold(x()); r.dispose(x); };
S.P7cleanup = (r, s) => { const t = r.signal(0); return (i) => { const h = { X: null, arm: false };
  h.X = r.computed(() => { const v = t(); fold(v); r.onCleanup(() => { if (h.arm) r.dispose(h.X); }); return r.getOwner(); });
  const own = h.X(); fold(own === undefined ? 0 : 1); t.set(i + 1);
  r.runWithOwner(own, () => { h.arm = true; const o2 = h.X(); fold(o2 === undefined ? 0 : 1); const z = r.computed(() => s() + 8); fold(z()); r.dispose(z); }); }; };

// ---- census-r1c.mjs patterns (R1C); loop inside ONE long-lived effect body (depth >= 1) unless "-top" ----
export const R1C = {};
const Q = R1C;
const W = (it) => ({ wrap: "effect", it });
const mk2 = (r, s) => { const n1 = r.computed(() => s() + 2), n2 = r.computed(() => s() + 5); fold(num(exp(() => n1())) + num(exp(() => n2()))); r.dispose(n1); r.dispose(n2); };
const pcl = (r, s, t) => () => { let c = null; c = r.computed(() => { const v = s() + t(); fold(v); r.onCleanup(() => r.dispose(c)); return 1; }); fold(num(exp(() => c()))); t.set(t.peek() + 1); fold(num(exp(() => c()))); };
const pclEff = (r, s, t) => () => { let e = null; e = r.effect(() => { fold(s() + t()); r.onCleanup(() => e()); }, { scheduler: (run) => { run(); } }); r.untrack(() => t.set(t.peek() + 1)); };
Q.PCL = (r, s) => W(pcl(r, s, r.signal(0)));
Q.PCLfirst = (r, s) => W(() => { let c = null; c = r.computed(() => { fold(s()); return 1; }); r.runWithOwner(c, () => r.onCleanup(() => r.dispose(c))); fold(num(exp(() => c()))); });
Q.PCLeff = (r, s) => W(pclEff(r, s, r.signal(0)));
Q["PCL-top"] = (r, s) => pcl(r, s, r.signal(0));
Q["PCLeff-top"] = (r, s) => pclEff(r, s, r.signal(0));
Q.PCLthrow = (r, s) => { const t = r.signal(0); return W(() => { let c = null; c = r.computed(() => { fold(s() + t()); r.onCleanup(() => { r.dispose(c); throw new Error("pclthrow"); }); return 1; }); fold(num(exp(() => c()))); t.set(t.peek() + 1); fold(num(exp(() => c()))); }); };
Q.PCLthrowE = (r, s) => { const t = r.signal(0); return W(() => { let e = null; e = r.effect(() => { fold(s() + t()); r.onCleanup(() => { e(); throw new Error("pclthrowE"); }); }, { scheduler: (run) => { try { run(); } catch (err) { if (err && err.name === "CapacityError") throw err; fold(0x2222); } } }); r.untrack(() => t.set(t.peek() + 1)); }); };
Q.PCLchild = (r, s) => { const t = r.signal(0); return W(() => { let X = null; X = r.computed(() => { fold(s() + t()); const ch = r.computed(() => { r.onCleanup(() => r.dispose(X)); return 1; }); return num(ch()) + 1; }); fold(num(exp(() => X()))); t.set(t.peek() + 1); fold(num(exp(() => X()))); }); };
Q.PCLchildE = (r, s) => { const t = r.signal(0); return W(() => { let X = null; X = r.effect(() => { fold(s() + t()); const ch = r.computed(() => { r.onCleanup(() => X()); return 1; }); fold(num(ch())); }, { scheduler: (run) => { run(); } }); r.untrack(() => t.set(t.peek() + 1)); }); };
Q["PCLchild-make"] = (r, s) => { const t = r.signal(0); return W(() => { let X = null; X = r.computed(() => { fold(s() + t()); const ch = r.computed(() => { r.onCleanup(() => { r.dispose(X); mk2(r, s); }); return 1; }); return num(ch()) + 1; }); fold(num(exp(() => X()))); t.set(t.peek() + 1); fold(num(exp(() => X()))); }); };
Q.PCLEfirst = (r, s) => W(() => { let run = null; const e = r.effect(() => { fold(s()); }, { scheduler: (rn) => { run = rn; } }); r.runWithOwner(e, () => r.onCleanup(() => e())); if (run !== null) exp(run); else fold(0x3333); });
Q["PCLCfirst-throw"] = (r, s) => W(() => { let c = null; c = r.computed(() => { fold(s()); return 1; }); r.runWithOwner(c, () => { r.onCleanup(() => r.dispose(c)); r.onCleanup(() => { throw new Error("cf"); }); }); fold(num(exp(() => c()))); });
Q.PFB = (r, s) => W(() => { let c = null; c = r.computed(() => { fold(s()); r.dispose(c); mk2(r, s); return 1; }); r.runWithOwner(c, () => r.onCleanup(() => { throw new Error("pfb"); })); fold(num(exp(() => c()))); });
Q.PCLW = (r, s) => { const t = r.signal(0); return W(() => {
  let X = null; X = r.computed(() => { fold(s() + t()); r.onCleanup(() => r.dispose(X)); return 1; });
  fold(num(exp(() => X()))); t.set(t.peek() + 1);
  let w = null; w = r.computed(() => { r.dispose(w); fold(num(exp(() => X()))); mk2(r, s); return 1; });
  fold(num(exp(() => w())));
}); };

// One census row: the pattern table (REGR / SCOPE / R1C), the pattern name, the policy ("throw" = default registry, 1024).
export function censusRow(E, table, name, pol) {
  const r = E.createRegistry(pol === "grow" ? { onCapacityExceeded: "grow" } : undefined);
  hreset(); ck = 0; nf = 0;
  const s = r.signal(1);
  let i = 0, err = null, ce = null;
  const spec = table[name](r, s);
  const it = typeof spec === "function" ? spec : spec.it;
  const loop = () => { for (; i < N; i++) { try { it(i); } catch (e) { err = String(e && e.message); if (e && e.name === "CapacityError") ce = i; return; } } };
  try {
    if (typeof spec === "function") loop();
    else if (spec.wrap === "effect") { let once = false; r.effect(() => { fold(s()); if (once) return; once = true; loop(); }); }
    else if (spec.wrap === "computed") { const c = r.computed(() => { fold(s()); loop(); return 9; }); fold(c()); }
    else if (spec.wrap === "batch") r.batch(loop);
  } catch (e) { if (err === null) err = "OUTER " + String(e && e.message); }
  const st = r.stats(), h = hget();
  return { iters: i, ce, pool: st.nodePoolPopulation, hw: h.hw, reached: h.pins,
    log: { ck, nf, active: st.activeNodes, growths: st.poolGrowths, err: err === null ? null : err.slice(0, 60), unpins: h.unpins } };
}
// R1C rows run the loop inside a long-lived effect unless the pattern is a plain function (the "-top" rows): same runner as the
// research file (its `else` branch wraps in an effect for any non-function spec); the patterns above are W()-wrapped already.
export function r1cRow(E, name, pol) {
  const r = E.createRegistry(pol === "grow" ? { onCapacityExceeded: "grow" } : undefined);
  hreset(); ck = 0; nf = 0;
  const s = r.signal(1);
  let i = 0, err = null, ce = null;
  const spec = Q[name](r, s);
  const it = typeof spec === "function" ? spec : spec.it;
  const loop = () => { for (; i < N; i++) { try { it(i); } catch (e) { err = String(e && e.message); if (e && e.name === "CapacityError") ce = i; return; } } };
  try {
    if (typeof spec === "function") loop();
    else { let once = false; r.effect(() => { fold(s()); if (once) return; once = true; loop(); }); }
  } catch (e) { if (err === null) err = "OUTER " + String(e && e.message); }
  const st = r.stats(), h = hget();
  return { iters: i, ce, pool: st.nodePoolPopulation, hw: h.hw, reached: h.pins,
    log: { ck, nf, active: st.activeNodes, growths: st.poolGrowths, err: err === null ? null : err.slice(0, 60), unpins: h.unpins } };
}

// ---- haz0.mjs (HAZ0): exact-filled pool, X's re-run cleanup arm disposes X then creates Y (+ child Z) at depth 0 ----
export async function hazRow(E, kindX, fill) {
  const r = E.createRegistry({ onCapacityExceeded: "grow" });
  const log = [];
  const t = r.signal(0);
  let armed = false, Xh = null, Y = null, Z = null;
  const body = () => {
    const v = t(); log.push("X:run:" + v);
    r.effect(() => {
      r.onCleanup(() => {
        log.push("C1:cleanup");
        if (!armed) return;
        armed = false;
        if (kindX === "effect") Xh(); else r.dispose(Xh);
        log.push("X:disposed");
        Y = r.effect(() => {
          log.push("Y:run");
          r.onCleanup(() => log.push("Y:cleanup"));
          Z = r.computed(() => { r.onCleanup(() => log.push("Z:cleanup")); log.push("Z:run"); return 7; });
          log.push("Z=" + Z());
        });
        log.push("Y:created");
      });
    });
    return v;
  };
  if (kindX === "effect") Xh = r.effect(body);
  else { Xh = r.computed(body); r.effect(() => { log.push("R:" + Xh()); }); }
  let st = r.stats();
  if (fill) while (st.nodePoolPopulation - st.activeNodes > 0) { r.signal(0); st = r.stats(); }
  const before = { active: st.activeNodes, pool: st.nodePoolPopulation };
  hreset();
  armed = true;
  let err = null;
  try { t.set(1); } catch (e) { err = String(e && e.message).slice(0, 80); }
  await Promise.resolve(); await new Promise((res) => setTimeout(res, 0));
  log.push("--after flush");
  let zv; try { zv = Z ? Z() : "noZ"; } catch (e) { zv = "E:" + e.message; }
  log.push("Z()=" + zv);
  try { if (Y) { Y(); log.push("Y:disposed-by-test"); } } catch (e) { log.push("Ydispose E:" + e.message); }
  const h = hget();
  return { iters: 1, ce: err !== null && /capacity/i.test(err) ? 0 : null, pool: r.stats().nodePoolPopulation, hw: h.hw, reached: h.pins,
    log: { before, err, text: log.join(" | "), after: r.stats().activeNodes } };
}

// ---- sched2.mjs (R0): flushEffects' catch vs a disposed + recycled entry slot ----
function mkY(r, u, log, kind) {
  if (kind === "eff") return r.effect(() => { log.push("Y:" + u()); });
  if (kind === "cfirst") { const c = r.computed(() => u() + 0); return r.effect(() => { log.push("Y:" + c()); }); }
  return r.effect(() => { const c = r.computed(() => u() + 0); log.push("Y:" + c()); });   // efirst
}
// reached = the armed branch executed (scheduler / cleanup arm took the dispose-create-write path) -- 1 expected.
export function schedRow(E, route, kind, pol, noThrow) {
  const r = pol === "grow" ? E.createRegistry({ onCapacityExceeded: "grow" }) : E.createRegistry();
  const log = [];
  const t = r.signal(0), u = r.signal(0);
  let armed = false, Xh = null, reached = 0;
  if (route === "arm") {
    Xh = r.effect(() => {
      const v = t(); log.push("X:" + v);
      r.effect(() => { r.onCleanup(() => {
        if (!armed) return;
        armed = false; reached++; Xh(); mkY(r, u, log, kind); u.set(1);
        throw new Error("arm");
      }); });
    });
    let st = r.stats();
    while (st.nodePoolPopulation - st.activeNodes > 0) { r.signal(0); st = r.stats(); }   // exact fill (haz0.mjs)
  } else if (route === "f21c") {
    const sched = (thunk) => { if (!armed) { thunk(); return; } armed = false; reached++; thunk(); t.set(2); throw new Error("sched"); };
    Xh = r.effect(() => { log.push("X:" + t()); }, { scheduler: sched });
  } else {
    const sched = (thunk) => {
      if (!armed) { thunk(); return; }
      armed = false; reached++;
      if (route === "direct") Xh(); else thunk();
      mkY(r, u, log, kind);
      u.set(1);
      if (!noThrow) throw new Error("sched");
    };
    Xh = r.effect(() => {
      const v = t(); log.push("X:" + v);
      if (route === "cleanup") r.onCleanup(() => { if (v === 0 && armed === false && Xh) Xh(); });
      if (route === "body" && v === 1) Xh();
    }, { scheduler: sched });
  }
  hreset();
  armed = true;
  let err = null, ce = null;
  try { t.set(1); } catch (e) { err = (e && e.name === "CapacityError" ? "CE:" : "") + String(e && e.message).slice(0, 40); if (e && e.name === "CapacityError") ce = 1; }
  log.push("--after");
  if (route === "f21c") t.set(3); else u.set(2);
  const L = log.join(" "), cut = L.indexOf("--after");
  const out = { err, text: L, active: r.stats().activeNodes };
  if (route === "f21c") { out.X2 = L.slice(0, cut).includes("X:2"); out.X3 = L.slice(cut).includes("X:3"); }
  else { out.Y1 = L.slice(0, cut).includes("Y:1"); out.Y2 = L.slice(cut).includes("Y:2"); }
  const h = hget();
  return { iters: 1, ce, pool: r.stats().nodePoolPopulation, hw: h.hw, reached, log: out };
}
export const SCHED_ROWS = [];
for (const pol of ["grow", "throw"]) {
  for (const route of ["body", "cleanup", "direct", "arm"]) for (const kind of ["eff", "cfirst", "efirst"]) SCHED_ROWS.push({ id: route + "-" + kind + "/" + pol, route, kind, pol, noThrow: false });
  SCHED_ROWS.push({ id: "f21c/" + pol, route: "f21c", kind: "eff", pol, noThrow: false });
  SCHED_ROWS.push({ id: "nothrow-body/" + pol, route: "body", kind: "eff", pol, noThrow: true });
}

// ---- r7b.mjs (R7): X disposed by a 1->0 onDisconnect inside severStale ----
const isDc = (e) => { if (!e) return false; if (/dc/.test(String(e.message))) return true; if (Array.isArray(e.errors)) return e.errors.some(isDc); return false; };
const isPre = (e) => { if (!e) return false; if (/^pre$/.test(String(e.message))) return true; if (Array.isArray(e.errors)) return e.errors.length > 0 && e.errors.every(isPre); return false; };
const isCE = (e) => e && (e.name === "CapacityError" || (Array.isArray(e.errors) && e.errors.some(isCE)));
export function r7Row(E, kind, throwing, pol) {
  const N7 = 3000;
  const r = E.createRegistry({ onCapacityExceeded: pol });
  let pre = 0, errs = 0, reached = 0, other = null, iters = 0, yRuns = 0, inFrame = null;
  hreset();
  const catchE = (e) => { if (isDc(e)) { errs++; return false; } if (isPre(e)) { pre++; return false; } other = (e && e.name === "CapacityError" ? "CE" : String(e && e.message).slice(0, 50)); return true; };
  const one = () => {
    const s = r.signal(1), sw = r.signal(true), tmps = [];
    let X = null, ys = null, Ydisp = null, P = null;
    const xEff = kind === "EW" || kind === "E0" || kind === "ESW";
    r.observeObservers(s, { onDisconnect: () => { reached++; if (X !== null) { if (xEff) X(); else r.dispose(X); } tmps.push(r.signal(0)); if (throwing) throw new Error("dc"); } });
    let stop = false;
    try {
      if (kind === "CW" || kind === "C0") {
        X = r.computed(() => sw() ? s() : 0);
        X(); sw.set(false); X();
      } else if (kind === "EW" || kind === "E0") {
        X = r.effect(() => { sw() ? s() : 0; });
        sw.set(false);
      } else if (kind === "ESW") {
        ys = r.signal(0);
        X = r.effect(() => { sw() ? s() : 0; }, { scheduler: (run) => { try { run(); } catch (e) {
          if (isCE(e)) throw e;
          Ydisp = r.effect(() => { ys(); yRuns++; }); ys.set(ys.peek() + 1); throw e; } } });
        sw.set(false);
      } else if (kind === "CFB") {
        const Xc = r.computed(() => sw() ? s() : 0); X = Xc;
        Xc(); sw.set(false);
        P = r.computed(() => Xc() + 1);
        r.runWithOwner(P, () => r.onCleanup(() => { throw new Error("pre"); }));
        P();
      } else if (kind === "EFB") {
        const Xc = r.computed(() => sw() ? s() : 0); X = Xc;
        Xc(); sw.set(false);
        let run = null;
        const Pd = r.effect(() => { Xc(); }, { scheduler: (rn) => { run = rn; } });
        r.runWithOwner(Pd, () => r.onCleanup(() => { throw new Error("pre"); }));
        try { if (run !== null) run(); } finally { Pd(); }
      }
    } catch (e) { stop = catchE(e); }
    if (Ydisp !== null) Ydisp();
    if (P !== null) r.dispose(P);
    if (X !== null) { if (xEff) X(); else r.dispose(X); }
    r.dispose(s); r.dispose(sw); if (ys !== null) r.dispose(ys);
    for (const t of tmps) r.dispose(t);
    return stop;
  };
  const loop = () => { for (let i = 0; i < N7; i++) { if (one()) break; iters++; } const st = r.stats(); inFrame = { active: st.activeNodes, pool: st.nodePoolPopulation }; };
  try {
    if (kind === "C0" || kind === "E0") loop();
    else { const Wf = r.effect(loop); Wf(); }
  } catch (e) { other = "outer:" + String(e && e.message).slice(0, 50); }
  const st = r.stats(), h = hget();
  const log = { errs, pre, other, activeIn: inFrame && inFrame.active, poolIn: inFrame && inFrame.pool, active: st.activeNodes, pins: h.pins, unpins: h.unpins };
  if (kind === "ESW") log.yRuns = yRuns;
  return { iters, ce: other === "CE" ? iters : null, pool: st.nodePoolPopulation, hw: h.hw, reached, log };
}
export const R7_KINDS = ["CW", "EW", "CFB", "EFB", "C0", "E0", "ESW"];

// ---- A-RESET-SCOPE (probe-first; H19): K scope-owner disposals at depth 0 (P7 body), then op = "reset" | "destroy", then ONE signal
// creation. H19 sits in destroy()'s body (reset() disposes every node but keeps the pool); destroy() empties nodePool, so any slot still on scopePinHead afterwards is a ghost outside the pool: the creation's nodeMiss
// (depth 0, H4 clause) would splice it into the free list and hand it out -> pool stays 0 instead of regrowing to the
// constructor capacity. Meaningful only on a build whose scope pins are stranded (the SNOCALL control).
export function resetScopeRow(E, K, op) {
  const r = E.createRegistry();
  hreset(); ck = 0; nf = 0;
  const s = r.signal(1);
  const it = P.P7(r, s);
  for (let i = 0; i < K; i++) it(i);
  const pre = r.stats();
  r[op]();
  const mid = r.stats();
  const a = r.signal(0);
  const post = r.stats(), h = hget();
  return { iters: K, ce: null, pool: post.nodePoolPopulation, hw: h.hw, reached: h.pins,
    log: { preActive: pre.activeNodes, prePool: pre.nodePoolPopulation, midActive: mid.activeNodes, midPool: mid.nodePoolPopulation, postActive: post.activeNodes, growths: post.poolGrowths, sig: typeof a } };
}

// ---- L-1 pre-walk (research r1d/ALL3/locals.mjs row "L1-PW"; PROGRESS-ALL3 Task 3 L35; LOCALS.md L-1): effect X reads computed D;
// D (refreshed by X's pre-walk, X not COMPUTING) disposes X, creates effect Y reading t, sets t (Y QUEUED for the next pass) and drops
// dep s whose onDisconnect throws -> flushEffects' catch. Y:1 = Y's queued run delivered before the write returned. reached = the throw fired.
export async function l1pwRow(E, pol) {
  const log = []; let err = null, res = {}, reached = 0;
  const r = E.createRegistry({ onCapacityExceeded: pol });
  hreset();
  try {
    const k = r.signal(0), s = r.signal(0), t = r.signal(0); let armed = false, armThrow = false, Xh = null, caught = null;
    r.observeObservers(s, { onDisconnect: () => { if (armThrow) { armThrow = false; reached++; log.push("s:onDisconnect-throw"); throw new Error("disc"); } } });
    const D = r.computed(() => { const v = k(); if (!armed) { s(); return v; } armed = false;
      Xh(); log.push("D:disposedX"); r.effect(() => { log.push("Y:" + t()); }); t.set(1); log.push("D:set-t"); return v; });
    Xh = r.effect(() => { log.push("X:" + D()); });
    armed = true; armThrow = true;
    try { k.set(1); } catch (e) { caught = String(e && e.name === "CapacityError" ? "CapacityError" : (e && e.name) + ":" + (e && e.message)).slice(0, 90); }
    await Promise.resolve(); await new Promise((res2) => setTimeout(res2, 0)); log.push("--after"); t.set(2);
    const a = log.indexOf("--after"), i1 = log.indexOf("Y:1"), i2 = log.indexOf("Y:2", a);
    res = { caught, Y1: i1 >= 0 && i1 < a, Y2: a >= 0 && i2 >= 0 };
  } catch (e) { err = String(e && e.message).slice(0, 90); }
  const st = r.stats(), h = hget();
  return { iters: 1, ce: null, pool: st.nodePoolPopulation, hw: h.hw, reached, log: { err, ...res, text: log.join(" | "), active: st.activeNodes, links: st.activeLinks } };
}
