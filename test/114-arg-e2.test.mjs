/**
 * ARG-E2 (b186, program ARG) -- LiteSignal 1.6.0 batch B2: rows for F1 (pending cleanup error delivery), F4 (revertBlocked) and
 * F5 (effect() creation supersede), plus the S5 tooth rows (T1 T2 T3), the memory row (MEM), the GC row (GC) and the retention
 * row (RET).
 *
 * Source of every expected value: PLAN-ARG-E2.md ASSERTIONS as overridden by ADDENDUM b185 (b185-1, b185-2) and ADDENDUM b186
 * (b186-3 .. b186-5); rulings D-b183-1 (reader re-runs) and D-b183-2 (a successful immediate re-run supersedes the first error).
 * Values were measured by the TASK 0g witness scripts (.handoff/arg/e2/witness/f1.mjs, f4.mjs, f5.mjs; this file reuses their
 * scenario code and row shapes) and by evidence/shapes/s5-tooth.mjs + mem.mjs. Nothing here was copied from a run of the build
 * under test.
 *
 * Builds the values came from (commit + sha256/8):
 *   e26168ce  ARG-E1 final build (before-144ae75-e26168ce)
 *   91c507df  before-e2-566a092-91c507df: the "before" of this batch; witness output is byte-equal to e26168ce on every row
 *   84992f67  B1a + S5 read trim (live Signal.js after b186-2); passes all F1 rows
 * Every RED row below FAILS on 91c507df (and e26168ce). PIN rows pass on 91c507df and guard a mutant (named in the comment) or
 * pin unchanged behaviour. Row ids: A1..A14d (F1), R0..R5c (F4), F5-*, TT (F5), T1/T2/T3 (S5 tooth), MEM, GC, RET.
 *
 * D-b186-4: the F5 supersede applies only to effects WITHOUT a scheduler; with a scheduler any first-pass error throws and
 * disposes as on 91c507df (F5-S, P3, P3b are frozen-parity PINs). Live build df50017f (= b836fbbb + peekComputed).
 *
 * ADDENDUM b187 rows (r2; values measured by TASK C0, evidence/b187/C0-REPORT.md): A13b, A11x, A15, A15n, A6c-peek, A6c-boxpeek,
 * A1b, RET-A11x. All pass on df50017f. Fail (RED) on 91c507df, proven by running:
 *   91c507df: A15, A15n, A1b (plus the earlier RED rows)
 * PIN rows: A13b, A11x, RET-A11x pass on both frozen builds; A6c-peek, A6c-boxpeek are PIN too: they pass on 91c507df and FAIL on
 * b836fbbb (runs 3, seen [E,200]). Every PIN row guards the mutants named at the row.
 *
 * ADDENDUM b188 rows (H2; values measured by TASK T0, evidence/b188/T0-REPORT.md): A13b-peek, A13b-boxpeek, T2/T3 x peek / boxpeek /
 * boxget, R5e, R5ec, band gv0x70000000 on R5 / R5c, F5-DD, F5-DDr, F5-DS, A14p-peek, A14p-boxpeek, F0C-peek, F0C-boxpeek. RED on
 * 91c507df: R5e (4 bands) and R5 at gv0x70000000; every other b188 row is a PIN (passes on 91c507df, b836fbbb and df50017f).
 * Live build f6ff4cf3 (= df50017f + one comment-only hunk). MEM (D-b188-2) measures against a vendored copy of 91c507df,
 * test/fixtures/Signal-91c507df.js, in the child process.
 *
 * Engine under test: F_B33_ENGINE (absolute path or file: URL; the same switch as test/110 and test/56), default ../Signal.js.
 * No timing assertion anywhere. GC / MEM / RET rows run in a child process (--expose-gc, --max-old-space-size pinned).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE = process.env.F_B33_ENGINE ?? new URL("../Signal.js", import.meta.url).href;
const ENGINE_URL = ENGINE.startsWith("file:") ? ENGINE : pathToFileURL(ENGINE).href;
const { createRegistry } = await import(ENGINE_URL);

// B1b landed (live build b836fbbb, D-b186-4): no row is deferred.

const E = new Error("E"), E2 = new Error("E2");
const tag = (x) => (x === E ? "E" : x === E2 ? "E2" : x instanceof Error ? "ERR:" + x.message : x);
const thrown = (fn) => { try { fn(); return "none"; } catch (e) { return tag(e); } };
const val = (fn) => { try { return fn(); } catch (e) { return "threw:" + tag(e); } };
const msg = (e) => (e instanceof Error ? e.message : String(e));
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// gv seeding through restore (as test/110 seeded()): a registry whose globalVersion is `gv` (null = default 1).
function seeded(gv) {
    const r = createRegistry(); r.signal(0);
    if (gv === null) return r;
    const snap = r.snapshot();
    return r.restore(Object.assign({}, snap, { gv }), { fnsById: {}, handles: {} });
}
const STD = [[null, "gv1"], [0x40000010, "gv0x40000010"], [0x7FFFFF00, "gv0x7fffff00"]];
const WRAP = [[0x7FFFFFFD, "gv0x7ffffffd"], [0x7FFFFFFE, "gv0x7ffffffe"], [0x7FFFFFFF, "gv0x7fffffff"]];
const NEG = [[0x80000010 | 0, "gvNeg0x80000010"]];

// kind: "RED" | "PIN". Registers one test per band; the NEG band is always PIN and never todo (frozen already passes there).
function rows(group, list) {
    describe(group, () => {
        for (const { id, kind, name, bands, f, exp, keys } of list) {
            for (const [gv, bl] of bands) {
                const neg = bl === "gvNeg0x80000010";
                const opts = {};
                const kk = neg ? "PIN" : kind;
                it("[" + kk + "] " + id + " " + name + " (" + bl + ")", opts, () => {
                    const got = f(seeded(gv));
                    assert.deepStrictEqual(pick(got, keys || Object.keys(exp)), exp);
                });
            }
        }
    });
}

// ======================================================================================================================
// F1: pending cleanup error delivery (D-b183-1). Base: s=1; c = computed reading s, a cleanup armed once that does
// `s.set(20); throw E`; returns v*10. Arm, then s.set(2).
// ======================================================================================================================
function base(r, box = false, e2 = false) {
    const s = r.signal(1); const st = { cbody: 0, armed: false };
    const fn = () => {
        st.cbody++; const v = s();
        r.onCleanup(() => { if (st.armed) { st.armed = false; s.set(20); throw E; } });
        if (e2 && v === 20) throw E2;
        return v * 10;
    };
    return { s, c: box ? r.computedBox(fn) : r.computed(fn), st };
}
const READERS = {
    direct: (c) => c(), peek: (c) => c.peek(), boxget: (c) => c.get(), boxpeek: (c) => c.peek(),
};
// pre-walk: a dependent effect `if (readC) c()` linked c on its first run; readC is then false and the write arms the pending error.
function prewalked(r, box) {
    const b = base(r, box); let readC = true;
    const h = r.effect(() => { if (readC) { if (box) b.c.get(); else b.c(); } });
    readC = false; b.st.armed = true; b.s.set(2);
    return { ...b, h };
}

const f1 = [];
f1.push({ id: "A1", kind: "RED", name: "catching effect reader sees E then 200, 3 runs, c body 2", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); const seen = []; let runs = 0;
        r.effect(() => { runs++; try { seen.push(c()); } catch (e) { seen.push(tag(e)); } });
        st.armed = true; const t = thrown(() => s.set(2));
        return { seen, runs, cbody: st.cbody, thrown: t };
    }, exp: { seen: [10, "E", 200], runs: 3, cbody: 2, thrown: "none" } });
f1.push({ id: "A2", kind: "RED", name: "non-catching effect: s.set throws E (identity), seen [10,200], 3 runs", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); const seen = []; let runs = 0;
        r.effect(() => { runs++; seen.push(c()); });
        st.armed = true; const t = thrown(() => s.set(2));
        return { thrown: t, seen, runs };
    }, exp: { thrown: "E", seen: [10, 200], runs: 3 } });
f1.push({ id: "A3", kind: "RED", name: "catching computed reader: d 200, d runs 3, E seen once", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); let druns = 0, eSeen = 0;
        const d = r.computed(() => { druns++; try { return c(); } catch (e) { if (e === E) eSeen++; return "E"; } });
        d(); st.armed = true; s.set(2); const v = val(d);
        return { d: v, druns, eSeen };
    }, exp: { d: 200, druns: 3, eSeen: 1 } });
// Only druns is a tooth (frozen 2): the frozen build already returns 200 and throws nothing.
f1.push({ id: "A4", kind: "RED", name: "non-catching computed reader: no throw, d 200, d runs 3", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); let druns = 0;
        const d = r.computed(() => { druns++; return c(); });
        d(); st.armed = true; s.set(2); const t = thrown(d); const v = val(d);
        return { thrown: t, d: v, druns };
    }, exp: { thrown: "none", d: 200, druns: 3 } });
// A5 (PIN, kills NOCONSUME): direct / peek / box.get / box.peek with no pre-walk: first read throws E, next 200, c body 2.
for (const k of Object.keys(READERS)) {
    f1.push({ id: "A5-" + k, kind: "PIN", name: "no pre-walk: first E, second 200, c body 2", bands: STD,
        f: (r) => {
            const { s, c, st } = base(r, k.startsWith("box")); const rd = () => READERS[k](c);
            rd(); st.armed = true; s.set(2);
            const first = thrown(rd), second = val(rd);
            return { first, second, cbody: st.cbody };
        }, exp: { first: "E", second: 200, cbody: 2 } });
}
// A5P (RED): the same four readers after a pre-walk by a dependent whose body does not read c. Also kills PEEKNOFLOOR (b188): the
// peek floor deleted changes A5P-peek (c.peek) and A5P-boxpeek (cb.peek) on all 3 STD bands.
for (const k of Object.keys(READERS)) {
    f1.push({ id: "A5P-" + k, kind: "RED", name: "after pre-walk: first E, second 200, c body 2", bands: STD,
        f: (r) => {
            const { c, st } = prewalked(r, k.startsWith("box")); const rd = () => READERS[k](c);
            const first = thrown(rd), second = val(rd);
            return { first, second, cbody: st.cbody };
        }, exp: { first: "E", second: 200, cbody: 2 } });
}
// A6 (PIN, corrected by b185-2): the effect reads s itself (its trigger), then untrack(c). Run 3 comes from F-b33-1.
f1.push({ id: "A6", kind: "PIN", name: "untrack read in effect: seen [10,E,200], runs 3, c body 2", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); c(); const seen = []; let runs = 0;
        r.effect(() => { runs++; s(); try { seen.push(r.untrack(() => c())); } catch (e) { seen.push(tag(e)); } });
        st.armed = true; thrown(() => s.set(2));
        return { seen, runs, cbody: st.cbody };
    }, exp: { seen: [10, "E", 200], runs: 3, cbody: 2 } });
// A6b (PIN, kills OWNER-FALLBACK): the untracked reader is triggered by t, not s: no reader mark, runs 2.
f1.push({ id: "A6b", kind: "PIN", name: "untrack read, effect triggered by t: seen [10,E], runs 2, c after 200", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); c(); const t = r.signal(0); const seen = []; let runs = 0;
        r.effect(() => { runs++; t(); try { seen.push(r.untrack(() => c())); } catch (e) { seen.push(tag(e)); } });
        st.armed = true; s.set(2); thrown(() => t.set(1)); const after = val(c);
        return { seen, runs, cAfter: after };
    }, exp: { seen: [10, "E"], runs: 2, cAfter: 200 } });
f1.push({ id: "A7", kind: "RED", name: "diamond two catching effects: e1 [10,E,200], e2 [10,200]", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); const e1 = [], e2 = [];
        r.effect(() => { try { e1.push(c()); } catch (e) { e1.push(tag(e)); } });
        r.effect(() => { try { e2.push(c()); } catch (e) { e2.push(tag(e)); } });
        st.armed = true; thrown(() => s.set(2));
        return { e1, e2 };
    }, exp: { e1: [10, "E", 200], e2: [10, 200] } });
f1.push({ id: "A8", kind: "PIN", name: "effect never reads c: c() throws E, next 200, effect runs 3", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); c(); let runs = 0;
        r.effect(() => { runs++; s(); });
        st.armed = true; s.set(2);
        const first = thrown(c), second = val(c);
        return { first, second, runs };
    }, exp: { first: "E", second: 200, runs: 3 } });
f1.push({ id: "A9", kind: "PIN", name: "write before read: no throw, c 30", bands: STD,
    f: (r) => {
        const { s, c } = prewalked(r, false);
        s.set(3); const t = thrown(c); const v = val(c);
        return { thrown: t, c: v };
    }, exp: { thrown: "none", c: 30 } });
f1.push({ id: "A10", kind: "RED", name: "pending state snapshot + restore: first E, second 200, rlog [5], live effect log [1,20]", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); let readC = true; const elog = [];
        const h = r.effect(() => { if (readC) c(); elog.push(s()); });
        readC = false; st.armed = true; s.set(2);
        const sId = r.nodeId(s), cId = r.nodeId(c), eId = r.nodeId(h);
        let rr = null, snapErr = null; const H = {}; const rlog = [];
        try {
            const snap = r.snapshot();
            rr = r.restore(snap, { fnsById: { [cId]: () => H[sId]() * 10, [eId]: () => { rlog.push(H[sId]()); } }, handles: H });
        } catch (e) { snapErr = tag(e); }
        if (rr === null) return { snapErr };
        const first = thrown(() => H[cId]()), second = val(() => H[cId]());
        thrown(() => H[sId].set(5));
        return { first, second, rlog, liveElog: elog };
    }, exp: { first: "E", second: 200, rlog: [5], liveElog: [1, 20] } });
// A11 (RED: frozen seen [10,200]): the reader disposes itself, then reads pending c.
// The tooth is seen (a dead reader must not be re-marked); a fresh effect on a recycled slot runs creation + one write.
// Self-dispose nulls the current observer, so this row never reaches the COMPUTING test: it does NOT kill NOCOMPGUARD (A11x does).
f1.push({ id: "A11", kind: "RED", name: "reader disposes itself then reads: fr 2, seen [10,E], runs 2, effects 1", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); let h = null, selfDispose = false, runs = 0; const seen = [];
        h = r.effect(() => { runs++; if (selfDispose) h(); try { seen.push(c()); } catch (e) { seen.push(tag(e)); } });
        selfDispose = true; st.armed = true; thrown(() => s.set(2));
        const q = r.signal(0); let fr = 0;
        r.effect(() => { fr++; q(); });
        q.set(1);
        return { fr, seen, runs, effects: r.stats().effects };
    }, exp: { fr: 2, seen: [10, "E"], runs: 2, effects: 1 } });
f1.push({ id: "A12", kind: "RED", name: "sync scheduler in creation, two throws: log [E,E2], thrown E2, effects 0, c body 2", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r, false, true); c(); st.armed = true; s.set(2);
        const log = [];
        const t = thrown(() => r.effect(() => { try { log.push(c()); } catch (e) { log.push(tag(e)); throw e; } }, { scheduler: (x) => x() }));
        return { log, thrown: t, effects: r.stats().effects, cbody: st.cbody };
    }, exp: { log: ["E", "E2"], thrown: "E2", effects: 0, cbody: 2 } });
// A12b (F1 x scheduler seam): A12 without the E2 throw. Under D-b186-4 the scheduler's error still throws and disposes, but F1
// delivers the cleanup error first: RED vs 91c507df on log (['E']) and cbody (1).
f1.push({ id: "A12b", kind: "RED", name: "sync scheduler in creation, one throw (D-b186-4): log [E,200], thrown E, effects 0, c body 2", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); c(); st.armed = true; s.set(2);
        const log = [];
        const t = thrown(() => { r.effect(() => { try { log.push(c()); } catch (e) { log.push(tag(e)); throw e; } }, { scheduler: (x) => x() }); });
        return { log, thrown: t, effects: r.stats().effects, cbody: st.cbody };
    }, exp: { log: ["E", 200], thrown: "E", effects: 0, cbody: 2 } });
// A13 (PIN, kills LEAK-DESC): describe(c).value is E, never the wrapper (the wrapper proto's measured value is
// UndeliveredCleanupError, which is the must-fail control).
f1.push({ id: "A13", kind: "PIN", name: "describe(c).value is E, not the wrapper", bands: STD,
    f: (r) => {
        const { c } = prewalked(r, false);
        const d = r.describe(c);
        return { valueIsE: d.value === E };
    }, exp: { valueIsE: true } });
// A14 / A14d (PIN, kill WRAP-ALL): the cleanup throws E with NO write in it.
function cleanThrow(r, box = false) {
    const s = r.signal(1); const st = { cbody: 0, armed: false };
    const fn = () => {
        st.cbody++; const v = s();
        r.onCleanup(() => { if (st.armed) { st.armed = false; throw E; } });
        return v * 10;
    };
    const c = box ? r.computedBox(fn) : r.computed(fn);
    return { s, c, st };
}
f1.push({ id: "A14", kind: "PIN", name: "cleanup throws E, no write: effect reader seen [10,E] runs 2, two direct reads E E, c body 1", bands: STD,
    f: (r) => {
        const { s, c, st } = cleanThrow(r); c(); const seen = []; let runs = 0;
        r.effect(() => { runs++; try { seen.push(c()); } catch (e) { seen.push(tag(e)); } });
        st.armed = true; const w = thrown(() => s.set(2));
        const first = thrown(c), second = thrown(c);
        return { seen, runs, write: w, first, second, cbody: st.cbody };
    }, exp: { seen: [10, "E"], runs: 2, write: "none", first: "E", second: "E", cbody: 1 } });
f1.push({ id: "A14d", kind: "PIN", name: "cleanup throws E, no write, no reader: two direct reads E E, c body 1", bands: STD,
    f: (r) => {
        const { s, c, st } = cleanThrow(r); c();
        st.armed = true; s.set(2);
        const first = thrown(c), second = thrown(c);
        return { first, second, cbody: st.cbody };
    }, exp: { first: "E", second: "E", cbody: 1 } });
// A14p-peek / A14p-boxpeek (b188, PIN; passes on 91c507df): the cleanup throws E with no write; the handle was primed by a plain
// read (c() / c.get()), armed, s.set(2), then TWO c.peek() reads: both throw E, c body 1. Kills PEEKPLAIN (peekComputed's
// `if (!peek && ...) throw v;` plain throw: the first peek throws the raw wrapper value, the second returns, c body 2) on all 3 STD bands.
for (const box of [false, true]) {
    f1.push({ id: box ? "A14p-boxpeek" : "A14p-peek", kind: "PIN", name: "cleanup throws E, no write, two peeks: E E, c body 1", bands: STD,
        f: (r) => {
            const { s, c, st } = cleanThrow(r, box); if (box) c.get(); else c();
            st.armed = true; s.set(2);
            const first = thrown(() => c.peek()), second = thrown(() => c.peek());
            return { first, second, cbody: st.cbody };
        }, exp: { first: "E", second: "E", cbody: 1 } });
}
// F0C-peek / F0C-boxpeek (b188, PIN; test/110:1557 F0-C read by peek; seed gv 0x3FFFFFFD, its own band): c is primed by c.peek(), the
// write s.set(1) stales it, the next c.peek() runs the throwing cleanup ("ccl", which writes s). The node ends with version
// 0x3FFFFFFF and evalVersion -1 (the zero-floor sentinel). Kills PEEKZEROF (`f === 0 && !peek`: peek keeps evalVersion 0) and ZEROF
// on the one band; both give evalVersion 0.
for (const box of [false, true]) {
    f1.push({ id: box ? "F0C-boxpeek" : "F0C-peek", kind: "PIN", name: "seed 0x3FFFFFFD, cleanup throws ccl on the peek: version 0x3FFFFFFF, evalVersion -1", bands: [[0x3FFFFFFD, "gv0x3ffffffd"]],
        f: (r) => {
            const s = r.signal(0);
            const fn = () => { const v = s(); r.onCleanup(() => { s.set(s.peek() + 10); throw new Error("ccl"); }); return v; };
            const c = box ? r.computedBox(fn) : r.computed(fn);
            try { c.peek(); } catch (e) { /* the prime read does not throw */ }
            s.set(1);
            let th = "none"; try { c.peek(); } catch (e) { th = msg(e); }
            const node = r.snapshot().nodes.find((n) => n.id === r.nodeId(c));
            return { thrown: th, version: node ? node.version : null, evalVersion: node ? node.evalVersion : null };
        }, exp: { thrown: "ccl", version: 0x3FFFFFFF, evalVersion: -1 } });
}
// ---- ADDENDUM b187 rows (r2). Expected values: PLAN-ARG-E2.md ADDENDUM b187 as measured by TASK C0
// (.handoff/arg/e2/evidence/b187/C0-REPORT.md, probe187.mjs; 91c507df, b836fbbb and the three mutants). Bands: STD for every row.

