// test/torture.mjs -- node --expose-gc test/torture.mjs
//
// Standing zero-GC + retention judge for @zakkster/lite-signal, wired to the
// REAL engine (../Signal.js, not node_modules) so it proves THIS working tree.
// Generated from the torture-harness skill; adapted to lite-signal's actual
// hot entry points (there is no per-op user object -- the engine pools its
// nodes, so the steady-state hot path is signal.set -> propagate -> effect).
//
// Gates (fix the code, never widen a budget):
//   * 1e5 set->propagate ops              -> maxMajor 0; 0 B/op retention SLOPE
//   * 1e5 untrack-in-effect ops           -> maxMajor 0; 0 B/op retention SLOPE  (LEDGER #30 path)
//     Slope (b72, the test/64 flake): min-over-batches read the instrument's
//     per-batch constant k as per-op bytes (b64 + b71 under load: untrack
//     0.0008 B/op = 16 B in the minimum 2e4-call batch, exit 1; `node --expose-gc
//     --no-concurrent-osr test/torture.mjs` reproduced it on the b72 before-copy
//     6/6). Both lanes use the QS estimator (phase 6): ONE measureAllocs call per
//     attempt, pseudo-batches of 2e4 calls alternating 1 step per call (even) and
//     5 (odd), so k is shared by both parities and cancels. Verdict: judgeSlope
//     (./torture-judge.mjs, b78 rule R2'): Dlo = min even batch, Dhi = 2nd-smallest
//     odd batch. An attempt passes iff it settled, ran exactly 1080000 steps, every
//     step fired the effect, it ended in the reset state, every batch reading is
//     null or a finite number >= 0, it kept >= 4 batches per parity and Dhi <= Dlo;
//     up to 3 attempts per lane, stop at the first pass.
//     Catches a retainer down to 1 per 1e5 steps (the old floor: 1 per 2e4).
//     No single bad batch passes a retainer: one odd dip is skipped by the
//     2nd-smallest (b72-b77 read Dhi = min odd, so ONE odd batch dipped to the even
//     floor passed a retainer -- b77, vector V1), one even spike is not the min, and
//     a one-time upward step in k (b73: +6240 B on every batch after ~7) rides every
//     batch (cancels) or misses batch 0, so it can only lift Dhi (red, retried).
//     They keep Dhi <= Dlo: a min of paired differences (the QS control, b74) would
//     pass a retainer on ONE pair whose even batch spiked. A live pass needs two
//     clean odd batches, so a loaded host turns more attempts red (K=3 retries).
//     Cannot see: (1) a retainer slower than ~1 per 1e5 steps; (2) retention once
//     per batch or GC cycle, independent of step count (printed as k from a
//     passing attempt only -- a failed lane prints fail(Dlo=<n>B) -- gated
//     nowhere); (3) allocations that die young -- both lanes read the heap after
//     a forced GC; the pinned child covers set only through the NEST / QS graphs
//     and untrack not at all, so a transient per-op box passes (the old floor was
//     equally blind to it); (4) two odd dips in one attempt, each dipping by >= the
//     retainer's per-batch bytes (vector B1); (5) a spike on every measured even
//     batch masks a retainer up to its size. A k that grows with batch duration
//     reads as per-step growth (fails closed). Must-fail: test/64 lanes aset / aun
//     (one retained object per 1000 calls in read.set / untrack -> alloc > 0, FAIL).
//   * 1e4 create/dispose cycles           -> activeNodes/activeLinks back to baseline
//   * effect self-disposes inside untrack -> gen-safe restore, no crash, baseline
//   * NEST (SPEC-A A1.11): 1e5 nested recomputes effect -> computed -> computed
//     (three frames deep, the A1 cursor-stack push/pop on every frame)
//                                         -> <= 0.05 B/op steady state, maxMajor 0
//     The B/op lane runs in a CHILD with pinned semi-space (fail closed if the
//     flags are missing) and reads V8 new-space deltas, so it sees a transient
//     box; a one-box-per-op control MUST read >= 8 B/op or the lane is blind.
//   * WATCH: watch() fire (Watch.js; default registry), measured in the SAME
//     pinned child as NEST -> <= 0.05 B/op steady state; every step must fire
//     the callback (fires === steps) or the lane is blind. (An in-process
//     measureAllocs lane cannot see a per-fire allocation that dies young.)
//   * NEST retention: 1e4 cycles of the P10 + F8 shapes (nested-frame disposal,
//     onDisconnect disposing the next dep) -> engine-owned WeakRefs all collected
//     (6 per sampled cycle x NEST_SAMPLED (161) = 966; a live/dead WeakRef
//     control proves gc + WeakRef clearing work in this process, not that the
//     census samples the objects a leak would keep), free-list census (every
//     slot the counters call free is drained back out of R's pools, one more
//     node must throw CapacityError), post-drain stats() back to baseline. The
//     resident delta is an advisory print
//     (res=...KB(adv)), gated nowhere: heapUsed noise crossed 64 KB with every
//     exact term green (b60).
//   * PIN (A1.8): 1e4 effects that dispose themselves while RUNNING (pinned slots),
//     at top level and inside a flush -> nodePoolPopulation flat after warm-up,
//     maxMajor 0; 1e3 dead-owner cycles (a child created under a parent disposed
//     mid-run, then the parent's slot recycled) -> the child is never adopted by
//     the stranger in that slot
//   * QS (F21, LEDGER #35): 1e5 s.set with one sync-scheduled effect (the
//     scheduler calls run() immediately) + one plain effect -> maxMajor 0 and a
//     0 B/op retention SLOPE; the same step in the pinned child -> <= 0.05 B/op
//     steady state; every step must run both bodies and the scheduler (else the
//     lane is blind). Both halves gate, but only the child lane caught the
//     QS-teeth control (one run, burst 38: child 135.972 B/op FAIL; in-process
//     still 0 B/op with gc minor=2).
//     Slope (PLAN-0c addendum 1): ONE measureAllocs call per attempt over a
//     wrapper that alternates pseudo-batches of 2e4 calls at 1 qsStep per call
//     (even batches) and 5 (odd batches), so the instrument's per-batch constant
//     k (CI read 16-72 B in every batch, a 0.0008-0.0036 B/op min-over-batches
//     false red; it also differs BETWEEN calls) is shared by both parities and
//     cancels; a per-call retainer grows with the 8e4 extra steps. Verdict: the
//     same judgeSlope as the set / untrack lanes (b78: Dlo = min even, Dhi =
//     2nd-smallest odd). An attempt passes iff it settled, ran exactly 1080000
//     steps, ended in the reset state, every batch reading is null or a finite
//     number >= 0, it kept >= 4 batches per parity and Dhi <= Dlo; up to 3
//     attempts, stop at the first pass. Control: the same
//     call shape with one object retained per 1000 qsSteps, read as the MIN OF
//     PAIRED DIFFERENCES (b74): over the 8 pairs (even batch b - 1, odd batch b)
//     min(odd - even) MUST be >= 1280 B with >= 4 measured pairs, or the slope
//     is blind. (Dhi - Dlo, two independent mins, let a one-time step in k pass
//     a blind control: b73 saw +6240 B on every batch after ~batch 7 of a call
//     (b74: also the first QS attempt, from odd batch 9); begun between batch 0
//     and 1 it reads ~6240 B. A step lands inside at
//     most one pair, so it cannot lift the min.) Up to 3 attempts, each from the
//     reset state with an empty ring, stop at the first pass, exhausted = red
//     (b73: a single call went red under 8x parallel load, ctl=-3664B). A k that
//     grows with batch duration lifts every pair: it fails OPEN in the control
//     (a blind control passes once it reaches 1280 B per pair). Cannot see: (1) a
//     retainer slower than ~1 per 1e5 steps; (2) retention once per batch or GC
//     cycle, independent of step count (reported as k from a passing attempt
//     only, gated nowhere); (3) allocations that die young
//     -- the child lane owns those at <= 0.05 B/op, so a transient 1-in-1000
//     16 B box (0.016 B/op) passes both lanes; (4) two odd dips in one attempt,
//     each dipping by >= the retainer's per-batch bytes; (5) a spike on every
//     measured even batch masks a retainer up to its size. A k that grows with
//     batch duration reads as per-step growth (fails closed). No single bad
//     batch passes a retainer (see the set / untrack lanes above).
//   * F21 retention: 1e3 x {createRegistry({maxFlushPasses: 8}), the P3 shape
//     (creation-time CycleError caught, then a new effect in a recycled slot),
//     destroy()} -> lite-leak tracker.size() === 0 (a cycle's marker is released
//     only when the shape behaved and destroy() returned)
//   * MREG (A5a, PLAN-A5a-lifecycle TASK 2): observeObservers registrations on
//     one node are independent. Fire half: one source with three hoisted
//     registrations, a toggle effect reads it on odd steps only, so every step
//     is one connect or one disconnect fire walking all three -> in-process
//     maxMajor 0 and minor 0 (gc() first) over 1e5 steps -- best effort only:
//     minor 0 is blind once earlier phases have grown new space -- and, the
//     real gate, the pinned NEST child gated on the WHOLE measured run: every
//     window 1..8 <= 0.05 B/op net (max, not min, so a transient that dirties
//     only some windows fails) and no scavenge in any window (null === 0);
//     every step must fire every registration (conn + disc ===
//     steps per reg) or the lane is blind. Retention half: 1e4 cycles, each
//     with fresh callbacks: A offs itself in its onConnect, B registers a new D
//     from inside its first onConnect (D must skip that fire), C disposes a
//     scratch signal from inside its first onDisconnect; observe / unobserve
//     twice, FIFO order checked on all four fires, then the source is disposed
//     with the B / C / D off handles KEPT (never called, held in a module array
//     through the census) -> the F-a drop must clear their callbacks. Oracles:
//     WeakRefs to the six callbacks of every 64th cycle + the last 4
//     (MREG_SAMPLED = 161) all collected after forced GC (the NEST census
//     control proves gc + WeakRef clearing work here); a lite-leak marker per
//     cycle released only when the shape behaved (size() === 0); stats() back
//     to baseline. The registration cycle itself allocates by API design (an
//     entry, a reg and an off closure per observeObservers call), so only the
//     fire half carries a B/op gate. Must-fail: the M9 mutant (dropLifecycleHooks
//     without the F-a clearing) keeps the kept offs' callbacks alive (cb > 0).
//
// The untrack path is the LEDGER #30 keystone: untrack() nulls currentObserver
// for its window and restores it gen-safely (only if the observer survived the
// window). This torture drives 1e5 of those windows with maxMajor 0 and a 0 B/op
// retention slope (transients unmeasured; see the header).
import { GcProfiler, checkNoGc, measureAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getHeapSpaceStatistics } from 'node:v8';
// Cold slope verdict (b78): a separate module because this file runs every phase on import.
import { judgeSlope } from './torture-judge.mjs';

