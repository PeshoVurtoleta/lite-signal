/**
 * test/95 -- R6 `shrink --emit-test` (s3c C4, burst 143 B3): argv door, parity, the lite-s3 harness test,
 * the kernel-only standalone test, the refusal vocabulary, the specToSource differential.
 *
 * Written from the plan ASSERTIONS 1-7 (.handoff/PLAN-R6-emit-test.md) and the B0 evidence, not from the
 * implementation. Expected values: the HEAD e9f8e6a goldens below (a pre-change build, captured by B0 and
 * embedded so this file never reads .handoff/), the plan text, and for the differential kinds.mjs:evalKind
 * (the plan's reference). Hand arithmetic for the fixed vectors: hash([]) = 7; hash([1]) with read(1)=1 is
 * 7*31 + 1 = 218; cond a=50 -> a (50 > 50 is false), a=51 -> read(d[1]).
 *
 * Not expressed here (gates run elsewhere): ASSERTION 7 torture exit 0 at 0 B/op (npm run torture) and the
 * test/40 GRAPH --smoke tracker rows (test/40 itself). Here: Signal.js unchanged vs HEAD, and the
 * standalone teardown (activeNodes / activeLinks) exit 0 on the tree kernel.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as CFG from '../bench/soak/config.mjs';
import { ROSTER, ALL_SCENARIOS, COV_OFF_SUPPORTED } from '../bench/soak/lanes/index.mjs';
import { evalKind } from '../bench/soak/kinds.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOAK = join(ROOT, 'bench', 'soak');
const SHRINK_CLI = join(SOAK, 'shrink.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'soak-emit-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const K_152 = join(ROOT, 'node_modules', 'lite-signal-1.5.2', 'Signal.js');
let EM = null, EM_ERR = null;
try { EM = await import('../bench/soak/emit.mjs'); } catch (e) { EM_ERR = e; }
const em = () => { if (EM === null) assert.fail('bench/soak/emit.mjs does not load yet: '
    + String(EM_ERR)); return EM; };

// ---- helpers ----
const cleanEnv = (keys) => {
    const env = {};
    for (const k of Object.keys(process.env)) if (k.toUpperCase().indexOf('SOAK_') !== 0
        && k !== 'NODE_TEST_CONTEXT') env[k] = process.env[k];
    return Object.assign(env, keys);
};
function run(args, keys, opts = {}) {
    return new Promise((res) => {
        const c = spawn(process.execPath, args, { env: cleanEnv(keys), cwd: opts.cwd || ROOT });
        let so = '', se = '';
        c.stdout.on('data', (d) => { so += d; });
        c.stderr.on('data', (d) => { se += d; });
        const t = setTimeout(() => c.kill('SIGKILL'), opts.timeout || 280000);
        c.on('close', (status, signal) => { clearTimeout(t); res({ status, signal, stdout: so, stderr: se }); });
    });
}
let dirN = 0;
const mkd = (name) => { const d = join(TMP, name + '-' + (dirN++)); mkdirSync(d, { recursive: true }); return d; };
const lines = (s) => s.split('\n').filter((l) => l.length > 0);

// ---- kernels: the tree kernel and three mutants, each one exact single-match replace of the tree Signal.js ----
const TREE_SRC = readFileSync(join(ROOT, 'Signal.js'), 'utf8');
function kernel(name, find, repl) {
    const d = mkd('kernel-' + name);
    let src = TREE_SRC;
    if (find !== null) {
        const n = TREE_SRC.split(find).length - 1;
        if (n !== 1) throw new Error('kernel ' + name + ': anchor matched ' + n + ' times (need exactly 1)');
        src = TREE_SRC.replace(find, () => repl);
    }
    writeFileSync(join(d, 'Signal.js'), src);
    copyFileSync(join(ROOT, 'Watch.js'), join(d, 'Watch.js'));
    return join(d, 'Signal.js');
}
const BATCH_ANCHOR = '    function batch(fn) {\n        if (batchDepth === 0) {';
const K_TREE = kernel('tree', null, null);
const K_CAP = kernel('mut-cap-node', 'policy === "throw" && nodePool.length >= currentNodesCapacity',
    'policy === "throw" && nodePool.length > currentNodesCapacity');
const K_OB = kernel('mut-ob-batch', BATCH_ANCHOR,
    '    function batch(fn) {\n        if (fn) return fn();\n        if (batchDepth === 0) {');
const K_THROW = kernel('mut-throw-batch', BATCH_ANCHOR,
    '    function batch(fn) {\n        throw new Error("planted batch crash");\n        if (batchDepth === 0) {');

// ---- HEAD e9f8e6a goldens (b143 B0 evidence, derived from the pre-change build; see the header) ----
const GOLD = {
    k1: {
        keys: [
            "kind", "key", "lane", "cycle", "seed", "world",
            "worldSeed", "large", "covOff", "target", "reproduced", "confirmed",
            "ops", "subOps", "opsOriginal", "predicateRuns", "maxRuns", "budgetExhausted",
            "passes", "script", "scriptDigest", "genVersion", "engine", "kernel",
            "node",
        ],
        scalars: {
            "kind": "shrink",
            "key": "BATCH:0:0x4d1f455d",
            "lane": "BATCH",
            "cycle": 0,
            "seed": 12648430,
            "world": 0,
            "worldSeed": 1293895005,
            "large": false,
            "covOff": null,
            "target": [
                "O1:computed-mismatch"
            ],
            "reproduced": true,
            "confirmed": true,
            "ops": 3,
            "subOps": 7,
            "opsOriginal": 423,
            "predicateRuns": 137,
            "maxRuns": 5000,
            "budgetExhausted": false,
            "passes": 2,
            "scriptDigest": "7b809f27b482b1ea9bbf5505d0df5a64c1fe32802f796ab3d4270a5c1eb65ace",
            "genVersion": 1,
            "engine": "lite"
        },
        script: {
            "genVersion": 1,
            "lane": "BATCH",
            "seed": 1293895005,
            "large": false,
            "covOff": null,
            "flushPasses": null,
            "ops": [
                {
                    "o": "sig",
                    "i": 1,
                    "v": 58
                },
                {
                    "o": "comp",
                    "i": 15,
                    "spec": {
                        "k": "sum",
                        "d": [
                            1
                        ]
                    }
                },
                {
                    "o": "batch",
                    "body": [
                        {
                            "o": "batch",
                            "body": [
                                {
                                    "o": "set",
                                    "i": 1,
                                    "v": 0
                                },
                                {
                                    "o": "read",
                                    "is": [
                                        15
                                    ]
                                },
                                {
                                    "o": "set",
                                    "i": 1,
                                    "v": 58
                                }
                            ]
                        }
                    ]
                }
            ]
        },
        shrinkLine: "soak: SHRINK -- key=BATCH:0:0x4d1f455d target=O1:computed-mismatch ops=3 subOps=7 from=4" +
            "23 runs=137/5000",
        test: [
            "// GENERATED by bench/soak/shrink.mjs (lite-signal soak, S1c TASK 8). Do not edit: re-ru" +
                "n the shrink.",
            "// key BATCH:0:0x4d1f455d  target O1:computed-mismatch  ops 3 (from 423)",
            "// Run: SOAK_KERNEL=/abs/dir/Signal.js node <this file>   (no arguments; SOAK_KERNEL is " +
                "required and ABSOLUTE)",
            "// Exit: 1 the target failure reproduces, 0 the script runs clean, 3 a different failure" +
                ", 2 config or a harness",
            "// throw (unset / relative SOAK_KERNEL, a module that fails to load, an exec throw). Nev" +
                "er 1 by accident:",
            "// every soak module loads inside the try below, so a failed import is 2, not \"reproduce" +
                "d\".",
            "import { writeSync } from 'node:fs';",
            "import { isAbsolute } from 'node:path';",
            ,
            "const KEY = \"BATCH:0:0x4d1f455d\";",
            "const TARGET = [\"O1:computed-mismatch\"];",
            "@SCRIPT@",
            "const say = (fd, s) => writeSync(fd, 'shrink-test: ' + s + '\\n');",
            "if (process.argv.length > 2) { say(2, 'CONFIG -- this test takes no arguments (set SOAK_" +
                "KERNEL instead)'); process.exit(2); }",
            "const K = process.env.SOAK_KERNEL;",
            "if (K === undefined || K === '') { say(2, 'CONFIG -- SOAK_KERNEL is required (an absolut" +
                "e path to a frozen <dir>/Signal.js; a soak run never uses the live Signal.js)'); process" +
                ".exit(2); }",
            "if (!isAbsolute(K)) { say(2, 'CONFIG -- SOAK_KERNEL must be an absolute path (got ' + K " +
                "+ '): a relative one would resolve against the cwd'); process.exit(2); }",
            "let r, liteAdapter, familyKeys;",
            "try {",
            "    const ex = await import(\"@ROOT@/bench/soak/exec.mjs\");",
            "    const mn = await import(\"@ROOT@/bench/soak/main.mjs\");",
            "    liteAdapter = (await import(\"@ROOT@/bench/soak/adapters/lite.mjs\")).liteAdapter;",
            "    familyKeys = mn.familyKeys;",
            "    const tap = { escape: null, onOpen() {} };",
            "    r = ex.runWorld(mn.tapAdapter(liteAdapter, tap), SCRIPT);",
            "} catch (e) {",
            "    say(2, 'CRASH -- ' + (e && e.stack ? e.stack : String(e)));",
            "    process.exit(2);",
            "}",
            "const kernel = liteAdapter.files().map((f) => f.sha256.slice(0, 12)).join(',');",
            "if (r.failure === null) { say(1, 'CLEAN key=' + KEY + ' kernel=' + kernel); process.exit" +
                "(0); }",
            "const got = familyKeys(r.failure.fails);",
            "const hit = TARGET.length === 0 || (got.length === TARGET.length && got.every((k) => TAR" +
                "GET.indexOf(k) !== -1));",
            "say(1, (hit ? 'REPRODUCED' : 'DIFFERENT') + ' key=' + KEY + ' step=' + r.failure.step + " +
                "' got=' + got.join(',') + ' target=' + TARGET.join(',') + ' kernel=' + kernel);",
            "process.exit(hit ? 1 : 3);",
            ,
        ],
    },
    k2: {
        keys: [
            "kind", "key", "lane", "cycle", "seed", "world",
            "worldSeed", "large", "covOff", "target", "reproduced", "confirmed",
            "ops", "subOps", "opsOriginal", "predicateRuns", "maxRuns", "budgetExhausted",
            "passes", "script", "scriptDigest", "genVersion", "engine", "kernel",
            "node",
        ],
        scalars: {
            "kind": "shrink",
            "key": "CAPACITY:0:0xaa6a0e89",
            "lane": "CAPACITY",
            "cycle": 0,
            "seed": 12648430,
            "world": 0,
            "worldSeed": 2859077257,
            "large": false,
            "covOff": null,
            "target": [
                "O6:expected-escape-missing"
            ],
            "reproduced": true,
            "confirmed": true,
            "ops": 1,
            "subOps": 1,
            "opsOriginal": 409,
            "predicateRuns": 10,
            "maxRuns": 5000,
            "budgetExhausted": false,
            "passes": 2,
            "scriptDigest": "9334f4860c998e7b53bffac27e6811453b108beede1dafefc8c4983e7cd53409",
            "genVersion": 1,
            "engine": "lite"
        },
        script: {
            "genVersion": 1,
            "lane": "CAPACITY",
            "seed": 2859077257,
            "large": false,
            "covOff": null,
            "flushPasses": null,
            "capacity": {
                "maxNodes": 32,
                "maxLinks": 64,
                "onCapacityExceeded": "throw"
            },
            "ops": [
                {
                    "o": "cedge",
                    "k": "node",
                    "reuse": 0
                }
            ]
        },
        shrinkLine: "soak: SHRINK -- key=CAPACITY:0:0xaa6a0e89 target=O6:expected-escape-missing ops=1 subOps" +
            "=1 from=409 runs=10/5000",
        test: [
            "// GENERATED by bench/soak/shrink.mjs (lite-signal soak, S1c TASK 8). Do not edit: re-ru" +
                "n the shrink.",
            "// key CAPACITY:0:0xaa6a0e89  target O6:expected-escape-missing  ops 1 (from 409)",
            "// Run: SOAK_KERNEL=/abs/dir/Signal.js node <this file>   (no arguments; SOAK_KERNEL is " +
                "required and ABSOLUTE)",
            "// Exit: 1 the target failure reproduces, 0 the script runs clean, 3 a different failure" +
                ", 2 config or a harness",
            "// throw (unset / relative SOAK_KERNEL, a module that fails to load, an exec throw). Nev" +
                "er 1 by accident:",
            "// every soak module loads inside the try below, so a failed import is 2, not \"reproduce" +
                "d\".",
            "import { writeSync } from 'node:fs';",
            "import { isAbsolute } from 'node:path';",
            ,
            "const KEY = \"CAPACITY:0:0xaa6a0e89\";",
            "const TARGET = [\"O6:expected-escape-missing\"];",
            "@SCRIPT@",
            "const say = (fd, s) => writeSync(fd, 'shrink-test: ' + s + '\\n');",
            "if (process.argv.length > 2) { say(2, 'CONFIG -- this test takes no arguments (set SOAK_" +
                "KERNEL instead)'); process.exit(2); }",
            "const K = process.env.SOAK_KERNEL;",
            "if (K === undefined || K === '') { say(2, 'CONFIG -- SOAK_KERNEL is required (an absolut" +
                "e path to a frozen <dir>/Signal.js; a soak run never uses the live Signal.js)'); process" +
                ".exit(2); }",
            "if (!isAbsolute(K)) { say(2, 'CONFIG -- SOAK_KERNEL must be an absolute path (got ' + K " +
                "+ '): a relative one would resolve against the cwd'); process.exit(2); }",
            "let r, liteAdapter, familyKeys;",
            "try {",
            "    const ex = await import(\"@ROOT@/bench/soak/exec.mjs\");",
            "    const mn = await import(\"@ROOT@/bench/soak/main.mjs\");",
            "    liteAdapter = (await import(\"@ROOT@/bench/soak/adapters/lite.mjs\")).liteAdapter;",
            "    familyKeys = mn.familyKeys;",
            "    const tap = { escape: null, onOpen() {} };",
            "    r = ex.runWorld(mn.tapAdapter(liteAdapter, tap), SCRIPT);",
            "} catch (e) {",
            "    say(2, 'CRASH -- ' + (e && e.stack ? e.stack : String(e)));",
            "    process.exit(2);",
            "}",
            "const kernel = liteAdapter.files().map((f) => f.sha256.slice(0, 12)).join(',');",
            "if (r.failure === null) { say(1, 'CLEAN key=' + KEY + ' kernel=' + kernel); process.exit" +
                "(0); }",
            "const got = familyKeys(r.failure.fails);",
            "const hit = TARGET.length === 0 || (got.length === TARGET.length && got.every((k) => TAR" +
                "GET.indexOf(k) !== -1));",
            "say(1, (hit ? 'REPRODUCED' : 'DIFFERENT') + ' key=' + KEY + ' step=' + r.failure.step + " +
                "' got=' + got.join(',') + ' target=' + TARGET.join(',') + ' kernel=' + kernel);",
            "process.exit(hit ? 1 : 3);",
            ,
        ],
    },
    k3: {
        keys: [
            "kind", "key", "lane", "cycle", "seed", "world",
            "worldSeed", "large", "covOff", "target", "reproduced", "confirmed",
            "ops", "subOps", "opsOriginal", "predicateRuns", "maxRuns", "budgetExhausted",
            "passes", "script", "scriptDigest", "genVersion", "engine", "kernel",
            "node",
        ],
        scalars: {
            "kind": "shrink",
            "key": "ERROR:0:0xcea2a53d",
            "lane": "ERROR",
            "cycle": 0,
            "seed": 12648430,
            "world": 4,
            "worldSeed": 3466765629,
            "large": false,
            "covOff": null,
            "target": [
                "O6:escape-computed",
                "O6:expected-escape-missing",
                "O4:effect-dead"
            ],
            "reproduced": true,
            "confirmed": true,
            "ops": 6,
            "subOps": 7,
            "opsOriginal": 428,
            "predicateRuns": 425,
            "maxRuns": 5000,
            "budgetExhausted": false,
            "passes": 3,
            "scriptDigest": "84a10b3d9e6f7014860dea611af5c48d8763e2efecbd55b21dbdcaa9d55e5e40",
            "genVersion": 1,
            "engine": "lite"
        },
        script: {
            "genVersion": 1,
            "lane": "ERROR",
            "seed": 3466765629,
            "large": false,
            "covOff": null,
            "flushPasses": 8,
            "ops": [
                {
                    "o": "sig",
                    "i": 5,
                    "v": 0
                },
                {
                    "o": "comp",
                    "i": 15,
                    "spec": {
                        "k": "identity",
                        "d": [
                            5
                        ]
                    }
                },
                {
                    "o": "comp",
                    "i": 18,
                    "spec": {
                        "k": "sum",
                        "d": [
                            15
                        ],
                        "thr": true
                    }
                },
                {
                    "o": "comp",
                    "i": 21,
                    "spec": {
                        "k": "sum",
                        "d": [
                            18
                        ]
                    }
                },
                {
                    "o": "eff",
                    "i": 22,
                    "spec": {
                        "k": "sum",
                        "d": [
                            21
                        ]
                    }
                },
                {
                    "o": "batch",
                    "body": [
                        {
                            "o": "set",
                            "i": 5,
                            "v": 3
                        }
                    ],
                    "thr": 1
                }
            ]
        },
        shrinkLine: "soak: SHRINK -- key=ERROR:0:0xcea2a53d target=O6:escape-computed,O6:expected-escape-miss" +
            "ing,O4:effect-dead ops=6 subOps=7 from=428 runs=425/5000",
        test: [
            "// GENERATED by bench/soak/shrink.mjs (lite-signal soak, S1c TASK 8). Do not edit: re-ru" +
                "n the shrink.",
            "// key ERROR:0:0xcea2a53d  target O6:escape-computed,O6:expected-escape-missing,O4:effec" +
                "t-dead  ops 6 (from 428)",
            "// Run: SOAK_KERNEL=/abs/dir/Signal.js node <this file>   (no arguments; SOAK_KERNEL is " +
                "required and ABSOLUTE)",
            "// Exit: 1 the target failure reproduces, 0 the script runs clean, 3 a different failure" +
                ", 2 config or a harness",
            "// throw (unset / relative SOAK_KERNEL, a module that fails to load, an exec throw). Nev" +
                "er 1 by accident:",
            "// every soak module loads inside the try below, so a failed import is 2, not \"reproduce" +
                "d\".",
            "import { writeSync } from 'node:fs';",
            "import { isAbsolute } from 'node:path';",
            ,
            "const KEY = \"ERROR:0:0xcea2a53d\";",
            "const TARGET = [\"O6:escape-computed\",\"O6:expected-escape-missing\",\"O4:effect-dead\"];",
            "@SCRIPT@",
            "const say = (fd, s) => writeSync(fd, 'shrink-test: ' + s + '\\n');",
            "if (process.argv.length > 2) { say(2, 'CONFIG -- this test takes no arguments (set SOAK_" +
                "KERNEL instead)'); process.exit(2); }",
            "const K = process.env.SOAK_KERNEL;",
            "if (K === undefined || K === '') { say(2, 'CONFIG -- SOAK_KERNEL is required (an absolut" +
                "e path to a frozen <dir>/Signal.js; a soak run never uses the live Signal.js)'); process" +
                ".exit(2); }",
            "if (!isAbsolute(K)) { say(2, 'CONFIG -- SOAK_KERNEL must be an absolute path (got ' + K " +
                "+ '): a relative one would resolve against the cwd'); process.exit(2); }",
            "let r, liteAdapter, familyKeys;",
            "try {",
            "    const ex = await import(\"@ROOT@/bench/soak/exec.mjs\");",
            "    const mn = await import(\"@ROOT@/bench/soak/main.mjs\");",
            "    liteAdapter = (await import(\"@ROOT@/bench/soak/adapters/lite.mjs\")).liteAdapter;",
            "    familyKeys = mn.familyKeys;",
            "    const tap = { escape: null, onOpen() {} };",
            "    r = ex.runWorld(mn.tapAdapter(liteAdapter, tap), SCRIPT);",
            "} catch (e) {",
            "    say(2, 'CRASH -- ' + (e && e.stack ? e.stack : String(e)));",
            "    process.exit(2);",
            "}",
            "const kernel = liteAdapter.files().map((f) => f.sha256.slice(0, 12)).join(',');",
            "if (r.failure === null) { say(1, 'CLEAN key=' + KEY + ' kernel=' + kernel); process.exit" +
                "(0); }",
            "const got = familyKeys(r.failure.fails);",
            "const hit = TARGET.length === 0 || (got.length === TARGET.length && got.every((k) => TAR" +
                "GET.indexOf(k) !== -1));",
            "say(1, (hit ? 'REPRODUCED' : 'DIFFERENT') + ' key=' + KEY + ' step=' + r.failure.step + " +
                "' got=' + got.join(',') + ' target=' + TARGET.join(',') + ' kernel=' + kernel);",
            "process.exit(hit ? 1 : 3);",
            ,
        ],
    },
    k4: {
        keys: [
            "kind", "key", "lane", "cycle", "seed", "world",
            "worldSeed", "large", "covOff", "target", "reproduced", "confirmed",
            "ops", "subOps", "opsOriginal", "predicateRuns", "maxRuns", "budgetExhausted",
            "passes", "script", "scriptDigest", "genVersion", "engine", "kernel",
            "node",
        ],
        scalars: {
            "kind": "shrink",
            "key": "BATCH:0:0x4d1f455d",
            "lane": "BATCH",
            "cycle": 0,
            "seed": 12648430,
            "world": 0,
            "worldSeed": 1293895005,
            "large": false,
            "covOff": null,
            "target": [
                "OB:batch-early-run"
            ],
            "reproduced": true,
            "confirmed": true,
            "ops": 4,
            "subOps": 5,
            "opsOriginal": 423,
            "predicateRuns": 104,
            "maxRuns": 5000,
            "budgetExhausted": false,
            "passes": 2,
            "scriptDigest": "270ed7f893aed371ba12bcb79049238f55907ea0025ccd26dad76ab85fe0f751",
            "genVersion": 1,
            "engine": "lite"
        },
        script: {
            "genVersion": 1,
            "lane": "BATCH",
            "seed": 1293895005,
            "large": false,
            "covOff": null,
            "flushPasses": null,
            "ops": [
                {
                    "o": "sig",
                    "i": 6,
                    "v": 0
                },
                {
                    "o": "comp",
                    "i": 10,
                    "spec": {
                        "k": "sum",
                        "d": [
                            6
                        ]
                    }
                },
                {
                    "o": "eff",
                    "i": 21,
                    "spec": {
                        "k": "sum",
                        "d": [
                            10
                        ]
                    }
                },
                {
                    "o": "batch",
                    "body": [
                        {
                            "o": "set",
                            "i": 6,
                            "v": 1
                        }
                    ]
                }
            ]
        },
        shrinkLine: "soak: SHRINK -- key=BATCH:0:0x4d1f455d target=OB:batch-early-run ops=4 subOps=5 from=423" +
            " runs=104/5000",
        test: [
            "// GENERATED by bench/soak/shrink.mjs (lite-signal soak, S1c TASK 8). Do not edit: re-ru" +
                "n the shrink.",
            "// key BATCH:0:0x4d1f455d  target OB:batch-early-run  ops 4 (from 423)",
            "// Run: SOAK_KERNEL=/abs/dir/Signal.js node <this file>   (no arguments; SOAK_KERNEL is " +
                "required and ABSOLUTE)",
            "// Exit: 1 the target failure reproduces, 0 the script runs clean, 3 a different failure" +
                ", 2 config or a harness",
            "// throw (unset / relative SOAK_KERNEL, a module that fails to load, an exec throw). Nev" +
                "er 1 by accident:",
            "// every soak module loads inside the try below, so a failed import is 2, not \"reproduce" +
                "d\".",
            "import { writeSync } from 'node:fs';",
            "import { isAbsolute } from 'node:path';",
            ,
            "const KEY = \"BATCH:0:0x4d1f455d\";",
            "const TARGET = [\"OB:batch-early-run\"];",
            "@SCRIPT@",
            "const say = (fd, s) => writeSync(fd, 'shrink-test: ' + s + '\\n');",
            "if (process.argv.length > 2) { say(2, 'CONFIG -- this test takes no arguments (set SOAK_" +
                "KERNEL instead)'); process.exit(2); }",
            "const K = process.env.SOAK_KERNEL;",
            "if (K === undefined || K === '') { say(2, 'CONFIG -- SOAK_KERNEL is required (an absolut" +
                "e path to a frozen <dir>/Signal.js; a soak run never uses the live Signal.js)'); process" +
                ".exit(2); }",
            "if (!isAbsolute(K)) { say(2, 'CONFIG -- SOAK_KERNEL must be an absolute path (got ' + K " +
                "+ '): a relative one would resolve against the cwd'); process.exit(2); }",
            "let r, liteAdapter, familyKeys;",
            "try {",
            "    const ex = await import(\"@ROOT@/bench/soak/exec.mjs\");",
            "    const mn = await import(\"@ROOT@/bench/soak/main.mjs\");",
            "    liteAdapter = (await import(\"@ROOT@/bench/soak/adapters/lite.mjs\")).liteAdapter;",
            "    familyKeys = mn.familyKeys;",
            "    const tap = { escape: null, onOpen() {} };",
            "    r = ex.runWorld(mn.tapAdapter(liteAdapter, tap), SCRIPT);",
            "} catch (e) {",
            "    say(2, 'CRASH -- ' + (e && e.stack ? e.stack : String(e)));",
            "    process.exit(2);",
            "}",
            "const kernel = liteAdapter.files().map((f) => f.sha256.slice(0, 12)).join(',');",
            "if (r.failure === null) { say(1, 'CLEAN key=' + KEY + ' kernel=' + kernel); process.exit" +
                "(0); }",
            "const got = familyKeys(r.failure.fails);",
            "const hit = TARGET.length === 0 || (got.length === TARGET.length && got.every((k) => TAR" +
                "GET.indexOf(k) !== -1));",
            "say(1, (hit ? 'REPRODUCED' : 'DIFFERENT') + ' key=' + KEY + ' step=' + r.failure.step + " +
                "' got=' + got.join(',') + ' target=' + TARGET.join(',') + ' kernel=' + kernel);",
            "process.exit(hit ? 1 : 3);",
            ,
        ],
    },
};

// ---- the four B0 keys (README.txt (a)) ----
const KEYS = {
    k1: { key: 'BATCH:0:0x4d1f455d', stem: 'shrink-BATCH-0x4d1f455d', kernel: K_152, smoke: true, env: {} },
    k2: { key: 'CAPACITY:0:0xaa6a0e89', stem: 'shrink-CAPACITY-0xaa6a0e89', kernel: K_CAP, smoke: false,
        env: { SOAK_CYCLES: '11', SOAK_OPS: '1000' } },
    k3: { key: 'ERROR:0:0xcea2a53d', stem: 'shrink-ERROR-0xcea2a53d', kernel: K_152, smoke: true, env: {} },
    k4: { key: 'BATCH:0:0x4d1f455d', stem: 'shrink-BATCH-0x4d1f455d', kernel: K_OB, smoke: true, env: {} },
};
const goldenTest = (k) => GOLD[k].test.join('\n').replace('@SCRIPT@', () => 'const SCRIPT = '
    + JSON.stringify(GOLD[k].script) + ';')
    .split('@ROOT@/').join(pathToFileURL(ROOT).href);

/** One shrink child per (key, mode); K1 and K4 share a stem, so every run has its own dir. Memoized, parallel. */
const FX = new Map();
function shrinkOf(k, flag, plant) {
    const id = k + (flag ? '+emit' : '');
    if (!FX.has(id)) {
        const K = KEYS[k];
        const dir = mkd(id.replace('+', '-'));
        if (plant) writeFileSync(join(dir, K.stem + '.standalone.test.mjs'), '// planted\n');
        const argv = (K.smoke ? ['--smoke'] : []).concat(flag ? ['--emit-test'] : []);
        const keys = Object.assign({ SOAK_REPLAY: K.key, SOAK_SHRINK: '1', SOAK_KERNEL: K.kernel,
            SOAK_OUT: join(dir, 'stream.jsonl') }, K.env);
        const p = run(['--expose-gc', SHRINK_CLI].concat(argv), keys).then((r) => {
            const jp = join(dir, K.stem + '.json');
            return Object.assign(r, { dir, jsonPath: jp, testPath: join(dir, K.stem + '.test.mjs'),
                stdPath: join(dir, K.stem + '.standalone.test.mjs'),
                json: existsSync(jp) ? JSON.parse(readFileSync(jp, 'utf8')) : null });
        });
        FX.set(id, p);
    }
    return FX.get(id);
}
// start all eight now so the rows below only wait
const WARM = ['k1', 'k2', 'k3', 'k4'].flatMap((k) => [shrinkOf(k, false, false), shrinkOf(k, true, k !== 'k1')]);
const T = { timeout: 600000 };

