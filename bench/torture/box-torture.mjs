/**
 * bench/torture/box-torture.mjs -- signalBox / computedBox (1.5.0).
 *
 * The boxes are documented as "the same ReactiveNode and zero-GC read/write
 * path as the callable forms, full interop in one graph". That claim is the
 * whole point of the API -- and it is exactly the kind of claim that rots
 * quietly, because a divergence between the two representations produces
 * correct-looking behaviour in any test that uses only one of them.
 *
 * So the centrepiece here is not a box-specific unit test. It is the same
 * differential fuzz that `oracle-fuzzer.mjs` runs, with every node in the graph
 * randomly realised as EITHER a callable or a box. The reference evaluator does
 * not know which is which. If the two representations ever disagree -- on
 * values, on equality, on dynamic dependency tracking -- a mixed graph is where
 * it shows, and a single-representation suite never would.
 *
 * The rest of the file pins the surface contracts the callable forms do not
 * have: `subscribe` (immediate fire, untracked callback, idempotent disposer),
 * `update`, and the allocation-light representation itself. That last one is a
 * design law, not an implementation detail -- llms.txt is explicit that the
 * prototype is shared "from the start -- never setPrototypeOf (which would
 * deopt the method-call ICs to megamorphic)". A test that pins zero own
 * properties and a stable shared prototype is the only thing standing between
 * that law and a well-meaning refactor.
 *
 * Exit code: 0 iff boxes are indistinguishable from callables where they should
 * be, and honour their own contracts where they differ.
 *
 * Usage: node --expose-gc bench/torture/box-torture.mjs
 *        BOX_SEEDS=2000 node --expose-gc bench/torture/box-torture.mjs
 */

// Feature-detected rather than statically imported. A bare
// `import { signalBox }` is a load-time error on 1.4.x, which would take the
// whole runner down on a branch that simply predates the API instead of
// reporting a clean skip.
import * as Signal from "../../Signal.js";

const { createRegistry } = Signal;
const signalBox = Signal.signalBox;
const computedBox = Signal.computedBox;

if (typeof signalBox !== "function" || typeof computedBox !== "function") {
    console.log("lite-signal box torture -- SKIP: signalBox/computedBox require 1.5.0+");
    process.exit(0);
}
import { mulberry32, randInt, pickValue, toNum, soakRegistry, createReport } from "./helpers/index.mjs";

const SEEDS = Number(process.env.BOX_SEEDS || 300);
const OPS = Number(process.env.BOX_OPS || 80);
const R = createReport(`lite-signal box torture -- signalBox/computedBox, ${SEEDS} mixed-representation seeds`);
const reg = () => soakRegistry(createRegistry);

/* -- 1. Mixed-representation differential fuzz ------------------------------ */

function buildModel(rnd, { leaves, tiers, perTier }) {
    const model = { leaves: [], nodes: [] };
    for (let i = 0; i < leaves; i++) {
        model.leaves.push({
            value: rnd() < 0.5 ? randInt(rnd, 100) : pickValue(rnd),
            // The representation is drawn per NODE, so a single graph mixes both.
            boxed: rnd() < 0.5,
        });
    }
    let prev = model.leaves.map((_, i) => ({ kind: "leaf", index: i }));
    for (let t = 0; t < tiers; t++) {
        const tier = [];
        for (let n = 0; n < perTier; n++) {
            const deps = [];
            const fanIn = 2 + randInt(rnd, 3);
            for (let d = 0; d < fanIn; d++) deps.push(prev[randInt(rnd, prev.length)]);
            const roll = rnd();
            model.nodes.push({
                kind: roll < 0.30 ? "select" : (roll < 0.55 ? "identity" : "sum"),
                deps,
                boxed: rnd() < 0.5,
                selector: roll < 0.30 ? { kind: "leaf", index: randInt(rnd, leaves) } : null,
            });
            tier.push({ kind: "node", index: model.nodes.length - 1 });
        }
        prev = prev.concat(tier);
    }
    return model;
}

/** Uncached recursive reference. Knows nothing about boxes or callables. */
function reference(model, ref) {
    if (ref.kind === "leaf") return model.leaves[ref.index].value;
    const node = model.nodes[ref.index];
    if (node.kind === "sum") {
        let acc = 0;
        for (let i = 0; i < node.deps.length; i++) acc = (acc + toNum(reference(model, node.deps[i]))) | 0;
        return acc;
    }
    if (node.kind === "identity") return reference(model, node.deps[0]);
    const sel = toNum(reference(model, node.selector));
    const n = node.deps.length;
    return reference(model, node.deps[((sel % n) + n) % n]);
}

