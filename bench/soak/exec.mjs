/**
 * @zakkster/lite-signal soak -- the EXECUTOR: plays one world's op script against an engine (through an
 * adapter) and the naive model in lockstep, and runs the oracles (SPEC-B v2 sections 4.2, 5, 6).
 * Parity-pinned. Shared by the dev driver now and by main / replay / shrink (S1c-S1d).
 *
 * Lockstep rule: every engine mutation exec makes (a write, a create, a dispose, a registration) is
 * applied to the model at the same instant, whether it happens at top level, inside a body or inside a
 * lifecycle callback. The model never learns anything from an engine READ; reads are what get checked.
 *
 *   frame stack   one frame per user body on the stack (scenarios.mjs explains prev/reads/ok/inRead/nested)
 *   body builder  engine bodies call kinds.evalKind with a read that goes through the engine, checks O2,
 *                 and records the tracked links (O5) and the observation (O1e)
 *   guards        EVERY top-level engine call (and every write inside a body) runs in guard(): its escape
 *                 must equal the prediction (O6). The prediction is built from what actually escaped the
 *                 effect bodies that ran at the guard's own depth, plus a throw-in-batch token, a throwing
 *                 `equals` token, or an expected CycleError. A computed error that escapes without passing
 *                 through an effect body (F6) is therefore never predicted
 *   cycle error   (G7, O6 (iii)) where the CycleError surfaces depends on the kernel: a lite kernel that is no
 *                 controls.json control aborts at the creation of the effect that closes the write cycle
 *                 (creationAbort, from adapter.knownAs()); a control, or another engine, at the cyc:1 set.
 *                 Both predictions come from the model's write-cycle census (model.writeCycleNew / writeCycle);
 *                 the model kill stays keyed on the ACTUAL escape, never on the prediction
 *   taint         model.kill() taints observers that read a disposed node; a run in progress during a
 *                 disposal is tainted until it ends (taint clears only for a run entirely after it) ONLY if
 *                 that run already read a killed node, or a live computed tainted after the kill (b70 D6 V1);
 *                 a run that read neither before the kill sees what the model sees and is not tainted by this disposal
 *   at rest       O1e + O4 every op, O5 every op, O1c when the op's chk bit is set and at world end
 *   wie writer    (WIE, gen.mjs I2 lifted) a computed whose spec carries w writes w := f(its output) through
 *                 write() after its body returns (spec.wu: under untrack), exactly like an effect writer. D4: a
 *                 target that is not an earlier signal (forward / self / non-integer / non-signal) or is in its
 *                 own transitive read set fails closed at creation (unmodelled)
 *   batch         OB inline: an effect that ALREADY ran must not re-run while a batch is open (batchDepth > 0;
 *                 a first run inside a batch is allowed, p2). OB is PERFORMED once per outermost batch whose
 *                 close-flush re-ran >= 1 effect (a witnessed deferral); a batch with nothing to defer is
 *                 not evidence
 *
 * A world stops at the first op with any failure; every oracle that fired on that op is reported.
 * COLD module.
 */

import { SoakThrow, ERR, evalKind, decodeValue, EQ_BOMB, toNum, specRefs } from './kinds.mjs';
import { Model } from './model.mjs';
import * as O from './oracles.mjs';
import { Detectors } from './scenarios.mjs';
import { laneByName } from './lanes/index.mjs';
import { mulberry32, shuffle } from '../torture/helpers/index.mjs';

const NONE = Symbol('none');
const END_CHECK_SALT = 0x5bd1e995;

/** Oracles counted when PERFORMED (a skipped check is never counted as one). */
export const CHECK_NAMES = Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O7a', 'OB']);
/** Oracles that skip tainted nodes; each skip is counted per oracle (S1c gates a taint-skip ratio). */
export const SKIP_NAMES = Object.freeze(['O1c', 'O1e', 'O2', 'O4']);
const COUNTER_CAP = 0x3FFFFFFF;   // per-world counters stay Smi (S7: [2^30, 2^31) boxes on pointer-compressed V8)

/**
 * Run one world. adapter: adapters/lite.mjs (or any contract-valid adapter). script: gen.mjs output.
 * Returns { failure: null | {step, op, fails[], scen[]}, scen: {name: n}, checks: {...}, ops, opsByClass }.
 */
export function runWorld(adapter, script, opts) {
    const x = new Exec(adapter, script, opts || {});
    return x.run();
}

