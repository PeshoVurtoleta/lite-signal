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
import { spawn } from "node:child_process";
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

test("exports: MODULE_REF + 14 EDITS + 12 NAMES; NAMES / I / IDX agree", () => {
    assert.deepEqual(Object.keys(A).sort(), ["EDITS", "I", "IDX", "MODULE_REF", "NAMES", "instrument"]);
    assert.ok(MODULE_REF instanceof RegExp);
    assert.equal(EDITS.length, 14);
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

test("instrument(''): 14 drift lines, each ONE line, each 'found 0x, expected Nx'", () => {
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
// CI class 9 (b129): CI run 40630057413 (ubuntu, node 24) lost the gutted --verify row to
// the old spawnSync 120 s timeout (status null !== 1) on a child that runs 0.3-2.2 s. The
// cause is unknown, so every CLI row runs through run() below, which makes the NEXT hang
// self-diagnosing instead of a bare `null !== 1`:
//   - at reportMs (90 s) SIGUSR2 -> --report-on-signal writes a node report into a dir
//     OUTSIDE the run's TMPDIR (so tmpLeft stays exactly as strong). That report is written
//     FROM THE EVENT LOOP: it appears only when the loop still turns (an async stall). A
//     main thread busy in JS or blocked in native writes nothing (measured, node 26.8.2).
//   - no report after usr2Ms: SIGUSR1 starts the inspector (--inspect-port=0: a random
//     port, nothing opens unless signalled), Debugger.pause interrupts busy JS, its call
//     frames are recorded and process.report.writeReport() runs ON the paused top frame,
//     so the report's javascriptStack is the hang. No pause -> diag says native-blocked.
//   - Linux: /proc State, wchan and every thread's comm + state, read before any signal.
//   - SIGKILL at reportMs + windowMs, and never later than hardMs (120 s) after spawn.
// r.diag (wall ms, status, signal, the hang findings, stdout / stderr tails) is the message
// of every CLI assertion. Diagnostics are try/catch'd: they never throw and never change a
// verdict. The report's environmentVariables and sharedObjects are never printed.
const tmpRoot = mkdtempSync(join(tmpdir(), "va54-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
const BUDGET = Object.freeze({ reportMs: 90000, usr2Ms: 5000, windowMs: 15000, hardMs: 120000 });
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "..." : s);
const tail = (s) => (s.length > 2048 ? `...[${s.length - 2048} B cut]` + s.slice(-2048) : s);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const procSnap = (pid) => {
    if (process.platform !== "linux") return `proc: n/a on ${process.platform}`;
    const out = [];
    try { const m = /^State:\s*(.*)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8")); out.push("State " + (m ? m[1] : "?")); } catch (e) { out.push("status " + (e.code || e.message)); }
    try { out.push("wchan " + readFileSync(`/proc/${pid}/wchan`, "utf8").trim()); } catch (e) { out.push("wchan " + (e.code || e.message)); }
    try {
        for (const tid of readdirSync(`/proc/${pid}/task`)) {
            try { const m = /\((.*)\)\s+(\S)/s.exec(readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8")); out.push(`task ${tid} ${m ? m[1] + " " + m[2] : "?"}`); } catch (e) { out.push(`task ${tid} ${e.code || e.message}`); }
        }
    } catch (e) { out.push("tasks " + (e.code || e.message)); }
    return "proc (pre-signal): " + out.join("; ");
};
const readReport = (dir) => {
    try {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith(".json")) continue;
            try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { /* still being written */ }
        }
    } catch { /* no dir: no report */ }
    return null;
};
const summarize = (rp) => {
    const L = [];
    try {
        const h = rp.header || {}, js = rp.javascriptStack || {};
        L.push(`report: event=${h.event} trigger=${h.trigger}`);
        L.push("  js stack: " + clip(String(js.message), 300));
        for (const f of (Array.isArray(js.stack) ? js.stack : []).slice(0, 20)) L.push("    " + clip(String(f), 300));
        for (const f of (Array.isArray(rp.nativeStack) ? rp.nativeStack : []).slice(0, 20)) L.push("  native " + clip(String(f.symbol || f.pc), 200));
        const by = {};
        for (const u of (Array.isArray(rp.libuv) ? rp.libuv : [])) {
            const c = by[u.type] || (by[u.type] = [0, 0, 0]);
            c[0]++; if (u.is_active) c[1]++; if (u.is_referenced) c[2]++;
        }
        L.push("  libuv: " + Object.entries(by).map(([k, [n, a, rf]]) => `${k} x${n} (active ${a}, ref ${rf})`).join(", "));
    } catch (e) { L.push("report summary failed: " + e.message); }
    return L.join("\n");
};
// Busy-JS fallback: the inspector's pause lands through a V8 interrupt, where the
// event-loop-driven SIGUSR2 report cannot. Resolves when done or at `until`; never rejects.
const inspectHung = (child, getErr, until, notes) => new Promise((res) => {
    let ws = null, iv = null, to = null, fin = false, id = 0, writeId = -1;
    const urls = new Map();   // scriptId -> url (paused call frames carry no url for ESM)
    const end = (m) => {
        if (fin) return;
        fin = true;
        if (m) notes.push(m);
        clearInterval(iv); clearTimeout(to);
        try { if (ws !== null) ws.close(); } catch { /* best effort */ }
        res();
    };
    const send = (method, params) => { try { ws.send(JSON.stringify({ id: ++id, method, params: params || {} })); } catch (e) { end("inspector: send failed " + e.message); } };
    if (typeof WebSocket !== "function") { end("inspector: skipped, no global WebSocket on " + process.version); return; }
    to = setTimeout(() => end("inspector: no Debugger.paused in time -- the main thread is not running JS (blocked in native?)"), Math.max(0, until - performance.now()));
    try { if (!child.kill("SIGUSR1")) { end("inspector: SIGUSR1 not delivered"); return; } } catch (e) { end("inspector: SIGUSR1 failed " + e.message); return; }
    notes.push("sent SIGUSR1 (inspector)");
    iv = setInterval(() => {
        if (ws !== null || fin) return;
        const m = /Debugger listening on (ws:\/\/\S+)/.exec(getErr());
        if (m === null) return;
        try { ws = new WebSocket(m[1]); } catch (e) { end("inspector: connect failed " + e.message); return; }
        ws.onerror = () => end("inspector: websocket error");
        ws.onclose = () => end("inspector: websocket closed");
        ws.onopen = () => { send("Debugger.enable"); send("Debugger.pause"); };
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(String(ev.data)); } catch { return; }
            if (msg.method === "Debugger.scriptParsed") { if (msg.params) urls.set(msg.params.scriptId, msg.params.url); return; }
            if (msg.method === "Debugger.paused") {
                const cf = (msg.params && Array.isArray(msg.params.callFrames)) ? msg.params.callFrames : [];
                notes.push(`inspector: paused, ${cf.length} frame(s)`);
                for (const f of cf.slice(0, 20)) notes.push(`    ${f.functionName || "(anonymous)"} ${f.url || (f.location && urls.get(f.location.scriptId)) || "?"}:${f.location ? f.location.lineNumber + 1 : "?"}`);
                if (cf.length === 0) { end(); return; }
                writeId = id + 1;
                send("Debugger.evaluateOnCallFrame", { callFrameId: cf[0].callFrameId, expression: "process.report.writeReport()" });
            } else if (msg.id === writeId) {
                end(msg.error || (msg.result && msg.result.exceptionDetails)
                    ? "inspector: writeReport() failed " + clip(JSON.stringify(msg.error || msg.result.exceptionDetails), 300)
                    : "inspector: writeReport() ran on the paused frame");
            }
        };
    }, 50);
});
// spawnSync's { status, signal, stdout, stderr } (status null when killed) + tmpLeft, wallMs, diag.
// `b` overrides BUDGET fields (ms from spawn, except usr2Ms / windowMs: ms after reportMs).
const run = (args, extraEnv = {}, b = BUDGET) => new Promise((resolve) => {
    b = { ...BUDGET, ...b };
    const t = mkdtempSync(join(tmpRoot, "r-"));
    const rep = mkdtempSync(join(tmpRoot, "rep-"));   // sibling of t, never inside it
    const env = { ...process.env, TMPDIR: t, TMP: t, TEMP: t, ...extraEnv };
    const argv = ["--report-on-signal", "--report-signal=SIGUSR2", `--report-directory=${rep}`, "--inspect-port=0", TOOL, ...args];
    const t0 = performance.now();
    let stdout = "", stderr = "", exited = false, hardHit = false, hangP = null;
    const notes = [];
    const child = spawn(process.execPath, argv, { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { notes.push("spawn error: " + e.message); });
    const waitReport = async (until) => {
        for (;;) {
            const rp = readReport(rep);
            if (rp !== null || exited || !(performance.now() < until)) return rp;
            await sleep(100);
        }
    };
    const onHang = async () => {
        try {
            notes.push(`HANG: no exit after ${Math.round(performance.now() - t0)} ms -- diagnosing`);
            notes.push(procSnap(child.pid));
            const killAt = t0 + Math.min(b.reportMs + b.windowMs, b.hardMs);
            try { child.kill("SIGUSR2"); notes.push("sent SIGUSR2 (report-on-signal)"); } catch (e) { notes.push("SIGUSR2 failed " + e.message); }
            let rp = await waitReport(Math.min(t0 + b.reportMs + b.usr2Ms, killAt));
            if (rp !== null) notes.push("report appeared via SIGUSR2 (the event loop still turns: an async stall)");
            else if (!exited) {
                notes.push(`no report ${b.usr2Ms} ms after SIGUSR2 -- the event loop is not turning (main thread busy in JS or blocked in native)`);
                await inspectHung(child, () => stderr, killAt, notes);
                rp = await waitReport(killAt);
                notes.push(rp !== null ? "report appeared via the inspector" : notes.includes("inspector: writeReport() ran on the paused frame")
                    ? "report did NOT appear in the report dir although writeReport() ran" : "report did NOT appear (main thread blocked in native?)");
            }
            if (rp !== null) notes.push(summarize(rp));
            if (!exited) { notes.push(`SIGKILL at ${Math.round(performance.now() - t0)} ms`); child.kill("SIGKILL"); }
        } catch (e) { notes.push("diagnostic failed: " + e.message); try { child.kill("SIGKILL"); } catch { /* gone */ } }
    };
    const soft = setTimeout(() => { hangP = onHang(); }, b.reportMs);
    const hard = setTimeout(() => { hardHit = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, b.hardMs);
    child.on("close", (status, signal) => {
        exited = true;
        clearTimeout(soft); clearTimeout(hard);
        const wallMs = Math.round(performance.now() - t0);
        Promise.resolve(hangP).then(() => {
            let tmpLeft;
            try { tmpLeft = readdirSync(t); } catch (e) { tmpLeft = ["<readdir " + (e.code || e.message) + ">"]; }
            const diag = [`wall ${wallMs} ms, status ${status}, signal ${signal}`, ...notes,
                ...(hardHit ? [`hard ceiling ${b.hardMs} ms hit: SIGKILL`] : []),
                "--- stdout tail ---", tail(stdout), "--- stderr tail ---", tail(stderr)].join("\n");
            resolve({ status, signal, stdout, stderr, tmpLeft, wallMs, diag });
        });
    });
});

test("argv: unknown arguments exit 2, empty stdout, one stderr line, case-insensitive hint", async () => {
    const H_V = "--verify", H_E = "--engine <path>", H_B = "--verify or --engine <path>";
    for (const [arg, hint] of [["--VERIFY", H_V], ["-v", H_V], ["--verfy", H_V], ["--Engine", H_E], ["-e", H_E], ["foo", H_B], ["--help", H_B]]) {
        const r = await run([arg]);
        const m = arg + "\n" + r.diag;
        assert.equal(r.status, 2, m);
        assert.equal(r.stdout, "", m);
        assert.equal(r.stderr, `visit-anatomy: unknown argument ${JSON.stringify(arg)} (did you mean ${hint}?)\n`, m);
        assert.deepEqual(r.tmpLeft, [], m);
    }
});

test("argv: strict rejections (duplicate --engine / --verify, bare --engine, missing engine) exit 2 with a named reason", async () => {
    const missing = join(tmpRoot, "no-such-engine.js");
    for (const [args, re] of [
        [["--engine", join(REPO, "Signal.js"), "--engine", join(REPO, "Signal.js")], /^visit-anatomy: duplicate argument "--engine"/],
        [["--engine"], /^visit-anatomy: --engine needs a Signal\.js path\n$/],
        [["--verify", "--verify"], /^visit-anatomy: duplicate argument "--verify"\n$/],
        [["--engine", missing], /^visit-anatomy: cannot read engine .*ENOENT\)\n$/],
    ]) {
        const r = await run(args);
        const m = args.join(" ") + "\n" + r.diag;
        assert.equal(r.status, 2, m);
        assert.equal(r.stdout, "", m);
        assert.equal(r.stderr.split("\n").length, 2, m);   // one line + trailing newline
        assert.match(r.stderr, re, m);
        assert.deepEqual(r.tmpLeft, [], m);
    }
});

test("--verify: stdout + exit line equals the verify golden; engine line checked by sha; no tmp dir left", async () => {
    const golden = readFileSync(GOLDEN_VERIFY, "utf8");
    const lines = golden.split("\n");
    const ei = lines.findIndex((l) => l.startsWith("engine: "));
    assert.ok(ei >= 0, "golden has an engine: line");
    const wantEngine = `engine: Signal.js sha256 ${sha(LIVE)} instrumented sha256 ${sha(instrument(LIVE))}`;
    const pins = /VERIFY PASSED: (\d+) exact structural pins hold/.exec(golden);
    assert.ok(pins, "golden has a VERIFY PASSED line");
    const gj = JSON.parse(readFileSync(join(REPO, "bench/soak/calibration/golden/visit-anatomy.golden.json"), "utf8"));
    assert.equal(Number(pins[1]), gj.pins);   // golden text and golden.json agree on the pin count
    const r = await run(["--verify"]);
    assert.equal(r.stderr, "", r.diag);
    assert.deepEqual(r.tmpLeft, [], r.diag);
    const got = (r.stdout + "exit=" + r.status + "\n").split("\n");
    assert.equal(got[ei], wantEngine, r.diag);
    const masked = (ls) => ls.map((l, i) => (i === ei ? "engine: <masked>" : l)).join("\n");
    const at = got.findIndex((l, i) => i !== ei && l !== lines[i]);   // the diff's first line, kept in the message
    assert.equal(masked(got), masked(lines), `golden mismatch at line ${at + 1}: got ${JSON.stringify(got[at])} want ${JSON.stringify(lines[at])}\n` + r.diag);
    assert.ok(r.stdout.includes(`VERIFY PASSED: ${pins[1]} exact`), r.diag);
});

test("--verify must-fail control: a gutted clean short-circuit body exits 1 with named VERIFY FAIL lines", async () => {
    // Drop the bare `return;` from the clean short-circuit body: every clean read then
    // falls through to the O(deps) walk, so unrelated-read.depWalk is no longer 0.
    // FIX-T W2 (b102): the body lives in refreshComputed (returns void, never throws the
    // cached error), so the 1.5.x `throw node.value; return node.value;` anchor is gone --
    // same mutant, retargeted to the body's new last statement.
    const from = "            node.evalVersion = globalVersion | 0;\n            return;\n        }\n\n        const savedGen";
    assert.equal(LIVE.split(from).length - 1, 1, "edit anchor occurs exactly once");
    const d = mkdtempSync(join(tmpRoot, "g-"));
    const eng = join(d, "Signal.gutted.js");
    writeFileSync(eng, LIVE.replace(from, () => "            node.evalVersion = globalVersion | 0;\n        }\n\n        const savedGen"));
    const r = await run(["--verify", "--engine", eng]);
    assert.equal(r.status, 1, r.diag);
    assert.equal(r.stdout.includes("VERIFY PASSED"), false, r.diag);
    assert.match(r.stderr, /VERIFY FAIL: unrelated-read\.depWalk = [1-9]/, r.diag);
    assert.match(r.stderr, /VERIFY FAILED: \d+ exact-count/, r.diag);
    assert.deepEqual(r.tmpLeft, [], r.diag);
});

test("TMPDIR is honoured: a non-existent TMPDIR makes the tool fail non-zero and creates nothing", async () => {
    const ghost = join(tmpRoot, "does", "not", "exist");
    const r = await run(["--verify"], { TMPDIR: ghost, TMP: ghost, TEMP: ghost });
    assert.equal(r.status, 1, r.diag);   // a timeout kill would give null
    assert.match(r.stderr, /ENOENT/, r.diag);
    assert.equal(r.stdout.includes("VERIFY PASSED"), false, r.diag);
    assert.equal(existsSync(ghost), false, r.diag);
});

// Must-fail row (a) for the diagnostic itself (b129): two planted engines under a short
// budget, run side by side. SPIN = an infinite loop at the top of requirePositiveInt, which
// --verify first reaches AFTER import (the import-time createRegistry() passes no config);
// the SIGUSR2 report cannot fire there, the inspector path must. STALL = a top-level await
// on a promise that never settles while a ref'd 60 s timer keeps the loop alive; the SIGUSR2
// path must report it. instrument() accepting both copies proves no EDITS anchor moved.
// A sentinel env var proves the report's environmentVariables never reach diag.
test("hang diagnostic self-test (b129 must-fail row a): planted busy-JS hang and async stall are SIGKILLed with a report naming the hang",
    { skip: !(Number(process.versions.node.split(".")[0]) >= 22) && typeof WebSocket !== "function" && `no global WebSocket on ${process.version} (the inspector fallback needs it)` }, async () => {
        const SPIN = "function requirePositiveInt(v, name) {\n";
        const STALL = "let defaultRegistry = createRegistry();\n";
        assert.equal(LIVE.split(SPIN).length - 1, 1, "SPIN anchor occurs exactly once");
        assert.equal(LIVE.split(STALL).length - 1, 1, "STALL anchor occurs exactly once");
        const spinSrc = LIVE.replace(SPIN, () => SPIN + "    for (const e = Date.now() + 60000; Date.now() < e;) { /* b129 planted busy-JS hang, bounded: never orphans */ }\n");
        const stallSrc = LIVE.replace(STALL, () => "await new Promise(function plantedStall() { setTimeout(() => {}, 60000); });\n" + STALL);
        assert.equal(typeof instrument(spinSrc), "string");
        assert.equal(typeof instrument(stallSrc), "string");
        const d = mkdtempSync(join(tmpRoot, "h-"));
        const spinEng = join(d, "Signal.spin.js"), stallEng = join(d, "Signal.stall.js");
        writeFileSync(spinEng, spinSrc);
        writeFileSync(stallEng, stallSrc);
        const SHORT = { reportMs: 4000, usr2Ms: 1000, windowMs: 6000, hardMs: 15000 };
        const SENT = "b129-env-sentinel-0f3a";
        const [s, w] = await Promise.all([
            run(["--verify", "--engine", spinEng], { B129_SENTINEL: SENT }, SHORT),
            run(["--verify", "--engine", stallEng], { B129_SENTINEL: SENT }, SHORT),
        ]);
        for (const [n, r] of [["spin", s], ["stall", w]]) {
            const m = n + "\n" + r.diag;
            assert.equal(r.status, null, m);
            assert.equal(r.signal, "SIGKILL", m);
            assert.match(r.diag, /^wall \d+ ms, status null, signal SIGKILL\n/, m);
            assert.match(r.diag, /\nHANG: no exit after \d+ ms/, m);
            assert.equal(r.diag.includes("hard ceiling"), false, m);   // the diagnosis killed it, not the backstop
            assert.equal(r.diag.includes(SENT), false, m);
        }
        assert.match(s.diag, /\nno report 1000 ms after SIGUSR2 -- the event loop is not turning/, s.diag);
        assert.match(s.diag, /\ninspector: paused, \d+ frame\(s\)\n {4}requirePositiveInt /, s.diag);
        assert.match(s.diag, /\nreport appeared via the inspector\nreport: event=JavaScript API trigger=API\n/, s.diag);
        assert.match(s.diag, /\n {4}at requirePositiveInt \(file:/, s.diag);   // the report's javascriptStack
        assert.match(s.diag, /\n {2}libuv: /, s.diag);
        assert.match(w.diag, /\nreport appeared via SIGUSR2 \(the event loop still turns: an async stall\)\nreport: event=SIGUSR2 trigger=Signal\n/, w.diag);
        assert.match(w.diag, /\n {2}libuv: .*timer x\d/, w.diag);
        assert.equal(w.diag.includes("sent SIGUSR1"), false, w.diag);   // the inspector was not needed
    });
