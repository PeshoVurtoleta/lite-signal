// bench/andrii-run.mjs -- one leg of the Andrii Volynets js-reactivity-benchmark rerun
// (PLAN-PD-A TASK 3; 7 adapters per D-b170-5, the reset-root diagnostic is dropped).
// REPORTED tier: this wrapper gates nothing in npm test; it refuses to produce a leg whose
// identity or completeness is unverified.
//
// Usage (timed legs run under the quiet lock, see PLAN-PD-A TASK 6):
//   node bench/andrii-run.mjs --node <bin> --out <dir> --build <commit>-<sha8>
//        --expect-node <vX.Y.Z> --expect-rows <R> [--clone <C>] [--timeout-min 240]
//   node bench/andrii-run.mjs --node <bin> --out <dir> --build <commit>-<sha8> --dry-run
//        (--expect-node / --expect-rows optional with --dry-run)
//
// Order of work (every step fails closed, exit 1):
//   1. identity check (before anything is built or timed); every row is also a HEADER line:
//      - `git -C L show <commit>:Signal.js` / `:Watch.js` / `:Signal.d.ts` sha256 == the
//        frozen copy in L/.handoff/b169-evidence/andrii/builds/<build>/ (the build label
//        names a real commit), and the frozen Signal.js sha256 starts with <sha8>
//      - L/Signal.js, L/Watch.js, L/Signal.d.ts == frozen; C/src/frameworks/lite160/
//        node_modules/@zakkster/lite-signal/{Signal.js, Watch.js, Signal.d.ts} == frozen
//      - nested package.json: name @zakkster/lite-signal, version
//        1.6.0-candidate+<commit>.<sha8>
//      - C/node_modules/@zakkster/lite-signal/package.json version 1.5.2
//      - <build>/IDENTITY.txt names the frozen Signal.js and Watch.js sha256 and the
//        C/node_modules 1.5.2 Signal.js sha256
//      - C/src/frameworks/liteSignal.ts byte-identical to C HEAD (upstream adapter)
//      - each of the 7 names has exactly one C/src/frameworkCatalog.json entry
//      - <bin> runs; --expect-node equals `<bin> -v`
//      - --out is outside the clone and (real run) holds no samples.json / run.log yet
//   2. HEADER.txt (date, host, CPU, load1 + busy node pids, node -v, V8, NODE_OPTIONS, clone
//      HEAD, git status --porcelain, lite shas, the identity rows, IDENTITY.txt) and
//      clone-local.patch (git diff HEAD plus every untracked, non-ignored file as a
//      /dev/null diff; the ignored nested lite160/node_modules package is covered by the
//      sha lines instead). git calls use --no-optional-locks (no index refresh in C).
//   3. `pnpm build` in C (pnpm on PATH, else npx -y pnpm@<packageManager pin>), then the
//      worker manifests dist/workers/<id>.packages.json are checked (1.5.2 for lite /
//      lite-eager, the candidate version for the 4 lite160 adapters, alien-signals present
//      and no lite-signal in the alien worker).
//   4. `<bin> --expose-gc dist/index.js` in C with BENCH_FRAMEWORK = the 7 names,
//      BENCH_ROUNDS=3, BENCH_PROFILE=quick, BENCH_SAMPLES_FILE=<out>/samples.json,
//      BENCH_SOURCE_COMMIT=<C HEAD>; every other inherited BENCH_* variable is removed.
//      stdout -> <out>/run.log, stderr -> <out>/run.err.log.
//   5. post-check: exactly the 7 names in samples.packages and in the rows (C's
//      src/index.ts:7-30 filters frameworkInfo by name at :21-23 and silently drops an
//      unknown name; it throws only when NOTHING matches), no FAILED row, samples.node ==
//      `<bin> -v`, per-worker package versions as in step 3, exactly --expect-rows records
//      per adapter, rounds 3 / profile quick, sourceCommit, C/bench-results unchanged, the
//      child process group empty, L and nested Signal.js / Watch.js still the frozen sha.
//      Appended to HEADER.txt.
//
// Child processes (pnpm build and the bench): spawned detached, i.e. leader of their own
// process group; on timeout, on every exit path and on SIGINT / SIGTERM to this wrapper the
// whole group gets SIGKILL (process.kill(-pgid)), so no forked worker outlives the leg; the
// post-check asserts `ps -o pid= -g <pgid>` is empty.
//
// --dry-run: steps 1, 2 and the step-3 manifest check against the CURRENT dist (no build,
// no bench); writes HEADER.txt + clone-local.patch so the wrapper can be exercised untimed.
//
// Worker execPath: C/src/util/benchmark.ts:593-611 runs each row via child_process.fork()
// with an options object that has NO execPath key, so Node uses process.execPath (the <bin>
// this wrapper launched); execArgv is the parent's process.execArgv (--expose-gc) minus any
// --max-old-space-size, plus --max-old-space-size=WORKER_HEAP_MB (benchmark.ts:604-609).
//
// Exports (for probes; importing runs nothing): spawnGroup, groupAlive.
// Zero deps, node: builtins only. Never writes C/bench-results.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync,
  readdirSync, statSync, realpathSync,
} from 'node:fs';
import { cpus, hostname, loadavg, type, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const L = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CLONE = '/Users/zakkster/Work/js-reactivity-benchmark/js-reactivity-benchmark';
const STABLE_VERSION = '1.5.2';
const LITE_PKG = '@zakkster/lite-signal';
const ALIEN = 'alien-signals';
const FROZEN_FILES = ['Signal.js', 'Watch.js', 'Signal.d.ts'];

// name -> which lite-signal it must bundle ('stable' | 'candidate' | null = alien)
const ADAPTERS = [
  ['lite-signal', 'stable'],
  ['lite-signal-eager', 'stable'],
  ['lite-signal-1.6', 'candidate'],
  ['lite-signal-eager-1.6', 'candidate'],
  ['lite-signal-reset', 'candidate'],
  ['lite-signal-eager-reset', 'candidate'],
  [ALIEN, null],
];
const NAMES = ADAPTERS.map((a) => a[0]);

const FLAGS = ['--node', '--out', '--expect-node', '--expect-rows', '--build', '--clone', '--timeout-min', '--dry-run'];

function die(msg) {
  process.stderr.write('andrii-run: ' + msg + '\n');
  process.exit(1);
}

function lev(a, b) {
  const row = [];
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function didYouMean(flag) {
  let best = null;
  let bestD = Infinity;
  for (const f of FLAGS) {
    const d = lev(flag, f);
    if (d < bestD) { bestD = d; best = f; }
  }
  return bestD <= 3 ? ' (did you mean ' + best + '?)' : '';
}

function parseArgs(argv) {
  const o = { node: null, out: null, expectNode: null, expectRows: null, build: null, clone: DEFAULT_CLONE,
    timeoutMin: 240, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (!FLAGS.includes(a)) die('unknown argument ' + JSON.stringify(a) + didYouMean(a));
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) die(a + ' needs a value');
    if (a === '--node') o.node = v;
    else if (a === '--out') o.out = path.resolve(v);
    else if (a === '--expect-node') o.expectNode = v;
    else if (a === '--build') o.build = v;
    else if (a === '--clone') o.clone = path.resolve(v);
    else if (a === '--expect-rows') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 100000) die('--expect-rows must be an integer in [1, 100000]');
      o.expectRows = n;
    } else if (a === '--timeout-min') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 1440) die('--timeout-min must be an integer in [1, 1440]');
      o.timeoutMin = n;
    }
  }
  if (!o.node) die('--node <bin> is required');
  if (!o.out) die('--out <dir> is required');
  if (!o.build) die('--build <commit>-<sha8> is required');
  if (!o.dryRun && !o.expectNode) die('--expect-node <vX.Y.Z> is required (unless --dry-run)');
  if (!o.dryRun && o.expectRows === null) die('--expect-rows <R> is required (unless --dry-run)');
  return o;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256OrNull(p) {
  return existsSync(p) ? sha256(readFileSync(p)) : null;
}

