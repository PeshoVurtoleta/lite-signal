// Two-baseline gate. A candidate must clear BOTH the never-moving floor
// (generous) and the previous published version (tight), on every workload.
// Reads baselines/<version>/<workload>.json captured same-host by matrix.sh.
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.

import { checkRegression } from '@zakkster/lite-profiler';
import { readFileSync, existsSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'));
const candidate = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0];
if (!candidate) { console.error('usage: node gate.mjs <candidate-label>'); process.exit(2); }

// --- semver precedence (no deps) -- for the successor guard below --------------
function parseSemver(v){const[c,pre]=String(v).split('-');const[maj,min,pat]=c.split('.').map(Number);return{maj,min,pat,pre:pre?pre.split('.'):[]};}
function cmpSemver(a,b){const A=parseSemver(a),B=parseSemver(b);
  if(A.maj!==B.maj)return A.maj-B.maj; if(A.min!==B.min)return A.min-B.min; if(A.pat!==B.pat)return A.pat-B.pat;
  if(!A.pre.length&&!B.pre.length)return 0; if(!A.pre.length)return 1; if(!B.pre.length)return -1;
  const n=Math.max(A.pre.length,B.pre.length);
  for(let i=0;i<n;i++){const x=A.pre[i],y=B.pre[i];
    if(x===undefined)return -1; if(y===undefined)return 1;
    const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);
    if(xn&&yn){const d=Number(x)-Number(y); if(d)return d;}
    else if(xn)return -1; else if(yn)return 1; else{ if(x<y)return -1; if(x>y)return 1; }}
  return 0;}
const candVersion = candidate.replace(/^candidate-/, '');

const { floor, rolling, workloads } = manifest;
const TF = manifest.tolerances.floor, TR = manifest.tolerances.rolling;
const load = (v, w) => { const p = `./baselines/${v}/${w}.json`; return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };

// Identical-code guard: if the candidate engine is byte-identical to a baseline
// engine, that axis is vacuous -- the two run the same code, so any measured delta
// is host noise, not a regression. Skip it rather than let variance flag a phantom.
// (Hashes are persisted per capture by matrix.sh as baselines/<label>/engine.sha256.)
const engHash = (v) => { const p = `./baselines/${v}/engine.sha256`; return existsSync(p) ? readFileSync(p, 'utf8').trim() : null; };
const candHash = engHash(candidate), floorHash = engHash(floor), rollingHash = engHash(rolling);
const short = (h) => (h ? h.slice(0, 8) : '--------');
const floorIdentical = !!(candHash && floorHash && candHash === floorHash);
const rollingIdentical = !!(candHash && rollingHash && candHash === rollingHash);
// Successor guard: a candidate cannot regress against a version RELEASED AFTER it.
// If a baseline is version-numerically newer than the candidate (e.g. cutting stable
// 1.4.0 while 1.5.0-alpha.1 exists on the rolling axis), comparing them measures the
// candidate against its own future -- the expected slowdown is not a regression. Skip
// that axis with a note, exactly like the identical-code skip.
const floorIsSuccessor = cmpSemver(candVersion, floor) < 0;
const rollingIsSuccessor = cmpSemver(candVersion, rolling) < 0;
const skipFloor = floorIdentical || floorIsSuccessor;
const skipRolling = rollingIdentical || rollingIsSuccessor;

console.error(`\ngate: candidate ${candidate}`);
console.error(`  floor   ${floor}      ${JSON.stringify(TF)}`);
console.error(`  rolling ${rolling}    ${JSON.stringify(TR)}\n`);
if (rollingIdentical) console.error(`  note: candidate is byte-identical to rolling ${rolling} (sha ${short(candHash)}) -- rolling axis skipped; identical code cannot regress\n`);
if (floorIdentical) console.error(`  note: candidate is byte-identical to floor ${floor} (sha ${short(candHash)}) -- floor axis skipped; identical code cannot regress\n`);
if (rollingIsSuccessor && !rollingIdentical) console.error(`  note: rolling ${rolling} is NEWER than candidate ${candVersion} -- rolling axis skipped; a version cannot regress against its own successor\n`);
if (floorIsSuccessor && !floorIdentical) console.error(`  note: floor ${floor} is NEWER than candidate ${candVersion} -- floor axis skipped; a version cannot regress against its own successor\n`);
console.error('workload               vs floor   vs rolling   verdict');
console.error('---------------------  ---------  -----------  -------');

