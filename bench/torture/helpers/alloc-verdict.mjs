/**
 * bench/torture/helpers/alloc-verdict.mjs -- the zerogc byte witness verdict (witness 1).
 *
 * A measureAllocs + checkAllocs pair (lite-gc-profiler 1.16.0) can end 'inconclusive' with no floor at all:
 * bytesPerCall null because EVERY batch bracket inverted (a foreign survivor was reclaimed inside each
 * window, so each end anchor read below its start). That is the host's GC timing, not the code under test,
 * and a re-measure usually lands. The same host timing can leave a 'fail' whose min rests on the one or two
 * batches that did not invert (D-b146-1): that floor is under-sampled, so it is re-measured too. A real leak
 * usually reads above the floor on every MEASURED batch, but a later attempt can still invert every batch (an
 * inconclusive), so a measured fail is sticky (D-b146-2): if no later attempt passes, the witness ends 'fail'
 * (with the last measured fail's alloc + report), never 'inconclusive'. So:
 *
 *   pass                                                  -> 'pass'
 *   fail, under-sampled (measuredBatches <= batches / 2, invertedBatches > 0, settled)
 *                                                         -> 'retry' while attempts remain, else 'fail'
 *   fail (well-sampled)                                   -> 'fail', never retried
 *   fail with a missing / non-integer batch count         -> 'fail', never retried (fail closed)
 *   inconclusive, bytesPerCall null, invertedBatches > 0,
 *     settled true (every batch got a finite reading)     -> 'retry' while attempts remain, else 'inconclusive'
 *   a measured fail, then no pass on any later attempt    -> 'fail' (sticky): bytesWitness, not allocStep
 *   any other inconclusive (unsettled, no memory channel) -> 'fail': the harness itself is broken. gc-profiler
 *     also labels an UNSETTLED all-inverted run 'bracket_inverted'; settled is what tells the two apart
 *   an unknown verdict, a non-object report or alloc      -> 'fail' (fail closed)
 *
 * byteWitnessLabel / churnNote / inconclusiveSuffix are the report text of each outcome: 'inconclusive' is a
 * NOTE (the gate stands on the exact counters and, for the steady scenarios, the scavenge / nursery window),
 * never a PASS of the byte claim, and the PASS line says so. Pure; no imports. Cold: it runs between
 * measurements, never inside the measured fn.
 */

/** Measurements per byte witness before an inverted-bracket inconclusive (or an under-sampled fail) stands. */
export const ALLOC_ATTEMPTS = 3;

const isCount = (n) => typeof n === "number" && Number.isInteger(n);

/** A measured floor that rests on at most half the batches because the rest inverted (D-b146-1). */
function underSampled(alloc) {
    if (alloc === null || typeof alloc !== "object") return false;
    const b = alloc.batches, m = alloc.measuredBatches, inv = alloc.invertedBatches;
    return isCount(b) && b >= 1 && isCount(m) && m >= 1 && m * 2 <= b &&
        isCount(inv) && inv > 0 && alloc.settled === true;
}

/**
 * One step of the byte witness. A 'fail' is retried only when under-sampled: alloc.batches and
 * alloc.measuredBatches integers >= 1 with measuredBatches * 2 <= batches, alloc.invertedBatches an
 * integer > 0, alloc.settled === true; any missing / non-integer field keeps it 'fail' (fail closed).
 * @param {object} rep      checkAllocs() report
 * @param {object} alloc    the measureAllocs() result rep was computed from
 * @param {number} attempt  1-based attempt number, in [1, budget]
 * @param {number} budget   attempts allowed, an integer >= 1
 * @returns {'pass'|'fail'|'retry'|'inconclusive'}
 */
export function allocStep(rep, alloc, attempt, budget) {
    if (!isCount(budget) || budget < 1) throw new RangeError("allocStep: budget must be an integer >= 1, got " + String(budget));
    if (!isCount(attempt) || attempt < 1 || attempt > budget) throw new RangeError("allocStep: attempt must be an integer in [1, " + budget + "], got " + String(attempt));
    if (rep === null || typeof rep !== "object") return "fail";
    if (rep.verdict === "pass") return "pass";
    if (rep.verdict === "fail") return underSampled(alloc) ? (attempt < budget ? "retry" : "fail") : "fail";
    if (rep.verdict !== "inconclusive") return "fail";   // any verdict this mapping does not know
    if (alloc === null || typeof alloc !== "object") return "fail";
    if (alloc.bytesPerCall !== null || !isCount(alloc.invertedBatches) || !(alloc.invertedBatches > 0) || alloc.settled !== true) return "fail";
    return attempt < budget ? "retry" : "inconclusive";
}

