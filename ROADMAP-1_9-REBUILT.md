# lite-signal 1.9.0+ -- the rebuilt line (base: 1.8.0)

All previously-built 1.9.0/1.9.1/1.10.0 engines are REJECTED AS VERSIONS.
This roadmap scalps their proven-safe functionality onto a fresh line from
1.8.0 (the last clean base: gate-passed, no bench regressions), adds the
profiling/tracing direction, and encodes the lesson the regression taught.

## The standing gate (new, applies to every version below)

Every candidate must pass, before anything else is even discussed:

1. THE 1to1batch BAR: fieldkit `1to1batch` (sbench updateComputations1to1,
   exact -- one effect, one signal, 400k batch-wrapped sets) within noise
   of 1.8.0, cold-process interleaved minima, on real hardware.
2. CREATION BAR: fieldkit `createSignals` / `createEffects` within noise
   of 1.8.0 (any new closure or property stamp on creation paths shows
   here).
3. Hot-function hash parity vs the previous version wherever the feature
   claims to be cold-path -- claims are PROVEN by sha256 over extracted
   bodies, not asserted.
4. The usual ladder: full suite, smoke, burst structure, upstream
   johnsoncodehk run (177/178 is the standing; #179 excluded by design),
   ecosystem spot (lite-headless minimum), VersionMatrix gate, ASCII audit.

The lesson behind bar 1: the old 1.9.0's onSettled check cost ~7ns per
flush THROUGH V8 CODE-SIZE/INLINE-BUDGET effects, not instruction count --
bytes added to flushEffects/executeEffect are hot-path changes even when
the branch never takes. Therefore: NOTHING lands in a hot function body in
the default build. Per-flush or per-run telemetry exists only inside
build-time twins (see 1.12.0).

## The line -- one to two improvements per version

### 1.9.0 -- `using` / Symbol.dispose  (salvaged; was old-1.9.1's feature)

[Symbol.dispose] on lifecycle objects only: registry -> destroy(), effect
disposers -> themselves, createScope disposers, box PROTOTYPES (zero
per-instance). Callable handles deliberately unstamped. Existence-guarded.
Evidence carried over: creation probes neutral, prototype trick free.
Re-verify on the 1.8.0 base against all bars (the old evidence was
gathered on a regressed base).
npm story: "ES explicit resource management, today" -- small, modern,
visible.

### 1.9.1 -- computed((prev) => ..., {initial})  (salvaged from 1.10.0)

The creation-time-wrapper design ONLY: arity decided once at computed()
creation, wrapper closure installed there; pullComputed's call site stays
the byte-identical zero-argument call (hash-proven on the old base;
re-prove on this one). computedBox included.
npm story: Solid createMemo ergonomics for scans/reductions.

### 1.9.2 -- getOwner() / runWithOwner(handle, fn)  (salvaged from 1.10.0)

The GEN-GUARDED design only (raw-pointer variant is documented-rejected:
recycled-slot cascade death + corpse-adoption crash, reproduced on 1.5.0).
describeNode handles out, liveNode resolution in, stale degrades to
rooted. Ships with recycling-pressure tests, not just microtask
round-trips.
npm story: async continuations that survive real pool semantics.

### 1.10.0 -- named nodes + whyDirty()  (NEW: the tracing foundation)

Two cold-path primitives your profiler tools consume directly:

- `signal(v, {name})` / `computed(fn, {name})` / `effect(fn, {name})`.
  Names live in a registry-side Map<id, name> populated ONLY when a name
  is given -- zero node-shape change, zero cost for unnamed nodes, one
  cold map.set at creation for named ones. describe()/describeNode gain
  `name`; devtools and the profilers render "hp" instead of "#412".
- `whyDirty(handle)` -- the pull-side diagnostic: for a computed, walks
  its deps and reports which one's version moved past evalVersion (and
  transitively which signal write is the root cause), as an array of
  descriptors. Answers "why will this recompute" / "why did this fire"
  without instrumenting anything. Allocates freely -- it is a diagnostic
  call on the user's cold path, never invoked by the engine.

npm story: the first reactive engine where the DEFAULT build explains
itself by name.

### 1.10.1 -- cold-counter pack  (salvaged 1.9.0 counters + additions)

stats() grows: totalLinkAllocations / totalLinkDisposals (the mark-cone
gating data), totalCascadeDisposals, totalCycleErrors, plus the existing
growth/allocation ledgers documented as a stable profiler contract.
Placement rule: every counter rides a branch that is ALREADY cold
(alloc/free/dispose/error). Nothing per-flush, nothing per-run, nothing
per-read. Verify each counter individually against bar 1 -- allocateLink
is warm under churn workloads; if the churn counters flunk the bar there,
they move into the trace twin instead.

### 1.11.0 -- onSettled, rebuilt as a CREATION-TIME capability

The feature returns with the cost model inverted: `createRegistry({
settled: true })` selects, ONCE AT BUILD TIME, a flushEffects variant with
the settle tail -- the same const-selection discipline as the 1.7.0 set
closures (immutable binding, no mutable-slot dispatch, no hot-path check
in the default build, whose flushEffects is byte-identical to 1.8.0's).
onSettled() on a registry built without the capability throws with a
clear message pointing at the option. The profiler creates its registries
with it; production overlays never pay.
This subsumes both rejected fix candidates: "zero cost when detached"
becomes zero BY CONSTRUCTION, decided before the first closure is built.

### 1.12.0 -- the trace twin  (the profiling flagship)

`createRegistry({ trace: true })` selects instrumented BUILD-TIME TWINS of
the write closures and the drain: per-write timestamps, per-flush pass
records, per-effect run durations, recompute counts -- all written into
PRE-ALLOCATED ring buffers (Float64Array/Uint32Array, power-of-2 masks;
zero-GC tracing, the house style). A `trace()` accessor hands the buffers
to lite-profiler/lite-trace for rendering. Default-build registries are
byte-identical to 1.11.0 -- the twin is selected, never branched.
This is where EVERYTHING per-flush/per-run lives, forever. npm story:
oscilloscope-grade tracing built into the engine, zero cost when off.

### 1.13.0 (candidate) -- flushStrategy "microtask"

Already built as a preview on the old line (third build-time closure
variant, existing modes byte-identical, 7 async pins). Re-based onto this
line and run through the full ladder when its turn comes. Orthogonal to
the profiling direction; slotted last.

## Rejected on this line (ledger, so nothing is re-litigated)

- #15 computed self-dirty / upstream #179 closure: hot-path cost for a
  deliberately-excluded construct (stands).
- #16 (NEW) inner-write fixed point: one flag test + refire branch per
  effect run + ceremony stores; closed ZERO upstream tests (the suite
  passes under 1.8.0 absorption); its value was contract purity, its cost
  was hot bytes in executeEffect. Absorption remains the contract.
  Everything learned (two-tier batch rule, #235 analysis, currentObserver
  identity) stays archived for the day the trade changes.
- #17 (NEW) onSettled as a dynamic always-checked hook: the 7ns/flush
  inline-budget trap. Superseded by 1.11.0's creation-time capability.
- Raw-pointer owner handles: crash + corruption, reproduced (stands).

## Per-version protocol (unchanged, plus the new bars)

Each version: one branch, its discriminator test file, fieldkit run on
both MacBooks (bars 1-2), hash-parity proof where cold-path is claimed,
full ladder, WHY-note for the Volynets audience, THEN npm. One or two
features per version keeps every bench bisectable to a single cause --
exactly what made this regression findable.