// >>> WIRE: the engine under test -- the working-tree source, NOT node_modules.
import { createRegistry, signal as defaultSignal, watch } from '../Signal.js';

const R = createRegistry();
const { signal, computed, effect, untrack, dispose, stats, observeObservers, getOwner } = R;

// ---- NEST steady-state lane (child mode) ----------------------------------
// B/op = V8 new-space used-size delta over K ops with no scavenge in the window,
// minus an empty-step baseline; steady state = MIN over windows 1..n-1 (window 0
// may run unoptimized code: printed, never floored on). Prints one JSON line.
const NEST_K = 20000;
const NEST_WINDOWS = 9;
function newSpaceUsed() {
  const sp = getHeapSpaceStatistics();
  for (let i = 0; i < sp.length; i++) if (sp[i].space_name === 'new_space') return sp[i].space_used_size;
  return -1;
}
function laneBytesPerOp(step) {
  const per = [];
  for (let w = 0; w < NEST_WINDOWS; w++) {
    const before = newSpaceUsed();
    for (let i = 0; i < NEST_K; i++) step(i);
    const after = newSpaceUsed();
    per.push(after >= before ? (after - before) / NEST_K : null);   // null: a scavenge hit the window
  }
  return per;
}
function steadyMin(per, base) {
  let m = null;
  for (let w = 1; w < per.length; w++) {
    if (per[w] === null || base[w] === null) continue;
    const v = per[w] - base[w];
    if (m === null || v < m) m = v;
  }
  return m === null ? null : (m < 0 ? 0 : m);
}
// Whole-run view (b116, MREG lane only): the MAX net B/op over windows 1..n-1 (negative clamped
// to 0; a window with a null side is skipped here and counted by windowNulls), and the count of
// windows 1..n-1 where the lane or the baseline was hit by a scavenge (fail closed: unmeasured).
function windowMax(per, base) {
  let m = null;
  for (let w = 1; w < per.length; w++) {
    if (per[w] === null || base[w] === null) continue;
    const v = per[w] - base[w];
    if (m === null || v > m) m = v;
  }
  return m === null ? null : (m < 0 ? 0 : m);
}
function windowNulls(per, base) {
  let n = 0;
  for (let w = 1; w < per.length; w++) if (per[w] === null || base[w] === null) n++;
  return n;
}
if (process.argv.includes('--nest-lane')) {
  const pinned = process.execArgv.includes('--min-semi-space-size=4') &&
    process.execArgv.includes('--max-semi-space-size=4');
  const sN = signal(0);
  const c1 = computed(() => sN() + 1);
  const c2 = computed(() => { sN(); return c1() * 2; });   // reads sN first: its pre-walk stops there
  let sinkN = 0;
  const stopN = effect(() => { sN(); sinkN = (sinkN + c2()) & 0x3FFFFFFF; });   // frames: effect -> c2 -> c1
  const nestStep = (i) => { sN.set(i & 0xFFFF); };
  const emptyStep = (i) => { sinkN = (sinkN + (i & 1)) & 0x3FFFFFFF; };
  // WATCH lane: watch() binds to the default registry. Every step changes the value
  // (consecutive i differ; each window ends at (NEST_K - 1) & 0xFFFF != 0), so every
  // step runs the full fire. Step and callback are hoisted: no closure per op.
  // The callback stores its 3rd argument (the stop handle) in a hoisted slot: a body
  // that ignored it would be inlined and let escape analysis delete anything Watch.js
  // allocates for the call (e.g. a fresh `() => stop()` per fire would read 0).
  const sW = defaultSignal(-1);
  const KEEPW = [null];
  let sinkW = 0, firesW = 0, stepsW = 0;
  const watchBody = (next, prev, st) => { KEEPW[0] = st; sinkW = (sinkW + next - prev) & 0x3FFFFFFF; firesW++; };
  const stopW = watch(sW, watchBody);
  const watchStep = (i) => { stepsW++; sW.set(i & 0xFFFF); };
  // QS lane (F21): one sync-scheduled effect + one plain effect on the same signal.
  // The counter is a Smi below 2^30: a step never repeats a value (equal set = no-op).
  const sQ = signal(0);
  let qN = 0, qRuns = 0, qPlain = 0, qSched = 0;
  const qScheduler = (run) => { qSched++; run(); };
  const stopQ1 = effect(() => { sQ(); qRuns++; }, { scheduler: qScheduler });
  const stopQ2 = effect(() => { sQ(); qPlain++; });
  const qsStep = (i) => { qN = (qN + 1) & 0x3FFFFFFF; sQ.set(qN); };
  // MREG lane (A5a): three independent registrations on mS; the effect reads mS on odd mT
  // only, so every step is one connect or one disconnect fire over all three. Hooks are
  // hoisted; per-reg counters live in Int32Array slots [connA, connB, connC, discA, discB, discC].
  const mS = signal(0), mT = signal(0);
  const MC = new Int32Array(6);
  let mN = 0, mSteps = 0;
  const mOffA = observeObservers(mS, { onConnect: () => { MC[0]++; }, onDisconnect: () => { MC[3]++; } });
  const mOffB = observeObservers(mS, { onConnect: () => { MC[1]++; }, onDisconnect: () => { MC[4]++; } });
  const mOffC = observeObservers(mS, { onConnect: () => { MC[2]++; }, onDisconnect: () => { MC[5]++; } });
  const stopM = effect(() => { if ((mT() & 1) === 1) mS(); });
  const mregStep = (i) => { mSteps++; mN = (mN + 1) & 0x3FFFFFFF; mT.set(mN); };
  const BOX = ['tagged'];   // PACKED_ELEMENTS: a double stored here is a fresh HeapNumber
  const boxStep = (i) => { BOX[0] = i + 0.5; };   // control: one 16 B HeapNumber per op
  for (let i = 0; i < 50000; i++) { nestStep(i); emptyStep(i); boxStep(i); watchStep(i); qsStep(i); mregStep(i); }   // warm up
  const base = laneBytesPerOp(emptyStep);
  const nest = laneBytesPerOp(nestStep);
  const wat = laneBytesPerOp(watchStep);
  const ctl = laneBytesPerOp(boxStep);
  const qs = laneBytesPerOp(qsStep);
  const mr = laneBytesPerOp(mregStep);
  stopN();
  stopW();
  stopQ1();
  stopQ2();
  stopM();
  mOffA(); mOffB(); mOffC();
  console.log(JSON.stringify({ pinned, nest: steadyMin(nest, base), watch: steadyMin(wat, base),
    control: steadyMin(ctl, base), window0: nest[0], watchWindow0: wat[0],
    watchFires: firesW, watchSteps: stepsW, sink: sinkN + sinkW,
    qs: steadyMin(qs, base), qsWindow0: qs[0], qsSteps: qN, qsRuns: qRuns, qsPlain: qPlain, qsSched: qSched,
    mreg: steadyMin(mr, base), mregMax: windowMax(mr, base), mregNull: windowNulls(mr, base), mregPer: mr,
    mregBase: base, mregWindow0: mr[0], mregSteps: mSteps, mregCounts: Array.from(MC) }));
  process.exit(0);
}

