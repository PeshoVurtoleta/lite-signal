/**
 * REGISTRY lane (S3 rung R5, .handoff/PLAN-R5-registry-capacity.md PLAN BODY 1 TASK 2 + RULED D-b139-1..3): registry
 * destroy() at the top level and IN FLIGHT (inside batch(), an effect body, a computed body). LANE_INDEX 10 (S3-D6).
 * Not rostered until R5 B2 (lanes/index.mjs ROSTER / BY_NAME); until then a caller wires it through runWorld's
 * opts.laneOps (test/92, the B1a census harness).
 *
 * World: GRAPH vocabulary on a small graph (3..5 leaf signals, 2..4 computeds, 2..3 effects over sum / identity
 * bodies, values 1..9), core set / read / create / stop ops (gen.mjs emitters, exec.mjs core handlers). A destroy step
 * emits one rdestroy; the generator's shadow model then drops every node (model.destroyAll) and the next step rebuilds
 * the graph (a seq of core creates closed by rbuilt).
 *
 * Ops (lane-owned, exec.mjs laneOp):
 *   rdestroy { at: 'top' }                  W.destroy() at rest, guarded (O6, EXPECT_NONE: legal at the top level)
 *   rdestroy { at: 'batch', i, v, n }       batch^n(() => { set(leaf i, v); destroy(); }), n 1 | 2 (nested)
 *   rdestroy { at: 'body', i, v }           a private effect reading leaf i destroys when it reads v; then setTop(i, v)
 *   rdestroy { at: 'computed', i, v }       a private computed reading leaf i destroys when it reads v, pulled by a
 *                                           private effect; then setTop(i, v)
 *   rbuilt   {}                             the rebuild after a destroy is done: counts reuse-after-destroy when a
 *                                           destroy ran in this world and the model holds live nodes again
 * O6 (v): every IN-FLIGHT destroy's outermost guard is judged against expectFromThrow(DIV-D2-destroy-throws
 * .expectedThrow) (contract D2: destroy() inside batch, flush or any body throws), read ONCE at module load from
 * divergences.json, module-relative (the file divergences.mjs REGISTRY_URL names; no import: divergences.mjs imports
 * the ROSTER, which imports this lane); a missing row throws (fail closed). While expectedThrow is null the list
 * is [EXPECT_NEVER_ENTRY]: no throw -> expected-escape-missing (DIV-F10), an engine throw ->
 * escape-<Ctor> + expected-escape-missing (D-b139-3: the flushEffects TypeError of a cleared queue slot, the CO-SHAPE
 * of DIV-F10). exec.regExpect carries the list into that ONE guard (exec.mjs guard() resets it at entry).
 * After every rdestroy that ran, exec's model drops every node (model.destroyAll): the engine holds none (O5 at rest).
 * The private nodes are never in the model; destroy() removes them, else O5 node-count reports them.
 * An in-flight op on a dead / absent leaf (a shrunk script) is a no-op, as exec.setTop is.
 * covOff destroy-in-flight -> rule in-flight: every rdestroy is at 'top' (P-REGISTRY-TRIGGERLESS).
 * Per-exec state in a WeakMap (exec needs no slot; the entry dies with the world). Fail closed (exec.unmodelled): an
 * unknown at, a value outside 1..9, a nesting outside 1..2, a non-integer leaf index.
 * COLD module: harness code, never an engine hot path.
 */

import { readFileSync } from 'node:fs';
import { specRefs } from '../kinds.mjs';
import { expectFromThrow } from '../oracles.mjs';
const REGISTRY_URL = new URL('../divergences.json', import.meta.url);

const MIX = Object.freeze({ set: 40, read: 16, mk: 12, stop: 8, destroy: 4 });
const AT = Object.freeze({ top: 4, batch: 2, body: 2, computed: 2 });
const MAX_LIVE = 24;
const D2_ID = 'DIV-D2-destroy-throws';

function d2Row() {
    const reg = JSON.parse(readFileSync(REGISTRY_URL, 'utf8'));
    const list = reg !== null && typeof reg === 'object' ? reg.entries : undefined;
    const row = Array.isArray(list) ? list.find((e) => e !== null && typeof e === 'object' && e.id === D2_ID) : undefined;
    if (row === undefined) throw new Error('lanes/registry: divergences.json has no ' + D2_ID + ' row (O6 (v) needs its expectedThrow)');
    return row;
}

/** The O6 (v) expect[] list of every in-flight destroy (frozen; read once). */
export const REG_EXPECT = expectFromThrow(d2Row().expectedThrow);

/* ---- generator side (G0: the generator reads only its shadow model) ------------------------------------------ */

const SHADOW = new WeakMap();   // Gen -> { built }

function shadowOf(g) {
    let s = SHADOW.get(g);
    if (s === undefined) { s = { built: false }; SHADOW.set(g, s); }
    return s;
}

function val(g) { return 1 + g.int(9); }

function other(g, i) { return ((g.M.n[i].v + g.int(8)) % 9) + 1; }   // 1..9, never the current value

function pool(g) { return g.nodes((nd) => (nd.t === 's' && nd.role === 'leaf') || nd.t === 'c'); }

function body(g, role) {
    const x = g.r();
    const d = g.some(pool(g), x < 0.2 ? 1 : x < 0.7 ? 2 : 3);
    return { k: d.length === 1 ? 'identity' : 'sum', d, role };
}

