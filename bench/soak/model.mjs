/**
 * @zakkster/lite-signal soak -- the NAIVE reference model (SPEC-B v2 section 4.1). Parity-pinned.
 *
 * Hard rule (the naivety pin, enforced by test/43-soak-model): nothing here remembers a computed value
 * across checks, and nothing here numbers changes. val() recomputes from the leaves on every call; the only
 * memo lives for ONE check call and is owned by the caller. An oracle that re-walked the engine's own
 * bookkeeping would share its errors (S14).
 *
 * State, one table `n[]` indexed by script node index (signals, computeds and effects share it):
 * Model parameter: caps.childEffects only (equality is Object.is in exec's body code and kinds.sameValue).
 *
 *   pure     (written by script ops, read by the generator):  t, live, v, dis, rank, role, spec, mode,
 *                                                              parent, children, cl; regs[] {target, live}; fired
 *   observed (written by exec.mjs from engine body runs; the generator NEVER reads these, rule G0):
 *            runs, links (tracked live reads of the last completed run), seen ([{r, v}] every read of the
 *            last run, in order), taint, out, threw
 *   sch      (S3 R4c, lanes/scheduler.mjs) 1 = an effect created with a scheduler (its runs are deferred to the
 *            lane's deliveries; its first run too: p2 relaxed), 0 = every other node (every other lane)
 *
 * Rules folded in from TASK 0d (calibration/task0.json d_probes):
 *   p1  childEffects 'parent-run': a parent re-run or stop disposes its child effects recursively (kill).
 *   p4  an unobserved computed keeps its links after a top-level pull (expectedLinks counts it).
 *   p5  a disposed handle reads undefined and never links (val, expectedLinks).
 *   p6  default equality is Object.is (kinds.sameValue; the model compares nothing else).
 *   p7  a body that throws midway keeps ONLY the prefix it read (links = reads before the throw).
 *   p8  disposing a source re-runs nothing: dependents keep a value the model cannot reproduce, so they are
 *       TAINTED until their body runs entirely after the disposal (taint, tainted()).
 *
 * Owners (S3 R3, lanes/owner.mjs; b125 B1 owner probe): p1 generalized. An OWNER is a live computed or effect;
 * a signal is never adopted (children null). kill(i) cascades owned effects AND computeds child-first, then fires
 * the owner's own cleanups; every run of an owner (the engine runs runCleanup before a first evaluation too):
 * kill children -> own cleanups FIFO ->
 * body. cl = the cleanups registered in the owner's current registration set (addCleanup; ordinal = cl before the
 * increment); every fire empties the set (one-shot: a body re-registers its own). fired = cleanups the model says
 * are due, world total; the sentinel signal (setSentinel) holds fired as its value (a cleanup writes the ENGINE
 * sentinel directly, never the model). liveOwner(h): h when it is a live computed / effect, else -1 (runWithOwner
 * on a dead / stale / signal handle roots the call). Lanes other than OWNER never pass a computed parent and never
 * register a cleanup, so for them every rule above is the p1 rule unchanged.
 *
 * COLD module.
 */

import { evalKind, SoakThrow, ERR, sameValue } from './kinds.mjs';

export class Model {
    /** caps: the adapter capability block; only `childEffects` is a model parameter. */
    constructor(caps) {
        this.n = [];
        this.regs = [];
        this.childOwned = caps.childEffects === 'parent-run';
        this.fired = 0;       // cleanups due so far (owners); the sentinel's model value
        this.sentinel = -1;   // the sentinel signal index (setSentinel), -1 = none
    }

    node(i) { return this.n[i]; }

    addSignal(i, v, o) {
        this.n[i] = {
            i, t: 's', live: true, v, dis: o.dis === true, rank: o.rank | 0, role: o.role || 'leaf',
            spec: null, mode: null, parent: -1, children: null, cl: 0, dying: false,
            runs: 0, links: null, seen: null, taint: false, out: undefined, threw: false, sch: 0,
        };
    }

    /** parent (optional): the owner the computed is created under (OWNER lane); other lanes pass none. */
    addComputed(i, spec, parent) {
        this.n[i] = {
            i, t: 'c', live: true, v: undefined, dis: false, rank: 0, role: spec.role || 'comp',
            spec, mode: { early: false, flip: false }, parent: this.parentIdx(parent), children: [], cl: 0, dying: false,
            runs: 0, links: null, seen: null, taint: false, out: undefined, threw: false, sch: 0,
        };
        this.adopt(i, parent);
    }

