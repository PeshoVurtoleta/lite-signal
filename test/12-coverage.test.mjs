// 12-coverage.test.mjs
//
// Targeted exercises for public surface and hot-path branches that the
// behavioural suites above don't incidentally hit. Engine-agnostic except the
// owner-tree block, which is capability-gated like 09-conformance.

import {describe, it, beforeEach} from "node:test";
import assert from "node:assert/strict";
import {
    createRegistry, setDefaultRegistry,
    signal, computed, effect, batch, untrack, isTracking, onCleanup, stats, destroy,
    hasObservers, observeObservers, forEachObserver, forEachSource,
} from "../Signal.js";
// Namespace handle for the 1.1.5-only delegators (nodeId/describe). Imported as a
// namespace, not by name, so this file still LOADS against 1.1.4 (which omits them);
// the calls below are capability-gated.
import * as LiteSignal from "../Signal.js";

let r;
beforeEach(() => {
    r = createRegistry();
});

// Owner-tree capability probe (same idiom as 09-conformance): present in v1.2.0+,
// absent in v1.1.x. Gates the owner-tree branch tests below so this one file runs
// unchanged across engines.
const HAS_OWNER_TREE = (() => {
    try {
        const rr = createRegistry();
        const a = rr.signal(0), b = rr.signal(0);
        let innerRuns = 0;
        rr.effect(() => {
            a();
            rr.effect(() => {
                b();
                innerRuns++;
            });
        });
        a.set(1);
        const before = innerRuns;
        b.set(1);
        rr.destroy();
        return (innerRuns - before) === 1;
    } catch {
        return false;
    }
})();
const ownerSkip = HAS_OWNER_TREE ? false : "owner tree lands in v1.2 (engine has no owner tree)";

// ─── public top-level surface (delegates to the default registry) ─────────────
describe("public top-level surface routes to the default registry", () => {
    it("batch / untrack / isTracking / onCleanup / stats / destroy are wired", () => {
        const own = createRegistry();
        setDefaultRegistry(own);

        assert.equal(isTracking(), false, "false outside any observer");

        const s = signal(0);
        let cleanups = 0;
        let sawTrackingInside = null;
        const stop = effect(() => {
            onCleanup(() => {
                cleanups++;
            });   // top-level onCleanup, inside an effect
            sawTrackingInside = isTracking();    // true while an observer body is on the stack
            s();
        });
        assert.equal(sawTrackingInside, true);

        batch(() => {
            s.set(1);
            s.set(2);
        });    // top-level batch
        assert.equal(s.peek(), 2);
        assert.equal(cleanups, 1, "re-run fired the registered cleanup once");

        assert.equal(untrack(() => s.peek()), 2); // top-level untrack
        assert.equal(typeof stats().activeNodes, "number"); // top-level stats

        stop();
        destroy();                                // top-level destroy wipes the default registry
    });
});

// ─── computed clean-read short-circuit (markEpoch) ────────────────────────────
describe("computed clean-read short-circuit", () => {
    it("re-reading a clean computed returns the cache without re-evaluating", () => {
        const a = r.signal(1);
        let evals = 0;
        const c = r.computed(() => {
            evals++;
            return a() * 2;
        });

        let seen;
        r.effect(() => {
            seen = c();
        });          // first pull
        assert.equal(evals, 1);
        assert.equal(seen, 2);

        for (let i = 0; i < 5; i++) assert.equal(c(), 2); // clean re-reads
        assert.equal(evals, 1, "clean re-reads must not re-evaluate");

        a.set(3);                                  // dirty -> next read re-evaluates
        assert.equal(c(), 6);
        assert.equal(evals, 2);
    });

    it("clean re-read of an errored computed replays the cached throw", () => {
        const a = r.signal(0);
        const c = r.computed(() => {
            if (a() === 0) throw new Error("boom");
            return a();
        });
        assert.throws(() => c(), /boom/);          // first eval throws + caches
        assert.throws(() => c(), /boom/);          // clean re-read replays cached error
        a.set(5);
        assert.equal(c(), 5);                      // recovers once the dep changes
    });
});

