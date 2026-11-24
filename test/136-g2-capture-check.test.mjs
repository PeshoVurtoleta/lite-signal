// G2 (b251) -- cross-file capture check (lib/rowcheck.mjs, lib/collect.mjs via report.mjs),
// the sweep.mjs per-child stamp call site, and the vs-andrii.mjs join (A3 + D-b251-1).
// Fixtures are generated into os.tmpdir() from the live row names (mirror-config + title +
// micro-suites: 17 dynamic + 30 micro = 47 rows); values are synthetic. No engine other than
// lite is imported; no .handoff path is read; nothing is written under bench/.
// Expected values: PLAN-G2 A2 / A3, the D-b251-1 ruling, and the refusal texts of rowcheck.mjs
// (a tamper must exit 1 and say WHY).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as FX from "./fixtures/g2/capture.mjs";
const { CAP, LITE, ALIEN, REFLEX, SHA_E, SHA_H, DYN, MICRO, cleanModel, writeModel, each, isE, ALL, tok, delTok, row0, firstOf } = FX;

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const BENCH = join(ROOT, "bench");
const RC = await import(pathToFileURL(join(BENCH, "lib", "rowcheck.mjs")).href);
const CO = await import(pathToFileURL(join(BENCH, "lib", "collect.mjs")).href);
const tmps = [];
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };

function node(args, env, opts = {}) {
    const e = { ...process.env, ...(env || {}) };
    delete e.DRIFT_TOL; delete e.CAPTURE_ID;
    const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: opts.timeout || 120000, killSignal: "SIGKILL", env: e, maxBuffer: 1 << 26 });
    assert.equal(r.signal, null, "child killed: " + r.signal);
    return r;
}
function capDir(mutate, engines, reps) {
    const m = cleanModel(engines, reps);
    if (mutate) mutate(m);
    const d = mk("g2-cap-");
    writeModel(d, m);
    return d;
}
const report = (dir) => node([join(BENCH, "report.mjs"), dir]);

// ----------------------------------------------------------------------- A2 via report.mjs
test("A2: clean 2 engines x 2 reps exits 0 and prints the exact VALIDATED line", () => {
    const r = report(capDir());
    assert.equal(r.status, 0, r.stderr);
    // 47 rows (17 dynamic + 8 kairo + 4 fan + 1 mol + 17 sBench), 2 engines -> 94 cells, 4 files
    const line = r.stdout.split("\n").find((l) => l.startsWith("VALIDATED:"));
    assert.equal(line, `VALIDATED: 47 rows, 94 of 94 engine cells (2 engines), 4 rep files, capture ${CAP} (bench/lib/rowcheck.mjs)`);
});