/**
 * O6 (iii) creation prediction (DELTA 4b-v2 T3): true when a write-cycle creation must abort in effect()
 * (a lite kernel that matches no controls.json control). Fails closed BEFORE any state: a lite adapter
 * without knownAs(), a knownAs() that throws (controls.json unreadable) or returns neither null nor a name.
 * opts.creationAbort: test-only override (test/57); it must be a boolean, and the identity is still verified.
 */
function creationAbortOf(ad, opts) {
    const o = Object.hasOwn(opts, 'creationAbort') ? opts.creationAbort : undefined;   // own key only (no prototype chain)
    if (o !== undefined && typeof o !== 'boolean') {
        throw new TypeError('exec: opts.creationAbort must be a boolean, got ' + (o === null ? 'null' : typeof o));
    }
    let lite = false;
    if (ad.name === 'lite') {
        if (typeof ad.knownAs !== 'function') throw new TypeError('exec: lite adapter has no knownAs() (kernel identity unverified)');
        const k = ad.knownAs();
        if (k !== null && !(typeof k === 'string' && k.length > 0)) {
            throw new TypeError('exec: lite adapter knownAs() must return null or a control name, got ' + typeof k);
        }
        lite = k === null;
    }
    return o === undefined ? lite : o;
}

/** exec's own op names. apply() matches them first, so a lane-owned op can never shadow one (laneOpsOf rejects it). */
const CORE_OPS = Object.freeze(['sig', 'comp', 'eff', 'set', 'burst', 'read', 'stop', 'disp', 'batch', 'reg', 'off', 'arm', 'seq']);

/**
 * The lane-owned op handlers of a world (S3 R0): the lanes/index.mjs descriptor.ops of script.lane, resolved ONCE per
 * world; null when the lane owns none or the script names no rostered lane. apply() hands an op it does not know to
 * ops[op.o](exec, op, k); an op no lane owns throws exactly as before. opts.laneOps: test-only override (test/74),
 * null or a plain object. Fails closed BEFORE any state: a handler that is not a function, or a key naming a core op.
 */
function laneOpsOf(script, opts) {
    let ops;
    if (Object.hasOwn(opts, 'laneOps')) ops = opts.laneOps;   // own key only (no prototype chain)
    else {
        const d = laneByName(script.lane);
        ops = d === null || d.ops === undefined ? null : d.ops;
    }
    if (ops === null) return null;
    if (typeof ops !== 'object' || Array.isArray(ops)) {
        throw new TypeError('exec: lane ops must be null or a plain object, got ' + (Array.isArray(ops) ? 'an array' : typeof ops));
    }
    for (const name of Object.keys(ops)) {
        if (CORE_OPS.indexOf(name) !== -1) throw new TypeError('exec: lane op ' + name + ' shadows a core op');
        if (typeof ops[name] !== 'function') throw new TypeError('exec: lane op ' + name + ' is not a function');
    }
    return ops;
}

class Exec {
    constructor(adapter, script, opts) {
        this.creationAbort = creationAbortOf(adapter, opts);
        this.laneOps = laneOpsOf(script, opts);
        this.unmodelled = null;   // pin (i) sticky: a batch / body guard must not swallow it (run() rethrows)
        this.ad = adapter;
        this.caps = adapter.caps;
        this.script = script;
        this.opts = opts;
        this.W = adapter.open({ maxFlushPasses: script.flushPasses });
        this.M = new Model(adapter.caps);
        this.H = [];
        this.RH = [];
        this.frames = [];
        this.guards = [];
        this.cbDepth = 0;
        this.topRead = -1;
        this.batchDepth = 0;
        this.bodies = 0;
        this.actions = new Map();
        this.regActions = new Map();
        this.ran = new Set();
        this.D = new Detectors(this);
        this.checks = { O1c: 0, O1e: 0, O2: 0, O4: 0, O5: 0, O6: 0, O7a: 0, OB: 0 };
        this.skipTainted = { O1c: 0, O1e: 0, O2: 0, O4: 0 };
        this.gateHits = { batchTokenEscaped: 0 };   // guards whose escape carried the throw-in-batch token
        this.effReruns = 0;    // effect re-runs (runs > 0) in this world, capped at COUNTER_CAP (OB evidence)
        this.closeMark = -1;   // effReruns when the outermost batch's callback returned; -1 = no batch closing
        this.stepFails = [];
        this.opsRun = 0;
        this.opsByClass = Object.create(null);
        this.trace = opts.trace === true ? [] : null;
    }

