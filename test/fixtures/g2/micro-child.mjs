// Child for test/137: runs micro-suite rows of bench/lib/micro-suites.mjs on the LITE engine only
// (env is read by micro-suites at import, so every config is a fresh process).
//   node --expose-gc micro-child.mjs <mode> [row...]
//   checksums : prints "<row>\t<checksum>" per row
//   fan-sets  : counts `new Set` inside each timed window of the fan rows (globalThis.Set
//               patched; performance.now toggles the window: odd call = t0, even call = t1)
//   fan-past  : runs one fan row, then calls the captured runner past its schedule, then with NaN
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const [mode, ...want] = process.argv.slice(2);
let inWindow = false, windowSets = 0, windows = [];
if (mode === "fan-sets") {
    const RealSet = Set;
    globalThis.Set = class CountingSet extends RealSet { constructor(it) { super(it); if (inWindow) windowSets++; } };
    const realNow = performance.now.bind(performance);
    let calls = 0;
    performance.now = () => {
        calls++;
        if (calls & 1) { inWindow = true; windowSets = 0; } else { inWindow = false; windows.push(windowSets); }
        return realNow();
    };
}
const { createRegistry } = await import(pathToFileURL(join(ROOT, "Signal.js")).href);
const { microRows } = await import(pathToFileURL(join(ROOT, "bench", "lib", "micro-suites.mjs")).href);
const CFG = Object.freeze({ maxNodes: 262144, maxLinks: 1048576, prealloc: "lazy", onCapacityExceeded: "throw" });
let reg = createRegistry(CFG);
const built = [];
const fw = {
    name: "lite-signal",
    signal: (v) => { const s = reg.signal(v); return { read: s, write: s.set }; },
    computed: (fn) => ({ read: reg.computed(fn) }),
    effect: (fn) => { reg.effect(fn); },
    withBatch: (fn) => reg.batch(fn),
    withBuild: (fn) => { const r = fn(); if (typeof r === "function") built.push(r); return r; },
    reset() { reg.destroy(); reg = createRegistry(CFG); },
};
const rows = microRows().filter((r) => want.length === 0 || want.includes(r.name));
if (rows.length === 0) { console.error("no such row: " + want.join(",")); process.exit(2); }
for (const r of rows) {
    windows = [];
    const out = r.run(fw);
    if (mode === "checksums") console.log(r.name + "\t" + out.checksum);
    else if (mode === "fan-sets") console.log(r.name + "\t" + out.checksum + "\t" + windows.join(","));
    else if (mode === "fan-past") {
        const run = built[built.length - 1];
        // the runner has consumed its whole schedule (1000 warm-up + FAN_ITERS steps)
        try { run(1); console.log("past: no throw"); } catch (e) { console.log("past: " + e.message); }
        try { run(NaN); console.log("nan: no throw"); } catch (e) { console.log("nan: " + e.message); }
    }
}