// ---- ASSERTION 1: argv ----
const HEAD_UNKNOWN = (a) => "unknown argument '" + a + "' (the only argument is --smoke; " +
    'everything else is a SOAK_* env key)';   // HEAD e9f8e6a text, .handoff/r6-evidence/argv-table.txt
const SHRINK_ARGS = ['--smoke', '--emit-test'];
const PC = (argv, args) => CFG.parseConfig({}, { roster: ROSTER, scenarios: ALL_SCENARIOS,
    covOffSupported: COV_OFF_SUPPORTED, argv, args });
const msgOf = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('no throw'); };

test('A1 argv in process: --emit-test sets emitTest; typos, repeats, bad opts.args and the default door fail closed',
    () => {
    assert.equal(PC(['--emit-test'], SHRINK_ARGS).emitTest, true);
    assert.equal(PC([], SHRINK_ARGS).emitTest, false);
    assert.equal(PC(['--smoke'], SHRINK_ARGS).emitTest, false);
    assert.match(msgOf(() => PC(['--emit-tst'], SHRINK_ARGS)).message, /unknown argument '--emit-tst'/);
    assert.match(msgOf(() => PC(['--emit-test', '--emit-test'], SHRINK_ARGS)).message,
        /duplicate argument '--emit-test'/);
    assert.ok(msgOf(() => PC([], ['--bogus'])) instanceof TypeError, 'an unknown opts.args entry is a TypeError');
    assert.ok(msgOf(() => PC([], [])) instanceof TypeError, 'empty opts.args is a TypeError');
    assert.ok(msgOf(() => PC([], ['--smoke', '--smoke'])) instanceof TypeError,
        'a repeated opts.args entry is a TypeError');
    // must-fail (HEAD): the default door still refuses --emit-test with the byte-identical HEAD text
    assert.equal(msgOf(() => PC(['--emit-test'], undefined)).message, HEAD_UNKNOWN('--emit-test'));
    assert.equal(msgOf(() => PC(['--x'], undefined)).message, HEAD_UNKNOWN('--x'));
});