// A13b (PIN, kills NOCONSUME on all 3 STD bands): after the delivery the public snapshot() value of c is E, never the wrapper
// (NOCONSUME leaves the wrapper in the slot: snapIsE false). 91c507df gives the same tuple.
f1.push({ id: "A13b", kind: "PIN", name: "after the delivery the snapshot value of c is E, not the wrapper", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r); c(); st.armed = true; s.set(2);
        const first = thrown(c);
        const node = r.snapshot().nodes.find((n) => n.id === r.nodeId(c));
        return { first, snapIsE: node !== undefined && node.value === E };
    }, exp: { first: "E", snapIsE: true } });
// A13b-peek / A13b-boxpeek (b188, PIN; passes on 91c507df: the plain E is cached): prime c() / c.get(), arm, s.set(2), first = a
// peek. The snapshot value of c is E, never the wrapper. Kills PEEKNOCONSUME (peek leaves the wrapper in the slot: snapIsE false)
// and PEEKTHROWWRAP (peek throws the wrapper, not E: first is the wrapper) on all 3 STD bands.
for (const box of [false, true]) {
    f1.push({ id: box ? "A13b-boxpeek" : "A13b-peek", kind: "PIN", name: "after the peek delivery the snapshot value of c is E, not the wrapper", bands: STD,
        f: (r) => {
            const { s, c, st } = base(r, box); if (box) c.get(); else c(); st.armed = true; s.set(2);
            const first = thrown(() => c.peek());
            const node = r.snapshot().nodes.find((n) => n.id === r.nodeId(c));
            return { first, snapIsE: node !== undefined && node.value === E };
        }, exp: { first: "E", snapIsE: true } });
}
// A11x (PIN, kills NOCOMPGUARD on all 3 STD bands): a nested computed frame (x) disposes the running effect h, and
// refreshComputed's finally restores currentObserver = the dead h; h then reads pending c. The COMPUTING test is what keeps the
// dead h unmarked. Under NOCOMPGUARD the dead h is marked and re-queued: ops [5,2,5] and thrown TypeError (computeFn undefined).
// 91c507df gives the same tuple as the target.
f1.push({ id: "A11x", kind: "PIN", name: "nested frame disposes the reader, dead observer reads pending c: no throw, seen [10,E], runs 2, ops [5,2]", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r);
        const g = r.signal(0), k = r.signal(0); let kill = false, h = null, runs = 0; const seen = [], ops = [];
        const x = r.computed(() => { k(); if (kill) h(); return 0; });
        h = r.effect(() => { runs++; g(); x(); try { seen.push(c()); } catch (e) { seen.push(tag(e)); } });
        const hid = r.nodeId(h);
        const off = r.onGraphMutation((op, a) => { if (a === hid && (op === 2 || op === 5)) ops.push(op); });
        kill = true; st.armed = true;
        const t = thrown(() => r.batch(() => { g.set(1); k.set(1); s.set(2); }));
        off();
        return { thrown: t, seen, runs, ops };
    }, exp: { thrown: "none", seen: [10, "E"], runs: 2, ops: [5, 2] } });
