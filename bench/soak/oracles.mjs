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
 *   O7   checkLcFire     (LIFECYCLE lane, S3 R2) a fire matches the registration's phase: onConnect only while
 *                        disconnected, onDisconnect only while connected (lanes/lifecycle.mjs calls it after O7a passes)
 *        checkLcRest     at rest, each live registration on a live target agrees with model.sinkCount (connected iff
 *                        > 0), and a target whose sink set did not move saw no fire (exec.mjs lcAtRest, exec.lc !== null)
 *   OB   checkBatchRun   an effect that already ran re-runs while a batch is open (exec decides when; the
 *                        first run of an effect created inside a batch is synchronous by design, p2)
 *   O8   checkHookFire   a graph-mutation event reached the TOP LIVE listener, never an off'd or a lower one
 *        checkMirror     the mirror.mjs replay of the hook stream is consistent and matches stats() at rest
 *                        (S3 R1, the HOOK lane only: lanes/hook.mjs onFire calls checkHookFire, exec.mjs hookAtRest calls checkMirror while exec.hk !== null)
 *
 * COLD module.
 */

import { Model } from './model.mjs';
import { SoakThrow, sameValue, showValue, specRefs } from './kinds.mjs';

export const ORACLES = Object.freeze(['O1c', 'O1e', 'O2', 'O4', 'O5', 'O6', 'O7a', 'O7', 'OB', 'O8']);

