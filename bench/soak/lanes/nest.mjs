/**
 * NEST lane (SPEC-B v2 section 5.1; F15, F8, F13, F7 via O7a). Outer effect or computed bodies with
 * mode toggles set by ops (the probe-cursor2/3 shapes):
 *   child   P10  the outer's body creates a child effect whose first (nested) run disposes X
 *   nested  P7   the inner computed's body disposes X while the outer is suspended in its pull
 *   deep         disposal two frames deep (inner -> inner2)
 *   untrack P11  the outer reads its inner via untrack; the inner disposes X
 *   cb      P6   the inner retracks (drops x); x's onDisconnect disposes X
 *   self         the active frame disposes X (live cursor; retrack-dispose's case)
 *   odisp        a nested frame disposes the suspended OUTER observer (allocateLink gate)
 *   early   P8   any of the above, and the outer ends right after the action (severTail path)
 *   outer computed P9 (30% of outers; pulled at top level by the arming op)
 * X is the first live source of the outer's previous read set beyond its action slot (the saved cursor)
 * with p 0.6, else any live disposable signal. Every arming op bumps the outer's dedicated trigger t, so
 * the outer re-runs in that op and the one-shot action fires once. Plus recycle ops (registration ->
 * dispose target -> recreate -> observe, F7 Q1) and plain writes, creation, stops, disposals and
 * registrations. G6 is lifted: computeds read disposable signals.
 */

const MIX = Object.freeze({ arm: 40, set: 18, outer: 10, misc: 8, stop: 5, dispose: 5, recycle: 6, reg: 6, off: 2 });
const VARIANTS = Object.freeze({ plain: 3, untrack: 2, deep: 2, flip: 2, none: 1 });

function outerOps(g) {
    const ops = [];
    const t = g.sig({ role: 'trig', v: 0 });
    ops.push(t);
    const variant = g.weighted(VARIANTS);
    const pre = g.chance(0.4) ? [g.pick(g.leaves())] : [];
    // cov-off:saved-cursor-hazard twin: every outer also reads a fresh disposable BEFORE its action slot,
    // so a victim can be drawn from the already-read prefix (no cursor of any frame points past it)
    if (g.ruleOff('cursor-victim')) { const p = g.sig({ dis: true }); ops.push(p); pre.push(p.i); }
    const post = [];
    for (let k = 0; k < 3; k++) { const s = g.sig({ dis: true }); ops.push(s); post.push(s.i); }
    // G4: an extra shared disposable may not already be read by this body (post OR pre)
    if (g.chance(0.5)) { const ex = g.disposables().filter((d) => post.indexOf(d) === -1 && pre.indexOf(d) === -1); if (ex.length) post.push(g.pick(ex)); }
    let ic2 = -1, x = -1, reg = -1, ic = -1;
    if (variant === 'deep') { const c = g.comp({ k: 'inner', t: t.i, x: null, ic2: null, role: 'inner' }, false); ops.push(c); ic2 = c.i; }
    if (variant === 'flip') {
        const xs = g.sig({ role: 'flip' });
        ops.push(xs);
        x = xs.i;
    }
    if (variant !== 'none') {
        const c = g.comp({ k: 'inner', t: t.i, x: x >= 0 ? x : null, ic2: ic2 >= 0 ? ic2 : null, role: 'inner' }, false);
        ops.push(c);
        ic = c.i;
    }
    if (x >= 0) { const r = g.reg(x); ops.push(r); reg = r.r; }
    const isComp = g.chance(0.3);
    const spec = { k: 'outer', t: t.i, pre, ic: ic >= 0 ? ic : null, icU: variant === 'untrack', post, role: 'outer' };
    const o = isComp ? g.comp(spec, true) : g.eff(spec);
    ops.push(o);
    g.meta[o.i] = { variant, ic, ic2, x, reg, isComp, t: t.i, flipped: false };
    return ops;
}

function armOp(g) {
    const outers = g.nodes((nd) => nd.role === 'outer');
    if (outers.length === 0) return { o: 'seq', ops: outerOps(g) };
    const O = g.pick(outers);
    const m = g.meta[O];
    const modes = ['self'];
    if (!m.isComp) modes.push('child', 'child');
    if (m.ic >= 0) modes.push('nested', 'nested', 'odisp');
    if (m.ic2 >= 0) modes.push('deep');
    if (m.reg >= 0 && !m.flipped && g.M.regs[m.reg].live) modes.push('cb', 'cb');
    if (m.ic < 0 && !m.isComp) modes.push('odisp');
    let mode = g.pick(modes);
    const op = { o: 'arm', O, mode, x: -1, at: -1, child: -1, reg: -1, flip: -1, early: g.chance(0.3) ? 1 : 0, t: m.t, v: 0, pull: m.isComp ? 1 : 0 };
    const spec = g.M.n[O].spec;
    let X = -1;
    const twin = g.ruleOff('cursor-victim');
    if (mode === 'odisp') X = O;
    else if (twin && mode !== 'self') {
        // the twin: the victim is from the outer's already-read prefix (index < cursor), never ahead of it.
        // 'self' keeps its normal victim: the outer is the ACTIVE frame there (live cursor, not saved).
        const prefix = spec.pre.filter((s) => g.M.n[s].live && g.M.n[s].dis);
        if (prefix.length > 0) X = prefix[0];
    } else {
        const ahead = spec.post.filter((s) => g.M.n[s].live && g.M.n[s].dis);
        if (ahead.length > 0 && g.chance(0.6)) X = ahead[0];
        else { const ds = g.disposables(); if (ds.length > 0) X = g.pick(ds); }
    }
    if (X < 0) mode = op.mode = 'none';
    op.x = X;
    if (mode === 'child') op.child = g.reserve();
    else if (mode === 'nested') op.at = m.ic;
    else if (mode === 'deep') op.at = m.ic2;
    else if (mode === 'cb') { op.reg = m.reg; op.flip = m.ic; m.flipped = true; g.M.setMode(m.ic, 'flip', true); }
    else if (mode === 'odisp') { if (m.ic >= 0) op.at = m.ic; else op.child = g.reserve(); }
    g.M.setMode(O, 'early', op.early === 1);
    // the trigger MUST change t (Object.is), or the outer does not re-run and the mode change is unobserved
    const tv = g.M.n[m.t].v;
    op.v = (typeof tv === 'number' && Number.isInteger(tv) && tv >= 0) ? (tv + 1) % 100000 : 0;
    g.M.setValue(m.t, op.v);
    const ops = [op];
    if (mode !== 'none') {
        const wasDis = g.M.n[X].t === 's' && g.M.n[X].dis;
        g.M.kill(X);
        if (wasDis) ops.push(g.sig({ dis: true }));
    }
    return ops.length === 1 ? op : { o: 'seq', ops };
}

