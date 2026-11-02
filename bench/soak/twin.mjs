/**
 * @zakkster/lite-signal soak -- the TWIN runner (R7 group B task 1, burst 148; PLAN-R7-box.md C-1, C-3, C-14, C-15,
 * C-25, C-27). One world script runs on a PRIMARY adapter and on its TWIN (contract.mjs TWINS: lite -> lite-box/alt),
 * each through trace.mjs traceAdapter into its own hash-only sink; the OT oracle (oracles.mjs checkTrace) compares
 * the two traces line by line.
 *
 *   runWorldTwin(desc, ad, twinAd, script, opts?) -> a runWorld()-shaped result
 *     desc     the lane descriptor of the script (desc.name === script.lane, else TypeError)
 *     ad       the primary adapter; twinAd the twin adapter (both contract adapters with open())
 *     opts     forwarded unchanged to BOTH exec.mjs runWorld calls (creationAbort / laneOps / trace)
 *
 * Per side: a FRESH sink, a fresh world (runWorld opens one), then the verdict line `V <json {failure, checks}>`
 * (appendTraceLine, C-14) so two runs that agree on every call but not on the oracle verdict still differ. The sink
 * step column (C-15) is driven HERE (exec.runWorld has no per-step hook, C-25): runWorld gets a shallow script copy
 * whose ops is a Proxy over script.ops; reading ops[k] stamps step k, reading ops.length stamps (last k) + 1, so a
 * line written by the end check, the teardown or the V line carries step ops.length.
 *
 * On an OT diff the pair is RE-RUN (fresh worlds again) with sinks keeping text for lines [at - 3, at + 1) (C-1), so
 * the failure detail shows the differing lines (C-27 format); a re-run that does not reproduce the same `at` keeps
 * the hash-only failure and says so in its detail (fail closed: the diff stands).
 *
 * Result: ops / opsByClass / gateHits / skipTainted / trace from the PRIMARY; checks = primary checks + OT: 1 (C-9:
 * OT joins exec CHECK_NAMES only in C1); failure = the primary failure, with the OT failure appended to its fails[]
 * when the traces differ; a clean primary -> the OT failure ({step, op, fails: [OT], scen: []}, step = the step
 * column of the first differing line, op = that script op's name or 'end') or null. scen = the primary counts plus
 * 'box-trace-equal' 1 (traces equal) and 'box-interop' = cross-kind reads (world.boxCounts().crossRead, lite-box
 * only) summed over both sides; a key is present only when its count is > 0 (Detectors.counts convention).
 *
 * Retention: nothing outlives the call -- the sinks, the worlds and the tap holders are locals; the result holds
 * numbers, strings and the primary's own result objects only. COLD module: never on a measured path.
 */

import { runWorld } from './exec.mjs';
import { checkTrace } from './oracles.mjs';
import { makeTraceSink, traceAdapter, appendTraceLine, setTraceStep } from './trace.mjs';

const COUNTER_CAP = 0x3FFFFFFF;   // scenario counts stay Smi (exec.mjs COUNTER_CAP)
const KEEP_BEFORE = 3;            // C-1: the re-run keeps [at - 3, at + 1)

function isAdapter(a) {
    return a !== null && typeof a === 'object' && typeof a.open === 'function';
}

/** The Proxy handler that drives sink's step column from exec's reads of script.ops (one per side per run). */
function stepHandler(sink) {
    let last = -1;
    return {
        get(t, p) {
            if (p === 'length') { setTraceStep(sink, last + 1); return t.length; }
            if (typeof p === 'string') {
                const k = +p;
                if (k >= 0 && k < t.length && (k | 0) === k) { last = k; setTraceStep(sink, k); }
            }
            return t[p];
        },
    };
}

