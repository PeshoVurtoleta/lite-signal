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

export function makeVerdict() {
    return { failures: [], ok: true };
}

function fail(v, msg) {
    v.failures.push(msg);
    v.ok = false;
}

// --- per-row checks --------------------------------------------------------------

export function checkDeadSink(v, label, sinkValue) {
    if (!(sinkValue !== 0)) fail(v, `DEAD SINK: ${label} finished with sink=0 (effect never re-ran; timing measures nothing)`);
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
