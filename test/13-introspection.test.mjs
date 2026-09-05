// 13-introspection.test.mjs — observer-lifecycle surface (1.1.5)
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../Signal.js";

let r;
beforeEach(() => { r = createRegistry(); });

describe("hasObservers", () => {
    it("reflects live observation: false → true → false", () => {
        const s = r.signal(0);
        assert.equal(r.hasObservers(s), false);
        const w = r.effect(() => s());
        assert.equal(r.hasObservers(s), true);
        w();
        assert.equal(r.hasObservers(s), false);
    });
    it("a peek does not count as an observer", () => {
        const s = r.signal(0);
        const w = r.effect(() => { s.peek(); });
        assert.equal(r.hasObservers(s), false);
        w();
    });
});

describe("observeObservers — auto-pause lifecycle", () => {
    it("source starts on first observer, stops on last (lite-time pattern)", () => {
        const now = r.signal(0);
        let running = false, starts = 0, stops = 0;
        const un = r.observeObservers(now, {
            onConnect: () => { running = true; starts++; },
            onDisconnect: () => { running = false; stops++; },
        });
        assert.equal(running, false);
        const w1 = r.effect(() => now());
        assert.equal(running, true); assert.equal(starts, 1);
        const w2 = r.effect(() => now());
        assert.equal(starts, 1, "no extra connect for 2nd observer");
        w1();
        assert.equal(running, true); assert.equal(stops, 0, "still observed");
        w2();
        assert.equal(running, false); assert.equal(stops, 1);
        un();
    });
    it("re-observation after full disconnect fires connect again", () => {
        const now = r.signal(0);
        let conn = 0, disc = 0;
        const un = r.observeObservers(now, { onConnect: () => conn++, onDisconnect: () => disc++ });
        const w1 = r.effect(() => now()); w1();
        const w2 = r.effect(() => now()); w2();
        assert.equal(conn, 2); assert.equal(disc, 2);
        un();
    });
    it("re-tracking does NOT churn for a persistently-read source", () => {
        const t = r.signal(0), other = r.signal(0);
        let conn = 0, disc = 0;
        const un = r.observeObservers(t, { onConnect: () => conn++, onDisconnect: () => disc++ });
        const w = r.effect(() => { t(); other(); });
        assert.equal(conn, 1);
        other.set(1); other.set(2);            // effect re-runs, still reads t
        assert.equal(conn, 1, "no spurious reconnect on re-track");
        assert.equal(disc, 0, "no spurious disconnect on re-track");
        w();
        assert.equal(disc, 1);
        un();
    });
    it("conditional reads toggle connect/disconnect honestly", () => {
        const gate = r.signal(true), t = r.signal(0);
        let conn = 0, disc = 0;
        const un = r.observeObservers(t, { onConnect: () => conn++, onDisconnect: () => disc++ });
        const w = r.effect(() => { if (gate()) t(); });   // reads t only when gate
        assert.equal(conn, 1);
        gate.set(false);                                   // stops reading t
        assert.equal(disc, 1);
        gate.set(true);                                    // reads t again
        assert.equal(conn, 2);
        w(); un();
    });
    it("unobserve stops callbacks; registering while already observed does not fire", () => {
        const s = r.signal(0);
        let conn = 0;
        const un = r.observeObservers(s, { onConnect: () => conn++ });
        un();
        const w = r.effect(() => s());
        assert.equal(conn, 0, "no callback after unobserve");
        w();
        const w2 = r.effect(() => s());        // observed first
        let conn2 = 0;
        const un2 = r.observeObservers(s, { onConnect: () => conn2++ });
        assert.equal(conn2, 0, "transition-only: no immediate fire when already observed");
        assert.equal(r.hasObservers(s), true);
        w2(); un2();
    });
    it("works for computeds too (pause an expensive projection when unobserved)", () => {
        const a = r.signal(0);
        const c = r.computed(() => a() * 2);
        let conn = 0, disc = 0;
        const un = r.observeObservers(c, { onConnect: () => conn++, onDisconnect: () => disc++ });
        const w = r.effect(() => c());
        assert.equal(conn, 1);
        w();
        assert.equal(disc, 1);
        un();
    });
});

describe("forEachObserver / forEachSource enumeration", () => {
    it("walks the dependency graph in both directions", () => {
        const a = r.signal(1), b = r.signal(2);
        const sum = r.computed(() => a() + b());
        const w = r.effect(() => sum());
        const aObs = []; r.forEachObserver(a, d => aObs.push(d.kind));
        assert.deepEqual(aObs, ["computed"]);
        const sumSrc = []; r.forEachSource(sum, d => sumSrc.push(d.kind));
        assert.deepEqual(sumSrc, ["signal", "signal"]);
        const sumObs = []; r.forEachObserver(sum, d => sumObs.push(d.kind));
        assert.deepEqual(sumObs, ["effect"]);
        w();
    });
    it("descriptor carries kind and current value", () => {
        const s = r.signal(42);
        const c = r.computed(() => s() + 1);
        const e = r.effect(() => c());
        let sigKind, sigVal;
        r.forEachSource(c, d => { sigKind = d.kind; sigVal = d.value; });
        assert.equal(sigKind, "signal");
        assert.equal(sigVal, 42);
        e();
    });
});
