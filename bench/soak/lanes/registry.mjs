/**
 * REGISTRY lane (S3 rung R5, .handoff/PLAN-R5-registry-capacity.md PLAN BODY 1 TASK 2 + RULED D-b139-1..3): registry
 * destroy() at the top level and IN FLIGHT (inside batch(), an effect body, a computed body). LANE_INDEX 10 (S3-D6).
 * Not rostered until R5 B2 (lanes/index.mjs ROSTER / BY_NAME); until then a caller wires it through runWorld's
 * opts.laneOps (test/92, the B1a census harness).
 *
 * World: GRAPH vocabulary on a small graph (3..5 leaf signals, 2..4 computeds, 2..3 effects over sum / identity
 * bodies, values 1..9), core set / read / create / stop ops (gen.mjs emitters, exec.mjs core handlers). A destroy step
 * emits one rdestroy. At the top level the generator's shadow model then drops every node (model.destroyAll) and the
 * next step rebuilds the graph (a seq of core creates closed by rbuilt). In flight the destroy throws and the graph
 * stays: the shadow model takes only the leaf write (setValue i v) and no rebuild follows.
 *
 * Ops (lane-owned, exec.mjs laneOp):
 *   rdestroy { at: 'top' }                  W.destroy() at rest, guarded (O6, EXPECT_NONE: legal at the top level)
 *   rdestroy { at: 'batch', i, v, n }       batch^n(() => { set(leaf i, v); destroy(); }), n 1 | 2 (nested); the set
 *                                           stays (model.setValue)
 *   rdestroy { at: 'body', i, v }           a private effect reading leaf i destroys when it reads v; then
 *                                           setTop(i, v); then the private effect is disposed (guarded, EXPECT_NONE)
 *   rdestroy { at: 'computed', i, v }       a private computed reading leaf i destroys when it reads v, pulled by a
 *                                           private effect; then setTop(i, v); then the private effect and computed
 *                                           are disposed (guarded, EXPECT_NONE)
 *   rreset   { at: 'top', i, t }            registry reset() at rest (C-RESET soak S3a; cap reset); i = a live leaf the
 *                                           private fixture reads, t = its thrown-cleanup count 0 | 1 | 2 (weights
 *                                           6:2:2, D-b162-1). The shadow model then resets (model.resetAll) and the
 *                                           next step rebuilds the graph, as after a top-level destroy
 *   rbuilt   {}                             the rebuild after a top-level destroy is done: counts reuse-after-destroy
 *                                           when a destroy ran in this world and the model holds live nodes again;
 *                                           never for the rebuild after an rreset (the last top-level teardown)
 * rreset (TASK 8a, ADDENDUM 2 / 2b / 3): a PRIVATE fixture (never in the model): effect P (onCleanup logs 'P') owning
 * child Q (onCleanup logs 'Q'), each reading leaf i; t=1: Q's cleanup throws SoakThrow reset:Q (T_Q) once; t=2: P also
 * owns R (logs 'R', throws reset:R = T_R). Then stats() s0, a census hook (W.hook: op 2 ids + kinds and the op-4 count
 * while reset runs, the op-1 id of the probe), W.reset() in ONE guard whose g.eq holds the predicted tokens (t=1
 * [T_Q], t=2 [T_R, T_Q]; O6 compares a multiset after normalizeEscape flattens an AggregateError), model.resetAll(),
 * onRegReset('top'), a probe signal (its op-1 id), its dispose, the hook off. Checks (S0 facts, b162 SUMMARY.txt):
 *   O5  gauges signals / computeds / effects (kind-count), activeNodes (node-count), activeLinks (link-count) all 0;
 *       vs s0 (probe excluded): totalAllocations +0, poolGrowths +0, totalDisposals + s0.activeNodes (node-count)
 *   O8  mirror-links: op-2 count = s0.activeNodes + 2t (X = 2 per thrower); the s0 edge list (model + fixture, engine
 *       ids) has s0.activeLinks edges; op-4 count = the edges whose target's LAST op 2 precedes its source's (rule I3,
 *       mirror.mjs: an edge whose source dies first is freed with that op 2, no op 4). In the S0 fixture that is
 *       s0.activeLinks - t (F-S0-1: a thrower's last op 2 is its round-2 retry, after its leaf); on a world graph a
 *       computed -> computed edge can die source-first at t=0 too (b163 S3a: the literal - t failed 40 / 40 worlds);
 *       op-2 kind ranks E < C < S non-decreasing per round (at most one rank drop, the retry round, and none at t=0;
 *       F-S0-2); every op-2 kind is E, C or S; the probe's op-1 id > the max op-2 id
 *   OW  reset-cleanup: the cleanup log deepEquals ['Q','P'] (t 0 / 1) or ['R','Q','P'] (t 2); the escape: t=0 none,
 *       t=1 esc === T_Q (identity: a wrapper fails), t=2 an AggregateError, message exactly "reset: cleanups threw",
 *       errors [T_R, T_Q] by identity; a D-6 message (cleanups kept creating nodes / no progress) is detail d6
 * One did() per oracle per rreset. The tokens, the log and the escape are op locals: no lane field keeps them (A6).
 * Caps (D-b163-3, ADDENDUM 5): needsCaps stays destroy / stopEffect / links; reset-top is gated per scenario (scenCaps
 * reset / owner / hook, the lanes/batch.mjs precedent), so a pre-1.6.0 kernel still runs the lane's destroy ops and
 * requiredApplicable drops reset-top. On such a world an rreset (scripts stay engine-independent) is a validated no-op.
 * O6 (v): every IN-FLIGHT destroy's outermost guard is judged against expectFromThrow(DIV-D2-destroy-throws
 * .expectedThrow), read ONCE at module load from divergences.json, module-relative (the file divergences.mjs
 * REGISTRY_URL names; no import: divergences.mjs imports the ROSTER, which imports this lane); a missing row throws
 * (fail closed). Contract D2 (since 1.6.0, C-RESET D-4, Signal.js 482a1d98): destroy() inside batch, flush or any
 * body throws Error '[lite-signal] destroy: graph not settled (<reason>)' and changes nothing; expectedThrow is
 * { ctor 'Error', messagePrefix '[lite-signal] destroy: graph not settled' }, so the guard throw is absorbed and any
 * other escape is O6 escape-<Ctor>, a missing throw O6 expected-escape-missing. DIV-F10 is closed (fixedIn 1.6.0):
 * on the tree its shapes (no throw; the D-b139-3 flushEffects TypeError of a cleared queue slot) are known=none.
 * A null expectedThrow would give [EXPECT_NEVER_ENTRY] (every in-flight destroy red: the pre-1.6.0 never entry).
 * exec.regExpect carries the list into that ONE guard (exec.mjs guard() resets it at entry).
 * After a top-level rdestroy exec's model drops every node (model.destroyAll): the engine holds none (O5 at rest).
 * An in-flight rdestroy leaves the graph intact (no model.destroyAll); the private nodes are never in the model, so
 * the op disposes them after the guard, else O5 node-count reports them.
 * An in-flight op (and an rreset) on a dead / absent leaf (a shrunk script) is a no-op, as exec.setTop is.
 * covOff destroy-in-flight -> rule in-flight: every rdestroy is at 'top' (P-REGISTRY-TRIGGERLESS).
 * Per-exec state in a WeakMap (exec needs no slot; the entry dies with the world). Fail closed (exec.unmodelled): an
 * unknown at, a value outside 1..9, a nesting outside 1..2, a non-integer leaf index; an rreset at other than 'top' or
 * with t outside 0..2.
 * COLD module: harness code, never an engine hot path.
 */

