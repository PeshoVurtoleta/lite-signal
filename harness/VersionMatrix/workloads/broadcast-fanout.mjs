// One source fanning out to many leaves (the BROADCAST loss pattern).
// A single effect reads every leaf, so one source write recomputes all N on flush.
export const name = 'broadcast-fanout';
export const phases = ['write', 'read'];
export const defaults = { LEAVES: 900, ITER: 40, WARMUP: 200, MEASURE: 1200, CAP: 2048, SEED: 0x1234abcd };

export function build(E, cfg) {
    const src = E.signal(1);
    const leaves = new Array(cfg.LEAVES);
    for (let i = 0; i < cfg.LEAVES; i++) { const k = 1 + (i % 7); leaves[i] = E.computed(() => src() * k + i); }
    let sink = 0;
    const eff = E.effect(() => { let s = 0; for (let i = 0; i < leaves.length; i++) s += leaves[i](); sink = s; });
    return {
        frame(profiler, rng) {
            profiler.beginFrame();
            profiler.begin('write');
            for (let it = 0; it < cfg.ITER; it++) E.batch(() => { src.set(rng() * 1000); });
            profiler.end('write');
            profiler.begin('read');
            let acc = 0;
            for (let i = 0; i < leaves.length; i++) acc += leaves[i]();
            profiler.end('read');
            profiler.endFrame();
            return acc + sink * 0;
        },
        dispose() { if (typeof eff === 'function') eff(); else if (eff && typeof E.dispose === 'function') { try { E.dispose(eff); } catch { /* */ } } }
    };
}
