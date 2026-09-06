// General mixed reactive graph: sources -> layer1 -> layer2, effects on layer2.
// Maps to the general-purpose "KAIROS/mix" shape.
export const name = 'reactive-graph-mix';
export const phases = ['write', 'read'];
export const defaults = { SOURCES: 256, FANIN: 4, L1: 256, L2: 128, EFFECTS: 64, WRITES: 64, ITER: 30, WARMUP: 200, MEASURE: 1200, CAP: 2048, SEED: 0x1234abcd };

export function build(E, cfg) {
    const sources = new Array(cfg.SOURCES);
    for (let i = 0; i < cfg.SOURCES; i++) sources[i] = E.signal(i * 1.0);
    const l1 = new Array(cfg.L1);
    for (let i = 0; i < cfg.L1; i++) {
        const idx = new Array(cfg.FANIN);
        for (let k = 0; k < cfg.FANIN; k++) idx[k] = (i * cfg.FANIN + k) % cfg.SOURCES;
        l1[i] = E.computed(() => { let s = 0; for (let k = 0; k < idx.length; k++) s += sources[idx[k]](); return s; });
    }
    const l2 = new Array(cfg.L2);
    for (let i = 0; i < cfg.L2; i++) {
        const idx = new Array(cfg.FANIN);
        for (let k = 0; k < cfg.FANIN; k++) idx[k] = (i * cfg.FANIN + k) % cfg.L1;
        l2[i] = E.computed(() => { let s = 0; for (let k = 0; k < idx.length; k++) s += l1[idx[k]](); return s; });
    }
    let sink = 0;
    const effects = new Array(cfg.EFFECTS);
    for (let i = 0; i < cfg.EFFECTS; i++) {
        const a = i % cfg.L2, b = (i * 7 + 3) % cfg.L2;
        effects[i] = E.effect(() => { sink += l2[a]() + l2[b](); });
    }
    return {
        frame(profiler, rng) {
            profiler.beginFrame();
            profiler.begin('write');
            for (let it = 0; it < cfg.ITER; it++) {
                E.batch(() => { for (let w = 0; w < cfg.WRITES; w++) sources[(rng() * cfg.SOURCES) | 0].set(rng() * 1000); });
            }
            profiler.end('write');
            profiler.begin('read');
            let acc = 0;
            for (let i = 0; i < cfg.L2; i++) acc += l2[i]();
            profiler.end('read');
            profiler.endFrame();
            return acc;
        },
        dispose() { for (let i = 0; i < effects.length; i++) { const h = effects[i]; if (typeof h === 'function') h(); else if (h && typeof E.dispose === 'function') { try { E.dispose(h); } catch { /* */ } } } }
    };
}
