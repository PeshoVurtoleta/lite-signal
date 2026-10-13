/**
 * @zakkster/lite-signal soak -- the REPR child of the WRAP job (SPEC-B v2 section 5.2; SPEC-S2 group A TASK 6).
 *
 *   node --allow-natives-syntax --expose-gc bench/soak/wrap-repr.mjs     (spawned by wrap.mjs when SOAK_REPR=1)
 *
 * REPORT-ONLY (F18 evidence): NOTE output, never a verdict. One registry; a node built BEFORE any crossing
 * (`old`), then 2^31 + 2^20 signal() + dispose() cycles: the free list is LIFO, so ONE slot is recycled every
 * cycle and that drive crosses both nodeSeq and that slot's gen past 2^31. Then:
 *   sameMapPre   %HaveSameMap(old node, a fresh node) before the drive
 *   sameMapPost  %HaveSameMap(old node, the recycled node) after it: false when a field generalised
 *                (a float64 gen / id goes Double for every node of the shape: map deprecation)
 *   propNs / churnNs  best of 5 x 1e6 ns/op (1 signal -> 8 computeds -> 1 effect; create + read + dispose),
 *                pre, post and post/pre
 * %HaveSameMap is compiled through `new Function`, so this file parses without --allow-natives-syntax;
 * without the flag the child still runs and prints natives=false (the maps are then null, never guessed).
 *
 * The kernel comes from kernel.mjs (the SOAK_KERNEL seam the parent passed through the environment).
 * stdout: exactly one JSON line. COLD timing harness: hrtime reads sit outside the timed loops' bodies.
 */

import { K, KERNEL_FILES, KERNEL_KNOWN_AS } from './kernel.mjs';

const TWO31 = 2147483648;
const DRIVE_N = TWO31 + (1 << 20);
const CHUNK = 1 << 24;
const TIME_N = 1000000;
const TIME_ROUNDS = 5;
const DRIVE = new Float64Array(1);   // the drive total passes 2^31: never a closure let

let haveSameMap = null, nativesError = null;
try {
    haveSameMap = new Function('a', 'b', 'return %HaveSameMap(a, b);');
} catch (e) {
    nativesError = String(e && e.message ? e.message : e).slice(0, 160);
}

function nodeOf(h) {
    for (const k of Object.getOwnPropertySymbols(h)) {
        const v = h[k];
        if (v !== null && typeof v === 'object' && 'flags' in v) return v;
    }
    return undefined;
}
function sameMap(a, b) {
    if (haveSameMap === null || a === undefined || b === undefined) return null;
    return haveSameMap(a, b) === true;
}

const r = K.createRegistry({ maxNodes: 64 });
const signal = r.signal, dispose = r.dispose;
const S = new Int32Array(1);
const old = r.signal(0);
const src = r.signal(0);
const cs = [];
for (let i = 0; i < 8; i++) cs.push(r.computed(() => src() + i));
r.effect(() => { let s = 0; for (let i = 0; i < 8; i++) s = (s + cs[i]()) | 0; S[0] = s; });

function prop(n) { for (let i = 0; i < n; i++) src.set(i & 0xFFFF); }
function churn(n) { for (let i = 0; i < n; i++) { const s = signal(i & 0xFFFF); s(); dispose(s); } }
function best(fn) {
    let m = Infinity;
    for (let k = 0; k < TIME_ROUNDS; k++) {
        const t0 = process.hrtime.bigint();
        fn(TIME_N);
        const ns = Number(process.hrtime.bigint() - t0) / TIME_N;
        if (ns < m) m = ns;
    }
    return Math.round(m * 100) / 100;
}

for (let w = 0; w < 5; w++) { prop(200000); churn(200000); }
const propPre = best(prop), churnPre = best(churn);
const probe = r.signal(0);
const sameMapPre = sameMap(nodeOf(old), nodeOf(probe));
r.dispose(probe);

const t0 = performance.now();
DRIVE[0] = 0;
while (DRIVE[0] < DRIVE_N) {
    const rem = DRIVE_N - DRIVE[0];
    const n = (rem < CHUNK ? rem : CHUNK) | 0;
    for (let i = 0; i < n; i++) dispose(signal(0));
    DRIVE[0] += n;
}
const driveWallMs = Math.round((performance.now() - t0) * 10) / 10;

const fresh = r.signal(0);
const sameMapPost = sameMap(nodeOf(old), nodeOf(fresh));
r.dispose(fresh);
const propPost = best(prop), churnPost = best(churn);
const ratio = (a, b) => (a > 0 ? Math.round((b / a) * 1000) / 1000 : null);

r.destroy();
process.stdout.write(JSON.stringify({
    repr: true,
    natives: haveSameMap !== null, nativesError,
    kernel: { sha256: KERNEL_FILES[0].sha256, knownAs: KERNEL_KNOWN_AS },
    opsDriven: DRIVE[0], driveWallMs,
    sameMapPre, sameMapPost,
    propNs: { pre: propPre, post: propPost, ratio: ratio(propPre, propPost) },
    churnNs: { pre: churnPre, post: churnPost, ratio: ratio(churnPre, churnPost) },
    sink: S[0],
}) + '\n');
process.exit(0);
