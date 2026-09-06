// Self-noise: two cold captures of the SAME version. The reported deltas are
// pure host noise (same code, same machine) -- gate tolerances must exceed them,
// or the gate red-lights on jitter.
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.

import { diffCaptures } from '@zakkster/lite-profiler';
import { readFileSync, existsSync } from 'node:fs';

const [A, B] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'));
const load = (v, w) => { const p = `./baselines/${v}/${w}.json`; return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
const metrics = ['frame.avg', 'frame.p99', 'phase.write.p99'];
const read = (d, m) => { const p = m.split('.'); return p[0] === 'frame' ? d.frame[p[1]] : (d.phases[p[1]] && d.phases[p[1]][p[2]]); };

console.error(`\nself-noise: ${A} vs ${B} (two cold captures of the same version)`);
console.error('gate tolerances must sit ABOVE these numbers.\n');
console.error('workload               ' + metrics.map((m) => m.padEnd(16)).join(''));
console.error('---------------------  ' + metrics.map(() => '--------------  ').join(''));
for (const w of manifest.workloads) {
    const a = load(A, w), b = load(B, w);
    if (!a || !b) { console.error(`  ${w.padEnd(21)} missing capture`); continue; }
    const d = diffCaptures(a, b);
    const cells = metrics.map((m) => { const x = read(d, m); return ((x && x.pct != null) ? (Math.abs(x.pct) * 100).toFixed(1) + '%' : 'n/a').padEnd(16); });
    console.error(`  ${w.padEnd(21)} ${cells.join('')}`);
}
console.error('');