test('A1 argv spawned: shrink 2 on typo / doubled flag; main (SHRINK=1) and replay 2', T, async () => {
    const e = { SOAK_REPLAY: KEYS.k1.key, SOAK_KERNEL: K_152, SOAK_OUT: join(mkd('argv'), 'x.jsonl') };
    const [typo, twice, main, rep] = await Promise.all([
        run([SHRINK_CLI, '--emit-tst'], Object.assign({ SOAK_SHRINK: '1' }, e), { timeout: 60000 }),
        run([SHRINK_CLI, '--emit-test', '--emit-test'], Object.assign({ SOAK_SHRINK: '1' }, e), { timeout: 60000 }),
        run([join(SOAK, 'main.mjs'), '--emit-test'], Object.assign({ SOAK_SHRINK: '1' }, e), { timeout: 60000 }),
        run([join(SOAK, 'replay.mjs'), '--emit-test'], e, { timeout: 60000 }),
    ]);
    assert.equal(typo.status, 2, typo.stderr);
    assert.match(typo.stderr, /^soak: CONFIG -- unknown argument '--emit-tst'/m);
    assert.equal(twice.status, 2, twice.stderr);
    assert.match(twice.stderr, /^soak: CONFIG -- duplicate argument '--emit-test'/m);
    assert.equal(main.status, 2, main.stderr);
    assert.match(main.stderr, /unknown argument '--emit-test'/);
    assert.equal(rep.status, 2, rep.stderr);
    assert.match(rep.stderr, /unknown argument '--emit-test'/);
});