function runSeed(seed) {
    const rnd = mulberry32(seed);
    const model = buildModel(rnd, { leaves: 10, tiers: 4, perTier: 7 });
    const r = reg();

    // Uniform accessors hide the representation from the graph builder, exactly
    // as a consumer mixing the two APIs would experience it.
    const sigs = model.leaves.map((l) => (l.boxed ? r.signalBox(l.value) : r.signal(l.value)));
    const readLeaf = (i) => (model.leaves[i].boxed ? sigs[i].get() : sigs[i]());
    const writeLeaf = (i, v) => sigs[i].set(v);          // .set exists on both

    const comps = new Array(model.nodes.length);
    const readNode = (i) => (model.nodes[i].boxed ? comps[i].get() : comps[i]());
    const read = (ref) => (ref.kind === "leaf" ? readLeaf(ref.index) : readNode(ref.index));

    for (let i = 0; i < model.nodes.length; i++) {
        const node = model.nodes[i];
        let body;
        if (node.kind === "sum") {
            body = function () {
                let acc = 0;
                for (let d = 0; d < node.deps.length; d++) acc = (acc + toNum(read(node.deps[d]))) | 0;
                return acc;
            };
        } else if (node.kind === "identity") {
            body = function () { return read(node.deps[0]); };
        } else {
            body = function () {
                const sel = toNum(read(node.selector));
                const n = node.deps.length;
                return read(node.deps[((sel % n) + n) % n]);
            };
        }
        comps[i] = node.boxed ? r.computedBox(body) : r.computed(body);
    }

    // Live observers, half of them subscribing through the box channel. A
    // `subscribe` callback is an independent witness: its last delivered value
    // must agree with what a pull returns.
    const witnesses = [];
    const stops = [];
    for (let e = 0; e < 5; e++) {
        const idx = randInt(rnd, comps.length);
        if (model.nodes[idx].boxed && rnd() < 0.5) {
            const w = { idx, last: undefined };
            witnesses.push(w);
            stops.push(comps[idx].subscribe((v) => { w.last = v; }));
        } else {
            stops.push(r.effect(function () { readNode(idx); }));
        }
    }

    const mismatches = [];
    const checkAll = (label) => {
        for (let i = 0; i < model.nodes.length; i++) {
            const got = readNode(i);
            const want = reference(model, { kind: "node", index: i });
            if (!Object.is(got, want)) {
                mismatches.push({ label, i, boxed: model.nodes[i].boxed, kind: model.nodes[i].kind, got, want });
                return false;
            }
        }
        // A subscriber's last delivered value must match a fresh pull.
        for (const w of witnesses) {
            const pulled = readNode(w.idx);
            if (!Object.is(w.last, pulled)) {
                mismatches.push({ label, i: w.idx, boxed: true, kind: "subscribe", got: w.last, want: pulled });
                return false;
            }
        }
        return true;
    };

    if (!checkAll("initial")) return { seed, mismatches };

    for (let op = 0; op < OPS; op++) {
        const roll = rnd();
        if (roll < 0.45) {
            const li = randInt(rnd, model.leaves.length);
            const v = rnd() < 0.55 ? randInt(rnd, 100) : pickValue(rnd);
            model.leaves[li].value = v;
            writeLeaf(li, v);
        } else if (roll < 0.65) {
            r.batch(function () {
                const n = 2 + randInt(rnd, 3);
                for (let w = 0; w < n; w++) {
                    const li = randInt(rnd, model.leaves.length);
                    const v = rnd() < 0.55 ? randInt(rnd, 100) : pickValue(rnd);
                    model.leaves[li].value = v;
                    writeLeaf(li, v);
                }
            });
        } else if (roll < 0.78) {
            // update() on a box must be exactly set(fn(peek())).
            const boxed = model.leaves.map((l, i) => (l.boxed ? i : -1)).filter((i) => i >= 0);
            if (boxed.length > 0) {
                const li = boxed[randInt(rnd, boxed.length)];
                const delta = randInt(rnd, 10);
                const cur = model.leaves[li].value;
                const next = (toNum(cur) + delta) | 0;
                model.leaves[li].value = next;
                sigs[li].update((c) => (toNum(c) + delta) | 0);
            }
        } else if (roll < 0.88) {
            const li = randInt(rnd, model.leaves.length);
            writeLeaf(li, model.leaves[li].value);      // no-op rewrite
        } else {
            const k = 1 + randInt(rnd, 4);
            for (let i = 0; i < k; i++) readNode(randInt(rnd, comps.length));
        }
        if (!checkAll("op " + op)) break;
    }

    for (const s of stops) s();
    return { seed, mismatches };
}

