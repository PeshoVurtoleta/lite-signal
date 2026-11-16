// L-1 B2 child driver (test/115-l1-overflow.test.mjs). One mode per process; prints ONE JSON line on stdout.
// usage: node [flags] l1-child.mjs <mode> '<json args>'
// Grid geometry is the B0 driver's (.handoff/l1/b0/tools/grid.mjs): the top read runs inside leaf.apply(null, ARGS[o]), every extra
// argument is one 8-byte stack slot, so o = 0..255 walks the overflow point over every 8-byte offset of the level stride.
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { PerformanceObserver, constants as PC } from "node:perf_hooks";

const [mode, argJson] = process.argv.slice(2);
const A = JSON.parse(argJson);
const V8MSG = "Maximum call stack size exceeded";
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';

function rep(t, from, to) {
    const parts = t.split(from);
    if (parts.length !== 2) { console.error("l1-child: edit anchor matched " + (parts.length - 1) + " times: " + from.slice(0, 70)); process.exit(5); }
    return parts[0] + to + parts[1];
}
const asData = (t) => import("data:text/javascript;base64," + Buffer.from(t, "utf8").toString("base64"));
// A build with Watch.js beside it loads by file URL; a vendored fixture (no Watch.js) loads from text with the re-export line removed.
async function load(p) {
    if (existsSync(dirname(p) + "/Watch.js")) return import(pathToFileURL(p).href);
    return asData(rep(readFileSync(p, "utf8"), WATCH_LINE, ""));
}
const fail = (m) => { console.error("l1-child: " + m); process.exit(6); };
const isCycle = (e) => e instanceof Error && String(e.message).startsWith("CycleError");
const lbl = (e) => (e && e.constructor && e.constructor.name) + (isCycle(e) ? ":Cycle" : "");
Error.stackTraceLimit = 6;

// ---------------- chain builders (B0 configs) ----------------
function build(M, CFG, API, N) {
    const BOX = API === "box";
    const NOOP = () => {};
    const opts = CFG === "R2"
        ? { maxNodes: 2 * N + 64, maxLinks: 8 * N + 256, prealloc: "lazy" }
        : { maxNodes: N + 16, maxLinks: 3 * N + 16, prealloc: "lazy", onCapacityExceeded: "grow" };
    const r = M.createRegistry(opts);
    const s = BOX ? r.signalBox(1) : r.signal(1);
    const t = CFG === "R6" ? (BOX ? r.signalBox(0) : r.signal(0)) : null;
    const mk = BOX ? (fn) => r.computedBox(fn) : (fn) => r.computed(fn);
    const rd = BOX ? (h) => () => h.get() : (h) => h;
    const c = new Array(N);
    const sr = rd(s);
    if (CFG === "R2") { const g = () => sr(); c[0] = mk(() => g()); }
    else if (CFG === "R5") c[0] = mk(() => { r.onCleanup(NOOP); return sr() + 1; });
    else if (CFG === "R6") { const tr = rd(t); c[0] = mk(() => tr() + sr() + 1); }
    else c[0] = mk(() => sr() + 1);
    for (let i = 1; i < N; i++) {
        const p = rd(c[i - 1]);
        if (CFG === "R2") { const g = () => p(); c[i] = mk(() => g() + 1); }
        else if (CFG === "R5") c[i] = mk(() => { r.onCleanup(NOOP); return p() + 1; });
        else if (CFG === "R6") { const tr = rd(t); c[i] = mk(() => tr() + p() + 1); }
        else c[i] = mk(() => p() + 1);
    }
    return { r, s, t, c, rs: c.map(rd), base: CFG === "R2" ? 0 : 1 };
}
function walk(g, sv, N) {
    let bad = 0;
    for (let i = 0; i < N; i++) {
        let v, k = false;
        try { v = g.rs[i](); } catch { k = true; }
        if (!k && v !== sv + i + g.base) k = true;
        if (k) bad++;
    }
    return bad;
}
// walk variant (A.walk2): same count as walk(), and classifies each bad read: wrong value / non-RangeError throw / throw === top error.
function walkCap(g, sv, N, err, c) {
    let bad = 0;
    for (let i = 0; i < N; i++) {
        let v, k = false, thrown = false, x;
        try { v = g.rs[i](); } catch (e) { k = true; thrown = true; x = e; }
        if (!k && v !== sv + i + g.base) { k = true; c.wrong++; }
        if (thrown) { if (!(x instanceof RangeError)) c.notRange++; if (x === err) c.top++; }
        if (k) bad++;
    }
    return bad;
}
const ARGS = []; for (let o = 0; o <= 255; o++) ARGS.push(new Array(o).fill(0));
let TOP = null;
function leaf() { return TOP(); }

