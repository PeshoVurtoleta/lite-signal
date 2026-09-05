# Testing lite-signal 1.7.0 `sab` mode on Andrii's bench — methodology

> The 1.7.0 `flushStrategy: "sab"` lever produces a measurement trap that Andrii's own
> `SCHEDULER_SEMANTICS.md` warns about: **"flush without delivery vs flush with delivery is not
> apples-to-apples."** This doc lays out how to avoid the trap on each bench shape so the numbers
> you publish actually mean something. Read this before publishing any cross-engine sab
> comparison.

## The trap, in one paragraph

In `sab` mode, `.set` outside a `batch()` enqueues effects via FLAG_SCHEDULED dedup but **does not
flush them**. Effects stay queued until either a batch exits (and a settled context is detected),
or `r.flush()` is called explicitly, or the test ends with the queue still pending. If a benchmark
writes 400,000 times in a hot loop and never wraps in batch and never calls flush, **the effect
body never executes during the timed window**. The test measures pure write+mark cost. In `eager`
mode the same loop delivers 400,000 effect runs. Comparing those two numbers and saying "sab is
100× faster" is comparing different work, not different speeds.

Reflex's adapter declares `effectStrategy: "sab"` and that's the source of the apparent update-
group dominance in `js-reactivity-benchmark`. **This is not cheating** — Andrii documented the
semantics — but it does mean per-test honesty matters.

## Per-test reality check (Andrii's actual bench)

The good news after reading Andrii's `sBench.ts`, `kairoBench.ts`, `molBench.ts`, `fanBench.ts`,
`cellxBench.ts`, and `dynamicBench.ts` source: **every test that has effects ALSO wraps writes in
`framework.withBatch(...)` already**. Andrii designed the bench so any scheduler that flushes at
batch exit (eager AND sab) produces correct, comparable numbers.

The traps live only in **custom harnesses** that have effects but no `withBatch` (this is what
happened in my first toe-to-toe run before I added the sink-correctness check). Here is the
per-suite breakdown:

