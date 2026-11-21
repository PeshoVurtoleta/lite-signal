// b127 A4 child (run with --expose-gc --max-old-space-size=2048). argv: engineFile mode(ref|flush).
// Neon probe-d1-d2.mjs PROBE 5: build a tiny registry (maxNodes 4), an effect on one signal; flush: one s.set(1) (a flushEffects pass);
// stop the effect, destroy(), keep ONLY the registry referenced, gc, then count 'ReactiveNode' instances in a heap snapshot.
// shape: see build(). ref = the same without the s.set(1) (no flush), so (flush - ref) isolates what the flush leaves behind.
import v8 from "node:v8";
import { pathToFileURL } from "node:url";
const [file, mode, shape = "stop"] = process.argv.slice(2);
const S = await import(pathToFileURL(file).href);
function build() {
    const reg = S.createRegistry({ maxNodes: 4, maxLinks: 4 });
    const s = reg.signal(0); let runs = 0;
    // shapes: stop = stop() before destroy; live = effect left alive; throw = last entry throws out of the flush; self = last entry disposes itself
    let stop; const on = () => mode === "flush" && runs > 1;
    if (shape === "throw") stop = reg.effect(() => { s(); runs++; if (on()) throw new Error("x"); });
    else if (shape === "self") stop = reg.effect(() => { s(); runs++; if (on()) stop(); });
    else stop = reg.effect(() => { s(); runs++; });
    if (mode === "flush") { try { s.set(1); } catch (e) { /* throw shape */ } }
    if (shape === "stop") stop();
    reg.destroy();
    return { reg, runs };
}
globalThis.__keep = build();
globalThis.gc(); globalThis.gc();
const chunks = []; for await (const ch of v8.getHeapSnapshot()) chunks.push(ch);
const snap = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const f = snap.snapshot.meta.node_fields, stride = f.length, ni = f.indexOf("name"), strings = snap.strings, nodes = snap.nodes;
let count = 0; for (let i = 0; i < nodes.length; i += stride) if (strings[nodes[i + ni]] === "ReactiveNode") count++;
process.stdout.write(JSON.stringify({ mode, count, runs: globalThis.__keep.runs }) + "\n");
