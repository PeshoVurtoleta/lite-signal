// 103-reset.test.mjs -- registry.reset() + destroy() in-flight guard: INDEPENDENT ORACLE (b159, batch B2).
// Oracle: .handoff/PLAN-C-RESET.md ASSERTIONS A1, A2, A3 + ADDENDUM 1 (D-1, D-4, D-6). Values that exist on the
// before-build (default capacities 1024/4096, ids 1..5, first op-1 id after the fixture, mutation event shapes) were
// probed on .handoff/b159-before/Signal.js; values that only exist after reset() (op-2 order, op-4 count, cleanup
// order, onDisconnect order) come from the ASSERTIONS and are marked "ASSERTION A1 (planner)" so a mismatch is
// adjudicated, not bent. Every row must FAIL on the before-build (no reset(); destroy() has no guard).
// B2 redo (b160): ASSERTIONS A2', A3', A6-A10, A5+, L1 per .handoff/PLAN-C-RESET.md ADDENDUM 3 (binding). Message texts MSG[1]/MSG[2]
// come verbatim from ADDENDUM 3; op-2 counts 301/451/12 and error orders are the planner's numbers (ASSERTION, adjudicate on mismatch).
// b161 r3: rows K1-K7 = REVIEW-B1-r2 B-1..B-4 (fixtures r2-probes/kill.mjs, killw.mjs; values probed on head 482a1d98).
// b161 r4: K8 = REVIEW-B1-r3 B-6 (test/103) / B-7 (test/104).
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as Sig from "../Signal.js";
import { createRegistry } from "../Signal.js";
import { createLeakTracker } from "@zakkster/lite-leak";

const HAVE_GC = typeof globalThis.gc === "function";
const nap = (ms) => new Promise((res) => setTimeout(res, ms));
const settle = async () => { globalThis.gc(); await nap(0); globalThis.gc(); };
const P = "[lite-signal] ";
const MSG1 = (live, m) => P + "reset: cleanups kept creating nodes (" + live + " still live after " + m + " counted rounds, maxFlushPasses)";
const MSG2 = (live, m) => P + "reset: no progress (" + live + " still live after " + m + " counted rounds, maxFlushPasses; every remaining disposal threw)";


// Exact A1 fixture without boxes (ids 1..5).
function fixtureExact() {
    const r = createRegistry();
    const ev = [], cleanups = [], disc = [];
    r.onGraphMutation((op, a, b) => { ev.push([op, a, b]); });
    const a = r.signal(1), b = r.signal(2);
    const c = r.computed(() => a() + b());
    const e1 = r.effect(() => {
        c();
        r.onCleanup(() => { cleanups.push("e1"); });
        r.effect(() => { a(); r.onCleanup(() => { cleanups.push("e2"); }); });
    });
    r.observeObservers(a, { onDisconnect() { disc.push("a"); } });
    r.observeObservers(c, { onDisconnect() { disc.push("c"); } });
    ev.length = 0;
    return { r, ev, cleanups, disc, a, b, c, e1 };
}

