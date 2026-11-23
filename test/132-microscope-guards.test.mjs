// G1 microscope guards -- pure rows (A1 + A5 parts, resolveRun). Written from PLAN-G1 ASSERTIONS;
// no comparison engine is imported. Expected values: either quoted from the plan or derived
// below by hand / by an independent reference (comments say how).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BENCH = join(here, "..", "bench");
const G = await import(join(BENCH, "lib", "guards.mjs"));
const STAMP = await import(join(BENCH, "lib", "stamp.mjs"));
const FW = await import(join(BENCH, "frameworks.mjs"));
const oracle = await import(join(BENCH, "lib", "sink-oracle.mjs")).catch((e) => ({ __missing: e }));
const KEYS = FW.ENGINE_KEYS;
const ONE = (key, N, it) => { assert.ok(oracle.expectedSink, "bench/lib/sink-oracle.mjs expectedSink missing"); return oracle.expectedSink(key, N, it); };
const byOffset = (pairs) => Object.fromEntries(pairs.map(([o, v]) => [o, v]));

// ---- independent references (from the adapter semantics in the plan, not from sink-oracle) ----
// Final state after the timed loop = state after drive(iterations - 1).
function refSimple(key, N, it) {
    const last = it - 1;
    if (key === "kairos") return [[0, last * (N * (N + 1) / 2)]];                  // sum_i last*(i+1)
    if (key === "deepChain") return [[0, last + N]];
    if (key === "mux") {                                                           // slot j holds last i < it with i % N == j
        let s = 0; for (let j = 0; j < N; j++) { let i = j + Math.floor((it - 1 - j) / N) * N; if (j > it - 1) i = 0; s += i; }
        return [[0, s]];
    }
    if (key === "broadcast") {                                                     // offset o = last k (k < N, k & 31 == o): last + k
        const out = [];
        for (let o = 0; o < 32; o++) { let k = -1; for (let q = 0; q < N; q++) if ((q & 31) === o) k = q; out.push([o, last + k]); }
        return out;
    }
    throw new Error("no ref for " + key);
}
function refDag(key, N, it) {
    const srcV = it - 1;
    const W = Math.max(4, Math.ceil(Math.sqrt(N))), L = Math.max(2, Math.ceil(N / W));
    let prev = [srcV];
    const PAIRS = [[0, 1], [0, 2], [1, 3], [2, 3]];
    for (let layer = 0; layer < L; layer++) {
        const next = [];
        for (let w = 0; w < W; w++) {
            if (key === "dynamicDag") {
                const deps = []; for (let k = 0; k < 6; k++) deps.push(prev[(w * 7 + k * 11) % prev.length]);
                let s = 0;
                if (srcV & 1) { for (let k = 0; k < 6; k++) s += deps[k]; } else { for (let k = 5; k >= 0; k--) s += deps[k]; }
                next.push(s);
            } else {
                const cand = []; for (let k = 0; k < 4; k++) cand.push(prev[(w * 7 + k * 13) % prev.length]);
                const which = srcV & 3; next.push(cand[PAIRS[which][0]] + cand[PAIRS[which][1]]);
            }
        }
        prev = next;
    }
    let s = 0; for (let i = 0; i < prev.length; i++) s += prev[i];
    return [[0, s]];
}

test("A1 expectedSink at 20000: plan-quoted values", () => {
    assert.deepEqual(ONE("kairos", 1000, 20000), [[0, 10009499500]]);
    assert.deepEqual(ONE("deepChain", 256, 20000), [[0, 20255]]);
    assert.deepEqual(ONE("mux", 256, 20000), [[0, 5087104]]);
    const b = ONE("broadcast", 1000, 20000);
    assert.equal(b.length, 32);
    const m = byOffset(b);
    assert.equal(Object.keys(m).length, 32);
    assert.equal(m[0], 20991); assert.equal(m[7], 20998); assert.equal(m[8], 20967); assert.equal(m[31], 20990);
});

for (const it of [65, 66, 257, 258, 20000]) {
    test("A1 expectedSink vs independent reference, iterations=" + it, () => {
        assert.deepEqual(ONE("kairos", 1000, it), refSimple("kairos", 1000, it));
        assert.deepEqual(ONE("deepChain", 256, it), refSimple("deepChain", 256, it));
        assert.deepEqual(ONE("mux", 256, it), refSimple("mux", 256, it));
        assert.deepEqual(ONE("broadcast", 1000, it), refSimple("broadcast", 1000, it));
        assert.deepEqual(ONE("dynamicDag", 960, it), refDag("dynamicDag", 960, it));
        assert.deepEqual(ONE("selectiveDag", 960, it), refDag("selectiveDag", 960, it));
    });
}

