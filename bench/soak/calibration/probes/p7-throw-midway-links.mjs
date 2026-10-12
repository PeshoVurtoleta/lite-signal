// TASK 0d probe 7: after a body throws MIDWAY, which dependency links remain: the prefix read
// before the throw, or the previous run's full set (old tail kept)? Checked for a computed and an effect.
import { K, emit } from './_kernel.mjs';

// forEachSource passes a description object; map it back to a name by node id.
function sourcesOf(r, h, names) {
    const out = [];
    r.forEachSource(h, (src) => { out.push(names.get(src.id) || '?'); });
    return out;
}

function computedCase() {
    const r = K.createRegistry();
    const f = r.signal(0), a = r.signal(1), b = r.signal(2), d = r.signal(3);
    const names = new Map([[r.nodeId(f), 'f'], [r.nodeId(a), 'a'], [r.nodeId(b), 'b'], [r.nodeId(d), 'd']]);
    let runs = 0;
    const c = r.computed(() => { runs++; const x = f() + a(); if (f() === 1) throw new Error('SoakThrow:mid'); return x + b() + d(); });
    c();
    const before = sourcesOf(r, c, names);
    f.set(1);
    let threw = false;
    try { c(); } catch (e) { threw = true; }
    const afterThrow = sourcesOf(r, c, names);
    const runsAfterThrow = runs;
    b.set(20);                  // b was NOT read by the throwing run
    let rethrew = false;
    try { c(); } catch (e) { rethrew = true; }
    const recomputedOnTailWrite = runs > runsAfterThrow;
    return { before, threw, afterThrow, linksAfterThrow: r.stats().activeLinks, recomputedOnTailWrite, rethrew };
}

function effectCase() {
    const r = K.createRegistry();
    const f = r.signal(0), a = r.signal(1), b = r.signal(2);
    let runs = 0;
    let stop;
    try {
        stop = r.effect(() => { runs++; f(); a(); if (f() === 1) throw new Error('SoakThrow:eff'); b(); });
    } catch (e) { /* first run does not throw */ }
    const linksBefore = r.stats().activeLinks;
    try { f.set(1); } catch (e) { /* flush rethrows the body error */ }
    const linksAfterThrow = r.stats().activeLinks;
    const runsAfterThrow = runs;
    try { b.set(20); } catch (e) { /* would rethrow only if the effect re-ran */ }
    const reranOnTailWrite = runs > runsAfterThrow;
    if (stop) stop();
    return { linksBefore, linksAfterThrow, reranOnTailWrite };
}

const computed = computedCase();
const effect = effectCase();
const prefix = computed.afterThrow.join(',') === 'f,a' && !computed.recomputedOnTailWrite &&
    effect.linksAfterThrow === 2 && !effect.reranOnTailWrite;
emit('throw-midway-links', { computed, effect, prefix },
    prefix
        ? 'a body that throws midway keeps ONLY the prefix it read before the throw (the old tail is severed); a write to a tail-only source does not re-run it'
        : 'a body that throws midway keeps the previous run\'s tail links: see observed');
