// b123 shared shape programs (ASSERTION 1): used by test/123 (planted overflow) and by the --jitless sweep child.
// Each shape arms a stack-overflow site (via opts.arm(site)), runs one write, then re-writes and returns every list.
// opts.arm is called right before the write; opts.thrown records errors; opts.cap(e) records RangeError objects.
export function makeShapes(S, opts) {
    const arm = opts.arm || (() => {});
    const cap = opts.cap || (() => {});
    const go = opts.go || ((f) => f());
    const pre = opts.prelog === true;   // sweep variant: an earlier sibling frame leaves a log entry, so fixLen !== 0 at the deep frame
    const names = (r, nm) => (h) => { const o = []; r.forEachSource(h, (x) => o.push(nm.get(x.id) || "?" + x.id)); return o; };
    const audit = (r, hs) => { let n = 0; for (const h of hs) r.forEachSource(h, () => n++); return [r.stats().activeLinks, n]; };
    function mk() {
        const r = S.createRegistry(); const nm = new Map();
        const reg = (k, h) => { nm.set(r.nodeId(h), k); return h; };
        return { r, reg, src: names(r, nm) };
    }
    function fin(o, r, hs, thrown) {
        o.thrown = thrown; o.audit = audit(r, hs);
        let resetErr = null; try { r.reset(); } catch (e) { resetErr = String(e && e.message).slice(0, 60); }
        o.resetErr = resetErr;
        return o;
    }
    const note = (log) => (e) => { cap(e); log.push(e instanceof RangeError ? "RangeError" : e.constructor.name + ":" + String(e.message).slice(0, 30)); };
    // R: E -> C1 (d1, catches, reads more) -> C2 (d2: disposes b, ends with unread tail x).
    function R() {
        const { r, reg, src } = mk();
        const a = reg("a", r.signal(0)), b = reg("b", r.signal(0)), c = reg("c", r.signal(0)), d = reg("d", r.signal(0)), x = reg("x", r.signal(0)), s0 = reg("s", r.signal(0)), bp = reg("bp", r.signal(0));
        let on = false; const log = []; const nt = note(log);
        const Cp = reg("Cp", r.computed(() => { a(); if (on) r.dispose(bp); return 1; }));
        const C2 = reg("C2", r.computed(() => { a(); if (on) { r.dispose(b); return 1; } x(); return 1; }));
        const C1 = reg("C1", r.computed(() => { a(); if (pre) { bp(); Cp(); } try { C2(); } catch (e) { nt(e); } b(); c(); d(); return 1; }));
        const E = reg("E", r.effect(() => { s0(); C1(); }));
        const hs = [a, b, c, d, x, s0, bp, Cp, C1, C2, E]; const before = { C1: src(C1), C2: src(C2), E: src(E) };
        on = true; arm("R"); let thrown = null; try { go(() => r.batch(() => { s0.set(1); a.set(1); })); } catch (e) { cap(e); thrown = e.constructor.name; }
        const o = { before, log, C1: src(C1), C2: src(C2), E: src(E) };
        on = false; arm(null); try { r.batch(() => { s0.set(2); a.set(2); }); } catch (e) { cap(e); o.thrown2 = e.constructor.name; }
        o.after = { C1: src(C1), C2: src(C2), E: src(E) };
        return fin(o, r, hs, thrown);
    }
    // E: an effect X (deferred scheduler, run by hand at depth 2 inside C1) disposes a source of C1 and ends with an unread tail y.
    function E() {
        const { r, reg, src } = mk();
        const a = reg("a", r.signal(0)), b = reg("b", r.signal(0)), c = reg("c", r.signal(0)), d = reg("d", r.signal(0)), y = reg("y", r.signal(0)), s0 = reg("s", r.signal(0)), bp = reg("bp", r.signal(0));
        let on = false, thunk = null; const log = []; const nt = note(log);
        const X = reg("X", r.effect(() => { a(); if (on) { r.dispose(b); return; } y(); }, { scheduler: (t) => { thunk = t; } }));
        thunk();
        const Cp = reg("Cp", r.computed(() => { a(); if (on) r.dispose(bp); return 1; }));
        const C1 = reg("C1", r.computed(() => { a(); if (pre) { bp(); Cp(); } if (on) { try { thunk(); } catch (e) { nt(e); } } b(); c(); d(); return 1; }));
        const Ee = reg("E", r.effect(() => { s0(); C1(); }));
        const hs = [a, b, c, d, y, s0, bp, Cp, X, C1, Ee]; const before = { C1: src(C1), X: src(X), E: src(Ee) };
        on = true; arm("E"); let thrown = null; try { go(() => r.batch(() => { s0.set(1); a.set(1); })); } catch (e) { cap(e); thrown = e.constructor.name; }
        const o = { before, log, C1: src(C1), X: src(X), E: src(Ee) };
        on = false; arm(null); try { r.batch(() => { s0.set(2); a.set(2); }); } catch (e) { cap(e); o.thrown2 = e.constructor.name; }
        o.after = { C1: src(C1), X: src(X), E: src(Ee) };
        return fin(o, r, hs, thrown);
    }
    // S: C1 ends with a 2-link stale tail (w, w2); severStale's walk fires w's onDisconnect, which disposes b (a source of the
    // suspended COMPUTING frame E) and throws, so the walk is mid-way (live cursor = w2 link) at the restore.
    function S_() {
        const { r, reg, src } = mk();
        const a = reg("a", r.signal(0)), b = reg("b", r.signal(0)), c = reg("c", r.signal(0)), w = reg("w", r.signal(0)), w2 = reg("w2", r.signal(0)), bp = reg("bp", r.signal(0));
        let on = false; const log = []; const nt = note(log);
        r.observeObservers(w, { onDisconnect: () => { if (on) { r.dispose(b); throw new Error("hook"); } } });
        const Cp = reg("Cp", r.computed(() => { a(); if (on) r.dispose(bp); return 1; }));
        const C1 = reg("C1", r.computed(() => { a(); if (!on) { w(); w2(); } return 1; }));
        const E = reg("E", r.effect(() => { a(); if (pre) { bp(); Cp(); } try { C1(); } catch (e) { nt(e); } b(); c(); }));
        const hs = [a, b, c, w, w2, bp, Cp, C1, E]; const before = { C1: src(C1), E: src(E) };
        on = true; arm("S"); let thrown = null; try { go(() => a.set(1)); } catch (e) { cap(e); thrown = e.constructor.name; }
        const o = { before, log, C1: src(C1), E: src(E) };
        on = false; arm(null); try { a.set(2); } catch (e) { cap(e); o.thrown2 = e.constructor.name; }
        o.after = { C1: src(C1), E: src(E) };
        return fin(o, r, hs, thrown);
    }
    // Rd (dirty log): C2 disposes a source of the OUTER frame E (b2, E's cursor sits on it, saved in C1's frame); the planted
    // overflow at C2's restore leaves that entry above d in the log; C1's restore (d1) must still apply it to E's cursor.
    function Rd() {
        const { r, reg, src } = mk();
        const a = reg("a", r.signal(0)), b2 = reg("b2", r.signal(0)), c = reg("c", r.signal(0)), x = reg("x", r.signal(0)), s0 = reg("s", r.signal(0));
        let on = false; const log = []; const nt = note(log);
        const C2 = reg("C2", r.computed(() => { a(); if (on) { r.dispose(b2); return 1; } x(); return 1; }));
        const C1 = reg("C1", r.computed(() => { const v = a(); try { C2(); } catch (e) { nt(e); } return v; }));
        const E = reg("E", r.effect(() => { s0(); C1(); b2(); c(); }));
        const hs = [a, b2, c, x, s0, C1, C2, E]; const before = { C1: src(C1), C2: src(C2), E: src(E) };
        on = true; arm("R"); let thrown = null; try { go(() => r.batch(() => { s0.set(1); a.set(1); })); } catch (e) { cap(e); thrown = e.constructor.name; }
        const o = { before, log, C1: src(C1), C2: src(C2), E: src(E) };
        on = false; arm(null); try { r.batch(() => { s0.set(2); a.set(2); }); } catch (e) { cap(e); o.thrown2 = e.constructor.name; }
        o.after = { C1: src(C1), C2: src(C2), E: src(E) };
        return fin(o, r, hs, thrown);
    }
    return { R, E, S: S_, Rd };
}
