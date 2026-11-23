// bench/lib/schedule.mjs -- round-robin rep scheduling.
//
// F3: run-all-bench.sh iterates `for eng; for rep` -- all 10 reps of engine 1, then
// all 10 of engine 2. That is defect #1 of the retired sbench driver, named in
// harness/toe-to-toe/README.md ("Ordering bias -- the thermal artifact"): the last
// engine always runs on the hottest chassis, which is how deepChain showed a
// MONOTONIC slowdown across 1.9->1.10->1.11 -- three engines whose propagation bodies
// are sha256-IDENTICAL. Identical code cannot trend; the trend was the machine heating
// up under a fixed order.
//
// Fix (toe-to-toe's fix): round-robin. Each rep wave runs EVERY engine once, in a
// rotated order, so thermal drift spreads across all columns instead of loading the
// last one. buildSchedule returns a flat list of {engine, rep, wave} steps in the
// order they should execute.

// engines: string[]  reps: number  -> [{engine, rep, wave, index}]
export function buildSchedule(engines, reps) {
    const n = engines.length;
    const steps = [];
    let index = 0;
    for (let wave = 0; wave < reps; wave++) {
        // rotate the starting engine each wave so no engine is pinned to the hot slot
        for (let k = 0; k < n; k++) {
            const eng = engines[(wave + k) % n];
            steps.push({ engine: eng, rep: wave + 1, wave, index: index++ });
        }
    }
    return steps;
}

// Emit the schedule as shell-consumable lines "engine rep" so a thin .mjs driver can
// exec them, or a Makefile/loop can read them. One line per cold process to spawn.
export function scheduleLines(engines, reps) {
    return buildSchedule(engines, reps).map((s) => `${s.engine} ${s.rep}`);
}

// For the sentinel drift check (ported from toe-to-toe): the FIRST-scheduled combo is
// re-measured as an extra trailing step. Caller compares its time to the same combo's
// earlier measurement; a delta beyond DRIFT_TOL means the host drifted mid-sweep and
// the whole sweep is thermally suspect.
// Sentinel drift tolerance. Host-calibratable: VersionMatrix's README is explicit that
// tolerances should be set from measured self-noise ("calibrate before tightening").
// A quiet host at full scale wants ~5%; a noisy shared box or sub-10ms measurements
// need more headroom. Override with DRIFT_TOL env (fraction, e.g. 0.15).
// Fail closed: a set DRIFT_TOL must be a plain decimal fraction strictly inside (0,1).
// "5%" used to become NaN, and `x > NaN` is false, so the sentinel silently never fired;
// "" / "0" / "1" / "0x1" / " 0.1" are refused the same way (throw at import). Unset -> 0.05.
const DRIFT_TOL_RAW = process.env.DRIFT_TOL;
const DRIFT_TOL_RE = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?$/;
export const DRIFT_TOL = DRIFT_TOL_RAW === undefined ? 0.05
    : (DRIFT_TOL_RE.test(DRIFT_TOL_RAW) ? Number(DRIFT_TOL_RAW) : NaN);
if (!(DRIFT_TOL > 0 && DRIFT_TOL < 1)) {
    throw new Error(`schedule: DRIFT_TOL must be a decimal fraction in (0,1), e.g. 0.15 (got "${DRIFT_TOL_RAW}")`);
}

export function withSentinel(steps) {
    if (steps.length === 0) return steps;
    const first = steps[0];
    return [...steps, { engine: first.engine, rep: "sentinel", wave: -1, index: steps.length, sentinel: true }];
}

export function sentinelDrift(baselineTime, sentinelTime) {
    const ratio = sentinelTime / baselineTime;
    return { ratio, drifted: Math.abs(ratio - 1) > DRIFT_TOL };
}

