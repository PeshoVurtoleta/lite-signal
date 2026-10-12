// TASK 0d probe 2: when does an effect created INSIDE a batch first run, and what value does it see?
import { K, emit } from './_kernel.mjs';

const r = K.createRegistry();
const s = r.signal(0);
const seen = [];
let runsAtCreateReturn = -1;
let runsAtBatchBodyEnd = -1;
r.batch(() => {
    s.set(5);
    r.effect(() => { seen.push(s()); });
    runsAtCreateReturn = seen.length;
    s.set(6);
    runsAtBatchBodyEnd = seen.length;
});
const runsAfterBatch = seen.length;
s.set(7);
const sync = runsAtCreateReturn === 1;
emit('midbatch-effect-first-run', {
    runsAtCreateReturn, runsAtBatchBodyEnd, runsAfterBatch, seen, runsAfterLaterSet: seen.length,
}, sync
    ? 'an effect created mid-batch runs its first body synchronously at creation (sees the in-batch value), ' +
      'then re-runs at batch close iff a source it read changed after that first run'
    : 'an effect created mid-batch defers its first run to batch close');
