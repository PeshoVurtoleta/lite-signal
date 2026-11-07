/**
 * FIX-CL-D (b176): LEDGER #55 -- an onCleanup that THROWS must not wedge a node. Rows A1-A9 / R1-R6 / F1 / D1 pin the
 * RE-RUN contract (a node that has run: body skipped, error rethrown / cached, links as the last run left them).
 * The rows after them pin the BODY-FIRST contract for a node that has NOT run yet (a cleanup attached before the first
 * run with runWithOwner), rulings D-b175-1..4 of PROPOSAL-fix-cl-shape.md (research b175, shape D):
 *   - the engine disposes the still-attached owned children (repeated only after a child threw, at most
 *     maxFlushPasses passes; at the cap a CycleError joins the errors and the rest waits for the next run), runs the
 *     node's own cleanup list ONCE (entries after a throwing one are dropped, A7), runs the body ONCE, then surfaces
 *     every error as that run's error: a computed caches E (an AggregateError when more than one error: the cleanup
 *     errors in DISPOSAL order, then the body error, O-b176-1) until its next dependency change; an effect rethrows it.
 *   - cleanups re-armed during the drain wait for the next run; a dep-less computed keeps E until disposed (D-b175-3).
 * Expected values come from the planner ASSERTIONS (PLAN-FIX-CL.md ADDENDUM b176, ROW MAP) and the b175 research
 * (RESEARCH.md 3-4, probes rv172-p1 / rv173-paths / rv174-* / attack{,2,3} / fc-props), re-probed on the frozen
 * build D6 d0daca88 for this file. Never copied from a candidate engine's output unchecked: a PROBE row says so.
 * E and E2 are compared BY IDENTITY; AggregateError .errors element by element.
 *
 * Legend (builds: d235e505 = Signal.js before FIX-CL, r3 = 9cf9518f the #55 core, D = the body-first build):
 *   RED    red on r3 AND d235e505 (the row pins the new body-first behaviour).
 *   R0     red on d235e505 only (the r3 core already satisfies it; pins the re-run contract).
 *   PARITY green on all three builds (regression pin or unchanged-behaviour pin; the comment says which).
 * Per-row marking is in the comment above each row; the counts per build are in
 * .handoff/b176-evidence/bt1/RED-<build>.txt.
 * Every row title starts with its [RED] / [R0] / [PARITY] tag (checked against the per-build runs: RED 52, R0 13,
 * PARITY 17 of 82 rows). PARITY rows include the unchanged A6 A8 A9 D1 R5 F1, P7, S5c, REARM S2c, A7D (dropped entry), Pa-Pj.
 *
 * LEDGER #55 (FIXED by this shape) and #56 (OPEN, D-b170-4: a child whose cleanup throws is popped before its disposal
 * and stays live; rows A4, A6, P3, PE, CAP, CAPN3 pin the orphan counts as they are).
 * AUD-E1 (b177, r2 b178) adds 13 rows at the end (S1 x4, B3 message + B3 disposed-branch message, F0-E pin, F0-C, P2
 * snapshot/restore x2, A4 x2, A5 x1; header above the "AUD-E1 S1" describe). Each row's tag in its title says RED / PIN /
 * PARITY against the frozen 17ac945 / c8f6cd1e build; no row is deferred (the rows that assert the new
 * never-ran message text are red on a tree that still has the old text, by design). The A4 row is a KNOWN pin (ruling
 * Q-b177-1). One more r2 row, S1e2 (T5, [PARITY]), sits in the FIX-CL-D section beside S1e. The 82-row count above is the
 * FIX-CL-D count.
 * A8 / NR-GC run in a child process (--expose-gc). Not ported: S5b (a sync scheduler runs the first body at creation,
 * the cleanup attaches afterwards: not a never-run attach).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Engine under test: F_B33_ENGINE (absolute path or file: URL; the same switch as test/56), default ../Signal.js.
const ENGINE = process.env.F_B33_ENGINE ?? new URL("../Signal.js", import.meta.url).href;
const ENGINE_URL = ENGINE.startsWith("file:") ? ENGINE : pathToFileURL(ENGINE).href;
const { createRegistry } = await import(ENGINE_URL);

const E = new Error("E");

function thrown(fn) {
    try { fn(); } catch (e) { return e; }
    return NOBODY;
}
const NOBODY = Symbol("nothing thrown");

describe("FIX-CL: throwing re-run cleanup does not wedge (LEDGER #55)", () => {

    it("[R0] A1 effect: cleanup throw rethrows E from the write, body skipped, effect recovers, snapshot works", () => {
        const r = createRegistry();
        const p = r.signal(0), q = r.signal(0);
        const runs = [];
        r.effect(() => {
            runs.push(p());
            r.onCleanup(() => { if (q.peek() > 0) throw E; });
        });
        assert.deepEqual(runs, [0]);
        const e1 = thrown(() => r.batch(() => { q.set(1); p.set(1); }));
        assert.equal(e1, E);
        assert.deepEqual(runs, [0]);
        // the throw consumed the cleanup; the next write runs the body
        assert.equal(thrown(() => p.set(2)), NOBODY);
        assert.deepEqual(runs, [0, 2]);
        assert.equal(r.stats().activeLinks, 1);
        assert.doesNotThrow(() => r.snapshot());
        // the body re-registered the throwing cleanup (q is still 1): the next re-run throws again
        assert.equal(thrown(() => p.set(3)), E);
        assert.deepEqual(runs, [0, 2]);
        assert.equal(thrown(() => q.set(0)), NOBODY);
        assert.deepEqual(runs, [0, 2]);
        assert.equal(thrown(() => p.set(4)), NOBODY);
        assert.deepEqual(runs, [0, 2, 4]);
    });

    it("[R0] A2 computed: cleanup throw is cached as the computed's error, never a CycleError", () => {
        const r = createRegistry();
        const p = r.signal(0), q = r.signal(0);
        const c = r.computed(() => {
            r.onCleanup(() => { if (q.peek() > 0) throw E; });
            return 10 * p();
        });
        assert.equal(c(), 0);
        q.set(1);
        p.set(1);
        assert.equal(thrown(() => c()), E);
        assert.equal(thrown(() => c()), E);
        q.set(0);
        assert.equal(thrown(() => c()), E);   // the error is cached until a dependency changes
        p.set(2);
        assert.equal(c(), 20);
    });

    it("[R0] A3 D-H: an effect that catches the computed's cleanup error sees it; the write does not throw", () => {
        const r = createRegistry();
        const p = r.signal(0), q = r.signal(0);
        const E3 = new Error("E");
        const c = r.computed(() => {
            r.onCleanup(() => { if (q.peek() > 0) throw E3; });
            return 10 * p();
        });
        const log = [];
        r.effect(() => {
            try { log.push(c()); } catch (e) { log.push("!" + e.message); }
        });
        q.set(1);
        assert.equal(thrown(() => p.set(1)), NOBODY);
        assert.deepEqual(log, [0, "!E"]);
    });

    it("[R0] A5 #50: onCleanup(5) throws TypeError /fn is not a function/ at re-run; the next write runs the body", () => {
        const r = createRegistry();
        const p = r.signal(0);
        let runs = 0;
        r.effect(() => {
            p();
            runs++;
            r.onCleanup(() => {});
            r.onCleanup(5);
        });
        assert.equal(runs, 1);
        const e = thrown(() => p.set(1));
        assert.ok(e instanceof TypeError);
        assert.match(e.message, /fn is not a function/);
        assert.equal(runs, 1);
        assert.equal(thrown(() => p.set(2)), NOBODY);
        // the failed run consumed the cleanup list, so write 2 runs the body
        assert.equal(runs, 2);
    });

    it("[R0] A7 skip rule: cleanups a, b (throws), c -> log [a, b]; c never runs; the next write runs the body", () => {
        const r = createRegistry();
        const p = r.signal(0);
        const log = [];
        let runs = 0;
        const EB = new Error("B");
        r.effect(() => {
            p();
            runs++;
            r.onCleanup(() => log.push("a"));
            r.onCleanup(() => { log.push("b"); throw EB; });
            r.onCleanup(() => log.push("c"));
        });
        assert.equal(thrown(() => p.set(1)), EB);
        assert.deepEqual(log, ["a", "b"]);
        assert.equal(runs, 1);
        // the next write runs the body (it throws nothing: the cleanup list was consumed)
        assert.equal(thrown(() => p.set(2)), NOBODY);
        assert.equal(runs, 2);
        assert.deepEqual(log, ["a", "b"]);
    });
});

describe("FIX-CL: orphan of a throwing cascade / dispose cleanup stays open (LEDGER #56, D-b170-4 (a))", () => {

    // Derived from D-b170-3 (a) + the orchestrator ruling, not probed: the parent's cascade detaches the child
    // BEFORE its cleanup throws, so the child is a live ORPHAN (LEDGER #56, stays open). The frozen build shows
    // the WEDGE instead (parent keeps FLAG_COMPUTING: parentRuns stays 1, effects 2), so this row is RED there.
    it("[R0] A4 cascade: parent recovers (runs 2); the orphan of #56 stays live (effects 3)", () => {
        const r = createRegistry();
        const p = r.signal(0), q = r.signal(0);
        let parentRuns = 0;
        r.effect(() => {
            p();
            parentRuns++;
            r.effect(() => {
                p();
                r.onCleanup(() => { if (q.peek() > 0) throw E; });
            });
        });
        assert.equal(parentRuns, 1);
        assert.equal(r.stats().effects, 2);
        q.set(1);
        assert.equal(thrown(() => p.set(1)), E);   // parent body skipped; the orphan re-runs, re-registers its cleanup
        assert.equal(thrown(() => p.set(2)), E);   // the orphan's re-run cleanup throws (q is 1)
        assert.equal(parentRuns, 2);               // the parent ran its body: not wedged
        // parent + orphan + the new child: the 3rd is the LEDGER #56 orphan
        assert.equal(r.stats().effects, 3);
    });

    it("[PARITY] A6 dispose PARITY: first dispose throws E, the effect still runs on the next write, a later dispose completes", () => {
        const r = createRegistry();
        const p = r.signal(0), q = r.signal(0);
        const runs = [];
        let cleanups = 0, op2 = 0;
        r.onGraphMutation((op) => { if (op === 2) op2++; });
        const d = r.effect(() => {
            runs.push(p());
            r.onCleanup(() => { cleanups++; if (q.peek() > 0) throw E; });
        });
        q.set(1);
        assert.equal(thrown(() => r.dispose(d)), E);
        assert.equal(cleanups, 1);
        assert.equal(op2, 1);
        assert.equal(r.stats().effects, 1);   // the effect survives the throwing dispose (the orphan, #56)
        assert.equal(thrown(() => p.set(1)), NOBODY);
        assert.deepEqual(runs, [0, 1]);       // it still runs on the next write
        q.set(0);
        assert.equal(thrown(() => r.dispose(d)), NOBODY);
        assert.equal(cleanups, 2);
        assert.equal(r.stats().effects, 0);
        assert.equal(op2, 2);                 // graph op 2 (node disposed) fired once per attempt: 2
    });
});

// ---- A8: zero-GC of the re-run path (regression pin) + must-fail control, in a CHILD process ----
// FILLER 218 (b176): A8 failed when 4 copies ran in parallel at load ~30 (passed alone; failure mode not recorded).
// Background JIT installs land in a load-dependent number of the 12 measured windows (code / trusted taint,
// heap-window.mjs; b176 probe, 24 parallel children: 1 or 2 tainted, 24/24 identical with the flags below). The child now
// runs --single-threaded (tier-up depends on the call budget only, not on host load; as test/71 / test/72) with the
// semi-space pinned BOTH ways (--min + --max = 1 MB), and refuses to measure when any of those flags is missing.

const HEAP_WINDOW = new URL("../bench/torture/helpers/heap-window.mjs", import.meta.url).href;
const SIGNAL_URL = ENGINE_URL;

const A8_FLAGS = ["--expose-gc", "--single-threaded", "--min-semi-space-size=1", "--max-semi-space-size=1"];

const CHILD = `
import { measureWindows } from ${JSON.stringify(HEAP_WINDOW)};
import { createRegistry } from ${JSON.stringify(SIGNAL_URL)};
for (const f of ${JSON.stringify(A8_FLAGS)}) {
    if (!process.execArgv.includes(f)) { console.error("A8 child: " + f + " is not in execArgv"); process.exit(3); }
}
const N = 100000, WARM = 4, CYC = 12;
const cb = () => {};
let SINK = null;                 // module scope: a dead local would be escape-eliminated
function make(control) {
    const r = createRegistry();
    const p = r.signal(0);
    r.effect(() => { p(); r.onCleanup(cb); });
    let k = 1;
    return () => {
        for (let i = 0; i < N; i++) { p.set(k++); if (control) SINK = [i, k]; }
    };
}
const real = await measureWindows(make(false), { warmup: WARM, cycles: CYC });
const ctl = await measureWindows(make(true), { warmup: WARM, cycles: CYC });
console.log("RESULT " + JSON.stringify({ N, real, ctl, sinkSet: SINK !== null }));
`;

function runChild(flags) {
    const res = spawnSync(process.execPath, [...A8_FLAGS, ...flags, "--input-type=module", "-e", CHILD], {
        encoding: "utf8", timeout: 120000, killSignal: "SIGKILL",
    });
    assert.equal(res.error, undefined, "spawn error: " + (res.error && res.error.message));
    assert.equal(res.signal, null, "child killed by " + res.signal);
    assert.equal(res.status, 0, "child status " + res.status + "\n" + res.stderr);
    const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, "no RESULT line:\n" + res.stdout + res.stderr);
    return JSON.parse(line.slice(7));
}

describe("FIX-CL A8: 1e5 re-runs with a NON-throwing cleanup stay zero-GC (regression pin)", () => {
    it("[PARITY] A8 real loop: minor 0, major 0, <= 0.5 B/op over non-code spaces; control (module-scope sink) minor > 0", () => {
        const o = runChild([]);
        const cap = 0.5 * o.N;
        assert.equal(o.real.nan, 0);
        assert.ok(o.real.clean >= 12 - 4, "clean windows " + o.real.clean);
        assert.equal(o.real.minor, 0);
        assert.equal(o.real.major, 0);
        assert.ok(o.real.max <= cap, "max bytes/window " + o.real.max);
        // must-fail control: the same loop plus a retained-transient sink must scavenge
        assert.equal(o.sinkSet, true);
        assert.ok(o.ctl.minor > 0, "control minor " + o.ctl.minor);
    });

    it("[PARITY] A8 control teeth hold under --no-opt --no-maglev (a boxing control is tier-dependent)", () => {
        const o = runChild(["--no-opt", "--no-maglev"]);
        assert.equal(o.sinkSet, true);
        assert.ok(o.ctl.minor > 0, "control minor " + o.ctl.minor);
    });
});

// ---- A9: retention over 10,000 throw -> recover -> dispose cycles ----

describe("FIX-CL A9: retention across throw -> recover -> dispose cycles", () => {
    const CYCLES = 10000;

    function run(keepAlive) {
        const r = createRegistry({ onCapacityExceeded: "grow" });
        const p = r.signal(0), q = r.signal(0);
        const marks = [];
        let k = 0, hits = 0;
        const keep = [];
        for (let i = 1; i <= CYCLES; i++) {
            const d = r.effect(() => {
                p();
                r.onCleanup(() => { if (q.peek() > 0) throw E; });
            });
            q.set(1);
            if (thrown(() => p.set(++k)) === E) hits++;   // re-run: the cleanup throws
            q.set(0);                                      // recover
            thrown(() => p.set(++k));                      // the body runs again (fixed build)
            if (keepAlive) keep.push(d); else r.dispose(d);
            if (i % 1000 === 0) { const s = r.stats(); marks.push([s.activeNodes, s.activeLinks]); }
        }
        return { marks, hits, last: r.stats() };
    }

    it("[PARITY] each cycle throws E from the write; every 1,000-cycle checkpoint reads activeNodes 2, activeLinks 0", () => {
        const o = run(false);
        assert.equal(o.hits, CYCLES);
        assert.equal(o.marks.length, 10);
        for (const m of o.marks) assert.deepEqual(m, [2, 0]);
        assert.equal(o.last.activeNodes, 2);
        assert.equal(o.last.activeLinks, 0);
        assert.equal(o.last.effects, 0);
    });

    it("[PARITY] keep-alive control: keeping every cycle's effect adds exactly +10,000 nodes and +10,000 links", () => {
        const o = run(true);
        assert.equal(o.last.activeNodes, 2 + CYCLES);
        assert.equal(o.last.activeLinks, CYCLES);
        assert.deepEqual(o.marks[9], [2 + CYCLES, CYCLES]);
    });
});

// ---- r2 teeth rows (b171): one per ruled clause the r1 reviewer found unpinned. Each is RED on its named mutant. ----

const FLAG_STALE_READ = 64;   // snapshot().nodes[i].flags bit (Signal.js FLAG_STALE_READ = 1 << 6)
function stale(r) { return r.snapshot().nodes.some((n) => (n.flags & FLAG_STALE_READ) !== 0); }

describe("FIX-CL r2: teeth for the ruled clauses", () => {

    it("[R0] R1 D-b170-3: a throwing effect re-run is NOT stamped evaluated; a later wake through an unchanged computed still runs the body", () => {
        const r = createRegistry();
        const p = r.signal(0), q = r.signal(0), s = r.signal(0);
        const c = r.computed(() => s() & 0);
        const runs = [];
        r.effect(() => {
            runs.push(p());
            c();
            r.onCleanup(() => { if (q.peek() > 0) throw E; });
        });
        q.set(1);
        assert.equal(thrown(() => p.set(1)), E);
        q.set(0);
        s.set(1);
        assert.deepEqual(runs, [0, 1]);   // stampE mutant: [0]
    });

    it("[R0] R2 computed clears STALE_READ on a cleanup throw: no stale bit, one recompute, log [0, '!E', 3]", () => {
        const r = createRegistry();
        const x = r.signal(0), p = r.signal(0), q = r.signal(0), w = r.signal(0);
        let cRuns = 0;
        const c = r.computed(() => {
            cRuns++;
            r.onCleanup(() => { if (q.peek() > 0) { w.set(w.peek() + 1); throw E; } });
            return p() + w();
        });
        const log = [];
        r.effect(() => { x(); try { log.push(c()); } catch (e) { log.push("!" + e.message); } });
        q.set(1);
        r.batch(() => { x.set(1); p.set(1); });
        assert.equal(stale(r), false);    // nostaleC mutant: bit 64 left set
        q.set(0);
        const before = cRuns;
        p.set(2);
        assert.equal(cRuns - before, 1);  // nostaleC mutant: 2
        assert.deepEqual(log, [0, "!E", 3]);
    });

    it("[R0] R3 effect clears STALE_READ on a cleanup throw inside a nested flush: no stale bit afterwards", () => {
        const r = createRegistry();
        const t = r.signal(0), q = r.signal(0), w = r.signal(0), z = r.signal(0);
        r.effect(() => {
            t(); w();
            r.onCleanup(() => { if (q.peek() > 0) { w.set(w.peek() + 1); throw E; } });
        });
        const k = r.computed(() => { z(); t.set(t.peek() + 1); return 1; });
        q.set(1);
        assert.equal(thrown(() => k()), E);
        assert.equal(stale(r), false);    // nostaleE mutant: bit 64 left set
    });

    it("[R0] R4 computed cleanup that disposes its own node then throws: swallowed, no resurrection (nodes 2 === activeNodes 2)", () => {
        const r = createRegistry();
        const p = r.signal(0), q = r.signal(0);
        let c;
        c = r.computed(() => {
            r.onCleanup(() => { if (q.peek() > 0) { r.dispose(c); throw E; } });
            return 10 * p();
        });
        c();
        q.set(1);
        p.set(1);
        assert.equal(thrown(() => c()), NOBODY);
        assert.equal(r.snapshot().nodes.length, 2);   // ungatedC mutant: 3
        assert.equal(r.stats().activeNodes, 2);
    });

    it("[PARITY] R5 A1b-2: a computed cleanup that disposes its own node WITHOUT throwing stops the re-run; graph op 5 does not fire", () => {
        const r = createRegistry();
        const p = r.signal(0), q = r.signal(0);
        let op5 = 0, c;
        r.onGraphMutation((op) => { if (op === 5) op5++; });
        c = r.computed(() => {
            r.onCleanup(() => { if (q.peek() > 0) r.dispose(c); });
            return 10 * p();
        });
        c();
        const before = op5;
        q.set(1);
        p.set(1);
        c();
        assert.equal(op5 - before, 0);    // genFalse mutant: 1
    });

    // D-b171-1 / Q-CL-3: RED on the r1 build 56710006 (snapshot throws "scheduled effect run pending").
    it("[R0] R6 D-b171-1 needs-run marker: after a re-queued effect's re-run cleanup throws, snapshot() works and the next write runs the body", () => {
        const r = createRegistry();
        const s = r.signal(0), trig = r.signal(0), x = r.signal(0);
        const u = r.signal(0), w = r.signal(0); const cu = r.computed(() => u() & 0);
        let arm = false, runs = 0;
        const k = r.computed(() => { if (trig() > 0) { arm = true; s.set(s.peek() + 1); } return trig(); });
        r.effect(() => {
            x(); s(); k(); cu();
            runs++;
            r.onCleanup(() => { if (arm) { arm = false; w.set(w.peek() + 1); w.set(w.peek() + 1); throw E; } });
        });
        assert.equal(runs, 1);
        assert.equal(thrown(() => r.batch(() => { s.set(10); trig.set(1); })), E);
        assert.equal(runs, 2);
        assert.doesNotThrow(() => r.snapshot());
        // u.set(1) wakes the effect through an UNCHANGED computed: a marker runs the body, a stamp stays idle
        // R6' (B-2): the cleanup wrote w twice before throwing; a near-floor marker (globalVersion - 1) sits above the dep stamp
        u.set(1); assert.equal(runs, 3);   // markerNear: 2
        x.set(1);
        assert.equal(runs, 4);             // markerNear: 3
        assert.doesNotThrow(() => r.snapshot());
    });

    // B-3 (REVIEW-r3): the runCleanupC dispatcher's firstOwned branch. Regression pin (green on r3 and d235e505);
    // killed by dispCOwnedOnly (effects 3 / childCleanups 0).
    it("[PARITY] D1 A1b-2 dispatcher: a computed's owned child (no onCleanup on the computed) is cascade-disposed on every recompute", () => {
        const r = createRegistry(); const p = r.signal(0); let childCleanups = 0;
        const c = r.computed(() => { r.effect(() => { r.onCleanup(() => childCleanups++); }); return p(); });
        c(); p.set(1); c(); p.set(2); c();
        assert.equal(r.stats().effects, 1);   // dispCOwnedOnly mutant: 3
        assert.equal(childCleanups, 2);       // dispCOwnedOnly mutant: 0
    });
});

// ======================================================================================================
// FIX-CL-D (b176): body-first rows for a node whose cleanup was attached before its FIRST run
// ======================================================================================================

const E2 = new Error("E2");
const FLAGS_QUEUED_STALE = 68;   // FLAG_QUEUED 4 | FLAG_STALE_READ 64
const CYCLE_TEXT = "CycleError: owned cleanups kept throwing before the body ran";   // B3 (D-AUD-2), was "... before the first run"

function rec(r, h) { const id = r.nodeId(h); return r.snapshot().nodes.find((n) => n.id === id); }
function snapOk(r) { try { r.snapshot(); return true; } catch { return false; } }
function sameJson(a, b) { return JSON.stringify(a, errRepl) === JSON.stringify(b, errRepl); }
function errRepl(k, v) { return v instanceof Error ? "ERR:" + v.message : v; }
// An AggregateError whose .errors are exactly `list` (identity, element by element, in order).
function assertAgg(e, list) {
    assert.ok(e instanceof AggregateError, "not an AggregateError: " + String(e));
    assert.equal(e.errors.length, list.length);
    for (let i = 0; i < list.length; i++) assert.equal(e.errors[i], list[i], "errors[" + i + "]");
}

// A never-run computed c (s * 10) with a throwing cleanup attached by runWithOwner before its first read.
function c1(r) {
    const s = r.signal(1); const st = { runs: 0 };
    const c = r.computed(() => { st.runs++; return s() * 10; });
    r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
    return { s, c, st };
}
// gv seeding through restore (rv174-band.mjs): a registry whose globalVersion is `gv` (null = default).
function seeded(gv) {
    const r = createRegistry(); r.signal(0);
    if (gv === null) return r;
    const snap = r.snapshot();
    return r.restore(Object.assign({}, snap, { gv }), { fnsById: {}, handles: {} });
}

describe("FIX-CL-D: a cleanup that throws before the first run (body-first, D-b175-1..4)", () => {

    // ---- first-run values: computed ----
    // RED: r3 / d235e505 stamp E on the 2nd read and run the body there (runs 0 after the 1st read).
    it("[RED] P2 never-run computed: c() E, c() E (body ran ONCE in the first read), runs 1, snapshot ok; a write gives 20, runs 2", () => {
        const r = createRegistry(); const { s, c, st } = c1(r);
        assert.equal(thrown(() => c()), E);
        assert.equal(st.runs, 1);
        assert.equal(thrown(() => c()), E);
        assert.equal(st.runs, 1);
        assert.equal(snapOk(r), true);
        s.set(2);
        assert.equal(c(), 20);
        assert.equal(st.runs, 2);
    });

    it("[RED] P3 owned child effect whose cleanup throws: c() E twice, body runs once; the #56 orphan stays live (PROBE: effects 1)", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        r.runWithOwner(c, () => r.effect(() => { r.onCleanup(() => { throw E; }); }));
        assert.equal(r.stats().effects, 1);
        assert.equal(thrown(() => c()), E);
        assert.equal(thrown(() => c()), E);
        assert.equal(runs, 1);
        assert.equal(r.stats().effects, 1);   // PROBE: the orphan of the throwing cascade (LEDGER #56) is still live
        s.set(2);
        assert.equal(c(), 20);
        assert.equal(runs, 2);
    });

    it("[RED] P4 c's evaluated record round-trips: flags 17, version === evalVersion !== 0; restored d 20, live d 20 (Pg)", () => {
        const r = createRegistry(); const { s, c } = c1(r);
        const d = r.computed(() => { try { return c(); } catch (e) { return e === E ? "E" : "?"; } });
        assert.equal(d(), "E");
        const cr = rec(r, c);
        assert.equal(cr.flags, 17);                       // FLAG_COMPUTED 1 | FLAG_HAS_ERROR 16
        assert.equal(cr.value, E);
        assert.notEqual(cr.version, 0);
        assert.equal(cr.version, cr.evalVersion);
        const snap = r.snapshot();
        const sId = r.nodeId(s), cId = r.nodeId(c), dId = r.nodeId(d);
        const H = {};
        const r2 = r.restore(snap, { fnsById: { [cId]: () => H[sId]() * 10, [dId]: () => { try { return H[cId](); } catch { return "E"; } } }, handles: H });
        assert.ok(sameJson(r2.snapshot(), snap));
        assert.deepEqual(r2.snapshot(), snap);
        H[sId].set(2);
        assert.equal(H[dId](), 20);
        s.set(2);
        assert.equal(d(), 20);
    });

    // PARITY-r3: restore-wired never-evaluated computed (headDep set by the record): E, E, 20 on every build.
    it("[R0] P7 restore-wired never-evaluated computed, throwing pre-run cleanup: E, E, then 20 after a write; body ran once before the write", () => {
        const r = createRegistry(); const s = r.signal(1); const c = r.computed(() => s() * 10); const sId = r.nodeId(s), cId = r.nodeId(c);
        const snap = r.snapshot(); const cr = snap.nodes.find((n) => n.id === cId); cr.deps = [sId]; cr.subPos = [0];
        const H = {}; let runs = 0;
        const r2 = r.restore(snap, { fnsById: { [cId]: () => { runs++; return H[sId]() * 10; } }, handles: H });
        r2.runWithOwner(H[cId], () => r2.onCleanup(() => { throw E; }));
        assert.equal(thrown(() => H[cId]()), E);
        assert.equal(thrown(() => H[cId]()), E);
        H[sId].set(2);
        assert.equal(H[cId](), 20);
    });

    // ---- first-run values: deferred effect ----
    // RED: r3 / d235e505 skip the body on the first run (runs 0, snapshot refuses).
    it("[RED] P1 deferred effect: t() throws E, the body ran (runs 1, log [1]), snapshot ok; s.set(2) -> t2 returns undefined, log [1,2], runs 2 (S5a)", () => {
        const r = createRegistry(); const s = r.signal(1); const q = []; const log = []; let runs = 0;
        const h = r.effect(() => { runs++; log.push(s()); }, { scheduler: (t) => q.push(t) });
        r.runWithOwner(h, () => r.onCleanup(() => { throw E; }));
        assert.equal(runs, 0);
        assert.equal(q.length, 1);
        assert.equal(thrown(() => q.shift()()), E);
        assert.equal(runs, 1);
        assert.deepEqual(log, [1]);
        assert.equal(snapOk(r), true);
        assert.equal(q.length, 0);
        s.set(2);
        assert.equal(q.length, 1);
        assert.equal(thrown(() => q.shift()()), NOBODY);
        assert.deepEqual(log, [1, 2]);
        assert.equal(runs, 2);
    });

    // ---- readers of a never-run c (D-b175-1: the first read caches E; readers see the cached error) ----
    it("[RED] T1 computed reader d of c: E, then 20, 30 after writes; c.runs 3; snapshot ok; c's record is a plain evaluated computed (flags 1)", () => {
        const r = createRegistry(); const { s, c, st } = c1(r);
        const d = r.computed(() => { try { return c(); } catch (e) { return e === E ? "E" : "?"; } });
        assert.equal(d(), "E");
        assert.equal(st.runs, 1);
        s.set(2); assert.equal(d(), 20);
        s.set(3); assert.equal(d(), 30);
        assert.equal(st.runs, 3);
        assert.equal(snapOk(r), true);
        const cr = rec(r, c);
        assert.equal(cr.flags, 1);
        assert.notEqual(cr.evalVersion, 0);
    });

    it("[RED] T1b uncatching computed reader d2 = c() * 2: throws E (the cached error), c's body ran once; after a write 40 (PROBE)", () => {
        const r = createRegistry(); const { s, c, st } = c1(r);
        const d2 = r.computed(() => c() * 2);
        assert.equal(thrown(() => d2()), E);
        assert.equal(st.runs, 1);
        s.set(2);
        assert.equal(d2(), 40);
        assert.equal(st.runs, 2);
    });

    it("[RED] T2 catching effect reader: log [E, 20, 30] (eR 3, c.runs 3); no QUEUED / STALE_READ left", () => {
        const r = createRegistry(); const { s, c, st } = c1(r); const log = []; let eR = 0;
        const h = r.effect(() => { eR++; try { log.push(c()); } catch (e) { log.push(e === E ? "E" : "?"); } });
        assert.deepEqual(log, ["E"]);
        assert.equal(eR, 1);
        s.set(2); s.set(3);
        assert.deepEqual(log, ["E", 20, 30]);
        assert.equal(eR, 3);
        assert.equal(st.runs, 3);
        assert.equal(rec(r, h).flags & FLAGS_QUEUED_STALE, 0);
    });

    it("[RED] T3 uncaught read in a live effect: g.set(1) throws E, log ['idle'], eR 2; s.set(2) re-runs it on the new value (PROBE)", () => {
        const r = createRegistry(); const { s, c, st } = c1(r); const g = r.signal(0); const log = []; let eR = 0;
        r.effect(() => { eR++; if (g() > 0) log.push(c()); else log.push("idle"); });
        assert.equal(thrown(() => g.set(1)), E);
        assert.deepEqual(log, ["idle"]);
        assert.equal(eR, 2);
        assert.equal(st.runs, 1);
        assert.equal(thrown(() => s.set(2)), NOBODY);
        assert.deepEqual(log, ["idle", 20]);
        assert.equal(eR, 3);
        assert.equal(st.runs, 2);
        assert.equal(snapOk(r), true);
    });

    it("[RED] T3s deferred-scheduler reader: t() throws E (the cached error), the log stays empty, snapshot ok; s.set(2) schedules a run that logs 20 (PROBE)", () => {
        const r = createRegistry(); const { s, c, st } = c1(r); const log = []; let pending = null;
        r.effect(() => { log.push(c()); }, { scheduler: (t) => { pending = t; } });
        const t0 = pending; assert.equal(typeof t0, "function");
        pending = null;
        assert.equal(thrown(() => t0()), E);
        assert.deepEqual(log, []);
        assert.equal(st.runs, 1);
        assert.equal(snapOk(r), true);
        s.set(2);
        assert.equal(typeof pending, "function");
        assert.equal(thrown(() => pending()), NOBODY);
        assert.deepEqual(log, [20]);
    });

    it("[RED] T5 snapshot of the T1 state restores identically; restored and live d are both 20 after s.set(2) (rv173-paths A8)", () => {
        const r = createRegistry(); const { s, c } = c1(r);
        const d = r.computed(() => { try { return c(); } catch { return "E"; } });
        assert.equal(d(), "E");
        const snap = r.snapshot();
        const sId = r.nodeId(s), cId = r.nodeId(c), dId = r.nodeId(d);
        const H = {};
        const r2 = r.restore(snap, { fnsById: { [cId]: () => H[sId]() * 10, [dId]: () => { try { return H[cId](); } catch { return "E"; } } }, handles: H });
        assert.ok(sameJson(r2.snapshot(), snap));
        H[sId].set(2);
        assert.equal(H[dId](), 20);
        s.set(2);
        assert.equal(d(), 20);
    });

    it("[RED] U1 effect reading c inside untrack (catching): log [E], eR 1, c.runs 1 (the first read ran the body); c() is still E (PROBE)", () => {
        const r = createRegistry(); const { c, st } = c1(r); const log = []; let eR = 0;
        r.effect(() => { eR++; log.push(r.untrack(() => { try { return c(); } catch { return "E"; } })); });
        assert.deepEqual(log, ["E"]);
        assert.equal(eR, 1);
        assert.equal(st.runs, 1);
        assert.equal(thrown(() => c()), E);
        assert.deepEqual(log, ["E"]);
        assert.equal(eR, 1);
    });

    it("[RED] K1 effect reading c.peek() (catching): log [E], eR 1, c.runs 1 (PROBE)", () => {
        const r = createRegistry(); const { c, st } = c1(r); const log = []; let eR = 0;
        r.effect(() => { eR++; try { log.push(c.peek()); } catch { log.push("E"); } });
        assert.deepEqual(log, ["E"]);
        assert.equal(eR, 1);
        assert.equal(st.runs, 1);
    });

    it("[RED] L1 c2's body throws E2 on top of the pre-run E: d sees AggregateError [E, E2] (cached, same object); a write leaves E2 alone (PROBE)", () => {
        const r = createRegistry(); const s = r.signal(1); const st = { runs: 0 }; let dR = 0;
        const c2 = r.computed(() => { st.runs++; s(); throw E2; });
        r.runWithOwner(c2, () => r.onCleanup(() => { throw E; }));
        const d = r.computed(() => { dR++; try { return c2(); } catch (e) { return e; } });
        const first = d();
        assertAgg(first, [E, E2]);
        assert.equal(dR, 1);
        assert.equal(st.runs, 1);
        assert.equal(d(), first);
        s.set(2);
        assert.equal(d(), E2);                // the cleanup list was consumed: only the body error remains
        assert.equal(dR, 2);
        assert.equal(st.runs, 2);
    });

    // PROBE (D6 + hand check): d's re-run pre-walk pulls c FIRST (c's list was consumed at the first read, so c's body runs: 20),
    // then d re-arms c; the next write finds the re-armed cleanup on an EVALUATED c, so the r3 core rule applies:
    // E is cached and c's body is skipped (c.runs stays 2). Bounded: no cycle, no leak.
    it("[RED] L2c a computed d that re-arms c on every run terminates: E, 20, E, E; dR 1..4, c.runs 1, 2, 2, 2 (PROBE)", () => {
        const r = createRegistry(); const { s, c, st } = c1(r); let dR = 0;
        const d = r.computed(() => {
            dR++;
            r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
            try { return c(); } catch { return "E"; }
        });
        const seen = [];
        seen.push([d(), dR, st.runs]);
        s.set(2); seen.push([d(), dR, st.runs]);
        s.set(3); seen.push([d(), dR, st.runs]);
        s.set(4); seen.push([d(), dR, st.runs]);
        assert.deepEqual(seen, [["E", 1, 1], [20, 2, 2], ["E", 3, 2], ["E", 4, 2]]);
        assert.equal(snapOk(r), true);
    });

    it("[RED] L2e Pd: an effect re-arming c on every run: creates ok, set 2 ok, set 3 ok; log [E,E,E]; c.runs 1; snapshot ok (maxFlushPasses 3)", () => {
        const r = createRegistry({ maxFlushPasses: 3 }); const s = r.signal(1); const log = []; let runs = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        const arm = () => r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
        arm();
        assert.equal(thrown(() => r.effect(() => { try { log.push(c()); } catch (e) { log.push(e === E ? "E" : "?"); } arm(); })), NOBODY);
        assert.equal(thrown(() => s.set(2)), NOBODY);
        assert.equal(thrown(() => s.set(3)), NOBODY);
        assert.deepEqual(log, ["E", "E", "E"]);
        assert.equal(runs, 1);
        assert.equal(snapOk(r), true);
    });

    // ---- the 2^30 version band and gv seeding (rv174-band.mjs / attack2.mjs band pre-walk) ----
    for (const gv of [null, 0x40000010, 0x7FFFFF00]) {
        const label = gv === null ? "default" : "0x" + (gv >>> 0).toString(16);
        it("[RED] BAND gv " + label + ": catching d of a never-run c reads E, 20, 30 and c.runs 3, snapshot ok (no clean short-circuit at any band)", () => {
            const r = seeded(gv);
            const { s, c, st } = c1(r);
            const d = r.computed(() => { try { return c(); } catch { return "E"; } });
            const a = [d()]; s.set(2); a.push(d()); s.set(3); a.push(d());
            assert.deepEqual(a, ["E", 20, 30]);
            assert.equal(st.runs, 3);
            assert.equal(snapOk(r), true);
        });
        it("[RED] BAND gv " + label + " effect reader: log [E, 20], c.runs 2; restore-wired pre-walk: d reads 10, E, 30 and c.runs 2, snapshot ok", () => {
            const r2 = seeded(gv); const { s: s2, c: c2, st: st2 } = c1(r2); const log = [];
            r2.effect(() => { try { log.push(c2()); } catch { log.push("E"); } });
            s2.set(2);
            assert.deepEqual(log, ["E", 20]);
            assert.equal(st2.runs, 2);
            // pre-walk (attack2.mjs): c is restored as a never-evaluated record under an evaluated d
            const r = seeded(gv); const s = r.signal(1); const c = r.computed(() => s() * 10);
            const d = r.computed(() => { try { return c(); } catch { return "E"; } }); d();
            const sId = r.nodeId(s), cId = r.nodeId(c), dId = r.nodeId(d);
            const snap = r.snapshot();
            const rc = snap.nodes.find((n) => n.id === cId);
            rc.version = 0; rc.evalVersion = 0; rc.clean = false; delete rc.value; rc.flags = rc.flags & ~16;
            const H = {}; let runs = 0;
            const rr = r.restore(snap, { fnsById: { [cId]: () => { runs++; return H[sId]() * 10; }, [dId]: () => { try { return H[cId](); } catch { return "E"; } } }, handles: H });
            rr.runWithOwner(H[cId], () => rr.onCleanup(() => { throw E; }));
            const a = [H[dId]()]; H[sId].set(2); a.push(H[dId]()); H[sId].set(3); a.push(H[dId]());
            assert.deepEqual(a, [10, "E", 30]);
            assert.equal(runs, 2);
            assert.equal(snapOk(rr), true);
        });
    }

    // ---- several errors ----
    it("[RED] MULTI rv174-multi: c with a throwing child computed (E2) and its own E: d sees Agg [E2, E] (disposal order, O-b176-1), then 20, 30; c.runs 3", () => {
        const r = createRegistry(); const s = r.signal(1); const st = { runs: 0 };
        const c = r.computed(() => { st.runs++; return s() * 10; });
        r.runWithOwner(c, () => { const k = r.computed(() => 0); r.runWithOwner(k, () => r.onCleanup(() => { throw E2; })); r.onCleanup(() => { throw E; }); });
        const d = r.computed(() => { try { return c(); } catch (e) { return e; } });
        const first = d();
        assertAgg(first, [E2, E]);
        s.set(2); assert.equal(d(), 20);
        s.set(3); assert.equal(d(), 30);
        assert.equal(st.runs, 3);
        assert.equal(snapOk(r), true);
    });

    it("[RED] MULTI effect reader of the same c: log [Agg [E2, E], 20], c.runs 2", () => {
        const r = createRegistry(); const s = r.signal(1); const st = { runs: 0 }; const log = [];
        const c = r.computed(() => { st.runs++; return s() * 10; });
        r.runWithOwner(c, () => { const k = r.computed(() => 0); r.runWithOwner(k, () => r.onCleanup(() => { throw E2; })); r.onCleanup(() => { throw E; }); });
        r.effect(() => { try { log.push(c()); } catch (e) { log.push(e); } });
        s.set(2);
        assert.equal(log.length, 2);
        assertAgg(log[0], [E2, E]);
        assert.equal(log[1], 20);
        assert.equal(st.runs, 2);
    });

    it("[RED] PE two owned throwing child effects (E then E2 adopted): c() Agg [E2, E] twice (same object), then 20; runs 2, effects 2 (#56 orphans), snapshot ok", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        r.runWithOwner(c, () => { r.effect(() => { r.onCleanup(() => { throw E; }); }); r.effect(() => { r.onCleanup(() => { throw E2; }); }); });
        const a = thrown(() => c());
        assertAgg(a, [E2, E]);
        assert.equal(thrown(() => c()), a);
        s.set(2);
        assert.equal(c(), 20);
        assert.equal(runs, 2);
        assert.equal(r.stats().effects, 2);   // PROBE: both orphans stay live (LEDGER #56)
        assert.equal(snapOk(r), true);
    });

    it("[RED] PF deferred effect whose body also throws E2: t() Agg [E, E2], snapshot ok, runs 1; after s.set(2) t2 throws E2 alone, runs 2", () => {
        const r = createRegistry(); const s = r.signal(1); let t = null, runs = 0;
        const h = r.effect(() => { runs++; s(); throw E2; }, { scheduler: (f) => { t = f; } });
        r.runWithOwner(h, () => r.onCleanup(() => { throw E; }));
        assertAgg(thrown(() => t()), [E, E2]);
        assert.equal(runs, 1);
        assert.equal(snapOk(r), true);
        assert.equal(thrown(() => s.set(2)), NOBODY);
        assert.equal(thrown(() => t()), E2);
        assert.equal(runs, 2);
    });

    it("[RED] S6 computed whose body throws E2 after the pre-run E: c() Agg [E, E2] twice (same object), then 20 after a write; runs 2", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0;
        const c = r.computed(() => { runs++; if (s() === 1) throw E2; return s() * 10; });
        r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
        const a = thrown(() => c());
        assertAgg(a, [E, E2]);
        assert.equal(thrown(() => c()), a);
        s.set(2);
        assert.equal(c(), 20);
        assert.equal(runs, 2);
        assert.equal(snapOk(r), true);
    });

    // ---- cap (maxFlushPasses) ----
    it("[RED] CAP a child that re-adopts a throwing child every time: Agg of 101 (100 x E + the CycleError text), calls 100, runs 1, effects 101", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0, calls = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        const mk = () => r.runWithOwner(c, () => r.effect(() => { r.onCleanup(() => { calls++; if (calls < 1e6) mk(); throw E; }); }));
        mk();
        const a = thrown(() => c());
        assert.ok(a instanceof AggregateError);
        assert.equal(a.errors.length, 101);
        for (let i = 0; i < 100; i++) assert.equal(a.errors[i], E, "errors[" + i + "]");
        assert.ok(a.errors[100] instanceof Error);
        assert.equal(a.errors[100].message, CYCLE_TEXT);
        assert.equal(calls, 100);
        assert.equal(runs, 1);
        assert.equal(r.stats().effects, 101);
    });

    it("[RED] CAP5 maxFlushPasses 5, child re-adopts until K = 8: calls 5, errors 6 (5 x E + CycleError), runs 1 (PROBE)", () => {
        const r = createRegistry({ maxFlushPasses: 5 }); const s = r.signal(1); let runs = 0, calls = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        const mk = () => r.runWithOwner(c, () => r.effect(() => { r.onCleanup(() => { calls++; if (calls < 8) mk(); throw E; }); }));
        mk();
        const a = thrown(() => c());
        assert.ok(a instanceof AggregateError);
        assert.equal(a.errors.length, 6);
        for (let i = 0; i < 5; i++) assert.equal(a.errors[i], E, "errors[" + i + "]");
        assert.equal(a.errors[5].message, CYCLE_TEXT);
        assert.equal(calls, 5);
        assert.equal(runs, 1);
    });

    it("[RED] CAPN3 150 finite throwing kids + an own cleanup: c() Agg of 101, kidsRun 100, own 0; then one kid per write (PROBE)", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0, own = 0, kids = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        const e0 = r.stats().effects;
        r.runWithOwner(c, () => { for (let i = 0; i < 150; i++) r.effect(() => { r.onCleanup(() => { kids++; throw E; }); }); r.onCleanup(() => { own++; }); });
        const a = thrown(() => c());
        assert.ok(a instanceof AggregateError);
        assert.equal(a.errors.length, 101);
        assert.equal(a.errors[100].message, CYCLE_TEXT);
        assert.equal(kids, 100);
        assert.equal(own, 0);
        assert.equal(r.stats().effects - e0, 150);
        assert.equal(runs, 1);
        s.set(2);
        assert.equal(thrown(() => c()), E);
        assert.equal(kids, 101);
        assert.equal(own, 0);
        s.set(3);
        assert.equal(thrown(() => c()), E);
        assert.equal(kids, 102);
        assert.equal(own, 0);
    });

    // ---- re-armed and self-attaching cleanups ----
    it("[RED] REARM S2b: a non-throwing self-re-arming cleanup beside a throwing one: c() E, fCalls 1; after a write c() 20, fCalls 2, runs 2", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0, calls = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        const f = () => { calls++; r.runWithOwner(c, () => r.onCleanup(f)); };
        r.runWithOwner(c, () => { r.onCleanup(f); r.onCleanup(() => { throw E; }); });
        assert.equal(thrown(() => c()), E);
        assert.equal(calls, 1);
        s.set(2);
        assert.equal(c(), 20);
        assert.equal(calls, 2);
        assert.equal(runs, 2);
    });

    // PARITY: no throw, so the normal path runs (identical on every build).
    it("[PARITY] REARM S2c control (no throw): a self-re-arming cleanup alone: c() 10, fCalls 1, runs 1", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0, calls = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        const f = () => { calls++; r.runWithOwner(c, () => r.onCleanup(f)); };
        r.runWithOwner(c, () => r.onCleanup(f));
        assert.equal(c(), 10);
        assert.equal(calls, 1);
        assert.equal(runs, 1);
    });

    it("[RED] SELF S2 a throwing self-re-attaching cleanup (computed): c() E, calls 1, runs 1 (no recursion through the first body)", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0, calls = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        const f = () => { calls++; r.runWithOwner(c, () => r.onCleanup(f)); throw E; };
        r.runWithOwner(c, () => r.onCleanup(f));
        assert.equal(thrown(() => c()), E);
        assert.equal(calls, 1);
        assert.equal(runs, 1);
    });

    it("[RED] SELF S2e a throwing self-re-attaching cleanup (deferred effect): t() E, calls 1, runs 1, queue empty, snapshot ok", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0, calls = 0; const q = [];
        const h = r.effect(() => { runs++; s(); }, { scheduler: (t) => q.push(t) });
        const f = () => { calls++; r.runWithOwner(h, () => r.onCleanup(f)); throw E; };
        r.runWithOwner(h, () => r.onCleanup(f));
        assert.equal(thrown(() => q.shift()()), E);
        assert.equal(calls, 1);
        assert.equal(runs, 1);
        assert.equal(q.length, 0);
        assert.equal(snapOk(r), true);
    });

    it("[RED] SELF S2x disarmed afterwards: 1st read E (calls 1), 2nd E, after s.set(2) E again (the re-armed f throws), runs 1, snapshot ok", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0, calls = 0, armed = true;
        const c = r.computed(() => { runs++; return s() * 10; });
        const f = () => { calls++; if (armed) r.runWithOwner(c, () => r.onCleanup(f)); throw E; };
        r.runWithOwner(c, () => r.onCleanup(f));
        assert.equal(thrown(() => c()), E);
        assert.equal(calls, 1);
        armed = false;
        assert.equal(thrown(() => c()), E);
        s.set(2);
        assert.equal(thrown(() => c()), E);
        assert.equal(runs, 1);
        assert.equal(snapOk(r), true);
    });

    // ---- dispose from inside the drain ----
    it("[R0] S1 a cleanup that disposes its own computed then throws: c() returns undefined, the body never ran, snapshot ok", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        r.runWithOwner(c, () => r.onCleanup(() => { r.dispose(c); throw E; }));
        assert.equal(thrown(() => c()), NOBODY);
        assert.equal(runs, 0);
        assert.equal(snapOk(r), true);
    });

    it("[PARITY] S1e a cleanup that disposes its own deferred effect then throws: t() E, runs 0, effects 0, snapshot ok", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0; const q = [];
        const h = r.effect(() => { runs++; s(); }, { scheduler: (t) => q.push(t) });
        r.runWithOwner(h, () => r.onCleanup(() => { h(); throw E; }));
        assert.equal(thrown(() => q.shift()()), E);
        assert.equal(runs, 0);
        assert.equal(r.stats().effects, 0);
        assert.equal(snapOk(r), true);
    });

    // AUD-E1 r2 T5 (kills mutant effUngated: rerunCleanupEffect's gen gate forced true; the S1e row above does not write the
    // dependency, so it never reached the gate). Shape = the b177 witness DEADe: a RE-RUN cleanup that WRITES the effect's own
    // dependency, DISPOSES its own effect, then throws E. Contract: the write surfaces E itself (not an AggregateError, no
    // "computeFn is not a function" from a body-less re-queue), the body ran once (creation) and never again, stats().effects
    // 0, and later writes run nothing. Values PROBED on r2 (ca39e1f4) and on frozen 17ac945 -- identical there, so [PARITY]
    // (a regression pin on a gate the S1 fix added): s 6 (5 + the cleanup's write 5 + 1), a fresh effect on the recycled slot
    // runs exactly once per write (creation + one t.set = 2) and the registry holds s, t and that effect only (nodes 3, links 2).
    it("[PARITY] S1e2 a re-run cleanup that writes its own dep, disposes its own effect, then throws: the write throws E itself, body runs 1, effects 0, later writes run nothing, a new effect runs once per write", () => {
        const r = createRegistry(); const s = r.signal(0); let h = null, bodies = 0;
        h = r.effect(() => { bodies++; s(); r.onCleanup(() => { s.set(s.peek() + 1); r.dispose(h); throw E; }); });
        assert.equal(bodies, 1);
        assert.equal(thrown(() => s.set(5)), E);
        assert.equal(bodies, 1);
        assert.equal(r.stats().effects, 0);
        assert.equal(s.peek(), 6);
        assert.equal(thrown(() => s.set(9)), NOBODY);
        assert.equal(bodies, 1);
        let runs = 0; const t = r.signal(0);
        r.effect(() => { runs++; t(); s(); });
        t.set(1);
        assert.equal(runs, 2);
        const st = r.stats();
        assert.equal(st.effects, 1);
        assert.equal(st.activeNodes, 3);
        assert.equal(st.activeLinks, 2);
    });

    it("[RED] SD a reader that disposes itself then reads c (computed half): d() undefined, c() E (cached); effect half: eR 2, cR 1, effects delta 0", () => {
        const r = createRegistry(); const s = r.signal(1); let cR = 0, dR = 0;
        const c = r.computed(() => { cR++; return s() * 10; });
        r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
        let d;
        d = r.computed(() => { dR++; r.dispose(d); try { return c(); } catch { return "E"; } });
        assert.equal(d(), undefined);         // a disposed computed reads undefined (PROBE)
        assert.equal(dR, 1);
        assert.equal(cR, 1);
        assert.equal(thrown(() => c()), E);
        assert.equal(cR, 1);
        // effect half
        const r2 = createRegistry(); const s2 = r2.signal(1); let cR2 = 0, eR = 0;
        const c2 = r2.computed(() => { cR2++; return s2() * 10; });
        r2.runWithOwner(c2, () => r2.onCleanup(() => { throw E; }));
        const g = r2.signal(0); const base = r2.stats().effects; let stop = null;
        stop = r2.effect(() => { eR++; if (g() > 0) { stop(); try { c2(); } catch { /* cached E */ } } });
        assert.equal(thrown(() => g.set(1)), NOBODY);
        assert.equal(eR, 2);
        assert.equal(cR2, 1);
        assert.equal(r2.stats().effects - base, 0);
        assert.equal(thrown(() => c2()), E);
        assert.equal(snapOk(r2), true);
    });

    // ---- A7 on the first run: the entries after a throwing one are dropped ----
    it("[RED] A7D own list [throw, record]: c() E on the first read", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0;
        const c = r.computed(() => { runs++; return s() * 10; });
        r.runWithOwner(c, () => { r.onCleanup(() => { throw E; }); r.onCleanup(() => { /* dropped */ }); });
        assert.equal(thrown(() => c()), E);
        assert.equal(runs, 1);
    });
    // PARITY count: the dropped 2nd entry never runs (identical on every build, A7).
    it("[PARITY] A7D the dropped 2nd entry never runs, not at the first read and not at dispose (ranFirst 0, ranEver 0)", () => {
        const r = createRegistry(); const s = r.signal(1); let rec2 = 0;
        const c = r.computed(() => s() * 10);
        r.runWithOwner(c, () => { r.onCleanup(() => { throw E; }); r.onCleanup(() => { rec2++; }); });
        thrown(() => c());
        assert.equal(rec2, 0);
        r.dispose(c);
        assert.equal(rec2, 0);
    });

    // ---- reads in batch / flush ----
    it("[RED] S4a read in a batch: E, then 20 (after s.set(2) in the batch), then 20; runs 2, snapshot ok", () => {
        const r = createRegistry(); const { s, c, st } = c1(r); const out = [];
        r.batch(() => {
            out.push(thrown(() => c()));
            s.set(2);
            out.push(thrown(() => c()) === NOBODY ? c() : "?");
        });
        out.push(c());
        assert.equal(out[0], E);
        assert.deepEqual(out.slice(1), [20, 20]);
        assert.equal(st.runs, 2);
        assert.equal(snapOk(r), true);
    });

    it("[RED] S4c read inside an effect during a flush: log [E, 20, 30], c.runs 3, snapshot ok", () => {
        const r = createRegistry(); const { s, c, st } = c1(r); const x = r.signal(0); const log = [];
        r.effect(() => { if (x() > 0) { try { log.push(c()); } catch (e) { log.push(e === E ? "E" : "?"); } } });
        x.set(1); s.set(2); s.set(3);
        assert.deepEqual(log, ["E", 20, 30]);
        assert.equal(st.runs, 3);
        assert.equal(snapOk(r), true);
    });

    // PARITY-r3: a plain effect created inside a batch (S5c), the cleanup attached before the batch flushes it.
    it("[PARITY] S5c plain effect created in a batch with a throwing pre-run cleanup: the batch ends clean, snapshot ok, then s.set(2) throws E; log [1], runs 1, effects 1", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0; const log = [];
        assert.equal(thrown(() => r.batch(() => {
            const h = r.effect(() => { runs++; log.push(s()); });
            r.runWithOwner(h, () => r.onCleanup(() => { throw E; }));
        })), NOBODY);
        assert.equal(snapOk(r), true);
        assert.equal(thrown(() => s.set(2)), E);
        assert.deepEqual(log, [1]);
        assert.equal(runs, 1);
        assert.equal(r.stats().effects, 1);
    });

    // ---- sync scheduler during creation (rv174-syncsched) ----
    it("[RED] SY1 sync-scheduler effect whose first run reads c: effect() throws E, log [], c.runs 1, no effect left; s.set(2) logs nothing", () => {
        const r = createRegistry(); const { s, c, st } = c1(r); const log = [];
        const eff0 = r.stats().effects;
        assert.equal(thrown(() => r.effect(() => { log.push(c()); }, { scheduler: (t) => t() })), E);
        assert.deepEqual(log, []);
        assert.equal(st.runs, 1);
        assert.equal(r.stats().effects - eff0, 0);
        s.set(2);
        assert.deepEqual(log, []);
    });

    it("[RED] SY1b same, c's body throws E2 too: effect() throws Agg [E, E2], log [], c.runs 1, no effect left", () => {
        const r = createRegistry(); const s = r.signal(1); let runs = 0; const log = [];
        const c = r.computed(() => { runs++; throw E2; });
        r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
        const eff0 = r.stats().effects;
        assertAgg(thrown(() => r.effect(() => { log.push(c()); }, { scheduler: (t) => t() })), [E, E2]);
        assert.deepEqual(log, []);
        assert.equal(runs, 1);
        assert.equal(r.stats().effects - eff0, 0);
        s.set(2);
        assert.deepEqual(log, []);
    });

    it("[RED] T3c an effect whose FIRST run reads c: effect() throws E, log [], no effect left, c.runs 1; c() is still E", () => {
        const r = createRegistry(); const { c, st } = c1(r); const log = []; const before = r.stats().effects;
        assert.equal(thrown(() => r.effect(() => log.push(c()))), E);
        assert.deepEqual(log, []);
        assert.equal(st.runs, 1);
        assert.equal(r.stats().effects, before);
        assert.equal(thrown(() => c()), E);
    });

    // ---- a constant computed: nothing can wake it (D-b175-3) ----
    it("[RED] DEPLESS dep-less computed: E, E, runs 1, snapshot ok; still E after unrelated writes; dispose does not throw", () => {
        const r = createRegistry(); let runs = 0; const u = r.signal(0);
        const c = r.computed(() => { runs++; return 7; });
        r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
        assert.equal(thrown(() => c()), E);
        assert.equal(thrown(() => c()), E);
        assert.equal(runs, 1);
        assert.equal(snapOk(r), true);
        u.set(1); u.set(2);
        assert.equal(thrown(() => c()), E);
        assert.equal(runs, 1);
        assert.equal(thrown(() => r.dispose(c)), NOBODY);
    });

    it("[RED] DEPLESS QUIET computed on a never-written signal: E, E, runs 1 until a write, then the value", () => {
        const r = createRegistry(); const s = r.signal(3); let runs = 0;
        const c = r.computed(() => { runs++; return s(); });
        r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
        assert.equal(thrown(() => c()), E);
        assert.equal(thrown(() => c()), E);
        assert.equal(runs, 1);
        s.set(4);
        assert.equal(c(), 4);
        assert.equal(runs, 2);
    });

    // ---- ST1: the first body suffers a stale read (a write by ANOTHER node to a dep it already read) ----
    // NOSTAMP (dropping the stamps in firstRunCleanupC) is declared EQUIVALENT: refreshComputed stores version = gv on a first eval
    // (evalVersion 0 forces the store), its finally stores evalVersion = gv, a stale re-pull re-stamps both inside runFirstBody, and no
    // user code runs between that last stamp and firstRunCleanupC's. This row pins the stale re-pull values only.
    // PROBE (D6): the body runs twice inside the first run (computedRunTail's stale re-pull, an existing rule, not a second
    // drain); the re-pull disposes the child effect; the cached E is stamped current, so reads 1 and 2 are E without a 3rd run.
    it("[RED] ST1 c's first body reads w, then a child effect writes w (stale read): c() E, E; runs 2 (the stale re-pull), effects 0; w.set(7) -> 7, runs 3, snapshot ok (PROBE)", () => {
        const r = createRegistry(); const w = r.signal(0); let runs = 0;
        const c = r.computed(() => { runs++; const v = w(); if (runs === 1) r.effect(() => { w.set(5); }); return v; });
        r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
        assert.equal(thrown(() => c()), E);
        assert.equal(thrown(() => c()), E);
        assert.equal(runs, 2);
        assert.equal(r.stats().effects, 0);
        w.set(7);
        assert.equal(c(), 7);
        assert.equal(runs, 3);
        assert.equal(snapOk(r), true);
    });

    // Reviewer r1 (recycle.mjs): the one-shot skip must not leak onto a RECYCLED slot. Mutant BOTHSKIP drops the skip test's
    // consume, so c2 (same node object) loses its pre-run cleanup: log f,c-body,f,c2-body.
    it("[RED] SKIPRECYCLE a disposed node's slot is recycled: c2's non-throwing pre-run cleanup still runs before its body; log [f, c-body, f, c2-pre, c2-body]", () => {
        const r = createRegistry(); const s = r.signal(1); const log = [];
        const c = r.computed(() => { log.push("c-body"); return s(); });
        const f = () => { log.push("f"); r.runWithOwner(c, () => r.onCleanup(f)); };
        r.runWithOwner(c, () => { r.onCleanup(f); r.onCleanup(() => { throw E; }); });
        assert.equal(thrown(() => c()), E);
        r.dispose(c);                                   // depth 0: the slot is freed (the dispose runs the re-armed f)
        const c2 = r.computed(() => { log.push("c2-body"); return 2; });
        r.runWithOwner(c2, () => r.onCleanup(() => log.push("c2-pre")));
        assert.equal(c2(), 2);
        assert.deepEqual(log, ["f", "c-body", "f", "c2-pre", "c2-body"]);
    });

    // ---- TT1: throw-through runFirstBody's try / finally ----
    it("[RED] TT1 body throws E2 after a pre-run E with a re-armed cleanup f: c() Agg [E, E2], fCalls 1; s.set(2) -> fCalls 2, value 20; a 2nd never-run c2 runs pre, body", () => {
        const r = createRegistry(); const s = r.signal(1); let fCalls = 0, runs = 0;
        const c = r.computed(() => { runs++; if (s() === 1) throw E2; return s() * 10; });
        const f = () => { fCalls++; r.runWithOwner(c, () => r.onCleanup(f)); };
        r.runWithOwner(c, () => { r.onCleanup(f); r.onCleanup(() => { throw E; }); });
        assertAgg(thrown(() => c()), [E, E2]);
        assert.equal(fCalls, 1);
        s.set(2);
        assert.equal(c(), 20);
        assert.equal(fCalls, 2);
        // a second never-run computed with a non-throwing pre-run cleanup: the one-shot skip did not leak onto it
        const log = []; const c2 = r.computed(() => { log.push("body"); return 1; });
        r.runWithOwner(c2, () => r.onCleanup(() => log.push("pre")));
        assert.equal(c2(), 1);
        assert.deepEqual(log, ["pre", "body"]);
    });

    it("[RED] TT1e same for a deferred effect (the body error propagates through runFirstBody): t() Agg [E, E2], fCalls 1; after s.set(2) the run is clean, fCalls 2", () => {
        const r = createRegistry(); const s = r.signal(1); let fCalls = 0, runs = 0; let t = null;
        const h = r.effect(() => { runs++; if (s() === 1) throw E2; }, { scheduler: (f) => { t = f; } });
        const f = () => { fCalls++; r.runWithOwner(h, () => r.onCleanup(f)); };
        r.runWithOwner(h, () => { r.onCleanup(f); r.onCleanup(() => { throw E; }); });
        assertAgg(thrown(() => t()), [E, E2]);
        assert.equal(fCalls, 1);
        assert.equal(runs, 1);
        s.set(2);
        assert.equal(thrown(() => t()), NOBODY);
        assert.equal(fCalls, 2);
        assert.equal(runs, 2);
        // a second never-run effect with a non-throwing pre-run cleanup
        const log = []; let t2 = null;
        const h2 = r.effect(() => { log.push("body"); }, { scheduler: (f2) => { t2 = f2; } });
        r.runWithOwner(h2, () => r.onCleanup(() => log.push("pre")));
        t2();
        assert.deepEqual(log, ["pre", "body"]);
    });

    // F1 RE-RULED by D-AUD-5 (S3, b177; was a PARITY row: g.set throws E2, xR 2, a 1 on r4 / r5 / 17ac945 c8f6cd1e, so this
    // row is RED there). "A throwing effect body that saw a mid-run write is re-queued": every run creates a child that writes
    // a (stale read) and throws E2, so every run re-queues itself; the flush stops at maxFlushPasses (100) with its CycleError
    // (the buffered E2s are dropped, as at every pass cap). Measured on c0c123a1: xR 101 (1 creation + 100 passes), a 100.
    it("[RED] F1 D-AUD-5 body-error contract: a throwing body that writes via a child effect is re-queued every run -> g.set throws CycleError 'flush passes exceeded', xR 101, a 100", () => {
        const r = createRegistry(); const a = r.signal(0), g = r.signal(0); let xR = 0;
        r.effect(() => {
            xR++; a();
            if (g() > 0) { r.effect(() => a.set(a.peek() + 1)); throw E2; }
        });
        const e = thrown(() => g.set(1));
        assert.ok(e instanceof Error && !(e instanceof AggregateError), "thrown " + e);
        assert.equal(e.message, "CycleError: flush passes exceeded");   // frozen 17ac945: E2
        assert.equal(xR, 101);                 // frozen: 2; errTailNoDepWalk: differs
        assert.equal(a.peek(), 100);           // frozen: 1
    });

    // ---- PARITY rows: non-throwing pre-run attaches behave exactly as before (fc-props Pa Pb Pc Pi Pj) ----
    it("[PARITY] Pa PARITY non-throwing pre-run cleanup on c: order pre, body1, cl1, body2", () => {
        const r = createRegistry(); const s = r.signal(1); const log = []; let n = 0;
        const c = r.computed(() => { const k = ++n; log.push("body" + k); r.onCleanup(() => log.push("cl" + k)); return s(); });
        r.runWithOwner(c, () => r.onCleanup(() => log.push("pre"))); c(); s.set(2); c();
        assert.deepEqual(log, ["pre", "body1", "cl1", "body2"]);
    });

    it("[PARITY] Pb PARITY an owned child attached before c's first run is disposed at c's first evaluation (childRuns 1, 1; effects 0)", () => {
        const r = createRegistry(); const s = r.signal(1), x = r.signal(0); let childRuns = 0;
        const c = r.computed(() => s());
        r.runWithOwner(c, () => r.effect(() => { x(); childRuns++; })); c(); x.set(1);
        assert.equal(childRuns, 1);
        s.set(2); c(); x.set(2);
        assert.equal(childRuns, 1);
        assert.equal(r.stats().effects, 0);
    });

    it("[PARITY] Pc PARITY deferred effect, non-throwing pre-run cleanup: order pre, body1, cl, body2", () => {
        const r = createRegistry(); const s = r.signal(1); const log = []; let t = null;
        const stop = r.effect(() => { log.push("body" + s()); r.onCleanup(() => log.push("cl")); }, { scheduler: (f) => { t = f; } });
        r.runWithOwner(stop, () => r.onCleanup(() => log.push("pre"))); t(); s.set(2); t();
        assert.deepEqual(log, ["pre", "body1", "cl", "body2"]);
    });

    it("[PARITY] Pi PARITY dispose of a never-run c with a throwing cleanup: the 1st dispose throws E, the 2nd completes (computeds 0)", () => {
        const r = createRegistry(); const s = r.signal(1); const c = r.computed(() => s());
        r.runWithOwner(c, () => r.onCleanup(() => { throw E; }));
        assert.equal(thrown(() => r.dispose(c)), E);
        assert.equal(thrown(() => r.dispose(c)), NOBODY);
        assert.equal(r.stats().computeds, 0);
    });

    it("[PARITY] Pj PARITY runWithOwner onto a never-run effect that attaches nothing: log [1, cl, 2], effect record flags 2", () => {
        const r = createRegistry(); const s = r.signal(1); let t = null; const log = [];
        const stop = r.effect(() => { log.push(s()); r.onCleanup(() => log.push("cl")); }, { scheduler: (f) => { t = f; } });
        r.runWithOwner(stop, () => {}); t();
        const eff = r.snapshot().nodes.find((n) => (n.flags & 2) !== 0);
        s.set(2); t();
        assert.deepEqual(log, [1, "cl", 2]);
        assert.equal(eff.flags, 2);
    });
});

