// 35-cursor-safety.test.mjs -- engine group A1 oracle (F15, F8, F13 + suspects S1-S5, S8).
//
// Written from SPEC-A.md (section 0.2 suspects, section A1 ASSERTIONS) and the
// audit probes, NOT from the patched engine. Every expectation is derived from the
// documented semantics; the derivation sits in a comment above it.
//
// Class under test: user code (bodies, lifecycle callbacks, cleanups) runs while a
// suspended frame or a list walk holds a raw pointer into a dependency list or a
// node. Disposal from that user code must leave every cursor valid and the graph
// consistent.
//
// Link accounting used throughout: stats().activeLinks counts edges
// source -> observer, one per (source, observer) pair, for effects AND computeds.
// A disposed handle read inside a body returns undefined and records no edge.
// stats().signals / computeds / effects are LIVE counts (they decrement on dispose).
//
// Each test names its SPEC id. Tests are regression oracles: all must fail on the
// frozen pre-fix kernels (head / wt0); P6, P6b and the replay seed also on headpatched.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createRegistry } from "../Signal.js";

const mk = () => createRegistry();
const links = (r) => r.stats().activeLinks;
const nodes = (r) => r.stats().activeNodes;
function countSources(r, h) { let n = 0; r.forEachSource(h, () => { n++; }); return n; }

// ---------------------------------------------------------------------------
// F15 -- cursors of SUSPENDED frames (P6 .. P11)
// ---------------------------------------------------------------------------
describe("F15 suspended-frame cursors", () => {
    it("P6: nested computed retrack -> onDisconnect disposes a dep the outer effect reads later", () => {
        const r = mk();
        const t = r.signal(0), x = r.signal(0), a = r.signal(0), b = r.signal(0);
        let mode = 0, runs = 0, lastB;
        const inner = r.computed(() => (mode === 0 ? x() : 0) + t());
        r.observeObservers(x, { onDisconnect: () => r.dispose(a) });
        r.effect(() => { runs++; t(); inner(); a(); lastB = b(); });
        assert.equal(runs, 1);
        mode = 1;
        t.set(1);                                   // must not throw
        assert.equal(runs, 2);
        // Derivation: effect keeps t, inner, b (a was disposed mid-run, a() records
        // nothing) = 3 links; inner keeps only t = 1 link (x dropped). Total 4.
        assert.equal(links(r), 4);
        const before = runs;
        b.set(42);
        assert.equal(runs, before + 1, "effect still reacts to b (not silently dead)");
        assert.equal(lastB, 42);
        const before2 = runs;
        t.set(2);
        assert.equal(runs, before2 + 1, "effect still reacts to t");
        assert.equal(links(r), 4);
    });

    it("P6b: same shape as P6 -- no error escapes either set, effect keeps reacting", () => {
        const r = mk();
        const t = r.signal(0), x = r.signal(0), a = r.signal(0), b = r.signal(0);
        let mode = 0, runs = 0, lastB;
        const inner = r.computed(() => (mode === 0 ? x() : 0) + t());
        r.observeObservers(x, { onDisconnect: () => r.dispose(a) });
        r.effect(() => { runs++; t(); inner(); a(); lastB = b(); });
        mode = 1;
        assert.doesNotThrow(() => t.set(1));
        assert.equal(links(r), 4);
        const r0 = runs;
        assert.doesNotThrow(() => b.set(42));
        assert.equal(runs, r0 + 1);
        assert.equal(lastB, 42);
        assert.doesNotThrow(() => t.set(2));
        assert.equal(runs, r0 + 2);
        // b is still observed by the effect; a is gone.
        assert.equal(r.hasObservers(b), true);
        assert.equal(r.hasObservers(a), false);
    });

    it("P7: nested computed body disposes a dep the OUTER effect reads later", () => {
        const r = mk();
        const t = r.signal(0), a = r.signal(0), b = r.signal(0);
        let mode = 0, runs = 0;
        const inner = r.computed(() => { if (mode === 1) r.dispose(a); return t(); });
        r.effect(() => { runs++; t(); inner(); a(); b(); });
        mode = 1;
        assert.doesNotThrow(() => t.set(1));
        // Derivation: effect t, inner, b = 3; inner t = 1. Total 4.
        assert.equal(links(r), 4);
        const r0 = runs;
        b.set(1);
        assert.equal(runs, r0 + 1, "b.set re-runs the effect exactly once");
    });

    it("P8: outer effect ends after the inner dispose (severTail path)", () => {
        const r = mk();
        const t = r.signal(0), a = r.signal(0), b = r.signal(0);
        let mode = 0, runs = 0;
        const inner = r.computed(() => { if (mode === 1) r.dispose(a); return t(); });
        r.effect(() => { runs++; t(); inner(); if (mode === 0) { a(); b(); } });
        mode = 1;
        assert.doesNotThrow(() => t.set(1));
        // Derivation: run 2 reads only t and inner: effect 2 links; inner t = 1. Total 3.
        assert.equal(links(r), 3);
        const r0 = runs;
        b.set(9);                                   // b is no longer a dependency
        assert.equal(runs, r0);
        t.set(2);
        assert.equal(runs, r0 + 1);
        assert.equal(links(r), 3);
    });

    it("P9: outer computed, inner computed disposes the outer's cursor dep", () => {
        const r = mk();
        const t = r.signal(0), a = r.signal(0), b = r.signal(0);
        let mode = 0;
        const inner = r.computed(() => { if (mode === 1) r.dispose(a); return t(); });
        const outer = r.computed(() => { t(); inner(); if (mode === 0) { a(); b(); } return mode; });
        assert.equal(outer(), 0);
        mode = 1;
        t.set(1);
        // Derivation: outer returns mode (=1). Outer deps t, inner = 2; inner dep t = 1. Total 3.
        assert.doesNotThrow(() => outer());
        assert.equal(outer(), 1);
        assert.equal(links(r), 3);
    });

    it("P10: child effect's first (nested) run disposes a signal the parent reads later", () => {
        const r = mk();
        const t = r.signal(0), a = r.signal(0), b = r.signal(0);
        let mode = 0, runs = 0;
        r.effect(() => { runs++; t(); if (mode === 1) r.effect(() => { r.dispose(a); }); a(); b(); });
        mode = 1;
        assert.doesNotThrow(() => t.set(1));
        assert.equal(runs, 2);
        // Derivation: parent keeps t, b (a disposed) = 2 links; the child has no deps.
        assert.equal(links(r), 2);
        mode = 0;                                   // no more children from here on
        b.set(5);
        // Derivation: runs 1 (initial) + 1 (t.set) + 1 (b.set) = 3.
        assert.equal(runs, 3);
        assert.equal(links(r), 2);
    });

    it("P11: untrack + computed body disposes the outer effect's cursor dep", () => {
        // NOTE: the audit probe (inner with no deps) never recomputes, so it cannot
        // dispose anything. Here inner depends on t, so it IS stale on the t.set and
        // recomputes inside untrack while the effect is suspended on its cursor.
        const r = mk();
        const t = r.signal(0), a = r.signal(0), b = r.signal(0);
        let mode = 0, runs = 0;
        const inner = r.computed(() => { t(); if (mode === 1) r.dispose(a); return 1; });
        r.effect(() => { runs++; t(); r.untrack(() => inner()); a(); b(); });
        assert.equal(links(r), 4);                  // effect t,a,b + inner t
        mode = 1;
        assert.doesNotThrow(() => t.set(1));
        // Derivation: untrack means no effect->inner edge. Effect keeps t, b = 2; inner t = 1. Total 3.
        assert.equal(links(r), 3);
        const r0 = runs;
        b.set(3);
        assert.equal(runs, r0 + 1);
    });
});

// ---------------------------------------------------------------------------
// F8 / F13 -- lifecycle callbacks fire in the middle of a list walk
// ---------------------------------------------------------------------------
describe("F8 / F13 walk pointers across lifecycle callbacks", () => {
    it("F8: disposeNode dLink walk -- onDisconnect(a) disposes b", () => {
        const r = mk();
        const a = r.signal(0), b = r.signal(0);
        r.observeObservers(a, { onDisconnect: () => r.dispose(b) });
        const stop = r.effect(() => { a(); b(); });
        assert.equal(links(r), 2);
        assert.doesNotThrow(() => stop());
        assert.equal(links(r), 0);
        // Derivation: effect gone, b disposed by the callback, a survives.
        assert.equal(r.stats().signals, 1);
        assert.equal(r.stats().effects, 0);
    });

    it("F13: severTail walk -- gate false drops [a, b], onDisconnect(a) disposes b", () => {
        const r = mk();
        const gate = r.signal(true), a = r.signal(0), b = r.signal(0);
        r.observeObservers(a, { onDisconnect: () => r.dispose(b) });
        r.effect(() => { if (gate()) { a(); b(); } });
        assert.equal(links(r), 3);
        assert.doesNotThrow(() => gate.set(false));
        // Derivation: the effect keeps only the gate link; signals gate and a survive.
        assert.equal(links(r), 1);
        assert.equal(r.stats().signals, 2);
    });

    it("allocateLink-sever variant: deps [g, a, b] -> [g, x], onDisconnect(a) disposes b", () => {
        const r = mk();
        const g = r.signal(0), a = r.signal(0), b = r.signal(0), x = r.signal(0);
        let mode = 0, runs = 0;
        r.observeObservers(a, { onDisconnect: () => r.dispose(b) });
        r.effect(() => { runs++; g(); if (mode === 0) { a(); b(); } else { x(); } });
        assert.equal(links(r), 3);
        mode = 1;
        // Reading x finds a mismatched cursor (a's link) and severs the tail [a, b]
        // from inside allocateLink; the callback disposes b mid-walk.
        assert.doesNotThrow(() => g.set(1));
        // Derivation: effect keeps g and x = 2 links. Signals g, a, x survive (b disposed).
        assert.equal(links(r), 2);
        assert.equal(r.stats().signals, 3);
        const r0 = runs;
        x.set(1);
        assert.equal(runs, r0 + 1, "the new dep x is live");
    });
});

