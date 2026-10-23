/**
 * @zakkster/lite-signal -- zero-GC reactive graph.
 *
 * Public type surface for the JavaScript implementation in `Signal.js`.
 */

// --- Options ------------------------------------------------------------------

/** Equality predicate. Returning `true` halts propagation. */
export type EqualsFn<T> = (a: T, b: T) => boolean;

/** Options accepted by {@link signal}. */
export interface SignalOptions<T> {
    /** Custom equality predicate. Default: `Object.is`. */
    equals?: EqualsFn<T>;
}

/** Options accepted by {@link computed}. */
export interface ComputedOptions<T> {
    /** Custom equality predicate. Default: `Object.is`. */
    equals?: EqualsFn<T>;
}

/**
 * Scheduler trampoline. The implementation must call the supplied `run` callback
 * at most once. `requestAnimationFrame`, `queueMicrotask`, and `setTimeout`
 * shapes are all compatible (wrap them if their signature differs).
 */
export type EffectScheduler = (run: () => void) => void;

/** Options accepted by {@link effect}. */
export interface EffectOptions {
    /** Optional scheduler. If supplied, the effect's first run and every
     *  subsequent re-run is deferred through this trampoline. */
    scheduler?: EffectScheduler;
}

/** Idempotent dispose handle returned by {@link effect} and `.subscribe()`. */
export type Dispose = () => void;

/**
 * Anything that can be passed to {@link Registry.dispose}: a {@link Signal},
 * a {@link Computed}, or an effect's {@link Dispose} function. Passing an
 * unrelated value is a safe no-op.
 */
export type Disposable<T = unknown> = Signal<T> | Computed<T> | SignalBox<T> | ComputedBox<T> | Dispose;

// --- Reactive primitive shapes ------------------------------------------------

/** Reactive source of truth. */
export interface Signal<T> {
    /** Read the current value, tracking the read if inside an effect or computed. */
    (): T;
    /** Read the value WITHOUT tracking. */
    peek(): T;
    /** Overwrite the value. No-op if equal under the signal's equality predicate. */
    set(value: T): void;
    /** Functional update: `set(fn(currentValue))`. Reads the current value without tracking. */
    update(fn: (current: T) => T): void;
    /** Subscribe to value changes. Fires immediately with the current value. */
    subscribe(fn: (value: T) => void): Dispose;
}

/** Lazy memoised derivation. */
export interface Computed<T> {
    /** Resolve the value, tracking the read if inside an effect or computed. */
    (): T;
    /** Resolve the value WITHOUT tracking. */
    peek(): T;
    /** Subscribe to value changes. Fires immediately with the current value. */
    subscribe(fn: (value: T) => void): Dispose;
}

/**
 * Allocation-light, non-callable signal (1.5.0). A plain object on a shared
 * prototype rather than a callable function -- cheaper to construct than
 * {@link Signal} (no closure allocation), with an identical zero-GC read/write
 * path. Interoperates freely with callable handles in the same graph.
 */
export interface SignalBox<T> {
    /** Read the current value, tracking the read if inside an effect or computed. */
    get(): T;
    /** Overwrite the value. No-op if equal under the box's equality predicate. */
    set(value: T): void;
    /** Read the value WITHOUT tracking. */
    peek(): T;
    /** Functional update: `set(fn(currentValue))`. Reads the current value without tracking. */
    update(fn: (current: T) => T): void;
    /** Subscribe to value changes. Fires immediately with the current value; the callback runs untracked. */
    subscribe(fn: (value: T) => void): Dispose;
}

/**
 * Allocation-light, non-callable computed (1.5.0). The derived counterpart to
 * {@link SignalBox}: `{ get, peek, subscribe }`, no `set` / `update`.
 */
export interface ComputedBox<T> {
    /** Resolve the value, tracking the read if inside an effect or computed. */
    get(): T;
    /** Resolve the value WITHOUT tracking. */
    peek(): T;
    /** Subscribe to value changes. Fires immediately with the current value; the callback runs untracked. */
    subscribe(fn: (value: T) => void): Dispose;
}

// --- Diagnostics --------------------------------------------------------------