import { readFileSync } from 'node:fs';
import { specRefs, SoakThrow } from '../kinds.mjs';
import { expectFromThrow } from '../oracles.mjs';
const REGISTRY_URL = new URL('../divergences.json', import.meta.url);

const MIX = Object.freeze({ set: 40, read: 16, mk: 12, stop: 8, destroy: 4, reset: 4 });
const AT = Object.freeze({ top: 4, batch: 2, body: 2, computed: 2 });
const MAX_LIVE = 24;
const D2_ID = 'DIV-D2-destroy-throws';
const TW = Object.freeze({ 0: 6, 1: 2, 2: 2 });   // rreset thrown-cleanup count t (D-b162-1)
const AGG_MSG = 'reset: cleanups threw';
const D6_PREFIXES = Object.freeze(['[lite-signal] reset: cleanups kept creating nodes', '[lite-signal] reset: no progress']);

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
    if (at === 'top') {
        g.M.destroyAll();
        shadowOf(g).built = false;
        return { o: 'rdestroy', at };
    }
    // in flight: the D2 guard throw leaves the graph; only the leaf write lands (batch set / setTop)
    const i = g.pick(g.leaves());
    const op = { o: 'rdestroy', at, i, v: other(g, i) };
    if (at === 'batch') op.n = 1 + g.int(2);
    g.M.setValue(i, op.v);
    return op;
}

