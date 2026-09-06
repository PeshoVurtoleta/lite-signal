// profile-create-1to8.mjs
// Standalone reproduction of Andrii's createComputations1to8 row.
// Run with:
//   node --expose-gc --allow-natives-syntax profile-create-1to8.mjs
//
// What it does:
//   1. Warms up JIT on each framework
//   2. Builds N signals as sources
//   3. Times the construction of N computeds (in 1:8 burst pattern, like the harness)
//   4. Optionally prints V8 hidden-class info to confirm H2

import { createRegistry } from "./lite_v120/Signal.js";
import * as alien from "./alien_sigs/esm/index.mjs";

const COUNT  = 100_000;       // total computeds built per pass — matches harness COUNT=1e5
const SCOUNT = COUNT / 8;     // matches harness math for 1to8
const PASSES = 8;             // best-of-N (we report min, which is more stable than median in a noisy VM)
const WARMUPS = 8;            // alien-signals needs ~3 passes to hit TurboFan steady-state

// ----- lite-signal harness shape ----------------------------------------
const liteReg = createRegistry({ maxNodes: 1 << 18, maxLinks: 1 << 22, onCapacityExceeded: "grow" });

function liteBuildSources(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = liteReg.signal(i);
    out[i] = { read: s, write: s.set };
  }
  return out;
}
function liteCreate1to8(n, sources) {
  for (let i = 0; i < n / 8; i++) {
    const get = sources[i].read;
    liteReg.computed(() => get());
    liteReg.computed(() => get());
    liteReg.computed(() => get());
    liteReg.computed(() => get());
    liteReg.computed(() => get());
    liteReg.computed(() => get());
    liteReg.computed(() => get());
    liteReg.computed(() => get());
  }
}

// ----- alien-signals shape ----------------------------------------------
function alienBuildSources(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = alien.signal(i);
  return out;
}
function alienCreate1to8(n, sources) {
  for (let i = 0; i < n / 8; i++) {
    const get = sources[i];
    alien.computed(() => get());
    alien.computed(() => get());
    alien.computed(() => get());
    alien.computed(() => get());
    alien.computed(() => get());
    alien.computed(() => get());
    alien.computed(() => get());
    alien.computed(() => get());
  }
}

// ----- runner ------------------------------------------------------------
function timePass(buildSrc, createFn, count, scount) {
  // Build fresh sources for this pass
  const sources = buildSrc(scount);
  // Warm caches (matches harness)
  for (let i = 0; i < scount; i++) sources[i].read?.() ?? sources[i]();
  globalThis.gc?.();
  globalThis.gc?.();   // double-GC to make sure both young and old gens are clean
  const t0 = performance.now();
  createFn(count, sources);
  const t1 = performance.now();
  return t1 - t0;
}

function warmUp(buildSrc, createFn) {
  for (let i = 0; i < WARMUPS; i++) {
    const small = COUNT / 10;       // bigger warmup body so the create loop body gets TurboFan'd
    const srcCount = small / 8;
    const sources = buildSrc(srcCount);
    for (let i = 0; i < srcCount; i++) sources[i].read?.() ?? sources[i]();
    createFn(small, sources);
  }
  globalThis.gc?.();
  globalThis.gc?.();
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function run(name, buildSrc, createFn) {
  warmUp(buildSrc, createFn);
  const samples = [];
  for (let i = 0; i < PASSES; i++) {
    samples.push(timePass(buildSrc, createFn, COUNT, SCOUNT));
  }
  const m = median(samples);
  const min = Math.min(...samples);
  console.log(
    `${name.padEnd(16)} min=${min.toFixed(2)}ms  median=${m.toFixed(2)}ms  samples=[${samples.map(x => x.toFixed(1)).join(", ")}]`
  );
  return { name, median: m, min, samples };
}

console.log(`-- createComputations1to8 microbench --`);
console.log(`COUNT=${COUNT}  SCOUNT=${SCOUNT}  PASSES=${PASSES}  WARMUPS=${WARMUPS}`);
console.log(`node ${process.version}`);
console.log();

const litR = run("lite-signal", liteBuildSources, liteCreate1to8);
const aliR = run("alien-signals", alienBuildSources, alienCreate1to8);

const ratioMin = litR.min / aliR.min;
console.log();
console.log(`lite/alien ratio (min):    ${ratioMin.toFixed(2)}x   harness reported on 2016 MBP: 14.33x`);

// ----- hidden-class inspection (requires --allow-natives-syntax) --------
const hasNatives = (() => {
  try { new Function("return %HasFastProperties({})")(); return true; } catch { return false; }
})();

if (hasNatives) {
  console.log();
  console.log(`-- Hidden-class inspection (V8 --allow-natives-syntax) --`);
  const sources = liteBuildSources(8);
  const liteSig = sources[0].read;
  const liteCmp = liteReg.computed(() => sources[0].read());

  const aSig = alien.signal(0);
  const aCmp = alien.computed(() => aSig());

  const hasFast = new Function("o", "return %HasFastProperties(o)");

  // Count own props for context
  const ownProps = (o) => Object.getOwnPropertyNames(o).concat(Object.getOwnPropertySymbols(o).map(String));

  console.log(`lite signal read   HasFastProperties: ${hasFast(liteSig)}   ownProps: [${ownProps(liteSig).join(", ")}]`);
  console.log(`lite computed read HasFastProperties: ${hasFast(liteCmp)}   ownProps: [${ownProps(liteCmp).join(", ")}]`);
  console.log(`alien signal       HasFastProperties: ${hasFast(aSig)}    ownProps: [${ownProps(aSig).join(", ")}]`);
  console.log(`alien computed     HasFastProperties: ${hasFast(aCmp)}    ownProps: [${ownProps(aCmp).join(", ")}]`);

  // Cross-instance hidden-class identity check: are two lite computeds the same shape?
  const liteCmp2 = liteReg.computed(() => sources[0].read());
  const aCmp2 = alien.computed(() => aSig());
  const sameMap = new Function("a", "b", "return %HaveSameMap(a, b)");
  console.log();
  console.log(`Two lite computeds  same hidden-class: ${sameMap(liteCmp, liteCmp2)}`);
  console.log(`Two alien computeds same hidden-class: ${sameMap(aCmp, aCmp2)}`);
}

console.log();
console.log("(All times include the create loop body only — sources are prebuilt and cache-warmed.)");
