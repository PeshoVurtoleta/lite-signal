// visit-anatomy harness: the instrument() boundary (harness/visit-anchors.mjs) and the
// CLI contract (harness/visit-anatomy.mjs). Burst 33 B-B2c. Must-fail control: run this
// file against the 9228154 (pre-B1) HARNESS with the burst-33 golden in place:
//   - the refusal message for a // comment ended by U+2028 / U+2029 is ONE escaped line
//     (red on 9228154, where JSON.stringify left the terminator raw in the message);
//   - the --verify golden compare is red because the 37-pin tool prints a different report;
// On that control the two rows above go red; the gutted-engine --verify row and the
// TMPDIR row stay green -- 9228154 already had the comparator, the fail exit and
// tmpdir(). Their teeth are proven by mutants instead (comparator gutted, fail exit 0,
// TMPDIR ignored), not by the old harness.
// Known gap: the --verify golden compare cannot catch a tool that echoes the golden only for
// the default engine; that tooth belongs to B-B4's measured --engine lane (follow-up).
// The remaining rows (frozen tables, the compile() attack on MODULE_REF, anchor matrix,
// argv hints, argv strict rejections, purity, form matrix) are regression pins for
// behaviour already shipped by HEAD 9228154 (green on the control).
// Expected values come from the written contract (the header comments of the two
// harness files and the brief), not from running the tool: drift-line text is built
// from the live EDITS anchors + the stated "found Nx, expected Mx" format; the engine
// and instrumented shas are computed here with node:crypto.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TOOL = join(REPO, "harness/visit-anatomy.mjs");
const GOLDEN_VERIFY = join(REPO, "bench/soak/calibration/golden/visit-anatomy-verify.txt");
const A = await import(new URL("../harness/visit-anchors.mjs", import.meta.url).href);
const { instrument, EDITS, NAMES, I, IDX, MODULE_REF } = A;
const LIVE = readFileSync(join(REPO, "Signal.js"), "utf8");
const MODREF_MSG = /module reference .* survives instrumentation/s;
const MODREF_SRC = MODULE_REF.source;   // captured before the compile() attack re-points the copy
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const RAW_TERM = new RegExp("[\\r\\n" + LS + PS + "]");
const esc = (s) => s.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
const label = (a) => `"${esc(a.slice(0, 48))}..."`;
const caught = (src) => { try { instrument(src); } catch (e) { return e; } return null; };

test("exports: MODULE_REF + 13 EDITS + 12 NAMES; NAMES / I / IDX agree", () => {
    assert.deepEqual(Object.keys(A).sort(), ["EDITS", "I", "IDX", "MODULE_REF", "NAMES", "instrument"]);
    assert.ok(MODULE_REF instanceof RegExp);
    assert.equal(EDITS.length, 13);
    assert.equal(NAMES.length, 12);
    for (let i = 0; i < NAMES.length; i++) { assert.equal(I[NAMES[i]], i); assert.equal(IDX[i], NAMES[i]); }
});

test("frozen tables: NAMES, I, IDX, EDITS, every entry, MODULE_REF; writes throw and do not land", () => {
    for (const [n, t] of [["NAMES", NAMES], ["I", I], ["IDX", IDX], ["EDITS", EDITS], ["MODULE_REF", MODULE_REF]]) assert.ok(Object.isFrozen(t), n);
    for (const e of EDITS) assert.ok(Object.isFrozen(e));
    const before = instrument(LIVE);
    assert.throws(() => { EDITS[1][0] = "x"; }, TypeError);
    assert.throws(() => { EDITS.push(["a", "b", 1]); }, TypeError);
    assert.throws(() => { I.depWalk = 0; }, TypeError);
    assert.throws(() => { NAMES[0] = "z"; }, TypeError);
    assert.throws(() => { MODULE_REF.lastIndex = 5; }, TypeError);
    assert.equal(instrument(LIVE), before);
});

test("compile() attack on the exported MODULE_REF: instrument() still refuses module references", () => {
    try { MODULE_REF.compile("a^"); } catch { /* frozen: either outcome is fine */ }
    assert.throws(() => instrument(LIVE + '\nexport * from "./x";\n'), MODREF_MSG);
    assert.throws(() => instrument(LIVE + '\nimport("node:fs");\n'), MODREF_MSG);
    assert.equal(typeof instrument(LIVE), "string");
});