    /** sch (optional, S3 R4c): 1 = a scheduled effect (lanes/scheduler.mjs); undefined / 0 = unscheduled. Else (-0 too) TypeError. */
    addEffect(i, spec, parent, sch) {
        if ((sch !== undefined && sch !== 0 && sch !== 1) || Object.is(sch, -0)) throw new TypeError('Model.addEffect: sch must be 0 or 1, got ' + (typeof sch === 'number' ? (Object.is(sch, -0) ? '-0' : String(sch)) : typeof sch));
        this.n[i] = {
            i, t: 'e', live: true, v: undefined, dis: false, rank: 0, role: spec.role || 'eff',
            spec, mode: { early: false, flip: false }, parent: this.parentIdx(parent), children: [], cl: 0,
            dying: false, runs: 0, links: null, seen: null, taint: false, out: undefined, threw: false, sch: sch === 1 ? 1 : 0,
        };
        this.adopt(i, parent);
    }

    /** The parent index a new e / c records: -1 for none, or for a node that cannot own (a signal, no node). */
    parentIdx(parent) {
        if (!this.childOwned || parent === undefined || parent < 0) return -1;
        const p = this.n[parent];
        return p === undefined || p.children === null ? -1 : parent;
    }

    /** p1: an owner (any e / c node, even one disposed mid-body, as NEST p1 always did) adopts child i. */
    adopt(i, parent) {
        if (!this.childOwned || parent === undefined || parent < 0) return;
        const p = this.n[parent];
        if (p !== undefined && p.children !== null) p.children.push(i);
    }

    /** runWithOwner(h): h when it is a live computed / effect (the call adopts), else -1 (rooted, tracking detached). */
    liveOwner(h) {
        const nd = Number.isInteger(h) && h >= 0 ? this.n[h] : undefined;
        return nd !== undefined && nd.live && nd.t !== 's' ? h : -1;
    }

    /** The recorded owner of node i (-1: none or no node). The OW cleanup-order oracle walks it. */
    parentOf(i) {
        const nd = this.n[i];
        return nd === undefined ? -1 : nd.parent;
    }

    /**
     * onCleanup(fn) with owner i (lockstep with the engine call): the registration ordinal k within i's current set,
     * or -1 when the call is a no-op (no owner, a signal, a disposed owner: never fires).
     */
    addCleanup(i) {
        const nd = Number.isInteger(i) && i >= 0 ? this.n[i] : undefined;
        if (nd === undefined || !nd.live || nd.t === 's') return -1;
        return nd.cl++;
    }

    /** Mark signal i as the cleanup sentinel S: its model value is fired from now on. Fails closed. */
    setSentinel(i) {
        const nd = this.n[i];
        if (nd === undefined || nd.t !== 's' || !nd.live) throw new TypeError('model: setSentinel(' + i + ') needs a live signal');
        if (this.sentinel !== -1 && this.sentinel !== i) throw new TypeError('model: a second sentinel #' + i + ' (have #' + this.sentinel + ')');
        this.sentinel = i;
        nd.v = this.fired;
    }

    /** Fire owner nd's current registration set (FIFO; the order lives in the lane's fire log): fired += cl. */
    fireCleanups(nd) {
        if (nd.cl === 0) return;
        this.fired += nd.cl;
        nd.cl = 0;
        if (this.sentinel !== -1) this.n[this.sentinel].v = this.fired;
    }

    /** Owner rule, re-run of owner i (runs > 0): kill its children (child-first), then fire its own cleanups. */
    rerunOwner(i) {
        const out = this.killChildren(i);
        const nd = this.n[i];
        if (nd !== undefined && nd.t !== 's') this.fireCleanups(nd);
        return out;
    }

    setValue(i, v) {
        this.n[i].v = v;
    }

    setMode(i, key, value) {
        this.n[i].mode[key] = value;
    }

    /**
     * Dispose node i (and, for an owner, its owned effects and computeds recursively; each owner's own cleanups fire
     * after its subtree's, child-first). Every live observer whose last run read a killed node becomes tainted (p8).
     * Returns the killed indices (pre-order).
     */
    kill(i) {
        const out = [];
        const go = (j) => {
            const nd = this.n[j];
            if (nd === undefined || !nd.live) return;
            nd.live = false;
            out.push(j);
            if (this.childOwned && nd.children !== null) for (let k = 0; k < nd.children.length; k++) go(nd.children[k]);
            this.fireCleanups(nd);
        };
        go(i);
        if (out.length === 0) return out;
        const dead = new Set(out);
        for (let k = 0; k < this.n.length; k++) {
            const nd = this.n[k];
            if (nd === undefined || !nd.live || nd.seen === null) continue;
            for (let j = 0; j < nd.seen.length; j++) if (dead.has(nd.seen[j].r)) { nd.taint = true; break; }
        }
        return out;
    }

