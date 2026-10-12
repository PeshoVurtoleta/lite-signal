/**
 * @zakkster/lite-signal soak -- DEVELOPMENT DRIVER (chunk S1b). Not the soak: no JSONL, no gates, no
 * verdict. It runs N worlds of one lane through gen -> exec -> oracles and prints failures by
 * (oracle, sig), the first world seeds per sig, and the scenario counts.
 *
 *   node --expose-gc bench/soak/_dev-run.mjs <kernelDir|Signal.js> <LANE> <worlds> [seed] [cov-off:<scen>]
 *   node bench/soak/_dev-run.mjs --hash <kernelDir|Signal.js> <LANE> <worlds> [seed]
 *        prints the sha256 of the op scripts of those worlds (G0 determinism), runs nothing
 *   node bench/soak/_dev-run.mjs --replay <kernelDir|Signal.js> <LANE> <0xWORLDSEED> [large]
 *        runs one world with a trace and prints the failure, the scenario tags and the last ops
 *
 * World seeds: seeds.mjs seedFor(seed, laneIndex, cycle 0), then worldSeed(cycleSeed, w).
 */

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
let mode = 'run';
if (argv[0] === '--hash' || argv[0] === '--replay') mode = argv.shift().slice(2);
const [kArg, laneName, nArg, seedArg, extra] = argv;
if (!kArg || !laneName || !nArg) {
    process.stderr.write('usage: _dev-run.mjs [--hash|--replay] <kernel> <LANE> <worlds|0xSEED> [seed] [cov-off:<scenario>]\n');
    process.exit(2);
}
let kpath = resolve(kArg);
if (existsSync(kpath) && statSync(kpath).isDirectory()) kpath = join(kpath, 'Signal.js');
process.env.SOAK_KERNEL = kpath;

const { liteAdapter } = await import('./adapters/lite.mjs');
const { validateAdapter, applicability } = await import('./adapters/contract.mjs');
const { laneByName, isLargeWorld } = await import('./lanes/index.mjs');
const { generateWorld, scriptJson } = await import('./gen.mjs');
const { runWorld } = await import('./exec.mjs');
const { seedFor, worldSeed } = await import('./seeds.mjs');
const { KERNEL_FILES, KERNEL_KNOWN_AS } = await import('./kernel.mjs');

const desc = laneByName(laneName);
if (desc === null) { process.stderr.write('unknown lane ' + laneName + '\n'); process.exit(2); }
const problems = validateAdapter(liteAdapter);
if (problems.length) { process.stderr.write('adapter invalid: ' + problems.join('; ') + '\n'); process.exit(2); }
const app = applicability(desc, liteAdapter.caps);
if (app.status !== 'run') { process.stderr.write('lane ' + laneName + ' SKIPs on lite: ' + JSON.stringify(app) + '\n'); process.exit(2); }

const kernelTag = (KERNEL_KNOWN_AS || 'unknown') + ' ' + KERNEL_FILES[0].sha256.slice(0, 8);
const hex = (n) => '0x' + (n >>> 0).toString(16);
const SEED_CAP = Number(process.env.DEV_SEEDS || 3);   // world seeds printed per sig

if (mode === 'replay') {
    const ws = Number(nArg) >>> 0;
    const script = generateWorld(desc, ws, { large: seedArg === 'large' });
    const r = runWorld(liteAdapter, script, { trace: true });
    console.log('replay ' + laneName + ' world ' + hex(ws) + ' kernel ' + kernelTag + ' ops=' + r.ops);
    console.log(JSON.stringify(r.failure, null, 1));
    if (r.trace) for (const line of r.trace.slice(-6)) console.log('  ' + line.slice(0, 600));
    process.exit(0);
}

const N = Number(nArg) | 0;
const base = seedArg === undefined ? 0xC0FFEE : Number(seedArg) >>> 0;
const covOff = extra && extra.indexOf('cov-off:') === 0 ? extra.slice(8) : null;
if (covOff !== null && desc.covOff[covOff] === undefined) { process.stderr.write('cov-off:' + covOff + ' is not supported on ' + laneName + '\n'); process.exit(2); }
const cycleSeed = seedFor(base, desc.index, 0);