/** A top-level rreset: the shadow model resets and the next step rebuilds (as a top-level destroy). */
function resetOp(g) {
    const i = g.pick(g.leaves());
    const t = Number(g.weighted(TW));
    g.M.resetAll();
    shadowOf(g).built = false;
    return { o: 'rreset', at: 'top', i, t };
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
        case 'reset': g.push(resetOp(g)); return;
    }
}

/* ---- exec side --------------------------------------------------------------------------------------------- */

const STATE = new WeakMap();   // exec -> { destroyed: top-level destroys that ran, reset: the last teardown was an rreset }

function stateOf(x) {
    let s = STATE.get(x);
    if (s === undefined) { s = { destroyed: 0, reset: false }; STATE.set(x, s); }
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

/** An in-flight rdestroy: the guard expects the D2 throw (REG_EXPECT) and the graph stays (no model.destroyAll). */
function opDestroyInFlight(x, op, at) {
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
        let e, c;   // the private nodes (never modelled): disposed after the guard, effect first
        if (at === 'body') x.guard(() => { e = W.effect(() => { if (W.read(h) === v) W.destroy(); }); });
        else x.guard(() => { c = W.computed(() => { const r = W.read(h); if (r === v) W.destroy(); return r; }); e = W.effect(() => { W.read(c); }); });
        x.regExpect = REG_EXPECT;
        x.setTop(i, v, false);
        x.regExpect = null;
        x.guard(() => { if (e !== undefined) W.dispose(e); if (c !== undefined) W.dispose(c); });
    }
    x.regExpect = null;
    x.D.onRegDestroy(at);
}

function opDestroy(x, op) {
    const at = op.at;
    if (at !== 'top') { opDestroyInFlight(x, op, at); return; }
    const st = stateOf(x);
    x.guard(() => x.W.destroy());
    x.M.destroyAll();
    st.destroyed++;
    st.reset = false;
    x.D.onRegDestroy(at);
}

/* ---- rreset (TASK 8a) ---------------------------------------------------------------------------------------- */

/** The private fixture, in its own scope (its closures capture only these parameters). Never in the model. */
function resetFixture(W, h, t, log, TQ, TR, fx) {
    fx.P = W.effect(() => {
        W.read(h);
        W.onCleanup(() => { log.push('P'); });
        fx.Q = W.effect(() => { W.read(h); W.onCleanup(() => { log.push('Q'); if (t >= 1) throw TQ; }); });
        if (t === 2) fx.R = W.effect(() => { W.read(h); W.onCleanup(() => { log.push('R'); throw TR; }); });
    });
}

/**
 * The live edges at s0 as engine ids [src0, tgt0, src1, tgt1, ...]: the model's (expectedLinks' rule: per live observer,
 * its distinct live non-effect sources; a never-ran effect charged what its body would track) plus the fixture's
 * leaf -> P / Q / R. Engine ids through W.nodeId (the ids the hook's op 2 reports); -1 for a handle with none.
 */
