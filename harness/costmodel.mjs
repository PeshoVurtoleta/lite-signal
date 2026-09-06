// costmodel.mjs
// Fits a linear cost model over bench/mirror.mjs CSV rows:
//
//     time_ms  ~=  a * nodesRecomputed + b * edgesTraversed + c * sinkReads + d
//
// and reports the coefficients as ns/unit, the fit quality, and -- the actual
// diagnostic payload -- the RESIDUALS: rows the linear model cannot explain
// are the shapes hiding a cost the counters do not carry (allocation bursts,
// flush-pass multiplication, cache effects). The 2026-08 audit's ground truth
// was that lite's structural work is byte-identical to alien/reflex on the
// dynamic suite, so the ENTIRE gap is per-unit CPU: this tool turns that gap
// into numbers per unit and locates the shapes where "per-unit" is not the
// whole story.
//
// --predict re-ranks the rows under hypothetical coefficients ("what would
// the table look like if per-recompute cost dropped 30%?") to aim engine work
// BEFORE writing it:
//
//     node harness/costmodel.mjs mirror-lite.csv
//     node harness/costmodel.mjs a.csv b.csv --predict nodesRecomputed=0.7
//
// Input: one or more files of bench/mirror.mjs stdout (stamp + 4-column CSV;
// rows from several frameworks may be mixed -- each framework is fit
// separately). SLOW/CAPPED rows are excluded from the fit (ceiling-truncated
// times poison a least-squares).
//
// NEVER a gate: exit 0 unless the input is unusable. Gates live in
// bench/torture and harness/VersionMatrix.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const predictIdx = args.indexOf("--predict");
const predictArg = predictIdx >= 0 ? args[predictIdx + 1] : null;
const files = args.filter((a, i) => !a.startsWith("--") && (predictIdx < 0 || i !== predictIdx + 1));
if (!files.length) {
    console.error("usage: node harness/costmodel.mjs <mirror.csv> [more.csv ...] [--predict key=scale[,key=scale]]");
    console.error("       keys: nodesRecomputed, edgesTraversed, sinkReads");
    process.exit(2);
}

/* -- parse -------------------------------------------------------------------- */
const REGRESSORS = ["nodesRecomputed", "edgesTraversed", "sinkReads"];
const rows = [];
let capped = 0;
for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim() || line.startsWith("#") || line.startsWith("framework")) continue;
        const parts = line.split(",");
        if (parts.length < 4) continue;
        const framework = parts[0].trim();
        const test = parts.slice(1, -2).join(",").trim();
        const time = parseFloat(parts[parts.length - 2]);
        const metrics = parts[parts.length - 1].trim();
        if (!Number.isFinite(time)) continue;
        if (/SLOW|CAPPED/.test(metrics) || /SLOW|CAPPED/.test(test)) { capped++; continue; }
        const m = {};
        for (const kv of metrics.split(/\s+/)) {
            const [k, v] = kv.split("=");
            if (k && v !== undefined) m[k] = Number(v);
        }
        if (!REGRESSORS.every((k) => Number.isFinite(m[k]))) continue;
        rows.push({ framework, test, time, m });
    }
}
if (!rows.length) { console.error("costmodel: no usable rows parsed"); process.exit(2); }
if (capped) console.log(`note: ${capped} SLOW/CAPPED row(s) excluded from the fit (ceiling-truncated times)`);

/* -- least squares (normal equations, k x k Gaussian elimination) -------------- */
function fit(X, y) {
    const k = X[0].length;
    const A = Array.from({ length: k }, () => new Float64Array(k));
    const b = new Float64Array(k);
    for (let r = 0; r < X.length; r++) {
        for (let i = 0; i < k; i++) {
            b[i] += X[r][i] * y[r];
            for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j];
        }
    }
    // Gaussian elimination with partial pivoting
    const idx = [...Array(k).keys()];
    for (let col = 0; col < k; col++) {
        let piv = col;
        for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        if (Math.abs(A[piv][col]) < 1e-12) return null;    // singular: collinear regressors
        [A[col], A[piv]] = [A[piv], A[col]];
        [b[col], b[piv]] = [b[piv], b[col]];
        void idx;
        for (let r = 0; r < k; r++) {
            if (r === col) continue;
            const f = A[r][col] / A[col][col];
            for (let j = col; j < k; j++) A[r][j] -= f * A[col][j];
            b[r] -= f * b[col];
        }
    }
    const coef = new Float64Array(k);
    for (let i = 0; i < k; i++) coef[i] = b[i] / A[i][i];
    return coef;
}

const byFw = {};
for (const r of rows) (byFw[r.framework] = byFw[r.framework] || []).push(r);

const predictScales = {};
if (predictArg) {
    for (const kv of predictArg.split(",")) {
        const [k, v] = kv.split("=");
        if (!REGRESSORS.includes(k) || !Number.isFinite(Number(v))) {
            console.error(`--predict: bad term "${kv}" (keys: ${REGRESSORS.join(", ")}; value = scale factor)`);
            process.exit(2);
        }
        predictScales[k] = Number(v);
    }
}

