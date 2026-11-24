// bench/sweep.mjs -- the PROTOCOL. Turns the mirror into a toe-to-toe-grade sweep:
//
//  1. PER-ROW COLD-PROCESS ISOLATION (matches Andrii's runScenarioIsolated). Every
//     (engine, scenario) is measured in its OWN forked `node` process, so V8 never
//     carries inline caches / JIT state / heap from one row into another. This is the
//     inversion the roadmap called for (F4): the validator forks per row; now we do too.
//
//  2. SCENARIO-MAJOR WILLIAMS SCHEDULING (F3, M8). Instead of `for eng; for rep` -- which
//     pins the newest engine to the hottest chassis and faked the monotonic deepChain
//     slowdown across sha-identical engines -- each rep wave runs every (engine, scenario)
//     once, scenario by scenario: a scenario's engines run back to back as one block, and
//     the engine order inside a block cycles through a Williams design (every position and
//     every ordered engine pair equally often), so a drifting host never biases one whole
//     engine. Scenario order rotates between waves. (schedule.mjs buildScenarioMajor.)
//
//  3. SENTINEL DRIFT. The first-scheduled combo is re-measured dead last and compared with
//     the MEDIAN of its REPS first-pass reps (D-b254-1; schedule.mjs sentinelBaseline) --
//     the statistic the sweep publishes, not its rep-1 time alone (b253: one fast or slow
//     first process flagged two clean captures). If the re-measure disagrees with that
//     median by more than DRIFT_TOL, the host drifted mid-sweep and the WHOLE sweep is
//     marked suspect -- loudly, per toe-to-toe. All REPS first-combo times must be present,
//     finite and > 0, else drift is unmeasured (a guard failure). The child sequence is
//     unchanged (no warm-up child). Cost: a linear drift D across the sweep shows as ~D/2
//     against the median at REPS=10 (b254 review, full 47 rows: 0.49D at REPS 10, 0.62D at
//     REPS 2, 0.43D at REPS 3); at REPS=2 the median is the mean of the two reps.
//
//  4. STAMP-CONSISTENT AGGREGATION (F2). Rows are grouped into <engine>-rep<N>.txt
//     files; collect.mjs refuses to merge them unless stamps agree (one engine hash,
//     one protocol, one host), the file count matches the claimed reps and every row is
//     in every rep. "Median of 10 over 5 files" cannot happen -- the aggregator counts.
//     Then lib/rowcheck.mjs re-checks the files across engines (b251 M7 / M16): counters
//     equal across reps, edgesTraversed / sum / checksum equal across engines, one host /
//     node / harness / engine / protocol / config / adapter, and this capture's id in every
//     stamp. A refusal is a guard failure (exit 1, no COMPLETE).
//
// Every sweep generates a fresh CAPTURE_ID (an inherited CAPTURE_ID is overridden), passes
// it to every child (mirror.mjs stamps it) and writes it into COMPLETE; report.mjs refuses
// a stamp whose captureId differs from the marker's. A rep file keeps only its first
// child's stamp, so EVERY child's stamp (and the sentinel's) is checked as it arrives: well
// formed, this CAPTURE_ID, and equal to the first accepted child's on host / node / shas /
// protocol / config / adapter / quick; a mismatch is a guard failure and the row is dropped.
//
//   node --expose-gc bench/sweep.mjs                 # full: all scenarios, REPS reps
//   QUICK=1 REPS=2 SUBSET=cheap node --expose-gc bench/sweep.mjs   # fast demo
//
// SWEEP_DIR=<dir> (default bench/sweep-runs/; a relative path resolves against the cwd)
// receives <engine>-rep<N>.txt. If ANY *-rep*.txt is already there the sweep exits 2
// before the first fork: it never deletes or overwrites a capture (copy it aside first).
// SWEEP_TIMEOUT_MS=<ms> (integer 1..2^31-1, default 120000, nominal) bounds each child:
// on expiry the child is killed with SIGKILL (a SIGTERM can be trapped), the row is
// recorded as a failure and the sweep exits non-zero at the end.
// A bad DRIFT_TOL or REPS exits 2 before the first fork (DRIFT_TOL is validated when
// schedule.mjs loads, so the sweep loads it dynamically and turns the throw into exit 2).
// Only a clean verdict (exit 0) writes <dir>/COMPLETE (protocol, reps, engines, captureId; tmp +
// rename) as the LAST step; report.mjs refuses a dir without it, and the sweep refuses
// to start where one exists (D-b187-4).
//
// Engines: lite-signal always; alien-signals and reflex-quant if installed. (Extend as adapters land.)