// A15 / A15n (RED vs 91c507df: {d 200, druns 1} / {thrown none, d 200, druns 1}; kills NOMARKEPOCH on gv0x40000010 and gv0x7fffff00
// ONLY: there the far floor makes refreshComputed's clean test pass, so the stamp markEpoch = globalVersion decides whether d
// re-pulls. Under NOMARKEPOCH: A15 {d "E", druns 1}, A15n {thrown "E", d "threw:E", druns 1}. gv1 matches the target by design
// and does NOT kill NOMARKEPOCH; the gv1 cell is a band control.) First read of d after a pre-walk left c's wrapper pending.
f1.push({ id: "A15", kind: "RED", name: "catching computed reader d, first read after a pre-walk: d 200, d runs 2", bands: STD,
    f: (r) => {
        const { c } = prewalked(r, false); let druns = 0;
        const d = r.computed(() => { druns++; try { return c(); } catch (e) { return tag(e); } });
        const v = val(d);
        return { d: v, druns };
    }, exp: { d: 200, druns: 2 } });
f1.push({ id: "A15n", kind: "RED", name: "non-catching computed reader d, first read after a pre-walk: no throw, d 200, d runs 2", bands: STD,
    f: (r) => {
        const { c } = prewalked(r, false); let druns = 0;
        const d = r.computed(() => { druns++; return c(); });
        const t = thrown(d); const v = val(d);
        return { thrown: t, d: v, druns };
    }, exp: { thrown: "none", d: 200, druns: 2 } });
// A6c-peek / A6c-boxpeek (X4 shape; PIN: passes on 91c507df and df50017f, FAILS on b836fbbb: runs 3, seen [E,200]; 3 STD bands). An effect peeks a
// pending c: the peek delivers E but does not mark the effect as a reader (no re-run). cAfter / cbody show the next read is the
// re-run. Kills PEEKMARK (delete the `!peek &&` guard) and PEEKARG (peekComputed passes no peek flag) on both rows; PEEKPULL-FN
// (sharedComputedPeek back to pullComputed) on A6c-peek; PEEKPULL-BOX (boxComputedPeek back to pullComputed) on A6c-boxpeek.
function a6c(r, box) {
    const { s, c, st } = base(r, box); if (box) c.get(); else c();
    const go = r.signal(0); let runs = 0; const seen = [];
    r.effect(() => { runs++; if (go() === 1) { try { seen.push(c.peek()); } catch (e) { seen.push(tag(e)); } } });
    st.armed = true; s.set(2); thrown(() => go.set(1));
    const cAfter = val(() => (box ? c.get() : c()));
    return { runs, seen, cAfter, cbody: st.cbody };
}
f1.push({ id: "A6c-peek", kind: "PIN", name: "effect peeks pending c: seen [E], runs 2, c after 200, c body 2", bands: STD,
    f: (r) => a6c(r, false), exp: { runs: 2, seen: ["E"], cAfter: 200, cbody: 2 } });
f1.push({ id: "A6c-boxpeek", kind: "PIN", name: "effect box.peek() on pending c: seen [E], runs 2, c after 200, c body 2", bands: STD,
    f: (r) => a6c(r, true), exp: { runs: 2, seen: ["E"], cAfter: 200, cbody: 2 } });
// A1b (RED vs 91c507df: seen [10,200], runs 2; kills GETPEEK on all 3 STD bands): A1 with a computedBox and box.get(); get stays a
// reader (marks the effect), unlike peek. GETPEEK (boxComputedGet calls peekComputed) would drop the re-run: runs 2.
f1.push({ id: "A1b", kind: "RED", name: "catching effect reads box.get(): seen [10,E,200], runs 3, c body 2", bands: STD,
    f: (r) => {
        const { s, c, st } = base(r, true); const seen = []; let runs = 0;
        r.effect(() => { runs++; try { seen.push(c.get()); } catch (e) { seen.push(tag(e)); } });
        st.armed = true; const t = thrown(() => s.set(2));
        return { seen, runs, cbody: st.cbody, thrown: t };
    }, exp: { seen: [10, "E", 200], runs: 3, cbody: 2, thrown: "none" } });
rows("ARG-E2 F1: a pending cleanup error reaches the next reader, which re-runs (D-b183-1)", f1);

// ======================================================================================================================
// S5 tooth rows (SHAPES.md S5 section; s5-tooth.mjs). PIN on 91c507df / S0 / S5; they kill S5-NOCHECK (the read closure's
// post-refresh `node.gen !== birthGen` check deleted): that mutant returns "R" (T2) and throws X (T3).
// ======================================================================================================================
describe("ARG-E2 S5 tooth: a read whose refresh disposed / recycled the node returns undefined", () => {
    it("[PIN] T1 the computed body disposes its own handle during the refresh: second read undefined, live 1", () => {
        const r = createRegistry();
        const s = r.signal(0);
        let kill = false;
        const c = r.computed(() => { const v = s(); if (kill) r.dispose(c); return "V" + v; });
        const first = c();
        kill = true; s.set(1);
        const second = c();
        assert.deepStrictEqual({ first, second, live: r.stats().activeNodes | 0 }, { first: "V0", second: undefined, live: 1 });
    });
    it("[PIN] T2 a dependency's body (c's pre-walk) disposes c and a fresh signal takes its slot: c() is undefined, never the resident's value (kills S5-NOCHECK)", () => {
        const r = createRegistry();
        const s = r.signal(0);
        let kill = false, c = null, fresh = null;
        const d = r.computed(() => { const v = s(); if (kill) { kill = false; r.dispose(c); fresh = r.signal("R"); } return v; });
        c = r.computed(() => d() + 1);
        const first = c();
        kill = true; s.set(1);
        const second = val(c);
        assert.deepStrictEqual({ first, second, freshRead: fresh() }, { first: 1, second: undefined, freshRead: "R" });
    });
    it("[PIN] T3 as T2 with a computed resident holding error X: c() is undefined, does not throw X (kills S5-NOCHECK)", () => {
        const r = createRegistry();
        const s = r.signal(0);
        const X = new Error("X");
        let kill = false, c = null, fresh = null;
        const d = r.computed(() => { const v = s(); if (kill) { kill = false; r.dispose(c); fresh = r.computed(() => { throw X; }); try { fresh(); } catch { /* resident now holds X */ } } return v; });
        c = r.computed(() => d() + 1);
        const first = c();
        kill = true; s.set(1);
        let second;
        try { second = c(); } catch (e) { second = "threw:" + (e === X ? "X" : String(e)); }
        assert.deepStrictEqual({ first, second }, { first: 1, second: undefined });
    });
    // b188 variants (PIN on 91c507df / b836fbbb / df50017f: before df50017f the peek ran through pullComputed's gen check). T2 / T3 with
    // the row's own reader for the prime and the second read; box variants use computedBox. Fresh registry plus the 3 STD bands.
    // Kills PEEKNOGEN (peekComputed's `const g = node.gen;` deleted) and PEEKGLATE (that line moved below the refresh) on the
    // peek / boxpeek rows; PULLNOGEN (pullComputed's gen capture deleted) on the boxget rows. All on all 4 bands.
    const TBANDS = [["fresh", "fresh"]].concat(STD);
    for (const rk of ["peek", "boxpeek", "boxget"]) {
        const box = rk !== "peek";
        for (const [gv, bl] of TBANDS) {
            it("[PIN] T2-" + rk + " a dependency's body disposes c and a fresh signal takes its slot: the " + rk + " read is undefined (" + bl + ")", () => {
                const r = gv === "fresh" ? createRegistry() : seeded(gv);
                const rd = READERS[rk];
                const s = r.signal(0);
                let kill = false, c = null, fresh = null;
                const d = r.computed(() => { const v = s(); if (kill) { kill = false; r.dispose(c); fresh = r.signal("R"); } return v; });
                c = box ? r.computedBox(() => d() + 1) : r.computed(() => d() + 1);
                const first = val(() => rd(c));
                kill = true; s.set(1);
                const second = val(() => rd(c));
                assert.deepStrictEqual({ first, second, freshRead: fresh() }, { first: 1, second: undefined, freshRead: "R" });
            });
            it("[PIN] T3-" + rk + " as T2 with a computed resident holding error X: the " + rk + " read is undefined, does not throw X (" + bl + ")", () => {
                const r = gv === "fresh" ? createRegistry() : seeded(gv);
                const rd = READERS[rk];
                const s = r.signal(0);
                const X = new Error("X");
                let kill = false, c = null, fresh = null;
                const d = r.computed(() => { const v = s(); if (kill) { kill = false; r.dispose(c); fresh = r.computed(() => { throw X; }); try { fresh(); } catch { /* resident now holds X */ } } return v; });
                c = box ? r.computedBox(() => d() + 1) : r.computed(() => d() + 1);
                const first = val(() => rd(c));
                kill = true; s.set(1);
                let second;
                try { second = rd(c); } catch (e) { second = "threw:" + (e === X ? "X" : String(e)); }
                assert.deepStrictEqual({ first, second }, { first: 1, second: undefined });
            });
        }
    }
});

