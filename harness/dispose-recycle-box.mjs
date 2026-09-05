// dispose-recycle: callable signal() vs signalBox() vs alien-signals.
// Isolates the per-primitive creation cost that signalBox is designed to cut.
const N = 100_000, WARMUP = 3, RUNS = 10;

const adapters = {
  "lite-callable": async () => {
    const { createRegistry } = await import("../Signal.js");
    let r;
    return { fresh(){ r = createRegistry({ maxNodes: N+1000, maxLinks: N*2, prealloc:"eager", onCapacityExceeded:"grow" }); },
             create:(i)=>r.signal(i), dispose:(h)=>r.dispose(h) };
  },
  "lite-box": async () => {
    const { createRegistry } = await import("../Signal.js");
    let r;
    return { fresh(){ r = createRegistry({ maxNodes: N+1000, maxLinks: N*2, prealloc:"eager", onCapacityExceeded:"grow" }); },
             create:(i)=>r.signalBox(i), dispose:(h)=>r.dispose(h) };
  },
  "alien-signals": async () => {
    const m = await import("alien-signals");
    const signal = m.signal || (m.default && m.default.signal);
    return { fresh(){}, create:(i)=>signal(i), dispose:()=>{} };
  },
};

function once(a) {
  a.fresh();
  const h = new Array(N);
  const t0 = performance.now();
  for (let i=0;i<N;i++) h[i] = a.create(i);
  const t1 = performance.now();
  for (let i=0;i<N;i++) a.dispose(h[i]);
  const t2 = performance.now();
  for (let i=0;i<N;i++) h[i] = a.create(i);
  const t3 = performance.now();
  let acc=0; for (let i=0;i<N;i+=4096) acc += (h[i]?1:0);
  if (acc<0) console.log(acc);
  return { creation:t1-t0, dispose:t2-t1, recreate:t3-t2, total:t3-t0 };
}

const sel = (process.env.FW||"lite-callable,lite-box,alien-signals").split(",");
const res = {};
for (const fw of sel) {
  let a; try { a = await adapters[fw](); } catch(e){ console.log(`skip ${fw}: ${e.message}`); continue; }
  for (let i=0;i<WARMUP;i++) once(a);
  if (global.gc) global.gc();
  const runs=[];
  for (let i=0;i<RUNS;i++){ runs.push(once(a)); if(global.gc) global.gc(); }
  runs.sort((x,y)=>x.total-y.total);
  res[fw] = runs[Math.floor(runs.length/2)];
}
console.log(`dispose-recycle  N=${N.toLocaleString()}  median of ${RUNS}\n`);
const cols=["creation","dispose","recreate","total"];
console.log("framework".padEnd(16)+cols.map(c=>c.padStart(11)).join(""));
console.log("-".repeat(16+11*4));
for (const fw of sel) { const m=res[fw]; if(!m) continue;
  console.log(fw.padEnd(16)+cols.map(c=>(m[c].toFixed(1)+"ms").padStart(11)).join("")); }
if (res["lite-callable"] && res["lite-box"]) {
  const c=res["lite-callable"], b=res["lite-box"];
  console.log(`\nbox vs callable creation: ${b.creation.toFixed(1)}ms vs ${c.creation.toFixed(1)}ms (${((1-b.creation/c.creation)*100).toFixed(0)}% faster)`);
  console.log(`box vs callable recreate: ${b.recreate.toFixed(1)}ms vs ${c.recreate.toFixed(1)}ms (${((1-b.recreate/c.recreate)*100).toFixed(0)}% faster)`);
}
if (res["lite-box"] && res["alien-signals"]) {
  const b=res["lite-box"], al=res["alien-signals"];
  console.log(`box vs alien creation:    ${b.creation.toFixed(1)}ms vs ${al.creation.toFixed(1)}ms (${(b.creation/al.creation).toFixed(1)}x)`);
}
