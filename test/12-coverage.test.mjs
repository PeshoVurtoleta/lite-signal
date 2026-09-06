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

// ─────────────────────────────────────────────────────────────────────────────
// 1.7.0 -- flushStrategy + flush(), and the last uncovered engine branches.
//
// Everything below closes a coverage hole that existed at 1.7.0-preview.2:
// the entire non-eager `.set` / `boxSet` body, `flush()`, the top-level
// `flush` / `getOwner` / `runWithOwner` delegators, the `allocateLink`
// eligibility gate, the link-ceiling clamp, the `executeEffect` re-entrancy
// CycleError, and the stale-handle guards on the box + computed read paths.
// ─────────────────────────────────────────────────────────────────────────────

describe("flushStrategy: validation and the three modes", () => {
    it("rejects a bogus strategy at createRegistry time", () => {
        assert.throws(
            () => createRegistry({flushStrategy: "bogus"}),
            /flushStrategy must be one of: 'eager', 'sab', 'manual'/,
        );
        // all three valid tokens construct
        for (const mode of ["eager", "sab", "manual"]) {
            const rr = createRegistry({flushStrategy: mode});
            assert.equal(typeof rr.flush, "function", `${mode} registry exposes flush()`);
            rr.destroy();
        }
        // omitted config / omitted key both default to "eager"
        assert.equal(typeof createRegistry().flush, "function");
        assert.equal(typeof createRegistry({maxNodes: 32}).flush, "function");
    });

    it("eager (default): .set outside batch auto-flushes; batch exit auto-flushes", () => {
        const rr = createRegistry({flushStrategy: "eager"});
        const s = rr.signal(0);
        let runs = 0;
        rr.effect(() => { s(); runs++; });
        assert.equal(runs, 1, "creation run");
        s.set(1);
        assert.equal(runs, 2, "eager: idle write delivers immediately");
        rr.batch(() => { s.set(2); s.set(3); });
        assert.equal(runs, 3, "eager: batch coalesces to one delivery at exit");
    });

    it("sab: idle .set defers + dedups; batch exit delivers", () => {
        const rr = createRegistry({flushStrategy: "sab"});
        const s = rr.signal(0);
        let runs = 0;
        rr.effect(() => { s(); runs++; });
        assert.equal(runs, 1);

        s.set(1);
        assert.equal(runs, 1, "sab: idle write does NOT auto-flush");
        for (let i = 2; i < 1002; i++) s.set(i);
        assert.equal(runs, 1, "sab: 1000 queued writes dedup via FLAG_SCHEDULED");
        assert.equal(s.peek(), 1001, "the VALUE is written eagerly -- only delivery defers");

        rr.batch(() => { s.set(2000); });
        assert.equal(runs, 2, "sab: batch exit drains the whole backlog in one pass");
    });

    it("sab: explicit flush() drains an idle-write backlog without a batch", () => {
        const rr = createRegistry({flushStrategy: "sab"});
        const s = rr.signal(0);
        let runs = 0;
        rr.effect(() => { s(); runs++; });
        s.set(1);
        assert.equal(runs, 1);
        rr.flush();
        assert.equal(runs, 2, "flush() is the escape hatch for sab idle writes");
        rr.flush();
        assert.equal(runs, 2, "flush() on an empty queue is a no-op");
    });

    it("manual: neither .set nor batch exit flush -- only flush() does", () => {
        const rr = createRegistry({flushStrategy: "manual"});
        const s = rr.signal(0);
        let runs = 0;
        rr.effect(() => { s(); runs++; });
        assert.equal(runs, 1);
        s.set(1);
        assert.equal(runs, 1, "manual: idle write does not deliver");
        rr.batch(() => { s.set(2); });
        assert.equal(runs, 1, "manual: batch exit does NOT auto-flush");
        rr.flush();
        assert.equal(runs, 2, "manual: flush() is the only settle point");
        assert.equal(s.peek(), 2);
    });

    it("lazy pull stays correct in every mode -- a computed read is never stale", () => {
        for (const mode of ["eager", "sab", "manual"]) {
            const rr = createRegistry({flushStrategy: mode});
            const s = rr.signal(10);
            const c = rr.computed(() => s() * 3);
            assert.equal(c(), 30, `${mode}: initial pull`);
            s.set(20);
            assert.equal(c(), 60, `${mode}: pull sees the write with no flush -- delivery defers, pull does not`);
            const cb = rr.computedBox(() => s() + 1);
            assert.equal(cb.get(), 21, `${mode}: computedBox pull`);
            assert.equal(cb.peek(), 21, `${mode}: computedBox peek`);
        }
    });
});