describe("A1 reset(): order, events, stats, stale handles", () => {
    test("reset() returns undefined and the registry exposes it", () => {
        const f = fixtureExact();
        assert.equal(typeof f.r.reset, "function");
        assert.equal(f.r.reset(), undefined);
    });
    test("cleanups run inside-out: ['e2','e1'] (ASSERTION A1 (planner))", () => {
        const f = fixtureExact();
        f.r.reset();
        assert.deepEqual(f.cleanups, ["e2", "e1"]);
    });
    test("op-2 ids in order [4,5,3,2,1] (ASSERTION A1 (planner))", () => {
        const f = fixtureExact();
        f.r.reset();
        assert.deepEqual(f.ev.filter((e) => e[0] === 2).map((e) => e[1]), [4, 5, 3, 2, 1]);
    });
    test("op-4 count is 4, one per dependency link (ASSERTION A1 (planner))", () => {
        const f = fixtureExact();
        f.r.reset();
        assert.equal(f.ev.filter((e) => e[0] === 4).length, 4);
    });
    test("only ops 2 and 4 fire during reset (ASSERTION A1 (planner))", () => {
        const f = fixtureExact();
        f.r.reset();
        assert.deepEqual([...new Set(f.ev.map((e) => e[0]))].sort(), [2, 4]);
    });
    test("onDisconnect order ['c','a'] (ASSERTION A1 (planner))", () => {
        const f = fixtureExact();
        f.r.reset();
        assert.deepEqual(f.disc, ["c", "a"]);
    });
    test("stats after reset: gauges 0, lifetime kept, totalDisposals += 5, capacities + populations unchanged (D-1)", () => {
        const f = fixtureExact();
        f.r.reset();
        assert.deepEqual(f.r.stats(), {
            signals: 0, computeds: 0, effects: 0, activeLinks: 0,
            pooledLinks: 4096, linkPoolCapacity: 4096, nodePoolCapacity: 1024,
            nodePoolPopulation: 1024, linkPoolPopulation: 4096,
            activeNodes: 0, totalAllocations: 5, totalDisposals: 5, poolGrowths: 0,
        });
    });
    test("stale handles of all four kinds read undefined; peek undefined; set is a no-op", () => {
        const r = createRegistry();
        const s = r.signal(1), c = r.computed(() => s() + 1);
        const sb = r.signalBox(3), cb = r.computedBox(() => sb.get() * 2);
        assert.equal(c(), 2);
        assert.equal(cb.get(), 6);
        r.reset();
        assert.equal(s(), undefined);
        assert.equal(s.peek(), undefined);
        assert.equal(c(), undefined);
        assert.equal(c.peek(), undefined);
        assert.equal(sb.get(), undefined);
        assert.equal(sb.peek(), undefined);
        assert.equal(cb.get(), undefined);
        assert.equal(cb.peek(), undefined);
        const before = JSON.stringify(r.stats());
        s.set(9); sb.set(9);
        assert.equal(s(), undefined);
        assert.equal(sb.get(), undefined);
        assert.equal(JSON.stringify(r.stats()), before);
    });
    test("the next signal() fires op 1 with id 6 (nodeSeq continues) (ASSERTION A1 (planner))", () => {
        const f = fixtureExact();
        f.r.reset();
        f.ev.length = 0;
        f.r.signal(1);
        assert.deepEqual(f.ev, [[1, 6, 32]]);
    });
    test("reset() on an empty registry is a no-op returning undefined", () => {
        const r = createRegistry();
        assert.equal(r.reset(), undefined);
        assert.equal(r.stats().activeNodes, 0);
        assert.equal(r.stats().totalDisposals, 0);
    });
    test("top-level export reset() resets the default registry", () => {
        assert.equal(typeof Sig.reset, "function");
        const s = Sig.signal(1);
        assert.equal(Sig.stats().activeNodes, 1);
        assert.equal(Sig.reset(), undefined);
        assert.equal(Sig.stats().activeNodes, 0);
        assert.equal(s(), undefined);
    });
});

