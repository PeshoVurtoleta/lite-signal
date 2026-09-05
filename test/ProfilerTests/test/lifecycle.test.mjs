// Hard suite -- lifecycle + isolation. Cleanup ordering, dispose, error recovery,
// self-cycles, custom schedulers.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as LS from '@zakkster/lite-signal';
const { signal, computed, effect, dispose, onCleanup } = LS;

describe('lifecycle + isolation', () => {
  it('runs onCleanup before each re-run and once on dispose', () => {
    const s = signal(0);
    const log = [];
    const e = effect(() => {
      const v = s();
      onCleanup(() => log.push('cleanup ' + v));
      log.push('run ' + v);
    });
    assert.deepEqual(log, ['run 0']);
    s.set(1);
    assert.deepEqual(log, ['run 0', 'cleanup 0', 'run 1'], 'cleanup runs before re-run');
    e();
    assert.deepEqual(log, ['run 0', 'cleanup 0', 'run 1', 'cleanup 1'], 'final cleanup on dispose');
  });

  it('dispose() is idempotent and a disposed effect never fires again', () => {
    const s = signal(0);
    let runs = 0;
    const e = effect(() => { s(); runs++; });
    assert.equal(runs, 1);
    e(); e(); e();
    s.set(1); s.set(2);
    assert.equal(runs, 1, 'disposed effect must not run');
  });

  it('does not corrupt the engine when an effect throws', () => {
    const s = signal(0);
    const bad = effect(() => { if (s() === 1) throw new Error('boom'); });
    try { s.set(1); } catch { /* the throw may surface here; that is fine */ }
    // The engine must still be functional afterwards:
    const s2 = signal(0);
    let runs = 0;
    const e2 = effect(() => { s2(); runs++; });
    assert.equal(runs, 1);
    s2.set(1);
    assert.equal(runs, 2, 'engine still delivers updates after an effect threw');
    bad(); e2();
  });

  it('does not corrupt the engine when a computed throws', () => {
    const s = signal(0);
    const c = computed(() => { if (s() === 1) throw new Error('boom'); return s(); });
    assert.equal(c(), 0);
    s.set(1);
    assert.throws(() => c(), /boom/, 'throwing computed propagates on read');
    s.set(2);
    assert.equal(c(), 2, 'computed recovers once the input is valid again');
  });

  it('does not infinite-loop when an effect writes a signal it reads', () => {
    const s = signal(0);
    let runs = 0;
    const e = effect(() => { runs++; const v = s(); if (v < 3) s.set(v + 1); });
    // The invariant under test is no runaway / no stack overflow -- it settles.
    assert.ok(runs <= 16, `self-writing effect settled in ${runs} runs (no runaway)`);
    assert.ok(s.peek() >= 1, 'the write took effect');
    e();
  });

  it('routes re-runs through a custom scheduler', () => {
    const queue = [];
    let scheduled = 0;
    const sched = (runner) => { scheduled++; queue.push(runner); };
    const flush = () => { while (queue.length) queue.shift()(); };
    const s = signal(0);
    let runs = 0;
    const e = effect(() => { s(); runs++; }, { scheduler: sched });
    flush();                       // tolerate either sync-first-run or scheduled-first-run
    const runsAfterInit = runs;
    assert.ok(runsAfterInit >= 1, 'effect ran at least once after init/flush');
    const sched0 = scheduled;
    s.set(1);
    assert.ok(scheduled > sched0, 'scheduler was invoked on dependency change');
    flush();
    assert.ok(runs > runsAfterInit, 'effect ran after the scheduler flushed');
    e();
  });
});
