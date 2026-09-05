/**
 * @zakkster/lite-signal 1.8.0-sidestack (REJECTED BUILD -- do not publish)
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 * --------------------
 * Ledger #13 artifact. This is the batch-revert side stack (Reflex-study
 * pattern C, interleaved stride-3 rev2) that passed the FULL behavioral
 * contract (439/439 suite, smoke, burst/pull structure, VersionMatrix gate)
 * and was rejected on cold-process write probes: +5-9% on capture-dense
 * batched writes, +20% on revert-heavy batches vs the on-node triple, in
 * BOTH the parallel-array and this interleaved layout. The batch-revert
 * fields are not cold -- the first batched write is a hot edge, and the
 * on-node triple rides node.value's cache line. Kept as the measured
 * counter-example closing engine-ledger family (c) in both directions.
 *
 * Original (pre-rejection) header follows.
 * --------------------
 * 1.8.0 -- lean node shape + effect cleanup return (Reflex-study patterns C + A).
 *
 * CHANGED (internal, no public API surface change): the per-node batch-revert
 * triple {preBatchValue, preBatchVersion, revertEpoch} moved off ReactiveNode
 * into a registry-level side stack (three parallel arrays + one SMI
 * `revertSlot` back-pointer per node). Ledger family (c) OPPOSITE direction:
 * #10/#12 moved HOT fields into typed arrays (deopting hot reads); this moves
 * COLD fields (touched only by batched writes) OFF the node. Two fewer node
 * fields; `batchEpoch` retired (guaranteed slot-clearing at batch exit and on
 * mid-batch dispose replaces epoch invalidation); captured pre-batch values
 * are released AT batch exit instead of retained until the node's next
 * capture. Unbatched .set is one `batchDepth` branch, as before.
 *
 * NEW: effect(() => { ...; return cleanup }) -- an effect body may return a
 * cleanup function (Solid/Vue/Reflex-compatible), which runs before the next
 * re-run and on dispose. Composes with imperative onCleanup(fn) in call
 * order. Non-function returns are ignored. Zero cost on bodies that return
 * undefined (one typeof check per effect run, off the mark/pull path).
 *
 * 1.7.0 flushStrategy (eager | sab | manual) + r.flush() carry forward
 * unchanged, including the two-closure .set/boxSet build.
 *
 * Original 1.7.0 header follows.
 *
 * --------------------
 * 1.7.0 -- flushStrategy: registry-level effect-delivery policy.
 *
 * NEW: createRegistry({flushStrategy: "eager" | "sab" | "manual"})
 *   - "eager" (DEFAULT, byte-identical to 1.6.0): .set outside batch auto-flushes;
 *     batch exit auto-flushes. No behavioral change vs 1.6.0 for any existing user.
 *   - "sab" ("stable after batch", matches Andrii Volynets's @volynets/reflex sab
 *     semantics): .set outside batch enqueues effects but does NOT auto-flush;
 *     batch exit DOES flush. Effects deduplicate via FLAG_SCHEDULED across writes.
 *     This is the apples-to-apples comparison mode for the js-reactivity-benchmark
 *     update group, where the eager flushEffects empty-path try/finally was the
 *     dominant per-write overhead on tests that have no effects to deliver
 *     (updateComputations1to1 etc).
 *   - "manual": neither .set nor batch exit auto-flush; only explicit r.flush()
 *     drains the queue. For hard-real-time loops that need frame-aligned settle.
 *
 * NEW: r.flush() -- explicit flush API (no-op if already flushing or queue empty).
 *
 * Hot-path safety: the strategy is resolved ONCE at registry init by selecting
 * one of two pre-built flush hooks (eagerFlushHook | noopFlush). Each .set/.boxSet
 * closure captures a constant function reference for its lifetime; V8 inlines the
 * monomorphic target. In "eager" mode the inlined body is byte-identical to the
 * 1.6.0 inline check (`if (batchDepth === 0) flushEffects()`), preserving the
 * section 0b ledger #6 verdict (per-call closure-var loads are forbidden -- a hoisted
 * function reference + monomorphic inlining is not the same mechanism).
 *
 * Original 1.6.0 header follows.
 *
 * --------------------
 * Hybrid Doubly-Linked-List Reactive Graph Engine -- decoupled (Signal1_3) base
 * with the two 1.1.3 performance fixes ported in:
 *   1. pullComputed clean short-circuit (markEpoch) -- kills the dynamic-graph
 *      regression: "large web app" 4900ms -> 665ms, "wide dense" 4472 -> 952.
 *   2. allocateLink: O(1) tailSub dedup replaces the O(N) prefix scan -- divergent
 *      re-tracking is O(N) not O(N^2) (600-dep flip micro: 1373ms -> 62ms).
 * Ownership tree + L1/L2/L3 layering + observer/owner split are UNCHANGED; they
 * were never the regression. Same EDGE NOTE as 1.1.3 applies to fix (2): a nested
 * re-read of the same source can retain one bounded, dispose-reclaimed link.
 *
 * Original header:
 * Hybrid Doubly-Linked-List Reactive Graph Engine.
 *
 * Performance model:
 * - ReactiveLink DLL object pool guarantees O(1) graph edge allocation.
 * - Inlined O(1) cursor fast-path for stable steady-state reads.
 * - Divergence triggers immediate tail-severing to bound worst-case complexity.
 * - O(1) Owner Context Tree ensures automatic teardown of nested observers.
 *
 * -- ARCHITECTURE: three layers + a public API, with a strict dependency direction --
 *
 *   L1  GRAPH TOPOLOGY      allocateLink, freeLink, severTail
 *       Owns the ReactiveLink pool and the dep/sub doubly-linked lists.
 *       INVARIANT: never touches `owner`/`firstOwned`. Pure edge mechanics.
 *
 *   L2  OWNERSHIP / LIFECYCLE   createNode, disposeNode, runCleanup
 *       Owns the owner tree and node death + user cleanup.
 *       INVARIANT: never touches the `activeObserverCurrentDep` cursor.
 *       Sanctioned downward edge -> L1: disposeNode walks a dying node's own
 *       dep/sub lists and calls freeLink to extract it from the graph.
 *
 *   L3  PROPAGATION / EXECUTION   markDownstream, flushEffects, executeEffect, pullComputed
 *       The engine. markDownstream is itself owner-free and cursor-free
 *       (a pure propagation primitive). executeEffect/pullComputed are the
 *       ORCHESTRATORS: they drive the cursor + severTail (L1) AND, before a
 *       re-run, call runCleanup (L2) to cascade-dispose owned children.
 *       Sanctioned upward call -> L2: executeEffect/pullComputed -> runCleanup.
 *
 *   API  signal, computed, effect, dispose, batch, untrack, onCleanup, stats, destroy
 *
 *   The only cross-layer edges are L3->runCleanup and L2->freeLink. The graph of
 *   dependencies is acyclic; nothing in L1 reaches up, nothing in L2 touches
 *   the cursor, and the engine is the single place the two subsystems meet.
 *
 * -- OWNER vs OBSERVER --
 *   `currentObserver` = the node whose READS establish dependencies (tracking).
 *   `currentOwner`    = the node that OWNS anything created right now (lifecycle).
 *   They move together by default, but are distinct pointers so ownership can be
 *   detached without affecting tracking. createRoot (1.5.0) uses this: it nulls
 *   the OWNER (and OBSERVER) for the duration of a callback so nodes created
 *   inside survive the enclosing scope's re-runs; runWithOwner (re-attaching to a
 *   chosen owner) remains future work on the same split. untrack suppresses
 *   tracking without orphaning created nodes. createNode and onCleanup key off
 *   the OWNER; the read fast-path and allocateLink key off the OBSERVER.
 */

const FLAG_COMPUTED = 1 << 0;
const FLAG_EFFECT = 1 << 1;
const FLAG_QUEUED = 1 << 2;
const FLAG_COMPUTING = 1 << 3;
const FLAG_HAS_ERROR = 1 << 4;

// Hoisted equality default. Object.is lookup is fast under V8 IC but a module-
// scope const is monomorphic without ICs. Replaces the per-call lookup in
// signal() and computed() construction.
const OBJECT_IS = Object.is;
const FLAG_SIGNAL = 1 << 5;

/**
 * Internal: a reactive node (signal, computed, or effect).
 * Lives in a preallocated pool; never released to GC during normal use.
 * @private
 */
class ReactiveNode {
    constructor() {
        /** Bitmask: FLAG_SIGNAL | FLAG_COMPUTED | FLAG_EFFECT | FLAG_QUEUED | FLAG_COMPUTING | FLAG_HAS_ERROR */
        this.flags = 0;
        /** Current value (signal, computed) or error (when FLAG_HAS_ERROR is set). */
        this.value = undefined;
        /** Compute body (computed, effect). */
        this.computeFn = undefined;
        /** Single fn OR array of fns; cleared after invocation. */
        this.cleanupFn = undefined;
        /** Custom equality predicate. Defaults to Object.is. */
        this.equals = undefined;
        /** Optional effect scheduler. */
        this.scheduler = undefined;
        /** Cached gen-bound trampoline that re-enters executeEffect under the scheduler.
         *  Allocated once on the first set with a scheduler; recycled with the slot. (1.2.0) */
        this.schedulerThunk = undefined;

        /** Bumped on every change that mutates value. 32-bit modular. */
        this.version = 0;
        /** Last globalVersion at which this node was re-evaluated. */
        this.evalVersion = 0;
        /** Last globalVersion at which this node was marked dirty (de-duplicates traversal). */
        this.markEpoch = 0;
        /** Recycle generation: bumped on dispose, used to invalidate stale scheduler closures and disposer handles. */
        this.gen = 0;
        /** Stable per-allocation id for introspection/devtools (1.1.5). Reassigned on each allocate-from-pool. */
        this.id = 0;

        /** 1.8.0: live capture slot in the registry's batch-revert side stack;
         *  0 = no capture this batch, else (index + 1). Replaces the on-node
         *  {preBatchValue, preBatchVersion, revertEpoch} triple -- two fewer
         *  fields per node, and the captured value no longer outlives the batch. */
        this.revertSlot = 0;

        // Doubly-linked dependency list (this node depends on these sources).
        this.headDep = null;
        this.tailDep = null;
        // Doubly-linked subscriber list (these targets depend on this node).
        this.headSub = null;
        this.tailSub = null;

        // Owner Context Tree (Auto-Disposal of Nested Observers) -- 1.2.0.
        // An effect/computed created inside another effect/computed is "owned"
        // by it. When the owner re-runs or is disposed, owned children are
        // cascade-disposed before the new run. Plain signals are NOT adopted
        // (so lazy-allocation wrappers like lite-store survive owner re-runs).
        this.owner = null;
        this.prevOwned = null;
        this.nextOwned = null;
        this.firstOwned = null;

        // Pool free-list pointer.
        this.nextFree = null;
        // 1.3.0: Intrusive mark-stack pointer. markDownstream chains visited
        // nodes through this field instead of an external array, eliminating the
        // separate cache line + bounds-check on each push/pop. Always null
        // outside an active markDownstream sweep; cleared on pop and on dispose.
        this.nextMark = null;
    }
}