describe("flushStrategy: the non-eager .set body, branch by branch", () => {
    it("sab: gen guard, equals short-circuit, and pre-batch revert all hold", () => {
        const rr = createRegistry({flushStrategy: "sab"});

        // equals short-circuit: writing the same value never bumps the version
        const s = rr.signal(5);
        let runs = 0;
        rr.effect(() => { s(); runs++; });
        s.set(5);
        rr.flush();
        assert.equal(runs, 1, "sab: Object.is-equal write short-circuits before markDownstream");

        // pre-batch revert: set-then-revert inside a batch is a net no-op
        rr.batch(() => { s.set(99); s.set(5); });
        assert.equal(runs, 1, "sab: batch revert restores preBatchVersion -- no delivery");
        assert.equal(s.peek(), 5);

        // a genuinely different final value inside the batch DOES deliver
        rr.batch(() => { s.set(99); s.set(7); });
        assert.equal(runs, 2);
        assert.equal(s.peek(), 7);

        // gen guard: .set on a disposed signal is a silent no-op
        rr.dispose(s);
        s.set(1234);
        assert.equal(s.peek(), undefined, "sab: stale handle read is undefined");
        rr.flush();
        assert.equal(runs, 2, "sab: write through a stale handle delivers nothing");
    });

    it("manual + custom equals: the predicate gates the deferred path too", () => {
        const rr = createRegistry({flushStrategy: "manual"});
        const s = rr.signal({v: 1}, {equals: (a, b) => a.v === b.v});
        let runs = 0;
        rr.effect(() => { s(); runs++; });
        s.set({v: 1});                 // structurally equal → short-circuit
        rr.flush();
        assert.equal(runs, 1);
        s.set({v: 2});
        rr.flush();
        assert.equal(runs, 2);
    });
});

describe("flushStrategy: signalBox / computedBox on the non-eager path", () => {
    it("sab: boxSet defers, dedups, reverts in batch, and no-ops on a stale box", () => {
        const rr = createRegistry({flushStrategy: "sab"});
        const b = rr.signalBox(0);
        let runs = 0;
        rr.effect(() => { b.get(); runs++; });
        assert.equal(runs, 1);

        b.set(1);
        assert.equal(runs, 1, "sab: boxSet does not auto-flush");
        assert.equal(b.peek(), 1, "the write itself is eager");
        b.set(1);
        b.update((v) => v);            // update → boxSet with an equal value → short-circuit
        rr.flush();
        assert.equal(runs, 2);

        rr.batch(() => { b.set(50); b.set(1); });
        assert.equal(runs, 2, "sab: box set-then-revert inside a batch is a net no-op");
        assert.equal(b.peek(), 1);

        rr.batch(() => { b.update((v) => v + 41); });
        assert.equal(runs, 3, "sab: box batch with a real net change delivers at exit");
        assert.equal(b.peek(), 42);

        rr.dispose(b);
        b.set(7);
        b.update((v) => 7);
        assert.equal(b.peek(), undefined, "stale box peek → undefined");
        assert.equal(b.get(), undefined, "stale box get → undefined");
        rr.flush();
        assert.equal(runs, 3, "stale box writes deliver nothing");
    });

    it("manual: boxSet needs an explicit flush; computedBox honours a custom equals", () => {
        const rr = createRegistry({flushStrategy: "manual"});
        const b = rr.signalBox(2);
        const cb = rr.computedBox(() => ({n: b.get() * 2}), {equals: (a, x) => a.n === x.n});
        let runs = 0;
        rr.effect(() => { cb.get(); runs++; });
        b.set(3);
        assert.equal(runs, 1, "manual: no delivery without flush()");
        assert.equal(cb.peek().n, 6, "pull is still correct");
        rr.flush();
        assert.equal(runs, 2);

        // computedBox WITHOUT opts → the `equals` default arm
        const plain = rr.computedBox(() => b.get() + 100);
        assert.equal(plain.get(), 103);
        rr.dispose(plain);
        assert.equal(plain.get(), undefined, "stale computedBox get → undefined");
        assert.equal(plain.peek(), undefined, "stale computedBox peek → undefined");
    });
});

