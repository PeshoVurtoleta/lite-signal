/**
 * @zakkster/lite-signal — zero-GC reactive graph.
 *
 * Public type surface for the JavaScript implementation in `src/index.js`.
 */

// ─── Options ──────────────────────────────────────────────────────────────────

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

// ─── Reactive primitive shapes ────────────────────────────────────────────────

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

// ─── Diagnostics ──────────────────────────────────────────────────────────────

export interface RegistryStats {
    /** Number of signals created in this registry's lifetime. */
    signals: number;
    /** Number of computeds created in this registry's lifetime. */
    computeds: number;
    /** Number of effects currently alive (decrements on dispose). */
    effects: number;
    /** Number of dependency links currently in use. */
    activeLinks: number;
    /** Number of dependency links available in the pool. */
    pooledLinks: number;
    /** Total link-pool capacity (grows under `"grow"` policy). */
    linkPoolCapacity: number;
    /** Total node-pool capacity (grows under `"grow"` policy). */
    nodePoolCapacity: number;
    /** Number of nodes currently allocated (signals + computeds + alive effects). */
    activeNodes: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when a pool ceiling is hit. */
export class CapacityError extends Error {
    readonly name: "CapacityError";
    readonly kind: "nodes" | "links";
    readonly capacity: number;
    constructor(kind: "nodes" | "links", capacity: number);
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export interface RegistryConfig {
    /** Initial node-pool capacity. Default: 1024. */
    maxNodes?: number;
    /** Initial link-pool capacity. Default: `maxNodes * 4`. */
    maxLinks?: number;
    /**
     * Behaviour when a pool is exhausted:
     *  - `"throw"` (default): throw {@link CapacityError} immediately.
     *  - `"grow"`: double the pool. Links are bounded by `maxLinks * 16`.
     */
    onCapacityExceeded?: "throw" | "grow";
    /** Max effect-queue drain passes before a {@link CycleError} is thrown. Default: 100. */
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
    onCleanup(fn: () => void): void;
    stats(): RegistryStats;
    /** Reset everything: nodes, links, queues, global clock. Outstanding dispose
     *  closures become safe no-ops. Outstanding read/set closures still reference
     *  pool slots — they will silently misbehave; use a fresh registry afterwards. */
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

// ─── Top-level helpers (delegate to default registry) ────────────────────────

export function signal<T>(initial: T, opts?: SignalOptions<T>): Signal<T>;
export function computed<T>(fn: () => T, opts?: ComputedOptions<T>): Computed<T>;
export function effect(fn: () => void, opts?: EffectOptions): Dispose;
/** Universal disposal — see {@link Registry.dispose}. */
export function dispose(api: Disposable): void;
export function batch<T>(fn: () => T): T;
export function untrack<T>(fn: () => T): T;
export function onCleanup(fn: () => void): void;
export function stats(): RegistryStats;


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
 * Track a reactive source and run a callback whenever its evaluated value changes.
 *
 * Models Vue's `watch(source, callback)` and MobX's `reaction(predicate, effect)`.
 * Internal reads inside the callback are untracked — they do not create reactive
 * dependencies.
 *
 * @example
 * const count = signal(0);
 * const stop = watch(() => count() * 2, (next, prev) => {
 * console.log(`Doubled count changed: ${prev} -> ${next}`);
 * });
 * * @param source    A function that reads reactive values (e.g., a signal/computed getter).
 * @param callback  Fired when the source's value changes. Receives the new and previous values.
 * @param options   Optional configuration (e.g., `{ immediate: true }`).
 * @returns         Dispose function — call to stop watching and release the effect.
 */
export function watch<T>(
    source: () => T,
    callback: (newValue: T, oldValue: T | undefined) => void,
    options?: WatchOptions
): () => void;