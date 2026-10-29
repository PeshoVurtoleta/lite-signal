/**
 * RECYCLE lane (S3 rung R4a, .handoff/PLAN-R4-recycle-sched.md TASK 2 + ADDENDA O7-O14, M5): STALE HANDLES -- a handle
 * kept after its node was disposed, used while the engine slot is dead or after the free list handed the slot to a new
 * node (signal, computed or effect). LANE_INDEX 11 (S3-D6). Rostered since R4a B3 (lanes/index.mjs ROSTER,
 * adapters/contract.mjs ORACLE_CAPS O9 and gates.mjs FAMILY).
 *
 * World: 2 base signals (never disposed) + few-slot churn (<= MAX_CHURN live churn nodes: signals, computeds and
 * effects over 1..2 base / churn value nodes), so the world holds <= 8 live nodes and a dispose + create reuses the
 * slot (the lite free list is LIFO across kinds: b129 T0 b). Values are small non-zero ints (1..9), so a stale read
 * that returns a resident's value is never confused with undefined. Churn nodes are created by the core sig / comp /
 * eff ops (gen.mjs emitters); a churn node is disposed only through rdisp, and only while no live churn node reads it
 * (no taint). Core set / read ops keep the residents moving.
 *
 * Ops (lane-owned, exec.mjs laneOp). Every op carries its ring index s (0..RING-1), so a shrunk script names a fixed
 * ring entry; an op on an empty entry (or on a handle kind the op does not take) is a no-op:
 *   rdisp  { i, s }        dispose live churn node i (exec.guard + exec.disposeIdx: model kill first) and retain its
 *                          handle in ring entry s (the older handle there is dropped)
 *   rsset  { s, v }        stale SIGNAL set(v) (v 1..9), guarded (O6)
 *   rsupd  { s, v }        stale SIGNAL update(fn) through the adapter update(h, fn) (cap recycle, b137), guarded
 *                          (O6); fn (rc.ufn, one closure per RcState) counts its calls and returns v (1..9)
 *   rsread { s, mode }     stale signal / computed read() or peek(), guarded (O6); mode 'read' | 'peek'
 *   rsdisp { s }           registry dispose of the stale handle: ALWAYS adapter dispose(h) = r.dispose(h) (O10)
 * O9 (oracles.mjs) is judged inside each stale op handler, right after the engine call: one did('O9') per judged op,
 * findings through failF. stale-read: the return is not undefined. stale-write (rsupd, D-b135-1 / D-b136-1, first):
 * update called fn or returned anything but undefined (checkO9Update); then (rsset and rsupd, M6 = D-b130-1,
 * checkO9Write, the detail naming the kind that mismatched): a live signal's peek is off the model, or an effect body ran during the op (the model's effect run counts), or -- only when both are
 * clean -- a CLEAN live computed peeks a value off the model (model.val). Clean is established, never assumed: rsset
 * (and rsupd) first pulls every live computed through exec.readCheck (O1c judged there, index order), so each one the model does
 * not taint has just evaluated; with no signal moved and no effect run since, its peek is a cached read. A tainted
 * computed is skipped, never peeked. The peek pass stops at the first mismatch (a computed downstream of a corrupted
 * one may be dirty) and counts a body run during it (exec.bodies moved) as a mismatch, so no body runs outside
 * readCheck on a correct engine. stale-dispose: stats() activeNodes /
 * activeLinks moved, or a live SIGNAL handle peeks undefined (a computed / effect resident a stale dispose kills moves
 * activeNodes; a computed peek here would run a body outside readCheck, so only signals are peeked). The at-rest
 * O1c / O5 lines a missing guard also trips follow by presence (R3 A5(a)).
 *
 * Slot belief (detectors only, never an oracle input): exec and the generator each replay the engine free list
 * (LIFO stack: a create pops the last freed slot, else takes a fresh one) over the nodes the world actually created,
 * in creation order (node index order). res (the kind of the node the stale handle's slot hosts now, null = dead) and
 * held (ring entries on that slot) are the exec's own. D.onRcStale(op, kind, res, held) counts the scenarios:
 * stale-write-recycled, stale-peek-recycled, stale-read-recycled, stale-dispose-recycled, stale-dead-unrecycled,
 * multi-gen (required); an upd counts only stale-dead-unrecycled and multi-gen (D-b136-2: no new scenario). The exec
 * replay agrees with the engine's slot reuse (b130 review probe .handoff/b130-evidence/review-b2b/scratch/bench/soak/
 * probe-replay.mjs: 679/679 resident-signal peeks x 3 kernels); the census shows each T-RC mutant breaching with its
 * own sig.
 * covOff stale-dispose-recycled -> rule stale-dispose-dead: rsdisp only names entries whose slot is dead.
 *
 * exec state (exec.rc, an RcState): set by the lane's first op, one per world (exec constructs rc = null per world, so
 * a world an unmodelled throw ends -- skipping rc.close() -- leaks nothing into the next). hs / hk / hslot: the fixed
 * ring of RING retained stale handles (preallocated; close() nulls it and never throws); free / host / slotOf: the
 * slot replay; st: int32 diagnostic counters (capped); ufn / ugo: the rsupd closures, built once per RcState (no
 * per-op closure), with their per-op slots uv / uh / uw / ucalls / uval. Fail closed (exec.unmodelled): a malformed
 * ring index, rsset / rsupd value or rsread mode, or a slot replay ahead of exec.H. rdisp on a dead / absent / non-integer i is a silent no-op,
 * as exec.disposeIdx is (a shrunk script).
 * COLD module: harness code, never an engine hot path.
 */

