/**
 * test/50 -- the soak HTML report and the baseline diff (SPEC-S2-groupB tasks 2-3, ASSERTIONS 5; LP section 9).
 *
 * Expected values come from the plan text: escaping of & < > " ', `</script>` rendering as `&lt;/script&gt;`, a
 * missing value rendering `n/a` (never 0), a self-contained page (no remote src/href), and the baseline policy:
 * different schema -> INCOMPATIBLE; late heap median > +2 MB on the same Node major -> REGRESSION (+2.1 MB), +1.9 MB
 * -> PASS, another Node major -> NOTE; failingWorlds 0 -> > 0 REGRESSION; a missing lane REGRESSION; throughput -15%
 * and p99 +25% are NOTEs only.
 *
 * Fixtures use the real record keys of bench/soak/main.mjs cycle records / SoakReport.mjs (lane, cycle, worlds, ops,
 * failingWorlds, memory.residentMB, throughput.opsPerSec, gc.maxPauseMs) plus the plan's new keys (rss.p95MB,
 * latency{class:{n,p50Ns,p99Ns,belowFloor}}).
 *
 * ASSUMPTIONS (shapes the plan does not fix):
 *   - base and head are parsed streams {header, cycles, summary} (cycles = array of cycle records);
 *   - diffBaseline returns an object with a string `verdict` (PASS | REGRESSION | NOTE | INCOMPATIBLE) and may carry
 *     `exitCode`. For the NOTE-only cases the overall verdict is accepted as PASS or NOTE (a PASS carrying notes) but
 *     the result must mention NOTE and must not be REGRESSION / INCOMPATIBLE and, if exitCode exists, it is 0;
 *     REGRESSION and INCOMPATIBLE are asserted exactly (exitCode 1 for REGRESSION if present);
 *   - the heap REGRESSION result names `heap` somewhere in its text; the lane regression names the lane;
 *   - renderHtml returns a string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderHtml } from '../bench/soak/report-html.mjs';
import { diffBaseline } from '../bench/soak/baseline.mjs';
import { SCHEMA_VERSION, GEN_VERSION, KNOWN_KEYS } from '../bench/soak/config.mjs';

/* ---- escapeHtml -------------------------------------------------------------------------------------- */

