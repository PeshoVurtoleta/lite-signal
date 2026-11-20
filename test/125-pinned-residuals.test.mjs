// 125-pinned-residuals.test.mjs -- b230 U3 B2 (F-b224-1 ALL3x pinned-slot fix): behaviour rows, Part 2 (Part 1 = test/124).
// Families: A-R1-{HAZ1,FIRST,NEST,UNWIND,UDESTROY}; A-ARM-THROW-{RE,RC,FE,FC}; A-ARM-RESET (+ ZEROARM controls); A-L34 (+ honest
// A-L34-LATCH, no teeth claimed); A-KNOWN-{L6,L7,L21,L21B,L22,L24,L37,L38,R1CAV,R1CAP}; A-INSTR-{O1,O1c,O1f} + firing controls;
// reach rows for B1's CTLX-NOLOOP / CTLX-NOPAIR / CTLR1D / CTLR1{RE,RC,FE,FC}; A-RETAIN. A-ZGC lives in fixtures/b228/gc-child.mjs
// (a --expose-gc --single-threaded child; spawned by the last describe here).
// Oracle: EXP below = the b229 U2 outputs on the coded build (.handoff/b228/u2/out/{probes,new}/*.jsonl, run from the research probes
// on 84068786; the live text 29731ff9 differs only in comments), embedded verbatim by .handoff/b230/u3b2/gen.mjs; the drivers in
// fixtures/b228/instr.mjs are ports of those probes. Control numbers that SPEC ASSERTION 5 gives (5000 / 3000) are quoted; the rest of
// a control's firing set is pinned as measured on the coded-derived control (.handoff/b230/u3b2/ctlprobe*.txt). Engine under test: env
// LS_ENGINE (abs path; its Watch.js beside it), default ../Signal.js. Instrumented rows (A-INSTR, controls, UNDERLYING Ic rows) build
// on the engine text through count-checked anchors: a build whose anchors moved (the before build b5289277) FAILS by anchor miss
// -- that is not teeth, it is the reason those rows are red on before.
// b231 triage (orchestrator; probes in .handoff/b231/triage/, table TRIAGE-b231.md): D1 unwind FE / FC grow 2048 / 2000 = harness shape, not a pin
// (coded pins == unpins, hw 1; the residue is the owned child whose cleanup threw, identical on before). D3 / D4 / D5 / D6 accepted as measured
// (CTLR7 teeth = leak counters, not O1; fclear only where the moved slot is QUEUED-resident). D2 (CTLR1D no flip) -> U4 battery. D7 / D8 / R1CAP-R1CAV fixed
// in b231. Revert mismatches: unwind CYC / throw active 1024 (before 1023) is R7a (coded + CTLR7 reads 1023); A-ARM-RESET coded rows red on before = teeth.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadEngine, hits } from "./fixtures/b228/stage.mjs";
import { loadInstr, loadZeroArm, ihits, haz1Rows, firstRows, nestRows, unwindRows, armResetRows, l21bRows, localsRows } from "./fixtures/b228/instr.mjs";
import { REGR, SCOPE, R1C, censusRow, r1cRow, hazRow, schedRow, SCHED_ROWS, r7Row, R7_KINDS } from "./fixtures/b228/shapes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENG = process.env.LS_ENGINE || join(HERE, "..", "Signal.js");
const EXP = {
  "haz1": [
    {"row":"haz1/effect/fill/Z/grow","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1022,"pool":1280,"ps":null},
    {"row":"haz1/effect/fill/noZ/grow","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | C1:cleanup | X:disposed | Y:run | Y:created | --after | Y:cleanup | Y:disposed-by-test","after":1022,"pool":1280,"ps":null},
    {"row":"haz1/effect/nofill/Z/grow","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"haz1/effect/nofill/noZ/grow","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | C1:cleanup | X:disposed | Y:run | Y:created | --after | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"haz1/computed/fill/Z/grow","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | R:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | R:undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1022,"pool":1280,"ps":null},
    {"row":"haz1/computed/fill/noZ/grow","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | R:0 | C1:cleanup | X:disposed | Y:run | Y:created | R:undefined | --after | Y:cleanup | Y:disposed-by-test","after":1022,"pool":1280,"ps":null},
    {"row":"haz1/computed/nofill/Z/grow","before":{"active":4,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | R:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | R:undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":2,"pool":1024,"ps":null},
    {"row":"haz1/computed/nofill/noZ/grow","before":{"active":4,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | R:0 | C1:cleanup | X:disposed | Y:run | Y:created | R:undefined | --after | Y:cleanup | Y:disposed-by-test","after":2,"pool":1024,"ps":null},
    {"row":"haz1/effect/fill/Z/throw","before":{"active":1024,"pool":1024},"err":"CapacityError","touched":{"Y":false,"Z":false},"log":"X:run:0 | C1:cleanup | X:disposed | --after","after":1023,"pool":1024,"ps":null},
    {"row":"haz1/effect/fill/noZ/throw","before":{"active":1024,"pool":1024},"err":"CapacityError","touched":{"Y":false,"Z":false},"log":"X:run:0 | C1:cleanup | X:disposed | --after","after":1023,"pool":1024,"ps":null},
    {"row":"haz1/effect/nofill/Z/throw","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"haz1/effect/nofill/noZ/throw","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | C1:cleanup | X:disposed | Y:run | Y:created | --after | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"haz1/computed/fill/Z/throw","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | R:0 | C1:cleanup | X:disposed | R:undefined | --after","after":1023,"pool":1024,"ps":null},
    {"row":"haz1/computed/fill/noZ/throw","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | R:0 | C1:cleanup | X:disposed | R:undefined | --after","after":1023,"pool":1024,"ps":null},
    {"row":"haz1/computed/nofill/Z/throw","before":{"active":4,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | R:0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | R:undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":2,"pool":1024,"ps":null},
    {"row":"haz1/computed/nofill/noZ/throw","before":{"active":4,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"X:run:0 | R:0 | C1:cleanup | X:disposed | Y:run | Y:created | R:undefined | --after | Y:cleanup | Y:disposed-by-test","after":2,"pool":1024,"ps":null}
  ],
  "first": [
    {"row":"first/effect/fill/Z/grow","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1022,"pool":1280,"ps":null},
    {"row":"first/effect/fill/noZ/grow","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":1022,"pool":1280,"ps":null},
    {"row":"first/effect/nofill/Z/grow","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"first/effect/nofill/noZ/grow","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"first/computed/fill/Z/grow","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1022,"pool":1280,"ps":null},
    {"row":"first/computed/fill/noZ/grow","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":1022,"pool":1280,"ps":null},
    {"row":"first/computed/nofill/Z/grow","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"first/computed/nofill/noZ/grow","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"first/effect/fill/Z/throw","before":{"active":1024,"pool":1024},"err":"CapacityError","touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | rv=undefined | --after","after":1023,"pool":1024,"ps":null},
    {"row":"first/effect/fill/noZ/throw","before":{"active":1024,"pool":1024},"err":"CapacityError","touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | rv=undefined | --after","after":1023,"pool":1024,"ps":null},
    {"row":"first/effect/nofill/Z/throw","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"first/effect/nofill/noZ/throw","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"first/computed/fill/Z/throw","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | rv=undefined | --after","after":1023,"pool":1024,"ps":null},
    {"row":"first/computed/fill/noZ/throw","before":{"active":1024,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | rv=undefined | --after","after":1023,"pool":1024,"ps":null},
    {"row":"first/computed/nofill/Z/throw","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null},
    {"row":"first/computed/nofill/noZ/throw","before":{"active":3,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"C1:cleanup | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":1,"pool":1024,"ps":null}
  ],
  "nest": [
    {"row":"nest/write/Z/grow","before":{"active":5,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"E2:0 | X:run:0 | X0=0 | C1:cleanup | w | E2:1 | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":3,"pool":1024,"ps":null},
    {"row":"nest/write/noZ/grow","before":{"active":5,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"E2:0 | X:run:0 | X0=0 | C1:cleanup | w | E2:1 | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":3,"pool":1024,"ps":null},
    {"row":"nest/nowrite/Z/grow","before":{"active":5,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"E2:0 | X:run:0 | X0=0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":3,"pool":1024,"ps":null},
    {"row":"nest/nowrite/noZ/grow","before":{"active":5,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"E2:0 | X:run:0 | X0=0 | C1:cleanup | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":3,"pool":1024,"ps":null},
    {"row":"nest/write/Z/throw","before":{"active":5,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"E2:0 | X:run:0 | X0=0 | C1:cleanup | w | E2:1 | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":3,"pool":1024,"ps":null},
    {"row":"nest/write/noZ/throw","before":{"active":5,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"E2:0 | X:run:0 | X0=0 | C1:cleanup | w | E2:1 | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":3,"pool":1024,"ps":null},
    {"row":"nest/nowrite/Z/throw","before":{"active":5,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"E2:0 | X:run:0 | X0=0 | C1:cleanup | X:disposed | Y:run | Z:run | Z=7 | Y:created | rv=undefined | --after | Z()=7 | Z:cleanup | Y:cleanup | Y:disposed-by-test","after":3,"pool":1024,"ps":null},
    {"row":"nest/nowrite/noZ/throw","before":{"active":5,"pool":1024},"err":null,"touched":{"Y":false,"Z":false},"log":"E2:0 | X:run:0 | X0=0 | C1:cleanup | X:disposed | Y:run | Y:created | rv=undefined | --after | Y:cleanup | Y:disposed-by-test","after":3,"pool":1024,"ps":null}
  ],
  "unwind": [
    {"row":"unwind/none/grow","iters":2000,"err":null,"events":0,"pool":1024,"active":0,"ps":null},
    {"row":"unwind/RE/grow","iters":2000,"err":null,"events":2000,"pool":1024,"active":0,"ps":null},
    {"row":"unwind/RC/grow","iters":2000,"err":null,"events":2000,"pool":1024,"active":0,"ps":null},
    {"row":"unwind/FE/grow","iters":2000,"err":null,"events":2000,"pool":2048,"active":2000,"ps":null},
    {"row":"unwind/FC/grow","iters":2000,"err":null,"events":2000,"pool":2048,"active":2000,"ps":null},
    {"row":"unwind/CYC/grow","iters":2000,"err":null,"events":2000,"pool":206080,"active":206000,"ps":null},
    {"row":"unwind/DESTROY/grow","iters":2000,"err":null,"events":1,"pool":256,"active":0,"ps":null},
    {"row":"unwind/none/throw","iters":2000,"err":null,"events":0,"pool":1024,"active":0,"ps":null},
    {"row":"unwind/RE/throw","iters":2000,"err":null,"events":2000,"pool":1024,"active":0,"ps":null},
    {"row":"unwind/RC/throw","iters":2000,"err":null,"events":2000,"pool":1024,"active":0,"ps":null},
    {"row":"unwind/FE/throw","iters":1021,"err":"CapacityError","events":1022,"pool":1024,"active":1024,"ps":null},
    {"row":"unwind/FC/throw","iters":1021,"err":"CapacityError","events":1022,"pool":1024,"active":1024,"ps":null},
    {"row":"unwind/CYC/throw","iters":9,"err":"cleanups threw before the body could run","events":9,"pool":1024,"active":1024,"ps":null},
    {"row":"unwind/DESTROY/throw","iters":2000,"err":null,"events":1,"pool":256,"active":0,"ps":null}
  ],
  "unwindIc": [
    {"row":"unwind/none/grow","iters":2000,"err":null,"events":0,"pool":1024,"active":0,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{},"armMv":{},"missTop":0,"handouts":6000,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/RE/grow","iters":2000,"err":null,"events":2000,"pool":1024,"active":0,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupEffect":2000},"armMv":{},"missTop":0,"handouts":10000,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/RC/grow","iters":2000,"err":null,"events":2000,"pool":1024,"active":0,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupComputed":2000},"armMv":{},"missTop":0,"handouts":10000,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/FE/grow","iters":2000,"err":null,"events":2000,"pool":2048,"active":2000,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupEffect":2000,"firstRunCleanupE":2000},"armMv":{},"missTop":4,"handouts":10000,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/FC/grow","iters":2000,"err":null,"events":2000,"pool":2048,"active":2000,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupComputed":2000,"firstRunCleanupC":2000},"armMv":{},"missTop":4,"handouts":10000,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/CYC/grow","iters":2000,"err":null,"events":2000,"pool":206080,"active":206000,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupEffect":4000,"firstRunCleanupE":4000},"armMv":{},"missTop":801,"handouts":212000,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/DESTROY/grow","iters":2000,"err":null,"events":1,"pool":256,"active":0,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupComputed":1},"armMv":{"rerunCleanupComputed":1},"missTop":1,"handouts":6002,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/none/throw","iters":2000,"err":null,"events":0,"pool":1024,"active":0,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{},"armMv":{},"missTop":0,"handouts":6000,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/RE/throw","iters":2000,"err":null,"events":2000,"pool":1024,"active":0,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupEffect":2000},"armMv":{},"missTop":0,"handouts":10000,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/RC/throw","iters":2000,"err":null,"events":2000,"pool":1024,"active":0,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupComputed":2000},"armMv":{},"missTop":0,"handouts":10000,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}},
    {"row":"unwind/FE/throw","iters":1021,"err":"CapacityError","events":1022,"pool":1024,"active":1024,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupEffect":1022,"firstRunCleanupE":1022},"armMv":{},"missTop":1,"handouts":5109,"releases":0,"released":0,"pins":1021,"unpins":1021,"hw":1,"ce":1}},
    {"row":"unwind/FC/throw","iters":1021,"err":"CapacityError","events":1022,"pool":1024,"active":1024,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupComputed":1022,"firstRunCleanupC":1022},"armMv":{},"missTop":1,"handouts":5109,"releases":0,"released":0,"pins":1021,"unpins":1021,"hw":1,"ce":1}},
    {"row":"unwind/CYC/throw","iters":9,"err":"cleanups threw before the body could run","events":9,"pool":1024,"active":1024,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupEffect":19,"firstRunCleanupE":19},"armMv":{},"missTop":1,"handouts":1051,"releases":0,"released":0,"pins":9,"unpins":9,"hw":1,"ce":1}},
    {"row":"unwind/DESTROY/throw","iters":2000,"err":null,"events":1,"pool":256,"active":0,"ps":{"viol":0,"violSites":{},"violC":0,"violCSites":{},"r1aDo":0,"r1aOwn":0,"armE":{"rerunCleanupComputed":1},"armMv":{"rerunCleanupComputed":1},"missTop":1,"handouts":6002,"releases":0,"released":0,"pins":2000,"unpins":2000,"hw":1,"ce":0}}
  ],
  "armreset": [
    {"row":"armop/none/-/grow","op":"-","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/reset/RE/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/reset/RC/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/reset/FE/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/reset/FC/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/destroy/RE/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/RC/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/FE/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/FC/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/none/-/throw","op":"-","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/reset/RE/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/reset/RC/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/reset/FE/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/reset/FC/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/destroy/RE/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/RC/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/FE/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/FC/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}}
  ],
  "zaReset": [
    {"row":"armop/none/-/grow","op":"-","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/reset/RE/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1024,"Ycreated":true}},
    {"row":"armop/reset/RC/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1024,"Ycreated":true}},
    {"row":"armop/reset/FE/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1024,"Ycreated":true}},
    {"row":"armop/reset/FC/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1024,"Ycreated":true}},
    {"row":"armop/destroy/RE/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/RC/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/FE/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/FC/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/none/-/throw","op":"-","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/reset/RE/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1024,"Ycreated":true}},
    {"row":"armop/reset/RC/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1024,"Ycreated":true}},
    {"row":"armop/reset/FE/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1024,"Ycreated":true}},
    {"row":"armop/reset/FC/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1024,"Ycreated":true}},
    {"row":"armop/destroy/RE/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/RC/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/FE/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}},
    {"row":"armop/destroy/FC/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":512,"Ycreated":true}}
  ],
  "zaDestroy": [
    {"row":"armop/none/-/grow","op":"-","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/reset/RE/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/reset/RC/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/reset/FE/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/reset/FC/grow","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":null,"pool":1280,"Ycreated":true}},
    {"row":"armop/destroy/RE/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":256,"Ycreated":true}},
    {"row":"armop/destroy/RC/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":256,"Ycreated":true}},
    {"row":"armop/destroy/FE/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":256,"Ycreated":true}},
    {"row":"armop/destroy/FC/grow","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":256,"Ycreated":true}},
    {"row":"armop/none/-/throw","op":"-","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/reset/RE/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/reset/RC/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/reset/FE/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/reset/FC/throw","op":"ok","p2":{"before":{"active":1024,"pool":1024},"err":"CapacityError","pool":1024,"Ycreated":false}},
    {"row":"armop/destroy/RE/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":256,"Ycreated":true}},
    {"row":"armop/destroy/RC/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":256,"Ycreated":true}},
    {"row":"armop/destroy/FE/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":256,"Ycreated":true}},
    {"row":"armop/destroy/FC/throw","op":"ok","p2":{"before":{"active":256,"pool":256},"err":null,"pool":256,"Ycreated":true}}
  ],
  "locals": [
    {"row":"L1-PW","pol":"grow","err":null,"caught":"Error:disc","Y1":true,"Y2":true,"defect":false,"log":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | Y:1 | --after | Y:2","stats":{"active":5,"links":2,"pool":1024}},
    {"row":"L34/effect/call/d0","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/call/d1","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/effect/rdispose/d0","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/rdispose/d1","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/computed/rdispose/d0","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/computed/rdispose/d1","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L6-OP2/signal","pol":"grow","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L6-OP2/effect","pol":"grow","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L7-DW/onDisconnect/call","pol":"grow","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/onDisconnect/rdispose","pol":"grow","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L7-DW/op4/call","pol":"grow","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/op4/rdispose","pol":"grow","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L2122-EQ/signal","pol":"grow","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L2122-EQ/box","pol":"grow","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L24-OP1/computed","pol":"grow","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | c:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/effect","pol":"grow","err":null,"zv":5,"mv":"function","zv2":5,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | e:run | made","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/computedBox","pol":"grow","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | cb:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L3738/forEachObserver/norecycle","pol":"grow","err":null,"ids":[3,4,5],"seen":[3],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[5],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachObserver/recycle","pol":"grow","err":null,"ids":[3,4,5],"seen":[3,6],"walkErr":null,"stranger":[6],"skipped":[5],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachSource/norecycle","pol":"grow","err":null,"ids":[2,3,4],"seen":[2],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[4],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachSource/recycle","pol":"grow","err":null,"ids":[2,3,4],"seen":[2,1],"walkErr":null,"stranger":[1],"skipped":[4],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachOwned/norecycle","pol":"grow","err":null,"ids":[5,4,3],"seen":[5,4],"walkErr":null,"stranger":[],"skipped":[3],"defect":true,"log":"","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L3738/forEachOwned/recycle","pol":"grow","err":null,"ids":[5,4,3],"seen":[5,6],"walkErr":null,"stranger":[6],"skipped":[3],"defect":true,"log":"","stats":{"active":5,"links":1,"pool":1024}},
    {"row":"L9-OP4","pol":"grow","err":null,"disc":0,"conn":0,"defect":false,"log":"hook:s-disposed,Y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L1-PW","pol":"throw","err":null,"caught":"Error:disc","Y1":true,"Y2":true,"defect":false,"log":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | Y:1 | --after | Y:2","stats":{"active":5,"links":2,"pool":1024}},
    {"row":"L34/effect/call/d0","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/call/d1","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/effect/rdispose/d0","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/rdispose/d1","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/computed/rdispose/d0","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/computed/rdispose/d1","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L6-OP2/signal","pol":"throw","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L6-OP2/effect","pol":"throw","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L7-DW/onDisconnect/call","pol":"throw","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/onDisconnect/rdispose","pol":"throw","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L7-DW/op4/call","pol":"throw","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/op4/rdispose","pol":"throw","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L2122-EQ/signal","pol":"throw","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L2122-EQ/box","pol":"throw","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L24-OP1/computed","pol":"throw","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | c:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/effect","pol":"throw","err":null,"zv":5,"mv":"function","zv2":5,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | e:run | made","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/computedBox","pol":"throw","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | cb:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L3738/forEachObserver/norecycle","pol":"throw","err":null,"ids":[3,4,5],"seen":[3],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[5],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachObserver/recycle","pol":"throw","err":null,"ids":[3,4,5],"seen":[3,6],"walkErr":null,"stranger":[6],"skipped":[5],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachSource/norecycle","pol":"throw","err":null,"ids":[2,3,4],"seen":[2],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[4],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachSource/recycle","pol":"throw","err":null,"ids":[2,3,4],"seen":[2,1],"walkErr":null,"stranger":[1],"skipped":[4],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachOwned/norecycle","pol":"throw","err":null,"ids":[5,4,3],"seen":[5,4],"walkErr":null,"stranger":[],"skipped":[3],"defect":true,"log":"","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L3738/forEachOwned/recycle","pol":"throw","err":null,"ids":[5,4,3],"seen":[5,6],"walkErr":null,"stranger":[6],"skipped":[3],"defect":true,"log":"","stats":{"active":5,"links":1,"pool":1024}},
    {"row":"L9-OP4","pol":"throw","err":null,"disc":0,"conn":0,"defect":false,"log":"hook:s-disposed,Y-created","stats":{"active":1,"links":0,"pool":1024}}
  ],
  "noloop": [
    {"row":"L1-PW","pol":"grow","err":null,"caught":"Error:disc","Y1":true,"Y2":true,"defect":false,"log":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | Y:1 | --after | Y:2","stats":{"active":5,"links":2,"pool":1024}},
    {"row":"L34/effect/call/d0","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/call/d1","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/effect/rdispose/d0","pol":"grow","err":null,"Yc":true,"zEarly":true,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":false,"activeMid":1,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Z:cleanup | --after | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/rdispose/d1","pol":"grow","err":null,"Yc":true,"zEarly":true,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":false,"activeMid":3,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Z:cleanup | --after | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/computed/rdispose/d0","pol":"grow","err":null,"Yc":true,"zEarly":true,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":false,"activeMid":1,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Z:cleanup | --after | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/computed/rdispose/d1","pol":"grow","err":null,"Yc":true,"zEarly":true,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":false,"activeMid":3,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Z:cleanup | --after | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L6-OP2/signal","pol":"grow","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L6-OP2/effect","pol":"grow","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L7-DW/onDisconnect/call","pol":"grow","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/onDisconnect/rdispose","pol":"grow","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L7-DW/op4/call","pol":"grow","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/op4/rdispose","pol":"grow","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L2122-EQ/signal","pol":"grow","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L2122-EQ/box","pol":"grow","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L24-OP1/computed","pol":"grow","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | c:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/effect","pol":"grow","err":null,"zv":5,"mv":"function","zv2":5,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | e:run | made","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/computedBox","pol":"grow","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | cb:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L3738/forEachObserver/norecycle","pol":"grow","err":null,"ids":[3,4,5],"seen":[3],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[5],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachObserver/recycle","pol":"grow","err":null,"ids":[3,4,5],"seen":[3,6],"walkErr":null,"stranger":[6],"skipped":[5],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachSource/norecycle","pol":"grow","err":null,"ids":[2,3,4],"seen":[2],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[4],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachSource/recycle","pol":"grow","err":null,"ids":[2,3,4],"seen":[2,1],"walkErr":null,"stranger":[1],"skipped":[4],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachOwned/norecycle","pol":"grow","err":null,"ids":[5,4,3],"seen":[5,4],"walkErr":null,"stranger":[],"skipped":[3],"defect":true,"log":"","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L3738/forEachOwned/recycle","pol":"grow","err":null,"ids":[5,4,3],"seen":[5,6],"walkErr":null,"stranger":[6],"skipped":[3],"defect":true,"log":"","stats":{"active":5,"links":1,"pool":1024}},
    {"row":"L9-OP4","pol":"grow","err":null,"disc":0,"conn":0,"defect":false,"log":"hook:s-disposed,Y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L1-PW","pol":"throw","err":null,"caught":"Error:disc","Y1":true,"Y2":true,"defect":false,"log":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | Y:1 | --after | Y:2","stats":{"active":5,"links":2,"pool":1024}},
    {"row":"L34/effect/call/d0","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/call/d1","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/effect/rdispose/d0","pol":"throw","err":null,"Yc":true,"zEarly":true,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":false,"activeMid":1,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Z:cleanup | --after | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/rdispose/d1","pol":"throw","err":null,"Yc":true,"zEarly":true,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":false,"activeMid":3,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Z:cleanup | --after | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/computed/rdispose/d0","pol":"throw","err":null,"Yc":true,"zEarly":true,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":false,"activeMid":1,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Z:cleanup | --after | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/computed/rdispose/d1","pol":"throw","err":null,"Yc":true,"zEarly":true,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":false,"activeMid":3,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Z:cleanup | --after | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L6-OP2/signal","pol":"throw","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L6-OP2/effect","pol":"throw","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L7-DW/onDisconnect/call","pol":"throw","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/onDisconnect/rdispose","pol":"throw","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L7-DW/op4/call","pol":"throw","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/op4/rdispose","pol":"throw","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L2122-EQ/signal","pol":"throw","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L2122-EQ/box","pol":"throw","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L24-OP1/computed","pol":"throw","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | c:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/effect","pol":"throw","err":null,"zv":5,"mv":"function","zv2":5,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | e:run | made","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/computedBox","pol":"throw","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | cb:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L3738/forEachObserver/norecycle","pol":"throw","err":null,"ids":[3,4,5],"seen":[3],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[5],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachObserver/recycle","pol":"throw","err":null,"ids":[3,4,5],"seen":[3,6],"walkErr":null,"stranger":[6],"skipped":[5],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachSource/norecycle","pol":"throw","err":null,"ids":[2,3,4],"seen":[2],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[4],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachSource/recycle","pol":"throw","err":null,"ids":[2,3,4],"seen":[2,1],"walkErr":null,"stranger":[1],"skipped":[4],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachOwned/norecycle","pol":"throw","err":null,"ids":[5,4,3],"seen":[5,4],"walkErr":null,"stranger":[],"skipped":[3],"defect":true,"log":"","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L3738/forEachOwned/recycle","pol":"throw","err":null,"ids":[5,4,3],"seen":[5,6],"walkErr":null,"stranger":[6],"skipped":[3],"defect":true,"log":"","stats":{"active":5,"links":1,"pool":1024}},
    {"row":"L9-OP4","pol":"throw","err":null,"disc":0,"conn":0,"defect":false,"log":"hook:s-disposed,Y-created","stats":{"active":1,"links":0,"pool":1024}}
  ],
  "nopair": [
    {"row":"L1-PW","pol":"grow","err":null,"caught":"Error:disc","Y1":true,"Y2":true,"defect":false,"log":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | Y:1 | --after | Y:2","stats":{"active":5,"links":2,"pool":1024}},
    {"row":"L34/effect/call/d0","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/call/d1","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/effect/rdispose/d0","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":true,"yCleanupAtTest":false,"zCleanupAtTest":true,"activeMid":2,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Y:cleanup | --after | Z:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/rdispose/d1","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":true,"yCleanupAtTest":false,"zCleanupAtTest":true,"activeMid":4,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Y:cleanup | --after | Z:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/computed/rdispose/d0","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":true,"yCleanupAtTest":false,"zCleanupAtTest":true,"activeMid":2,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Y:cleanup | --after | Z:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/computed/rdispose/d1","pol":"grow","err":null,"Yc":true,"zEarly":false,"yEarly":true,"yCleanupAtTest":false,"zCleanupAtTest":true,"activeMid":4,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Y:cleanup | --after | Z:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L6-OP2/signal","pol":"grow","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L6-OP2/effect","pol":"grow","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L7-DW/onDisconnect/call","pol":"grow","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/onDisconnect/rdispose","pol":"grow","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L7-DW/op4/call","pol":"grow","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/op4/rdispose","pol":"grow","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L2122-EQ/signal","pol":"grow","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L2122-EQ/box","pol":"grow","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L24-OP1/computed","pol":"grow","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | c:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/effect","pol":"grow","err":null,"zv":5,"mv":"function","zv2":5,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | e:run | made","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/computedBox","pol":"grow","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | cb:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L3738/forEachObserver/norecycle","pol":"grow","err":null,"ids":[3,4,5],"seen":[3],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[5],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachObserver/recycle","pol":"grow","err":null,"ids":[3,4,5],"seen":[3,6],"walkErr":null,"stranger":[6],"skipped":[5],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachSource/norecycle","pol":"grow","err":null,"ids":[2,3,4],"seen":[2],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[4],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachSource/recycle","pol":"grow","err":null,"ids":[2,3,4],"seen":[2,1],"walkErr":null,"stranger":[1],"skipped":[4],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachOwned/norecycle","pol":"grow","err":null,"ids":[5,4,3],"seen":[5,4],"walkErr":null,"stranger":[],"skipped":[3],"defect":true,"log":"","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L3738/forEachOwned/recycle","pol":"grow","err":null,"ids":[5,4,3],"seen":[5,6],"walkErr":null,"stranger":[6],"skipped":[3],"defect":true,"log":"","stats":{"active":5,"links":1,"pool":1024}},
    {"row":"L9-OP4","pol":"grow","err":null,"disc":0,"conn":0,"defect":false,"log":"hook:s-disposed,Y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L1-PW","pol":"throw","err":null,"caught":"Error:disc","Y1":true,"Y2":true,"defect":false,"log":"X:0 | D:disposedX | Y:0 | D:set-t | s:onDisconnect-throw | Y:1 | --after | Y:2","stats":{"active":5,"links":2,"pool":1024}},
    {"row":"L34/effect/call/d0","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":2,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/call/d1","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":false,"yCleanupAtTest":true,"zCleanupAtTest":true,"activeMid":4,"defect":false,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | --after | Z:cleanup | Y:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/effect/rdispose/d0","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":true,"yCleanupAtTest":false,"zCleanupAtTest":true,"activeMid":2,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Y:cleanup | --after | Z:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/effect/rdispose/d1","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":true,"yCleanupAtTest":false,"zCleanupAtTest":true,"activeMid":4,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Y:cleanup | --after | Z:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L34/computed/rdispose/d0","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":true,"yCleanupAtTest":false,"zCleanupAtTest":true,"activeMid":2,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Y:cleanup | --after | Z:cleanup | Y:disposed-by-test","stats":{"active":0,"links":0,"pool":1024}},
    {"row":"L34/computed/rdispose/d1","pol":"throw","err":null,"Yc":true,"zEarly":false,"yEarly":true,"yCleanupAtTest":false,"zCleanupAtTest":true,"activeMid":4,"defect":true,"log":"C:cleanup | P:re-disposed | Y:run | Z:run | Y:created | Y:cleanup | --after | Z:cleanup | Y:disposed-by-test","stats":{"active":2,"links":1,"pool":1024}},
    {"row":"L6-OP2/signal","pol":"throw","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L6-OP2/effect","pol":"throw","err":null,"activeDelta":-1,"defect":true,"log":"hook:x-re-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L7-DW/onDisconnect/call","pol":"throw","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/onDisconnect/rdispose","pol":"throw","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L7-DW/op4/call","pol":"throw","err":null,"Yc":true,"Y1":true,"defect":false,"log":"X:run | X:re-disposed | Y:0 | --after | Y:1","stats":{"active":4,"links":1,"pool":1024}},
    {"row":"L7-DW/op4/rdispose","pol":"throw","err":null,"Yc":true,"Y1":false,"defect":true,"log":"X:run | X:re-disposed | Y:0 | --after","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L2122-EQ/signal","pol":"throw","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L2122-EQ/box","pol":"throw","err":null,"yv":1,"defect":true,"log":"eq:s-disposed,y-created","stats":{"active":1,"links":0,"pool":1024}},
    {"row":"L24-OP1/computed","pol":"throw","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | c:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/effect","pol":"throw","err":null,"zv":5,"mv":"function","zv2":5,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | e:run | made","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L24-OP1/computedBox","pol":"throw","err":null,"zv":5,"mv":9,"zv2":9,"alias":true,"statsKinds":{"signals":1,"computeds":0,"effects":-1},"defect":true,"log":"hook:O-disposed,z-created | made | cb:run","stats":{"active":2,"links":0,"pool":1024}},
    {"row":"L3738/forEachObserver/norecycle","pol":"throw","err":null,"ids":[3,4,5],"seen":[3],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[5],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachObserver/recycle","pol":"throw","err":null,"ids":[3,4,5],"seen":[3,6],"walkErr":null,"stranger":[6],"skipped":[5],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachSource/norecycle","pol":"throw","err":null,"ids":[2,3,4],"seen":[2],"walkErr":"TypeError:null.gen","stranger":[],"skipped":[4],"defect":true,"log":"","stats":{"active":4,"links":2,"pool":1024}},
    {"row":"L3738/forEachSource/recycle","pol":"throw","err":null,"ids":[2,3,4],"seen":[2,1],"walkErr":null,"stranger":[1],"skipped":[4],"defect":true,"log":"","stats":{"active":5,"links":3,"pool":1024}},
    {"row":"L3738/forEachOwned/norecycle","pol":"throw","err":null,"ids":[5,4,3],"seen":[5,4],"walkErr":null,"stranger":[],"skipped":[3],"defect":true,"log":"","stats":{"active":4,"links":0,"pool":1024}},
    {"row":"L3738/forEachOwned/recycle","pol":"throw","err":null,"ids":[5,4,3],"seen":[5,6],"walkErr":null,"stranger":[6],"skipped":[3],"defect":true,"log":"","stats":{"active":5,"links":1,"pool":1024}},
    {"row":"L9-OP4","pol":"throw","err":null,"disc":0,"conn":0,"defect":false,"log":"hook:s-disposed,Y-created","stats":{"active":1,"links":0,"pool":1024}}
  ],
  "l21b": [
    {"row":"L21/signal/eq1/retfalse/dispose/grow","eqCalls":1,"err":null,"sameSlot":true,"yv":1,"yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/signal/eq1/retfalse/nodispose/grow","eqCalls":1,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/signal/eq1/rettrue/dispose/grow","eqCalls":1,"err":null,"sameSlot":true,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":false},
    {"row":"L21/signal/eq1/rettrue/nodispose/grow","eqCalls":1,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/signal/eq2/retfalse/dispose/grow","eqCalls":2,"err":null,"sameSlot":true,"yv":"Y","yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/signal/eq2/retfalse/nodispose/grow","eqCalls":2,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/signal/eq2/rettrue/dispose/grow","eqCalls":2,"err":null,"sameSlot":true,"yv":"Y","yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/signal/eq2/rettrue/nodispose/grow","eqCalls":2,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/box/eq1/retfalse/dispose/grow","eqCalls":1,"err":null,"sameSlot":true,"yv":1,"yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/box/eq1/retfalse/nodispose/grow","eqCalls":1,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/box/eq1/rettrue/dispose/grow","eqCalls":1,"err":null,"sameSlot":true,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":false},
    {"row":"L21/box/eq1/rettrue/nodispose/grow","eqCalls":1,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/box/eq2/retfalse/dispose/grow","eqCalls":2,"err":null,"sameSlot":true,"yv":"Y","yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/box/eq2/retfalse/nodispose/grow","eqCalls":2,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/box/eq2/rettrue/dispose/grow","eqCalls":2,"err":null,"sameSlot":true,"yv":"Y","yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/box/eq2/rettrue/nodispose/grow","eqCalls":2,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/signal/eq1/retfalse/dispose/throw","eqCalls":1,"err":null,"sameSlot":true,"yv":1,"yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/signal/eq1/retfalse/nodispose/throw","eqCalls":1,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/signal/eq1/rettrue/dispose/throw","eqCalls":1,"err":null,"sameSlot":true,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":false},
    {"row":"L21/signal/eq1/rettrue/nodispose/throw","eqCalls":1,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/signal/eq2/retfalse/dispose/throw","eqCalls":2,"err":null,"sameSlot":true,"yv":"Y","yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/signal/eq2/retfalse/nodispose/throw","eqCalls":2,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/signal/eq2/rettrue/dispose/throw","eqCalls":2,"err":null,"sameSlot":true,"yv":"Y","yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/signal/eq2/rettrue/nodispose/throw","eqCalls":2,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/box/eq1/retfalse/dispose/throw","eqCalls":1,"err":null,"sameSlot":true,"yv":1,"yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/box/eq1/retfalse/nodispose/throw","eqCalls":1,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/box/eq1/rettrue/dispose/throw","eqCalls":1,"err":null,"sameSlot":true,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":false},
    {"row":"L21/box/eq1/rettrue/nodispose/throw","eqCalls":1,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/box/eq2/retfalse/dispose/throw","eqCalls":2,"err":null,"sameSlot":true,"yv":"Y","yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/box/eq2/retfalse/nodispose/throw","eqCalls":2,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null},
    {"row":"L21/box/eq2/rettrue/dispose/throw","eqCalls":2,"err":null,"sameSlot":true,"yv":"Y","yRuns":2,"yRunsAfterSetY2":3,"defect":true},
    {"row":"L21/box/eq2/rettrue/nodispose/throw","eqCalls":2,"err":null,"sameSlot":false,"yv":"Y","yRuns":1,"yRunsAfterSetY2":2,"defect":null}
  ]
};
const cache = new Map();
const eng = (name) => { const k = name || ""; if (!cache.has(k)) cache.set(k, loadEngine(ENG, k)); return cache.get(k); };
const icache = new Map();
const ieng = (kind, ctl) => { const k = kind + "/" + (ctl || ""); if (!icache.has(k)) icache.set(k, loadInstr(ENG, kind, ctl || "")); return icache.get(k); };
const POLS = ["grow", "throw"];
const byPol = (rows, pol) => rows.filter((r) => (r.pol !== undefined ? r.pol : r.row.slice(r.row.lastIndexOf("/") + 1)) === pol);
const hk = () => globalThis.__B230;
const jr = (x) => JSON.parse(JSON.stringify(x));   // an `undefined` field (e.g. yv) is absent in the recorded jsonl
const noPs = (r) => { const o = { ...r }; delete o.ps; return o; };

// ---------------------------------------------------------------- A-R1 (haz1 / firstrun / nestflush / unwind)
describe("A-R1-HAZ1: X's re-run arm disposes X then creates Y (fill = exact-filled pool); coded values (U2)", () => {
  for (const pol of POLS) it("haz1 x " + pol + " (8 rows, full tuple)", async () => { assert.deepEqual(byPol(await haz1Rows(await eng(""), null), pol), byPol(EXP.haz1, pol)); });
});
describe("A-R1-FIRST: the first-run arms (drainPreRun) dispose X then create Y", () => {
  for (const pol of POLS) it("firstrun x " + pol + " (8 rows, full tuple)", async () => { assert.deepEqual(byPol(await firstRows(await eng(""), null), pol), byPol(EXP.first, pol)); });
});
describe("A-R1-NEST: release point (ii), a nested flush at depth 0", () => {
  for (const pol of POLS) it("nestflush x " + pol + " (4 rows, full tuple)", async () => { assert.deepEqual(byPol(await nestRows(await eng(""), null), pol), byPol(EXP.nest, pol)); });
});
describe("A-R1-UNWIND: arm-counter unwind rows (N 2000; a stuck counter would refuse every release)", () => {
  for (const pol of POLS) it("unwind none / RE / RC / FE / FC / CYC x " + pol, async () => {
    const got = byPol(unwindRows(await eng(""), null), pol).filter((r) => !/DESTROY/.test(r.row));
    assert.deepEqual(got, byPol(EXP.unwind, pol).filter((r) => !/DESTROY/.test(r.row)));
  });
});
describe("A-R1-UDESTROY: destroy() inside a re-run cleanup arm: releases never refused afterwards, pool = U2 value (256, M-8)", () => {
  for (const pol of POLS) it("unwind DESTROY x " + pol + " (Ic: full tuple incl. releases / hw)", async () => {
    const Ic = await ieng("Ic", "");
    const got = byPol(unwindRows(Ic.E, Ic), pol).filter((r) => /DESTROY/.test(r.row));
    const want = byPol(EXP.unwindIc, pol).filter((r) => /DESTROY/.test(r.row));
    assert.equal(want.length, 1); assert.equal(want[0].pool, 256);
    assert.deepEqual(got, want);
  });
});
describe("A-R1-UDESTROY-PLAIN", () => {
  for (const pol of POLS) it("UDESTROY plain twin x " + pol + ": iters / err / events / pool / active == coded table (no instrumentation; SPEC: green on before b5289277)", async () => {
    const got = unwindRows(await eng(""), null, 2000, ["DESTROY"]).filter((r) => r.row === "unwind/DESTROY/" + pol);
    const want = EXP.unwind.filter((r) => r.row === "unwind/DESTROY/" + pol);
    assert.equal(got.length, 1); assert.equal(want.length, 1);
    assert.deepEqual(noPs(got[0]), noPs(want[0]));
  });
});
describe("A-ARM-THROW: a throwing cleanup in each arm family leaves armDepth balanced (N 2000; pool 1024, hw 1)", () => {
  for (const F of ["RE", "RC", "FE", "FC"]) for (const pol of POLS) it(F + " x " + pol, async () => {
    const Ic = await ieng("Ic", "");
    const got = byPol(unwindRows(Ic.E, Ic), pol).filter((r) => r.row === "unwind/" + F + "/" + pol);
    const want = byPol(EXP.unwindIc, pol).filter((r) => r.row === "unwind/" + F + "/" + pol);
    assert.equal(want.length, 1); assert.equal(want[0].ps.hw, 1); assert.equal(want[0].ps.pins, want[0].ps.unpins);
    // pool: RE / RC 1024; FE / FC 2048 (grow; the failed first run leaves X alive -- harness shape, active 2000) / CE at 1022 (throw): U2 values, SPEC said 1024
    assert.equal(want[0].pool, (F === "FE" || F === "FC") ? (pol === "grow" ? 2048 : 1024) : 1024);    assert.deepEqual(got, want);
  });
});

// ---------------------------------------------------------------- A-ARM-RESET
describe("A-ARM-RESET: reset() / destroy() inside each arm must not zero armDepth (U2 values); ZEROARM-* controls flip", () => {
  for (const pol of POLS) it("coded x " + pol + " (9 rows)", async () => { assert.deepEqual(byPol(armResetRows(await eng("")), pol), byPol(EXP.armreset, pol)); });
  for (const [name, key] of [["ZEROARM-RESET", "zaReset"], ["ZEROARM-DESTROY", "zaDestroy"]]) it(name + " control: executed, table = U2 measured, differs from coded", async () => {
    const h0 = ihits().ZEROARM;
    const got = armResetRows(await loadZeroArm(ENG, name));
    assert.ok(ihits().ZEROARM > h0, "plant executed");
    assert.deepEqual(got, EXP[key]);
    assert.notDeepEqual(got, EXP.armreset);
  });
});

// ---------------------------------------------------------------- A-L34 / LATCH / controls
describe("A-L34: a cleanup re-disposes its owner and creates Y (+ Z): the outer disposeOwned / runCleanup must not run Y / Z", () => {
  for (const pol of POLS) it("rdispose shapes x " + pol + " (4 rows, full tuple; zEarly / yEarly false)", async () => {
    const got = byPol(await localsRows(await eng("")), pol).filter((r) => /^L34\/.*\/rdispose\//.test(r.row));
    const want = byPol(EXP.locals, pol).filter((r) => /^L34\/.*\/rdispose\//.test(r.row));
    assert.equal(want.length, 4); assert.ok(want.every((r) => r.zEarly === false && r.yEarly === false && r.defect === false));
    assert.deepEqual(got, want);
  });
  it("CTLX-NOLOOP (disposeOwned loop gen test dropped): zEarly 8/8 on the rdispose rows, rows = U2 measured", async () => {
    const got = (await localsRows(await eng("CTLX-NOLOOP"))).filter((r) => /^L34\//.test(r.row));
    assert.deepEqual(got, EXP.noloop.filter((r) => /^L34\//.test(r.row)));
    const rd = got.filter((r) => /rdispose/.test(r.row)); assert.equal(rd.length, 8); assert.equal(rd.filter((r) => r.zEarly === true).length, 8);
    assert.equal(got.filter((r) => r.yEarly === true).length, 0);
  });
  it("CTLX-NOPAIR (disposeNode pair gen test dropped): yEarly 8/8 on the rdispose rows, rows = U2 measured", async () => {
    const got = (await localsRows(await eng("CTLX-NOPAIR"))).filter((r) => /^L34\//.test(r.row));
    assert.deepEqual(got, EXP.nopair.filter((r) => /^L34\//.test(r.row)));
    const rd = got.filter((r) => /rdispose/.test(r.row)); assert.equal(rd.length, 8); assert.equal(rd.filter((r) => r.yEarly === true).length, 8);
    assert.equal(got.filter((r) => r.zEarly === true).length, 0);
  });
});
describe("A-L34-LATCH (honest row, NO teeth claimed: the effect-handle `Ph()` re-dispose is a latched no-op on every build)", () => {
  for (const pol of POLS) it("effect/call x " + pol + " (2 rows)", async () => {
    const got = byPol(await localsRows(await eng("")), pol).filter((r) => /^L34\/effect\/call\//.test(r.row));
    assert.deepEqual(got, byPol(EXP.locals, pol).filter((r) => /^L34\/effect\/call\//.test(r.row)));
  });
});

// ---------------------------------------------------------------- A-KNOWN (full measured defect; KNOWN = still defective by design)
const KNOWN = { L6: /^L6-OP2\//, L7: /^L7-DW\//, L21: /^L2122-EQ\/signal$/, L22: /^L2122-EQ\/box$/, L24: /^L24-OP1\//, L37: /^L3738\/(forEachObserver|forEachSource)\//, L38: /^L3738\/forEachOwned\// };
describe("A-KNOWN: the user-callback LOCALS holders stay KNOWN (full-output deepEqual of the measured defect)", () => {
  for (const [id, re] of Object.entries(KNOWN)) for (const pol of POLS) it(id + " x " + pol, async () => {
    const want = byPol(EXP.locals, pol).filter((r) => re.test(r.row));
    assert.ok(want.length >= 1);
    assert.deepEqual(jr(byPol(await localsRows(await eng("")), pol).filter((r) => re.test(r.row))), want);
  });
  for (const pol of POLS) it("L21B x " + pol + " (second equals inside batch(); 16 rows, yRuns 2 on the disposing rows)", async () => {
    const want = byPol(EXP.l21b, pol);
    assert.equal(want.length, 16);
    assert.deepEqual(jr(byPol(l21bRows(await eng("")), pol)), want);
  });
  // R1-capacity (D-b227-2; PROPOSAL "Residuals after ALL3"): a create inside a cleanup arm with the pool exactly full can no longer
  // reuse the pinned slot (releasePinned refuses while armDepth > 0): "throw" raises CapacityError, "grow" grows a chunk (1024 -> 1280).
  // R1-caveat: under "throw", that CapacityError inside a DISPOSED computed's arm is swallowed with the cleanup's error (err null, Y never runs).
  for (const [id, pol, re, n] of [["R1CAP", "throw", /^haz1\/effect\/fill\//, 2], ["R1CAP", "grow", /\/fill\//, 4], ["R1CAV", "throw", /^haz1\/computed\/fill\//, 2]]) it(id + " x " + pol + " (" + n + " haz1 fill rows)", async () => {
    const want = byPol(EXP.haz1, pol).filter((r) => re.test(r.row));
    assert.equal(want.length, n);
    assert.deepEqual(byPol(await haz1Rows(await eng(""), null), pol).filter((r) => re.test(r.row)), want);
  });
});

// ---------------------------------------------------------------- reach rows for B1's controls (deviation 6)
const hz = (k, kind, z, pol) => k + "/" + kind + "/fill/" + z + "/" + pol;
const FLIPS = {   // rows whose full tuple differs from the coded table (measured on the coded-derived control; every one is in the control's own family)
  CTLR1RE: ["haz1/effect/fill/Z/grow", "haz1/effect/fill/noZ/grow", "haz1/effect/fill/Z/throw", "haz1/effect/fill/noZ/throw"],
  CTLR1RC: ["haz1/computed/fill/Z/grow", "haz1/computed/fill/noZ/grow", "haz1/computed/fill/Z/throw", "haz1/computed/fill/noZ/throw", "nest/write/Z/grow", "nest/write/noZ/grow", "nest/write/Z/throw", "nest/write/noZ/throw"],
  CTLR1FE: ["first/effect/fill/noZ/grow", "first/effect/fill/Z/throw", "first/effect/fill/noZ/throw"],
  CTLR1FC: ["first/computed/fill/noZ/grow", "first/computed/fill/Z/throw", "first/computed/fill/noZ/throw"],
};
describe("CTLR1{RE,RC,FE,FC} (one arm family's armDepth++ dropped): executed; the verdict flips ONLY on that family's haz1 / first / nest rows (noZ grow pool 1280 -> 1024: the arm's node is handed to Y while the arm still holds it)", () => {
  for (const c of Object.keys(FLIPS)) it(c, async () => {
    const E = await eng(c), h0 = hits()[c], diff = [];
    const W = { haz1: EXP.haz1, first: EXP.first, nest: EXP.nest };
    for (const [k, fn] of [["haz1", haz1Rows], ["first", firstRows], ["nest", nestRows]]) for (const r of await fn(E, null)) if (JSON.stringify(r) !== JSON.stringify(W[k].find((x) => x.row === r.row))) diff.push(r.row);
    assert.ok(hits()[c] > h0, c + " plant executed");
    assert.deepEqual(diff, FLIPS[c]);
    const noZ = FLIPS[c].find((x) => /fill\/noZ\/grow$/.test(x));
    const row = (await (noZ.startsWith("haz1") ? haz1Rows : firstRows)(E, null)).find((r) => r.row === noZ);
    assert.equal(EXP[noZ.startsWith("haz1") ? "haz1" : "first"].find((r) => r.row === noZ).pool, 1280); assert.equal(row.pool, 1024);
  });
});
describe("CTLR1D (rerunCleanupEffect catch decrement dropped): REACH only, NO teeth on the coded build", () => {
  // B1's SPEC expectation (releases 0, hw 2000, pool 2048, throw CE at 1022) held on the ALL2 build, where the unwind driver's R7 pins were
  // released ONLY by releasePinned. On the coded build severStale's own release (R7a) frees them, so a stuck armDepth changes no unwind row:
  // pinned here as a measured non-flip (hit 2000 = the plant ran once per RE event; rows = the coded rows; hw 1, pins == unpins).
  it("executed 2000x; RE / grow row == coded row; pins == unpins; hw 1", async () => {
    const h = hk(), ctx = { zero() { h.pins = 0; h.unpins = 0; h.hw = 0; h.hit.CTLR1D = 0; }, x() { return { hw: h.hw, pins: h.pins, unpins: h.unpins, hit: h.hit.CTLR1D }; } };
    const [row] = unwindRows(await eng("CTLR1D"), ctx, 2000, ["RE"]).filter((r) => r.row === "unwind/RE/grow");
    assert.deepEqual(row.ps, { hw: 1, pins: 2000, unpins: 2000, hit: 2000 });
    assert.deepEqual(noPs(row), noPs(EXP.unwind.find((r) => r.row === "unwind/RE/grow")));
  });
});

// ---------------------------------------------------------------- A-INSTR (O1 / O1c / O1f oracles over every family)
const NAMES = { regr: Object.keys(REGR), scope: Object.keys(SCOPE), r1c: Object.keys(R1C) };
let famP = null;
function fams() {
  if (famP) return famP;
  famP = (async () => {
    const Ic = await ieng("Ic", ""), If = await ieng("If", ""), out = {};
    const snap = (id, L) => { const t = L.ps(); return { id, ...t }; };
    for (const [fam, run] of [["regr", (n, pol) => censusRow(Ic.E, REGR, n, pol)], ["scope", (n, pol) => censusRow(Ic.E, SCOPE, n, pol)], ["r1c", (n, pol) => r1cRow(Ic.E, n, pol)]]) {
      out[fam] = []; for (const pol of POLS) for (const n of NAMES[fam]) { Ic.zero(); run(n, pol); out[fam].push(snap(fam + "/" + n + "/" + pol, Ic)); }
    }
    out.haz = []; for (const k of ["effect", "computed"]) for (const f of [true, false]) { Ic.zero(); await hazRow(Ic.E, k, f); out.haz.push(snap("haz/" + k + "/" + f, Ic)); }
    out.r7 = []; for (const k of R7_KINDS) for (const th of [false, true]) for (const pol of POLS) { Ic.zero(); r7Row(Ic.E, k, th, pol); out.r7.push(snap("r7/" + k + "/" + (th ? "thr1" : "thr0") + "/" + pol, Ic)); }
    const pr = []; for (const rows of [await haz1Rows(Ic.E, Ic), await firstRows(Ic.E, Ic), await nestRows(Ic.E, Ic), unwindRows(Ic.E, Ic)]) for (const r of rows) pr.push({ id: r.row, ...r.ps });
    out.probes = pr;
    out.sched = []; for (const r of SCHED_ROWS) { If.zero(); schedRow(If.E, r.route, r.kind, r.pol, r.noThrow); out.sched.push(snap("sched/" + r.id, If)); }
    return out;
  })();
  return famP;
}
const idsOf = (fam) => ({
  regr: POLS.flatMap((p) => NAMES.regr.map((n) => "regr/" + n + "/" + p)), scope: POLS.flatMap((p) => NAMES.scope.map((n) => "scope/" + n + "/" + p)), r1c: POLS.flatMap((p) => NAMES.r1c.map((n) => "r1c/" + n + "/" + p)),
  haz: ["effect", "computed"].flatMap((k) => [true, false].map((f) => "haz/" + k + "/" + f)),
  r7: R7_KINDS.flatMap((k) => ["thr0", "thr1"].flatMap((t) => POLS.map((p) => "r7/" + k + "/" + t + "/" + p))),
  probes: ["haz1", "first", "nest"].flatMap((q) => EXP[q === "first" ? "first" : q].map((r) => r.row)).concat(EXP.unwind.map((r) => r.row)),
  sched: SCHED_ROWS.map((r) => "sched/" + r.id) })[fam];
describe("A-INSTR-O1: no node handed out while a frame / observer / owner / scope still holds it (viol 0; the hand-out hook REACHED on every row)", () => {
  for (const fam of ["regr", "scope", "r1c", "haz", "r7", "probes"]) it(fam, async () => {
    const rows = (await fams())[fam];
    assert.deepEqual(rows.map((r) => ({ id: r.id, viol: r.viol, reach: r.handouts > 0 || r.ce > 0 })), idsOf(fam).map((id) => ({ id, viol: 0, reach: true })));
  });
});
describe("A-INSTR-O1c: no node handed out while an arm shadow stack holds it, and no R1a loop / own-cleanup on a moved gen (violC 0, r1aDo 0, r1aOwn 0)", () => {
  for (const fam of ["regr", "scope", "r1c", "haz", "r7", "probes"]) it(fam, async () => {
    const rows = (await fams())[fam];
    assert.deepEqual(rows.map((r) => ({ id: r.id, violC: r.violC, r1aDo: r.r1aDo, r1aOwn: r.r1aOwn })), idsOf(fam).map((id) => ({ id, violC: 0, r1aDo: 0, r1aOwn: 0 })));
  });
  it("reach: the arm shadow stack was entered (armE) by the r1c family, the probes and the unwind rows", async () => {
    const f = await fams();
    const arm = (rows) => rows.reduce((a, r) => a + Object.values(r.armE || {}).reduce((x, y) => x + y, 0), 0);
    assert.ok(arm(f.r1c) > 0); assert.ok(arm(f.probes) > 0);
  });
});
describe("A-INSTR-O1f: flushEffects' catch never clears QUEUED on a slot whose gen moved (fclear 0, fclearMv 0; entries and catches REACHED)", () => {
  it("sched2 rows (26: 4 routes x 3 kinds x 2 policies + f21c + nothrow)", async () => {
    const rows = (await fams()).sched;
    assert.deepEqual(rows.map((r) => ({ id: r.id, fclear: r.fclear, fclearMv: r.fclearMv, entries: r.entries > 0 })), idsOf("sched").map((id) => ({ id, fclear: 0, fclearMv: 0, entries: true })));
    assert.ok(rows.some((r) => r.catches > 0));
  });
});

// ---------------------------------------------------------------- firing controls (each plant executes; verdict flips; fires only on its named rows)
const CTLS = {
  CTLIMM: ["regr/P-REUSE:5000:0", "regr/P-NEST:5000:0", "regr/P-NEST2:5000:0", "scope/P7run:5000:0", "r1c/PCLchild-make:0:5000", "r1c/PFB:5000:5000", "r1c/PCLW:5000:0"],
  CTLEARLY: ["regr/P-NEST2:5000:0"],
  CTLEIMM: ["r1c/PCLchild-make:0:5000"],
  CTLSRUN: ["scope/P7run:5000:0"],
  CTLSNEST: ["scope/P7nest:5000:0"],
};
describe("A-INSTR firing controls (grow; census regr + scope + r1c = 40 shapes): the plant executes and the oracle fires on exactly the named rows", () => {
  for (const [c, want] of Object.entries(CTLS)) it(c, async () => {
    const L = await ieng("Ic", c); const h0 = ihits()[c], fired = [];
    for (const [fam, T, run] of [["regr", REGR, (n) => censusRow(L.E, REGR, n, "grow")], ["scope", SCOPE, (n) => censusRow(L.E, SCOPE, n, "grow")], ["r1c", R1C, (n) => r1cRow(L.E, n, "grow")]])
      for (const n of Object.keys(T)) { L.zero(); run(n); const t = L.ps(); if (t.viol || t.violC) fired.push(fam + "/" + n + ":" + t.viol + ":" + t.violC); }
    assert.ok(ihits()[c] > h0, c + " plant executed");
    assert.deepEqual(fired, want);
  });
  it("CTLR0c (disposeNode's flushCur null dropped), O1f: fclear 1 on the 6 QUEUED-resident routes x 2 policies, fclearMv 1 on the 24 moved-gen rows", async () => {
    const L = await ieng("If", "CTLR0c"); const h0 = ihits().CTLR0c, fc = [], mv = [];
    for (const r of SCHED_ROWS) { L.zero(); schedRow(L.E, r.route, r.kind, r.pol, r.noThrow); const t = L.ps(); if (t.fclear) fc.push(r.id + ":" + t.fclear); if (t.fclearMv) mv.push(r.id + ":" + t.fclearMv); }
    assert.ok(ihits().CTLR0c > h0);
    const ids = (routes, kinds) => POLS.flatMap((p) => routes.flatMap((ro) => kinds.map((k) => ro + "-" + k + "/" + p)));
    assert.deepEqual(fc, ["grow", "throw"].flatMap((p) => ["body", "cleanup", "direct"].flatMap((ro) => ["eff", "efirst"].map((k) => ro + "-" + k + "/" + p + ":1"))));
    assert.deepEqual(mv, ids(["body", "cleanup", "direct", "arm"], ["eff", "cfirst", "efirst"]).map((x) => x + ":1"));
  });
  it("CTLR7 (severStale's gen-moved release dropped): A-R7 thr1 grow rows pool 3072 / unpins 0 / hw 3000 / hit 3000 (the pin is never released); C0 / E0 recover at depth 0; throw CW CE at 1020", async () => {
    const L = await ieng("Ic", "CTLR7"); const got = {};
    for (const k of R7_KINDS) { L.zero(); const h0 = ihits().CTLR7; const r = r7Row(L.E, k, true, "grow"); const t = L.ps(); got[k] = { iters: r.iters, pool: r.pool, unpins: t.unpins, hw: t.hw, hit: ihits().CTLR7 - h0, viol: t.viol }; }
    const stuck = { iters: 3000, pool: 3072, unpins: 0, hw: 3000, hit: 3000, viol: 0 };
    const rec = { iters: 3000, pool: 1024, unpins: 0, hw: 1, hit: 3000, viol: 0 };
    assert.deepEqual(got, { CW: stuck, EW: stuck, CFB: stuck, EFB: stuck, C0: rec, E0: rec, ESW: stuck });
    L.zero(); const r = r7Row(L.E, "CW", true, "throw"); assert.equal(r.ce, 1020);
  });
});

// ---------------------------------------------------------------- A-RETAIN (deterministic counts; no timing)
describe("A-RETAIN: P2e x 3 cycles x 5000 on ONE registry -- after each cycle the pinned list is empty, activeNodes is back at baseline, pool 1024", () => {
  it("3 cycles", async () => {
    const Ic = await ieng("Ic", ""); const r = Ic.E.createRegistry(); const s = r.signal(1); const base = r.stats().activeNodes; Ic.zero();
    const spec = REGR.P2e(r, s); const seen = [];
    for (let cyc = 0; cyc < 3; cyc++) {
      let once = false, done = 0;
      const h = r.effect(() => { s(); if (once) return; once = true; for (let i = 0; i < 5000; i++) { spec.it(i); done++; } });
      h();
      const t = Ic.ps(), st = r.stats();
      seen.push({ done, pinned: t.pins - t.unpins - t.released, active: st.activeNodes - base, pool: st.nodePoolPopulation, ce: t.ce });
    }
    assert.deepEqual(seen, [0, 1, 2].map(() => ({ done: 5000, pinned: 0, active: 0, pool: 1024, ce: 0 })));
  });
});

// ---------------------------------------------------------------- A-ZGC (child process: --expose-gc --single-threaded --max-old-space-size=512)
describe("A-ZGC: steady write -> flush -> computed read, 1e5 cycles: 0 major, 0 scavenges, <= 0.1 B/op; the 64 B plant >= 32 B/op (1e4 windows) and >= 1 scavenge (1e5 window)", () => {
  it("gc-child", () => {
    const r = spawnSync(process.execPath, ["--expose-gc", "--single-threaded", "--max-old-space-size=512", join(HERE, "fixtures", "b228", "gc-child.mjs"), ENG], { encoding: "utf8", timeout: 240000, killSignal: "SIGKILL" });
    assert.equal(r.status, 0, "gc-child exit " + r.status + " " + r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.eng.map((w) => w.major), [0, 0, 0]);
    assert.deepEqual(o.eng.map((w) => w.scav), [0, 0, 0]);
    assert.ok(o.eng.every((w) => w.bop <= 0.1), "engine B/op " + JSON.stringify(o.eng));
    assert.ok(o.plant1e4.every((w) => w.scav === 0 && w.bop >= 32), "plant 1e4 " + JSON.stringify(o.plant1e4));
    assert.ok(o.plant1e5.every((w) => w.scav >= 1), "plant 1e5 " + JSON.stringify(o.plant1e5));
  });
});

// ---------------------------------------------------------------- U4 battery survivors (b231)
describe("U4 battery survivors (b231): plain-input rows", () => {
  // Kills H12-RETFALSE (rerunCleanupComputed final `return false;` -> `return true;`); evidence .handoff/b228/mutants/probe-surv.mjs (RETFALSE) + PROGRESS.md.
  for (const pol of POLS) it("rerunCleanupComputed returns false after a completed cleanup: the body re-runs (" + pol + ")", async () => {
    const S = await eng(""); const r = S.createRegistry({ onCapacityExceeded: pol }); const a = r.signal(0); let runs = 0;
    const c = r.computed(() => { runs++; const v = a(); r.onCleanup(() => {}); return v * 10; });
    const v0 = c(); a.set(1); const v1 = c(); a.set(2); const v2 = c();
    assert.deepEqual({ v0, v1, v2, runs }, { v0: 0, v1: 10, v2: 20, runs: 3 });
  });
  // Kills US-NOFIND and US-HEADARM (unpinScope list search); port of .handoff/b228/mutants/probe-us.mjs; oracle = coded output (live 29731ff9).
  const EXP_US = {
    grow: { L: ["Y:function", "inScopeGap:0 grow", "Y:disposed"], gap: [1, "grow"] },
    throw: { L: ["Y:function", "inScopeGap:-1 CapacityError", "Y:disposed"], gap: [0, "CapacityError"] }
  };
  const usGap = (r) => { const st0 = r.stats(), free0 = st0.nodePoolPopulation - st0.activeNodes; let c = 0; try { for (;;) { r.signal(0); c++; if (r.stats().nodePoolPopulation !== st0.nodePoolPopulation) break; if (c > free0 + 4) break; } } catch (e) { return [c - free0, e.constructor.name]; } return [c - free0, "grow"]; };
  for (const pol of POLS) it("unpinScope on a non-head scope pin: full probe output (" + pol + ")", async () => {
    const S = await eng(""); const r = S.createRegistry({ onCapacityExceeded: pol });
    const O1 = r.effect(() => {}), O2 = r.effect(() => {}); const L = []; let Yh = null;
    r.runWithOwner(O1, () => {
      r.runWithOwner(O2, () => { O2(); O1(); });
      const Y = r.effect(() => {}); r.effect(() => { r.onCleanup(() => L.push("Z:cleanup")); });
      L.push("Y:" + typeof Y); Yh = Y; Y(); L.push("inScopeGap:" + usGap(r).join(" "));
    });
    Yh(); L.push("Y:disposed");
    assert.deepEqual({ L, gap: usGap(r) }, EXP_US[pol]);
  });
});