import { specRefs } from '../kinds.mjs';
import { checkO9Read, checkO9Write, checkO9Update, checkO9Dispose, checkComputed } from '../oracles.mjs';

const RING = 8;           // retained stale handles per world (power of 2)
const RING_MASK = RING - 1;
const MAX_CHURN = 6;      // live churn nodes (+ 2 base signals = 8 live nodes at most)
const ST_CAP = 0x3FFFFFFF;
const MIX = Object.freeze({ mk: 26, rdisp: 16, stale: 30, set: 15, read: 13 });
const STALE = Object.freeze({ rsset: 10, rsread: 12, rsdisp: 8, rsupd: 6 });   // a stale step = 2..5 of these (a seq)
const KIND = Object.freeze({ s: 27, c: 31, e: 42 });
const EFF_KEEP_P = 0.6;   // an rdisp prefers a non-effect victim
const BASE_P = 0.7;       // a core set targets a base signal (read by most churn nodes)

/* ---- slot replay (shared by the generator shadow and the exec RcState) ---------------------------------------- */

/** Node k was created: it takes the last freed slot (LIFO), else a fresh one. */
function slotAlloc(sl, k) {
    const slot = sl.free.length > 0 ? sl.free.pop() : sl.nslot++;
    sl.slotOf[k] = slot;
    sl.host[slot] = k;
    return slot;
}

/** Node k was disposed: its slot goes on top of the free list. */
function slotFree(sl, k) {
    const slot = sl.slotOf[k];
    sl.host[slot] = -1;
    sl.free.push(slot);
    return slot;
}

/** Ring entries (this one included) holding a stale handle on `slot`. */
function heldOn(kinds, slots, slot) {
    let n = 0;
    for (let j = 0; j < RING; j++) if (kinds[j] !== null && slots[j] === slot) n++;
    return n;
}

/* ---- generator side (G0: the generator reads only its shadow model) ------------------------------------------ */

const SHADOW = new WeakMap();   // Gen -> the shadow slot replay + churn bookkeeping + ring

function shadowOf(g) {
    let s = SHADOW.get(g);
    if (s === undefined) {
        s = { free: [], nslot: 0, slotOf: [], host: [], churn: [], base: [], rd: [], rk: new Array(RING).fill(null), rslot: new Int32Array(RING), cur: 0 };
        SHADOW.set(g, s);
    }
    return s;
}

/** The kind the shadow slot hosts now ('s' | 'c' | 'e'), or null when it is dead. */
function resOf(g, sh, slot) {
    const k = sh.host[slot];
    return k === undefined || k < 0 ? null : g.M.n[k].t;
}

function val(g) { return 1 + g.int(9); }

function mkSig(g, sh, role) {
    const op = g.sig({ v: val(g), role });
    slotAlloc(sh, op.i);
    sh.rd[op.i] = 0;
    return op;
}

