// 126-pinned-overflow.test.mjs -- b232 STEP 2 (maintainer ruling D-b231-1 "(A) Host-keyed rows").
// Purpose: kill six pinned-slot engine mutants (F-b224-1 fix) that survive every behavioural row (test/124, test/125) because they
// differ only AFTER a stack overflow inside a function's FIRST call (V8 lazy-compile stack check, consumed once per process). Each
// cell is therefore one fresh `node --jitless` child (fixtures/b232/{d2b,d2fe,noflags}.mjs), judged by SITE (D-b216-4), never by k.
// HOST_KEY = darwin && arm64 && node v26.8.2 (D-b222-1): the overflow sites are frame-size / host bound. Off-key: one
// "# REPORTED <row> ..." line + t.skip BEFORE any spawn. LS_B232_OFFKEY=1 forces the off-key path (check of the skip path only).
// Families -> mutants (row titles start with the family token; the b231 battery maps on them):
//   OV-D2B     RE-NODEC-catch, RC-NODEC-catch  (arm = one throwing re-run cleanup RE effect / RC computed, then the effS strand cell
//                                              unpinOwn<-effectTail, then the depth-0 gap readout)
//   OV-D2FE    FE-NODEC-catch, FC-NODEC-catch  (A site firstRunCleanupE<-rerunCleanupEffect / firstRunCleanupC<-rerunCleanupComputed,
//                                              B site unpinOwn<-effectTail; k1 x k2 grid, one cell per process)
//   OV-SOLATE  UO-SOLATE                       (effS strand, no arm)
//   OV-NOFLAGS H18-NOFLAGS                     (no cell where FN ran and the call still threw: coded; mutant k 366..368 top runWithOwner)
// Oracle = b231 probes (.handoff/b228/mutants/probe-{d2b,d2fe,noflags}.mjs; PROGRESS-2.md "Survivor classification"), measured on
// node v26.8.2 darwin-arm64 against the coded build 29731ff9. Expected values are the measured tuples quoted there (exact, not signs):
// coded depth-0 gap 1 "grow" / 0 "CapacityError"; mutant on its own arm 0 / -1. Engine under test: env LS_ENGINE (abs path; its
// Watch.js beside it; the battery points it at a mutant, so the CODED rows must go red), default ../Signal.js. The must-fail rows stage
// the six mutants IN-TEST from the LIVE ../Signal.js text (fixtures/b232/mutants.mjs, count-checked, byte-identical to
// .handoff/b228/mutants/work/<ID>/Signal.js) and so are independent of LS_ENGINE. Every spawnSync has timeout + SIGKILL and asserts
// res.error === undefined, res.signal === null, res.status === 0 (a timed-out child fails the row).
// Cost (node v26.8.2 darwin-arm64, untimed wall, host load ~6, so indicative): OV-D2B 4 cells (k 360..385 swept inside each child) ~0.6 s coded,
// ~0.6 s per must-fail; OV-SOLATE 2 cells ~0.3 s each row; OV-D2FE 144 cells coded (2 arms x 2 pols x k1 370..375 x k2 372..377) ~8 s, 72 cells
// per must-fail row ~4 s; OV-NOFLAGS 1 cell (k 0..400 inside) ~1.5 s per row. Whole file ~22 s.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stageMutant } from "./fixtures/b232/mutants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = join(HERE, "..", "Signal.js");
const ENG = process.env.LS_ENGINE || LIVE;
const FX = join(HERE, "fixtures", "b232");
const HOST_KEY = process.platform === "darwin" && process.arch === "arm64" && process.version === "v26.8.2" && process.env.LS_B232_OFFKEY !== "1";
const offKey = (t, row) => { console.log("# REPORTED " + row + " on " + process.platform + "-" + process.arch + " " + process.version + ": host-keyed (D-b231-1)"); t.skip("host-keyed (D-b231-1)"); return true; };

