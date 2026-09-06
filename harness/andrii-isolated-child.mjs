// andrii-isolated-child.mjs
// Runs one framework + one Andrii creation row in this clean V8 process and
// emits JSON. One framework per process keeps every IC site monomorphic --
// the same isolation Andrii's harness gets via fork() per scenario.
//
// 2026-08 audit Phase 3 repairs (the instrument was DEAD and, worse, lying):
//   - FRESH REGISTRY PER TIMED SAMPLE. The old child reused one registry
//     across warmups and all BENCH_RUNS samples with zero disposal, so
//     ~500k undisposed nodes accumulated, the pool grew mid-run, and
//     min-of-N quietly selected whichever sample dodged a growth chunk --
//     while alien's garbage simply GC'd away between samples. Now each
//     sample times a fresh, exactly pre-sized, zero-occupancy registry
//     (warmups run on a separate scratch registry; hidden classes are shared
//     across registry instances, so ICs stay monomorphic).
//   - RESOLVED-VERSION STAMPING. The old "v120"/"v121" labels were relics:
//     "v120" imported whatever @zakkster/lite-signal was installed (1.4.0 at
//     repair time) and "v121" imported the working tree. Frameworks are now
//     "npm" / "tree" / "alien" and every result carries the version string
//     read from the RESOLVED package -- the label can no longer lie.
//   - MISSING FRAMEWORK != CRASH. alien-signals lives in bench/node_modules
//     (harness/ has no dependency tree), so it is resolved through
//     bench/package.json via createRequire. If a competitor is absent the
//     child emits { unavailable: true, reason } and exit 0 -- the runner
//     renders n/a for competitors and hard-fails only when a LITE framework
//     is missing.
//   - SMOKE ORACLE. Before anything is timed, the adapter must prove live
//     reactivity (signal -> computed recompute on write). A present-but-
//     broken adapter is a FAILURE, never a timed row of garbage.
//   - GROWTH WITNESS. For lite frameworks each sample reports whether the
//     pool grew inside the timed body (stats().poolGrowths delta), so a
//     growth-contaminated sample is visible instead of silently shaping min().
//
// argv: framework row     env: BENCH_RUNS, LITE_NPM_PATH, LITE_TREE_PATH, ALIEN_PATH

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const [, , FRAMEWORK, ROW] = process.argv;
const BENCH_RUNS = parseInt(process.env.BENCH_RUNS || "4", 10);
const HERE = dirname(fileURLToPath(import.meta.url));

const emit = (obj) => { process.stdout.write(JSON.stringify(obj)); };

if (!Number.isFinite(BENCH_RUNS) || BENCH_RUNS < 1) {
    emit({ framework: FRAMEWORK, row: ROW, error: `BENCH_RUNS must be a positive integer (got "${process.env.BENCH_RUNS}")` });
    process.exit(1);
}

function pkgVersionNear(resolvedFile) {
    // Walk up from a resolved module file to its package.json.
    let dir = dirname(resolvedFile);
    for (let i = 0; i < 6; i++) {
        try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version; }
        catch { dir = dirname(dir); }
    }
    return "unknown";
}

/* -- framework resolution ---------------------------------------------------- */
// makeAdapter() returns a FRESH world each call (fresh registry for lite;
// alien has module-global state, so "fresh" is the module itself plus the
// GC that already reclaims its unreferenced nodes between samples).
let makeAdapter = null;
let VERSION = "unknown";
let LABEL = FRAMEWORK;
let statsOf = null;      // per-adapter stats accessor (lite only); null = no counters

// Timed-registry sizing: the largest row builds 100k signals + 100k computeds
// with <= 100k links. 1<<18 nodes / 1<<17 links covers every row with
// headroom; "grow" stays on as a safety valve and the growth WITNESS reports
// if it ever fires inside a timed body.
const LITE_SIZES = { maxNodes: 1 << 18, maxLinks: 1 << 17, onCapacityExceeded: "grow" };