/** A churn node of kind k: a computed / effect over 1 (10%), 2 (55%) or 3 (35%) distinct live value nodes (base + churn signals / computeds; fewer when the pool is smaller). */
function mkNode(g, sh, k) {
    if (k === 's') { const op = mkSig(g, sh, 'rc'); sh.churn.push(op.i); return op; }
    const pool = sh.base.slice();
    for (const j of sh.churn) if (g.M.n[j].t !== 'e') pool.push(j);
    const x = g.r();
    const d = g.some(pool, x < 0.1 ? 1 : x < 0.65 ? 2 : 3);
    const spec = { k: d.length === 1 ? 'identity' : 'sum', d, role: 'rc' };
    const op = k === 'c' ? g.comp(spec, g.chance(0.8)) : g.eff(spec);
    slotAlloc(sh, op.i);
    sh.rd[op.i] = 0;
    for (const j of d) sh.rd[j]++;
    sh.churn.push(op.i);
    return op;
}

function mkOp(g, sh) {
    if (sh.churn.length >= MAX_CHURN) return dispOp(g, sh);
    return mkNode(g, sh, g.weighted(KIND));
}

function dispOp(g, sh) {
    const free = sh.churn.filter((j) => sh.rd[j] === 0);
    if (free.length === 0) return sh.churn.length >= MAX_CHURN ? setOp(g, sh) : mkNode(g, sh, g.weighted(KIND));
    // keep effects alive longer (O4 / O1e density): a non-effect victim is preferred when there is one
    const ne = free.filter((j) => g.M.n[j].t !== 'e');
    const i = ne.length > 0 && g.chance(EFF_KEEP_P) ? g.pick(ne) : g.pick(free);
    const nd = g.M.n[i];
    if (nd.t !== 's') for (const j of nd.spec.d) sh.rd[j]--;
    sh.churn.splice(sh.churn.indexOf(i), 1);
    g.M.kill(i);
    const s = sh.cur;
    sh.cur = (sh.cur + 1) & RING_MASK;
    sh.rk[s] = nd.t;
    sh.rslot[s] = slotFree(sh, i);
    return { o: 'rdisp', i, s };
}

/** A ring entry whose kind passes kp; with probability p one whose slot hosts a live value node now. -1 = none. */
function pickEntry(g, sh, kp, p) {
    const all = [];
    const rec = [];
    for (let j = 0; j < RING; j++) {
        const k = sh.rk[j];
        if (k === null || !kp(k)) continue;
        all.push(j);
        const r = resOf(g, sh, sh.rslot[j]);
        if (r === 's' || r === 'c') rec.push(j);
    }
    if (all.length === 0) return -1;
    return rec.length > 0 && g.chance(p) ? g.pick(rec) : g.pick(all);
}

function pickSet(g, sh) {
    const s = pickEntry(g, sh, (k) => k === 's', 0.75);
    if (s < 0) return null;
    return { o: 'rsset', s, v: val(g) };
}

function pickUpd(g, sh) {
    const s = pickEntry(g, sh, (k) => k === 's', 0.75);
    if (s < 0) return null;
    return { o: 'rsupd', s, v: val(g) };
}

function pickRead(g, sh) {
    const s = pickEntry(g, sh, (k) => k !== 'e', 0.7);
    if (s < 0) return null;
    const r = resOf(g, sh, sh.rslot[s]);
    // T-RC-readgen moves ONLY a stale SIGNAL peek on a slot hosting a signal / computed (b129 T0 S5): peek it mostly
    const peek = sh.rk[s] === 's' && (r === 's' || r === 'c') ? g.chance(0.7) : g.chance(0.5);
    return { o: 'rsread', s, mode: peek ? 'peek' : 'read' };
}

function pickDisp(g, sh) {
    let s;
    if (g.ruleOff('stale-dispose-dead')) {
        const dead = [];
        for (let j = 0; j < RING; j++) if (sh.rk[j] !== null && resOf(g, sh, sh.rslot[j]) === null) dead.push(j);
        s = dead.length > 0 ? g.pick(dead) : -1;
    } else {
        s = pickEntry(g, sh, () => true, 0.3);
    }
    if (s < 0) return null;
    return { o: 'rsdisp', s };
}

/** One stale step: 2..5 stale ops (each judged on its own), a seq when > 1; none possible -> a create. */
function staleOp(g, sh) {
    const n = 2 + g.int(4);
    const ops = [];
    for (let k = 0; k < n; k++) {
        const w = g.weighted(STALE);
        const s = w === 'rsset' ? pickSet(g, sh) : w === 'rsread' ? pickRead(g, sh) : w === 'rsupd' ? pickUpd(g, sh) : pickDisp(g, sh);
        if (s !== null) ops.push(s);
    }
    if (ops.length === 0) return mkOp(g, sh);
    return ops.length === 1 ? ops[0] : { o: 'seq', ops };
}

