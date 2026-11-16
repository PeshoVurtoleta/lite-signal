// UCE-H B2 child driver (test/116-uce-h.test.mjs). One mode per process; prints ONE JSON line on stdout.
// usage: node [flags] uceh-child.mjs <mode> '<json args>'
// Modes: gc3 (per-site B/op, class 18 rule: --single-threaded + JS heap spaces only), val (snapshot evalVersion of the far floor at a seeded gv),
//        ret3 (1000 forge + dispose + recycle cycles, lite-leak tracker size).
// Sites: E = rerunCleanupEffect (effect re-queued stale, its re-run cleanup throws), C = computedRunTail (computed written in its own body),
//        U = UCE delivery in throwComputedError (computed re-run cleanup writes a dep and throws).
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { PerformanceObserver, constants as PC } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
const JS_SPACES = ["new_space", "old_space", "new_large_object_space", "large_object_space"];
function spaces() { let u = 0, k = 0; for (const s of getHeapSpaceStatistics()) { if (JS_SPACES.includes(s.space_name)) u += s.space_used_size; else if (s.space_name === "code_space" || s.space_name === "trusted_space" || s.space_name === "code_large_object_space" || s.space_name === "trusted_large_object_space") k += s.space_used_size; } return [u, k]; }
const fail = (m) => { console.error("uceh-child: " + m); process.exit(6); };
function needST() { if (!process.execArgv.includes("--single-threaded")) { console.error("uceh-child: GC modes need --single-threaded"); process.exit(3); } for (const n of JS_SPACES) if (!getHeapSpaceStatistics().some((s) => s.space_name === n)) fail("no heap space " + n); }
const [mode, argJson] = process.argv.slice(2);
const A = JSON.parse(argJson);
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';
function rep(t, from, to) { const parts = t.split(from); if (parts.length !== 2) fail("edit anchor matched " + (parts.length - 1) + " times"); return parts[0] + to + parts[1]; }
async function load(p) {
    if (existsSync(dirname(p) + "/Watch.js")) return import(pathToFileURL(p).href);
    return import("data:text/javascript;base64," + Buffer.from(rep(readFileSync(p, "utf8"), WATCH_LINE, ""), "utf8").toString("base64"));
}
const E = new Error("uceh-E");   // pre-allocated: no body or cleanup allocates it
let sink = null;

