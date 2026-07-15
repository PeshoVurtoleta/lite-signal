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
export type Disposable<T = unknown> = Signal<T> | Computed<T> | Dispose;

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

/** Stops an {@link Registry.observeObservers} subscription. Idempotent. */
export type Unobserve = () => void;

/** Anything carrying a node identity that the introspection surface can read. */
export type ReactiveHandle = Signal<any> | Computed<any>;

// --- Graph-mutation hook (1.2.1) ----------------------------------------------

/**
 * Opcode passed as the first argument to a {@link GraphMutationListener}.
 *
 *  - `1` node create.    `(intA, intB) = (node.id, node.flags)`.
 *  - `2` node dispose.   `(intA, intB) = (node.id, node.flags)` -- fires for every node
 *                        disposed, including cascaded owner-tree children.
 *  - `3` link add.       `(intA, intB) = (source.id, target.id)`.
 *  - `4` link remove.    `(intA, intB) = (source.id, target.id)` -- `-1` if the link
 *                        was already nulled (defensive, rare).
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
    /**
     * Universal disposal for anything created by this registry: signals,
     * computeds, or effect dispose handles. Cross-registry calls are silent
     * no-ops (each registry owns its own private node-identity Symbol).
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
export function effect(fn: () => void, opts?: EffectOptions): Dispose;
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
 * @param source    Reactive read function.
 * @param callback  Called with the new and previous values plus a stop handle.
 * @param options   `immediate: true` runs the callback once on registration
 *                  with `oldValue = undefined`.
 * @returns Dispose function. Idempotent and safe to call at any time, including
 *          synchronously during the immediate callback.
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
