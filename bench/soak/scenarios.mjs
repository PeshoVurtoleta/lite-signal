/**
 * @zakkster/lite-signal soak -- SCENARIO DETECTORS (SPEC-B v2 section 5.1: "each counter checks its
 * trigger condition, not just that the op was issued"; S8 hollow chaos modes).
 *
 * exec.mjs calls these hooks at engine-observable events (a top-level write, a batch write, a body frame
 * ending, a disposal with the frame stack as it is, an O1c pull, a guarded call's escape). Each counter
 * increments only when its TRUE condition holds at that event. Counts are world-level (`counts`) and
 * step-level (`step`, the scen[] tag of a failure).
 *
 * Frame vocabulary (exec.mjs runBody): a frame is one user body on the stack, with
 *   prev   the live sources its previous run linked (the engine dep list at run start, spliced on disposal)
 *   reads  the sources tracked so far in this run; ok = reads are still a prefix of prev (cursor intact)
 *   inRead the node it is reading right now (-1 none); nested = a body ran inside that read (the engine
 *          saved this frame's cursor: pullComputed / executeEffect prevActiveDep)
 * A frame is SUSPENDED when it is not the innermost frame, or it is inside a read that ran a nested body.
 *
 * COLD module.
 */

export const SCENARIOS = Object.freeze([
    // GRAPH
    'diamond-write', 'dep-set-flip', 'deep-pull', 'second-invalidation', 'equality-cutoff', 'adversarial-equality', 'wide-mark',
    // BATCH
    'revert-after-mid-read', 'revert-no-read', 'nested-close', 'throw-in-batch', 'effect-created-mid-batch', 'multi-write-same-signal',
    // ERROR
    'throw-dep-effect-prewalk', 'throw-dep-computed-prewalk', 'recovery-after-throw', 'aggregate', 'throwing-equals', 'cycle-error-surfaces',
    // NEST
    'saved-cursor-hazard', 'live-cursor-hazard', 'child-first-run-dispose', 'nested-computed-dispose', 'untrack-dispose', 'outer-computed',
    'early-exit-after-dispose', 'lifecycle-callback-dispose', 'lifecycle-dispose-recycle', 'dispose-outer-observer',
    // WIE (unit 0s; in the roster since B2b)
    'wie-stale-effect', 'wie-stale-computed', 'wie-prewalk', 'wie-untrack', 'wie-write-before-read',
    // HOOK (S3 R1; lanes/hook.mjs, in the roster since R1b)
    'hook-multi', 'hook-non-lifo-off', 'hook-mirror-dispose', 'hook-recompute',
    // LIFECYCLE (S3 R2; lanes/lifecycle.mjs, not rostered until R2 B3)
    'lc-two-regs', 'lc-off-sibling', 'lc-late-off-recycle', 'lc-callback-dispose', 'lc-callback-register', 'lc-callback-off-sibling',
    // OWNER (S3 R3; lanes/owner.mjs, not rostered until R3 B3)
    'own-cascade', 'own-rerun', 'own-computed', 'cleanup-fifo', 'run-with-owner', 'run-with-dead-owner', 'root-detached', 'signal-not-adopted',
    // RECYCLE (S3 R4a; lanes/recycle.mjs, not rostered until R4a B3)
    'stale-write-recycled', 'stale-peek-recycled', 'stale-read-recycled', 'stale-dispose-recycled', 'stale-dead-unrecycled', 'multi-gen',
]);

const DEEP_PULL_MIN = 16;
const WIDE_MARK_MIN = 64;

function isAdversarialPair(a, b) {
    if (Object.is(a, 0) && Object.is(b, -0)) return true;
    if (Object.is(a, -0) && Object.is(b, 0)) return true;
    if (Number.isNaN(a) && Number.isNaN(b) && typeof a === 'number' && typeof b === 'number') return true;
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && a !== b && a.ref === 'X' && b.ref === 'X') return true;
    return false;
}