// ---- NR-GC (D-A6): after a body-first first run, 1e5 re-runs with a hoisted non-throwing cleanup stay zero-GC ----

const CHILD_NR = `
import { measureWindows } from ${JSON.stringify(HEAP_WINDOW)};
import { createRegistry } from ${JSON.stringify(SIGNAL_URL)};
for (const f of ${JSON.stringify(A8_FLAGS)}) {
    if (!process.execArgv.includes(f)) { console.error("NR-GC child: " + f + " is not in execArgv"); process.exit(3); }
}
const N = 100000, WARM = 4, CYC = 12;
const cb = () => {};
const boom = new Error("boom");
const th = () => { throw boom; };
let SINK = null;
function make(control) {
    const r = createRegistry();
    const p = r.signal(0);
    const c = r.computed(() => { r.onCleanup(cb); return p(); });
    r.runWithOwner(c, () => r.onCleanup(th));
    let first = null;
    try { c(); } catch (e) { first = e; }       // the body-first first run: c caches boom
    let k = 1;
    return () => {
        for (let i = 0; i < N; i++) { p.set(k++); c(); if (control) SINK = [i, k]; }
    };
}
const real = await measureWindows(make(false), { warmup: WARM, cycles: CYC });
const ctl = await measureWindows(make(true), { warmup: WARM, cycles: CYC });
console.log("RESULT " + JSON.stringify({ N, real, ctl, sinkSet: SINK !== null }));
`;

