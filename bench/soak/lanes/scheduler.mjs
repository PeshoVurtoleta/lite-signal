/**
 * SCHEDULER lane (S3 rung R4c, .handoff/PLAN-R4-recycle-sched.md R4c TASK 2 + ADDENDA O15 / O16): effects created with
 * a SCHEDULER (registry.effect(fn, { scheduler })) whose runs -- the first one included (p2 relaxed) -- are thunks the
 * lane queues and delivers later, in an order of its own. LANE_INDEX 8 (S3-D6). Rostered in R4c B3 (b134):
 * lanes/index.mjs ROSTER; contract.mjs ORACLE_CAPS O9 ['recycle'] and gates.mjs FAMILY O9 already admit it (no edit).
 *
 * World: 3 base signals (never disposed, values 1..9), 2 computeds over them (never disposed, no throw), and 3..MAX_EFF
 * live effects over base signals / computeds -- scheduled (sch 1) or plain (sch 0). G-SC1: every effect body is a kinds
 * spec (sum / identity / select / cond / hash) with no throw rule and no in-body write, over nodes that never throw, so
 * a delivery runs at most the delivered effect's own body and nothing it could write.
 *
 * Ops (lane-owned, exec.mjs laneOp):
 *   screate { ci, spec, sch }  create effect ci over spec; sch 1 = scheduled (its own scheduler fn, made here, cold),
 *                              sch 0 = plain (the S1 effect path). Fails closed (exec.unmodelled): sch not 0 / 1, ci not a
 *                              fresh integer index below MAX_NODES, a spec outside G-SC1
 *   sdrain { n }               deliver n thunks (1..4), or 0 = all: loop until the ring is empty (bound DRAIN_BOUND pops,
 *                              else fail closed). Then Detectors.onScDrain(n, delivered)
 *   swrite { i, v }            set signal i to v (1..9) at top level (exec.setTop); Detectors.onScWrite(i, changed) first,
 *                              before the set reaches the engine
 *   sdisp  { i }               dispose effect i (exec.guard + exec.disposeIdx: model kill first); its queued thunks stay
 *                              queued (dead thunks, delivered later: thunk-after-dispose)
 *   srec   { i, ci, spec }     in ONE engine batch: dispose live scheduled effect i, then screate a scheduled successor
 *                              ci (the LIFO free list hands it i's slot: b131 T0 b, all 3 kernels); records succ[i] = ci
 * swrite / sdisp / srec fail closed (exec.unmodelled 'exec: unmodelled scheduler op: <op> i ...') unless i is an integer
 * in [0, MAX_NODES) other than -0, and ('<op> #i is a <t>') when i is a node of the wrong kind, live or dead (swrite:
 * not a signal; sdisp: not an effect; srec: a LIVE node, handle or not, that is not a scheduled effect). Only an absent
 * node, or a dead / no-handle node OF THE RIGHT KIND, is a shrunk script: swrite / sdisp do nothing, srec only creates
 * ci. screate ci / sch and sdrain n reject -0 too.
 * Every script ENDS with sdrain { n: 0 } (the generator keeps one trailing drain-all and moves it after each step), so
 * exec.scEnd() finds every pend 0. A shrunk script without it fails closed there (unmodelled).
 *
 * Scheduler fn (one per scheduled effect): function (run) -> push (i, run) on the ring, pend[i]++, count a defined
 * `this` (st.thisDef only: #48 / M3, never judged). A non-function run or a FULL ring sets exec.unmodelled and throws
 * it (fail closed: a thunk is never dropped; exec rethrows the sticky unmodelled after the op). Every push stamps the
 * entry with the world's push sequence number (ringS; a HOLD re-queue keeps its stamp).
 * Policy per world from the script seed (policyOf): FIFO, LIFO or HOLD (pop the head; the first pop of an entry re-queues
 * it at the tail with its held bit set, the second pop delivers it). Delivery: null the slot, pend[i]--, count the
 * entries still queued as older (pushed before the delivered one) / younger (after), detector
 * onScDeliver(i, recycled, retried, older, younger), then under exec.guard dlv = 1, cur = i, run() in try / finally
 * (cur = -1, dlv = 0).
 *
 * O9 stale-thunk (oracles.mjs checkStaleThunk / checkScheduledBody): exec calls sc.onBody(i, depth) at every runBody
 * entry; only depth-1 EFFECT bodies are looked at (deeper bodies and computed bodies -- an effect pre-walk pulls them at
 * depth 1 too -- never). Outside any delivery (dlv 0) a scheduled (sch 1) effect body is a finding (checkScheduledBody:
 * the engine ran it synchronously, not through its thunk; did('O9'), st.outside); an unscheduled one is not judged.
 * During a delivery (cur !== -1) the FIRST such body is judged -- the delivered node cur must be live and i === cur --
 * then cur = -1; later bodies of the same delivery are unjudged (silent). Each judged delivery counts did('O9'). A
 * delivery that runs no body is not judged (a dead or clean thunk runs none).
 * KNOWN R1 / R2 (test/58) are tolerated by construction: scheduler calls, deliveries and bodies are counters only.
 * Suspension (exec.atRest): a live effect with pend > 0 skips O1e / O4 (counted st.susp by exec); after the drain its
 * pend is 0 and O1e / O4 judge it in full (a lost re-schedule = O4 effect-dead; a lost first run = O4 never ran).
 *
 * Slot view (detector only, never an oracle input): succ[i] = the srec successor of i. recycled = i is dead, succ[i]
 * is a live scheduled effect and pend[succ[i]] > 0 at the delivery. An sdisp followed by a later screate may also
 * reuse the slot; the lane does not count that pair (no full slot replay). covOff thunk-recycled -> rule no-recycle:
 * srec is never emitted (an sdisp takes its draw).
 *
 * exec state (exec.sc, an ScState): created by the lane's first op, one per world (exec constructs sc = null per world,
 * so a world an unmodelled throw ends -- skipping sc.close() -- leaks nothing into the next). Preallocated: ringI
 * Int32Array(RING), ringT Array(RING) (thunks), ringH Uint8Array(RING) (held bits), ringS Int32Array(RING) (push
 * sequence stamps; seq = the next stamp, fail closed past ST_CAP), pend / succ Int32Array(MAX_NODES), dlv (1 while a
 * delivery runs its thunk). st: int32 diagnostic counters (capped; st.outside = scheduled bodies run outside any
 * delivery). close() never throws: nulls every ring slot, empties the ring, clears cur / dlv, drops exec (exec.scClosed
 * then fails the world closed when size, x or any ringT slot is left set).
 * COLD module: harness code, never an engine hot path.
 */

