/**
 * @zakkster/lite-signal v1.1.3
 * --------------------
 * Zero-GC reactive graph.
 *
 * Architecture: monomorphic object pool + versioned push-pull propagation
 * + SMI modular arithmetic for 32-bit version-wrap safety.
 *
 * Performance characteristics:
 *  - Object pool: nodes and links are allocated from preallocated arrays. Steady-state
 *    operations (signal.set / computed.peek / effect re-run) perform zero allocations
 *    after warmup.
 *  - Stable read order: re-tracking dependencies in the same order yields O(1) link reuse
 *    via the `activeObserverCurrentDep` cursor.
 *  - Chaotic / randomized read order degrades to O(N) per dep (linear search of headDep
 *    list) — see {@link allocateLink}.
 *  - Computed resolution is recursive on the JS call stack. Maximum chain depth is bound
 *    by the engine stack limit (~10,000 frames).
 *  - 32-bit modular arithmetic for versioning: the engine is immune to integer-overflow
 *    crashes regardless of uptime.
 *
 * Public surface: {@link signal}, {@link computed}, {@link effect}, {@link batch},
 * {@link untrack}, {@link onCleanup}, {@link stats}, {@link createRegistry},
 * {@link setDefaultRegistry}, {@link CapacityError}.
 */

// ─── Node flag bits ────────────────────────────────────────────────────────────
const FLAG_COMPUTED = 1 << 0;
const FLAG_EFFECT = 1 << 1;
const FLAG_QUEUED = 1 << 2;
const FLAG_COMPUTING = 1 << 3;
const FLAG_HAS_ERROR = 1 << 4;
const FLAG_SIGNAL = 1 << 5; // Identifies signals for universal disposal

/**
 * Internal: a reactive node (signal, computed, or effect).
 * Lives in a preallocated pool; never released to GC during normal use.
 * @private
 */
