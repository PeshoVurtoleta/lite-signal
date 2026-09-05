# Benchmark methodology

This folder benchmarks `@zakkster/lite-signal` against the reactive-signals field. It is built around one rule: **no number is publishable unless the harness can prove it measured identical work under a stamped, reproducible protocol.** Every mechanism below exists to make that rule enforceable by code rather than by trust.

The harness rebuild (bench protocol v3) replaced a set of hand-maintained result files that had drifted from the code producing them. If you are looking for the short version: run the commands in [Run order](#run-order), read the [three instruments](#the-three-instruments), and trust nothing that lacks a `#STAMP` line.

---

## The three instruments

Each has one job and one fixed configuration. They never borrow config from each other — mixing purposes is the specific failure this rebuild corrects.

| instrument | file | config | measures |
| :--- | :--- | :--- | :--- |
| **Microscope** | `benchmark.mjs` | **eager, right-sized pools, default flush** (lite's *recommended production* config) | throughput + allocation on six first-party shapes, with the anti-DCE sink |
| **Mirror** | `mirror.mjs` + `sweep.mjs` | **Andrii's canonical adapter** verbatim: `lazy / 131072 / 1048576 / default eager / destroy()+rebuild` | cross-framework standing on the community suite; rows diff 1:1 against his log |
| **Version economics** | `harness/toe-to-toe` | frozen per-version engines | lite-vs-lite deltas across versions and capability-on costs |

The microscope shows lite **at its recommended config on representative shapes**. The mirror shows lite **under the community benchmark's exact adapter** — a stricter, neutral cross-framework ranking. Both are reported. They can disagree, because they measure different things (lite's eager production pool vs Andrii's lazy oversized pool), and the honest position lives in the union of the two, not in cherry-picking one.

---

## Run order

Requires `--expose-gc` on every command. Install deps first (`npm i`).

```sh
# 1. Prove the mirror measures identical work to Andrii's suite (must print 9/9 MATCH).
node --expose-gc bench/mirror.mjs --self-verify

# 2. The zero-GC microscope — lite's recommended config, six first-party shapes.
node --expose-gc bench/benchmark.mjs

# 3. The cross-framework sweep — per-row cold-process isolation, round-robin, sentinel.
#    Calibrate the drift tolerance to your host's self-noise first.
DRIFT_TOL=0.05 node --expose-gc bench/sweep.mjs

# 4. Format a captured sweep into a publishable, stamped results file (refuses bad captures).
node bench/report.mjs bench/mirror-runs <andrii-log> > results-mirror.txt

# 5. Join local rows against Andrii's log; validates via counters, voids invalid comparisons.
node bench/vs-andrii.mjs <local-mirror> <andrii-log> lite-signal
```

If step 1 fails after an engine change, the harness has drifted from Andrii's suite — that is a bug in the port or a change upstream, not a result. Fix it before benching.

---

## Provenance: the machine stamp

Every output begins with a machine-generated `#STAMP`: engine sha256, harness sha256, the **live** registry config (echoed from the same frozen object handed to `createRegistry`, so a header can never disagree with the code that ran), protocol id, host, node version, reps. Hand-written factual headers are abolished — they are how the previous result files came to claim "eager" while running `sab`, and "median of 10" over five files on disk.

```
# ==== BENCH STAMP v1 (machine-generated -- do not hand-edit) ====
# protocol    : isolated-per-row  reps=10
# host        : Apple M4 Pro  darwin/arm64  node v26.3.1  gc=on
# engine.sha  : 65b2346069e621...
# config      : {"maxNodes":131072,"maxLinks":1048576,"prealloc":"lazy",...}
```

Aggregation refuses to merge rep files whose stamps disagree (mixed engine hash, mixed protocol, mixed host) or whose count does not match the claimed reps. `report.mjs` will not generate a results file from an inconsistent capture.

---

## Validity guards

Failures set a non-zero exit and print `INVALID RUN`. A number that failed a guard is not a slow number — it is not a number.

- **Dead-sink** — an effect never re-ran in the timed loop (the classic way a benchmark reports impossible throughput). The microscope's anti-DCE sink is the enforcement; see below.
- **Counter-agreement** — on a deterministic shape, every framework must report the same `edgesTraversed` / `nodesRecomputed`. Equal counters *prove* equal work — a stronger guarantee than a live sink, because it catches an engine that silently skips propagation. In the M4 mirror run, lite and alien agree on every shape's counters.
- **Checksum / expected** — fan-out shapes carry checksums; pull/push shapes carry hard `expected {sum, count}` vectors verified at full scale.
- **Sentinel drift** — the first combo is re-measured last; drift beyond `DRIFT_TOL` marks the whole sweep thermally suspect. Calibrate the tolerance to the host: a quiet M4 at full scale wants ~5%; sub-10ms measurements on a shared box need more headroom.

---

## The anti-DCE sink (microscope)

V8's escape analysis deletes computations it can prove have no observable effect. Every effect in the microscope writes its value into a `Float64Array(4096)` rooted on `globalThis`; after each timed loop the sink is summed into `BENCH_SINK_SUM` and checked against a hand-computed expected value. Any elided or skipped work changes the sum and tags the row `sink=[ ]`. The sum is a contract, not a soft check, and it is identical for every library — the workload is fixed, so a "faster" adapter that writes less is caught on the first run.

Properties that make it un-foldable: a typed array (typed-element store IC V8 cannot elide), rooted on `globalThis` (always reachable), read *after* the loop (every write is load-bearing), indexed with a power-of-two bitmask (`& (SIZE-1)`, no per-write division). `--expose-gc` is mandatory or the heap columns are meaningless.

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
lite-signal   median=  21.83ms min=  21.76ms ops/s=916K   heapMed= 0.0KB   heapP95= 0.3KB   retained= 0.0KB   sink=[x]
```

- **median / min** — median of `RUNS` timed runs; min alongside so distribution tightness is visible.
- **heapMed** — MEDIAN transient heap per timed run, GC-fenced around *each* run. (v3 fix: the old single Δheap smeared one run's GC across the average and needed an apology paragraph. Per-run fencing removed both.)
- **heapP95** — 95th-percentile of the same per-run deltas — the allocation tail, shown separately instead of hidden in a mean.
- **retained** — heap surviving a forced GC — the steady-state live-graph cost. Near-zero for a well-behaved engine.
- **sink** — `[x]` if the anti-DCE sum matched; `[ ]` invalidates the row.

---

## Results: how to read them honestly

The claim that reproduces on any host is about **allocation, not raw propagation speed**. Representative M4 Pro / Node 26 microscope figures (lite's recommended eager config):

- lite runs at `retained = 0.0KB` on every shape (true zero-GC steady state), with `heapMed` from **33× to ∞ lower** than the field — e.g. DEEP CHAIN `0.0KB` vs alien's ~1MB, DYNAMIC DAG ~40× under alien, KAIROS ~33× under alien.
- On **throughput**, lite is competitive-to-winning on this shape set: ahead on BROADCAST, MUX, and SELECTIVE DAG; ahead of alien on DYNAMIC DAG; within ~11% of alien on KAIROS.
- The consistent **weakness is deep/layered propagation** (DEEP CHAIN: alien ~2× faster). A flatter representation wins when the propagation path is long rather than wide. This is real and unhidden.

Under the **mirror** (Andrii's lazy cross-framework adapter, a stricter neutral ranking), lite is slower on the dynamic/app propagation shapes while remaining dominant on allocation. Both pictures are true; the honest headline is **"competitive throughput with one-to-four orders of magnitude less GC pressure"** — not "fastest reactive engine." Any public number cites its `(stamp, protocol)` or it is not made.

> Note on adapters: a reused, warmed **singleton** registry across a micro-benchmark suite skips pool-growth and teardown that fresh-per-test instances pay. Andrii's adapter now resets (`destroy()` + fresh registry) between benches, which is the fair setup. The mirror uses his reset adapter verbatim; the microscope pre-sizes per scenario. Neither reuses a warmed pool across unrelated shapes to flatter a comparison.

---

## Structure probes (`lib/structure-probe.mjs`)

A timing regression is far more actionable with its structural cause attached. The probe reads `onGraphMutation` and folds `recomputed / maxRecompute / flushPasses / churnPerRecompute / poolGrowths` into the mirror's metrics column (free; absent on reference engines). It reproduces `harness/burst-dag.mjs`'s numbers exactly. Already useful: on the burst shape lite reports `maxRecompute=1, flushPasses=0` — zero redundant work — so its burst cost is per-node path length, not waste.

---

## Torture soaks (`bench/torture/`)

Not benchmarks — crash-detection soaks. Each runs for a configurable duration and asserts (1) zero thrown exceptions and (2) `activeNodes`/`activeLinks` return to baseline after a settle pass. Exit `0` iff both hold.

| File | Stresses |
| :--- | :--- |
| `graph-fuzzer.mjs` | 1,500-node random DAG; mixed writes, rewiring, nested batch + untrack. |
| `scheduler-bench.mjs` | 1,500 microtask-scheduled effects; concurrent writes during drains. |
| `torture-soak.mjs` | 7,500-node graph; continuous writes + rewiring; pool-growth + free-list recycle. |

```sh
TORTURE_SECONDS=30 node --expose-gc bench/torture/torture-soak.mjs
```

---

## Self-validation: linear scaling

Work being eliminated by the optimizer scales sublinearly. Run the microscope at 10× iterations; every well-behaved row should be ~10× the time within noise. A row that stays flat is being elided and cannot be trusted.

```sh
ITERATIONS=200000 node --expose-gc bench/benchmark.mjs
```

---

## Legacy: `benchmarkReactive.mjs` and the smoke runner

`benchmarkReactive.mjs` and `run-all-reactive.sh` (five engines in one process) are the **superseded** reactive path. That shared-process protocol is the origin of the retired "lite is ahead on the dyn family / large web app / wide dense" claim, which the mirror, the microscope, and Andrii's own log all contradict once measured under an isolated protocol. The smoke runner is demoted: its output is stamped `shared-process-smoke`, and the aggregator **hard-refuses** those files for any publishable table. Keep it only as a fast smoke check; never cite its numbers. New reactive standing comes from `sweep.mjs`.

`run-all-bench.sh` (microscope, one engine per cold process) is retained but should schedule round-robin rather than `for eng; for rep` — engine-major ordering pins the last engine to the hottest chassis (the bias that faked a monotonic trend across sha-identical engines). `sweep.mjs` already does this for the mirror.

---

## Standing rules (enforced by the harness, not by prose)

1. No number is published unless its file carries a stamp and the run exited 0.
2. The mirror tracks Andrii verbatim; divergence for identical engine bytes is a harness bug (`mirror.mjs --self-verify`). Shape edits happen only by re-porting from source.
3. One shape name = one definition, repo-wide. Approximations are deleted, not renamed.
4. lite's config is fixed per instrument and echoed by the stamp. `sab` is a production feature, not a benchmark knob — it only differs from default under un-batched drives, where it must go through `batch()`/`flush()` or the sink is dead (guarded).
5. Cross-protocol / cross-host comparisons cite `(stamp, protocol)` or are not made.

---

## Bench package versioning

The bench harness is its own package (`lite-signal-bench`), versioned independently of the engine. v3.0.0 is the protocol rebuild: stamps, guards, the mirror/sweep/report toolchain, per-run heap fencing, and the removal of the three impostor shapes. Engine version lives at the repo root.
