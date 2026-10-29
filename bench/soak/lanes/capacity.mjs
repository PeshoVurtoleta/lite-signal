/**
 * CAPACITY lane (S3 rung R5, .handoff/PLAN-R5-registry-capacity.md PLAN BODY 2 TASKS 1-4 + RULED): the registry
 * capacity edge -- the node cap and the link cap under onCapacityExceeded 'throw', the 16x link ceiling under 'grow',
 * growth past the initial pool under 'grow', and reuse at the edge (free one, create succeeds, the next create throws
 * again). LANE_INDEX 12 (S3-D6). Not rostered until R5 B2 (lanes/index.mjs ROSTER / BY_NAME); until then a caller
 * wires it through runWorld's opts.laneOps (test/93, the B1b census harness).
 *
 * World (gen.mjs G12): init seeds Gen.capacity = { maxNodes 32 | 64, maxLinks 1x | 2x maxNodes, onCapacityExceeded
 * 'throw' | 'grow' } (each 50/50); the script carries it as `capacity` and exec.mjs passes it to adapter.open() (the
 * lite-s3 decorator merges it over the base cfg and checks the stats() echo). The core graph is GRAPH vocabulary over
 * small values (3..4 leaf signals, 2..3 computeds, 2 effects, sum / identity bodies, values 1..9; core set / read /
 * create / stop ops, gen.mjs emitters + exec.mjs core handlers) kept within the G12 budget: <= maxNodes/2 - 2 live core
 * nodes and <= maxLinks/2 core links (static bound: the sum of |deps| over live computeds and effects).
 *
 * Op (lane-owned, exec.mjs laneOp), TOP LEVEL only, no effect is created by it:
 *   cedge { k: 'node' | 'link' | 'ceil', reuse: 0 | 1 }
 * The prediction comes from exec's model (live node count, model.expectedLinks) plus the open-time echo W.capacity(),
 * never from the script (the script's cfg is only checked against the echo). The op creates PRIVATE nodes (never in
 * the model) and releases every one of them in the same op, so O5 at rest sees the core graph only.
 *   node, throw  fill F = maxNodes - live private signals (each guarded, EXPECT_NONE), then one more create, guarded
 *                against [CapacityError 'CapacityError: nodes capacity (<maxNodes>) exceeded.'] (O6 (v) list through
 *                exec.regExpect). reuse 1: dispose one private, create one (EXPECT_NONE), create one more (the same
 *                expected throw).
 *   link, throw  R = maxLinks - E free links. S = ceil(sqrt(R)) private signals, then computeds reading the first
 *                min(S, left) of them, each pulled (W.read, EXPECT_NONE) until exactly R links are live; then an OVER
 *                computed reading one signal is pulled against [CapacityError 'links capacity (<maxLinks>)']. 0 partial
 *                links (the throw is the over computed's first link). reuse 1: dispose the over computed and the last
 *                fill computed, re-create that one (pull, EXPECT_NONE), pull a second over computed (the same expected
 *                throw).
 *   ceil, grow   as link, with R = 16 x maxLinks - E and the message 'links capacity (<16 x maxLinks>)' (A_CAP_CEIL).
 *   node, grow   F = maxNodes - live + 1 private signals, all EXPECT_NONE; grow-past-initial counts only when
 *                stats().nodePoolCapacity >= 2 x maxNodes afterwards (TASK 0 b: the 33rd node of a 32 pool takes
 *                the capacity to 512, so never a literal 64).
 *   link, grow   R = maxLinks - E + 1 links (past the initial pool, below the ceiling), all EXPECT_NONE.
 * Every private is released (computeds newest-first, then signals), each dispose guarded (EXPECT_NONE). A fill
 * create / pull that escapes stops the fill (its O6 finding stands; the world stops at this op).
 * Oracle: O6 checkEscape only (no new sig): a missing throw -> expected-escape-missing; a wrong ctor / message ->
 * escape-<Ctor> + expected-escape-missing; a throw below the cap -> escape-CapacityError; a slot or link not returned
 * -> O5 node-count / link-count at rest (and teardown-residue).
 * Detectors: D.onCapEdge(kind, policy, threw, reused) (scenarios.mjs): node-cap-throw, link-cap-throw,
 * link-ceiling-grow, grow-past-initial, reuse-at-edge.
 * covOff link-ceiling-grow -> rule no-ceiling: no ceil op is generated.
 * Per-exec state in a WeakMap (exec needs no slot; the entry dies with the world): the echo, checked once.
 * Fail closed (exec.unmodelled): a world with no W.capacity(), a script without capacity, an echo that differs from
 * the script cfg, an unknown k, a reuse outside 0 / 1, reuse on a no-throw op, ceil under 'throw', a fill that would
 * hit the node cap under 'throw' (or reaches no free slot / link).
 * COLD module: harness code, never an engine hot path.
 */

