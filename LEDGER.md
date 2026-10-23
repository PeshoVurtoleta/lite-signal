# lite-signal — the consolidated ledger

*Every hot-path optimisation tried and refused, every regression bisected, every bug
repaired, and the laws each one produced. This is the evidence base the current
exploration roadmap builds on: it is why "the engine is at its lazy-pull optimum" is a
measured result rather than an assertion. Nothing here is re-litigated without a **new
mechanism** clearing **every** gate.*

Numbering note: #1–#12 are the original post-1.5 §0b set; #14 is the shelved per-edge-versioning
spike; #15–#17 were added on the rebuilt engine line; #18–#20 were diagnosed in the
benchmark-rebuild thread. **#13 is still unassigned** (no entry exists under that number). #21–#26 came out of the
allocator-literature sweep and the push-pull / iterative-pull exploration. #27-#28 are the SoA
research track (LiteSignalExperimental fork, section G). #29-#31 came out of the 2026-09
weak-point analysis of Andrii's harness (section H). #32-#33 came out of the 2026-10 1.6.0 audit program (section I). #34-#46 are the 1.6.0 soak and A9 findings (section J).

---

## The laws that fell out (read this first)

Every entry below collapses into seven rules. The rules are the payoff; the entries are the
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
   the loss are the same change. Two corollaries from 2026-09: a layout trade has a **size
   axis** -- per-hop cost wins on cache-resident graphs, density wins past a crossover (~1e4
   nodes on M4 / node 26), so a layout is judged across a size sweep, never at one size
   *(#27)*; and **the allocation site is part of the layout** -- where V8 places the pool
   objects (young-then-promoted vs pretenured) moves propagation as much as field order
   does *(#29)*. *(#10, #12, #27, #29)*
5. **Measure on the hardware and V8 you ship against.** A "win" on an old Xeon / old Node can
   be 0% on current silicon where V8 already inlines the thing you're removing. *(#19)*
6. **Native-allocator techniques compensate for what C lacks; a pooled, single-type,
   GC-hosted, generation-guarded design already has those things.** Four separate
   allocator designs were evaluated and all four failed for this one reason: their
   innovation is a workaround for a constraint that does not exist here. Before porting
   any allocator idea, name the C limitation it exists to route around, then check whether
   this engine has that limitation. Usually it does not. *(#21, #22, #23, #24)*
7. **Creation cost is survival, not allocation.** The pool is a GC root: every undisposed
   node -- and the compute closure it holds -- stays alive after the caller drops its
   handle, so a create-and-drop workload makes the scavenger copy what a GC-owned engine
   simply frees. At equal bytes the mint path is not the problem (per-mint allocation on an
   eager pool equals alien's; the callable handle costs 13.6 ns vs `bind`'s 8.3 ns); the
   45-55% GC share under the lazy adapter is the explicit-lifetime contract plus a 224-byte
   node (Node ships without pointer compression). The one lever that removed the copying
   moved the cost into propagation. (The contrast holds against alien's lazy computeds. Solid 2's unowned
   non-lazy memos are retained by their sources when never read -- @solidjs/signals 2.0.0-rc.14,
   `core/core.ts` and `core/graph.ts`, INFERRED from source.) *(#29, D)*

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
| **11** | (title not recorded) -- an epoch-guard / burst-coalescing tweak | killed: the burst is single-pass, one recompute per node (section D) | content lost in consolidation; cited by Law 3 and section D. The current exploration roadmap (post-1.12, v2.3) calls #2/#11 "epoch-guard tweaks" |
| **16** | Inner-write fixed point | closed ZERO upstream tests; rejected | one flag test + refire branch per effect run + ceremony stores — contract purity bought with hot bytes in `executeEffect`. Absorption remains the contract; the analysis (two-tier batch rule, #235, `currentObserver` identity) is archived for the day the trade changes |

### Family (c) — hot-read data-layout changes (win creation/GC-marking, deopt propagation)

| # | optimisation | result | mechanism |
|---|---|---|---|
| **10** | `ReactiveNode` scheduler-field relocation (move `scheduler`/`schedulerThunk` to a registry Map, "size-class boundary" win) | creation −6 to −12% (real) **but** propagation regressed: KAIROS +13–18%, MUX +36–49%, DEEP +12–17% | removing 2 fields shifted the hot-read offsets (`version`/`evalVersion`/`markEpoch`) → blew the propagation ICs. Win and loss are the *same* change. (Candidate's own VERDICT claimed 0.97–1.03× hot-path; measurement showed 1.13–1.49×.) Corollary: relocating any hot field is rejected by extension |
| **12** | Edge-arena SoA rewrite (`ReactiveLink` objects → `Int32Array` columns by edge id) | CORRECTNESS CLEAN (difftest 0/30k, suite 412/413, zero-GC held) **but** propagation regressed: KAIROS +11–18%, MUX +65–78%, DEEP +3–13% | edge traversal via typed-array index = 2 bounds-checked array loads per hop where the object graph did 1 inlined pointer deref. V8 optimises monomorphic object-property access far better than indexed typed-array traversal on the hot path. Best-engineered rejection of the campaign — correct and zero-GC-preserving, but the layout trade is backwards for a propagation-dominated engine |
| **27** | Link-pool hybrid SoA, "R3" (5 threading fields -> `Int32Array` columns, source/target kept as packed ref-columns) | suite + torture clean; full GC 1.5-1.95× faster; resident 1e5-node graph -30% per set; **but** independently re-measured: MUX +30%, BROADCAST (1->1000 effects) +30%, fanout64 +10%, creation churn +39%; memory -21-26% (not -33%), -8% just past a column doubling | #12's per-hop typed-array load minus the bounce. Crossover at ~1e4 nodes: density wins above it, per-hop cost below. Not eligible as the default engine; see section G |
| **29** | Literal-site pool construction -> V8 allocation-site pretenuring of nodes + links | creation -50-62% under Andrii's lazy adapter (GC inside the window -> 0), suite / GC lane / perf gate / torture all green; **but** propagation +14-71% on six shapes (MUX +71%), bimodal per process, and still +3-14% with the whole pool pretenured | both effects vanish under `--no-allocation-site-pretenuring`: the same placement decision is the creation win and the propagation loss. The allocation site is part of the layout. See section H |

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
| **23** | Free-list randomisation as a bug-finding mode (mimalloc's observation that the allocation fast path never *inspects* the free list, so reuse order is free) | **KEPT as a test-only dimension, but DOWNGRADED.** The mechanism is real and free: the pool has exactly two pop sites, both bare head-takes, so three reuse orders were implemented with **zero change to either pop site** and hot-body parity stayed green. Its bug-finding premise failed | tested against a real historical bug — the parked-cursor disposal defect (#20) — by reverting the fix and running value-checked torture that knew nothing about it. **Every order caught it, including plain LIFO**, because that defect corrupts *structurally* (it splices through a dangling pointer) and crashes regardless of who owns the slot. The missing ingredient was workload **shape**, not reuse order. Deeper reason: randomisation exists in C because a pointer to a freed block is indistinguishable from a pointer to that block re-allocated; here every handle carries a generation bumped on disposal and `id` is a fresh identity per allocation, so a stale handle reads `undefined` under *every* order. **The ABA guard is identity-based, not address-based.** Kept only for state-space widening; the actionable lesson is that shape coverage beats allocation-order randomisation. Note (2026-10-12): the pop sites are untouched, but the PUSH sites are not -- LiteSignal+/1.13.0 disposeNode carries two `if (FREE_ADV)` branches in the DEFAULT body (one in the subscriber-link loop, one at the node push). The hot-body parity set did not include disposeNode, so "selected, not branched" was not met on the disposal path. The FIFO mode also loses slots after a drain-and-refill (stale tail, INFERRED from reading). Do not carry the mode forward |
| **25** | `ppRevalidate` — eager dependency refresh at an absorber's run end (when a mark lands on a node that is mid-run, pull its whole dep chain once the run finishes, to clear the stale marks the inner write left upstream) | REJECTED — fixed the hazard it targeted but **diverged from lazy-pull on the inner-write-through-computed conformance pin and broke value-dependent cycle detection** | eagerly refreshing dependencies changes equality-cutoff outcomes: the twin re-fired where lazy's stale cache correctly absorbed. Family (b) again, at a new site — *any* pre-resolve of recorded dependencies resolves edges the semantics say to leave alone. Superseded by flag-only **weakening**: the absorber re-tags its dep chain WEAK at run end and touches nothing else — no pull, no recompute, no cache refresh — so caches stay stale-but-marked exactly as lazy leaves them and the next sweep strengthens the weak marks and re-descends. Negative control confirms the weakening is load-bearing: neuter it and exactly the hazard tests fail. Provenance (2026-10-12): the harness artifacts behind this entry (pp.difftest, hotbody-parity, oracle-torture) are not on disk anywhere in the suite. The numbers stand as recorded; they cannot be re-run from the repo. |
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
link → `TypeError: Cannot set properties of null (setting 'headSub')`. Present **from 1.4.0 until it was found**. **Fixed** with a one-line cold-path repair (advance the cursor past the
doomed link); the repair also made the `-1` sentinel band-aid in `freeLink` dead code, which
was excised. 30/30 coverage, 50k-cycle stress zero-leak, churn 1.00×.

**Amended 2026-10 (1.6.0 A1, F15).** The one-line repair covers only the LIVE cursor. A frame
suspended under a nested frame kept its cursor in a JS local, so a disposal inside any nested
frame (a child effect's first run, a nested recompute, untrack + computed) still freed a link a
suspended frame pointed at (1.6.0 audit program, 2026-10). A1 (1.6.0 working tree, unreleased) moves saved cursors onto a
registry `cursorStack` and repairs every frame (`repairCursor` / `dropCursors`), and pins the
slot of a node disposed while RUNNING until depth 0. A line that carries only the
one-line repair (published 1.5.x, 1.6.0-rc..1.11.0, LiteSignal+/1.13.0) still has F15.

### F29 -- `globalVersion` reached the 0 "unset" sentinel *(found by reading, 2026-10-13; FIXED in the 1.6.0 working tree)*

`evalVersion` / `markEpoch` use 0 as "unset", and `globalVersion` bumped as a plain `(v + 1) | 0`, so
one full wrap (2^32 - 1 bumps in one registry lifetime) put a 0 stamp in the graph. Witnessed by the
NEARWRAP census (SPEC-A A13): a one-shot lost notification, a lazy computed first read returning
`undefined`, an effect created at the crossing permanently deaf, an effect stamped 0 skipping its
dependency check, a computed stamped 0 bypassing the equality cutoff. **Fixed** at the two bump sites
(`read.set`, `boxSet`) with `((v + 1) | 0) || 1`; the counter's period becomes 2^32 - 1 and `test/51`
pins it with must-fail mutants per site.

*The bake-off (PRELIMINARY, 2026-10-13, M4 Pro, Node 26.8.2, quiet-lock, load 1.06-1.91, 132 runs (30 + 60 + 42, three batches)).*
Six spellings were built and compared: the pre-fix bump, `if (!globalVersion) globalVersion = 1;`, the
single-expression `|| 1` form, the chained store at both sites, chained in `read.set` with the plain
form in `boxSet` (shipped), and a step-by-2 odd counter. `--trace-turbo-inlining` decision logs were
identical after masking the size / budget figures for every spelling (KAIROS and BROADCAST, sync and concurrent; `read.set` inlined into
`drive` and `runOne` in all; the inlining budget never binds, 543 of 920 at most). Bytecode
`read.set` 252-264 B, `boxSet` 200-208 B across the spellings; shipped 252 / 204 (pre-fix 252 / 200). In three rotated A/B
batches the shipped spelling (K3) stayed within the A/A spread (K3 / pre-fix medians at most 1.028;
per-batch A/A up to 1.074); K2's raw 1.080 (KAIROS) and 1.106 (BROADCAST) fall on the bimodal
scenarios and were not mode-split. Law 1's failure mode (#17: bytes pushing a hot body past the
inline budget) did not occur; this is a default-build correctness fix no build-time twin can carry,
so it is a measured exception to Law 1, not a counter-example. KAIROS (~510 vs ~600 ms) and
BROADCAST (~420 vs ~480 ms) are BIMODAL, with a slow-mode frequency independent of the kernel: an
earlier 4-round A/B read KAIROS 1.083; in batch 3 the byte-identical A/A twin K1b read 1.081 against
the pre-fix tree while K1 read 1.007 -- mode counting, not a cost. Do not read
a 4-round A/B on those two scenarios without splitting the modes first.

*Rejected: step-by-2* (`(v + 2) | 0`, an odd counter that never lands on 0): it halves the ordering
window (about 2^30 bumps instead of about 2^31) and wraps at 2^31, colliding with the 2^31 band tests
and the A4 rebase work.

*Acceptance (reduced campaign: sweep + microscope, REPS=10, no Andrii suite; 2026-10-13, M4 Pro, Node
26.8.2, quiet-lock, load 1.05-2.91; Chrome busy during part of the sweep, 31 of 59 cpu-sampler
samples): ACCEPT, PRELIMINARY.* 0 / 45 sweep rows and 0 / 6 microscope scenarios beyond the A/A
noise; KAIROS / BROADCAST fast-mode ratios (KCAND / KWT0) 0.984 / 0.994. The worst regression-direction
sweep row, `updateComputations2to1` (raw 1.454), is a slow-mode count (fast-mode ratio 0.987, Fisher p
0.656). The full BENCH-CAMPAIGN runs before release. Report:
audit/2026-10-07/verification/campaign-f29/REPORT.md (git-ignored).

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

Provenance (2026-10-12): `engines/shelved`, which this entry cites, is not on disk anywhere
in the suite. The result stands as recorded; it cannot be re-run from the repo.

Reflex's `edge.version` is a membership / tracking stamp, not a value version (Reflex monorepo
volynetstyle/Reflex at commit f4a98ce, 2026-10-09: packages/reflex-runtime/docs/RULES.md R3 and
INVARIANTS.md, packages/reflex-runtime/src/protocol/read.producer.ts). The 1.13 REFLEX-LESSONS claim that Volynets' paper 01
formalises #14 conflates the two; 1.13's `track:"reorder"` is find-with-reorder retracking,
not per-edge versioning.

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

Provenance (2026-10-12): the harness artifacts this entry cites (the iterative-pull ceiling
probe and its 40k-schedule differential fuzz) are not on disk anywhere in the suite. The
numbers stand as recorded; they cannot be re-run from the repo.

This refines #9 rather than overturning it: the *eager pre-walk* remains rejected. What
changed is the finding that a laziness-preserving iterative form exists at all.

---

## D. The closings — perf questions answered "no fix exists within this paradigm"

| question | verdict | evidence |
|---|---|---|
| **Creation cost** | CLOSED -- structural, externally confirmed | the callable handle's `read` (+ `set`) closure is irreducible; Andrii ran his own 100k-creation breakdown and reached the same conclusion; reshaping the handle regressed the read/update path (same family as #1/#8/#10/#12). `signalBox`/`computedBox` (his suggestion) is the answer and earned the 4th-place creation rows. Keep the callable contract; treat the residual gap as structural. **2026-09 attribution corrects the *reason*, not the verdict** (section H): the closures are not the dominant cost. Under Andrii's lazy adapter 45-55% of creation time is scavenger survival-copying, because the pool is a GC root (undisposed nodes and their compute closures outlive the dropped handle) and each fresh `ReactiveNode` is 224 B on Node. At equal bytes (eager pool) lite's per-mint allocation equals alien's, and the callable handle costs 13.6 ns vs `bind` 8.3 ns. Give alien the same retention (anchor every handle) and its cc0to1 triples (1.54 -> 4.53 ms). The one lever that removed the copying (#29) moved the cost into propagation |
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
- **VersionMatrix gains `mux` + `effect-fanout` (from #27, 2026-09):** the five original
  workloads had no long dep-list walk (the MUX shape that exposed #10 and #12) and no
  effect-dense flush. The resident `broadcast-fanout` is a KAIROS shape that runs ONE effect
  per write. The #27 fork passed the matrix while costing +30% on both missing shapes.
- **A missing baseline fails closed (2026-09):** `gate.mjs` used to pass a floor/rolling axis
  vacuously when its capture was absent, so a newly added workload gated nothing. It is now
  `NO EVIDENCE` (exit 3, recapture).
- **Memory is `heapUsed + arrayBuffers` (from #27, 2026-09):** `heapUsed` cannot see typed-array
  backing stores. The torture retention witnesses (`torture-soak`, `graph-fuzzer`,
  `scheduler-bench`, via `helpers.residentBytes()`), the zero-GC tests (04, 09) and the
  microscope's heap column now sum both. The perf-gate lane already judged `arrayBuffersKB`.
- **Layout claims go through `harness/layout-ab.mjs` (from #27 + #29, 2026-09):** cold child per
  cell, A/B order alternated, eight shapes plus a 1e3-1e5 resident-graph size sweep with the crossover stated,
  plus a resident-memory lane across power-of-two boundaries. Timing two engines in one process
  (the fork's `soaWitness` ns/op) is not evidence. Run: `node harness/run.mjs layout <candidate>`.
- **Counters are int32-safe (2026-10):** every int32 counter stays within [-2^30, 2^30-1]
  (ceiling 0x3FFFFFFF) or lives in a Float64Array.
- **A creation win must also clear propagation (from #29):** creation rows and propagation rows
  can move in opposite directions from ONE mechanism. A creation-only scorecard is a
  self-reported claim.

---

## G. SoA 2.0.0 research track (LiteSignalExperimental fork)

### #27 -- link-pool Structure-of-Arrays, Tier 1 (built, measured, R3 fallback shipped in-fork)

The frozen AoS link pool (`ReactiveLink` objects, 7 pointer fields) was converted to columns to
shed traced pointers and densify the resident graph (the mark-time / retained-pointer thesis, see
`scratchpad/RESEARCH.md`). Two layouts were built and measured against the immutable AoS foil
(`harness/foil/Signal-aos-1.5.2.js`) on the new `harness/soaWitness.mjs`, node v26.8.2 / M4 Pro.

- **Full 7->0 (source/target as Int32Array node SLOTS, + a dense `node.slot`).** Sheds ALL 7 link
  pointers. Traced pointers at 1e5 nodes / 4e5 links: 4,600,207 -> 1,400,112. **But it FAILED the
  throughput half of the conjunction:** the hot pull-walk now pays a `nodePool[slot]` bounce where
  AoS did a single `link.source` deref. VersionMatrix 3/5 -- **deep-chain +9-12%, creation-churn
  +10-12%** vs the rolling 1.5.0 baseline (confirmed on two runs). This is **Family (c) exactly**:
  a data-layout change that wins GC-marking and deopts propagation. Semantics were perfect
  (local 515/513/0/2, semantic torture 18/4/0, reactive-suite parity with the foil, 0 B/op, jit
  monomorphic x4) -- the conversion was correct, the *layout* lost the conjunction.
- **R3 fallback, 5/7 (source/target as PACKED `Array<ReactiveNode>` ref-columns, `node.slot`
  dropped; the 5 threading fields stay Int32Array + NIL=-1).** Removes the hot-walk bounce
  (`linkSource[l]` is the node directly). **Recovers throughput: VersionMatrix 5/5** (deep-chain
  1.32->1.23ms, creation-churn 0.0267->0.024ms, both back in band). Still sheds 5/7 link pointers:
  traced pointers 4,600,207 -> **2,200,130 (2.09x fewer, 2.4M shed)**, heap 87->58 MB (33% denser),
  markMs ratio ~1.8x, ns/op in band. Ref-columns nulled on free/dispose/destroy (no retention),
  packed (jit monomorphic x4, no HOLEY). **PASSES the conjunction -- this is the shipped-in-fork
  layout.**

**Rule (amends Family (c)):** to trace ZERO pointers per link, source/target must be integer slots,
which forces a pool bounce on every propagation read -- a structural ~10% hot-walk cost. The
defensible SoA link win is the **ref-column hybrid (5/7 shed)**: it densifies the graph and halves
traced pointers while holding propagation at parity. "7->0" is a mark-time mirage that the pull-walk
pays for. The node-scalar / value-slot sessions are the remaining, separate Tier-1/Tier-2 questions.
Nothing shipped to the 1.5.x / 1.6.0-rc lines; the fork stays at 1.5.2, engine banner unchanged.

#### #27 amendment -- independent re-measure (2026-09-24): the conjunction does NOT hold on small graphs

Re-measured per the gate rule ("re-measure every self-reported claim"). Setup: R3 fork `Signal.js`
vs `LiteSignal/Signal.js` 1.5.2 AoS, **one engine per cold process**, order alternated per rep,
10 reps, median, eager registry (`maxNodes 1<<18, maxLinks 1<<20`), anti-DCE `Float64Array` sink,
node v26.8.2 / M4 Pro. Every row that moved has **non-overlapping min..max ranges**.

**Memory: the headline was measured with a metric that cannot see the columns.** `soaWitness`
reports `process.memoryUsage().heapUsed`; the five `Int32Array` columns (20 B/slot) are
ArrayBuffer backing stores and live outside it. `heapUsed + arrayBuffers`, graph delta over an
empty-process baseline, soaWitness graph shape:

| config | nodes | AoS total | SoA total (heap + AB) | delta |
|---|---:|---:|---:|---|
| eager, exact capacity (the soaWitness config) | 1e5 | 80.2 MB | 51.4 + 7.6 = 59.0 MB | **-26%** (not -33%) |
| lazy mirror config (`131072 / 1048576`, grow) | 1e5 | 80.3 MB | 53.3 + 10.0 = 63.3 MB | **-21%** |
| lazy, just below a column doubling | 130,000 | 103.3 MB | 67.2 + 10.0 = 77.2 MB | -25% |
| lazy, just past a column doubling | 132,000 | 104.8 MB | 76.6 + 20.0 = 96.6 MB | **-8%** |
| lazy, just below / past the previous doubling | 65,000 / 66,000 | 52.3 / 53.1 MB | 38.6 / 48.0 MB | -26% / **-10%** |

The columns grow by power-of-two realloc while AoS grew in 1024-link chunks, so the density win is
a sawtooth between ~8% and ~26% depending on where the link count sits. The "4.60M -> 2.20M traced
pointers" figure is a **static model** (soaWitness constants 17/7 vs 13/2 times pool population),
not a heap measurement: correct in direction, modelled in magnitude.

**GC: the real, robust win.** Forced full `gc()`, median of 9: 13.9 -> 7.1 ms (1.95x) eager exact;
12.1 -> 8.2 ms lazy; 16.7 -> 8.9 ms at 132k (past the doubling, still 1.9x: ArrayBuffers are not
traced). This half of the conjunction stands.

**Throughput: "unchanged" does not survive.** SoA / AoS, median ns/op:

| shape | SoA / AoS | note |
|---|---:|---|
| creation churn (signal + computed + effect, mint + dispose per op) | **1.39** | 177 -> 246 ns |
| MUX (256 inputs -> 1 sum computed -> 1 effect) | **1.30** | 1113 -> 1447 ns |
| BROADCAST (1 -> 1000 effects) | **1.30** | 14.0 -> 18.2 us |
| fanout64 (bar 1b) | **1.10** | 734 -> 809 ns |
| KAIROS, DEEP (256), diamond x100, dynamic DAG (retrack every op) | 0.98 - 1.02 | parity |
| resident 1e5 nodes / 4e5 links (soaWitness shape) | **0.70** | 8.10 -> 5.66 ms per set |

**Size crossover** (soaWitness shape, same protocol, 6 reps): 1e3 nodes **1.07**, 3e3 **1.08**,
1e4 **1.02**, 3e4 **0.93**, 1e5 **0.70**. The layout flips at roughly **1e4 nodes / 4e4 links**
on this host: below it the per-hop instruction cost dominates, above it cache density does.

**Diagnosis -- structural, not tunable.** Three cumulative variants of the fork, same protocol:
(v1) drop the new free-list bounds check in `allocLinkSlot`; (v2) also drop the three fail-closed
`linkSource[x] === null` throws; (v3) also make the seven columns `const` (fixed capacity, no
`let` rebinding). Recovered: MUX 1.33 -> 1.30, BROADCAST 1.29 -> 1.23, fanout64 1.10 -> 1.05,
churn 1.33 -> 1.21. The guards and the `let` reloads are 2-12 points; the residual 1.21-1.30 is
the typed-array index hop itself. **This is #12's mechanism minus the bounce**: R3 removed the
`nodePool[slot]` load, which is why DEEP/KAIROS recovered, but every next-pointer hop is still an
indexed typed-array load instead of an inlined field load, and effect-dense flushes, long dep
lists, and create/dispose pay it per hop.

**Growth pause.** One effect linking 1.1M signals under the lazy mirror config, worst single
read: SoA stalls deterministically at each column doubling (1.2 ms @131k, 2.4 @262k, 4.5 @524k,
**12.7 ms @1,048,576**); AoS's worst single stall is 7.7 ms (GC, not growth). Total build time
favours SoA (61 vs 78 ms). The realloc re-introduces the O(n) growth-pause class that P0/P1
chunked growth removed; right-sized eager pools never hit it.

**Why the fork's gates missed it.** VersionMatrix has no MUX workload -- the exact shape that
exposed #10 (+36-49%) and #12 (+65-78%). fanout64 (bar 1b) is not cited for #27. `soaWitness`
times ns/op for BOTH engines in ONE process, which the cold-process rule forbids. The
`scratchpad/RESEARCH.md` it cites (conjunction definition, section 11 noise floor) does not exist
on disk.

**Verdict under the gate order.** Conformance and the internal suite pass; the
independently-measured raw bench (creation AND propagation) **fails on four small-graph shapes**.
By the absolute gate order that makes R3 ineligible as the DEFAULT engine. It remains a measured,
real win for large resident graphs (>= ~3e4 nodes: -30% per set at 1e5, ~2x faster full GC) --
the #14 posture (shelved with its numbers) or a build-time twin selected once at
`createRegistry` (the #17 `settled:true` precedent) are the eligible forms. `snapshot`/`restore`
does not depend on the columns (one walk re-expressed over `link.source`/`link.nextDep`) and is
decoupled from this verdict. Owner's call.

**Rule (amends Law 4 -- the size axis).** A layout change is not a single trade; it is a trade
with a crossover. Per-hop instruction cost wins while the graph is cache-resident; density wins
once it is not. Report every layout candidate across a size sweep with the crossover stated;
a single-size measurement (either side) is a cherry-pick.

---

### #28 -- node-half built + REVERTED; the SoA line is a 1.6.0 MINOR, not a 2.0.0

The node pointer-field conversion (owner-tree + `nextFree` -> Int32Array slot-columns + a re-introduced
`node.slot`) was built and measured. `nextFree` as a column regressed creation-churn a STABLE +8%
(rolling) -- because `nextFree` is touched on EVERY alloc/free, it is NOT a cold field (the #27 rule).
Reverting `nextFree` to an object free-list recovered the bulk; the 4 owner-tree columns (genuinely
cold) still left creation-churn straddling the +5% rolling line (3 PASS / 1 FAIL / 1 unstable-refuse
over 5 runs). The marginal traced-pointer gain (2.09x -> 2.56x fewer) was not worth borderline gates
plus a `node.slot` read on every dispose -> REVERTED to the clean link-SoA (2.09x, VersionMatrix 5/5
stable). **Rule: only fields touched purely on cold paths (create/dispose/cascade) belong in columns;
`nextFree` and any per-op field do not.**

**Version verdict.** link-SoA is an internal representation change with an identical public API and no
breaking change -> by semver it is a MINOR, not a major. A serialization SPIKE
(`scratchpad/serialize-spike/`, 17/17 assertions) proved a pure-int-column graph can be snapshotted and
zero-copy Worker-transferred (ArrayBuffer neutered on transfer), but compute closures cannot travel
(rehydrate by stable id), and -- the decisive point -- the compelling half (in-process snapshot /
undo / time-travel) rides the CURRENT ref-column engine by mapping refs->slots AT SNAPSHOT TIME with
ZERO steady-state throughput tax. Pure-int columns buy only niche cross-worker transfer at a universal
~10% deep-chain cost, so they do not justify a major or a universal tax. **Decision: ship link-SoA as
1.6.0 (denser graph) + a `snapshot`/`restore` in-process time-travel FEATURE on the ref-column engine;
no 2.0.0. The value spike (Tier 2) and `(slot,gen)` handle identity (Tier 3) are moot / dropped.**

---

## H. 2026-09 weak-point analysis (Andrii's harness, 1.5.2) -- what is structural, what moved

Source: Andrii's `js-reactivity-benchmark` (mitata runner, his adapters, lazy AND eager lite
adapters), node v26.8.2 / M4 Pro, plus same-host cold-process probes. Ratios are lite / alien
medians. alien is a reference point, not a target.

**Provenance correction (2026-09-24).** The earlier `bench-lite-signal-20260922T035612Z.log`
did NOT measure 1.5.2: the `node_modules/@zakkster/lite-signal/Signal.js` it ran was a
hand-copied Sep 20 build of the Experimental SoA fork (it carries `linkNextDep` / `REHYDRATE`
/ `FLAG_BOX` under a "v1.5.2" banner), and `dist/index.js` had it bundled in. Andrii's deps
were reinstalled from his lockfile (`npm ci`, lite-signal 1.4.0) and `dist/` rebuilt. The map
below is from clean runs with the engine file named per row. **Rule: a harness whose engine is
swapped by hand records the engine's sha256 next to its log, or the log is not evidence.**

### The weak-point map

Clean run: 1.5.2 (`LiteSignal/Signal.js`, sha256 `f8dd50f8...`) bundled into his harness,
8 interleaved rounds per lite adapter, alien 5 rounds in the same session.

| class | rows (lite lazy / eager vs alien) | verdict |
|---|---|---|
| creation | createDataSignals 21x / 12x; cc0to1 19x / 9.4x; cc1to1 13x / 12x; cc1to2..1to8 22-30x / 16-21x; cc2to1, 4to1 4.4-6.6x; cc1to1000 396x (alien 0.03 ms) | structural -- Law 7 for the ANCHORED gap. On the public unanchored rows the dominant term is dead-code elimination of the lazy engines' creation loops (100k computeds in 0.04-0.42 ms, bimodal run to run; 1.6.0 audit program bench campaign, 2026-10-12; section E rule). Quote public creation ratios with that split. His creation rows keep no handle: alien's computeds are garbage (or DCE'd) at birth, lite's pool retains every one. The eager adapter alone cuts 28-50% on the 1-source rows (no `ReactiveNode` constructed in the window) |
| unobserved set (the "update" rows never read their computed) | 1to1 2.1x / 2.2x; 2to1 1.6x / 1.1x; 4to1 3.3x / 2.3x; 1to2 0.96x / 1.03x; 1to4 3.5x / 2.3x | ~2-5 ns per `set()` of markDownstream + flushEffects framing on a signal with no subscribers; ms-scale rows, noisy. The only levers are the #6 / #7 guard family (rejected). 1to1000 mints 1000 computeds inside the timed body (a creation row); 1000to1 is sub-0.1 ms |
| propagation | app-shaped dynamic rows 1.39-1.56x lazy / 1.12-1.33x eager; layered burst 2.26x / 2.28x (the worst row); layered warm 1.47-1.90x; diamond mesh 1.49x / 1.65x; pure push 1.71x / 1.48x; deep (5x500) 1.62x / 1.36x; manyEffectsFromOneSource 1.49x / 1.55x. Lite LEADS manySourcesIntoOneComputedEffect (0.74-0.78x) and pure pull lazy (0.70x), and ties wide dense eager (0.94x) | per-unit CPU (costmodel: structural work identical) plus locality (D). The one new lever with a clean mechanism is #30. **Creation leaks into these rows:** lite's eager adapter beats its lazy adapter on every app row (0.80-0.85) because his dynamic rows default `measureBuild = (warmupIterations === 0)` -- every app-shaped row (dashboard, editor, kanban, entity, simple / dynamic component, large web app, wide dense, deep, pure push / pull) BUILDS its graph inside the timed window, so the lazy adapter pays `ReactiveNode` / `ReactiveLink` construction and survival copying there (Law 7). Only the large-graph rows (layered, diamond mesh) warm up outside the window. Not chunk locality -- see #31 |
| harness artifact | "Assertion failed" lines on simple component / dynamic component / large web app | alien fails the IDENTICAL assertions (40 / 40 / 20 lines over 10 rounds of the Sep 22 log): stale expectations in `config.ts`, not an engine defect |

### Creation attribution -- why the gap is survival (Law 7)

Measured on the anchored creation rows (all handles kept in a ring), cold process each:

- **Where the time goes.** Under the lazy adapter 45-55% of creation time is scavenger work
  (cc0to1: 6.3 of 14.8 ms). On a pre-grown eager pool, steady `computed()` minting is still
  56% GC by CPU profile; `createNode` is ~5% and the `computed()` body ~13%.
- **It is not the bytes.** With the young generation made large enough that no GC fires in
  the window, per-mint allocation on an eager pool is 336-337 B/op -- equal to alien + its
  adapter (333-352). The lazy adapter adds exactly one `ReactiveNode` per mint: +224 B
  (25 fields x 8 B; Node ships without pointer compression).
- **It is not the closures.** In isolation the callable computed handle (closure + context +
  4 own props) costs 13.6 ns and the signal handle (2 closures + 6 props) 13.5 ns, vs 8.3 ns
  for alien's `bind` pattern. Own props cost <= 4 ns. `setPrototypeOf` to shed them costs
  55 ns (#1 re-confirmed on node 26).
- **It is retention.** The pool is a GC root, so undisposed nodes and their compute closures
  survive the dropped handle and get copied. Give alien the same retention (anchor every
  handle) and its cc0to1 triples, 1.54 -> 4.53 ms; the lite-eager gap narrows from 5.4x to
  2.7x.

### #29 -- literal-site pool construction / allocation-site pretenuring *(REJECTED)*

Built pool nodes and links from a module-level object literal (`makeNode()` / `makeLink()`)
with the IDENTICAL field order instead of `new ReactiveNode()` / `new ReactiveLink()`. A
literal site carries an AllocationSite, so V8 can pretenure it (allocate straight into old
space once it sees high survival); a class `new` carries none. No hot body touched, no offset
moved.

- **Creation: a real, large win.** Andrii-adapter rows, cold process: createDataSignals
  10.7 -> 5.4 ms, cc0to1 14.8 -> 5.6 ms, cc1to1 12.7 -> 6.1 ms; GC inside the window -> 0.
  Suite 513/2/0, GC lane 521/2/0, perf gate 10/10 (both mustFail controls trip), torture
  21 / 5 floor-skips / 0. Every semantic gate green.
- **Propagation: fails gate 3.** Cold 9-shape matrix, 10 reps: MUX +71%, KAIROS +23%,
  DIAMOND +19%, BROADCAST +17%, DEEP +16%, fanout64 +14% (five separated), and bimodal per
  process (one MUX process ran at baseline, the others +80%) depending on when the
  pretenuring decision fired during construction.
- **Mechanism, proven both ways.** Under `--no-allocation-site-pretenuring` BOTH effects
  vanish (creation back to 12.6 / 11.2 ms, propagation back to baseline). Forcing the
  decision before the registry exists (whole pool pretenured, no young/old split) shrinks
  the loss to +3-14% (MUX +7-14%, DEEP +8-10%, KAIROS +3-4%) but does not remove it.
- **Rule.** The allocation site is part of the layout (Law 4). A creation win that moves
  where the pool lives must clear propagation, and a win that depends on when a V8
  heuristic fires is not a property of the engine.
- Spike kept for reproduction: `futureVersions/Signal-1.5.2-pretenure-REJECTED-29.js`
  (git-ignored). Reproduce the mechanism with and without `--no-allocation-site-pretenuring`.

### #30 -- "observer-fold": fold `isTrackingDeps` into `currentObserver !== null` *(LANDED in the working tree, unreleased -- every gate passed)*

Naming: early drafts called this "K1". LiteSignal+/1.13.0 already uses K1 for its difftest
criterion, so the ledger name is **observer-fold**.

`isTrackingDeps` is redundant state. Tracking happens iff `isTrackingDeps && currentObserver
!== null`, and every site that clears the flag either also nulls the observer (fireConnect,
runCleanup, runWithOwner, createRoot, destroy, self-dispose) or keeps the observer only to
suppress tracking (`untrack`, `subscribe`'s untracked callback). Deleting the flag:

- **Read fast paths** (signal / computed / boxGet / boxComputedGet): `isTrackingDeps &&
  currentObserver !== null` -> `currentObserver !== null`. One context load and one branch
  less per tracked read, and FEWER bytes in four hot bodies (Law 1 in the helpful direction).
- **executeEffect / pullComputed:** two context stores less per run (save + restore of the
  flag); `isTracking()` becomes `currentObserver !== null`.
- **`untrack` / subscribe callbacks** null the observer instead, and restore it only if its
  `gen` survived the window: `currentObserver = (po !== null && po.gen === pg) ? po : null`.
  That reproduces exactly what disposeNode's `currentObserver === node` guard does today when
  an observer disposes itself inside an untracked region (the only non-tracking use of
  `currentObserver` in the engine, audited line by line).

Not re-litigation: #4 / #6 / #7 ADDED guards to hot bodies; #30 DELETES state and bytes.

Evidence (measured candidate kept at `futureVersions/Signal-1.5.2-K1-candidate-30.js` + `K1-candidate-30.diff`,
git-ignored; the landed `Signal.js` is byte-identical to it in executable code, comments aside):

- gate 2, internal: suite 513 / 2 / 0, GC lane 521 / 2 / 0, perf gate 10 / 10, torture 21 / 5 floor-skips / 0.
  Andrii's vitest adapter suite: 14 / 14 lite tests on both adapters.
- gate 3, independent raw bench (cold 9-shape matrix, 10 reps, observer-fold / 1.5.2 medians): fanout64
  **0.90** (separated), MUX 0.93, resident 1e5 graph 0.95, DEEP 0.97, DIAMOND 0.97, KAIROS
  0.98, BROADCAST 0.98, dynamic DAG 0.98, creation churn 1.02 (overlap). No shape separated slower.
- Andrii's harness (his adapters, his mitata runner, clean-reinstalled deps with the engine
  file set per build; 8 interleaved rounds x 2 engines x {lazy, eager} adapters, 45 rows per
  block, all 32 blocks complete). Geomean observer-fold / 1.5.2 over rows >= 0.2 ms: propagation
  **0.971** lazy / **0.962** eager (23 rows each), update 0.989 / 0.974, creation 0.992 /
  0.996 (neutral, as the mechanism predicts). Separated faster:
  manySourcesIntoOneComputedEffect(+WithDirect) on both adapters, manyEffectsFromOneSource
  (lazy). Layered burst flush 732 -> 594 ms lazy (0.81), 736 -> 629 ms eager (0.86).
  **One flag:** `avoidablePropagation` separated SLOWER on the lazy adapter (0.39 -> 0.42
  ms, 1.08) while the same shape is 0.97 on eager. Sub-half-millisecond row; recorded as
  open, not waved off. The VersionMatrix and real-hardware gates must re-check it.
- Context for the flag: the same row moved 0.40 -> 0.36 ms (separated FASTER) under #31, a
  change that does not touch its path at all. The row flips sign on unrelated changes.
- gate 1, external conformance (johnsoncodehk suite, lite column, `node harness/run.mjs conformance`):
  196 cases, **0 per-test differences** vs 1.5.2 (177 / 1 / 0 both; the 1 is #179, the #15
  absorption contract; 18 behavioral values identical). The runner's negative control (a
  sabotaged `untrack`) produces 4 diffs and exits 1.
- pipeline: planner -> coder -> reviewer REJECTED (non-ASCII in ledger lines + a null->0
  print in the new torture) -> coder fixed -> reviewer APPROVED -> qa PASS. QA's
  `test/34-observer-fold.test.mjs` (24 cases: isTracking truth table, untrack depth 0..64,
  throwing untrack, self-dispose inside untrack incl. slot recycling, subscribe self-dispose,
  createRoot / runWithOwner inside untrack, nested subscribe ownership, 1e4-cycle churn)
  measured: npm test 539 / 3 / 0, test:gc 547 / 2 / 0, perf gate 10 / 10, torture 21 / 5 / 0,
  `test/torture.mjs` 0 B/op maxMajor 0, 1e4 cycles back to baseline with a resident delta of
  38.11 KB (<= 64 KB).
- STILL OPEN: the VersionMatrix gate on the 7 workloads (needs a same-host capture), the
  release target (the 1.5.x line kept Signal.js byte-identical across patches -- a 1.5.3
  patch vs folding into the 1.6.0-rc line is the owner's decision), and the forward-port to
  1.6.0-rc.2 .. 1.11.0 (38 identical sites each) and LiteSignal+/1.13.0 (47: +9 in its
  push-pull / iterative twins). Expected size of the win stays modest (2-10%): a
  correctness-neutral byte deletion, not a paradigm move.

### #31 -- larger lazy refill chunks *(NULL -- no effect, not shipped)*

Hypothesis: the eager adapter's 15-20% lead on app rows was lazy-chunk locality (pool
objects built 256 nodes / 1024 links at a time, interleaved with user allocations). Probe:
chunks 256 -> 2048 nodes, 1024 -> 8192 links, cold code only. Andrii's harness, lazy
adapter, 6 interleaved rounds: propagation geomean **1.008**, every app row 0.98-1.01,
creation 1.003. No effect. The real cause was the harness timing the graph build
(`measureBuild`, see the map above) -- construction cost, not placement. It would also have
cost lazy's small-footprint promise (a throw-policy default registry would populate up to
2048 nodes / 8192 links on its first miss). Closed.

---

## I. 1.6.0 audit program (2026-10) -- cursor-safety designs refused

Four designs for keeping a suspended frame's re-tracking cursor safe (the #20 follow-up, F15) were refused: forward-pointer pinning (#32, built), H1 (built and measured), H2 (bounded by a control, not built) and H3 (unsound by reading) (#33). Provenance: 1.6.0 audit program, A1 rounds 2-4, 2026-10-11.

| # | optimisation | result | mechanism |
|---|---|---|---|
| **32** | Forward-pointer link pinning for cursor safety (A1 round 2) | REJECTED -- every link freed under a COMPUTING target is withheld until depth 0, so 5000 temporaries in one run, or an effect owning 1000 computeds with maxLinks 1500, throw CapacityError where the pre-A1 tree passes | capacity is consumed by correctness bookkeeping; the cursor stack holds one slot per frame instead |
| **33** | Cursor-safety alternatives H1-H3 (A1 round 3-4) | H1 savedCursor on the node REJECTED: bimodal, fanout64 up to x1.84, mux x3.7, +8 B/node. H2 Int32 index stack: bounded at x1.076 or worse by the stack-load-only control, not built. H3 derived cursor: unsound (untracked pulls, a node disposed during its own pull, and pre-walk pulls have no read position) | every variant tried with one per-frame memory write ran diamond >= x1.055 (unsafe local-save control x1.003); PRELIMINARY, noisy host (load 3.7-5). H5 (frameNode-narrowed pinning) is unbuilt and open |

## J. 1.6.0 soak findings (2026-10) -- engine defects

Twelve findings from the 1.6.0 verification and soak work (`bench/soak/`, decisions/0001-soak-design.md) and review: eleven engine
defects and one former candidate (#36, triaged b77 as F5). #34, #35, #36, #37 (F-b33-1), #38 (F6), #39, #40, #41 and #42 ship
in 1.5.2. #34 is OPEN at HEAD (its fix belongs to the Phase A group named below); #35 is FIXED on 1.6.0-dev (c2f123c);
#36 (F-MB) is TRIAGED and folded into DIV-F5 (F5, OPEN, FIX-R in A3); #37 (F-b33-1) is FIXED on 1.6.0-dev (f4f9475,
32625fe, 87a9e92) with three KNOWN residuals; #38 (F6) is FIXED on 1.6.0-dev (FIX-T, 0878c6b); #39 (null opts leak) is FIXED on 1.6.0-dev (075a92c);
#40 (disposeNode keeps the lifecycle entry) is FIXED on 1.6.0-dev (73d6a90); #41 (error -> equal value) is FIXED on 1.6.0-dev (FIX-T, 0878c6b, D-K); #42 (clean dep cycle -> stack overflow) is FIXED on 1.6.0-dev (FIX-T, 0878c6b; CycleError, with residuals in its row); #43 (restore re-runs an effect once more than live, F-b101-1) is OPEN (A9, pre-existing, its own unit after FIX-T); #44 (read-path slot reuse across allocateLink user code) is FIXED on 1.6.0-dev (b104, Signal.js sha256/8 e912e302; its own unit after FIX-T); #45 (op 3 reported for an edge an onConnect hook already removed) is FIXED on 1.6.0-dev (b105, Signal.js sha256/8 d00484d6; KNOWN lone-op-4 residual for a disposed target); #46 (a throwing onConnect leaves a live edge with no op 3) is OPEN (pre-existing, found b105 by the #45 reviewer, opened by the maintainer b105; its own unit).

| # | finding | status | mechanism |
|---|---|---|---|
| **34** | F20: int32 closure counters allocate 12 B per write in [2^30, 2^31) on pointer-compressed V8 (Chrome, Electron) | OPEN at HEAD (shipped 1.5.2; A4-V2 not landed). REPORTED (2026-10-10, jsvu d8 15.7.37 arm64, pointer_compression: true; engine probe s7/eng-set-*.mjs, one signal + one effect, 1e7-write windows, 1 MB semi-space, scavenges counted between markers): kernels 1.5.2 (f8dd50f8) and wt (7f707ccd) both 0 scavenges warm -> 114 scavenges (about 11.95 B/write) once globalVersion is in [2^30, 2^30 + 1.2e7); Node (32-bit Smi) unaffected | a closure-context `let` in a context of more than 2 slots holds a non-Smi as a HeapNumber, so every write allocates 12 B. Rule: no int32 closure counter leaves [-2^30, 2^30-1]; exact counters live in a Float64Array slot. Log: audit/2026-10-07/verification/VERIFICATION-2026-10-10.md:132-159 (git-ignored); SPEC-B addendum 7 |
| **35** | F21: a CycleError ("flush passes exceeded") or a same-pass dispose leaves stale queue entries that later run a recycled slot | FIXED on 1.6.0-dev (c2f123c, qskip2, 0 B; soak DIV-F21 fixedIn "A2-F21", be0fe70); still present in published 1.5.2. KNOWN residuals, both equal to the pre-fix engine 740edfc (maintainer ruling D5, pinned as KNOWN rows in test/58): R1 a recycled scheduled resident that is legitimately queued in the window gets 3 scheduler calls (ideal 2), body runs 2; R2 a recycled unscheduled resident legitimately queued runs early at the stale entry's position (test/58 row 3 pins the order "C0,C,M"); when a later write in the same pass re-queues it (KNOWN R2): 3 body runs (ideal 2), last value 2 (correct). Census history (a measurement, pre-fix): soak ERROR census of 4000 worlds: 3 on 1.5.2, 23 on the audit patch build (bench/soak/calibration/f21-census.json) | the abort branch of flushEffects keeps activeQueue and FLAG_QUEUED; after the effects are disposed and the slots reused, the next flush runs the new residents and a first run throws "Infinite effect loop detected" from an unrelated effect(). Found by the soak ERROR lane. Fix: `flushEffects` runs a queue entry only while `(node.flags & FLAG_QUEUED) !== 0` (was FLAG_EFFECT) and the test also guards the scheduler branch; every QUEUED period owns one entry (QUEUED is set only in markDownstream with its one push, and cleared by executeEffect; dispose and destroy zero every flag). Rejected: fix3 slot pinning (CapacityError at N=520 under the default registry). Creation abort site (new on 1.6.0-dev, F-b33-1): a CycleError thrown at effect() creation is one more way to abort a flush and leave the failed effect's queue entry behind; an effect created after it recycles that slot (test/56 X2R, b1e7a06: with qskip2 stripped the mutant M12 dies on X2R with "Infinite effect loop detected.", runs 1; the fixed engine passes) |
| **36** | F-MB (folded into DIV-F5): four BATCH-lane BREACH lines with known=none: O2 glitch + O1 effect-stale (BATCH:1:0xb08f012b; scen effect-created-mid-batch, multi-write-same-signal, revert-no-read) and O1 computed-mismatch + O4 effect-dead (BATCH:2:0xfd8b9606; scen effect-created-mid-batch) | FOLDED into DIV-F5 (F5, OPEN, fixBy A3; maintainer b77). Triage b77 (.handoff/b77-evidence/fmb/VERDICT.md, reviewer APPROVED): both keys shrink (4 and 9 ops) and reproduce on tree / preb33 / rev152, and are clean on headpatched and on tree + the FIX-R hunks only. They stay known=none in the soak until A3 lands (maintainer b77: no tagger or registry edit before it): key 1 is a tagger gap (the effect's first run is the mid-read, but onEffectCreated marks none, so the revert is tagged revert-no-read); key 2 is tagged revert-after-mid-read, but its O4 effect-dead line is not among DIV-F5's oracles. Contract (maintainer b77): the p2 rule (a mid-batch effect re-runs at batch close iff a source it read changed after its first run) wins over the batch doc comment Signal.js:1945-1947, which A3 amends. A3 must cover body-observed intermediates and add a red-first boxSet row (the soak writes via h.set only, so the boxSet revert site is unexercised). Accepted cost (R13.2, b103): the DIV-F5 O1c shape was widened (b103), so an F6-shaped regression in a revert world reads as DIV-F5 until A3 lands; re-narrow the DIV-F5 shape when FIX-R lands | F5 by two more observation paths. (1) An effect created mid-batch reads the intermediate on its first run; the revert to the pre-batch value restores the version, so the computed keeps the intermediate value, the mid-batch effect never re-runs, and a reader created before the batch re-runs at batch close and reads the stale value (O2 glitch, O1 effect-stale on that reader). (2) A mid-batch read re-evaluates a conditional computed, which drops a dependency; the revert restores the version, so a later write to the dropped source never reaches the computed or its effect (O1 computed-mismatch, O4 effect-dead). NOT the ERROR-lane F6 below |
| **37** | F-b33-1: a write made during an evaluation lost the reader's update (a body mid-run had already read the old value) | FIXED on 1.6.0-dev: engine f4f9475 (B1 + B1-fix), D-R3 32625fe (a false CycleError through an absorbing mid-run computed), KC 87a9e92 (the flag depended on subscription order: a lost update along s -> P -> T). Tests: test/56. R2-M1 (creation abort) is fixed and modelled by the soak (eb5acc2), see decisions/0001 Amendment 2026-10-18. The soak now witnesses it: lane WIE (unit 0s; DIV-B33 explains the lost update on the preb33 heads, must-fail controls L-WIE-preb33 and L-WIE-rev152, oracle test/66). KNOWN residuals, each pinned in test/56 (D-M1 and D-M2: maintainer "accept all three" 2026-10-14, b1e7a06; KC-NEST0: PLAN N13.2, accepted for 1.6.0, not a release blocker): D-M1 a write in the pre-walk through an equality-cutoff computed forces +1 reader run (EQ e2After 1, ideal 0; value-correct, at most +1 run per write wave); D-M2 a write from onConnect, or from an onDisconnect fired by severTail, runs under the reader's owner and is absorbed as its self-write (P1 / P1b seen 0, ideal 10; Signal.js header "WRITE DURING AN EVALUATION"); KC-NEST0 KC-NEST without P (T = X()): the write by W is absorbed by the 4a self-write clause (second X read 1, pinned) | a write while a body is mid-run (cursorDepth !== 0) goes through markDownstreamInEval: FLAG_STALE_READ (1 << 6) on every COMPUTING reader reachable from the written signal along some path through no mid-run computed (order-independent, shadow re-push) that is not the writer. A stale effect is re-queued (requeueStaleEffect) and runs again in the same flush; a stale computed is re-pulled in the same read under the staleRepulls cap ("CycleError: computed keeps invalidating its own reads"). A CycleError can now fire from effect() creation and from reads. Cold path only: the 10 hot functions byte-identical across D-R3 and KC; markDownstreamInEval 235 -> 290 -> 335 B (maintainer N11, N14) |
| **38** | F6: a dependency pre-walk has no catch, so a throwing computed dependency escapes it. Two sites plus a residue: the EFFECT pre-walk, the COMPUTED pre-walk (pullComputed), and pullComputed's cached-rethrow fast path | FIXED on 1.6.0-dev (FIX-T, commit 0878c6b, D-H; Signal.js sha256/8 928f0e64); still present in published 1.5.2. Fix: the dependency pre-walk of both sites (the computed pre-walk in `refreshComputed`, the effect pre-walk via `pullMoved`) calls `refreshComputed`, which returns void and never throws the node's own cached error; the dependent re-runs and its body's read of the errored dep throws the same error object (which the body may catch). READS of an errored computed (`pullComputed`, the computed read closure) still throw the cached error until a dep changes. The residue (cached-rethrow fast path) goes with it. Original finding: published 1.5.2 reproduced both heads; the b53 scratch kernels fixed one site each and the other site still reproduced. The soak labels it DIV-F6, widened in b53 (3 standalone shapes: engine-side ERR(computed:N) in O4 effect-dead, O1 computed-err-mismatch, O2 glitch; worldScen recovery-after-throw, notWorldScen revert-after-mid-read). Tagger gap, follow-up: the cached-rethrow path runs no body frame, so scenarios.mjs:151-154 never tags it. 1.6.0-dev added a trigger: a re-pull-cap computed CycleError inside an effect's pre-walk stranded the effect (test/56 F6K, was KNOWN runs 1); fixed with D1(b) (the cap now caches the CycleError as the node's own error) + D-H (test/56 F6K header: runs 3). Restore copies live state, so a restored graph no longer rethrows from a pre-walk either. | effect site: the token escapes set() / batch() unpredicted and the effect stays queued forever (O6 escape-computed + O4 effect-dead). Computed site: pullComputed's pre-walk (preb33 :1283, 1.5.2 :1085) has no catch; the throw escapes MID's pre-walk, MID keeps its old version and, on recovery, the equality cutoff (preb33 :1319) keeps it, so a computed reader keeps a stale cached ERR(computed:N) and an effect never re-runs. Cached rethrow (preb33 :1261-1263, :1269-1273): the same bug when the throwing dependency was already evaluated in this version. Line numbers as of the b53 triage. Evidence: .handoff/b53-evidence/triage-SUMMARY.md, t2-SUMMARY.md |
| **39** | null opts leaked a node or a lifecycle entry: `signal` / `computed` / `signalBox` / `computedBox` / `effect` read `opts.equals` / `opts.scheduler` after `createNode`; `observeObservers` created its lifecycle entry and bumped the lifecycle count before reading `opts.onConnect`. The call threw `TypeError` correctly but left allocation behind | FIXED on 1.6.0-dev (075a92c; Signal.js 734b7e0b -> 78d5a262; found by reviewer NIT b60 + coder sweep b61). Tests: test/60 (62 tests, 33 red on the frozen build), test/61 (39 boundary probes, 33 red on the frozen b61 build), test/59 rows 10-11. Probe: 10/10 creation entries x {registry, default exports} leaked an active node (+1, never freed) on the frozen build, 0/10 live; `observeObservers` +1 on both registry method and default wrapper, 0/2 live | every opts read is hoisted above the allocation (maintainer ruling b61: read opts first, no new checks); cold paths only, 7/7 hot bodies byte-identical. The lifecycle leak left a hook-less entry (freed only by a later `observeObservers` + unobserve on that slot) that kept the internal count non-zero, and so the connect/disconnect branch on for every link, until then. Side effect: a getter-defined `onConnect` / `onDisconnect` is read once, not twice. |
| **40** | `disposeNode` never deleted the node's lifecycleMap entry: a signal disposed without calling the `observeObservers` off() handed its onConnect / onDisconnect hooks to the next resident of its pooled slot, and the internal lifecycle count stayed above 0 (the zero-cost gate stayed on). Second site (b62 sweep finding, outside the maintainer's R1/R2 ruling): registry `destroy()` bumped every node's gen and rebuilt the free list without clearing hooks | FIXED on 1.6.0-dev (73d6a90, b62). Pre-existing: shipped in 1.5.2 (probe: fired = 1 on HEAD and on 1.6.0-dev). Tests: test/62 (19 tests, 12 red on the previous engine; white-box lifecycle-count lane). Bytes (node v26.8.2): `disposeNode` 667 -> 686 B (+19, the only changed hashed hot body), `dropLifecycleHooks` 31 B new (cold), `destroy` 619 -> 638, `observeObservers` 169 -> 181 | the entry is keyed by node; only the off() closure deleted it (same inheritance path as #39, reachable without any throw). Fix: `disposeNode` calls a cold `dropLifecycleHooks(node)` when `lifecycleCount !== 0`, just before the gen bump, so every dispose path (dispose(api), effect disposer, owner cascade, re-entrant dispose, pinned) drops the entry, including hooks registered by user code during teardown; `destroy()` makes the same call per node. Folded in: the unobserve returned by `observeObservers` captures the node's gen and is a no-op once the node is disposed, so a stale unobserve no longer removes the next resident's hooks (before, it did). Dev-only note: removing the unobserve's delete (M-OFF) is no longer visible to torture's NEST lane; test/13 + test/62 catch it |
| **41** | error -> equal value is not a change: a computed that cached error X and then returns a value Object.is to X (or one its custom equals accepts) keeps its version, so a reader that caught the error never re-runs | FIXED on 1.6.0-dev (FIX-T, commit 0878c6b, D-K); still present in published 1.5.2 (found b98 by the A9 engine reviewer, probe P2; maintainer repro .handoff/fixT/err2val.mjs: after strict.set(false) A returns X but B stays "caught", bRuns 1, effect never re-runs). Ruling D-K (b98): fix in the FIX-T / D-H burst (same function, same perf gate, same CHANGELOG "error semantics" entry); err2val.mjs is the gate that fails on the old code | pullComputed success branch runs the equality check even when the previous state was FLAG_HAS_ERROR. Fix (`refreshComputed`, Signal.js): the change test is true when the previous state was FLAG_HAS_ERROR, so a custom `equals` is NOT called on an error and leaving an error always moves value + version. How other libraries compare here (Preact, the TC39 polyfill) is UNVERIFIED and not claimed |
| **42** | A computed whose body catches a CycleError from a partner leaves a CLEAN dependency cycle; the next read after a write to a dep recurses in the pull pre-walk until RangeError (Maximum call stack size exceeded) instead of throwing a CycleError | FIXED on 1.6.0-dev (FIX-T, commit 0878c6b): the pre-walk throws `CycleError: Circular dependency detected.` at depth > nodePool.length; still present in published 1.5.2 (found b100, probe .handoff/b100-evidence/P0c/probe.mjs, out.txt). Repro: `const s = r.signal(0); let D; const C = r.computed(() => { try { D(); } catch (e) {} return s(); }); D = r.computed(() => C()); C();` then `s.set(1); C();` threw RangeError on 1.5.2; it throws CycleError since FIX-T. Fixed in FIX-T (same pre-walk as D-H), NOT A9. snapshot() emits the cycle (both nodes clean, deps [3,1] and [2]); restore() reproduces it by design (restore copies live state, D-N) and so reproduces the now-CycleError | the pull pre-walk (pullComputed) walks a clean node's recorded deps recursively; after the CycleError was swallowed inside C, C and D each hold the other as a clean dep, so once s moves the pre-walk C -> D -> C never meets a node it can mark or skip and recurses without a depth guard. Fix: a depth guard in the pre-walk (`refreshComputed(node, depth)`, `if (depth > nodePool.length) throwComputedCycle()`) that raises CycleError. Residuals (measurements: Node v26.8.2, darwin, 2026-10-22; depths untimed; timing K=9 at load 2.9-3.4, PRELIMINARY; .handoff/fixT/perf/SUMMARY.txt): the cold first-read chain depth is 6.1% below (warmed bisection 2411 vs 2567) and 6.4% below (one-shot fresh process 1984 vs 2120) the pre-FIX-T 1.6.0-dev build B0 (08401c2) (percentages = 1 - live/B0 from those depths; .handoff/b102-evidence/B1fix/chain-ab.txt, a6-oneshot.txt); the write + 1-level refresh path measured about 6% slower than the pre-FIX-T 1.6.0-dev build B0 (08401c2, Signal.js sha256/8 98295467; B4 lane L6, B0/W2 0.940); clean computed reads measured about 3x faster than B0 in every round but inconclusive under the A/A band rule. Residual (b102, maintainer): a chain of computedBox read via get() keeps the pullComputed wrapper, so it pays one extra stack frame per cold level (computedBox get() chain: 1945 levels warmed; the computed read closure inlines the refresh); the cold-chain depth gate covers the read closure only. Residual (ADDENDUM 2): the guard fires at depth > nodePool.length, so a pool above the pre-walk stack limit still RangeErrors (b102, node v26.8.2: eager maxNodes 4096 / 16384 / 65536 -> RangeError; default 1024 -> CycleError). Residual (grow pool, .handoff/b102-evidence/F/p42.txt): `onCapacityExceeded: "grow"` with a population of 20224 -> RangeError on the live build too (the guard needs depth > nodePool.length, above the stack limit). |
| **43** | F-b101-1: restore -- a seeded errored dirty computed that leaves its error re-runs the restored effect once more than live | OPEN (A9 snapshot/restore; PRE-EXISTING at HEAD 08401c2, found in burst 101, not caused by FIX-T; surfaced because D-K made test/76 D-I2's E-returns-E shape leave the error). Maintainer ruling b101 ADDENDUM 6: its own unit after FIX-T; test/76 D-I2 (P2) becomes a KNOWN pin in burst 102. Repro: `s = signal(1); c = computed(() => { if (s() < 3) throw E; return "ok"; }); effect(() => { try { c(); } catch {} untrack(() => { if (s() < 2) s.set(2); }); });` then snapshot -> restore; set 5 then 6 on both: live runs the effect at 5 only, the restored graph at 5 AND 6 -- on the frozen HEAD build too (.handoff/b101-evidence/B1/probes/di2d.mjs, di2-dump.txt) | snapshots of both twins after each write are field-equal (gv, flags, version, evalVersion, markEpoch, deps, subPos), so the divergence is in state snapshot() does not record. Candidates: the effect's queue / QUEUED_STALE / STALE_READ handling at restore, the seeded computed's equals. The 1200-graph fuzz misses it. Fix: not yet designed (find the unrecorded state first) |
| **44** | Read-path slot reuse across allocateLink user code: a read function's entry gen check runs BEFORE allocateLink, which can run user code (observeObservers onConnect via fireConnect, an onGraphMutation op-3 listener, severTail -> freeLink -> op-4 / onDisconnect); a callback that disposes the node being read (and re-seats its pooled slot) makes the read return the new occupant's value (computed: also runs the new occupant's body inside the old read; dispose-only computed: caches TypeError "node.computeFn is not a function" on the dead node) | FIXED on 1.6.0-dev (b104, Signal.js sha256/8 e912e302; was 928f0e64 at HEAD bfcf95b). Pre-existing (OPEN at HEAD 08401c2 before the fix; found b102 by the B1-fix coder for computed; widened by the maintainer to all four read functions with a signal probe). Affected: signal read, computed read closure, signalBox get, computedBox get (the four read functions in Signal.js; line numbers move). Evidence: .handoff/b102-evidence/L44/alloclink-usercode.mjs + .txt (computed), alloclink-signal.mjs (signal + signalBox: ["D-value"] on HEAD and tree for onConnect reseat and op3 reseat). Ruling (maintainer b102, PLAN-0s-fixt.md ADDENDUM 9): NOT part of FIX-T (FIX-T stays behavior-identical here: its read closure snapshots gen right before the refresh); own unit AFTER FIX-T | the gen check at read entry precedes allocateLink, and allocateLink can run user code that disposes the node and re-seats its slot, so the read continues against the new occupant. Fix (b104): each of the four read functions re-checks `if (node.gen !== birthGen) return undefined;` right after allocateLink and returns undefined (the cursor-reuse arm and untracked reads are unchanged). Cost (node v26.8.2, quiet host, --print-bytecode, .handoff/b104-evidence/A6-growth.txt): +18 B bytecode per reader (read(signal) 88 -> 106, read(computed) 182 -> 200 of the 460 B inline limit, boxGet 78 -> 96, boxComputedGet 81 -> 99); all 4 still inlined, 0 deopts, jit-health 5 bailouts = baseline; timing (interleaved A/B vs 928f0e64, K=9 rotated rounds, node v26.8.2, darwin, quiet host, load 2.42 -> 2.33, 2026-10-23, .handoff/b104/perf/SUMMARY.txt; tracked read in an effect re-run, cursor-reuse and allocateLink arms of all four readers): 7 of 8 lanes measured inside the run's own A/A noise band, the 8th (computedBox get, reuse arm) inconclusive (its A/A band, 0.949..1.003, leaves [0.95, 1.05]); a padded control build measured slower beyond the band on all 8. Gate: test/79-l44-read-reuse.test.mjs (31 tests, --expose-gc): 4 kinds x 3 triggers red on 928f0e64, 4/4 noRecheck mutants killed, zero-GC (minor 0 over 1e6 reads, retained growth < 0.5 B/op) + retention rows. A reader of a node disposed by hook code now returns undefined, like other stale-handle reads; Signal.d.ts keeps `(): T` (maintainer ruling D2; JSDoc in Signal.js only) |
| **45** | onGraphMutation op 3 (link-add) is emitted for an edge that no longer exists: in allocateLink, fireConnect(source) runs the onConnect hook BEFORE `mutationHook(3, source.id, target.id)`; a hook that disposes `source` (unlinking the new edge) and creates a node that reuses its pooled slot makes op 3 report the NEW occupant's id as the source of an edge that was never created | FIXED on 1.6.0-dev (b105, Signal.js sha256/8 d00484d6; was e912e302 at HEAD b32a6f3). Fix: fireConnect(source, target) records both endpoints' gens before onConnect and returns whether either changed; allocateLink does `if (_was0 && fireConnect(source, target)) return;`, so op 3 is emitted only for an edge that survived the hook (order "connect, op 3" kept). Cost (node v26.8.2, --print-bytecode, untimed, .handoff/b105-evidence/L45/a6-after.txt): allocateLink 567 -> 572 B (+5), fireConnect 107 -> 142 B (cold, never inlined), the 4 readers unchanged (106/200/96/99), inlining census unchanged, 0 deopts, jit-health --strict 5 bailouts = baseline; not timed. Gate: test/80-l45-op3-ghost.test.mjs (17 tests; ghost rows A source-disposed+reseat, B source-disposed, C target-disposed, D observer self-disposed, plus KNOWN C/D rows, red on 928f0e64 and e912e302; mutants M1/M2/M3 killed, 6/4/2 rows failing). KNOWN residual (maintainer b105, covers C and D): the hook's dispose of the target emits op 4 for the new edge whose op 3 is now never emitted, a lone op 4 (a Mirror replay reports 'op4 on non-live id <target>'); pinned in rows 'KNOWN C residual' / 'KNOWN D residual'. Published 1.5.2 (ec36ab8, Signal.js f8dd50f8) has A and B; on 1.5.2 C instead leaves a live phantom edge (already fixed on the 1.6 line; .handoff/b105-evidence/L45-152/op3-152.txt). Was: OPEN at HEAD a347f3a (Signal.js sha256/8 e912e302, unchanged since 564579d) and on bfcf95b (Signal.js sha256/8 928f0e64, pre-#44): pre-existing, found b104 by the #44 reviewer, opened by the maintainer (b104). Evidence: .handoff/b104-evidence/L45/op3.mjs + op3.txt (`K=<Signal.js> node op3.mjs`): both builds log ops ["op1 2","op1 3","op3 3->2"] with activeLinks 0 (id 3 = the re-seated D; the read itself returns undefined on e912e302 per #44, "D" on 928f0e64). Scheduled (maintainer b104): its own unit after the #44 qa pass | Was (b104 plan; done b105: red-first rows = test/80 A-D, consumer decision = PLAN-45 ADDENDUM 1 Q1/Q2): the op-3 emit reads `source.id` and `target.id` after user code ran; the A1.5 (S1) comment fixes the order "connect, op 3", so the fix must keep that order and skip (or correct) op 3 when the edge was unlinked by the hook, e.g. re-check that `link.source === source` and the source gen is unchanged before emitting. The re-check belongs inside the `_was0` branch (or a cold helper); bytecode growth to be measured as for #44. Needs a red-first row (op-3 listener + onConnect dispose/reseat) and a decision whether a devtools consumer may rely on the current op stream (note: disposing a source emits op 2 but no op 4 for its live sub edge; disposing a target emits op 4). Same ghost op 3 when the hook disposes source with no reseat (dead id) or disposes target (op 4 1->2, then op 3 1->2); reviewer probe b104 (.handoff/b104-evidence/L45/v.mjs, `K=<Signal.js> T=A|B|C node v.mjs`), both builds. Red-first rows for all three; the re-check covers both endpoints' gen |
| **46** | onGraphMutation op 3 is never emitted for an edge that stays LIVE when an observeObservers onConnect hook throws (the inverse of #45) | OPEN at Signal.js sha256/8 d00484d6 (b105 #45 fix tree) and on e912e302 (HEAD b32a6f3), 928f0e64 (bfcf95b) and published 1.5.2 (ec36ab8, f8dd50f8): pre-existing; found b105 by the #45 reviewer, opened by the maintainer (b105). Evidence: .handoff/b105-evidence/L46/op3-throw.mjs + op3-throw.txt (`K=<Signal.js> node op3-throw.mjs`): an effect that catches the throw from S's read and then reads T ends with activeLinks 2 but only one op 3 (`3:2->3` for T) on all four builds -- the S edge is live but was never announced. A Mirror replay under-counts edges (test/80 N3 world: activeLinks 1, mirror edges 0). Pinned today only as test/80 N3 "(not wedged)" (a throwing onConnect emits no op 3 and the error propagates) | allocateLink links the edge into both lists, then fireConnect(source) throws before `mutationHook(3, ...)`; the edge stays (by design since A1.5/S1, so a throwing hook cannot strand a half-linked edge), but its op 3 is skipped. Fix options for its planner: emit op 3 in a finally / after a caught throw while keeping the "connect, op 3" order, or unlink the edge on a throw; needs a red-first row and a decision on the op order under a throw. Related test gap (reviewer b105, mutant X3): dropping fireConnect's A1.6 `finally` restore survives every onConnect test; the catch-and-continue effect above would kill it (after T.set the effect must run 2 times) |

---

*MIT © Zahary Shinikchiev. The ledger is the map; the laws are the territory. Keep it whole,
so nothing is re-litigated and every future spike starts from what's already known.*