test("non-string inputs throw TypeError (name the type; null and undefined named)", () => {
    const vals = [undefined, null, 0, -0, NaN, 1, 2 ** 31, 2 ** 53, true, {}, [], [LIVE], Symbol("x"), 1n,
        new String(LIVE), Buffer.from(LIVE), () => LIVE, { toString: () => LIVE }];
    for (const v of vals) assert.throws(() => instrument(v), TypeError, typeof v);
    assert.throws(() => instrument(null), /got null/);
    assert.throws(() => instrument(undefined), /got undefined/);
});

test("double-instrument and any __VC refused; purity (same in -> same out, input untouched)", () => {
    const once = instrument(LIVE);
    assert.throws(() => instrument(once), /already instrumented/);
    assert.throws(() => instrument(LIVE + "\n// __VC\n"), /already instrumented/);
    const copy = LIVE.slice();
    assert.equal(instrument(LIVE), once);
    assert.equal(LIVE, copy);
    caught(""); caught(LIVE + '\nimport("x")');   // failed calls leave no state behind
    assert.equal(instrument(LIVE), once);
});

test("instrument(''): 13 drift lines, each ONE line, each 'found 0x, expected Nx'", () => {
    const e = caught("");
    assert.ok(e && Array.isArray(e.drift));
    assert.deepEqual(e.drift, EDITS.map(([a, , n]) => `${label(a)} found 0x, expected ${n}x`));
    assert.deepEqual(e.drift.filter((l) => RAW_TERM.test(l)), []);
    assert.ok(e.drift.some((l) => l === '"        let link;\\n        if (freeLinkHead === n..." found 0x, expected 1x'));
});

test("anchor matrix from the live Signal.js: 0x, N-1 (N>1), N+1 -> exactly one drift line", () => {
    for (const [a, , n] of EDITS) {
        const mangled = a.replace(/\S/, (c) => (c === "Z" ? "Y" : "Z"));
        const cases = [[LIVE.split(a).join(mangled), 0], [LIVE + "\n/*" + a + "*/\n", n + 1]];
        if (n > 1) cases.push([LIVE.replace(a, mangled), n - 1]);
        for (const [src, got] of cases) {
            const e = caught(src);
            assert.ok(e && Array.isArray(e.drift), `${label(a)} ${got}x`);
            assert.deepEqual(e.drift, [`${label(a)} found ${got}x, expected ${n}x`]);
        }
    }
});

test("CRLF engine source fails closed with the escaped single-line linkAlloc drift", () => {
    const e = caught(LIVE.replace(/\n/g, "\r\n"));
    assert.deepEqual(e && e.drift, ['"        let link;\\n        if (freeLinkHead === n..." found 0x, expected 1x']);
});

const T = { LF: "\n", CR: "\r", LS, PS, CRLF: "\r\n" };
const REFUSE = {
    stExportStar: `export * from "./x.js";`, stExportStarUp: `export * from '../x.js';`, stNamed: `import {a} from "./x.js";`,
    stNoSpace: `import a from'../x.js';`, dyn: `import("./x.js");`, dynSpaced: `import( '../x.js' );`, bareImport: `import "./x.js";`,
    bareImportSq: `import '../x.js';`, importNL: `import\n"./x.js";`, exportNs: `export * as ns from "./x.js";`,
    dynNL: `const m = import(\n  "./x.js");`, commentInDyn: `import(/*c*/"./x.js");`, escapedSlash: `export * from ".\\/x.js";`,
    hexDot: `export * from "\\x2e/x.js";`, unicodeDot: `export * from "\\u002e/x.js";`, commentBeforeFrom: `export * from /*c*/ "./x.js";`,
    templateImport: "import(`./x.js`);", importMeta: 'new URL("./x.js", import.meta.url);', importMetaSp: "import /*c*/ . meta",
    bare: `import("node:fs");`, abs: `import("/abs/x.mjs");`, bareStatic: `import fs from "fs";`, star: `import * as ns from "x";`,
    reexport: `export {a} from "x";`, attrs: `import j from "./x.json" with {type: "json"};`, tab: "import\t(\"x\")",
    nbsp: "import\u00a0(\"x\")", vt: "import\v(\"x\")", ff: "import\f(\"x\")", multiBlock: `import /*a*/ /*b*/\n/*c*/("x")`,
    emptyBlock: `import/**/("x")`, fromNoSpace: `export{a}from"x";`, fromBlock: `export * from/**/"x";`,
};
for (const [tn, t] of Object.entries(T)) {
    REFUSE[`dynLine_${tn}`] = `import //c${t}("./x.mjs")`;
    REFUSE[`fromLine_${tn}`] = `export * from //c${t}"./x.mjs"`;
    REFUSE[`twoLine_${tn}`] = `import //a${t}//b${t}("./x.mjs")`;
    REFUSE[`awaitLine_${tn}`] = `await import //c${t} ("./x.mjs")`;
    REFUSE[`blockImport_${tn}`] = `import /*a${t}b*/("x")`;   // block comment spanning a terminator, import branch
    REFUSE[`blockFrom_${tn}`] = `export * from /*a${t}b*/"x"`;   // ... and the from branch
    REFUSE[`mixed_${tn}`] = `export * from /*a*/ //b${t} /*c*/ "./x.mjs"`;
}
const ACCEPT = {
    reimport: "const reimport = 1; reimport;", importer: "function importer() {} importer();", underscore: "const _import = () => 0; _import(1);",
    importX: "const importX = (x) => x; importX(1);", proseTick: "// copied from `Watch.js`", fromTick: "/* imported from `y` */",
    fromIdent: "const from = 1, frm = from;",
};

