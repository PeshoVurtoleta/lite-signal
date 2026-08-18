# BRIEF_SIGNAL -- @zakkster/lite-signal -- close createRegistry's open door

> Written in the LiteObjectPool session of 2026-08-17 and staged here for you to
> move to `LiteSignal/`. It is a FINDING plus a proposed session, not a plan
> anyone has accepted. Every claim below was measured against
> `LiteSignal/Signal.js` at **v1.4.4** on 2026-08-17 -- re-run the probe before
> acting on it, because a brief written from memory of a package is exactly the
> failure this brief exists to describe.

```markdown
---
package: "@zakkster/lite-signal"
version_target: 1.4.5 (patch) or 1.5.0 (minor) -- see THE VERSION QUESTION
status: proposed
found_in: v1.4.4
found_by: the D5 option-shape work in @zakkster/lite-object-pool 2.1.0
severity: one uncatchable process kill, one silent real-time contract break
---

# createRegistry validates NOTHING, and two of its failure modes are severe

PURPOSE
  `createRegistry(config)` reads five options and validates none of them. It
  reads each as `config.X !== undefined ? config.X : default` and uses the value
  as-is. There is no type check, no range check, no enum check, and no
  unknown-key check. Twenty of twenty-five malformed configs constructed without
  complaint; the ones that did fail, failed later and elsewhere.

  This is the prior art that produced lite-object-pool's Decision 5. That package
  is now the one with the validated constructor and lite-signal is the one with
  the open door -- the reverse of the situation that motivated the borrowing.

THE MEASURED MATRIX (Signal.js v1.4.4, each case in its own process)
  Run of 25 configs. `--max-old-space-size=256`, 15s timeout, isolated children
  because the first attempt at a single-process probe was killed by case 7.

    maxNodes: -1                USE THROW   TypeError: reading 'nextFree'
    maxNodes: 0                 USE THROW   TypeError: reading 'nextFree'
    maxNodes: 1.5               USE THROW   CapacityError: nodes capacity (1.5)
    maxNodes: "32"              BUILT + RAN (no validation)
    maxNodes: null              USE THROW   TypeError: reading 'nextFree'
    maxNodes: NaN               USE THROW   TypeError: reading 'nextFree'
    maxNodes: Infinity          KILLED      SIGABRT -- process OOM
    maxNodes: 1e9               KILLED      SIGABRT -- process OOM
    maxLinks: -1                USE THROW   TypeError: reading 'nextFree'
    maxLinks: Infinity          KILLED      SIGABRT -- process OOM
    prealloc: "eger"            BUILT + RAN (no validation)
    prealloc: "EAGER"           BUILT + RAN (no validation)
    prealloc: true              BUILT + RAN (no validation)
    prealloc:"lazy"+Infinity    BUILT + RAN (no validation)
    onCapacityExceeded:"Grow"   BUILT + RAN (no validation)
    onCapacityExceeded:"gro"    BUILT + RAN (no validation)
    onCapacityExceeded: 1       BUILT + RAN (no validation)
    maxFlushPasses: 0           BUILT + RAN (no validation)
    maxFlushPasses: -5          BUILT + RAN (no validation)
    maxNods: 32 (typo key)      BUILT + RAN (no validation)
    preAlloc: "lazy" (case)     BUILT + RAN (no validation)
    unknown: whatever           BUILT + RAN (no validation)
    config: null                CTOR THROW  TypeError: reading 'maxNodes'
    config: 42                  BUILT + RAN (no validation)
    config: "eager"             BUILT + RAN (no validation)

  Nothing throws BY NAME. Not one message says which option was wrong.

FINDING 1 (SEVERE -- uncatchable). `maxNodes: Infinity` kills the process.
  `Signal.js:230-237` runs `for (let i = 0; i < currentNodesCapacity; i++)
  nodePool[i] = new ReactiveNode()` with no bound on `currentNodesCapacity`.
  With `Infinity` -- or `1e9`, which is a plausible typo for `1e5` -- this is
  FATAL ERROR: Ineffective mark-compacts near heap limit, SIGABRT. It is not a
  throw. `try/catch` does not catch it, a supervisor does not see an error, and
  a test runner reports a crashed worker rather than a failed assertion.

  Note the doc comment already says `maxLinks` growth has "a hard ceiling of
  maxLinks * 16" (`:203`). The GROWTH path is bounded. The CONSTRUCTION path
  is not, so the bound protects the case that was already survivable and misses
  the one that kills the process.

  This is the same trap lite-object-pool logged as OP-02 and closed in 2.1.0:
  `{prealloc: "eager", capacity: Infinity}` throws by name there rather than
  allocating forever. lite-signal has the identical shape, unfixed.

FINDING 2 (SEVERE -- silent, and telemetry cannot see it). A typo in `prealloc`
  silently flips the population strategy to its opposite, and `stats()` reports
  the two as identical.
  `Signal.js:230` tests `if (prealloc === "eager")`. Any value that is not the
  exact string falls through to lazy. Measured at `maxNodes: 200000`:

      prealloc: "eager"   heap delta 112.4 MB   -- pool populated
      prealloc: "eger"    heap delta   0.0 MB   -- pool EMPTY, silently lazy
      prealloc: "lazy"    heap delta   0.0 MB

  So does `"EAGER"`, and so does `true`. The option exists to buy deterministic
  latency and a zero-allocation hot path -- the package's own words at
  `Signal.js:187-196`, the contract for "render loops, game ticks, and extension
  frame budgets". A one-character typo silently sells that contract back, and
  the caller finds out as jitter in production, not as an error.

  Worse: `stats()` cannot distinguish them. For eager and lazy alike it reports
  `nodePoolCapacity: 8, pooledLinks: 32, linkPoolCapacity: 32` -- the LEDGER, not
  the population. Verified identical across `"eager"`, `"eger"`, `"EAGER"`,
  `true`, `"lazy"`. So the one instrument a caller would reach for to confirm
  their real-time posture reports success in both cases. **`stats()` blind to
  prealloc is arguably its own finding and may deserve a separate entry.**

FINDING 3 (LOUD BUT MISLEADING). Bad numbers surface as `TypeError: Cannot read
  properties of undefined (reading 'nextFree')`, thrown from deep in the node
  allocator on FIRST USE -- not at construction, and naming an internal field
  rather than the option. `-1`, `0`, `null`, and `NaN` all land here. `1.5`
  produces `CapacityError: nodes capacity (1.5) exceeded`, which at least names a
  quantity, but a fractional capacity should never have been accepted.

FINDING 4 (FAIL-OPEN). Unknown keys are ignored: `{maxNods: 32}` and
  `{preAlloc: "lazy"}` both construct a default registry and run. A caller who
  misspells a key gets the default silently -- the exact class lite-object-pool
  2.0.0 closed with an unknown-key throw plus a did-you-mean hint.
  `onCapacityExceeded: "Grow"` falls through to the `"throw"` policy, which is at
  least the safe direction, but silently.

THE VERSION QUESTION -- decide this FIRST, it is not obvious
  Adding validation makes calls that currently "work" start throwing. Every
  config in the matrix above that says BUILT + RAN is a call some caller may be
  making today. Strictly, rejecting them is BREAKING.

  The counter-argument, and the reason this may be a patch: none of those configs
  do what their author asked for. `{maxNods: 32}` does not set a capacity;
  `{prealloc: "eger"}` does not preallocate; `{maxNodes: -1}` builds a registry
  that dies on first use. Turning a silent wrong result into a named throw is
  arguably a bug fix, not a contract change.

  Recommendation: **split it.** Findings 1 and 3 are unambiguous bug fixes --
  ship in a PATCH, because every input they touch is already broken (a crash or
  a delayed TypeError is not a behaviour anyone depends on). Findings 2 and 4
  change inputs that currently RUN, so ship them in a MINOR, and say so in the
  CHANGELOG in the callers' terms: "if you had a typo, you will now hear about
  it." Do not bundle the two halves to save a release.

TASKS
  - Write the decision record first, settling: the split above; whether unknown
    keys throw or warn (throw -- a warn is a side effect and an allocation, and
    lite-object-pool's D5 point 4 already argues this out); whether the
    did-you-mean hint is worth its bytes in a cold constructor (it is -- the
    constructor is cold, and `preAlloc`/`maxNods` are the observed typos).
  - Validate all five options by name, throwing a TypeError prefixed
    `createRegistry: "<option>"`. `maxNodes`/`maxLinks`/`maxFlushPasses`: finite
    integer >= 1. `prealloc`: exactly `"eager"` or `"lazy"`. `onCapacityExceeded`:
    exactly `"throw"` or `"grow"`. `config` itself: object or undefined -- `null`,
    `42` and `"eager"` all currently get through or die badly.
  - Bound eager construction. `prealloc:"eager"` with a non-finite capacity must
    throw by name, not allocate. Consider a named ceiling above which eager
    construction refuses rather than tries.
  - Unknown-key rejection with a did-you-mean, modelled on
    `LiteObjectPool/ObjectPool.js` (`ALLOWED_KEYS` + `suggestKey`, edit distance).
    It is ~25 lines, constructor-cold, and already gated in a sibling.
  - Make `stats()` distinguish eager from lazy, or document loudly that it cannot.
    Reporting the ledger under a key that reads like a population is the part that
    makes Finding 2 undetectable.
  - Tests: the full matrix above as a boundary suite -- every row asserts a NAMED
    throw or a documented acceptance. Include the two OOM rows as isolated
    child-process cases; they cannot run in-process.

ASSERTIONS
  - Every row of the matrix either throws a TypeError naming the option, or is
    explicitly listed as accepted. No row reaches `nextFree`.
  - `{maxNodes: Infinity}` throws by name in-process. Proven by a child-process
    test that the UNFIXED code kills and the fixed code does not -- that
    before/after pair IS the positive control, and without it the test passes
    trivially on a build where the option was silently ignored.
  - `{prealloc: "eger"}` throws. Plus the retained heap-delta check: `"eager"` at
    `maxNodes: 200000` allocates >20 MB and `"lazy"` allocates ~0, so the
    instrument that detected the flip stays in the suite and would catch a future
    regression where eager stops preallocating.
  - Unknown keys throw with a suggestion: `{maxNods: 32}` suggests `maxNodes`,
    `{preAlloc: "x"}` suggests `prealloc`.
  - The engine's zero-GC gates are UNCHANGED. All of this is constructor-cold; if
    any hot-path number moves, the diff is wrong.
  - The existing suite passes untouched except where a test was asserting one of
    the broken behaviours -- and if one is, that is a finding of its own, so name
    it rather than editing it quietly.

NON-GOALS
  No engine changes. No option RENAMES -- `maxNodes`/`prealloc`/
  `onCapacityExceeded` keep their names; this is about validating what is already
  there. No new options. Do not port lite-object-pool's `capacity`/`prealloc`/
  `onExhausted` triple: lite-signal's shape is the one that was RIGHT, and the
  borrowing already went the other way.

DONE WHEN
  no config can build a registry that dies on first use;
  no config can kill the process;
  a typo throws by name instead of silently selling the real-time contract
```