test('A1 K1 + --emit-test runs the shrink to exit 1 (must-fail: HEAD exits 2 unknown argument)', T, async () => {
    const r = await shrinkOf('k1', true, false);
    assert.equal(r.status, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /unknown argument/);
});

// ---- ASSERTION 2: parity without the flag ----
const KINDS = ['k1', 'k2', 'k3', 'k4'];
const strip = (j) => { const o = Object.assign({}, j); delete o.createdAt; return o; };
const diffLines = (a, b) => {
    const x = a.split('\n'), y = b.split('\n');
    assert.equal(x.length, y.length, 'line counts');
    const out = [];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) out.push([x[i], y[i]]);
    return out;
};
for (const k of KINDS) {
    test('A2 parity ' + k + ': no flag -> HEAD golden json; harness test differs in 1 line', T, async () => {
        const r = await shrinkOf(k, false, false);
        const want = GOLD[k];
        assert.equal(r.status, 1, r.stderr);
        const j = r.json;
        assert.ok(j !== null, 'json written');
        assert.deepEqual(Object.keys(j), want.keys.concat(['createdAt']), 'key order');
        const g = strip(j);
        const scal = Object.assign({}, g); delete scal.script; delete scal.kernel; delete scal.node;
        assert.deepEqual(scal, want.scalars);
        assert.deepEqual(g.script, want.script);
        assert.equal(r.stdout.split('\n')[0].split(' json=')[0], want.shrinkLine,
            'SHRINK line byte-identical up to json=');
        assert.doesNotMatch(r.stdout, /standalone=/);
        assert.equal(existsSync(r.stdPath), false, 'no standalone written without the flag');
        const src = readFileSync(r.testPath, 'utf8');
        const d = diffLines(goldenTest(k), src);
        assert.equal(d.length, 1, 'exactly one changed line, got ' + d.length);   // must-fail: reverting task 3 -> 0
        assert.ok(d[0][0].indexOf('adapters/lite.mjs') !== -1 && d[0][0].indexOf('liteS3') === -1, d[0][0]);
        assert.ok(d[0][1].indexOf('adapters/lite-s3.mjs') !== -1 && d[0][1].indexOf('.liteS3Adapter') !== -1, d[1]);
    });
}