test("A1 expectedSink: every pair is finite and non-zero (a zero oracle value would pass a dead sink)", () => {
    for (const [k, N] of [["kairos", 1000], ["broadcast", 1000], ["deepChain", 256], ["mux", 256], ["dynamicDag", 960], ["selectiveDag", 960]]) {
        for (const it of [65, 66, 257, 258, 20000]) {
            for (const [o, v] of ONE(k, N, it)) {
                assert.ok(Number.isInteger(o) && o >= 0, k + " offset");
                assert.ok(Number.isFinite(v) && v !== 0, k + "/" + it + " value " + v);
            }
        }
    }
});

function failuresAfter(fn) { const v = G.makeVerdict(); fn(v); return { v, n: v.failures.length }; }

test("A1 checkSinkExact: (NaN,NaN) adds exactly 1 failure", () => {
    const { v, n } = failuresAfter((v) => G.checkSinkExact(v, "t / NaN", NaN, NaN));
    assert.equal(n, 1); assert.equal(v.ok, false);
});
test("A1 checkSinkExact: (0,0) adds exactly 1 failure", () => {
    const { v, n } = failuresAfter((v) => G.checkSinkExact(v, "t / zero", 0, 0));
    assert.equal(n, 1); assert.equal(v.ok, false);
});
test("A1 checkSinkExact: (x+1,x) adds exactly 1 failure", () => {
    const { n } = failuresAfter((v) => G.checkSinkExact(v, "t / off", 10009499501, 10009499500));
    assert.equal(n, 1);
});
test("A1 checkSinkExact: (Infinity,Infinity), (-0,-0) and (x,x+1) each fail once; label named", () => {
    assert.equal(failuresAfter((v) => G.checkSinkExact(v, "t", Infinity, Infinity)).n, 1);
    assert.equal(failuresAfter((v) => G.checkSinkExact(v, "t", -0, -0)).n, 1);
    const { v, n } = failuresAfter((v) => G.checkSinkExact(v, "lite-signal / kairos", 5, 6));
    assert.equal(n, 1); assert.ok(v.failures[0].includes("lite-signal / kairos"));
});
test("A1 checkSinkExact: exact equal finite non-zero values pass with 0 failures", () => {
    for (const x of [1, -1, 20255, 5087104, 10009499500, 0.5, 1e300]) {
        const { v, n } = failuresAfter((v) => G.checkSinkExact(v, "ok", x, x));
        assert.equal(n, 0, "x=" + x); assert.equal(v.ok, true);
    }
});
test("A1 checkDeadSink: NaN fails (passes on 2da99d5); 0, Infinity fail; finite non-zero passes", () => {
    assert.equal(failuresAfter((v) => G.checkDeadSink(v, "t", NaN)).n, 1);
    assert.equal(failuresAfter((v) => G.checkDeadSink(v, "t", 0)).n, 1);
    assert.equal(failuresAfter((v) => G.checkDeadSink(v, "t", Infinity)).n, 1);
    assert.equal(failuresAfter((v) => G.checkDeadSink(v, "t", -Infinity)).n, 1);
    assert.equal(failuresAfter((v) => G.checkDeadSink(v, "t", 1)).n, 0);
    assert.equal(failuresAfter((v) => G.checkDeadSink(v, "t", -3.5)).n, 0);
});

// ---- resolveRun (PLAN task 1) ----
const R = (env) => { assert.equal(typeof G.resolveRun, "function", "resolveRun missing"); return G.resolveRun(env, KEYS); };
const P = STAMP.PROTOCOLS;
test("resolveRun: FW unset -> all libs, shared-process-smoke, iterations 20000", () => {
    const r = R({});
    assert.equal(r.ok, true); assert.deepEqual(r.libs, KEYS);
    assert.equal(r.protocol, "shared-process-smoke"); assert.equal(r.protocol, P.SMOKE);
    assert.equal(r.iterations, 20000);
});
test("resolveRun: one key -> isolated-per-engine, per key", () => {
    for (const k of KEYS) {
        const r = R({ FW: k });
        assert.equal(r.ok, true, k); assert.deepEqual(r.libs, [k]); assert.equal(r.protocol, "isolated-per-engine");
    }
});
test("resolveRun: two or more keys -> shared-process-smoke", () => {
    const r = R({ FW: "lite-signal,alien-signals" });
    assert.equal(r.ok, true); assert.deepEqual(r.libs, ["lite-signal", "alien-signals"]); assert.equal(r.protocol, "shared-process-smoke");
    assert.equal(R({ FW: KEYS.join(",") }).protocol, "shared-process-smoke");
});
// widened rule: one tooth per bad FW value
for (const bad of ["bogus", "", "lite-signal,lite-signal", "lite-signal,bogus", "lite-signal,", ",lite-signal", "LITE-SIGNAL", "lite-signal,,alien-signals"]) {
    test("resolveRun: FW=" + JSON.stringify(bad) + " refused", () => {
        const r = R({ FW: bad });
        assert.equal(r.ok, false); assert.equal(typeof r.reason, "string"); assert.ok(r.reason.length > 0);
    });
}
test("resolveRun: ITERATIONS accepted values 257, 258, 20000, 2^30-1", () => {
    for (const s of ["257", "258", "20000", "1073741823"]) {
        const r = R({ FW: "lite-signal", ITERATIONS: s });
        assert.equal(r.ok, true, s); assert.equal(r.iterations, Number(s));
    }
});
for (const bad of ["0257", "256", "255", "2", "65", "0", "1", "-5", "1.5", "abc", "1073741824", "-0", "", " 65", "65 ", "065", "+65", "1e3", "0x41"]) {
    test("resolveRun: ITERATIONS=" + JSON.stringify(bad) + " refused", () => {
        const r = R({ FW: "lite-signal", ITERATIONS: bad });
        assert.equal(r.ok, false); assert.equal(typeof r.reason, "string");
    });
}
test("resolveRun: ITERATIONS unset -> 20000", () => { assert.equal(R({ FW: "lite-signal" }).iterations, 20000); });