class ReactiveNode {
    constructor() {
        /** Bitmask: FLAG_COMPUTED | FLAG_EFFECT | FLAG_QUEUED | FLAG_COMPUTING | FLAG_HAS_ERROR */
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

        /** Bumped on every change that mutates value. 32-bit modular. */
        this.version = 0;
        /** Last globalVersion at which this node was re-evaluated. */
        this.evalVersion = 0;
        /** Last globalVersion at which this node was marked dirty (de-duplicates traversal). */
        this.markEpoch = 0;
        /** Recycle generation: bumped on dispose, used to invalidate stale scheduler closures. */
        this.gen = 0;

        /** Captured value at first .set() inside the current batch (revert detection). */
        this.preBatchValue = undefined;
        /** Captured version at first .set() inside the current batch. */
        this.preBatchVersion = 0;
        /** batchEpoch that owns the capture; 0 = no capture. */
        this.revertEpoch = 0;

        // Doubly-linked dependency list (this node depends on these sources).
        this.headDep = null;
        this.tailDep = null;
        /** Cursor pointing into headDep during re-tracking. */
        this.currentDep = null;
        // Doubly-linked subscriber list (these targets depend on this node).
        this.headSub = null;
        this.tailSub = null;

        // Pool free-list pointer.
        this.nextFree = null;
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
 * Twitch Extension viewer, one per worker, one per test).
 *
 * @param {object} [config]
 * @param {number} [config.maxNodes=1024]            Initial node-pool capacity.
 * @param {number} [config.maxLinks=maxNodes*4]      Initial link-pool capacity.
 * @param {"throw"|"grow"} [config.onCapacityExceeded="throw"]
 *        `"throw"` fails fast when pools are full.
 *        `"grow"` doubles the pool (bounded by `maxLinks * 16` for links).
 * @param {number} [config.maxFlushPasses=100]       Cycle-protection: max effect-queue
 *                                                   drain passes before throwing CycleError.
 * @returns {Registry}
 */
export function createRegistry(config = {}) {
    // Per-registry symbols. NODE_PTR carries a direct pool-slot reference;
    // NODE_GEN stamps the slot's generation at the moment of API creation
    // so dispose() can detect stale handles after the slot has been recycled.
    const NODE_PTR = Symbol("node_ptr");
    const NODE_GEN = Symbol("node_gen");

    let currentNodesCapacity = config.maxNodes ?? 1024;
    let currentLinkCapacity = config.maxLinks ?? currentNodesCapacity * 4;
    const policy = config.onCapacityExceeded ?? "throw";
    const maxFlushPasses = config.maxFlushPasses ?? 100;
    const maxLinkLimit = currentLinkCapacity * 16;

    // --- ZERO-GC OBJECT POOLS ---
    const nodePool = [];
    for (let i = 0; i < currentNodesCapacity; i++) nodePool[i] = new ReactiveNode();
    let freeNodeHead = nodePool[0];
    for (let i = 0; i < currentNodesCapacity - 1; i++) nodePool[i].nextFree = nodePool[i + 1];

    const linkPool = [];
    for (let i = 0; i < currentLinkCapacity; i++) linkPool[i] = new ReactiveLink();
    let freeLinkHead = linkPool[0];
    for (let i = 0; i < currentLinkCapacity - 1; i++) linkPool[i].nextFree = linkPool[i + 1];

    let activeNodes = 0 | 0;
    let activeLinks = 0 | 0;
    let statSignals = 0 | 0;
    let statComputeds = 0 | 0;
    let statEffects = 0 | 0;

    // --- QUEUES & STACKS (Monomorphic arrays) ---
    const effectQueueA = [];
    const effectQueueB = [];
    const markStack = [];
    for (let i = 0; i < currentNodesCapacity; i++) {
        effectQueueA[i] = null;
        effectQueueB[i] = null;
        markStack[i] = null;
    }

    let activeQueue = effectQueueA;
    let activeQueueLen = 0 | 0;
    let isQueueA = true;

    // --- GLOBAL STATE ---
    let globalVersion = 1 | 0; // Forced 32-bit SMI
    let batchEpoch = 1 | 0;     // skip-zero sentinel; revertEpoch=0 means "no capture"
    let currentObserver = null;
    let activeObserverCurrentDep = null;
    let batchDepth = 0 | 0;
    let isTrackingDeps = false;
    let isFlushing = false;

    // Reused buffer for throw isolation during flush
    const flushErrorBuffer = [];
    let flushErrorCount = 0 | 0;

    // --- ALLOCATORS ---

    /**
     * Establish (or reuse) a dependency link from `source` → `target`.
     *
     * Fast path: cursor match (re-tracking same dep at same position) — O(1), no allocation.
     * Slow path: linear search of target.headDep for an existing link — O(N) in N deps.
     * Cold path: pool exhausted → grow or throw per policy.
     *
     * @private
     */
    function allocateLink(source, target) {
        let expected = activeObserverCurrentDep;
        // Dead on this build: the inline cursor fast-path inside every read
        // (signal/computed) consumes a cursor *hit* before allocateLink runs,
        // so on entry the cursor never matches `source`. Kept for the
        // direct-call contract; excluded from coverage rather than faked.
        /* c8 ignore start */
        if (expected !== null && expected.source === source) {
            activeObserverCurrentDep = expected.nextDep;
            return expected;
        }
        /* c8 ignore stop */

        let existing = target.headDep;
        let found = null;
        while (existing !== null) {
            if (existing.source === source) {
                found = existing;
                break;
            }
            existing = existing.nextDep;
        }

        let link;
        if (found !== null) {
            link = found;
            let p = link.prevDep;
            let n = link.nextDep;
            if (p !== null) p.nextDep = n; else target.headDep = n;
            if (n !== null) n.prevDep = p; else target.tailDep = p;
        } else {
            if (freeLinkHead === null) {
                if (policy === "throw") throw new CapacityError("links", currentLinkCapacity);
                const newCap = currentLinkCapacity * 2;
                if (newCap > maxLinkLimit) throw new CapacityError("links", maxLinkLimit);

                const newLinks = new Array(newCap - currentLinkCapacity);
                for (let i = 0; i < newLinks.length; i++) newLinks[i] = new ReactiveLink();
                for (let i = 0; i < newLinks.length - 1; i++) newLinks[i].nextFree = newLinks[i + 1];

                const startIdx = linkPool.length;
                linkPool.length = newCap;

                for (let i = 0; i < newLinks.length; i++) {
                    linkPool[startIdx + i] = newLinks[i];
                }

                freeLinkHead = newLinks[0];
                currentLinkCapacity = newCap;
            }

            link = freeLinkHead;
            freeLinkHead = link.nextFree;
            link.nextFree = null;
            activeLinks = (activeLinks + 1) | 0;

            link.source = source;
            link.target = target;

            link.nextSub = null;
            link.prevSub = source.tailSub;

            if (source.tailSub !== null) source.tailSub.nextSub = link;
            else source.headSub = link;

            source.tailSub = link;
        }

        link.nextDep = expected;
        if (expected !== null) {
            let p = expected.prevDep;
            link.prevDep = p;
            expected.prevDep = link;
            if (p !== null) p.nextDep = link; else target.headDep = link;
        } else {
            let tail = target.tailDep;
            link.prevDep = tail;
            if (tail !== null) tail.nextDep = link; else target.headDep = link;
            target.tailDep = link;
        }

        return link;
    }

    /** Return a link to the free pool and unlink it from the source's sub list. @private */
    function freeLink(link, target, source) {
        const pSub = link.prevSub;
        const nSub = link.nextSub;

        if (pSub !== null) pSub.nextSub = nSub; else source.headSub = nSub;
        if (nSub !== null) nSub.prevSub = pSub; else source.tailSub = pSub;

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

    // --- MANUAL MEMORY MANAGEMENT ---

    function disposeNode(node) {
        /* c8 ignore next -- redundant: both callers (effect handle, dispose(api)) pre-check flags!==0; destroy() resets slots inline */
        if (node.flags === 0) return; // Already freed

        runCleanup(node);

        // 1. Unlink from dependencies
        let dLink = node.headDep;
        while (dLink !== null) {
            const next = dLink.nextDep;
            freeLink(dLink, node, dLink.source);
            dLink = next;
        }

        // 2. Unlink from subscribers
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

        // 3. Clear node state and return to pool
        node.computeFn = undefined;
        node.cleanupFn = undefined;
        node.scheduler = undefined;
        node.value = undefined;
        node.equals = undefined;
        node.flags = 0;
        node.headDep = null;
        node.tailDep = null;
        node.currentDep = null;
        node.headSub = null;
        node.tailSub = null;

        node.revertEpoch = 0;
        node.preBatchValue = undefined;
        node.preBatchVersion = 0;

        node.gen = (node.gen + 1) | 0;
        node.nextFree = freeNodeHead;
        freeNodeHead = node;
        activeNodes = (activeNodes - 1) | 0;
    }

    /**
     * Claim a node from the free pool, reinitialise, and return it.
     * Grows pool per `policy` if exhausted.
     * @private
     */
    function createNode(value, flags) {
        if (freeNodeHead === null) {
            if (policy === "throw") throw new CapacityError("nodes", currentNodesCapacity);
            const newCap = currentNodesCapacity * 2;

            const newNodes = new Array(newCap - currentNodesCapacity);
            for (let i = 0; i < newNodes.length; i++) newNodes[i] = new ReactiveNode();
            for (let i = 0; i < newNodes.length - 1; i++) newNodes[i].nextFree = newNodes[i + 1];

            const startIdx = nodePool.length;
            nodePool.length = newCap; // Pre-allocate the new length
            for (let i = 0; i < newNodes.length; i++) {
                nodePool[startIdx + i] = newNodes[i];
            }

            freeNodeHead = newNodes[0];

            effectQueueA.length = newCap;
            effectQueueB.length = newCap;
            markStack.length = newCap;

            currentNodesCapacity = newCap;
        }

        const node = freeNodeHead;
        freeNodeHead = node.nextFree;
        node.nextFree = null;
        activeNodes = (activeNodes + 1) | 0;

        node.value = value;
        node.flags = flags | 0;
        node.headDep = null;
        node.tailDep = null;
        node.currentDep = null;
        node.headSub = null;
        node.tailSub = null;
        node.version = 0;
        node.evalVersion = 0;
        node.markEpoch = 0;
        node.revertEpoch = 0;
        node.preBatchValue = undefined;
        node.preBatchVersion = 0;
        return node;
    }

    /** Invoke registered cleanup function(s) on `node` and clear. @private */
    function runCleanup(node) {
        const cleanup = node.cleanupFn;
        if (cleanup === undefined) return;

        const prevObserver = currentObserver;
        const prevTracking = isTrackingDeps;
        currentObserver = null;
        isTrackingDeps = false;
        try {
            if (typeof cleanup === "function") cleanup();
            else for (let i = 0; i < cleanup.length; i++) cleanup[i]();
        } finally {
            node.cleanupFn = undefined;
            currentObserver = prevObserver;
            isTrackingDeps = prevTracking;
        }
    }

    /**
     * Mark all transitive subscribers of `startNode` dirty.
     * Iterative DFS via the markStack to avoid call-stack growth.
     * Effects are enqueued for the flush phase; computeds are merely marked.
     * @private
     */
    function markDownstream(startNode) {
        let stackLen = 0;
        markStack[stackLen++] = startNode;

        while (stackLen !== 0) {
            const n = markStack[--stackLen];

            let link = n.headSub;
            while (link !== null) {
                const t = link.target;
                if ((t.markEpoch | 0) !== (globalVersion | 0)) {
                    t.markEpoch = globalVersion | 0;
                    // flags read stays INSIDE the markEpoch guard on purpose: hoisting it
                    // above the guard would load t.flags for every already-marked revisit
                    // too, adding work on exactly the dedup-skip path that markEpoch exists
                    // to make cheap (diamond / shared-computed fan-out).
                    const flags = t.flags | 0;

                    if ((flags & FLAG_EFFECT) !== 0) {
                        // "No re-run" semantics for self-cycles: an effect that is currently
                        // executing on the call stack must not be re-queued by its own body's
                        // writes (directly or through computed chains). The effect's evalVersion
                        // is bumped to the post-write globalVersion in its executeEffect finally,
                        // so subsequent unrelated writes still propagate normally.
                        if ((flags & (FLAG_QUEUED | FLAG_COMPUTING)) === 0) {
                            t.flags = flags | FLAG_QUEUED;
                            activeQueue[activeQueueLen++] = t;
                        }
                    } else {
                        markStack[stackLen++] = t;
                    }
                }
                link = link.nextSub;
            }
        }
    }

    /**
     * Execute an effect through a scheduler trampoline. Guards against running
     * a stale node (disposed and recycled before the scheduler fired).
     * @private
     */
    function safeExecute(node, gen) {
        if ((node.gen | 0) !== (gen | 0)) return;
        /* c8 ignore next -- unreachable after the gen guard: every disposal bumps node.gen, so a non-effect slot fails the gen check above first */
        if ((node.flags & FLAG_EFFECT) === 0) return;
        executeEffect(node);
    }

    /**
     * Drain the effect queue. Double-buffered so new effects scheduled mid-flush
     * end up in the next pass. Individual effect throws are caught, buffered, and
     * re-thrown at the end of the flush (or wrapped in AggregateError if multiple).
     * @private
     */
    function flushEffects() {
        if (isFlushing) return;
        isFlushing = true;
        let passes = 0 | 0;
        let normalExit = false;

        try {
            while (activeQueueLen > 0) {
                passes = (passes + 1) | 0;
                if (passes > maxFlushPasses) {
                    throw new Error("CycleError: flush passes exceeded");
                }

                const toRun = activeQueueLen | 0;
                const currentQueue = activeQueue;

                isQueueA = !isQueueA;
                activeQueue = isQueueA ? effectQueueA : effectQueueB;
                activeQueueLen = 0 | 0;

                for (let i = 0; i < toRun; i++) {
                    const node = currentQueue[i];
                    try {
                        const scheduler = node.scheduler;
                        if (scheduler) {
                            const gen = node.gen | 0;
                            scheduler(() => safeExecute(node, gen));
                        } else {
                            executeEffect(node);
                        }
                    } catch (err) {
                        // Buffer and continue. Effect's own try/finally inside
                        // executeEffect already restored observer state and
                        // severed tail deps before the throw landed here.
                        flushErrorBuffer[flushErrorCount] = err;
                        flushErrorCount = (flushErrorCount + 1) | 0;
                    }
                }
            }
            normalExit = true;
        } finally {
            isFlushing = false;
            if (!normalExit) {
                // Escaping via CycleError or any non-effect-body throw. Discard
                // buffered effect errors — the structural failure supersedes them
                // and prevents leaking stale errors to the next flush call.
                for (let i = 0; i < flushErrorCount; i++) flushErrorBuffer[i] = null;
                flushErrorCount = 0 | 0;
            }
        }

        if (flushErrorCount > 0) {
            if (flushErrorCount === 1) {
                const err = flushErrorBuffer[0];
                flushErrorBuffer[0] = null; // drop reference, retain backing store
                flushErrorCount = 0 | 0;
                throw err;
            }
            // 2+ errors: snapshot into a fresh array for AggregateError, then clear.
            const errs = flushErrorBuffer.slice(0, flushErrorCount);
            for (let i = 0; i < flushErrorCount; i++) flushErrorBuffer[i] = null;
            flushErrorCount = 0 | 0;
            throw new AggregateError(errs, "Effects threw during flush");
        }
    }

    /**
     * Free any tail links not visited during the current re-tracking pass.
     * Called after computeFn returns: anything still hanging off the cursor is stale.
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

    /**
     * Run an effect's compute body, re-tracking dependencies.
     * Short-circuits if no dependency has bumped its version since last eval.
     * @private
     */
    function executeEffect(node) {
        /* c8 ignore next -- defense-in-depth: writes during a flush re-queue for the next pass, so an effect cannot synchronously re-enter executeEffect */
        if ((node.flags & FLAG_COMPUTING) !== 0) throw new Error("CycleError: Infinite effect loop detected.");

        const isFirst = node.evalVersion === 0;

        if (!isFirst) {
            let link = node.headDep;
            const evalVer = node.evalVersion | 0;
            let needsRun = false;
            while (link !== null) {
                const dep = link.source;
                if ((dep.flags & FLAG_COMPUTED) !== 0) pullComputed(dep);

                // Overflow-safe modular arithmetic version check
                if (((dep.version - evalVer) | 0) > 0) {
                    needsRun = true;
                    break;
                }
                link = link.nextDep;
            }
            if (!needsRun) {
                node.flags = node.flags & ~FLAG_QUEUED;
                node.evalVersion = globalVersion | 0;
                return;
            }
        }

        node.flags = (node.flags & ~FLAG_QUEUED) | FLAG_COMPUTING;

        runCleanup(node);

        // Cleanup may have disposed us (e.g. via a synchronous dispose() call from
        // within the user's cleanup body). disposeNode clears flags to 0 and nulls
        // computeFn; bailing here prevents a TypeError on computeFn() below and
        // avoids reinitialising observer state on a freed slot.
        if ((node.flags & FLAG_EFFECT) === 0) return;

        const prevObserver = currentObserver;
        const prevActiveDep = activeObserverCurrentDep;
        const prevTracking = isTrackingDeps;

        currentObserver = node;
        activeObserverCurrentDep = node.headDep;
        isTrackingDeps = true;

        try {
            node.computeFn();
        } finally {
            severTail(node);
            node.currentDep = activeObserverCurrentDep;

            currentObserver = prevObserver;
            activeObserverCurrentDep = prevActiveDep;
            isTrackingDeps = prevTracking;

            node.flags = node.flags & ~FLAG_COMPUTING;
            node.evalVersion = globalVersion | 0;
        }
    }

    /**
     * Resolve a computed node's current value: re-run if a dependency has
     * changed since last evaluation, else return cached value.
     *
     * Errors thrown by computeFn are captured in `node.value` with FLAG_HAS_ERROR;
     * subsequent reads re-throw until a dependency change re-runs computeFn.
     *
     * @private
     */
    function pullComputed(node) {
        if ((node.evalVersion | 0) === (globalVersion | 0)) {
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
                // Modular Arithmetic 32-bit Wrap Check
                if (((dep.version - evalVer) | 0) > 0) {
                    shouldRun = true;
                    break;
                }
                link = link.nextDep;
            }
        }

        if (shouldRun) {
            if ((node.flags & FLAG_COMPUTING) !== 0) throw new Error("CycleError: Circular dependency detected.");
            node.flags = node.flags | FLAG_COMPUTING;

            // Run cleanups registered during the previous compute pass before re-tracking.
            // Mirrors effect semantics so `onCleanup` works in both kinds of observer.
            runCleanup(node);

            const prevObserver = currentObserver;
            const prevActiveDep = activeObserverCurrentDep;
            const prevTracking = isTrackingDeps;

            currentObserver = node;
            activeObserverCurrentDep = node.headDep;
            isTrackingDeps = true;

            try {
                const newValue = node.computeFn();
                const eq = node.equals;
                if (node.evalVersion === 0 || !eq || !eq(node.value, newValue)) {
                    node.value = newValue;
                    node.version = globalVersion | 0;
                }
                node.flags = node.flags & ~FLAG_HAS_ERROR;
            } catch (err) {
                node.value = err;
                node.flags = node.flags | FLAG_HAS_ERROR;
                node.version = globalVersion | 0;
            } finally {
                severTail(node);
                node.currentDep = activeObserverCurrentDep;

                currentObserver = prevObserver;
                activeObserverCurrentDep = prevActiveDep;
                isTrackingDeps = prevTracking;

                node.flags = node.flags & ~FLAG_COMPUTING;
            }
        }

        node.evalVersion = globalVersion | 0;
        if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;
        return node.value;
    }

    // --- PUBLIC API SURFACE ---

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
        // Read opts defensively instead of defaulting to `= {}`: the default allocates
        // a throwaway object on every no-opts call (the common path) — pure nursery
        // garbage when mounting many signals.
        node.equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : Object.is;
        node.version = globalVersion | 0;
        statSignals = (statSignals + 1) | 0;

        const read = () => {
            if (isTrackingDeps && currentObserver !== null) {
                // Inlined cursor fast-path: on stable read order this matches every
                // time, so we skip a call into the (large, non-inlinable) allocateLink
                // frame entirely. Only a cursor miss falls through to the cold path,
                // where allocateLink re-reads the cursor for its relink logic.
                const expected = activeObserverCurrentDep;
                if (expected !== null && expected.source === node) {
                    activeObserverCurrentDep = expected.nextDep;
                } else {
                    allocateLink(node, currentObserver);
                }
            }
            return node.value;
        };
        read.peek = () => node.value;
        read.set = (value) => {
            const eq = node.equals;
            if (eq && eq(node.value, value)) return;

            // Revert capture: first .set() of this signal inside the current batch.
            // Guarded by batchDepth so out-of-batch writes pay zero added cost.
            if (batchDepth > 0 && node.revertEpoch !== batchEpoch) {
                node.preBatchValue = node.value;
                node.preBatchVersion = node.version | 0;
                node.revertEpoch = batchEpoch | 0;
            }

            node.value = value;

            // Revert detection: in-batch write whose value matches the pre-batch
            // capture. Restore version (without bumping globalVersion) and skip
            // propagation. Subscribers already queued by an earlier mid-batch set
            // will dirty-check against this restored version at flush and bail.
            if (batchDepth > 0 && node.revertEpoch === batchEpoch && eq && eq(node.preBatchValue, value)) {
                node.version = node.preBatchVersion | 0;
                return;
            }

            globalVersion = (globalVersion + 1) | 0;
            node.version = globalVersion | 0;
            markDownstream(node);
            if (batchDepth === 0) flushEffects();
        };
        read.update = (fn) => read.set(fn(node.value));

        read.subscribe = (fn) => {
            // Single-closure subscription: the read is tracked (it establishes the
            // dependency), then fn runs untracked. untrack() is inlined here to (a) drop
            // the second per-subscription closure and (b) save an untrack()+wrapper call
            // on every fire, not just at setup.
            // COUPLING: this duplicates untrack()'s isTrackingDeps save/restore. If
            // untrack ever manages additional state (e.g. currentObserver), mirror it here.
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
        };

        // Secret pointer for safe, isolated disposal without allocating closures
        read[NODE_PTR] = node;
        read[NODE_GEN] = node.gen | 0;
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
        // Defensive opts read; avoids the `= {}` per-call allocation. See signal().
        node.equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : Object.is;
        statComputeds = (statComputeds + 1) | 0;

        const read = () => {
            if (isTrackingDeps && currentObserver !== null) {
                // Inlined cursor fast-path — see signal() read for rationale.
                const expected = activeObserverCurrentDep;
                if (expected !== null && expected.source === node) {
                    activeObserverCurrentDep = expected.nextDep;
                } else {
                    allocateLink(node, currentObserver);
                }
            }
            return pullComputed(node);
        };
        read.peek = () => pullComputed(node);

        read.subscribe = (fn) => {
            // Single-closure subscription — see signal() subscribe for rationale and
            // the untrack-inlining coupling note.
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
        };

        read[NODE_PTR] = node;
        read[NODE_GEN] = node.gen | 0;
        return read;
    }

