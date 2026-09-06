// Profile the installed (or --engine=<path>) lite-signal across one or all
// workloads in a cold process, writing baselines/<label>/<workload>.json with
// environment metadata attached. One engine per process => no contamination.
//
// Usage: node run.mjs <label> [workload|all] [--engine=<specifier-or-path>]
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.

import { Profiler, summarize } from '@zakkster/lite-profiler';
import { profile, envMeta } from './lib/capture.mjs';
import { get, NAMES } from './workloads/index.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const label = positional[0];
const wname = positional[1];
let enginePath = '@zakkster/lite-signal';
let rep = null;
for (const a of args) { let m = /^--engine=(.+)$/.exec(a); if (m) enginePath = m[1]; m = /^--rep=(\d+)$/.exec(a); if (m) rep = m[1]; }

if (!label || !wname) {
    console.error('usage: node run.mjs <label> <workload> [--engine=<specifier-or-path>]');
    console.error('       workloads: ' + NAMES.join(', '));
    console.error('       (one workload per process -- the driver loops; keeps each cold and under the node pool cap)');
    process.exit(1);
}

const E = await import(/^[./]/.test(enginePath) ? pathToFileURL(resolve(enginePath)).href : enginePath);
mkdirSync('./baselines/' + label, { recursive: true });
const env = envMeta();

{
    const w = get(wname);
    const { summary, sink } = profile(Profiler, summarize, w, E, { label: wname, engine: 'lite-signal@' + label }, null);
    summary.env = env;
    const outPath = rep ? `./baselines/${label}/${wname}.rep${rep}.json` : `./baselines/${label}/${wname}.json`;
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    const f = summary.frame;
    const phaseCells = Object.keys(summary.phases).map((t) => `${t}.p99=${summary.phases[t].p99.toFixed(4)}`).join('  ');
    const counterCells = summary.counters && Object.keys(summary.counters).length
        ? '  ' + Object.keys(summary.counters).map((t) => `${t}=${summary.counters[t].max}`).join('  ') : '';
    console.error(
        `  [${label} / ${wname.padEnd(20)}] frame.avg=${f.avg.toFixed(4)}ms  p99=${f.p99.toFixed(4)}ms  ` +
        `${phaseCells}${counterCells}  sink=${sink.toFixed(0)}`
    );
}
