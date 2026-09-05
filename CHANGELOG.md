# Changelog

All notable changes to `@zakkster/lite-signal` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [1.6.0-beta-1] -- 2026-08-20

Backports the **1.4.5 `createRegistry` input validation** (all four findings) onto
the 1.6.0-beta engine. Supersedes 1.6.0-beta. Only `createRegistry`'s *cold*
construction path changed -- the hot paths are byte-identical and the zero-GC gates
(`bench/torture/run.mjs` 22/22) are unchanged. If you had a typo in your registry
config, you will now hear about it.

### Added -- createRegistry validates its config (fail closed)

- **Bounded eager construction.** `prealloc:"eager"` with a non-finite or absurd
  capacity (`maxNodes:Infinity`, `maxNodes:1e9`) previously ran an unbounded
  construction loop and killed the process with an **uncatchable SIGABRT**. It now
  throws a `TypeError` **by name**, before allocating, gated on `(maxNodes+maxLinks)`
  against a ceiling of `1<<24` (16,777,216) objects. `prealloc:"lazy"` keeps its
  unbounded on-demand ledger, untouched.
- **Per-option validation by name.** `maxNodes` / `maxLinks` / `maxFlushPasses` must
  be finite integers `>= 1`; `prealloc` must be exactly `"eager"` | `"lazy"`;
  `onCapacityExceeded` must be exactly `"throw"` | `"grow"`. Each bad value throws a
  `TypeError` prefixed `createRegistry: "<option>"` at construction -- not a delayed
  internal `nextFree` TypeError on first use.
- **Config-shape gate.** A non-object, `null`, or array `config` throws
  `createRegistry: "config"` rather than dying later.
- **Unknown-key rejection with did-you-mean.** An unrecognized key throws with a
  Levenshtein suggestion (`maxNods` -> `maxNodes`, `preAlloc` -> `prealloc`) instead
  of being silently ignored.
- **`stats()` gains `nodePoolPopulation` / `linkPoolPopulation`** -- the TRUE count
  of physically constructed nodes/links, distinct from the `*Capacity` ledgers. A
  silently mis-set `prealloc` is now observable (population 0 under lazy) instead of
  telemetry-blind. **The one observable API change: `stats()` grows to 14 keys,
  purely additive** -- no existing key changed; only an exact key-*count* assertion
  is affected (updated in `test/03-pool.test.mjs`).

### Tests

New `test/*-config-validation.test.mjs` adds the full config matrix, the did-you-mean
cases, the eager ceiling, the population contract, and the three OOM rows as isolated
child-process cases proving the fixed engine throws + exits 0 under a 256 MB cap where
the unvalidated engine died.

## [1.6.0-beta] -- 2026-07-27

Promotes `1.6.0-alpha.0` to the `beta` dist-tag. The engine gains one behavioural
fix over alpha.0 -- the dangling re-tracking cursor crash below, which touches
`disposeNode` / `freeLink` -- plus 100% branch coverage and a completed torture
surface; `createScope`, the `flushPasses` stat, and the op-6 / op-7 mutation-hook
opcodes are carried forward from alpha.0 unchanged.

### Added -- torture suite completed: `introspect-torture`, and `scope-torture` now runs

