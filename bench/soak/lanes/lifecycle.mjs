/**
 * LIFECYCLE lane (S3 rung R2, .handoff/PLAN-R2-lifecycle.md TASK 2): lifecycle REGISTRATIONS (world.lifecycle(h,
 * { onConnect, onDisconnect }), the registry's observeObservers) over a GRAPH-vocabulary world (no batch, so prefixr
 * runs it like the tree). LANE_INDEX 5 (S3-D6). Rostered since R2 B3 (b111): lanes/index.mjs ROSTER, after HOOK.
 *
 * Ops (lane-owned, exec.mjs laneOp): lreg { r, i, a? } registers r on node i with BOTH callbacks (a per-callback merge
 * then degenerates to a whole overwrite: no D3 spurious-* shape); loff { r } retires r. a = an ARMED action, one-shot,
 * run by r's first fire of the armed kind in the same op (on 1 = onConnect, 0 = onDisconnect):
 *   { k: 'disp', x }      dispose node x, a later source of the effect whose walk fired the callback. on 0: x is the
 *                         walk's NEXT link x' 3 times in 4 (L7a: the F8 freeLink TypeError on rev152), else y (the
 *                         non-adjacent L7b twin); on 1: y. On 0, TRIM_P of the time the walk is a RETRACK TRIM instead
 *                         (L7c, PLAN-R2 AD6, trimOps): the one body that is not a plain try-mode GRAPH kind
 *                         (maintainer ruling, this shape only) -- a kinds.mjs 'outer' effect over t, then post
 *                         [a, b, c]; a core 'arm' op sets its early mode and writes t, so the re-run reads [t] alone
 *                         and the trim unlinks a, b, c in order; a's onDisconnect disposes b, the trim's NEXT link.
 *                         No read can throw (fresh signals only), so no body error reaches the GRAPH oracles.
 *   { k: 'lreg', r, x }   register r on node x from inside the callback (phase-free: -1, L8a)
 *   { k: 'loff', r }      off sibling registration r on the same target (lc-callback-off-sibling). Armed as a MIRROR
 *                         pair on t', A registered first: A offs B, B offs A. An ADD kernel fires A first and A offs
 *                         the not-yet-visited B (L8c, the B0-2 crash on headpatched); an overwrite kernel fires only
 *                         B, which offs the earlier A (the stale-off sibling shape). The generator's 'lself' arm
 *                         (b118, D-b117-2 / T-LC-iter) emits the same { k: 'loff', r } in two more shapes on t':
 *                         SELF (1 - NEXT_OFF_P): rA armed to off ITSELF, then rB unarmed -- rA fires first (FIFO) and
 *                         offs the registration the walk stands on, whose successor rB must still fire; NEXT
 *                         (NEXT_OFF_P): rA armed to off rB, then rB and rC unarmed -- rA offs its not-yet-visited
 *                         successor (rB never fires, rC does). Under single-reg 'lself' falls back to 'disp'
 *   { k: 'set', x, v }    write signal x := decodeValue(v)
 * Every armed seq makes the fire certain on every kernel: a FRESH target t', one registration (the mirror pair for
 * 'loff': one of the two fires on every kernel; for 'lself' rA fires first), then an effect reading [t', x', y]
 * (connect) and, for on 0, its stop in the same op (the disconnect walk). The L7c seq is { seq [ { seq build }, arm ] }: build = fresh t, a, b, c, one
 * registration on each of a (armed), b and c, then E; the arm re-runs E in the same op, so the action is still armed. The
 * generator's shadow model applies every armed action at generation time (G0; for the mirror pair both offs, so the
 * shadow never relies on the kernel-dependent survivor; for 'lself' the one off: rA (SELF) or rB (NEXT); for L7c E's
 * early mode, t's new value and b's death).
 * Q3 (A1): a lifecycle callback NEVER throws in R2 -- an action escape is caught in the callback and reported through
 * exec.engineError (O6, fail closed, never swallowed).
 *
 * Oracles: every fire runs O7a (checkFire) and, only when it passes, O7 checkLcFire (phase); exec.mjs lcAtRest runs O7
 * checkLcRest after every op while exec.lc !== null. Attribution (oracles.mjs checkLcRest (b) / (c)), kept per
 * registration since its last LEGAL fire (lastGood; a legal fire clears all three):
 *   co       other live registrations that overlapped on the same target (an lreg on a held target adds both ways)
 *   sibOff   the first off of ANOTHER registration on the same live target
 *   deadOff  the first late off of a registration whose target is dead, when this registration's target was
 *            created after that death (L10: the off may hit the recycled slot); only set while co is empty, and a
 *            later overlap clears it (the overwrite is then the better explanation)
 *
 * exec state (exec.lc, an LcState): regs[r] = { r, target, live, phase, fires, co, sibOff, deadOff, off }, prev
 * (Map target -> sink Set at the previous rest), step, cbDepth (lane callbacks on the stack), actions (r -> armed
 * action, dropped at rest), deadAt (target -> model node count when its death was first seen: a node with an index
 * >= it was created after the death). Fail closed (exec.unmodelled): an lreg whose r is not a fresh integer id, a
 * malformed action, an loff whose r is not an integer >= 0, a fire (O7a passed) for a registration LcState never
 * recorded (a harness bug, never an O6 engine escape; b117). An lreg on a dead / absent node and an loff of a
 * registration that is not live are no-ops (a shrunk script).
 *
 * Scenarios (scenarios.mjs onLc*, TRUE conditions): lc-two-regs, lc-off-sibling, lc-late-off-recycle,
 * lc-callback-dispose, lc-callback-register (required); lc-callback-off-sibling (optional; an 'lself' off counts it
 * too: a registration after rA is live on t' when rA's action runs). covOff lc-two-regs ->
 * rule single-reg: no handle ever holds two live registrations (every D3 trigger is gone; T-cov-LIFECYCLE).
 * COLD module: harness code, never an engine hot path.
 */