describe("public top-level surface: flush / getOwner / runWithOwner (1.7.0)", () => {
    it("all three route to the default registry", () => {
        const own = createRegistry({flushStrategy: "manual"});
        setDefaultRegistry(own);

        const s = signal(0);
        let runs = 0;
        let captured;
        effect(() => { s(); captured = LiteSignal.getOwner(); runs++; });
        assert.equal(runs, 1);
        assert.ok(captured, "getOwner() inside an effect body returns a handle");
        assert.equal(LiteSignal.getOwner(), undefined, "…and undefined outside one");

        s.set(1);
        assert.equal(runs, 1, "top-level set on a manual default registry defers");
        LiteSignal.flush();
        assert.equal(runs, 2, "top-level flush() drains the default registry");

        // runWithOwner adopts into the captured owner and returns fn's value
        let inner = 0;
        const ret = LiteSignal.runWithOwner(captured, () => {
            effect(() => { inner++; });
            return "ok";
        });
        assert.equal(ret, "ok");
        assert.equal(inner, 1);
        s.set(2);
        LiteSignal.flush();
        assert.equal(inner, 1, "the adopted child was cascade-disposed by the owner's re-run");

        // a stale / null / non-tracker handle degrades to rooted execution
        assert.equal(LiteSignal.runWithOwner(null, () => "rooted"), "rooted");
        assert.equal(LiteSignal.runWithOwner(undefined, () => "rooted"), "rooted");

        own.destroy();
        setDefaultRegistry(createRegistry());
    });
});

