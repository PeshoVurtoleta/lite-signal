/**
 * WIE lane (unit 0s, PLAN-0s-wie ADDENDUM 1; rulings D1 / D3 / D4 / D5): WRITE-IN-EVAL. Computed WRITERS
 * (gen.mjs I2 lifted for this lane only: C writes w := f(C's output), Gen.writer) and READERS of w in both
 * orders: w read BEFORE C is pulled (the stale class, F-b33-1 / LEDGER #37: the reader holds the old value
 * when C's write lands and must be flagged and re-run) and w read AFTER C (the write-before-read control).
 *
 * Reader variants per writer group (test/56 row names):
 *   eff-stale   effect [w, C]                    V1; a top-level set of C's input makes it b33-effect (pre-walk)
 *   eff-y       Y = computed(w); effect [Y, C]   V3 (V6 when the writer carries wu)
 *   comp-stale  D = computed [w, C] (+50% an effect over D)   V7 / b33-computed (pull walk); IF with the effect
 *   eff-ctrl    effect [C, w]                    V2 control
 *   comp-ctrl   D = computed [C, w]              V2 control through a computed
 * lead: with p 0.5 a stale-order reader first reads a leaf s of C's cone ([s, w, C]): a set of s makes the reader
 * DIRECTLY dirty, so its body (not a pre-walk) pulls C and C's write lands after the reader read w -- the
 * acyclic, post-creation lost update (#37). pre-pull: with p 0.5 the writer is pulled at its creation, before
 * any reader exists, so the readers' first runs are not the creation-time V1 shape and later ops are reached.
 * Not reachable here: the b33 PRE-WALK lost update (test/56 b33-effect / b33-computed) needs a write whose
 * value is independent of C's output; w := f(out) changes only when C's output changes, which re-runs the
 * reader through C on any engine. wie-prewalk counts the pre-walk WRITE (coverage), not that lost update.
 * Reader computeds carry role 'reader'. A writer reads leaves and plain computeds only, so W1 (Gen.writer:
 * rank(w) = specRank + 1) holds by construction; exec.mjs still fails closed on a target in its own read set (D4).
 *
 * D3 narrow v1, OUT: batches, lifecycle, child effects, cleanup writes, disposal of writers / targets (W3).
 * D5: no new oracle; O1e / O1c / O2 against the lockstep model catch the stale class.
 * index 4 lives ON the descriptor: WIE is not in ROSTER until B2 (tests import it directly).
 */

const MIX = Object.freeze({ set: 40, burst: 6, rewrite: 4, read: 14, readAll: 8, untrack: 3, group: 8, comp: 5, stop: 4 });

const READERS = Object.freeze(['eff-stale', 'eff-y', 'comp-stale', 'eff-ctrl', 'comp-ctrl']);
const KINDS = Object.freeze({ sum: 3, identity: 1, select: 1.5, cond: 1, hash: 1 });

function plainPool(g) {
    return g.nodes((nd) => (nd.t === 's' && nd.role === 'leaf') || (nd.t === 'c' && nd.role === 'comp' && nd.spec.w === undefined));
}

/** A reader body over refs in ORDER (sum and hash read every dep in d order; G4: refs distinct). */
function rspec(g, d, role) {
    const spec = { k: g.chance(0.7) ? 'sum' : 'hash', d };
    if (role) spec.role = role;
    return spec;
}

/** [s, w, C] with p 0.5 (s a leaf of C's static cone), else [w, C]. */
function staleRefs(g, w, c) {
    if (g.chance(0.5)) {
        const ls = Array.from(g.cone(c)).filter((x) => g.M.n[x].role === 'leaf').sort((a, b) => a - b);
        if (ls.length > 0) return [g.pick(ls), w, c];
    }
    return [w, c];
}

