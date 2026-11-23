// bench/lib/guards.mjs -- validity guards. Any failure => INVALID RUN + nonzero exit.
//
// Generalizes the VALIDITY GUARD that already lives at the bottom of benchmark.mjs
// (the one that would have caught the MUX 22,032K-ops/s fiction: nine rows printed
// sink=[ ] and the run was published anyway). The lesson from that incident is that a
// guard is only worth having if it BLOCKS -- so every check here contributes to a
// single verdict and the harness sets process.exitCode on failure.
//
// Four guard families:
//   1. deadSink        -- an effect never re-ran in the timed loop (existing check).
//   2. counterAgreement -- on a DETERMINISTIC shape, every framework must report the
//                          same work (edgesTraversed / nodesRecomputed). This is F6:
//                          equal counters PROVE equal work, which is a stronger anti-DCE
//                          than the sink -- it catches an engine that silently skips
//                          propagation even while leaving a nonzero sink.
//   3. checksum        -- fanBench-style: the accumulated checksum must match across
//                          frameworks (Andrii prints checksum= on those rows).
//   4. expected        -- pull/push shapes carry hard expected {sum, count}; a mismatch
//                          is a correctness failure, not a slow row.
//
// Plus an AGGREGATOR guard: refuse to merge rep files whose stamps are inconsistent
// (mixed engine hashes, mixed protocols, mixed hosts) or missing. This is what makes
// F2 unrepeatable: the aggregator counts files and reads stamps; it cannot be told
// "median of 10" when five files are present or when three were captured on a laptop.

import { PROTOCOLS } from "./stamp.mjs";

export function makeVerdict() {
    return { failures: [], ok: true };
}

function fail(v, msg) {
    v.failures.push(msg);
    v.ok = false;
}

// --- per-row checks --------------------------------------------------------------

// Fail closed: only a finite non-zero value passes. SINK is a Float64Array, so NaN is the
// reachable non-number; NaN and +-Infinity fail here (b250 G1, M3).
export function checkDeadSink(v, label, sinkValue) {
    if (!(Number.isFinite(sinkValue) && sinkValue !== 0)) fail(v, `DEAD SINK: ${label} finished with sink=${sinkValue} (effect never re-ran or wrote a non-finite value; timing measures nothing)`);
}

// Exact sink check against an independent oracle value (bench/lib/sink-oracle.mjs).
// Passes only on a finite non-zero expected value AND got === expected (a NaN, 0 or
// non-finite expected value fails closed: an oracle that cannot anchor the row is no
// anchor). Called between timed runs, never inside one. Allocates only on failure: the
// label is a caller-owned string built once per row, and the passing path touches only
// its number arguments.
export function checkSinkExact(v, label, got, expected) {
    if (Number.isFinite(expected) && expected !== 0 && got === expected) return;
    fail(v, `SINK MISMATCH: ${label} got=${got} expected=${expected} (stale, dead or wrong propagation in the timed run)`);
}

// Order-independent sink check (D-b250-2), used ONLY where the engine's effect re-run order
// is not creation order (solid-js / broadcast: solid re-orders observers as computeds
// re-track, so which effect of a residue class writes last varies run to run). Slot j of a
// BROADCAST row passes iff d = got - src satisfies 0 <= d < n and d % 32 === j, i.e. the
// slot holds src + k for SOME effect k of its residue class, written with the final source
// value of THIS run (the sink is reset before each run). Weaker than checkSinkExact by
// design; the failure text and the row output say so. Allocates only on failure.
export function checkSinkResidue(v, label, got, src, slot, n) {
    const d = got - src;
    if (d >= 0 && d < n && d % 32 === slot) return;
    fail(v, `SINK RESIDUE MISMATCH (residue check): ${label} got=${got} src=${src} slot=${slot} n=${n} (no effect k with k % 32 === slot, 0 <= k < n wrote src + k in the timed run)`);
}

// --- run resolution (FW / ITERATIONS; b250 G1, M4 + M6) --------------------------

export const DEFAULT_ITERATIONS = 20000;
// D-b250-1: MUX N + 1 (the only microscope scenario driving a modular index; the ruling text
// says "largest scenario N + 1", which holds among modular-index scenarios -- kairos /
// broadcast N = 1000 drive src.set(i) and need only >= 2). MUX drives sigs[i % N] = i with N = 256; at
// ITERATIONS <= 256 every timed run re-writes the values warm-up already wrote, nothing
// changes, the effect never re-runs and the loop measures nothing. benchmark.mjs refuses
// (exit 2) at start-up if any scenario N >= ITERATIONS_MIN, so the two cannot drift silently.
export const ITERATIONS_MIN = 257;
const ITERATIONS_MAX = 0x3FFFFFFF;   // 2^30 - 1: the drive index stays a Smi on every V8 build
const ITERATIONS_RE = /^[1-9][0-9]*$/;