export interface RegistryStats {
    /** Number of signals created in this registry's lifetime. */
    signals: number;
    /** Number of computeds created in this registry's lifetime. */
    computeds: number;
    /** Number of effects currently alive (decrements on dispose). */
    effects: number;
    /** Number of dependency links currently in use. */
    activeLinks: number;
    /** Dependency links available in the pool (ledger-based: `linkPoolCapacity - activeLinks`). */
    pooledLinks: number;
    /** Link-pool capacity ledger. Doubles under the `"grow"` policy; under `"lazy"`
     *  prealloc it may exceed the count of physically constructed links. */
    linkPoolCapacity: number;
    /** Node-pool capacity ledger. Doubles under the `"grow"` policy; under `"lazy"`
     *  prealloc it may exceed the count of physically constructed nodes. */
    nodePoolCapacity: number;
    /** TRUE node-pool population: the number of `ReactiveNode`s physically constructed
     *  (`nodePool.length`), distinct from the `nodePoolCapacity` ledger. Under
     *  `prealloc:"lazy"` (or a silently-flipped `prealloc` typo) this stays 0 until
     *  first demand while capacity reads the ledger -- so a mis-set `prealloc` is
     *  observable here rather than telemetry-blind. Added in the 1.4.5 backport. */
    nodePoolPopulation: number;
    /** TRUE link-pool population: the number of `ReactiveLink`s physically constructed
     *  (`linkPool.length`), distinct from the `linkPoolCapacity` ledger. Added in the
     *  1.4.5 backport. */
    linkPoolPopulation: number;
    /** Number of nodes currently allocated (signals + computeds + alive effects). */
    activeNodes: number;
    /**
     * Cumulative count of every node acquired over the registry's life -- whether
     * popped from the free list or freshly constructed during a pool-growth chunk.
     * Monotonic; reset only by {@link Registry.destroy}. The true total ever handed
     * out, not the live count (`activeNodes` is the live gauge). Added in 1.4.0.
     */
    totalAllocations: number;
    /**
     * Cumulative count of every node returned to the pool (`disposeNode`). Monotonic;
     * reset only by {@link Registry.destroy}. In a quiescent registry
     * `totalAllocations - totalDisposals === activeNodes`. Added in 1.4.0.
     */
    totalDisposals: number;
    /**
     * Cumulative count of pool-growth chunks -- incremented whenever a node *or* link
     * refill pushes capacity past its current ledger. Nonzero after warm-up means the
     * initial pool was undersized and grew at runtime; an eager pool sized for its
     * workload keeps this at 0. Reset only by {@link Registry.destroy}. Added in 1.4.0.
     */
    poolGrowths: number;
}

// --- Snapshot / restore (1.6.0) ----------------------------------------------

/** The form a snapshotted node is restored as. Boxes (`signalBox`/`computedBox`)
 *  are recorded distinctly from their callable counterparts so restore rebuilds
 *  the right handle shape; effects have no box form. */
export type SnapshotNodeKind =
    | "signal"
    | "computed"
    | "effect"
    | "signalBox"
    | "computedBox";

/** One serialized node in a {@link Snapshot}. Identity is the stable, in-process
 *  monotonic `node.id`; `ownerId` and `deps` reference other nodes by that id.
 *  Compute bodies, equality predicates, and schedulers are NOT captured
 *  (compute bodies are re-supplied on {@link Registry.restore} via `fnsById`;
 *  equality predicates and schedulers are not -- a restored node uses
 *  `Object.is` and runs synchronously). `value` is held
 *  by reference (in-process time-travel; no structured-clone constraint). */
export interface SnapshotNode {
    /** Stable per-allocation node id (the in-process key). */
    id: number;
    /** signal / computed / effect / signalBox / computedBox. */
    kind: SnapshotNodeKind;
    /** Raw flag bitmask at capture time. */
    flags: number;
    /** The node's value at capture (by reference). */
    value: unknown;
    /** The node's version counter at capture. */
    version: number;
    /** The registry clock value at this node's last evaluation (int32; 0 = never evaluated). Required:
     *  restore() refuses a missing or non-int32 value, a signal with a non-0 value, an effect with 0, and a
     *  computed whose 0-ness differs from its `version`'s. Copied back exactly (negative values after an int32
     *  wrap are legal). */
    evalVersion: number;
    /** The registry clock value at the last mark that reached this node (int32; 0 for a signal). Required:
     *  restore() refuses a missing or non-int32 value or a signal with a non-0 value; `clean` must agree with
     *  it (`clean` iff `evalVersion !== 0` and `markEpoch` is not modularly ahead of `evalVersion`). Copied back exactly. */
    markEpoch: number;
    /** Whether this node's cache was CLEAN and evaluated at capture -- i.e. the
     *  computed actually ran and no mark has landed in its cone since (the same
     *  freshness test pullComputed's clean short-circuit trusts). For a computed,
     *  restore trusts the cached value only when `true`; a `false`
     *  computed is wired to its recorded deps and is not a cache hit: a dirty one is
     *  seeded with its recorded value, version, error bit, evalVersion and markEpoch and
     *  is pulled exactly as live does (the body runs only if a dep moved past its
     *  evalVersion); a never-evaluated one (version 0) is not seeded and runs its body
     *  on its first read. Meaningless (always `false`) for a plain signal. */
    clean: boolean;
    /** Owner node's id, or `null` for a top-level node. */
    ownerId: number | null;
    /** Position in the owner's child list (0 = newest child, the one `forEachOwned`
     *  visits first); `-1` exactly when `ownerId` is `null`. Required: restore()
     *  refuses a record without it, a non-integer, a value < -1, `-1` on an owned
     *  record, a non-`-1` on an unowned one, and any owner whose children's
     *  `ownerPos` values are not a permutation of 0..n-1. restore() re-creates each
     *  owner's children in this order.
     *  Cleanup callbacks are not captured; a restored node registers them when it
     *  next runs. */
    ownerPos: number;
    /** Ids of this node's dependency sources, in dep-list order. */
    deps: number[];
    /** Parallel to `deps`: `subPos[j]` is dep link j's position in its source's
     *  subscriber list (int >= 0; `[]` for a signal). Required: restore() refuses a
     *  missing / non-array `subPos`, a length != `deps.length`, an element that is not
     *  an int >= 0, and any source whose subscribers' positions are not a permutation
     *  of 0..n-1 (out of range or duplicate). restore() places every subscriber link
     *  at its recorded position, so each source's subscriber order round-trips. */
    subPos: number[];
}