// CI class 16 (b178, FILLER 222): this child used to spawn with only --expose-gc + --max-semi-space-size=1; on CI 42291560302 (43d2fa3)
// ubuntu node 24 and macOS node 24, and macOS node 24 on 42177925587 (17ac945), it failed `clean windows 0` while the A8 row (A8_FLAGS)
// stayed green. Same flags and the same fail-closed execArgv self-check (exit 3) as A8 / CHILD_S1.
function runChildNr(flags) {
    const res = spawnSync(process.execPath, [...A8_FLAGS, ...flags, "--input-type=module", "-e", CHILD_NR], {
        encoding: "utf8", timeout: 120000, killSignal: "SIGKILL",
    });
    assert.equal(res.error, undefined, "spawn error: " + (res.error && res.error.message));
    assert.equal(res.signal, null, "child killed by " + res.signal);
    assert.equal(res.status, 0, "child status " + res.status + "\n" + res.stderr);
    const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, "no RESULT line:\n" + res.stdout + res.stderr);
    return JSON.parse(line.slice(7));
}

describe("FIX-CL-D NR-GC: re-runs after a body-first first run stay zero-GC (D-A6)", () => {
    it("[RED] NR-GC real loop: minor 0, major 0, <= 0.5 B/op over non-code spaces; control (module-scope sink) minor > 0", () => {
        const o = runChildNr([]);
        const cap = 0.5 * o.N;
        assert.equal(o.real.nan, 0);
        assert.ok(o.real.clean >= 12 - 4, "clean windows " + o.real.clean);
        assert.equal(o.real.minor, 0);
        assert.equal(o.real.major, 0);
        assert.ok(o.real.max <= cap, "max bytes/window " + o.real.max);
        assert.equal(o.sinkSet, true);
        assert.ok(o.ctl.minor > 0, "control minor " + o.ctl.minor);
    });
    it("[RED] NR-GC control teeth hold under --no-opt --no-maglev (a boxing control is tier-dependent)", () => {
        const o = runChildNr(["--no-opt", "--no-maglev"]);
        assert.equal(o.sinkSet, true);
        assert.ok(o.ctl.minor > 0, "control minor " + o.ctl.minor);
    });
});