const CYCLES = 10000;   // 1e4 create/dispose cycles
const HOT = 100000;     // 1e5 hot ops per path

const leaks = [];
const warns = [];
const tracker = createLeakTracker({
  name: 'torture',
  onLeak: (r) => leaks.push(String(r.tag)),
  onWarning: (w) => warns.push(w.kind + ':' + w.reason),
});

// ---- phase 1: retention torture ------------------------------------------
// Create a signal + computed + effect triad each cycle, then dispose all three.
// Each cycle tracks a per-cycle marker standing in for "user state bound to
// this reactive scope" and UNTRACKS it on teardown -- modelling deterministic
// release on dispose. size() must balance to 0 (every issued handle released),
// and a quiescent registry must return activeNodes/activeLinks to baseline --
// that stats() equality is the real retention oracle for a pooled engine: a
// leaked node or link would strand the count above baseline. Held-value
// contract: tag is a number, cleanup is null -- neither closes over the target.
const base = stats();
for (let i = 0; i < CYCLES; i++) {
  const marker = { i };
  const handle = tracker.track(marker, null, i, { audit: true });

  const s = signal(i);
  const c = computed(() => s() * 2);
  const stop = effect(() => { void c(); });

  stop();
  dispose(c);
  dispose(s);
  tracker.untrack(handle);
}

globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));

const live = tracker.size();
const findings = tracker.audit();
const afterCycles = stats();
const nodesBaseline = afterCycles.activeNodes === base.activeNodes;
const linksBaseline = afterCycles.activeLinks === base.activeLinks;

// ---- phase 2: allocation + GC torture ------------------------------------
// Steady-state graphs allocated OUTSIDE the hot loops; only .set() steps inside.

// Path A: set -> propagate -> effect.
const sa = signal(0);
const ca = computed(() => sa() + 1);
let sinkA = 0, aRuns = 0;
const stopA = effect(() => { sinkA += ca(); aRuns++; });
const setStep = (i) => { sa.set(i); };

// Path B: untrack-in-effect (the LEDGER #30 hot window). The untracked body is
// hoisted so the per-op cost is untrack()'s null/restore window ONLY -- a fresh
// arrow per run would allocate and mask the thing under test.
const sb = signal(0);
let sinkB = 0;
const untrackedBody = () => { sinkB++; };
const stopB = effect(() => { sb(); untrack(untrackedBody); });
const untrackStep = (i) => { sb.set(i); };

// (watch() fire is measured in the pinned child lane, phase 4b.)

// 2a: GC budget over 1e5 + 1e5 ops.
const gc = new GcProfiler().start();
for (let i = 0; i < HOT; i++) {
  setStep(i);
  if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
}
for (let i = 0; i < HOT; i++) {
  untrackStep(i);
  if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
}
await new Promise((r) => setTimeout(r, 50));
const s = gc.summary();
const gcReport = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
gc.stop();

// 2b: per-op retention SLOPE (requires --expose-gc; the phase-6 QS estimator, see the header).
// min-over-batches alone reads the instrument's per-batch constant k as k / iterations B/op
// (b64, b71: untrack 0.0008 B/op = 16 B per batch, a false red). ONE measureAllocs call per
// attempt alternates pseudo-batches of AL_ITER calls at 1 step per call (even) and 5 (odd):
// k is shared by both parities and cancels; a per-step retainer grows with the 8e4 extra steps.
// Steps drive Smi counters below 2^30 (a value never repeats: an equal set is a no-op). The
// wrappers are hot (Smi state only); everything else is cold and may allocate.
const AL_ITER = 20000, AL_BATCHES = 16, AL_WARM = 40000, AL_K = 3;
// Warm-up = pseudo-batches 0 (even) and 1 (odd); measured batch b has parity b & 1.
const AL_STEPS = ((AL_WARM + AL_ITER * AL_BATCHES) / AL_ITER / 2) * AL_ITER * 6;   // 1080000
let aN = 0, apLeft = 0, apOdd = 1;
const setStepN = () => { aN = (aN + 1) & 0x3FFFFFFF; sa.set(aN); };
const setPairStep = () => {
  if (apLeft === 0) { apLeft = AL_ITER; apOdd ^= 1; }
  apLeft--;
  setStepN();
  if (apOdd === 1) { setStepN(); setStepN(); setStepN(); setStepN(); }
};
let bN = 0, bpLeft = 0, bpOdd = 1;
const untrackStepN = () => { bN = (bN + 1) & 0x3FFFFFFF; sb.set(bN); };
const untrackPairStep = () => {
  if (bpLeft === 0) { bpLeft = AL_ITER; bpOdd ^= 1; }
  bpLeft--;
  untrackStepN();
  if (bpOdd === 1) { untrackStepN(); untrackStepN(); untrackStepN(); untrackStepN(); }
};
// null is not zero: an attempt that did not settle, run exactly AL_STEPS steps, fire the effect
// on every step, end in the reset state, read only null / finite >= 0 batches and keep >= 4 batches
// per parity is unmeasured, never a pass. Verdict: judgeSlope (Dlo = min even, Dhi = 2nd-smallest odd).
function alRead(r, steps, fires, endOk) {
  const ok = r.settled && endOk && steps === AL_STEPS && fires === AL_STEPS;
  return { r, steps, fires, endOk, ...judgeSlope(r.batchBytes, ok) };
}
const alOpts = { iterations: AL_ITER, batches: AL_BATCHES, warmup: AL_WARM };
const setAttempts = [];
let setPass = null;
for (let a = 0; a < AL_K && setPass === null; a++) {
  apLeft = 0; apOdd = 1;
  const n0 = aN, f0 = aRuns;
  const r = measureAllocs(setPairStep, alOpts);
  const at = alRead(r, (aN - n0) & 0x3FFFFFFF, aRuns - f0, apLeft === 0 && apOdd === 1);
  setAttempts.push(at);
  if (at.pass) setPass = at;
}
const unAttempts = [];
let unPass = null;
for (let a = 0; a < AL_K && unPass === null; a++) {
  bpLeft = 0; bpOdd = 1;
  const n0 = bN, f0 = sinkB;   // sinkB counts untrackedBody runs (one per fired effect)
  const r = measureAllocs(untrackPairStep, alOpts);
  const at = alRead(r, (bN - n0) & 0x3FFFFFFF, sinkB - f0, bpLeft === 0 && bpOdd === 1);
  unAttempts.push(at);
  if (at.pass) unPass = at;
}
// Label: per lane the passing attempt, else the last one; a pass has Dhi <= Dlo, so it reads 0.
const setShown = setPass !== null ? setPass : setAttempts[setAttempts.length - 1];
const unShown = unPass !== null ? unPass : unAttempts[unAttempts.length - 1];
const allocMeasured = setShown.measured && unShown.measured;
const bpcLabel = allocMeasured
  ? String(Math.max(0, (setShown.hi - setShown.lo) / (AL_ITER * 4), (unShown.hi - unShown.lo) / (AL_ITER * 4)))
  : 'unmeasured';
// k is a per-batch constant only on a pass; a failed lane prints its Dlo under fail(), never as k.
// A unit only follows a number: 16B/batch, fail(Dlo=640B), fail(unmeasured).
const kLabel = (pass, shown) => pass !== null ? pass.lo + 'B/batch' :
  'fail(' + (Number.isFinite(shown.lo) ? 'Dlo=' + shown.lo + 'B' : 'unmeasured') + ')';
const alKLabel = kLabel(setPass, setShown) + ',' + kLabel(unPass, unShown);
const allocOk = setPass !== null && unPass !== null;

stopA();
stopB();

// ---- phase 3: effect self-disposes inside untrack ------------------------
// The exact LEDGER #30 restore hazard: an observer nulls itself (dispose bumps
// gen) INSIDE an untrack window. The gen-safe restore must NOT re-seat a dead,
// recycled slot as currentObserver. Prove no crash, the effect stops firing,
// and the registry returns to baseline.
const selfBase = stats();
let ran = 0;
let selfDispose;
const trigger = signal(0);
selfDispose = effect(() => {
  trigger();
  ran++;
  if (ran === 2) untrack(() => { selfDispose(); });
});
trigger.set(1);   // re-run #2 -> self-dispose inside untrack
trigger.set(2);   // disposed: must NOT re-run
dispose(trigger);
const selfAfter = stats();
const selfOk = ran === 2 &&
  selfAfter.activeNodes === selfBase.activeNodes &&
  selfAfter.activeLinks === selfBase.activeLinks;

