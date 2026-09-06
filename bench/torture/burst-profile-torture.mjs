/**
 * bench/torture/burst-profile-torture.mjs -- the 1.6.0 flush/burst lane:
 * opcodes 6/7 + the stats().flushPasses counter, pinned EXACTLY.
 *
 * 1.6.0 adds two mutation-hook opcodes and one stat on top of the 1.2.1
 * keystone: op 6 "flush pass start" (a = pass index within the current drain,
 * starting at 1; b = effects queued for that pass) fired at the top of each
 * drain pass, op 7 "effect enqueue" (a = node id) fired when an effect is
 * QUEUED by markDownstream, and stats().flushPasses, which advances once per
 * pass ONLY while a mutation-hook listener is attached. This is the substrate
 * lite-devtools' burstProfile() reads; this file gates it engine-raw, with no
 * devtools dependency, so the torture suite proves the lane the tools trust.
 *
 * CRITICAL SEMANTICS, established empirically before any assertion (probed on
 * 1.6.0-rc, 2026-09-05):
 *   - op 7 fires on the 0->1 QUEUED transition only. A batch of B writes over
 *     K observing effects emits exactly K op-7s, not B*K: queue-level
 *     coalescing is directly visible in the opcode stream, BEFORE any body
 *     runs. This is the coalescing == 1.0x witness: enqueues == distinct
 *     effects, re-runs == 0.
 *   - op 7 fires at MARK time (inside the write), op 6 at pass START -- so a
 *     one-pass burst reads [7 x K, then 6]; a cascade reads 7,6(1),7,6(2):
 *     the pass-2 enqueue happens DURING pass 1 (double-buffered queues).
 *   - op 6's pass index restarts at 1 for every drain; a k-stage cross-effect
 *     cascade drains in exactly k passes (toRun 1 each).
 *   - a SELF-write (an effect writing its own dep) does NOT re-enqueue the
 *     writing effect (FLAG_COMPUTING guard): exactly one pass, one op-7, and
 *     the body runs exactly once -- while the write itself lands.
 *   - detached (no listener): zero op-6/7, and flushPasses is FROZEN -- the
 *     documented zero-cost gate.
 *   - flushPasses advances exactly once per op-6 while attached (stat and
 *     opcode lane must agree), and destroy() resets it to 0.
 *
 * Falsifiability self-test (BURST_BREAK, never set by the runner):
 *   BURST_BREAK=drop7  -- the recorder drops every 2nd op-7 (a dropped-enqueue
 *                         defect): the exact enqueue counts fail, exit 1.
 *   BURST_BREAK=ghost6 -- the recorder doubles every op-6 (a phantom pass):
 *                         the pass sequence + stat-agreement pins fail, exit 1.
 * Both verified to exit 1 at build time.
 *
 * Exit code: 0 iff every pin held; 77 (SKIP) below the 1.6.0 surface.
 *
 * Usage: node bench/torture/burst-profile-torture.mjs
 *        BURST_VOLUME=5000 node bench/torture/burst-profile-torture.mjs
 */

import * as Signal from "../../Signal.js";
import { createReport, fixedRegistry, SKIP_EXIT } from "./helpers/index.mjs";

const { createRegistry } = Signal;

/* -- surface gate ------------------------------------------------------------ */
{
    const r = createRegistry({ maxNodes: 16, maxLinks: 32 });
    const hasHook = typeof r.onGraphMutation === "function";
    const hasStat = typeof r.stats === "function" && typeof r.stats().flushPasses === "number";
    if (!hasHook || !hasStat) {
        console.log("lite-signal burst-profile torture -- SKIP: op-6/7 + flushPasses require 1.6.0+");
        process.exit(SKIP_EXIT);
    }
    r.destroy();
}

const VOLUME = Number(process.env.BURST_VOLUME || 1000);
const BREAK = process.env.BURST_BREAK || "";
const R = createReport(`lite-signal burst-profile torture -- op-6/7 + flushPasses exact accounting, ${VOLUME}-burst volume`);

