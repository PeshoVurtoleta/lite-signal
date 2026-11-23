// G1 microscope guards -- benchmark.mjs child runs (A2) + hot-body pin (A5). From PLAN-G1 ASSERTIONS.
// The four comparison engines are replaced by a throwing stub via a resolve hook
// (fixtures/g1-stub), so no bench/node_modules is needed and a lite-only run never calls them.
// Plants run on a tmp copy of bench/ (+ Signal.js), each a count-checked single-match edit.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const REGISTER = join(here, "fixtures", "g1-stub", "register.mjs");
const SRC = readFileSync(join(ROOT, "bench", "benchmark.mjs"), "utf8");
const tmps = [];
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function treeCopy(benchSrcText, guardsEdit) {
    const d = mkdtempSync(join(tmpdir(), "g1-child-"));
    tmps.push(d);
    mkdirSync(join(d, "bench"));
    for (const f of ["Signal.js", "Watch.js"]) cpSync(join(ROOT, f), join(d, f));
    cpSync(join(ROOT, "package.json"), join(d, "package.json"));
    for (const f of ["frameworks.mjs", "package.json"]) cpSync(join(ROOT, "bench", f), join(d, "bench", f));
    cpSync(join(ROOT, "bench", "lib"), join(d, "bench", "lib"), { recursive: true });
    writeFileSync(join(d, "bench", "benchmark.mjs"), benchSrcText);
    if (guardsEdit) { const g = join(d, "bench", "lib", "guards.mjs"); writeFileSync(g, plant(readFileSync(g, "utf8"), 0, 0, guardsEdit[0], guardsEdit[1])); }
    return join(d, "bench", "benchmark.mjs");
}
// exactly one match inside [from, to) or the test fails loudly
function plant(text, from, to, oldStr, newStr, region) {
    const a = region ? text.indexOf(region[0]) : 0;
    assert.ok(a >= 0, "region start not found: " + (region && region[0]));
    let b = region ? text.indexOf(region[1], a + 1) : text.length;
    if (b < 0) b = text.length;
    const slice = text.slice(a, b);
    const n = slice.split(oldStr).length - 1;
    assert.equal(n, 1, "plant needs exactly 1 match, got " + n + " for: " + oldStr);
    return text.slice(0, a) + slice.replace(oldStr, () => newStr) + text.slice(b);
}
function run(benchPath, env) {
    const e = { ...process.env }; delete e.FW; delete e.ITERATIONS;
    Object.assign(e, env);
    const r = spawnSync(process.execPath, ["--expose-gc", "--import", REGISTER, benchPath],
        { encoding: "utf8", timeout: 120000, killSignal: "SIGKILL", env: e, maxBuffer: 1 << 26 });
    assert.equal(r.signal, null, "child killed by " + r.signal + " (timeout?)");
    const out = r.stdout || "";
    const lines = out.split("\n");
    const rows = lines.filter((l) => l.includes(" median=") && /sink=\[(x| )\]\s*$/.test(l));
    const stampLines = lines.filter((l) => l.startsWith("#STAMP "));
    return {
        status: r.status, stderr: r.stderr || "", out,
        ok: rows.filter((l) => /sink=\[x\]\s*$/.test(l)).length,
        dead: rows.filter((l) => /sink=\[ \]\s*$/.test(l)).length,
        stampCount: stampLines.length,
        stamp: stampLines.length ? JSON.parse(stampLines[0].slice(7)) : null,
    };
}

// config order = scenario order kairos, broadcast, deepChain, mux, dynamicDag, selectiveDag.
// Derived by hand from the adapter formulas: N+64=1064, N+16=1016, 256+16=272 (x2),
// W=ceil(sqrt(960))=31, L=ceil(960/31)=31, W*L=961 -> maxNodes 961+32=993 (x2),
// maxLinks dynamic 961*FAN6*2=11532, selective 961*POOL4*2=7688.
const SC = ["kairos", "broadcast", "deepChain", "mux", "dynamicDag", "selectiveDag"];
const EXPECT_CFG = [
    { maxNodes: 1064 }, { maxNodes: 1016 }, { maxNodes: 272 }, { maxNodes: 272 },
    { maxNodes: 993, maxLinks: 11532 }, { maxNodes: 993, maxLinks: 7688 },
].map((o) => ({ ...o, prealloc: "eager", onCapacityExceeded: "grow" }));
function configList(cfg) {
    if (Array.isArray(cfg)) return cfg;
    assert.ok(cfg && typeof cfg === "object", "stamp.config not an object: " + JSON.stringify(cfg));
    const ks = Object.keys(cfg);
    if (SC.every((k) => k in cfg)) return SC.map((k) => cfg[k]);   // keyed by scenario
    return ks.map((k) => cfg[k]);                                  // numeric-keyed (spread array)
}

