/**
 * @zakkster/lite-signal soak -- the PARITY gate (port of lite-pick benchmark/soak/parity.mjs; lesson S6/L27).
 *
 *   node bench/soak/parity.mjs            check   (npm run parity)
 *   node bench/soak/parity.mjs --update   re-pin  (npm run parity:update)
 *
 * PARITY_FILES are pinned by sha256 in bench/soak/parity.json. The check exits 1 when any file differs from
 * its pin, is missing, or when the pin file lists a file that is not a parity file. A missing or malformed
 * pin file is exit 2 (fail closed, never "nothing to compare = OK"). A commit that changes the kernel must
 * re-pin it deliberately, in the same commit (`--update`).
 *
 * PARITY_FILES grows with the soak: S1b appended bench/soak/model.mjs, oracles.mjs and exec.mjs (SPEC-B v2
 * section 1) plus kinds.mjs (the shared body code), gen.mjs (replay keys), scenarios.mjs and lanes/*.mjs
 * (they decide the scripts and the coverage verdict), and re-pinned in the same
 * change. A listed file that does not exist yet would fail the check, so files are listed only once they exist.
 *
 * COLD module. checkParity() is the library entry used by the provenance header.
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PIN_PATH = join(ROOT, 'bench', 'soak', 'parity.json');
export const PARITY_FILES = Object.freeze([
    'Signal.js', 'Watch.js',
    // S1b: the user-code kinds, the naive model, the oracles, the executor and the generator (replay keys
    // are valid only while gen.mjs is byte-identical)
    'bench/soak/kinds.mjs', 'bench/soak/model.mjs', 'bench/soak/oracles.mjs', 'bench/soak/exec.mjs', 'bench/soak/gen.mjs',
    // the lanes and the detectors decide the scripts and the coverage verdict
    'bench/soak/scenarios.mjs', 'bench/soak/lanes/index.mjs', 'bench/soak/lanes/graph.mjs', 'bench/soak/lanes/batch.mjs',
    'bench/soak/lanes/error.mjs', 'bench/soak/lanes/nest.mjs',
    // S1c B1+B2 (pinned after QA, amendment 10): the gates and the boundary decide the verdict, the divergence
    // registry decides which failures are known, and the seeds decide which worlds run
    'bench/soak/gates.mjs', 'bench/soak/boundary.mjs', 'bench/soak/divergences.mjs', 'bench/soak/divergences.json',
    'bench/soak/seeds.mjs',
    // S1c B3 (pinned after review, burst 7): the burn-in entry decides the records, the BREACH lines and the exit
    'bench/soak/main.mjs',
    // S1c B4 (pinned after review, burst 7c): replay and shrink decide which world a key plays and what the
    // emitted shrink test proves
    'bench/soak/replay.mjs', 'bench/soak/shrink.mjs',
    // burst 12 (maintainer decision b): the constants decide the gate thresholds; SoakReport decides
    // consistency / release eligibility
    'bench/soak/config.mjs', 'bench/soak/SoakReport.mjs',
    // S2 A-B3a (burst 27, SPEC-S2-groupA DELTA 2 task 11 + MD2): the wrap job, its rules and REPR child decide the
    // wrap verdict; nearwrap.mjs and kernel.mjs decide which kernel a run loads; spin.mjs is the W1 / W5 drive
    'bench/soak/wrap.mjs', 'bench/soak/wrap-repr.mjs', 'bench/soak/wraprules.mjs', 'bench/soak/nearwrap.mjs',
    'bench/soak/kernel.mjs', 'bench/torture/helpers/spin.mjs',
]);
const SHA256_RE = /^[0-9a-f]{64}$/;

/** sha256 hex of a file, or null when it cannot be read. */
export function sha256File(path) {
    try {
        return createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch {
        return null;
    }
}

/** Current hashes of PARITY_FILES (relative path -> hex | null). */
export function currentHashes() {
    const out = {};
    for (const f of PARITY_FILES) out[f] = sha256File(join(ROOT, f));
    return out;
}

/**
 * Compare the working tree against the pins: { ok, mismatched: [{file, pinned, actual}], error }.
 * ok is null (unknown, never true) when the pin file is missing or malformed.
 */
export function checkParity() {
    let pins;
    try {
        pins = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
    } catch (e) {
        return { ok: null, mismatched: [], error: 'cannot read ' + PIN_PATH + ': ' + (e && e.message ? e.message : e) };
    }
    if (!pins || typeof pins !== 'object' || Array.isArray(pins) || typeof pins.files !== 'object' || pins.files === null || Array.isArray(pins.files)) {
        return { ok: null, mismatched: [], error: 'malformed pin file (no "files" object)' };
    }
    for (const f of Object.keys(pins.files)) {
        if (typeof pins.files[f] !== 'string' || !SHA256_RE.test(pins.files[f])) {
            return { ok: null, mismatched: [], error: 'malformed pin file: "' + f + '" is not a sha256 hex string' };
        }
    }
    const cur = currentHashes();
    const mismatched = [];
    for (const f of PARITY_FILES) {
        const pinned = Object.prototype.hasOwnProperty.call(pins.files, f) ? pins.files[f] : null;
        if (pinned === null || cur[f] === null || pinned !== cur[f]) mismatched.push({ file: f, pinned, actual: cur[f] });
    }
    for (const f of Object.keys(pins.files)) {
        if (PARITY_FILES.indexOf(f) === -1) mismatched.push({ file: f, pinned: pins.files[f], actual: 'not a parity file' });
    }
    return { ok: mismatched.length === 0, mismatched, error: null };
}

function short(h) { return h === null || h === undefined ? 'missing' : String(h).slice(0, 12); }

/**
 * Is this module the process entry? Compared by REALPATH: Node resolves symlinks in import.meta.url but not
 * in process.argv[1], so a plain string compare silently skipped the check (exit 0, no output) when the
 * repository was reached through a symlink (macOS /tmp -> /private/tmp). Fail-open, fixed 2026-10-10.
 */
function isEntry() {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntry()) {
    const args = process.argv.slice(2);
    for (const a of args) {
        if (a !== '--update') { process.stderr.write('parity: unknown argument ' + a + ' (only --update)\n'); process.exitCode = 2; }
    }
    if (process.exitCode !== 2 && args.indexOf('--update') !== -1) {
        const cur = currentHashes();
        const missing = PARITY_FILES.filter((f) => cur[f] === null);
        if (missing.length) {
            process.stderr.write('parity: FAIL -- cannot read ' + missing.join(', ') + '\n');
            process.exitCode = 2;
        } else {
            writeFileSync(PIN_PATH, JSON.stringify({ files: cur }, null, 2) + '\n');
            process.stdout.write('parity: pinned ' + PARITY_FILES.length + ' files -> bench/soak/parity.json\n');
            process.exitCode = 0;
        }
    } else if (process.exitCode !== 2) {
        const r = checkParity();
        if (r.ok === null) {
            process.stderr.write('parity: FAIL -- ' + r.error + '\n');
            process.exitCode = 2;
        } else if (!r.ok) {
            for (const m of r.mismatched) {
                if (m.actual === 'not a parity file') process.stderr.write('parity: FAIL -- ' + m.file + ' is pinned but is not one of PARITY_FILES\n');
                else process.stderr.write('parity: FAIL -- ' + m.file + ' sha256 ' + short(m.actual) + ' != pinned ' + short(m.pinned) + '\n');
            }
            process.stderr.write('parity: the kernel changed. If deliberate, run `npm run parity:update` and commit parity.json with it.\n');
            process.exitCode = 1;
        } else {
            process.stdout.write('parity: OK (' + PARITY_FILES.length + ' files match bench/soak/parity.json)\n');
            process.exitCode = 0;
        }
    }
}
