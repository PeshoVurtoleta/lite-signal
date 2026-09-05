/**
 * bench/torture/deep-chain-torture.mjs -- pullComputed recursion, fail-closed.
 *
 * `pullComputed` is call-stack recursive: pulling a computed walks its deps and
 * recurses into every computed source (1.8.0 Signal.js :1065, recursing at :1086).
 * A chain of N computeds
 * therefore reads at call-stack depth N, and beyond the host's stack budget
 * (~10k on a default V8) reading the tail throws a RangeError rather than
 * corrupting anything. That is the fail-CLOSED edge for pull depth.
 *
 * The PUSH path has no such limit: effect propagation runs through the flush
 * QUEUE, which is heap-iterative, not call-stack recursive. A cascade of N
 * effects (each writing the next signal) drains in N flush passes without ever
 * growing the stack -- so with a flush-pass budget >= N it completes where an
 * equally deep PULL chain cannot. The two paths are contrasted here.
 *
 * Depth is RAMPED, never pinned: the exact throwing depth is host- and
 * stack-dependent, so asserting a specific number would be a flake. We assert
 * only that SOME depth <= a large ceiling throws a RangeError, and then that:
 *   - the registry that threw is STILL USABLE -- a fresh small graph builds and
 *     evaluates correctly, effects included;
 *   - an effect CASCADE over an equally deep chain does NOT throw and lands the
 *     correct tail value.
 *
 * Exit code: 0 iff the pull edge failed closed and the push path stayed open.
 *
 * Usage: node --expose-gc bench/torture/deep-chain-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { createReport } from "./helpers/index.mjs";

const { createRegistry } = Signal;
const R = createReport("lite-signal deep-chain torture -- pullComputed recursion, fail-closed");

const CEILING = 100000;   // if nothing throws by here, the recursion guard is gone
const START = 2000;
const STEP = 2000;

/* Build a linear computed chain of `depth` and read its tail once. */
function readDeepChain(r, depth) {
    const base = r.signal(1);
    let prev = r.computed(() => base());
    for (let i = 1; i < depth; i++) {
        const p = prev;
        prev = r.computed(() => p() + 1);
    }
    return prev;   // tail handle; caller reads it
}

/* -- 1. Ramp pull depth until a RangeError fails the read closed ------------- */
let threwDepth = -1;
let lastRegistry = null;
let lastTail = null;
for (let depth = START; depth <= CEILING; depth += STEP) {
    const r = createRegistry({ maxNodes: depth + 64, maxLinks: (depth + 64) * 4, onCapacityExceeded: "grow" });
    const tail = readDeepChain(r, depth);
    let threw = null;
    try { tail(); } catch (e) { threw = e; }
    if (threw !== null) {
        R.ok("pull-fail-closed", threw instanceof RangeError,
            `deep read threw ${threw.constructor.name} at depth ${depth}, expected RangeError`);
        threwDepth = depth;
        lastRegistry = r;
        lastTail = tail;
        break;
    }
}
R.ok("pull-fail-closed", threwDepth !== -1,
    `no RangeError by depth ${CEILING} -- the recursion guard is gone or the stack is unbounded`);
if (threwDepth !== -1) R.note(`pull chain failed closed with a RangeError at depth ${threwDepth}`);

/* -- 2. The registry that threw is still usable ----------------------------- */
if (lastRegistry !== null) {
    const r = lastRegistry;
    let value = null;
    let effectRuns = 0;
    let threw = null;
    try {
        const a = r.signal(10);
        const b = r.signal(20);
        const c = r.computed(() => a() + b());
        value = c();
        const stop = r.effect(() => { c(); effectRuns++; });
        a.set(15);
        stop();
    } catch (e) { threw = e; }
    R.ok("still-usable", threw === null,
        `the registry was corrupt after a deep-read RangeError: ${threw && threw.message}`);
    R.eq("still-usable", value, 30, "a fresh computed built after the RangeError returned the wrong value");
    R.eq("still-usable", effectRuns, 2, "a fresh effect did not fire correctly after the RangeError");

    // The deep chain itself remains fail-closed on re-read -- deterministic, not a
    // one-shot: the limit is structural (call depth), not a cached error.
    let reThrew = null;
    try { lastTail(); } catch (e) { reThrew = e; }
    R.ok("still-usable", reThrew instanceof RangeError,
        "the deep chain stopped failing closed on re-read -- the limit is not deterministic");
}

/* -- 3. An effect cascade over an equally deep chain does NOT throw ---------- */
{
    // The push path is iterative: with a flush-pass budget >= depth, a cascade of
    // `depth` effects (each writing the next signal) propagates end to end where
    // the equally deep PULL chain could not. Uses the depth that broke the pull
    // path, so "equally deep" is literal.
    const depth = threwDepth !== -1 ? threwDepth : START;
    const r = createRegistry({
        maxNodes: depth * 2 + 64,
        maxLinks: (depth * 2 + 64) * 4,
        onCapacityExceeded: "grow",
        maxFlushPasses: depth + 100,   // budget, not a stack limit
    });
    const sigs = new Array(depth + 1);
    for (let i = 0; i <= depth; i++) sigs[i] = r.signal(0);
    const stops = new Array(depth);
    for (let i = 0; i < depth; i++) {
        const src = sigs[i];
        const dst = sigs[i + 1];
        stops[i] = r.effect(() => { dst.set(src() + 1); });
    }

    let threw = null;
    try { sigs[0].set(1); } catch (e) { threw = e; }
    R.ok("push-open", threw === null,
        `an effect cascade of depth ${depth} threw ${threw && threw.constructor.name} -- the push path is not iterative`);
    R.eq("push-open", sigs[depth].peek(), depth + 1,
        "the effect cascade did not propagate the correct tail value");

    for (let i = 0; i < depth; i++) stops[i]();
    R.note(`effect cascade of depth ${depth} propagated iteratively without a RangeError`);
}

process.exit(R.finish("the pull edge failed closed at depth; the iterative push path stayed open"));
