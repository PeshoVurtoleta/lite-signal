// bench/sweep.mjs -- the PROTOCOL. Turns the mirror into a toe-to-toe-grade sweep:
//
//  1. PER-ROW COLD-PROCESS ISOLATION (matches Andrii's runScenarioIsolated). Every
//     (engine, scenario) is measured in its OWN forked `node` process, so V8 never
//     carries inline caches / JIT state / heap from one row into another. This is the
//     inversion the roadmap called for (F4): the validator forks per row; now we do too.
//
//  2. ROUND-ROBIN REP SCHEDULING (F3). Instead of `for eng; for rep` -- which pins the
//     newest engine to the hottest chassis and faked the monotonic deepChain slowdown
//     across sha-identical engines -- each rep wave runs every combo once in a rotated
//     order, spreading thermal drift across all columns. (schedule.mjs' fix.)
//
//  3. SENTINEL DRIFT. The first-scheduled combo is re-measured dead last. If its time
//     disagrees with its first measurement by more than DRIFT_TOL, the host drifted
//     mid-sweep and the WHOLE sweep is marked suspect -- loudly, per toe-to-toe.
//
//  4. STAMP-CONSISTENT AGGREGATION (F2). Rows are grouped into <engine>-rep<N>.txt
//     files; collect.mjs refuses to merge them unless stamps agree (one engine hash,
//     one protocol, one host) and the file count matches the claimed reps. "Median of
//     10 over 5 files" cannot happen -- the aggregator counts.
//
//   node --expose-gc bench/sweep.mjs                 # full: all scenarios, REPS reps
//   QUICK=1 REPS=2 SUBSET=cheap node --expose-gc bench/sweep.mjs   # fast demo
//
// Engines: lite-signal always; alien-signals if installed. (Extend as adapters land.)

import { fork } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DYNAMIC_TESTS } from "./lib/mirror-config.mjs";
import { microRows } from "./lib/micro-suites.mjs";
import { parseStampFromText } from "./lib/stamp.mjs";
import { collectEngine } from "./lib/collect.mjs";
import * as G from "./lib/guards.mjs";
import { DRIFT_TOL, sentinelDrift } from "./lib/schedule.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIRROR = join(HERE, "mirror.mjs");
const QUICK = process.env.QUICK === "1";
const REPS = Number(process.env.REPS || (QUICK ? 2 : 10));
const RUN_DIR = join(HERE, "mirror-runs");

// scenario selection: full list, or a cheap subset for demos
const CHEAP = new Set(["pure pull", "linear chain - 1 source - pull (linear pull)", "wide tree - 8 sources - pull (branchy pull)", "stable diamond mesh warm"]);
const scenarioNames = process.env.SUBSET === "cheap"
    ? DYNAMIC_TESTS.filter((t) => CHEAP.has(t.name)).map((t) => t.name)
    : [...DYNAMIC_TESTS.map((t) => t.name), ...microRows().map((r) => r.name)];  // full 47-row field

const ENGINES = ["lite-signal", "alien-signals"];