for (const [fw, R] of Object.entries(byFw)) {
    console.log(`\n=== ${fw} (${R.length} rows) ===`);
    if (R.length < REGRESSORS.length + 2) { console.log("  too few rows for a meaningful fit; need >= 5"); continue; }

    // nodesVisited note: in the mirror suite it tracks nodesRecomputed 1:1;
    // if that ever diverges the counters changed meaning -- say so.
    if (R.some((r) => Number.isFinite(r.m.nodesVisited) && r.m.nodesVisited !== r.m.nodesRecomputed)) {
        console.log("  note: nodesVisited diverges from nodesRecomputed in this data -- the visit cost is");
        console.log("        NOT folded into the recompute coefficient here; consider adding it as a regressor.");
    }

    // Collinearity check: near-collinear counters make the individual
    // coefficients variance-inflated even when the FIT predicts well -- the
    // mirror suite guarantees correlated counters (edges ~ 4x recomputes on
    // fan-in-4 shapes). Warn so nobody quotes a per-unit "cost" from a
    // direction the data barely spans (2026-08 review).
    for (let i = 0; i < REGRESSORS.length; i++) {
        for (let j = i + 1; j < REGRESSORS.length; j++) {
            const xi = R.map((r) => r.m[REGRESSORS[i]]), xj = R.map((r) => r.m[REGRESSORS[j]]);
            const mean = (v) => v.reduce((a, x) => a + x, 0) / v.length;
            const mi = mean(xi), mj = mean(xj);
            let num = 0, di = 0, dj = 0;
            for (let k = 0; k < xi.length; k++) { num += (xi[k] - mi) * (xj[k] - mj); di += (xi[k] - mi) ** 2; dj += (xj[k] - mj) ** 2; }
            const corr = di > 0 && dj > 0 ? num / Math.sqrt(di * dj) : 1;
            if (Math.abs(corr) > 0.95) {
                console.log(`  ! ${REGRESSORS[i]} and ${REGRESSORS[j]} are ${(corr * 100).toFixed(1)}% correlated across these rows --`);
                console.log(`    their individual coefficients are unstable; trust the FIT and residuals, not the split between them.`);
            }
        }
    }
    const X = R.map((r) => [...REGRESSORS.map((k) => r.m[k]), 1]);
    const y = R.map((r) => r.time);
    const coef = fit(X, y);
    if (!coef) { console.log("  singular system (collinear counters across these rows) -- cannot fit"); continue; }

    const pred = (m) => REGRESSORS.reduce((s, k, i) => s + coef[i] * m[k], 0) + coef[REGRESSORS.length];
    const yBar = y.reduce((a, v) => a + v, 0) / y.length;
    let ssRes = 0, ssTot = 0;
    for (const r of R) { const e = r.time - pred(r.m); ssRes += e * e; ssTot += (r.time - yBar) ** 2; }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

    console.log("  coefficients (time in ms):");
    REGRESSORS.forEach((k, i) => console.log(`    ${k.padEnd(16)} ${(coef[i] * 1e6).toFixed(2).padStart(9)} ns/unit`));
    console.log(`    ${"intercept".padEnd(16)} ${coef[REGRESSORS.length].toFixed(3).padStart(9)} ms/row`);
    console.log(`  R^2 = ${r2.toFixed(4)}  over ${R.length} rows`);

    const resid = R.map((r) => ({ r, e: r.time - pred(r.m), p: pred(r.m) }))
        .sort((a, b) => Math.abs(b.e) - Math.abs(a.e));
    console.log("  residuals (worst 6 -- shapes hiding costs the counters do not carry):");
    for (const { r, e, p } of resid.slice(0, 6)) {
        console.log(`    ${(e >= 0 ? "+" : "") + e.toFixed(2)}ms (actual ${r.time.toFixed(2)}, model ${p.toFixed(2)})  ${r.test.slice(0, 76)}`);
    }

    if (predictArg) {
        console.log(`  --predict ${predictArg}: hypothetical re-ranking`);
        const scaled = REGRESSORS.map((k, i) => coef[i] * (predictScales[k] !== undefined ? predictScales[k] : 1));
        const predH = (m) => REGRESSORS.reduce((s, k, i) => s + scaled[i] * m[k], 0) + coef[REGRESSORS.length];
        // Baseline rank uses the MODEL's prediction, not the measured time:
        // ranking actual-vs-hypothetical would report residual noise as
        // "movement" of the hypothetical change (2026-08 review).
        const before = [...R].sort((a, b) => pred(b.m) - pred(a.m));
        const rankBefore = new Map(before.map((r, i) => [r, i]));
        const after = [...R].sort((a, b) => predH(b.m) - predH(a.m));
        let totalOld = 0, totalNew = 0;
        for (const r of R) { totalOld += pred(r.m); totalNew += predH(r.m); }
        console.log(`    modeled total: ${totalOld.toFixed(1)}ms -> ${totalNew.toFixed(1)}ms (${((totalNew / totalOld - 1) * 100).toFixed(1)}%)`);
        console.log("    biggest movers (rank by cost, model time):");
        const movers = after.map((r, i) => ({ r, from: rankBefore.get(r), to: i }))
            .filter((x) => x.from !== x.to)
            .sort((a, b) => Math.abs(b.from - b.to) - Math.abs(a.from - a.to))
            .slice(0, 5);
        if (!movers.length) console.log("      (ranking unchanged)");
        for (const { r, from, to } of movers) {
            console.log(`      #${from + 1} -> #${to + 1}  ${pred(r.m).toFixed(2)}ms -> ${predH(r.m).toFixed(2)}ms  ${r.test.slice(0, 60)}`);
        }
    }
}
process.exit(0);