// ======================================================================================================================
// F4: revertBlocked (B1 item 5). The oracle is the witness scheduler-call count and what the effect saw. "verBump" = s's
// snapshot() version after the batch differs from before: true = the set back was blocked (new version + mark), false = it
// reverted. Scenario code is f4.mjs; see its header for how each one-line plan row was read.
// ======================================================================================================================
function ver(r, id) {
    try { const n = r.snapshot().nodes.find((x) => x.id === id); return n ? n.version : "noNode"; } catch (e) { return "snapErr:" + msg(e); }
}
function f4(r, throwCleanup, stopAfterRun2) {
    const s = r.signal(0);
    const h = r.computed(() => { s.set(2); return 0; }); let t = null, calls = 0, run = 0; const seen = [];
    r.effect(() => { run++; seen.push(s()); if (run === 2) { r.untrack(() => h()); if (throwCleanup) r.onCleanup(() => { throw new Error("b"); }); } }, { scheduler(x) { t = x; calls++; } });
    t();
    const sId = r.nodeId(s); const v0 = ver(r, sId);
    let batchErr = "none";
    try { r.batch(() => { s.set(1); t(); if (!stopAfterRun2) { try { t(); } catch { /* run 3 throws its cleanup */ } } s.set(0); }); } catch (e) { batchErr = msg(e); }
    const callsAfterBatch = calls; let err = null; try { t(); } catch (e) { err = e.message; }
    const v1 = ver(r, sId);
    const afterThunk = [...seen]; s.set(5); try { t(); } catch { /* ignore */ }
    return { seenAtEnd: afterThunk, callsAfterBatch, err, finalSeen: seen, s: s(), verBump: v1 !== v0, batchErr };
}
function plainRevert(r) {
    const s = r.signal(0); let runs = 0; const seen = [];
    r.effect(() => { runs++; seen.push(s()); });
    const sId = r.nodeId(s); const v0 = ver(r, sId);
    let batchErr = "none";
    try { r.batch(() => { s.set(1); s.set(0); }); } catch (e) { batchErr = msg(e); }
    return { runs, seen, verBump: ver(r, sId) !== v0, batchErr };
}
function dormant(r, ahead) {
    const s0 = r.signal(0); let runs0 = 0;
    const e0 = r.effect(() => { runs0++; s0(); });
    const sId = r.nodeId(s0), eId = r.nodeId(e0);
    const snap = r.snapshot();
    const gv = (snap.gv + ahead) | 0;
    const H = {}; let runs = 0; const seen = [];
    let rr = null, restoreErr = null;
    try { rr = r.restore(Object.assign({}, snap, { gv: gv === 0 ? 1 : gv }), { fnsById: { [eId]: () => { runs++; seen.push(H[sId]()); } }, handles: H }); } catch (e) { restoreErr = msg(e); }
    if (rr === null) return { restoreErr };
    // reach guard (b188-2): the restored stamp's distance to the restored gv, taken before the batch (preBatchEvals = gv, so x = -ahead)
    const sn0 = rr.snapshot(); const en0 = sn0.nodes.find((x) => x.id === eId);
    const stampDist = en0 ? ((en0.evalVersion - sn0.gv) | 0) : "noNode";
    const s = H[sId]; const v0 = ver(rr, sId);
    let batchErr = "none";
    try { rr.batch(() => { s.set(1); s.set(0); }); } catch (e) { batchErr = msg(e); }
    return { extraRuns: runs, seen, verBump: ver(rr, sId) !== v0, batchErr, stampDist };
}
const f4rows = [];
const B7 = [[0x70000000, "gv0x70000000"]];   // second straddle band: 0x70000000 + 0x1FFFFFF0 / 0x20000000 / 0x20000010 all wrap int32
// R0 (RED, kills F4-BOTH): probe.mjs shape. Teeth callsAfterBatch 4 (frozen 1) and verBump true (frozen false); seenAtEnd
// [0,1,0] equals frozen, exact but not a tooth.
f4rows.push({ id: "R0", kind: "RED", name: "probe shape, throwing cleanup (far-floor marker): 4 calls, seenAtEnd [0,1,0], version bumped", bands: STD,
    f: (r) => f4(r, true, false), exp: { callsAfterBatch: 4, seenAtEnd: [0, 1, 0], verBump: true } });
f4rows.push({ id: "R1", kind: "PIN", name: "probe shape, no throw (control): 4 calls, seenAtEnd [0,1,2,0], final [0,1,2,0,5], version bumped", bands: STD,
    f: (r) => f4(r, false, false), exp: { callsAfterBatch: 4, seenAtEnd: [0, 1, 2, 0], finalSeen: [0, 1, 2, 0, 5], verBump: true } });
// R2 (PIN, kills ARGON-Q): a plain revert stays a revert.
f4rows.push({ id: "R2", kind: "PIN", name: "plain revert batch{set(1); set(0)}: runs 1, seen [0], no version bump", bands: STD,
    f: (r) => plainRevert(r), exp: { runs: 1, seen: [0], verBump: false, batchErr: "none" } });
// R3 (RED on the 3 standard bands, kills F4-Z; gvNeg is PIN: frozen already blocks when g0 is a negative int32). Tooth: verBump
// only; calls 3 and seenAtEnd [0,1,0] equal frozen.
f4rows.push({ id: "R3", kind: "RED", name: "stale re-queue (evalVersion 0 + QUEUED) at the set back: blocked, calls 3, seenAtEnd [0,1,0], version bumped", bands: STD.concat(NEG),
    f: (r) => f4(r, false, true), exp: { callsAfterBatch: 3, seenAtEnd: [0, 1, 0], verBump: true } });
// R4 (RED): the far-floor marker and g0 on opposite sides of the int32 wrap. Kills REVPLAIN and NOFAR (3 WRAP bands); not F4-PLAIN / F4-W
// (a marker ~2^30 behind is blocked under the plain compare too, through the x > 0 arm: only the blocking arm differs).
f4rows.push({ id: "R4", kind: "RED", name: "far-floor marker across the int32 wrap: 4 calls, seenAtEnd [0,1,0], version bumped", bands: WRAP,
    f: (r) => f4(r, true, false), exp: { callsAfterBatch: 4, seenAtEnd: [0, 1, 0], verBump: true } });
// R4c (PIN, band control).
f4rows.push({ id: "R4c", kind: "PIN", name: "stamp arm across the int32 wrap (control): 4 calls, seenAtEnd [0,1,2,0], final [0,1,2,0,5], version bumped", bands: WRAP,
    f: (r) => f4(r, false, false), exp: { callsAfterBatch: 4, seenAtEnd: [0, 1, 2, 0], finalSeen: [0, 1, 2, 0, 5], verBump: true } });
// R5 (RED, KNOWN pin): a dormant stamp more than 2^29 behind g0 is blocked, exactly 1 extra run which sees 0. RED on 91c507df on all 4
// bands (STD + gv0x70000000). With R5e it kills F4-W on gv0x7fffff00 and gv0x70000000 (the bands where the stamp-to-capture distance wraps).
f4rows.push({ id: "R5", kind: "RED", name: "dormant stamp 0x20000010 behind (KNOWN +1 run): extraRuns 1, seen [0], version bumped", bands: STD.concat(B7),
    f: (r) => dormant(r, 0x20000010), exp: { extraRuns: 1, seen: [0], verBump: true, batchErr: "none" } });
f4rows.push({ id: "R5c", kind: "PIN", name: "dormant stamp 0x1FFFFFF0 behind (boundary control): reverts, 0 extra runs", bands: STD.concat(B7),
    f: (r) => dormant(r, 0x1FFFFFF0), exp: { extraRuns: 0, seen: [], verBump: false, batchErr: "none" } });
// R5c is the PIN control of R5; with R5ec it kills F4-PLAIN on gv0x7fffff00 and gv0x70000000 (CHANGED there, same on the other two bands).
// R5e (RED on 91c507df, 4 bands): the exact edge, stamp 0x20000000 behind (stampDist -0x20000000 is the reach guard). Blocked: 1 extra
// run which sees 0. Kills FAREDGE (the edge made non-blocking) on all 4 bands.
f4rows.push({ id: "R5e", kind: "RED", name: "dormant stamp exactly 0x20000000 behind (edge, KNOWN +1 run): extraRuns 1, seen [0], version bumped, stampDist -0x20000000", bands: STD.concat(B7),
    f: (r) => dormant(r, 0x20000000), exp: { extraRuns: 1, seen: [0], verBump: true, batchErr: "none", stampDist: -0x20000000 } });
// R5ec (PIN, 4 bands): 0x1FFFFFFF behind, one inside the edge: reverts, 0 extra runs (stampDist -0x1FFFFFFF). Kills FAREDGE-IN (`x <=
// -0x1FFFFFFF`: blocks one too early) on all 4 bands; with R5c it kills F4-PLAIN on gv0x7fffff00 and gv0x70000000.
f4rows.push({ id: "R5ec", kind: "PIN", name: "dormant stamp 0x1FFFFFFF behind (inside the edge): reverts, 0 extra runs, stampDist -0x1FFFFFFF", bands: STD.concat(B7),
    f: (r) => dormant(r, 0x1FFFFFFF), exp: { extraRuns: 0, seen: [], verBump: false, batchErr: "none", stampDist: -0x1FFFFFFF } });
rows("ARG-E2 F4: revertBlocked keeps a set back from reverting past a needs-run marker (B1 item 5)", f4rows);