// ---------------------------------------------------------------------------
// Suspects S1 .. S5, S8 (derived from documented semantics)
// ---------------------------------------------------------------------------
describe("suspects S1-S5, S8", () => {
    // S1 runs in a worker thread: on a pre-fix engine the half-inserted edge can make
    // allocateLink loop forever, and a synchronous hang must surface as a failure,
    // not freeze the whole test run.
    it("S1: onConnect disposes its own source while the edge is being inserted", async () => {
        const code = `
            const { parentPort, workerData } = require("node:worker_threads");
            import(workerData.url).then(({ createRegistry }) => {
                const r = createRegistry();
                const x = r.signal(0), a = r.signal(0), y = r.signal(0);
                let connects = 0, runs = 0;
                r.observeObservers(a, { onConnect: () => { connects++; r.dispose(a); } });
                r.effect(() => { runs++; x(); a(); y(); });
                const o = { connects, links: r.stats().activeLinks, signals: r.stats().signals,
                            nodes: r.stats().activeNodes, runs1: runs };
                x.set(1); o.runs2 = runs;
                y.set(1); o.runs3 = runs;
                o.linksEnd = r.stats().activeLinks;
                parentPort.postMessage(o);
            }).catch((e) => parentPort.postMessage({ error: String(e && e.stack || e) }));
        `;
        const o = await new Promise((resolve) => {
            const w = new Worker(code, { eval: true, workerData: { url: new URL("../Signal.js", import.meta.url).href } });
            const timer = setTimeout(() => { w.terminate(); resolve({ error: "hang: no result within 5 s" }); }, 5000);
            w.once("message", (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
            w.once("error", (e) => { clearTimeout(timer); resolve({ error: String(e) }); });
        });
        assert.equal(o.error, undefined, o.error);
        // Derivation: onConnect fires once, on a's 0->1 transition, after the edge is
        // fully inserted (registered divergence DV-A1-2). Disposing a frees that edge
        // and nothing else; the effect goes on to read y. So the effect holds x and y
        // = 2 links; a is gone (signals x, y); nodes = x, y, effect = 3.
        assert.equal(o.connects, 1);
        assert.equal(o.links, 2);
        assert.equal(o.signals, 2);
        assert.equal(o.nodes, 3);
        assert.equal(o.runs1, 1);
        // Both surviving deps are live (the dep list is not orphaned).
        assert.equal(o.runs2, 2, "x.set re-runs the effect");
        assert.equal(o.runs3, 3, "y.set re-runs the effect");
        assert.equal(o.linksEnd, 2);
    });

    it("S2: a nested frame disposes the SUSPENDED outer observer (slot recycling)", () => {
        const r = mk();
        const t = r.signal(0), a = r.signal(0), b = r.signal(0);
        let mode = 0, runs = 0, fresh, stopOuter;
        stopOuter = r.effect(() => {
            runs++;
            t();
            if (mode) r.effect(() => { stopOuter(); fresh = r.signal(7); });
            a(); b();
        });
        assert.equal(links(r), 3);
        mode = 1;
        assert.doesNotThrow(() => t.set(1));
        // Derivation: the outer effect is disposed from inside its own child (it was
        // suspended in a nested frame). A disposed observer owns/tracks nothing: after
        // the child returns the outer's body keeps running but its reads a(), b() must
        // NOT record edges (currentObserver is restored to null, not to a recycled slot).
        // So: 0 links, 0 effects, observers of t/a/b = none, and `fresh` (a signal
        // created inside the child) has 0 sources -- a signal never has sources, a
        // phantom count means the recycled slot was reinstalled as an observer.
        assert.equal(runs, 2);
        assert.equal(links(r), 0);
        assert.equal(r.stats().effects, 0);
        assert.equal(r.hasObservers(t), false);
        assert.equal(r.hasObservers(a), false);
        assert.equal(r.hasObservers(b), false);
        assert.equal(countSources(r, fresh), 0);
        assert.equal(fresh.peek(), 7);
        // Live nodes: t, a, b, fresh.
        assert.equal(nodes(r), 4);
        assert.equal(r.stats().signals, 4);
        // The dead outer stays dead.
        t.set(2); a.set(1); b.set(1);
        assert.equal(runs, 2);
        // The free list is sound: two new signals are distinct nodes.
        const p = r.signal(1), q = r.signal(2);
        p.set(10);
        assert.equal(q.peek(), 2);
        assert.equal(p.peek(), 10);
        assert.equal(fresh.peek(), 7);
        assert.equal(nodes(r), 6);
    });

    // S3 stayed GREEN on every frozen kernel (head, headpatched, wt0): the freed pre-walk
    // link keeps a usable nextDep in practice, even when 0..3 extra effects recycle
    // free-list links inside C's body. Kept as a regression pin for A1.9 (extra = number
    // of throwaway effects created right after C disposes itself, to churn the free list).
    for (const extra of [0, 1, 3]) {
        it(`S3: a dep computed that disposes itself in the pre-walk must not hide a later changed dep (extra=${extra}; regression pin)`, () => {
            const r = mk();
            const k = r.signal(0), x = r.signal(0);
            const zs = [r.signal(0), r.signal(0), r.signal(0)];
            let seen = -1, runs = 0;
            const C = r.computed(() => {
                if (k() === 1) { r.dispose(C); for (let i = 0; i < extra; i++) r.effect(() => { zs[i](); }); }
                return undefined;
            });
            r.effect(() => { runs++; C(); seen = x(); });
            assert.equal(seen, 0);
            r.batch(() => { k.set(1); x.set(5); });
            // Derivation: x changed in the batch, so the effect MUST re-run and see 5
            // (a stale 0 would be a fail-open miss). It re-runs exactly once: 1 + 1.
            assert.equal(seen, 5);
            assert.equal(runs, 2);
            // C is gone (no edge for it, its k edge freed); the effect->x edge remains,
            // plus one edge per throwaway effect.
            assert.equal(links(r), 1 + extra);
            assert.equal(r.stats().computeds, 0);
            x.set(6);
            assert.equal(seen, 6);
            assert.equal(runs, 3);
        });
    }

    // Three children C0..C2 under one owner; the cleanup of child `d` disposes C1
    // during the owner's cascade. Whichever order the cascade walks the siblings,
    // one of the two variants (d=0, d=2) disposes a sibling the walk has not reached.
    // Measured on the frozen kernels: d=2 is red, d=0 is green (the cascade walks
    // newest-first), so d=0 is a regression pin kept for order independence.
    for (const d of [0, 2]) {
        it(`S4: cascade survives a child cleanup that disposes a sibling (cleanup of C${d} disposes C1)`, () => {
            const r = mk();
            const trig = r.signal(0);
            const s = [r.signal(0), r.signal(0), r.signal(0)];
            const runs = [0, 0, 0];
            const stops = [];
            let make = true;
            r.effect(() => {
                trig();
                if (!make) return;
                for (let i = 0; i < 3; i++) {
                    stops.push(r.effect(() => {
                        runs[i]++;
                        s[i]();
                        if (i === d) r.onCleanup(() => stops[1]());
                    }));
                }
            });
            assert.equal(r.stats().effects, 4);
            assert.equal(links(r), 4);                    // trig + one per child
            make = false;
            trig.set(1);                                  // owner re-runs: all three children die
            // Derivation: an owner re-run disposes ALL its owned children before the
            // body runs again; the body (make=false) creates none. So 1 effect (the
            // owner), 1 link (trig), nodes = trig + 3 signals + owner = 5, and no
            // child reacts any more (each ran exactly once, at creation).
            assert.equal(r.stats().effects, 1);
            assert.equal(links(r), 1);
            assert.equal(nodes(r), 5);
            for (let i = 0; i < 3; i++) {
                assert.equal(r.hasObservers(s[i]), false, `s${i} has no observer`);
                s[i].set(1);
                assert.equal(runs[i], 1, `child ${i} did not react`);
            }
            // Free list is sound afterwards.
            const p = r.signal(1), q = r.signal(2);
            p.set(10);
            assert.equal(q.peek(), 2);
        });
    }

    it("S5: a throwing op-5 hook on an effect's first run does not strand the context (regression pin: effect() restores context itself)", () => {
        const r = mk();
        const s = r.signal(0);
        let fired = 0;
        const off = r.onGraphMutation((op) => { if (op === 5) { fired++; throw new Error("hook"); } });
        try { r.effect(() => { s(); }); } catch (e) { /* either surfacing is acceptable */ }
        off();
        assert.ok(fired >= 1, "the op-5 hook actually fired");
        // Derivation: observer context is restored whatever the hook did, so at top
        // level nothing is tracking.
        assert.equal(r.isTracking(), false);
        // A fresh effect on the same registry still tracks normally.
        const base = links(r);
        const p = r.signal(1), q = r.signal(2);
        let sum = 0;
        r.effect(() => { sum = p() + q(); });
        assert.equal(sum, 3);
        assert.equal(links(r), base + 2);
        p.set(5);
        assert.equal(sum, 7);
    });

    it("S5: a throwing op-5 hook on an effect RE-run does not strand the context", () => {
        const r = mk();
        const s = r.signal(0);
        let armed = false, fired = 0;
        r.effect(() => { s(); });
        const off = r.onGraphMutation((op) => { if (armed && op === 5) { fired++; throw new Error("hook"); } });
        armed = true;
        try { s.set(1); } catch (e) { /* either surfacing is acceptable */ }
        armed = false;
        off();
        assert.ok(fired >= 1, "the op-5 hook fired on the re-run");
        assert.equal(r.isTracking(), false);
        const p = r.signal(1);
        let seen = 0;
        r.effect(() => { seen = p(); });
        p.set(9);
        assert.equal(seen, 9);
    });

    it("S5: a throwing op-5 hook on a computed pull does not strand the context", () => {
        const r = mk();
        const s = r.signal(1);
        const c = r.computed(() => s() * 2);
        let fired = 0;
        const off = r.onGraphMutation((op) => { if (op === 5) { fired++; throw new Error("hook"); } });
        try { c(); } catch (e) { /* the error is cached as the computed's error (DV-S5) */ }
        off();
        assert.ok(fired >= 1, "the op-5 hook fired on the pull");
        assert.equal(r.isTracking(), false);
        const p = r.signal(2);
        let seen = 0;
        r.effect(() => { seen = p(); });
        p.set(3);
        assert.equal(seen, 3);
    });

    it("S8: onDisconnect disposes the very computed being disposed (3 deps)", () => {
        const r = mk();
        const a = r.signal(1), b = r.signal(2), d = r.signal(3);
        const c = r.computed(() => a() + b() + d());
        assert.equal(c(), 6);
        assert.equal(links(r), 3);
        let calls = 0;
        r.observeObservers(a, { onDisconnect: () => { calls++; r.dispose(c); } });
        assert.doesNotThrow(() => r.dispose(c));
        // Derivation: a's 1->0 transition fires exactly once; the re-entrant dispose is
        // a no-op for an already-dying node. All 3 edges are gone; a, b, d survive.
        assert.equal(calls, 1);
        assert.equal(links(r), 0);
        assert.equal(nodes(r), 3);
        assert.equal(r.stats().computeds, 0);
        // The slot must have been released exactly once: two new signals are distinct.
        const p = r.signal(1), q = r.signal(2);
        assert.equal(p.peek(), 1);
        assert.equal(q.peek(), 2);
        p.set(10);
        assert.equal(q.peek(), 2);
        assert.equal(p.peek(), 10);
        assert.equal(nodes(r), 5);
    });

    it("S8 (cleanup variant): an effect disposes itself from its own cleanup (regression pin)", () => {
        const r = mk();
        const s = r.signal(0);
        let stop, cleanups = 0;
        stop = r.effect(() => { s(); r.onCleanup(() => { cleanups++; stop(); }); });
        assert.equal(links(r), 1);
        assert.doesNotThrow(() => stop());
        // Derivation: the cleanup runs once and the nested stop() is a no-op.
        assert.equal(cleanups, 1);
        assert.equal(links(r), 0);
        assert.equal(r.stats().effects, 0);
        assert.equal(nodes(r), 1);
        const p = r.signal(1), q = r.signal(2);
        p.set(10);
        assert.equal(q.peek(), 2);
        assert.equal(nodes(r), 3);
    });

    // S6 (a throwing cleanup leaves FLAG_COMPUTING set) belongs to group A2.
    it.todo("S6: a throwing cleanup must not kill its effect (group A2)");
});

// ---------------------------------------------------------------------------
// Replay of the soak model lane that found F15 on the patched build.
// The lane body below is copied VERBATIM from audit/.../replay-lane.mjs (random
// ops + a naive reference model). Only the seed-dependent prelude is adapted.
// The SPEC-A assertion is "no TypeError" for seed 2776916833 (headpatched dies with
// "Cannot set properties of null (setting 'headSub')" via severTail).
// ---------------------------------------------------------------------------
let rs = 0; const rnd = () => (rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)], chance = (p) => rnd() < p;

function runLane(laneSeed, steps) {
  rs = laneSeed >>> 0;
  const r = createRegistry({ maxNodes: 4096, onCapacityExceeded: 'grow' });
  const S = [];            // signals: {h, v, live, disposable}
  const C = [];            // computeds: {h, ins:[{k,i}], op, thr, live}
  const E = [];            // effects: {stop, ins, last, live}
  const REG = [];          // lifecycle registrations: {sigIdx, off, dead}
  const stats = { ops: 0, sets: 0, batches: 0, reverts: 0, midReads: 0, effRuns: 0, created: 0, disposed: 0, lifecycleFires: 0 };
  let fail = null;
  const val = (k, i, memo) => {                              // MODEL evaluation (pure, from scratch)
    if (k === 's') return S[i].live ? S[i].v : undefined;
    const key = 'c' + i; if (memo.has(key)) return memo.get(key);
    const c = C[i]; let out;
    try { const xs = c.ins.map(d => { const x = val(d.k, d.i, memo); if (x instanceof Error) throw x; return x; });
          const v = c.op === 0 ? xs.reduce((a, b) => a + b, 0) : c.op === 1 ? (xs[0] > 50 ? xs[1] ?? 0 : xs[0]) : xs.reduce((a, b) => a * 31 + b | 0, 7);
          out = (c.thr && ((v % 5 + 5) % 5) === 3) ? new Error('thr') : v; }
    catch (e) { out = e; }
    memo.set(key, out); return out;
  };
  const engRead = (d) => d.k === 's' ? S[d.i].h() : C[d.i].h();
  const newSignal = (disposable) => { S.push({ h: r.signal(Math.floor(rnd() * 100)), v: 0, live: true, disposable }); const s = S.at(-1); s.v = s.h.peek(); stats.created++; };
  const newComputed = () => {
    const ins = []; const n = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) { const live = C.map((c, i) => c.live ? i : -1).filter(i => i >= 0);
      if (live.length && chance(0.4)) ins.push({ k: 'c', i: pick(live) }); else ins.push({ k: 's', i: pick(S.map((s, i) => (s.live && !s.disposable) ? i : -1).filter(i => i >= 0)) }); }
    const c = { ins, op: Math.floor(rnd() * 3), thr: chance(0.25), live: true };
    c.h = r.computed(() => { const xs = c.ins.map(engRead);   // engine body: same function, reading through the engine
      const v = c.op === 0 ? xs.reduce((a, b) => a + b, 0) : c.op === 1 ? (xs[0] > 50 ? xs[1] ?? 0 : xs[0]) : xs.reduce((a, b) => a * 31 + b | 0, 7);
      if (c.thr && ((v % 5 + 5) % 5) === 3) throw new Error('thr'); return v; });
    C.push(c); stats.created++;
  };
  const newEffect = () => {
    const ins = []; const n = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) { const lc = C.map((c, i) => c.live ? i : -1).filter(i => i >= 0);
      if (lc.length && chance(0.6)) ins.push({ k: 'c', i: pick(lc) }); else ins.push({ k: 's', i: pick(S.map((s, i) => s.live ? i : -1).filter(i => i >= 0)) }); }
    const e = { ins, last: null, live: true };
    e.stop = r.effect(() => { stats.effRuns++; e.last = e.ins.map(d => { try { return engRead(d); } catch { return 'ERR'; } }); });
    E.push(e); stats.created++;
  };
  const checkQuiescent = (where) => {
    const memo = new Map();
    for (let i = 0; i < C.length; i++) { const c = C[i]; if (!c.live) continue;
      const m = val('c', i, memo); let g; try { g = c.h(); } catch (e) { g = e; }
      const ok = (m instanceof Error) ? (g instanceof Error) : (g === m);
      if (!ok) return `computed#${i} engine=${g instanceof Error ? 'ERR' : g} model=${m instanceof Error ? 'ERR' : m} after ${where}`; }
    for (let i = 0; i < E.length; i++) { const e = E[i]; if (!e.live) continue;
      for (let j = 0; j < e.ins.length; j++) { const d = e.ins[j]; if (d.k === 's' && !S[d.i].live) continue;
        const m = val(d.k, d.i, memo); const want = m instanceof Error ? 'ERR' : m;
        if (e.last[j] !== want) return `effect#${i} last saw ${e.last[j]} for ${d.k}${d.i}, model=${want} after ${where}`; } }
    return null;
  };
  const guarded = (where, fn) => { try { fn(); } catch (e) { fail = `exception escaped ${where}: ${e && e.message}`; if (process.env.STACK) console.log(e.stack); } };
  for (let i = 0; i < 6; i++) newSignal(false);
  for (let i = 0; i < 3; i++) newSignal(true);
  for (let i = 0; i < 6; i++) newComputed();
  for (let i = 0; i < 5; i++) newEffect();
  for (let step = 0; step < steps && !fail; step++) {
    stats.ops++; const x = rnd(); let where;
    if (x < 0.35) { const s = pick(S.filter(s => s.live)); const v = Math.floor(rnd() * 100); where = 'set';
      guarded(where, () => { s.v = v; s.h.set(v); }); stats.sets++; }
    else if (x < 0.60) { where = 'batch'; stats.batches++;
      guarded(where, () => r.batch(() => {
        const k = 1 + Math.floor(rnd() * 4);
        for (let j = 0; j < k; j++) {
          const s = pick(S.filter(s => s.live)); const pre = s.v; const v = Math.floor(rnd() * 100); s.v = v; s.h.set(v);
          if (chance(0.5)) { const lc = C.filter(c => c.live); if (lc.length) { stats.midReads++; try { pick(lc).h(); } catch {} } }   // a mid-batch read
          if (chance(0.3)) { s.v = pre; s.h.set(pre); stats.reverts++; }                                                          // ... and a revert
        }
        if (chance(0.15)) newEffect();                                                                                             // effect created mid-batch
      })); }
    else if (x < 0.70) { where = 'read'; const lc = C.filter(c => c.live); if (lc.length) { try { pick(lc).h(); } catch {} } }
    else if (x < 0.78) { where = 'create'; guarded(where, () => { const t = rnd(); if (t < 0.4) newEffect(); else if (t < 0.8) newComputed(); else newSignal(chance(0.5)); }); }
    else if (x < 0.86) { where = 'dispose-effect'; const le = E.filter(e => e.live); if (le.length > 2) { const e = pick(le); guarded(where, () => e.stop()); e.live = false; stats.disposed++; } }
    else if (x < 0.92) { where = 'lifecycle-register'; const ds = S.map((s, i) => (s.live && s.disposable) ? i : -1).filter(i => i >= 0);
      const target = pick(S.map((s, i) => s.live ? i : -1).filter(i => i >= 0));
      const reg = { sigIdx: target, dead: false };
      const cb = () => { if (fail) return; stats.lifecycleFires++;
        if (reg.dead) { fail = `lifecycle callback fired for a DISPOSED registration (signal#${reg.sigIdx})`; return; }
        if (ds.length && chance(0.5)) { const j = pick(ds); if (S[j].live && j !== reg.sigIdx) { r.dispose(S[j].h); S[j].live = false; for (const q of REG) if (q.sigIdx === j) q.dead = true; } } };
      guarded(where, () => { reg.off = r.observeObservers(S[target].h, { onConnect: cb, onDisconnect: cb }); }); REG.push(reg); }
    else { where = 'dispose-signal'; const ds = S.map((s, i) => (s.live && s.disposable) ? i : -1).filter(i => i >= 0);
      if (ds.length) { const j = pick(ds); guarded(where, () => r.dispose(S[j].h)); S[j].live = false; stats.disposed++; for (const q of REG) if (q.sigIdx === j) q.dead = true;
        guarded('refill', () => newSignal(true)); } }
    if (!fail) fail = checkQuiescent(where);
  }
  return { fail, stats };
}

