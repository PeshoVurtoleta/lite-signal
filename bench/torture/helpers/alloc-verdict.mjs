/**
 * bench/torture/helpers/alloc-verdict.mjs -- the zerogc byte witness verdict (witness 1).
 *
 * A measureAllocs + checkAllocs pair (lite-gc-profiler 1.16.0) can end 'inconclusive' with no floor at all:
 * bytesPerCall null because EVERY batch bracket inverted (a foreign survivor was reclaimed inside each
 * window, so each end anchor read below its start). That is the host's GC timing, not the code under test,
 * and a re-measure usually lands. So:
 *
 *   pass                                                  -> 'pass'
 *   fail (a measured floor above the limit)               -> 'fail', never retried
 *   inconclusive, bytesPerCall null, invertedBatches > 0,
 *     settled true (every batch got a finite reading)     -> 'retry' while attempts remain, else 'inconclusive'
 *   any other inconclusive (unsettled, no memory channel) -> 'fail': the harness itself is broken. gc-profiler
 *     also labels an UNSETTLED all-inverted run 'bracket_inverted'; settled is what tells the two apart
 *   an unknown verdict, a non-object report or alloc      -> 'fail' (fail closed)
 *
 * byteWitnessLabel / churnNote / inconclusiveSuffix are the report text of each outcome: 'inconclusive' is a
 * NOTE (the gate stands on the exact counters and, for the steady scenarios, the scavenge / nursery window),
 * never a PASS of the byte claim, and the PASS line says so. Pure; no imports. Cold: it runs between
 * measurements, never inside the measured fn.
 */

/** Measurements per byte witness before an inverted-bracket inconclusive is reported as such. */
export const ALLOC_ATTEMPTS = 3;

const isCount = (n) => typeof n === "number" && Number.isInteger(n);

/**
 * One step of the byte witness.
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
    if (rep.verdict !== "inconclusive") return "fail";   // 'fail' and any verdict this mapping does not know
    if (alloc === null || typeof alloc !== "object") return "fail";
    if (alloc.bytesPerCall !== null || !isCount(alloc.invertedBatches) || !(alloc.invertedBatches > 0) || alloc.settled !== true) return "fail";
    return attempt < budget ? "retry" : "inconclusive";
}

/**
 * Run the byte witness: measure(), check(alloc), allocStep, re-measuring only on 'retry'.
 * @param {() => object} measure        returns a measureAllocs() result
 * @param {(alloc: object) => object} check  returns the checkAllocs() report of that result
 * @param {number} budget               attempts allowed, an integer >= 1 (validated before the first measure)
 * @returns {{outcome: 'pass'|'fail'|'inconclusive', attempts: number, budget: number, alloc: object, rep: object}}
 *          the last attempt
 */
export function bytesWitness(measure, check, budget) {
    if (typeof measure !== "function") throw new TypeError("bytesWitness: measure must be a function");
    if (typeof check !== "function") throw new TypeError("bytesWitness: check must be a function");
    if (!isCount(budget) || budget < 1) throw new RangeError("bytesWitness: budget must be an integer >= 1, got " + String(budget));
    for (let attempt = 1; ; attempt++) {
        const alloc = measure();
        const rep = check(alloc);
        const outcome = allocStep(rep, alloc, attempt, budget);
        if (outcome !== "retry") return { outcome, attempts: attempt, budget, alloc, rep };
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