for (const it of [257, 258]) {
    test("A2 FW=lite-signal ITERATIONS=" + it + ": exit 0, 6 [x], per-engine protocol, iterations, config", () => {
        const r = run(join(ROOT, "bench", "benchmark.mjs"), { FW: "lite-signal", ITERATIONS: String(it) });
        assert.equal(r.status, 0, r.stderr.slice(0, 500) + r.out.slice(-500));
        assert.equal(r.ok, 6); assert.equal(r.dead, 0);
        assert.equal(r.stampCount, 1);
        assert.equal(r.stamp.protocol, "isolated-per-engine");
        assert.equal(r.stamp.extra.iterations, it);
        assert.deepEqual(configList(r.stamp.config), EXPECT_CFG);
    });
}

const LITE = ['"lite-signal": {', '\n    "alien-signals": {'];
test("A2 plant: timed drive no-op -> exit 1, 6 [ ], 0 [x]", () => {
    const p = treeCopy(plant(SRC, 0, 0, "const {drive, teardown} = adapter(N, sinkSlot);",
        "const {drive: drive0, teardown} = adapter(N, sinkSlot); const drive = () => {}; void drive0;"));
    const r = run(p, { FW: "lite-signal", ITERATIONS: "257" });
    assert.equal(r.status, 1, r.stderr.slice(0, 300));
    assert.equal(r.dead, 6); assert.equal(r.ok, 0);
});
test("A2 plant: lite deepChain tip()+1 -> exit 1, exactly 1 [ ] (5 [x])", () => {
    const p = treeCopy(plant(SRC, 0, 0, "SINK[sinkSlot] = tip();", "SINK[sinkSlot] = tip() + 1;", LITE));
    const r = run(p, { FW: "lite-signal", ITERATIONS: "257" });
    assert.equal(r.status, 1, r.stderr.slice(0, 300));
    assert.equal(r.dead, 1); assert.equal(r.ok, 5);
});
test("A2 plant: lite kairos NaN -> exit 1, exactly 1 [ ]", () => {
    const p = treeCopy(plant(SRC, 0, 0, "cs[i] = r.computed(() => src() * (i + 1));", "cs[i] = r.computed(() => src() * (i + 1) * NaN);", LITE));
    const r = run(p, { FW: "lite-signal", ITERATIONS: "257" });
    assert.equal(r.status, 1, r.stderr.slice(0, 300));
    assert.equal(r.dead, 1); assert.equal(r.ok, 5);
});