// A world for one site: bodies(site, st, G, extra) -> the node bodies, written once and used twice (in the live registry that is snapshotted, then in the
// restored far-gv registry). The in-eval write that marks a reader stale must come from ANOTHER computed (w; a self-write is not a stale mark): the reader
// peeks w, w re-runs (its dep t moved) and writes s.
function bodies(site, st, G, extra) {
    const w = () => { G.t(); G.s.set(++st.k); return 0; };
    if (site === "C") return { w, c: () => { G.s(); st.runs++; if (st.arm) { st.arm = false; st.fl = true; G.w.peek(); } else if (st.fl) { st.fl = false; if (st.rawProbe) st.raw = st.rawProbe(); } if (extra) sink = new Array(4); return 1; } };   // fl: the re-pull run right after computedRunTail floored evalVersion (the re-pull stamps over it afterwards)
    if (site === "E") return { w, e: () => {
        G.s();
        G.onCleanup(() => { if (st.throwNext) { st.throwNext = false; if (st.probe) st.probe(); throw E; } });
        if (st.arm) { st.arm = false; st.throwNext = true; G.w.peek(); }
        if (extra) sink = new Array(4);
    } };
    if (site === "U") return { c: () => {
        G.s();
        G.onCleanup(() => { if (st.arm) { st.arm = false; G.s.set(++st.k); if (st.probe) st.probe(); throw E; } });
        if (extra) sink = new Array(4);
        return 1;
    } };
    fail("unknown site " + site);
}
// Builds the world in a fresh registry, snapshots, shifts every nonzero version / evalVersion / markEpoch by (gv - snap.gv) | 0 (a shift that
// lands on 0 returns null), restores into a registry that starts at gv. Returns {r, st, node, cycle, prep} or null.
function mkFar(M, site, gv, extra) {
    const r0 = M.createRegistry({ maxNodes: 64, prealloc: "lazy" });
    const st0 = { arm: false, throwNext: false, probe: null, runs: 0, k: 1 }, G0 = { s: r0.signal(1), t: r0.signal(1), w: null, onCleanup: r0.onCleanup };
    const b0 = bodies(site, st0, G0, extra);
    if (b0.w) G0.w = r0.computed(b0.w);
    const n0 = site === "E" ? r0.effect(b0.e) : r0.computed(b0.c);
    if (site !== "E") n0();
    const snap = r0.snapshot(), delta = (gv - snap.gv) | 0;
    let zero = false;
    const nodes = snap.nodes.map((n) => {
        const m = Object.assign({}, n);
        for (const f of ["version", "evalVersion", "markEpoch"]) if (typeof n[f] === "number" && n[f] !== 0) { m[f] = (n[f] + delta) | 0; if (m[f] === 0) zero = true; }
        m.clean = m.evalVersion !== 0 && ((m.markEpoch - m.evalVersion) | 0) <= 0;   // the restore check's own definition (as test/115 shiftSnap)
        return m;
    });
    if (zero) return null;
    const ids = { s: r0.nodeId(G0.s), t: r0.nodeId(G0.t), n: r0.nodeId(n0), w: G0.w ? r0.nodeId(G0.w) : 0 }, H = {};
    const st = { arm: false, throwNext: false, probe: null, runs: 0, k: 1, hits: 0 }, G = { s: null, t: null, w: null, onCleanup: null };
    const b = bodies(site, st, G, extra);
    const fnsById = { [ids.n]: site === "E" ? b.e : b.c };
    if (b.w) fnsById[ids.w] = b.w;
    const rr = M.createRegistry({ maxNodes: 8 }).restore(Object.assign({}, snap, { nodes, gv }), { fnsById, handles: H });
    G.s = H[ids.s]; G.t = H[ids.t]; G.w = b.w ? H[ids.w] : null; G.onCleanup = rr.onCleanup;
    const s = G.s, t = G.t, node = H[ids.n];
    // RAW node pointer (snapshot().evalVersion is `| 0`, D-M, and hides an out-of-int32 store): the symbol-keyed node pointer of describe()'s descriptor
    const dsc = rr.describe(node), np = Object.getOwnPropertySymbols(dsc).map((y) => dsc[y]).find((x) => x !== null && typeof x === "object");
    if (!np) fail("no node pointer on the descriptor");
    st.rawProbe = () => np.evalVersion; st.raw = null;
    let i = 1000;
    const hit = (x) => { if (x !== E) throw x; st.hits++; };
    let cycle;
    if (site === "C") cycle = () => { st.arm = true; t.set(++i); s.set(++i); node(); };
    else if (site === "E") cycle = () => { st.arm = true; t.set(++i); try { s.set(++i); } catch (x) { hit(x); } };
    else cycle = () => { st.arm = true; s.set(++i); try { node(); } catch (x) { hit(x); } s.set(++i); try { node(); } catch (x) { hit(x); } };   // 2nd read: only the first cycle can still hold an armed, unregistered state
    return { r: rr, st, node, s, t, nextI: () => ++i, hit, cycle, prep: site === "E" ? () => { s.set(++i); } : () => { s.set(++i); node(); } };
}
const trapAbs = (n) => (n < 0 ? -n : n);
void trapAbs;