/** The sig vocabulary (SPEC-B section 6; escape-<origin> / escape-<Ctor> are open families). */
export const SIGS = Object.freeze({
    O1c: ['computed-mismatch', 'computed-err-mismatch'],
    O1e: ['effect-stale'],
    O2: ['glitch'],
    O4: ['effect-dead'],
    O5: ['node-count', 'kind-count', 'link-count', 'teardown-residue'],
    O6: ['escape-*', 'expected-escape-missing', 'equals-mutated', 'escape-empty'],
    O7a: ['dead-registration-fire'],
    O7: ['spurious-connect', 'missed-disconnect', 'stale-off', 'spurious-disconnect', 'missed-connect'],   // S3-D5 order
    OB: ['batch-early-run'],
    O8: ['ghost-listener', 'mirror-links'],
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

/** O6 expect[] lists: no engine error expected, and the (iii) cycle-bomb CycleError (G7; any ctor, message prefix). */
export const EXPECT_NONE = Object.freeze([]);
export const EXPECT_CYCLE = Object.freeze([Object.freeze({ id: 'CycleError', ctor: null, prefix: 'CycleError:' })]);

/**
 * O6 for one guarded call. pred: predicted SoakThrow tokens (multiset). got: normalizeEscape(escape) or [].
 * expect: the engine errors expected, an array of { id, ctor: string | null (null = any), prefix } (EXPECT_NONE,
 * EXPECT_CYCLE). Each entry absorbs at most ONE non-token leaf, entries tried in order; an entry that absorbed
 * nothing reports 'predicted <id> did not happen' after the token misses. EXPECT_CYCLE gives exactly the former
 * cycle === true result, EXPECT_NONE the former false. Throws TypeError (before any check) on a malformed list.
 */
export function checkEscape(pred, got, expect) {
    if (!Array.isArray(expect)) throw new TypeError('checkEscape: expect must be an array (EXPECT_NONE / EXPECT_CYCLE), got ' + (expect === null ? 'null' : typeof expect));
    for (const e of expect) {
        if (e === null || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.prefix !== 'string' || e.prefix === '' || (e.ctor !== null && typeof e.ctor !== 'string')) {
            throw new TypeError('checkEscape: expect entries are { id: string, ctor: string | null, prefix: non-empty string }');
        }
    }
    const out = [];
    const want = new Map();
    for (const t of pred) want.set(t, (want.get(t) || 0) + 1);
    const seen = expect.map(() => false);
    for (const leaf of got) {
        if (leaf.token !== undefined) {
            const n = want.get(leaf.token) || 0;
            if (n > 0) { want.set(leaf.token, n - 1); continue; }
            out.push({ oracle: 'O6', sig: escapeSig(leaf), detail: cut('unpredicted escape ' + leaf.token) });
        } else if (!absorb(expect, seen, leaf)) {
            out.push({ oracle: 'O6', sig: escapeSig(leaf), detail: cut('engine error escaped: ' + leaf.ctor + ': ' + leaf.message) });
        }
    }
    for (const [t, n] of want) {
        if (n > 0) out.push({ oracle: 'O6', sig: 'expected-escape-missing', detail: cut('predicted escape ' + t + ' x' + n + ' did not happen') });
    }
    for (let j = 0; j < expect.length; j++) {
        if (!seen[j]) out.push({ oracle: 'O6', sig: 'expected-escape-missing', detail: 'predicted ' + expect[j].id + ' did not happen' });
    }
    return out;
}

/** The first expect[] entry not yet seen that matches leaf (ctor, message prefix) absorbs it. */
function absorb(expect, seen, leaf) {
    if (typeof leaf.message !== 'string') return false;
    for (let j = 0; j < expect.length; j++) {
        const e = expect[j];
        if (seen[j] || (e.ctor !== null && leaf.ctor !== e.ctor) || leaf.message.indexOf(e.prefix) !== 0) continue;
        seen[j] = true;
        return true;
    }
    return false;
}

/** OB: effect i (it had already run) re-ran while `depth` batches were open. Always a failure. */
export function checkBatchRun(i, depth) {
    return { oracle: 'OB', sig: 'batch-early-run', detail: cut('effect#' + i + ' re-ran inside an open batch (depth ' + depth + ')') };
}

/** O7a: lifecycle registration r just fired. */
export function checkFire(model, r, kind) {
    const why = model.regMayFire(r);
    if (why === null) return null;
    const g = model.regs[r];
    return { oracle: 'O7a', sig: 'dead-registration-fire', detail: cut((kind || 'callback') + ' fired for registration r' + r + ' on #' + (g ? g.target : '?') + ': ' + why) };
}

/**
 * O7 for one fire of LIFECYCLE registration r (lanes/lifecycle.mjs, only after O7a checkFire passed). lc: the world's
 * LcState; lc.regs[r] = { r, target, live, phase (-1 | 0 | 1), fires[], co, sibOff, deadOff }. Pushes kind onto
 * fires (the first FIRE_KEEP kinds since the last rest). A phase -1 registration (made inside a callback) takes the
 * phase the fire implies. Otherwise onConnect while connected = spurious-connect, onDisconnect while disconnected =
 * spurious-disconnect (the phase is left as it was); a legal fire flips the phase. Returns null or a failure.
 */
const FIRE_KEEP = 16;

export function checkLcFire(lc, r, kind) {
    const g = lc.regs[r];
    // a fire for a registration LcState never recorded is a harness bug (O7a passed, so the model holds it): fail closed
    if (g === undefined) throw new Error('checkLcFire: fire ' + kind + ' for registration r' + r + ' that LcState never recorded');
    if (g.fires.length < FIRE_KEEP) g.fires.push(kind);
    const on = kind === 'onConnect';
    if (g.phase === -1) { g.phase = on ? 1 : 0; return null; }
    if (on && g.phase === 1) return { oracle: 'O7', sig: 'spurious-connect', detail: cut('r' + r + ' on #' + g.target + ': onConnect while connected') };
    if (!on && g.phase === 0) return { oracle: 'O7', sig: 'spurious-disconnect', detail: cut('r' + r + ' on #' + g.target + ': onDisconnect while disconnected') };
    g.phase = on ? 1 : 0;
    return null;
}

/**
 * O7 at rest (exec.mjs lcAtRest). For every live registration on a live target (a disposed target ends its
 * registration: no disconnect is owed, L4), with sinks = model.sinkSet(target) and k = its size:
 *   phase -1, no fire   adopts (k > 0 ? 1 : 0) and reports nothing (stated weakness: one transition can be missed)
 *   (a) quiet target    fires since the last rest, the sink set equals the previous rest's (lc.prev; key absent = the
 *                       target did not exist then) and no node that ran this op is a sink or reads the target directly
 *                       (spec refs: a run that linked and dropped it inside the op) -> spurious-<first kind>
 *   (b) phase != (k > 0)  missed-connect / missed-disconnect, + ' (co-registered r<M>)' when g.co is non-empty
 *   (c) (b) after an off  stale-off: g.sibOff (an off of another registration on the same target) first, else g.deadOff
 *                       (an off on a dead target that died before this target was created)
 * One failure per registration. Returns a list of { oracle: 'O7', sig, detail, r } (empty = consistent). ran: the
 * Set of node indices whose body ran this op. tally (optional, b118): { n } -- n += 1 per registration checked
 * against rule (a) / (b) (live, live target, phase !== -1 after the adoption step); exec.mjs lcAtRest adds it to
 * checks.O7. Mutates only the phase of a phase -1 registration (and tally.n).
 */
export function checkLcRest(lc, model, memo, ran, tally) {
    const out = [];
    const regs = lc.regs;
    for (let r = 0; r < regs.length; r++) {
        const g = regs[r];
        if (g === undefined || !g.live) continue;
        const t = g.target;
        const tn = model.n[t];
        if (tn === undefined || !tn.live) continue;
        const sinks = model.sinkSet(t, memo);
        const k = sinks.size;
        if (g.phase === -1) {
            if (g.fires.length === 0) g.phase = k > 0 ? 1 : 0;
            continue;
        }
        if (tally !== undefined) tally.n++;
        const head = 'r' + r + ' on #' + t + ': ';
        if (g.fires.length > 0 && lcQuiet(lc, model, t, sinks, ran)) {
            const f = g.fires[0];
            out.push({ oracle: 'O7', sig: f === 'onConnect' ? 'spurious-connect' : 'spurious-disconnect', detail: cut(head + f + ' on a quiet target (sinks ' + k + ')'), r });
            continue;
        }
        if (g.phase === (k > 0 ? 1 : 0)) continue;
        const base = head + (g.phase === 1 ? 'connected' : 'disconnected') + ' at rest, sinks ' + k;
        if (g.sibOff !== null) {
            out.push({ oracle: 'O7', sig: 'stale-off', detail: cut(base + ' after off of r' + g.sibOff.r + ' on #' + t + ' (sibling) at step ' + g.sibOff.step), r });
        } else if (g.deadOff !== null) {
            const d = g.deadOff;
            const who = d.r !== undefined ? 'off of r' + d.r + ' on #' + d.d : 'a late off';
            out.push({ oracle: 'O7', sig: 'stale-off', detail: cut(base + ' after ' + who + ' (dead target) at step ' + d.step), r });
        } else {
            let co = '';
            for (const m of g.co) { co = ' (co-registered r' + m + ')'; break; }
            out.push({ oracle: 'O7', sig: g.phase === 1 ? 'missed-disconnect' : 'missed-connect', detail: cut(base + co), r });
        }
    }
    return out;
}

/** Rule (a): target t's sink set did not move since the last rest and no run this op could have linked it. */
function lcQuiet(lc, model, t, sinks, ran) {
    const prev = lc.prev.get(t);
    if (prev === undefined || prev.size !== sinks.size) return false;
    for (const s of sinks) if (!prev.has(s)) return false;
    for (const j of ran) {
        if (sinks.has(j)) return false;
        const nd = model.n[j];
        if (nd !== undefined && nd.spec !== null && nd.spec.k !== undefined && specRefs(nd.spec).indexOf(t) !== -1) return false;
    }
    return true;
}

/**
 * O8 for one hook delivery. stack: the lane's listeners in subscription order, each { live: boolean, offStep:
 * number | null } (offStep = the step whose off() retired it); receiver: the stack index of the listener that got
 * the event; op: the hook op (1-5); step: the op step being executed. The expected receiver is the TOP LIVE entry
 * (the highest live index; TASK 0 b93: headpatched delivers there after any off order, a live L0 underneath).
 *   off'd receiver        ghost-listener 'L<i> received op<k> after off at step <offStep> (expected L<j> | none)' (DIV-F9 shape)
 *   live, not the top     ghost-listener 'L<i> received op<k> at step <s> but L<j> is the top live listener'
 *   index not in stack    ghost-listener 'L<i> received op<k> at step <s> but is not a subscribed listener'
 * Returns null when receiver is the top live entry.
 */
export function checkHookFire(stack, receiver, op, step) {
    let top = -1;
    for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].live) { top = j; break; }
    }
    if (receiver === top) return null;
    const want = top === -1 ? 'none' : 'L' + top;
    const e = Number.isInteger(receiver) && receiver >= 0 && receiver < stack.length ? stack[receiver] : null;
    if (e === null) {
        return { oracle: 'O8', sig: 'ghost-listener', detail: cut('L' + receiver + ' received op' + op + ' at step ' + step + ' but is not a subscribed listener') };
    }
    if (!e.live) {
        return { oracle: 'O8', sig: 'ghost-listener', detail: cut('L' + receiver + ' received op' + op + ' after off at step ' + e.offStep + ' (expected ' + want + ')') };
    }
    return { oracle: 'O8', sig: 'ghost-listener', detail: cut('L' + receiver + ' received op' + op + ' at step ' + step + ' but ' + want + ' is the top live listener') };
}

/**
 * O8 at rest: every problem the mirror (mirror.mjs) recorded since the last check, then its edge / node counts vs
 * stats().activeLinks / activeNodes. Drains the mirror's problem list. Returns a list (empty = consistent).
 */
export function checkMirror(mirror, stats) {
    const out = [];
    for (const p of mirror.drain()) out.push({ oracle: 'O8', sig: 'mirror-links', detail: cut(p) });
    if (mirror.edges !== stats.activeLinks) out.push({ oracle: 'O8', sig: 'mirror-links', detail: cut('mirror edges ' + mirror.edges + ' != activeLinks ' + stats.activeLinks) });
    if (mirror.nodes !== stats.activeNodes) out.push({ oracle: 'O8', sig: 'mirror-links', detail: cut('mirror nodes ' + mirror.nodes + ' != activeNodes ' + stats.activeNodes) });
    return out;
}