function setOp(g, sh) {
    const cs = sh.churn.filter((j) => g.M.n[j].t === 's');
    const ss = cs.length === 0 || g.chance(BASE_P) ? sh.base : cs;
    const i = g.pick(ss);
    const op = g.set(i, ((g.M.n[i].v + g.int(8)) % 9) + 1);   // 1..9, never the current value
    if (ss !== sh.base || !g.chance(0.2)) return op;
    const j = sh.base[0] === i ? sh.base[1] : sh.base[0];   // both base signals, one after the other
    return { o: 'seq', ops: [op, g.set(j, ((g.M.n[j].v + g.int(8)) % 9) + 1)] };
}

function readOp(g, sh) {
    const cs = sh.churn.filter((j) => g.M.n[j].t === 'c');
    if (cs.length === 0) return mkOp(g, sh);
    return { o: 'read', is: cs };   // every live churn computed, top-level pulls (O1c)
}

function init(g) {
    const sh = shadowOf(g);
    for (let k = 0; k < 2; k++) { const op = mkSig(g, sh, 'base'); sh.base.push(op.i); g.push(op, true); }
    g.push(mkNode(g, sh, 's'), true);
    g.push(mkNode(g, sh, 'c'), true);
    g.push(mkNode(g, sh, 'e'), true);
}

function step(g) {
    const sh = shadowOf(g);
    switch (g.weighted(MIX)) {
        case 'mk': g.push(mkOp(g, sh)); return;
        case 'rdisp': g.push(dispOp(g, sh)); return;
        case 'stale': g.push(staleOp(g, sh)); return;
        case 'set': g.push(setOp(g, sh)); return;
        case 'read': g.push(readOp(g, sh)); return;
    }
}

/* ---- exec side --------------------------------------------------------------------------------------------- */

/** exec.rc: the RECYCLE lane's per-world state (exec.mjs run() calls close() once, after W.close()). */
export class RcState {
    constructor() {
        this.hs = new Array(RING).fill(null);   // the retained stale handles
        this.hk = new Array(RING).fill(null);   // their kinds 's' | 'c' | 'e' (null = empty entry)
        this.hslot = new Int32Array(RING);      // their slots (slot replay)
        this.free = [];
        this.nslot = 0;
        this.slotOf = [];
        this.host = [];
        this.seen = 0;   // exec.H indices the slot replay has caught up with
        this.st = { rdisp: 0, set: 0, upd: 0, read: 0, peek: 0, disp: 0, recycled: 0, dead: 0 };
        // rsupd (opUpd): per-op slots + two closures built here once, so an rsupd op allocates no closure of its own
        this.uv = 0;            // the value ufn returns (op.v, 1..9)
        this.uh = null;         // the stale handle under update
        this.uw = null;         // the world (exec.W) whose update(h, fn) ugo calls
        this.ucalls = 0;        // ufn calls during the current op
        this.uval = undefined;  // what update(h, fn) returned (exec.guard discards its fn's return)
        this.ufn = () => { this.ucalls = (this.ucalls + 1) | 0; return this.uv; };
        this.ugo = () => { this.uval = this.uw.update(this.uh, this.ufn); };
    }

    /** Teardown: drop every retained handle and the replay. Never throws. */
    close() {
        for (let j = 0; j < RING; j++) { this.hs[j] = null; this.hk[j] = null; }
        this.uh = null;
        this.uw = null;
        this.uval = undefined;
        this.free.length = 0;
        this.slotOf.length = 0;
        this.host.length = 0;
    }
}

function unmodelled(x, msg) {
    x.unmodelled = new Error('exec: unmodelled recycle op: ' + msg);
    throw x.unmodelled;
}

function bump(st, key) { if (st[key] < ST_CAP) st[key] = (st[key] + 1) | 0; }

/** exec.rc, created on the lane's first op; the slot replay catches up with every node created since the last op. */
function stateOf(x) {
    let rc = x.rc;
    if (rc === null) { rc = new RcState(); x.rc = rc; }
    const H = x.H;
    if (rc.seen > H.length) unmodelled(x, 'slot replay ahead of exec.H (' + rc.seen + ' > ' + H.length + ')');
    for (let k = rc.seen; k < H.length; k++) if (H[k] !== undefined) slotAlloc(rc, k);
    if (H.length > rc.seen) rc.seen = H.length;
    return rc;
}