    /** Count one performed check / one taint skip (capped: never leaves Smi range). */
    did(o) { if (this.checks[o] < COUNTER_CAP) this.checks[o]++; }
    skipped(o) { if (this.skipTainted[o] < COUNTER_CAP) this.skipTainted[o]++; }

    failF(f) {
        for (const g of this.stepFails) if (g.oracle === f.oracle && g.sig === f.sig) return;
        this.stepFails.push(f);
    }

    engineError(e, where) {
        const leaf = this.W.normalizeEscape(e)[0];
        this.failF({ oracle: 'O6', sig: O.escapeSig(leaf), detail: (where + ': ' + (leaf.token || (leaf.ctor + ': ' + leaf.message))).slice(0, 240) });
    }

    /* ---- the world loop -------------------------------------------------------------------------- */

    run() {
        const ops = this.script.ops;
        let failure = null;
        for (let k = 0; k < ops.length; k++) {
            const op = ops[k];
            this.D.beginStep();
            this.ran.clear();
            this.stepFails = [];
            this.opsRun++;
            this.opsByClass[op.o] = (this.opsByClass[op.o] || 0) + 1;
            if (this.trace !== null) this.trace.push(k + ' ' + JSON.stringify(op));
            this.apply(op, k);
            if (this.unmodelled !== null) throw this.unmodelled;
            this.actions.clear();
            this.regActions.clear();
            this.atRest(op);
            if (this.stepFails.length > 0) {
                failure = { step: k, op: op.o, fails: this.stepFails, scen: Array.from(this.D.step) };
                break;
            }
        }
        if (failure === null) {
            this.D.beginStep();
            this.stepFails = [];
            this.o1c((this.script.seed ^ END_CHECK_SALT) >>> 0);
            if (this.stepFails.length > 0) failure = { step: ops.length, op: 'end', fails: this.stepFails, scen: Array.from(this.D.step) };
        }
        // teardown: registrations off, everything disposed, residue must be 0 / 0 (O5)
        for (let r = 0; r < this.M.regs.length; r++) if (this.M.regs[r] !== undefined) this.M.offReg(r);
        let residue = null;
        let closeErr = NONE;
        try { residue = this.W.close(); } catch (e) { closeErr = e; }
        if (failure === null) {
            this.stepFails = [];
            this.did('O5');   // the teardown residue check (counted like the at-rest O5: before close()'s outcome is read)
            if (closeErr !== NONE) this.engineError(closeErr, 'close()');
            else { const f = O.checkTeardown(residue); if (f !== null) this.failF(f); }
            if (this.stepFails.length > 0) failure = { step: ops.length, op: 'teardown', fails: this.stepFails, scen: [] };
        }
        return {
            failure, scen: this.D.counts, checks: this.checks, skipTainted: this.skipTainted, gateHits: this.gateHits,
            ops: this.opsRun, opsByClass: this.opsByClass,
            trace: this.trace,
        };
    }

    apply(op, k) {
        switch (op.o) {
            case 'sig': this.createSignal(op); break;
            case 'comp': this.createComputed(op); break;
            case 'eff': this.createEffect(op); break;
            case 'set': this.setTop(op.i, op.v, op.cyc === 1); break;
            case 'burst': for (const v of op.vs) this.setTop(op.i, v, false); break;
            case 'read': for (const i of op.is) this.readCheck(i, op.u === 1); break;
            case 'stop':
            case 'disp': this.guard(() => this.disposeIdx(op.i)); break;
            case 'batch': this.guard((g) => this.runBatch(op.body, op.thr === 1, g, k)); break;
            case 'reg': this.register(op); break;
            case 'off': this.unregister(op); break;
            case 'arm': this.arm(op); break;
            case 'seq': for (const s of op.ops) this.apply(s, k); break;
            default: this.laneOp(op, k);
        }
    }

    /** An op exec does not know: the lane's own handler (laneOpsOf), else the unknown-op throw. */
    laneOp(op, k) {
        const ops = this.laneOps;
        if (ops === null || !Object.hasOwn(ops, op.o)) throw new Error('exec: unknown op ' + op.o);
        ops[op.o](this, op, k);
    }

    /* ---- guarded calls (O6) ---------------------------------------------------------------------- */

