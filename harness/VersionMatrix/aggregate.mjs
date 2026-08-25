// Reduce N per-rep captures to a median summary per workload. Median (not mean)
// resists the occasional slow rep; gating on medians is what makes a tight
// frame.avg tolerance trustworthy despite single-run variance.
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const label = process.argv[2];
if (!label) { console.error('usage: node aggregate.mjs <label>'); process.exit(2); }
const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'));
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

for (const w of manifest.workloads) {
    const dir = `./baselines/${label}`;
    const reps = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(w + '.rep') && f.endsWith('.json')) : [];
    if (!reps.length) { console.error(`  ${w}: no reps`); continue; }
    const S = reps.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
    const med = JSON.parse(JSON.stringify(S[0]));
    for (const k of ['avg', 'min', 'max', 'p01', 'p99', 'fps', 'jankRatio', 'spikeRatio']) med.frame[k] = median(S.map((s) => s.frame[k]));
    for (const tag in med.phases) for (const k of ['avg', 'min', 'max', 'p01', 'p99', 'last']) med.phases[tag][k] = median(S.map((s) => s.phases[tag][k]));
    // COUNTER DETERMINISM (2026-08, creation-churn): counter channels carry the
    // engine's own exact allocation counters under a fixed LCG schedule, so
    // every rep must report BYTE-IDENTICAL values -- there is no host noise to
    // median away. Any cross-rep drift means broken instrumentation or a
    // nondeterministic engine; either way the capture is not evidence, and
    // gate.mjs refuses to judge on it (counterDrift below).
    // Tags are the UNION across ALL reps, not rep 1's set (2026-08 review: a
    // capture whose FIRST rep lacked the counters aggregated to counters={}
    // with counterDrift=0 -- the lane silently vanished from the baseline and
    // every downstream counter gate went vacuous, while the reverse rep order
    // was correctly refused. Presence itself must agree across reps.)
    let counterDrift = 0;
    const counterTags = {};
    for (const s of S) for (const tag in (s.counters || {})) counterTags[tag] = true;
    if (Object.keys(counterTags).length) {
        med.counters = med.counters || {};
        for (const tag in counterTags) {
            med.counters[tag] = med.counters[tag] || {};
            for (const k of ['sum', 'avg', 'min', 'max', 'p01', 'p99', 'last']) {
                const vals = S.map((s) => s.counters && s.counters[tag] ? s.counters[tag][k] : undefined);
                med.counters[tag][k] = median(vals.map((v) => (typeof v === 'number' ? v : NaN)));
                for (const v of vals) if (!Object.is(v, vals[0])) { counterDrift++; break; }
            }
        }
    }
    med.reps = S.length; med.aggregate = 'median';
    // EVIDENCE QUALITY (persisted for gate.mjs): spread across reps, and the
    // wall-clock span of the captures. A wide spread means the host was not
    // in one steady state; a wide span means reps from DIFFERENT SESSIONS
    // are being medianed together (manual run.mjs loops do not clean the
    // dir the way matrix.sh capture() does). Either way the median is not
    // evidence, and gate.mjs will refuse to judge on it.
    //
    // TRIMMED (2026-08): with n >= 5 reps, ONE rep is dropped -- the one
    // farthest from the median -- before computing the gated spread, and the
    // untrimmed value is persisted alongside as spreadRawPct. Rationale: the
    // raw (max-min)/median conflates "one bad rep" with "unstable host".
    // Measured across four independent same-host capture sessions,
    // broadcast-fanout drew exactly one 20-30%-slow rep per label (different
    // rep positions each time -- macOS core placement, not cold start) while
    // the other four reps sat within a few percent; the median the gate
    // judges on was stable across all four sessions. A median-of-5 tolerates
    // one outlier BY CONSTRUCTION, so evidence quality should too. A host
    // that is genuinely unstable fails the trimmed spread anyway (five
    // scattered reps stay scattered after dropping one).
    const avgs = S.map((s) => s.frame.avg);
    const rawSpread = (vals) => (Math.max(...vals) - Math.min(...vals)) / med.frame.avg * 100;
    const spreadRawPct = rawSpread(avgs);
    let gatedVals = avgs;
    if (avgs.length >= 5) {
        const m = median(avgs);
        let worst = 0;
        for (let i = 1; i < avgs.length; i++) if (Math.abs(avgs[i] - m) > Math.abs(avgs[worst] - m)) worst = i;
        gatedVals = avgs.filter((_, i) => i !== worst);
    }
    const spreadPct = rawSpread(gatedVals);
    const dates = S.map((s) => Date.parse(s.env && s.env.date || 0)).filter(Boolean);
    const spanMin = dates.length ? (Math.max(...dates) - Math.min(...dates)) / 60000 : 0;
    med.evidence = { spreadPct: +spreadPct.toFixed(1), spreadRawPct: +spreadRawPct.toFixed(1), captureSpanMinutes: +spanMin.toFixed(1), counterDrift };
    writeFileSync(`${dir}/${w}.json`, JSON.stringify(med, null, 2));
    const trimmedNote = avgs.length >= 5 && spreadRawPct - spreadPct > 5
        ? ` raw ${spreadRawPct.toFixed(1)}% trimmed->${spreadPct.toFixed(1)}% (1 outlier rep dropped)` : '';
    const warn = spreadPct > 15 ? '  !! SPREAD -- host unstable or mixed sessions; recapture before gating'
               : spanMin > 30 ? '  !! reps span ' + spanMin.toFixed(0) + ' min -- mixed sessions; recapture'
               : counterDrift > 0 ? '  !! COUNTER DRIFT -- exact counters differ across reps; instrumentation broken or engine nondeterministic'
               : '';
    console.error(`  ${w.padEnd(20)} median frame.avg=${med.frame.avg.toFixed(4)} p99=${med.frame.p99.toFixed(4)} (n=${med.reps}, avg-spread ${spreadPct.toFixed(1)}%${trimmedNote})${warn}`);
}
