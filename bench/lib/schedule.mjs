// bench/lib/schedule.mjs -- round-robin rep scheduling.
//
// F3: run-all-bench.sh iterates `for eng; for rep` -- all 10 reps of engine 1, then
// all 10 of engine 2. That is defect #1 of the retired sbench driver, named in
// harness/toe-to-toe/README.md ("Ordering bias -- the thermal artifact"): the last
// engine always runs on the hottest chassis, which is how deepChain showed a
// MONOTONIC slowdown across 1.9->1.10->1.11 -- three engines whose propagation bodies
// are sha256-IDENTICAL. Identical code cannot trend; the trend was the machine heating
// up under a fixed order.
//
// Fix (toe-to-toe's fix): round-robin. Each rep wave runs EVERY engine once, in a
// rotated order, so thermal drift spreads across all columns instead of loading the
// last one. buildSchedule returns a flat list of {engine, rep, wave} steps in the
// order they should execute.

// engines: string[]  reps: number  -> [{engine, rep, wave, index}]
export function buildSchedule(engines, reps) {
    const n = engines.length;
    const steps = [];
    let index = 0;
    for (let wave = 0; wave < reps; wave++) {
        // rotate the starting engine each wave so no engine is pinned to the hot slot
        for (let k = 0; k < n; k++) {
            const eng = engines[(wave + k) % n];
            steps.push({ engine: eng, rep: wave + 1, wave, index: index++ });
        }
    }
    return steps;
}

// Emit the schedule as shell-consumable lines "engine rep" so a thin .mjs driver can
// exec them, or a Makefile/loop can read them. One line per cold process to spawn.
export function scheduleLines(engines, reps) {
    return buildSchedule(engines, reps).map((s) => `${s.engine} ${s.rep}`);
}

// For the sentinel drift check (ported from toe-to-toe): the FIRST-scheduled combo is
// re-measured as an extra trailing step. Caller compares its time to the same combo's
// earlier measurement; a delta beyond DRIFT_TOL means the host drifted mid-sweep and
// the whole sweep is thermally suspect.
// Sentinel drift tolerance. Host-calibratable: VersionMatrix's README is explicit that
// tolerances should be set from measured self-noise ("calibrate before tightening").
// A quiet host at full scale wants ~5%; a noisy shared box or sub-10ms measurements
// need more headroom. Override with DRIFT_TOL env (fraction, e.g. 0.15).
export const DRIFT_TOL = Number(process.env.DRIFT_TOL || 0.05);

export function withSentinel(steps) {
    if (steps.length === 0) return steps;
    const first = steps[0];
    return [...steps, { engine: first.engine, rep: "sentinel", wave: -1, index: steps.length, sentinel: true }];
}

export function sentinelDrift(baselineTime, sentinelTime) {
    const ratio = sentinelTime / baselineTime;
    return { ratio, drifted: Math.abs(ratio - 1) > DRIFT_TOL };
}
