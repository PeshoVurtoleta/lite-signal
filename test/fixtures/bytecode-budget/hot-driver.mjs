// AUD-F group 1 (test/118-hot-body-budget.test.mjs): the hot-path driver for the inlinee bytecode budget. Staged by the test beside ONE
// build of Signal.js (copied as ./Signal.js); every BUDGET function must be COMPILED (V8 prints a function only once it is compiled):
// signal read / set / peek, computed read / peek, computedBox get (pullComputed), effect + batch + cleanups (executeEffect, flushEffects,
// runCleanupE / C, fireRecompute, effectTail), the pre-walk (pullMoved), and a conditional-dep effect / computed (the stale-tail epilogue).
import { signal, computed, effect, batch, computedBox, onCleanup } from './Signal.js';
const a = signal(0), b = signal(1);
const c = computed(() => { onCleanup(() => {}); return a() + b(); });
const d = computed(() => c() * 2);
const sink = new Int32Array(1);
effect(() => { onCleanup(() => {}); sink[0] = (sink[0] + d()) | 0; });
function step(i) {
    a.set(i);
    b.set(i ^ 1);
    batch(() => { a.set(i + 1); b.set(i); });
    return (a.peek() + c.peek() + d()) | 0;
}
let acc = 0;
for (let i = 0; i < 300000; i++) acc = (acc + step(i)) | 0;
// stale-tail lanes: a dep dropped on alternate runs
const g = signal(0), x = signal(0);
effect(() => { if ((g() & 1) === 0) x(); });
const cc = computed(() => ((g() & 1) === 0 ? x() : 0));
const cb = computedBox(() => a() + g());   // computedBox get -> pullComputed
for (let i = 1; i < 2000; i++) { g.set(i); acc = (acc + cc() + cb.get()) | 0; }
if (acc === 7 && sink[0] === 7) console.log('');
