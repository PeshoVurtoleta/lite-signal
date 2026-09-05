// bench/lib/stamp.mjs -- machine-generated provenance header.
//
// WHY THIS EXISTS (F1 + F2). resultsReactive.txt's hand-written header claimed
// "DEFAULT flushStrategy (eager)" while benchmarkReactive.mjs:97 built the registry
// with flushStrategy:"sab", and claimed "MEDIAN of 10 full runs" while only five
// bench-runs-reactive/run_*.txt exist. A prose header that a human maintains by hand
// WILL drift from the code that produced the run. So: prose headers are abolished for
// anything factual. Every harness prints this machine stamp, derived from live state:
//
//   * engine sha256    -- the SAME hash VersionMatrix uses to SKIP identical-code
//                         axes. Two runs with the same engine bytes have the same
//                         engine hash; a diff that survives equal hashes is host noise.
//   * harness sha256   -- the bytes that PRODUCED this row. A row cannot be attributed
//                         to code that no longer exists.
//   * config           -- ECHOED FROM THE LIVE OBJECT, not typed into a comment. See
//                         the single-reference rule below: the object the stamp prints
//                         is byte-identical to the object handed to createRegistry,
//                         because it is the SAME reference. This is the structural
//                         fix for F1 -- header and code cannot disagree when they are
//                         the same object.
//   * protocol id      -- isolated-per-engine | isolated-per-row | shared-process-smoke.
//                         Aggregators refuse to merge rows across protocol ids.
//   * host / node / date / reps
//
// SINGLE-REFERENCE RULE. Harnesses build their registry config ONCE:
//     const LITE_CONFIG = Object.freeze({ ... });
//     const reg = createRegistry(LITE_CONFIG);
//     ... makeStamp({ config: LITE_CONFIG, ... })
// Never re-type the config for the stamp. The freeze makes accidental mutation throw.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";

export const PROTOCOLS = Object.freeze({
    PER_ENGINE: "isolated-per-engine",       // one cold process per engine, all scenarios share it
    PER_ROW: "isolated-per-row",             // one cold process per (engine x scenario) -- Andrii-grade
    SMOKE: "shared-process-smoke",           // many engines in one process -- NEVER publishable
});

function sha256File(path) {
    try {
        return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch (e) {
        return "unreadable(" + (e && e.code || "err") + ")";
    }
}

function resolvePath(p) {
    if (!p) return null;
    return p.startsWith("file:") ? fileURLToPath(p) : p;
}

// Build a stamp object from LIVE state. `config` MUST be the same object reference
// passed to createRegistry (see single-reference rule). `enginePath` and `harnessPath`
// are hashed off disk.
export function makeStamp({ enginePath, harnessPath, config, protocol, reps, extra }) {
    const ep = resolvePath(enginePath);
    const hp = resolvePath(harnessPath);
    const cpu = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) || "unknown-cpu";
    return {
        kind: "bench-stamp/v1",
        date: new Date().toISOString(),
        protocol: protocol || "UNSET",
        reps: reps ?? null,
        node: process.version,
        arch: process.arch,
        platform: process.platform,
        cpu,
        gcExposed: typeof globalThis.gc === "function",
        enginePath: ep,
        engineSha256: ep ? sha256File(ep) : null,
        harnessPath: hp,
        harnessSha256: hp ? sha256File(hp) : null,
        // The config is echoed verbatim from the live reference. If a harness builds it
        // with flushStrategy:"sab", the stamp says sab. It cannot say otherwise.
        config: config ? { ...config } : null,
        extra: extra || null,
    };
}

// Render the stamp as a comment block for the top of a results/rep file. Machine block
// first; any human prose in results*.txt must FOLLOW this, never replace it.
export function formatStamp(stamp) {
    const L = [];
    L.push("# ==== BENCH STAMP v1 (machine-generated -- do not hand-edit) ====");
    L.push("# date        : " + stamp.date);
    L.push("# protocol    : " + stamp.protocol + (stamp.reps != null ? "  reps=" + stamp.reps : ""));
    L.push("# host        : " + stamp.cpu + "  " + stamp.platform + "/" + stamp.arch +
        "  node " + stamp.node + "  gc=" + (stamp.gcExposed ? "on" : "OFF"));
    L.push("# engine      : " + stamp.enginePath);
    L.push("# engine.sha  : " + stamp.engineSha256);
    L.push("# harness     : " + stamp.harnessPath);
    L.push("# harness.sha : " + stamp.harnessSha256);
    L.push("# config      : " + (stamp.config ? JSON.stringify(stamp.config) : "(reference libs / n-a)"));
    if (stamp.extra) L.push("# extra       : " + JSON.stringify(stamp.extra));
    if (!stamp.gcExposed) L.push("# !! WARNING: run with --expose-gc; heap columns are meaningless without it.");
    L.push("# ================================================================");
    return L.join("\n");
}

// Emit a machine-parseable one-liner too, so aggregators can read the stamp back off
// a rep file without re-parsing the pretty block. Prefixed so it never collides with
// data rows.
export function formatStampLine(stamp) {
    return "#STAMP " + JSON.stringify(stamp);
}

export function printStamp(stamp) {
    console.log(formatStamp(stamp));
    console.log(formatStampLine(stamp));
}

// Parse the #STAMP line back out of a captured rep file's text.
export function parseStampFromText(text) {
    const line = text.split(/\r?\n/).find((l) => l.startsWith("#STAMP "));
    if (!line) return null;
    try {
        return JSON.parse(line.slice("#STAMP ".length));
    } catch {
        return null;
    }
}
