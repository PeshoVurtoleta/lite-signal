# Changelog

All notable changes to `@zakkster/lite-signal` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [1.7.0-alpha.6] -- 2026-08-20

Backports the **1.4.5 `createRegistry` input validation** (all four findings) onto
the 1.7.0-alpha.5 engine. Supersedes 1.7.0-alpha.5. Only `createRegistry`'s *cold*
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
- **`flushStrategy` stays a first-class option.** It is a recognized key (its own native value-guard is unchanged); only misspelled *keys* are rejected.
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

## [1.7.0-alpha.4] -- 2026-08-18

**Torture-suite and test parity with the shipped 1.4.4 canonical suite.** This is
a **verification-only** cut: `Signal.js` and `Signal.d.ts` are **UNCHANGED**
(shasum-identical to alpha.3). Nothing in the engine, the public surface, or the
runtime behaviour moved. Every number below was verified against the real 1.7.0
engine and pins its ACTUAL behaviour -- no assertion was softened, no budget
widened.

### Added -- five torture scenarios ported to full 1.4.4 parity (17 -> 22)

`bench/torture/` now carries the complete **22-scenario superset (19 semantic +
3 soak)**. The five ported scenarios all target primitives 1.7.0 already ships,
so they **run natively -- no SKIP**:

- `lifecycle-torture` -- `createRoot` detachment (detached children survive and
  stay reactive, deps isolated) + `destroy` registry reset (stales every handle,
  returns `stats().activeNodes` to 0). Both halves native.
- `owner-torture` -- `getOwner` / `runWithOwner` capture-restore via `createScope`:
  live-owner adoption cascade-disposes, a STALE handle degrades to ROOTED, deps
  stay isolated, plus a 300-seed capture/dispose/recycle/restore fuzz. Native.
- `error-torture` -- throwing effect bodies under flush: a single throw re-thrown
  UNWRAPPED, 2+ aggregated into an `AggregateError` carrying EXACTLY those errors,
  a survivor between two throwers still runs, and the error buffer drains flat
  (`activeNodes`/`activeLinks` unchanged) over 4096 throw/clean cycles.
- `deep-chain-torture` -- `pullComputed` recursion fails CLOSED with a `RangeError`
  beyond the stack budget (ramp 2000/2000/100000, depth never pinned) while the
  iterative push path stays open; the registry that threw stays usable and the
  re-throw is deterministic.
- `zerogc-torture` -- the zero-GC claim made falsifiable via `@zakkster/lite-gc-profiler`:
  `measureAllocs`/`checkAllocs` at `maxBytesPerCall: 0` + `measureOps`/`checkNoGc`
  at `maxMajor: 0` / `maxPauseMs: 2` + engine `stats()` deltas across steady and
  create/dispose churn, with the `churn-box` signalBox path active on 1.7.0 and a
  `ZEROGC_BREAK=1` self-test that must fail the gate.

`run.mjs` registers all five in the 1.4.4 order (owner after scope; error +
deep-chain after capacity; zerogc after dispose; lifecycle after introspect).
`node bench/torture/run.mjs --list` -> 22.

### Added -- `test/30-throwing-equals.test.mjs`

Pins the behaviour of a user `equals` predicate that THROWS at all five engine
sites: the three callable sites (signal `set` pre-check, batch-revert check,
computed re-eval) and signalBox `boxSet`'s two (pre-check, revert). Includes the
CONTRAST anti-tautology test (a clean set-X-then-back suppresses the re-run,
proving the throw is the cause) plus the a-box / b-box cases.

### Changed -- capacity section 9, tighter introspection, soak value-oracles

- `capacity-torture` gains section 9: the 16x link-grow ceiling (`maxLinks * 16`),
  pinning `err.kind === "links"`, `err.capacity === maxLinks * 16`, growth
  terminating AT the ceiling, and a fail-closed re-throw. Sections 1-8 untouched.
- `introspect-torture`'s `forEachOwned` assertion tightened from `>= 2` to
  EXACTLY 2 owned children (deterministic count).
- The three soaks (`graph-fuzzer`, `scheduler-bench`, `torture-soak`) gained a
  once-allocated `Int32Array` shadow value-oracle -- a rotating fixed window per
  tick with zero per-tick allocation and a full sweep at teardown; a mismatch
  exits 1 with seed + index. The reachable magic-constant JIT sink was replaced
  with a module-scoped int32 sink read under an `if (ops > 0 && sink === 0)`
  teardown guard.

### Dev dependency

`@zakkster/lite-gc-profiler` (`^1.15.0`) added as a **dev-only** dependency for
`zerogc-torture`. `dependencies` stays empty; `package.json` `files[]` still
excludes `bench/`.

Verified green: torture **22/22** (20 execute + 2 later-version skips --
`cleanup-return-torture` 1.8.0, `dispose-torture` 1.9.0); unit **490 tests, 489
pass, 0 fail, 1 skip** (SSR N/A).

## [1.7.0-alpha.3] -- 2026-07-27

