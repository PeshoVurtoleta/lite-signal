// ASYNC-GAP RECYCLING HAZARD, exact: LIFO free list means the NEXT node
// created after the owner's disposal reuses the owner's slot.
import {pathToFileURL} from "node:url";

const E = await import(pathToFileURL(process.argv[2]).href);
const r = E.createRegistry({maxNodes: 8, maxLinks: 32, onCapacityExceeded: "grow"});

const sig = r.signal(0);
let captured = null;
const stopA = r.effect(() => {
    captured = r.getOwner();
});   // owner A

stopA();                                        // A dies during the await gap
let strangerRuns = 0;
const stopB = r.effect(() => {
    sig();
    strangerRuns++;
});   // B pops A's slot (LIFO)

let innerRuns = 0;
r.runWithOwner(captured, () => {                // continuation with the stale capture
    r.effect(() => {
        sig();
        innerRuns++;
    });
});
sig.set(1);
const before = innerRuns;                       // want 2

stopB();                                        // dispose the UNRELATED stranger
sig.set(2);
const after = innerRuns;

console.log(`inner runs: before stranger dispose = ${before} (want 2), after = ${after} (want 3)`);
console.log(after === before
    ? "VERDICT: CORRUPTED -- continuation adopted by the recycled slot's new resident; died with a stranger"
    : "VERDICT: SAFE -- stale capture did not bind to the recycled slot");

// Secondary hazard: adoption into a corpse (dead but not yet recycled) = silent leak
const r2 = E.createRegistry();
const sig2 = r2.signal(0);
let cap2 = null;
const stop2 = r2.effect(() => {
    cap2 = r2.getOwner();
});
stop2();                                        // dead, slot NOT yet recycled
let leakRuns = 0;
r2.runWithOwner(cap2, () => {
    r2.effect(() => {
        sig2();
        leakRuns++;
    });
});
sig2.set(1);
console.log(`corpse-adoption: effect created under a DEAD owner runs = ${leakRuns} (2 = alive)`);
console.log(`  active effects per stats: ${r2.stats().effects} -- if owned by a corpse, no cascade can ever reach it (leak until registry destroy)`);