/** A plain, in-process serialization of a reactive graph produced by
 *  {@link Registry.snapshot}. Feed it back to {@link Registry.restore} to
 *  rebuild the graph into a fresh registry. */
export interface Snapshot {
    /** Format version. Currently `1`. */
    v: 1;
    /** The source registry's version clock at capture (int32, never 0). Required; restore() sets the
     *  fresh registry's clock to it exactly. */
    gv: number;
    /** The source registry's next node id at capture (a 32-bit integer). Required; any int32 (live's counter
     *  wraps, so it may sit at or below a restored id); restore() continues ids from it exactly. */
    nextId: number;
    /** Every live node in the source registry at capture time. */
    nodes: SnapshotNode[];
}

/** Options for {@link Registry.restore}. */
export interface RestoreOptions {
    /** Compute bodies keyed by the snapshot node id, re-supplied for every
     *  restored computed / effect (functions do not serialize). A missing entry
     *  for any computed/effect FAILS CLOSED with a `[lite-signal] restore:
     *  missing fn for id <id> (<kind>)` error. */
    fnsById?: { [id: number]: (...args: any[]) => any };
    /** Optional out-parameter: if provided, restore fills it with
     *  `{ [id]: handle }` for every rebuilt node (callable handles for
     *  signals/computeds, box objects for boxes, the dispose fn for effects).
     *  The intended way to wire `fnsById` bodies to the rebuilt graph -- they
     *  close over this same object and are only invoked after restore has
     *  populated it. */
    handles?: { [id: number]: unknown };
    /** Optional registry-config override for the fresh registry restore builds.
     *  When omitted, restore sizes `maxNodes` / `maxLinks` from the snapshot
     *  (node count + total dep edges, with headroom) so a graph larger than the
     *  default 1024-node capacity restores without a `CapacityError`. Supply
     *  this to pin `prealloc`, `onCapacityExceeded`, or an explicit capacity.
     *  Supplying it turns the snapshot sizing off (used as given; a graph over 1024
     *  nodes needs its own maxNodes / maxLinks or onCapacityExceeded: "grow"). */
    config?: RegistryConfig;
}

// --- Observer-lifecycle introspection (1.1.4) ---------------------------------

/** Whether a described node is a signal, a computed, or an effect. */
export type NodeKind = "signal" | "computed" | "effect";

/** Non-perturbing snapshot of a graph neighbour yielded by the `forEach*` walkers. */
export interface NodeDescriptor {
    /** Stable per-allocation node id (1.1.5+). Dedupe key for graph traversal, and the
     *  re-walk handle: a descriptor may be passed back into forEachObserver/forEachSource. */
    id: number;
    kind: NodeKind;
    /** The node's current value (last stored/computed value; an effect's is its body return). */
    value: unknown;
}

/** Transition callbacks for {@link Registry.observeObservers}. */
export interface ObserveObserversHooks {
    /** Fired on the 0->1 observer transition (after registration). */
    onConnect?: () => void;
    /** Fired on the 1->0 observer transition. */
    onDisconnect?: () => void;
}

/**
 * Stops an {@link Registry.observeObservers} subscription. Idempotent. A no-op once the observed node is
 * disposed (disposing the handle, or `destroy()`, already drops its hooks).
 */
export type Unobserve = () => void;

/** Anything carrying a node identity that the introspection surface can read. */
export type ReactiveHandle = Signal<any> | Computed<any> | SignalBox<any> | ComputedBox<any>;

// --- Graph-mutation hook (1.2.1) ----------------------------------------------

/**
 * Opcode passed as the first argument to a {@link GraphMutationListener}.
 *
 *  - `1` node create.    `(intA, intB) = (node.id, node.flags)`. Nodes made by
 *                        `signalBox` / `computedBox` carry bit 7 (`128`, FLAG_BOX) in
 *                        `flags`, e.g. `160` / `129` (1.6.0); the same holds for op `2`.
 *  - `2` node dispose.   `(intA, intB) = (node.id, node.flags)` -- fires for every node
 *                        disposed, including cascaded owner-tree children. `flags` can
 *                        carry bit 6 (`1 << 6`, the internal stale-read mark, 1.6.0) when
 *                        a node that a write flagged mid-run is disposed before the flag
 *                        clears (still mid-run, or after that run threw);
 *                        op `1` never carries it. Box nodes carry `128` (see op `1`).
 *  - `3` link add.       `(intA, intB) = (source.id, target.id)` -- since 1.6.0 emitted only
 *                        for an edge that still exists when it fires (an `onConnect` hook
 *                        that removed the new edge, by disposing either endpoint,
 *                        suppresses it). Also emitted when an `onConnect` hook throws
 *                        without disposing either endpoint (the edge stays live): after
 *                        the hook and before its error propagates. Op `2` (node disposed)
 *                        implies the node's subscriber edges are gone; no per-edge op `4`
 *                        is emitted for them (bench/soak/mirror.mjs rule I3).
 *  - `4` link remove.    `(intA, intB) = (source.id, target.id)`.
 *  - `5` recompute.      `(intA, intB) = (node.id, 0)` -- fires just before an effect
 *                        re-run or a computed re-eval.
 */
export type GraphMutationOpcode = 1 | 2 | 3 | 4 | 5;