/* Opcode recorder: keeps only the flush lane (>= 6). Sequence entries are
 * [op, a, b] triples; BURST_BREAK fault injection lives ONLY here, proving the
 * pins fire on a defective stream without ever touching the engine. */
function makeRecorder() {
    const seq = [];
    let drop7 = false;
    const hook = (op, a, b) => {
        if (op < 6) return;
        if (op === 7 && BREAK === "drop7" && (drop7 = !drop7)) return;
        seq.push([op, a, b]);
        if (op === 6 && BREAK === "ghost6") seq.push([op, a, b]);
    };
    return { seq, hook };
}
const count = (seq, op) => seq.reduce((n, e) => n + (e[0] === op ? 1 : 0), 0);
const passVector = (seq) => seq.filter((e) => e[0] === 6).map((e) => `${e[1]}:${e[2]}`).join(",");

/* -- 1. detached: zero ops, flushPasses frozen ------------------------------- */
{
    const r = fixedRegistry(createRegistry);
    const s = r.signal(0);
    let runs = 0;
    r.effect(() => { s(); runs++; });
    const fp0 = r.stats().flushPasses;
    for (let i = 1; i <= 64; i++) s.set(i);
    R.eq("detached", r.stats().flushPasses - fp0, 0,
        "flushPasses must be FROZEN with no mutation-hook listener attached");
    R.eq("detached", runs, 1 + 64, "sanity: the effect itself still ran per write");
    r.destroy();
}

/* -- 2. fan burst: K effects, B-write batch -> K enqueues, ONE pass ---------- */
{
    const K = 8, B = 5;
    const r = fixedRegistry(createRegistry);
    const s = r.signal(0);
    const runs = new Int32Array(K);
    for (let i = 0; i < K; i++) { const idx = i; r.effect(() => { s(); runs[idx]++; }); }
    const { seq, hook } = makeRecorder();
    r.onGraphMutation(hook);
    const fp0 = r.stats().flushPasses;
    const runs0 = Array.from(runs);
    r.batch(() => { for (let w = 1; w <= B; w++) s.set(w); });

    R.eq("fan", count(seq, 7), K,
        `a ${B}-write batch over ${K} effects must emit exactly ${K} op-7s (enqueue coalescing)`);
    R.eq("fan", passVector(seq), `1:${K}`,
        "the burst must drain in exactly ONE pass with all K effects queued");
    R.eq("fan", r.stats().flushPasses - fp0, 1, "flushPasses must advance exactly once");
    let reruns = 0;
    for (let i = 0; i < K; i++) reruns += runs[i] - runs0[i];
    R.eq("fan", reruns, K, `coalescing == 1.0x: exactly ${K} body runs for the whole burst`);
    // op-7s precede the pass they feed: the K enqueues are recorded before op 6.
    R.eq("fan", seq.findIndex((e) => e[0] === 6), K,
        "op-7 fires at MARK time -- all K enqueues must precede the op-6 pass start");
    r.onGraphMutation(null);
    r.destroy();
}

/* -- 3. volume: N bursts -> exact linear accounting, zero drift -------------- */
{
    const K = 8;
    const r = fixedRegistry(createRegistry);
    const s = r.signal(0);
    const runs = new Int32Array(K);
    for (let i = 0; i < K; i++) { const idx = i; r.effect(() => { s(); runs[idx]++; }); }
    const { seq, hook } = makeRecorder();
    r.onGraphMutation(hook);
    const fp0 = r.stats().flushPasses;
    const runs0 = Array.from(runs);
    for (let n = 0; n < VOLUME; n++) {
        r.batch(() => { s.set(n * 3 + 1); s.set(n * 3 + 2); s.set(n * 3 + 3); });
    }
    R.eq("volume", count(seq, 6), VOLUME, `exactly ${VOLUME} passes over ${VOLUME} bursts`);
    R.eq("volume", count(seq, 7), VOLUME * K, `exactly ${VOLUME * K} enqueues (K per burst, never B*K)`);
    R.eq("volume", r.stats().flushPasses - fp0, VOLUME,
        "flushPasses total must agree with the op-6 count exactly");
    let ok = true;
    for (let i = 0; i < K; i++) ok = ok && (runs[i] - runs0[i] === VOLUME);
    R.ok("volume", ok, "every effect must have run exactly once per burst (no redundancy, no drops)");
    R.eq("volume", s.peek(), VOLUME * 3, "value sanity: last batched write won");
    r.onGraphMutation(null);
    r.destroy();
}

