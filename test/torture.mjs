// test/torture.mjs -- node --expose-gc test/torture.mjs
//
// Standing zero-GC + retention judge for @zakkster/lite-signal, wired to the
// REAL engine (../Signal.js, not node_modules) so it proves THIS working tree.
// Generated from the torture-harness skill; adapted to lite-signal's actual
// hot entry points (there is no per-op user object -- the engine pools its
// nodes, so the steady-state hot path is signal.set -> propagate -> effect).
//
// Gates (fix the code, never widen a budget):
//   * 1e5 set->propagate ops              -> 0 B/op, maxMajor 0
//   * 1e5 untrack-in-effect ops           -> 0 B/op, maxMajor 0  (LEDGER #30 path)
//   * 1e4 create/dispose cycles           -> activeNodes/activeLinks back to baseline
//   * effect self-disposes inside untrack -> gen-safe restore, no crash, baseline
//   * NEST (SPEC-A A1.11): 1e5 nested recomputes effect -> computed -> computed
//     (three frames deep, the A1 cursor-stack push/pop on every frame)
//                                         -> <= 0.05 B/op steady state, maxMajor 0
//     The B/op lane runs in a CHILD with pinned semi-space (fail closed if the
//     flags are missing) and reads V8 new-space deltas, so it sees a transient
//     box; a one-box-per-op control MUST read >= 8 B/op or the lane is blind.
//   * NEST retention: 1e4 cycles of the P10 + F8 shapes (nested-frame disposal,
//     onDisconnect disposing the next dep) -> engine-owned WeakRefs all collected,
//     activeNodes/activeLinks back to baseline, resident delta <= 64 KB
//   * PIN (A1.8): 1e4 effects that dispose themselves while RUNNING (pinned slots),
//     at top level and inside a flush -> nodePoolPopulation flat after warm-up,
//     maxMajor 0; 1e3 dead-owner cycles (a child created under a parent disposed
//     mid-run, then the parent's slot recycled) -> the child is never adopted by
//     the stranger in that slot
//
// The untrack path is the LEDGER #30 keystone: untrack() nulls currentObserver
// for its window and restores it gen-safely (only if the observer survived the
// window). This torture drives 1e5 of those windows at zero allocation.
import { GcProfiler, checkNoGc, measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getHeapSpaceStatistics } from 'node:v8';

// >>> WIRE: the engine under test -- the working-tree source, NOT node_modules.
import { createRegistry } from '../Signal.js';

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
  const BOX = ['tagged'];   // PACKED_ELEMENTS: a double stored here is a fresh HeapNumber
  const boxStep = (i) => { BOX[0] = i + 0.5; };   // control: one 16 B HeapNumber per op
  for (let i = 0; i < 50000; i++) { nestStep(i); emptyStep(i); boxStep(i); }   // warm up
  const base = laneBytesPerOp(emptyStep);
  const nest = laneBytesPerOp(nestStep);
  const ctl = laneBytesPerOp(boxStep);
  stopN();
  console.log(JSON.stringify({ pinned, nest: steadyMin(nest, base), control: steadyMin(ctl, base),
    window0: nest[0], sink: sinkN }));
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
let sinkA = 0;
const stopA = effect(() => { sinkA += ca(); });
const setStep = (i) => { sa.set(i); };

// Path B: untrack-in-effect (the LEDGER #30 hot window). The untracked body is
// hoisted so the per-op cost is untrack()'s null/restore window ONLY -- a fresh
// arrow per run would allocate and mask the thing under test.
const sb = signal(0);
let sinkB = 0;
const untrackedBody = () => { sinkB++; };
const stopB = effect(() => { sb(); untrack(untrackedBody); });
const untrackStep = (i) => { sb.set(i); };

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

// 2b: per-op allocation floor (min-over-batches; requires --expose-gc).
const allocSet = measureAllocs(setStep, { iterations: 20000, batches: 8, warmup: 20000 });
const allocUn = measureAllocs(untrackStep, { iterations: 20000, batches: 8, warmup: 20000 });
// null is not zero: an unmeasured (settled:false / no channel) bytesPerCall is
// NOT a zero-allocation result. It prints as 'unmeasured' and fails the gate --
// a measurement that did not happen must never read green.
const allocMeasured = allocSet.bytesPerCall !== null && allocUn.bytesPerCall !== null;
const bpcLabel = allocMeasured
  ? String(Math.max(allocSet.bytesPerCall, allocUn.bytesPerCall, 0))
  : 'unmeasured';
const allocSetReport = checkAllocs(allocSet, { maxBytesPerCall: 0 });
const allocUnReport = checkAllocs(allocUn, { maxBytesPerCall: 0 });
const allocOk = allocMeasured &&
  allocSetReport.verdict === 'pass' && allocUnReport.verdict === 'pass';

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
const nestLabel = nestLane === null || nestLane.nest === null ? 'unmeasured' : nestLane.nest.toFixed(3);
const ctlLabel = nestLane === null || nestLane.control === null ? 'unmeasured' : nestLane.control.toFixed(2);

