/**
 * OWNER lane (S3 rung R3, .handoff/PLAN-R3-owner.md TASK 2 + ADDENDA A1-A4): OWNERSHIP -- live computeds and effects
 * adopting the nodes their bodies create, onCleanup FIFO, runWithOwner on live / dead / signal handles, createRoot
 * (detached). LANE_INDEX 7 (S3-D6). Rostered in R3 B3 (b126): lanes/index.mjs ROSTER;
 * contract.mjs ORACLE_CAPS OW and gates.mjs FAMILY OW.
 *
 * World: a sentinel signal S (top rank) read by an init effect E_S (the cleanup COUNT stays on O1e / O4 / O2: a cleanup
 * writes the ENGINE S directly, +1; the model holds S = model.fired), then owners. Every owner body is a kinds.mjs
 * 'outer' over its OWN trigger signal t (pre / post empty, so the value is t's): only the lane writes t, so every owner
 * run is caused by a lane op and the one-shot exec action of that run is always installed. spec.cl = the PERSISTENT
 * cleanups the body registers on every run (B1 row 4: a registration set fires once, so a body re-registers).
 *
 * Ops (lane-owned, exec.mjs laneOp). Every op that can stale a computed (oarm / orwo / oroot) runs inside ONE engine
 * batch (inBatch: exec.guard + W.batch + exec.batchDepth, so an effect re-run inside it still fails OB), then a second
 * batch-wrapped sweep; osent / odisp / opull stale none (odisp / opull run one batch, osent none):
 *   osent { i }             mark signal i the sentinel (model.setSentinel); the first lane op of every world
 *   oarm  { i, t, v, a }    one-shot action for owner i's next run, then t := decodeValue(v) (a change, so the run is
 *                           certain). a = { c: [{ k: 'e'|'c'|'s', ci, spec }], cl: 0..3, root: { k, ci, spec } | null,
 *                           grab: 0|1 }: the run registers spec.cl + a.cl cleanups, creates the c[] nodes (owned; a
 *                           signal is never adopted), a createRoot holding `root` (root-detached), and with grab 1
 *                           keeps getOwner()'s descriptor. A computed owner creates only computeds (and no root)
 *   orwo  { h, ci, k, spec, cl, g }  runWithOwner(h): cl cleanups + node ci (k / spec; ci -1 = none). h = a live owner
 *                           (adopts), a dead owner or a signal (rooted, never fires). g 1 = pass the getOwner()
 *                           descriptor a grab kept instead of the creation handle: B1 row 7 says the engine accepts
 *                           both identically, so g is kept ONLY to exercise the descriptor path (live owners only)
 *   oroot { ci, k, spec, cl }   createRoot: cl onCleanup calls inside the root fn (no owner: no-ops) + a rooted owner ci
 *   odisp { i }             batch(() => dispose owner i): D.onOwnKill, then exec.disposeIdx (model kill before the engine
 *                           dispose, both before the batch closes), then exec.owCheck()
 *   opull { i }             batch-wrapped top-level pull of computed owner i (O1c), then exec.owCheck()
 * Rule G-OW1: GRAPH pull / dispose never target an owner node -- this lane emits no GRAPH op at all.
 *
 * A4 inputs (b125 B2a review; evidence .handoff/b126-evidence/b2b/):
 *   (1) every owner re-eval is batch-wrapped, the at-rest O1c and the world-end pull included, WITHOUT an exec change:
 *       a computed owner re-evaluates only in a lane sweep (sweep(): every live computed, index order, so a child --
 *       always a higher index -- is pulled after its parent) inside the op's batches, and effect owners re-run in a
 *       batch close-flush. Every op that can stale a computed (oarm / orwo / oroot) ends with a batch-wrapped sweep
 *       (osent / odisp / opull stale none), so no computed is stale at rest: the exec
 *       O1c / end pulls read clean computeds and never fire a cleanup. A cleanup write is then deferred to the batch
 *       close (B1 row 6), never run mid-cascade, and one owCheck window holds a whole cascade (FIFO / ancestor order).
 *   (2) teardown is O5-only: close() disposes every handle without the model, so its fires are unjudgeable and a
 *       sentinel write would re-run E_S against a model that killed nothing (a false O2). The cleanups go silent once
 *       exec sets ow.closing before close() (PROPOSED patch, exec.mjs run() + header).
 *
 * exec state (exec.ow, an OwState): fires [{o, k}] and calls [{name, self}] (exec.owCheck judges and empties both),
 * sent (the sentinel index, -1 = none), sv (the engine sentinel value: fires so far), grab (owner -> descriptor),
 * closing, and the diagnostic counters st { fires, multi (a fire into a non-empty window), loose (a fire at an
 * unbatched top-level pull), teardown (fires after closing) }. Callbacks: each cleanup / createRoot fn / runWithOwner
 * fn is a `function` (never an arrow) logging its `this` (checkOwThis); owner bodies are NOT callback-this subjects
 * (B1 surprise 3: the controls run bodies with this = an internal record). A cleanup whose registration the model
 * calls a no-op (addCleanup -1: no owner, a dead owner, a root) logs nothing; it still writes S, so a fire the engine
 * should never make heads O1e / O4 / O2 on E_S. Fail closed (exec.unmodelled): a malformed action or a node index
 * that is not fresh. An op on a dead / absent node is a no-op (a shrunk script).
 *
 * Scenarios (scenarios.mjs onOwn*): own-cascade, own-rerun, own-computed, cleanup-fifo, run-with-owner,
 * run-with-dead-owner (required); root-detached, signal-not-adopted (optional). covOff cleanup-fifo -> rule
 * single-cleanup: no owner's registration set ever holds >= 2 cleanups (T-cov-OWNER).
 * COLD module: harness code, never an engine hot path.
 */