import { GRAPH } from './graph.mjs';
import { specRefs, decodeValue, EQ_BOMB_CODE } from '../kinds.mjs';
import { checkFire, checkLcFire } from '../oracles.mjs';

const MIX = Object.freeze({ graph: 66, lreg: 8, loff: 6, wire: 8, cbarm: 7, recycle: 5 });
const ACTIONS = Object.freeze({ disp: 3, lreg: 2, set: 2, loff: 1, lself: 1 });   // 'lself' is emitted as k 'loff'
const ACTION_KINDS = Object.freeze(['disp', 'lreg', 'loff', 'set']);
const CO_P = 0.35;      // an lreg picks an already-held target (lc-two-regs), default rule only
const NEXT_P = 0.75;    // an on-0 'disp' disposes the walk's NEXT link x' (L7a), else the non-adjacent y (L7b)
const TRIM_P = 0.4;     // an on-0 'disp' arm is the L7c retrack trim (trimOps) instead of a stop walk
const NEXT_OFF_P = 0.3; // an 'lself' arm is the NEXT shape (rA offs rB; rC after it), else SELF (rA offs rA; rB after it)
const QUEUE_P = 0.6;    // a step advances the late-off-recycle sequence in flight
const FIRE_CAP = 0x3FFFFFFF;   // per-world counter stays Smi

/* ---- generator side (G0: the generator reads only its shadow model) ------------------------------------------ */

const SHADOW = new WeakMap();   // Gen -> { q: [g => op | null] } (the late-off-recycle sequence in flight)

function regsOn(g, t) {
    const out = [];
    const R = g.M.regs;
    for (let r = 0; r < R.length; r++) if (R[r] !== undefined && R[r].live && R[r].target === t) out.push(r);
    return out;
}

/** Live registrations on live targets. */
function heldRegs(g) {
    const out = [];
    const R = g.M.regs;
    for (let r = 0; r < R.length; r++) {
        const x = R[r];
        if (x !== undefined && x.live && g.M.n[x.target] !== undefined && g.M.n[x.target].live) out.push(r);
    }
    return out;
}

function single(g) { return g.ruleOff('single-reg'); }

function targets(g) {
    const one = single(g);
    return g.nodes((nd) => nd.t !== 'e' && (!one || regsOn(g, nd.i).length === 0));
}

function lreg(g, t, a) {
    const r = g.nextReg++;
    g.M.addReg(r, t);
    const op = { o: 'lreg', r, i: t };
    if (a !== null) op.a = a;
    return op;
}

function lregOp(g) {
    let t = -1;
    if (!single(g) && g.chance(CO_P)) {
        const held = heldRegs(g);
        if (held.length > 0) t = g.M.regs[g.pick(held)].target;
    }
    if (t < 0) {
        const ts = targets(g);
        if (ts.length === 0) return { o: 'read', is: [] };
        t = g.pick(ts);
    }
    return lreg(g, t, null);
}

