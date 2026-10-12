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
 * CONTROLS_ERROR (null, or why controls.json could not be read).
 *
 * Uses top-level await. COLD module.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { configExit } from './config.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const envKernel = process.env.SOAK_KERNEL;
const envEngine = process.env.SOAK_ENGINE;

export const KERNEL_OVERRIDE = envKernel !== undefined;
if (KERNEL_OVERRIDE && envKernel === '') configExit("SOAK_KERNEL='' is not a path");
// The seam is lite-only; alien and polyfill load from exact-pinned devDependencies (v2 section 3.1).
if (KERNEL_OVERRIDE && envEngine !== undefined && envEngine !== 'lite') {
    configExit("SOAK_KERNEL is the lite-only kernel seam; it cannot be combined with SOAK_ENGINE='" + envEngine + "'");
}

const requested = KERNEL_OVERRIDE ? resolve(envKernel) : join(ROOT, 'Signal.js');
if (!existsSync(requested) || !statSync(requested).isFile()) configExit('SOAK_KERNEL: kernel file not found: ' + requested);
const kernelPath = realpathSync(requested);
if (basename(kernelPath) !== 'Signal.js') {
    configExit('SOAK_KERNEL: the kernel file must be named Signal.js (got ' + basename(kernelPath) + '); Watch.js imports ./Signal.js');
}
export const KERNEL_DIR = dirname(kernelPath);
const watchPath = join(KERNEL_DIR, 'Watch.js');
if (!existsSync(watchPath)) {
    configExit('SOAK_KERNEL: sibling Watch.js missing in ' + KERNEL_DIR + ' (scratch kernels are a Signal.js + Watch.js directory pair)');
}

export const KERNEL_URL = pathToFileURL(kernelPath).href;

let mod;
try {
    mod = await import(KERNEL_URL);
} catch (e) {
    configExit('SOAK_KERNEL: kernel failed to load: ' + String(e && e.message ? e.message : e).split('\n')[0]);
}
if (typeof mod.createRegistry !== 'function') configExit('SOAK_KERNEL: ' + kernelPath + ' does not export createRegistry()');
export const K = mod;

function sha256(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export const KERNEL_FILES = Object.freeze([
    Object.freeze({ path: kernelPath, sha256: sha256(kernelPath) }),
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