// ---- phase 4: NEST (SPEC-A A1.11) -----------------------------------------
// 4a: GC budget over 1e5 nested recomputes (effect -> computed -> computed).
const nS = signal(0);
const nC1 = computed(() => nS() + 1);
const nC2 = computed(() => { nS(); return nC1() * 2; });
let nSink = 0;
const nStop = effect(() => { nS(); nSink = (nSink + nC2()) & 0x3FFFFFFF; });
const nestStep = (i) => { nS.set(i & 0xFFFF); };
const ngc = new GcProfiler().start();
for (let i = 0; i < HOT; i++) {
  nestStep(i);
  if ((i & 8191) === 0) ngc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
}
await new Promise((r) => setTimeout(r, 50));
const ns = ngc.summary();
const nestGcReport = checkNoGc(ns, { maxMajor: 0, maxPauseMs: 4 });
ngc.stop();
nStop();
dispose(nC2);
dispose(nC1);
dispose(nS);

// 4b: steady-state B/op in a pinned-semi-space child (fail closed on any gap).
const NEST_BUDGET = 0.05;
const lane = spawnSync(process.execPath,
  ['--expose-gc', '--min-semi-space-size=4', '--max-semi-space-size=4', fileURLToPath(import.meta.url), '--nest-lane'],
  { encoding: 'utf8', timeout: 120000 });
let nestLane = null;
try { nestLane = JSON.parse(lane.stdout.trim().split('\n').pop()); } catch { nestLane = null; }
const nestOk = nestLane !== null && nestLane.pinned === true &&
  nestLane.nest !== null && nestLane.nest <= NEST_BUDGET &&
  nestLane.control !== null && nestLane.control >= 8;   // a blind lane is a FAIL, not a pass
// WATCH rides the same child: the box control above proves that process can see.
// Blind unless every measured + warm-up step fired the callback.
const watchFired = nestLane !== null && nestLane.watchSteps > 0 && nestLane.watchFires === nestLane.watchSteps;
const watchOk = nestOk && watchFired &&
  typeof nestLane.watch === 'number' && nestLane.watch <= NEST_BUDGET;
const nestLabel = nestLane === null || nestLane.nest === null ? 'unmeasured' : nestLane.nest.toFixed(3);
const watchLabel = nestLane === null || typeof nestLane.watch !== 'number' ? 'unmeasured' : nestLane.watch.toFixed(3);
const ctlLabel = nestLane === null || nestLane.control === null ? 'unmeasured' : nestLane.control.toFixed(2);
// QS rides the same child (phase 6 reads it). Blind unless every step ran the scheduler and both
// bodies (+1: each effect's creation run).
const qsChildFired = nestLane !== null && nestLane.qsSteps > 0 && nestLane.qsRuns === nestLane.qsSteps + 1 &&
  nestLane.qsPlain === nestLane.qsSteps + 1 && nestLane.qsSched === nestLane.qsSteps + 1;
const qsChildOk = nestOk && qsChildFired && typeof nestLane.qs === 'number' && nestLane.qs <= NEST_BUDGET;
const qsChildLabel = nestLane === null || typeof nestLane.qs !== 'number' ? 'unmeasured' : nestLane.qs.toFixed(3);

// 4c: retention -- 1e4 cycles of the P10 (child effect's nested first run disposes
// a dep the parent reads later) and F8 (onDisconnect disposes the next dep during
// the dispose walk) shapes. Three exact oracles, no heap threshold:
// (1) WeakRef census, ENGINE-owned: every 64th cycle of pass 1 and the last 4
//     cycles (NEST_SAMPLED = 161) hold WeakRefs to the six user objects handed to the
//     engine (a signal's value payload, the effect bodies bodyP / childP /
//     bodyF, the observeObservers hooks object and its onDisconnect). After
//     disposal + forced GC none may survive: a pooled or pinned node (or the
//     lifecycle map) that kept a value / computeFn / hook would keep them alive.
//     The hooks-object WeakRef cannot catch anything on this engine:
//     observeObservers copies onDisconnect into its own lifecycle entry and never
//     holds the hooks object (a retained entry shows up as the onDisconnect ref).
//     Control: a module-held object's WeakRef must still deref and a WeakRef whose
//     target died with its function's frame must be cleared -- either failing =
//     FAIL. It proves gc + WeakRef clearing work here, NOT that the census counts
//     the right objects (that rests on mutants that must leave a sampled ref
//     alive, e.g. dropping disposeNode's value or computeFn clear).
// (2) Free-list census on R: every slot the counters call free
//     (nodePoolPopulation - activeNodes, linkPoolPopulation - activeLinks) is
//     drained back out under the default "throw" policy, and one more node must
//     throw CapacityError. A slot that left the free list while activeNodes still
//     decremented is silent to the counters and to the heap (the eager pool holds
//     it either way); only the drain sees it.
// (3) Post-drain stats(): activeNodes / activeLinks / signals / computeds / effects
//     back to nestBase, and totalAllocations - totalDisposals === activeNodes.
// Pass 2 (warm, unsampled) measures the resident delta: an advisory print
// (res=...KB(adv)), gated nowhere. (lite-leak's tracker would only see
// harness-owned markers here, so 4c does not use it.) Cannot see: engine-internal
// retention of objects that are neither user-owned nor counted (e.g. a growing
// array of node refs); a free-list leak rarer than ~1 slot per 2e4 cycles (the
// drain counts every slot stranded on R since its creation -- phases 1-4c share R --
// but only this lane's 2 x NEST_CYCLES cycles run the P10 / F8 shapes).
const NEST_CYCLES = 10000;
// Sampled cycles: (i & 63) === 0 over pass 1 (ceil(NEST_CYCLES / 64)) plus the last 4
// cycles of pass 2 (disjoint from pass 1). nestSampled === NEST_SAMPLED is gated, so a
// sampling-loop change that breaks the formula fails closed.
const NEST_SAMPLED = Math.ceil(NEST_CYCLES / 64) + 4;
const nestBase = stats();
let nestShapeFail = 0;
let nestSampled = 0;
let resBefore = null;
const nestRefs = [];
// One cycle per call, so its locals die on return: only the engine can keep the
// sampled objects alive afterwards.
function nestCycle(sample) {
  if (sample) nestSampled++;
  try {
    // P10
    const payload = { sample };
    const t = signal(0), a = signal(payload), b = signal(0);
    let mode = 0, runs = 0;
    const childP = () => { dispose(a); };
    const bodyP = () => {
      runs++; t();
      if (mode === 1) effect(childP);
      a(); b();
    };
    if (sample) { nestRefs.push(new WeakRef(payload)); nestRefs.push(new WeakRef(bodyP)); nestRefs.push(new WeakRef(childP)); }
    const stopP = effect(bodyP);
    mode = 1;
    t.set(1);
    b.set(5);
    if (runs !== 3 || stats().activeLinks !== nestBase.activeLinks + 2) nestShapeFail++;
    stopP();
    dispose(t);
    dispose(b);
    // F8
    const a2 = signal(0), b2 = signal(0);
    const hooks = { onDisconnect: () => dispose(b2) };
    const off = observeObservers(a2, hooks);
    const bodyF = () => { a2(); b2(); };
    if (sample) { nestRefs.push(new WeakRef(bodyF)); nestRefs.push(new WeakRef(hooks)); nestRefs.push(new WeakRef(hooks.onDisconnect)); }
    const stopF = effect(bodyF);
    stopF();
    if (stats().activeLinks !== nestBase.activeLinks || stats().signals !== nestBase.signals + 1) nestShapeFail++;
    off();
    dispose(a2);
  } catch {
    nestShapeFail++;
  }
}
for (let i = 0; i < 2 * NEST_CYCLES; i++) {
  if (i === NEST_CYCLES) {
    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 50));
    globalThis.gc?.();
    resBefore = process.memoryUsage();
  }
  // Sample every 64th cycle of pass 1 AND the last 4 cycles: those slots sit idle on
  // the free list afterwards (earlier ones are overwritten by reuse), so only a node
  // that kept its payload or closure after disposal can keep them alive.
  nestCycle((i < NEST_CYCLES && (i & 63) === 0) || i >= 2 * NEST_CYCLES - 4);
}
// Census control: ctlHeld stays reachable from module scope (must deref alive);
// nestCtlRef()'s target dies with its frame (the gc sequence below must clear it).
// Proves gc + WeakRef clearing work, not that nestRefs holds what a leak would keep.
const ctlHeld = { ctl: 1 };
const ctlLiveRef = new WeakRef(ctlHeld);
function nestCtlRef() { return new WeakRef({ ctl: 2 }); }
const ctlDeadRef = nestCtlRef();
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 0));   // WeakRef targets stay alive until the job that read them ends
globalThis.gc?.();
let nestAlive = 0;
for (let i = 0; i < nestRefs.length; i++) if (nestRefs[i].deref() !== undefined) nestAlive++;
const ctlAlive = ctlLiveRef.deref() === ctlHeld;
const ctlDead = ctlDeadRef.deref() === undefined;
const resAfter = process.memoryUsage();
const nestResKB = ((resAfter.heapUsed + resAfter.arrayBuffers) - (resBefore.heapUsed + resBefore.arrayBuffers)) / 1024;
const nestAfter = stats();
// Free-list census on R (after the res read). Nodes: drain every free slot, then one
// more must throw CapacityError (default "throw" policy: the pool cannot grow).
const nD = nestAfter.nodePoolPopulation - nestAfter.activeNodes;
const lD = nestAfter.linkPoolPopulation - nestAfter.activeLinks;
let nDrained = 0, nExtraThrew = false, lDrained = 0, lFull = false;
const drainSigs = [];
try {
  for (let i = 0; i < nD; i++) { drainSigs.push(signal(i)); nDrained++; }
} catch { /* nDrained < nD: a slot the counters call free is not on the free list */ }
if (nDrained === nD) {
  try {
    drainSigs.push(signal(-1));
  } catch (e) {
    nExtraThrew = (e !== null && typeof e === 'object' && e.name === 'CapacityError') ||
      String(e && e.message).startsWith('CapacityError');
  }
}
for (let i = 0; i < drainSigs.length; i++) dispose(drainSigs[i]);
drainSigs.length = 0;
// Links: 64 source signals, floor(lD / 64) effects reading all 64, one effect reading
// lD % 64. Unmeasured (fails closed) if the node pool cannot hold sources + effects.
const LDW = 64;
const lFullEff = Math.floor(lD / LDW);
const lEff = lFullEff + (lD % LDW !== 0 ? 1 : 0);
const lMeasured = LDW + lEff <= nD;
const lSrc = [], lStops = [];
if (lMeasured) {
  const l0 = stats().activeLinks;
  try {
    for (let i = 0; i < LDW; i++) lSrc.push(signal(i));
    for (let e = 0; e < lEff; e++) {
      const w = e < lFullEff ? LDW : lD % LDW;
      lStops.push(effect(() => { for (let k = 0; k < w; k++) lSrc[k](); }));
    }
  } catch { /* lDrained < lD */ }
  const lst = stats();
  lDrained = lst.activeLinks - l0;
  lFull = lst.activeLinks === lst.linkPoolPopulation;
}
for (let i = 0; i < lStops.length; i++) lStops[i]();
for (let i = 0; i < lSrc.length; i++) dispose(lSrc[i]);
lStops.length = 0;
lSrc.length = 0;
const nestDrainAfter = stats();
const nestRetOk = nestShapeFail === 0 && nestSampled === NEST_SAMPLED && nestRefs.length === NEST_SAMPLED * 6 && nestAlive === 0 &&
  ctlAlive && ctlDead &&
  nestAfter.activeNodes === nestBase.activeNodes &&
  nestAfter.activeLinks === nestBase.activeLinks &&
  nDrained === nD && nExtraThrew &&
  lMeasured && lDrained === lD && lFull &&
  nestDrainAfter.activeNodes === nestBase.activeNodes &&
  nestDrainAfter.activeLinks === nestBase.activeLinks &&
  nestDrainAfter.signals === nestBase.signals &&
  nestDrainAfter.computeds === nestBase.computeds &&
  nestDrainAfter.effects === nestBase.effects &&
  nestDrainAfter.totalAllocations - nestDrainAfter.totalDisposals === nestDrainAfter.activeNodes;