    guard(fn, cycle) {
        const g = { base: this.frames.length, thrown: [], eq: [], batchTok: null, cycle: cycle === true };
        this.guards.push(g);
        let esc = NONE;
        try { fn(g); } catch (e) { esc = e; }
        this.guards.pop();
        this.did('O6');
        const got = esc === NONE ? [] : this.W.normalizeEscape(esc);
        if (esc !== NONE && got.length === 0) {
            this.failF({ oracle: 'O6', sig: 'escape-empty', detail: 'an escape normalized to zero leaves: ' + String(esc).slice(0, 160) });
        }
        if (this.trace !== null && esc !== NONE) this.trace.push('    escape at depth ' + g.base + ': ' + JSON.stringify(got));
        const pred = [];
        for (const e of g.thrown) for (const leaf of this.W.normalizeEscape(e)) if (leaf.token !== undefined) pred.push(leaf.token);
        // batch(fn): fn threw the batch token. It is ALWAYS predicted (SPEC-B 6, O6 (ii)), together with any
        // effect-body throw of the close-flush: an engine whose close-flush error replaces the user's error
        // LOSES it (F22) and fails here as expected-escape-missing. No allowance.
        if (g.batchTok !== null) pred.push(g.batchTok);
        for (const t of g.eq) pred.push(t);
        for (const f of O.checkEscape(pred, got, g.cycle ? O.EXPECT_CYCLE : O.EXPECT_NONE)) this.failF(f);
        if (g.batchTok !== null) for (const leaf of got) if (leaf.token === g.batchTok) { this.gateHits.batchTokenEscaped++; break; }
        this.D.onEscape(g, got);
        return esc;
    }

    /** An effect body escaped with err: attribute it to the innermost guard at the frame's own depth. */
    attribute(f, err) {
        for (let k = this.guards.length - 1; k >= 0; k--) {
            if (this.guards[k].base === f.depth) { this.guards[k].thrown.push(err); return; }
        }
    }

    bombEquals(i) {
        return (a, b) => {
            if (b === EQ_BOMB) {
                const t = new SoakThrow('equals', i);
                if (this.guards.length > 0) this.guards[this.guards.length - 1].eq.push(t.token);
                this.D.count('throwing-equals');
                throw t;
            }
            return Object.is(a, b);
        };
    }

    /* ---- node creation --------------------------------------------------------------------------- */

    createSignal(op) {
        const v = decodeValue(op.v);
        this.M.addSignal(op.i, v, { dis: op.dis === 1, rank: op.rank | 0, role: op.role });
        this.D.onCreate(op.i, 's');
        const sopts = op.eq === 1 ? { equals: this.bombEquals(op.i) } : undefined;
        this.guard(() => { this.H[op.i] = this.W.signal(v, sopts); });
    }

    createComputed(op) {
        this.M.addComputed(op.i, op.spec);
        const i = op.i;
        // D4 (WIE): a computed writer whose target is not a signal, or sits in the writer's own transitive read
        // set (static, every branch), is outside the model (W1 broken): fail closed before the engine sees it.
        // A target index with no node writes nothing, as write() already does -- but only for an integer w < i (an
        // earlier node the shrinker removed). A forward, self, negative, non-integer or non-numeric target fails
        // closed here: only an integer 0 <= w < i reaches the next arm.
        const w = op.spec.w;
        if (w !== undefined && w !== null && !(Number.isInteger(w) && w >= 0 && w < i)) {
            this.unmodelled = new Error('exec: unmodelled computed writer: computed#' + i + ' writes #' + w +
                ', which is not an earlier node (forward, self, negative, non-integer or non-numeric target; W1)');
            throw this.unmodelled;
        }
        if (w !== undefined && w !== null && this.M.n[w] !== undefined) {
            if (this.M.n[w].t !== 's' || this.readSet(op.spec).has(w)) {
                this.unmodelled = new Error('exec: unmodelled computed writer: computed#' + i + ' writes #' + w +
                    (this.M.n[w].t !== 's' ? ', which is not a signal' : ', which is in its own transitive read set (W1)'));
                throw this.unmodelled;
            }
        }
        this.D.onCreate(i, 'c');
        this.guard(() => { this.H[i] = this.W.computed(() => this.runBody(i)); });
        if (op.pull === 1) this.readCheck(i, false);
    }