describe("A2 reset(): errors + depth counters", () => {
    // Three root effects; slots 0,1,2 (fresh registry). reset walks the highest slot first.
    function threeRoots(throwSlots) {
        const r = createRegistry();
        const log = [];
        const errs = [new Error("E0"), new Error("E1"), new Error("E2")];
        for (let i = 0; i < 3; i++) {
            r.effect(() => {
                r.onCleanup(() => { log.push("c" + i); if (throwSlots.includes(i)) throw errs[i]; });
            });
        }
        return { r, log, errs };
    }
    function after(r) {
        // post-error state: kills drop-the-finally mutants on disposeDepth / batchDepth.
        assert.equal(r.stats().activeNodes, 0);
        assert.equal(r.snapshot().nodes.length, 0);
        assert.equal(r.reset(), undefined);
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { s(); runs++; });
        assert.equal(runs, 1);
        s.set(1);
        assert.equal(runs, 2);
    }
    test("two throwers -> AggregateError, errors === [E2, E0] by identity, message", () => {
        const { r, errs } = threeRoots([2, 0]);
        let caught;
        try { r.reset(); } catch (e) { caught = e; }
        assert.ok(caught instanceof AggregateError);
        assert.equal(caught.errors.length, 2);
        assert.equal(caught.errors[0], errs[2]);
        assert.equal(caught.errors[1], errs[0]);
        assert.equal(caught.message, "reset: cleanups threw");
    });
    test("two throwers: each cleanup ran once, newest first; activeNodes 0", () => {
        const { r, log } = threeRoots([2, 0]);
        try { r.reset(); } catch {}
        assert.deepEqual(log, ["c2", "c1", "c0"]);
        assert.equal(r.stats().activeNodes, 0);
    });
    test("two throwers: graph usable afterwards (snapshot empty, second reset undefined, effect re-runs once)", () => {
        const { r } = threeRoots([2, 0]);
        try { r.reset(); } catch {}
        after(r);
    });
    test("single thrower is rethrown === itself (not wrapped)", () => {
        const { r, errs } = threeRoots([1]);
        let caught;
        try { r.reset(); } catch (e) { caught = e; }
        assert.equal(caught, errs[1]);
        assert.equal(r.stats().activeNodes, 0);
    });
    test("single thrower: graph usable afterwards", () => {
        const { r } = threeRoots([1]);
        try { r.reset(); } catch {}
        after(r);
    });
    test("each cleanup runs at most once; one throwing root does not stop the others (single thrower log)", () => {
        const { r, log } = threeRoots([1]);
        try { r.reset(); } catch {}
        assert.deepEqual(log, ["c2", "c1", "c0"]);
    });
    test("`this` inside a cleanup is undefined", () => {
        const r = createRegistry();
        let ran = 0, seen = "unset";
        r.effect(() => { r.onCleanup(function () { ran++; seen = this; }); });
        r.reset();
        assert.equal(ran, 1);
        assert.equal(seen, undefined);
    });
    test("throw leaves no write-batch open: a write after a throwing reset flushes at once", () => {
        const { r } = threeRoots([0, 1, 2]);
        let caught;
        try { r.reset(); } catch (e) { caught = e; }
        assert.ok(caught instanceof AggregateError);
        assert.deepEqual(caught.errors.map((e) => e.message), ["E2", "E1", "E0"]);
        const s = r.signal(0);
        const seen = [];
        r.effect(() => { seen.push(s()); });
        s.set(5);
        assert.deepEqual(seen, [0, 5]);
    });
});

// A3: the 7 in-flight contexts, for BOTH reset() and destroy() (D-4).
const NOT_SETTLED = /graph not settled/;
// A3': the reason text for reset/destroy called from a cleanup (or listener) running inside reset.
const IN_PROGRESS = /graph not settled \(dispose or reset in progress\)/;
function probe(r, m, out) {
    out.before = r.stats().activeNodes;
    try { r[m](); out.err = null; } catch (e) { out.err = e; }
    out.after = r.stats().activeNodes;
}
const CONTEXTS = {
    "batch body": (r, m, out) => {
        r.signal(0);
        r.batch(() => { probe(r, m, out); });
        out.expect = 1;
    },
    "effect body": (r, m, out) => {
        r.signal(0);
        r.effect(() => { probe(r, m, out); });
        out.expect = 2;
    },
    "computed body": (r, m, out) => {
        r.signal(0);
        const c = r.computed(() => { probe(r, m, out); return 1; });
        c();
        out.expect = 2;
    },
    "untrack() inside an effect's first run": (r, m, out) => {
        r.signal(0);
        r.effect(() => { r.untrack(() => { probe(r, m, out); }); });
        out.expect = 2;
    },
    "a cleanup during dispose(api)": (r, m, out) => {
        const e = r.effect(() => { r.onCleanup(() => { probe(r, m, out); }); });
        r.dispose(e);
        out.reason = IN_PROGRESS;
    },
    "an onGraphMutation listener": (r, m, out) => {
        let armed = false, fired = false;
        r.onGraphMutation(() => { if (armed && !fired) { fired = true; probe(r, m, out); } });
        armed = true;
        r.signal(0);
    },
    "a cleanup during reset": (r, m, out) => {
        r.effect(() => { r.onCleanup(() => { probe(r, m, out); }); });
        r.reset();
        out.reason = IN_PROGRESS;
    },
    // extra context (A3' / N2 intent: reset's own disposeDepth++ kills mutant M16): an op-2 listener during reset.
    "an op-2 listener during reset": (r, m, out) => {
        r.effect(() => {});
        let fired = false;
        r.onGraphMutation((op) => { if (op === 2 && !fired) { fired = true; probe(r, m, out); } });
        r.reset();
        out.reason = IN_PROGRESS;
    },
};
for (const m of ["reset", "destroy"]) {
    describe("A3 " + m + "() throws 'graph not settled' in flight", () => {
        for (const name of Object.keys(CONTEXTS)) {
            test(m + "() in " + name, () => {
                const r = createRegistry();
                const out = { err: undefined, before: -1, after: -2, expect: -1 };
                CONTEXTS[name](r, m, out);
                assert.ok(out.err instanceof Error, m + "() must throw in flight, got " + out.err);
                assert.match(out.err.message, NOT_SETTLED);
                if (out.reason) assert.match(out.err.message, out.reason);
                if (m === "reset" && out.reason) assert.equal(out.err.message, P + "reset: graph not settled (dispose or reset in progress)");
                if (m === "reset") assert.match(out.err.message, /reset: graph not settled/);
                assert.equal(out.after, out.before, "activeNodes unchanged by the refused call");
                if (out.expect !== -1) assert.equal(out.before, out.expect);
            });
        }
    });
}

