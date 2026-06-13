/**
 * @zakkster/lite-signal v1.2.0
 * --------------------
 * Hybrid Doubly-Linked-List Reactive Graph Engine — decoupled (Signal1_3) base
 * with the two 1.1.3 performance fixes ported in:
 *   1. pullComputed clean short-circuit (markEpoch) — kills the dynamic-graph
 *      regression: "large web app" 4900ms -> 665ms, "wide dense" 4472 -> 952.
 *   2. allocateLink: O(1) tailSub dedup replaces the O(N) prefix scan — divergent
 *      re-tracking is O(N) not O(N^2) (600-dep flip micro: 1373ms -> 62ms).
 * Ownership tree + L1/L2/L3 layering + observer/owner split are UNCHANGED; they
 * were never the regression. Same EDGE NOTE as 1.1.3 applies to fix (2): a nested
 * re-read of the same source can retain one bounded, dispose-reclaimed link.
 *
 * Original header:
 * v1.3.2: Hybrid Doubly-Linked-List Reactive Graph Engine.
 *
 * Performance model:
 * - ReactiveLink DLL object pool guarantees O(1) graph edge allocation.
 * - Inlined O(1) cursor fast-path for stable steady-state reads.
 * - Divergence triggers immediate tail-severing to bound worst-case complexity.
 * - O(1) Owner Context Tree ensures automatic teardown of nested observers.
 *
 * ── ARCHITECTURE: three layers + a public API, with a strict dependency direction ──
 *
 *   L1  GRAPH TOPOLOGY      allocateLink, freeLink, severTail
 *       Owns the ReactiveLink pool and the dep/sub doubly-linked lists.
 *       INVARIANT: never touches `owner`/`firstOwned`. Pure edge mechanics.
 *
 *   L2  OWNERSHIP / LIFECYCLE   createNode, disposeNode, runCleanup
 *       Owns the owner tree and node death + user cleanup.
 *       INVARIANT: never touches the `activeObserverCurrentDep` cursor.
 *       Sanctioned downward edge → L1: disposeNode walks a dying node's own
 *       dep/sub lists and calls freeLink to extract it from the graph.
 *
 *   L3  PROPAGATION / EXECUTION   markDownstream, flushEffects, executeEffect, pullComputed
 *       The engine. markDownstream is itself owner-free and cursor-free
 *       (a pure propagation primitive). executeEffect/pullComputed are the
 *       ORCHESTRATORS: they drive the cursor + severTail (L1) AND, before a
 *       re-run, call runCleanup (L2) to cascade-dispose owned children.
 *       Sanctioned upward call → L2: executeEffect/pullComputed → runCleanup.
 *
 *   API  signal, computed, effect, dispose, batch, untrack, onCleanup, stats, destroy
 *
 *   The only cross-layer edges are L3→runCleanup and L2→freeLink. The graph of
 *   dependencies is acyclic; nothing in L1 reaches up, nothing in L2 touches
 *   the cursor, and the engine is the single place the two subsystems meet.
 *
 * ── OWNER vs OBSERVER ──
 *   `currentObserver` = the node whose READS establish dependencies (tracking).
 *   `currentOwner`    = the node that OWNS anything created right now (lifecycle).
 *   Today they move together, so behaviour is unchanged — but they are distinct
 *   pointers so future runWithOwner/createRoot can attach ownership without
 *   establishing reactive dependencies (and untrack can suppress tracking
 *   without orphaning created nodes). createNode and onCleanup key off the
 *   OWNER; the read fast-path and allocateLink key off the OBSERVER.
 */

const FLAG_COMPUTED = 1 << 0;
const FLAG_EFFECT = 1 << 1;
const FLAG_QUEUED = 1 << 2;
const FLAG_COMPUTING = 1 << 3;
const FLAG_HAS_ERROR = 1 << 4;
const FLAG_SIGNAL = 1 << 5;