/** The graph: 3..5 leaves, 2..4 computeds, 2..3 effects. */
function build(g) {
    const ops = [];
    const L = 3 + g.int(3);
    for (let k = 0; k < L; k++) ops.push(g.sig({ v: val(g), role: 'leaf' }));
    const C = 2 + g.int(3);
    for (let k = 0; k < C; k++) ops.push(g.comp(body(g, 'comp'), g.chance(0.5)));
    const E = 2 + g.int(2);
    for (let k = 0; k < E; k++) ops.push(g.eff(body(g, 'eff')));
    shadowOf(g).built = true;
    return ops;
}

function setOp(g) {
    const i = g.pick(g.leaves());
    return g.set(i, other(g, i));
}

function destroyOp(g) {
    const at = g.ruleOff('in-flight') ? 'top' : g.weighted(AT);
    let op;
    if (at === 'top') op = { o: 'rdestroy', at };
    else {
        const i = g.pick(g.leaves());
        op = { o: 'rdestroy', at, i, v: other(g, i) };
        if (at === 'batch') op.n = 1 + g.int(2);
    }
    g.M.destroyAll();
    shadowOf(g).built = false;
    return op;
}

function init(g) {
    for (const op of build(g)) g.push(op, true);
}

function step(g) {
    if (!shadowOf(g).built) {
        const ops = build(g);
        ops.push({ o: 'rbuilt' });
        g.push({ o: 'seq', ops });
        return;
    }
    switch (g.weighted(MIX)) {
        case 'set': g.push(setOp(g)); return;
        case 'read': g.push({ o: 'read', is: g.nodes((nd) => nd.t === 'c') }); return;
        case 'mk': {
            if (g.nodes(() => true).length >= MAX_LIVE) { g.push(setOp(g)); return; }
            g.push(g.chance(0.5) ? g.comp(body(g, 'comp'), g.chance(0.5)) : g.eff(body(g, 'eff')));
            return;
        }
        case 'stop': {
            const es = g.nodes((nd) => nd.t === 'e');
            g.push(es.length > 1 ? g.stop(g.pick(es)) : setOp(g));
            return;
        }
        case 'destroy': g.push(destroyOp(g)); return;
    }
}

/* ---- exec side --------------------------------------------------------------------------------------------- */

const STATE = new WeakMap();   // exec -> { destroyed }

function stateOf(x) {
    let s = STATE.get(x);
    if (s === undefined) { s = { destroyed: 0 }; STATE.set(x, s); }
    return s;
}

function unmodelled(x, msg) {
    x.unmodelled = new Error('exec: unmodelled registry op: ' + msg);
    throw x.unmodelled;
}

function batchN(x, n, h, v) {
    if (n === 1) x.W.batch(() => { x.W.set(h, v); x.W.destroy(); });
    else x.W.batch(() => { x.W.batch(() => { x.W.set(h, v); x.W.destroy(); }); });
}

function opDestroy(x, op) {
    const st = stateOf(x);
    const at = op.at;
    if (at === 'top') {
        x.guard(() => x.W.destroy());
    } else {
        if (at !== 'batch' && at !== 'body' && at !== 'computed') unmodelled(x, 'rdestroy at ' + JSON.stringify(at) + ' is not top / batch / body / computed');
        const i = op.i;
        const v = op.v;
        if (!Number.isInteger(i)) unmodelled(x, 'rdestroy leaf ' + JSON.stringify(i) + ' is not an integer');
        if (!(Number.isInteger(v) && v >= 1 && v <= 9)) unmodelled(x, 'rdestroy value ' + JSON.stringify(v) + ' is not 1..9');
        const n = at === 'batch' ? op.n : 1;
        if (n !== 1 && n !== 2) unmodelled(x, 'rdestroy batch nesting ' + JSON.stringify(op.n) + ' is not 1 / 2');
        const nd = i >= 0 ? x.M.n[i] : undefined;
        if (nd === undefined || !nd.live || nd.t !== 's' || x.H[i] === undefined) return;   // shrunk away / dead
        const h = x.H[i];
        const W = x.W;
        if (at === 'batch') {
            x.M.setValue(i, v);
            x.regExpect = REG_EXPECT;
            x.guard(() => batchN(x, n, h, v));
        } else {
            if (at === 'body') x.guard(() => { W.effect(() => { if (W.read(h) === v) W.destroy(); }); });
            else x.guard(() => { const c = W.computed(() => { const r = W.read(h); if (r === v) W.destroy(); return r; }); W.effect(() => { W.read(c); }); });
            x.regExpect = REG_EXPECT;
            x.setTop(i, v, false);
        }
        x.regExpect = null;
    }
    x.M.destroyAll();
    st.destroyed++;
    x.D.onRegDestroy(at);
}

function opBuilt(x) {
    if (stateOf(x).destroyed === 0) return;
    const n = x.M.n;
    let live = 0;
    for (let k = 0; k < n.length; k++) if (n[k] !== undefined && n[k].live) live++;
    if (live > 0) x.D.onRegReuse(live);
}

export const REGISTRY = Object.freeze({
    name: 'REGISTRY',
    index: 10,
    needsCaps: Object.freeze(['destroy', 'stopEffect', 'links']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6']),
    required: Object.freeze(['destroy-top', 'destroy-in-flight', 'destroy-in-batch', 'destroy-in-body', 'destroy-in-computed', 'reuse-after-destroy']),
    optional: Object.freeze([]),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: '3-5 leaves, 2-4 computeds, 2-3 effects (sum / identity, values 1..9; <= 24 live); destroy() at the top level or in flight (batch, effect body, computed body), then a rebuild' }),
    flushPasses: null,
    covOff: Object.freeze({ 'destroy-in-flight': 'in-flight' }),
    init,
    step,
    specRefs,
    ops: Object.freeze({ rdestroy: opDestroy, rbuilt: opBuilt }),
});