`bench/torture/run.mjs` now registers **22 scenarios (19 semantic + 3 soak)** --
full parity with the shipped 1.4.4 sibling, the forward-compatible superset
through 1.9. This is a **verification-only** parity pass: the engine
(`Signal.js` / `Signal.d.ts`) is **UNCHANGED** -- byte-identical shasum before
and after. Two changes matter on the 1.6.0 engine
specifically. First, **`scope-torture`** -- present but feature-skipped on
the 1.5.0 line -- now **executes**, since `createScope` exists: it fuzzes the
adoption contract (computeds/effects adopted, plain signals not; the
`signals + computeds + effects === activeNodes` invariant), the disposal-crash
repro and a 300-seed fuzz of it, `runWithOwner` re-attachment into a scope, and
pool balance over 200 scope rounds on a hard-ceiling registry. Second, a new
semantic scenario **`introspect-torture`** closes the one 1.6.0 gap the rest of
the suite left open: the read-only introspection surface
(`describe` / `nodeId` / `hasObservers` / `isTracking` /
`forEachObserver` / `forEachSource` / `forEachOwned` / `ownerOf` /
`observeObservers`) that lite-devtools and lite-studio build on. Because these
calls cannot corrupt a value, every value/wakeup/work oracle is blind to them --
so a wrong `hasObservers` or a `forEachSource` that skips a link is a silent
correctness bug in every tool that trusts it. It pins two load-bearing
properties: **walk agreement** (the source/observer walk must match the real edge
set and track dynamic rewiring, cross-checked against both the reference dep set
and the op-3/op-4 link lane) and **the ABA gen-stamp guard** (a descriptor
captured before a node is disposed and its slot recycled must resolve to nothing,
never the new resident -- the only scenario that catches this guard's removal).

Beyond `scope-torture` and `introspect-torture`, five further scenarios are
ported from the 1.4.4 sibling to close the parity gap: **`lifecycle-torture`**
(createRoot detachment + destroy registry reset), **`owner-torture`** (getOwner /
runWithOwner capture-restore, live-adoption cascade, and stale-handle ABA
degradation to rooted), **`error-torture`** (throwing effect bodies: per-effect
buffering, single re-throw vs `AggregateError`, and a 4096-cycle buffer drain),
**`deep-chain-torture`** (pullComputed recursion fail-closed with a `RangeError`
vs the iterative push path), and **`zerogc-torture`** (the zero-GC hot path made
falsifiable via `measureAllocs` / `measureOps` + `stats()` counters, with a
`ZEROGC_BREAK` self-test). Because 1.6.0 ships `createScope` / `getOwner` /
`runWithOwner` / `createRoot` **natively**, the owner/scope/createRoot scenarios
that SKIPPED on 1.4.4 (which lacks `createScope`) **run natively here** and passed
exactly as written -- no assertion needed pinning to a divergent behaviour; the
`churn-box` lane in `zerogc-torture` activates because `signalBox` exists. The
three soaks (`graph-fuzzer`, `scheduler-bench`, `torture-soak`) gain a
value-correctness oracle: a preallocated `Int32Array` shadow of every signal,
checked over a rotating window per tick and swept in full at teardown, alongside
the existing liveness assertions and the module-scoped int32 JIT sink.

Every scenario feature-detects and **skips cleanly** below the engine version
that introduces its feature, so on the 1.6.0 engine the runner executes **16
semantic** scenarios and reports a clean SKIP for the three later-version ones
(`flush-torture` 1.7.0, `cleanup-return-torture` 1.8.0, `dispose-torture` 1.9.0).

### Changed -- test file numbering collision fixed

The new `createScope` unit file shipped as `test/28-scope.test.mjs`, colliding on
the `28-` prefix with `test/28-run-with-owner.test.mjs` (getOwner/runWithOwner).
It is renamed to `test/29-scope.test.mjs`. Both always ran under the
`test/*.test.mjs` glob; the rename only restores the one-file-per-number
convention.

A new unit file **`test/30-throwing-equals.test.mjs`** (numbered 30 -- 28 is
still occupied by both `28-run-with-owner` and the renamed history, and 29 is
taken) pins the behaviour of a user `equals` predicate that throws. It covers all
five physical `eq()` sites: the three callable sites (signal set pre-check
:1105, batch-revert check :1112, computed re-eval :986) with a contrast
anti-tautology test, plus the two `signalBox` boxSet sites (pre-check :1210,
revert :1217) -- confirmed to behave identically to the callable path.

### Verified -- full suite green on the 1.6.0 engine (Node 22, `--expose-gc`)

- **Torture:** 22/22 -- `torture:semantic` 19/19 (16 executed, 3 clean skips),
  `torture:soak` 3/3 (zero errors, value oracle clean, every pool back to its
  leaf-only floor).
- **Unit:** 472 tests, 471 pass, 0 fail, 1 skip (the architectural SSR N/A in
  `17-reactivity`), measured with the sibling `@zakkster/lite-devtools` resolvable
  so the 10-test `test/25-devtools-real-boot` real-rig runs. The +9 over the
  previous cut is the new `test/30-throwing-equals.test.mjs` (throwing-`equals`
  site audit). Without the devtools sibling the 10 real-boot tests do not pass;
  that rig is the only sibling-dependent surface.

### Removed -- `bench-reactive-legacy` (deprecated in 1.5.0)

The pre-v3 five-framework reactivity suite is removed, per the 1.5.0 deprecation
(one-release window through 1.5.1). Cross-framework standing comes from the bench
protocol v3 **mirror** (`bench/mirror.mjs --self-verify` + `bench/sweep.mjs`).

### Changed -- bench protocol v3 (carried forward)

The `bench/` harness is bench protocol v3: three instruments (microscope / mirror /
version-economics), each with a fixed config and a machine-generated `#STAMP`
(engine + harness sha256, live registry config, host, node). See `bench/README.md`.

### Added -- Coveralls coverage badge

README carries a Coveralls badge; lcov is produced by `npm run test:report`
(`coveralls-next` in devDependencies).


### Fixed -- dangling re-tracking cursor on source disposal (crash)

Disposing a signal/computed from inside an observer that had linked it on the
previous run, but had not yet re-read it on the current run, crashed with
`TypeError: Cannot set properties of null (setting 'headSub')`. `disposeNode`'s
sub-list teardown freed the link while the observer's re-tracking cursor
(`activeObserverCurrentDep`) was still parked on it; `severTail` then walked from
a freed link, wiped the observer's `headDep`, and double-freed the link. Reachable
from the plain public API (see `COVERAGE-NOTES.md` for the repro). Fixed with a
one-line cursor repair in `disposeNode` (advance the cursor to the next surviving
dep before the free); O(1), disposal path only, no steady-state cost. The now-dead
`freeLink` `-1` defensive ternaries were removed with it. Pinned by a regression
test in `test/12-coverage.test.mjs`.

**Hot-path parity note:** this touches `disposeNode` and `freeLink`, so their
sha256 no longer matches the `1.6.0-alpha.0` baseline. The steady-state read /
propagation bodies (`pullComputed`, `markDownstream`, `executeEffect`,
`flushEffects`, `allocateLink`, `severTail`, `createNode`, `runCleanup`) are
unchanged. Re-baseline the VersionMatrix engine sha256 on the next publish.

### Changed -- branch coverage closed to 100%

Branch coverage on `Signal.js` went `96.96% -> 100%`. The gap the `1.6.0-alpha.0`
notes described -- the hook-attached side of the new op-6 / op-7 gates, which the
active suite never exercised because it never attached a hook -- is now closed by
a test that attaches a mutation hook and asserts both opcodes fire on the flush
path. Alongside it: the three reachable branches ported from the 1.4.0-rc pass
(`allocateLink` dead-target, `executeEffect` scheduler re-entrancy, `computed`
stale-handle read), the 1.5.0 box + owner surface (box stale-handle guards,
`computedBox` `equals`, top-level `getOwner` / `runWithOwner`), and the two
provably-unreachable clamps (link-ledger, `batchEpoch` wraparound) now carrying
`/* c8 ignore */` with proofs. See `COVERAGE-NOTES.md`; reconfirm under codify.

## [1.6.0-alpha.0] -- 2026-07-XX

The observability-and-lifecycle minor, shipping on the `alpha` dist-tag while it
settles. Three additions: `stats()` gains a twelfth key, **`flushPasses`**, plus two
flush-profiling mutation-hook opcodes -- the flush/recompute dimension
lite-devtools 1.2 / lite-studio 1.2 read through `watchAllocations`;
**`createScope(fn)`**, the disposable-owner counterpart to
`createRoot` that a keyed-list / scene reconciler needs for per-item teardown;
and **`getOwner` / `runWithOwner`** carried forward from 1.5.0-beta.2 as the
capture-and-restore companion to `createRoot`. The engine hot path is **no
longer byte-identical to 1.5** for the first time since 1.2.2 -- `markDownstream`
and `flushEffects` picked up hook-gated fires for the two new opcodes -- but
the gate is a single branch-predicted `null` check per fire site and the
observable cost only shows on the cheapest propagation shapes (KAIROS, DEEP
CHAIN); the wide-aggregation and dynamic-DAG wins are unchanged. Drop-in over
1.5.1-beta.1.

### Added -- `flushPasses` on `stats()` + flush-profiling opcodes

`stats()` now returns **12 keys**: the 11 from 1.4.x plus `flushPasses`, a counter
that advances once per effect-flush drain pass. Two `onGraphMutation` opcodes back
the flush dimension:

- **`6` flush pass** -- `(passCount, effectsToRun)`, at the top of each drain pass.
- **`7` effect run in pass** -- `(id, 0)`, before each effect re-run inside a pass.

Both the counter bump and the opcode dispatch sit behind the existing
`if (mutationHook !== null)` gate, so when no profiler is attached they are inert:
`flushPasses` is frozen and the flush loop is byte-identical to 1.5.0 EXCEPT for
the added `null` check itself. The residual cost is one branch-predicted `null`
check per fire site (per pass in `flushEffects`, per enqueued dirty subscriber
in `markDownstream`'s inner loop). Measurable on the very cheapest propagation
shapes where every iteration matters -- KAIROS moves from -7% -> -12% vs alien
on the 1.6.0-alpha sweep, DEEP CHAIN from -14% -> -21% -- and invisible on the
allocation-dominated shapes where the ratio of pool retracking to marker walks
favors lite by orders of magnitude (SELECTIVE DAG +49%, DYNAMIC DAG +43%, MUX
+35%, SMALL SELECTIVE +29% -- all unchanged from the 1.5.0-beta sweep). When a
profiler is actually attached the observable becomes the profiler's own cost and
the gate itself disappears from the picture. This is what lets `watchAllocations`
chart recompute/flush activity alongside the 1.4.0 allocation counters
(`totalAllocations` / `poolGrowths` / `totalDisposals`), which remain available
from 1.4.0 on every engine -- only the flush series requires 1.6.

The `03-pool` test for the `stats()` shape is bumped from "11-key 1.4.0 shape"
to "12-key 1.6 shape" with `flushPasses` in the expected key list.

### Added -- `createScope(fn)` (disposable owner scope)

`createScope` runs `fn(dispose)` in a detached scope and returns whatever `fn`
returns, having handed `fn` a single `dispose` that **cascade-disposes every effect
and computed created inside `fn`**. It is the lifecycle complement to `createRoot`:

- `createRoot(fn)` only **detaches** -- nodes created inside are unowned and the
  caller must dispose each one by hand (there is no owner to do it automatically).
  Correct for spawning one known long-lived watcher (lite-query's pattern).
- `createScope(fn)` **adopts** -- it owns whatever `fn` builds, so one disposer tears
  down a subtree of *unknown* shape. This is what a per-item scope in a keyed-list or
  scene reconciler requires, where the item's reactive graph is the consumer's
  `mapFn`, not something the reconciler can enumerate.

**Semantics.** `fn` runs once in a detached, untracked context: no ownership and no
dependency leak from `fn`'s direct body into the enclosing scope, and the scope owner
never re-runs. Reactive bindings belong in inner effect/computed bodies inside `fn`
(those track normally and are owned by the scope); direct-body reads are untracked.
Consistent with the 1.2.0 ownership rule, **plain signals created directly in `fn` are
not adopted** -- dispose those explicitly (the creator holds the handle) or let them
fall out of reference; computeds and effects are adopted and cascade.

**Implementation.** The scope owner is backed by a never-re-running effect node, so it
counts as one effect in `stats()` and its disposer is the same gen-guarded, ABA-safe,
introspection-stamped handle `effect()` returns (`describe` / `nodeId` / `forEachOwned`
resolve it to the owner). No new node kind, flag, or `stats()` key -- the pinned
`signals + computeds + effects === activeNodes` invariant is untouched. The API
(`fn => dispose`) is the stable contract; a future engine may swap in a lighter
pure-owner node transparently.

Exported as a registry method and a top-level helper bound to the default registry,
mirroring `createRoot`.

### Added -- `getOwner` / `runWithOwner` (carried forward from 1.5.0-beta.2)

The re-attach companion to `createRoot`, ported forward from 1.5.0-beta.2
unchanged. `getOwner()` returns the current owner as an **opaque, gen-stamped
handle** (or `undefined` outside any effect/computed body); `runWithOwner(handle,
fn)` runs `fn` with the captured lifecycle scope reinstated so effects/computeds
created directly in `fn` are adopted by that owner. Nulls the tracking observer
for the duration of `fn` (same pairing as `createRoot`) so accidental cross-async
edges cannot form.

Handles are gen-stamped (the same `NODE_GEN` ABA-guard machinery
`describe` / `nodeId` / `forEachOwned` / `ownerOf` have used since 1.2.1) --
safe to hold across async boundaries. If the captured owner is disposed and
its pool slot recycled by an unrelated effect via the LIFO free list, the gen
no longer matches and `runWithOwner` degrades to **rooted execution** rather
than corrupting the graph. Two hazards on the raw-pointer alternative were
empirically reproduced against a 1.5.0-beta engine patched with the naive
implementation (`harness/owner-hazard-repro.mjs`) and are pinned in
`test/28-run-with-owner.test.mjs`:

- **Recycled-slot cascade death** -- capture, dispose owner, allocate a stranger
  effect that reuses the slot, `runWithOwner(captured)` silently adopts
  continuation into the stranger, stranger's re-run cascade-disposes it.
- **Corpse adoption = engine crash** -- capture, dispose owner but not-yet-
  recycled, `runWithOwner(captured, () => effect(...))` splices a child into
  a disposed owner's `firstOwned` and the next disposal walk recurses without
  termination (`RangeError: Maximum call stack size exceeded`).

Both fail on the raw-pointer sketch; both pass on the shipped `describeNode` /
`liveNode` implementation. Test coverage: 16 tests in `test/28-run-with-owner`
(basic shape, degradation, and the three hazard pins with allocation pressure
applied so the ABA guard is genuinely exercised).

Exported as registry methods and top-level helpers, mirroring `createRoot` /
`createScope`.

### Added -- characterization harnesses (`burst-dag.mjs`, `pull-stress.mjs`)

Two standalone harnesses in `harness/` that exercise the new 1.6.0 instrumentation
surface against the engine's hot paths, both consuming public `onGraphMutation`
(opcodes 5/6/7) and both staying out of `npm test` and the published tarball.
`pull-stress.mjs` imports `../Signal.js` and exposes a CLI + module exports;
`burst-dag.mjs` takes the engine path as an argument and is CLI-only.

**`burst-dag.mjs`** (`npm run profile:burst`, also `node --expose-gc
harness/burst-dag.mjs <Signal.js>`) reproduces Andrii's actual generator: the
layer edges use his **verbatim strided picker** (`base = (node*13 + layer*17) %
prevW`, strided step), `staticFraction = 1` (all-static computeds, per-batch pull
reads, no effects) -- the real `layered burst flush warm` shape. It runs that
head-to-head against the earlier contiguous-window guess it embeds and reports
structure (passes/burst, recomputed, maxRecompute/node, poolGrowths) plus median
us/burst for each. On 1.6.0-alpha the strided real topology recomputes ~2x the
nodes (15928 vs 8120) at ~26% higher us/burst, both with `passes = 0` (pure pull,
nothing to flush) and `maxRecompute/node = 1`: no redundant work either way, so
the ~2x gap is **locality** on the correct topology. This resolves the ROADMAP S5
open question (was the contiguous guess faithful to Andrii's generator?). The
earlier contiguous version -- with its `--width` / `--layers` CLI and its
`burstDagScenario` / `multiPassProbe` exports for the zero-GC gate -- is archived
as `harness/attic/burst-dag.mjs`; nothing mounted those exports, so retiring it
is inert.

**`pull-stress.mjs`** (`npm run profile:pull`, also `node --expose-gc
harness/pull-stress.mjs [--maxDepth=3584 --step=512 ...]`) is the pull-path companion:
characterizes how the recursive pull scales with chain depth and binary-searches
the exact overflow point. Three answers per run: (1) the exact deepest chain
that pulls successfully (the roadmap's "~5,000 chained computeds" pinned to a
number for the current engine), (2) per-level cold cost across a depth sweep
(should be roughly linear; superlinear flags a per-node bookkeeping cost
growing with depth), and (3) cached-read cost (should be O(1) regardless of
depth via the 1.1.4 `markEpoch` short-circuit). Structure pass at a safe fixed
depth confirms the opcode triple (0 flush passes, 0 effect runs, recomputes ==
depth) -- the pull path is doing nothing it shouldn't. Also exports
`pullStressScenario` for steady-state allocation gates and `probeOverflow`
for the binary search alone. Both `--kind=callable` and `--kind=box` are
supported and surface a real engine difference (box pulls overflow earlier
because `box.get()` adds a prototype-method frame per level, and cached box
reads are several times more expensive than cached callable reads).

`pull-stress` imports only `../Signal.js`, and `burst-dag` takes the engine path
as an argument, so both run against any engine build: point them at 1.5.x to
compare without the new counters (`burst-dag` adapts -- only opcode 5 fires on
that engine, so `passes` reads 0 -- and `pull-stress` works identically), or at a
rejected candidate to re-verify on. The numbers they produce are reproducible,
comparable, and engine-version-aware.

### Verified

- **Full suite green** against the 1.6.0-alpha engine (getOwner + runWithOwner
  merged in from 1.5.0-beta.2): **447 tests**, 436 pass, 0 fail, 1 skip
  (only the architecturally-N/A SSR case in `17-reactivity`), 10 cancelled
  (the `25-devtools-real-boot` cases that need `@zakkster/lite-devtools`
  installed as a peer -- pre-existing, unrelated to any 1.6 change). +4
  `createScope` tests in `test/28-scope_test.mjs`; +16 `getOwner` /
  `runWithOwner` tests in `test/28-run-with-owner.test.mjs` (basic shape,
  degradation, and the three hazard pins -- recycled-slot cascade / corpse
  adoption / composed with allocation pressure); the 1.5.0 box and createRoot
  suites carry forward unchanged. `test/03-pool` "stats() shape" test
  updated from the 11-key 1.4.0 shape to the 12-key 1.6 shape (adds
  `flushPasses`). **Coverage** (c8@11, Node 22): `Signal.js` 100% statements /
  96.96% branches / 100% functions / 100% lines; `Watch.js` 100% across all
  four. The branch drop vs 1.5.0 (97.35% -> 96.96%) is the zero-cost gate on
  `flushPasses` / opcode 6 / opcode 7 -- the `if (mutationHook !== null)`
  mutation-hook-attached branch is not exercised by the active test suite,
  which never attaches a hook; the inert path is covered.
- **`createScope` behavior** (4 tests, `node --expose-gc`): returns `fn`'s value and
  runs the owner exactly once even when `fn` reads signals in its direct body
  (untracked); inner effects/computeds track and update; `dispose()` cascade-disposes
  the owned subtree (effects + computeds) while an un-adopted signal correctly
  survives; a disposed scope's inner effects stop firing; **a scope created inside a
  consumer effect survives that consumer's re-run** (the reconciler-critical detach
  property); `dispose()` is an idempotent no-op on the second call; the disposer is
  introspection-stamped to its owner effect; and `totalAllocations - totalDisposals
  === activeNodes` holds after teardown. Plus a smoke confirming signal -> computed ->
  effect is unaffected by the additive change.
- **`getOwner` / `runWithOwner` port**: sha256 over the extracted function bodies of
  `pullComputed`, `executeEffect`, `allocateLink`, `severTail`, `createNode`,
  `runCleanup`, `disposeNode`, `createRoot`, `createScope` matches the pristine
  1.6.0-alpha engine byte-for-byte -- port touched no hot path. `Publications/
  owner-hazard-repro.mjs` reports **`VERDICT: SAFE`** on the merged engine on both
  hazards (continuation runs 2 times before stranger disposal, 3 after; corpse
  case runs 2 without `RangeError`).
- **Instrumentation is zero-cost when unobserved**: `flushPasses` advances and opcodes
  6/7 fire only while a mutation-hook listener is attached; with none, the two hook
  fire sites are pure `null`-check branches (branch-predicted-free after warmup).

### Verified -- fresh 1.6.0-alpha bench sweep (dual-host: Apple M4 Pro + 2016 Intel MacBook)

Both v3 instruments were re-run in full on the 1.6.0-alpha engine on **two hosts**:
the current authoritative machine **Apple M4 Pro darwin/arm64, Node 26.3.1** (with
`#STAMP`-verified outputs committed to `bench/r.txt` -- microscope aggregate, 4
engines across the six first-party shapes -- and `bench/rb.txt` -- mirror sweep,
Andrii's canonical adapter verbatim, lite vs alien across 47 rows, isolated-per-row,
10 reps) and the older reference host **2016 Intel MacBook Pro, Node 22** (kept
sweep-over-sweep for cross-host reference; `bench/results.txt` propagation, 9
scenarios, and `bench/resultsReactive.txt` cross-framework reactivity, median-of-10,
34 tests -- the 10 raw reactive-suite runs sit under `bench/bench-runs-reactive/
run_1.txt` ... `run_10.txt` so anyone can re-median independently). The M4 Pro host
has a lower run-to-run noise floor than the Intel host, so the sub-percent parity
band tightens; conversely the Intel host makes small branch-cost swings visible
that the M4 Pro's frontend absorbs.

- **Microscope aggregate on M4 Pro (r.txt):** on the six v3 microscope shapes, lite
  wins vs alien on **MUX +35.3%** (fan-in), **SELECTIVE DAG +20.6%**, **DYNAMIC DAG
  +17.7%**, and -- new this sweep -- **BROADCAST +12.0%** (flipped from -1.2%
  parity on 1.5.0-beta; fan-out is now a fourth speed win). The three allocation-
  heavy wins hold their 1.5.0-beta M4 Pro magnitudes within noise because the
  mutation-hook gate is round-off relative to per-iteration retracking work.
  **KAIROS narrowed from -15.7% to -9.9%** -- the exact opposite of what the Intel
  host shows for the same engine, which is what you would expect if branch
  prediction on the M4's frontend is absorbing the two hook-gate `null` checks
  completely. DEEP CHAIN stays firmly in alien's column at -73.8% (the
  architectural weak spot the honest framing has always named: recursive JS-stack
  computed resolution against a flat chain). Speed wins vs alien: **4/6** (was
  3/6 on 1.5.0-beta); heap wins: **5/6** with the sixth being a shared-zero on
  BROADCAST.
- **Propagation bench on Intel (results.txt):** lite +49% / +43% / +35% / +29% on
  the four allocation-heavy scenarios (SELECTIVE DAG / DYNAMIC DAG / MUX / SMALL
  SELECTIVE) -- unchanged in character from the 1.5.0-beta Intel sweep, confirming
  the gate is round-off on allocation-dominated shapes. Parity on LARGE WEB APP
  (-3%) and WIDE DENSE (-6%), inside host noise. **Alien-signals ahead on
  BROADCAST (-10%), KAIROS (-12%, was -7% on 1.5.0-beta), and DEEP CHAIN (-21%,
  was -14% on 1.5.0-beta)** -- the KAIROS and DEEP CHAIN widening IS the observable
  gate cost on this slower host, one predicted `null` check per inner-loop
  iteration on shapes that iterate 1000-25000 times per rep. That the same
  engine reads KAIROS -12% on Intel and -9.9% on M4 Pro is not a contradiction;
  it is what a cross-host branch-cost artifact looks like when only one of the two
  frontends can hide it. Speed wins vs alien on Intel: **4/9** (was 5/9); heap
  wins: **8/9** (unchanged).
- **Microscope heap (the actual story) on M4 Pro:** on every shape where GC
  pressure exists at all, lite allocates **one to four orders of magnitude less
  transient heap than alien** -- DEEP CHAIN 0.5 KB vs 1062 KB (>2000x, on the
  shape lite loses on time), MUX 0 KB vs 781 KB, KAIROS 23 KB vs 802 KB (34.3x),
  DYNAMIC DAG 3.4 MB vs 60.0 MB (17.9x), SELECTIVE DAG 7.6 MB vs 78.2 MB (10.3x).
  Against preact-signals and solid-signals the heap gap is even wider on the
  fan-in / fan-out family; solid allocates ~17 MB on MUX and ~15 MB on SELECTIVE
  DAG where lite allocates 0 KB and 7.6 MB on the same shapes. The
  differentiated position is ALLOCATION, not raw propagation speed --
  competitive-to-winning throughput with dramatically lower GC pressure, and
  that is the headline that reproduces across hosts.
- **Mirror sweep on M4 Pro (rb.txt):** Andrii's canonical 47-shape suite re-run
  isolated-per-row lite vs alien on M4 Pro reproduces the same honest framing:
  lite runs **parity-to-behind alien on throughput** across the suite (wins
  outright on **5/47** -- `1000x5 - 25 sources (wide dense)` +12.2%,
  `manySourcesIntoOneComputedEffectWithDirect` +31.8%,
  `manySourcesIntoOneComputedEffect` +31.4%, `molBench` +1.0% (new this sweep),
  and `createComputations4to1` +9.5%; up from 4/47 on 1.5.0-beta), weak on the
  deep/layered-burst family. Every row carries a `#STAMP` and the counters
  (`nodesRecomputed` / `edgesTraversed` / `sinkReads`) match Andrii's published
  suite exactly (`mirror.mjs --self-verify`), so a lite-vs-alien delta here is
  identical work, not DCE.
- **Reactive suite on Intel (resultsReactive.txt):** fastest of five frameworks
  on all five `dyn` rows (simple +19%, dynamic +13%, large web app +11%, wide
  dense +4%, deep +16%). On the `S: updateComputations` micro-rows lite trades
  the lead with alien: **4/7 wins this sweep** (was 7/7 on 1.5.0-beta),
  consistent with the gate cost on 50-70ms rows that iterate many thousands of
  times per measurement on the Intel host.
- **Andrii Volynets js-reactivity-benchmark position holds at 4th of 15** with
  geomean **73.1ms** (raw log `bench/AndriiVolynetsReactiveBench.log`, all 15
  x 47 rows); lite is ahead of 5th-place Preact Signals (79.9) by ~9%.
  Outright-fastest-of-15 wins jumped to **6 shapes**: `broadPropagation`,
  `manyEffectsFromOneSource`, `manySourcesIntoOneComputedEffect`,
  `manySourcesIntoOneComputedEffectWithDirect`, `molBench`, and the `32x8 - 4
  sources - pull` DAG. Top-3 count: 23/47. (Outright wins swing at the top of
  a very tight leaderboard; the stable metric across every sweep is the
  geomean rank at 4th of 15.)
- **Third-party engine versions carried forward** from the 1.5.0-beta sweep
  (alien-signals 3.2.1, @preact/signals-core 1.14.2, @vue/reactivity 3.5.35,
  solid-js 1.9.13). No peer bumps this cycle -- the deltas here are the 1.6
  engine's own footprint plus host noise.

### Tooling -- harness reorganization (no published-surface change)

The loose `harness/` probes are routed through a single dispatcher
(`harness/run.mjs`) and exposed as npm scripts: `harness:field`,
`harness:dispose`, `harness:churn`, `harness:owner`, `harness:creation`, and
`harness:all` (field + dispose + churn in sequence). `harness:field` is the
portable fieldkit verify + cold-child A/B bench; the rest map one-to-one to the
existing probe files. Paths resolve from the dispatcher, so the working
directory no longer matters.

- **`churnprobe.mjs` corrected.** It read link churn from `stats().totalLink*`
  fields that never existed on this engine (`stats()` tracks only NODE lifecycle
  plus a live `activeLinks` gauge), so every row printed `NaN`. It now counts
  gross link churn off `onGraphMutation` -- opcode `3` (link-add) and `4`
  (link-sever) -- which is strictly better: a net `activeLinks` delta would read
  zero on `dep-flip` because each sever is matched by an add, hiding exactly the
  retracking the probe exists to catch. Stable shapes now read `churn/recompute
  = 0`; `dep-flip` reads `2.0`. Opcodes `3`/`4`/`5` are unchanged from 1.5; the
  probe does not use the new `6`/`7` flush opcodes.
- **`burst-dag.mjs` reconciled.** The contiguous-window guess was first promoted
  from `futureVersions/` into `harness/` (wiring up the `profile:burst` script
  that already pointed there), then superseded by the verbatim-Andrii strided
  reconciliation now carrying that name (see Added above); the contiguous guess
  and its `burstDagScenario` / `multiPassProbe` exports are preserved in
  `harness/attic/`. `pull-stress.mjs` -- the pull-path companion documented
  alongside it -- landed in `harness/`.
- **The owner-recycling reproducer** is documented at its real home,
  `harness/owner-hazard-repro.mjs`; the earlier `Publications/...` citations
  in README / CHANGELOG / llms.txt pointed at a path the file was never in, and
  are corrected. The createComputations matrix parent/child link
  (`creation-isolated.mjs` -> `andrii-isolated-child.mjs`) is repaired.
- **Six settled one-off probes** -- the five from the 1.2.0 -> 1.2.1
  construction-shape regression hunt, plus the superseded
  `repro-set-after-dispose.mjs` (its invariant now pinned by `test/07-dispose`
  and `test/26-free-list-invariant`) -- are parked in `harness/attic/` with a
  README explaining each.

`Signal.js` and the published `files[]` whitelist are untouched by any of the
above; this is a repo-tooling change only.

## [1.5.0] -- 2026-06-XX

The API-surface minor: two new **non-callable, allocation-light** reactive
primitives, `signalBox` and `computedBox`, land alongside the existing callable
`signal` / `computed`; and **`createRoot`** lands as the ownership escape hatch
the owner tree was designed for. They wrap the same `ReactiveNode` machinery and
interoperate freely in one graph -- a box can depend on a callable and vice
versa -- so this is an additive surface, not a second engine. Drop-in over 1.4.0:
the callable API, hot paths, and `stats()` shape are unchanged; the boxes are new
exports and the `24-signalbox` suite (staged `{skip:true}` since 1.3.0) now runs
and passes. The 1.3.0 eager pool default carries forward (`prealloc: "eager"`).

### Added -- `signalBox(initial, opts?)` and `computedBox(fn, opts?)`

Non-callable variants that return a plain object on a shared prototype instead of
a callable function:

- **`signalBox`** returns `{ get, set, peek, update, subscribe }`.
- **`computedBox`** returns `{ get, peek, subscribe }` (no `set` / `update` --
  it is derived).

Both are exported as registry methods *and* as top-level helpers bound to the
default registry, mirroring `signal` / `computed`. The `opts.equals` custom
equality option is supported on both, same default (`Object.is`).

**Why a second shape.** The callable API (`count()`, `count.set(x)`) is the most
ergonomic surface, but constructing a callable means building a function object
and hanging methods/state off it. For code that creates *many* short-lived
reactive cells, or that wants a plain serializable-looking handle, the box trades
call ergonomics for cheaper construction:

- **Box creation is faster than callable** -- on this host, 10,000 `signalBox`
  in ~10ms vs ~18ms for 10,000 callable `signal` (about 1.7x cheaper),
  because `Object.create(proto)` is cheaper than allocating a closure with
  attached properties.
- **The hot read/write path stays zero-GC** -- 200,000 box writes through a
  256-wide graph allocate nothing and grow the pool zero times. The box is a
  thin handle over the same pooled node; only the *handle object* differs from
  the callable, and it is created once.

### Engineering note -- monomorphic boxes via `Object.create`, not `setPrototypeOf`

Each box is built with `Object.create(SIGNAL_BOX_PROTO)` (resp.
`COMPUTED_BOX_PROTO`) and then has its two own properties (`NODE_PTR`,
`NODE_GEN`) added in a fixed order. This is deliberate: using `setPrototypeOf`
on an already-constructed object transitions it to dictionary mode and forces the
method-call inline caches at `box.get()` / `box.set()` to megamorphic. Building on
the shared prototype from the start keeps every box monomorphic, so the method
calls stay inline-cached and fast. This is the same class of V8-closure-tax
avoidance the engine applies throughout; a rejected earlier prototype that used
`setPrototypeOf` regressed box method calls and was not shipped.

### Interop -- one graph, two handle shapes

A box and a callable handle wrap the same kind of `ReactiveNode`. Verified both
directions: a callable `computed` that reads `box.get()` tracks the box as a
dependency and updates correctly; a `computedBox` that reads a callable
`signal()` does the same. Glitch-freedom, batching, ownership/auto-disposal, and
the introspection surface all apply uniformly -- a box node is indistinguishable
from a callable node to the graph, the owner tree, and devtools.

### Added -- `test/24-signalbox_test.mjs` activated (12 tests)

The suite that was committed-but-skipped since 1.3.0 now runs against the real
implementation. The 9 originally-staged tests cover box get/set/peek/update,
computedBox derive + memoize, peek-does-not-track, subscribe fires-and-untracks,
box<->callable interop both directions, batch coalescing across boxes, dispose
stopping updates with ABA-safety, and the `equals` short-circuit. The 3
box-coverage additions for 1.5.0 cover `computedBox.peek` (track-free read on
the derived shape), the set-then-revert net no-op in a batch (pre-batch revert
applies to box writes too), and the top-level `signalBox` / `computedBox`
helpers binding to the default registry with full callable interop. All 12 pass.

### Added -- `createRoot(fn)` (ownership escape hatch)

`createRoot` runs `fn` in a **detached ownership scope**: effects and computeds
created inside `fn` are not adopted by the enclosing owner, so they survive the
enclosing effect's re-runs and disposal. The caller owns their lifecycle (there
is no parent to auto-dispose them -- `fn` typically returns a disposer or the
created handle). Exported as a registry method and a top-level helper, mirroring
`signal` / `computed` / `untrack`.

**Why it exists.** The owner tree's defining behavior is that owned children
dispose with their parent -- correct and intended (pinned by the cleanup-ordering
tests since 1.2.0). But that makes one pattern a footgun: lazily spawning a
*long-lived* node from *inside* a consumer effect. The spawned node is adopted by
the consumer, so the consumer's next re-run cascade-disposes it. This is not an
engine defect -- it is the ownership model working as designed -- but until now
there was no sanctioned way to opt a child *out* of ownership. `createRoot` is
that opt-out. The engine head comment has named `runWithOwner` / `createRoot` as
the intended future API for exactly this since the owner/observer split shipped
in 1.2.0 (`currentOwner` and `currentObserver` were made distinct pointers
precisely so ownership could be detached without affecting tracking); 1.5.0
delivers the first of the two.

**What it detaches.** For the duration of `fn`, both `currentOwner` and
`currentObserver` (and the tracking flag) are nulled, so neither ownership nor a
reactive dependency leaks from `fn`'s direct body into the enclosing scope. Inner
effect / computed bodies still establish their own owner+observer scopes as
usual -- only the boundary at `fn` is detached. Mirrors Solid's `createRoot` on
the lifecycle axis.

**Who needs it.** Any consumer that lazily creates a watcher/subscription inside
a reactive scope and expects it to outlive that scope -- `lite-query`'s
query-watcher being the first in the ecosystem. Those consumers wrap the spawn in
`createRoot(() => effect(...))` and dispose it themselves; the watcher then
survives consumer re-runs.

### Verified

- **Full suite green** against the 1.5.0 engine: 439 tests, 438 pass, 0 fail,
  1 skip (only the architecturally-N/A SSR case in `17-reactivity`; the 9
  `24-signalbox` tests are now active and the suite carries +3 box-coverage
  additions for a 12-test file, +7 `createRoot` tests in
  `test/27-create-root_test.mjs`). **Coverage** (c8@11,
  Node 22): `Signal.js` 100% statements / 97.35% branches / 100% functions / 100%
  lines; `Watch.js` 100% across all four.
- **Box hot path is zero-GC**: 200,000 writes through a 256-wide box graph,
  0 heap growth, 0 pool growths after warm-up -- identical steady-state profile
  to the callable API.
- **Box creation is allocation-light**: measurably cheaper construction than the
  callable equivalent (~1.7x on this host), the design goal of the second shape.
- **Interop confirmed**: callable-reads-box and box-reads-callable both track and
  update correctly in a single graph; `stats()` counts box nodes in `signals` /
  `computeds` exactly as callable nodes.
- **`stats()` shape unchanged** from 1.4.0 (11 keys); boxes allocate nodes
  through the same `createNode` path, so the 1.4.0 lifecycle counters
  (`totalAllocations` etc.) account for box nodes automatically.
- **`createRoot` detaches ownership without leaking**: a watcher effect spawned
  inside a consumer effect via `createRoot` survives the consumer's re-run (fires
  on later dependency changes where, unwrapped, it would have been cascade-
  disposed), and an explicit disposer on the detached effect still stops it
  cleanly -- detachment costs no auto-cleanup but introduces no leak. Verified
  against the exact lazy-watcher pattern `lite-query` uses.

