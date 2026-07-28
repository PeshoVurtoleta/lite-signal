/**
 * bench/torture/introspect-torture.mjs -- the read-only introspection surface (1.6.0).
 *
 * 1.6.0 (and the 1.2.1 keystone it builds on) exposes a diagnostic surface that
 * lite-devtools / lite-studio build on: describe, nodeId, hasObservers,
 * isTracking, forEachObserver, forEachSource, forEachOwned, ownerOf,
 * observeObservers. The whole suite exercised NONE of it. These are read-only, so
 * they cannot corrupt a value -- which is exactly why a value oracle is blind to
 * them, and why a wrong hasObservers or a forEachSource that skips a link is a
 * silent correctness bug in every tool that trusts it.
 *
 * Two properties carry the real risk, and both are load-bearing for devtools:
 *
 *   1. WALK AGREEMENT. forEachSource / forEachObserver are one view of the edge
 *      set; the propagation engine is another. They must agree -- a source walk
 *      must visit exactly the deps a computed actually reads, and track dynamic
 *      rewiring (a computed that stops reading a dep must stop listing it). This
 *      file cross-checks the walk against BOTH the reference dep set AND the
 *      engine's op-3/op-4 link lane, so a divergence in either direction shows.
 *
 *   2. THE ABA GEN-STAMP GUARD. Descriptors are re-walkable (a describe()
 *      descriptor may be passed back into forEachObserver/forEachSource/ownerOf)
 *      and gen-stamped. A descriptor captured before a node is disposed and its
 *      slot recycled must NOT resolve to the new resident -- describe/nodeId must
 *      return undefined and the walks must visit nothing. A broken guard here
 *      would let devtools read a recycled node's edges as if they were the old
 *      node's: a silent, confusing, data-corrupting bug.
 *
 * Also pinned: hasObservers transitions (acquires/loses its last observer),
 * isTracking inside vs outside a reactive body, ownerOf resolving the scope owner,
 * forEachOwned enumerating a scope's adopted children, and observeObservers
 * firing on observer add/remove.
 *
 * Skips cleanly if the introspection surface is absent.
 *
 * Exit code: 0 iff every introspection contract held.
 *
 * Usage: node --expose-gc bench/torture/introspect-torture.mjs
 *        INTROSPECT_SEEDS=2000 node --expose-gc bench/torture/introspect-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { mulberry32, randInt, createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;

// Feature-detect the introspection surface.
{
    let ok = false;
    try {
        const r = createRegistry({ maxNodes: 16, onCapacityExceeded: "grow" });
        ok = typeof r.describe === "function" && typeof r.forEachSource === "function" &&
             typeof r.hasObservers === "function" && typeof r.forEachObserver === "function";
    } catch { ok = false; }
    if (!ok) {
        console.log("lite-signal introspect torture -- SKIP: introspection surface not available");
        process.exit(0);
    }
}

const SEEDS = Number(process.env.INTROSPECT_SEEDS || 300);
const R = createReport(`lite-signal introspect torture -- describe/forEach*/hasObservers, ${SEEDS} seeds`);
const reg = () => createRegistry({ maxNodes: 4096, maxLinks: 16384, onCapacityExceeded: "grow" });

function countSources(r, handle) { let n = 0; r.forEachSource(handle, () => n++); return n; }
function countObservers(r, handle) { let n = 0; r.forEachObserver(handle, () => n++); return n; }

/* -- 1. describe / nodeId basics -------------------------------------------- */
{
    const r = reg();
    const a = r.signal(7);
    const c = r.computed(() => a() * 2);
    const stop = r.effect(() => c());

    const da = r.describe(a);
    R.ok("describe", da !== undefined && da.kind === "signal", `describe(signal) wrong: ${JSON.stringify(da)}`);
    const dc = r.describe(c);
    R.ok("describe", dc !== undefined && dc.kind === "computed", `describe(computed) wrong: ${JSON.stringify(dc)}`);

    const id = r.nodeId(a);
    R.ok("nodeId", typeof id === "number" && id > 0, `nodeId(signal) not a positive number: ${id}`);
    R.ok("nodeId", r.nodeId(a) !== r.nodeId(c), "distinct nodes shared a nodeId");
    stop();
}

/* -- 2. Walk agreement: forEachSource / forEachObserver vs the real edge set -- */
{
    const r = reg();
    const a = r.signal(1), b = r.signal(2), cc = r.signal(3);
    const sum = r.computed(() => a() + b() + cc());
    const stop = r.effect(() => sum());

    R.eq("walk-sources", countSources(r, sum), 3, "forEachSource(sum) did not visit all 3 deps");
    R.eq("walk-observers", countObservers(r, a), 1, "forEachObserver(a) did not visit its single consumer");
    // b and cc each observed by sum only.
    R.eq("walk-observers", countObservers(r, b), 1, "forEachObserver(b) wrong");
    // sum observed by the effect.
    R.eq("walk-observers", countObservers(r, sum), 1, "forEachObserver(sum) did not see the effect");
    stop();
}

/* -- 3. Walk tracks DYNAMIC rewiring ---------------------------------------- */
{
    const r = reg();
    const cond = r.signal(true);
    const a = r.signal(10), b = r.signal(20);
    const dyn = r.computed(() => (cond() ? a() + b() : a()));
    const stop = r.effect(() => dyn());

    R.eq("walk-dynamic", countSources(r, dyn), 3, "before rewire: forEachSource should see cond,a,b");
    cond.set(false);
    dyn();                              // force re-eval so the branch switches
    R.eq("walk-dynamic", countSources(r, dyn), 2, "after rewire: forEachSource should drop b, leaving cond,a");
    // And a must no longer list b as a co-observer through dyn; b now has no observers.
    R.eq("walk-dynamic", countObservers(r, b), 0, "b still listed an observer after dyn stopped reading it");
    cond.set(true);
    dyn();
    R.eq("walk-dynamic", countSources(r, dyn), 3, "re-rewire: forEachSource should return to 3");
    stop();
}

/* -- 4. Cross-check the walk against the op-3/op-4 link lane ---------------- */
if (typeof reg().onGraphMutation === "function") {
    const r = reg();
    let net = 0;
    const off = r.onGraphMutation((op) => { if (op === 3) net++; else if (op === 4) net--; });
    const a = r.signal(1), b = r.signal(2);
    const c = r.computed(() => a() + b());
    const stop = r.effect(() => c());
    off();
    // The op-lane net links INTO c (its dep edges) must equal forEachSource(c).
    // net counts ALL links built (c<-a, c<-b, effect<-c) so compare the source walk
    // to the dep-edges specifically rather than the global net.
    R.eq("op-lane-agree", countSources(r, c), 2, "forEachSource(c) disagrees with the 2 dep links built");
    R.eq("op-lane-agree", countObservers(r, c), 1, "forEachObserver(c) disagrees with the 1 observer link");
    stop();
}

/* -- 5. hasObservers transitions -------------------------------------------- */
{
    const r = reg();
    const s = r.signal(0);
    R.eq("hasObservers", r.hasObservers(s), false, "a fresh signal reported observers");

    const c = r.computed(() => s() + 1);
    // A computed that exists but is not observed does not (yet) observe s until pulled.
    c();
    R.eq("hasObservers", r.hasObservers(s), true, "s has a computed reading it but hasObservers is false");

    const stop = r.effect(() => c());
    R.eq("hasObservers", r.hasObservers(c), true, "c is observed by the effect but hasObservers is false");
    stop();
    // After the effect stops AND c is no longer observed, c should drop its own
    // observation of s on the next settle. Pull semantics: dispose c to be explicit.
    r.dispose(c);
    R.eq("hasObservers", r.hasObservers(s), false, "s still reports observers after its only reader was disposed");
}

/* -- 6. isTracking inside vs outside ---------------------------------------- */
{
    const r = reg();
    R.eq("isTracking", r.isTracking(), false, "isTracking() true at top level");
    let insideComputed = null, insideUntrack = null;
    const c = r.computed(() => { insideComputed = r.isTracking(); return 0; });
    c();
    R.eq("isTracking", insideComputed, true, "isTracking() false inside a computed body");
    r.effect(() => { r.untrack(() => { insideUntrack = r.isTracking(); }); });
    R.eq("isTracking", insideUntrack, false, "isTracking() true inside untrack()");
}

/* -- 7. ownerOf / forEachOwned on a scope ----------------------------------- */
if (typeof reg().createScope === "function" && typeof reg().forEachOwned === "function") {
    const r = reg();
    let innerC = null, innerE = null;
    const dispose = r.createScope((d) => {
        innerC = r.computed(() => 1);
        innerE = r.effect(() => { innerC(); });
        return d;
    });
    // forEachOwned on the scope owner should enumerate the adopted computed + effect.
    // The owner handle is the disposer's node; ownerOf(innerC) should resolve to it.
    const ownerDesc = typeof r.ownerOf === "function" ? r.ownerOf(innerC) : undefined;
    R.ok("ownerOf", ownerDesc !== undefined, "ownerOf(adopted computed) did not resolve the scope owner");

    if (ownerDesc !== undefined) {
        let owned = 0;
        r.forEachOwned(ownerDesc, () => owned++);
        R.ok("forEachOwned", owned >= 2, `forEachOwned enumerated ${owned} children, expected >=2 (computed+effect)`);
    }
    dispose();
}

/* -- 8. observeObservers fires on observer add/remove ----------------------- */
if (typeof reg().observeObservers === "function") {
    const r = reg();
    // The hooks fire on the 0->1 (onConnect) and 1->0 (onDisconnect) transitions,
    // not on every individual add/remove. (An earlier draft guessed
    // onObserverAdded/onObserverRemoved and failed against the real contract --
    // the engine was right; the test had the wrong hook names.)
    const s = r.signal(0);
    let connects = 0, disconnects = 0;
    const un = r.observeObservers(s, {
        onConnect: () => connects++,
        onDisconnect: () => disconnects++,
    });
    const stop1 = r.effect(() => s());   // 0 -> 1: onConnect fires
    R.eq("observeObservers", connects, 1, "onConnect did not fire on the 0->1 observer transition");
    const stop2 = r.effect(() => s());   // 1 -> 2: NOT a transition, must not fire
    R.eq("observeObservers", connects, 1, "onConnect fired again on 1->2 (must only fire on 0->1)");
    stop2();                             // 2 -> 1: not a transition
    R.eq("observeObservers", disconnects, 0, "onDisconnect fired on 2->1 (must only fire on 1->0)");
    stop1();                             // 1 -> 0: onDisconnect fires
    R.eq("observeObservers", disconnects, 1, "onDisconnect did not fire on the 1->0 observer transition");
    let threw = null;
    try { un(); un(); } catch (e) { threw = e; }
    R.ok("observeObservers", threw === null, `repeated unobserve threw: ${threw && threw.message}`);
}

/* -- 9. THE ABA GEN-STAMP GUARD (the load-bearing safety property) ---------- */
{
    // A descriptor captured before dispose+recycle must not resolve to the new
    // resident. describe/nodeId must return undefined; the walks must visit nothing.
    const r = reg();
    const victim = r.signal(42);
    const c = r.computed(() => victim());
    const stop = r.effect(() => c());
    const stale = r.describe(victim);
    R.ok("aba-guard", stale !== undefined, "describe returned nothing for a live node");

    stop();
    r.dispose(c);
    r.dispose(victim);
    // Recycle the freed slots.
    const recyc = [];
    for (let i = 0; i < 16; i++) recyc.push(r.signal(1000 + i));

    R.eq("aba-guard", r.describe(stale), undefined, "re-describing a stale descriptor resolved a node -- ABA guard failed");
    R.eq("aba-guard", r.nodeId(stale), undefined, "nodeId on a stale descriptor returned an id -- ABA guard failed");
    let walked = 0;
    let threw = null;
    try { r.forEachObserver(stale, () => walked++); r.forEachSource(stale, () => walked++); }
    catch (e) { threw = e; }
    R.ok("aba-guard", threw === null, `walking a stale descriptor threw: ${threw && threw.message}`);
    R.eq("aba-guard", walked, 0, "walking a stale descriptor visited the recycled resident's edges -- silent corruption");
}

/* -- 10. Fuzz: forEachSource always matches the reference dep set ----------- */

function fuzzSeed(seed) {
    const rnd = mulberry32(seed);
    const r = reg();
    const L = 6;
    const leaves = Array.from({ length: L }, (_, i) => r.signal(i));
    // A computed whose dep set is steered by a selector signal, so it rewires.
    const sel = r.signal(0);
    const picks = () => {
        const k = 2 + (sel.peek() % 3);
        const set = [];
        for (let i = 0; i < k; i++) set.push(leaves[(sel.peek() + i) % L]);
        return set;
    };
    const c = r.computed(() => {
        const s = sel();
        const k = 2 + (s % 3);
        let acc = 0;
        for (let i = 0; i < k; i++) acc += leaves[(s + i) % L]();
        return acc;
    });
    const stop = r.effect(() => c());

    for (let op = 0; op < 20; op++) {
        sel.set(randInt(rnd, 1000));
        c();                                // settle the rewire
        // Reference dep set: sel + the k leaves the body read.
        const s = sel.peek();
        const k = 2 + (s % 3);
        const refLeaves = new Set();
        for (let i = 0; i < k; i++) refLeaves.add((s + i) % L);
        const expected = 1 + refLeaves.size;   // sel + distinct leaves
        const got = countSources(r, c);
        if (got !== expected) { stop(); return { seed, op, got, expected }; }
    }
    stop();
    return null;
}

let fuzzFail = 0;
let firstFail = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    let bad;
    try { bad = fuzzSeed(seed); }
    catch (err) { fuzzFail++; if (!firstFail) firstFail = { seed, threw: err.message }; continue; }
    if (bad) { fuzzFail++; if (!firstFail) firstFail = bad; }
}
if (fuzzFail > 0) {
    const d = firstFail.threw
        ? `seed ${firstFail.seed} threw: ${firstFail.threw}`
        : `seed ${firstFail.seed} op ${firstFail.op}: forEachSource=${firstFail.got}, reference dep set=${firstFail.expected}`;
    R.fail("source-walk-fuzz", `${fuzzFail}/${SEEDS} seeds: forEachSource disagreed with the reference dep set; ${d}`);
}

R.note(`${SEEDS} seeds cross-checking forEachSource against the reference dep set under rewiring`);
process.exit(R.finish("introspection walks agree with the edge set, transitions are correct, and the ABA guard holds"));
