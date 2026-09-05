# Changelog

All notable changes to `@zakkster/lite-signal` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [1.9.0-preview.6] -- 2026-08-20

Backports the **1.4.5 `createRegistry` input validation** (all four findings) onto
the 1.9.0-preview.5 engine. Supersedes 1.9.0-preview.5. Only `createRegistry`'s *cold*
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

## [1.9.0-preview.5] -- 2026-08-18

Packaging-only cut. **The engine is UNCHANGED** -- `Signal.js` is behaviourally
byte-identical to `preview.4`; the sole `Signal.js` edit is the header banner
version string (see below). This release makes the published package honour its
own `package.json`: since 1.5.0 the manifest has advertised `"types":
"./Signal.d.ts"` and listed `Signal.d.ts` in `files[]`, but the 1.9.0 line
shipped without the file (`preview.4` and earlier packed a `types` pointer to a
non-existent declaration, so `tsc` consumers got no types). No API, torture, or
test change from `preview.4`.

### Added -- the missing `Signal.d.ts` (the 1.9.0 type surface)

- **`Signal.d.ts`** now ships, modelled on the 1.8.0 declaration (1.9.0's export
  surface is byte-identical to 1.8.0's) plus the 1.9.0 explicit-resource-management
  delta: `[Symbol.dispose](): void` is typed on exactly the handles the engine
  stamps -- both box prototypes (`SignalBox` :1495, `ComputedBox` :1496), every
  `Dispose` function (the shared effect disposer at :1614, reached by `effect()`,
  `.subscribe()`, and the `createScope` disposer at :1853), and the `Registry`
  (-> `destroy`, :2087). Callable value handles (`Signal` / `Computed`) are left
  UNSTAMPED, matching the engine. So `using r = createRegistry()`,
  `using box = signalBox(0)`, and `using stop = effect(fn)` all typecheck.
- The `[Symbol.dispose]` slot is expressed through a `lib`-conditional helper
  (`ExplicitDisposeSlot`): it resolves to the member only when the ambient
  TypeScript `lib` knows `Symbol.dispose` (`esnext.disposable` -- required to use
  `using` at all), and to `{}` otherwise, so the declaration NEVER forces a `lib`
  upgrade on type-only consumers. Verified: compiles under
  `--lib ES2022,ESNext.Disposable` with `using` on all four shapes; compiles clean
  under `--lib ES2020` for a type-only consumer (zero errors); manual
  `[Symbol.dispose]()` is typed.

### Changed -- header banner reconciled to the manifest

- **`Signal.js` header banner** now reads `v1.9.0-preview.5`, matching
  `package.json` and this changelog. `preview.2` through `preview.4` shipped a
  stale `preview.2` banner (a cosmetic drift in a comment; no code depended on
  it). No other line of `Signal.js` changed -- torture stays 22/22 and the unit
  suite is unaffected.

## [1.9.0-preview.4] -- 2026-08-18

Version-only re-tag over `preview.3`. `Signal.js` is byte-identical to
`preview.3` past the header banner; no engine, torture, test, API, or packaging
change (the `Signal.d.ts` gap and the stale `preview.2` banner were both still
present -- both are fixed in `preview.5`). Recorded here for continuity.

## [1.9.0-preview.3] -- 2026-08-18

Verification-only parity cut. **The engine is UNCHANGED** -- `Signal.js` (2209
lines) is byte-for-byte identical to `preview.2`; this cut only brings the
`bench/torture` suite and the unit tests to FULL PARITY with the shipped 1.4.4
canonical suite, then VERIFIES-then-PINS 1.9.0's actual behaviour (no assertion
softened, no budget widened).

### Added -- the last three torture scenarios + soak value-oracles + a throwing-equals pin

- **`error-torture`** -- throwing effect bodies under flush: a single throw is
  re-thrown UNWRAPPED; two or more aggregate into one `AggregateError` carrying
  EXACTLY those errors in order; the effect scheduled between two throwers still
  runs; and the pre-allocated error buffer drains to a clean baseline over 4096
  throw/clean cycles (`activeNodes` / `activeLinks` flat). Pinned against 1.9.0
  `Signal.js` :928 (buffer append), :936-937 (finally clear), :941-951 (single
  re-throw / AggregateError).
- **`deep-chain-torture`** -- `pullComputed` (1.9.0 :1092, recursing at :1113) is
  call-stack recursive, so a computed chain ramped START 2000 / STEP 2000 /
  CEILING 100000 fails CLOSED with a `RangeError` at some depth; the registry
  stays usable, the re-read is deterministic, and the heap-iterative effect
  cascade over an equally deep chain completes without throwing.
- **`zerogc-torture`** -- the zero-GC claim as a re-runnable gate via
  `@zakkster/lite-gc-profiler` (added as a dev-only dependency): `measureAllocs` /
  `checkAllocs` at `maxBytesPerCall: 0`, `measureOps` / `checkNoGc` at
  `maxMajor: 0` / `maxPauseMs: 2`, and `stats()` poolGrowths/totalAllocations
  deltas, over deep/wide/batch steady writes plus create/dispose churn on both the
  callable form and `signalBox` (churn-box activates natively and reports a visible
  "ok" verdict). `ZEROGC_BREAK=1` self-tests that the gate rejects a planted
  allocation (exits non-zero).
- **`capacity-torture` section 9** -- the 16x link grow ceiling: `grow` mode still
  fails closed at `maxLinks * 16` (confirmed 1.9.0 :312 / :471) with a `links`
  `CapacityError`, growth terminating AT the ceiling, and a fail-closed re-throw
  rather than a partial sum.
- **Soak value-oracles** -- `graph-fuzzer`, `scheduler-bench`, `torture-soak` now
  assert VALUE-CORRECTNESS, not just resources: a single `Int32Array` shadow,
  allocated ONCE before the loop, shadows every writable signal; a rotating fixed
  window is checked per tick (no per-tick allocation) and a full sweep runs at
  teardown; a mismatch exits 1 with the seed and index. The module-scoped int32
  JIT sink replaces the former magic-constant "impossible" guard.
- **`test/30-throwing-equals.test.mjs`** -- a user `equals` that THROWS, pinned at
  all five 1.9.0 sites: the three callable sites (signal set pre-check :1272, batch
  revert :1279, computed re-eval :1143) with a CONTRAST anti-tautology test, and
  the two `signalBox` `boxSet` sites (pre-check :1403, revert :1410).

