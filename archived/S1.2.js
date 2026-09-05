/**
 * @zakkster/lite-signal
 * --------------------
 * v1.2: Array-Backed, Zero-GC Reactive Graph Engine.
 *
 * Architecture:
 * - Contiguous flat arrays for topological edges (deps/subs).
 * - O(1) cursor fast-path inlined into reads.
 * - Manual pointer scans replacing megamorphic built-ins.
 * - Loop-invariant code motion (LICM) hoisting on hot paths.
 * - Zero materialization overhead on option literals.
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

        this.version = 0;
        this.evalVersion = 0;
        this.markEpoch = 0;
        this.gen = 0;

        this.preBatchValue = undefined;
        this.preBatchVersion = 0;
        this.revertEpoch = 0;

        // Zero-GC Contiguous Arrays
        this.deps = [];
        this.depsLen = 0;
        this.subs = [];
        this.subsLen = 0;
        this.currentDep = 0;

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
    const policy = (config !== undefined && config.onCapacityExceeded !== undefined) ? config.onCapacityExceeded : "throw";
    const maxFlushPasses = (config !== undefined && config.maxFlushPasses !== undefined) ? config.maxFlushPasses : 100;

    const nodePool = [];
    for (let i = 0; i < currentNodesCapacity; i++) nodePool[i] = new ReactiveNode();
    let freeNodeHead = nodePool[0];
    for (let i = 0; i < currentNodesCapacity - 1; i++) nodePool[i].nextFree = nodePool[i + 1];

    let activeNodes = 0;
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
    let currentObserver = null;
    let batchDepth = 0;
    let isTrackingDeps = false;
    let isFlushing = false;

    const flushErrorBuffer = [];
    let flushErrorCount = 0;

    // ─── HIGH-PERFORMANCE ARRAY LINKING ───────────────────────────

    // Outlined cold path for edge allocation
    function linkNodes(source, target, cursor) {
        let idx = -1;
        const tDeps = target.deps;
        const tLen = target.depsLen | 0;

        // Manual loop: beats megamorphic Array.indexOf for small lists
        for (let i = cursor; i < tLen; i++) {
            if (tDeps[i] === source) {
                idx = i;
                break;
            }
        }

        if (idx >= 0) {
            if (idx > cursor) {
                const tmp = tDeps[idx];
                tDeps[idx] = tDeps[cursor];
                tDeps[cursor] = tmp;
            }
            target.currentDep = (cursor + 1) | 0;
            return;
        }

        if (cursor < tLen) {
            tDeps[tLen] = source;
            target.depsLen = (tLen + 1) | 0;
            const tmp = tDeps[tLen];
            tDeps[tLen] = tDeps[cursor];
            tDeps[cursor] = tmp;
        } else {
            tDeps[tLen] = source;
            target.depsLen = (tLen + 1) | 0;
        }
        target.currentDep = (cursor + 1) | 0;

        const sSubs = source.subs;
        const sLen = source.subsLen | 0;
        sSubs[sLen] = target;
        source.subsLen = (sLen + 1) | 0;
    }

    function severTail(node) {
        const visitedLen = node.currentDep | 0;
        const deps = node.deps;
        const depsLen = node.depsLen | 0;

        for (let i = visitedLen; i < depsLen; i++) {
            const dep = deps[i];
            const dSubs = dep.subs;
            const dSubsLen = dep.subsLen | 0;

            let sIdx = -1;
            for (let j = 0; j < dSubsLen; j++) {
                if (dSubs[j] === node) {
                    sIdx = j;
                    break;
                }
            }

            if (sIdx >= 0) {
                dSubs[sIdx] = dSubs[dSubsLen - 1];
                dSubs[dSubsLen - 1] = null;
                dep.subsLen = (dSubsLen - 1) | 0;
            }
            deps[i] = null;
        }
        node.depsLen = visitedLen;
    }

    function disposeNode(node) {
        if (node.flags === 0) return;

        runCleanup(node);

        const deps = node.deps;
        const depsLen = node.depsLen | 0;
        for (let i = 0; i < depsLen; i++) {
            const dep = deps[i];
            const dSubs = dep.subs;
            const dSubsLen = dep.subsLen | 0;
            let sIdx = -1;
            for (let j = 0; j < dSubsLen; j++) {
                if (dSubs[j] === node) {
                    sIdx = j;
                    break;
                }
            }
            if (sIdx >= 0) {
                dSubs[sIdx] = dSubs[dSubsLen - 1];
                dSubs[dSubsLen - 1] = null;
                dep.subsLen = (dSubsLen - 1) | 0;
            }
            deps[i] = null;
        }
        node.depsLen = 0;

        const subs = node.subs;
        const subsLen = node.subsLen | 0;
        for (let i = 0; i < subsLen; i++) {
            const sub = subs[i];
            const sDeps = sub.deps;
            const sDepsLen = sub.depsLen | 0;
            let dIdx = -1;
            for (let j = 0; j < sDepsLen; j++) {
                if (sDeps[j] === node) {
                    dIdx = j;
                    break;
                }
            }
            if (dIdx >= 0) {
                sDeps[dIdx] = sDeps[sDepsLen - 1];
                sDeps[sDepsLen - 1] = null;
                sub.depsLen = (sDepsLen - 1) | 0;
            }
            subs[i] = null;
        }
        node.subsLen = 0;

        node.computeFn = undefined;
        node.cleanupFn = undefined;
        node.scheduler = undefined;
        node.value = undefined;
        node.equals = undefined;
        node.flags = 0;
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
            currentNodesCapacity = newCap;
        }

        const node = freeNodeHead;
        freeNodeHead = node.nextFree;
        node.nextFree = null;
        activeNodes = (activeNodes + 1) | 0;

        node.value = value;
        node.flags = flags | 0;
        node.depsLen = 0;
        node.subsLen = 0;
        node.version = 0;
        node.evalVersion = 0;
        node.markEpoch = 0;
        node.revertEpoch = 0;
        return node;
    }

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

    function markDownstream(startNode) {
        let stackLen = 0;
        markStack[stackLen++] = startNode;

        while (stackLen !== 0) {
            const n = markStack[--stackLen];
            const subs = n.subs;
            const len = n.subsLen | 0;

            for (let i = 0; i < len; i++) {
                const t = subs[i];
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
                            const gen = node.gen | 0;
                            scheduler(() => {
                                if (node.gen === gen && (node.flags & FLAG_EFFECT) !== 0) {
                                    executeEffect(node);
                                }
                            });
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
            const deps = node.deps;
            const len = node.depsLen | 0;
            const evalVer = node.evalVersion | 0;
            let needsRun = false;

            for (let i = 0; i < len; i++) {
                const dep = deps[i];
                if ((dep.flags & FLAG_COMPUTED) !== 0) pullComputed(dep);
                if (((dep.version - evalVer) | 0) > 0) {
                    needsRun = true;
                    break;
                }
            }
            if (!needsRun) {
                node.flags &= ~FLAG_QUEUED;
                node.evalVersion = globalVersion;
                return;
            }
        }

        node.flags = (node.flags & ~FLAG_QUEUED) | FLAG_COMPUTING;
        runCleanup(node);
        if ((node.flags & FLAG_EFFECT) === 0) return;

        const prevObserver = currentObserver;
        const prevTracking = isTrackingDeps;
        currentObserver = node;
        node.currentDep = 0;
        isTrackingDeps = true;

        try {
            node.computeFn();
        } finally {
            severTail(node);
            currentObserver = prevObserver;
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

        let shouldRun = node.evalVersion === 0;
        if (!shouldRun) {
            const deps = node.deps;
            const len = node.depsLen | 0;
            const evalVer = node.evalVersion | 0;

            for (let i = 0; i < len; i++) {
                const dep = deps[i];
                if ((dep.flags & FLAG_COMPUTED) !== 0) pullComputed(dep);
                if (((dep.version - evalVer) | 0) > 0) {
                    shouldRun = true;
                    break;
                }
            }
        }

        if (shouldRun) {
            if ((node.flags & FLAG_COMPUTING) !== 0) throw new Error("CycleError: Circular dependency detected.");
            node.flags |= FLAG_COMPUTING;
            runCleanup(node);

            const prevObserver = currentObserver;
            const prevTracking = isTrackingDeps;
            currentObserver = node;
            node.currentDep = 0;
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
                isTrackingDeps = prevTracking;
                node.flags &= ~FLAG_COMPUTING;
            }
        }

        node.evalVersion = globalVersion;
        if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;
        return node.value;
    }

    // ─── PUBLIC API ──────────────────────────────────────────────────

    function signal(initial, opts) {
        const node = createNode(initial, FLAG_SIGNAL);
        node.equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : Object.is;
        node.version = globalVersion;
        statSignals++;

        const read = () => {
            if (isTrackingDeps && currentObserver !== null) {
                // Inlined O(1) cursor fast-path prevents outline call frame allocation
                const cursor = currentObserver.currentDep | 0;
                const tDeps = currentObserver.deps;
                if (cursor < currentObserver.depsLen && tDeps[cursor] === node) {
                    currentObserver.currentDep = (cursor + 1) | 0;
                } else {
                    linkNodes(node, currentObserver, cursor);
                }
            }
            return node.value;
        };

        read.peek = () => node.value;

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

        read.update = (fn) => read.set(fn(node.value));

        read.subscribe = (fn) => {
            return effect(() => {
                const val = read();
                // Direct untrack execution drops allocation to a single closure.
                // Tightly coupled to isTrackingDeps mechanics.
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
                const cursor = currentObserver.currentDep | 0;
                const tDeps = currentObserver.deps;
                if (cursor < currentObserver.depsLen && tDeps[cursor] === node) {
                    currentObserver.currentDep = (cursor + 1) | 0;
                } else {
                    linkNodes(node, currentObserver, cursor);
                }
            }
            return pullComputed(node);
        };

        read.peek = () => pullComputed(node);

        read.subscribe = (fn) => {
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
            node.scheduler(() => {
                if (node.gen === gen && (node.flags & FLAG_EFFECT) !== 0) executeEffect(node);
            });
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
                statEffects--;
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
            const isSig = (node.flags & FLAG_SIGNAL) !== 0;
            const isComp = (node.flags & FLAG_COMPUTED) !== 0;
            disposeNode(node);
            if (isSig) statSignals--;
            if (isComp) statComputeds--;
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
            nodePoolCapacity: currentNodesCapacity,
            activeNodes
        };
    }

    function destroy() {
        for (let i = 0; i < currentNodesCapacity; i++) {
            const n = nodePool[i];
            n.flags = 0;
            n.deps.length = 0;
            n.subs.length = 0;
            n.depsLen = 0;
            n.subsLen = 0;
            n.gen = (n.gen + 1) | 0;
            if (i < currentNodesCapacity - 1) n.nextFree = nodePool[i + 1];
        }
        nodePool[currentNodesCapacity - 1].nextFree = null;
        freeNodeHead = nodePool[0];
        activeNodes = 0;
        activeQueueLen = 0;
        isFlushing = false;
        batchDepth = 0;
        currentObserver = null;
        isTrackingDeps = false;
        globalVersion = 1;
        batchEpoch = 1;
        statSignals = 0;
        statComputeds = 0;
        statEffects = 0;
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

export function destroy() {
    return defaultRegistry.destroy();
}

export {watch, when, whenAsync} from "../Watch.js";