/** One reader of (w, C) of the given variant; put(op) receives each op in order. */
function reader(g, variant, w, c, put) {
    switch (variant) {
        case 'eff-stale': put(g.eff(rspec(g, staleRefs(g, w, c)))); return;
        case 'eff-y': {
            const y = g.comp({ k: 'identity', d: [w], role: 'reader' }, false);
            put(y);
            put(g.eff(rspec(g, [y.i, c])));
            return;
        }
        case 'comp-stale': {
            const d = g.comp(rspec(g, staleRefs(g, w, c), 'reader'), false);
            put(d);
            if (g.chance(0.5)) put(g.eff({ k: 'identity', d: [d.i] }));
            return;
        }
        case 'eff-ctrl': put(g.eff(rspec(g, [c, w]))); return;
        case 'comp-ctrl': put(g.comp(rspec(g, [c, w], 'reader'), false)); return;
    }
}

/** A writer group: target w + writer C (inc / wu variants) + 1..3 readers. Mid-world it is ONE seq op. */
function group(g, init) {
    const spec = g.bodySpec(plainPool(g), { kinds: KINDS });
    if (spec === null) return false;
    const inc = g.chance(0.5) ? 1 + g.int(5) : undefined;
    const ops = g.writer(spec, { inc, wu: g.chance(0.25) });
    if (g.chance(0.5)) ops[1].pull = 1;   // pre-pull: C has written w before any reader runs
    const w = ops[0].i, c = ops[1].i;
    const seq = [ops[0], ops[1]];
    const n = 1 + g.int(3);
    for (let k = 0; k < n; k++) reader(g, g.pick(READERS), w, c, (op) => seq.push(op));
    if (init) for (const op of seq) g.push(op, true);
    else g.push({ o: 'seq', ops: seq });
    return true;
}

function init(g) {
    for (let k = 0; k < 8; k++) g.push(g.sig({}), true);
    for (let t = 0; t < 2; t++) {
        const pool = plainPool(g);
        for (let n = 0; n < 3; n++) g.push(g.comp(g.bodySpec(pool, { kinds: KINDS }), false), true);
    }
    for (let k = 0; k < 4; k++) group(g, true);
}

function step(g) {
    const what = g.weighted(MIX);
    switch (what) {
        case 'set': {
            g.push(g.set(g.pick(g.leaves()), g.value()));
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
            const s = g.pick(g.leaves());
            g.push(g.set(s, g.vOf(s)));
            return;
        }
        case 'read': {
            const cs = g.nodes((nd) => nd.t === 'c');
            g.push({ o: 'read', is: g.some(cs, 1 + g.int(4)) });
            return;
        }
        case 'readAll': {
            g.push({ o: 'read', is: g.nodes((nd) => nd.t === 'c') });
            return;
        }
        case 'untrack': {
            const cs = g.nodes((nd) => nd.t === 'c');
            g.push({ o: 'read', is: [g.pick(cs)], u: 1 });
            return;
        }
        case 'group': {
            if (!group(g, false)) g.push({ o: 'read', is: [] });
            return;
        }
        case 'comp': {
            const spec = g.bodySpec(plainPool(g), { kinds: KINDS });
            g.push(spec === null ? { o: 'read', is: [] } : g.comp(spec, false));
            return;
        }
        case 'stop': {
            // readers only (effects); writers and targets are never disposed (W3)
            const es = g.nodes((nd) => nd.t === 'e');
            if (es.length > 3) g.push(g.stop(g.pick(es)));
            else g.push({ o: 'read', is: [] });
            return;
        }
    }
}

export const WIE = Object.freeze({
    name: 'WIE',
    index: 4,
    needsCaps: Object.freeze(['untrack']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6']),
    required: Object.freeze(['wie-stale-effect', 'wie-stale-computed', 'wie-prewalk', 'wie-untrack', 'wie-write-before-read']),
    optional: Object.freeze([]),
    scenCaps: Object.freeze({ 'wie-untrack': ['untrack'] }),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: '8 leaves, 2x3 plain computeds, 4 writer groups (computed writer + 1-3 readers; +8% per step)' }),
    flushPasses: null,
    covOff: Object.freeze({}),
    init,
    step,
});
