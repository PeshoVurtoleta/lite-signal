// AUD-F group 1 child driver (test/117-audf-g1.test.mjs). One mode per process; prints ONE JSON line on stdout.
// usage: node [flags] audf-g1-child.mjs <mode> '<json args>'
// modes: sweep (A2 + A7 per-cell + HALF-FREED, run with --jitless), gc (A6, needs --expose-gc --single-threaded), ret (A7 cycles, needs --expose-gc)
// The sweep is a port of .handoff/audf/evidence/p2-halffreed.mjs (effect re-run at the stack limit, classify the registry state after).
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { PerformanceObserver, constants as PC } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";

const JS_SPACES = ["new_space", "old_space", "new_large_object_space", "large_object_space"];
function spaces() { let u = 0; for (const s of getHeapSpaceStatistics()) if (JS_SPACES.includes(s.space_name)) u += s.space_used_size; return u; }
const fail = (m) => { console.error("audf-g1-child: " + m); process.exit(6); };
function needST() { if (!process.execArgv.includes("--single-threaded")) { console.error("audf-g1-child: GC modes need --single-threaded"); process.exit(3); } for (const n of JS_SPACES) if (!getHeapSpaceStatistics().some((s) => s.space_name === n)) fail("no heap space " + n); }

const [mode, argJson] = process.argv.slice(2);
const A = JSON.parse(argJson);
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';
function rep(t, from, to) {
    const parts = t.split(from);
    if (parts.length !== 2) { console.error("audf-g1-child: edit anchor matched " + (parts.length - 1) + " times: " + from.slice(0, 70)); process.exit(5); }
    return parts[0] + to + parts[1];
}
// A build with Watch.js beside it loads by file URL; the vendored fixture (no Watch.js) loads from text with the re-export line removed.
async function load(p) {
    if (existsSync(dirname(p) + "/Watch.js")) return import(pathToFileURL(p).href);
    return import("data:text/javascript;base64," + Buffer.from(rep(readFileSync(p, "utf8"), WATCH_LINE, ""), "utf8").toString("base64"));
}

// ---------------- A2 classifier (the p2 key string) ----------------
const RX_STUCK = /isTracking=true|owner=true|reset=\(a computed \/ effect body is running\)|snap=\(flush\/batch\/track in progress\) \| woke=0 /;
const TAIL = " \\| errs= \\| snapAfter=SA \\| links=\\d+ \\| runsAtOvf=\\d+ \\| isTracking=false \\| owner=false \\| reset=ok \\| newEffect=ok$";
const RX_CLEAN = new RegExp("^OVF snap=ok \\| woke=3" + TAIL.replace("SA", "ok"));
const RX_G2 = new RegExp("^OVF snap=\\(scheduled effect run pending\\) \\| woke=0" + TAIL.replace("SA", "\\(scheduled effect run pending\\)"));
const RX_RECOVERED = new RegExp("^OVF snap=\\(scheduled effect run pending\\) \\| woke=3" + TAIL.replace("SA", "ok"));
function classOf(k) {
    if (k === "ok") return "OK";
    if (RX_STUCK.test(k)) return "STUCK";
    if (RX_G2.test(k)) return "KNOWN-G2";
    if (RX_CLEAN.test(k)) return "CLEAN";
    if (RX_RECOVERED.test(k)) return "RECOVERED";
    return "UNKNOWN";
}
// HALF-FREED: the walked source-link count differs from the observer-link count, or from stats().activeLinks.
function halfClassify(m, links) { return (m.src !== m.obs || m.src !== links) ? ("src=" + m.src + " obs=" + m.obs + " links=" + links + " nodes=" + m.nodes) : null; }