    /**
     * Create an eagerly-run side effect that re-executes whenever its tracked
     * dependencies change.
     *
     * Errors thrown by the effect body propagate to the caller of `set()` (or
     * to the scheduler trampoline). The effect's dependency state is fully
     * restored before the error propagates.
     *
     * @param {() => void} fn        Effect body.
     * @param {object} [opts]
     * @param {(run:()=>void)=>void} [opts.scheduler]
     *        Optional trampoline (e.g. queueMicrotask, requestAnimationFrame).
     *        Receives a `run` callback that the scheduler must eventually invoke.
     * @returns {() => void}         Dispose function. Idempotent. Safe to call
     *                               after registry.destroy().
     */
    function effect(fn, opts) {
        const node = createNode(undefined, FLAG_EFFECT);
        node.computeFn = fn;
        // Defensive opts read; avoids the `= {}` per-call allocation. Read scheduler once
        // and reuse the local for the trampoline check below.
        const scheduler = opts !== undefined ? opts.scheduler : undefined;
        node.scheduler = scheduler;
        statEffects = (statEffects + 1) | 0;

        let firstRunError = null;
        if (scheduler) {
            const gen = node.gen | 0;
            scheduler(() => safeExecute(node, gen));
        } else {
            try {
                executeEffect(node);
            } catch (err) {
                // First-run failure: dispose the node so we don't leak a half-initialised
                // effect in the registry. Propagate the error to the caller.
                firstRunError = err;
            }
        }

        let disposed = false;
        const birthGen = node.gen | 0;
        const disposeFn = function dispose() {
            if (disposed) return;
            disposed = true;
            // Generation guard: if destroy() (or a future direct disposal)
            // recycled this slot to a different node, the stale closure must
            // NOT operate on it — without this check, the closure would call
            // disposeNode() on whatever now lives in the slot and desync
            // statEffects (it would decrement even though the node is no
            // longer an effect). Mirrors the NODE_GEN stamp on signals/computeds.
            if ((node.gen | 0) !== birthGen) return;
            if (node.flags !== 0) {
                disposeNode(node);
                statEffects = (statEffects - 1) | 0;
            }
        };

        if (firstRunError !== null) {
            disposeFn();
            throw firstRunError;
        }
        return disposeFn;
    }

