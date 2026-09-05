/**
 * Differential retracking fuzzer.
 * --------------------------------
 * Builds the SAME value-dependent dynamic graph in two implementations and
 * asserts they produce identical results under thousands of random writes.
 * This is the strongest guard against retracking regressions: it stresses
 * the exact things unit tests miss — value-dependent topology (deps that
 * appear/disappear based on computed values), double-reads of one source in a
 * single compute, value-dependent read REORDERING, and batched writes.
 *
 * Usage: point REF and CANDIDATE at any two builds (e.g. last release vs the
 * branch under review). A passing run means the candidate's dependency
 * tracking is observably identical to the reference on dynamic graphs.
 *
 *   node --expose-gc retracking.difftest.mjs
 *
 * Wire it into CI by importing your two builds below and asserting exit 0.
 */
import * as REF from "./Signal.js";        // reference (e.g. last shipped)
import * as CANDIDATE from "./futureVersions/Signal_1.3.js";   // build under review

function buildGraph(lib) {
  const W = 8, LAYERS = 4, FAN = 5;
  const srcs = [];
  for (let i = 0; i < W; i++) srcs.push(lib.signal(i + 1));
  let prev = srcs;
  for (let l = 0; l < LAYERS; l++) {
    prev = prev.map((_, idx) => {
      const mine = [];
      for (let f = 0; f < FAN; f++) mine.push(prev[(idx + f) % prev.length]);
      const first = mine[0], tail = mine.slice(1);
      return lib.computed(() => {
        let sum = first();
        const drop = sum & 1;                       // value-dependent removal
        const dropDex = sum % tail.length;
        if (sum & 2) sum += first();                // double-read of one source
        for (let i = 0; i < tail.length; i++) {
          if (drop && i === dropDex) continue;
          sum += tail[i]();
        }
        if (sum & 4)                                // value-dependent reorder
          for (let i = tail.length - 1; i >= 0; i--) sum += tail[i]();
        return sum;
      });
    });
  }
  const agg = lib.computed(() => prev.reduce((a, c) => a + c(), 0));
  let observed = 0;
  lib.effect(() => { observed = agg(); });
  return { srcs, read: () => observed };
}

// Small deterministic PRNG so failures reproduce.
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(label, driver) {
  const r = buildGraph(REF), c = buildGraph(CANDIDATE);
  let agree = 0, disagree = 0, firstFail = null;
  driver(r, c, (step, info) => {
    const a = r.read(), b = c.read();
    if (a === b) agree++;
    else { disagree++; if (!firstFail) firstFail = { step, ...info, ref: a, candidate: b }; }
  });
  console.log(`${label}: ${agree} agree, ${disagree} disagree`);
  if (firstFail) console.log("  first divergence:", JSON.stringify(firstFail));
  return disagree === 0;
}

const rnd = mulberry(12345);
let ok = true;

ok = run("direct writes", (r, c, check) => {
  for (let step = 0; step < 20000; step++) {
    const idx = (rnd() * r.srcs.length) | 0;
    const val = (rnd() * 1000) | 0;
    r.srcs[idx].set(val);
    c.srcs[idx].set(val);
    check(step, { idx, val });
  }
}) && ok;

ok = run("batched writes", (r, c, check) => {
  for (let step = 0; step < 10000; step++) {
    const i1 = (rnd() * r.srcs.length) | 0;
    const i2 = (rnd() * r.srcs.length) | 0;
    const v = (rnd() * 500) | 0;
    REF.batch(() => { r.srcs[i1].set(v); r.srcs[i2].set(v + 1); });
    CANDIDATE.batch(() => { c.srcs[i1].set(v); c.srcs[i2].set(v + 1); });
    check(step, { i1, i2, v });
  }
}) && ok;

console.log(ok ? "\nPASS — candidate matches reference" : "\nFAIL — divergence detected");
process.exit(ok ? 0 : 1);