describe("D-6 reset rounds are bounded by maxFlushPasses (counted rounds)", () => {
    // Spawn derivation (unchanged, creator rounds still count): spawn() once up front (1); round 1 disposes that effect
    // and its cleanup respawns (1); each later round (M-1 of them) can dispose both the survivor and an effect respawned
    // into a lower slot in the same round, so 2 spawns each: 1 + 1 + 2*(M-1). M=5 -> 10, M=3 -> 6.
    for (const [M, want] of [[5, 10], [3, 6]]) {
        test("maxFlushPasses " + M + ": cleanups that keep creating nodes -> AggregateError MSG[1], errors [], " + want + " spawns; survivor live; clean second reset ends it", () => {
            const r = createRegistry({ maxFlushPasses: M });
            let spawns = 0, stop = false;
            function spawn() {
                if (stop) return;
                spawns++;
                r.effect(() => { r.onCleanup(spawn); });
            }
            spawn();
            assert.equal(spawns, 1);
            let caught;
            try { r.reset(); } catch (e) { caught = e; }
            stop = true;
            assert.ok(caught instanceof AggregateError, "D-6 is always an AggregateError");
            assert.equal(caught.message, MSG1(1, M));
            assert.deepEqual(caught.errors, []);
            assert.equal(spawns, want);
            assert.equal(r.stats().effects, 1);
            assert.equal(r.stats().activeNodes, 1);
            assert.equal(r.reset(), undefined);
            assert.equal(r.stats().activeNodes, 0);
        });
    }
});

// ---- ADDENDUM 3 rows ----
function kids(r, n, log, errs) {
    // one root effect owning n throwing children; child i logs i then throws errs[i].
    r.effect(() => {
        for (let i = 1; i <= n; i++) {
            r.effect(() => { r.onCleanup(() => { log.push(i); throw errs[i]; }); });
        }
    });
}
function mkErrs(n) { const a = [null]; for (let i = 1; i <= n; i++) a.push(new Error("E" + i)); return a; }
// K6 pinned from the probe: 2 still live after 1 counted round.
const K6MSG = MSG1(2, 1);
function catchReset(r) { try { r.reset(); } catch (e) { return e; } return undefined; }
function op2counter(r) { const c = { n: 0, ids: [] }; r.onGraphMutation((op, a) => { if (op === 2) { c.n++; c.ids.push(a); } }); return c; }

describe("A2' D2 contract: a throwing cleanup skips the same node's later onCleanup", () => {
    test("2 onCleanup, first throws -> log ['c1'], reset rethrows E1 === itself, activeNodes 0", () => {
        const r = createRegistry();
        const log = [], E1 = new Error("E1");
        r.effect(() => {
            r.onCleanup(() => { log.push("c1"); throw E1; });
            r.onCleanup(() => { log.push("c2"); });
        });
        assert.equal(catchReset(r), E1);
        assert.deepEqual(log, ["c1"]);
        assert.equal(r.stats().activeNodes, 0);
    });
});