if (mode === 'hash') {
    const h = createHash('sha256');
    for (let w = 0; w < N; w++) {
        const ws = worldSeed(cycleSeed, w);
        h.update(scriptJson(generateWorld(desc, ws, { large: isLargeWorld(desc, w), covOff })));
        h.update('\n');
    }
    console.log('scripts ' + laneName + ' worlds=' + N + ' seed=' + hex(base) + ' sha256=' + h.digest('hex') + ' (kernel loaded: ' + kernelTag + ')');
    process.exit(0);
}

const t0 = performance.now();
const bySig = new Map();
const scen = Object.create(null);
// Cross-world totals here are plain numbers, capped at 0x3FFFFFFF on the per-world side, for DEV use only.
// The real soak's cross-world totals belong to S1c (main.mjs, Float64Array slots).
const checks = Object.create(null);
const skips = Object.create(null);
const gates = Object.create(null);
let ops = 0, failing = 0, crashes = 0, large = 0;
for (let w = 0; w < N; w++) {
    const ws = worldSeed(cycleSeed, w);
    const isLarge = isLargeWorld(desc, w);
    if (isLarge) large++;
    const script = generateWorld(desc, ws, { large: isLarge, covOff });
    let r;
    try {
        r = runWorld(liteAdapter, script);
    } catch (e) {
        crashes++;
        const k = 'CRASH ' + String(e && e.message ? e.message : e).slice(0, 80);
        const b = bySig.get(k) || { n: 0, seeds: [], scen: new Map() };
        b.n++;
        if (b.seeds.length < SEED_CAP) b.seeds.push(hex(ws));
        bySig.set(k, b);
        continue;
    }
    ops += r.ops;
    for (const k in r.scen) scen[k] = (scen[k] || 0) + r.scen[k];
    for (const k in r.checks) checks[k] = (checks[k] || 0) + r.checks[k];
    for (const k in r.skipTainted) skips[k] = (skips[k] || 0) + r.skipTainted[k];
    for (const k in r.gateHits) gates[k] = (gates[k] || 0) + r.gateHits[k];
    if (r.failure !== null) {
        failing++;
        for (const f of r.failure.fails) {
            const key = f.oracle + ':' + f.sig;
            const b = bySig.get(key) || { n: 0, seeds: [], scen: new Map(), detail: f.detail };
            b.n++;
            if (b.seeds.length < SEED_CAP) b.seeds.push(hex(ws) + (isLarge ? ' large' : '') + '@' + r.failure.step);
            for (const s of r.failure.scen) b.scen.set(s, (b.scen.get(s) || 0) + 1);
            bySig.set(key, b);
        }
    }
}
const ms = performance.now() - t0;
console.log('lane ' + laneName + ' kernel ' + kernelTag + ' worlds=' + N + ' (large ' + large + ') seed=' + hex(base) + (covOff ? ' cov-off:' + covOff : '') +
    ' ops=' + ops + ' failingWorlds=' + failing + ' crashes=' + crashes + ' wall=' + (ms / 1000).toFixed(1) + 's ops/s=' + Math.round(ops / (ms / 1000)));
console.log('checks performed ' + JSON.stringify(checks));
console.log('skipped (tainted) ' + JSON.stringify(skips) + '  gate hits ' + JSON.stringify(gates));
for (const [k, b] of [...bySig].sort((a, c) => c[1].n - a[1].n)) {
    const sc = [...b.scen].sort((a, c) => c[1] - a[1]).map(([s, n]) => s + ':' + n).join(',');
    console.log('  FAIL ' + String(b.n).padStart(6) + '  ' + k + '  seeds ' + b.seeds.join(' ') + (sc ? '  scen ' + sc : '') + (b.detail ? '\n           e.g. ' + b.detail : ''));
}
const missing = [];
console.log('scenarios (required):');
for (const s of desc.required) { console.log('  ' + String(scen[s] || 0).padStart(8) + '  ' + s); if (!scen[s]) missing.push(s); }
console.log('scenarios (optional):');
for (const s of desc.optional) console.log('  ' + String(scen[s] || 0).padStart(8) + '  ' + s);
const other = Object.keys(scen).filter((s) => desc.required.indexOf(s) === -1 && desc.optional.indexOf(s) === -1);
if (other.length) console.log('other scenarios seen: ' + other.map((s) => s + ':' + scen[s]).join(' '));
console.log('missing required: ' + (missing.length ? missing.join(',') : 'none'));
process.exitCode = failing > 0 || crashes > 0 ? 1 : 0;