/**
 * Listener registered with {@link Registry.onGraphMutation}. Called synchronously
 * inside each mutation point with three integers -- no objects allocated.
 *
 * **Contract: observe only.** Listeners MUST NOT throw and MUST NOT mutate the
 * graph from inside the callback. Both will corrupt the engine's state. Wrap any
 * downstream work in a microtask if it could touch the registry.
 */
export type GraphMutationListener = (opcode: GraphMutationOpcode, intA: number, intB: number) => void;

/** Idempotent unsubscriber returned by {@link Registry.onGraphMutation}. */
export type GraphMutationUnsubscribe = () => void;

// --- Errors -------------------------------------------------------------------

/** Thrown when a pool ceiling is hit. */
export class CapacityError extends Error {
    readonly name: "CapacityError";
    readonly kind: "nodes" | "links";
    readonly capacity: number;
    constructor(kind: "nodes" | "links", capacity: number);
}

// --- Registry -----------------------------------------------------------------

export interface RegistryConfig {
    /** Initial node-pool capacity (a ledger under `prealloc: "lazy"`). Default: 1024. */
    maxNodes?: number;
    /** Initial link-pool capacity (a ledger under `prealloc: "lazy"`). Default: `maxNodes * 4`. */
    maxLinks?: number;
    /**
     * Pool population strategy. Default: `"eager"`.
     *  - `"eager"`: construct the full `maxNodes` / `maxLinks` pools up front.
     *    Deterministic latency -- zero allocation inside any subsequent hot path
     *    (the contract for render loops, game ticks, and extension frame budgets),
     *    at the cost of a larger resident heap that every major GC traces.
     *  - `"lazy"`: treat `maxNodes` / `maxLinks` as capacity ledgers and construct
     *    nodes/links on first demand, recycling through the free lists thereafter.
     *    Smaller heap, faster cold start, lighter GC marking; identical zero-GC
     *    steady state after warm-up. Prefer for footprint-sensitive or short-lived
     *    registries.
     */
    prealloc?: "eager" | "lazy";
    /**
     * Behaviour when a pool is exhausted. Default: `"throw"`.
     *  - `"throw"`: throw {@link CapacityError} immediately when the pool is full.
     *  - `"grow"`: extend the pool on demand. Growth is chunked and incremental
     *    (contiguous runs of up to 1024 links / 256 nodes per free-list miss),
     *    not a single doubling burst, so any one growth pause stays bounded. The
     *    capacity ledger still doubles, keeping {@link RegistryStats} semantics
     *    unchanged. Link growth is bounded by a hard ceiling of `maxLinks * 16`.
     */
    onCapacityExceeded?: "throw" | "grow";
    /** Max effect-queue drain passes before a flush-cycle `Error` (message prefixed `"CycleError:"`) is thrown. Default: 100. */
    maxFlushPasses?: number;
}