export class Detectors {
    constructor(x) {
        this.x = x;                     // the exec world (frames, model, ran set)
        this.counts = Object.create(null);
        this.step = new Set();
        this.setThisOp = [];            // signals whose value a top-level write changed this op
        this.wsp = new Map();           // computed -> value-changing writes into its cone since its last run
        this.batch = null;              // { pre: Map(s -> pre value), writes: Map, mid: Set(s), depth }
        this.recycle = null;            // lifecycle-dispose-recycle tracker
    }

    count(name) {
        this.counts[name] = (this.counts[name] || 0) + 1;
        this.step.add(name);
    }

    beginStep() {
        this.step.clear();
        this.setThisOp.length = 0;
    }

    /* ---- graph helpers over OBSERVED links (what the engine was told) ---------------------------- */

    /** node -> number of live observers whose last run linked it. */
    subscriberCounts() {
        const M = this.x.M;
        const sub = new Map();
        for (let k = 0; k < M.n.length; k++) {
            const nd = M.n[k];
            if (nd === undefined || !nd.live || nd.t === 's' || nd.links === null) continue;
            for (const r of nd.links) sub.set(r, (sub.get(r) || 0) + 1);
        }
        return sub;
    }

    /** Signals reachable from node i over observed links (memo per call site). */
    obsCone(i, memo) {
        if (memo.has(i)) return memo.get(i);
        const M = this.x.M;
        const nd = M.n[i];
        const out = new Set();
        memo.set(i, out);
        if (nd === undefined) return out;
        if (nd.t === 's') { out.add(i); return out; }
        if (nd.links !== null) for (const r of nd.links) for (const s of this.obsCone(r, memo)) out.add(s);
        return out;
    }

    /* ---- GRAPH ------------------------------------------------------------------------------------- */

    /** A top-level (or batch) write of signal s from `old` to `v`. changed: not equal under the engine's equality. */
    onWrite(s, old, v, changed, topLevel) {
        const sub = this.subscriberCounts();
        if (isAdversarialPair(old, v) && (sub.get(s) || 0) > 0) this.count('adversarial-equality');
        if (!changed) return;
        if (!topLevel) this.onBodyWrite(s);
        if (topLevel) {
            this.setThisOp.push(s);
            if ((sub.get(s) || 0) >= WIDE_MARK_MIN) this.count('wide-mark');
        }
        // second-invalidation bookkeeping: unobserved (no subscriber), already-evaluated computeds in s's cone
        const M = this.x.M;
        const memo = new Map();
        for (let k = 0; k < M.n.length; k++) {
            const nd = M.n[k];
            if (nd === undefined || !nd.live || nd.t !== 'c' || nd.links === null) continue;
            if ((sub.get(k) || 0) > 0) continue;
            if (this.obsCone(k, memo).has(s)) this.wsp.set(k, (this.wsp.get(k) || 0) + 1);
        }
    }

    /* ---- WIE ---------------------------------------------------------------------------------------- */

    /**
     * A value-changing write of signal s from inside a body. Only a COMPUTED writer counts (the innermost
     * frame is the writer: exec.write runs before its frame pops). Over the suspended frames below it:
     *   wie-stale-effect / wie-stale-computed  an effect / computed frame already read s (directly, or through
     *                        a computed whose observed links reach s): it holds the old value (the #37 class)
     *   wie-untrack          as stale, and the write actually ran inside W.untrack (the writer frame's wu flag,
     *                        set by exec around the untracked write), not merely spec.wu === 1
     *   wie-write-before-read  a frame whose spec reads s directly has NOT read it yet (the control order)
     *   wie-prewalk          the writer was pulled by a pre-walk (effect flush or computed dependency walk)
     */
    onBodyWrite(s) {
        const x = this.x;
        const frames = x.frames;
        const n = frames.length;
        if (n === 0) return;
        const top = frames[n - 1];
        if (top.t !== 'c') return;
        const spec = x.M.n[top.i].spec;
        if (spec === null || spec.w !== s) return;
        if (top.pre !== 0) this.count('wie-prewalk');
        const memo = new Map();
        let stale = false;
        for (let j = n - 2; j >= 0; j--) {
            const F = frames[j];
            let read = false;
            for (const e of F.seen) if (e.r === s || this.obsCone(e.r, memo).has(s)) { read = true; break; }
            if (read) {
                stale = true;
                this.count(F.t === 'e' ? 'wie-stale-effect' : 'wie-stale-computed');
            } else {
                const fs = x.M.n[F.i].spec;
                if (fs !== null && fs.d !== undefined && fs.d.indexOf(s) !== -1) this.count('wie-write-before-read');
            }
        }
        if (stale && top.wu === 1) this.count('wie-untrack');
    }

