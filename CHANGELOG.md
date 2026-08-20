# Changelog

All notable changes to `@zakkster/lite-signal` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [1.4.5] -- 2026-08-18

The createRegistry validation patch. Until now `createRegistry(config)` read five
options and validated none of them -- 20 of 25 malformed configs built without a
word and the rest failed later, deep in the node allocator, naming an internal
`nextFree` field rather than the option you got wrong. This closes the door. All
of it is constructor-cold: **the engine's hot path is byte-for-byte unchanged and
the zero-GC steady state does not move** (read/set/flush allocate 0 B/op as before).

### Fixed

- **`prealloc:"eager"` with an absurd capacity no longer kills the process.**
  `{maxNodes: Infinity}` and `{maxNodes: 1e9}` (a plausible typo for `1e5`) used to
  run an unbounded construction loop and SIGABRT the process with an uncatchable
  "Ineffective mark-compacts near heap limit" -- not a throw, so `try/catch` could
  not see it and a supervisor got a crashed worker instead of an error. Eager
  construction now refuses by name above a `(maxNodes + maxLinks) > (1 << 24)`
  ceiling, throwing a `TypeError` prefixed `createRegistry: "maxNodes"` (or
  `"maxLinks"`) that suggests `prealloc:"lazy"` for an unbounded on-demand ledger.
- **Fractional and non-positive capacities are rejected at construction.**
  `{maxNodes: -1}`, `0`, `null`, `NaN` used to build a registry that died on first
  use with `TypeError: Cannot read properties of undefined (reading 'nextFree')`;
  `{maxNodes: 1.5}` was accepted and surfaced later as a `CapacityError`. All now
  throw `createRegistry: "maxNodes"` (finite integer >= 1) at the call that made
  the mistake.

### Changed

- **Every option is validated by name.** `maxNodes` / `maxLinks` / `maxFlushPasses`
  must be finite integers >= 1; `prealloc` exactly `"eager"` or `"lazy"`;
  `onCapacityExceeded` exactly `"throw"` or `"grow"`; `config` itself a plain object
  or `undefined` (`null`, `42`, `"eager"` are rejected). A bad value throws a
  `TypeError` prefixed `createRegistry: "<option>"`.
- **Unknown keys throw with a did-you-mean hint.** `{maxNods: 32}` and
  `{preAlloc: "lazy"}` used to build a default registry and run -- the misspelled
  key silently ignored, so the capacity or the population strategy you asked for
  never took effect. They now throw and suggest the intended key. If you had a typo,
  you will now hear about it at construction instead of debugging it as production
  jitter. A one-character `prealloc` typo in particular used to flip an eager pool
  to lazy silently, selling back the zero-GC latency contract eager exists to buy.
- **`stats()` returns 13 keys** (was 11): adds `nodePoolPopulation` and
  `linkPoolPopulation`, the PHYSICAL count of constructed pool objects, distinct
  from the `*Capacity` ledgers. Under `"eager"` population equals capacity; under
  `"lazy"` it starts at 0 and grows on demand. This is the instrument that lets a
  caller confirm an eager pool actually preallocated -- previously `stats()`
  reported only the ledger and was blind to a `prealloc` typo. No existing key
  removed or changed; two free array-length reads, no allocation.

### Tests

- `test/28-config-validation.test.mjs` -- the full 25-config matrix: every
  malformed row throws a `TypeError` naming the option (never reaching the internal
  `nextFree` path), every accepted row is explicitly listed, plus the retained
  heap-delta / population check that `"eager"` at `maxNodes:200000` retains >20 MB
  with `nodePoolPopulation === 200000` and `"lazy"` retains ~0 with
  `nodePoolPopulation === 0`.
- `test/28-config-oom.child.mjs` -- the three OOM rows (`maxNodes:Infinity`,
  `maxNodes:1e9`, `maxLinks:Infinity`) run as isolated child processes under
  `--max-old-space-size=256`, each asserting a caught named `TypeError` and a clean
  exit (the fix must not SIGABRT).

## [1.4.4] -- 2026-08-03

The verification-surface patch, round four. **The engine is unchanged**: as in
1.4.1/1.4.2/1.4.3, the only edit to `Signal.js` is the version string in its header
banner, and `Signal.d.ts` is untouched. Everything here lives in `bench/torture/`
and `test/`, neither of which ships the engine -- `files[]` excludes `bench/`. If
you consume the package, 1.4.4 is byte-for-byte 1.4.3 plus a version number.

1.4.3 gated the zero-GC claim. This round closes the remaining gaps at the ERROR
edges -- the paths that only run when user code throws or a graph is pushed past a
structural limit -- and turns the three soaks from liveness-only into
value-correctness gates.

### Added -- two semantic scenarios (suite now 22)

- `bench/torture/error-torture.mjs` -- throwing effect BODIES under flush.
  `flushEffects` buffers each per-effect throw into a pre-allocated buffer, keeps
  the remaining queued effects running, and only then surfaces what it caught:
  a single throw is re-thrown UNWRAPPED (the original error), two-or-more become a
  single `AggregateError` carrying EXACTLY those errors in order. This is a stress
  scenario, not a unit duplicate of `test/09-conformance`: it asserts what the unit
  tests do not -- that survivors in the same pass still run, and that the buffer
  returns to baseline under 4096 throw/clean cycles so nothing bleeds between
  flushes (a clean flush after a throwing one throws nothing, `stats()` never
  drifts).
- `bench/torture/deep-chain-torture.mjs` -- `pullComputed` recursion, fail-closed.
  `pullComputed` is call-stack recursive, so a deep computed chain read fails
  CLOSED with a `RangeError` beyond the host stack rather than corrupting anything.
  Depth is RAMPED, never pinned (the exact throwing depth is host-dependent): it
  asserts only that some depth <= 100k throws a `RangeError`, then that the registry
  that threw is STILL usable (a fresh small graph builds and evaluates correctly,
  effects included) and that the iterative PUSH path -- an equally deep effect
  cascade, flush-pass budget raised to match -- propagates end to end without
  throwing, contrasting the heap-iterative scheduler against the stack-recursive
  pull.

### Added -- `test/27-throwing-equals.test.mjs`, a throwing user `equals`

`equals` is user code the engine calls on the hot write/recompute path and does
not sandbox. This file pins its behaviour at all three call sites: (a) the signal
`set` pre-check -- the original error propagates and the signal is left unmutated,
no downstream fires; (b) the batch revert check -- PINNED, not asserted-as-atomic:
the throw at that site happens after `node.value` was written but before the
version bump, so the net value is correct yet downstream FIRES (the throw stranded
the version bump, defeating the revert), documented exactly so a future move to an
atomic revert trips the pin; (c) computed re-eval -- caught, cached as
`FLAG_HAS_ERROR`, re-thrown on every read until a dep change re-evaluates cleanly
and clears it.

### Changed -- capacity ceiling + soak value oracles

- `bench/torture/capacity-torture.mjs` gains the 16x link grow ceiling: under
  `grow`, link growth is capped at `maxLinks * 16` and throws `CapacityError`
  with `kind: "links"` and `capacity` equal to the ceiling AT the ceiling --
  growth terminates exactly at `16x` (`linkPoolCapacity === 128` for `maxLinks: 8`,
  not one chunk over) -- and the overflowed computed still re-throws on read
  rather than leaking a partial sum. Every pre-existing case is intact.
- `graph-fuzzer.mjs`, `torture-soak.mjs`, `scheduler-bench.mjs` each gain a
  value-correctness ORACLE. Each shadows its signals in a single `Int32Array`
  allocated ONCE outside the churn loop, updated in lockstep with every write, and
  asserts the engine's value equals the model on a rotating window each tick plus a
  full sweep at teardown -- zero per-tick allocation, so the implicit pool-to-floor
  gate is not regressed. All prior liveness assertions (0 errors, pool-to-floor,
  JIT sink advanced) are preserved; the soaks now assert value-correctness, not
  just liveness. Mutation-verified: corrupting one shadow write makes the soak exit
  non-zero.

### Verified -- full suite green on the 1.4.4 engine (Node 22, `--expose-gc`)

- **Torture:** 22/22 -- `error-torture` and `deep-chain-torture` PASS; the three
  soaks report `value mismatches: 0`.
- The engine is byte-for-byte 1.4.3; the unit suite grows only by `test/27`
  (7 new tests) and no prior test regressed.

## [1.4.3] -- 2026-08-02

The verification-surface patch, round three. **The engine is unchanged**: as in
1.4.1 and 1.4.2, the only edit to `Signal.js` is the version string in its header
banner, and `Signal.d.ts` is untouched. Everything here lives in `bench/torture/`,
which does not ship -- `files[]` excludes it. If you consume the package, 1.4.3 is
byte-for-byte 1.4.2 plus a version number.

1.4.2 completed the forward-compatible torture superset. This release adds the one
scenario that was still missing: the zero-GC claim, gated. The headline promise --
writing through an already-built reactive graph allocates nothing -- was, until
now, asserted only by a hand-rolled `perf_hooks` scavenge counter that lived in a
`futureVersions/` sketch and never ran in CI. That meter is deleted and replaced by
a real gate driven by `@zakkster/lite-gc-profiler@^1.15.0`.

### Added -- `zerogc-torture.mjs`, the zero-GC gate (suite now 20 scenarios)

`bench/torture/zerogc-torture.mjs` turns "zero-GC" from a slogan into a
re-runnable gate. It measures the steady-state hot path against three independent
witnesses, gated separately because no single one sees everything:

- **per-call RETAINED bytes** -- `measureAllocs` / `checkAllocs` at
  `maxBytesPerCall: 0`, the literal zero-retention assertion. Because it measures
  allocation surviving a forced collection (min across batches), it also proves
  the create+dispose CHURN case: a callable handle allocates transiently, is
  reclaimed, and retains 0 -- the pool absorbing the node.
- **major GC count and longest pause** -- `measureOps` (`stabilize: 'deep'`) /
  `checkNoGc` at `maxMajor: 0` / `maxPauseMs: 2`. A zero-alloc window forces no
  major collection regardless of length; a nonzero count is transient garbage the
  retained-bytes settling would hide.