test("every module-reference form refuses (incl. // ended by LF / CR / U+2028 / U+2029 / CRLF); controls accepted", () => {
    const escaped = Object.entries(REFUSE).filter(([, f]) => { const e = caught(LIVE + "\n" + f + "\n"); return !(e && MODREF_MSG.test(e.message)); }).map(([k]) => k);
    assert.deepEqual(escaped, []);
    const falsePos = Object.entries(ACCEPT).filter(([, f]) => caught(LIVE + "\n" + f + "\n") !== null).map(([k]) => k);
    assert.deepEqual(falsePos, []);
});

test("module-reference refusal message is ONE escaped line for CR / LF / U+2028 / U+2029 terminators", () => {
    const e = caught(LIVE + '\nimport //c\r("./x.mjs")\n');
    assert.match(e.message, /module reference "import \/\/c\\r\(" survives/);
    for (const [name, t, token] of [["LS", LS, "\\u2028"], ["PS", PS, "\\u2029"], ["LF", "\n", "\\n"], ["CR", "\r", "\\r"]]) {
        const m = caught(LIVE + `\nimport //c${t}("./x.mjs")\n`).message;
        assert.equal(RAW_TERM.test(m), false, name);
        assert.ok(m.includes("import //c" + token + "("), name);
    }
});