### Changed -- introspect-torture forEachOwned pinned to an exact count

`introspect-torture` section 7 asserted `owned >= 2`; the owned count under one
scope owner (a computed + an effect) is DETERMINISTICALLY 2, so it is now pinned
`owned === 2`. No behavioural change -- a tightened assertion.

### Verified -- the whole superset runs natively on the 1.9.0 engine

`dispose`, `cleanup-return`, `owner`, `scope`, and `flush` all execute NATIVELY
here with zero feature-skips: 1.9.0 is the first engine to run the complete
torture superset.

- **Torture:** 22/22 -- `torture:semantic` 19/19 (all executed, zero skips),
  `torture:soak` 3/3 (zero errors, value-oracle clean, every pool back to its
  leaf-only floor).
- **Unit (`npm test`):** 512 tests, 511 pass, 0 fail, 1 skip.
- **Unit (`npm run test:gc`):** 520 tests, 519 pass, 0 fail, 1 skip.

## [1.9.0-preview.2] -- 2026-07-27

Rolls up the post-`1.9.0-preview` changes into the `preview.2` tag. The 1.9.0
feature (`using` / `Symbol.dispose` on lifecycle objects) ships in the preview and
is unchanged here; this cut adds two new torture scenarios from a consolidated
coverage audit, the crash fix inherited from the 1.8.0 base, 100% coverage, and
test-suite hygiene.

### Added -- torture suite reaches the zero-skip milestone (19 scenarios)

Two effects converge on the 1.9.0 engine. First, **`dispose-torture` now
executes**: 1.9.0 stamps `Symbol.dispose` at five sites (the registry -> destroy,
an effect's stop handle, a `createScope` disposer, a `createRoot` disposer, and
both box prototypes), so `using`-declared lifecycle objects dispose at block exit.
The scenario feature-detects via the box-prototype stamp and drives each site
through the TC39 `using` path, asserting idempotent disposal. Because it is a set
of stamped methods with **no new export**, it is exactly the profile the value /
introspection oracles cannot see. Second, the coverage audit added **two new
semantic scenarios** for exports no scenario exercised directly:

- **`owner-torture`** (1.6.0+) -- `getOwner` / `runWithOwner` capture-restore: the
  gen-stamped owner handle, adoption of effects/computeds created inside
  `runWithOwner`, and cascade-dispose when the captured owner is torn down.
- **`lifecycle-torture`** (createRoot 1.5.0+, destroy 1.4.0+) -- `createRoot`
  detachment (an owned subtree that survives its enclosing scope) and the direct
  `destroy` reset contract; `createRoot` had never been called by any scenario,
  and `destroy` was only reached indirectly through a registry `Symbol.dispose`.

The suite is now **19 scenarios (16 semantic + 3 soak)**. On the 1.9.0 engine
**every semantic scenario executes -- zero feature-skips** -- the first engine
version to run the complete superset, since `dispose` was the last remaining
feature gate (box 1.5.0, scope/owner/introspect 1.6.0, flush 1.7.0,
cleanup-return 1.8.0, dispose 1.9.0 are all satisfied).

### Verified -- full suite green on the 1.9.0 engine (Node 22, `--expose-gc`)

- **Torture:** 19/19 -- `torture:semantic` 16/16 (all executed, zero skips),
  `torture:soak` 3/3 (zero errors, every pool back to its leaf-only floor).
- **Unit (plain run):** 499 tests, 479 pass, 0 fail, 1 skip (the architectural
  SSR N/A in `17-reactivity`). The only non-passes are the 19 in
  `test/25-devtools-real-boot`, the real-rig that requires the sibling
  `@zakkster/lite-devtools`; with that sibling resolvable the suite is 498 pass +
  1 skip. Engine-only, excluding `test/25`: 480 tests, 479 pass, 1 skip. (The c8
  coverage run below reports a different count -- perf-smoke budgets skip under
  instrumentation.)

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
from the plain public API, inherited from the 1.8.0 base. Fixed with a one-line
cursor repair in `disposeNode`; the two dead `freeLink` `-1` ternaries were removed
with it. Pinned by a regression test in `test/12-coverage.test.mjs`.

### Changed -- coverage closed to 100% and test-suite hygiene

`Signal.js` reaches **100% statements / branches / functions / lines** (491 tests,
490 pass, 1 skip). Beyond the crash fix and its ported box/owner/opcode closure
suite, this pass added: a test for the new **`using` / `Symbol.dispose`** methods on
both box prototypes (`box[Symbol.dispose]()` disposes and is idempotent); and the
cleanup-return array-append arm (carried in via `33-cleanup-return`). Three provably
-unreachable arms carry `/* c8 ignore */` with proofs: the link-ledger clamp, the
`batchEpoch` 2^32 wraparound, and the `Symbol.dispose` pre-Node-20 polyfill fallback.

Test-suite hygiene: `33-computed-selfdirty-prev-owner.test.mjs` renamed to `34-`
(the `33-` slot belongs to `33-cleanup-return`, which carries forward from 1.8.0
because this line inherits effect cleanup-return) -- the rename had left a
byte-identical `33-` copy behind, so the scope suite's `28-`/`29-` pattern
repeated here; the stray `33-computed-selfdirty-prev-owner.test.mjs` is deleted,
leaving one `34-`. The duplicate `28-scope.test.mjs` was likewise dropped in
favour of `29-scope.test.mjs` (both were byte-identical).

**Hot-path parity note:** the fix touches `disposeNode` and `freeLink`; re-baseline
the VersionMatrix engine sha256 on the next publish.

## [1.9.0-preview] -- 2026-07-XX (rebuilt line, candidate)

**Feature of the cut: `using` / `Symbol.dispose` on lifecycle objects.**
The one-or-two-features-per-version discipline of the rebuilt line
(bisectability -> a single cause per bench delta) governs everything
NEW; **`getOwner` / `runWithOwner` continue as the cascade forward-port
from 1.5.0-beta.3** where they landed to unblock the profiler tooling,
carried through 1.5.0 / 1.5.1 / 1.6 / 1.7 / 1.8 unchanged. They are on
this cut and land on every future cut on the same terms until an
engine-shape change forces a re-verification. Base is 1.8.0 -- the last
gate-passed, no-bench-regression checkpoint.

