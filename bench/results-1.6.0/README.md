# bench/results-1.6.0 -- time-only results on the final engine

Tier: REPORTED (measurements, no gate). Time only: no heap figure is published here.
Every file in this directory is either a verbatim copy of a captured log or the output
of bands.mjs over the committed rep files. Numbers are medians in ms, lower is better.

## Common to all three captures
- Engine: Signal.js sha256 a7202c9b (full: a7202c9bb9af63007a76662330aa43b40e40442c80493347a3711dd23789bf89).
- Host: Apple M4 Pro, 12 cores, darwin/arm64, node v26.8.2. 10 reps per engine. Dates 2026-11-23 / 2026-11-24.
- Host state, from the .prov files: quiet-lock baseline 2.21; every PRE and POST check printed QUIET; AC power; "Using Batt" lines in each window: 0.

## The three protocols
1. microscope (microscope-time.txt): isolated-per-engine, round-robin, 5 engines, 6 scenarios.
   Window 2026-11-23 23:14:23 .. 2026-11-24 00:00:06 EET (21:14:23Z .. 22:00:06Z). HEAD 9ccc286.
   PRE load1 2.61, POST load1 1.27. AC 100%, charged. No node process at >= 1% CPU at PRE or POST.
   Raw reps: bench/bench-runs/ (50 rep files + COMPLETE). Stamps carry no captureId.
2. mirror (mirror-report.txt, mirror-bands.txt): isolated-per-engine shared harness (one cold process per engine ran all 47 rows in a fixed order; a row can depend on the rows before it), 3 engines.
   Capture 20261123T221116Z-c3010561. Window 2026-11-24 00:11:15 .. 00:19:48 EET (22:11:15Z .. 22:19:48Z). HEAD 9ccc286.
   PRE load1 1.24, POST load1 2.04. AC 100%, charged. Raw reps: bench/mirror-runs/ (30 + COMPLETE).
   mirror-report.txt says VALIDATED 47 rows, 141 of 141 engine cells.
3. sweep (sweep.txt, sweep-report.txt, sweep-bands.txt): isolated-per-row (every engine/row in its own cold process), scenario-major Williams schedule, sentinel drift limit 5%, 3 engines, 1410 cold processes.
   Capture 20261124T001531Z-02a0b456. Window 2026-11-24 02:15:31 .. 02:25:22 EET (00:15:31Z .. 00:25:22Z). HEAD 0fffc59.
   PRE load1 1.46 with one other node process at 1.3% CPU; POST load1 2.58. AC charging, 93% at PRE, 97% at POST.
   Sentinel ratio 0.992x (stable). Raw reps: bench/sweep-runs/ (30 + COMPLETE).
   sweep-report.txt says VALIDATED 47 rows, 141 of 141 engine cells.

## Engine versions
Read from bench/node_modules/<package>/package.json on the authoring checkout (the rep-file stamps record the Signal.js sha256 only, not the other engines' versions): alien-signals 3.2.1, reflex-quant 1.2.0, solid-js 1.9.15, @preact/signals-core 1.14.4. bench/package.json declares ^3.2.1, 1.2.0, ^1.9.13, ^1.14.2.

## Band rule (bands.mjs)
- spread = (max - min) / median of the 10 per-rep medians (bench/lib/collect.mjs, perTestSpread).
- pair band = the larger of the two engines' spreads (as sweep.mjs does).
- delta = (other - lite) / other; + means lite faster.
- |delta| <= band is "inside the band": neither a win nor a loss. A win count counts only leads outside the band.
- The microscope prints no spread of its own; microscope-time.txt derives it from the 10 rep files.
- mirror-report.txt ends its table with "lite faster than alien on 6/47 shapes." and "lite faster than reflex-quant on 4/47 shapes."; those lines carry no band. mirror-bands.txt supersedes them.
- sweep-report.txt carries no spread column either, and its lines "lite faster than alien on 5/47 shapes." and "lite faster than reflex-quant on 1/47 shapes." carry no band; sweep.txt (the sweep log) and sweep-bands.txt carry the spreads, and sweep-bands.txt supersedes those lines.

## Files
- microscope-time.txt: time-only table cut by bands.mjs from bench/bench-runs. Its medians equal the 30 cells of the raw aggregate log (control b in bands.log). The raw aggregate log (also printing withdrawn heap columns) is .handoff/b253/microscope-aggregate.log, sha256 86bbe6c2c16ef9fdb88a775b467fc91ca31f04ae865c09e21cae273896c24529; re-derive the times with: node bench/aggregate.mjs --dir bench/bench-runs --reps 10.
- mirror-report.txt: verbatim copy of the report.mjs output (sha256 f7a81386a50cf7a1...). Re-derive: node bench/report.mjs bench/mirror-runs bench/AndriiVolynetsReactiveBench.log (identical except the Generated line; without the second argument the informational ANDRII JOIN section is omitted).
- mirror-bands.txt: bands.mjs, lite vs alien and lite vs reflex-quant, 47 rows each.
- sweep.txt: the sweep log with its carriage-return progress counters removed; every other line verbatim, including the sentinel line.
- sweep-report.txt: verbatim copy of the report.mjs output (sha256 945cdcf321c06fc5...).
- sweep-bands.txt: bands.mjs over bench/sweep-runs.
- cross-protocol.txt: mirror vs sweep, lite vs alien, per row (rule at its top).
- bands.log: stdout of the control run (node .handoff/b255/bands.mjs controls).
- bands.mjs: untracked, at .handoff/b255/bands.mjs (not shipped), sha256 411ece0fe197371b694aecd118cb069403bd0cce5aa53e6c7e22e0d9d644a8c1. It reads the committed rep files, runs nothing timed, and refuses (non-zero exit, no output file) on a missing rep, a non-finite or <= 0 time, a rep count other than 10, or mixed engine sha / captureId.

## Noisy-row measurement (no cause stated)
The two refused b253 sweeps on HEAD 9ccc286 flagged 14 (first) and 30 (second) lite/alien rows over 8% spread and were refused by the sentinel (LEDGER #90). The valid b254 capture flags 18 lite/alien rows over 8%; its 3-engine table flags 24 rows and its lite/reflex-quant table flags 22 (sweep.txt).
