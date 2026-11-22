// b245 XA6 (PLAN-XA6 TASK 1) test/123 3b snapshot child. Run: node --expose-gc --single-threaded --max-old-space-size=512 snap3b-child.mjs <engineFile>
// The gc-child.mjs "destroy" shape verbatim (10,000 logged drop entries, destroy(), api held, gc), then a node:v8 heap snapshot taken at
// the point gc-child reads heapUsed; the snapshot is parsed here and the live objects named ReactiveLink / ReactiveNode are counted.
// Prints ONE JSON line { destroy, retained, ReactiveLink, ReactiveNode }. Fails closed: exit 3 without --single-threaded or --expose-gc
// (a background GC / compiler thread could hold objects across the snapshot), exit 4 on a snapshot parse / count failure (missing meta
// fields, or 0 ReactiveLink / ReactiveNode objects: the import-time pools always hold some, so 0 means the count did not run).
import { pathToFileURL } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { readFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
if (!process.execArgv.includes("--single-threaded") || typeof globalThis.gc !== "function") {
    process.stderr.write("snap3b-child: needs --single-threaded and --expose-gc (execArgv " + JSON.stringify(process.execArgv) + ")\n"); process.exit(3);
}
const S = await import(pathToFileURL(process.argv[2]).href);
const gc2 = () => { globalThis.gc(); globalThis.gc(); };
const K = 10000; const r0 = S.createRegistry({ maxNodes: 40000, maxLinks: 120000 }); gc2(); const h0 = process.memoryUsage().heapUsed;
const trig = r0.signal(0), t = r0.signal(0); const sg = []; for (let i = 0; i < K; i++) sg.push(r0.signal(i)); let on = false;
const C2 = r0.computed(() => { trig(); if (on) r0.dispose(C1); return 1; }); const C1 = r0.computed(() => { let v = trig() + C2(); for (let i = 0; i < K; i++) v += sg[i](); return v; });
r0.effect(() => { trig(); C1(); t(); }); on = true; r0.batch(() => { trig.set(1); });
gc2(); let res = "ok"; try { r0.destroy(); } catch (e) { res = e.name; }
globalThis.__sink = r0; gc2(); await new Promise((q) => setTimeout(q, 20)); gc2();
const retained = process.memoryUsage().heapUsed - h0;
const dir = mkdtempSync(join(tmpdir(), "snap3b-"));
const file = writeHeapSnapshot(join(dir, "s.heapsnapshot"));
let c = null;
try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const m = s.snapshot.meta, F = m.node_fields.length, iT = m.node_fields.indexOf("type"), iN = m.node_fields.indexOf("name");
    const OBJ = Array.isArray(m.node_types[0]) ? m.node_types[0].indexOf("object") : -1;
    if (!(F > 0) || iT < 0 || iN < 0 || OBJ < 0 || s.nodes.length % F !== 0) throw new Error("snapshot meta: fields " + F + " type " + iT + " name " + iN + " object " + OBJ);
    c = { ReactiveLink: 0, ReactiveNode: 0 };
    for (let i = 0; i < s.nodes.length; i += F) if (s.nodes[i + iT] === OBJ) { const n = s.strings[s.nodes[i + iN]]; if (n === "ReactiveLink") c.ReactiveLink++; else if (n === "ReactiveNode") c.ReactiveNode++; }
    if (c.ReactiveLink === 0 || c.ReactiveNode === 0) throw new Error("count: " + JSON.stringify(c));
} catch (e) {
    process.stderr.write("snap3b-child: snapshot parse / count failed: " + (e && e.message) + "\n"); c = null;
} finally { try { unlinkSync(file); rmdirSync(dir); } catch { /* best effort: the temp dir is in os.tmpdir() */ } }
if (c === null) process.exit(4);
process.stdout.write(JSON.stringify({ destroy: res, retained, ...c }) + "\n");
process.exit(0);