// ======================================================================================================================
// F5: effect() creation supersede (D-b183-2). Scenario code is f5.mjs.
// ======================================================================================================================
const ptrOf = (h) => { const k = Object.getOwnPropertySymbols(h).find((x) => x.description === "node_ptr"); return k ? h[k] : undefined; };
const genOf = (h) => { const k = Object.getOwnPropertySymbols(h).find((x) => x.description === "node_gen"); return k ? h[k] : undefined; };
function writerOf(r, s) { return r.computed(() => { if (s.peek() === 0) s.set(1); return 0; }); }
function body5A(r, s, writer, st) {
    return () => { st.runs++; const v = s(); r.untrack(() => writer()); if (v === 0) throw new Error("stale-zero"); st.eLog.push(v); };
}
function thrown5(fn) { try { fn(); return "none"; } catch (e) { return e instanceof AggregateError ? "Agg[" + e.errors.map(msg).join(",") + "]" : msg(e); } }
function case5A(r) {
    // pass 1 throws after a stale read, the immediate re-run succeeds
    const s = r.signal(0);
    const writer = r.computed(() => { if (s.peek() === 0) s.set(1); return 0; });
    const eLog = []; let runs = 0, threw = "none", h = null;
    try {
        h = r.effect(() => { runs++; const v = s(); r.untrack(() => writer()); if (v === 0) throw new Error("stale-zero"); eLog.push(v); });
    } catch (e) { threw = msg(e); }
    const live = r.stats().effects, handle = typeof h === "function";
    const before = runs; let w = "none"; try { s.set(5); } catch (e) { w = msg(e); }
    return { threw, handle, live, eLog, runsAfterWrite: runs - before, write: w };
}
function case5B(r, inBatch) {
    // pass 1 ok, the immediate re-run throws
    const s = r.signal(0);
    const w = r.computed(() => { if (s.peek() === 0) s.set(1); return 0; });
    const log = []; let threw = "none";
    const create = () => r.effect(() => { const v = s(); r.untrack(() => w()); log.push(v); if (v === 1) throw new Error("rerun-boom"); });
    try { inBatch ? r.batch(create) : create(); } catch (e) { threw = msg(e); }
    return { threw, log, live: r.stats().effects, hasObs: r.hasObservers(s) };
}
function staleOkA(r) {
    const s = r.signal(0); const writer = writerOf(r, s); const aLog = [];
    const a = r.effect(() => { const v = s(); r.untrack(() => writer()); aLog.push(v); });
    return { s, a, aLog };
}
// The B0 rows (F5-A, F5-B, F5-Bt) ran on a plain createRegistry() with no restore seed; only that band was measured. The
// scheduler-less rows below the line were measured at all three bands. `rows()` seeds through seeded(null) for the null band
// (one extra signal(0) before the scenario), so the B0 rows use their own plain band: gvNull = createRegistry().
function plainRegistry() { return createRegistry(); }
const f5 = [];
f5.push({ id: "F5-A", kind: "RED", name: "pass 1 throws, immediate re-run ok: no throw, handle live, live 1, eLog [1,5], later write +1 run", bands: [[null, "fresh"]],
    f: () => case5A(plainRegistry()), exp: { threw: "none", handle: true, live: 1, eLog: [1, 5], runsAfterWrite: 1 } });
// F5-B (PIN, kills SUPERSEDE-ALL): pass 1 ok, the re-run throws: effect() throws it and disposes.
f5.push({ id: "F5-B", kind: "PIN", name: "pass 1 ok, re-run throws: throws rerun-boom, log [0,1], live 0, no observer", bands: [[null, "fresh"]],
    f: () => case5B(plainRegistry(), false), exp: { threw: "rerun-boom", log: [0, 1], live: 0, hasObs: false } });
f5.push({ id: "F5-Bt", kind: "PIN", name: "same inside a batch: throws rerun-boom, log [0,1], live 1, observer kept (unchanged vs frozen)", bands: [[null, "fresh"]],
    f: () => case5B(plainRegistry(), true), exp: { threw: "rerun-boom", log: [0, 1], live: 1, hasObs: true } });
f5.push({ id: "F5-S", kind: "PIN", name: "5A with a sync scheduler (D-b186-4): throws stale-zero and disposes, as 91c507df", bands: STD,
    f: (r) => {
        const s = r.signal(0); const writer = writerOf(r, s); const st = { runs: 0, eLog: [] };
        let threw = "none", h = null;
        try { h = r.effect(body5A(r, s, writer, st), { scheduler: (x) => x() }); } catch (e) { threw = msg(e); }
        const live = r.stats().effects, handle = typeof h === "function";
        const before = st.runs; let w = "none"; try { s.set(5); } catch (e) { w = msg(e); }
        return { threw, handle, live, eLog: st.eLog, runsAfterWrite: st.runs - before, write: w };
    }, exp: { threw: "stale-zero", handle: false, live: 0, eLog: [1], runsAfterWrite: 0 } });
// P1 (PIN, kills M-INT0): restored registry with nextId 0 -> the effect gets id 0; a plain throw (no witness) still disposes.
f5.push({ id: "P1", kind: "PIN", name: "restored registry nextId 0: a plain first-run throw still throws and disposes", bands: [[null, "fresh"]],
    f: () => {
        const r0 = createRegistry();
        const r2 = r0.restore(Object.assign({}, r0.snapshot(), { nextId: 0 }), { fnsById: {}, handles: {} });
        let threw = "none", h = null;
        try { h = r2.effect(() => { throw new Error("plain"); }); } catch (e) { threw = msg(e); }
        return { threw, handle: typeof h === "function", live: r2.stats().effects };
    }, exp: { threw: "plain", handle: false, live: 0 } });
// P3 / P3b (PIN, D-b186-4): the scheduler's own error throws and disposes, as 91c507df.
f5.push({ id: "P3", kind: "PIN", name: "pass 1 ok + stale re-run ok, sync scheduler throws X on its first call: throws sched-X, disposed", bands: [[null, "fresh"]],
    f: () => {
        const r = createRegistry(); const s = r.signal(0); const writer = writerOf(r, s); const log = [];
        let threw = "none", h = null, n = 0;
        try { h = r.effect(() => { const v = s(); r.untrack(() => writer()); log.push(v); }, { scheduler: (x) => { const first = n++ === 0; x(); if (first) throw new Error("sched-X"); } }); }
        catch (e) { threw = msg(e); }
        return { threw, handle: typeof h === "function", live: r.stats().effects, log };
    }, exp: { threw: "sched-X", handle: false, live: 0, log: [0, 1] } });
f5.push({ id: "P3b", kind: "PIN", name: "5A body throws stale-zero, scheduler catches it and throws X2: throws sched-X2, disposed", bands: [[null, "fresh"]],
    f: () => {
        const r = createRegistry(); const s = r.signal(0); const writer = writerOf(r, s);
        let threw = "none", h = null, n = 0;
        const sched = (x) => { const f = n++ === 0; try { x(); } catch (e) { if (f) throw new Error("sched-X2"); throw e; } };
        try { h = r.effect(body5A(r, s, writer, { runs: 0, eLog: [] }), { scheduler: sched }); } catch (e) { threw = msg(e); }
        return { threw, handle: typeof h === "function", live: r.stats().effects };
    }, exp: { threw: "sched-X2", handle: false, live: 0 } });
// F5-D (PIN): the stale re-run is the deferred 2nd scheduler call (evalVersion 0): E1 thrown, effect disposed.
f5.push({ id: "F5-D", kind: "PIN", name: "5A, deferred 2nd scheduler call: throws stale-zero, disposed, thunk later runs nothing", bands: STD,
    f: (r) => {
        const s = r.signal(0); const writer = writerOf(r, s); const st = { runs: 0, eLog: [] };
        let threw = "none", h = null, calls = 0, saved = null;
        const scheduler = (x) => { calls++; if (calls === 1) x(); else saved = x; };
        try { h = r.effect(body5A(r, s, writer, st), { scheduler }); } catch (e) { threw = msg(e); }
        const live = r.stats().effects, handle = typeof h === "function", runsAtThrow = st.runs, callsAtThrow = calls;
        let late = "none"; if (saved !== null) { try { saved(); } catch (e) { late = msg(e); } }
        return { threw, handle, live, eLog: st.eLog, runsAtThrow, callsAtThrow, lateThunk: late, runsAfterLate: st.runs - runsAtThrow };
    }, exp: { threw: "stale-zero", handle: false, live: 0, eLog: [], runsAtThrow: 1, callsAtThrow: 2, lateThunk: "none", runsAfterLate: 0 } });
// F5-Fl (PIN vs frozen): case 5A created inside an outer effect's body while that outer effect runs in a flush.
f5.push({ id: "F5-Fl", kind: "PIN", name: "5A created in a flush: inner throws stale-zero, inner disposed, outer live", bands: STD,
    f: (r) => {
        const s = r.signal(0); const writer = writerOf(r, s); const st = { runs: 0, eLog: [] };
        const go = r.signal(0); let threw = "none", made = false, h = null;
        r.effect(() => { if (go() === 1 && !made) { made = true; try { h = r.effect(body5A(r, s, writer, st)); } catch (e) { threw = msg(e); } } });
        let w = "none"; try { go.set(1); } catch (e) { w = msg(e); }
        const live = r.stats().effects, handle = typeof h === "function", runsAtEnd = st.runs;
        let w2 = "none"; try { s.set(5); } catch (e) { w2 = msg(e); }
        return { threw, handle, live, eLog: st.eLog, innerRuns: runsAtEnd, write: w, runsAfterWrite: st.runs - runsAtEnd, write2: w2 };
    }, exp: { threw: "stale-zero", handle: false, live: 1, eLog: [], innerRuns: 1, write: "none", runsAfterWrite: 0, write2: "none" } });
// F5-R (PIN, kills WIT-BOTH): witness on a recycled slot. createNode gives every allocation a fresh id (D0g-4), so the recycled
// slot has the same node object, a NEW id and a moved gen; a plain throw still throws and disposes.
f5.push({ id: "F5-R", kind: "PIN", name: "recycled slot + witness, plain throw: still throws and disposes (sameSlot true, sameId false, gen moved)", bands: STD,
    f: (r) => {
        const { a, aLog } = staleOkA(r);
        const aId = r.nodeId(a), aGen = genOf(a), aPtr = ptrOf(a);
        a();
        let threw = "none", bId = null, bGen = null, bPtr = null, h = null;
        try { h = r.effect(() => { const o = r.getOwner(); bId = o ? o.id : null; bGen = o ? genOf(o) : null; bPtr = o ? ptrOf(o) : null; throw new Error("plain"); }); } catch (e) { threw = msg(e); }
        return { aLog, threw, handle: typeof h === "function", live: r.stats().effects, sameSlot: bPtr === aPtr, sameId: bId === aId, genMoved: bGen !== aGen };
    }, exp: { aLog: [0, 1], threw: "plain", handle: false, live: 0, sameSlot: true, sameId: false, genMoved: true } });
