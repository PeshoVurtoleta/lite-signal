// Does SAB mode actually run effects when not wrapped in batch()?
import { createRegistry } from "./v17/Signal.js";

const SINK = new Float64Array(64);
let effectRuns = 0;

function build(mode) {
    const cfg = { maxNodes: 64, prealloc: "eager", onCapacityExceeded: "grow" };
    if (mode === "sab") cfg.flushStrategy = "sab";
    const r = createRegistry(cfg);
    const src = r.signal(0);
    const c1 = r.computed(() => src() * 2);
    const c2 = r.computed(() => src() * 3);
    effectRuns = 0;
    r.effect(() => { SINK[0] = c1() + c2(); effectRuns++; });
    return { r, src };
}

for (const mode of ["eager", "sab"]) {
    const { r, src } = build(mode);
    console.log(`\n=== ${mode} mode ===`);
    console.log(`After setup: SINK[0]=${SINK[0]}, effectRuns=${effectRuns}`);
    SINK[0] = 0;
    effectRuns = 0;
    // Drive 1000 writes without batch wrapping (matches my bench runner)
    for (let i = 1; i <= 1000; i++) src.set(i);
    console.log(`After 1000 src.set() (no batch, no flush): SINK[0]=${SINK[0]}, effectRuns=${effectRuns}`);
    // Now an explicit flush (only matters in sab/manual)
    if (r.flush) r.flush();
    console.log(`After r.flush(): SINK[0]=${SINK[0]}, effectRuns=${effectRuns}`);
    r.destroy();
}