// ---- D-A7: retention over 10,000 cycles (P6 / P6R rewritten to the body-first values) ----

describe("FIX-CL-D retention: throwing pre-run cleanups return the graph to the baseline (D-A7)", () => {
    // P6: 10,000 cycles read-E / read-E / dispose.
    function p6(keepAlive) {
        const r = createRegistry({ onCapacityExceeded: "grow" });
        const s = r.signal(1); const keep = []; const marks = [];
        const base = r.stats(); let hits = 0, bodies = 0;
        for (let i = 1; i <= 10000; i++) {
            const c = r.createRoot(() => {
                const cc = r.computed(() => { bodies++; return s() * 10; });
                r.runWithOwner(cc, () => r.onCleanup(() => { throw E; }));
                return cc;
            });
            if (thrown(() => c()) === E) hits++;
            if (thrown(() => c()) === E) hits++;
            if (keepAlive) keep.push(c); else r.dispose(c);
            if (i % 1000 === 0) { const st = r.stats(); marks.push([st.activeNodes, st.activeLinks]); }
        }
        return { base: [base.activeNodes, base.activeLinks], marks, hits, bodies };
    }
    it("[RED] P6 retention: 10,000 read-E / read-E / dispose cycles return activeNodes / activeLinks to the baseline at all 10 checkpoints", () => {
        const o = p6(false);
        assert.equal(o.hits, 20000);
        assert.equal(o.bodies, 10000);          // body-first: every first read ran the body once
        assert.equal(o.marks.length, 10);
        for (const m of o.marks) assert.deepEqual(m, o.base);
    });
    it("[RED] P6 keep-alive control: keeping every computed adds exactly +10,000 nodes and +10,000 links", () => {
        const o = p6(true);
        assert.deepEqual(o.marks[9], [o.base[0] + 10000, o.base[1] + 10000]);
    });

    // P6R: c + a catching d + a deferred effect per cycle, each with a throwing pre-run cleanup; dispose all.
    function p6r(keepAlive) {
        const r = createRegistry({ onCapacityExceeded: "grow" });
        const s = r.signal(1); const keep = []; const marks = [];
        const base = r.stats(); let bad = 0, snapBad = 0;
        for (let i = 1; i <= 10000; i++) {
            const hs = r.createRoot(() => {
                const cc = r.computed(() => s() * 10);
                r.runWithOwner(cc, () => r.onCleanup(() => { throw E; }));
                const d = r.computed(() => { try { return cc(); } catch { return "E"; } });
                r.runWithOwner(d, () => r.onCleanup(() => { throw E2; }));
                if (thrown(() => d()) !== E2) bad++;           // d's own pre-run cleanup error E2 is cached as d's error
                const q = [];
                const ef = r.effect(() => { try { cc(); } catch { /* the effect reads the cached E */ } }, { scheduler: (t) => q.push(t) });
                r.runWithOwner(ef, () => r.onCleanup(() => { throw E2; }));
                if (thrown(() => q[0]()) !== E2) bad++;
                return [cc, d, ef];
            });
            if (keepAlive) keep.push(hs); else { r.dispose(hs[2]); r.dispose(hs[1]); r.dispose(hs[0]); }
            if (i % 1000 === 0) {
                const st = r.stats(); marks.push([st.activeNodes, st.activeLinks]);
                try { r.snapshot(); } catch { snapBad++; }
            }
        }
        return { base: [base.activeNodes, base.activeLinks], marks, bad, snapBad };
    }
    it("[RED] P6R retention: 10,000 cycles of c + catching d + deferred effect, each with a throwing pre-run cleanup, return activeNodes / activeLinks to the baseline at all 10 checkpoints; bad 0, snapBad 0", () => {
        const o = p6r(false);
        assert.equal(o.bad, 0);
        assert.equal(o.marks.length, 10);
        for (const m of o.marks) assert.deepEqual(m, o.base);
        assert.equal(o.snapBad, 0);
    });
    it("[RED] P6R keep-alive control: keeping c, d and the effect adds exactly +30,000 nodes and +30,000 links (c->s, d->c, effect->c per cycle)", () => {
        const o = p6r(true);
        assert.equal(o.bad, 0);
        assert.equal(o.marks[9][0], o.base[0] + 30000);
        assert.equal(o.marks[9][1], o.base[1] + 30000);
    });
});

