// One-shot generator for the tracked fixture (kept for provenance; the tests never run it).
// Writes bench-runs/{lite-signal,alien-signals}-rep{1,2,3}.txt + COMPLETE.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepText } from "./rep-text.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "bench-runs");
mkdirSync(dir, { recursive: true });
// Per-scenario [rep1, rep2, rep3] ms; unsorted on purpose so median != mean != first.
export const TIMES = {
    "lite-signal": [[10, 12, 11], [20.5, 19.5, 30], [5, 7, 6], [8.25, 8.75, 2], [40, 41, 39.5], [15, 14, 13]],
    "alien-signals": [[13, 9, 11.5], [18, 22, 21], [4, 4.5, 4.25], [9, 8, 50], [37, 35, 36], [16, 17, 18]],
};
for (const lib of Object.keys(TIMES)) {
    for (let rep = 0; rep < 3; rep++) {
        const times = TIMES[lib].map((t) => t[rep]);
        writeFileSync(join(dir, lib + "-rep" + (rep + 1) + ".txt"), makeRepText({ lib, times }));
    }
}
writeFileSync(join(dir, "COMPLETE"),
    '{"kind":"bench-capture-complete/v1","writer":"run-all-bench.sh","protocol":"isolated-per-engine","reps":3,"engines":["lite-signal","alien-signals"]}\n');
