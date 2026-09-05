// bench/lib/structure-probe.mjs -- structural fingerprint via onGraphMutation.
//
// The burst-dag dividend (Session 5): a timing regression is far more actionable when
// it arrives with its structural cause attached. "burst +18%, flushPasses 1->3" reads
// itself; "burst +18%" alone starts a two-hour investigation. This probe reads the same
// signals harness/burst-dag.mjs and harness/churnprobe.mjs read, off the engine's
// onGraphMutation hook, and folds them into one fingerprint the mirror attaches to lite
// rows (free when the hook is absent -- ref engines simply don't get the column).
//
// Opcode vocabulary (this engine, from churnprobe.mjs + burst-dag.mjs):
//   1 node-create   2 node-dispose   3 link-add   4 link-sever   5 recompute   6 flush-pass
//
// Fingerprint:
//   recomputed      distinct nodes that recomputed in the measured interval
//   maxRecompute    the busiest single node's recompute count (redundancy tell)
//   churnPerRecompute (linkAdd+linkSever)/recomputes -- ~0 means cone-caching held
//                     (stable topology), high means dep-flip retracking every cycle
//   flushPasses     op-6 count -- extra passes are the classic propagation-cost regression
//   poolGrowths     from stats() -- a nonzero here means the pool was undersized
//
// Usage: wrap the measured drive with probe.measure(registry, () => drive()).

export function makeStructureProbe() {
    let measuring = false;
    let recomputes = 0, linkAdd = 0, linkSever = 0, flushPasses = 0;
    const perNode = new Map();   // nodeId -> recompute count (for maxRecompute)

    function onMutation(op, a) {
        if (!measuring) return;
        if (op === 5) { recomputes++; if (a != null) perNode.set(a, (perNode.get(a) ?? 0) + 1); }
        else if (op === 3) linkAdd++;
        else if (op === 4) linkSever++;
        else if (op === 6) flushPasses++;
    }

    return {
        // attach to a registry BEFORE the measured interval; returns an off() to detach
        attach(registry) {
            const off = registry.onGraphMutation(onMutation);
            return off;
        },
        start() { measuring = true; },
        stop() { measuring = false; },
        // fingerprint of the measured interval; pass the registry to fold in poolGrowths
        fingerprint(registry) {
            let maxRecompute = 0;
            for (const c of perNode.values()) if (c > maxRecompute) maxRecompute = c;
            const churn = linkAdd + linkSever;
            const poolGrowths = registry?.stats ? registry.stats().poolGrowths : null;
            return {
                recomputed: perNode.size,
                maxRecompute,
                flushPasses,
                churnPerRecompute: recomputes ? +(churn / recomputes).toFixed(4) : 0,
                poolGrowths,
            };
        },
        reset() { recomputes = 0; linkAdd = 0; linkSever = 0; flushPasses = 0; perNode.clear(); },
    };
}

// Render a fingerprint into the metrics column (compact, space-separated k=v).
export function fingerprintStr(fp) {
    if (!fp) return "";
    const parts = [
        `recomputed=${fp.recomputed}`,
        `maxRecompute=${fp.maxRecompute}`,
        `flushPasses=${fp.flushPasses}`,
        `churnPerRecompute=${fp.churnPerRecompute}`,
    ];
    if (fp.poolGrowths != null) parts.push(`poolGrowths=${fp.poolGrowths}`);
    return parts.join(" ");
}