function edgesAt(x, W, h, fx) {
    const M = x.M;
    const out = [];
    const memo = new Map();
    const id = (hd) => { const v = hd === undefined ? undefined : W.nodeId(hd); return Number.isInteger(v) ? v : -1; };
    for (let k = 0; k < M.n.length; k++) {
        const nd = M.n[k];
        if (nd === undefined || !nd.live || nd.t === 's') continue;
        let list = nd.links;
        if (list === null) {
            if (nd.t !== 'e') continue;
            list = [];
            for (const e of M.evalBody(k, memo).seen) if (!e.u) list.push(e.r);
        }
        const seen = new Set();
        for (let j = 0; j < list.length; j++) {
            const r = list[j];
            const src = M.n[r];
            if (src !== undefined && src.live && src.t !== 'e' && !seen.has(r)) { seen.add(r); out.push(id(x.H[r]), id(x.H[k])); }
        }
    }
    const hid = id(h);
    for (const f of [fx.P, fx.Q, fx.R]) if (f !== undefined) out.push(hid, id(f));
    return out;
}

/**
 * The op-4 count rule I3 predicts (bench/soak/mirror.mjs; F-S0-1 generalised): an edge fires op 4 iff its target is
 * disposed for the LAST time while its source is still live (target's last op 2 before the source's last op 2); an
 * edge whose source dies first is freed with that op 2, silently. A thrower child's last op 2 is its round-2 retry,
 * after its leaf's: the F-S0-1 - t. -1 when an edge end has no id or no op 2 (the count checks already fail then).
 */
function op4Predicted(edges, ids) {
    const last = new Map();
    for (let k = 0; k < ids.length; k++) last.set(ids[k], k);
    let n = 0;
    for (let k = 0; k < edges.length; k += 2) {
        const a = last.get(edges[k]);
        const b = last.get(edges[k + 1]);
        if (a === undefined || b === undefined) return -1;
        if (b < a) n++;
    }
    return n;
}

/** The census record; its listener closes over the record only and never throws (on: 1 = reset, 2 = probe create). */
function censusOf() {
    const c = { on: 0, ids: [], flags: [], n4: 0, probe: -1, fn: null };
    c.fn = (op, a, b) => {
        if (c.on === 1) {
            if (op === 2) { c.ids.push(a); c.flags.push(b); } else if (op === 4) c.n4++;
        } else if (c.on === 2 && op === 1 && c.probe === -1) c.probe = a;
    };
    return c;
}

/** op-2 kind rank: effect 0 < computed 1 < signal 2; -1 = none of the three. */
function rankOf(f) { return (f & 2) !== 0 ? 0 : (f & 1) !== 0 ? 1 : (f & 32) !== 0 ? 2 : -1; }

function escName(e, TQ, TR) {
    if (e === TQ) return 'T_Q';
    if (TR !== null && e === TR) return 'T_R';
    if (e instanceof AggregateError) return 'AggregateError(' + (Array.isArray(e.errors) ? e.errors.length : '?') + ')';
    if (e !== null && typeof e === 'object') return String(e.constructor && e.constructor.name) + ': ' + String(e.message).slice(0, 120);
    return typeof e;
}

/** The OW reset-cleanup escape-shape detail for t, or null when the shape is exactly the predicted one. */
function escapeShape(t, threw, esc, TQ, TR) {
    if (threw && esc !== null && typeof esc === 'object' && typeof esc.message === 'string' && D6_PREFIXES.some((p) => esc.message.startsWith(p))) {
        return 'd6: ' + esc.message.slice(0, 160);
    }
    if (t === 0) return threw ? 'want no escape, got ' + escName(esc, TQ, TR) : null;
    if (!threw) return 'want ' + (t === 1 ? 'T_Q' : 'AggregateError') + ', got no escape';
    if (t === 1) return esc === TQ ? null : 'want T_Q (identity), got ' + escName(esc, TQ, TR);
    if (!(esc instanceof AggregateError)) return 'want AggregateError, got ' + escName(esc, TQ, TR);
    if (esc.message !== AGG_MSG) return 'AggregateError message ' + JSON.stringify(String(esc.message).slice(0, 120)) + ' != ' + JSON.stringify(AGG_MSG);
    const es = esc.errors;
    if (!Array.isArray(es) || es.length !== 2 || es[0] !== TR || es[1] !== TQ) {
        return 'AggregateError errors [' + (Array.isArray(es) ? es.map((e) => escName(e, TQ, TR)).join(', ') : typeof es) + '] != [T_R, T_Q]';
    }
    return null;
}