// env: a process.env-like object. engineKeys: the declared engine keys (frameworks.mjs).
// Returns { ok: true, libs, protocol, iterations } or { ok: false, reason }.
//   FW unset         -> every engine, PROTOCOLS.SMOKE (one shared process).
//   FW = one key     -> that engine, PROTOCOLS.PER_ENGINE.
//   FW = 2+ keys     -> those engines, PROTOCOLS.SMOKE.
//   FW set to "", an empty token, an unknown key or a duplicate -> refusal.
//   ITERATIONS unset -> DEFAULT_ITERATIONS; else a plain decimal integer in (D-b250-1: min 257)
//   [ITERATIONS_MIN, ITERATIONS_MAX] (no sign, no leading zero, no "-0", no exponent).
export function resolveRun(env, engineKeys) {
    let libs;
    let protocol;
    const fw = env.FW;
    if (fw === undefined) {
        libs = engineKeys.slice();
        protocol = PROTOCOLS.SMOKE;
    } else {
        if (typeof fw !== "string") return { ok: false, reason: "FW must be a string" };
        const toks = fw.split(",").map((s) => s.trim());
        libs = [];
        for (const k of toks) {
            if (k === "") return { ok: false, reason: `FW=${JSON.stringify(fw)} has an empty engine key` };
            if (!engineKeys.includes(k)) return { ok: false, reason: `FW: unknown engine "${k}" (known: ${engineKeys.join(", ")})` };
            if (libs.includes(k)) return { ok: false, reason: `FW: duplicate engine "${k}"` };
            libs.push(k);
        }
        protocol = libs.length === 1 ? PROTOCOLS.PER_ENGINE : PROTOCOLS.SMOKE;
    }
    let iterations = DEFAULT_ITERATIONS;
    const it = env.ITERATIONS;
    if (it !== undefined) {
        if (typeof it !== "string" || !ITERATIONS_RE.test(it)) {
            return { ok: false, reason: `ITERATIONS=${JSON.stringify(it)} is not a plain positive decimal integer` };
        }
        const n = Number(it);
        if (!(n >= ITERATIONS_MIN && n <= ITERATIONS_MAX)) {
            return { ok: false, reason: `ITERATIONS=${it} is outside [${ITERATIONS_MIN}, ${ITERATIONS_MAX}]` };
        }
        iterations = n;
    }
    return { ok: true, libs, protocol, iterations };
}

// rows: [{ framework, value }] for ONE scenario. All must be equal (===) or within an
// integer tolerance of 0 -- counters are exact integers on deterministic shapes.
export function checkCounterAgreement(v, scenario, counterName, rows) {
    if (rows.length < 2) return;
    const ref = rows[0].value;
    for (const r of rows) {
        if (r.value !== ref) {
            fail(v, `COUNTER DISAGREEMENT: ${scenario} ${counterName}: ${r.framework}=${r.value} != ${rows[0].framework}=${ref} (frameworks did unequal work; DCE or a skipped propagation)`);
            return;
        }
    }
}

export function checkChecksum(v, scenario, rows) {
    if (rows.length < 2) return;
    const ref = rows[0].checksum;
    for (const r of rows) {
        if (r.checksum !== ref) {
            fail(v, `CHECKSUM MISMATCH: ${scenario}: ${r.framework}=${r.checksum} != ${rows[0].framework}=${ref}`);
            return;
        }
    }
}

export function checkExpected(v, scenario, framework, got, expected) {
    if (expected == null) return;
    if (expected.sum != null && got.sum !== expected.sum) {
        fail(v, `EXPECTED SUM: ${scenario} ${framework}: sum=${got.sum} expected=${expected.sum}`);
    }
    if (expected.count != null && got.count !== expected.count) {
        fail(v, `EXPECTED COUNT: ${scenario} ${framework}: count=${got.count} expected=${expected.count}`);
    }
}

// --- emit the verdict + set exit code --------------------------------------------

export function reportVerdict(v) {
    if (v.ok) return true;
    const bar = "!".repeat(98);
    console.log("");
    console.log(bar);
    console.log("INVALID RUN -- " + v.failures.length + " guard failure(s). These numbers are NOT publishable.");
    for (const f of v.failures) console.log("    ! " + f);
    console.log("See bench/lib/guards.mjs. Do not publish, do not diff against Andrii.");
    console.log(bar);
    process.exitCode = 1;
    return false;
}

// --- aggregator-side stamp consistency (F2) --------------------------------------

// files: [{ path, stamp }]. Returns { ok, reason, engineSha, protocol }.
// Refuses: any missing stamp; mixed engine hashes; mixed protocols; mixed hosts.
export function assertStampsConsistent(files) {
    if (files.length === 0) return { ok: false, reason: "no rep files found" };
    const missing = files.filter((f) => !f.stamp);
    if (missing.length) {
        return { ok: false, reason: `${missing.length} file(s) have no #STAMP line: ${missing.map((f) => f.path).join(", ")}` };
    }
    const engineShas = new Set(files.map((f) => f.stamp.engineSha256));
    if (engineShas.size > 1) {
        return { ok: false, reason: `mixed engine hashes across rep files (${engineShas.size} distinct) -- these are different engines, refusing to merge` };
    }
    const protocols = new Set(files.map((f) => f.stamp.protocol));
    if (protocols.size > 1) {
        return { ok: false, reason: `mixed protocols across rep files (${[...protocols].join(", ")}) -- cross-protocol merge is forbidden` };
    }
    if ([...protocols][0] === "shared-process-smoke") {
        return { ok: false, reason: `these files were captured under shared-process-smoke; that protocol is never publishable (see F4)` };
    }
    const hosts = new Set(files.map((f) => f.stamp.cpu + "|" + f.stamp.node + "|" + f.stamp.arch));
    if (hosts.size > 1) {
        return { ok: false, reason: `mixed hosts across rep files (${hosts.size} distinct) -- cross-host comparison reintroduces the contamination cold processes remove` };
    }
    return { ok: true, engineSha: [...engineShas][0], protocol: [...protocols][0], host: [...hosts][0] };
}

// Verify the claimed rep count matches files on disk. Kills "median of 10" over 5 files.
export function assertRepCount(files, claimedReps, engineKey) {
    if (files.length !== claimedReps) {
        return { ok: false, reason: `${engineKey}: claimed reps=${claimedReps} but ${files.length} rep file(s) on disk` };
    }
    return { ok: true };
}
