// b123 / b217 A-b217-1, A-b217-3: public-behaviour traces for the "entry lowered to k" rule of fixCursor (A1 cursor-repair log).
// caseB = the engine reviewer's case 2b (.handoff/b216/review-r1/rv/case2.mjs, verbatim logic): a recycled link X re-walked by D's
// second run at depth 1; K's frame is entered at depth 2 with savedCur === X. A lowered entry must NOT repair it.
// caseA = case 2a (multi-fix: two repairs to one suspended cursor in one suspension).
// gtLow / gtRaw / gtSev = A-b217-3 inputs for the `> k` -> `>= k` mutant (MU-GT).
// Every function takes the engine module S and returns the trace array (public behaviour only, no engine internals).
// gtOvf / noclrOvf (b218) take (S, arm) and return { out, r, hs, effects } (no reset); invariants(o) is the 1f / 1h oracle.
const safe = (f) => { try { return f(); } catch (e) { return "E:" + (e && e.name) + ":" + String(e && e.message).slice(0, 40); } };
const tail = (r, out) => { const st = r.stats(); out.push("L" + st.activeLinks + " N" + st.activeNodes); out.push(safe(() => { r.reset(); return "reset L" + r.stats().activeLinks; })); return out; };
export function caseA(S) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const trig = r.signal(0), s = r.signal(1), s2 = r.signal(2), s3 = r.signal(3);
    let phase = 0;
    const D = r.computed(() => { trig(); if (phase === 1) { phase = 2; r.dispose(s); r.dispose(s2); } return 0; });
    const C = r.computed(() => trig() + D());
    r.effect(() => { let v = trig(); v += C(); v += s() | 0; v += s2() | 0; v += s3(); out.push("run:" + v); });
    phase = 1;
    out.push(safe(() => trig.set(1)));
    out.push(safe(() => s3.set(9)));
    out.push(safe(() => trig.set(2)));
    return tail(r, out);
}
export function caseB(S) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const trig = r.signal(0), s = r.signal(1), s2 = r.signal(2), g1 = r.signal(0), h = r.signal(0);
    let f = null, phase = 0;
    const K = r.computed(() => h() + 100);
    const D = r.computed(() => { let v = g1() + K(); if (phase === 1) { phase = 2; r.dispose(s); f = r.signal(10); } if (f) v += f(); return v; });
    const C = r.computed(() => trig() + (phase === 1 ? D() : 0));
    r.effect(() => {
        let v = trig(); v += C(); v += s() | 0; v += s2();
        if (phase === 2) { phase = 3; g1.set(1); h.set(5); v += D(); }
        out.push("run:" + v);
    });
    phase = 1;
    out.push(safe(() => trig.set(1)));
    out.push(safe(() => s2.set(7)));
    out.push(safe(() => { g1.set(3); h.set(4); return D(); }));
    out.push(safe(() => trig.set(3)));
    return tail(r, out);
}
// A-b217-3 inputs. Each recycles a freed link into another list before a level-k restore whose parent cursor is non-null.
// gtLow: E = [trig, C, s, s2, C2, s3]. On trig.set, E's body reads C -> D (index 2) disposes s (E's cursor sits on s's link): the
// entry is logged at depth 3, lowered by D's restore to 2, then by C's restore (k = 1) to 1 (and applied to E's cursor). f = signal(10)
// recycles s's freed link into D's list. Then C2 (stale on trig) runs as a LATER child of E at index 1 with E's cursor on s3's link
// (non-null): the entry's level 1 === k = 1.
export function gtLow(S) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const trig = r.signal(0), s = r.signal(1), s2 = r.signal(2), s3 = r.signal(3);
    let on = false, f = null;
    const D = r.computed(() => { trig(); if (on) { on = false; r.dispose(s); f = r.signal(10); } return f ? f() : 0; });
    const C = r.computed(() => trig() + D());
    const C2 = r.computed(() => trig() * 2);
    r.effect(() => { let v = trig(); v += C(); v += s() | 0; v += s2(); v += C2(); v += s3(); out.push("run:" + v); });
    on = true;
    out.push(safe(() => trig.set(1)));
    out.push(safe(() => s3.set(9)));
    out.push(safe(() => trig.set(2)));
    return tail(r, out);
}
// gtRaw: C (index 1) disposes s (E's cursor sits on it: logged at depth 2, raw level 2) and creates f. M (stale, index 2) reads f
// (recycling s's freed link into M's list), then C reads t1 and a stale K (index 2): both frames restore with k = 2 === the entry's
// level, with C's cursor non-null (t1 / K / t2 remain in C's old list).
export function gtRaw(S) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const trig = r.signal(0), s = r.signal(1), t1 = r.signal(2), t2 = r.signal(3), t3 = r.signal(4);
    let on = false, f = null;
    const M = r.computed(() => { trig(); return f ? f() : 0; });
    const K = r.computed(() => trig() + 1);
    const C = r.computed(() => { let v = trig(); if (on) { on = false; r.dispose(s); f = r.signal(10); } v += M(); v += t1(); v += K(); v += t2(); return v; });
    r.effect(() => { let v = trig(); v += C(); v += s() | 0; v += t3(); out.push("run:" + v); });
    on = true;
    out.push(safe(() => trig.set(1)));
    out.push(safe(() => t2.set(9)));
    out.push(safe(() => trig.set(2)));
    return tail(r, out);
}
// gtSev: C1 ends with a 3-link stale tail (w, w2, w3). severStale's walk (index 2) fires w's onDisconnect, which disposes b (a source
// of the suspended frame E: logged at depth 2), then w2's onDisconnect, which reads Q (never run before: a frame at index 2 === the
// entry's level) with the walk cursor on w3's link (non-null).
export function gtSev(S) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const a = r.signal(0), b = r.signal(1), c = r.signal(2), w = r.signal(0), w2 = r.signal(0), w3 = r.signal(0);
    let on = false, q = 0;
    r.observeObservers(w, { onDisconnect: () => { if (on) r.dispose(b); } });
    r.observeObservers(w2, { onDisconnect: () => { if (on) q = Q(); } });
    const Q = r.computed(() => a() + 100);
    const C1 = r.computed(() => { a(); if (!on) { w(); w2(); w3(); } return 1; });
    r.effect(() => { let v = a(); v += C1(); v += b() | 0; v += c(); out.push("run:" + v + "/" + q); });
    on = true;
    out.push(safe(() => a.set(1)));
    out.push(safe(() => c.set(9)));
    out.push(safe(() => a.set(2)));
    return tail(r, out);
}
// b218 planted-overflow inputs (REACH MATRIX .handoff/b218/matrix, cells P2 x MU-GT and P2 x MU-NOCLR0). Both take (S, arm): arm("R")
// arms the test's count-checked cold-arm plant (refreshComputed site, throws on its first call), arm(null) disarms. They return
// { out, r, hs, effects } WITHOUT reset, so the row can check invariants first. Every effect body records the names it read in its
// last COMPLETED run (a disposed handle is not recorded: its link is gone). Engine logic = the matrix probes gtovf / p2Noclr0 (pad 0);
// the only edits are the read recorder rd() (same reads, same order) and dropping the probe's "fired" trace line.
function effectRec(r, name, body, opts) {
    const e = { name, h: null, n: 0, lastSet: [], dead: opts.dead };
    let cur = null;
    const rd = (nm, h) => { if (!cur.dead.has(nm)) cur.set.add(nm); return h(); };
    e.h = r.effect(() => { cur = { set: new Set(), dead: e.dead }; e.n++; body(rd); e.lastSet = [...cur.set].sort(); });
    return e;
}
// gtOvf (matrix gtovf = .handoff/b217/review-r2/gt-overflow-repro.mjs): C2 (depth 1) disposes s (the effect's cursor sits on it: an
// entry at level 2) and arms the plant; the overflow at C2's restore leaves the entry at level 2 (never lowered). The effect then
// re-runs C2 in the same run; G (depth 2 inside C2) restores with k = 2 and C2's cursor on a recycled link === the entry's link.
// `>` skips the entry; `>=` (MU-GT) redirects C2's cursor and drops a subscription.
export function gtOvf(S, arm) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const trig = r.signal(0), s = r.signal(1), s2 = r.signal(2), h = r.signal(0), a = r.signal(0), b = r.signal(7);
    let phase = 0; const dead = new Set();
    const G = r.computed(() => h() + 100);
    const C2 = r.computed(() => { let v = trig() + a() + G(); if (phase === 1) { phase = 2; r.dispose(s); dead.add("s"); arm("R"); v += b(); } else if (phase >= 2) v += b(); return v; });
    const ef = effectRec(r, "E", (rd) => {
        let v = rd("trig", trig); let e = null;
        try { v += rd("C2", C2); } catch (x) { e = x.name; }
        v += rd("s", s) | 0; v += rd("s2", s2);
        if (phase === 2) { phase = 3; arm(null); a.set(1); h.set(5); try { v += rd("C2", C2); } catch (x) { e = (e || "") + "+" + x.name; } }
        out.push("run:" + v + (e ? "/" + e : ""));
    }, { dead });
    phase = 1;
    out.push(safe(() => trig.set(1)));
    out.push(safe(() => s2.set(7)));
    out.push(safe(() => { h.set(9); a.set(2); return C2(); }));
    out.push(safe(() => trig.set(3)));
    return { out, r, hs: { trig, s, s2, h, a, b, G, C2, E: ef.h }, effects: [ef] };
}
// noclrOvf (matrix p2Noclr0): cross-tree stale entry. Tree 1: C1 (depth 1) disposes s while E's cursor sits on X = link(s -> E): entry
// (X, link(t -> E), level 2); the overflow at C1's restore (k = 1) leaves it; E's depth-0 restore clears the log (MU-NOCLR0 keeps it).
// E2 (list [g, C3]) then reads u, taking X off the free list as its u link. Tree 3: E2 dirties C3 in its own body and re-reads it;
// C3's restore (k = 1) runs with E2's cursor === X: a kept entry redirects it into E's list and E loses its t subscription.
export function noclrOvf(S, arm) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const trig = r.signal(0), s = r.signal(1), t = r.signal(2), g = r.signal(0), h = r.signal(0), u = r.signal(3);
    const padC = r.computed(() => 0); padC();
    let on = false, mode = 0; const dead = new Set();
    const C3 = r.computed(() => h() + 1);
    const e2 = effectRec(r, "E2", (rd) => { let v = rd("g", g); if (mode >= 2) h.set(g.peek() + 10); v += rd("C3", C3); if (mode >= 1) v += rd("u", u); out.push("E2:" + v); }, { dead });
    const C1 = r.computed(() => { trig(); if (on) { on = false; r.dispose(s); dead.add("s"); arm("R"); } return 1; });
    const e1 = effectRec(r, "E", (rd) => { let v = rd("trig", trig), e = ""; try { v += rd("C1", C1); } catch (x) { e = "/" + x.name; } v += rd("s", s) | 0; v += rd("t", t); out.push("E:" + v + e); }, { dead });
    on = true; out.push(safe(() => trig.set(1))); arm(null);
    r.dispose(padC);
    mode = 1; out.push(safe(() => g.set(1)));
    mode = 2; out.push(safe(() => g.set(2))); out.push(safe(() => t.set(5))); out.push(safe(() => u.set(4)));
    return { out, r, hs: { trig, s, t, g, h, u, C3, E2: e2.h, C1, E: e1.h, padC }, effects: [e2, e1] };
}
// Fixture-free invariants for gtOvf / noclrOvf (test/123 1f / 1h, D-b217-1), checked BEFORE reset: (subs) every effect's sources ===
// the set it read in its last completed run; (links) activeLinks === the sum of forEachSource over EVERY handle (every effect included);
// (once) writing each signal of an effect's last-run read set re-runs that effect exactly once; (reset) reset() succeeds.
export function invariants(o) {
    const { r, hs, effects } = o; const id2n = new Map();
    for (const k in hs) { try { id2n.set(r.nodeId(hs[k]), k); } catch { /* disposed handle */ } }
    const names = (h) => { const a = []; try { r.forEachSource(h, (x) => a.push(id2n.get(x.id) || "?" + x.id)); } catch (e) { a.push("E:" + e.name); } return a.sort(); };
    const subs = [];
    for (const e of effects) { const got = names(e.h); if (JSON.stringify(got) !== JSON.stringify(e.lastSet)) subs.push(e.name + " sources " + JSON.stringify(got) + " != last run " + JSON.stringify(e.lastSet)); }
    let sum = 0; for (const k in hs) { try { r.forEachSource(hs[k], () => { sum++; }); } catch { /* disposed handle */ } }
    const links = [r.stats().activeLinks, sum];
    const once = [];
    for (const e of effects) {
        for (const nm of e.lastSet.slice()) {
            const h = hs[nm]; if (typeof h.set !== "function" || typeof h.peek !== "function") continue;
            const n0 = e.n; try { h.set(h.peek() + 1000); } catch (x) { once.push(e.name + "/" + nm + " threw " + x.name); continue; }
            if (e.n - n0 !== 1) once.push(e.name + " ran " + (e.n - n0) + "x on " + nm);
        }
    }
    // b219 COMPUTED clause (A-b219-3): o.computeds = [{ name, h, n, lastSet }] (compRec): every computed's forEachSource set === the reads of its
    // last completed run, and writing a source it read makes its next read recompute exactly once (a 2nd read adds no run).
    const comp = [];
    for (const c of (o.computeds || [])) {
        const got = names(c.h); if (JSON.stringify(got) !== JSON.stringify(c.lastSet)) comp.push(c.name + " sources " + JSON.stringify(got) + " != last run " + JSON.stringify(c.lastSet));
        for (const nm of c.lastSet.slice()) {
            const h = hs[nm]; if (!h || typeof h.set !== "function" || typeof h.peek !== "function") continue;
            const n0 = c.n; try { h.set(h.peek() + 1000); } catch (x) { comp.push(c.name + "/" + nm + " threw " + x.name); continue; }
            safe(() => c.h()); const n1 = c.n - n0; safe(() => c.h());
            if (n1 !== 1 || c.n - n0 !== 1) comp.push(c.name + " ran " + n1 + "x then " + (c.n - n0) + "x on " + nm);
        }
    }
    let reset = null; try { r.reset(); } catch (x) { reset = String(x && x.message).slice(0, 80); }
    return { subs, links, once, comp, reset };
}