test("census: raw live Signal.js has exactly 1 MODULE_REF hit (the Watch.js re-export), instrument(live) has 0", () => {
    const g = new RegExp(MODREF_SRC, "g");
    const raw = LIVE.match(g) || [];
    assert.equal(raw.length, 1, JSON.stringify(raw));
    assert.match(raw[0], /^from\s*"/);
    assert.equal((instrument(LIVE).match(g) || []).length, 0);
});

// ---- CLI -----------------------------------------------------------------------
const tmpRoot = mkdtempSync(join(tmpdir(), "va54-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
const run = (args, extraEnv = {}) => {
    const t = mkdtempSync(join(tmpRoot, "r-"));
    const env = { ...process.env, TMPDIR: t, TMP: t, TEMP: t, ...extraEnv };
    const r = spawnSync(process.execPath, [TOOL, ...args], { env, encoding: "utf8", timeout: 120000, cwd: REPO });
    return { ...r, tmpLeft: readdirSync(t) };
};

test("argv: unknown arguments exit 2, empty stdout, one stderr line, case-insensitive hint", () => {
    const H_V = "--verify", H_E = "--engine <path>", H_B = "--verify or --engine <path>";
    for (const [arg, hint] of [["--VERIFY", H_V], ["-v", H_V], ["--verfy", H_V], ["--Engine", H_E], ["-e", H_E], ["foo", H_B], ["--help", H_B]]) {
        const r = run([arg]);
        assert.equal(r.status, 2, arg);
        assert.equal(r.stdout, "", arg);
        assert.equal(r.stderr, `visit-anatomy: unknown argument ${JSON.stringify(arg)} (did you mean ${hint}?)\n`, arg);
        assert.deepEqual(r.tmpLeft, [], arg);
    }
});

test("argv: strict rejections (duplicate --engine / --verify, bare --engine, missing engine) exit 2 with a named reason", () => {
    const missing = join(tmpRoot, "no-such-engine.js");
    for (const [args, re] of [
        [["--engine", join(REPO, "Signal.js"), "--engine", join(REPO, "Signal.js")], /^visit-anatomy: duplicate argument "--engine"/],
        [["--engine"], /^visit-anatomy: --engine needs a Signal\.js path\n$/],
        [["--verify", "--verify"], /^visit-anatomy: duplicate argument "--verify"\n$/],
        [["--engine", missing], /^visit-anatomy: cannot read engine .*ENOENT\)\n$/],
    ]) {
        const r = run(args);
        assert.equal(r.status, 2, args.join(" "));
        assert.equal(r.stdout, "", args.join(" "));
        assert.equal(r.stderr.split("\n").length, 2, args.join(" "));   // one line + trailing newline
        assert.match(r.stderr, re, args.join(" "));
        assert.deepEqual(r.tmpLeft, [], args.join(" "));
    }
});

test("--verify: stdout + exit line equals the verify golden; engine line checked by sha; no tmp dir left", () => {
    const golden = readFileSync(GOLDEN_VERIFY, "utf8");
    const lines = golden.split("\n");
    const ei = lines.findIndex((l) => l.startsWith("engine: "));
    assert.ok(ei >= 0, "golden has an engine: line");
    const wantEngine = `engine: Signal.js sha256 ${sha(LIVE)} instrumented sha256 ${sha(instrument(LIVE))}`;
    const pins = /VERIFY PASSED: (\d+) exact structural pins hold/.exec(golden);
    assert.ok(pins, "golden has a VERIFY PASSED line");
    const gj = JSON.parse(readFileSync(join(REPO, "bench/soak/calibration/golden/visit-anatomy.golden.json"), "utf8"));
    assert.equal(Number(pins[1]), gj.pins);   // golden text and golden.json agree on the pin count
    const r = run(["--verify"]);
    assert.equal(r.stderr, "");
    assert.deepEqual(r.tmpLeft, []);
    const got = (r.stdout + "exit=" + r.status + "\n").split("\n");
    assert.equal(got[ei], wantEngine);
    const masked = (ls) => ls.map((l, i) => (i === ei ? "engine: <masked>" : l)).join("\n");
    assert.equal(masked(got), masked(lines));
    assert.ok(r.stdout.includes(`VERIFY PASSED: ${pins[1]} exact`));
});

test("--verify must-fail control: a gutted clean short-circuit body exits 1 with named VERIFY FAIL lines", () => {
    // Drop `return node.value;` from the clean short-circuit body: every clean read then
    // falls through to the O(deps) walk, so unrelated-read.depWalk is no longer 0.
    const from = "            if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;\n            return node.value;\n        }\n\n        const savedGen";
    assert.equal(LIVE.split(from).length - 1, 1, "edit anchor occurs exactly once");
    const d = mkdtempSync(join(tmpRoot, "g-"));
    const eng = join(d, "Signal.gutted.js");
    writeFileSync(eng, LIVE.replace(from, () => "            if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;\n        }\n\n        const savedGen"));
    const r = run(["--verify", "--engine", eng]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout.includes("VERIFY PASSED"), false);
    assert.match(r.stderr, /VERIFY FAIL: unrelated-read\.depWalk = [1-9]/);
    assert.match(r.stderr, /VERIFY FAILED: \d+ exact-count/);
    assert.deepEqual(r.tmpLeft, []);
});

test("TMPDIR is honoured: a non-existent TMPDIR makes the tool fail non-zero and creates nothing", () => {
    const ghost = join(tmpRoot, "does", "not", "exist");
    const r = run(["--verify"], { TMPDIR: ghost, TMP: ghost, TEMP: ghost });
    assert.equal(r.status, 1);   // a timeout kill would give null
    assert.match(r.stderr, /ENOENT/);
    assert.equal(r.stdout.includes("VERIFY PASSED"), false);
    assert.equal(existsSync(ghost), false);
});