describe("A6 one root + N throwing owned children (default passes)", () => {
    for (const [n, op2] of [[100, 301], [150, 451]]) {
        test(n + " children: AggregateError 'reset: cleanups threw', " + n + " errors newest-first by identity, each cleanup once, activeNodes 0, op-2 " + op2, () => {
            const r = createRegistry();
            const log = [], errs = mkErrs(n);
            kids(r, n, log, errs);
            const c = op2counter(r);
            const caught = catchReset(r);
            assert.ok(caught instanceof AggregateError);
            assert.equal(caught.message, "reset: cleanups threw");
            assert.equal(caught.errors.length, n);
            const want = []; for (let i = n; i >= 1; i--) want.push(i);
            assert.deepEqual(log, want);
            for (let k = 0; k < n; k++) assert.equal(caught.errors[k], errs[n - k]);
            assert.equal(r.stats().activeNodes, 0);
            assert.equal(c.n, op2);
        });
    }
});

describe("A7 pure throwers never produce D-6", () => {
    test("(c) maxFlushPasses 3, a root owning 3 throwing children: errors [E3,E2,E1], no D-6", () => {
        const r = createRegistry({ maxFlushPasses: 3 });
        const log = [], errs = mkErrs(3);
        kids(r, 3, log, errs);
        const caught = catchReset(r);
        assert.ok(caught instanceof AggregateError);
        assert.equal(caught.message, "reset: cleanups threw");
        assert.equal(caught.errors.length, 3);
        assert.equal(caught.errors[0], errs[3]);
        assert.equal(caught.errors[1], errs[2]);
        assert.equal(caught.errors[2], errs[1]);
        assert.deepEqual(log, [3, 2, 1]);
        assert.equal(r.stats().activeNodes, 0);
    });
    test("(c') maxFlushPasses 1, 3 throwing root siblings: 3 errors, no D-6", () => {
        const r = createRegistry({ maxFlushPasses: 1 });
        const errs = mkErrs(3);
        for (let i = 1; i <= 3; i++) r.effect(() => { r.onCleanup(() => { throw errs[i]; }); });
        const caught = catchReset(r);
        assert.ok(caught instanceof AggregateError);
        assert.equal(caught.message, "reset: cleanups threw");
        assert.equal(caught.errors.length, 3);
        assert.equal(caught.errors[0], errs[3]);
        assert.equal(caught.errors[1], errs[2]);
        assert.equal(caught.errors[2], errs[1]);
        assert.equal(r.stats().activeNodes, 0);
    });
});

describe("A7' D-b159-D counting rule (B-1)", () => {
    test("K1 maxFlushPasses 1: detached throwing child -> the EK Error itself (not Aggregate), activeNodes 0", () => {
        const r = createRegistry({ maxFlushPasses: 1 });
        const s = r.signal(1);
        const EK = new Error("EK");
        const c = r.computed(() => { r.effect(() => { r.onCleanup(() => { throw EK; }); }); return s(); });
        c();
        const e = catchReset(r);
        assert.equal(e, EK);
        assert.ok(!(e instanceof AggregateError));
        assert.equal(r.stats().activeNodes, 0);
    });
    test("K2 maxFlushPasses 1: lost round + listener throw -> AggregateError 'reset: cleanups threw' [EK, EL], activeNodes 0", () => {
        const r = createRegistry({ maxFlushPasses: 1 });
        const EK = new Error("EK"), EL = new Error("EL");
        let n = 0;
        const R = r.effect(() => { r.effect(() => { r.onCleanup(() => { throw EK; }); }); });
        const rid = r.nodeId(R);
        r.onGraphMutation((op, id) => { if (op === 2 && id === rid && ++n === 2) throw EL; });
        const e = catchReset(r);
        assert.ok(e instanceof AggregateError);
        assert.equal(e.message, "reset: cleanups threw");
        assert.equal(e.errors.length, 2);
        assert.equal(e.errors[0], EK);
        assert.equal(e.errors[1], EL);
        assert.equal(r.stats().activeNodes, 0);
    });
});

