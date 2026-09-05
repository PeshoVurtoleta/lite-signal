// Single source of truth for the microscope engine list.
//
// benchmark.mjs derives its ALL_LIBS from ENGINE_KEYS here (and asserts it has an
// ADAPTERS implementation for every key, so the two files cannot drift silently);
// aggregate.mjs reads ENGINES for labels + key order; run-all-bench.sh reads
// ENGINE_KEYS for its round-robin schedule. The engine set is declared in exactly
// ONE place.
//
// The reactive harness (benchmarkReactive.mjs) and its vue-reactivity engine were
// retired in bench protocol v3, along with the per-harness key filtering (keysFor)
// and the unused selectedKeys/makeWant helpers. This list is now the microscope's
// engines only; the full cross-framework field runs in bench/mirror.mjs against
// alien-signals.
//
// key   = FW= filter token AND the ADAPTERS key inside benchmark.mjs
// label = report column header (defaults to key)
// kind  = "lite" (a @zakkster/lite-signal build) | "ref" (a third-party engine)
// path  = engine module path relative to the harness (lite builds only)

export const ENGINES = [
    { key: "lite-signal",   label: "@zakkster/lite-signal", kind: "lite", path: "../Signal.js" },
    { key: "alien-signals", label: "alien-signals",         kind: "ref" },
    { key: "preact",        label: "preact-signals",        kind: "ref" },
    { key: "solid",         label: "solid-signals",         kind: "ref" },
];

// Ordered list of all engine keys.
export const ENGINE_KEYS = ENGINES.map((e) => e.key);
