// One source -> EFFECTS effects: the effect-dense flush (ledger bar 1b, the
// BROADCAST row). Every write queues and runs EFFECTS effect bodies, so the
// markDownstream effect branch, the flush loop and executeEffect's framing are
// paid EFFECTS times per write.
//
// Why a separate workload: the resident 'broadcast-fanout' is a KAIROS shape
// (1 -> 900 computeds -> ONE effect). It runs one effect per write, so an
// executeEffect / flush-loop regression (#18: +21-23% on effect-dense graphs)
// is structurally invisible to it -- and so was the #27 link-SoA fork's +30%
// on 1 -> 1000 effects (measured 2026-09-24).
//
// ITER 16 (~110 us/frame on the 2026 reference host) chosen by measured self-noise,
// six cold reps of 1.5.2 per setting: ITER 8 spread 15.1% (trips the 15% evidence
// guard), ITER 16 spread 5.6%, ITER 32 spread 10.2%. Recalibrate with a two-capture
// `npm run calibrate` before tightening anything.
export const name = 'effect-fanout';
export const phases = ['write'];
export const defaults = { EFFECTS: 512, ITER: 16, WARMUP: 200, MEASURE: 1200, CAP: 2048, SEED: 0x1234abcd };

export function build(E, cfg) {
    const src = E.signal(1);
    const sinks = new Float64Array(cfg.EFFECTS);
    const effs = new Array(cfg.EFFECTS);
    for (let i = 0; i < cfg.EFFECTS; i++) effs[i] = E.effect(() => { sinks[i] = src() + i; });
    return {
        frame(profiler, rng) {
            profiler.beginFrame();
            profiler.begin('write');
            for (let it = 0; it < cfg.ITER; it++) src.set(rng() * 1000);
            profiler.end('write');
            profiler.endFrame();
            return sinks[(rng() * cfg.EFFECTS) | 0];
        },
        dispose() {
            for (let i = 0; i < effs.length; i++) {
                const h = effs[i];
                if (typeof h === 'function') h();
                else if (h && typeof E.dispose === 'function') { try { E.dispose(h); } catch { /* */ } }
            }
        }
    };
}
