import { effect, untrack } from "./Signal.js";

/**
 * Sentinel for "first run" — distinguishes a legitimate `undefined` source value
 * from the uninitialized state. Using `Symbol` instead of `undefined` ensures a
 * source like `signal(undefined)` correctly fires `callback(undefined, undefined)`
 * on first change rather than being treated as never-changed.
 * @private
 */
const UNINITIALIZED = Symbol("watch.uninitialized");

/**
 * Track a reactive source and run a callback whenever its value changes.
 *
 * Models Vue's `watch(source, callback)` and MobX's `reaction(predicate, effect)`.
 * The callback is invoked with `(newValue, oldValue)`. Internal reads inside the
 * callback are untracked — they don't create reactive dependencies — so a callback
 * that reads other signals to perform a side-effect won't re-fire when those
 * unrelated signals change.
 *
 * Disposing the returned function detaches the underlying effect and stops the
 * watcher.
 *
 * @example
 *   const count = signal(0);
 *   const stop = watch(count, (next, prev) => {
 *       console.log(`count changed: ${prev} -> ${next}`);
 *   });
 *   count.set(1);  // logs: "count changed: 0 -> 1"
 *   count.set(2);  // logs: "count changed: 1 -> 2"
 *   stop();
 *   count.set(3);  // no log
 *
 * @example
 *   // Immediate fires the callback once on registration with `oldValue = undefined`
 *   watch(count, (next, prev) => console.log(next), { immediate: true });
 *
 * @param {() => T} source        A function that reads reactive values (typically a
 *                                signal/computed getter, or a closure combining several).
 * @param {(newValue: T, oldValue: T | undefined) => void} callback
 *                                Called when the source's value changes. Receives the
 *                                new and previous values. Internal reads are untracked.
 * @param {{ immediate?: boolean }} [options]
 *                                `immediate: true` runs the callback once on registration
 *                                with `oldValue = undefined`. Defaults to false.
 * @returns {() => void}          Dispose function — call to stop watching.
 * @template T
 */
export function watch(source, callback, options) {
    const immediate = options !== undefined && options.immediate === true;
    let oldValue = UNINITIALIZED;

    return effect(() => {
        // Track the source — this read registers the dependency.
        const newValue = source();

        // Invoke the callback without registering further dependencies.
        untrack(() => {
            if (oldValue === UNINITIALIZED) {
                if (immediate) callback(newValue, undefined);
            } else if (!Object.is(newValue, oldValue)) {
                // Guard for raw inline getters: the effect re-runs whenever any read
                // dep changes, but the projected source value may be unchanged. Vue's
                // `watch` and MobX's `reaction` both short-circuit here. Wrapping the
                // source in a `computed` would also suppress this via the equality
                // check inside computed itself; the guard makes that wrapping optional.
                callback(newValue, oldValue);
            }
            oldValue = newValue;
        });
    });
}