class ReactiveNode {
    constructor() {
        this.flags = 0;
        this.value = undefined;
        this.computeFn = undefined;
        this.cleanupFn = undefined;
        this.equals = undefined;
        this.scheduler = undefined;
        this.schedulerThunk = undefined;

        this.version = 0;
        this.evalVersion = 0;
        this.markEpoch = 0;
        this.gen = 0;
        this.id = 0;

        this.preBatchValue = undefined;
        this.preBatchVersion = 0;
        this.revertEpoch = 0;

        this.headDep = null;
        this.tailDep = null;
        this.headSub = null;
        this.tailSub = null;

        // Owner Context Tree (Auto-Disposal of Nested Observers)
        this.owner = null;
        this.prevOwned = null;
        this.nextOwned = null;
        this.firstOwned = null;

        this.nextFree = null;
    }
}

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

export class CapacityError extends Error {
    constructor(kind, capacity) {
        super(`CapacityError: ${kind} capacity (${capacity}) exceeded.`);
        this.name = "CapacityError";
        this.kind = kind;
        this.capacity = capacity;
    }
}

export function createRegistry(config) {
    const NODE_PTR = Symbol("node_ptr");
    const NODE_GEN = Symbol("node_gen");

    let currentNodesCapacity = (config !== undefined && config.maxNodes !== undefined) ? config.maxNodes : 1024;
    let currentLinkCapacity = (config !== undefined && config.maxLinks !== undefined) ? config.maxLinks : currentNodesCapacity * 4;
    const policy = (config !== undefined && config.onCapacityExceeded !== undefined) ? config.onCapacityExceeded : "throw";
    const maxFlushPasses = (config !== undefined && config.maxFlushPasses !== undefined) ? config.maxFlushPasses : 100;
    const maxLinkLimit = currentLinkCapacity * 16;

    const nodePool = [];
    for (let i = 0; i < currentNodesCapacity; i++) nodePool[i] = new ReactiveNode();
    let freeNodeHead = nodePool[0];
    for (let i = 0; i < currentNodesCapacity - 1; i++) nodePool[i].nextFree = nodePool[i + 1];

    const linkPool = [];
    for (let i = 0; i < currentLinkCapacity; i++) linkPool[i] = new ReactiveLink();
    let freeLinkHead = linkPool[0];
    for (let i = 0; i < currentLinkCapacity - 1; i++) linkPool[i].nextFree = linkPool[i + 1];

    let activeNodes = 0;
    let activeLinks = 0;
    let statSignals = 0;
    let statComputeds = 0;
    let statEffects = 0;

    const effectQueueA = [];
    const effectQueueB = [];
    const markStack = [];
    let activeQueue = effectQueueA;
    let activeQueueLen = 0;
    let isQueueA = true;

    let globalVersion = 1;
    let batchEpoch = 1;
    let currentObserver = null;           // tracking context: whose reads link deps
    let currentOwner = null;              // lifecycle context: who owns nodes created now
    let activeObserverCurrentDep = null;
    let batchDepth = 0;
    let isTrackingDeps = false;

    // ── Node identity + observer-lifecycle introspection (ported from 1.1.5) ──
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

    // ═══ L1 · GRAPH TOPOLOGY ══════════════════════════════════════
    // Owns the ReactiveLink pool and the dep/sub lists. Pure edge mechanics:
    // INVARIANT — must never touch node.owner / firstOwned.

    // ─── HYBRID ALLOCATOR ─────────────────────────────────────────

    function allocateLink(source, target) {
        // Eligibility gate (restored from 1.1.5): an observer disposed mid-run (self-dispose, or
        // an outer observer torn down while suspended) has flags cleared to 0. Linking would splice
        // a dead, pool-bound node back into source's subscriber list — a phantom edge. Cold path only.
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
            if (policy === "throw") throw new CapacityError("links", currentLinkCapacity);
            const newCap = currentLinkCapacity * 2;
            if (newCap > maxLinkLimit) throw new CapacityError("links", maxLinkLimit);

            const newLinks = new Array(newCap - currentLinkCapacity);
            for (let i = 0; i < newLinks.length; i++) newLinks[i] = new ReactiveLink();
            for (let i = 0; i < newLinks.length - 1; i++) newLinks[i].nextFree = newLinks[i + 1];

            const startIdx = linkPool.length;
            linkPool.length = newCap;
            for (let i = 0; i < newLinks.length; i++) linkPool[startIdx + i] = newLinks[i];
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
        const _was0 = lifecycleCount !== 0 && source.headSub === null;   // 0→1 detect (pre-link)
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
    }

    function freeLink(link, target, source) {
        const pSub = link.prevSub;
        const nSub = link.nextSub;
        if (pSub !== null) pSub.nextSub = nSub; else source.headSub = nSub;
        if (nSub !== null) nSub.prevSub = pSub; else source.tailSub = pSub;
        if (lifecycleCount !== 0 && source.headSub === null) fireDisconnect(source);   // 1→0

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

    // ═══ L2 · OWNERSHIP / LIFECYCLE ═══════════════════════════════
    // Owns the owner tree, node death, and user cleanup.
    // INVARIANT — must never touch the activeObserverCurrentDep cursor.
    // Sanctioned downward edge → L1: disposeNode calls freeLink to extract a
    // dying node from the graph.

    // ─── LIFECYCLE & OWNERSHIP ───────────────────────────────────────

    function disposeNode(node) {
        if (node.flags === 0) return;

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

        // CROSS-EDGE L2→L1: extract this node's own edges from the graph.
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
        node.revertEpoch = 0;
        node.preBatchValue = undefined;
        node.preBatchVersion = 0;

        node.gen = (node.gen + 1) | 0;
        node.nextFree = freeNodeHead;
        freeNodeHead = node;
        activeNodes = (activeNodes - 1) | 0;
    }

    function createNode(value, flags) {
        if (freeNodeHead === null) {
            if (policy === "throw") throw new CapacityError("nodes", currentNodesCapacity);
            const newCap = currentNodesCapacity * 2;
            const newNodes = new Array(newCap - currentNodesCapacity);
            for (let i = 0; i < newNodes.length; i++) newNodes[i] = new ReactiveNode();
            for (let i = 0; i < newNodes.length - 1; i++) newNodes[i].nextFree = newNodes[i + 1];

            const startIdx = nodePool.length;
            nodePool.length = newCap;
            for (let i = 0; i < newNodes.length; i++) nodePool[startIdx + i] = newNodes[i];
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
        node.tailSub = null;
        node.version = 0;
        node.evalVersion = 0;
        node.markEpoch = 0;
        node.revertEpoch = 0;
        node.preBatchValue = undefined;
        node.preBatchVersion = 0;
        node.id = nodeSeq; nodeSeq = (nodeSeq + 1) | 0;   // fresh identity per allocation (ported from 1.1.5)

        // Wire into Owner Context (lifecycle, not tracking — keyed off currentOwner).
        // ONLY observers (computed/effect) are adopted: a re-running owner disposes
        // its nested observers (which would otherwise leak dep links), but plain
        // signals have no deps to leak, and disposing them breaks lazy-allocation
        // libraries (lite-store allocates a key's signal on first read, INSIDE the
        // reading computed — adopting it meant that computed's next run wiped the
        // store key). Signals are therefore never owner-adopted.
        // firstOwned is reset unconditionally (reuse-safety: a recycled former-owner
        // must not carry stale children into runCleanup). prevOwned/nextOwned are
        // written only on the adoption path -- an unadopted node is in no owner's
        // firstOwned chain, so its prevOwned/nextOwned are never traversed and may
        // stay stale. Saves two writes per signal and per top-level computed/effect.
        node.firstOwned = null;
        if (currentOwner !== null && (flags & (FLAG_COMPUTED | FLAG_EFFECT)) !== 0) {
            node.owner = currentOwner;
            node.prevOwned = null;
            node.nextOwned = currentOwner.firstOwned;
            if (currentOwner.firstOwned !== null) {
                currentOwner.firstOwned.prevOwned = node;
            }
            currentOwner.firstOwned = node;
        } else {
            node.owner = null;
        }

        return node;
    }

    function runCleanup(node) {
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

        // Auto-dispose all nested observers
        let child = node.firstOwned;
        while (child !== null) {
            let next = child.nextOwned;
            // Detach immediately to optimize disposeNode processing
            child.owner = null;
            child.prevOwned = null;
            child.nextOwned = null;
            disposeNode(child);
            child = next;
        }
        node.firstOwned = null;
    }

    // ═══ L3 · PROPAGATION / EXECUTION ═════════════════════════════
    // markDownstream is owner-free AND cursor-free (a pure propagation
    // primitive). executeEffect/pullComputed are the orchestrators: they drive
    // the cursor + severTail (L1) and, before a re-run, call runCleanup (L2) to
    // cascade-dispose owned children. Sanctioned upward call → L2: runCleanup.

    // ─── EXECUTION ENGINE ─────────────────────────────────────────

    function markDownstream(startNode) {
        let stackLen = 0;
        markStack[stackLen++] = startNode;

        while (stackLen !== 0) {
            const n = markStack[--stackLen];
            let link = n.headSub;

            while (link !== null) {
                const t = link.target;
                if (t.markEpoch !== globalVersion) {
                    t.markEpoch = globalVersion;
                    const flags = t.flags;

                    if ((flags & FLAG_EFFECT) !== 0) {
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

    function flushEffects() {
        if (isFlushing) return;
        isFlushing = true;
        let passes = 0;
        let normalExit = false;

        try {
            while (activeQueueLen > 0) {
                if (++passes > maxFlushPasses) throw new Error("CycleError: flush passes exceeded");
                const toRun = activeQueueLen | 0;
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
        runCleanup(node);   // CROSS-EDGE L3→L2: dispose owned children before re-run
        if ((node.flags & FLAG_EFFECT) === 0) return;

        const prevObserver = currentObserver;
        const prevOwner = currentOwner;
        const prevActiveDep = activeObserverCurrentDep;
        const prevTracking = isTrackingDeps;

        currentObserver = node;
        currentOwner = node;
        activeObserverCurrentDep = node.headDep;
        isTrackingDeps = true;

        try {
            node.computeFn();
        } finally {
            severTail(node);

            currentObserver = prevObserver;
            currentOwner = prevOwner;
            activeObserverCurrentDep = prevActiveDep;
            isTrackingDeps = prevTracking;

            node.flags &= ~FLAG_COMPUTING;
            node.evalVersion = globalVersion;
        }
    }

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
            runCleanup(node);   // CROSS-EDGE L3→L2: dispose owned children before recompute

            const prevObserver = currentObserver;
            const prevOwner = currentOwner;
            const prevActiveDep = activeObserverCurrentDep;
            const prevTracking = isTrackingDeps;

            currentObserver = node;
            currentOwner = node;
            activeObserverCurrentDep = node.headDep;
            isTrackingDeps = true;

            try {
                const newValue = node.computeFn();
                const eq = node.equals;
                if (node.evalVersion === 0 || !eq || !eq(node.value, newValue)) {
                    node.value = newValue;
                    node.version = globalVersion;
                }
                node.flags &= ~FLAG_HAS_ERROR;
            } catch (err) {
                node.value = err;
                node.flags |= FLAG_HAS_ERROR;
                node.version = globalVersion;
            } finally {
                severTail(node);

                currentObserver = prevObserver;
                currentOwner = prevOwner;
                activeObserverCurrentDep = prevActiveDep;
                isTrackingDeps = prevTracking;

                node.flags &= ~FLAG_COMPUTING;
            }
        }

        node.evalVersion = globalVersion;
        if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;
        return node.value;
    }

    // ─── PUBLIC API ──────────────────────────────────────────────────

    // ─── shared accessor methods (one set per registry, not per primitive) ───────
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

    function signal(initial, opts) {
        const node = createNode(initial, FLAG_SIGNAL);
        node.equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : Object.is;
        node.version = globalVersion;
        statSignals++;

        const read = () => {
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

        read.peek = () => node.value;
        // set stays a CLOSURE (byte-identical to 1.2.0): its call path is the hot
        // path, and a closure over `node` beats a shared method's this[NODE_PTR]
        // load. Keeping it a closure also restores detached `const {set}=signal()`.
        read.set = (value) => {
            const eq = node.equals;
            if (eq && eq(node.value, value)) return;
            if (batchDepth > 0 && node.revertEpoch !== batchEpoch) {
                node.preBatchValue = node.value;
                node.preBatchVersion = node.version;
                node.revertEpoch = batchEpoch;
            }
            node.value = value;
            if (batchDepth > 0 && node.revertEpoch === batchEpoch && eq && eq(node.preBatchValue, value)) {
                node.version = node.preBatchVersion;
                return;
            }
            globalVersion = (globalVersion + 1) | 0;
            node.version = globalVersion;
            markDownstream(node);
            if (batchDepth === 0) flushEffects();
        };
        read.update = sharedUpdate;        // shared: cold path, calls this.set (the closure above)
        read.subscribe = sharedSubscribe;  // shared: cold path, recovers via `this`

        read[NODE_PTR] = node;
        read[NODE_GEN] = node.gen;
        return read;
    }

    function computed(fn, opts) {
        const node = createNode(undefined, FLAG_COMPUTED);
        node.computeFn = fn;
        node.equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : Object.is;
        statComputeds++;

        const read = () => {
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

        read.peek = () => pullComputed(node);
        read.subscribe = sharedSubscribe;

        read[NODE_PTR] = node;
        read[NODE_GEN] = node.gen;
        return read;
    }

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
            // (gen bumps on disposeNode → stale thunk no-ops).
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

    function batch(fn) {
        if (batchDepth === 0) {
            batchEpoch = (batchEpoch + 1) | 0;
            if (batchEpoch === 0) batchEpoch = 1;
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

    function onCleanup(fn) {
        if (currentOwner !== null) {
            const existing = currentOwner.cleanupFn;
            if (existing === undefined) currentOwner.cleanupFn = fn;
            else if (typeof existing === "function") currentOwner.cleanupFn = [existing, fn];
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
            n.tailSub = null;
            n.version = 0;
            n.evalVersion = 0;
            n.markEpoch = 0;
            n.revertEpoch = 0;
            n.preBatchValue = undefined;
            n.preBatchVersion = 0;

            n.owner = null;
            n.prevOwned = null;
            n.nextOwned = null;
            n.firstOwned = null;

            n.gen = (n.gen + 1) | 0;

            effectQueueA[i] = null;
            effectQueueB[i] = null;
            markStack[i] = null;

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
        batchEpoch = 1;
        statSignals = 0;
        statComputeds = 0;
        statEffects = 0;

        for (let i = 0; i < flushErrorCount; i++) flushErrorBuffer[i] = null;
        flushErrorCount = 0;
        flushErrorBuffer.length = 0;
    }

    function hasObservers(handle) {
        const node = handle != null ? handle[NODE_PTR] : undefined;
        return node !== undefined && node.headSub !== null;
    }
    function observeObservers(handle, opts) {
        const node = handle != null ? handle[NODE_PTR] : undefined;
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
        const d = {id: node.id, kind, value: node.value};
        Object.defineProperty(d, NODE_PTR, {value: node, enumerable: false});
        return d;
    }
    function nodeId(handle) {
        const node = handle != null ? handle[NODE_PTR] : undefined;
        return node !== undefined ? node.id : undefined;
    }
    function describe(handle) {
        const node = handle != null ? handle[NODE_PTR] : undefined;
        return node !== undefined ? describeNode(node) : undefined;
    }
    function forEachObserver(handle, fn) {
        const node = handle != null ? handle[NODE_PTR] : undefined;
        if (node === undefined) return;
        let l = node.headSub;
        while (l !== null) { const nx = l.nextSub; fn(describeNode(l.target)); l = nx; }
    }
    function forEachSource(handle, fn) {
        const node = handle != null ? handle[NODE_PTR] : undefined;
        if (node === undefined) return;
        let l = node.headDep;
        while (l !== null) { const nx = l.nextDep; fn(describeNode(l.source)); l = nx; }
    }

    return {signal, computed, effect, dispose, batch, untrack, onCleanup, stats, destroy, isTracking, hasObservers, observeObservers, forEachObserver, forEachSource, nodeId, describe};
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
export function nodeId(handle) {
    return defaultRegistry.nodeId(handle);
}
export function describe(handle) {
    return defaultRegistry.describe(handle);
}

export {watch, when, whenAsync} from "../Watch.js";