function cell(script, args) {
    const res = spawnSync(process.execPath, ["--jitless", join(FX, script), ...args], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", env: {}, maxBuffer: 1 << 24 });
    assert.equal(res.error, undefined, script + " " + args.join(" ") + ": spawn error " + (res.error && res.error.message));
    assert.equal(res.signal, null, script + " " + args.join(" ") + ": killed by signal " + res.signal);
    assert.equal(res.status, 0, script + " " + args.join(" ") + ": exit " + res.status + " " + String(res.stderr).slice(0, 300));
    return res.stdout;
}
// env: {} for every child: the caller environment size shifts the stack start (pad axis, b221/b222), so the same k lands on a
// different frame; an empty environment makes every cell independent of the runner / battery env.
const mutant = (name) => stageMutant(LIVE, readFileSync(LIVE, "utf8"), name);

// ---- D2B / SOLATE: one child per (arm, pol); site cells = the strand cells at unpinOwn<-effectTail ----
const STRAND = "unpinOwn<-effectTail";
const ARMED = { none: "-", RE: "Error", RC: "read:Error" };   // the arm's own throw (cRE / cRC) observed: the arm executed
const CODED = { grow: { gap: 1, end: "grow" }, throw: { gap: 0, end: "CapacityError" } };
const MUTD = { grow: { gap: 0, end: "grow" }, throw: { gap: -1, end: "CapacityError" } };
function d2b(eng, arm, pol) {
    const o = JSON.parse(cell("d2b.mjs", [eng, arm, pol, "360", "385"]));
    const site = o.cells.filter((c) => c.site === STRAND);
    for (const c of site) assert.equal(c.armed, ARMED[arm], "arm " + arm + " did not execute at k " + c.k);
    return site.map((c) => ({ gap: c.gap, end: c.end }));
}
function expectSite(got, want, what) {
    assert.ok(got.length >= 3, what + ": REACH floor: " + got.length + " site cells (<3; measured 7 coded / 7-8 mutant)");   // sweep must hit the site
    for (const g of got) assert.deepEqual(g, want, what);
}

describe("OV-D2B (RE-NODEC-catch, RC-NODEC-catch): throwing re-run cleanup arm, then effS strand, then the depth-0 gap", () => {
    it("OV-D2B coded: arm RE / RC -> gap 1 grow, gap 0 CapacityError at every unpinOwn<-effectTail cell", (t) => {
        if (!HOST_KEY) return offKey(t, "OV-D2B");
        for (const arm of ["RE", "RC"]) for (const pol of ["grow", "throw"]) expectSite(d2b(ENG, arm, pol), CODED[pol], "coded " + arm + "/" + pol);
    });
    for (const [m, arm, other] of [["RE-NODEC-catch", "RE", "RC"], ["RC-NODEC-catch", "RC", "RE"]]) {
        it("OV-D2B must-fail: " + m + " -> its own arm reads 0 grow / -1 CapacityError (mutated line executed); the other arm stays coded", (t) => {
            if (!HOST_KEY) return offKey(t, "OV-D2B must-fail " + m);
            const eng = mutant(m);
            for (const pol of ["grow", "throw"]) {
                expectSite(d2b(eng, arm, pol), MUTD[pol], m + " own arm " + arm + "/" + pol);
                expectSite(d2b(eng, other, pol), CODED[pol], m + " other arm " + other + "/" + pol);
            }
        });
    }
});

describe("OV-SOLATE (UO-SOLATE): effS strand, no arm", () => {
    it("OV-SOLATE coded: gap 1 grow, gap 0 CapacityError at every unpinOwn<-effectTail cell", (t) => {
        if (!HOST_KEY) return offKey(t, "OV-SOLATE");
        for (const pol of ["grow", "throw"]) expectSite(d2b(ENG, "none", pol), CODED[pol], "coded none/" + pol);
    });
    it("OV-SOLATE must-fail: UO-SOLATE -> gap 0 grow / -1 CapacityError (scopeOwned after the unlink orphans X)", (t) => {
        if (!HOST_KEY) return offKey(t, "OV-SOLATE must-fail");
        const eng = mutant("UO-SOLATE");
        for (const pol of ["grow", "throw"]) expectSite(d2b(eng, "none", pol), MUTD[pol], "UO-SOLATE none/" + pol);
    });
});

// ---- D2FE: one child per (arm, pol, k1, k2) ----
const ASITE = { FE: "firstRunCleanupE<-rerunCleanupEffect", FC: "firstRunCleanupC<-rerunCleanupComputed" };
function d2fe(eng, arm, pol) {
    const out = [];
    for (let k1 = 370; k1 <= 375; k1++) for (let k2 = 372; k2 <= 377; k2++) {
        const o = JSON.parse(cell("d2fe.mjs", [eng, arm, String(k1), String(k2), pol]).trim());
        if (o.A === ASITE[arm] && o.B === STRAND) out.push({ gap: o.gap[0], end: o.gap[1], at: k1 + "/" + k2 });
    }
    return out;
}
function expectFe(got, want, what) {
    assert.ok(got.length >= 1, what + ": REACH floor: no (A, B) site cell in the k1 x k2 grid (measured 4)");
    for (const g of got) assert.deepEqual({ gap: g.gap, end: g.end }, want, what + " at k1/k2 " + g.at);
}

// must-fail verdict: the same site cells, but the mutated tuple appears (>= 1 cell) and nothing else but the coded tuple does (a cell whose
// k lands just outside the arm's try reads coded on the mutant too; with env {} measured: all cells read mutated).
function expectFeMut(got, mutd, coded, what) {
    assert.ok(got.length >= 1, what + ": REACH floor: no (A, B) site cell in the k1 x k2 grid (measured 4)");
    const key = (g) => g.gap + "/" + g.end, M = key(mutd), C = key(coded);
    assert.ok(got.some((g) => key(g) === M), what + ": no site cell reads the mutated tuple " + M + "; got " + got.map((g) => g.at + "=" + key(g)).join(" "));
    for (const g of got) assert.ok(key(g) === M || key(g) === C, what + ": unexpected tuple " + key(g) + " at k1/k2 " + g.at);
}

describe("OV-D2FE (FE-NODEC-catch, FC-NODEC-catch): first-run arm site A, then effS strand site B", () => {
    it("OV-D2FE coded: FE and FC -> gap 1 grow, gap 0 CapacityError at every (A, unpinOwn<-effectTail) cell", (t) => {
        if (!HOST_KEY) return offKey(t, "OV-D2FE");
        for (const arm of ["FE", "FC"]) for (const pol of ["grow", "throw"]) expectFe(d2fe(ENG, arm, pol), CODED[pol], "coded " + arm + "/" + pol);
    });
    for (const [m, arm] of [["FE-NODEC-catch", "FE"], ["FC-NODEC-catch", "FC"]]) {
        it("OV-D2FE must-fail: " + m + " -> its own arm reads 0 grow / -1 CapacityError at the A site", (t) => {
            if (!HOST_KEY) return offKey(t, "OV-D2FE must-fail " + m);
            const eng = mutant(m);
            for (const pol of ["grow", "throw"]) expectFeMut(d2fe(eng, arm, pol), MUTD[pol], CODED[pol], m + " " + arm + "/" + pol);
        });
    }
});

// ---- NOFLAGS: one child ----
function noflags(eng) { return JSON.parse(cell("noflags.mjs", [eng])); }
describe("OV-NOFLAGS (H18-NOFLAGS): runWithOwner(liveX, FN): no cell where FN ran and the call threw", () => {
    it("OV-NOFLAGS coded: k 0..400 has no cell where FN ran then RangeError (the finally calls nothing for a live owner)", (t) => {
        if (!HOST_KEY) return offKey(t, "OV-NOFLAGS");
        const o = noflags(ENG);
        // REACH: the sweep crosses the stack edge (FN ran cleanly with headroom, did not run without): measured ranOk 35, notRan 366
        assert.ok(o.ranOk >= 1 && o.notRan >= 1, "REACH: ranOk " + o.ranOk + " notRan " + o.notRan);
        assert.deepEqual(o.cells, []);
    });
    it("OV-NOFLAGS must-fail: H18-NOFLAGS -> FN ran, then a RangeError from runWithOwner's finally (measured k 366..368)", (t) => {
        if (!HOST_KEY) return offKey(t, "OV-NOFLAGS must-fail");
        const o = noflags(mutant("H18-NOFLAGS"));
        assert.ok(o.cells.length >= 1, "mutant: no FN-ran-then-threw cell (measured 3)");
        for (const c of o.cells) { assert.equal(c.err, "RangeError"); assert.equal(c.top, "Object.runWithOwner"); }
    });
});