    function dispose(api) {
        // Safe read: foreign APIs or effects return undefined for NODE_PTR.
        const node = api?.[NODE_PTR];

        if (!node) {
            // Plain functions self-execute (effect dispose handles and the
            // dispose returned by .subscribe()). BUT we must not invoke a
            // FOREIGN signal/computed here — they are also functions, and
            // calling one would (1) read the value if untracked, or worse,
            // (2) cross-link the foreign node into our observer if called
            // inside a tracking context. Duck-type on `.peek`: every reactive
            // primitive carries it; plain dispose handles do not.
            if (typeof api === "function" && typeof api.peek !== "function") api();
            return;
        }

        // Generation guard: if the slot has been recycled since this handle
        // was issued, the handle is stale — silently no-op. Without this,
        // a second dispose() call after the slot has been reallocated to a
        // different signal/computed would free the new occupant.
        const stamp = api[NODE_GEN] | 0;
        if (stamp !== (node.gen | 0)) return;

        if (node.flags !== 0) {
            const isSig = (node.flags & FLAG_SIGNAL) !== 0;
            const isComp = (node.flags & FLAG_COMPUTED) !== 0;

            disposeNode(node);

            if (isSig) statSignals = (statSignals - 1) | 0;
            if (isComp) statComputeds = (statComputeds - 1) | 0;
        }
    }