import { fork } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { DYNAMIC_TESTS } from "./lib/mirror-config.mjs";
import { microRows } from "./lib/micro-suites.mjs";
import { parseStampFromText } from "./lib/stamp.mjs";
import { collectEngine } from "./lib/collect.mjs";
import * as G from "./lib/guards.mjs";
import { checkCapture, makeChildStampGuard, makeCaptureId } from "./lib/rowcheck.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIRROR = join(HERE, "mirror.mjs");
const QUICK = process.env.QUICK === "1";
const REPS = Number(process.env.REPS || (QUICK ? 2 : 10));
const SWEEP_DIR = process.env.SWEEP_DIR;
if (SWEEP_DIR === "") { console.error("sweep: SWEEP_DIR is set but empty"); process.exit(2); }
const RUN_DIR = SWEEP_DIR === undefined ? join(HERE, "sweep-runs") : resolvePath(SWEEP_DIR);
// per-child timeout (ms): unset -> default; anything but an integer 1..2^31-1 -> exit 2
const TIMEOUT_RAW = process.env.SWEEP_TIMEOUT_MS;
const CHILD_TIMEOUT_MS = TIMEOUT_RAW === undefined ? 120000 : (/^[1-9][0-9]*$/.test(TIMEOUT_RAW) ? Number(TIMEOUT_RAW) : NaN);
if (!(CHILD_TIMEOUT_MS <= 2147483647)) {
    console.error(`sweep: SWEEP_TIMEOUT_MS must be an integer 1..2147483647 (got "${TIMEOUT_RAW}")`);
    process.exit(2);
}

// scenario selection: full list, or a cheap subset for demos
const CHEAP = new Set(["pure pull", "linear chain - 1 source - pull (linear pull)", "wide tree - 8 sources - pull (branchy pull)", "stable diamond mesh warm"]);
const scenarioNames = process.env.SUBSET === "cheap"
    ? DYNAMIC_TESTS.filter((t) => CHEAP.has(t.name)).map((t) => t.name)
    : [...DYNAMIC_TESTS.map((t) => t.name), ...microRows().map((r) => r.name)];  // full 47-row field

const ENGINES = ["lite-signal", "alien-signals", "reflex-quant"];
// one id per capture: UTC second + 8 random hex digits (rowcheck CAPTURE_ID_RE, the same
// format run-all-mirror.sh writes); every child stamps it
const CAPTURE_ID = makeCaptureId();