function readJsonOrNull(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    timeout: 120000, killSignal: 'SIGKILL', ...opts });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '',
    error: r.error ? r.error.message : null };
}

function git(repo, args) {
  return run('git', ['--no-optional-locks', '-C', repo, ...args]);
}

// sha256 of a committed blob, bytes exact; null when the commit / path does not exist
function gitBlobSha(repo, rev, file) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', repo, 'show', rev + ':' + file],
    { maxBuffer: 256 * 1024 * 1024, timeout: 120000, killSignal: 'SIGKILL' });
  return r.status === 0 && r.stdout ? sha256(r.stdout) : null;
}

// ---- process-group control ------------------------------------------------------------------
const liveGroups = new Set();

function killGroup(pgid) {
  try { process.kill(-pgid, 'SIGKILL'); } catch (e) { /* group already gone */ }
}

function onSignal(sig) {
  for (const g of liveGroups) killGroup(g);
  process.stderr.write('andrii-run: ' + sig + ' -- child process group(s) killed\n');
  process.exit(sig === 'SIGINT' ? 130 : 143);
}

let signalsHooked = false;

function hookSignals() {
  if (signalsHooked) return;
  signalsHooked = true;
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

// pids still in process group pgid (`ps -o pid= -g <pgid>` plus a ps -A pgid filter)
export function groupAlive(pgid) {
  const pids = new Set();
  const a = spawnSync('ps', ['-o', 'pid=', '-g', String(pgid)], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  for (const t of (a.stdout || '').split(/\s+/)) if (/^\d+$/.test(t)) pids.add(Number(t));
  const b = spawnSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  for (const line of (b.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (m && Number(m[2]) === pgid) pids.add(Number(m[1]));
  }
  return [...pids];
}

// Spawn cmd as the leader of a new process group; resolve after it exits, the whole group
// SIGKILLed. opts: {cwd, env, stdio, timeoutMs, capture}. capture: stdio 'pipe', text kept.
export function spawnGroup(cmd, args, opts) {
  hookSignals();
  return new Promise((resolve) => {
    let child;
    let out = '';
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    let timer = null;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child && child.pid) {
        killGroup(child.pid);
        liveGroups.delete(child.pid);
      }
      resolve({ status: code, signal, timedOut, error: spawnError, pgid: child && child.pid ? child.pid : null, output: out });
    };
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, detached: true,
        stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : opts.stdio });
    } catch (e) {
      spawnError = e;
      finish(null, null);
      return;
    }
    if (child.pid) liveGroups.add(child.pid);
    if (opts.capture) {
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
    }
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killGroup(child.pid);
    }, opts.timeoutMs);
    child.on('error', (e) => {
      spawnError = e;
      if (!child.pid) finish(null, null);
    });
    child.on('exit', (code, signal) => {
      // the leader is gone: kill the rest of the group first, so no grandchild holds a pipe open
      killGroup(child.pid);
      if (opts.capture) child.on('close', () => finish(code, signal));
      else finish(code, signal);
    });
  });
}

