/**
 * test/torture-judge.mjs -- the retention-slope verdict of test/torture.mjs (set, untrack and QS lanes; b78).
 *
 * One measureAllocs call per attempt alternates pseudo-batches of the same call count at 1 step per call
 * (even batch index) and 5 (odd), so the instrument's per-batch constant k is shared by both parities and
 * cancels, while a per-step retainer grows with the 4x extra steps of every odd batch. The verdict (rule R2'):
 *
 *   Dlo = the minimum even batch, Dhi = the 2nd-smallest odd batch (a multiset: two equal odd minima give
 *   Dhi = that value); pass iff measured and Dhi <= Dlo.
 *
 * Why the 2nd-smallest odd: with Dhi = min odd (the b72-b77 rule, ord 1) ONE odd batch that dipped to the
 * even floor passed a retainer (b77; vector V1). No single bad batch (an odd dip, an odd spike, an even spike,
 * an even dip) passes a retainer now; an R2' pass is always an R1 pass. Blind: two odd dips in one attempt,
 * each dipping by >= the retainer's per-batch bytes (vector B1), and a spike on every measured even batch.
 *
 * Fail closed (null is not zero): measured only when ok === true (the caller's counter conjunction), bb is an
 * array, every entry is null (a skipped batch) or a finite number >= 0, each parity kept >= 4 batches, and
 * Dlo and Dhi exist. Also the QS control's min of paired differences: pmin = min over odd b of bb[b] - bb[b - 1]
 * (both non-null), nPair = the pairs counted -- computed exactly as the pre-b78 qsRead (the control gates on
 * measured, nPair and pmin, unchanged). Pure; no imports, no side effects at import. Cold: it runs after a
 * measurement, never inside the measured fn, and may allocate.
 */

/** Rank of the odd batch read as Dhi: 2 = the 2nd-smallest (b78 rule R2'); 1 = the minimum (pre-b78 rule). */
export const SLOPE_ORD = 2;

/**
 * Slope verdict of one attempt.
 * @param {Array<number|null>} bb  measureAllocs() batchBytes, even index = 1 step per call, odd = 5
 * @param {boolean} ok             the caller's counter conjunction (settled, steps, fires, end state); only true counts
 * @param {1|2} [ord=SLOPE_ORD]    rank of the odd batch read as Dhi; anything else throws RangeError
 * @returns {{lo: number|null, hi: number|null, hiMin: number|null, nLo: number, nHi: number,
 *            pmin: number|null, nPair: number, measured: boolean, pass: boolean}}
 *          lo = Dlo (min even), hi = Dhi (ord-th smallest odd; null when fewer than ord odd batches),
 *          hiMin = min odd, nLo / nHi = non-null batches per parity
 */
export function judgeSlope(bb, ok, ord = SLOPE_ORD) {
  if (ord !== 1 && ord !== 2) throw new RangeError('judgeSlope: ord must be 1 or 2, got ' + String(ord));
  let lo = null, h1 = null, h2 = null, nLo = 0, nHi = 0, pmin = null, nPair = 0, valid = true;
  const isArr = Array.isArray(bb);
  const n = isArr ? bb.length : 0;
  for (let b = 0; b < n; b++) {
    const v = bb[b];
    if (v === null) continue;
    if (typeof v !== 'number' || !(v >= 0 && v < Infinity)) valid = false;   // NaN, negative, Infinity, '0', undefined
    if ((b & 1) === 0) { nLo++; if (lo === null || v < lo) lo = v; }
    else {
      nHi++;
      if (h1 === null || v < h1) { h2 = h1; h1 = v; } else if (h2 === null || v < h2) h2 = v;
      const ev = bb[b - 1];
      if (ev !== null) { nPair++; const d = v - ev; if (pmin === null || d < pmin) pmin = d; }
    }
  }
  const hi = ord === 1 ? h1 : h2;
  const measured = ok === true && isArr && valid && nLo >= 4 && nHi >= 4 && lo !== null && hi !== null;
  return { lo, hi, hiMin: h1, nLo, nHi, pmin, nPair, measured, pass: measured && hi <= lo };
}