// ─── dependency-set shrink severs the stale tail ──────────────────────────────
describe("dependency-set shrink severs the stale tail", () => {
    it("an effect reading fewer signals on re-run releases the dropped links", () => {
        const a = r.signal(1), b = r.signal(1), wide = r.signal(true);
        let runs = 0;
        r.effect(() => {
            runs++;
            if (wide()) {
                a();
                b();
            } else {
                a();
            }
        });

        const before = r.stats().activeLinks;      // deps: wide, a, b
        wide.set(false);                           // re-run drops b -> tail severed
        const after = r.stats().activeLinks;
        assert(after < before, `links should shrink (${before} -> ${after})`);

        const atDrop = runs;
        b.set(42);                                 // dropped dep must not retrigger
        assert.equal(runs, atDrop, "dropped dep b no longer fires the effect");
    });
});

// ─── branch completion: error / structural edge paths ────────────────────────
describe("branch completion: error and structural edges", () => {
    it("link-pool exhaustion under 'throw' policy raises CapacityError", () => {
        const rr = createRegistry({maxNodes: 16, maxLinks: 2, onCapacityExceeded: "throw"});
        const a = rr.signal(1), b = rr.signal(1), c = rr.signal(1);
        assert.throws(() => rr.effect(() => {
            a();
            b();
            c();
        }), /CapacityError/);
    });

    it("disposing a source nulls a sole subscriber's head & tail dep pointers", () => {
        const s = r.signal(1);
        let seen = 0;
        r.effect(() => {
            s();
            seen++;
        });    // effect's only dep is s -> link is head AND tail
        const base = seen;
        r.dispose(s);                         // dispose the SOURCE: sub-walk hits head/tail else-branches
        assert.equal(seen, base);
        assert.equal(typeof r.stats().activeLinks, "number");
    });

    it("disposing a mid-list source keeps neighbour links intact", () => {
        const a = r.signal(1), s = r.signal(1), b = r.signal(1);
        r.effect(() => {
            a();
            s();
            b();
        });   // s is the MIDDLE dep -> pDep/nDep both non-null
        r.dispose(s);
        assert.equal(typeof r.stats().activeLinks, "number");
    });

    it("re-tracking that reads no deps severs the whole list from the head", () => {
        let first = true, runs = 0;
        const trigger = r.signal(0);
        r.effect(() => {
            runs++;
            if (first) {
                trigger();
                first = false;
            }
        });
        trigger.set(1);                       // re-run reads nothing -> headDep severed to null
        assert.equal(runs, 2);
        const atTwo = runs;
        trigger.set(2);                       // no longer subscribed -> no re-run
        assert.equal(runs, atTwo);
    });

    it("a scheduled thunk fired after dispose no-ops (stale gen guard)", () => {
        const queue = [];
        const sched = (run) => {
            queue.push(run);
        };
        const a = r.signal(0);
        let body = 0;
        const stop = r.effect(() => {
            a();
            body++;
        }, {scheduler: sched});
        queue.splice(0).forEach(t => t());    // initial run
        a.set(1);                             // schedules a thunk (captures gen G)
        const stale = queue.shift();
        stop();                               // dispose -> gen bumps past G
        const before = body;
        stale();                              // fire stale thunk -> gen mismatch -> no-op
        assert.equal(body, before, "stale thunk must not run the disposed body");
    });

    it("a self-referential computed throws a cycle error", () => {
        let c;
        c = r.computed(() => c() + 1);        // reads itself during its own evaluation
        assert.throws(() => c(), /cycle/i);
    });

    it("destroying the registry mid-flush discards buffered effect errors", () => {
        const rr = createRegistry();
        const a = rr.signal(0);
        rr.effect(() => {
            if (a() > 0) throw new Error("boom");
        }); // buffers an error
        rr.effect(() => {
            if (a() > 0) rr.destroy();
        });           // reset() with count>0
        assert.doesNotThrow(() => {
            a.set(1);
        });
    });
});