// F5-R2 (PIN): A stays live, B takes a fresh slot with the same gen as A but a different id; a plain throw still disposes.
f5.push({ id: "F5-R2", kind: "PIN", name: "fresh slot, same gen as A, other id: plain throw still disposes, A stays live", bands: STD,
    f: (r) => {
        const { a, aLog } = staleOkA(r);
        const aId = r.nodeId(a), aGen = genOf(a);
        let threw = "none", bId = null, bGen = null, h = null;
        try { h = r.effect(() => { const o = r.getOwner(); bId = o ? o.id : null; bGen = o ? genOf(o) : null; throw new Error("plain"); }); } catch (e) { threw = msg(e); }
        return { aLog, threw, handle: typeof h === "function", live: r.stats().effects, sameId: bId === aId, sameGen: bGen === aGen };
    }, exp: { aLog: [0, 1], threw: "plain", handle: false, live: 1, sameId: false, sameGen: true } });
// F5-W (PIN vs frozen): deferred first run + a runWithOwner pre-run cleanup; first-thunk error is an AggregateError.
f5.push({ id: "F5-W", kind: "PIN", name: "deferred scheduler first run + runWithOwner pre-run cleanup: unchanged", bands: STD,
    f: (r) => {
        const s = r.signal(0); const writer = writerOf(r, s); const st = { runs: 0, eLog: [] };
        let calls = 0, saved = null;
        const h = r.effect(body5A(r, s, writer, st), { scheduler: (x) => { calls++; saved = x; } });
        const rwo = thrown5(() => r.runWithOwner(h, () => r.onCleanup(() => { throw new Error("pre-cl"); })));
        const t1 = thrown5(() => saved()); const runs1 = st.runs, calls1 = calls, live1 = r.stats().effects;
        const t2 = thrown5(() => saved()); const runs2 = st.runs, calls2 = calls;
        const w = thrown5(() => s.set(5)); const t3 = thrown5(() => saved());
        return { rwo, t1, runs1, calls1, live1, t2, runs2, calls2, write: w, t3, runs3: st.runs, calls3: calls, eLog: st.eLog, live: r.stats().effects };
    }, exp: { rwo: "none", t1: "Agg[pre-cl,stale-zero]", runs1: 1, calls1: 2, live1: 1, t2: "none", runs2: 2, calls2: 2, write: "none", t3: "none", runs3: 3, calls3: 3, eLog: [1, 5], live: 1 } });
// TT (PIN): throw-throw: pass 1 throws stale-zero, the immediate re-run throws rerun-boom2: effect() throws it and disposes.
f5.push({ id: "TT", kind: "PIN", name: "throw-throw 5A shape: throws rerun-boom2, disposed, runs 2, no observer", bands: STD,
    f: (r) => {
        const s = r.signal(0); const writer = writerOf(r, s); let runs = 0;
        let threw = "none", h = null;
        try { h = r.effect(() => { runs++; const v = s(); r.untrack(() => writer()); if (v === 0) throw new Error("stale-zero"); throw new Error("rerun-boom2"); }); } catch (e) { threw = msg(e); }
        return { threw, handle: typeof h === "function", live: r.stats().effects, runs, hasObs: r.hasObservers(s) };
    }, exp: { threw: "rerun-boom2", handle: false, live: 0, runs: 2, hasObs: false } });
// F5-DD / F5-DDr / F5-DS (b188, PIN on 91c507df / b836fbbb / df50017f; STD bands; values measured by T0). The first pass of effect h
// throws stale-zero after a stale read; the immediate re-run succeeds and then disposes h (aOwner = getOwner() of h) in some way, so
// the supersede must not hand back the dead handle: effect() still throws stale-zero and returns no handle.
//   F5-DD: a second effect X disposes h after h's re-run (t.set(1) wakes X in the same drain). Kills GENBOTH and TRIPLE.
//   F5-DDr: as F5-DD plus r.signal(0) after the dispose (the slot is recycled by a signal with evalVersion 0). Kills TRIPLE only
//           (GENBOTH keeps requeue's evalVersion !== 0 test and survives it).
//   F5-DS: no X effect; the re-run disposes its own effect (r.dispose(aOwner) in place of t.set(1)); live 0. Kills TRIPLE.
function f5dd(r, mode) {
    const s = r.signal(0), tg = r.signal(0); const writer = writerOf(r, s);
    let k = false, aOwner = null; const log = [];
    if (mode !== "DS") r.effect(() => { if (tg() === 1 && !k) { k = true; r.dispose(aOwner); if (mode === "DDr") r.signal(0); } });
    let threw = "none", h = null;
    try {
        h = r.effect(() => {
            aOwner = r.getOwner(); const v = s(); r.untrack(() => writer());
            if (v === 0) throw new Error("stale-zero");
            if (mode === "DS") r.dispose(aOwner); else tg.set(1);
            log.push(v);
        });
    } catch (e) { threw = msg(e); }
    return { threw, handle: typeof h === "function", log, live: r.stats().effects };
}
f5.push({ id: "F5-DD", kind: "PIN", name: "5A, a later effect disposes h after the re-run: throws stale-zero, no handle, log [1], live 1 (X)", bands: STD,
    f: (r) => f5dd(r, "DD"), exp: { threw: "stale-zero", handle: false, log: [1], live: 1 } });
f5.push({ id: "F5-DDr", kind: "PIN", name: "F5-DD + slot recycled by r.signal(0): throws stale-zero, no handle, log [1], live 1", bands: STD,
    f: (r) => f5dd(r, "DDr"), exp: { threw: "stale-zero", handle: false, log: [1], live: 1 } });
f5.push({ id: "F5-DS", kind: "PIN", name: "5A, the re-run disposes its own effect (no X): throws stale-zero, no handle, log [1], live 0", bands: STD,
    f: (r) => f5dd(r, "DS"), exp: { threw: "stale-zero", handle: false, log: [1], live: 0 } });
// The three plain-registry rows must not be seeded: run them through a local describe instead of rows().
{
    const plain = f5.filter((x) => x.bands[0][1] === "fresh");
    const seededRows = f5.filter((x) => x.bands[0][1] !== "fresh");
    describe("ARG-E2 F5: B0 rows on a plain registry (D-b183-2)", () => {
        for (const { id, kind, name, f, exp } of plain) {
            it("[" + kind + "] " + id + " " + name, () => {
                assert.deepStrictEqual(pick(f(), Object.keys(exp)), exp);
            });
        }
    });
    rows("ARG-E2 F5: a successful immediate re-run supersedes the first pass's error (D-b183-2)", seededRows);
}

// ======================================================================================================================
// Child-process rows: GC, MEM, RET. Flags pinned as test/110 (A8_FLAGS): --expose-gc, --single-threaded, semi-space 1 MB both
// ways, and the child refuses to measure when a flag is missing (exit 3).
// ======================================================================================================================
const HEAP_WINDOW = new URL("../bench/torture/helpers/heap-window.mjs", import.meta.url).href;
const A8_FLAGS = ["--expose-gc", "--single-threaded", "--min-semi-space-size=1", "--max-semi-space-size=1"];

function runChild(src, flags, cwd) {
    const res = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", src], {
        cwd, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL",
    });
    assert.equal(res.error, undefined, "spawn error: " + (res.error && res.error.message));
    assert.equal(res.signal, null, "child killed by " + res.signal);
    assert.equal(res.status, 0, "child status " + res.status + "\n" + String(res.stderr || "").split("\n").slice(-12).join("\n"));
    const line = res.stdout.split("\n").filter((l) => l.startsWith("RESULT ")).pop();
    assert.ok(line, "no RESULT line:\n" + res.stdout + res.stderr);
    return JSON.parse(line.slice(7));
}

// ---- GC: 10,000 S1 cycles through an effect reader (pre-allocated error) ----
// Budget (PLAN GC row, b186-5 "unchanged"): window bytes <= the one-rethrow reference (the test/110 A4 reference loop: N
// one-level catch-and-rethrows of the same pre-allocated error, measured in the same child) + 48 B per cycle (the wrapper),
// plus the A4 bracket tolerance 64 B. gc major 0. Counts are the A1 shape scaled by N: per cycle the reader effect runs twice
// (the error run and the re-run), c's body runs once, the effect catches boom once. Must-fail controls: +{} per cycle (bytes)
// must exceed the budget; +8-field object per cycle (scavenge) must scavenge.
const CHILD_GC = `
import { measureWindows } from ${JSON.stringify(HEAP_WINDOW)};
import { createRegistry } from ${JSON.stringify(ENGINE_URL)};
for (const f of ${JSON.stringify(A8_FLAGS)}) {
    if (!process.execArgv.includes(f)) { console.error("GC child: " + f + " is not in execArgv"); process.exit(3); }
}
const N = 10000, WARM = 4, CYC = 12;
const CTLN = 5000;                     // bytes control runs N/2 cycles per window so real + 96 B stays under the 1 MiB semi-space
const boom = new Error("boom");
const CNT = new Int32Array(8);         // [c body runs, cycles, reader runs, boom caught, wrong errors, set threw]
let SINK = null;                       // module scope: a dead local would be escape-eliminated
function make(control) {
    const r = createRegistry();
    const p = r.signal(0);
    const cl = () => { p.set(p.peek() + 1); throw boom; };   // hoisted: one closure per make()
    const c = r.computed(() => { p(); CNT[0]++; r.onCleanup(cl); return 1; });
    r.effect(() => { CNT[2]++; try { c(); } catch (e) { if (e === boom) CNT[3]++; else CNT[4]++; } });
    let k = 2;
    return () => {
        const n = control === 1 ? CTLN : N;
        for (let i = 0; i < n; i++) {
            k += 2;
            try { p.set(k); } catch (e) { CNT[5]++; }
            CNT[1]++;
            if (control === 1) SINK = {};
            else if (control === 2) SINK = { a: i, b: k, c: i, d: k, e: i, f: k, g: i, h: k };
        }
    };
}
function oneLevel() { try { throw boom; } catch (err) { throw err; } }
function makeRef() {
    return () => {
        for (let i = 0; i < N; i++) {
            try { oneLevel(); } catch (e) { if (e !== boom) CNT[4]++; }
        }
    };
}
const ref = await measureWindows(makeRef(), { warmup: WARM, cycles: CYC });
CNT.fill(0);
const real = await measureWindows(make(0), { warmup: WARM, cycles: CYC });
const realCnt = Array.from(CNT);
CNT.fill(0);
const ctlB = await measureWindows(make(1), { warmup: WARM, cycles: CYC });
const ctl = await measureWindows(make(2), { warmup: WARM, cycles: CYC });
console.log("RESULT " + JSON.stringify({ N, CTLN, ref, real, ctlB, ctl, realCnt, sinkSet: SINK !== null }));
`;
const GC_WRAP_BUDGET = 48;   // B per cycle over the A4 reference (PLAN GC row)
const GC_TOL = 64;           // A4 bracket tolerance per window (test/110 S1_TOL)

