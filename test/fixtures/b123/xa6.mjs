// b245 XA6 B1 (PLAN-XA6 TASK 3): public-behaviour inputs for test/123 rows 3c (M11 SS-NULL) and 1p (M12 MU-NONULLCHK).
// Every function takes the engine module S and returns an array of strings / values (trace, forEachSource lists, stats, reset).
const safe = (f) => { try { const v = f(); return v === undefined ? null : v; } catch (e) { return "E:" + (e && e.name) + ":" + String(e && e.message).slice(0, 40); } };
function lister(r, hs) {
    const id2n = new Map(); for (const k in hs) id2n.set(r.nodeId(hs[k]), k);
    return (k) => { const a = []; try { r.forEachSource(hs[k], (x) => a.push(id2n.get(x.id) || "?" + x.id)); } catch (e) { a.push("E:" + e.name); } return k + "[" + a.join(",") + "]"; };
}
// 3c: E (effect, depth 0) reads trig, C, x, y; C (computed, depth 1 inside E) reads trig then b, and its re-run drops the tail dep b
// -> severStale(C, link(b)) runs at d === 1 with E's live cursor (the link after C: x) as savedCur. F (an effect made after E) also
// reads x, y, so x / y's subscriber tails are F's links: a lost E cursor makes E's re-reads of x / y allocate duplicate links
// (allocateLink's same-pass dedup only sees the tail). maxLinks 8 = the 8 links the graph holds before the write (E 4, C 2, F 2).
export function ssTail(S, pol, ml) {
    const out = [];
    const r = S.createRegistry({ maxNodes: 16, maxLinks: ml, onCapacityExceeded: pol });
    const trig = r.signal(0), b = r.signal(1), x = r.signal(2), y = r.signal(3);
    let on = false;
    const C = r.computed(() => { const v = trig(); if (!on) b(); return v + 10; });
    const E = r.effect(() => { out.push("E:" + (trig() + C() + x() + y())); });
    const F = r.effect(() => { out.push("F:" + (x() + y())); });
    const ls = lister(r, { trig, b, x, y, C, E, F });
    out.push("L" + r.stats().activeLinks);
    on = true;
    out.push(safe(() => trig.set(1)));
    out.push(ls("E"), ls("C"), ls("F"), "L" + r.stats().activeLinks);
    out.push(safe(() => x.set(20)));
    out.push(safe(() => y.set(30)));
    out.push(ls("E"), "L" + r.stats().activeLinks);
    out.push(safe(() => { r.reset(); return "reset L" + r.stats().activeLinks; }));
    return out;
}
// 1p: E (depth 0) reads s0, C1, w; C1 (depth 1) reads a, b1, b2 and C2 LAST, so the cursor C1 saves for C2's frame is null (the read
// advanced it past C2, the end of C1's list); C2 (depth 2) disposes b1 (a dep of the suspended C1) -> one logged entry, and C2's restore
// calls fixCursor(null, 2) on the cold arm (fixLen 3).
export function nullCur(S) {
    const out = [];
    const r = S.createRegistry({ maxNodes: 32, maxLinks: 64 });
    const s0 = r.signal(0), a = r.signal(1), b1 = r.signal(2), b2 = r.signal(3), w = r.signal(4);
    let on = false;
    const C2 = r.computed(() => { const v = a(); if (on) r.dispose(b1); return v; });
    const C1 = r.computed(() => { let v = a(); v += b1() | 0; v += b2(); v += C2(); return v; });
    const E = r.effect(() => { out.push("E:" + (s0() + C1() + w())); });
    const ls = lister(r, { s0, a, b2, w, C1, C2, E });
    on = true;
    out.push(safe(() => r.batch(() => { s0.set(1); a.set(10); })));
    on = false;
    out.push(ls("E"), ls("C1"), ls("C2"), "L" + r.stats().activeLinks);
    out.push(safe(() => b2.set(30)));
    out.push(safe(() => w.set(40)));
    out.push(safe(() => a.set(50)));
    out.push(ls("E"), ls("C1"), "L" + r.stats().activeLinks);
    out.push(safe(() => { r.reset(); return "reset L" + r.stats().activeLinks; }));
    return out;
}
