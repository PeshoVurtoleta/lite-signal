// bench/lib/mirror-config.mjs -- Andrii's dynamic perfTests, ported verbatim from
// src config.ts. These are the "dynamic" suite rows; kairo/fan/mol/S live in the
// harness alongside. Correctness is verified by CROSS-ENGINE AGREEMENT in mirror.mjs
// (lite and alien must produce the same result sum + counters on each shape), not by
// hand-transcribed `expected` vectors -- his config.ts vectors proved stale against his
// own current log, so the mirror checks engines against each other instead.
//
// Grouped exactly as his config.ts comments group them, so the port is auditable
// against the source side-by-side.

export const DYNAMIC_TESTS = [
    // App-like scenarios
    { name: "dashboard selective reads", width: 64, totalLayers: 6, staticFraction: 0.95, nSources: 4, readFraction: 0.12, iterations: 120000 },
    { name: "editor derived state", width: 24, totalLayers: 8, staticFraction: 0.8, nSources: 3, readFraction: 0.4, iterations: 90000 },
    { name: "kanban board", width: 120, totalLayers: 7, staticFraction: 0.9, nSources: 5, readFraction: 0.18, iterations: 30000 },
    { name: "entity detail page", width: 40, totalLayers: 10, staticFraction: 0.97, nSources: 4, readFraction: 0.6, iterations: 30000 },

    // Layered-DAG full-drain + burst + diamond-mesh (warm shapes: measureBuild=false)
    { name: "layered full-drain cold", graphKind: "layered-dag", width: 512, sourcesCount: 256, totalLayers: 32, staticFraction: 1, nSources: 4, fanIn: 4, readFraction: 1, sinkReadMode: "per-update", iterations: 120, warmupIterations: 0, measureBuild: false },
    { name: "layered full-drain warm", graphKind: "layered-dag", width: 512, sourcesCount: 256, totalLayers: 32, staticFraction: 1, nSources: 4, fanIn: 4, readFraction: 1, sinkReadMode: "per-update", iterations: 120, warmupIterations: 320, measureBuild: false },
    { name: "layered burst flush warm", graphKind: "layered-dag", width: 512, sourcesCount: 256, totalLayers: 32, staticFraction: 1, nSources: 8, fanIn: 8, readFraction: 1, sinkReadMode: "per-batch", updatesPerIteration: 16, iterations: 96, warmupIterations: 256, measureBuild: false },
    { name: "stable diamond mesh warm", graphKind: "diamond-mesh", width: 512, sourcesCount: 256, totalLayers: 32, staticFraction: 1, nSources: 8, fanIn: 8, readFraction: 1, sinkReadMode: "per-update", iterations: 96, warmupIterations: 256, measureBuild: false },

    // Pull / push modes
    { name: "pure pull", mode: "pull", width: 32, totalLayers: 8, staticFraction: 1, nSources: 4, readFraction: 1, iterations: 10000 },
    { name: "linear chain - 1 source - pull (linear pull)", mode: "pull", width: 8, totalLayers: 64, staticFraction: 1, nSources: 1, readFraction: 1, iterations: 10000 },
    { name: "wide tree - 8 sources - pull (branchy pull)", mode: "pull", width: 64, totalLayers: 4, staticFraction: 1, nSources: 8, readFraction: 1, iterations: 10000 },
    { name: "pure push", mode: "push", width: 32, totalLayers: 8, staticFraction: 1, nSources: 4, readFraction: 1, iterations: 10000 },

    // Stress-style, kept for continuity
    { name: "simple component", width: 10, staticFraction: 1, nSources: 2, totalLayers: 5, readFraction: 0.2, iterations: 600000 },
    { name: "dynamic component", width: 10, totalLayers: 10, staticFraction: 3 / 4, nSources: 6, readFraction: 0.2, iterations: 15000 },
    { name: "large web app", width: 1000, totalLayers: 12, staticFraction: 0.95, nSources: 4, readFraction: 1, iterations: 7000 },
    { name: "wide dense", width: 1000, totalLayers: 5, staticFraction: 1, nSources: 25, readFraction: 1, iterations: 3000 },
    { name: "deep", width: 5, totalLayers: 500, staticFraction: 1, nSources: 3, readFraction: 1, iterations: 500 },
];

// QUICK mode shrinks iteration counts for a fast smoke run (matches the QUICK spirit of
// benchmarkReactive.mjs). Structure is untouched so counters stay meaningful.
export function scaleQuick(tests, quick) {
    if (!quick) return tests;
    return tests.map((t) => ({ ...t, iterations: Math.max(50, Math.round(t.iterations / 50)), warmupIterations: t.warmupIterations ? Math.max(8, Math.round(t.warmupIterations / 8)) : t.warmupIterations }));
}
