// TASK 0d probe 4: does an UNOBSERVED computed keep its dependency links after a top-level pull?
import { K, emit } from './_kernel.mjs';

const r = K.createRegistry();
const s = r.signal(1);
const t = r.signal(10);
const c = r.computed(() => s() + t());
const linksBefore = r.stats().activeLinks;
const v1 = c();
const linksAfterPull = r.stats().activeLinks;
const sourceHasObservers = typeof r.hasObservers === 'function' ? r.hasObservers(s) : null;
s.set(2);
const v2 = c();
const linksAfterSecondPull = r.stats().activeLinks;
const keeps = linksAfterPull === 2 && linksAfterSecondPull === 2;
emit('unobserved-computed-links', {
    linksBefore, v1, linksAfterPull, sourceHasObservers, v2, linksAfterSecondPull, keeps,
}, keeps
    ? 'a top-level pull of an unobserved computed links its sources and KEEPS the links (modelEdges counts evaluated unobserved computeds)'
    : 'an unobserved computed drops its links after a top-level pull');