// ---- phase 5: PIN (SPEC-A A1.8) --------------------------------------------
// 5a: slots disposed while RUNNING are pinned until depth 0 and must come back.
// Without the release (createNode miss + flush end), every cycle strands two
// slots and the pool grows by ~2e4. Top level: the effect disposes itself on its
// first (synchronous) run; in a flush: it disposes itself on its re-run.
const pinCycle = () => {
  effect(() => { dispose(getOwner()); });
  const s2 = signal(0);
  let st = null;
  st = effect(() => { s2(); if (st !== null) st(); });
  s2.set(1);
  dispose(s2);
};
let pinThrew = null;
try {
  for (let i = 0; i < 1000; i++) pinCycle();   // warm-up: pool reaches its working size
} catch (e) {
  pinThrew = String(e && e.message);
}
const pinBase = stats();
const pgc = new GcProfiler().start();
try {
  if (pinThrew === null) for (let i = 0; i < 10000; i++) pinCycle();
} catch (e) {
  pinThrew = String(e && e.message);
}
await new Promise((r) => setTimeout(r, 50));
const ps = pgc.summary();
const pinGcReport = checkNoGc(ps, { maxMajor: 0 });
pgc.stop();
const pinAfter = stats();
const pinPoolDelta = pinAfter.nodePoolPopulation - pinBase.nodePoolPopulation;

// 5b: dead owner. The child effect created after its parent died mid-run must be
// unowned; if the dead parent adopted it, the parent's recycled slot (now another
// effect) cascade-disposes it on its next run and the child stops reacting.
let deadOwnerFail = 0;
for (let i = 0; i < 1000; i++) {
  try {
  const t = signal(0), x = signal(0), k = signal(0);
  let mode = 0, runs = 0, stopOuter = null, child = null;
  stopOuter = effect(() => {
    t();
    if (mode === 1) {
      effect(() => { stopOuter(); });
      child = effect(() => { x(); runs++; });
    }
  });
  mode = 1;
  t.set(1);
  const stops = [];
  for (let j = 0; j < 8; j++) stops.push(effect(() => { k(); }));   // recycles the released slots
  k.set(1);
  const before = runs;
  x.set(1);
  if (child === null || runs !== before + 1) deadOwnerFail++;
  if (child !== null) child();
  for (let j = 0; j < stops.length; j++) stops[j]();
  dispose(t); dispose(x); dispose(k);
  } catch {
    deadOwnerFail++;
  }
}
const pinOk = pinThrew === null && pinPoolDelta === 0 && pinGcReport.ok && deadOwnerFail === 0 &&
  pinAfter.activeNodes === pinBase.activeNodes;

