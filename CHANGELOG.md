# Changelog

All notable changes to `@zakkster/lite-signal` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

One engine simplification (LEDGER #30, "observer-fold") plus dev-only work: the gate gaps
closed after the link-SoA fork (LEDGER #27) passed the gates while costing +10-39% on four
shapes, a gate-1 conformance runner, and the `bench/soak/` randomized soak harness. The engine also carries the error-semantics fix FIX-T ("### Fixed -- engine: error semantics" below: a dependency pre-walk no longer throws a cached error, leaving an error is a change, a dep cycle throws CycleError). `Watch.js`
changes `watch()`'s fire order and `stop()` ("### Fixed -- `watch()`" below) and `when()`'s cancel
handle ("### Fixed -- `when()`" below; `Signal.d.ts` gains doc comments only); `Signal.js` changes the tracking-flag fold described below (no
API, no behavior change), the F29 version-counter fix ("### Fixed" below), the F21 flushEffects fix ("### Fixed -- engine: stale effect-queue entries skip a node that is no longer QUEUED" below), the sync-scheduler creation-throw fix ("### Fixed -- engine: a synchronous scheduler's creation-time throw disposes the effect" below) and also carries the in-progress A1 cursor-safety repair (F15 / F8 / F13, round
4-1, commit fc1f826), whose entry lands here when its campaign is accepted. The Signal.js rungs after that:
`observeObservers` registrations are independent (A5a), `onGraphMutation` unsubscribe works in any order (A5b),
user callbacks run with `this === undefined` (#48) and a stale signal handle's `update(fn)` returns without calling `fn` (#51); see their "### Fixed" entries below. Nothing else in the
published `files[]` changes except `README.md`, `llms.txt` and the 1.6.0 `snapshot()` / `restore()` API plus the FLAG_BOX change to box nodes' `onGraphMutation` op 1 / op 2 flags (now 160 / 129; "### Added -- `snapshot()` / `restore()` and FLAG_BOX (bit 7)" below; `Signal.js` and `Signal.d.ts`).

### Fixed -- stale update(fn) no longer calls fn (LEDGER #51, b136)

A STALE signal handle's `update(fn)` (the handle's slot was disposed, or the registry destroyed, whether or not the slot was
re-seated) now returns `undefined` without calling `fn` and leaves the resident unchanged. Before (Signal.js sha256/8
ec6d7156) `fn` was called once with the slot's CURRENT resident value (a recycled signal / computed resident's value,
`undefined` for a dead slot, the effect node's value for an effect resident) and the write was then dropped by `set`'s gen
guard. `sharedUpdate` now has the same `this[NODE_GEN] !== node.gen` guard that `sharedSignalPeek` and `boxUpdate` already
have (maintainer D-b135-1). The module-level `signal` export gets the same fix; computed / computedBox have no `update`.
Two visible changes: a stale `update(5)` (a non-function) used to throw `TypeError: fn is not a function` and now returns
undefined silently (as a stale signalBox update already did); a DETACHED `const { update } = s; update(f)` still throws
`TypeError`, but the message changed from `Cannot read properties of undefined (reading 'set')` to `Cannot read properties
of undefined (reading 'Symbol(node_ptr)')`. Live `update(fn)` is unchanged (10,000-op seeded live-handle trace
byte-identical before/after). Cost, untimed (b136, Node v26.8.2): `sharedUpdate` 29 -> 49 B bytecode, registers 4 -> 5;
a cold path, none of test/65's 14 pinned hot bodies changes. Inlining diff: TurboFan SAME; Maglev differs in one line
(`sharedUpdate` is no longer in the "small function" class, still inlined at the same sites). No timing claim. Tests:
`test/91-l51-stale-update.test.mjs` (16 tests under --expose-gc; the A3 / A4 rows skip without it). LEDGER #51 is FIXED on
1.6.0-dev (b136, Signal.js sha256/8 ea0b64d1; lands with b137's calibration recut). Published 1.5.2 still has the bug.

### Fixed -- user code no longer runs with `this` = the internal node (LEDGER #48, b120)

Computed, `computedBox` and effect bodies (live, and restored through `restore`'s `fnsById`), the effect scheduler (at creation
and on every later schedule) and every `onCleanup` function (single and array form) now run with `this === undefined`. Before
(Signal.js sha256/8 2f7974f3) the body and the creation-time scheduler ran with `this` = the internal node, and, when two or more
cleanups were registered in one run, every one of them (the first included) ran with `this` = the internal cleanup array
(a lone cleanup and later scheduler calls already saw `undefined`). A sloppy-mode body sees `globalThis`, as for any plain call.
Non-function arguments still fail where they failed before. A non-function body or scheduler throws `TypeError` at the same
call, and a non-function inside a registered cleanup array throws `TypeError` when the cleanups run. A lone `onCleanup(5)`
(a non-function without a `length`) throws on neither build (unchanged, LEDGER #50). Only the message texts changed: a `computed(123)` read, a
`computedBox(123)` read and `effect(123)` now say `(0 , node.computeFn) is not a function` (was `node.computeFn is not a
function`), a truthy non-function scheduler says `scheduler is not a function` (was `node.scheduler is not a function`), a
non-function in the cleanup array says `fn is not a function` (was `cleanup[i] is not a function`). Hot-path cost, untimed
bytecode / depth evidence only (b120, Node v26.8.2; no timing claim, the A/B is release-gate only): `executeEffect` 455 -> 454 B
and `refreshComputed` 782 -> 781 B, registers unchanged (16 / 19); recursion depth unchanged on all 5 lanes. The body call is
`(0, node.computeFn)()` rather than a local, because the local added a register and cost 2.6% of fresh nested-effect depth
(1616 -> 1574). Tests: `test/86-callback-this.test.mjs` (22 tests under --expose-gc, 19 without); `test/76`'s D-L receiver row
now asserts `this === undefined`. LEDGER #48 is FIXED on 1.6.0-dev (Signal.js sha256/8 ec6d7156; lands with its timed
calibration recut, b121).

### Fixed -- onGraphMutation unsubscribe in any order (F9 / A5b)

The `onGraphMutation` registrations now form a live-entry stack. An unsubscribe in any order unlinks only its own entry, the
newest still-live entry stays the active listener, and a removed listener is never revived (before, `offA` then `offB` re-activated
A: the old unsubscribe restored whatever it had saved, so only LIFO order was correct). A held unsubscriber no longer retains its
listener: the off closure holds only its entry, and the entry's listener and links are nulled once it has run. `onGraphMutation(null)`
stays a clearing entry on top. Fire points and the D-B2 wrapper are byte-identical (`if (mutationHook !== null)`); the register
and unsubscribe paths are cold. Disassembled function sizes before -> after (bytecode, untimed, node v26.8.2): `onGraphMutation`
72 -> 56 B, its off closure 27 -> 119 B, new `hookPush` 73 B (`.handoff/b116-evidence/b1/G1-diff.txt`). Tests: `test/85-f9-hook-non-lifo.test.mjs`
(non-LIFO off, a null entry, double and stale offs, register and off mid-fire, a throwing listener, exhaustive and seeded
reference-model sweeps, and `--expose-gc` retention and 0 B/op fire rows). Docs: README, `llms.txt` and `Signal.d.ts` (JSDoc only) no
longer say "restores the previous one" / "LIFO stacking". LEDGER: rung line under section J.

### Fixed -- observeObservers registrations are independent (D3 / A5a)

Each `observeObservers(handle, hooks)` call is now its own registration (before, the registrations on one node were merged into one entry;
DIV-D3). Per registration: callbacks fire in registration order (FIFO) on every 0->1 / 1->0 step; a registration
added during a fire is skipped by that fire (it starts in the node's current phase); the returned `unobserve` takes effect
immediately, even mid-fire; callbacks are called with `this === undefined`; disposing the observed node drops every registration and its callbacks (b114 F-a), and a kept `unobserve` retains nothing.
Every callback runs in its own try/catch: one error is rethrown as-is, two or more become an `AggregateError` with the errors in
registration order and the message `observeObservers: onConnect callbacks threw` / `observeObservers: onDisconnect callbacks threw`.
The LEDGER #45 / #46 op-3 rules are unchanged (a throwing `onConnect` still announces its live edge once). `fireDisconnect` restores
`currentObserver` on every path. Tests: `test/84-lifecycle-independent.test.mjs`; `test/65-hot-body-pins.test.mjs` now pins 14 hot
bodies (+ `allocateLink`, `freeLink`, values unchanged); `test/torture.mjs` gains the `mreg` lane (steady-state, whole-run window
gate and retention half in the pinned child). (User code running with `this` = the internal node was fixed later, LEDGER #48: see the #48 entry above.)

### Tests / Docs -- soak: RECYCLE update op rsupd + T-RC-updgen (LEDGER #51 tooth, b137)

Dev-only (`bench/soak/`, not shipped). No engine change in this unit: Signal.js stays sha256/8 ea0b64d1 (the b136 #51 fix).
- RECYCLE gains the op `rsupd {s, v}`: a stale SIGNAL handle's `update(fn)` through the new S3 decorator world method
  `update(h, fn)` (`adapters/lite-s3.mjs`; `contract.mjs` EXT_METHODS.recycle = ['update']; `adapters/lite.mjs` unchanged,
  S3-D1; `config.mjs` LATENCY_UNTIMED gains `update`, 8 S3 extension methods). Generator weight STALE.rsupd 6
  (`lanes/recycle.mjs`). `scenarios.mjs` onRcStale accepts 'upd' on kind s only. No new scenario (D-b136-2: SCENARIOS
  stays 66).
- Oracle: `checkO9Update(label, calls, got)` raises the existing O9 sig stale-write when `fn` was called or the return is
  not undefined (D-b136-1: no new sig, O9 sigs stay 4). `checkO9Write` gains an optional `kind` naming the mismatched kind.
- `divergences.json` DIV-51 (fixedIn b136-#51): the frozen controls headpatched / lite-1.5.2 (and the HEAD aa154b6 tree,
  Signal.js ec6d7156) call `fn` on a stale update; that is explained under the named controls only, never on the tree.
- Maintainer ruling D-b137-1 (2026-10-29): `LANE_KERNELS.RECYCLE` = tree only (was headpatched, lite-1.5.2, tree; OWNER / #48
  precedent). With rsupd the controls fail-stop every RECYCLE world (B1 census 200 / 200 each, all DIV-51; about 6254
  ops vs 81000). P-RC-TREE is the pass control.
- Must-fail control T-RC-updgen: kernel = live Signal.js with the :1998 `sharedUpdate` line swapped back to HEAD's (kernel
  sha256 equals HEAD aa154b6 Signal.js ec6d7156); head `oracle=O9 lane=RECYCLE sig=stale-write known=none`. _mustfail now
  lists 79 controls (61 short + 18 long). teeth.mjs CHECKS lane:RECYCLE / oracle:O9 / sig:O9:stale-write gain it; teeth
  universe 70, CHECKS ids 60, GAPS 22 unchanged. `test/45` (38 tests) now pins the T-RC / T-SC kernel sha8s to the
  parity.json Signal.js pin, no silent skip (FILLER 84).
- Tests: `test/88` gains the checkO9Update matrix (A1), `world.update` on stale signal handles recycled to s / c / e and dead
  (0 calls, undefined, resident unchanged; A2, red on ec6d7156) and a 1e6 stale `world.update` GC row (minor 0, < 0.5 B/op,
  [v]-sink must-fail control; --expose-gc only); its header now says #51 is PINNED.
- FILLERS closed: 76a `lanes/scheduler.mjs` needsCaps + 'recycle' (+ `test/89` row); 76b `test/41` LANE_PINS subset of
  PARITY_FILES; 77 `owner.mjs` / `recycle.mjs` headers; 69 `owner.mjs` `!(cl <= CL_MAX)` + `test/41` literal; 78
  `parity.mjs` hint `npm run soak:parity:update`; 67 `recycle.mjs` b130 probe cite + kind; 73 `test/88` sig title; 84
  `test/45` guard; 88 `llms.txt` stale-handle sentence. 76c needed no edit (the golden-cmp lives only in an evidence script).
- Timed calibration recut (quiet-lock --strict, QUIET: load1 1.23 / baseline 2.21, no busy node, 1079 s, 2026-10-29,
  node v26.8.2, one run; kernels headpatched / lite-1.5.2 / tree, RECYCLE on tree only): RECYCLE tree 2717 full / 150
  smoke worlds, 0 failing, 0 crash; lowest required scenario stale-peek-recycled 67155 full / 3619 smoke (was 80812 /
  4341); every other lane moved no count. Wall time is REPORTED tier: gates nothing, no speed claim.

### Tests / Docs -- torture: scheduler-bench retired (R4b, b135)

Dev-only (`bench/`, not shipped). No engine change: Signal.js sha256/8 ec6d7156 unchanged.
- `bench/torture/scheduler-bench.mjs` retired 2026-10-29 (authority ruling S3-D4): delisted from `run.mjs`, its npm
  script removed from `bench/package.json`, the file moved to the gitignored `archived/`
  (source: `git show f2c2d45:bench/torture/scheduler-bench.mjs`). Absorbed by the soak SCHEDULER lane; coverage table and accepted loss in
  `decisions/0001-soak-design.md` section 16, RETIRED block in `bench/torture/MANIFEST.txt`.
- The torture suite is now 24 scenarios (23 semantic + 1 opt-in soak, `wraparound-torture`). `npm run torture:soak` runs
  0 scenarios by default ("0 passed, 1 skipped, 0 failed", exit 0).
- The lane's queue is synchronous: real microtask timing is witnessed only by `test/05-scheduler.test.mjs`. Accepted
  loss: the ~10 s single-registry aging with 1,508 live real-microtask effects under `grow`.

### Tests / Docs -- soak: SCHEDULER lane + O9 stale-thunk (R4c, b131-b134)

Dev-only (`bench/soak/`, not shipped). No engine change in this rung: Signal.js is the tree kernel sha256/8
ec6d7156; no new engine claim.
- New SCHEDULER lane, the 10th rostered lane (`lanes/scheduler.mjs`; `LANE_INDEX.SCHEDULER` = 8, ROSTER length 10,
  laneSpan stays 12). It drives scheduled effects (`scheduler` option) through a per-world ring of queued thunks with
  a FIFO / LIFO / HOLD delivery policy chosen per seed, ops `screate` / `sdrain` / `swrite` / `sdisp` / `srec`, under
  the G-SC1 effect-spec restriction. The exec ScState hook suspends O1e / O4 for a node with a pending thunk and
  excludes O5 while the effect never ran.
- Oracle O9 gains the sig `stale-thunk` (O9 sigs 3 -> 4; no 5th sig, D-b128-2): a delivery's first outermost effect body
  belongs to another node than the delivered thunk's, or a delivery of a disposed node runs a body (checkStaleThunk),
  or, maintainer ruling D-b132-1, a depth-1 scheduled body runs outside any delivery (checkScheduledBody). exec
  `scClosed()` fails closed after `close()`; a malformed index, -0 or wrong node kind is unmodelled.
- SCENARIOS 58 -> 66. SCHEDULER required 8: thunk-after-dispose, thunk-recycled, pending-write, partial-drain,
  drain-all, hold-retry, fifo-delivery, lifo-delivery (the last two by the observed delivery order, D-b132-1); covOff
  thunk-recycled. Policy collapse has no must-fail row (maintainer D-b133-1): the census lane mutants and the
  `test/89` observed-order rows are its evidence.
- Census (b133) 200 worlds x tree ec6d7156 / headpatched fa2871f0 / rev152: 0 failing. Mutants: dropcall 9cc16933 and
  wedge dbb57692 breach O4 effect-dead 50/50; thunkgen 304984f9 breaches O9 stale-thunk 56/56 FIFO + HOLD worlds (LIFO
  is blind by design); syncrun 542fcf14 breaches O9 stale-thunk 50/50.
- Timed calibration recut (quiet-lock --strict, QUIET: load1 1.94 / baseline 2.21, no busy node, 1088 s, 2026-10-28
  21:48 UTC, Node v26.8.2): SCHEDULER 2684 full / 147 smoke worlds, 0 failing, 0 crash on all 3 kernels; lowest
  required scenario thunk-recycled 80766 full / 4546 smoke. The 9 pre-existing lanes moved no count.
  LANE_KERNELS.SCHEDULER = headpatched, lite-1.5.2, tree. parity.json FILES 51 -> 52 (+ lanes/scheduler.mjs).
  scripts-1000 gains the SCHEDULER digest (9 others byte-identical). REPORTED tier: gates nothing, no speed claim.
- Must-fail controls (7 new): T-SC-dropcall, T-SC-wedge (O4 effect-dead), T-SC-thunkgen, T-SC-syncrun (O9
  stale-thunk), T-cov-SCHEDULER (exit 3, missing=thunk-recycled) and the pass controls P-SC-TREE, P-SC-HP. _mustfail
  now lists 78 controls (60 short + 18 long). teeth.mjs: universe 70, CHECKS ids 60, GAPS 22, NOT_TEETH 11,
  UNREACHABLE 5.
- Tests: new `test/89` (150 rows); `npm test` 2669 tests / 2656 pass / 0 fail / 12 skip / 1 todo (node v26.8.2);
  torture 0 B/op, gc major 0.

### Tests / Docs -- bench: inline-diff (b131)

Dev-only (`bench/inline-diff.mjs`, `npm run inline-diff`; not shipped, never in `npm test` / `verify`). Compares a
FROZEN before build against an after build for one named hot function by the Maglev + TurboFan inlining decisions
(`--trace-turbo-inlining` + `--trace-maglev-inlining`), as a multiset, with a before-vs-before null control; exit 0
SAME / 1 DIFF / 2 NO-VERDICT. Tests: `test/90` (14 rows, canned traces, no V8 spawn). The whole-trace default scope
DIFFs on ANY inlining change in the driver, including node's own ESM loader (isPosixPathSeparator, get pathname): use
`--only-fn` for the callee-side-only view.

### Tests / Docs -- soak: RECYCLE lane + O9 oracle (R4a, b130)

Dev-only (`bench/soak/`, not shipped). No engine change in this rung: Signal.js is the tree kernel sha256/8
ec6d7156; no new engine claim.
- New RECYCLE lane, the 9th rostered lane (`lanes/recycle.mjs`; `LANE_INDEX.RECYCLE` = 11, ROSTER length 9, laneSpan 12). It
  drives stale-handle use after slot recycling with ops `rdisp` / `rsset` / `rsread` / `rsdisp` over a fixed per-world ring of 8
  stale handles. SCENARIOS 52 -> 58 (stale-write-recycled, stale-peek-recycled, stale-read-recycled, stale-dispose-recycled,
  stale-dead-unrecycled, multi-gen; covOff stale-dispose-recycled -> stale-dispose-dead).
- New oracle O9, judged only inside RECYCLE's op handlers, sigs `stale-read` (a stale read / peek returns != undefined),
  `stale-write` (any live signal peek != model, any effect ran, or, maintainer ruling D-b130-1, a live computed the model holds
  CLEAN peeks != model) and `stale-dispose` (activeNodes / activeLinks moved, or a live signal handle reads undefined).
- Census 200 worlds x tree ec6d7156 / headpatched fa2871f0 / rev152 f8dd50f8: 0 failing. Timed calibration recut (QUIET,
  load1 2.58 / baseline 2.21, 1055 s, 2026-10-28T05:51Z); after the B3 r2 `checkCl` fix the committed soak-calibration.json
  was re-cut non-timed with `--import-throughput` of that run (counts identical): RECYCLE 2717 full / 150 smoke worlds, 0
  failing on all 3 kernels; LANE_KERNELS.RECYCLE = headpatched, lite-1.5.2, tree. parity.json FILES 50 -> 51
  (+ lanes/recycle.mjs). REPORTED tier: gates nothing, no speed claim.
- Must-fail controls (5 new): T-RC-setgen, T-RC-readgen, T-RC-dispgen (one-hunk tree mutants of the generation guards: read.set
  Signal.js:2075, sharedSignalPeek :2019, registry dispose(api) :2425; each breaches O9 with its sig), T-cov-RECYCLE (exit 3,
  missing=stale-dispose-recycled) and the pass control P-RC-TREE. _mustfail now lists 71 controls (53 short + 18 long).
  teeth.mjs: universe 68, CHECKS ids 58, GAPS 22, NOT_TEETH 9, UNREACHABLE 5.
- Found on the way: LEDGER #51 (a stale `update(fn)` passes the recycled resident's value to `fn`; OPEN at b129, D-b129-1; FIXED b136, see "### Fixed -- stale update(fn) no longer calls fn" above). Recorded in
  LEDGER #51 (b129); not fixed here. The RECYCLE update op `rsupd` and its control T-RC-updgen landed in b137 (see "soak:
  RECYCLE update op rsupd" above); the lane kernels listed in this entry were narrowed to tree there (D-b137-1).
- Tests: new `test/88` (117 rows); `test/45` 37 tests; `test/54` (b129) CLI hang diagnostic (SIGUSR2 node report with an
  inspector `Debugger.pause` fallback, 120 s ceiling, self-test row with a planted spin and a planted stall). `npm test` 2504
  tests / 2491 pass / 0 fail / 12 skip / 1 todo (node v26.8.2).
- `owner.mjs` cleanup counts now fail closed (`checkCl`: an integer in 0..CL_MAX = 3) instead of `| 0` (FILLER 55);
  `test/87` 48 -> 49 tests (malformed-cl row).

### Tests / Docs -- soak: OWNER lane + OW oracle (R3, b124-b127)

Dev-only (`bench/soak/`, not shipped). No engine change in this rung: Signal.js is the tree kernel sha256/8 ec6d7156
(LEDGER #48, 699b9ef); no new engine claim.
- New OWNER lane, the 8th rostered lane (`lanes/owner.mjs`; `LANE_INDEX.OWNER` = 7, ROSTER length 8). It drives `createRoot` /
  `runWithOwner` / `getOwner` / `onCleanup` ownership with ops `osent` / `oarm` / `orwo` / `oroot` / `odisp` / `opull`.
- New oracle family OW (registered last in ORACLES), sigs `cleanup-order` (FIFO within an owner; every descendant's cleanups
  before its ancestor's; siblings unordered) and `callback-this` (lane callbacks run with `this === undefined`). The cleanup
  COUNT is judged by the sentinel (O1e / O4 / O2); teardown is judged by O5 only.
- Calibrated on the tree kernel only (maintainer ruling D-b124-1). New divergence DIV-48 (kind fix) records the frozen
  controls (headpatched, rev152) running multi-cleanups with `this` = the cleanup array; the tree fixed it in LEDGER #48.
- Timed calibration recut (b126): quiet-lock `run --strict` exit 0, QUIET at launch (load1 3.11, baseline 2.21; load1 7.71
  at the end), 2026-10-28, 1043 s wall (`seconds` in soak-calibration.json), engine ec6d7156,
  Node v26.8.2, Apple M4 Pro, one run. REPORTED tier: it gates nothing and makes no speed claim.
- Must-fail controls (8 new): T-owner-cascade, T-owner-cleanup, T-owner-fifo, T-owner-outin, T-owner-this (tree mutants), the
  pass control P-OWNER-TREE, T-cov-OWNER and P-OWNER-HP (cov-off, exit 3). _mustfail now lists 66 controls (48 short + 18 long).
  teeth.mjs: universe 63, CHECKS ids 53, GAPS 22, NOT_TEETH 8, UNREACHABLE 5.
- Tests: new test/87-soak-owner.test.mjs (48 tests); test/44 DIV-48 rows; test/45 36 tests (teeth q).
- Evidence (REPORTED, no timing claim): OWNER 11 x 100000 on the tree kernel, exit 0, 2706 worlds, 0 failing, all 11 cycle
  boundaries trackerSize 0 / weakAlive 0; host PRELIMINARY (load1 6.39).
- Open FILLER F-OW-TEARDOWN: a `close()` that skips every cleanup is unseen today (teardown is O5-only, the sentinel is silent).

### Tests / Docs -- soak: LIFECYCLE lane + O7 (R2, b110-b112)

Dev-only (`bench/soak/`, not shipped). At b110-b112 `Signal.js` was unchanged (sha256/8 0f75866f) and no engine claim was made; the A5a / A5b entries above change it (sha256/8 2f7974f3).
- New LIFECYCLE lane, the 7th rostered lane (appended last in `lanes/index.mjs` ROSTER; `LANE_INDEX.LIFECYCLE` = 5, HOOK = 6).
  It drives `observeObservers` `onConnect` / `onDisconnect` registrations (ops `lreg` / `loff`, several registrations per
  handle, callbacks that dispose, register, unregister and write) over a GRAPH-vocabulary world with no batch.
- Oracles: the new O7 (phase model, five sigs: `spurious-connect`, `missed-disconnect`,
  `stale-off`, `spurious-disconnect`, `missed-connect`; checked at each fire and at rest),
  run after the existing O7a (fire time, `dead-registration-fire`).
- Generator shapes: L7a (a callback disposes the walk's next source), L7c (a retrack trim whose first `onDisconnect` disposes the
  trim's next link; the one shape whose effect body is not a GRAPH kind: a try-mode `outer` body switched to early exit) and
  L8c (a mirror pair of registrations that off each other).
  No lifecycle callback throws in this rung (a follow-up, R2b, owns throwing callbacks).
- Calibrated on the tree kernel only; LIFECYCLE was exempt in test/41 while DIV-D3 stayed open (the exemption ended with A5a, see the b117-b118 bullet below).
- Divergences: DIV-D3-independent-registrations is now matched on LIFECYCLE; by maintainer ruling (b112) DIV-F7's `fixedIn`
  is set to 0v-#40 (73d6a90) and DIV-F8's to A1.4 (fc1f826): the soak registry's record of the rung after which the tree no
  longer shows the shape; the A1 repair's own entry still waits for its campaign (intro above).
- Must-fail controls (as of b119; the b111 set was L-LC-preb33, P-LC-TRIGGERLESS, T-LC-dupconn, T-LC-dupdisc, T-LC-dropconn,
  T-LC-dropdisc, T-LC-offgen): L-LC-preb33, the pass control P-LC-tree, T-cov-LIFECYCLE, and the seven T-LC-* tree mutants listed below.
- `soak:parity` pinned 47 files at b111 (+ `lanes/lifecycle.mjs`, `adapters/contract.mjs`) and pins 49 now (+ `controls/prea5/Signal.js`, `Watch.js`; counted from parity.json `files`). The timed calibration recut (b111; one
  run, 2026-10-25, Node v26.8.2, Apple M4 Pro, quiet-lock) took 998 s wall (`seconds` 997 in soak-calibration.json); launched
  QUIET (load1 3.06, baseline 2.21), load1 6.67 at the end. REPORTED tier: it gates nothing and makes no speed claim.
- b117-b118 (A5 follow-ups; dev-only): the LIFECYCLE exemption in test/41 B6 (f) ended with DIV-D3 (exemption set is now
  `{ERROR: [DIV-F22]}`): LIFECYCLE needs full-length tree evidence. divergences.json DIV-D3 `fixedIn` A5a and DIV-F9 `fixedIn` A5b: on the
  tree both now classify null (a regression); the named control kernels still explain them. Frozen control kernel
  `controls/prea5` (767f808, Signal.js 0f75866f) is the fifth control in controls.json. `lifecycle.mjs` `cbOf` fails closed
  (`exec: unmodelled lifecycle op: fire ...`) for a fire of a registration LcState never recorded. New generator arm `lself` (a callback
  that offs itself, or its next sibling), which makes the one-line T-LC-iter mutant (off() clears `reg.next`) reachable. exec.mjs: the
  at-rest O7 counts once per checked registration (was once per op), and a fail raised inside `close()` at teardown is kept as a
  `teardown` failure (before, the reset after close() wiped it).
- b117-b118 must-fail rows: P-LC-TRIGGERLESS is renamed T-cov-LIFECYCLE; new pass control P-LC-tree (the full tree lane, exit 0);
  the T-LC-* rows run P-LC-tree's shape (no `cov-off:lc-two-regs`). T-LC-* now has seven tree mutants: T-LC-dupconn, T-LC-dupdisc,
  T-LC-dropconn, T-LC-dropdisc, T-LC-offlive (off() without its `!reg.live` guard; replaced T-LC-offgen, whose #40 gen-stamp mutant is
  equivalent and is now teeth.mjs UNREACHABLE `lc-off-gen-stamp`), T-LC-merge and T-LC-iter (D-b117-2: first a planned gap, a control
  since b118). Also new: T-A5b (prea5, HOOK smoke, explained DIV-F9) and P-HOOK-TREE (tree, HOOK, PASS); test/75 "A3 HOOK on tree" is
  a pass row since A5b. teeth GAPS: 23 at b116 -> 22 net (+T-LC-iter then -T-LC-iter, -T-A5b); CHECKS ids stay 47; _mustfail controls 58
  (40 short, 18 long); test/45 35 tests (31 at b118, +4 with b119 B5). Counts recomputed from teeth.mjs / _mustfail.mjs as of this entry.
- Soak teeth (b119 B5, A6 follow-ups): L-WRAP-TREE now asserts W2 PASS on the tree (`expect.extra.pass` `['W2']`);
  `wrapJudge` needs >= 1 W2 wrap record, each status PASS, and no BREACH line naming check=W2, else a MISS. `validSpec` allows
  `extra.pass` only on wrap controls and refuses base prefixr outside run wrap. teeth.mjs `audit()` refuses an orphan control
  (`orphan control: <name>`): every _mustfail control is under a CHECKS id or in the new NOT_TEETH allowlist (7 pass / report-only
  controls). P-HOOK-TREE-COVOFF joins CHECKS cause:scenario.
- Measured (REPORTED tier; gates nothing). `npm test`, 2026-10-26 08:01, node v26.8.2, load1 3.17 at launch, untimed: 2295 tests,
  2283 pass, 0 fail, 11 skip, 1 todo (`.handoff/b119-evidence/start/npmtest.log`). Timed calibration recut (one run, node v26.8.2, 12 cores, quiet-lock), 2026-10-26 07:17-07:34, engine
  2f7974f3, exit 0, 1003 s (cut 551 s), launched QUIET (load1 2.45, baseline 2.21); one earlier attempt was refused NOISY (exit 76) and is
  not counted (`.handoff/b118-evidence/recut/recut.log`).
Plan and evidence: `.handoff/PLAN-R2-lifecycle.md` (addenda A1-A4, AD5-AD9); `audit/2026-10-07/verification/SPEC-B.md`
addendum 13.

### Tests / Docs -- LEDGER #43 closed, not an engine bug (b107)

The b101 finding F-b101-1 ("restore re-runs an effect once more than live") was a harness error, not an engine defect: the probe and
test/76's restored `fnsById` bodies called the LIVE registry's `untrack`, which is per-registry, so the restored effect tracked the
read (one extra link; `snapshot()` records it). With the restored registry's `untrack`, run logs and full snapshots equal live after
every write. `Signal.js` is unchanged (sha256/8 0628127b). test/76: the former KNOWN row is now a regression row (restored == live) plus
a cross-registry row (a foreign `untrack` tracks in live and in the restored graph alike). Docs: `llms.txt` and `Signal.d.ts` (JSDoc
only) now say that `fnsById` bodies must call the restored registry's `untrack` / `batch` / `createRoot` / `runWithOwner`. Evidence:
`.handoff/b107-evidence/L43/`.

### Added -- `snapshot()` / `restore()` and FLAG_BOX (bit 7)

`snapshot()` serializes the live graph of a registry to a plain `{ v: 1, gv, nextId, nodes: [...] }` object (one record per live
node: id, kind, flags, value, version, evalVersion, markEpoch, clean, ownerId, ownerPos, deps, subPos); `restore(snap, opts?)` rebuilds it into a FRESH registry
and returns that registry. Both exist top-level (default registry) and per-registry. Types: `Snapshot`,
`SnapshotNode`, `SnapshotNodeKind`, `RestoreOptions` (`fnsById`, `handles`, `config`). Values move by reference
(in-process; no structured clone). Cold paths only: no change to the read / write / flush hot bodies.
- Restore behavior: it rebuilds nodes and links without running any body, keeps the snapshot ids (a re-snapshot
  round-trips), and does not re-fire effects (an effect runs only on the next dependency change). Computeds and
  effects get their body from `opts.fnsById[id]`; a missing one throws `restore: missing fn for id <id>`. A
  computed restores as follows. A dirty computed restores with its recorded deps, value, version, error bit, evalVersion and markEpoch, so a read pulls it exactly as live does: the pull walks its deps and runs the body only if a dep moved past its evalVersion (otherwise the seeded value is a cache hit); when the body runs, a result equal to the seeded value (under Object.is -- a custom `equals` is not captured, so a computed built with one may propagate after restore where the live graph would not) does not propagate. A never-evaluated computed (version 0) is not seeded; its body runs on its first read. A clean
  one restores with its cached value and deps. After restore, the rebuilt graph runs each effect with the same sequence of values, and leaves every node with the same value or error and the same subscriber / owner order, as the live graph would from the same point; this is a gated property (the seeded live fuzz in test/76: 400 graphs x 3 seeds in `npm test`, 4000 x 5 seeds at the A9 close), not a universal law. Limits: cleanup callbacks (`onCleanup`) and a custom `equals` / scheduler are NOT captured, so an effect that registered a cleanup before `snapshot()` has none until its next run (the ORDER of pre-snapshot cleanups is therefore not reproduced); restore copies live state, so it reproduces live as it is now: LEDGER #38 (F6), #41 and #42 are fixed in 1.6.0-dev (FIX-T, "### Fixed -- engine: error semantics" below), so a restored graph's dependency pre-walk no longer rethrows a cached error either, leaving an error state is a change in it too, and a restored dep cycle throws CycleError. A malformed snapshot, a duplicate id, a dangling dep id (on any
  record, dirty and never-read computeds included) or owner id all throw before the registry is returned.
- Input law: restore() validates the whole snapshot before building anything: ids must be positive integers <= 0x3FFFFFFF (2^30 - 1) and unique; dep ids and ownerIds must be positive integers <= 0x3FFFFFFF that resolve to a record id; versions and flags must be int32; the snapshot's `gv`, `nextId` and every record's `evalVersion` / `markEpoch` are required and must be int32 (a missing or non-int32 one throws a TypeError before anything is built); `gv` is never 0, `nextId` may be any 32-bit integer, even at or below a restored id (live's counter wraps), and restore continues ids from it exactly, an effect's `evalVersion` is never 0, a signal's `evalVersion` and `markEpoch` are 0, `clean` must equal (`evalVersion !== 0` and `markEpoch` not modularly ahead of `evalVersion`), and a computed has `evalVersion` 0 exactly when its `version` is 0 (negative stamps after an int32 wrap and any stamp-vs-`gv` order are NOT refused: live reaches them); a signal is never owned; deps must be an array; a null / non-object record throws a named TypeError. Snapshots carry live node ids, so a snapshot holding any node id past 0x3FFFFFFF (a node created after the registry's first 2^30 - 1, including in a registry restored at the cap that then grew) snapshots fine but restore() refuses it -- fail closed, by design (D-F); once those nodes are disposed, a NEW snapshot of that registry restores again (the old snapshot still holds the id and stays refused). Options must be a plain object with own keys fnsById / handles / config only -- an unknown key throws with a did-you-mean hint; bodies are looked up only as own properties of fnsById. Rejected structures: a signal with deps, an effect as a dep source, a signal as owner, a self owner, owner cycles, and a dep id missing from the snapshot on any record (dirty and never-read computeds included). opts.handles is filled only after the rebuild succeeds; a failed restore leaves it untouched. A snapshot taken after a registry's node-id counter wrapped (ids <= 0) is rejected (fail closed). A dep cycle among clean computeds is NOT refused: live can emit one (a computed whose body catches a CycleError from a partner), and the restored graph reproduces live exactly, including live's own CycleError ("CycleError: Circular dependency detected.") on the next read after a write to a dep (LEDGER #42, fixed in FIX-T; residual: a pool larger than the pre-walk stack limit still overflows the stack with a RangeError first).
- D-L / D-M / D-O -- clock, next id and stamps: the snapshot gains `gv` (the registry clock) and `nextId` (the next node id),
  and every record gains `evalVersion` and `markEpoch` (int32 numbers). All four are required (a missing or non-int32 one
  throws a TypeError before anything is built; `v: 1` is unchanged, the format is unshipped). restore() sets the clock to `gv`
  and the next id to `nextId` exactly, and copies each computed's and effect's `evalVersion` / `markEpoch`; a seeded dirty
  computed copies its recorded stamps too (it no longer restores with `evalVersion` 0 behind a one-shot body wrapper).
  Relations refused: `gv` 0; an effect `evalVersion` 0; a signal `evalVersion` or `markEpoch` not 0; `clean` inconsistent with
  (`evalVersion !== 0` and `markEpoch` not modularly ahead of `evalVersion`); a computed whose `evalVersion` 0-ness differs
  from its `version` 0-ness. Negative stamps after an int32 wrap and any stamp-vs-`gv` order are not refused (live reaches
  them). The snapshot records the registry clock (`gv`), the next node id (`nextId`) and every node's `evalVersion` / `markEpoch`, and restore copies them (the clock and next id exactly), so every freshness check in a restored graph answers as live's does (within the limits above): a restored effect no longer re-fires where live would not, and one that absorbed its own write is still due its re-run. The LIVE 2^31 dormancy band (the 32-bit version wrap) is unchanged and a restore reproduces it; the old restore-only wrap re-fire is gone.
- D-N -- restore() no longer refuses a dep cycle among clean computeds: live can emit one (a computed whose body catches a
  CycleError from a partner), so the old refusal rejected a snapshot live itself produced. The restored graph reproduces live
  exactly, including live's behavior since FIX-T: the next read after a write to a dep throws CycleError ("CycleError:
  Circular dependency detected.") in live and in the restored graph alike (LEDGER #42, fixed; residual: a pool larger than the
  pre-walk stack limit still overflows the stack with a RangeError first).
- D-A -- FLAG_BOX: `signalBox` / `computedBox` nodes now carry bit 7 (128) in their node flags, so the
  `onGraphMutation` op 1 (node-create) and op 2 (node-dispose) flags for them are 160 (signalBox) and 129
  (computedBox); callable signal / computed / effect stay 32 / 1 / 2. A listener that matched box flags as 32 / 1
  must accept 160 / 129.
- D-B -- `snapshot()` throws `[lite-signal] snapshot: graph not settled` while a flush is running, inside a batch,
  or while ANY body is running -- including a body under `untrack()`, `createRoot()` or `runWithOwner()` -- and (D-B2) inside an `onCleanup` during a dispose or its owner cascade (`destroy()` runs no cleanups) with `(dispose in progress)`, inside an `onGraphMutation` listener with `(onGraphMutation listener running)`, and (D-D2) while any effect has a pending scheduled run (queued, or its first scheduled run not yet executed) with `(scheduled effect run pending)`, so no pending run is lost silently.
- D-C -- `restore()` without `opts.config` sizes the fresh registry `maxNodes = max(1.5N + 16, 1024)` and
  `maxLinks = max(1.5L + 16, 4 x maxNodes)` (N nodes, L dep edges in the snapshot). The source registry's
  `onCapacityExceeded` and `maxFlushPasses` are not carried; pass `opts.config` to set them (an explicit
  config wins outright).
- D-D -- not captured: custom `equals` (a restored signal or computed uses `Object.is`), effect schedulers (a restored effect
  runs synchronously unless re-created with a scheduler), `onCleanup` registrations, and lifecycle /
  `onGraphMutation` listeners.
- Tests: `test/76-snapshot.test.mjs`.
- D-J -- `subPos` + `ownerPos`: every `snapshot()` record gains `subPos: number[]` (parallel to `deps`; `subPos[j]` is dep
  link j's position in its source's subscriber list; `[]` for a signal) and `ownerPos: number` (position in the owner's
  child list, 0 = newest child, the one `forEachOwned` visits first; `-1` when `ownerId` is null). Both are REQUIRED:
  a snapshot without `subPos` / `ownerPos` is refused. `restore()` validates both before building anything (TypeError,
  `[lite-signal] restore:` prefix): `subPos` missing, not an array, length != `deps.length`, an element not an int >= 0,
  or per source not a permutation of 0..n-1; `ownerPos` missing, not an int >= -1, not `-1` exactly when `ownerId` is
  null, `-1` on an owned record, or per owner not a permutation of 0..n-1. It then places every subscriber link at its
  recorded position and each owner's children in recorded order, so each source's subscriber order and each owner's
  child order round-trip. Fixed with it: a duplicate read (`[s, C, s]`) is kept (restore dropped the second link), and a
  child created into a reused pool slot is restored in the right owner-child position (it was restored in the wrong
  order). Cleanup callbacks are still not captured. `v: 1` is unchanged (the format is unshipped).

### Changed -- soak latency lane refuses an unreadable parameter list (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); bench/soak/latency.mjs (re-pinned in parity.json, still 40
files), test/71, test/46, and comment-only changes in bench/soak/_mustfail.mjs and teeth.mjs.
Closing run (quiet-lock, Node v26.8.2, 1-min load 3.12-3.19, 2.22 after): npm run verify exit 0; npm test 1860 / 1846
pass / 0 fail / 7 skip / 7 todo; torture GATE ok (alloc=0 B/op, retention=0/966); soak:parity OK 40.
- arm()'s paramsHidden() now accepts a world method only when its parameter-list head (the source up to the first
  `)` or `=>`) holds nothing but identifier characters, whitespace, `,`, `(`, `{`, `}`, `:` (SAFE_HEAD). Any other
  character refuses it as "a rest, default or unreadable parameter list (...)": a computed or string key (whose `)`
  can precede the list's own `)`), a comment, a default `=`, a rest `...`. Fail-closed by construction: array-
  destructure parameters and generators are refused too (no adapter uses them). The 15 lite adapter world methods
  are all still accepted. Cold path only: arm(), once per armed open per new function, never per timed call.
- test/71 29 -> 36: 5 refusal rows (computed key, comment, no-space `async[k]`, string key `')'`, computed key in
  a destructuring parameter), each red on the earlier patch or the base, plus 2 over-refusal guards.
  test/46 249 -> 250: an UPPER-case `<SHA7>-<SHA7>` pair dir row for the M3 tree twin (fails with
  inPairDir's toLowerCase() removed).

### Changed -- soak must-fail control T-flushdrop; retired torture scenarios graph-fuzzer and torture-soak (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); bench/soak/_mustfail.mjs, teeth.mjs, test/45, and
bench/torture (run.mjs, MANIFEST.txt, README.md, two scenario files deleted), bench/package.json, bench/README.md,
README.md (two runnable command lines). No PARITY_FILES or calibration-pinned file touched (no re-pin, no recut).
Closing run (quiet-lock, Node v26.8.2, 1-min load 1.31-2.66): npm run verify exit 0; npm test 1852 / 1838 pass /
0 fail / 7 skip / 7 todo; torture GATE ok (alloc=0 B/op, retention=0/966); soak:parity OK 40.
- T-flushdrop (new control, 41st; headpatched GRAPH --smoke): a patch at the flushEffects inner loop skips every 64th
  flushed effect (FLAG_QUEUED cleared, one-off drop). Expected exit 1 with O4 GRAPH effect-dead + O1 GRAPH
  effect-stale; red 3/3 with identical heads, about 2 s. The revert, a never-drop patch and a drop-then-execute patch
  all MISS. Limit: the drop counter is process-global, so the O1 head depends on flush phase; a GRAPH op-mix change
  may drop it and the control then MISSes (fails loud, never a silent pass).
- Retirement: run.mjs SCENARIOS 26 -> 24; graph-fuzzer.mjs and torture-soak.mjs deleted (absorbed by the bench/soak
  GRAPH lane; the MANIFEST RETIRED block records the absorbed-by map and `git show 1dea069:` blobs 8c4b5f8f /
  f8494263). The control went in first so the GRAPH lane's coverage was proven before the deletion.
- Accepted loss: single-registry aging (the long one-registry run torture-soak did), see the MANIFEST RETIRED block.
- Coverage note: scheduler-bench's high-water witness is NOT mutant-proven against deferred-sever (a sever mutant
  does not trip it: links 7823 / 13008); the deferred-sever mutant was run on torture-soak. Coverage of deferred
  sever now rests on soak T-sever / O5.

### Added -- soak:report --html / --baseline and an every-cycle rss check (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); bench/soak/SoakReport.mjs, anatomy.mjs, baseline.mjs
(comments), latency.mjs, main.mjs, report-html.mjs, parity.mjs / parity.json, plus test/46, 50, 71, 72.
Closing run (quiet-lock, Node v26.8.2, 1-min load 4.71-2.02, noisy host): npm run verify exit 0; npm test 1851 /
1837 pass / 0 fail / 7 skip / 7 todo; torture GATE ok (alloc=0 B/op, retention=0/966); soak:parity OK 40.
- soak:report <stream> [--html <out>] [--baseline <stream>]: --html writes a self-contained page for every outcome
  (a write error is CONFIG, exit 2). --baseline judges the base stream only when the head is consistent; an
  inconsistent base is REFUSED and an incomparable pair INCOMPATIBLE (both exit 2); the
  exit is max(head, baseline). On a short stream (OPS_MIN) the baseline line reads NOTE (p99-unmeasured per latency
  class), not PASS. The baseline thresholds (+2 MB late heap, -15% throughput, +25% p99) live in baseline.mjs and
  are REPORTED-tier: unverified against a real same-code release pair.
- New INTEGRITY checks: every-cycle rss values (warm-up included; samples === ceil(worlds / stride), stride re-derived
  by the exported rssStride), an anatomy.worlds upper bound, and the tree twin of M3 (`<sha7>-<sha7>` dir).
- report-html: a markDedupe sparkline. The latency lane rejects world methods with a rest or default parameter
  (Function.length hides them); openAnatomy ignores an inherited `source`, and an rmSync failure is an UNAVAILABLE lane.
- Parity pins 38 -> 40 (main, SoakReport, latency, anatomy re-pinned; report-html and baseline added). npm test
  +33 (1818 -> 1851); no-flag SoakReport output is byte-identical to HEAD on 8 streams.

### Added -- soak T-mark must-fail control and the NOTE spec kind (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); bench/soak/_mustfail.mjs, config.mjs, main.mjs, teeth.mjs,
parity.json, plus test/45 and the new test/73.
Closing run (quiet-lock, Node v26.8.2, 1-min load 2.71-2.67, noisy host): npm run verify exit 0; npm test 1818 /
1804 pass / 0 fail / 7 skip / 7 todo; torture GATE ok (alloc=0 B/op, retention=0/966); soak:parity OK 38.
- T-mark (new control, 40th; base tree, GRAPH --smoke): two patches on the live markDownstream turn the markEpoch
  dedupe off. The shape lane's markDedupe reads 1.000 on the mutant against 0.880-0.918 on the head (3 smoke
  cycles each); the control is judged by a NOTE spec (`shape[GRAPH] markDedupe>=`), not a BREACH.
- NOTE spec kind: main.mjs prints a report-only `soak: NOTE -- shape[<LANE>] markDedupe=<x.xxx|null> cycle=<c>
  worlds=<n>` line per non-null anatomy cycle; _mustfail judges a NOTE spec over every selected line, with the count
  equal to the lane's cycle records. config.mjs MARK_DEDUPE_NOTE = 0.99 (in the stream header gates block).
  teeth GAPS 24 -> 23.
- test/73 (9 tests): head GRAPH markDedupe 0.873 (71529 stamps / 81913 edges) < 0.99; the control's patches 1.000;
  a patches [] control must-fail.
- Parity pins stay 38 (main.mjs and config.mjs re-pinned only).

### Added -- soak report-only anatomy lane (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); bench/soak/anatomy.mjs (new), adapters/lite.mjs,
SoakReport.mjs, gates.mjs, main.mjs, parity.mjs / parity.json, calibration/soak-calibration.json (recut), plus test/40,
42, 46 and the new test/72.
Closing run (quiet-lock, Node v26.8.2, 1-min load 4.84-3.05, noisy host): npm run verify exit 0; npm test 1809 /
1795 pass / 0 fail / 7 skip / 7 todo; torture GATE ok (alloc=0 B/op, retention=0/966); soak:parity OK 38.
- anatomy.mjs: the resolved kernel instrumented with harness/visit-anchors into a temp copy; shape worlds
  (w % 16 = 0) are re-run on that shadow engine. Cycle key `anatomy` {worlds, counts, markDedupe} | null, validated
  by SoakReport. A divergent, overflowed or unavailable shadow gives null plus a NOTE, never 0. openAnatomy never
  throws for an unavailable lane (a foreign __VISIT__ or a sha mismatch is refused). adapters/lite.mjs gains
  liteAdapterFor(kernel).
- Transparency: per-cycle worlds..weakAlive deepStrictEqual to before, 15/15 cycles, default and SOAK_SEED=1.
  opsPerSec before -> after (REPORTED, PRELIMINARY, one run each): GRAPH -4.2..-5.0%, BATCH -4.4..-5.4%, ERROR
  -2.1..-11.1%, NEST -5.4..-5.9%, WIE -4.2..-6.1% (the shadow re-run of 1 world in 16).
- Calibration recut (adapters/lite.mjs pin only; every deterministic count identical); throughput is imported from
  the 2026-10-19 timed run and the kernels' throughput reads PENDING. Parity pins 36 -> 38. npm test +32
  (1777 -> 1809).

### Added -- soak report-only latency lane; devDependency @zakkster/lite-sketch 1.2.0 (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); bench/soak/latency.mjs (new), config.mjs, gates.mjs,
main.mjs, SoakReport.mjs, parity.mjs / parity.json, package.json (devDependencies), package-lock.json, plus test/40,
42, 46 and the new test/71. package.json `dependencies` stays empty; bench/ is not in files[].
Closing run (quiet-lock, Node v26.8.2, 1-min load 3.25-4.82, noisy host): npm run verify exit 0; npm test 1777 /
1763 pass / 0 fail / 7 skip / 7 todo; torture GATE ok (alloc=0 B/op, retention=0/966); soak:parity OK 36.
- package.json devDependencies += "@zakkster/lite-sketch": "1.2.0" (exact); the lockfile diff is the lite-sketch
  entries only. A missing or wrong-version lite-sketch exits 2 (CONFIG) before any record is written.
- latency.mjs: one DDSketch (alpha 0.01) per world method, armed on worlds w % 16 = 8, returning calls only; cycle key
  `latency` {n, p50Ns, p99Ns, belowFloor} per method, validated by SoakReport; a 0 or NaN quantile is null. An
  unclassified function key or a method with length > 2 is a TypeError (fail closed). Report-only, gates nothing.
- config.mjs SKETCH_ALPHA 0.01, LATENCY_METHODS (12), LATENCY_UNTIMED (3) enter the stream header gates block, so a
  pre-b85 stream is refused by the new SoakReport (gates-block mismatch; expected). Parity pins 35 -> 36.
- npm test +29 (1748 -> 1777): test/71 17 (64-seed transparency over GRAPH / BATCH / ERROR / NEST; GC slope
  -0.0000622 B/op against a 32.0 B/op transient control), test/46 12.

### Added -- soak teeth: L-NW-hp-zero, the end-to-end NEARWRAP control (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); bench/soak/_mustfail.mjs, teeth.mjs, plus test/45 and
test/48. No PARITY_FILES or calibration-pinned file touched (no re-pin, no recut).
Closing run (quiet-lock, Node v26.8.2, 1-min load 2.76-2.46): npm run verify exit 0; npm test 1748 / 1734 pass /
0 fail / 7 skip / 7 todo; torture GATE ok (alloc=0 B/op, retention=0/966).
- L-NW-hp-zero (new long control, 39th; headpatched + SOAK_NEARWRAP=zero:8, GRAPH x 11 at 20000 ops): the first
  end-to-end NEARWRAP tooth and a second lane:GRAPH control (teeth CHECKS lane:GRAPH = [T-sever, L-NW-hp-zero]).
  headpatched's globalVersion bump has no 0-skip (F29), so globalVersion reaches 0 and O1 / O2 / O4 fire: exit 1,
  4 known=none GRAPH heads (O1 computed-mismatch, O1 effect-stale, O2 glitch, O4 effect-dead), 2/2. With the 0-skip
  patched in, the same run is clean (exit 0, 0 BREACH). The spec is keyed on `oracle=O1 lane=GRAPH`, not known= / sig=.
- teeth.mjs: T-A3b / T-A7a / T-A7b note NEARWRAP; totals-e2e no longer waits on NEARWRAP.
- test/45 "teeth n" (+1) and test/48 literal counter-rewrite pins (+1): npm test +2 (1746 -> 1748).
- A drafted second control, L-NW-rebase (clampSweep no-op'd, sign:8), was NOT red (0/3) and was dropped.

### Fixed -- soak:report accepts a NEARWRAP kernel only on verified sha256 (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); bench/soak/SoakReport.mjs only (checkNearwrapKernel,
checkHeader), plus test/46.
- Before: a SOAK_KERNEL + SOAK_NEARWRAP stream failed `INTEGRITY -- control` (the derived
  bench/soak/out/nearwrap/<d7>-<w7>/ kernel is not the SOAK_KERNEL value), so it never reached
  `NOT A RELEASE SOAK -- nearwrap` -- unless that value was a bare `Signal.js` (`./Signal.js`, `../Signal.js`): the
  suffix fallback matched every derived path and the base was never hashed.
- Now (every NEARWRAP stream): derivedSha256 must equal kernel.files[0].sha256, and the kernel files must be the
  derived pair <d7>-<w7>/{Signal,Watch}.js. On an override, additionally: the SOAK_KERNEL file and its sibling
  Watch.js are re-hashed on the reporting host -- baseSha256 must equal the base's sha256 (of its utf8 text, as
  nearwrap.mjs records it) and kernel.files[1].sha256 the sibling Watch.js (the derived Watch.js is a byte copy); a
  base or sibling Watch.js that does not resolve, or is not a regular file, is refused (fail closed). Each failure
  is its own `INTEGRITY -- control` message.
- Residual: derive(base) is never re-run, so the derived pair is self-reported; a TREE NEARWRAP run's baseSha256 and
  derived Watch.js sha256 are self-reported. Harmless: a nearwrap stream is always refused.
- Measured (1 run, quiet-lock, load 2.93 -> 2.77, 7 s): the b82 D-B8 spawn (headpatched scratch kernel +
  SOAK_NEARWRAP=zero:8, GRAPH x 11) now reports `NOT A RELEASE SOAK -- nearwrap: zero:8` (was INTEGRITY), verdict
  FAIL (consistent) from 4 known=none GRAPH BREACHes (O1 computed-mismatch, O1 effect-stale, O2 glitch, O4
  effect-dead).
- SoakReport.mjs is parity-pinned: parity.json re-pinned (35 files, SoakReport line only); not calibration-PINNED,
  no recut. test/46 200 -> 210 tests (+10): the honest SOAK_KERNEL + NEARWRAP stream; 7 must-fail rows (M1, M2,
  M4-M7, M9: one per new check, the unresolvable one three ways -- missing, FIFO base, FIFO sibling Watch.js); M3,
  the plain override rule on the derived path (green on HEAD by design); M8, an honest non-UTF-8 base that must be
  accepted (red on the raw-byte hash). Two older rows retargeted.

### Changed -- soak teeth: L-T-graveyard, L-T-rss sized (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); the must-fail battery only (bench/soak/_mustfail.mjs,
teeth.mjs, test/45); no parity-pinned or calibration-pinned file touched.
Closing run (quiet-lock, Node v26.8.2, 1-min load 1.85-2.75): npm run verify exit 0; npm test 1736 / 1722 pass /
0 fail / 7 skip / 7 todo; torture GATE ok (alloc=0 B/op, retention=0/966).
- L-T-graveyard (new control, 38th; headpatched GRAPH 11 x DEFAULT_OPS): freeLink keeps released links in a global
  graveyard instead of the free list (activeLinks still decremented). It is gate:heap's second tooth
  (teeth.mjs CHECKS gate:heap = [L-T-leak, L-T-graveyard]). Measured, 1 run: exit 1, gate=heap lane=GRAPH, early
  33.981 / late 64.837 MB vs limit 39.379 MB = 1.65x; the rss gate passed in that run. Not every release goes through
  that push: the disposeNodeInner sub-walk recycles about 1% inline (probe: 770 of 71917).
- L-T-rss starts late: no retention through registry (WARMUP_CYCLES + GATE_N) x RSS_WORLDS_CEIL 240 = 1440, then it
  retains Buffer.allocUnsafeSlow(1572864) (1.5 MB) per registry. Measured, 1 run each: 1.5 MB tripped gate=heap
  then gate=rss, band 544.969 MB, late 1775.813 MB vs limit 969.696 MB = 1.83x; a 512 KB size MISSed (late 911.438
  vs limit 953.017 MB = 0.96x).
- test/45 +2 (25 tests): the graveyard kernel equals the base with exactly the freeLink push replaced; L-T-rss
  window bounds, one patch, buffer >= 1.5 MB.
- Honest-control check: 12 controls OK / 0 MISS, and no gate=rss line in any child stream. RssSampler: 1e6 pushes,
  stored count max 255, 0 B/op.

### Changed -- soak hard `rss` drift gate (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); soak harness only, no calibration-pinned file touched
(no recut).
Closing run (quiet-lock, Node v26.8.2, load 2.8-9.3 shared host): npm test 1734 / 1720 pass / 0 fail / 7 skip /
7 todo; torture GATE ok (alloc=0 B/op, retention=0/966). npm run verify was PENDING at that commit.
- Rule (gates.mjs rssRule :207): FAIL when !(late <= limit), limit = band x RSS_RATIO 1.75 + RSS_SLACK_MB 16
  (config.mjs :83-84), so NaN fails closed. Kind fail, teeth L-T-rss (gates.mjs :361).
- Window (gates.mjs rssWindows :480): band = median of the first GATE_N post-warm-up per-cycle rss.p95MB values;
  late = p95 of the last min(max(1, floor(post / 4)), RSS_BUF) post-warm-up cycles. Below 2 x GATE_N post cycles the
  gate is INCONCLUSIVE (cause post-cycles, shared with heap); a smoke run is SMOKE.
- Output: BREACH line `soak: BREACH gate=rss lane=<L> detail=late=...MB > limit=...MB (band=...)` (main.mjs :330);
  drift.rss {band, late, limit, status} beside drift.heap (gates.mjs :634). LaneGates reads rec.rss once; a
  non-finite or negative p95MB throws GateInputError (gates.mjs :559-561); warm-up cycles' rss is not read (:555).
- New cycle key `rss` {samples, p95MB, maxMB, stride}, between memory and boundary: one RssSampler per run, reset
  per lane-cycle, fed process.memoryUsage.rss() at every world end (main.mjs :14-16, :363). config.mjs RSS_BUF 256
  (the sampler capacity and the late-window cap); SCHEMA_VERSION stays 2.
- SoakReport key tables know `rss` (SoakReport.mjs :121, :131): an older SoakReport refuses a stream carrying it
  (unknown-key "rss"; SoakReport.mjs :191).
- parity.json pins 35 files (+ bench/soak/rss.mjs); L-T-rss is the new teeth control (CHECKS gate:rss).
- Review: r1 REJECTED (test-only), r2 APPROVED; 400-lane seeded oracle 0 mismatches.

### Changed -- soak calibrate.mjs D7 at cut time; FAIL_CAP census (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); bench/soak/calibration/calibrate.mjs (a cold tool: not
parity-pinned, not calibration-PINNED, so no recut) and one new test only.
Closing run (quiet-lock, Node v26.8.2, load 1.89 -> 7.37): npm test 1727 / 1713 pass / 0 fail / 7 skip / 7 todo;
torture GATE ok (alloc=0 B/op, k=0B/batch,0B/batch K=1,1, retention=0/966).
- calibrate.mjs `--write`: for a lane-only kernel (tree) the cut now dies before writing unless the new pure export
  laneOnlyProblems(k, res, parity) is empty -- test/41's D7 rule at cut time: res.kernel is kernelPath(k), the files
  are exactly [Signal.js, Watch.js] of that kernel, and each sha256 is a string equal to an OWN parity.json entry
  (null is not a sha). Before, a sha-less entry for an unlisted path, a wrong kernel, and extra / missing / reordered
  files passed, as did a string files (for-of walked its characters); any other non-array files threw a TypeError.
- calibrate.mjs gitHead: provenance gitDirty keeps byte 0 of each `git status --porcelain` line (new export
  porcelainLines; the old whole-output trim() turned line 0's ' M' into 'M'; one trailing CR is stripped per line).
  soak-calibration.json shows it only after the next recut.
- new test/70-calibrate-d7.test.mjs (19 rows): the D7 rule on GOOD and hostile inputs, a live 1-cycle x 1-op child
  whose real output passes, porcelain parsing, and a static row pinning both call sites (the die in the cut loop and
  gitHead's use of porcelainLines).
- FAIL_CAP census (a long-open item, now closed): FAIL_CAP (config.mjs, 16) caps only the stored failure records per
  cycle; every failing world still reaches the BREACH log. Witness: the full L- battery (12 controls, full length)
  run twice in scratch copies of HEAD, FAIL_CAP 16 vs 1e9 -- 12/12 OK both times, identical BREACH keys in every
  control; in the 5 controls where the cap bit (259 to 3485 failing worlds per cycle) the BREACH streams were
  byte-identical; the 3 other differences were measured values only (heap MB, wrap W5 bop / pre) in controls with no
  failing worlds. Wall time 793 s / 776 s per battery (load 3.62 -> 1.73 / 1.73 -> 1.05). Only BreachLog's dedup
  (one line per oracle family / lane / sig / known) can hide a head, by design.

### Changed -- small sweep: test/torture, test/41, 42, 66, 69 and soak gates.mjs NITs (dev-only, not shipped)

Engine unchanged (Signal.js d07e0b17, Watch.js 065f21bd); test harness, bench/soak/gates.mjs and its parity pin only.
Closing run (quiet-lock, Node v26.8.2, load 1.46 -> 8.44): npm test 1708 / 1694 pass / 0 fail / 7 skip / 7 todo;
torture GATE ok (alloc=0 B/op, k=0B/batch,0B/batch K=1,1, retention=0/966).
- test: torture k label prints fail(unmeasured) for any non-finite Dlo (was fail(Dlo=NaNB)); test/69 own-min-loop
  wiring check reads only the alRead / qsRead bodies and fails closed when either is missing; blind-spot comments
  say "each dipping by >= the retainer's per-batch bytes".
- test/66: the WIE generated row pins the exact scenario-counter map of its 200 worlds (cut at HEAD; re-cut on a
  gen/exec/scenarios/engine change); new W1 row notSignal2 (effect target) is a second killer of the dropped
  not-a-signal check.
- soak gates: boundaryState reads trackerSize / weakAlive once each, and LaneGates.push reads rec.cycle and
  rec.memory at most once each, so a record getter cannot change the verdict between reads; gates.mjs re-pinned in
  parity.json; new test/42 read-once row.
- test/41 calibrationProblems: the (f) exemption check compares exempt.ERROR element by element (a toJSON
  spoof is red); a kernel file shaOf cannot read is red even with sha256 null, and files [null] is a (p) line; every
  bound cell's cycles must equal cut.cycles / cut.smokeCycles.
- test/69 also fails closed on an alRead / qsRead body holding a quote, backtick or slash (a } in a string cannot cut
  it short); the test/41 D7 lane-only loop object-guards each files entry, a null sha256 is red (row tree files [null]).

### Changed -- test/torture.mjs slope lanes: 2nd-smallest odd batch (dev-only, not shipped)

In the b77 closing npm test the test/64 aset must-fail row went red: the mutant exited 1 only via the untrack lane,
while the set lane false-passed at k=640B/batch (GATE K=1,3). The old rule (Dhi = min odd batch, pass iff Dhi <= Dlo)
let ONE odd batch that dipped to the even floor pass a retainer (one object per 1000 read.set calls); the b74 note had
flagged the hole ("A dip on ONE odd batch masks a retainer up to its size"). The verdict now lives in a new pure cold
module test/torture-judge.mjs (`judgeSlope`, `SLOPE_ORD` = 2) used by the set, untrack and QS slope lanes: Dlo = min
even batch, Dhi = 2nd-smallest odd batch, pass iff Dhi <= Dlo. A new-rule pass is always an old-rule pass; no single bad
batch (odd dip, odd spike, even spike, even dip) passes a retainer. Remaining blind spots: two odd dips in one attempt,
each dipping by >= the retainer's per-batch bytes; plus the unchanged ones (a spike on every measured even batch, a
retainer slower than ~1 per 1e5 steps, per-batch / per-GC retention, young-dying allocations). The detection floor is
still 1 per 1e5 steps. The QS control (min paired difference >= 1280 B) is unchanged. Hot wrappers are byte-identical.

The judge also fails closed on a non-finite, negative or non-number batch entry (the old inline judge passed NaN, -16,
'0' and undefined slots; found by the b78 golden vectors). Trade-off: a pass now needs two clean odd batches, so a noisy
live attempt can go red where the old rule passed (pinned vector C1); attempts K=3 are unchanged; false-red rate under
load, b78 census (K=10 runs of test/64, Node v26.8.2, load 2.3-3.9): the live row passed 10/10 on its first attempt
(K=1,1), aset and aun failed 10/10 with their own fail lines; not yet measured at the b77 load (3.3 -> 6.5 during the
run). Tests: new test/69-torture-judge.test.mjs (13 tests: golden old-rule literals from HEAD, new-rule verdicts, the
b77 teeth vector V1 (old PASS / new FAIL), fail-closed rows, and a wiring row pinning the counter conjunction, the 3
pass sites and no pass override); test/64 copies the judge into each mutant tree and prints its sha8. npm test (b78
closing run): 1705 tests / 1691 pass / 0 fail / 7 skip / 7 todo.

### Fixed -- engine (F5, DIV-F5; LEDGER #36 F-MB)

A batch revert restored the pre-batch version even after a reactive body had observed the intermediate value (pre-existing
since 1.2.0, in the signal set path and the box set path). Four observable shapes: (1) a computed re-evaluated mid-batch
kept the intermediate value after the revert; (2) a reader created before the batch re-ran at close and read it stale
(glitch); (3) an effect created mid-batch read the intermediate on its first run and never re-ran after the revert; (4) a
mid-batch re-evaluation dropped a conditional dependency and the revert then hid a later write to the dropped source
(effect dead).

Fix (Signal.js 0628127b -> 0f75866f): inside `batch()`, setting a signal back to its pre-batch value (under its `equals`)
restores the old version and fires nothing ONLY IF no reactive body (computed or effect) ran since that signal's first write
in the batch; if one ran, the set back is a normal write (downstream re-runs and sees the reverted value). A node gains a
`preBatchEvals` capture of the body-run counter at its first batch write.

Cost (untimed, node v26.8.2; a statistical A/B is a PENDING release-gate step): bytecode fireRecompute 26 -> 45 (+19),
read.set 252 -> 285 (+33), boxSet 204 -> 227 (+23); executeEffect 455, refreshComputed 782, the readers 106/200/96/99,
allocateLink 572, flushEffects 440 and batch 108 unchanged; inlining census unchanged (executeEffect inlined into
flushEffects in 8/8 lanes, 0 deopts); +8.00 B per node (eager 233.28 -> ~241.3 B/node at maxNodes 1e5); GC over a 1e6 batch
set/read/revert loop: minor 0, major 0. Soak: shrinks ERROR:7:0x8999219f, BATCH:1:0xb08f012b and BATCH:2:0xfd8b9606 exit 1 -> 0;
BATCH failingWorlds 2000 -> 0, ERROR 1523 -> 1516 (DIV-F5 lines dropped; 10 worlds now reach DIV-F22).

KNOWN residuals: (a) a body (effect or computed) already running when `s` is first written in the batch (it, or a computed it reads, writes `s`) that then reads `s` in the same run does not block the revert, so it keeps the intermediate value
(test/37 (c): `[5]`, ideal `[5,0]`); (b) the body-run counter is 30 bits, so a revert slips through only after exactly
k*2^30 body runs between the capture and the revert inside one batch, falling back to the pre-fix behavior (same class as
the 2^31 dormancy band and #44's gen wrap).

Tests: test/82-f5-fixr.test.mjs (33 rows: R1-R7 on signal and box, G1-G4, source pin, 8-bit boundary, GC / retention),
test/37 todos resolved ((c) KNOWN [5]), test/48 mask30 rows. Full suite: npm test 2196 tests / 2184 pass / 0 fail / 11 skip / 1 todo; npm run test:gc 2244 / 2241 pass / 0 fail / 2 skip / 1 todo (node v26.8.2, b108). Soak closure of #36: done in b109 (see "### Changed -- soak b109: DIV-F5 fixed in the registry, LEDGER #36 closed" below).

### Changed -- LEDGER #36 (F-MB) triaged: folded into DIV-F5 (docs only, not shipped)

The four known=none BATCH-lane lines (BATCH:1:0xb08f012b, BATCH:2:0xfd8b9606) are F5 (a batch revert after a mid-batch
read leaves downstream stale): an effect created mid-batch that reads the intermediate (a new path), and a classic
revert-after-mid-read whose re-evaluation drops a dependency (an O4 effect-dead line DIV-F5 does not list). Both
shrunk worlds (4 and 9 ops) fail on the tree, preb33 and 1.5.2
and pass on the tree plus the FIX-R hunks only (FIX-R has since landed; see the F5 entry above). No engine, harness or registry change in this triage: the lines stayed known=none in the
soak until FIX-R lands (A3). Contract ruling: a mid-batch effect re-runs at batch close iff a source it read changed
after its first run; A3 amends the batch doc comment in Signal.js to match.

### Fixed -- soak gates.mjs: `LaneGates.push` is all-or-nothing (dev-only, not shipped)

`LaneGates.push` reads a cycle record once and checks it whole before anything folds: the count maps are copied into
Maps, the boundary state is taken before the fold, and every `Totals` refusal (a total leaving 2^53, an empty failure
key) runs up front (`Totals.assertAdd`). Before, a throw after the fold began (a total overflow, a `failureCounts` key
'', or a record getter / Proxy trap on `boundary` or a count map) left the lane half-folded (cycles counted, boundary
and heap not). A throw anywhere in `push` now leaves the lane un-folded for that record. Output for valid records is
byte-identical (golden compute smoke/full + judgeRun). test/42 gains 5 rows (R1-R5), red on the old gates.mjs;
LaneGates refuses a duplicate opts.required name (TypeError). test/41: the (f) failure line prints the own keys of the
exemption set (a non-enumerable key was invisible); must-fail row.

### Changed -- test/41 clause (f) hardened; exemption set spelled twice (dev-only, not shipped)

The (f) exemption-set check now spells the ruled set `{ERROR: [DIV-F5, DIV-F6, DIV-F22]}` a second time, structurally
and fail-closed: editing the test/41 literal alone is red (before, it compared against the string it had parsed). Three
new must-fail rows: `fixedIn` deleted and `fixedIn` '' (only `fixedIn === null` counts as open, so the exemption expires
and (f) is red) and a null exemption set (exempt = null: red, no TypeError). The comments that said "both kernels" now
say every kernel that cuts the lane.

### Added -- soak must-fail control L-WIE-rev152 (dev-only, not shipped)

`_mustfail.mjs` gains a long control: base rev152, lane WIE, 11 x 100000, expected spec oracle=O1 lane=WIE
sig=effect-stale, known DIV-B33. Measured (b75): 1 OK / 0 MISS; the four heads O1e/O2/O1c (WIE:0) and O4
(WIE:4:0x88c7b46b) are byte-identical to the b69 r152-full.err, all DIV-B33, 0 known=none, 0 retention/heap BREACH.
Must-fail checks: the base tree -> MISS (no BREACH); DIV-B33 without O4 -> MISS (O4 known=none). `teeth.mjs` lane:WIE is
now backed by [L-WIE-preb33, L-WIE-rev152]; test/45 "teeth l" pins it. MUSTFAIL_LIST 36 -> 37 lines.

### Fixed -- soak gates.mjs: `Totals.toJSON` keeps a `__proto__` key; `LaneGates.push` refuses re-entry (dev-only)

`Totals.toJSON` keeps a key named `__proto__` (an own key of a JSON-parsed failureCounts) as an own data property of a
plain object (`Object.defineProperty`); key order and JSON bytes are unchanged for every other key set (golden
byte-identical). `LaneGates.push` throws GateInputError on a re-entrant push into the same lane (a record getter pushing
mid-check); the guard resets in `finally`. test/42 todo rows 2 -> 0 (both now real tests, red on the old gates.mjs);
the descriptor rows pin both own keys as writable / enumerable / configurable data properties (`writable: false` is
red); the per-lane row pushes into a 2nd lane from a record getter mid-push: both fold (one shared busy flag is red).
parity.json re-pinned (gates.mjs line only), parity OK 34 files. Engine unchanged. A getter firing during the fold
(after the cycle count moves, e.g. `rec.boundary`) still left the OUTER lane half-folded here; closed by the
all-or-nothing entry above.

### Changed -- soak D4: NEST floors re-cut on full-length worlds; test/41 clause (f) (dev-only, not shipped)

The tree kernel is added to the NEST calibration only (`calibrate.mjs` LANE_KERNELS): headpatched and lite-1.5.2
fail-stop every NEST world (full 33885/33885 at 32.5 ops/world; 36726/36726 at 30.0) while the live engine runs 425.0.
Recut (timed, 891 s, quiet-lock, 2026-10-19): tree NEST full 2596 worlds / 1103300 ops / 0 failing, O7a 50367 (now
`CHECK_FLOOR`'s binding cell, 5.0x 10000); smoke 144 / 61200 / O7a 2704 (5.4x `CHECK_FLOOR_SMOKE` 500); rarest NEST
scenario lifecycle-callback-dispose 11388 full / 621 smoke. `CHECK_FLOOR`, `CHECK_FLOOR_SMOKE`, `SCEN_MIN`,
`SCEN_MIN_SMOKE` and `TAINT_SKIP_MAX` are unchanged (`SCEN_MIN`'s binding cell stays 1.5.2 ERROR aggregate 22).
test/41 gains clause (f): every rostered lane needs full-length evidence (full + smoke cells, failingWorlds 0)
on a kernel that cuts it. One exemption, ERROR (tree ERROR fails 17039/17050: DIV-F5/F6/F22), holds only while
one of them is open (fixedIn null) in `divergences.json`; all three closed or absent turn (f) red and force the ERROR
recut. Clause (e) counts full-length cells only; the mutant minima count full-length cells plus the exempt ERROR
cells (`SCEN_MIN`'s binding). `TAINT_SKIP_MAX`'s binding cell moves to tree NEST O1e 0.2222 (smoke 0.2202; was
headpatched NEST 0.0579). `hollowVolume` rows now record failingWorlds.

### Changed -- `test/torture.mjs` QS retention control: paired-batch minimum (dev-only, not shipped)

The blind-control gate reads the min over the 8 (even b-1, odd b) batch pairs of odd - even (>= 4 measured pairs,
>= 1280 B) instead of Dhi - Dlo, so a one-time step in the per-batch constant cannot pass a blind control (b73 saw
+6240 B per batch from about batch 7-9; b74 saw it on the first QS attempt too). The phase-2b set / untrack lanes and
the QS slope lane keep Dhi <= Dlo (an upward step can only redden them). GATE labels emit a unit only after
a number: `k=<n>B/batch,<n>B/batch`, `k=fail(Dlo=<n>B)`, `ctl=unmeasured`.

### Fixed -- `watch()`: baseline committed before the callback; `stop()` releases the last value

Two defects in `watch()` (Watch.js), both present through 1.5.2:
- The fire wrote `oldValue = currentNewValue` AFTER calling the callback, so a callback that threw
  left the previous baseline in place. With `s = signal(0)` and a callback that throws once on
  `s.set(1)`, the next `s.set(2)` reported `(2, 0)` instead of `(2, 1)`, and the `Object.is` guard
  compared later values against the stale baseline (a projection that returned to the thrown fire's
  value re-fired). The fire now reads `next` / `prev` into locals and commits `next` as the baseline
  before invoking the callback.
- `stop()` disposed the effect but kept both value slots, so a stop handle the caller kept after
  disposal kept the last observed value reachable. The first `stop()` now drops `oldValue`,
  `currentNewValue`, `source`, `callback` and the engine dispose handle; later calls are no-ops (the
  late-binding `wantsStopEarly` path for `stop()` inside the immediate fire is kept).

Per-fire cost stays at zero allocations: `test/torture.mjs` gains a `watch()` fire lane in the
pinned-semi-space child (new-space delta minus an empty-step baseline, in the same process as the
>= 8 B/op box control), gated at the nest budget (`watch=` on the GATE line; fires must equal steps,
or the lane is blind). An escaping per-fire object, an inline `untrack(() => ...)` arrow in the
effect body and a fresh `() => stop()` closure passed to the callback per fire each turn it red (the
lane's callback stores its stop argument in a hoisted slot, so that closure escapes and V8 cannot
escape-analyse it away). New `test/52-watch-commit-release.test.mjs` (17 tests). Of the first 9, 8 are
red on the 1.5.2 Watch.js; the idempotence row pins engine behaviour and passes on both). Every clear
in `stop()` is load-bearing: removing the `oldValue` or `currentNewValue` clear turns the 3
value-release tests red, and removing `stopFn = null` at either release site (outside `stop()`, or the
`wantsStopEarly` path) turns that site's dispose-handle test red -- a kept stop handle would otherwise
keep the whole registry reachable. 8 later rows: a kept stop handle releases `source` and `callback`
(stop from outside, also with source and callback in separate scopes, inside a later callback, inside
the immediate fire), stopped wins, and owner-disposed / sibling-stop pins; 6 are red on the 01c00bc
Watch.js (removing `source = null` or `callback = null` in `stop()` turns them red, removing the
`stopped` test after `source()` turns the stopped-wins row red). **Behaviour change (stopped wins):**
`stop()` called inside `source()` now means the callback does not run after it and the value slots are
not re-populated. Through 1.5.2 the callback still fired after `stop()` with `(v, prev)`, with or
without `immediate` (on the unreleased 7676dac / 01c00bc only with `immediate: true`, as `(v,
undefined)`), and the value was re-retained. The per-fire path gains one boolean test after `source()`
and no allocation (torture `watch()` lane 0.000 B/op). A watcher disposed by its OWNER (a parent
effect disposed first) keeps the last value, `source`, `callback` and the engine handle until its stop
handle is called (safe, gen-guarded, releases everything) or dropped, as a raw `effect()` dispose
handle keeps its registry; not fixable at zero cost without an engine hook (documented, not fixed). A
re-entrant write to the source from inside the callback is unchanged: the engine does not re-run an
effect for a write made during its own run, so that write is not observed by the watcher (same on
1.5.2).

### Fixed -- `when()`: the cancel handle releases predicate, callback and the engine handle on fire and cancel

`when()` (Watch.js) never cleared its engine dispose handle (`stopFn`), present through 1.5.2: a
cancel handle the caller kept after the predicate fired, or after an explicit cancel, kept the
disposed effect's dispose handle and, through it, the whole registry -- every value its nodes hold --
reachable for as long as the handle lived. Both release paths now drop the handle before calling it:
`stop()` (run on fire and on cancel) and the `wantsStopEarly` path (predicate truthy at registration);
later calls find it null and are no-ops. `stop()` also nulls `predicate` and `callback`, so the kept
handle retains nothing of the watcher (no closure-context retention). **Behaviour change (stopped
wins):** `cancel()` called inside the predicate on a later run now means the callback does not run
even if that run returns truthy; through 1.5.2 / 01c00bc it still fired. Unchanged and documented: a
callback that throws on a later fire skips the auto-dispose (the throw propagates out of the write,
later writes do not refire, the live effect and predicate / callback stay referenced by the handle
until `cancel()`, which releases everything; a throw at registration makes `when()` throw and the
engine disposes the effect). Documented, not fixed: a `when()` disposed by its OWNER (never fired,
never cancelled) keeps the engine handle, predicate and callback until its handle is called (safe) or
dropped; no zero-cost fix without an engine hook. The `fired` guard is now `done` and its comment
corrected (it is reached after a later-fire callback throw). No per-check allocation is added: the
per-check path is unchanged (one more `done` test runs only on the truthy, once-only path).
`whenAsync()` was not affected: it discards `when()`'s handle and the Promise holds no path back to
the registry (now pinned). New `test/53-when-release.test.mjs` (20 tests; 11 rows added for the
closure-slot release: after fire (and once with predicate and callback in separate scopes), cancel and
a truthy registration, cancel inside a later predicate run (falsy, and truthy: stopped wins), a
later-fire throw pin + cancel, owner-disposed pin + call, 1000 stale handles after slot reuse; 8 are
red on the 01c00bc Watch.js): 4 original release rows, all red on the 1.5.2 / 7676dac Watch.js;
removing `stopFn = null` in `stop()`
turns 3 of them red and removing it on the `wantsStopEarly` path turns the fourth red. Two premise rows
pin the engine fact the release rows rest on (a kept effect dispose handle, live or already disposed,
keeps its registry reachable), so an engine change that breaks it fails those rows instead of leaving
the release rows passing vacuously; plus a cancel-after-done no-op row and two `whenAsync` pins.

### Fixed -- engine: `globalVersion` skips 0, the "unset" stamp sentinel (F29)

`evalVersion` and `markEpoch` use 0 as "unset", but `globalVersion` bumped as a plain
`(v + 1) | 0` and so first reached 0 after 2^32 - 1 version bumps in one registry lifetime (then every
2^32). At that write a lazy computed's first read could return `undefined`, and an effect created or
read at that moment could go permanently deaf (no re-run after 1000 further writes); an
effect stamped 0 skipped its dependency check, a computed stamped 0 bypassed the equality
cutoff, and a batch revert inside the window re-ran. Both bump sites (`read.set`, `boxSet`)
now spell the bump `((v + 1) | 0) || 1`, so the only 0 stamps left are the "unset" ones `createNode` and `destroy()` write;
the version counter's period is 2^32 - 1. The `|| 1` arm is `c8`-ignored (unreachable in a
test run; see COVERAGE-NOTES.md). Bytecode, `--print-bytecode` (bake-off, 2026-10-13, PRELIMINARY):
`read.set` 252 B, unchanged vs the pre-fix tree; `boxSet` 200 -> 204 B. New
`test/51-version-zero-sentinel.test.mjs` (6 tests, red on the pre-fix tree, with must-fail
mutants per site). Acceptance campaign (reduced: sweep + microscope, REPS=10, no Andrii suite; 2026-10-13,
M4 Pro, Node 26.8.2, quiet-lock, load 1.05-2.91; Chrome busy during part of the sweep, 31 of 59 samples):
ACCEPT, PRELIMINARY -- 0 / 45 sweep rows and 0 / 6 microscope scenarios beyond the A/A noise;
KAIROS and BROADCAST are bimodal and their fast-mode ratios are 0.984 and 0.994. The full
BENCH-CAMPAIGN runs before release.

### Fixed -- engine: a write made while a body is mid-run flags the stale reader (F-b33-1)

A write made while some body was running (an effect or computed mid-run, `untrack` included) was marked
and queued like any other, but a reader that was itself mid-run and had already read the old value was
skipped: it finished with the stale value and nothing re-ran it (a lost update). Present in 1.5.2 (the
b33 lanes lose updates there). Commits f4f9475 (engine), b1e7a06 (tests), 32625fe (D-R3), 87a9e92 (KC).
Behavior now, as in the `Signal.js` header "WRITE DURING AN EVALUATION":
- A write while `cursorDepth !== 0` goes through a cold twin, `markDownstreamInEval`: the same marking, plus
  an internal flag bit (`FLAG_STALE_READ`, 1 << 6) on every mid-run (COMPUTING) reader that is reachable from
  the written signal along some path through no mid-run computed (order-independent), and is not the writer
  (writer = the current observer, else the current owner; an untrack-wrapped or `watch()`-callback self-write
  stays absorbed). A stale effect is re-queued after its run and runs again in the same flush; a stale
  computed is re-pulled in the same read.
- A write made before a body's first read (by its own cleanups, or its owned children's) is seen, not stale:
  `disposeOwned` / `runOwnCleanup` clear the node's own flag (gen-guarded), so there is no false re-run and
  no false `CycleError`.
- D-R3: a write absorbed by a mid-run computed (its own write, or one made before its body reads) no longer
  re-runs or `CycleError`s the readers behind it. Before this, such a shape (row ANC) threw `CycleError:
  flush passes exceeded` at `effect()` creation after 101 runs.
- KC: whether a reader gets the flag no longer depends on subscription order (a reader reached first through
  an absorbed path and later through a clean edge still gets it; each node pops at most twice, O(V+E), no
  allocation). This fixed a lost update.
- A never-settling loop throws `CycleError:` where it forms: effects through `flushEffects`' `maxFlushPasses`,
  computeds when the nested re-pull count reaches `maxFlushPasses` ("CycleError: computed keeps invalidating
  its own reads"), including from `effect()` creation (its first run) and from reads.

KNOWN residuals (maintainer ruling 2026-10-14 "accept all three"; D-M1 and D-M2 pinned in test/56 as KNOWN
rows, KC-NEST0 accepted for 1.6.0 with its own KNOWN row), none fixed:
- D-M1: a conservative over-run. A stale re-pull through an equality-cutoff computed (row EQ: the computed
  always returns 7) still re-runs its reader once; values are correct, at most +1 effect run per write wave
  (the pin asserts 1, the ideal is 0).
- D-M2: a write from an `onConnect` callback, or from an `onDisconnect` fired by `severTail`, runs with
  `currentOwner` = the reading node (`fireConnect` / `fireDisconnect` null only the observer), so it is
  absorbed as that reader's self-write: not flagged, that run keeps the value it read (same as 1.5.2).
- KC-NEST0: a write by W that is absorbed by a nested computed chain (row KC-NEST without the extra read P,
  T = X()) does not flag F: F runs once and its second X read returns 1; the fixed engine's value is pinned,
  not an ideal.

Cost (node v26.8.2, `--print-bytecode`, from the commit messages): byte-identical to the pre-fix tree
7c65afd: `flushEffects` 440, `runCleanup` 28, `destroy` 619, `disposeNode` 667. Changed: `executeEffect` 455
(cap 459), `pullComputed` 824, new `effectTail` 25; the cold `markDownstreamInEval` is 335 (frame 88) after
the D-R3 and KC hunks (235 at f4f9475); cold `disposeOwned` 57 -> 95, `runOwnCleanup` 166 -> 204;
`markDownstream` is 194, unchanged by D-R3 and KC. Allocation (gates in the 32625fe / 87a9e92 messages):
torture GATE 0 B/op, qs 0; 1e5 KC-PX sets give maxMajor 0 and 0 B/op; 1000 create / destroy cycles leave
`tracker.size()` 0. `Watch.js` is unchanged.

New `test/56-write-in-eval.test.mjs` (48 rows at 87a9e92). Gates at 87a9e92: `npm test` 1420 tests / 1404
pass / 0 fail / 7 skip / 9 todo; `test:gate` 10/10; `visit-anatomy --verify` 61/61. Review R2 and R3:
engine APPROVED (mutant sets in the commit messages).

### Fixed -- engine: stale effect-queue entries skip a node that is no longer QUEUED (F21, LEDGER #35)

A `CycleError: flush passes exceeded` abort, or a dispose in the same pass, left stale entries in the
effect queue. A later flush then ran whatever node had recycled the slot: a spurious body run, a second
scheduler call, or a bogus creation-time `CycleError` ("Infinite effect loop detected") from an unrelated
`effect()`. Shipped in 1.5.2. Fix "qskip2" (c2f123c, one code hunk in `flushEffects`): the flush loop runs a
queue entry only while `(node.flags & FLAG_QUEUED) !== 0` (it tested `FLAG_EFFECT`), and the test now
guards the scheduler branch too. Only effects are ever QUEUED; QUEUED is set only in `markDownstream`
together with its one push, and cleared by `executeEffect` (dispose and destroy zero every flag), so every QUEUED period owns one entry (a
scheduled effect keeps QUEUED until its thunk runs). 0 B. Bytecode length and frame size equal the pre-fix
tree in all 9 tracked functions (disposeNode 667, nodeMiss 295, releasePinned 45, createNode 229,
flushEffects 440, executeEffect 448, markDownstream 173, pullComputed 797, destroy 619); no new flag bit, no
capacity change. The rejected alternative (fix3, slot pinning) threw `CapacityError` at N=520 under the
default registry.

KNOWN residuals (maintainer ruling D5, "Document as KNOWN"), both equal to the pre-fix engine and pinned as
KNOWN rows in test/58: R1: a recycled scheduled resident that is legitimately queued in the window gets 3
scheduler calls (ideal 2) and 2 body runs. R2: a recycled unscheduled resident that is legitimately queued
runs early at the stale entry's position (preservation row 3 pins the order "C0,C,M"); when a later write
in the same pass re-queues it (KNOWN R2), 3 body runs (ideal 2), last value 2 (correct).

New `test/58-f21-stale-queue.test.mjs` (21 rows, 22 tests with the kernel diagnostic; 9 are red on the pre-fix engine: probe-f21, P2_Afirst, P3,
P8, d, D1, rows 7 / 8, PX3; preservation rows P5, P7, P2_Bfirst, row 3, C1 (N=1000, default registry), C3,
U1, R2-ABA, self-dispose and keep-QUEUED; KNOWN rows R1, R2). Mutants Q1-Q5, each caught on its named rows
(Q1 no QUEUED test: 9 red; Q2 test on the executeEffect branch only: 6; Q3 on the scheduler branch only: 3;
Q4 EFFECT|COMPUTING: 6; Q5 inverted polarity: 19). `test/torture.mjs` gains phase QS (`s.set` driving one
sync-scheduled and one plain effect; as first shipped, 0 B/op in-process, since replaced by an interleaved
one-call retention slope, a6c66a9: one `measureAllocs` call alternates pseudo-batches of 2e4 calls at 1 and at 5
steps per call, the per-batch constant k cancels, and an attempt passes iff it settled, ran exactly 1080000 steps,
ended in the reset state, kept >= 4 batches per parity and Dhi <= Dlo (up to 3 attempts, stop at the first pass);
three local runs (node v26.8.2) read alloc=0 B/op
k=0B/batch K=1 ctl=2560B, child 0.000 B/op, gc major 0; the retention control must read Dhi - Dlo >= 1280 B
(superseded b74: it now gates on the min over the 8 (even b-1, odd b) batch pairs of odd - even, >= 4 measured
pairs, >= 1280 B); b73: up to 3 fail-closed control attempts, ctl=<d>B,K=<n>)
and phase F21 retention (1e3 x {`createRegistry({maxFlushPasses: 8})`, the P3 shape, `destroy()`} -> lite-leak
tracker size 0); the pre-fix engine gives size 1000 there, and a QS-teeth control gives 135.972 B/op in the
child lane. `npm test` at be0fe70: 1372 tests / 1356 pass / 0 fail / 7 skip / 9 todo.

Soak wiring (dev-only, not shipped; be0fe70): `divergences.json` DIV-F21 `fixedIn` null -> "A2-F21"
(ruling D2), so it explains a failure only on a `controls.json` kernel (all pre-fix until the post-fix `preb33` was
added, eb5acc2, which pins zero DIV-F21); `main.mjs` and
`SoakReport.mjs` classify with `includeFixed` = the kernel is a known control (the header's `controls.name` identity; SoakReport tests `controls.name !== null`); DIV-F22 stays temporary. The GAP
P-INTERIM-ERROR-clean is deleted (GAPS 25 -> 24) and became a short-battery `_mustfail.mjs` control on
headpatched + the qskip2 hunk (ERROR lane, 11 x DEFAULT_OPS, expects exit 1 explained by DIV-F22 only); it was
later re-pointed to `preb33` with no patches, expected exit 1 explained by [DIV-F5, DIV-F6, DIV-F22] (see "Changed --
soak models the R2-M1 creation abort" below).
Decision B39-D1 was RULED 2026-10-14 (superseded for the control base by the `preb33` re-point): (a) keep -- the control
uses headpatched + the hunk, not the tree
base, because the tree ERROR lane fails 17039 of 17050 worlds (DIV-F5 / F6 / F22 plus 3 known=none
recovery-after-throw BREACHes (the 3 known=none breaches also appear on the pre-F21 740edfc kernel); P-TREE is still a GAP), while headpatched + hunk
gives 4077 worlds, 3020 failing, 1 BREACH (DIV-F22). Until the tree base can host it, the proof that the
shipped tree's ERROR lane is clean of F21 rests on test/58. Wiring gate: test/46 "fixed-entry wiring".

### Fixed -- engine: a synchronous scheduler's creation-time throw disposes the effect

`effect()` with a scheduler that runs the first run synchronously rethrew a first-run error (CycleError,
body throw, or a throw from the scheduler itself) before a handle existed, and the effect stayed
subscribed. It is now disposed before the rethrow, as on the no-scheduler path. Deferred schedulers are
unchanged. A first run that throws `null` without a scheduler was swallowed and a live handle returned
(through a synchronous scheduler it was rethrown, but the effect stayed live); any thrown value,
including `null` and `undefined`, is now rethrown and the effect disposed. The handle's generation is now
captured before the first run, which also fixes a no-throw case: an effect that disposed itself during
its first run returned a handle that, called or passed to `dispose()`, disposed whatever node had reused
its slot (a signal created afterwards could be destroyed). That handle is now stale: calling it or
`dispose(h)` is a no-op and `describe(h)` is `undefined`. Hot paths unchanged (the 7 hot function bodies
are byte-identical; `effect()` creation is cold). New `test/59-sync-scheduler-creation-throw.test.mjs`
(21 tests; 13 red on the previous engine).

### Fixed -- engine: null opts no longer leak a node or a lifecycle entry

`signal`, `computed`, `signalBox`, `computedBox`, `effect` and `observeObservers` called with `null` opts
still throw `TypeError`, but nothing is allocated first. The five creation entries read `opts.equals` /
`opts.scheduler` after `createNode`, so the throw left an active node (+1, never freed; 10/10 entries x
{registry, default exports} leaked on the previous engine, 0/10 now). `observeObservers` created its
lifecycle entry and bumped the internal lifecycle count before reading `opts.onConnect`, so the throw left a
hook-less entry (freed only by a later `observeObservers` + unobserve on that slot) that kept the count
non-zero, and the connect/disconnect branch on for every link, until then (+1 on both the registry method and the default wrapper
before, 0/2 now). Every opts read is hoisted above the allocation (read opts first, no new checks). The
`effect()` JSDoc now says any throw that escapes the call (a CycleError, a body throw, a throwing scheduler, or a
truthy non-function scheduler) disposes the effect first, and a deferred first run (async scheduler) that throws
later leaves it live (comment only). Cold paths only (the 7 hot function bodies are
byte-identical). Under `onCapacityExceeded: 'throw'` at capacity, null opts or a throwing opts getter now throw their
own error (the null TypeError, or whatever the getter throws) instead of CapacityError (the opts read now happens before the capacity check), and
`observeObservers` reads each hook once (a Proxy can observe the difference); benign. New
`test/60-null-opts-no-leak.test.mjs` (62 tests, including O5, a white-box lifecycleCount witness; 33 red on the previous engine);
`test/59` gains rows 10 (a stored run from a throwing scheduler, fired later, is a no-op) and 11
(generation wrap 2^31-1 -> -2^31) plus `hasObservers` checks on the undefined rows (23 tests; regression pins);
`test/61-null-opts-boundary.test.mjs` adds 39 boundary probes (33 red on the previous engine).

### Fixed -- engine: disposing a node drops its observeObservers hooks (LEDGER #40)

`disposeNode` never deleted the node's `observeObservers` entry; only the unobserve closure did. A signal or
computed disposed without calling its unobserve handed its `onConnect` / `onDisconnect` hooks to the next
resident of its pooled slot, and the internal lifecycle count stayed above 0 (the link alloc/free connect
branch stayed on). `disposeNode` now calls a cold `dropLifecycleHooks(node)` when the count is non-zero, just
before the generation bump, so every dispose path (`dispose(api)`, an effect disposer, the owner cascade, a
re-entrant dispose, a pinned node) drops the entry; hooks registered by user code during teardown are dropped
too. A sweep found a second site of the same class: registry `destroy()` bumped every node's generation and
rebuilt the free list without clearing hooks (count stuck above 0, the next resident inherited them); it makes
the same cold call. The unobserve returned by `observeObservers` captures the node's generation and is a
no-op once the node is disposed, so a stale unobserve no longer removes the next resident's hooks (it did
before). Effects: a pooled slot no longer hands hooks to its next resident, the hooks become collectable at
dispose, and the lifecycle count returns to 0. Pre-existing: shipped in 1.5.2. Bytes (node v26.8.2
`--print-bytecode`): `disposeNode` 667 -> 686 B (+19, the only changed body of the 7 hashed hot functions),
`dropLifecycleHooks` 31 B (new, cold), `destroy` 619 -> 638, `observeObservers` 169 -> 181. New
`test/62-dispose-drops-lifecycle-hooks.test.mjs` (19 tests under `--expose-gc`, 12 red on the previous engine;
14 without it: a white-box lifecycle-count lane runs in plain `npm test`, and the WeakRef retention rows are
skipped).

### Fixed -- engine: error semantics -- a dependency pre-walk no longer throws a cached error; leaving an error is a change; a dep cycle throws CycleError (FIX-T, LEDGER #38 / F6, #41, #42)

#38 (F6), #41 and #42 are pre-existing bugs shipped in 1.5.2; the re-pull cap (D1(b)) is 1.6.0-dev-only code (F-b33-1, not in 1.5.2). All four are fixed together on 1.6.0-dev (commit 0878c6b, `Signal.js` sha256/8 928f0e64).
- Dependency pre-walk (D-H, #38 / F6). Refreshing a computed -- the dependency pre-walk of a dependent computed or effect --
  no longer throws a dependency's cached error. Before, the throw escaped the pre-walk: the effect stayed queued forever, or a
  computed kept a stale cached error after its dependency recovered. Now the pre-walk refreshes (`refreshComputed`, void, never
  throws the node's own error) and the dependent re-runs; its body's read of the errored dependency throws the cached error (the
  same object), which the body may catch. READS of an errored computed still throw the cached error until a dependency changes
  (`pullComputed` and the computed read closure keep that throw).
- Leaving an error state (D-K, #41). A computed that cached an error and then returns a value equal to it (or one its custom
  `equals` accepts) now always moves its value and version: `equals` is NOT called when the previous state was an error. A
  reader that caught the error re-runs. (How other libraries compare here is unverified and not claimed.)
- Re-pull cap (D1(b)). The computed re-pull cap (F-b33-1, `maxFlushPasses` nested re-pulls) now caches its
  `CycleError: computed keeps invalidating its own reads` as the node's own error, so a repeat read throws the same object
  instead of re-running the body.
- Dependency cycle (#42). A cycle among computeds that are all clean (a body that caught a CycleError from a partner, or a
  restored graph) used to recurse in the pre-walk until `RangeError: Maximum call stack size exceeded`. The pre-walk now throws
  `CycleError: Circular dependency detected.` at depth > `nodePool.length` (no acyclic chain is deeper than the pool).
  RESIDUAL: a pool larger than the pre-walk stack limit still overflows first (Node v26.8.2: eager `maxNodes` 4096 / 16384 /
  65536 -> RangeError; the default 1024 -> CycleError).
- Residuals, measured (Node v26.8.2, darwin, 2026-10-22; depths are untimed probes; the timings are K=9 rounds at load average
  2.9-3.4, PRELIMINARY; evidence `.handoff/fixT/perf/SUMMARY.txt`, `.handoff/b102-evidence/`): the cold first-read chain depth
  is 6.1% below (warmed bisection 2411 vs 2567) and 6.4% below (a one-shot fresh process 1984 vs 2120) the pre-FIX-T 1.6.0-dev build B0 (08401c2) (percentages = 1 - live/B0 from those depths; .handoff/b102-evidence/B1fix/chain-ab.txt, a6-oneshot.txt); a `computedBox`
  `get()` keeps the `pullComputed` wrapper, one extra frame per cold level (1945 warmed); re-walk depth is about 5055 on
  every build. The write plus one-level refresh path measured about 6% slower than the pre-FIX-T 1.6.0-dev build B0 (08401c2, `Signal.js` sha256/8 98295467; lane L6, B0/W2 0.940); clean computed
  reads measured about 3x faster than B0 in every round but inconclusive under the A/A band rule. Not gated: statistical tier.
- LEDGER #43 (restore re-runs an effect once more than live) was later closed as not an engine bug (see "### Tests / Docs -- LEDGER #43 closed" above). (#44, #45 and #46 are fixed, next entries.)

### Fixed -- engine: onGraphMutation now reports op 3 for an edge a throwing onConnect hook leaves live (LEDGER #46)

Pre-existing (found b105 by the #45 reviewer). When an `observeObservers` `onConnect` hook threw, `allocateLink` had already linked
the edge into both lists (kept live by design, A1.5/S1) but `fireConnect` threw before op 3, so the edge was live and never
announced; a Mirror replay under-counted edges. Present in published 1.5.2 (ec36ab8, `Signal.js` f8dd50f8), e912e302 and 928f0e64
(probe `.handoff/b105-evidence/L46/op3-throw.mjs`: before `activeLinks=2 op3=["3:2->3"]`, after `["3:1->3","3:2->3"]`,
`.handoff/b106-evidence/L46/golden-diff.txt`). `fireConnect` now emits op 3 for the edge it leaves live, after the hook threw and
before the error propagates (order: connect (threw), op 3, error), unless the hook disposed either endpoint (the #45 generation
check). The edge stays live; an effect that catches the error still re-runs on that source. If the op-3 listener itself throws there,
its error replaces the `onConnect` error (maintainer ruling b106 Q1 = (i), plain `finally`). KNOWN interplay with #45: a hook that
throws after disposing an endpoint emits no op 3 (the #45 rule wins). Cost (node v26.8.2, `--print-bytecode`, untimed,
`.handoff/b106-evidence/L46/jit-before.txt` / `jit-after.txt`): `fireConnect` 142 -> 205 B (+63, cold), `allocateLink` 572 unchanged,
the four readers unchanged (106 / 200 / 96 / 99), inlining census unchanged; not timed (hot bodies byte-identical). The throw path
measured minor 0 / major 0 GC before and after (`gc-throw-*.txt`; 1e6-step gate in test/81). Gate:
`test/81-l46-op3-throw.test.mjs` (18 tests; rows R1, R4, R5, R9b, DF and test/80 N3' red on `Signal.js` d00484d6, 6 rows; mutants M1-M10,
swapped ids, an `||` generation check, X3 (flags instead of generation) and T1 (one [a, b] array per throw, transient) killed; X6 equivalent).
test/80 row N3, which pinned the old no-op-3 behavior, is rewritten as N3'. Docs: the `Signal.d.ts` op `4` text drops the stale `-1` sentinel clause (the `freeLink` `-1` ternaries were removed in 1.5.0-beta.8, see that entry). Fix: `Signal.js` d00484d6 -> 0628127b.

### Fixed -- engine: onGraphMutation no longer reports op 3 for an edge an onConnect hook removed (LEDGER #45)

Pre-existing (found b104). `allocateLink` ran the `observeObservers` `onConnect` hook (`fireConnect`) before emitting op 3. A hook that
disposed the source (op 2 for it, with a new node possibly reusing the slot), or disposed the target computed, or a target that
disposed itself from its own read's hook, removed the new edge, yet op 3 still reported ids for an edge that did not exist (or the
new occupant's id as its source). `fireConnect(source, target)` now records both endpoints' generations before the hook and returns
whether either changed; `allocateLink` does `if (_was0 && fireConnect(source, target)) return;`, so op 3 is emitted only for an
edge that survived the hook. The order "connect, op 3" is kept. Published 1.5.2 (ec36ab8, `Signal.js` f8dd50f8) shows the
source-disposed cases; on 1.5.2 a disposed target instead leaves a live phantom edge (already fixed on the 1.6 line). KNOWN
residual (both target-disposed cases): the hook's dispose of the target emits op 4 for the new edge, whose op 3 is now never
emitted, so a Mirror replay sees a lone op 4 ('op4 on non-live id <target>'); pinned in the gate. Cost (node v26.8.2,
`--print-bytecode`, untimed, `.handoff/b105-evidence/L45/a6-after.txt`): `allocateLink` 567 -> 572 B (+5), `fireConnect` 107 -> 142 B
(cold, never inlined), the four readers unchanged (106 / 200 / 96 / 99), inlining census unchanged, 0 deopts, jit-health 5
bailouts = baseline. Not timed (`allocateLink` is not inlined and the change is in its cold `_was0` branch). Op 2 implies the
node's subscriber edges are gone; no per-edge op 4 is emitted for them. Gate: `test/80-l45-op3-ghost.test.mjs` (17 tests; ghost
rows A/B/C/D and the two KNOWN rows red on `Signal.js` 928f0e64 and e912e302; mutants M1/M2/M3 killed, 6/4/2 rows failing).
Fix: `Signal.js` e912e302 -> d00484d6.

### Fixed -- engine: a tracked read no longer returns a recycled slot's value after hook code disposed the node (LEDGER #44)

Pre-existing (found b102). A tracked read whose dependency link is new calls `allocateLink`, which can run user code
(`observeObservers` `onConnect`; an `onGraphMutation` op-3 listener; an `onDisconnect` fired by the tail sever). If that code
disposed the node being read and a new node reused the slot, the read returned the new resident's value (computed kinds also ran
the new resident's body; a dispose-only computed read threw `TypeError: node.computeFn is not a function`). Each of the four
readers (signal read, computed read, `signalBox` `get`, `computedBox` `get`) now re-checks the generation right after
`allocateLink` and returns `undefined`, like other stale-handle reads; the cursor-reuse arm and untracked reads are unchanged.
`Signal.d.ts` keeps `(): T`. Cost (node v26.8.2, quiet host, `--print-bytecode`, `.handoff/b104-evidence/A6-growth.txt`): +18 B
bytecode per reader (read(signal) 88 -> 106, read(computed) 182 -> 200 of the 460 B inline limit, boxGet 78 -> 96,
boxComputedGet 81 -> 99); all four still inline, 0 deopts, jit-health 5 bailouts = baseline. Timing (interleaved A/B, fix
(`Signal.js` e912e302) vs `Signal.js` 928f0e64, K=9 rotated rounds, node v26.8.2, darwin, quiet host, load 2.42 -> 2.33,
2026-10-23, `.handoff/b104/perf/SUMMARY.txt`; a tracked read in an effect re-run, cursor-reuse and allocateLink arms of all four
readers): 7 of 8 lanes measured inside the run's own A/A noise band; the 8th (`computedBox` `get`, reuse arm) is inconclusive
(its A/A band, 0.949..1.003, leaves [0.95, 1.05]); a padded control build measured slower beyond the band on all 8. Gate:
`test/79-l44-read-reuse.test.mjs` (4 kinds x 3 triggers red on `Signal.js` 928f0e64; 4/4 no-recheck mutants killed; zero-GC rows).

### Changed -- soak b103: DIV-F6 retired, DIV-F5 O1c shape widened (dev-only, not shipped)

FIX-T fixed F6, so DIV-F6 is retired and the test/41 (f) ERROR exemption set is now `{DIV-F5, DIV-F22}`. The DIV-F5 O1c
(computed-err-mismatch) entry no longer requires the step scenario revert-after-mid-read (it matches the world scenario too): a live
soak world ERROR:7:0x8999219f had been known=none only because of that narrowing (the F5 bug: a batch revert restores
preBatchVersion after a mid-batch re-run; 7-op repro; FIXED later in the engine by FIX-R, see "### Fixed -- engine (F5, DIV-F5; LEDGER #36 F-MB)" above). Maintainer ruling b103, PLAN-0s-fixt.md ADDENDUM 13.

### Changed -- soak b109: DIV-F5 fixed in the registry, LEDGER #36 closed (dev-only, not shipped)

FIX-R (LEDGER #47, `Signal.js` 0f75866f) fixed F5, so DIV-F5 is now fixedIn "A3-FIX-R" (74ea021) and explains only with
includeFixed (control kernels preb33 / rev152 / prefixr); on the tree an F5 shape is known=none. The test/41 (f) ERROR
exemption set is now `{ERROR: [DIV-F22]}` (was DIV-F5 and DIV-F22). Tree lanes (seed 0xC0FFEE, default ops): ERROR
failingWorlds 1516, all DIV-F22, known=none 0; BATCH 0 failing (pre-fix 0628127b: 2000/2000). The 10 former-F5 ERROR worlds
now reach DIV-F22 (pinned in test/44). The O1c shape was NOT re-narrowed: the census found one known=DIV-F5 line on preb33
and rev152 (world 0x8992029a, step 57), so the widened shape stays (test/44 "b109 A1 fallback"). F-MB keys
BATCH:1:0xb08f012b and BATCH:2:0xfd8b9606 replay clean on live at SOAK_OPS=1000000 and exit 1 on 0628127b: LEDGER #36 is
CLOSED. The tagger gap (scenarios.mjs:303 onEffectCreated never fills b.mid) is recorded, not edited. test/46 FIXED_RE
gains F5. Wrap re-anchor (A6): FIX-R closed W2 (batchEpoch cycle) on the tree except the KNOWN k*2^30 alias, so
L-WRAP-TREE now expects W1/W3/W4 only, and the new must-fail L-WRAP-W2-PREFIXR (frozen pre-FIX-R kernel
`bench/soak/controls/prefixr`, 25784e5, `Signal.js` 0628127b) expects BREACH check=W2 counter=batchEpoch; the miss existed
since b108 (no long-control run in b108; only `soak:teeth:long` and the CI soak-nightly run it). Counts: npm test 2201 tests / 2189 pass / 0 fail / 11 skip / 1 todo; npm run test:gc 2249 / 2246 pass / 0 fail / 2 skip / 1 todo; torture 0 B/op; parity OK 45 files (b109 B3, node v26.8.2, untimed).
Untimed counts, node v26.8.2, host PRELIMINARY (load1 2.21-16.94 across the b109 runs vs baseline 2.21; .handoff/b109-evidence/B3/uptime.txt).

### Changed -- soak NEST taint-skip triage (D6): in-flight frames taint only on a victim read (dev-only, not shipped)

Harness only; the engine (`Signal.js` d07e0b17) is unchanged. Every binding-kernel NEST calibration cell (headpatched,
lite-1.5.2) had been cut on fail-stopped worlds (30.0-32.8 ops/world vs 425 live), where sticky taint grows with world
age; on the live tree 352343 of 352343 disposal-hit in-flight frames were blanket (never read the victim). `exec.mjs`
`disposeIdx` now taints an in-flight run only if its reads so far hold a victim or a computed tainted after the kill
(ruling D1, V1); the `:653` pre-skip is kept. Live NEST smoke O1c 0.577 -> 0.136, O1e 0.434 -> 0.220 (b70; 9 seeds max
0.142 / 0.232; 0 fail, 0 BREACH). `TAINT_SKIP_MAX` stays 0.35 (D3); the late/early bucket ratio is reported, not
gated. The taint-skip must-fail is now P-NEST-TAINT-HALF (`gate:taint-skip` in `_mustfail.mjs`, `cause:taint-skip` in
`test/67`); P-NEST-TRIGGERLESS is coverage-only and the cov-off taint leg is void (cov-off stays the coverage gate's
case). DIV-F15 is widened: it also explains O1e effect-stale on the effect that escaped the DIV-F15 TypeError in the
same step. Recut (b71): clean max 0.2546 -> 0.0579 (binding cut), sweep 0.2585 -> 0.0663. NEST floors on full-length
worlds (D4) were deferred (superseded b74: resolved, see "Changed -- soak D4" above).

### Added -- soak lane WIE (write-in-evaluation) joins the roster; per-lane kernel map (dev-only, not shipped)

Unit 0s (harness only; the engine, `Signal.js` d07e0b17, is unchanged). The soak roster is now five lanes: GRAPH, BATCH,
ERROR, NEST and WIE, a write made from inside a computed body (the F-b33-1 shape, LEDGER #37). Lane `lanes/wie.mjs`
(92c0020) with its oracle `test/66-soak-wie.test.mjs`; the roster flip, teeth and calibration recut are 35bbf26.
`parity.json` now pins 34 files (was 33: adds `bench/soak/lanes/wie.mjs`). Per-lane kernel map in `calibrate.mjs`
(`LANE_KERNELS`, `LANE_ONLY_KERNELS`, `LANE_PINS`, `pinnedFor`): WIE is cut only on the tree kernel, because 1.5.2 predates
the b33 fix; the tree kernel's files must equal `parity.json`. Divergence DIV-B33 (lane WIE only) explains the lost
update on a controls.json kernel as O1e effect-stale, O1c computed-mismatch and O2 glitch, and (widened, ruling b68)
O4 effect-dead (replay `WIE:4:0x88c7b46b`); on the tree it stays a regression. New must-fail control `L-WIE-preb33`
(preb33 at 11 x 100000 WIE: exit 1, 'explained' by DIV-B33). Teeth universe 47 ids (was 46), `CHECKS` 35 (`CHECKS_MIN`
35, was 34), 34 must-fail controls (was 33). The WIE digest was appended to `golden/scripts-1000.json`. Calibration
recut: 832 s (`.handoff/b68-evidence/b2b/recut.log`), started at load 2.75 / 2.71 / 3.01 (`recut-load-before.txt`),
so any throughput in it is PRELIMINARY and decides no gate.

### Changed -- torture NEST retention lane gates on exact counts (dev-only, not shipped)

`test/torture.mjs` phase 4c (NEST retention) no longer gates on the resident heap delta: `heapUsed` noise
crossed the 64 KB bound with every exact term green (b51; b60 1 of 43; burst 61 5 of 60 runs). It now gates
on exact counts: a 6-object WeakRef census over 161 sampled cycles with a live/dead control, a free-list
census that drains every free node and link slot (1021/1021 nodes, 4095/4095 links) and requires one more
node to throw `CapacityError`, and post-drain `stats()` equality. `res=<x>KB(adv)` stays an advisory print;
the new gate token is `free=<n>/<n>n,<l>/<l>l`. Teeth: two retention mutants the old gate passed (every
1000th disposal skipping the free list; an unobserve (`off()`) that leaves its lifecycle entry behind -- on the
0u engine; since LEDGER #40 disposal drops the entry too, see below) now fail. 60 of 60 runs ok
under quiet-lock (res advisory -175.5..209.0 KB).

### Changed -- test/34 heap gate -> exact counts; torture NEST NITs (dev-only, not shipped)

`test/34` section 11's 64 KB resident-delta gate flaked (85 KB run alone on HEAD). It now gates on exact
counts: the `activeNodes` / `activeLinks` baseline, a free-list drain (1022/1022 nodes, 4096/4096 links; one
more throws `CapacityError`) and a WeakRef census over 322 sampled user closures with a live/dead control; the
delta prints as advisory. It fails on two retention mutants the old gate passed. `test/torture.mjs`: the
NEST sampled count is derived (161) and gated, an unmeasured link drain prints `unmeasured`, and comments say
what the census can and cannot see. Note: removing the unobserve's delete (M-OFF) is no longer visible to the
torture NEST lane; `test/13` and `test/62` catch it.

### Changed -- torture phase 2b alloc lanes -> retention slope; test/64 alloc mutants; test/68 (dev-only, not shipped)

`test/torture.mjs` phase 2b (set, untrack): the min-over-batches 0 B/op floor read the instrument's per-batch
constant k (16 B per 2e4-call batch, 0.0008 B/op) as per-op bytes and failed test/64's live lane under load
(b64, b71); `--no-concurrent-osr` reproduces it 6/6. Both lanes now use phase QS's interleaved one-call
retention slope (1 vs 5 steps per call, k cancels, up to 3 attempts, all fail-closed), which catches a retainer
down to 1 per 1e5 steps (the old floor: 1 per 2e4). b72 adds `aset` / `aun` to test/64: one `{ n }` retained per
1000 calls in `read.set` / `untrack` must turn the phase-2b retention-slope lane red (`| alloc=` > 0 and a
`set|untrack alloc fail attempt` line). New `test/68-soak-taint-boundary.test.mjs`: boundary rows for the soak
taint-skip gate (the inclusive 0.35 edge, totals past 2^31 / 2^32 / 2^53, fail-closed inputs). `npm test`:
test/64 5 -> 7, test/68 new: 7 pass (b73: the 2 QA todo rows fixed -- a taint-skip count that is not a safe non-negative integer reads NaN -> INCONCLUSIVE, never PASS).

### Added -- test-gap gates: torture must-fail control, hot-body source pins, LEDGER #40 boundary probes (dev-only, not shipped)

`test/64-torture-mustfail.test.mjs` (7 tests) runs `test/torture.mjs` under `--expose-gc` on the working-tree
engine and on five mutant engines built in a temp dir. The live run must end `| ok` with full drains
(1021/1021 nodes, 4095/4095 links) and retention 0/966. Each mutant must exit 1 with a `| FAIL` GATE line AND
its own breach (observed): every 1000th disposal skipping the node free list -> `free=811/1021n`; skipping the
link free list -> `4032/4095l`; disposal keeping `node.value` -> `retention=1/966`. A crashed child (no GATE
line) fails the test, and a mutant whose anchor text is not found exactly once fails it (re-anchor). The
unobserve-leaves-its-entry mutant of the NEST lane entry above is not in the set: since LEDGER #40 disposal
drops the entry and torture cannot see it by design. Runs inside `npm test` (count verdicts; the torture's
only timing term is its 4 ms cap on a GC pause inside a window). b72 adds `aset` / `aun`: one `{ n }` retained
per 1000 calls in `read.set` / `untrack` must turn the phase-2b retention-slope lane red (`| alloc=` > 0 and a
`set|untrack alloc fail attempt` line).

`test/65-hot-body-pins.test.mjs` (14 tests) pins the sha256 (first 16 hex) and UTF-8 byte length of the source
text of the 7 hot functions (`flushEffects`, `executeEffect`, `createNode`, `nodeMiss`, `disposeNode`,
`effectTail`, `pullComputed`). V8-independent (source, not bytecode): any edit to a hot body fails with the
function's name until it is re-pinned on purpose in the same change (`HOT_BODY_PRINT=1` prints the current
table). Sibling of `bench/soak/parity.json`, which pins the whole file. Its extractor ignores braces in
strings, templates and comments, and fails closed on a missing or duplicated name.

`test/63-lifecycle-boundary.test.mjs` (33 tests) holds boundary probes for LEDGER #40 (`observeObservers`
lifecycle entries across dispose, slot reuse, stale unobserve, destroy, and the lifecycle-count wrap), ported
from the burst-62 qa scratch suite; 30 of 33 are red on the engine before #40. `test/62` gains row A9 (now 20
tests under `--expose-gc`, 15 without): an unobserve must really delete its entry (a mutant that only
decremented the count while keeping the entry passed test/13 and test/62 before); green on the current and the
pre-#40 engine (a regression pin, not a red-first row). `npm test`: 1584 -> 1637 tests (+53: test/63 33,
test/65 14, test/64 5, test/62 1), 0 fail.

### Changed -- soak models the R2-M1 creation abort; `preb33` control; DIV-F6 widened (dev-only, not shipped)

DELTA 4b (eb5acc2). The soak model predicts the O6 `CycleError` at `effect()` creation when the kernel aborts
a write-cycle creation (`creationAbort`), else at the `cyc:1` set; an unmodelled creation cycle inside a
batch or frame fails closed. New byte-frozen control `preb33` (1.6.0-dev at 7c65afd, the last kernel before
the F-b33-1 fix, post-F21; a DIV-F21 label on it is a FAIL) in `bench/soak/controls/preb33/`. DIV-F6 gains
3 standalone shapes: the known=none `preb33` ERROR heads are the computed-site twin of F6 (`pullComputed`'s
pre-walk has no catch, so a throwing dep leaves the computed's version unchanged and the equality cutoff
hides the recovery; present in 1.5.2). Full unmasked enumeration of all 17039 failing `preb33` worlds:
known=none 0. `_mustfail` P-INTERIM-ERROR-clean now runs on `preb33` with no patches and expects exit 1,
`explained` by [DIV-F5, DIV-F6, DIV-F22]; `preb33` is frozen without a FIX-T kernel, so it stays exit 1
permanently. `bench/soak/parity.mjs` pins 33 files (was 29; adds `adapters/lite.mjs`, `controls.json`,
`controls/preb33/Signal.js` and `Watch.js`). Calibration recut (`calibrate.mjs --write --timed`, quiet-lock,
2026-10-17 UTC, 737 s): every deterministic cell identical, only provenance and `pinnedSha256` moved;
throughput PRELIMINARY (host noisy: load 2.67 at start, 9.30 at end, another process).

### Fixed -- soak wrap job: `soak:wrap` refuses a NEARWRAP config first; semi-space probe tolerance (dev-only, not shipped)

`npm run soak:wrap` (bench/soak/wrap.mjs) now refuses a `SOAK_NEARWRAP` config before it probes the
pinned semi-space. Refusal order: burn-in keys, `SOAK_NEARWRAP`, semi-space pin, kernel import,
`KERNEL_NEARWRAP`, then provenance. The semi-space probe accepts a `new_space` capacity in
(4 MB - 256 KB, 4 MB] on every node major (`SEMI_TOL = SEMI_BYTES / 16`; node 24 / 26 read
4 MB - 256 B, node 22 reads 4 MB - 70,656 B), so the wrap job runs on node 22 and CI's node 22 job
sees the NEARWRAP CONFIG line (test/41 "the wrap job refuses a NEARWRAP kernel" was red on ubuntu
node 22 since f64e05c). The flag parse is unchanged: unpinned, only `--min-...`, only `--max-...` and any
value other than 4 are still refused. Gates: test/41 (`semiSpaceProblem` band + flag vectors,
NEARWRAP with `--expose-gc` only).

### Fixed -- zerogc torture: an all-inverted retained-bytes witness is re-measured, then reported INCONCLUSIVE (dev-only, not shipped)

The retained-bytes witness in `bench/torture/zerogc-torture.mjs` (new helper
`bench/torture/helpers/alloc-verdict.mjs`) re-measures a run whose every batch bracket inverted
(gc-profiler 1.16.0 verdict `inconclusive`, `bytesPerCall` null, settled) up to 3 attempts
(`ALLOC_ATTEMPTS`). A measured fail and an unsettled run are never retried (an unsettled run FAILs as
UNVERIFIABLE). A witness still unmeasured after 3 attempts is a labelled INCONCLUSIVE note, not a
FAIL: the scenario stands on its exact counters (`poolGrowths` / `totalAllocations` / `activeNodes`)
and, for steady scenarios, the scavenge + nursery window, and the PASS line says so ("(byte witness
INCONCLUSIVE on N scenario(s))"). Previously an inconclusive verdict failed the `semantic torture` CI
step (seen once: churn-plain, 8 inverted batches, ubuntu node 22). Gates: new
`test/55-zerogc-alloc-verdict.test.mjs` (17 tests).

### Added -- soak stream schemaVersion 2, `SOAK_NEARWRAP` (dev-only, not shipped)

The soak stream `SCHEMA_VERSION` is 2: the header carries `nearwrap` (null, or `{phase, k, rewrites, baseSha256,
derivedSha256}`) and the gates block carries the wrap job's 8 constants (`SEMI_SPACE_MB`, `WRAP_CHUNK`, `NS_K_CYCLE`,
`WRAP_MAX_NODES`, `W4_SAMPLE_MASK`, `REPR_TIMEOUT_MS`, `BASELINE_MAX_BYTES`, `NEARWRAP_K_MAX`). New key
`SOAK_NEARWRAP=<sign|zero>:<k>` (k 1..64) runs the lanes on a kernel derived by `bench/soak/nearwrap.mjs` with its
wrap counters preset k below their ceiling; it is never release evidence (`soak:report` exits 1 with its own
`NOT A RELEASE SOAK -- nearwrap`, after the mustfail / smoke / non-lite reasons). The header's `nearwrap` must match the config key, and the key is refused with
`SOAK_ENGINE` other than lite. A schemaVersion 1 stream is refused (`INTEGRITY -- header`).

### Added -- CI (dev-only, not shipped)

`.github/workflows/ci.yml` (npm test + torture on Node 22 / 24 / 26 and macOS Node 24;
parity, perf gate and a soak smoke checked by `soak:report` on Node 26.8.2) and
`soak-nightly.yml` (a release-shaped 33 x 200000 burn-in judged by `soak:report`,
`soak:teeth`, `soak:teeth:long`). The tree soak steps are report-only while teeth.mjs GAPS
lists P-TREE. `package-lock.json` is now committed. `test/47` guards the workflow files
(closed-world schema + sha256 pin).

### Changed -- engine: `isTrackingDeps` folded into `currentObserver` (LEDGER #30)

The separate `isTrackingDeps` boolean is gone. Tracking is now on iff
`currentObserver !== null` -- the flag and the observer pointer were always set and cleared
together, so the flag was pure redundancy in every hot read body. The read fast-paths
(`signal`/`computed` closures, `boxGet`/`boxComputedGet`) drop one guard, and
`executeEffect`/`pullComputed` drop two context stores per run. `untrack` and the
`subscribe` callbacks (callable and box) now null the observer for their window and restore
it gen-safely -- the observer is put back only if it survived the window
(`po.gen === pg`), mirroring `disposeNode`'s self-dispose guard so a body that disposes its
own observer inside `untrack` never re-seats a recycled slot. Equivalent to the measured
`futureVersions/K1-candidate-30.diff` (0 per-test conformance diffs, cold-process bench
2-10% faster). New standing witness `test/torture.mjs` (`npm run test:torture`) gates the
two hot paths with maxMajor 0 and a 0 B/op retention slope (b72: the phase-6 QS estimator -- one
measureAllocs call per attempt, 2e4-call pseudo-batches alternating 1 and 5 steps per call, up to 3 attempts;
it replaced min-over-batches, which read a 16 B per-batch constant as 0.0008 B/op),
the create/dispose cycle back to baseline, and the
effect-self-disposes-inside-untrack case; `@zakkster/lite-leak` joins as a devDependency
(runtime `dependencies` stay empty). Boundary suite `test/34-observer-fold.test.mjs` (24
cases: the `isTracking()` truth table, untrack depth 0..64, throwing untrack, self-dispose
inside untrack including slot recycling, subscribe self-dispose, createRoot / runWithOwner
inside untrack, nested-subscribe ownership, 1e4-cycle churn with a resident delta of 38 KB).
Pipeline: planner -> coder -> reviewer (rejected once, on docs) -> qa, all green.

### Added -- gate 1 runner `harness/conformance.mjs` (`node harness/run.mjs conformance [A] [B]`)

Runs the lite column of the external johnsoncodehk reactive-framework-test-suite (178
conformance + 18 behavioral cases, `REACTIVE_SUITE_PATH`) against one or two engines under the
suite's own `vite-node`, and prints a PER-TEST diff (a candidate that fixes one case and
breaks another keeps the same total). #179 is the documented absorption contract (LEDGER
#15). Exit 0 / 1 (difference) / 2 (suite or engine missing -- fail closed). Ported from the
LiteSignalExperimental fork's `harness/reactive-suite/run.mjs`, which counted pass/fail only.

### Added -- two VersionMatrix workloads

- `mux` (256 inputs -> one sum computed -> one effect): the long dep-list walk that exposed
  #10 and #12, absent from the five original workloads.
- `effect-fanout` (one source -> 512 effects): the effect-dense flush (bar 1b). The resident
  `broadcast-fanout` is a KAIROS shape that runs ONE effect per write, so it could not see
  an `executeEffect` / flush-loop regression.

### Added -- `harness/layout-ab.mjs` (`node harness/run.mjs layout [A] <B>`)

The instrument that caught #27, made permanent. One cold child process per cell, A/B order
alternated per rep; eight shapes; a 1e3-1e5 size sweep of a resident graph that states the crossover; a
resident-memory lane (`heapUsed + arrayBuffers`, forced full-GC time) including both sides
of two power-of-two link-count boundaries. Exits 1 if any child fails. Not a gate.

### Changed -- fail closed

- `harness/VersionMatrix/gate.mjs`: a floor or rolling capture missing for any manifest
  workload is now `NO EVIDENCE` (exit 3, recapture). It used to pass that axis vacuously,
  so a newly added workload gated nothing.
- Memory witnesses now count `heapUsed + arrayBuffers`, because `heapUsed` cannot see
  typed-array backing stores: the torture retention witnesses (`torture-soak`,
  `graph-fuzzer`, `scheduler-bench`, via the new `helpers.residentBytes()`), the zero-GC
  tests `04` and `09`, and the microscope's heap column. The perf-gate lane already judged
  `arrayBuffersKB`.

### Added -- soak harness tooling (dev-only, not shipped)

`bench/soak/` is a randomized burn-in of the engine against a naive reference model. Nothing here is in
`files[]`; `Signal.js`, `Watch.js` and `Signal.d.ts` are untouched by it.

- S1a/S1b: fail-closed `SOAK_*` config, seeds, JSONL stream, `SOAK_KERNEL` seam, provenance header, parity pin
  (`npm run soak:parity`); naive model, oracles O1c/O1e/O2/O4/O5/O6/O7a, op-script generator, executor and the GRAPH,
  BATCH, ERROR and NEST lanes (tests 40, 41 and 43). Against the published 1.5.2 the lanes find F5, F6, F7 and F15;
  the ERROR lane found F21 and F22.
- S1c: `gates.mjs` (verdict ladder; check-floor, taint-skip and coverage evidence gates that go INCONCLUSIVE, never
  PASS), `boundary.mjs` (forced-GC drain, tracker and WeakRef witness), `divergences.json` (DIV-F22 is temporary;
  DIV-F21 is fixed, fixedIn "A2-F21"), `main.mjs` (`npm run soak`, `soak:smoke`), `replay.mjs` and `shrink.mjs` (`soak:replay`, `soak:shrink`).
- soak: new hard oracle OB (batch-early-run, QA F5): an effect that already ran must not re-run inside an open batch;
  cycle `checks` gain OB.
- soak: provenance `gitInfo` scrubs GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_COMMON_DIR / GIT_OBJECT_DIRECTORY
  from its git child env (exported `GIT_SCRUB_ENV`, QA F6), so an inherited variable can no longer make a soak header
  stamp another tree's SHA or dirty state. `GIT_CONFIG_*` stay inherited; config-level `core.worktree` is a known gap.
  No new config key.
- S1d: `SoakReport.mjs` (`npm run soak:report -- <stream>`) re-derives a stream's verdict with the code that judged it:
  exit 0 `verdict <V> (consistent)`, exit 1 `INTEGRITY -- <class>` or `NOT A RELEASE SOAK -- mustfail|smoke|non-lite|
  nearwrap|overridden-kernel|tree-parity|lane-subset|volume|provenance`, exit 2 CONFIG (test/46, 177 tests). Kernel identity is
  self-reported (residual).
- soak release policy (maintainer decision c): a tree run is release evidence only for the full roster at default
  volume (SOAK_OPS >= DEFAULT_OPS and >= DEFAULT_CYCLES completed cycles per lane; an interrupted cycle does not
  count) from a clean committed tree (gitSha a 40- or 64-hex commit sha, gitDirty false, gitError null); anything else
  prints `NOT A RELEASE
  SOAK -- lane-subset|volume|provenance`. A pinned control kernel skips that tree policy and prints `NOTE -- control
  kernel <name>, not release evidence`, exiting 0 unless mustfail / smoke / non-lite refuses it. The decision is the
  exported pure `releaseRefusal()`. `parity.json` also pins `config.mjs`
  and `SoakReport.mjs` (decision b; 23 pinned files then, 29 since 8c3eb9a, 33 since eb5acc2).
- Calibration: `calibration/calibrate.mjs` + `soak-calibration.json` (seed 0xC0FFEE, 11 x 100000 + smoke, headpatched
  and 1.5.2): DEFAULT_OPS 100000 and SCEN_MIN 8 kept; CHECK_FLOOR 1000 -> 10000, CHECK_FLOOR_SMOKE 250 -> 500,
  TAINT_SKIP_MAX 0.5 -> 0.35; drift guard in test/41 (superseded b74: the binding NEST cells are now the tree kernel's,
  see "Changed -- soak D4" above).
- Teeth: `teeth.mjs` (CHECKS / GAPS, ceiling 26, may only shrink / UNREACHABLE, `audit()`) and `_mustfail.mjs` (30
  controls through the real `main.mjs` on pinned scratch kernels). `npm run soak:teeth` (short), `soak:teeth:long`
  (L-* controls); `MUSTFAIL_LIST=1`, `MUSTFAIL_ONLY=<regex>`, `MUSTFAIL_HEADS=1`. `soak:report` prints
  `NOTE -- teeth GAP gate=<ids> oracle=<ids>`. test/45 audits the registry against literal ceilings.
- soak: the BATCH `cov-off` switch no longer leaks. `lanes/batch.mjs` guarded on script codes while the detector
  (`scenarios.mjs`) compares decoded values with `Object.is`; VALUE_POOL aliasing (codes 0 / -1 and 1 / -3 decode
  equal) let a revert through. The guard now compares decoded values: 0 hits on every `cov-off` cell and every
  `covOffSweep` cell (5 cov-off scenarios x 17 seeds x 2 kernels = 170 cells), clean streams byte-identical, and
  `T-cov-BATCH` is back on `--smoke`.
- soak: the ERROR lane gains OB in its hard oracles (decision e): a clean ERROR run performs OB 193019 (headpatched) /
  115043 (1.5.2) times at 11 x 100000, and OB is now each ERROR cell's least-performed oracle. At 11 x OPS_MIN ERROR
  OB (2152 / 1227) joins BATCH OB (8295 / 1789) and NEST O7a (413 / 502) below `CHECK_FLOOR`; only GRAPH clears it
  (superseded b74: the NEST cells 413 / 502 are fail-stopped rows; tree NEST O7a at 11 x OPS_MIN reads 672, and tree WIE
  O5 14323 also clears).
- soak: test/41 (40 tests, now ~32 s on an M4 Pro) adds a live large-world probe (decision d): main.mjs
  runs GRAPH 11 x 33000 on headpatched and its fold must equal the recorded `probe.fold`, with one LARGE world in
  every
  cycle. The pinned set drops `main.mjs` and `calibrate.mjs` (an edit of either was a ~13-minute recut) and adds
  `kinds.mjs` and `bench/torture/helpers/index.mjs`. Recut 2026-10-17 (UTC): one `--timed` run of 737 s under quiet-lock
  (sequential children, throughput REPORTED and PRELIMINARY: host noisy, load 2.67 at start, 9.30 at end; decides no
  gate); the `kernels.*.full` / `smoke` counts are unchanged.

### Docs

`LEDGER.md` gains the laws' size-axis and allocation-site corollaries, Law 7 (creation cost
is survival, not allocation), section G (#27 / #28 and the independent re-measure), section
H (the 2026-09 weak-point analysis of Andrii's harness: #29 rejected, #30 candidate, #31
null), and the new gate rules. README's VersionMatrix section lists all seven workloads.
`LEDGER.md` section J records two engine defects found by the 1.6.0 soak work: #34 (F20,
int32 closure counters allocate on pointer-compressed V8; open) and #35 (F21, stale queue after a
CycleError; fixed in this cycle, with KNOWN residuals R1 / R2). New `decisions/0001-soak-design.md` (dev-only ADR) records the soak design, the
F5 / F6 decisions and their rejected alternatives.
README's "Counter widths and wrap limits" table (inside "The case for object pooling", also in `llms.txt`) states each
engine counter's width, exact wrap condition and pin; its `nodeSeq` row spells out the consequences of node id 0 at
allocation k * 2^32 (an `onGraphMutation` listener that reads `intB === 0` as "no second id" without the opcode misreads
a link to node 0; `restore()` throws a `TypeError` on a node id or `ownerId` of 0) and that `destroy()` does not reset
`nodeSeq`. Docs only; no engine change.

## [1.5.2] -- 2026-09-19

Dev-only session: a standing, self-validating zero-GC judge. `Signal.js` is
byte-identical to 1.5.1 except the version banner comment; no API change, no
behavior change, no engine logic moved. `Watch.js`, `bench/`, `harness/`, and
`conformance/` are untouched.

### Added -- perf-gate lane (dev-only, engine-frozen)

`@zakkster/lite-perf-gate` (`^1.4.2`, devDependency only -- runtime `dependencies`
stay empty) joins as the standing verdict on lite-signal's headline zero-GC
claim. New file `test/32-perf-gate.test.mjs` wires `zgcSuite()` over seven
claimed-zero steady-state paths, each anchored to its `llms.txt` "Performance
characteristics" claim and warmed inside `setup()` so the measurement window
sees only steady state: `set-propagate` (1 signal -> 8 computeds -> 1 effect,
synchronous flush), `computed-cache-hit`, `computed-recompute-stable`,
`effect-rerun-stable`, `peek`, `batch-flush` (3 sets/batch), and
`box-set-propagate` (the 1.5.0 `signalBox`/`computedBox` surface). Five signals
judge every run -- scavenges, engine counters (`totalAllocations` /
`totalDisposals` / `poolGrowths`, all budgeted to 0 via per-scenario
`statsOf`), retained heap, old-gen, and external/arrayBuffers -- at two scales
(N and k*N), with positive/negative/large detector controls validated on every
invocation. Two permanent negative controls keep the gate honest: a per-op
object allocator and a per-op `signal()`+`dispose` churn (the documented
264 B/op creation path); both MUST trip the gate.

New script `test:gate` (`node --expose-gc --max-semi-space-size=4 --test
test/32-perf-gate.test.mjs`) runs the gate for real; it is appended to
`test:all`. The gate file guards on `--expose-gc` AND `--max-semi-space-size=4`
and otherwise emits ONE loud named skip, so plain `npm test` stays green: this
lane adds exactly one loud named skip over 1.5.1 (pass count unchanged; the
other skip is the architecturally-N/A SSR case). `node:test`'s absolute leaf
tally is node-version-sensitive -- on node v26.8.2 `npm test` reports 513 pass /
2 skip. The 16MB `test:gc` lane never produces a false red. Thresholds are lite-perf-gate
defaults, untouched.

### Docs

`llms.txt` gains the perf-gate version note and the fixed 13-key `RegistryStats`
interface block (`nodePoolPopulation` / `linkPoolPopulation` were described in
prose since 1.5.0 but missing from the interface listing). README Testing
strategy gains the gate lane.

## [1.5.1] -- 2026-09-05

Docs + verification patch. `Signal.js` is byte-identical to 1.5.0 except the
version banner comment; no API change, no behavior change. Ships the corrected
allocation economics below to the `latest` line while `1.6.0-rc` bakes.

### Added -- mint-cycle allocation anatomy probe (harness, no engine change)

A dedicated probe (`harness/mint-anatomy.mjs`, dispatched as `mint`) pins the
per-op heap cost of every creation primitive's mint+dispose cycle on a pre-grown
fixed-ceiling registry (`createRegistry({maxNodes:1<<16, maxLinks:1<<18,
onCapacityExceeded:"throw"})`). Fresh child process per (variant, warmup) cell --
JIT tier state poisons same-process comparisons. `Signal.js` / `Signal.d.ts`
untouched; this is verification + attribution only.

**Corrected numbers** (all-space B/op, node v26.3.1 darwin/arm64, pre-grown
throw-policy registry, slope over ops windows {1000,4000,16000} so the sampler
constant cancels):

| cycle (mint + dispose) | all-space B/op | note                                    |
| ---------------------- | -------------: | --------------------------------------- |
| `signal(1)` + dispose  |            264 | tier-invariant                          |
| `computed(fn)` + dispose |          208 | 4 own props, no `set`/`update`          |
| `effect(fn)` + disposeFn() |        160 | 2-prop disposer + 3-slot context        |
| `signalBox(1)` + dispose |           56 | `Object.create(proto)` handle, 0 closures |
| `computedBox(fn)` + dispose |        56 | same                                    |
| dispose side (all forms) |            0 | mint-and-hold equals the cycle to +-0.3 B |

LiteStore LS-06's ~209 B for the signal cycle was a **new-space-only reading at a
pre-TurboFan tier**: below ~15-25k lifetime mints, ~56 B/op of closure-feedback
plumbing lands in OLD space, invisible to a `new_space` delta. The total was
always 264. `--no-turbofan` freezes the new-space witness at 208 forever;
`--no-maglev` shows 264 immediately; all-space totals never move (264.3 at every
tier). Hence the methodology rule this probe enforces (P3, and the sampling-profiler
cross-check in the findings): **allocation accounting must sum `space_used_size`
over ALL heap spaces** -- a new-space-only delta is valid only for scavenge-churn
characterization, never for per-op cost.

**Pooling accessor closures with their nodes -- evaluated and REJECTED (fail-open).**
Reusing one accessor-closure identity across dispose/reuse makes a retained stale
handle and a fresh handle *the same object* (`a === b`), so both holders share one
captured `birthGen` and the ABA gen-guard -- checked at the only place it runs and
pinned by `probe-c1-stale-set` / `probe-c1-stale-read` -- becomes undecidable: a
stale `a()` reads the recycled slot's new resident, a stale `a.set()` overwrites
it. That fails open; suite law is fail closed. **Fresh accessor identity per mint
is load-bearing** for the stale-handle contract and cannot be repaired by any stamp
placement. The callable path's ~264 B is therefore the documented, irreducible
price of `count()` / `count.set(x)` ergonomics; **`signalBox` (56 B/op, same graph,
same but DECIDABLE guard -- each box carries its own `NODE_GEN`) is the sanctioned
cheap path** (-79%). FinalizationRegistry-gated recycling is semantically sound but
allocates per mint, makes reuse GC-scheduled, and retains every accessor until
finalization -- rejected too.

Run it: `node harness/run.mjs mint [--verify]` (`--verify` applies relative pins
P1..P5; exit 0 iff every cell succeeded and every pin passed).

### Added -- attribution instrument set (harness-only, none ship in the tarball)

- `harness/costmodel.mjs`, `creation-anatomy.mjs` (+ child), `floors.mjs`
  (+ `floors-history.json`), `jit-health.mjs` (+ `jit-baseline.json`),
  `trend.mjs`, `visit-anatomy.mjs`; VersionMatrix `creation-churn` workload +
  same-host 1.3.0/1.5.0 reference baselines. Verification instruments only.

### Changed

- devDependencies: `@zakkster/lite-devtools` ^1.2.0 -> ^1.3.1,
  `@zakkster/lite-gc-profiler` ^1.15.0 -> ^1.16.0 (the instrument versions the
  suite is gated with). Runtime dependencies remain zero.

## [1.5.0] -- 2026-08-21

**Stable 1.5.0.** Graduates `1.5.0-rc.3` to the release line with **no further engine
change** -- `Signal.js` / `Signal.d.ts` are byte-identical to rc.3 past the version
header, and the zero-GC gates (`bench/torture/run.mjs` 22/22) are unchanged. This is
the first stable to carry the **1.4.5 `createRegistry` input validation** (folded in
at rc.3; see below) on top of the 1.5.0 surface: `signalBox` / `computedBox`,
`createRoot`, and `getOwner` / `runWithOwner`. Drop-in over 1.4.5 for the callable
API; the only observable delta on existing code is `stats()` growing 11 -> 13 keys
(purely additive). The full rc/beta history is retained below.

## [1.5.0-rc.3] -- 2026-08-20

Backports the **1.4.5 `createRegistry` input validation** (all four findings) onto
the rc.2 engine. This is the first engine change since the RC line began -- the hot
paths are still byte-identical to 1.4.0; only `createRegistry`'s *cold* construction
path gained validation, so the zero-GC gates (`bench/torture/run.mjs` 22/22) are
unchanged. If you had a typo in your registry config, you will now hear about it.

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
  of physically constructed nodes/links (`nodePool.length` / `linkPool.length`),
  distinct from the `*Capacity` ledgers. A silently mis-set `prealloc` is now
  observable (population 0 under lazy) instead of telemetry-blind. **This is the one
  observable API change: `stats()` grows 11 -> 13 keys, purely additive** -- no
  existing key changed; only an exact key-*count* assertion is affected (updated
  in `test/03-pool.test.mjs`).

### Tests

`test/30-config-validation.test.mjs` adds the full 25-config matrix, the did-you-mean
cases, the eager ceiling, the population contract, and the three OOM rows as isolated
child-process cases (`test/30-config-oom.child.mjs`) proving the fixed engine throws
+ exits 0 under a 256 MB cap where the unvalidated engine died.

## [1.5.0-rc.2] -- 2026-08-18

Version-only bump over rc.1; engine byte-identical past the header. Superseded by
rc.3, the first entry to carry an engine change.

## [1.5.0-rc.1] -- 2026-07-27

Release candidate for 1.5.0. Promotes `1.5.0-beta.8` with **no engine change** --
`Signal.js` and `Signal.d.ts` are FROZEN: byte-identical to beta.8, hot paths
byte-identical to 1.4.0. What this RC finalises is the *torture surface*: it is
brought to full **parity with 1.4.4** at **22 scenarios (19 semantic + 3 soak)**.
This work is **verification-only** -- the added test/bench material OBSERVES the
frozen engine and pins its ACTUAL behaviour; nothing in the engine moved.

### Changed -- the torture suite is now at full 1.4.4 parity (22 scenarios)

The `bench/torture/` runner (`run.mjs`) now registers **22** scenarios in two
groups -- **19 semantic + 3 soak** -- up from the sixteen (13 semantic + 3 soak)
the earlier RC listed. Six scenarios are finalised here, ported from 1.4.4 and
re-pointed / re-targeted to the surface 1.5.0 actually ships:

- `owner-torture` -- getOwner/runWithOwner capture-restore, live adoption +
  cascade-dispose, ABA stale-handle -> rooted degradation, dep isolation. 1.5.0
  has no `createScope`, so every owner scope is built from an **effect as the
  unit of ownership** (getOwner() inside an effect body captures that effect;
  its stop() cascade-disposes adopted children).
- `error-torture` -- throwing effect bodies: per-effect buffering, exact-order
  `AggregateError`, single-throw re-thrown unwrapped, buffer drain flat over
  4096 throw/clean cycles. Confirmed byte-identical to 1.4.4 (Signal.js :816 /
  :823-825 / :829-839).
- `deep-chain-torture` -- `pullComputed` recursion fails closed with a
  **RangeError** at depth; the iterative push path stays open at equal depth.
- `zerogc-torture` -- the zero-GC hot path made falsifiable via
  `@zakkster/lite-gc-profiler` (a **dev-only** dependency; `dependencies` stays
  empty). `ZEROGC_BREAK=1` self-test confirmed to reject a planted allocation.
- `introspect-torture` -- describe/forEach*/hasObservers/ownerOf + the ABA
  gen-stamp guard. Section 7 (ownerOf/forEachOwned) re-targeted off `createScope`
  onto an effect-body owner.
- `lifecycle-torture` -- createRoot detachment + destroy registry reset; the
  root-vs-owner scenario nests `createRoot` inside an effect body so detachment
  is observable. `destroy()` leaves `stats().activeNodes === 0`.

**First-time execution on the 1.5.0 engine.** Several lanes that only ever
SKIPPED on earlier cuts now EXECUTE here for the first time: `box-torture`
(signalBox/computedBox), the **`churn-box`** lane inside `zerogc-torture`
(signalBox create+dispose churn -- retains 0 B/call, `poolGrowths` delta 0,
`activeNodes` back to baseline), and the owner/root lifecycle scenarios
(`lifecycle-torture` + `owner-torture` via getOwner/runWithOwner/createRoot).

Every scenario feature-detects and **skips cleanly** below the version that
introduces its feature. On the 1.5.0 engine the runner executes **15 semantic
scenarios** and reports a clean SKIP for the four feature-gated later-version
ones: `scope-torture` (1.6.0 `createScope`), `flush-torture` (1.7.0
`flushStrategy`), `cleanup-return-torture` (1.8.0 effect-return cleanup), and
`dispose-torture` (1.9.0 `Symbol.dispose`). Each of the three soaks now carries
an `Int32Array` value-correctness oracle (allocated once, a rotating sampled
window per tick with zero per-tick allocation, a full sweep at teardown).

**Final verification for this RC (`--expose-gc`):**

| group | result |
| ----- | ------ |
| `torture:semantic` | 19/19 pass -- 15 executed, 4 clean skips (scope/flush/cleanup-return/dispose) |
| `torture:soak` | 3/3 pass -- zero errors, every pool back to its leaf-only floor, oracle sweeps 0 mismatches |

The mutation-evidence table in `bench/torture/README.md` is unchanged and still
holds: the soaks catch 1 of 5 injected engine defects, the semantic files catch
5 of 5, and each of the feature-scoped mutants is caught only by its dedicated
scenario.

### Changed -- README and llms.txt torture sections corrected

Both root docs now describe the **22-scenario suite (19 semantic + 3 soak)**, the
15-run / 4-skip split on the 1.5.0 engine, the six scenarios finalised in this RC,
and the feature gates -- matching `bench/torture/run.mjs`. The unit test count is
updated for the new `test/29-throwing-equals` (7 tests).

### Added -- test/29-throwing-equals

A new `test/29-throwing-equals.test.mjs` (7 `it()` across three call sites)
pins the behaviour of a user `equals` predicate that THROWS at each of the three
LOGICAL sites the engine invokes it on the callable surface: signal-set pre-check
(Signal.js :1096), batch-revert check (:1103), and computed re-eval (:977). A
raw grep shows five physical `eq()` calls because 1.5.0's `signalBox` mirrors the
callable set path with its own pre-check/revert pair (:1201 / :1208); they
collapse to the same three logical sites and are byte-identical in logic. No
behavioral divergence from 1.4.4 was observed -- every assertion holds identically.

### Notes -- unit suite and the devtools real-boot rig

The unit suite is **461 tests: 460 pass + 1 skip, 0 fail** (the architectural SSR
N/A in `17-reactivity`) in the full workspace, i.e. with the sibling
`@zakkster/lite-devtools` resolvable, and now includes the 7-test
`test/29-throwing-equals`. `test/25-devtools-real-boot.test.mjs` is a 10-test
real-rig that boots the installed Devtools against the local engine; a bare
checkout without that sibling cannot resolve the specifier and reports 10 fewer.
No engine test regressed; the gap is purely the sibling package's presence.
`@zakkster/lite-gc-profiler` is added to `devDependencies` for `zerogc-torture`;
it is dev-only and `dependencies` stays empty (zero runtime deps).

Nothing new ships in the tarball: `files[]` still excludes `bench/`, so this RC's
publishable surface (`Signal.js`, `Signal.d.ts`, `Watch.js`, docs) is identical
in bytes to beta.8 apart from the version strings. Drop-in over 1.5.0-beta.8.

## [1.5.0-beta.8] -- 2026-07-22

### Added -- `box-torture`, and the torture suite reaches the box surface

The 1.4.1 torture reorganization -- one runner (`bench/torture/run.mjs`), the
`semantic` / `soak` split, the shared `helpers/`, and the five semantic
scenarios -- is the floor this release builds on. 1.5.0 adds a sixth semantic
scenario, `box-torture`, targeting the new `signalBox` / `computedBox` surface.

The boxes are documented as the same `ReactiveNode` and the same zero-GC
read/write path as the callable forms, with full interop in one graph. That is
precisely the kind of claim that rots silently: a divergence between the two
representations produces correct-looking behaviour in any test that exercises
only one of them. So `box-torture` does not lead with box-specific unit
assertions. Its centrepiece is the same differential fuzz `oracle-fuzzer` runs --
a random DAG checked against an independent uncached reference evaluator -- with
**every node independently realised as either a callable or a box**. The
reference does not know which is which. If the two representations ever disagree
on a value, on equality, or on dynamic dependency tracking, a mixed graph is
where it surfaces and a single-representation suite never would. The remainder
pins the surface the callables do not have (`subscribe` immediate-fire /
untracked-callback / idempotent-disposer, `update`) and the allocation-light
representation itself (zero own enumerable data beyond the two internal handle
slots, a stable shared prototype, never `setPrototypeOf`) -- the last being a
design law, not an implementation detail.

Mutation-verified, and the mixed-graph dimension is not decorative:

| mutant | caught by | missed by |
| ------ | --------- | --------- |
| `boxGet` skips dependency tracking | box-torture (299/300 seeds) + unit `24-signalbox` | -- |
| `computedBox` default equality `Object.is` -> `===` | **box-torture only** (33/300 seeds) | unit `24-signalbox` (12/12 pass), callable-only `oracle-fuzzer` (400/400 pass) |

The second row is the reason the scenario exists. A `computedBox` that silently
downgrades its default equality is invisible to the box unit suite and to the
callable fuzzer; only a graph that mixes both representations and fuzzes the
`-0` / `NaN` value boundary at a box-computed node position catches it.

`24-signalbox` moves from `{skip:true}` (its state on the 1.4.x line, where the
API did not exist) to fully live. The unit count rises to **453 passing** (1
skip, the architectural SSR N/A in `17-reactivity`), up from 405 on 1.4.1.

### Changed -- torture sources are ASCII (again)

`bench/torture/box-torture.mjs` shipped with em dashes and box-drawing
characters, and `helpers/index.mjs` had regained them. `Signal.js` is pure ASCII
and the ecosystem source rule permits only the sanctioned multiplication and
micro signs, so both were normalised (`--`, `<=`, `-`). The published surface is
unaffected either way -- `files[]` excludes `bench/`.

### Changed -- benchmark harness rewritten (bench protocol v3, breaking)

`bench/` is rebuilt around three instruments with fixed, non-shared configs and a
machine-generated `#STAMP` on every output (engine + harness sha256, the live
registry config echoed from the same frozen object handed to `createRegistry`,
host, node): the **microscope** (`benchmark.mjs` -- lite's recommended eager config
on six first-party shapes), the **mirror** (`mirror.mjs` + `sweep.mjs` -- Andrii's
canonical adapter verbatim, cross-framework rows diffing 1:1 against his log), and
**version economics** (`harness/toe-to-toe`). Hand-written result headers are
abolished; nothing is publishable without a `#STAMP`. See `bench/README.md`.

### Deprecated -- `bench-reactive-legacy`

The pre-v3 five-framework reactivity suite (`benchmarkReactive.mjs`) is retained one
release as `bench-reactive-legacy` and will be **removed after 1.5.1**. Use the
mirror for cross-framework standing.

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

### Changed -- branch coverage closed to 100%

Branch coverage on `Signal.js` went `97.35% -> 100%`. Three reachable branches
gained tests (`allocateLink` dead-target gate, `executeEffect` scheduler
re-entrancy, `computed` stale-handle read), the new box + owner surface gained
tests (box stale-handle guards, `computedBox` `equals`, top-level `getOwner` /
`runWithOwner` delegators), and the two provably-unreachable clamps (link-ledger,
`batchEpoch` wraparound) carry `/* c8 ignore */` with proofs. See
`COVERAGE-NOTES.md`; reconfirm under codify.

### Tooling -- harness reorganization (no engine change)

The loose `harness/` probes are now routed through a single dispatcher
(`harness/run.mjs`) and exposed as npm scripts: `harness:field`,
`harness:dispose`, `harness:churn`, `harness:owner`, `harness:creation`, and
`harness:all` (field + dispose + churn in sequence). `harness:field` is the
portable fieldkit verify + cold-child A/B bench; the rest map one-to-one to the
existing probe files. Paths resolve from the dispatcher, so the working
directory no longer matters.

The empirical owner-recycling reproducer is documented at its real home,
`harness/owner-hazard-repro.mjs`; the earlier `Publications/...` citations in
README / CHANGELOG / llms.txt pointed at a path the file was never in, and are
corrected. The broken parent/child link in the createComputations matrix
(`creation-isolated.mjs` now resolves `andrii-isolated-child.mjs`) is repaired.

Six settled one-off probes -- the five from the 1.2.0 -> 1.2.1 construction-
shape regression hunt, plus the superseded `repro-set-after-dispose.mjs` (its
invariant now pinned by `test/07-dispose` and `test/26-free-list-invariant`) --
are parked in `harness/attic/` with a README explaining each. `Signal.js` is
untouched and the published `files[]` whitelist is unchanged, so installed
tarballs are byte-identical; this is a repo-tooling change only.

## [1.5.0-beta.2] -- 2026-07-XX

The re-attach companion to `createRoot`: **`getOwner`** and **`runWithOwner`**
ship on the same additive-surface story as 1.5.0. **No engine change.** The
hot-path function bodies (`pullComputed`, `markDownstream`, `executeEffect`,
`flushEffects`, `allocateLink`, `severTail`, `createNode`, `runCleanup`,
`disposeNode`) are **verified byte-identical to 1.5.0-beta.1** via sha256 over
their extracted bodies. The new primitives are ~20 lines of user-API code plus
two top-level bindings; every read of `currentOwner` still happens at the same
sites (creation, effect body save/restore, cleanup), and the propagation path
remains owner-free per the `markDownstream` invariant comment. Drop-in over
1.5.0-beta.1.

### Added -- `getOwner()` and `runWithOwner(ownerHandle, fn)`

`getOwner()` returns an **opaque, gen-stamped handle** for the current
lifecycle owner (or `undefined` outside any effect/computed body).
`runWithOwner(handle, fn)` runs `fn` with that handle re-installed as the
current owner: effects and computeds created directly in `fn` are adopted
by that owner and cascade-dispose when it re-runs or is disposed. Nulls
the tracking observer for the duration of `fn` (Solid semantics, matching
`createRoot`'s pairing) so accidental cross-async edges cannot form.

The handles use the same `describeNode` / `liveNode` ABA-guard machinery
that `describe` / `nodeId` / `forEachOwned` / `ownerOf` have used since
1.2.1: a returned descriptor carries an internal `NODE_GEN` stamp, and
`runWithOwner` resolves via `liveNode()` which checks that the stamp
still matches the pool slot's current gen. Stale, null, undefined, or
non-tracker handles all **degrade to rooted execution** -- `currentOwner`
set to `null`, `fn` runs, created children survive without adoption, and
the caller is responsible for their disposal (the same contract as
`createRoot`).

### Fixed -- the two hazards the gen guard exists to prevent

The design was originally sketched with raw node pointers -- `getOwner()
{ return currentOwner; }` and `runWithOwner(node, fn) { const p =
currentOwner; currentOwner = node; ... }`. That shape is broken in this
engine because nodes are pooled and the LIFO free list recycles a
disposed owner's slot into whatever effect/computed is allocated next.
Two failure modes were empirically reproduced against a 1.5.0-beta
engine patched with the raw-pointer alternative
(`harness/owner-hazard-repro.mjs`):

- **Recycled-slot cascade death.** Owner A captured; A disposed; effect B
  allocated (LIFO -> same slot); `runWithOwner(captured)` silently
  adopts the continuation into B; B's re-run cascade-disposes it.
  Measured on the unsafe engine: continuation ran 1 time before
  stranger disposal, 1 time after (should have been 2, then 3).
- **Corpse adoption = engine crash.** Same capture, slot NOT yet
  recycled; `runWithOwner(captured, () => effect(...))` splices a child
  into a disposed owner's `firstOwned` list; the next disposal walk
  recurses without termination. Measured: `RangeError: Maximum call
  stack size exceeded` at `runCleanup` / `disposeNode`. Not a leak, a
  crash.

Both hazards are pinned in `test/28-run-with-owner.test.mjs` and both
fail on the raw-pointer sketch; both pass on the shipped
`describeNode` / `liveNode` implementation. The safe implementation
degrades both hazards to rooted execution (the continuation runs and
survives independently of any stranger's lifecycle -- the only honest
semantics for "the scope you captured no longer exists").

### Added -- `test/28-run-with-owner.test.mjs`

**16 tests**, structured to catch the failure modes above rather than
just the microtask happy path:

- Basic shape (7 tests): `getOwner()` returns undefined outside any
  effect/computed and a descriptor inside; `runWithOwner` adopts a
  nested effect into the captured owner, nulls the tracking observer
  for reads directly in `fn`, returns whatever `fn` returns, restores
  previous owner/observer/tracking on return AND on throw, and nests
  correctly (inner switches, outer unwinds).
- Degradation (3 tests): `null` / `undefined` / a signal handle all
  degrade to rooted execution and the created effect works normally
  (fires on updates, disposable).
- Hazard pins (3 tests, plus a composed test): the recycled-slot cascade
  and the corpse-adoption case, each with allocation pressure applied
  BEFORE `runWithOwner` (a stranger effect is created to force slot
  recycling), so the ABA guard is genuinely exercised. A follow-up
  composed test asserts the continuation survives both the stranger's
  re-runs and its disposal.

Full test suite on 1.5.0-beta.2: **455 total** (439 pre-existing +
16 new), 444 pass, 0 fail, 1 skip (SSR N/A), 10 cancelled (the
`25-devtools-real-boot` cases that need `@zakkster/lite-devtools`
installed as a peer -- pre-existing, unrelated).

### Added -- `harness/owner-hazard-repro.mjs`

A standalone reproducer for the two hazards, callable against any engine
(`node owner-hazard-repro.mjs <path-to-Signal.js>`). Prints
`VERDICT: SAFE` on the shipping implementation, `VERDICT: CORRUPTED` +
a stack overflow on the raw-pointer sketch. Kept in `harness/`
alongside the other run-on-demand probes rather than under `test/` so it can
travel to other engines (a candidate 1.6, or a rejected candidate you
want to confirm) without dragging the whole test tree along.

### Verified -- no hot-path change vs 1.5.0-beta.1

sha256 over the extracted function bodies of `pullComputed`,
`markDownstream`, `executeEffect`, `flushEffects`, `allocateLink`,
`severTail`, `createNode`, `runCleanup`, and `disposeNode` matches
1.5.0-beta.1 byte-for-byte. `currentOwner` is written by exactly the
sites that wrote it before (creation adoption, effect-body save/restore,
cleanup), plus the two new user-API primitives. Propagation
(`markDownstream`) remains owner-free per its documented invariant.

### Not shipped

- Watch.js needs no changes -- `watch` / `when` / `whenAsync` create
  effects through the normal path and inherit correct adoption under
  `runWithOwner` automatically. Verified against the safe engine.
- `runWithOwner` deliberately does NOT accept a callable `signal`
  handle as an "owner" (signals cannot own). It falls through to
  rooted execution instead, matching the shape of every other
  handle-taking introspection API.

## [1.5.0-beta.1] -- 2026-06-XX

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

### Verified -- fresh 1.5.0-beta bench sweep (Apple M4 Pro / Node 26)

Both v3 instruments were re-run in full on the 1.5.0-beta engine on **Apple
M4 Pro darwin/arm64, Node 26.3.1** (a step up from the 1.4.0 sweep's 2016
Intel MacBook / Node 22 host), with `#STAMP`-verified outputs committed to
`bench/rb.txt` (microscope aggregate, 4 engines across the six first-party
shapes) and `bench/r.txt` (mirror sweep, Andrii's canonical adapter verbatim,
lite vs alien across 47 rows, isolated-per-row, 10 reps). The M4 Pro host has
a lower run-to-run noise floor than the old Intel host, so the sub-percent
parity band tightens and the honest wins/losses stand out cleanly.

- **Microscope aggregate (rb.txt):** on the six v3 microscope shapes, lite
  wins vs alien on **MUX +34.6%** (fan-in), **SELECTIVE DAG +20.0%**, and
  **DYNAMIC DAG +18.4%** -- the allocation-heavy dynamic shapes stay lite's
  home turf; the wins narrow versus the older Intel sweep (fast machine has
  less GC pause to hide behind, so alien's raw propagation surfaces more) but
  the ordering is intact. **BROADCAST is a true tie** (-1.2%, both under the
  GC delta floor). Alien ahead on **KAIROS -15.7%** (1000 shared-source
  computeds -- alien's flatter representation prices in the walk cheaper on
  M4-class silicon) and **DEEP CHAIN -76.9%** (256-deep chain -- the same
  architectural weak spot the honest framing has always named; recursive
  JS-stack computed resolution loses to alien's flatter chain on hot new
  cores by a wider margin than on old Intel). Speed wins vs alien: **3/6**;
  heap wins: **5/6** with the sixth being a shared-zero on BROADCAST.
- **Microscope heap (the actual story):** on every shape where GC pressure
  exists at all, lite allocates **one to four orders of magnitude less
  transient heap than alien** -- DEEP CHAIN 0.5 KB vs 1062 KB (>2000x, on
  the shape lite loses on time), MUX 0 KB vs 781 KB, KAIROS 23 KB vs 802 KB
  (34.8x), DYNAMIC DAG 3.1 MB vs 60.7 MB (19.5x), SELECTIVE DAG 7.7 MB vs
  78.0 MB (10.2x). Against preact-signals and solid-signals the heap gap is
  even wider on the fan-in / fan-out family; solid allocates ~17 MB on MUX
  and ~15 MB on SELECTIVE DAG where lite allocates 0 KB and 7.7 MB on the
  same shapes. The differentiated position is ALLOCATION, not raw
  propagation speed -- competitive-to-winning throughput with dramatically
  lower GC pressure, and that is the headline that reproduces across hosts.
- **Mirror sweep (r.txt):** Andrii's canonical 47-shape suite re-run
  isolated-per-row lite vs alien on M4 Pro reproduces the same honest
  framing: lite runs **parity-to-behind alien on throughput** across the
  suite (wins outright on 4/47 -- `1000x5 - 25 sources (wide dense)` +12%,
  `manySourcesIntoOneComputedEffectWithDirect` +32.5%,
  `manySourcesIntoOneComputedEffect` +31.7%, and `createComputations4to1`
  +19.3%), weak on the deep/layered-burst family. Every row carries a
  `#STAMP` and the counters (`nodesRecomputed` / `edgesTraversed` /
  `sinkReads`) match Andrii's published suite exactly (`mirror.mjs
  --self-verify`), so a lite-vs-alien delta here is identical work, not DCE.
- **Andrii Volynets js-reactivity-benchmark position holds at 4th of 15**
  with geomean **79.3ms** (raw log `bench/AndriiVolynetsReactiveBench.log`,
  Andrii's own host); lite is ahead of 5th-place Preact Signals (99.8) by
  ~21%. Top-3 count: **25/47** (up from 23 on 1.4.0);
  outright-fastest-of-15 wins fluctuate at the top of a very tight
  leaderboard where alien-signals / reflex / lite trade sub-percent margins
  per shape (5 on 1.4.0, **2 on 1.5.0-beta** -- `createComputations4to1`
  and `1000x5 - 25 sources (wide dense)`), plus 9 second-place finishes.
  The stable metric across every published sweep is the geomean rank at #4
  of 15.
- **Third-party version bumps** used in the local head-to-head vs 1.4.0:
  alien-signals 3.1.2 -> 3.2.1, @preact/signals-core 1.14.1 -> 1.14.2,
  @vue/reactivity 3.5.13 -> 3.5.35, solid-js 1.9.12 -> 1.9.13. Any
  within-lib delta between the two sweeps reflects those bumps + the
  Intel -> M4 Pro host change, not lite-signal changes: 1.4.0 -> 1.5.0
  hot-path bytes are byte-identical (1.5.0 adds only the non-callable box
  handle shape, which affects construction cost and handle ergonomics but
  not the pooled-node read/write path).

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