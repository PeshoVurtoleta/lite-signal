// jit-health.mjs
// Verifies the engine's JIT-facing invariants instead of assuming them:
//
//   MAPS LANE (child under --allow-natives-syntax): every handle family the
//   engine hands out -- callable signals, callable computeds, signalBox,
//   computedBox -- must be MONOMORPHIC: all 1,000 handles of a family share
//   one hidden class (%HaveSameMap), including handles created AFTER a
//   dispose+recycle round (a recycled slot must not mint a divergent shape).
//   SCOPE: this verifies the PUBLIC handle families only. The pooled
//   ReactiveNode/ReactiveLink internals -- the "monomorphic slot wiring" the
//   engine's comments describe -- are unreachable from outside the module;
//   their JIT health shows up indirectly in the deopt lane's invalidation
//   census (dependent-code marks name ReactiveNode/ReactiveLink directly).
//   Deterministic -> gateable: --strict exits 1 on a violation.
//
//   DEOPT LANE (child under --trace-deopt): drives the hot paths (steady
//   writes, branch-flip retracking, batched bursts) and counts deopt events
//   attributed to Signal.js. The count is Node-major-specific (TurboFan
//   heuristics move between majors), so it is ADVISORY against a recorded
//   per-major baseline in harness/jit-baseline.json: --record writes the
//   baseline, later runs WARN when the count exceeds it. Never exit-coded.
//
// Usage: node harness/jit-health.mjs             # both lanes, advisory
//        node harness/jit-health.mjs --strict    # maps violations exit 1
//        node harness/jit-health.mjs --record    # record deopt baseline for this Node major

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const STRICT = process.argv.includes("--strict");
const RECORD = process.argv.includes("--record");
const BASELINE_PATH = join(HERE, "jit-baseline.json");
const CHILD = process.env.JIT_HEALTH_CHILD || null;

/* -- child: maps lane (runs under --allow-natives-syntax) ------------------- */
if (CHILD === "maps") {
    const E = await import(join(HERE, "../Signal.js"));
    // %-natives cannot appear at module parse time without the flag everywhere,
    // so the probe is compiled here, inside the flagged child.
    const haveSameMap = new Function("a", "b", "return %HaveSameMap(a, b);");
    const r = E.createRegistry({ maxNodes: 8192, maxLinks: 32768, prealloc: "eager", onCapacityExceeded: "grow" });

    const N = 1000;
    const families = {
        signal: () => r.signal(1),
        computed: () => { const s = r.signal(1); return r.computed(() => s()); },
        signalBox: () => r.signalBox(1),
        computedBox: () => { const s = r.signalBox(1); return r.computedBox(() => s.get()); },
    };
    const out = {};
    for (const [name, make] of Object.entries(families)) {
        if (name.endsWith("Box") && typeof r[name] !== "function") { out[name] = { skipped: "surface absent" }; continue; }
        const handles = [];
        for (let i = 0; i < N; i++) handles.push(make());
        let divergent = 0;
        for (let i = 1; i < handles.length; i++) if (!haveSameMap(handles[0], handles[i])) divergent++;
        // Recycle round: dispose half, mint fresh handles into the recycled
        // slots, compare against the ORIGINAL map.
        for (let i = 0; i < N; i += 2) r.dispose(handles[i]);
        let recycledDivergent = 0;
        for (let i = 0; i < N / 2; i++) { const h = make(); if (!haveSameMap(handles[1], h)) recycledDivergent++; }
        out[name] = { n: N, divergent, recycledDivergent };
    }
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
}

/* -- child: deopt lane (runs under --trace-deopt; hot-path driver) ---------- */
if (CHILD === "deopt") {
    const E = await import(join(HERE, "../Signal.js"));
    const r = E.createRegistry({ maxNodes: 8192, maxLinks: 65536, prealloc: "eager", onCapacityExceeded: "grow" });
    // steady deep chain
    const a = r.signal(0);
    let prev = a;
    for (let i = 0; i < 16; i++) { const p = prev; prev = r.computed(() => p() + 1); }
    let sink = 0; const tail = prev; r.effect(() => { sink = tail(); });
    for (let i = 0; i < 200_000; i++) a.set(i);
    // branch-flip retracking
    const sel = r.signal(0);
    const xs = [], ys = [];
    for (let i = 0; i < 4; i++) { xs.push(r.signal(i)); ys.push(r.signal(i + 4)); }
    const c = r.computed(() => {
        let t = 0;
        if (sel() & 1) { for (let j = 0; j < 4; j++) t += ys[j](); }
        else { for (let j = 0; j < 4; j++) t += xs[j](); }
        return t;
    });
    r.effect(() => { sink += c(); });
    for (let i = 0; i < 200_000; i++) sel.set(i & 1);
    // batched bursts
    const sigs = []; for (let i = 0; i < 8; i++) sigs.push(r.signal(i));
    r.effect(() => { let t = 0; for (let j = 0; j < 8; j++) t += sigs[j](); sink += t; });
    let cur = 0;
    const cb = () => { for (let j = 0; j < 8; j++) sigs[j].set(cur + j); };
    for (let i = 0; i < 100_000; i++) { cur = i; r.batch(cb); }
    process.stdout.write(JSON.stringify({ sink }));
    process.exit(0);
}