    /** End of a top-level op: diamond-write = some body that ran reads >= 2 nodes whose cone holds a written s. */
    endOp() {
        if (this.setThisOp.length === 0) return;
        const M = this.x.M;
        const memo = new Map();
        for (const i of this.x.ran) {
            const nd = M.n[i];
            if (nd === undefined || nd.links === null) continue;
            for (const s of this.setThisOp) {
                let paths = 0;
                for (const r of nd.links) if (r === s || this.obsCone(r, memo).has(s)) paths++;
                if (paths >= 2) { this.count('diamond-write'); return; }
            }
        }
    }

    /** O1c is about to pull computed i at rest. */
    beforeCheckRead(i) {
        if ((this.wsp.get(i) || 0) >= 2) this.count('second-invalidation');
    }

    /** O1c pulled computed i; `bodies` computed bodies ran during that one read. */
    afterCheckRead(i, bodies) {
        if (bodies >= DEEP_PULL_MIN) this.count('deep-pull');
    }

    /* ---- frames ------------------------------------------------------------------------------------ */

    onFrameEnd(f, nd, prevOut, prevThrew, threw) {
        const x = this.x;
        if (nd.t === 'c') this.wsp.delete(nd.i);
        if (f.prev !== null && f.prev.length > 0) {
            let same = f.prev.length === f.reads.length;
            for (let k = 0; same && k < f.reads.length; k++) if (f.reads[k] !== f.prev[k]) same = false;
            if (!same) this.count('dep-set-flip');
        }
        if (nd.t === 'c' && !f.first && !threw && !prevThrew && Object.is(prevOut, nd.out) && (f.depth > 0 || x.topRead === -1)) {
            this.count('equality-cutoff');
        }
        if (nd.t === 'c' && threw) {
            if (f.pre === 1) this.count('throw-dep-effect-prewalk');
            else if (f.pre === 2) this.count('throw-dep-computed-prewalk');
        }
        if (nd.t === 'c' && !threw && prevThrew && !f.first) this.count('recovery-after-throw');
        if (f.hazard && f.reads.length === f.hazardAt) this.count('early-exit-after-dispose');
    }

    /** A tracked read of `ref` by frame f (before the engine read). */
    onTrackedRead(f, ref) {
        const rc = this.recycle;
        if (rc !== null && rc.z === ref) {
            const sub = this.subscriberCounts();
            if ((sub.get(ref) || 0) === 0) this.count('lifecycle-dispose-recycle');
            this.recycle = null;
        }
    }

    onCreate(i, t) {
        const rc = this.recycle;
        if (rc === null) return;
        if (rc.z === -1 && t === 's') rc.z = i;
        else if (rc.z === -1) this.recycle = null;
    }