function loffOp(g) {
    const live = [];
    const R = g.M.regs;
    for (let r = 0; r < R.length; r++) if (R[r] !== undefined && R[r].live) live.push(r);
    if (live.length === 0) return { o: 'read', is: [] };
    let pool = live;
    const x = g.r();
    if (x < 0.5) {
        const sib = live.filter((r) => g.M.n[R[r].target].live && regsOn(g, R[r].target).length >= 2);
        if (sib.length > 0) pool = sib;
    } else if (x < 0.65) {
        const late = live.filter((r) => !g.M.n[R[r].target].live);
        if (late.length > 0) pool = late;
    }
    const r = g.pick(pool);
    g.M.offReg(r);
    return { o: 'loff', r };
}

function lcEff(g, d) {
    return g.eff({ k: 'sum', d, try: true, role: 'lce' });
}

/** Observe or un-observe a registered target: an effect over [t, leaf?], or the stop of a lane effect. */
function wireOp(g) {
    const lce = g.nodes((nd) => nd.t === 'e' && nd.role === 'lce');
    if (lce.length > 0 && g.chance(0.4)) return g.stop(g.pick(lce));
    const held = heldRegs(g);
    if (held.length === 0) return lregOp(g);
    const t = g.M.regs[g.pick(held)].target;
    const d = [t];
    const ls = g.leaves().filter((l) => l !== t);
    if (ls.length > 0 && g.chance(0.7)) d.push(g.pick(ls));
    return lcEff(g, d);
}

/**
 * An armed callback action on a fresh target (the fire is certain on every kernel). E reads [tp, xs, ys] in that
 * order, so its stop walk unlinks tp, then xs: an on-0 'disp' of xs frees the walk's next link (L7a). 'loff' arms the
 * mirror pair rA (offs rB) then rB (offs rA) on tp (L8c on an ADD kernel; the old armed-second shape on overwrite).
 * 'lself' (emitted as k 'loff') arms rA alone: SELF rA offs rA, rB unarmed after it (T-LC-iter: off() must not cut
 * the walk standing on rA); NEXT rA offs rB, rB and rC unarmed after it (equivalent under that patch: the
 * predecessor is relinked past rB).
 */
function cbarmOps(g) {
    const on = g.chance(0.5) ? 1 : 0;
    let k = g.weighted(ACTIONS);
    if ((k === 'loff' || k === 'lself') && single(g)) k = 'disp';
    if (k === 'disp' && on === 0 && g.chance(TRIM_P)) return trimOps(g);
    const ops = [];
    const tp = g.sig({ role: 'lct', v: g.int(100) });
    const xs = g.sig({ role: 'lct', v: g.int(100) });   // the next dep: fresh, no sinks, no registration
    const ys = g.sig({ dis: true });
    ops.push(tp, xs, ys);
    let a;
    let b = null;   // the mirror partner's action ('loff' only)
    let offd = -1;  // 'lself': the registration rA's action offs (G0)
    if (k === 'loff') {
        a = { on, k, r: g.nextReg + 1 };   // rB, registered right after rA
        const rA = lreg(g, tp.i, a);
        b = { on, k, r: rA.r };
        ops.push(rA, lreg(g, tp.i, b));
    } else if (k === 'lself') {
        const rA = g.nextReg;
        if (g.chance(NEXT_OFF_P)) {
            offd = rA + 1;   // NEXT: rA offs rB, registered right after it; rC after rB
            a = { on, k: 'loff', r: offd };
            ops.push(lreg(g, tp.i, a), lreg(g, tp.i, null), lreg(g, tp.i, null));
        } else {
            offd = rA;       // SELF: rA offs itself; rB after it
            a = { on, k: 'loff', r: offd };
            ops.push(lreg(g, tp.i, a), lreg(g, tp.i, null));
        }
    } else if (k === 'lreg') {
        a = { on, k, r: -1, x: xs.i };
    } else if (k === 'set') {
        const ls = g.leaves();
        if (ls.length === 0) { k = 'disp'; a = { on, k, x: ys.i }; }
        else { const v = g.value(); a = { on, k, x: g.pick(ls), v: v === EQ_BOMB_CODE ? 0 : v }; }
    } else {
        a = { on, k, x: on === 0 && g.chance(NEXT_P) ? xs.i : ys.i };
    }
    if (b === null && offd < 0) ops.push(lreg(g, tp.i, a));
    const E = lcEff(g, [tp.i, xs.i, ys.i]);
    ops.push(E);
    if (on === 0) ops.push(g.stop(E.i));
    // G0: the action's effect on the shadow model, at generation time
    if (k === 'disp') g.M.kill(a.x);
    else if (k === 'lreg') { a.r = g.nextReg++; g.M.addReg(a.r, xs.i); }
    else if (k === 'loff') { g.M.offReg(a.r); g.M.offReg(b.r); }
    else if (k === 'lself') g.M.offReg(offd);
    else g.M.setValue(a.x, decodeValue(a.v));
    return ops;
}

