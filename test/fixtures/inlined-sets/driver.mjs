// driver.mjs <workload> [iters] (imports ./Signal.js beside it; test/122 stages it; body = audit/2026-11-19-hotpath-fable/work/driver2.mjs verbatim) -- UNTIMED inlining-budget probes (no clock is read).
const [, , wl, itArg] = process.argv;
const E = await import("./Signal.js");
const N = +(itArg || 200000);
let chk = 0;
function setLoop() {            // one unbatched set site, no subscribers: read.set + markDownstream + flushEffects
    const s = E.signal(0);
    function hotSet(n) { for (let i = 0; i < n; i++) s.set(i); }
    for (let k = 0; k < 20; k++) hotSet(N);
    chk += s.peek();
}
function setTwo() {             // two set sites in one function
    const a = E.signal(0), b = E.signal(0);
    function hotSet2(n) { for (let i = 0; i < n; i++) { a.set(i); b.set(-i); } }
    for (let k = 0; k < 20; k++) hotSet2(N);
    chk += a.peek() + b.peek();
}
function reads6() {             // one function with six computed read sites (each a distinct computed)
    const s = E.signal(0);
    const c1 = E.computed(() => s() + 1), c2 = E.computed(() => s() + 2), c3 = E.computed(() => s() + 3);
    const c4 = E.computed(() => s() + 4), c5 = E.computed(() => s() + 5), c6 = E.computed(() => s() + 6);
    function hotReads6(n) { let t = 0; for (let i = 0; i < n; i++) { t += c1(); t += c2(); t += c3(); t += c4(); t += c5(); t += c6(); } return t; }
    for (let k = 0; k < 20; k++) { s.set(k); chk += hotReads6(N); }
}
function sigReads10() {         // one function with ten signal read sites
    const ss = []; for (let i = 0; i < 10; i++) ss.push(E.signal(i));
    const [a, b, c, d, e, f, g, h, i2, j] = ss;
    function hotSig10(n) { let t = 0; for (let i = 0; i < n; i++) { t += a(); t += b(); t += c(); t += d(); t += e(); t += f(); t += g(); t += h(); t += i2(); t += j(); } return t; }
    for (let k = 0; k < 20; k++) chk += hotSig10(N);
}
({ setLoop, setTwo, reads6, sigReads10 })[wl]();
console.log("DRIVER2-CHK " + wl + " " + chk);