function ringIndex(x, s) {
    if (!Number.isInteger(s) || s < 0 || s > RING_MASK) unmodelled(x, 'ring index ' + JSON.stringify(s) + ' outside [0, ' + RING_MASK + ']');
    return s;
}

/** Count ring entry s's stale op on the scenario detectors (res / held from the exec slot replay). */
function report(x, rc, s, op) {
    const slot = rc.hslot[s];
    const k = rc.host[slot];
    const nd = k === undefined || k < 0 ? undefined : x.M.n[k];
    const res = nd === undefined || !nd.live ? null : nd.t;
    bump(rc.st, res === null ? 'dead' : 'recycled');
    x.D.onRcStale(op, rc.hk[s], res, heldOn(rc.hk, rc.hslot, slot));
}

function label(rc, op, s) { return op + ' ring ' + s + ' (stale ' + rc.hk[s] + ' handle, slot ' + rc.hslot[s] + ')'; }

/** Sum of the model's effect run counts (exec.runBody bumps nd.runs on every body run). */
function effRuns(x) {
    const n = x.M.n;
    let r = 0;
    for (let k = 0; k < n.length; k++) if (n[k] !== undefined && n[k].t === 'e') r += n[k].runs;
    return r;
}

/** Live signals whose engine peek is off the model (mode 0) or reads undefined (mode 1). A throwing peek is O6. */
function liveSignals(x, mode) {
    const n = x.M.n;
    let bad = 0;
    for (let k = 0; k < n.length; k++) {
        const nd = n[k];
        if (nd === undefined || !nd.live || nd.t !== 's' || x.H[k] === undefined) continue;
        let v;
        try { v = x.W.peek(x.H[k]); } catch (e) { x.engineError(e, 'peek of live signal #' + k); bad++; continue; }
        if (mode === 0 ? !Object.is(v, nd.v) : v === undefined) bad++;
    }
    return bad;
}

/** Pull every live computed through exec.readCheck (O1c); returns the ones the model does not taint (clean now). */
function prePull(x) {
    const M = x.M;
    const out = [];
    for (let k = 0; k < M.n.length; k++) {
        const nd = M.n[k];
        if (nd === undefined || !nd.live || nd.t !== 'c' || x.H[k] === undefined) continue;
        x.readCheck(k, false);
        if (nd.live && !M.tainted(k, new Map())) out.push(k);
    }
    return out;
}

/** M6: 1 when a clean computed (prePull) peeks off model.val, a peek throws or runs a body; else 0. Stops at the first. */
function cleanComputeds(x, cs) {
    const M = x.M;
    const b0 = x.bodies;
    const memo = new Map();
    for (const k of cs) {
        if (!M.n[k].live) continue;
        let got;
        try { got = x.W.peek(x.H[k]); } catch (e) { x.engineError(e, 'peek of clean computed #' + k); return 1; }
        if (x.bodies !== b0 || checkComputed(M, k, got, memo) !== null) return 1;
    }
    return 0;
}

function statsOf(x) {
    try { return x.W.stats(); } catch (e) { x.engineError(e, 'stats()'); return null; }
}

function opDisp(x, op) {
    const rc = stateOf(x);
    const s = ringIndex(x, op.s);
    const i = op.i;
    const nd = Number.isInteger(i) && i >= 0 ? x.M.n[i] : undefined;
    if (nd === undefined || !nd.live || x.H[i] === undefined) return;   // shrunk away / dead
    const h = x.H[i];
    x.guard(() => x.disposeIdx(i));
    rc.hs[s] = h;
    rc.hk[s] = nd.t;
    rc.hslot[s] = slotFree(rc, i);
    bump(rc.st, 'rdisp');
}

function opSet(x, op) {
    const rc = stateOf(x);
    const s = ringIndex(x, op.s);
    const v = op.v;
    if (!(Number.isInteger(v) && v >= 1 && v <= 9)) unmodelled(x, 'rsset value ' + JSON.stringify(v) + ' is not 1..9');
    if (rc.hk[s] !== 's') return;   // empty entry / not a signal handle (a shrunk script)
    const h = rc.hs[s];
    const cs = prePull(x);
    const e0 = effRuns(x);
    x.guard(() => x.W.set(h, v));
    x.did('O9');
    let mism = liveSignals(x, 0);
    const ran = effRuns(x) - e0;
    let kind = 'signal';
    if (mism === 0 && ran === 0) { mism = cleanComputeds(x, cs); kind = 'computed'; }
    const f = checkO9Write(label(rc, 'rsset', s), mism, ran, kind);
    if (f !== null) x.failF(f);
    bump(rc.st, 'set');
    report(x, rc, s, 'set');
}