    createEffect(op) {
        const i = op.i;
        this.M.addEffect(i, op.spec, -1);
        // pin (i): a write-cycle creation is predicted only at top level; inside a batch or a body the abort
        // point is unmodelled. On a control (creationAbort false) it is legal and the set predicts it.
        let cycle = false;
        if (this.creationAbort && this.M.writeCycleNew(i)) {
            if (this.batchDepth > 0 || this.frames.length > 0) {
                this.unmodelled = new Error('exec: unmodelled creation cycle: effect#' + i + ' closes a write cycle at batch depth ' + this.batchDepth + ', frame depth ' + this.frames.length);
                throw this.unmodelled;
            }
            cycle = true;
        }
        this.D.onCreate(i, 'e');
        const nd = this.M.n[i];
        const before = nd.runs;
        const esc = this.guard(() => { this.H[i] = this.W.effect(() => { this.runBody(i); }); }, cycle);
        if (esc !== NONE && nd.live) this.M.kill(i);   // a throwing first run disposes it (p3)
        this.D.onEffectCreated(this.batchDepth > 0, nd.runs > before);
    }

    /** Static transitive read set of a spec over the model's specs (every branch; D4). Cold DFS. */
    readSet(spec) {
        const out = new Set();
        const stack = specRefs(spec);
        while (stack.length > 0) {
            const r = stack.pop();
            if (out.has(r)) continue;
            out.add(r);
            const nd = this.M.n[r];
            if (nd !== undefined && nd.t === 'c' && nd.spec !== null) for (const x of specRefs(nd.spec)) stack.push(x);
        }
        return out;
    }

    /** Inside a parent body (NEST): an owned child effect whose first run disposes x. */
    createChild(ci, parent, x) {
        this.M.addEffect(ci, { k: 'child', role: 'child' }, parent);
        this.D.onCreate(ci, 'e');
        this.actions.set(ci, () => this.disposeIdx(x));
        this.H[ci] = this.W.effect(() => { this.runBody(ci); });
    }

    /* ---- writes ---------------------------------------------------------------------------------- */

    setTop(i, code, cyc) {
        const nd = this.M.n[i];
        if (nd === undefined || nd.t !== 's' || this.H[i] === undefined) return;
        // pin (iii): cyc:1 predicts a CycleError only while the model still holds the write cycle (on a
        // creationAbort kernel the creation already aborted and the escape killed the closing effect)
        const cycle = cyc && this.M.writeCycle(i);
        if (cyc && !cycle && !this.creationAbort) {
            throw new Error('exec: unmodelled cycle set: signal#' + i + ' carries cyc:1 but the model holds no write cycle through it');
        }
        const v = decodeValue(code);
        const old = nd.live ? nd.v : undefined;
        const bomb = v === EQ_BOMB;
        const changed = nd.live && !bomb && !Object.is(old, v);
        if (nd.live && !bomb) this.M.setValue(i, v);
        if (nd.live && !bomb) this.D.onWrite(i, old, v, changed, true);
        this.guard(() => this.W.set(this.H[i], v), cycle);
        if (bomb && nd.live) {
            let now;
            try { now = this.W.peek(this.H[i]); } catch (e) { this.engineError(e, 'peek after throwing equals'); return; }
            if (!Object.is(now, nd.v)) this.failF({ oracle: 'O6', sig: 'equals-mutated', detail: 'signal#' + i + ' changed although its equals threw' });
        }
    }

    /** A write from inside a body (I1 effect writes, cycle-bomb, WIE computed writers). Guarded: a nested flush's escape is checked here. */
    write(w, v) {
        const nd = this.M.n[w];
        if (nd === undefined || !nd.live) return;
        const old = nd.v;
        this.M.setValue(w, v);
        this.D.onWrite(w, old, v, !Object.is(old, v), false);
        this.guard(() => this.W.set(this.H[w], v));
    }

    /* ---- batch ----------------------------------------------------------------------------------- */

    runBatch(body, thr, g, k) {
        const outer = this.batchDepth === 0;
        try {
            this.W.batch(() => {
                this.batchDepth++;
                const depth = this.batchDepth;
                this.D.onBatchEnter(depth);
                let wrote = false;
                try {
                    for (const s of body) if (this.applySub(s, g, k)) wrote = true;
                    if (thr) {
                        const t = new SoakThrow('batch', k);
                        g.batchTok = t.token;
                        this.D.onBatchThrow(wrote);
                        throw t;
                    }
                } finally {
                    this.batchDepth--;
                    this.D.onBatchExit(depth, wrote);
                    if (outer && depth === 1) this.closeMark = this.effReruns;   // the close-flush starts after this
                }
            });
        } finally {
            // OB performed: >= 1 effect re-ran in this batch's close-flush (a deferral the engine really made)
            if (outer) {
                if (this.closeMark >= 0 && this.effReruns > this.closeMark) this.did('OB');
                this.closeMark = -1;
            }
        }
    }

