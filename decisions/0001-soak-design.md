# ADR 0001 -- The soak harness (bench/soak): design, gates, teeth

Status: ACCEPTED for the 1.6.0 line (S1a-S1d, bursts through 13, 2026-10-10 .. 2026-10-13). Dev-only tooling:
nothing under bench/soak/ is in package.json `files[]`, and Signal.js / Watch.js are not touched by it.
Open items are listed in "Consequences". The longer design record is audit/2026-10-07/verification/SPEC-B.md plus
SPEC-B-S1cd-batches.md (git-ignored); this ADR is the part that has to outlive them. File:line cites are HEAD 3f169dd.

## Context

The 1.6.0 audit (audit/2026-10-07/FINDINGS.md) found defects the torture suite did not: a batch revert after a mid-batch
read (F5), a throwing computed escaping the effect pre-walk (F6), lifecycle callbacks keyed by a recycled slot (F7),
and the suspended-frame cursor class (F8, F13, F15). The torture scenarios replay hand-written shapes; none of them
generates random programs, compares against an independent model, and watches memory across many cycles. Two engine
findings (F21, F22) were themselves FOUND by the new harness (bench/soak/calibration/f21-census.json).

## Decision

### 1. A soak: lanes, a naive model, oracles

A run is `header, cycle x (cycles x lanes), summary` (main.mjs:1-45). A cycle plays seeded op-script worlds of one lane
against the engine AND the reference model (model.mjs, deliberately naive: no caches, a pinned scan rejects counters)
until SOAK_OPS ops ran, then closes a boundary (boundary.mjs:1-22): drop the world refs, time-bounded forced-GC drain,
`tracker.size()` as the authority plus a WeakRef witness count, memory sampled after the drain.