import { specRefs, decodeValue } from '../kinds.mjs';

const MIX = Object.freeze({ oarm: 46, orwo: 16, oroot: 12, odisp: 12, opull: 6 });
const CHILD = Object.freeze({ e: 45, c: 40, s: 15 });   // what an effect owner's run creates (a computed: 'c' only)
const CL = Object.freeze({ 0: 3, 1: 3, 2: 2, 3: 1 });   // cleanups per draw (spec.cl, a.cl, orwo cl)
const CL_MAX = Math.max(...Object.keys(CL).map(Number));   // 3: the largest count CL draws (checkCl's bound)
const TOP_RANK = 1000;  // the sentinel's rank: above every lane signal (rank 0)
const MIN_OWNERS = 3;   // below it a step adds a rooted owner
const MAX_OWNERS = 32;  // at or above it a run creates no node
const DEEP_P = 0.4;     // an arm / dispose prefers an owned owner (depth grows: own-cascade)
const GRAB_P = 0.25;    // an arm keeps the getOwner() descriptor
const ROOT_P = 0.1;     // an effect owner's run opens a createRoot (root-detached)
const DEAD_P = 0.2;     // an orwo targets a dead owner (run-with-dead-owner)
const SIG_P = 0.1;      // ... or a signal handle

/* ---- generator side (G0: the generator reads only its shadow model) ------------------------------------------ */

const SHADOW = new WeakMap();   // Gen -> { grab: Set of owners whose last arm kept a descriptor }

function shadowOf(g) {
    let s = SHADOW.get(g);
    if (s === undefined) { s = { grab: new Set() }; SHADOW.set(g, s); }
    return s;
}

function single(g) { return g.ruleOff('single-cleanup'); }

function owners(g) { return g.nodes((nd) => nd.t !== 's' && nd.role === 'owner'); }

function ownerSpec(t, cl) {
    return { k: 'outer', t, pre: [], ic: null, icU: false, post: [], role: 'owner', cl };
}

/** A cleanup count, capped at room (single-cleanup keeps every registration set <= 1). */
function clDraw(g, room) {
    const n = Number(g.weighted(CL));
    return n > room ? (room > 0 ? room : 0) : n;
}

/** A node an owner's run (or a root / runWithOwner fn) creates: its trigger op (pre) and its descriptor c. */
function child(g, k) {
    if (k === 's') return { pre: [], c: { k: 's', ci: g.reserve() } };
    const t = g.sig({ role: 'trig', v: 0 });
    const ci = g.reserve();
    return { pre: [t], c: { k, ci, spec: ownerSpec(t.i, clDraw(g, single(g) ? 1 : 3)) } };
}

