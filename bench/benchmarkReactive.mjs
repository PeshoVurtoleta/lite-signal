// benchmarkReactive.mjs -- RETIRED (obsolete as of bench protocol v3).
//
// This harness is superseded. Every shape it measured now lives in the unified mirror,
// under a strictly better protocol (per-row cold-process isolation, counter/checksum
// verification against Andrii's log, machine-stamped provenance):
//
//   - its dependency-graph / dynamic shapes  -> bench/mirror.mjs  (17 rows, counter-verified)
//   - the kairo / fan / mol / sBench families -> bench/lib/micro-suites.mjs (30 rows)
//
// Together that is the full 47-row js-reactivity-benchmark field in ONE run.
//
// Why it was retired, not kept as a second opinion:
//   * It ran the five-engines-in-one-process "smoke" protocol -- the origin of the
//     phantom "lite is ahead on the dyn family / large web app" claim that the mirror,
//     the microscope, and Andrii's own log all contradict once measured in isolation.
//   * Two harnesses measuring the same shapes is exactly the split-brain (one shape,
//     several verdicts) the v3 rebuild exists to eliminate. One field, one protocol.
//
// Run the field instead:
//   node --expose-gc bench/mirror.mjs               # full 47-row field, one process
//   node --expose-gc bench/sweep.mjs                # 47 rows, per-row cold isolation
//   node --expose-gc bench/mirror.mjs --self-verify # counters vs Andrii's log (9/9)
//   node bench/vs-andrii.mjs <local> <andrii-log>   # counter-validated join

console.error(
    "benchmarkReactive.mjs is RETIRED (bench protocol v3).\n" +
    "The full 47-row field now runs unified in the mirror:\n" +
    "  node --expose-gc bench/mirror.mjs        (one process)\n" +
    "  node --expose-gc bench/sweep.mjs         (per-row cold isolation)\n" +
    "See bench/README.md -> 'The three instruments'."
);
process.exit(2);