const T0LOOP = "const t0 = performance.now();\n            for (let i = 0; i < ITERATIONS; i++) drive(i);";
test("A2 plant NORESET: timed-loop-only no-op (warm-up untouched) -> exit 1, 6 [ ]", () => {
    const p = treeCopy(plant(SRC, 0, 0, T0LOOP, "const t0 = performance.now();\n            for (let i = 0; i < ITERATIONS; i++) void i;"));
    const r = run(p, { FW: "lite-signal", ITERATIONS: "257" });
    assert.equal(r.status, 1, r.stderr.slice(0, 300)); assert.equal(r.dead, 6); assert.equal(r.ok, 0);
});
test("A2 plant LASTONLY: timed loop skips drive on run index 2 -> exit 1, 6 [ ]", () => {
    const p = treeCopy(plant(SRC, 0, 0, T0LOOP, "const t0 = performance.now();\n            for (let i = 0; i < ITERATIONS; i++) if (r !== 2) drive(i);"));
    const r = run(p, { FW: "lite-signal", ITERATIONS: "257" });
    assert.equal(r.status, 1, r.stderr.slice(0, 300)); assert.equal(r.dead, 6); assert.equal(r.ok, 0);
});
test("A2 CFGALWAYS: FW=alien-signals -> stamp config === null (stamp precedes the stub throw)", () => {
    const r = run(join(ROOT, "bench", "benchmark.mjs"), { FW: "alien-signals", ITERATIONS: "257" });
    assert.equal(r.stampCount, 1); assert.equal(r.stamp.config, null);
});
test("A2 NOMUX: ITERATIONS_MIN lowered to 256 in a tmp guards.mjs -> exit 2, 0 #STAMP, 'mux N=256'", () => {
    const p = treeCopy(SRC, ["ITERATIONS_MIN = 257", "ITERATIONS_MIN = 256"]);
    const r = run(p, { FW: "lite-signal", ITERATIONS: "300" });
    assert.equal(r.status, 2, r.stderr.slice(0, 300)); assert.equal(r.stampCount, 0);
    assert.match(r.stderr + r.out, /mux N=256/);
});
test("A2 NODRIFT: kairos LITE_CONFIGS maxNodes 1000+64 -> 1000+65 -> exit 2, 0 #STAMP, 'LITE_CONFIGS.kairos'", () => {
    const p = treeCopy(plant(SRC, 0, 0, "maxNodes: 1000 + 64,", "maxNodes: 1000 + 65,"));
    const r = run(p, { FW: "lite-signal", ITERATIONS: "257" });
    assert.equal(r.status, 2, r.stderr.slice(0, 300)); assert.equal(r.stampCount, 0);
    assert.match(r.stderr + r.out, /LITE_CONFIGS\.kairos/);
});

// FW unset / 2 keys: the stamp is printed before the first run; the alien stub then throws, so only the stamp is asserted.
test("A2 FW unset -> stamp protocol shared-process-smoke", () => {
    const r = run(join(ROOT, "bench", "benchmark.mjs"), { ITERATIONS: "257" });
    assert.equal(r.stampCount, 1); assert.equal(r.stamp.protocol, "shared-process-smoke");
});
test("A2 FW=lite-signal,alien-signals -> stamp protocol shared-process-smoke", () => {
    const r = run(join(ROOT, "bench", "benchmark.mjs"), { FW: "lite-signal,alien-signals", ITERATIONS: "257" });
    assert.equal(r.stampCount, 1); assert.equal(r.stamp.protocol, "shared-process-smoke");
});

// widened rule: a tooth per bad value, each exit 2 and no #STAMP line
for (const fw of ["bogus", "", "lite-signal,lite-signal", "lite-signal,bogus", "lite-signal,"]) {
    test("A2 refusal FW=" + JSON.stringify(fw) + " -> exit 2, no #STAMP", () => {
        const r = run(join(ROOT, "bench", "benchmark.mjs"), { FW: fw, ITERATIONS: "257" });
        assert.equal(r.status, 2, r.stderr.slice(0, 300));
        assert.equal(r.stampCount, 0); assert.equal(r.ok + r.dead, 0);
    });
}
for (const it of ["0257", "256", "255", "0", "1", "-5", "1.5", "abc", "1073741824", "-0", "", " 65", "65 ", "065", "1e3"]) {
    test("A2 refusal ITERATIONS=" + JSON.stringify(it) + " -> exit 2, no #STAMP", () => {
        const r = run(join(ROOT, "bench", "benchmark.mjs"), { FW: "lite-signal", ITERATIONS: it });
        assert.equal(r.status, 2, r.stderr.slice(0, 300));
        assert.equal(r.stampCount, 0); assert.equal(r.ok + r.dead, 0);
    });
}