import { specRefs } from '../kinds.mjs';
import { checkStaleThunk, checkScheduledBody } from '../oracles.mjs';

export const RING = 256;          // queued thunks per world (power of 2)
const RING_MASK = RING - 1;
export const MAX_NODES = 4096;    // pend / succ cover every node index of a world
export const DRAIN_BOUND = 1024;  // pops per sdrain (HOLD pops an entry twice)
const ST_CAP = 0x3FFFFFFF;
const MAX_EFF = 7;                // live effects (with 3 base signals + 2 computeds: <= 12 live nodes)
const MIN_EFF = 3;
export const POLICY = Object.freeze(['FIFO', 'LIFO', 'HOLD']);
const P_FIFO = 0, P_LIFO = 1, P_HOLD = 2;
const MIX = Object.freeze({ wd: 44, w: 10, drain: 10, mk: 10, disp: 8, rec: 15, read: 3 });
const DRAIN_N = Object.freeze({ all: 38, n1: 22, n2: 18, n3: 12, n4: 10 });
const SPEC_KINDS = Object.freeze({ sum: 6, identity: 1.5, select: 1, cond: 1, hash: 1 });
const G_SC1_KINDS = Object.freeze(['sum', 'identity', 'select', 'cond', 'hash']);
const SCH_P = 0.8;                // a new effect is scheduled
const DISP_PEND_P = 0.7;          // an sdisp prefers a pended effect
const LABELS = Object.freeze(['sdrain FIFO delivery', 'sdrain LIFO delivery', 'sdrain HOLD delivery']);

/** The world's delivery policy from its seed (0 FIFO, 1 LIFO, 2 HOLD); the generator and exec both call it. */
export function policyOf(seed) {
    let h = (seed >>> 0) ^ 0x5CED5CED;
    h = Math.imul(h ^ (h >>> 16), 0x45D9F3B);
    h = Math.imul(h ^ (h >>> 16), 0x45D9F3B);
    return ((h ^ (h >>> 16)) >>> 0) % 3;
}

