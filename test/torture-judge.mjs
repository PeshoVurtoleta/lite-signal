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

// ---- whole-run verdict of the pinned child lanes (b123, FILLER 7 group A) ----
// The child measures each lane in WHOLE_WINDOWS windows of new_space + new_large_object_space
// used-size deltas (window 0 warm, printed only), after two forced young GCs, and records every
// gc entry (startTime, kind) of the run. The verdict reads the MEAN of windows 1..8 against the
// same windows of the empty-step baseline, plus the GC counts inside the cell's span (before
// window 1's probe .. after window 8's probe) and the baseline's span: a transient either stays
// young (every byte is in the mean) or scavenges inside the span (a minor count). Cold; may allocate.

/** Windows per child lane: window 0 (warm-up, ignored here) + the 8 gated windows. */
export const WHOLE_WINDOWS = 9;
/** Forced young GCs the child runs: two before each of its 6 lanes. */
export const WHOLE_FORCED = 12;
/**
 * B/op a baseline's smallest window may exceed the cell's smallest window and still count as warm
 * (b123 witness under 10 burners: base 0.0908 vs cell 0.0892 = 0.0016; a cold probe reads 0.1452 vs
 * 0.0892 = 0.056). The tolerance's own slack hides at most this much of the 0.05 budget on a flat baseline;
 * heavier non-min baseline windows are not bounded by this min-vs-min guard (they subtract from the mean in full).
 */
export const WHOLE_STALE_TOL = 0.005;

/**
 * Class of a gc entry kind (fail closed: anything not listed is unknown, and unknown fails a span).
 * @param {*} kind  the entry's detail.kind
 * @returns {'minor'|'major'|'ignored'|'unknown'}  1, 2 minor (2 = minor mark-sweep); 4 major;
 *          8 incremental, 16 weak callbacks ignored; anything else (0, 3, 32, '1', NaN, undefined) unknown
 */
export function classifyGcKind(kind) {
  switch (kind) {
    case 1: case 2: return 'minor';
    case 4: return 'major';
    case 8: case 16: return 'ignored';
    default: return 'unknown';
  }
}

const isSeq = (a) => Array.isArray(a) || ArrayBuffer.isView(a);

/**
 * GC entries inside one span, by class. An entry counts iff t0 <= startTime <= t1 (both ends
 * inclusive); an entry whose time is NaN cannot be placed and counts as unknown in every span.
 * @param {ArrayLike<number>} times  entry start times (performance.now() clock)
 * @param {ArrayLike<*>} kinds       entry kinds, same index
 * @param {number} n                 entries to read (integer, 0 <= n <= both lengths)
 * @param {number} t0                span start
 * @param {number} t1                span end
 * @returns {{minor: number, major: number, unknown: number, ignored: number}|null}
 *          null (unmeasured) on a malformed input or a span that is not finite with t0 <= t1
 */
export function countSpan(times, kinds, n, t0, t1) {
  if (!isSeq(times) || !isSeq(kinds) || !Number.isInteger(n) || n < 0 || n > times.length || n > kinds.length) return null;
  if (typeof t0 !== 'number' || typeof t1 !== 'number' || !(t0 > -Infinity && t1 < Infinity && t0 <= t1)) return null;
  const c = { minor: 0, major: 0, unknown: 0, ignored: 0 };
  for (let i = 0; i < n; i++) {
    const t = times[i];
    if (typeof t !== 'number' || t !== t) { c.unknown++; continue; }
    if (t >= t0 && t <= t1) c[classifyGcKind(kinds[i])]++;
  }
  return c;
}

const isBytes = (v) => typeof v === 'number' && v >= 0 && v < Infinity;   // -0 passes as 0
const isCount = (v) => Number.isInteger(v) && v >= 0;
const spanOf = (c) => c !== null && typeof c === 'object' && isCount(c.minor) && isCount(c.major) && isCount(c.unknown) ? c : null;

/**
 * Whole-run verdict of one child cell.
 * @param {Array<number|null>} per   the cell's WHOLE_WINDOWS window B/op values
 * @param {Array<number|null>} base  the empty-step baseline's windows, same length
 * @param {{cell: object, base: object, forcedSeen: number}} counts  countSpan() of the cell's span and
 *        the baseline's span; forcedSeen = young entries seen inside the forced-GC spans
 * @param {number} budget            B/op ceiling of the mean (0.05 in the torture)
 * @returns {{measured: boolean, mean: number|null, nulls: number, minor: number|null, major: number|null,
 *            unknown: number|null, baseMinor: number|null, baseMajor: number|null, baseUnknown: number|null,
 *            forcedSeen: number|null, staleBase: boolean, pass: boolean}}
 *          measured iff both arrays have WHOLE_WINDOWS entries, windows 1..8 are finite >= 0 on both sides
 *          (nulls = the windows that are not), the min baseline window 1..8 does not exceed the min cell
 *          window 1..8 by more than WHOLE_STALE_TOL (a baseline whose min exceeds the cell's by more than
 *          WHOLE_STALE_TOL is stale / cold: it would hide the cell's bytes, so the mean is unmeasured and
 *          staleBase = true), and both span counts and forcedSeen are well-formed;
 *          mean = max(0, (sum per[1..8] - sum base[1..8]) / 8); pass iff measured, mean <= budget, every
 *          span count (minor, major, unknown; cell and baseline) is 0 and forcedSeen >= WHOLE_FORCED
 */
export function judgeWhole(per, base, counts, budget) {
  const W = WHOLE_WINDOWS;
  const shaped = Array.isArray(per) && Array.isArray(base) && per.length === W && base.length === W;
  let nulls = shaped ? 0 : W - 1, sp = 0, sb = 0, pm = Infinity, bm = Infinity;
  if (shaped) {
    for (let w = 1; w < W; w++) {
      const a = per[w], b = base[w];
      if (isBytes(a) && isBytes(b)) { sp += a; sb += b; if (a < pm) pm = a; if (b < bm) bm = b; } else nulls++;
    }
  }
  const staleBase = shaped && nulls === 0 && !(bm <= pm + WHOLE_STALE_TOL);
  const mean = shaped && nulls === 0 && bm <= pm + WHOLE_STALE_TOL ? Math.max(0, (sp - sb) / (W - 1)) : null;
  const cc = counts !== null && typeof counts === 'object' ? counts : null;
  const cell = cc === null ? null : spanOf(cc.cell);
  const bs = cc === null ? null : spanOf(cc.base);
  const forcedSeen = cc !== null && isCount(cc.forcedSeen) ? cc.forcedSeen : null;
  const measured = mean !== null && cell !== null && bs !== null && forcedSeen !== null;
  const pass = measured && typeof budget === 'number' && mean <= budget &&
    cell.minor === 0 && cell.major === 0 && cell.unknown === 0 &&
    bs.minor === 0 && bs.major === 0 && bs.unknown === 0 && forcedSeen >= WHOLE_FORCED;
  return {
    measured, mean, nulls,
    minor: cell === null ? null : cell.minor, major: cell === null ? null : cell.major,
    unknown: cell === null ? null : cell.unknown,
    baseMinor: bs === null ? null : bs.minor, baseMajor: bs === null ? null : bs.major,
    baseUnknown: bs === null ? null : bs.unknown,
    forcedSeen, staleBase, pass,
  };
}
