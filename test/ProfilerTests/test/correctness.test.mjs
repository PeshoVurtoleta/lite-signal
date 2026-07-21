// Hard suite -- graph correctness. The classic reactive torture cases.
// Portable across lite-signal versions: imports the bare package (self-references
// inside the repo, resolves the installed version standalone). Default (eager)
// flush is assumed for these -- the published line is eager by default.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as LS from '@zakkster/lite-signal';
const { signal, computed, effect, batch, untrack } = LS;

describe('graph correctness', () => {
  it('is glitch-free on an observed diamond (one consistent update)', () => {
    const a = signal(1);
    const b = computed(() => a() + 1);
    const c = computed(() => a() * 2);
    let dRuns = 0;
    const d = computed(() => { dRuns++; return b() + c(); });
    const seen = [];
    let eRuns = 0;
    const e = effect(() => { eRuns++; seen.push(d()); });
    assert.equal(seen.at(-1), (1 + 1) + (1 * 2)); // 4
    const d0 = dRuns, e0 = eRuns;
    a.set(2);
    assert.equal(dRuns - d0, 1, `d recomputed ${dRuns - d0}x (glitch => >1)`);
    assert.equal(eRuns - e0, 1, `effect ran ${eRuns - e0}x (glitch => >1)`);
    assert.equal(seen.at(-1), (2 + 1) + (2 * 2)); // 7, consistent
    e();
  });

  it('propagates a deep chain exactly once to the tail', () => {
    const head = signal(0);
    let node = computed(() => head());
    for (let i = 0; i < 50; i++) { const prev = node; node = computed(() => prev() + 1); }
    const tail = node;
    let runs = 0;
    const e = effect(() => { runs++; tail(); });
    const r0 = runs;
    head.set(1);
    assert.equal(tail(), 51);
    assert.equal(runs - r0, 1, 'tail effect ran once for one head change');
    e();
  });

  it('fans out one source to many observers, each exactly once', () => {
    const s = signal(0);
    const N = 200;
    let total = 0;
    const ds = [];
    for (let i = 0; i < N; i++) ds.push(effect(() => { s(); total++; }));
    assert.equal(total, N);
    s.set(1);
    assert.equal(total, 2 * N, 'each observer fired exactly once more');
    for (const d of ds) d();
  });

  it('does not notify on a no-op set (Object.is equality)', () => {
    const s = signal(5);
    let runs = 0;
    const e = effect(() => { s(); runs++; });
    assert.equal(runs, 1);
    s.set(5);
    assert.equal(runs, 1, 'no-op set must not re-run');
    s.set(6);
    assert.equal(runs, 2);
    e();
  });

  it('honors a custom equals predicate', () => {
    const s = signal({ v: 1 }, { equals: (a, b) => a.v === b.v });
    let runs = 0;
    const e = effect(() => { s(); runs++; });
    s.set({ v: 1 });
    assert.equal(runs, 1, 'custom-equal set must not re-run');
    s.set({ v: 2 });
    assert.equal(runs, 2);
    e();
  });

  it('keeps an unobserved computed lazy (no recompute until read)', () => {
    const s = signal(0);
    let runs = 0;
    const c = computed(() => { runs++; return s() * 2; });
    assert.equal(runs, 0, 'computed must not run before first read');
    assert.equal(c(), 0);
    assert.equal(runs, 1);
    s.set(1); s.set(2); s.set(3);
    assert.equal(runs, 1, 'unobserved computed stays lazy across writes');
    assert.equal(c(), 6);
    assert.equal(runs, 2);
  });

  it('re-tracks dynamic/conditional dependencies (drops the untaken branch)', () => {
    const cond = signal(true);
    const a = signal('a'); const b = signal('b');
    let runs = 0;
    const e = effect(() => { runs++; void (cond() ? a() : b()); });
    assert.equal(runs, 1);
    b.set('b2');
    assert.equal(runs, 1, 'writing the untracked branch must not re-run');
    a.set('a2');
    assert.equal(runs, 2);
    cond.set(false);
    assert.equal(runs, 3);
    a.set('a3');
    assert.equal(runs, 3, 'after the switch, the old dep must be dropped');
    b.set('b3');
    assert.equal(runs, 4);
    e();
  });

  it('untrack() reads without creating a dependency', () => {
    const tracked = signal(0); const hidden = signal(0);
    let runs = 0;
    const e = effect(() => { runs++; tracked(); untrack(() => hidden()); });
    assert.equal(runs, 1);
    hidden.set(1);
    assert.equal(runs, 1, 'untracked read must not subscribe');
    tracked.set(1);
    assert.equal(runs, 2);
    e();
  });

  it('coalesces many writes in a batch into one effect run', () => {
    const x = signal(0); const y = signal(0);
    let runs = 0;
    const e = effect(() => { runs++; x(); y(); });
    assert.equal(runs, 1);
    batch(() => { x.set(1); y.set(1); x.set(2); });
    assert.equal(runs, 2, 'batch delivers one run for many writes');
    assert.equal(x.peek(), 2);
    e();
  });

  it('settles a net-unchanged value within a batch without an extra run', () => {
    const s = signal(1);
    let runs = 0;
    const e = effect(() => { s(); runs++; });
    assert.equal(runs, 1);
    batch(() => { s.set(2); s.set(1); }); // net unchanged across the batch
    assert.equal(runs, 1, 'net-unchanged batch must not re-run dependents');
    e();
  });
});