/** Isolated reactive graph. Created by {@link createRegistry}. */
export interface Registry {
    signal<T>(initial: T, opts?: SignalOptions<T>): Signal<T>;
    computed<T>(fn: () => T, opts?: ComputedOptions<T>): Computed<T>;
    effect(fn: () => void, opts?: EffectOptions): Dispose;
    /** Allocation-light, non-callable signal (1.5.0). See {@link SignalBox}. */
    signalBox<T>(initial: T, opts?: SignalOptions<T>): SignalBox<T>;
    /** Allocation-light, non-callable computed (1.5.0). See {@link ComputedBox}. */
    computedBox<T>(fn: () => T, opts?: ComputedOptions<T>): ComputedBox<T>;
    /**
     * Run `fn` in a detached ownership scope (1.5.0). Effects/computeds created
     * directly in `fn` are NOT adopted by the enclosing owner, so they survive
     * the enclosing effect's re-runs and disposal -- the caller owns their
     * lifecycle (`fn` typically returns a disposer or the created handle). Both
     * ownership and tracking are detached for the duration of `fn`; inner
     * effect/computed bodies still establish their own scopes. The ownership
     * escape hatch for lazily spawning a long-lived node from inside a consumer
     * effect (e.g. a query watcher). Returns whatever `fn` returns.
     */
    createRoot<T>(fn: () => T): T;
    /**
     * Return the currently-active owner as an opaque, gen-stamped handle
     * (`undefined` if called outside any effect/computed body). Companion to
     * {@link runWithOwner}: capture the current lifecycle scope now, restore
     * it later (typically across an async boundary). Introduced in 1.5.0-beta.2.
     *
     * The handle is a plain descriptor object (same shape as {@link describe}
     * returns) stamped with an internal generation counter. It is safe to
     * hold across async boundaries: if the captured owner is disposed and
     * its pool slot is subsequently recycled by an unrelated effect/computed,
     * the generation counter no longer matches and {@link runWithOwner}
     * treats the handle as stale (degrades to rooted execution). This is the
     * ABA guard already used by `describe` / `nodeId` / `forEachOwned`.
     *
     * The handle does NOT keep the owner alive -- it is a snapshot, not a
     * reference. Node lifetime is controlled by the owner tree, not by
     * outstanding handles.
     */
    getOwner(): Owner;
    /**
     * Run `fn` with `ownerHandle` as the current lifecycle owner. Effects
     * or computeds created directly in `fn` are adopted by that owner and
     * cascade-dispose when the owner re-runs or is disposed. Introduced in
     * 1.5.0-beta.2.
     *
     * Degradation semantics for handles that cannot be re-attached:
     * - `null` / `undefined` -> rooted execution (createRoot semantics for
     *   ownership; created children survive, caller disposes them).
     * - stale handle (owner disposed, slot recycled) -> rooted execution.
     *   Never adopts into the unrelated new resident of the recycled slot;
     *   never adopts into a corpse (a disposed owner whose slot is not yet
     *   recycled).
     * - handle for a live signal (not an effect/computed) -> rooted
     *   execution (signals cannot own).
     *
     * Nulls the tracking observer for the duration of `fn` (the same pairing
     * as {@link createRoot}): reads directly inside `fn` do NOT link into any
     * enclosing observer. Inner effect/computed bodies still establish their
     * own owner + observer scopes.
     *
     * Returns whatever `fn` returns.
     */
    runWithOwner<T>(ownerHandle: Owner, fn: () => T): T;
    /**
     * Universal disposal for anything created by this registry: signals,
     * computeds, boxes, or effect dispose handles. Cross-registry calls are
     * silent no-ops (each registry owns its own private node-identity Symbol).
     * Passing an unrelated value is also a safe no-op.
     */
    dispose(api: Disposable): void;
    batch<T>(fn: () => T): T;
    untrack<T>(fn: () => T): T;
    /** True iff a read RIGHT NOW would record a dependency on this registry.
     *  False inside `untrack`, `subscribe` callbacks, `onCleanup` bodies, and
     *  outside any observer. Use for lazy-allocation wrappers like lite-store. */
    isTracking(): boolean;
    /** O(1): does this source have at least one live observer right now? A `peek` does not count. */
    hasObservers(handle: ReactiveHandle): boolean;
    /** Auto-pause hook: fires `onConnect` on the 0->1 observer transition and `onDisconnect`
     *  on 1->0, after registration (transition-only -- no immediate fire if already observed).
     *  Re-tracking a persistently-read source does not churn. Returns an idempotent unobserve.
     *  @throws TypeError if `handle` is not a reactive handle. */
    observeObservers(handle: ReactiveHandle, hooks?: ObserveObserversHooks): Unobserve;
    /** Walk the observers (subscribers) of `handle`, newest-first. No-op on a non-handle. */
    forEachObserver(handle: ReactiveHandle, fn: (descriptor: NodeDescriptor) => void): void;
    /** Walk the sources (dependencies) of `handle`. No-op on a non-handle. */
    forEachSource(handle: ReactiveHandle, fn: (descriptor: NodeDescriptor) => void): void;
    /** Walk the owned children of `handle` -- nodes whose lifetime is bound to this
     *  one by the 1.2 owner tree (1.2.1+). Top-level handles and signals have no
     *  owned children; effects/computeds may own nested observers created inside
     *  their bodies. No-op on a non-handle or stale handle. */
    forEachOwned(handle: ReactiveHandle, fn: (descriptor: NodeDescriptor) => void): void;
    /** Descriptor of `handle`'s owner, or `undefined` for top-level handles, stale
     *  handles, or non-handles (1.2.1+). The owner is the effect or computed inside
     *  whose body `handle` was created -- the node that will cascade-dispose it
     *  on re-run or explicit dispose. */
    ownerOf(handle: ReactiveHandle): NodeDescriptor | undefined;
    /** Stable node id of `handle` (1.1.5+), or undefined for a non-handle or stale handle. */
    nodeId(handle: ReactiveHandle): number | undefined;
    /** The own descriptor of `handle` (1.1.5+), or undefined for a non-handle or stale handle.
     *  Re-walkable: the returned descriptor may be passed back into forEachObserver/
     *  forEachSource/forEachOwned/ownerOf. Descriptors are gen-stamped (1.2.1+): a
     *  descriptor obtained pre-recycle goes stale and walks as undefined post-recycle. */
    describe(handle: ReactiveHandle): NodeDescriptor | undefined;
    /** Register a single graph-mutation listener (1.2.1+). Replaces any existing
     *  listener and returns an unsubscribe that restores the previous one on call.
     *  Listener is invoked synchronously at each mutation point with three integers:
     *  `(opcode, intA, intB)` -- see {@link GraphMutationOpcode}. Cost when no
     *  listener is registered: one branch-predicted `null` check per mutation point.
     *  @throws TypeError if `fn` is not a function or null. */
    onGraphMutation(fn: GraphMutationListener | null): GraphMutationUnsubscribe;
    onCleanup(fn: () => void): void;
    stats(): RegistryStats;
    /** Reset everything: nodes, links, queues, global clock. Outstanding dispose
     *  closures become safe no-ops. Outstanding read/set closures still reference
     *  pool slots -- they will silently misbehave; use a fresh registry afterwards. */
    destroy(): void;
    /**
     * Serialize this registry's live graph to a plain {@link Snapshot} (1.6.0) --
     * in-process time-travel / undo. A cold, one-time walk of the live node pool:
     * every node's value, version, kind, owner, dependency edges, and cache
     * validity are recorded by the stable in-process `node.id`. Compute bodies,
     * equality predicates and schedulers are NOT captured; values are held by
     * reference. Does not perturb the graph or allocate on any hot path.
     *
     * FAILS CLOSED on an unsettled graph: throws `[lite-signal] snapshot: graph not settled (<reason>)`.
     * `(flush/batch/track in progress)`: mid-flush or mid-batch, where a captured
     * cut would be torn, or from inside any running body (effect / computed /
     * watcher), including under `untrack`, `createRoot` and `runWithOwner`.
     * `(dispose in progress)`: inside an `onCleanup` during a dispose or its owner
     * cascade (a handle's dispose, `dispose()`, or `effect()`'s first-run-throw
     * dispose; `destroy()` runs no cleanups). `(onGraphMutation listener running)`:
     * inside an `onGraphMutation` listener. `(scheduled effect run pending)`: while
     * any effect has a scheduled run pending (queued, or its first scheduled run not
     * yet executed) -- so no pending run can be silently lost; a scheduler that never
     * runs its thunk keeps snapshot() refusing until the effect is disposed.
     *
     * NOT captured: custom `equals`, effect schedulers (a restored effect runs
     * synchronously unless re-created with a scheduler), `onCleanup` registrations,
     * lifecycle (`observeObservers`) and `onGraphMutation` listeners.
     */
    snapshot(): Snapshot;
    /**
     * Rebuild a FRESH registry from a {@link Snapshot} (1.6.0). Signals and boxes
     * are restored with their value + version; computeds and effects are
     * re-supplied their compute body from `opts.fnsById` (keyed by snapshot node
     * id) -- a missing fn for any computed/effect FAILS CLOSED. Dependency edges
     * and the owner tree are rebuilt from ids. A CLEAN, evaluated computed is
     * restored with its cached value + deps and marked current (a read is a cache
     * hit); a DIRTY computed is restored with its recorded deps, value, version,
     * error bit, evalVersion and markEpoch, so a read pulls it exactly as live does:
     * the pull walks its deps and runs the body only if a dep moved past its
     * evalVersion (otherwise the seeded value is a cache hit); when the body runs, a
     * result equal to the seeded value (under Object.is -- a custom `equals` is not
     * captured, so a computed built with one may propagate after restore where the
     * live graph would not) does not propagate. A NEVER-EVALUATED computed (version 0)
     * is not seeded; its body runs on its first read. A subsequent `set()` propagates normally. Effects are
     * restored but NOT re-fired -- they run only on the next dependency change;
     * no user side effect runs during restore. Values are restored by reference.
     * After restore, the rebuilt graph runs each effect with the same sequence of values,
     * and leaves every node with the same value or error and the same subscriber / owner
     * order, as the live graph would from the same point; this is a gated
     * property (the seeded live fuzz in test/76: 400 graphs x 3 seeds in `npm test`, 4000
     * x 5 seeds at the A9 close), not a universal law. Limits: cleanup callbacks
     * (`onCleanup`) and a custom `equals` / scheduler are NOT captured, so an effect that
     * registered a cleanup before `snapshot()` has none until its next run (the ORDER of
     * pre-snapshot cleanups is therefore not reproduced); restore copies live state, so it
     * reproduces live as it is now: LEDGER #38 (F6), #41 and #42 are fixed in 1.6.0-dev
     * (FIX-T), so a restored dependency pre-walk no longer rethrows a cached error either,
     * leaving an error state is a change in it too, and a restored dep cycle throws CycleError.
     * A duplicate or dangling id, or an unknown owner id, FAILS CLOSED.
     * Every dep id must exist in the snapshot on EVERY record, including dirty /
     * never-read computeds.
     *
     * restore() validates the whole snapshot before building anything: ids must be
     * positive integers <= 0x3FFFFFFF (2^30 - 1) and unique; dep ids and ownerIds
     * must be positive integers <= 0x3FFFFFFF that resolve to a record id; versions
     * and flags must be int32; the snapshot's `gv`, `nextId` and every record's `evalVersion` / `markEpoch` are required and must be int32 (a missing or non-int32 one throws a TypeError before anything is built); `gv` is never 0, `nextId` may be any 32-bit integer, even at or below a restored id (live's counter wraps), and restore continues ids from it exactly, an effect's `evalVersion` is never 0, a signal's `evalVersion` and `markEpoch` are 0, `clean` must equal (`evalVersion !== 0` and `markEpoch` not modularly ahead of `evalVersion`), and a computed has `evalVersion` 0 exactly when its `version` is 0 (negative stamps after an int32 wrap and any stamp-vs-`gv` order are NOT refused: live reaches them); a signal is never owned; deps must be
     * an array; subPos must be an array with one entry per dep (each an int >= 0,
     * and per source a permutation of 0..n-1); ownerPos must be an int >= -1, exactly
     * -1 when ownerId is null, and per owner a permutation of 0..n-1; a snapshot
     * without subPos / ownerPos is refused; a null / non-object record throws a named TypeError. Snapshots carry
     * live node ids, so a snapshot holding any node id past 0x3FFFFFFF (a node created
     * after the registry's first 2^30 - 1, including in a registry restored at the cap
     * that then grew) snapshots fine but restore() refuses it (fail closed, D-F); once
     * those nodes are disposed, a NEW snapshot of that registry restores again
     * (the old snapshot still holds the id and stays refused). Options must be
     * a plain object with own keys fnsById / handles / config only -- an unknown key
     * throws with a did-you-mean hint; bodies are looked up only as own properties
     * of fnsById. Rejected structures: a signal with deps, an effect as a dep
     * source, a signal as owner, a self owner, owner cycles, and a dep id missing from the snapshot on any record (dirty and
     * never-read computeds included). opts.handles is filled only after the rebuild
     * succeeds; a failed restore leaves it untouched. A snapshot taken after a
     * registry's node-id counter wrapped (ids <= 0) is rejected (fail closed). A dep cycle among clean computeds is NOT refused: live can emit one (a
     * computed whose body catches a CycleError from a partner), and the restored graph reproduces live exactly,
     * including live's own CycleError ("CycleError: Circular dependency detected.") on the next read after a write to a dep (LEDGER #42, fixed in FIX-T; residual: a pool larger than the pre-walk stack limit still overflows the stack with a RangeError first).
     *
     * The snapshot records the registry clock (`gv`), the next node id (`nextId`) and
     * every node's `evalVersion` / `markEpoch`, and restore copies them (the clock and
     * next id exactly), so every freshness check in a restored graph answers as live's
     * does (within the limits above): a restored effect no longer re-fires where live would
     * not, and one that absorbed its own write is still due its re-run. The LIVE 2^31 dormancy band (the 32-bit version wrap) is unchanged and a
     * restore reproduces it; the old restore-only wrap re-fire is gone.
     *
     * The fresh registry is sized to the snapshot (see `opts.config`). Without `opts.config`
     * the fresh registry gets `maxLinks = max(1.5 * L + 16, 4 * maxNodes)` (L = total
     * dep edges); the source registry's `onCapacityExceeded` / `maxFlushPasses` are
     * NOT carried over.
     *
     * Pass `opts.handles` to receive the rebuilt handles keyed by id -- the
     * natural way to wire `fnsById` bodies to the new graph.
     */
    restore(snap: Snapshot, opts?: RestoreOptions): Registry;
}