// ======================================================================================================
// AUD-E1 (b177) batch B3: rows from PLAN-AUD-E1.md ASSERTIONS A1 / A4 / A5 (an oracle independent of the engine coder).
//   S1: a re-run cleanup that WRITES one of the node's own dependencies and then throws must not lose the write
//   (fable-5.1 engine-2); B3: the never-ran message text (fable-5.1 engine-4). Every row is [RED] on the frozen build
//   17ac945 / c8f6cd1e unless it says PIN. No row is deferred. Engine under
//   test: F_B33_ENGINE or ../Signal.js.
//   Expected values are the ASSERTIONS' (A1: effect [0,11] / [0,11,15], computed 'ccl' then 11 with 2 body runs,
//   runs [1,2,3], "cleanups threw before the body could run", evalVersion -1) or hand-derived in the row comment.
// ======================================================================================================

describe("AUD-E1 S1: a throwing re-run cleanup that wrote a dependency keeps the write (re-queue / far floor)", () => {

    // Hand-derived: run 1 sees s=0. s.set(1) -> cleanup writes s = 1 + 10 = 11 and throws 'cl' (the write rethrows it as itself).
    // The write made during the cleanup must not be absorbed: the node is re-queued and its body sees 11 -> [0, 11].
    // Run 2 registers the same cleanup. s.set(5) -> cleanup writes 5 + 10 = 15 and throws; body sees 15 -> [0, 11, 15].
    // Frozen (measured): [0] then [0, 5] (the write of 11 is lost, the node wedges).
    it("[RED] S1 effect: set(1) throws Error 'cl' as itself, seen [0,11]; set(5) throws 'cl', seen [0,11,15]", () => {
        const r = createRegistry();
        const s = r.signal(0); const seen = [];
        r.effect(() => { seen.push(s()); r.onCleanup(() => { s.set(s.peek() + 10); throw new Error("cl"); }); });
        assert.deepEqual(seen, [0]);
        const e1 = thrown(() => s.set(1));
        assert.ok(e1 instanceof Error && !(e1 instanceof AggregateError), "set(1) threw " + String(e1));
        assert.equal(e1.message, "cl");
        assert.deepEqual(seen, [0, 11]);
        assert.equal(s.peek(), 11);
        const e2 = thrown(() => s.set(5));
        assert.ok(e2 instanceof Error && !(e2 instanceof AggregateError), "set(5) threw " + String(e2));
        assert.equal(e2.message, "cl");
        assert.deepEqual(seen, [0, 11, 15]);
    });

    // Hand-derived: c() = 0, runs 1. s.set(1). Read 1: the cleanup writes s = 11, throws 'ccl': cached, read 1 throws 'ccl'
    // (the body is skipped). The write must stay visible: read 2 re-runs the body, which reads 11 -> returns 11, 2 body runs.
    // Frozen (measured): read 2 throws 'ccl' again, runs 1.
    it("[RED] S1 computed: read 1 throws 'ccl', read 2 === 11, 2 body runs", () => {
        const r = createRegistry();
        const s = r.signal(0); let runs = 0;
        const c = r.computed(() => { runs++; const v = s(); r.onCleanup(() => { s.set(s.peek() + 10); throw new Error("ccl"); }); return v; });
        assert.equal(c(), 0);
        s.set(1);
        const e1 = thrown(() => c());
        assert.ok(e1 instanceof Error, "read 1 threw " + String(e1));
        assert.equal(e1.message, "ccl");
        assert.equal(runs, 1);
        assert.equal(c(), 11);
        assert.equal(runs, 2);
    });

    // Nested writer: the write is made by a computed W pulled from the cleanup (so it takes the write-during-evaluation walk,
    // not the plain-write path). Hand-derived as S1 effect: s.set(1) -> cleanup pulls W (writes s = 1 + 10 = 11), throws 'cl';
    // the node is re-queued and its body sees 11 -> [0, 11]. W has no deps so it is evaluated exactly once.
    it("[RED] S1 nested writer, effect: the cleanup pulls a computed that writes the dep and throws 'cl' -> the effect is re-queued, seen [0,11]", () => {
        const r = createRegistry();
        const s = r.signal(0); const seen = []; let wRuns = 0;
        const W = r.computed(() => { wRuns++; s.set(s.peek() + 10); return 1; });
        r.effect(() => { seen.push(s()); r.onCleanup(() => { W(); throw new Error("cl"); }); });
        const e1 = thrown(() => s.set(1));
        assert.ok(e1 instanceof Error && e1.message === "cl", "set(1) threw " + String(e1));
        assert.equal(wRuns, 1);
        assert.deepEqual(seen, [0, 11]);
    });

    // Computed analogue of the nested writer: c's cleanup pulls W (writes s = 11) and throws 'ccl'; read 1 throws 'ccl',
    // read 2 re-runs the body on 11.
    it("[RED] S1 nested writer, computed: the cleanup pulls a computed that writes the dep and throws 'ccl' -> read 1 throws, read 2 === 11", () => {
        const r = createRegistry();
        const s = r.signal(0); let runs = 0;
        const W = r.computed(() => { s.set(s.peek() + 10); return 1; });
        const c = r.computed(() => { runs++; const v = s(); r.onCleanup(() => { W(); throw new Error("ccl"); }); return v; });
        assert.equal(c(), 0);
        s.set(1);
        const e1 = thrown(() => c());
        assert.ok(e1 instanceof Error && e1.message === "ccl", "read 1 threw " + String(e1));
        assert.equal(c(), 11);
        assert.equal(runs, 2);
    });
});