// EVIDENCE GUARD: a verdict computed from unstable or mixed-session captures
// is not a verdict. If ANY side's aggregate (candidate, floor, rolling)
// carries spread > maxSpreadPct or a multi-session capture span, refuse to
// judge -- exit 3 ("recapture") so pre-publish can distinguish "regression"
// (exit 1) from "insufficient evidence" instead of aborting on host noise.
// This is what turns the moving-target FAIL (broadcast one run, deep-chain
// the next, PASS the third) into an explicit instruction.
const EV = (manifest.evidence || {});
const MAX_SPREAD = EV.maxSpreadPct !== undefined ? EV.maxSpreadPct : 15;
const MAX_SPAN = EV.maxCaptureSpanMinutes !== undefined ? EV.maxCaptureSpanMinutes : 30;
const MIN_REPS = EV.minReps !== undefined ? EV.minReps : 3;
let noEvidence = 0;
for (const w of workloads) {
    for (const [side, v] of [['candidate', candidate], ['floor', floor], ['rolling', rolling]]) {
        const s = load(v, w);
        if (!s) continue;
        const e = s.evidence || {};
        const bad = (e.spreadPct !== undefined && e.spreadPct > MAX_SPREAD) ? `spread ${e.spreadPct}% > ${MAX_SPREAD}%`
                  : (e.captureSpanMinutes !== undefined && e.captureSpanMinutes > MAX_SPAN) ? `capture span ${e.captureSpanMinutes}min > ${MAX_SPAN}min (mixed sessions)`
                  : (s.reps !== undefined && s.reps < MIN_REPS) ? `only ${s.reps} rep(s) < ${MIN_REPS}`
                  : null;
        if (bad) { console.error(`  ! NO EVIDENCE [${side} ${v} / ${w}]: ${bad}`); noEvidence++; }
    }
}
if (noEvidence) {
    console.error(`\nGATE REFUSED (${noEvidence} unstable capture(s)) -- RECAPTURE, do not treat as regression`);
    process.exit(3);
}

let failed = 0;
for (const w of workloads) {
    const cand = load(candidate, w);
    if (!cand) { console.error(`  ${w.padEnd(21)} MISSING candidate capture`); failed++; continue; }
    const fb = load(floor, w), rb = load(rolling, w);
    const fc = (fb && !skipFloor) ? checkRegression(fb, cand, TF) : { ok: true, regressions: [] };
    const rc = (rb && !skipRolling) ? checkRegression(rb, cand, TR) : { ok: true, regressions: [] };
    const ok = fc.ok && rc.ok;
    if (!ok) failed++;
    const fcL = skipFloor ? 'SKIP' : (fc.ok ? 'PASS' : 'FAIL');
    const rcL = skipRolling ? 'SKIP' : (rc.ok ? 'PASS' : 'FAIL');
    console.error(`  ${w.padEnd(21)}  ${fcL.padEnd(9)}  ${rcL.padEnd(11)}  ${ok ? 'PASS' : 'FAIL'}`);
    for (const [base, x] of [...fc.regressions.map((r) => ['floor', r]), ...rc.regressions.map((r) => ['rolling', r])]) {
        console.error(`      ! [${base}] ${x.metric}: ${x.baseline.toFixed(4)} -> ${x.candidate.toFixed(4)} (+${(x.change * 100).toFixed(1)}% > ${(x.tolerance * 100).toFixed(0)}%)`);
    }
}
console.error('');
if (failed) { console.error(`GATE FAILED (${failed} workload(s)) -- publish should abort`); process.exit(1); }
console.error('GATE PASSED');
process.exit(0);
