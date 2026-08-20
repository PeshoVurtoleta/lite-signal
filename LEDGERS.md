# lite-signal — the consolidated ledger

*Every hot-path optimisation tried and refused, every regression bisected, every bug
repaired, and the laws each one produced. This is the evidence base the post-1.12.0
exploration roadmap builds on: it is why "the engine is at its lazy-pull optimum" is a
measured result rather than an assertion. Nothing here is re-litigated without a **new
mechanism** clearing **every** gate.*

Numbering note: #1–#12 are the original post-1.5 §0b set; #14 is the shelved per-edge-versioning
spike; #15–#17 were added on the rebuilt 1.9 line; #18–#20 were diagnosed in the
benchmark-rebuild thread. **#13 is still unassigned** (no entry exists under that number).

---

## The laws that fell out (read this first)

Every entry below collapses into five rules. The rules are the payoff; the entries are the
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
| **7** | 1.5.1 split-flush (thin wrapper + `flushEffectsNonEmpty` worker) | update1to1 noise, KAIROS 13–15% slower | same two-loop / extra-branch mechanism as #5/#6 |
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

### Boundary cases (their own reasons)

| # | optimisation | result | mechanism |
|---|---|---|---|
| **15** | Computed self-dirty / upstream #179 closure | rejected (stands) | hot-path cost for a construct the suite deliberately excludes; **absorption is the contract**, kept honest by the absorption pin (`test/33-...`) |
| **17** | `onSettled` as a dynamic always-checked drain hook | **+27–31% on batched updates**, ~7ns/flush → forced the reset of the 1.9.x line to 1.8.0 | not instruction count — bytes pushing `flushEffects` past V8's inline budget; **the branch didn't even have to be taken.** *This is the entry that produced Law 1.* Implementation permanently rejected; the feature returned in 1.11.0 as `createRegistry({settled:true})` — same capability, selected once at build time, default byte-identical |
| **19** | Equals short-circuit (replace indirect `node.equals(a,b)` with direct `OBJECT_IS`) | 14/14 semantics, but **0% on target hardware** — rejected | looked like a 20% win on an old Xeon/Node 22 (upd1to1 = 5.12ms); on M4/Node 26 the same shape is 1.70ms = 4.25ns/set, where V8 already inlines the monomorphic call. *This is the entry that produced Law 5.* |
| — | Raw-pointer owner handles | crash + corruption, reproduced (stands) | the pool recycles autonomously; a raw-pointer handle adopts a recycled slot → cascade death + corpse-adoption crash. Only the gen-guarded design is safe |

---

## B. Regressions & bugs found and fixed *(not rejected optimisations — real defects caught)*

### #18 — the cleanup-return hot-body regression *(diagnosed in-thread)*

1.8.0's cleanup-return **inlined 15 lines into `executeEffect`** → **+21–23% on effect-dense
graphs**, invisible everywhere else including `1to1batch` (one effect). Hid for **five
versions** because 1.8.0's own proof exempted the one body that changed ("sha256 over the 15
*other* bodies") and bar 1 was structurally blind to it. Bisected: reverting only that hunk
restored 1.7.0 exactly. **Fixed** with variant C (a cold helper, +2 lines on the common
path), cascaded 1.8→1.12. Forced two gate changes (see §E).

### #20 — the parked-cursor disposal bug *(you found it; fixed identically by both of us)*

`disposeNode` frees a node's outgoing link out from under a **parked re-tracking cursor**
when an effect disposes its own not-yet-retracked dep mid-run → `severTail` walks the freed
link → `TypeError: Cannot set properties of null (setting 'headSub')`. Present
**1.4.0 → 1.12.0**. **Fixed** with a one-line cold-path repair (advance the cursor past the
doomed link); the repair also made the `-1` sentinel band-aid in `freeLink` dead code, which
was excised. 30/30 coverage, 50k-cycle stress zero-leak, churn 1.00×.

---

## C. Shelved — built and measured, parked (not disproven, not rejected)

### #14 — per-edge versioning *(the shelved 1.9 spike)*

Attaches a version to each **edge** rather than each node, so a computed can tell which
specific dependency moved without re-reading node versions. Built during the second
Reflex-study cycle, measured, and **shelved with its numbers** — it lives in
`engines/shelved`, not in the rejected set. Distinct from the rejected entries: those
failed a gate; this one was parked as a design direction that didn't earn its place *yet*,
with the data kept so it can be revived if a workload ever makes per-edge granularity pay.
(The 1.9.0 line instead shipped inner-write fixed point + onSettled + link-churn counters.)

---

## D. The closings — perf questions answered "no fix exists within this paradigm"

| question | verdict | evidence |
|---|---|---|
| **Creation cost** | CLOSED — structural, externally confirmed | the callable handle's `read` (+ `set`) closure is irreducible; Andrii ran his own 100k-creation breakdown and reached the same conclusion; reshaping the handle regressed the read/update path (same family as #1/#8/#10/#12). `signalBox`/`computedBox` (his suggestion) is the answer and earned the 4th-place creation rows. Keep the callable contract; treat the residual gap as structural |
| **Burst / flush** | CLOSED — locality, harness-confirmed | `burst-dag.mjs` + the op-5/6/7 counters show the burst is **single-pass, one recompute per node** — nothing to coalesce (killed #11). The ~2–4× gap is traversal locality at scale, and the two levers that could touch locality (#10, #12) both deopt propagation. No flush fix exists |
| **Iterative pull** | REJECTED (#9) — incompatible with lazy conditional deps | no cheap lazy-preserving iterative pull exists for opaque `computeFn`s; the RangeError ceiling only bites at ~5k–20k depth, which the real targets never reach |

**Net:** the only genuinely open *engine* question left is paradigm-level — does push-pull
dominate lazy-pull on updates, and does a hard zero-GC constraint change that? That is the
subject of the post-1.12.0 exploration roadmap, not a release.

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
