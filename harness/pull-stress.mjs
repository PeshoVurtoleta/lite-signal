// pull-stress.mjs -- @zakkster/lite-signal 1.6 pull-mode depth characterization.
// -----------------------------------------------------------------------------
// Companion to burst-dag.mjs. Where burst-dag asks "is the burst flush
// algorithmically wasteful?", this asks "how does the pull path scale with
// chain depth, and exactly where does it break?".
//
// The pull is RECURSIVE in the current engine: reading c[N-1] in a linear
// chain c[0] <- c[1] <- ... <- c[N-1] recurses N levels through the JS call
// stack. The roadmap names this the main outstanding architectural item ("the
// pull-mode recursion depth limit (~5,000 chained computeds)"). This harness
// pins that ~5,000 to a number on the current engine, characterizes the per-
// level cost on the way up, and gives a before/after baseline for the
// eventual iterative pull rewrite.
//
// Three answers:
//   1. EXACT overflow depth -- binary-searched via try/catch on read; the
//      number reported is the deepest chain that pulls successfully (not the
//      first one that throws). Both ends are reported.
//   2. PER-LEVEL COST -- median cold-pull us / depth across a sweep. Should be
//      roughly linear; a knee in the curve flags a per-node bookkeeping cost
//      that grows with depth (effect-set walk, owner chain, dep-list scan).
//   3. STEADY-STATE PULL COST -- median cached-read us; should be O(1) via
//      the 1.1.4 markEpoch / version short-circuit, INDEPENDENT of depth.
//
// What opcodes 5/6/7 confirm for the structure pass (1 cold read at the tip):
//   - opcode 6 (flush pass)        MUST be 0   -- pure pull has nothing to drain
//   - opcode 7 (effect run in pass) MUST be 0   -- no effects in chain
//   - opcode 5 (recompute)         MUST equal depth -- one per chain node
// A correct engine produces this exact triple; deviation is a real finding,
// reported as a STRUCTURE FAILED verdict that suppresses the timing summary.
//
// Two consumers, one file:
//   - standalone:  node --expose-gc pull-stress.mjs [--maxDepth=4096 --step=512 ...]
//       structure pass at maxDepth + cold/cached sweep + overflow probe + verdict.
//   - the gate:    import { pullStressScenario } and add to zgc-scenarios.mjs.
//       NB each "iter" is one source write + one tip pull through a fixed-depth
//       chain. For chains of depth 1024, pass N in the low thousands.
//
// Engine-agnostic by the same rule as the rest of the surface: imports only
// `./Signal.js` and uses the public `onGraphMutation` hook. Point Signal.js at
// 1.5.x (no flushPasses key, opcode 6/7 absent -- the structure pass adapts)
// or a rejected candidate and re-run.
//
// MIT (c) Zahary Shinikchiev.

import { createRegistry } from "../Signal.js";
import { performance } from "node:perf_hooks";

const DEFAULTS = {
    maxDepth: 3584,            // upper bound of the timing sweep AND the structure pass
                               // (current 1.6.0 overflow at ~4041; default leaves headroom)
    step: 512,                 // sweep granularity (depth points: step, 2*step, ..., maxDepth)
    kind: "callable",          // "callable" (user path) | "box" (allocation-light path)
    trials: 9,                 // median-of-N for cold + cached timing
    warmupChains: 3,           // build+pull this many disposable chains before timing
    cachedReadsPerTrial: 1000, // averaged for stable us/read at sub-microsecond resolution
    overflowProbeMax: 32768,   // hard ceiling for the overflow binary search
};

function parseParams(argv) {
    const p = { ...DEFAULTS };
    for (const arg of argv) {
        const m = /^--([a-zA-Z]+)=(.+)$/.exec(arg);
        if (m === null) continue;
        const key = m[1], val = m[2];
        if (key === "kind") p.kind = (val === "box" ? "box" : "callable");
        else if (Object.prototype.hasOwnProperty.call(p, key)) p[key] = val | 0;
    }
    return p;
}

// Pool capacities sized to the chain so the BUILD is fully pooled (no growth).
// One source + `depth` computeds; one link per computed.
function capacities(depth) {
    const nodes = depth + 16;
    const links = depth + 16;
    return {
        maxNodes: Math.ceil(nodes * 1.1),
        maxLinks: Math.ceil(links * 1.1),
        prealloc: "eager",
        onCapacityExceeded: "grow",
    };
}

