/**
 * bench/soak/calibration/probes/_kernel.mjs -- shared loader for the TASK 0d semantic probes.
 *
 *   node bench/soak/calibration/probes/<probe>.mjs [path/to/Signal.js]
 *
 * Default kernel: the exact-pinned published 1.5.2 alias (node_modules/lite-signal-1.5.2), whose
 * Signal.js is byte-identical to `git show HEAD:Signal.js` (sha256 f8dd50f8...). A missing kernel or
 * a missing sibling Watch.js exits 2 (fail closed). Each probe prints ONE JSON line and exits 0; a
 * crash exits 1. COLD code.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const arg = process.argv[2];
const path = arg ? resolve(arg) : join(ROOT, 'node_modules', 'lite-signal-1.5.2', 'Signal.js');
if (!existsSync(path)) {
    process.stderr.write('probe: CONFIG -- kernel not found: ' + path + '\n');
    process.exit(2);
}
if (!existsSync(join(dirname(path), 'Watch.js'))) {
    process.stderr.write('probe: CONFIG -- no sibling Watch.js next to ' + path + ' (Signal.js re-exports ./Watch.js)\n');
    process.exit(2);
}

export const K = await import(pathToFileURL(path).href);
export const KERNEL = { path: relative(ROOT, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };

export function errShape(e) {
    if (e === undefined) return null;
    return {
        ctor: e && e.constructor ? e.constructor.name : typeof e,
        message: e && e.message !== undefined ? String(e.message) : String(e),
        aggregate: typeof AggregateError === 'function' && e instanceof AggregateError,
        errors: e && Array.isArray(e.errors) ? e.errors.map((x) => (x && x.message !== undefined ? String(x.message) : String(x))) : null,
    };
}

export function emit(probe, observed, rule) {
    process.stdout.write(JSON.stringify({ probe, kernel: KERNEL, observed, rule }) + '\n');
}
