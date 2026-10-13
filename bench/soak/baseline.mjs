/**
 * @zakkster/lite-signal soak -- baseline diff of two burn-in streams (SPEC-S2 group B TASK 3; LP section 9
 * "Baseline: foreign schema -> INCOMPATIBLE; re-derived; overridden/red baselines refused. Diff late medians:
 * FAIL on heap > +2 MB (same Node major), quality 0 -> >0, missing lane; throughput -15% and p99 +25% are NOTE
 * only"; maintainer recommendation D-B4: a heap REGRESSION needs the same Node major AND runner class).
 *
 * PURE MODULE: no I/O, no process state, no clock. SoakReport.mjs `--baseline <stream>` (B-B5) loads and
 * RE-DERIVES both streams with its own integrity checks first, then calls diffBaseline(base, head). This module
 * re-derives nothing: it reads the records the re-derivation accepted.
 *
 *   diffBaseline(base, head) -> { verdict, exitCode, reason, detail, nodeMajor, runner, regressions, notes, lanes }
 *     base, head   { header, cycles, summary }: the stream's header record, its cycle records in stream order and
 *                  its summary record (the shapes of main.mjs / provenance.mjs; see "Fields read" below). A base or
 *                  head that is not an object, or whose cycles is not an array, throws TypeError (wrong container).
 *     verdict      BASELINE_VERDICT: the FIRST that applies, in this order
 *                    INCOMPATIBLE  the two streams cannot be compared (exit 2): schemaVersion differs between them
 *                                  or from this code's SCHEMA_VERSION, genVersion likewise, SOAK_ENGINE /
 *                                  SOAK_SMOKE differ, SOAK_OPS not an integer in [1, OPS_MAX] or SOAK_CYCLES not an
 *                                  integer in [0, CYCLES_MAX] on either side (null / NaN / string / out of range: reason config), or a header / summary / node / os field this diff needs is
 *                                  missing or unparsable (unknown is never comparable)
 *                    REFUSED       the base is not a green release-shaped stream (exit 2): verdict !== PASS or
 *                                  exitCode !== 0 (red, INCONCLUSIVE, SMOKE, PARTIAL), kernel.override !== false,
 *                                  controls.name !== null, mustfail !== null, or a base lane without a numeric
 *                                  late heap median / failingWorlds count
 *                    REGRESSION    exit 1: at least one regressions[] entry
 *                    NOTE          exit 0: no regression, at least one notes[] entry
 *                    PASS          exit 0 (no regression, no note)
 *     reason/detail  the INCOMPATIBLE / REFUSED cause (null otherwise)
 *     nodeMajor    { base, head } integers parsed from header.node (`v<major>.`); runner { base, head } strings
 *                  `<os.platform>/<os.arch>` (cpuModel is NOT part of the class: hosted runners vary it)
 *     regressions / notes   [{ kind, lane, detail }] in lane order (base perLane key order, then head-only lanes)
 *     lanes        [{ lane, heapLateMB: {base, head, delta}, failingWorlds: {base, head},
 *                     opsPerSec: {base, head, ratio}, p99Ns: {<class>: {base, head, ratio}} }]
 *                  a value that could not be measured is null (never 0)
 *
 * Rules, per base lane whose status is not SKIP (a PASS base ran every lane):
 *   missing-lane   REGRESSION: the lane is absent from head.perLane, SKIP there, or notRun
 *   heap           delta = round3(head late - base late) of perLane[lane].drift.heap.late (the summary's late
 *                  median residentMB, gates.mjs LaneGates.compute). delta > BASELINE_HEAP_MB -> REGRESSION when
 *                  nodeMajor, runner AND volume (config SOAK_OPS and SOAK_CYCLES) are equal, else a NOTE
 *                  (a forever run, SOAK_CYCLES 0, on either side -- or both -- states no volume and is never volume-comparable: NOTE;
 *                  orchestrator ruling, SPEC-B item 12: a volume difference is never INCOMPATIBLE, so the
 *                  volume-independent failingWorlds / missing-lane regressions still FAIL). A head late that is not a finite number ->
 *                  REGRESSION `heap` (unmeasured is never "no growth"), on any Node major.
 *                  Rounded to 3 decimals first so 12.1 - 10.1 (2.0000000000000004 in binary) is not > 2.
 *   failingWorlds  REGRESSION: base perLane[lane].totals.failingWorlds 0 and head > 0, or head not a count
 *   throughput     NOTE: late median opsPerSec head / base < 1 - BASELINE_THROUGHPUT_DROP (0.85); a late median
 *                  that is not a positive finite number on either side -> NOTE `throughput-unmeasured`
 *   p99            NOTE: per latency class present in the base's late window, late median p99Ns head / base >
 *                  1 + BASELINE_P99_RISE (1.25); a class the head did not measure -> NOTE `p99-unmeasured`.
 *                  Streams without cycle.latency (schema 1) compare no p99 and add no note.
 * Per head lane absent from base.perLane: NOTE `new-lane`.
 * "Late window" = the lane's last GATE_N cycle records with warmup false and interrupted false; its median is
 * NaN when any of those values is not a finite number (null is not zero) or the window is empty.
 *
 * Fields read: header {schemaVersion, genVersion, node, os {platform, arch}, kernel {override}, controls {name},
 * mustfail, config {SOAK_ENGINE, SOAK_SMOKE, SOAK_OPS, SOAK_CYCLES: {value}}} (provenance.mjs buildHeader; SoakReport.mjs:114);
 * cycle {lane, warmup, interrupted, throughput {opsPerSec}, latency {<class>: {p99Ns}} (schema 2, B-B4)}
 * (main.mjs:439-449); summary {verdict, exitCode, perLane {<lane>: {status, notRun, totals {failingWorlds},
 * drift {heap {late}}}}} (main.mjs:298-308, gates.mjs:505-519).
 *
 * The thresholds live here (BASELINE_*); B-B5 may move them into config.mjs CONSTANTS (header gates block).
 * COLD module.
 */

