// prepublishOnly gate TEMPLATE for the lite-signal repo.
//
// Wiring: place this harness at <lite-signal-repo>/harness/version-matrix/ and add
// to the lite-signal package.json:
//     "scripts": { "prepublishOnly": "node harness/version-matrix/pre-publish.mjs" }
//
// It re-captures floor + rolling (published tarballs) AND the CURRENT TREE candidate
// on ONE host in ONE run (median-of-N), then applies the two-baseline gate. A
// regression exits non-zero, which aborts `npm publish`. This is the checkpoint:
// you cannot ship a regression without either fixing it or bumping a tolerance in
// manifest.json -- a change reviewers can see.
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoPkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8'));
const version = repoPkg.version;

// Current-tree engine entry. Adjust if the published entry is not Signal.js.
const enginePath = resolve(here, '../../Signal.js');
const label = 'candidate-' + version;

const r = spawnSync('bash', [resolve(here, 'matrix.sh'), 'gate-self', label, enginePath], {
    cwd: here, stdio: 'inherit', env: { ...process.env, REPS: process.env.REPS || '5' }
});

if (r.status !== 0) {
    console.error(`\nversion-matrix gate FAILED for ${version} -- aborting publish.`);
    console.error('Fix the regression, or raise the tolerance in manifest.json (visible in review).');
    process.exit(r.status || 1);
}
console.error(`\nversion-matrix gate passed for ${version}.`);