/**
 * Internal: a directed edge between a source node and a target node.
 * Pool-allocated, never GC'd.
 * @private
 */
class ReactiveLink {
    constructor() {
        this.source = null;
        this.target = null;

        this.prevDep = null;
        this.nextDep = null;
        this.prevSub = null;
        this.nextSub = null;

        this.nextFree = null;
    }
}

/**
 * Thrown when the registry would need to grow beyond its hard ceiling
 * (or {@link RegistryConfig.onCapacityExceeded} is `"throw"` and the pool is full).
 */
export class CapacityError extends Error {
    /**
     * @param {"nodes"|"links"} kind  Which pool was exhausted.
     * @param {number}          capacity  Capacity at the time of the error.
     */
    constructor(kind, capacity) {
        super(`CapacityError: ${kind} capacity (${capacity}) exceeded.`);
        this.name = "CapacityError";
        /** @type {"nodes"|"links"} */
        this.kind = kind;
        /** @type {number} */
        this.capacity = capacity;
    }
}

/**
 * Create an isolated reactive registry.
 *
 * Use this when you need multiple independent reactive graphs (e.g. one per
 * Twitch Extension viewer, one per worker, one per test). The top-level
 * helpers ({@link signal}, {@link effect}, ...) delegate to a single shared
 * default registry; call {@link setDefaultRegistry} to swap that for your own.
 *
 * @param {object} [config]
 * @param {number} [config.maxNodes=1024]            Initial node-pool capacity (ledger).
 * @param {number} [config.maxLinks=maxNodes*4]      Initial link-pool capacity (ledger).
 * @param {"eager"|"lazy"} [config.prealloc="eager"]
 *        Pool population strategy. `"eager"` constructs the full `maxNodes` /
 *        `maxLinks` pools up front -- deterministic latency, zero allocation
 *        inside any subsequent hot path (the contract for render loops, game
 *        ticks, and extension frame budgets), at the cost of a larger resident
 *        heap that every major GC traces. `"lazy"` treats the capacities as
 *        ledgers and constructs nodes/links on first demand, recycling through
 *        the free lists thereafter -- smaller heap, faster cold start, lighter
 *        GC marking, identical zero-GC steady state after warm-up. Choose eager
 *        for hard-real-time, lazy for footprint-sensitive or short-lived registries.
 * @param {"throw"|"grow"} [config.onCapacityExceeded="throw"]
 *        `"throw"` fails fast with a {@link CapacityError} when a pool is full.
 *        `"grow"` extends the pool on a free-list miss. Growth is chunked and
 *        incremental -- contiguous runs of up to 1024 links / 256 nodes per
 *        miss, not a single doubling burst -- so any one growth pause stays
 *        bounded; the capacity ledger still doubles (`stats()` semantics
 *        unchanged). Link growth is bounded by a hard ceiling of `maxLinks * 16`.
 *        Each chunk increments `stats().poolGrowths`.
 * @param {number} [config.maxFlushPasses=100]       Cycle-protection: max effect-queue
 *                                                   drain passes before throwing an
 *                                                   Error prefixed `"CycleError:"`.
 * @returns {Registry}
 */
