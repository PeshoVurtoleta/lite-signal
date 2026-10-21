/**
 * HOOK lane (S3 rung R1, PLAN-0s-s3-r1.md TASK 6): graph-mutation LISTENERS (registry.onGraphMutation, through the
 * S3 decorator's world.hook(fn), adapters/lite-s3.mjs) stacked over a GRAPH-vocabulary world, with non-LIFO offs.
 *
 * Listener stack: L0 is subscribed by init op 0 BEFORE any node exists and is PERMANENT (H2: no hoff ever targets
 * it); 2..5 listeners are live at every step after init (L0 alone during GRAPH.init) (L0 + 1..4 more). hsub { l } subscribes listener l (the next index);
 * hoff { l } retires live listener l -- any live non-L0 index, so most offs are NON-LIFO (a live listener sits
 * above the one retired; cov-off:hook-non-lifo-off keeps every off LIFO). H1: a subscribe always passes a function
 * (never null). Every listener feeds ONE world mirror (mirror.mjs) and checks each delivery with O8
 * checkHookFire (the receiver must be the TOP LIVE listener; TASK 0 b93: headpatched delivers there after any off
 * order, tree and rev152 hand events to an off'd listener = DIV-F9 ghost-listener). exec.mjs atRest runs O8
 * checkMirror (mirror vs stats()) after every op while exec.hk !== null.
 *
 * exec state (exec.hk, a HookState): stack [{ live, offStep, off }] (index = listener id; a gap left by a shrunk
 * script is a never-live entry), mirror, step (the op step being executed: set at the first hsub, advanced by
 * exec.mjs hookAtRest), fires (deliveries, capped). Fail closed (exec.unmodelled): the first hsub after a node
 * exists (the mirror could not see it), an hsub whose l is not a fresh integer index, an hoff of L0 (H2) or of a
 * non-integer l. An hoff of a listener that is not live (shrunk away) is a no-op, like a dead target.
 *
 * Scenarios (scenarios.mjs Detectors, TRUE conditions): hook-multi (a delivery with >= 3 listeners live),
 * hook-non-lifo-off (an hoff with a live listener above its target), hook-mirror-dispose (an op-2 delivery for a
 * node the mirror still holds SOURCE edges for: rule I3's silent subscriber free), hook-recompute (an op-5
 * delivery). COLD module: harness code, never an engine hot path.
 */

import { GRAPH } from './graph.mjs';
import { specRefs } from '../kinds.mjs';
import { Mirror } from '../mirror.mjs';
import { checkHookFire } from '../oracles.mjs';

const MIX = Object.freeze({ graph: 88, hsub: 6, hoff: 6 });   // graph: one GRAPH-vocabulary step (lanes/graph.mjs MIX)
const LIVE_MIN = 2;   // live listeners, L0 included
const LIVE_MAX = 5;
const FIRE_CAP = 0x3FFFFFFF;   // per-world counter stays Smi

/* ---- generator side (shadow listener stack per Gen; G0: the generator never sees an engine) ----------------- */

const SHADOW = new WeakMap();   // Gen -> { next, live: [non-L0 live ids, ascending] }

function hsub(st) {
    const l = st.next++;
    if (l > 0) st.live.push(l);
    return { o: 'hsub', l };
}

function hoff(g, st) {
    const top = st.live.length - 1;
    const at = g.ruleOff('non-lifo-off') ? top : g.int(st.live.length);
    const l = st.live[at];
    st.live.splice(at, 1);
    return { o: 'hoff', l };
}

function init(g) {
    const st = { next: 0, live: [] };
    SHADOW.set(g, st);
    g.push(hsub(st), true);   // op 0: L0, before any node
    GRAPH.init(g);
    const k = LIVE_MIN + g.int(LIVE_MAX - LIVE_MIN + 1);
    while (1 + st.live.length < k) g.push(hsub(st), true);
}

function step(g) {
    const st = SHADOW.get(g);
    const what = g.weighted(MIX);
    const live = 1 + st.live.length;
    if (what === 'hsub' || (what === 'hoff' && live <= LIVE_MIN)) {
        if (live < LIVE_MAX) { g.push(hsub(st)); return; }
        g.push(hoff(g, st));
        return;
    }
    if (what === 'hoff') { g.push(hoff(g, st)); return; }
    GRAPH.step(g);
}

/* ---- exec side (lane-owned ops, exec.mjs laneOp) ------------------------------------------------------------ */

export class HookState {
    constructor(step) {
        this.stack = [];
        this.mirror = new Mirror();
        this.step = step;
        this.fires = 0;
    }
}

function unmodelled(x, msg) {
    x.unmodelled = new Error('exec: unmodelled hook op: ' + msg);
    throw x.unmodelled;
}

/** One delivery to listener l: O8 receiver check, the scenario detectors, then the mirror. */
function onFire(x, hk, l, op, a, b) {
    if (hk.fires < FIRE_CAP) hk.fires++;
    const f = checkHookFire(hk.stack, l, op, hk.step);
    if (f !== null) x.failF(f);
    x.D.onHookFire(hk, op, a);
    hk.mirror.apply(op, a, b);
}

function opHsub(x, op, k) {
    let hk = x.hk;
    if (hk === null) {
        if (x.M.n.length > 0) unmodelled(x, 'the first hsub runs at step ' + k + ' after ' + x.M.n.length + ' node(s) exist (the mirror cannot see them)');
        hk = new HookState(k);
        x.hk = hk;
    }
    const l = op.l;
    if (!(Number.isInteger(l) && l >= hk.stack.length)) unmodelled(x, 'hsub L' + String(l) + ' is not a fresh listener index (next ' + hk.stack.length + ')');
    while (hk.stack.length < l) hk.stack.push({ live: false, offStep: null, off: null });
    const e = { live: false, offStep: null, off: null };
    hk.stack.push(e);
    const fn = (hop, a, b) => onFire(x, hk, l, hop, a, b);   // H1: always a function
    x.guard(() => { e.off = x.W.hook(fn); });
    e.live = typeof e.off === 'function';
}

function opHoff(x, op, k) {
    const l = op.l;
    if (!Number.isInteger(l) || l < 0) unmodelled(x, 'hoff L' + String(l) + ' is not a listener index');
    if (l === 0) unmodelled(x, 'hoff L0 at step ' + k + ' (H2: L0 is permanent)');
    const hk = x.hk;
    if (hk === null || l >= hk.stack.length || !hk.stack[l].live) return;   // shrunk away: a no-op
    const e = hk.stack[l];
    let above = false;
    for (let j = l + 1; j < hk.stack.length; j++) if (hk.stack[j].live) { above = true; break; }
    x.D.onHookOff(above);
    e.live = false;
    e.offStep = k;
    x.guard(() => e.off());
}

export const HOOK = Object.freeze({
    name: 'HOOK',
    index: 6,
    needsCaps: Object.freeze(['hook']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O8']),
    required: Object.freeze(['hook-multi', 'hook-non-lifo-off', 'hook-mirror-dispose', 'hook-recompute']),
    optional: Object.freeze([]),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: 'GRAPH normal world (lanes/graph.mjs) + permanent L0 at op 0 + 2-5 live listeners; 12% of steps hsub / hoff' }),
    flushPasses: null,
    covOff: Object.freeze({ 'hook-non-lifo-off': 'non-lifo-off' }),
    init,
    step,
    specRefs,
    ops: Object.freeze({ hsub: opHsub, hoff: opHoff }),
});