/**
 * Create an isolated reactive registry.
 *
 * @example
 *   const r = createRegistry({ maxNodes: 4096, onCapacityExceeded: "grow" });
 *   const count = r.signal(0);
 *   r.effect(() => console.log(count()));
 */
export function createRegistry(config?: RegistryConfig): Registry;

/** Replace the default registry backing the top-level helpers. */
export function setDefaultRegistry(registry: Registry): void;

// --- Top-level helpers (delegate to default registry) ------------------------

export function signal<T>(initial: T, opts?: SignalOptions<T>): Signal<T>;
export function computed<T>(fn: () => T, opts?: ComputedOptions<T>): Computed<T>;
/**
 * Create and immediately run an effect. Without `opts.scheduler` the first run happens inside
 * `effect()`, so a never-settling write cycle formed by it throws an `Error` whose message
 * starts `"CycleError:"` from the `effect()` call itself, and the effect is disposed. With a
 * scheduler the first run is the scheduler's: a synchronous scheduler rethrows from `effect()`
 * after disposing the effect, as without one (also when the scheduler itself throws); a
 * deferred one does not throw from `effect()`. Any value the first run throws, `null`
 * included, is rethrown. A write made while another body is mid-run re-runs a reader that
 * already read the old value: a stale effect is re-queued after its run and runs again in the
 * same flush (1.6.0, F-b33-1). Rules and KNOWN exceptions: llms.txt 'Write during an
 * evaluation'. The handle of an effect that disposes itself during its first run is stale:
 * calling it, or `dispose(h)`, is a no-op.
 */