export function createRegistry(config) {
    const NODE_PTR = Symbol("node_ptr");
    const NODE_GEN = Symbol("node_gen");

    let currentNodesCapacity = (config !== undefined && config.maxNodes !== undefined) ? config.maxNodes : 1024;
    let currentLinkCapacity = (config !== undefined && config.maxLinks !== undefined) ? config.maxLinks : currentNodesCapacity * 4;
    const policy = (config !== undefined && config.onCapacityExceeded !== undefined) ? config.onCapacityExceeded : "throw";
    const maxFlushPasses = (config !== undefined && config.maxFlushPasses !== undefined) ? config.maxFlushPasses : 100;
    const maxLinkLimit = currentLinkCapacity * 16;

    // 1.7: flushStrategy -- selects when effects auto-deliver.
    // "eager" (default, byte-identical to 1.6.0): .set + batch-exit both auto-flush.
    // "sab"   (Reflex-equivalent semantics): only batch-exit auto-flushes.
    // "manual": neither -- only explicit r.flush().
    // Validated here; the hot-path hooks bind to one of two pre-built closures
    // below, near flushEffects.
    const flushStrategy = (config !== undefined && config.flushStrategy !== undefined) ? config.flushStrategy : "eager";
    if (flushStrategy !== "eager" && flushStrategy !== "sab" && flushStrategy !== "manual") {
        throw new Error("flushStrategy must be one of: 'eager', 'sab', 'manual'");
    }

    // Lazy pool population (P1): maxNodes / maxLinks are capacity ledgers,
    // not eager construction counts. Nodes/links are constructed on first
    // demand and recycled through the free lists thereafter -- the zero-GC
    // steady state is identical after warm-up, but the heap no longer carries
    // never-used live objects for every major GC to mark.
    const prealloc = (config !== undefined && config.prealloc !== undefined) ? config.prealloc : "eager";
    const nodePool = [];
    let freeNodeHead = null;
    const linkPool = [];
    let freeLinkHead = null;
    if (prealloc === "eager") {
        for (let i = 0; i < currentNodesCapacity; i++) nodePool[i] = new ReactiveNode();
        freeNodeHead = nodePool[0];
        for (let i = 0; i < currentNodesCapacity - 1; i++) nodePool[i].nextFree = nodePool[i + 1];
        for (let i = 0; i < currentLinkCapacity; i++) linkPool[i] = new ReactiveLink();
        freeLinkHead = linkPool[0];
        for (let i = 0; i < currentLinkCapacity - 1; i++) linkPool[i].nextFree = linkPool[i + 1];
    }

    let activeNodes = 0;
    let activeLinks = 0;
    let statSignals = 0;
    let statComputeds = 0;
    let statEffects = 0;
    // 1.4: cumulative lifecycle counters for churn-rate observability (lite-devtools
    // / lite-studio derive allocationRate, poolReuseRate, avg node lifetime from these).
    // Monotonic across the registry's life; reset only by destroy(). Three integer
    // bumps at existing chokepoints -- no new node fields, no hot-path cost.
    let statTotalAllocations = 0;   // bumped on every createNode (pool pop OR fresh build)
    let statTotalDisposals = 0;     // bumped on every disposeNode
    let statPoolGrowths = 0;        // bumped when a node/link chunk pushes capacity past its ledger
    let statFlushPasses = 0;        // 1.6: bumped per flush pass, ONLY while a mutation-hook
                                    //      listener is attached (gated -> zero cost when detached).

    const effectQueueA = [];
    const effectQueueB = [];
    let activeQueue = effectQueueA;
    let activeQueueLen = 0;
    let isQueueA = true;

    let globalVersion = 1;
    // 1.8.0: batch-revert side stack (lean node shape, Reflex-study pattern C).
    // The per-node batch-revert triple {preBatchValue, preBatchVersion,
    // revertEpoch} moved OFF ReactiveNode into three parallel capture arrays,
    // populated only on the first write to a node inside a batch. The node
    // keeps ONE SMI field (`revertSlot`, 0 = no live capture, else index+1)
    // for O(1) mid-batch access to its capture. The stack is drained at
    // outermost batch exit (and each entry invalidated on mid-batch dispose),
    // which also releases the captured value reference at batch exit -- the
    // on-node design retained `preBatchValue` until the NEXT capture.
    // `batchEpoch` is gone: guaranteed slot-clearing at exit/dispose replaces
    // epoch invalidation outright. Growth uses packed `arr[len++]` appends
    // (the effect-queue convention); steady-state batches under the high-water
    // mark allocate nothing.
    // rev2: ONE interleaved stride-3 stack [node, value, version, ...] --
    // a capture touches one cache line, not three parallel arrays. revertTop
    // is the next free BASE index (multiple of 3); node.revertSlot stores
    // (base + 3) so 0 keeps meaning "no capture".
    const revertStack = [];
    let revertTop = 0;
    let currentObserver = null;           // tracking context: whose reads link deps
    let currentOwner = null;              // lifecycle context: who owns nodes created now
    let activeObserverCurrentDep = null;
    let batchDepth = 0;
    let isTrackingDeps = false;

    // -- Node identity + observer-lifecycle introspection (ported from 1.1.5) --
    let nodeSeq = 1 | 0;
    let lifecycleCount = 0 | 0;
    const lifecycleMap = new WeakMap();
    function fireConnect(node) {
        const e = lifecycleMap.get(node);
        if (e === undefined || e.onConnect === undefined) return;
        const po = currentObserver, pt = isTrackingDeps;
        currentObserver = null; isTrackingDeps = false;
        try { e.onConnect(); } finally { currentObserver = po; isTrackingDeps = pt; }
    }
    function fireDisconnect(node) {
        const e = lifecycleMap.get(node);
        if (e === undefined || e.onDisconnect === undefined) return;
        const po = currentObserver, pt = isTrackingDeps;
        currentObserver = null; isTrackingDeps = false;
        try { e.onDisconnect(); } finally { currentObserver = po; isTrackingDeps = pt; }
    }
    let isFlushing = false;

    const flushErrorBuffer = [];
    let flushErrorCount = 0;

    // === L1 * GRAPH TOPOLOGY ======================================
    // Owns the ReactiveLink pool and the dep/sub lists. Pure edge mechanics:
    // INVARIANT -- must never touch node.owner / firstOwned.

    // --- HYBRID ALLOCATOR -----------------------------------------

    /**
     * Establish (or reuse) a dependency link from `source` -> `target`.
     *
     * Fast path: cursor match (re-tracking same dep at same position) -- O(1), no allocation.
     * Mid path: O(1) tailSub dedup (1.1.4 rewrite) -- divergent retracking stays O(N) overall,
     *           not O(N^2).
     * Cold path: pool exhausted -> grow or throw per policy.
     *
     * SEVER-FIRST: on a cursor-miss divergence the unmatched dep tail is freed
     * BEFORE any new link is allocated, so peak link usage never exceeds steady
     * state (zero pool debt) and a divergent re-track cannot trigger mid-compute
     * pool growth under tight maxLinks + "throw".
     *
     * EDGE NOTE: a node that reads the SAME source twice within one body, with a
     * nested computed that also reads that source evaluated in between, retains
     * one redundant link per intervening observer for the node's lifetime. Value-
     * correct, bounded (does not grow across re-tracks), and reclaimed on dispose.
     *
     * @private
     */
        // --- Graph-mutation hook (1.2.1 keystone prototype) ---------------------
        // Single nullable listener; every fire point is `if (mutationHook !== null)`
        // -- branch-predicted free when absent, allocation-free when present
        // (opcode + two int args). Enables push-based devtools (watchGraph) and the
        // recompute profiler. Opcodes: 1 node-create, 2 node-dispose, 3 link-add,
        // 4 link-remove, 5 recompute, 6 flush-pass-start (a=pass#, b=effects this pass),
        // 7 effect-enqueue (a=node id). 6/7 added in 1.6 for burst/flush profiling.
    let mutationHook = null;
    function onGraphMutation(fn) {
        if (fn !== null && typeof fn !== "function") throw new TypeError("onGraphMutation: listener must be a function or null");
        const prev = mutationHook;
        mutationHook = fn;
        return () => { if (mutationHook === fn) mutationHook = prev; };
    }

    function allocateLink(source, target) {
        // Eligibility gate (restored from 1.1.5): an observer disposed mid-run (self-dispose, or
        // an outer observer torn down while suspended) has flags cleared to 0. Linking would splice
        // a dead, pool-bound node back into source's subscriber list -- a phantom edge. Cold path only.
        if (target.flags === 0) return null;
        let expected = activeObserverCurrentDep;

        if (expected !== null) {
            let stale = expected;
            let prev = stale.prevDep;
            if (prev !== null) prev.nextDep = null; else target.headDep = null;
            target.tailDep = prev;

            while (stale !== null) {
                let next = stale.nextDep;
                freeLink(stale, target, stale.source);
                stale = next;
            }
            activeObserverCurrentDep = null;
        }

        // O(1) same-pass dedup (ported from 1.1.3): replaces the O(N) prefix scan
        // that made divergent re-tracking O(N^2). If this source was already
        // linked to this target during THIS pass, its sub-list tail points at us.
        const lastSub = source.tailSub;
        if (lastSub !== null && lastSub.target === target) return;

        let link;
        if (freeLinkHead === null) {
            if (policy === "throw" && linkPool.length >= currentLinkCapacity) throw new CapacityError("links", currentLinkCapacity);
            // Incremental growth (P0): construct links on a free-list miss instead
            // of doubling with an eager construction burst. The capacity LEDGER
            // still doubles (stats() / ceiling semantics are unchanged) -- only the
            // physical allocation is amortized. Eliminates multi-ms pauses in hot loops.
            if (linkPool.length >= maxLinkLimit) throw new CapacityError("links", maxLinkLimit);
            // Chunked refill (P1 rev2): construct a CONTIGUOUS run of links on a
            // miss. Restores eager-pool heap locality for traversal-heavy graphs
            // (lazy one-at-a-time construction interleaves pool objects with
            // user allocations and costs 10-25% on dynamic/large-graph shapes)
            // while keeping pauses bounded (~chunk x ~0.5us) and startup lazy.
            let limit = (policy === "throw") ? currentLinkCapacity : maxLinkLimit;
            let chunk = limit - linkPool.length;
            if (chunk > 1024) chunk = 1024;
            link = new ReactiveLink();
            linkPool.push(link);
            for (let i = 1; i < chunk; i++) {
                const l = new ReactiveLink();
                linkPool.push(l);
                l.nextFree = freeLinkHead;
                freeLinkHead = l;
            }
            if (linkPool.length > currentLinkCapacity) {
                let doubled = currentLinkCapacity;
                while (doubled < linkPool.length) doubled *= 2;
                currentLinkCapacity = doubled > maxLinkLimit ? maxLinkLimit : doubled;
                statPoolGrowths++;   // 1.4: link capacity ledger crossed
            }
        } else {
            link = freeLinkHead;
            freeLinkHead = link.nextFree;
            link.nextFree = null;
        }
        activeLinks = (activeLinks + 1) | 0;

        link.source = source;
        link.target = target;

        link.nextSub = null;
        link.prevSub = source.tailSub;
        const _was0 = lifecycleCount !== 0 && source.headSub === null;   // 0->1 detect (pre-link)
        if (source.tailSub !== null) source.tailSub.nextSub = link;
        else source.headSub = link;
        source.tailSub = link;
        if (_was0) fireConnect(source);

        let tail = target.tailDep;
        link.prevDep = tail;
        link.nextDep = null;
        if (tail !== null) tail.nextDep = link;
        else target.headDep = link;
        target.tailDep = link;
        if (mutationHook !== null) mutationHook(3, source.id, target.id);
    }

    /** Return a link to the free pool and unlink it from the source's sub list. @private */
    function freeLink(link, target, source) {
        if (mutationHook !== null) mutationHook(4, link.source !== null ? link.source.id : -1, link.target !== null ? link.target.id : -1);
        const pSub = link.prevSub;
        const nSub = link.nextSub;
        if (pSub !== null) pSub.nextSub = nSub; else source.headSub = nSub;
        if (nSub !== null) nSub.prevSub = pSub; else source.tailSub = pSub;
        if (lifecycleCount !== 0 && source.headSub === null) fireDisconnect(source);   // 1->0

        link.source = null;
        link.target = null;
        link.prevDep = null;
        link.nextDep = null;
        link.prevSub = null;
        link.nextSub = null;

        link.nextFree = freeLinkHead;
        freeLinkHead = link;
        activeLinks = (activeLinks - 1) | 0;
    }

    /**
     * Free any tail links not visited during the current re-tracking pass.
     * Called from executeEffect / pullComputed after the body returns: anything
     * still reachable from `activeObserverCurrentDep` is a stale dep from the
     * previous run and gets returned to the pool.
     * @private
     */
    function severTail(node) {
        let stale = activeObserverCurrentDep;
        if (stale !== null) {
            let prev = stale.prevDep;
            if (prev !== null) prev.nextDep = null; else node.headDep = null;
            node.tailDep = prev;

            while (stale !== null) {
                let next = stale.nextDep;
                freeLink(stale, node, stale.source);
                stale = next;
            }
        }
    }

    // === L2 * OWNERSHIP / LIFECYCLE ===============================
    // Owns the owner tree, node death, and user cleanup.
    // INVARIANT -- must never touch the activeObserverCurrentDep cursor.
    // Sanctioned downward edge -> L1: disposeNode calls freeLink to extract a
    // dying node from the graph.

    // --- LIFECYCLE & OWNERSHIP ---------------------------------------

    function disposeNode(node) {
        if (mutationHook !== null) mutationHook(2, node.id, node.flags | 0);
        if (node.flags === 0) return;

        // RACE WITH ACTIVE TRACKING: an effect/computed may call dispose on
        // itself from inside its own body (#141). Once we tear the node down
        // its dep-list, FLAG_COMPUTING, and cursor become stale immediately --
        // any read() that runs in the REST of the body would otherwise try to
        // hang a fresh link off a freed slot. Null the tracking state now so
        // subsequent reads in this call stack become no-ops, and let
        // executeEffect / pullComputed skip their finally-block bookkeeping
        // via the gen-snapshot guard there.
        if (currentObserver === node) {
            currentObserver = null;
            activeObserverCurrentDep = null;
            isTrackingDeps = false;
        }
        if (currentOwner === node) {
            currentOwner = null;
        }

        // Live per-kind count: decrement here -- the single chokepoint every teardown
        // path funnels through (owner cascade at the firstOwned loop, the effect
        // disposer, and dispose(api)). Keyed off flags BEFORE they are cleared lower
        // in this function; the guard above makes it double-dispose-safe. This is what
        // keeps stats() honest: signals + computeds + effects === activeNodes holds
        // under owner-cascade disposal, not just explicit dispose.
        const f = node.flags;
        if ((f & FLAG_SIGNAL) !== 0) statSignals--;
        else if ((f & FLAG_COMPUTED) !== 0) statComputeds--;
        else if ((f & FLAG_EFFECT) !== 0) statEffects--;

        // O(1) detach from parent to avoid modifying list during parent iteration
        if (node.owner !== null) {
            if (node.prevOwned !== null) node.prevOwned.nextOwned = node.nextOwned;
            else node.owner.firstOwned = node.nextOwned;
            if (node.nextOwned !== null) node.nextOwned.prevOwned = node.prevOwned;
            node.owner = null;
            node.prevOwned = null;
            node.nextOwned = null;
        }

        runCleanup(node);

        // CROSS-EDGE L2->L1: extract this node's own edges from the graph.
        let dLink = node.headDep;
        while (dLink !== null) {
            const next = dLink.nextDep;
            freeLink(dLink, node, dLink.source);
            dLink = next;
        }

        let sLink = node.headSub;
        while (sLink !== null) {
            const target = sLink.target;
            const next = sLink.nextSub;

            const pDep = sLink.prevDep;
            const nDep = sLink.nextDep;
            if (pDep !== null) pDep.nextDep = nDep; else target.headDep = nDep;
            if (nDep !== null) nDep.prevDep = pDep; else target.tailDep = pDep;

            sLink.source = null;
            sLink.target = null;
            sLink.prevDep = null;
            sLink.nextDep = null;
            sLink.prevSub = null;
            sLink.nextSub = null;
            sLink.nextFree = freeLinkHead;
            freeLinkHead = sLink;
            activeLinks = (activeLinks - 1) | 0;

            sLink = next;
        }

        node.computeFn = undefined;
        node.cleanupFn = undefined;
        node.scheduler = undefined;
        node.schedulerThunk = undefined;  // drop closure; recycle rebuilds it
        node.value = undefined;
        node.equals = undefined;
        node.flags = 0;
        node.headDep = null;
        node.tailDep = null;
        node.headSub = null;
        node.tailSub = null;
        // 1.8.0: a node disposed MID-BATCH may hold a live capture in the
        // revert side stack. Invalidate the entry (the exit drain skips nulls)
        // BEFORE the slot is cleared -- the pool may recycle this node into a
        // new role inside the same batch, and the new resident must not
        // inherit a stale slot pointing at the old capture.
        const rSlot = node.revertSlot;
        if (rSlot !== 0) {
            revertStack[rSlot - 3] = null;
            revertStack[rSlot - 2] = undefined;
            node.revertSlot = 0;
        }
        node.nextMark = null;   // 1.3.0: defensive -- disposal during a sweep shouldn't happen, but ensures clean state

        node.gen = (node.gen + 1) | 0;
        node.nextFree = freeNodeHead;
        freeNodeHead = node;
        activeNodes = (activeNodes - 1) | 0;
        statTotalDisposals++;   // 1.4: every node returned to the pool
    }

    /**
     * Claim a node from the free pool, reinitialise, and return it.
     * Grows pool per `policy` if exhausted (or throws CapacityError under "throw").
     * Adopts the new node into `currentOwner` if there is one AND the new node is
     * an observer (computed/effect) -- plain signals are not adopted (see ReactiveNode
     * comment on the owner tree).
     * @private
     */
    function createNode(value, flags) {
        let node;
        if (freeNodeHead === null) {
            if (policy === "throw" && nodePool.length >= currentNodesCapacity) throw new CapacityError("nodes", currentNodesCapacity);
            // Incremental growth (P0): chunked construction on a free-list miss;
            // ledger doubles for stats() continuity. The effect queues are no
            // longer length-extended here: `arr.length = n` converts a PACKED
            // array to HOLEY permanently (a hidden flush-path tax); sequential
            // `arr[len++] = x` appends keep them packed and auto-grow. (markStack
            // is gone entirely as of 1.3.0's intrusive mark stack.)
            let chunk = (policy === "throw") ? (currentNodesCapacity - nodePool.length) : 256;
            if (chunk > 256) chunk = 256;
            node = new ReactiveNode();
            nodePool.push(node);
            for (let i = 1; i < chunk; i++) {
                const n = new ReactiveNode();
                nodePool.push(n);
                n.nextFree = freeNodeHead;
                freeNodeHead = n;
            }
            if (nodePool.length > currentNodesCapacity) {
                let doubled = currentNodesCapacity;
                while (doubled < nodePool.length) doubled *= 2;
                currentNodesCapacity = doubled;
                statPoolGrowths++;   // 1.4: capacity ledger crossed
            }
        } else {
            node = freeNodeHead;
            freeNodeHead = node.nextFree;
            node.nextFree = null;
        }
        activeNodes = (activeNodes + 1) | 0;
        statTotalAllocations++;   // 1.4: every node acquired (pool pop or fresh build)

        // 1.2.3: Clean free-list invariant (Andrii's recommendation).
        //
        // Every node leaving the pool is guaranteed-clean for the five fields
        // {headDep, tailDep, headSub, tailSub, revertSlot}: dispose() clears
        // them on the recycle path (revertSlot via the 1.8.0 mid-batch capture
        // invalidation), and the
        // ReactiveNode constructor initializes them to the same values on the
        // fresh-allocation path (chunked refill above). Re-writing them
        // here was defense against a state that cannot exist.
        //
        // What stays: fields that define the new lifetime (value, flags, id,
        // firstOwned, conditional owner-tree wiring) AND fields dispose does
        // not touch (version, evalVersion, markEpoch -- used by the propagation
        // and pull machinery, must be reset for the new lifetime).
        node.value = value;
        node.flags = flags | 0;
        node.version = 0;
        node.evalVersion = 0;
        node.markEpoch = 0;
        node.id = nodeSeq; nodeSeq = (nodeSeq + 1) | 0;   // fresh identity per allocation (ported from 1.1.5)

        // Wire into Owner Context (lifecycle, not tracking -- keyed off currentOwner).
        // ONLY observers (computed/effect) are adopted: a re-running owner disposes
        // its nested observers (which would otherwise leak dep links), but plain
        // signals have no deps to leak, and disposing them breaks lazy-allocation
        // libraries (lite-store allocates a key's signal on first read, INSIDE the
        // reading computed -- adopting it meant that computed's next run wiped the
        // store key). Signals are therefore never owner-adopted.
        //
        // 1.2.3 clean free-list invariant (extended to the owner tree):
        // owner / prevOwned / firstOwned are all guaranteed-null on every node
        // leaving the pool. Both teardown paths null them -- disposeNode (lines
        // ~451-453) on direct dispose, runCleanup (lines ~609-615) on parent
        // cascade -- and the ReactiveNode constructor inits them to null on the
        // fresh-allocation path. The three former null-writes here (firstOwned,
        // the adoption-path prevOwned, and the else-branch owner) were defense
        // against a state that cannot exist. Only the writes that establish the
        // NEW lifetime remain: owner + nextOwned + the parent's chain splice on
        // the adoption path. nextOwned is written unconditionally on adoption
        // (it takes the prior firstOwned, which may be non-null), so it is a
        // real lifetime write, not a redundant clear.
        if (currentOwner !== null && (flags & (FLAG_COMPUTED | FLAG_EFFECT)) !== 0) {
            node.owner = currentOwner;
            node.nextOwned = currentOwner.firstOwned;
            if (currentOwner.firstOwned !== null) {
                currentOwner.firstOwned.prevOwned = node;
            }
            currentOwner.firstOwned = node;
        }

        if (mutationHook !== null) mutationHook(1, node.id, node.flags | 0);
        return node;
    }

    /**
     * Cascade-dispose owned children inside-out (deepest first), then invoke this
     * node's own cleanup if any. Cascade order is the v1.2 conformance fix for
     * #238 / #241 / #243 -- nested cleanups must fire grandchild -> child -> outer
     * so that a parent's cleanup still sees its own state intact.
     * @private
     */
    function runCleanup(node) {
        // Cascade children FIRST -- deepest cleanups fire before shallowest.
        // This matches the universal invariant in the upstream conformance suite
        // (#238 / #241 / #243): nested cleanups run inside-out on owner-tree
        // disposal, mirroring the parent-knows-best assumption shared with
        // React / Solid (children may rely on parent state being live at their
        // cleanup time, but never the reverse).
        let child = node.firstOwned;
        while (child !== null) {
            let next = child.nextOwned;
            // Detach immediately to optimise disposeNode processing
            child.owner = null;
            child.prevOwned = null;
            child.nextOwned = null;
            disposeNode(child);
            child = next;
        }
        node.firstOwned = null;

        // Then this node's own cleanup.
        const cleanup = node.cleanupFn;
        if (cleanup !== undefined) {
            const prevObserver = currentObserver;
            const prevOwner = currentOwner;
            const prevTracking = isTrackingDeps;
            currentObserver = null;
            currentOwner = null;
            isTrackingDeps = false;
            try {
                if (typeof cleanup === "function") cleanup();
                else for (let i = 0; i < cleanup.length; i++) cleanup[i]();
            } finally {
                node.cleanupFn = undefined;
                currentObserver = prevObserver;
                currentOwner = prevOwner;
                isTrackingDeps = prevTracking;
            }
        }
    }

    // === L3 * PROPAGATION / EXECUTION =============================
    // markDownstream is owner-free AND cursor-free (a pure propagation
    // primitive). executeEffect/pullComputed are the orchestrators: they drive
    // the cursor + severTail (L1) and, before a re-run, call runCleanup (L2) to
    // cascade-dispose owned children. Sanctioned upward call -> L2: runCleanup.

    // --- EXECUTION ENGINE -----------------------------------------

    /**
     * Mark all transitive subscribers of `startNode` dirty.
     * 1.3.0: Iterative DFS backed by an intrusive linked-list stack (`nextMark`)
     * instead of an external array (the iterative property itself is retained
     * from 1.2.4) -- eliminates array bounds checks and consolidates the touched
     * memory to the node's own cache line (we already loaded `t` to check
     * t.markEpoch, so writing t.nextMark is in-cache).
     * Effects are enqueued for the flush phase; computeds are merely marked
     * (their re-evaluation is lazy -- triggered by the next read).
     * @private
     */
    function markDownstream(startNode) {
        const gv = globalVersion;   // hoist invariant module-scope read into a local
        let markHead = startNode;
        startNode.nextMark = null;

        while (markHead !== null) {
            const n = markHead;
            markHead = n.nextMark;
            n.nextMark = null;       // clear on pop; chain stays clean for future sweeps

            let link = n.headSub;
            while (link !== null) {
                const t = link.target;
                if (t.markEpoch !== gv) {
                    t.markEpoch = gv;
                    const flags = t.flags;

                    if ((flags & FLAG_EFFECT) !== 0) {
                        if ((flags & (FLAG_QUEUED | FLAG_COMPUTING)) === 0) {
                            t.flags = flags | FLAG_QUEUED;
                            activeQueue[activeQueueLen++] = t;
                            // 1.6: op 7, effect enqueued. Gated; the ONE insertion inside the
                            // markDownstream inner loop -> gate-check KAIROS/MUX before shipping.
                            if (mutationHook !== null) mutationHook(7, t.id, 0);
                        }
                    } else {
                        // Intrusive push: t.nextMark holds the prior head
                        t.nextMark = markHead;
                        markHead = t;
                    }
                }
                link = link.nextSub;
            }
        }
    }

    /**
     * Drain the effect queue. Double-buffered (effectQueueA / effectQueueB) so
     * effects scheduled mid-flush land in the next pass. Individual effect throws
     * are caught and buffered; at end-of-flush a single throw is rethrown directly,
     * multiple throws are aggregated into an `AggregateError` (1.2.0). Exceeds
     * `maxFlushPasses` (default 100) -> Error prefixed `"CycleError:"`.
     * @private
     */
    function flushEffects() {
        if (isFlushing) return;
        isFlushing = true;
        let passes = 0;
        let normalExit = false;

        try {
            while (activeQueueLen > 0) {
                if (++passes > maxFlushPasses) throw new Error("CycleError: flush passes exceeded");
                const toRun = activeQueueLen | 0;
                // 1.6 burst/flush instrumentation. Gated on the hook -> zero cost when no
                // profiler is attached; statFlushPasses advances only while observed.
                if (mutationHook !== null) { statFlushPasses = (statFlushPasses + 1) | 0; mutationHook(6, passes, toRun); }
                const currentQueue = activeQueue;

                isQueueA = !isQueueA;
                activeQueue = isQueueA ? effectQueueA : effectQueueB;
                activeQueueLen = 0;

                for (let i = 0; i < toRun; i++) {
                    const node = currentQueue[i];
                    try {
                        const scheduler = node.scheduler;
                        if (scheduler) {
                            scheduler(node.schedulerThunk);  // reuse cached thunk
                        } else {
                            if ((node.flags & FLAG_EFFECT) !== 0) executeEffect(node);
                        }
                    } catch (err) {
                        flushErrorBuffer[flushErrorCount++] = err;
                    }
                }
            }
            normalExit = true;
        } finally {
            isFlushing = false;
            if (!normalExit) {
                for (let i = 0; i < flushErrorCount; i++) flushErrorBuffer[i] = null;
                flushErrorCount = 0;
            }
        }

        if (flushErrorCount > 0) {
            if (flushErrorCount === 1) {
                const err = flushErrorBuffer[0];
                flushErrorBuffer[0] = null;
                flushErrorCount = 0;
                throw err;
            }
            const errs = flushErrorBuffer.slice(0, flushErrorCount);
            for (let i = 0; i < flushErrorCount; i++) flushErrorBuffer[i] = null;
            flushErrorCount = 0;
            throw new AggregateError(errs, "Effects threw during flush");
        }
    }

    // 1.7: flushStrategy hot-path lever (REVISION).
    //
    // The first 1.7 implementation captured a function reference (flushAfterWrite)
    // and called it from .set / boxSet. V8 did NOT inline that reference on this
    // workload -- eager-mode .set measured 16-65% slower than 1.6.0 on Andrii's
    // updateComputations* tests because every set paid a function-call indirection.
    //
    // This revision encodes the strategy as a closure-captured BOOLEAN const
    // (FLUSH_ON_IDLE_WRITE / FLUSH_ON_BATCH_EXIT) and inlines the conditional
    // directly into the .set / boxSet / batch bodies. V8 captures the booleans as
    // hidden-class constants and can fold them at JIT time: for "eager", the
    // emitted code is byte-identical to 1.6.0's `if (batchDepth === 0) flushEffects()`.
    // For "sab"/"manual", the `FLUSH_ON_IDLE_WRITE && ...` short-circuits on the
    // const-false; V8 elides the whole branch after one tier-up.
    //
    // This is NOT ledger #6 (per-call closure-var load of a PRIMITIVE that V8
    // can't fold). The literals here are immutable for the registry's lifetime
    // (declared `const`, never reassigned), which gives V8's JIT the constant-
    // folding hook it needs.
    const FLUSH_ON_IDLE_WRITE = (flushStrategy === "eager");
    const FLUSH_ON_BATCH_EXIT = (flushStrategy !== "manual");

    /**
     * Explicit flush API (1.7). Drains the effect queue if not already flushing.
     * Available in every mode. In "manual" mode this is the ONLY way effects run
     * outside of explicit batch boundaries with non-manual strategy.
     *
     * Safe to call from any state: re-entrant calls are no-ops (`isFlushing`
     * guard inside flushEffects), and an empty queue exits immediately.
     */
    function flush() {
        flushEffects();
    }

    /**
     * Run an effect's compute body, re-tracking dependencies.
     * Short-circuits if no dependency has bumped its version since last eval.
     * If the body self-disposes (node.gen advances during the body), skips the
     * post-body bookkeeping (severTail, flag clear, evalVersion bump) -- that
     * gen-snapshot guard is the v1.2 conformance fix for #141.
     * @private
     */
    function executeEffect(node) {
        if ((node.flags & FLAG_COMPUTING) !== 0) throw new Error("CycleError: Infinite effect loop detected.");

        if (node.evalVersion !== 0) {
            let link = node.headDep;
            const evalVer = node.evalVersion | 0;
            let needsRun = false;

            while (link !== null) {
                const dep = link.source;
                if ((dep.flags & FLAG_COMPUTED) !== 0) pullComputed(dep);
                if (((dep.version - evalVer) | 0) > 0) {
                    needsRun = true;
                    break;
                }
                link = link.nextDep;
            }

            if (!needsRun) {
                node.flags &= ~FLAG_QUEUED;
                node.evalVersion = globalVersion;
                return;
            }
        }

        node.flags = (node.flags & ~FLAG_QUEUED) | FLAG_COMPUTING;
        runCleanup(node);   // CROSS-EDGE L3->L2: dispose owned children before re-run
        if ((node.flags & FLAG_EFFECT) === 0) return;

        const prevObserver = currentObserver;
        const prevOwner = currentOwner;
        const prevActiveDep = activeObserverCurrentDep;
        const prevTracking = isTrackingDeps;

        currentObserver = node;
        currentOwner = node;
        activeObserverCurrentDep = node.headDep;
        isTrackingDeps = true;

        // SELF-DISPOSE DETECTION: snapshot the gen. disposeNode bumps gen,
        // so if it advanced during the body the node was disposed (and may
        // already have been recycled into a different role). Skip the
        // dep-list / flag / version mutations in that case -- they would
        // either crash on the freed link list or corrupt the new resident.
        const savedGen = node.gen;
        if (mutationHook !== null) mutationHook(5, node.id, 0);
        try {
            // 1.8.0 (Reflex pattern A): an effect body may RETURN a cleanup
            // function -- Solid/Vue-compatible ergonomics for the existing
            // imperative onCleanup(fn). The returned fn runs before the next
            // re-run and on dispose, appended with the exact onCleanup
            // append semantics (single fn -> pair array -> push), so the two
            // registration styles compose in call order. Non-function returns
            // are ignored; a self-disposed body (gen advanced) registers
            // nothing -- the slot may already host a new resident.
            const ret = node.computeFn();
            if (typeof ret === "function" && node.gen === savedGen) {
                const existing = node.cleanupFn;
                if (existing === undefined) node.cleanupFn = ret;
                else if (typeof existing === "function") node.cleanupFn = [existing, ret];
                else existing.push(ret);
            }
        } finally {
            if (node.gen === savedGen) {
                severTail(node);
                node.flags &= ~FLAG_COMPUTING;
                node.evalVersion = globalVersion;
            }
            currentObserver = prevObserver;
            currentOwner = prevOwner;
            activeObserverCurrentDep = prevActiveDep;
            isTrackingDeps = prevTracking;
        }
    }

    /**
     * Resolve a computed node's current value: re-run if a dependency has changed
     * since last evaluation, else return cached value. The clean-read short-circuit
     * via markEpoch (1.1.4) returns the cached value in O(1) when no mark landed
     * in this node's transitive cone since the last eval, instead of walking the
     * whole dependency subtree.
     *
     * Errors thrown by computeFn are captured in `node.value` with FLAG_HAS_ERROR;
     * subsequent reads re-throw until a dependency change re-runs computeFn.
     *
     * Same gen-snapshot self-dispose guard as executeEffect -- see #141 fix.
     *
     * @private
     */
    function pullComputed(node) {
        if (node.evalVersion === globalVersion) {
            if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;
            return node.value;
        }

        // CLEAN SHORT-CIRCUIT (ported from 1.1.3): markDownstream already stamps
        // markEpoch on the changed signal's whole cone; if no mark landed since
        // our last eval, the cached value is valid -> skip the dep walk. O(1).
        if (node.evalVersion !== 0 && ((node.markEpoch - node.evalVersion) | 0) <= 0) {
            node.evalVersion = globalVersion | 0;
            if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;
            return node.value;
        }

        let shouldRun = node.evalVersion === 0;
        if (!shouldRun) {
            let link = node.headDep;
            const evalVer = node.evalVersion | 0;
            while (link !== null) {
                const dep = link.source;
                if ((dep.flags & FLAG_COMPUTED) !== 0) pullComputed(dep);
                if (((dep.version - evalVer) | 0) > 0) {
                    shouldRun = true;
                    break;
                }
                link = link.nextDep;
            }
        }

        if (shouldRun) {
            if ((node.flags & FLAG_COMPUTING) !== 0) throw new Error("CycleError: Circular dependency detected.");
            node.flags |= FLAG_COMPUTING;
            runCleanup(node);   // CROSS-EDGE L3->L2: dispose owned children before recompute

            const prevObserver = currentObserver;
            const prevOwner = currentOwner;
            const prevActiveDep = activeObserverCurrentDep;
            const prevTracking = isTrackingDeps;

            currentObserver = node;
            currentOwner = node;
            activeObserverCurrentDep = node.headDep;
            isTrackingDeps = true;

            // Same self-dispose detection as executeEffect -- see comment there.
            const savedGen = node.gen;
            if (mutationHook !== null) mutationHook(5, node.id, 0);
            try {
                const newValue = node.computeFn();
                const eq = node.equals;
                if (node.evalVersion === 0 || !eq || !eq(node.value, newValue)) {
                    node.value = newValue;
                    node.version = globalVersion;
                }
                node.flags &= ~FLAG_HAS_ERROR;
            } catch (err) {
                if (node.gen === savedGen) {
                    node.value = err;
                    node.flags |= FLAG_HAS_ERROR;
                    node.version = globalVersion;
                } else {
                    // The body disposed `node` and then threw. The error has
                    // nowhere to land -- the caller of the read that triggered
                    // this pull has already had its tracking state torn down.
                    // Swallow rather than corrupt a recycled slot. The
                    // canonical thrown-computed test (#168 / cached error)
                    // does NOT self-dispose, so this branch isn't reachable
                    // from the conformance set.
                }
            } finally {
                if (node.gen === savedGen) {
                    severTail(node);
                    node.flags &= ~FLAG_COMPUTING;
                }
                currentObserver = prevObserver;
                currentOwner = prevOwner;
                activeObserverCurrentDep = prevActiveDep;
                isTrackingDeps = prevTracking;
            }
        }

        if (node.flags === 0) return undefined;   // disposed during body
        node.evalVersion = globalVersion;
        if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;
        return node.value;
    }

    // --- PUBLIC API --------------------------------------------------

    // --- shared accessor methods (one set per registry, not per primitive) -------
    // update/subscribe are method-invoked (s.update(fn), s.subscribe(fn)), so `this`
    // is the read function and this[NODE_PTR] is the node. set() and peek() stay
    // closures: set() is the hot write path (a closure over `node` beats the
    // this[NODE_PTR] load and keeps `const {set} = signal()` working), and peek()'s
    // body is too cheap to absorb the node recovery.
    function sharedUpdate(fn) { return this.set(fn(this[NODE_PTR].value)); }
    function sharedSubscribe(fn) {
        const read = this;
        return effect(() => {
            const val = read();
            const prevTracking = isTrackingDeps;
            isTrackingDeps = false;
            try {
                fn(val);
            } finally {
                isTrackingDeps = prevTracking;
            }
        });
    }
    // Shared peeks (one per registry, not per primitive). Save one closure
    // allocation per signal/computed creation versus the previous per-instance
    // arrows. Method-invoked, so `this` is the read function and this[NODE_PTR]
    // is the node. Signal: direct value read. Computed: pull (still respects
    // the cached/short-circuit fast paths since pullComputed handles them).
    function sharedSignalPeek() {
        const node = this[NODE_PTR];
        if (this[NODE_GEN] !== node.gen) return undefined;   // stale handle: slot recycled (ABA guard, matches read())
        return node.value;
    }
    function sharedComputedPeek() {
        const node = this[NODE_PTR];
        if (this[NODE_GEN] !== node.gen) return undefined;
        return pullComputed(node);
    }

    /**
     * Create a reactive signal.
     *
     * @template T
     * @param {T} initial            Initial value.
     * @param {object} [opts]
     * @param {(a:T,b:T)=>boolean} [opts.equals=Object.is]
     *        Equality predicate. Returning true short-circuits notification.
     * @returns {Signal<T>}
     */
    function signal(initial, opts) {
        const node = createNode(initial, FLAG_SIGNAL);
        node.equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : OBJECT_IS;
        node.version = globalVersion;
        statSignals++;

        // birthGen pinned at construction. The set/read closures check
        // `node.gen === birthGen` to detect stale handles after dispose +
        // pool-slot recycling. Without this, a retained set() from a disposed
        // signal can overwrite the recycled slot's new resident; a retained
        // read() inside an active observer can create a phantom subscription
        // to the recycled slot. See probe-c1-stale-set.mjs / probe-c1-stale-read.mjs.
        const birthGen = node.gen;

        const read = () => {
            if (node.gen !== birthGen) return undefined;
            if (isTrackingDeps && currentObserver !== null) {
                let expected = activeObserverCurrentDep;
                if (expected !== null && expected.source === node) {
                    activeObserverCurrentDep = expected.nextDep;
                } else {
                    allocateLink(node, currentObserver);
                }
            }
            return node.value;
        };

        read.peek = sharedSignalPeek;
        // set stays a CLOSURE (byte-identical to 1.2.0): its call path is the hot
        // path, and a closure over `node` beats a shared method's this[NODE_PTR]
        // load. Keeping it a closure also restores detached `const {set}=signal()`.
        //
        // 1.7: TWO closures, selected once at signal creation by FLUSH_ON_IDLE_WRITE.
        // The closure-captured boolean approach (a single .set with
        // `if (FLUSH_ON_IDLE_WRITE && batchDepth === 0)`) measured +16-30% slower
        // than 1.6.0 on Andrii's updateComputations* tests -- V8 doesn't
        // constant-fold closure-captured `const` booleans on this hot path
        // (they live in a context slot, not a literal in bytecode). Splitting at
        // build time keeps the eager body byte-identical to 1.6.0 -- V8 JITs each
        // closure independently, no extra load/branch per .set.
        read.set = FLUSH_ON_IDLE_WRITE
            ? (value) => {
                if (node.gen !== birthGen) return;
                const eq = node.equals;
                if (eq && eq(node.value, value)) return;
                // 1.8.0: batch-revert via the side stack. First batched write
                // captures {node, value, version} into the parallel arrays and
                // stamps node.revertSlot; later batched writes compare against
                // the capture and restore the version on a full revert (the
                // capture write itself can never revert -- equality with the
                // pre-write value was already excluded above). Unbatched
                // writes take one branch, exactly as before.
                if (batchDepth > 0) {
                    const slot = node.revertSlot;
                    if (slot === 0) {
                        const base = revertTop;
                        revertStack[base] = node;
                        revertStack[base + 1] = node.value;
                        revertStack[base + 2] = node.version;
                        revertTop = base + 3;
                        node.revertSlot = base + 3;
                        node.value = value;
                    } else {
                        node.value = value;
                        if (eq && eq(revertStack[slot - 2], value)) {
                            node.version = revertStack[slot - 1];
                            return;
                        }
                    }
                } else {
                    node.value = value;
                }
                globalVersion = (globalVersion + 1) | 0;
                node.version = globalVersion;
                markDownstream(node);
                if (batchDepth === 0) flushEffects();
            }
            : (value) => {
                // sab / manual mode: write + mark only. Effects stay queued (dedup via
                // FLAG_SCHEDULED) until batch exit (sab) or explicit flush() (manual).
                if (node.gen !== birthGen) return;
                const eq = node.equals;
                if (eq && eq(node.value, value)) return;
                if (batchDepth > 0) {
                    const slot = node.revertSlot;
                    if (slot === 0) {
                        const base = revertTop;
                        revertStack[base] = node;
                        revertStack[base + 1] = node.value;
                        revertStack[base + 2] = node.version;
                        revertTop = base + 3;
                        node.revertSlot = base + 3;
                        node.value = value;
                    } else {
                        node.value = value;
                        if (eq && eq(revertStack[slot - 2], value)) {
                            node.version = revertStack[slot - 1];
                            return;
                        }
                    }
                } else {
                    node.value = value;
                }
                globalVersion = (globalVersion + 1) | 0;
                node.version = globalVersion;
                markDownstream(node);
            };
        read.update = sharedUpdate;        // shared: cold path, calls this.set (the closure above)
        read.subscribe = sharedSubscribe;  // shared: cold path, recovers via `this`

        read[NODE_PTR] = node;
        read[NODE_GEN] = node.gen;
        return read;
    }

    /**
     * Create a memoised, lazy derived value. The compute body only runs when a
     * downstream observer reads it AND a dependency has changed since the last
     * read.
     *
     * @template T
     * @param {() => T} fn           Compute body.
     * @param {object} [opts]
     * @param {(a:T,b:T)=>boolean} [opts.equals=Object.is]
     *        Equality predicate. Returning true blocks propagation downstream.
     * @returns {Computed<T>}
     */
    function computed(fn, opts) {
        const node = createNode(undefined, FLAG_COMPUTED);
        node.computeFn = fn;
        node.equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : OBJECT_IS;
        statComputeds++;

        const birthGen = node.gen;

        const read = () => {
            if (node.gen !== birthGen) return undefined;
            if (isTrackingDeps && currentObserver !== null) {
                let expected = activeObserverCurrentDep;
                if (expected !== null && expected.source === node) {
                    activeObserverCurrentDep = expected.nextDep;
                } else {
                    allocateLink(node, currentObserver);
                }
            }
            return pullComputed(node);
        };

        read.peek = sharedComputedPeek;
        read.subscribe = sharedSubscribe;

        read[NODE_PTR] = node;
        read[NODE_GEN] = node.gen;
        return read;
    }

    // --- 1.5: signalBox / computedBox -- non-callable, allocation-light API ------
    //
    // The callable signal()/computed() pay an irreducible per-primitive cost: a
    // `read` closure + (for signals) a `set` closure, both capturing `node` and
    // `birthGen`. That is the price of the ergonomic `count()` / `count.set(x)`
    // surface, and it is why creation can't reach alien-signals territory on the
    // callable path (Andrii's analysis; confirmed empirically).
    //
    // signalBox() trades the call ergonomics for allocation: it returns a PLAIN
    // OBJECT whose methods live on a shared prototype, so creation allocates one
    // object and writes two own props (NODE_PTR, NODE_GEN) -- zero closures. The
    // graph machinery underneath is identical; a box and a callable handle wrap
    // the same kind of ReactiveNode and interoperate freely in one graph.
    //
    //   const s = registry.signalBox(0);
    //   s.get();  s.set(1);  s.peek();  s.update(n => n+1);  s.subscribe(fn);
    //
    // Hot-path note: get()/set() resolve the node via this[NODE_PTR] (one prop
    // load) instead of a lexical capture. On a monomorphic box shape V8 compiles
    // that to a pointer-offset load; the cost vs the callable closure is in the
    // low single digits on read-heavy graphs and is the explicit, documented
    // tradeoff for the creation win.

    function boxGet() {
        const node = this[NODE_PTR];
        if (node.gen !== this[NODE_GEN]) return undefined;   // stale: slot recycled (ABA guard)
        if (isTrackingDeps && currentObserver !== null) {
            const expected = activeObserverCurrentDep;
            if (expected !== null && expected.source === node) {
                activeObserverCurrentDep = expected.nextDep;
            } else {
                allocateLink(node, currentObserver);
            }
        }
        return node.value;
    }
    // 1.7: boxSet also splits into two builds, selected once at registry init.
    // Same rationale as the .set closure split (V8 doesn't fold closure-captured
    // booleans here either). `boxSet` is the method assigned to every signalBox,
    // so binding it once at registry creation gives every box a monomorphic
    // method dispatch and a body byte-identical to 1.6.0 in eager mode.
    const boxSet = FLUSH_ON_IDLE_WRITE
        ? function boxSet(value) {
            const node = this[NODE_PTR];
            if (node.gen !== this[NODE_GEN]) return;
            const eq = node.equals;
            if (eq && eq(node.value, value)) return;
            if (batchDepth > 0) {
                const slot = node.revertSlot;
                if (slot === 0) {
                    const base = revertTop;
                    revertStack[base] = node;
                    revertStack[base + 1] = node.value;
                    revertStack[base + 2] = node.version;
                    revertTop = base + 3;
                    node.revertSlot = base + 3;
                    node.value = value;
                } else {
                    node.value = value;
                    if (eq && eq(revertStack[slot - 2], value)) {
                        node.version = revertStack[slot - 1];
                        return;
                    }
                }
            } else {
                node.value = value;
            }
            globalVersion = (globalVersion + 1) | 0;
            node.version = globalVersion;
            markDownstream(node);
            if (batchDepth === 0) flushEffects();
        }
        : function boxSet(value) {
            const node = this[NODE_PTR];
            if (node.gen !== this[NODE_GEN]) return;
            const eq = node.equals;
            if (eq && eq(node.value, value)) return;
            if (batchDepth > 0) {
                const slot = node.revertSlot;
                if (slot === 0) {
                    const base = revertTop;
                    revertStack[base] = node;
                    revertStack[base + 1] = node.value;
                    revertStack[base + 2] = node.version;
                    revertTop = base + 3;
                    node.revertSlot = base + 3;
                    node.value = value;
                } else {
                    node.value = value;
                    if (eq && eq(revertStack[slot - 2], value)) {
                        node.version = revertStack[slot - 1];
                        return;
                    }
                }
            } else {
                node.value = value;
            }
            globalVersion = (globalVersion + 1) | 0;
            node.version = globalVersion;
            markDownstream(node);
        };
    function boxPeek() {
        const node = this[NODE_PTR];
        if (node.gen !== this[NODE_GEN]) return undefined;
        return node.value;
    }
    function boxUpdate(fn) {
        const node = this[NODE_PTR];
        if (node.gen !== this[NODE_GEN]) return;
        boxSet.call(this, fn(node.value));
    }
    // Subscribe drives an effect that reads this box's value untracked-in-callback.
    // Mirrors sharedSubscribe but calls get() through `this` (boxes aren't callable).
    function boxSubscribe(fn) {
        const box = this;
        return effect(() => {
            const val = box.get();
            const prevTracking = isTrackingDeps;
            isTrackingDeps = false;
            try { fn(val); } finally { isTrackingDeps = prevTracking; }
        });
    }
    function boxComputedGet() {
        const node = this[NODE_PTR];
        if (node.gen !== this[NODE_GEN]) return undefined;
        if (isTrackingDeps && currentObserver !== null) {
            const expected = activeObserverCurrentDep;
            if (expected !== null && expected.source === node) {
                activeObserverCurrentDep = expected.nextDep;
            } else {
                allocateLink(node, currentObserver);
            }
        }
        return pullComputed(node);
    }
    function boxComputedPeek() {
        const node = this[NODE_PTR];
        if (node.gen !== this[NODE_GEN]) return undefined;
        return pullComputed(node);
    }

    // Shared prototypes -- methods defined once per registry, inherited by every box.
    const SIGNAL_BOX_PROTO = {
        get: boxGet,
        set: boxSet,
        peek: boxPeek,
        update: boxUpdate,
        subscribe: boxSubscribe,
    };
    const COMPUTED_BOX_PROTO = {
        get: boxComputedGet,
        peek: boxComputedPeek,
        subscribe: boxSubscribe,
    };

    /**
     * Allocation-light, non-callable signal. Returns a plain object on a shared
     * prototype: `{ get, set, peek, update, subscribe }`. Interoperates with
     * callable signal()/computed() in the same graph.
     * @template T
     * @param {T} initial
     * @param {object} [opts]
     * @param {(a:T,b:T)=>boolean} [opts.equals=Object.is]
     * @returns {SignalBox<T>}
     */
    function signalBox(initial, opts) {
        const node = createNode(initial, FLAG_SIGNAL);
        node.equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : OBJECT_IS;
        node.version = globalVersion;
        statSignals++;
        // Object.create(proto) allocates the box already on the shared prototype's
        // map -- no setPrototypeOf transition (which deopts the object to dictionary
        // mode and blows the method-call ICs to megamorphic). Own props are then
        // added in a stable order, keeping every box monomorphic.
        const box = Object.create(SIGNAL_BOX_PROTO);
        box[NODE_PTR] = node;
        box[NODE_GEN] = node.gen;
        return box;
    }

    /**
     * Allocation-light, non-callable computed. Returns `{ get, peek, subscribe }`
     * on a shared prototype.
     * @template T
     * @param {() => T} fn
     * @param {object} [opts]
     * @param {(a:T,b:T)=>boolean} [opts.equals=Object.is]
     * @returns {ComputedBox<T>}
     */
    function computedBox(fn, opts) {
        const node = createNode(undefined, FLAG_COMPUTED);
        node.computeFn = fn;
        node.equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : OBJECT_IS;
        statComputeds++;
        const box = Object.create(COMPUTED_BOX_PROTO);
        box[NODE_PTR] = node;
        box[NODE_GEN] = node.gen;
        return box;
    }


    /**
     * Create an eagerly-run side effect that re-executes whenever its tracked
     * dependencies change. The body runs synchronously on creation.
     *
     * An effect that creates nested effects/computeds in its body owns them via
     * the v1.2 owner tree: when this effect re-runs or is disposed, owned
     * children are cascade-disposed before the new run.
     *
     * Errors thrown by the effect body propagate to the caller of `set()` (or
     * to the scheduler trampoline). The effect's dependency state is fully
     * restored before the error propagates. Multiple throws in the same flush
     * pass aggregate into an `AggregateError` at the trigger.
     *
     * @param {() => void} fn        Effect body.
     * @param {object} [opts]
     * @param {(run:()=>void)=>void} [opts.scheduler]
     *        Optional trampoline (e.g. queueMicrotask, requestAnimationFrame).
     *        Receives a `run` callback that the scheduler must eventually invoke.
     *        The thunk is cached per-node and gen-bound, so a stale schedule
     *        fired post-dispose against a recycled slot is a guaranteed no-op.
     * @returns {() => void}         Dispose function. Idempotent. Safe to call
     *                               after registry.destroy().
     */
    function effect(fn, opts) {
        const node = createNode(undefined, FLAG_EFFECT);
        node.computeFn = fn;
        node.scheduler = (opts !== undefined) ? opts.scheduler : undefined;
        statEffects++;

        let firstRunError = null;
        if (node.scheduler) {
            const gen = node.gen | 0;
            // Cache the gen-bound thunk so re-schedules reuse the same closure.
            // The inline guard preserves ABA correctness across dispose+recycle
            // (gen bumps on disposeNode -> stale thunk no-ops).
            node.schedulerThunk = () => {
                if (node.gen === gen && (node.flags & FLAG_EFFECT) !== 0) executeEffect(node);
            };
            node.scheduler(node.schedulerThunk);
        } else {
            try {
                executeEffect(node);
            } catch (err) {
                firstRunError = err;
            }
        }

        let disposed = false;
        const birthGen = node.gen;
        const disposeFn = function dispose() {
            if (disposed) return;
            disposed = true;
            if (node.gen !== birthGen) return;
            if (node.flags !== 0) {
                disposeNode(node);
            }
        };

        // Effect handles are first-class introspection handles (1.2.1): stamp
        // the same NODE_PTR / NODE_GEN pair signal() and computed() stamp, so
        // describe / track / dependencies / graph / findPath / ownerTree work
        // when handed the dispose handle directly. NODE_GEN mirrors birthGen
        // -- introspection validity agrees exactly with the disposer's own
        // stale-guard. (Pre-existing gap on every prior version: the disposer
        // was a bare closure and liveNode() reported live effects as stale.)
        disposeFn[NODE_PTR] = node;
        disposeFn[NODE_GEN] = birthGen;

        if (firstRunError !== null) {
            disposeFn();
            throw firstRunError;
        }
        return disposeFn;
    }

    function dispose(api) {
        const node = api?.[NODE_PTR];
        if (!node) {
            if (typeof api === "function" && typeof api.peek !== "function") api();
            return;
        }
        if (api[NODE_GEN] !== node.gen) return;
        if (node.flags !== 0) {
            disposeNode(node);
        }
    }

    /**
     * Coalesce multiple synchronous writes into a single effect-flush pass.
     * Nested batches are merged -- only the outermost close triggers the flush.
     *
     * Pre-batch revert (1.2.0): if a signal is set, then set back to its
     * pre-batch value (under its `equals`) before the outer close, the version
     * bump is reverted and downstream effects/computeds do not fire.
     *
     * NOT transactional: an exception inside the body does NOT roll back applied
     * writes. Effects that have not yet fired for the pending writes do still
     * run on batch close with the post-throw values.
     *
     * @template T
     * @param {() => T} fn
     * @returns {T}
     */
    function batch(fn) {
        batchDepth = (batchDepth + 1) | 0;
        try {
            return fn();
        } finally {
            batchDepth = (batchDepth - 1) | 0;
            if (batchDepth === 0) {
                // 1.8.0: drain the revert side stack BEFORE the flush --
                // effects run at batchDepth 0 and may open a fresh batch,
                // which must start on a clean stack. The drain walks exactly
                // the distinct nodes written this batch (each write already
                // cost more than this), clears their slots, and releases the
                // captured value references (the on-node design retained
                // preBatchValue until the node's next capture).
                if (revertTop !== 0) {
                    for (let i = 0; i < revertTop; i += 3) {
                        const n = revertStack[i];
                        if (n !== null) n.revertSlot = 0;
                        revertStack[i] = null;
                        revertStack[i + 1] = undefined;
                        revertStack[i + 2] = 0;
                    }
                    revertTop = 0;
                }
                if (FLUSH_ON_BATCH_EXIT) flushEffects();
            }
        }
    }

    /**
     * Returns true iff a read RIGHT NOW would record a dependency on this
     * registry. Mirrors the engine's own read-trap predicate (both flags).
     * False inside untrack(), subscribe callbacks, onCleanup bodies,
     * watch/when callbacks, and outside any observer. For wrapper libraries
     * (lite-store, lite-query, lite-form) that lazily allocate signals on
     * property reads. Per-registry. ~1-2 ns.
     * @returns {boolean}
     */
    /**
     * Returns true iff a read RIGHT NOW would record a dependency on this
     * registry. Mirrors the engine's own read-trap predicate (both flags).
     * False inside untrack(), subscribe callbacks, onCleanup bodies,
     * watch/when callbacks, and outside any observer. For wrapper libraries
     * (lite-store, lite-query, lite-form) that lazily allocate signals on
     * property reads. Per-registry. ~1-2 ns.
     * @returns {boolean}
     */
    function isTracking() {
        return isTrackingDeps && currentObserver !== null;
    }

    function untrack(fn) {
        const prev = isTrackingDeps;
        isTrackingDeps = false;
        try {
            return fn();
        } finally {
            isTrackingDeps = prev;
        }
    }

    /**
     * Run `fn` in a detached ownership scope: nodes (effects / computeds)
     * created inside `fn` are NOT adopted by the enclosing owner, so they
     * survive the enclosing effect's re-runs and disposal. Use this for
     * long-lived reactive work spawned lazily from inside a consumer effect
     * (e.g. a query watcher created on first read) -- without it, the
     * enclosing effect owns the watcher and cascade-disposes it on its next
     * run. The caller is responsible for disposing anything created here
     * (there is no owner to do it automatically).
     *
     * Detaches BOTH ownership and tracking for the duration of `fn`, so reads
     * performed directly in `fn` (outside any inner effect/computed body) do
     * not link the enclosing observer either. Inner effect/computed bodies
     * establish their own owner+observer scopes as usual.
     *
     * Mirrors Solid's `createRoot` for the lifecycle axis. Returns whatever
     * `fn` returns (typically a disposer or the created handle).
     */
    function createRoot(fn) {
        const prevOwner = currentOwner;
        const prevObserver = currentObserver;
        const prevTracking = isTrackingDeps;
        currentOwner = null;
        currentObserver = null;
        isTrackingDeps = false;
        try {
            return fn();
        } finally {
            currentOwner = prevOwner;
            currentObserver = prevObserver;
            isTrackingDeps = prevTracking;
        }
    }

    /**
     * Create a DISPOSABLE reactive scope: an owner that ADOPTS the effects and
     * computeds created inside `fn`, so a single returned `dispose` tears the
     * whole subtree down at once. Where `createRoot` only DETACHES (leaving the
     * caller to dispose each created node by hand -- "there is no owner to do it
     * automatically"), `createScope` hands back one disposer that cascade-disposes
     * everything `fn` built. This is the lifecycle primitive a keyed list / scene
     * reconciler needs for per-item scopes of unknown internal shape.
     *
     * `fn` receives `dispose` and runs ONCE in a detached, untracked context: no
     * ownership and no dependency leak from `fn`'s direct body into the enclosing
     * scope, and the scope owner itself never re-runs. Put reactive bindings in
     * inner effect / computed bodies inside `fn` -- those establish their own
     * tracking scopes AND are owned by this scope, so they update normally and are
     * cascade-disposed on `dispose()`. Reads in `fn`'s direct body are untracked.
     * Returns whatever `fn` returns.
     *
     * Plain signals created directly in `fn` are NOT adopted -- the engine never
     * owner-adopts signals (the lazy-alloc rule, 1.2.0) -- so dispose those
     * explicitly (the creator holds the handle) or let them fall out of reference.
     * Computeds and effects ARE adopted and cascade.
     *
     * Implementation: the scope owner is backed by a never-re-running effect node,
     * so it counts as one effect in stats() and its disposer is the same
     * gen-guarded handle effect() returns -- ABA-safety and introspection match
     * effects exactly. The API (`fn => dispose`) is the stable contract; a future
     * engine may swap in a lighter pure-owner node transparently.
     *
     * @template T
     * @param {(dispose: () => void) => T} fn
     * @returns {T}
     */
    function createScope(fn) {
        let stop;
        let result;
        // Forward-referenced disposer: `stop` is assigned only after effect()
        // returns, but `fn` runs synchronously DURING effect(). Callers stash this
        // and invoke it later, by which point `stop` is set. (Disposing the scope
        // synchronously from inside `fn` is a no-op -- not a supported pattern.)
        const dispose = function dispose() { if (stop !== undefined) stop(); };
        // createRoot detaches owner+observer+tracking; inside it effect() creates a
        // ROOT owner effect (unowned -> survives the enclosing scope's re-runs).
        // untrack keeps `fn`'s direct reads from handing the owner any dependency,
        // so the owner runs exactly once; `fn`'s inner effects/computeds are owned
        // by it and cascade on dispose.
        createRoot(function () {
            stop = effect(function scopeOwner() {
                untrack(function () { result = fn(dispose); });
            });
        });
        // Stamp the wrapper so describe / nodeId / forEachOwned resolve it to the
        // owner effect, matching the first-class-handle contract effects gained in
        // 1.2.1. (`stop` carries the symbols once effect() has returned.)
        if (stop !== undefined && stop[NODE_PTR] !== undefined) {
            dispose[NODE_PTR] = stop[NODE_PTR];
            dispose[NODE_GEN] = stop[NODE_GEN];
        }
        return result;
    }

    /**
     * Register a function to run when the enclosing effect/computed re-runs or
     * is disposed. Cascade order on disposal is inside-out: an effect's owned
     * children's cleanups run BEFORE this one (#238 / #241 / #243).
     *
     * No-op if called outside an effect / computed body.
     *
     * @param {() => void} fn
     */
    function onCleanup(fn) {
        if (currentOwner !== null) {
            const existing = currentOwner.cleanupFn;
            if (existing === undefined) currentOwner.cleanupFn = fn;
            else if (typeof existing === "function") currentOwner.cleanupFn = [existing, fn];
            else existing.push(fn);
        }
    }

    /**
     * Snapshot of registry counters. Useful for diagnostics and tests --
     * e.g. asserting that `activeNodes` returns to a baseline after teardown.
     *
     * Returns 11 keys: eight live gauges (`signals`, `computeds`, `effects`,
     * `activeNodes`, `activeLinks`, `pooledLinks`, `nodePoolCapacity`,
     * `linkPoolCapacity`) plus three cumulative lifecycle counters added in 1.4.0
     * (`totalAllocations`, `totalDisposals`, `poolGrowths`). The counters are
     * monotonic over the registry's life and reset only by {@link destroy}; sample
     * them over time to derive allocation rate, pool-reuse ratio, and graph churn
     * without the engine computing rates itself. In a quiescent registry
     * `totalAllocations - totalDisposals === activeNodes`. Box nodes
     * (`signalBox` / `computedBox`) are counted exactly as callable nodes.
     * @returns {RegistryStats}
     */
    function stats() {
        return {
            signals: statSignals,
            computeds: statComputeds,
            effects: statEffects,
            activeLinks,
            pooledLinks: currentLinkCapacity - activeLinks,
            linkPoolCapacity: currentLinkCapacity,
            nodePoolCapacity: currentNodesCapacity,
            activeNodes,
            // 1.4: cumulative lifecycle counters (monotonic; reset by destroy()).
            // Derive: allocationRate = deltatotalAllocations/deltat; poolReuseRate =
            // 1 - poolGrowths*initialCap/totalAllocations; avgLifetime ~ totalDisposals/rate.
            totalAllocations: statTotalAllocations,
            totalDisposals: statTotalDisposals,
            poolGrowths: statPoolGrowths,
            // 1.6: flush-pass counter; advances only while a mutation-hook listener is
            // attached (frozen + zero-cost otherwise). Feeds devtools watchAllocations.
            flushPasses: statFlushPasses
        };
    }

    /**
     * Reset the entire registry: clear every node, every link, every queue, the
     * global clock. All previously-issued read/set/dispose closures become safe
     * no-ops (every node's `gen` bump invalidates any outstanding handle).
     */
    function destroy() {
        const nodeCount = nodePool.length;
        for (let i = 0; i < nodeCount; i++) {
            const n = nodePool[i];
            n.value = undefined;
            n.computeFn = undefined;
            n.cleanupFn = undefined;
            n.equals = undefined;
            n.scheduler = undefined;
            n.flags = 0;
            n.headDep = null;
            n.tailDep = null;
            n.headSub = null;
            n.tailSub = null;
            n.version = 0;
            n.evalVersion = 0;
            n.markEpoch = 0;
            n.revertSlot = 0;

            n.owner = null;
            n.prevOwned = null;
            n.nextOwned = null;
            n.firstOwned = null;
            n.nextMark = null;

            n.gen = (n.gen + 1) | 0;

            if (i < nodeCount - 1) n.nextFree = nodePool[i + 1];
        }
        if (nodeCount > 0) {
            nodePool[nodeCount - 1].nextFree = null;
            freeNodeHead = nodePool[0];
        } else {
            freeNodeHead = null;
        }
        effectQueueA.length = 0;
        effectQueueB.length = 0;

        const linkCount = linkPool.length;
        for (let i = 0; i < linkCount; i++) {
            const l = linkPool[i];
            l.source = null;
            l.target = null;
            l.prevDep = null;
            l.nextDep = null;
            l.prevSub = null;
            l.nextSub = null;
            if (i < linkCount - 1) l.nextFree = linkPool[i + 1];
        }
        if (linkCount > 0) {
            linkPool[linkCount - 1].nextFree = null;
            freeLinkHead = linkPool[0];
        } else {
            freeLinkHead = null;
        }

        activeNodes = 0;
        activeLinks = 0;
        activeQueueLen = 0;
        isFlushing = false;
        batchDepth = 0;
        currentObserver = null;
        currentOwner = null;
        activeObserverCurrentDep = null;
        isTrackingDeps = false;
        globalVersion = 1;
        // 1.8.0: reset the batch-revert side stack.
        revertStack.length = 0;
        revertTop = 0;
        statSignals = 0;
        statComputeds = 0;
        statEffects = 0;
        statTotalAllocations = 0;
        statTotalDisposals = 0;
        statPoolGrowths = 0;
        statFlushPasses = 0;

        for (let i = 0; i < flushErrorCount; i++) flushErrorBuffer[i] = null;
        flushErrorCount = 0;
        flushErrorBuffer.length = 0;
    }

    function hasObservers(handle) {
        const node = liveNode(handle);
        return node !== undefined && node.headSub !== null;
    }
    function observeObservers(handle, opts) {
        const node = liveNode(handle);
        if (node === undefined) throw new TypeError("observeObservers: argument is not a reactive handle");
        let e = lifecycleMap.get(node);
        if (e === undefined) {
            e = {onConnect: undefined, onDisconnect: undefined};
            lifecycleMap.set(node, e);
            lifecycleCount = (lifecycleCount + 1) | 0;
        }
        if (opts !== undefined) {
            if (opts.onConnect !== undefined) e.onConnect = opts.onConnect;
            if (opts.onDisconnect !== undefined) e.onDisconnect = opts.onDisconnect;
        }
        let live = true;
        return () => {
            if (!live) return;
            live = false;
            if (lifecycleMap.delete(node)) lifecycleCount = (lifecycleCount - 1) | 0;
        };
    }
    function describeNode(node) {
        const fl = node.flags;
        const kind = (fl & FLAG_EFFECT) !== 0 ? "effect" : (fl & FLAG_COMPUTED) !== 0 ? "computed" : "signal";
        // Plain property assignment, not Object.defineProperty.
        // Object.keys() never includes symbol-keyed properties regardless of
        // descriptor -- enumerable: false was defending nothing. Confirmed
        // empirically: `o[Symbol()] = x; Object.keys(o)` returns only
        // string-keyed enumerable props.
        const d = {id: node.id, kind, value: node.value};
        d[NODE_PTR] = node;
        d[NODE_GEN] = node.gen;   // descriptors are re-walkable handles; stamp gen so the ABA guard holds for them too
        return d;
    }
    // Gen-guarded handle resolution (1.2.1): with the v1.2 owner tree, the
    // ENGINE recycles slots autonomously (owner re-run cascade-disposes owned
    // children), so stale handles are a normal occurrence -- introspecting the
    // slot's NEW resident through an old handle reports the wrong node.
    // read()/set() already guard via closure-captured birthGen; the
    // introspection surface must apply the same ABA guard via NODE_GEN.
    function liveNode(handle) {
        if (handle == null) return undefined;
        const node = handle[NODE_PTR];
        if (node === undefined) return undefined;
        if (handle[NODE_GEN] !== node.gen) return undefined;   // stale: slot recycled
        return node;
    }
    function nodeId(handle) {
        const node = liveNode(handle);
        return node !== undefined ? node.id : undefined;
    }
    function describe(handle) {
        const node = liveNode(handle);
        return node !== undefined ? describeNode(node) : undefined;
    }
    function forEachObserver(handle, fn) {
        const node = liveNode(handle);
        if (node === undefined) return;
        let l = node.headSub;
        while (l !== null) { const nx = l.nextSub; fn(describeNode(l.target)); l = nx; }
    }
    /** Iterate this node's OWNED children (v1.2 owner tree). Additive 1.3 API
     *  prototype: lets devtools/studio walk + render the ownership hierarchy
     *  (cascade-disposal domains), which is invisible through dep/sub edges. */
    function forEachOwned(handle, fn) {
        const node = liveNode(handle);
        if (node === undefined) return;
        let c = node.firstOwned;
        while (c !== null) { const nx = c.nextOwned; fn(describeNode(c)); c = nx; }
    }
    /** Descriptor of this node's owner, or undefined (top-level / stale handle). */
    function ownerOf(handle) {
        const node = liveNode(handle);
        if (node === undefined || node.owner === null) return undefined;
        return describeNode(node.owner);
    }
    function forEachSource(handle, fn) {
        const node = liveNode(handle);
        if (node === undefined) return;
        let l = node.headDep;
        while (l !== null) { const nx = l.nextDep; fn(describeNode(l.source)); l = nx; }
    }

    return {signal, computed, effect, signalBox, computedBox, dispose, batch, flush, untrack, createRoot, createScope, onCleanup, stats, destroy, isTracking, hasObservers, observeObservers, forEachObserver, forEachSource, forEachOwned, ownerOf, nodeId, describe, onGraphMutation};
}

