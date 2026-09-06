// Engine-agnostic reactive workload for cross-version profiling.
//
// The SAME graph is built against whatever lite-signal build is injected as `E`
// (signal/computed/effect/batch/dispose), profiled with lite-profiler, and
// reduced to a CaptureSummary. run.mjs imports ONE engine per process (cold) so
// there is no IC/JIT contamination between versions -- the honest methodology.
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.

export const CFG = {
    LABEL: 'reactive-graph-mix',
    SOURCES: 256,   // source signals
    FANIN: 4,       // deps per computed
    L1: 256,        // layer-1 computeds (fan-in over sources)
    L2: 128,        // layer-2 computeds (fan-in over layer-1)
    EFFECTS: 64,    // effects reading layer-2 (push path)
    WRITES: 48,     // source writes per frame
    WARMUP: 400,    // unmeasured warmup frames (JIT)
    MEASURE: 3000,  // measured frames
    CAP: 4096,      // profiler ring capacity (>= MEASURE)
    SEED: 0x1234abcd
};

// Deterministic LCG so every engine sees an identical input sequence.
function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return (s >>> 8) / 16777216;
    };
}

export function makeGraph(E, cfg) {
    const sources = new Array(cfg.SOURCES);
    for (let i = 0; i < cfg.SOURCES; i++) sources[i] = E.signal(i * 1.0);

    const l1 = new Array(cfg.L1);
    for (let i = 0; i < cfg.L1; i++) {
        const idx = new Array(cfg.FANIN);
        for (let k = 0; k < cfg.FANIN; k++) idx[k] = (i * cfg.FANIN + k) % cfg.SOURCES;
        l1[i] = E.computed(() => {
            let s = 0;
            for (let k = 0; k < idx.length; k++) s += sources[idx[k]]();
            return s;
        });
    }

    const l2 = new Array(cfg.L2);
    for (let i = 0; i < cfg.L2; i++) {
        const idx = new Array(cfg.FANIN);
        for (let k = 0; k < cfg.FANIN; k++) idx[k] = (i * cfg.FANIN + k) % cfg.L1;
        l2[i] = E.computed(() => {
            let s = 0;
            for (let k = 0; k < idx.length; k++) s += l1[idx[k]]();
            return s;
        });
    }

    let sink = 0;
    const effects = new Array(cfg.EFFECTS);
    for (let i = 0; i < cfg.EFFECTS; i++) {
        const a = i % cfg.L2;
        const b = (i * 7 + 3) % cfg.L2;
        effects[i] = E.effect(() => {
            sink += l2[a]() + l2[b]();
        });
    }

    return {
        sources, l1, l2,
        readSink: () => sink,
        dispose() {
            for (let i = 0; i < effects.length; i++) {
                const h = effects[i];
                if (typeof h === 'function') h();
                else if (h && typeof E.dispose === 'function') {
                    try {
                        E.dispose(h);
                    } catch { /* handle not disposable */
                    }
                }
            }
        }
    };
}

function step(E, g, profiler, rng, cfg) {
    profiler.beginFrame();
    profiler.begin('write');
    E.batch(() => {
        for (let w = 0; w < cfg.WRITES; w++) {
            const idx = (rng() * cfg.SOURCES) | 0;
            g.sources[idx].set(rng() * 1000);
        }
    });
    profiler.end('write');
    profiler.begin('read');
    let acc = 0;
    const l2 = g.l2;
    for (let i = 0; i < l2.length; i++) acc += l2[i]();
    profiler.end('read');
    profiler.endFrame();
    return acc;
}

/**
 * Build the graph, warm it up (unmeasured), run MEASURE frames under a fresh
 * Profiler, and summarize. Returns { summary, sink }.
 */
export function profileEngine(E, Profiler, summarize, meta, cfg = CFG) {
    const g = makeGraph(E, cfg);

    // warmup: same frame fn, throwaway profiler, discarded
    let rng = lcg(cfg.SEED ^ 0x9e3779b9);
    const scratch = new Profiler(cfg.CAP, ['write', 'read']);
    for (let i = 0; i < cfg.WARMUP; i++) step(E, g, scratch, rng, cfg);
    scratch.destroy();

    // measured: reset rng to SEED so the input sequence is identical per engine
    rng = lcg(cfg.SEED);
    const p = new Profiler(cfg.CAP, ['write', 'read']);
    let acc = 0;
    for (let i = 0; i < cfg.MEASURE; i++) acc += step(E, g, p, rng, cfg);

    const summary = summarize(p, meta);
    p.destroy();
    g.dispose();
    return {summary, sink: acc};
}