    /** Owner rule (p1): an owner (effect or computed) re-run disposes its children first. */
    killChildren(i) {
        const nd = this.n[i];
        if (!this.childOwned || nd === undefined || nd.children === null || nd.children.length === 0) return [];
        const out = [];
        const kids = nd.children;
        nd.children = [];
        for (let k = 0; k < kids.length; k++) for (const j of this.kill(kids[k])) out.push(j);
        return out;
    }

    /** The value of node i, recomputed from the leaves. An Error (SoakThrow) is a value. memo: one check. */
    val(i, memo) {
        const nd = this.n[i];
        if (nd === undefined || !nd.live) return undefined;
        if (nd.t === 's') return nd.v;
        if (nd.t === 'e') return undefined;
        if (memo.has(i)) return memo.get(i);
        let out;
        try {
            out = evalKind(nd.spec, (r) => {
                const x = this.val(r, memo);
                if (x instanceof SoakThrow) throw x;
                return x;
            }, i, nd.mode);
        } catch (e) {
            if (!(e instanceof SoakThrow)) throw e;
            out = e;
        }
        memo.set(i, out);
        return out;
    }

    /**
     * What effect (or computed) body i would read now, in order: { seen: [{r, v}], out, threw }. An effect
     * that reads through try records the error and continues; a naked body stops at the first error.
     */
    evalBody(i, memo) {
        const nd = this.n[i];
        const seen = [];
        const tryMode = nd.t === 'e' && nd.spec.try === true;
        const read = (r, untracked) => {
            const x = this.val(r, memo);
            seen.push({ r, v: x, u: untracked === true });
            if (x instanceof SoakThrow) {
                if (tryMode) return ERR;
                throw x;
            }
            return x;
        };
        let out, threw = null;
        try {
            out = evalKind(nd.spec, read, i, nd.mode);
        } catch (e) {
            if (!(e instanceof SoakThrow)) throw e;
            threw = e;
        }
        return { seen, out, threw };
    }

    /** The signals node i reads now, transitively (dynamic: follows the current branches). */
    readCone(i, memo) {
        const cone = new Set();
        const visit = (j) => {
            const nd = this.n[j];
            if (nd === undefined || !nd.live) return;
            if (nd.t === 's') { cone.add(j); return; }
            if (nd.t !== 'c') return;
            try {
                evalKind(nd.spec, (r) => {
                    visit(r);
                    const x = this.val(r, memo);
                    if (x instanceof SoakThrow) throw x;
                    return x;
                }, j, nd.mode);
            } catch (e) {
                if (!(e instanceof SoakThrow)) throw e;
            }
        };
        visit(i);
        return cone;
    }

    /**
     * Write cycles (G7, O6 (iii); DELTA 4b-v2 T2). A write edge s -> t is a LIVE effect whose spec.d holds
     * signal s and whose spec.w is t, with a numeric non-zero spec.inc (a writer with no inc, e.g. the GRAPH
     * writers, writes its own sum and settles; inc 0 writes the same value). Pure: reads only script state.
     * writeCycle(sig): a write path sig -> ... -> sig exists (the cyc:1 set's flush exceeds the pass cap).
     * writeCycleNew(i): effect i, just added, closes a write path from its spec.w back into its spec.d (its
     * first run's flush exceeds the pass cap). Cold DFS, one visited set per call.
     */
    writeCycle(sig) {
        return this.writeReach(sig, [sig]);
    }

    writeCycleNew(i) {
        const nd = this.n[i];
        if (!this.writeEdge(nd)) return false;
        return this.writeReach(nd.spec.w, nd.spec.d);   // a self-loop (w in d) is found on the first pop via i's own edge
    }

    writeEdge(nd) {
        if (nd === undefined || !nd.live || nd.t !== 'e' || nd.spec === null) return false;
        const s = nd.spec;
        return Array.isArray(s.d) && s.w !== undefined && s.w !== null && typeof s.inc === 'number' && s.inc !== 0;
    }

    /** Is any signal of `goal` reachable from signal `from` over one or more write edges? */
    writeReach(from, goal) {
        const seen = new Set([from]);
        const stack = [from];
        while (stack.length > 0) {
            const s = stack.pop();
            for (let k = 0; k < this.n.length; k++) {
                const nd = this.n[k];
                if (!this.writeEdge(nd) || nd.spec.d.indexOf(s) === -1) continue;
                const t = nd.spec.w;
                if (goal.indexOf(t) !== -1) return true;
                if (!seen.has(t)) { seen.add(t); stack.push(t); }
            }
        }
        return false;
    }