## Provenance, and one thing to check before you trust this

The finding originates in @zakkster/lite-object-pool's Decision 5 work: lite-signal
was the prior art for the `capacity` / population-strategy / exhaustion-policy
split, and while reading it for that, its constructor turned out to validate
nothing. It was recorded as "NOT yet filed as of 2026-08-15" and carried as a note
through 2.0.0 and 2.1.0 because of the one-package-at-a-time law.

The note said only: *unvalidated options fail open on typos; `maxNodes: -1` reaches
`TypeError: Cannot read properties of undefined (reading 'nextFree')`*. That much
reproduced exactly. The two severe findings -- the uncatchable OOM and the silent
eager-to-lazy flip -- were NOT in the note and were found by running the matrix.
The note also understated the blast radius: it read as a typo-ergonomics problem,
and it is a process-kill and a silently broken latency guarantee.

Before acting: `LiteSignal/futureVersions/` holds `1.5.0.js`, `1.6.0.js` and two
roadmaps, and several of them mention validation. I did not read them -- this brief
was written from `Signal.js` and a probe, not from the roadmap. **Check whether
1.5.0/1.6.0 already plans some of this before scheduling it**, or you will get a
duplicate session and possibly a conflicting option design.

The probe is not in either repo. It lives in this session's scratchpad as
`sigprobe2.mjs`; it is ~60 lines (a case table, a child-process runner, an
OOM/timeout classifier) and is worth rebuilding as `LiteSignal/probe/config.mjs`
rather than recovering, since the boundary suite supersedes it anyway.