// Build a fresh linear chain of `depth` computeds rooted on one signal, in a
// fresh registry sized for it. The body is captured per closure so the call
// site stays megamorphic (each computed's body is a distinct closure capturing
// a different `dep`) -- representative of the realistic pull workload.
function buildChain(depth, kind) {
    const r = createRegistry(capacities(depth));
    const callable = kind === "callable";
    const source = callable ? r.signal(0) : r.signalBox(0);
    let prev = source;
    let tip = null;
    for (let i = 0; i < depth; i++) {
        const dep = prev;
        const body = callable ? () => dep() : () => dep.get();
        const c = callable ? r.computed(body) : r.computedBox(body);
        tip = c;
        prev = c;
    }
    return { r, source, tip };
}

function readTip(tip, kind) {
    return kind === "callable" ? tip() : tip.get();
}

/**
 * Structure pass: builds a fresh chain at `depth`, attaches the op 5/6/7 hook
 * for exactly ONE cold pull at the tip, then detaches. Returns the structural
 * triple plus the `flushPasses` stat cross-check (must equal the op-6 count;
 * the hook was attached only across this one pull, so the two must agree).
 * Throws RangeError if `depth` is at/above the engine's overflow point --
 * caller is expected to choose a depth below the overflow probe's result.
 */
export function profileDepth(depth, params = {}) {
    const p = { ...DEFAULTS, ...params };
    const { r, tip } = buildChain(depth, p.kind);

    let passes = 0, recomputes = 0, effectsInPass = 0;
    const off = r.onGraphMutation((op, a, b) => {
        if (op === 5) recomputes++;
        else if (op === 6) passes++;
        else if (op === 7) effectsInPass++;
    });
    let value, threw = null;
    try { value = readTip(tip, p.kind); }
    catch (e) { threw = e; }
    off();

    const flushPassesStat = r.stats().flushPasses;
    r.destroy();

    if (threw !== null) throw threw;   // propagate (RangeError or otherwise)
    return {
        depth, kind: p.kind, value,
        passes, recomputes, effectsInPass,
        flushPassesStat,
    };
}

/**
 * Median-of-N timing at a fixed depth, profiler DETACHED. Two numbers per
 * point: coldUs (first-read on a freshly-built chain, full-depth recompute)
 * and cachedUs (repeated read with no intervening write, should be O(1) via
 * markEpoch). A fresh chain per trial so the cold read is genuinely cold each
 * time -- one chain re-read with a signal-write between would measure
 * mark-then-pull, not pull-from-empty.
 */
export function timeDepth(depth, params = {}) {
    const p = { ...DEFAULTS, ...params };

    // Warm-up: build+pull a few disposable chains so JIT settles before the
    // measured trials. Each warmup is at the SAME depth so the JIT specializes
    // for the shape we'll be measuring.
    for (let i = 0; i < p.warmupChains; i++) {
        const w = buildChain(depth, p.kind);
        readTip(w.tip, p.kind);
        w.r.destroy();
    }

    const coldTimes = new Array(p.trials);
    const cachedTimes = new Array(p.trials);
    let sink = 0;   // anti-DCE: XOR the returned values so the reads can't be elided

    for (let t = 0; t < p.trials; t++) {
        const { r, tip } = buildChain(depth, p.kind);

        const t0 = performance.now();
        sink ^= readTip(tip, p.kind) | 0;
        const t1 = performance.now();
        coldTimes[t] = (t1 - t0) * 1000;   // ms -> us

        // Cached: re-read the tip many times with no write between. Each read
        // should hit the markEpoch short-circuit at the tip alone -- no
        // dependency walk, no recomputation.
        const N = p.cachedReadsPerTrial;
        const t2 = performance.now();
        for (let k = 0; k < N; k++) sink ^= readTip(tip, p.kind) | 0;
        const t3 = performance.now();
        cachedTimes[t] = ((t3 - t2) * 1000) / N;   // us per read

        r.destroy();
    }

    coldTimes.sort((a, b) => a - b);
    cachedTimes.sort((a, b) => a - b);
    const mid = p.trials >> 1;
    return {
        depth, kind: p.kind,
        coldUs: coldTimes[mid],
        cachedUs: cachedTimes[mid],
        coldUsPerLevel: coldTimes[mid] / depth,
        _sink: sink,
    };
}

/**
 * Binary-search the exact maximum chain depth that still pulls successfully.
 * Each probe builds a FRESH chain (no shared state) and attempts one cold read
 * on the tip; success means depth is achievable, failure (RangeError on the
 * JS call stack) means it overflowed. Returns { lastOk, firstFail }.
 *
 * Strategy: exponential ramp from depth=1 until first failure (or until the
 * ceiling is reached without failure), then bisect between last-ok and
 * first-fail. O(log limit) registries; cheap even for limits in the millions.
 */