test('A2 teeth: the line counter reports 0 for identical text and 1 for one changed line', () => {
    assert.equal(diffLines(goldenTest('k1'), goldenTest('k1')).length, 0);
    assert.equal(diffLines('a\nb\nc', 'a\nX\nc').length, 1);
});

for (const k of KINDS) {
    test('A2 flag ' + k
        + ': the same scalars, script and harness test; the three new keys sit right before createdAt', T, async () => {
        const [p, f] = await Promise.all([shrinkOf(k, false, false), shrinkOf(k, true, k !== 'k1')]);
        assert.deepEqual(Object.keys(f.json), GOLD[k].keys.concat(['emitted', 'standalone', 'emitReason',
            'createdAt']));
        const a = strip(f.json); delete a.emitted; delete a.standalone; delete a.emitReason;
        const b = strip(p.json);
        for (const o of [a, b]) { delete o.kernel; delete o.node; }
        assert.deepEqual(a, b);
        assert.equal(readFileSync(f.testPath, 'utf8'), readFileSync(p.testPath, 'utf8'),
            'the harness test is flag-independent');
    });
}

// ---- ASSERTION 3: D-b143-1a (the harness test uses lite-s3) ----
test('A3 K2 harness test: 1 on the capacity mutant, 0 on tree; the HEAD golden exits 2 (unmodelled)', T, async () => {
    const r = await shrinkOf('k2', false, false);
    const head = join(mkd('a3'), KEYS.k2.stem + '.head.test.mjs');
    writeFileSync(head, goldenTest('k2'));
    const [mut, tree, old] = await Promise.all([
        run([r.testPath], { SOAK_KERNEL: K_CAP }, { cwd: tmpdir(), timeout: 120000 }),
        run([r.testPath], { SOAK_KERNEL: K_TREE }, { cwd: tmpdir(), timeout: 120000 }),
        run([head], { SOAK_KERNEL: K_CAP }, { cwd: tmpdir(), timeout: 120000 }),
    ]);
    assert.equal(mut.status, 1, mut.stdout + mut.stderr);
    assert.match(mut.stdout, /^shrink-test: REPRODUCED key=CAPACITY:0:0xaa6a0e89 /);
    assert.equal(tree.status, 0, tree.stdout + tree.stderr);
    assert.match(tree.stdout, /^shrink-test: CLEAN /);
    assert.equal(old.status, 2, 'HEAD golden: ' + old.stdout + old.stderr);   // must-fail control
    assert.match(old.stderr, /unmodelled capacity op/);
});

