/**
 * SNAPSHOT lane (R8 group B tasks 4-6, burst 155; PLAN-R8-snapshot.md CURRENT R8-2, R8-3, R8-8, R8-10, R8-12, R8-13,
 * R8-19, R8-20): registry snapshot() / restore() time travel, judged by the OS oracle (oracles.mjs checkOsRoundtrip /
 * checkOsModel / checkOsRefire / osCleanClass / checkOsCleanBit). LANE_INDEX 13, rostered in R8 C1 (b156: lanes/index.mjs
 * ROSTER[13] / BY_NAME); test/102 still wires it directly through runWorld's opts.laneOps.
 *
 * World: one GRAPH normal world (lanes/graph.mjs init / step on the same generator; no LARGE world) plus the three lane
 * ops below, drawn by the lane's own MIX. R8-8: a plain lane (no sub-lane mix, twin false).
 *
 * Generator (G0: shadow model only): a ring of 2 slots per generator (module WeakMap, dies with it). snap {s} stores
 * g.M.restoreCopy() in slot s; rest {s} (only when slot s is filled, else the step emits a snap) sets g.M :=
 * slot.restoreCopy(), so the slot stays pristine and can restore again (restore-twice). R8-10: gen.mjs Gen.next is a
 * monotonic counter (sig / comp / eff / reserve all take next++) and a rest never rewinds it, so no node index is ever
 * reused after a rest: the nodes created after the snap leave the model with the restore and every later creation takes
 * a fresh index past them (test/102 pins it on 200 scripts and on the executed worlds).
 *
 * Ops (lane-owned, exec.mjs laneOp), each only at an op boundary (top level: no frame, guard, batch or callback open):
 *   snap   {s}           S1 = W.snapshot(); mc = M.restoreCopy(); idOf (Int32Array, length max(H.length, M.n.length)):
 *                        idOf[i] = W.nodeId(H[i]), -1 = no handle or no live engine node; Hlen = H.length. Stored in slot s
 *                        (a snap already in s is dropped). A snapshot() throw is an O6 engine error (nothing stored)
 *   rest   {s}           one restore EVENT (a no-op when slot s is empty: a shrunk script). fnsById = exec's own body
 *                        shapes keyed by S1 id (computed () => x.runBody(i), effect () => { x.runBody(i); }, by the
 *                        model kind of index i). The per-index run counter (SnState cnt / total, fed by exec runBody's
 *                        sn.onBody) is armed BEFORE open(): a 'snapshot-refire' body runs before open() returns. Then
 *                        W' = adapter.open({ maxFlushPasses, from: { registry: W.registry, snap: S1, fnsById, handles } })
 *                        -> checkOsRefire(runs during open) -> exec.swapWorld(W', copy of mc, H') with H'[i] =
 *                        handles[idOf[i]] for i < Hlen (H cut to Hlen) -> S2 = W'.snapshot() before any read ->
 *                        checkOsRoundtrip(S1, S2) -> checkOsModel(S1, mc, idOf) -> one top-level UNTRACKED read per
 *                        computed record, in S1 order, no write between (exec.readCheck: O1c rides along) ->
 *                        checkOsCleanBit with R8-19 runs = the record's own body runs from restore() through the end of
 *                        its own read ('dirty' = a skip, not a check). checks.OS += 1 per event (R8-3; all three sigs
 *                        judged in it). An open() that throws ends the event after the refire check (an O6 engine
 *                        error when no body ran; the old world stays and the world fails at this op)
 *   snapin {s, where}    a refusal probe (R8-13). 'batch' W.batch(() => W.snapshot()) and 'body' (a private computed whose
 *                        body calls W.snapshot(), read once, disposed in the same guard) must throw the not-settled Error:
 *                        exec.regExpect = SNAP_EXPECT, so O6 reports expected-escape-missing when it does not throw.
 *                        'untrack' W.untrack(() => W.snapshot()) at the top level must return (O6 EXPECT_NONE: an
 *                        over-refusal escapes). s is validated as snap's; the probe stores nothing
 *
 * Fail closed (exec.unmodelled): at the world's first SNAPSHOT op, a script with a capacity key or any op outside the
 * allowlist (core sig without eq / comp without a computed writer / eff / set / burst / read / stop / disp / seq /
 * batch, plus snap / rest / snapin: every lc / hk / ow / rc / sc / capacity lane op, reg / off and NEST arm fail); at
 * every SNAPSHOT op, an exec lane state lc / hk / ow / rc / sc that is set, a live registration, an open frame / guard /
 * batch / callback, an op.s that is not exactly 0 or 1 (-0, -1, 2, 1.5, NaN, '0', null, undefined), an unknown where.
 * exec.sn = SnState: slots[2] + the armed counter + judged (clean / never / dirty records met by the read passes; test
 * evidence, read by no oracle); close() nulls every slot and the counter (exec calls it after
 * W.close()).
 * COLD module: snap / rest allocate per op by design (snapshot-torture ruling); other lanes pay exec's one sn null test
 * per runBody.
 */