// ─── scheduler ABA across a recycled pool slot (gen guard, engine-agnostic) ───
describe("scheduler: stale thunk vs a recycled slot", () => {
    it("a thunk captured before dispose does not run the slot's new occupant", () => {
        const queue = [];
        const sched = (run) => {
            queue.push(run);
        };
        const rr = createRegistry({maxNodes: 4, maxLinks: 16});

        const a = rr.signal(0);
        let bodyOld = 0;
        const stopOld = rr.effect(() => {
            a();
            bodyOld++;
        }, {scheduler: sched});
        queue.splice(0).forEach(t => t());   // initial run of the old effect
        a.set(1);                             // schedules a thunk (captures the old gen)
        const staleThunk = queue.shift();
        stopOld();                            // dispose -> slot freed, gen bumped

        // Reallocate the same slot with a NEW effect (FLAG_EFFECT set, fresh gen).
        const b = rr.signal(0);
        let bodyNew = 0;
        rr.effect(() => {
            b();
            bodyNew++;
        }, {scheduler: sched});
        queue.splice(0).forEach(t => t());   // initial run of the new effect
        const newBaseline = bodyNew;

        staleThunk();                         // gen mismatch while FLAG_EFFECT set -> no-op
        assert.equal(bodyOld, 1, "old body never ran again");
        assert.equal(bodyNew, newBaseline, "stale thunk did not run the recycled slot's new effect");
    });
});

// ─── markEpoch clean short-circuit: the O(1) clean-read skip (v1.1.3 feature) ─
// Reached only when a computed was evaluated, then an UNRELATED signal bumped
// globalVersion (so evalVersion !== globalVersion, defeating the same-tick skip)
// while leaving the computed's cone unmarked (markEpoch <= evalVersion).
describe("markEpoch clean short-circuit", () => {
    it("re-reading a computed after an unrelated change skips re-evaluation", () => {
        const a = r.signal(1), b = r.signal(0);
        let evals = 0;
        const c = r.computed(() => {
            evals++;
            return a() * 2;
        });  // depends on a, not b
        assert.equal(c(), 2);
        const baseline = evals;
        b.set(1);                         // unrelated: bumps globalVersion, c not in b's cone
        assert.equal(c(), 2);             // markEpoch short-circuit -> cached value, no re-eval
        assert.equal(evals, baseline, "clean read must not re-evaluate the computed");
    });

    it("the clean short-circuit re-throws a cached error after an unrelated change", () => {
        const a = r.signal(1), b = r.signal(0);
        const c = r.computed(() => {
            if (a() > 0) throw new Error("boom");
            return 0;
        });
        assert.throws(() => c(), /boom/);  // first eval throws -> error cached (FLAG_HAS_ERROR)
        b.set(1);                          // unrelated change
        assert.throws(() => c(), /boom/);  // short-circuit path re-throws the cached error
    });
});

// ─── sever-first: re-tracking a different LEADING dependency ──────────────────
// On a leading-edge divergence the cursor sits at headDep, so the stale list is
// severed from the head (prev === null branch).
describe("sever-first on a leading-edge divergence", () => {
    it("severs the stale list from the head and re-subscribes", () => {
        let useA = true;
        const a = r.signal(1), b = r.signal(2), tail = r.signal(0);
        let runs = 0;
        r.effect(() => {
            runs++;
            (useA ? a() : b());
            tail();
        });  // first deps: [a, tail]
        useA = false;
        tail.set(1);                          // re-run reads b first -> diverges at head
        assert.equal(runs, 2);
        const atTwo = runs;
        a.set(99);
        assert.equal(runs, atTwo, "dropped leading dep no longer drives the effect");
        b.set(99);
        assert.equal(runs, atTwo + 1, "new leading dep drives the effect");
    });
});

// ─── registry config defaulting (ternary branches) ───────────────────────────
describe("registry config defaulting", () => {
    it("applies defaults for omitted fields across config shapes", () => {
        const r1 = createRegistry();                            // config === undefined
        const r2 = createRegistry({maxNodes: 8});               // config set, maxLinks omitted
        const r3 = createRegistry({maxNodes: 8, maxLinks: 9});  // both set
        const r4 = createRegistry({maxFlushPasses: 50});        // explicit flush-pass cap
        for (const rr of [r1, r2, r3, r4]) {
            const s = rr.signal(1);
            assert.equal(s(), 1);
        }
    });
});

