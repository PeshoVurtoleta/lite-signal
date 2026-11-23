// bench/lib/rowcheck.mjs -- cross-file validity check of a MIRROR capture (M7 / M16, b251).
//
// The mirror's in-process guards (guards.mjs checkCounterAgreement / checkChecksum) compare
// engines inside ONE process. Both published protocols run ONE engine per process
// (run-all-mirror.sh: one process per engine x rep; sweep.mjs: one per engine x row x rep),
// so those guards compare nothing there. This module re-runs the comparison over the rep
// files on disk, after the capture, and fails closed:
//
//   rows   -- every data row parses; every row is a known mirror row (the dynamic configs
//             of mirror-config.mjs, full or QUICK scale, and the microRows() names); a row
//             carries its required tokens (dynamic: nodesRecomputed nodesVisited
//             edgesTraversed sinkReads sum; kairo / fan / mol: checksum); sum and checksum
//             are non-zero; every row is in every rep file of its engine with every counter
//             equal across those reps; every row is carried by >= 2 engines; edgesTraversed,
//             sum and checksum are equal across the engines that carry the row.
//   stamps -- checkStamps: kind, 64-hex engine / harness sha, the non-empty fields, and ONE
//             host, node, harness sha, engine sha, protocol, config and adapter across every
//             file of every engine; extra.quick === the expected value (false for a
//             publishable capture) and extra.captureId === the COMPLETE marker's captureId
//             in every file; a marker captureId that does not match CAPTURE_ID_RE is refused.
//
// checkStamps' "config equal across engines" is a MIRROR rule: every mirror process echoes
// the same LITE_CONFIG. Never call it on a microscope capture (benchmark.mjs / aggregate.mjs),
// whose stamps carry a config for lite only.
//
// Every check returns { ok: true, ... } or { ok: false, reason }; an input it cannot
// verify is refused, never skipped. Cold path only (report.mjs / sweep.mjs, after capture).

import { randomBytes } from "node:crypto";
import { DYNAMIC_TESTS, scaleQuick } from "./mirror-config.mjs";
import { microRows } from "./micro-suites.mjs";
import { testColumn } from "./title.mjs";
import { loadRepFiles } from "./collect.mjs";

export const DYNAMIC_REQUIRED = Object.freeze(["nodesRecomputed", "nodesVisited", "edgesTraversed", "sinkReads", "sum"]);
const REQUIRED_BY_CLASS = Object.freeze({
    dynamic: DYNAMIC_REQUIRED,
    kairo: Object.freeze(["checksum"]),
    fan: Object.freeze(["checksum"]),
    mol: Object.freeze(["checksum"]),
    s: Object.freeze([]),            // sBench rows: timing only, validated in-process (validate throws)
});
// tokens a mirror row may carry; anything else is refused
const KNOWN_TOKENS = new Set([...DYNAMIC_REQUIRED, "checksum", "flushPasses", "poolGrowths", "samples", "ceiling"]);
// per-sample bookkeeping of a SLOW/CAPPED row: legitimately differs rep to rep
const VOLATILE = new Set(["samples", "ceiling"]);
// equal across engines (every other counter is compared across one engine's reps only)
const CROSS_ENGINE = Object.freeze(["edgesTraversed", "sum", "checksum"]);
// must be a finite non-zero number
const NONZERO = Object.freeze(["sum", "checksum"]);

