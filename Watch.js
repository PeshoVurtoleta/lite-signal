import { effect, untrack } from "./Signal.js";

/**
 * Sentinel for "first run" in `watch`. Distinguishes a legitimate `undefined`
 * source value from the uninitialized state -- necessary because a naive
 * `oldValue === undefined` check would conflate them.
 * @private
 */
const UNINITIALIZED = Symbol("watch.uninitialized");

/**
 * Track a reactive source and run a callback whenever its projected value
 * changes. The callback receives `(newValue, oldValue, stop)` -- the third
 * argument is a dispose function that can be called from inside the callback
 * to terminate the watcher (matching MobX's `reaction` ergonomics).
 *
 * Internal reads inside the callback are untracked: a callback that reads
 * other signals to perform side-effects won't re-fire when those unrelated
 * signals change.
 *
 * Uses `Object.is` to guard against the raw-getter case where a dep mutation
 * fires the effect but the projected value is unchanged (e.g.,
 * `watch(() => health() <= 0, ...)` where many `health` changes produce the
 * same boolean). Wrapping the source in a `computed` would achieve the same
 * via the computed's own equality check -- the guard makes that wrapping
 * optional.
 *
 * @example
 *   const count = signal(0);
 *   const stop = watch(count, (next, prev) => console.log(prev, "->", next));
 *   count.set(1);  // logs: 0 -> 1
 *   stop();
 *
 * @example  // Self-disposing on a condition
 *   const status = signal("loading");
 *   watch(status, (next, prev, stop) => {
 *       if (next === "ready") { initialize(); stop(); }
 *   });
 *
 * @example  // Immediate fire
 *   watch(count, (n, p) => render(n), { immediate: true });
 *
 * @param {() => T} source                    Reactive read function.
 * @param {(newValue: T, oldValue: T | undefined, stop: () => void) => void} callback
 * @param {{ immediate?: boolean }} [options] `immediate: true` runs callback
 *                                            once on registration with
 *                                            `oldValue = undefined`.
 * @returns {() => void}                      Dispose function. Idempotent.
 * @template T
 */
export function watch(source, callback, options) {
    const immediate = options !== undefined && options.immediate === true;
    let oldValue = UNINITIALIZED;
    let currentNewValue;            // shared mutable state, read by untrackedFire
    let stopFn = null;
    let wantsStopEarly = false;

    // Late-binding stop handle: safe to call before `stopFn` is assigned (e.g.,
    // synchronously inside the immediate fire), and safe to call multiple times.
    const stop = () => {
        if (stopFn !== null) stopFn();
        else wantsStopEarly = true;
    };

    // ZERO-GC HOT PATH: the untrack body is hoisted into a closure allocated
    // ONCE at registration time. If this were declared inline as
    // `untrack(() => { ... })` inside the effect body, V8 would allocate a
    // fresh closure on every fire -- at 120fps that's 7,200 allocations per
    // minute per watcher. The shared `currentNewValue` variable is the price
    // for keeping the per-fire cost at exactly zero allocations.
    const untrackedFire = () => {
        if (oldValue === UNINITIALIZED) {
            if (immediate) callback(currentNewValue, undefined, stop);
        } else if (!Object.is(currentNewValue, oldValue)) {
            callback(currentNewValue, oldValue, stop);
        }
        oldValue = currentNewValue;
    };

    stopFn = effect(() => {
        currentNewValue = source();
        untrack(untrackedFire);
    });

    // If the immediate callback called stop() before stopFn was assigned,
    // honor it now.
    if (wantsStopEarly) stopFn();
    return stop;
}

/**
 * Fire `callback` exactly once when `predicate` first returns a truthy value,
 * then auto-dispose. If `predicate` is already truthy at registration, fires
 * synchronously and disposes immediately.
 *
 * Models MobX's `when(predicate, effect)` semantics. The returned dispose
 * function can be called to cancel the watcher before it fires (useful for
 * conditional registration that should be revocable).
 *
 * @example  // Trigger on state transition
 *   when(() => user.isAuthenticated, () => redirect("/dashboard"));
 *
 * @example  // Cancellable
 *   const cancel = when(() => slow.ready, () => start());
 *   if (userBacked) cancel();
 *
 * @param {() => unknown} predicate Reactive read function; fired when truthy.
 * @param {() => void} callback     Called once when predicate first truthy.
 *                                  Internal reads are untracked.
 * @returns {() => void}            Dispose function. Idempotent.
 */
export function when(predicate, callback) {
    let stopFn = null;
    let wantsStopEarly = false;
    let fired = false;

    const stop = () => {
        if (stopFn !== null) stopFn();
        else wantsStopEarly = true;
    };

    stopFn = effect(() => {
        // Defense-in-depth: even if dispose timing lets one more evaluation
        // through (e.g., during sync propagation), don't fire twice. In practice
        // stop() disposes this effect before any re-entry, so the early return is
        // unreachable under the engine's self-cycle no-re-run guard -- hence ignored.
        /* c8 ignore next -- unreachable defensive guard; see comment above */
        if (fired) return;
        if (predicate()) {
            fired = true;
            untrack(callback);
            stop();
        }
    });

    if (wantsStopEarly) stopFn();
    return stop;
}

/**
 * Promise-returning variant of {@link when}. The returned promise resolves
 * when `predicate` first returns a truthy value. Composes with `await` for
 * declarative async control flow against reactive state.
 *
 * ! **HOT-PATH WARNING -- DO NOT USE PER FRAME.** This function calls
 * `new Promise(...)`, which is a heap allocation. Every call allocates a
 * Promise object plus its executor closure plus internal Promise infrastructure
 * (resolve function, microtask state). This is unavoidable -- Promises require
 * heap allocation by the language spec.
 *
 * **Use `whenAsync` for:** high-level scene/UI orchestration, boot sequences,
 * waiting for user input, awaiting network state, level transitions. Anything
 * that runs once or rarely.
 *
 * **NEVER use `whenAsync` for:** per-frame entity updates, render-loop logic,
 * animation tick handlers, anywhere that runs at 60/120 fps. The Promise
 * allocations will be visible in GC traces and will cause frame-time spikes
 * under sustained load.
 *
 * **Zero-GC alternative:** use {@link when} with a callback. `when` is
 * allocation-free per evaluation in its hot path (two closures total at
 * registration, zero per predicate check).
 *
 * Note: this promise never rejects. If the predicate never becomes truthy,
 * the promise never settles. Wrap in `Promise.race` for timeout semantics.
 *
 * @example  // OK -- high-level orchestration
 *   await whenAsync(() => user.isAuthenticated);
 *   navigate("/dashboard");
 *
 * @example  // OK -- boot sequence
 *   await whenAsync(() => assets.loaded);
 *   startGame();
 *
 * @example  // NOT OK -- per-frame, allocates a Promise every frame
 *   function animate() {
 *       whenAsync(() => physics.settled).then(render);  // GC pressure!
 *       requestAnimationFrame(animate);
 *   }
 *
 * @example  // Same use case, zero-GC
 *   when(() => physics.settled, render);  // no Promise, no GC pressure
 *
 * @example  // With timeout
 *   await Promise.race([
 *     whenAsync(() => api.ready),
 *     new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))
 *   ]);
 *
 * @param {() => unknown} predicate Reactive read function; resolves promise when truthy.
 * @returns {Promise<void>}         Resolves when predicate first truthy.
 */
export function whenAsync(predicate) {
    return new Promise((resolve) => when(predicate, resolve));
}
