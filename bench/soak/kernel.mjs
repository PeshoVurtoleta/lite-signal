/**
 * @zakkster/lite-signal soak -- the KERNEL SEAM (SPEC-B v2 section 3.1; lite-pick kernel.mjs:15-19).
 *
 * Every soak module reaches the lite kernel only through this module. By default it loads the in-tree
 * ../../Signal.js; SOAK_KERNEL=<path> swaps in a scratch or control copy. That seam is what lets the
 * must-fail battery drive a one-line mutant through the REAL main.mjs.
 *
 * A kernel is a DIRECTORY PAIR: Signal.js re-exports ./Watch.js and Watch.js imports ./Signal.js, so the
 * file must be named Signal.js and a sibling Watch.js must exist. Every violation exits 2 with one
 * `soak: CONFIG --` line, before any record. The path is resolved ONCE (realpath, so the hashed files are
 * the files the import actually loads: lite-pick hashed the wrong file once, S6 / L27).
 *
 * Exports: K (module namespace), KERNEL_URL, KERNEL_DIR, KERNEL_OVERRIDE, KERNEL_FILES [{path, sha256}]
 * (Signal.js, Watch.js), KERNEL_KNOWN_AS (a controls.json control name when BOTH hashes match, else null),
 * CONTROLS_ERROR (null, or why controls.json could not be read), KERNEL_NEARWRAP (null, or the NEARWRAP record).
 *
 * NEARWRAP (S2 task 10): SOAK_NEARWRAP=<sign|zero>:<k> derives a kernel from the resolved base Signal.js
 * (nearwrap.mjs derive: census counters preset to ceiling - k), writes it with a copy of the base Watch.js to
 * bench/soak/out/nearwrap/<derived Signal.js sha7>-<Watch.js sha7>/ (git-ignored; both hashed in memory before
 * any write, so two runs that share a folder write byte-identical files) and loads THAT pair: KERNEL_URL / KERNEL_DIR /
 * KERNEL_FILES describe the derived files, so header kernel.files[0].sha256 == nearwrap.derivedSha256 and the
 * tree-parity pin never matches (never release evidence). KERNEL_OVERRIDE still means "SOAK_KERNEL was set".
 *
 * Uses top-level await. COLD module.
 */

import { existsSync, readFileSync, realpathSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { configExit, parseNearwrap, SoakConfigError } from './config.mjs';
import { derive } from './nearwrap.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const envKernel = process.env.SOAK_KERNEL;
const envEngine = process.env.SOAK_ENGINE;
const envNearwrap = process.env.SOAK_NEARWRAP;

export const KERNEL_OVERRIDE = envKernel !== undefined;
if (KERNEL_OVERRIDE && envKernel === '') configExit("SOAK_KERNEL='' is not a path");
// The seam is lite-only; alien and polyfill load from exact-pinned devDependencies (v2 section 3.1).
if (KERNEL_OVERRIDE && envEngine !== undefined && envEngine !== 'lite') {
    configExit("SOAK_KERNEL is the lite-only kernel seam; it cannot be combined with SOAK_ENGINE='" + envEngine + "'");
}
if (envNearwrap !== undefined && envEngine !== undefined && envEngine !== 'lite') {
    configExit("SOAK_NEARWRAP derives the lite kernel; it cannot be combined with SOAK_ENGINE='" + envEngine + "'");
}

const requested = KERNEL_OVERRIDE ? resolve(envKernel) : join(ROOT, 'Signal.js');
if (!existsSync(requested) || !statSync(requested).isFile()) configExit('SOAK_KERNEL: kernel file not found: ' + requested);
const kernelPath = realpathSync(requested);
if (basename(kernelPath) !== 'Signal.js') {
    configExit('SOAK_KERNEL: the kernel file must be named Signal.js (got ' + basename(kernelPath) + '); Watch.js imports ./Signal.js');
}
const baseDir = dirname(kernelPath);
const baseWatch = join(baseDir, 'Watch.js');
if (!existsSync(baseWatch)) {
    configExit('SOAK_KERNEL: sibling Watch.js missing in ' + baseDir + ' (scratch kernels are a Signal.js + Watch.js directory pair)');
}

/** Write `text` to `path` through a same-directory temp file + rename (a concurrent run never reads a half file). */
function writeAtomic(path, text) {
    const tmp = path + '.' + process.pid + '.tmp';
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}

let nearwrap = null;
let loadPath = kernelPath;
if (envNearwrap !== undefined) {
    let opts, d, watchBytes;
    try {
        opts = parseNearwrap(envNearwrap);
        d = derive(readFileSync(kernelPath, 'utf8'), { phase: opts.phase, k: opts.k });
        watchBytes = readFileSync(baseWatch);
    } catch (e) {
        if (e instanceof SoakConfigError) configExit(e.message);
        throw e;
    }
    const watchSha = createHash('sha256').update(watchBytes).digest('hex');
    const dir = join(ROOT, 'bench', 'soak', 'out', 'nearwrap', d.derivedSha256.slice(0, 7) + '-' + watchSha.slice(0, 7));
    try {
        mkdirSync(dir, { recursive: true });
        writeAtomic(join(dir, 'Signal.js'), d.text);
        writeAtomic(join(dir, 'Watch.js'), watchBytes);
    } catch (e) {
        configExit('SOAK_NEARWRAP: cannot write the derived kernel to ' + dir + ': ' + String(e && e.message ? e.message : e).split('\n')[0]);
    }
    loadPath = realpathSync(join(dir, 'Signal.js'));
    nearwrap = Object.freeze({
        phase: opts.phase, k: opts.k, rewrites: Object.freeze(d.rewrites.map((r) => Object.freeze(r))),
        baseSha256: d.baseSha256, derivedSha256: d.derivedSha256,
    });
}
export const KERNEL_NEARWRAP = nearwrap;
export const KERNEL_DIR = dirname(loadPath);
const watchPath = join(KERNEL_DIR, 'Watch.js');

export const KERNEL_URL = pathToFileURL(loadPath).href;

let mod;
try {
    mod = await import(KERNEL_URL);
} catch (e) {
    configExit((nearwrap !== null ? 'SOAK_NEARWRAP: derived ' : 'SOAK_KERNEL: ') + 'kernel failed to load: ' + String(e && e.message ? e.message : e).split('\n')[0]);
}
if (typeof mod.createRegistry !== 'function') configExit('SOAK_KERNEL: ' + loadPath + ' does not export createRegistry()');
export const K = mod;

function sha256(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export const KERNEL_FILES = Object.freeze([
    Object.freeze({ path: loadPath, sha256: sha256(loadPath) }),
    Object.freeze({ path: watchPath, sha256: sha256(watchPath) }),
]);

let knownAs = null;
let controlsError = null;
try {
    const c = JSON.parse(readFileSync(join(ROOT, 'bench', 'soak', 'controls.json'), 'utf8'));
    if (!c || !Array.isArray(c.controls)) throw new Error('no "controls" array');
    for (const ctl of c.controls) {
        if (ctl && ctl.sha256 && ctl.sha256['Signal.js'] === KERNEL_FILES[0].sha256 && ctl.sha256['Watch.js'] === KERNEL_FILES[1].sha256) {
            knownAs = String(ctl.name);
            break;
        }
    }
} catch (e) {
    controlsError = 'cannot read bench/soak/controls.json: ' + String(e && e.message ? e.message : e);
}
export const KERNEL_KNOWN_AS = knownAs;
export const CONTROLS_ERROR = controlsError;
