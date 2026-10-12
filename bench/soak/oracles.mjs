/**
 * @zakkster/lite-signal soak -- the S1 correctness oracles (SPEC-B v2 section 6). Parity-pinned.
 *
 * Every oracle is a pure function of (model, observation): it returns a failure
 * { oracle, sig, detail } (or a list of them), or null. None of them touches an engine; exec.mjs makes
 * the engine calls and hands the results in. test/43-soak-model proves each one fires on a hand-built
 * failing world and is silent on a passing one (no tautologies, S8).
 *
 *   O1c  checkComputed   at-rest engine read of a live, untainted computed vs model.val
 *   O1e  checkEffect     a live, untainted effect's last observation vs what its body would read now
 *   O2   checkRead       inline: every value a body reads vs model.val at that moment
 *   O4   checkEffect     the effect's inputs changed during the op and it ran 0 times (live inputs only
 *                        when tainted), or a live effect never ran at all
 *   O5   checkCounts / checkTeardown   per-kind counts, activeNodes, activeLinks in [E, E + 0] (G4)
 *   O6   checkEscape     the escape set of one guarded call equals the predicted set (tokens, CycleError)
 *   O7a  checkFire       a lifecycle callback fires only for a live registration on a live target
 *
 * COLD module.
 */

import { Model } from './model.mjs';
import { SoakThrow, sameValue, showValue } from './kinds.mjs';

export const ORACLES = Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O7a']);

/** The sig vocabulary (SPEC-B section 6; escape-<origin> / escape-<Ctor> are open families). */
export const SIGS = Object.freeze({
    O1c: ['computed-mismatch', 'computed-err-mismatch'],
    O1e: ['effect-stale'],
    O2: ['glitch'],
    O4: ['effect-dead'],
    O5: ['node-count', 'kind-count', 'link-count', 'teardown-residue'],
    O6: ['escape-*', 'expected-escape-missing', 'equals-mutated', 'escape-empty'],
    O7a: ['dead-registration-fire'],
});

const DETAIL_MAX = 240;
const cut = (s) => (s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX - 3) + '...' : s);

/** O1c: engine value `got` (a returned value, or the thrown SoakThrow) of computed i vs the model. */
export function checkComputed(model, i, got, memo) {
    const want = model.val(i, memo);
    if (sameValue(got, want)) return null;
    const errSide = got instanceof SoakThrow || want instanceof SoakThrow;
    return {
        oracle: 'O1c', sig: errSide ? 'computed-err-mismatch' : 'computed-mismatch',
        detail: cut('node#' + i + ' (' + (model.n[i].spec !== null ? model.n[i].spec.k : 'signal') + ') engine=' + showValue(got) + ' model=' + showValue(want)),
    };
}

/** O2: a body read of node `ref` returned (or threw) `got`. The caller skips tainted computeds. */
export function checkRead(model, ref, got, memo, reader) {
    const want = model.val(ref, memo);
    if (sameValue(got, want)) return null;
    return {
        oracle: 'O2', sig: 'glitch',
        detail: cut('body#' + reader + ' read #' + ref + ' engine=' + showValue(got) + ' model=' + showValue(want)),
    };
}

/**
 * O1e + O4 for one live effect i (at rest). ran: the effect's body ran during this op.
 * Returns { fail, o1e, o4 }: fail is a failure or null; o1e / o4 say whether that oracle was PERFORMED
 * ('done'), skipped because the effect or its inputs are tainted ('skip'), or not applicable ('na': O4
 * only applies to an effect that ran 0 times this op). Callers count performed checks only.
 *
 * A live effect whose body NEVER ran is a failure (O4 effect-dead, "never ran"): every engine runs an
 * effect's first body synchronously at creation (p2), and one whose first run threw is no longer live (p3).
 */
export function checkEffect(model, i, ran, memo, tmemo) {
    const nd = model.n[i];
    if (nd === undefined || !nd.live || nd.t !== 'e') return { fail: null, o1e: 'na', o4: 'na' };
    if (nd.seen === null) {
        // alsoImplies: the same root cause also short-changes activeLinks; the caller excludes this effect from
        // O5 in the same pass (one root cause, counted once by the A/B) and the record says so
        return {
            fail: { oracle: 'O4', sig: 'effect-dead', detail: cut('effect#' + i + ' is live but its body never ran'), alsoImplies: ['O5'] },
            o1e: 'na', o4: 'done', neverRan: true,
        };
    }
    if (!model.tainted(i, tmemo)) {
        const o4 = ran ? 'na' : 'done';
        const m = model.evalBody(i, memo);
        if (Model.sameSeen(m.seen, nd.seen)) return { fail: null, o1e: 'done', o4 };
        return {
            fail: {
                oracle: ran ? 'O1e' : 'O4', sig: ran ? 'effect-stale' : 'effect-dead',
                detail: cut('effect#' + i + ' saw [' + nd.seen.map(fmtSeen).join(',') + '] model [' + m.seen.map(fmtSeen).join(',') + ']' + (ran ? '' : ' (ran 0 times this op)')),
            },
            o1e: 'done', o4,
        };
    }
    // Tainted: O1e is skipped; O4 still checks the live, untainted inputs.
    if (ran) return { fail: null, o1e: 'skip', o4: 'na' };
    let compared = 0;
    for (let k = 0; k < nd.seen.length; k++) {
        const e = nd.seen[k];
        const s = model.n[e.r];
        if (s === undefined || !s.live) continue;
        if (s.t === 'c' && model.tainted(e.r, tmemo)) continue;
        compared++;
        const now = model.val(e.r, memo);
        if (!sameValue(now, e.v)) {
            return {
                fail: {
                    oracle: 'O4', sig: 'effect-dead',
                    detail: cut('effect#' + i + ' (tainted) live input #' + e.r + ' was ' + showValue(e.v) + ' now ' + showValue(now) + ', ran 0 times this op'),
                },
                o1e: 'skip', o4: 'done',
            };
        }
    }
    return { fail: null, o1e: 'skip', o4: compared > 0 ? 'done' : 'skip' };
}