describe("A7'' retry break test, one tooth per part (B-2)", () => {
    test("K3 default: two roots x 2 throwing children -> errors [b2,b1,a2,a1] by identity, activeNodes 0", () => {
        const r = createRegistry();
        const E = {};
        for (const t of ["a", "b"]) {
            r.effect(() => {
                r.onCleanup(() => {});
                for (let i = 1; i <= 2; i++) {
                    E[t + i] = new Error(t + i);
                    r.effect(() => { r.onCleanup(() => { throw E[t + i]; }); });
                }
            });
        }
        const e = catchReset(r);
        assert.ok(e instanceof AggregateError);
        assert.equal(e.message, "reset: cleanups threw");
        assert.equal(e.errors.length, 4);
        [E.b2, E.b1, E.a2, E.a1].forEach((x, i) => assert.equal(e.errors[i], x));
        assert.deepEqual(e.errors.map((x) => x.message), ["b2", "b1", "a2", "a1"]);
        assert.equal(r.stats().activeNodes, 0);
    });
    test("K4 default: disposal leg re-registering cleanup -> errors [a1,a2,a3,a4,b], k 4, activeNodes 0", () => {
        const r = createRegistry();
        const sigs = [r.signal(1), r.signal(2), r.signal(3)];
        let k = 0;
        const errs = [];
        const Eb = new Error("b");
        r.effect(() => { r.onCleanup(() => { throw Eb; }); });
        r.effect(() => {
            const o = r.getOwner();
            const c = () => {
                k++;
                const er = new Error("a" + k);
                errs.push(er);
                if (sigs.length) { r.dispose(sigs.pop()); r.runWithOwner(o, () => r.onCleanup(c)); }
                throw er;
            };
            r.onCleanup(c);
        });
        const e = catchReset(r);
        assert.ok(e instanceof AggregateError);
        assert.equal(e.message, "reset: cleanups threw");
        assert.deepEqual(e.errors.map((x) => x.message), ["a1", "a2", "a3", "a4", "b"]);
        [...errs, Eb].forEach((x, i) => assert.equal(e.errors[i], x));
        assert.equal(k, 4);
        assert.equal(r.stats().activeNodes, 0);
    });
    test("K5 maxFlushPasses 2: create leg never terminates -> MSG1(1, 2), errors [E1,E2], runs 2, activeNodes 1", () => {
        const r = createRegistry({ maxFlushPasses: 2 });
        let runs = 0;
        let sib = r.signal(0);
        r.effect(() => {
            const o = r.getOwner();
            const c = () => {
                runs++;
                if (runs > 1000) return; // cap keeps a mutant finite
                r.dispose(sib);
                sib = r.signal(runs);
                r.runWithOwner(o, () => r.onCleanup(c));
                throw new Error("E" + runs);
            };
            r.onCleanup(c);
        });
        const e = catchReset(r);
        assert.ok(e instanceof AggregateError);
        assert.equal(e.message, MSG1(1, 2));
        assert.deepEqual(e.errors.map((x) => x.message), ["E1", "E2"]);
        assert.equal(runs, 2);
        assert.equal(r.stats().activeNodes, 1);
    });
});

describe("A8 (d) a listener that throws on every op 2 -> MSG[2]", () => {
    test("maxFlushPasses 3, 4 signals: AggregateError MSG[2], 12 errors in fire order, op-2 12, nodes live, then clean reset", () => {
        const r = createRegistry({ maxFlushPasses: 3 });
        const sigs = [r.signal(10), r.signal(11), r.signal(12), r.signal(13)];
        const thrown = [], ids = [];
        const off = r.onGraphMutation((op, a) => {
            if (op !== 2) return;
            ids.push(a);
            const e = new Error("L" + thrown.length);
            thrown.push(e);
            throw e;
        });
        const caught = catchReset(r);
        assert.ok(caught instanceof AggregateError);
        assert.equal(caught.message, MSG2(4, 3));
        assert.equal(caught.errors.length, 12);
        for (let i = 0; i < 12; i++) assert.equal(caught.errors[i], thrown[i], "error " + i + " in fire order");
        assert.equal(ids.length, 12);
        assert.equal(r.stats().activeNodes, 4);
        assert.deepEqual(sigs.map((s) => s()), [10, 11, 12, 13]);
        off();
        assert.equal(r.reset(), undefined);
        assert.equal(r.stats().activeNodes, 0);
    });
});