// -----------------------------------------------------------------
// GLOBAL BINDINGS
// -----------------------------------------------------------------

let defaultRegistry = createRegistry();

export function setDefaultRegistry(registry) {
    defaultRegistry = registry;
}

export function signal(initial, opts) {
    return defaultRegistry.signal(initial, opts);
}

export function computed(fn, opts) {
    return defaultRegistry.computed(fn, opts);
}

export function signalBox(initial, opts) {
    return defaultRegistry.signalBox(initial, opts);
}

export function computedBox(fn, opts) {
    return defaultRegistry.computedBox(fn, opts);
}

export function effect(fn, opts) {
    return defaultRegistry.effect(fn, opts);
}

export function dispose(api) {
    return defaultRegistry.dispose(api);
}

export function batch(fn) {
    return defaultRegistry.batch(fn);
}

export function flush() {
    return defaultRegistry.flush();
}

export function untrack(fn) {
    return defaultRegistry.untrack(fn);
}
export function createRoot(fn) {
    return defaultRegistry.createRoot(fn);
}

export function createScope(fn) {
    return defaultRegistry.createScope(fn);
}

/**
 * True iff a read RIGHT NOW would record a dependency on the default registry.
 * See {@link createRegistry} for the per-registry version.
 */
export function isTracking() {
    return defaultRegistry.isTracking();
}

export function onCleanup(fn) {
    return defaultRegistry.onCleanup(fn);
}

export function stats() {
    return defaultRegistry.stats();
}

export function destroy() {
    return defaultRegistry.destroy();
}

export function hasObservers(handle) {
    return defaultRegistry.hasObservers(handle);
}
export function observeObservers(handle, opts) {
    return defaultRegistry.observeObservers(handle, opts);
}
export function forEachObserver(handle, fn) {
    return defaultRegistry.forEachObserver(handle, fn);
}
export function forEachSource(handle, fn) {
    return defaultRegistry.forEachSource(handle, fn);
}
export function onGraphMutation(fn) {
    return defaultRegistry.onGraphMutation(fn);
}
export function forEachOwned(handle, fn) {
    return defaultRegistry.forEachOwned(handle, fn);
}
export function ownerOf(handle) {
    return defaultRegistry.ownerOf(handle);
}
export function nodeId(handle) {
    return defaultRegistry.nodeId(handle);
}
export function describe(handle) {
    return defaultRegistry.describe(handle);
}

export {watch, when, whenAsync} from "./Watch.js";