/* ---- generator side (G0: the generator reads only its shadow model) ------------------------------------------ */

const SHADOW = new WeakMap();   // Gen -> base / computeds / effects + a shadow queue (an approximation: preferences only)

function shadowOf(g) {
    let s = SHADOW.get(g);
    if (s === undefined) {
        s = { base: [], comps: [], effs: [], sch: [], pend: [], q: [], pol: policyOf(g.seed), tail: null, cones: new Map() };
        SHADOW.set(g, s);
    }
    return s;
}

function val(g) { return 1 + g.int(9); }

function shPush(sh, i) { sh.q.push({ i, h: 0 }); sh.pend[i] = (sh.pend[i] | 0) + 1; }

/** Shadow delivery of up to n thunks (0 = all) under the world policy. Approximate (static cones, keep-QUEUED). */
function shDrain(sh, n) {
    let d = 0;
    while (sh.q.length > 0 && (n === 0 || d < n)) {
        const e = sh.pol === P_LIFO ? sh.q.pop() : sh.q.shift();
        if (sh.pol === P_HOLD && e.h === 0) { e.h = 1; sh.q.push(e); continue; }
        sh.pend[e.i]--;
        d++;
    }
}

function coneOf(g, sh, k) {
    let c = sh.cones.get(k);
    if (c === undefined) { c = g.cone(k); sh.cones.set(k, c); }
    return c;
}

/** A value-changing write of base s schedules every live scheduled effect over s with no thunk pending (keep-QUEUED). */
function shWrite(g, sh, s) {
    for (const k of sh.effs) if (sh.sch[k] === 1 && (sh.pend[k] | 0) === 0 && coneOf(g, sh, k).has(s)) shPush(sh, k);
}

function effSpec(g, sh) {
    const pool = sh.base.concat(sh.comps);
    const x = g.r();
    const spec = g.bodySpec(pool, { kinds: SPEC_KINDS, fan: x < 0.1 ? 1 : x < 0.45 ? 2 : 3, selectors: sh.base });
    spec.role = 'sc';
    return spec;
}

/** A new effect node; returns the screate op. */
function mkEff(g, sh, spec, sch) {
    const ci = g.next++;
    g.M.addEffect(ci, spec, -1, sch);
    sh.sch[ci] = sch;
    sh.pend[ci] = 0;
    sh.effs.push(ci);
    if (sch === 1) shPush(sh, ci);   // the deferred first run
    return { o: 'screate', ci, spec, sch };
}

function killEff(g, sh, i) {
    sh.effs.splice(sh.effs.indexOf(i), 1);
    g.M.kill(i);
}

function writeOp(g, sh, same) {
    const i = g.pick(sh.base);
    const old = g.M.n[i].v;
    const v = same ? old : ((old + g.int(8)) % 9) + 1;   // 1..9; never the current value unless same
    g.M.setValue(i, v);
    if (!same) shWrite(g, sh, i);
    return { o: 'swrite', i, v };
}

function drainOp(g, sh) {
    const w = g.weighted(DRAIN_N);
    const n = w === 'all' ? 0 : w === 'n1' ? 1 : w === 'n2' ? 2 : w === 'n3' ? 3 : 4;
    shDrain(sh, n);
    return { o: 'sdrain', n };
}

function mkOp(g, sh) {
    if (sh.effs.length >= MAX_EFF) return dispOp(g, sh);
    return mkEff(g, sh, effSpec(g, sh), g.chance(SCH_P) ? 1 : 0);
}

function dispOp(g, sh) {
    if (sh.effs.length <= MIN_EFF) return mkOp(g, sh);
    const pended = sh.effs.filter((k) => (sh.pend[k] | 0) > 0);
    const i = pended.length > 0 && g.chance(DISP_PEND_P) ? g.pick(pended) : g.pick(sh.effs);
    killEff(g, sh, i);
    return { o: 'sdisp', i };
}