test('escapeHtml: & < > " \' each become an entity, & first (no double escaping)', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.ok(['&#39;', '&#x27;', '&apos;'].includes(escapeHtml("'")), "apostrophe entity: " + escapeHtml("'"));
    const all = escapeHtml('<a href="x" onclick=\'y\'>&</a>');
    assert.ok(!/[<>"']/.test(all), 'no raw markup character survives: ' + all);
    assert.ok(all.includes('&lt;a href=&quot;x&quot;'));
    assert.equal(escapeHtml('a&lt;b'), 'a&amp;lt;b', 'an existing entity is escaped, not trusted');
    assert.equal(escapeHtml('plain 123'), 'plain 123');
});

/* ---- renderHtml fixtures ----------------------------------------------------------------------------- */

const LANES = ['BATCH', 'GRAPH'];
// Real shapes: cycle records = main.mjs:439-449 (memory = boundary.mjs {heapUsedMB, arrayBuffersMB, residentMB, rssMB}, gc =
// {major, minor, maxPauseMs} or null, warmup, interrupted); summary.perLane[lane] = gates.mjs LaneGates.compute()
// (status, cycles, postWarmup, totals, failureCounts, drift.heap {early, late, limit, status}, retention); header = provenance
// buildHeader keys (SoakReport.mjs RECORD_KEYS.header), config entries {value, source}. No committed golden stream exists, so
// the fixture is built here from those producers and only the field under test is mutated per case.
function cycle(lane, n, over) {
    return Object.assign({
        type: 'cycle', seq: 0, tMs: n * 1000, lane, laneIndex: LANES.indexOf(lane), cycle: n, warmup: n <= 1, seed: n, interrupted: false,
        worlds: 100, largeWorlds: 2, ops: 100000, opsByClass: {}, checks: {}, skipTainted: {},
        failures: [], failureCounts: {}, failingWorlds: 0, scenarios: {}, gateHits: {},
        throughput: { wallMs: 1000, opsPerSec: 100000 },
        memory: { heapUsedMB: 30, arrayBuffersMB: 1, residentMB: 40, rssMB: 120 },
        boundary: { lane, cycle: n, worlds: 100, tracked: 100, witnessed: 100, trackerSize: 0, weakAlive: 0, forcedGcTries: 1, drainMs: 1, heapSampledAfterGc: true },
        gc: { major: 0, minor: 3, maxPauseMs: 2 },
        rss: { samples: 100, p95MB: 120, maxMB: 125, stride: 1 },
        latency: { set: { n: 100, p50Ns: 200, p99Ns: 1000, belowFloor: 0 } },
    }, over || {});
}
const mkCycles = (n, over) => { const out = []; for (let c = 1; c <= n; c++) for (const l of LANES) out.push(cycle(l, c, over ? over(l, c) : null)); return out; };
const medianRes = (cs) => { const v = cs.map((c) => c.memory && c.memory.residentMB).filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
function header(over) {
    const cfg = {};
    for (const k of KNOWN_KEYS) cfg[k] = { value: null, source: 'default' };
    Object.assign(cfg, { SOAK_SMOKE: { value: false, source: 'default' }, SOAK_CYCLES: { value: 12, source: 'default' }, SOAK_OPS: { value: 100000, source: 'default' },
        SOAK_SEED: { value: 0xC0FFEE, source: 'default' }, SOAK_LANES: { value: LANES.slice(), source: 'default' }, SOAK_ENGINE: { value: 'lite', source: 'default' } });
    return Object.assign({
        type: 'header', seq: 0, tMs: 0, schemaVersion: SCHEMA_VERSION, genVersion: GEN_VERSION, kind: 'burn-in', pkgVersion: '1.6.0',
        startedAt: '2026-10-13T00:00:00.000Z', gitSha: 'abc1234', gitDirty: false, gitError: null,
        kernel: { path: 'Signal.js', override: false }, engine: 'lite', parity: {}, controls: { name: null, error: null },
        node: 'v26.8.2', v8: '14.0', execArgv: [], os: { platform: 'linux', arch: 'x64' }, config: cfg, laneRoster: LANES.slice(), lanes: LANES.slice(),
        scenarios: [], oraclesNA: {}, genRules: [], divergences: [], mustfail: null, timerFloorNs: 30,
    }, over || {});
}
function stream(cycles, hdr) {
    const perLane = {}, tot = { worlds: 0, ops: 0, failingWorlds: 0 };
    for (const l of LANES) {
        const mine = cycles.filter((c) => c.lane === l);
        const fw = mine.reduce((a, c) => a + c.failingWorlds, 0);
        const late = medianRes(mine);
        tot.worlds += mine.reduce((a, c) => a + c.worlds, 0); tot.ops += mine.reduce((a, c) => a + c.ops, 0); tot.failingWorlds += fw;
        perLane[l] = {
            status: fw ? 'FAIL' : 'PASS', cycles: mine.length, postWarmup: Math.max(0, mine.length - 1),
            totals: { worlds: mine.length * 100, ops: mine.length * 100000, failingWorlds: fw, checks: {}, skipTainted: {} }, failureCounts: {}, scenarioMissing: [],
            drift: { heap: { early: late, late, limit: late === null ? null : late * 1.5 + 8, status: 'PASS' } },
            retention: { badBoundaries: 0, unmeasured: 0 }, causes: [],
        };
    }
    return {
        header: header(hdr),
        cycles,
        summary: { type: 'summary', seq: 1, tMs: 99999, reason: 'end', cyclesRun: cycles.length, lanesRun: LANES.length, totals: tot, perLane, breaches: [], inconclusive: [], skipped: [], smoke: false, verdict: 'PASS', exitCode: 0 },
    };
}
const ok = () => stream(mkCycles(12));

const P = '</script><img src=x onerror=1>';
// keep the structural keys (only STRING VALUES and perLane / latency / p99Ns / config keys carry the payload)
function evilStream(s) {
    const cycles = s.cycles.map((c) => Object.assign({}, c, { lane: P + c.lane }));
    const header = Object.assign({}, s.header, {
        pkgVersion: P + '1', startedAt: P + 't', gitSha: '<img src=x>' + P, gitError: P + 'e', node: P + 'v26', v8: P + 'v8',
        os: { platform: P + 'p', arch: P + 'a', cpuModel: P + 'c' }, kernel: { path: P, override: P },
        config: Object.assign({}, s.header.config, { SOAK_CYCLES: { value: P, source: 'env' }, SOAK_OPS: { value: P, source: 'env' }, SOAK_SEED: { value: P, source: 'env' },
            SOAK_LANES: { value: [P, P + 'b'], source: 'env' }, SOAK_SMOKE: { value: P, source: 'env' } }),
        controls: { name: P, error: P }, engine: { name: P }, parity: { ok: P }, timerFloorNs: P,
    });
    const pl = {};
    for (const k of Object.keys(s.summary.perLane)) pl[P + k] = Object.assign({}, s.summary.perLane[k], { status: P + 's', causes: [P + 'c'] });
    const summary = Object.assign({}, s.summary, {
        reason: P + 'r', verdict: P + 'v', perLane: pl,
        breaches: [{ gate: P + 'g', lane: P + 'l', sig: P + 's', known: P + 'k', replay: P + 'r', detail: P + 'd' }, { oracle: P + 'o', lane: P, detail: P }],
        inconclusive: [P + 'inc1', P + 'inc2'],
    });
    return { header, cycles, summary };
}

const headWith = (delta, hdr) => stream(mkCycles(12, () => ({ memory: { heapUsedMB: 30, arrayBuffersMB: 1, residentMB: 40 + delta, rssMB: 120 } })), hdr);
const baseStream = () => stream(mkCycles(12, () => ({ memory: { heapUsedMB: 30, arrayBuffersMB: 1, residentMB: 40, rssMB: 120 } })));

test('renderHtml: an XSS payload in EVERY printed string field (header / <title> / lane names / reasons / causes / breaches / config / diff / lines) leaves no raw <script or <img', () => {
    const e = evilStream(ok());
    const diff = diffBaseline(baseStream(), headWith(3));          // a real, full diff result ...
    diff.verdict = P; diff.reason = P; diff.detail = P; diff.runner = { base: P, head: P }; diff.nodeMajor = { base: P, head: P };
    diff.regressions = [{ kind: P, lane: P, detail: P }]; diff.notes = [{ kind: P, lane: P, detail: P }];
    diff.lanes = [{ lane: P, heapLateMB: { base: 1, head: 2, delta: 1 }, failingWorlds: { base: 0, head: 0 }, opsPerSec: { base: 1, head: 1, ratio: 1 }, p99Ns: { [P]: { base: 1, head: 2, ratio: 2 } } }];
    const html = renderHtml({ header: e.header, cycles: e.cycles, summary: e.summary, lines: [P, 'INTEGRITY -- ' + P], diff });
    assert.equal(typeof html, 'string');
    assert.ok(html.includes('&lt;/script&gt;&lt;img src=x onerror=1&gt;'), 'escaped form present');
    assert.ok(!/<\/?script/i.test(html), 'no raw script tag anywhere');
    assert.ok(!/<img/i.test(html), 'no raw img tag anywhere');
    assert.ok(!/onerror=1>/.test(html.replace(/&lt;[^&]*onerror=1&gt;/g, '')), 'no unescaped handler tail');
});

// Markup assumption: one <tr> per lane with <td> cells in the documented column order (sparkline table: lane, cycles,
// residentMB, rss p95, opsPerSec, gc, latency; summary lane table: lane, status, cycles, post, failingWorlds, heap early,
// heap late, ...). Spec side: a missing value is exactly `n/a`, never 0.
const cellsOf = (html, first, second) => {
    const re = /<tr>(.*?)<\/tr>/g; let m;
    while ((m = re.exec(html)) !== null) {
        const cells = [...m[1].matchAll(/<td>(.*?)<\/td>/g)].map((x) => x[1]);
        if (cells.length >= 7 && cells[0] === first && cells[1] === second) return cells;
    }
    return null;
};

test('renderHtml: a missing GRAPH residentMB cell and a missing heap-late cell are exactly n/a (a text(null) -> 0 mutant is red)', () => {
    const cycles = mkCycles(12, (l) => (l === 'GRAPH' ? { memory: { residentMB: undefined } } : null));
    const s = stream(cycles);
    s.summary.perLane.GRAPH.drift = { heap: { early: null, late: null, limit: null, status: 'PASS' } };
    const html = renderHtml({ header: s.header, cycles, summary: s.summary, lines: [], diff: null });
    const spark = cellsOf(html, 'GRAPH', '12');                      // sparkline row: lane, cycles, residentMB, ...
    assert.ok(spark, 'GRAPH sparkline row');
    assert.equal(spark[2], '<span class="na">n/a</span>', 'GRAPH residentMB series has no finite value');
    assert.ok(/<svg\b/.test(cellsOf(html, 'BATCH', '12')[2]), 'control: BATCH residentMB draws an svg');
    const lane = cellsOf(html, 'GRAPH', 'PASS');                     // summary row: lane, status, cycles, post, failingWorlds, early, late
    assert.ok(lane, 'GRAPH summary row');
    assert.equal(lane[5], 'n/a', 'heap early cell');
    assert.equal(lane[6], 'n/a', 'heap late cell');
    const good = ok();
    const goodLane = cellsOf(renderHtml({ header: good.header, cycles: good.cycles, summary: good.summary, lines: [], diff: null }), 'GRAPH', 'PASS');
    assert.equal(goodLane[6], '40', 'control: a measured late heap prints its value');
});

test('renderHtml: a missing value never leaks undefined / NaN / null text', () => {
    const cycles = mkCycles(12, (l) => (l === 'GRAPH' ? { rss: undefined, latency: undefined, gc: null, memory: { residentMB: undefined } } : null));
    const s = stream(cycles);
    const html = renderHtml({ header: s.header, cycles, summary: s.summary, lines: [], diff: null });
    assert.ok(html.includes('n/a'));
    assert.ok(!/\bundefined\b|\bNaN\b|\bnull\b/.test(html), 'no leaked JS value text');
});

test('renderHtml: self-contained (no remote src / href / link / import / url(), no script)', () => {
    const s = ok();
    const html = renderHtml({ header: s.header, cycles: s.cycles, summary: s.summary, lines: ['soak:report: stream records=1'], diff: null });
    assert.ok(html.length > 200);
    assert.ok(!/(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html), 'no remote src/href');
    assert.ok(!/<link\b|<script\b/i.test(html), 'no <link> / <script>');
    assert.ok(!/@import|url\(\s*["']?https?:/i.test(html), 'no CSS import');
    assert.ok(/<svg\b/i.test(html), 'inline SVG sparklines');
    assert.ok(html.includes('BATCH') && html.includes('GRAPH'), 'one section per lane');
});

/* ---- diffBaseline ------------------------------------------------------------------------------------ */

const jsonOf = (r) => JSON.stringify(r);
const top = (r) => { assert.equal(typeof r.verdict, 'string', jsonOf(r)); return r.verdict; };
function assertNote(r, why, kind) {
    assert.equal(top(r), 'NOTE', why + ': ' + jsonOf(r));
    assert.equal(r.exitCode, 0, why + ' exit');
    assert.ok(r.regressions.length === 0, why + ': no regression');
    if (kind) assert.ok(r.notes.some((n) => n.kind === kind), why + ': a ' + kind + ' note');
}

test('diffBaseline: a stream against itself is PASS with no regression', () => {
    const r = diffBaseline(baseStream(), baseStream());
    assert.equal(top(r), 'PASS', jsonOf(r));
    assert.ok(!/REGRESSION|INCOMPATIBLE/.test(jsonOf(r)));
    if (r.exitCode !== undefined) assert.equal(r.exitCode, 0);
});

test('diffBaseline: late heap +2.1 MB on the same Node major is REGRESSION heap; +1.9 MB is PASS', () => {
    const bad = diffBaseline(baseStream(), headWith(2.1));
    assert.equal(top(bad), 'REGRESSION', jsonOf(bad));
    assert.match(jsonOf(bad), /heap/i);
    if (bad.exitCode !== undefined) assert.equal(bad.exitCode, 1);
    const good = diffBaseline(baseStream(), headWith(1.9));
    assert.equal(top(good), 'PASS', jsonOf(good));
    assert.ok(!/REGRESSION/.test(jsonOf(good)));
    if (good.exitCode !== undefined) assert.equal(good.exitCode, 0);
});

test('diffBaseline: the same +2.1 MB on a different Node major is a NOTE, not a REGRESSION', () => {
    const r = diffBaseline(baseStream(), headWith(2.1, { node: 'v24.1.0' }));
    assertNote(r, 'node major differs', 'heap');
    assert.notEqual(top(r), 'REGRESSION');
});

test('diffBaseline: a different schemaVersion is INCOMPATIBLE', () => {
    const head = baseStream(); head.header.schemaVersion = SCHEMA_VERSION + 1;
    const r = diffBaseline(baseStream(), head);
    assert.equal(top(r), 'INCOMPATIBLE', jsonOf(r));
});

test('diffBaseline: failingWorlds 0 -> > 0 is REGRESSION', () => {
    const cycles = mkCycles(12, (l, c) => (l === 'GRAPH' && c === 12 ? { failingWorlds: 3 } : null));
    const head = stream(cycles);
    const r = diffBaseline(baseStream(), head);
    assert.equal(top(r), 'REGRESSION', jsonOf(r));
    assert.match(jsonOf(r), /failingWorlds|GRAPH/);
});

test('diffBaseline: a lane present in the baseline but absent from the head is REGRESSION', () => {
    const head = stream(mkCycles(12).filter((c) => c.lane !== 'GRAPH'));
    delete head.summary.perLane.GRAPH;
    const r = diffBaseline(baseStream(), head);
    assert.equal(top(r), 'REGRESSION', jsonOf(r));
    assert.match(jsonOf(r), /GRAPH/);
});

test('diffBaseline: a different runner class (darwin vs linux) makes a +2.1 MB heap delta a NOTE', () => {
    const head = headWith(2.1); head.header.os = { platform: 'darwin', arch: 'arm64' };
    assertNote(diffBaseline(baseStream(), head), 'runner class differs', 'heap');
});

// Thresholds: throughput FAILS the NOTE only strictly below 0.85x, p99 strictly above 1.25x. The exact boundary values
// (85000, 1250) are PASS, so the rows use a clear breach (80000 / 1300) and a clear control (90000 / 1200).
test('diffBaseline: throughput -20% is a NOTE only; -10% is PASS', () => {
    const mk = (ops) => stream(mkCycles(12, () => ({ throughput: { wallMs: 1000, opsPerSec: ops } })));
    assertNote(diffBaseline(baseStream(), mk(80000)), 'throughput -20%', 'throughput');
    const ok = diffBaseline(baseStream(), mk(90000));
    assert.equal(top(ok), 'PASS', jsonOf(ok));
});

test('diffBaseline: p99 latency 1.3x is a NOTE only; 1.2x is PASS', () => {
    const mk = (p99) => stream(mkCycles(12, () => ({ latency: { set: { n: 100, p50Ns: 200, p99Ns: p99, belowFloor: 0 } } })));
    assertNote(diffBaseline(baseStream(), mk(1300)), 'p99 x1.3', 'p99');
    const ok = diffBaseline(baseStream(), mk(1200));
    assert.equal(top(ok), 'PASS', jsonOf(ok));
});

test('diffBaseline: a differing SOAK_OPS / SOAK_CYCLES is not INCOMPATIBLE: heap +3 MB is a NOTE, failingWorlds 0 -> 5 and a missing lane stay REGRESSION', () => {
    for (const key of ['SOAK_OPS', 'SOAK_CYCLES']) {
        const heap = headWith(3); heap.header.config[key] = { value: 777777, source: 'env' };
        assertNote(diffBaseline(baseStream(), heap), key + ' differs, heap +3', 'heap');
        const fw = stream(mkCycles(12, (l, c) => (l === 'GRAPH' && c === 12 ? { failingWorlds: 5 } : null)));
        fw.header.config[key] = { value: 777777, source: 'env' };
        const r = diffBaseline(baseStream(), fw);
        assert.equal(top(r), 'REGRESSION', key + ': ' + jsonOf(r));
        assert.ok(r.regressions.some((x) => x.kind === 'failingWorlds' && x.lane === 'GRAPH'));
        const gone = stream(mkCycles(12).filter((c) => c.lane !== 'GRAPH')); delete gone.summary.perLane.GRAPH;
        gone.header.config[key] = { value: 777777, source: 'env' };
        assert.equal(top(diffBaseline(baseStream(), gone)), 'REGRESSION', key + ' missing lane');
    }
});

test('diffBaseline: a SOAK_OPS / SOAK_CYCLES that is present but not a finite positive integer is INCOMPATIBLE (null is not "same volume")', () => {
    const common = [null, NaN, '100000', -5, 1.5, Infinity, undefined];
    for (const key of ['SOAK_OPS', 'SOAK_CYCLES']) {
        // 0 is bad for SOAK_OPS only (SOAK_CYCLES 0 is a forever run); config.mjs OPS_MAX 0x3FFFFFFF, CYCLES_MAX 2^28
        const bads = key === 'SOAK_OPS' ? common.concat([0, 2 ** 40, 0x3FFFFFFF + 1]) : common.concat([2 ** 28 + 1, 2 ** 40]);
        for (const bad of bads) {
            const both = baseStream(); both.header.config[key] = { value: bad, source: 'env' };
            const head = baseStream(); head.header.config[key] = { value: bad, source: 'env' };
            const r1 = diffBaseline(both, head);       // identical bad value on both sides: still unknown, never comparable
            assert.equal(top(r1), 'INCOMPATIBLE', key + '=' + String(bad) + ' both: ' + jsonOf(r1));
            assert.equal(r1.exitCode, 2);
            const h2 = baseStream(); h2.header.config[key] = { value: bad, source: 'env' };
            assert.equal(top(diffBaseline(baseStream(), h2)), 'INCOMPATIBLE', key + '=' + String(bad) + ' head only');
            const b3 = baseStream(); b3.header.config[key] = { value: bad, source: 'env' };
            assert.equal(top(diffBaseline(b3, baseStream())), 'INCOMPATIBLE', key + '=' + String(bad) + ' base only');
        }
        const absent = baseStream(); delete absent.header.config[key];
        assert.equal(top(diffBaseline(absent, baseStream())), 'INCOMPATIBLE', key + ' absent');
    }
});

test('diffBaseline: accept edges -- SOAK_OPS 1 / OPS_MAX and SOAK_CYCLES CYCLES_MAX on both sides are NOT INCOMPATIBLE', () => {
    // bounds from config.mjs: OPS_MAX 0x3FFFFFFF, CYCLES_MAX 1 << 28
    const edges = [['SOAK_OPS', 1], ['SOAK_OPS', 0x3FFFFFFF], ['SOAK_CYCLES', 1 << 28], ['SOAK_CYCLES', 0]];
    for (const [key, v] of edges) {
        const b = baseStream(); b.header.config[key] = { value: v, source: 'env' };
        const h = baseStream(); h.header.config[key] = { value: v, source: 'env' };
        const r = diffBaseline(b, h);
        assert.ok(r.verdict === 'PASS' || r.verdict === 'NOTE', key + '=' + v + ': ' + jsonOf(r));
        assert.equal(r.exitCode, 0);
    }
});

test('diffBaseline: a forever run (SOAK_CYCLES 0) is valid but states no volume: heap +3 MB is a NOTE (head only / base only / both)', () => {
    const forever = (s) => { s.header.config.SOAK_CYCLES = { value: 0, source: 'env' }; return s; };
    assertNote(diffBaseline(baseStream(), forever(headWith(3))), 'forever head only', 'heap');
    assertNote(diffBaseline(forever(baseStream()), headWith(3)), 'forever base only', 'heap');
    assertNote(diffBaseline(forever(baseStream()), forever(headWith(3))), 'forever both', 'heap');
});

test('diffBaseline: INCOMPATIBLE outranks REFUSED (a red base with a null / absent SOAK_OPS is INCOMPATIBLE config, not REFUSED)', () => {
    for (const how of ['null', 'absent']) {
        const b = baseStream(); b.summary.verdict = 'FAIL'; b.summary.exitCode = 1;
        if (how === 'null') b.header.config.SOAK_OPS = { value: null, source: 'env' }; else delete b.header.config.SOAK_OPS;
        const r = diffBaseline(b, baseStream());
        assert.equal(top(r), 'INCOMPATIBLE', how + ': ' + jsonOf(r));
        assert.equal(r.reason, 'config', how);
        assert.equal(r.exitCode, 2);
    }
    // control: the same red base with a valid volume is REFUSED
    const red = baseStream(); red.summary.verdict = 'FAIL'; red.summary.exitCode = 1;
    assert.equal(top(diffBaseline(red, baseStream())), 'REFUSED');
});

test('diffBaseline: a base that is not a green tree release run is REFUSED (red verdict, override, control kernel, mustfail)', () => {
    const cases = {
        'red verdict': (b) => { b.summary.verdict = 'FAIL'; b.summary.exitCode = 1; },
        'overridden kernel': (b) => { b.header.kernel = { path: 'x/Signal.js', override: true }; },
        'control kernel': (b) => { b.header.controls = { name: 'headpatched', error: null }; },
        'mustfail knob': (b) => { b.header.mustfail = 'cov-off:x'; },
    };
    for (const [why, mutate] of Object.entries(cases)) {
        const b = baseStream(); mutate(b);
        const r = diffBaseline(b, baseStream());
        assert.equal(top(r), 'REFUSED', why + ': ' + jsonOf(r));
        assert.equal(r.exitCode, 2, why);
    }
});

/* ---- b88 H2 (ASSERTION 3): the markDedupe sparkline, n/a never 0, latency p99 = max over classes ---------------------- */

const graphRow = (html) => {
    const re = /<tr>(.*?)<\/tr>/g; let m;
    while ((m = re.exec(html)) !== null) {
        const cells = [...m[1].matchAll(/<td>(.*?)<\/td>/g)].map((x) => x[1]);
        if (cells.length >= 7 && cells[0] === 'GRAPH' && cells[1] === '12') return cells;
    }
    return null;
};
const NA = '<span class="na">n/a</span>';

test('renderHtml b88: a cycle with anatomy.markDedupe 0.888 renders a <title>GRAPH markDedupe sparkline (HEAD has no markDedupe text)', () => {
    const cycles = mkCycles(12, (l) => (l === 'GRAPH' ? { anatomy: { worlds: 100, counts: {}, markDedupe: 0.888 } } : null));
    const s = stream(cycles);
    const html = renderHtml({ header: s.header, cycles, summary: s.summary, lines: [], diff: null });
    assert.ok(html.includes('<title>GRAPH markDedupe'), 'markDedupe sparkline title');
    assert.ok(html.includes('last 0.888 min 0.888 max 0.888'), 'the plotted value is the cycle value');
    const row = graphRow(html);
    assert.ok(row, 'GRAPH sparkline row');
    assert.equal(row.filter((c) => c === NA).length, 0, 'every series of GRAPH is finite -> no n/a cell');
});

test('renderHtml b88: all-null anatomy renders exactly one n/a cell in the GRAPH row (never 0, no markDedupe svg); a text(null) -> 0 mutant is red', () => {
    const cycles = mkCycles(12, (l) => (l === 'GRAPH' ? { anatomy: { worlds: 0, counts: null, markDedupe: null } } : null));
    const s = stream(cycles);
    const html = renderHtml({ header: s.header, cycles, summary: s.summary, lines: [], diff: null });
    assert.ok(!html.includes('<title>GRAPH markDedupe'), 'no sparkline for an all-null series');
    const row = graphRow(html);
    assert.ok(row, 'GRAPH sparkline row');
    assert.equal(row.filter((c) => c === NA).length, 1, 'exactly the markDedupe cell is n/a: ' + JSON.stringify(row));
    assert.ok(!/markDedupe[^<]*<\/title>[^]*last 0 /.test(html), 'never a 0 point');
});

test('renderHtml b88: latency p99 sparkline = MAX over classes (1000 / 300 / 5000 -> 5000; a min-taking renderer would show 300)', () => {
    const lat = { set: { n: 100, p50Ns: 200, p99Ns: 1000, belowFloor: 0 }, read: { n: 100, p50Ns: 100, p99Ns: 300, belowFloor: 0 }, batch: { n: 100, p50Ns: 900, p99Ns: 5000, belowFloor: 0 } };
    const cycles = mkCycles(12, () => ({ latency: lat }));
    const s = stream(cycles);
    const html = renderHtml({ header: s.header, cycles, summary: s.summary, lines: [], diff: null });
    assert.ok(html.includes('last 5000 min 5000 max 5000'), 'max over classes is plotted');
    assert.ok(!html.includes('last 300 min 300'), 'the min class is not plotted');
    // regression pin: HEAD already takes the max; the row is the must-fail witness for a min-mutant.
});
