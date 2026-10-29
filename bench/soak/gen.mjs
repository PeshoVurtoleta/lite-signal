/**
 * @zakkster/lite-signal soak -- the seeded OP-SCRIPT GENERATOR (SPEC-B v2 section 4.3). Parity-pinned.
 *
 * generateWorld(desc, worldSeed, opts) returns a plain-JSON script { genVersion, lane, seed, large,
 * flushPasses, ops[] } BEFORE anything runs. Rule G0: the generator reads only its own SHADOW model
 * (model.mjs pure state: liveness from its own ops, the exact values of the signals only script ops
 * write, the node specs). It never sees an engine, so the same (lane, seed) gives the same script on every
 * kernel and on every engine, and a replay key is just (lane, cycle, seed). exec.mjs resolves nothing
 * from the engine either: an op whose target is dead at execution time is a no-op.
 *
 * Generator rules (by-design behaviour is a generator rule, never an oracle exception; header.genRules):
 *   I1   an effect writes only a signal whose rank > the max rank of its transitive read set (acyclic
 *        cascades; an effect never writes what it reads). Each write target has exactly one writer.
 *   I2   computed bodies never write. NEST bodies may dispose (P7-P9 shapes). Lifted for WIE only (unit 0s,
 *        D3 narrow v1): a computed WRITER C (spec.w target, optional spec.inc, spec.wu = write under untrack;
 *        Gen.writer) writes w := f(C's output). W1 rank(w) > the max rank of C's transitive read set (the I1
 *        rule; exec.mjs D4: a target that is not an earlier signal (forward / self / non-integer / non-signal)
 *        or is in C's own transitive read set fails closed). W2 one writer per target.
 *        W3 w is never set at top level and never disposed while its writer is live (role 'target').
 *   G4   no duplicate reads in one body (O5 slack 0).
 *   G5   chain depth <= MAX_DEPTH (200).
 *   G6   GRAPH / BATCH / ERROR computeds read only non-disposable signals. NEST lifts it.
 *   G7   cycle-bomb only in ERROR (flushPasses 8), its effects stopped in the same op.
 *   G8   lifecycle registrations target live handles only.
 *   G9   no destroy() outside the REGISTRY lane (lanes/registry.mjs owns rdestroy).
 *   G10  a world is a fresh registry (maxNodes 4096, grow). Exception G12 (CAPACITY lane, lanes/capacity.mjs): the
 *        lane seeds Gen.capacity { maxNodes, maxLinks, onCapacityExceeded }, the script carries it as `capacity`
 *        (emitted after flushPasses, ONLY when non-null: no other lane's script has the key) and exec.mjs passes it
 *        to open(); the lane keeps its core graph within maxNodes/2 - 2 live nodes and maxLinks/2 links.
 *   cov-off:<scenario>  switches off exactly the generator rule that can produce that scenario
 *        (lanes/<lane>.mjs covOff map); recorded in the header, never a release soak.
 *
 * COLD module.
 */

import { mulberry32 } from '../torture/helpers/index.mjs';
import { Model } from './model.mjs';
import { encodeValue, decodeValue, VALUE_POOL, specRefs, EQ_BOMB_CODE } from './kinds.mjs';