- **the engine's own `stats()` counters** -- steady scenarios: `poolGrowths` and
  `totalAllocations` do not move across the window (no node pulled, pool never
  grew); churn scenarios: `poolGrowths` stays 0 and `activeNodes` returns to its
  baseline (every acquired node recycled, none leaked).

The scenario states its non-goal as loudly as its goal: node CREATION is **not**
zero-alloc (the callable API allocates two closures per `signal`, a `signalBox`
allocates its wrapper); the pool removes the internal NODE allocation, never the
public HANDLE. Five deterministic graph shapes are gated -- deep chain x16, wide
fan-out x32, batched 8-signal writes, and create+dispose churn on both the
callable and (self-skipping below 1.5.0) the box form. `ZEROGC_BREAK=1` arms an
effect that pushes a fresh object into a module-level sink on every write:
mutation-verification that `checkAllocs` rejects a planted allocation, and that
reaching the PASS line with the break armed is itself a failure (a gate blind to a
planted leak is blind to a real one). Registered in `run.mjs` as a `semantic`
scenario; the suite is now **20 scenarios (17 semantic + 3 soak)**.

### Removed -- the orphaned hand-rolled meter

`futureVersions/zgc/` (the `perf_hooks` scavenge-counting gate, its `Watch.stub.mjs`,
core, scenarios, and node:test wrapper) is deleted. Its scenario shapes are ported
into `zerogc-torture.mjs`; its bespoke measurement is superseded by the profiler.
Also removed: `bench/torture/index.mjs`, a stale non-ASCII duplicate of
`bench/torture/helpers/index.mjs` that no scenario imported. Neither path ships
(`files[]` excludes `bench/`).

### Changed -- one devDependency

`@zakkster/lite-gc-profiler@^1.15.0` added to `devDependencies` (dev-only; the
package still has zero runtime dependencies and `files[]` ships no test code).

### Verified -- full suite green on the 1.4.3 engine (Node 22, `--expose-gc`)

- **Torture:** 20/20 -- `zerogc-torture` PASS (three witnesses green across all
  five graph shapes; `churn-box` a clean skip on 1.4.x). `ZEROGC_BREAK=1` exits
  non-zero and names `injected` (retained 32 B/call).
- The engine is byte-for-byte 1.4.2; the unit suite is unaffected (425 total,
  415 pass, 0 fail, 10 skip).

## [1.4.2] -- 2026-07-28

The verification-surface patch, round two. **The engine is unchanged**: as in
1.4.1, the only edit to `Signal.js` is the version string in its header banner,
and `Signal.d.ts` is untouched. Everything here lives in `bench/torture/`, which
does not ship -- `files[]` excludes it. If you consume the package, 1.4.2 is
byte-for-byte 1.4.1 plus a version number.

1.4.1 added five semantic scenarios and left the torture directory at eight. This
release completes it: eleven more scenarios land, and one runner now drives the
whole forward-compatible superset -- **19 scenarios (16 semantic + 3 soak)** --
across every version from this 1.4.x base through 1.9.

### Added -- eleven torture scenarios completing the 19-scenario suite

Each new scenario **feature-detects and skips cleanly** on an engine that predates
its feature: it prints `SKIP: <feature> requires <version>+` and exits 0 rather
than failing, which is what lets one directory ride every version on the rebuilt
line. Three run fully on this 1.4.x base; six self-skip until their feature exists;
two more run on the surfaces 1.4.x already has:

- **`op-accounting.mjs`** -- structural work read from the `onGraphMutation`
  opcode lane (op 1-5): the op5 identity (op5 == computed recomputes + effect
  executions), equality cutoff, diamond glitch-freedom by recompute count,
  link/node balance, laziness, and a 400-seed op5-vs-wrapper differential.
- **`introspect-torture.mjs`** -- the read-only introspection surface
  (`describe` / `nodeId` / `forEach*` / `hasObservers` / `isTracking` / `ownerOf` /
  `observeObservers`): walk agreement against the real edge set including dynamic
  rewiring, `hasObservers` transitions, `observeObservers` connect/disconnect
  edges, and the ABA gen-stamp guard (a stale descriptor must resolve to nothing,
  never a recycled resident).
- **`lifecycle-torture.mjs`** -- `destroy` (1.4.0+) registry reset: handles staled
  via gen-bump, stale writes no-op, pool reusable, idempotent. Its `createRoot`
  half (1.5.0+) self-skips on this base, and the PASS line reflects only what ran.
- **`async-torture.mjs`** -- `watch` / `when` / `whenAsync` contracts + a 300-seed
  projection-guard storm.
- **`capacity-torture.mjs`** -- the fail-closed pool boundary: exact node/link
  ceilings, `CapacityError`, `grow` mode crossing the boundary, no partial value
  escapes.
- **`box-torture.mjs`** (1.5.0+), **`scope-torture.mjs`** (1.6.0+),
  **`owner-torture.mjs`** (1.6.0+), **`flush-torture.mjs`** (1.7.0+),
  **`cleanup-return-torture.mjs`** (1.8.0+), **`dispose-torture.mjs`** (1.9.0+) --
  present and gen-guarded; each reports a clean SKIP on the 1.4.x engine.

### Changed -- one runner for the whole suite

`bench/torture/run.mjs` now registers all 19 scenarios in two groups (`semantic`,
`soak`), child-process-isolated (several assert on global pool accounting). New
flags: `--group semantic|soak`, `--list`. `npm run torture` /
`torture:semantic` / `torture:soak` drive them.

### Verified -- full suite green on the 1.4.2 engine (Node 22, `--expose-gc`)

- **Torture:** 19/19 -- `torture:semantic` 16/16 (10 executed, 6 clean skips:
  box 1.5.0, scope/owner 1.6.0, flush 1.7.0, cleanup-return 1.8.0, dispose 1.9.0),
  `torture:soak` 3/3 (zero errors, every pool back to its leaf-only floor).
- The engine is byte-for-byte 1.4.1; the unit suite is unaffected.

## [1.4.1] -- 2026-07-21

The verification-surface patch. **The engine is unchanged**: the only edit to
`Signal.js` is the version string in its header banner, and `Signal.d.ts` is
untouched. Everything here lives in `bench/torture/`, which does not ship --
`files[]` excludes it. If you consume the package, 1.4.1 is byte-for-byte 1.4.0
plus a version number.

What changed is what the repo can *prove* about that engine. The torture
directory used to answer two questions -- did anything throw, and did the pool
come back -- and both are liveness questions. Neither reads a value and asks
whether it is right. This release adds five scenarios that assert on meaning,
and fixes the three existing soaks, which had been lying in small ways.

### Added -- five semantic torture scenarios

The three pre-1.4.1 soaks (`graph-fuzzer`, `scheduler-bench`, `torture-soak`)
pass green on an engine whose computeds return stale values. That is not a
hypothesis. Flipping the clean short-circuit in `pullComputed` from `<= 0` to
`<= 1` -- a one-character edit, exactly the shape a perf tweak makes -- keeps the
pool perfectly balanced, throws nothing, and all three soaks report PASS. The
new scenarios exist to close that gap.

- **`oracle-fuzzer.mjs`** -- differential correctness. Drives a random DAG and,
  after every operation, compares **every** computed against an independent
  reference evaluator that recomputes from the leaves with no caching, no
  versioning and no short-circuit. The reference shares no code with the engine,
  so a bug in the engine's invalidation cannot hide in the oracle too. Node
  shapes cover static fan-in (`sum`), dynamic dependency sets (`select`, which
  reads a selector then exactly one dep, so the source set moves between
  evaluations), and value passthrough (`identity`, which preserves `-0` and `NaN`
  where a `sum` would normalise them away). Failures print the seed and a
  minimised operation log so they replay.
- **`glitch-hunter.mjs`** -- glitch freedom across diamond topologies plus exact
  wakeup accounting. An engine may not expose an intermediate state in which two
  branches of a diamond disagree about which epoch they reflect.
- **`work-accounting.mjs`** -- minimum body-execution counts across 10 fixed
  topologies. Pins that the engine does *exactly* the necessary work: no
  recompute of an unaffected node, and no skipped recompute of an affected one.
  Both directions fail loudly.
- **`concurrent-storm.mjs`** -- reentrancy, nesting and flush ordering against
  eight documented contracts: self-write termination, mutual A->B->A loops
  tripping `CycleError` rather than hanging, nested batches flushing only at the
  outermost boundary, effects scheduled *by* a pass draining in the *next* pass,
  writes and reads inside cleanup, dispose-mid-flush, self-disposal from inside
  a body, and async writes interleaved with flushes.
- **`scheduler-storm.mjs`** -- deferred-execution hazards under saturation. The
  cached `schedulerThunk` is gen-bound; `dispose` bumps `gen`, so a `run` the
  scheduler is still holding must become a silent no-op and must **not** fire the
  new resident once that pool slot is recycled. That is a textbook ABA hazard and
  the guard is one `===` away from being wrong. Also pins that `FLAG_QUEUED` is
  cleared only inside `executeEffect` (which is what makes a microtask scheduler
  coalesce N writes into one run), and that a throwing scheduler does not take
  the rest of the flush pass down with it.

Where no contract is documented, these files **pin the observed behaviour** and
say so at the scenario, rather than asserting an invented one.

#### Measured discrimination

Each scenario was validated by mutating the engine and confirming the scenario
fails, then restoring. Recorded because a torture suite nobody has mutation-
tested is decoration:

| mutant | caught by | missed by |
| ------ | --------- | --------- |
| `pullComputed` short-circuit `<= 0` -> `<= 1` | oracle-fuzzer (400/400 seeds), glitch-hunter, work-accounting | all three legacy soaks |
| drop `node.gen === gen` from the cached thunk | scheduler-storm | **the entire 405-test unit suite** |
| `batch` flushing at every boundary, not the outermost | concurrent-storm | -- (unit suite catches it too) |

The ABA row is the reason this release exists: 405 unit tests pass on an engine
whose stale thunks fire into recycled pool slots.

### Added -- one entry point, two groups