    /**
     * Coalesce multiple synchronous writes into a single effect-flush pass.
     * Nested batches are merged.
     *
     * @template T
     * @param {() => T} fn
     * @returns {T}
     */
    function batch(fn) {
        if (batchDepth === 0) {
            batchEpoch = (batchEpoch + 1) | 0;
            /* c8 ignore next -- 2^32 wraparound sentinel; unreachable without ~4e9 batches */
            if (batchEpoch === 0) batchEpoch = 1 | 0;   // preserve the 0 sentinel
        }
        batchDepth = (batchDepth + 1) | 0;
        try {
            return fn();
        } finally {
            batchDepth = (batchDepth - 1) | 0;
            if (batchDepth === 0) flushEffects();
        }
    }

    /**
     * Run `fn` without recording any signal/computed reads as dependencies.
     * Useful inside effects to peek at signals you don't want to react to.
     *
     * @template T
     * @param {() => T} fn
     * @returns {T}
     */
    /**
     * Returns true iff a read RIGHT NOW would record a dependency in the current
     * call stack: an observer body is on the stack AND tracking is enabled.
     *
     * Mirrors the engine's own read-trap predicate (both flags checked). Returns
     * false inside `untrack()`, inside `signal.subscribe`'s callback (which
     * inlines the same untracked-notify pattern), inside `runCleanup` bodies,
     * and outside any observer.
     *
     * Use case: wrapper libraries (lite-store, lite-query, lite-form) that
     * lazily allocate reactive primitives on property reads — gating on
     * isTracking() lets them skip allocation when reads happen outside a
     * reactive context, preserving the zero-GC contract.
     *
     * Cost: two closure-variable loads, one AND, one return. ~1–2 ns.
     *
     * Note: per-registry. Wrappers operating against a non-default registry
     * MUST call that registry's `isTracking()`, not the top-level one — each
     * registry has its own tracking state.
     *
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
     * Register a function to run when the enclosing effect re-runs or is disposed.
     *
     * No-op if called outside an effect / computed body.
     *
     * @param {() => void} fn
     */
    function onCleanup(fn) {
        if (currentObserver !== null) {
            const existing = currentObserver.cleanupFn;
            if (existing === undefined) currentObserver.cleanupFn = fn;
            else if (typeof existing === "function") currentObserver.cleanupFn = [existing, fn];
            else existing.push(fn);
        }
    }