    /**
     * Taint (p8), transitive: node i's last run read a node before it was disposed (flag set by kill() for
     * completed runs; by exec.disposeIdx for a run in progress whose reads so far hold a victim or a
     * kill-tainted live computed, b70 D6 V1), or read a computed that is itself tainted.
     */
    tainted(i, tmemo) {
        const nd = this.n[i];
        if (nd === undefined) return false;
        if (tmemo.has(i)) return tmemo.get(i);
        tmemo.set(i, false);
        let t = nd.taint === true;
        if (!t && nd.seen !== null) {
            for (let j = 0; j < nd.seen.length; j++) {
                const s = this.n[nd.seen[j].r];
                if (s !== undefined && s.t === 'c' && s.live && this.tainted(s.i, tmemo)) { t = true; break; }
            }
        }
        tmemo.set(i, t);
        return t;
    }

    /** Live per-kind counts. */
    counts() {
        let s = 0, c = 0, e = 0;
        for (let k = 0; k < this.n.length; k++) {
            const nd = this.n[k];
            if (nd === undefined || !nd.live) continue;
            if (nd.t === 's') s++;
            else if (nd.t === 'c') c++;
            else e++;
        }
        return { signals: s, computeds: c, effects: e };
    }

    /**
     * O5's E: over live observers that have run, the distinct LIVE sources tracked in the last run. A live
     * effect whose body never ran (fail-open hole: it would contribute nothing) is charged the sources its
     * body WOULD track now (evalBody, untracked reads excluded), so an engine that skipped the run is short.
     * memo: one check call. skip: effect indices to leave out (already reported by O4 as never-ran).
     */
    expectedLinks(memo, skip) {
        let total = 0;
        for (let k = 0; k < this.n.length; k++) {
            const nd = this.n[k];
            if (nd === undefined || !nd.live || nd.t === 's') continue;
            if (skip !== undefined && skip.has(k)) continue;   // O4 owns it this pass (oracles.checkCounts)
            let list = nd.links;
            if (list === null) {
                if (nd.t !== 'e') continue;   // a computed never pulled has no links (lazy)
                list = [];
                for (const e of this.evalBody(k, memo).seen) if (!e.u) list.push(e.r);
            }
            const seenHere = new Set();
            for (let j = 0; j < list.length; j++) {
                const r = list[j];
                const s = this.n[r];
                if (s !== undefined && s.live && s.t !== 'e' && !seenHere.has(r)) { seenHere.add(r); total++; }
            }
        }
        return total;
    }

    /**
     * O7 (S3 R2, lanes/lifecycle.mjs): the reverse link index, source -> Set of the LIVE observers whose link list
     * holds it. Same source rule as expectedLinks: a live effect whose body never ran is charged the sources its
     * body WOULD track now (evalBody, untracked reads excluded); a computed never pulled has no links (lazy); a
     * pulled, unobserved computed keeps its links (p4 / L6). Built once per check call and kept in the CALLER's
     * memo under the string key 'lc:sinks' (val() keys are node indices, so the two never collide).
     */
    sinkIndex(memo) {
        const got = memo.get('lc:sinks');
        if (got !== undefined) return got;
        const idx = new Map();
        for (let k = 0; k < this.n.length; k++) {
            const nd = this.n[k];
            if (nd === undefined || !nd.live || nd.t === 's') continue;
            let list = nd.links;
            if (list === null) {
                if (nd.t !== 'e') continue;   // a computed never pulled has no links (lazy)
                list = [];
                for (const e of this.evalBody(k, memo).seen) if (!e.u) list.push(e.r);
            }
            for (let j = 0; j < list.length; j++) {
                let s = idx.get(list[j]);
                if (s === undefined) { s = new Set(); idx.set(list[j], s); }
                s.add(k);
            }
        }
        memo.set('lc:sinks', idx);
        return idx;
    }

    /** The distinct LIVE observers of node i (sinkIndex). A fresh empty Set when i has none. memo: one check. */
    sinkSet(i, memo) {
        const s = this.sinkIndex(memo).get(i);
        return s === undefined ? new Set() : s;
    }

    /** How many distinct LIVE observers node i has (O7: connected iff > 0). memo: one check. */
    sinkCount(i, memo) {
        return this.sinkSet(i, memo).size;
    }

    addReg(r, target) {
        this.regs[r] = { r, target, live: true };
    }

    offReg(r) {
        if (this.regs[r] !== undefined) this.regs[r].live = false;
    }

    /** May registration r fire right now? Live registration, target live (or mid-dispose). */
    regMayFire(r) {
        const g = this.regs[r];
        if (g === undefined || !g.live) return 'registration off';
        const t = this.n[g.target];
        if (t === undefined || (!t.live && !t.dying)) return 'target #' + g.target + ' disposed';
        return null;
    }

    /** Two read lists are the same observation: same refs in order, sameValue per entry. */
    static sameSeen(a, b) {
        if (a.length !== b.length) return false;
        for (let k = 0; k < a.length; k++) if (a[k].r !== b[k].r || !sameValue(a[k].v, b[k].v)) return false;
        return true;
    }
}
