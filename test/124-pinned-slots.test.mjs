// 124-pinned-slots.test.mjs -- b230 U3 B1 (F-b224-1 ALL3x pinned-slot fix): behaviour rows, Part 1.
// Families: A-B225 (census regr), A-R1C (cleanup-arm census + HAZ0), A-SCOPE (+ SNOCALL pair, A-RESET-SCOPE), A-R7 (+ ESW, CTLR7,
// CTLR0c), A-R0-{body,cleanup,direct,arm,prewalk,nothrow} + KNOWN A-R0-F21c. (Part 2 = test/125, a later batch.)
// Oracle: the EXPECTED tables below were generated from the U2 probe runs on the coded build (.handoff/b228/u2/out/*, run from the
// research drivers on the instrumented -I / -Ic copies; fields U2 did not record -- pool / hw / reached of the sched2 and haz0 rows
// -- come from the b230 probe .handoff/b230/u3b1/coded-probe.json, marked below) and diffed against this file's port of the drivers
// (.handoff/b230/u3b1/gen-expected.mjs: 140 rows, 0 differences). Expected values are NOT taken from running the engine under test
// in this file. Before-build values (SPEC ASSERTIONS 1-2) are quoted in each family comment; a row that is green on the before
// build says so ("pin"). Engine under test: env LS_ENGINE (abs path), default ../Signal.js; test/124 against b5289277 =
// LS_ENGINE=.handoff/b228/bcdiff/before-b5289277/Signal.js (its Watch.js beside it). Tuple = { iters, ce, pool, hw, reached, log }
// (see fixtures/b228/shapes.mjs); controls patch a temp copy of the engine through fixtures/b228/stage.mjs (count != 1 FAILS).
// ACCEPTED DEVIATIONS from SPEC (orchestrator ruling b230; evidence .handoff/b230/u3b1/):
//  1 A-R7 thr0 is also red on before (D2 releases the pin at the frame exit): separate rows, revert-before.log.
//  2 HAZ0 (4 variants) sits in A-R1C; the fill variants are red on before (pool 1280), nofill identical: revert-before.log.
//  4 H19 lives in destroy()'s body (reset() keeps the pool): A-RESET-SCOPE teeth use destroy(); reset() is an honest row: coded-probe2.json.
//  5 SNOCALL alone does not rescue P7-in-scope rows (H4 only helps a miss outside a scope): the pair is pinned on P7throw: coded-probe2.json.
//  6 CTLX-* / CTLR1* reach rows belong to test/125 (B2); here they only stage and load.
//  8 hw = combined pinnedHead + scopePinHead high-water from stage.mjs hooks (equal to U2's -I hw on all 140 rows): gen-expected.mjs.
//  9 CTLR7 is reached on C0 / E0 but the rows do not change (released at the next depth-0 point): controls.txt.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, hits } from "./fixtures/b228/stage.mjs";
import { REGR, SCOPE, R1C, censusRow, r1cRow, hazRow, l1pwRow, schedRow, SCHED_ROWS, r7Row, R7_KINDS, resetScopeRow } from "./fixtures/b228/shapes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENG = process.env.LS_ENGINE || join(HERE, "..", "Signal.js");
const cache = new Map();
const eng = (name) => { const k = name || ""; if (!cache.has(k)) cache.set(k, loadEngine(ENG, k)); return cache.get(k); };
const POLS = ["throw", "grow"];
const T = (o) => o;   // tuple literal marker (readability only)
const B225_NAMES = ["P1","P2","P2e","P2c","P3","P3c","P4","P5u","P5r","P5b","P6","P6w1","P6w64","P6w512","P7","P-REUSE","P-NEST","P-NEST2"];
const SCOPE_NAMES = ["P7","P7e","P7run","P7enc","P7nest","P7cross","P7throw","P7cleanup"];
const R1C_NAMES = ["PCL","PCLfirst","PCLeff","PCL-top","PCLeff-top","PCLthrow","PCLthrowE","PCLchild","PCLchildE","PCLchild-make","PCLEfirst","PCLCfirst-throw","PFB","PCLW"];
// EXPECTED (coded 29731ff9), one row per line: key = family/shape/policy; generated from the U2 outputs (see header).
const EXP = {
  "regr/P1/throw": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":2563227136,"nf":15000,"active":1,"growths":0,"err":null,"unpins":10000}},
  "regr/P1/grow": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":2563227136,"nf":15000,"active":1,"growths":0,"err":null,"unpins":10000}},
  "regr/P2/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1612854320,"nf":10000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P2/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1612854320,"nf":10000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P2e/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":775915395,"nf":10001,"active":2,"growths":0,"err":null,"unpins":5000}},
  "regr/P2e/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":775915395,"nf":10001,"active":2,"growths":0,"err":null,"unpins":5000}},
  "regr/P2c/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1476550206,"nf":10002,"active":2,"growths":0,"err":null,"unpins":5000}},
  "regr/P2c/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1476550206,"nf":10002,"active":2,"growths":0,"err":null,"unpins":5000}},
  "regr/P3/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":681753464,"nf":5000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P3/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":681753464,"nf":5000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P3c/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2530587712,"nf":15000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P3c/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2530587712,"nf":15000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P4/throw": {"iters":5000,"ce":null,"pool":1024,"hw":3,"reached":15000,"log":{"ck":23140160,"nf":20000,"active":1,"growths":0,"err":null,"unpins":15000}},
  "regr/P4/grow": {"iters":5000,"ce":null,"pool":1024,"hw":3,"reached":15000,"log":{"ck":23140160,"nf":20000,"active":1,"growths":0,"err":null,"unpins":15000}},
  "regr/P5u/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1612854320,"nf":10000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P5u/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1612854320,"nf":10000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P5r/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1612854320,"nf":10000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P5r/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1612854320,"nf":10000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P5b/throw": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":2563227136,"nf":15000,"active":1,"growths":0,"err":null,"unpins":10000}},
  "regr/P5b/grow": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":2563227136,"nf":15000,"active":1,"growths":0,"err":null,"unpins":10000}},
  "regr/P6/throw": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":1895444931,"nf":15001,"active":2,"growths":0,"err":null,"unpins":10000}},
  "regr/P6/grow": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":1895444931,"nf":15001,"active":2,"growths":0,"err":null,"unpins":10000}},
  "regr/P6w1/throw": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":3825896815,"nf":20001,"active":2,"growths":0,"err":null,"unpins":10000}},
  "regr/P6w1/grow": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":3825896815,"nf":20001,"active":2,"growths":0,"err":null,"unpins":10000}},
  "regr/P6w64/throw": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":4083449653,"nf":15079,"active":2,"growths":0,"err":null,"unpins":10000}},
  "regr/P6w64/grow": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":4083449653,"nf":15079,"active":2,"growths":0,"err":null,"unpins":10000}},
  "regr/P6w512/throw": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":1751942140,"nf":15010,"active":2,"growths":0,"err":null,"unpins":10000}},
  "regr/P6w512/grow": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":1751942140,"nf":15010,"active":2,"growths":0,"err":null,"unpins":10000}},
  "regr/P7/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1489665696,"nf":15000,"active":1,"growths":0,"err":null,"unpins":0}},
  "regr/P7/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1489665696,"nf":15000,"active":1,"growths":0,"err":null,"unpins":0}},
  "regr/P-REUSE/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":3080597080,"nf":15000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P-REUSE/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":3080597080,"nf":15000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "regr/P-NEST/throw": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":414343312,"nf":20000,"active":1,"growths":0,"err":null,"unpins":10000}},
  "regr/P-NEST/grow": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":414343312,"nf":20000,"active":1,"growths":0,"err":null,"unpins":10000}},
  "regr/P-NEST2/throw": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":3342748352,"nf":20000,"active":1,"growths":0,"err":null,"unpins":10000}},
  "regr/P-NEST2/grow": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":3342748352,"nf":20000,"active":1,"growths":0,"err":null,"unpins":10000}},
  "scope/P7/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1489665696,"nf":15000,"active":1,"growths":0,"err":null,"unpins":0}},
  "scope/P7/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":1489665696,"nf":15000,"active":1,"growths":0,"err":null,"unpins":0}},
  "scope/P7e/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":164027539,"nf":15001,"active":2,"growths":0,"err":null,"unpins":0}},
  "scope/P7e/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":164027539,"nf":15001,"active":2,"growths":0,"err":null,"unpins":0}},
  "scope/P7run/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2456670144,"nf":15000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "scope/P7run/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2456670144,"nf":15000,"active":1,"growths":0,"err":null,"unpins":5000}},
  "scope/P7enc/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2869425256,"nf":25000,"active":2,"growths":0,"err":null,"unpins":5000}},
  "scope/P7enc/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2869425256,"nf":25000,"active":2,"growths":0,"err":null,"unpins":5000}},
  "scope/P7nest/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2029464488,"nf":15000,"active":1,"growths":0,"err":null,"unpins":0}},
  "scope/P7nest/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2029464488,"nf":15000,"active":1,"growths":0,"err":null,"unpins":0}},
  "scope/P7cross/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2590389440,"nf":25000,"active":1,"growths":0,"err":null,"unpins":0}},
  "scope/P7cross/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2590389440,"nf":25000,"active":1,"growths":0,"err":null,"unpins":0}},
  "scope/P7throw/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":4129670752,"nf":20000,"active":1,"growths":0,"err":null,"unpins":0}},
  "scope/P7throw/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":4129670752,"nf":20000,"active":1,"growths":0,"err":null,"unpins":0}},
  "scope/P7cleanup/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2467752192,"nf":20000,"active":2,"growths":0,"err":null,"unpins":5000}},
  "scope/P7cleanup/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2467752192,"nf":20000,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCL/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2571908299,"nf":15001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCL/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2571908299,"nf":15001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLfirst/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":3262289515,"nf":5001,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLfirst/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":3262289515,"nf":5001,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLeff/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2515369859,"nf":5001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLeff/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2515369859,"nf":5001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCL-top/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2846971824,"nf":15000,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCL-top/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2846971824,"nf":15000,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLeff-top/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":553362920,"nf":5000,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLeff-top/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":553362920,"nf":5000,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLthrow/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2571908299,"nf":15001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLthrow/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2571908299,"nf":15001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLthrowE/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":571935411,"nf":10001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLthrowE/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":571935411,"nf":10001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLchild/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2162882195,"nf":15001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLchild/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":2162882195,"nf":15001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLchildE/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":3519284371,"nf":10001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLchildE/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":3519284371,"nf":10001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLchild-make/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":253735731,"nf":20001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLchild-make/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":253735731,"nf":20001,"active":3,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLEfirst/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":16777619,"nf":1,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLEfirst/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":16777619,"nf":1,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLCfirst-throw/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":3262289515,"nf":5001,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLCfirst-throw/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":3262289515,"nf":5001,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PFB/throw": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":982853851,"nf":15001,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PFB/grow": {"iters":5000,"ce":null,"pool":1024,"hw":1,"reached":5000,"log":{"ck":982853851,"nf":15001,"active":2,"growths":0,"err":null,"unpins":5000}},
  "r1c/PCLW/throw": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":4234580659,"nf":25001,"active":3,"growths":0,"err":null,"unpins":10000}},
  "r1c/PCLW/grow": {"iters":5000,"ce":null,"pool":1024,"hw":2,"reached":10000,"log":{"ck":4234580659,"nf":25001,"active":3,"growths":0,"err":null,"unpins":10000}},
  "haz/effect/true": {"iters":1,"ce":null,"pool":1280,"hw":1,"reached":1,"log":{"before":{"active":1024,"pool":1024},"err":null,"text":"X:run:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | --after flush | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1022}},
  "haz/effect/false": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"before":{"active":3,"pool":1024},"err":null,"text":"X:run:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | --after flush | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1}},
  "haz/computed/true": {"iters":1,"ce":null,"pool":1280,"hw":1,"reached":1,"log":{"before":{"active":1024,"pool":1024},"err":null,"text":"X:run:0 | R:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | R:undefined | --after flush | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1022}},
  "haz/computed/false": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"before":{"active":4,"pool":1024},"err":null,"text":"X:run:0 | R:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | R:undefined | --after flush | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":2}},
  "sched/body-eff/grow": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":3,"Y1":true,"Y2":true}},
  "sched/body-cfirst/grow": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/body-efirst/grow": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/cleanup-eff/grow": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":3,"Y1":true,"Y2":true}},
  "sched/cleanup-cfirst/grow": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/cleanup-efirst/grow": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/direct-eff/grow": {"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":3,"Y1":true,"Y2":true}},
  "sched/direct-cfirst/grow": {"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/direct-efirst/grow": {"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/arm-eff/grow": {"iters":1,"ce":null,"pool":1280,"hw":1,"reached":1,"log":{"err":"arm","text":"X:0 Y:0 Y:1 --after Y:2","active":1024,"Y1":true,"Y2":true}},
  "sched/arm-cfirst/grow": {"iters":1,"ce":null,"pool":1280,"hw":1,"reached":1,"log":{"err":"arm","text":"X:0 Y:0 Y:1 --after Y:2","active":1025,"Y1":true,"Y2":true}},
  "sched/arm-efirst/grow": {"iters":1,"ce":null,"pool":1280,"hw":1,"reached":1,"log":{"err":"arm","text":"X:0 Y:0 Y:1 --after Y:2","active":1025,"Y1":true,"Y2":true}},
  "sched/f21c/grow": {"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":"sched","text":"X:0 X:1 --after X:3","active":3,"X2":false,"X3":true}},
  "sched/nothrow-body/grow": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":null,"text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":3,"Y1":true,"Y2":true}},
  "sched/body-eff/throw": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":3,"Y1":true,"Y2":true}},
  "sched/body-cfirst/throw": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/body-efirst/throw": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/cleanup-eff/throw": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":3,"Y1":true,"Y2":true}},
  "sched/cleanup-cfirst/throw": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/cleanup-efirst/throw": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/direct-eff/throw": {"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":3,"Y1":true,"Y2":true}},
  "sched/direct-cfirst/throw": {"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/direct-efirst/throw": {"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":"sched","text":"X:0 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},
  "sched/arm-eff/throw": {"iters":1,"ce":1,"pool":1024,"hw":1,"reached":1,"log":{"err":"CE:CapacityError: nodes capacity (1024) exc","text":"X:0 --after","active":1023,"Y1":false,"Y2":false}},
  "sched/arm-cfirst/throw": {"iters":1,"ce":1,"pool":1024,"hw":1,"reached":1,"log":{"err":"CE:CapacityError: nodes capacity (1024) exc","text":"X:0 --after","active":1023,"Y1":false,"Y2":false}},
  "sched/arm-efirst/throw": {"iters":1,"ce":1,"pool":1024,"hw":1,"reached":1,"log":{"err":"CE:CapacityError: nodes capacity (1024) exc","text":"X:0 --after","active":1023,"Y1":false,"Y2":false}},
  "sched/f21c/throw": {"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":"sched","text":"X:0 X:1 --after X:3","active":3,"X2":false,"X3":true}},
  "sched/nothrow-body/throw": {"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":null,"text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":3,"Y1":true,"Y2":true}},
  "r7/CW/0/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/CW/0/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/CW/1/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/CW/1/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/EW/0/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/EW/0/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/EW/1/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/EW/1/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/CFB/0/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":3000,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/CFB/0/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":3000,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/CFB/1/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/CFB/1/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/EFB/0/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":3000,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/EFB/0/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":3000,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/EFB/1/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/EFB/1/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/C0/0/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/C0/0/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/C0/1/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/C0/1/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/E0/0/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/E0/0/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/E0/1/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/E0/1/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":3000}},
  "r7/ESW/0/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000,"yRuns":0}},
  "r7/ESW/0/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":0,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000,"yRuns":0}},
  "r7/ESW/1/grow": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000,"yRuns":6000}},
  "r7/ESW/1/throw": {"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000,"yRuns":6000}},
};
const EXP_HAZ = Object.fromEntries(Object.entries(EXP).filter(([k]) => k.startsWith("haz/")));
// probed on the coded build (.handoff/b230/u3b1/coded-probe2.json); reasoning in the family comment.
const SNO = {"throw":{"a":{"a":{"iters":5000,"ce":null,"pool":1024,"hw":1023,"reached":5000,"log":{"ck":4129670752,"nf":20000,"active":1,"growths":0,"err":null,"unpins":0}},"ha":5000,"hb":1023,"h4":1},"b":{"iters":1022,"ce":1022,"pool":1024,"hw":1023,"reached":1023,"log":{"ck":444310765,"nf":4091,"active":1,"growths":0,"err":"CapacityError: nodes capacity (1024) exceeded.","unpins":0}}},"grow":{"a":{"a":{"iters":5000,"ce":null,"pool":1024,"hw":1023,"reached":5000,"log":{"ck":4129670752,"nf":20000,"active":1,"growths":0,"err":null,"unpins":0}},"ha":5000,"hb":5000,"h4":16},"b":{"iters":5000,"ce":null,"pool":5120,"hw":5000,"reached":5000,"log":{"ck":4129670752,"nf":20000,"active":1,"growths":3,"err":null,"unpins":0}}}};
const RST = {"destroy":{"iters":3,"ce":null,"pool":256,"hw":3,"reached":3,"log":{"preActive":1,"prePool":1024,"midActive":0,"midPool":0,"postActive":1,"growths":0,"sig":"function"}},"destroyNoH19":{"iters":3,"ce":null,"pool":0,"hw":3,"reached":3,"log":{"preActive":1,"prePool":1024,"midActive":0,"midPool":0,"postActive":1,"growths":0,"sig":"function"}},"reset":{"iters":3,"ce":null,"pool":1024,"hw":3,"reached":3,"log":{"preActive":1,"prePool":1024,"midActive":0,"midPool":1024,"postActive":1,"growths":0,"sig":"function"}}};
const CTL_ESW = {"throw":{"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000,"yRuns":3000}},"grow":{"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":1024,"active":0,"pins":3000,"unpins":3000,"yRuns":3000}}};
const CTL_R7 = {"throw":{"rows":{"CW":{"iters":1020,"ce":1020,"pool":1024,"hw":1021,"reached":1021,"log":{"errs":1020,"pre":0,"other":"CE","activeIn":1,"poolIn":1024,"active":0,"pins":1021,"unpins":0}},"EW":{"iters":1020,"ce":1020,"pool":1024,"hw":1021,"reached":1021,"log":{"errs":1020,"pre":0,"other":"CE","activeIn":1,"poolIn":1024,"active":0,"pins":1021,"unpins":0}},"CFB":{"iters":1019,"ce":null,"pool":1024,"hw":1020,"reached":1020,"log":{"errs":1019,"pre":0,"other":"cleanups threw before the body could run","activeIn":1,"poolIn":1024,"active":0,"pins":1020,"unpins":0}},"EFB":{"iters":1019,"ce":null,"pool":1024,"hw":1020,"reached":1020,"log":{"errs":1019,"pre":0,"other":"cleanups threw before the body could run","activeIn":1,"poolIn":1024,"active":0,"pins":1020,"unpins":0}},"C0":{"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":0}},"E0":{"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":0}},"ESW":{"iters":1018,"ce":1018,"pool":1024,"hw":1019,"reached":1019,"log":{"errs":1018,"pre":0,"other":"CE","activeIn":1,"poolIn":1024,"active":0,"pins":1019,"unpins":0,"yRuns":2036}}},"reach":{"CW":true,"EW":true,"CFB":true,"EFB":true,"C0":true,"E0":true,"ESW":true}},"grow":{"rows":{"CW":{"iters":3000,"ce":null,"pool":3072,"hw":3000,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":3072,"active":0,"pins":3000,"unpins":0}},"EW":{"iters":3000,"ce":null,"pool":3072,"hw":3000,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":3072,"active":0,"pins":3000,"unpins":0}},"CFB":{"iters":3000,"ce":null,"pool":3072,"hw":3000,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":3072,"active":0,"pins":3000,"unpins":0}},"EFB":{"iters":3000,"ce":null,"pool":3072,"hw":3000,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":3072,"active":0,"pins":3000,"unpins":0}},"C0":{"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":0}},"E0":{"iters":3000,"ce":null,"pool":1024,"hw":1,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":0,"poolIn":1024,"active":0,"pins":3000,"unpins":0}},"ESW":{"iters":3000,"ce":null,"pool":3072,"hw":3000,"reached":3000,"log":{"errs":3000,"pre":0,"other":null,"activeIn":1,"poolIn":3072,"active":0,"pins":3000,"unpins":0,"yRuns":6000}}},"reach":{"CW":true,"EW":true,"CFB":true,"EFB":true,"C0":true,"E0":true,"ESW":true}}};
const CTL_BODY = {"throw":{"sched/body-eff/throw":{"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 --after Y:2","active":3,"Y1":false,"Y2":true}},"sched/body-cfirst/throw":{"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},"sched/body-efirst/throw":{"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 --after Y:2","active":4,"Y1":false,"Y2":true}}},"grow":{"sched/body-eff/grow":{"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 --after Y:2","active":3,"Y1":false,"Y2":true}},"sched/body-cfirst/grow":{"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 Y:1 --after Y:2","active":4,"Y1":true,"Y2":true}},"sched/body-efirst/grow":{"iters":1,"ce":null,"pool":1024,"hw":1,"reached":1,"log":{"err":"sched","text":"X:0 X:1 Y:0 --after Y:2","active":4,"Y1":false,"Y2":true}}}};
// L1-PW: probed on the coded build (.handoff/b230/u3b1/probe3.json); Y:1 delivered per PROGRESS-ALL3 Task 3 L35.
const L1PW = {"throw":{"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":null,"caught":"Error:disc","Y1":true,"Y2":true,"text":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | Y:1 | --after | Y:2","active":5,"links":2}},"grow":{"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":null,"caught":"Error:disc","Y1":true,"Y2":true,"text":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | Y:1 | --after | Y:2","active":5,"links":2}}};
const L1PW_CTL = {"throw":{"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":null,"caught":"Error:disc","Y1":false,"Y2":true,"text":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | --after | Y:2","active":5,"links":2}},"grow":{"iters":1,"ce":null,"pool":1024,"hw":0,"reached":1,"log":{"err":null,"caught":"Error:disc","Y1":false,"Y2":true,"text":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | --after | Y:2","active":5,"links":2}}};


describe("b230 engine loads", () => {
    it("the staged engine loads with the counter hooks (a load failure is a FAIL)", async () => {
        const E = await eng("");
        assert.equal(typeof E.createRegistry, "function");
    });
    it("stage.mjs is count-checked: an anchor that does not match exactly once THROWS (never skips)", async () => {
        const { rep1 } = await import("./fixtures/b228/stage.mjs");
        assert.throws(() => rep1("abc abc", "abc", "x", "twice"), /matched 2 times/);
        assert.throws(() => rep1("abc", "zzz", "x", "never"), /matched 0 times/);
        assert.equal(rep1("abc", "b", "x", "once"), "axc");
    });
});

const table = async (prefix, names, runner, pol) => {
    const E = await eng(""), got = {};
    for (const n of names) got[n] = await runner(E, n, pol);
    return got;
};
const pick = (obj, prefix, names, pol) => { const o = {}; for (const n of names) o[n] = obj[prefix + "/" + n + "/" + pol]; return o; };

// A-B225: the b225 census (5000 iterations each). Coded: every shape 5000 iterations, pool 1024, no CapacityError, hw = the
// shape's own frame depth (P4 3, P6w64 / P6w512 ... see table), "throw" == "grow" checksum on P-REUSE / P-NEST2.
// Before b5289277 (SPEC ASSERTION 1): P1 / P5b / P-NEST CE at 511 (pool 10240 under grow); P2e / P2c / P3c / P7 CE at 1022 (pool 5120).
describe("A-B225 census (pinned slot released at its own frame exit)", () => {
    for (const pol of POLS) it("A-B225 " + pol + ": full tuple of all " + B225_NAMES.length + " shapes", async () => {
        assert.deepEqual(await table("regr", B225_NAMES, (E, n, p) => censusRow(E, REGR, n, p), pol), pick(EXP, "regr", B225_NAMES, pol));
    });
    it("A-B225: P-REUSE / P-NEST2 'throw' checksum == 'grow' (3080597080 / 3342748352, SPEC ASSERTION 1)", async () => {
        const E = await eng("");
        assert.equal(censusRow(E, REGR, "P-REUSE", "throw").log.ck, 3080597080);
        assert.equal(censusRow(E, REGR, "P-REUSE", "grow").log.ck, 3080597080);
        assert.equal(censusRow(E, REGR, "P-NEST2", "throw").log.ck, 3342748352);
        assert.equal(censusRow(E, REGR, "P-NEST2", "grow").log.ck, 3342748352);
    });
});

// A-R1C: cleanup-arm shapes (r1c census), 5000 iterations, pool 1024, hw 1 (PCLW hw 2). Before: PCL CE after 1021 iterations; PCLW CE at 510.
describe("A-R1C census (cleanup arms release their own pin at the arm's exit)", () => {
    for (const pol of POLS) it("A-R1C " + pol + ": full tuple of all " + R1C_NAMES.length + " shapes", async () => {
        assert.deepEqual(await table("r1c", R1C_NAMES, (E, n, p) => r1cRow(E, n, p), pol), pick(EXP, "r1c", R1C_NAMES, pol));
    });
    it("A-R1C HAZ0 (exact-filled pool, X's cleanup arm disposes X then creates Y + child Z): 4 variants, full tuples", async () => {
        const E = await eng(""), got = {};
        for (const k of ["effect", "computed"]) for (const f of [true, false]) got["haz/" + k + "/" + f] = await hazRow(E, k, f);
        assert.deepEqual(got, EXP_HAZ);
    });
});

// A-SCOPE: scope-owner disposal (P7 family). Coded: 5000 iterations, pool 1024, hw 1 (P7throw hw 1). Before: P7 CE at 1022 / pool 5120 under
// grow; P7throw hw 1023.
describe("A-SCOPE census (scope pins released when the last scope owning the node closes)", () => {
    for (const pol of POLS) it("A-SCOPE " + pol + ": full tuple of the P7 family (" + SCOPE_NAMES.length + " shapes)", async () => {
        assert.deepEqual(await table("scope", SCOPE_NAMES, (E, n, p) => censusRow(E, SCOPE, n, p), pol), pick(EXP, "scope", SCOPE_NAMES, pol));
    });
});

// A-SCOPE-SNOCALL (H4 / H18): the control drops runWithOwner's unpinScope call (a simulated overflow at the call), stranding the
// scope pin of every P7throw iteration. With H4 (nodeMiss also releases when only scopePinHead is non-empty) the strand is picked
// up at the next depth-0 miss (pool 1024, hw 1023); with H4 dropped as well it accumulates to CapacityError / pool growth (the
// before-build outcome for P7). Values probed on the coded build (.handoff/b230/u3b1/coded-probe2.json); reach = the SNOCALL hit counter.
describe("A-SCOPE-SNOCALL pair (H18 call dropped; H4 rescues, noH4 does not)", () => {
    for (const pol of POLS) it("A-SCOPE-SNOCALL " + pol + ": SNOCALL rescued by H4; SNOCALL+noH4 accumulates; both reached", async () => {
        const a = censusRow(await eng("SNOCALL"), SCOPE, "P7throw", pol), ha = hits();
        const b = censusRow(await eng("SNOCALL+noH4"), SCOPE, "P7throw", pol), hb = hits();
        assert.deepEqual({ a, ha: ha.SNOCALL, hb: hb.SNOCALL, h4: hb.noH4 }, SNO[pol].a);
        assert.deepEqual(b, SNO[pol].b);
        assert.ok(ha.SNOCALL > 0 && hb.SNOCALL > 0 && hb.noH4 > 0, "controls reached");
        assert.notDeepEqual([a.iters, a.ce, a.pool], [b.iters, b.ce, b.pool], "the verdict flips between the pair (CE iteration under throw, pool under grow)");
    });
});

// A-RESET-SCOPE (H19, probe-first; reset() empties the pool, a ghost scope pin would be handed out): three stranded scope pins
// (SNOCALL), then destroy() + one signal creation. Coded: the creation regrows the pool (256 = U-DESTROY value). noH19: the ghost slot
// is handed out and the pool stays 0. reset() keeps the pool (H19 lives in destroy()'s body): pinned as an honest row.
describe("A-RESET-SCOPE (H19)", () => {
    it("coded + SNOCALL, destroy(): the stranded scope pins are dropped with the pool (pool 256)", async () => {
        assert.deepEqual(resetScopeRow(await eng("SNOCALL"), 3, "destroy"), RST.destroy);
        assert.equal(hits().SNOCALL, 3);
    });
    it("coded + SNOCALL + noH19, destroy(): ghost slot handed out, pool 0 (verdict flips; the dropped statement was reached)", async () => {
        assert.deepEqual(resetScopeRow(await eng("SNOCALL+noH19"), 3, "destroy"), RST.destroyNoH19);
        assert.ok(hits().noH19 > 0, "H19 line reached with a non-empty scope list");
    });
    it("reset() (pool kept): identical with and without H19 (honest row, no teeth claimed)", async () => {
        assert.deepEqual(resetScopeRow(await eng("SNOCALL"), 3, "reset"), RST.reset);
        assert.deepEqual(resetScopeRow(await eng("SNOCALL+noH19"), 3, "reset"), RST.reset);
    });
});

// A-R7: severStale's X disposed by a 1->0 onDisconnect (N = 3000). Coded: thr1 3000 iterations, pool 1024, hw 1, pins == unpins ==
// 3000. Before: pool 3072 under grow, CE at 1019-1020 under throw (thr0 also differs on before: D2 releases the pin at the frame exit).
describe("A-R7 (disposed by the epilogue's onDisconnect)", () => {
    for (const thr of [1, 0]) for (const pol of POLS) it("A-R7 thr" + thr + " " + pol + ": full tuple of " + R7_KINDS.length + " kinds", async () => {
        const E = await eng(""), got = {};
        for (const k of R7_KINDS) got[k] = r7Row(E, k, thr === 1, pol);
        const want = {}; for (const k of R7_KINDS) want[k] = EXP["r7/" + k + "/" + thr + "/" + pol];
        assert.deepEqual(got, want);
    });
    it("A-R7 thr1: pins == unpins == 3000 on every kind that disposes inside the epilogue, both policies", async () => {
        const E = await eng("");
        for (const pol of POLS) for (const k of R7_KINDS) { const r = r7Row(E, k, true, pol); assert.equal(r.log.pins, 3000, k); assert.equal(r.log.unpins, 3000, k); }
    });
});
// A-R7-ESW: R0's holder inside R7 -- scheduler creates effect Y (+ queues it by a write) and rethrows. Coded: yRuns 6000 for 3000
// iterations = y 2 per iteration (Y keeps its queued run), both policies. CTLR0c (drop disposeNode's flushCur null): y 1.
describe("A-R7-ESW", () => {
    for (const pol of POLS) it("A-R7-ESW thr1 " + pol + ": y 2 (yRuns 6000 / 3000 iterations)", async () => {
        const r = r7Row(await eng(""), "ESW", true, pol);
        assert.equal(r.log.yRuns, 6000); assert.equal(r.iters, 3000); assert.equal(r.log.yRuns / r.iters, 2);
        assert.deepEqual(r, EXP["r7/ESW/1/" + pol]);
    });
    for (const pol of POLS) it("A-R7-ESW CTLR0c " + pol + ": y 1 (yRuns 3000), the dropped flushCur null was reached", async () => {
        const r = r7Row(await eng("CTLR0c"), "ESW", true, pol), h = hits();
        assert.deepEqual(r, CTL_ESW[pol]);
        assert.equal(r.log.yRuns / r.iters, 1);
        assert.ok(h.CTLR0c > 0, "CTLR0c reached: " + h.CTLR0c);
    });
});
// A-R7 CTLR7 (drop H1's unpinOwn in severStale's gen-moved arm): thr1 kinds fall back to the before-build leak (pool 3072 under grow,
// CE at 1019-1021 under throw); thr0 kinds are unaffected (D2 releases them). Each thr1 row reaches the dropped statement.
describe("A-R7 CTLR7 (H1 dropped)", () => {
    for (const pol of POLS) it("A-R7 CTLR7 thr1 " + pol + ": the severStale kinds leak; hit counters > 0 on exactly them", async () => {
        const E = await eng("CTLR7"), got = {}, reach = {};
        for (const k of R7_KINDS) { got[k] = r7Row(E, k, true, pol); reach[k] = hits().CTLR7 > 0; }
        assert.deepEqual(got, CTL_R7[pol].rows);
        assert.deepEqual(reach, CTL_R7[pol].reach);
    });
});

// A-R0: flushEffects' catch vs a disposed + recycled entry slot (sched2). Per route (body / cleanup / direct / arm), kinds eff + cfirst +
// efirst (route x kind rows; efirst = Y builds a computed on u in each run). A-R0-prewalk = the research row L-1 pre-walk (locals.mjs L1-PW); nothrow = body route
// with a non-throwing scheduler; f21c = KNOWN (c). Y:1 = Y's first post-throw run happened before t.set returned. Coded: Y:1 on every
// row except f21c and the CapacityError "throw" arm rows. Before (SPEC ASSERTION 2): direct / arm / prewalk Y:1 0 (red); body / cleanup /
// nothrow identical (green pins); f21c identical on every build (KNOWN: full-output deepEqual).
const R0 = (route, kinds, pol) => SCHED_ROWS.filter((r) => r.route === route && kinds.includes(r.kind) && r.pol === pol && !r.noThrow);
async function sched(rows, name) {
    const E = await eng(name), got = {};
    for (const r of rows) got["sched/" + r.id] = schedRow(E, r.route, r.kind, r.pol, r.noThrow);
    return got;
}
const want = (rows) => { const o = {}; for (const r of rows) o["sched/" + r.id] = EXP["sched/" + r.id]; return o; };
describe("A-R0 (R0c: the entry's catch clears QUEUED only while flushCur names the entry's node)", () => {
    for (const pol of POLS) {
        for (const [fam, route, kinds] of [["body", "body", ["eff", "cfirst", "efirst"]], ["cleanup", "cleanup", ["eff", "cfirst", "efirst"]], ["direct", "direct", ["eff", "cfirst", "efirst"]], ["arm", "arm", ["eff", "cfirst", "efirst"]]]) {
            it("A-R0-" + fam + " " + pol + ": full tuples (Y:1 per SPEC ASSERTION 2)", async () => {
                const rows = R0(route, kinds, pol);
                assert.deepEqual(await sched(rows, ""), want(rows));
            });
        }
        it("A-R0-prewalk (L-1) " + pol + ": research row L1-PW (D's sever throws; no scheduler, no arm): Y:1 delivered, full tuple", async () => {
            assert.deepEqual(await l1pwRow(await eng(""), pol), L1PW[pol]);
            assert.equal(L1PW[pol].log.Y1, true);
        });
        it("A-R0-prewalk CTLR0c " + pol + ": the control loses Y:1 (verdict flips), the dropped statement was reached", async () => {
            const r = await l1pwRow(await eng("CTLR0c"), pol), h = hits();
            assert.deepEqual(r, L1PW_CTL[pol]);
            assert.ok(h.CTLR0c > 0, "CTLR0c reached: " + h.CTLR0c);
            assert.notEqual(r.log.Y1, L1PW[pol].log.Y1);
        });
        it("A-R0-nothrow " + pol + ": body route, scheduler does not throw: Y:1 on every build", async () => {
            const rows = SCHED_ROWS.filter((r) => r.noThrow && r.pol === pol);
            assert.deepEqual(await sched(rows, ""), want(rows));
        });
        it("A-R0-F21c (KNOWN (c)) " + pol + ": full output; X:2 does not run before t.set returns, on any build", async () => {
            const rows = SCHED_ROWS.filter((r) => r.route === "f21c" && r.pol === pol);
            assert.deepEqual(await sched(rows, ""), want(rows));
            assert.equal(want(rows)["sched/f21c/" + pol].log.X2, false);
        });
        it("A-R0-body CTLR0c " + pol + ": the control loses Y:1 on the body route (SPEC: CTLR0c body 0); the dropped statement was reached", async () => {
            const rows = R0("body", ["eff", "cfirst", "efirst"], pol);
            const got = await sched(rows, "CTLR0c"), h = hits();
            assert.deepEqual(got, CTL_BODY[pol]);
            assert.ok(h.CTLR0c > 0, "CTLR0c reached");
            assert.notDeepEqual(got["sched/body-eff/" + pol].log.Y1, EXP["sched/body-eff/" + pol].log.Y1, "verdict flips on body-eff");
        });
    }
});

// ---- controls that B2 (test/125) exercises: patch anchors must apply exactly once on this build (a miss FAILS here, early) ----
describe("stage.mjs control anchors (each patch applies once and the patched build loads)", () => {
    for (const c of ["CTLR0c", "CTLR7", "CTLX-NOLOOP", "CTLX-NOPAIR", "CTLR1D", "CTLR1FE", "CTLR1FC", "CTLR1RE", "CTLR1RC", "SNOCALL", "SNOCALL+noH4", "SNOCALL+noH19"])
        it("control " + c + " stages and loads", async () => { assert.equal(typeof (await eng(c)).createRegistry, "function"); });
});
