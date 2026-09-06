// Diagnostic view over committed baselines: each history version vs the floor,
// per workload, on the gated metrics. Writes matrix-report.json for CHANGELOG use.
//
// NOTE: committed baselines may have been captured on different hosts, so this is
// a diagnostic / public-evidence view, NOT the gate. The gate (gate.mjs, driven by
// matrix.sh) re-captures floor + rolling + candidate on one host in one run.
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.

import { diffCaptures } from '@zakkster/lite-profiler';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'));
const { floor, rolling, history, workloads } = manifest;
const load = (v, w) => { const p = `./baselines/${v}/${w}.json`; return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
const metrics = ['frame.avg', 'frame.p99', 'phase.write.p99'];
const read = (d, m) => { const p = m.split('.'); return p[0] === 'frame' ? d.frame[p[1]] : (d.phases[p[1]] && d.phases[p[1]][p[2]]); };
const pct = (x) => (x && x.pct != null) ? ((x.pct >= 0 ? '+' : '') + (x.pct * 100).toFixed(1) + '%') : 'n/a';

const report = { generatedAt: new Date().toISOString(), floor, rolling, note: 'diagnostic over committed baselines; may be cross-host; not the gate', workloads: {} };
console.error(`\ndiagnostic: history vs floor ${floor}  (committed baselines -- cross-host possible, not the gate)\n`);
for (const w of workloads) {
    const fb = load(floor, w);
    console.error(`  ${w}`);
    report.workloads[w] = {};
    for (const v of history) {
        const cap = load(v, w);
        if (!cap || !fb) { console.error(`    ${v.padEnd(18)} (missing)`); continue; }
        const d = diffCaptures(fb, cap);
        const cells = metrics.map((m) => `${m.split('.').slice(-2).join('.')}=${pct(read(d, m))}`);
        const host = cap.env ? ` [${cap.env.cpu ? cap.env.cpu.split(' ').slice(0, 3).join(' ') : '?'}, node ${cap.env.node}]` : '';
        console.error(`    ${v.padEnd(18)} ${cells.join('  ')}${v === rolling ? '  <- rolling' : ''}${v === floor ? '  <- floor' : ''}`);
        report.workloads[w][v] = { vsFloor: Object.fromEntries(metrics.map((m) => [m, read(d, m) ? read(d, m).pct : null])), env: cap.env || null };
    }
}
writeFileSync('./matrix-report.json', JSON.stringify(report, null, 2));
console.error('\n  wrote matrix-report.json');
