/**
 * @zakkster/lite-signal soak -- the provenance header (SPEC-B v2 section 7; port of lite-pick provenance.mjs).
 *
 * buildHeader(cfg, extras) gathers everything needed to COMPARE two runs: schema, generator and package
 * versions, git SHA and dirty flag, the sha256 of the RESOLVED kernel files (Signal.js AND Watch.js), the
 * matching control name, the NEARWRAP derivation (null when none), the parity result, Node/V8/execArgv, the host (including loadavg: PLAN 0.5, a busy
 * host invalidates timing), every config key with its source, every constant (gatesBlock), and the timer floor.
 *
 * Unknown is null, never a fabricated value: gitSha null + gitError when git fails; gitDirty null when the
 * status probe fails (never false). gitDirty counts tracked changes AND untracked, non-ignored files. git runs in THIS
 * repository with a timeout and piped stderr (L10, L18): its child env drops the five repo-LOCATING vars in GIT_SCRUB_ENV
 * (QA F6), so an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_COMMON_DIR / GIT_OBJECT_DIRECTORY cannot make
 * the header stamp another tree's SHA or dirty state. No config key or env var names another tree: only the code-only
 * gitInfo(root) seam (tests) does.
 * SOAK_REQUIRE_PROVENANCE=1 exits 2 before any record when the SHA, the dirty flag, the parity result or
 * the controls file is unknown.
 *
 * COLD module.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import os from 'node:os';
import { SCHEMA_VERSION, GEN_VERSION, gatesBlock, configExit } from './config.mjs';
import { KERNEL_URL, KERNEL_OVERRIDE, KERNEL_FILES, KERNEL_KNOWN_AS, CONTROLS_ERROR, KERNEL_NEARWRAP } from './kernel.mjs';
import { checkParity } from './parity.mjs';
import { SEED_FORMULA, WORLD_SEED_FORMULA } from './seeds.mjs';
import { rosterRemapCollision } from './lanes/index.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IS_WIN = process.platform === 'win32';
export const HEADER_KINDS = Object.freeze(['burn-in', 'wrap', 'replay']);

/** The extras a caller must supply (lanes, scenarios, engine are owned by later modules). */
export const REQUIRED_EXTRAS = Object.freeze(['kind', 'engine', 'laneRoster', 'lanes', 'scenarios', 'oraclesNA', 'genRules', 'divergences']);

export const GIT_STATUS_ARGS = Object.freeze(['-c', 'core.excludesFile=', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);

/**
 * The repo-LOCATING git env vars gitInfo removes from its child env (QA F6, PLAN-F5-F6 option b). Exactly these:
 * GIT_CONFIG_* and every other var stay inherited, because GIT_STATUS_ARGS already pins every config knob that
 * can hide a file (and test/41's hostile-config rows prove it against inherited config).
 * KNOWN GAP: config that relocates the tree (core.worktree in the repository's own config, and similar) is not
 * scrubbed; it lives in the repository the SHA describes, not in the caller's env.
 */
export const GIT_SCRUB_ENV = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']);

/** process.env minus GIT_SCRUB_ENV, built at CALL time (a caller may set process.env after this module loads). */
function gitEnv() {
    const env = {};
    for (const k of Object.keys(process.env)) {
        // Windows env names are case-insensitive (git reads Git_Dir as GIT_DIR there); POSIX names are exact.
        if (GIT_SCRUB_ENV.indexOf(IS_WIN ? k.toUpperCase() : k) === -1) env[k] = process.env[k];
    }
    return env;
}

/**
 * { sha, dirty, error } of the repository at `root`. The `root` parameter is a code-only seam for tests (a
 * throwaway repository); buildHeader always calls gitInfo() with no argument, so a run describes THIS tree.
 */
export function gitInfo(root = ROOT) {
    const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, env: gitEnv() };
    try {
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
        let dirty = null;
        try {
            // Untracked files COUNT: an uncommitted model.mjs or parity.json changes what the soak runs, so a
            // tree that hides them cannot be reproduced from its SHA. Only the REPOSITORY's ignore rules
            // should exclude a path: /bench/soak/out/ and /audit/ in the tracked .gitignore.
            // KNOWN GAP (git status has no switch for it): .git/info/exclude (per-clone, not covered by the
            // SHA) and a self-ignoring UNTRACKED .gitignore (a file containing "*", which ignores itself) can
            // still hide files from this probe.
            // User, system or env config must not hide anything, so the probe pins every knob that can:
            //   --untracked-files=normal   beats status.showUntrackedFiles=no (S1a review rounds 2 and 3)
            //   -c core.excludesFile=      drops a personal/global excludes file (it beats env and global config)
            //   --ignore-submodules=none   beats diff.ignoreSubmodules / submodule.*.ignore
            // Output FORMAT knobs (status.relativePaths, status.submoduleSummary, color) do not matter: only
            // emptiness is read, and --porcelain is format-stable. A failing probe still leaves dirty null.
            dirty = execFileSync('git', GIT_STATUS_ARGS, opts).trim().length > 0;
        } catch (e) { /* dirty stays null: unknown */ }
        return { sha, dirty, error: null };
    } catch (e) {
        const msg = e && e.stderr ? String(e.stderr).trim() : String(e && e.message ? e.message : e);
        return { sha: null, dirty: null, error: msg.split('\n')[0] || 'git failed' };
    }
}

