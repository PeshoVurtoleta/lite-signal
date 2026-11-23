// G2 (b251) -- mirror shapes on the LITE engine only: micro-suites (kairo closed forms, molBench,
// fan schedule), depgraph push (A4), and the mirror.mjs child CLI. No alien-signals / reflex-quant
// import anywhere (bench/node_modules is absent in CI): the child runs that name them use a resolve
// hook (fixtures/g2/no-engines) that makes both unresolvable. No .handoff path is read.
// Expected values:
//   * kairo: closed forms from the case bodies, by hand (avoidable 0+1+2+3=6; broad 49+49+1=99;
//     deep 49+50=99; diamond 5*(499+1)=2500; mux 2*45+10+90=190; repeatedObservers 30*99=2970;
//     triangle 10*99+45=1035; unstable 20*2*99=3960).
//   * molBench: the last pass runs two batches. Batch 1 (B=1, A=1999): C=2, D=[0,1,2,3,4] so D[2]=2,
//     D[4]=4, F=hard(2)=2+fib(16)=1599 (fib(16)=1597), G=2+2+4+1599=1607, effects 3204 and 1607.
//     Batch 2 (A=2000, B=2): C=0, F=1599 again (so the hard(F) effect is cut off in BOTH batches),
//     E=hard(0+2000+0)=3597 (E%2=1), G=0+1+4+1599=1604, effects hard(1604)=3201 and 1604.
//     Checksum = 3204+1607+3201+1604 = 9616; final G = 1604.
//   * fan: a plain simulation of the schedule (own LCG draw, own Set order, own effect semantics)
//     below (fanReference); manyEffectsFromOneSource 144 * 500500 * 2 = 144144000.
//   * push (A4): w4/L3/it10/warm5 -> 4 leaf effects per graph; the before design attached 4 more
//     after the warm-up (8).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRegistry } from "../Signal.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const BENCH = join(ROOT, "bench");
const CHILD = join(here, "fixtures", "g2", "micro-child.mjs");
const NOENG = join(here, "fixtures", "g2", "no-engines", "register.mjs");
const DG = await import(pathToFileURL(join(BENCH, "lib", "depgraph.mjs")).href);

function run(args, env, opts = {}) {
    const e = { ...process.env };
    for (const k of ["FW", "SCENARIO", "QUICK", "MOL_D", "FAN_VERBATIM", "BENCH_RUNS", "ROWS_ONLY", "CAPTURE_ID"]) delete e[k];
    Object.assign(e, env);
    const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: opts.timeout || 240000, killSignal: "SIGKILL", env: e, maxBuffer: 1 << 26 });
    assert.equal(r.signal, null, "child killed: " + r.signal);
    return r;
}
const child = (mode, rows, env) => run(["--expose-gc", CHILD, mode, ...rows], { QUICK: "1", ...env });
const table = (out) => Object.fromEntries(out.trim().split("\n").filter((l) => l.includes("\t")).map((l) => { const p = l.split("\t"); return [p[0], p.slice(1)]; }));

