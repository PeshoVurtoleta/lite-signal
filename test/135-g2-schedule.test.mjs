// G2 (b251) -- bench/lib/schedule.mjs: scenario-major Williams schedule (A1 as amended by
// D-b251-2), williamsRows, the older exports, and the DRIFT_TOL import-time refusal.
// Expected values come from the PLAN-G2 ASSERTIONS / rulings, or are computed here by hand:
//   * 3 x 47 x 10 = 1410 steps = 470 blocks of 3; 6 permutations pooled 79/79/78/78/78/78;
//     within-block ordered pairs 156..158 (470 blocks x 2 adjacencies = 940 over 6 pairs);
//     cross-block self pairs 0 (D-b251-2 residual); per-scenario position counts 3 or 4
//     (floor/ceil of 10/3); cross-block carryover pairs 77..79 (reviewer range; the sum 469
//     = 470 blocks - 1 is exact arithmetic).
//   * wave offsets floor(w * 47 / 10) = 0 4 9 14 18 23 28 32 37 42 (by hand).
//   * williamsRows base row 0, 1, n-1, 2, n-2, ... ; row r = base + r mod n; odd n appends reversed rows.
// Old design (9e21cba engine-major): 30 of 1409 transitions change engine -> the row
// "all 1409 transitions change engine" fails there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SCHED_URL = pathToFileURL(join(here, "..", "bench", "lib", "schedule.mjs")).href;
delete process.env.DRIFT_TOL;
const SM = await import(SCHED_URL);
const { buildScenarioMajor, williamsRows, buildSchedule, scheduleLines, withSentinel, sentinelDrift, sentinelBaseline, DRIFT_TOL } = SM;

const ENG = ["alien", "lite", "reflex"];
const names = (p, n) => Array.from({ length: n }, (_, i) => p + i);
const SCEN = names("s", 47);
const big = buildScenarioMajor(ENG, SCEN, 10);

test("A1: 1410 steps, each scenario once per wave, its 3 engines contiguous, rep = wave + 1", () => {
    assert.equal(big.length, 1410);
    for (let w = 0; w < 10; w++) {
        const seen = new Set();
        for (let k = 0; k < 47; k++) {
            const blk = big.slice((w * 47 + k) * 3, (w * 47 + k) * 3 + 3);
            assert.equal(new Set(blk.map((x) => x.scenario)).size, 1, "block is one scenario");
            assert.equal(new Set(blk.map((x) => x.engine)).size, 3, "block has 3 distinct engines");
            assert.ok(blk.every((x) => x.rep === w + 1));
            assert.ok(!seen.has(blk[0].scenario), "scenario twice in a wave");
            seen.add(blk[0].scenario);
        }
        assert.equal(seen.size, 47);
    }
    const per = new Map();
    for (const s of big) per.set(s.engine + "|" + s.scenario, (per.get(s.engine + "|" + s.scenario) ?? 0) + 1);
    assert.equal(per.size, 141);
    for (const v of per.values()) assert.equal(v, 10);
});

test("A1: pooled permutation counts are two 79s and four 78s", () => {
    const c = new Map();
    for (let b = 0; b < 470; b++) {
        const k = big.slice(b * 3, b * 3 + 3).map((x) => x.engine[0]).join("");
        c.set(k, (c.get(k) ?? 0) + 1);
    }
    assert.equal(c.size, 6);
    assert.deepEqual([...c.values()].sort((a, b) => a - b), [78, 78, 78, 78, 79, 79]);
});

test("A1: within-block ordered pairs 156..158; cross-block self pairs 0; carryover pairs 77..79", () => {
    const within = new Map(), cross = new Map();
    let self = 0, change = 0;
    for (let i = 1; i < big.length; i++) {
        const a = big[i - 1].engine, b = big[i].engine;
        if (a !== b) change++;
        if (i % 3 === 0) { cross.set(a + b, (cross.get(a + b) ?? 0) + 1); if (a === b) self++; }
        else within.set(a + b, (within.get(a + b) ?? 0) + 1);
    }
    assert.equal(within.size, 6);
    for (const v of within.values()) assert.ok(v >= 156 && v <= 158, "within pair " + v);
    assert.equal([...within.values()].reduce((x, y) => x + y, 0), 940);
    assert.equal(self, 0);
    assert.equal(cross.size, 6);
    for (const v of cross.values()) assert.ok(v >= 77 && v <= 79, "carryover pair " + v);
    assert.equal([...cross.values()].reduce((x, y) => x + y, 0), 469);
    // old engine-major order: 30 of 1409 transitions change engine; here every one does
    assert.equal(change, 1409);
});