// ---- A5 (GC): 1e6 passing checkSinkExact calls allocate nothing; control must show GC ----
import { spawnSync } from "node:child_process";
const GCCHILD = join(here, "fixtures", "g1-stub", "gc-child.mjs");
function gcRun(mode, kind, flags) {
    const extra = flags || [];
    const r = spawnSync(process.execPath, ["--expose-gc", "--allow-natives-syntax", ...extra, GCCHILD, join(BENCH, "lib", "guards.mjs"), mode, kind || "exact"],
        { encoding: "utf8", timeout: 120000, killSignal: "SIGKILL" });
    assert.equal(r.signal, null, "child killed: " + r.signal);
    assert.equal(r.status, 0, "child stderr: " + r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
}
// fail closed: the loop must be TurboFan-optimized (calibrated mask, V8 bit layout differs per Node) before gcEntries counts
const isOpt = (o) => o.mask !== 0 && (o.status & o.mask) === o.mask;
function assertOptimized(o) { assert.ok(isOpt(o), "runLoop not TurboFan-optimized: status=" + o.status + " mask=" + o.mask); }
test("A5 GC: 1e6 passing checkSinkExact calls -> 0 gc entries", () => {
    const o = gcRun("pass");
    assertOptimized(o); assert.equal(o.failures, 0); assert.equal(o.gcEntries, 0);
});
test("A5 GC control: a fresh string per call -> >= 1 gc entry (the observer can see GC)", () => {
    const o = gcRun("control");
    assertOptimized(o);
    assert.ok(o.gcEntries >= 1, "gcEntries=" + o.gcEntries);
});

// ---- D-b250-1 / D-b250-2 rows (from RULINGS-b250.txt) ----
test("D-b250-1 ITERATIONS_MIN === 257 (mux N 256 + 1)", () => { assert.equal(G.ITERATIONS_MIN, 257); });
test("D-b250-1 resolveRun: reason names the range for 256", () => {
    const r = R({ FW: "lite-signal", ITERATIONS: "256" });
    assert.equal(r.ok, false); assert.ok(r.reason.includes("ITERATIONS=256 is outside [257, 1073741823]"), r.reason);
});
test("D-b250-1 resolveRun: 1073741824 refused, 1073741823 accepted, 257 accepted", () => {
    assert.equal(R({ FW: "lite-signal", ITERATIONS: "1073741824" }).ok, false);
    assert.equal(R({ FW: "lite-signal", ITERATIONS: "1073741823" }).ok, true);
    assert.equal(R({ FW: "lite-signal", ITERATIONS: "257" }).ok, true);
});
test("finalSource(iterations) = iterations - 1; RangeError below 2 / non-integer", () => {
    assert.ok(oracle.finalSource, "finalSource missing");
    assert.equal(oracle.finalSource(257), 256); assert.equal(oracle.finalSource(20000), 19999); assert.equal(oracle.finalSource(2), 1);
    for (const bad of [1, 0, -1, 1.5, NaN, Infinity]) assert.throws(() => oracle.finalSource(bad), RangeError, String(bad));
});

// checkSinkResidue(v,label,got,src,slot,n): pass iff d = got-src, d >= 0 && d < n && d % 32 === slot.
// 1255 = 256 + 999 (999 % 32 = 7, k=999 < 1000); 1248 = 256 + 992 (992 % 32 = 0).
const res = (got, src, slot, n) => failuresAfter((v) => G.checkSinkResidue(v, "solid / broadcast (residue check)", got, src, slot, n));
test("D-b250-2 checkSinkResidue: passing cases add 0 failures", () => {
    assert.equal(res(1255, 256, 7, 1000).n, 0);
    assert.equal(res(1248, 256, 0, 1000).n, 0);
    assert.equal(res(256 + 7, 256, 7, 1000).n, 0);          // smallest d for slot 7
});
const RES_BAD = { "d = n": [1256, 256, 8, 1000], "wrong residue": [1254, 256, 7, 1000], "NaN": [NaN, 256, 7, 1000],
    "got 0": [0, 256, 7, 1000], "fractional": [1255.5, 256, 7, 1000], "d < 0": [255, 256, 7, 1000],
    "dead slot 0": [0, 256, 0, 1000] };   // d = -256, -256 % 32 is -0 (RNEG trap)
// (d = n case: d=1000, 1000 % 32 = 8, slot 8 so only the bound can reject it)
for (const [name, a] of Object.entries(RES_BAD)) {
    test("D-b250-2 checkSinkResidue: " + name + " -> exactly 1 failure, text prefix", () => {
        const { v, n } = res(...a);
        assert.equal(n, 1); assert.ok(v.failures[0].startsWith("SINK RESIDUE MISMATCH (residue check): "), v.failures[0]);
    });
}
test("D-b250-2 sinkCheckMode: solid/broadcast is residue; every other engine x scenario is exact", () => {
    assert.equal(typeof oracle.sinkCheckMode, "function");
    const SC = ["kairos", "broadcast", "deepChain", "mux", "dynamicDag", "selectiveDag"];
    assert.equal(oracle.sinkCheckMode("solid", "broadcast"), "residue");
    for (const e of KEYS) for (const sc of SC) {
        if (e === "solid" && sc === "broadcast") continue;
        assert.equal(oracle.sinkCheckMode(e, sc), "exact", e + "/" + sc);
    }
});
for (const e of ["lite-signal", "alien-signals", "preact", "reflex-quant"]) {
    test("D-b250-2 sinkCheckMode(" + e + ", broadcast) === exact", () => { assert.equal(oracle.sinkCheckMode(e, "broadcast"), "exact"); });
}
for (const sc of ["kairos", "deepChain", "mux", "dynamicDag", "selectiveDag"]) {
    test("D-b250-2 sinkCheckMode(solid, " + sc + ") === exact", () => { assert.equal(oracle.sinkCheckMode("solid", sc), "exact"); });
}
test("D-b250-2 RESIDUE_ROWS is frozen and is exactly [solid/broadcast]", () => {
    assert.ok(Object.isFrozen(oracle.RESIDUE_ROWS)); assert.deepEqual([...oracle.RESIDUE_ROWS], ["solid/broadcast"]);
});
test("D-b250-2 solid residue plant (pure row, the solid child cannot run under the throwing stub): wrong residue and out-of-range fail, right residue passes", () => {
    assert.equal(res(256 + 8, 256, 7, 1000).n, 1);          // residue 8 written to slot 7
    assert.equal(res(256 + 1000 + 7, 256, 7, 1000).n, 1);   // d = 1007 >= n
    assert.equal(res(256 + 999, 256, 7, 1000).n, 0);
});
test("A5 GC: 1e6 passing checkSinkResidue calls -> 0 gc entries; control >= 1", () => {
    const p = gcRun("pass", "residue"); assertOptimized(p); assert.equal(p.failures, 0); assert.equal(p.gcEntries, 0);
    const c = gcRun("control", "residue"); assertOptimized(c); assert.ok(c.gcEntries >= 1, "gcEntries=" + c.gcEntries);
});
test("A5 GC must-fail: --no-opt --no-maglev pass mode reads gcEntries >= 1 AND the optimized-status assertion fails (the residue half proves the observer sees harness boxing, not that checkSinkResidue boxes)", () => {
    for (const kind of ["exact", "residue"]) {
        const o = gcRun("pass", kind, ["--no-opt", "--no-maglev"]);
        assert.ok(o.gcEntries >= 1, kind + " gcEntries=" + o.gcEntries);
        assert.equal(isOpt(o), false, kind + " status assertion has no teeth");
    }
});
test("A5 GC status clause false arm: --turbo-filter=cal optimizes only the calibration fn -> mask !== 0, runLoop not optimized, gcEntries >= 1", () => {
    const t = gcRun("pass", "exact", ["--turbo-filter=cal"]);
    assert.notEqual(t.mask, 0); assert.equal(isOpt(t), false); assert.ok(t.gcEntries >= 1, "gcEntries=" + t.gcEntries);
});
