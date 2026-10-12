// TASK 0d probe 8: disposing a source does NOT re-run its dependents (the taint rule). What does a
// dependent read afterwards, and when does it next recompute?
import { K, emit } from './_kernel.mjs';

const r = K.createRegistry();
const s = r.signal(5);
const t = r.signal(1);
let cRuns = 0;
let eRuns = 0;
const seen = [];
const c = r.computed(() => { cRuns++; const v = s(); return (v === undefined ? 'U' : v) + ':' + t(); });
r.effect(() => { eRuns++; seen.push(c()); });
const before = { cRuns, eRuns, value: c() };
r.dispose(s);
const afterDispose = { cRuns, eRuns, value: c() };
t.set(2);                   // another source changes: the dependent recomputes and now reads the dead source
const afterOtherWrite = { cRuns, eRuns, value: c() };
const taint = afterDispose.eRuns === before.eRuns && afterDispose.cRuns === before.cRuns &&
    afterDispose.value === before.value && afterOtherWrite.value === 'U:2';
emit('dispose-taint', { before, afterDispose, afterOtherWrite, seen, taint },
    taint
        ? 'taint rule: disposing a source re-runs nothing; dependents keep their cached value (TAINTED: the model must not compare them) until another source changes, then they read the disposed source as undefined'
        : 'disposing a source re-runs or invalidates its dependents: see observed');