The rebuilt line is designed against the old-1.9.x / old-1.10 engines
that were rejected as versions (see the ROADMAP-1_9-REBUILT ledger);
their proven-safe functionality is being scalped forward across
1.9.0-preview -> 1.9.2 rather than shipped in a bundle. The discipline
is the point.

**Where features land on the rebuilt line:**

- **1.9.0-preview (this cut)** -- `using` / `Symbol.dispose` on
  lifecycle objects.
- **Carried forward from 1.5.0-beta.3 through every 1.x line** --
  `getOwner()` / `runWithOwner(handle, fn)`, safe gen-guarded design.
  Ships everywhere until an engine-shape change forces re-verification.
- **1.9.1-preview** (next) -- `computed(prev => ..., {initial})`,
  Solid-createMemo-shaped scans/reductions.
- **1.10.0-preview** -- named nodes + `whyDirty()` (the tracing
  foundation).
- **1.10.1-preview** -- cold-counter pack.
- **1.11.0-preview** -- `onSettled`, rebuilt as a creation-time
  capability.
- **1.12.0-preview** -- the trace twin (build-time twin closures for
  per-flush / per-run instrumentation).
- **1.13.0-preview** (candidate) -- `flushStrategy: "microtask"`.

### Added -- `Symbol.dispose` on lifecycle objects

Explicit resource management (`using` syntax, TC39 Stage 3), existence-
guarded so it degrades cleanly on older runtimes. Manual
`[Symbol.dispose]()` works on **Node 20+**; the `using` syntax lights up
on **Node 24+**. Stamped at five sites; every callable **value** handle
(the return of `signal()` / `computed()`) is deliberately unstamped.

```javascript
// Lifecycle objects that auto-dispose at block exit:
using r = createRegistry();                // -> destroy() at block exit
using stop = effect(() => { ... });        // -> stop() at block exit
using scope = createScope(dispose => ...); // -> dispose() at block exit

// Boxes stamp via prototype (zero per-instance cost):
using s = registry.signalBox(0);            // -> dispose(s) at block exit

// Callable handles are deliberately UNSTAMPED:
const val = signal(0);                      // no [Symbol.dispose] -- values
                                            //   don't auto-dispose at block
                                            //   exit; that would be a footgun
```

**Stamp sites (five total):**

- **`SYMBOL_DISPOSE` module constant** -- resolved once with
  `typeof Symbol.dispose === "symbol" ? Symbol.dispose : null`, then every
  stamp site is a single `!== null` existence guard. Old runtimes pay
  nothing but the guard on the cold creation path.
- **Registry** -- `r[Symbol.dispose] = destroy`. `using r =
  createRegistry()` frees the pool at block exit.
- **Effect disposer** -- the returned disposer function is its own
  `[Symbol.dispose]`: `disposeFn[SYMBOL_DISPOSE] = disposeFn`. Idempotent
  and gen-guarded exactly like a manual call.
- **`createScope` disposer** -- same idempotent self-stamp as the effect
  disposer.
- **`signalBox` / `computedBox` prototypes** -- one shared method per
  registry on the two box prototypes: `SIGNAL_BOX_PROTO[SYMBOL_DISPOSE] =
  function () { dispose(this); }`. **Zero per-instance cost** -- the
  method lives on the prototype, never on the instance. Verified:
  `Object.prototype.hasOwnProperty.call(box, Symbol.dispose) === false`.
- **Callable handles NOT stamped** -- `signal()` and `computed()` return
  value-typed closures. Auto-disposing them at block exit would let a
  `using v = signal(0)` in a hot loop delete the graph on every
  iteration. One extra own-prop stamp per handle is also real creation-
  path cost. The design is deliberate; the discriminator test would
  catch a regression that stamped them.

### Added -- `getOwner` / `runWithOwner` (cascade forward-port from 1.5.0-beta.3)

Not new to 1.9.0 -- they have landed on every published cut since
1.5.0-beta.3 unblocked the profiler tooling with them. Re-stated here
because the rebuilt-line ledger explicitly flagged them as a "salvage
1.10 -> 1.9.2" candidate, and I need to be crystal about which pattern
governs on this cut: the **cascade forward-port pattern** (they ship
until an engine-shape change forces re-verification), NOT the "one
feature per version, deferred to 1.9.2" pattern. If a future 1.9.x cut
introduces an engine-shape change that could invalidate the gen-stamped
handle contract, the ROADMAP-1_9-REBUILT 1.9.2 line reserves the space
to re-verify the port -- but on this cut nothing changed and the
long-standing safe implementation carries.

The port is the same safe design shipped on 1.6 / 1.7 / 1.8:
`getOwner()` returns a `describeNode` handle stamped with the pool
slot's generation counter (NODE_GEN); `runWithOwner(handle, fn)`
resolves via `liveNode()`, and if the gen has moved (slot recycled) or
the handle refers to a non-tracker, degrades to **rooted execution**.
Two hazards on the raw-pointer alternative empirically reproduced by
`Publications/owner-hazard-repro.mjs`:

- **Recycled-slot cascade death** -- capture, dispose owner, allocate
  a stranger effect that reuses the slot; a raw-pointer
  `runWithOwner(captured)` silently adopts the continuation into the
  stranger; the stranger's next re-run cascade-disposes it.
- **Corpse adoption = engine crash** -- capture, dispose owner but
  not-yet-recycled; a raw-pointer `runWithOwner(captured, () =>
  effect(...))` splices a child into a disposed owner's `firstOwned`;
  the next disposal walk recurses without termination
  (`RangeError: Maximum call stack size exceeded`). Not a leak; a
  crash.

