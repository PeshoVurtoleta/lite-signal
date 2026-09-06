// Combined harness: @zakkster/lite-profiler-signal + @zakkster/lite-devtools,
// both pointed at the SAME lite-signal registry (1.6.0-preview.2).
//
// profiler-signal WRITES coarse frame telemetry into signals (fps, frameP99,
// frameClass, per-phase p99). A small "dashboard" reads those signals. devtools
// then INSPECTS that live graph -- non-perturbingly (peek + enumerator walks,
// never adds an observer) -- and confirms, via the same stats() it monitors, that
// the profiler allocates no new graph nodes in steady state.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Profiler, FrameClass } from '@zakkster/lite-profiler';
import { createProfilerView } from '@zakkster/lite-profiler-signal';
import { computed, effect } from '@zakkster/lite-signal';
import * as DT from '@zakkster/lite-devtools';

const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* spin */ } };

// ---- build the profiler + reactive view -----------------------------------
const profiler = new Profiler(256, ['update', 'render']);
const view = createProfilerView(profiler, { intervalMs: 20, leading: true, trailing: true });

// ---- a consumer "dashboard": this is what gives the telemetry signals observers
let dashRuns = 0;
const dash = effect(() => {
  void view.fps();
  void view.frameClass();
  void view.frameP99();
  void view.phases.update.p99();
  dashRuns++;
});
const overBudget = computed(() => view.frameP99() > 16.7);
void overBudget(); // realize so it links to frameP99

let jankFired = 0;
view.onJank(() => { jankFired++; });

// ---- drive frames: mostly fast, a few deliberate hitches -------------------
const FRAMES = 40;
for (let i = 0; i < FRAMES; i++) {
  profiler.beginFrame();
  profiler.begin('update'); busy(i % 9 === 0 ? 50 : 0.4); profiler.end('update');
  profiler.begin('render'); busy(0.3); profiler.end('render');
  profiler.endFrame();
  view.pulse();
}
view.flush(); // deterministic recompute -> output signals are set

describe('profiler-signal x devtools (shared registry)', () => {
  it('devtools reports engine capabilities for this version', () => {
    const cap = DT.capabilities();
    console.log('\n  capabilities:', JSON.stringify(cap));
    assert.equal(typeof cap.floor, 'string');
    assert.equal(cap.owners, true, '1.6 exposes owner-tree introspection');
    assert.equal(cap.mutationHook, true, '1.6 exposes the graph-mutation hook');
  });

  it('devtools sees the profiler signals and their dashboard observers', () => {
    const fpsObs = DT.subscribers(view.fps);
    const p99Obs = DT.subscribers(view.frameP99);
    console.log(`  fps=${view.fps.peek().toFixed(1)} | fps observers=${fpsObs.length} | frameP99 observers=${p99Obs.length}`);
    assert.ok(fpsObs.length >= 1, `fps observed by the dashboard; got ${fpsObs.length}`);
    assert.ok(p99Obs.length >= 2, `frameP99 observed by dashboard + overBudget computed; got ${p99Obs.length}`);
  });

  it('renders the live telemetry DAG', () => {
    const g = DT.graph([view.fps, view.frameClass, view.frameP99, view.phases.update.p99], { owners: true });
    console.log(`  graph: ${g.nodes.length} nodes, ${g.edges.length} edges`);
    console.log('  --- toTree(frameP99) ---');
    console.log(DT.toTree(view.frameP99).split('\n').map((l) => '    ' + l).join('\n'));
    const dot = DT.toDot(g);
    console.log('  --- toDot (first 3 lines) ---');
    console.log(dot.split('\n').slice(0, 3).map((l) => '    ' + l).join('\n'));
    assert.ok(g.nodes.length >= 4, 'graph discovered the telemetry signals + consumers');
    assert.ok(g.edges.length >= 1, 'graph discovered dependency edges');
  });

  it('devtools introspection is non-perturbing (walks add no observers)', () => {
    const before = DT.subscribers(view.fps).length;
    // a battery of devtools reads -- the kind a live panel would run every tick
    DT.inspect(view.fps);
    DT.graph([view.fps, view.frameClass, view.frameP99], { owners: true });
    DT.toDot(DT.graph(view.frameClass));
    DT.dependencies(view.frameP99);
    DT.monitor();
    const after = DT.subscribers(view.fps).length;
    assert.equal(after, before, `walking must not subscribe anything (${before} -> ${after})`);
  });

  it('steady-state pulsing allocates no new graph nodes (seen via devtools.monitor)', () => {
    const m0 = DT.monitor();
    // 2000 more frames; the hot path is one tick.set per frame -> NO new nodes
    for (let i = 0; i < 2000; i++) {
      profiler.beginFrame();
      profiler.begin('update'); profiler.end('update');
      profiler.begin('render'); profiler.end('render');
      profiler.endFrame();
      view.pulse();
    }
    view.flush();
    const m1 = DT.monitor();
    console.log(`  monitor: activeNodes ${m0.activeNodes} -> ${m1.activeNodes}` +
      (typeof m1.nodePoolCapacity === 'number' ? ` | poolCap ${m0.nodePoolCapacity} -> ${m1.nodePoolCapacity}` : '') +
      ` | dashboard recomputes so far: ${dashRuns} | onJank fired: ${jankFired}`);
    assert.ok(
      Math.abs(m1.activeNodes - m0.activeNodes) <= 4,
      `profiler must not grow the graph in steady state: ${m0.activeNodes} -> ${m1.activeNodes}`
    );
  });
});