describe("ARG-E2 GC: 10,000 S1 cycles through an effect reader cost the rethrow plus at most one wrapper", () => {
    it("[RED] GC window bytes <= reference + 48 B/cycle (+64 B bracket), major 0, counts exact; +{} control exceeds the budget; scavenge control scavenges", () => {
        const o = runChild(CHILD_GC, A8_FLAGS, undefined);
        if (process.env.E2_DEBUG) console.log("GCDBG " + JSON.stringify(o));
        const [cbody, cycles, readerRuns, boomCaught, wrong, setThrew] = o.realCnt;
        assert.equal(wrong, 0, "the reader caught something other than the cleanup's error");
        assert.equal(setThrew, 0, "a catching reader must not make set throw");
        // A1 shape scaled: creation run + 2 reader runs per cycle; c body: creation + 1 per cycle; E seen once per cycle.
        assert.equal(readerRuns, 2 * cycles + 1, "reader runs " + readerRuns + " vs cycles " + cycles);
        assert.equal(cbody, cycles + 1, "c body runs " + cbody + " vs cycles " + cycles);
        assert.equal(boomCaught, cycles, "E delivered once per cycle");
        assert.equal(o.ref.nan, 0);
        assert.ok(o.ref.clean >= 12 - 4, "reference clean windows " + o.ref.clean);
        assert.equal(o.real.nan, 0);
        assert.equal(o.real.major, 0);
        assert.equal(o.real.minor, 0, "the real loop scavenged: window bytes would read low");
        // Every real window is "tainted" (a code-space change in each window under the optimizing tiers, measured: 12 of 12), so
        // the bound uses the largest window delta, clean or tainted: an upper bound that includes any JIT bytes.
        const hi = (w) => Math.max(w.max ?? -Infinity, w.taintMax ?? -Infinity);
        assert.ok(Number.isFinite(hi(o.real)), "no measurable real window");
        assert.ok(hi(o.real) - o.ref.max <= GC_WRAP_BUDGET * o.N + GC_TOL, "engine window max " + hi(o.real) + " vs reference max " + o.ref.max);
        // must-fail controls
        assert.equal(o.sinkSet, true);
        assert.equal(o.ctlB.minor, 0, "bytes control scavenged: its window bytes would not be comparable");
        // per-cycle compare (the control ran CTLN cycles per window): control B/cycle must exceed ref B/cycle + 48
        assert.ok(hi(o.ctlB) / o.CTLN - o.ref.max / o.N > GC_WRAP_BUDGET, "bytes control stayed inside the budget: " + hi(o.ctlB) / o.CTLN + " vs ref " + o.ref.max / o.N);
        assert.ok(o.ctl.minor > 0, "scavenge control minor " + o.ctl.minor);
    });
});

// ---- MEM: retained heap per computed() handle (b186-5; D-b188-2, option (b): in-child reference) ----
// No per-Node byte constant. The MEM child loads three builds and measures them interleaved, 5 rounds:
//   ref  = test/fixtures/Signal-91c507df.js, a vendored byte-identical copy of the frozen 91c507df build (CI has no .handoff/);
//          the child fails closed (exit 4) unless its sha256/8 is 91c507df.
//   eng  = the engine under test (ENGINE_URL).
//   s1v  = the must-fail control, EXECUTED: the fixture text with the S1v edit applied (count-checked, exactly one match each).
// Per round, per build (order rotated each round): settle (gc until stable), used, N = 10000 computed(), settle, used; B/handle =
// delta / N, where used = bytes used in the four JS-object heap spaces (see "Spaces" below). Every delta must be > 0 (a delta
// <= 0 means the window did not measure: the row FAILS, a test bug, never re-run).
// Gate: median over rounds of (eng - ref) <= +0.5 B per handle, one-sided; median of (s1v - ref) >= +4 B (control).
// S1v mechanism (shapes/mkshapes.cjs S1v, SHAPES.md S1v: computed()'s read closure captures one more function-scoped `var`, so the
// function context of computed() gains one slot per handle; measured +8.00 B on 91c507df-era shapes). The original aliased
// throwComputedError, which does not exist in 91c507df; the port captures refreshComputed instead (behaviour identical):
//   edit 1: after computed()'s `const birthGen = node.gen;` (anchor: that line + the blank line + "/**" + " * Read the value
//           (refreshed if stale); tracked inside an observer.") insert `var rcf = refreshComputed;   // S1v control`;
//   edit 2: in the read closure, `refreshComputed(node, 0);` before `if (node.gen !== g) return undefined;   // disposed during
//           the refresh` becomes `rcf(node, 0);`.
// Loading: the fixture's one `export {watch, when, whenAsync} from "./Watch.js";` line is removed (count-checked) from the ref and
// s1v texts (no Watch.js beside the fixture), and both are imported through a data: URL (no temp file).
// Window pin (D-b189-2): the child runs --single-threaded and refuses to measure without it (exit 3). Mechanism (b189, CI run
// 43651343131: one round of 15 at about -810 B on node 22 / 24 / 26): an in-flight job on the concurrent optimizing-compiler
// thread keeps the PREVIOUS measure()'s registry context alive (its 16384 eager nodes + 65536 links + both pool arrays,
// ~9.8 MB, without its handles) through every gc() of settle() at h0; the job is finalized before h1 and the context dies
// inside the window: 1.68 MB - ~9.8 MB = about -816 B per handle. Space stats h0 -> h1 on a bad round: old -7194 KB,
// large_object -773 KB (the two pool arrays). Locally reproduced under `taskpolicy -b` and --concurrent-recompilation-delay=300;
// 0 bad windows with --single-threaded or --no-concurrent-recompilation. With no background compiler thread a compile job
// completes inside the main-thread call that started it, so no job can hold a dead registry across a settle().
// Spaces: used() sums v8.getHeapSpaceStatistics() space_used_size over new_space, old_space, new_large_object_space and
// large_object_space only (the child exits 6 if one is missing). Every byte a handle retains is there (the closure, its context
// and the node are old-space objects; a valid window moves old_space by 1643 KB and no other of the four spaces by > 2 KB). Excluded: a JIT
// code install / flush inside the window moved code_space by +90 / -88 / -91 KB with trusted_space -24 KB (about +-9 B per
// handle on that column, 18x the gate bound), and code / trusted / read-only / shared spaces hold no per-handle object.
// Must-fail tooth: PIN plants that pin (an extra eager registry alive at h0, dropped inside the window); the every-round guard
// (memMeasured) must reject the planted window.
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/Signal-91c507df.js", import.meta.url));
const MEM_N = 10000;
const MEM_ROUNDS = 5;
const MEM_BOUND = 0.5;     // B per handle: median(eng - ref) <= this
const MEM_CONTROL = 4;     // B per handle: median(s1v - ref) >= this
const CHILD_MEM = `
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getHeapSpaceStatistics } from "node:v8";
import { createRegistry as createEng } from ${JSON.stringify(ENGINE_URL)};
for (const f of ["--expose-gc", "--single-threaded"]) {
    if (!process.execArgv.includes(f)) { console.error("MEM child: " + f + " is not in execArgv"); process.exit(3); }
}
const text = readFileSync(${JSON.stringify(FIXTURE_PATH)}, "utf8");
const sha8 = createHash("sha256").update(readFileSync(${JSON.stringify(FIXTURE_PATH)})).digest("hex").slice(0, 8);
if (sha8 !== "91c507df") { console.error("MEM child: fixture sha256/8 " + sha8 + " is not 91c507df"); process.exit(4); }
function rep(t, from, to) {
    const parts = t.split(from);
    if (parts.length !== 2) { console.error("MEM child: edit anchor matched " + (parts.length - 1) + " times: " + from.slice(0, 60)); process.exit(5); }
    return parts[0] + to + parts[1];
}
const noWatch = rep(text, 'export {watch, when, whenAsync} from "./Watch.js";', "");
const A1 = "        const birthGen = node.gen;\\n\\n        /**\\n         * Read the value (refreshed if stale); tracked inside an observer.";
const A2 = "                refreshComputed(node, 0);\\n                if (node.gen !== g) return undefined;   // disposed during the refresh\\n";
let s1v = rep(noWatch, A1, "        const birthGen = node.gen;\\n        var rcf = refreshComputed;   // S1v control\\n\\n        /**\\n         * Read the value (refreshed if stale); tracked inside an observer.");
s1v = rep(s1v, A2, "                rcf(node, 0);\\n                if (node.gen !== g) return undefined;   // disposed during the refresh\\n");
const load = (t) => import("data:text/javascript;base64," + Buffer.from(t, "utf8").toString("base64"));
const builds = [
    { name: "ref", create: (await load(noWatch)).createRegistry },
    { name: "eng", create: createEng },
    { name: "s1v", create: (await load(s1v)).createRegistry },
];
const N = ${MEM_N}, ROUNDS = ${MEM_ROUNDS};
const body = () => 1;
// used: bytes in the JS-object spaces (in-window JIT code install / flush in code / trusted space is not retention)
const JS_SPACES = ["new_space", "old_space", "new_large_object_space", "large_object_space"];
for (const n of JS_SPACES) {
    if (!getHeapSpaceStatistics().some((s) => s.space_name === n)) { console.error("MEM child: no heap space named " + n); process.exit(6); }
}
function used() {
    let u = 0;
    for (const s of getHeapSpaceStatistics()) if (JS_SPACES.includes(s.space_name)) u += s.space_used_size;
    return u;
}
// settle: full gc() until two consecutive used() readings agree within 1 KB (a single gc() can leave the previous build's garbage unswept)
function settle() {
    let p = -Infinity, h = 0;
    for (let i = 0; i < 12; i++) { globalThis.gc(); h = used(); if (Math.abs(h - p) < 1024) break; p = h; }
    return h;
}
let PIN = null;   // must-fail tooth: a planted pin of the D-b189-2 class, dropped inside the window
function measure(create) {
    const r = create({ maxNodes: 16384, prealloc: "eager" });
    const keep = new Array(N).fill(null);
    const h0 = settle();
    PIN = null;
    for (let i = 0; i < N; i++) keep[i] = r.computed(body);
    const h1 = settle();
    if (keep[N - 1] === null) console.log("x");
    return (h1 - h0) / N;
}
for (let w = 0; w < 4; w++) for (const b of builds) measure(b.create);   // warm-up: lazy compilation and tier-up of computed() / createNode happen outside every window
const rounds = [];
for (let round = 0; round < ROUNDS; round++) {
    const row = {};
    for (let j = 0; j < builds.length; j++) { const b = builds[(round + j) % builds.length]; row[b.name] = measure(b.create); }
    rounds.push(row);
}
PIN = builds[0].create({ maxNodes: 16384, prealloc: "eager" });   // tooth: an extra registry alive at h0, freed in the window
const plant = measure(builds[0].create);
console.log("RESULT " + JSON.stringify({ rounds, plant, sha8 }));
`;
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
const memMeasured = (x) => x > 0;   // the every-round guard (D-b188-2, kept by D-b189-2): a delta <= 0 means the window did not measure
describe("ARG-E2 MEM: a computed() handle retains no more than on 91c507df", () => {
    it("[PIN] MEM median of 5 interleaved rounds: engine retains no more than 91c507df + 0.5 B per computed(); executed S1v control >= +4 B", () => {
        const o = runChild(CHILD_MEM, ["--expose-gc", "--single-threaded", "--max-old-space-size=256"], undefined);
        assert.equal(o.sha8, "91c507df");
        assert.equal(o.rounds.length, MEM_ROUNDS);
        const show = o.rounds.map((x) => "ref " + x.ref.toFixed(2) + " eng " + x.eng.toFixed(2) + " s1v " + x.s1v.toFixed(2)).join(" | ");
        for (const x of o.rounds) {
            for (const k of ["ref", "eng", "s1v"]) assert.ok(memMeasured(x[k]), "round heap delta for " + k + " is not > 0 (the window did not measure): " + show);
        }
        // must-fail tooth (D-b189-2): the planted pin (an extra eager registry alive at h0, dropped inside the window) must be rejected
        assert.ok(Number.isFinite(o.plant), "tooth: no planted-window reading: " + o.plant);
        assert.equal(memMeasured(o.plant), false, "tooth: the planted in-window free read " + o.plant.toFixed(2) + " B per handle and passed the every-round guard");
        assert.equal(memMeasured(0), false, "guard boundary: a 0 B round must not count as measured");
        assert.equal(memMeasured(NaN), false, "guard boundary: a NaN round must not count as measured");
        const dEng = median(o.rounds.map((x) => x.eng - x.ref));
        const dS1v = median(o.rounds.map((x) => x.s1v - x.ref));
        if (process.env.E2_DEBUG) console.log("MEMDBG medians eng-ref " + dEng.toFixed(3) + " s1v-ref " + dS1v.toFixed(3) + " plant " + o.plant.toFixed(2) + " | " + show);
        assert.ok(dEng <= MEM_BOUND, "median(engine - 91c507df) = " + dEng.toFixed(3) + " B per computed() > +" + MEM_BOUND + "; rounds: " + show);
        assert.ok(dS1v >= MEM_CONTROL, "must-fail control: median(S1v - 91c507df) = " + dS1v.toFixed(3) + " B < +" + MEM_CONTROL + " (the window cannot see one extra context slot); rounds: " + show);
    });
});