if (mode === "sweep") {
    const { createRegistry } = await load(A.path);
    const BELOW = A.below, PADS = A.pads, SHAPE = A.shape;
    const ARGS = []; for (let o = 0; o < PADS; o++) ARGS.push(new Array(o).fill(0));
    let S = null, HALF = null, HALF_OVF = null;
    const walkMin = { nodes: 1e9, links: 1e9 };
    function linkSums(r, roots) {
        const seen = new Map(), q = [];
        for (const h of roots) { const d = h == null ? undefined : r.describe(h); if (d !== undefined && !seen.has(d.id)) { seen.set(d.id, d); q.push(d); } }
        let src = 0, obs = 0;
        while (q.length) {
            const d = q.pop();
            r.forEachSource(d, (x) => { src++; if (!seen.has(x.id)) { seen.set(x.id, x); q.push(x); } });
            r.forEachObserver(d, (x) => { obs++; if (!seen.has(x.id)) { seen.set(x.id, x); q.push(x); } });
        }
        return { nodes: seen.size, src, obs };
    }
    function half(r, roots, links) {
        const m = linkSums(r, roots);
        if (m.nodes < walkMin.nodes) walkMin.nodes = m.nodes;
        if (m.src < walkMin.links) walkMin.links = m.src;
        return halfClassify(m, links);
    }
    function leaf() { S.set(1); }
    const f = (n, o) => (n === 0 ? leaf.apply(null, ARGS[o]) : f(n - 1, o) + 0);
    const ret = { checked: 0, bad: 0, badStuck: 0, badOther: 0, examples: [] };
    function cell(dd, o) {
        const r = createRegistry({ maxNodes: 64, prealloc: "lazy" });
        const s = r.signal(0), d1 = r.signal(0), d2 = r.signal(0);
        let runs = 0, c = null, eh = null;
        if (SHAPE === "computed") { c = r.computed(() => s() + d1()); eh = r.effect(() => { c(); d2(); runs++; }); }
        else eh = r.effect(() => { s(); d1(); d2(); runs++; });
        const ROOTS = [s, d1, d2, c, eh]; HALF = null; HALF_OVF = null;
        S = s;
        let err = null;
        try { f(dd, o); } catch (x) { err = x; }
        if (err === null) { HALF = half(r, ROOTS, r.stats().activeLinks); return "ok"; }
        HALF_OVF = half(r, ROOTS, r.stats().activeLinks);
        if (!(err instanceof RangeError)) return "nonRange:" + err.message;
        let snap = "ok"; try { r.snapshot(); } catch (e) { snap = e.message.replace("[lite-signal] snapshot: graph not settled ", ""); }
        const r0 = runs; const errs = [];
        for (const [sig, v] of [[s, 5], [d1, 6], [d2, 7]]) { try { sig.set(v); } catch (e) { errs.push(String(e.message).slice(0, 40)); } }
        const woke = runs - r0;
        let snap2 = "ok"; try { r.snapshot(); } catch (e) { snap2 = e.message.replace("[lite-signal] snapshot: graph not settled ", ""); }
        const st = r.stats();
        HALF = half(r, ROOTS, st.activeLinks);
        const trk = r.isTracking(), own = r.getOwner() !== undefined;
        // A7 per overflow cell, BEFORE reset(): dispose everything, create one signal -> activeNodes 1
        const stuckNow = trk || own || /flush\/batch\/track in progress/.test(snap2);
        let nodesAfter = "threw";
        try { for (const h of [eh, c, s, d1, d2]) if (h != null) r.dispose(h); r.signal(0); nodesAfter = r.stats().activeNodes; } catch (e) { nodesAfter = "THROW " + String(e.message).slice(0, 50); }
        ret.checked++;
        if (nodesAfter !== 1) { ret.bad++; if (stuckNow) ret.badStuck++; else ret.badOther++; if (ret.examples.length < 4) ret.examples.push([dd, o, nodesAfter]); }
        let rs = "ok"; try { r.reset(); } catch (e) { rs = String(e.message).replace("[lite-signal] reset: graph not settled ", ""); }
        let e2 = "ok"; try { const r2s = r.signal(0); let n = 0; const d = r.effect(() => { r2s(); n++; }); r2s.set(1); if (n !== 2) e2 = "newEffectRuns=" + n; d(); } catch (e) { e2 = "THROW " + String(e.message).slice(0, 50); }
        const key = "OVF snap=" + snap + " | woke=" + woke + " | errs=" + errs.join(",") + " | snapAfter=" + snap2 + " | links=" + st.activeLinks + " | runsAtOvf=" + r0 + " | isTracking=" + trk + " | owner=" + own + " | reset=" + rs + " | newEffect=" + e2;
        return key;
    }
    const t0 = Date.now();
    for (let w = 0; w < 200; w++) cell(50, w % PADS);                      // warm the path shallow
    let lo = 1, hi = 1 << 20;                                              // first overflowing depth (pad 0)
    while (lo < hi) { const m = (lo + hi) >> 1; if (cell(m, 0) === "ok") lo = m + 1; else hi = m; }
    let D1 = lo, okRun = 0; while (okRun < 6 && D1 > 1) { D1--; if (cell(D1, 0) === "ok") okRun++; else okRun = 0; }
    const D0 = D1 + 6;
    ret.checked = 0; ret.bad = 0; ret.badStuck = 0; ret.badOther = 0; ret.examples = [];
    const sum = { D0, cells: 0, classes: {}, byClass: {}, unknown: [], halfFreed: 0, halfAtOvf: 0, halfExamples: [], walkMin: null, ret: null, ctl: null, ms: 0 };
    for (let dd = D0 - 4; dd <= D0 + BELOW; dd++) for (let o = 0; o < PADS; o++) {
        const k = cell(dd, o); sum.cells++;
        const cl = classOf(k);
        sum.classes[k] = (sum.classes[k] || 0) + 1;
        sum.byClass[cl] = (sum.byClass[cl] || 0) + 1;
        if (cl === "UNKNOWN" && sum.unknown.length < 4) sum.unknown.push([dd - D0, o, k]);
        if (HALF !== null) { sum.halfFreed++; if (sum.halfExamples.length < 3) sum.halfExamples.push([dd - D0, o, HALF]); }
        if (HALF_OVF !== null) sum.halfAtOvf++;
    }
    sum.walkMin = walkMin; sum.ret = ret;
    // must-fail control of the HALF-FREED classifier: planted count mismatches must classify, an agreeing triple must not
    sum.ctl = {
        srcNeObs: halfClassify({ nodes: 4, src: 3, obs: 2 }, 3) !== null,
        srcNeLinks: halfClassify({ nodes: 4, src: 3, obs: 3 }, 4) !== null,
        agree: halfClassify({ nodes: 4, src: 3, obs: 3 }, 3) === null
    };
    sum.ms = Date.now() - t0;
    console.log(JSON.stringify(sum));
} else if (mode === "gc") {
    // A6: 10,000 conditional-dep flips (severStale runs on every flip: one of two effects drops x on each flip) allocate 0 B/op.
    // JS heap spaces only, --single-threaded (CI class 18, as test/115 A5). ctl: the same loop plus one module-scope-stored object per flip.
    if (typeof globalThis.gc !== "function") fail("--expose-gc missing");
    needST();
    const Meng = await load(A.eng), Mref = await load(A.ref);
    let sink = null, majors = 0, scav = 0, windowMajors = 0;
    new PerformanceObserver((l) => { for (const en of l.getEntries()) { if (en.detail && en.detail.kind === PC.NODE_PERFORMANCE_GC_MAJOR) majors++; else scav++; } }).observe({ entryTypes: ["gc"] });
    const tick = () => new Promise((res) => setTimeout(res, 15));
    function mkLoop(M, extra) {
        const r = M.createRegistry({ maxNodes: 64, prealloc: "lazy" });
        const g = r.signal(0), x = r.signal(0);
        let ea = 0, eb = 0;
        r.effect(() => { ea++; if ((g() & 1) === 0) x(); });   // drops x on every even -> odd flip
        r.effect(() => { eb++; if ((g() & 1) === 1) x(); });   // drops x on every odd -> even flip
        const c = r.computed(() => ((g() & 1) === 0 ? x() : 0));
        let i = 0;
        return (n) => { for (let k = 0; k < n; k++) { g.set(++i); c(); if (extra) sink = { i }; } if (ea + eb < 0) throw new Error("unreachable"); };
    }
    const loops = { ref: mkLoop(Mref, false), eng: mkLoop(Meng, false), ctl: mkLoop(Meng, true) };
    for (const k of Object.keys(loops)) loops[k](3000);   // warm
    const names = ["ref", "eng", "ctl"], res = { ref: [], eng: [], ctl: [] }; let discarded = 0;
    for (let rd = 0; rd < A.rounds; rd++) {
        for (let q = 0; q < 3; q++) {
            const nm = names[(q + rd) % 3];
            globalThis.gc(); await tick();
            const sc0 = scav, mj0 = majors;
            const h0 = spaces();
            loops[nm](A.cycles);
            const h1 = spaces();
            await tick();
            if (majors !== mj0) windowMajors++;
            if (scav !== sc0 || majors !== mj0) { discarded++; continue; }
            res[nm].push((h1 - h0) / A.cycles);
        }
    }
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
    console.log(JSON.stringify({ ref: med(res.ref), eng: med(res.eng), ctl: med(res.ctl), n: [res.ref.length, res.eng.length, res.ctl.length], discarded, windowMajors }));
    void sink;
} else if (mode === "ret") {
    // A7: A.cycles x (registry, conditional effect, an epilogue hook that throws once, dispose all) -> tracker size 0, activeLinks 0 each cycle.
    if (typeof globalThis.gc !== "function") fail("--expose-gc missing");
    const { createLeakTracker } = await import("@zakkster/lite-leak");
    const M = await load(A.path);
    const tr = createLeakTracker({ name: "audfg1ret" });
    const settle = async () => { for (let t = 0; t < 60 && tr.size() !== 0; t++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); } return tr.size(); };
    const sum = { cycles: 0, hookThrows: 0, badLinks: [], badNodes: [], badOther: [], tracked: 0, trackerLeft: -1 };
    function cycle(i) {   // own frame: no local of the last cycle stays reachable from the loop
        const r = M.createRegistry({ maxNodes: 64 });
        const g = r.signal(0), x = r.signal(0);
        let armed = false;
        const off = r.observeObservers(x, { onDisconnect: () => { if (armed) { armed = false; throw new Error("hook once"); } } });
        const e = r.effect(() => { if ((g() & 1) === 0) x(); });
        const c = r.computed(() => ((g() & 1) === 0 ? x() : 0));
        c();
        armed = true;
        g.set(1);   // the effect re-runs and drops x (still observed by c)
        // c re-runs and drops x: 1 -> 0, the hook throws out of the computed epilogue
        try { c(); } catch (err) { if (err && err.message === "hook once") sum.hookThrows++; else sum.badOther.push([i, String(err && err.message).slice(0, 40)]); }
        off();
        r.dispose(e); r.dispose(c); r.dispose(g); r.dispose(x);
        const st = r.stats();
        if (st.activeLinks !== 0) sum.badLinks.push([i, st.activeLinks]);
        if (st.activeNodes !== 0) sum.badNodes.push([i, st.activeNodes]);
        tr.track(r, null, "registry"); tr.track(e, null, "effect"); tr.track(c, null, "computed");
        sum.tracked++; sum.cycles++;
    }
    for (let i = 0; i < A.cycles; i++) cycle(i);
    sum.trackerLeft = await settle();
    console.log(JSON.stringify(sum));
} else fail("unknown mode " + mode);