// 4c: retention -- 1e4 cycles of the P10 (child effect's nested first run disposes
// a dep the parent reads later) and F8 (onDisconnect disposes the next dep during
// the dispose walk) shapes. The retention oracle is ENGINE-owned: every 64th cycle
// holds WeakRefs to the user objects the engine stores in its pooled nodes (a
// signal's value payload, an effect's body closure). After disposal + forced GC
// none may survive: a pooled or pinned node that kept its value / computeFn would
// keep them alive. (lite-leak's tracker would only see harness-owned markers here,
// so 4c does not use it.) Pass 2 (warm, unsampled) measures the resident delta.
const NEST_CYCLES = 10000;
const nestBase = stats();
let nestShapeFail = 0;
let resBefore = null;
const nestRefs = [];
// One cycle per call, so its locals die on return: only the engine can keep the
// sampled objects alive afterwards.
function nestCycle(sample) {
  try {
    // P10
    const payload = { sample };
    const t = signal(0), a = signal(payload), b = signal(0);
    let mode = 0, runs = 0;
    const bodyP = () => {
      runs++; t();
      if (mode === 1) effect(() => { dispose(a); });
      a(); b();
    };
    if (sample) { nestRefs.push(new WeakRef(payload)); nestRefs.push(new WeakRef(bodyP)); }
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
    const off = observeObservers(a2, { onDisconnect: () => dispose(b2) });
    const bodyF = () => { a2(); b2(); };
    if (sample) nestRefs.push(new WeakRef(bodyF));
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
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 0));   // WeakRef targets stay alive until the job that read them ends
globalThis.gc?.();
let nestAlive = 0;
for (let i = 0; i < nestRefs.length; i++) if (nestRefs[i].deref() !== undefined) nestAlive++;
const resAfter = process.memoryUsage();
const nestResKB = ((resAfter.heapUsed + resAfter.arrayBuffers) - (resBefore.heapUsed + resBefore.arrayBuffers)) / 1024;
const nestAfter = stats();
const nestRetOk = nestShapeFail === 0 && nestRefs.length > 0 && nestAlive === 0 &&
  nestAfter.activeNodes === nestBase.activeNodes &&
  nestAfter.activeLinks === nestBase.activeLinks &&
  nestResKB <= 64;

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

// ---- verdict --------------------------------------------------------------
const ok = gcReport.ok && allocOk && selfOk && nestGcReport.ok && nestOk && nestRetOk && pinOk &&
  live === 0 && findings.length === 0 && leaks.length === 0 && warns.length === 0 &&
  nodesBaseline && linksBaseline;

console.log(
  'GATE leak=size ' + live + '/0 findings=' + findings.length +
  ' warnings=' + warns.length +
  ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
  ' maxMs=' + s.gc.maxMs.toFixed(2) +
  ' | alloc=' + bpcLabel + ' B/op' +
  ' | nest gc major=' + ns.gc.major + ' minor=' + ns.gc.minor + ' alloc=' + nestLabel + ' B/op' +
  ' control=' + ctlLabel + ' B/op retention=' + nestAlive + '/' + nestRefs.length + ' res=' + nestResKB.toFixed(1) + 'KB' +
  ' | pin pool=+' + pinPoolDelta + ' major=' + ps.gc.major + ' deadOwner=' + deadOwnerFail + '/1000' +
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
  if (!nestRetOk) console.error('  nest retention: shapeFail=' + nestShapeFail + ' alive=' + nestAlive + '/' + nestRefs.length +
    ' nodes ' + nestBase.activeNodes + '->' + nestAfter.activeNodes +
    ' links ' + nestBase.activeLinks + '->' + nestAfter.activeLinks + ' res=' + nestResKB.toFixed(1) + 'KB (<=64)');
  if (!pinOk) console.error('  pin: threw=' + pinThrew + ' poolDelta=' + pinPoolDelta + ' deadOwnerFail=' + deadOwnerFail +
    ' nodes ' + pinBase.activeNodes + '->' + pinAfter.activeNodes +
    (pinGcReport.ok ? '' : ' gc ' + pinGcReport.violations.map((v) => v.metric + '=' + v.actual).join(',')));
  for (const v of gcReport.violations) console.error('  gc violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
  if (allocSetReport.verdict !== 'pass') console.error('  set alloc ' + allocSetReport.verdict + ' bytesPerCall=' + allocSet.bytesPerCall);
  if (allocUnReport.verdict !== 'pass') console.error('  untrack alloc ' + allocUnReport.verdict + ' bytesPerCall=' + allocUn.bytesPerCall);
  for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
  for (const l of leaks) console.error('  leak ' + l);
  process.exitCode = 1;
}