import { SCHEMA_VERSION, GEN_VERSION, GATE_N, VERDICT, OPS_MAX, CYCLES_MAX } from './config.mjs';

export const BASELINE_HEAP_MB = 2;
export const BASELINE_THROUGHPUT_DROP = 0.15;
export const BASELINE_P99_RISE = 0.25;

export const BASELINE_VERDICT = Object.freeze({
    PASS: 'PASS', NOTE: 'NOTE', REGRESSION: 'REGRESSION', REFUSED: 'REFUSED', INCOMPATIBLE: 'INCOMPATIBLE',
});
export const BASELINE_EXIT = Object.freeze({ PASS: 0, NOTE: 0, REGRESSION: 1, REFUSED: 2, INCOMPATIBLE: 2 });

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r3 = (x) => Math.round(x * 1000) / 1000;
const numOrNull = (x) => (isNum(x) ? x : null);

class Stop extends Error { constructor(verdict, reason, detail) { super(detail); this.verdict = verdict; this.reason = reason; } }
const incompatible = (reason, detail) => { throw new Stop(BASELINE_VERDICT.INCOMPATIBLE, reason, detail); };
const refused = (reason, detail) => { throw new Stop(BASELINE_VERDICT.REFUSED, reason, detail); };

/** Median of finite numbers; NaN when empty or when any value is not a finite number. */
function medianFinite(vals) {
    if (vals.length === 0) return NaN;
    for (const v of vals) if (!isNum(v)) return NaN;
    const a = vals.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** The lane's late window: the last GATE_N completed post-warm-up cycle records. */
function lateWindow(cycles, lane) {
    const out = [];
    for (const c of cycles) if (isObj(c) && c.lane === lane && c.warmup === false && c.interrupted === false) out.push(c);
    return out.slice(-GATE_N);
}

function nodeMajor(h, side) {
    const m = typeof h.node === 'string' ? /^v(\d+)\./.exec(h.node) : null;
    if (m === null) incompatible('node', side + ' header.node ' + JSON.stringify(h.node) + ' has no parsable major');
    return Number(m[1]);
}

function runnerClass(h, side) {
    const o = h.os;
    if (!(isObj(o) && typeof o.platform === 'string' && o.platform !== '' && typeof o.arch === 'string' && o.arch !== '')) {
        incompatible('runner', side + ' header.os has no platform / arch');
    }
    return o.platform + '/' + o.arch;
}

function configValue(h, key, side) {
    if (!(isObj(h.config) && isObj(h.config[key]) && own(h.config[key], 'value'))) incompatible('config', side + ' header.config.' + key + ' is missing');
    return h.config[key].value;
}

function checkShape(s, side) {
    if (!isObj(s)) throw new TypeError('diffBaseline: ' + side + ' must be { header, cycles, summary }');
    if (!Array.isArray(s.cycles)) throw new TypeError('diffBaseline: ' + side + '.cycles must be an array of cycle records');
    if (!isObj(s.header)) incompatible('header', side + ' has no header record');
    if (!isObj(s.summary)) incompatible('summary', side + ' has no summary record');
    if (!isObj(s.summary.perLane)) incompatible('summary', side + ' summary.perLane is missing');
}

function checkCompatible(base, head) {
    const b = base.header, h = head.header;
    if (b.schemaVersion !== h.schemaVersion) incompatible('schema', 'base schemaVersion ' + String(b.schemaVersion) + ' != head ' + String(h.schemaVersion));
    if (b.schemaVersion !== SCHEMA_VERSION) incompatible('schema', 'schemaVersion ' + String(b.schemaVersion) + ' != this code\'s ' + SCHEMA_VERSION);
    if (b.genVersion !== h.genVersion || b.genVersion !== GEN_VERSION) incompatible('schema', 'genVersion base ' + String(b.genVersion) + ' head ' + String(h.genVersion) + ' (this code ' + GEN_VERSION + ')');
    for (const k of ['SOAK_ENGINE', 'SOAK_SMOKE']) {
        const bv = configValue(b, k, 'base'), hv = configValue(h, k, 'head');
        if (bv !== hv) incompatible('config', k + ' base ' + JSON.stringify(bv) + ' != head ' + JSON.stringify(hv));
    }
}

function checkBaseGreen(base) {
    const h = base.header, s = base.summary;
    if (s.verdict !== VERDICT.PASS) refused('red', 'baseline verdict ' + JSON.stringify(s.verdict) + ' is not PASS (only a green run is a baseline)');
    if (s.exitCode !== 0) refused('red', 'baseline exitCode ' + JSON.stringify(s.exitCode) + ' is not 0');
    if (!(isObj(h.kernel) && h.kernel.override === false)) refused('overridden', 'baseline kernel.override ' + JSON.stringify(isObj(h.kernel) ? h.kernel.override : undefined) + ' (only a tree kernel is a baseline)');
    if (!(isObj(h.controls) && h.controls.name === null)) refused('overridden', 'baseline ran control kernel ' + JSON.stringify(isObj(h.controls) ? h.controls.name : undefined));
    if (h.mustfail !== null) refused('overridden', 'baseline ran a SOAK_MUSTFAIL teeth knob');
}

/** Late-window median p99Ns per latency class present in the window; null when no cycle carries latency. */
function latencyByClass(win) {
    let any = false;
    const classes = [];
    for (const c of win) {
        if (!isObj(c.latency)) continue;
        any = true;
        for (const k of Object.keys(c.latency)) if (classes.indexOf(k) === -1) classes.push(k);
    }
    if (!any) return null;
    const out = {};
    for (const k of classes) out[k] = medianFinite(win.map((c) => (isObj(c.latency) && isObj(c.latency[k]) ? c.latency[k].p99Ns : null)));
    return out;
}

export function diffBaseline(base, head) {
    try {
        checkShape(base, 'base');
        checkShape(head, 'head');
        checkCompatible(base, head);
        const major = { base: nodeMajor(base.header, 'base'), head: nodeMajor(head.header, 'head') };
        const runner = { base: runnerClass(base.header, 'base'), head: runnerClass(head.header, 'head') };
        // volume: SOAK_OPS a safe integer in (0, OPS_MAX]; SOAK_CYCLES a safe integer in [0, CYCLES_MAX] (0 = a forever run,
        // config.mjs allowZero). null === null is not "same volume": anything else is INCOMPATIBLE
        const volume = {
            base: [configValue(base.header, 'SOAK_OPS', 'base'), configValue(base.header, 'SOAK_CYCLES', 'base')],
            head: [configValue(head.header, 'SOAK_OPS', 'head'), configValue(head.header, 'SOAK_CYCLES', 'head')],
        };
        for (const side of ['base', 'head']) {
            for (let k = 0; k < 2; k++) {
                const v = volume[side][k];
                const okv = k === 0 ? (Number.isSafeInteger(v) && v > 0 && v <= OPS_MAX) : (Number.isSafeInteger(v) && v >= 0 && v <= CYCLES_MAX);
                if (!okv) incompatible('config', side + ' ' + (k === 0 ? 'SOAK_OPS' : 'SOAK_CYCLES') + ' ' + String(v) + ' is not ' + (k === 0 ? 'an integer in [1, ' + OPS_MAX + ']' : 'an integer in [0, ' + CYCLES_MAX + ']'));
            }
        }
        checkBaseGreen(base);
        // a forever run (SOAK_CYCLES 0) states no volume: it is never comparable, even against another forever run
        const sameVolume = volume.base[0] === volume.head[0] && volume.base[1] === volume.head[1] && volume.base[1] > 0 && volume.head[1] > 0;
        // comparable heap: same Node major, runner class AND volume (SPEC-B item 12 ruling); else a heap delta is a NOTE
        const sameHost = major.base === major.head && runner.base === runner.head && sameVolume;
        const regressions = [], notes = [], lanes = [];
        const bp = base.summary.perLane, hp = head.summary.perLane;
        const baseLanes = Object.keys(bp).filter((k) => !(isObj(bp[k]) && bp[k].status === 'SKIP'));
        // a red base lane is refused before any diff entry is built (the whole base is unusable)
        for (const lane of baseLanes) {
            const L = bp[lane];
            if (!(isObj(L) && isObj(L.drift) && isObj(L.drift.heap) && isNum(L.drift.heap.late))) refused('lane', 'baseline lane ' + lane + ' has no numeric late heap median');
            if (!(isObj(L.totals) && isCount(L.totals.failingWorlds))) refused('lane', 'baseline lane ' + lane + ' has no failingWorlds count');
        }
        for (const lane of baseLanes) {
            const B = bp[lane], H = own(hp, lane) ? hp[lane] : null;
            const row = { lane, heapLateMB: { base: B.drift.heap.late, head: null, delta: null }, failingWorlds: { base: B.totals.failingWorlds, head: null }, opsPerSec: { base: null, head: null, ratio: null }, p99Ns: {} };
            lanes.push(row);
            if (!isObj(H) || H.status === 'SKIP' || H.notRun === true) {
                regressions.push({ kind: 'missing-lane', lane, detail: 'lane ' + lane + ' ran in the baseline but ' + (!isObj(H) ? 'is absent from' : (H.status === 'SKIP' ? 'was SKIPPED in' : 'ran no cycle in')) + ' the head' });
                continue;
            }
            // heap
            const hl = isObj(H.drift) && isObj(H.drift.heap) ? H.drift.heap.late : undefined;
            if (!isNum(hl)) {
                regressions.push({ kind: 'heap', lane, detail: 'head late heap median ' + String(hl) + ' is unmeasured (base ' + B.drift.heap.late + 'MB)' });
            } else {
                const delta = r3(hl - B.drift.heap.late);
                row.heapLateMB.head = hl;
                row.heapLateMB.delta = delta;
                if (!(delta <= BASELINE_HEAP_MB)) {
                    const d = 'late heap median ' + B.drift.heap.late + 'MB -> ' + hl + 'MB (+' + delta + 'MB > +' + BASELINE_HEAP_MB + 'MB)';
                    if (sameHost) regressions.push({ kind: 'heap', lane, detail: d });
                    else notes.push({ kind: 'heap', lane, detail: d + ' across node v' + major.base + ' ' + runner.base + ' ops x cycles ' + volume.base.join(' x ') + ' -> v' + major.head + ' ' + runner.head + ' ' + volume.head.join(' x ') + ' (not comparable: NOTE only)' });
                }
            }
            // failingWorlds (quality 0 -> > 0)
            const hf = isObj(H.totals) ? H.totals.failingWorlds : undefined;
            if (!isCount(hf)) regressions.push({ kind: 'failingWorlds', lane, detail: 'head failingWorlds ' + String(hf) + ' is not a count' });
            else {
                row.failingWorlds.head = hf;
                if (B.totals.failingWorlds === 0 && hf > 0) regressions.push({ kind: 'failingWorlds', lane, detail: 'failingWorlds 0 -> ' + hf });
            }
            // throughput (NOTE only)
            const bw = lateWindow(base.cycles, lane), hw = lateWindow(head.cycles, lane);
            const bo = medianFinite(bw.map((c) => (isObj(c.throughput) ? c.throughput.opsPerSec : null)));
            const ho = medianFinite(hw.map((c) => (isObj(c.throughput) ? c.throughput.opsPerSec : null)));
            row.opsPerSec.base = numOrNull(bo);
            row.opsPerSec.head = numOrNull(ho);
            if (!(bo > 0 && ho > 0)) notes.push({ kind: 'throughput-unmeasured', lane, detail: 'late median opsPerSec base ' + String(row.opsPerSec.base) + ' head ' + String(row.opsPerSec.head) });
            else {
                row.opsPerSec.ratio = r3(ho / bo);
                if (ho / bo < 1 - BASELINE_THROUGHPUT_DROP) notes.push({ kind: 'throughput', lane, detail: 'late median opsPerSec ' + bo + ' -> ' + ho + ' (x' + row.opsPerSec.ratio + ' < x' + r3(1 - BASELINE_THROUGHPUT_DROP) + ')' });
            }
            // p99 per latency class (NOTE only; schema-1 streams carry no latency)
            const bl = latencyByClass(bw), hlc = latencyByClass(hw);
            if (bl !== null) {
                for (const k of Object.keys(bl)) {
                    const b99 = bl[k], h99 = hlc !== null && own(hlc, k) ? hlc[k] : NaN;
                    const cell = { base: numOrNull(b99), head: numOrNull(h99), ratio: null };
                    row.p99Ns[k] = cell;
                    if (!(b99 > 0 && h99 > 0)) notes.push({ kind: 'p99-unmeasured', lane, detail: 'latency ' + k + ' late median p99Ns base ' + String(cell.base) + ' head ' + String(cell.head) });
                    else {
                        cell.ratio = r3(h99 / b99);
                        if (h99 / b99 > 1 + BASELINE_P99_RISE) notes.push({ kind: 'p99', lane, detail: 'latency ' + k + ' late median p99Ns ' + b99 + ' -> ' + h99 + ' (x' + cell.ratio + ' > x' + r3(1 + BASELINE_P99_RISE) + ')' });
                    }
                }
            }
        }
        for (const lane of Object.keys(hp)) {
            if (baseLanes.indexOf(lane) === -1 && !(isObj(hp[lane]) && hp[lane].status === 'SKIP')) notes.push({ kind: 'new-lane', lane, detail: 'lane ' + lane + ' ran in the head but not in the baseline (nothing to compare)' });
        }
        const verdict = regressions.length > 0 ? BASELINE_VERDICT.REGRESSION : (notes.length > 0 ? BASELINE_VERDICT.NOTE : BASELINE_VERDICT.PASS);
        return { verdict, exitCode: BASELINE_EXIT[verdict], reason: null, detail: null, nodeMajor: major, runner, regressions, notes, lanes };
    } catch (e) {
        if (!(e instanceof Stop)) throw e;
        return { verdict: e.verdict, exitCode: BASELINE_EXIT[e.verdict], reason: e.reason, detail: e.message, nodeMajor: null, runner: null, regressions: [], notes: [], lanes: [] };
    }
}
