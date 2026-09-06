import { createRegistry } from "../Signal.js";

function bench(makeRegistry, build, n, samples = 7) {
    // warmup
    for (let i = 0; i < 3; i++) {
        const r = makeRegistry();
        const ctx = build(r);
        for (let j = 0; j < Math.floor(n/100); j++) ctx.write(j);
        r.destroy();
    }
    globalThis.gc?.();
    const times = [];
    for (let i = 0; i < samples; i++) {
        const r = makeRegistry();
        const ctx = build(r);
        for (let j = 0; j < Math.floor(n/100); j++) ctx.write(j);  // warm
        globalThis.gc?.();
        const t0 = performance.now();
        for (let j = 0; j < n; j++) ctx.write(j);
        times.push(performance.now() - t0);
        r.destroy();
    }
    times.sort((a,b) => a-b);
    return times[Math.floor(times.length/2)];
}

const cfg = {maxNodes: 16384, maxLinks: 65536, prealloc: "lazy", onCapacityExceeded: "grow"};
const sab = {...cfg, flushStrategy: "sab"};

const shapes = [
    {name: "1to1   n=400k", n: 400000, build: r => {
        const s = r.signal(0); r.computed(() => s()); return {write: v => s.set(v)};
    }},
    {name: "1to2   n=400k", n: 400000, build: r => {
        const s = r.signal(0); r.computed(() => s() * 2); r.computed(() => s() * 3);
        return {write: v => s.set(v)};
    }},
    {name: "1to4   n=400k", n: 400000, build: r => {
        const s = r.signal(0);
        for (let i = 0; i < 4; i++) { const k=i; r.computed(() => s() * k); }
        return {write: v => s.set(v)};
    }},
    {name: "1to8   n=400k", n: 400000, build: r => {
        const s = r.signal(0);
        for (let i = 0; i < 8; i++) { const k=i; r.computed(() => s() * k); }
        return {write: v => s.set(v)};
    }},
    {name: "1to1000 n=4k", n: 4000, build: r => {
        const s = r.signal(0);
        for (let i = 0; i < 1000; i++) { const k=i; r.computed(() => s() + k); }
        return {write: v => s.set(v)};
    }},
    {name: "1000to1 n=1k", n: 1000, build: r => {
        const srcs = []; for (let i = 0; i < 1000; i++) srcs.push(r.signal(i));
        r.computed(() => { let sum=0; for (let i=0;i<1000;i++) sum+=srcs[i](); return sum; });
        return {write: v => srcs[v % 1000].set(v)};
    }},
];

console.log("Shape           |  eager   |   sab    | speedup | reflex (log) | alien (log)");
console.log("----------------|----------|----------|---------|--------------|------------");
const refs = {
    "1to1":   {reflex: 6.67, alien: 7.51},
    "1to2":   {reflex: 4.69, alien: 5.93},
    "1to4":   {reflex: 2.23, alien: 4.35},
    "1to1000":{reflex: 0.23, alien: 0.09},
    "1000to1":{reflex: 0.23, alien: 0.06},
};
for (const s of shapes) {
    const e = bench(() => createRegistry(cfg), s.build, s.n);
    const sb = bench(() => createRegistry(sab), s.build, s.n);
    const key = s.name.split(/\s+/)[0];
    const ref = refs[key] || {reflex:"-", alien:"-"};
    const refRx = typeof ref.reflex === "number" ? ref.reflex.toFixed(2) : ref.reflex;
    const refAl = typeof ref.alien === "number" ? ref.alien.toFixed(2) : ref.alien;
    console.log(
        s.name.padEnd(15) + " | " +
        e.toFixed(2).padStart(7) + "  | " +
        sb.toFixed(2).padStart(7) + "  | " +
        (e/sb).toFixed(2).padStart(5) + "x  | " +
        refRx.padStart(11) + "  | " + refAl.padStart(10)
    );
}