// --- scenario-major Williams schedule (M8, b251; per-scenario cycling D-b251-2) --------
// The per-row sweep used to build combos engine-major (all of engine 1's scenarios, then
// engine 2's, ...) and rotate the whole list by one slot per wave, so each wave ran one
// engine's rows contiguously in time: 30 of 1409 transitions changed engine, and a host
// that drifted mid-wave biased whole engines. buildScenarioMajor instead runs each
// scenario's engines back to back as one BLOCK, so every engine of a row sees the same
// host state. The engine order of a block is a row of a Williams design: over the full
// design every engine takes every block position equally often AND every ordered pair
// (X immediately before Y) occurs equally often. A plain cyclic rotation (ABC, BCA, CAB)
// is NOT enough -- it puts C after B in every block (carryover confounded, lesson b210).
// For odd n the design is the square plus its mirror: n = 3 -> all 6 permutations.
//
// PER SCENARIO (what a row's median sees): each scenario walks its own cycle of the design
// rows across waves -- one whole Latin square, then the other (odd n). Any prefix of that
// cycle is whole squares plus part of ONE Latin square, whose rows never share a position,
// so for ANY reps each engine sits at each block position floor(reps/n) or ceil(reps/n)
// times per scenario (reps = 10, n = 3 -> 3 or 4). Per-scenario ordered-pair counts are
// balanced only over whole design cycles (2n waves for odd n).
// POOLED (all scenarios together): which square comes first and the two start offsets
// (<= 2n^2 candidate cycles per scenario, n <= 8; a fixed formula above that) are chosen
// by a deterministic, bounded search -- greedy in scenario order, then at most 8 passes
// re-choosing one scenario with the rest fixed -- over the cost (pooled permutation-count
// spread beyond 1, cross-block self pairs = one engine's cold process last in a block and
// first in the next, pooled sum of squares, worst cross-block ordered-pair count). It runs
// once with that order and once with the first two terms swapped and keeps the better
// whole schedule. Pooled ordered-pair balance follows from the pooled permutation counts.
// Neither pooled balance nor zero self pairs is guaranteed for every (S, reps) (3 x 3 x 10:
// spread 2, 1 self pair); for the sweep's 3 x 47 x 10 the A1 probe pins permutation counts
// 79/79/78/78/78/78, within-block pairs 156..158 and 0 self pairs.
// Scenarios keep their list order within a wave and rotate between waves by
// floor(wave*S/reps) slots, so each scenario visits spread-out positions of the wave; a
// scenario's predecessor scenario is the same in every wave (except at the wrap).

const SCHEDULE_MAX_STEPS = 1000000;
const SCHEDULE_SEARCH_MAX_ENGINES = 8;

function checkNameList(what, list) {
    if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`schedule: ${what}s must be a non-empty array`);
    }
    const seen = new Set();
    for (const x of list) {
        if (typeof x !== "string" || x.length === 0) {
            throw new Error(`schedule: every ${what} must be a non-empty string (got ${JSON.stringify(x)})`);
        }
        if (seen.has(x)) throw new Error(`schedule: duplicate ${what} "${x}"`);
        seen.add(x);
    }
}

// Williams design over n treatments (indices 0..n-1). Base row 0, 1, n-1, 2, n-2, ...;
// row r adds r mod n (rows 0..n-1, a Latin square); odd n appends the reversed rows
// (rows n..2n-1, the mirror square, also Latin).
export function williamsRows(n) {
    if (!Number.isInteger(n) || n < 1) {
        throw new Error(`schedule: williamsRows needs an integer n >= 1 (got ${JSON.stringify(n)})`);
    }
    const base = [0];
    for (let lo = 1, hi = n - 1; base.length < n;) {
        base.push(lo++);
        if (base.length < n) base.push(hi--);
    }
    const rows = [];
    for (let r = 0; r < n; r++) rows.push(base.map((v) => (v + r) % n));
    if (n % 2 === 1 && n > 1) for (let r = 0; r < n; r++) rows.push(rows[r].slice().reverse());
    return rows;
}

// One scenario's cycle of design-row indices: square q from offset a in increasing row
// order, then (odd n) the other square from offset b in DECREASING row order (walking the
// mirror upward would put an engine last in one row and first in the next).
function scenarioCycle(n, odd, q, a, b) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(q * n + ((a + i) % n));
    if (odd) for (let i = 0; i < n; i++) out.push((1 - q) * n + ((b - i + n) % n));
    return out;
}

function lexLess(x, y) {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
}

