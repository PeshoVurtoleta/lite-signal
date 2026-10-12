#!/usr/bin/env node
// @zakkster/lite-signal gate 1 -- external conformance, per-test diff.
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT License
//
// Runs ONLY the lite-signal column of the external johnsoncodehk
// reactive-framework-test-suite (178 conformance + 18 behavioral cases) against
// one or two engine files, then prints a PER-TEST diff. Ported from the
// LiteSignalExperimental fork's harness/reactive-suite/run.mjs (which counted
// pass/fail only and needed tsx) and extended to the per-test diff LEDGER.md's
// gate order names as gate 1.
//
// WHY PER-TEST. A candidate that fixes one case and breaks another keeps the same
// pass count. Gate 1 is "no case changes verdict or behavioral value", not "same
// total". Behavioral cases record the VALUE the engine produced (design choices,
// e.g. equality semantics) -- a changed value is a semantic change even though
// no case "fails".
//
// HOW. The suite is TypeScript with mixed `.js` / extensionless relative imports,
// so a child is run under the suite's own `vite-node` (it ships in the suite's
// devDependencies); no tsx, no install in this repo. Each engine runs in its own
// child process (a fresh default registry, no cross-engine module sharing).
//
// USAGE
//   node harness/run.mjs conformance [engineA] [engineB]
//   REACTIVE_SUITE_PATH=/path/to/reactive-framework-test-suite node harness/conformance.mjs [A] [B]
//   No engine: this repo's Signal.js alone (verdict only). One engine: repo vs
//   candidate. Two: A vs B.
// ENV   REACTIVE_SUITE_PATH (default ~/Work/reactive-framework-test-suite-master)
//
// EXIT  0 = no per-test difference (or single-engine run with 0 conformance
//       failures beyond KNOWN_FAIL); 1 = any difference / unexpected failure;
//       2 = the suite or an engine is missing (fail closed, never a quiet pass).