// ---- phase 6: QS (F21, LEDGER #35) ----------------------------------------
// The flush loop runs an entry only while its node is still QUEUED. Hot shape: one
// effect whose scheduler calls run() synchronously + one plain effect, both on qS.
// Scheduler, bodies and step are hoisted; the step counter is a Smi below 2^30, so
// no value repeats (an equal set would be a no-op and the lane would measure nothing).
const qS = signal(0);
let qsN = 0, qsRuns = 0, qsPlain = 0, qsSched = 0;
const qsScheduler = (run) => { qsSched++; run(); };
const qsStop1 = effect(() => { qS(); qsRuns++; }, { scheduler: qsScheduler });
const qsStop2 = effect(() => { qS(); qsPlain++; });
const qsStep = () => { qsN = (qsN + 1) & 0x3FFFFFFF; qS.set(qsN); };
const qgc = new GcProfiler().start();
for (let i = 0; i < HOT; i++) {
  qsStep();
  if ((i & 8191) === 0) qgc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
}
await new Promise((r) => setTimeout(r, 50));
const qs = qgc.summary();
const qsGcReport = checkNoGc(qs, { maxMajor: 0, maxPauseMs: 4 });
qgc.stop();
// In-process verdict = retention SLOPE. min-over-batches alone reads a per-batch constant
// k as k / iterations B/op, and k differs between measureAllocs calls, so ONE call per
// attempt interleaves both step counts: even batches run 1 qsStep per call, odd ones 5.
// k is shared by both parities and cancels; a per-call retainer grows with the steps.
// The wrappers are hot (Smi state only); everything else is cold and may allocate.
const QS_ITER = 20000, QS_BATCHES = 16, QS_WARM = 40000, QS_K = 3;
// Warm-up = pseudo-batches 0 (even) and 1 (odd); measured batch b has parity b & 1.
const QS_STEPS = ((QS_WARM + QS_ITER * QS_BATCHES) / QS_ITER / 2) * QS_ITER * 6;   // 1080000
let qpLeft = 0, qpOdd = 1;
const qsPairStep = () => {
  if (qpLeft === 0) { qpLeft = QS_ITER; qpOdd ^= 1; }
  qpLeft--;
  qsStep();
  if (qpOdd === 1) { qsStep(); qsStep(); qsStep(); qsStep(); }
};
// Fail closed: an attempt that did not run exactly QS_STEPS steps, end in the reset state,
// settle, read only null / finite >= 0 batches and keep >= 4 batches per parity is unmeasured,
// never a pass. Verdict: judgeSlope (Dlo = min even, Dhi = 2nd-smallest odd).
// Also the control's min of paired differences (from judgeSlope): pmin = min over odd b of
// batchBytes[b] - batchBytes[b - 1] (both halves non-null), nPair = the pairs counted. A one-time
// step in k lands inside at most one pair.
function qsRead(r, n0, endOk) {
  const steps = (qsN - n0) & 0x3FFFFFFF;
  const ok = r.settled && endOk && steps === QS_STEPS;
  return { r, steps, endOk, ...judgeSlope(r.batchBytes, ok) };
}
const qsAttempts = [];
let qsPass = null;
for (let a = 0; a < QS_K && qsPass === null; a++) {
  qpLeft = 0; qpOdd = 1;
  const n0 = qsN;
  const r = measureAllocs(qsPairStep, { iterations: QS_ITER, batches: QS_BATCHES, warmup: QS_WARM });
  const at = qsRead(r, n0, qpLeft === 0 && qpOdd === 1);
  qsAttempts.push(at);
  if (at.pass) qsPass = at;
}
const qsAllocOk = qsPass !== null;
// Control with teeth: drives qsPairStep itself (same call shape, one call per attempt), retaining one
// { v } per 1000 qsN steps, at most 1 per call (Smi mark, pre-sized ring: 1080 holds per
// call; past the ring fails closed). Odd batches hold 100, even 20, so every (even b - 1, odd b) pair
// differs by 80 holds = 1280 B at a 16 B object floor (measured 32 B per { v }: 2560 B). Gate: the
// min of paired differences >= 1280 B, or blind (b74; not Dhi - Dlo, see the header).
const QS_HOLD_N = 2048;
const QS_HOLD = new Array(QS_HOLD_N).fill(null);
let qcMark = 0, qh = 0;
const qsCtlPairStep = () => {
  qsPairStep();
  if (((qsN - qcMark) & 0x3FFFFFFF) >= 1000) { qcMark = (qcMark + 1000) & 0x3FFFFFFF; if (qh < QS_HOLD_N) QS_HOLD[qh] = { v: qh }; qh++; }
};
// Bounded fail-closed retry, as the lane above: up to QS_K attempts, stop at the first pass; each
// starts from the reset state with an empty ring. An attempt passes iff measured with >= 4 measured
// pairs, the min of paired differences >= 1280 and the ring never overflowed; exhausted -> red.
const qsCtlAttempts = [];
let qsCtlPass = null;
for (let a = 0; a < QS_K && qsCtlPass === null; a++) {
  qpLeft = 0; qpOdd = 1; qcMark = qsN; qh = 0;
  QS_HOLD.fill(null);
  const n0 = qsN;
  const at = qsRead(measureAllocs(qsCtlPairStep, { iterations: QS_ITER, batches: QS_BATCHES, warmup: QS_WARM }),
    n0, qpLeft === 0 && qpOdd === 1);
  const c = { at, delta: at.measured && at.nPair >= 4 ? at.pmin : null, holds: qh };   // delta = min paired difference
  qsCtlAttempts.push(c);
  if (c.delta !== null && c.delta >= 1280 && c.holds <= QS_HOLD_N) qsCtlPass = c;
}
const qsCtlOk = qsCtlPass !== null;
QS_HOLD.fill(null);
// Advisory only (never gates): on a red slope, sample where the qs steps allocate.
let qsAttr = null;
if (!qsAllocOk) {
  qpLeft = 0; qpOdd = 1;
  qsAttr = measureAllocs(qsPairStep, { iterations: QS_ITER, batches: 4, warmup: 0, attribute: true, topSites: 5 });
}
// Blind unless every step ran the scheduler and both bodies (+1: each creation run).
// Counted after the control and the attribution run: both drive qsStep.
const qsFired = qsN >= HOT && qsRuns === qsN + 1 && qsPlain === qsN + 1 && qsSched === qsN + 1;
// Label: the passing attempt, else the last one. A pass has Dhi <= Dlo, so it reads 0.
const qsShown = qsPass !== null ? qsPass : qsAttempts[qsAttempts.length - 1];
const qsBpcLabel = qsShown.measured ? String(Math.max(0, (qsShown.hi - qsShown.lo) / (QS_ITER * 4))) : 'unmeasured';
const qsKLabel = kLabel(qsPass, qsShown);
// Control label: the passing attempt, else the last one.
const qsCtlShown = qsCtlPass !== null ? qsCtlPass : qsCtlAttempts[qsCtlAttempts.length - 1];
const qsCtlLabel = qsCtlShown.delta === null ? 'unmeasured' : qsCtlShown.delta + 'B';
const qsOk = qsFired && qsGcReport.ok && qsAllocOk && qsCtlOk && qsChildOk;
qsStop1();
qsStop2();
dispose(qS);

// ---- phase 7: F21 retention ---------------------------------------------------
// 1e3 cycles of the P3 shape (vectors/probes2.mjs): a creation-time CycleError leaves
// stale queue entries; the next effect() recycles a slot and must neither throw nor
// be killed by a stale entry. Each cycle tracks a marker (held until size() is read)
// and releases it only if the shape behaved AND destroy() returned, so size() counts
// the failed cycles. Held-value contract: tag is a number, cleanup is null.
const F21_CYCLES = 1000;
const f21Markers = new Array(F21_CYCLES).fill(null);
let f21Fail = 0;
function f21Cycle(i) {
  const marker = { i };
  f21Markers[i] = marker;
  const handle = tracker.track(marker, null, 200000 + i, { audit: true });
  let clean = false;
  try {
    const r = createRegistry({ maxFlushPasses: 8 });
    const s1 = r.signal(1), w = r.signal(0), q = r.signal(0);
    const go = r.signal(false), a = r.signal(0), b = r.signal(0);
    const e1 = r.effect(() => { if (go()) b.set(a() + 1); });
    const e3 = r.effect(() => { if (go()) a.set(b() + 1); });
    let cyc = null;
    try { r.effect(() => { go.set(true); }); } catch (e) { cyc = String(e && e.message); }
    e1(); e3();
    let runs = 0;
    r.effect(() => { runs++; w.set(s1() + 1); });   // F21: a stale entry must not throw here
    q.set(1);
    clean = cyc !== null && cyc.startsWith('CycleError') && runs === 1 && r.stats().effects === 1;
    r.destroy();
  } catch {
    clean = false;
  }
  if (clean) tracker.untrack(handle); else f21Fail++;
}
for (let i = 0; i < F21_CYCLES; i++) f21Cycle(i);
const f21Live = tracker.size();
f21Markers.fill(null);
const f21Ok = f21Live === 0 && f21Fail === 0;