describe("A9 cleanups that keep creating nodes -> MSG[1] with the collected errors", () => {
    test("maxFlushPasses 5, mk = () => r.effect(() => r.onCleanup(mk)): AggregateError MSG[1], errors [], effects 1", () => {
        const r = createRegistry({ maxFlushPasses: 5 });
        let stop = false;
        const mk = () => { if (!stop) r.effect(() => { r.onCleanup(mk); }); };
        mk();
        const caught = catchReset(r);
        stop = true;
        assert.ok(caught instanceof AggregateError);
        assert.equal(caught.message, MSG1(1, 5));
        assert.deepEqual(caught.errors, []);
        assert.equal(r.stats().effects, 1);
    });
    test("same + a root T whose cleanup throws E_T: errors deepEqual [E_T] (carried into the D-6 error)", () => {
        const r = createRegistry({ maxFlushPasses: 5 });
        const ET = new Error("E_T");
        let stop = false;
        const mk = () => { if (!stop) r.effect(() => { r.onCleanup(mk); }); };
        r.effect(() => { r.onCleanup(() => { throw ET; }); });
        mk();
        const caught = catchReset(r);
        stop = true;
        assert.ok(caught instanceof AggregateError);
        assert.equal(caught.message, MSG1(1, 5));
        assert.equal(caught.errors.length, 1);
        assert.equal(caught.errors[0], ET);
    });
});

describe("A9' K7 MSG2 reports the last counted round (B-4)", () => {
    test("K7 maxFlushPasses 2: AggregateError MSG2(2, 2), errors [L1,L2,L3], activeNodes 2", () => {
        const r = createRegistry({ maxFlushPasses: 2 });
        const bad = new Set();
        let made = false;
        const X = r.signal(0);
        bad.add(r.nodeId(X));
        r.effect(() => {
            r.onCleanup(() => {
                if (!made) { made = true; const e2 = r.effect(() => {}); bad.add(r.nodeId(e2)); }
            });
        });
        let n = 0;
        r.onGraphMutation((op, id) => { if (op === 2 && bad.has(id)) throw new Error("L" + (++n)); });
        const e = catchReset(r);
        assert.ok(e instanceof AggregateError);
        assert.equal(e.message, MSG2(2, 2));
        assert.deepEqual(e.errors.map((x) => x.message), ["L1", "L2", "L3"]);
        assert.equal(r.stats().activeNodes, 2);
    });
});