/** Shadow of node c's creation under parent and of its first run's registrations (same op: a sweep pulls a computed). */
function shadowMake(g, c, parent) {
    const M = g.M;
    if (c.k === 's') { M.addSignal(c.ci, 0, { role: 'own' }); return; }
    if (c.k === 'c') M.addComputed(c.ci, c.spec, parent);
    else M.addEffect(c.ci, c.spec, parent);
    for (let j = 0; j < c.spec.cl; j++) M.addCleanup(c.ci);
}

function pickOwner(g, os, pred) {
    const pref = os.filter(pred);
    return pref.length > 0 && g.chance(DEEP_P) ? g.pick(pref) : g.pick(os);
}

function hasKids(g, i) {
    const ch = g.M.n[i].children;
    for (let k = 0; k < ch.length; k++) if (g.M.n[ch[k]].live) return true;
    return false;
}

/** A rooted top-level owner (createRoot), with 0..1 onCleanup calls in the root fn (no owner: no-ops). */
function rootOp(g) {
    const ch = child(g, g.chance(0.6) ? 'e' : 'c');
    const cl = g.int(2);
    shadowMake(g, ch.c, -1);
    ch.pre.push({ o: 'oroot', ci: ch.c.ci, k: ch.c.k, spec: ch.c.spec, cl });
    return { o: 'seq', ops: ch.pre };
}

function armOp(g) {
    const os = owners(g);
    if (os.length < MIN_OWNERS) return rootOp(g);
    const M = g.M;
    const i = pickOwner(g, os, (j) => M.n[j].parent >= 0);
    const nd = M.n[i];
    const comp = nd.t === 'c';
    const ops = [];
    const a = { c: [], cl: 0, root: null, grab: 0 };
    const n = os.length >= MAX_OWNERS ? 0 : g.int(3);
    for (let k = 0; k < n; k++) {
        const ch = child(g, comp ? 'c' : g.weighted(CHILD));
        for (const p of ch.pre) ops.push(p);
        a.c.push(ch.c);
    }
    if (!comp && os.length < MAX_OWNERS && g.chance(ROOT_P)) {
        const ch = child(g, g.chance(0.5) ? 'e' : 'c');
        for (const p of ch.pre) ops.push(p);
        a.root = ch.c;
    }
    if (g.chance(GRAB_P)) a.grab = 1;
    a.cl = clDraw(g, single(g) ? 1 - nd.spec.cl : 3);
    // the trigger MUST change (Object.is), or the owner does not run and the action stays unobserved
    const t = nd.spec.t;
    const tv = M.n[t].v;
    const v = (Number.isInteger(tv) && tv >= 0) ? (tv + 1) % 100000 : 0;
    M.setValue(t, decodeValue(v));
    // shadow of the run (A3): kill children -> own cleanups -> body (registrations, then the created nodes)
    M.rerunOwner(i);
    for (let j = 0; j < nd.spec.cl + a.cl; j++) M.addCleanup(i);
    for (const c of a.c) shadowMake(g, c, i);
    if (a.root !== null) shadowMake(g, a.root, -1);
    const sh = shadowOf(g);
    if (a.grab === 1) sh.grab.add(i); else sh.grab.delete(i);
    ops.push({ o: 'oarm', i, t, v, a });
    return ops.length === 1 ? ops[0] : { o: 'seq', ops };
}