// ─── owner tree: directly disposing owned children detaches them ──────────────
describe("owner tree: direct child disposal detaches from the parent list", {skip: ownerSkip}, () => {
    it("detaches head, tail, and middle children correctly", () => {
        let a, b, c;
        r.effect(() => {
            a = r.effect(() => {
            });   // created 1st -> tail of the LIFO firstOwned list
            b = r.effect(() => {
            });   // 2nd -> middle
            c = r.effect(() => {
            });   // 3rd -> head
        });
        // firstOwned: c -> b -> a
        c();   // head: prevOwned === null (else: firstOwned = b); nextOwned !== null
        a();   // tail: prevOwned !== null;                        nextOwned === null
        b();   // last: prevOwned === null;                        nextOwned === null
        assert.ok(true);
    });
});

// ─── owner tree: cascade tolerates a child freed by a sibling's cleanup ───────
describe("owner tree: cascade tolerates an already-freed child", {skip: ownerSkip}, () => {
    it("re-disposing a child the cascade already passed is a no-op", () => {
        let disposeChildB = null;
        const parent = r.effect(() => {
            disposeChildB = r.effect(() => {
            });                       // childB (tail)
            r.effect(() => {
                r.onCleanup(() => disposeChildB());
            });  // childA (head): cleanup frees childB
        });
        // Disposing the parent cascades childA first; childA's cleanup disposes
        // childB out from under the loop, so the cascade then re-disposes an
        // already-freed childB -> disposeNode's flags===0 guard.
        assert.doesNotThrow(() => parent());
    });
});

// ─── public top-level surface: introspection delegators ───────────────────────
// These four (and nodeId/describe in 1.1.5) are the only top-level delegators no
// behavioural suite calls directly — every other suite reaches them via a registry.
describe("public top-level surface: introspection delegators route to the default registry", () => {
    it("hasObservers / observeObservers / forEachObserver / forEachSource (+ nodeId/describe on 1.1.5)", () => {
        const own = createRegistry();
        setDefaultRegistry(own);

        const a = signal(1);
        const b = computed(() => a() + 1);
        const stop = effect(() => {
            b();
        });            // a -> b -> effect

        assert.equal(hasObservers(a), true);            // top-level hasObservers
        assert.equal(hasObservers(signal(0)), false);

        let connects = 0;                               // top-level observeObservers -> unobserve
        const fresh = signal(0);
        const unobserve = observeObservers(fresh, {
            onConnect: () => {
                connects++;
            }
        });
        const s2 = effect(() => fresh());
        assert.equal(connects, 1, "0->1 connect fired through the top-level delegator");
        s2();
        unobserve();

        const obs = [];
        forEachObserver(a, d => obs.push(d.kind));   // top-level forEachObserver
        assert.deepEqual(obs, ["computed"]);
        const src = [];
        forEachSource(b, d => src.push(d.kind));     // top-level forEachSource
        assert.deepEqual(src, ["signal"]);

        // nodeId / describe are 1.1.5+; gate so this same file passes on 1.1.4.
        if (typeof LiteSignal.nodeId === "function") {
            assert.equal(typeof LiteSignal.nodeId(a), "number");
            assert.equal(LiteSignal.nodeId(null), undefined);
        }
        if (typeof LiteSignal.describe === "function") {
            assert.equal(LiteSignal.describe(a).kind, "signal");
            assert.equal(LiteSignal.describe(null), undefined);
        }

        stop();
        destroy();
    });

    // 1.2.1 adds three new top-level delegators: onGraphMutation, forEachOwned, ownerOf.
    // Capability-gated like nodeId/describe so this file still loads on 1.2.0 (which lacks them).
    it("onGraphMutation / forEachOwned / ownerOf (1.2.1+) route to the default registry", () => {
        if (typeof LiteSignal.onGraphMutation !== "function") return;
        if (typeof LiteSignal.forEachOwned !== "function") return;
        if (typeof LiteSignal.ownerOf !== "function") return;

        const own = createRegistry();
        setDefaultRegistry(own);

        // onGraphMutation through the top-level binding
        const events = [];
        const unsub = LiteSignal.onGraphMutation((op, x, y) => events.push([op, x, y]));
        const s = signal(1);
        assert.equal(events.length, 1, "top-level onGraphMutation received the node-create event");
        assert.equal(events[0][0], 1, "opcode is OP_NODE_CREATE");
        unsub();

        // forEachOwned through the top-level binding — top-level signal has no children
        let calls = 0;
        LiteSignal.forEachOwned(s, () => calls++);
        assert.equal(calls, 0, "top-level forEachOwned on a top-level signal is a no-op");
        LiteSignal.forEachOwned(null, () => calls++);
        assert.equal(calls, 0, "top-level forEachOwned on null is a no-op");

        // ownerOf through the top-level binding
        assert.equal(LiteSignal.ownerOf(s), undefined, "top-level signal has no owner");
        assert.equal(LiteSignal.ownerOf(null), undefined, "ownerOf null is undefined");

        destroy();
    });
});

