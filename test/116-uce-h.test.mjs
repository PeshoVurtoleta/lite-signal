/**
 * UCE-H (burst 194, batch B2): the forged-wrapper finding F-b192-1 + the far-floor HeapNumber trap at three warm / cold sites.
 *
 * Oracle: .handoff/uceh/PLAN-UCEH.md ASSERTIONS A1-A5 + ruling D-b193-2 (option A: gen + slot re-check), written without reading the fix.
 * Engine under test: ../Signal.js, or the absolute path in env UCEH_SIGNAL (the mutant battery). Reference (frozen before build, commit
 * 347ba17 / sha256/8 2043b9f6) is ALWAYS test/fixtures/Signal-2043b9f6.js; the identity row fails the file unless its sha is 2043b9f6.
 *
 * Row labels: RED = fails on the frozen build, passes on the fixed one. PIN = same on both (honest path / regression pin).
 * Every row is a hard row (no todo): a failing row fails the run.
 *
 * Sites: E = rerunCleanupEffect, C = computedRunTail, U = the UCE delivery in throwComputedError. Floor = int32 form of
 * (gv - 0x3FFFFFFF), never 0 (0 -> -1; LEDGER #34 / F29). Expected values below are hand-derived from that spec:
 *   gv -0x40000001: g - 0x3FFFFFFF = -0x7FFFFFFF - 1 ... = -2^31 exactly            -> -0x80000000
 *   gv -0x40000002: -0x80000001 wraps int32 (+2^32)                                  -> 0x7FFFFFFF
 *   gv  0x3FFFFFFF: 0                                                                -> -1
 * Children (spawnSync): --max-old-space-size pinned, SIGKILL timeout, every caller checks error / signal / status (fail closed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_PATH = process.env.UCEH_SIGNAL || fileURLToPath(new URL("../Signal.js", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/Signal-2043b9f6.js", import.meta.url));
const CHILD_PATH = fileURLToPath(new URL("./fixtures/uceh-child.mjs", import.meta.url));
const WATCH_LINE = 'export {watch, when, whenAsync} from "./Watch.js";';
async function loadBuild(p) {
    if (existsSync(dirname(p) + "/Watch.js")) return import(pathToFileURL(p).href);
    const parts = readFileSync(p, "utf8").split(WATCH_LINE);
    assert.equal(parts.length, 2, "Watch re-export line matched " + (parts.length - 1) + " times");
    return import("data:text/javascript;base64," + Buffer.from(parts[0] + parts[1], "utf8").toString("base64"));
}
const M = await loadBuild(ENGINE_PATH);
const { createRegistry } = M;
const V8MSG = "Maximum call stack size exceeded";
const HEAP = "--max-old-space-size=1536";
const CHILD_TIMEOUT = 240000;

function childRaw(flags, mode, args) {
    return spawnSync(process.execPath, [...flags, HEAP, CHILD_PATH, mode, JSON.stringify(args)], { encoding: "utf8", timeout: CHILD_TIMEOUT, killSignal: "SIGKILL", maxBuffer: 1 << 26, env: process.platform === "win32" ? process.env : {} });
}
function child(flags, mode, args) {
    const r = childRaw(flags, mode, args);
    if (r.error) assert.fail("child " + mode + " error: " + r.error.message);
    if (r.signal !== null) assert.fail("child " + mode + " killed by " + r.signal);
    if (r.status !== 0) assert.fail("child " + mode + " exit " + r.status + ": " + String(r.stderr).slice(-400));
    const lines = r.stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
}

describe("fixture identity", () => {
    it("the vendored before build is 2043b9f6", () => {
        assert.equal(createHash("sha256").update(readFileSync(FIXTURE_PATH)).digest("hex").slice(0, 8), "2043b9f6");
    });
});

// ---- A1: GC per site. Stat per child: windows of 2000 cycles after gc + settle, 12 rounds x 4 loops (ref, eng, ctl, reftwin), a window with any
// collection is discarded; per loop the median of the kept windows; JS heap spaces only, --single-threaded (CI class 18, fe3a15a). ----
// Site C runs --jitless: measured on the frozen build, the optimized computedRunTail does not box at gv -0x7FFFFF00 (ref 1.98 B/op at both gv);
// jitless (Ignition) boxes it deterministically (49.98 vs 1.98 B/op, 3 HeapNumbers), E boxes in default tiers (+16.0 B/op), U (+44.7 B/op).
const SITES = { E: "rerunCleanupEffect", C: "computedRunTail", U: "UCE delivery (throwComputedError)" };
describe("A1 GC: the far floor allocates nothing per site (ref = frozen 2043b9f6)", () => {
    for (const site of Object.keys(SITES)) {
        for (const gv of [-0x7FFFFF00, 0x50000000]) {
            const neg = gv < 0;
            it((neg ? "[RED] " : "[PIN] ") + "site " + site + " (" + SITES[site] + ") at gv " + gv + (neg ? ": ref - eng >= 12 B/op (kills BOXING-" + site + ", HELPERBOX)" : ": |eng - ref| < 8 B/op"), () => {
                const o = child([...(site === "C" ? ["--jitless"] : []), "--expose-gc", "--single-threaded"], "gc3", { eng: ENGINE_PATH, ref: FIXTURE_PATH, site, gv, cycles: 2000, rounds: 12 });
                const what = " " + JSON.stringify(o);
                assert.equal(o.windowMajors, 0, "windowMajors" + what);
                for (let i = 0; i < 4; i++) assert.ok(o.n[i] >= 8, "kept windows [ref, eng, reftwin, ctl] " + JSON.stringify(o.n) + what);
                for (const k of ["ref", "eng", "reftwin", "ctl"]) assert.ok(o.cover[k] >= (site === "C" ? 1.99 : 0.99), "site did not fire in loop " + k + what);   // C: body runs 2x per cycle; E / U: one caught throw per cycle
                assert.ok(Math.abs(o.reftwin - o.ref) < 8, "A/A twin |reftwin - ref|" + what);
                assert.ok(o.ctl - o.eng >= 24, "control must box: ctl - eng" + what);
                if (neg) assert.ok(o.ref - o.eng >= 12, "ref - eng >= 12" + what);
                else assert.ok(Math.abs(o.eng - o.ref) < 8, "|eng - ref| < 8" + what);
            });
        }
    }
    it("tooth: the gc3 child refuses to measure without --single-threaded (exit 3)", () => {
        const r = childRaw(["--expose-gc"], "gc3", { eng: ENGINE_PATH, ref: FIXTURE_PATH, site: "U", gv: 0x50000000, cycles: 100, rounds: 1 });
        assert.equal(r.error, undefined); assert.equal(r.signal, null);
        assert.equal(r.status, 3, "exit " + r.status);
        assert.ok(String(r.stderr).includes("GC modes need --single-threaded"));
        assert.equal(String(r.stdout).trim(), "");
    });
});

// ---- A2: values + census ----
describe("A2 floor values (snapshot evalVersion after the site fired at a seeded gv) and source census", () => {
    const VALS = [[-0x40000001, -0x80000000], [-0x40000002, 0x7FFFFFFF], [0x3FFFFFFF, -1]];
    for (const site of ["E", "U"]) for (const [gv, want] of VALS) {
        it("[PIN] site " + site + " at gv " + gv + ": evalVersion " + want + " (kills BOUNDLE, BOUNDLO, NOZERO)", () => {
            const o = child([], "val", { path: ENGINE_PATH, site, target: gv });
            assert.equal(o.found, true, "no start gv reached the target: " + JSON.stringify(o));
            assert.equal(o.hits, 1);
            assert.equal(o.gvAt, gv);
            assert.equal(o.evalVersion, want);
        });
    }
    // A2-RAW: snapshot().evalVersion is `| 0` (D-M), so it folds a stored 2^31 / -2^31-1 back into int32 and hides a bound error (BOUNDLE, BOUNDLO).
    // These rows read the RAW node field through describe()'s symbol-keyed node pointer: exactly the int32 value, and (raw | 0) === raw.
    // Site C: the floor is read inside the re-pull run (the re-pull stamps over it afterwards); its gv is the settled snapshot gv (no write follows).
    for (const site of ["E", "C", "U"]) for (const [gv, want] of VALS) {
        it("[PIN] A2-RAW site " + site + " at gv " + gv + ": raw node.evalVersion === " + want + " and a valid int32 (kills BOUNDLE, BOUNDLO, NOZERO, DROP)", () => {
            const o = child([], "val", { path: ENGINE_PATH, site, target: gv });
            assert.equal(o.found, true, "no start gv reached the target: " + JSON.stringify(o));
            assert.equal(o.gvAt, gv);
            assert.strictEqual(o.raw, want, "raw " + String(o.raw));
            assert.strictEqual(o.raw | 0, o.raw, "raw is not an int32: " + String(o.raw));
        });
    }
    const src = readFileSync(ENGINE_PATH, "utf8");
    const count = (t, s) => t.split(s).length - 1;
    it("[RED] census: the old floor text '(globalVersion - 0x3FFFFFFF) | 0' occurs 0 times (old code: 3 sites + 2 comments)", () => {
        assert.equal(count(src, "(globalVersion - 0x3FFFFFFF) | 0"), 0);
    });
    // Census: counts the definition (1) + the 4 call sites; a comment containing `stampFarFloor(` would break it.
    it("[RED] census: stampFarFloor( is called exactly 4 times (3 UCE-H sites + severStale's computed consume, AUD-F G1; the single definition excluded)", () => {
        assert.equal(count(src, "function stampFarFloor("), 1, "definitions");
        assert.equal(count(src, "stampFarFloor(") - 1, 4, "call sites");
    });
});

// ---- A3: forged wrappers. P = the UCE prototype, taken from a public snapshot value (the repro of review b192). ----
function ucePrototype() {
    const r = createRegistry(); const Ex = new Error("E");
    const s = r.signal(1); const st = { armed: false };
    const c = r.computed(() => { const v = s(); r.onCleanup(() => { if (st.armed) { st.armed = false; s.set(20); throw Ex; } }); return v * 10; });
    let readC = true; r.effect(() => { if (readC) c(); s(); });
    readC = false; st.armed = true; s.set(2);
    const n = r.snapshot().nodes.find((x) => x.id === r.nodeId(c));
    assert.ok(n && n.value && typeof n.value === "object" && n.value.err === Ex, "no wrapper in the snapshot");
    return Object.getPrototypeOf(n.value);
}
const P = ucePrototype();
const KINDS = ["ctorRange", "ctorObject", "msg", "protoTrap", "hasInstance", "errGet", "proxyGet"];
const KILLS = { ctorRange: "NOGEN-U", ctorObject: "NOGEN-U", msg: "NOGEN-U", protoTrap: "BOTHSKIP-U", hasInstance: "BOTHSKIP-U", errGet: "EARLYCHK, BOTHSKIP-U", proxyGet: "BOTHSKIP-U" };
// forged world: X = a computed that throws `forged` (cached as its error); the user-code point disposes X once and recycles the slot as s2.
function forge(kind, into, extra) {
    const r = createRegistry({ maxNodes: 64 }); let X, s2 = null;
    const recycle = () => { if (s2 === null) { r.dispose(X); s2 = r.signal(into === "forged" ? forged : 42); } };
    let forged;
    if (kind === "ctorRange" || kind === "ctorObject") forged = Object.create(P, { constructor: { get() { recycle(); return kind === "ctorRange" ? RangeError : Object; } }, message: { value: V8MSG }, err: { value: 7 } });
    else if (kind === "msg") forged = Object.create(P, { constructor: { value: RangeError }, message: { get() { recycle(); return V8MSG; } }, err: { value: 7 } });
    else if (kind === "protoTrap") forged = new Proxy({ err: 7 }, { getPrototypeOf() { recycle(); return P; } });
    else if (kind === "hasInstance" || kind === "errGet") forged = Object.create(P, { err: kind === "errGet" ? { get() { recycle(); return 7; } } : { value: 7 } });
    else if (kind === "proxyGet") forged = new Proxy(Object.create(P, { err: { value: 7 } }), { get(t, k, rc) { if (k === "err") recycle(); return Reflect.get(t, k, rc); } });
    if (extra) extra({ r, recycle, get X() { return X; }, forged });
    X = r.computed(() => { throw forged; });
    const pin = r.signal(0);
    const rankOf = (h) => r.snapshot().nodes.findIndex((n) => n.id === r.nodeId(h));
    const xRank = rankOf(X), pinRank = rankOf(pin);
    assert.ok(xRank >= 0 && pinRank === xRank + 1, "setup: X rank " + xRank + " pin rank " + pinRank);
    let caught = "none";
    const HI = P.constructor;
    if (kind === "hasInstance") Object.defineProperty(HI, Symbol.hasInstance, { value(x) { recycle(); return Function.prototype[Symbol.hasInstance].call(this, x); }, configurable: true });
    try { try { X(); caught = "returned"; } catch (e) { caught = e; } } finally { if (kind === "hasInstance") delete HI[Symbol.hasInstance]; }
    assert.notEqual(s2, null, "the user-code point never ran (" + kind + ")");
    return { r, X, s2, pin, forged, caught, xRank, pinRank, rankOf };
}
describe("A3 forged UndeliveredCleanupError: X's read fails closed, the recycled slot is never written", () => {
    for (const kind of KINDS) {
        it("[RED] " + kind + ": X's read throws exactly the forged object, s2() === 42, s2 takes X's rank, the pin keeps its rank (kills " + KILLS[kind] + ", NOREUSE witness)", () => {
            const w = forge(kind, "42");
            assert.strictEqual(w.caught, w.forged, "X read threw " + String(w.caught));
            assert.strictEqual(w.s2(), 42);
            assert.equal(w.rankOf(w.s2), w.xRank, "s2 did not take X's former rank");
            assert.equal(w.rankOf(w.pin), w.pinRank, "the pin moved");
        });
        it("[RED] " + kind + ": the slot recycled as r.signal(forged): s2() === forged (kills NOGEN-U)", () => {
            const w = forge(kind, "forged");
            assert.strictEqual(w.caught, w.forged);
            assert.strictEqual(w.s2(), w.forged);
        });
    }
    it("[RED] re-entrant same gen: the err getter reads X once (caught); the outer read throws forged; X's record equals the inner delivery's (kills NOVAL-U)", () => {
        const r = createRegistry({ maxNodes: 64 }); let X, inner = "none", recInner = null, depth = 0;
        const forged = Object.create(P, { err: { get() {
            if (depth++ === 0) { try { X(); inner = "returned"; } catch (e) { inner = e; } recInner = r.snapshot().nodes.find((n) => n.id === r.nodeId(X)); }
            return 7;
        } } });
        X = r.computed(() => { throw forged; });
        let caught = "none"; try { X(); caught = "returned"; } catch (e) { caught = e; }
        assert.strictEqual(inner, 7, "the inner read delivers err");
        assert.strictEqual(caught, forged, "the outer read threw " + String(caught));
        assert.deepEqual(r.snapshot().nodes.find((n) => n.id === r.nodeId(X)), recInner);
    });
    it("[PIN] observer recycled into s3: s3's snapshot markEpoch is unchanged by the delivery (the stale-mark never lands on a stranger)", () => {
        const r = createRegistry({ maxNodes: 64 }); let Y, s3 = null, mark0 = null;
        const forged = Object.create(P, { err: { get() { if (s3 === null) { r.dispose(Y); s3 = r.signal(9); mark0 = r.snapshot().nodes.find((n) => n.id === r.nodeId(s3)).markEpoch; } return 7; } } });
        const X = r.computed(() => { throw forged; });
        Y = r.computed(() => X());
        try { Y(); } catch (e) { /* 7 or forged */ }
        assert.notEqual(s3, null, "the getter never ran");
        assert.equal(r.snapshot().nodes.find((n) => n.id === r.nodeId(s3)).markEpoch, mark0);
        assert.strictEqual(s3(), 9);
    });
    it("[RED] err read once: a getter whose 2nd read recycles X is never read twice: the X read throws 7, calls 1, s2 null, a 2nd read throws 7 (kills READ2W, READ2T)", () => {
        const r = createRegistry({ maxNodes: 64 }); let X, s2 = null, calls = 0;
        const forged = Object.create(P, { err: { get() { calls++; if (calls === 2) { r.dispose(X); s2 = r.signal(42); return 8; } return 7; } } });
        X = r.computed(() => { throw forged; });
        let caught = "none"; try { X(); caught = "returned"; } catch (e) { caught = e; }
        assert.strictEqual(caught, 7);
        assert.strictEqual(calls, 1, "err read " + calls + " times");
        assert.strictEqual(s2, null);
        let again = "none"; try { X(); again = "returned"; } catch (e) { again = e; }
        assert.strictEqual(again, 7);
    });
    it("[RED] describe(X) with an err getter that recycles X: the descriptor is not live (liveNode undefined), s2() === 42 (kills DESCGEN)", () => {
        // X holds the forged value without a prior read (a read would deliver and replace it): restore a snapshot whose X value is the forged object.
        const r0 = createRegistry({ maxNodes: 64 });
        const X0 = r0.computed(() => { throw 1; });
        try { X0(); } catch (e) { /* cached */ }
        const snap = r0.snapshot(), xid = r0.nodeId(X0), H = {};
        let r, s2 = null;
        const forged = Object.create(P, { err: { get() { if (s2 === null) { r.dispose(H[xid]); s2 = r.signal(42); } return 7; } } });
        const nodes = snap.nodes.map((n) => (n.id === xid ? Object.assign({}, n, { value: forged }) : n));
        r = createRegistry({ maxNodes: 8 }).restore(Object.assign({}, snap, { nodes }), { fnsById: { [xid]: () => { throw 1; } }, handles: H });
        const d = r.describe(H[xid]);
        assert.notEqual(s2, null, "describe never ran the getter");
        assert.notEqual(d, undefined);
        assert.strictEqual(r.describe(d), undefined, "the descriptor resolves to a stranger");
        assert.strictEqual(r.nodeId(d), undefined);
        assert.strictEqual(s2(), 42);
    });
    it("[PIN] honest path: a forged wrapper with NO move: X's read throws 7 (both builds)", () => {
        const r = createRegistry({ maxNodes: 64 });
        const forged = Object.create(P, { err: { value: 7 } });
        const X = r.computed(() => { throw forged; });
        let caught = "none"; try { X(); caught = "returned"; } catch (e) { caught = e; }
        assert.strictEqual(caught, 7);
        let again = "none"; try { X(); again = "returned"; } catch (e) { again = e; }
        assert.strictEqual(again, 7, "the delivered err is cached as the node's error");
    });
});

// ---- A4: retention ----
describe("A4 retention: 1000 forge + dispose + recycle cycles", () => {
    it("[PIN] lite-leak tracker size 0 after 2 gc(); the planted array control shows 1000", () => {
        const o = child(["--expose-gc"], "ret3", { path: ENGINE_PATH, cycles: 1000 });
        assert.equal(o.cycles, 1000); assert.equal(o.planted, 1000);
        assert.equal(o.moved, 1000, "recycle path coverage");
        assert.equal(o.ctlSize, 1000, "control must keep all 1000 planted objects alive");
        assert.equal(o.size, 0, "tracked registries / forged objects / s2 retained: " + o.size);
    });
});
