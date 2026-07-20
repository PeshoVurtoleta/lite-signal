# lite-signal — the consolidated ledger

*Every hot-path optimisation tried and refused, every regression bisected, every bug
repaired, and the laws each one produced. This is the evidence base the current
exploration roadmap builds on: it is why "the engine is at its lazy-pull optimum" is a
measured result rather than an assertion. Nothing here is re-litigated without a **new
mechanism** clearing **every** gate.*

Numbering note: #1–#12 are the original post-1.5 §0b set; #14 is the shelved per-edge-versioning
spike; #15–#17 were added on the rebuilt engine line; #18–#20 were diagnosed in the
benchmark-rebuild thread. **#13 is still unassigned** (no entry exists under that number). #21–#26 came out of the
allocator-literature sweep and the push-pull / iterative-pull exploration.

---

## The laws that fell out (read this first)

Every entry below collapses into six rules. The rules are the payoff; the entries are the
proof.

1. **Bytes in a hot body cost even when the branch never runs.** V8's inline / code-size
   budget is the real constraint, not instruction count. A check that never takes its branch
   can still push a function out of inlining and make it a slower function. *(#17, #18)*
2. **You cannot out-inline TurboFan by hand.** It already inlines tiny monomorphic functions
   and elides non-throwing `try/finally`. Manual "skip the call / avoid the frame" guards
   just make the body bigger and branchier, and V8 optimises the result worse. *(#4, #5, #6,
   #7, #8)*
3. **Eager resolution is incompatible with lazy-pull.** Any pre-walk / pre-resolve of the
   recorded dependency list resolves edges the next run won't take, breaking conditional
   dependencies. The pre-walk *is* the optimisation and the pre-walk is what's wrong — not
   tunable. *(#2, #9, #11, #16)*
4. **Hot-read data layout is zero-sum.** Moving fields to win creation or GC-marking shifts
   the field offsets the propagation path reads hot and blows its inline caches. The win and
   the loss are the same change. *(#10, #12)*
5. **Measure on the hardware and V8 you ship against.** A "win" on an old Xeon / old Node can
   be 0% on current silicon where V8 already inlines the thing you're removing. *(#19)*
6. **Native-allocator techniques compensate for what C lacks; a pooled, single-type,
   GC-hosted, generation-guarded design already has those things.** Four separate
   allocator designs were evaluated and all four failed for this one reason: their
   innovation is a workaround for a constraint that does not exist here. Before porting
   any allocator idea, name the C limitation it exists to route around, then check whether
   this engine has that limitation. Usually it does not. *(#21, #22, #23, #24)*

Gate consequence: **no single green gate — and no candidate's self-reported scorecard —
authorises a ship.** Gate order is conformance (per-test diff) → internal suite →
independently-measured raw per-process bench (creation AND propagation) → real-hardware
bench. Re-measure every claim.

---

## A. Rejected optimisations — by family

### Family (a) — hot-path frame-skips (V8 already does it better)

| # | optimisation | result | mechanism |
|---|---|---|---|
| **1** | Closure-pool + ctx-box (`setPrototypeOf` carrier for signal state) | 5–14% slower propagation, 10–30% slower creation | `setPrototypeOf` deopts the object to dictionary mode → megamorphic dispatch |
| **3** | Intrusive mark stack, standalone | wins in container, regresses on paired MBP runs | the +8-byte `nextMark` field's cache pressure; net-neutral, so kept *inside* the 1.3.0 bundle, never shipped alone |
| **4** | `runCleanup` guard inlining (`if firstOwned‖cleanupFn` at the call site) | 7.5% slower | V8 already inlined the empty call; the manual branch adds cost on every recompute |
| **5** | `markDownstream` linear-fast-path + `headSub` pruning | passed **all 178** conformance, but KAIROS regressed 13–18% | two-loop structure makes the body bigger/branchier; V8 optimises wide fan-out worse |
| **6** | `flushEffects` empty-queue inline guard (`activeQueueLen>0` at call site) | 12–14% slower | extra closure-var load on every set; defeats V8's inlining of the empty path |
| **7** | The split-flush attempt (thin wrapper + `flushEffectsNonEmpty` worker) | update1to1 noise, KAIROS 13–15% slower | same two-loop / extra-branch mechanism as #5/#6 |
| **8** | `pullComputed`/`set`/`boxSet` local-caching patch | no-op or worse | the engine already caches `eq`, has the `markEpoch` short-circuit + `FLAG_COMPUTING` cycle guard; the patch would have *deleted* correctness machinery |

### Family (b) — eager graph pre-resolution (breaks lazy-pull)

| # | optimisation | result | mechanism |
|---|---|---|---|
| **2** | `FLAG_STALE` cross-sweep bailout | breaks lazy-pull (#213 inner-write bug) | fundamental semantic incompatibility — not fixable |
| **9** | Iterative pull via eager dep pre-walk (explicit `resolveStack`, post-order DFS over recorded `headDep`) | FAILED conformance: 4 regressions (#188/#189/#193/#153) | eager pre-walk resolves deps the new run won't read → breaks dynamic/conditional-dep laziness. The pre-walk is the optimisation and the pre-walk is what's broken → not tunable |
| **16** | Inner-write fixed point | closed ZERO upstream tests; rejected | one flag test + refire branch per effect run + ceremony stores — contract purity bought with hot bytes in `executeEffect`. Absorption remains the contract; the analysis (two-tier batch rule, #235, `currentObserver` identity) is archived for the day the trade changes |

### Family (c) — hot-read data-layout changes (win creation/GC-marking, deopt propagation)

| # | optimisation | result | mechanism |
|---|---|---|---|
| **10** | `ReactiveNode` scheduler-field relocation (move `scheduler`/`schedulerThunk` to a registry Map, "size-class boundary" win) | creation −6 to −12% (real) **but** propagation regressed: KAIROS +13–18%, MUX +36–49%, DEEP +12–17% | removing 2 fields shifted the hot-read offsets (`version`/`evalVersion`/`markEpoch`) → blew the propagation ICs. Win and loss are the *same* change. (Candidate's own VERDICT claimed 0.97–1.03× hot-path; measurement showed 1.13–1.49×.) Corollary: relocating any hot field is rejected by extension |
| **12** | Edge-arena SoA rewrite (`ReactiveLink` objects → `Int32Array` columns by edge id) | CORRECTNESS CLEAN (difftest 0/30k, suite 412/413, zero-GC held) **but** propagation regressed: KAIROS +11–18%, MUX +65–78%, DEEP +3–13% | edge traversal via typed-array index = 2 bounds-checked array loads per hop where the object graph did 1 inlined pointer deref. V8 optimises monomorphic object-property access far better than indexed typed-array traversal on the hot path. Best-engineered rejection of the campaign — correct and zero-GC-preserving, but the layout trade is backwards for a propagation-dominated engine |

### Family (d) — native-allocator ports (they solve constraints this engine does not have)

Each of these is a well-regarded design from the systems literature. Each was probed
before being built, and each died on a measurement or an inspection. Recorded together
because the *pattern* is the finding — see Law 6.

| # | optimisation | result | mechanism |
|---|---|---|---|
| **21** | Bonwick partial-slab allocation discipline (carve the pool into slabs, per-slab free lists, allocate from one active slab so recycled slots stay dense) | REJECTED — no disease to cure. A positive control (deliberately shuffled allocation) separated at **1.80× the floor**, proving the probe could resolve allocation-order locality; the real global LIFO free list then measured **mean slot gap 44 out of a 1.6M pool at 0.96×**, touching the theoretical minimum slab count | a LIFO free list already has strong *temporal* locality — objects freed together are re-allocated together. Slab discipline fights *spatial* fragmentation in a multi-size, multi-consumer kernel allocator; a single-type pool with LIFO recycle has most of that property for free. The mechanism works (the sequential variant reached mean gap 1, identical to a virgin pool) — there was simply nothing left to recover |
| **22** | mimalloc deferred collect (`free`/`local_free` split — disposal pushes to a pending list, field clearing batched into a collect pass at free-list exhaustion) | REJECTED — **pins 128 MB and runs 3.2× slower**. Retention measured exactly (no clock): eager disposal released 128.56 MB, deferred released 0.39 MB | in C, `free()` does no per-block work at all — a freed block keeps stale bytes and nobody cares — so the `local_free` push *is* the entire cost of free and nothing per-block is being deferred. Here the fifteen writes in `disposeNode` are mostly **reference drops required for GC correctness**. Deferring the clear *is* deferring the reference drop, which is retention. The work cannot be eliminated, only relocated, and relocating it costs a second traversal of a scattered pending list plus collect passes the LIFO design never needs. A hybrid (drop references at disposal, defer only the scalars) leaves three writes to defer — nothing measurable, still paying for the collect machinery |
| **24** | Mesh-style non-relocating compaction (merge spans with disjoint occupancy bitmaps by remapping virtual memory so two virtual pages share one physical page) | REJECTED on inspection — not built | two independent reasons. The mechanism is virtual-memory remapping, and JS has no page control, so there is nothing to port. More fundamentally the *motivation* is inverted: Mesh goes to extraordinary lengths to avoid relocation **because C has raw pointers and may not safely move objects**. This engine has generation-tagged handles and therefore *may* relocate — so Mesh is an elaborate workaround for a restriction that does not apply, and the thing it avoids is simply the compaction phase already sketched in the pool-lifecycle roadmap. **One idea does transfer:** its *policy* — choose compaction targets by looking for chunk pairs with complementary occupancy, so a single pass frees a whole chunk. Pure algorithm, needs no virtual memory, and answers the "which chunks first" question compaction would otherwise guess at |

### Boundary cases (their own reasons)

| # | optimisation | result | mechanism |
|---|---|---|---|
| **23** | Free-list randomisation as a bug-finding mode (mimalloc's observation that the allocation fast path never *inspects* the free list, so reuse order is free) | **KEPT as a test-only dimension, but DOWNGRADED.** The mechanism is real and free: the pool has exactly two pop sites, both bare head-takes, so three reuse orders were implemented with **zero change to either pop site** and hot-body parity stayed green. Its bug-finding premise failed | tested against a real historical bug — the parked-cursor disposal defect (#20) — by reverting the fix and running value-checked torture that knew nothing about it. **Every order caught it, including plain LIFO**, because that defect corrupts *structurally* (it splices through a dangling pointer) and crashes regardless of who owns the slot. The missing ingredient was workload **shape**, not reuse order. Deeper reason: randomisation exists in C because a pointer to a freed block is indistinguishable from a pointer to that block re-allocated; here every handle carries a generation bumped on disposal and `id` is a fresh identity per allocation, so a stale handle reads `undefined` under *every* order. **The ABA guard is identity-based, not address-based.** Kept only for state-space widening; the actionable lesson is that shape coverage beats allocation-order randomisation |
| **25** | `ppRevalidate` — eager dependency refresh at an absorber's run end (when a mark lands on a node that is mid-run, pull its whole dep chain once the run finishes, to clear the stale marks the inner write left upstream) | REJECTED — fixed the hazard it targeted but **diverged from lazy-pull on the inner-write-through-computed conformance pin and broke value-dependent cycle detection** | eagerly refreshing dependencies changes equality-cutoff outcomes: the twin re-fired where lazy's stale cache correctly absorbed. Family (b) again, at a new site — *any* pre-resolve of recorded dependencies resolves edges the semantics say to leave alone. Superseded by flag-only **weakening**: the absorber re-tags its dep chain WEAK at run end and touches nothing else — no pull, no recompute, no cache refresh — so caches stay stale-but-marked exactly as lazy leaves them and the next sweep strengthens the weak marks and re-descends. Negative control confirms the weakening is load-bearing: neuter it and exactly the hazard tests fail |
| **15** | Computed self-dirty / upstream #179 closure | rejected (stands) | hot-path cost for a construct the suite deliberately excludes; **absorption is the contract**, kept honest by the absorption pin (`test/33-...`) |
| **17** | `onSettled` as a dynamic always-checked drain hook | **+27–31% on batched updates**, ~7ns/flush → forced a reset of the engine line to the prior release | not instruction count — bytes pushing `flushEffects` past V8's inline budget; **the branch didn't even have to be taken.** *This is the entry that produced Law 1.* Implementation permanently rejected; the feature returned in a later release as `createRegistry({settled:true})` — same capability, selected once at build time, default byte-identical |
| **19** | Equals short-circuit (replace indirect `node.equals(a,b)` with direct `OBJECT_IS`) | 14/14 semantics, but **0% on target hardware** — rejected | looked like a 20% win on an old Xeon/Node 22 (upd1to1 = 5.12ms); on M4/Node 26 the same shape is 1.70ms = 4.25ns/set, where V8 already inlines the monomorphic call. *This is the entry that produced Law 5.* |
| — | Raw-pointer owner handles | crash + corruption, reproduced (stands) | the pool recycles autonomously; a raw-pointer handle adopts a recycled slot → cascade death + corpse-adoption crash. Only the gen-guarded design is safe |

---

## B. Regressions & bugs found and fixed *(not rejected optimisations — real defects caught)*

### #18 — the cleanup-return hot-body regression *(diagnosed in-thread)*

The cleanup-return change **inlined 15 lines into `executeEffect`** → **+21–23% on effect-dense
graphs**, invisible everywhere else including `1to1batch` (one effect). Hid for **five
versions** because its own proof exempted the one body that changed ("sha256 over the 15
*other* bodies") and bar 1 was structurally blind to it. Bisected: reverting only that hunk
restored the prior body exactly. **Fixed** with variant C (a cold helper, +2 lines on the common
path), cascaded across every later line. Forced two gate changes (see §E).

### #20 — the parked-cursor disposal bug *(you found it; fixed identically by both of us)*

`disposeNode` frees a node's outgoing link out from under a **parked re-tracking cursor**
when an effect disposes its own not-yet-retracked dep mid-run → `severTail` walks the freed
link → `TypeError: Cannot set properties of null (setting 'headSub')`. Present
**present from 1.4.0 until it was found**. **Fixed** with a one-line cold-path repair (advance the cursor past the
doomed link); the repair also made the `-1` sentinel band-aid in `freeLink` dead code, which
was excised. 30/30 coverage, 50k-cycle stress zero-leak, churn 1.00×.

---

## C. Shelved — built and measured, parked (not disproven, not rejected)

### #14 — per-edge versioning *(the shelved spike)*

Attaches a version to each **edge** rather than each node, so a computed can tell which
specific dependency moved without re-reading node versions. Built during the second
Reflex-study cycle, measured, and **shelved with its numbers** — it lives in
`engines/shelved`, not in the rejected set. Distinct from the rejected entries: those
failed a gate; this one was parked as a design direction that didn't earn its place *yet*,
with the data kept so it can be revived if a workload ever makes per-edge granularity pay.
(That line instead shipped inner-write fixed point + onSettled + link-churn counters.)

### #26 — resume-cursor iterative pull *(built, gated, scoped)*

The rejected iterative pull (#9) used an **eager pre-walk**: resolve every recorded
dependency, then decide. That resolves edges the next run will not read, which is why it
broke conditional-dependency laziness and was correctly closed as not-tunable.

A different transcription survives. Keep an explicit pooled descent stack with a
**per-frame resume cursor**, so the dep walk's early `break` at the first changed
dependency is preserved exactly — a dependency past that point is never visited, which is
the property #9 destroyed. Resolution then proceeds **bottom-up**, so by the time a
`computeFn` runs its dependencies are already fresh and its nested reads land on the
version fast path instead of descending.

Measured: the steady-state deep re-pull ceiling moves from **~6,900 to beyond 1,048,576**
(no ceiling found below the probe cap) — the limit becomes pool capacity rather than the
JS stack. Gated: hot bodies byte-identical, full suite green with it as the default, a
40k-schedule differential fuzz against the recursive resolver with zero divergence, and
zero-GC holding (the descent stack is a registry-level pooled array, deliberately **not**
a new node field, which would have grown every node and collided with the creation
field-write audit).

**Parked, not shipped, and honestly scoped.** It cannot fix the *first-evaluation*
ceiling and does not claim to: on first evaluation dependencies are discovered by running
the body, so there is no graph to descend — inherent to lazy dependency discovery, not an
implementation gap. It is also transcribed from the lazy-pull body and reads that body's
clean-cone predicate, so pairing it with the push-pull twin (which marks with a flag
instead) would consult a counter nothing updates; that combination **throws** rather than
silently serving stale values. Folding it into the push-pull resolver is the open follow-up.

This refines #9 rather than overturning it: the *eager pre-walk* remains rejected. What
changed is the finding that a laziness-preserving iterative form exists at all.

---

## D. The closings — perf questions answered "no fix exists within this paradigm"

| question | verdict | evidence |
|---|---|---|
| **Creation cost** | CLOSED — structural, externally confirmed | the callable handle's `read` (+ `set`) closure is irreducible; Andrii ran his own 100k-creation breakdown and reached the same conclusion; reshaping the handle regressed the read/update path (same family as #1/#8/#10/#12). `signalBox`/`computedBox` (his suggestion) is the answer and earned the 4th-place creation rows. Keep the callable contract; treat the residual gap as structural |
| **Burst / flush** | CLOSED — locality, harness-confirmed | `burst-dag.mjs` + the op-5/6/7 counters show the burst is **single-pass, one recompute per node** — nothing to coalesce (killed #11). The ~2–4× gap is traversal locality at scale, and the two levers that could touch locality (#10, #12) both deopt propagation. No flush fix exists |
| **Iterative pull** | REJECTED as an eager pre-walk (#9); **REOPENED and built** as a resume-cursor transcription (#26) | the eager pre-walk is still incompatible with lazy conditional deps and stays closed. A resume-cursor form that preserves the dep-walk break *is* laziness-preserving, and moves the steady-state deep re-pull ceiling from ~6,900 to beyond 1M. The original ceiling estimate was also optimistic: the measured steady-state ceiling is ~6,900, and the first-evaluation ceiling ~2,500–4,000. Real targets still rarely reach either, so this remains a robustness result, not a throughput one |

**Net:** the only genuinely open *engine* question left is paradigm-level — does push-pull
dominate lazy-pull on updates, and does a hard zero-GC constraint change that? That is the
subject of the current exploration roadmap, not a release.

---

## E. Also learned in-thread (not a ledger entry, but a standing rule)

**Benchmarks that discard their outputs measure whether the JIT deleted the loop, not the
work.** The `createComputations*` rows created N computeds and discarded them; on Node 26/M4,
V8 elided the whole loop for the *lazy* engine (alien → 0.04ms) but not the side-effecting one
(lite), manufacturing a fake ~27000× gap. Fix: capture the loop variable (fidelity) **and**
anchor every created node into a reused ring buffer (the same anti-DCE technique the microscope's
`Float64Array` sink already used on the propagation side). Anchored, the ratio fell to ~5×,
matching the real structural creation gap. Rule: **a create/discard micro-benchmark must anchor
its outputs or it is measuring dead-code elimination.**

---

## F. How the gate evolved (the ledger changed the rules)

- **Law 1 (from #17):** nothing lands in a hot function body in the default build. Per-flush /
  per-run work lives only in a build-time twin, selected not branched.
- **Bar 1b = fanout64 (from #18):** `1to1batch` (one effect) is structurally blind to an
  `executeEffect` regression that only shows on effect-dense graphs. A fan-out bar was added.
- **Bar 3 amended (from #18):** a changed hot body must be benched on its **worst shape**,
  never exempted by "hash parity over the *other* bodies."
- **Law 5 (from #19):** measure on the hardware and V8 you ship against; an old-silicon win can
  be zero on current V8.
- **Gate order, unchanged and absolute:** conformance → internal suite → independently-measured
  raw bench (creation AND propagation) → real-hardware bench. No single green gate authorises a
  ship; re-measure every self-reported claim.

---

*MIT © Zahary Shinikchiev. The ledger is the map; the laws are the territory. Keep it whole,
so nothing is re-litigated and every future spike starts from what's already known.*