if (mode === "gc3") {
    if (typeof globalThis.gc !== "function") fail("--expose-gc missing");
    needST();
    const Meng = await load(A.eng), Mref = await load(A.ref);
    let majors = 0, scav = 0, windowMajors = 0;
    new PerformanceObserver((l) => { for (const en of l.getEntries()) { if (en.detail && en.detail.kind === PC.NODE_PERFORMANCE_GC_MAJOR) majors++; else scav++; } }).observe({ entryTypes: ["gc"] });
    const tick = () => new Promise((res) => setTimeout(res, 15));
    const mk = (M, extra) => { const w = mkFar(M, A.site, A.gv, extra); if (w === null) fail("shift landed on 0"); return w; };
    const W = { ref: mk(Mref, false), eng: mk(Meng, false), reftwin: mk(Mref, false), ctl: mk(Meng, true) };
    const names = ["ref", "eng", "ctl", "reftwin"], res = { ref: [], eng: [], ctl: [], reftwin: [] }, ran = { ref: 0, eng: 0, ctl: 0, reftwin: 0 };
    const run = (nm, n) => { const w = W[nm]; for (let k = 0; k < n; k++) w.cycle(); ran[nm] += n; };
    for (const nm of names) run(nm, 3000);
    let discarded = 0, codeMoved = 0;
    for (let rd = 0; rd < A.rounds; rd++) {
        for (let q = 0; q < 4; q++) {
            const nm = names[(q + rd) % 4];
            globalThis.gc(); await tick();
            const sc0 = scav, mj0 = majors, [h0, k0] = spaces();
            run(nm, A.cycles);
            const [h1, k1] = spaces(); if (k1 !== k0) codeMoved++;
            await tick();
            if (majors !== mj0) windowMajors++;
            if (scav !== sc0 || majors !== mj0) { discarded++; continue; }
            res[nm].push((h1 - h0) / A.cycles);
        }
    }
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
    // coverage floor: the site really fired (U / E: one caught E per cycle; C: the body ran twice per cycle, original + re-pull)
    const cover = {};
    for (const nm of names) cover[nm] = A.site === "C" ? W[nm].st.runs / ran[nm] : W[nm].st.hits / ran[nm];
    console.log(JSON.stringify({ ref: med(res.ref), eng: med(res.eng), reftwin: med(res.reftwin), ctl: med(res.ctl), n: [res.ref.length, res.eng.length, res.reftwin.length, res.ctl.length], discarded, codeMoved, windowMajors, cover }));
    void sink;
} else if (mode === "val") {
    // Seeded gv: find the start gv whose cleanup-throw lands the global version exactly on A.target (probe inside the cleanup, read-only snapshot),
    // then report the node's snapshot evalVersion and the RAW field after the site fired (C: the raw field read inside the re-pull run, before the stamp).
    const M = await load(A.path);
    let out = { found: false };
    for (let k = 0; k < 60 && !out.found; k++) {
        const w = mkFar(M, A.site, (A.target - k) | 0, false);
        if (w === null) continue;
        w.prep();
        // no write follows the floor in these steps (E: the throw leaves the flush; U: the delivery ends the read), so the settled snapshot's gv IS the gv the floor read
        w.st.arm = true;
        if (A.site === "E") { w.t.set(w.nextI()); try { w.s.set(w.nextI()); } catch (x) { w.hit(x); } }
        else if (A.site === "C") { w.t.set(w.nextI()); w.s.set(w.nextI()); w.node(); }
        else { w.s.set(w.nextI()); try { w.node(); } catch (x) { w.hit(x); } }
        const gvAt = w.r.snapshot().gv;
        if (gvAt !== A.target) continue;
        const rec = w.r.snapshot().nodes.find((n) => n.id === w.r.nodeId(w.node));
        out = { found: true, k, gvAt, evalVersion: rec.evalVersion, raw: A.site === "C" ? w.st.raw : w.st.rawProbe(), hits: A.site === "C" ? w.st.runs : w.st.hits };
    }
    console.log(JSON.stringify(out));
} else if (mode === "ret3") {
    if (typeof globalThis.gc !== "function") fail("--expose-gc missing");
    const { createLeakTracker } = await import("@zakkster/lite-leak");
    const M = await load(A.path);
    const tr = createLeakTracker({ name: "ucehret" }), ctl = createLeakTracker({ name: "ucehctl" }), planted = [];
    const P = (() => {
        const r = M.createRegistry(); const s = r.signal(1); const st = { armed: false };
        const c = r.computed(() => { const v = s(); r.onCleanup(() => { if (st.armed) { st.armed = false; s.set(20); throw E; } }); return v * 10; });
        let readC = true; r.effect(() => { if (readC) c(); s(); });
        readC = false; st.armed = true; s.set(2);
        const n = r.snapshot().nodes.find((x) => x.id === r.nodeId(c));
        if (!(n && n.value && n.value.err === E)) fail("no wrapper in the snapshot");
        return Object.getPrototypeOf(n.value);
    })();
    let moved = 0;
    function one() {
        const r = M.createRegistry({ maxNodes: 16, prealloc: "lazy" }); let X, s2 = null;
        const forged = Object.create(P, { err: { get() { if (s2 === null) { r.dispose(X); s2 = r.signal(42); } return 7; } } });
        X = r.computed(() => { throw forged; });
        try { X(); } catch (e) { /* the forged object or 7 */ }
        if (s2 !== null) moved++;
        tr.track(r, null, "reg"); tr.track(forged, null, "forged"); if (s2 !== null) tr.track(s2, null, "s2");
        r.dispose(s2);
    }
    for (let i = 0; i < A.cycles; i++) one();
    for (let i = 0; i < A.cycles; i++) { const o = { i }; planted.push(o); ctl.track(o, null, "planted"); }
    for (let t = 0; t < 2; t++) { globalThis.gc(); await new Promise((res) => setTimeout(res, 30)); }
    console.log(JSON.stringify({ cycles: A.cycles, moved, size: tr.size(), ctlSize: ctl.size(), planted: planted.length }));
} else fail("unknown mode " + mode);