/**
 * L7c (retrack trim): E = 'outer' over t then post [a, b, c] (reads [t, a, b, c]); registrations on a (armed on 0:
 * dispose b, the trim's next link), b and c; then a core 'arm' op: E's early mode on, t := a new value, so E re-runs
 * reading [t] alone and drops a, b, c, three consecutive reads. Returned as [ { seq build }, arm ] (cbarm wraps it).
 */
function trimOps(g) {
    const t = g.sig({ role: 'lct', v: g.int(100) });
    const a = g.sig({ role: 'lct', v: g.int(100) });
    const b = g.sig({ role: 'lct', v: g.int(100) });   // the victim: the trim's NEXT link after a
    const c = g.sig({ role: 'lct', v: g.int(100) });
    const act = { on: 0, k: 'disp', x: b.i };
    const build = [t, a, b, c, lreg(g, a.i, act), lreg(g, b.i, null), lreg(g, c.i, null)];
    const spec = { k: 'outer', t: t.i, pre: [], ic: null, icU: false, post: [a.i, b.i, c.i], try: true, role: 'lce' };
    const E = g.eff(spec);
    build.push(E);
    const v = (t.v + 1 + g.int(99)) % 100;   // Object.is-distinct from t's value, or E does not re-run
    const arm = { o: 'arm', O: E.i, x: -1, at: -1, child: -1, reg: -1, flip: -1, early: 1, t: t.i, v, pull: 0 };
    // G0: the arm's mode and write, then the action, on the shadow model
    g.M.setMode(E.i, 'early', true);
    g.M.setValue(t.i, decodeValue(v));
    g.M.kill(act.x);
    return [{ o: 'seq', ops: build }, arm];
}

/** L10: reg on y, observe y; later ops: dispose y, a fresh z registered + observed, the LATE off of y's reg, z unobserved. */
function recycleOps(g, st) {
    const y = g.sig({ dis: true });
    const ry = lreg(g, y.i, null);
    const ls = g.leaves();
    const E1 = lcEff(g, ls.length > 0 ? [y.i, g.pick(ls)] : [y.i]);
    let E2 = -1;
    st.q.push(
        (h) => (h.M.n[y.i].live ? h.disp(y.i) : null),
        (h) => {
            const z = h.sig({ dis: true });
            const rz = lreg(h, z.i, null);
            const l2 = h.leaves();
            const e = lcEff(h, l2.length > 0 ? [z.i, h.pick(l2)] : [z.i]);
            E2 = e.i;
            return { o: 'seq', ops: [z, rz, e] };
        },
        (h) => (h.M.regs[ry.r].live ? (h.M.offReg(ry.r), { o: 'loff', r: ry.r }) : null),
        (h) => (E2 >= 0 && h.M.n[E2].live ? h.stop(E2) : null),
    );
    return [y, ry, E1];
}

function init(g) {
    SHADOW.set(g, { q: [] });
    GRAPH.init(g);
    for (let k = 0; k < 3; k++) g.push(lregOp(g), true);
    for (let k = 0; k < 2; k++) g.push(wireOp(g), true);
}

function step(g) {
    const st = SHADOW.get(g);
    if (st.q.length > 0 && g.chance(QUEUE_P)) {
        while (st.q.length > 0) {
            const op = st.q.shift()(g);
            if (op !== null) { g.push(op); return; }
        }
    }
    switch (g.weighted(MIX)) {
        case 'graph': GRAPH.step(g); return;
        case 'lreg': g.push(lregOp(g)); return;
        case 'loff': g.push(loffOp(g)); return;
        case 'wire': g.push(wireOp(g)); return;
        case 'cbarm': g.push({ o: 'seq', ops: cbarmOps(g) }); return;
        case 'recycle':
            if (st.q.length > 0) { g.push(lregOp(g)); return; }
            g.push({ o: 'seq', ops: recycleOps(g, st) });
            return;
    }
}