// NOTE: on head / wt0 (and on any A1-only engine) this lane aborts at op 2 with F6
// ("Effects threw during flush", group A2), so it only reaches the F15 case once A2
// lands; on headpatched it reaches op 91 and dies with the TypeError.
describe("replay lane", () => {
    it("replay seed 2776916833: no TypeError escapes the lane", () => {
        const res = runLane(2776916833, 400);
        assert.ok(res.stats.ops > 0 && res.stats.sets > 0 && res.stats.created > 0, "the lane did real work");
        assert.doesNotMatch(String(res.fail), /TypeError|Cannot (set|read) properties|headSub/);
    });
});

// ---------------------------------------------------------------------------
// Randomized nested-dispose fuzz (R1): three nested-frame shapes x nested-call
// position x victim, with the expected link count computed from a closed-form model.
// PRNG: 32-bit-exact LCG (Math.imul), two independent streams.
// ---------------------------------------------------------------------------
function lcg(seed) {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

describe("R1 randomized nested-dispose fuzz", () => {
    it("R1: 600 random configurations keep the dep list consistent", () => {
        const keyRng = lcg(0xC0FFEE), opRng = lcg(0x5EED5);
        const tally = { shape: [0, 0, 0], victimBeforeCall: 0, victimAfterCall: 0 };
        const N = 600;
        for (let it = 0; it < N; it++) {
            const r = mk();
            const n = 3 + Math.floor(keyRng() * 4);          // 3..6 signals read by the outer effect
            const p = Math.floor(keyRng() * (n + 1));        // nested call happens after p of them
            const v = Math.floor(keyRng() * n);              // victim index
            const shape = Math.floor(keyRng() * 3);          // 0 computed pull, 1 child effect, 2 untrack+computed
            tally.shape[shape]++;
            if (v < p) tally.victimBeforeCall++; else tally.victimAfterCall++;

            const t = r.signal(0);
            const sig = [];
            for (let i = 0; i < n; i++) sig.push(r.signal(0));
            let go = false, runs = 0;
            const seen = new Array(n).fill(-1);
            const inner = r.computed(() => { t(); if (go) r.dispose(sig[v]); return 1; });
            const nested = () => {
                if (shape === 0) inner();
                else if (shape === 1) { if (go) r.effect(() => { r.dispose(sig[v]); }); }
                else r.untrack(() => inner());
            };
            const stop = r.effect(() => {
                runs++;
                t();
                for (let i = 0; i < n; i++) { if (i === p) nested(); seen[i] = sig[i](); }
                if (p === n) nested();
            });
            // Initial links (model): shape0: t, inner, n sigs + inner->t ; shape1: t + n ; shape2: t + n + inner->t.
            assert.equal(links(r), shape === 0 ? n + 3 : shape === 1 ? n + 1 : n + 2, `initial links it=${it}`);
            go = true;
            t.set(1);
            go = false;
            // Final links (model): the victim's edge is gone whether it was linked before
            // the nested call or never linked after it.
            // shape0: t, inner, (n-1) + inner->t = n+2; shape1: t + (n-1) = n; shape2: t + (n-1) + inner->t = n+1.
            assert.equal(links(r), shape === 0 ? n + 2 : shape === 1 ? n : n + 1, `final links it=${it} shape=${shape} n=${n} p=${p} v=${v}`);
            assert.equal(runs, 2);

            // A random surviving signal still drives the effect.
            const surv = [];
            for (let i = 0; i < n; i++) if (i !== v) surv.push(i);
            const k = surv[Math.floor(opRng() * surv.length)];
            const val = 1 + Math.floor(opRng() * 1000);
            sig[k].set(val);
            assert.equal(runs, 3, `survivor re-runs it=${it}`);
            assert.equal(seen[k], val);
            t.set(2);
            assert.equal(runs, 4);

            // Full teardown returns the registry to empty.
            stop();
            r.dispose(inner);
            r.dispose(t);
            for (let i = 0; i < n; i++) r.dispose(sig[i]);
            assert.equal(links(r), 0, `teardown links it=${it}`);
            assert.equal(nodes(r), 0, `teardown nodes it=${it}`);
        }
        // Coverage floors (asserted so a generator change cannot silently thin the fuzz).
        for (let s = 0; s < 3; s++) assert.ok(tally.shape[s] >= 150, `shape ${s} covered ${tally.shape[s]}`);
        assert.ok(tally.victimBeforeCall >= 150, `victim read before nested call: ${tally.victimBeforeCall}`);
        assert.ok(tally.victimAfterCall >= 150, `victim read after nested call: ${tally.victimAfterCall}`);
    });
});

// ---------------------------------------------------------------------------
// Retention: 1e4 cycles of the P10 and F8 shapes return to baseline
// ---------------------------------------------------------------------------
describe("retention", () => {
    it("1e4 cycles of the P10 + F8 shapes bring activeNodes / activeLinks back to baseline", () => {
        const r = mk();
        const base = r.stats();
        const baseNodes = base.activeNodes, baseLinks = base.activeLinks;
        assert.equal(baseNodes, 0);
        assert.equal(baseLinks, 0);
        let popNodes = -1, popLinks = -1;
        for (let i = 0; i < 10000; i++) {
            // P10 shape
            const t = r.signal(0), a = r.signal(0), b = r.signal(0);
            let mode = 0;
            const stop = r.effect(() => { t(); if (mode === 1) r.effect(() => { r.dispose(a); }); a(); b(); });
            mode = 1;
            t.set(1);
            mode = 0;
            stop();
            r.dispose(t); r.dispose(a); r.dispose(b);
            // F8 shape
            const fa = r.signal(0), fb = r.signal(0);
            const un = r.observeObservers(fa, { onDisconnect: () => r.dispose(fb) });
            const fstop = r.effect(() => { fa(); fb(); });
            fstop();
            r.dispose(fa); un();
            if (i === 0) { const s = r.stats(); popNodes = s.nodePoolPopulation; popLinks = s.linkPoolPopulation; }
        }
        const s = r.stats();
        assert.equal(s.activeNodes, baseNodes);
        assert.equal(s.activeLinks, baseLinks);
        assert.equal(s.signals, 0);
        assert.equal(s.effects, 0);
        assert.equal(s.nodePoolPopulation, popNodes, "node pool did not grow after the first cycle");
        assert.equal(s.linkPoolPopulation, popLinks, "link pool did not grow after the first cycle");
    });
});

// ---------------------------------------------------------------------------
// A1 probe-gated suspects promoted to regression tests: S3b, P13, S9 (+S9b),
// S10 a/b/c, C10 a/b. Shapes follow audit/.../probe-suspects.mjs; every expectation
// is derived from the documented semantics in the comment above it. Each test runs
// in a worker thread (the S1 guard pattern): a corrupted list on a pre-fix kernel
// can loop forever, and that must surface as a failure, not freeze the run. The
// scenario function is serialised with toString(), so it must be self-contained.
// ---------------------------------------------------------------------------
async function isolated(scenario) {
    const code = `
        const { parentPort, workerData } = require("node:worker_threads");
        import(workerData.url).then(({ createRegistry }) => {
            const tryMsg = (fn) => { try { fn(); return null; } catch (e) { return e.constructor.name + ": " + e.message; } };
            parentPort.postMessage((${scenario.toString()})(createRegistry, tryMsg));
        }).catch((e) => parentPort.postMessage({ error: String(e && e.stack || e) }));
    `;
    const o = await new Promise((resolve) => {
        const w = new Worker(code, { eval: true, workerData: { url: new URL("../Signal.js", import.meta.url).href } });
        const timer = setTimeout(() => { w.terminate(); resolve({ error: "hang: no result within 5 s" }); }, 5000);
        w.once("message", (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
        w.once("error", (e) => { clearTimeout(timer); resolve({ error: String(e) }); });
    });
    assert.equal(o.error, undefined, o.error);
    return o;
}

describe("A1 probe-gated suspects (S3b, P13, S9, S10, C10)", () => {
    it("S3b: a dep computed disposed from its own dep's pre-walk must not hide a later changed dep", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const k = r.signal(0), x = r.signal(0);
            let seen = -1, runs = 0, C = null;
            const D = r.computed(() => { if (k() === 1) r.dispose(C); return 0; });
            C = r.computed(() => D());
            r.effect(() => { runs++; C(); seen = x(); });
            const e1 = tryMsg(() => r.batch(() => { k.set(1); x.set(5); }));
            const s = r.stats();
            const seen1 = seen, runs1 = runs;
            x.set(6);
            return { e1, seen1, runs1, seen2: seen, runs2: runs, computeds: s.computeds, links: s.activeLinks };
        });
        // Derivation: the batch changes x, so the effect MUST re-run once and see 5. D's value
        // is unchanged (0), so no version moves on the C path; a pre-walk that follows the
        // freed C link stops before x and leaves seen at 0 (fail-open miss).
        assert.equal(o.e1, null);
        assert.equal(o.seen1, 5);
        assert.equal(o.runs1, 2);
        // C is disposed: only D is left; links = D->k and effect->x (C reads record no edge).
        assert.equal(o.computeds, 1);
        assert.equal(o.links, 2);
        // The effect is still live on x afterwards: 1 + 1 + 1 runs.
        assert.equal(o.seen2, 6);
        assert.equal(o.runs2, 3);
    });

    it("P13: a dep computed disposes E in E's pre-walk, then creates Z in E's recycled slot", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const t = r.signal(0), w = r.signal(5);
            let mode = 0, Z = null, stopE = null;
            const K = r.computed(() => { t(); if (mode === 1 && Z === null) { stopE(); Z = r.computed(() => w() + 37); } return 1; });
            stopE = r.effect(() => { K(); });
            mode = 1;
            const e1 = tryMsg(() => t.set(1));
            const z1 = Z !== null ? Z() : null;
            let zSources = 0;
            if (Z !== null) r.forEachSource(Z, () => { zSources++; });
            w.set(6);
            const z2 = Z !== null ? Z() : null;
            return { e1, z1, z2, zSources, effects: r.stats().effects, computeds: r.stats().computeds };
        });
        // Derivation: Z = w + 37 is a normal computed. w = 5 -> 42; after w.set(6) -> 43.
        // The dying effect's pre-walk epilogue must not stamp or relink Z (a stamp would make
        // Z look clean forever, so z2 would stay 42). Z has exactly one source (w).
        assert.equal(o.e1, null);
        assert.equal(o.z1, 42);
        assert.equal(o.z2, 43);
        assert.equal(o.zSources, 1);
        // E was disposed (0 effects); K and Z are live computeds.
        assert.equal(o.effects, 0);
        assert.equal(o.computeds, 2);
    });

    // S9 contract (settled by the orchestrator, consistent with the I1 self-write pin in
    // test/17-reactivity): a node is NOT re-queued by a write made from its own epilogue's
    // onDisconnect. But the write must not be absorbed: the next trigger sees it.
    it("S9: effect epilogue onDisconnect writes a live dep -> no extra run now, seen on the next trigger", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const a = r.signal(0), b = r.signal(0), x = r.signal(0), k = r.signal(0);
            const K = r.computed(() => { k(); return 0; });
            let mode = 0, seen = -1, runs = 0;
            r.observeObservers(b, { onDisconnect: () => x.set(9) });
            r.effect(() => { runs++; K(); a(); seen = x(); if (mode === 0) b(); });
            mode = 1;
            const e1 = tryMsg(() => a.set(1));
            const seenAfterFlush = seen, runsAfterFlush = runs;
            const e2 = tryMsg(() => k.set(1));
            return { e1, e2, seenAfterFlush, runsAfterFlush, seenAfterK: seen, runsAfterK: runs, x: x.peek() };
        });
        assert.equal(o.e1, null);
        assert.equal(o.e2, null);
        // Derivation: a.set(1) re-runs the effect (runs 2); it reads x = 0 and drops b. The
        // severTail of b fires onDisconnect -> x.set(9) from the node's own epilogue. By the
        // contract it is NOT re-queued: still runs = 2, seen = 0 (the body ran before the write).
        assert.equal(o.seenAfterFlush, 0);
        assert.equal(o.runsAfterFlush, 2);
        // k.set(1) makes K stale; K recomputes to the same 0 (unchanged), but the pre-walk still
        // finds x changed after the effect's last evaluation (the write was not absorbed), so the
        // effect re-runs exactly once (runs 3) and sees 9.
        assert.equal(o.x, 9);
        assert.equal(o.seenAfterK, 9);
        assert.equal(o.runsAfterK, 3);
    });

    it("S9b: computed epilogue onDisconnect writes a live dep -> the next read recomputes with it", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const a = r.signal(0), b = r.signal(0), x = r.signal(0), z = r.signal(0);
            let mode = 0, evals = 0;
            r.observeObservers(b, { onDisconnect: () => x.set(9) });
            const c = r.computed(() => { evals++; a(); const v = x(); if (mode === 0) b(); return v; });
            c();
            mode = 1;
            a.set(1);
            const e1 = tryMsg(() => c());          // recompute: reads x = 0, drops b, onDisconnect writes x = 9
            const evalsAfterFirst = evals;
            const first = c();                      // x moved after that evaluation was stamped
            const evalsAfterSecond = evals;
            z.set(1);                               // an unrelated write moves the global version
            return { e1, first, later: c(), x: x.peek(), evalsAfterFirst, evalsAfterSecond, evalsEnd: evals };
        });
        // Derivation: the recompute that dropped b ran its body with x = 0 (its own write is not
        // a re-queue). The write x = 9 must not be absorbed: the very next read recomputes (a
        // 3rd evaluation) and returns 9; it then stays cached through an unrelated write.
        assert.equal(o.e1, null);
        assert.equal(o.evalsAfterFirst, 2);
        assert.equal(o.first, 9);
        assert.equal(o.evalsAfterSecond, 3);
        assert.equal(o.later, 9);
        assert.equal(o.evalsEnd, 3);
        assert.equal(o.x, 9);
    });

    // S10: the saved owner X is an IDLE effect (entered with runWithOwner) disposed inside the
    // window, and its node slot is recycled by later signals. The restored owner context must
    // not adopt later nodes into the recycled resident (a signal).
    const s10 = (inner) => async () => {
        const o = await isolated(new Function("createRegistry", "tryMsg", `
            const inner = ${inner};
            const r = createRegistry();
            const X = r.effect(() => {});
            let c = null;
            r.runWithOwner(X, () => {
                inner(r, X);
                for (let i = 0; i < 4; i++) r.signal(i);   // recycle the freed slots (X's among them)
                c = r.computed(() => 0);
            });
            const owner = r.ownerOf(c);
            return { e1: null, ownerKind: owner === undefined ? null : owner.kind, effects: r.stats().effects };
        `));
        // Derivation: X is disposed inside the window, so no owner remains. A computed created
        // after that has no owner (ownerOf -> undefined); an owner of kind "signal" means the
        // restored context points at a recycled slot. Y/Z/X are all disposed: 0 live effects.
        assert.equal(o.ownerKind, null);
        assert.equal(o.effects, 0);
    };
    it("S10a: runCleanup restores a recycled owner", s10(
        "(r, X) => { const Y = r.effect(() => { r.onCleanup(() => X()); }); Y(); }"));
    it("S10b: runWithOwner restores a recycled owner", s10(
        "(r, X) => { const Z = r.effect(() => {}); r.runWithOwner(Z, () => { X(); }); }"));
    it("S10c: createRoot restores a recycled owner", s10(
        "(r, X) => { r.createRoot(() => { X(); }); }"));

    // C10: an op-4 (edge removed) hook disposes link.source. The hook fires while the link is
    // still in the source's sub list, so the source's own disposal must not free it a second time.
    it("C10a: op-4 hook disposes link.source during a dispose walk (no double free)", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const a = r.signal(0), b = r.signal(0);
            const stop = r.effect(() => { a(); b(); });
            const ida = r.nodeId(a);
            let armed = true;
            r.onGraphMutation((op, src) => { if (armed && op === 4 && src === ida) { armed = false; r.dispose(a); } });
            const e1 = tryMsg(() => stop());
            const linksAfter = r.stats().activeLinks;
            const s1 = r.signal(1), s2 = r.signal(2);
            let runs = 0;
            r.effect(() => { runs++; s1(); s2(); });
            const e2 = tryMsg(() => s2.set(3));
            const st = r.stats();
            return { e1, e2, linksAfter, s1: s1.peek(), s2: s2.peek(), links: st.activeLinks, nodes: st.activeNodes, runs };
        });
        // Derivation: stop() removes both edges (a, b) and the hook disposes a on the way: 0 links
        // (a negative count means a link was freed twice). Then two fresh signals and a new effect
        // reading both: 2 links; live nodes b, s1, s2, effect = 4 (a and the first effect are gone).
        // The new effect ran once, and s2.set(3) re-runs it: runs = 2.
        assert.equal(o.e1, null);
        assert.equal(o.e2, null);
        assert.equal(o.linksAfter, 0);
        assert.equal(o.links, 2);
        assert.equal(o.nodes, 4);
        assert.equal(o.s1, 1);
        assert.equal(o.s2, 3);
        assert.equal(o.runs, 2);
    });

    it("C10b: op-4 hook disposes link.source during a severTail walk (no double free)", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const g = r.signal(true), a = r.signal(0), b = r.signal(0);
            r.effect(() => { if (g()) { a(); b(); } });
            const ida = r.nodeId(a);
            let armed = true;
            r.onGraphMutation((op, src) => { if (armed && op === 4 && src === ida) { armed = false; r.dispose(a); } });
            const e1 = tryMsg(() => g.set(false));
            const linksAfter = r.stats().activeLinks;
            const s1 = r.signal(1), s2 = r.signal(2);
            r.effect(() => { s1(); s2(); });
            const st = r.stats();
            return { e1, linksAfter, s1: s1.peek(), s2: s2.peek(), links: st.activeLinks, nodes: st.activeNodes };
        });
        // Derivation: g.set(false) re-runs the effect, which now reads only g: the stale tail
        // [a, b] is severed and the hook disposes a on the way. 1 link remains (effect->g).
        // A second effect reading s1 and s2 adds 2 links: 3. Live nodes: g, b, s1, s2 and two
        // effects = 6 (a is disposed).
        assert.equal(o.e1, null);
        assert.equal(o.linksAfter, 1);
        assert.equal(o.links, 3);
        assert.equal(o.nodes, 6);
        assert.equal(o.s1, 1);
        assert.equal(o.s2, 2);
    });
});