Rolls up the post-`1.7.0-alpha.0` changes into the `alpha.3` tag. The
flush-strategy feature (`flushStrategy` + `r.flush()`) and the forward-ported
`getOwner` / `runWithOwner` ship in alpha.0 and are unchanged here; what this cut
adds is the dangling-cursor crash fix (below), 100% branch coverage on
`Signal.js`, the completed torture surface for the flush feature, and a
test-directory cleanup.

### Added -- `flush-torture` now executes on the 1.7.0 engine

`bench/torture/`'s `flush-torture` scenario -- present but feature-skipped on the
1.5.x / 1.6.x lines -- now **runs**, since `flushStrategy` exists. It pins the
three modes by a cross-strategy differential (the same graph and op sequence
under `eager` / `sab` / `manual` must reach identical settled values once
drained -- they differ only in *when* draining happens), plus per-strategy
scheduling (eager flushes on `.set()`, sab only at batch exit, manual only on
`flush()`), re-entrant / empty `flush()`, and the `.subscribe()` contract under
each strategy. On the 1.7.0 engine the runner therefore executes **12 semantic**
scenarios and cleanly SKIPS the two later-version ones (`cleanup-return-torture`
1.8.0, `dispose-torture` 1.9.0); the suite total is unchanged at **17 (14
semantic + 3 soak)**.

### Changed -- bench protocol v3 (carried forward)

The `bench/` harness is bench protocol v3: three instruments (microscope / mirror /
version-economics), each with a fixed config and a machine-generated `#STAMP`
(engine + harness sha256, live registry config, host, node). The pre-v3
five-framework reactivity suite was removed after 1.5.1. See `bench/README.md`.

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
dep before the free); O(1), disposal path only, no steady-state cost. Pinned by a
regression test in `test/12-coverage.test.mjs`.

This also corrects the record on `freeLink`: the `link.source !== null ? ... : -1`
fallbacks were documented as "unreachable defensive code," but they were in fact
reachable -- and *only* reachable -- through this crash path. With the cursor
repaired they are genuinely dead, so they were removed (replaced by the passed
`source.id` / `target.id`, which are always live). Branch coverage on `Signal.js`
is now 100%: the two remaining unreachable arms (link-ledger clamp, `batchEpoch`
2^32 wraparound) carry `/* c8 ignore */` with proofs. See `COVERAGE-NOTES.md`.

**Hot-path parity note:** this touches `disposeNode` and `freeLink`; re-baseline the
VersionMatrix engine sha256 on the next publish. Steady-state read/propagation
bodies are unchanged.

### Changed -- test file numbering

`test/28-scope.test.mjs` is renamed to `test/29-scope.test.mjs` to resolve the
duplicate `28-` prefix it shared with `28-run-with-owner.test.mjs`
(`createScope` is the 1.6.0 primitive, sequenced after `runWithOwner`). The
alpha.3 tree had carried *both* files -- the original `28-scope` and a
byte-identical `29-scope` copy -- so the scope suite was running twice; the stray
`28-scope.test.mjs` is deleted, leaving one `29-scope.test.mjs`.

### Verified -- full suite green on the 1.7.0 engine (Node 22, `--expose-gc`)

- **Torture:** 17/17 -- `torture:semantic` 14/14 (12 executed incl. `flush-torture`,
  2 clean skips: `cleanup-return` 1.8.0, `dispose` 1.9.0), `torture:soak` 3/3
  (zero errors, every pool back to its leaf-only floor).
- **Unit:** 485 tests, 465 pass, 0 fail, 1 skip (the architectural SSR N/A in
  `17-reactivity`). The 1 skip aside, the only non-passes are the 19 in
  `test/25-devtools-real-boot`, the real-rig that requires the sibling
  `@zakkster/lite-devtools`; with that sibling resolvable the suite is 484 pass +
  1 skip. (Engine-only, excluding `test/25`: 466 tests, 465 pass, 1 skip.)

## [1.7.0-alpha.0] -- 2026-07-14

The **flush-strategy minor**, promoted from `preview` to the `alpha` dist-tag.
Two additions on top of 1.6.0-preview:

- **`flushStrategy` registry option + `r.flush()`** -- the primary 1.7 lever, a
  per-registry choice of when effects auto-deliver (`"eager"` default | `"sab"` |
  `"manual"`) plus an explicit `flush()` method on every registry. Resolved once at
  registry init by binding to a pre-built closure reference; the "eager" inlined
  body is byte-identical to 1.6's `if (batchDepth === 0) flushEffects()` so
  existing users see zero behavioral or performance regression.