    applySub(s, g, k) {
        switch (s.o) {
            case 'set': {
                const nd = this.M.n[s.i];
                if (nd === undefined || !nd.live || this.H[s.i] === undefined) return false;
                const v = decodeValue(s.v);
                const old = nd.v;
                this.M.setValue(s.i, v);
                this.D.onBatchWrite(s.i, old, v);
                this.D.onWrite(s.i, old, v, !Object.is(old, v), false);
                this.W.set(this.H[s.i], v);
                return true;
            }
            case 'read':
                for (const i of s.is) { this.readCheck(i, false); this.D.onMidRead(i); }
                return false;
            case 'eff':
                this.createEffect(s);
                return false;
            case 'batch': {
                let wrote = false;
                this.W.batch(() => {
                    this.batchDepth++;
                    const depth = this.batchDepth;
                    this.D.onBatchEnter(depth);
                    try {
                        for (const t of s.body) if (this.applySub(t, g, k)) wrote = true;
                    } finally {
                        this.batchDepth--;
                        this.D.onBatchExit(depth, wrote);
                    }
                });
                return wrote;
            }
            default: throw new Error('exec: unknown batch sub-op ' + s.o);
        }
    }

    /* ---- disposal -------------------------------------------------------------------------------- */

    disposeIdx(j) {
        const nd = this.M.n[j];
        if (nd === undefined || !nd.live || this.H[j] === undefined) return;
        this.D.onDispose(j);
        for (const f of this.frames) {
            if (f.prev !== null) {
                const at = f.prev.indexOf(j);
                if (at !== -1) { f.prev = f.prev.slice(); f.prev.splice(at, 1); }
            }
            const ar = f.reads.indexOf(j);
            if (ar !== -1) f.reads.splice(ar, 1);
        }
        const dead = this.M.kill(j);
        // V1 (b70 D6): taint an in-flight run only if its reads so far hold a victim, or a live computed that
        // is tainted after the kill. taintRun stays OR-accumulated; one tainted() memo for the whole call.
        if (this.frames.length !== 0) {
            const tm = new Map();
            for (const f of this.frames) {
                const seen = f.seen;
                for (let k = 0; k < seen.length; k++) {
                    const r = seen[k].r;
                    if (dead.indexOf(r) !== -1) { f.taintRun = true; break; }
                    const sn = this.M.n[r];
                    if (sn !== undefined && sn.t === 'c' && sn.live && this.M.tainted(r, tm)) { f.taintRun = true; break; }
                }
            }
        }
        nd.dying = true;
        try { this.W.dispose(this.H[j]); } finally { nd.dying = false; }
    }

    /* ---- lifecycle registrations (O7a) ----------------------------------------------------------- */

    register(op) {
        const tn = this.M.n[op.i];
        if (tn === undefined || !tn.live || this.H[op.i] === undefined) return;
        this.M.addReg(op.r, op.i);
        const r = op.r;
        this.guard(() => {
            this.RH[r] = this.W.lifecycle(this.H[op.i], { onConnect: this.cb(r, 'onConnect'), onDisconnect: this.cb(r, 'onDisconnect') });
        });
    }

    unregister(op) {
        if (this.RH[op.r] === undefined) return;
        this.M.offReg(op.r);
        this.guard(() => this.RH[op.r]());
    }

    cb(r, kind) {
        return () => {
            this.cbDepth++;
            try {
                this.did('O7a');
                const f = O.checkFire(this.M, r, kind);
                if (f !== null) this.failF(f);
                const a = this.regActions.get(r);
                if (a !== undefined) { this.regActions.delete(r); a(); }
            } finally {
                this.cbDepth--;
            }
        };
    }

    /* ---- NEST arming ------------------------------------------------------------------------------ */