/** srec on a scheduled effect: pended -> srec alone; else a write into its cone first, so it is pended (shadow belief). */
function recOp(g, sh) {
    if (g.ruleOff('no-recycle')) return dispOp(g, sh);
    const sched = sh.effs.filter((k) => sh.sch[k] === 1);
    if (sched.length === 0) return mkOp(g, sh);
    const pended = sched.filter((k) => (sh.pend[k] | 0) > 0);
    const i = pended.length > 0 ? g.pick(pended) : g.pick(sched);
    let pre = null;
    if ((sh.pend[i] | 0) === 0) {
        const bs = sh.base.filter((s) => coneOf(g, sh, i).has(s));
        if (bs.length > 0) {
            const s = g.pick(bs);
            const v = ((g.M.n[s].v + g.int(8)) % 9) + 1;
            g.M.setValue(s, v);
            shWrite(g, sh, s);
            pre = { o: 'swrite', i: s, v };
        }
    }
    killEff(g, sh, i);
    const c = mkEff(g, sh, effSpec(g, sh), 1);
    const op = { o: 'srec', i, ci: c.ci, spec: c.spec };
    return pre === null ? op : { o: 'seq', ops: [pre, op] };
}

function readOp(g, sh) {
    return { o: 'read', is: sh.comps.slice() };   // both computeds, top-level pulls (O1c)
}

/** Keep exactly one trailing drain-all at the end of the script (exec.scEnd needs every pend 0 at the world end). */
function untail(g, sh) {
    if (sh.tail === null) return;
    if (g.ops.length === 0 || g.ops[g.ops.length - 1] !== sh.tail) throw new Error('lanes/scheduler: the trailing drain-all is not the last op');
    g.ops.pop();
    sh.tail = null;
}

function retail(g, sh) { sh.tail = g.push({ o: 'sdrain', n: 0 }, true); }

function init(g) {
    const sh = shadowOf(g);
    for (let k = 0; k < 3; k++) { const op = g.sig({ v: val(g), role: 'base' }); sh.base.push(op.i); g.push(op, true); }
    for (let k = 0; k < 2; k++) {
        const spec = g.bodySpec(sh.base, { kinds: { sum: 3, identity: 1, hash: 1 }, fan: 2 });
        spec.role = 'comp';
        const op = g.comp(spec, true);
        sh.comps.push(op.i);
        g.push(op, true);
    }
    for (let k = 0; k < 5; k++) g.push(mkEff(g, sh, effSpec(g, sh), k < 4 ? 1 : 0), true);
    retail(g, sh);
}

function step(g) {
    const sh = shadowOf(g);
    untail(g, sh);
    switch (g.weighted(MIX)) {
        case 'wd': { const w = writeOp(g, sh, false); g.push({ o: 'seq', ops: [w, drainOp(g, sh)] }); break; }
        case 'w': g.push(writeOp(g, sh, g.chance(0.1))); break;
        case 'drain': g.push(drainOp(g, sh)); break;
        case 'mk': g.push(mkOp(g, sh)); break;
        case 'disp': g.push(dispOp(g, sh)); break;
        case 'rec': g.push(recOp(g, sh)); break;
        case 'read': g.push(readOp(g, sh)); break;
    }
    retail(g, sh);
}

/* ---- exec side --------------------------------------------------------------------------------------------- */

function unmodelled(x, msg) {
    x.unmodelled = new Error('exec: unmodelled scheduler op: ' + msg);
    throw x.unmodelled;
}

function bump(st, key) { if (st[key] < ST_CAP) st[key] = (st[key] + 1) | 0; }

/** exec.sc: the SCHEDULER lane's per-world state (exec reads onBody / pend / st.susp / close / size / ringT / x only). */
export class ScState {
    constructor(x, policy) {
        if (policy !== P_FIFO && policy !== P_LIFO && policy !== P_HOLD) throw new TypeError('ScState: policy must be 0 (FIFO), 1 (LIFO) or 2 (HOLD), got ' + String(policy));
        this.x = x;
        this.policy = policy;
        this.ringI = new Int32Array(RING);         // queued thunk -> its effect's node index
        this.ringT = new Array(RING).fill(null);   // the queued thunks
        this.ringH = new Uint8Array(RING);         // HOLD held bit (re-queued once)
        this.ringS = new Int32Array(RING);         // push sequence stamp (a HOLD re-queue keeps it)
        this.seq = 0;                              // the next push stamp
        this.head = 0;
        this.size = 0;
        this.pend = new Int32Array(MAX_NODES);     // node index -> thunks queued and not yet delivered
        this.succ = new Int32Array(MAX_NODES).fill(-1);   // srec successor (slot view, detectors only)
        this.cur = -1;                             // the node whose thunk is being delivered (-1 = none)
        this.dlv = 0;                              // 1 while a delivery runs its thunk (even after its body was judged)
        this.st = { susp: 0, thisDef: 0, calls: 0, deliv: 0, dead: 0, recyc: 0, retry: 0, judged: 0, maxQ: 0, outside: 0 };
    }

