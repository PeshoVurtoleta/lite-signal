// G1 microscope guards -- aggregate.mjs fixtures (A3) + run-all-bench.sh runner (A4).
// A3 golden: test/fixtures/g1-aggregate/golden-time-cells.json was cut by running the FROZEN OLD
// aggregate (252942e / 9bf7c2a4) on the fixture:
//   cd test/fixtures/g1-aggregate && node <old aggregate beside frameworks.mjs + lib/> --reps 3
// and medians re-derived by hand (e.g. KAIROS lite [10,12,11] -> 11.00ms).
// The runner never writes under the real bench/: it runs in a tmp copy with a stub benchmark.mjs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { makeRepText } from "./fixtures/g1-aggregate/rep-text.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const FIX = join(here, "fixtures", "g1-aggregate");
const KEYS = ["lite-signal", "alien-signals", "preact", "solid", "reflex-quant"];   // bench/frameworks.mjs ENGINE_KEYS (checked below)
const tmps = [];
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("fixture keys match bench/frameworks.mjs ENGINE_KEYS", async () => {
    const F = await import(join(ROOT, "bench", "frameworks.mjs"));
    assert.deepEqual(F.ENGINE_KEYS, KEYS);
});

// ---------------- A3 ----------------
const GOLD = JSON.parse(readFileSync(join(FIX, "golden-time-cells.json"), "utf8"));
const SCENARIOS = Object.keys(GOLD.rows);

