// MUX: many inputs -> one sum computed -> one effect (the long dep-list walk).
// Every write re-validates a 256-long dep list in pullComputed and re-tracks 256
// reads through the retracking cursor, so a per-hop cost change (a layout move,
// a bigger read body) shows here first. The shape that exposed #10 (+36-49%)
// and #12 (+65-78%), and -- because none of the five original workloads walks a
// long dep list -- the one the #27 link-SoA fork passed the matrix without
// (+30% on this shape, measured 2026-09-24).
// Self-noise at these defaults (~40 us/frame): frame.avg spread 1.5% over three cold
// reps of 1.5.2, deterministic sink across reps.
export const name = 'mux';
export const phases = ['write', 'read'];
export const defaults = { INPUTS: 256, ITER: 32, WARMUP: 200, MEASURE: 1200, CAP: 2048, SEED: 0x1234abcd };

export function build(E, cfg) {
    const ins = new Array(cfg.INPUTS);
    for (let i = 0; i < cfg.INPUTS; i++) ins[i] = E.signal(i * 1.0);
    const sum = E.computed(() => { let s = 0; for (let i = 0; i < ins.length; i++) s += ins[i](); return s; });
    let sink = 0;
    const eff = E.effect(() => { sink = sum(); });
    return {
        frame(profiler, rng) {
            profiler.beginFrame();
            profiler.begin('write');
            for (let it = 0; it < cfg.ITER; it++) ins[(rng() * cfg.INPUTS) | 0].set(rng() * 1000);
            profiler.end('write');
            profiler.begin('read');
            const acc = sum();
            profiler.end('read');
            profiler.endFrame();
            return acc + sink * 0;
        },
        dispose() { if (typeof eff === 'function') eff(); else if (eff && typeof E.dispose === 'function') { try { E.dispose(eff); } catch { /* */ } } }
    };
}