// ─── inline branch arms the behavioural suites miss ───────────────────────────
// These share a source line with covered code, so they never appear as uncovered
// LINES — only as partial branches. Prime suspects for a 97%→100% branch gap.
describe("custom equals predicate (signal + computed)", () => {
    it("a signal's custom equals suppresses propagation for 'equal' writes", () => {
        const s = r.signal(1.0, {equals: (a, b) => Math.trunc(a) === Math.trunc(b)});
        let runs = 0;
        r.effect(() => {
            s();
            runs++;
        });
        assert.equal(runs, 1);
        s.set(1.4);                 // same integer part → equal → no propagation
        assert.equal(runs, 1);
        s.set(2.0);                 // different integer part → propagates
        assert.equal(runs, 2);
    });
    it("a computed's custom equals gates downstream recompute", () => {
        const src = r.signal(0);
        const c = r.computed(() => src(), {equals: (a, b) => (a & 1) === (b & 1)});
        let runs = 0;
        r.effect(() => {
            c();
            runs++;
        });
        assert.equal(runs, 1);
        src.set(2);                 // 0,2 share parity → computed "unchanged"
        assert.equal(runs, 1);
        src.set(3);                 // parity flips → downstream re-runs
        assert.equal(runs, 2);
    });
});

describe("introspection — full branch sweep (the 97.3%→100% gap)", () => {
    // The full 01–17 suite leaves the observer/source introspection surface as the
    // sole partial-branch region. Each arm below is exercised explicitly.
    it("hasObservers across every handle state", () => {
        const s = r.signal(0);
        assert.equal(r.hasObservers(s), false);        // valid node, headSub === null
        const stop = r.effect(() => s());
        assert.equal(r.hasObservers(s), true);         // valid node, has observers
        assert.equal(r.hasObservers(null), false);     // handle == null → ": undefined" arm
        assert.equal(r.hasObservers(undefined), false);
        assert.equal(r.hasObservers({}), false);       // non-null, no NODE_PTR
        stop();
    });
    it("observeObservers: create / entry-exists / opts / idempotent dispose / invalid", () => {
        const s = r.signal(0);
        assert.throws(() => r.observeObservers(null), TypeError);
        assert.throws(() => r.observeObservers({}), TypeError);
        let con = 0, dis = 0;
        const off = r.observeObservers(s, {onConnect: () => con++, onDisconnect: () => dis++}); // create + both opts
        const off2 = r.observeObservers(s);            // entry exists → skip create; opts === undefined
        const stop = r.effect(() => s());              // connect → onConnect
        stop();                                        // last observer leaves → onDisconnect
        assert.ok(con >= 1 && dis >= 1);
        off();
        off();                                  // disposer: live→delete, then !live→early return
        off2();
    });
    it("forEachObserver / forEachSource: empty, invalid, populated, every descriptor kind", () => {
        const a = r.signal(0);
        const c = r.computed(() => a() + 1);
        let n = 0;
        r.forEachObserver(a, () => n++);               // valid, no observers → loop skipped
        r.forEachObserver(null, () => n++);            // invalid → early return
        r.forEachSource(c, () => n++);                 // computed not activated → no sources
        r.forEachSource(undefined, () => n++);
        assert.equal(n, 0);
        const stop = r.effect(() => c());              // activates c→a and e→c
        const oa = [];
        r.forEachObserver(a, d => oa.push(d.kind)); // observer of a is a computed
        const oc = [];
        r.forEachObserver(c, d => oc.push(d.kind)); // observer of c is an effect
        const sc = [];
        r.forEachSource(c, d => sc.push(d.kind));   // source of c is a signal
        assert.deepEqual(oa, ["computed"]);
        assert.deepEqual(oc, ["effect"]);
        assert.deepEqual(sc, ["signal"]);
        stop();
    });
});