/** rsupd: update(fn) through a stale signal handle (D-b135-1: fn never called, undefined returned, nothing moved). */
function opUpd(x, op) {
    const rc = stateOf(x);
    const s = ringIndex(x, op.s);
    const v = op.v;
    if (!(Number.isInteger(v) && v >= 1 && v <= 9)) unmodelled(x, 'rsupd value ' + JSON.stringify(v) + ' is not 1..9');
    if (rc.hk[s] !== 's') return;   // empty entry / not a signal handle (a shrunk script)
    const cs = prePull(x);
    const e0 = effRuns(x);
    rc.uh = rc.hs[s];
    rc.uw = x.W;
    rc.uv = v;
    rc.ucalls = 0;
    rc.uval = undefined;
    x.guard(rc.ugo);
    x.did('O9');
    let mism = liveSignals(x, 0);
    const ran = effRuns(x) - e0;
    let kind = 'signal';
    if (mism === 0 && ran === 0) { mism = cleanComputeds(x, cs); kind = 'computed'; }
    const lbl = label(rc, 'rsupd', s);
    const f = checkO9Update(lbl, rc.ucalls, rc.uval) ?? checkO9Write(lbl, mism, ran, kind);
    rc.uh = null;
    rc.uval = undefined;
    if (f !== null) x.failF(f);
    bump(rc.st, 'upd');
    report(x, rc, s, 'upd');
}

function opRead(x, op) {
    const rc = stateOf(x);
    const s = ringIndex(x, op.s);
    const peek = op.mode === 'peek';
    if (!peek && op.mode !== 'read') unmodelled(x, 'rsread mode ' + JSON.stringify(op.mode) + ' is not read / peek');
    const k = rc.hk[s];
    if (k === null || k === 'e') return;   // empty entry / an effect handle (a shrunk script)
    const h = rc.hs[s];
    let got;
    x.guard(() => { got = peek ? x.W.peek(h) : x.W.read(h); });
    x.did('O9');
    const f = checkO9Read(label(rc, peek ? 'rsread peek' : 'rsread read', s), got);
    if (f !== null) x.failF(f);
    bump(rc.st, peek ? 'peek' : 'read');
    report(x, rc, s, peek ? 'peek' : 'read');
}

function opSDisp(x, op) {
    const rc = stateOf(x);
    const s = ringIndex(x, op.s);
    if (rc.hk[s] === null) return;   // empty entry (a shrunk script)
    const h = rc.hs[s];
    const s0 = statsOf(x);
    x.guard(() => x.W.dispose(h));   // adapter dispose(h) = r.dispose(h) (O10)
    const s1 = statsOf(x);
    if (s0 !== null && s1 !== null) {
        x.did('O9');
        const f = checkO9Dispose(label(rc, 'rsdisp', s), s0.activeNodes, s1.activeNodes, s0.activeLinks, s1.activeLinks, liveSignals(x, 1));
        if (f !== null) x.failF(f);
    }
    bump(rc.st, 'disp');
    report(x, rc, s, 'disp');
}

export const RECYCLE = Object.freeze({
    name: 'RECYCLE',
    index: 11,
    needsCaps: Object.freeze(['recycle', 'disposeSignal', 'disposeComputed', 'stopEffect', 'links']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O9']),
    required: Object.freeze(['stale-write-recycled', 'stale-peek-recycled', 'stale-read-recycled', 'stale-dispose-recycled', 'stale-dead-unrecycled', 'multi-gen']),
    optional: Object.freeze([]),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: '2 base signals + <= 6 churn nodes (<= 8 live); dispose + create recycles the LIFO slot; stale set / read / peek / registry dispose through a ring of 8 retained handles' }),
    flushPasses: null,
    covOff: Object.freeze({ 'stale-dispose-recycled': 'stale-dispose-dead' }),
    init,
    step,
    specRefs,
    ops: Object.freeze({ rdisp: opDisp, rsset: opSet, rsread: opRead, rsdisp: opSDisp, rsupd: opUpd }),
});