function miscOps(g) {
    if (g.chance(0.5)) {
        const pool = g.nodes((nd) => nd.t === 's' && (nd.role === 'leaf' || nd.dis));
        return g.comp(g.bodySpec(pool), false);
    }
    const pool = g.nodes((nd) => (nd.t === 's' && (nd.role === 'leaf' || nd.dis)) || (nd.t === 'c' && nd.role === 'comp'));
    const spec = g.bodySpec(pool, { fan: 1 + g.int(3) });
    spec.try = true;
    return g.eff(spec);
}

function init(g) {
    for (let k = 0; k < 6; k++) g.push(g.sig({}), true);
    for (let k = 0; k < 8; k++) g.push(g.sig({ dis: true }), true);
    for (let k = 0; k < 3; k++) g.push({ o: 'seq', ops: outerOps(g) }, true);
    for (let k = 0; k < 6; k++) g.push(miscOps(g), true);
    for (let k = 0; k < 2; k++) g.push(g.reg(g.pick(g.nodes((nd) => nd.t !== 'e'))), true);
}

function step(g) {
    switch (g.weighted(MIX)) {
        case 'arm': g.push(armOp(g)); return;
        case 'set': {
            const ss = g.nodes((nd) => nd.t === 's' && (nd.role === 'leaf' || nd.role === 'trig' || nd.dis));
            g.push(g.set(g.pick(ss), g.value()));
            return;
        }
        case 'outer': g.push({ o: 'seq', ops: outerOps(g) }); return;
        case 'misc': g.push(miscOps(g)); return;
        case 'stop': {
            const es = g.nodes((nd) => nd.t === 'e' && nd.role !== 'child');
            if (es.length > 2) { g.push(g.stop(g.pick(es))); return; }
            g.push({ o: 'read', is: [] });
            return;
        }
        case 'dispose': {
            const ds = g.disposables();
            if (ds.length === 0) { g.push(g.sig({ dis: true })); return; }
            g.push({ o: 'seq', ops: [g.disp(g.pick(ds)), g.sig({ dis: true })] });
            return;
        }
        case 'recycle': {
            const y = g.sig({ dis: true });
            const r = g.reg(y.i);
            const d = g.disp(y.i);
            const z = g.sig({ dis: true });
            const e = g.eff({ k: 'sum', d: [z.i, g.pick(g.leaves())], try: true, role: 'eff' });
            g.push({ o: 'seq', ops: [y, r, d, z, e] });
            return;
        }
        case 'reg': g.push(g.reg(g.pick(g.nodes((nd) => nd.t !== 'e')))); return;
        case 'off': {
            const live = [];
            for (let r = 0; r < g.M.regs.length; r++) if (g.M.regs[r] !== undefined && g.M.regs[r].live) live.push(r);
            if (live.length === 0) { g.push({ o: 'read', is: [] }); return; }
            g.push(g.unreg(g.pick(live)));
            return;
        }
    }
}

export const NEST = Object.freeze({
    name: 'NEST',
    needsCaps: Object.freeze(['disposeSignal', 'childEffects']),
    hardOracles: Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O7a']),
    required: Object.freeze(['saved-cursor-hazard', 'live-cursor-hazard', 'child-first-run-dispose', 'nested-computed-dispose', 'untrack-dispose',
        'outer-computed', 'early-exit-after-dispose', 'lifecycle-callback-dispose', 'lifecycle-dispose-recycle']),
    optional: Object.freeze(['dispose-outer-observer']),
    scenCaps: Object.freeze({
        'untrack-dispose': ['untrack'], 'lifecycle-callback-dispose': ['lifecycle'], 'lifecycle-dispose-recycle': ['lifecycle'],
        'child-first-run-dispose': ['childEffects'],
    }),
    mix: MIX,
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: '6 leaves, 8 disposable, 3 outers (+10% per step), 6 misc nodes, 2 registrations' }),
    flushPasses: null,
    // the twin removes ONLY the saved-cursor condition: same modes, victim drawn from the read prefix
    covOff: Object.freeze({ 'saved-cursor-hazard': 'cursor-victim' }),
    init,
    step,
});