- **`getOwner` / `runWithOwner` port** -- carried forward from 1.5.0-beta.2 into
  this line. The 1.7.0-preview `Signal.js` was branched from a pre-1.5.0-beta.2
  base and the two async-gap primitives (`getOwner()` capture, `runWithOwner()`
  restore) were missing. Ported unchanged: the same safe `describeNode` +
  `liveNode` gen-guard machinery that landed in 1.5.0-beta.2 and carried into 1.6
  is now present here too, so any consumer using the ownership escape hatch (e.g.
  `lite-query`'s query-watcher across an `await`) gets the same guarantees on the
  1.7 line.

The two hot-path changes 1.6 -> 1.7 are localised to `signal` / `computed` /
`effect` / `signalBox` / `computedBox` (their `.set` sites) and `batch` (its
exit site) -- specifically the resolved-once `FLUSH_ON_IDLE_WRITE` /
`FLUSH_ON_BATCH_EXIT` booleans. **Every other hot-path body is byte-identical to 1.6.0**
(sha256-verified over `pullComputed`, `markDownstream`, `executeEffect`,
`flushEffects`, `allocateLink`, `severTail`, `createNode`, `runCleanup`,
`disposeNode`, `createRoot`, `createScope`). The two ownership primitives added
by this port only add new user-API functions -- they do not touch any of the
above; the sha256 check confirms it.

Drop-in over 1.6.0-preview. The default is unchanged.

### Added -- `flushStrategy` registry option

Selects when effects auto-deliver, chosen once at `createRegistry` time:

- **`"eager"`** (default, byte-identical to 1.6.0): `.set` outside batch
  auto-flushes; batch exit auto-flushes.
- **`"sab"`** (**stable-after-batch**, matches Reflex semantics): `.set` outside
  batch enqueues effects via the existing `FLAG_SCHEDULED` dedup but does NOT
  auto-flush; batch exit DOES auto-flush. This is the apples-to-apples mode for
  the `js-reactivity-benchmark` `update*` group -- on shapes with observers but
  no effects, the eager `flushEffects` empty-path `try/finally` was the dominant
  per-write overhead.
- **`"manual"`**: neither `.set` nor batch exit auto-flush; only explicit
  `r.flush()` drains the queue. For hard-real-time loops that need frame-aligned
  settle points (Hueforge, Gradient Studio).

### Added -- `r.flush()` explicit flush API

Explicit flush method on every registry. Re-entrant safe (the existing
`isFlushing` guard applies unchanged); empty queue exits immediately. The three
strategies use it as follows: `"eager"` never needs it (auto-flushes cover
everything); `"sab"` needs it if you `.set` outside batch and want the effects
to run without waiting for the next batch exit; `"manual"` needs it to run any
effects at all.

### Added -- `getOwner` / `runWithOwner` (carried forward from 1.5.0-beta.2)

The capture-and-restore companion to `createRoot`. `getOwner()` returns the
current lifecycle owner as an opaque, gen-stamped handle (`undefined` outside
any effect/computed body); `runWithOwner(handle, fn)` runs `fn` with that owner
reinstated so effects/computeds created directly in `fn` are adopted by it (and
cascade-dispose when the owner re-runs). Nulls the tracking observer for `fn`'s
direct body -- same pairing as `createRoot`, so accidental cross-async
dependency edges cannot form.

**Handles are gen-stamped.** They use the `describeNode` + `liveNode` ABA-guard
machinery (`NODE_GEN` stamp checked against the pool slot's current gen), same as
`describe` / `nodeId` / `forEachOwned` / `ownerOf` since 1.2.1. Safe to hold
across async boundaries: if the captured owner is disposed and the pool slot is
recycled by an unrelated effect via the LIFO free list, the handle's gen no
longer matches and `runWithOwner` degrades to **rooted execution** rather than
adopting the continuation into the recycled slot's new resident. Two hazards on
the raw-pointer alternative pinned in `test/28-run-with-owner.test.mjs` and
empirically reproduced against a patched engine via
`harness/owner-hazard-repro.mjs`:

- **Recycled-slot cascade death** -- capture, dispose owner, allocate a stranger
  effect that reuses the slot; a raw-pointer `runWithOwner(captured)` silently
  adopts the continuation into the stranger; the stranger's next re-run
  cascade-disposes it.
- **Corpse adoption = engine crash** -- capture, dispose owner but not-yet-
  recycled; a raw-pointer `runWithOwner(captured, () => effect(...))` splices a
  child into a disposed owner's `firstOwned`; the next disposal walk recurses
  without termination (`RangeError: Maximum call stack size exceeded`). Not a
  leak; a crash.

Both fail on the raw-pointer sketch; both pass on the shipped `describeNode` /
`liveNode` implementation. Verified against 1.7.0-preview's engine directly --
`harness/owner-hazard-repro.mjs ./Signal.js` reports `VERDICT: SAFE` on the
recycled-slot case (continuation runs 2 times before stranger disposal, 3
times after) and completes the corpse case without stack overflow.

Exported as registry methods AND top-level helpers bound to `defaultRegistry`,
mirroring `createRoot` and `createScope`. Top-level exports added right before
the top-level `createScope` binding for stable ordering.

### Hot-path safety -- and the design that was tried, measured, and rejected

**The shipped mechanism is a pair of closure-captured `const` booleans**, not a
function reference:

```js
const FLUSH_ON_IDLE_WRITE = (flushStrategy === "eager");
const FLUSH_ON_BATCH_EXIT = (flushStrategy !== "manual");
```

They are immutable for the registry's lifetime, which gives V8's JIT the
constant-folding hook it needs: in `"eager"` mode the emitted code for `.set` is
byte-identical to 1.6.0's `if (batchDepth === 0) flushEffects()`; in
`"sab"`/`"manual"` the `FLUSH_ON_IDLE_WRITE && ...` short-circuits on the const-false
and V8 elides the branch entirely after one tier-up. `signal()` additionally
selects between **two pre-built `.set` closures at construction time**, so the eager
body carries no extra load or branch at all. **Zero behavioural or performance
regression** for any existing user.

**The first 1.7 implementation did something else and it was slower.** It captured
a function reference (`flushAfterWrite` / `flushAfterBatch`, bound to
`eagerFlushHook | noopFlush`) and called it from `.set` / `boxSet`. V8 did **not**
inline that reference on this workload: eager-mode `.set` measured **16-65% slower
than 1.6.0** on Andrii's `updateComputations*` tests, because every write paid a
function-call indirection. A second attempt -- a single `.set` body with
`if (FLUSH_ON_IDLE_WRITE && batchDepth === 0)` -- measured **16-30% slower**, because
a closure-captured `const` boolean lives in a context slot, not as a literal in
bytecode, when the body is shared. Splitting the closure at *build* time is what
recovered parity. Both dead ends are recorded here so nobody re-derives them.

This is NOT ledger S0b #6 (per-call closure-var load of a primitive V8 can't fold).
The literals are declared `const` and never reassigned, and the hot body is selected
before the first write.

> **Known stale comment:** the file header of `Signal.js` (around line 22) still
> describes the *abandoned* function-reference design ("one of two pre-built flush
> hooks (eagerFlushHook | noopFlush)"). No such identifier exists in the code; the
> in-place comment at the `FLUSH_ON_IDLE_WRITE` declaration is the accurate one.
> The header needs a one-line correction. It is called out rather than silently
> edited because `Signal.js` is sha256-pinned across the 1.6 -> 1.7 boundary.

The `getOwner` / `runWithOwner` port adds new user-API functions but touches no
hot path. sha256 over the extracted function bodies of `pullComputed`,
`markDownstream`, `executeEffect`, `flushEffects`, `allocateLink`, `severTail`,
`createNode`, `runCleanup`, `disposeNode`, `createRoot`, `createScope` matches
pristine 1.7.0-preview byte-for-byte; the two new functions are inserted between
`createRoot` and `createScope` without disturbing either.

### Test coverage

- **Full suite green:** **484 tests across 29 files**, 483 pass, **0 fail**, 1 skip
  (only the architecturally-N/A SSR case in `17-reactivity`), 0 cancelled. Plain
  `npm test` runs 476 of them -- 8 are gated on `--expose-gc` (3 in `04-zero-gc`,
  4 in `09-conformance`, 1 in `11-adopted-reactive`) and need `npm run test:gc`. The 10
  previously-cancelled `25-devtools-real-boot` cases now run and pass (19/19) with
  `@zakkster/lite-devtools` resolvable as a dev peer. Default-mode behaviour is
  unchanged byte-for-byte from 1.6.0.
- **Coverage: `Signal.js` at 100% statements / 100% functions / 100% lines /
  99.24% branches; `Watch.js` at 100% on every metric** (`npm run test:coverage`).
  Up from 97.84 / 93.40 / 97.84 / 96.22 on `preview.2`.

  The four residual branch arms are **unreachable by construction**, and are listed
  rather than papered over with an ignore pragma (which would have broken the
  sha256 hot-path proof above for no behavioural gain):

  1-2. `freeLink`'s `link.source !== null ? ... : -1` and `link.target !== null ? ... : -1`
       fallbacks. All three call sites pass a link taken from a live dep/sub list;
       both endpoints are always non-null.
  3.   The `doubled > maxLinkLimit ? maxLinkLimit : doubled` clamp in the link-growth
       ledger. `maxLinkLimit` is `maxLinks * 16` and the ledger only doubles from
       `maxLinks`, so the doubling sequence lands *exactly* on the ceiling and cannot
       overshoot. The ceiling itself is a real wall and is tested.
  4.   The `if (batchEpoch === 0) batchEpoch = 1;` 32-bit-wraparound guard in `batch()`.
       Reaching it needs 2^32 batches in one registry.

- **+16 tests in `test/28-run-with-owner.test.mjs`** (carried forward from
  1.5.0-beta.2 / 1.6.0-alpha): 7 basic-shape tests, 3 degradation tests
  (`null` / `undefined` / signal-handle all fall through to rooted execution),
  and 3 **hazard pins** with allocation pressure applied so the ABA guard is
  actually exercised (recycled-slot cascade, corpse adoption, composed).
- **`test/03-pool` "stats() shape" test** bumped from the 11-key 1.4.0 shape to
  the 12-key 1.6+ shape (adds `flushPasses`).
- **+16 tests in `test/12-coverage.test.mjs`** -- the behavioural coverage that
  `preview.2` explicitly deferred is now **delivered**, and it is what closed the
  gap above:
  - `flushStrategy` validation (a bogus token throws at `createRegistry`; all three
    valid tokens construct; an omitted config and an omitted key both default to
    `"eager"`).
  - All three modes end-to-end: `eager` delivers per idle write and once per batch;
    `sab` defers an idle write, **dedups 1000 un-batched writes into one run**, and
    drains the whole backlog at batch exit; `manual` gates *both* the idle write and
    the batch exit, leaving `r.flush()` as the only settle point.
  - **Lazy-pull correctness in every mode** -- a `computed` / `computedBox` read after
    a deferred write returns the NEW value with no flush. The write is always eager;
    only delivery defers. This is the invariant that makes `"sab"`/`"manual"` safe.
  - The **entire non-eager `.set` / `boxSet` body, branch by branch**: gen guard
    (a write through a stale handle is a silent no-op), `equals` short-circuit
    (default and custom predicates), pre-batch revert (set-then-revert inside a batch
    is a net no-op and restores `preBatchVersion`), and the real-net-change path.
  - The **top-level `flush` / `getOwner` / `runWithOwner` delegators** bound to the
    default registry (all three were 0% covered).
  - `flush()` on an empty queue is a no-op; `flush()` is the escape hatch for an
    idle-write backlog in `sab`.
- **+5 engine-edge tests in `test/12-coverage.test.mjs`** for branches no behavioural
  suite reached. Two are worth recording because finding them corrected a wrong
  assumption in the source comments:
  - **The `allocateLink` eligibility gate (`target.flags === 0`) is NOT reachable by
    plain self-dispose.** `disposeNode` already nulls `currentObserver` /
    `activeObserverCurrentDep` / `isTrackingDeps` when the disposing node *is* the
    current observer, so a read later in a self-disposing effect's body never reaches
    `allocateLink` at all. The gate's live path is the *other* case its own comment
    names: an **outer observer torn down while suspended** inside a nested pull -- a
    computed whose body disposes the effect that is currently pulling it. There,
    `currentObserver` is the *computed*, the effect's tracking state survives, and
    `pullComputed` restores a **dead node** as the observer. The next read in the
    effect's body must not splice a phantom edge into the corpse. Now pinned.
  - **`executeEffect`'s `CycleError: Infinite effect loop detected.`** is likewise not
    reachable through `markDownstream` (which skips any node carrying `FLAG_COMPUTING`,
    so an effect writing to its own dependency is deliberately **absorbed**). It IS
    reachable through a user `scheduler` that retains the cached thunk and re-invokes
    it from inside the effect body. Now pinned as a `CycleError`, not a stack overflow.

### Bench impact -- `sab` vs `eager` on the update group (sandbox VM medians, 7 samples)

`update*` group with observers-but-no-effects, apples-to-apples in `sab` mode:

| Shape (n=writes) | eager  | sab    | speedup |
|------------------|-------:|-------:|--------:|
| 1to1   (400k)    | 14.15  | 12.04  | 1.18x   |
| 1to2   (400k)    | 11.68  | 10.25  | 1.14x   |
| 1to4   (400k)    | 11.36  | 11.01  | 1.03x   |
| 1to8   (400k)    | 11.47  | 10.09  | 1.14x   |
| 1to1000 (4k)     |  1.59  |  1.55  | 1.03x   |
| 1000to1 (1k)     |  0.07  |  0.03  | 2.31x   |

Real wins, but smaller than the gap to Reflex on the same shapes. The residual
gap is structural (per-write `gen` check, batch-revert epoch tracking, global
version bumping) -- design decisions accepted by S0b and not in scope here.
Modern V8's `try/finally` elision varies; expect higher absolute speedups on
production V8 than on this sandbox.

### Fixed -- `Signal.d.ts` was missing the entire 1.7.0 surface

`preview.2` shipped `flushStrategy`, `flush()`, `getOwner()` and `runWithOwner()` in
the engine and **declared none of them in the types**. Any TypeScript consumer would
have got a compile error on `createRegistry({ flushStrategy: "manual" })`, on
`r.flush()`, and on both ownership primitives. Added:

- `RegistryConfig.flushStrategy?: "eager" | "sab" | "manual"`
- `Registry.flush(): void`
- `Registry.getOwner(): OwnerHandle | undefined`
- `Registry.runWithOwner<T>(owner: OwnerHandle | null | undefined, fn: () => T): T`
- top-level `flush` / `getOwner` / `runWithOwner` bound to the default registry
- `export type OwnerHandle = NodeDescriptor` -- the gen-stamped handle, structurally
  the same descriptor `describe()` returns, so it stays re-walkable through
  `forEachOwned` / `ownerOf` / `nodeId`

Verified structurally: all **32** runtime exports and all **26** registry methods now
have a declaration.

### Fixed -- documentation had `runWithOwner` marked "not yet shipped"

Both `README.md` and `llms.txt` still carried the 1.5.0-era sentence *"the re-attach
companion `runWithOwner` ... is not yet shipped"* while the engine exported it. Corrected
in both, and `flushStrategy` / `flush()` -- previously mentioned nowhere outside the
harness notes -- now have a full API-reference section in the README and a Core-concepts
entry in `llms.txt`.

### Regenerated -- every published benchmark number

The v3 microscope and mirror have been re-run on the 1.7.0-preview engine on **Apple
M4 Pro darwin/arm64, Node 26.3.1** and their outputs committed to `bench/r.txt`
(microscope aggregate, 4 engines across the six first-party shapes) and `bench/rb.txt`
(mirror sweep, Andrii's canonical adapter verbatim, lite vs alien across 47 rows,
isolated-per-row, 10 reps). Both benchmark sections of the README and the llms.txt
Benchmark snapshot are rebuilt from these outputs rather than carried forward. Two
consequences worth stating out loud:

- **The headline ranking improved.** On Andrii's 1.7.0 run (`bench/AndriiVolynetsReactiveBench1.7.0.log`,
  15 frameworks x 47 tests, checked in), lite-signal is **4th of 15 by geomean at
  71.5 ms** -- and the gap to 5th-place Preact Signals widened from ~5% to **20%**.
  Outright fastest of all 15 on four tests. The `1000x5 - 25 sources` wide-dense DAG,
  which was **5.7x behind** the leaders on the 1.1.2 engine Andrii first measured, is
  now the **fastest result in the entire field**.
- **Two local results got worse, and are now stated plainly instead of buried.**
  **DEEP CHAIN is a -74.3% loss to alien-signals** (172 ms vs 99 ms), not the -18% the
  old (invalid) table reported -- it is the engine's largest open performance gap and
  it is structural. And **DYNAMIC DAG, while +17.0% over alien, loses to preact-signals**
  (3718 ms vs 2760 ms on this sweep). The old `resultsReactive.txt` claims "fastest of
  all five on every `dyn` row" and "ahead on all seven `updateComputations` rows" do
  not survive the re-measurement. Both retracted.
- **The microscope wins moved slightly since 1.6.0-alpha's M4 Pro sweep.** MUX +32.6%
  (was +35.3%), SELECTIVE DAG +20.4% (was +20.6%), DYNAMIC DAG +17.0% (was +17.7%) --
  same magnitudes, host-noise drift. **BROADCAST narrowed from +12.0% to +6.2%** but
  stayed on the win side of parity, keeping the 4/6 speed-win count. **KAIROS widened
  slightly from -9.9% to -11.7%**. DEEP CHAIN unchanged at -74.3%. Heap column is
  intact: one to four orders of magnitude below alien on every shape where GC pressure
  exists at all.

### Migration

- **Every existing user**: zero work needed. The default is unchanged; every
  registry created without a `flushStrategy` argument runs the same code as on
  1.6.0.
- **Bench adapters wanting apples-to-apples with Reflex-style flush semantics**:
  pass `flushStrategy: "sab"` to `createRegistry` (see `liteSignal.ts` example
  in the changeset).
- **Frame-aligned real-time loops**: pass `flushStrategy: "manual"` and call
  `r.flush()` at the settle point.
- **Users of `createRoot` who want the capture-and-restore idiom across
  async boundaries**: `getOwner()` + `runWithOwner()` are now available on
  the 1.7 line (they were absent from pre-1.5.0-beta.2 branches and needed the
  forward-port to reach 1.7 through the flushStrategy branch).

### Verified

- **Full engine test suite** green: 484 total across 29 files (476 without
  `--expose-gc`), 483 pass, 0 fail, 1 skip, 0 cancelled. Coverage: `Signal.js` 100/99.24/100/100
  (stmts/branch/funcs/lines), `Watch.js` 100 on every metric.
- **`harness/owner-hazard-repro.mjs ./Signal.js`** reports
  `VERDICT: SAFE` on the recycled-slot case AND completes the corpse case
  without stack overflow -- the ABA guard degrades both hazards to rooted
  execution as designed.
- **sha256 over 11 hot-path function bodies** (`pullComputed`, `markDownstream`,
  `executeEffect`, `flushEffects`, `allocateLink`, `severTail`, `createNode`,
  `runCleanup`, `disposeNode`, `createRoot`, `createScope`) byte-identical
  between pristine 1.7.0-preview (as uploaded) and the merged-with-getOwner
  engine. The port literally only adds new code between `createRoot` and
  `createScope` plus updates the return object and adds two top-level exports;
  zero touch on any pre-existing function.

### Tooling -- harness wiring, and a benchmark that was measuring nothing

**`bench/benchmark.mjs` was producing invalid numbers and is fixed.** Every
lite-signal adapter in it constructed its registry with `flushStrategy: "sab"`
while driving un-batched `.set` calls. In SAB mode a `.set` outside `batch()`
*enqueues* effects but does not flush them, and the harness never called
`batch()` or `r.flush()` anywhere -- so the effect ran exactly **once** (its
creation-time run) and never again inside the timed loop. The loop was timing a
bare mark-dirty against dead-code-eliminated downstream work.

The symptom was visible in the reports and went unread: nine of eleven rows
printed `sink=[ ]` and `BENCH_SINK_SUM (anti-DCE): 0.00`. MUX reported
**22,032K ops/s** against a real **~219K** -- a ~100x fiction. Measured on the
same host: as-written `sab`-no-flush = 1 effect run, sink 0; `sab` + explicit
`r.flush()` = 20,000 runs, 191K ops/s; `eager` = 20,000 runs, 219K ops/s (which
matches the long-published ~223K MUX figure).

- The nine adapters now run **eager**, which is byte-identical to 1.6.0 and the
  only mode comparable to the reference libraries -- alien-signals, preact,
  vue-reactivity and solid all deliver eagerly. SAB is the right mode for
  Andrii's `update*` group (observers but no effects), which is what
  `harness/perf-probe.mjs` and `harness/toe-to-toe/` are for, not this harness.
- A **VALIDITY GUARD** was added: any scenario finishing with a dead sink now
  prints an `INVALID RUN` block naming the offending rows and sets a non-zero
  exit code. The old code computed the `sink=[x]` / `[ ]` column and then ignored
  it. Silence was the bug.
- **Every number in `results.txt` and `bench/bench-runs/` predating this fix is
  invalid and must be regenerated.** `bench/benchmarkReactive.mjs` is
  **unaffected**: it also sets `"sab"`, but it drives every write through
  `withBatch(...)`, and batch exit *does* auto-flush in SAB mode -- verified
  clean against 1.7.0 (cellx vectors matched, all internal assertions pass).

**Harness wiring restored and extended.** `profile:burst` / `profile:pull`
pointed at `burst-dag.mjs` / `pull-stress.mjs` in the repo root, where neither
file has lived since 1.6; both now resolve into `harness/`. The dispatcher
(`harness/run.mjs`) gained `smoke`, `perf`, `burst`, `pull` and `toe`, and the
`harness:*` scripts plus `gate` / `prepublishOnly` (VersionMatrix) and
`test:harness` (ProfilerTools) are wired in `package.json` again. `harness:smoke`
now leads `harness:all` and `npm run verify`, because it is the only probe that
**asserts** -- a `flushStrategy` regression fails in a second instead of after
twenty minutes of timed probes.

**Scratch directories folded in.** `tmp/`, `tmp2/` and `tmp3/` are gone:

- `tmp3/toe-to-toe.mjs` + `runner.mjs` -> `harness/toe-to-toe/`. This is the
  corrected cross-version sweep and it supersedes the sbench driver: it replaces
  sequential ordering with round-robin (the old loop ran the newest engine last,
  on the hottest chassis, which is why three sha256-**identical** propagation
  bodies appeared to trend across 1.9 -> 1.11), adds a `1.6.0-sentinel` drift
  column, and fixes the **silent corrupter** -- `if (mode === "sab" && engineDir
  === "v17")` meant only v17 ever received `flushStrategy: "sab"`, while every
  later engine was *labelled* sab and batch-wrapped but built **eager**. Its
  `engines/` dir is gitignored: several snapshots are unreleased, so the sweep
  script is public and the engine source is not.
- `tmp/sbench-driver.mjs` + `sbench-runner.mjs` -> `harness/attic/` (superseded).
  Their output stands, though: in that sweep v17 was the only `sab` combo, so the
  corrupter was accidentally correct there. Preserved as
  `harness/toe-to-toe/sbench-results-1.7.0.txt`.
- `tmp2/TESTING-SAB-METHODOLOGY.md` -> `harness/`; `tmp2/sink-check.mjs` ->
  `harness/attic/` (redundant -- `harness/smoke.mjs` covers eager/sab/manual and
  asserts). `tmp/Signal.js` (a stale 1.7.0-WIP snapshot) and the duplicated
  `CHANGELOG-1.7.0.md` / `ROADMAP` copies are dropped.
- Root loose files cleaned: `owner-hazard-repro.mjs` (a formatting-only duplicate
  of the `harness/` copy) removed; `retracking.difftest.mjs` moved into
  `harness/` and **fixed** -- it imported a hard-coded `./1.1.6.js` that does not
  exist in this tree, so it could not run at all; it now takes
  `<reference.js> [candidate.js]` on the command line.

`Signal.js` and the published `files[]` whitelist are untouched by any of the
above; installed tarballs are byte-identical.

## [1.6.0] -- 2026-06-26 (preview)

The observability-and-lifecycle minor, shipping on the `preview` dist-tag while it
settles. Two additions: `stats()` gains a twelfth key, **`flushPasses`**, plus two
flush-profiling mutation-hook opcodes -- the flush/recompute dimension
lite-devtools 1.2 / lite-studio 1.2 read through `watchAllocations`; and
**`createScope(fn)`** (landed in `preview.0`), the disposable-owner counterpart to
`createRoot` that a keyed-list / scene reconciler needs for per-item teardown.
Drop-in over 1.5.0: the callable API and hot paths are unchanged, and the new
instrumentation is frozen and zero-cost unless a mutation-hook listener is attached.

### Added -- `flushPasses` on `stats()` + flush-profiling opcodes

`stats()` now returns **12 keys**: the 11 from 1.4.x plus `flushPasses`, a counter
that advances once per effect-flush drain pass. Two `onGraphMutation` opcodes back
the flush dimension:

- **`6` flush pass** -- `(passCount, effectsToRun)`, at the top of each drain pass.
- **`7` effect run in pass** -- `(id, 0)`, before each effect re-run inside a pass.

Both the counter bump and the opcode dispatch sit behind the existing
`if (mutationHook !== null)` gate, so when no profiler is attached they are inert:
`flushPasses` is frozen and the flush loop is byte-identical to 1.5.0. This is what
lets `watchAllocations` chart recompute/flush activity alongside the 1.4.0
allocation counters (`totalAllocations` / `poolGrowths` / `totalDisposals`), which
remain available from 1.4.0 on every engine -- only the flush series requires 1.6.

### Added -- `createScope(fn)` (disposable owner scope) [preview.0]

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

### Added -- characterization harnesses (`burst-dag.mjs`, `pull-stress.mjs`)

Two root-level standalone harnesses that exercise the new 1.6.0 instrumentation
surface against the engine's two main hot paths. Both are engine-agnostic
(`./Signal.js` + public `onGraphMutation` only), both expose a CLI + module
exports, both stay out of `npm test` and the published tarball.

**`burst-dag.mjs`** (`npm run profile:burst`, also `node --expose-gc burst-dag.mjs
[--width=512 --layers=32 ...]`) reconstructs the published
`js-reactivity-benchmark` burst shape (sources -> width x layers, fanIn 8, burst
16) and characterizes lite-signal's own flush behavior. The standalone path uses
the new `stats().flushPasses` counter as a cross-check against the opcode-6 pass
count -- by construction they must match when the hook is attached for exactly
one burst, which the harness asserts inline. Also exports `burstDagScenario`
(for plugging into a steady-state allocation gate) and `multiPassProbe` (a
controlled two-effect write-back that forces a `passes > 1` case so the opcode
dispatch can be smoke-tested on an engine where multi-pass actually occurs).

**`pull-stress.mjs`** (`npm run profile:pull`, also `node --expose-gc
pull-stress.mjs [--maxDepth=3584 --step=512 ...]`) is the pull-path companion:
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

Both files import only `./Signal.js`, so the same harness runs against any
engine build: point `Signal.js` at 1.5.x to compare without the counters
(`burst-dag` adapts -- only opcode 5 fires on that engine -- and `pull-stress`
works identically), or at a rejected candidate to re-verify on. The numbers
they produce are reproducible, comparable, and engine-version-aware.

### Verified

- **Full suite green** against the 1.6.0 engine: 443 tests, 442 pass, 0 fail,
  1 skip (only the architecturally-N/A SSR case in `17-reactivity`). +4
  `createScope` tests in `test/29-scope.test.mjs`; the 1.5.0 box and createRoot
  suites carry forward unchanged. **Coverage** (c8@11, Node 22): `Signal.js`
  100% statements / 96.96% branches / 100% functions / 100% lines; `Watch.js`
  100% across all four. The branch drop vs 1.5.0 (97.35% -> 96.96%) is the
  zero-cost gate on `flushPasses` / opcode 6 / opcode 7 -- the
  `if (mutationHook !== null)` mutation-hook-attached branch is not exercised
  by the active test suite, which never attaches a hook; the inert path is
  covered.
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
- **Instrumentation is zero-cost when unobserved**: `flushPasses` advances and opcodes
  6/7 fire only while a mutation-hook listener is attached; with none, the flush path
  is unchanged from 1.5.0.



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

### Added -- `test/24-signalbox.test.mjs` activated (9 tests)

The suite that was committed-but-skipped since 1.3.0 now runs against the real
implementation: box get/set/peek/update, computedBox derive + memoize,
peek-does-not-track, subscribe fires-and-untracks, box<->callable interop both
directions, batch coalescing across boxes, dispose stopping updates with
ABA-safety, and the `equals` short-circuit. All 9 pass.

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


- **Full suite green** against the 1.5.0 engine: 439 tests, 438 pass, 0 fail,
  1 skip (only the architecturally-N/A SSR case in `17-reactivity`; the 9
  `24-signalbox` tests are now active, +6 `createRoot` tests in
  `test/27-create-root.test.mjs`, +3 box-coverage tests). **Coverage** (c8@11,
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



## [1.2.2] -- 2026-06-XX

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

### Added -- `test/10-free-list-invariant.test.mjs`

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

### Added -- `test/11-devtools-contract.test.mjs`

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
- Added `test/15-identity.test.mjs`: 5 tests -- ids unique + stable, `nodeId`/`describe`
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
- Added `test/13-introspection.test.mjs`: 10 tests across 3 describe blocks --
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
- Added `test/10-is-tracking.test.mjs`: 11 tests across 5 describe blocks --
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