const T = (name, mutate, re, extra = {}) => ({ name, mutate, re, ...extra });
const REASON = (s) => new RegExp("REFUSING to generate a report: " + s);
const TAMPERS = [
    T("alien edgesTraversed=1", (m) => each(m, isE(ALIEN), (f) => { tok(row0(f), "edgesTraversed")[1] = "1"; }), REASON('rowcheck: row ".*" edgesTraversed differs across engines')),
    T("fan checksum=0", (m) => each(m, ALL, (f) => { tok(firstOf(f, "fan"), "checksum")[1] = "0"; }), REASON('rowcheck: .*: row "manyEffectsFromOneSource" has checksum=0, a zero value')),
    T("sum= deleted from one rep", (m) => { delTok(row0(m.files["lite-signal-rep2.txt"]), "sum"); }, REASON('rowcheck: lite-signal-rep2.txt: dynamic row ".*" carries no sum=')),
    T("minimal stamp", (m) => each(m, isE(ALIEN), (f) => { f.stamp = { protocol: "isolated-per-engine" }; }), REASON('rowcheck: alien-signals-rep\\d.txt \\(alien-signals\\): stamp kind undefined != "bench-stamp/v1"')),
    T("empty stamp {}", (m) => each(m, isE(ALIEN), (f) => { f.stamp = {}; }), REASON("COMPLETE marker protocol")),
    T("node v22 vs v24", (m) => { each(m, isE(ALIEN), (f) => { f.stamp.node = "v22.11.0"; }); each(m, isE(LITE), (f) => { f.stamp.node = "v24.11.0"; }); }, REASON('rowcheck: stamp node differs across the capture: .*"v2[24]\\.11\\.0"')),
    T("quick=true", (m) => each(m, ALL, (f) => { f.stamp.extra.quick = true; }), REASON("rowcheck: .*stamp extra.quick=true, expected false \\(a QUICK capture is a smoke run, never publishable\\)")),
    T("captureId != marker", (m) => each(m, ALL, (f) => { f.stamp.extra.captureId = "20261123T120000Z-ffffffff"; }), REASON('rowcheck: .*stamp captureId "20261123T120000Z-ffffffff" != COMPLETE marker captureId "' + CAP + '"')),
    T("row missing from 1 of 2 reps", (m) => { m.files["lite-signal-rep2.txt"].rows.splice(1, 1); }, REASON('lite-signal: row ".*" is in 1 of 2 rep file\\(s\\)')),
    T("one-engine dir", (m) => { delete m.files["alien-signals-rep1.txt"]; delete m.files["alien-signals-rep2.txt"]; m.marker.engines = [LITE]; }, REASON("rowcheck: fewer than 2 engines in the capture \\(lite-signal\\)")),
    // reviewer rows
    T("sums differing only above 2^53 (text compare)", (m) => { each(m, isE(LITE), (f) => { tok(row0(f), "sum")[1] = "9007199254740993"; }); each(m, isE(ALIEN), (f) => { tok(row0(f), "sum")[1] = "9007199254740992"; }); }, REASON('rowcheck: row ".*" sum differs across engines')),
    T("sum=-0", (m) => each(m, ALL, (f) => { tok(row0(f), "sum")[1] = "-0"; }), REASON("rowcheck: .*has sum=-0, a zero value")),
    T("checksum=0.0", (m) => each(m, ALL, (f) => { tok(firstOf(f, "kairo"), "checksum")[1] = "0.0"; }), REASON("rowcheck: .*has checksum=0.0, a zero value")),
    T("sum=1e-400", (m) => each(m, ALL, (f) => { tok(row0(f), "sum")[1] = "1e-400"; }), REASON("rowcheck: .*has sum=1e-400, a zero value")),
    T("edgesTraversed=-5", (m) => each(m, ALL, (f) => { tok(row0(f), "edgesTraversed")[1] = "-5"; }), REASON('rowcheck: .*count edgesTraversed="-5" is not a non-negative integer')),
    T("edgesTraversed=1.5", (m) => each(m, ALL, (f) => { tok(row0(f), "edgesTraversed")[1] = "1.5"; }), REASON('rowcheck: .*count edgesTraversed="1.5" is not a non-negative integer')),
    // one stamp tamper per equal-across field
    T("stamp cpu differs", (m) => each(m, isE(ALIEN), (f) => { f.stamp.cpu = "Intel Xeon"; }), REASON('rowcheck: stamp cpu differs across the capture: .*"Intel Xeon"')),
    T("stamp platform differs", (m) => each(m, isE(ALIEN), (f) => { f.stamp.platform = "linux"; }), REASON('rowcheck: stamp platform differs across the capture: .*"linux"')),
    T("stamp arch differs", (m) => each(m, isE(ALIEN), (f) => { f.stamp.arch = "x64"; }), REASON('rowcheck: stamp arch differs across the capture: .*"x64"')),
    T("stamp node differs across reps", (m) => { m.files["lite-signal-rep2.txt"].stamp.node = "v24.11.0"; }, REASON("lite-signal: lite-signal: mixed hosts across rep files \\(2 distinct\\)")),
    T("stamp harnessSha256 differs across engines", (m) => each(m, isE(ALIEN), (f) => { f.stamp.harnessSha256 = "b".repeat(64); }), REASON("rowcheck: stamp harnessSha256 differs across the capture")),
    T("stamp engineSha256 differs across engines", (m) => each(m, isE(ALIEN), (f) => { f.stamp.engineSha256 = "c".repeat(64); }), REASON("rowcheck: stamp engineSha256 differs across the capture")),
    T("report.mjs COMPLETE-marker protocol refusal (alien stamps isolated-per-row)", (m) => each(m, isE(ALIEN), (f) => { f.stamp.protocol = "isolated-per-row"; }), REASON("COMPLETE marker protocol")),
    T("stamp config differs across engines", (m) => each(m, isE(ALIEN), (f) => { f.stamp.config.prealloc = "eager"; }), REASON("rowcheck: stamp config differs across the capture")),
    T("stamp adapter differs across engines", (m) => each(m, isE(ALIEN), (f) => { f.stamp.extra.adapter = "reset"; }), REASON("rowcheck: stamp extra.adapter differs across the capture")),
    // more refusals
    T("counter differs across one engine's reps", (m) => { tok(row0(m.files["lite-signal-rep2.txt"]), "nodesVisited")[1] = "999999"; }, REASON('rowcheck: lite-signal: row ".*" nodesVisited differs across reps')),
    T("unknown row", (m) => each(m, ALL, (f) => { f.rows.push({ fw: f.engine, test: "bogus row", time: "1.00", tokens: [["checksum", "5"]], capped: false }); }), REASON('rowcheck: .*row "bogus row" is not a known mirror row')),
    T("row carried by one engine only", (m) => each(m, isE(ALIEN), (f) => { f.rows.splice(2, 1); }), REASON('rowcheck: row ".*" is carried by 1 engine\\(s\\)')),
    T("missing nodesRecomputed", (m) => each(m, ALL, (f) => { delTok(row0(f), "nodesRecomputed"); }), REASON("rowcheck: .*carries no nodesRecomputed=")),
    T("kairo checksum missing", (m) => each(m, ALL, (f) => { delTok(firstOf(f, "kairo"), "checksum"); }), REASON("rowcheck: .*kairo row .* carries no checksum=")),
    T("mol checksum=0", (m) => each(m, ALL, (f) => { tok(firstOf(f, "mol"), "checksum")[1] = "0"; }), REASON('rowcheck: .*row "molBench" has checksum=0')),
    T("captureId format", (m) => { each(m, ALL, (f) => { f.stamp.extra.captureId = "capture-1"; }); m.marker.captureId = "capture-1"; }, REASON('rowcheck: captureId "capture-1" does not match')),
    T("marker without captureId", (m) => { delete m.marker.captureId; }, REASON("rowcheck: the COMPLETE marker carries no captureId")),
    T("no COMPLETE marker", (m) => { m.marker = null; }, /REFUSING to generate a report: no readable COMPLETE marker/),
];
for (const t of TAMPERS) {
    test("A2 tamper exits 1: " + t.name, () => {
        const r = report(capDir(t.mutate));
        assert.equal(r.status, 1, r.stdout.slice(0, 300) + r.stderr);
        assert.equal(r.stdout, "");
        assert.match(r.stderr, t.re);
    });
}
test("A2 controls: capped volatile tokens, scientific sum, 3-engine missing cell all pass", () => {
    let r = report(capDir((m) => {
        const a = row0(m.files["lite-signal-rep1.txt"]), b = row0(m.files["lite-signal-rep2.txt"]);
        a.capped = "SLOW/CAPPED"; a.tokens.unshift(["samples", "1"], ["ceiling", "1500ms"]);
        b.capped = "SLOW/CAPPED"; b.tokens.unshift(["samples", "3"], ["ceiling", "1500ms"]);
    }));
    assert.equal(r.status, 0, r.stderr);
    r = report(capDir((m) => each(m, ALL, (f) => { tok(row0(f), "sum")[1] = "2.9694238299960427e+240"; })));
    assert.equal(r.status, 0, r.stderr);
    // a third engine lacking one row: 47 rows x 3 = 141 cells, 140 carried
    r = report(capDir((m) => {
        for (const rep of [1, 2]) {
            const src = m.files[`alien-signals-rep${rep}.txt`];
            const st = JSON.parse(JSON.stringify(src.stamp)); st.extra.refLibs = { [REFLEX]: "0.1.0" };
            const rows = src.rows.map((x) => ({ ...x, fw: REFLEX, tokens: x.tokens.map((t) => t.slice()) }));
            rows.splice(3, 1);
            m.files[`reflex-quant-rep${rep}.txt`] = { engine: REFLEX, stamp: st, rows };
        }
        m.marker.engines = [LITE, ALIEN, REFLEX];
    }), [LITE, ALIEN]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^VALIDATED: 47 rows, 140 of 141 engine cells \(3 engines\), 6 rep files, capture /m);
});