import { GRAPH } from './graph.mjs';
import { checkOsRoundtrip, checkOsModel, checkOsRefire, osCleanClass, checkOsCleanBit } from '../oracles.mjs';

const MIX = Object.freeze({ graph: 88, snap: 5, rest: 4, snapin: 3 });
const WHERE = Object.freeze({ batch: 1, body: 1, untrack: 1 });
const ALLOWED = Object.freeze(['sig', 'comp', 'eff', 'set', 'burst', 'read', 'stop', 'disp', 'seq', 'batch', 'snap', 'rest', 'snapin']);
const COUNTER_CAP = 0x3FFFFFFF;
const NOT_SETTLED = '[lite-signal] snapshot: graph not settled';

/** The O6 expect[] list of a batch / body snapin probe: the engine's not-settled Error (Signal.js snapshot()). */
export const SNAP_EXPECT = Object.freeze([Object.freeze({ id: 'snapshot-not-settled', ctor: 'Error', prefix: NOT_SETTLED })]);

/* ---- generator side (G0: the generator reads only its shadow model) ------------------------------------------ */

const GSLOTS = new WeakMap();   // Gen -> [Model | null, Model | null]

function gslots(g) {
    let s = GSLOTS.get(g);
    if (s === undefined) { s = [null, null]; GSLOTS.set(g, s); }
    return s;
}

function init(g) {
    GRAPH.init(g);
}

function step(g) {
    const what = g.weighted(MIX);
    if (what === 'graph') { GRAPH.step(g); return; }
    const sl = gslots(g);
    const s = g.int(2);
    if (what === 'snapin') { g.push({ o: 'snapin', s, where: g.weighted(WHERE) }); return; }
    if (what === 'rest' && sl[s] !== null) {
        g.M = sl[s].restoreCopy();
        g.push({ o: 'rest', s });
        return;
    }
    sl[s] = g.M.restoreCopy();
    g.push({ o: 'snap', s });
}

/* ---- exec side --------------------------------------------------------------------------------------------- */

/**
 * The per-world SNAPSHOT state (exec.sn). exec reads exactly two members: onBody(i) at every runBody entry (counts
 * only while armed: cnt[i] per node index, total over all bodies, both capped Smi) and close() after W.close().
 */
export class SnState {
    constructor() {
        this.slots = [null, null];   // { snap, mc, idOf, Hlen, restores } per slot
        this.armed = false;
        this.cnt = null;             // Int32Array while armed
        this.total = 0;
        this.judged = { clean: 0, never: 0, dirty: 0 };   // clean-bit classes met by the read pass (dirty = skipped); evidence only
    }

    onBody(i) {
        if (!this.armed) return;
        const c = this.cnt;
        if (i >= 0 && i < c.length && c[i] < COUNTER_CAP) c[i]++;
        if (this.total < COUNTER_CAP) this.total++;
    }

    close() {
        this.slots[0] = null;
        this.slots[1] = null;
        this.cnt = null;
        this.armed = false;
    }
}

