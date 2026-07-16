// Reduce N per-rep captures to a median summary per workload. Median (not mean)
// resists the occasional slow rep; gating on medians is what makes a tight
// frame.avg tolerance trustworthy despite single-run variance.
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const label = process.argv[2];
if (!label) { console.error('usage: node aggregate.mjs <label>'); process.exit(2); }
const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'));
const MIN_REPS = (manifest.evidence && manifest.evidence.minReps !== undefined) ? manifest.evidence.minReps : 3;
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

for (const w of manifest.workloads) {
    const dir = `./baselines/${label}`;
    const reps = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(w + '.rep') && f.endsWith('.json')) : [];
    if (!reps.length) { console.error(`  ${w}: no reps`); continue; }
    const S = reps.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
    const med = JSON.parse(JSON.stringify(S[0]));
    for (const k of ['avg', 'min', 'max', 'p01', 'p99', 'fps', 'jankRatio', 'spikeRatio']) med.frame[k] = median(S.map((s) => s.frame[k]));
    for (const tag in med.phases) for (const k of ['avg', 'min', 'max', 'p01', 'p99', 'last']) med.phases[tag][k] = median(S.map((s) => s.phases[tag][k]));
    med.reps = S.length; med.aggregate = 'median';
    // EVIDENCE QUALITY (persisted for gate.mjs): spread across reps, and the
    // wall-clock span of the captures. A wide spread means the host was not
    // in one steady state; a wide span means reps from DIFFERENT SESSIONS
    // are being medianed together (manual run.mjs loops do not clean the
    // dir the way matrix.sh capture() does). Either way the median is not
    // evidence, and gate.mjs will refuse to judge on it.
    const dates = S.map((s) => Date.parse(s.env && s.env.date || 0)).filter(Boolean);
    const spanMin = dates.length ? (Math.max(...dates) - Math.min(...dates)) / 60000 : 0;
    // A sub-minReps aggregate must NOT report spreadPct:0 -- a single sample has
    // zero spread by construction, which would masquerade as a perfectly stable
    // capture and sail past the evidence guard's spread check. Flag it explicitly
    // and leave spreadPct null so the ONLY thing gate.mjs can key on is reps<minReps
    // (-> exit 3 RECAPTURE). This closes the thin-baseline hole at the source.
    const insufficient = S.length < MIN_REPS;
    const spreadPct = insufficient ? null
        : (Math.max(...S.map((s) => s.frame.avg)) - Math.min(...S.map((s) => s.frame.avg))) / med.frame.avg * 100;
    med.evidence = {
        spreadPct: spreadPct === null ? null : +spreadPct.toFixed(1),
        captureSpanMinutes: +spanMin.toFixed(1),
        insufficientReps: insufficient || undefined,
        minReps: MIN_REPS,
    };
    writeFileSync(`${dir}/${w}.json`, JSON.stringify(med, null, 2));
    const warn = insufficient ? `  !! ONLY ${S.length} rep(s) < ${MIN_REPS} -- NOT evidence; gate will exit 3 (recapture)`
               : spreadPct > 15 ? '  !! SPREAD -- host unstable or mixed sessions; recapture before gating'
               : spanMin > 30 ? '  !! reps span ' + spanMin.toFixed(0) + ' min -- mixed sessions; recapture'
               : '';
    const spreadStr = spreadPct === null ? 'n/a' : spreadPct.toFixed(1) + '%';
    console.error(`  ${w.padEnd(20)} median frame.avg=${med.frame.avg.toFixed(4)} p99=${med.frame.p99.toFixed(4)} (n=${med.reps}, avg-spread ${spreadStr})${warn}`);
}