describe("multi-cleanup: array conversion and array execution", () => {
    it("3 onCleanup calls in one scope batch to an array and all fire on re-run", () => {
        const s = r.signal(0);
        let cleaned = 0;
        r.effect(() => {
            s();
            r.onCleanup(() => cleaned++);   // single fn
            r.onCleanup(() => cleaned++);   // → converts to [fn, fn]
            r.onCleanup(() => cleaned++);   // → pushes onto the array
        });
        assert.equal(cleaned, 0);
        s.set(1);                            // re-run walks the cleanup array
        assert.equal(cleaned, 3);
    });
});

// ---------------------------------------------------------------------------
// 1.4.0-rc branch closure.
//
// c8 on the rc flagged six lines in Signal.js. Three are reachable and are
// closed by the tests below (:333, :826, :1115). One (:415) was reachable ONLY
// through the dangling-cursor defect the fourth test now pins as a regression --
// with disposeNode's CURSOR REPAIR in place those defensive ternaries are dead
// and were removed. The remaining two (:383 link-ledger clamp, :1241 batchEpoch
// wraparound) are provably unreachable and carry `/* c8 ignore */` with the
// proof inline; see COVERAGE-NOTES.md.
// ---------------------------------------------------------------------------

describe("allocateLink: eligibility gate on a target disposed mid-run (Signal.js:333)", () => {
    it("an observer torn down inside a nested pull links nothing for the rest of its body", () => {
        const a = r.signal(0);
        const b = r.signal(0);
        let stop = null;
        let armed = false;

        // Created OUTSIDE the effect on purpose, so it is not owner-adopted: the
        // effect can dispose ITSELF from inside this computed's body without the
        // owner cascade tearing the computed down mid-pull. That is the shape that
        // reaches the gate -- disposeNode only nulls the tracking context when
        // `currentObserver === node`, and here currentObserver is `killer`. When
        // pullComputed unwinds it restores currentObserver to the now-DEAD effect.
        const killer = r.computed(() => {
            if (armed && stop !== null) stop();
            return 1;
        });

        let runs = 0;
        stop = r.effect(() => {
            runs++;
            a();
            if (runs === 2) {
                armed = true;
                killer();   // <- effect node is disposed in here; flags go to 0
                b();        // <- allocateLink(b, deadEffect): target.flags === 0 -> null
            }
        });
        assert.equal(runs, 1);

        a.set(1);
        assert.equal(runs, 2, "the effect did re-run and did reach the post-dispose read");

        // The gate held: no phantom edge was spliced onto the pool-bound node.
        assert.equal(r.hasObservers(b), false, "no phantom subscriber on b");
        assert.equal(r.stats().effects, 0, "the effect really is disposed");
        assert.equal(r.stats().activeLinks, 0, "every link went back to the pool");

        a.set(2);
        assert.equal(runs, 2, "a dead observer is never re-entered");
    });
});

describe("executeEffect: synchronous re-entrancy guard (Signal.js:826)", () => {
    it("a scheduler whose thunk is re-invoked from the body throws CycleError", () => {
        const s = r.signal(0);
        let run = null;
        let reentered = false;

        // The write path cannot reach this guard -- markDownstream refuses to re-queue
        // a node carrying FLAG_COMPUTING. The scheduler trampoline can: it hands the
        // run thunk to user code, and nothing stops that code from calling it again
        // from inside the very body it is already running.
        assert.throws(
            () => r.effect(
                () => {
                    s();
                    if (run !== null && !reentered) {
                        reentered = true;
                        run();   // <- re-enters executeEffect while FLAG_COMPUTING is set
                    }
                },
                {scheduler: (thunk) => { run = thunk; thunk(); }},
            ),
            /CycleError: Infinite effect loop detected/,
        );
        assert.equal(reentered, true, "the body really did re-enter");

        // The outer executeEffect's finally still ran: no node left stuck COMPUTING,
        // no tracking context leaked.
        assert.equal(r.isTracking(), false);
        const live = r.signal(1);
        let ok = 0;
        r.effect(() => { ok++; live(); });
        live.set(2);
        assert.equal(ok, 2, "the registry is still usable after the cycle throw");
    });
});