import {fileURLToPath, pathToFileURL} from "node:url";
import {dirname, join, resolve} from "node:path";
import {existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ENGINE = resolve(HERE, "..", "Signal.js");
// Documented, not a regression: #179 (computed self-increment read-after-write)
// is the absorption contract -- LEDGER #15. A candidate that PASSES it changed
// the contract and must say so; one that fails anything else is a regression.
const KNOWN_FAIL = new Set(["Inner Write :: #179 computed self-increment: intra-run read-after-write values correct"]);

// ------------------------------------------------------------------ child mode
if (process.argv[2] === "--child") {
    const [, , , suite, engine, out] = process.argv;
    const {testSuite, SkipTest} = await import(pathToFileURL(join(suite, "src", "index.ts")).href);
    const {signal, computed, effect, batch, untrack, onCleanup, destroy} = await import(pathToFileURL(engine).href);
    // The lite-signal adapter, identical to the suite's test/frameworks/liteSignal.ts.
    const fw = {
        name: "lite-signal",
        signal(v) { const s = signal(v); return {read: () => s(), write: (x) => s.set(x)}; },
        computed(fn) { const c = computed(fn); return {read: () => c()}; },
        effect(fn) {
            return effect(() => { const r = fn(); if (typeof r === "function") onCleanup(r); });
        },
        run(fn) { try { fn(); } finally { destroy(); } },
        batch(fn) { return batch(fn); },
        untracked(fn) { return untrack(fn); },
    };
    const res = {};
    for (const {section, cases, type} of testSuite) {
        for (const [name, fn] of Object.entries(cases)) {
            const key = section + " :: " + name;
            try {
                let result;
                fw.run(() => { result = fn(fw); });
                res[key] = type === "behavioral" ? {kind: "behavioral", value: JSON.stringify(result === undefined ? null : result)} : {kind: "conformance", value: "pass"};
            } catch (e) {
                if (e instanceof SkipTest) res[key] = {kind: type === "behavioral" ? "behavioral" : "conformance", value: "skip"};
                else res[key] = {kind: type === "behavioral" ? "behavioral" : "conformance", value: type === "behavioral" ? "error" : "fail"};
            }
        }
    }
    writeFileSync(out, JSON.stringify(res));
    process.exit(0);
}

// ----------------------------------------------------------------- parent mode
const SUITE = process.env.REACTIVE_SUITE_PATH || join(os.homedir(), "Work", "reactive-framework-test-suite-master");
const VITE_NODE = join(SUITE, "node_modules", ".bin", "vite-node");
if (!existsSync(join(SUITE, "src", "index.ts"))) { console.error(`[lite-signal] conformance: suite not found at ${SUITE} (set REACTIVE_SUITE_PATH). Failing closed.`); process.exit(2); }
if (!existsSync(VITE_NODE)) { console.error(`[lite-signal] conformance: ${VITE_NODE} missing -- run npm install in the suite. Failing closed.`); process.exit(2); }

const pos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (pos.length > 2) { console.error("usage: node harness/conformance.mjs [engineA] [engineB]"); process.exit(2); }
const engines = pos.length === 0 ? [REPO_ENGINE] : pos.length === 1 ? [REPO_ENGINE, resolve(pos[0])] : [resolve(pos[0]), resolve(pos[1])];
for (const e of engines) if (!existsSync(e)) { console.error(`[lite-signal] conformance: engine not found: ${e}. Failing closed.`); process.exit(2); }

const tmp = mkdtempSync(join(os.tmpdir(), "lite-conformance-"));
const runs = engines.map((engine, i) => {
    const out = join(tmp, `r${i}.json`);
    const r = spawnSync(VITE_NODE, [fileURLToPath(import.meta.url), "--child", SUITE, engine, out], {cwd: SUITE, encoding: "utf8"});
    if (r.status !== 0 || !existsSync(out)) {
        console.error(`[lite-signal] conformance: child failed for ${engine}:\n${(r.stderr || r.stdout || "").split("\n").slice(0, 8).join("\n")}`);
        rmSync(tmp, {recursive: true, force: true});
        process.exit(2);
    }
    return {engine, res: JSON.parse(readFileSync(out, "utf8"))};
});
rmSync(tmp, {recursive: true, force: true});

function tally(res) {
    let pass = 0, fail = 0, skip = 0, beh = 0;
    const unexpected = [];
    for (const [k, v] of Object.entries(res)) {
        if (v.kind === "behavioral") { beh++; continue; }
        if (v.value === "pass") pass++; else if (v.value === "skip") skip++; else { fail++; if (!KNOWN_FAIL.has(k)) unexpected.push(k); }
    }
    return {pass, fail, skip, beh, unexpected};
}

console.log(`suite   ${SUITE}`);
let bad = 0;
for (const {engine, res} of runs) {
    const t = tally(res);
    console.log(`engine  ${engine}`);
    console.log(`        conformance ${t.pass} pass / ${t.fail} fail / ${t.skip} skip, behavioral ${t.beh} recorded`);
    for (const k of t.unexpected) console.log(`        UNEXPECTED FAIL  ${k}`);
    for (const k of KNOWN_FAIL) if (res[k] && res[k].value === "pass") console.log(`        CONTRACT CHANGE  ${k} now passes (LEDGER #15 absorption contract)`);
    if (runs.length === 1) bad += t.unexpected.length;
}
if (runs.length === 2) {
    const [a, b] = runs;
    const keys = new Set([...Object.keys(a.res), ...Object.keys(b.res)]);
    let diffs = 0;
    for (const k of keys) {
        const x = a.res[k], y = b.res[k];
        if (!x || !y || x.value !== y.value) { diffs++; console.log(`  DIFF  ${k}: ${x ? x.value : "(missing)"} -> ${y ? y.value : "(missing)"}`); }
    }
    console.log(`\nPER-TEST DIFF  ${keys.size} cases, ${diffs} difference(s)`);
    bad += diffs;
}
console.log(bad === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(bad === 0 ? 0 : 1);