// Token domains. Counts (every token but sum / checksum / ceiling) are non-negative
// integers in plain decimal, no sign, no leading zero, no fraction, no exponent. sum and
// checksum are results: any finite decimal number (sign, fraction and exponent allowed, no
// leading zero), non-zero by VALUE (so -0, 0.0 and 1e-400 are zero), compared across reps
// and engines as printed TEXT (two sums equal as doubles but printed differently, or
// differing only above 2^53, are a mismatch).
const COUNT_RE = /^(?:0|[1-9][0-9]*)$/;
const NUM_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/;
const RESULT_TOKENS = new Set(["sum", "checksum"]);
// capture id: UTC second + 8 random hex digits. The ONE format: makeCaptureId (sweep.mjs)
// builds it, checkStamps refuses any other; run-all-mirror.sh (bash) carries a copy of
// this regex and must stay byte-equal to it.
export const CAPTURE_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
export function makeCaptureId(date = new Date(), hex = randomBytes(4).toString("hex")) {
    const id = date.toISOString().replace(/\.[0-9]{3}Z$/, "Z").replace(/[-:]/g, "") + "-" + hex;
    if (!CAPTURE_ID_RE.test(id)) throw new Error(`rowcheck: generated capture id "${id}" does not match ${CAPTURE_ID_RE}`);
    return id;
}
const TIME_RE = /^[0-9]+(?:\.[0-9]+)?$/;
const CEILING_RE = /^[0-9]+ms$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^([A-Za-z]+)=(.*)$/;

// --- row parsing ---------------------------------------------------------------------

// One line of a rep file -> null (comment, blank or the CSV header: not a data row),
// { ok: false, reason } (a data row that does not parse), or
// { ok: true, framework, test, time, capped, tokens: { key: "<raw value text>" } }.
// Token values are kept as the printed text so equality is exact (sum may print as
// 2.9694238299960427e+240).
export function parseMetrics(line) {
    if (typeof line !== "string") return { ok: false, reason: "not a string" };
    if (line.trim() === "" || line.startsWith("#")) return null;
    const p = line.split(" , ");
    if (p.length < 2) return { ok: false, reason: `not a mirror row (no " , " separator): ${JSON.stringify(line.slice(0, 80))}` };
    if (p[0].trim() === "framework") return null;
    if (p.length !== 4) return { ok: false, reason: `expected 4 columns, got ${p.length}: ${JSON.stringify(line.slice(0, 80))}` };
    const framework = p[0].trim(), test = p[1].trim(), timeText = p[2].trim();
    if (framework === "" || test === "") return { ok: false, reason: `empty framework / test column: ${JSON.stringify(line.slice(0, 80))}` };
    if (!TIME_RE.test(timeText)) return { ok: false, reason: `${test}: time "${timeText}" is not a plain non-negative number` };
    const tokens = {};
    let capped = false;
    for (const tok of p[3].trim().split(/\s+/)) {
        if (tok === "") continue;
        if (tok === "SLOW/CAPPED") { capped = true; continue; }
        const m = KEY_RE.exec(tok);
        if (!m) return { ok: false, reason: `${test}: unparseable token "${tok}"` };
        const k = m[1], v = m[2];
        if (!KNOWN_TOKENS.has(k)) return { ok: false, reason: `${test}: unknown token "${k}"` };
        if (Object.hasOwn(tokens, k)) return { ok: false, reason: `${test}: duplicate token "${k}"` };
        if (k === "ceiling") {
            if (!CEILING_RE.test(v)) return { ok: false, reason: `${test}: token ceiling="${v}" is not <integer>ms` };
        } else if (RESULT_TOKENS.has(k)) {
            if (!(NUM_RE.test(v) && Number.isFinite(Number(v)))) return { ok: false, reason: `${test}: token ${k}="${v}" is not a finite decimal number` };
        } else if (!COUNT_RE.test(v)) {
            return { ok: false, reason: `${test}: count ${k}="${v}" is not a non-negative integer` };
        }
        tokens[k] = v;
    }
    return { ok: true, framework, test, time: Number(timeText), capped, tokens };
}

// --- row classes (built once, lazily) ------------------------------------------------