function fmtSeen(e) { return '#' + e.r + '=' + showValue(e.v); }

/**
 * O5 at rest: stats() vs the model's live counts and expected links (slack 0 under G4). skip: effects O4
 * already reported as never-ran in this pass (their links are neither charged nor expected).
 */
export function checkCounts(model, stats, skip) {
    const memo = new Map();
    const out = [];
    const c = model.counts();
    for (const k of ['signals', 'computeds', 'effects']) {
        if (stats[k] !== c[k]) out.push({ oracle: 'O5', sig: 'kind-count', detail: cut(k + ' engine=' + stats[k] + ' model=' + c[k]) });
    }
    const nodes = c.signals + c.computeds + c.effects;
    if (stats.activeNodes !== nodes) out.push({ oracle: 'O5', sig: 'node-count', detail: cut('activeNodes engine=' + stats.activeNodes + ' model=' + nodes) });
    const E = model.expectedLinks(memo, skip);
    if (!(stats.activeLinks >= E && stats.activeLinks <= E)) {
        out.push({ oracle: 'O5', sig: 'link-count', detail: cut('activeLinks engine=' + stats.activeLinks + ' expected=' + E + ' (slack 0)') });
    }
    return out;
}

/** O5 at world end, after close(): every node and link returned. */
export function checkTeardown(residue) {
    if (residue !== null && residue.nodes === 0 && residue.links === 0) return null;
    return { oracle: 'O5', sig: 'teardown-residue', detail: cut('after close(): ' + JSON.stringify(residue)) };
}

/** The sig of an unpredicted escape leaf ({token, origin} or {ctor, message}). */
export function escapeSig(leaf) {
    if (leaf.token !== undefined) return 'escape-' + leaf.origin;
    if (typeof leaf.message === 'string' && leaf.message.indexOf('CycleError') === 0) return 'escape-CycleError';
    return 'escape-' + leaf.ctor;
}

/**
 * O6 for one guarded call. pred: predicted SoakThrow tokens (multiset). got: normalizeEscape(escape) or [].
 * cycle: a CycleError is expected (cycle-bomb, G7).
 */
export function checkEscape(pred, got, cycle) {
    const out = [];
    const want = new Map();
    for (const t of pred) want.set(t, (want.get(t) || 0) + 1);
    let cycleSeen = false;
    for (const leaf of got) {
        if (leaf.token !== undefined) {
            const n = want.get(leaf.token) || 0;
            if (n > 0) { want.set(leaf.token, n - 1); continue; }
            out.push({ oracle: 'O6', sig: escapeSig(leaf), detail: cut('unpredicted escape ' + leaf.token) });
        } else if (cycle && !cycleSeen && typeof leaf.message === 'string' && leaf.message.indexOf('CycleError:') === 0) {
            cycleSeen = true;
        } else {
            out.push({ oracle: 'O6', sig: escapeSig(leaf), detail: cut('engine error escaped: ' + leaf.ctor + ': ' + leaf.message) });
        }
    }
    for (const [t, n] of want) {
        if (n > 0) out.push({ oracle: 'O6', sig: 'expected-escape-missing', detail: cut('predicted escape ' + t + ' x' + n + ' did not happen') });
    }
    if (cycle && !cycleSeen) out.push({ oracle: 'O6', sig: 'expected-escape-missing', detail: 'predicted CycleError did not happen' });
    return out;
}

/** O7a: lifecycle registration r just fired. */
export function checkFire(model, r, kind) {
    const why = model.regMayFire(r);
    if (why === null) return null;
    const g = model.regs[r];
    return { oracle: 'O7a', sig: 'dead-registration-fire', detail: cut((kind || 'callback') + ' fired for registration r' + r + ' on #' + (g ? g.target : '?') + ': ' + why) };
}