### Added -- VersionMatrix identical-code guard (harness/VersionMatrix/)

The regression gate (`harness/VersionMatrix/`, wired into `prepublishOnly` since
1.4.0) gains an **identical-code guard**: each capture records the sha256 of the
engine source (`baselines/<label>/engine.sha256`). If the candidate's hash matches
a baseline's, that axis is running the *same bytes* -- any measured delta is host
noise, not a regression -- so the gate marks it `SKIP` rather than let variance
flag a phantom. This is what saves you when you re-version without a code change:
a `1.5.0-beta.0` that is byte-identical to a published `1.5.0-alpha.1` cannot
regress against it, and the gate says so structurally instead of failing on a
noisy median. Genuine code changes produce a different hash and are gated
normally. Everything else about the harness -- cold-process-per-version,
LCG-deterministic input, two baselines (floor `1.3.0` + rolling), calibrated
tolerances (`frame.avg` 5% rolling / 10% floor, `frame.p99` and `phase.write.p99`
18% / 30%), four workloads mapping to public bench claims -- carries forward
from 1.4.0. Details in `harness/VersionMatrix/README.md`.

### Verified -- fresh 1.5.0-beta bench sweep

Both benches were re-run in full on the 1.5.0-beta engine and their outputs
committed to `bench/results.txt` (isolated propagation, 9 scenarios) and
`bench/resultsReactive.txt` (cross-framework reactivity, median-of-10, 34
tests). The 10 raw reactive-suite runs sit under `bench/bench-runs-reactive/
run_1.txt` ... `run_10.txt` so anyone can re-median independently.