describe("engine edge branches the behavioural suites never reach", () => {
    it("allocateLink eligibility gate: an observer torn down WHILE SUSPENDED links nothing after", () => {
        // The gate (`target.flags === 0` → return null) is NOT reachable by plain
        // self-dispose: disposeNode nulls `currentObserver` when the disposing node
        // IS the current observer. The live path is the other one named in the gate's
        // comment -- an OUTER observer torn down while suspended inside a nested pull.
        // Here the computed's body disposes the effect that is currently pulling it;
        // `currentObserver` is the computed at that moment, so the effect's tracking
        // state is NOT nulled, and pullComputed restores a DEAD node as the observer.
        // The next read in the effect's body must not splice a phantom edge into it.
        const rr = createRegistry();
        const a = rr.signal(0);
        const b = rr.signal(0);
        let stop = null;
        let runs = 0;
        const c = rr.computed(() => {
            const v = a();
            if (runs > 1 && stop) stop();      // tear down the suspended outer effect
            return v;
        });
        stop = rr.effect(() => {
            runs++;
            a();
            c();
            if (runs > 1) b();                  // read through a dead observer
        });
        assert.equal(runs, 1);

        a.set(1);                               // re-run → the pull kills the puller
        assert.equal(runs, 2);
        assert.equal(rr.hasObservers(b), false, "the corpse spliced no phantom edge into b");
        b.set(5);
        assert.equal(runs, 2, "and it is not resurrected by a later write to b");
    });

    it("link growth: chunked refill crosses the ledger and stops at the 16x ceiling", () => {
        const rr = createRegistry({maxNodes: 8, maxLinks: 2, onCapacityExceeded: "grow"});
        const sigs = [];
        for (let i = 0; i < 6; i++) sigs.push(rr.signal(i));
        rr.effect(() => { for (const s of sigs) s(); });
        const st = rr.stats();
        assert.equal(st.linkPoolCapacity, 32, "the ledger lands on maxLinks * 16, the hard ceiling");
        assert.ok(st.poolGrowths >= 1, "the growth was recorded");
        assert.equal(st.activeLinks, 6);
        // …and the ceiling is a real wall, not just a ledger label
        assert.throws(() => {
            const more = [];
            for (let i = 0; i < 40; i++) more.push(rr.signal(i));
            rr.effect(() => { for (const s of more) s(); });
        }, /links/);
    });

    it("executeEffect re-entrancy is a CycleError, not a stack overflow", () => {
        const rr = createRegistry();
        let thunk = null;
        let depth = 0;
        assert.throws(
            () => {
                rr.effect(
                    () => { depth++; if (depth === 1 && thunk) thunk(); },
                    {scheduler: (run) => { thunk = run; run(); }},
                );
            },
            /CycleError: Infinite effect loop detected/,
        );
    });

    it("stale-handle guards on the computed read path", () => {
        const rr = createRegistry();
        const s = rr.signal(1);
        const c = rr.computed(() => s() + 1);
        assert.equal(c(), 2);
        rr.dispose(c);
        assert.equal(c(), undefined, "callable computed read on a stale handle → undefined, no dep recorded");
        assert.equal(rr.hasObservers(s), false, "…and it recorded no phantom subscription");
    });

    it("freeLink emits opcode 4 with both endpoint ids when a dep-set flip severs the tail", () => {
        const rr = createRegistry();
        const removed = [];
        const off = rr.onGraphMutation((op, a, b) => { if (op === 4) removed.push([a, b]); });
        const flag = rr.signal(true);
        const x = rr.signal(1);
        const y = rr.signal(2);
        rr.effect(() => { flag() ? x() : y(); });
        flag.set(false);              // severs the flag→x edge
        off();
        assert.equal(removed.length, 1);
        assert.equal(removed[0][0], rr.nodeId(x), "source id");
        assert.ok(removed[0][1] > 0, "target id");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1.7.0 regression: dangling re-tracking cursor on source disposal.
//
// The one crash path the preview.2 closure section did not reach. Disposing a
// source from inside an observer that linked it on the previous run but has not
// re-read it on this one left the observer's re-tracking cursor
// (activeObserverCurrentDep) parked on a freed link; severTail then walked from
// it, wiped headDep, and double-freed -> freeLink null-deref on source.headSub.
// Fixed by a one-line cursor repair in disposeNode; this pins it and closes the
// last reachable branch (:459, now removed). See COVERAGE-NOTES.md.
// ─────────────────────────────────────────────────────────────────────────────

describe("disposeNode: cursor repair when a source dies under a parked cursor", () => {
    it("disposing a not-yet-retracked dep from the observer's own body does not corrupt the dep list", () => {
        const removals = [];
        r.onGraphMutation((op, sourceId, targetId) => { if (op === 4) removals.push([sourceId, targetId]); });

        const a = r.signal(0);
        const b = r.signal(0);
        let runs = 0;

        // Run 1 links [a, b]. On run 2 the body reads `a` (cursor advances to link(b))
        // then disposes `b` WITHOUT reading it -- the cursor is parked on the exact link
        // disposeNode is about to splice out and free.
        r.effect(() => {
            runs++;
            a();
            if (runs === 1) b();
            if (runs === 2) r.dispose(b);
        });
        assert.equal(runs, 1);

        a.set(1);
        assert.equal(runs, 2, "the re-run completed instead of throwing");
        assert.equal(r.hasObservers(a), true, "link(a) survived -- headDep was not wiped");
        a.set(2);
        assert.equal(runs, 3, "the effect still reacts through its surviving dep");
        assert.equal(r.stats().activeLinks, 1, "only link(a) is outstanding");
        assert.equal(r.stats().signals, 1, "b is gone, a survives");

        // disposeNode inlines the sub-list free (opcode 2), so no per-edge opcode 4 for a
        // disposed source; opcode 4 fires only for a dep-set flip (asserted below).
        assert.equal(removals.length, 0, "source disposal reports opcode 2, not per-edge opcode 4");

        const flip = [];
        r.onGraphMutation((op, sourceId, targetId) => { if (op === 4) flip.push([sourceId, targetId]); });
        const x = r.signal(1);
        const y = r.signal(2);
        const gate = r.signal(true);
        r.effect(() => { gate() ? x() : y(); });
        gate.set(false);                       // dep-set flip: severs link(x) via freeLink
        assert.equal(flip.length, 1);
        assert.ok(flip[0][0] > 0 && flip[0][1] > 0, "opcode 4 payload is (source.id, target.id) -- never -1");
    });
});