function rwoOp(g) {
    const M = g.M;
    const os = owners(g);
    const x = g.r();
    let h = -1;
    if (x < SIG_P) {
        const ss = g.nodes((nd) => nd.t === 's' && nd.role === 'trig');
        if (ss.length > 0) h = g.pick(ss);
    } else if (x < SIG_P + DEAD_P) {
        const dead = [];
        for (let k = 0; k < M.n.length; k++) if (M.n[k] !== undefined && !M.n[k].live && M.n[k].t !== 's') dead.push(k);
        if (dead.length > 0) h = g.pick(dead);
    }
    if (h < 0) {
        if (os.length === 0) return rootOp(g);
        h = g.pick(os);
    }
    const lo = M.liveOwner(h);
    const cl = clDraw(g, single(g) && lo >= 0 ? 1 - M.n[lo].cl : 3);
    const ops = [];
    let c = null;
    if (os.length < MAX_OWNERS && (cl === 0 || g.chance(0.7))) {
        const ch = child(g, lo >= 0 && M.n[lo].t === 'c' ? 'c' : (g.chance(0.55) ? 'e' : 'c'));
        for (const p of ch.pre) ops.push(p);
        c = ch.c;
    }
    const gf = lo >= 0 && shadowOf(g).grab.has(h) && g.chance(0.5) ? 1 : 0;
    if (lo >= 0) for (let j = 0; j < cl; j++) M.addCleanup(lo);
    if (c !== null) shadowMake(g, c, lo);
    ops.push({ o: 'orwo', h, ci: c === null ? -1 : c.ci, k: c === null ? 'e' : c.k, spec: c === null ? null : c.spec, cl, g: gf });
    return ops.length === 1 ? ops[0] : { o: 'seq', ops };
}

function dispOp(g) {
    const os = owners(g);
    if (os.length <= MIN_OWNERS) return rootOp(g);
    const i = pickOwner(g, os, (j) => hasKids(g, j));
    g.M.kill(i);
    return { o: 'odisp', i };
}

function pullOp(g) {
    const cs = g.nodes((nd) => nd.t === 'c' && nd.role === 'owner');
    if (cs.length === 0) return armOp(g);
    return { o: 'opull', i: g.pick(cs) };
}

function init(g) {
    const s = g.sig({ v: 0, role: 'sent', rank: TOP_RANK });
    g.push(s, true);
    g.push({ o: 'osent', i: s.i }, true);
    g.push(g.eff({ k: 'sum', d: [s.i], role: 'sent' }), true);
    for (let k = 0; k < 4; k++) g.push(rootOp(g), true);
}

function step(g) {
    switch (g.weighted(MIX)) {
        case 'oarm': g.push(armOp(g)); return;
        case 'orwo': g.push(rwoOp(g)); return;
        case 'oroot': g.push(owners(g).length >= MAX_OWNERS ? dispOp(g) : rootOp(g)); return;
        case 'odisp': g.push(dispOp(g)); return;
        case 'opull': g.push(pullOp(g)); return;
    }
}

/* ---- exec side --------------------------------------------------------------------------------------------- */

/** exec.ow: the OWNER lane's per-world state (exec.mjs owCheck reads fires / calls). */
export class OwState {
    constructor() {
        this.fires = [];
        this.calls = [];
        this.sent = -1;
        this.sv = 0;
        this.grab = new Map();
        this.closing = false;
        this.st = { fires: 0, multi: 0, loose: 0, teardown: 0 };
    }
}

function unmodelled(x, msg) {
    x.unmodelled = new Error('exec: unmodelled owner op: ' + msg);
    throw x.unmodelled;
}

function stateOf(x) {
    let ow = x.ow;
    if (ow === null) { ow = new OwState(); x.ow = ow; }
    return ow;
}

/** One guarded engine batch; exec.batchDepth is raised so an effect re-run inside it still fails OB. */
function inBatch(x, fn) {
    x.guard(() => x.W.batch(() => {
        x.batchDepth++;
        try { fn(); } finally { x.batchDepth--; }
    }));
}

/** Pull every live computed in index order (a child, a higher index, after its parent). Call inside inBatch only. */
function sweep(x) {
    const M = x.M;
    for (let j = 0; j < M.n.length; j++) {
        const nd = M.n[j];
        if (nd !== undefined && nd.live && nd.t === 'c' && x.H[j] !== undefined) x.readCheck(j, false);
    }
}

/** The ENGINE sentinel write of one fire (+1); the model's S is model.fired. Silent at teardown. */
function bump(x, ow) {
    if (ow.closing === true || ow.sent < 0) return;
    ow.sv = (ow.sv + 1) | 0;
    x.W.set(x.H[ow.sent], ow.sv);
}

