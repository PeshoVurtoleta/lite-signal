// Per-frame create -> write -> dispose churn: the CREATION lane, previously
// the only bench axis with zero timing gate (2026-08 audit HIGH #3 -- creation
// is lite-signal's weakest competitive axis, and a 2x node-birth regression or
// an O(active) dispose walk shipped green). Every frame builds CHURN fresh
// signal+computed+effect triples against a small persistent backbone, drives
// batched writes through them, then disposes all of them -- so phase.create
// and phase.dispose time exactly the birth and teardown paths.
//
// COUNTER LANE (engines with the 1.4.0 stats counters): the frame also counts
// the engine's own exact deltas -- 'allocs' (totalAllocations) and
// 'poolGrowths' -- via the profiler's counter channels. Under the fixed
// creation schedule both are deterministic: allocs is exactly 3*CHURN per
// frame and poolGrowths is exactly 0 (steady churn must be served entirely by
// pool recycling). Gated at ZERO tolerance (counter.allocs.max /
// counter.poolGrowths.max): an engine that starts allocating one node more
// per frame, or growing the pool under steady churn, fails EXACTLY, with no
// timing noise involved. On engines without the counters (< 1.4.0) no
// channels are registered and the counter lane skips leniently -- but a
// candidate that DROPS the counters while rolling has them fails closed
// (checkRegression treats a vanished counter as a structural regression).
// stats() itself is called every frame on EVERY engine (the 8-key shape is
// 1.0+) so the frame cost stays symmetric across versions.
export const name = 'creation-churn';
export const phases = ['create', 'write', 'dispose'];
// CHURN sized so a frame is ~25-30 us on the 2026 reference host: large enough
// that p99 is engine work rather than timer jitter, small enough that 288
// in-flight nodes sit well under the default registry's 1024-node pool.
export const defaults = { CHURN: 96, BACKBONE: 8, WRITES: 32, WARMUP: 300, MEASURE: 1500, CAP: 2048, SEED: 0x1234abcd };

export function build(E, cfg) {
    const backbone = new Array(cfg.BACKBONE);
    for (let i = 0; i < cfg.BACKBONE; i++) backbone[i] = E.signal(i * 1.0);

    // Scratch reused across frames: the workload itself allocates nothing per
    // frame beyond the engine calls under measurement.
    const sigs = new Array(cfg.CHURN), comps = new Array(cfg.CHURN), stops = new Array(cfg.CHURN);
    let sink = 0;

    const st0 = typeof E.stats === 'function' ? E.stats() : null;
    const hasCounters = !!(st0 && typeof st0.totalAllocations === 'number' && typeof st0.poolGrowths === 'number');
    let prevAllocs = hasCounters ? st0.totalAllocations : 0;
    let prevGrowths = hasCounters ? st0.poolGrowths : 0;

    return {
        counters: hasCounters ? ['allocs', 'poolGrowths'] : [],
        frame(profiler, rng) {
            profiler.beginFrame();
            profiler.begin('create');
            for (let i = 0; i < cfg.CHURN; i++) {
                const s = E.signal(i * 1.0);
                sigs[i] = s;
                const b = backbone[i % cfg.BACKBONE];
                const c = E.computed(() => s() + b());
                comps[i] = c;
                stops[i] = E.effect(() => { sink += c(); });
            }
            profiler.end('create');
            profiler.begin('write');
            E.batch(() => {
                for (let w = 0; w < cfg.WRITES; w++) {
                    if (w & 1) backbone[(rng() * cfg.BACKBONE) | 0].set(rng() * 1000);
                    else sigs[(rng() * cfg.CHURN) | 0].set(rng() * 1000);
                }
            });
            profiler.end('write');
            profiler.begin('dispose');
            for (let i = 0; i < cfg.CHURN; i++) {
                const h = stops[i];
                if (typeof h === 'function') h(); else E.dispose(h);
                E.dispose(comps[i]);
                E.dispose(sigs[i]);
            }
            profiler.end('dispose');
            // Engine-exact counters, sampled OUTSIDE the timed phases. The
            // stats() call itself runs on every engine for frame-cost symmetry.
            const st = typeof E.stats === 'function' ? E.stats() : null;
            if (hasCounters) {
                profiler.count('allocs', st.totalAllocations - prevAllocs);
                profiler.count('poolGrowths', st.poolGrowths - prevGrowths);
                prevAllocs = st.totalAllocations;
                prevGrowths = st.poolGrowths;
            }
            profiler.endFrame();
            return sink;
        },
        dispose() {
            for (let i = 0; i < cfg.BACKBONE; i++) { try { E.dispose(backbone[i]); } catch { /* pre-dispose engines */ } }
        }
    };
}
