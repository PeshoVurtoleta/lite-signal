// TASK 0d probe 6: is the default equality Object.is? (NaN equal to NaN; -0 distinct from 0)
import { K, emit } from './_kernel.mjs';

const r = K.createRegistry();
const n = r.signal(NaN);
const z = r.signal(0);
let nRuns = 0;
let zRuns = 0;
r.effect(() => { n(); nRuns++; });
r.effect(() => { z(); zRuns++; });
n.set(NaN);
z.set(-0);
const objectIs = nRuns === 1 && zRuns === 2;
const strict = nRuns === 2 && zRuns === 1;
emit('default-equality', { nanRuns: nRuns, negZeroRuns: zRuns, objectIs, strict },
    'equality=' + (objectIs ? 'Object.is' : strict ? '===' : 'unknown') + ': set(NaN) over NaN ' +
    (nRuns === 1 ? 'is a no-op' : 'propagates') + '; set(-0) over 0 ' + (zRuns === 2 ? 'propagates' : 'is a no-op'));