/* ---- exec side (lane-owned ops, exec.mjs laneOp) ------------------------------------------------------------ */

export class LcState {
    constructor(step) {
        this.regs = [];
        this.prev = new Map();
        this.step = step;
        this.cbDepth = 0;
        this.actions = new Map();
        this.deadAt = new Map();
        this.fires = 0;
    }

    /** Record, for each live registration whose target is dead, the model node count when the death was first seen. */
    stampDeaths(M) {
        const R = this.regs;
        for (let r = 0; r < R.length; r++) {
            const g = R[r];
            if (g === undefined || !g.live || this.deadAt.has(g.target)) continue;
            const nd = M.n[g.target];
            if (nd === undefined || !nd.live) this.deadAt.set(g.target, M.n.length);
        }
    }

    /** End of an op (exec.mjs lcAtRest, after checkLcRest): fires reset, sink sets snapshotted, unfired actions dropped. */
    rest(M, memo) {
        this.stampDeaths(M);
        const R = this.regs;
        for (let r = 0; r < R.length; r++) if (R[r] !== undefined) R[r].fires.length = 0;
        const prev = new Map();
        for (let k = 0; k < M.n.length; k++) {
            const nd = M.n[k];
            if (nd !== undefined && nd.live && nd.t !== 'e') prev.set(k, M.sinkSet(k, memo));
        }
        this.prev = prev;
        this.actions.clear();
        this.step++;
    }
}

function unmodelled(x, msg) {
    x.unmodelled = new Error('exec: unmodelled lifecycle op: ' + msg);
    throw x.unmodelled;
}

function validAction(a) {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) return false;
    if (ACTION_KINDS.indexOf(a.k) === -1 || (a.on !== 0 && a.on !== 1)) return false;
    if (a.k === 'lreg' || a.k === 'loff') { if (!(Number.isInteger(a.r) && a.r >= 0)) return false; }
    if (a.k !== 'loff' && !Number.isInteger(a.x)) return false;
    if (a.k === 'set' && !Number.isInteger(a.v)) return false;
    return true;
}

/**
 * One fire of registration r: O7a, then (only if it passes) O7; a legal fire clears the attribution; the armed action.
 * checks.O7 counts once per registration checkLcFire checks: after O7a passed AND LcState holds r (else unmodelled).
 */
function cbOf(x, lc, r, kind) {
    return () => {
        x.cbDepth++;
        lc.cbDepth++;
        try {
            if (lc.fires < FIRE_CAP) lc.fires++;
            x.did('O7a');
            const f = checkFire(x.M, r, kind);
            if (f !== null) x.failF(f);
            else {
                if (lc.regs[r] === undefined) unmodelled(x, 'fire ' + kind + ' for registration r' + r + ' that LcState never recorded');
                x.did('O7');
                const f7 = checkLcFire(lc, r, kind);
                if (f7 !== null) x.failF(f7);
                else { const g = lc.regs[r]; g.co.clear(); g.sibOff = null; g.deadOff = null; }
            }
            const a = lc.actions.get(r);
            if (a !== undefined && (a.on === 1) === (kind === 'onConnect')) {
                lc.actions.delete(r);
                runAction(x, lc, a);
            }
        } catch (e) {
            // Q3: the callback never throws into the engine; an escape is an O6 failure (the sticky unmodelled
            // error is rethrown by exec.run after the op)
            if (e !== x.unmodelled) x.engineError(e, 'lifecycle callback r' + r + ' ' + kind);
        } finally {
            x.cbDepth--;
            lc.cbDepth--;
        }
    };
}

function runAction(x, lc, a) {
    switch (a.k) {
        case 'disp': {
            const nd = x.M.n[a.x];
            if (nd !== undefined && nd.live) { x.D.onLcCallbackDispose(); x.disposeIdx(a.x); }
            return;
        }
        case 'lreg': regLc(x, lc, a.r, a.x, null); return;
        case 'loff': { const h = lc.regs[a.r]; if (h !== undefined && h.live) offLc(x, lc, h); return; }
        case 'set': x.write(a.x, decodeValue(a.v)); return;
    }
}