test("A1 + D-b251-2: per scenario, each engine takes each block position 3 or 4 of 10 times", () => {
    const pos = new Map();   // scenario|engine|position -> count
    for (let b = 0; b < 470; b++) for (let j = 0; j < 3; j++) {
        const s = big[b * 3 + j];
        const k = s.scenario + "|" + s.engine + "|" + j;
        pos.set(k, (pos.get(k) ?? 0) + 1);
    }
    for (const sc of SCEN) for (const e of ENG) for (let j = 0; j < 3; j++) {
        const v = pos.get(sc + "|" + e + "|" + j) ?? 0;
        assert.ok(v === 3 || v === 4, `${sc} ${e} position ${j}: ${v}`);
    }
});

test("A1: per-wave scenario offsets for S=47 reps=10 are pinned, scenarios rotate in list order", () => {
    const want = [0, 4, 9, 14, 18, 23, 28, 32, 37, 42];
    for (let w = 0; w < 10; w++) {
        for (let k = 0; k < 47; k++) {
            assert.equal(big[(w * 47 + k) * 3].scenario, SCEN[(want[w] + k) % 47], `wave ${w} block ${k}`);
        }
    }
});

test("per-scenario floor/ceil bound holds for smaller configs", () => {
    for (const [S, reps] of [[10, 3], [47, 1], [1, 5], [2, 3], [5, 7], [3, 12]]) {
        const sc = names("q", S);
        const st = buildScenarioMajor(ENG, sc, reps);
        assert.equal(st.length, 3 * S * reps);
        const pos = new Map();
        for (let i = 0; i < st.length; i++) {
            const k = st[i].scenario + "|" + st[i].engine + "|" + (i % 3);
            pos.set(k, (pos.get(k) ?? 0) + 1);
        }
        for (const s of sc) for (const e of ENG) for (let j = 0; j < 3; j++) {
            const v = pos.get(s + "|" + e + "|" + j) ?? 0;
            assert.ok(v === Math.floor(reps / 3) || v === Math.ceil(reps / 3), `(${S},${reps}) ${s} ${e} pos ${j}: ${v}`);
        }
    }
});

test("williamsRows: bad n throws; n=1, 3, 4 pinned", () => {
    for (const bad of [0, 1.5, "3", -1]) {
        assert.throws(() => williamsRows(bad), /schedule: williamsRows needs an integer n >= 1/);
    }
    assert.deepEqual(williamsRows(1), [[0]]);
    // n=3: base 0,1,2; +r mod 3; then the three rows reversed
    assert.deepEqual(williamsRows(3), [[0, 1, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 0, 2]]);
    // n=4 (even): base 0,1,3,2; +1, +2, +3 mod 4; no mirror square
    assert.deepEqual(williamsRows(4), [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]]);
});

test("williamsRows design validity (n = 3, 4, 5, 9): positions Latin, ordered pairs balanced", () => {
    for (const n of [3, 4, 5, 9]) {
        const rows = williamsRows(n);
        const odd = n % 2 === 1;
        assert.equal(rows.length, odd ? 2 * n : n);
        for (const sq of odd ? [0, 1] : [0]) {
            for (let p = 0; p < n; p++) {
                const col = rows.slice(sq * n, sq * n + n).map((r) => r[p]);
                assert.equal(new Set(col).size, n, `n=${n} square ${sq} position ${p}`);
            }
        }
        const pairs = new Map();
        for (const r of rows) for (let j = 0; j + 1 < n; j++) pairs.set(r[j] + ">" + r[j + 1], (pairs.get(r[j] + ">" + r[j + 1]) ?? 0) + 1);
        assert.equal(pairs.size, n * (n - 1));
        for (const v of pairs.values()) assert.equal(v, odd ? 2 : 1);
    }
});

