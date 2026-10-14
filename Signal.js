/**
 * @zakkster/lite-signal v1.5.2
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
 *
 *   TRACKING INVARIANT (LEDGER #30): tracking is on iff `currentObserver !== null`.
 *   There is no separate `isTrackingDeps` flag -- it was folded into the observer
 *   pointer (they were always set and cleared together). To suppress tracking,
 *   untrack / subscribe callbacks / fireConnect|Disconnect / runCleanup NULL the
 *   observer for the window and restore it after. The restore is gen-safe: if the
 *   suppressed body disposed the very observer it ran under (self-dispose bumps
 *   node.gen and disposeNode already nulls currentObserver), the observer is NOT
 *   put back -- restore is `(po !== null && po.gen === pg) ? po : null`, mirroring
 *   disposeNode's own self-dispose guard so a recycled slot is never re-entered.
 *
 * -- WRITE DURING AN EVALUATION (F-b33-1) --
 *   A write made while some body is mid-run (cursorDepth !== 0, untrack included)
 *   goes through markDownstreamInEval: the same marking, plus FLAG_STALE_READ on
 *   every reader that is itself mid-run (COMPUTING) and is not the writer
 *   (writer = currentObserver, else currentOwner: an untrack-wrapped or watch-
 *   callback self-write stays absorbed). A write made before a body's first
 *   read -- by its own cleanups or its owned children's (runCleanup) -- is seen,
 *   not stale: disposeOwned / runOwnCleanup clear the node's own flag (gen-
 *   guarded). After its run a stale effect is
 *   re-queued with evalVersion 0 (requeueStaleEffect) and runs again in the same
 *   flush; a stale computed is re-pulled in the same read (computedRunTail).
 *   A write that lands during the dependency pre-walk moves this node's
 *   markEpoch: pullMoved / pullComputed compare it across the walk and run the
 *   body. A never-settling loop throws "CycleError:" where it forms -- effects
 *   through flushEffects' maxFlushPasses, computeds when the nested re-pull
 *   count reaches maxFlushPasses -- including from effect() creation and reads.
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
// F-b33-1: set only by markDownstreamInEval on a mid-run (COMPUTING) reader that is not the writer:
// the run read a value a later write in the same evaluation changed. Internal, transient.
const FLAG_STALE_READ = 1 << 6;
const FLAG_QUEUED_STALE = FLAG_QUEUED | FLAG_STALE_READ;
const FLAG_ERR_OR_STALE = FLAG_HAS_ERROR | FLAG_STALE_READ;

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

        /** Captured value at first .set() inside the current batch (pre-batch revert detection). */
        this.preBatchValue = undefined;
        /** Captured version at first .set() inside the current batch. */
        this.preBatchVersion = 0;
        /** batchEpoch that owns the capture; 0 = no capture. */
        this.revertEpoch = 0;

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
/** The only config keys {@link createRegistry} recognizes. Anything else is
 *  rejected at construction with a did-you-mean hint (fail closed on an
 *  unverified state -- an unknown key is an error, never a silent ignore). */
const ALLOWED_KEYS = ["maxNodes", "maxLinks", "prealloc", "onCapacityExceeded", "maxFlushPasses"];

/** Ceiling on eager pool construction: `(maxNodes + maxLinks)` objects. A finite
 *  but absurd `maxNodes` (e.g. `1e9`, a plausible typo for `1e5`) that would
 *  otherwise OOM the process is refused BY NAME at construction rather than
 *  allocating forever. Only the `"eager"` path is bounded; `"lazy"` keeps its
 *  unbounded ledger. `1 << 24` == 16777216. */
const EAGER_CONSTRUCT_CEILING = 1 << 24;

/**
 * Levenshtein edit distance between two short strings. Cold: called only on the
 * constructor error path, over the known option names, so its per-call array
 * allocation never touches any hot path.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    const prev = new Array(n + 1);
    const cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            let min = prev[j] + 1;
            if (cur[j - 1] + 1 < min) min = cur[j - 1] + 1;
            if (prev[j - 1] + cost < min) min = prev[j - 1] + cost;
            cur[j] = min;
        }
        for (let j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
}

/**
 * The closest known config key to `key` within edit distance 2 (case-folded so
 * `preAlloc`/`MAXNODES` resolve), or null when nothing is close. Cold path only.
 * @param {string} key
 * @returns {string|null}
 */
function suggestKey(key) {
    const lk = key.toLowerCase();
    let best = null;
    let bestD = 3;
    for (let i = 0; i < ALLOWED_KEYS.length; i++) {
        const d = editDistance(lk, ALLOWED_KEYS[i].toLowerCase());
        if (d < bestD) { bestD = d; best = ALLOWED_KEYS[i]; }
    }
    return bestD <= 2 ? best : null;
}

/**
 * Render a rejected value for an error message, e.g. `42 (number)`.
 * Cold: this runs only on a throw path, never on any hot path. `String(symbol)`
 * throws, so symbols are stringified defensively.
 * @param {*} v
 * @returns {string}
 */
function received(v) {
    return (typeof v === "symbol" ? v.toString() : String(v)) + " (" + typeof v + ")";
}

/**
 * Validate that a numeric option is a finite integer >= 1. Cold: constructor
 * error path only. Throws a {@link TypeError} prefixed `createRegistry: "<name>"`.
 * @param {*} v
 * @param {string} name
 */
function requirePositiveInt(v, name) {
    if (!Number.isInteger(v) || v < 1) {
        throw new TypeError(
            'createRegistry: "' + name + '" must be a finite integer >= 1, received ' + received(v) + '.'
        );
    }
}