`bench/torture/run.mjs` replaces the ad-hoc shell loops people were writing
around six separate `node --expose-gc bench/torture/<file>.mjs` invocations.

```bash
npm run torture              # everything
npm run torture:semantic     # correctness only, ~10s, CI-shaped
npm run torture:soak         # resource soaks only
node bench/torture/run.mjs --list
node bench/torture/run.mjs --seconds 30 --bail
node bench/torture/run.mjs oracle glitch    # substring match on names
```

Scenarios are split into **`semantic`** (deterministic, fast, assert on meaning
-- belong in CI on every commit) and **`soak`** (wall-clock bound, assert on
resources -- belong in a nightly or pre-publish job). Each scenario stays a
standalone executable module, and the runner **spawns them as child processes**
rather than importing them. That is deliberate: several assert on global pool
accounting and on the default registry, so running two in one process would let
the first one's residue poison the second's baseline. Process isolation is the
only thing that makes those assertions mean anything.

`--expose-gc` is passed by the runner unconditionally. It is not optional:
several scenarios force collection to settle finalizers, and without it they
would silently degrade to asserting nothing rather than failing loudly.

### Added -- shared torture infrastructure

`bench/torture/helpers/index.mjs` collects what every soak had grown its own
copy of: the seeded `mulberry32` PRNG (so a failure replays from its seed
alone), the `soakRegistry` / `fixedRegistry` constructors, and `createReport`,
which **collects failures instead of throwing on the first one** -- torture
output is read once, usually in CI, and "fix, rerun, discover the next one" is a
slow loop.

It also holds `VALUE_POOL`, the adversarial value domain. An earlier draft of
the oracle used integers only, and a mutant that swapped the default equality
from `Object.is` to `==` sailed straight through, because on integers the two
agree. The pool now contains the pairs where the candidate definitions
disagree: `Object.is` vs `===` differ on `NaN` and on `-0`/`0`; `===` vs `==`
differ on `0`/`""`/`false`/`"0"` and `null`/`undefined`. Equality decides whether
a write propagates at all, so it has to be fuzzed with values that can tell the
definitions apart.

The module is deliberately dependency-free and side-effect-free: importing it
must not touch the default registry, or an import would quietly allocate and
poison the pool baselines the scenarios assert on.

### Fixed -- the soaks printed `impossible` on a healthy run

All three legacy soaks used a magic-constant guard as a JIT sink
(`if (acc === 1234567) console.log("impossible")`) to stop V8 eliminating the
accumulator loops that make the engine do real work. Those constants are
**reachable**: a 1.4.0 soak run printed `impossible` for real, because the
accumulator genuinely landed on the sentinel. The sink polluted stdout on a
passing run, which is how a CI log teaches people to ignore it.

Replaced with a module-scoped int32 sink accumulated in the loop and read at
teardown. It never prints -- and it now carries an assertion the old form could
not: **if the sink never advances, the run fails**, because that means the work
loops were optimised away and the soak measured nothing. Previously that failure
mode was undetectable.

### Fixed -- "pool returned to baseline" was not what was being asserted

The soaks printed a `baseline` (e.g. `7500 / 17992`), a post-teardown figure
(`2500 / 0`), and then declared that the pool had "returned to baseline". Those
numbers never match and were never supposed to: teardown disposes the computeds
and effects and leaves only the signals alive, so the real assertion is a
leaf-only floor of `N_SIGNALS + 8`. The verdict did not describe the check.

- the pre-run stat is now labelled `pre-soak`, not `baseline`;
- the floor actually asserted on is printed
  (`post-teardown floor asserted: <= 2508 nodes / 0 links`), so a reader can
  check the verdict against the numbers instead of trusting it;
- the pass line reads `pool drained to its leaf-only floor`.

### Fixed -- `helpers/` resolution

The helpers module was committed at `bench/torture/index.mjs` while the
scenarios -- and the module's own header docstring -- referenced
`bench/torture/helpers/index.mjs`. Four of the five semantic scenarios died with
`ERR_MODULE_NOT_FOUND` before executing a single assertion, leaving the suite at
1/5 with three stack traces in the log. Moved to the path everything already
expected. `run.mjs` propagated the failure correctly; nothing else would have
caught it, because the torture suite is not wired into `npm test` or
`npm run gate`.

### Changed -- torture sources are ASCII

`bench/torture/*.mjs` carried em dashes, less-than-or-equal glyphs, and 1,820
box-drawing characters. `Signal.js` is pure ASCII and `bench/benchmark.mjs` uses
only the sanctioned multiplication sign, which made the torture directory the
lone outlier against the ecosystem's ASCII-only source rule. Normalised to
`--`, `<=` and `-`. The directory's `README.md` is left as it is, consistent
with `bench/README.md`.

### Added -- `harness/ProfilerTools/` is now checked in

The combined profiler + devtools integration harness has been described in the
README and wired into `test:harness` / `test:all` since 1.4.0, but its four files
were never committed. They land here: `harness.test.mjs`, `package.json`,
`setup.sh`, `README.md`. Verified working -- 5/5 passing, a 7-node / 6-edge
telemetry DAG discovered through devtools, and `activeNodes 22 -> 22` across
2,000 driven frames, which is the zero-GC contract holding end-to-end across
three packages rather than on a microbench.

Its scope is now stated explicitly in the README and `llms.txt`, because it was
previously ambiguous and the ambiguity was dangerous: **`setup.sh` hard-pins
`@zakkster/lite-signal@1.6.0-preview.2` from the registry and nothing resolves
to `../../Signal.js`.** The harness does not test the working tree. Since
`npm run test:all` chains it, a passing `test:all` is not by itself clearance to
publish -- `npm test`, `npm run torture` and `npm run test:hardening` are the
legs that exercise local changes.

### Not changed

- `Signal.js` behaviour, `Signal.d.ts`, the public API, the hot path, bundle
  size, and the 1.4.0 `stats()` surface.
- `npm test` still runs `test/*.test.mjs` only: **405 passing**, unchanged.
- The torture suite remains opt-in and unpublished.

## [1.4.0] -- 2026-06-XX

The observability minor: `stats()` gains **three cumulative lifecycle counters**
(`totalAllocations`, `totalDisposals`, `poolGrowths`) -- the surface reserved for
1.4.0 in the 1.2.x and 1.3.0 notes, now delivered. This is what lite-devtools /
lite-studio read to chart allocation rate, pool-reuse ratio, and graph churn over
time. Drop-in over 1.3.0 -- no hot-path change, no public callable API change; the
counters are bumped on existing lifecycle edges (acquire / dispose / grow) that
already ran, so steady-state throughput and zero-GC are unchanged. The eager pool
default introduced in 1.3.0 carries forward (`prealloc: "eager"`).

### Added -- cumulative lifecycle counters on `stats()`

`stats()` now returns **11 keys**: the 8 from 1.2.x/1.3.0 plus three monotonic
counters. They are cumulative over the registry's life and reset only by
`destroy()`.

- **`totalAllocations`** -- incremented on every node acquire, whether the node
  is popped from the free list or freshly constructed during a pool-growth chunk.
  This is the true number of nodes the registry has ever handed out, not the
  current live count (`activeNodes` remains the live gauge).
- **`totalDisposals`** -- incremented on every `disposeNode`, i.e. every node
  returned to the pool. `totalAllocations - totalDisposals` tracks the live set
  and should equal `activeNodes` in a quiescent registry.
- **`poolGrowths`** -- incremented whenever a node *or* link refill chunk pushes
  capacity past its current ledger (`maxNodes` / `maxLinks`). A nonzero value
  after warm-up means the initial pool was undersized for the workload and the
  registry grew at runtime -- the signal a tool uses to recommend a larger
  `maxNodes` / `maxLinks`, or that confirms an eager pool was sized correctly
  (stays 0).

The counters are exact, not sampled: they sit on the same `createNode` /
`disposeNode` / chunk-refill edges the engine already executes, so reading them
costs nothing and they cannot drift from the real lifecycle.

### Why these three, and what they enable

The point is *derivable* observability without the engine itself computing rates.
A consumer sampling `stats()` over time gets, with no extra engine work:

- **allocation rate** = delta `totalAllocations` / delta t (graph build pressure),
- **pool-reuse ratio** = `1 - poolGrowths * initialCapacity / totalAllocations`
  (how much work the pool absorbed vs. how much forced growth),
- **approximate average lifetime** ~ `totalDisposals` / allocation rate (churn).

These are exactly the series lite-devtools 1.2 / lite-studio 1.2 plot. The engine
stays a measurement *source*, not a metrics framework -- consistent with the
zero-overhead-in-steady-state contract.

### Changed -- `destroy()` resets the counters

`destroy()` (the in-place arena reset) now also zeroes the three counters along
with the rest of registry state, so a reused registry reports lifecycle numbers
for its current epoch only. Grown pool *capacity* is retained across `destroy()`
as before (the reset keeps the arena warm); only the cumulative counts reset.

### Added -- dedicated test harness layout

The repo now ships **three opt-in test harnesses** alongside the in-tree engine
suite, each in its own subdirectory with its own `package.json` and setup story.
They do **not** run on `npm test`; they opt in through dedicated scripts,
including the VersionMatrix gate (run on demand via `npm run gate`). The
default `npm test` is now scoped
via a Node 22 native glob -- `'test/*.test.mjs'` -- so only the 26 root engine
test files are discovered. Subdirectory test files (e.g.
`test/ProfilerTests/test/*.test.mjs`) and out-of-tree test files
(`harness/ProfilerTools/harness.test.mjs`) are no longer accidentally swept into
the default run.

- **`test/ProfilerTests/`** -- a **version-portable hardening suite** for the
  engine. Imports `@zakkster/lite-signal` as a bare specifier; self-references
  through this repo's own package name when run from inside the tree, resolves
  to the installed version when run standalone (`./run-matrix.sh`). Feature-
  gated: older engines skip the cases for APIs they do not have yet, newer
  cases light up automatically. Pins the diamond / dynamic-dep / cleanup-order /
  cascade-dispose invariants that quietly break reactive engines under retune.