/** Smallest nonzero performance.now() delta over 1000 tries, in ns (lite-pick provenance.mjs). */
export function timerFloorNs() {
    let floor = Infinity;
    for (let i = 0; i < 1000; i++) {
        const a = performance.now();
        let b = performance.now();
        while (b === a) b = performance.now();
        const d = (b - a) * 1e6;
        if (d > 0 && d < floor) floor = d;
    }
    return floor === Infinity ? null : +floor.toFixed(1);
}

function pkgVersion() {
    try {
        return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
}

/**
 * Build the header body (the caller stamps type/seq/tMs). Exits 2 when cfg.requireProvenance is set and no
 * git SHA is establishable. Throws TypeError when a REQUIRED_EXTRAS key is missing (a harness bug).
 */
export function buildHeader(cfg, extras) {
    const x = extras || {};
    for (const k of REQUIRED_EXTRAS) {
        if (!Object.prototype.hasOwnProperty.call(x, k) || x[k] === undefined) throw new TypeError('buildHeader: extras.' + k + ' is required');
    }
    if (HEADER_KINDS.indexOf(x.kind) === -1) throw new TypeError('buildHeader: extras.kind must be one of ' + HEADER_KINDS.join('|'));
    const git = gitInfo();
    const parity = checkParity();
    // Required provenance admits NO unknown (null is not zero): every field a comparison depends on must
    // be established, or the run exits 2 before any record.
    if (cfg.requireProvenance) {
        if (git.sha === null) configExit('SOAK_REQUIRE_PROVENANCE=1 but no git SHA is establishable (' + (git.error || 'unknown') + ')');
        if (git.dirty === null) configExit('SOAK_REQUIRE_PROVENANCE=1 but the git dirty state is unknown (git status failed)');
        if (parity.ok === null) configExit('SOAK_REQUIRE_PROVENANCE=1 but parity is unknown (' + parity.error + ')');
        if (CONTROLS_ERROR !== null) configExit('SOAK_REQUIRE_PROVENANCE=1 but the control kernels are unknown (' + CONTROLS_ERROR + ')');
    }
    const cpus = os.cpus();
    return {
        schemaVersion: SCHEMA_VERSION,
        genVersion: GEN_VERSION,
        kind: x.kind,
        pkgVersion: pkgVersion(),
        startedAt: new Date().toISOString(),
        gitSha: git.sha,
        gitDirty: git.dirty,
        gitError: git.error,
        kernel: {
            url: KERNEL_URL,
            override: KERNEL_OVERRIDE,
            files: KERNEL_FILES.map((f) => ({ path: f.path, sha256: f.sha256 })),
        },
        // null, or the NEARWRAP kernel this run loaded: {phase, k, rewrites, baseSha256, derivedSha256} (kernel.mjs)
        nearwrap: KERNEL_NEARWRAP === null ? null : JSON.parse(JSON.stringify(KERNEL_NEARWRAP)),
        engine: x.engine,
        parity: { ok: parity.ok, mismatched: parity.mismatched.map((m) => m.file), error: parity.error },
        controls: { name: KERNEL_KNOWN_AS, error: CONTROLS_ERROR },
        node: process.version,
        v8: process.versions.v8,
        execArgv: process.execArgv.slice(),
        os: {
            platform: os.platform(),
            arch: os.arch(),
            totalmem: os.totalmem(),
            freemem: os.freemem(),
            cpuModel: cpus.length ? cpus[0].model : null,
            cpuCount: cpus.length,
            loadavg: os.loadavg(),
        },
        config: cfg.record,
        laneRoster: x.laneRoster,
        lanes: x.lanes,
        scenarios: x.scenarios,
        oraclesNA: x.oraclesNA,
        genRules: x.genRules,
        divergences: x.divergences,
        mustfail: cfg.mustFail,
        seedFormula: SEED_FORMULA,
        worldSeedFormula: WORLD_SEED_FORMULA,
        // DATA, not a failure: the one (lane, cycle) pair that shares a seed through the seed-0 remap, if
        // this run's base, rostered lane INDICES and cycle count reach it (lanes/index.mjs rosterRemapCollision:
        // seeds.mjs remapCollision over the index span, kept only when both lanes are rostered; exact).
        seedRemapCollision: rosterRemapCollision(cfg.seed, cfg.roster, cfg.cycles),
        gates: gatesBlock(),
        timerFloorNs: timerFloorNs(),
    };
}