let fuzzFailures = 0;
let firstFuzz = null;
for (let seed = 1; seed <= SEEDS; seed++) {
    let res;
    try { res = runSeed(seed); }
    catch (err) { fuzzFailures++; if (firstFuzz === null) firstFuzz = { seed, threw: err }; continue; }
    if (res.mismatches.length > 0) {
        fuzzFailures++;
        if (firstFuzz === null) firstFuzz = res;
    }
}
if (fuzzFailures > 0) {
    const d = firstFuzz.threw
        ? `seed ${firstFuzz.seed} threw: ${firstFuzz.threw.message}`
        : (() => {
            const m = firstFuzz.mismatches[0];
            return `seed ${firstFuzz.seed}: node #${m.i} (${m.kind}, ${m.boxed ? "box" : "callable"}) ${m.label} -- ` +
                `got ${String(m.got)}, reference ${String(m.want)}`;
        })();
    R.fail("mixed-interop", `${fuzzFailures}/${SEEDS} seeds disagreed; ${d}`);
}
R.note(`${SEEDS} seeds x ${OPS} ops over graphs mixing callables and boxes at every node`);

/* -- 2. Allocation-light representation is a design law --------------------- */
{
    const a = signalBox(1);
    const b = signalBox(2);
    const c = computedBox(() => a.get());

    R.eq("allocation-light", Object.getOwnPropertyNames(a).length, 0,
        "a signalBox grew own properties; methods must live on the shared prototype");
    R.eq("allocation-light", Object.getOwnPropertyNames(c).length, 0,
        "a computedBox grew own properties");
    R.ok("allocation-light", Object.getPrototypeOf(a) === Object.getPrototypeOf(b),
        "two signalBoxes no longer share one prototype -- method-call ICs will go megamorphic");

    const proto = Object.getPrototypeOf(a);
    const names = Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor").sort();
    R.ok("allocation-light", names.join(",") === "get,peek,set,subscribe,update",
        `signalBox prototype surface changed: ${names.join(",")}`);
    const cnames = Object.getOwnPropertyNames(Object.getPrototypeOf(c)).filter((n) => n !== "constructor").sort();
    R.ok("allocation-light", cnames.join(",") === "get,peek,subscribe",
        `computedBox prototype surface changed: ${cnames.join(",")}`);
    R.ok("allocation-light", !("set" in c) && !("update" in c),
        "computedBox exposes a writer -- it is derived and must not");
}

/* -- 3. subscribe contract -------------------------------------------------- */
{
    const r = reg();
    const b = r.signalBox(1);

    // Fires immediately with the current value.
    const seen = [];
    const un = b.subscribe((v) => seen.push(v));
    R.eq("subscribe", seen.length, 1, "subscribe did not fire immediately");
    R.eq("subscribe", seen[0], 1, "the immediate fire delivered the wrong value");

    b.set(2);
    R.eq("subscribe", seen.length, 2, "a change did not reach the subscriber");
    R.eq("subscribe", seen[1], 2, "the change delivered the wrong value");

    // Equal writes must not deliver.
    b.set(2);
    R.eq("subscribe", seen.length, 2, "an equal write was delivered to the subscriber");

    // The disposer is idempotent and actually detaches.
    un();
    const afterUn = seen.length;
    b.set(3);
    R.eq("subscribe", seen.length, afterUn, "the subscriber fired after unsubscribing");
    let threw = null;
    try { un(); un(); } catch (err) { threw = err; }
    R.ok("subscribe", threw === null, `a repeated unsubscribe threw: ${threw && threw.message}`);
}
{
    // The callback runs UNTRACKED: reading a signal inside it must not
    // subscribe the enclosing effect to that signal.
    const r = reg();
    const b = r.signalBox(0);
    const hidden = r.signal(0);
    let effectRuns = 0;
    let cbRuns = 0;
    const stop = r.effect(function () {
        effectRuns++;
        b.get();
        b.subscribe(function () { cbRuns++; hidden(); });
    });
    const e0 = effectRuns;
    hidden.set(1);
    R.eq("subscribe-untracked", effectRuns, e0,
        "a signal read inside a subscribe callback leaked into the enclosing effect's deps");
    stop();
}
{
    // Unsubscribing from inside the callback must not corrupt the notify walk.
    const r = reg();
    const b = r.signalBox(0);
    const order = [];
    let unB = null;
    const unA = b.subscribe((v) => { order.push("A" + v); if (unB) unB(); });
    unB = b.subscribe((v) => order.push("B" + v));
    order.length = 0;
    let threw = null;
    try { b.set(1); } catch (err) { threw = err; }
    R.ok("subscribe-reentrant", threw === null, `unsubscribing during notify threw: ${threw && threw.message}`);
    R.ok("subscribe-reentrant", order.includes("A1"), "the surviving subscriber did not fire");
    b.set(2);
    R.ok("subscribe-reentrant", !order.includes("B2"), "a subscriber removed during notify still fired later");
    unA();
}
{
    // A throwing subscriber must not silence the others or wedge the box.
    const r = reg();
    const b = r.signalBox(0);
    let goodRuns = 0;
    let threw = null;
    // Throw on the CHANGE notification only. `subscribe` fires immediately, and
    // a callback that throws on that first call propagates out of subscribe()
    // itself -- a different path (and arguably correct: a broken subscriber
    // should fail loudly at registration).
    let firstFire = true;
    const unBad = b.subscribe(() => {
        if (firstFire) { firstFire = false; return; }
        throw new Error("subscriber exploded");
    });
    const unGood = b.subscribe(() => { goodRuns++; });
    const g0 = goodRuns;
    try { b.set(1); } catch (err) { threw = err; }
    R.ok("subscribe-throwing", goodRuns > g0,
        `a throwing subscriber starved the next one${threw ? ` (set threw: ${threw.message})` : ""}`);
    try { unBad(); unGood(); } catch { /* teardown */ }
}