test("buildScenarioMajor: n > 8 fallback (no search) is a valid design with pinned first blocks", () => {
    const E9 = names("e", 9);
    const st = buildScenarioMajor(E9, ["x", "y", "z", "w"], 18);
    assert.equal(st.length, 9 * 4 * 18);
    const blockEngines = (i) => st.slice(i * 9, i * 9 + 9).map((s) => s.engine);
    const idx = (arr) => arr.map((e) => Number(e.slice(1)));
    // wave 0, scenarios in list order: x = square 0 row 0 (the base row), y = first mirror row
    // (reversed base), z = square 0 row 1 (base + 1 mod 9)
    assert.deepEqual(idx(blockEngines(0)), [0, 1, 8, 2, 7, 3, 6, 4, 5]);
    assert.deepEqual(idx(blockEngines(1)), [5, 4, 6, 3, 7, 2, 8, 1, 0]);
    assert.deepEqual(idx(blockEngines(2)), [1, 2, 0, 3, 8, 4, 7, 5, 6]);
    // validity: per scenario over a full 2n = 18 wave cycle, each engine takes each position
    // exactly 2 times and each ordered within-block pair exactly 2 times
    const pos = new Map(), pr = new Map();
    for (let b = 0; b < 4 * 18; b++) {
        const blk = st.slice(b * 9, b * 9 + 9);
        const sc = blk[0].scenario;
        assert.ok(blk.every((x) => x.scenario === sc));
        for (let j = 0; j < 9; j++) {
            const k = sc + "|" + blk[j].engine + "|" + j;
            pos.set(k, (pos.get(k) ?? 0) + 1);
            if (j > 0) { const q = sc + "|" + blk[j - 1].engine + ">" + blk[j].engine; pr.set(q, (pr.get(q) ?? 0) + 1); }
        }
    }
    assert.equal(pos.size, 4 * 9 * 9);
    for (const v of pos.values()) assert.equal(v, 2);
    assert.equal(pr.size, 4 * 72);
    for (const v of pr.values()) assert.equal(v, 2);
});

test("buildScenarioMajor: bad inputs throw", () => {
    const ok = ["a", "b"];
    assert.throws(() => buildScenarioMajor([], ok, 1), /schedule: engines must be a non-empty array/);
    assert.throws(() => buildScenarioMajor(ok, [], 1), /schedule: scenarios must be a non-empty array/);
    assert.throws(() => buildScenarioMajor(["a", "a"], ok, 1), /schedule: duplicate engine "a"/);
    assert.throws(() => buildScenarioMajor(ok, ["s", "s"], 1), /schedule: duplicate scenario "s"/);
    assert.throws(() => buildScenarioMajor(["a", ""], ok, 1), /schedule: every engine must be a non-empty string/);
    assert.throws(() => buildScenarioMajor(ok, ["s", 3], 1), /schedule: every scenario must be a non-empty string/);
    assert.throws(() => buildScenarioMajor("ab", ok, 1), /engines must be a non-empty array/);
    for (const bad of [0, 1.5, -1, "3", NaN, undefined]) {
        assert.throws(() => buildScenarioMajor(ok, ok, bad), /schedule: reps must be an integer >= 1/);
    }
    // 4 x 500 x 501 = 1,002,000 steps > 1,000,000
    assert.throws(() => buildScenarioMajor(names("e", 4), names("s", 500), 501), /schedule: 4 x 500 x 501 steps exceeds 1000000/);
    // a minimal valid call: 2 engines, 1 scenario, 2 reps = rows [0,1] then [1,0]
    assert.deepEqual(buildScenarioMajor(ok, ["x"], 2).map((s) => s.engine + s.rep), ["a1", "b1", "b2", "a2"]);
});