// ---- ASSERTION 4: the standalone ----
const STD_CODE = { K_UNSET: {}, K_EMPTY: { SOAK_KERNEL: '' },
    K_REL: { SOAK_KERNEL: 'node_modules/lite-signal-1.5.2/Signal.js' },
    K_MISSING: { SOAK_KERNEL: join(TMP, 'no-such-dir', 'Signal.js') } };

test('A4 K1 --emit-test: emitted true, standalone path beside the harness test, SHRINK line gains standalone=', T,
    async () => {
    const r = await shrinkOf('k1', true, false);
    assert.equal(r.json.emitted, true);
    assert.equal(r.json.emitReason, null);
    assert.equal(r.json.standalone, r.stdPath);
    assert.ok(existsSync(r.stdPath), 'standalone written');
    assert.match(r.stdout, new RegExp('^soak: SHRINK -- .* standalone=' + r.stdPath.replace(/[.*+?^${}()|[\]\\]/g,
        '\\$&') + '$', 'm'));
    assert.match(r.stdout, /^soak: END verdict=FAIL exit=1 /m);
});

test('A4 K1 standalone: exits 1 on rev152 (must-fail control), 0 on the tree kernel; the model value 58 is asserted',
    T, async () => {
    const r = await shrinkOf('k1', true, false);
    const [old, tree] = await Promise.all([
        run([r.stdPath], { SOAK_KERNEL: K_152 }, { cwd: tmpdir(), timeout: 120000 }),
        run([r.stdPath], { SOAK_KERNEL: K_TREE }, { cwd: tmpdir(), timeout: 120000 }),
    ]);
    assert.equal(old.status, 1, 'rev152: ' + old.stdout + old.stderr);
    assert.match(old.stdout + old.stderr, /\b58\b/, 'the failure names the model value (fails[].detail: model=58)');
    assert.equal(tree.status, 0, 'tree: ' + tree.stdout + tree.stderr);
});

test('A4 K1 standalone exit contract: 2 CONFIG (8 shapes), 3 CRASH', T, async () => {
    const r = await shrinkOf('k1', true, false);
    const dd = mkd('std');
    const noReg = join(dd, 'noreg.mjs'); writeFileSync(noReg, 'export const x = 1;\n');
    const broken = join(dd, 'broken.mjs'); writeFileSync(broken, 'export const = ;\n');
    const cases = [
        ['unset', [], STD_CODE.K_UNSET], ['empty', [], STD_CODE.K_EMPTY], ['relative', [], STD_CODE.K_REL],
        ['missing', [], STD_CODE.K_MISSING], ['argv', ['x'], { SOAK_KERNEL: K_152 }], ['argv --smoke', ['--smoke'],
            { SOAK_KERNEL: K_152 }],
        ['no createRegistry', [], { SOAK_KERNEL: noReg }], ['unloadable', [], { SOAK_KERNEL: broken }],
    ];
    const res = await Promise.all(cases.map((c) => run([r.stdPath].concat(c[1]), c[2], { cwd: tmpdir(),
        timeout: 120000 })));
    cases.forEach((c, i) => {
        assert.equal(res[i].status, 2, c[0] + ': ' + res[i].stdout + res[i].stderr);
        assert.match(res[i].stderr, /^standalone-test: CONFIG -- /, c[0]);
        assert.equal(lines(res[i].stderr).length, 1, c[0] + ': exactly one stderr line: ' + res[i].stderr);
    });
    const crash = await run([r.stdPath], { SOAK_KERNEL: K_THROW }, { cwd: tmpdir(), timeout: 120000 });
    assert.equal(crash.status, 3, crash.stdout + crash.stderr);
    assert.match(crash.stderr, /^standalone-test: CRASH -- /m);
});