/* -- 4. cascade: a D-stage cross-effect chain drains in exactly D passes ----- */
{
    const D = 6;
    const r = fixedRegistry(createRegistry);
    const sigs = [];
    for (let i = 0; i <= D; i++) sigs.push(r.signal(0));
    let armed = false;
    for (let i = 0; i < D; i++) {
        const a = sigs[i], b = sigs[i + 1];
        r.effect(() => { const v = a(); if (armed) b.set(v + 1); });
    }
    armed = true;
    const { seq, hook } = makeRecorder();
    r.onGraphMutation(hook);
    const fp0 = r.stats().flushPasses;
    sigs[0].set(1);
    const expectPasses = Array.from({ length: D }, (_, i) => `${i + 1}:1`).join(",");
    R.eq("cascade", passVector(seq), expectPasses,
        `a ${D}-stage cascade must drain in exactly ${D} passes of 1 effect each (double-buffer contract)`);
    R.eq("cascade", count(seq, 7), D, "exactly one enqueue per stage");
    R.eq("cascade", r.stats().flushPasses - fp0, D, "flushPasses must count every cascade pass");
    R.eq("cascade", sigs[D].peek(), D + 1, "the value must have walked the whole chain");
    // Interleaving pin: stage i+1's enqueue happens DURING pass i, so the raw
    // stream alternates 7,6,7,6,... strictly.
    let alternates = seq.length === 2 * D;
    for (let i = 0; i < seq.length && alternates; i++) alternates = seq[i][0] === (i % 2 === 0 ? 7 : 6);
    R.ok("cascade", alternates, "op stream must strictly alternate enqueue/pass (7,6,7,6,...)");
    r.onGraphMutation(null);
    r.destroy();
}

/* -- 5. self-write: one pass, no re-enqueue, still responsive ---------------- */
{
    const r = fixedRegistry(createRegistry);
    const s = r.signal(0);
    let runs = 0;
    r.effect(() => { const v = s(); runs++; if (v === 5) s.set(6); });
    const { seq, hook } = makeRecorder();
    r.onGraphMutation(hook);
    const fp0 = r.stats().flushPasses;
    const runs0 = runs;
    s.set(5);   // body runs, self-writes 6 -- FLAG_COMPUTING guard blocks re-queue
    R.eq("self-write", passVector(seq), "1:1", "a self-write must NOT open a second pass");
    R.eq("self-write", count(seq, 7), 1, "the writing effect must not re-enqueue itself");
    R.eq("self-write", runs - runs0, 1, "the self-cycle must run exactly once");
    R.eq("self-write", s.peek(), 6, "the self-written value must land");
    R.eq("self-write", r.stats().flushPasses - fp0, 1, "exactly one pass on the stat too");
    // Documented follow-up contract: the effect stays responsive to EXTERNAL writes.
    seq.length = 0;
    s.set(9);
    R.eq("self-write", runs - runs0, 2, "a later external write must still fire the effect");
    R.eq("self-write", passVector(seq), "1:1", "and it drains in one ordinary pass");
    r.onGraphMutation(null);
    r.destroy();
}

/* -- 6. destroy() resets the counter ----------------------------------------- */
{
    const r = fixedRegistry(createRegistry);
    const s = r.signal(0);
    r.effect(() => { s(); });
    r.onGraphMutation(() => {});
    s.set(1); s.set(2);
    R.ok("destroy-reset", r.stats().flushPasses >= 2, "precondition: counter advanced while hooked");
    r.destroy();
    R.eq("destroy-reset", r.stats().flushPasses, 0, "destroy() must reset flushPasses to 0");
}

process.exit(R.finish(
    "op-6/7 flush lane exact: enqueue coalescing, pass accounting, stat agreement, self-write guard",
    { minAsserts: 20 }
));
