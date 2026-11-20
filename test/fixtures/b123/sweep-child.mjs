// b123 --jitless real-overflow sweep child (ASSERTION 1). Env: B123_ENGINE (abs path), B123_LINES (json: lines of the cold-arm
// fixCursor call sites), B123_KMAX. Prints one JSON object {shape: [cell...]}. Every shape's armed write runs at recursion
// depth N - k (N = measured limit), so k spare frames remain when the write starts.
import { pathToFileURL, fileURLToPath } from "node:url";
const S = await import(pathToFileURL(process.env.B123_ENGINE).href);
const SH = await import(pathToFileURL(fileURLToPath(new URL("./shapes.mjs", import.meta.url))).href);
const LINES = new Set(JSON.parse(process.env.B123_LINES));
const KMAX = +process.env.B123_KMAX;
function at(n, f) { if (n === 0) return f(); return at(n - 1, f); }
function atp(n, f) { const a = n | 1, b = a + 2, c = b * 3; if (n === 0) return f(); const v = atp(n - 1, f); return (c & 0) === 0 ? v : 0; }
const noop = () => 0;
function limit(at) { let lo = 100, hi = 200000; while (lo < hi) { const mid = (lo + hi + 1) >> 1; let ok = true; try { at(mid, noop); } catch (e) { ok = false; } if (ok) lo = mid; else hi = mid - 1; } return lo; }
for (let i = 0; i < 3; i++) { limit(at); limit(atp); }
// B123_KWIN (optional, "a-b,c-d"): sweep only these k windows instead of 0..KMAX (rows then hold one cell per listed k, in order).
const KS = []; if (process.env.B123_KWIN) { for (const w of process.env.B123_KWIN.split(",")) { const [a, b] = w.split("-").map(Number); for (let k = a; k <= b; k++) KS.push(k); } } else for (let k = 0; k <= KMAX; k++) KS.push(k);
// Build-independent frame name: the function name printed by V8 ("at fn (file:l:c)", "at new C", "at Object.fn"); "<anon>" when V8 prints no name.
const frameFn = (ln) => { const m = /^\s*at (?:async )?(?:new )?(.*?)(?: \(.*)?$/.exec(ln); const n = m ? m[1] : ""; return n === "" || /^(file|node):|^\/|:\d+:\d+$/.test(n) ? "<anon>" : n.replace(/^(?:Object|Array|Function)\./, ""); };
const topSite = (e, n) => String(e && e.stack).split("\n").slice(1, 1 + n).map(frameFn).join("<-");   // "thrower<-caller"
const topLine = (e) => { const ln = String(e && e.stack).split("\n")[1] || ""; const m = /:(\d+):\d+\)?\s*$/.exec(ln); return m ? +m[1] : -1; };
const out = {};
for (const [rn, rec] of [["at", at], ["atp", atp]]) for (const shape of ["R", "E", "S", "Rd", "R+", "E+", "S+"]) {
    const rows = [];
    for (const k of KS) {
        const N = limit(rec); let cur = 0, ranges = 0, other = []; const errs = [];
        const P = SH.makeShapes(S, {
            go: (f) => rec(N - k, f), prelog: shape.endsWith("+"),
            // cap runs INSIDE the overflow zone: for a RangeError it only counts and keeps the error object (the other branch builds a short string; pre-existing) (its stack is read after the cell, at shallow depth;
            // formatting a stack or running a regex here would itself overflow and corrupt the measurement).
            cap: (e) => { if (e.constructor === RangeError) { ranges++; errs.push(e); } else other.push(e.constructor.name + ":" + String(e.message).slice(0, 40)); },
        });
        let o = null, err = null;
        try { o = P[shape.replace("+", "")](); } catch (e) { err = e.constructor.name + ":" + String(e.message).slice(0, 40); }
        for (const e of errs) if (LINES.has(topLine(e))) cur++;
        rows.push({ k, ranges, cur, other, err, o, sites: errs.map((e) => topSite(e, 2)) });
    }
    out[rn + ":" + shape] = rows;
}
process.stdout.write(JSON.stringify(out));
