# harness/toe-to-toe

Cross-version sweep: every shipped and in-flight engine, measured against every
other, in cold processes, on one host. This is the tool that answers "did 1.N
actually get faster, or did the machine get hotter?".

Run it with `npm run harness:toe` (or `node harness/run.mjs toe`).

## The engines are PRIVATE

`engines/` is **gitignored**. It holds frozen `Signal.js` snapshots, and several
of them (`v18` .. `v112`) are **unreleased**. The sweep *script* is versioned and
public -- the methodology is the valuable part and belongs in the repo. The
engine source is not published until its version ships.

Consequence: a fresh clone has no `engines/` and `harness:toe` will not run until
you drop the snapshots back in. That is intentional. The layout is:

    harness/toe-to-toe/
      toe-to-toe.mjs     driver (round-robin, sentinel, report)
      runner.mjs         one engine + one mode + one scenario, per cold process
      Watch.js           resolution shim (see below) -- NOT an engine file
      engines/           PRIVATE, gitignored
        v15/Signal.js  v16/  v17/  v17-eager/  v18/  v19/  v110/  v111/  v112/

`Watch.js` is a two-line forward. The frozen snapshots end with
`export {watch, when, whenAsync} from "../../Watch.js"`, which resolved to the
repo-root `Watch.js` at their original scratch depth. The shim reproduces that
resolution from `engines/<v>/` without editing the snapshots -- they are the
artifacts under measurement and must stay byte-frozen. The sweep never calls
`watch` / `when` / `whenAsync`; the re-export only has to resolve.

## What this corrects (vs the old sbench sweep)

The predecessor (`../attic/sbench-driver.mjs`) had three defects. This tool fixes
all three, and the fixes are the reason its numbers can be trusted:

1. **Ordering bias -- the thermal artifact.** The old loop ran *all* cold
   processes of v15, then all of v16, ... so the newest engine always ran LAST,
   on the hottest chassis. That is why `deepChain` appeared to show a monotonic
   slowdown across 1.9 -> 1.10 -> 1.11 -- three engines whose propagation bodies
   are sha256-**identical**. Identical code cannot trend. Now: round-robin, each
   repetition runs every combo once in a rotated order, so thermal drift spreads
   across all columns instead of loading the last one.

2. **No drift detector.** The 1.6.0 baseline is now re-measured as a final column
   (`1.6.0-sentinel`). If the sentinel disagrees with the baseline by more than
   `DRIFT_TOL`, the host drifted mid-run and the whole sweep is suspect -- the
   report says so loudly instead of quietly publishing a thermal gradient.

3. **The silent corrupter.** The old runner read:

       if (mode === "sab" && engineDir === "v17") cfg.flushStrategy = "sab";

   so **only v17** ever actually got `flushStrategy: "sab"`. Every later engine
   (v18/v19/v110/v111/v112) was *labelled* `sab` in `COMBOS` -- and therefore had
   its drive batch-wrapped -- while its registry was silently built **eager**.
   That is a different workload than the column claims, and it is the most likely
   source of the phantom "broadcast cliff at 1.8.0". Now the `mode` decides, and
   nothing else.

   > Note this bug did **not** invalidate `sbench-results-1.7.0.txt`: in that
   > sweep v17 was the only `sab` combo, so the guard happened to be correct
   > there. Those numbers stand. The bug only bit once v18+ were added.

## Capability columns

`1.11.0` (`settled`) and `1.12.0` (`trace`) are creation-time capabilities that
are **off** by default. "Zero cost when off" is already proven by byte-identical
hot bodies; what was never measured is the cost when they are **on**. The
`*-on` combos run the SAME engine with the capability enabled, so the delta
against that engine's own `sab` column is the honest price of the feature.

## Reading the report

Every runner emits `sinkOk` -- an anti-DCE check that the effect actually ran.
A column with `sinkOk: false` measured nothing and must not be compared. (This
is the same class of bug that made `bench/benchmark.mjs` report 22,032K ops/s on
MUX against a real ~219K; see the VALIDITY GUARD in that file.)
