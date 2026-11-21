/**
 * XG (b241 plan, b244 batch B2): the TurboFan + Maglev inlining DECISION multiset of the engine against the frozen build (D-b240-3).
 *
 * Oracle: .handoff/b241/PLAN-XG.md TASKS 3-5 (orchestrator notes ON-1..4 bind). Census: .handoff/b241/xg/CENSUS.txt (b244 TASK 0, node v26.8.2,
 * untimed, 2 runs per build x cell, A/A 0 in 16 / 16): fixture F = fixtures/Signal-29731ff9.js (== git show 2d2785d:Signal.js, the 9b83c52 engine)
 * with its Watch re-export line stripped (F == F-with-Watch.js-beside in 4 / 4 cells). The b240 finding: 1.6.0 lost 4 TurboFan decisions + 1 Maglev
 * decision vs 24ac539 (fixtures/Signal-da5ddb86.js), shipped per D-b240-3; this file stops any FURTHER loss. A lost decision fails; a gain is REPORTED.
 *
 * Drivers: hot118 = fixtures/bytecode-budget/hot-driver.mjs (test/118), effect = fixtures/inlining-decisions/effect-driver.mjs (the freq-1.0 audit
 * effect driver b240 used), each staged beside ONE build as ./driver.mjs. Flags: --no-concurrent-recompilation --single-threaded (test/122),
 * NODE_OPTIONS stripped, NODE_V8_COVERAGE unset, SIGKILL at 300000 ms. One node child at a time.
 * Keys: TurboFan `inlinee -> host` (+ " [try]" for "(inside try-block)"); Maglev = the normalised `greedy inlining` / `== Inlining` line
 * (call-frequency lines dropped). Name filter = the b240 OURS regex verbatim. Refusal lines (TF "Cannot consider", Maglev "cannot inline") are REPORTED.
 * Engine under test: ../Signal.js, or the absolute path in env XG_SIGNAL (a build with Watch.js beside it is staged with it). XG_PRINT=1 prints the
 * fixture literals for a re-cut (only on a PIN_NODE bump or a ruled recovery unit: new fixture named commit + sha, live lane green first).
 * Pins apply only on PIN_KEY (v26.8.2, ci.yml PIN_NODE); any other node prints REPORTED and skips the assertion (house rule of test/118 / test/122).
 * Row labels: PIN = measured fixture value; GATE = live vs fixture; A/A = run-to-run identity; MUST-FAIL = a control that must miss; REPORTED = printed.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PIN_KEY = "v26.8.2";
const PINNED = process.version === PIN_KEY;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ENGINE_PATH = process.env.XG_SIGNAL || here("../Signal.js");
if (process.env.XG_SIGNAL) console.log("# engine under test (XG_SIGNAL): " + ENGINE_PATH);
const FIXTURE_PATH = here("./fixtures/Signal-29731ff9.js"), HIST_PATH = here("./fixtures/Signal-da5ddb86.js");
const CI_PATH = here("../.github/workflows/ci.yml");
const DRV = { hot118: here("./fixtures/bytecode-budget/hot-driver.mjs"), effect: here("./fixtures/inlining-decisions/effect-driver.mjs") };
const CELLS = [["hot118", "turbo"], ["hot118", "maglev"], ["effect", "turbo"], ["effect", "maglev"]];
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';
const FLAGS = ["--no-concurrent-recompilation", "--single-threaded"];
const TIER = { turbo: "--trace-turbo-inlining", maglev: "--trace-maglev-inlining" };
const SPAWN = { encoding: "utf8", timeout: 300000, killSignal: "SIGKILL", maxBuffer: 1 << 28, env: { ...process.env, NODE_OPTIONS: "", NODE_V8_COVERAGE: undefined } };
// The pad control: F with executeEffect padded past the 460 B TurboFan inline cap (single-match anchor).
const PAD = "        let xgPad = 0;\n" + "        xgPad = (xgPad + 1) | 0;\n".repeat(40);
const ANCHOR = "    function executeEffect(node) {\n        if ((node.flags & FLAG_COMPUTING) !== 0) throwEffectCycle();\n";
const PAD_LEN = 733, CAP = 460;
// Maglev already refuses executeEffect (450 >= max-size 100), so the pad changes no Maglev decision at the default cap. At
// --max-maglev-inlined-bytecode-size=450 F inlines executeEffect and P (733) does not (census: 449 gives 0 losses, 450 gives 4 / 5).
const MAGLEV_PAD_FLAG = "--max-maglev-inlined-bytecode-size=450";

// Census literals (CENSUS.txt, node v26.8.2): the fixture's positive decisions per cell.
const PIN = {
    "hot118/turbo": {
        "(anon) -> batch [try]": 1, "(anon) -> executeEffect [try]": 1, "(anon) -> flushEffects [try]": 1, "batch -> step": 2,
        "effectTail -> executeEffect": 1, "effectTail -> flushEffects [try]": 1, "executeEffect -> flushEffects [try]": 1,
        "fireRecompute -> executeEffect [try]": 1, "fireRecompute -> flushEffects [try]": 1, "fireRecompute -> refreshComputed [try]": 1,
        "flushEffects -> read.set": 1, "markDownstream -> read.set": 1, "onCleanup -> (anon)": 2, "onCleanup -> executeEffect [try]": 2,
        "onCleanup -> flushEffects [try]": 2, "peekComputed -> step": 1, "pullMoved -> executeEffect": 1, "pullMoved -> flushEffects [try]": 1,
        "read -> (anon)": 3, "read -> executeEffect [try]": 1, "read -> step": 1, "rerunCleanupComputed -> refreshComputed": 1,
        "rerunCleanupComputed -> runCleanupC": 1, "runCleanup -> refreshComputed [try]": 1, "runCleanup -> rerunCleanupEffect [try]": 1,
        "runCleanup -> runCleanupC [try]": 1, "runCleanupC -> refreshComputed": 1, "runCleanupE -> executeEffect": 1,
        "runCleanupE -> flushEffects [try]": 1, "runOwnCleanup -> refreshComputed [try]": 1, "runOwnCleanup -> rerunCleanupEffect [try]": 1,
        "runOwnCleanup -> runCleanupC [try]": 1,
    },
    "hot118/maglev": {
        "== Inlining <SharedFunctionInfo batch>": 1, "== Inlining <SharedFunctionInfo onCleanup>": 5, "== Inlining <SharedFunctionInfo peekComputed>": 1,
        "== Inlining <SharedFunctionInfo pullComputed>": 1, "== Inlining <SharedFunctionInfo pullMoved>": 2, "== Inlining <SharedFunctionInfo runCleanup>": 2,
        "== Inlining <SharedFunctionInfo severTail>": 1, "greedy inlining {<SharedFunctionInfo batch>}: small function, skipping max-depth": 1,
        "greedy inlining {<SharedFunctionInfo onCleanup>}: small function, skipping max-depth": 2,
        "greedy inlining {<SharedFunctionInfo runCleanup>}: small function, skipping max-depth": 2,
    },
    "effect/turbo": {
        "(anon) -> flushEffects [try]": 1, "effectTail -> flushEffects [try]": 1, "executeEffect -> flushEffects [try]": 1,
        "fireRecompute -> flushEffects [try]": 1, "markDownstream -> drive": 1, "markDownstream -> read.set": 1, "read -> flushEffects [try]": 1,
        "read.set -> drive": 1, "runCleanupE -> flushEffects [try]": 1,
    },
    "effect/maglev": {
        "== Inlining <SharedFunctionInfo effectTail>": 1, "== Inlining <SharedFunctionInfo fireRecompute>": 1, "== Inlining <SharedFunctionInfo runCleanupE>": 1,
        "greedy inlining {<SharedFunctionInfo fireRecompute>}: small function, skipping max-depth": 1,
        "greedy inlining {<SharedFunctionInfo runCleanupE>}: small function, skipping max-depth": 1,
    },
};
const PIN_COUNT = { "hot118/turbo": 38, "hot118/maglev": 18, "effect/turbo": 9, "effect/maglev": 5 };
// b240 (inl-result.txt) re-measured by the census: da5ddb86 (24ac539) -> fixture loses exactly these 5 decisions.
const HIST_LOSSES = {
    "hot118/turbo": ["-1 read -> flushEffects [try]", "-1 rerunCleanupEffect -> executeEffect", "-1 runCleanup -> executeEffect [try]", "-1 runOwnCleanup -> executeEffect [try]"],
    "hot118/maglev": [],
    "effect/turbo": [],
    "effect/maglev": ["-1 greedy inlining {<SharedFunctionInfo effectTail>}: small function, skipping max-depth"],
};

// OURS = the b240 inl-diff.mjs regex verbatim.
const OURS = /SharedFunctionInfo (read|read\.set|executeEffect|flushEffects|effectTail|refreshComputed|rerunCleanup\w+|firstRunCleanup\w+|runCleanup\w*|runOwnCleanup|fireRecompute|pullMoved|pullComputed|peekComputed|markDownstream\w*|batch|onCleanup|severStale|severTail|unpinOwn|fixCursor|computedRunTail|allocateLink|freeLink)>/;
// The same name list, written out: the filter row pins OURS.source to it (a name dropped from OURS fails; ENGINEDROP).
const OURS_NAMES = ["read", "read\\.set", "executeEffect", "flushEffects", "effectTail", "refreshComputed", "rerunCleanup\\w+", "firstRunCleanup\\w+", "runCleanup\\w*",
    "runOwnCleanup", "fireRecompute", "pullMoved", "pullComputed", "peekComputed", "markDownstream\\w*", "batch", "onCleanup", "severStale", "severTail", "unpinOwn",
    "fixCursor", "computedRunTail", "allocateLink", "freeLink"];
const nm = (s) => { const m = /<SharedFunctionInfo ?([^>]*)>/.exec(s); return m ? (m[1] || "(anon)") : "?"; };
const mnorm = (s) => s.replace(/0x[0-9a-f]+/gi, "").replace(/\{ /g, "{").replace(/\([0-9.]+\)/g, "(N)").replace(/size \(N\)/g, "size(N)").replace(/\s+/g, " ").trim();
const mrnorm = (s) => s.replace(/0x[0-9a-f]+/gi, "").replace(/\{ /g, "{").replace(/\s+/g, " ").trim();
function parse(tn, out) {
    const pos = [], ref = [];
    for (const l of out.split("\n")) {
        if (!OURS.test(l)) continue;
        let m;
        if (tn === "turbo") {
            if ((m = /^Inlining (.*?) into (.*?)( \(inside try-block\))?$/.exec(l))) pos.push(nm(m[1]) + " -> " + nm(m[2]) + (m[3] ? " [try]" : ""));
            else if ((m = /^Cannot consider (.*?) for inlining \(reason: (.*)\)/.exec(l))) ref.push(nm(m[1]) + " : " + m[2]);
        } else if (!/call frequency/.test(l)) {
            if (/^\s*(greedy inlining|== Inlining)/.test(l)) pos.push(mnorm(l));
            else if (/^\s*cannot inline/.test(l)) ref.push(mrnorm(l));
        }
    }
    return { pos, ref };
}
const ms = (a) => { const m = new Map(); for (const x of a) m.set(x, (m.get(x) || 0) + 1); return m; };
function diff(a, b) { const A = ms(a), B = ms(b), r = []; for (const k of [...new Set([...A.keys(), ...B.keys()])].sort()) { const d = (B.get(k) || 0) - (A.get(k) || 0); if (d) r.push((d > 0 ? "+" : "") + d + " " + k); } return r; }
const losses = (from, to) => diff(from, to).filter((x) => x.startsWith("-"));
const gains = (from, to) => diff(from, to).filter((x) => x.startsWith("+"));
const lit = (a) => Object.fromEntries([...ms(a)].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
const floorOk = (pos) => pos.length >= 1;

const dirs = [];
function stage(buildPath, dn, src) {
    const dir = mkdtempSync(join(tmpdir(), "xg-inl-"));
    dirs.push(dir);
    if (src === undefined && existsSync(dirname(buildPath) + "/Watch.js")) { copyFileSync(buildPath, join(dir, "Signal.js")); copyFileSync(dirname(buildPath) + "/Watch.js", join(dir, "Watch.js")); }
    else {
        const parts = (src ?? readFileSync(buildPath, "utf8")).split(WATCH_LINE);
        assert.equal(parts.length, 2, "Watch re-export line matched " + (parts.length - 1) + " times");
        writeFileSync(join(dir, "Signal.js"), parts[0] + parts[1]);
    }
    copyFileSync(DRV[dn], join(dir, "driver.mjs"));
    return dir;
}
function trace(dir, tn, extra = []) {
    const r = spawnSync(process.execPath, [...FLAGS, TIER[tn], ...extra, "driver.mjs"], { ...SPAWN, cwd: dir });
    if (r.error) assert.fail("probe error: " + r.error.message);
    assert.equal(r.signal, null, "probe killed by " + r.signal);
    assert.equal(r.status, 0, String(r.stderr).slice(-300));
    return parse(tn, String(r.stdout));
}
function rawLen(dir) {
    const r = spawnSync(process.execPath, ["--print-bytecode", "--print-bytecode-filter=executeEffect", "driver.mjs"], { ...SPAWN, cwd: dir });
    if (r.error) assert.fail("raw probe error: " + r.error.message);
    assert.equal(r.status, 0, String(r.stderr).slice(-300));
    const out = String(r.stdout).split("\n"), lens = [];
    for (let i = 0; i < out.length; i++) if (/^\[generated bytecode for function: executeEffect \(/.test(out[i]))
        for (let j = i + 1; j < out.length && j < i + 12; j++) { const m = out[j].match(/^Bytecode length: (\d+)$/); if (m) { lens.push(Number(m[1])); break; } }
    return lens;
}
function gate(t, label, ok, detail) {
    if (!PINNED) { console.log("# REPORTED " + label + " on " + process.version + " (pins are " + PIN_KEY + " only): " + detail); return t.skip("REPORTED on " + process.version); }
    assert.ok(ok, label + ": " + detail);
}

const S = {};   // staged dirs per build / driver
const memo = new Map();
const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
const run = (b, dn, tn, extra) => once(b + "/" + dn + "/" + tn + (extra ? "/" + extra.join(",") : ""), () => trace(S[b + "/" + dn], tn, extra));
const lost = (b, dn, tn, ex) => losses(run("fix", dn, tn, ex).pos, run(b, dn, tn, ex).pos);
before(() => {
    const fsrc = readFileSync(FIXTURE_PATH, "utf8"), fparts = fsrc.split(WATCH_LINE);
    assert.equal(fparts.length, 2, "fixture Watch line count");
    const fstrip = fparts[0] + fparts[1], ap = fstrip.split(ANCHOR);
    assert.equal(ap.length, 2, "executeEffect pad anchor matched " + (ap.length - 1) + " times");
    const padded = ap[0] + ANCHOR + PAD + ap[1];
    for (const dn of Object.keys(DRV)) {
        S["live/" + dn] = stage(ENGINE_PATH, dn);
        S["fix/" + dn] = stage(FIXTURE_PATH, dn);
        S["hist/" + dn] = stage(HIST_PATH, dn);
        S["pad/" + dn] = stage(null, dn, padded + WATCH_LINE);
    }
});
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("fixture identity", () => {
    it("the vendored frozen build is 29731ff9 (git show 2d2785d:Signal.js); the historical control is da5ddb86 (24ac539)", () => {
        assert.equal(createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex").slice(0, 12), "29731ff9103a");
        assert.equal(createHash("sha256").update(readFileSync(HIST_PATH)).digest("hex").slice(0, 8), "da5ddb86");
    });
    it("[PIN] CI PIN_NODE equals the pin key " + PIN_KEY, () => {
        const m = readFileSync(CI_PATH, "utf8").match(/^\s*PIN_NODE:\s*'([^']+)'\s*$/m);
        assert.ok(m, "PIN_NODE not found in ci.yml");
        assert.equal("v" + m[1], PIN_KEY);
    });
});

describe("XG inlining decisions (D-b240-3, deterministic flags, sequential)", () => {
    for (const [dn, tn] of CELLS) {
        const cell = dn + "/" + tn;
        it("floor " + cell + ": the fixture trace has >= 1 positive decision line (else the parse or the filter is broken)", (t) => {
            const f = run("fix", dn, tn);
            if (tn === "maglev") return gate(t, cell + " floor", floorOk(f.pos), f.pos.length + " positive fixture lines");
            assert.ok(floorOk(f.pos), cell + ": 0 positive fixture lines");
        });
        it("[PIN] fixture " + cell + ": the positive decision multiset is the census literal (" + PIN_COUNT[cell] + " lines)", (t) => {
            const f = run("fix", dn, tn);
            if (process.env.XG_PRINT === "1") console.log("# XG_PRINT " + cell + " " + JSON.stringify(lit(f.pos)));
            gate(t, cell + " fixture multiset", JSON.stringify(lit(f.pos)) === JSON.stringify(lit(Object.entries(PIN[cell]).flatMap(([k, v]) => Array(v).fill(k)))) && f.pos.length === PIN_COUNT[cell],
                f.pos.length + " lines, diff vs census " + JSON.stringify(diff(Object.entries(PIN[cell]).flatMap(([k, v]) => Array(v).fill(k)), f.pos)));
        });
        it("[GATE] engine " + cell + ": loses no decision vs the fixture", (t) => {
            const lo = lost("live", dn, tn); gate(t, cell + " lost decisions", lo.length === 0, JSON.stringify(lo));
        });
        it("[A/A] engine " + cell + ": two runs give identical positive and refusal multisets", () => {
            const a = run("live", dn, tn), b = trace(S["live/" + dn], tn);
            assert.deepEqual(diff(a.pos, b.pos), []);
            assert.deepEqual(diff(a.ref, b.ref), []);
        });
        it("[REPORTED] engine " + cell + ": gains and refusal diffs vs the fixture", () => {
            const f = run("fix", dn, tn), l = run("live", dn, tn), g = gains(f.pos, l.pos), rd = diff(f.ref, l.ref);
            console.log("# REPORTED " + process.version + " " + cell + ": lost " + losses(f.pos, l.pos).length + ", gained " + g.length + ", refusal diffs " + rd.length);
            for (const x of [...g, ...rd.map((y) => "refusal " + y)]) console.log("#   " + x);
        });
    }
    // Every default-cap runOwnCleanup TurboFan decision also names an OURS host, so the cells alone cannot see runOwnCleanup leave the filter (b244 TASK 6:
    // ENGINEDROP survived them). The source pin catches any dropped name; the witness is the fixture's 2 Maglev runOwnCleanup inlines at the pad cap.
    it("[PIN] filter: OURS is the b240 name list verbatim, and the fixture hot118 Maglev trace at " + MAGLEV_PAD_FLAG + " keeps 2 '== Inlining runOwnCleanup' lines", (t) => {
        assert.equal(OURS.source, "SharedFunctionInfo (" + OURS_NAMES.join("|") + ")>");
        if (!PINNED) return gate(t, "runOwnCleanup witness", false, "the " + MAGLEV_PAD_FLAG + " child is spawned on " + PIN_KEY + " only");
        const n = run("fix", "hot118", "maglev", [MAGLEV_PAD_FLAG]).pos.filter((x) => x === "== Inlining <SharedFunctionInfo runOwnCleanup>").length;
        gate(t, "runOwnCleanup witness", n === 2, n + " line(s)");
    });
    it("[MUST-FAIL] historical: da5ddb86 (24ac539) -> fixture loses exactly the 5 b240 decisions (4 TurboFan in hot118, greedy effectTail in effect Maglev)", (t) => {
        const got = Object.fromEntries(CELLS.map(([dn, tn]) => [dn + "/" + tn, losses(run("hist", dn, tn).pos, run("fix", dn, tn).pos)]));
        gate(t, "historical losses", JSON.stringify(got) === JSON.stringify(HIST_LOSSES), JSON.stringify(got));
    });
    it("[MUST-FAIL] floor control: a trace with inlining disabled (--no-turbo-inlining / --no-maglev-inlining) fails the floor in every cell", (t) => {
        const ctl = (dn, tn) => {
            const off = trace(S["fix/" + dn], tn, [tn === "turbo" ? "--no-turbo-inlining" : "--no-maglev-inlining"]);
            assert.equal(floorOk(off.pos), false, dn + "/" + tn + ": inlining-off trace passed the floor (" + off.pos.length + " lines)");
        };
        for (const [dn, tn] of CELLS) if (tn === "turbo") ctl(dn, tn);
        if (!PINNED) return gate(t, "floor control Maglev cells", false, "the --no-maglev-inlining children are spawned on " + PIN_KEY + " only");
        for (const [dn, tn] of CELLS) if (tn === "maglev") ctl(dn, tn);
    });
    it("[MUST-FAIL] pad: executeEffect padded to " + PAD_LEN + " B (> " + CAP + "), the driver exits 0, and the gate sees >= 1 lost decision in every cell (TurboFan at the default caps, Maglev at " + MAGLEV_PAD_FLAG + " vs the fixture at the same flag)", (t) => {
        const lens = rawLen(S["pad/effect"]);
        assert.ok(lens.length >= 1 && lens.every((x) => x > CAP), "padded executeEffect lengths " + lens.join(","));
        const got = {};
        for (const [dn, tn] of CELLS) if (tn === "turbo") got[dn + "/" + tn] = lost("pad", dn, tn);
        if (!PINNED) return gate(t, "pad", false, "lengths " + lens.join(",") + " TurboFan losses " + JSON.stringify(got) + "; the " + MAGLEV_PAD_FLAG + " children are spawned on " + PIN_KEY + " only");
        for (const [dn, tn] of CELLS) if (tn === "maglev") got[dn + "/" + tn] = lost("pad", dn, tn, [MAGLEV_PAD_FLAG]);
        gate(t, "pad", lens.every((x) => x === PAD_LEN) && Object.values(got).every((l) => l.length >= 1), "lengths " + lens.join(",") + " losses " + JSON.stringify(got));
    });
});