// ---- phase 8: MREG (A5a, observeObservers registrations are independent) -----
// 8a: fire half, GC budget. Three hoisted registrations on mgS; the effect reads mgS on odd
// mgT only, so each step is one connect or one disconnect fire walking all three regs.
// Counters are Int32Array slots [connA, connB, connC, discA, discB, discC].
const mgS = signal(0), mgT = signal(0);
const MG = new Int32Array(6);
let mgN = 0;
const mgOffA = observeObservers(mgS, { onConnect: () => { MG[0]++; }, onDisconnect: () => { MG[3]++; } });
const mgOffB = observeObservers(mgS, { onConnect: () => { MG[1]++; }, onDisconnect: () => { MG[4]++; } });
const mgOffC = observeObservers(mgS, { onConnect: () => { MG[2]++; }, onDisconnect: () => { MG[5]++; } });
const mgStop = effect(() => { if ((mgT() & 1) === 1) mgS(); });
const mgStep = () => { mgN = (mgN + 1) & 0x3FFFFFFF; mgT.set(mgN); };
globalThis.gc?.();   // empty new space first; minor 0 is best effort, the pinned child gates B/op
const mggc = new GcProfiler().start();
for (let i = 0; i < HOT; i++) {
  mgStep();
  if ((i & 8191) === 0) mggc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
}
await new Promise((r) => setTimeout(r, 50));
const mgs = mggc.summary();
const mgGcReport = checkNoGc(mgs, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
mggc.stop();
// Blind unless every step fired every registration once (steps start at mgN = 1: connect first).
const mgFired = mgN === HOT && MG[0] === HOT / 2 && MG[1] === HOT / 2 && MG[2] === HOT / 2 &&
  MG[3] === HOT / 2 && MG[4] === HOT / 2 && MG[5] === HOT / 2;
mgStop();
mgOffA(); mgOffB(); mgOffC();
dispose(mgT);
dispose(mgS);
// The same fire step in the pinned child (phase 4b). Blind unless conn + disc === steps for
// every reg and conn - disc is 0 or 1 (the child's steps also start with a connect).
const mregChildFired = nestLane !== null && nestLane.mregSteps > 0 && Array.isArray(nestLane.mregCounts) &&
  nestLane.mregCounts.length === 6 && [0, 1, 2].every((k) => {
    const c = nestLane.mregCounts[k], d = nestLane.mregCounts[k + 3];
    return c + d === nestLane.mregSteps && (c - d === 0 || c - d === 1);
  });
// Whole-run gate (b116): the steady-state MIN alone cannot see a transient (allocation in only
// some windows), so EVERY window 1..8 must be <= NEST_BUDGET net (mregMax) and none may have been
// hit by a scavenge (mregNull === 0). Missing fields fail closed.
const mregChildOk = nestOk && mregChildFired && typeof nestLane.mreg === 'number' && nestLane.mreg <= NEST_BUDGET &&
  typeof nestLane.mregMax === 'number' && nestLane.mregMax <= NEST_BUDGET && nestLane.mregNull === 0;
const mregChildLabel = (nestLane === null || typeof nestLane.mreg !== 'number' ? 'unmeasured' : nestLane.mreg.toFixed(3)) +
  ' B/op max=' + (nestLane === null || typeof nestLane.mregMax !== 'number' ? 'unmeasured' : nestLane.mregMax.toFixed(3)) +
  ' B/op null=' + (nestLane === null || typeof nestLane.mregNull !== 'number' ? 'unmeasured' : nestLane.mregNull);

// 8b: retention half. Per cycle, fresh callbacks on a fresh source (one cycle per call, so its
// locals die on return): connect #1 = A (offs itself), B (registers D: born connected, so this
// fire skips it), C; disconnect #1 = C (disposes the scratch signal), D; connect #2 = B, C, D;
// disconnect #2 = C, D. ord records the FIFO order of each fire (base 8: A=1, B=2, C=3, D=4).
// Then dispose(src) with offB / offC / offD KEPT in MREG_KEPT (never called) until after the
// census: the F-a drop must clear their callbacks. Exact oracles: (1) WeakRefs to cbA, cbB,
// cbCc, cbCd, cbDc, cbDd of every sampled cycle all collected; (2) a lite-leak marker per
// cycle, released only when the shape behaved (size() counts the failed cycles); (3) stats()
// back to mregBase. Held-value contract: tag is a number, cleanup is null.
const MREG_CYCLES = 10000;
const MREG_SAMPLED = Math.ceil(MREG_CYCLES / 64) + 4;   // (i & 63) === 0, plus the last 4 cycles
const MREG_KEPT = new Array(MREG_CYCLES * 3).fill(null);
const mregMarkers = new Array(MREG_CYCLES).fill(null);
const mregRefs = [];
let mregFail = 0, mregSampled = 0;
const mtracker = createLeakTracker({
  name: 'torture-mreg',
  onLeak: (r) => leaks.push(String(r.tag)),
  onWarning: (w) => warns.push(w.kind + ':' + w.reason),
});
const mregBase = stats();
function mregCycle(i, sample) {
  if (sample) mregSampled++;
  const marker = { i };
  mregMarkers[i] = marker;
  const handle = mtracker.track(marker, null, 300000 + i, { audit: true });
  let clean = false;
  try {
    const src = signal(0), scratch = signal(0);
    let ord = 0, nA = 0, nB = 0, nCc = 0, nCd = 0, nDc = 0, nDd = 0, scratchGone = false;
    let offA = null, offD = null;
    const cbA = () => { nA++; ord = ord * 8 + 1; offA(); };
    const cbDc = () => { nDc++; ord = ord * 8 + 4; };
    const cbDd = () => { nDd++; ord = ord * 8 + 4; };
    const cbB = () => {
      nB++; ord = ord * 8 + 2;
      if (offD === null) offD = observeObservers(src, { onConnect: cbDc, onDisconnect: cbDd });
    };
    const cbCc = () => { nCc++; ord = ord * 8 + 3; };
    const cbCd = () => { nCd++; ord = ord * 8 + 3; if (!scratchGone) { scratchGone = true; dispose(scratch); } };
    offA = observeObservers(src, { onConnect: cbA });
    const offB = observeObservers(src, { onConnect: cbB });
    const offC = observeObservers(src, { onConnect: cbCc, onDisconnect: cbCd });
    if (sample) {
      mregRefs.push(new WeakRef(cbA)); mregRefs.push(new WeakRef(cbB)); mregRefs.push(new WeakRef(cbCc));
      mregRefs.push(new WeakRef(cbCd)); mregRefs.push(new WeakRef(cbDc)); mregRefs.push(new WeakRef(cbDd));
    }
    const body = () => { src(); };
    const stop1 = effect(body);
    const o1 = ord; ord = 0;
    const d1 = nDc;   // D registered during connect #1: that fire must skip it
    stop1();
    const o2 = ord; ord = 0;
    const stop2 = effect(body);
    const o3 = ord; ord = 0;
    stop2();
    const o4 = ord;
    dispose(src);
    MREG_KEPT[3 * i] = offB; MREG_KEPT[3 * i + 1] = offC; MREG_KEPT[3 * i + 2] = offD;
    const st = stats();
    clean = o1 === (1 * 8 + 2) * 8 + 3 && o2 === 3 * 8 + 4 && o3 === (2 * 8 + 3) * 8 + 4 && o4 === 3 * 8 + 4 &&
      d1 === 0 && nA === 1 && nB === 2 && nCc === 2 && nCd === 2 && nDc === 1 && nDd === 2 && scratchGone &&
      offD !== null && st.activeLinks === mregBase.activeLinks && st.activeNodes === mregBase.activeNodes &&
      st.signals === mregBase.signals && st.effects === mregBase.effects;
  } catch {
    clean = false;
  }
  if (clean) mtracker.untrack(handle); else mregFail++;
}
for (let i = 0; i < MREG_CYCLES; i++) mregCycle(i, (i & 63) === 0 || i >= MREG_CYCLES - 4);
const mregLive = mtracker.size();
const mregFindings = mtracker.audit();
mregMarkers.fill(null);
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 0));   // WeakRef targets stay alive until the job that read them ends
globalThis.gc?.();
let mregAlive = 0;
for (let i = 0; i < mregRefs.length; i++) if (mregRefs[i].deref() !== undefined) mregAlive++;
let mregKept = 0;   // the off handles must still be held at census time, or the F-a check is vacuous
for (let i = 0; i < MREG_KEPT.length; i++) if (typeof MREG_KEPT[i] === 'function') mregKept++;
MREG_KEPT.fill(null);
const mregAfter = stats();
const mregOk = mgGcReport.ok && mgFired && mregChildOk && mregFail === 0 && mregSampled === MREG_SAMPLED &&
  mregRefs.length === MREG_SAMPLED * 6 && mregAlive === 0 && mregKept === MREG_CYCLES * 3 &&
  mregLive === 0 && mregFindings.length === 0 && ctlAlive && ctlDead &&
  mregAfter.activeNodes === mregBase.activeNodes && mregAfter.activeLinks === mregBase.activeLinks;

// ---- verdict --------------------------------------------------------------
const ok = gcReport.ok && allocOk && selfOk && nestGcReport.ok && nestOk && watchOk && nestRetOk && pinOk && qsOk && f21Ok && mregOk &&
  live === 0 && findings.length === 0 && leaks.length === 0 && warns.length === 0 &&
  nodesBaseline && linksBaseline;

console.log(
  'GATE leak=size ' + live + '/0 findings=' + findings.length +
  ' warnings=' + warns.length +
  ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
  ' maxMs=' + s.gc.maxMs.toFixed(2) +
  ' | alloc=' + bpcLabel + ' B/op k=' + alKLabel + ' K=' + setAttempts.length + ',' + unAttempts.length +
  ' | nest gc major=' + ns.gc.major + ' minor=' + ns.gc.minor + ' alloc=' + nestLabel + ' B/op' +
  ' watch=' + watchLabel + ' B/op control=' + ctlLabel + ' B/op retention=' + nestAlive + '/' + nestRefs.length +
  ' free=' + nDrained + '/' + nD + 'n,' + (lMeasured ? lDrained + '/' + lD + 'l' : 'unmeasured') + ' res=' + nestResKB.toFixed(1) + 'KB(adv)' +
  ' | pin pool=+' + pinPoolDelta + ' major=' + ps.gc.major + ' deadOwner=' + deadOwnerFail + '/1000' +
  ' | qs gc major=' + qs.gc.major + ' minor=' + qs.gc.minor + ' alloc=' + qsBpcLabel + ' B/op child=' + qsChildLabel + ' B/op' +
  ' k=' + qsKLabel + ' K=' + qsAttempts.length + ' ctl=' + qsCtlLabel + ',K=' + qsCtlAttempts.length +
  ' | f21 size=' + f21Live + '/0 fail=' + f21Fail + '/' + F21_CYCLES +
  ' | mreg gc major=' + mgs.gc.major + ' minor=' + mgs.gc.minor + ' fire=' + mregChildLabel +
  ' cb=' + mregAlive + '/' + mregRefs.length + ' size=' + mregLive + '/0 fail=' + mregFail + '/' + MREG_CYCLES +
  ' | ' + (ok ? 'ok' : 'FAIL')
);

