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
 *   every mid-run (COMPUTING) reader that is reachable from the written signal
 *   along some path through no mid-run computed (order-independent) and is not
 *   the writer (writer = currentObserver, else currentOwner: an untrack-wrapped
 *   or watch-callback self-write stays absorbed). KNOWN (D-M2):
 *   an onConnect write, or one from an onDisconnect fired by severTail, runs with
 *   currentOwner = the reading node (fireConnect / Disconnect null only the
 *   observer), so it is absorbed as that reader's self-write: not flagged, that
 *   run keeps the value it read. A write made before a body's first read -- by
 *   its own cleanups or its owned children's (runCleanup) -- is seen, not stale:
 *   disposeOwned / runOwnCleanup clear the node's own flag (gen-guarded). After
 *   its run a stale effect is re-queued with evalVersion 0 (requeueStaleEffect)
 *   and runs again in the same flush; a stale computed is re-pulled in the same
 *   read (computedRunTail).
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
// 1.6.0: box-form witness for snapshot(). OR'd into the node's flags at
// signalBox/computedBox creation (folds into the existing flags write -- zero
// new allocation, off the 56 B/op box path; the hook's op 1 / op 2 flags carry it: signalBox 160, computedBox 129). snapshotKind reads it directly.
// Never inspected by any hot body; createNode overwrites flags wholesale on
// recycle so it never lingers on a reused slot.
const FLAG_BOX = 1 << 7;   // bits 0-6 are taken (1 << 6 = FLAG_STALE_READ)
// The box constructors' createNode flags, folded at module scope: one const load at the
// call site, no OR. createNode stores flags wholesale, so the box bit rides the existing write.
const FLAG_SIGNAL_BOX = FLAG_SIGNAL | FLAG_BOX;
const FLAG_COMPUTED_BOX = FLAG_COMPUTED | FLAG_BOX;

// Private cross-registry rehydration hook (1.6.0 snapshot/restore). restore()
// builds a FRESH registry via createRegistry() and populates its internals via
// this module-scope WeakMap keyed by the fresh registry's public API object --
// the only sanctioned way one registry closure reaches another's private pools.
// Kept OFF the public object (not even a non-enumerable symbol, which
// Object.getOwnPropertySymbols would still surface): a live registry exposes no
// handle to its own rehydrate. Cold path only; never touched by any hot body.
const REHYDRATE = new WeakMap();

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
        /** FIX-R (A3, F5): evalCount at the capture; the revert is blocked iff it moved. Smi. */
        this.preBatchEvals = 0;

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
 * @param {string[]} [keys=ALLOWED_KEYS] the known option names to match against
 * @returns {string|null}
 */
function suggestKey(key, keys = ALLOWED_KEYS) {
    const lk = key.toLowerCase();
    let best = null;
    let bestD = 3;
    for (let i = 0; i < keys.length; i++) {
        const d = editDistance(lk, keys[i].toLowerCase());
        if (d < bestD) { bestD = d; best = keys[i]; }
    }
    return bestD <= 2 ? best : null;
}

/** The only option keys restore() recognizes (A9 round 2, E2). Anything else is
 *  rejected with the same did-you-mean hint as createRegistry's config law. */
const RESTORE_KEYS = ["fnsById", "handles", "config"];
const RESTORE_HAS_OWN = Object.prototype.hasOwnProperty;
const RESTORE_K_SIGNAL = 1;
const RESTORE_K_SIGNAL_BOX = 2;
const RESTORE_K_COMPUTED = 3;
const RESTORE_K_COMPUTED_BOX = 4;
const RESTORE_K_EFFECT = 5;

/** A restorable node id (also every dep id and ownerId): an int in
 *  [1, 0x3FFFFFFF] (2^30 - 1). Snapshot ids start at 1, so 0, negatives,
 *  floats, NaN, non-numbers and anything past the cap fail closed. The cap
 *  (A9 round 3, maintainer ruling D-F) keeps every restored id a Smi on
 *  pointer-compressed V8 (31-bit Smi: a closure counter >= 2^30 boxes on every
 *  write). It does not bound the post-restore node-id counter: restore copies
 *  the snapshot's nextId (D-O, any int32 -- live's counter wraps by
 *  `(nodeSeq + 1) | 0`), so the rebuild continues exactly where live was. */
function restoreIdOk(x) {
    return typeof x === "number" && (x | 0) === x && x > 0 && x <= 0x3FFFFFFF;
}

/** Render a rejected snapshot field for a message without ever throwing
 *  (String() of a null-prototype object throws). Cold. */
function restoreShow(x) {
    return (x !== null && (typeof x === "object" || typeof x === "function")) ? "(" + typeof x + ")" : String(x);
}

/**
 * D-J (1.6.0): verify recorded positions form, per group, a permutation of
 * 0..n-1, where n is the group's member count. Entry e (0 <= e < count) puts
 * record rec[e] at position pos[e] in group group[e] (a record index). Shared
 * by subPos (group = the dep's source; n = its subscriber count) and ownerPos
 * (D-J6: group = the owner; n = its owned-child count). n entries,
 * every one in range and none twice = a permutation, so a gap reports as out
 * of range. Positions arrive validated as ints >= 0. Returns the prefix sums
 * base (length groupCount + 1): group g's members occupy [base[g], base[g + 1]).
 * Read-only, throws TypeError. Cold: one call per restore.
 * @private
 */
function restorePermCheck(group, pos, rec, count, groupCount, ids, label, noun, plural) {
    const base = new Int32Array(groupCount + 1);
    for (let e = 0; e < count; e++) base[group[e] + 1]++;
    for (let g = 0; g < groupCount; g++) base[g + 1] += base[g];
    const filled = new Uint8Array(count);
    for (let e = 0; e < count; e++) {
        const g = group[e], p = pos[e], n = base[g + 1] - base[g];
        if (p >= n) {
            throw new TypeError("[lite-signal] restore: " + label + " " + p + " out of range at index " + rec[e] +
                " (" + noun + " id " + ids[g] + " has " + n + " " + plural + ")");
        }
        const k = base[g] + p;
        if (filled[k] !== 0) {
            throw new TypeError("[lite-signal] restore: duplicate " + label + " " + p + " at index " + rec[e] + " (" + noun + " id " + ids[g] + ")");
        }
        filled[k] = 1;
    }
    return base;
}

/**
 * A9 round 2 (+ round 3): the ONE read-only pre-scan restore() runs over
 * snap.nodes before the first write (no createNode, no handle, no registry
 * state). Throws on: a null / non-object record; an id, dep id or ownerId that
 * is not an int in [1, 0x3FFFFFFF] (round 3 cap, D-F); a duplicate id; a
 * non-int32 version; non-int32 flags (round 3; undefined / NaN / "x" no longer
 * coerce to 0); an unknown kind; deps not an array; a missing or inherited
 * compute body (own properties of fnsById only); a signal with deps; a signal
 * with an owner (round 3: a signal is never owned); an effect used as a dep
 * source; a dangling dep on ANY record (dirty computeds included, E9); a missing,
 * self, signal-kind or cyclic owner (a dep cycle among clean computeds is NOT
 * refused, D-N: live emits one); D-J: a subPos that is missing, not an array, not
 * deps.length long, or holds a non-int / negative element (TypeError, checked
 * after the record's dep ids), then, per source, subPos values that are not a
 * permutation of 0..n-1 (TypeError: out of range / duplicate; after the dep
 * resolve, before the owner scans); D-J6: an ownerPos that is missing or not an
 * int >= -1 (TypeError, checked after the record's ownerId), then, after the
 * owner scans (so a missing / self / signal / cyclic owner keeps its own
 * error), an ownerPos that is not -1 on an unowned record or is -1 on an owned
 * one, and per owner, ownerPos values that are not a permutation of 0..n-1
 * (TypeError: out of range / duplicate). D-M (round 6): an evalVersion or
 * markEpoch that is missing or not an int32 (TypeError, after the flags); a
 * signal whose stamps are not both 0, an effect with evalVersion 0, a computed
 * whose evalVersion is 0 while its version is not (or the reverse), and a clean
 * bit other than `evalVersion !== 0 && ((markEpoch - evalVersion) | 0) <= 0`
 * (snapshot()'s own formula; TypeError). Negative stamps and stamps on either
 * side of gv are accepted (live reaches both). Every field the rebuild uses is copied
 * here, read once, so a getter cannot change it between check and use.
 * Cold: one call per restore, never on a hot path.
 * @private
 */
