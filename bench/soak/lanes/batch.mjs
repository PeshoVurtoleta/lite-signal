/**
 * BATCH lane (SPEC-B v2 section 5.1): batched writes with dependency-aware mid-batch reads and reverts to
 * the pre-batch value (F5) or to an intermediate one, nested batches, throw-in-batch, effects created
 * mid-batch, no-op batches and plain writes. Built on model-lane.mjs:71-79.
 */

const MIX = Object.freeze({ batch: 40, nested: 15, throwIn: 6, effMid: 8, noop: 3, set: 28 });

function compPool(g) {
    return g.nodes((nd) => (nd.t === 's' && nd.role === 'leaf') || nd.t === 'c');
}

function init(g) {
    for (let k = 0; k < 8; k++) g.push(g.sig({}), true);
    for (let t = 0; t < 2; t++) {
        const pool = compPool(g);
        for (let n = 0; n < 5; n++) g.push(g.comp(g.bodySpec(pool), false), true);
    }
    for (let k = 0; k < 5; k++) g.push(effOp(g), true);
}

function effOp(g) {
    const spec = g.bodySpec(compPool(g), { fan: 1 + g.int(3) });
    spec.try = true;
    return g.eff(spec);
}

/**
 * Append k writes (+ mid-reads, reverts) to body. st: the outermost batch's state
 * { pre: Map(s -> pre-batch code), mid: Set(s), hist: Map(s -> [codes]) }.
 */
function writes(g, body, k, st) {
    const leaves = g.leaves();
    const comps = g.nodes((nd) => nd.t === 'c');
    const guardOff = g.ruleOff('mid-read-revert');
    const put = (s, v) => {
        if (guardOff && st.mid.has(s) && v === st.pre.get(s)) return;   // cov-off: never revert after a mid-read
        body.push(g.set(s, v));
        st.hist.get(s).push(v);
    };
    for (let j = 0; j < k; j++) {
        const s = g.pick(leaves);
        if (!st.pre.has(s)) { st.pre.set(s, g.vOf(s)); st.hist.set(s, []); }
        put(s, g.value());
        if (g.chance(0.5)) {
            const deps = comps.filter((c) => g.cone(c).has(s));
            if (deps.length > 0) {
                const c = g.pick(deps);
                body.push({ o: 'read', is: [c] });
                const cone = g.cone(c);
                for (const [w] of st.pre) if (cone.has(w)) st.mid.add(w);
            }
        }
        const r = g.r();
        if (r < 0.3) put(s, st.pre.get(s));
        else if (r < 0.4) { const h = st.hist.get(s); if (h.length > 0) put(s, g.pick(h)); }
    }
}

function newState() { return { pre: new Map(), mid: new Set(), hist: new Map() }; }

function step(g) {
    switch (g.weighted(MIX)) {
        case 'batch': {
            const body = [];
            writes(g, body, 1 + g.int(4), newState());
            g.push({ o: 'batch', body });
            return;
        }
        case 'nested': {
            const st = newState();
            const depth = 2 + g.int(2);
            const build = (d) => {
                const body = [];
                writes(g, body, 1 + g.int(2), st);
                if (d < depth) body.push({ o: 'batch', body: build(d + 1) });
                if (g.chance(0.5)) writes(g, body, 1, st);
                return body;
            };
            g.push({ o: 'batch', body: build(1) });
            return;
        }
        case 'throwIn': {
            const body = [];
            writes(g, body, 1 + g.int(3), newState());
            g.push({ o: 'batch', body, thr: 1 });
            return;
        }
        case 'effMid': {
            const st = newState();
            const body = [];
            writes(g, body, 1 + g.int(2), st);
            body.push(effOp(g));
            if (g.chance(0.6)) writes(g, body, 1 + g.int(2), st);
            g.push({ o: 'batch', body });
            return;
        }
        case 'noop':
            g.push({ o: 'batch', body: [] });
            return;
        case 'set': {
            const s = g.pick(g.leaves());
            g.push(g.set(s, g.value()));
            return;
        }
    }
}

export const BATCH = Object.freeze({
    name: 'BATCH',
    needsCaps: Object.freeze(['batch']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6']),
    required: Object.freeze(['revert-after-mid-read', 'revert-no-read', 'nested-close', 'throw-in-batch', 'effect-created-mid-batch', 'multi-write-same-signal']),
    optional: Object.freeze([]),
    scenCaps: Object.freeze({
        'revert-after-mid-read': ['batch'], 'revert-no-read': ['batch'], 'nested-close': ['batch'], 'throw-in-batch': ['batch'],
        'effect-created-mid-batch': ['batch'], 'multi-write-same-signal': ['batch'],
    }),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: '8 leaves, 2x5 computeds, 5 effects (+ mid-batch creations)' }),
    flushPasses: null,
    covOff: Object.freeze({ 'revert-after-mid-read': 'mid-read-revert' }),
    init,
    step,
});