S1 lanes: GRAPH, BATCH, ERROR, NEST. Hard oracles (exec.mjs:40 CHECK_NAMES, oracles.mjs:26): O1c computed values, O1e
effect observations, O2 glitch (inline), O4 dead effect, O5 node/link counts, O6 guarded escapes, O7a lifecycle
callbacks, OB (section 6). O3 is report-only. Oracles are pure and property-based; no oracle re-walks the kernel
(oracles that share the kernel's walk share its errors).

Defaults are calibrated, not guessed (section 8): DEFAULT_OPS 100000 per lane-cycle, 11 cycles (MIN_ACTIVE_CYCLES,
config.mjs:21, :31). Smoke = 3 x 20000 and can only be SMOKE, never PASS.

### 2. Cold-path policy

Every bench/soak module is COLD (each header says so): none is imported by Signal.js, none sits on a hot body. The
harness may allocate freely. Two rules keep it honest anyway: run totals live in a Float64Array (gates.mjs:70 Totals,
exact to 2^53; the startup self-check `totals` feeds 3 x 2^30 and demands 3221225472, gates.mjs:260) and SOAK_OPS is
capped at 0x3FFFFFFF (config.mjs:35) so a per-lane counter stays a Smi on pointer-compressed V8 (the F20 class).
Per-op 0 B/op stays owned by test/32-perf-gate and test/torture.mjs, not by the soak (GC_MAJOR_POLICY, config.mjs).

### 3. Frozen kernels (SOAK_KERNEL)

All S1 runs load the engine through one seam (kernel.mjs:1-20). By default the in-tree Signal.js; SOAK_KERNEL=<abs path
to a Signal.js with a sibling Watch.js> swaps a control. The path is realpath-resolved once so the hashed files are the
loaded files. controls.json pins two controls by sha256: `rev152` (the published 1.5.2, exact devDependency alias
`lite-signal-1.5.2`) and `headpatched` (the audit patch build, frozen in bench/soak/controls/headpatched, because
/audit/ is git-ignored). parity.json pins 23 files (Signal.js, Watch.js, 21 bench/soak files, config.mjs and SoakReport.mjs among them); `npm run soak:parity`
exits 1 on any drift, and a pin moves only through `parity.mjs --update` after review. The header records the kernel
hashes and `controls.name`; a stream from a scratch kernel is consistent but is never release evidence (section 9).

### 4. Verdicts and the INCONCLUSIVE evidence gates

Gates are data: `GATES = [{id, kind, check, pass, mustFail[], teeth}]` (gates.mjs:292); GATE_NAMES derives from it, so a
gate and its must-fail control land in one edit. Kinds: fail (oracle, heap, retention), evidence (coverage,
check-floor, taint-skip), startup (totals). Verdict ladder (gates.mjs:539-566, first match wins): config/expose-gc/
provenance error -> 2; any FAIL gate, BREACH or fatal -> FAIL 1 (a crash is never PASS or INCONCLUSIVE); any
INCONCLUSIVE cause -> 3; smoke -> SMOKE 0; a skip on a non-lite engine -> PARTIAL 0 (never the string PASS); else
PASS 0. lite must SKIP nothing (a roster bug exits 2).

Evidence gates exist so thin evidence cannot pass (the S1b review reported a NEST cov-off run skipping 53% of its effect checks
while green; not reproduced, section 8). They turn a run INCONCLUSIVE, never PASS and never FAIL:
- check-floor (gates.mjs:221): every applicable hard oracle PERFORMED >= CHECK_FLOOR checks; taint skips never count.
- taint-skip (:239): per skipping oracle, skipped / (performed + skipped) <= TAINT_SKIP_MAX; 0/0 is NaN and fails closed.
- coverage (:204): every required scenario >= SCEN_MIN hits (smoke: SCEN_MIN_SMOKE).
Causes (gates.mjs:371): interrupted, no-lane, post-cycles, scenario, check-floor, taint-skip, lane-status. Retention
FAILs on an UNMEASURED boundary at once (null is not zero); only a BAD warm-up boundary is ignored (gates.mjs:192).

### 5. Divergence registry

divergences.json is the one place a tolerated or explained behaviour lives; divergences.mjs validates it (fail closed:
classify throws while it is invalid) and classifies a failing world only if EVERY fail of the failing step is explained.
Matching is all-of on engine, lane, oracle, sig, op, step/world/prior scenario and an anchored detail-regex shape.
Entries are `fix` (an audit finding the engine fix will close), `contract` (a deliberate divergence from the naive
model) or `engine`. A tolerated failure is still a FAIL: it is tagged, never forgiven.

DIV-F21 (CycleError surfaces from a stale queue entry; divergences.json:145) and DIV-F22 (batch body error replaced by
the close-flush error; :156) are TEMPORARY: both `fixedIn: null, fixBy: A2`. When A2 lands the entry flips to fixedIn,
the GAP `P-INTERIM-ERROR-clean` becomes an active control, and a fixed entry explains a failure only for a pre-fix
control kernel (classify opts.includeFixed). F22 is tagged F6+F22 when DIV-F6 itself explains the replacing token, F22
when it was a predicted effect-body escape (the census corrected 17 -> 16 + 1, f21-census.json "correction").

### 6. Oracle OB (F5, QA finding 5): batch-early-run -- adopted

An effect that ALREADY ran must not re-run while a batch is open (exec.mjs:437-438). First runs are exempt (an effect
created inside a batch runs synchronously, p2). OB is PERFORMED once per outermost batch whose close-flush re-ran
>= 1 effect (exec.mjs:298-305), so a batch with nothing to defer is no evidence. It is checked inline, its counter is
capped at 0x3FFFFFFF, it needs `caps.batch` (bench/soak/adapters/contract.mjs:82), it is a hard oracle of BATCH (lanes/batch.mjs:117) and
of ERROR (lanes/error.mjs:106), where it meets the same CHECK_FLOOR. Census (calibration/ob-census.json): 0 OB failures in 6000 worlds on headpatched, the
tree and 1.5.2, so no divergence entry and no L-REV-152 change.
Rejected alternatives (PLAN-F5-F6.md):
- A one-shot startup probe in validateAdapter: it misses a flush at a nested close and a leak after a throw, is static
  by design, and would report an engine defect as a config error (exit 2).
- Promoting report-only O3 (runs per op vs the model minimum): engines legitimately differ on run counts (S5 adapters
  would FAIL falsely).
Open: OB also applies to `batch: 'deferred-drain'` engines, whose re-runs come after W.batch returns, so its floor can
never be met there (INCONCLUSIVE for every S5 drain adapter). Maintainer decision (a), accepted and still to build
(section 12): the OB fail check applies to every batch engine, the OB evidence floor only where a close-flush is
observable (native batch). GAPS T-OB-lying-adapter and T-OB-nested-close record the missing red cases.

### 7. Git-env convention (F6, QA finding 6) -- option (b)

provenance.gitInfo drops five repo-LOCATING variables from its child env at CALL time: GIT_SCRUB_ENV = GIT_DIR,
GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY (provenance.mjs:47-56). An inherited one used to
make a soak header stamp another tree's SHA and dirty state. GIT_CONFIG_* stay inherited: GIT_STATUS_ARGS
(provenance.mjs:38) already beats them, and test/41 proves it with hostile-config rows. Tests reach other trees only
through the code-only `gitInfo(root)` seam (provenance.mjs:63) and real throwaway repos; no config key was added.
Rejected: (a) a SOAK_GIT_ENV key (the key list in config.mjs KNOWN_KEYS is closed; a test-only key is an opt-in door
to describe another tree, i.e. fail-open, and a second env parser beside config.mjs); scrubbing GIT_CONFIG_* too (the
hostile-config rows would then check nothing).
KNOWN GAPs: provenance.mjs:44 documents config-level `core.worktree`; a self-ignoring untracked .gitignore and
.git/info/exclude are documented at :72-74. Reviewer candidates NOT in the code comment and not tested:
GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_REPLACE_REF_BASE / GIT_NO_REPLACE_OBJECTS, and core.fsmonitor via inherited
GIT_CONFIG_* (the claim that GIT_STATUS_ARGS pins every knob that can hide a file is unproven for fsmonitor).
gitInfo('/nonexistent') fails closed but prints "spawnSync git ENOENT"; a root inside an enclosing repo walks up.

### 8. Calibration constants (bench/soak/calibration/soak-calibration.json, guard test/41)

Cut: seed 0xC0FFEE, 11 x 100000 per lane plus smoke 3 x 20000, kernels headpatched and 1.5.2, one `--timed` run
(734 s under quiet-lock, M4 Pro, node v26.8.2, sequential children one kernel at a time; loadavg 2.61/2.44/2.35
before and 2.55/2.64/2.49 after the timed phase; throughput is REPORTED tier and decides no gate), the recut of
2026-10-13. `calibrate.mjs --write` dies unless main.mjs folds equal to the evidence, on the full cells and on the
large-world probe (PROBE: GRAPH, headpatched, 11 cycles x 33000 ops, calibrate.mjs:69; main.mjs rejects fewer than 11
cycles). test/41 fails when a constant, the generator version, a (p) PINNED file sha, a live smoke re-measure or the
live probe fold moves without a recut. PINNED (calibrate.mjs:56) covers the generator, executor, oracles, model,
scenarios, seeds, lanes, adapters, kinds.mjs and the torture helpers; it does NOT cover main.mjs or calibrate.mjs.
| constant | value | evidence (soak-calibration.json) |
|---|---|---|
| DEFAULT_OPS | 100000 (kept) | rarest required scenario at 11 x 100000: 2724 hits (GRAPH deep-pull); worst cell 22 (1.5.2 ERROR aggregate) |
| SCEN_MIN / SCEN_MIN_SMOKE | 8 / 1 (kept) | smoke minimum 156 (GRAPH deep-pull, both kernels); 1.5.2 smoke ERROR aggregate reads 2 (seed-dependent, masked because 1.5.2 always FAILs) |
| CHECK_FLOOR | 10000 (was 1000) | least performed clean cell NEST O7a 41184 (4.1x); at 11 x OPS_MIN NEST O7a 413, BATCH OB 8295 and ERROR OB 2152 -> INCONCLUSIVE |
| CHECK_FLOOR_SMOKE | 500 (was 250) | least clean smoke cell NEST O7a 2170 (4.3x); 8-seed smoke minimum 2174 |
| TAINT_SKIP_MAX | 0.35 (was 0.5) | clean max 0.2585 over 8 seeds; headpatched NEST cov-off O1c 0.4314-0.4434 over 17 seeds |
TAINT_SKIP_MAX was an ORCHESTRATOR decision on the reviewer's ruling: at 0.5 the gate did not trip its own design case,
and the S1b "0.53" figure was not reproducible. On 1.5.2 the same cov-off reads 0.2425-0.2612, which taint-skip cannot
separate; the coverage gate catches it (asserted in test/41). One scalar floor serves every oracle: at
11 x OPS_MIN only GRAPH clears it (O5 14791 on both kernels); ERROR OB (2152 / 1227), BATCH OB (8295 / 1789) and
NEST O7a (413 / 502) read INCONCLUSIVE (per-oracle floors stay deferred, decision (e)). The 1.5.2 ERROR smoke
`aggregate` count (2) is seed-dependent; no action.
Config comment: config.mjs:50-56 (the CHECK_FLOOR note).

### 9. SoakReport: integrity, release refusals, residuals

`node bench/soak/SoakReport.mjs <stream>` re-derives the verdict, perLane, INCONCLUSIVE lines, BREACH entries, totals,
cycle and world seeds and every failure's known tag with the SAME code that judged the run (gates.mjs, divergences,
main's BreachLog, seeds). Exact key sets per record type are checked (SoakReport.mjs:1-83, the header comment). Exit 0 = consistent
(`verdict <V> (consistent)`, any V); exit 1 = `INTEGRITY -- <class>` in fixed precedence (stream, header, cycles,
summary), or consistent but `NOT A RELEASE SOAK -- mustfail|smoke|non-lite|overridden-kernel|tree-parity|lane-subset|volume|provenance`; CRASH is a
report bug; exit 2 = CONFIG. Control kernels (controls.json pins) re-derive consistent, print `NOTE -- control kernel
<name>, not release evidence`; a pinned control skips the tree release policy (tree-parity, lane-subset, volume,
provenance) and exits 0 unless mustfail / smoke / non-lite refuses it first (SoakReport.mjs:510-514). Release
definition (maintainer decision (c), pure exported
`releaseRefusal()`, SoakReport.mjs:495): a tree run is release evidence only for the full roster at default volume
(SOAK_OPS >= DEFAULT_OPS and >= DEFAULT_CYCLES completed cycles per lane; interrupted cycles do not count) from a
clean committed tree (gitSha a commit sha, gitDirty false, gitError null). test/46 (177 tests) generates
every stream at test time from frozen kernels; its tamper classes: cycle-grid, failure-count, seq-gap,
fatal-after-summary, gates-block, verdict, scenario-counts, summary-missing, overridden-kernel, non-lite, known-tag,
malformed.
Residuals, stated plainly (SoakReport.mjs:67-80): kernel identity is SELF-REPORTED (a consistent five-field forgery of a
RELEASE-SIZE scratch stream, plus clean git fields, as a tree run exits 0; signing is out of scope until S4, GAP R-kernel-identity); a forged null-known
BREACH on a lane with a capped cycle is admitted (FAIL_CAP keeps only 16 failures per cycle); gates-block, registry and
tree-parity cannot tell a stale stream from a forged one and refuse both; extra config keys, engine.version,
controls.error, parity.error, gateHits names and header sub-objects are not judged. The record-key tables are COPIES
(main/provenance export no shapes); the honest-stream tests are the drift guard.
Release eligibility reads no verdict: a consistent release-size tree stream exits 0 whatever V it re-derives (FAIL too).

### 10. The teeth registry (a gate that cannot fail is not a gate)

bench/soak/teeth.mjs holds, by import and never by copy:
- `universe()` (43 ids at HEAD): lane:, gate:, oracle:, sig:<oracle>:<sig>, cause: ids plus `config` and `report`.
  Excluded on purpose (teeth.mjs:24-31): REPORT_ONLY_GATES, REASONS, WRAP_CHECKS, MUSTFAIL_MODES.
- `CHECKS` (31 ids): id -> controls that turn it red. `T-cfg-*` must resolve every config control (>= 16);
  `report` maps to test/46's TEST_ANCHORS.
- `GAPS` (26 at HEAD): controls the SPEC asks for that cannot exist yet, each with why (file:line), until, and `covers`
  (the universe ids it stands in for). GAPS may only shrink.
- `UNREACHABLE` (4): cause:lane-status, replay-ops-guard, report-crash, report-registry-config, each with a proof and
  an anchor that must occur EXACTLY once. The last two are "unreachable from argv or a stream; reachable only from a
  corrupted checkout (untested)".
- `audit({controls, ceiling, max})` REQUIRES all three (never defaulted); returns the problem list.
test/45 (17 tests, no child process) holds the shrink-only literals: the 26-name GAPS ceiling and max 26, the 11
GAP-covered universe ids (exact set equality), CHECKS_MIN 31 (an exact floor), EVIDENCE_CAUSE {coverage: 'scenario'}
(interim: the coverage cause is still built inside LaneGates), and a pairing check: EVERY mapped control must expect
the text its id would print (oracle=/sig= via oracleFamily, lane=, gate=, the INCONCLUSIVE head, a CONFIG line, test
anchors). It also checks the ^L- / ^(?!L-) partition, validSpec for all controls, staleAnchors and a 1-byte anchor
mutant ("2 matches" for the severTail anchor), and must-fail copies of every audit problem class.
`_mustfail.mjs` (30 controls: 14 non-config + 16 T-cfg) runs each through the REAL main.mjs on a scratch kernel
directory: exactly-once anchors, exact exit, every spec on ONE BREACH/INCONCLUSIVE head, no CRASH, END sentinel last,
and SoakReport re-derivation `(consistent)`. `npm run soak:teeth` = short (^(?!L-)); `npm run soak:teeth:long` = ^L-;
MUSTFAIL_LIST=1 builds all and runs none; MUSTFAIL_ONLY=<regex>; MUSTFAIL_HEADS=1 prints matched heads.

### 11. Deviations from SPEC-B section 9 (binding; also recorded as S1cd amendment 15)

- L-REV-152 has 9 specs: the 4 SPEC ones plus O1 computed-mismatch, O1 effect-stale, O2 glitch (BATCH), O4 effect-dead
  and O6 expected-escape-missing (ERROR); each is a unique tooth (_mustfail.mjs:265-291).
- L-P-INTERIM = GRAPH,BATCH at 11 x DEFAULT_OPS, exit 0, 22 clean boundaries; L-P-INTERIM-ERROR is kind `explained`
  (exit 1, every BREACH known in {DIV-F21, DIV-F22}). Amendment 13.
- T-cov-BATCH runs --smoke like T-cov-GRAPH (_mustfail.mjs:346); T-cov-ERROR is `explained` at exit 1
  because a headpatched ERROR run always shows F21/F22 BREACHes, and FAIL outranks INCONCLUSIVE.
- T-cfg is 16 rows (the S5 polyfill row is deferred); the provenance row uses a zero-commit repo copy under
  bench/soak/out, not `GIT_DIR=/nonexistent` (gitInfo scrubs GIT_DIR).
- L-I1 / L-I2 arm at the 2nd registry, not "after the first heartbeat" (the kernel raises its own signal).
- L-T-retain runs 11 x OPS_MIN (_mustfail.mjs:308-318). At 11 x DEFAULT_OPS the retained registries (~500 MB per GRAPH
  cycle) reached the V8 heap limit at cycle 6-7 (residentMB 3534.27, SIGABRT, no END). At 11 x OPS_MIN: exit 1,
  `gate=retention lane=GRAPH`, badBoundaries 10; the heap gate trips too, accepted.
- T-floor-BATCH (new): 11 x OPS_MIN performs BATCH OB 8295 < 10000 -> `INCONCLUSIVE checks lane=BATCH oracle=OB`.
- The meta-test is test/45 (SPEC text said test/35); SoakReport's tests are test/46.

### 12. Maintainer decisions of 2026-10-13 (dated amendment)

- (a) OB: a fail check for every batch engine; the OB evidence floor only where a close-flush is observable (native
  batch). Accepted, not built (the S5 adapter pass narrows ORACLE_CAPS for BATCH and ERROR alike).
- (b) parity.json also pins config.mjs and SoakReport.mjs (built: 23 pins).
- (c) Release policy: the full roster at default volume from a clean committed tree (section 9; built).
- (d) test/41 stops pinning main.mjs and calibrate.mjs; a live smoke fold and a live large-world probe guard main.mjs
  (section 8; built). The probe cost is accepted as built (measured 2026-10-13, M4 Pro: the probe run standalone 25.7
  s under quiet-lock, 1-min load 1.76 before / 1.64 after; inside test/41 it runs concurrently with the live smoke
  pair, ~17.5-19.5 s; test/41 as a whole 13 s before the probe, 31-34 s after).
- (e) ERROR gains OB as a hard oracle (built); a per-oracle CHECK_FLOOR stays deferred. Separately, the 1.5.2 ERROR smoke
  `aggregate` count (SCEN_MIN_SMOKE coverage, not an oracle floor) is seed-dependent; recorded, no action.

## Consequences

- The BATCH cov-off switch is closed: lanes/batch.mjs:42 compares DECODED values with Object.is, as the detector does
  (scenarios.mjs:236); soak-calibration.json records 0 cov-off hits on every covOff cell and every covOffSweep cell
  (5 cov-off scenarios x 17 seeds x 2 kernels = 170 cells).
- Maintenance trap resolved (decision (d)): test/41 no longer pins main.mjs or calibrate.mjs; a live smoke fold and a
  live large-world probe fold guard main.mjs instead. Residual (accepted): a COVOFF_SEEDS content change plus a
  matching JSON goes unflagged (it needs a recut and shows in the JSON diff); a main.mjs drift outside the smoke and
  probe shapes is caught only at the next recut. Cost (accepted): see section 12 for the measured probe and test/41 times.
- GAPS shrink as engine fixes land (A1 .. A7) and as S2/S3/S5 add lanes and adapters; each landing deletes its GAP and
  edits test/45's literals in the same change.
- Candidate follow-ups: export a gate -> cause map from gates.mjs (drops test/45 EVIDENCE_CAUSE; needs a parity re-pin);
  `cause:post-cycles` and `cause:lane-status` both render to a `lane ` head, so pin past the argument when
  T-post-cycles lands; UNREACHABLE has no literal in test/45 (a new id declared unreachable needs review, not a test edit).
- Full-size release soaks (three runs on a quiet host) are still PENDING; no number in this ADR is a release-soak result.

## Alternatives rejected (summary)

A validateAdapter startup probe and promoting O3 (section 6); SOAK_GIT_ENV and scrubbing GIT_CONFIG_* (section 7);
a fixed timing threshold inside the soak (timing is the STATISTICAL tier and the soak decides no timing gate);
copying GATES or the GAPS ceiling into the meta-test (the ceiling literal lives in test/45 so it cannot drift with GAPS).
