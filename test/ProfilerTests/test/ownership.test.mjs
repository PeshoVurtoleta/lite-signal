// Hard suite -- ownership + introspection. Version-gated: createRoot is >=1.5.0,
// createScope is >=1.6.0; the enumerator/ownership hooks (forEachObserver,
// forEachSource, hasObservers, ownerOf) are the same surface lite-devtools walks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as LS from '@zakkster/lite-signal';
const { signal, computed, effect } = LS;

const HAS_ROOT = typeof LS.createRoot === 'function';
const HAS_SCOPE = typeof LS.createScope === 'function';
const HAS_OWNEROF = typeof LS.ownerOf === 'function';
const HAS_FE_OBS = typeof LS.forEachObserver === 'function';
const HAS_FE_SRC = typeof LS.forEachSource === 'function';
const HAS_HASOBS = typeof LS.hasObservers === 'function';

const need = (cond, why) => (cond ? false : why);

describe('ownership', () => {
  it('createScope cascade-disposes the effects it adopts', { skip: need(HAS_SCOPE, 'requires createScope (>=1.6.0)') }, () => {
    const s = signal(0);
    let aRuns = 0, bRuns = 0;
    let stop;
    LS.createScope((d) => {
      stop = d;
      effect(() => { s(); aRuns++; });
      effect(() => { s(); bRuns++; });
    });
    assert.equal(aRuns, 1); assert.equal(bRuns, 1);
    s.set(1);
    assert.equal(aRuns, 2); assert.equal(bRuns, 2);
    stop();
    s.set(2);
    assert.equal(aRuns, 2, 'adopted effect a stopped after cascade dispose');
    assert.equal(bRuns, 2, 'adopted effect b stopped after cascade dispose');
  });

  it('createRoot detaches: a node created inside has no owner', { skip: need(HAS_ROOT && HAS_OWNEROF, 'requires createRoot + ownerOf') }, () => {
    let h;
    LS.createRoot(() => { h = effect(() => {}); });
    assert.ok(LS.ownerOf(h) == null, 'createRoot-created effect must be unowned (got ' + JSON.stringify(LS.ownerOf(h)) + ')');
    h();
  });

  it('createScope adopts: a node created inside is owned by the scope', { skip: need(HAS_SCOPE && HAS_OWNEROF, 'requires createScope + ownerOf') }, () => {
    let h, stop;
    LS.createScope((d) => { stop = d; h = effect(() => {}); });
    assert.ok(LS.ownerOf(h) != null, 'scope-created effect must have an owner');
    stop();
  });
});

describe('introspection (the surface lite-devtools walks)', () => {
  it('forEachSource / forEachObserver reflect the real edges', { skip: need(HAS_FE_SRC && HAS_FE_OBS, 'requires forEachSource/forEachObserver') }, () => {
    const a = signal(1);
    const b = computed(() => a() + 1);
    const e = effect(() => b());     // a <- b <- e
    void b();                        // ensure b is linked
    let srcOfB = 0;
    LS.forEachSource(b, () => srcOfB++);
    assert.ok(srcOfB >= 1, 'b reports >=1 source (a)');
    let obsOfA = 0;
    LS.forEachObserver(a, () => obsOfA++);
    assert.ok(obsOfA >= 1, 'a reports >=1 observer (b)');
    e();
  });

  it('hasObservers tracks observation state across subscribe/dispose', { skip: need(HAS_HASOBS, 'requires hasObservers') }, () => {
    const s = signal(0);
    assert.equal(LS.hasObservers(s), false, 'no observers initially');
    const e = effect(() => s());
    assert.equal(LS.hasObservers(s), true, 'observed after effect subscribes');
    e();
    assert.equal(LS.hasObservers(s), false, 'unobserved again after dispose');
  });

  it('introspection is non-perturbing: walking edges does not add observers', { skip: need(HAS_FE_OBS && HAS_HASOBS, 'requires forEachObserver + hasObservers') }, () => {
    const s = signal(0);
    LS.forEachObserver(s, () => {});  // a devtools-style walk
    assert.equal(LS.hasObservers(s), false, 'walking must not subscribe anything');
  });
});