test('A4 K1 standalone source: ASCII, no bench/soak, node: imports + kernel, teardown', T, async () => {
    const r = await shrinkOf('k1', true, false);
    const src = readFileSync(r.stdPath, 'utf8');
    assert.equal(/[^\x00-\x7f]/.test(src), false, 'ASCII');
    assert.equal(src.indexOf('bench/soak'), -1, 'no bench/soak');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const specs = [];
    for (const m of code.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g)) specs.push(m[2]);
    for (const m of code.matchAll(/^\s*import\s*(['"])([^'"]+)\1/gm)) specs.push(m[2]);
    for (const m of code.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) specs.push(m[2]);
    for (const s of specs) assert.ok(s.indexOf('node:') === 0, 'non-node import: ' + s);
    const dyn = (code.match(/\bimport\s*\(/g) || []).length;
    const lit = (code.match(/\bimport\s*\(\s*['"]/g) || []).length;
    assert.equal(dyn - lit, 1, 'exactly one non-literal dynamic import (the kernel)');
    assert.ok(src.indexOf('SOAK_KERNEL') !== -1);
    assert.ok(/activeNodes/.test(src) && /activeLinks/.test(src), 'teardown asserts the live counts');
});

// ---- ASSERTION 5: refusals ----
for (const [k, re, lab] of [['k2', /^lane: CAPACITY/, 'lane: CAPACITY'], ['k3', /^lane: ERROR/, 'lane: ERROR'],
    ['k4', /^target: OB:batch-early-run/, 'target: OB:batch-early-run']]) {
    test('A5 refusal ' + k + ' -> ' + lab
        + ': exit 2, one CONFIG line, emitted false, planted standalone deleted, harness test kept', T, async () => {
        const r = await shrinkOf(k, true, true);
        assert.equal(r.status, 2, r.stdout + r.stderr);
        const cfg = lines(r.stderr).filter((l) => l.indexOf('soak: CONFIG') === 0);
        assert.equal(cfg.length, 1, r.stderr);
        assert.match(cfg[0], new RegExp('^soak: CONFIG -- shrink --emit-test: .*'
            + lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(r.stdout, /soak: END/);
        assert.equal(r.json.emitted, false);
        assert.equal(r.json.standalone, null);
        assert.match(r.json.emitReason, re);
        assert.equal(existsSync(r.stdPath), false, 'the planted standalone is deleted');
        assert.ok(existsSync(r.testPath), 'the harness test is still written');
    });
}

const K1_INFO = () => Object.assign({}, JSON.parse(JSON.stringify(GOLD.k1.scalars)),
    { script: JSON.parse(JSON.stringify(GOLD.k1.script)) });
const FAIL_O1C = () => ({ failure: { step: 3, op: 'end', fails: [{ oracle: 'O1c', sig: 'computed-mismatch',
    detail: 'node#15 (sum) engine=0 model=58' }] } });   // README.txt (c) K1 confirm run
const refuse = (mut, re, r) => {
    const info = K1_INFO();
    mut(info);
    const out = em().emittable(info, r || FAIL_O1C());
    assert.equal(out.ok, false, 'must refuse: ' + re);
    assert.match(out.reason, re);
};

test('A5 emittable in process: K1 is emittable; O5 counts too; each refusal class has its prefix', () => {
    assert.equal(em().emittable(K1_INFO(), FAIL_O1C()).ok, true, 'K1 (O1c, sum, batch) is emittable');
    for (const detail of ['signals engine=3 model=2', 'activeNodes engine=5 model=4',
        'activeLinks engine=3 expected=2 (slack 0)']) {
        const o = em().emittable(K1_INFO(), { failure: { step: 3, op: 'end', fails: [{ oracle: 'O5', sig: 'x',
            detail }] } });
        assert.equal(o.ok, true, detail + ': ' + o.reason);
    }
    for (const lane of ['ERROR', 'REGISTRY', 'CAPACITY', 'HOOK', 'LIFECYCLE', 'OWNER', 'RECYCLE', 'SCHEDULER',
        'FUTURE']) {
        refuse((i) => { i.lane = lane; }, new RegExp('^lane: ' + lane));
    }
    refuse(() => {}, /^target: /, { failure: { step: 1, op: 'x', fails: [{ oracle: 'O2', sig: 'glitch',
        detail: 'd' }] } });
    refuse(() => {}, /^target: OB:batch-early-run/, { failure: { step: 3, op: 'batch', fails: [{ oracle: 'OB',
        sig: 'batch-early-run', detail: 'effect#21 re-ran inside an open batch (depth 1)' }] } });
    refuse((i) => { i.script.ops[0].o = 'frob'; }, /^op: /);
    for (const f of ['chk', 'pull', 'u', 'thr', 'eq', 'dis', 'cyc', 'rank', 'role']) {
        refuse((i) => { i.script.ops[0][f] = 1; }, new RegExp('^flag: ops\\[0\\]\\.' + f));
    }
    refuse((i) => { i.script.ops[2].thr = 1; }, /^flag: ops\[2\]\.thr/);
    for (const f of ['thr', 'try', 'w']) refuse((i) => { i.script.ops[1].spec[f] = true; }, /^flag: /);
    refuse((i) => { i.script.ops[0].zzz = 1; }, /^key: /);
    refuse((i) => { i.script.ops[1].spec.zz = 1; }, /^key: /);
    refuse((i) => { i.script.zzz = 1; }, /^key: /);
    refuse((i) => { i.script.capacity = { maxNodes: 32 }; }, /^key: /);
    refuse((i) => { i.script.ops[1].spec.k = 'outer'; }, /^kind: /);
    refuse((i) => { i.script.ops[1].spec.k = 'child'; }, /^kind: /);
    refuse((i) => { i.script.ops[0].v = -3; }, /^value: /);
    refuse(() => {}, /^detail: /, { failure: { step: 3, op: 'end', fails: [{ oracle: 'O1c', sig: 'computed-mismatch',
        detail: 'node#15 (sum) engine=0 model="x"' }] } });
    refuse(() => {}, /^detail: /, { failure: { step: 3, op: 'end', fails: [{ oracle: 'O1e', sig: 'effect-mismatch',
        detail: 'effect#3 saw [#1=0,#2=1] model [#1=1,#2=2,#3=3,#4=4,#5=5,#6=6,#7=7,#8=8,#9=9,#10=10...' }] } });
});

test('A5 emittable precedence: first match wins (lane before target before op before flag)', () => {
    refuse((i) => { i.lane = 'CAPACITY'; i.script.ops[0].o = 'frob'; }, /^lane: CAPACITY/,
        { failure: { step: 1, op: 'x', fails: [{ oracle: 'O2', sig: 's', detail: 'd' }] } });
    refuse((i) => { i.script.ops[0].o = 'frob'; i.script.ops[1].thr = 1; }, /^target: /,
        { failure: { step: 1, op: 'x', fails: [{ oracle: 'O2', sig: 's', detail: 'd' }] } });
    refuse((i) => { i.script.ops[0].o = 'frob'; i.script.ops[1].thr = 1; }, /^op: /);
    refuse((i) => { i.script.ops[0].chk = 1; i.script.ops[0].v = -3; }, /^flag: ops\[0\]\.chk/);
});

// ---- ASSERTION 6: differential ----
function mulberry32(a) {
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0);
    };
}
const SPECIAL = [0, -1, 50, 51];
/** Returns {mismatch, byKind, condHigh, condLow, reads} over `pairs` seeded (spec, inputs) pairs. */
function differential(mod, pairs) {
    const rs = mulberry32(0x5eed), rv = mulberry32(0x5eed ^ 0x9e3779b9);   // independent spec / value streams
    const kinds = ['sum', 'identity', 'select', 'cond', 'hash'];
    const st = { mismatch: 0, byKind: { sum: 0, identity: 0, select: 0, cond: 0, hash: 0 }, condHigh: 0, condLow: 0,
        first: null };
    for (let p = 0; p < pairs; p++) {
        const k = kinds[rs() % 5];
        const n = 1 + (rs() % 6);
        const d = [];
        for (let i = 0; i < n; i++) d.push(rs() % 40);
        const spec = k === 'select' ? { k, s: rs() % 40, d } : { k, d };
        const tab = [];
        for (let i = 0; i < 40; i++) {
            tab.push((rv() & 1) ? SPECIAL[rv() % 4] : ((rv() & 3) === 0 ? (rv() | 0) : rv() % 100));
        }
        const trace = (log) => (ref) => { log.push(ref); return tab[ref]; };
        const la = [], lb = [];
        const want = evalKind(spec, trace(la), 0);
        const got = mod.specToSource(spec);
        const fn = new Function('return (' + got + ')')();
        let have;
        try { have = fn(trace(lb)); } catch (e) { have = 'THROW ' + String(e); }
        st.byKind[k]++;
        if (k === 'cond') { if (tab[d[0]] > 50 && d.length > 1) st.condHigh++; else st.condLow++; }
        if (!Object.is(want, have)
            || la.join() !== lb.join()) { st.mismatch++; if (st.first === null) st.first = [spec, want, have]; }
    }
    return st;
}

test('A6 differential: 10,000 seeded pairs, specToSource vs evalKind (Object.is); floor; fixed vectors', () => {
    const st = differential(em(), 10000);
    assert.equal(st.mismatch, 0, JSON.stringify(st.first));
    for (const k of Object.keys(st.byKind)) assert.ok(st.byKind[k] >= 1500, k + ' covered ' + st.byKind[k]
        + ' (floor 1500)');
    assert.ok(st.condHigh >= 100 && st.condLow >= 100, 'cond branches ' + st.condHigh + '/' + st.condLow);
    const ev = (spec, tab) => new Function('return (' + em().specToSource(spec) + ')')()((r) => tab[r]);
    assert.equal(ev({ k: 'hash', d: [] }, {}), 7);
    assert.equal(ev({ k: 'hash', d: [1] }, { 1: 1 }), 218);
    assert.equal(ev({ k: 'cond', d: [0, 1] }, { 0: 50, 1: 9 }), 50);
    assert.equal(ev({ k: 'cond', d: [0, 1] }, { 0: 51, 1: 9 }), 9);
});

test('A6 teeth: a tmpdir copy of emit.mjs with its cond "> 50" -> ">= 50" fails >= 1 pair', async () => {
    const src = readFileSync(join(SOAK, 'emit.mjs'), 'utf8');
    const n = src.split('> 50').length - 1;
    assert.equal(n, 1, 'emit.mjs must contain "> 50" exactly once for this mutant (found ' + n + ')');
    const abs = src.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.[^'"]*)\2/g,
        (m, pre, q, rel) => pre + JSON.stringify(pathToFileURL(resolve(SOAK, rel)).href)).replace('> 50', '>= 50');
    const f = join(mkd('mut-emit'), 'emit-mut.mjs');
    writeFileSync(f, abs);
    const mod = await import(pathToFileURL(f).href);
    assert.ok(differential(mod, 10000).mismatch >= 1, 'the cond mutant must be caught');
});

// ---- ASSERTION 7: engine untouched, standalone retention ----
test('A7 Signal.js and Watch.js are unchanged vs HEAD (no hot-body change in R6)', (t) => {
    const tr = spawnSync('git', ['ls-files', '--error-unmatch', 'Signal.js', 'Watch.js'], { cwd: ROOT,
        timeout: 30000 });
    if (tr.status !== 0) { t.skip('Signal.js / Watch.js not tracked here'); return; }
    const r = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'Signal.js', 'Watch.js'], { cwd: ROOT,
        timeout: 30000 });
    if (r.error || r.status === null || r.status > 1) { t.skip('git unavailable here'); return; }
    assert.equal(r.status, 0, 'Signal.js / Watch.js differ from HEAD');
});

// Drift gate: emit.mjs copies exec.mjs END_CHECK_SALT; the two literals must stay equal (with a must-fail mutant).
test('END_CHECK_SALT in emit.mjs equals exec.mjs (drift gate, must-fail on a changed literal)', () => {
    const RE = /^const END_CHECK_SALT = (0x[0-9a-f]+);$/m;
    const saltOf = (src) => {
        const g = new RegExp(RE.source, 'gm');
        const all = src.match(g) || [];
        if (all.length !== 1) throw new Error('END_CHECK_SALT matches: ' + all.length);
        return RE.exec(src)[1];
    };
    const saltsEqual = (a, b) => saltOf(a) === saltOf(b);
    const exSrc = readFileSync(join(SOAK, 'exec.mjs'), 'utf8');
    const emSrc = readFileSync(join(SOAK, 'emit.mjs'), 'utf8');
    assert.equal(saltOf(exSrc).length > 2, true);
    assert.equal(saltOf(emSrc).length > 2, true);
    assert.equal(saltsEqual(exSrc, emSrc), true, 'emit.mjs END_CHECK_SALT drifted from exec.mjs');
    const lit = saltOf(emSrc);
    assert.equal(emSrc.split('const END_CHECK_SALT = ' + lit + ';').length, 2, 'mutant replace must match once');
    const mut = emSrc.replace('const END_CHECK_SALT = ' + lit + ';', () => 'const END_CHECK_SALT = 0x12345678;');
    assert.equal(saltsEqual(exSrc, mut), false, 'the comparator must report the changed salt');
});

test('A7 K1 standalone on the tree kernel disposes everything and exits 0 (activeNodes 0 / activeLinks 0 asserted)',
    T, async () => {
    const r = await shrinkOf('k1', true, false);
    const tree = await run([r.stdPath], { SOAK_KERNEL: K_TREE }, { cwd: tmpdir(), timeout: 120000 });
    assert.equal(tree.status, 0, tree.stdout + tree.stderr);
});

test('fixtures settled', T, async () => { await Promise.all(WARM); });