if (!ok) {
  if (!nodesBaseline) console.error('  activeNodes drift: ' + base.activeNodes + ' -> ' + afterCycles.activeNodes);
  if (!linksBaseline) console.error('  activeLinks drift: ' + base.activeLinks + ' -> ' + afterCycles.activeLinks);
  if (!selfOk) console.error('  self-dispose-in-untrack: ran=' + ran +
    ' nodes ' + selfBase.activeNodes + '->' + selfAfter.activeNodes +
    ' links ' + selfBase.activeLinks + '->' + selfAfter.activeLinks);
  if (!nestGcReport.ok) for (const v of nestGcReport.violations) console.error('  nest gc violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
  if (!nestOk) console.error('  nest lane: ' + (nestLane === null ? 'no result (exit ' + lane.status + ') ' + String(lane.stderr).slice(0, 400) : JSON.stringify(nestLane)) +
    ' budget<=' + NEST_BUDGET + ' control>=8');
  if (!watchOk) console.error('  watch lane: ' + (nestLane === null ? 'no result' :
    'watch=' + nestLane.watch + ' window0=' + nestLane.watchWindow0 + ' fires=' + nestLane.watchFires +
    ' steps=' + nestLane.watchSteps) + ' budget<=' + NEST_BUDGET + (nestOk ? '' : ' (child lane failed: control/pin)'));
  if (!nestRetOk) console.error('  nest retention: shapeFail=' + nestShapeFail + ' sampled=' + nestSampled + '/' + NEST_SAMPLED +
    ' alive=' + nestAlive + '/' + nestRefs.length + ' control alive=' + (ctlAlive ? 1 : 0) + ' dead=' + (ctlDead ? 1 : 0) +
    ' nodes ' + nestBase.activeNodes + '->' + nestAfter.activeNodes +
    ' links ' + nestBase.activeLinks + '->' + nestAfter.activeLinks +
    ' drain nodes=' + nDrained + '/' + nD + ' extraThrew=' + nExtraThrew +
    ' links=' + (lMeasured ? lDrained + '/' + lD + ' full=' + lFull : 'unmeasured') +
    ' post-drain nodes=' + nestDrainAfter.activeNodes + ' links=' + nestDrainAfter.activeLinks +
    ' sig/comp/eff=' + nestDrainAfter.signals + '/' + nestDrainAfter.computeds + '/' + nestDrainAfter.effects +
    ' (base ' + nestBase.signals + '/' + nestBase.computeds + '/' + nestBase.effects + ')' +
    ' alloc-disp=' + (nestDrainAfter.totalAllocations - nestDrainAfter.totalDisposals) +
    ' res=' + nestResKB.toFixed(1) + 'KB (advisory)');
  if (!pinOk) console.error('  pin: threw=' + pinThrew + ' poolDelta=' + pinPoolDelta + ' deadOwnerFail=' + deadOwnerFail +
    ' nodes ' + pinBase.activeNodes + '->' + pinAfter.activeNodes +
    (pinGcReport.ok ? '' : ' gc ' + pinGcReport.violations.map((v) => v.metric + '=' + v.actual).join(',')));
  if (!qsOk) {
    console.error('  qs: fired=' + qsFired + ' steps=' + qsN + ' runs=' + qsRuns + ' plain=' + qsPlain + ' sched=' + qsSched +
      ' alloc=' + qsBpcLabel + ' child=' + qsChildLabel + ' childFired=' + qsChildFired +
      (qsGcReport.ok ? '' : ' gc ' + qsGcReport.violations.map((v) => v.metric + '=' + v.actual).join(',')));
    const show = (at) => 'Dlo=' + at.lo + ' Dhi=' + at.hi + ' minOdd=' + at.hiMin +
      ' (Dlo = min even, Dhi = 2nd-smallest odd; pass iff Dhi <= Dlo) batches ' +
      at.r.batchBytes.map((v, b) => ((b & 1) === 0 ? 'e' : 'o') + v).join(',') +
      ' measured=' + at.r.measuredBatches + ' inverted=' + at.r.invertedBatches + ' settled=' + at.r.settled +
      ' perParity=' + at.nLo + '/' + at.nHi + ' steps=' + at.steps + '/' + QS_STEPS + ' endState=' + at.endOk;
    for (let a = 0; a < qsAttempts.length; a++) console.error('  qs attempt ' + a + ': ' + show(qsAttempts[a]));
    for (let a = 0; a < qsCtlAttempts.length; a++) {
      const c = qsCtlAttempts[a];
      console.error('  qs control attempt ' + a + ': pairMin=' + c.delta + ' (>= 1280) pairs=' + c.at.nPair +
        ' (>= 4) holds=' + c.holds + '/' + QS_HOLD_N + ' ' + show(c.at));
    }
    if (qsAttr !== null) {
      const at = qsAttr.attribution;
      if (at === null || !at.available) console.error('  qs attribution (advisory): unavailable ' + (at === null ? 'null' : at.reason));
      else for (const st of at.sites) console.error('  qs attribution (advisory): ' + st.url + ':' + st.line + ' ' + st.selfBytes + ' B');
    }
  }
  if (!f21Ok) console.error('  f21 retention: size=' + f21Live + ' fail=' + f21Fail + '/' + F21_CYCLES);
  if (!mregOk) console.error('  mreg: fired=' + mgFired + ' steps=' + mgN + ' counts=' + Array.from(MG).join(',') +
    (mgGcReport.ok ? '' : ' gc ' + mgGcReport.violations.map((v) => v.metric + '=' + v.actual).join(',')) +
    ' child=' + (nestLane === null ? 'no result' : mregChildLabel + ' window0=' + nestLane.mregWindow0 +
      ' per=' + JSON.stringify(nestLane.mregPer) + ' base=' + JSON.stringify(nestLane.mregBase) +
      ' steps=' + nestLane.mregSteps + ' counts=' + String(nestLane.mregCounts)) + ' childFired=' + mregChildFired +
    ' budget<=' + NEST_BUDGET + (nestOk ? '' : ' (child lane failed: control/pin)') +
    ' | cycles fail=' + mregFail + '/' + MREG_CYCLES + ' sampled=' + mregSampled + '/' + MREG_SAMPLED +
    ' cb alive=' + mregAlive + '/' + mregRefs.length + ' kept=' + mregKept + '/' + (MREG_CYCLES * 3) +
    ' size=' + mregLive + ' findings=' + mregFindings.length + ' control alive=' + (ctlAlive ? 1 : 0) + ' dead=' + (ctlDead ? 1 : 0) +
    ' nodes ' + mregBase.activeNodes + '->' + mregAfter.activeNodes + ' links ' + mregBase.activeLinks + '->' + mregAfter.activeLinks);
  for (const v of gcReport.violations) console.error('  gc violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
  const alShow = (at) => 'Dlo=' + at.lo + ' Dhi=' + at.hi + ' minOdd=' + at.hiMin +
    ' (Dlo = min even, Dhi = 2nd-smallest odd; pass iff Dhi <= Dlo) batches ' +
    at.r.batchBytes.map((v, b) => ((b & 1) === 0 ? 'e' : 'o') + v).join(',') +
    ' measured=' + at.r.measuredBatches + ' inverted=' + at.r.invertedBatches + ' settled=' + at.r.settled +
    ' perParity=' + at.nLo + '/' + at.nHi + ' steps=' + at.steps + '/' + AL_STEPS + ' fires=' + at.fires +
    ' endState=' + at.endOk;
  if (setPass === null) for (let a = 0; a < setAttempts.length; a++) console.error('  set alloc fail attempt ' + a + ': ' + alShow(setAttempts[a]));
  if (unPass === null) for (let a = 0; a < unAttempts.length; a++) console.error('  untrack alloc fail attempt ' + a + ': ' + alShow(unAttempts[a]));
  for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
  for (const l of leaks) console.error('  leak ' + l);
  process.exitCode = 1;
}
