// Single source of truth for the benchmark engine list.
// benchmark.mjs, benchmarkReactive.mjs, aggregate.mjs, and run-all.sh all read
// from here so the framework set is declared in exactly ONE place.
//
// To add/remove an engine: edit ENGINES below. Every consumer updates automatically.
//
// `key`  = the FW= filter token and the adapter key inside the harnesses.
// `label`= column header in reports (defaults to key).
// `kind` = "lite" (a @zakkster/lite-signal build) or "ref" (alien/preact/solid).
// `path` = engine module path, relative to the harness file (lite builds only).

export const ENGINES = [
    {key: "lite-signal", label: "@zakkster/lite-signal", kind: "lite", path: "../Signal.js", harness: "both"},
    {key: "alien-signals", label: "alien-signals", kind: "ref", harness: "both"},
    {key: "preact", label: "preact-signals", kind: "ref", harness: "both"},
    {key: "solid", label: "solid-signals", kind: "ref", harness: "both"},
    {key: "vue-reactivity", label: "vue-js", kind: "ref", harness: "reactive"},
];

// Keys for a given harness ("benchmark" | "reactive"). "both"-tagged engines
// always included. This lets the two harnesses — which legitimately test
// different version subsets — share ONE declaration.
export function keysFor(harness) {
    return ENGINES
        .filter((e) => e.harness === harness || e.harness === "both")
        .map((e) => e.key);
}

// Ordered list of ALL keys (used by the benchmark harness + run-all.sh default).
export const ENGINE_KEYS = keysFor("benchmark");

// Resolve the active set from the FW env var (comma-separated keys).
// No FW → all engines. Unknown keys are dropped (with the valid set kept).
export function selectedKeys(fwEnv) {
    if (!fwEnv) return ENGINE_KEYS.slice();
    const want = new Set(fwEnv.split(",").map((s) => s.trim()));
    return ENGINE_KEYS.filter((k) => want.has(k));
}

// Convenience: a `want(key)` predicate for the harnesses' gated registration.
export function makeWant(fwEnv) {
    const set = fwEnv ? new Set(fwEnv.split(",").map((s) => s.trim())) : null;
    return (key) => set === null || set.has(key);
}