// --- fork one (engine, scenario) row in its own cold process -------------------------
function runRow(engine, scenario) {
    return new Promise((resolve) => {
        const child = fork(MIRROR, [], {
            env: { ...process.env, FW: engine, SCENARIO: scenario, ROWS_ONLY: "1", QUICK: QUICK ? "1" : "", CAPTURE_ID },
            execArgv: [...process.execArgv.filter((a) => a !== "--expose-gc"), "--expose-gc"],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let out = "", err = "", timedOut = false;
        // SIGKILL, not SIGTERM: a child that traps SIGTERM would stall the night. stdout and
        // stderr are destroyed too, so "close" fires even if a grandchild still holds them
        // open (a grandchild holding the IPC fd can still delay "close").
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
            child.stdout.destroy();
            child.stderr.destroy();
        }, CHILD_TIMEOUT_MS);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        // "close", not "exit": stdout/stderr are fully drained before the row is parsed
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
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

async function main() {
    // schedule.mjs validates DRIFT_TOL when it loads (it throws on a bad value): load it
    // here so a bad env value is a clean exit 2, like every other bad input
    let S;
    try { S = await import("./lib/schedule.mjs"); } catch (e) {
        console.error("sweep: " + (e && e.message ? e.message : String(e)));
        process.exitCode = 2;
        return;
    }
    const { DRIFT_TOL, sentinelDrift, sentinelBaseline, buildScenarioMajor } = S;
    // scenario-major Williams schedule (M8); buildScenarioMajor refuses bad REPS / names
    let steps;
    try { steps = buildScenarioMajor(ENGINES, scenarioNames, REPS); } catch (e) {
        console.error("sweep: " + (e && e.message ? e.message : String(e)));
        process.exitCode = 2;
        return;
    }
    // refuse, never delete: an existing capture is the maintainer's, not ours
    if (existsSync(RUN_DIR)) {
        const reps = readdirSync(RUN_DIR).filter((f) => /-rep.*\.txt$/.test(f));
        if (reps.length > 0) {
            console.error(`sweep: REFUSING -- ${reps.length} rep file(s) already in ${RUN_DIR} (e.g. ${reps[0]}).`);
            console.error("Copy the old set aside first; the sweep never overwrites or deletes a capture.");
            process.exitCode = 2;
            return;
        }
        if (existsSync(join(RUN_DIR, "COMPLETE"))) {
            console.error(`sweep: REFUSING -- ${join(RUN_DIR, "COMPLETE")} already exists (a finished capture's marker).`);
            console.error("Copy the old set aside first; the sweep never overwrites or deletes a capture.");
            process.exitCode = 2;
            return;
        }
    }
    mkdirSync(RUN_DIR, { recursive: true });

    console.log(`sweep: ${ENGINES.length} engine(s) x ${scenarioNames.length} scenario(s) x ${REPS} rep(s) = ${steps.length} cold processes`);
    console.log(`protocol: isolated-per-row, scenario-major Williams, sentinel drift @ ${(DRIFT_TOL * 100).toFixed(0)}%, child timeout ${CHILD_TIMEOUT_MS} ms`);
    console.log(`capture: ${CAPTURE_ID}`);
    console.log(`output: ${RUN_DIR}\n`);

    const verdict = G.makeVerdict();
    // every child's stamp, not only the first per rep file: well-formed, this capture's id,
    // and equal to the first accepted child's on host / node / shas / protocol / config /
    // adapter / quick (lib/rowcheck.mjs makeChildStampGuard)
    const childStamp = makeChildStampGuard(CAPTURE_ID, { quick: QUICK });
    const stampByFile = new Map();   // engine-rep -> stamp (written once)
    const firstCombo = steps[0];
    const firstTimes = [];   // every first-combo rep time, in schedule order (sentinel baseline)
    let sentinelTime = null;

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
        const { code, out, err, timedOut } = await runRow(step.engine, step.scenario);
        const { stamp, row, guards } = parseChild(out);
        done++;
        if (timedOut) {
            verdict.ok = false;
            verdict.failures.push(`${step.engine}/${step.scenario} rep${step.rep}: TIMEOUT -- child killed (SIGKILL) after ${CHILD_TIMEOUT_MS} ms; row discarded`);
            continue;
        }
        if (!row || !stamp) {
            G.makeVerdict(); verdict.ok = false;
            verdict.failures.push(`${step.engine}/${step.scenario} rep${step.rep}: no row/stamp (exit ${code}). stderr: ${(err || "").split("\n")[0]}`);
            continue;
        }
        const cs = childStamp(step.engine, `${step.engine}/${step.scenario} rep${step.rep}`, stamp);
        if (!cs.ok) { verdict.ok = false; verdict.failures.push(`stamp check: ${cs.reason}; row discarded`); continue; }
        if (code !== 0) { verdict.ok = false; verdict.failures.push(`${step.engine}/${step.scenario} rep${step.rep}: child exited ${code} after printing its row (its guards may not have run). stderr: ${(err || "").split("\n")[0]}`); }
        for (const g of guards) { verdict.ok = false; verdict.failures.push(`${step.engine}/${step.scenario}: ${g}`); }
        writeRow(step.engine, step.rep, stamp, row);
        // every first-combo rep time feeds the sentinel baseline (median of REPS)
        if (step.engine === firstCombo.engine && step.scenario === firstCombo.scenario) {
            firstTimes.push(timeOf(row));
        }
        process.stdout.write(`\r  ${done}/${steps.length} rows measured`);
    }

    // --- sentinel: re-measure the first combo dead last ---
    process.stdout.write("\r" + " ".repeat(40) + "\r");
    const sent = await runRow(firstCombo.engine, firstCombo.scenario);
    const sp = parseChild(sent.out);
    if (!sent.timedOut) {
        const cs = sp.stamp ? childStamp(firstCombo.engine, `sentinel ${firstCombo.engine}/${firstCombo.scenario}`, sp.stamp) : { ok: false, reason: "the sentinel child printed no stamp" };
        if (!cs.ok) { verdict.ok = false; verdict.failures.push(`stamp check: ${cs.reason}`); }
    }
    if (sent.timedOut) {
        verdict.ok = false;
        verdict.failures.push(`sentinel ${firstCombo.engine}/${firstCombo.scenario}: TIMEOUT -- child killed (SIGKILL) after ${CHILD_TIMEOUT_MS} ms`);
    } else if (sp.row && sent.code === 0 && Number.isFinite(timeOf(sp.row))) {
        // baseline = median of the first combo's REPS reps; a missing / non-finite / <= 0
        // rep time refuses it (drift unmeasured, no "sentinel:" line)
        const base = sentinelBaseline(firstTimes, REPS);
        if (!base.ok) {
            verdict.ok = false;
            verdict.failures.push(`sentinel ${firstCombo.engine}/${firstCombo.scenario}: drift unmeasured -- ${base.reason}`);
        } else {
            sentinelTime = timeOf(sp.row);
            const d = sentinelDrift(base.median, sentinelTime);
            console.log(`sentinel: ${firstCombo.engine}/${firstCombo.scenario}  baseline=median(${base.n})=${base.median.toFixed(2)}ms  last=${sentinelTime.toFixed(2)}ms  ratio=${d.ratio.toFixed(3)}x  ${d.drifted ? "<-- DRIFTED, sweep suspect" : "(stable)"}`);
            if (d.drifted) { verdict.ok = false; verdict.failures.push(`SENTINEL DRIFT: host moved ${((d.ratio - 1) * 100).toFixed(1)}% mid-sweep (> ${(DRIFT_TOL * 100).toFixed(0)}% tol); the whole sweep is thermally suspect`); }
        }
    }
    else { verdict.ok = false; verdict.failures.push(`sentinel ${firstCombo.engine}/${firstCombo.scenario}: drift unmeasured (exit ${sent.code}, first-combo reps=${firstTimes.length})`); }

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
    // cross-file rows + cross-engine stamps (b251 M7 / M16); a QUICK sweep expects quick=true
    // stamps (report.mjs then refuses the capture as a smoke run)
    const rc = checkCapture(RUN_DIR, ENGINES, { captureId: CAPTURE_ID }, { quick: QUICK });
    if (!rc.ok) { verdict.ok = false; verdict.failures.push(`rowcheck: ${rc.reason}`); }

    // per-shape spread flag: the single-shape sentinel does not guard per-row variance
    // on the heavy shapes (burst/layered swing ~15% run-to-run). SPREAD_WARN marks any
    // row whose worst-engine (max-min)/median across reps exceeds the threshold, so a
    // high-variance row can never be published as a point number by accident.
    const SPREAD_WARN = Number(process.env.SPREAD_WARN || 8);   // % ; host-calibratable
    if (perEngine["lite-signal"] && perEngine["alien-signals"]) {
        const lite = perEngine["lite-signal"], alien = perEngine["alien-signals"];
        console.log(`aggregated: protocol=${lite.protocol}  reps=${lite.reps}  engineSha=${lite.engineSha.slice(0, 12)}\n`);
        console.log("test".padEnd(52) + "lite".padStart(9) + "alien".padStart(9) + "  lite vs alien".padEnd(17) + "spread");
        console.log("-".repeat(100));
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

    // every other captured engine (D-b207-8, output only; the block above is unchanged):
    // an all-engines median block, then one lite vs <engine> block per extra engine.
    // spread = worst (max-min)/median across reps over the engines in that block.
    const SHORT = { "lite-signal": "lite", "alien-signals": "alien" };
    const shortOf = (e) => SHORT[e] || e;
    const extras = ENGINES.filter((e) => e !== "lite-signal" && e !== "alien-signals" && perEngine[e]);
    if (perEngine["lite-signal"] && extras.length) {
        const lite = perEngine["lite-signal"];
        const spStrOf = (sp) => sp.toFixed(0) + "%" + (sp > SPREAD_WARN ? " !!" : "");
        const all = ENGINES.filter((e) => perEngine[e]);
        const colW = all.map((e) => Math.max(9, shortOf(e).length + 2));
        console.log("\nall engines (median ms; lower is better):");
        console.log("test".padEnd(52) + all.map((e, i) => shortOf(e).padStart(colW[i])).join("") + "  spread");
        console.log("-".repeat(100));
        for (const test of lite.perTest.keys()) {
            let sp = 0;
            for (const e of all) sp = Math.max(sp, perEngine[e].perTestSpread.get(test) ?? 0);
            console.log(test.slice(0, 50).padEnd(52) + all.map((e, i) => { const v = perEngine[e].perTest.get(test); return (v == null ? "-" : v.toFixed(2)).padStart(colW[i]); }).join("") + "  " + spStrOf(sp));
        }
        console.log("-".repeat(100));
        for (const x of extras) {
            const other = perEngine[x], xs = shortOf(x), xw = Math.max(9, xs.length + 2), vsW = Math.max(17, xs.length + 13);
            console.log(`\nlite vs ${x}:`);
            console.log("test".padEnd(52) + "lite".padStart(9) + xs.padStart(xw) + `  lite vs ${xs}`.padEnd(vsW) + "spread");
            console.log("-".repeat(100));
            for (const test of lite.perTest.keys()) {
                const l = lite.perTest.get(test), a = other.perTest.get(test);
                if (a == null) continue;
                const d = (a - l) / a * 100;
                const sp = Math.max(lite.perTestSpread.get(test) ?? 0, other.perTestSpread.get(test) ?? 0);
                console.log(test.slice(0, 50).padEnd(52) + l.toFixed(2).padStart(9) + a.toFixed(2).padStart(xw) + `   ${d >= 0 ? "+" : ""}${d.toFixed(1)}% ${l < a ? "lite" : xs}`.padEnd(vsW) + "  " + spStrOf(sp));
            }
            console.log("-".repeat(100));
        }
    }

    if (!G.reportVerdict(verdict)) return;
    // completion marker (D-b187-4): LAST state write, clean verdict only; tmp + rename
    const marker = { kind: "bench-capture-complete/v1", writer: "sweep.mjs", protocol: perEngine[ENGINES[0]].protocol, reps: REPS, engines: ENGINES, captureId: CAPTURE_ID };
    writeFileSync(join(RUN_DIR, "COMPLETE.tmp"), JSON.stringify(marker) + "\n");
    renameSync(join(RUN_DIR, "COMPLETE.tmp"), join(RUN_DIR, "COMPLETE"));
    console.log("\nsweep OK -- stamp-consistent, rep count verified, rows validated across engines, sentinel stable. Numbers are publishable.");
}

main();