- **Propagation bench (results.txt):** lite +48% / +45% / +33% / +29% on the four
  allocation-heavy scenarios (SELECTIVE DAG / DYNAMIC DAG / MUX / SMALL
  SELECTIVE); **LARGE WEB APP flipped into a small lite win (+2%, from -3% on
  1.4.0)** after the alien-signals 3.1.2 -> 3.2.1 bump between sweeps; parity on
  WIDE DENSE (-6%) and KAIROS (-7%); alien ahead on BROADCAST (-12%) and DEEP
  CHAIN (-14%, narrowed from -29% on 1.4.0 for the same alien-version reason
  -- lite's DEEP CHAIN barely moved, 395 -> 398ms). Speed wins vs alien: **5/9**
  (was 4/9); heap wins: 8/9.
- **Reactive suite (resultsReactive.txt):** fastest of five frameworks on all
  five `dyn` rows (simple +19%, dynamic +16%, large web app +9%, wide dense +6%,
  deep +12%), and **lite now leads alien on ALL 7 `S: updateComputations` rows**
  this sweep (+3% / +6% / +3% / +12% / +3% / +2% / +8%; was 4/7 on 1.4.0).
- **Andrii Volynets js-reactivity-benchmark position holds at 4th of 15** with
  geomean **79.3ms** (raw log `bench/AndriiVolynetsReactiveBench.log`); lite is
  ahead of 5th-place Preact Signals (99.8) by ~21% -- the gap widened this
  sweep after Preact's own regression on the newer 1.14.2. Top-3 count moved
  from 21/47 (1.3.0 log) -> 23/47 (1.4.0 log) -> **25/47 (1.5.0-beta log)**;
  outright-fastest-of-15 wins fluctuate at the top of a very tight leaderboard
  where alien-signals / reflex / lite trade sub-percent margins per shape (5
  outright wins on 1.4.0, **2 outright wins on 1.5.0-beta** -- `createComputations4to1`
  and `1000x5 - 25 sources (wide dense)`). The stable metric across every
  published sweep is the geomean rank at #4 of 15.
- **Third-party version bumps** used in this sweep vs 1.4.0: alien-signals
  3.1.2 -> 3.2.1, @preact/signals-core 1.14.1 -> 1.14.2, @vue/reactivity
  3.5.13 -> 3.5.35, solid-js 1.9.12 -> 1.9.13. Any within-lib delta between
  the two sweeps reflects those bumps + host noise, not lite-signal changes:
  1.4.0 -> 1.5.0 hot-path bytes are byte-identical (1.5.0 adds only the
  non-callable box handle shape, which affects construction cost and handle
  ergonomics but not the pooled-node read/write path).

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

### Added -- VersionMatrix regression gate (harness/VersionMatrix/)

A **same-host, cold-process regression gate** for the engine ships alongside the
observability counters, wired into `prepublishOnly` -- a candidate that regresses
beyond calibrated tolerances aborts `npm publish` before it starts. Each
version-x-workload is profiled in its own `node` invocation (V8 never carries
inline caches or JIT state across versions), fed an identical LCG write sequence
(delta = engine change, not input), and reduced to a per-metric median-of-N
(default 5). **Two baselines** gate every publish: a **floor** (never moves;
"we shall not regress below this line") and a **rolling** baseline (previous
published version); a candidate must clear BOTH. Tolerances calibrated against
measured self-noise (`npm run calibrate`): `frame.avg` is the stable anchor at
5% vs rolling / 10% vs floor (self-noise <=~3%); `frame.p99` and
`phase.write.p99` sit at 18% / 30% (self-noise up to ~14%, so a p99 fail should
be re-run to confirm). Four workloads map to public bench claims:
`reactive-graph-mix` (KAIROS / mol pattern), `deep-chain` (the DEEP CHAIN weak
spot), `broadcast-fanout` (the BROADCAST fan-out), and `dynamic-dep-churn` (the
DYNAMIC / SELECTIVE DAG wins). Committed median baselines under
`harness/VersionMatrix/baselines/` are the public evidence surface (each
carrying `env` metadata: CPU, node, date); the gate itself always re-captures
floor / rolling / candidate in the same job so it never diffs across hosts.
Manifest at `manifest.json` pins the floor (`1.3.0`), the rolling reference, and
the workload list. Details in `harness/VersionMatrix/README.md`. (The 1.5.0-beta
identical-code guard extending this gate lands in the 1.5.0 entry above.)

### Verified

- **Full suite green** against the 1.4.0 engine: 429 tests, 419 pass, 0 fail,
  10 skip (9 signalBox-staged-for-1.5.0 plus 1 architecturally-N/A SSR skip). The eager-default and the counter additions
  changed no existing test outcome.
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
  10 skip (9 `24-signalbox` tests `{skip:true}` on 1.3.x -- those primitives
  land in 1.5.0 -- plus 1 architecturally-N/A SSR skip). The eager-default flip
  changed no test outcome.
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