/**
 * @zakkster/lite-signal rough draft 1.2
 * --------------------
 * Zero-GC reactive graph.
 * * Architecture: monomorphic object pool + versioned push-pull propagation
 * - SMI modular arithmetic for 32-bit version-wrap safety.
 * * Performance characteristics:
 * - Object pool: nodes and links are allocated from preallocated arrays. Steady-state
 * operations (signal.set / computed.peek / effect re-run) perform zero allocations
 * after warmup.
 * - Dependency reconciliation uses per-source version stamps (v1.1): each source records
 * the `currentEvalId` in which it was read; a two-pass reconcile at end-of-compute
 * diffs the recorded set against the existing dep list. Hot path is O(1) per read
 * regardless of read order or dep-set churn. End-of-compute is O(prev deps + new deps).
 * - V8 Monomorphic Optimization: execution frames are strictly separated into
 * `withComputedFrame` and `withEffectFrame` to guarantee branchless JIT inlining.
 * - Computed resolution is recursive on the JS call stack. Maximum chain depth is bound
 * by the engine stack limit (~10,000 frames).
 * * @module @zakkster/lite-signal
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

        // v1.1 topology markers
        this.reachEval = 0;
        this.linkedInEvalMark = 0;
        this.depsCount = 0;

        // Doubly-linked dependency & subscriber lists
        this.headDep = null;
        this.tailDep = null;
        this.headSub = null;

        // Pool free-list pointer
        this.nextFree = null;
    }
}

/**
 * Internal: a directed edge between a source node and a target node.
 * Pool-allocated, never GC’d.
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

    let currentNodesCapacity = config.maxNodes || 1024;
    let currentLinkCapacity = config.maxLinks || currentNodesCapacity * 4;
    const policy = config.onCapacityExceeded || "throw";
    const maxFlushPasses = config.maxFlushPasses || 100;
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

    // ── GLOBAL STATE ──
    let globalVersion = 1 | 0;
    let currentObserver = null;
    let batchDepth = 0 | 0;
    let isTrackingDeps = false;
    let isFlushing = false;

    // ── v1.1 DEP-TRACKING STATE ──
    let nextEvalId = 0 | 0;
    let currentEvalId = 0 | 0;

    let scratchCount = 0 | 0;
    let scratchSources = new Array(64);
    let scratchSavedReach = new Int32Array(64); // SMI aligned

    // v1.1 HYBRID: cursor-based fast path for top-level computes with stable read order.
    // `cursor` walks the current target's `headDep` list. `cursorActive` is true while
    // we haven't diverged. On a cursor match, we just stamp `source.reachEval` and
    // advance — no scratch write, no end-of-compute reconcile work. On divergence,
    // cursorActive flips false and recordRead falls back to v1.1 scratch mode.
    //
    // Cursor mode is enabled ONLY when prevObserver === null at frame entry (top-level
    // observer). Nested computes use scratch mode to keep nested-correctness
    // straightforward — the saved/restored reachEval discipline is hard to preserve
    // through cursor matches without adding equivalent overhead.
    let cursor = null;
    let cursorActive = false;

    function growScratch() {
        const oldLen = scratchSources.length;
        const newLen = oldLen * 2;
        const newSources = new Array(newLen);
        const newSaved = new Int32Array(newLen);
        for (let i = 0; i < oldLen; i++) {
            newSources[i] = scratchSources[i];
            newSaved[i] = scratchSavedReach[i];
        }
        scratchSources = newSources;
        scratchSavedReach = newSaved;
    }

    // ── ALLOCATORS ──

    function recordRead(source) {
        // Dedup: source was already recorded in this eval. Return immediately so the
        // cursor doesn't get advanced on duplicate reads.
        if (source.reachEval === currentEvalId) return;

        // v1.1 HYBRID FAST PATH: cursor mode (top-level computes with stable order).
        // Match means: next position in the existing dep list IS the source we're
        // reading. Stamp reachEval (needed for cycle guard and for PASS 1 of
        // reconcileDeps in case we later diverge), advance cursor, done. No scratch
        // write, and the end-of-compute reconcile becomes a no-op if cursor reaches
        // the end without divergence.
        if (cursorActive) {
            if (cursor !== null && cursor.source === source) {
                source.reachEval = currentEvalId;
                cursor = cursor.nextDep;
                return;
            }
            // Read didn't match cursor position. Could be reordering, set-churn, or
            // first-eval (cursor === null). Disable cursor mode for the rest of this
            // compute and fall through to scratch push.
            cursorActive = false;
        }

        // v1.1 STANDARD PATH: push to scratch for end-of-compute reconciliation.
        if (scratchCount === scratchSources.length) growScratch();
        scratchSavedReach[scratchCount] = source.reachEval | 0;
        source.reachEval = currentEvalId;
        scratchSources[scratchCount] = source;
        scratchCount = (scratchCount + 1) | 0;
    }

    function allocateLinkPlain(source, target) {
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

        const link = freeLinkHead;
        freeLinkHead = link.nextFree;
        link.nextFree = null;
        activeLinks = (activeLinks + 1) | 0;

        link.source = source;
        link.target = target;

        // Prepend to source’s subscriber list
        link.prevSub = null;
        link.nextSub = source.headSub;
        if (source.headSub !== null) source.headSub.prevSub = link;
        source.headSub = link;

        // Append to target’s dep list
        link.prevDep = target.tailDep;
        link.nextDep = null;
        if (target.tailDep !== null) target.tailDep.nextDep = link;
        else target.headDep = link;
        target.tailDep = link;
        target.depsCount = (target.depsCount + 1) | 0;

        return link;
    }

    /** Return a link to the free pool and unlink it from the source's sub list. @private */
    function freeLink(link, target, source) {
        const pSub = link.prevSub;
        const nSub = link.nextSub;

        if (pSub !== null) pSub.nextSub = nSub; else source.headSub = nSub;
        if (nSub !== null) nSub.prevSub = pSub;

        const pDep = link.prevDep;
        const nDep = link.nextDep;
        if (pDep !== null) pDep.nextDep = nDep; else target.headDep = nDep;
        if (nDep !== null) nDep.prevDep = pDep; else target.tailDep = pDep;
        target.depsCount = (target.depsCount - 1) | 0;

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
            const next = sLink.nextSub;
            freeLink(sLink, sLink.target, node);
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
        node.headSub = null;
        node.depsCount = 0;

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
        node.headSub = null;
        node.version = 0;
        node.evalVersion = 0;
        node.markEpoch = 0;
        node.depsCount = 0;
        node.reachEval = 0;
        node.linkedInEvalMark = 0;
        return node;
    }

    /** Invoke registered cleanup function(s) on `node` and clear. @private */
    function runCleanup(node) {
        const cleanup = node.cleanupFn;
        if (cleanup) {
            if (typeof cleanup === "function") cleanup();
            else for (let i = 0; i < cleanup.length; i++) cleanup[i]();
            node.cleanupFn = undefined;
        }
    }

    /**
     * Mark all transitive subscribers of `startNode` dirty.
     * Iterative DFS via the markStack to avoid call-stack growth.
     * Effects are enqueued for the flush phase; computeds are merely marked.
     * @private
     */
    function markDownstream(startNode) {
        let stackLen = 0 | 0;
        markStack[stackLen] = startNode;
        stackLen = (stackLen + 1) | 0;

        while (stackLen > 0) {
            stackLen = (stackLen - 1) | 0;
            const n = markStack[stackLen];

            let link = n.headSub;
            while (link !== null) {
                const t = link.target;
                if ((t.markEpoch | 0) !== (globalVersion | 0)) {
                    t.markEpoch = globalVersion | 0;
                    const flags = t.flags | 0;

                    if ((flags & FLAG_EFFECT) !== 0) {
                        if ((flags & FLAG_QUEUED) === 0) {
                            t.flags = flags | FLAG_QUEUED;
                            activeQueue[activeQueueLen] = t;
                            activeQueueLen = (activeQueueLen + 1) | 0;
                        }
                    } else {
                        markStack[stackLen] = t;
                        stackLen = (stackLen + 1) | 0;
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

        while (activeQueueLen > 0) {
            passes = (passes + 1) | 0;
            if (passes > maxFlushPasses) {
                isFlushing = false;
                throw new Error("CycleError: flush passes exceeded");
            }

            const toRun = activeQueueLen | 0;
            const currentQueue = activeQueue;

            isQueueA = !isQueueA;
            activeQueue = isQueueA ? effectQueueA : effectQueueB;
            activeQueueLen = 0 | 0;

            for (let i = 0; i < toRun; i++) {
                const node = currentQueue[i];
                const scheduler = node.scheduler;
                if (scheduler) {
                    const gen = node.gen | 0;
                    scheduler(() => safeExecute(node, gen));
                } else {
                    executeEffect(node);
                }
            }
        }
        isFlushing = false;
    }

    function reconcileDeps(target, scratchStart, restoreNeeded) {
        const expectedCount = (scratchCount - scratchStart) | 0;

        // v1.1 HYBRID CURSOR FAST PATH.
        // If cursorActive is still true at end of compute, the body read sources in
        // exactly the order they appear in the dep list and there are no scratch
        // entries (any scratch push disables cursor mode). Two sub-cases:
        //   (a) cursor === null — read consumed every dep in order; nothing changed.
        //   (b) cursor !== null — read consumed a prefix and stopped early; free the
        //       unread tail.
        // No restoreNeeded work for cursor matches: cursor mode runs only at the top
        // level where restoreNeeded ≡ false (no outer compute on the stack).
        if (cursorActive) {
            if (cursor === null) return;          // (a)
            let link = cursor;                    // (b)
            while (link !== null) {
                const next = link.nextDep;
                freeLink(link, target, link.source);
                link = next;
            }
            return;
        }

        // Fast path: dep set unchanged from previous eval (same set, same order).
        // Reached when cursor mode was disabled at frame entry (nested compute) OR
        // when divergence happened and the diverged scratch sequence happens to
        // still match the prior list — uncommon but cheap to check.
        if (target.depsCount === expectedCount) {
            let link = target.headDep;
            let i = scratchStart;
            let stable = true;
            while (link !== null && i < scratchCount) {
                if (link.source !== scratchSources[i]) { stable = false; break; }
                link = link.nextDep;
                i = (i + 1) | 0;
            }
            if (stable && link === null && i === scratchCount) {
                if (restoreNeeded) {
                    for (let j = scratchStart; j < scratchCount; j++) {
                        scratchSources[j].reachEval = scratchSavedReach[j] | 0;
                    }
                }
                scratchCount = scratchStart | 0;
                return;
            }
        }

        let link = target.headDep;
        while (link !== null) {
            const next = link.nextDep;
            const source = link.source;
            if (source.reachEval === currentEvalId) {
                source.linkedInEvalMark = currentEvalId;
            } else {
                freeLink(link, target, source);
            }
            link = next;
        }

        for (let i = scratchStart; i < scratchCount; i++) {
            const source = scratchSources[i];
            if (source.linkedInEvalMark !== currentEvalId) {
                allocateLinkPlain(source, target);
                source.linkedInEvalMark = currentEvalId;
            }
        }

        if (restoreNeeded) {
            for (let i = scratchStart; i < scratchCount; i++) {
                scratchSources[i].reachEval = scratchSavedReach[i] | 0;
            }
        }
        scratchCount = scratchStart | 0;
    }

    /**
     * V8 Monomorphic Optimization:
     * Extracted specifically for Computed nodes to ensure the JIT compiler
     * inlines the math and memory states perfectly without polymorphic bailouts.
     * @private
     */
    function withComputedFrame(node) {
        const prevObserver = currentObserver;
        const prevEvalId = currentEvalId;
        const prevScratchCount = scratchCount;
        const prevTracking = isTrackingDeps;
        const prevCursor = cursor;
        const prevCursorActive = cursorActive;

        currentObserver = node;
        nextEvalId = (nextEvalId + 1) | 0;
        currentEvalId = nextEvalId;
        isTrackingDeps = true;
        node.flags = node.flags | FLAG_COMPUTING;
        // v1.1 HYBRID: cursor mode enabled only at top level. Nested computes
        // (prevObserver !== null) get cursorActive = false, falling through to
        // standard scratch-mode tracking. This keeps nested-correctness simple
        // — see Bug 1 history; cursor matches don't save reachEval and so
        // would corrupt outer-compute stamps if enabled while nested.
        cursor = node.headDep;
        cursorActive = (prevObserver === null);

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
            reconcileDeps(node, prevScratchCount, prevObserver !== null);
            currentObserver = prevObserver;
            currentEvalId = prevEvalId;
            isTrackingDeps = prevTracking;
            cursor = prevCursor;
            cursorActive = prevCursorActive;
            node.flags = node.flags & ~FLAG_COMPUTING;
        }
    }

    /**
     * V8 Monomorphic Optimization:
     * Extracted specifically for Effect nodes.
     * @private
     */
    function withEffectFrame(node) {
        const prevObserver = currentObserver;
        const prevEvalId = currentEvalId;
        const prevScratchCount = scratchCount;
        const prevTracking = isTrackingDeps;
        const prevCursor = cursor;
        const prevCursorActive = cursorActive;

        currentObserver = node;
        nextEvalId = (nextEvalId + 1) | 0;
        currentEvalId = nextEvalId;
        isTrackingDeps = true;
        node.flags = node.flags | FLAG_COMPUTING;
        cursor = node.headDep;
        cursorActive = (prevObserver === null);

        try {
            node.computeFn();
        } finally {
            reconcileDeps(node, prevScratchCount, prevObserver !== null);
            currentObserver = prevObserver;
            currentEvalId = prevEvalId;
            isTrackingDeps = prevTracking;
            cursor = prevCursor;
            cursorActive = prevCursorActive;
            node.flags = node.flags & ~FLAG_COMPUTING;
        }
    }

    function executeEffect(node) {
        if ((node.flags & FLAG_COMPUTING) !== 0) throw new Error("CycleError: Infinite effect loop detected.");

        const isFirst = node.evalVersion === 0;

        if (!isFirst) {
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
                node.flags = node.flags & ~FLAG_QUEUED;
                node.evalVersion = globalVersion | 0;
                return;
            }
        }

        node.flags = node.flags & ~FLAG_QUEUED;

        runCleanup(node);

        try {
            withEffectFrame(node);
        } finally {
            node.evalVersion = globalVersion | 0;
        }
    }

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
                if (((dep.version - evalVer) | 0) > 0) {
                    shouldRun = true;
                    break;
                }
                link = link.nextDep;
            }
        }

        if (shouldRun) {
            if ((node.flags & FLAG_COMPUTING) !== 0) throw new Error("CycleError: Circular dependency detected.");
            runCleanup(node);
            withComputedFrame(node);
        }

        node.evalVersion = globalVersion | 0;
        if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;
        return node.value;
    }

    // ── PUBLIC API SURFACE ──

    function signal(initial, opts = {}) {
        const node = createNode(initial, FLAG_SIGNAL);
        node.equals = opts.equals !== undefined ? opts.equals : Object.is;
        node.version = globalVersion | 0;
        statSignals = (statSignals + 1) | 0;

        const read = () => {
            if (isTrackingDeps && currentObserver !== null) recordRead(node);
            return node.value;
        };
        read.peek = () => node.value;
        read.set = (value) => {
            const eq = node.equals;
            if (eq && eq(node.value, value)) return;
            if (currentObserver !== null && node.reachEval === currentEvalId) {
                throw new Error("CycleError: write to a signal during the compute that reads it.");
            }
            node.value = value;
            globalVersion = (globalVersion + 1) | 0;
            node.version = globalVersion | 0;
            markDownstream(node);
            if (batchDepth === 0) flushEffects();
        };
        read.update = (fn) => read.set(fn(node.value));

        read.subscribe = (fn) => {
            let captured;
            const invokeSub = () => fn(captured);
            return effect(() => {
                captured = read();
                untrack(invokeSub);
            });
        };

        read[NODE_PTR] = node;
        read[NODE_GEN] = node.gen | 0;
        return read;
    }

    function computed(fn, opts = {}) {
        const node = createNode(undefined, FLAG_COMPUTED);
        node.computeFn = fn;
        node.equals = opts.equals !== undefined ? opts.equals : Object.is;
        statComputeds = (statComputeds + 1) | 0;

        const read = () => {
            if (isTrackingDeps && currentObserver !== null) recordRead(node);
            return pullComputed(node);
        };
        read.peek = () => pullComputed(node);

        read.subscribe = (fn) => {
            let captured;
            const invokeSub = () => fn(captured);
            return effect(() => {
                captured = read();
                untrack(invokeSub);
            });
        };

        read[NODE_PTR] = node;
        read[NODE_GEN] = node.gen | 0;
        return read;
    }

    function effect(fn, opts = {}) {
        const node = createNode(undefined, FLAG_EFFECT);
        node.computeFn = fn;
        node.scheduler = opts.scheduler;
        statEffects = (statEffects + 1) | 0;

        const scheduler = opts.scheduler;
        let firstRunError = null;
        if (scheduler) {
            const gen = node.gen | 0;
            scheduler(() => safeExecute(node, gen));
        } else {
            try {
                executeEffect(node);
            } catch (err) {
                firstRunError = err;
            }
        }

        let disposed = false;
        const birthGen = node.gen | 0;
        const disposeFn = function dispose() {
            if (disposed) return;
            disposed = true;
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
        const node = api?.[NODE_PTR];

        if (!node) {
            if (typeof api === "function" && typeof api.peek !== "function") api();
            return;
        }

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

    function batch(fn) {
        batchDepth = (batchDepth + 1) | 0;
        try {
            return fn();
        } finally {
            batchDepth = (batchDepth - 1) | 0;
            if (batchDepth === 0) flushEffects();
        }
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

    function onCleanup(fn) {
        if (currentObserver !== null) {
            const existing = currentObserver.cleanupFn;
            if (existing === undefined) currentObserver.cleanupFn = fn;
            else if (typeof existing === "function") currentObserver.cleanupFn = [existing, fn];
            else existing.push(fn);
        }
    }

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
            n.headSub = null;
            n.version = 0;
            n.evalVersion = 0;
            n.markEpoch = 0;
            n.depsCount = 0;
            n.reachEval = 0;
            n.linkedInEvalMark = 0;
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
        isTrackingDeps = false;
        nextEvalId = 0 | 0;
        currentEvalId = 0 | 0;
        scratchCount = 0 | 0;
        for (let i = 0; i < scratchSources.length; i++) scratchSources[i] = undefined;
        globalVersion = 1 | 0;
        statSignals = 0 | 0;
        statComputeds = 0 | 0;
        statEffects = 0 | 0;
    }

    return {signal, computed, effect, dispose, batch, untrack, onCleanup, stats, destroy};
}

// ─────────────────────────────────────────────────────────────────
// GLOBAL BINDINGS
// ─────────────────────────────────────────────────────────────────

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

export function effect(fn, opts) {
    return defaultRegistry.effect(fn, opts);
}

export function dispose(api) {
    return defaultRegistry.dispose(api);
}

export function batch(fn) {
    return defaultRegistry.batch(fn);
}

export function untrack(fn) {
    return defaultRegistry.untrack(fn);
}

export function onCleanup(fn) {
    return defaultRegistry.onCleanup(fn);
}

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
export {watch, when, whenAsync} from "../Watch.js"