// ---------------------------------------------------------------------------------------------------------------------
// b219 (STEP B, A-b219-3 / -4) additions. Inputs ported from the A2 helpers' corpora (.handoff/b219/a2/A/corpus.mjs, a2/B/corpus.mjs, the
// r3 reviewer's noclrRR, the b218 matrix p6): the logic is unchanged; the only edits are (1) the plant control is `ctl` = { arm(site, at),
// fired() } (arm("R"|"E"|"S", at) arms the count-checked cold-arm plant to throw on its `at`-th call, arm(null) disarms) and (2) the
// computed clause (compRec / invariants().comp). Every input returns an array of strings (trace + audit lines) and takes (S, ctl).
// A-harness (mkA): trees R / E / S / N on one registry; the audit line set = links vs sum, the clause (every live computed / effect's
// sources === the reads of its last completed run; writing a read source re-runs it exactly once) and reset().
function mkA(S) {
    const r = S.createRegistry({ maxNodes: 4096, maxLinks: 16384 });
    const X = { r, last: {}, runs: {}, dead: new Set(), hs: {}, kind: {}, trace: [] };
    X.reg = (n, k, h) => { X.hs[n] = h; X.kind[n] = k; return h; };
    X.S = (n, v) => X.reg(n, "S", r.signal(v));
    const wrap = (n, f) => () => { const cur = []; const v = f((h) => { cur.push(h); return h(); }); X.last[n] = cur; X.runs[n] = (X.runs[n] | 0) + 1; return v; };
    X.C = (n, f) => X.reg(n, "C", r.computed(wrap(n, f)));
    X.E = (n, f) => X.reg(n, "E", r.effect(wrap(n, f)));
    X.D = (n) => { X.dead.add(n); return r.dispose(X.hs[n]); };
    return X;
}
function auditA(X) {
    const { r } = X, out = []; const id2n = new Map(), h2n = new Map();
    for (const n in X.hs) if (!X.dead.has(n)) { try { id2n.set(r.nodeId(X.hs[n]), n); h2n.set(X.hs[n], n); } catch { /* gone */ } }
    const names = (h) => { const a = []; try { r.forEachSource(h, (x) => a.push(id2n.get(x.id) || "?" + x.id)); } catch (e) { a.push("E:" + e.name); } return a.sort(); };
    let sum = 0; for (const n of id2n.values()) { try { r.forEachSource(X.hs[n], () => { sum++; }); } catch { /* gone */ } }
    out.push("links " + r.stats().activeLinks + "/sum" + sum);
    const bad = [];
    for (const n in X.last) { if (X.dead.has(n) || !h2n.has(X.hs[n])) continue; const want = X.last[n].map((h) => h2n.get(h)).filter(Boolean).sort(), got = names(X.hs[n]); if (JSON.stringify(want) !== JSON.stringify(got)) bad.push(n + " src " + got + " != last " + want); }
    for (const n in X.last) { if (X.dead.has(n) || !h2n.has(X.hs[n])) continue; for (const h of X.last[n]) { const hn = h2n.get(h); if (!hn || typeof h.set !== "function" || typeof h.peek !== "function") continue; const r0 = X.runs[n] | 0; safe(() => h.set(h.peek() + 1000)); if (X.kind[n] === "C") safe(() => X.hs[n]()); const d = (X.runs[n] | 0) - r0; if (d !== 1) bad.push(n + " ran " + d + "x on " + hn); } }
    out.push("clause " + JSON.stringify(bad));
    out.push(safe(() => { r.reset(); return "reset L" + r.stats().activeLinks; }));
    return out;
}
const armerA = (ctl, site, at) => (site ? () => ctl.arm(site, at) : null);
const nodeBodyA = (X, t, st, arm) => X.C("C1" + t, (rd) => { rd(X.hs["trig" + t]); if (st.on) { st.on = false; X.D("s" + t); if (arm) arm(); } return 1; });
function treeR(X, t, arm, ctl) {   // top-level computed C0 (depth 0) -> C1 (depth 1) disposes s (C0's cursor sits on it), overflow at C1's restore
    const trig = X.S("trig" + t, 0), s = X.S("s" + t, 1), tt = X.S("t" + t, 2), st = { on: false };
    const C1 = nodeBodyA(X, t, st, arm);
    const C0 = X.C("C0" + t, (rd) => { let v = rd(trig), e = ""; try { v += rd(C1); } catch (x) { e = "/" + x.name; } v += (rd(s) | 0); v += rd(tt); return "C0:" + v + e; });
    X.trace.push(safe(() => C0())); st.on = true; X.trace.push(safe(() => trig.set(1))); X.trace.push(safe(() => C0())); ctl.arm(null);
}
function treeE(X, t, arm, ctl) {   // depth-0 effect E -> C1 (depth 1)
    const trig = X.S("trig" + t, 0), s = X.S("s" + t, 1), tt = X.S("t" + t, 2), st = { on: false };
    const C1 = nodeBodyA(X, t, st, arm);
    X.E("E" + t, (rd) => { let v = rd(trig), e = ""; try { v += rd(C1); } catch (x) { e = "/" + x.name; } v += (rd(s) | 0); v += rd(tt); X.trace.push("E" + t + ":" + v + e); });
    st.on = true; X.trace.push(safe(() => trig.set(1))); ctl.arm(null);
}
function treeS(X, t, arm, ctl) {   // depth-0 severStale: E0's stale tail (w1, w2) severed after its restore; w1's onDisconnect reads X0 -> Y logs at cursorDepth 3
    const trig = X.S("trig" + t, 0), trig2 = X.S("trig2" + t, 0), w1 = X.S("w1" + t, 0), w2 = X.S("w2" + t, 0), sx = X.S("sx" + t, 1), tx = X.S("tx" + t, 2);
    const st = { on2: false, hook: false, first: true };
    const Y = X.C("Y" + t, (rd) => { rd(trig2); if (st.on2) { st.on2 = false; X.D("sx" + t); if (arm) arm(); } return 1; });
    const X0 = X.C("X0" + t, (rd) => { let v = rd(trig2); try { v += rd(Y); } catch (x) { v += 1000; } v += (rd(sx) | 0); v += rd(tx); return v; });
    X.r.observeObservers(w1, { onDisconnect: () => { if (st.hook) { st.hook = false; X.trace.push("hook:" + safe(() => X0())); } } });
    X.E("E0" + t, (rd) => { rd(trig); if (st.first) { st.first = false; rd(w1); rd(w2); } });
    X.trace.push(safe(() => X0())); st.on2 = true; st.hook = true; X.trace.push(safe(() => trig2.set(1))); X.trace.push(safe(() => trig.set(1))); ctl.arm(null);
}
function treeN(X, t) {   // clean nested tree, never logs
    const trig = X.S("trig" + t, 0), a = X.S("a" + t, 1);
    const C2 = X.C("C2" + t, (rd) => { rd(trig); return rd(a) + 1; });
    const C1 = X.C("C1" + t, (rd) => rd(trig) + rd(C2));
    X.E("E" + t, (rd) => { X.trace.push("N" + t + ":" + (rd(trig) + rd(C1) + rd(a))); });
    X.trace.push(safe(() => trig.set(1))); X.trace.push(safe(() => a.set(5)));
}
const TREES = { R: treeR, E: treeE, S: treeS };
// armed variant: "none" | "r1" | "r2" (R site, call 1 / 2) | "s1" (S site, call 1) | "e1" (E site, call 1); only the FIRST tree is armed.
export const VARS = { none: null, r1: ["R", 1], r2: ["R", 2], s1: ["S", 1], e1: ["E", 1] };
// seq: the three trees in `order` (a string over R E S) on one registry, then a clean tree N; ends with the audit.
export function seq(S, ctl, order, v) {
    const X = mkA(S); const [site, at] = VARS[v] || [null, 0];
    order.split("").forEach((k, i) => TREES[k](X, String(i), i === 0 ? armerA(ctl, site, at) : null, ctl));
    treeN(X, "n"); X.trace.push("fired " + ctl.fired()); return X.trace.concat(auditA(X));
}
// first: a fresh registry, the first-ever tree of kind k (R E S), armed v.
export function first(S, ctl, k, v) { const X = mkA(S); const [site, at] = VARS[v] || [null, 0]; TREES[k](X, "0", armerA(ctl, site, at), ctl); X.trace.push("fired " + ctl.fired()); return X.trace.concat(auditA(X)); }
// nest: the tree (clean | dirtyE | dirtyR | dirtyS) built INSIDE an outer computed body (E / S frames at cursorDepth >= 1).
export function nest(S, ctl, nm, v) {
    const tree = { clean: () => treeN(X, "in"), dirtyE: (arm) => treeE(X, "in", arm, ctl), dirtyR: (arm) => treeR(X, "in", arm, ctl), dirtyS: (arm) => treeS(X, "in", arm, ctl) }[nm];
    const X = mkA(S); const [site, at] = VARS[v] || [null, 0];
    const outer = X.C("outer", () => { tree(armerA(ctl, site, at)); return 1; });
    X.trace.push(safe(() => outer())); X.trace.push("fired " + ctl.fired()); return X.trace.concat(auditA(X));
}
// destroyReuse: tree k, destroy(), then the same tree again on the same registry (the first tree after destroy()).
export function destroyReuse(S, ctl, k) {
    const X = mkA(S); TREES[k](X, "0", null, ctl); const o = X.trace; o.push(safe(() => { X.r.destroy(); return "destroyed"; }));
    const sv = X.r; const n0 = o.length;
    safe(() => { const Y = mkA({ createRegistry: () => sv }); Y.trace = o; TREES[k](Y, "1", null, ctl); return 0; }); o.push("after:" + (o.length - n0));
    o.push(safe(() => JSON.stringify(sv.stats()))); return o;
}
// p6 (b218 matrix): C2 disposes cursor sources of C1 and the effect, recycles, throws; caught = C1 catches, else the throw unwinds through C1's restore.
export function p6(S, ctl, caught) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const trig = r.signal(0), s = r.signal(1), s1 = r.signal(2), t = r.signal(3), t1 = r.signal(4);
    let on = false, f = null;
    const K = r.computed(() => trig() + 7);
    const C2 = r.computed(() => { trig(); if (on) { on = false; r.dispose(s); r.dispose(s1); f = r.signal(5); f(); throw new Error("boom"); } return 1; });
    const C1 = r.computed(() => { let v = trig(); if (caught) { try { v += C2(); } catch (e) { v += 1000; } } else v += C2(); v += s1() | 0; v += K(); v += t1(); return v; });
    r.effect(() => { let v = trig(), e = ""; try { v += C1(); } catch (x) { e = "/" + x.message; } v += K(); v += s() | 0; v += t(); out.push("run:" + v + e); });
    on = true; out.push(safe(() => trig.set(1))); out.push(safe(() => t.set(9))); out.push(safe(() => trig.set(2)));
    return tail(r, out);
}
// noclrRR (review-r3 lowerR.noclrRR, A-b218-5): noclrOvf with the depth-0 frame a top-level computed C0 and E2 a computed C2. Returns
// { out, r, hs, effects: [], computeds } like noclrOvf (the computed clause of invariants() reads o.computeds).
function compRec(r, name, body, dead) {
    const c = { name, h: null, n: 0, lastSet: [] }; let cur = null;
    const rd = (nm, h) => { if (!dead.has(nm)) cur.add(nm); return h(); };
    c.h = r.computed(() => { cur = new Set(); c.n++; const v = body(rd); c.lastSet = [...cur].sort(); return v; });
    return c;
}
export function noclrRR(S, ctl, npad) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const trig = r.signal(0), s = r.signal(1), t = r.signal(2), g = r.signal(0), h = r.signal(0), u = r.signal(3);
    const pads = []; for (let i = 0; i < npad; i++) { const p = r.computed(() => 0); p(); pads.push(p); }
    let on = false, mode = 0; const dead = new Set(); const hs = { trig, s, t, g, h, u };
    const c3 = compRec(r, "C3", (rd) => rd("h", h) + 1, dead); hs.C3 = c3.h;
    const c2 = compRec(r, "C2", (rd) => { let v = rd("g", g); v += rd("C3", c3.h); if (mode >= 1) v += rd("u", u); return "C2:" + v; }, dead); hs.C2 = c2.h;
    const c1 = compRec(r, "C1", (rd) => { rd("trig", trig); if (on) { on = false; r.dispose(s); dead.add("s"); ctl.arm("R"); } return 1; }, dead); hs.C1 = c1.h;
    const c0 = compRec(r, "C0", (rd) => { let v = rd("trig", trig), e = ""; try { v += rd("C1", c1.h); } catch (x) { e = "/" + x.name; } v += rd("s", s) | 0; v += rd("t", t); return "C0:" + v + e; }, dead); hs.C0 = c0.h;
    const C2 = c2.h, C0 = c0.h;
    out.push(safe(() => C2())); out.push(safe(() => C0()));
    on = true; trig.set(1); out.push(safe(() => C0())); ctl.arm(null);
    for (const p of pads) r.dispose(p);
    mode = 1; g.set(1); out.push(safe(() => C2()));
    mode = 2; g.set(2); h.set(12); out.push(safe(() => C2())); t.set(5); out.push(safe(() => C0()));
    u.set(4); out.push(safe(() => C2())); t.set(9); out.push(safe(() => C0()));
    return { out, r, hs, effects: [], computeds: [c3, c2, c1, c0] };
}
// B-harness (mkB): a registry with an optional gv seed (snapshot() + restore({...snap, gv}): the public path that starts the clock near 2^31-1).
function mkB(S, gv) {
    let r = S.createRegistry({ maxNodes: 256, maxLinks: 1024 });
    if (gv !== undefined && gv !== null) { r.signal(0); const snap = r.snapshot(); r = r.restore(Object.assign({}, snap, { gv }), { fnsById: {}, handles: {} }); }
    const T = { r, out: [], hs: {}, recs: [], dead: new Set() };
    T.sig = (nm, v) => (T.hs[nm] = r.signal(v));
    function rec(nm, kind, body) {
        const R = { nm, kind, runs: 0, last: [], cur: null, h: null };
        const rd = (n, h) => { if (!T.dead.has(n)) R.cur.add(n); return h(); };
        const fn = () => { R.cur = new Set(); R.runs++; const v = body(rd); R.last = [...R.cur].sort(); return v; };
        R.h = kind === "c" ? r.computed(fn) : r.effect(fn);
        T.hs[nm] = R.h; T.recs.push(R); return R;
    }
    T.comp = (nm, body) => rec(nm, "c", body).h;
    T.eff = (nm, body) => rec(nm, "e", body).h;
    T.kill = (nm) => { T.dead.add(nm); r.dispose(T.hs[nm]); };
    T.runs = () => T.recs.map((x) => x.nm + ":" + x.runs).join(",");
    T.audit = () => {
        const id2n = new Map(); for (const k in T.hs) { try { id2n.set(r.nodeId(T.hs[k]), k); } catch { /* disposed */ } }
        const names = (h) => { const a = []; try { r.forEachSource(h, (x) => a.push(id2n.get(x.id) || "?" + x.id)); } catch (e) { a.push("E:" + e.name); } return a.sort(); };
        const subs = [];
        for (const x of T.recs) { if (T.dead.has(x.nm)) continue; const got = names(x.h); if (JSON.stringify(got) !== JSON.stringify(x.last)) subs.push(x.nm + " " + JSON.stringify(got) + "!=" + JSON.stringify(x.last)); }
        let sum = 0; for (const k in T.hs) { try { r.forEachSource(T.hs[k], () => { sum++; }); } catch { /* disposed */ } }
        const links = [r.stats().activeLinks, sum];
        const once = [];
        for (const x of T.recs) {
            if (T.dead.has(x.nm)) continue;
            for (const nm of x.last.slice()) {
                const h = T.hs[nm]; if (!h || typeof h.set !== "function" || typeof h.peek !== "function") continue;
                const n0 = x.runs; try { h.set(h.peek() + 1000); } catch (e) { once.push(x.nm + "/" + nm + " threw " + e.name); continue; }
                if (x.kind === "c") { safe(() => x.h()); const n1 = x.runs - n0; safe(() => x.h()); once.push(x.nm + "/" + nm + " c:" + n1 + "," + (x.runs - n0 - n1)); }
                else once.push(x.nm + "/" + nm + " e:" + (x.runs - n0));
            }
        }
        let reset = null; try { r.reset(); reset = "ok L" + r.stats().activeLinks; } catch (e) { reset = "E:" + String(e && e.message).slice(0, 60); }
        return { subs, links, once, reset };
    };
    T.done = () => { T.out.push("#RUNS " + T.runs()); T.out.push(JSON.stringify(T.audit())); return T.out; };
    return T;
}
// G (pre-walk guard `dep.evalVersion !== globalVersion`): kind "eff" (effect over one computed), "cc" (computed over computed), "effcc"
// (effect over computed over computed); gv = clock seed (2147483644: the writes cross 2^31-1).
export function G(S, ctl, kind, gv) {
    const T = mkB(S, gv); const s = T.sig("s", 1);
    if (kind === "eff") { const C = T.comp("C", (rd) => rd("s", s) * 2); T.eff("E", (rd) => { T.out.push("E:" + rd("C", C)); }); for (let i = 0; i < 6; i++) T.out.push(safe(() => s.set(10 + i))); }
    else if (kind === "cc") { const C1 = T.comp("C1", (rd) => rd("s", s) * 2); const C2 = T.comp("C2", (rd) => rd("C1", C1) + 1); T.out.push(C2()); for (let i = 0; i < 6; i++) { s.set(10 + i); T.out.push(safe(() => C2())); } }
    else { const C1 = T.comp("C1", (rd) => rd("s", s) * 2); const C2 = T.comp("C2", (rd) => rd("C1", C1) + 1); T.eff("E", (rd) => { T.out.push("E:" + rd("C2", C2)); }); for (let i = 0; i < 6; i++) T.out.push(safe(() => s.set(10 + i))); }
    return T.done();
}
// G_del3b (visible): E deps [C1, C2, w]; C1's body (run by the pre-walk's pull) writes w -> pullMoved true on the FIRST link -> `break`; a
// mutant without it keeps walking and pulls the LATER stale computed C2 that E's re-run no longer reads (C2's body logs "C2body:").
export function gDel3b(S, ctl) {
    const T = mkB(S, null); const s = T.sig("s", 1), t = T.sig("t", 1), w = T.sig("w", 0); let mode = 0, arm = false;
    const C1 = T.comp("C1", (rd) => { const v = rd("s", s) > 0; if (arm) { arm = false; w.set(w.peek() + 1); } return v; });
    const C2 = T.comp("C2", (rd) => { const v = rd("t", t); T.out.push("C2body:" + v); return v * 3; });
    T.eff("E", (rd) => { let v = rd("C1", C1); if (mode === 0) v += rd("C2", C2); v += rd("w", w); T.out.push("E:" + v); });
    mode = 1; arm = true; T.out.push(safe(() => { T.r.batch(() => { s.set(5); t.set(2); }); }));
    T.out.push(safe(() => t.set(3))); T.out.push(safe(() => s.set(6)));
    return T.done();
}
// S3 (stale-slot, dropCursors L1215 link-slot store): tree 1 (caseA shape) leaves a repair entry (X, Y, lv) at fixLog slots 0..2 (fixLen then
// 0). G runs BEFORE tree 1, so X is the free-list head: Pm = [G, q] first runs after tree 1 and its first link takes X. Tree 2: q written ->
// Pm's body runs (depth 2 under E2) with its cursor on X, writes g1 and reads G: G's frame (depth 3, savedCur = X) disposes ITSELF -> one
// drop entry at slot 0 (head overwrites the stale link). A mutant leaving the stale X in slot 0 nulls Pm's LIVE cursor (duplicate link).
export function s3Stale(S, ctl, o) {
    const T = mkB(S, null);
    const trig = T.sig("trig", 0), s = T.sig("s", 1), s2 = T.sig("s2", 2), s3_ = T.sig("s3", 3), g1 = T.sig("g1", 0), q = T.sig("q", 0);
    let phase = 0, kill = false;
    const Gc = T.comp("G", (rd) => { const v = rd("g1", g1); if (kill) { kill = false; if (o.act === "self") T.kill("G"); else T.kill("w"); } return v; });
    Gc();
    const D = T.comp("D", (rd) => { rd("trig", trig); if (phase === 1) { phase = 2; T.kill("s"); if (o.two) T.kill("s2"); } return 0; });
    const C = T.comp("C", (rd) => rd("trig", trig) + rd("D", D));
    T.eff("E1", (rd) => { let v = rd("trig", trig); v += rd("C", C); v += rd("s", s) | 0; v += rd("s2", s2) | 0; v += rd("s3", s3_); T.out.push("E1:" + v); });
    phase = 1; T.out.push(safe(() => trig.set(1)));
    for (let i = 0; i < o.pad; i++) { const p = T.sig("pad" + i, i); T.comp("padc" + i, (rd) => rd("pad" + i, p))(); }
    let arm = false, dropq = false; const w = T.sig("w", 0);
    const Pm = T.comp("Pm", (rd) => { if (arm) { arm = false; kill = true; dropq = true; g1.set(g1.peek() + 1); } let v = rd("G", Gc); if (!(o.drop && dropq)) v += rd("q", q); if (o.after) v += rd("trig", trig); return v; });
    T.out.push(safe(() => Pm()));
    if (o.dup) T.eff("E3", (rd) => { T.out.push("E3:" + rd("q", q)); });
    T.eff("E2", (rd) => { T.out.push("E2:" + rd("Pm", Pm)); });
    arm = true; T.out.push(safe(() => q.set(1)));
    T.out.push(safe(() => q.set(2))); T.out.push(safe(() => g1.set(50)));
    return T.done();
}
// afterDirty (A-b219-4): a dirty depth-0 tree of root kind k (R / E / S; unarmed, it logs and applies fixes), then the clean nested tree N on
// the same registry: returns [JSON of the cold-arm `fixCursor(savedCur, d)` call counts the clean tree made] (ctl.cnt() = per-site totals).
export function afterDirty(S, ctl, k) {
    const X = mkA(S); TREES[k](X, "0", null, ctl); const c0 = ctl.cnt(); treeN(X, "n"); const c1 = ctl.cnt();
    return [JSON.stringify({ S: c1.S - c0.S, E: c1.E - c0.E, R: c1.R - c0.R })];
}
// b219 attempt (a) (fixCursor `i < n` -> `i <= n`): noclrOvf with TWO entries logged in tree 1 (C1 disposes s0 then s: slots 0..2 = s0, 3..5 = X = link(s)
// = the free-list head), the overflow at C1's restore leaving both unlowered at level 2, the depth-0 restore clearing fixLen (slots stay). Tree 2: E2's u
// link takes X; C3's re-run logs exactly ONE entry (disposes b behind its cursor: fixLen 3, slot 0) and C3's restore (k = 1) runs with E2's cursor === X:
// `<=` also reads the stale slots 3..5 (X, link(t), 2) and redirects E2's cursor into E's list. Returns { out, r, hs, effects, computeds }.
export function noclrA(S, arm) {
    const out = []; const r = S.createRegistry({ maxNodes: 64, maxLinks: 256 });
    const trig = r.signal(0), s0 = r.signal(5), s = r.signal(1), t = r.signal(2), g = r.signal(0), h = r.signal(0), u = r.signal(3), a = r.signal(7), b = r.signal(8);
    const padC = r.computed(() => 0); padC();
    let on = false, mode = 0, kill = false; const dead = new Set();
    const c3 = compRec(r, "C3", (rd) => { let v = rd("h", h); if (kill) { kill = false; r.dispose(b); dead.add("b"); } v += rd("a", a); if (!dead.has("b")) v += rd("b", b); return v + 1; }, dead);
    const e2 = effectRec(r, "E2", (rd) => { let v = rd("g", g); if (mode >= 2) { kill = true; h.set(g.peek() + 10); } v += rd("C3", c3.h); if (mode >= 1) v += rd("u", u); out.push("E2:" + v); }, { dead });
    const C1 = r.computed(() => { trig(); if (on) { on = false; r.dispose(s0); dead.add("s0"); r.dispose(s); dead.add("s"); arm("R"); } return 1; });
    const e1 = effectRec(r, "E", (rd) => { let v = rd("trig", trig), e = ""; try { v += rd("C1", C1); } catch (x) { e = "/" + x.name; } v += rd("s0", s0) | 0; v += rd("s", s) | 0; v += rd("t", t); out.push("E:" + v + e); }, { dead });
    on = true; out.push(safe(() => trig.set(1))); arm(null);
    r.dispose(padC);
    mode = 1; out.push(safe(() => g.set(1)));
    mode = 2; out.push(safe(() => g.set(2))); out.push(safe(() => t.set(5))); out.push(safe(() => u.set(4)));
    return { out, r, hs: { trig, s0, s, t, g, h, u, a, b, C3: c3.h, E2: e2.h, C1, E: e1.h, padC }, effects: [e2, e1], computeds: [c3] };
}