/** onCleanup with owner o (lockstep with model.addCleanup). k -1: the model says the engine call is a no-op. */
function addCl(x, ow, o) {
    const k = x.M.addCleanup(o);
    if (k === -1) {
        x.W.onCleanup(function () { bump(x, ow); });
        return;
    }
    x.W.onCleanup(function () {
        if (ow.closing === true) { ow.st.teardown++; return; }
        ow.st.fires++;
        if (ow.fires.length > 0) ow.st.multi++;
        if (x.batchDepth === 0 && x.topRead !== -1) ow.st.loose++;
        ow.fires.push({ o, k });
        ow.calls.push({ name: 'cleanup #' + o + ' k=' + k, self: this });
        bump(x, ow);
    });
}

function checkNode(x, c) {
    if (c === null || typeof c !== 'object' || !Number.isInteger(c.ci) || c.ci < 0 || x.M.n[c.ci] !== undefined) {
        unmodelled(x, 'node ' + JSON.stringify(c) + ' is not a fresh index');
    }
    if (c.k === 's') return;
    if ((c.k !== 'e' && c.k !== 'c') || c.spec === null || typeof c.spec !== 'object' || c.spec.k !== 'outer') {
        unmodelled(x, 'node #' + c.ci + ' has no owner spec');
    }
    checkCl(x, c.spec.cl, 'node #' + c.ci + ' spec');
}

/** Fail closed on a malformed cleanup count: an integer in [0, CL_MAX] (never coerced: `cl | 0` would run 0 cleanups
 *  for 'x' / 1.5 / NaN; an unbounded 2**31 would run the addCl loop out of memory). */
function checkCl(x, cl, what) {
    if (!Number.isInteger(cl) || cl < 0 || !(cl <= CL_MAX)) unmodelled(x, what + ' cl ' + String(cl) + ' is not a cleanup count');
}

/** Create node c under parent (the running owner, a runWithOwner owner, or -1 rooted); its first run gets the action. */
function mk(x, c, parent) {
    checkNode(x, c);
    const M = x.M;
    const i = c.ci;
    x.D.onOwnCreate(c.k, parent);
    if (c.k === 's') { x.createSignal({ o: 'sig', i, v: 0, role: 'own' }); return; }
    x.actions.set(i, () => bodyAction(x, i, null));
    if (c.k === 'c') {
        M.addComputed(i, c.spec, parent);
        x.D.onCreate(i, 'c');
        x.H[i] = x.W.computed(() => x.runBody(i));
    } else {
        M.addEffect(i, c.spec, parent);
        x.D.onCreate(i, 'e');
        x.H[i] = x.W.effect(() => { x.runBody(i); });
    }
}

/** createRoot(fn): cl onCleanup calls (no owner inside a root: no-ops) and node c, rooted. Returns `did`. */
function root(x, ow, c, cl) {
    let did = 0;
    x.W.createRoot(function () {
        ow.calls.push({ name: 'createRoot', self: this });
        for (let j = 0; j < cl; j++) { addCl(x, ow, -1); did++; }
        if (c !== null) { mk(x, c, -1); did++; }
    });
    x.D.onOwnRoot(did);
    return did;
}

/** Owner i's body action (the exec one-shot): spec.cl + a.cl cleanups, then the created nodes, the root, the grab. */
function bodyAction(x, i, a) {
    const ow = x.ow;
    const n = x.M.n[i].spec.cl + (a === null ? 0 : a.cl);   // checked at creation (checkNode) / arm (checkAction)
    for (let j = 0; j < n; j++) addCl(x, ow, i);
    if (a === null) return;
    if (a.grab === 1) ow.grab.set(i, x.W.getOwner());
    for (let j = 0; j < a.c.length; j++) mk(x, a.c[j], i);
    if (a.root !== null) root(x, ow, a.root, 0);
}

function checkAction(x, a) {
    if (a === null || typeof a !== 'object' || !Array.isArray(a.c) || !Number.isInteger(a.cl) || a.cl < 0 ||
        (a.root !== null && (typeof a.root !== 'object' || a.root.k === 's')) || (a.grab !== 0 && a.grab !== 1)) {
        unmodelled(x, 'oarm action ' + JSON.stringify(a) + ' is malformed');
    }
}

/** An osent shrunk away leaves ow.sent -1: bump() is silent, so that world loses its cleanup-count oracle (only
 *  test/87 row 2's >= 1 failing world guards the count). */