describe("AUD-E1 B3: the never-ran message and the far-floor marker at f === 0", () => {

    // engine-4 shape (fable-5.1 reproductions shapeC / opus p3-neverran): run 1 tracks s. Run 2 (triggered by s.set(1)) pulls a
    // computed that writes s (so the effect is stale-read re-queued), registers a cleanup that throws 'E-cleanup', and returns.
    // The re-queued run 3 runs that cleanup first and then the body, which throws 'E-body-run3'. Runs [1,2,3]; the errors are
    // the cleanup error then the body error in an AggregateError whose message says what is true here: the cleanups threw
    // before the body could run (not "before the first run": the effect had run twice).
    it("[RED] B3 re-queued effect, throwing cleanup + throwing body: runs [1,2,3], AggregateError 'cleanups threw before the body could run' [E-cleanup, E-body-run3]", () => {
        const r = createRegistry();
        const s = r.signal(0); const runs = []; let phase = 0;
        r.effect(() => {
            const myRun = runs.length + 1; runs.push(myRun);
            if (phase === 0) { s(); return; }
            r.untrack(() => { const w = r.computed(() => { s.set(99); return 1; }); w(); });
            r.onCleanup(() => { throw new Error("E-cleanup"); });
            if (myRun >= 3) throw new Error("E-body-run" + myRun);
        });
        phase = 1;
        const e = thrown(() => s.set(1));
        assert.deepEqual(runs, [1, 2, 3]);
        assert.ok(e instanceof AggregateError, "threw " + String(e));
        assert.equal(e.message, "cleanups threw before the body could run");
        assert.deepEqual(e.errors.map((x) => x.message), ["E-cleanup", "E-body-run3"]);
    });

    // Disposed branch of firstRunCleanupE (`if (node.gen !== g) throw firstRunErrors(errs)`, the body never runs). A never-run
    // effect (deferred scheduler, task not yet called) owns a child effect whose cleanup throws 'A' and has its own pre-run
    // cleanup attached by runWithOwner, which disposes the effect and throws 'B'. Task call: the drain disposes the child
    // (A), then runs the own cleanup (B; the effect is disposed) -> AggregateError [A, B] in DISPOSAL order (the child
    // first), message "cleanups threw before the body could run"; the body never runs (0). stats().effects 2 -> 1: the
    // parent is gone; the 1 left is the child, a live orphan (LEDGER #56: a child whose cleanup throws is popped before its
    // disposal and stays live). Order and counts PROBED on the live tree (fad445be) and on the frozen 17ac945 / c8f6cd1e build
    // (identical there except the message text "... before the first run"). [RED]: red on the frozen build by the message
    // alone, and red on a live tree that still has the old text.
    it("[RED] B3 disposed branch: never-run effect, a pre-run cleanup disposes it after a child's cleanup threw: AggregateError 'cleanups threw before the body could run' [A, B], body runs 0, parent gone from stats()", () => {
        const r = createRegistry();
        let task = null, bodies = 0;
        const A = new Error("A"), B = new Error("B");
        const stop = r.effect(() => { bodies++; }, { scheduler: (f) => { task = f; } });
        r.runWithOwner(stop, () => {
            r.effect(() => { r.onCleanup(() => { throw A; }); });
            r.onCleanup(() => { r.dispose(stop); throw B; });
        });
        assert.equal(r.stats().effects, 2);
        assert.equal(bodies, 0);
        const e = thrown(() => task());
        assert.ok(e instanceof AggregateError, "threw " + String(e));
        assert.equal(e.message, "cleanups threw before the body could run");
        assert.equal(e.errors.length, 2);
        assert.equal(e.errors[0], A);
        assert.equal(e.errors[1], B);
        assert.equal(bodies, 0, "the body of a disposed never-run effect must not run");
        assert.equal(r.stats().effects, 1);   // the child orphan (#56)
    });

    // Effect far-floor site. R6 shape (above): a re-queued effect (evalVersion 0 with links) whose re-run cleanup throws gets a
    // needs-run marker f = (globalVersion - 0x3FFFFFFF) | 0, and f === 0 must become -1 (0 would read as a pending scheduled
    // run). Seed 0x3FFFFFFA: the batch's writes (s, trig, the k computed's write, the cleanup's two w writes) leave
    // globalVersion exactly 0x3FFFFFFF at the catch, so f === 0 (precondition asserted via snapshot().gv). PIN: green on
    // the frozen build (the marker already exists there); kills the mutant `f === 0 ? -1 : f` -> `f`.
    it("[PIN] F0-E effect marker: gv 0x3FFFFFFF at the catch -> snapshot evalVersion === -1 (not 0), snapshot works, the next wake runs the body", () => {
        const r = seeded(0x3FFFFFFA);
        const s = r.signal(0), trig = r.signal(0), x = r.signal(0), u = r.signal(0), w = r.signal(0); const cu = r.computed(() => u() & 0);
        let arm = false, runs = 0;
        const k = r.computed(() => { if (trig() > 0) { arm = true; s.set(s.peek() + 1); } return trig(); });
        const ef = r.effect(() => {
            x(); s(); k(); cu();
            runs++;
            r.onCleanup(() => { if (arm) { arm = false; w.set(w.peek() + 1); w.set(w.peek() + 1); throw E; } });
        });
        assert.equal(thrown(() => r.batch(() => { s.set(10); trig.set(1); })), E);
        const snap = r.snapshot();
        assert.equal(snap.gv, 0x3FFFFFFF, "precondition: globalVersion at the catch");
        assert.equal(snap.nodes.find((n) => n.id === r.nodeId(ef)).evalVersion, -1);
        const before = runs;
        u.set(1);
        assert.equal(runs, before + 1);
    });

    // Computed far-floor site. Seed 0x3FFFFFFD: s.set(1) and the cleanup's write are the two writes between the seed and the
    // catch, so globalVersion is exactly 0x3FFFFFFF at the catch (precondition: the node's cached-error version). The
    // write moved markEpoch, so the error is stamped at the far floor: f = (0x3FFFFFFF - 0x3FFFFFFF) | 0 = 0 -> -1.
    // Frozen: evalVersion = globalVersion = 0x3FFFFFFF.
    it("[RED] F0-C computed far floor: gv 0x3FFFFFFF at the catch -> snapshot evalVersion === -1", () => {
        const r = seeded(0x3FFFFFFD);
        const s = r.signal(0);
        const c = r.computed(() => { const v = s(); r.onCleanup(() => { s.set(s.peek() + 10); throw new Error("ccl"); }); return v; });
        c(); s.set(1);
        assert.equal(thrown(() => c()).message, "ccl");
        const rec = r.snapshot().nodes.find((n) => n.id === r.nodeId(c));
        assert.equal(rec.version, 0x3FFFFFFF, "precondition: globalVersion at the catch");
        assert.equal(rec.evalVersion, -1);
    });

    // P2 computed state survives snapshot / restore: after read 1 threw 'ccl' (s is 11), the snapshot restores into a registry
    // whose next read of c re-runs the body and returns 11 (the far floor is below every recent version). Both the default
    // band and the f === 0 band.
    for (const gv of [null, 0x3FFFFFFD]) {
        it("[RED] P2 computed snapshot/restore (gv " + (gv === null ? "default" : "0x3FFFFFFD") + "): after the throwing read, snapshot ok, the restored computed's next read is 11", () => {
            const r = seeded(gv);
            const s = r.signal(0);
            const c = r.computed(() => { const v = s(); r.onCleanup(() => { s.set(s.peek() + 10); throw new Error("ccl"); }); return v; });
            c(); s.set(1);
            assert.equal(thrown(() => c()).message, "ccl");
            const snap = r.snapshot();
            const sId = r.nodeId(s), cId = r.nodeId(c);
            const H = {};
            const rr = r.restore(snap, { fnsById: { [cId]: () => H[sId]() }, handles: H });
            assert.equal(H[cId](), 11);
            assert.equal(snapOk(rr), true);
        });
    }
});