    /**
     * Snapshot of registry counters. Useful for diagnostics and tests.
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
            activeNodes
        };
    }

    /**
     * Reset the entire registry: clear every node, every link, every queue, the
     * global clock. All previously-issued read/set/dispose closures become
     * no-ops (they're guarded internally — they will not corrupt the pool).
     */
    function destroy() {
        for (let i = 0; i < currentNodesCapacity; i++) {
            const n = nodePool[i];
            n.value = undefined;
            n.computeFn = undefined;
            n.cleanupFn = undefined;
            n.equals = undefined;
            n.scheduler = undefined;
            n.flags = 0;
            n.headDep = null;
            n.tailDep = null;
            n.currentDep = null;
            n.headSub = null;
            n.tailSub = null;
            n.version = 0;
            n.evalVersion = 0;
            n.markEpoch = 0;
            n.revertEpoch = 0;
            n.preBatchValue = undefined;
            n.preBatchVersion = 0;
            // Bump gen so any scheduler trampolines holding a stale node ref bail.
            n.gen = (n.gen + 1) | 0;
            if (i < currentNodesCapacity - 1) n.nextFree = nodePool[i + 1];
        }
        nodePool[currentNodesCapacity - 1].nextFree = null;
        freeNodeHead = nodePool[0];

        for (let i = 0; i < currentLinkCapacity; i++) {
            const l = linkPool[i];
            l.source = null;
            l.target = null;
            l.prevDep = null;
            l.nextDep = null;
            l.prevSub = null;
            l.nextSub = null;
            if (i < currentLinkCapacity - 1) l.nextFree = linkPool[i + 1];
        }
        linkPool[currentLinkCapacity - 1].nextFree = null;
        freeLinkHead = linkPool[0];

        activeNodes = 0 | 0;
        activeLinks = 0 | 0;
        activeQueueLen = 0 | 0;
        isFlushing = false;
        batchDepth = 0 | 0;
        currentObserver = null;
        activeObserverCurrentDep = null;
        isTrackingDeps = false;
        globalVersion = 1 | 0;
        batchEpoch = 1 | 0;
        statSignals = 0 | 0;
        statComputeds = 0 | 0;
        statEffects = 0 | 0;

        for (let i = 0; i < flushErrorCount; i++) flushErrorBuffer[i] = null;

        flushErrorCount = 0 | 0;
        flushErrorBuffer.length = 0; // release the backing array
    }