// ---------------- modes ----------------
if (mode === "grid") {
    const M = await load(A.path);
    const N = A.N, sum = { overflowed: 0, noOverflow: 0, wedged: [], maxBefore: 0, before: {}, sameCached: 0, freshOrNew: 0, wrongValue: 0 };
    if (A.walk2) { sum.w1Wrong = 0; sum.w1NotRange = 0; sum.w1Top = 0; sum.w1BadPads = []; sum.walk2Bad = 0; sum.walk2Max = 0; sum.walk2Pads = []; }
    // two unrecorded warm-up overflows (B0 driver)
    for (let w = 0; w < 2; w++) { const g = build(M, A.cfg, A.api, N); TOP = () => g.rs[N - 1](); try { leaf.apply(null, ARGS[0]); } catch {} walk(g, 1, N); g.s.set(2); walk(g, 2, N); }
    for (let o = A.o0; o <= A.o1; o++) {
        const g = build(M, A.cfg, A.api, N); TOP = () => g.rs[N - 1]();
        let err = null;
        try { leaf.apply(null, ARGS[o]); } catch (e) { err = e; }
        if (!(err instanceof RangeError)) { sum.noOverflow++; continue; }
        sum.overflowed++;
        if (A.nosweep) {   // overflow, write, ONE top read at pad 0
            g.s.set(2); let v, e2 = null;
            try { v = leaf.apply(null, ARGS[0]); } catch (x) { e2 = x; }
            if (e2 === err) sum.sameCached++; else if (e2 === null && v !== 2 + N - 1 + g.base) sum.wrongValue++; else sum.freshOrNew++;
        } else {
            let b0;
            if (A.walk2) {
                const c = { wrong: 0, notRange: 0, top: 0 };
                b0 = walkCap(g, 1, N, err, c);
                sum.w1Wrong += c.wrong; sum.w1NotRange += c.notRange; sum.w1Top += c.top;
                if ((c.wrong || c.notRange || c.top) && sum.w1BadPads.length < 16) sum.w1BadPads.push(o);
                const b1 = walk(g, 1, N);   // second pre-write walk
                sum.walk2Bad += b1; if (b1 > sum.walk2Max) sum.walk2Max = b1;
                if (b1 > 0 && sum.walk2Pads.length < 16) sum.walk2Pads.push(o);
            } else b0 = walk(g, 1, N);
            sum.before[b0] = (sum.before[b0] || 0) + 1; if (b0 > sum.maxBefore) sum.maxBefore = b0;
            g.s.set(2);
            if (walk(g, 2, N) !== 0) sum.wedged.push(o);
        }
    }
    console.log(JSON.stringify(sum));
} else if (mode === "a4") {
    // restore(snapshot()) after every overflow pad + the exact reset record; R1 callable chain
    const M = await load(A.path);
    const N = A.N, sum = { overflowed: 0, noOverflow: 0, snapThrew: [], badRecords: 0, badPads: [], topBad: [], topWhy: "", maxBad: 0, why: {}, span: {}, restoreFailed: [], restoreMsg: "", readWrong: [] };
    const FLAG_HAS_ERROR = 16, FLAG_COMPUTING = 8;
    for (let o = A.o0; o <= A.o1; o++) {
        const g = build(M, "R1", "call", N); TOP = () => g.rs[N - 1]();
        // never-evaluated reference record, from the same registry
        const refc = g.r.computed(() => 0);
        let err = null;
        try { leaf.apply(null, ARGS[o]); } catch (e) { err = e; }
        if (!(err instanceof RangeError)) { sum.noOverflow++; continue; }
        sum.overflowed++;
        let snap;
        try { snap = g.r.snapshot(); } catch (e) { sum.snapThrew.push(o); continue; }
        const idOf = new Map(); g.c.forEach((h, i) => idOf.set(g.r.nodeId(h), i));
        const refRec = snap.nodes.find((n) => n.id === g.r.nodeId(refc));
        let bad = 0;
        for (const n of snap.nodes) {
            if (!idOf.has(n.id)) continue;
            const why = [];
            if (n.version !== 0) why.push("version=" + n.version);
            if (n.evalVersion !== 0) why.push("evalVersion=" + n.evalVersion);
            if (n.clean !== false) why.push("clean");
            if (n.value !== undefined) why.push("value=" + lbl(n.value));
            if ((n.flags & FLAG_HAS_ERROR) !== 0) why.push("HAS_ERROR");
            if ((n.flags & FLAG_COMPUTING) !== 0) why.push("COMPUTING");
            if (n.flags !== refRec.flags) why.push("flags=" + n.flags + "!=" + refRec.flags);
            if (why.length && idOf.get(n.id) === N - 1) { sum.topBad.push(o); sum.topWhy = why.join("+"); }
            if (why.length) { bad++; const ix = idOf.get(n.id); if (!(o in sum.span)) sum.span[o] = [ix, ix]; else { if (ix < sum.span[o][0]) sum.span[o][0] = ix; if (ix > sum.span[o][1]) sum.span[o][1] = ix; } const k = why.join("+"); sum.why[k] = (sum.why[k] || 0) + 1; }
        }
        sum.badRecords += bad; if (bad) sum.badPads.push(o); if (bad > sum.maxBad) sum.maxBad = bad;
        try {
            const ids = g.c.map((h) => g.r.nodeId(h)), sId = g.r.nodeId(g.s), refId = g.r.nodeId(refc);
            const H = {}, fnsById = {};
            fnsById[refId] = () => 0;
            for (let i = 0; i < N; i++) { const prev = i === 0 ? sId : ids[i - 1]; fnsById[ids[i]] = () => H[prev]() + 1; }
            g.r.restore(snap, { fnsById, handles: H });
            const a = H[ids[0]](), b = H[ids[1]]();
            if (a !== 2 || b !== 3) sum.readWrong.push(o);
        } catch (e) { sum.restoreFailed.push(o); sum.restoreMsg = lbl(e) + ": " + String(e.message).slice(0, 120); }
    }
    console.log(JSON.stringify(sum));
} else if (mode === "resetev") {
    // must-fail control: the fixture with the 4a block reduced to an evalVersion-only reset (RESETEV shape), planted overflow read
    // -> restore(snapshot()) must throw a TypeError (a computed has evalVersion 0 exactly when its version is 0).
    const text = rep(readFileSync(A.path, "utf8"), WATCH_LINE, "");
    const ANCHOR = "    function throwComputedError(node, peek) {\n        const v = node.value;\n";
    const EDIT = ANCHOR + '        if (v !== null && typeof v === "object" && v.constructor === RangeError && (v.message === "Maximum call stack size exceeded" || v.message === "Maximum call stack size exceeded.")) { node.evalVersion = 0; throw v; }\n';
    const M = await asData(rep(text, ANCHOR, EDIT));
    const r = M.createRegistry({ maxNodes: 64, prealloc: "lazy" });
    const s = r.signal(1);
    const c = r.computed(() => { s(); throw new RangeError(V8MSG); });
    try { c(); fail("planted read did not throw"); } catch (e) { if (!(e instanceof RangeError)) fail("planted read threw " + lbl(e)); }
    const snap = r.snapshot();
    const cId = r.nodeId(c), sId = r.nodeId(s);
    let out = { restore: "ok", type: "", msg: "" };
    try { const H = {}; r.restore(snap, { fnsById: { [cId]: () => { H[sId](); throw new RangeError(V8MSG); } }, handles: H }); } catch (e) { out = { restore: "threw", type: e && e.constructor && e.constructor.name, msg: String(e.message).slice(0, 200) }; }
    console.log(JSON.stringify(out));
} else if (mode === "pre") {
    // K1 (NOCLEAR-firstRunCleanupC): chain whose every node has a pre-run cleanup (runWithOwner before the first read); overflow the cold
    // read at pad o; wedged = the post-write bottom-up walk has any error / wrong value.
    const M = await load(A.path); const N = A.N, sum = { ovf: 0, wedged: [] };
    for (let o = 0; o <= 255; o++) {
        const r = M.createRegistry({ maxNodes: N + 16, maxLinks: 3 * N + 16, prealloc: "lazy", onCapacityExceeded: "grow" }); const s = r.signal(1); const c = [];
        c[0] = r.computed(() => s() + 1); for (let i = 1; i < N; i++) { const q = c[i - 1]; c[i] = r.computed(() => q() + 1); }
        for (let i = 0; i < N; i++) r.runWithOwner(c[i], () => r.onCleanup(() => {}));
        TOP = () => c[N - 1]();
        let err = null; try { leaf.apply(null, ARGS[o]); } catch (x) { err = x; }
        if (!(err instanceof RangeError)) continue; sum.ovf++;
        const walkc = (sv) => { let bad = 0; for (let i = 0; i < N; i++) { try { if (c[i]() !== sv + i + 1) bad++; } catch { bad++; } } return bad; };
        walkc(1); s.set(2); if (walkc(2) !== 0) sum.wedged.push(o);
    }
    console.log(JSON.stringify(sum));
} else if (mode === "effsweep") {
    // K1 on effects (NOCLEAR-firstRunCleanupE, SET-EARLY-E): a never-run effect (deferred by its scheduler) with a pre-run cleanup, its thunk run
    // at the stack limit (plain recursion depth dd, extra args o); afterwards a shallow re-run must not hit a stuck COMPUTING (CycleError).
    const M = await load(A.path);
    const maxD = () => { let D = 0; try { (function f() { D++; f(); })(); } catch {} return D; };
    const sweepFn = () => {
        const D = maxD();
        const sum = { pads: 0, ovf: 0, stuck: 0, other: {} };
        for (let dd = D - A.span; dd < D; dd++) for (let o = 0; o < A.args; o++) {
            const r = M.createRegistry({ maxNodes: 64, prealloc: "lazy" }); const s = r.signal(0); let pend = null;
            const e = r.effect(() => { s(); r.onCleanup(() => {}); }, { scheduler: (t) => { pend = t; } });
            r.runWithOwner(e, () => r.onCleanup(() => {}));
            sum.pads++; const f = (n) => (n === 0 ? pend() : f(n - 1) + 0);
            try { f(dd); } catch (x) { if (x instanceof RangeError) sum.ovf++; }
            try { pend(); s.set(100 + dd); } catch (x) { if (isCycle(x)) sum.stuck++; else { const k = lbl(x); sum.other[k] = (sum.other[k] || 0) + 1; } }
        }
        return sum;
    };
    const sum = sweepFn();
    console.log(JSON.stringify(sum));
} else if (mode === "gc") {
    // A5: planted-overflow serve-and-re-run cycles; B/op of the engine vs the E2 fixture in this child (a count, not a floor).
    if (typeof globalThis.gc !== "function") fail("--expose-gc missing");
    const Meng = await load(A.eng), Mref = await load(A.ref);
    const E = new RangeError(V8MSG);   // pre-allocated: the body allocates nothing
    let sink = null, majors = 0, scav = 0, windowMajors = 0;
    new PerformanceObserver((l) => { for (const en of l.getEntries()) { if (en.detail && en.detail.kind === PC.NODE_PERFORMANCE_GC_MAJOR) majors++; else scav++; } }).observe({ entryTypes: ["gc"] });
    const tick = () => new Promise((res) => setTimeout(res, 15));   // gc entries are delivered from a later task
    function mkLoop(M, extra) {
        const r = M.createRegistry({ maxNodes: 64, prealloc: "lazy" });
        const s = r.signal(0);
        const c = r.computed(() => { s(); if (extra) sink = new Array(4); throw E; });
        let i = 0;
        return (n) => { for (let k = 0; k < n; k++) { s.set(++i); try { c(); } catch (e) { if (e !== E) throw e; } } };
    }
    const loops = { ref: mkLoop(Mref, false), eng: mkLoop(Meng, false), ctl: mkLoop(Meng, true) };
    for (const k of Object.keys(loops)) loops[k](3000);   // warm
    const CYC = A.cycles, ROUNDS = A.rounds, names = ["ref", "eng", "ctl"];
    const res = { ref: [], eng: [], ctl: [] }; let scavInWindows = 0;
    for (let rd = 0; rd < ROUNDS; rd++) {
        for (let q = 0; q < 3; q++) {
            const nm = names[(q + rd) % 3];
            globalThis.gc(); await tick();
            const sc0 = scav, mj0 = majors;
            const h0 = process.memoryUsage().heapUsed;
            loops[nm](CYC);
            const h1 = process.memoryUsage().heapUsed;
            await tick();
            if (majors !== mj0) windowMajors++;
            if (scav !== sc0 || majors !== mj0) { scavInWindows++; continue; }   // a collection inside the window: discard it (counted)
            res[nm].push((h1 - h0) / CYC);
        }
    }
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
    console.log(JSON.stringify({ ref: med(res.ref), eng: med(res.eng), ctl: med(res.ctl), n: [res.ref.length, res.eng.length, res.ctl.length], discarded: scavInWindows, windowMajors }));
    void sink;
} else if (mode === "ret") {
    // A6: 64 overflow pads each disposed -> activeNodes 0, activeLinks 0, tracker size 0; WeakRef to the reset node's error cleared.
    if (typeof globalThis.gc !== "function") fail("--expose-gc missing");
    const { createLeakTracker } = await import("@zakkster/lite-leak");
    const M = await load(A.path);
    const N = A.N, tr = createLeakTracker({ name: "l1ret" });
    const settle = async () => { for (let t = 0; t < 40 && tr.size() !== 0; t++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); } return tr.size(); };
    const sum = { pads: 0, noOverflow: 0, badNodes: [], badLinks: [], badTracker: [], refCleared: null, refClearedPlanted: null };
    for (let o = 0; o < A.pads; o++) {
        let g = build(M, "R1", "call", N); TOP = () => g.rs[N - 1]();
        let err = null;
        try { leaf.apply(null, ARGS[o]); } catch (e) { err = e; }
        if (!(err instanceof RangeError)) { sum.noOverflow++; }
        sum.pads++;
        tr.track(g.r, null, "registry"); tr.track(g.c[N - 1], null, "top"); tr.track(g.c[0], null, "bottom");
        if (err) tr.track(err, null, "err");
        for (let i = 0; i < N; i++) g.r.dispose(g.c[i]);
        g.r.dispose(g.s);
        const st = g.r.stats();
        if (st.activeNodes !== 0) sum.badNodes.push([o, st.activeNodes]);
        if (st.activeLinks !== 0) sum.badLinks.push([o, st.activeLinks]);
        g = null; err = null; TOP = null;
        const left = await settle();
        if (left !== 0) sum.badTracker.push([o, left]);
    }
    // WeakRef to a reset node's error: registry and node stay ALIVE, only the error must be collectable.
    const keep = [];
    function plant() {
        const r = M.createRegistry({ maxNodes: 64, prealloc: "lazy" });
        const s = r.signal(1);
        const c = r.computed(() => { s(); throw new RangeError(V8MSG); });
        keep.push(r, s, c);
        let wr = null;
        try { c(); } catch (e) { wr = new WeakRef(e); }
        return wr;
    }
    const wr = plant();
    for (let t = 0; t < 10; t++) { await new Promise((r) => setTimeout(r, 10)); globalThis.gc(); }
    sum.refClearedPlanted = wr.deref() === undefined;
    console.log(JSON.stringify(sum));
    void keep;
} else if (mode === "ret2") {
    // B1b' retention: A.cycles worlds of A7.1 (hook peek inside X's own finally) and of A8 (hook inside a dep's finally), each disposed ->
    // activeNodes 0, activeLinks 0, tracker size 0 after gc.
    if (typeof globalThis.gc !== "function") fail("--expose-gc missing");
    const { createLeakTracker } = await import("@zakkster/lite-leak");
    const M = await load(A.path);
    const tr = createLeakTracker({ name: "l1ret2" });
    const settle = async () => { for (let t = 0; t < 40 && tr.size() !== 0; t++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); } return tr.size(); };
    const sum = { cycles: 0, badNodes: [], badLinks: [], badTracker: [] };
    const tryR = (f) => { try { f(); } catch (e) { /* the overflow is the point */ } };
    function world7() {
        const r = M.createRegistry({ maxNodes: 64 });
        const s = r.signal(0), t = r.signal(0);
        const X = r.computed(() => { if (s() === 0) { t(); return 1; } throw new RangeError(V8MSG); });
        const off = r.observeObservers(t, { onDisconnect: () => { try { X.peek(); } catch (e) { /* guarded */ } } });
        X(); s.set(1); tryR(() => X()); tryR(() => X());
        off(); r.dispose(X); r.dispose(s); r.dispose(t);
        return r;
    }
    function world8() {
        const r = M.createRegistry({ maxNodes: 64 });
        const s = r.signal(0), t = r.signal(0), k = r.signal(0), u = r.signal(0);
        let readX = true;
        const D = r.computed(() => { t(); if (k() === 0) u(); return 0; });
        const X = r.computed(() => { D(); if (s() === 1) throw new RangeError(V8MSG); return 1; });
        const Y = r.computed(() => (readX ? X() : 0));
        const off = r.observeObservers(u, { onDisconnect: () => { try { X.peek(); } catch (e) { /* guarded */ } } });
        Y(); readX = false; s.set(1); Y(); k.set(1); tryR(() => X()); tryR(() => X());
        off(); for (const h of [Y, X, D, s, t, k, u]) r.dispose(h);
        return r;
    }
    for (let i = 0; i < A.cycles; i++) {
        for (const [nm, mk] of [["a7", world7], ["a8", world8]]) {
            let r = mk();
            const st = r.stats();
            if (st.activeNodes !== 0) sum.badNodes.push([nm, i, st.activeNodes]);
            if (st.activeLinks !== 0) sum.badLinks.push([nm, i, st.activeLinks]);
            tr.track(r, null, nm);
            r = null;
        }
        sum.cycles++;
        const left = await settle();
        if (left !== 0) sum.badTracker.push([i, left]);
    }
    console.log(JSON.stringify(sum));
} else if (mode === "gc2") {
    // A13: serve-and-reset cycles at a far gv (restore of a stamp-shifted snapshot); B/op of the engine vs the E2 reference vs an A/A twin of the REFERENCE
    // (reftwin: a second registry on Mref, the tolerance source) and an engine twin (reported only) in this child; plus the allocating control. Windows with any collection are discarded and counted.
    if (typeof globalThis.gc !== "function") fail("--expose-gc missing");
    const Meng = await load(A.eng), Mref = await load(A.ref);
    const E = new RangeError(V8MSG);
    let sink = null, majors = 0, scav = 0, windowMajors = 0;
    new PerformanceObserver((l) => { for (const en of l.getEntries()) { if (en.detail && en.detail.kind === PC.NODE_PERFORMANCE_GC_MAJOR) majors++; else scav++; } }).observe({ entryTypes: ["gc"] });
    const tick = () => new Promise((res) => setTimeout(res, 15));
    function mkFar(M, gv, extra) {
        const r0 = M.createRegistry({ maxNodes: 64, prealloc: "lazy" });
        const s0 = r0.signal(1); const X0 = r0.computed(() => { s0(); throw E; });
        const snap = r0.snapshot(), delta = (gv - snap.gv) | 0;
        const nodes = snap.nodes.map((n) => {
            const m = Object.assign({}, n);
            for (const f of ["version", "evalVersion", "markEpoch"]) if (typeof n[f] === "number" && n[f] !== 0) { m[f] = (n[f] + delta) | 0; if (m[f] === 0) fail("shift landed on 0"); }
            return m;
        });
        const ids = { s: r0.nodeId(s0), X: r0.nodeId(X0) }, H = {};
        const rr = M.createRegistry({ maxNodes: 8 }).restore(Object.assign({}, snap, { nodes, gv }), { fnsById: { [ids.X]: () => { H[ids.s](); if (extra) sink = new Array(4); throw E; } }, handles: H });
        const s = H[ids.s], c = H[ids.X]; let i = 1;
        return (n) => { for (let k = 0; k < n; k++) { s.set(++i); try { c(); } catch (e) { if (e !== E) throw e; } } };
    }
    const loops = { ref: mkFar(Mref, A.gv, false), eng: mkFar(Meng, A.gv, false), twin: mkFar(Meng, A.gv, false), reftwin: mkFar(Mref, A.gv, false), ctl: mkFar(Meng, A.gv, true) };
    for (const k of Object.keys(loops)) loops[k](3000);
    const names = ["ref", "eng", "twin", "ctl", "reftwin"], res = { ref: [], eng: [], twin: [], ctl: [], reftwin: [] }; let scavInWindows = 0;
    for (let rd = 0; rd < A.rounds; rd++) {
        for (let q = 0; q < 5; q++) {
            const nm = names[(q + rd) % 5];
            globalThis.gc(); await tick();
            const sc0 = scav, mj0 = majors;
            const h0 = process.memoryUsage().heapUsed;
            loops[nm](A.cycles);
            const h1 = process.memoryUsage().heapUsed;
            await tick();
            if (majors !== mj0) windowMajors++;
            if (scav !== sc0 || majors !== mj0) { scavInWindows++; continue; }
            res[nm].push((h1 - h0) / A.cycles);
        }
    }
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
    console.log(JSON.stringify({ ref: med(res.ref), eng: med(res.eng), twin: med(res.twin), ctl: med(res.ctl), reftwin: med(res.reftwin), n: [res.ref.length, res.eng.length, res.twin.length, res.ctl.length, res.reftwin.length], discarded: scavInWindows, windowMajors }));
    void sink;
} else fail("unknown mode " + mode);