import { specRefs } from '../kinds.mjs';

const MIX = Object.freeze({ set: 36, read: 14, mk: 10, stop: 6, cedge: 10 });
const K_THROW = Object.freeze({ node: 1, link: 1 });
const K_GROW = Object.freeze({ node: 1, link: 1, ceil: 1 });
const K_GROW_NOCEIL = Object.freeze({ node: 1, link: 1 });
const CEIL_X = 16;   // Signal.js A_CAP_CEIL: maxLinkLimit = currentLinkCapacity * 16 (the initial maxLinks)

/* ---- generator side (G0: the generator reads only its shadow model) ------------------------------------------ */

function val(g) { return 1 + g.int(9); }

function other(g, i) { return ((g.M.n[i].v + g.int(8)) % 9) + 1; }   // 1..9, never the current value

function pool(g) { return g.nodes((nd) => (nd.t === 's' && nd.role === 'leaf') || nd.t === 'c'); }

function body(g, role) {
    const d = g.some(pool(g), g.chance(0.4) ? 1 : 2);
    return { k: d.length === 1 ? 'identity' : 'sum', d, role };
}

/** G12: the core budget after adding one node with `deps` links (static bound) still fits. */
function fits(g, deps) {
    const cap = g.capacity;
    let live = 0;
    let links = 0;
    const n = g.M.n;
    for (let k = 0; k < n.length; k++) {
        const nd = n[k];
        if (nd === undefined || !nd.live) continue;
        live++;
        if (nd.t !== 's' && nd.spec !== null) links += specRefs(nd.spec).length;
    }
    return live + 1 <= (cap.maxNodes >> 1) - 2 && links + deps <= (cap.maxLinks >> 1);
}

function init(g) {
    const maxNodes = g.chance(0.5) ? 32 : 64;
    const maxLinks = maxNodes * (g.chance(0.5) ? 1 : 2);
    g.capacity = { maxNodes, maxLinks, onCapacityExceeded: g.chance(0.5) ? 'throw' : 'grow' };
    const L = 3 + g.int(2);
    for (let k = 0; k < L; k++) g.push(g.sig({ v: val(g), role: 'leaf' }), true);
    const C = 2 + g.int(2);
    for (let k = 0; k < C; k++) {
        const b = body(g, 'comp');
        if (fits(g, b.d.length)) g.push(g.comp(b, g.chance(0.5)), true);
    }
    for (let k = 0; k < 2; k++) {
        const b = body(g, 'eff');
        if (fits(g, b.d.length)) g.push(g.eff(b), true);
    }
}

function setOp(g) {
    const i = g.pick(g.leaves());
    return g.set(i, other(g, i));
}

function edgeOp(g) {
    const grow = g.capacity.onCapacityExceeded === 'grow';
    const k = g.weighted(!grow ? K_THROW : g.ruleOff('no-ceiling') ? K_GROW_NOCEIL : K_GROW);
    const throws = !grow || k === 'ceil';
    return { o: 'cedge', k, reuse: throws && g.chance(0.5) ? 1 : 0 };
}

function step(g) {
    switch (g.weighted(MIX)) {
        case 'set': g.push(setOp(g)); return;
        case 'read': {
            const cs = g.nodes((nd) => nd.t === 'c');
            g.push(cs.length > 0 ? { o: 'read', is: cs } : setOp(g));
            return;
        }
        case 'mk': {
            const b = body(g, g.chance(0.5) ? 'comp' : 'eff');
            if (!fits(g, b.d.length)) { g.push(setOp(g)); return; }
            g.push(b.role === 'comp' ? g.comp(b, g.chance(0.5)) : g.eff(b));
            return;
        }
        case 'stop': {
            const es = g.nodes((nd) => nd.t === 'e');
            g.push(es.length > 1 ? g.stop(g.pick(es)) : setOp(g));
            return;
        }
        case 'cedge': g.push(edgeOp(g)); return;
    }
}

/* ---- exec side --------------------------------------------------------------------------------------------- */

const STATE = new WeakMap();   // exec -> { echo }

function unmodelled(x, msg) {
    x.unmodelled = new Error('exec: unmodelled capacity op: ' + msg);
    throw x.unmodelled;
}