/**
 * Run the byte witness: measure(), check(alloc), allocStep, re-measuring only on 'retry'. A measured fail is
 * sticky (D-b146-2): if no later attempt passes, the witness ends 'fail' (with the last measured fail's
 * alloc + report, attempts = the last attempt number), never 'inconclusive'. Only a later pass clears it.
 * @param {() => object} measure        returns a measureAllocs() result
 * @param {(alloc: object) => object} check  returns the checkAllocs() report of that result
 * @param {number} budget               attempts allowed, an integer >= 1 (validated before the first measure)
 * @returns {{outcome: 'pass'|'fail'|'inconclusive', attempts: number, budget: number, alloc: object, rep: object}}
 *          the last attempt (a sticky fail: the last attempt number, with the last measured fail's alloc + rep)
 */
export function bytesWitness(measure, check, budget) {
    if (typeof measure !== "function") throw new TypeError("bytesWitness: measure must be a function");
    if (typeof check !== "function") throw new TypeError("bytesWitness: check must be a function");
    if (!isCount(budget) || budget < 1) throw new RangeError("bytesWitness: budget must be an integer >= 1, got " + String(budget));
    let failAlloc = null, failRep = null;   // the last attempt whose report verdict was 'fail' (sticky)
    for (let attempt = 1; ; attempt++) {
        const alloc = measure();
        const rep = check(alloc);
        const outcome = allocStep(rep, alloc, attempt, budget);
        if (rep !== null && typeof rep === "object" && rep.verdict === "fail") { failAlloc = alloc; failRep = rep; }
        if (outcome === "retry") continue;
        if (outcome !== "pass" && failRep !== null) {
            return { outcome: "fail", attempts: attempt, budget, alloc: failAlloc, rep: failRep };
        }
        return { outcome, attempts: attempt, budget, alloc, rep };
    }
}

/**
 * The report text of one bytesWitness result.
 * -> {ok, detail, note, inconclusive}: ok true / false is the R.ok verdict (null: no R.ok, the outcome is a
 * NOTE); detail is the R.ok failure text (null on a pass); note is an R.note line or null; inconclusive is
 * the count the PASS-line suffix adds (0 or 1). A 'fail' whose report verdict is not 'fail' (an unsettled
 * or unmeasurable run), and any outcome this mapping does not know, is an UNVERIFIABLE FAIL.
 * @param {string} name        scenario name
 * @param {object} w           bytesWitness() result
 * @param {boolean} steady     the scenario also has the scavenge / nursery window (witness 4)
 * @param {number} floor       the maxBytesPerCall the witness was checked against
 */
export function byteWitnessLabel(name, w, steady, floor) {
    if (w === null || typeof w !== "object") throw new TypeError("byteWitnessLabel: w must be a bytesWitness() result");
    const at = "attempt " + w.attempts + "/" + w.budget;
    if (w.outcome === "pass") {
        return { ok: true, detail: null, note: w.attempts > 1 ? name + " -- byte witness: pass on " + at : null, inconclusive: 0 };
    }
    if (w.outcome === "inconclusive") {
        return {
            ok: null, detail: null, inconclusive: 1,
            note: name + " -- INCONCLUSIVE: byte witness unmeasured after " + w.attempts + " attempts " +
                "(every batch bracket inverted); not a FAIL -- gated on exact counters" +
                (steady ? " + scavenge/nursery window" : ""),
        };
    }
    const a = w.alloc !== null && typeof w.alloc === "object" ? w.alloc : {};
    const verdict = w.rep !== null && typeof w.rep === "object" ? w.rep.verdict : undefined;
    return {
        ok: false, note: null, inconclusive: 0,
        detail: (w.outcome === "fail" && verdict === "fail" ? "" : "UNVERIFIABLE: ") +
            `retained ${a.bytesPerCall} B/call vs floor ${floor} ` +
            `(verdict ${verdict}${a.settled ? "" : ", UNSETTLED"}` +
            `${a.invertedBatches ? `, ${a.invertedBatches} inverted batch(es)` : ""}, ${at})`,
    };
}

/**
 * The churn scenario's visible verdict line. The retained-bytes claim is made only when the byte witness
 * PASSED; otherwise the line speaks for the exact counters alone.
 * @param {string} name     scenario name
 * @param {string} outcome  bytesWitness() outcome
 * @param {number} floor    the churn maxBytesPerCall (CHURN_BYTES_FLOOR)
 */
export function churnNote(name, outcome, floor) {
    if (outcome === "pass") return `${name} -- ok: retained < ${floor} B/call (sub-object floor), poolGrowths delta 0, activeNodes returned to baseline`;
    return `${name} -- counters ok: poolGrowths delta 0, activeNodes returned to baseline` +
        (outcome === "inconclusive" ? " (byte witness INCONCLUSIVE)" : "");
}

/** The PASS-line suffix: "" at 0 inconclusive byte witnesses, else the count. n: an integer >= 0. */
export function inconclusiveSuffix(n) {
    if (!isCount(n) || n < 0) throw new RangeError("inconclusiveSuffix: n must be an integer >= 0, got " + String(n));
    return n === 0 ? "" : ` (byte witness INCONCLUSIVE on ${n} scenario(s))`;
}