async function waitGroupGone(pgid) {
  for (let i = 0; i < 40; i++) {
    const left = groupAlive(pgid);
    if (left.length === 0) return left;
    killGroup(pgid);
    await new Promise((r) => setTimeout(r, 50));
  }
  return groupAlive(pgid);
}

function busyNodes() {
  const r = run('ps', ['-Ao', 'pid=,pcpu=,args=']);
  if (r.status !== 0) return ['ps failed: ' + (r.error || r.stderr.trim())];
  const lines = [];
  for (const raw of r.stdout.split('\n')) {
    const m = raw.match(/^\s*(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    if (path.basename(m[3].split(' ')[0]) !== 'node') continue;
    lines.push((Number(m[2]) >= 10 ? 'BUSY ' : 'idle ') + 'pid ' + pid + ' ' + m[2] + '% ' + m[3].slice(0, 160));
  }
  return lines;
}

function hostBlock(label) {
  const la = loadavg();
  const b = busyNodes();
  const out = [label + ' load1: ' + la[0].toFixed(2) + ' (load5 ' + la[1].toFixed(2) + ', load15 ' +
    la[2].toFixed(2) + ')'];
  out.push(label + ' node processes (BUSY = >= 10% CPU, wrapper excluded):' + (b.length ? '' : ' none'));
  for (const l of b) out.push('  ' + l);
  const ql = path.join(process.env.HOME || '', '.claude/hooks/quiet-lock.mjs');
  if (existsSync(ql)) {
    const q = run(process.execPath, [ql, 'status'], { timeout: 30000 });
    out.push(label + ' quiet-lock status (exit ' + q.status + '): ' + (q.stdout + q.stderr).trim());
  }
  return out;
}

function snapshotDir(dir) {
  if (!existsSync(dir)) return 'absent';
  const acc = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        acc.push(path.relative(dir, p) + ' ' + st.size + ' ' + st.mtimeMs);
      }
    }
  };
  walk(dir);
  return acc.join('\n');
}

