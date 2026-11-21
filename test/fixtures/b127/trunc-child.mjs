// b127 A3 child. argv: engineFile N. ONE depth-1 frame (effect E) runs N depth-2 computeds c2; each c2 reads a and b, then runs a depth-3
// computed c3 that disposes a (a dep of the suspended depth-2 frame). Nothing else is disposed. The test stages a fixCursor counter
// (globalThis.__FX) into the engine copy. Prints the scan counters, the per-child trace and the final stats.
import { pathToFileURL } from "node:url";
const [file, Ns] = process.argv.slice(2); const N = +Ns;
globalThis.__FX = { calls: 0, iters: 0 };
const S = await import(pathToFileURL(file).href);
const r = S.createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16 });
const trace = [];
r.effect(() => {
    for (let i = 0; i < N; i++) {
        const a = r.signal(i), b = r.signal(2 * i);
        const c2 = r.computed(() => { const x = a() + b(); const c3 = r.computed(() => { r.dispose(a); return 7; }); const y = c3(); return x + y; });
        trace.push(c2());
    }
});
const st = r.stats();
process.stdout.write(JSON.stringify({ N, calls: globalThis.__FX.calls, iters: globalThis.__FX.iters, trace, activeNodes: st.activeNodes, activeLinks: st.activeLinks }) + "\n");
r.destroy();