    /**
     * Node i is about to be disposed by exec code (a top-level op, a body or a lifecycle callback). The
     * frame stack is exactly the engine's at this instant.
     */
    onDispose(i) {
        const x = this.x;
        const M = x.M;
        const frames = x.frames;
        const nd = M.n[i];
        // lifecycle-dispose-recycle: the target of a live registration dies; the next node allocated is watched.
        for (let r = 0; r < M.regs.length; r++) {
            const g = M.regs[r];
            if (g !== undefined && g.live && g.target === i) { this.recycle = { z: -1 }; break; }
        }
        if (x.cbDepth > 0) this.count('lifecycle-callback-dispose');
        const n = frames.length;
        if (n === 0) return;
        const top = frames[n - 1];
        if (x.cbDepth === 0) {
            if (top.t === 'e' && top.first && n >= 2) this.count('child-first-run-dispose');
            if (top.t === 'c' && n >= 2) this.count('nested-computed-dispose');
            if (top.t === 'c' && n >= 2 && frames[n - 2].inReadU) this.count('untrack-dispose');
        }
        for (let j = n - 1; j >= 0; j--) {
            const F = frames[j];
            const suspended = j < n - 1 || (F.inRead !== -1 && F.nested);
            if (F.i === i && suspended && nd !== undefined && nd.t !== 's') this.count('dispose-outer-observer');
            if (!F.ok || F.prev === null) continue;
            const at = F.prev.indexOf(i, F.reads.length);
            if (at === -1) continue;
            if (suspended) {
                this.count('saved-cursor-hazard');
                if (F.t === 'c') this.count('outer-computed');
                if (at === F.reads.length) { F.hazard = true; F.hazardAt = F.reads.length; }
            } else {
                this.count('live-cursor-hazard');
            }
        }
    }

    /* ---- BATCH -------------------------------------------------------------------------------------- */

    onBatchEnter(depth) {
        if (depth === 1) this.batch = { pre: new Map(), writes: new Map(), mid: new Set(), last: new Map() };
    }

    onBatchExit(depth, wroteInside) {
        if (depth >= 2 && wroteInside) this.count('nested-close');
        if (depth === 1) this.batch = null;
    }

    onBatchWrite(s, old, v) {
        const b = this.batch;
        if (b === null) return;
        if (!b.pre.has(s)) b.pre.set(s, old);
        const w = (b.writes.get(s) || 0) + 1;
        b.writes.set(s, w);
        const pre = b.pre.get(s);
        if (w >= 2 && !Object.is(b.last.get(s), v)) this.count('multi-write-same-signal');
        if (w >= 2 && Object.is(v, pre) && !Object.is(old, pre)) {
            this.count(b.mid.has(s) ? 'revert-after-mid-read' : 'revert-no-read');
            b.mid.delete(s);
        }
        b.last.set(s, v);
    }

    /** A mid-batch top-level read of computed c: mark every in-flight write whose signal c reads now. */
    onMidRead(c) {
        const b = this.batch;
        if (b === null) return;
        const M = this.x.M;
        const cone = M.readCone(c, new Map());
        for (const [s, pre] of b.pre) {
            const nd = M.n[s];
            if (nd !== undefined && nd.live && !Object.is(nd.v, pre) && cone.has(s)) b.mid.add(s);
        }
    }

    onBatchThrow(wrote) {
        if (wrote) this.count('throw-in-batch');
    }

    onEffectCreated(inBatch, ran) {
        if (inBatch && ran) this.count('effect-created-mid-batch');
    }

    /* ---- HOOK --------------------------------------------------------------------------------------- */

    /**
     * One hook delivery (lanes/hook.mjs onFire), BEFORE the mirror applies it. hk: the world's HookState.
     *   hook-multi           the delivery happened with >= 3 listeners live (L0 + 2 above it)
     *   hook-mirror-dispose  op 2 for a node the mirror still holds SOURCE edges for (rule I3: freed silently)
     *   hook-recompute       op 5 reached a listener
     */
    onHookFire(hk, op, a) {
        const st = hk.stack;
        let live = 0;
        for (let j = 0; j < st.length; j++) if (st[j].live) live++;
        if (live >= 3) this.count('hook-multi');
        if (op === 2) {
            const m = hk.mirror.out.get(a);
            if (m !== undefined && m.size > 0) this.count('hook-mirror-dispose');
        } else if (op === 5) this.count('hook-recompute');
    }