// --- fork one (engine, scenario) row in its own cold process -------------------------
function runRow(engine, scenario) {
    return new Promise((resolve) => {
        const child = fork(MIRROR, [], {
            env: { ...process.env, FW: engine, SCENARIO: scenario, ROWS_ONLY: "1", QUICK: QUICK ? "1" : "" },
            execArgv: [...process.execArgv.filter((a) => a !== "--expose-gc"), "--expose-gc"],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let out = "", err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("exit", (code) => resolve({ code, out, err }));
    });
}

// parse a child's stdout: #STAMP line + one data row (+ optional #GUARD lines)
function parseChild(out) {
    const stamp = parseStampFromText(out);
    let row = null; const guards = [];
    for (const line of out.split(/\r?\n/)) {
        if (line.startsWith("#GUARD ")) guards.push(line.slice(7));
        else if (!line.startsWith("#") && line.includes(" , ")) row = line;
    }
    return { stamp, row, guards };
}

// --- build the round-robin schedule of (engine, scenario) combos across reps ---------
function buildSweep() {
    const combos = [];
    for (const e of ENGINES) for (const s of scenarioNames) combos.push({ engine: e, scenario: s });
    const steps = [];
    for (let wave = 0; wave < REPS; wave++) {
        // rotate combo order each wave so no combo is pinned to the hot (last) slot
        const rot = wave % combos.length;
        for (let k = 0; k < combos.length; k++) {
            const c = combos[(rot + k) % combos.length];
            steps.push({ ...c, rep: wave + 1 });
        }
    }
    return { combos, steps };
}

async function main() {
    if (existsSync(RUN_DIR)) rmSync(RUN_DIR, { recursive: true, force: true });
    mkdirSync(RUN_DIR, { recursive: true });

    const { combos, steps } = buildSweep();
    console.log(`sweep: ${ENGINES.length} engine(s) x ${scenarioNames.length} scenario(s) x ${REPS} rep(s) = ${steps.length} cold processes`);
    console.log(`protocol: isolated-per-row, round-robin, sentinel drift @ ${(DRIFT_TOL * 100).toFixed(0)}%\n`);

    const verdict = G.makeVerdict();
    const stampByFile = new Map();   // engine-rep -> stamp (written once)
    const firstCombo = combos[0];
    let firstTime = null, sentinelTime = null;

    // helper to append a row to <engine>-rep<N>.txt, writing the stamp header once
    const writeRow = (engine, rep, stamp, row) => {
        const path = join(RUN_DIR, `${engine}-rep${rep}.txt`);
        const key = `${engine}-rep${rep}`;
        if (!stampByFile.has(key)) {
            writeFileSync(path, "#STAMP " + JSON.stringify(stamp) + "\nframework , test , time , metrics\n");
            stampByFile.set(key, stamp);
        }
        appendFileSync(path, row + "\n");
    };
    const timeOf = (row) => parseFloat(row.split(" , ")[2]);

    let done = 0;
    for (const step of steps) {
        const { code, out, err } = await runRow(step.engine, step.scenario);
        const { stamp, row, guards } = parseChild(out);
        done++;
        if (!row || !stamp) {
            G.makeVerdict(); verdict.ok = false;
            verdict.failures.push(`${step.engine}/${step.scenario} rep${step.rep}: no row/stamp (exit ${code}). stderr: ${(err || "").split("\n")[0]}`);
            continue;
        }
        for (const g of guards) { verdict.ok = false; verdict.failures.push(`${step.engine}/${step.scenario}: ${g}`); }
        writeRow(step.engine, step.rep, stamp, row);
        // capture first-combo baseline for the sentinel
        if (step.rep === 1 && step.engine === firstCombo.engine && step.scenario === firstCombo.scenario && firstTime === null) {
            firstTime = timeOf(row);
        }
        process.stdout.write(`\r  ${done}/${steps.length} rows measured`);
    }

    // --- sentinel: re-measure the first combo dead last ---
    process.stdout.write("\r" + " ".repeat(40) + "\r");
    const sent = await runRow(firstCombo.engine, firstCombo.scenario);
    const sp = parseChild(sent.out);
    if (sp.row) {
        sentinelTime = timeOf(sp.row);
        const d = sentinelDrift(firstTime, sentinelTime);
        console.log(`sentinel: ${firstCombo.engine}/${firstCombo.scenario}  first=${firstTime?.toFixed(2)}ms  last=${sentinelTime.toFixed(2)}ms  ratio=${d.ratio.toFixed(3)}x  ${d.drifted ? "<-- DRIFTED, sweep suspect" : "(stable)"}`);
        if (d.drifted) { verdict.ok = false; verdict.failures.push(`SENTINEL DRIFT: host moved ${((d.ratio - 1) * 100).toFixed(1)}% mid-sweep (> ${(DRIFT_TOL * 100).toFixed(0)}% tol); the whole sweep is thermally suspect`); }
    }

    // --- aggregate with stamp + rep-count guards, then emit the table ---
    console.log("");
    const rowParser = (text) => {
        const m = new Map();
        for (const line of text.split(/\r?\n/)) {
            if (line.startsWith("#") || !line.includes(" , ")) continue;
            const p = line.split(" , ").map((s) => s.trim());
            if (p.length >= 3 && p[0] !== "framework" && Number.isFinite(parseFloat(p[2]))) m.set(p[1], parseFloat(p[2]));
        }
        return m;
    };
    const perEngine = {};
    for (const e of ENGINES) {
        const c = collectEngine(RUN_DIR, e, REPS, rowParser);
        if (!c.ok) { verdict.ok = false; verdict.failures.push(`aggregate ${e}: ${c.reason}`); continue; }
        perEngine[e] = c;
    }

    if (perEngine["lite-signal"] && perEngine["alien-signals"]) {
        const lite = perEngine["lite-signal"], alien = perEngine["alien-signals"];
        console.log(`aggregated: protocol=${lite.protocol}  reps=${lite.reps}  engineSha=${lite.engineSha.slice(0, 12)}\n`);
        console.log("test".padEnd(52) + "lite".padStart(9) + "alien".padStart(9) + "  lite vs alien".padEnd(17) + "spread");
        console.log("-".repeat(100));
        // per-shape spread flag: the single-shape sentinel does not guard per-row variance
        // on the heavy shapes (burst/layered swing ~15% run-to-run). SPREAD_WARN marks any
        // row whose worst-engine (max-min)/median across reps exceeds the threshold, so a
        // high-variance row can never be published as a point number by accident.
        const SPREAD_WARN = Number(process.env.SPREAD_WARN || 8);   // % ; host-calibratable
        const noisy = [];
        for (const test of lite.perTest.keys()) {
            const l = lite.perTest.get(test), a = alien.perTest.get(test);
            if (a == null) continue;
            const d = (a - l) / a * 100;
            const sp = Math.max(lite.perTestSpread.get(test) ?? 0, alien.perTestSpread.get(test) ?? 0);
            const spStr = sp.toFixed(0) + "%" + (sp > SPREAD_WARN ? " !!" : "");
            if (sp > SPREAD_WARN) noisy.push({ test, sp });
            console.log(test.slice(0, 50).padEnd(52) + l.toFixed(2).padStart(9) + a.toFixed(2).padStart(9) + `   ${d >= 0 ? "+" : ""}${d.toFixed(1)}% ${l < a ? "lite" : "alien"}`.padEnd(17) + "  " + spStr);
        }
        console.log("-".repeat(100));
        if (noisy.length) {
            noisy.sort((x, y) => y.sp - x.sp);
            console.log(`\n${noisy.length} row(s) exceed ${SPREAD_WARN}% run-to-run spread -- treat as a band, not a point, or add reps:`);
            for (const n of noisy) console.log(`  ${n.test.slice(0, 54).padEnd(56)} ${n.sp.toFixed(0)}%`);
            console.log("(the sentinel guards ONE shape; these rows have their own per-shape variance.)");
        }
    }

    if (!G.reportVerdict(verdict)) return;
    console.log("\nsweep OK -- stamp-consistent, rep count verified, sentinel stable. Numbers are publishable.");
}

main();
