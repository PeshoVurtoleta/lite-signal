// aggregateReactive.mjs -- RETIRED (bench protocol v3).
//
// This aggregated benchmarkReactive.mjs output (bench-reactive-runs/). Both are gone:
// the reactive field is now measured by the unified mirror, and aggregation is done by
// the sweep + report/collect path with stamp-consistent provenance.
//
// Replacement:
//   node --expose-gc bench/sweep.mjs         # 47-row field, per-row cold isolation
//   node bench/report.mjs bench/mirror-runs  # stamped, guarded results file
console.error("aggregateReactive.mjs is RETIRED. Use bench/sweep.mjs + bench/report.mjs (see bench/README.md).");
process.exit(2);