// ---- A4: 10,000 S1 cycles with a pre-allocated thrown error cost one rethrow each, nothing else (KNOWN pin; A8_FLAGS child) ----

const CHILD_S1 = `
import { measureWindows } from ${JSON.stringify(HEAP_WINDOW)};
import { createRegistry } from ${JSON.stringify(ENGINE_URL)};
for (const f of ${JSON.stringify(A8_FLAGS)}) {
    if (!process.execArgv.includes(f)) { console.error("S1 child: " + f + " is not in execArgv"); process.exit(3); }
}
const N = 10000, WARM = 4, CYC = 12;
const boom = new Error("boom");        // pre-allocated: the thrown error object itself costs nothing per cycle
const CNT = new Int32Array(4);         // [body runs, cycles, wrong errors, boom caught]
let SINK = null;                       // module scope: a dead local would be escape-eliminated
function make(control) {
    const r = createRegistry();
    const p = r.signal(0);
    const cl = () => { p.set(p.peek() + 1); throw boom; };   // hoisted: ONE closure per make(), none per run
    r.effect(() => { p(); CNT[0]++; r.onCleanup(cl); });
    let k = 2;
    return () => {
        for (let i = 0; i < N; i++) {
            k += 2;                    // never equal to p (the cleanup writes k + 1), so every set is a real change
            try { p.set(k); } catch (e) { if (e !== boom) CNT[2]++; else CNT[3]++; }
            CNT[1]++;
            if (control === 1) SINK = {};                                                // BYTES control: 1 empty object per cycle
            else if (control === 2) SINK = { a: i, b: k, c: i, d: k, e: i, f: k, g: i, h: k };   // SCAVENGE control: 1 bigger object per cycle
        }
    };
}
// Reference: N one-level catch-and-rethrows of the same pre-allocated error (what the engine's rerunCleanupEffect
// "catch (err) { ...; throw err; }" does), caught one level up, with no engine involved.
function oneLevel() { try { throw boom; } catch (err) { throw err; } }
function makeRef() {
    return () => {
        for (let i = 0; i < N; i++) {
            try { oneLevel(); } catch (e) { if (e !== boom) CNT[2]++; }
        }
    };
}
const ref = await measureWindows(makeRef(), { warmup: WARM, cycles: CYC });
CNT.fill(0);
const real = await measureWindows(make(0), { warmup: WARM, cycles: CYC });
const realCnt = [CNT[0], CNT[1], CNT[2], CNT[3]];
CNT.fill(0);
const ctlB = await measureWindows(make(1), { warmup: WARM, cycles: CYC });
const ctl = await measureWindows(make(2), { warmup: WARM, cycles: CYC });
console.log("RESULT " + JSON.stringify({ N, ref, real, ctlB, ctl, realCnt, sinkSet: SINK !== null }));
`;

