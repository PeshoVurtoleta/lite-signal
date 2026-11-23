// bench/lib/sink-oracle.mjs -- independent expected sink values for the microscope
// (bench/benchmark.mjs). b250 G1 (M3).
//
// Plain JS: no engine import. Each scenario is recomputed from its definition: the
// timed loop drives drive(i) for i = 0 .. iterations - 1, so the final source value is
// v = iterations - 1 (MUX writes sigs[i % N] = i instead). The DAG rows copy the
// adapters' dep-index formulas AND their summation order exactly, because their values
// pass 2^53 and floating-point addition is order-sensitive: a different order is a
// different (wrong) expected value.
//
// expectedSink(key, N, iterations) -> [[offset, value], ...], offsets relative to the
// row's sink slot, ascending. benchmark.mjs resets the sink before every timed run and
// checks every pair exactly after it (guards.checkSinkExact), so a value left over from
// set-up or warm-up can never pass. Throws on an unknown key or a bad argument (cold;
// fail closed).

// The source value the last drive(i) of a timed run writes.
export function finalSource(iterations) {
    if (!Number.isInteger(iterations) || iterations < 2) throw new RangeError("expectedSink: iterations must be an integer >= 2");
    return iterations - 1;
}

// D-b250-2: rows whose engine re-runs effects in an order that is not creation order, so
// the exact per-slot value is not defined; benchmark.mjs checks them with
// guards.checkSinkResidue over the same offsets. Every other row is checked exactly.
export const RESIDUE_ROWS = Object.freeze(["solid/broadcast"]);
export function sinkCheckMode(lib, key) {
    return RESIDUE_ROWS.includes(lib + "/" + key) ? "residue" : "exact";
}

export function expectedSink(key, N, iterations) {
    if (!Number.isInteger(N) || N < 1) throw new RangeError("expectedSink: N must be a positive integer");
    const v = finalSource(iterations);
    switch (key) {
        case "kairos": {
            // N computeds src * (i + 1); one effect sums them in index order.
            let s = 0;
            for (let i = 0; i < N; i++) s += v * (i + 1);
            return [[0, s]];
        }
        case "broadcast": {
            // N effects, effect k writes slot (k & 31) = src + k; effects re-run in
            // creation order, so the highest k of each residue class writes last.
            const slots = new Array(32).fill(undefined);
            for (let k = 0; k < N; k++) slots[k & 31] = v + k;
            const out = [];
            for (let j = 0; j < 32; j++) if (slots[j] !== undefined) out.push([j, slots[j]]);
            return out;
        }
        case "deepChain": {
            // N computeds, each p() + 1, from src.
            let x = v;
            for (let i = 0; i < N; i++) x = x + 1;
            return [[0, x]];
        }
        case "mux": {
            // drive(i) writes sigs[i % N] = i; signal j ends at the largest i < iterations
            // with i % N === j (0 when no such i). One computed sums sigs in index order.
            const last = iterations - 1;
            let s = 0;
            for (let j = 0; j < N; j++) {
                const val = j <= last ? j + N * Math.floor((last - j) / N) : 0;
                s += val;
            }
            return [[0, s]];
        }
        case "dynamicDag": {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const FAN = 6;
            let prevLayer = [v];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = new Array(W);
                for (let w = 0; w < W; w++) {
                    const deps = new Array(FAN);
                    for (let k = 0; k < FAN; k++) deps[k] = prevLayer[(w * 7 + k * 11) % prevLayer.length];
                    let s = 0;
                    if (v & 1) {
                        for (let k = 0; k < FAN; k++) s += deps[k];
                    } else {
                        for (let k = FAN - 1; k >= 0; k--) s += deps[k];
                    }
                    newLayer[w] = s;
                }
                prevLayer = newLayer;
            }
            let s = 0;
            for (let i = 0; i < prevLayer.length; i++) s += prevLayer[i];
            return [[0, s]];
        }
        case "selectiveDag": {
            const W = Math.max(4, Math.ceil(Math.sqrt(N)));
            const L = Math.max(2, Math.ceil(N / W));
            const POOL = 4;
            const PAIRS = [[0, 1], [0, 2], [1, 3], [2, 3]];
            const which = v & 3;
            const a = PAIRS[which][0], b = PAIRS[which][1];
            let prevLayer = [v];
            for (let layer = 0; layer < L; layer++) {
                const newLayer = new Array(W);
                for (let w = 0; w < W; w++) {
                    const cand = new Array(POOL);
                    for (let k = 0; k < POOL; k++) cand[k] = prevLayer[(w * 7 + k * 13) % prevLayer.length];
                    newLayer[w] = cand[a] + cand[b];
                }
                prevLayer = newLayer;
            }
            let s = 0;
            for (let i = 0; i < prevLayer.length; i++) s += prevLayer[i];
            return [[0, s]];
        }
        default:
            throw new Error("expectedSink: unknown scenario key " + JSON.stringify(key));
    }
}
