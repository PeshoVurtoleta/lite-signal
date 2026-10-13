/**
 * ERROR lane (SPEC-B v2 section 5.1): throwing computeds (thr rule, 25% of creations), effects that read
 * through try (70%) or naked (30%), writes, batches, recovery steering, throwing `equals`, creation,
 * stops and the cycle-bomb (G7: flushPasses 8, its effects stopped in the same op). F6 lives here.
 * 25% of batches throw after their writes; with a throwing close-flush that is the F22 shape (lost batch error).
 */

import { EQ_BOMB_CODE, SoakThrow } from '../kinds.mjs';

const MIX = Object.freeze({ set: 35, batch: 20, steer: 10, eqBomb: 5, create: 15, stop: 5, bomb: 1 });

function sigPool(g) {
    return g.nodes((nd) => nd.t === 's' && (nd.role === 'leaf' || nd.role === 'eq'));
}

/** Does node i depend (statically, any branch) on a throwing computed? */
function thrCone(g, i, memo) {
    if (memo.has(i)) return memo.get(i);
    const nd = g.M.n[i];
    let t = false;
    if (nd.t === 'c') {
        t = nd.spec.thr === true;
        if (!t) for (const r of nd.spec.d.concat(nd.spec.s !== undefined ? [nd.spec.s] : [])) if (thrCone(g, r, memo)) { t = true; break; }
    }
    memo.set(i, t);
    return t;
}

function compOp(g) {
    const pool = g.nodes((nd) => (nd.t === 's' && (nd.role === 'leaf' || nd.role === 'eq')) || (nd.t === 'c'));
    return g.comp(g.bodySpec(pool, { thr: g.chance(0.25) }), false);
}

function effOp(g) {
    let comps = g.nodes((nd) => nd.t === 'c');
    if (g.ruleOff('prewalk-throw')) { const memo = new Map(); comps = comps.filter((c) => !thrCone(g, c, memo)); }
    const pool = comps.concat(g.chance(0.3) ? sigPool(g) : []);
    const spec = g.bodySpec(pool.length > 0 ? pool : sigPool(g), { fan: 1 + g.int(3) });
    spec.try = g.chance(0.7);
    return g.eff(spec);
}

function init(g) {
    g.flushPasses = 8;
    for (let k = 0; k < 8; k++) g.push(g.sig({}), true);
    for (let k = 0; k < 2; k++) g.push(g.sig({ role: 'eq', eq: true, v: g.int(100) }), true);
    for (let k = 0; k < 12; k++) g.push(compOp(g), true);
    for (let k = 0; k < 6; k++) g.push(effOp(g), true);
}

function step(g) {
    switch (g.weighted(MIX)) {
        case 'set': {
            g.push(g.set(g.pick(sigPool(g)), g.value()));
            return;
        }
        case 'batch': {
            const body = [];
            const n = 1 + g.int(3);
            for (let k = 0; k < n; k++) {
                body.push(g.set(g.pick(sigPool(g)), g.value()));
                if (g.chance(0.3)) { const cs = g.nodes((nd) => nd.t === 'c'); if (cs.length) body.push({ o: 'read', is: [g.pick(cs)] }); }
            }
            // 25% throw-in-batch: O6 always predicts the batch token. When a naked effect also throws in the
            // close-flush, an engine whose finally-flush error replaces the user's error loses it (F22)
            g.push(g.chance(0.25) ? { o: 'batch', body, thr: 1 } : { o: 'batch', body });
            return;
        }
        case 'steer': {
            const memo = new Map();
            const bad = g.nodes((nd) => nd.t === 'c').filter((c) => g.M.val(c, memo) instanceof SoakThrow);
            const target = bad.length > 0 ? g.pick(bad) : g.pick(g.nodes((nd) => nd.t === 'c'));
            const srcs = Array.from(g.cone(target)).filter((s) => g.M.n[s].live);
            const s = srcs.length > 0 ? g.pick(srcs) : g.pick(sigPool(g));
            g.push(g.set(s, g.int(100)));
            return;
        }
        case 'eqBomb': {
            const eqs = g.nodes((nd) => nd.t === 's' && nd.role === 'eq');
            g.push(g.set(g.pick(eqs), EQ_BOMB_CODE));
            return;
        }
        case 'create':
            g.push(g.chance(0.5) ? compOp(g) : effOp(g));
            return;
        case 'stop': {
            const es = g.nodes((nd) => nd.t === 'e');
            if (es.length > 2) g.push(g.stop(g.pick(es)));
            else g.push({ o: 'read', is: [] });
            return;
        }
        case 'bomb': {
            const a = g.sig({ role: 'bomb', v: 0 }), b = g.sig({ role: 'bomb', v: 0 });
            const e1 = g.eff({ k: 'sum', d: [a.i], w: b.i, inc: 1, try: true, role: 'bomb' });
            const e2 = g.eff({ k: 'sum', d: [b.i], w: a.i, inc: 1, try: true, role: 'bomb' });
            const trig = { o: 'set', i: a.i, v: 500, cyc: 1 };
            g.push({ o: 'seq', ops: [a, b, e1, e2, trig, g.stop(e1.i), g.stop(e2.i), g.disp(a.i), g.disp(b.i)] });
            return;
        }
    }
}

export const ERROR = Object.freeze({
    name: 'ERROR',
    needsCaps: Object.freeze([]),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'OB']),
    required: Object.freeze(['throw-dep-effect-prewalk', 'throw-dep-computed-prewalk', 'recovery-after-throw', 'aggregate', 'throwing-equals']),
    optional: Object.freeze(['cycle-error-surfaces']),
    scenCaps: Object.freeze({}),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: '8 leaves, 2 throwing-equals signals, 12 computeds (25% thr), 6 effects (70% try)' }),
    flushPasses: 8,
    covOff: Object.freeze({ 'throw-dep-effect-prewalk': 'prewalk-throw' }),
    init,
    step,
});