// ---------------------------------------------------------------------------
// A1 round-2 blockers (reviewer probes PA2, S11-LEAK, PIN-1, PIN-2). Written
// before the fix: todo until the A1 coder lands it (the coder removes the todos).
// ---------------------------------------------------------------------------
describe("A1-r2 reviewer blockers", () => {
    it("PA2: a slot recycled by an epilogue onDisconnect must not become an observed dep", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const g = r.signal(true), A = r.signal(1), S = r.signal(2);
            let X = null, runs = 0;
            r.observeObservers(A, { onDisconnect: () => { r.dispose(S); X = r.signal(99); } });
            r.effect(() => { runs++; if (g()) A(); S(); });
            const e1 = tryMsg(() => g.set(false));
            const observed = r.hasObservers(X);
            const links = r.stats().activeLinks;
            const runs1 = runs;
            const e2 = tryMsg(() => X.set(100));
            return { e1, observed, links, runs1, runs2: runs, e2 };
        });
        // Derivation: g.set(false) re-runs the effect once (runs 2); it reads g and S; the
        // epilogue severs the stale A edge, whose onDisconnect disposes S (its edge goes)
        // and allocates X into S's slot. X was never read by the effect, so it has no
        // observers; the only edge left is effect->g (1). X.set(100) must not re-run it.
        assert.equal(o.e1, null);
        assert.equal(o.observed, false);
        assert.equal(o.links, 1);
        assert.equal(o.runs1, 2);
        assert.equal(o.e2, null);
        assert.equal(o.runs2, 2);
    });

    it("S11-LEAK: a throwing epilogue onDisconnect must not wedge the registry", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry({ maxNodes: 64, maxLinks: 256, onCapacityExceeded: "throw" });
            const g = r.signal(true), b = r.signal(0);
            r.observeObservers(b, { onDisconnect: () => { throw new Error("boom"); } });
            r.effect(() => { if (g()) b(); });
            tryMsg(() => g.set(false));          // may or may not surface the throw; not asserted
            const base = r.stats().activeNodes;
            let err = null, i = 0;
            try {
                for (; i < 20000; i++) {
                    const s2 = r.signal(0); let st;
                    st = r.effect(() => { s2(); if (st) st(); });
                    s2.set(1); r.dispose(s2);
                }
            } catch (e) { err = e.constructor.name + ": " + e.message + " at " + i; }
            return { err, base, after: r.stats().activeNodes };
        });
        // Derivation: every loop iteration creates a signal + an effect and disposes both,
        // so the live-node count after the loop equals the count before it, and a pool of
        // 64 nodes is never exhausted unless disposal leaks slots.
        assert.equal(o.err, null);
        assert.equal(o.after, o.base);
    });

    // Regression pin: green on a1cand; guards the pin/release logic against a leaking fix.
    it("PIN-1: self-disposing effects (top level and inside a flush) do not leak pinned slots", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry({ maxNodes: 64, maxLinks: 256, onCapacityExceeded: "throw" });
            const once = (inBatch) => {
                const s2 = r.signal(0); let st;
                st = r.effect(() => { s2(); if (st) st(); });   // disposes itself on its 2nd run
                if (inBatch) r.batch(() => { s2.set(1); }); else s2.set(1);
                r.dispose(s2);
            };
            let err = null, i = 0, popWarm = -1, nodesWarm = -1;
            try {
                for (; i < 10000; i++) {
                    once(false); once(true);
                    if (i === 200) { popWarm = r.stats().nodePoolPopulation; nodesWarm = r.stats().activeNodes; }
                }
            } catch (e) { err = e.constructor.name + ": " + e.message + " at " + i; }
            const s = r.stats();
            return { err, popWarm, popEnd: s.nodePoolPopulation, nodesWarm, nodesEnd: s.activeNodes };
        });
        // Derivation: each iteration nets zero live nodes (signal and effect both disposed),
        // so a 64-slot pool never exhausts and the pool population is flat after warm-up.
        assert.equal(o.err, null);
        assert.equal(o.popEnd, o.popWarm);
        assert.equal(o.nodesEnd, o.nodesWarm);
        assert.equal(o.nodesEnd, 0);
    });

    // Regression pin: green on a1cand (red on head, wt0 and the no_pin mutant).
    it("PIN-2: a dead (disposed-while-running) owner adopts nothing; its recycled slot's re-run keeps the stranger", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const t = r.signal(0), a = r.signal(0), x = r.signal(0), k = r.signal(0);
            let mode = 0, stopOuter = null, e3runs = 0;
            stopOuter = r.effect(() => {
                t();
                if (mode === 1) {
                    r.effect(() => { stopOuter(); });
                    r.effect(() => { x(); e3runs++; });   // created under the (now dead) outer
                }
                a();
            });
            mode = 1; t.set(1);
            const e3created = e3runs;
            for (let i = 0; i < 64; i++) r.effect(() => { k(); });   // recycle the outer's slot
            k.set(1);                                                // re-run the new residents
            x.set(1);
            return { e3created, e3end: e3runs };
        });
        // Derivation: the child effect reading x runs once at creation (1). The dead owner
        // adopts nothing, so the child is unowned; recycling the slot and re-running the
        // new resident cannot dispose it. x.set(1) then re-runs it exactly once: 2.
        assert.equal(o.e3created, 1);
        assert.equal(o.e3end, 2);
    });
});