function opSent(x, op) {
    const ow = stateOf(x);
    const nd = x.M.n[op.i];
    if (nd === undefined || nd.t !== 's' || !nd.live || x.H[op.i] === undefined) return;   // shrunk away
    x.M.setSentinel(op.i);
    ow.sent = op.i;
    ow.sv = x.M.fired;
}

function opArm(x, op) {
    stateOf(x);
    checkAction(x, op.a);
    const M = x.M;
    const nd = M.n[op.i];
    const armed = nd !== undefined && nd.live && nd.t !== 's' && x.H[op.i] !== undefined;
    inBatch(x, () => {
        if (armed) x.actions.set(op.i, () => bodyAction(x, op.i, op.a));
        const tn = M.n[op.t];
        if (tn !== undefined && tn.t === 's' && tn.live && x.H[op.t] !== undefined) {
            const v = decodeValue(op.v);
            const old = tn.v;
            M.setValue(op.t, v);
            x.D.onWrite(op.t, old, v, !Object.is(old, v), false);
            x.W.set(x.H[op.t], v);
        }
        sweep(x);
    });
    inBatch(x, () => sweep(x));   // computeds an effect owner created in the first batch's close-flush
}

function opRwo(x, op) {
    const ow = stateOf(x);
    checkCl(x, op.cl, 'orwo');
    const h = op.h;
    if (!Number.isInteger(h) || h < 0 || x.H[h] === undefined) return;   // shrunk away
    const lo = x.M.liveOwner(h);
    const handle = op.g === 1 && lo >= 0 && ow.grab.has(h) ? ow.grab.get(h) : x.H[h];
    const c = op.ci >= 0 ? { k: op.k, ci: op.ci, spec: op.spec } : null;
    const cl = op.cl;
    inBatch(x, () => {
        let did = 0;
        x.W.runWithOwner(handle, function () {
            ow.calls.push({ name: 'runWithOwner #' + h, self: this });
            for (let j = 0; j < cl; j++) { addCl(x, ow, lo); did++; }
            if (c !== null) { mk(x, c, lo); did++; }
        });
        x.D.onOwnRunWithOwner(h, did);
        sweep(x);
    });
    inBatch(x, () => sweep(x));
}

function opRoot(x, op) {
    const ow = stateOf(x);
    checkCl(x, op.cl, 'oroot');
    const c = op.ci >= 0 ? { k: op.k, ci: op.ci, spec: op.spec } : null;
    inBatch(x, () => { root(x, ow, c, op.cl); sweep(x); });
    inBatch(x, () => sweep(x));
}

function opDisp(x, op) {
    stateOf(x);
    const nd = x.M.n[op.i];
    if (nd === undefined || !nd.live || nd.t === 's' || x.H[op.i] === undefined) return;   // shrunk away / dead
    inBatch(x, () => { x.D.onOwnKill(op.i, false); x.disposeIdx(op.i); });
    x.owCheck();
}

function opPull(x, op) {
    stateOf(x);
    const nd = x.M.n[op.i];
    if (nd === undefined || !nd.live || nd.t !== 'c' || x.H[op.i] === undefined) return;
    inBatch(x, () => { x.readCheck(op.i, false); });
    x.owCheck();
}

export const OWNER = Object.freeze({
    name: 'OWNER',
    index: 7,
    needsCaps: Object.freeze(['owner', 'childEffects', 'batch']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'OW']),
    required: Object.freeze(['own-cascade', 'own-rerun', 'own-computed', 'cleanup-fifo', 'run-with-owner', 'run-with-dead-owner']),
    optional: Object.freeze(['root-detached', 'signal-not-adopted']),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: 'sentinel S + E_S + 4 rooted owners at init; every step one batch-wrapped arm / runWithOwner / createRoot / dispose / pull' }),
    flushPasses: null,
    covOff: Object.freeze({ 'cleanup-fifo': 'single-cleanup' }),
    init,
    step,
    specRefs,
    ops: Object.freeze({ osent: opSent, oarm: opArm, orwo: opRwo, oroot: opRoot, odisp: opDisp, opull: opPull }),
});
