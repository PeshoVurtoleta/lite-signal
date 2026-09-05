// repro-set-after-dispose.mjs
// Demonstrates the latent C1 issue from AUDIT.md:
// A set closure detached BEFORE dispose still mutates the recycled slot.

import { createRegistry } from "/home/claude/lite-v121-work/Signal.js";

const r = createRegistry({ maxNodes: 4, maxLinks: 16, onCapacityExceeded: "grow" });

// === Scenario 1: stale set on disposed signal that hasn't been recycled yet ===
console.log("--- Scenario 1: stale set on disposed slot (not yet recycled) ---");

const s1 = r.signal("alice");
const { set: staleSetA } = s1;   // detach the set handle

console.log("before dispose: s1() =", s1(), "  stats:", r.stats().signals);
r.dispose(s1);
console.log("after dispose:  s1() =", s1(), "  stats:", r.stats().signals);
// dispose() correctly returned. But the stale set still works:
staleSetA("MUTATED");
console.log("after stale set: s1() =", s1());

// === Scenario 2: stale set hits a RECYCLED slot (the actual corruption) ===
console.log("\n--- Scenario 2: stale set hits recycled slot ---");

const s2 = r.signal("original");
const { set: staleSetB } = s2;
r.dispose(s2);

// Recycle the slot. The new resident takes the same ReactiveNode instance
// from the pool. The stale set closure still holds a reference to that same node.
const s3 = r.signal("new resident");
console.log("s3()         =", s3());
console.log("s3.peek()    =", s3.peek());

// Call the stale set from a destroyed handle — does it scribble on s3?
staleSetB("ZOMBIE WRITE");
console.log("after staleSetB('ZOMBIE WRITE') called on disposed s2:");
console.log("s3()         =", s3());
console.log("s3.peek()    =", s3.peek());
// If "ZOMBIE WRITE" appears, the bug is confirmed.

// === Scenario 3: stale set into a recycled COMPUTED slot (worse) ===
console.log("\n--- Scenario 3: stale set hits recycled COMPUTED slot ---");

const s4 = r.signal(100);
const { set: staleSetC } = s4;
r.dispose(s4);

// Force-recycle into a computed
const c1 = r.computed(() => 42);
console.log("c1()         =", c1());
console.log("c1.peek()    =", c1.peek());

staleSetC("CORRUPTING COMPUTED");
console.log("after staleSetC called on disposed s4's set:");
console.log("c1()         =", c1());
console.log("c1.peek()    =", c1.peek());

// === Scenario 4: same but the new resident has live subscribers — is propagation triggered? ===
console.log("\n--- Scenario 4: stale set fires markDownstream on recycled slot's subs ---");

const s5 = r.signal(0);
const { set: staleSetD } = s5;
r.dispose(s5);

// Recycle into a signal that has a downstream effect
const s6 = r.signal("LIVE");
let effectFires = 0;
const stopEff = r.effect(() => { s6(); effectFires++; });
console.log("effectFires after setup =", effectFires);

staleSetD("STALE PROPAGATION");
// If markDownstream walks s6's subs and s6's effect fires, that's full propagation
// from a closure that should have been dead.
console.log("effectFires after stale set =", effectFires);
console.log("s6() =", s6());

stopEff();
