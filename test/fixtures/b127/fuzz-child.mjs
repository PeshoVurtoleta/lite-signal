// b127 A1 child (copy of test/fixtures/b123/fuzz-child.mjs + shadow-log hooks, hits / adds in the JSON). argv: fileA fileB programs seed policy maxNodes maxLinks
// (nested computed reads, untrack, createRoot, runWithOwner, observeObservers hooks), run on build A and build B in
// ONE process (two module instances), full trace compared op by op. argv: dirA dirB programs seed [policy]
// Trace per op: effect runs (id + sum read), thrown error text, stats activeLinks / activeNodes, top-level peeks.
// b123 child (derived from audit opus fuzz-nested.mjs + B0 counted copy). argv: fileA fileB programs seed policy maxNodes maxLinks
// b127 A1 shadow hooks: a staged engine copy calls these; the un-planted engine never does. __SHadd records one
// side-log entry (link, replacement, depth); __SHchk mirrors fixCursor's match (entry depth > k and entry link === c)
// WITHOUT rewriting c, counts a hit, and lowers the entry; k === 0 (a depth-0 restore) clears the side log like the real log.
globalThis.__SH = { log: [], hits: 0, adds: 0 };
globalThis.__SHadd = (l, nd, d) => { const S = globalThis.__SH; S.log.push(l, nd, d); S.adds++; };
globalThis.__SHchk = (c, k) => { const S = globalThis.__SH; if (k === 0) { S.log.length = 0; return c; } for (let i = 0; i < S.log.length; i += 3) { if (S.log[i + 2] > k) { if (c !== null && S.log[i] === c) S.hits++; S.log[i + 2] = k; } } return c; };
// Prints one JSON line. Each build is a separate module instance (distinct files).
import { pathToFileURL } from 'node:url';
const [fileA, fileB, NP = '300', SEED = '12345', POLICY = 'grow', MAXN = '64', MAXL = '256'] = process.argv.slice(2);
const A = await import(pathToFileURL(fileA).href), B = await import(pathToFileURL(fileB).href);
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function h(a, b) { let x = (a * 2654435761 + b * 40503 + 7) >>> 0; x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995) >>> 0; x ^= x >>> 15; return x; }
function genProgram(R) {
  const NS = 4 + (R() * 6 | 0), NC = 3 + (R() * 7 | 0), NE = 2 + (R() * 4 | 0);
  const comps = [], effs = [];
  for (let i = 0; i < NC; i++) { const deps = []; const k = 1 + (R() * 4 | 0); for (let j = 0; j < k; j++) deps.push(R() < 0.6 || i === 0 ? ['s', R() * NS | 0] : ['c', R() * i | 0]); comps.push({ deps, act: R() < 0.5 ? (R() * 6 | 0) : -1, actAt: R() * deps.length | 0, tgt: R() < 0.5 ? ['s', R() * NS | 0] : ['c', R() * NC | 0] }); }
  for (let i = 0; i < NE; i++) { const deps = []; const k = 2 + (R() * 5 | 0); for (let j = 0; j < k; j++) deps.push(R() < 0.5 ? ['s', R() * NS | 0] : ['c', R() * NC | 0]); effs.push({ deps, act: R() < 0.4 ? (R() * 6 | 0) : -1, actAt: R() * deps.length | 0, tgt: R() < 0.5 ? ['s', R() * NS | 0] : ['c', R() * NC | 0], hook: R() < 0.3 }); }
  const ops = []; const NO = 20 + (R() * 30 | 0);
  for (let i = 0; i < NO; i++) { const r = R(); if (r < 0.6) ops.push(['set', R() * NS | 0, R() * 5 | 0]); else if (r < 0.75) ops.push(['batch', R() * NS | 0, R() * 5 | 0, R() * NS | 0, R() * 5 | 0]); else if (r < 0.88) ops.push(['read', R() * NC | 0]); else ops.push(['dispose', R() < 0.5 ? 's' : 'c', R() < 0.5 ? (R() * NS | 0) : (R() * NC | 0)]); }
  return { NS, NC, NE, comps, effs, ops };
}
const EVS = [{ catches: 0, distinct: 0, growths: 0 }, { catches: 0, distinct: 0, growths: 0 }], SEEN = new WeakSet();
function run(E, P) {
  const ev = EVS[E === A ? 0 : 1];
  const r = E.createRegistry({ maxNodes: +MAXN, maxLinks: +MAXL, onCapacityExceeded: POLICY });
  const tr = [];
  const S = [], C = [], EH = [], runs = new Array(P.comps.length + P.effs.length).fill(0);
  const get = (t) => (t[0] === 's' ? S[t[1] % S.length] : C[t[1] % C.length]);
  const safe = (f) => { try { return f(); } catch (e) { if (e && e.name === 'CapacityError') { ev.catches++; if (!SEEN.has(e)) { SEEN.add(e); ev.distinct++; } } return 'E:' + String(e && e.message).slice(0, 40); } };
  function act(code, tgt, id) {
    const x = get(tgt); if (!x) return;
    switch (code) {
      case 0: r.dispose(x); break;
      case 1: r.untrack(() => r.dispose(x)); break;
      case 2: r.createRoot(() => r.dispose(x)); break;
      case 3: { const own = r.getOwner(); r.runWithOwner(own, () => r.dispose(x)); break; }
      case 4: { const t = r.computed(() => { const v = typeof x === 'function' ? x() : 0; r.dispose(x); return v; }); t(); r.dispose(t); break; }
      case 5: r.untrack(() => { const t = r.computed(() => { r.dispose(x); return 1; }); t(); }); break;
    }
  }
  for (let i = 0; i < P.NS; i++) S.push(r.signal(i));
  for (let i = 0; i < P.comps.length; i++) {
    const c = P.comps[i], id = i;
    C.push(r.computed(() => { runs[id]++; let s = 0; for (let j = 0; j < c.deps.length; j++) { if (c.act >= 0 && j === c.actAt && (h(id, runs[id]) & 3) === 0) act(c.act, c.tgt, id); const d = get(c.deps[j]); const v = safe(() => d()); s += typeof v === 'number' ? v : 0; } return s; }));
  }
  for (let i = 0; i < P.effs.length; i++) {
    const e = P.effs[i], id = P.comps.length + i;
    if (e.hook) { const t = get(e.deps[0]); if (t) safe(() => r.observeObservers(t, { onConnect: () => { if ((h(id, runs[id]) & 7) === 0) act(0, e.tgt, id); } })); }
    EH.push(safe(() => r.effect(() => { runs[id]++; let s = 0; for (let j = 0; j < e.deps.length; j++) { if (e.act >= 0 && j === e.actAt && (h(id, runs[id]) & 1) === 0) act(e.act, e.tgt, id); const d = get(e.deps[j]); const v = safe(() => d()); s += typeof v === 'number' ? v : 0; } tr.push('e' + id + ':' + s); })));
  }
  for (const op of P.ops) {
    let res;
    if (op[0] === 'set') res = safe(() => { S[op[1]].set(op[2]); });
    else if (op[0] === 'batch') res = safe(() => r.batch(() => { S[op[1]].set(op[2]); S[op[3]].set(op[4]); }));
    else if (op[0] === 'read') res = safe(() => C[op[1]]());
    else res = safe(() => r.dispose(op[1] === 's' ? S[op[2] % S.length] : C[op[2] % C.length]));
    const st = r.stats();
    tr.push(op[0] + '>' + (typeof res === 'string' ? res : String(res)) + '|L' + st.activeLinks + 'N' + st.activeNodes + '|' + C.map((c) => { const v = safe(() => c.peek()); return v === undefined ? 'u' : v; }).join(',') + '|' + C.concat(EH).map((hh) => { const a = []; safe(() => r.forEachSource(hh, (x) => { a.push(x.id); })); return a.join('.'); }).join(','));
  }
  ev.growths += r.stats().poolGrowths;
  return tr;
}
const R = rng(+SEED);
let diffs = 0, ops = 0, firstDiff = null;
for (let p = 0; p < +NP; p++) {
  const P = genProgram(R);
  globalThis.__SH.log.length = 0; const ta = run(A, P), tb = run(B, P);
  ops += ta.length;
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i++) if (ta[i] !== tb[i]) { diffs++; if (!firstDiff) firstDiff = { p, i, a: ta[i], b: tb[i] }; break; }
}
console.log(JSON.stringify({ programs: +NP, seed: +SEED, policy: POLICY, traceLines: ops, diffs, first: firstDiff, hits: globalThis.__SH.hits, adds: globalThis.__SH.adds, A: EVS[0], B: EVS[1] }));