    /** An hoff of a live listener; above: a live listener sits above its target (a NON-LIFO off). */
    onHookOff(above) {
        if (above) this.count('hook-non-lifo-off');
    }

    /* ---- LIFECYCLE (called by lanes/lifecycle.mjs only: no other lane pays for them) ------------------ */

    /**
     * An lreg reached the engine call. others: live registrations already on the same LIVE target; inCb: made from
     * inside a lifecycle callback.
     *   lc-two-regs           the target now holds >= 2 live registrations (the DIV-D3 overwrite trigger)
     *   lc-callback-register  the registration was made inside a lifecycle callback (phase-free, L8a)
     */
    onLcReg(others, inCb) {
        if (others > 0) this.count('lc-two-regs');
        if (inCb) this.count('lc-callback-register');
    }

    /**
     * An loff of a live registration. siblings: other live registrations on the same LIVE target; recycled: the
     * target is dead and a live registration sits on a node created after it died (L10: the off may hit the slot's
     * new tenant); inCb: from inside a lifecycle callback.
     *   lc-off-sibling           an off with a sibling registration live on the same target (L2 / L2b)
     *   lc-late-off-recycle      the late off of a dead target with a newer node registered (L10)
     *   lc-callback-off-sibling  lc-off-sibling, from inside a lifecycle callback (B0-2 shape, optional)
     */
    onLcOff(siblings, recycled, inCb) {
        if (siblings > 0) {
            this.count('lc-off-sibling');
            if (inCb) this.count('lc-callback-off-sibling');
        }
        if (recycled) this.count('lc-late-off-recycle');
    }

    /** A lifecycle callback's armed action disposes a LIVE node (L7 shapes: mid connect / disconnect walk). */
    onLcCallbackDispose() {
        this.count('lc-callback-dispose');
    }

    /* ---- OWNER (exec.mjs runBody while exec.ow !== null, and lanes/owner.mjs only: no other lane pays) ---- */

    /**
     * Owner i is about to be killed (rerun false: odisp, BEFORE model.kill) or re-run (rerun true: runBody entry,
     * BEFORE model.rerunOwner). Reads the model's LIVE ownership subtree that dies now (a re-run keeps i itself):
     *   own-cascade   the dying subtree is >= 2 ownership levels deep below i (a grandchild dies too)
     *   own-rerun     a re-run that kills >= 1 live child or fires >= 1 cleanup of i
     *   own-computed  a dying computed owner holds a live computed child (computed owns computed)
     *   cleanup-fifo  a dying owner (or the re-run owner) fires >= 2 cleanups (FIFO is judgeable)
     */
    onOwnKill(i, rerun) {
        const M = this.x.M;
        const nd = M.n[i];
        if (nd === undefined || nd.t === 's' || !nd.live) return;
        let depth = 0, fifo = nd.cl >= 2, comp = false, kids = 0;
        const stack = [i, 0];
        while (stack.length > 0) {
            const d = stack.pop(), j = stack.pop();
            const o = M.n[j];
            if (o.children === null) continue;
            for (let k = 0; k < o.children.length; k++) {
                const c = M.n[o.children[k]];
                if (c === undefined || !c.live) continue;
                if (j === i) kids++;
                if (d + 1 > depth) depth = d + 1;
                if (c.cl >= 2) fifo = true;
                if (o.t === 'c' && c.t === 'c') comp = true;
                stack.push(c.i, d + 1);
            }
        }
        if (depth >= 2) this.count('own-cascade');
        if (rerun && (kids > 0 || nd.cl > 0)) this.count('own-rerun');
        if (comp) this.count('own-computed');
        if (fifo) this.count('cleanup-fifo');
    }

    /**
     * A runWithOwner(h, fn) returned; did: cleanups registered + nodes created inside fn (0 = hollow, not counted).
     *   run-with-owner       h is a live computed / effect (model.liveOwner): fn's work is adopted
     *   run-with-dead-owner  h is a disposed / stale owner or a signal handle: fn runs rooted (never fires, never adopted)
     */
    onOwnRunWithOwner(h, did) {
        if (!(did > 0)) return;
        this.count(this.x.M.liveOwner(h) >= 0 ? 'run-with-owner' : 'run-with-dead-owner');
    }