// ---------------------------------------------------------------------------
// A1 round-3 blockers (reviewer probe-r2: R2-ABA, R2-CAP, R2-CAP-owned-rerun).
// R2-ABA is red on the round-2 builds (r2-4 and r2-7: TypeError, the effect ran a
// stranger's body); both CAP cases are red on r2-7 (forward-pointer link pinning).
// ---------------------------------------------------------------------------
describe("A1-r3 reviewer blockers", () => {
    it("R2-ABA: a cleanup that disposes its own effect, then recycles the slot at depth 0, never runs the stranger", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const s = r.signal(0);
            let stop = null, X = null, runs = 0;
            stop = r.effect(() => {
                runs++; s();
                r.onCleanup(() => {
                    stop();
                    const st = r.stats();
                    let free = st.nodePoolPopulation - st.activeNodes - 1;   // -1: the pinned slot
                    while (free-- > 0) r.signal(-1);
                    X = r.signal(5);                                        // free-list miss at depth 0
                });
            });
            const e1 = tryMsg(() => s.set(1));
            return { e1, runs, xVal: X === null ? null : X(), xKind: X === null ? null : r.describe(X).kind };
        });
        // Derivation: the effect runs once at creation (1). s.set(1) re-runs it: its cleanup
        // disposes it, so the re-run must stop before the body (runs stays 1) even though X
        // now lives in its recycled slot; X is an ordinary signal holding 5.
        assert.equal(o.e1, null);
        assert.equal(o.runs, 1);
        assert.equal(o.xVal, 5);
        assert.equal(o.xKind, "signal");
    });

    it("R2-ABA (computed): a cleanup that disposes its own computed, then recycles the slot at depth 0, never runs the stranger", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const s = r.signal(0);
            let C = null, X = null, runs = 0;
            C = r.computed(() => {
                runs++; s();
                r.onCleanup(() => {
                    r.dispose(C);
                    const st = r.stats();
                    let free = st.nodePoolPopulation - st.activeNodes - 1;   // -1: the pinned slot
                    while (free-- > 0) r.signal(-1);
                    X = r.signal(5);
                });
                return 1;
            });
            C();
            s.set(1);
            let v;
            const e1 = tryMsg(() => { v = C(); });
            return { e1, v, runs, xVal: X === null ? null : X(), xKind: X === null ? null : r.describe(X).kind };
        });
        // Derivation: C evaluates once (1). After s.set(1) the read recomputes it: its cleanup
        // disposes it, so the recompute must stop before the body (runs stays 1) and the read
        // yields undefined; X, now in C's recycled slot, is an ordinary signal holding 5.
        assert.equal(o.e1, null);
        assert.equal(o.v, undefined);
        assert.equal(o.runs, 1);
        assert.equal(o.xVal, 5);
        assert.equal(o.xKind, "signal");
    });

    it("A16: onDisconnect that disposes the RUNNING observer mid-body leaves the rest of the body untracked", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const g = r.signal(0), b = r.signal(0), x = r.signal(0);
            let mode = 0, trackingAfter = null, stop = null;
            r.observeObservers(b, { onDisconnect: () => { if (stop !== null) stop(); } });
            stop = r.effect(() => { g(); if (mode === 0) b(); else { x(); trackingAfter = r.isTracking(); } });
            mode = 1;
            const e1 = tryMsg(() => g.set(1));
            return { e1, trackingAfter, effects: r.stats().effects };
        });
        // Derivation: on the re-run, reading x first severs the stale b edge (allocateLink's
        // mismatch path); b's onDisconnect disposes the running effect. The callback window
        // must not re-seat the dead observer, so isTracking() is false for the rest of the
        // body, and no effect is left alive.
        assert.equal(o.e1, null);
        assert.equal(o.trackingAfter, false);
        assert.equal(o.effects, 0);
    });

    it("R2-CAP: 5000 temporaries created, read and disposed in ONE effect run fit the default pool", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            let done = 0;
            const e1 = tryMsg(() => r.effect(() => {
                for (let i = 0; i < 5000; i++) { const t = r.signal(i); t(); r.dispose(t); done++; }
            }));
            return { e1, done, activeLinks: r.stats().activeLinks };
        });
        // Derivation: each temporary's single edge is freed before the next one is created,
        // so at most one link is live at a time; the pool never needs more than that.
        assert.equal(o.e1, null);
        assert.equal(o.done, 5000);
        assert.equal(o.activeLinks, 0);
    });

    it("R2-CAP-owned-rerun: an effect owning 1000 computeds re-runs under maxLinks 1500 (throw)", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry({ maxNodes: 4096, maxLinks: 1500, onCapacityExceeded: "throw" });
            const s = r.signal(0);
            let sum = 0;
            const e0 = tryMsg(() => r.effect(() => { s(); for (let i = 0; i < 1000; i++) { const c = r.computed(() => i); sum += c(); } }));
            const e1 = tryMsg(() => s.set(1));
            return { e0, e1, links: r.stats().activeLinks };
        });
        // Derivation: a run holds 1 + 1000 edges (s and each owned computed). The re-run's
        // cleanup disposes the 1000 old children (freeing their edges) before re-creating
        // them, so live edges peak at 1001 < 1500 and end at 1001.
        assert.equal(o.e0, null);
        assert.equal(o.e1, null);
        assert.equal(o.links, 1001);
    });

    it("C11: an epilogue onDisconnect that disposes a later stale source and creates an effect leaves other lists intact", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const g = r.signal(true), a = r.signal(0), b = r.signal(0), c = r.signal(0);
            const p = r.signal(0), q = r.signal(0), y = r.signal(0), z = r.signal(0);
            const U = r.effect(() => { p(); q(); });
            const before = []; r.forEachSource(U, (d) => before.push(d.id));
            let F = null;
            r.observeObservers(a, { onDisconnect: () => { r.dispose(b); F = r.effect(() => { y(); z(); }); } });
            r.effect(() => { if (g()) { a(); b(); c(); } });
            const e1 = tryMsg(() => g.set(false));
            const after = []; r.forEachSource(U, (d) => after.push(d.id));
            let fSources = 0; if (F !== null) r.forEachSource(F, () => { fSources++; });
            return { e1, uSame: before.join() === after.join(), fSources, links: r.stats().activeLinks };
        });
        // Derivation: g.set(false) re-runs E, which now reads only g; its epilogue severs a, b, c.
        // Severing a fires onDisconnect: b is disposed (its link to E freed) and F is created
        // nested inside the epilogue (its frame pushes and pops a cursor), reading y and z.
        // The sever must resume on E's own list. Live links afterwards: U(p,q) + F(y,z) + E(g) = 5.
        assert.equal(o.e1, null);
        assert.equal(o.uSame, true);
        assert.equal(o.fSources, 2);
        assert.equal(o.links, 5);
    });

    // NOTE (R4-RET and R4-RET-EQ): these enable gc via v8.setFlagsFromString inside this test
    // process. That is safe only because node:test runs each test file in its own process; never
    // run this file in-process alongside other tests (the flag would leak into them).
    it("R4-RET: a computed body that disposes its own node does not leave its value on the pooled slot", async () => {
        const v8 = await import("node:v8"), vm = await import("node:vm");
        v8.setFlagsFromString("--expose-gc");
        const gc = vm.runInNewContext("gc");
        const { createRegistry } = await import(new URL("../Signal.js", import.meta.url).href);
        const r = createRegistry();
        const s = r.signal(0);
        let C = null, ref = null;
        const run = () => {
            C = r.computed(() => {
                s();
                const payload = { big: new Array(4096).fill(1) };
                ref = new WeakRef(payload);
                r.dispose(C);
                return payload;
            });
            return C();
        };
        const got = run();
        await new Promise((res) => setTimeout(res, 0));
        gc(); gc();
        // Derivation: the read returns undefined (the node died in its own body), and nothing
        // reachable may hold the payload -- the engine's slot included.
        assert.equal(got, undefined);
        assert.equal(ref.deref(), undefined);
        r.destroy?.();
    });

    it("R4-RET-EQ: a custom equals that disposes the computed's own node does not park the NEW value", async () => {
        const v8 = await import("node:v8"), vm = await import("node:vm");
        v8.setFlagsFromString("--expose-gc");
        const gc = vm.runInNewContext("gc");
        const { createRegistry } = await import(new URL("../Signal.js", import.meta.url).href);
        const r = createRegistry();
        const s = r.signal(0);
        let C = null, ref = null;
        // equals runs only on the 2nd evaluation (the 1st has no prior value to compare with).
        C = r.computed(() => {
            if (s() === 0) return 0;
            const payload = { big: new Array(4096).fill(1) };
            ref = new WeakRef(payload);
            return payload;
        }, { equals: (a, b) => { if (b !== 0) r.dispose(C); return false; } });
        assert.equal(C(), 0);
        s.set(1);
        const got = C();
        await new Promise((res) => setTimeout(res, 0));
        gc(); gc();
        // Derivation: equals disposed the node and said "different"; only the post-equals gen
        // re-check stops the write. The read gives undefined and the new value is unreachable.
        assert.notEqual(ref, null);
        assert.equal(got, undefined);
        assert.equal(ref.deref(), undefined);
        r.destroy?.();
    });
});