function restorePrescan(nodes, fnsById) {
    const count = nodes.length;
    const ids = new Int32Array(count);
    const kinds = new Uint8Array(count);
    const vers = new Int32Array(count);
    const evs = new Int32Array(count);         // D-M: recorded evalVersion
    const mes = new Int32Array(count);         // D-M: recorded markEpoch
    const clean = new Uint8Array(count);       // 1 = clean computed (wired, cache trusted)
    const hasErr = new Uint8Array(count);
    const seed = new Uint8Array(count);        // 1 = dirty, evaluated computed: seed value + version + stamps + error bit (D-I2, D-L)
    const ownerIds = new Int32Array(count);    // 0 = no owner
    const ownerIdx = new Int32Array(count);    // -1 = no owner
    const values = new Array(count);
    const fns = new Array(count);
    const depIds = new Array(count);
    const depIdx = new Array(count);
    const subPos = new Array(count);           // D-J: Int32Array per record, parallel to depIds
    let subE = 0;                              // total dep links = total subscriber slots
    const ownPos = new Int32Array(count);      // D-J6: position in the owner's child list; -1 = no owner
    let ownedN = 0;                            // owned records = total owned-child slots
    const byId = new Map();                    // validated int id -> record index

    // Scan A: per-record shape and int law.
    for (let i = 0; i < count; i++) {
        const rec = nodes[i];
        if (rec === null || typeof rec !== "object") {
            throw new TypeError("[lite-signal] restore: invalid record at index " + i);
        }
        const id = rec.id;
        if (!restoreIdOk(id)) {
            throw new TypeError("[lite-signal] restore: invalid id " + restoreShow(id) + " at index " + i);
        }
        if (byId.has(id)) throw new Error("[lite-signal] restore: duplicate id " + id);
        byId.set(id, i);
        ids[i] = id;
        const k = rec.kind;
        let kc = 0;
        if (k === "signal") kc = RESTORE_K_SIGNAL;
        else if (k === "signalBox") kc = RESTORE_K_SIGNAL_BOX;
        else if (k === "computed") kc = RESTORE_K_COMPUTED;
        else if (k === "computedBox") kc = RESTORE_K_COMPUTED_BOX;
        else if (k === "effect") kc = RESTORE_K_EFFECT;
        else throw new TypeError("[lite-signal] restore: unknown kind " + restoreShow(k) + " for id " + id);
        kinds[i] = kc;
        const v = rec.version;
        if (typeof v !== "number" || (v | 0) !== v) {
            throw new TypeError("[lite-signal] restore: invalid version " + restoreShow(v) + " at index " + i);
        }
        vers[i] = v;
        const fl = rec.flags; if (typeof fl !== "number" || (fl | 0) !== fl) throw new TypeError("[lite-signal] restore: invalid flags " + restoreShow(fl) + " at index " + i);
        // D-M (round 6): the recorded freshness stamps, each read ONCE. Any int32: a far floor is
        // negative and a stamp may sit modularly on either side of gv, both live-reachable. The
        // relations are the ones live keeps: a signal is never evaluated or marked; an effect
        // snapshot() accepts has finished a run; a computed is evaluated (evalVersion != 0) iff
        // its version moved off 0; the clean bit is exactly snapshot()'s formula.
        const ev = rec.evalVersion;
        if (typeof ev !== "number" || (ev | 0) !== ev) throw new TypeError("[lite-signal] restore: invalid evalVersion " + restoreShow(ev) + " at index " + i);
        const me = rec.markEpoch;
        if (typeof me !== "number" || (me | 0) !== me) throw new TypeError("[lite-signal] restore: invalid markEpoch " + restoreShow(me) + " at index " + i);
        if (kc <= RESTORE_K_SIGNAL_BOX) {
            if (ev !== 0) throw new TypeError("[lite-signal] restore: invalid evalVersion " + ev + " at index " + i + " (a signal is never evaluated: expected 0)");
            if (me !== 0) throw new TypeError("[lite-signal] restore: invalid markEpoch " + me + " at index " + i + " (a signal is never marked: expected 0)");
        } else if (kc === RESTORE_K_EFFECT) {
            if (ev === 0) throw new TypeError("[lite-signal] restore: invalid evalVersion 0 at index " + i + " (an effect has finished a run)");
        } else if ((ev === 0) !== (v === 0)) {
            throw new TypeError("[lite-signal] restore: invalid evalVersion " + ev + " at index " + i + " (version " + v + ": a computed is evaluated iff its version is not 0)");
        }
        const cl = rec.clean;
        if (cl !== (ev !== 0 && ((me - ev) | 0) <= 0)) {
            throw new TypeError("[lite-signal] restore: invalid clean " + restoreShow(cl) + " at index " + i + " (evalVersion " + ev + ", markEpoch " + me + ")");
        }
        evs[i] = ev; mes[i] = me;
        const d = rec.deps;
        if (!Array.isArray(d)) throw new TypeError("[lite-signal] restore: invalid deps at index " + i);
        const dl = d.length;
        if (dl !== 0 && kc <= RESTORE_K_SIGNAL_BOX) {
            throw new Error("[lite-signal] restore: " + k + " id " + id + " has deps (a signal has no sources)");
        }
        const dc = new Int32Array(dl);
        for (let j = 0; j < dl; j++) {
            const x = d[j];
            if (!restoreIdOk(x)) {
                throw new TypeError("[lite-signal] restore: invalid dep id " + restoreShow(x) + " at index " + i);
            }
            dc[j] = x;
        }
        depIds[i] = dc;
        // D-J: subPos[j] = dep link j's position in its source's subscriber list. Required on
        // every record ([] for a signal); length and each element read ONCE into the copy the
        // rebuild uses; checked after the dep ids so a bad dep id keeps its own error.
        const sp = rec.subPos;
        if (!Array.isArray(sp) || sp.length !== dl) throw new TypeError("[lite-signal] restore: invalid subPos at index " + i);
        const pc = new Int32Array(dl);
        for (let j = 0; j < dl; j++) {
            const x = sp[j];
            if (typeof x !== "number" || (x | 0) !== x || x < 0) {
                throw new TypeError("[lite-signal] restore: invalid subPos " + restoreShow(x) + " at index " + i);
            }
            pc[j] = x;
        }
        subPos[i] = pc;
        subE += dl;
        const o = rec.ownerId;
        if (o === null || o === undefined) {
            ownerIds[i] = 0;
        } else if (!restoreIdOk(o)) {
            throw new TypeError("[lite-signal] restore: invalid ownerId " + restoreShow(o) + " at index " + i);
        } else {
            ownerIds[i] = o;
            if (kc <= RESTORE_K_SIGNAL_BOX) throw new Error("[lite-signal] restore: " + k + " id " + id + " has an owner (a signal is never owned)");
            ownedN++;
        }
        // D-J6: ownerPos = this record's position in its owner's child list, -1 = no owner (the
        // ownerIdx encoding). Required on every record, read ONCE, after the ownerId checks; -1
        // iff unowned and the per-owner permutation are checked after the owner scans (Scan C2).
        const op = rec.ownerPos;
        if (typeof op !== "number" || (op | 0) !== op || op < -1) {
            throw new TypeError("[lite-signal] restore: invalid ownerPos " + restoreShow(op) + " at index " + i);
        }
        ownPos[i] = op;
        if (kc >= RESTORE_K_COMPUTED) {
            // Own properties only: an inherited "toString" (or any prototype key) is never a body.
            const fn = (fnsById !== undefined && RESTORE_HAS_OWN.call(fnsById, id)) ? fnsById[id] : undefined;
            if (typeof fn !== "function") {
                throw new Error("[lite-signal] restore: missing fn for id " + id + " (" + k + ")");
            }
            fns[i] = fn;
            if (kc !== RESTORE_K_EFFECT && cl) {
                clean[i] = 1;
                if ((fl & FLAG_HAS_ERROR) !== 0) hasErr[i] = 1;
            } else if (kc !== RESTORE_K_EFFECT && v !== 0) {
                seed[i] = 1;   // D-I2 / D-L: dirty, evaluated (version 0 = never): seed value + version + stamps + error bit
                if ((fl & FLAG_HAS_ERROR) !== 0) hasErr[i] = 1;
            }
        }
        values[i] = rec.value;
    }

    // Scan B: every dep and owner resolves; structural kinds. D-J: flatten (source, position, record) per link.
    const sGroup = new Int32Array(subE), sPos = new Int32Array(subE), sRec = new Int32Array(subE);
    let se = 0;
    for (let i = 0; i < count; i++) {
        const dc = depIds[i];
        const dl = dc.length;
        const di = new Int32Array(dl);
        for (let j = 0; j < dl; j++) {
            const s = byId.get(dc[j]);
            if (s === undefined) {
                throw new Error("[lite-signal] restore: dep id " + dc[j] + " missing for id " + ids[i]);
            }
            if (kinds[s] === RESTORE_K_EFFECT) {
                throw new Error("[lite-signal] restore: dep id " + dc[j] + " of id " + ids[i] + " is an effect (an effect is never a source)");
            }
            di[j] = s;
            sGroup[se] = s; sPos[se] = subPos[i][j]; sRec[se] = i; se++;
        }
        depIdx[i] = di;
        const oid = ownerIds[i];
        if (oid === 0) { ownerIdx[i] = -1; continue; }
        const oi = byId.get(oid);
        if (oi === undefined) {
            throw new Error("[lite-signal] restore: owner id " + oid + " missing for id " + ids[i]);
        }
        if (oi === i) throw new Error("[lite-signal] restore: id " + ids[i] + " owns itself");
        if (kinds[oi] <= RESTORE_K_SIGNAL_BOX) {
            throw new Error("[lite-signal] restore: owner id " + oid + " of id " + ids[i] + " is a signal (only a computed or an effect owns)");
        }
        ownerIdx[i] = oi;
    }

    // Scan B2 (D-J): per source, the recorded subscriber positions are a permutation 0..n-1.
    const subBase = restorePermCheck(sGroup, sPos, sRec, subE, count, ids, "subPos", "source", "subscribers");

    // Scan C: owner chains are acyclic. 1 = on the current walk, 2 = proven to reach a root. O(N), bounded by count.
    const mark = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        if (mark[i] !== 0) continue;
        let j = i, steps = 0;
        while (j !== -1 && mark[j] === 0) {
            mark[j] = 1;
            j = ownerIdx[j];
            if (++steps > count) throw new Error("[lite-signal] restore: owner chain from id " + ids[i] + " exceeds the snapshot");
        }
        if (j !== -1 && mark[j] === 1) throw new Error("[lite-signal] restore: owner cycle through id " + ids[j]);
        j = i;
        while (j !== -1 && mark[j] === 1) { mark[j] = 2; j = ownerIdx[j]; }
    }

    // Scan C2 (D-J6): ownerPos is -1 iff the record has no owner; per owner, the recorded
    // positions are a permutation 0..n-1. ownOrder lists each owner's children in list order.
    const oGroup = new Int32Array(ownedN), oPos = new Int32Array(ownedN), oRec = new Int32Array(ownedN);
    let oe = 0;
    for (let i = 0; i < count; i++) {
        const oi = ownerIdx[i], p = ownPos[i];
        if (oi === -1) {
            if (p !== -1) throw new TypeError("[lite-signal] restore: invalid ownerPos " + p + " at index " + i + " (no owner: expected -1)");
            continue;
        }
        if (p === -1) throw new TypeError("[lite-signal] restore: invalid ownerPos -1 at index " + i + " (owned by id " + ids[oi] + ")");
        oGroup[oe] = oi; oPos[oe] = p; oRec[oe] = i; oe++;
    }
    const ownBase = restorePermCheck(oGroup, oPos, oRec, ownedN, count, ids, "ownerPos", "owner", "owned children");
    const ownOrder = new Int32Array(ownedN);
    for (let e = 0; e < ownedN; e++) ownOrder[ownBase[oGroup[e]] + oPos[e]] = oRec[e];

    return { count, ids, kinds, vers, evs, mes, clean, hasErr, seed, ownerIdx, values, fns, depIdx, subPos, subBase, subE, ownBase, ownOrder };
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
    // FIX-R (A3, F5): body-run counter, bumped once per computed / effect body run (fireRecompute).
    // Masked to 30 bits so the context slot stays a Smi (zero-box); compared for equality only.
    // KNOWN ABA: exactly k*2^30 body runs between a capture and its revert -> the pre-fix revert.
    let evalCount = 0;
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
    // A5a (F7 / DIV-D3): lifecycleMap maps node -> entry {head, tail}, a FIFO list of independent
    // registrations reg {onConnect, onDisconnect, phase, live, prev, next}. A fire walks the list and
    // drives each live reg's phase (0 = disconnected, 1 = connected) to the node's state, calling the
    // matching callback on each 0->1 / 1->0 step. A reg added during a fire was born in the target
    // phase, so that fire skips it; an off() clears `live` at once (EventTarget semantics). Every
    // callback runs in its own try/catch: one error is rethrown as-is, >= 2 become an AggregateError
    // in registration order (only the error path allocates).
    // LEDGER #45: returns true when the hook disposed either endpoint (gen moved), i.e. the new
    // edge is gone; allocateLink then skips op 3. Only a boolean crosses the call (cold path).
    function fireConnect(source, target) {
        const e = lifecycleMap.get(source);
        if (e === undefined) return false;
        // A1.6: #30 gen-safe restore -- a callback that disposes the observer does not re-seat it.
        const po = currentObserver, pg = po !== null ? po.gen : 0;
        const sg = source.gen, tg = target.gen;
        currentObserver = null;
        let threw = false, err0 = undefined, errs = null;
        // A dispose of `source` inside a callback ends the walk (disposeNode dropped its entry).
        for (let r = e.head; r !== null && source.gen === sg; r = r.next) {
            if (!r.live || r.phase !== 0 || source.headSub === null) continue;
            r.phase = 1;
            const f = r.onConnect;
            if (f === undefined) continue;
            try { f(); } catch (err) {
                if (!threw) { err0 = err; threw = true; }
                else if (errs === null) errs = [err0, err];
                else errs.push(err);
            }
        }
        currentObserver = (po !== null && po.gen === pg) ? po : null;
        if (threw) {
            // LEDGER #46: a throwing onConnect leaves the edge live; announce it ONCE before the error
            // propagates, unless a hook removed an endpoint (#45). A throwing op-3 listener here
            // replaces the error.
            if (mutationHook !== null && source.gen === sg && target.gen === tg) mutationHook(3, source.id, target.id);
            if (errs === null) throw err0;
            throw new AggregateError(errs, "observeObservers: onConnect callbacks threw");
        }
        return source.gen !== sg || target.gen !== tg;
    }
    function fireDisconnect(node) {
        const e = lifecycleMap.get(node);
        if (e === undefined) return;
        const po = currentObserver, pg = po !== null ? po.gen : 0;
        const g = node.gen;
        currentObserver = null;
        let threw = false, err0 = undefined, errs = null;
        for (let r = e.head; r !== null && node.gen === g; r = r.next) {
            if (!r.live || r.phase !== 1 || node.headSub !== null) continue;
            r.phase = 0;
            const f = r.onDisconnect;
            if (f === undefined) continue;
            try { f(); } catch (err) {
                if (!threw) { err0 = err; threw = true; }
                else if (errs === null) errs = [err0, err];
                else errs.push(err);
            }
        }
        // Restored on every path (each callback is caught above), as the 1.5 try/finally did.
        currentObserver = (po !== null && po.gen === pg) ? po : null;
        if (threw) {
            if (errs === null) throw err0;
            throw new AggregateError(errs, "observeObservers: onDisconnect callbacks threw");
        }
    }
    // LEDGER #40: the node object is pooled, so its lifecycleMap entry would outlive the handle
    // and hand its hooks to the slot's next resident. Cold: disposeNode / destroy call it only
    // while some registration is live (lifecycleCount !== 0).
    function dropLifecycleHooks(node) {
        const e = lifecycleMap.get(node);
        if (e === undefined) return;
        // A5a (F-a): kill every reg, so an off handle the user keeps (never called) does not
        // retain its callbacks -- or, through reg.next, a later reg's -- once the node is gone.
        // next / prev stay: a fire walking this list stops on its gen check (the caller bumps
        // node.gen right after this call), and the dead shells they reach hold no callbacks.
        for (let r = e.head; r !== null; r = r.next) {
            r.onConnect = undefined;
            r.onDisconnect = undefined;
            r.live = false;
        }
        lifecycleMap.delete(node);
        lifecycleCount = (lifecycleCount - 1) | 0;
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
    // Live-entry stack, any-order off; the newest live entry is active and `mutationHook`
    // mirrors its wrapper (null = none, or a `null` "clear" entry on top). Every fire point
    // is `if (mutationHook !== null)` -- branch-predicted free when absent, allocation-free
    // when present (opcode + two int args). Enables push-based devtools (watchGraph) and the
    // recompute profiler. Opcodes: 1 node-create, 2 node-dispose, 3 link-add,
    // 4 link-remove, 5 recompute.
    let mutationHook = null;
    // D-B2 (1.6.0): listeners currently running. Only the wrapper below touches it, so it
    // exists only while a listener is registered; snapshot() refuses while it is > 0. Smi
    // (bounded by the JS stack). Fire points are unchanged: they call the wrapper.
    let hookDepth = 0;
    // A5b / DIV-F9 (1.6.0): registration stack, newest on top. Entry = {w, below, above, live};
    // off() unlinks its own entry in any order (a dead entry never comes back) and, when it
    // was the top, re-points mutationHook at the next live entry below. Cold path only.
    let hookTop = null;
    function onGraphMutation(fn) {
        if (fn !== null && typeof fn !== "function") throw new TypeError("onGraphMutation: listener must be a function or null");
        const w = fn === null ? null : (op, a, b) => {
            hookDepth++;
            try { fn(op, a, b); } finally { hookDepth--; }
        };
        return hookPush(w);
    }
    // Separate function so the off closure's context holds only its entry, never the
    // listener: a held off retains nothing once it has run (w / below / above nulled).
    function hookPush(w) {
        const e = {w: w, below: hookTop, above: null, live: true};
        if (hookTop !== null) hookTop.above = e;
        hookTop = e;
        mutationHook = w;
        return () => {
            if (!e.live) return;
            e.live = false;
            const below = e.below, above = e.above;
            if (below !== null) below.above = above;
            if (above !== null) above.below = below;
            else { hookTop = below; mutationHook = below === null ? null : below.w; }
            e.w = null; e.below = null; e.above = null;
        };
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
        // disposes `source` (or `target`) unlinks a whole edge. Op order stays connect, op 3;
        // op 3 fires only for an edge that survived the hook (#45: a hook-removed edge emits none).
        if (_was0 && fireConnect(source, target)) return;
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
        node.preBatchEvals = 0;   // FIX-R (A3, F5)
        node.nextMark = null;   // 1.3.0: defensive -- disposal during a sweep shouldn't happen, but ensures clean state

        // LEDGER #40: drop observeObservers hooks before the slot is pooled (else the next resident
        // inherits them); before the gen bump, so hooks user code registered during teardown go too.
        if (lifecycleCount !== 0) dropLifecycleHooks(node);
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
        // Every node leaving the pool is guaranteed-clean for the eight fields
        // {headDep, tailDep, headSub, tailSub, revertEpoch, preBatchValue,
        // preBatchVersion, preBatchEvals (FIX-R)}: dispose() clears them on the recycle path, and the
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
            else for (let i = 0; i < cleanup.length; i++) { const fn = cleanup[i]; fn(); }
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
    // this twin. Marking and queueing are identical to markDownstream's loop; in addition
    // a target that is mid-run (COMPUTING), is not the writer, is not already flagged and
    // is reachable from the written signal along some path through no mid-run computed
    // (order-independent) gets FLAG_STALE_READ: its run read a value this write changed.
    // A COMPUTING node has not handed out its value yet: it absorbs the write or is
    // flagged itself and re-pulled (computedRunTail) before it returns, so nothing below
    // it is flagged through it. nc is set when a COMPUTING node pops; floor is the
    // stack entry under it, so nc clears when floor pops (LIFO: all pushed in between
    // descend from that node). The flag test runs on every edge, ahead of the markEpoch
    // dedup: a direct edge still flags a target an absorbed path stamped first. The
    // writer is the observer, else the owner (untrack nulls currentObserver; Watch.js
    // runs callbacks as untrack(cb) inside its effect), so self-writes stay absorbed. No
    // evalVersion write here: the S9 stamp in the run's `finally` would overwrite it.
    function markDownstreamInEval(startNode) {
        const gv = globalVersion;
        const writer = currentObserver !== null ? currentObserver : currentOwner;
        let markHead = startNode;
        startNode.nextMark = null;
        let nc = false;
        let floor = null;

        while (markHead !== null) {
            const n = markHead;
            markHead = n.nextMark;
            if (n === floor) nc = false;
            // Shadow mark: a node first popped inside an absorbed (nc) region keeps
            // nextMark = startNode; one later clean (!nc) edge to it re-pushes it (the
            // else-if below) so its edges get the flag test too. Each node pops at most
            // twice: O(V+E), no allocation. A shadow mark can outlive the walk, harmlessly:
            // startNode is a signal (never a link target, never pushed), a push always
            // overwrites nextMark, the re-push test only fires on a node stamped in this
            // walk (modulo the 2^32 markEpoch wrap: a stale match costs one harmless extra
            // re-walk), and disposeNode clears nextMark. No extra retention: nodePool owns
            // every node for the registry's life, and destroy() nulls nextMark.
            n.nextMark = nc ? startNode : null;
            if (!nc && (n.flags & FLAG_COMPUTING) !== 0) {
                nc = true;
                floor = markHead;
            }

            let link = n.headSub;
            while (link !== null) {
                const t = link.target;
                const flags = t.flags;
                if (!nc && (flags & (FLAG_COMPUTING | FLAG_STALE_READ)) === FLAG_COMPUTING && t !== writer) {
                    t.flags = flags | FLAG_STALE_READ;
                }
                if (t.markEpoch !== gv) {
                    t.markEpoch = gv;

                    if ((flags & FLAG_EFFECT) !== 0) {
                        if ((flags & (FLAG_QUEUED | FLAG_COMPUTING)) === 0) {
                            t.flags = flags | FLAG_QUEUED;
                            activeQueue[activeQueueLen++] = t;
                        }
                    } else {
                        t.nextMark = markHead;
                        markHead = t;
                    }
                } else if (!nc && t.nextMark === startNode) {
                    t.nextMark = markHead;
                    markHead = t;
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
     * FLAG_STALE_READ. Not stale -> return: the error stays cached and the pullComputed
     * wrapper throws it (D-H: a refresh never throws a cached error).
     * Stale -> clear the flag, set a far evalVersion floor (below any write made in
     * this run; never 0, so the equality cutoff is kept and neither the same-version
     * cache nor the clean short-circuit can re-absorb it), then re-refresh in the same
     * read. More than maxFlushPasses nested re-pulls -> D1(b): Error
     * "CycleError: computed keeps invalidating its own reads" is cached as the node's
     * own error (value, FLAG_HAS_ERROR, version = evalVersion = globalVersion), so a
     * repeat read rethrows it instead of re-running the body.
     * @private
     */
    function computedRunTail(node) {
        if ((node.flags & FLAG_STALE_READ) === 0) return;
        node.flags &= ~FLAG_STALE_READ;
        const f = (globalVersion - 0x3FFFFFFF) | 0;
        node.evalVersion = f === 0 ? -1 : f;
        if (staleRepulls >= maxFlushPasses) {
            node.value = new Error("CycleError: computed keeps invalidating its own reads");
            node.flags |= FLAG_HAS_ERROR;
            node.version = globalVersion;
            node.evalVersion = globalVersion;
            return;
        }
        staleRepulls++;
        try { refreshComputed(node, 0); } finally { staleRepulls--; }
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
    // out of line only for executeEffect's inlining budget. refreshComputed keeps the check
    // inline: routing its own pre-walk through this helper measured slower (r2, mux).
    // D-H: refresh, not pull -- a dep's cached error is thrown by the body's read, never here.
    // F-b33-1: also true if node's markEpoch moved across the pull (a write reached this
    // effect while the walk ran user code). `e !== 0`: createNode's recycle reset must not
    // mask the link compare.
    function pullMoved(link, dep, node) {
        const m = node.markEpoch;
        refreshComputed(dep, 0);
        const e = node.markEpoch;
        return (e !== m && e !== 0) || link.source !== dep || link.target !== node;
    }
    // Op 5 (recompute), out of line for the frames' inlining budget (TurboFan inlines it back,
    // so the no-hook path is one Smi bump + one compare).
    // FIX-R (A3, F5): every body run (executeEffect, refreshComputed) calls this first in its `try`,
    // so the evalCount bump lives HERE, before the hook call (a throwing op-5 hook still counts as
    // a run): inside executeEffect it would push that body past V8's 460 B inline limit.
    function fireRecompute(node) { evalCount = (evalCount + 1) & 0x3fffffff; if (mutationHook !== null) mutationHook(5, node.id, 0); }
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
            (0, node.computeFn)();
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
     * Resolve a computed node's current value: refresh it (refreshComputed) unless it
     * was already evaluated at globalVersion, then rethrow its cached error or return
     * its value.
     *
     * Errors thrown by computeFn are captured in `node.value` with FLAG_HAS_ERROR;
     * subsequent reads re-throw until a dependency change re-runs computeFn. D-H: only
     * this wrapper throws a cached error, so a dependent's pre-walk never aborts on an
     * errored dep -- the dependent re-runs and its body's read (which may catch) throws.
     *
     * gen snapshot across the refresh: a node disposed (or its slot recycled) by user
     * code during the refresh reads undefined, never the slot's new value or error.
     *
     * Used by peek, box get and box peek; the computed read closure inlines these 3
     * steps by hand (one frame per cold level).
     *
     * @private
     */
    function pullComputed(node) {
        if (node.evalVersion !== globalVersion) {
            const g = node.gen;
            refreshComputed(node, 0);
            if (node.gen !== g) return undefined;   // disposed during the refresh
        }
        if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;
        return node.value;
    }

    /**
     * Bring a computed node up to date: re-run if a dependency has changed since
     * last evaluation, else keep the cached value. The clean-read short-circuit via
     * markEpoch (1.1.4) settles it in O(1) when no mark landed in this node's
     * transitive cone since the last eval, instead of walking the whole dependency
     * subtree.
     *
     * Returns void and never throws the node's cached error (pullComputed and the
     * read closure do).
     * Throws only on a cycle: the node re-entered while computing, or (#42) `depth`,
     * the pre-walk recursion depth (a Smi), past nodePool.length -- an acyclic dep
     * chain is never deeper than the pool, so a cyclic dep graph throws CycleError
     * instead of overflowing the stack -- while nodePool.length is below the stack
     * limit; a larger pool still overflows first (LEDGER #42 residual).
     *
     * Same gen-snapshot self-dispose guard as executeEffect -- see #141 fix.
     *
     * @private
     */
    function refreshComputed(node, depth) {
        if (node.evalVersion === globalVersion) return;

        // CLEAN SHORT-CIRCUIT (ported from 1.1.3): markDownstream already stamps
        // markEpoch on the changed signal's whole cone; if no mark landed since
        // our last eval, the cached value is valid -> skip the dep walk. O(1).
        if (node.evalVersion !== 0 && ((node.markEpoch - node.evalVersion) | 0) <= 0) {
            node.evalVersion = globalVersion | 0;
            return;
        }

        const savedGen = node.gen;   // once, before any user code (see executeEffect)
        let shouldRun = node.evalVersion === 0;
        if (!shouldRun) {
            if (depth > nodePool.length) throwComputedCycle();   // #42: deeper than any acyclic chain
            const markAtWalk = node.markEpoch;   // F-b33-1: a write during the walk moves it
            let link = node.headDep;
            const evalVer = node.evalVersion | 0;
            while (link !== null) {
                const dep = link.source;
                if ((dep.flags & FLAG_COMPUTED) !== 0) {
                    refreshComputed(dep, depth + 1);
                    if (link.source !== dep || link.target !== node) { shouldRun = true; break; }   // A1.9: link freed
                }
                if (((dep.version - evalVer) | 0) > 0) {
                    shouldRun = true;
                    break;
                }
                link = link.nextDep;
            }
            if (node.gen !== savedGen) return;   // A1.9: disposed during the pre-walk
            if (markAtWalk !== node.markEpoch) shouldRun = true;
        }

        if (shouldRun) {
            if ((node.flags & FLAG_COMPUTING) !== 0) throwComputedCycle();
            node.flags |= FLAG_COMPUTING;
            runCleanup(node);   // CROSS-EDGE L3->L2: dispose owned children before recompute
            if (node.gen !== savedGen) return;   // B1 (r3): disposed by a cleanup

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
                const newValue = (0, node.computeFn)();
                // A1 r4: a body (or `equals`) that disposed `node` must not park its value on
                // the pinned, then pooled, slot (retention until reuse). Cold: never inlined.
                if (node.gen === savedGen) {
                    const eq = node.equals;
                    // D-K: leaving an error is always a change; equals is not called on the error.
                    if ((node.evalVersion === 0 || (node.flags & FLAG_HAS_ERROR) !== 0 || !eq ||
                        !eq(node.value, newValue)) && node.gen === savedGen) {
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
            if (node.flags === 0) return;   // disposed during body
            if ((node.flags & FLAG_ERR_OR_STALE) !== 0) computedRunTail(node);
            return;
        }

        if (node.flags === 0) return;   // disposed during body
        node.evalVersion = globalVersion;
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
        const equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : OBJECT_IS;
        const node = createNode(initial, FLAG_SIGNAL);
        node.equals = equals;
        node.version = globalVersion;
        statSignals++;

        // birthGen pinned at construction. The set/read closures check
        // `node.gen === birthGen` to detect stale handles after dispose +
        // pool-slot recycling. Without this, a retained set() from a disposed
        // signal can overwrite the recycled slot's new resident; a retained
        // read() inside an active observer can create a phantom subscription
        // to the recycled slot. See probe-c1-stale-set.mjs / probe-c1-stale-read.mjs.
        const birthGen = node.gen;

        /**
         * Read the value; tracked inside an observer. Returns
         * undefined if the handle is stale, including disposed by a hook during this read.
         */
        const read = () => {
            if (node.gen !== birthGen) return undefined;
            if (currentObserver !== null) {
                let expected = activeObserverCurrentDep;
                if (expected !== null && expected.source === node) {
                    activeObserverCurrentDep = expected.nextDep;
                } else {
                    allocateLink(node, currentObserver);
                    if (node.gen !== birthGen) return undefined;   // a hook inside allocateLink disposed this node (LEDGER #44)
                }
            }
            return node.value;
        };

        read.peek = sharedSignalPeek;
        // set stays a CLOSURE (1.2.0 + the F29 `|| 1` 0-skip + the FIX-R guard): its call path is the hot
        // path, and a closure over `node` beats a shared method's this[NODE_PTR]
        // load. Keeping it a closure also restores detached `const {set}=signal()`.
        read.set = (value) => {
            if (node.gen !== birthGen) return;
            const eq = node.equals;
            if (eq && eq(node.value, value)) return;
            if (batchDepth > 0 && node.revertEpoch !== batchEpoch) {
                node.preBatchValue = node.value;
                node.preBatchVersion = node.version;
                node.preBatchEvals = evalCount;   // FIX-R (A3, F5): body-run count at the capture
                node.revertEpoch = batchEpoch;
            }
            node.value = value;
            // FIX-R (A3, F5): revert only if no body ran since this node's capture (else a body
            // that saw the intermediate value would look current and never re-run).
            if (batchDepth > 0 && node.revertEpoch === batchEpoch && node.preBatchEvals === evalCount && eq && eq(node.preBatchValue, value)) {
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
        const equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : OBJECT_IS;
        const node = createNode(undefined, FLAG_COMPUTED);
        node.computeFn = fn;
        node.equals = equals;
        statComputeds++;

        const birthGen = node.gen;

        /**
         * Read the value (refreshed if stale); tracked inside an observer. Returns
         * undefined if the handle is stale, including disposed by a hook during this read.
         */
        const read = () => {
            if (node.gen !== birthGen) return undefined;
            if (currentObserver !== null) {
                let expected = activeObserverCurrentDep;
                if (expected !== null && expected.source === node) {
                    activeObserverCurrentDep = expected.nextDep;
                } else {
                    allocateLink(node, currentObserver);
                    if (node.gen !== birthGen) return undefined;   // a hook inside allocateLink disposed this node (LEDGER #44)
                }
            }
            if (node.evalVersion !== globalVersion) {
                const g = node.gen;   // equals birthGen here: the else arm re-checks after allocateLink (LEDGER #44)
                refreshComputed(node, 0);
                if (node.gen !== g) return undefined;   // disposed during the refresh
            }
            if ((node.flags & FLAG_HAS_ERROR) !== 0) throw node.value;
            return node.value;
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

    /**
     * signalBox get(): read the value; tracked inside an observer. Returns
     * undefined if the handle is stale, including disposed by a hook during this read.
     */
    function boxGet() {
        const node = this[NODE_PTR];
        if (node.gen !== this[NODE_GEN]) return undefined;   // stale: slot recycled (ABA guard)
        if (currentObserver !== null) {
            const expected = activeObserverCurrentDep;
            if (expected !== null && expected.source === node) {
                activeObserverCurrentDep = expected.nextDep;
            } else {
                allocateLink(node, currentObserver);
                if (node.gen !== this[NODE_GEN]) return undefined;   // a hook inside allocateLink disposed this node (LEDGER #44)
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
            node.preBatchEvals = evalCount;   // FIX-R (A3, F5): body-run count at the capture
            node.revertEpoch = batchEpoch;
        }
        node.value = value;
        // FIX-R (A3, F5): same guard as read.set.
        if (batchDepth > 0 && node.revertEpoch === batchEpoch && node.preBatchEvals === evalCount && eq && eq(node.preBatchValue, value)) {
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
    /**
     * computedBox get(): read the value (refreshed if stale); tracked inside an observer. Returns
     * undefined if the handle is stale, including disposed by a hook during this read.
     */
    function boxComputedGet() {
        const node = this[NODE_PTR];
        if (node.gen !== this[NODE_GEN]) return undefined;
        if (currentObserver !== null) {
            const expected = activeObserverCurrentDep;
            if (expected !== null && expected.source === node) {
                activeObserverCurrentDep = expected.nextDep;
            } else {
                allocateLink(node, currentObserver);
                if (node.gen !== this[NODE_GEN]) return undefined;   // a hook inside allocateLink disposed this node (LEDGER #44)
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
        const equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : OBJECT_IS;
        const node = createNode(initial, FLAG_SIGNAL_BOX);
        node.equals = equals;
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
        const equals = (opts !== undefined && opts.equals !== undefined) ? opts.equals : OBJECT_IS;
        const node = createNode(undefined, FLAG_COMPUTED_BOX);
        node.computeFn = fn;
        node.equals = equals;
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
     * `"CycleError:"` -- from this call itself when the loop forms on the first run,
     * with or without a synchronous scheduler. Any throw that escapes this call (a
     * CycleError, a body throw, a throwing scheduler, or a truthy non-function
     * scheduler) disposes the effect first; a deferred first run (async scheduler)
     * that throws later leaves it live.
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
        const scheduler = (opts !== undefined) ? opts.scheduler : undefined;
        const node = createNode(undefined, FLAG_EFFECT);
        node.computeFn = fn;
        node.scheduler = scheduler;
        statEffects++;

        let firstRunError = null;
        let threw = false;
        // birthGen is captured BEFORE the first run: a first run that disposes
        // its own effect lets the slot be recycled (gen bumped), so the dispose
        // tail after the catch and the returned handle (disposeFn guard + NODE_GEN
        // stamp) key on this pre-run gen and never touch the slot's new resident.
        const birthGen = node.gen;
        try {
            if (node.scheduler) {
                const gen = node.gen | 0;
                // Cache the gen-bound thunk so re-schedules reuse the same closure.
                // The inline guard preserves ABA correctness across dispose+recycle
                // (gen bumps on disposeNode -> stale thunk no-ops).
                node.schedulerThunk = () => {
                    if (node.gen === gen && (node.flags & FLAG_EFFECT) !== 0) executeEffect(node);
                };
                scheduler(node.schedulerThunk);
            } else {
                executeEffect(node);
            }
        } catch (err) {
            threw = true;
            firstRunError = err;
        }

        let disposed = false;
        const disposeFn = function dispose() {
            if (disposed) return;
            disposed = true;
            if (node.gen !== birthGen) return;
            if (node.flags !== 0) {
                disposeGuarded(node);
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

        if (threw) {
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
            disposeGuarded(node);
        }
    }

    // D-B2 (1.6.0): public dispose entries in progress (dispose(api), the effect / restored-effect
    // handles, effect()'s first-run-throw tail). The cleanups and op-2 / op-4 listeners a dispose
    // runs see disposeDepth > 0, so snapshot() refuses inside them. Smi (bounded by the JS stack).
    // Cold: never inside the pinned disposeNode body.
    let disposeDepth = 0;
    function disposeGuarded(node) {
        disposeDepth++;
        try { disposeNode(node); } finally { disposeDepth--; }
    }

    /**
     * Coalesce multiple synchronous writes into a single effect-flush pass.
     * Nested batches are merged -- only the outermost close triggers the flush.
     *
     * Pre-batch revert (1.2.0; narrowed by FIX-R, A3 / F5): if a signal is set,
     * then set back to its pre-batch value (under its `equals`) before the outer
     * close, the version bump is reverted and downstream effects/computeds do not
     * fire -- ONLY if no computed or effect body ran since that signal's first
     * write in the batch (its capture). If one ran (a computed read mid-batch,
     * an effect created mid-batch), the set back is a normal write: it bumps the
     * version and marks downstream, so no reader keeps the intermediate value.
     * A body (effect or computed) already running when the signal is first
     * written in the batch (it, or a computed it reads, writes the signal) that
     * then reads it in the same run does not block the revert (KNOWN
     * residual (a)). The body-run counter is 30-bit: exactly k*2^30 body runs
     * between the capture and the set back fall back to the pre-fix revert (KNOWN).
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
            n.preBatchEvals = 0;   // FIX-R (A3, F5)

            n.owner = null;
            n.prevOwned = null;
            n.nextOwned = null;
            n.firstOwned = null;
            n.nextMark = null;

            if (lifecycleCount !== 0) dropLifecycleHooks(n);   // LEDGER #40: destroy re-seats every slot too
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
        const onConnect = (opts !== undefined) ? opts.onConnect : undefined;
        const onDisconnect = (opts !== undefined) ? opts.onDisconnect : undefined;
        // A5a: every call appends its own reg at the tail (FIFO), born in the node's current phase.
        // lifecycleCount counts NODES with >= 1 registration (the first reg makes the entry).
        let e = lifecycleMap.get(node);
        if (e === undefined) {
            e = {head: null, tail: null};
            lifecycleMap.set(node, e);
            lifecycleCount = (lifecycleCount + 1) | 0;
        }
        const reg = {onConnect: onConnect, onDisconnect: onDisconnect, phase: node.headSub !== null ? 1 : 0,
            live: true, prev: e.tail, next: null};
        if (e.tail !== null) e.tail.next = reg; else e.head = reg;
        e.tail = reg;
        // LEDGER #40: gen-stamped -- an off() that outlives its node (disposed, slot re-seated)
        // is a no-op; disposeNode already dropped the entry, and the live one is a stranger's.
        // `!reg.live` is the first guard (the stamp backs it): dropLifecycleHooks kills every reg
        // (live = false) when the node is disposed. The stamp matters only when dispose SKIPPED dropLifecycleHooks
        // (lifecycleCount wrapped to 0 while an entry was live). off() captures `reg`, never the
        // entry, and drops the dead reg's callbacks, so a kept off handle does not retain the
        // user's closures (test/80 RETENTION).
        const g = node.gen;
        return () => {
            if (!reg.live) return;
            reg.live = false;
            reg.onConnect = undefined;
            reg.onDisconnect = undefined;
            if (node.gen !== g) return;
            // Unlink; reg.next is NOT cleared, so a fire walking through `reg` continues past it.
            const le = lifecycleMap.get(node);
            const p = reg.prev, n = reg.next;
            if (p !== null) p.next = n; else le.head = n;
            if (n !== null) n.prev = p; else le.tail = p;
            if (le.head === null) {
                lifecycleMap.delete(node);
                lifecycleCount = (lifecycleCount - 1) | 0;
            }
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

    // === SNAPSHOT / RESTORE (1.6.0) -- COLD, in-process time-travel ==========
    // Two new cold functions and one private rehydration hook. NONE of them
    // touch markDownstream / pullComputed / executeEffect / flushEffects or the
    // read/write fast paths: snapshot is a one-time walk of the live pool,
    // restore builds a fresh graph out of the engine's existing cold primitives
    // (signal/computed/computedBox/signalBox constructors + allocateLink +
    // createNode). Values move BY REFERENCE (in-process; no structuredClone).

    /** kind string for a live node, distinguishing box vs callable form. */
    function snapshotKind(n) {
        const f = n.flags;
        if ((f & FLAG_EFFECT) !== 0) return "effect";
        const isBox = (f & FLAG_BOX) !== 0;
        if ((f & FLAG_COMPUTED) !== 0) return isBox ? "computedBox" : "computed";
        return isBox ? "signalBox" : "signal";
    }

    /**
     * Serialize the live graph to a plain object. A cold one-time walk of the
     * node pool. Node identity is the existing monotonic `node.id`; deps and
     * ownerId are recorded as ids. Functions (computeFn / equals / schedulers)
     * are NOT captured -- restore re-supplies bodies only, via `fnsById`; equals and schedulers are lost. Values are
     * captured by reference. D-J: subPos[j] is dep link j's position in its source's subscriber
     * list (restore places each link there, so each source's subscriber order round-trips).
     * D-J6: ownerPos is the record's position in its owner's child list (0 = the newest child,
     * the head forEachOwned visits first), or -1 when ownerId is null; restore places each child
     * there, so each owner's child order (the cascade-dispose visit order) round-trips; cleanup callbacks are not captured.
     * D-M / D-O (A9 round 6): every record carries its evalVersion + markEpoch, and the snapshot
     * the registry clock (gv) and the next node id (nextId), so restore resumes live's exact
     * freshness state and id sequence.
     * @returns {{v:1, nodes: Array<{id:number,kind:string,flags:number,value:*,version:number,clean:boolean,ownerId:(number|null),ownerPos:number,deps:number[],subPos:number[],evalVersion:number,markEpoch:number}>, gv:number, nextId:number}}
     */
    function snapshot() {
        // Fail closed on an unsettled graph. A snapshot taken mid-flush or
        // mid-batch would enshrine a torn cut -- half-propagated versions, deps
        // captured before severTail, values not yet committed. A snapshot taken
        // from inside a compute body (currentObserver !== null) would capture a FLAG_COMPUTING
        // node mid-track with a torn dep list. Snapshot only a quiescent graph so
        // every captured cache-validity bit is truthful.
        if (isFlushing || batchDepth > 0 || currentObserver !== null) {
            throw new Error("[lite-signal] snapshot: graph not settled (flush/batch/track in progress)");
        }
        // D-B2 (1.6.0): a dispose or an onGraphMutation listener in progress leaves the graph torn
        // (a dying node still linked, a half-built node, cut deps) while no body runs.
        if (disposeDepth > 0) throw new Error("[lite-signal] snapshot: graph not settled (dispose in progress)");
        if (hookDepth > 0) throw new Error("[lite-signal] snapshot: graph not settled (onGraphMutation listener running)");
        const out = [];
        const poolLen = nodePool.length;
        // D-J: index every live node's subscriber list first (a dep's source may sit later in
        // the pool), so each dep link records its position there. Cold: one Map per snapshot.
        const subIdx = new Map();
        const ownIdx = new Map();   // D-J6: owned node -> its position in its owner's child list
        for (let i = 0; i < poolLen; i++) {
            const n = nodePool[i];
            if (n.flags === 0) continue;
            let k = 0;
            for (let l = n.headSub; l !== null; l = l.nextSub) subIdx.set(l, k++);
            k = 0;
            for (let c = n.firstOwned; c !== null; c = c.nextOwned) ownIdx.set(c, k++);   // D-J6
        }
        let linkTotal = 0, ownedTotal = 0;
        for (let i = 0; i < poolLen; i++) {
            const n = nodePool[i];
            if (n.flags === 0) continue;   // free / never-used slot
            // D-B (1.6.0): a body running under untrack() / createRoot() / runWithOwner() leaves
            // currentObserver null, so the guard above misses it -- but its node still carries
            // FLAG_COMPUTING. Fail closed on ANY running body (cold: one AND per live node).
            if ((n.flags & FLAG_COMPUTING) !== 0) {
                throw new Error("[lite-signal] snapshot: graph not settled (flush/batch/track in progress)");
            }
            // D-D2 (1.6.0): a pending scheduled run would be lost (restore carries no scheduler).
            // QUEUED outside a flush/batch = a scheduled re-run handed to its scheduler, not yet run
            // (executeEffect clears it). An effect with evalVersion 0 has never finished a run:
            // effect() handed its first run to the scheduler without QUEUED. executeEffect stamps
            // evalVersion (never 0: globalVersion skips 0) on every completed run, so no new write.
            if ((n.flags & FLAG_QUEUED) !== 0 || ((n.flags & FLAG_EFFECT) !== 0 && n.evalVersion === 0)) {
                throw new Error("[lite-signal] snapshot: graph not settled (scheduled effect run pending)");
            }
            const deps = [];
            const subPos = [];
            let l = n.headDep;
            while (l !== null) {
                const src = l.source;
                if (src !== null) {
                    const p = subIdx.get(l);
                    if (p === undefined) throw new Error("[lite-signal] snapshot: graph not settled (torn subscriber list)");
                    deps.push(src.id);
                    subPos.push(p);
                }
                l = l.nextDep;
            }
            linkTotal += deps.length;
            let ownerPos = -1;
            if (n.owner !== null) {
                const q = ownIdx.get(n);
                if (q === undefined) throw new Error("[lite-signal] snapshot: graph not settled (torn owner list)");
                ownerPos = q; ownedTotal++;
            }
            // Per-computed cache validity, read from the SAME freshness fields the
            // hot path trusts (pullComputed's clean short-circuit): a cache is
            // valid iff the node was actually evaluated (evalVersion !== 0) AND no
            // mark has landed in its cone since that eval (markEpoch <= evalVersion).
            // A never-read computed (evalVersion 0, deps []) and a dirty one
            // both report clean:false; restore seeds a dirty one with its value, version and stamps (D-L), so its first read pre-walks as live, and leaves a never-read one uncomputed.
            // Signals have no cache; the bit is meaningless for them (and false).
            const clean = (n.evalVersion !== 0) && (((n.markEpoch - n.evalVersion) | 0) <= 0);
            out.push({
                id: n.id | 0,
                kind: snapshotKind(n),
                flags: n.flags | 0,
                value: n.value,
                version: n.version | 0,
                clean: clean,
                ownerId: n.owner !== null ? (n.owner.id | 0) : null,
                ownerPos,
                deps,
                subPos,
                evalVersion: n.evalVersion | 0,   // D-M: the freshness stamps restore copies back
                markEpoch: n.markEpoch | 0
            });
        }
        // D-J: every subscriber link is some live node's dep link, and vice versa.
        if (linkTotal !== subIdx.size) throw new Error("[lite-signal] snapshot: graph not settled (torn subscriber list)");
        // D-J6: every child in a live owner's list is a live owned record, and vice versa.
        if (ownedTotal !== ownIdx.size) throw new Error("[lite-signal] snapshot: graph not settled (torn owner list)");
        return {v: 1, nodes: out, gv: globalVersion | 0, nextId: nodeSeq | 0};
    }

    /**
     * Populate THIS (assumed-fresh) registry from a snapshot. Private hook,
     * reached only via {@link restore} through the module-scope REHYDRATE WeakMap.
     * @private
     */
    function rehydrate(snap, fnsById, handlesOut) {
        if (snap === null || typeof snap !== "object") {
            throw new TypeError("[lite-signal] restore: invalid snapshot (expected { v: 1, nodes: [...] })");
        }
        const nodes = snap.nodes;
        if (snap.v !== 1 || !Array.isArray(nodes)) {
            throw new TypeError("[lite-signal] restore: invalid snapshot (expected { v: 1, nodes: [...] })");
        }
        // D-M / D-O (round 6): the recorded clock and next node id are REQUIRED, each read ONCE
        // and copied exactly, never coerced. gv is never 0 (the clock skips 0) and otherwise any
        // int32 (it wraps); nextId is any int32 (live's nodeSeq wraps by (nodeSeq + 1) | 0).
        const gv = snap.gv;
        if (typeof gv !== "number" || (gv | 0) !== gv || gv === 0) {
            throw new TypeError("[lite-signal] restore: invalid gv " + restoreShow(gv) + " (expected an int32 other than 0)");
        }
        const nextId = snap.nextId;
        if (typeof nextId !== "number" || (nextId | 0) !== nextId || Object.is(nextId, -0)) {
            throw new TypeError("[lite-signal] restore: invalid nextId " + restoreShow(nextId) + " (expected an int32)");
        }
        // A9 round 2: ONE read-only pre-scan validates every record (E1 int law, E2 own-property
        // bodies, E4 structure, E9 dangling deps) BEFORE the first write below. Nothing past this
        // line reads the snapshot again: the rebuild uses only the validated, copied plan.
        const P = restorePrescan(nodes, fnsById);
        const count = P.count;
        const ids = P.ids, kinds = P.kinds, vers = P.vers, values = P.values;

        // D-M (round 6): the clock resumes at live's globalVersion exactly, and pass 1 gives every
        // computed and effect its recorded evalVersion + markEpoch, so each freshness compare
        // (the clean short-circuit, the newer-dep pre-walk, the modular 2^31 band) answers as it
        // did live. No clock is synthesised from the restored versions.
        globalVersion = gv;
        const evs = P.evs, mes = P.mes;

        const built = new Array(count);
        // E3: handles are collected here and copied into handlesOut only after
        // every pass succeeded -- a throw (e.g. CapacityError mid-build) leaves
        // the caller's object untouched, never holding handles into an abandoned registry.
        const handles = new Array(count);

        // Pass 1: build every node (no compute body is executed here).
        for (let i = 0; i < count; i++) {
            const kc = kinds[i];
            let node, handle;

            if (kc === RESTORE_K_SIGNAL || kc === RESTORE_K_SIGNAL_BOX) {
                handle = (kc === RESTORE_K_SIGNAL_BOX) ? signalBox(values[i]) : signal(values[i]);
                node = handle[NODE_PTR];
                node.value = values[i];            // by reference
                node.version = vers[i];
            } else if (kc !== RESTORE_K_EFFECT) {
                const fn = P.fns[i];
                // computed/computedBox are LAZY -- construction does not run fn.
                handle = (kc === RESTORE_K_COMPUTED_BOX) ? computedBox(fn) : computed(fn);
                node = handle[NODE_PTR];
                if (P.clean[i] === 1) {
                    // Snapshot proved this cache CLEAN and evaluated: trust the
                    // captured value, rebuild deps (pass 2), and copy its stamps
                    // (clean by the validated formula: a read is a cache hit). Its deps may still include
                    // a dirty computed (a self-write, or a dep that threw in the
                    // pre-walk): pass 2 wires that edge too (D-G).
                    node.value = values[i];            // by reference
                    node.version = vers[i];
                    node.evalVersion = evs[i];   // D-M: the recorded stamps
                    node.markEpoch = mes[i];
                    if (P.hasErr[i] === 1) node.flags |= FLAG_HAS_ERROR;
                }
                else if (P.seed[i] === 1) {
                    // DIRTY and evaluated (D-I2 / D-L): copy the recorded value + version
                    // + error bit AND stamps, so the first read pre-walks the wired deps
                    // and reruns the body exactly as the live node would (the equality
                    // cutoff uses node.equals: the default -- a custom equals is not captured).
                    node.value = values[i];            // by reference
                    node.version = vers[i];
                    node.evalVersion = evs[i];
                    node.markEpoch = mes[i];
                    if (P.hasErr[i] === 1) node.flags |= FLAG_HAS_ERROR;
                }
                else {
                    // Never evaluated (version 0, evalVersion 0): nothing seeded. Pass 2
                    // still wires recorded deps (D-G); the first read runs the body,
                    // which re-tracks deps and caches correctly.
                    node.markEpoch = mes[i];
                }
            } else {
                const fn = P.fns[i];
                // Build the effect node WITHOUT running its body (user decision:
                // restore state, do not re-fire). Its recorded stamps are copied (D-M),
                // so it fires on the next dependency change exactly as live's would.
                node = createNode(undefined, FLAG_EFFECT);
                node.computeFn = fn;
                node.evalVersion = evs[i];   // never 0 (validated)
                node.markEpoch = mes[i];
                statEffects++;
                const birthGen = node.gen;
                let disposed = false;
                const disposeFn = function dispose() {
                    if (disposed) return;
                    disposed = true;
                    if (node.gen !== birthGen) return;
                    if (node.flags !== 0) disposeGuarded(node);
                };
                disposeFn[NODE_PTR] = node;
                disposeFn[NODE_GEN] = birthGen;
                handle = disposeFn;
            }

            node.id = ids[i];   // preserve stable ids so re-snapshot round-trips (validated unique by the pre-scan)
            built[i] = node;
            handles[i] = handle;
        }
        nodeSeq = nextId;   // D-O: continue at live's next id (validated int32)

        // Pass 2: rebuild dep edges (every dep resolved by the pre-scan).
        // A never-evaluated or dirty computed with recorded deps is wired too
        // (D-G), so a set() on those deps reaches whatever reads it; its first
        // read pre-walks them (dirty, D-L) or runs the body (never evaluated), and
        // the cursor re-tracks or severs the wired links (no double-link). No recorded deps: skip.
        // D-J: every link is recorded in slots at its source's base + subPos, and pass 2b
        // re-chains each source's subscriber list in that order (placed, not appended).
        // src.tailSub = null before each allocateLink defeats its same-pass dedup
        // (source.tailSub.target === target), so a node that read one source twice
        // (deps [s, C, s]) gets both links back. The source's list is left torn (headSub
        // overwritten, prevSub null) until pass 2b rebuilds every list with links.
        // Nothing reads a subscriber list in between: a fresh registry has no lifecycle
        // listener, no onGraphMutation hook and no running observer.
        const subBase = P.subBase;
        const slots = new Array(P.subE);
        const links0 = activeLinks;
        for (let i = 0; i < count; i++) {
            const kc = kinds[i];
            if ((kc === RESTORE_K_COMPUTED || kc === RESTORE_K_COMPUTED_BOX) && P.clean[i] === 0 && P.depIdx[i].length === 0) continue;
            const node = built[i];
            const di = P.depIdx[i];
            const sp = P.subPos[i];
            for (let j = 0; j < di.length; j++) {
                const src = built[di[j]];
                src.tailSub = null;                 // defeat the same-pass dedup (see above)
                allocateLink(src, node);            // appends to node.tailDep
                slots[subBase[di[j]] + sp[j]] = node.tailDep;
            }
        }
        // Fail closed if any recorded link was not allocated (a dedup return would leave one
        // link in two slots and pass 2b would chain a cyclic list). Cold: one compare.
        if (((activeLinks - links0) | 0) !== P.subE) throw new Error("[lite-signal] restore: link rebuild mismatch (" + ((activeLinks - links0) | 0) + " of " + P.subE + ")");
        // Pass 2b (D-J): chain each source's subscriber list in recorded order (Scan B2
        // proved the positions a permutation, so every slot holds exactly one link).
        for (let s = 0; s < count; s++) {
            const b = subBase[s], e = subBase[s + 1];
            if (b === e) continue;
            const src = built[s];
            let prev = null;
            for (let k = b; k < e; k++) {
                const l = slots[k];
                l.prevSub = prev;
                l.nextSub = null;
                if (prev === null) src.headSub = l; else prev.nextSub = l;
                prev = l;
            }
            src.tailSub = prev;
        }

        // Pass 3: rebuild the owner tree (owners resolved and proven acyclic by the pre-scan).
        // D-J6: each owner's children are chained in recorded ownerPos order (Scan C2 proved the
        // positions a permutation per owner), so each owner's child order round-trips.
        const ownBase = P.ownBase, ownOrder = P.ownOrder;
        for (let o = 0; o < count; o++) {
            const b = ownBase[o], e = ownBase[o + 1];
            if (b === e) continue;
            const owner = built[o];
            let prev = null;
            for (let k = b; k < e; k++) {
                const node = built[ownOrder[k]];
                node.owner = owner;
                node.prevOwned = prev;
                node.nextOwned = null;
                if (prev === null) owner.firstOwned = node; else prev.nextOwned = node;
                prev = node;
            }
        }

        if (handlesOut !== undefined) {
            for (let i = 0; i < count; i++) handlesOut[ids[i]] = handles[i];
        }
    }

    /**
     * Rebuild a FRESH registry from a snapshot. Computeds/effects are re-supplied
     * their compute body from `opts.fnsById` (keyed by the snapshot node id);
     * a missing fn for any computed/effect FAILS CLOSED. If `opts.handles` is
     * provided it is filled with `{ [id]: handle }` for every restored node --
     * the natural way to wire `fnsById` bodies to the rebuilt graph (they close
     * over the same object and are only invoked after restore populates it).
     * Effects are restored but NOT re-fired. Values are restored by reference.
     * @param {object} snap  A {@link snapshot} result.
     * @param {{fnsById?:Object<number,Function>, handles?:Object<number,*>, config?:Object}} [opts]
     * @returns {Registry} a fresh registry.
     */
    function restore(snap, opts) {
        let fnsById, handlesOut, override;
        if (opts !== undefined) {
            // E2 (A9 round 2): a PLAIN object only -- no array, no prototype keys,
            // no Symbol keys; an unknown key is an error with a did-you-mean hint.
            if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
                throw new TypeError("[lite-signal] restore: options must be a plain object");
            }
            const proto = Object.getPrototypeOf(opts);
            if (proto !== Object.prototype && proto !== null) {
                throw new TypeError("[lite-signal] restore: options must be a plain object (inherited keys are never read)");
            }
            if (Object.getOwnPropertySymbols(opts).length !== 0) {
                throw new TypeError("[lite-signal] restore: options must not carry Symbol keys");
            }
            const okeys = Object.getOwnPropertyNames(opts);
            for (let ki = 0; ki < okeys.length; ki++) {
                const ok = okeys[ki];
                if (RESTORE_KEYS.indexOf(ok) === -1) {
                    const hint = suggestKey(ok, RESTORE_KEYS);
                    throw new TypeError(
                        '[lite-signal] restore: "' + ok + '" is not a recognized option' +
                        (hint !== null ? ' (did you mean "' + hint + '"?)' : '') +
                        '. Allowed: ' + RESTORE_KEYS.join(", ") + '.'
                    );
                }
            }
            fnsById = RESTORE_HAS_OWN.call(opts, "fnsById") ? opts.fnsById : undefined;
            handlesOut = RESTORE_HAS_OWN.call(opts, "handles") ? opts.handles : undefined;
            override = RESTORE_HAS_OWN.call(opts, "config") ? opts.config : undefined;
            if (fnsById !== undefined && (fnsById === null || typeof fnsById !== "object")) {
                throw new TypeError("[lite-signal] restore: fnsById must be an object");
            }
            if (handlesOut !== undefined && (handlesOut === null || typeof handlesOut !== "object")) {
                throw new TypeError("[lite-signal] restore: handles must be an object");
            }
        }
        if (override !== undefined && (override === null || typeof override !== "object")) {
            throw new TypeError("[lite-signal] restore: config must be an object");
        }
        // Size the fresh registry to the snapshot so a > default-maxNodes (1024)
        // graph does not hit CapacityError partway through the rebuild. Count the
        // nodes and their total dep edges, add headroom, and let an explicit
        // opts.config win. A malformed snap sizes to the default and REHYDRATE's
        // validator throws the precise shape error.
        let config = override;
        if (config === undefined && snap !== null && typeof snap === "object" && Array.isArray(snap.nodes)) {
            const nodes = snap.nodes;
            const nodeCount = nodes.length;
            let linkCount = 0;
            for (let i = 0; i < nodeCount; i++) {
                const d = nodes[i] && nodes[i].deps;
                if (Array.isArray(d)) linkCount += d.length;
            }
            const maxNodes = (nodeCount + (nodeCount >> 1) + 16) | 0;   // 1.5x + 16 headroom
            const nodeCap = maxNodes > 1024 ? maxNodes : 1024;
            // D-C (1.6.0): links get max(1.5L + 16, 4 x maxNodes) -- the createRegistry default ratio as a
            // floor, so the restored registry keeps the link headroom a default-sized one has. The source
            // registry's prealloc / onCapacityExceeded / maxFlushPasses are NOT carried: pass opts.config.
            const maxLinks = (linkCount + (linkCount >> 1) + 16) | 0;
            const linkFloor = nodeCap * 4;
            config = {maxNodes: nodeCap, maxLinks: maxLinks > linkFloor ? maxLinks : linkFloor};
        }
        const fresh = createRegistry(config);
        REHYDRATE.get(fresh)(snap, fnsById, handlesOut);
        return fresh;
    }

    const api = {
        getOwner,
        runWithOwner,
        signal,
        computed,
        effect,
        signalBox,
        computedBox,
        dispose,
        batch,
        untrack,
        createRoot,
        onCleanup,
        stats,
        destroy,
        isTracking,
        hasObservers,
        observeObservers,
        forEachObserver,
        forEachSource,
        forEachOwned,
        ownerOf,
        nodeId,
        describe,
        onGraphMutation,
        snapshot,
        restore
    };
    // Private rehydration hook: reachable by restore() via REHYDRATE.get(fresh)
    // but held OFF the public object in a module-scope WeakMap, so a live
    // registry exposes no handle to its own rehydrate (invisible to
    // Object.getOwnPropertySymbols; calling it could corrupt the registry).
    REHYDRATE.set(api, rehydrate);
    return api;
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

/**
 * Serialize the default registry's live graph to a plain object (1.6.0).
 * See {@link Registry.snapshot}.
 */
export function snapshot() {
    return defaultRegistry.snapshot();
}

/**
 * Rebuild a fresh registry from a snapshot (1.6.0). Delegates to the default
 * registry but returns an independent, freshly-built registry. See
 * {@link Registry.restore}.
 */
export function restore(snap, opts) {
    return defaultRegistry.restore(snap, opts);
}

export {watch, when, whenAsync} from "./Watch.js";