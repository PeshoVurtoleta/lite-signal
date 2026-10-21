/**
 * @zakkster/lite-signal soak -- the graph-mutation MIRROR (S3 R1 HOOK; PLAN-0s-s3-r1.md TASK 4). Pure.
 *
 * A Mirror replays the onGraphMutation stream (op, a, b) of one world into a node set and an edge MULTISET
 * (Map source -> Map target -> count) and records every event the stream cannot have produced as a problem
 * detail. O8 (oracles.mjs checkMirror) drains the problems and compares the counts with stats() at rest.
 *
 * The stream (B0-7, .handoff/s3-evidence/p2, all 3 kernels):
 *   op 1 (id, flags)    a node was created: id joins the live set
 *   op 2 (id, flags)    a node was disposed. It fires FIRST; the node's own DEP edges then emit op 4 each, its
 *                       SUBSCRIBER edges are freed SILENTLY -> rule I3: drop every edge where id is the SOURCE,
 *                       then remove id from the live set (its incoming dep edges stay until their op 4s)
 *   op 3 (src, tgt)     a link: +1 edge src -> tgt
 *   op 4 (src, tgt)     an unlink: -1 edge src -> tgt
 *   op 5 (id, 0)        a recompute: no change
 *
 * Problem details (each a string; the mirror keeps the first PROBLEM_CAP and counts the rest):
 *   op1 id <v> outside [1, 2^31-1]       op1 id <v> already live
 *   op<k> on non-live id <v>             (op 2 / 3 / 5 on any non-live id; op 4 on a non-live SOURCE, or a non-live
 *                                         target with no such edge: a remaining edge always has a live source, I3)
 *   op4 on absent edge <src> -> <tgt>    unknown op <k>
 *
 * COLD module: one Map lookup per hook event, never on an engine hot path.
 */

export const ID_MAX = 0x7fffffff;           // 2^31 - 1
export const PROBLEM_CAP = 16;

const isId = (v) => Number.isInteger(v) && v >= 1 && v <= ID_MAX;
const show = (v) => (typeof v === 'number' ? String(v) : typeof v);

export class Mirror {
    constructor() {
        this.live = new Set();
        this.out = new Map();       // src -> Map(tgt -> count)
        this.edges = 0;
        this.problems = [];
        this.dropped = 0;           // problems past PROBLEM_CAP
        this.events = 0;
    }

    get nodes() { return this.live.size; }

    /** Count of edge src -> tgt (0 when absent). */
    edgeCount(src, tgt) {
        const m = this.out.get(src);
        if (m === undefined) return 0;
        const n = m.get(tgt);
        return n === undefined ? 0 : n;
    }

    problem(detail) {
        if (this.problems.length < PROBLEM_CAP) this.problems.push(detail);
        else this.dropped++;
    }

    /** Apply one hook event. Returns true when it was consistent, false when it recorded a problem. */
    apply(op, a, b) {
        this.events++;
        if (op === 1) {
            if (!isId(a)) { this.problem('op1 id ' + show(a) + ' outside [1, 2^31-1]'); return false; }
            if (this.live.has(a)) { this.problem('op1 id ' + a + ' already live'); return false; }
            this.live.add(a);
            return true;
        }
        if (op === 2) {
            if (!this.live.has(a)) { this.problem('op2 on non-live id ' + show(a)); return false; }
            const m = this.out.get(a);
            if (m !== undefined) {
                for (const n of m.values()) this.edges -= n;
                this.out.delete(a);
            }
            this.live.delete(a);
            return true;
        }
        if (op === 3) {
            if (!this.live.has(a)) { this.problem('op3 on non-live id ' + show(a)); return false; }
            if (!this.live.has(b)) { this.problem('op3 on non-live id ' + show(b)); return false; }
            let m = this.out.get(a);
            if (m === undefined) { m = new Map(); this.out.set(a, m); }
            m.set(b, (m.get(b) || 0) + 1);
            this.edges++;
            return true;
        }
        if (op === 4) {
            if (!this.live.has(a)) { this.problem('op4 on non-live id ' + show(a)); return false; }
            const n = this.edgeCount(a, b);
            if (n === 0) {
                this.problem(this.live.has(b) ? 'op4 on absent edge ' + a + ' -> ' + show(b) : 'op4 on non-live id ' + show(b));
                return false;
            }
            const m = this.out.get(a);
            if (n === 1) {
                m.delete(b);
                if (m.size === 0) this.out.delete(a);
            } else {
                m.set(b, n - 1);
            }
            this.edges--;
            return true;
        }
        if (op === 5) {
            if (!this.live.has(a)) { this.problem('op5 on non-live id ' + show(a)); return false; }
            return true;
        }
        this.problem('unknown op ' + show(op));
        return false;
    }

    /** Drain the recorded problems (the list, plus a 'N more' line when some were dropped). */
    drain() {
        const out = this.problems;
        if (this.dropped > 0) out.push('... ' + this.dropped + ' more mirror problems');
        this.problems = [];
        this.dropped = 0;
        return out;
    }
}