function fixtureDir(mutate) {
    const d = mk("g1-agg-");
    cpSync(join(FIX, "bench-runs"), join(d, "bench-runs"), { recursive: true });
    if (mutate) mutate(join(d, "bench-runs"));
    return join(d, "bench-runs");
}
function agg(dir, extra) {
    const r = spawnSync(process.execPath, [join(ROOT, "bench", "aggregate.mjs"), "--dir", dir, ...(extra || [])],
        { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", cwd: dirname(dir) });
    assert.equal(r.signal, null, "aggregate killed: " + r.signal);
    return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
}
const rd = (d, n) => readFileSync(join(d, n), "utf8");
const wr = (d, n, t) => writeFileSync(join(d, n), t);
const editStamp = (d, name, fn) => {
    const t = rd(d, name);
    const i = t.split("\n").findIndex((l) => l.startsWith("#STAMP "));
    const lines = t.split("\n");
    const s = JSON.parse(lines[i].slice(7)); fn(s); lines[i] = "#STAMP " + JSON.stringify(s);
    wr(d, name, lines.join("\n"));
};
const TIMES = (lib) => [1, 2, 3, 4, 5, 6].map((x) => x + (lib === "lite-signal" ? 0 : 0.5));

test("A3 good fixture (2 engines x 3 reps): exit 0, time cells == golden, header 3 tokens, no heap %", () => {
    for (const extra of [[], ["--reps", "3"]]) {
        const r = agg(fixtureDir(), extra);
        assert.equal(r.status, 0, r.err + r.out.slice(0, 400));
        const lines = r.out.split("\n");
        const hdr = lines.find((l) => l.startsWith("scenario"));
        assert.ok(hdr, "no header line");
        assert.deepEqual(hdr.trim().split(/\s{2,}/), ["scenario", ...GOLD.columns]);
        for (const sc of SCENARIOS) {
            const row = lines.find((l) => l.startsWith(sc + " "));
            assert.ok(row, "row missing: " + sc);
            assert.deepEqual(row.trim().split(/\s{2,}/), [sc, ...GOLD.rows[sc]], sc);
        }
        assert.equal((r.out.match(/heap [+-]\d/g) || []).length, 0);
    }
});

// the 8 T6 refusal cases + one tooth per stamp member of the union check
const REFUSE = {
    "COMPLETE absent": (d) => rmSync(join(d, "COMPLETE")),
    "a rep has sink=[ ]": (d) => wr(d, "alien-signals-rep2.txt", rd(d, "alien-signals-rep2.txt").replace("sink=[x]", "sink=[ ]")),
    "a rep has INVALID RUN": (d) => wr(d, "lite-signal-rep1.txt", makeRepText({ lib: "lite-signal", times: TIMES("lite-signal"), invalid: true })),
    "a rep has fewer than 6 scenario rows": (d) => wr(d, "lite-signal-rep3.txt", makeRepText({ lib: "lite-signal", times: TIMES("lite-signal"), dropRows: 1 })),
    "per-engine rep counts unequal": (d) => rmSync(join(d, "alien-signals-rep3.txt")),
    "rep count differs from COMPLETE.reps": (d) => wr(d, "COMPLETE", rd(d, "COMPLETE").replace('"reps":3', '"reps":4')),
    "rep count differs from --reps": null,   // run with --reps 4, see below
    "cross-engine harnessSha256 mismatch": (d) => { for (let i = 1; i <= 3; i++) editStamp(d, "alien-signals-rep" + i + ".txt", (s) => { s.harnessSha256 = "c".repeat(64); }); },
    "cross-engine extra mismatch": (d) => { for (let i = 1; i <= 3; i++) editStamp(d, "alien-signals-rep" + i + ".txt", (s) => { s.extra = { warmup: 2, iterations: 65 }; }); },
    "cross-engine engineSha256 mismatch": (d) => { for (let i = 1; i <= 3; i++) editStamp(d, "alien-signals-rep" + i + ".txt", (s) => { s.engineSha256 = "d".repeat(64); }); },
    "cross-engine protocol mismatch": (d) => { for (let i = 1; i <= 3; i++) editStamp(d, "alien-signals-rep" + i + ".txt", (s) => { s.protocol = "isolated-per-row"; }); },
    "cross-engine host mismatch": (d) => { for (let i = 1; i <= 3; i++) editStamp(d, "alien-signals-rep" + i + ".txt", (s) => { s.cpu = "Other CPU"; }); },
    "per-engine mixed harnessSha256 (one rep)": (d) => editStamp(d, "lite-signal-rep2.txt", (s) => { s.harnessSha256 = "e".repeat(64); }),
};
for (const [name, mut] of Object.entries(REFUSE)) {
    test("A3 refusal: " + name + " -> exit 1, REFUSING, no table", () => {
        const dir = fixtureDir(mut || undefined);
        const r = agg(dir, name.includes("--reps") ? ["--reps", "4"] : []);
        assert.equal(r.status, 1, r.err + r.out.slice(0, 300));
        assert.ok((r.err + r.out).includes("REFUSING"), "no REFUSING: " + r.err.slice(0, 300));
        assert.ok(!/KAIROS\s+\d/.test(r.out), "a table was printed despite the refusal");
        assert.ok(!(r.err + r.out).includes("    at "), "stack trace leaked");
    });
}
test("A3 missing --dir -> exit 2, no stack trace", () => {
    const d = mk("g1-agg-none-");
    const r = agg(join(d, "does-not-exist"));
    assert.equal(r.status, 2, r.err.slice(0, 300));
    assert.ok(!(r.err + r.out).includes("    at "), "stack trace leaked: " + r.err.slice(0, 300));
});

// ---------------- A4 (runner) ----------------
const STUB = `// stub benchmark.mjs: writes a valid rep; STUB_FAIL="<engine>:<n>" exits 1 at that engine's n-th call.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const { makeRepText } = await import(${JSON.stringify(pathToFileURL(join(FIX, "rep-text.mjs")).href)});
const fw = process.env.FW;
const cf = join(process.env.STUB_DIR, "count-" + fw);
const n = (existsSync(cf) ? Number(readFileSync(cf, "utf8")) : 0) + 1;
writeFileSync(cf, String(n));
process.stderr.write("stub-stderr-line\\n");
if (process.env.STUB_FAIL === fw + ":" + n) { process.stdout.write("half a rep\\n"); process.exit(1); }
process.stdout.write(makeRepText({ lib: fw, times: [1, 2, 3, 4, 5, 6] }));
`;
function runnerTree() {
    const d = mk("g1-run-");
    mkdirSync(join(d, "bench")); mkdirSync(join(d, "stub"));
    for (const f of ["frameworks.mjs", "package.json", "run-all-bench.sh"]) cpSync(join(ROOT, "bench", f), join(d, "bench", f));
    cpSync(join(ROOT, "bench", "lib"), join(d, "bench", "lib"), { recursive: true });
    writeFileSync(join(d, "bench", "benchmark.mjs"), STUB);
    return d;
}
function runner(d, env) {
    const e = { ...process.env, STUB_DIR: join(d, "stub") }; delete e.REPS; delete e.STUB_FAIL;
    Object.assign(e, env);
    const r = spawnSync("bash", [join(d, "bench", "run-all-bench.sh")], { encoding: "utf8", timeout: 180000, killSignal: "SIGKILL", env: e });
    assert.equal(r.signal, null, "runner killed: " + r.signal);
    return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
}
const runs = (d) => join(d, "bench", "bench-runs");
const listing = (d) => existsSync(runs(d)) ? readdirSync(runs(d)).sort().map((n) => n + " " + sha(readFileSync(join(runs(d), n)))) : [];
const stubCalls = (d) => readdirSync(join(d, "stub")).sort();

test("A4 REPS=2: 10 reps + COMPLETE, 0 .partial, 0 .tmp, stdout only, COMPLETE content", () => {
    const d = runnerTree();
    const r = runner(d, { REPS: "2" });
    assert.equal(r.status, 0, r.err + r.out.slice(-300));
    const names = readdirSync(runs(d)).sort();
    const expectReps = KEYS.flatMap((k) => [1, 2].map((n) => k + "-rep" + n + ".txt"));
    assert.deepEqual(names, [...expectReps, "COMPLETE"].sort());
    assert.equal(names.filter((n) => n.endsWith(".partial")).length, 0);
    assert.equal(names.filter((n) => n.endsWith(".tmp")).length, 0);
    for (const n of expectReps) {
        const t = rd(runs(d), n);
        assert.ok(t.includes("#STAMP "), n); assert.ok(!t.includes("stub-stderr-line"), n + " captured stderr");
    }
    const c = JSON.parse(rd(runs(d), "COMPLETE"));
    assert.equal(c.kind, "bench-capture-complete/v1"); assert.equal(c.writer, "run-all-bench.sh");
    assert.equal(c.protocol, "isolated-per-engine"); assert.equal(c.reps, 2); assert.deepEqual(c.engines, KEYS);
});
test("A4 re-invocation refuses (exit 2) three times and leaves the capture byte-identical", () => {
    const d = runnerTree();
    assert.equal(runner(d, { REPS: "2" }).status, 0);
    const before = listing(d), calls = stubCalls(d);
    assert.equal(before.length, 11);
    for (const reps of ["2", "1", "3"]) {
        const r = runner(d, { REPS: reps });
        assert.equal(r.status, 2, "REPS=" + reps + ": " + r.err.slice(0, 300));
        assert.deepEqual(listing(d), before, "capture changed after REPS=" + reps);
        assert.deepEqual(stubCalls(d), calls, "stub ran despite the refusal");
    }
});
test("A4 refuses when only COMPLETE exists, or only a .partial exists (exit 2, no stub call)", () => {
    for (const fname of ["COMPLETE", "lite-signal-rep1.txt.partial"]) {
        const d = runnerTree();
        mkdirSync(runs(d)); writeFileSync(join(runs(d), fname), "x\n");
        const r = runner(d, { REPS: "2" });
        assert.equal(r.status, 2, fname + ": " + r.err.slice(0, 200));
        assert.deepEqual(readdirSync(runs(d)), [fname]); assert.deepEqual(stubCalls(d), []);
    }
});
test("A4 stub exit 1 at alien rep 1: .partial left, no COMPLETE, runner exit 1", () => {
    const d = runnerTree();
    const r = runner(d, { REPS: "2", STUB_FAIL: "alien-signals:1" });
    assert.equal(r.status, 1, r.err.slice(0, 300));
    const names = readdirSync(runs(d));
    assert.ok(names.includes("alien-signals-rep1.txt.partial"));
    assert.ok(!names.includes("alien-signals-rep1.txt"));
    assert.ok(!names.includes("COMPLETE")); assert.ok(!names.includes("COMPLETE.tmp"));
});
for (const reps of ["0", "abc", "-1", "1.5", "01", "2 "]) {
    test("A4 REPS=" + JSON.stringify(reps) + " -> exit 2, 0 files created, stub never called", () => {
        const d = runnerTree();
        const r = runner(d, { REPS: reps });
        assert.equal(r.status, 2, r.err.slice(0, 300));
        assert.deepEqual(listing(d), []); assert.deepEqual(stubCalls(d), []);
    });
}

// ---------------- B2 r1 teeth: one row per widened-rule member ----------------
const allReps = (eng, fn) => (d) => { for (let i = 1; i <= 3; i++) fn(d, eng + "-rep" + i + ".txt"); };
const stampAll = (fn) => (d) => { for (const e of ["lite-signal", "alien-signals"]) allReps(e, (dd, n) => editStamp(dd, n, fn))(d); };
const completeEdit = (fn) => (d) => { const c = JSON.parse(rd(d, "COMPLETE")); fn(c); wr(d, "COMPLETE", JSON.stringify(c) + "\n"); };
const TEETH = {
    "every rep protocol isolated-per-row": [stampAll((s) => { s.protocol = "isolated-per-row"; })],
    "every rep protocol UNSET": [stampAll((s) => { s.protocol = "UNSET"; })],
    "every rep harnessSha256 null": [stampAll((s) => { s.harnessSha256 = null; })],
    "every rep engineSha256 null": [stampAll((s) => { s.engineSha256 = null; })],
    "every rep gcExposed false": [stampAll((s) => { s.gcExposed = false; })],
    "one rep gcExposed false": [(d) => editStamp(d, "alien-signals-rep2.txt", (s) => { s.gcExposed = false; })],
    "COMPLETE kind wrong": [completeEdit((c) => { c.kind = "bench-capture-complete/v0"; })],
    "COMPLETE protocol wrong": [completeEdit((c) => { c.protocol = "isolated-per-row"; })],
    "COMPLETE writer run-all-mirror.sh": [completeEdit((c) => { c.writer = "run-all-mirror.sh"; })],
    "COMPLETE not JSON": [(d) => wr(d, "COMPLETE", "this is not json\n")],
    "leftover lite-signal-rep2.txt.partial": [(d) => wr(d, "lite-signal-rep2.txt.partial", "half\n")],
    "a rep of an engine COMPLETE does not list": [(d) => { for (let i = 1; i <= 3; i++) wr(d, "preact-rep" + i + ".txt", rd(d, "alien-signals-rep" + i + ".txt")); }],
    "rep numbers 1,2,4": [(d) => { cpSync(join(d, "lite-signal-rep3.txt"), join(d, "lite-signal-rep4.txt")); rmSync(join(d, "lite-signal-rep3.txt")); }],
    "an own row printed for another engine": [(d) => wr(d, "lite-signal-rep2.txt", rd(d, "lite-signal-rep2.txt").replace("lite-signal         median=", "alien-signals       median="))],
    "own row sink=[x?]": [(d) => wr(d, "alien-signals-rep1.txt", rd(d, "alien-signals-rep1.txt").replace("sink=[x]", "sink=[x?]"))],
    "duplicate own scenario row (second KAIROS block, median 0.01ms)": [(d) => {
        const t = rd(d, "lite-signal-rep1.txt");
        const blockStart = t.indexOf("-".repeat(98) + "\nKAIROS");
        const blockEnd = t.indexOf("-".repeat(98) + "\nBROADCAST");
        const blk = t.slice(blockStart, blockEnd).replace(/median=\s*[\d.]+ms/, "median=    0.01ms");
        wr(d, "lite-signal-rep1.txt", t.slice(0, blockEnd) + blk + t.slice(blockEnd));
    }],
    "two #STAMP lines in one rep": [(d) => { const t = rd(d, "lite-signal-rep3.txt"); const l = t.split("\n").find((x) => x.startsWith("#STAMP ")); wr(d, "lite-signal-rep3.txt", t.replace(l, l + "\n" + l)); }],
    "leftover COMPLETE.tmp": [(d) => wr(d, "COMPLETE.tmp", "{}\n")],
    "surplus lite-signal-rep4.txt beyond COMPLETE.reps=3": [(d) => cpSync(join(d, "lite-signal-rep3.txt"), join(d, "lite-signal-rep4.txt"))],
    "file named lite-signal-rep01.txt": [(d) => cpSync(join(d, "lite-signal-rep1.txt"), join(d, "lite-signal-rep01.txt"))],
    "a directory named lite-signal-rep3.txt": [(d) => { rmSync(join(d, "lite-signal-rep3.txt")); mkdirSync(join(d, "lite-signal-rep3.txt")); }],
};
for (const [name, [mut]] of Object.entries(TEETH)) {
    test("B2-r1 refusal: " + name + " -> exit 1, REFUSING, no stack", () => {
        const r = agg(fixtureDir(mut));
        assert.equal(r.status, 1, r.err.slice(0, 300) + r.out.slice(0, 200));
        assert.ok((r.err + r.out).includes("REFUSING"), "no REFUSING: " + r.err.slice(0, 300));
        assert.ok(!(r.err + r.out).includes("    at "), "stack trace leaked: " + r.err.slice(0, 300));
        assert.ok(!/KAIROS\s+\d/.test(r.out), "a table was printed");
    });
}
test("B2-r1: alien median 0 -> exit 0, that row reads 'time n/a', no Infinity/NaN", () => {
    const r = agg(fixtureDir((d) => {
        for (let i = 1; i <= 3; i++) wr(d, "alien-signals-rep" + i + ".txt", rd(d, "alien-signals-rep" + i + ".txt").replace(/median=\s*[\d.]+ms/, "median=    0.00ms"));
    }));
    assert.equal(r.status, 0, r.err.slice(0, 300));
    const row = r.out.split("\n").find((l) => /^\s+KAIROS\s+time /.test(l));
    assert.ok(row, "no KAIROS vs-row:\n" + r.out);
    assert.ok(/^\s+KAIROS\s+time n\/a/.test(row), row);
    assert.ok(!/Infinity|NaN/.test(r.out));
});