// ---- A5 hot-body pin: recompute the 32 hashes with the golden's normative rule ----
const GOLD = JSON.parse(readFileSync(join(here, "133-microscope-hotbody.golden.json"), "utf8"));
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
function braceMatch(t, openIdx) {            // counts '{' and '}' only, no string awareness (golden rule)
    let depth = 0;
    for (let i = openIdx; i < t.length; i++) {
        if (t[i] === "{") depth++;
        else if (t[i] === "}") { depth--; if (depth === 0) return i; }
    }
    throw new Error("unbalanced braces");
}
function unique(t, needle, from) {
    const a = t.indexOf(needle, from || 0);
    assert.ok(a >= 0, "not found: " + JSON.stringify(needle));
    assert.equal(t.indexOf(needle, a + 1), -1, "not unique: " + JSON.stringify(needle));
    return a;
}
function normalizeCfg(s) {                   // replace the paren-matched argument of every createRegistry(
    let out = "", i = 0;
    for (;;) {
        const k = s.indexOf("createRegistry(", i);
        if (k < 0) { out += s.slice(i); return out; }
        const open = k + "createRegistry".length;
        let d = 0, j = open;
        for (; j < s.length; j++) { if (s[j] === "(") d++; else if (s[j] === ")") { d--; if (d === 0) break; } }
        out += s.slice(i, open + 1) + "<CFG>"; i = j;
    }
}
function hashes(t) {
    const h = {};
    const ad = unique(t, "\nconst ADAPTERS = {");
    const adOpen = t.indexOf("{", ad);
    const adBlock = t.slice(adOpen, braceMatch(t, adOpen) + 1);
    for (const E of GOLD.engines) {
        const eIdx = unique(adBlock, '\n    "' + E + '": {');
        const eOpen = adBlock.indexOf("{", eIdx);
        const eBlock = adBlock.slice(eOpen, braceMatch(adBlock, eOpen) + 1);
        for (const S of GOLD.scenarios) {
            const m = unique(eBlock, "\n        " + S + "(N, sinkSlot) {");
            const start = m + 1 + "        ".length;
            const open = eBlock.indexOf("{", start + S.length);
            const text = eBlock.slice(start, braceMatch(eBlock, open) + 1);
            h[E + "/" + S] = sha(normalizeCfg(text));
        }
    }
    const ro = unique(t, "\nfunction runOne(");
    const roOpen = t.indexOf("{", ro);
    const body = t.slice(roOpen, braceMatch(t, roOpen) + 1);
    const dl = body.split("\n").filter((l) => l.includes("drive(i)")).map((l) => l.trim());
    assert.equal(dl.length, 2, "runOne must contain exactly 2 'drive(i)' lines");
    h["runOne/warmupLoop"] = sha(dl[0]); h["runOne/timedLoop"] = sha(dl[1]);
    return h;
}
const LIVE = hashes(SRC);

test("A5 hot-body golden: 32 keys, scheme read from the golden JSON", () => {
    assert.equal(GOLD.keys.length, 32); assert.deepEqual(Object.keys(GOLD.hashes).sort(), [...GOLD.keys].sort());
    assert.equal(GOLD.engines.length * GOLD.scenarios.length, 30);
});
test("A5 timed loop text is the plain loop", () => {
    const body = SRC.slice(SRC.indexOf("\nfunction runOne("));
    assert.ok(body.split("\n").some((l) => l.trim() === GOLD.timedLoopText));
});
for (const key of GOLD.keys) {
    test("A5 hot-body hash " + key, () => { assert.equal(LIVE[key], GOLD.hashes[key]); });
}
test("A5 teeth: one char changed in alien mux -> that hash (only) differs from the golden", () => {
    const aIdx = SRC.indexOf('\n    "alien-signals": {');
    const mIdx = SRC.indexOf("\n        mux(N, sinkSlot) {", aIdx);
    assert.ok(aIdx > 0 && mIdx > aIdx);
    const at = SRC.indexOf("s += ", mIdx);
    assert.ok(at > mIdx && at - mIdx < 400, "expected 's += ' inside alien mux");
    const mutated = SRC.slice(0, at) + "s -= " + SRC.slice(at + 5);
    const h = hashes(mutated);
    const diff = GOLD.keys.filter((k) => h[k] !== GOLD.hashes[k]);
    assert.deepEqual(diff, ["alien-signals/mux"]);
});
test("A5 teeth: a drive loop edit in runOne -> runOne/timedLoop differs", () => {
    const i = SRC.indexOf("\nfunction runOne(");
    const first = SRC.indexOf("drive(i)", i);
    const at = SRC.indexOf("drive(i)", first + 1);   // second = timed loop
    // keep both lines matching 'drive(i)' so only the hash can notice: append a comment-free no-op
    const mutated = SRC.slice(0, at) + "drive(i) | 0" + SRC.slice(at + 8);
    assert.notEqual(hashes(mutated)["runOne/timedLoop"], GOLD.hashes["runOne/timedLoop"]);
});