    /** Ring push (the scheduler fn). Fail closed: never drops a thunk. */
    push(i, run, self) {
        const x = this.x;
        if (x === null) throw new Error('lanes/scheduler: scheduler called after close()');
        if (typeof run !== 'function') unmodelled(x, 'scheduler of #' + i + ' got a ' + typeof run + ', not a thunk');
        if (this.size >= RING) unmodelled(x, 'ring full (' + RING + ' queued thunks) at a scheduler call of #' + i);
        if (this.seq >= ST_CAP) unmodelled(x, 'push sequence exhausted (' + ST_CAP + ' pushes) at a scheduler call of #' + i);
        const p = (this.head + this.size) & RING_MASK;
        this.ringI[p] = i;
        this.ringT[p] = run;
        this.ringH[p] = 0;
        this.ringS[p] = this.seq;
        this.seq = (this.seq + 1) | 0;
        this.size++;
        this.pend[i]++;
        const st = this.st;
        bump(st, 'calls');
        if (self !== undefined) bump(st, 'thisDef');
        if (this.size > st.maxQ) st.maxQ = this.size;
    }

    /** One scheduler fn for effect i (cold, made at screate). `this` is counted only (M3). */
    schedulerFor(i) {
        const sc = this;
        return function (run) { sc.push(i, run, this); };
    }

    /**
     * exec.runBody entry hook (O9 stale-thunk), depth-1 effect bodies only: outside any delivery a scheduled body is a
     * finding; inside one the first body is judged against the delivered node, later ones are silent. Never throws.
     */
    onBody(i, depth) {
        if (depth !== 1) return;
        const x = this.x;
        if (x === null) return;
        const nd = x.M.n[i];
        if (nd === undefined || nd.t !== 'e') return;   // a computed pulled by the effect pre-walk: not the judged body
        if (this.dlv === 0) {
            if (nd.sch === 1) {
                try {
                    x.did('O9');
                    bump(this.st, 'outside');
                    const f = checkScheduledBody('body outside delivery (' + POLICY[this.policy] + ')', i, false);
                    if (f !== null) x.failF(f);
                } catch (e) {
                    if (x.unmodelled === null) x.unmodelled = new Error('exec: unmodelled scheduler state: onBody: ' + String(e && e.message));
                }
            }
            return;
        }
        if (this.cur === -1) return;                    // a 2nd outermost body of the same delivery: silent
        const cur = this.cur;
        this.cur = -1;
        const cn = x.M.n[cur];
        try {
            x.did('O9');
            bump(this.st, 'judged');
            const f = checkStaleThunk(LABELS[this.policy], cur, i, !(cn !== undefined && cn.live));
            if (f !== null) x.failF(f);
        } catch (e) {
            if (x.unmodelled === null) x.unmodelled = new Error('exec: unmodelled scheduler state: onBody: ' + String(e && e.message));
        }
    }