    arm(op) {
        const M = this.M;
        const on = M.n[op.O];
        if (on !== undefined && on.live) {
            const early = op.early === 1;
            if (on.mode.early !== early) M.setMode(op.O, 'early', early);
            if (op.flip >= 0 && M.n[op.flip] !== undefined && M.n[op.flip].live && !M.n[op.flip].mode.flip) M.setMode(op.flip, 'flip', true);
            const x = op.x;
            if (op.child >= 0) this.actions.set(op.O, () => this.createChild(op.child, op.O, x));
            else if (op.reg >= 0) this.regActions.set(op.reg, () => this.disposeIdx(x));
            else if (op.at >= 0) this.actions.set(op.at, () => this.disposeIdx(x));
            else if (x >= 0) this.actions.set(op.O, () => this.disposeIdx(x));
        }
        this.setTop(op.t, op.v, false);
        if (op.pull === 1) this.readCheck(op.O, false);
    }

    /* ---- bodies ----------------------------------------------------------------------------------- */

    runBody(i) {
        const M = this.M;
        const nd = M.n[i];
        const frames = this.frames;
        const parent = frames.length > 0 ? frames[frames.length - 1] : null;
        if (parent !== null && parent.inRead !== -1) parent.nested = true;
        let pre = 0;   // 1: pulled by an effect pre-walk (flush, no body frame); 2: pulled by a computed pre-walk
        if (nd.t === 'c') {
            this.bodies++;
            if (parent !== null) { if (parent.inRead !== i) pre = 2; }
            else if (this.topRead === -1) pre = 1;
            else if (this.topRead !== i) pre = 2;
        }
        if (nd.t === 'e' && nd.runs > 0) {
            M.killChildren(i);
            if (this.effReruns < COUNTER_CAP) this.effReruns++;
            if (this.batchDepth > 0) this.failF(O.checkBatchRun(i, this.batchDepth));   // OB: a re-run inside an open batch
        }
        let prev = null;
        if (nd.links !== null) {
            prev = [];
            for (const r of nd.links) if (M.n[r] !== undefined && M.n[r].live) prev.push(r);
        }
        const f = {
            i, t: nd.t, prev, reads: [], seen: [], ok: true, inRead: -1, inReadU: false, nested: false,
            first: nd.runs === 0, taintRun: false, depth: frames.length, pre, hazard: false, hazardAt: -1, wu: 0,
        };
        frames.push(f);
        nd.runs++;
        this.ran.add(i);
        const action = this.actions.get(i);
        if (action !== undefined) this.actions.delete(i);
        const ctx = { early: nd.mode.early, flip: nd.mode.flip, action: action === undefined ? null : action };
        let out, err = NONE;
        try {
            out = evalKind(nd.spec, this.reader(f, nd), i, ctx);
            if (nd.t === 'e' && nd.spec.w !== undefined && nd.spec.w !== null) {
                this.write(nd.spec.w, nd.spec.inc !== undefined ? (toNum(out) + nd.spec.inc) | 0 : out);
            } else if (nd.t === 'c' && nd.spec.w !== undefined && nd.spec.w !== null) {
                // WIE computed writer: same value rule as the effect writer; wu = the write runs under untrack.
                // The untrack branch is wrapper coverage: engine-equivalent on the live engine (Signal.js:1095,
                // markDownstreamInEval writer = observer else owner = this computed either way). f.wu marks it.
                const wv = nd.spec.inc !== undefined ? (toNum(out) + nd.spec.inc) | 0 : out;
                if (nd.spec.wu === 1) this.W.untrack(() => {
                    f.wu = 1; try { this.write(nd.spec.w, wv); } finally { f.wu = 0; }
                });
                else this.write(nd.spec.w, wv);
            }
        } catch (e) {
            err = e;
        }
        frames.pop();
        const prevOut = nd.out, prevThrew = nd.threw;
        nd.links = f.reads;
        nd.seen = f.seen;
        nd.taint = f.taintRun;
        nd.threw = err !== NONE;
        nd.out = err === NONE ? out : err;
        this.D.onFrameEnd(f, nd, prevOut, prevThrew, err !== NONE);
        if (err !== NONE) {
            if (nd.t === 'e') this.attribute(f, err);
            throw err;
        }
        return out;
    }

