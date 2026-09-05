// Churn-per-recompute measurement: the gating datum for the 1.11 mark-cone
// cache spike. Cone caching is valid only where steady-state topology churn
// is ~zero; this measures it on the three canonical shapes + burst-dag DAG.
//
// Link churn is read off onGraphMutation, NOT stats(). This engine's stats()
// exposes only NODE lifecycle counters (totalAllocations/totalDisposals bump on
// createNode/disposeNode) plus a live activeLinks gauge -- there is no cumulative
// LINK counter, and a net activeLinks delta would hide equal-and-opposite
// sever+add retracking, which is exactly the dep-flip shape this probe must
// catch. The hook gives gross counts directly. Opcode vocabulary (this engine):
//   1 node-create   2 node-dispose   3 link-add (allocateLink)
//   4 link-sever (freeLink)   5 recompute
// A stable topology reads linkAlloc == linkDisp == 0 in the measured interval
// (churn/recompute ~0 -> cone-caching valid); dep-flip reads high (-> invalid).
import {pathToFileURL} from "node:url";

const E = await import(pathToFileURL(process.argv[2]).href);

function measure(name, build, drive, iters) {
    const r = E.createRegistry({maxNodes: 16384, maxLinks: 131072, prealloc: "lazy", onCapacityExceeded: "grow"});
    let recomputes = 0, linkAlloc = 0, linkDisp = 0, measuring = false;
    r.onGraphMutation((op) => {
        if (!measuring) return;          // ignore build + warm-up mutations
        if (op === 5) recomputes++;
        else if (op === 3) linkAlloc++;
        else if (op === 4) linkDisp++;
    });
    const h = build(r);
    for (let i = 0; i < 200; i++) drive(r, h, i);          // reach steady state
    measuring = true;
    for (let i = 0; i < iters; i++) drive(r, h, 200 + i);  // measured interval
    measuring = false;
    const churn = linkAlloc + linkDisp;
    console.log(`${name.padEnd(22)} recomputes=${String(recomputes).padStart(7)}  linkAlloc=${String(linkAlloc).padStart(6)}  linkDisp=${String(linkDisp).padStart(6)}  churn/recompute=${recomputes ? (churn / recomputes).toFixed(4) : "n/a"}`);
    r.destroy();
}

// stable broadcast: 1 signal -> 400 computeds -> 400 effects
measure("broadcast-stable", (r) => {
    const src = r.signal(0);
    const sinks = [];
    for (let i = 0; i < 400; i++) {
        const c = r.computed(() => src() + i);
        r.effect(() => {
            c();
        });
    }
    return src;
}, (r, src, i) => src.set(i), 2000);

// stable deep chain: 400-deep computed chain + 1 effect
measure("chain-stable", (r) => {
    const root = r.signal(0);
    let prev = root;
    for (let i = 0; i < 400; i++) {
        const p = prev;
        prev = r.computed(() => p() + 1);
    }
    r.effect(() => {
        prev();
    });
    return root;
}, (r, root, i) => root.set(i), 2000);

// dynamic dep churn: effects flip between dep sets every write
measure("dep-flip-churn", (r) => {
    const flag = r.signal(true);
    const a = r.signal(0);
    const b = r.signal(0);
    for (let i = 0; i < 200; i++) r.effect(() => {
        flag() ? a() : b();
    });
    return flag;
}, (r, flag, i) => flag.set(i % 2 === 0), 2000);

// burst-dag-like diamond lattice, stable topology
measure("diamond-dag-stable", (r) => {
    const roots = [];
    for (let i = 0; i < 16; i++) roots.push(r.signal(i));
    let layer = roots.map(s => r.computed(() => s()));
    for (let d = 0; d < 6; d++) {
        const next = [];
        for (let i = 0; i < layer.length; i++) {
            const x = layer[i], y = layer[(i + 1) % layer.length];
            next.push(r.computed(() => x() + y()));
        }
        layer = next;
    }
    for (const c of layer) r.effect(() => {
        c();
    });
    return roots;
}, (r, roots, i) => r.batch(() => {
    roots[i % 16].set(i);
    roots[(i + 7) % 16].set(i * 2);
}), 2000);