function show(v) {
    if (Object.is(v, -0)) return '-0';
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

function unmodelled(x, msg) {
    x.unmodelled = new Error('exec: unmodelled snapshot op: ' + msg);
    throw x.unmodelled;
}

function scanOps(x, ops) {
    if (!Array.isArray(ops)) unmodelled(x, 'an op list is not an array');
    for (let k = 0; k < ops.length; k++) {
        const op = ops[k];
        const o = op !== null && typeof op === 'object' ? op.o : undefined;
        if (ALLOWED.indexOf(o) === -1) unmodelled(x, 'op ' + show(o) + ' is outside the SNAPSHOT allowlist (' + ALLOWED.join(' / ') + ')');
        if (o === 'sig' && op.eq === 1) unmodelled(x, 'a throwing-equals signal (restore drops equals)');
        if (o === 'comp' && op.spec !== null && typeof op.spec === 'object' && op.spec.w !== undefined && op.spec.w !== null) unmodelled(x, 'a computed writer (the clean-bit read pass allows no write)');
        if (o === 'seq') scanOps(x, op.ops);
        else if (o === 'batch') scanOps(x, op.body);
    }
}

/** exec.sn, created (after the whole-script allowlist scan) at the world's first SNAPSHOT op. */
function stateOf(x) {
    let sn = x.sn;
    if (sn === null) {
        if (x.script.capacity !== undefined) unmodelled(x, 'a script with a capacity key');
        scanOps(x, x.script.ops);
        sn = new SnState();
        x.sn = sn;
    }
    return sn;
}

/** The op boundary + lane-state guard of every SNAPSHOT op. */
function boundary(x, what) {
    if (x.lc !== null || x.hk !== null || x.ow !== null || x.rc !== null || x.sc !== null) unmodelled(x, what + ' with an lc / hk / ow / rc / sc lane state set');
    if (x.frames.length !== 0 || x.guards.length !== 0 || x.batchDepth !== 0 || x.cbDepth !== 0) unmodelled(x, what + ' off an op boundary (frame / guard / batch / callback open)');
    const regs = x.M.regs;
    for (let r = 0; r < regs.length; r++) if (regs[r] !== undefined && regs[r].live === true) unmodelled(x, what + ' with live registration r' + r);
}

function slotOf(x, op) {
    const s = op.s;
    if ((s !== 0 && s !== 1) || Object.is(s, -0)) unmodelled(x, op.o + ' slot s ' + show(s) + ' is not 0 or 1');
    return s;
}

function opSnap(x, op) {
    const sn = stateOf(x);
    const s = slotOf(x, op);
    boundary(x, 'snap');
    const W = x.W, M = x.M, H = x.H;
    let S1;
    try { S1 = W.snapshot(); } catch (e) { x.engineError(e, 'snapshot()'); return; }
    const idOf = new Int32Array(Math.max(H.length, M.n.length)).fill(-1);
    for (let i = 0; i < H.length; i++) {
        const h = H[i];
        if (h === undefined) continue;
        const id = W.nodeId(h);
        if (id !== undefined) idOf[i] = id;
    }
    sn.slots[s] = { snap: S1, mc: M.restoreCopy(), idOf, Hlen: H.length, restores: 0 };
}

function compFn(x, i) { return () => x.runBody(i); }
function effFn(x, i) { return () => { x.runBody(i); }; }

function opRest(x, op, k) {
    const sn = stateOf(x);
    const s = slotOf(x, op);
    boundary(x, 'rest');
    const slot = sn.slots[s];
    if (slot === null) return;
    const S1 = slot.snap, mc = slot.mc, idOf = slot.idOf, Hlen = slot.Hlen;
    const label = 'rest s' + s + ' op ' + k;
    // detector facts vs the CURRENT model (before the swap)
    const cur = x.M;
    let disposed = false, born = false;
    for (let i = 0; i < mc.n.length && !disposed; i++) {
        const a = mc.n[i];
        if (a !== undefined && a.live) { const b = cur.n[i]; if (b === undefined || !b.live) disposed = true; }
    }
    for (let i = 0; i < cur.n.length && !born; i++) {
        const b = cur.n[i];
        if (b !== undefined && b.live && (i >= mc.n.length || mc.n[i] === undefined)) born = true;
    }
    const fnsById = {};
    for (let i = 0; i < Hlen; i++) {
        const id = idOf[i];
        if (id === -1) continue;
        const nd = mc.n[i];
        if (nd === undefined) continue;
        if (nd.t === 'c') fnsById[id] = compFn(x, i);
        else if (nd.t === 'e') fnsById[id] = effFn(x, i);
    }
    const handles = {};
    sn.cnt = new Int32Array(idOf.length);
    sn.total = 0;
    sn.armed = true;
    let W2 = null, openErr = null, threw = false;
    try {
        W2 = x.ad.open({ maxFlushPasses: x.script.flushPasses, from: { registry: x.W.registry, snap: S1, fnsById, handles } });
    } catch (e) {
        openErr = e;
        threw = true;
    }
    const during = sn.total;
    x.did('OS');
    const fr = checkOsRefire(label, during);
    if (fr !== null) x.failF(fr);
    if (threw) {
        sn.armed = false;
        sn.cnt = null;
        if (during === 0) x.engineError(openErr, 'restore: open({ from })');
        return;
    }
    const H2 = new Array(Hlen);
    for (let i = 0; i < Hlen; i++) { const id = idOf[i]; H2[i] = id === -1 ? undefined : handles[id]; }
    x.swapWorld(W2, mc.restoreCopy(), H2);
    let S2 = null;
    try { S2 = W2.snapshot(); } catch (e) { x.engineError(e, 'snapshot() of the restored world'); }
    if (S2 !== null) { const f = checkOsRoundtrip(S1, S2); if (f !== null) x.failF(f); }
    const fm = checkOsModel(S1, mc, idOf);   // a malformed S1 reports here too ('malformed snap'), never a throw
    if (fm !== null) x.failF(fm);
    const idx = new Map();
    for (let i = 0; i < Hlen; i++) if (idOf[i] !== -1) idx.set(idOf[i], i);
    const nodes = S1 !== null && typeof S1 === 'object' && Array.isArray(S1.nodes) ? S1.nodes : [];
    for (let j = 0; j < nodes.length; j++) {
        const rec = nodes[j];
        if (rec === null || typeof rec !== 'object' || (rec.kind !== 'computed' && rec.kind !== 'computedBox')) continue;
        const i = idx.get(rec.id);
        if (i === undefined) continue;   // an unmapped record: checkOsModel reports the count
        let cls;
        try { cls = osCleanClass(rec); } catch { cls = null; }   // malformed: reported by checkOsModel above
        x.readCheck(i, true);
        if (cls !== null && sn.judged[cls] < COUNTER_CAP) sn.judged[cls]++;
        if (cls === null || cls === 'dirty') continue;   // dirty = a skip (R8-12, b98), not a check
        const f = checkOsCleanBit(label, rec, sn.cnt[i]);
        if (f !== null) x.failF(f);
    }
    sn.armed = false;
    sn.cnt = null;
    slot.restores++;
    x.D.onSnap('rest', disposed, born, slot.restores);
}

function opSnapin(x, op) {
    stateOf(x);
    slotOf(x, op);
    boundary(x, 'snapin');
    const where = op.where;
    const W = x.W;
    if (where === 'untrack') {
        let ok = false;
        x.guard(() => { W.untrack(() => W.snapshot()); ok = true; });
        x.D.onSnap('in', 'untrack', ok);
        return;
    }
    if (where !== 'batch' && where !== 'body') unmodelled(x, 'snapin where ' + show(where) + ' is not batch / body / untrack');
    let err = null;
    x.regExpect = SNAP_EXPECT;
    if (where === 'batch') {
        x.guard(() => { try { W.batch(() => { W.snapshot(); }); } catch (e) { err = e; throw e; } });
    } else {
        x.guard(() => {
            const c = W.computed(() => W.snapshot());
            try { W.read(c); } catch (e) { err = e; throw e; } finally { W.dispose(c); }
        });
    }
    x.regExpect = null;
    const msg = err !== null && typeof err === 'object' ? err.message : undefined;
    x.D.onSnap('in', where, err instanceof Error && typeof msg === 'string' && msg.indexOf(NOT_SETTLED) === 0);
}

export const SNAPSHOT = Object.freeze({
    name: 'SNAPSHOT',
    index: 13,
    twin: false,
    needsCaps: Object.freeze(GRAPH.needsCaps.concat(['snapshot'])),
    hardOracles: Object.freeze(['OS']),
    required: Object.freeze(['snap-restore']),
    optional: Object.freeze(['restore-after-dispose', 'restore-recycled', 'restore-twice', 'snap-refused-batch', 'snap-refused-body', 'snap-untrack-ok']
        .concat(GRAPH.required, GRAPH.optional)),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: 'one GRAPH normal world (no LARGE world) + snap / rest / snapin over 2 snapshot slots' }),
    flushPasses: null,
    covOff: Object.freeze({}),
    init,
    step,
    specRefs: GRAPH.specRefs,
    ops: Object.freeze({ snap: opSnap, rest: opRest, snapin: opSnapin }),
});