let ROW_CLASS = null;      // Map<test column, class>
let ROW_CLASS_ERR = null;
function rowClasses() {
    if (ROW_CLASS || ROW_CLASS_ERR) return ROW_CLASS;
    const map = new Map();
    const put = (key, cls) => {
        if (!Object.hasOwn(REQUIRED_BY_CLASS, cls)) { ROW_CLASS_ERR = `row "${key}" has class "${cls}" with no token rule in rowcheck.mjs`; return; }
        const had = map.get(key);
        if (had !== undefined && had !== cls) { ROW_CLASS_ERR = `row "${key}" is both "${had}" and "${cls}"`; return; }
        map.set(key, cls);
    };
    for (const quick of [false, true]) for (const cfg of scaleQuick(DYNAMIC_TESTS, quick)) put(testColumn(cfg), "dynamic");
    for (const r of microRows()) put(r.name, r.group);
    if (!ROW_CLASS_ERR) ROW_CLASS = map;
    return ROW_CLASS;
}

// --- stamps --------------------------------------------------------------------------

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const nonEmpty = (x) => typeof x === "string" && x.length > 0;
function canonical(obj) {
    const keys = Object.keys(obj).sort();
    return JSON.stringify(keys.map((k) => [k, obj[k]]));
}
const STAMP_STRINGS = Object.freeze(["date", "protocol", "node", "arch", "platform", "cpu", "enginePath", "harnessPath"]);
// equal across every file of every engine (host = cpu + platform + arch)
const STAMP_EQUAL = Object.freeze([
    ["cpu", (s) => s.cpu],
    ["platform", (s) => s.platform],
    ["arch", (s) => s.arch],
    ["node", (s) => s.node],
    ["harnessSha256", (s) => s.harnessSha256],
    ["engineSha256", (s) => s.engineSha256],
    ["protocol", (s) => s.protocol],
    ["config", (s) => canonical(s.config)],
    ["extra.adapter", (s) => s.extra.adapter],
]);

// entries: [{ engine, name, stamp }] (every rep file of every engine). captureId: the COMPLETE
// marker's captureId. opts.quick: the extra.quick every stamp must carry (default false).
export function checkStamps(entries, captureId, opts = {}) {
    const quick = Object.hasOwn(opts, "quick") ? opts.quick : false;
    if (typeof quick !== "boolean") return { ok: false, reason: "checkStamps: opts.quick must be a boolean" };
    if (!nonEmpty(captureId)) return { ok: false, reason: "the COMPLETE marker carries no captureId (a capture predating b251, or a hand-made marker)" };
    if (!CAPTURE_ID_RE.test(captureId)) return { ok: false, reason: `captureId ${JSON.stringify(captureId)} does not match ${CAPTURE_ID_RE}` };
    if (!Array.isArray(entries) || entries.length === 0) return { ok: false, reason: "no stamped rep files" };
    for (const { engine, name, stamp: s } of entries) {
        const at = `${name} (${engine})`;
        if (!isPlainObject(s)) return { ok: false, reason: `${at}: no #STAMP object` };
        if (s.kind !== "bench-stamp/v1") return { ok: false, reason: `${at}: stamp kind ${JSON.stringify(s.kind)} != "bench-stamp/v1"` };
        for (const k of STAMP_STRINGS) if (!nonEmpty(s[k])) return { ok: false, reason: `${at}: stamp ${k} is missing or empty` };
        if (!SHA_RE.test(s.engineSha256)) return { ok: false, reason: `${at}: stamp engineSha256 is not 64 hex digits` };
        if (!SHA_RE.test(s.harnessSha256)) return { ok: false, reason: `${at}: stamp harnessSha256 is not 64 hex digits` };
        if (!(Number.isInteger(s.reps) && s.reps >= 1)) return { ok: false, reason: `${at}: stamp reps ${JSON.stringify(s.reps)} is not an integer >= 1` };
        if (!isPlainObject(s.config) || Object.keys(s.config).length === 0) return { ok: false, reason: `${at}: stamp config is missing or empty` };
        const x = s.extra;
        if (!isPlainObject(x)) return { ok: false, reason: `${at}: stamp extra is missing` };
        if (!nonEmpty(x.adapter)) return { ok: false, reason: `${at}: stamp extra.adapter is missing or empty` };
        if (x.quick !== quick) return { ok: false, reason: `${at}: stamp extra.quick=${JSON.stringify(x.quick)}, expected ${quick}${quick ? "" : " (a QUICK capture is a smoke run, never publishable)"}` };
        if (x.captureId !== captureId) return { ok: false, reason: `${at}: stamp captureId ${JSON.stringify(x.captureId)} != COMPLETE marker captureId ${JSON.stringify(captureId)} (a file from another capture)` };
        if (!isPlainObject(x.refLibs)) return { ok: false, reason: `${at}: stamp extra.refLibs is missing` };
        if (engine !== "lite-signal" && !nonEmpty(x.refLibs[engine])) return { ok: false, reason: `${at}: stamp extra.refLibs names no version for ${engine}` };
        if (!(typeof x.load1 === "number" && Number.isFinite(x.load1) && x.load1 >= 0)) return { ok: false, reason: `${at}: stamp extra.load1 is missing or not a finite number >= 0` };
    }
    const first = entries[0];
    for (const [field, get] of STAMP_EQUAL) {
        const ref = get(first.stamp);
        for (const e of entries) {
            if (get(e.stamp) !== ref) {
                return { ok: false, reason: `stamp ${field} differs across the capture: ${e.name} (${e.engine}) ${JSON.stringify(get(e.stamp))} != ${first.name} (${first.engine}) ${JSON.stringify(ref)}` };
            }
        }
    }
    return { ok: true };
}

