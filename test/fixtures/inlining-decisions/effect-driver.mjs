// XG TASK 2 (b244): audit/2026-11-21-crossaudit-neon/work/effect-hot-driver.mjs verbatim below (sha256 9a1a979d, the b240 freq-1.0 effect driver).
// Direct signal -> effect hot driver (call frequency 1.0 into executeEffect body & effectTail).
import { signal, effect } from './Signal.js';
const s = signal(0);
const sink = new Int32Array(1);
effect(() => { sink[0] = (sink[0] + s()) | 0; });
function drive(n) {
    for (let i = 1; i <= n; i++) s.set(i);
}
for (let k = 0; k < 20; k++) drive(20000);
if (sink[0] === -999999) console.log(sink[0]);
