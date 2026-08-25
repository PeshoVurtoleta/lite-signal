// ASYNC-GAP RECYCLING HAZARD, exact: LIFO free list means the NEXT node
// created after the owner's disposal reuses the owner's slot.
//
// 2026-08 audit: promoted from a print-only diagnostic (always exit 0) to a
// PINNED CONTRACT with a real exit code. The 1.5.0 contract, verified live:
//
//   1. RECYCLED SLOT -- a stale owner capture must NOT bind to the recycled
//      slot's new resident. The continuation effect survives the stranger's
//      disposal (gen-stamp guard: capture gen != resident gen).
//   2. CORPSE (dead but not yet recycled) -- runWithOwner on the dead handle
//      DEGRADES TO ROOTED execution: the continuation effect is alive, runs on
//      writes, and ownerOf() reports it UNOWNED (undefined), exactly like a
//      top-level effect. It is NOT adopted by the corpse -- so it is reachable
//      the same way any rooted effect is (explicit dispose / registry destroy),
//      never a silent cascade into a dead subtree.
//
// Any drift from either pin -- adoption by a recycled stranger, adoption by the
// corpse (ownerOf reporting the dead node), or the continuation not running at
// all -- exits 1. A future engine that CHANGES the documented degradation
// (e.g. to a throw) will fail this pin loudly; update the pin with the version
// that changes the contract, not silently.
//
// Usage: node harness/owner-hazard-repro.mjs [engine-path]   (default ../Signal.js)
import {pathToFileURL, fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const enginePath = process.argv[2] || join(HERE, "../Signal.js");
const E = await import(pathToFileURL(enginePath).href);

let failures = 0;
function pin(name, cond, detail) {
    if (!cond) { failures++; console.error(`  PIN FAILED [${name}]: ${detail}`); }
}

/* ── 1. recycled slot: stale capture must not bind to the new resident ────── */
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
pin("recycled-slot-run", before === 2,
    `continuation effect ran ${before} times before the stranger's dispose, want 2`);
pin("recycled-slot-survive", after === before + 1,
    `continuation ran ${after} after disposing the stranger (want ${before + 1}) -- ` +
    `it was adopted by the recycled slot's new resident and died with a stranger`);

/* ── 2. corpse: dead-but-unrecycled owner must degrade to ROOTED ──────────── */
const r2 = E.createRegistry();
const sig2 = r2.signal(0);
let cap2 = null;
const stop2 = r2.effect(() => {
    cap2 = r2.getOwner();
});
stop2();                                        // dead, slot NOT yet recycled
let leakRuns = 0;
let inner2 = null;
r2.runWithOwner(cap2, () => {
    inner2 = r2.effect(() => {
        sig2();
        leakRuns++;
    });
});
sig2.set(1);
// Fail CLOSED on a missing ownerOf: an engine without the introspection cannot
// prove rootedness, and "unverifiable" must not alias the pin's pass value.
const owner2 = typeof r2.ownerOf === "function" ? r2.ownerOf(inner2) : "<engine lacks ownerOf -- unverifiable>";
console.log(`corpse-degradation: effect created under a DEAD owner runs = ${leakRuns} (want 2 = alive), ` +
    `ownerOf = ${JSON.stringify(owner2)} (want undefined = rooted)`);
pin("corpse-alive", leakRuns === 2,
    `continuation under a dead owner ran ${leakRuns} times, want 2 (alive, degraded to rooted)`);
pin("corpse-rooted", owner2 === undefined,
    `continuation is owned by ${JSON.stringify(owner2)} -- adoption into a corpse means no cascade ` +
    `can ever reach it (leak until registry destroy); the contract is rooted degradation`);

/* ── verdict ──────────────────────────────────────────────────────────────── */
if (failures === 0) {
    console.log("VERDICT: SAFE -- stale captures never bind to recycled slots or corpses; degradation is rooted, as documented");
    process.exit(0);
}
console.error(`VERDICT: CONTRACT DRIFT -- ${failures} pin(s) failed (see above)`);
process.exit(1);
