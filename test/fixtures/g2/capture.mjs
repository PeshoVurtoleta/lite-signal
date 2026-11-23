// Capture-dir fixture builder for test/136 (G2 b251). Rows are named from the live mirror
// config (mirror-config + title + micro-suites); values are synthetic but shaped like
// mirror.mjs output. Nothing here runs an engine. build -> mutate the model -> write to a dir.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
const BENCH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bench", "lib");
const U = (f) => pathToFileURL(join(BENCH, f)).href;
const { DYNAMIC_TESTS, scaleQuick } = await import(U("mirror-config.mjs"));
const { testColumn } = await import(U("title.mjs"));
const { microRows } = await import(U("micro-suites.mjs"));

export const CAP = "20261123T120000Z-0a1b2c3d";
export const SHA_E = "a7202c9bb9af63007a76662330aa43b40e40442c80493347a3711dd23789bf89";
export const SHA_H = "d326ef8ef2da5202b2ad4cf57847e1e924717f41e92ee858383ce275a80361ec";
export const LITE = "lite-signal", ALIEN = "alien-signals", REFLEX = "reflex-quant";
export const DYN = scaleQuick(DYNAMIC_TESTS, false).map(testColumn);
export const MICRO = microRows().map((r) => ({ name: r.name, group: r.group }));

export function stampFor(engine, node = "v26.8.2") {
    return {
        kind: "bench-stamp/v1", date: "2026-11-23T12:00:00.000Z", protocol: "isolated-per-engine", reps: 2,
        node, arch: "arm64", platform: "darwin", cpu: "Apple M4 Pro", gcExposed: true,
        enginePath: "/x/LiteSignal/Signal.js", engineSha256: SHA_E,
        harnessPath: "/x/LiteSignal/bench/mirror.mjs", harnessSha256: SHA_H,
        config: { maxNodes: 262144, maxLinks: 1048576, prealloc: "lazy", onCapacityExceeded: "throw" },
        extra: { ceiling_ms: 1500, quick: false, adapter: "destroy", scenario: "all", captureId: CAP,
            refLibs: engine === LITE ? {} : { [engine]: "3.2.1" }, load1: 1.5 },
    };
}
export function rowsFor(engine, rep) {
    const out = [];
    DYN.forEach((t, i) => {
        const tokens = [["nodesRecomputed", String(1000 + i)], ["nodesVisited", String(1000 + i)], ["edgesTraversed", String(4000 + 7 * i)], ["sinkReads", String(50 + i)], ["sum", String(123456789 + 1000 * i)]];
        if (engine === LITE) tokens.push(["poolGrowths", "0"]);
        out.push({ fw: engine, test: t, time: (5 + i + rep * 0.37).toFixed(2), tokens, capped: false });
    });
    MICRO.forEach((m, i) => {
        const tokens = m.group === "s" ? [] : [["checksum", String(9000 + 11 * i)]];
        out.push({ fw: engine, test: m.name, time: (1 + i * 0.1 + rep * 0.05).toFixed(2), tokens, capped: false });
    });
    return out;
}
// model: { files: { "<engine>-rep<N>.txt": { engine, stamp, rows } }, marker }
export function cleanModel(engines = [LITE, ALIEN], reps = 2) {
    const m = { files: {}, marker: { kind: "bench-capture-complete/v1", writer: "run-all-mirror.sh", protocol: "isolated-per-engine", reps, engines: engines.slice(), captureId: CAP } };
    for (const e of engines) for (let r = 1; r <= reps; r++) m.files[`${e}-rep${r}.txt`] = { engine: e, stamp: stampFor(e), rows: rowsFor(e, r) };
    return m;
}
const pad = (s, n) => { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); };
export function writeModel(d, m) {
    mkdirSync(d, { recursive: true });
    for (const [fn, f] of Object.entries(m.files)) {
        const L = ["#STAMP " + (typeof f.stamp === "string" ? f.stamp : JSON.stringify(f.stamp)), ["framework".padEnd(22), "test".padEnd(60), "time".padEnd(8), "metrics"].join(" , ")];
        for (const r of f.rows) {
            if (r.raw !== undefined) { L.push(r.raw); continue; }
            const met = (r.capped ? [r.capped] : []).concat(r.tokens.map(([k, v]) => k + "=" + v)).join(" ");
            L.push([pad(r.fw, 22), pad(r.test, 60), pad(r.time, 8), met].join(" , "));
        }
        writeFileSync(join(d, fn), L.join("\n") + "\n");
    }
    if (m.marker) writeFileSync(join(d, "COMPLETE"), JSON.stringify(m.marker) + "\n");
}
export const each = (m, pred, fn) => { for (const f of Object.values(m.files)) if (pred(f)) fn(f); };
export const isE = (e) => (f) => f.engine === e;
export const ALL = () => true;
export const tok = (r, k) => r.tokens.find((t) => t[0] === k);
export const delTok = (r, k) => { r.tokens = r.tokens.filter((t) => t[0] !== k); };
export const row0 = (f) => f.rows[0];
export const firstOf = (f, group) => f.rows.find((r) => MICRO.some((x) => x.name === r.test && x.group === group));