- **`harness/ProfilerTools/`** -- a **combined integration harness** that points
  `@zakkster/lite-profiler-signal` and `@zakkster/lite-devtools` at the same
  registry and verifies the cross-package zero-GC contract end-to-end (devtools
  inspects a profiler-driven graph non-perturbingly and confirms via the same
  `stats()` it monitors that the profiler allocates no new nodes in steady
  state). Setup is one-time (`bash setup.sh`) and pins specific package
  versions via tarball install so the harness re-runs reproducibly.
- **`harness/VersionMatrix/`** -- a **cold-process regression gate** run on
  demand via `npm run gate`. Each version-x-workload is profiled in its own `node`
  invocation (so V8 never carries inline caches or JIT state from one version
  into another), fed an identical LCG write sequence (delta = engine change,
  not input), and reduced to a per-metric median-of-N. Two baselines gate every
  publish -- a **floor** (never moves; "we shall not regress below this line")
  and a **rolling** baseline (previous published version); a candidate must
  clear BOTH. Tolerances calibrated against measured self-noise (`npm run
  calibrate`): `frame.avg` is the stable anchor at 5% rolling / 10% floor
  (self-noise <=~3%); `frame.p99` and `phase.write.p99` sit at 18% / 30%
  (self-noise up to ~14%, so a p99 fail should be re-run to confirm). Four
  workloads map to the public bench claims: `reactive-graph-mix` (KAIROS / mol
  pattern), `deep-chain` (the DEEP CHAIN weak spot), `broadcast-fanout` (the
  BROADCAST fan-out), and `dynamic-dep-churn` (the DYNAMIC / SELECTIVE DAG
  wins). Committed median baselines under `harness/VersionMatrix/baselines/`
  are the public evidence surface (each carrying `env` metadata: CPU, node,
  date); the gate itself always re-captures floor / rolling / candidate in the
  same job so it never diffs across hosts. Manifest at `manifest.json` pins the
  floor (`1.3.0`), the rolling reference, and the workload list; adding a new
  version to the matrix is a documented 3-step recipe in
  `harness/VersionMatrix/README.md`.

New root scripts: `test:hardening`, `test:hardening:gc`, `test:harness`,
`test:all`, `gate` (the on-demand VersionMatrix regression gate). The README's
"Test harnesses" section documents all three subdirectories, the setup story,
and the expectation that more dedicated harnesses will land as future
publications need targeted defensive validation.

### Verified

- **Full suite green** against the 1.4.0 engine: 425 tests, 415 pass, 0 fail,
  10 skip (this counts the four branch-closure tests added to `12-coverage` for the
  1.4.0-rc coverage pass; re-verify against your own runner). The 10 skips are the 9 `{skip:true}` `signalBox` tests in `24-signalbox`
  (staged for 1.5.0) plus 1 architecturally-N/A SSR case in `17-reactivity`. The
  eager-default and the counter additions changed no existing test outcome; 6 new
  counter tests in `03-pool` cover the new surface.
- **Coverage** (c8@11, Node 22): `Signal.js` 100% statements / 100% branches /
  100% functions / 100% lines; `Watch.js` 100% across all four. The three counter
  bumps sit on already-covered acquire / dispose / grow edges. The rc coverage pass
  closed the last branch gap (98.26% -> 100%): three reachable branches gained tests,
  two provably-unreachable clamps got `/* c8 ignore */` with proofs, and one branch
  pair reachable only through a now-fixed dangling-cursor crash was removed with the
  fix. See `COVERAGE-NOTES.md`; reconfirm under codify.
- **Counter correctness** confirmed directly: after building a signal ->
  computed -> effect graph, `totalAllocations` equals the node count and
  `totalDisposals` tracks effect/computed teardown; forcing a pool past its
  ledger under `onCapacityExceeded: "grow"` increments `poolGrowths`; an
  eager pool sized to cover its graph keeps `poolGrowths` at 0.
- **Zero-GC steady state holds**: the counters bump only on acquire / dispose /
  grow, none of which occur on the steady-state write path after warm-up. Writing
  through a built graph allocates nothing and moves no counter.
- **`stats()` shape** is now the authoritative 11-key 1.4.x shape, pinned by a
  new shape-and-initial-zeros test in `03-pool` -- the first explicit pin for
  the `stats()` surface (the 1.2.x / 1.3.0 entries described the absence of the
  counters in prose; 1.4.0 codifies the new shape as a test assertion).
- **Fresh 1.4.0 bench sweep published** in `bench/results.txt` (isolated
  propagation, 9 scenarios) and `bench/resultsReactive.txt` (cross-framework
  reactivity, median-of-10, 34 tests) -- the 1.3.0 numbers were carried
  forward provisionally in the 1.4.0-beta notes ("a fresh run will be
  published when available"); those runs are now committed. The 10 raw
  reactive-suite runs sit under `bench/bench-runs-reactive/run_1.txt` ...
  `run_10.txt` so anyone can re-median them independently. On the propagation
  bench, lite is still +48% / +44% / +35% / +30% on the four allocation-heavy
  scenarios (SELECTIVE DAG / DYNAMIC DAG / MUX / SMALL SELECTIVE), parity on
  the three stable app shapes (KAIROS / LARGE WEB APP / WIDE DENSE, within
  3-5%), and behind on BROADCAST (-11%) and DEEP CHAIN (-29%; the DEEP CHAIN
  gap widened this cycle -- alien's 256-deep pipeline got faster, not because
  lite regressed). On the reactive suite, lite is the fastest of five
  frameworks on all five dyn rows (large web app +9%, wide dense +4%, simple
  +18%, dynamic +16%, deep +20%) and trades within a few percent on
  updateComputations (lite ahead on 4 of 7). The Andrii Volynets js-reactivity-
  benchmark position holds at **4th of 15** with geomean **76.3ms** (raw log
  `bench/AndriiVolynetsReactiveBench.log` -- all 15 x 47 rows checked in for
  audit); lite is ahead of 5th-place Preact Signals (78.4) by ~3%. The
  outright-fastest-of-15 shape count moved from three (`manyEffectsFromOneSource`,
  `manySourcesIntoOneComputedEffect`, `manySourcesIntoOneComputedEffectWithDirect`)
  in the 1.3.0 log to five in the 1.4.0 log (`manyEffectsFromOneSource`,
  `manySourcesIntoOneComputedEffectWithDirect`, `molBench`,
  `updateComputations2to1`, and the `32x8 - 4 sources - pull` DAG); top-3
  count moved from 21/47 to 23/47. Both movements are within the run-to-run
  band of the 10-year-old measurement host, not engine changes -- the hot
  paths did not move.

## [1.3.0] -- 2026-06-XX

The pool minor: the node and link pools become **growable and incrementally
populated**, the propagation mark phase moves to an **intrusive linked-list
stack**, and a small **registry config surface** (`prealloc`,
`onCapacityExceeded`, `maxFlushPasses`) is exposed. Drop-in over 1.2.2 -- the
hot paths and public callable API are byte-identical; everything here is pool
mechanics, construction-time behavior, and new opt-in config. Steady-state
zero-GC is unchanged: after warm-up the pools recycle exactly as before.

**Default behavior: `prealloc: "eager"`.** The pools are preallocated up front
by default, preserving 1.2.x's deterministic-latency profile (no allocation
inside a hot loop or render frame -- the contract that matters for the 16ms /
120fps Twitch-overlay and canvas use cases this engine targets). Lazy population
is available as an opt-in (`prealloc: "lazy"`) for footprint-sensitive or
fast-cold-start consumers. See the tradeoff note under *Added -- registry config*.

### Added -- growable pools (`onCapacityExceeded: "grow"`)

The node and link pools can now grow past their initial capacity instead of
only throwing. Growth is **chunked and incremental**, not a single doubling
burst:

- **Link pool** refills in contiguous runs of up to **1024** links per
  free-list miss; **node pool** in runs of up to **256**. This bounds any
  single growth pause to roughly `chunk x ~0.5us` and keeps the freshly
  constructed slots contiguous in memory (better locality than scattered
  one-at-a-time `new`).
- `onCapacityExceeded` (default `"throw"`) selects the policy: `"throw"` fails
  fast with a `CapacityError` when a pool is full (the 1.2.x behavior, now
  named); `"grow"` extends the pool on demand. Link growth is bounded by a hard
  ceiling of `maxLinks * 16`.
- The growth path **no longer length-extends the effect queues or mark stack**.
  Previously `arr.length = newCap` permanently converted those arrays from
  PACKED to HOLEY elements-kind -- a silent flush-path tax. They now grow by
  sequential `arr[len++] = x` appends, which keep them packed.

### Added -- registry config surface

`createRegistry(config)` accepts three new options. All are additive and
non-breaking; omitting `config` reproduces 1.2.x behavior with the eager
default.

- **`prealloc`** (`"eager"` default | `"lazy"`). `"eager"` constructs the full
  `maxNodes` / `maxLinks` pools up front -- deterministic latency, zero
  allocation inside any subsequent hot path, at the cost of a larger resident
  heap that every major GC must trace. `"lazy"` treats `maxNodes` / `maxLinks`
  as capacity *ledgers*, constructs nodes/links on first demand, and recycles
  through the free lists thereafter -- smaller heap, faster cold start, lighter
  GC marking, identical zero-GC steady state after warm-up. **Choose eager for
  hard-real-time (render loops, game ticks, extension frame budgets); choose
  lazy for footprint-sensitive or short-lived registries.**
- **`onCapacityExceeded`** (`"throw"` default | `"grow"`) -- see above.
- **`maxFlushPasses`** (default `100`) -- cycle-protection ceiling: the maximum
  number of effect-queue drain passes before the flush throws an `Error`
  prefixed `"CycleError:"`. Exposes what was a fixed internal bound so
  pathological-but-legitimate deep-cascade graphs can raise it.

### Changed -- intrusive mark stack in `markDownstream`