export function createRegistry(config) {
    const NODE_PTR = Symbol("node_ptr");
    const NODE_GEN = Symbol("node_gen");

    // --- 1.4.5 backport: createRegistry input validation (all cold, constructor-only).
    // Config-shape gate: accept `undefined` or a non-null, non-array object; reject
    // `null`, primitives and arrays BY NAME rather than dying later on `config.maxNodes`
    // or an internal `nextFree` read (fail closed on an unverified state).
    if (config !== undefined && (config === null || typeof config !== "object" || Array.isArray(config))) {
        throw new TypeError(
            'createRegistry: "config" must be a plain object or undefined, received ' + received(config) + '.'
        );
    }
    if (config !== undefined) {
        // Per-option validation BY NAME -- a bad value throws `createRegistry: "<option>"`
        // at construction, not a delayed internal TypeError on first use.
        if (config.maxNodes !== undefined) requirePositiveInt(config.maxNodes, "maxNodes");
        if (config.maxLinks !== undefined) requirePositiveInt(config.maxLinks, "maxLinks");
        if (config.maxFlushPasses !== undefined) requirePositiveInt(config.maxFlushPasses, "maxFlushPasses");
        if (config.prealloc !== undefined && config.prealloc !== "eager" && config.prealloc !== "lazy") {
            throw new TypeError(
                'createRegistry: "prealloc" must be "eager" or "lazy", received ' + received(config.prealloc) + '.'
            );
        }
        if (config.onCapacityExceeded !== undefined && config.onCapacityExceeded !== "throw" && config.onCapacityExceeded !== "grow") {
            throw new TypeError(
                'createRegistry: "onCapacityExceeded" must be "throw" or "grow", received ' + received(config.onCapacityExceeded) + '.'
            );
        }
        // Unknown-key rejection with a did-you-mean hint (`preAlloc` -> `prealloc`,
        // `maxNods` -> `maxNodes`). Own enumerable keys only; cold path.
        const badKeys = Object.keys(config);
        for (let bi = 0; bi < badKeys.length; bi++) {
            const bk = badKeys[bi];
            if (ALLOWED_KEYS.indexOf(bk) === -1) {
                const hint = suggestKey(bk);
                throw new TypeError(
                    'createRegistry: "' + bk + '" is not a recognized option' +
                    (hint !== null ? ' (did you mean "' + hint + '"?)' : '') +
                    '. Allowed: ' + ALLOWED_KEYS.join(", ") + '.'
                );
            }
        }
    }
    // --- end 1.4.5 backport.

    let currentNodesCapacity = (config !== undefined && config.maxNodes !== undefined) ? config.maxNodes : 1024;
    let currentLinkCapacity = (config !== undefined && config.maxLinks !== undefined) ? config.maxLinks : currentNodesCapacity * 4;
    const policy = (config !== undefined && config.onCapacityExceeded !== undefined) ? config.onCapacityExceeded : "throw";
    const maxFlushPasses = (config !== undefined && config.maxFlushPasses !== undefined) ? config.maxFlushPasses : 100;
    const maxLinkLimit = currentLinkCapacity * 16;

    // Lazy pool population (P1): maxNodes / maxLinks are capacity ledgers,
    // not eager construction counts. Nodes/links are constructed on first
    // demand and recycled through the free lists thereafter -- the zero-GC
    // steady state is identical after warm-up, but the heap no longer carries
    // never-used live objects for every major GC to mark.
    const prealloc = (config !== undefined && config.prealloc !== undefined) ? config.prealloc : "eager";
    // Eager-construction ceiling (cold): `"eager"` builds `(maxNodes + maxLinks)`
    // objects up front; a finite-but-absurd capacity (e.g. `1e9`) would OOM the
    // process with an uncatchable SIGABRT, not a throw. Refuse BY NAME before
    // allocating. Named for the larger driver. `"lazy"` keeps its unbounded ledger.
    if (prealloc === "eager" && (currentNodesCapacity + currentLinkCapacity) > EAGER_CONSTRUCT_CEILING) {
        const driver = currentLinkCapacity > currentNodesCapacity ? "maxLinks" : "maxNodes";
        throw new TypeError(
            'createRegistry: "' + driver + '" eager construction of ' +
            (currentNodesCapacity + currentLinkCapacity) + ' objects (maxNodes ' +
            currentNodesCapacity + ' + maxLinks ' + currentLinkCapacity + ') exceeds the ceiling of ' +
            EAGER_CONSTRUCT_CEILING + '. Use prealloc:"lazy" for an unbounded on-demand ledger, ' +
            'or lower the capacity.'
        );
    }
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

    const effectQueueA = [];
    const effectQueueB = [];
    let activeQueue = effectQueueA;
    let activeQueueLen = 0;
    let isQueueA = true;

    // 0 is reserved for "unset" (evalVersion / markEpoch stamps): the read.set / boxSet bumps skip it via `|| 1` (F29).
    let globalVersion = 1;
    let batchEpoch = 1;
    let currentObserver = null;           // tracking context: whose reads link deps
    let currentOwner = null;              // lifecycle context: who owns nodes created now
    let activeObserverCurrentDep = null;
    let batchDepth = 0;
    // A1 cursor stack (F15): the SAVED re-tracking cursors of suspended frames. executeEffect /
    // pullComputed push the outer cursor on entry and pop it on exit, so disposeNode can repair a
    // cursor no matter how deep the frame that holds it is suspended (repairCursor / dropCursors).
    // A frame entered at depth d saves into slot d. At depth 0 there is no outer frame and the
    // live cursor is always null, so a depth-0 frame skips both the store and the load and
    // restores null (r3: the keyed store + load were the cost every top-level flush paid per
    // effect, measured on fanout64). Slot 0 is never written; repairCursor / dropCursors only
    // ever replace a slot that already holds the link, so it stays null.
    // Holds links only; preallocated to 32 slots and grows only at a new maximum depth.
    // cursorDepth is a Smi and balanced on every exit path: every push sits right before a
    // `try` whose `finally` pops; the only user code inside that `finally` before the pop
    // (the epilogue severTail) runs through severTailFrame, which pops and restores on a
    // throw. destroy() leaves it alone -- the frames that called it unwind through it.
    const cursorStack = [];
    for (let i = 0; i < 32; i++) cursorStack.push(null);
    let cursorDepth = 0;
    // A1.8 (S2): slots of nodes disposed while RUNNING (FLAG_COMPUTING). A suspended frame
    // may still hold such a node as its saved observer/owner; recycling the slot before
    // every frame has unwound would re-seat a stranger. Released into the free list only
    // at depth 0 (releasePinned).
    let pinnedHead = null;

    // -- Node identity + observer-lifecycle introspection (ported from 1.1.5) --
    let nodeSeq = 1 | 0;
    let lifecycleCount = 0 | 0;
    const lifecycleMap = new WeakMap();
    function fireConnect(node) {
        const e = lifecycleMap.get(node);
        if (e === undefined || e.onConnect === undefined) return;
        // A1.6: #30 gen-safe restore -- a callback that disposes the observer does not re-seat it.
        const po = currentObserver, pg = po !== null ? po.gen : 0;
        currentObserver = null;
        try { e.onConnect(); } finally { currentObserver = (po !== null && po.gen === pg) ? po : null; }
    }
    function fireDisconnect(node) {
        const e = lifecycleMap.get(node);
        if (e === undefined || e.onDisconnect === undefined) return;
        const po = currentObserver, pg = po !== null ? po.gen : 0;
        currentObserver = null;
        try { e.onDisconnect(); } finally { currentObserver = (po !== null && po.gen === pg) ? po : null; }
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
    // 4 link-remove, 5 recompute.
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

        // SEVER-FIRST (A1.3): the walk is severTail's list-consistent one. A lifecycle
        // callback inside it may dispose `target` or `source`, and may recycle the slot
        // into a new resident (flags non-zero again), so re-check by GEN, not flags (cold:
        // mismatch path only) before linking.
        if (activeObserverCurrentDep !== null) {
            const sg = source.gen, tg = target.gen;
            severTail(target);
            if (source.gen !== sg || target.gen !== tg) return null;
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
                // The `> maxLinkLimit` arm is provably unreachable, retained as a clamp.
                // Proof: maxLinkLimit === initialLinkCapacity * 16, currentLinkCapacity is
                // only ever assigned a power-of-2 multiple of that same initial capacity,
                // so 16x is ON the doubling chain (m, 2m, 4m, 8m, 16m). The guard above
                // (`linkPool.length >= maxLinkLimit -> CapacityError`) plus the chunk math
                // (`chunk = limit - linkPool.length`) cap linkPool.length AT maxLinkLimit,
                // so `doubled` terminates at exactly 16m and can never exceed it.
                /* c8 ignore next -- unreachable clamp; see proof above + COVERAGE-NOTES.md */
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

        let tail = target.tailDep;
        link.prevDep = tail;
        link.nextDep = null;
        if (tail !== null) tail.nextDep = link;
        else target.headDep = link;
        target.tailDep = link;
        // A1.5 (S1): onConnect runs only once the edge is in BOTH lists, so a callback that
        // disposes `source` (or `target`) unlinks a whole edge. Op order stays connect, op 3.
        if (_was0) fireConnect(source);
        if (mutationHook !== null) mutationHook(3, source.id, target.id);
    }

    /** Return a link to the free pool and unlink it from the source's sub list. @private */
    function freeLink(link, target, source) {
        // Every caller (allocateLink sever, severTail, disposeNode dep-walk) passes a
        // LIVE link: `source === link.source`, `target === link.target`. The 1.3.x
        // `link.source !== null ? ... : -1` guards existed only to survive a cursor
        // dangling at an already-freed link -- a state disposeNode's CURSOR REPAIR now
        // makes unreachable. Reading the params directly is equivalent and branch-free.
        if (mutationHook !== null) {
            mutationHook(4, source.id, target.id);
            // C10: a hook that disposed `source` (or `target`) already freed this link via the
            // source's sub-list walk; freeing it again would double-free it. Op order unchanged.
            // Both ends are compared: a freed link recycled into a new edge from the same
            // source slot would pass a source-only test.
            if (link.source !== source || link.target !== target) return;
        }
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
        // 1->0 fires LAST (A1 r2): the link is already back in the pool, so a throwing
        // onDisconnect cannot strand it half-freed (out of every list, never pooled).
        if (lifecycleCount !== 0 && source.headSub === null) fireDisconnect(source);
    }

    /**
     * Free any tail links not visited during the current re-tracking pass.
     * Called from executeEffect / pullComputed after the body returns: anything
     * still reachable from `activeObserverCurrentDep` is a stale dep from the
     * previous run and gets returned to the pool.
     * @private
     */
    function severTail(node) {
        // List-consistent walk (A1.3, F13): every stale link is unlinked from the dep list
        // BEFORE freeLink runs user code (op-4 hook, onDisconnect), and the walk pointer IS
        // the live cursor, so a callback that disposes a later stale dep's source moves the
        // walk via repairCursor instead of leaving it on a freed link. Order (head -> tail)
        // of op 4 and the 1->0 callbacks is unchanged.
        let stale = activeObserverCurrentDep;
        while (stale !== null) {
            const p = stale.prevDep, n = stale.nextDep;
            if (p !== null) p.nextDep = n; else node.headDep = n;
            if (n !== null) n.prevDep = p; else node.tailDep = p;
            activeObserverCurrentDep = n;
            freeLink(stale, node, stale.source);
            stale = activeObserverCurrentDep;
        }
    }

    /**
     * Frame-epilogue sever (A1 r2). The stale-tail walk runs user code (op-4 hook,
     * onDisconnect). If that throws, the frame must still unwind: clear COMPUTING,
     * restore observer/owner, pop the cursor, then rethrow. Without this a throwing
     * epilogue callback left cursorDepth > 0 forever (pinned slots never released)
     * and the context stranded. Links not yet severed stay in the dep list (still
     * consistent): at worst one extra run, then the next re-track severs them.
     * Cold: called only when a stale tail exists; the frame's caller checks for it.
     * @private
     */
    function severTailFrame(node, po, pw) {
        try {
            severTail(node);
        } catch (err) {
            node.flags &= ~FLAG_COMPUTING;
            currentObserver = po;
            currentOwner = pw;
            cursorDepth = (cursorDepth - 1) | 0;
            activeObserverCurrentDep = cursorStack[cursorDepth];
            throw err;
        }
    }

    /**
     * A1.2 cold helpers: keep every re-tracking cursor (the live one and the
     * frames' saved ones on cursorStack) pointing at a live link of its own list.
     * Identity compares only; no numeric arguments.
     * @private
     */
    function repairCursor(sLink, nDep) {
        if (activeObserverCurrentDep === sLink) { activeObserverCurrentDep = nDep; return; }
        // At most one match: one frame per owner, one owner per link.
        for (let i = (cursorDepth - 1) | 0; i >= 0; i--) {
            if (cursorStack[i] === sLink) { cursorStack[i] = nDep; return; }
        }
    }
    /**
     * Drop every cursor into a dying running node's dep list. The live-cursor test is the
     * functional part. The saved-slot loop is DEFENSE IN DEPTH (no probe can observe it):
     * a dead frame's saved cursor only ever returns to that dead frame, which can no
     * longer link (allocateLink's flags gate) or sever (the gen guard); and if its link is
     * recycled into another frame's list, any legitimate holder sits in a higher slot, so
     * repairCursor's top-down scan finds that one first. Nulling it keeps repairCursor's
     * "at most one match" invariant literally true. @private
     */
    function dropCursors(node) {
        const c = activeObserverCurrentDep;
        if (c !== null && c.target === node) activeObserverCurrentDep = null;
        for (let i = 0; i < cursorDepth; i++) {
            const k = cursorStack[i];
            if (k !== null && k.target === node) cursorStack[i] = null;
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
        const f = node.flags;

        // RACE WITH ACTIVE TRACKING: an effect/computed may call dispose on
        // itself from inside its own body (#141), or from any frame nested
        // inside its own (F15). Once we tear the node down its dep-list,
        // FLAG_COMPUTING, and cursors become stale immediately -- any read()
        // that runs in the REST of the body would otherwise try to hang a fresh
        // link off a freed slot. Drop every cursor (live or saved) into its
        // list, null the tracking state now so subsequent reads in this call
        // stack become no-ops, and let executeEffect / pullComputed skip their
        // finally-block bookkeeping via the gen-snapshot guard there. A cursor
        // into this node's list exists only while it has a frame, and it is
        // COMPUTING throughout that frame, so the flag gates the scan exactly.
        if ((f & FLAG_COMPUTING) !== 0) dropCursors(node);
        if (currentObserver === node) {
            currentObserver = null;
        }
        if (currentOwner === node) {
            currentOwner = null;
        }

        // O(1) detach from parent to avoid modifying list during parent iteration
        if (node.owner !== null) {
            if (node.prevOwned !== null) node.prevOwned.nextOwned = node.nextOwned;
            else node.owner.firstOwned = node.nextOwned;
            if (node.nextOwned !== null) node.nextOwned.prevOwned = node.prevOwned;
            node.owner = null;
            node.prevOwned = null;
            node.nextOwned = null;
        }

        // RE-ENTRANCY (A1.7, S8): runCleanup and the dLink walk run user code (cleanups,
        // op-4 hook, onDisconnect) that may dispose THIS node again. The inner call then
        // completes the disposal (gen bump, free-list push); the outer call must stop, or
        // it pushes the node onto the free list twice.
        const g = node.gen;
        runCleanup(node);
        if (node.gen !== g) return;

        // CROSS-EDGE L2->L1: extract this node's own edges from the graph.
        // Pop from the front (A1.4, F8): each link leaves the dep list BEFORE freeLink
        // runs user code, and the list is re-read after every callback, so a callback
        // that disposes a later dep's source never leaves this walk on a freed link.
        let dLink;
        while ((dLink = node.headDep) !== null) {
            const n = dLink.nextDep;
            node.headDep = n;
            if (n !== null) n.prevDep = null; else node.tailDep = null;
            freeLink(dLink, node, dLink.source);
        }
        if (node.gen !== g) return;

        let sLink = node.headSub;
        while (sLink !== null) {
            const target = sLink.target;
            const next = sLink.nextSub;

            const pDep = sLink.prevDep;
            const nDep = sLink.nextDep;
            if (pDep !== null) pDep.nextDep = nDep; else target.headDep = nDep;
            if (nDep !== null) nDep.prevDep = pDep; else target.tailDep = pDep;

            // CURSOR REPAIR (1.4.0; every frame since A1.2): `target` may be an observer
            // that is MID-RUN with its re-tracking cursor parked on this very link -- it
            // linked `source` on the previous run, has not reached that read yet on this
            // one, and `source` is disposed from its body or from any frame nested inside
            // it (F15: the cursor is then SAVED on cursorStack, not live). Splicing the
            // link out and handing it to the free list would leave that cursor dangling
            // at a freed slot: severTail would then read a nulled prevDep, wipe
            // target.headDep (orphaning every surviving dep), and double-free the link --
            // freeLink null-derefs on `source.headSub`. Advance the cursor to the next
            // surviving dep instead. Only a COMPUTING target has a frame, so only it can
            // hold a cursor. Disposal path only; no steady-state cost.
            if ((target.flags & FLAG_COMPUTING) !== 0) repairCursor(sLink, nDep);

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
        node.nextMark = null;   // 1.3.0: defensive -- disposal during a sweep shouldn't happen, but ensures clean state

        node.gen = (node.gen + 1) | 0;
        if ((f & FLAG_COMPUTING) !== 0) {
            node.nextFree = pinnedHead;   // A1.8: running -> pinned until depth 0
            pinnedHead = node;
        } else {
            node.nextFree = freeNodeHead;
            freeNodeHead = node;
        }
        activeNodes = (activeNodes - 1) | 0;
        // Live per-kind count: decrement here -- the single chokepoint every teardown
        // path funnels through (owner cascade at the firstOwned loop, the effect
        // disposer, and dispose(api)). Keyed off the flags captured at entry; the
        // flags === 0 guard and the A1.7 gen checks make it run once per disposal,
        // next to activeNodes, so signals + computeds + effects === activeNodes holds
        // under owner-cascade and re-entrant disposal, inside cleanups too.
        if ((f & FLAG_SIGNAL) !== 0) statSignals--;
        else if ((f & FLAG_COMPUTED) !== 0) statComputeds--;
        else if ((f & FLAG_EFFECT) !== 0) statEffects--;
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
        // Miss path out of line (A1 r2): keeps createNode under TurboFan's 460-byte
        // inlining limit so signal() / computed() / effect() inline it, as in 1.5.2.
        if (freeNodeHead === null) node = nodeMiss();
        else {
            node = freeNodeHead;
            freeNodeHead = node.nextFree;
            node.nextFree = null;
        }
        activeNodes = (activeNodes + 1) | 0;
        statTotalAllocations++;   // 1.4: every node acquired (pool pop or fresh build)

        // 1.2.3: Clean free-list invariant (Andrii's recommendation).
        //
        // Every node leaving the pool is guaranteed-clean for the seven fields
        // {headDep, tailDep, headSub, tailSub, revertEpoch, preBatchValue,
        // preBatchVersion}: dispose() clears them on the recycle path, and the
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
        // A dead owner (disposed, slot pinned: A1.8) adopts nothing; the node is unowned (DV-A1-4).
        if (currentOwner !== null && (flags & (FLAG_COMPUTED | FLAG_EFFECT)) !== 0 && currentOwner.flags !== 0) {
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
     * Free-list miss (cold). A1.8: at depth 0 pinned slots are reusable again, so take
     * one of those first; otherwise grow by a chunk (or throw under "throw").
     * @private
     */
    function nodeMiss() {
        let node;
        if (pinnedHead !== null && cursorDepth === 0 && releasePinned()) {
            node = freeNodeHead;
            freeNodeHead = node.nextFree;
            node.nextFree = null;
            return node;
        }
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
        return node;
    }

    /**
     * A1.8: splice every pinned slot into the free list. Callers guarantee
     * cursorDepth === 0 (no frame left that could hold a pinned node). Cold.
     * @private
     */
    function releasePinned() {
        let n = pinnedHead;
        pinnedHead = null;
        while (n !== null) {
            const nx = n.nextFree;
            n.nextFree = freeNodeHead;
            freeNodeHead = n;
            n = nx;
        }
        return freeNodeHead !== null;
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
        // A1 r2: a two-test dispatcher so it stays small enough to inline into
        // executeEffect / pullComputed (and through them into flushEffects); the
        // work lives in two cold helpers. Zero calls when there is nothing to do.
        if (node.firstOwned !== null) disposeOwned(node);
        if (node.cleanupFn !== undefined) runOwnCleanup(node);
    }
    /** Cascade-dispose the owned children (cold half of runCleanup). @private */
    function disposeOwned(node) {
        // Pop from the front (A1.10, S4): the owned list stays consistent at every user-code
        // point and is re-read after each disposal, so a cleanup that disposes a later sibling
        // (which unlinks itself from this list) cannot end the cascade early.
        const g = node.gen;
        let child;
        while ((child = node.firstOwned) !== null) {
            const next = child.nextOwned;
            node.firstOwned = next;
            if (next !== null) next.prevOwned = null;
            // Detach immediately to optimise disposeNode processing
            child.owner = null;
            child.prevOwned = null;
            child.nextOwned = null;
            disposeNode(child);
        }
        // F-b33-1: the body has read nothing yet and will read these writes -> not stale.
        if (node.gen === g) node.flags &= ~FLAG_STALE_READ;
    }
    /** Run this node's own cleanup(s) (cold half of runCleanup). @private */
    function runOwnCleanup(node) {
        const cleanup = node.cleanupFn;
        // Cleared BEFORE the call (A1.7): a cleanup that disposes its own node must not
        // run itself again from the re-entrant disposeNode.
        node.cleanupFn = undefined;
        // S10: #30 gen-safe restore -- a cleanup that disposes the saved observer/owner
        // (whose slot may already be recycled) must not re-seat it.
        const po = currentObserver, pg = po !== null ? po.gen : 0;
        const pw = currentOwner, pwg = pw !== null ? pw.gen : 0;
        const g = node.gen;
        currentObserver = null;
        currentOwner = null;
        try {
            if (typeof cleanup === "function") cleanup();
            else for (let i = 0; i < cleanup.length; i++) cleanup[i]();
        } finally {
            currentObserver = (po !== null && po.gen === pg) ? po : null;
            currentOwner = (pw !== null && pw.gen === pwg) ? pw : null;
        }
        // F-b33-1: the body has read nothing yet and will read these writes -> not stale.
        if (node.gen === g) node.flags &= ~FLAG_STALE_READ;
    }

    // === L3 * PROPAGATION / EXECUTION =============================
    // markDownstream is owner-free AND cursor-free (a pure propagation
    // primitive). executeEffect/pullComputed are the orchestrators: they drive
    // the cursor + severTail (L1) and, before a re-run, call runCleanup (L2) to
    // cascade-dispose owned children. Sanctioned upward call -> L2: runCleanup.

    // --- EXECUTION ENGINE -----------------------------------------

    // --- F-b33-1: WRITE DURING AN EVALUATION (cold) ---------------
    // markDownstream hands a write made while a body is mid-run (cursorDepth !== 0) to
    // this twin. Marking is identical to markDownstream's loop; in addition a target that
    // is mid-run (COMPUTING), is not the writer and is not already flagged gets
    // FLAG_STALE_READ: its run read a value this write changed. The writer is the
    // observer, else the owner (untrack nulls currentObserver; Watch.js runs callbacks as
    // untrack(cb) inside its effect), so self-writes stay absorbed. No evalVersion write
    // here: the S9 stamp in the run's `finally` would overwrite it.
    function markDownstreamInEval(startNode) {
        const gv = globalVersion;
        const writer = currentObserver !== null ? currentObserver : currentOwner;
        let markHead = startNode;
        startNode.nextMark = null;

        while (markHead !== null) {
            const n = markHead;
            markHead = n.nextMark;
            n.nextMark = null;

            let link = n.headSub;
            while (link !== null) {
                const t = link.target;
                if (t.markEpoch !== gv) {
                    t.markEpoch = gv;
                    const flags = t.flags;
                    if ((flags & (FLAG_COMPUTING | FLAG_STALE_READ)) === FLAG_COMPUTING && t !== writer) {
                        t.flags = flags | FLAG_STALE_READ;
                    }

                    if ((flags & FLAG_EFFECT) !== 0) {
                        if ((flags & (FLAG_QUEUED | FLAG_COMPUTING)) === 0) {
                            t.flags = flags | FLAG_QUEUED;
                            activeQueue[activeQueueLen++] = t;
                        }
                    } else {
                        t.nextMark = markHead;
                        markHead = t;
                    }
                }
                link = link.nextSub;
            }
        }
    }

    /**
     * F-b33-1: re-queue an effect whose run read a value a write in the same evaluation
     * changed. Called by effectTail only after the run start cleared QUEUED and
     * executeEffect's `finally` cleared COMPUTING, with no user code in between. evalVersion = 0
     * makes the next run skip the pre-walk. Inside a flush the nested flushEffects()
     * returns at once and the entry runs in the next pass of the same flush (counted
     * against maxFlushPasses -> "CycleError: flush passes exceeded"); outside a flush
     * (effect() creation, a scheduler thunk) it drains now. Inside a batch it waits for
     * the batch close.
     * @private
     */
    function requeueStaleEffect(node) {
        node.flags &= ~FLAG_STALE_READ;
        node.evalVersion = 0;
        if ((node.flags & FLAG_QUEUED) === 0) {
            node.flags |= FLAG_QUEUED;
            activeQueue[activeQueueLen++] = node;
        }
        if (batchDepth === 0) flushEffects();
    }

    // Nested stale re-pulls in flight (computedRunTail). Smi, capped at maxFlushPasses.
    let staleRepulls = 0;

    /**
     * F-b33-1: the post-run tail of a computed whose flags carry FLAG_HAS_ERROR or
     * FLAG_STALE_READ. Not stale -> rethrow the cached error (the old inline throw).
     * Stale -> clear the flag, set a far evalVersion floor (below any write made in
     * this run; never 0, so the equality cutoff is kept and neither the same-version
     * cache nor the clean short-circuit can re-absorb it), then re-pull in the same
     * read. The floor is set BEFORE the cap check, so a throw leaves the node dirty,
     * not cached. More than maxFlushPasses nested re-pulls -> Error
     * "CycleError: computed keeps invalidating its own reads".
     * @private
     */
    function computedRunTail(node) {
        if ((node.flags & FLAG_STALE_READ) === 0) throw node.value;
        node.flags &= ~FLAG_STALE_READ;
        const f = (globalVersion - 0x3FFFFFFF) | 0;
        node.evalVersion = f === 0 ? -1 : f;
        if (staleRepulls >= maxFlushPasses) throw new Error("CycleError: computed keeps invalidating its own reads");
        staleRepulls++;
        try { return pullComputed(node); } finally { staleRepulls--; }
    }

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
        if (cursorDepth !== 0) { markDownstreamInEval(startNode); return; }
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
     * F21 (LEDGER #35): an entry runs only while its node is still QUEUED.
     * A scheduled effect keeps QUEUED until its thunk runs (one scheduler call per pending
     * period); a stale entry whose slot holds a legitimately QUEUED resident serves it early (KNOWN,
     * HEAD-equal); a deferred-scheduler resident then gets a second call at its own entry (R1).
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
                const currentQueue = activeQueue;

                isQueueA = !isQueueA;
                activeQueue = isQueueA ? effectQueueA : effectQueueB;
                activeQueueLen = 0;

                for (let i = 0; i < toRun; i++) {
                    const node = currentQueue[i];
                    try {
                        // F21: run only while QUEUED; a stale entry (disposed, recycled into an
                        // un-queued resident, or period already served) -> skip
                        if ((node.flags & FLAG_QUEUED) !== 0) {
                            const scheduler = node.scheduler;
                            if (scheduler) {
                                scheduler(node.schedulerThunk);  // reuse cached thunk
                            } else {
                                executeEffect(node);
                            }
                        }
                    } catch (err) {
                        flushErrorBuffer[flushErrorCount++] = err;
                    }
                }
            }
            if (pinnedHead !== null && cursorDepth === 0) releasePinned();
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

    // A1 r2: the cycle throws live out of line. Their `new Error(...)` bytes counted
    // against executeEffect's TurboFan inlining budget (max 460 bytecode bytes) on
    // every run; the call that replaces them is smaller and never taken in practice.
    // A1.9: pull a computed dep from executeEffect's pre-walk; true if that ran user code
    // which freed or recycled the walk's link (both ends compared). Small, so it inlines;
    // out of line only for executeEffect's inlining budget. pullComputed keeps the check
    // inline: routing its own pre-walk through this helper measured slower (r2, mux).
    // F-b33-1: also true if node's markEpoch moved across the pull (a write reached this
    // effect while the walk ran user code). `e !== 0`: createNode's recycle reset must not
    // mask the link compare.
    function pullMoved(link, dep, node) {
        const m = node.markEpoch;
        pullComputed(dep);
        const e = node.markEpoch;
        return (e !== m && e !== 0) || link.source !== dep || link.target !== node;
    }
    // Op 5 (recompute), out of line for the frames' inlining budget (small: TurboFan inlines
    // it back, so the no-hook path is still one compare).
    function fireRecompute(node) { if (mutationHook !== null) mutationHook(5, node.id, 0); }
    // F-b33-1: executeEffect's post-run tail, out of line for its inlining budget (small: inlines back).
    // Truthiness test, not `!== 0` (D4): 25 B vs 31 keeps it under the small-function inline caps
    // (Maglev 27 B, TurboFan 30 B); flags is a Smi bit set, so the two forms are the same test.
    function effectTail(node) { if (node.flags & FLAG_STALE_READ) requeueStaleEffect(node); }
    function throwEffectCycle() { throw new Error("CycleError: Infinite effect loop detected."); }
    function throwComputedCycle() { throw new Error("CycleError: Circular dependency detected."); }

    /**
     * Run an effect's compute body, re-tracking dependencies.
     * Short-circuits if no dependency has bumped its version since last eval.
     * If the body self-disposes (node.gen advances during the body), skips the
     * post-body bookkeeping (severTail, flag clear, evalVersion bump) -- that
     * gen-snapshot guard is the v1.2 conformance fix for #141.
     * @private
     */
    function executeEffect(node) {
        if ((node.flags & FLAG_COMPUTING) !== 0) throwEffectCycle();
        // SELF-DISPOSE / ABA DETECTION: snapshot the gen ONCE, before any user code (the
        // pre-walk's pulls, runCleanup's cleanups, the body). disposeNode bumps gen, so if
        // it advanced the node was disposed -- and, if that happened at depth 0, possibly
        // recycled into a stranger (a pinned slot is released by the next depth-0 miss).
        const savedGen = node.gen;

        if (node.evalVersion !== 0) {
            let link = node.headDep;
            const evalVer = node.evalVersion | 0;
            let needsRun = false;

            while (link !== null) {
                const dep = link.source;
                // A1.9 (S3): the pull ran user code that freed (maybe recycled) this link;
                // its nextDep is gone, so stop walking and run the body (fail closed).
                if ((dep.flags & FLAG_COMPUTED) !== 0 && pullMoved(link, dep, node)) { needsRun = true; break; }
                if (((dep.version - evalVer) | 0) > 0) {
                    needsRun = true;
                    break;
                }
                link = link.nextDep;
            }
            if (node.gen !== savedGen) return;   // A1.9: disposed (maybe recycled) during the pre-walk

            if (!needsRun) {
                node.flags &= ~FLAG_QUEUED_STALE;
                node.evalVersion = globalVersion;
                return;
            }
        }

        node.flags = (node.flags & ~FLAG_QUEUED_STALE) | FLAG_COMPUTING;
        runCleanup(node);   // CROSS-EDGE L3->L2: dispose owned children before re-run
        if (node.gen !== savedGen) return;   // B1 (r3): a cleanup disposed it; never run a stranger

        const prevObserver = currentObserver;
        const prevOwner = currentOwner;

        // If gen advances during the body the node was disposed (and may already have been
        // recycled into a different role). Skip the dep-list / flag / version mutations in
        // that case -- they would either crash on the freed link list or corrupt the new
        // resident.
        currentObserver = node;
        currentOwner = node;
        // Cursor push (A1.1): nothing that can throw sits between it and `try`. The op-5 hook
        // runs INSIDE `try` (S5), so a throwing hook unwinds the context like a body throw.
        const d = cursorDepth;
        if (d !== 0) cursorStack[d] = activeObserverCurrentDep;
        cursorDepth = d + 1;   // Smi: depth is bounded by the JS stack, far below 2^30
        activeObserverCurrentDep = node.headDep;
        try {
            fireRecompute(node);
            node.computeFn();
        } finally {
            if (node.gen === savedGen) {
                // S9: stamp BEFORE severTail. Its 1->0 callbacks may write a dep this run
                // still reads; COMPUTING keeps markDownstream from queueing us, so a later
                // stamp would absorb that write and the next pre-walk would miss it.
                node.evalVersion = globalVersion;
                if (activeObserverCurrentDep !== null) severTailFrame(node, prevObserver, prevOwner);
                node.flags &= ~FLAG_COMPUTING;
            }
            currentObserver = prevObserver;
            currentOwner = prevOwner;
            cursorDepth = d;
            activeObserverCurrentDep = d !== 0 ? cursorStack[d] : null;
        }
        effectTail(node);
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

        const savedGen = node.gen;   // once, before any user code (see executeEffect)
        let shouldRun = node.evalVersion === 0;
        if (!shouldRun) {
            const markAtWalk = node.markEpoch;   // F-b33-1: a write during the walk moves it
            let link = node.headDep;
            const evalVer = node.evalVersion | 0;
            while (link !== null) {
                const dep = link.source;
                if ((dep.flags & FLAG_COMPUTED) !== 0) {
                    pullComputed(dep);
                    if (link.source !== dep || link.target !== node) { shouldRun = true; break; }   // A1.9: link freed
                }
                if (((dep.version - evalVer) | 0) > 0) {
                    shouldRun = true;
                    break;
                }
                link = link.nextDep;
            }
            if (node.gen !== savedGen) return undefined;   // A1.9: disposed during the pre-walk
            if (markAtWalk !== node.markEpoch) shouldRun = true;
        }

        if (shouldRun) {
            if ((node.flags & FLAG_COMPUTING) !== 0) throwComputedCycle();
            node.flags |= FLAG_COMPUTING;
            runCleanup(node);   // CROSS-EDGE L3->L2: dispose owned children before recompute
            if (node.gen !== savedGen) return undefined;   // B1 (r3): disposed by a cleanup

            const prevObserver = currentObserver;
            const prevOwner = currentOwner;

            // Same self-dispose detection, cursor push and in-`try` op-5 hook as executeEffect.
            // A throwing hook is cached as this computed's error (DV-S5).
            currentObserver = node;
            currentOwner = node;
            const d = cursorDepth;
            if (d !== 0) cursorStack[d] = activeObserverCurrentDep;
            cursorDepth = d + 1;   // Smi: depth is bounded by the JS stack, far below 2^30
            activeObserverCurrentDep = node.headDep;
            try {
                fireRecompute(node);
                const newValue = node.computeFn();
                // A1 r4: a body (or `equals`) that disposed `node` must not park its value on
                // the pinned, then pooled, slot (retention until reuse). Cold: never inlined.
                if (node.gen === savedGen) {
                    const eq = node.equals;
                    if ((node.evalVersion === 0 || !eq || !eq(node.value, newValue)) && node.gen === savedGen) {
                        node.value = newValue;
                        node.version = globalVersion;
                    }
                    node.flags &= ~FLAG_HAS_ERROR;
                }
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
                    node.evalVersion = globalVersion;   // S9: before severTail (see executeEffect)
                    if (activeObserverCurrentDep !== null) severTailFrame(node, prevObserver, prevOwner);
                    node.flags &= ~FLAG_COMPUTING;
                }
                currentObserver = prevObserver;
                currentOwner = prevOwner;
                cursorDepth = d;
                activeObserverCurrentDep = d !== 0 ? cursorStack[d] : null;
            }
            if (node.flags === 0) return undefined;   // disposed during body
            if ((node.flags & FLAG_ERR_OR_STALE) !== 0) return computedRunTail(node);
            return node.value;
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
            const po = currentObserver, pg = po !== null ? po.gen : 0;
            currentObserver = null;
            try {
                fn(val);
            } finally {
                currentObserver = (po !== null && po.gen === pg) ? po : null;
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
            if (currentObserver !== null) {
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
        // set stays a CLOSURE (byte-identical to 1.2.0 + the F29 `|| 1` 0-skip): its call path is the hot
        // path, and a closure over `node` beats a shared method's this[NODE_PTR]
        // load. Keeping it a closure also restores detached `const {set}=signal()`.
        read.set = (value) => {
            if (node.gen !== birthGen) return;
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
            /* c8 ignore next -- 2^32 wraparound: || 1 skips the 0 "unset" sentinel (F29); A4 replaces this line */
            node.version = globalVersion = ((globalVersion + 1) | 0) || 1;
            markDownstream(node);
            if (batchDepth === 0) flushEffects();
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
            if (currentObserver !== null) {
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
        if (currentObserver !== null) {
            const expected = activeObserverCurrentDep;
            if (expected !== null && expected.source === node) {
                activeObserverCurrentDep = expected.nextDep;
            } else {
                allocateLink(node, currentObserver);
            }
        }
        return node.value;
    }
    function boxSet(value) {
        const node = this[NODE_PTR];
        if (node.gen !== this[NODE_GEN]) return;
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
        /* c8 ignore next -- 2^32 wraparound: || 1 skips the 0 "unset" sentinel (F29); A4 replaces this line */
        globalVersion = ((globalVersion + 1) | 0) || 1;
        node.version = globalVersion;
        markDownstream(node);
        if (batchDepth === 0) flushEffects();
    }
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
            const po = currentObserver, pg = po !== null ? po.gen : 0;
            currentObserver = null;
            try { fn(val); } finally { currentObserver = (po !== null && po.gen === pg) ? po : null; }
        });
    }
    function boxComputedGet() {
        const node = this[NODE_PTR];
        if (node.gen !== this[NODE_GEN]) return undefined;
        if (currentObserver !== null) {
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
     * A run that reads a value a later write in the same evaluation changes runs
     * again (F-b33-1); a body that never settles throws an Error prefixed
     * `"CycleError:"` -- from this call itself when the loop forms on the first run.
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
        if (batchDepth === 0) {
            batchEpoch = (batchEpoch + 1) | 0;
            // 2^32 wraparound sentinel: batchEpoch is bumped ONLY here (and reset to 1 by
            // destroy()), so reaching 0 costs 4,294,967,295 top-level batch() calls. Kept
            // because revertEpoch comparisons treat 0 as "no capture".
            /* c8 ignore next -- 2^32 wraparound; unreachable without ~4.3e9 batches */
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
        return currentObserver !== null;
    }

    function untrack(fn) {
        const po = currentObserver, pg = po !== null ? po.gen : 0;
        currentObserver = null;
        try {
            return fn();
        } finally {
            currentObserver = (po !== null && po.gen === pg) ? po : null;
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
    function getOwner() {
        return currentOwner !== null ? describeNode(currentOwner) : undefined;
    }
    function runWithOwner(ownerHandle, fn) {
        const node = liveNode(ownerHandle);
        const pw = currentOwner, pwg = pw !== null ? pw.gen : 0;
        const po = currentObserver, pg = po !== null ? po.gen : 0;
        currentOwner = (node !== undefined && (node.flags & (FLAG_COMPUTED | FLAG_EFFECT)) !== 0) ? node : null;
        currentObserver = null;
        try {
            return fn();
        } finally {
            // S10: gen-safe restore (the #30 idiom) -- fn may dispose the saved owner/observer.
            currentOwner = (pw !== null && pw.gen === pwg) ? pw : null;
            currentObserver = (po !== null && po.gen === pg) ? po : null;
        }
    }
    function createRoot(fn) {
        const pw = currentOwner, pwg = pw !== null ? pw.gen : 0;
        const po = currentObserver, pg = po !== null ? po.gen : 0;
        currentOwner = null;
        currentObserver = null;
        try {
            return fn();
        } finally {
            // S10: gen-safe restore (the #30 idiom) -- fn may dispose the saved owner/observer.
            currentOwner = (pw !== null && pw.gen === pwg) ? pw : null;
            currentObserver = (po !== null && po.gen === pg) ? po : null;
        }
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
            // 1.4.5 backport: TRUE pool population (nodePool.length / linkPool.length),
            // distinct from the *Capacity ledgers above. Under prealloc:"lazy" (or a
            // silently-flipped `prealloc` typo) population stays 0 while capacity reads
            // the ledger -- so a mis-set prealloc is now observable, not telemetry-blind.
            nodePoolPopulation: nodePool.length,
            linkPoolPopulation: linkPool.length,
            activeNodes,
            // 1.4: cumulative lifecycle counters (monotonic; reset by destroy()).
            // Derive: allocationRate = deltatotalAllocations/deltat; poolReuseRate =
            // 1 - poolGrowths*initialCap/totalAllocations; avgLifetime ~ totalDisposals/rate.
            totalAllocations: statTotalAllocations,
            totalDisposals: statTotalDisposals,
            poolGrowths: statPoolGrowths
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
            n.revertEpoch = 0;
            n.preBatchValue = undefined;
            n.preBatchVersion = 0;

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

        pinnedHead = null;   // A1.8: every slot, pinned ones included, is on the rebuilt free list
        activeNodes = 0;
        activeLinks = 0;
        activeQueueLen = 0;
        isFlushing = false;
        batchDepth = 0;
        currentObserver = null;
        currentOwner = null;
        activeObserverCurrentDep = null;
        globalVersion = 1;
        batchEpoch = 1;
        statSignals = 0;
        statComputeds = 0;
        statEffects = 0;
        statTotalAllocations = 0;
        statTotalDisposals = 0;
        statPoolGrowths = 0;

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

    return {getOwner, runWithOwner, signal, computed, effect, signalBox, computedBox, dispose, batch, untrack, createRoot, onCleanup, stats, destroy, isTracking, hasObservers, observeObservers, forEachObserver, forEachSource, forEachOwned, ownerOf, nodeId, describe, onGraphMutation};
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

export function untrack(fn) {
    return defaultRegistry.untrack(fn);
}
export function createRoot(fn) {
    return defaultRegistry.createRoot(fn);
}

/**
 * Return the currently-active owner as an opaque, gen-stamped handle
 * (undefined if outside any effect/computed body). Pass to
 * {@link runWithOwner} to re-enter the captured lifecycle scope. The handle
 * is safe to hold across async boundaries: it goes STALE when the captured
 * owner is disposed and the pool slot is recycled, and stale handles
 * degrade to rooted execution rather than adopting into a stranger.
 */
export function getOwner() {
    return defaultRegistry.getOwner();
}

/**
 * Run `fn` with `ownerHandle` as the lifecycle owner: effects/computeds
 * created directly in `fn` are adopted by that owner. A null/undefined/stale
 * handle degrades to rooted execution (created children survive; the caller
 * disposes them). Nulls the tracking observer for the duration of `fn`.
 * See {@link Registry.runWithOwner}.
 */
export function runWithOwner(ownerHandle, fn) {
    return defaultRegistry.runWithOwner(ownerHandle, fn);
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