/* -- parent ----------------------------------------------------------------- */
console.log("jit health -- monomorphism (verified) + deopt census (advisory)");
console.log(`Node ${process.version}`);
console.log();

let exitCode = 0;

// maps lane
{
    const res = spawnSync(process.execPath, ["--allow-natives-syntax", "--expose-gc", SELF], {
        env: { ...process.env, JIT_HEALTH_CHILD: "maps" },
        encoding: "utf8",
    });
    if (res.status !== 0) {
        console.error("  maps lane FAILED to run:\n" + (res.stderr || res.stdout));
        process.exit(2);
    }
    const maps = JSON.parse(res.stdout);
    console.log("maps lane (1,000 handles per family + recycle round):");
    for (const [family, m] of Object.entries(maps)) {
        if (m.skipped) { console.log(`  ${family.padEnd(12)} skipped (${m.skipped})`); continue; }
        const clean = m.divergent === 0 && m.recycledDivergent === 0;
        console.log(
            `  ${family.padEnd(12)} ${clean ? "MONOMORPHIC" : "POLYMORPHIC"}` +
            (clean ? "" : `  -- ${m.divergent} divergent map(s) fresh, ${m.recycledDivergent} after recycle`)
        );
        if (!clean && STRICT) exitCode = 1;
    }
}

// deopt lane
{
    const res = spawnSync(process.execPath, ["--trace-deopt", "--expose-gc", SELF], {
        env: { ...process.env, JIT_HEALTH_CHILD: "deopt" },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
        console.error("  deopt lane FAILED to run:\n" + (res.stderr || "").slice(0, 800));
        process.exit(2);
    }
    // Node 26's --trace-deopt output carries NO file paths -- functions are
    // identified only as <JSFunction name (sfi = 0x...)> in bailout blocks and
    // <SharedFunctionInfo name> in dependent-code invalidation marks (2026-08
    // review HIGH: the original path-based regexes were structurally zero and
    // the lane was blind). Attribution is therefore by NAME, against the set
    // of function/class/const-fn names extracted from the CURRENT Signal.js --
    // never a hardcoded list that rots. Over-matching a driver name is
    // conservative (flags more, never less); the driver below defines none.
    const engineSrc = readFileSync(join(HERE, "../Signal.js"), "utf8");
    const engineNames = new Set();
    for (const m of engineSrc.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) engineNames.add(m[1]);
    for (const m of engineSrc.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(|function\b|async\b)/g)) engineNames.add(m[1]);

    const text = (res.stdout || "") + (res.stderr || "");
    const lines = text.split("\n");
    let deopts = 0, engineBailouts = 0, engineInvalidations = 0;
    const nameTally = {};
    for (const l of lines) {
        if (/^\[bailout/.test(l)) {
            deopts++;
            const m = /deoptimizing 0x[0-9a-f]+ <JSFunction ([A-Za-z_$][\w$]*)/.exec(l);
            if (m && engineNames.has(m[1])) { engineBailouts++; nameTally[m[1]] = (nameTally[m[1]] || 0) + 1; }
        } else if (/^\[marking dependent code .* for deoptimization/.test(l)) {
            const m = /<SharedFunctionInfo ([A-Za-z_$][\w$]*)>/.exec(l);
            if (m && engineNames.has(m[1])) { engineInvalidations++; nameTally[m[1]] = (nameTally[m[1]] || 0) + 1; }
        }
    }
    const count = engineBailouts;
    console.log();
    console.log(`deopt lane (steady + retrack + batch drivers, 500k ops): ${deopts} total bailout(s); engine-attributed: ${engineBailouts} bailout(s), ${engineInvalidations} code invalidation(s)`);
    const top = Object.entries(nameTally).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (top.length) console.log("  engine names in the trace: " + top.map(([n, c]) => `${n} x${c}`).join(", "));

    const major = process.version.split(".")[0];
    const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    if (RECORD) {
        baseline[major] = { engineDeopts: count, engineInvalidations, totalDeopts: deopts, date: new Date().toISOString(), node: process.version };
        writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
        console.log(`  baseline recorded for Node ${major} -> ${BASELINE_PATH}`);
    } else if (baseline[major]) {
        const b = baseline[major];
        if (count > b.engineDeopts) {
            console.log(`  WARN: ${count} engine deopts > recorded baseline ${b.engineDeopts} (Node ${major}, ${b.date.slice(0, 10)}) -- a hot path lost its optimized code; run with --trace-deopt manually to attribute`);
        } else {
            console.log(`  within baseline for Node ${major} (${b.engineDeopts} recorded ${b.date.slice(0, 10)})`);
        }
    } else {
        console.log(`  no baseline for Node ${major} yet -- run with --record on a healthy build to pin one`);
    }
}

if (exitCode) console.error("\nSTRICT: monomorphism violated -- a handle family minted divergent hidden classes");
process.exit(exitCode);