    /** Pop one entry under the policy and deliver it (1), or re-queue a HOLD entry (0). */
    deliverOne() {
        const x = this.x;
        const pol = this.policy;
        const p = pol === P_LIFO ? (this.head + this.size - 1) & RING_MASK : this.head;
        const i = this.ringI[p];
        const t = this.ringT[p];
        const held = this.ringH[p];
        const sq = this.ringS[p];
        this.ringT[p] = null;
        this.ringH[p] = 0;
        this.size--;
        if (pol !== P_LIFO) this.head = (this.head + 1) & RING_MASK;
        if (pol === P_HOLD && held === 0) {
            const q = (this.head + this.size) & RING_MASK;
            this.ringI[q] = i;
            this.ringT[q] = t;
            this.ringH[q] = 1;
            this.ringS[q] = sq;
            this.size++;
            return 0;
        }
        this.pend[i]--;
        const M = x.M;
        const nd = M.n[i];
        const s = this.succ[i];
        const recycled = nd !== undefined && !nd.live && s >= 0 && M.n[s] !== undefined && M.n[s].live && this.pend[s] > 0;
        const st = this.st;
        bump(st, 'deliv');
        if (nd !== undefined && !nd.live) bump(st, 'dead');
        if (recycled) bump(st, 'recyc');
        if (held === 1) bump(st, 'retry');
        let older = 0;
        let younger = 0;
        for (let k = 0; k < this.size; k++) {
            if (this.ringS[(this.head + k) & RING_MASK] < sq) older++;
            else younger++;
        }
        x.D.onScDeliver(i, recycled, held === 1, older, younger);
        x.guard(() => {
            this.dlv = 1;
            this.cur = i;
            try { t(); } finally { this.cur = -1; this.dlv = 0; }
        });
        return 1;
    }

    /** Teardown: null every queued thunk, empty the ring, drop exec. Never throws. */
    close() {
        for (let j = 0; j < RING; j++) { this.ringT[j] = null; this.ringH[j] = 0; }
        this.head = 0;
        this.size = 0;
        this.cur = -1;
        this.dlv = 0;
        this.x = null;
    }
}

/** exec.sc, created on the lane's first op. */
function stateOf(x) {
    let sc = x.sc;
    if (sc === null) { sc = new ScState(x, policyOf(x.script.seed)); x.sc = sc; }
    return sc;
}

/** G-SC1 (fail closed): a kinds spec with no throw rule / writer, over earlier nodes that never throw and write nothing. */
function checkSpec(x, spec, ci) {
    if (spec === null || typeof spec !== 'object' || G_SC1_KINDS.indexOf(spec.k) === -1) unmodelled(x, 'effect #' + ci + ' spec is not a G-SC1 kinds spec');
    if (spec.thr === true || (spec.w !== undefined && spec.w !== null) || spec.try === true) unmodelled(x, 'effect #' + ci + ' spec throws or writes (G-SC1)');
    for (const r of specRefs(spec)) {
        const nd = Number.isInteger(r) && r >= 0 && r < ci ? x.M.n[r] : undefined;
        if (nd === undefined || nd.t === 'e') unmodelled(x, 'effect #' + ci + ' reads #' + String(r) + ', not an earlier signal / computed (G-SC1)');
        if (nd.t === 'c' && (nd.spec.thr === true || (nd.spec.w !== undefined && nd.spec.w !== null))) unmodelled(x, 'effect #' + ci + ' reads computed #' + r + ', which throws or writes (G-SC1)');
    }
}

/** An op argument, named without coercing it (-0 shown as '-0'). */
function showArg(v) {
    if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (typeof v === 'string') return JSON.stringify(v);
    return v === null ? 'null' : typeof v;
}

/** A node index op argument: an integer in [0, MAX_NODES), -0 rejected. */
function isIdx(i) { return Number.isInteger(i) && i >= 0 && i < MAX_NODES && !Object.is(i, -0); }

/** swrite / sdisp / srec target i: fail closed unless isIdx(i). */
function opIdx(x, o, i) {
    if (!isIdx(i)) unmodelled(x, o + ' i ' + showArg(i) + ' is not a node index in [0, ' + MAX_NODES + ')');
}

function freshIndex(x, ci) {
    if (!isIdx(ci)) unmodelled(x, 'node index ' + showArg(ci) + ' outside [0, ' + MAX_NODES + ')');
    if (x.M.n[ci] !== undefined) unmodelled(x, 'node index ' + ci + ' is not fresh');
}

/** Create effect ci (sch 1: scheduled through its own scheduler fn). Validation precedes every state write. */
function create(x, sc, ci, spec, sch) {
    x.M.addEffect(ci, spec, -1, sch);
    x.D.onCreate(ci, 'e');
    const eopts = sch === 1 ? { scheduler: sc.schedulerFor(ci) } : undefined;
    x.guard(() => { x.H[ci] = x.W.effect(() => { x.runBody(ci); }, eopts); });
}