    /** A createRoot(fn) returned; did as above. root-detached: it ran inside a live body (the root is not adopted). */
    onOwnRoot(did) {
        if (did > 0 && this.x.frames.length > 0) this.count('root-detached');
    }

    /** A node of kind t was created while owner `owner` runs. signal-not-adopted: a signal under a live owner (p1: never adopted). */
    onOwnCreate(t, owner) {
        if (t === 's' && this.x.M.liveOwner(owner) >= 0) this.count('signal-not-adopted');
    }

    /* ---- RECYCLE (called by lanes/recycle.mjs only, while exec.rc !== null: no other lane pays) ---------------- */

    /**
     * One op through a STALE handle (its node disposed) reached the engine call. op: 'set' | 'peek' | 'read' | 'disp'
     * (disp = registry dispose(h)); kind: the stale handle's kind 's' | 'c' | 'e'; res: the kind of the live node the
     * slot hosts now ('s' | 'c' | 'e'), or null when the slot is dead / free (never recycled since); held: the stale
     * handles the lane retains for this slot, this one included (an integer >= 1). A combination the engine surface
     * does not offer (set on a non-signal, read / peek on an effect) fails closed. Each counter is the case a missing
     * gen guard would make visible (b129 T0 S5):
     *   stale-write-recycled    a stale SIGNAL set while the slot hosts a live signal or computed (set guard)
     *   stale-peek-recycled     a stale SIGNAL peek while the slot hosts a live signal or computed (peek guard)
     *   stale-read-recycled     a stale signal / computed read while the slot hosts any live node
     *   stale-dispose-recycled  a registry dispose of a stale handle while the slot hosts any live node (dispose guard;
     *                           cov-off rule stale-dispose-dead: lanes/recycle.mjs then disposes dead slots only)
     *   stale-dead-unrecycled   any stale op on a dead slot (the not-recycled control)
     *   multi-gen               >= 2 stale handles held on a slot that hosts a live node (recycled >= 2x)
     */
    onRcStale(op, kind, res, held) {
        if (op !== 'set' && op !== 'peek' && op !== 'read' && op !== 'disp') throw new TypeError('onRcStale: unknown op ' + String(op));
        if (kind !== 's' && kind !== 'c' && kind !== 'e') throw new TypeError('onRcStale: kind must be s / c / e, got ' + String(kind));
        if (res !== null && res !== 's' && res !== 'c' && res !== 'e') throw new TypeError('onRcStale: res must be null or s / c / e, got ' + String(res));
        if (!Number.isSafeInteger(held) || held < 1) throw new TypeError('onRcStale: held must be an integer >= 1, got ' + String(held));
        if ((op === 'set' && kind !== 's') || ((op === 'peek' || op === 'read') && kind === 'e')) {
            throw new TypeError('onRcStale: no ' + op + ' on a stale ' + kind + ' handle');
        }
        if (res === null) { this.count('stale-dead-unrecycled'); return; }
        const val = res === 's' || res === 'c';
        if (op === 'set' && val) this.count('stale-write-recycled');
        else if (op === 'peek' && kind === 's' && val) this.count('stale-peek-recycled');
        else if (op === 'read') this.count('stale-read-recycled');
        else if (op === 'disp') this.count('stale-dispose-recycled');
        if (held >= 2) this.count('multi-gen');
    }

    /* ---- ERROR -------------------------------------------------------------------------------------- */

    /** One guarded call finished. g: its guard; got: the normalized escape leaves. */
    onEscape(g, got) {
        if (g.thrown.length >= 2) this.count('aggregate');
        if (g.cycle) {
            for (const leaf of got) if (typeof leaf.message === 'string' && leaf.message.indexOf('CycleError:') === 0) { this.count('cycle-error-surfaces'); break; }
        }
    }
}