/* -- 4. update() and equality ----------------------------------------------- */
{
    const r = reg();
    const b = r.signalBox(10);
    b.update((c) => c + 5);
    R.eq("update", b.peek(), 15, "update did not apply its function");

    // update() must read the current value WITHOUT tracking. The test has to
    // call it from INSIDE a live effect and with no untrack wrapper -- an
    // earlier draft wrapped the call in untrack, which suppressed the very
    // tracking it was trying to detect and passed against a mutant that made
    // update() read through the tracked path.
    const outer = r.signalBox(1);
    const target = r.signalBox(0);
    let runs = 0;
    const stop = r.effect(function () {
        runs++;
        outer.get();                 // the effect's ONLY intended dependency
        target.update((c) => c + 1); // must not subscribe us to `target`
    });
    const base = runs;
    target.set(500);                 // if update() tracked, this wakes the effect
    R.eq("update", runs, base,
        "update() tracked its read -- the effect became a dependent of a box it only wrote");
    outer.set(2);
    R.ok("update", runs > base, "the effect stopped responding to its real dependency");
    stop();

    // A custom equality predicate must suppress propagation.
    const eqBox = r.signalBox({ v: 1 }, { equals: (a, c) => a.v === c.v });
    let notified = 0;
    const un = eqBox.subscribe(() => { notified++; });
    const afterInit = notified;
    eqBox.set({ v: 1 });                       // equal under the predicate
    R.eq("equals", notified, afterInit, "a custom equals predicate did not suppress an equal write");
    eqBox.set({ v: 2 });
    R.eq("equals", notified, afterInit + 1, "a differing write was not delivered");
    un();
}

/* -- 5. Boxes wake observers exactly like callables ------------------------- */
{
    const r = reg();
    // Same topology twice, once per representation. The run counts must match.
    const mk = (boxed) => {
        const src = boxed ? r.signalBox(1) : r.signal(1);
        const rd = boxed ? () => src.get() : () => src();
        const a = boxed ? r.computedBox(() => rd() * 2) : r.computed(() => rd() * 2);
        const ra = boxed ? () => a.get() : () => a();
        const b = boxed ? r.computedBox(() => rd() + 1) : r.computed(() => rd() + 1);
        const rb = boxed ? () => b.get() : () => b();
        let runs = 0;
        const stop = r.effect(function () { runs++; ra(); rb(); });
        return { src, stop, get runs() { return runs; } };
    };
    const boxed = mk(true);
    const callable = mk(false);
    const b0 = boxed.runs, c0 = callable.runs;
    boxed.src.set(2);
    callable.src.set(2);
    R.eq("wakeup-parity", boxed.runs - b0, callable.runs - c0,
        "a diamond woke its sink a different number of times through boxes than through callables");
    R.eq("wakeup-parity", boxed.runs - b0, 1, "the boxed diamond did not wake exactly once");
    boxed.stop(); callable.stop();
}

process.exit(R.finish("boxes match callables in mixed graphs and honour their own surface contracts"));