/** The world's verified echo (once per world): W.capacity() must equal the script's cfg. */
function echoOf(x) {
    let s = STATE.get(x);
    if (s !== undefined) return s.echo;
    const cap = x.script.capacity;
    if (cap === undefined || cap === null || typeof cap !== 'object') unmodelled(x, 'the script carries no capacity cfg (G12)');
    if (typeof x.W.capacity !== 'function') unmodelled(x, 'the world has no capacity() echo (adapters/lite-s3.mjs)');
    const e = x.W.capacity();
    if (e === null || typeof e !== 'object' || e.maxNodes !== cap.maxNodes || e.maxLinks !== cap.maxLinks || e.onCapacityExceeded !== cap.onCapacityExceeded) {
        unmodelled(x, 'echo ' + JSON.stringify(e) + ' differs from the script cfg ' + JSON.stringify(cap));
    }
    if (!(Number.isInteger(e.maxNodes) && e.maxNodes > 0 && Number.isInteger(e.maxLinks) && e.maxLinks > 0) ||
        (e.onCapacityExceeded !== 'throw' && e.onCapacityExceeded !== 'grow')) unmodelled(x, 'echo ' + JSON.stringify(e) + ' is not a positive-int cfg with policy throw / grow');
    s = { echo: e };
    STATE.set(x, s);
    return e;
}

function capExpect(kind, n) {
    return Object.freeze([Object.freeze({ id: 'CapacityError', ctor: 'CapacityError', prefix: 'CapacityError: ' + kind + ' capacity (' + n + ') exceeded.' })]);
}

function liveNodes(x) {
    const c = x.M.counts();
    return c.signals + c.computeds + c.effects;
}

/** One guarded private create / pull, EXPECT_NONE (or `expect` through exec.regExpect). Returns { ok, threw, h }. */
function tryCall(x, fn, expect) {
    const r = { ok: false, threw: false, h: undefined };
    if (expect !== null) x.regExpect = expect;
    x.guard(() => {
        try { r.h = fn(); } catch (e) { r.threw = true; throw e; }
        r.ok = true;
    });
    x.regExpect = null;
    return r;
}

function mkComputed(W, sigs, d) {
    return W.computed(() => { let t = 0; for (let k = 0; k < d; k++) t += W.read(sigs[k]); return t; });
}

/** Release every private: computeds newest-first, then signals, each guarded (EXPECT_NONE). */
function release(x, comps, sigs) {
    const W = x.W;
    for (let k = comps.length - 1; k >= 0; k--) { const h = comps[k]; if (h !== null) x.guard(() => W.dispose(h)); }
    for (let k = sigs.length - 1; k >= 0; k--) { const h = sigs[k]; x.guard(() => W.dispose(h)); }
    comps.length = 0;
    sigs.length = 0;
}

function edgeNode(x, e, reuse) {
    const W = x.W;
    const grow = e.onCapacityExceeded === 'grow';
    const F = e.maxNodes - liveNodes(x) + (grow ? 1 : 0);
    if (F < 1) unmodelled(x, 'node fill of ' + F + ' (live core nodes reach maxNodes ' + e.maxNodes + ')');
    const sigs = [];
    let filled = true;
    for (let k = 0; k < F; k++) {
        const r = tryCall(x, () => W.signal(1), null);
        if (!r.ok) { filled = false; break; }
        sigs.push(r.h);
    }
    let threw = false;
    let reused = false;
    if (filled && !grow) {
        const ex = capExpect('nodes', e.maxNodes);
        const p = tryCall(x, () => W.signal(1), ex);
        if (p.ok) sigs.push(p.h);
        threw = p.threw;
        if (threw && reuse === 1) {
            const h = sigs.pop();
            x.guard(() => W.dispose(h));
            const a = tryCall(x, () => W.signal(1), null);
            if (a.ok) {
                sigs.push(a.h);
                const b = tryCall(x, () => W.signal(1), ex);
                if (b.ok) sigs.push(b.h);
                reused = b.threw;
            }
        }
    }
    let grew = false;
    if (filled && grow) {
        let s = null;
        try { s = W.stats(); } catch (err) { x.engineError(err, 'stats()'); }
        grew = s !== null && s.nodePoolCapacity >= 2 * e.maxNodes;
    }
    release(x, [], sigs);
    if (filled && (!grow || grew)) x.D.onCapEdge('node', e.onCapacityExceeded, threw, reused);
}