// ----------------------------------------------------------------------- kairo + mol
test("kairo closed-form checksums hold on lite (QUICK=1)", () => {
    const r = child("checksums", ["avoidablePropagation", "broadPropagation", "deepPropagation", "diamond", "mux", "repeatedObservers", "triangle", "unstable"]);
    assert.equal(r.status, 0, r.stderr);
    const t = table(r.stdout);
    assert.deepEqual(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Number(v[0])])), {
        avoidablePropagation: 6, broadPropagation: 99, deepPropagation: 99, diamond: 2500,
        mux: 190, repeatedObservers: 2970, triangle: 1035, unstable: 3960,
    });
});
test("molBench: checksum 9616 (final G 1604 is checked in-process), MOL_D=fresh ok, bad MOL_D throws at import", () => {
    let r = child("checksums", ["molBench"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "molBench\t9616\n");
    r = child("checksums", ["molBench"], { MOL_D: "fresh" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "molBench\t9616\n");
    r = child("checksums", ["molBench"], { MOL_D: "upstream" });
    assert.equal(r.status, 0, r.stderr);
    for (const bad of ["bogus", ""]) {
        r = child("checksums", ["molBench"], { MOL_D: bad });
        assert.equal(r.status, 1, JSON.stringify(bad));
        assert.equal(r.stdout, "");
        assert.ok(r.stderr.includes(`MOL_D=${JSON.stringify(bad)}: expected "upstream" (default) or "fresh"`), r.stderr.slice(0, 300));
    }
});

// ----------------------------------------------------------------------- fan
// Independent reference of the three mutation rows: draw 8 distinct source indices per step with the
// LCG (seed 0x9e3779b9, seed = imul(seed,1664525)+1013904223 >>> 0, index = seed % 128), write
// ++value to each in insertion order, run the effects once per batch if their inputs changed.
// run(1000) then run(1000) on one built graph; the checksum is read after both (QUICK FAN_ITERS = 1000).
function fanReference(kind) {
    const S = 128, STEPS = 2000;
    const val = Array.from({ length: S }, (_, i) => i);
    let seed = 0x9e3779b9, value = 0, checksum = 0;
    const total = () => val.reduce((a, b) => a + b, 0);
    const every16 = () => { let s = 0; for (let i = 0; i < S; i += 16) s += val[i]; return s; };
    let lastTotal = total(), lastDirect = every16();
    if (kind !== "direct") checksum += lastTotal;
    if (kind !== "computed") checksum += lastDirect;
    for (let step = 0; step < STEPS; step++) {
        const idx = [];
        while (idx.length < 8) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const k = seed % S; if (!idx.includes(k)) idx.push(k); }
        for (const k of idx) val[k] = ++value;
        const tn = total(), dn = every16();
        if (kind !== "direct" && tn !== lastTotal) checksum += tn;
        if (kind !== "computed" && dn !== lastDirect) checksum += dn;
        lastTotal = tn; lastDirect = dn;
    }
    return checksum;
}
const FAN_ROWS = {
    manySourcesIntoOneComputedEffectWithDirect: "both",
    manySourcesIntoOneComputedEffect: "computed",
    manySourcesIntoOneDirectEffect: "direct",
};
test("fan: every checksum equals the reference simulation, default and FAN_VERBATIM=1", () => {
    for (const env of [{}, { FAN_VERBATIM: "1" }, { FAN_VERBATIM: "0" }]) {
        const r = child("fan-sets", [], env);
        assert.equal(r.status, 0, r.stderr);
        const t = table(r.stdout);
        assert.equal(Number(t.manyEffectsFromOneSource[0]), 144 * 500500 * 2);
        for (const [name, kind] of Object.entries(FAN_ROWS)) assert.equal(Number(t[name][0]), fanReference(kind), name + " " + JSON.stringify(env));
    }
});
// Two oracles: the 9e21cba golden checksums (before the schedule change) must equal the simulation.
test("fan: checksums equal the 9e21cba golden literals", () => {
    const t = table(child("fan-sets", [], {}).stdout);
    assert.equal(t.manySourcesIntoOneComputedEffectWithDirect[0], "2096469844");
    assert.equal(t.manySourcesIntoOneComputedEffect[0], "2032874944");
    assert.equal(t.manySourcesIntoOneDirectEffect[0], "63594900");
});
test("fan: `new Set` count in the timed window is 0 by default, 1000 per sample under FAN_VERBATIM=1", () => {
    let t = table(child("fan-sets", [], {}).stdout);
    for (const name of Object.keys(FAN_ROWS)) assert.equal(t[name][1], "0", name);
    // manyEffectsFromOneSource never drew a Set
    assert.equal(t.manyEffectsFromOneSource[1], "0");
    t = table(child("fan-sets", [], { FAN_VERBATIM: "1" }).stdout);
    // QUICK: BENCH_RUNS = 1 sample, FAN_ITERS = 1000 steps, one Set per step
    for (const name of Object.keys(FAN_ROWS)) assert.equal(t[name][1], "1000", name);
    assert.equal(t.manyEffectsFromOneSource[1], "0");
});
test("fan: FAN_VERBATIM=2 and \"\" throw at import", () => {
    for (const bad of ["2", ""]) {
        const r = child("fan-sets", [], { FAN_VERBATIM: bad });
        assert.equal(r.status, 1, JSON.stringify(bad));
        assert.equal(r.stdout, "");
        assert.ok(r.stderr.includes(`FAN_VERBATIM=${JSON.stringify(bad)}: expected "1", "0" or unset`), r.stderr.slice(0, 300));
    }
});
test("fan: a run past the schedule throws; NaN iters throws", () => {
    const r = child("fan-past", ["manySourcesIntoOneDirectEffect"], {});
    assert.equal(r.status, 0, r.stderr);
    // 1000 warm-up + 1000 timed steps = 2000 consumed
    assert.equal(r.stdout, "past: fan: 1 steps past the 2000-step schedule\nnan: fan: NaN steps past the 2000-step schedule\n");
});

// ----------------------------------------------------------------------- depgraph push (A4)
function pushHarness() {
    let reg = createRegistry({ maxNodes: 262144, maxLinks: 1048576, prealloc: "lazy", onCapacityExceeded: "throw" });
    const h = { effectCalls: 0 };
    h.fw = {
        name: "lite-signal",
        signal: (v) => { const s = reg.signal(v); return { read: s, write: s.set }; },
        computed: (fn) => ({ read: reg.computed(fn) }),
        effect: (fn) => { h.effectCalls++; reg.effect(fn); },
        withBatch: (fn) => reg.batch(fn),
        withBuild: (fn) => fn(),
        reset() { reg.destroy(); reg = createRegistry({ maxNodes: 262144, maxLinks: 1048576, prealloc: "lazy", onCapacityExceeded: "throw" }); },
    };
    return h;
}
const PUSH = { name: "probe push", mode: "push", width: 4, totalLayers: 3, staticFraction: 1, nSources: 2, readFraction: 1, iterations: 10, warmupIterations: 5 };
test("A4 push: 4 effect() calls per graph (not 8), stable over 5 measure + reset cycles, equal sinkReads", () => {
    const h = pushHarness();
    const per = [], sinks = [], sums = [];
    for (let c = 0; c < 5; c++) {
        const before = h.effectCalls;
        const counter = new DG.Counter();
        const graph = DG.makeGraph(h.fw, PUSH, counter);
        DG.runGraph(graph, { ...PUSH, iterations: 5, startTick: 0 }, h.fw);                    // warm-up
        counter.reset();
        const sum = DG.runGraph(graph, { ...PUSH, startTick: 5 * 1 }, h.fw);                   // timed
        per.push(h.effectCalls - before); sinks.push(counter.snapshot().sinkReads); sums.push(sum);
        h.fw.reset();
    }
    assert.deepEqual(per, [4, 4, 4, 4, 4]);
    assert.deepEqual(sinks, [30, 30, 30, 30, 30]);
    assert.deepEqual(sums, [224, 224, 224, 224, 224]);
});
test("A4 push: reusing a graph with another leaf count throws; same count reuses", () => {
    const h = pushHarness();
    const counter = new DG.Counter();
    const graph = DG.makeGraph(h.fw, PUSH, counter);
    DG.runGraph(graph, { ...PUSH, iterations: 2, startTick: 0 }, h.fw);
    assert.equal(h.effectCalls, 4);
    DG.runGraph(graph, { ...PUSH, iterations: 2, startTick: 2 }, h.fw);
    assert.equal(h.effectCalls, 4, "same leaf count: effects reused");
    // readFraction 0.5 of 4 leaves -> 2 read leaves
    assert.throws(() => DG.runGraph(graph, { ...PUSH, readFraction: 0.5, iterations: 2, startTick: 4 }, h.fw),
        /push graph reused with 2 read leaves; its effects cover 4/);
});

// ----------------------------------------------------------------------- mirror.mjs child CLI
const MIRROR = join(BENCH, "mirror.mjs");
// the --import hook prints a Node deprecation warning on stderr; it is not the harness's output
const errOf = (r) => r.stderr.split("\n").filter((l) => l && !l.includes("DEP0205") && !l.includes("--trace-deprecation")).join("\n") + "\n";
const mirror = (env, hook = false) => run(["--expose-gc", ...(hook ? ["--import", NOENG] : []), MIRROR], env);
test("mirror.mjs: QUICK=1 FW=lite-signal SCENARIO=deep exits 0; the row carries sum= right after sinkReads=", () => {
    const r = mirror({ QUICK: "1", FW: "lite-signal", SCENARIO: "deep" }, true);
    assert.equal(r.status, 0, r.stderr);
    const rows = r.stdout.split("\n").filter((l) => l.startsWith("lite-signal "));
    assert.equal(rows.length, 1);
    assert.match(rows[0], /^lite-signal +, 5x500 - 3 sources \(deep\) +, [0-9]+\.[0-9]{2} +, nodesRecomputed=[0-9]+ nodesVisited=[0-9]+ edgesTraversed=[0-9]+ sinkReads=[0-9]+ sum=-?[0-9]+(?:\.[0-9]+)?(?:e[-+][0-9]+)? poolGrowths=[0-9]+$/);
    const stamp = JSON.parse(r.stdout.split("\n").find((l) => l.startsWith("#STAMP ")).slice(7));
    assert.equal(stamp.protocol, "isolated-per-row");
    assert.equal(stamp.extra.quick, true);
    assert.equal(stamp.extra.captureId, null);
    assert.deepEqual(stamp.extra.refLibs, {});
    assert.equal(typeof stamp.extra.load1, "number");
    // CAPTURE_ID is stamped verbatim
    const r2 = mirror({ QUICK: "1", FW: "lite-signal", SCENARIO: "deep", CAPTURE_ID: "20261123T120000Z-0a1b2c3d", ROWS_ONLY: "1" }, true);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r2.stdout.split("\n")[0].slice(7)).extra.captureId, "20261123T120000Z-0a1b2c3d");
});
test("mirror.mjs: unknown / unloadable FW names exit 2 with empty stdout", () => {
    const known = "(known: lite-signal, alien-signals, reflex-quant)";
    for (const [fw, name] of [["bogus", "bogus"], ["bogus,lite-signal", "bogus"], ["lite-signal,", ""]]) {
        const r = mirror({ QUICK: "1", FW: fw }, true);
        assert.equal(r.status, 2, fw);
        assert.equal(r.stdout, "", fw);
        assert.equal(errOf(r), `mirror: unknown FW engine "${name}" ${known}\n`);
    }
    // reference engines made unresolvable by the hook: named in FW -> refuse, nothing printed
    for (const e of ["alien-signals", "reflex-quant"]) {
        const r = mirror({ QUICK: "1", FW: e, SCENARIO: "deep" }, true);
        assert.equal(r.status, 2, e);
        assert.equal(r.stdout, "", e);
        assert.ok(r.stderr.startsWith(`mirror: FW names ${e} but it cannot be imported: `), r.stderr.slice(0, 200));
        assert.ok(r.stderr.includes("ERR_MODULE_NOT_FOUND") || r.stderr.includes("g2 no-engines hook"));
    }
    // a mixed list refuses on the unloadable member, not just the first
    const r = mirror({ QUICK: "1", FW: "lite-signal,alien-signals", SCENARIO: "deep" }, true);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.ok(r.stderr.startsWith("mirror: FW names alien-signals but it cannot be imported: "));
});
