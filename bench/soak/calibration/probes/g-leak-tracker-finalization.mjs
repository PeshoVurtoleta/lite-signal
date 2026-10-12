// TASK 0g probe: does @zakkster/lite-leak's tracker size() decrement when a tracked target is
// FINALIZED without untrack()? Decides whether tracker.size() or a WeakRef witness is authoritative
// for the soak retention gate. Needs --expose-gc (exit 2 without it). Prints ONE JSON line.
import { createLeakTracker } from '@zakkster/lite-leak';

if (typeof globalThis.gc !== 'function') {
    process.stderr.write('probe: CONFIG -- --expose-gc is required\n');
    process.exit(2);
}
const N = 1000;
const KEEP = 10;
const DRAIN_MS = 2000;
let leaks = 0;
let cleaned = 0;
const tracker = createLeakTracker({ name: 'probe', onLeak: () => { leaks++; } });
const weak = [];
const kept = [];
function fill() {
    for (let i = 0; i < N; i++) {
        const o = { i };
        tracker.track(o, () => { cleaned++; }, 'probe');
        weak.push(new WeakRef(o));
        if (i < KEEP) kept.push(o);
    }
}
fill();
const sizeAfterTrack = tracker.size();
const t0 = performance.now();
let tries = 0;
const alive = () => { let n = 0; for (const w of weak) if (w.deref() !== undefined) n++; return n; };
while (performance.now() - t0 < DRAIN_MS && (tracker.size() > KEEP || alive() > KEEP)) {
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 10));
    tries++;
}
const sizeAfterDrain = tracker.size();
const weakAlive = alive();
// untrack path for contrast
const h = tracker.track({ x: 1 }, () => {}, 'probe');
const sizeBeforeUntrack = tracker.size();
tracker.untrack(h);
const sizeAfterUntrack = tracker.size();
const decrements = sizeAfterDrain === KEEP && weakAlive === KEEP;
process.stdout.write(JSON.stringify({
    probe: 'leak-tracker-finalization',
    leakVersion: (await import('node:fs')).readFileSync(new URL('../../../../node_modules/@zakkster/lite-leak/package.json', import.meta.url), 'utf8').match(/"version":\s*"([^"]+)"/)[1],
    observed: { N, KEEP, sizeAfterTrack, sizeAfterDrain, weakAlive, finalizerCleanups: cleaned, onLeak: leaks, drainTries: tries,
        drainMs: Math.round(performance.now() - t0), sizeBeforeUntrack, sizeAfterUntrack, decrements },
    rule: decrements
        ? 'tracker.size() DOES decrement on finalization without untrack(): size() counts live (uncollected) targets, so size()===0 after a drain is a valid retention witness; the WeakRef count agrees and is kept as the second witness'
        : 'tracker.size() does NOT decrement on finalization: the WeakRef witness is authoritative',
}) + '\n');
void kept;