    return {signal, computed, effect, dispose, batch, untrack, onCleanup, stats, destroy, isTracking};
}

// ─────────────────────────────────────────────────────────────────
// GLOBAL BINDINGS
// ─────────────────────────────────────────────────────────────────

let defaultRegistry = createRegistry();

/**
 * Replace the registry backing the top-level {@link signal} / {@link computed} /
 * {@link effect} / {@link batch} / {@link untrack} / {@link onCleanup} / {@link stats}
 * exports.
 *
 * @param {Registry} registry
 */
export function setDefaultRegistry(registry) {
    defaultRegistry = registry;
}

/** @type {Registry["signal"]} */
export function signal(initial, opts) {
    return defaultRegistry.signal(initial, opts);
}

/** @type {Registry["computed"]} */
export function computed(fn, opts) {
    return defaultRegistry.computed(fn, opts);
}

/** @type {Registry["effect"]} */
export function effect(fn, opts) {
    return defaultRegistry.effect(fn, opts);
}

export function dispose(api) {
    return defaultRegistry.dispose(api);
}

/** @type {Registry["batch"]} */
export function batch(fn) {
    return defaultRegistry.batch(fn);
}

/** @type {Registry["untrack"]} */
export function untrack(fn) {
    return defaultRegistry.untrack(fn);
}

/**
 * True iff a read RIGHT NOW would record a dependency on the default registry.
 * See {@link createRegistry} for the per-registry version. Wrappers operating
 * against a non-default registry MUST call THAT registry's `isTracking()`.
 */
export function isTracking() {
    return defaultRegistry.isTracking();
}

/** @type {Registry["onCleanup"]} */
export function onCleanup(fn) {
    return defaultRegistry.onCleanup(fn);
}

/** @type {Registry["stats"]} */
export function stats() {
    return defaultRegistry.stats();
}

/** * Wipe the default registry. strictly for test-suite isolation.
 * @private
 */
export function destroy() {
    return defaultRegistry.destroy();
}

/**
 * Re-export of the user-land watch utility.
 * @see {@link watch} in Watch.js for full implementation details.
 */
export {watch, when, whenAsync} from "./Watch.js"