function regLc(x, lc, r, i, a) {
    if (!(Number.isInteger(r) && r >= 0) || lc.regs[r] !== undefined) unmodelled(x, 'lreg r' + String(r) + ' is not a fresh registration id');
    if (a !== null && !validAction(a)) unmodelled(x, 'lreg r' + r + ' carries a malformed action ' + JSON.stringify(a));
    const M = x.M;
    const tn = M.n[i];
    if (tn === undefined || !tn.live || x.H[i] === undefined) return;   // a dead / absent target: a no-op
    const inCb = lc.cbDepth > 0;
    lc.stampDeaths(M);
    const g = {
        r, target: i, live: true, phase: inCb ? -1 : (M.sinkCount(i, new Map()) > 0 ? 1 : 0), fires: [], co: new Set(),
        sibOff: null, deadOff: null, off: null,
    };
    let others = 0;
    const R = lc.regs;
    for (let j = 0; j < R.length; j++) {
        const h = R[j];
        if (h === undefined || !h.live || h.target !== i) continue;
        h.co.add(r);
        g.co.add(j);
        h.deadOff = null;
        others++;
    }
    x.D.onLcReg(others, inCb);
    R[r] = g;
    M.addReg(r, i);
    if (a !== null) lc.actions.set(r, a);
    const cbs = { onConnect: cbOf(x, lc, r, 'onConnect'), onDisconnect: cbOf(x, lc, r, 'onDisconnect') };
    if (inCb) {
        try { g.off = x.W.lifecycle(x.H[i], cbs); } catch (e) { x.engineError(e, 'lifecycle() inside a callback'); }
    } else {
        x.guard(() => { g.off = x.W.lifecycle(x.H[i], cbs); });
    }
}

function offLc(x, lc, g) {
    const M = x.M;
    const inCb = lc.cbDepth > 0;
    const step = lc.step;
    lc.stampDeaths(M);
    const t = g.target;
    const tn = M.n[t];
    const R = lc.regs;
    let sib = 0;
    let recycled = false;
    if (tn !== undefined && tn.live) {
        for (let j = 0; j < R.length; j++) {
            const h = R[j];
            if (h === undefined || h === g || !h.live || h.target !== t) continue;
            if (h.sibOff === null) h.sibOff = { r: g.r, step };
            sib++;
        }
    } else {
        const dl = lc.deadAt.get(t);
        for (let j = 0; j < R.length; j++) {
            const h = R[j];
            if (h === undefined || h === g || !h.live) continue;
            const hn = M.n[h.target];
            if (hn === undefined || !hn.live || !(h.target >= dl)) continue;
            recycled = true;
            if (h.co.size === 0 && h.deadOff === null) h.deadOff = { r: g.r, d: t, step };
        }
    }
    x.D.onLcOff(sib, recycled, inCb);
    g.live = false;
    M.offReg(g.r);
    lc.actions.delete(g.r);
    const off = g.off;
    if (typeof off !== 'function') return;
    if (inCb) {
        try { off(); } catch (e) { x.engineError(e, 'off() inside a callback'); }
    } else {
        x.guard(() => off());
    }
}

function opLreg(x, op, k) {
    let lc = x.lc;
    if (lc === null) { lc = new LcState(k); x.lc = lc; }
    lc.step = k;
    regLc(x, lc, op.r, op.i, op.a === undefined ? null : op.a);
}

function opLoff(x, op, k) {
    if (!(Number.isInteger(op.r) && op.r >= 0)) unmodelled(x, 'loff r' + String(op.r) + ' is not a registration id');
    const lc = x.lc;
    if (lc === null) return;
    lc.step = k;
    const g = lc.regs[op.r];
    if (g === undefined || !g.live) return;   // shrunk away / already off: a no-op
    offLc(x, lc, g);
}

export const LIFECYCLE = Object.freeze({
    name: 'LIFECYCLE',
    index: 5,
    needsCaps: Object.freeze(['lifecycle', 'disposeSignal']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O7a', 'O7']),
    required: Object.freeze(['lc-two-regs', 'lc-off-sibling', 'lc-late-off-recycle', 'lc-callback-dispose', 'lc-callback-register']),
    optional: Object.freeze(['lc-callback-off-sibling']),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: 'GRAPH normal world (lanes/graph.mjs) + 3 registrations + 2 observers at init; 34% of steps lreg / loff / wire / armed callback / late-off recycle' }),
    flushPasses: null,
    covOff: Object.freeze({ 'lc-two-regs': 'single-reg' }),
    init,
    step,
    specRefs,
    ops: Object.freeze({ lreg: opLreg, loff: opLoff }),
});