// ---- RET: 100 create / fire / read / dispose cycles of an F1 reader (no retention) ----
// Modeled on test/110 AUD-E1 A5. Per cycle: a computed c whose re-run cleanup writes its signal and throws a tracked error; a
// catching effect reader of c; p.set(1) fires (the A1 shape: 3 reader runs, E seen once); a direct read of c; then dispose
// effect, c and p (a still-armed throwing cleanup throws on its first dispose, so each dispose retries as A5 does).
const RET_F1 = `
import { createLeakTracker } from '@zakkster/lite-leak';
import { createRegistry } from ${JSON.stringify(ENGINE_URL)};
const tr = createLeakTracker({ name: 'e2', onLeak() {}, onWarning() {} });
const settle = async () => {
    for (let t = 0; t < 40 && tr.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 10)); }
    return tr.size();
};
const r = createRegistry();
const held = [];
function retry(fn) { for (let d = 0; d < 3; d++) { try { fn(); return; } catch (x) { /* retry */ } } }
function cycle(i, keep) {
    const err = new Error('c' + i), pay = { i };
    tr.track(err, null, 'err' + i); tr.track(pay, null, 'pay' + i);
    if (keep) held.push(err);
    const p = r.signal(0); let runs = 0, errSeen = 0, disposing = false;
    const c = r.computed(() => { p(); r.onCleanup(() => { pay.i++; if (!disposing) p.set(p.peek() + 10); throw err; }); return 1; });
    const e = r.effect(() => { runs++; try { c(); } catch (x) { if (x === err) errSeen++; } });
    let t1 = null;
    try { p.set(1); } catch (x) { t1 = x; }
    let direct = null;
    try { c(); } catch (x) { direct = x; }
    disposing = true;
    retry(() => r.dispose(e));
    retry(() => r.dispose(c));
    r.dispose(p);
    return runs + ':' + errSeen + ':' + (t1 === null) + ':' + (direct === null);
}
const sizes = [], shapes = [], gauges = [];
for (let i = 0; i < 100; i++) {
    shapes.push(cycle(i, false));
    sizes.push(await settle());
    const st = r.stats(); gauges.push(st.activeNodes + st.activeLinks);
}
const q = r.signal(0); let gRuns = 0;
r.effect(() => { q(); gRuns++; });
const afterCreate = gRuns;
q.set(1);
const afterWrite = gRuns;
cycle(1000, true);
const control = await settle();
console.log("RESULT " + JSON.stringify({ sizes, shapes, gauges, afterCreate, afterWrite, control }));
`;
describe("ARG-E2 RET: the pending-error wrapper is not retained after dispose", () => {
    it("[RED] RET 100 cycles: tracker.size() 0 after each, activeNodes + activeLinks 0, each cycle 3 reader runs with E seen once and no throw from the write or the direct read; a later effect on a recycled slot runs once, then twice; held control stays tracked", () => {
        const root = fileURLToPath(new URL("../", import.meta.url));
        const o = runChild(RET_F1, ["--expose-gc", "--max-old-space-size=256"], root);
        assert.equal(o.sizes.length, 100);
        assert.ok(o.sizes.every((n) => n === 0), "tracker.size() per cycle: " + o.sizes.filter((n) => n !== 0).join());
        assert.ok(o.gauges.every((n) => n === 0), "activeNodes + activeLinks per cycle: " + [...new Set(o.gauges)].join());
        // A1 shape: creation run + error run + re-run = 3 reader runs; E seen once; the catching reader keeps set from throwing.
        assert.ok(o.shapes.every((x) => x === "3:1:true:true"), "cycle shapes: " + [...new Set(o.shapes)].join());
        assert.equal(o.afterCreate, 1);
        assert.equal(o.afterWrite, 2);
        assert.equal(o.control, 1, "control: the held error stays tracked");
    });
});

// ---- RET-A11x (b187 ASSERTION 4): 100 A11x create / batch / dispose cycles; same tracker pattern as RET_F1 above ----
// Per cycle: the A11x scenario (a nested computed frame disposes the running effect h, the dead h reads pending c), then dispose of
// every node. Expected per cycle (C0, A11x target): thrown none, seen [10,E], runs 2, ops [5,2]. After every cycle:
// tracker.size() 0, stats().effects 0, stats().activeLinks 0.
const RET_A11X = `
import { createLeakTracker } from '@zakkster/lite-leak';
import { createRegistry } from ${JSON.stringify(ENGINE_URL)};
const tr = createLeakTracker({ name: 'e2x', onLeak() {}, onWarning() {} });
const settle = async () => {
    for (let t = 0; t < 40 && tr.size() !== 0; t++) { gc(); await new Promise((r) => setTimeout(r, 10)); }
    return tr.size();
};
const r = createRegistry();
function retry(fn) { for (let d = 0; d < 3; d++) { try { fn(); return; } catch (x) { /* retry */ } } }
function cycle(i) {
    const err = new Error('c' + i), pay = { i };
    tr.track(err, null, 'err' + i); tr.track(pay, null, 'pay' + i);
    const s = r.signal(1), g = r.signal(0), k = r.signal(0); let armed = false;
    const c = r.computed(() => { const v = s(); r.onCleanup(() => { pay.i++; if (armed) { armed = false; s.set(20); throw err; } }); return v * 10; });
    let kill = false, h = null, runs = 0; const seen = [], ops = [];
    const x = r.computed(() => { k(); if (kill) h(); return 0; });
    h = r.effect(() => { runs++; g(); x(); try { seen.push(c()); } catch (e) { seen.push(e === err ? 'E' : 'ERR:' + e.message); } });
    const hid = r.nodeId(h);
    const off = r.onGraphMutation((op, a) => { if (a === hid && (op === 2 || op === 5)) ops.push(op); });
    kill = true; armed = true;
    let t = 'none';
    try { r.batch(() => { g.set(1); k.set(1); s.set(2); }); } catch (e) { t = e === err ? 'E' : 'ERR:' + e.message; }
    off();
    retry(() => r.dispose(h));
    retry(() => r.dispose(x));
    retry(() => r.dispose(c));
    r.dispose(s); r.dispose(g); r.dispose(k);
    return t + '|' + seen.join(',') + '|' + runs + '|' + ops.join(',');
}
const sizes = [], shapes = [], effects = [], links = [];
for (let i = 0; i < 100; i++) {
    shapes.push(cycle(i));
    sizes.push(await settle());
    const st = r.stats(); effects.push(st.effects); links.push(st.activeLinks);
}
console.log("RESULT " + JSON.stringify({ sizes, shapes, effects, links }));
`;
describe("ARG-E2 RET-A11x: a dead observer reading a pending wrapper retains nothing after dispose", () => {
    it("[PIN] RET-A11x 100 cycles: tracker.size() 0, stats().effects 0, activeLinks 0 after every cycle; each cycle none|10,E|2|5,2", () => {
        const root = fileURLToPath(new URL("../", import.meta.url));
        const o = runChild(RET_A11X, ["--expose-gc", "--max-old-space-size=256"], root);
        assert.equal(o.sizes.length, 100);
        assert.ok(o.sizes.every((n) => n === 0), "tracker.size() per cycle: " + o.sizes.filter((n) => n !== 0).join());
        assert.ok(o.effects.every((n) => n === 0), "stats().effects per cycle: " + [...new Set(o.effects)].join());
        assert.ok(o.links.every((n) => n === 0), "stats().activeLinks per cycle: " + [...new Set(o.links)].join());
        assert.ok(o.shapes.every((x) => x === "none|10,E|2|5,2"), "cycle shapes: " + [...new Set(o.shapes)].join());
    });
});