export function effect(fn: () => void, opts?: EffectOptions): Dispose;
/** Allocation-light, non-callable signal (1.5.0), bound to the default registry. See {@link SignalBox}. */
export function signalBox<T>(initial: T, opts?: SignalOptions<T>): SignalBox<T>;
/** Allocation-light, non-callable computed (1.5.0), bound to the default registry. See {@link ComputedBox}. */
export function computedBox<T>(fn: () => T, opts?: ComputedOptions<T>): ComputedBox<T>;
/** Run `fn` in a detached ownership scope (1.5.0), bound to the default registry. See {@link Registry.createRoot}. */
export function createRoot<T>(fn: () => T): T;
/**
 * An owner handle -- an opaque descriptor returned by {@link getOwner},
 * safe to hold across async boundaries. A stale, null, or non-tracker
 * handle degrades cleanly in {@link runWithOwner} (rooted execution)
 * rather than adopting into an unrelated recycled slot. See
 * {@link Registry.getOwner} for the ABA-guard mechanics. 1.5.0-beta.2+.
 */
export type Owner = NodeDescriptor | undefined;
/** Capture the current owner as an opaque, gen-stamped handle (1.5.0-beta.2), bound to the default registry. See {@link Registry.getOwner}. */
export function getOwner(): Owner;
/** Run `fn` under a captured owner handle (1.5.0-beta.2), bound to the default registry. See {@link Registry.runWithOwner}. */
export function runWithOwner<T>(ownerHandle: Owner, fn: () => T): T;
/** Universal disposal -- see {@link Registry.dispose}. */
export function dispose(api: Disposable): void;
export function batch<T>(fn: () => T): T;
export function untrack<T>(fn: () => T): T;
/** Top-level binding of {@link Registry.isTracking} against the default registry. */
export function isTracking(): boolean;
/** Top-level binding of {@link Registry.hasObservers}. */
export function hasObservers(handle: ReactiveHandle): boolean;
/** Top-level binding of {@link Registry.observeObservers}. */
export function observeObservers(handle: ReactiveHandle, hooks?: ObserveObserversHooks): Unobserve;
/** Top-level binding of {@link Registry.forEachObserver}. */
export function forEachObserver(handle: ReactiveHandle, fn: (descriptor: NodeDescriptor) => void): void;
/** Top-level binding of {@link Registry.forEachSource}. */
export function forEachSource(handle: ReactiveHandle, fn: (descriptor: NodeDescriptor) => void): void;
/** Top-level binding of {@link Registry.forEachOwned} (1.2.1+). */
export function forEachOwned(handle: ReactiveHandle, fn: (descriptor: NodeDescriptor) => void): void;
/** Top-level binding of {@link Registry.ownerOf} (1.2.1+). */
export function ownerOf(handle: ReactiveHandle): NodeDescriptor | undefined;
/** Top-level binding of {@link Registry.nodeId}. */
export function nodeId(handle: ReactiveHandle): number | undefined;
/** Top-level binding of {@link Registry.describe}. */
export function describe(handle: ReactiveHandle): NodeDescriptor | undefined;
/** Top-level binding of {@link Registry.onGraphMutation} (1.2.1+). */
export function onGraphMutation(fn: GraphMutationListener | null): GraphMutationUnsubscribe;
export function onCleanup(fn: () => void): void;
export function stats(): RegistryStats;
export function destroy(): void;
/** Serialize the default registry's live graph (1.6.0). See {@link Registry.snapshot}. */
export function snapshot(): Snapshot;
/** Rebuild a fresh registry from a snapshot (1.6.0). See {@link Registry.restore}. */
export function restore(snap: Snapshot, opts?: RestoreOptions): Registry;