    reader(f, nd) {
        const M = this.M, W = this.W, H = this.H;
        const tryMode = nd.t === 'e' && nd.spec.try === true;
        return (ref, untracked) => {
            const tn = M.n[ref];
            if (tn === undefined || H[ref] === undefined) { f.seen.push({ r: ref, v: undefined }); return undefined; }
            const u = untracked === true;
            if (!u && tn.live && M.n[f.i].live && tn.t !== 'e') {
                const pos = f.reads.length;
                if (f.ok && f.prev !== null && pos < f.prev.length && f.prev[pos] !== ref) f.ok = false;
                f.reads.push(ref);
                this.D.onTrackedRead(f, ref);
            }
            f.inRead = ref;
            f.inReadU = u;
            f.nested = false;
            let v, threw = false;
            try {
                v = u ? W.untrack(() => W.read(H[ref])) : W.read(H[ref]);
            } catch (e) {
                v = e;
                threw = true;
            }
            f.inRead = -1;
            f.inReadU = false;
            if (threw && !(v instanceof SoakThrow)) {
                this.engineError(v, 'body#' + f.i + ' read #' + ref);
                throw v;
            }
            this.o2(ref, v, f.i);
            f.seen.push({ r: ref, v });
            if (threw) {
                if (tryMode) return ERR;
                throw v;
            }
            return v;
        };
    }

    /** O2 for one body read. One check call = one fresh memo (SPEC-B 4.1: no cache across checks). */
    o2(ref, v, reader) {
        const tn = this.M.n[ref];
        if (tn.t === 'c' && tn.live && this.M.tainted(ref, new Map())) { this.skipped('O2'); return; }
        this.did('O2');
        const f = O.checkRead(this.M, ref, v, new Map(), reader);
        if (f !== null) this.failF(f);
    }

    /* ---- top-level reads + at-rest oracles -------------------------------------------------------- */

    /** A top-level read of node i, compared with the model (O1c family). Returns the bodies it ran, or -1. */
    readCheck(i, untracked) {
        const nd = this.M.n[i];
        if (nd === undefined || this.H[i] === undefined || nd.t === 'e') return -1;
        const b0 = this.bodies;
        const prevTop = this.topRead;
        this.topRead = i;
        let got, threw = false;
        try {
            got = untracked ? this.W.untrack(() => this.W.read(this.H[i])) : this.W.read(this.H[i]);
        } catch (e) {
            got = e;
            threw = true;
        } finally {
            this.topRead = prevTop;
        }
        if (threw && !(got instanceof SoakThrow)) { this.engineError(got, 'top-level read of #' + i); return -1; }
        if (nd.t === 'c' && nd.live && this.M.tainted(i, new Map())) { this.skipped('O1c'); return this.bodies - b0; }
        this.did('O1c');
        const f = O.checkComputed(this.M, i, got, new Map());
        if (f !== null) this.failF(f);
        return this.bodies - b0;
    }

    o1c(seed) {
        const M = this.M;
        const order = [];
        for (let k = 0; k < M.n.length; k++) if (M.n[k] !== undefined && M.n[k].live && M.n[k].t === 'c') order.push(k);
        shuffle(mulberry32(seed), order);
        for (const i of order) {
            if (!M.n[i].live) continue;
            if (M.tainted(i, new Map())) { this.skipped('O1c'); continue; }
            this.D.beforeCheckRead(i);
            const bodies = this.readCheck(i, false);
            if (bodies >= 0) this.D.afterCheckRead(i, bodies);
        }
    }

    atRest(op) {
        const M = this.M;
        this.D.endOp();
        const memo = new Map();   // one at-rest pass = one check call; no model mutation happens inside it
        const tm = new Map();
        const neverRan = new Set();   // reported by O4 this pass; O5 does not count the same root cause twice
        for (let k = 0; k < M.n.length; k++) {
            const nd = M.n[k];
            if (nd === undefined || !nd.live || nd.t !== 'e') continue;
            const r = O.checkEffect(M, k, this.ran.has(k), memo, tm);
            for (const o of ['o1e', 'o4']) {
                const name = o === 'o1e' ? 'O1e' : 'O4';
                if (r[o] === 'done') this.did(name);
                else if (r[o] === 'skip') this.skipped(name);
            }
            if (r.fail !== null) this.failF(r.fail);
            if (r.neverRan === true) neverRan.add(k);
        }
        if (this.caps.links === 'stats') {
            this.did('O5');
            let s = null;
            try { s = this.W.stats(); } catch (e) { this.engineError(e, 'stats()'); }
            if (s !== null) for (const f of O.checkCounts(M, s, neverRan)) this.failF(f);
        }
        if (op.chk === 1) this.o1c(op.cs >>> 0);
    }
}