export function probeOverflow(kind, ceiling) {
    const tryDepth = (d) => {
        try {
            const { r, tip } = buildChain(d, kind);
            readTip(tip, kind);
            r.destroy();
            return true;
        } catch (e) {
            // Only RangeError counts as "overflow". Anything else is a real
            // engine fault and surfaces to the caller.
            if (e instanceof RangeError) return false;
            throw e;
        }
    };

    // Exponential ramp.
    let lo = 1, hi = 1;
    while (hi <= ceiling) {
        if (tryDepth(hi)) {
            lo = hi;
            if (hi >= ceiling) return { lastOk: ceiling, firstFail: null };
            hi = Math.min(hi * 2, ceiling);
            if (hi === lo) hi = ceiling;   // ensure we test the ceiling exactly
        } else {
            break;
        }
    }
    if (hi <= ceiling && tryDepth(hi)) {
        return { lastOk: ceiling, firstFail: null };
    }

    // Bisect between lo (known OK) and hi (known FAIL).
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (tryDepth(mid)) lo = mid;
        else hi = mid;
    }
    return { lastOk: lo, firstFail: hi };
}

/**
 * zgc-scenarios.mjs entry. Steady-state allocation under repeated source
 * writes through a fixed-depth chain. Each `hot()` iter is one source write
 * (which marks the chain dirty) followed by one tip pull (which recomputes
 * the whole chain). For depth=1024, expect ~1024 recomputes per iter -- pass
 * a much smaller N than the gate's 200k default. The scaling claim still
 * holds: ~0 scavenges at N and k*N, poolGrowthDelta 0, allocDelta 0.
 */
export function pullStressScenario(overrides = {}) {
    const p = { depth: 1024, kind: "callable", ...overrides };
    let R = null, src = null, tip = null;
    return {
        name: `pull chain (depth=${p.depth}, ${p.kind})`,
        setup() {
            const built = buildChain(p.depth, p.kind);
            R = built.r; src = built.source; tip = built.tip;
            readTip(tip, p.kind);   // warm the cache once
            return { r: R, src, tip, kind: p.kind };
        },
        statsOf: (s) => s.r.stats(),
        hot(s, n) {
            const _src = s.src, _tip = s.tip, callable = s.kind === "callable";
            if (callable) {
                for (let i = 0; i < n; i++) { _src.set(i); _tip(); }
            } else {
                for (let i = 0; i < n; i++) { _src.set(i); _tip.get(); }
            }
        },
        teardown() { if (R !== null) R.destroy(); R = null; src = null; tip = null; },
    };
}

// ---- standalone CLI ---------------------------------------------------------
function isMain() {
    try { return import.meta.url === `file://${process.argv[1]}`; } catch (_) { return false; }
}