/**
 * Configuration options for the watch utility.
 */
export interface WatchOptions {
    /** * If true, fires the callback immediately upon registration
     * with `oldValue` set to `undefined`.
     */
    immediate?: boolean;
}

/**
 * Track a reactive source and run a callback whenever its projected value
 * changes. The callback receives `(newValue, oldValue, stop)` -- the third
 * argument is a dispose function that can be called from inside the callback
 * to terminate the watcher.
 *
 * Internal reads inside the callback are untracked.
 *
 * Uses `Object.is` to guard against the raw-getter case where a dep mutation
 * fires the effect but the projected value is unchanged.
 *
 * The new value is committed as the baseline before the callback runs, so a
 * callback that throws does not leave a stale `oldValue` for the next fire.
 *
 * @param source    Reactive read function.
 * @param callback  Called with the new and previous values plus a stop handle.
 * @param options   `immediate: true` runs the callback once on registration
 *                  with `oldValue = undefined`.
 *
 * @returns Dispose function. Idempotent and safe to call at any time, including
 *          synchronously during the immediate callback. The first call releases
 *          the last observed value, `source`, `callback` and the engine dispose
 *          handle. Called inside `source()`, the callback does not run (stopped
 *          wins). A watcher disposed by its OWNER keeps all four until this
 *          handle is called or dropped, as a raw `effect()` dispose handle
 *          keeps its registry.
 */
export function watch<T>(
    source: () => T,
    callback: (newValue: T, oldValue: T | undefined, stop: () => void) => void,
    options?: { immediate?: boolean }
): () => void;

/**
 * Fire `callback` exactly once when `predicate` first returns a truthy value,
 * then auto-dispose. If `predicate` is already truthy at registration, fires
 * synchronously.
 *
 * @param predicate  Reactive read function; callback fires when truthy.
 * @param callback   Called once when predicate first truthy. Reads inside are untracked.
 * @returns Dispose function. Call before predicate fires to cancel; idempotent.
 *          Once the watcher has fired or been cancelled, the handle holds
 *          nothing of it: `predicate`, `callback` and the engine dispose
 *          handle are released. Cancelled inside `predicate()`, the callback
 *          does not run, even if that run returns truthy (cancel wins).
 *          A callback that throws on a later fire (not at registration) skips
 *          the auto-dispose: the effect stays live and the handle keeps it,
 *          with `predicate` and `callback`, until it is called (same on 1.5.2).
 *          A watcher disposed by its OWNER keeps them until the handle is
 *          called or dropped, as a raw `effect()` dispose handle keeps its
 *          registry.
 */
export function when(
    predicate: () => unknown,
    callback: () => void
): () => void;

/**
 * Promise-returning variant of {@link when}. The returned promise resolves
 * when `predicate` first returns a truthy value.
 *
 * ! **HOT-PATH WARNING -- DO NOT USE PER FRAME.** This function calls
 * `new Promise(...)`, which is a heap allocation (one Promise object plus
 * executor closure plus internal infrastructure per call). Promises require
 * heap allocation by the language spec -- this cost is unavoidable.
 *
 * **Use for:** high-level scene/UI orchestration, boot sequences, awaiting
 * user input or network state, level transitions. Anything that runs once
 * or rarely.
 *
 * **NEVER use for:** per-frame entity updates, render-loop logic, animation
 * tick handlers. For zero-GC hot-path logic use {@link when} with a callback.
 *
 * Note: this promise never rejects. If the predicate never becomes truthy,
 * the promise never settles. Wrap in `Promise.race` for timeout semantics.
 *
 * @param predicate  Reactive read function; resolves promise when truthy.
 * @returns Promise that resolves when predicate first truthy.
 */
export function whenAsync(
    predicate: () => unknown
): Promise<void>;