function edgeLink(x, e, k, reuse) {
    const W = x.W;
    const grow = e.onCapacityExceeded === 'grow';
    const E = x.M.expectedLinks(new Map());
    const cap = k === 'ceil' ? CEIL_X * e.maxLinks : e.maxLinks;
    const R = cap - E + (k === 'link' && grow ? 1 : 0);
    if (R < 1) unmodelled(x, 'link fill of ' + R + ' (expected links ' + E + ', cap ' + cap + ')');
    const S = Math.ceil(Math.sqrt(R));
    const C = Math.ceil(R / S);
    if (!grow && liveNodes(x) + S + C + 1 > e.maxNodes) {
        unmodelled(x, 'link fill needs ' + (S + C + 1) + ' private nodes over ' + liveNodes(x) + ' live (maxNodes ' + e.maxNodes + ')');
    }
    const sigs = [];
    const comps = [];
    const ds = [];
    let filled = true;
    for (let j = 0; j < S && filled; j++) {
        const r = tryCall(x, () => W.signal(1 + (j % 9)), null);
        if (r.ok) sigs.push(r.h); else filled = false;
    }
    for (let left = R; left > 0 && filled;) {
        const d = left < S ? left : S;
        const c = tryCall(x, () => mkComputed(W, sigs, d), null);
        if (!c.ok) { filled = false; break; }
        comps.push(c.h);
        ds.push(d);
        if (!tryCall(x, () => W.read(c.h), null).ok) { filled = false; break; }
        left -= d;
    }
    let threw = false;
    let reused = false;
    if (filled && (!grow || k === 'ceil')) {
        const ex = capExpect('links', cap);
        const o = tryCall(x, () => mkComputed(W, sigs, 1), null);
        if (o.ok) {
            comps.push(o.h);
            threw = tryCall(x, () => W.read(o.h), ex).threw;
            if (threw && reuse === 1) {
                const oh = comps.pop();
                x.guard(() => W.dispose(oh));
                const lh = comps.pop();
                const d = ds[ds.length - 1];
                x.guard(() => W.dispose(lh));
                const a = tryCall(x, () => mkComputed(W, sigs, d), null);
                if (a.ok) {
                    comps.push(a.h);
                    if (tryCall(x, () => W.read(a.h), null).ok) {
                        const b = tryCall(x, () => mkComputed(W, sigs, 1), null);
                        if (b.ok) {
                            comps.push(b.h);
                            reused = tryCall(x, () => W.read(b.h), ex).threw;
                        }
                    }
                }
            }
        }
    }
    release(x, comps, sigs);
    if (filled && (!grow || k === 'ceil')) x.D.onCapEdge(k, e.onCapacityExceeded, threw, reused);
}

function opEdge(x, op) {
    const e = echoOf(x);
    const k = op.k;
    const reuse = op.reuse;
    if (k !== 'node' && k !== 'link' && k !== 'ceil') unmodelled(x, 'cedge k ' + JSON.stringify(k) + ' is not node / link / ceil');
    if (reuse !== 0 && reuse !== 1) unmodelled(x, 'cedge reuse ' + JSON.stringify(reuse) + ' is not 0 / 1');
    const grow = e.onCapacityExceeded === 'grow';
    if (k === 'ceil' && !grow) unmodelled(x, "cedge ceil under onCapacityExceeded 'throw' (the ceiling is a grow-only edge)");
    if (reuse === 1 && grow && k !== 'ceil') unmodelled(x, 'cedge reuse 1 on a no-throw op (' + k + ' under grow)');
    if (x.batchDepth !== 0 || x.frames.length !== 0) unmodelled(x, 'cedge is a top-level op');
    if (k === 'node') edgeNode(x, e, reuse);
    else edgeLink(x, e, k, reuse);
}

export const CAPACITY = Object.freeze({
    name: 'CAPACITY',
    index: 12,
    needsCaps: Object.freeze(['capacity', 'links', 'disposeSignal', 'disposeComputed']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6']),
    required: Object.freeze(['node-cap-throw', 'link-cap-throw', 'link-ceiling-grow', 'grow-past-initial', 'reuse-at-edge']),
    optional: Object.freeze([]),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: 'maxNodes 32 | 64, maxLinks 1x | 2x, throw | grow; 3-4 leaves, 2-3 computeds, 2 effects (sum / identity, values 1..9) within maxNodes/2 - 2 nodes and maxLinks/2 links; a cedge fills private nodes / links to the cap, the 16x ceiling or past the initial pool, probes it and releases them' }),
    flushPasses: null,
    covOff: Object.freeze({ 'link-ceiling-grow': 'no-ceiling' }),
    init,
    step,
    specRefs,
    ops: Object.freeze({ cedge: opEdge }),
});