| Suite | Has effects? | Wraps writes in `withBatch`? | sab vs eager comparison |
|---|:---:|:---:|---|
| **sBench `createComputations*`** | No | n/a | **fair** — measures creation cost only |
| **sBench `updateComputations*`** | **No** (1 computed, never read) | n/a | **fair** — measures write+mark cost only; sab skips the empty `flushEffects()` call |
| **kairoBench** (all 7 subtests) | Yes | **Yes** (verified in every kairo/*.ts) | **fair** — batch exit flushes in both modes |
| **molBench** | Yes | **Yes** (line 51, 55) | **fair** |
| **fanBench** | Yes | **Yes** (lines 81, 160) | **fair** |
| **cellxBench** | Yes | **Yes** (line 54) | **fair** |
| **dynamicBench** | Yes (via `dependencyGraph.ts`) | **Yes** (lines 151, 156, 176, 190, 197) | **fair** |

**Bottom line for Andrii's bench: sab is a fair comparison everywhere.** The trap doesn't fire.
Publish those numbers with confidence.

The trap fires when YOU write a custom benchmark with `framework.effect(...)` followed by raw
writes outside `withBatch`. That's the case for the toe-to-toe runner that initially showed 5–83×
"speedups" — my own custom kairos/broadcast/deepChain/mux scenarios had effects without batch wrap.
Adding the batch wrap or explicit flush brought them back to parity (the honest result).

## Sink-correctness check — paste into any custom harness

Before you trust any sab benchmark number from a custom harness, add this check:

```js
function build(framework, mode) {
    const SINK = {value: 0, runs: 0};
    const src = framework.signal(0);
    const c = framework.computed(() => src.read() * 2);
    framework.effect(() => { SINK.value = c.read(); SINK.runs++; });
    return { src, SINK };
}

const ctx = build(framework, mode);
// Drive the workload exactly as your benchmark does:
for (let i = 1; i <= 1000; i++) ctx.src.write(i);
console.log(`After 1000 writes: SINK.value=${ctx.SINK.value}, runs=${ctx.SINK.runs}`);
```

In `eager` mode you'll see `value=2000, runs=1000`. In `sab` mode without batch wrap you'll see
`value=0, runs=0`. **If your benchmark expects effects to run during the loop and they don't,
your sab numbers are measuring nothing — fix your harness, don't ship the numbers.**

The fix is one of:
- Wrap each write in `framework.withBatch(() => src.write(i))` — matches what Andrii's bench does.
- Call `r.flush()` once at the end and time it inside the measurement window.
- Use a test shape that has NO effects (Andrii's `updateComputations*` are this).

## Statistical methodology — beating the noise

Cold-process variance on update microbenchmarks is enormous. My toe-to-toe runs showed 1.5–5×
spread between consecutive cold processes of the same combination. The default `BENCH_RUNS=1` in
upstream js-reactivity-benchmark is statistically useless for these shapes.

**Recommended floor for any sab vs eager comparison:**

```bash
# In your bench dir (with v15/Signal.js, v16/Signal.js, v17/Signal.js installed):
BENCH_RUNS=20 COLD=10 node sbench-driver.mjs
```

That's 20 in-process samples × 10 cold processes = **200 samples per cell per scenario**. On the
sandbox VM that brings per-row noise from 1.5–5× down to roughly 1.05–1.15× — enough to call a
10% difference real.

**For the official lite-signal release announcement** (1.7.0 numbers as published), I'd go to
`BENCH_RUNS=20 COLD=20` (400 samples per cell). That takes ~30 minutes on the M2 Pro but produces
numbers you can defend against any skeptic.

## Which stat to report

Andrii's `summarizeSamples` produces median, mean, p75, p90, p95, p99, max, min, stddev, mad, iqr,
cv. The right choice depends on what you're claiming:

- **Median**: best default for "typical case" claims. Robust to outliers. Use this in the README.
- **Min-of-mins** (across all cold processes): the clean V8-tier-3 number. Use this for engine
  comparisons where you want to subtract OS noise. Honest because every engine gets the same shot.
- **p95**: the realistic worst case under sustained load. Use this for "real-time application"
  claims (Hueforge frame budget, Twitch overlay 16ms ceiling).
- **Mean ± stddev**: only if `cv` < 0.05 (CV = coefficient of variation). On the sandbox VM most
  rows have `cv > 0.10`, so don't lead with mean.

For the public 1.7.0 bench release, I'd publish **median + min-of-mins as a pair** so a skeptic
can see both the typical case and the floor.

## The decision: which mode does the lite-signal bench adapter ship?

This is a real product question. Reflex chose `sab` for its adapter (and is transparent about it
in `SCHEDULER_SEMANTICS.md`). You have three honest options:

**Option 1: Ship `eager` (default).** Conservative. Apples-to-apples with alien-signals,
preact-signals, vue-reactivity, solid (which all flush eagerly). Numbers don't change vs your
previous bench runs. lite-signal stays where it is in the update group.

**Option 2: Ship `sab` (matches Reflex).** Aggressive. Closes most of the 2.5× update-group gap to
Reflex on `updateComputations*`. Andrii will recognize the choice (he made the same one). Document
clearly: "lite-signal benchmark adapter uses `flushStrategy: 'sab'` to match Reflex's bench
contract; see `SCHEDULER_SEMANTICS.md` for what this measures."

**Option 3: Ship BOTH** — `lite-signal` (eager) and `lite-signal-sab` (sab) as separate adapter
entries. Andrii's bench supports multiple adapters per framework. Lets you show both numbers and
let the reader pick. Maximally honest. *Recommended.*

The case for option 3 is strong: it's what the data invites (two real modes, two valid contracts,
two sets of numbers), it's what the SCHEDULER_SEMANTICS doc implicitly endorses, and it avoids
any debate about which mode is "the real lite-signal." The PR to add a second adapter is
~30 lines.

## What to ship to Andrii (when you write him)

When you reach out to Andrii with the 1.7.0 numbers, the cleanest framing:

> "I read your Reflex source end-to-end and shipped the same `flushStrategy: eager|sab|manual`
> lever in lite-signal 1.7.0. Eager mode is byte-identical to 1.6.0 (no regression). Sab mode
> closes 1.29–1.54× of the update-group gap on your sBench. The 4–7.6× gap to alien-signals on
> 1to1000 / 1000to1 stays — that's push-eager territory and I think you and I agree it's structural
> for any lazy-pull engine.
>
> Two things I'd appreciate your read on:
>
> 1. **Adapter contract.** I'm leaning toward shipping two lite-signal adapters in your bench —
>    eager and sab — for transparency. Does that match your taste, or would you prefer one
>    canonical entry?
>
> 2. **The GC axis offer (A2 in my roadmap).** Your harness measures one dimension (throughput);
>    lite-signal was built for a second one (allocation). I have a reporter that runs alongside
>    yours and pins `poolGrowthDelta` / `allocDelta` for each test. Would you take a PR adding it
>    as an optional axis, or would you prefer it stays as a companion repo?"

Frame it as a contribution to the commons, not a pitch. Andrii's `SCHEDULER_SEMANTICS.md` already
shows he thinks carefully about exactly this comparison.

## Commands cheat-sheet

```bash
# 1. Verify your install works (smoke tests for all three modes)
node --expose-gc smoke.mjs

# 2. Quick correctness check (no benchmark) — sink-correctness in sab
node --expose-gc sink-check.mjs

# 3. Andrii's update group, 1.7.0 vs 1.6.0 vs 1.5.0, with statistical confidence
BENCH_RUNS=20 COLD=10 node sbench-driver.mjs > results.txt

# 4. Full bench against alien-signals / reflex / preact / solid / vue (in your real bench rig)
BENCH_RUNS=20 BENCH_FRAMEWORK="alien-signals,reflex,lite-signal,preact-signals,solid-signals,vue-reactivity" \
  node --expose-gc dist/index.js > full-bench.log

# 5. With the two-adapter trick (option 3 above) — shows lite-signal eager AND sab side-by-side
BENCH_RUNS=20 BENCH_FRAMEWORK="alien-signals,reflex,lite-signal,lite-signal-sab" \
  node --expose-gc dist/index.js > two-adapter.log
```

## Three things to double-check on the M2 Pro tomorrow

1. **Eager parity holds on M2.** Run `BENCH_RUNS=20 COLD=10 node sbench-driver.mjs` and check that
   1.7.0-eager median is within ±5% of 1.6.0 on every row. If any row regresses >10%, V8 on M2
   isn't inlining the two-closure split — ping me with the exact row and we'll diagnose.
2. **Sab wins persist or grow.** I'd expect 1.5×–2× on M2 (better cache locality, less JIT-tier
   noise). If the wins are smaller than the sandbox VM (1.29–1.54×), V8 on M2 is already inlining
   the empty `flushEffects()` better than the sandbox — which would mean the win is just smaller
   in absolute terms, not gone.
3. **Cold-process variance drops below 1.15×** on the noisy rows (`4to1`, `1to1000`). If you still
   see 2× variance, the system isn't quiescent enough — close all other apps, plug in the charger
   (laptop frequency scaling on battery is brutal), and rerun.

If all three check out, ship 1.7.0 publicly. Otherwise, ping with the row that surprised you.