The propagation mark phase now walks an **iterative DFS backed by an intrusive
linked-list stack** (a `nextMark` field on each node) instead of a separate
`markStack` container array. Because `nextMark` sits adjacent to the
`markEpoch` field that the same sweep reads, the stack write lands in an
already-hot cache line. Behaviorally identical -- same nodes marked in the same
order, same glitch-free guarantee -- and it removes the container array's growth
and HOLEY-conversion concerns entirely. The mark stack never grows the JS call
stack regardless of graph depth (the iterative property from 1.2.4 is retained).

### Added -- `ReactiveNode.nextMark`

One field added to the node shape to back the intrusive mark stack. Initialized
to `null` on construction, cleared on pop during a sweep and defensively on
dispose, so the chain stays clean for reuse. This is the only node-shape change
in 1.3.0.

### Verified

- **Full suite green** against the 1.3.0 engine: 423 tests, 413 pass, 0 fail,
  10 skip (9 signalBox-staged-for-1.5.0 in `24-signalbox` plus 1 architecturally-N/A
  SSR case in `17-reactivity`). The eager-default flip changed no test outcome.
- **Behavior-preservation difftest**: 20,000 direct + 10,000 batched writes
  against the published 1.1.5 reference, 0 disagreements. Pool growth, chunked
  refill, and the intrusive mark stack do not alter observable propagation.
- **Zero-GC steady state holds**: after warm-up, writing through a built graph
  allocates nothing and the pool does not grow (eager) / does not grow further
  (lazy, post warm-up). Confirmed across deep-chain, wide fan-out, and batched
  scenarios.
- **`stats()` shape unchanged from 1.2.x** (8 keys). The cumulative allocation
  counters (`totalAllocations` / `totalDisposals` / `poolGrowths`) remain
  reserved for 1.4.0 and are still absent here.

## [1.2.2] -- 2026-06-14

A code-deletion ship: a `createNode` audit removes ten redundant field-writes
that defended against a state the engine cannot produce on a clean free-list.
No public surface change, no semantic change, no new tests required for new
behavior (because there is none) -- only an added invariant suite that pins
the cleanliness claim the audit relies on. Drop-in over 1.2.1.

**Version lineage note.** This is the engine previously labeled `1.2.3` in dev.
Renumbered to `1.2.2` to keep semver tidy: the deletion is small, isolated, and
intentionally non-behavioral; bumping the patch rather than the minor reflects
that. The upcoming `1.3.0` (lazy/chunked pool with `prealloc:"eager"` default
and intrusive mark stack) carries the next minor bump.

### Changed -- clean free-list invariant audit in `createNode`

Two clusters of redundant writes removed. Both rely on a single invariant:
**every node leaving the pool has the listed fields at their fresh-construct
default values** because `disposeNode` and `runCleanup` already null them and
the `ReactiveNode` constructor initializes them to the same values on
fresh-pool-growth allocation.

- **Seven graph/batch fields** no longer rewritten on every allocate:
  `headDep`, `tailDep`, `headSub`, `tailSub`, `revertEpoch`, `preBatchValue`,
  `preBatchVersion`. Paired-checked: `disposeNode` clears all seven on the
  recycle path; the `ReactiveNode` constructor inits all seven to the same
  values on the fresh-allocation path used by pool growth.
- **Three owner-tree fields** in the non-adoption path no longer rewritten:
  the `firstOwned = null`, the adoption-path `prevOwned = null`, and the
  else-branch `owner = null`. The `disposeNode` direct path nulls
  `owner / prevOwned / nextOwned`; the `runCleanup` cascade path nulls them
  on every disposed child and sets the parent's `firstOwned = null` at exit.
  The constructor inits all four owner-tree fields to `null` on
  fresh-allocation.

What `createNode` still writes are the *lifetime* writes for the new resident:
`value`, `flags`, `id`, and the three fields `disposeNode` does NOT touch
(`version`, `evalVersion`, `markEpoch` -- propagation state that must reset for
the new lifetime), plus the conditional owner-adoption splice
(`owner`, `nextOwned`, parent chain link).

### Added -- `test/10-free-list-invariant_test.mjs`

A three-test invariant suite that asserts the audit's claim by inspecting
freshly-allocated nodes' underlying field state (via the documented
`describe()` -> `NODE_PTR` surface, the same protocol devtools uses). Tests:

- Recycled slot reports null `headDep/tailDep/headSub/tailSub` and zero
  `revertEpoch/preBatchVersion`, undefined `preBatchValue`, after disposing
  a real signal->computed->effect graph.
- Recycled slot reports null `owner/prevOwned/nextOwned/firstOwned` after an
  owner-cascade tears down a nested observer tree.
- Mixed-pattern churn (simple, batched-write, error-flush) leaves no dirty
  state on the free list across 32 follow-up allocations.

If any future change reintroduces a write to a clean-state field on the
dispose path or removes a write that turns out NOT to be redundant, this
suite catches it.

### Added -- `test/11-devtools-contract_test.mjs`

A 12-test smoke probe of the introspection surface that lite-devtools 1.1 /
lite-studio 1.1 consume. Verifies handle resolution + walkers, owner-tree
walkers, the `onGraphMutation` push hook, the `observeObservers` ghost
contract (zero added nodes under heavy introspection), and pins the
authoritative 1.2.x `stats()` shape (exactly 8 keys: `signals`, `computeds`,
`effects`, `activeNodes`, `activeLinks`, `pooledLinks`, `nodePoolCapacity`,
`linkPoolCapacity`). Also pins the absence of `totalAllocations` /
`totalDisposals` / `poolGrowths` on 1.2.x -- those are reserved for 1.4.0 and
the test fails if they appear early.

### Verified

- **408 tests total: 398 pass, 10 skip, 0 fail** across the 23 active
  suites (01-09 baseline + 11-23 introspection/ownership/perf-pin + my new
  25 devtools-real-boot + 26 free-list-invariant). The 10 skips are 9
  signalBox-staged-for-1.5.0 in `24-signalbox` and 1 architecturally-N/A
  SSR case in `17-reactivity`.
- **Coverage on `Signal.js`: 100% statements, 98.43% branches, 100%
  functions, 100% lines.** `Watch.js`: 100% across all four. (c8@11,
  Node 22.) Better branch coverage than the 1.2.1 baseline documented in
  `llms.txt` (was 98.07%); the engine path that closed the gap was a
  targeted test of the swallow-on-self-dispose-then-throw branch in
  `pullComputed`. The remaining ~5 unreached branches are exactly the
  unreachable-by-construction cases already catalogued as `/* c8 ignore */`
  candidates in `COVERAGE-NOTES.md` (cursor fast path, batch wraparound
  sentinel, etc.).
- **Devtools 1.1.0 + Studio 1.1.0 contract: green.** Test
  `25-devtools-real-boot` boots the actual `Devtools.js` against the
  1.2.2 engine and exercises all 19 exports + the 10 symbols Studio
  imports from Devtools. The ghost contract holds (heavy introspection
  adds zero nodes). One real test-rig finding surfaced during this work:
  if the engine is developed in a repo whose own `package.json` declares
  `name: "@zakkster/lite-signal"`, importing the package by name from the
  project root can resolve to a different module instance than imports
  from inside a sibling `node_modules/@zakkster/lite-devtools/`,
  fragmenting the `defaultRegistry`. This is purely a dev-loop / test-rig
  matter (not an engine, devtools, or studio bug) -- in a real consumer
  installation both packages live in `node_modules` and resolve once.

### Not changed

- Public API: no additions, no removals, no signature changes.
- Type surface: `Signal.d.ts` unchanged.
- Behavior: every existing test case in 01-09 passes unmodified.

### Honest notes

- **Perf**: no microbench numbers cited. Ten removed field writes per
  `createNode` is a real saving on creation-heavy workloads, but creation
  cost is dominated by the owner-adoption splice and the optional mutation
  hook, not by these writes. Any "X% faster on creation" claim would need
  to come from a per-run lite-vs-alien measurement on the project's
  standard benchmark harness; this ship does not include one because the
  audit is justified by correctness (clean invariant beats defensive
  writes) rather than measured speedup.
- **Differential testing**: the retracking difftest harness expects two
  engine builds (REF = prior shipped, CANDIDATE = under review). This ship
  was validated against itself (30,000 writes, 0 disagreements), which
  proves determinism but not 1.2.2-vs-1.2.1 behavioral equivalence --
  equivalence is argued instead from the audit being a code-deletion of
  writes provably-redundant under the existing pre/post-invariants, and
  from the full 01-09 suite passing unmodified.

### Benchmarks