test("buildSchedule / scheduleLines / withSentinel / sentinelDrift", () => {
    const s = buildSchedule(["a", "b", "c"], 3);
    assert.deepEqual(s.map((x) => x.engine + x.rep + ":" + x.wave + ":" + x.index),
        ["a1:0:0", "b1:0:1", "c1:0:2", "b2:1:3", "c2:1:4", "a2:1:5", "c3:2:6", "a3:2:7", "b3:2:8"]);
    assert.deepEqual(scheduleLines(["a", "b"], 2), ["a 1", "b 1", "b 2", "a 2"]);
    const w = withSentinel(buildSchedule(["a", "b"], 1));
    assert.equal(w.length, 3);
    assert.deepEqual(w[2], { engine: "a", rep: "sentinel", wave: -1, index: 2, sentinel: true });
    assert.deepEqual(withSentinel([]), []);
    assert.equal(DRIFT_TOL, 0.05);
    assert.equal(sentinelDrift(100, 104).drifted, false);
    assert.equal(sentinelDrift(100, 106).drifted, true);
    assert.equal(sentinelDrift(100, 96).drifted, false);
    assert.equal(sentinelDrift(100, 94).drifted, true);
    assert.equal(sentinelDrift(100, 104).ratio, 1.04);
});

// b254 SENTINEL-FIX (D-b254-1): baseline = median of the first combo's REPS reps.
test("sentinelBaseline: median of all REPS reps (odd, even, and a mean-killing skew)", () => {
    assert.deepEqual(sentinelBaseline([3, 1, 2], 3), { ok: true, median: 2, n: 3 });
    // even n averages the two middles (2 and 3): kills a single-middle mutant
    assert.deepEqual(sentinelBaseline([4, 1, 3, 2], 4), { ok: true, median: 2.5, n: 4 });
    // median 2, mean 13/3: kills a mean mutant
    assert.deepEqual(sentinelBaseline([1, 2, 10], 3), { ok: true, median: 2, n: 3 });
    assert.deepEqual(sentinelBaseline([5], 1), { ok: true, median: 5, n: 1 });
});
test("sentinelBaseline: refuses a wrong count, a non-array, bad reps, and every non-finite / <= 0 time", () => {
    assert.deepEqual(sentinelBaseline([1, 2], 3), { ok: false, reason: "baseline needs 3 of 3 first-combo reps, got 2" });
    assert.deepEqual(sentinelBaseline([1, 2, 3, 4], 3), { ok: false, reason: "baseline needs 3 of 3 first-combo reps, got 4" });
    assert.deepEqual(sentinelBaseline([], 2), { ok: false, reason: "baseline needs 2 of 2 first-combo reps, got 0" });
    assert.deepEqual(sentinelBaseline("5,5", 2), { ok: false, reason: "baseline needs an array of first-combo rep times" });
    assert.deepEqual(sentinelBaseline(null, 2), { ok: false, reason: "baseline needs an array of first-combo rep times" });
    for (const [bad, txt] of [[0, "0"], [1.5, "1.5"], [-1, "-1"], ["2", "\"2\""], [NaN, "null"], [undefined, "undefined"]]) {
        assert.deepEqual(sentinelBaseline([5, 5], bad), { ok: false, reason: `baseline reps must be an integer >= 1 (got ${txt})` });
    }
    for (const [v, txt] of [[NaN, "NaN"], [Infinity, "Infinity"], [0, "0"], [-1, "-1"], [-Infinity, "-Infinity"], ["5", "5"], [null, "null"]]) {
        assert.deepEqual(sentinelBaseline([5, v], 2), { ok: false, reason: `first-combo rep 2 time ${txt} is not a finite positive number` });
        assert.deepEqual(sentinelBaseline([v, 5, 5], 3), { ok: false, reason: `first-combo rep 1 time ${txt} is not a finite positive number` });
    }
});
test("sentinelBaseline: b253 replays are stable against the median; the old rep-1 guard flagged both", () => {
    const r1 = sentinelBaseline([198.20, 187.36, 188.03, 190.52, 188.78, 186.19, 189.64, 187.86, 191.44, 185.74], 10);
    assert.equal(r1.ok, true);
    assert.ok(Math.abs(r1.median - 188.405) < 1e-9, String(r1.median));
    const d1 = sentinelDrift(r1.median, 187.85);
    assert.equal(d1.ratio.toFixed(3), "0.997");
    assert.equal(d1.drifted, false);
    assert.equal(sentinelDrift(198.20, 187.85).drifted, true);   // the old trap, pinned
    const r2 = sentinelBaseline([173.84, 187.63, 192.50, 192.71, 190.52, 187.37, 188.64, 187.61, 188.82, 187.51], 10);
    assert.equal(r2.ok, true);
    assert.ok(Math.abs(r2.median - 188.135) < 1e-9, String(r2.median));
    const d2 = sentinelDrift(r2.median, 191.08);
    assert.equal(d2.ratio.toFixed(3), "1.016");
    assert.equal(d2.drifted, false);
    assert.equal(sentinelDrift(173.84, 191.08).drifted, true);   // the old trap, pinned
    // boundary: median 100 (mean is 100 too); DRIFT_TOL 0.05
    const b = sentinelBaseline([100, 90, 110], 3);
    assert.equal(b.median, 100);
    assert.equal(sentinelDrift(b.median, 105.1).drifted, true);
    assert.equal(sentinelDrift(b.median, 104.9).drifted, false);
});

