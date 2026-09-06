# harness/attic

Parked one-off probes. Kept for provenance, **not** wired into any npm script
and **not** expected to run as-is. Nothing here gates a release.

## The 1.2.0 -> 1.2.1 shape-regression hunt (settled)

These answered a single, now-decided question: why did the v1.2.1 proto-shape
`signal()` / `computed()` bodies cost ~1.5x more to construct than the v1.2.0
own-prop shape. The engine has long since moved on (current line is 1.5.x), the
finding is documented in the CHANGELOG, and none of these takes an engine path
-- they are pure V8 micro-benchmarks or import dead relative paths
(`./lite_v120`, `./alien_sigs`) that no longer exist.

- `profile-create-1to8.mjs`      -- standalone repro of the createComputations1to8 row.
- `profile-create-decompose.mjs` -- times each phase of computed() construction.
- `profile-prop-writes.mjs`      -- cost of each property write onto a fresh arrow.
- `profile-read-after-proto.mjs` -- confirms setPrototypeOf does not deopt reads.
- `signal-shape-probe.mjs`       -- isolates the source of the 1.5x construction delta.

## Superseded cross-version sweep (the 1.7.0 sBench tools)

- `sbench-driver.mjs` / `sbench-runner.mjs` -- the port of Andrii's sBench
  `update*` group that produced the evidence for the 1.7.0 `flushStrategy: "sab"`
  claim. **Superseded by `../toe-to-toe/`**, which covers the same combos and
  fixes three methodology defects (sequential ordering -> round-robin, no drift
  sentinel -> `1.6.0-sentinel` column, and the silent corrupter where only `v17`
  actually received `flushStrategy: "sab"`). See `../toe-to-toe/README.md`.

  The corrupter did **not** invalidate this tool's own output: in that sweep v17
  was the only `sab` combo, so the guard was accidentally correct. Its results are
  preserved at `../toe-to-toe/sbench-results-1.7.0.txt` and still stand.

  Both files also expect the engine snapshots as siblings (`./v15/Signal.js`, ...),
  which no longer exist at that path -- they now live in the private, gitignored
  `../toe-to-toe/engines/`. Run the successor instead.

- `sink-check.mjs` -- one-shot check that SAB mode really does defer effects until
  batch exit. Redundant: `../smoke.mjs` (T1-T5, wired as `npm run harness:smoke`)
  covers eager / sab / manual semantics *and* asserts, so it fails loudly on a
  regression instead of printing for a human to eyeball.

## Superseded profiling harness

- `burst-dag.mjs`               -- the contiguous-window burst-shape guess (256->512x32,
  fanIn 8, burst 16, with effects at the leaves). It was the pre-reconciliation
  reconstruction from *published* parameters; the canonical `harness/burst-dag.mjs`
  now uses Andrii's verbatim strided generator (ROADMAP S5 closed) and contrasts
  against this shape directly. Kept here because it still carries the
  `burstDagScenario` / `multiPassProbe` module exports (a `passes > 1` smoke-test
  case) -- nothing currently mounts them, but they are the reference if the
  zero-GC gate ever wants a burst scenario. Runs standalone
  (`node --expose-gc harness/attic/burst-dag.mjs`).

## Superseded correctness repro

- `repro-set-after-dispose.mjs`  -- stale-set-after-dispose (the C1 item from the
  old AUDIT.md). The invariant it demonstrated is now pinned in the live suite
  (`test/07-dispose.test.mjs`, `test/26-free-list-invariant.test.mjs`), so the
  loose repro is redundant. It also hard-codes an absolute path and will not run
  without editing.

> The still-cited owner-recycling repro (`owner-hazard-repro.mjs`) is **not**
> here -- it stays in `harness/` because the 1.5.0 CHANGELOG / README / llms.txt
> reference it as the empirical evidence behind `getOwner` / `runWithOwner`.