// ----------------------------------------------------------------------- direct rowcheck
test("rowcheck.parseMetrics", () => {
    const P = RC.parseMetrics;
    assert.equal(P(""), null);
    assert.equal(P("   "), null);
    assert.equal(P("# comment"), null);
    assert.equal(P("framework              , test , time     , metrics"), null);
    assert.deepEqual(P("lite-signal , deep , 12.50 , nodesRecomputed=3 sum=-1.5e+3 poolGrowths=0"),
        { ok: true, framework: "lite-signal", test: "deep", time: 12.5, capped: false, tokens: { nodesRecomputed: "3", sum: "-1.5e+3", poolGrowths: "0" } });
    assert.deepEqual(P("a , t , 1 , SLOW/CAPPED samples=2 ceiling=1500ms checksum=7"),
        { ok: true, framework: "a", test: "t", time: 1, capped: true, tokens: { samples: "2", ceiling: "1500ms", checksum: "7" } });
    assert.deepEqual(P("a , t , 1 , ").tokens, {});
    const bad = (line, re) => { const r = P(line); assert.equal(r.ok, false, line); assert.match(r.reason, re); };
    assert.deepEqual(P(5), { ok: false, reason: "not a string" });
    bad("garbage line", /not a mirror row \(no " , " separator\)/);
    bad("a , t , 1", /expected 4 columns, got 3/);
    bad("a ,  , 1 , checksum=3", /empty framework \/ test column/);
    bad("a , t , abc , checksum=3", /t: time "abc" is not a plain non-negative number/);
    bad("a , t , -1 , checksum=3", /time "-1" is not a plain/);
    bad("a , t , 1 , foo=1", /t: unknown token "foo"/);
    bad("a , t , 1 , sum=1 sum=2", /t: duplicate token "sum"/);
    bad("a , t , 1 , x", /t: unparseable token "x"/);
    bad("a , t , 1 , ceiling=15", /ceiling="15" is not <integer>ms/);
    bad("a , t , 1 , sum=NaN", /token sum="NaN" is not a finite decimal number/);
    bad("a , t , 1 , sum=1e999", /token sum="1e999" is not a finite decimal number/);
    bad("a , t , 1 , sum=0123", /token sum="0123"/);
    bad("a , t , 1 , nodesVisited=01", /count nodesVisited="01" is not a non-negative integer/);
    bad("a , t , 1 , nodesVisited=0x3", /count nodesVisited="0x3"/);
    bad("a , t , 1 , sinkReads=", /count sinkReads="" is not a non-negative integer/);
});
test("rowcheck.CAPTURE_ID_RE and makeCaptureId", () => {
    assert.ok(RC.CAPTURE_ID_RE.test("20261123T120000Z-0a1b2c3d"));
    for (const bad of ["20261123T120000Z-0A1B2C3D", "20261123T120000Z-0a1b2c3", "20261123T120000Z-0a1b2c3d4", "2026-11-23T12:00:00Z-0a1b2c3d", "x20261123T120000Z-0a1b2c3d", "20261123T120000Z-0a1b2c3d\n", "capture-1", ""]) {
        assert.equal(RC.CAPTURE_ID_RE.test(bad), false, JSON.stringify(bad));
    }
    assert.equal(RC.makeCaptureId(new Date("2026-11-23T12:34:56.789Z"), "deadbeef"), "20261123T123456Z-deadbeef");
    assert.throws(() => RC.makeCaptureId(new Date("2026-11-23T12:34:56Z"), "DEADBEEF"), /rowcheck: generated capture id "20261123T123456Z-DEADBEEF" does not match/);
    assert.match(RC.makeCaptureId(), RC.CAPTURE_ID_RE);
    assert.notEqual(RC.makeCaptureId(), RC.makeCaptureId());
});
test("rowcheck.checkStamps: exact reasons", () => {
    const ent = (mut) => { const m = cleanModel(); if (mut) mut(m); return Object.entries(m.files).map(([name, f]) => ({ engine: f.engine, name, stamp: f.stamp })); };
    assert.deepEqual(RC.checkStamps(ent(), CAP), { ok: true });
    const bad = (e, cap, re, opts) => { const r = RC.checkStamps(e, cap, opts); assert.equal(r.ok, false); assert.match(r.reason, re); };
    bad(ent(), null, /^the COMPLETE marker carries no captureId/);
    bad(ent(), "", /^the COMPLETE marker carries no captureId/);
    bad(ent(), "nope", /^captureId "nope" does not match/);
    bad([], CAP, /^no stamped rep files$/);
    bad(ent(), CAP, /^checkStamps: opts.quick must be a boolean$/, { quick: "no" });
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.extra.quick = true; })), CAP, /extra\.quick=true, expected false \(a QUICK capture/);
    assert.deepEqual(RC.checkStamps(ent((m) => each(m, ALL, (f) => { f.stamp.extra.quick = true; })), CAP, { quick: true }), { ok: true });
    bad(ent((m) => each(m, ALL, (f) => { f.stamp = null; })), CAP, /: no #STAMP object$/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.kind = "v0"; })), CAP, /stamp kind "v0" != "bench-stamp\/v1"/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.cpu = ""; })), CAP, /stamp cpu is missing or empty/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.engineSha256 = "abc"; })), CAP, /engineSha256 is not 64 hex digits/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.harnessSha256 = SHA_H.toUpperCase(); })), CAP, /harnessSha256 is not 64 hex digits/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.reps = null; })), CAP, /stamp reps null is not an integer >= 1/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.config = {}; })), CAP, /stamp config is missing or empty/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.extra = null; })), CAP, /stamp extra is missing/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.extra.adapter = ""; })), CAP, /stamp extra\.adapter is missing or empty/);
    bad(ent((m) => each(m, ALL, (f) => { delete f.stamp.extra.refLibs; })), CAP, /stamp extra\.refLibs is missing/);
    bad(ent((m) => each(m, isE(ALIEN), (f) => { f.stamp.extra.refLibs = {}; })), CAP, /stamp extra\.refLibs names no version for alien-signals/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.extra.load1 = -1; })), CAP, /stamp extra\.load1 is missing or not a finite number >= 0/);
    bad(ent((m) => each(m, ALL, (f) => { f.stamp.extra.captureId = "20261123T120000Z-ffffffff"; })), CAP, /stamp captureId "20261123T120000Z-ffffffff" != COMPLETE marker captureId/);
    // one row per equal-across field; each names the field and the odd file out
    const fields = [["cpu", (s) => { s.cpu = "X"; }], ["platform", (s) => { s.platform = "linux"; }], ["arch", (s) => { s.arch = "x64"; }],
        ["node", (s) => { s.node = "v24.0.0"; }], ["harnessSha256", (s) => { s.harnessSha256 = "b".repeat(64); }],
        ["engineSha256", (s) => { s.engineSha256 = "c".repeat(64); }], ["protocol", (s) => { s.protocol = "isolated-per-row"; }],
        ["config", (s) => { s.config = { ...s.config, prealloc: "eager" }; }], ["extra.adapter", (s) => { s.extra.adapter = "reset"; }]];
    for (const [field, mut] of fields) {
        const e = ent((m) => each(m, isE(ALIEN), (f) => mut(f.stamp)));
        const r = RC.checkStamps(e, CAP);
        assert.equal(r.ok, false, field);
        assert.match(r.reason, new RegExp("^stamp " + field.replace(".", "\\.") + " differs across the capture: alien-signals-rep\\d\\.txt \\(alien-signals\\) .* != lite-signal-rep1\\.txt \\(lite-signal\\) "), field);
    }
});
test("rowcheck.makeChildStampGuard: first accepted child is the reference; a refused one is not", () => {
    const st = (mut) => { const s = FX.stampFor(LITE); if (mut) mut(s); return s; };
    const g = RC.makeChildStampGuard(CAP, { quick: false });
    assert.deepEqual(g(LITE, "lite/a rep1", st()), { ok: true });
    assert.deepEqual(g(LITE, "lite/b rep1", st()), { ok: true });
    let r = g(LITE, "lite/c rep1", st((s) => { s.node = "v24.0.0"; }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /^stamp node differs across the capture: lite\/c rep1 \(lite-signal\) "v24\.0\.0" != lite\/a rep1 \(lite-signal\) "v26\.8\.2"$/);
    r = g(LITE, "lite/d rep1", st((s) => { s.extra.captureId = "20261123T120000Z-ffffffff"; }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /^lite\/d rep1 \(lite-signal\): stamp captureId "20261123T120000Z-ffffffff" != COMPLETE marker captureId/);
    r = g(LITE, "lite/e rep1", st((s) => { s.extra.quick = true; }));
    assert.match(r.reason, /extra\.quick=true, expected false/);
    // a refused first stamp never becomes the reference
    const g2 = RC.makeChildStampGuard(CAP);
    assert.equal(g2(LITE, "x", st((s) => { s.extra.captureId = "20261123T120000Z-ffffffff"; })).ok, false);
    assert.equal(g2(LITE, "y", st((s) => { s.node = "v1.0.0"; })).ok, true);
    assert.match(g2(LITE, "z", st()).reason, /^stamp node differs across the capture: z \(lite-signal\) "v26\.8\.2" != y \(lite-signal\) "v1\.0\.0"$/);
    // opts.quick = true accepts quick stamps only
    const gq = RC.makeChildStampGuard(CAP, { quick: true });
    assert.equal(gq(LITE, "q", st((s) => { s.extra.quick = true; })).ok, true);
    assert.equal(gq(LITE, "q2", st()).ok, false);
});
test("rowcheck.checkCapture: counts, and refusals reachable from direct calls", () => {
    const marker = { captureId: CAP };
    const ok = RC.checkCapture(capDir(), [LITE, ALIEN], marker, { quick: false });
    assert.deepEqual(ok, { ok: true, rows: 47, engines: 2, files: 4, cells: 94, cellsTotal: 94 });
    const d = capDir();
    assert.match(RC.checkCapture(d, [LITE], marker).reason, /^fewer than 2 engines in the capture \(lite-signal\)/);
    assert.match(RC.checkCapture(d, [LITE, LITE], marker).reason, /^engine list \["lite-signal","lite-signal"\] has a duplicate or empty key$/);
    assert.match(RC.checkCapture(d, [LITE, ALIEN], null).reason, /^no COMPLETE marker object$/);
    assert.match(RC.checkCapture(d, [LITE, "ghost-engine"], marker).reason, /^ghost-engine: no rep files$/);
    assert.match(RC.checkCapture(d, "lite", marker).reason, /^fewer than 2 engines/);
    // quick opts: a quick=true capture passes only with { quick: true }
    const dq = capDir((m) => each(m, ALL, (f) => { f.stamp.extra.quick = true; }));
    assert.equal(RC.checkCapture(dq, [LITE, ALIEN], marker, { quick: false }).ok, false);
    assert.equal(RC.checkCapture(dq, [LITE, ALIEN], marker, { quick: true }).ok, true);
    // a row framework that is not the file's engine
    const df = capDir((m) => { row0(m.files["alien-signals-rep1.txt"]).fw = LITE; });
    assert.match(RC.checkCapture(df, [LITE, ALIEN], marker).reason, /alien-signals-rep1\.txt: row ".*" is framework "lite-signal", not alien-signals/);
    const dd = capDir((m) => { const f = m.files["lite-signal-rep1.txt"]; f.rows.push({ ...f.rows[0] }); });
    assert.match(RC.checkCapture(dd, [LITE, ALIEN], marker).reason, /lite-signal-rep1\.txt: row ".*" appears twice/);
    const dn = capDir((m) => { m.files["lite-signal-rep2.txt"].rows = []; });
    assert.match(RC.checkCapture(dn, [LITE, ALIEN], marker).reason, /lite-signal-rep2\.txt: no data rows/);
    assert.equal(RC.DYNAMIC_REQUIRED.join(","), "nodesRecomputed,nodesVisited,edgesTraversed,sinkReads,sum");
});
test("collect.collectEngine refuses a row present in fewer reps than files (reachable directly)", () => {
    const d = capDir((m) => { m.files["lite-signal-rep2.txt"].rows.splice(0, 1); });
    const rowParser = (text) => {
        const out = new Map();
        for (const line of text.split("\n")) { const p = line.split(" , "); if (p.length === 4 && p[0].trim() === LITE) out.set(p[1].trim(), parseFloat(p[2])); }
        return out;
    };
    const r = CO.collectEngine(d, LITE, 2, rowParser);
    assert.equal(r.ok, false);
    assert.equal(r.reason, `row "${DYN[0]}" is in 1 of 2 rep file(s) -- a median over fewer reps than claimed`);
    const clean = CO.collectEngine(capDir(), LITE, 2, rowParser);
    assert.equal(clean.ok, true);
    assert.equal(clean.reps, 2);
    assert.equal(clean.perTest.size, 47);
    // median of reps 1,2 time for row 0: 5 + 0.37 and 5 + 0.74 -> 5.555 (two values: mean)
    assert.ok(Math.abs(clean.perTest.get(DYN[0]) - 5.555) < 1e-9);
});

// ----------------------------------------------------------------------- sweep call site
// A tmp copy of bench/ (sweep.mjs + lib/) with a STUB mirror.mjs that prints a valid stamp and
// one row, so the sweep's per-child stamp guard runs without any engine. 3 engines x 4 cheap
// scenarios x 2 reps = 24 children + 1 sentinel. The stub's time is constant, so the sentinel is stable.
// G2_SWEEP_SRC=<path> runs another sweep.mjs (e.g. a frozen before-copy for a revert check)
// against the live lib/; a set but missing path is refused.
const SWEEP_SRC = process.env.G2_SWEEP_SRC === undefined ? join(BENCH, "sweep.mjs") : process.env.G2_SWEEP_SRC;
function sweepRun(stubEnv) {
    assert.ok(existsSync(SWEEP_SRC), "G2_SWEEP_SRC: no such file " + JSON.stringify(SWEEP_SRC));
    const d = mk("g2-sweep-");
    mkdirSync(join(d, "bench"));
    cpSync(join(BENCH, "lib"), join(d, "bench", "lib"), { recursive: true });
    cpSync(SWEEP_SRC, join(d, "bench", "sweep.mjs"));
    cpSync(join(here, "fixtures", "g2", "sweep-stub-mirror.mjs"), join(d, "bench", "mirror.mjs"));
    const out = join(d, "out");
    const r = node(["--expose-gc", join(d, "bench", "sweep.mjs")], { SWEEP_DIR: out, SUBSET: "cheap", REPS: "2", QUICK: "", SWEEP_TIMEOUT_MS: "60000", ...stubEnv }, { timeout: 300000 });
    return { r, out, text: r.stdout + r.stderr };
}
test("sweep: a later child stamping a different node exits 1 and writes no COMPLETE", () => {
    const { r, out, text } = sweepRun({ STUB_TAMPER: "node" });
    assert.equal(r.status, 1, text.slice(-600));
    assert.match(text, /stamp check: stamp node differs across the capture: /);
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
test("sweep: a later child stamping another captureId exits 1 and writes no COMPLETE", () => {
    const { r, out, text } = sweepRun({ STUB_TAMPER: "captureId" });
    assert.equal(r.status, 1, text.slice(-600));
    assert.match(text, /stamp check: .*stamp captureId "20261123T120000Z-deadbeef" != COMPLETE marker captureId "[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}" \(a file from another capture\); row discarded/);
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
test("sweep: a sentinel child stamping another node exits 1 (call 25 = the sentinel)", () => {
    const cnt = join(mk("g2-cnt-"), "n");
    const { r, out, text } = sweepRun({ STUB_TAMPER: "sentinel", STUB_COUNT_FILE: cnt });
    assert.equal(r.status, 1, text.slice(-600));
    assert.equal(readFileSync(cnt, "utf8").length, 25);
    assert.match(text, /stamp check: stamp node differs across the capture: sentinel /);
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
test("sweep: a sentinel child printing no stamp exits 1 with the exact reason", () => {
    const cnt = join(mk("g2-cnt-"), "n");
    const { r, out, text } = sweepRun({ STUB_TAMPER: "sentinel-nostamp", STUB_COUNT_FILE: cnt });
    assert.equal(r.status, 1, text.slice(-600));
    assert.equal(readFileSync(cnt, "utf8").length, 25);
    assert.match(text, /stamp check: the sentinel child printed no stamp/);
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
// b254 SENTINEL-FIX (D-b254-1): the sentinel (last call) is compared with the median of the first
// combo's REPS reps. Call 1 is the first combo's rep 1 (schedule step 0).
const cheapSweep = (stubEnv) => {
    const cnt = join(mk("g2-cnt-"), "n");
    const res = sweepRun({ STUB_COUNT_FILE: cnt, ...stubEnv });
    return { ...res, calls: readFileSync(cnt, "utf8").length };
};
test("sweep a+: a sentinel 6.0% above the median baseline exits 1 (SENTINEL DRIFT)", () => {
    const { r, out, text, calls } = cheapSweep({ STUB_TIME_AT: "25:5.30" });
    assert.equal(r.status, 1, text.slice(-600));
    assert.equal(calls, 25);
    assert.match(text, /ratio=1\.060x/);
    assert.ok(text.includes("SENTINEL DRIFT: host moved 6.0% mid-sweep (> 5% tol)"), text.slice(-600));
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
test("sweep a-: a sentinel 6.0% below the median baseline exits 1 (SENTINEL DRIFT)", () => {
    const { r, out, text, calls } = cheapSweep({ STUB_TIME_AT: "25:4.70" });
    assert.equal(r.status, 1, text.slice(-600));
    assert.equal(calls, 25);
    assert.match(text, /ratio=0\.940x/);
    assert.ok(text.includes("SENTINEL DRIFT: host moved -6.0% mid-sweep (> 5% tol)"), text.slice(-600));
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
for (const [tag, t] of [["b+", "5.50"], ["b-", "4.50"]]) {
    test(`sweep ${tag}: REPS=3, first-combo rep 1 at ${t} is absorbed by the median -> stable, exit 0`, () => {
        const { r, out, text, calls } = cheapSweep({ REPS: "3", STUB_TIME_AT: "1:" + t });
        assert.equal(r.status, 0, text.slice(-800));
        assert.equal(calls, 37);
        assert.ok(text.includes("baseline=median(3)=5.00ms  last=5.00ms  ratio=1.000x  (stable)"), text.slice(-800));
        assert.equal(existsSync(join(out, "COMPLETE")), true);
        const rep1 = readFileSync(join(out, "lite-signal-rep1.txt"), "utf8") + readFileSync(join(out, "alien-signals-rep1.txt"), "utf8") + readFileSync(join(out, "reflex-quant-rep1.txt"), "utf8");
        assert.ok(rep1.includes(" , " + t + "     , "), "rep1 files carry the skewed time " + t);
    });
}
// D-b254-2: the first combo's 1-based call numbers come from the STUB_LOG_FILE call log of a clean
// REFERENCE run (same REPS, STUB_LOG_FILE only): every call whose FW|SCENARIO equals call 1's,
// minus the final sentinel call -- never from a copied scenario / engine list. One reference run
// per REPS value, shared by the rows below.
const refRuns = new Map();
const firstComboCalls = (reps) => {
    if (refRuns.has(reps)) return refRuns.get(reps);
    const log = join(mk("g2-ref-"), "log");
    const { r, text, calls } = cheapSweep({ REPS: String(reps), STUB_LOG_FILE: log });
    assert.equal(r.status, 0, "reference run: " + text.slice(-800));
    const lines = readFileSync(log, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, calls);
    lines.forEach((l, i) => assert.ok(l.startsWith((i + 1) + "|"), "reference log line " + (i + 1) + ": " + l));
    const key = (l) => l.slice(l.indexOf("|") + 1);   // "FW|SCENARIO"
    const all = lines.flatMap((l, i) => (key(l) === key(lines[0]) ? [i + 1] : []));
    assert.equal(all.length, reps + 1, "reference run: first-combo calls " + all.join(","));
    assert.equal(all[all.length - 1], calls, "reference run: the final call is the first combo (sentinel)");
    const fs0 = key(lines[0]), sep = fs0.indexOf("|");
    const ref = { f: { engine: fs0.slice(0, sep), scenario: fs0.slice(sep + 1) }, K: all.slice(0, -1) };
    refRuns.set(reps, ref);
    return ref;
};
const assertCallsAre = (log, f, K) => {
    const lines = readFileSync(log, "utf8").trimEnd().split("\n");
    for (const k of K) assert.equal(lines[k - 1], `${k}|${f.engine}|${f.scenario}`);
};
test("sweep c1: a missing first-combo rep 2 row -> drift unmeasured with the count reason, no sentinel line", () => {
    const { f, K } = firstComboCalls(2);
    assert.equal(K.length, 2);
    const log = join(mk("g2-log-"), "log");
    const { r, out, text, calls } = cheapSweep({ STUB_NOROW_AT: String(K[1]), STUB_LOG_FILE: log });
    assert.equal(r.status, 1, text.slice(-600));
    assert.equal(calls, 25);
    assert.equal(readFileSync(log, "utf8").trimEnd().split("\n").length, 25);
    assertCallsAre(log, f, [...K, 25]);
    assert.ok(text.includes(`sentinel ${f.engine}/${f.scenario}: drift unmeasured -- baseline needs 2 of 2 first-combo reps, got 1`), text.slice(-800));
    assert.doesNotMatch(r.stdout, /^sentinel: /m);
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
test("sweep b3: REPS=3, first-combo rep 1 at 6.00 and rep 3 at 4.00 -> median 5.00, stable, exit 0", () => {
    const { f, K } = firstComboCalls(3);
    assert.equal(K.length, 3);
    const log = join(mk("g2-log-"), "log");
    const { r, out, text, calls } = cheapSweep({ REPS: "3", STUB_TIME_AT: "1:6.00," + K[2] + ":4.00", STUB_LOG_FILE: log });
    assert.equal(r.status, 0, text.slice(-800));
    assert.equal(calls, 37);
    assertCallsAre(log, f, [...K, 37]);
    assert.ok(text.includes("baseline=median(3)=5.00ms  last=5.00ms  ratio=1.000x  (stable)"), text.slice(-800));
    assert.equal(existsSync(join(out, "COMPLETE")), true);
});
test("sweep c3: a 0 first-combo rep 1 time (rowcheck accepts it) -> exit 1, drift unmeasured is the only failure", () => {
    const { r, out, text, calls } = cheapSweep({ STUB_TIME_AT: "1:0" });
    assert.equal(r.status, 1, text.slice(-600));
    assert.equal(calls, 25);
    assert.ok(text.includes("INVALID RUN -- 1 guard failure(s)"), text.slice(-800));
    assert.ok(text.includes("drift unmeasured -- first-combo rep 1 time 0 is not a finite positive number"), text.slice(-800));
    assert.doesNotMatch(r.stdout, /^sentinel: /m);
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
test("sweep c4: a stamp-discarded first-combo rep 2 row is not in the baseline -> drift unmeasured, no sentinel line", () => {
    const { f, K } = firstComboCalls(2);
    const log = join(mk("g2-log-"), "log");
    const { r, out, text, calls } = cheapSweep({ STUB_NODE_AT: String(K[1]), STUB_LOG_FILE: log });
    assert.equal(r.status, 1, text.slice(-600));
    assert.equal(calls, 25);
    assertCallsAre(log, f, [...K, 25]);
    assert.match(text, /stamp check: stamp node differs across the capture: /);
    assert.ok(text.includes("drift unmeasured -- baseline needs 2 of 2 first-combo reps, got 1"), text.slice(-800));
    assert.doesNotMatch(r.stdout, /^sentinel: /m);
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
test("sweep c2: a NaN first-combo rep 1 time -> drift unmeasured with the finite reason", () => {
    const { r, out, text, calls } = cheapSweep({ STUB_TIME_AT: "1:NaN" });
    assert.equal(r.status, 1, text.slice(-600));
    assert.equal(calls, 25);
    assert.ok(text.includes("drift unmeasured -- first-combo rep 1 time NaN is not a finite positive number"), text.slice(-800));
    assert.doesNotMatch(r.stdout, /^sentinel: /m);
    assert.equal(existsSync(join(out, "COMPLETE")), false);
});
test("sweep: the same stub with consistent stamps exits 0 and COMPLETE carries the sweep's captureId", () => {
    const { r, out, text } = sweepRun({});
    assert.equal(r.status, 0, text.slice(-800));
    assert.match(text, /sweep OK -- stamp-consistent/);
    const marker = JSON.parse(readFileSync(join(out, "COMPLETE"), "utf8"));
    assert.equal(marker.writer, "sweep.mjs");
    assert.equal(marker.reps, 2);
    assert.deepEqual(marker.engines, ["lite-signal", "alien-signals", "reflex-quant"]);
    assert.match(marker.captureId, RC.CAPTURE_ID_RE);
    assert.ok(text.includes("capture: " + marker.captureId));
    // 3 engines x 2 reps rep files, each stamped with the capture id
    for (const e of marker.engines) for (const rep of [1, 2]) {
        const t = readFileSync(join(out, `${e}-rep${rep}.txt`), "utf8");
        assert.ok(t.includes(`"captureId":"${marker.captureId}"`), `${e} rep${rep}`);
    }
});

// ----------------------------------------------------------------------- vs-andrii (A3 + D-b251-1)
const LIN = "8x64 - 1 sources - pull (linear chain - 1 source - pull (linear pull))";
const BRA = "64x4 - 8 sources - pull (wide tree - 8 sources - pull (branchy pull))";
const padR = (s, n) => { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); };
const TITLES = DYN.concat(MICRO.map((m) => m.name));
const metricsOf = (i) => i < DYN.length
    ? `nodesRecomputed=${1000 + i} nodesVisited=${1000 + i} edgesTraversed=${4000 + i} sinkReads=${10 + i}`
    : (MICRO[i - DYN.length].group === "fan" ? `checksum=${777 + i}` : "");
const HEAD = ["framework".padEnd(22), "test".padEnd(60), "time".padEnd(8), "metrics"].join(" , ");
const STAMP = { kind: "bench-stamp/v1", protocol: "isolated-per-engine", extra: { adapter: "destroy" } };
const localRow = (fw, i, t = 10 + i) => [padR(fw, 22), padR(TITLES[i], 60), padR(typeof t === "number" ? t.toFixed(2) : t, 8), metricsOf(i)].join(" , ");
// Andrii's side cuts the test column at 60 chars (his columnWidth.test)
const andriiRow = (fw, i, metrics = metricsOf(i), t = 12 + i) => [padR(fw, 22), padR(TITLES[i].slice(0, 60), 60), padR(typeof t === "number" ? t.toFixed(2) : t, 8), padR(metrics, 97)].join(" , ");
const ORPH = [DYN.indexOf(LIN), DYN.indexOf(BRA)];
const ALLI = TITLES.map((_, i) => i);
function files(o = {}) {
    const d = mk("g2-va-");
    const lOnly = (o.localRows ?? ALLI.map((i) => localRow("lite-signal", i))).concat(o.localExtra ?? []);
    writeFileSync(join(d, "local.txt"), ["#STAMP " + JSON.stringify(STAMP), HEAD, ...lOnly, ...ALLI.map((i) => localRow("alien-signals", i))].join("\n") + "\n");
    const aRows = o.andriiRows ?? ALLI.filter((i) => !ORPH.includes(i)).map((i) => andriiRow("lite-signal", i));
    writeFileSync(join(d, "andrii.log"), [HEAD, ...ALLI.map((i) => andriiRow("alien-signals", i)), ...aRows, ...(o.andriiExtra ?? [])].join("\n") + "\n");
    return d;
}
const va = (d, l = "local.txt", a = "andrii.log") => node([join(BENCH, "vs-andrii.mjs"), join(d, l), join(d, a)]);
const lines = (s) => s.split("\n");

test("A3: clean real-shape join exits 0: 45 joined, exactly 30 n/a, 15 ok, 2 named mirror-only", () => {
    // 7 titles are longer than 60 chars: the join must still reach 45 (the old join: 38)
    assert.equal(TITLES.filter((t) => t.length > 60).length, 7);
    const r = va(files());
    assert.equal(r.status, 0, r.stdout.slice(-500) + r.stderr);
    const L = lines(r.stdout);
    assert.ok(L.includes("joined 45 row(s) on joinKey (local lite-signal vs andrii lite-signal); 30 n/a (no counters); 0 andrii row(s) with no local row."));
    assert.equal(L.filter((l) => l.includes("n/a (no counters: equal work unverified)")).length, 30);
    assert.equal(L.filter((l) => / ok$/.test(l)).length, 15);
    assert.deepEqual(L.filter((l) => l.startsWith("mirror-only")), [`mirror-only (no Andrii row): "${LIN}"`, `mirror-only (no Andrii row): "${BRA}"`]);
    assert.ok(L.includes("all 15 joined row(s) WITH counters match (equal work counted; see the note below on what the times compare)."));
    assert.equal(L.filter((l) => l.startsWith("!!")).length, 0);
});
test("D-b251-1: either MIRROR_ONLY member present on Andrii's side exits 1 naming it", () => {
    for (const [title, idx] of [[LIN, ORPH[0]], [BRA, ORPH[1]]]) {
        const base = ALLI.filter((i) => !ORPH.includes(i)).map((i) => andriiRow("lite-signal", i));
        const r = va(files({ andriiRows: base.concat([andriiRow("lite-signal", idx)]) }));
        assert.equal(r.status, 1);
        assert.ok(lines(r.stdout).includes(`!! MIRROR_ONLY title "${title}" HAS an andrii lite-signal row -- the MIRROR_ONLY list is stale`));
        assert.ok(lines(r.stdout).includes("vs-andrii: FAIL -- 1 MIRROR_ONLY title(s) found on the andrii side"));
    }
    // both present: all 47 join, both stale
    const r = va(files({ andriiRows: ALLI.map((i) => andriiRow("lite-signal", i)) }));
    assert.equal(r.status, 1);
    assert.ok(lines(r.stdout).includes("vs-andrii: FAIL -- 2 MIRROR_ONLY title(s) found on the andrii side"));
    assert.ok(lines(r.stdout).includes("joined 47 row(s) on joinKey (local lite-signal vs andrii lite-signal); 30 n/a (no counters); 0 andrii row(s) with no local row."));
});
test("A3: WORK DIFFERS exits 1; joined 0 exits 1; a third unjoined local row exits 1", () => {
    const kan = DYN.findIndex((t) => t.includes("(kanban board)"));
    let rows = ALLI.filter((i) => !ORPH.includes(i)).map((i) => andriiRow("lite-signal", i, i === kan ? metricsOf(i).replace("edgesTraversed=4002", "edgesTraversed=4003") : metricsOf(i)));
    let r = va(files({ andriiRows: rows }));
    assert.equal(r.status, 1);
    assert.ok(lines(r.stdout).includes("vs-andrii: FAIL -- 1 row(s) WORK DIFFERS"));
    assert.ok(lines(r.stdout).some((l) => l.endsWith("!! WORK DIFFERS -- comparison void")));
    // his rows under another framework name: nothing joins
    const other = ALLI.map((i) => andriiRow("reflex", i));
    r = va(files({ andriiRows: other }));
    assert.equal(r.status, 1);
    assert.ok(lines(r.stdout).includes("vs-andrii: FAIL -- joined 0 rows; 45 local row(s) unjoined"));
    // local file with no lite rows at all: joined 0, nothing unjoined
    r = va(files({ localRows: [] }));
    assert.equal(r.status, 1);
    assert.ok(lines(r.stdout).includes("vs-andrii: FAIL -- joined 0 rows"));
    // molBench missing on his side -> one more unjoined local row
    const mol = TITLES.indexOf("molBench");
    rows = ALLI.filter((i) => !ORPH.includes(i) && i !== mol).map((i) => andriiRow("lite-signal", i));
    r = va(files({ andriiRows: rows }));
    assert.equal(r.status, 1);
    assert.ok(lines(r.stdout).includes('!! unjoined local row: "molBench" (key "molBench") has no andrii lite-signal row'));
    assert.ok(lines(r.stdout).includes("vs-andrii: FAIL -- 1 local row(s) unjoined"));
});
test("A3: join-key collision on either side exits 1 naming both titles", () => {
    const twin = TITLES[0].slice(0, 60) + "TWIN";
    let r = va(files({ localExtra: [[padR("lite-signal", 22), padR(twin, 60), "10.00   ", ""].join(" , ")] }));
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `vs-andrii: REFUSING -- local join-key collision for lite-signal: "${TITLES[0]}" and "${twin}" share the key "${TITLES[0].slice(0, 60).trimEnd()}"\n`);
    const base = ALLI.filter((i) => !ORPH.includes(i)).map((i) => andriiRow("lite-signal", i));
    r = va(files({ andriiRows: base.concat([andriiRow("lite-signal", TITLES.indexOf("molBench"))]) }));
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'vs-andrii: REFUSING -- andrii join-key collision for lite-signal: "molBench" and "molBench" share the key "molBench"\n');
});
test("vs-andrii: a non-finite local / andrii lite time exits 1 (NaN, -, Infinity, -Infinity, 1e400, empty)", () => {
    const kan = DYN.findIndex((t) => t.includes("(kanban board)"));
    const kt = TITLES[kan];
    for (const bad of ["NaN", "-", "Infinity", "-Infinity", "1e400", ""]) {
        const lrows = ALLI.map((i) => i === kan ? localRow("lite-signal", i, bad) : localRow("lite-signal", i));
        let r = va(files({ localRows: lrows }));
        assert.equal(r.status, 1, "local " + JSON.stringify(bad));
        assert.equal(r.stdout, "");
        assert.equal(r.stderr, `vs-andrii: REFUSING -- local lite-signal row "${kt}" has no finite time ("${bad}")\n`);
        const arows = ALLI.filter((i) => !ORPH.includes(i)).map((i) => i === kan ? andriiRow("lite-signal", i, metricsOf(i), bad) : andriiRow("lite-signal", i));
        r = va(files({ andriiRows: arows }));
        assert.equal(r.status, 1, "andrii " + JSON.stringify(bad));
        assert.equal(r.stdout, "");
        assert.equal(r.stderr, `vs-andrii: REFUSING -- andrii lite-signal row "${kt.slice(0, 60).trimEnd()}" has no finite time ("${bad}")\n`);
    }
    // a bad time on a framework that is NOT the joined one is ignored
    const lrows = ALLI.map((i) => localRow("lite-signal", i));
    const d = files({ localRows: lrows });
    const t = readFileSync(join(d, "local.txt"), "utf8").replace(/(alien-signals\s+ , [^\n]*?\) +, )(\d+\.\d+)/, "$1NaN");
    assert.match(t, /alien-signals.*, NaN/);
    writeFileSync(join(d, "local.txt"), t);
    assert.equal(va(d).status, 0);
});
test("vs-andrii: unreadable input exits 2 with one line (missing, directory, no permission)", () => {
    const d = files();
    let r = va(d, "no-such-local.txt");
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `vs-andrii: cannot read the local file ${join(d, "no-such-local.txt")} (ENOENT)\n`);
    r = va(d, "local.txt", "no-such-andrii.log");
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `vs-andrii: cannot read the andrii file ${join(d, "no-such-andrii.log")} (ENOENT)\n`);
    mkdirSync(join(d, "adir"));
    r = va(d, "adir");
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `vs-andrii: cannot read the local file ${join(d, "adir")} (EISDIR)\n`);
    r = va(d, "local.txt", "adir");
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `vs-andrii: cannot read the andrii file ${join(d, "adir")} (EISDIR)\n`);
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
        writeFileSync(join(d, "secret.txt"), "x");
        chmodSync(join(d, "secret.txt"), 0);
        r = va(d, "secret.txt");
        assert.equal(r.status, 2);
        assert.equal(r.stderr, `vs-andrii: cannot read the local file ${join(d, "secret.txt")} (EACCES)\n`);
        r = va(d, "local.txt", "secret.txt");
        assert.equal(r.status, 2);
        assert.equal(r.stderr, `vs-andrii: cannot read the andrii file ${join(d, "secret.txt")} (EACCES)\n`);
        chmodSync(join(d, "secret.txt"), 0o600);
    }
    // usage and stamp refusals
    r = node([join(BENCH, "vs-andrii.mjs")]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^usage: node bench\/vs-andrii\.mjs <local-mirror\.txt> <andrii-log\.txt>/);
    writeFileSync(join(d, "nostamp.txt"), HEAD + "\n");
    r = va(d, "nostamp.txt");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /has no #STAMP line/);
});
