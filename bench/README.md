# Benchmark methodology

This folder benchmarks `@zakkster/lite-signal` against the reactive-signals field. It is built around one rule: **no number is publishable unless the harness can prove it measured identical work under a stamped, reproducible protocol.** Every mechanism below exists to make that rule enforceable by code rather than by trust.

The harness rebuild (bench protocol v3) replaced a set of hand-maintained result files that had drifted from the code producing them. If you are looking for the short version: run the commands in [Run order](#run-order), read the [three instruments](#the-three-instruments), and trust nothing that lacks a `#STAMP` line.

---

## The three instruments

Each has one job and one fixed configuration. They never borrow config from each other — mixing purposes is the specific failure this rebuild corrects.

| instrument | file | config | measures |
| :--- | :--- | :--- | :--- |
| **Microscope** | `benchmark.mjs` | **eager, right-sized pools, default flush** (lite's *recommended production* config) | time on six first-party shapes, with the anti-DCE sink (its `heapMed` / `heapP95` columns are not an allocation measurement; see "Reading the output") |
| **Mirror** | `mirror.mjs` + `sweep.mjs` | **Andrii's committed adapter config**: `262144 / 1048576 / lazy / throw / destroy()+rebuild` (his adapter at fb10dd9, liteSignal.ts:4-15; `mirror.mjs` builds the same config and, per reset, destroys the registry and creates a fresh one) | cross-framework standing on a port of the community suite; rows are joined to his log by `vs-andrii.mjs`, which voids a row whose counters differ |
| **Version economics** | `harness/toe-to-toe` | frozen per-version engines | lite-vs-lite deltas across versions and capability-on costs |

The microscope shows lite **at its recommended config on representative shapes**. The mirror shows lite **under the community benchmark's exact adapter** — a stricter, neutral cross-framework ranking. Both are reported. They can disagree, because they measure different things (lite's eager production pool vs Andrii's lazy oversized pool), and the honest position lives in the union of the two, not in cherry-picking one.

---

## Run order

Requires `--expose-gc` on every command. Install deps first (`npm i`).

```sh
# 1. Check the mirror's 9 counter-bearing dynamic rows against the counters from Andrii's log (must print 9/9 MATCH; the other rows are not checked).
node --expose-gc bench/mirror.mjs --self-verify

# 2. The microscope (time only; zero-GC is gated by `npm run test:torture`, not here) — lite's recommended config, six first-party shapes.
node --expose-gc bench/benchmark.mjs

# 3a. The cross-framework sweep -- per-row cold-process isolation, round-robin, sentinel.
#    Calibrate the drift tolerance to your host's self-noise first.
#    Writes bench/sweep-runs/ (SWEEP_DIR=<dir>); exits 2 before the first fork if any
#    *-rep*.txt is already there. SWEEP_TIMEOUT_MS=<ms> (default 120000) kills a hung
#    row with SIGKILL and fails the sweep.
DRIFT_TOL=0.05 node --expose-gc bench/sweep.mjs

# 3b. Or: per-engine mirror reps (FW=<engine> mirror.mjs, lite-signal + alien-signals,
#    round-robin, one cold process per rep) -> bench/mirror-runs/. Exits 2 if any rep
#    file, .txt.partial or COMPLETE is already there: copy the old set aside first.
REPS=10 bash bench/run-all-mirror.sh

# 4. Format a COMPLETE capture into a stamped results file (refuses bad captures: exit 1, or exit 2 if the directory has no rep files).
node bench/report.mjs bench/sweep-runs <andrii-log> > results-mirror.txt
node bench/report.mjs bench/mirror-runs <andrii-log> > results-mirror.txt

# 5. Join one local rep file against Andrii's log. The local #STAMP is required. A teardown
#    other than "destroy" needs [andrii-engine] (reset -> lite-signal-reset, which exists
#    only in the maintainer's local copy of his repo), else exit 2.
node bench/vs-andrii.mjs <local-mirror> <andrii-log> lite-signal [andrii-engine]
```

If step 1 fails after an engine change, the harness has drifted from Andrii's suite — that is a bug in the port or a change upstream, not a result. Fix it before benching.

---

## Captures and the COMPLETE marker

`sweep.mjs` and `run-all-mirror.sh` never delete or overwrite a capture. A finished capture directory carries a `COMPLETE` file (JSON: `kind`, `writer`, `protocol`, `reps`, `engines`) written last, via tmp + rename, and only when the run exits 0.

- `run-all-mirror.sh` writes each rep as `<engine>-rep<k>.txt.partial` and renames it to `.txt` only when that `mirror.mjs` process exits 0. A failing rep stops the run (`set -e`) and stays `.partial`; `report.mjs` ignores it and the next run refuses to start while it exists. It refuses (exit 2, before any run) if any `mirror-runs/*-rep*.txt`, `*-rep*.txt.partial` or `COMPLETE` exists.
- `sweep.mjs` refuses (exit 2, before the first fork) if its directory holds any `*-rep*.txt` or a `COMPLETE`. It writes no `COMPLETE`, and exits non-zero, when a child times out, prints no row or stamp, exits non-zero (even after printing its row) or prints a `#GUARD` line, when the sentinel times out, drifts beyond `DRIFT_TOL` or cannot be measured, or when the aggregate stamp / rep-count check fails.
- `report.mjs` exits 2 on a directory with no `<engine>-rep<N>.txt` files, and refuses (exit 1) a directory with no readable `COMPLETE`, a marker whose protocol disagrees with the stamps, a marker whose `reps` or `engines` disagree with the files on disk, unequal rep counts across engines, or an unknown protocol id.
- Consequence: the tracked Oct-12 `bench/mirror-runs/` set has no `COMPLETE`, so `node bench/report.mjs bench/mirror-runs ...` (and `npm run report` in `bench/`, which runs `report.mjs` with that default directory) now exits 1. Move or copy that set aside before capturing a new one.

---

## Provenance: the machine stamp

Every output begins with a machine-generated `#STAMP`: engine sha256, harness sha256, the **live** registry config (echoed from the same frozen object handed to `createRegistry`, so a header can never disagree with the code that ran), protocol id, host, node version, reps. The protocol id is `isolated-per-row` (one cold process per engine and scenario: `sweep.mjs`), `isolated-per-engine` (`FW=<engine>` without `SCENARIO`: `run-all-mirror.sh`; rows share one process) or `shared-process-smoke` (no `FW`, or `FW` naming more than one engine: never publishable). Hand-written factual headers are abolished — they are how the previous result files came to claim "eager" while running `sab`, and "median of 10" over five files on disk.

```
# ==== BENCH STAMP v1 (machine-generated -- do not hand-edit) ====
# protocol    : isolated-per-row  reps=10
# host        : Apple M4 Pro  darwin/arm64  node v26.3.1  gc=on
# engine.sha  : 65b2346069e621...
# config      : {"maxNodes":262144,"maxLinks":1048576,"prealloc":"lazy",...}
```

Aggregation refuses to merge rep files whose stamps disagree (mixed engine hash, mixed protocol, mixed host) or whose count does not match the claimed reps. `report.mjs` will not generate a results file from an inconsistent capture or from one without a matching `COMPLETE` marker.

---

## Validity guards

Failures set a non-zero exit and print `INVALID RUN`. A number that failed a guard is not a slow number — it is not a number.

- **Dead-sink** — an effect never re-ran in the timed loop (the classic way a benchmark reports impossible throughput). The microscope's anti-DCE sink is the enforcement; see below.
- **Counter-agreement** — on a deterministic shape, every framework must report the same `edgesTraversed` / `nodesRecomputed`. Equal counters *prove* equal work — a stronger guarantee than a live sink, because it catches an engine that silently skips propagation. `mirror.mjs` runs this guard across the engines that ran in ONE process; with one engine per process (`sweep.mjs`, `run-all-mirror.sh`) it compares nothing, so there the counters are checked only by `mirror.mjs --self-verify` and `vs-andrii.mjs`.
- **Checksum / expected** — fan-out shapes carry checksums; pull/push shapes carry hard `expected {sum, count}` vectors verified at full scale.
- **Sentinel drift** — the first combo is re-measured last; drift beyond `DRIFT_TOL` marks the whole sweep thermally suspect. Calibrate the tolerance to the host: a quiet M4 at full scale wants ~5%; sub-10ms measurements on a shared box need more headroom.

---

## The anti-DCE sink (microscope)

V8's escape analysis deletes computations it can prove have no observable effect. Every effect in the microscope writes its value into a `Float64Array(4096)` rooted on `globalThis`; after each timed loop the sink is summed into `BENCH_SINK_SUM` and checked against a hand-computed expected value. Any elided or skipped work changes the sum and tags the row `sink=[ ]`. The sum is a contract, not a soft check, and it is identical for every library — the workload is fixed, so a "faster" adapter that writes less is caught on the first run.

Properties that make it un-foldable: a typed array (typed-element store IC V8 cannot elide), rooted on `globalThis` (always reachable), read *after* the loop (every write is load-bearing), indexed with a power-of-two bitmask (`& (SIZE-1)`, no per-write division). `--expose-gc` is mandatory or the heap readings are meaningless.

---

## The six microscope workloads

The three former "~Andrii approximation" shapes (LARGE WEB APP, WIDE DENSE, SMALL SELECTIVE) were **removed** in v3. They were self-described non-1:1 ports and produced a shape name that carried three different verdicts across the old result files. Their real versions now run in the **mirror** under their real names, with counters and expected-value verification. One shape name, one definition, repo-wide.

| Scenario | N | What it stresses |
| :--- | :--- | :--- |
| MUX | 256 | Fan-in dependency tracking — per-edge allocation when one node has many sources. |
| BROADCAST | 1000 | Observer-list iteration — walking one signal's subscriber list. |
| KAIROS | 1000 | Glitch-freedom — mark-stale-then-pull-once vs redundant recompute. |
| DEEP CHAIN | 256 | Call-stack depth — iterative vs recursive propagation on a long pipeline. |
| DYNAMIC DAG | 960 | Read-order stability — re-tracking cost when read order inverts each iteration. |
| SELECTIVE DAG | 960 | Edge churn — hot-path cost of dropping and adding dependency links mid-run. |

### Reading the output

```
lite-signal   median=  21.83ms min=  21.76ms ops/s=916K   heapMed= 0.0KB   heapP95= 0.3KB   retained=  <KB>   sink=[x]
```

The numbers in this block are a layout example, not a measurement.

- **median / min** — median of `RUNS` timed runs; min alongside so distribution tightness is visible.
- **heapMed** -- median over runs of (heapUsed + arrayBuffers read at the end of the run) minus (the same sum read after a forced GC just before the run). There is no GC at the end of the run, so once a run allocates more than the young generation the delta reads young-generation fill, not the run's allocation. It is NOT an allocation measurement and no published figure rests on it; a corrected gauge is planned after 1.6.0.
- **heapP95** -- 95th percentile of the same per-run deltas; the same caveat applies.
- **retained** -- post-run post-GC heap minus the pre-setup heap, floored at 0 (live graph + pools); > 0 on a correct run.
- **sink** — `[x]` if the anti-DCE sum matched; `[ ]` invalidates the row.

---

## Results: how to read them honestly

The microscope publishes **time only**; its `heapMed` / `heapP95` columns are withdrawn (see `heapMed` above). The zero-GC claim is gated by `npm run test:torture` (lite-leak + lite-gc-profiler) and the node:test GC-count tests, not by this microscope (`npm run torture` is the scenario runner, a different thing). Throughput on lite's recommended eager config:

- The DYNAMIC DAG and SELECTIVE DAG payload values leave the small-integer range, so the allocation those rows show is V8 number boxing in the benchmark body, not engine allocation.
- On **throughput**, lite is competitive-to-winning on this shape set: ahead on BROADCAST, MUX, and SELECTIVE DAG; ahead of alien on DYNAMIC DAG; within ~11% of alien on KAIROS.
- The consistent **weakness is deep/layered propagation** (DEEP CHAIN: alien ~2× faster). A flatter representation wins when the propagation path is long rather than wide. This is real and unhidden.

Under the **mirror** (Andrii's lazy cross-framework adapter, a stricter neutral ranking), lite is slower on the dynamic/app propagation shapes. Both pictures are true; the honest headline is **"competitive throughput on the microscope shapes"** — not "fastest reactive engine." Any public number cites its `(stamp, protocol)` or it is not made.

> Note on adapters: a reused, warmed **singleton** registry across a micro-benchmark suite skips pool-growth and teardown that fresh-per-test instances pay. Andrii's committed adapter resets (`destroy()` + fresh registry) between benches, which is the fair setup. The mirror's `reset()` does the same (`mirror.mjs`: `reg.destroy()`, then `createRegistry(LITE_CONFIG)`); the microscope pre-sizes per scenario. Neither reuses a warmed pool across unrelated shapes to flatter a comparison.

---

## Structure probes (`lib/structure-probe.mjs`)

`lib/structure-probe.mjs` exists: it reads `onGraphMutation` and counts `recomputed / maxRecompute / flushPasses / churnPerRecompute / poolGrowths`. Nothing imports it and `mirror.mjs` does not fold its metrics into the metrics column, so it is not wired in and no result here rests on it. Wiring it is planned after 1.6.0.

---

## Torture soaks (`bench/torture/`)

Not benchmarks. The last duration-bound crash-detection soak, `scheduler-bench.mjs`, was retired 2026-10-29 (absorbed by the `bench/soak` SCHEDULER lane; see the RETIRED block in `bench/torture/MANIFEST.txt`). The one soak left in `bench/torture/` is the opt-in `wraparound-torture` (`TORTURE_WRAPAROUND=1`, ~30 s).

```sh
TORTURE_WRAPAROUND=1 node --expose-gc bench/torture/wraparound-torture.mjs
```

---

## Self-validation: linear scaling

Work being eliminated by the optimizer scales sublinearly. Run the microscope at 10× iterations; every well-behaved row should be ~10× the time within noise. A row that stays flat is being elided and cannot be trusted.

```sh
ITERATIONS=200000 node --expose-gc bench/benchmark.mjs
```

---

## Legacy: `benchmarkReactive.mjs` and the smoke runner

`benchmarkReactive.mjs` (five engines in one process) is the **superseded** reactive path; the shell runner `run-all-reactive.sh` that drove it has been removed. That shared-process protocol is the origin of the retired "lite is ahead on the dyn family / large web app / wide dense" claim, which the mirror, the microscope, and Andrii's own log all contradict once measured under an isolated protocol. Both are retired: `benchmarkReactive.mjs` is now a stub that prints a retirement notice and exits 2. Files stamped `shared-process-smoke` (`bench/lib/stamp.mjs`) are still **hard-refused** by `bench/aggregate.mjs` for any publishable table; never cite their numbers. New reactive standing comes from `sweep.mjs`.

`run-all-bench.sh` (microscope, one engine per cold process) schedules its reps round-robin (`lib/schedule.mjs`) rather than `for eng; for rep` — engine-major ordering pins the last engine to the hottest chassis (the bias that faked a monotonic trend across sha-identical engines). `sweep.mjs` and `run-all-mirror.sh` do the same for the mirror.

---

## Standing rules (enforced by the harness, not by prose)

1. No number is published unless its file carries a stamp, the run exited 0 and (for a mirror capture) its directory carries `COMPLETE`.
2. The mirror is a port of Andrii's suite, not a copy: a counter divergence for identical engine bytes is a harness bug (`mirror.mjs --self-verify`), and shape edits happen only by re-porting from his source.
3. One shape name = one definition, repo-wide. Approximations are deleted, not renamed.
4. lite's config is fixed per instrument and echoed by the stamp. `sab` is a production feature, not a benchmark knob — it only differs from default under un-batched drives, where it must go through `batch()`/`flush()` or the sink is dead (guarded).
5. Cross-protocol / cross-host comparisons cite `(stamp, protocol)` or are not made.

---

## Bench package versioning

The bench harness is its own package (`lite-signal-bench`), versioned independently of the engine. v3.0.0 is the protocol rebuild: stamps, guards, the mirror/sweep/report toolchain, per-run heap fencing, and the removal of the three impostor shapes. Engine version lives at the repo root.
