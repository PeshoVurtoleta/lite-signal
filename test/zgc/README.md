# Zero-GC gate for @zakkster/lite-signal

A CI-wireable gate that proves the steady-state hot path allocates nothing, and
**fails on an injected allocation**. This is the moat ("first and only zero-GC")
made re-runnable by a skeptic — point it at any build and it either passes or
names what allocated.

## The precise claim (and what is deliberately NOT claimed)

PASS means: **writing through an already-built reactive graph allocates nothing** —
no closures, arrays, or boxing on `set` / pull / `flush`; node and link churn is
absorbed by the pool.

NOT claimed as zero-GC, and shown honestly by the churn scenario: **node creation.**
The callable API allocates two closures per signal; even `signalBox` allocates its
wrapper object. The pool removes internal *node* allocation, not the public
*handle*. The churn scenario demonstrates this split directly — `poolGrowth = 0`
(engine allocates nothing internally) while the box wrappers show up as scavenges
(the handle allocates, by design; `signalBox` is the lightest handle).

## Three signals, each for what it can actually see

1. **Scavenge count** (`perf_hooks` `'gc'`, minor) during the window — the reliable
   detector of *transient* garbage. Per-iteration allocation fills the young
   generation and forces scavenges; a zero-alloc window forces none regardless of
   iteration count.
2. **`stats().poolGrowths` / `totalAllocations`** — exact engine counters (not
   sampled). Prove no node was pulled from the pool and the pool never grew.
3. **Retained-heap delta** (`memoryUsage` + `gc`) — leak detector.

The verdict uses a **scaling** idea: measure at N and k·N. Zero-alloc ⇒ ~0
scavenges at both; allocation ⇒ scavenges scale with total bytes. The result is
not hostage to one absolute threshold, and a known-allocating **positive control**
plus a no-op **negative control** validate the detector on every run (the gate
refuses to report a verdict if the controls misbehave).

## Why it is built this way (measurement traps, documented so nobody "simplifies" it)

Two approaches were tried and rejected — both produce **false passes**:

- **Retained-heap delta alone** (the obvious `heapUsed` before/after + `gc()`) only
  sees *retention*. A hot path that allocates a temporary every iteration and frees
  it shows ~0 retained delta — yet that transient churn is exactly the GC pressure
  the claim is about. Necessary as a leak check, insufficient as the primary signal.
- **V8 sampling heap profiler** (`HeapProfiler.startSampling`) reports
  *live-at-stop* sampled bytes, so it likewise **misses transient garbage**. It read
  0 B/iter for an effect that allocated an object on every run.

Scavenge-counting is used precisely because it catches the transient case the other
two miss. Two further V8 gotchas the controls account for: escape analysis / scalar
replacement and dead-store elimination will erase a "throwaway" allocation entirely
(making a real allocation read as zero), so the positive control allocates into a
module-level sink that genuinely escapes; and GC `PerformanceObserver` entries are
delivered asynchronously, so the window is followed by a real timer tick before the
count is read (and the count is snapshotted *before* the harness's own `gc()`).

## Run it

Drop your engine in as `signal.js` (it is imported once, at the top of
`zgc-scenarios.mjs`). If your build re-exports watchers via `../Watch.js`, that
path resolves *relative to the engine file* — either run the gate from inside
your repo where it resolves naturally, or place the included `Watch.stub.mjs`
as `../Watch.js` (the gate never exercises watchers). Then:

    # human-readable report (re-execs itself with a small young-gen for sensitivity)
    node --expose-gc zero-gc-gate.mjs

    # CI
    node --expose-gc --max-semi-space-size=4 --test zero-gc-gate.test.mjs

`--expose-gc` is required. `--max-semi-space-size=4` sharpens sensitivity to small
per-iteration allocation; the standalone runner sets it for you via re-exec.

Wire into `verify` as a step that runs the `--test` form; it exits non-zero when a
steady-state scenario allocates, when the pool grows under churn, or when the
detector fails self-validation.

## Pointing at another build

It is just an import. Swap `signal.js` for a candidate engine (e.g. a future 1.6, or
a rejected candidate you want to confirm) and re-run — the gate is engine-agnostic
as long as the build exposes `createRegistry({...})` returning
`{ signal, computed, effect, signalBox, dispose, batch, stats }` with the
`stats()` capacity ledger.

## Caveats

- Single-host, and scavenge count is a *presence/scaling* signal, not a per-byte
  figure (V8 exposes no clean cumulative-allocation counter; the precise transient
  byte count would require instrumentation the sampling profiler can't give
  honestly). It answers "did the hot path allocate" — which is the gate's job.
- The scenarios cover deep propagation, wide fan-out, batched writes, and
  create/dispose churn. Add the shapes your consumers actually run (the burst/flush
  DAG, once its generator is available) as new entries in `zgc-scenarios.mjs`.

MIT © Zahary Shinikchiev.