Both fail on the raw-pointer sketch; both pass on the shipped
`describeNode` / `liveNode` implementation. Verified against
1.9.0-preview's engine directly: `Publications/owner-hazard-repro.mjs
./Signal.js` reports `VERDICT: SAFE` on the recycled-slot case
(continuation runs 2 times before stranger disposal, 3 after) and
completes the corpse case without stack overflow.

Exported as registry methods AND top-level helpers bound to
`defaultRegistry`, inserted between `createRoot`'s and `createScope`'s
registrations for stable ordering. **Sha256 confirms the port added
new code only** -- no existing function's body was disturbed by the
insertion (evidence below).

### Hot-path safety -- claims proven, not asserted

The rebuilt-line gate proves cold-path claims by **sha256 over
extracted function bodies**, not by assertion. Verified against
pristine 1.8.0 (columns: pristine 1.8.0 body vs the 1.9.0-preview
engine as shipped, with the owner port cascade-forwarded):

| function        | 1.8.0             | 1.9.0-preview     | status                         |
| --------------- | ----------------- | ----------------- | ------------------------------ |
| `pullComputed`  | 317bd86984710625  | 317bd86984710625  | byte-identical                 |
| `markDownstream`| ad7a007ec23260fc  | ad7a007ec23260fc  | byte-identical                 |
| `executeEffect` | 4487beb9d15f80c6  | 4487beb9d15f80c6  | byte-identical                 |
| `flushEffects`  | a25b36ba097fdf1a  | a25b36ba097fdf1a  | byte-identical                 |
| `allocateLink`  | e8762fa2d0223715  | e8762fa2d0223715  | byte-identical                 |
| `severTail`     | ea575a83e3c79040  | ea575a83e3c79040  | byte-identical                 |
| `createNode`    | 6c769aa814fdd4d1  | 6c769aa814fdd4d1  | byte-identical                 |
| `runCleanup`    | 2e7daa3fb8d2c3ee  | 2e7daa3fb8d2c3ee  | byte-identical                 |
| `disposeNode`   | 21be4f8dc8763143  | 21be4f8dc8763143  | byte-identical                 |
| `createRoot`    | 530eef21e8ce24f1  | 530eef21e8ce24f1  | byte-identical                 |
| `flush`         | caa47726a01a0079  | caa47726a01a0079  | byte-identical                 |
| `batch`         | b8d8c94ed878bcab  | b8d8c94ed878bcab  | byte-identical                 |
| `signal`        | cf24a3a973f6d0f3  | cf24a3a973f6d0f3  | byte-identical                 |
| `computed`      | 30a28248bc315dc9  | 30a28248bc315dc9  | byte-identical                 |
| `effect`        | 8542b2aa3e519e91  | 53945acc0044b722  | +1 line, cold (Symbol.dispose) |
| `createScope`   | 68cd175f7ddc6120  | 13d52c939a2e4566  | +1 line, cold (Symbol.dispose) |

`effect` and `createScope` each pick up **exactly one line** on the
creation path:

```javascript
if (SYMBOL_DISPOSE !== null) disposeFn[SYMBOL_DISPOSE] = disposeFn;
```

This is creation-path stamping (once per effect/scope allocation, on
the disposer construction that already runs), not hot-path. Both the
propagation core (`pullComputed`, `markDownstream`, `flushEffects`,
`executeEffect`, `allocateLink`, `severTail`) AND the flush-strategy
scaffolding (`flush`, `batch`, `.set` closures) are byte-identical to
1.8.0. The `getOwner` / `runWithOwner` cascade port adds new functions
between `createRoot` and `createScope` -- confirmed by sha256 to
disturb no existing function.

**The Bar 2 CREATION BAR** (fieldkit `createSignals` / `createEffects`
within noise of 1.8.0) is the one to watch here -- a single existence-
guarded assignment on the effect / scope creation paths is the smallest
possible thing to add and should register as noise on both host
MacBooks. Any bench delta beyond noise is either V8 shape-transition
cost from the extra own-prop stamp on the disposer closure, or run-to-
run variance; the sha256 verification rules out any other mechanism.

### Test coverage

- **Full suite green**: **457 total, 446 pass, 0 fail, 1 skip (SSR N/A),
  10 cancelled** (the `25-devtools-real-boot` cases needing the devtools
  peer dep -- pre-existing, unrelated). Delta from 1.8.0's 451: +6 tests
  (+5 from the discriminator's `getOwner` block activating on this
  engine; +1 from the discriminator's absorption pin -- both accounted
  for below). The 16-test `test/28-run-with-owner.test.mjs`
  cascade-forwarded from 1.6/1.7/1.8 remains in place.
- **`test/28-run-with-owner.test.mjs`** (16 tests, cascade-forwarded):
  basic shape, degradation, and the three hazard pins with allocation
  pressure applied so the ABA guard is actually exercised.
- **New: `test/34-computed-selfdirty-prev-owner.test.mjs`** -- a single
  self-gating discriminator covering three feature bands:
  - **`getOwner / runWithOwner`** -- **ACTIVE on 1.9.0** (owner APIs
    are present via the cascade port). All 5 tests pass: `getOwner`
    returns a live handle inside a scope + `undefined` at root;
    `runWithOwner` adopts nodes into the chosen scope + doesn't track
    reads in `fn`'s direct body; a **stale owner handle degrades to
    rooted execution** under recycling pressure (the ABA-guard pin the
    roadmap explicitly requires -- allocates a stranger effect to reuse
    the disposed owner's slot, then attempts `runWithOwner` with the
    stale handle); nested `runWithOwner` restores the previous owner on
    exit and is throw-safe.
  - **`computed self-write stays ABSORBED (ledger #15)`** -- **ACTIVE
    on 1.9.0** and every 1.x engine. Pins the deliberate
    `johnsoncodehk/reactivity-benchmark #179` exclusion: a computed
    that writes its own tracked dep ABSORBS the write into the current
    evaluation rather than looping. This is the predictable 1.x
    contract, unchanged since the mark/absorb design.
  - `computed fn(prev) + opts.initial` -- **SKIPPED on 1.9.0**
    (feature lands 1.9.1-preview). Currently skips with reason
    `"engine predates fn(prev) (rebuilt-line 1.9.1)"`.
- **`test/03-pool.test.mjs`** carries the 12-key `stats()` shape
  assertion from 1.6/1.7/1.8 (adds `flushPasses`).

**Note on the test file name convention:** the uploaded discriminator
file used `33-computed-selfdirty-prev-owner_test.mjs` (underscore, and
number `33`). It is renamed to `34-computed-selfdirty-prev-owner.test.mjs`
in the delivered tree: `.test.mjs` (period) to match the ecosystem-wide
convention (`NN-name.test.mjs`) and pick up the standard `test/*.test.mjs`
glob (`_test.mjs` would be silently ignored by `node --test`), and `34-`
to avoid colliding with `33-cleanup-return.test.mjs`, which carries forward
from 1.8.0 since this line inherits the effect cleanup-return feature.

### The rebuilt-line rejection ledger (context for what does NOT ship)

Preserved from the ROADMAP-1_9-REBUILT for the record; nothing new on
this cut, these are the entries the rebuilt line is defined against:

- **#15 -- computed self-dirty / upstream #179 closure**: hot-path cost
  for a deliberately-excluded construct. The absorption pin
  (`test/33-...`) keeps this honest.
- **#16 -- inner-write fixed point**: one flag test + refire branch per
  effect run + ceremony stores; closed **zero** upstream tests (they
  pass under 1.8.0 absorption); its value was contract purity, its cost
  was hot bytes in `executeEffect`. Absorption remains the contract.
  Everything learned (two-tier batch rule, #235 analysis,
  `currentObserver` identity) stays archived for the day the trade
  changes.
- **#17 -- `onSettled` as a dynamic always-checked hook**: the 7ns/flush
  inline-budget trap that killed the old 1.9.0. Superseded by the
  **1.11.0-preview** design: creation-time capability
  (`createRegistry({ settled: true })`), const-selection at build,
  default-build `flushEffects` byte-identical to 1.8.0's.
- **Raw-pointer owner handles**: crash + corruption on recycled-slot
  and corpse-adoption, reproduced on 1.5.0-beta. Stands. The safe
  gen-guarded design that unblocked this on 1.5.0-beta.3 is what
  cascade-forwards here.

### The standing gate on the rebuilt line

Every candidate on the rebuilt line must pass, before anything else is
discussed:

1. **The 1to1batch BAR** -- fieldkit `1to1batch` (sbench
   `updateComputations1to1`, exact -- one effect, one signal, 400k
   batch-wrapped sets) within noise of 1.8.0, cold-process interleaved
   minima, on real hardware.
2. **CREATION BAR** -- fieldkit `createSignals` / `createEffects` within
   noise of 1.8.0. Any new closure or property stamp on creation paths
   shows here. This is the bar 1.9.0's `effect` and `createScope`
   Symbol.dispose stamps face; both are single-line existence-guarded
   assignments, so the expectation is noise-band.
3. **Hot-function hash parity** vs the previous version wherever the
   feature claims cold-path -- **claims are proven by sha256 over
   extracted bodies, not asserted**. Verified above for 1.9.0-preview
   against 1.8.0.
4. **The usual ladder**: full suite, smoke, burst structure, upstream
   johnsoncodehk run (177/178 is the standing; #179 excluded by design
   per ledger #15), ecosystem spot (lite-headless minimum),
   VersionMatrix gate, ASCII audit.

The lesson behind the 1to1batch bar: the old 1.9.0's `onSettled` check
cost ~7ns per flush **through V8 code-size / inline-budget effects,
not instruction count** -- bytes added to `flushEffects` /
`executeEffect` are hot-path changes even when the branch never takes.
Therefore: **nothing lands in a hot function body in the default
build**. Per-flush or per-run telemetry exists only inside build-time
twins (see the 1.12.0-preview trace-twin design).

### Verified

- **Full test suite green** on 1.9.0-preview: 457 total, 446 pass, 0
  fail, 1 skip, 10 cancelled.
- **Discriminator's absorption pin (ledger #15)** passes on this
  engine.
- **Discriminator's `getOwner / runWithOwner` block** (5 tests)
  activates and all pass -- including the recycling-pressure gen-guard
  test that would fail on a raw-pointer implementation.
- **`Publications/owner-hazard-repro.mjs ./Signal.js`** reports
  `VERDICT: SAFE` on the recycled-slot case AND completes the
  corpse-adoption case without stack overflow.
- **`test/28-run-with-owner.test.mjs`** cascade-forwarded from
  1.6/1.7/1.8 (16 tests) passes in isolation.
- **Symbol.dispose behavior verified end-to-end** on Node 22:
  - `registry[Symbol.dispose]` is a function; calling it destroys the
    registry.
  - `effect(...)[Symbol.dispose]` is a function; calling it stops the
    effect.
  - `createScope(...)`'s returned disposer has `[Symbol.dispose]` too
    (via `dispose[SYMBOL_DISPOSE] = dispose`).
  - `signalBox(...)[Symbol.dispose]` is a function, but
    `Object.prototype.hasOwnProperty.call(box, Symbol.dispose)` is
    `false` -- the method lives on the prototype, zero per-instance
    cost.
  - `signal(0)[Symbol.dispose]` is `undefined` (callable value handles
    deliberately unstamped).
- **sha256 hot-path parity vs 1.8.0**: 14 propagation / flush-scaffold
  functions byte-identical. Only `effect` and `createScope` differ,
  each by exactly one line for existence-guarded Symbol.dispose
  stamping. `getOwner` / `runWithOwner` port added new functions
  between `createRoot` and `createScope`; sha256 confirms no
  pre-existing function was disturbed by the insertion.

### Verified -- fresh 1.9.0-preview bench sweep (Apple M4 Pro / Node 26)

Both v3 instruments were re-run in full on the 1.9.0-preview engine on
**Apple M4 Pro darwin/arm64, Node 26.3.1**, with `#STAMP`-verified
outputs committed to `bench/r.txt` (microscope aggregate, 4 engines
across the six first-party shapes) and `bench/rb.txt` (mirror sweep,
Andrii's canonical adapter verbatim, lite vs alien across 47 rows,
isolated-per-row, 10 reps). Andrii 15-framework log at
`bench/AndriiVolynetsReactiveBench.log` (byte-identical to 1.8.0's --
the 1.9.0-preview engine is sha256-identical to 1.8.0 on all 14
propagation / flush-scaffold functions and differs only in `effect` and
`createScope` by one existence-guarded `[Symbol.dispose]` stamp line
each on the cold creation path, so the ranking numbers carry with zero
re-verification cost).

- **Andrii Volynets js-reactivity-benchmark position holds at 3rd of
  15** (the position lite moved to on 1.8.0) with geomean **95.4 ms**;
  lite is ahead of 4th-place @reactively (136.0, lite 1.43x faster) and
  5th-place Preact Signals (148.8, ~56% ahead), behind only
  alien-signals (77.5) and reflex (89.7). **20 outright wins** (the
  eight canonical propagation shapes, all four wide fan-in / fan-out
  shapes, `molBench`, and seven of the rectangular / layered DAG
  shapes). Top-3 count: **29/47**. Since the engine is sha256-identical
  to 1.8.0 across every propagation function, this is the same log
  1.8.0 published; re-running Andrii's suite would produce host-noise
  drift, not a code-driven delta.
- **Microscope aggregate on M4 Pro (r.txt):** on the six v3 microscope
  shapes, lite wins vs alien on **MUX +34.9%** (fan-in), **SELECTIVE
  DAG +20.9%**, **DYNAMIC DAG +16.1%**, and **BROADCAST +5.2%**
  (narrowed from +9.4% on 1.8.0 but still on the win side of parity).
  The wins hold within noise of the 1.8.0 M4 Pro sweep despite the two
  `[Symbol.dispose]` stamp lines added at effect / createScope
  creation, which is what "one existence guard per cold creation path,
  nothing on the propagation hot path" looks like in the propagation
  numbers. Alien ahead on **KAIROS -19.5%** (widened from -15.9% on
  1.8.0 -- host-noise drift on the shape where lite is architecturally
  weakest) and **DEEP CHAIN -72.8%** (the architectural weak spot:
  recursive JS-stack computed resolution against alien's flatter
  chain). Speed wins vs alien: **4/6**; heap wins: **5/6** with the
  sixth being a shared-zero on BROADCAST.
- **Microscope heap (the actual story) on M4 Pro:** on every shape
  where GC pressure exists at all, lite allocates **one to four orders
  of magnitude less transient heap than alien** -- DEEP CHAIN 0.5 KB vs
  1062 KB (>2000x, on the shape lite loses on time), MUX 0 KB vs 781
  KB, KAIROS 23 KB vs 802 KB (34.3x), DYNAMIC DAG 3.4 MB vs 55.7 MB
  (16.6x), SELECTIVE DAG 7.7 MB vs 76.5 MB (9.9x). Against
  preact-signals and solid-signals the heap gap is even wider on the
  fan-in / fan-out family; solid allocates ~17 MB on MUX and ~15 MB on
  SELECTIVE DAG where lite allocates 0 KB and 7.7 MB on the same
  shapes. The differentiated position is ALLOCATION, not raw
  propagation speed -- competitive-to-winning throughput with
  dramatically lower GC pressure, and that is the headline that
  reproduces across hosts.
- **Mirror sweep on M4 Pro (rb.txt):** Andrii's canonical 47-shape
  suite re-run isolated-per-row lite vs alien on M4 Pro reproduces the
  same honest framing: lite runs **parity-to-behind alien on
  throughput** across the head-to-head suite (wins outright on **3/47**
  -- `1000x5 - 25 sources (wide dense)` +10.7%,
  `manySourcesIntoOneComputedEffectWithDirect` +31.5%,
  `manySourcesIntoOneComputedEffect` +30.2%; `molBench` dropped from a
  razor-thin +0.3% win on 1.8.0 to -0.4% parity this sweep, taking the
  outright-win count from 4/47 to 3/47), weak on the deep/layered-burst
  family. That head-to-head result and the "3rd of 15 with 20 outright
  wins" both live on the same Andrii log and are not contradictory: the
  outright-of-15 rankings look at each shape across every framework in
  the field, so shapes where alien beats lite by 20-30% but reflex
  beats both and everyone else is slower can still count as a lite
  outright win when measured that way.
- **Third-party engine versions carried forward** from the 1.8.0 sweep
  (alien-signals 3.2.1, @preact/signals-core 1.14.2, @vue/reactivity
  3.5.35, solid-js 1.9.13). No peer bumps this cycle; the deltas here
  are the 1.9 engine's own footprint (the two `[Symbol.dispose]` stamp
  lines) plus host noise.

### Migration

Zero work for every existing user. Symbol.dispose is additive; nothing
that worked before behaves differently. `getOwner` / `runWithOwner`
cascade forward from every prior 1.x line without semantic change.

- **Node 20 / 22 users**: manual `.[Symbol.dispose]()` calls work
  today, the `using` syntax lights up when you upgrade to Node 24.
- **Node < 20 users**: `SYMBOL_DISPOSE` is `null` and every stamp site
  short-circuits at the guard. The engine behaves byte-identically to
  1.8.0 modulo the two guard branches on creation.
- **Users of the `getOwner` / `runWithOwner` idiom from 1.5.0-beta.3
  onward**: continues to work, same signatures, same handle
  gen-guarantees.

## [1.8.0-preview] -- 2026-07-XX

The **effect cleanup return** minor -- Reflex-study pattern A. One additive
hot-path change: an effect body may now `return` a cleanup function, which
runs before the next re-run and on dispose, composing with imperative
`onCleanup(fn)` in call order. Plus the recurring **`getOwner` /
`runWithOwner` forward-port from 1.5.0-beta.2** -- the 1.8.0-preview
`Signal.js` was branched from the same pre-1.5.0-beta.2 base as 1.7.0-preview
and 1.6.0-alpha, so the two async-gap ownership primitives are re-added
unchanged on this line.

The 1.7.0 flushStrategy scaffolding (`"eager"` | `"sab"` | `"manual"` + explicit
`r.flush()`) carries forward unchanged, as does every 1.5-era API surface
(`signalBox` / `computedBox` / `createRoot` / `createScope`) and every
propagation-core primitive. **Only `executeEffect` legitimately changed** from
1.7.0-preview; sha256 over the 15 other function bodies is byte-identical
between pristine 1.7.0-preview and pristine 1.8.0 (verified: `pullComputed`,
`markDownstream`, `flushEffects`, `allocateLink`, `severTail`, `createNode`,
`runCleanup`, `disposeNode`, `createRoot`, `createScope`, `flush`, `batch`,
`signal`, `computed`, `effect`).

Drop-in over 1.7.0-preview. The default is unchanged; effects that do not
return a function are unaffected (one `typeof` check per effect run, off the
mark/pull path).

### Added -- effect cleanup return (Reflex pattern A)

```javascript
effect(() => {
    const timer = setInterval(tick, 16);
    return () => clearInterval(timer);   // <-- ran before next re-run, and on dispose
});
```

Solid/Vue/Reflex-compatible: an effect body may **return a cleanup function**.
It runs before the next re-run and on the effect's disposal, appended to any
imperative `onCleanup(fn)` registered inside the same body with the same append
semantics (single fn -> pair array -> push), so the two registration styles
**compose in call order**. Non-function returns are ignored. A self-disposed
body (one that generation-advances mid-execution) registers nothing -- the
slot may already host a new resident by the time the return is inspected, so
the guard is `node.gen === savedGen` before touching `node.cleanupFn`.

**Computeds are untouched.** A computed returning a function keeps treating
that function as the *value*. The cleanup-return check is inside
`executeEffect` and gated on the effect body's return type; the computed pull
path has no analogous inspection.

**Cost.** One `typeof` per effect run, entirely off the mark/pull path.
`executeEffect`'s sha256 is the only 1.7 -> 1.8 body change; every other
propagation function is byte-identical (see Hot-path safety below).

### Added -- `getOwner` / `runWithOwner` (carried forward from 1.5.0-beta.2)

The capture-and-restore companion to `createRoot`. `getOwner()` returns the
current lifecycle owner as an opaque, gen-stamped handle (`undefined` outside
any effect/computed body); `runWithOwner(handle, fn)` runs `fn` with that
owner reinstated so effects/computeds created directly in `fn` are adopted by
it (and cascade-dispose when the owner re-runs). Nulls the tracking observer
for `fn`'s direct body -- same pairing as `createRoot`, so accidental
cross-async dependency edges cannot form.

**Handles are gen-stamped.** They use the `describeNode` + `liveNode`
ABA-guard machinery (`NODE_GEN` stamp checked against the pool slot's current
gen), same as `describe` / `nodeId` / `forEachOwned` / `ownerOf` since 1.2.1.
Safe to hold across async boundaries: stale handles (owner disposed, slot
recycled by an unrelated effect via the LIFO free list) degrade to **rooted
execution** rather than adopting the continuation into the recycled slot's new
resident. Two hazards on the raw-pointer alternative are empirically
reproduced by `Publications/owner-hazard-repro.mjs`:

- **Recycled-slot cascade death** -- capture, dispose owner, allocate a
  stranger effect that reuses the slot; a raw-pointer
  `runWithOwner(captured)` silently adopts the continuation into the
  stranger; the stranger's next re-run cascade-disposes it.
- **Corpse adoption = engine crash** -- capture, dispose owner but
  not-yet-recycled; a raw-pointer `runWithOwner(captured, () => effect(...))`
  splices a child into a disposed owner's `firstOwned`; the next disposal
  walk recurses without termination (`RangeError: Maximum call stack size
  exceeded`). Not a leak; a crash.

Both fail on the raw-pointer sketch; both pass on the shipped `describeNode` /
`liveNode` implementation. Verified against 1.8.0-preview's engine directly:
`Publications/owner-hazard-repro.mjs ./Signal.js` reports `VERDICT: SAFE` on
the recycled-slot case (continuation runs 2 times before stranger disposal, 3
times after) and completes the corpse case without stack overflow.

Exported as registry methods AND top-level helpers bound to `defaultRegistry`,
inserted between `createRoot`'s top-level binding and `createScope`'s for
stable ordering. No hot path touched; sha256 over the 15 other function
bodies matches pristine 1.8.0-preview byte-for-byte.

### Rejected during this cycle (ledger #13)

The **"lean node shape" batch-revert side stack** (Reflex pattern C). Moving
the on-node `{preBatchValue, preBatchVersion, revertEpoch}` triple into a
registry-level capture stack -- both a parallel-arrays variant AND an
interleaved stride-3 variant -- held the full behavioral contract (**439/439
internal tests, conformance clean**) and was VersionMatrix-neutral, but
regressed capture-dense batched writes **+5-9%** and revert-heavy batches
**+20%** in cold-process A/B (n=3, consistent).

Family (c) loses in **both** directions: these fields are not cold. The first
batched write is a hot edge (every batch that mutates a signal touches
`preBatchValue` on the way in), and the on-node triple **already rides
`node.value`'s cache line** -- no side structure can beat sitting inside the
line that's about to be loaded anyway. The build is archived under
`engines/rejected/1_8_0-sidestack.js` with its probe for future reference.

### Also measured this cycle (not a 1.8.0 engine property)

The **recursive-pull depth plateau is V8-scope-shape-sensitive**. Adding ANY
context slots to `createRegistry` -- **four dummy consts suffice** -- drops
the cold-pull overflow point from ~4096 to ~2559 on Node 22 by parking the
probe on interpreted-size frames. Ceiling scales linearly with
`--stack-size` on every build. Public claims quoting `~4k depth` should be
tightened to **"plateau-dependent, 2.5k-4k, tunable"** because the exact
ceiling is a V8 frame-layout artifact, not an engine constant. Nothing in
this release changed the pull path; the sensitivity was there in 1.7 too and
is documented here for the record. `pull-stress.mjs` (1.6+) will pin the
exact number on any given build.

### Hot-path safety

**Only `executeEffect` legitimately changed** from 1.7.0-preview -- the
cleanup-return check is an extra `typeof` + a small append. sha256 over the
15 other propagation-relevant function bodies (`pullComputed`,
`markDownstream`, `flushEffects`, `allocateLink`, `severTail`, `createNode`,
`runCleanup`, `disposeNode`, `createRoot`, `createScope`, `flush`, `batch`,
`signal`, `computed`, `effect`) matches pristine 1.7.0-preview byte-for-byte.

The `getOwner` / `runWithOwner` port only adds new user-API functions between
`createRoot` and `createScope` -- verified via sha256 that no pre-existing
function was disturbed by the insertion. Nothing in the propagation core,
scheduler, or pool moved.

### Test coverage

- **Full suite green** on 1.8.0-preview with the getOwner/runWithOwner port
  merged in: **451 total**, 440 pass, 0 fail, 1 skip (only the
  architecturally-N/A SSR case in `17-reactivity`), 10 cancelled (the
  `25-devtools-real-boot` cases that need `@zakkster/lite-devtools` installed
  as a peer -- pre-existing, unrelated). Default-mode behavior for effects
  that do not return a function is unchanged from 1.7.0-preview byte-for-byte.
- **+16 tests in `test/28-run-with-owner.test.mjs`** carried forward from
  1.5.0-beta.2 (basic shape, degradation, and the three hazard pins with
  allocation pressure applied).
- **`test/03-pool` "stats() shape"** carries the 12-key 1.6+ shape assertion
  forward (`flushPasses` present).
- **New behavioral coverage to add** for effect cleanup return (deferred to
  `1.8.0-preview.1`): fires before next re-run, fires on dispose,
  composition with `onCleanup(fn)` respects call order, non-function returns
  ignored, self-disposed body registers no cleanup, computed returning a
  function still treats it as the VALUE (regression pin), cleanup exceptions
  do not stop the effect from re-running (or do -- design decision either way
  needs a test).

### Verified

- **Full engine test suite** green on the merged engine (451 total, 440 pass,
  0 fail, 1 skip, 10 cancelled).
- **`Publications/owner-hazard-repro.mjs ./Signal.js`** reports `VERDICT:
  SAFE` on the recycled-slot case AND completes the corpse case without stack
  overflow -- the ABA guard degrades both hazards to rooted execution as
  designed.
- **sha256 over 15 pre-existing function bodies** byte-identical between
  pristine 1.8.0-preview and my merged-with-getOwner engine (port added new
  code only). **`executeEffect` sha256** matches between pristine 1.8.0 and
  my merged file too -- the cleanup-return addition survives the port
  unchanged; my port did not touch that function.
- **`executeEffect` sha256 vs 1.7.0-preview**: `26613285331deaed` ->
  `4487beb9d15f80c6`. Legitimate change; the sole 1.7 -> 1.8 hot-path
  modification.
- **`markDownstream` / `flushEffects` sha256**: unchanged from 1.7.0-preview
  (still `ad7a007ec23260fc` / `a25b36ba097fdf1a`), which in turn track back
  to 1.6.0-alpha's opcode 6/7 additions. The 1.8 minor introduces no new
  hook-gate branches.

### Migration

- **Every existing user**: zero work needed. Effects that don't return a
  function are unaffected. `flushStrategy` default remains `"eager"` (1.7's
  byte-identical mode).
- **Effects that already return a value (e.g. a state update)**: only
  function returns are treated as cleanups. If an effect happens to return a
  function today (rare, but possible), it will now be registered as a
  cleanup. Audit before upgrading if this is your codebase's pattern.
- **Users of `createRoot` who want capture-and-restore across async
  boundaries**: `getOwner()` + `runWithOwner()` are now on the 1.8 line
  (same signatures and semantics as 1.5.0-beta.2 / 1.6.0-alpha /
  1.7.0-preview).

## [1.7.0-preview] -- 2026-07-XX

The **flush-strategy minor**, shipping on the `preview` dist-tag while it settles.
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
`effect` / `signalBox` / `computedBox` (their `.set` sites) and `batch` (their
exit sites) -- specifically the resolved-once binding to `flushAfterWrite` /
`flushAfterBatch`. **Every other hot-path body is byte-identical to 1.6.0**
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
`Publications/owner-hazard-repro.mjs`:

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
`Publications/owner-hazard-repro.mjs ./Signal.js` reports `VERDICT: SAFE` on the
recycled-slot case (continuation runs 2 times before stranger disposal, 3
times after) and completes the corpse case without stack overflow.

Exported as registry methods AND top-level helpers bound to `defaultRegistry`,
mirroring `createRoot` and `createScope`. Top-level exports added right before
the top-level `createScope` binding for stable ordering.

### Hot-path safety

The `flushStrategy` lever is resolved ONCE at registry init by binding
`flushAfterWrite` and `flushAfterBatch` to one of two pre-built closure
references (`eagerFlushHook | noopFlush`). Every `.set` / `boxSet` / `batch`
call site captures a constant function reference for its lifetime; V8 sees
monomorphic targets and inlines the body. In "eager" mode the inlined body is
byte-identical to the 1.6.0 inline check `if (batchDepth === 0) flushEffects()`
-- **zero behavioral or performance regression** for any existing user.

This is NOT ledger S0b #6 (per-call closure-var load of a primitive). It is a
hoisted function reference resolved once at registry build time and is a NEW
mechanism by the v1 roadmap S0b line 100 definition.

The `getOwner` / `runWithOwner` port adds new user-API functions but touches no
hot path. sha256 over the extracted function bodies of `pullComputed`,
`markDownstream`, `executeEffect`, `flushEffects`, `allocateLink`, `severTail`,
`createNode`, `runCleanup`, `disposeNode`, `createRoot`, `createScope` matches
pristine 1.7.0-preview byte-for-byte; the two new functions are inserted between
`createRoot` and `createScope` without disturbing either.

### Test coverage

- **Full suite green** on 1.7.0-preview with the getOwner/runWithOwner port
  merged in: **451 total**, 440 pass, 0 fail, 1 skip (only the
  architecturally-N/A SSR case in `17-reactivity`), 10 cancelled (the
  `25-devtools-real-boot` cases that need `@zakkster/lite-devtools` installed as
  a peer -- pre-existing, unrelated). Default-mode behavior is unchanged
  byte-for-byte from 1.6.0.
- **+16 tests in `test/28-run-with-owner.test.mjs`** (carried forward from
  1.5.0-beta.2 / 1.6.0-alpha): 7 basic-shape tests, 3 degradation tests
  (`null` / `undefined` / signal-handle all fall through to rooted execution),
  and 3 **hazard pins** with allocation pressure applied so the ABA guard is
  actually exercised (recycled-slot cascade, corpse adoption, composed).
- **`test/03-pool` "stats() shape" test** bumped from the 11-key 1.4.0 shape to
  the 12-key 1.6+ shape (adds `flushPasses`). This was flagged already in the
  1.6.0 line; the 1.7 line inherits it.
- **New behavioral coverage to add** (per the drafted 1.7 notes, deferred to
  1.7.0-preview.1): `sab` batch-exit flush, `sab` dedup across many writes,
  `manual` flush gating, lazy-pull correctness across all three modes, invalid
  `flushStrategy` validation.

### Bench impact (sandbox VM medians, 7 samples)

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

- **Full engine test suite** green on the merged engine (451 total, 440 pass,
  0 fail, 1 skip, 10 cancelled).
- **`Publications/owner-hazard-repro.mjs ./Signal.js`** reports
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