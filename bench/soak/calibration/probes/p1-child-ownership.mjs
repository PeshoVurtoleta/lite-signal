// TASK 0d probe 1: is a child effect created inside a parent effect's body owned by that parent?
// Owned = the parent's re-run disposes the previous child, and the parent's stop disposes the live one.
import { K, emit } from './_kernel.mjs';

const r = K.createRegistry();
const a = r.signal(0);
const b = r.signal(0);
const runs = [];
let gen = 0;
const stop = r.effect(() => {
    a();
    const g = gen++;
    runs[g] = 0;
    r.effect(() => { b(); runs[g]++; });
});
const effectsAfterCreate = r.stats().effects;
a.set(1);                       // parent re-run: gen 1 child created
const effectsAfterRerun = r.stats().effects;
b.set(1);                       // only live children run
const gen0RunsAfterRerun = runs[0];
const gen1Runs = runs[1];
stop();
const effectsAfterParentStop = r.stats().effects;
b.set(2);
const gen1RunsAfterParentStop = runs[1];

const owned = gen0RunsAfterRerun === 1 && gen1Runs === 2 && effectsAfterRerun === 2 &&
    effectsAfterParentStop === 0 && gen1RunsAfterParentStop === 2;
emit('child-effect-ownership', {
    effectsAfterCreate, effectsAfterRerun, gen0RunsAfterRerun, gen1Runs,
    effectsAfterParentStop, gen1RunsAfterParentStop, owned,
}, owned
    ? 'nestedEffectsOwned=true: a parent re-run or stop disposes its child effects recursively'
    : 'nestedEffectsOwned=false: children survive their parent');