try {
    if (FRAMEWORK === "npm" || FRAMEWORK === "tree") {
        // "npm" must NEVER use the bare specifier: this file lives INSIDE the
        // @zakkster/lite-signal package, so Node's self-reference resolution
        // maps "@zakkster/lite-signal" back to ../Signal.js -- which is how
        // the old v120 lane silently timed the tree twice while claiming to
        // compare two published versions. The installed copy is addressed by
        // its node_modules path explicitly, and its absence is `unavailable`,
        // never a silent fallback to the tree.
        let resolved;
        if (FRAMEWORK === "tree") {
            resolved = process.env.LITE_TREE_PATH || join(HERE, "../Signal.js");
            // Stamp from the package.json NEXT TO the target engine -- an
            // LITE_TREE_PATH override may point at a SIBLING version folder
            // (harness/trend.mjs does exactly that), and stamping this repo's
            // version onto a foreign tree would be the v120 lie all over again.
            VERSION = pkgVersionNear(resolved) + " (tree)";
        } else if (process.env.LITE_NPM_PATH) {
            // FORCE a filesystem path: a bare specifier here would self-
            // reference-resolve to the tree (the exact v120 lie), and a
            // relative one would version-stamp from whatever package.json
            // sits near cwd. resolve() makes both absolute; a bare name
            // becomes a nonexistent path and fails LOUDLY as unavailable.
            resolved = resolvePath(process.env.LITE_NPM_PATH);
            VERSION = pkgVersionNear(resolved);
        } else {
            const pkgDir = join(HERE, "../node_modules/@zakkster/lite-signal");
            const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
            resolved = join(pkgDir, pkg.main || "Signal.js");
            VERSION = pkg.version;
        }
        const mod = await import(/^\//.test(resolved) ? "file://" + resolved : resolved);
        makeAdapter = () => {
            const r = mod.createRegistry(LITE_SIZES);
            return {
                signal: (initial) => { const v = r.signal(initial); return { read: v, write: v.set }; },
                computed: (fn) => ({ read: r.computed(fn) }),
                stats: () => r.stats(),
            };
        };
        statsOf = (a) => a.stats();
    } else if (FRAMEWORK === "alien") {
        // harness/ carries no dependency tree; competitors resolve through the
        // bench workspace, where the user installs them.
        const benchRequire = createRequire(join(HERE, "../bench/package.json"));
        const resolved = process.env.ALIEN_PATH || benchRequire.resolve("alien-signals");
        const alien = await import(/^\//.test(resolved) ? "file://" + resolved : resolved);
        VERSION = pkgVersionNear(resolved);
        makeAdapter = () => ({
            signal: (initial) => { const s = alien.signal(initial); return { read: s, write: s }; },
            computed: (fn) => ({ read: alien.computed(fn) }),
        });
    } else {
        emit({ framework: FRAMEWORK, row: ROW, error: "unknown framework " + FRAMEWORK });
        process.exit(1);
    }
} catch (err) {
    // Unresolvable module = the framework is not installed here. The RUNNER
    // decides whether that is n/a (competitor) or a failure (lite).
    emit({ framework: FRAMEWORK, row: ROW, unavailable: true, reason: err.message });
    process.exit(0);
}

/* -- smoke oracle ------------------------------------------------------------ */
// Prove live reactivity before timing anything. A broken adapter must be a
// loud failure, never a plausible-looking row of numbers.
{
    const a = makeAdapter();
    const s = a.signal(1);
    const c = a.computed(() => s.read() + 1);
    const v1 = c.read();
    s.write(2);
    const v2 = c.read();
    if (v1 !== 2 || v2 !== 3) {
        emit({ framework: FRAMEWORK, row: ROW, error: `smoke oracle failed: computed read ${v1} then ${v2}, want 2 then 3` });
        process.exit(1);
    }
}

/* -- Andrii creation rows (shapes byte-compatible with the original) --------- */
// EVERY body stores what it creates into `out`, a pre-allocated array that
// stays live past the timed window (2026-08 Phase 3 review, HIGH): alien's
// computed() is a side-effect-free bind() allocation, so a DISCARDED result
// is a legal escape-analysis target -- measured collapsing to ~2 ns/op
// (empty-loop speed) once TurboFan kicked in, while lite's registry writes
// can never be elided. Discarding results compared real work against a
// partially deleted loop; storing them makes the allocation observable for
// every framework symmetrically.
const COUNT = 1e5;

const SCENARIOS = {
    createDataSignals: {
        count: COUNT, scount: COUNT, body: (A, n, sources, out) => {
            for (let i = 0; i < n; i++) out[i] = sources[i] = A.signal(i);
        }
    },
    createComputations0to1: {
        count: COUNT, scount: 0, body: (A, n, _sources, out) => {
            for (let i = 0; i < n; i++) out[i] = A.computed(() => i);
        }
    },
    createComputations1to1: {
        count: COUNT, scount: COUNT, body: (A, n, sources, out) => {
            for (let i = 0; i < n; i++) { const get = sources[i].read; out[i] = A.computed(() => get()); }
        }
    },
    createComputations2to1: {
        count: COUNT / 2, scount: COUNT, body: (A, n, sources, out) => {
            for (let i = 0; i < n; i++) {
                const g1 = sources[i * 2].read, g2 = sources[i * 2 + 1].read;
                out[i] = A.computed(() => g1() + g2());
            }
        }
    },
    createComputations4to1: {
        count: COUNT / 4, scount: COUNT, body: (A, n, sources, out) => {
            for (let i = 0; i < n; i++) {
                const g1 = sources[i * 4].read, g2 = sources[i * 4 + 1].read;
                const g3 = sources[i * 4 + 2].read, g4 = sources[i * 4 + 3].read;
                out[i] = A.computed(() => g1() + g2() + g3() + g4());
            }
        }
    },
    createComputations1000to1: {
        count: COUNT / 1000, scount: COUNT, body: (A, n, sources, out) => {
            for (let i = 0; i < n; i++) {
                const off = i * 1000;
                out[i] = A.computed(() => { let sum = 0; for (let j = 0; j < 1000; j++) sum += sources[off + j].read(); return sum; });
            }
        }
    },
    createComputations1to2: {
        count: COUNT, scount: COUNT / 2, body: (A, n, sources, out) => {
            let k = 0;
            for (let i = 0; i < n / 2; i++) {
                const get = sources[i].read;
                out[k++] = A.computed(() => get()); out[k++] = A.computed(() => get());
            }
        }
    },
    createComputations1to4: {
        count: COUNT, scount: COUNT / 4, body: (A, n, sources, out) => {
            let k = 0;
            for (let i = 0; i < n / 4; i++) {
                const get = sources[i].read;
                out[k++] = A.computed(() => get()); out[k++] = A.computed(() => get());
                out[k++] = A.computed(() => get()); out[k++] = A.computed(() => get());
            }
        }
    },
    createComputations1to8: {
        count: COUNT, scount: COUNT / 8, body: (A, n, sources, out) => {
            let k = 0;
            for (let i = 0; i < n / 8; i++) {
                const get = sources[i].read;
                out[k++] = A.computed(() => get()); out[k++] = A.computed(() => get());
                out[k++] = A.computed(() => get()); out[k++] = A.computed(() => get());
                out[k++] = A.computed(() => get()); out[k++] = A.computed(() => get());
                out[k++] = A.computed(() => get()); out[k++] = A.computed(() => get());
            }
        }
    },
    createComputations1to1000: {
        count: COUNT, scount: COUNT / 1000, body: (A, n, sources, out) => {
            let k = 0;
            for (let i = 0; i < n / 1000; i++) {
                const get = sources[i].read;
                for (let j = 0; j < 1000; j++) out[k++] = A.computed(() => get());
            }
        }
    },
};

if (!SCENARIOS[ROW]) {
    emit({ framework: FRAMEWORK, row: ROW, error: "unknown row " + ROW });
    process.exit(1);
}

// Sinks allocated once per process (one row per process, sizes fixed).
const timedSink = new Array(SCENARIOS[ROW] ? SCENARIOS[ROW].count : 0);
const warmSink = new Array(SCENARIOS[ROW] ? SCENARIOS[ROW].count / 100 : 0);
let sinkWitness = "unset";

function makeSources(A, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = A.signal(i);
    return out;
}

/* -- one sample: warm on a scratch world, time on a fresh sized one ---------- */
function runSample(scenarioName) {
    const { count, scount, body } = SCENARIOS[scenarioName];

    // Warmup (JIT) on a scratch adapter -- its garbage never touches the
    // timed registry. Hidden classes are shared across registry instances,
    // so the timed body's IC sites stay warm and monomorphic.
    const warm = makeAdapter();
    for (let round = 0; round < 3; round++) {
        const ws = scount > 0 ? makeSources(warm, scount / 100) : null;
        // scale scount AND count together so per-source fan shapes stay valid
        body(warm, count / 100, ws, warmSink);
    }

    // Timed: a fresh, pre-sized, zero-occupancy world.
    const A = makeAdapter();
    let sources = scount > 0 ? makeSources(A, scount) : null;
    if (scount > 0) for (let i = 0; i < scount; i++) sources[i].read();
    globalThis.gc?.();

    const g0 = statsOf ? statsOf(A).poolGrowths : 0;
    const t0 = performance.now();
    body(A, count, sources, timedSink);
    const t1 = performance.now();
    sinkWitness = typeof timedSink[count - 1];   // liveness read past the window
    const grew = statsOf ? statsOf(A).poolGrowths - g0 : 0;

    sources = null;
    globalThis.gc?.();
    return { ms: t1 - t0, grew };
}

const samples = [];
const growth = [];
for (let i = 0; i < BENCH_RUNS; i++) {
    const r = runSample(ROW);
    samples.push(r.ms);
    growth.push(r.grew);
}
const sorted = [...samples].sort((a, b) => a - b);
const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
emit({
    framework: FRAMEWORK,
    label: LABEL,
    version: VERSION,
    row: ROW,
    samples,
    growth,                              // pool-growth chunks INSIDE each timed body (lite; always 0 for alien)
    min: Math.min(...samples),
    median,
    sinkWitness,                         // liveness proof: the created handles escaped the timed loop
});