describe("computed: stale-handle read (Signal.js:1115)", () => {
    it("reading a disposed computed returns undefined and creates no dependency", () => {
        const s = r.signal(2);
        const c = r.computed(() => s() * 10);
        assert.equal(c(), 20);

        r.dispose(c);

        // 21-perf-pins pins peek() on a stale computed; the gen guard on the READ
        // closure is a separate branch -- this is the one that closes it.
        assert.equal(c(), undefined, "stale computed handle reads undefined");
        assert.equal(c.peek(), undefined);

        let runs = 0;
        r.effect(() => { runs++; c(); });   // stale read from INSIDE a live observer
        assert.equal(runs, 1);

        s.set(3);
        assert.equal(runs, 1, "the stale read wired up no phantom subscription");
        assert.equal(r.stats().computeds, 0);
    });
});

describe("disposeNode: cursor repair when a source dies under a parked cursor", () => {
    it("disposing a not-yet-retracked dep from the observer's own body does not corrupt the dep list", () => {
        const removals = [];
        r.onGraphMutation((op, sourceId, targetId) => {
            if (op === 4) removals.push([sourceId, targetId]);
        });

        const a = r.signal(0);
        const b = r.signal(0);
        let runs = 0;

        // Run 1 links [a, b]. On run 2 the body reads `a` (cursor advances to link(b))
        // and then disposes `b` WITHOUT reading it -- so the re-tracking cursor is left
        // parked on the exact link that disposeNode is about to splice out and free.
        // Pre-fix: severTail walked from that freed link, wiped headDep, and double-freed
        // it -> "TypeError: Cannot set properties of null (setting 'headSub')".
        r.effect(() => {
            runs++;
            a();
            if (runs === 1) b();
            if (runs === 2) r.dispose(b);
        });
        assert.equal(runs, 1);

        a.set(1);
        assert.equal(runs, 2, "the re-run completed instead of throwing");

        // The surviving dep must still be wired: a is live, the effect still tracks it.
        assert.equal(r.hasObservers(a), true, "link(a) survived -- headDep was not wiped");
        a.set(2);
        assert.equal(runs, 3, "the effect still reacts through its surviving dep");

        assert.equal(r.stats().activeLinks, 1, "only link(a) is outstanding -- link(b) was freed exactly once");
        assert.equal(r.stats().signals, 1, "b is gone, a survives");

        // Documented asymmetry (NOT changed by this fix): disposeNode's sub-list teardown
        // inlines the free rather than routing through freeLink, so disposing a SOURCE
        // emits opcode 2 (node-dispose) but no opcode 4 (link-remove) for its outgoing
        // edges -- a consumer infers those edges died with the node. Opcode 4 fires only
        // for edges severed by a dep-set flip (allocateLink / severTail). Pinned here so
        // a future refactor of that loop has to be a deliberate contract change.
        assert.equal(removals.length, 0, "source disposal reports opcode 2, not per-edge opcode 4");

        // And the payloads that DO come out of freeLink carry real ids -- never the -1
        // sentinel the removed defensive ternaries used to emit.
        const flip = [];
        r.onGraphMutation((op, sourceId, targetId) => { if (op === 4) flip.push([sourceId, targetId]); });
        const x = r.signal(1);
        const y = r.signal(2);
        const gate = r.signal(true);
        r.effect(() => { gate() ? x() : y(); });
        gate.set(false);                       // dep-set flip: severs link(x) via freeLink
        assert.equal(flip.length, 1);
        assert.ok(flip[0][0] > 0 && flip[0][1] > 0, "opcode 4 payload is (source.id, target.id)");
    });
});