describe("A10 the closing flush's error rides last in the D-6 error", () => {
    // Fixture from .handoff/b159-evidence/b1-redo/probe-b1a-a10alt.mjs (the ADDENDUM 3 chain fixture cannot reach the
    // closing flush: its shared root signal is disposed in round 1). Here an op-2 listener on X creates s' and E' (reads s')
    // and sets s'; E' survives, is queued, and batch()'s closing flush re-runs it -> FE. Values from the probe output.
    test("maxFlushPasses 1: closing-flush error FE rides last -> AggregateError MSG[1] (2 still live after 1 counted rounds), errors [FE]", () => {
        const r = createRegistry({ maxFlushPasses: 1 });
        const FE = new Error("FE");
        let made = false, xid = -1, reruns = 0;
        r.onGraphMutation((op, id) => {
            if (op === 1 && xid === -1) xid = id;
            if (op === 2 && !made && id === xid) {
                made = true;
                const sp = r.signal(0);
                let runs = 0;
                r.effect(() => { sp(); if (runs++ > 0) { reruns++; throw FE; } });
                sp.set(1);
            }
        });
        r.signal(7);
        let caught;
        try { r.reset(); } catch (e) { caught = e; }
        assert.ok(caught instanceof AggregateError, "caught must be the D-6 AggregateError, not the bare flush error");
        assert.notEqual(caught, FE);
        assert.equal(caught.message, MSG1(2, 1));
        assert.equal(caught.errors.length, 1);
        assert.equal(caught.errors[0], FE);
        assert.equal(reruns, 1);
        assert.equal(made, true);
        assert.equal(r.stats().activeNodes, 2);
    });
    test("K8 maxFlushPasses 1: collected ET first, closing-flush FE last -> MSG1(2, 1), errors [ET, FE]", () => {
        const r = createRegistry({ maxFlushPasses: 1 });
        const FE = new Error("FE");
        const ET = new Error("ET");
        let made = false, xid = -1;
        r.onGraphMutation((op, id) => {
            if (op === 1 && xid === -1) xid = id;
            if (op === 2 && !made && id === xid) {
                made = true;
                const sp = r.signal(0);
                let runs = 0;
                r.effect(() => { sp(); if (runs++ > 0) throw FE; });
                sp.set(1);
            }
        });
        r.signal(7);
        r.effect(() => { r.onCleanup(() => { throw ET; }); });
        let caught;
        try { r.reset(); } catch (e) { caught = e; }
        assert.ok(caught instanceof AggregateError);
        assert.equal(caught.message, MSG1(2, 1));
        assert.equal(caught.errors.length, 2);
        assert.equal(caught.errors[0], ET);
        assert.equal(caught.errors[1], FE);
        assert.equal(r.stats().activeNodes, 2);
    });
});

describe("A10' K6 closing-flush null throw is recorded (B-3)", () => {
    test("K6 maxFlushPasses 1: closing flush throws null -> AggregateError MSG1, errors === [null]", () => {
        const r = createRegistry({ maxFlushPasses: 1 });
        r.signal(0);
        let done = false;
        r.onGraphMutation((op) => {
            if (op === 2 && !done) {
                done = true;
                const s2 = r.signal(0);
                let first = true;
                r.effect(() => { s2(); if (!first) throw null; first = false; });
                s2.set(1);
            }
        });
        const e = catchReset(r);
        assert.ok(e instanceof AggregateError);
        assert.equal(e.message, K6MSG);
        assert.equal(e.errors.length, 1);
        assert.equal(e.errors[0], null);
    });
});

describe("A11 L1 reset runs inside batch(): a cleanup write must not flush mid-reset", () => {
    test("runs === 0 (kills the no-batch mutant M17)", () => {
        const r = createRegistry();
        const s = r.signal(0);
        let runs = 0;
        r.effect(() => { s(); runs++; });
        r.effect(() => { r.onCleanup(() => s.set(1)); });
        runs = 0;
        r.reset();
        assert.equal(runs, 0);
    });
});

describe("A5+ retention of the thrown errors (lite-leak, needs --expose-gc)", () => {
    // ONE long-lived registry so a mutant that leaves resetFail set keeps the aggregate alive (mutant -> size 1).
    const r = createRegistry({ maxFlushPasses: 5 });
    let idc = 0;
    function cycle(tracker) {
        const log = [], errs = mkErrs(100);
        kids(r, 100, log, errs);
        const a = catchReset(r);
        tracker.track(a, null, ++idc);
        for (const e of a.errors) tracker.track(e, null, ++idc);
        let stop = false;
        const mk = () => { if (!stop) r.effect(() => { r.onCleanup(mk); }); };
        mk();
        const b = catchReset(r);
        tracker.track(b, null, ++idc);
        stop = true;
        assert.equal(r.reset(), undefined);
    }
    test("tracker.size() === 0 after gc on each of 5 cycles", { skip: !HAVE_GC }, async () => {
        const tracker = createLeakTracker({ name: "t103", onLeak() {}, onWarning() {} });
        for (let k = 0; k < 5; k++) {
            cycle(tracker);
            for (let i = 0; i < 30 && tracker.size() > 0; i++) { await settle(); await nap(10); }
            assert.equal(tracker.size(), 0, "cycle " + k);
        }
        assert.equal(r.stats().activeNodes, 0);
    });
});