/** Run one side: trace ad into sink, run the world, append the verdict line. Returns { r, crossRead }. */
function runSide(ad, script, sink, opts) {
    const traced = traceAdapter(ad, sink);
    const hold = { w: null };
    const tap = {
        name: traced.name, version: traced.version, files: traced.files, knownAs: traced.knownAs, caps: traced.caps,
        open(o) { const w = traced.open(o); hold.w = w; return w; },
    };
    if (Object.hasOwn(traced, 'mode')) tap.mode = traced.mode;
    const s = Object.assign({}, script, { ops: new Proxy(script.ops, stepHandler(sink)) });
    const r = runWorld(tap, s, opts);
    appendTraceLine(sink, 'V ' + JSON.stringify({ failure: r.failure, checks: r.checks }));
    let crossRead = 0;
    const w = hold.w;
    hold.w = null;
    if (w !== null && typeof w.boxCounts === 'function') {
        const c = w.boxCounts();
        if (c !== null && typeof c === 'object' && Number.isInteger(c.crossRead) && c.crossRead > 0) crossRead = c.crossRead;
    }
    return { r, crossRead };
}

/** One traced pair run on fresh worlds and fresh sinks (keep: undefined = hash-only, or a [lo, hi) window). */
function runPair(ad, twinAd, script, opts, keep) {
    const sa = keep === undefined ? makeTraceSink() : makeTraceSink({ keep });
    const sb = keep === undefined ? makeTraceSink() : makeTraceSink({ keep });
    const a = runSide(ad, script, sa, opts);
    const b = runSide(twinAd, script, sb, opts);
    const ot = checkTrace(sa, sb);
    let step = -1;
    if (ot !== null) step = ot.at < sa.n ? sa.step[ot.at] : sb.step[ot.at];
    return { a, b, ot, step };
}

export function runWorldTwin(desc, ad, twinAd, script, opts) {
    if (desc === null || typeof desc !== 'object' || typeof desc.name !== 'string') throw new TypeError('twin: runWorldTwin(desc, ...) desc must be a lane descriptor');
    if (!isAdapter(ad)) throw new TypeError('twin: runWorldTwin(desc, ad, ...) ad must be an adapter');
    if (!isAdapter(twinAd)) throw new TypeError('twin: runWorldTwin(desc, ad, twinAd, ...) twinAd must be an adapter');
    if (script === null || typeof script !== 'object' || !Array.isArray(script.ops)) throw new TypeError('twin: runWorldTwin script must be a gen.mjs script');
    if (script.lane !== desc.name) throw new TypeError('twin: script lane ' + String(script.lane) + ' is not desc ' + desc.name);

    const p = runPair(ad, twinAd, script, opts, undefined);
    const prim = p.a.r;
    let ot = p.ot;
    let otStep = p.step;
    if (ot !== null) {
        const lo = ot.at > KEEP_BEFORE ? ot.at - KEEP_BEFORE : 0;
        const q = runPair(ad, twinAd, script, opts, [lo, ot.at + 1]);
        if (q.ot !== null && q.ot.at === ot.at) { ot = q.ot; otStep = q.step; }
        else ot = { oracle: 'OT', sig: 'trace-diff', at: ot.at, detail: (ot.detail + ' (re-run: ' + (q.ot === null ? 'equal' : 'at ' + q.ot.at) + ')').slice(0, 240) };
    }

    const scen = Object.create(null);
    for (const k of Object.keys(prim.scen)) scen[k] = prim.scen[k];
    if (ot === null) scen['box-trace-equal'] = 1;
    const cross = p.a.crossRead + p.b.crossRead;
    if (cross > 0) scen['box-interop'] = cross < COUNTER_CAP ? cross : COUNTER_CAP;

    const checks = Object.assign({}, prim.checks, { OT: 1 });

    let failure = prim.failure;
    if (ot !== null) {
        if (failure !== null) failure = { step: failure.step, op: failure.op, fails: failure.fails.concat([ot]), scen: failure.scen };
        else {
            const ops = script.ops;
            failure = { step: otStep, op: otStep >= 0 && otStep < ops.length ? ops[otStep].o : 'end', fails: [ot], scen: [] };
        }
    }
    return {
        failure, scen, checks, skipTainted: prim.skipTainted, gateHits: prim.gateHits,
        ops: prim.ops, opsByClass: prim.opsByClass, trace: prim.trace,
    };
}