// Choose every scenario's cycle (index into cands): greedy in scenario order, then up to 8
// refinement passes that re-choose one scenario with the rest fixed and keep a change only
// on a strict improvement. selfFirst swaps the first two cost terms. Returns the cycles
// and the final cost in the canonical order [pooled spread beyond 1, self pairs, pooled
// sum of squares, worst cross pair].
function planCycles(n, R, rows, cands, S, reps, pairsBy, touch, selfFirst) {
    const cyc = new Array(S).fill(null);
    const rowCount = new Array(R).fill(0);
    const pairCount = new Array(n * n).fill(0);
    const full = Math.floor(reps / R), part = reps % R;
    const addRows = (c, sign) => { for (let i = 0; i < R; i++) rowCount[c[i]] += sign * (full + (i < part ? 1 : 0)); };
    const addPairs = (tr, sign) => {
        let self = 0;
        for (let t = 0; t < tr.length; t += 4) {
            const ea = rows[cyc[tr[t]][tr[t + 1] % R]][n - 1];
            const eb = rows[cyc[tr[t + 2]][tr[t + 3] % R]][0];
            pairCount[ea * n + eb] += sign;
            if (ea === eb) self += sign;
        }
        return self;
    };
    const score = (self) => {
        let mn = Infinity, mx = -Infinity, sq = 0, worst = 0;
        for (let r = 0; r < R; r++) { const v = rowCount[r]; if (v < mn) mn = v; if (v > mx) mx = v; sq += v * v; }
        for (let k = 0; k < n * n; k++) if (pairCount[k] > worst) worst = pairCount[k];
        const over = mx - mn > 1 ? mx - mn - 1 : 0;
        return selfFirst ? [self, over, sq, worst] : [over, self, sq, worst];
    };
    // pick the best cycle for scenario s given `pairs` (the transitions to score) and the
    // self-pair count of everything else; leaves s applied and returns the new self total
    const choose = (s, pairs, rest, keep) => {
        let best = keep, bestCost = null;
        if (keep) { cyc[s] = keep; addRows(keep, 1); bestCost = score(rest + addPairs(pairs, 1)); addPairs(pairs, -1); addRows(keep, -1); }
        for (const c of cands) {
            if (c === keep) continue;
            cyc[s] = c;
            addRows(c, 1);
            const cost = score(rest + addPairs(pairs, 1));
            addPairs(pairs, -1);
            addRows(c, -1);
            if (bestCost === null || lexLess(cost, bestCost)) { best = c; bestCost = cost; }
        }
        cyc[s] = best;
        addRows(best, 1);
        return rest + addPairs(pairs, 1);
    };
    let selfTotal = 0;
    for (let s = 0; s < S; s++) selfTotal = choose(s, pairsBy[s], selfTotal, null);
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        for (let s = 0; s < S; s++) {
            const cur = cyc[s];
            addRows(cur, -1);
            const rest = selfTotal + addPairs(touch[s], -1);
            selfTotal = choose(s, touch[s], rest, cur);
            if (cyc[s] !== cur) changed = true;
        }
        if (!changed) break;
    }
    const c = score(selfTotal);
    return { cyc, cost: selfFirst ? [c[1], c[0], c[2], c[3]] : c };
}

// engines: string[]  scenarios: string[]  reps: integer >= 1 -> [{engine, scenario, rep}]
export function buildScenarioMajor(engines, scenarios, reps) {
    checkNameList("engine", engines);
    checkNameList("scenario", scenarios);
    if (!Number.isInteger(reps) || reps < 1) {
        throw new Error(`schedule: reps must be an integer >= 1 (got ${JSON.stringify(reps)})`);
    }
    const n = engines.length, S = scenarios.length;
    if (!(n * S * reps <= SCHEDULE_MAX_STEPS)) {
        throw new Error(`schedule: ${n} x ${S} x ${reps} steps exceeds ${SCHEDULE_MAX_STEPS}`);
    }
    const rows = williamsRows(n);
    const R = rows.length, odd = R > n;
    const off = [];
    for (let w = 0; w < reps; w++) off.push(Math.floor((w * S) / reps) % S);
    let cyc;
    if (n > SCHEDULE_SEARCH_MAX_ENGINES) {
        cyc = [];
        for (let s = 0; s < S; s++) cyc.push(scenarioCycle(n, odd, odd ? s % 2 : 0, (s >> 1) % n, (s >> 1) % n));
    } else {
        // time-adjacent block pairs (scenario a in wave wa -> scenario b in wave wb):
        // pairsBy[max(a, b)] for the greedy, touch[a] and touch[b] for the refinement
        const pairsBy = Array.from({ length: S }, () => []);
        const touch = Array.from({ length: S }, () => []);
        let ps = -1, pw = -1;
        for (let w = 0; w < reps; w++) {
            for (let k = 0; k < S; k++) {
                const s = (off[w] + k) % S;
                if (ps >= 0) {
                    pairsBy[Math.max(ps, s)].push(ps, pw, s, w);
                    touch[ps].push(ps, pw, s, w);
                    if (s !== ps) touch[s].push(ps, pw, s, w);
                }
                ps = s; pw = w;
            }
        }
        const cands = [];
        for (let q = 0; q < (odd ? 2 : 1); q++) {
            for (let a = 0; a < n; a++) for (let b = 0; b < (odd ? n : 1); b++) cands.push(scenarioCycle(n, odd, q, a, b));
        }
        // two cost orders; keep the better whole schedule (canonical order, ties -> pooled-first)
        const p = planCycles(n, R, rows, cands, S, reps, pairsBy, touch, false);
        const f = planCycles(n, R, rows, cands, S, reps, pairsBy, touch, true);
        cyc = lexLess(f.cost, p.cost) ? f.cyc : p.cyc;
    }
    const steps = [];
    for (let w = 0; w < reps; w++) {
        for (let k = 0; k < S; k++) {
            const s = (off[w] + k) % S;
            const row = rows[cyc[s][w % R]];
            for (let j = 0; j < n; j++) steps.push({ engine: engines[row[j]], scenario: scenarios[s], rep: w + 1 });
        }
    }
    return steps;
}