function check(list, name, ok, detail) {
  list.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

function checkLines(list) {
  return list.map((c) => '  ' + (c.ok ? 'ok   ' : 'FAIL ') + c.name + (c.detail ? ' -- ' + c.detail : ''));
}

function printChecks(title, list) {
  process.stdout.write(title + '\n' + checkLines(list).join('\n') + '\n');
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// expected lite-signal version per worker manifest / samples.packages entry
function manifestChecks(list, where, getPkgs, candidateVersion) {
  for (const [name, kind] of ADAPTERS) {
    const pk = getPkgs(name);
    if (!pk || typeof pk !== 'object') { check(list, where + ' ' + name + ' manifest present', false, 'missing'); continue; }
    if (kind === null) {
      check(list, where + ' ' + name + ' bundles ' + ALIEN, typeof pk[ALIEN] === 'string', JSON.stringify(pk));
      check(list, where + ' ' + name + ' bundles no ' + LITE_PKG, !(LITE_PKG in pk), JSON.stringify(pk));
      continue;
    }
    const want = kind === 'stable' ? STABLE_VERSION : candidateVersion;
    check(list, where + ' ' + name + ' ' + LITE_PKG + ' == ' + want, pk[LITE_PKG] === want,
      'got ' + JSON.stringify(pk[LITE_PKG]));
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const C = o.clone;
  const bm = o.build.match(/^([0-9a-f]{7,40})-([0-9a-f]{8})$/);
  if (!bm) die('--build must be <commit>-<sha8> (lowercase hex), got ' + JSON.stringify(o.build));
  const commit = bm[1];
  const sha8 = bm[2];
  const candidateVersion = '1.6.0-candidate+' + commit + '.' + sha8;
  const frozenDir = path.join(L, '.handoff/b169-evidence/andrii/builds', o.build);
  const nestedDir = path.join(C, 'src/frameworks/lite160/node_modules', LITE_PKG);

  // ---- 1. identity ---------------------------------------------------------------------
  const id = [];
  const frozen = {};
  const live = {};
  const nested = {};
  for (const f of FROZEN_FILES) {
    frozen[f] = sha256OrNull(path.join(frozenDir, f));
    live[f] = sha256OrNull(path.join(L, f));
    nested[f] = sha256OrNull(path.join(nestedDir, f));
  }
  const shaStable = sha256OrNull(path.join(C, 'node_modules', LITE_PKG, 'Signal.js'));
  for (const f of FROZEN_FILES) {
    check(id, 'frozen ' + f + ' present', frozen[f], path.join(frozenDir, f));
    const committed = gitBlobSha(L, commit, f);
    check(id, 'git -C L show ' + commit + ':' + f + ' == frozen', committed && committed === frozen[f], committed);
    check(id, 'L/' + f + ' == frozen', live[f] && live[f] === frozen[f], live[f]);
    check(id, 'nested lite160 ' + f + ' == frozen', nested[f] && nested[f] === frozen[f], nested[f]);
  }
  check(id, 'frozen Signal.js sha256 starts with ' + sha8, frozen['Signal.js'] && frozen['Signal.js'].startsWith(sha8),
    frozen['Signal.js']);
  const nestedPkg = readJsonOrNull(path.join(nestedDir, 'package.json'));
  check(id, 'nested package.json name ' + LITE_PKG, nestedPkg && nestedPkg.name === LITE_PKG,
    nestedPkg ? nestedPkg.name : 'unreadable');
  check(id, 'nested package.json version ' + candidateVersion, nestedPkg && nestedPkg.version === candidateVersion,
    nestedPkg ? nestedPkg.version : 'unreadable');
  const stable = readJsonOrNull(path.join(C, 'node_modules', LITE_PKG, 'package.json'));
  check(id, 'C/node_modules ' + LITE_PKG + ' version ' + STABLE_VERSION, stable && stable.version === STABLE_VERSION,
    stable ? stable.version : 'unreadable');
  const identityTxt = path.join(frozenDir, 'IDENTITY.txt');
  const idText = existsSync(identityTxt) ? readFileSync(identityTxt, 'utf8') : null;
  check(id, 'IDENTITY.txt present', idText !== null, identityTxt);
  check(id, 'IDENTITY.txt names the frozen Signal.js sha256', idText !== null && frozen['Signal.js'] &&
    idText.includes(frozen['Signal.js']), frozen['Signal.js']);
  check(id, 'IDENTITY.txt names the frozen Watch.js sha256', idText !== null && frozen['Watch.js'] &&
    idText.includes(frozen['Watch.js']), frozen['Watch.js']);
  check(id, 'IDENTITY.txt names the C/node_modules 1.5.2 Signal.js sha256', idText !== null && shaStable &&
    idText.includes(shaStable), shaStable);
  const shaAdapter = sha256OrNull(path.join(C, 'src/frameworks/liteSignal.ts'));
  const shaHeadAdapter = gitBlobSha(C, 'HEAD', 'src/frameworks/liteSignal.ts');
  check(id, 'C/src/frameworks/liteSignal.ts == C HEAD', shaAdapter && shaAdapter === shaHeadAdapter,
    shaAdapter + ' vs HEAD ' + shaHeadAdapter);
  const catalog = readJsonOrNull(path.join(C, 'src/frameworkCatalog.json'));
  check(id, 'frameworkCatalog.json readable', Array.isArray(catalog));
  const idOf = new Map();
  for (const n of NAMES) {
    const hits = Array.isArray(catalog) ? catalog.filter((e) => e && e.name === n) : [];
    check(id, 'catalog entry for ' + n, hits.length === 1, hits.length === 1 ? 'id ' + hits[0].id : hits.length + ' entries');
    if (hits.length === 1) idOf.set(n, hits[0].id);
  }
  const nv = run(o.node, ['-p', 'process.version + " " + process.versions.v8 + " " + process.execPath']);
  const nodeParts = nv.status === 0 ? nv.stdout.trim().split(' ') : null;
  const binVersion = nodeParts ? nodeParts[0] : null;
  check(id, '--node runs', nodeParts && nodeParts.length === 3, nodeParts ? nv.stdout.trim() : (nv.error || nv.stderr.trim()));
  if (o.expectNode) check(id, '--expect-node ' + o.expectNode, binVersion === o.expectNode, binVersion);
  check(id, '--out outside the clone', !isInside(o.out, C), o.out);
  if (!o.dryRun) {
    check(id, '--out has no samples.json / run.log yet',
      !existsSync(path.join(o.out, 'samples.json')) && !existsSync(path.join(o.out, 'run.log')), o.out);
  }
  printChecks('IDENTITY (' + o.build + ', candidate ' + candidateVersion + ')', id);
  if (id.some((c) => !c.ok)) die('identity check failed; nothing built or timed');

  // ---- 2. HEADER + patch -----------------------------------------------------------------
  mkdirSync(o.out, { recursive: true });
  const HEADER = path.join(o.out, 'HEADER.txt');
  const cHead = git(C, ['rev-parse', 'HEAD']).stdout.trim();
  const lHead = git(L, ['rev-parse', 'HEAD']).stdout.trim();
  const porcelain = git(C, ['status', '--porcelain']).stdout;
  let patch = git(C, ['diff', '--binary', 'HEAD']).stdout;
  const untracked = git(C, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean);
  for (const f of untracked) patch += git(C, ['diff', '--no-index', '--binary', '--', '/dev/null', f]).stdout;
  writeFileSync(path.join(o.out, 'clone-local.patch'), patch);
  const cpu0 = cpus()[0];
  writeFileSync(HEADER, [
    'andrii-run leg header' + (o.dryRun ? ' (DRY-RUN: no build, no bench)' : ''),
    'date: ' + new Date().toISOString(),
    'host: ' + hostname() + ' ' + type() + ' ' + release() + ' ' + process.platform + '/' + process.arch,
    'cpu: ' + ((cpu0 && cpu0.model) || 'unknown').trim() + ' x' + cpus().length,
    'node: ' + binVersion,
    'v8: ' + (nodeParts ? nodeParts[1] : 'unknown'),
    'node bin: ' + o.node + ' (execPath ' + (nodeParts ? nodeParts[2] : 'unknown') + ')',
    'wrapper node: ' + process.version + ' ' + process.execPath,
    'NODE_OPTIONS: ' + (process.env.NODE_OPTIONS === undefined ? '(unset)' : JSON.stringify(process.env.NODE_OPTIONS)),
    'clone: ' + C,
    'clone HEAD: ' + cHead,
    'L HEAD: ' + lHead,
    'build: ' + o.build + ' candidate version ' + candidateVersion,
    'expect: node ' + (o.expectNode || '(dry-run: none)') + ', rows per adapter ' +
      (o.expectRows === null ? '(dry-run: none)' : o.expectRows),
    ...FROZEN_FILES.flatMap((f) => ['sha256 frozen ' + f + ': ' + frozen[f], 'sha256 L/' + f + ': ' + live[f],
      'sha256 nested lite160 ' + f + ': ' + nested[f]]),
    'sha256 C/node_modules 1.5.2 Signal.js: ' + shaStable,
    'sha256 C/src/frameworks/liteSignal.ts: ' + shaAdapter,
    'sha256 clone-local.patch: ' + sha256(patch) + ' (' + untracked.length + ' untracked files)',
    'adapters: ' + NAMES.join(','),
    'catalog ids: ' + NAMES.map((n) => n + '=' + idOf.get(n)).join(' '),
    'env: BENCH_FRAMEWORK=<adapters> BENCH_ROUNDS=3 BENCH_PROFILE=quick BENCH_SAMPLES_FILE=' +
      path.join(o.out, 'samples.json') + ' BENCH_SOURCE_COMMIT=' + cHead + ' (other BENCH_* removed)',
    'identity checks:',
    ...checkLines(id),
    ...hostBlock('before'),
    'git status --porcelain (clone):',
    ...porcelain.split('\n').filter(Boolean).map((l) => '  ' + l),
    'IDENTITY.txt:',
    ...idText.split('\n').filter(Boolean).map((l) => '  ' + l),
  ].join('\n') + '\n');

  // ---- 3. build + worker manifests ---------------------------------------------------------
  const benchResults = path.join(C, 'bench-results');
  const snapBefore = snapshotDir(benchResults);
  let buildCmd = 'none (dry-run: current dist)';
  if (!o.dryRun) {
    const onPath = run('sh', ['-c', 'command -v pnpm']).stdout.trim();
    const cpkg = readJsonOrNull(path.join(C, 'package.json'));
    const pin = cpkg && typeof cpkg.packageManager === 'string' ? cpkg.packageManager.replace(/^pnpm@/, '') : '10.22.0';
    const cmd = onPath ? [onPath, ['build']] : ['npx', ['-y', 'pnpm@' + pin, 'build']];
    buildCmd = cmd[0] + ' ' + cmd[1].join(' ');
    const b = await spawnGroup(cmd[0], cmd[1], { cwd: C, capture: true, timeoutMs: 600000 });
    const left = b.pgid ? await waitGroupGone(b.pgid) : [];
    appendFileSync(HEADER, 'pnpm build: ' + buildCmd + ' exit ' + b.status + (b.signal ? ' signal ' + b.signal : '') +
      (b.timedOut ? ' TIMED OUT' : '') + (b.error ? ' error ' + b.error.message : '') +
      ' group left ' + JSON.stringify(left) + '\n' + b.output.trim().split('\n').map((l) => '  ' + l).join('\n') + '\n');
    if (b.status !== 0 || left.length) die('pnpm build failed (exit ' + b.status + ', group left ' + left.length + '); see ' + HEADER);
  }
  const pre = [];
  manifestChecks(pre, 'dist/workers', (n) => readJsonOrNull(path.join(C, 'dist/workers', idOf.get(n) + '.packages.json')),
    candidateVersion);
  const shaIndex = sha256OrNull(path.join(C, 'dist/index.js'));
  check(pre, 'dist/index.js present', shaIndex, shaIndex);
  printChecks('WORKER MANIFESTS (' + buildCmd + ')', pre);
  appendFileSync(HEADER, 'worker manifests (' + buildCmd + '):\n' + checkLines(pre).join('\n') + '\n');
  if (pre.some((c) => !c.ok)) die('worker manifest check failed; bench not run');
  if (o.dryRun) {
    appendFileSync(HEADER, 'DRY-RUN complete: every pre-bench check passed\n');
    process.stdout.write('andrii-run: DRY-RUN ok (' + HEADER + ')\n');
    return;
  }

  // ---- 4. the leg ----------------------------------------------------------------------------
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BENCH_')) env[k] = v;
  env.BENCH_FRAMEWORK = NAMES.join(',');
  env.BENCH_ROUNDS = '3';
  env.BENCH_PROFILE = 'quick';
  env.BENCH_SAMPLES_FILE = path.join(o.out, 'samples.json');
  env.BENCH_SOURCE_COMMIT = cHead;
  const fdOut = openSync(path.join(o.out, 'run.log'), 'w');
  const fdErr = openSync(path.join(o.out, 'run.err.log'), 'w');
  const t0 = Date.now();
  const leg = await spawnGroup(o.node, ['--expose-gc', 'dist/index.js'], {
    cwd: C, env, stdio: ['ignore', fdOut, fdErr], timeoutMs: o.timeoutMin * 60000,
  });
  const wallMs = Date.now() - t0;
  const leftover = leg.pgid ? await waitGroupGone(leg.pgid) : [];
  closeSync(fdOut);
  closeSync(fdErr);

  // ---- 5. post-check -------------------------------------------------------------------------
  const post = [];
  check(post, 'bench exit 0', leg.status === 0 && !leg.timedOut, 'status ' + leg.status + (leg.signal ? ' signal ' + leg.signal : '') +
    (leg.timedOut ? ' TIMED OUT' : '') + (leg.error ? ' ' + leg.error.message : '') + ' wall ' + (wallMs / 60000).toFixed(1) + ' min');
  check(post, 'child process group ' + leg.pgid + ' empty', leg.pgid && leftover.length === 0, JSON.stringify(leftover));
  const s = readJsonOrNull(env.BENCH_SAMPLES_FILE);
  check(post, 'samples.json readable', s && Array.isArray(s.rows), env.BENCH_SAMPLES_FILE);
  if (s && Array.isArray(s.rows)) {
    const want = JSON.stringify([...NAMES].sort());
    const pkNames = Object.keys(s.packages || {}).sort();
    const rowNames = [...new Set(s.rows.map((r) => r.framework))].sort();
    check(post, 'samples.packages names == the 7', JSON.stringify(pkNames) === want, pkNames.join(','));
    check(post, 'row frameworks == the 7', JSON.stringify(rowNames) === want, rowNames.join(','));
    const failed = s.rows.filter((r) => r.status === 'failed');
    check(post, 'no FAILED row', failed.length === 0,
      failed.length + (failed.length ? ': ' + failed.slice(0, 5).map((r) => r.id).join('; ') : ''));
    check(post, 'samples.node == ' + binVersion, s.node === binVersion, s.node);
    check(post, 'policy.rounds 3', s.policy && s.policy.rounds === 3, s.policy && s.policy.rounds);
    check(post, 'profile quick', s.profile === 'quick', s.profile);
    check(post, 'sourceCommit == clone HEAD', s.sourceCommit === cHead, s.sourceCommit);
    const counts = {};
    for (const r of s.rows) counts[r.framework] = (counts[r.framework] || 0) + 1;
    for (const n of NAMES) check(post, n + ' records == --expect-rows ' + o.expectRows, counts[n] === o.expectRows, counts[n]);
    manifestChecks(post, 'samples.packages', (n) => (s.packages || {})[n] || null, candidateVersion);
    appendFileSync(HEADER, 'bundleSha256: ' + s.bundleSha256 + '\nsamples node: ' + s.node + ' v8 ' + s.v8 + '\n');
  }
  check(post, 'C/bench-results unchanged', snapshotDir(benchResults) === snapBefore, benchResults);
  for (const f of ['Signal.js', 'Watch.js']) {
    const lAfter = sha256OrNull(path.join(L, f));
    const nAfter = sha256OrNull(path.join(nestedDir, f));
    check(post, 'L/' + f + ' still == frozen', lAfter === frozen[f], lAfter);
    check(post, 'nested lite160 ' + f + ' still == frozen', nAfter === frozen[f], nAfter);
  }
  printChecks('POST-CHECK', post);
  appendFileSync(HEADER, ['wall: ' + wallMs + ' ms', ...hostBlock('after'), 'post-check:', ...checkLines(post)].join('\n') + '\n');
  if (post.some((c) => !c.ok)) die('post-check failed; the leg is VOID (see ' + HEADER + ')');
  process.stdout.write('andrii-run: leg ok (' + o.out + ')\n');
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch (e) {
    return false;
  }
}

if (isMain()) {
  main().catch((e) => {
    for (const g of liveGroups) killGroup(g);
    die('internal error: ' + (e && e.stack ? e.stack : String(e)));
  });
}