function runChildS1(flags) {
    const res = spawnSync(process.execPath, [...A8_FLAGS, ...flags, "--input-type=module", "-e", CHILD_S1], {
        encoding: "utf8", timeout: 120000, killSignal: "SIGKILL",
    });
    assert.equal(res.error, undefined, "spawn error: " + (res.error && res.error.message));
    assert.equal(res.signal, null, "child killed by " + res.signal);
    assert.equal(res.status, 0, "child status " + res.status + "\n" + res.stderr);
    const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, "no RESULT line:\n" + res.stdout + res.stderr);
    return JSON.parse(line.slice(7));
}

// KNOWN pin, not zero (maintainer ruling Q-b177-1, "Known pin (Rec.)", b177): the engine's re-run cleanup path is
// rerunCleanupEffect's committed `catch (err) { ...; throw err; }`, and V8 allocates 40 B on every catch-and-rethrow of an
// already-allocated error (node 26, b177 probes e1/gates/a4-throw-probe.txt: reference loop `try { throw boom } catch (e)
// { throw e }` caught one level up = 400032 / 400000 B per window of N = 10000 cycles = 40 B per throw; two levels = 80 B;
// throw + catch only = 0; try/finally = 0). The error path is cold, so the pin is: the engine loop costs exactly what the
// reference rethrow costs, and nothing else (the row's own cleanup closure is hoisted: 56 B/cycle of it was the
// as-is row's other cost). The expected value is measured IN THE SAME CHILD with the same measureWindows settings on a
// reference loop, so another Node major that allocates differently per rethrow moves both sides together.
// Tolerance: |engine - reference| <= 64 B per window (min and max each), i.e. 0.0064 B/cycle. Basis (node 26, 3 child runs, host
// load ~40): reference min 400000 max 400032; engine min 400008 max 400032 -- the window bracket constant is 0..32 B and
// the engine/reference offset at most 8 B. Must-fail controls (see the row): bytes control +{} = 960128 B/window (>= 8 B/cycle above
// the reference min; it scavenges under --no-opt --no-maglev, so it is asserted in the default-tier row only), scavenge control
// (+8-field object) minor 12 -- minor only, its bytes read low (264552) once a scavenge lands in the window.
const S1_TOL = 64;
function s1MatchesRef(w, ref) {
    return Math.abs(w.max - ref.max) <= S1_TOL && Math.abs(w.min - ref.min) <= S1_TOL;
}

describe("AUD-E1 A4: S1 cycles cost exactly one catch-and-rethrow each (KNOWN pin)", () => {
    it("[RED] A4 S1 loop (10,000 cycles per window): one body re-run and one rethrow of the pre-allocated error per cycle; window bytes == the rethrow reference (+-64 B); minor 0, major 0; bytes control (+{}) >= 8 B/cycle above it, scavenge control (+8-field object) scavenges", () => {
        const o = runChildS1([]);
        const [bodyRuns, cycles, wrong] = o.realCnt;
        assert.equal(wrong, 0, "a write threw something other than the cleanup's error");
        assert.equal(o.realCnt[3], o.realCnt[1], "every write must rethrow the cleanup's error");
        assert.equal(bodyRuns, cycles + 1, "body runs " + bodyRuns + " vs cycles " + cycles);   // creation + one per cycle (frozen: 1)
        assert.equal(o.ref.nan, 0);
        assert.ok(o.ref.clean >= 12 - 4, "reference clean windows " + o.ref.clean);
        assert.equal(o.real.nan, 0);
        assert.ok(o.real.clean >= 12 - 4, "clean windows " + o.real.clean);
        assert.equal(o.real.minor, 0);
        assert.equal(o.real.major, 0);
        assert.ok(s1MatchesRef(o.real, o.ref), "engine min/max " + o.real.min + "/" + o.real.max + " vs reference " + o.ref.min + "/" + o.ref.max);
        // must-fail controls (the engine loop plus one object per cycle), two separate claims:
        // (A) BYTES control: + one module-scope {} per cycle (measured 96 B/cycle = 960128 B/window, under the 1 MiB semi-space, so
        //     no scavenge and the window bytes are a real measurement): minor 0, and min exceeds the reference min by >= 8 B/cycle.
        assert.equal(o.sinkSet, true);
        assert.equal(o.ctlB.minor, 0, "bytes control scavenged: its window bytes would not be comparable");
        assert.ok(!s1MatchesRef(o.ctlB, o.ref), "bytes control matched the reference: " + o.ctlB.min + "/" + o.ctlB.max);
        assert.ok(o.ctlB.min - o.ref.min >= 8 * o.N, "bytes control exceeds the reference by only " + (o.ctlB.min - o.ref.min));
        // (B) SCAVENGE control: + one 8-field object per cycle crosses the semi-space, so it scavenges (bytes are NOT claimed: a
        //     window with a scavenge reads low).
        assert.ok(o.ctl.minor > 0, "scavenge control minor " + o.ctl.minor);
    });

    it("[RED] A4 S1 control teeth hold under --no-opt --no-maglev (the scavenge control must scavenge at every tier; the bytes control is asserted in the default-tier row only: it scavenges here)", () => {
        const o = runChildS1(["--no-opt", "--no-maglev"]);
        assert.equal(o.realCnt[0], o.realCnt[1] + 1);
        assert.equal(o.sinkSet, true);
        assert.ok(o.ctl.minor > 0, "control minor " + o.ctl.minor);
    });
});

// ---- A5: retention over 100 create / set x2 / dispose cycles of an S1 effect (child, --expose-gc) ----

const RETENTION_S1 = `
import { createLeakTracker } from '@zakkster/lite-leak';
import { createRegistry } from ${JSON.stringify(ENGINE_URL)};
const tr = createLeakTracker({ name: 'e1', onLeak() {}, onWarning() {} });
const settle = async () => {
    for (let t = 0; t < 40 && tr.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 10)); }
    return tr.size();
};
const r = createRegistry();
const held = [];
// Tracked values are created inside the helper so no frame of this loop holds the last one.
function cycle(i, keep) {
    const err = new Error('c' + i), pay = { i };
    tr.track(err, null, 'err' + i); tr.track(pay, null, 'pay' + i);
    if (keep) held.push(err);
    const p = r.signal(0); let runs = 0, disposing = false;
    // the write is made by the re-run cleanups only: a cleanup that writes its own signal while its effect is being DISPOSED
    // retains err + pay (2 tracked objects per cycle) on the frozen AND the c0c123a1 builds -- reported, not pinned here
    const e = r.effect(() => { p(); runs++; r.onCleanup(() => { pay.i++; if (!disposing) p.set(p.peek() + 10); throw err; }); });
    let t1 = null, t2 = null;
    try { p.set(1); } catch (x) { t1 = x; }
    try { p.set(100); } catch (x) { t2 = x; }
    // the dispose runs the (still armed) throwing cleanup: the 1st dispose throws err, a later one completes (A6)
    disposing = true;
    for (let d = 0; d < 3; d++) { try { r.dispose(e); break; } catch (x) { /* retry */ } }
    r.dispose(p);
    return runs + ':' + (t1 === err) + ':' + (t2 === err);
}
const sizes = [], shapes = [], gauges = [];
for (let i = 0; i < 100; i++) {
    shapes.push(cycle(i, false));
    sizes.push(await settle());
    const st = r.stats(); gauges.push(st.activeNodes + st.activeLinks);
}
// the recycled slots: a later effect runs exactly once at creation and once per write
const q = r.signal(0); let gRuns = 0;
r.effect(() => { q(); gRuns++; });
const afterCreate = gRuns;
q.set(1);
const afterWrite = gRuns;
// control: one held error keeps the tracker above 0
cycle(1000, true);
const control = await settle();
console.log(JSON.stringify({ sizes, shapes, gauges, afterCreate, afterWrite, control }));
`;

describe("AUD-E1 A5: retention across S1 create / set / set / dispose cycles", () => {
    it("[RED] A5 100 cycles: tracker.size() 0 after each, activeNodes + activeLinks 0, every cycle re-ran the body (3 runs) and rethrew its error; a later effect on a recycled slot runs once; held control > 0", () => {
        const root = fileURLToPath(new URL("../", import.meta.url));
        const res = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=256", "--input-type=module", "-e", RETENTION_S1], {
            cwd: root, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL",
        });
        const tail = String(res.stderr || "").split("\n").slice(-12).join("\n");
        assert.ok(res.status === 0 && res.signal === null, "child exit " + res.status + " sig " + res.signal + "\n" + tail);
        const o = JSON.parse(res.stdout.trim().split("\n").pop());
        assert.equal(o.sizes.length, 100);
        assert.ok(o.sizes.every((n) => n === 0), "tracker.size() per cycle: " + o.sizes.filter((n) => n !== 0).join());
        assert.ok(o.gauges.every((n) => n === 0), "activeNodes + activeLinks per cycle");
        // creation run + set(1) re-run + set(100) re-run = 3 body runs; both writes rethrow the cleanup's error itself (frozen: 1 run)
        assert.ok(o.shapes.every((x) => x === "3:true:true"), "cycle shapes: " + [...new Set(o.shapes)].join());
        assert.equal(o.afterCreate, 1);
        assert.equal(o.afterWrite, 2);
        assert.equal(o.control, 1, "control: the held error stays tracked");
    });
});