// ---------------------------------------------------------------------------
// A1 QA boundaries (qa, 2026-10-11). Written from SPEC-A A1 (A1.1 stack, A1.2 repair,
// A1.8 pinning, DV-A1-3) by hand; every expected number is derived in the comment above
// it. Each scenario runs in a worker (isolated) because the pre-fix kernels and the
// mutants can loop forever on a corrupted list.
// ---------------------------------------------------------------------------
describe("A1 QA boundaries", () => {
    it("QA1: cursorStack growth -- saved-cursor repair at nesting depth 1, 2, 31, 32, 33, 64", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const out = [];
            for (const D of [1, 2, 31, 32, 33, 64]) {
                const r = createRegistry();
                const s = r.signal(0);
                const xs = [], ys = [];
                for (let k = 0; k < D; k++) { xs.push(r.signal(1)); ys.push(r.signal(1)); }
                let armed = false;
                const C = [];
                for (let k = 0; k < D; k++) {
                    const below = k === 0 ? null : C[k - 1], xk = xs[k], yk = ys[k];
                    C.push(r.computed(() => {
                        s();
                        let v = 0;
                        if (below === null) {
                            if (armed) { armed = false; for (let j = 0; j < xs.length; j++) r.dispose(xs[j]); }
                        } else v = below();
                        const xv = xk();
                        return v + (xv === undefined ? 0 : xv) + yk();
                    }));
                }
                let runs = 0, last;
                r.effect(() => { runs++; last = C[D - 1](); });
                const st0 = r.stats();
                const res = { D, last0: last, links0: st0.activeLinks, signals0: st0.signals };
                armed = true;
                res.e1 = tryMsg(() => s.set(1));
                const st1 = r.stats();
                res.runs1 = runs; res.last1 = last; res.links1 = st1.activeLinks; res.signals1 = st1.signals;
                let srcs = 0; r.forEachSource(C[D - 1], () => { srcs++; }); res.topSources = srcs;
                res.e2 = tryMsg(() => ys[0].set(5));
                res.runs2 = runs; res.last2 = last;
                res.e3 = tryMsg(() => ys[D - 1].set(10));
                res.runs3 = runs; res.last3 = last;
                res.e4 = tryMsg(() => s.set(2));
                res.runs4 = runs; res.last4 = last; res.links4 = r.stats().activeLinks;
                res.yObserved = ys.every((y) => r.hasObservers(y));
                out.push(res);
            }
            return out;
        });
        for (const res of o) {
            const D = res.D;
            const m = "D=" + D;
            // Chain: E -> C[D-1] -> ... -> C[0]. C[k] reads s, C[k-1] (k >= 1), x_k, y_k and
            // returns C[k-1] + x_k + y_k. Every x and y starts at 1, so C[D-1] = 2D.
            assert.equal(res.last0, 2 * D, m);
            // Links: E 1; C[k>=1] 4 each; C[0] 3 (s, x, y) -> 1 + 4(D-1) + 3 = 4D.
            assert.equal(res.links0, 4 * D, m);
            assert.equal(res.signals0, 1 + 2 * D, m);
            // s.set(1): E's pre-walk pulls C[D-1] at depth 0; each C[k] reads s, then tracks
            // C[k-1] (cursor moves to its x_k link) and recomputes it one frame deeper, so the
            // frame of C[k] (k >= 1) holds its x_k link as a SAVED cursor at stack index D-1-k
            // (indices 1..D-1; D = 33 / 64 write past the 32 preallocated slots). C[0] disposes
            // every x: x_0 is its live cursor, the rest are saved cursors -> all repaired to y_k.
            assert.equal(res.e1, null, m);
            // Each x now reads undefined (0): C[D-1] = D (one y per level). Changed -> E +1.
            assert.equal(res.runs1, 2, m);
            assert.equal(res.last1, D, m);
            // Links: E 1; C[k>=1] 3 (s, C[k-1], y); C[0] 2 (s, y) -> 1 + 3(D-1) + 2 = 3D.
            assert.equal(res.links1, 3 * D, m);
            assert.equal(res.signals1, 1 + D, m);
            assert.equal(res.topSources, D === 1 ? 2 : 3, m);
            // y_0 = 5 -> C[0] = 5 -> C[D-1] = D + 4; E +1.
            assert.equal(res.e2, null, m);
            assert.equal(res.runs2, 3, m);
            assert.equal(res.last2, D + 4, m);
            // y_{D-1} = 10 -> C[D-1] gains 9 -> D + 13; E +1 (for D = 1 that is the same y:
            // 10 replaces 5, so 1 + 4 - 5 + 10 = 10 = D + 9).
            assert.equal(res.e3, null, m);
            assert.equal(res.runs3, 4, m);
            assert.equal(res.last3, D === 1 ? 10 : D + 13, m);
            // s.set(2), unarmed: every level recomputes to the same value; E does not re-run.
            assert.equal(res.e4, null, m);
            assert.equal(res.runs4, 4, m);
            assert.equal(res.links4, 3 * D, m);
            assert.equal(res.yObserved, true, m);
        }
    });

    it("QA2: policy 'throw' at exactly maxNodes with a pinned node -- withheld in-frame, released at a depth-0 miss", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry({ maxNodes: 8, onCapacityExceeded: "throw" });
            const sig = [];
            for (let i = 0; i < 6; i++) sig.push(r.signal(i));
            let C = null, inFrame = "unset";
            C = r.computed(() => { sig[0](); r.dispose(C); inFrame = tryMsg(() => r.signal(77)); return 1; });
            const K = r.signal(100);                        // 8th node: pool exactly full
            const eFull = tryMsg(() => r.signal(99));
            const v = C();
            const st1 = r.stats();
            let n1 = null; const eMiss = tryMsg(() => { n1 = r.signal(42); });
            const eOver = tryMsg(() => r.signal(43));
            const st2 = r.stats();
            return { eFull, inFrame, v, nodes1: st1.activeNodes, computeds1: st1.computeds, eMiss,
                n1v: n1 === null ? null : n1(), eOver, nodes2: st2.activeNodes,
                vals: sig.map((s) => s()).join(","), k: K() };
        });
        // 6 signals + C + K = 8 = maxNodes: a 9th create throws.
        assert.match(String(o.eFull), /^CapacityError/);
        // C() runs C's body at depth 1: C disposes itself (pinned, DV-A1-3: not reusable until
        // depth 0). Live 7, but the only free-able slot is pinned -> in-frame create throws.
        assert.match(String(o.inFrame), /^CapacityError/);
        // A body that disposed its own node reads undefined (R4-RET).
        assert.equal(o.v, undefined);
        assert.equal(o.nodes1, 7);
        assert.equal(o.computeds1, 0);
        // Depth 0, free list empty, pinned C -> the miss releases it: the create succeeds.
        assert.equal(o.eMiss, null);
        assert.equal(o.n1v, 42);
        // Now 8 live again: the next create throws, and nothing was clobbered.
        assert.match(String(o.eOver), /^CapacityError/);
        assert.equal(o.nodes2, 8);
        assert.equal(o.vals, "0,1,2,3,4,5");
        assert.equal(o.k, 100);
    });

    it("QA3: destroy() at depth 0 after an aborted (CycleError) flush leaves nothing pinned", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry({ maxNodes: 8, onCapacityExceeded: "throw", maxFlushPasses: 4 });
            const a = r.signal(0), b = r.signal(0);
            let armed = false, done = false;
            r.effect(() => { const v = a(); if (armed) b.set(v + 1); });
            r.effect(() => { const v = b(); if (armed) a.set(v + 1); });
            let E3 = null;
            E3 = r.effect(() => { if (a() > 0 && !done) { done = true; E3(); } });
            armed = true;
            const e1 = tryMsg(() => a.set(1));
            r.destroy();
            const sigs = [];
            let eFill = null;
            for (let i = 0; i < 8 && eFill === null; i++) eFill = tryMsg(() => { sigs.push(r.signal(1000 + i)); });
            const eOver = tryMsg(() => r.signal(9999));
            return { e1, done, eFill, count: sigs.length, eOver, nodes: r.stats().activeNodes,
                vals: sigs.map((s) => s()).join(",") };
        });
        // a.set(1): E1 writes b, E2 writes a, forever -> the flush exceeds 4 passes.
        assert.match(String(o.e1), /CycleError/);
        // E3 ran in pass 1 and disposed itself in its own body (pinned). The abort skipped the
        // post-loop release, so a slot is still pinned when destroy() runs at depth 0.
        assert.equal(o.done, true);
        // destroy() rebuilds the free list from the whole pool: exactly 8 creates succeed ...
        assert.equal(o.eFill, null);
        assert.equal(o.count, 8);
        // ... and the 9th throws. A stale pinned list would hand out a live slot here instead.
        assert.match(String(o.eOver), /^CapacityError/);
        assert.equal(o.nodes, 8);
        assert.equal(o.vals, "1000,1001,1002,1003,1004,1005,1006,1007");
    });

    it("QA4: double (and triple, and stale-recycled) dispose of a pinned node", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry({ maxNodes: 4, onCapacityExceeded: "throw" });
            const s = r.signal(1);
            let C = null;
            C = r.computed(() => { s(); r.dispose(C); r.dispose(C); return 5; });
            const e0 = tryMsg(() => C());
            const st1 = r.stats();
            const e1 = tryMsg(() => r.dispose(C));          // third dispose, depth 0, still pinned
            const ns = [];
            const eFill = tryMsg(() => { ns.push(r.signal(10)); ns.push(r.signal(20)); ns.push(r.signal(30)); });
            const eOver = tryMsg(() => r.signal(40));
            const e2 = tryMsg(() => r.dispose(C));          // stale handle; its slot now backs a live signal
            const st2 = r.stats();
            return { e0, e1, e2, eFill, eOver, nodes1: st1.activeNodes, computeds1: st1.computeds,
                nodes2: st2.activeNodes, signals2: st2.signals, vals: ns.map((n) => n()).join(","), s: s() };
        });
        assert.equal(o.e0, null);
        assert.equal(o.e1, null);
        // One disposal counted, not two: s alone is live.
        assert.equal(o.nodes1, 1);
        assert.equal(o.computeds1, 0);
        // Pool of 4: s + 2 free + pinned C. Three creates fit (the third releases C's slot
        // at the depth-0 miss); the 4th live node fills the pool, so a 5th throws.
        assert.equal(o.eFill, null);
        assert.match(String(o.eOver), /^CapacityError/);
        // The stale dispose must not reach the recycled slot.
        assert.equal(o.e2, null);
        assert.equal(o.nodes2, 4);
        assert.equal(o.signals2, 4);
        assert.equal(o.vals, "10,20,30");
        assert.equal(o.s, 1);
    });

    it("QA5: dispose inside untrack / runWithOwner / createRoot from a frame at depth 2", async () => {
        const o = await isolated((createRegistry, tryMsg) => {
            const r = createRegistry();
            const g = r.signal(0), p = r.signal(0), q = r.signal(0), w = r.signal(0);
            const m = r.signal(0), n = r.signal(0), k = r.signal(0), l = r.signal(0);
            let armed = false;
            const C1 = r.computed(() => {
                g();
                if (armed) {
                    armed = false;
                    r.untrack(() => r.dispose(k));
                    r.untrack(() => r.dispose(m));
                    const own = r.getOwner();
                    r.runWithOwner(own, () => r.dispose(p));
                    r.createRoot(() => { r.dispose(q); });   // createRoot(fn) calls fn() with no disposer
                }
                const kv = k();
                return (kv === undefined ? 0 : kv) + l();
            });
            const C2 = r.computed(() => { g(); const v = C1(); const mv = m(); return v + (mv === undefined ? 0 : mv) + n(); });
            let runs = 0, last;
            r.effect(() => {
                runs++;
                g();
                const v = C2(), pv = p(), qv = q();
                last = v + (pv === undefined ? 0 : pv) + (qv === undefined ? 0 : qv) + w();
            });
            const links0 = r.stats().activeLinks;
            armed = true;
            const e1 = tryMsg(() => g.set(1));
            const st1 = r.stats();
            const res = { links0, e1, runs1: runs, last1: last, links1: st1.activeLinks, signals1: st1.signals };
            res.e2 = tryMsg(() => n.set(5)); res.runs2 = runs; res.last2 = last;
            res.e3 = tryMsg(() => l.set(2)); res.runs3 = runs; res.last3 = last;
            res.e4 = tryMsg(() => w.set(1)); res.runs4 = runs; res.last4 = last;
            res.links4 = r.stats().activeLinks;
            return res;
        });
        // E reads g, C2, p, q, w (5); C2 reads g, C1, m, n (4); C1 reads g, k, l (3) = 12.
        assert.equal(o.links0, 12);
        // g.set(1): E's body is the depth-0 frame (g is its first dep, so no pre-walk pull).
        // E tracks C2 (cursor -> p link) and pulls it: C2's frame saves E's cursor. C2 tracks
        // C1 (cursor -> m link) and pulls it: C1's frame saves C2's cursor. In C1 (depth 2):
        //   untrack: k = C1's LIVE cursor; m = C2's SAVED cursor;
        //   runWithOwner: p = E's SAVED cursor; createRoot: q = E's repaired cursor.
        assert.equal(o.e1, null);
        assert.equal(o.runs1, 2);
        assert.equal(o.last1, 0);
        // Links: E g, C2, w = 3; C2 g, C1, n = 3; C1 g, l = 2 -> 8. Signals 8 - 4 = 4.
        assert.equal(o.links1, 8);
        assert.equal(o.signals1, 4);
        // n = 5: C2 = 5, E +1, last 5. l = 2: C1 = 2, C2 = 7, last 7. w = 1: last 8.
        assert.equal(o.e2, null); assert.equal(o.runs2, 3); assert.equal(o.last2, 5);
        assert.equal(o.e3, null); assert.equal(o.runs3, 4); assert.equal(o.last3, 7);
        assert.equal(o.e4, null); assert.equal(o.runs4, 5); assert.equal(o.last4, 8);
        assert.equal(o.links4, 8);
    });
});