The audit ship does not move the curve on any benchmark -- by design;
the steady-state hot paths are byte-identical to 1.2.1. The bench
results were re-measured against 1.2.2 on the project's reference host
(2016 MacBook Pro, Intel, Node 22) and are published as the baseline
for the next version. See [`bench/results.txt`](./bench/results.txt)
(in-house anti-DCE harness, median-of-3 cold-process runs from
`bench/run-all.sh`), [`bench/resultsReactive.txt`](./bench/resultsReactive.txt)
(community reactive suite, 10 raw runs), and the third-party
[js-reactivity-benchmark](https://github.com/volynetstyle/js-reactivity-benchmark)
results (16 frameworks). Position on the third-party suite: **#4 of 16
by geomean** (2.05× vs alien-signals 1.00×), behind alien-signals,
reflex, and @reactively; ahead of Preact Signals (2.09×), uSignal,
$mol_wire, and 9 others. Outright wins on `manyEffectsFromOneSource`
and `manySourcesIntoOneComputedEffectWithDirect`; top-3 finishes on
18 of 47 tests. The version dependencies used for these numbers are
pinned in [`bench/package.json`](./bench/package.json) at
`lite-signal-bench@2.2.0`.

## [1.2.1] -- 2026-06-12

A correctness-and-pauses patch in two halves: the pool allocator stops paying
for growth in unbounded bursts, and the introspection surface stops lying about
handles the 1.2.0 owner tree disposed behind your back. Plus the graph-mutation
hook -- the keystone that lets lite-devtools 1.1 / lite-studio 1.1 go push-based.
Drop-in over 1.2.0: 404-test suite green, 177/178 on
johnsoncodehk/reactive-framework-test-suite (same single open cell, Inner
Write #179), hot-path regression gate flat on two hosts.

### Fixed -- bounded pool growth (no more construction bursts)
- Under `onCapacityExceeded: "grow"`, exhausting a pool used to double it by
  synchronously constructing `currentCapacity` fresh nodes/links -- at a
  524,288-node pool that is a quarter-million 25-field allocations in one
  pause, in whatever frame triggered it. Growth is now incremental: **one**
  node/link constructed per free-list miss, pushed into the pool, recycled
  forever after. The capacity **ledger** still doubles, so `stats()`
  (`nodePoolCapacity` / `linkPoolCapacity` / `pooledLinks`), the
  `maxLinks × 16` ceiling, and every `CapacityError` are bit-identical to
  1.2.0 -- only the construction schedule changed. Locked by the existing
  `test/03-pool` capacity/ceiling/recycle contracts.
- Benchmark effect (volynetstyle/js-reactivity-benchmark, same host as the
  1.2.0 baseline run): creation group 489 -> 423 ms (-13.5%), with the burst
  cases roughly halved (`1to2` 112 -> 58, `1to8` 113 -> 55, `1to4` 81 -> 54).
  Honest redistribution note: rows that previously *fit inside the doubling
  overshoot* (`createDataSignals` 12.8 -> 71.9, `1to1` 17.8 -> 43.2) now pay
  their construction inside the measured window -- 1.2.0's overshoot was an
  accidental prefetch, and the same mechanism produced the pathological
  bursts. Bounded pauses are the right trade for real applications; the
  group total still improves.
- Steady-state hot paths are untouched (update / dynamic-retracking /
  effect-recycle measured flat on both benchmark hosts).

### Fixed -- effect queues / mark stack stay PACKED
- Pool growth used to pre-size `effectQueueA/B` and the mark stack with
  `arr.length = newCap` -- which permanently converts a PACKED V8 array to
  HOLEY elements, a silent tax on every subsequent flush read. The queues now
  grow by sequential append (packed-preserving, auto-amortised) and
  `destroy()` truncates instead of null-filling to capacity.

### Fixed -- `destroy()` iterates physical pools
- `destroy()` walked `currentNodesCapacity` slots by index; with incremental
  growth (and any future lazy population) the ledger can exceed the physical
  pool. It now walks `nodePool.length` / `linkPool.length` and is safe on an
  empty pool.

### Fixed -- stale-handle introspection (the owner-tree follow-up)
- 1.2.0's owner tree made the engine recycle pool slots **autonomously**: an
  owner re-run cascade-disposes its owned observers, so holding a stale handle
  stopped being a user error and became a routine occurrence. The
  introspection surface -- `nodeId` / `describe` / `forEachObserver` /
  `forEachSource` / `hasObservers` / `observeObservers` -- still resolved
  `NODE_PTR` without a generation check and would happily report the
  **recycled slot's new resident** (wrong id, wrong value, wrong edges)
  through an old handle. All six entry points now resolve through a
  gen-guarded `liveNode()` and report stale handles as `undefined` (or throw
  the existing `TypeError`, for `observeObservers`) -- the same ABA discipline
  `read()` / `set()` / `dispose()` already had.
- `describe()` descriptors are now **gen-stamped** alongside the node
  reference, so the documented "descriptors are re-walkable handles" contract
  survives the guard: a fresh descriptor walks; one held across a recycle
  correctly goes stale. Pinned by the existing
  "forEach* descriptors carry id and are re-walkable" test.
- **Effect dispose handles are now first-class introspection handles.** On
  every prior version, `effect()` returned a bare closure carrying neither
  `NODE_PTR` nor `NODE_GEN` -- so `describe` / `nodeId` / `forEachSource`
  returned `undefined`/empty for a **live** effect handle, and
  `observeObservers(effectHandle)` threw. The dispose function is now stamped
  with the same symbol pair as signal/computed handles (`NODE_GEN` mirrors the
  disposer's own `birthGen`, so introspection validity agrees exactly with its
  stale-guard). After explicit dispose, slot recycle, or owner-cascade the
  handle correctly reads stale. Measured cost: two property stores per effect
  creation (~50 ns on a create/dispose churn microbench) -- symmetric with
  what signal/computed handles already pay, create-path only. Found by the
  lite-devtools 1.1 cross-probe campaign (`track(effectHandle)` threw).
- `peek()` had the same hole: `sharedSignalPeek` / `sharedComputedPeek`
  resolved the slot ungated, so a stale handle's `peek()` returned the new
  resident's value. Both now gen-check first and return `undefined` when
  stale -- closing the last unguarded entry point in the probe-c1 ABA family.
  Measured cost: 4M peeks 7.1 -> 7.4 ms (~0.08 ns/op).

### Added -- `onGraphMutation(fn)`: the graph-mutation hook
- Registry-level (and default-registry module export) debug hook, the
  connection point for push-based tooling. Single nullable listener; every
  fire point is one `if (mutationHook !== null)` branch and the dispatch is
  allocation-free -- `(opcode, intA, intB)`:
    - `1` node create -- `(id, flags)`, end of `createNode`
    - `2` node dispose -- `(id, flags)`, top of `disposeNode` (cascades included)
    - `3` link add -- `(source.id, target.id)`
    - `4` link remove -- `(source.id, target.id)`
    - `5` recompute -- `(id, 0)`, before an effect re-run / computed re-eval
- Cost: **zero when unregistered** (hot-path gate flat); registered, the
  worst case measured is +29% on a dynamic-retracking torture loop (11.4M
  events for 400K writes) -- a debug-mode tax paid only while a consumer is
  attached, proportional to event volume.
- **Listener contract: observe only -- never throw, never mutate the graph.**
  The hook fires synchronously inside mutation points; lite-devtools 1.1
  multiplexes all of its consumers behind one registration, isolates their
  exceptions, and unregisters when the last consumer stops (returning the
  engine to the zero-cost state). `onGraphMutation` returns an unsubscribe
  that restores the previously registered listener.

### Added -- owner-tree introspection: `forEachOwned` / `ownerOf`
- The 1.2.0 owner tree finally gets a (read-only, gen-guarded) window:
  `forEachOwned(handle, fn)` iterates a node's owned children as standard
  re-walkable descriptors; `ownerOf(handle)` returns the owner's descriptor
  or `undefined` (top-level or stale). Same descriptor conventions as
  `forEachObserver` / `forEachSource`; garbage input is a no-op /
  `undefined`. This is what lite-devtools 1.1 builds `ownerTree()` and the
  `graph({owners: true})` ownership edges on
  (`capabilities().owners === true` from this release).

### Compatibility
- No behavioural change for live handles; stale handles now read as stale
  everywhere instead of as the slot's next tenant. Allocation strategy is
  unobservable through the public API. Tooling floor: lite-devtools >= 1.1.0
  detects `onGraphMutation` / `forEachOwned` at load and degrades to its
  1.0 polling behaviour on older engines.

## [1.2.0] -- 2026-06-11

A structural refactor that internally splits the engine into three named layers
(graph topology / ownership-lifecycle / propagation-execution) with a strict
dependency direction, plus a small set of additive features built on top of
that split. No behavioural changes for existing code -- drop-in over 1.1.5.

### Added -- auto-disposal of nested observers (owner tree)
- An effect or computed that creates **observers** (nested `effect`/`computed`)
  now owns them via an internal owner tree. When the owner re-runs or is
  disposed, all owned observers are cascade-disposed before the new run starts.
  This is what closes the long-standing "nested effects leak on re-run" hazard
  that other engines fix with `createRoot` wrappers.
- **Plain signals are deliberately NOT owner-adopted.** Lazy-allocation
  wrappers (`lite-store` allocates a key's signal on first read, `lite-form`
  allocates lazy fields the same way) depend on a lazily-created signal
  surviving its allocating computed's re-runs. The rule is:
  *observers cascade with the owner; signals do not.* Locked in by 5 tests in
  `test/15-owner-lazy-alloc.test.mjs` (the lite-store cross-wire shape) and
  the new `test/19-v12-additions.test.mjs`.

### Added -- pre-batch revert (the "set X, set X back" optimisation)
- Inside a `batch(...)`, if a signal is set and then set back to its
  pre-batch value (under the signal's own `equals`), the version bump is
  reverted and downstream effects/computeds do **not** fire. Eliminates a
  whole class of "spurious re-run from a temporary mutation" patterns common
  in form state and undo/redo. Verified end-to-end (signal, computed, effect)
  in `test/19-v12-additions.test.mjs`.

### Added -- multi-effect throws aggregate to `AggregateError`
- When two or more effects throw in the **same flush pass**, the engine
  collects all errors and rethrows a native `AggregateError` at the
  triggering `set()` / batch boundary. A single thrown error is rethrown
  unwrapped (no change). Effects that don't throw still run. Cycle detection
  unchanged -- a flush exceeding `maxFlushPasses` (default 100) throws an
  `Error` prefixed `"CycleError:"`.

### Added -- scheduler thunk caching with gen-bound ABA guard
- `effect(fn, { scheduler })` now caches the scheduler thunk on the node
  itself (`node.schedulerThunk`) so repeated re-schedules reuse the same
  closure (no allocation per re-schedule). The thunk holds a generation snapshot
  taken at effect creation: after `dispose()` the engine bumps the node's
  generation, so a stale thunk fired by an async scheduler against a recycled
  pool slot is a guaranteed no-op (ABA safe).

### Changed -- internal refactor, no behavioural difference
- The engine is reorganised into three explicit layers with documented
  invariants (see the file header in `Signal.js`):
    - **L1 Graph topology** -- `allocateLink` / `freeLink` / `severTail`. Pure
      edge mechanics. Never touches `owner` / `firstOwned`.
    - **L2 Ownership/lifecycle** -- `createNode` / `disposeNode` / `runCleanup`.
      Owns the owner tree and user cleanup. Never touches the tracking cursor.
    - **L3 Propagation/execution** -- `markDownstream` (cursor-free), and the
      orchestrators `executeEffect` / `pullComputed` that drive the cursor
      (L1) and call `runCleanup` (L2) before a re-run.
- `currentObserver` and `currentOwner` are now distinct pointers. Today they
  move together (no behavioural change), but the split paves the way for
  future `runWithOwner`/`createRoot` without coupling tracking and lifecycle.
- **Shared `peek` (perf).** `signal()` and `computed()` now reuse a single
  `peek` function per registry instead of allocating a fresh closure per
  primitive. Equivalent across registries (each registry has its own pair).
  ~10-14% faster signal/computed creation on the `S:create*` micros, no
  hot-path or behavioural change. Verified by 5 dedicated tests + the full
  309-strong existing suite + 30,000-write differential retracking fuzz vs
  the published 1.1.5.

### Changed -- port-forward of the 1.1.3/1.1.4 perf fixes
- `pullComputed` retains the **`markEpoch` clean short-circuit** -- re-reading
  a computed after an unrelated source changed is O(1).
- `allocateLink` retains the **O(1) `tailSub` dedup** -- divergent re-tracking
  remains O(N), not O(N^2). The same documented edge note applies: a nested
  re-read of the same source after an intervening observer can retain one
  duplicate link per intervening edge, bounded by the loop count and
  dispose-reclaimed.

### Fixed -- conformance regressions surfaced during release prep
- **#141 (`dispose during execution then continue: no re-run`)**: an effect that
  called its own dispose handle mid-run and then continued to read another
  signal would corrupt the link-list bookkeeping in `severTail` (latent crash
  present in 1.1.5 too -- the v1.2 owner tree exercised the path more
  aggressively and made it visible). Fixed by nulling the tracking cursor in
  `disposeNode` when the disposed node is the active observer, plus a
  gen-snapshot guard in `executeEffect` / `pullComputed` so a post-body
  `severTail` on a recycled slot is skipped.
- **#238 / #241 / #243 (cleanup ordering)**: nested effect cleanups must fire
  inside-out on owner-tree disposal -- grandchild before child before outer.
  The previous `runCleanup` ran the node's OWN cleanup before cascading, which
  surfaced on cascade-dispose, on owner re-run, AND on the regression path
  where an inner-only re-run had fired first. Fixed by swapping the order:
  cascade children first, then own. Matches React / Solid (children may rely
  on parent state being live at cleanup time; never the reverse).
- Permanent regression guards for all four landed in
  `test/20-axis-stress.test.mjs` under "Conformance pins" (7 new tests across
  two suites; includes a BONUS test for the re-run cascade path which has the
  same invariant).

### Test suite (released numbers)
- 363 tests / 133 suites total, all passing under `node --expose-gc --test`.
- **100% line coverage** and **98.62% branch coverage** on `Signal.js`
  + `Watch.js` (the few uncovered branches are defensive guards: cycle
  detection, batchEpoch wraparound after 2^3^2 batches, and the self-dispose
  `gen` branches added by the conformance fixes -- unreachable from
  conformance + existing user code).
- New file `test/19-v12-additions.test.mjs` (24 tests) locks in shared peek,
  owner adoption rule, pre-batch revert, AggregateError aggregation,
  CycleError detection, the `maxLinks` config branch, the disposed-signal
  read/set behaviour, and the stop-fn ABA guard.
- New file `test/20-axis-stress.test.mjs` (23 tests) -- eight orthogonal
  engine-invariant "axes" plus the permanent conformance pins for #141,
  #238, #241, #243.
- Existing `test/15-owner-lazy-alloc.test.mjs` skips ("scheduler-thunk
  caching lands in v1.2.0") are removed -- the owner tree exists, the
  tests pass.
- Differential retracking fuzz against the published 1.1.5: 30,000 writes,
  **0 disagreements** (`bench/retracking.difftest.mjs`).

### Notes for users
- **Drop-in.** No public surface removed. Behaviour identical to 1.1.5 except
  for: (i) the owner-cascade auto-dispose of nested observers (was: leaked),
  (ii) the pre-batch revert (was: always fired even if reverted), and
  (iii) multi-throw aggregation. (i) and (ii) are silent wins; if you
  previously caught the first thrown effect in a flush, you now get an
  `AggregateError` whose `.errors[0]` is what you used to get.
- The "scheduler-thunk caching" hint that referenced an older internal
  staging name (Signal-1.3.0-rc) is gone; the file is the public 1.2.0.

## [1.1.5] -- 2026-06-04

Additive release in service of `@zakkster/lite-devtools`: stable node identity on the
introspection surface, so a tool can dedupe and traverse the full reactive DAG. Drop-in
over 1.1.4, no breaking changes.

### Added -- node identity (top-level + per-registry)
- `nodeId(handle)` -> the node's stable per-allocation id (`number`), or `undefined` for a
  non-handle. The dedupe key for graph walks.
- `describe(handle)` -> the handle's own `{ id, kind, value }` descriptor, or `undefined`
  for a non-handle. **Re-walkable**: the descriptor may be passed back into
  `forEachObserver`/`forEachSource` -- the recursion primitive for full DAG discovery.
- `forEachObserver`/`forEachSource` descriptors now carry `id` (`{ id, kind, value }`).
- Every node gains a stable `id` assigned at allocation: one SMI write at creation, node
  shape kept uniform (monomorphic). **Zero steady-state cost.**

### Test suite
- Added `test/15-identity_test.mjs`: 5 tests -- ids unique + stable, `nodeId`/`describe`
  undefined on non-handles, descriptor shape `{ id, kind, value }`, descriptors re-walkable,
  identity walks non-perturbing.

## [1.1.4] -- 2026-05-31

Combined release: a retracking rewrite that closes the two documented chaotic
read-order limitations, plus an observer-lifecycle introspection surface. No
breaking changes, no public-API removals -- drop-in over 1.1.3. (This release
folds in the work that was internally staged as 1.1.4 and 1.1.5; it ships as a
single 1.1.4.)

### Changed -- performance (retracking, no semantic change)
- **Version-stamped O(1) reconciliation + clean-read short-circuit.** The cursor
  reconciliation now stamps each source per evaluation and a `markEpoch` guard
  short-circuits the pull when a subtree is already clean. This replaces the
  prior strategy's O(N)-per-dep degradation under chaotic, high-fan-in, batched
  read-after-write (every read re-validating its dependency subtree). Stable
  read order is unchanged -- still O(1) per dep via cursor reuse, still zero-alloc.
- **Result.** The two rows that were the documented v1.1.x limitation flipped from
  multiples-behind to ahead of `alien-signals`, and are now the fastest of the five
  benchmarked frameworks:
    - `dyn: large web app`  6194ms -> **571ms** (~10.9× faster; +9% vs alien)
    - `dyn: wide dense`     5115ms -> **912ms** (~5.6× faster; +10% vs alien)
  No regressions on the other rows (steady-state update, propagation, and creation
  paths are within noise of 1.1.2). See `resultsReactive.txt`.
- **Correctness.** The new retracking is validated by `retracking.difftest.mjs`
  against a reference reconciler: 20,000 direct writes and 10,000 batched writes,
  **0 disagreements**.

### Added -- observer-lifecycle introspection (top-level + per-registry)
A small, zero-cost-when-unused surface for auto-pausing wrappers and devtools.
All accept a public `Signal`/`Computed` handle.
- **`hasObservers(handle)` -> `boolean`.** O(1) (`node.headSub !== null`). The
  auto-pause predicate: is anything subscribed to this source right now? A `peek`
  does not count.
- **`observeObservers(handle, { onConnect?, onDisconnect? })` -> `unobserve`.**
  Fires `onConnect` on the 0->1 observer transition and `onDisconnect` on 1->0,
  *after* registration (transition-only -- no immediate fire if the handle is
  already observed). Re-tracking a persistently-read source does **not** churn
  connect/disconnect. This is the hook `lite-time` / `lite-raf` use to start a
  ticker only while a derived value is being watched.
- **`forEachObserver(handle, fn)` / `forEachSource(handle, fn)`.** Walk the live
  graph in either direction; `fn` receives a `{ kind, value }` descriptor where
  `kind` is `"signal" | "computed" | "effect"`. For graph inspection (lite-devtools).
- **Cost.** The hooks sit behind an internal lifecycle counter -- when no handle is
  being observed, the hot path adds a single branch-predicted `count !== 0` check
  inside link alloc/free and nothing else. Zero steady-state cost when unused.
- **Error contract.** `hasObservers` / `forEachObserver` / `forEachSource` no-op
  on a non-handle argument; `observeObservers` throws `TypeError`.

### Test suite
- Added `test/13-introspection_test.mjs`: 10 tests across 3 describe blocks --
  `hasObservers` (live observation reflects, peek doesn't count), `observeObservers`
  auto-pause lifecycle (start-on-first/stop-on-last, no extra connect for a 2nd
  observer, re-observe fires again, no churn on re-track, conditional reads toggle
  honestly, transition-only registration, works for computeds), and
  `forEachObserver`/`forEachSource` enumeration (both directions, descriptor carries
  kind + value).

### Migration from 1.1.3
None required. Drop-in upgrade. No existing surface or behavior changed; the
introspection functions are purely additive and the retracking change is internal.

## [1.1.3] -- 2026-05-28

Patch release: one new export, no behavior changes, no engine changes -- drop-in
over 1.1.2.

### Added
- **`isTracking()`** (top-level + per-registry). Returns `true` iff a read RIGHT
  NOW would record a dependency on this registry -- an observer body is on the
  stack AND tracking is enabled. Returns `false` inside `untrack()`, inside the
  callback of `signal.subscribe` (which inlines the same untracked-notify), inside
  `onCleanup` bodies, inside the `watch` / `when` callback path, and outside any
  observer. The predicate mirrors the engine's own read-trap check
  (`isTrackingDeps && currentObserver !== null`) so callers stay in lockstep with
  what the engine actually does on a read, not just whether an observer is on the
  stack.

### Why
Wrapper libraries (lite-store, lite-query, lite-form) need to allocate reactive
primitives lazily on property reads to preserve the zero-GC contract. Without a
predicate they must either always allocate (defeats the point) or inspect engine
internals (fragile coupling). `isTracking()` is the first-class way to gate
allocation on whether the read will actually subscribe anything.

### API notes
- **Per-registry.** A wrapper operating against a non-default registry MUST call
  THAT registry's `isTracking()`, not the top-level one -- each registry has its
  own tracking state. The top-level helper delegates to the default registry,
  matching the existing pattern for `signal`/`computed`/`effect`/`untrack`.
- **Cost.** Two closure-variable loads, one AND, one return; V8 inlines it.
  Roughly 1-2 ns per call.

### Test suite
- Added `test/10-is-tracking_test.mjs`: 11 tests across 5 describe blocks --
  observer-bodies (effect + computed), untracked windows (`untrack`, `subscribe`
  callback, `onCleanup`, `watch` callback), outside-observer (module scope,
  call-site of unobserved computed read), robustness (state restored after
  observer body throws, per-registry isolation), and the top-level binding.

### Migration from 1.1.2
None required. Drop-in upgrade. No existing surface or behavior changed.

## [1.1.2] -- 2026-05-26

Patch release: hot-path micro-optimizations and a zero-allocation cleanup of
the creation path. No behavior changes, no API changes -- drop-in over 1.1.1.

### Changed -- performance (no semantic change)
- **Inlined cursor fast-path in `signal()`/`computed()` reads.** On stable read
  order the cursor match is now handled inline; only a cursor *miss* falls
  through into the (large, non-inlinable) `allocateLink` frame. Removes a
  function call from the steady-state read hot path.
- **Allocation-free creation.** `signal`/`computed`/`effect` now read their
  `opts` argument defensively instead of defaulting the parameter to `{}`. The
  `= {}` default allocated a throwaway object on every no-opts call -- the common
  path when mounting many cells. Creation is now zero-allocation on that path.
- **Single-closure `subscribe`.** The tracked read + untracked notify is inlined
  (one closure instead of two), dropping a per-subscription closure and an
  `untrack` wrapper call on every fire.
- **`markDownstream` micro-cleanup.** Combined `(FLAG_QUEUED | FLAG_COMPUTING)`
  test and tightened stack/queue index arithmetic. The `flags` read stays inside
  the `markEpoch` dedup guard on purpose (hoisting it would add work on the
  already-marked revisit path that the guard exists to keep cheap).

### Changed -- packaging
- Canonical single-engine layout: the implementation is `Signal.js` and the
  watcher utilities are `Watch.js`, which imports `effect`/`untrack` from
  `./Signal.js`. Both the public entry and `Watch.js` resolve to one engine
  instance -- eliminating any chance of a duplicate-module-instance split that
  would silently break cross-module dependency tracking.

### Test suite
- `tests/09-conformance.test.mjs`: the owner-tree conformance items **#209** and
  **#210** (three-level cascading disposal; inner-effect cleanup on outer re-run)
  are marked skipped with a v1.2 pointer. The baseline engine maintains no owner
  tree; these are validated against the v1.2 ownership hybrid. All other
  conformance items pass.

### Performance
- Steady-state hot path remains **0 allocations** (`signal.set`, `peek`, computed
  read, effect re-run, dispose). Creation path now also 0-allocation on the
  no-opts common case. Re-run `npm run bench` on your target host for current
  ops/s; the 1.1.1 numbers stand as a floor.

### Migration from 1.1.x
None required. Drop-in upgrade.

## [1.1.1] -- 2026-05-22

Patch release: cleanup-semantics adapter integration, conformance fixes from
the `johnsoncodehk/reactive-framework-test-suite`, and one targeted
correctness bug in flush error reporting.

### Added
- Top-level `destroy()` export. Wipes the default registry; intended for
  test-suite isolation only. Previously the function existed but was not
  re-exported from the package entrypoint, breaking any adapter that
  destructure-imports it.
- `tailSub` field on `ReactiveNode`. Symmetric with the existing `tailDep`;
  enables O(1) tail insertion into the subscriber list.

### Changed -- conformance fixes

- **#216** Effects now fire in **creation order** on a shared signal.
  Subscriber list insertion is tail-first instead of head-first; traversal
  order in `markDownstream` is unchanged. Brings lite-signal in line with
  every other library in the suite except solid-js and pota.

- **#178** `runCleanup` invokes registered cleanups in an **untracked
  context** (`currentObserver = null`, `isTrackingDeps = false`). Reads
  inside a cleanup body -- including reads triggered by a synchronous
  `dispose()` from a containing effect -- no longer leak into the parent
  observer's dep set.

- **#111** `executeEffect` bails cleanly when a node is disposed by its own
  cleanup. Previously the post-cleanup body invocation hit `undefined()` on
  the cleared `computeFn`.

- **#123 / #132 / #147** **Revert detection in batches.** A signal whose
  in-batch write sequence ends at the pre-batch value (per its `equals`
  predicate) restores its `version` and skips propagation. Captures are
  scoped per top-level batch via a `revertEpoch` counter; the `0` sentinel
  is preserved through SMI wraparound by skipping it on increment.

- **#121** **Throw isolation in flush.** Effects that throw during
  `flushEffects` no longer halt the flush. Errors are collected in a
  reused per-registry buffer; on flush completion, a single thrown error
  re-raises as-is, multiple throws raise as `AggregateError`. `isFlushing`
  is now cleared in a `try/finally`, eliminating the registry-deadlock
  that the prior throw-out path would leave behind.

- **#180 / #213** **No-re-run semantics for self-cycles.** An effect that
  is currently executing on the call stack is no longer re-queued by
  `markDownstream` when its own body's writes propagate back through a
  computed chain. Matches S.js / pre-2.0 Solid. Sibling effects on the
  same chain continue to fire normally.

### Fixed
- Flush error buffer no longer leaks across calls when a `CycleError`
  escapes the flush loop. Buffered effect errors are cleared in the
  outer `finally` if the flush is exiting abnormally.

### Performance
- No regressions observed in MUX, BROADCAST, DEEP CHAIN, KAIROS, or
  SELECTIVE DAG benchmarks. MUX moved from 156K to 226K ops/s -- V8 appears
  to optimise the flush loop more aggressively now that the per-iteration
  `try/catch` shape is stable. Out-of-batch `signal.set` is unchanged
  (revert-detection guards short-circuit on `batchDepth === 0`).

### Conformance score
- Before 1.1.1: 145 / 156 (with v1.1.0 adapter pre-fix), 164 / 177
  (corrected adapter, no library fixes).
- After 1.1.1: TBD pending full conformance re-run. Expected: all
  Tier 1 + Tier 2 items closed (#216, #178, #111, #123, #132, #147, #121,
  #180, #213, #235), leaving `#179`, `#209`, `#210` deferred to v1.2
  (owner-tree / computed-self-write).

### Internal test suite
- Added `tests/09-conformance.test.mjs` collecting the upstream test IDs
  by number, with companion tests pinning the design decisions
  (sibling-effect propagation under no-re-run, cycle precedence over
  buffered errors, custom-equals revert, etc.).

## [1.1.0] -- 2026-05-20

### Added
- `markDownstream` iterative DFS marker backed by preallocated `markStack` -- propagation no longer grows the JS call stack regardless of graph depth.
- Double-buffered effect queue (`effectQueueA` / `effectQueueB`) -- effects scheduled mid-flush land in the next pass, no recursive flush.
- Generation counter (`gen`) per node -- stale handles after dispose+recycle silently no-op instead of corrupting the pool.
- `CapacityError` with `kind` (`"nodes"` | `"links"`) and `capacity` fields, thrown when the `"throw"` policy is set and a pool is exhausted.
- `createRegistry({ onCapacityExceeded: "grow" })` -- opt-in unbounded pool growth, bounded by `maxLinks * 16` ceiling.
- `createRegistry({ maxFlushPasses })` -- configurable cycle-protection limit (default `100`).
- `destroy()` -- full registry reset; all prior handles silently no-op afterward.
- `watch(source, callback, { immediate? })`, `when(predicate, callback)`, `whenAsync(predicate)` -- re-exported from `Watch.js`. Zero-allocation hot paths in `watch` and `when`; `whenAsync` allocates one Promise per call (documented; not for per-frame use).

### Changed
- 32-bit modular epoch arithmetic across `globalVersion`, `evalVersion`, `markEpoch`. Engine survives indefinite uptime without integer-overflow risk.
- `dispose(api)` is now universal across signals, computeds, effect handles, and `.subscribe()` return values. Cross-registry calls are silent no-ops. Foreign reactive primitives are duck-typed (on `.peek`) and not invoked.
- `untrack(fn)` restores prior tracking state via `try / finally` -- safe under thrown errors inside `fn`.
- `onCleanup(fn)` now accepts multiple registrations per scope and works in computeds, not just effects. Stored as a single function or upgraded to an array.

### Fixed
- Diamond dependency reads no longer over-fire effects (versioned pull resolves convergence cleanly in one pass).
- Effect re-runs no longer leak link slots when the dep set shrinks (tail-link severance in `severTail`).
- Disposed-then-recycled slots no longer mis-dispose under stale handles (generation guard in `dispose`).
- Cleanup functions registered inside computeds now fire (previously effect-only).

### Performance
- Steady-state hot path: **0 allocations** across `signal.set`, `signal.peek`, computed read, effect re-run, dispose.
- **249K ops/s** on MUX fan-in (Node 22, 2016 MacBook Pro). +20% vs alien-signals on identical workload.
- **15 KB** transient heap across 20,000 iterations.
- Full methodology and reproducibility recipe in [`bench/README.md`](./bench/README.md).

### Known limitations
- Dependency reconciliation is O(1) per read on stable read order; degrades to O(N) under chaotic read order. v1.2 (in benchmark validation) replaces the cursor-based retracking with per-source version-stamped reconciliation -- see [RFC #N1](https://github.com/PeshoVurtoleta/lite-signal/issues/1).
- Computed resolution is recursive on the JS call stack; bounded by the engine stack limit (~10,000 frames).
- `whenAsync` allocates one Promise per call. Use `when` (callback form) for per-frame paths.

### Migration from 1.0.x
None required. Drop-in upgrade.

## [1.0.0] -- 2026-05-12
Initial public release.