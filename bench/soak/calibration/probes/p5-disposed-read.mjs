// TASK 0d probe 5: a disposed signal handle reads undefined (call and peek), its set is a no-op,
// and reading it inside a computed creates no link -- including after its slot is recycled (ABA).
import { K, emit } from './_kernel.mjs';

const r = K.createRegistry();
const s = r.signal(7);
r.dispose(s);
const read = s();
const peek = s.peek();
let setThrew = null;
try { s.set(3); } catch (e) { setThrew = String(e && e.message); }
const readAfterSet = s();
const linksBefore = r.stats().activeLinks;
const c = r.computed(() => s());      // recycles the disposed slot (ABA) and reads the stale handle
const cv = c();
const linksAfter = r.stats().activeLinks;
const ok = read === undefined && peek === undefined && readAfterSet === undefined && cv === undefined &&
    linksAfter === linksBefore && setThrew === null;
emit('disposed-handle-read', {
    read: String(read), peek: String(peek), setThrew, readAfterSet: String(readAfterSet), computedValue: String(cv),
    linksBefore, linksAfter, ok,
}, ok
    ? 'disposedRead=undefined: a disposed handle reads undefined (call and peek), set is a silent no-op, and a read makes no link'
    : 'disposed handles do NOT read as undefined/no-link: see observed');