const GAUGES = Object.freeze([['signals', 'kind-count'], ['computeds', 'kind-count'], ['effects', 'kind-count'], ['activeNodes', 'node-count'], ['activeLinks', 'link-count']]);

/** Judge one top-level rreset (the header's O5 / O8 / OW list). Findings through x.failF; one did() per oracle. */
function judgeReset(x, t, s0, s1, c, edges, log, threw, esc, TQ, TR) {
    const pre = 'reset t=' + t + ': ';
    x.did('O5');
    for (const [k, sig] of GAUGES) if (s1[k] !== 0) x.failF({ oracle: 'O5', sig, detail: pre + k + '=' + s1[k] + ' != 0' });
    const dA = s1.totalAllocations - s0.totalAllocations;
    const dG = s1.poolGrowths - s0.poolGrowths;
    const dD = s1.totalDisposals - s0.totalDisposals;
    if (dA !== 0) x.failF({ oracle: 'O5', sig: 'node-count', detail: pre + 'totalAllocations +' + dA + ' != +0' });
    if (dG !== 0) x.failF({ oracle: 'O5', sig: 'node-count', detail: pre + 'poolGrowths +' + dG + ' != +0' });
    if (dD !== s0.activeNodes) x.failF({ oracle: 'O5', sig: 'node-count', detail: pre + 'totalDisposals +' + dD + ' != s0.activeNodes ' + s0.activeNodes });
    x.did('O8');
    const n2 = c.ids.length;
    if (n2 !== s0.activeNodes + 2 * t) x.failF({ oracle: 'O8', sig: 'mirror-links', detail: pre + 'op-2 count ' + n2 + ' != s0.activeNodes ' + s0.activeNodes + ' + 2t' });
    if (edges.length !== 2 * s0.activeLinks) x.failF({ oracle: 'O8', sig: 'mirror-links', detail: pre + 'edge list ' + (edges.length >> 1) + ' != s0.activeLinks ' + s0.activeLinks });
    const n4 = op4Predicted(edges, c.ids);
    if (c.n4 !== n4) x.failF({ oracle: 'O8', sig: 'mirror-links', detail: pre + 'op-4 count ' + c.n4 + ' != rule I3 ' + n4 + ' (s0.activeLinks ' + s0.activeLinks + ')' });
    let drops = 0, prev = 0, maxId = -1;
    for (let k = 0; k < n2; k++) {
        const r = rankOf(c.flags[k]);
        if (r === -1) { x.failF({ oracle: 'O8', sig: 'mirror-links', detail: pre + 'op-2 #' + k + ' id ' + c.ids[k] + ' flags 0x' + (c.flags[k] >>> 0).toString(16) + ' is not E / C / S' }); break; }
        if (k > 0 && r < prev) drops++;
        prev = r;
        if (c.ids[k] > maxId) maxId = c.ids[k];
    }
    if (drops > (t === 0 ? 0 : 1)) x.failF({ oracle: 'O8', sig: 'mirror-links', detail: pre + 'op-2 kind ranks E < C < S drop ' + drops + ' times (allowed ' + (t === 0 ? 0 : 1) + ')' });
    if (!(c.probe > maxId)) x.failF({ oracle: 'O8', sig: 'mirror-links', detail: pre + 'probe op-1 id ' + c.probe + ' not > max op-2 id ' + maxId });
    x.did('OW');
    const want = t === 2 ? 'R,Q,P' : 'Q,P';
    if (log.join(',') !== want || log.length !== (t === 2 ? 3 : 2)) x.failF({ oracle: 'OW', sig: 'reset-cleanup', detail: pre + 'cleanup log [' + log.join(',') + '] != [' + want + ']' });
    const shape = escapeShape(t, threw, esc, TQ, TR);
    if (shape !== null) x.failF({ oracle: 'OW', sig: 'reset-cleanup', detail: pre + shape });
}

const RESET_CAPS = Object.freeze(['reset', 'owner', 'hook']);

