// Branch-flipping computed bodies force dependency retracking every cycle
// (the DYNAMIC DAG pattern -- lite-signal's strength, and the 1.1.4 retrack path).
export const name = 'dynamic-dep-churn';
export const phases = ['write', 'read'];
export const defaults = { COMPS: 400, POOL: 160, ITER: 24, WARMUP: 200, MEASURE: 1200, CAP: 2048, SEED: 0x1234abcd };

export function build(E, cfg) {
    const sel = E.signal(0);
    const a = new Array(cfg.POOL), b = new Array(cfg.POOL);
    for (let i = 0; i < cfg.POOL; i++) { a[i] = E.signal(i + 1); b[i] = E.signal(i + 2); }
    const comps = new Array(cfg.COMPS);
    for (let i = 0; i < cfg.COMPS; i++) {
        const p = i % cfg.POOL, q = (i * 3 + 1) % cfg.POOL;
        comps[i] = E.computed(() => (sel() === 0 ? a[p]() + a[q]() : b[p]() + b[q]()));
    }
    let sink = 0;
    const eff = E.effect(() => { let s = 0; for (let i = 0; i < comps.length; i++) s += comps[i](); sink = s; });
    return {
        frame(profiler, rng) {
            profiler.beginFrame();
            profiler.begin('write');
            for (let it = 0; it < cfg.ITER; it++) {
                E.batch(() => {
                    sel.set((it & 1) ? 1 : 0);                 // flip branch -> every comp retracks
                    const j = (rng() * cfg.POOL) | 0;
                    a[j].set(rng() * 1000); b[j].set(rng() * 1000);
                });
            }
            profiler.end('write');
            profiler.begin('read');
            let acc = 0;
            for (let i = 0; i < comps.length; i++) acc += comps[i]();
            profiler.end('read');
            profiler.endFrame();
            return acc + sink * 0;
        },
        dispose() { if (typeof eff === 'function') eff(); else if (eff && typeof E.dispose === 'function') { try { E.dispose(eff); } catch { /* */ } } }
    };
}