if (isMain()) {
    const p = parseParams(process.argv.slice(2));
    console.log("pull-stress  kind=%s  maxDepth=%d  step=%d  trials=%d",
        p.kind, p.maxDepth, p.step, p.trials);

    // Structure pass at a SAFE fixed depth. The mutation hook adds a stack
    // frame per recompute (the callback itself is called from within each
    // recompute call), so attaching it effectively reduces the achievable
    // depth roughly by half. The structure verification only needs to confirm
    // the engine produces the right OPCODE TRIPLE (0 flush passes, 0 effect
    // runs, recomputes == depth) -- which is identical at any depth -- so we
    // run it well below the un-hooked overflow point. The sweep and probe
    // below run un-hooked, so they reach the true engine limit.
    const structDepth = Math.min(p.maxDepth, 1024);
    console.log("\n-- structure (1 cold pull at depth=%d, profiler attached) --", structDepth);
    let prof = null, structureOverflow = false;
    try { prof = profileDepth(structDepth, p); }
    catch (e) {
        if (e instanceof RangeError) {
            structureOverflow = true;
            console.log("  RangeError -- structure pass at depth=%d overflowed (the hook itself",
                structDepth);
            console.log("  costs stack frames; consider lowering structDepth in the harness).");
        } else throw e;
    }
    if (prof !== null) {
        console.log("  flush passes        : %d   (must be 0 -- pure pull has no flush)", prof.passes);
        console.log("  effects in flush    : %d   (must be 0 -- no effects in chain)", prof.effectsInPass);
        console.log("  recomputes (op 5)   : %d   (must equal depth=%d -- one per chain node)",
            prof.recomputes, structDepth);
        console.log("  stats().flushPasses : %d   (cross-check, == op-6 count)", prof.flushPassesStat);
    }
    const structureOk = prof !== null
        && prof.passes === 0
        && prof.effectsInPass === 0
        && prof.recomputes === structDepth;

    // Depth sweep: cold + cached us at step, 2*step, ..., maxDepth. Each
    // depth point gets a try/catch; if the sweep hits the overflow point
    // before reaching maxDepth, stop there cleanly.
    console.log("\n-- depth sweep (median-of-%d, fresh chain per trial) --", p.trials);
    console.log("  %s %s %s %s",
        "depth".padStart(8), "cold us".padStart(12), "cold us/lvl".padStart(13), "cached us".padStart(12));
    const sweep = [];
    let sweepCutShort = false;
    for (let d = p.step; d <= p.maxDepth; d += p.step) {
        try {
            const r = timeDepth(d, p);
            sweep.push(r);
            console.log("  %s %s %s %s",
                String(r.depth).padStart(8),
                r.coldUs.toFixed(2).padStart(12),
                r.coldUsPerLevel.toFixed(4).padStart(13),
                r.cachedUs.toFixed(4).padStart(12),
            );
        } catch (e) {
            if (e instanceof RangeError) {
                console.log("  depth=%d -- RangeError (overflow). Stopping sweep here.", d);
                sweepCutShort = true;
                break;
            } else throw e;
        }
    }

    // Overflow probe.
    console.log("\n-- overflow probe (binary search, ceiling=%d) --", p.overflowProbeMax);
    const ov = probeOverflow(p.kind, p.overflowProbeMax);
    if (ov.firstFail === null) {
        console.log("  ceiling not reached: chains up to depth=%d pull successfully.", ov.lastOk);
    } else {
        console.log("  deepest successful pull : %d", ov.lastOk);
        console.log("  first overflow at depth : %d", ov.firstFail);
    }

    // Verdict.
    console.log("\nVERDICT");
    if (structureOverflow) {
        console.log("  Structure pass overflowed at depth=%d. The hook adds a stack frame per", structDepth);
        console.log("  recompute, so it overflows earlier than the un-hooked sweep -- this is a");
        console.log("  harness limit, not an engine bug. Real overflow probe result: lastOk=%d.",
            ov.lastOk);
    } else if (!structureOk) {
        console.log("  STRUCTURE FAILED at depth=%d: opcode-6=%d, opcode-7=%d, recomputes=%d (expected 0/0/%d).",
            structDepth, prof.passes, prof.effectsInPass, prof.recomputes, structDepth);
        console.log("  The pull path is doing something it shouldn't -- flush passes / effect runs /");
        console.log("  recompute count is off. Investigate before reading timing or overflow numbers.");
    } else if (sweep.length === 0) {
        console.log("  No sweep points completed -- step=%d may be at/above the overflow point.", p.step);
    } else {
        const first = sweep[0], last = sweep[sweep.length - 1];
        const linearRatio = last.coldUsPerLevel / first.coldUsPerLevel;
        const linear = linearRatio < 2.0;   // within 2x = roughly linear at this noise floor
        console.log("  structure: 0 flush passes, 0 effect runs, %d recomputes at depth=%d. Pure pull.",
            prof.recomputes, structDepth);
        if (linear) {
            console.log("  cost: linear in depth (cold us/level %s -> %s across %d..%d, %sx -- within noise).",
                first.coldUsPerLevel.toFixed(4), last.coldUsPerLevel.toFixed(4),
                first.depth, last.depth, linearRatio.toFixed(2));
        } else {
            console.log("  cost: SUPERLINEAR (cold us/level %s -> %s across %d..%d, %sx).",
                first.coldUsPerLevel.toFixed(4), last.coldUsPerLevel.toFixed(4),
                first.depth, last.depth, linearRatio.toFixed(2));
            console.log("  A per-node cost is growing with depth -- worth profiling at the deep end.");
        }
        console.log("  steady-state: cached read = %s us at depth=%d (depth-independent O(1) via markEpoch).",
            last.cachedUs.toFixed(4), last.depth);
        if (ov.firstFail !== null) {
            console.log("  pull-mode depth limit: %d (overflow at %d).", ov.lastOk, ov.firstFail);
            console.log("  Roadmap target: iterative pull rewrite lifts this from a JS-call-stack");
            console.log("  bound to a heap-bound one (matching what 1.3.0 did for the mark phase).");
        }
        if (sweepCutShort) {
            console.log("  Sweep was cut short by overflow before reaching maxDepth=%d.", p.maxDepth);
        }
    }
}
