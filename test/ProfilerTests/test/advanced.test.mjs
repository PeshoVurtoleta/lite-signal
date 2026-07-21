// Hard suite -- advanced, version-gated. flushStrategy (createRegistry config) is
// >=1.7.0; on earlier engines these skip. This is the "harden per version" hinge:
// when 1.7.0 publishes, these activate automatically.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as LS from '@zakkster/lite-signal';

let HAS_FLUSH_STRATEGY = false;
try {
  if (typeof LS.createRegistry === 'function') {
    const probe = LS.createRegistry({ flushStrategy: 'manual' });
    HAS_FLUSH_STRATEGY = typeof probe.flush === 'function';
    if (typeof probe.destroy === 'function') probe.destroy();
  }
} catch { HAS_FLUSH_STRATEGY = false; }
const need = (cond, why) => (cond ? false : why);

describe('flushStrategy (version-gated, >=1.7.0)', () => {
  it('"manual" defers all delivery until flush()', { skip: need(HAS_FLUSH_STRATEGY, 'requires flushStrategy (>=1.7.0)') }, () => {
    const r = LS.createRegistry({ flushStrategy: 'manual' });
    const s = r.signal(0);
    let runs = 0;
    const e = r.effect(() => { s(); runs++; });
    const r0 = runs;
    s.set(1);
    assert.equal(runs, r0, 'manual: a bare .set must not auto-flush');
    r.batch(() => { s.set(2); });
    assert.equal(runs, r0, 'manual: even batch exit must not auto-flush');
    r.flush();
    assert.ok(runs > r0, 'manual: flush() delivers the queued effect');
    e();
    if (typeof r.destroy === 'function') r.destroy();
  });

  it('"sab" defers a bare .set but flushes at batch exit', { skip: need(HAS_FLUSH_STRATEGY, 'requires flushStrategy (>=1.7.0)') }, () => {
    const r = LS.createRegistry({ flushStrategy: 'sab' });
    const s = r.signal(0);
    let runs = 0;
    const e = r.effect(() => { s(); runs++; });
    const r0 = runs;
    s.set(1);
    assert.equal(runs, r0, 'sab: a bare .set outside a batch must not auto-flush');
    r.batch(() => { s.set(2); });
    assert.ok(runs > r0, 'sab: batch exit delivers (dedup across writes)');
    e();
    if (typeof r.destroy === 'function') r.destroy();
  });

  it('rejects an unknown flushStrategy', { skip: need(HAS_FLUSH_STRATEGY, 'requires flushStrategy (>=1.7.0)') }, () => {
    assert.throws(() => LS.createRegistry({ flushStrategy: 'nope' }), /flushStrategy/);
  });
});