export const GEN_VERSION = 1;
export const GEN_RULES = Object.freeze(['I1', 'I2', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10']);
export const MAX_DEPTH = 200;
const CHECK_P = 0.4;

/** The capability block the generator's shadow model uses (equality and ownership only). */
const SHADOW_CAPS = Object.freeze({ equality: 'is', childEffects: 'parent-run' });

export class Gen {
    constructor(desc, seed, opts) {
        this.desc = desc;
        this.seed = seed >>> 0;
        this.rnd = mulberry32(this.seed);
        this.M = new Model(SHADOW_CAPS);
        this.ops = [];
        this.next = 0;
        this.nextReg = 0;
        this.covOff = opts && opts.covOff ? opts.covOff : null;
        this.large = false;
        this.flushPasses = null;
        this.capacity = null;   // G12: the CAPACITY lane's registry cfg; null on every other lane (no script key)
        this.meta = [];   // gen-only facts per node (variant data for NEST outers)
    }

    /* ---- randomness ---------------------------------------------------------------------------- */
    r() { return this.rnd(); }
    int(n) { return (this.rnd() * n) | 0; }
    chance(p) { return this.rnd() < p; }
    pick(a) { return a[(this.rnd() * a.length) | 0]; }
    /** Draw `k` distinct elements. */
    some(a, k) {
        const pool = a.slice();
        const out = [];
        while (out.length < k && pool.length > 0) out.push(pool.splice(this.int(pool.length), 1)[0]);
        return out;
    }
    /** A value code: 55% an int 0..99, else an adversarial pool value. */
    value() {
        return this.chance(0.55) ? this.int(100) : -(this.int(VALUE_POOL.length) + 1);
    }
    weighted(table) {
        let total = 0;
        for (const k in table) total += table[k];
        let x = this.rnd() * total;
        for (const k in table) { x -= table[k]; if (x < 0) return k; }
        return Object.keys(table)[0];
    }

    /** True when cov-off disables the generator rule `rule` (lanes map scenario -> rule). */
    ruleOff(rule) {
        if (this.covOff === null) return false;
        const m = this.desc.covOff[this.covOff];
        return m !== undefined && m === rule;
    }

    /* ---- shadow model queries (pure state only: G0) ------------------------------------------------ */
    nodes(pred) {
        const out = [];
        const n = this.M.n;
        for (let i = 0; i < n.length; i++) if (n[i] !== undefined && n[i].live && pred(n[i])) out.push(i);
        return out;
    }
    leaves() { return this.nodes((nd) => nd.t === 's' && nd.role === 'leaf' && !nd.dis); }
    disposables() { return this.nodes((nd) => nd.t === 's' && nd.dis); }
    vOf(i) { return encodeValue(this.M.n[i].v); }

    /** Static max rank over every branch of a spec (I1). */
    rankOf(i, memo) {
        const m = memo || new Map();
        if (m.has(i)) return m.get(i);
        const nd = this.M.n[i];
        let r = 0;
        if (nd.t === 's') r = nd.rank;
        else if (nd.spec !== null) for (const x of specRefs(nd.spec)) r = Math.max(r, this.rankOf(x, m));
        m.set(i, r);
        return r;
    }
    specRank(spec) {
        const memo = new Map();
        let r = 0;
        for (const x of specRefs(spec)) r = Math.max(r, this.rankOf(x, memo));
        return r;
    }
    /** Static depth (longest computed chain) of a spec (G5). */
    depthOf(i, memo) {
        const m = memo || new Map();
        if (m.has(i)) return m.get(i);
        const nd = this.M.n[i];
        let d = 0;
        if (nd.t === 'c') { for (const x of specRefs(nd.spec)) d = Math.max(d, this.depthOf(x, m)); d += 1; }
        m.set(i, d);
        return d;
    }
    /** Static signal cone of node i (every branch). */
    cone(i, memo) {
        const m = memo || new Map();
        if (m.has(i)) return m.get(i);
        const nd = this.M.n[i];
        const out = new Set();
        m.set(i, out);
        if (nd.t === 's') out.add(i);
        else if (nd.spec !== null) for (const x of specRefs(nd.spec)) for (const s of this.cone(x, m)) out.add(s);
        return out;
    }

    /* ---- op emitters: each updates the shadow and returns the op (callers push it) ------------------ */
    sig(o) {
        const i = this.next++;
        const v = o && o.v !== undefined ? o.v : this.value();
        const op = { o: 'sig', i, v };
        if (o && o.dis) op.dis = 1;
        if (o && o.rank) op.rank = o.rank;
        if (o && o.role && o.role !== 'leaf') op.role = o.role;
        if (o && o.eq) op.eq = 1;
        this.M.addSignal(i, decodeValue(v), { dis: !!(o && o.dis), rank: o && o.rank ? o.rank : 0, role: (o && o.role) || 'leaf' });
        return op;
    }
    comp(spec, pull) {
        const i = this.next++;
        this.M.addComputed(i, spec);
        const op = { o: 'comp', i, spec };
        if (pull) op.pull = 1;
        return op;
    }
    eff(spec) {
        const i = this.next++;
        this.M.addEffect(i, spec, -1);
        return { o: 'eff', i, spec };
    }
    set(i, v) {
        if (v !== EQ_BOMB_CODE) this.M.setValue(i, decodeValue(v));
        return { o: 'set', i, v };
    }
    stop(i) { this.M.kill(i); return { o: 'stop', i }; }
    disp(i) { this.M.kill(i); return { o: 'disp', i }; }
    reg(target) {
        const r = this.nextReg++;
        this.M.addReg(r, target);
        return { o: 'reg', r, i: target };
    }
    unreg(r) { this.M.offReg(r); return { o: 'off', r }; }

    /** Allocate a node index without creating it (a child effect created by a body at run time). */
    reserve() { return this.next++; }

    /**
     * WIE (I2 lifted): a computed WRITER over `spec`. W1: its target is a fresh signal (W2) of rank
     * specRank(spec) + 1, role 'target' (W3: never set at top level, never disposed). o: { inc, wu }.
     * Returns [targetOp, writerOp] (callers push them, target first).
     */
    writer(spec, o) {
        const w = this.sig({ role: 'target', rank: this.specRank(spec) + 1, v: 0 });
        spec.w = w.i;
        if (o && o.inc !== undefined) spec.inc = o.inc;
        if (o && o.wu) spec.wu = 1;
        return [w, this.comp(spec, false)];
    }

    /* ---- spec builders ------------------------------------------------------------------------------ */

    /**
     * A computed/effect body spec over `pool` (candidate refs). kinds: weights over sum/identity/select/
     * cond/hash; selectors: leaf signals for select. G4: refs distinct, selector not among them.
     */
    bodySpec(pool, o) {
        const opt = o || {};
        const kinds = opt.kinds || { sum: 3, identity: 2, select: 2.5, cond: 1.5, hash: 1 };
        let k = this.weighted(kinds);
        const fan = opt.fan || (2 + this.int(3));
        let d = this.some(pool, Math.max(1, fan));
        if (d.length === 0) return null;
        const spec = { k, d };
        if (k === 'select') {
            const sels = (opt.selectors || this.leaves()).filter((s) => d.indexOf(s) === -1);
            if (sels.length === 0 || d.length < 2) spec.k = 'sum';
            else spec.s = this.pick(sels);
        }
        if (spec.k === 'identity') spec.d = d.slice(0, 1);
        if (spec.k === 'cond' && d.length > 2) spec.d = d.slice(0, 2);
        if (opt.thr) spec.thr = true;
        return spec;
    }

    /* ---- the script --------------------------------------------------------------------------------- */

    push(op, init) {
        if (!init && this.chance(CHECK_P)) { op.chk = 1; op.cs = this.int(0x7fffffff); }
        this.ops.push(op);
        return op;
    }

    script() {
        if (this.capacity === null) {
            return {
                genVersion: GEN_VERSION, lane: this.desc.name, seed: this.seed, large: this.large, covOff: this.covOff,
                flushPasses: this.flushPasses, ops: this.ops,
            };
        }
        return {
            genVersion: GEN_VERSION, lane: this.desc.name, seed: this.seed, large: this.large, covOff: this.covOff,
            flushPasses: this.flushPasses, capacity: this.capacity, ops: this.ops,
        };
    }
}

/**
 * Generate one world's script. desc: a lane descriptor (lanes/index.mjs). opts: { steps, covOff, large }.
 * steps: a non-negative integer (default 400 when undefined; anything else throws RangeError before any work).
 * `large` defaults to the lane's own LARGE rule (1 world in LARGE_WORLD_EVERY, decided by the caller).
 */
export function generateWorld(desc, worldSeed, opts) {
    const o = opts || {};
    // undefined -> the default 400; 0 means 0 steps (null is not zero: null, NaN, negative, fractional throw)
    const steps = o.steps === undefined ? 400 : o.steps;
    if (!(Number.isInteger(steps) && steps >= 0)) throw new RangeError('generateWorld: steps must be a non-negative integer, got ' + String(o.steps));
    const g = new Gen(desc, worldSeed, o);
    g.large = o.large === true;
    desc.init(g);
    for (let s = 0; s < steps; s++) desc.step(g);
    return g.script();
}

/** Canonical JSON of a script (the determinism proof hashes this). */
export function scriptJson(script) {
    return JSON.stringify(script);
}
