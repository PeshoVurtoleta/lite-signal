/**
 * @zakkster/lite-signal soak -- the HTML report of one burn-in stream (SPEC-S2 group B TASK 2; LP section 9
 * "HTML: self-contained inline SVG sparklines, integrity banner, escaped issues").
 *
 * PURE MODULE: no I/O, no process state, no clock, no randomness: the same input renders the same bytes.
 * SoakReport.mjs `--html <out>` (B-B5) writes the returned string.
 *
 *   renderHtml({ header, cycles, summary, lines, diff }) -> string   a complete HTML document
 *     header   the stream's header record, or null (an integrity failure may stop before it is usable)
 *     cycles   its cycle records in stream order (Array; undefined / null = none)
 *     summary  its summary record, or null
 *     lines    SoakReport's stdout + stderr lines (Array of strings; undefined / null = none). The integrity
 *              banner is derived from them ONLY: a line with `INTEGRITY --` or `CRASH --` -> red INTEGRITY FAILED;
 *              else `NOT A RELEASE SOAK --` -> amber; else a whole line `soak:report: verdict <V> (consistent)` -> green
 *              consistent; no such line -> grey "integrity not checked" (never green without the report's word)
 *     diff     a diffBaseline() result (baseline.mjs), or null / undefined = no baseline section
 *   A wrong container (the argument not a plain object, cycles / lines not arrays, header / summary / diff not
 *   objects or null) throws TypeError.
 *   escapeHtml(s) -> string   & < > " ' -> &amp; &lt; &gt; &quot; &#39;. A non-string throws TypeError.
 *
 * Self-contained: one inline <style>, no <script>, no external URL (no href / src attribute at all), inline
 * <svg> only. Every interpolated value goes through text() -> escapeHtml(); numbers are formatted to at most
 * 3 decimals. A missing value (undefined, null, NaN, +-Infinity, a non-numeric where a number is read) renders
 * `n/a`, NEVER 0.
 *
 * Sparklines (one row per lane, cycles in stream order, x = the lane's cycle index): residentMB
 * (cycle.memory.residentMB), rss p95 (cycle.rss.p95MB, schema 2), opsPerSec (cycle.throughput.opsPerSec),
 * gc maxPauseMs (cycle.gc.maxPauseMs; gc is null when no profiler ran), latency p99 (the max over classes of
 * cycle.latency[<class>].p99Ns, schema 2), markDedupe (cycle.anatomy.markDedupe = markStamp / markEdge, stamp/edge;
 * anatomy is null on an UNAVAILABLE / disabled lane and markDedupe null when markEdge is 0 -> n/a, never 0). A
 * missing cycle value breaks the line (no point is drawn, never a 0); a series with no finite value renders `n/a`
 * instead of an svg. Shapes read: main.mjs:439-449 (cycle), main.mjs:298-330 (summary), boundary.mjs:75/98 (gc,
 * memory), SPEC-S2 group B TASK 6 (rss, latency), anatomy.mjs toJSON (anatomy, B-B4b).
 *
 * COLD module.
 */

const SPARK_W = 160;
const SPARK_H = 32;
const SPARK_PAD = 2;

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };

export function escapeHtml(s) {
    if (typeof s !== 'string') throw new TypeError('escapeHtml: expected a string, got ' + (s === null ? 'null' : typeof s));
    return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** A number to at most 3 decimals; never a raw float tail. */
function fmtNum(v) {
    return String(Math.round(v * 1000) / 1000);
}

/** Any value to escaped display text; a missing value is `n/a`, never 0. */
function text(v) {
    if (v === undefined || v === null) return 'n/a';
    if (typeof v === 'number') return isNum(v) ? escapeHtml(fmtNum(v)) : 'n/a';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return escapeHtml(v);
    if (Array.isArray(v)) return v.length === 0 ? 'none' : v.map((x) => text(x)).join(', ');
    return escapeHtml(JSON.stringify(v));
}

/** Safe nested read: get(o, 'a', 'b') -> o.a.b or undefined. */
function get(o) {
    let cur = o;
    for (let i = 1; i < arguments.length; i++) {
        if (!own(cur, arguments[i])) return undefined;
        cur = cur[arguments[i]];
    }
    return cur;
}

function row(cells, tag) {
    const t = tag === undefined ? 'td' : tag;
    return '<tr>' + cells.map((c) => '<' + t + '>' + c + '</' + t + '>').join('') + '</tr>';
}

function table(head, rows) {
    return '<table><thead>' + row(head.map(text), 'th') + '</thead><tbody>' + rows.join('') + '</tbody></table>';
}

function kv(pairs) {
    return '<table class="kv"><tbody>' + pairs.map((p) => row([text(p[0]), text(p[1])])).join('') + '</tbody></table>';
}

/* ---- banner ------------------------------------------------------------------------------------------ */

function banner(lines) {
    let cls = 'unk', word = 'integrity not checked (no SoakReport line)', line = null;
    const bad = lines.find((l) => l.indexOf('INTEGRITY --') !== -1 || l.indexOf('CRASH --') !== -1);
    const refused = lines.find((l) => l.indexOf('NOT A RELEASE SOAK --') !== -1);
    const ok = lines.find((l) => /^soak:report: verdict \S+ \(consistent\)$/.test(l));
    if (bad !== undefined) { cls = 'bad'; word = 'INTEGRITY FAILED'; line = bad; }
    else if (refused !== undefined) { cls = 'warn'; word = 'consistent, NOT A RELEASE SOAK'; line = refused; }
    else if (ok !== undefined) { cls = 'ok'; word = 'consistent'; line = ok; }
    return '<div class="banner ' + cls + '"><strong>' + text(word) + '</strong>' + (line === null ? '' : '<br><code>' + text(line) + '</code>') + '</div>';
}

/* ---- sparklines -------------------------------------------------------------------------------------- */

const SERIES = [
    { name: 'residentMB', unit: 'MB', pick: (c) => get(c, 'memory', 'residentMB') },
    { name: 'rss p95', unit: 'MB', pick: (c) => get(c, 'rss', 'p95MB') },
    { name: 'opsPerSec', unit: 'ops/s', pick: (c) => get(c, 'throughput', 'opsPerSec') },
    { name: 'gc maxPauseMs', unit: 'ms', pick: (c) => get(c, 'gc', 'maxPauseMs') },
    { name: 'latency p99', unit: 'ns (max over classes)', pick: latencyP99Max },
    { name: 'markDedupe', unit: 'stamp/edge', pick: (c) => get(c, 'anatomy', 'markDedupe') },
];

function latencyP99Max(c) {
    const lat = get(c, 'latency');
    if (!isObj(lat)) return undefined;
    let m = NaN;
    for (const k of Object.keys(lat)) {
        const v = get(lat, k, 'p99Ns');
        if (isNum(v) && !(v <= m)) m = v;
    }
    return m;
}

/** One inline SVG sparkline; null-safe: a missing value breaks the polyline. */
function sparkline(vals, title) {
    let lo = Infinity, hi = -Infinity, n = 0, last;
    for (const v of vals) if (isNum(v)) { n++; if (v < lo) lo = v; if (v > hi) hi = v; last = v; }
    if (n === 0) return '<span class="na">n/a</span>';
    const span = hi - lo, step = vals.length > 1 ? (SPARK_W - 2 * SPARK_PAD) / (vals.length - 1) : 0;
    const x = (i) => (vals.length > 1 ? SPARK_PAD + i * step : SPARK_W / 2).toFixed(1);
    const y = (v) => (span > 0 ? SPARK_H - SPARK_PAD - ((v - lo) / span) * (SPARK_H - 2 * SPARK_PAD) : SPARK_H / 2).toFixed(1);
    const parts = [];
    let run = [];
    const flush = () => {
        if (run.length === 1) parts.push('<circle cx="' + run[0][0] + '" cy="' + run[0][1] + '" r="1.5"/>');
        else if (run.length > 1) parts.push('<polyline points="' + run.map((p) => p[0] + ',' + p[1]).join(' ') + '"/>');
        run = [];
    };
    for (let i = 0; i < vals.length; i++) {
        if (isNum(vals[i])) run.push([x(i), y(vals[i])]); else flush();
    }
    flush();
    const missing = vals.length - n;
    return '<svg class="spark" width="' + SPARK_W + '" height="' + SPARK_H + '" viewBox="0 0 ' + SPARK_W + ' ' + SPARK_H + '" role="img"><title>' +
        text(title) + '</title>' + parts.join('') + '</svg>' +
        '<span class="stat">last ' + text(last) + ' min ' + text(lo) + ' max ' + text(hi) + (missing > 0 ? ' (' + missing + ' n/a)' : '') + '</span>';
}

function laneOrder(cycles) {
    const out = [];
    for (const c of cycles) if (isObj(c) && typeof c.lane === 'string' && out.indexOf(c.lane) === -1) out.push(c.lane);
    return out;
}

function sparkSection(cycles) {
    const lanes = laneOrder(cycles);
    if (lanes.length === 0) return '<p class="na">n/a (no cycle records)</p>';
    const rows = lanes.map((lane) => {
        const mine = cycles.filter((c) => isObj(c) && c.lane === lane);
        return row([text(lane), text(mine.length)].concat(SERIES.map((s) => sparkline(mine.map(s.pick), lane + ' ' + s.name + ' (' + s.unit + ')'))));
    });
    return table(['lane', 'cycles'].concat(SERIES.map((s) => s.name + ' (' + s.unit + ')')), rows);
}

/* ---- sections ---------------------------------------------------------------------------------------- */

function headerSection(h) {
    if (h === null) return '<p class="na">n/a (no header record)</p>';
    const cfg = (k) => get(h, 'config', k, 'value');
    const kernel = get(h, 'controls', 'name');
    return kv([
        ['pkgVersion', get(h, 'pkgVersion')], ['schemaVersion', get(h, 'schemaVersion')], ['startedAt', get(h, 'startedAt')],
        ['gitSha', get(h, 'gitSha')], ['gitDirty', get(h, 'gitDirty')], ['gitError', get(h, 'gitError')],
        ['kernel', typeof kernel === 'string' ? 'control:' + kernel : (get(h, 'kernel', 'override') === true ? 'override' : (get(h, 'kernel', 'override') === false ? 'tree' : undefined))],
        ['parity ok', get(h, 'parity', 'ok')], ['engine', get(h, 'engine', 'name')],
        ['node', get(h, 'node')], ['v8', get(h, 'v8')],
        ['os', isObj(h.os) ? [get(h, 'os', 'platform'), get(h, 'os', 'arch'), get(h, 'os', 'cpuModel')].map((v) => (v === undefined || v === null ? 'n/a' : String(v))).join(' / ') : undefined],
        ['SOAK_CYCLES', cfg('SOAK_CYCLES')], ['SOAK_OPS', cfg('SOAK_OPS')], ['SOAK_SEED', cfg('SOAK_SEED')],
        ['SOAK_LANES', cfg('SOAK_LANES')], ['SOAK_SMOKE', cfg('SOAK_SMOKE')], ['timerFloorNs', get(h, 'timerFloorNs')],
    ]);
}

function summarySection(s) {
    if (s === null) return '<p class="na">n/a (no summary record)</p>';
    const top = kv([
        ['verdict', get(s, 'verdict')], ['exitCode', get(s, 'exitCode')], ['reason', get(s, 'reason')],
        ['cyclesRun', get(s, 'cyclesRun')], ['lanesRun', get(s, 'lanesRun')], ['smoke', get(s, 'smoke')],
        ['worlds', get(s, 'totals', 'worlds')], ['ops', get(s, 'totals', 'ops')], ['failingWorlds', get(s, 'totals', 'failingWorlds')],
    ]);
    const pl = isObj(s.perLane) ? s.perLane : {};
    const laneRows = Object.keys(pl).map((lane) => {
        const L = pl[lane];
        return row([text(lane), text(get(L, 'status')), text(get(L, 'cycles')), text(get(L, 'postWarmup')),
            text(get(L, 'totals', 'failingWorlds')), text(get(L, 'drift', 'heap', 'early')), text(get(L, 'drift', 'heap', 'late')),
            text(get(L, 'drift', 'heap', 'limit')), text(get(L, 'drift', 'heap', 'status')), text(get(L, 'retention', 'badBoundaries')),
            text(get(L, 'causes'))]);
    });
    const lanes = laneRows.length === 0 ? '<p class="na">n/a (no perLane)</p>' :
        table(['lane', 'status', 'cycles', 'post', 'failingWorlds', 'heap early MB', 'heap late MB', 'heap limit MB', 'heap', 'bad boundaries', 'causes'], laneRows);
    const br = Array.isArray(s.breaches) ? s.breaches : [];
    const breaches = br.length === 0 ? '<p>none</p>' : table(['gate / oracle', 'lane', 'sig', 'known', 'replay', 'detail'], br.map((b) => row([
        text(own(b, 'gate') ? 'gate=' + String(b.gate) : 'oracle=' + String(get(b, 'oracle'))), text(get(b, 'lane')), text(get(b, 'sig')),
        text(get(b, 'known')), text(get(b, 'replay')), text(get(b, 'detail'))])));
    const inc = Array.isArray(s.inconclusive) ? s.inconclusive : [];
    return top + '<h3>lanes</h3>' + lanes + '<h3>breaches</h3>' + breaches +
        '<h3>inconclusive</h3>' + (inc.length === 0 ? '<p>none</p>' : '<ul>' + inc.map((l) => '<li><code>' + text(l) + '</code></li>').join('') + '</ul>');
}

function diffSection(d) {
    const head = kv([['verdict', get(d, 'verdict')], ['exitCode', get(d, 'exitCode')], ['reason', get(d, 'reason')], ['detail', get(d, 'detail')],
        ['node major', isObj(d.nodeMajor) ? String(d.nodeMajor.base) + ' -> ' + String(d.nodeMajor.head) : undefined],
        ['runner', isObj(d.runner) ? String(d.runner.base) + ' -> ' + String(d.runner.head) : undefined]]);
    const list = (name, arr) => '<h3>' + text(name) + '</h3>' + (!Array.isArray(arr) || arr.length === 0 ? '<p>none</p>' :
        table(['kind', 'lane', 'detail'], arr.map((x) => row([text(get(x, 'kind')), text(get(x, 'lane')), text(get(x, 'detail'))]))));
    const lanes = Array.isArray(d.lanes) ? d.lanes : [];
    const laneRows = lanes.map((L) => row([text(get(L, 'lane')),
        text(get(L, 'heapLateMB', 'base')), text(get(L, 'heapLateMB', 'head')), text(get(L, 'heapLateMB', 'delta')),
        text(get(L, 'failingWorlds', 'base')), text(get(L, 'failingWorlds', 'head')),
        text(get(L, 'opsPerSec', 'base')), text(get(L, 'opsPerSec', 'head')), text(get(L, 'opsPerSec', 'ratio')),
        isObj(L.p99Ns) && Object.keys(L.p99Ns).length > 0 ? Object.keys(L.p99Ns).map((k) => text(k) + ' ' + text(get(L, 'p99Ns', k, 'base')) + ' -> ' +
            text(get(L, 'p99Ns', k, 'head'))).join('<br>') : 'n/a']));
    return head + list('regressions', d.regressions) + list('notes', d.notes) + '<h3>lanes</h3>' + (laneRows.length === 0 ? '<p class="na">n/a</p>' :
        table(['lane', 'heap late base MB', 'heap late head MB', 'delta MB', 'failingWorlds base', 'failingWorlds head', 'ops/s base', 'ops/s head', 'ratio', 'p99Ns base -> head'], laneRows));
}

const STYLE = 'body{font:14px/1.4 system-ui,sans-serif;margin:1.5rem;color:#1b1f24;background:#fff}' +
    'h1{font-size:1.4rem}h2{font-size:1.15rem;margin-top:1.6rem}h3{font-size:1rem}' +
    'table{border-collapse:collapse;margin:.4rem 0}th,td{border:1px solid #d0d7de;padding:.2rem .45rem;text-align:left;vertical-align:middle}' +
    'th{background:#f6f8fa}code,pre{font:12px/1.35 ui-monospace,monospace}pre{background:#f6f8fa;padding:.6rem;overflow:auto}' +
    '.banner{padding:.6rem .8rem;border-radius:.3rem;margin:.6rem 0}.ok{background:#dafbe1}.warn{background:#fff8c5}.bad{background:#ffebe9}.unk{background:#eaeef2}' +
    '.spark{vertical-align:middle;fill:none;stroke:#0969da;stroke-width:1.2}.spark circle{fill:#0969da;stroke:none}' +
    '.stat{display:block;font-size:11px;color:#57606a}.na{color:#57606a}';

export function renderHtml(input) {
    if (!isObj(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
        throw new TypeError('renderHtml: expected a plain object { header, cycles, summary, lines, diff }');
    }
    const header = input.header === undefined ? null : input.header;
    const summary = input.summary === undefined ? null : input.summary;
    const diff = input.diff === undefined ? null : input.diff;
    const cycles = input.cycles === undefined || input.cycles === null ? [] : input.cycles;
    const lines = input.lines === undefined || input.lines === null ? [] : input.lines;
    if (!(header === null || isObj(header))) throw new TypeError('renderHtml: header must be an object or null');
    if (!(summary === null || isObj(summary))) throw new TypeError('renderHtml: summary must be an object or null');
    if (!(diff === null || isObj(diff))) throw new TypeError('renderHtml: diff must be an object or null');
    if (!Array.isArray(cycles)) throw new TypeError('renderHtml: cycles must be an array');
    if (!(Array.isArray(lines) && lines.every((l) => typeof l === 'string'))) throw new TypeError('renderHtml: lines must be an array of strings');
    const title = 'lite-signal soak report' + (header !== null && typeof header.gitSha === 'string' ? ' ' + header.gitSha.slice(0, 12) : '');
    return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>' + text(title) + '</title><style>' + STYLE + '</style></head><body>\n' +
        '<h1>' + text(title) + '</h1>\n' + banner(lines) + '\n' +
        '<h2>run</h2>\n' + headerSection(header) + '\n' +
        '<h2>summary</h2>\n' + summarySection(summary) + '\n' +
        '<h2>lanes x cycles</h2>\n' + sparkSection(cycles) + '\n' +
        (diff === null ? '' : '<h2>baseline diff</h2>\n' + diffSection(diff) + '\n') +
        '<h2>report lines</h2>\n' + (lines.length === 0 ? '<p class="na">n/a</p>' : '<pre>' + lines.map((l) => text(l)).join('\n') + '</pre>') + '\n' +
        '</body></html>\n';
}
