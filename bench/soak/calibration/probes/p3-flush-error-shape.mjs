// TASK 0d probe 3: the error shape a flush throws for ONE throwing effect vs TWO, and at creation.
import { K, emit, errShape } from './_kernel.mjs';

function flushWith(nThrow) {
    const r = K.createRegistry();
    const s = r.signal(0);
    let quietRuns = 0;
    for (let i = 0; i < nThrow; i++) {
        const tok = 'SoakThrow:' + i;
        r.effect(() => { if (s() === 1) throw new Error(tok); });
    }
    r.effect(() => { s(); quietRuns++; });
    let caught;
    try { s.set(1); } catch (e) { caught = e; }
    // recovery: the registry still flushes after a throwing flush
    let caught2;
    try { s.set(2); } catch (e) { caught2 = e; }
    return { thrown: errShape(caught), quietRunsAfterThrowingFlush: quietRuns, recoveryThrown: errShape(caught2), quietRunsAfterRecovery: quietRuns };
}

function atCreation() {
    const r = K.createRegistry();
    let caught;
    try { r.effect(() => { throw new Error('SoakThrow:create'); }); } catch (e) { caught = e; }
    return { thrown: errShape(caught), effectsAfter: r.stats().effects };
}

const one = flushWith(1);
const two = flushWith(2);
const create = atCreation();
emit('flush-error-shape', { one, two, create },
    'effectErrors=' + (two.thrown && two.thrown.aggregate ? 'aggregate' : 'rethrow-first') +
    ': one throwing body -> ' + (one.thrown ? one.thrown.ctor + (one.thrown.aggregate ? '(errors=' + one.thrown.errors.length + ')' : '(original)') : 'nothing') +
    '; two -> ' + (two.thrown ? two.thrown.ctor + (two.thrown.aggregate ? '(errors=' + two.thrown.errors.length + ')' : '') : 'nothing') +
    '; at creation -> ' + (create.thrown ? create.thrown.ctor : 'nothing') +
    '; non-throwing effects in the same flush still run');
