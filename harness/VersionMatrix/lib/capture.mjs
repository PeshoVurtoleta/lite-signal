// Shared capture core: build a workload against an injected engine, warm it up
// (unmeasured), run the measured frames under a fresh Profiler, and summarize.
// One engine per process (the caller enforces cold isolation).
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>  MIT License.

import os from 'node:os';

// Deterministic LCG: every engine and every run sees an identical input stream.
export function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return (s >>> 8) / 16777216;
    };
}

export function envMeta() {
    const c = os.cpus();
    return {
        node: process.version,
        arch: process.arch,
        platform: os.platform() + ' ' + os.release(),
        cpu: (c && c[0] && c[0].model) ? c[0].model : 'unknown',
        cores: c ? c.length : 0,
        date: new Date().toISOString()
    };
}

/**
 * @param {Function} Profiler @param {Function} summarize
 * @param {{name:string, phases:string[], defaults:object, build:Function}} workload
 * @param {object} E injected lite-signal engine
 * @param {object} meta summary metadata (label, engine, budgetMs)
 * @param {object} [override] optional cfg overrides
 * @returns {{summary:object, sink:number}}
 */
export function profile(Profiler, summarize, workload, E, meta, override) {
    const cfg = Object.assign({}, workload.defaults, override || null);

    const g = workload.build(E, cfg);

    // Counter channels are ENGINE-dependent (a workload registers them only
    // when the engine carries the exact counters it samples), so the built
    // graph decides -- not the workload module. No channels on an engine
    // without the surface means the counter lane is absent from the summary
    // entirely, which checkRegression skips leniently for a baseline and
    // fails closed for a candidate that DROPPED it.
    const counters = g.counters || [];

    // warmup (unmeasured, throwaway profiler) -- JIT
    let rng = lcg(cfg.SEED ^ 0x9e3779b9);
    const scratch = new Profiler(cfg.CAP, workload.phases, counters);
    for (let i = 0; i < cfg.WARMUP; i++) g.frame(scratch, rng);
    scratch.destroy();

    // measured -- reset rng to SEED so the sequence is identical across engines
    rng = lcg(cfg.SEED);
    const p = new Profiler(cfg.CAP, workload.phases, counters);
    let sink = 0;
    for (let i = 0; i < cfg.MEASURE; i++) sink += g.frame(p, rng);

    const summary = summarize(p, meta);
    p.destroy();
    g.dispose();
    return { summary, sink };
}
