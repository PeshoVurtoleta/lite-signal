# lite-signal version matrix

A performance gate for `@zakkster/lite-signal` that turns "did this release regress?"
from a judgment call into a checkpoint. It profiles each engine version in a cold
process against a set of reactive workloads and blocks a release that regresses.

## Methodology (why the numbers are trustworthy)

- **One engine per cold process.** Each version is profiled in its own `node`
  invocation, so V8 never carries inline caches or JIT state from one engine into
  another. The driver swaps the version into `node_modules` and re-runs.
- **Deterministic input.** An LCG feeds an identical write sequence to every engine,
  so a delta is the engine changing, not the input.
- **Median-of-N.** Each version x workload is captured N times (default 5) and reduced
  to a per-metric median. A single cold sample is noisy enough that two captures of the
  *same* version can differ ~10% on `frame.avg`; medians make a tight gate honest.
- **Same-host gating.** The gate re-captures floor, rolling, and candidate in one run on
  one host. It never diffs against a baseline captured elsewhere -- cross-host comparison
  reintroduces exactly the contamination the cold-process rule removes.
- **Calibrated tolerances.** `frame.avg` is the stable anchor (self-noise <=~3%, gated
  tight at 5% vs rolling). `frame.p99` / `phase.write.p99` are jitter-prone (self-noise
  up to ~14%), so their tolerances sit above that floor and a p99 fail should be confirmed
  with a re-run. Run `npm run calibrate` to measure self-noise before tightening anything.
- **Identical-code guard.** Each capture also records the sha256 of the engine source
  (`baselines/<label>/engine.sha256`). If the candidate's hash matches a baseline's, that
  axis runs the *same bytes* -- any measured delta is host noise, not a regression -- so the
  gate **skips** it (shown as `SKIP`) rather than let variance flag a phantom. This is what
  saves you when you re-version without a code change: a `1.5.0-beta.0` that is byte-identical
  to the published `1.5.0-alpha.1` cannot regress against it, and the gate says so structurally
  instead of failing on a noisy median. A genuine code change produces a different hash and is
  gated normally.

## Two baselines

`manifest.json` names a **floor** (never moves -- "we shall not regress below this line")
and a **rolling** baseline (the previous published version). A candidate must clear BOTH:
the floor generously, the rolling tightly. This catches the blind spot of a fixed floor --
an engine that improves 1.4 -> 1.6 then regresses back to 1.4 levels still clears a 1.3
floor, but fails the rolling gate.

## Workloads

Each maps to a bench-benchmark row cited in public claims, so a change that regresses one
shape can't hide behind another:

- `reactive-graph-mix` -- general sources -> layer1 -> layer2 + effects.
- `deep-chain` -- long linear computed chain (lite-signal's DEEP CHAIN weak spot).
- `broadcast-fanout` -- one source -> many leaves (the BROADCAST pattern).
- `dynamic-dep-churn` -- branch-flipping bodies that retrack every cycle (DYNAMIC DAG).
- `creation-churn` -- per-frame create -> write -> dispose triples (the CREATION lane,
  previously ungated); also carries the exact-counter lane: the engine's own
  `totalAllocations`/`poolGrowths` deltas per frame, gated at zero tolerance
  (`counter.allocs.max` / `counter.poolGrowths.max`) -- deterministic under the LCG,
  cross-rep identity enforced by aggregate.mjs (drift = evidence refusal).

Graphs are sized under lite-signal's default 1024-node pool cap; frame cost is scaled by
`ITER` (more update cycles), not more nodes, and each workload runs in its own cold process.

## Commands

    npm run calibrate                         # self-noise: same version twice, per metric
    bash matrix.sh gate <candidate-version>   # published candidate vs floor + rolling
    bash matrix.sh gate-self <label> <path>   # current-tree candidate (engine path) vs floor + rolling
    node diff.mjs                             # diagnostic table over committed baselines -> matrix-report.json
    node gate.mjs <label>                     # gate over already-captured baselines (exit 1 on regression)

`REPS=5` (env) controls the median sample count.

## Two roles for `baselines/`

1. **Gate input** -- re-captured same-host by `matrix.sh`; ephemeral; authoritative.
2. **Committed public evidence** -- the median `baselines/<version>/<workload>.json` files
   checked into git, each carrying `env` metadata (CPU, node, date). Anyone can rerun and
   diff. These may be cross-host, so `diff.mjs` treats them as diagnostic, never as the gate.

## Wiring the checkpoint (templates)

- `pre-publish.mjs` -- wire into the lite-signal repo as
  `"prepublishOnly": "node harness/version-matrix/pre-publish.mjs"`. It runs `gate-self`
  with the candidate = current tree; a regression aborts `npm publish`.
- `.github/workflows/version-matrix.yml` -- PR-time gate. Captures floor + rolling +
  PR-head in the same job (same-host). Note the runner-noise caveat in the file: GitHub
  runners are noisy; calibrate to the runner class or treat CI as advisory and keep the
  tight gate on prepublish.

Both are templates because they live in the lite-signal repo (whose current-tree `Signal.js`
is the candidate); this harness ships standalone.

## Adding a version (e.g. 1.7.0)

1. Add `"1.7.0"` to `history` and set `"rolling"` to the previous published version.
2. `bash matrix.sh gate 1.7.0` (published) or, at prepublish, `gate-self` against the tree.
3. Commit the median `baselines/1.7.0/*.json`. Note in the CHANGELOG, citing the files.

> 1.7.0's `flushStrategy` / SAB changes alter the profiling paths; a floor captured now is
> what will gate 1.7.0. Re-calibrate self-noise once that engine is available.

Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.