function opCreate(x, op) {
    const sc = stateOf(x);
    const sch = op.sch;
    if ((sch !== 0 && sch !== 1) || Object.is(sch, -0)) unmodelled(x, 'screate sch ' + showArg(sch) + ' is not 0 / 1');
    freshIndex(x, op.ci);
    checkSpec(x, op.spec, op.ci);
    create(x, sc, op.ci, op.spec, sch);
}

function opDrain(x, op) {
    const sc = stateOf(x);
    const n = op.n;
    if (!(Number.isInteger(n) && n >= 0 && n <= 4) || Object.is(n, -0)) unmodelled(x, 'sdrain n ' + showArg(n) + ' is not 0..4');
    let delivered = 0;
    let pops = 0;
    while (sc.size > 0 && (n === 0 || delivered < n)) {
        if (pops >= DRAIN_BOUND) unmodelled(x, 'sdrain did not empty the ring within ' + DRAIN_BOUND + ' pops (' + sc.size + ' left)');
        pops++;
        delivered += sc.deliverOne();
        if (x.unmodelled !== null) throw x.unmodelled;
    }
    x.D.onScDrain(n, delivered);
}

function opWrite(x, op) {
    stateOf(x);
    const i = op.i;
    const v = op.v;
    opIdx(x, 'swrite', i);
    if (!(Number.isInteger(v) && v >= 1 && v <= 9)) unmodelled(x, 'swrite value ' + JSON.stringify(v) + ' is not 1..9');
    const nd = x.M.n[i];
    if (nd !== undefined && nd.t !== 's') unmodelled(x, 'swrite #' + i + ' is a ' + nd.t);
    if (nd === undefined || !nd.live || x.H[i] === undefined) return;   // a shrunk script
    x.D.onScWrite(i, !Object.is(nd.v, v));
    x.setTop(i, v, false);
}

function opDisp(x, op) {
    stateOf(x);
    const i = op.i;
    opIdx(x, 'sdisp', i);
    const nd = x.M.n[i];
    if (nd !== undefined && nd.t !== 'e') unmodelled(x, 'sdisp #' + i + ' is a ' + nd.t);
    if (nd === undefined || !nd.live || x.H[i] === undefined) return;   // shrunk away / dead
    x.guard(() => x.disposeIdx(i));
}

function opRec(x, op) {
    const sc = stateOf(x);
    const i = op.i;
    const ci = op.ci;
    opIdx(x, 'srec', i);
    freshIndex(x, ci);
    checkSpec(x, op.spec, ci);
    const nd = x.M.n[i];
    const kill = nd !== undefined && nd.live && x.H[i] !== undefined;   // absent / dead / no handle: only create ci
    if (nd !== undefined && nd.live && !(nd.t === 'e' && nd.sch === 1)) unmodelled(x, 'srec #' + i + ' is a ' + nd.t);
    if (kill) sc.succ[i] = ci;
    x.guard(() => x.W.batch(() => {
        x.batchDepth++;
        try {
            if (kill) x.guard(() => x.disposeIdx(i));
            create(x, sc, ci, op.spec, 1);
        } finally {
            x.batchDepth--;
        }
    }));
}

export const SCHEDULER = Object.freeze({
    name: 'SCHEDULER',
    index: 8,
    needsCaps: Object.freeze(['scheduler', 'stopEffect']),
    hardOracles: Object.freeze(['O1e', 'O4', 'O9']),
    required: Object.freeze(['thunk-after-dispose', 'thunk-recycled', 'pending-write', 'partial-drain', 'drain-all', 'hold-retry', 'fifo-delivery', 'lifo-delivery']),
    optional: Object.freeze([]),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: '3 base signals + 2 computeds + 3..7 effects (80% scheduled, own scheduler fn each); FIFO / LIFO / HOLD delivery per world; write / drain / dispose / srec (dispose + scheduled successor in one batch); every world ends with a drain-all' }),
    flushPasses: null,
    covOff: Object.freeze({ 'thunk-recycled': 'no-recycle' }),
    init,
    step,
    specRefs,
    ops: Object.freeze({ screate: opCreate, sdrain: opDrain, swrite: opWrite, sdisp: opDisp, srec: opRec }),
});
