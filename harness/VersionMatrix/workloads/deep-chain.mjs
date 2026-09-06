// Long linear computed chain (lite-signal's known DEEP CHAIN weak spot vs alien).
// head -> c0 -> c1 -> ... -> tail; an effect on the tail makes a head write
// propagate the full depth on flush.
export const name = 'deep-chain';
export const phases = ['write', 'read'];
export const defaults = { DEPTH: 900, ITER: 40, WARMUP: 200, MEASURE: 1200, CAP: 2048, SEED: 0x1234abcd };

export function build(E, cfg) {
    const head = E.signal(1);
    let prev = head;
    const chain = new Array(cfg.DEPTH);
    for (let i = 0; i < cfg.DEPTH; i++) { const p = prev; chain[i] = E.computed(() => p() + 1); prev = chain[i]; }
    const tail = chain[cfg.DEPTH - 1];
    let sink = 0;
    const eff = E.effect(() => { sink = tail(); });
    return {
        frame(profiler, rng) {
            profiler.beginFrame();
            profiler.begin('write');
            for (let it = 0; it < cfg.ITER; it++) E.batch(() => { head.set(rng() * 1000); });
            profiler.end('write');
            profiler.begin('read');
            const acc = tail();
            profiler.end('read');
            profiler.endFrame();
            return acc + sink * 0;
        },
        dispose() { if (typeof eff === 'function') eff(); else if (eff && typeof E.dispose === 'function') { try { E.dispose(eff); } catch { /* */ } } }
    };
}
