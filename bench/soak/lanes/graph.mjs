/**
 * GRAPH lane (SPEC-B v2 section 5.1): the plain consistency control. Random DAGs, writes, write bursts,
 * same-value rewrites, selector steering, partial / untracked top-level reads, creation, stops, disposal
 * of disposable signals (read by effects only: G6) and I1 writer effects. 1 world in 64 is LARGE.
 * Absorbs the oracle-fuzzer classes (CHECK_P, write-burst, shuffled check) and graph-fuzzer's shapes.
 */

import { specRefs } from '../kinds.mjs';

const MIX = Object.freeze({
    set: 30, burst: 6, rewrite: 6, steer: 6, partial: 8, untrack: 3, create: 12, stop: 5, dispose: 6, writer: 8, readAll: 10,
});

// value codes (kinds.mjs): int 0 is code 0, -0 is -2, NaN -5, REF_A -15, REF_B -16
const ADVERSARIAL = new Map([[0, -2], [-2, 0], [-5, -5], [-15, -16], [-16, -15]]);   // 0<->-0, NaN->NaN, REF_A<->REF_B

function readPool(g) {
    return g.nodes((nd) => (nd.t === 's' && !nd.dis && (nd.role === 'leaf' || nd.role === 'target')) || (nd.t === 'c' && nd.role !== 'chain'));
}

function effPool(g) {
    return g.nodes((nd) => (nd.t === 's' && (nd.role === 'leaf' || nd.role === 'target')) || (nd.t === 'c' && nd.role !== 'chain'));
}

function kinds(g) {
    return g.ruleOff('dynamic-kinds') ? { sum: 3, identity: 2, hash: 1 } : undefined;
}

function compOp(g, pool) {
    const spec = g.bodySpec(pool, { kinds: kinds(g) });
    if (spec === null) return null;
    return g.comp(spec, false);
}

function effOps(g, writer) {
    const spec = g.bodySpec(effPool(g), { kinds: kinds(g), fan: 1 + g.int(3) });
    if (spec === null) return [];
    spec.try = true;
    const ops = [];
    if (writer) {
        const rank = g.specRank(spec) + 1;
        const w = g.sig({ role: 'target', rank, v: 0 });
        ops.push(w);
        spec.w = w.i;
    }
    ops.push(g.eff(spec));
    return ops;
}

function chain(g, len) {
    const base = g.pick(g.leaves());
    let prev = g.comp({ k: 'sum', d: [base], role: 'chain' }, false);
    g.push(prev, true);
    for (let k = 1; k < len; k++) {
        const spec = g.chance(0.5) ? { k: 'identity', d: [prev.i], role: 'chain' } : { k: 'sum', d: [prev.i, base], role: 'chain' };
        prev = g.comp(spec, false);
        g.push(prev, true);
    }
}

function init(g) {
    const L = g.large ? 40 : 10;
    for (let k = 0; k < L; k++) g.push(g.sig({}), true);
    for (let k = 0; k < (g.large ? 10 : 3); k++) g.push(g.sig({ dis: true }), true);
    if (!g.ruleOff('chain') && (g.large || g.chance(0.5))) chain(g, g.large ? 200 : 16 + g.int(9));
    const tiers = g.large ? 12 : 4, per = g.large ? 100 : 5;
    const hub = g.leaves()[0];
    for (let t = 0; t < tiers; t++) {
        const pool = readPool(g);
        for (let n = 0; n < per; n++) {
            const spec = g.bodySpec(pool, { kinds: kinds(g) });
            if (g.large && g.chance(0.3) && spec.d.indexOf(hub) === -1 && spec.s !== hub) spec.d.push(hub);
            g.push(g.comp(spec, false), true);
        }
    }
    const E = g.large ? 150 : 5;
    for (let k = 0; k < E; k++) for (const op of effOps(g, g.chance(g.large ? 0.1 : 0.3))) g.push(op, true);
}

function step(g) {
    const what = g.weighted(MIX);
    const settable = () => g.nodes((nd) => nd.t === 's' && (nd.role === 'leaf'));
    switch (what) {
        case 'set': {
            const s = g.pick(settable());
            const cur = g.vOf(s);
            const v = (g.chance(0.25) && ADVERSARIAL.has(cur)) ? ADVERSARIAL.get(cur) : g.value();
            g.push(g.set(s, v));
            return;
        }
        case 'burst': {
            const s = g.pick(g.leaves());
            const n = 2 + g.int(4);
            const vs = [];
            for (let k = 0; k < n; k++) vs.push(g.value());
            g.set(s, vs[vs.length - 1]);
            g.push({ o: 'burst', i: s, vs });
            return;
        }
        case 'rewrite': {
            const s = g.pick(settable());
            g.push(g.set(s, g.vOf(s)));
            return;
        }
        case 'steer': {
            const sel = g.nodes((nd) => nd.t === 'c' && nd.spec.k === 'select');
            if (sel.length === 0 || g.ruleOff('dynamic-kinds')) { const s = g.pick(settable()); g.push(g.set(s, g.value())); return; }
            const c = g.M.n[g.pick(sel)];
            g.push(g.set(c.spec.s, g.int(100)));
            return;
        }
        case 'partial': {
            const cs = g.nodes((nd) => nd.t === 'c');
            g.push({ o: 'read', is: g.some(cs, 1 + g.int(5)) });
            return;
        }
        case 'untrack': {
            const cs = g.nodes((nd) => nd.t === 'c');
            g.push({ o: 'read', is: [g.pick(cs)], u: 1 });
            return;
        }
        case 'create': {
            const x = g.r();
            if (x < 0.3) g.push(g.sig({ dis: g.chance(0.3) }));
            else if (x < 0.7) { const op = compOp(g, readPool(g)); if (op !== null) g.push(op); else g.push({ o: 'read', is: [] }); }
            else { const ops = effOps(g, false); g.push(ops.length === 1 ? ops[0] : { o: 'seq', ops }); }
            return;
        }
        case 'stop': {
            const es = g.nodes((nd) => nd.t === 'e');
            if (es.length > 2) g.push(g.stop(g.pick(es)));
            else g.push({ o: 'read', is: [] });
            return;
        }
        case 'dispose': {
            const ds = g.disposables();
            if (ds.length === 0) { g.push(g.sig({ dis: true })); return; }
            const d = g.disp(g.pick(ds));
            g.push({ o: 'seq', ops: [d, g.sig({ dis: true })] });
            return;
        }
        case 'writer': {
            g.push({ o: 'seq', ops: effOps(g, true) });
            return;
        }
        case 'readAll': {
            g.push({ o: 'read', is: g.nodes((nd) => nd.t === 'c') });
            return;
        }
    }
}

export const GRAPH = Object.freeze({
    name: 'GRAPH',
    needsCaps: Object.freeze([]),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6']),
    required: Object.freeze(['diamond-write', 'dep-set-flip', 'deep-pull', 'second-invalidation', 'equality-cutoff', 'adversarial-equality']),
    optional: Object.freeze(['wide-mark']),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 64, normal: '10 leaves, 3 disposable, 4x5 computeds, chain 16-24 (p 0.5), 5 effects (30% I1 writers)', large: '40 leaves, 10 disposable, 12x100 computeds (30% read one hub leaf), chain 200, 150 effects' }),
    flushPasses: null,
    // cov-off:<scenario> -> the generator rule switched off
    covOff: Object.freeze({ 'dep-set-flip': 'dynamic-kinds', 'deep-pull': 'chain' }),
    init,
    step,
    specRefs,
});