// Per-child stamp guard for sweep.mjs (one cold process per engine x row x rep; a rep file
// keeps only its first child's stamp, so every later child is checked here, as it arrives).
// Returns check(engine, label, stamp) -> { ok } | { ok: false, reason }: the stamp must pass
// checkStamps' per-stamp rules (captureId === this capture's, extra.quick === opts.quick)
// and equal the first ACCEPTED child stamp on every equal-across field. label names the
// child (engine / scenario / rep) in the reason. A refused stamp never becomes the reference.
export function makeChildStampGuard(captureId, opts = {}) {
    let first = null;
    return function checkChild(engine, label, stamp) {
        const me = { engine, name: label, stamp };
        const r = checkStamps(first ? [first, me] : [me], captureId, opts);
        if (r.ok && first === null) first = me;
        return r;
    };
}

// --- capture -------------------------------------------------------------------------

// dir: a capture dir of <engine>-rep<N>.txt files. engines: the engine keys to compare
// (>= 2). marker: the parsed COMPLETE marker ({ captureId, ... }). opts.quick: see
// checkStamps. Returns { ok: true, rows, engines, files, cells, cellsTotal } or
// { ok: false, reason }.
export function checkCapture(dir, engines, marker, opts = {}) {
    if (!Array.isArray(engines) || engines.length < 2) {
        return { ok: false, reason: `fewer than 2 engines in the capture (${Array.isArray(engines) ? engines.join(", ") || "none" : "?"}) -- no cross-engine check is possible` };
    }
    if (new Set(engines).size !== engines.length || !engines.every(nonEmpty)) return { ok: false, reason: `engine list ${JSON.stringify(engines)} has a duplicate or empty key` };
    if (!isPlainObject(marker)) return { ok: false, reason: "no COMPLETE marker object" };
    const classes = rowClasses();
    if (!classes) return { ok: false, reason: `rowcheck: ${ROW_CLASS_ERR}` };

    // load every rep file of every engine
    const perEngine = new Map();   // engine -> [{ name, rows: Map<test, parsed> }]
    const entries = [];
    for (const engine of engines) {
        const files = loadRepFiles(dir, engine);
        if (files.length === 0) return { ok: false, reason: `${engine}: no rep files` };
        const parsedFiles = [];
        for (const f of files) {
            entries.push({ engine, name: f.name, stamp: f.stamp });
            const rows = new Map();
            for (const line of f.text.split(/\r?\n/)) {
                const r = parseMetrics(line);
                if (r === null) continue;
                if (!r.ok) return { ok: false, reason: `${f.name}: ${r.reason}` };
                if (r.framework !== engine) return { ok: false, reason: `${f.name}: row "${r.test}" is framework "${r.framework}", not ${engine}` };
                if (rows.has(r.test)) return { ok: false, reason: `${f.name}: row "${r.test}" appears twice` };
                const cls = classes.get(r.test);
                if (cls === undefined) return { ok: false, reason: `${f.name}: row "${r.test}" is not a known mirror row` };
                for (const k of REQUIRED_BY_CLASS[cls]) {
                    if (!Object.hasOwn(r.tokens, k)) return { ok: false, reason: `${f.name}: ${cls} row "${r.test}" carries no ${k}=` };
                }
                for (const k of NONZERO) {
                    if (Object.hasOwn(r.tokens, k) && Number(r.tokens[k]) === 0) return { ok: false, reason: `${f.name}: row "${r.test}" has ${k}=${r.tokens[k]}, a zero value (no anchored output)` };
                }
                rows.set(r.test, r);
            }
            if (rows.size === 0) return { ok: false, reason: `${f.name}: no data rows` };
            parsedFiles.push({ name: f.name, rows });
        }
        perEngine.set(engine, parsedFiles);
    }

    const st = checkStamps(entries, marker.captureId, opts);
    if (!st.ok) return st;

    // within one engine: every row in every rep, every counter equal across reps
    const repRow = new Map();      // engine -> Map<test, parsed of the first rep>
    for (const [engine, files] of perEngine) {
        const tests = new Set();
        for (const f of files) for (const t of f.rows.keys()) tests.add(t);
        const firstRows = new Map();
        for (const t of tests) {
            let ref = null, refName = null;
            for (const f of files) {
                const r = f.rows.get(t);
                if (!r) return { ok: false, reason: `${engine}: row "${t}" is missing from ${f.name} (present in another rep)` };
                if (ref === null) { ref = r; refName = f.name; continue; }
                const keys = new Set([...Object.keys(ref.tokens), ...Object.keys(r.tokens)]);
                for (const k of keys) {
                    if (VOLATILE.has(k)) continue;
                    if (ref.tokens[k] !== r.tokens[k]) {
                        return { ok: false, reason: `${engine}: row "${t}" ${k} differs across reps: ${f.name} ${r.tokens[k] ?? "(absent)"} != ${refName} ${ref.tokens[k] ?? "(absent)"}` };
                    }
                }
            }
            firstRows.set(t, ref);
        }
        repRow.set(engine, firstRows);
    }

    // across engines: >= 2 engines per row; edgesTraversed / sum / checksum equal
    const allTests = new Set();
    for (const rows of repRow.values()) for (const t of rows.keys()) allTests.add(t);
    let cells = 0;     // (row, engine) pairs actually carried and compared
    for (const t of allTests) {
        const carriers = engines.filter((e) => repRow.get(e).has(t));
        cells += carriers.length;
        if (carriers.length < 2) return { ok: false, reason: `row "${t}" is carried by ${carriers.length} engine(s) (${carriers.join(", ")}); a cross-engine check needs >= 2` };
        const ref = repRow.get(carriers[0]).get(t);
        for (const e of carriers.slice(1)) {
            const r = repRow.get(e).get(t);
            for (const k of CROSS_ENGINE) {
                if (ref.tokens[k] !== r.tokens[k]) {
                    return { ok: false, reason: `row "${t}" ${k} differs across engines: ${e} ${r.tokens[k] ?? "(absent)"} != ${carriers[0]} ${ref.tokens[k] ?? "(absent)"} (unequal work or a wrong result)` };
                }
            }
        }
    }
    // cells < cellsTotal: some engine carries none of some row (allowed while >= 2 engines do)
    return { ok: true, rows: allTests.size, engines: engines.length, files: entries.length, cells, cellsTotal: allTests.size * engines.length };
}