// DRIFT_TOL is validated at import: child processes, killed on timeout.
function driftChild(env) {
    const e = { ...process.env }; delete e.DRIFT_TOL;
    if (env !== undefined) e.DRIFT_TOL = env;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
        `import(${JSON.stringify(SCHED_URL)}).then((m) => console.log("TOL=" + m.DRIFT_TOL))`],
    { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", env: e });
    assert.equal(r.signal, null);
    return r;
}
test("DRIFT_TOL: unset -> 0.05; \"0.15\" -> 0.15", () => {
    let r = driftChild(undefined);
    assert.equal(r.status, 0); assert.equal(r.stdout, "TOL=0.05\n");
    r = driftChild("0.15");
    assert.equal(r.status, 0); assert.equal(r.stdout, "TOL=0.15\n");
});
for (const bad of ["5%", "", "0", "1", "-0.1", "NaN"]) {
    test(`DRIFT_TOL=${JSON.stringify(bad)} throws at import`, () => {
        const r = driftChild(bad);
        assert.equal(r.status, 1);
        assert.equal(r.stdout, "");
        assert.match(r.stderr, /schedule: DRIFT_TOL must be a decimal fraction in \(0,1\)/);
    });
}

// Regression pin (values read once from the reviewed schedule.mjs f2e52d97, not from the spec): the
// search residuals [pooled permutation spread, cross-block self pairs, worst cross-block pair] of
// small configs with 3 engines. They kill the cost-term / refinement / tie-break mutants that the
// 3 x 47 x 10 rows cannot see (D-b251-2: the residual self count is pinned).
test("regression pin: search residuals [spread, self pairs, worst carryover] at small configs", () => {
    const resid = (S, reps) => {
        const st = buildScenarioMajor(ENG, names("s", S), reps);
        const perm = new Map(), cross = new Map();
        let self = 0;
        for (let b = 0; b < st.length / 3; b++) {
            const k = st.slice(b * 3, b * 3 + 3).map((x) => x.engine).join();
            perm.set(k, (perm.get(k) ?? 0) + 1);
            if (b > 0) { const a = st[b * 3 - 1].engine, c = st[b * 3].engine; if (a === c) self++; cross.set(a + ">" + c, (cross.get(a + ">" + c) ?? 0) + 1); }
        }
        const v = [...perm.values()];
        return [Math.max(...v) - Math.min(...v), self, Math.max(...cross.values())];
    };
    const want = { "2,4": [1, 1, 2], "4,2": [1, 2, 2], "4,4": [1, 0, 3], "2,7": [1, 2, 3], "2,8": [1, 2, 3], "2,9": [0, 3, 3] };
    for (const [k, w] of Object.entries(want)) assert.deepEqual(resid(...k.split(",").map(Number)), w, "S,reps = " + k);
});
