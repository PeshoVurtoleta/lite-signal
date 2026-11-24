# Andrii js-reactivity-benchmark on lite-signal 1.6.0 (2026-11-24)

This folder holds this cycle's two Andrii js-reactivity-benchmark legs on lite-signal 1.6.0's final engine (node 26 and node 24), upstream's own published table, and a labelled projection of where 1.6.0 would land in it. Tier REPORTED: it gates nothing and every number is a measurement under the stated protocol, host, Node and run count.

Files: `summary.md` / `summary.json` (andrii-analyze output), `node26/HEADER.txt`, `node24/HEADER.txt` (leg headers), `clone-local.patch` (one copy: the two legs' patches are byte-equal, sha256 b7b8a129...; 5 untracked clone-local files).

## Provenance

- Engine build 6bcaaf1-a7202c9b: Signal.js a7202c9b, Watch.js e0cf8a8d, Signal.d.ts 0ec0367c; npm label `1.6.0-candidate+6bcaaf1.a7202c9b`.
- Clone 12f169b of volynetstyle/js-reactivity-benchmark (contains Andrii's harness fix f5afcf3).
- Host: Apple M4 Pro, 12 cores, darwin/arm64, AC power, run under `quiet-lock run --strict` (load baseline 2.21).
- leg-node26: node v26.8.2 (V8 14.6.202.34-node.28), 2026-11-24 04:21:11-04:50:08 EET, wall 1,737 s, load1 1.15 before / 1.98 after.
- leg-node24: node v24.15.0 (V8 13.6.233.17-node.48), 2026-11-24 04:51:09-05:18:46 EET, wall 1,657 s, load1 1.48 before / 1.57 after.
- Run count 1 per leg (3 rounds, profile quick). bundleSha256 0ab7cb36431b6d87885680ee10cfbc7f5a18af630c7c3e05e206892ab4cea647 is identical in both legs. 51 rows x 7 adapters, 0 failed, 0 void, 0 capped.
- Wrapper `bench/andrii-run.mjs`, analysis `bench/andrii-analyze.mjs`.
- Redaction: in the copied files only absolute home-directory path prefixes (user-home root plus user name) were replaced by `~`; nothing else changed.

| file | source sha256 | after redaction sha256 | replacements |
|---|---|---|---:|
| summary.md | 54d9892ffaf199b351e15f839828151be70deb0c490143efe29443dcabe1c012 | same (unchanged) | 0 |
| summary.json | 0a4edcf687eba14758d68e77579f86a7176c609999b5bbd8e82f7535f438b621 | same (unchanged) | 0 |
| node26/HEADER.txt | c675d073cfbf962690dc2d9607fa3529ab9e3f2ae2d043db4a827467368266c7 | 84ea7787d48fa54cd675a6b34c9c548afbcd1fde300cb41857ca7fdc7575e4a6 | 17 |
| node24/HEADER.txt | e869ed85ac2e027272a8018a21ccb0d729865f39b065444185967c99ae2e54e0 | 9a5f245bdadc921c2feacc1e59b4e845960010b9c082b82a30da3c2de59e7ee7 | 24 |
| clone-local.patch | b7b8a12923070ac92fec8582e626014d4c2914693f4a3f1a96fb60c46bb7618e | same (unchanged) | 0 |

## Adapters

- `lite-signal` and `lite-signal-eager`: npm 1.5.2, upstream's adapter shape (`destroy()` + a fresh registry per test), lazy / eager.
- `lite-signal-1.6` and `lite-signal-eager-1.6`: the 1.6.0 engine with the same destroy + rebuild shape.
- `lite-signal-reset` and `lite-signal-eager-reset`: the 1.6.0 engine with `registry.reset()`, which keeps the warmed pool. `bench/README.md` ("Note on adapters") calls destroy + rebuild the fair setup, so the reset rows are an adapter choice of this cycle and are never ranked against upstream's table.
- `alien-signals` 3.2.1.

## Local results (andrii-analyze protocol)

Geomean of time / alien over the 51 ranked rows, flat, per leg (summary.md). Lower is faster; alien = 1.0.

| adapter | node26 | node24 |
|---|---:|---:|
| LAZY: lite-signal-reset | 1.31839428 | 1.27392660 |
| LAZY: lite-signal-1.6 | 1.58490987 | 1.43231762 |
| LAZY: lite-signal (1.5.2) | 1.61263655 | 1.46296882 |
| EAGER: lite-signal-eager-reset | 1.43135906 | 1.33437263 |
| EAGER: lite-signal-eager (1.5.2) | 1.55447107 | 1.50764427 |
| EAGER: lite-signal-eager-1.6 | 1.60746274 | 1.62179391 |

- 1.6 vs 1.5.2 (per-row geomean of the ratio, node26 / node24): lazy 0.983 / 0.979; eager 1.034 / 1.076. The eager-1.6 adapter is SLOWER than eager 1.5.2 on both legs.
- reset vs destroy + rebuild on 1.6 (node26 / node24): lazy 0.832 / 0.889; eager 0.890 / 0.823.
- alien-signals wins the row on 44 / 42 of 51 (node26 / node24).
- Rank agreement between legs: LAZY and EAGER orders are identical; OVERALL is not (Spearman 0.821, max rank delta 2).

## Upstream's own table (MEASURED by upstream, not by us)

sourceCommit f0d456c, rendered 2026-11-16, node v24.15.0 linux/x64, 24 machine shards (Azure / AWS EPYC + Xeon, 4 cores), 3 machine rounds. Score = family-balanced geomean of time / per-test best over the 34 shared core scenarios (36 core minus "32x8 - 4 sources - push (pure push)" and "manyEffectsFromOneSource", excluded for every participant), median of the 3 machine-set scores. 30 participants, 29 ranked (dalien-signals unranked: 1 failed core scenario). lite-signal entered = npm 1.5.2. Excerpt: ranks 1-11 plus MobX (21) and SolidJS (23).

| rank | framework | score | 3-machine-set range |
|---:|---|---:|---|
| 1 | reflex-quant | 1.03 | 1.03-1.06 |
| 2 | alien-signals | 1.20 | 1.18-1.21 |
| 3 | reflex | 1.25 | 1.24-1.25 |
| 4 | @reactively | 1.63 | 1.60-1.65 |
| 5 | Preact Signals | 1.63 | 1.62-1.67 |
| 6 | @vue/reactivity 3.6 RC | 1.65 | 1.64-1.68 |
| 7 | anod | 1.83 | 1.82-1.85 |
| 8 | lite-signal (1.5.2) | 1.91 | 1.88-1.92 |
| 9 | rescript-signals | 1.92 | 1.89-1.92 |
| 10 | @maverick-js/signals | 2.05 | 2.01-2.05 |
| 11 | @vue/reactivity | 2.28 | 2.19-2.33 |
| 21 | MobX | 3.97 | 3.82-4.04 |
| 23 | SolidJS | 10.48 | 10.38-10.66 |

## Who is fastest in upstream's table

Lowest median per test:

- All 51 tests: reflex-quant 27, reflex 12, @vue/reactivity 3.6 RC 5, alien-signals 4, dalien-signals 2, s-js 1.
- 34 core tests: reflex-quant 21, reflex 10, alien-signals 1, dalien-signals 1, @vue/reactivity 3.6 RC 1.
- Decisive wins (upstream's rule: paired ratio range below 1): reflex-quant 16, reflex 5, alien-signals 1.
- lite-signal: 0 lowest medians, 0 decisive wins.

## Upstream's scorer on our legs

Upstream's exported `parseBenchOutput` run on each leg's run.log, filtered to upstream's 34 common core (commonTests identical to upstream's: true). Family-balanced geomean of time / per-test best, 4 decimals.

| adapter | node26 | node24 |
|---|---:|---:|
| alien-signals | 1.0431 | 1.0877 |
| lite-signal-reset | 1.3042 | 1.2947 |
| lite-signal-eager-reset | 1.4811 | 1.3905 |
| lite-signal-1.6 | 1.5861 | 1.4946 |
| lite-signal (1.5.2) | 1.5885 | 1.5005 |
| lite-signal-eager | 1.6531 | 1.6727 |
| lite-signal-eager-1.6 | 1.7742 | 1.9031 |

## PROJECTED placement of 1.6.0 (cross-host)

PROJECTED, cross-host: 1.907 / 1.903 -> 8th, inside 1.5.2's own range 1.88-1.92: no measurable change. The alien-normalised M1 (D-b169-1 Q4a) gives 1.825 / 1.650 (7th / 6th) but misses the known 1.5.2 point by -4.3% / -13.3%; no rank claim rests on it.

Values are node26 / node24. This is a projection from a different host and Node, not a measurement in upstream's table.

- M2 (delta transfer) = upstream's lite 1.5.2 score 1.9103 x (leg 1.6 / leg 1.5.2, family-balanced): node26 1.5861 / 1.5885 = 0.998456; node24 1.4946 / 1.5005 = 0.996074. M2 = 1.9074 / 1.9028.
- M1 (alien-normalised) = upstream alien 1.2004 x (leg 1.6 / leg alien): node26 1.5861 / 1.0431; node24 1.4946 / 1.0877. M1 = 1.8253 / 1.6495.
- Calibration of M1 on 1.5.2 (same formula with the 1.5.2 leg scores) = 1.8281 / 1.6560 against upstream's measured 1.9103: -4.3% / -13.3%.
- Neighbours in upstream's table: anod 1.83 (7th); rescript-signals 1.92 (9th, range 1.89-1.92, which overlaps lite's 1.88-1.92).
- Noise in upstream's own samples (latest.samples.json, "merged.noise", median SD of ln(time) over rows): betweenMachine 0.253 vs withinProcess 0.015.

## Protocols disagree

This cycle's local sweep (`bench/results-1.6.0/`, isolated per engine, 47 rows, 10 reps, lite / alien / reflex-quant; sweep-bands.txt) has alien-signals lowest median on 28 of 47 rows, reflex-quant 16, lite-signal 1, ties 2. Upstream's table (above) has reflex-quant lowest on 27 of 51 (this repo's count over upstream's samples). The protocols, hosts and participant sets differ; there is no single "fastest".

## Evidence route

The upstream and projection numbers come from a small probe that imports upstream's exported `parseBenchOutput` (clone 12f169b, `scripts/render-results-page.mjs`) and runs it on `bench-results/latest.log` and on each leg's `run.log`, filtered to upstream's 34 common core. The probe is not in the repo. `samples.json` (2.6 MB per leg) and the raw logs are not tracked (D-b169-1 Q5 a); they live in the maintainer's gitignored `.handoff` evidence.

## History

The old "4th of 15" (1.5.0-beta, 15 libraries, 47 tests, plain geomean in ms, Andrii's host, `bench/AndriiVolynetsReactiveBench.log`) is history, superseded by the table above.