/** contract.mjs hasCap, inlined (no new import edge into the ROSTER cycle): present = anything but false / 'no'. */
function capOn(caps, k) { const v = caps[k]; return v !== undefined && v !== false && v !== 'no'; }

/** A top-level rreset (TASK 8a; in flight is TASK 8b). The fixture, census and probe are disposed / off by the op. */
function opReset(x, op) {
    if (op.at !== 'top') unmodelled(x, 'rreset at ' + JSON.stringify(op.at) + ' is not top');
    const t = op.t;
    if (t !== 0 && t !== 1 && t !== 2) unmodelled(x, 'rreset t ' + JSON.stringify(t) + ' is not 0 / 1 / 2');
    const i = op.i;
    if (!Number.isInteger(i)) unmodelled(x, 'rreset leaf ' + JSON.stringify(i) + ' is not an integer');
    // D-b163-3: no reset / owner / hook cap (or no world method) -> a no-op, as a dead leaf (counts nothing)
    for (const k of RESET_CAPS) if (!capOn(x.caps, k)) return;
    if (typeof x.W.reset !== 'function' || typeof x.W.hook !== 'function' || typeof x.W.onCleanup !== 'function') return;
    const nd = i >= 0 ? x.M.n[i] : undefined;
    if (nd === undefined || !nd.live || nd.t !== 's' || x.H[i] === undefined) return;   // shrunk away / dead
    const W = x.W;
    const h = x.H[i];
    const TQ = new SoakThrow('reset', 'Q');
    const TR = t === 2 ? new SoakThrow('reset', 'R') : null;
    const log = [];
    const fx = { P: undefined, Q: undefined, R: undefined };
    x.guard(() => { resetFixture(W, h, t, log, TQ, TR, fx); });
    const s0 = W.stats();
    const edges = edgesAt(x, W, h, fx);
    const c = censusOf();
    let off;
    x.guard(() => { off = W.hook(c.fn); });
    let threw = false, esc;
    c.on = 1;
    x.guard((g) => {
        if (t === 1) g.eq.push(TQ.token);
        else if (t === 2) g.eq.push(TR.token, TQ.token);
        try { W.reset(); } catch (e) { threw = true; esc = e; throw e; }
    });
    c.on = 0;
    const s1 = W.stats();
    x.M.resetAll();
    stateOf(x).reset = true;
    x.D.onRegReset('top');
    let p;
    c.on = 2;
    x.guard(() => { p = W.signal(0); });
    c.on = 0;
    x.guard(() => { if (p !== undefined) W.dispose(p); });
    x.guard(() => { if (off !== undefined) off(); });
    judgeReset(x, t, s0, s1, c, edges, log, threw, esc, TQ, TR);
}

function opBuilt(x) {
    const st = stateOf(x);
    if (st.destroyed === 0 || st.reset) return;
    const n = x.M.n;
    let live = 0;
    for (let k = 0; k < n.length; k++) if (n[k] !== undefined && n[k].live) live++;
    if (live > 0) x.D.onRegReuse(live);
}

export const REGISTRY = Object.freeze({
    name: 'REGISTRY',
    index: 10,
    needsCaps: Object.freeze(['destroy', 'stopEffect', 'links']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O8', 'OW']),
    required: Object.freeze(['destroy-top', 'destroy-in-flight', 'destroy-in-batch', 'destroy-in-body', 'destroy-in-computed', 'reuse-after-destroy', 'reset-top']),
    optional: Object.freeze([]),
    scenCaps: Object.freeze({ 'reset-top': RESET_CAPS }),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: '3-5 leaves, 2-4 computeds, 2-3 effects (sum / identity, values 1..9; <= 24 live); destroy() at the top level or in flight (batch, effect body, computed body), then a rebuild; reset() at the top level (a private cleanup fixture, t 0 / 1 / 2 throwing cleanups), then a rebuild' }),
    flushPasses: null,
    covOff: Object.freeze({ 'destroy-in-flight': 'in-flight' }),
    init,
    step,
    specRefs,
    ops: Object.freeze({ rdestroy: opDestroy, rreset: opReset, rbuilt: opBuilt }),
});
