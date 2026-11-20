// instr.mjs -- b230 U3 B2 (F-b224-1 ALL3x): instrumented-engine builders (O1 / O1c / R1a / O1f), firing controls, and the
// B2 probe drivers (haz1 / firstrun / nestflush / unwind / armreset / locals / L21B). Test-only; never touches Signal.js.
// The builders instr / instrC / addR1aCtr / instrF below are VERBATIM slices of the research builders
// (.handoff/research/pinned-slots/{scope/mkbuilds-scope,r1c/mkbuilds-r1c,r1d/R1/mkbuilds-R1,r1d/R0/mkbuilds-R0}.mjs), applied to the
// engine text through the count-checked rep() with the b229 U2 comment REMAP (instr/mkinstr-b228.mjs): a count != want THROWS, so
// a row against an engine whose anchors moved (the before build b5289277 has none of the new unpin sites) FAILS by anchor miss.
// Instrumented copies are strip-equal to U2's coded-I / -Ic / -If (b229 strip-cmp; .handoff/b230/u3b2/strip-check.txt).
// Controls (CTLIMM, CTLEARLY, CTLEIMM, CTLSRUN, CTLSNEST) are re-derived onto the CODED text; each plant bumps
// globalThis.__B230I.hit.<NAME> when it executes (a plant with no reach counter is void).
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

globalThis.__B230I = { hit: {} };
export const ihits = () => ({ ...globalThis.__B230I.hit });
const ARMS = ["rerunCleanupEffect", "rerunCleanupComputed", "firstRunCleanupE", "firstRunCleanupC"];
const REMAP = [
  ["        scopePinHead = null;   // b226 S\n", "        scopePinHead = null;   // SG2: scope pins likewise; armDepth is not zeroed here (R1bNZ)\n"],
  ["        while ((child = node.firstOwned) !== null) {\n", "        while (node.gen === g && (child = node.firstOwned) !== null) {   // F-b224-1: stop once a child's cleanup disposed this node\n"],
  ["node.flags &= ~FLAG_QUEUED;   // stranded QUEUED (no call: holds at the stack limit)\n", "node.flags &= ~FLAG_QUEUED;   // stranded QUEUED, only on the entry's own node (R0c); no call: holds at the stack limit\n"],
  ["   // stranded QUEUED (no call: holds at the stack limit)\n", "   // stranded QUEUED, only on the entry's own node (R0c); no call: holds at the stack limit\n"],
  ["        while (node.gen === g && (child = node.firstOwned) !== null) {   // b227 R1a\n", "        while (node.gen === g && (child = node.firstOwned) !== null) {   // F-b224-1: stop once a child's cleanup disposed this node\n"],
];
function rep(s, a, b, want = 1) {
  let n = s.split(a).length - 1;
  if (n !== want) {
    let a2 = a, b2 = b;
    for (const [o, w] of REMAP) { if (a2.includes(o)) { a2 = a2.split(o).join(w); b2 = b2.split(o).join(w); } else if (o.startsWith("   //") && b2.includes(o)) b2 = b2.split(o).join(w); }
    const n2 = s.split(a2).length - 1;
    if (a2 !== a && n2 === want) { a = a2; b = b2; n = n2; }
  }
  if (n !== want) throw new Error("instr: match count " + n + " (want " + want + ") for: " + a.slice(0, 90));
  return want === 0 ? s : s.split(a).join(b);
}
// ---- verbatim research builders ----
function instr(src, tag, kind) {   // kind: "base" (HEAD, HEAD2), "d2", "s" (S and controls / ALL)
  let s = src;
  const isS = kind === "s";
  s = rep(s, "export class CapacityError extends Error {\n",
    "const __ps = ((globalThis.__PS || (globalThis.__PS = {}))[" + JSON.stringify(tag) + "] = { pins: 0, spins: 0, unpins: 0, moves: 0, scalls: 0, sunpins: 0, ctlRun: 0, releases: 0, released: 0, sspliced: 0, missDeep: 0, missTop: 0, hw: 0, shw: 0, ce: 0, viol: 0, violSites: {}, handouts: 0, fsMax: 0 });\nexport class CapacityError extends Error {\n");
  s = rep(s, "        if (policy === \"throw\" && nodePool.length >= currentNodesCapacity) throw new CapacityError(\"nodes\", currentNodesCapacity);\n", "        if (policy === \"throw\" && nodePool.length >= currentNodesCapacity) { __ps.ce++; throw new CapacityError(\"nodes\", currentNodesCapacity); }\n");
  s = rep(s, "    let pinnedHead = null;\n", "    let pinnedHead = null;\n    let __pinLen = 0, __spLen = 0; const __fs = []; let __fsN = 0;\n");
  s = rep(s, "        for (let i = 0; i < scopeDepth; i++) if (scopeOwners[i] === node) return true;\n        return false;\n    }\n",
    "        for (let i = 0; i < scopeDepth; i++) if (scopeOwners[i] === node) return true;\n        return false;\n    }\n" +
    "    function __chk(n, site) {\n        __ps.handouts++;\n        let k = null;\n        for (let i = 0; i < __fsN; i++) if (__fs[i] === n) { k = 'fs'; break; }\n" +
    "        if (k === null && n === currentObserver) k = 'obs';\n        if (k === null && n === currentOwner) k = 'own';\n" +
    "        if (k === null) for (let i = 0; i < scopeDepth; i++) if (scopeOwners[i] === n) { k = 'scope'; break; }\n" +
    "        if (k !== null) { __ps.viol++; const key = site + ':' + k + ':d' + cursorDepth; __ps.violSites[key] = (__ps.violSites[key] || 0) + 1; }\n    }\n" +
    "    function __hw() { if (__pinLen + __spLen > __ps.hw) __ps.hw = __pinLen + __spLen; if (__spLen > __ps.shw) __ps.shw = __spLen; }\n");
  if (isS) {
    s = rep(s, "            pinnedHead = node;\n        } else if (", "            pinnedHead = node;\n            __ps.pins++; __pinLen++; __hw();\n        } else if (");
    s = rep(s, "            scopePinHead = node;\n        } else {\n", "            scopePinHead = node;\n            __ps.pins++; __ps.spins++; __spLen++; __hw();\n        } else {\n");
    s = rep(s, "{ n.nextFree = scopePinHead; scopePinHead = n; return; }", "{ n.nextFree = scopePinHead; scopePinHead = n; __ps.moves++; __spLen++; __hw(); return; }", (tag.startsWith("CTLSNOREF") || tag.startsWith("ALLNOREF")) ? 0 : 1);
    s = rep(s, "    function unpinScope(node) {\n", "    function unpinScope(node) {\n        __ps.scalls++;\n");
    s = rep(s, "        if (p === null) scopePinHead = n.nextFree; else p.nextFree = n.nextFree;\n", "        if (p === null) scopePinHead = n.nextFree; else p.nextFree = n.nextFree;\n        __ps.sunpins++; __spLen--;\n");
    s = rep(s, "            if (q === null) pinnedHead = m.nextFree; else q.nextFree = m.nextFree;\n", "            if (q === null) pinnedHead = m.nextFree; else q.nextFree = m.nextFree;\n            __ps.ctlRun++; __pinLen--;\n", tag.startsWith("CTLSRUN") ? 1 : 0);
    s = rep(s, "        n = scopePinHead;\n        scopePinHead = null;\n", "        n = scopePinHead;\n        scopePinHead = null;\n        __ps.sspliced += __spLen; __spLen = 0;\n");
    s = rep(s, "        scopePinHead = null;   // b226 S\n", "        scopePinHead = null;   // b226 S\n        __spLen = 0;\n");
  } else {
    s = rep(s, "            pinnedHead = node;\n        } else {\n",
      "            pinnedHead = node;\n            __ps.pins++; if ((f & FLAG_COMPUTING) === 0) __ps.spins++; __pinLen++; __hw();\n        } else {\n");
  }
  s = rep(s, "            node = freeNodeHead;\n            freeNodeHead = node.nextFree;\n            node.nextFree = null;\n        }\n        activeNodes = (activeNodes + 1) | 0;\n",
    "            node = freeNodeHead;\n            freeNodeHead = node.nextFree;\n            node.nextFree = null;\n            __chk(node, 'pop');\n        }\n        activeNodes = (activeNodes + 1) | 0;\n");
  s = rep(s, "    function nodeMiss() {\n        let node;\n", "    function nodeMiss() {\n        let node;\n        if (cursorDepth > 0) __ps.missDeep++; else __ps.missTop++;\n");
  s = rep(s, "            node.nextFree = null;\n            return node;\n        }\n        if (policy === \"throw\"",
    "            node.nextFree = null;\n            __chk(node, 'missRel');\n            return node;\n        }\n        if (policy === \"throw\"");
  s = rep(s, "            statPoolGrowths++;   // 1.4: capacity ledger crossed\n        }\n        return node;\n    }\n",
    "            statPoolGrowths++;   // 1.4: capacity ledger crossed\n        }\n        __chk(node, 'missGrow');\n        return node;\n    }\n");
  s = rep(s, "        let n = pinnedHead;\n        pinnedHead = null;\n", "        let n = pinnedHead;\n        pinnedHead = null;\n        if (n !== null) { __ps.releases++; __ps.released += __pinLen; } __pinLen = 0;\n");
  s = rep(s, "        pinnedHead = null;   // A1.8: pinned slots are released with the rest of the pool\n", "        pinnedHead = null;   // A1.8: pinned slots are released with the rest of the pool\n        __pinLen = 0;\n");
  s = rep(s, "        if (p === null) pinnedHead = n.nextFree; else p.nextFree = n.nextFree;\n",
    "        if (p === null) pinnedHead = n.nextFree; else p.nextFree = n.nextFree;\n        __ps.unpins++; __pinLen--;\n", kind === "base" ? 0 : 1);
  s = rep(s, "        cursorDepth = d + 1;   // Smi, as in the frames\n", "        cursorDepth = d + 1;   // Smi, as in the frames\n        __fs[__fsN++] = node; if (__fsN > __ps.fsMax) __ps.fsMax = __fsN;\n");
  s = rep(s, "\n        cursorDepth = d + 1;   // Smi: depth is bounded by the JS stack, far below 2^30\n", "\n        cursorDepth = d + 1;   // Smi: depth is bounded by the JS stack, far below 2^30\n        __fs[__fsN++] = node; if (__fsN > __ps.fsMax) __ps.fsMax = __fsN;\n");
  s = rep(s, "\n            cursorDepth = d + 1;   // Smi: depth is bounded by the JS stack, far below 2^30\n", "\n            cursorDepth = d + 1;   // Smi: depth is bounded by the JS stack, far below 2^30\n            __fs[__fsN++] = node; if (__fsN > __ps.fsMax) __ps.fsMax = __fsN;\n");
  s = rep(s, "        } finally {\n            if (node.gen === g) node.flags &= ~FLAG_COMPUTING;\n", "        } finally {\n            __fs[--__fsN] = null;\n            if (node.gen === g) node.flags &= ~FLAG_COMPUTING;\n");
  s = rep(s, "        } finally {\n            if (node.gen === savedGen) {\n                // S9: stamp BEFORE the sever.", "        } finally {\n            __fs[--__fsN] = null;\n            if (node.gen === savedGen) {\n                // S9: stamp BEFORE the sever.");
  s = rep(s, "            } finally {\n                if (node.gen === savedGen) {\n                    node.evalVersion = globalVersion;   // S9", "            } finally {\n                __fs[--__fsN] = null;\n                if (node.gen === savedGen) {\n                    node.evalVersion = globalVersion;   // S9");
  return s;
}

function instrC(s) {
  s = rep(s, "violSites: {}, handouts: 0, fsMax: 0 }", "violSites: {}, handouts: 0, fsMax: 0, violC: 0, violCSites: {}, armE: {}, armMv: {}, csMax: 0 }");
  s = rep(s, "    let __pinLen = 0; const __fs = []; let __fsN = 0;\n", "    let __pinLen = 0; const __fs = []; let __fsN = 0;\n    const __cs = [], __csA = []; let __csN = 0;\n");
  s = rep(s, "        if (k !== null) { __ps.viol++; const key = site + ':' + k + ':d' + cursorDepth; __ps.violSites[key] = (__ps.violSites[key] || 0) + 1; }\n",
    "        if (k !== null) { __ps.viol++; const key = site + ':' + k + ':d' + cursorDepth; __ps.violSites[key] = (__ps.violSites[key] || 0) + 1; }\n" +
    "        for (let i = 0; i < __csN; i++) if (__cs[i] === n) { __ps.violC++; const kc = site + ':' + __csA[i] + ':d' + cursorDepth; __ps.violCSites[kc] = (__ps.violCSites[kc] || 0) + 1; break; }\n");
  for (const A of ARMS) {
    s = rep(s, "    function " + A + "(node) {\n",
      "    function " + A + "(node) {\n" +
      "        const __g = node.gen; __ps.armE['" + A + "'] = (__ps.armE['" + A + "'] || 0) + 1;\n" +
      "        __cs[__csN] = node; __csA[__csN++] = '" + A + "'; if (__csN > __ps.csMax) __ps.csMax = __csN;\n" +
      "        try { return __c_" + A + "(node); } finally { __cs[--__csN] = null; if (node.gen !== __g) __ps.armMv['" + A + "'] = (__ps.armMv['" + A + "'] || 0) + 1; }\n" +
      "    }\n    function __c_" + A + "(node) {\n");
  }
  return s;
}

function addR1aCtr(s) {
  s = rep(s, "csMax: 0 }", "csMax: 0, r1aDo: 0, r1aOwn: 0 }");
  s = rep(s, "    const __cs = [], __csA = []; let __csN = 0;\n", "    const __cs = [], __csA = [], __csG = []; let __csN = 0;\n");
  s = rep(s, "        __cs[__csN] = node; __csA[__csN++] = '", "        __csG[__csN] = __g; __cs[__csN] = node; __csA[__csN++] = '", 4);
  const w0 = "        while ((child = node.firstOwned) !== null) {\n", w1 = "        while (node.gen === g && (child = node.firstOwned) !== null) {   // b227 R1a\n";
  const w = s.includes(w1) ? w1 : w0;
  s = rep(s, w, w + "            if (node.gen !== g) __ps.r1aDo++;\n");
  s = rep(s, "    function runOwnCleanup(node) {\n        const cleanup = node.cleanupFn;\n",
    "    function runOwnCleanup(node) {\n        for (let __i = 0; __i < __csN; __i++) if (__cs[__i] === node && __csG[__i] !== node.gen) { __ps.r1aOwn++; break; }\n        const cleanup = node.cleanupFn;\n");
  return s;
}
const CLR_TAIL = "node.flags &= ~FLAG_QUEUED;   // stranded QUEUED (no call: holds at the stack limit)\n";
function instrF(src, tag) {
  let s = src;
  s = rep(s, "export class CapacityError extends Error {\n",
    "const __psf = ((globalThis.__PS || (globalThis.__PS = {}))[" + JSON.stringify(tag) + "] = { entries: 0, fh: 0, fhSites: {}, catches: 0, catchMv: 0, fclear: 0, fclearMv: 0 });\nexport class CapacityError extends Error {\n");
  s = rep(s, "    let pinnedHead = null;\n", "    let pinnedHead = null;\n    let __fnode = null;\n");
  const H = (site) => "if (node === __fnode) { __psf.fh++; __psf.fhSites." + site + " = (__psf.fhSites." + site + " || 0) + 1; }";
  s = rep(s, "            node = freeNodeHead;\n            freeNodeHead = node.nextFree;\n            node.nextFree = null;\n        }\n        activeNodes = (activeNodes + 1) | 0;\n",
    "            node = freeNodeHead;\n            freeNodeHead = node.nextFree;\n            node.nextFree = null;\n            " + H("pop") + "\n        }\n        activeNodes = (activeNodes + 1) | 0;\n");
  s = rep(s, "            node.nextFree = null;\n            return node;\n        }\n        if (policy === \"throw\"",
    "            node.nextFree = null;\n            " + H("missRel") + "\n            return node;\n        }\n        if (policy === \"throw\"");
  s = rep(s, "            statPoolGrowths++;   // 1.4: capacity ledger crossed\n        }\n        return node;\n    }\n",
    "            statPoolGrowths++;   // 1.4: capacity ledger crossed\n        }\n        " + H("missGrow") + "\n        return node;\n    }\n");
  s = rep(s, "                    const node = currentQueue[i];\n", "                    const node = currentQueue[i];\n                    const __fg = node.gen; __fnode = node; __psf.entries++;\n");
  s = rep(s, "                        flushErrorBuffer[flushErrorCount++] = err;\n", "                        __psf.catches++; if (node.gen !== __fg) __psf.catchMv++;\n                        flushErrorBuffer[flushErrorCount++] = err;\n");
  s = rep(s, CLR_TAIL + "                    }\n",
    "{ if (node.gen !== __fg) { __psf.fclearMv++; if ((node.flags & FLAG_QUEUED) !== 0) __psf.fclear++; } node.flags &= ~FLAG_QUEUED; }   // stranded QUEUED (no call: holds at the stack limit)\n                    }\n                    __fnode = null;\n");
  return s;
}

// ---- coded-text controls (applied BEFORE the instrumentation) ----
const HIT = (n) => "globalThis.__B230I.hit." + n + "++";
const CTL = {
  // a running node is freed at once instead of pinned (the pin condition's COMPUTING clause dropped)
  CTLIMM: (t) => rep(t, "        if ((f & FLAG_COMPUTING) !== 0) {\n            node.nextFree = pinnedHead;", "        if ((f & FLAG_COMPUTING) !== 0 && (" + HIT("CTLIMM") + ", false)) {\n            node.nextFree = pinnedHead;"),
  // refreshComputed's disposed-during-body exit releases EVERY pin at once (releasePinned at a live outer frame) instead of its own
  CTLEARLY: (t) => rep(t, "            if (node.flags === 0) { unpinOwn(node); return; }   // disposed during body", "            if (node.flags === 0) { " + HIT("CTLEARLY") + "; releasePinned(); return; }   // disposed during body"),
  // arm-immune: a node disposed while one of the 4 arms is active for it goes straight to the free list (research mkIMM, on the coded text)
  CTLEIMM: (t) => {
    let s = rep(t, "    let pinnedHead = null;\n", "    let pinnedHead = null;\n    const __am = []; let __amN = 0;\n");
    for (const A of ARMS) s = rep(s, "    function " + A + "(node) {\n", "    function " + A + "(node) {\n        __am[__amN++] = node;\n        try { return __i_" + A + "(node); } finally { __am[--__amN] = null; }\n    }\n    function __i_" + A + "(node) {\n");
    s = rep(s, "    function runFirstBody(node, isEffect) {\n", "    function __immArm(n) { for (let i = 0; i < __amN; i++) if (__am[i] === n) return true; return false; }\n    function runFirstBody(node, isEffect) {\n        for (let i = 0; i < __amN; i++) if (__am[i] === node) __am[i] = null;\n");
    return rep(s, "        if ((f & FLAG_COMPUTING) !== 0) {\n            node.nextFree = pinnedHead;", "        if ((f & FLAG_COMPUTING) !== 0 && !(__immArm(node) && (" + HIT("CTLEIMM") + ", true))) {\n            node.nextFree = pinnedHead;");
  },
  // unpinScope also frees a RUNNING pin (ignores the kind)
  CTLSRUN: (t) => rep(t, "        if (n === null) return;\n        if (p === null) scopePinHead = n.nextFree;",
    "        if (n === null) {   // CTLS-RUN control\n            " + HIT("CTLSRUN") + ";\n            let q = null, m = pinnedHead;\n            while (m !== null && m !== node) { q = m; m = m.nextFree; }\n            if (m === null) return;\n            if (q === null) pinnedHead = m.nextFree; else q.nextFree = m.nextFree;\n            m.nextFree = freeNodeHead; freeNodeHead = m;\n            return;\n        }\n        if (p === null) scopePinHead = n.nextFree;"),
  // disposeNode's flushCur null dropped (R0c) / severStale's gen-moved release dropped (R7a): the stage.mjs controls, here under the oracles
  CTLR0c: (t) => rep(t, "if (node === flushCur) flushCur = null;", "if (node === flushCur) " + HIT("CTLR0c") + ";"),
  CTLR7: (t) => rep(t, "} else unpinOwn(node);   // R7a (F-b224-1)", "} else { " + HIT("CTLR7") + "; }   // R7a (F-b224-1)"),
  // unpinScope without its outer-scope refusal
  CTLSNEST: (t) => rep(t, "        if (scopeDepth !== 0 && scopeOwned(node)) return;\n        let p = null, n = scopePinHead;", "        if (scopeDepth !== 0 && scopeOwned(node)) " + HIT("CTLSNEST") + ";\n        let p = null, n = scopePinHead;"),
};
export const IMM_CONTROLS = Object.keys(CTL);
for (const k of IMM_CONTROLS) globalThis.__B230I.hit[k] = 0;
let seq = 0;
// kind: "I" | "Ic" | "If"; ctl: "" or one CTL name. Returns { E, ps(), zero(), tag }. A control tag starts with the control name (the
// instr() CTLSRUN counter keys on it).
export async function loadInstr(srcFile, kind, ctl) {
  let text = readFileSync(srcFile, "utf8");
  if (ctl) { if (!CTL[ctl]) throw new Error("instr: unknown control " + ctl); text = CTL[ctl](text); }
  const tag = (ctl || "plain") + "-" + kind + "-" + (seq++);
  const t = kind === "I" ? instr(text, tag, "s") : kind === "Ic" ? addR1aCtr(toC(instr(text, tag, "s"))) : instrF(text, tag);
  const dir = mkdtempSync(join(tmpdir(), "b230i-"));
  writeFileSync(join(dir, "Signal.js"), t); copyFileSync(join(dirname(srcFile), "Watch.js"), join(dir, "Watch.js"));
  const E = await import(pathToFileURL(join(dir, "Signal.js")).href);
  const P = () => globalThis.__PS[tag];
  const zero = () => { const o = P(); for (const k of Object.keys(o)) o[k] = (o[k] !== null && typeof o[k] === "object") ? {} : 0; };
  const ps = () => ({ ...P() });
  return { E, ps, zero, tag, text: t };
}
const toC = (s) => instrC(rep(s, "    let __pinLen = 0, __spLen = 0; const __fs = []; let __fsN = 0;\n", "    let __spLen = 0;\n    let __pinLen = 0; const __fs = []; let __fsN = 0;\n"));
export const plainPs = () => null;

// ---- shared probe helpers (research r1d/R1/common.mjs, b228 probes/common-u2.mjs) ----
const settle = async () => { await Promise.resolve(); await new Promise((res) => setTimeout(res, 0)); };
const msg = (e) => String(e && e.name === "CapacityError" ? "CapacityError" : e && e.message).slice(0, 80);
const msg70 = (e) => String(e && e.name === "CapacityError" ? "CapacityError" : e && e.message).slice(0, 70);
function fill(r) { let st = r.stats(); while (st.nodePoolPopulation - st.activeNodes > 0) { r.signal(0); st = r.stats(); } return { active: st.activeNodes, pool: st.nodePoolPopulation }; }
function touched(log) { const a = log.indexOf("--after"); const y = log.indexOf("Y:cleanup"), z = log.indexOf("Z:cleanup"); return { Y: y >= 0 && y < a, Z: z >= 0 && z < a }; }
function act(r, log, disposeX, withZ, sink) {
  disposeX(); log.push("X:disposed");
  sink.Y = r.effect(() => { log.push("Y:run"); r.onCleanup(() => log.push("Y:cleanup"));
    if (withZ) { sink.Z = r.computed(() => { r.onCleanup(() => log.push("Z:cleanup")); log.push("Z:run"); return 7; }); log.push("Z=" + sink.Z()); } });
  log.push("Y:created");
}
async function tail(r, log, sink) {
  log.push("--after");
  if (sink.Z) { let zv; try { zv = sink.Z(); } catch (e) { zv = "E:" + msg(e); } log.push("Z()=" + zv); }
  try { if (sink.Y) { sink.Y(); log.push("Y:disposed-by-test"); } } catch (e) { log.push("Ydispose E:" + msg(e)); }
}
// ctx = { zero, ps } (instrumented) or null (plain: ps field null). Row objects as the research probes print them, minus the build tag.
const Z = (ctx) => { if (ctx) ctx.zero(); };
const PSX = (ctx) => { if (!ctx) return null; if (ctx.x) return ctx.x(); const t = ctx.ps(); return { viol: t.viol, violSites: t.violSites, violC: t.violC, violCSites: t.violCSites, r1aDo: t.r1aDo, r1aOwn: t.r1aOwn, armE: t.armE, armMv: t.armMv,
  missTop: t.missTop, handouts: t.handouts, releases: t.releases, released: t.released, pins: t.pins, unpins: t.unpins, hw: t.hw, ce: t.ce }; };

// ---- haz1 (r1d/R1/haz1.mjs): X's RE-RUN arm (top-level flush, depth 0) disposes X and creates Y; fill = exact-filled pool ----
export async function haz1Rows(E, ctx) {
  const out = [];
  async function variant(kindX, doFill, withZ, pol) {
    const r = E.createRegistry({ onCapacityExceeded: pol });
    const log = [], sink = { Y: null, Z: null };
    const t = r.signal(0);
    let armed = false, Xh = null;
    const body = () => { const v = t(); log.push("X:run:" + v);
      r.effect(() => { r.onCleanup(() => { log.push("C1:cleanup"); if (!armed) return; armed = false;
        act(r, log, () => (kindX === "effect" ? Xh() : r.dispose(Xh)), withZ, sink); }); });
      return v; };
    if (kindX === "effect") Xh = r.effect(body);
    else { Xh = r.computed(body); r.effect(() => { log.push("R:" + Xh()); }); }
    const before = doFill ? fill(r) : (() => { const s = r.stats(); return { active: s.activeNodes, pool: s.nodePoolPopulation }; })();
    Z(ctx); armed = true;
    let err = null;
    try { t.set(1); } catch (e) { err = msg(e); }
    await settle();
    await tail(r, log, sink);
    const st = r.stats();
    return { row: "haz1/" + kindX + "/" + (doFill ? "fill" : "nofill") + "/" + (withZ ? "Z" : "noZ") + "/" + pol, before, err, touched: touched(log), log: log.join(" | "), after: st.activeNodes, pool: st.nodePoolPopulation, ps: PSX(ctx) };
  }
  for (const pol of ["grow", "throw"]) for (const kindX of ["effect", "computed"]) for (const f of [true, false]) for (const z of [true, false]) out.push(await variant(kindX, f, z, pol));
  return out;
}
// ---- firstrun (r1d/R1/firstrun.mjs): the first-run arms via drainPreRun ----
export async function firstRows(E, ctx) {
  const out = [];
  async function variant(kindX, doFill, withZ, pol) {
    const r = E.createRegistry({ onCapacityExceeded: pol });
    const log = [], sink = { Y: null, Z: null }, q = [];
    const t = r.signal(0);
    let armed = false, Xh = null;
    const body = () => { const v = t(); log.push("X:run:" + v); return v; };
    if (kindX === "effect") Xh = r.effect(body, { scheduler: (run) => q.push(run) });
    else Xh = r.computed(body);
    r.runWithOwner(Xh, () => r.effect(() => { r.onCleanup(() => { log.push("C1:cleanup"); if (!armed) return; armed = false;
      act(r, log, () => (kindX === "effect" ? Xh() : r.dispose(Xh)), withZ, sink); }); }));
    const before = doFill ? fill(r) : (() => { const s = r.stats(); return { active: s.activeNodes, pool: s.nodePoolPopulation }; })();
    Z(ctx); armed = true;
    let err = null, rv;
    try { if (kindX === "effect") { const th = q.shift(); if (!th) throw new Error("no deferred run"); th(); } else rv = Xh(); } catch (e) { err = msg(e); }
    await settle();
    log.push("rv=" + rv);
    await tail(r, log, sink);
    const st = r.stats();
    return { row: "first/" + kindX + "/" + (doFill ? "fill" : "nofill") + "/" + (withZ ? "Z" : "noZ") + "/" + pol, before, err, touched: touched(log), log: log.join(" | "), after: st.activeNodes, pool: st.nodePoolPopulation, ps: PSX(ctx) };
  }
  for (const pol of ["grow", "throw"]) for (const kindX of ["effect", "computed"]) for (const f of [true, false]) for (const z of [true, false]) out.push(await variant(kindX, f, z, pol));
  return out;
}
// ---- nestflush (r1d/R1/nestflush.mjs): release point (ii), a nested flush at cursorDepth 0 ----
export async function nestRows(E, ctx) {
  const out = [];
  async function variant(write, withZ, pol) {
    const r = E.createRegistry({ onCapacityExceeded: pol });
    const log = [], sink = { Y: null, Z: null };
    const t = r.signal(0), s2 = r.signal(0);
    r.effect(() => { log.push("E2:" + s2()); });
    let armed = false, Xh = null;
    Xh = r.computed(() => { const v = t(); log.push("X:run:" + v);
      r.effect(() => { r.onCleanup(() => { log.push("C1:cleanup"); if (!armed) return; armed = false;
        act(r, log, () => { r.dispose(Xh); if (write) { log.push("w"); s2.set(1); } }, withZ, sink); }); });
      return v; });
    log.push("X0=" + Xh());
    const st0 = r.stats();
    Z(ctx); armed = true;
    let err = null, rv;
    try { t.set(1); rv = Xh(); } catch (e) { err = msg(e); }
    await settle();
    log.push("rv=" + rv);
    await tail(r, log, sink);
    const st = r.stats();
    return { row: "nest/" + (write ? "write" : "nowrite") + "/" + (withZ ? "Z" : "noZ") + "/" + pol, before: { active: st0.activeNodes, pool: st0.nodePoolPopulation }, err, touched: touched(log), log: log.join(" | "), after: st.activeNodes, pool: st.nodePoolPopulation, ps: PSX(ctx) };
  }
  for (const pol of ["grow", "throw"]) for (const w of [true, false]) for (const z of [true, false]) out.push(await variant(w, z, pol));
  return out;
}
// ---- unwind (r1d/R1/unwind.mjs): arm-counter unwind rows; N iterations ----
export function unwindRows(E, ctx, N = 2000, only = null) {
  const ERR = new Error("unwind");
  const ev = { RE: 0, RC: 0, FE: 0, FC: 0, CYC: 0, DESTROY: 0, other: null };
  function arm(r, F, i) {
    if (F === "RE") { const a = r.signal(0); const X = r.effect(() => { a(); r.onCleanup(() => { if (a.peek() > 0) throw ERR; }); });
      try { a.set(1); } catch (e) { if (e === ERR) ev.RE++; else throw e; } try { X(); } catch {} r.dispose(a); }
    else if (F === "RC") { const a = r.signal(0); const X = r.computed(() => { a(); r.onCleanup(() => { if (a.peek() > 0) throw ERR; }); return 1; });
      X(); a.set(1); try { X(); } catch (e) { if (e === ERR) ev.RC++; else throw e; } r.dispose(X); r.dispose(a); }
    else if (F === "FE" || F === "CYC") { const q = []; const X = r.effect(() => {}, { scheduler: (run) => q.push(run) });
      let k = 0; const attach = () => r.runWithOwner(X, () => r.effect(() => { r.onCleanup(() => { if (F === "CYC" && k++ < 1000) attach(); throw ERR; }); }));
      attach(); try { q.shift()(); } catch (e) { const s = String(e && e.message) + (e && e.errors ? e.errors.map((x) => x && x.message).join(",") : "");
        if (F === "CYC" ? /CycleError/.test(s) : (e === ERR || /unwind/.test(s))) ev[F]++; else throw e; } try { X(); } catch {} }
    else if (F === "FC") { const X = r.computed(() => 1); r.runWithOwner(X, () => r.effect(() => { r.onCleanup(() => { throw ERR; }); }));
      try { X(); } catch (e) { if (e === ERR || /unwind/.test(String(e && e.message))) ev.FC++; else throw e; } r.dispose(X); }
    else if (F === "DESTROY" && i === 0) { const a = r.signal(0); const X = r.computed(() => { a(); r.onCleanup(() => { if (a.peek() > 0) { r.destroy(); ev.DESTROY++; } }); return 1; });
      X(); a.set(1); try { X(); } catch {} }
  }
  function pin(r) {
    const s = r.signal(1), sw = r.signal(true); let X = null;
    r.observeObservers(s, { onDisconnect: () => { r.dispose(X); throw ERR; } });
    X = r.computed(() => (sw() ? s() : 0));
    try { X(); sw.set(false); X(); } catch (e) { if (e !== ERR && !/unwind/.test(String(e && e.message))) throw e; }
    r.dispose(s); r.dispose(sw);
  }
  const out = [];
  for (const pol of ["grow", "throw"]) for (const F of ["none", "RE", "RC", "FE", "FC", "CYC", "DESTROY"]) {
    if (only !== null && !only.includes(F)) continue;
    for (const k of Object.keys(ev)) ev[k] = k === "other" ? null : 0;
    const r = E.createRegistry({ onCapacityExceeded: pol });
    Z(ctx);
    let i = 0, err = null;
    try { for (; i < N; i++) { arm(r, F, i); pin(r); } } catch (e) { err = msg(e); }
    const st = r.stats();
    out.push({ row: "unwind/" + F + "/" + pol, iters: i, err, events: ev[F] === undefined ? 0 : ev[F], pool: st.nodePoolPopulation, active: st.activeNodes, ps: PSX(ctx) });
  }
  return out;
}
// ---- armreset (b228 probes/probe-armreset.mjs): reset() / destroy() inside each of the 4 cleanup arms, then the haz1 fill shape ----
export function armResetRows(E) {
  function phase1(r, op, arm) {
    let res = "not-called", armed = false;
    const cb = () => { if (!armed) return; armed = false; try { if (op === "reset") r.reset(); else r.destroy(); res = "ok"; } catch (e) { res = "E:" + msg70(e); } };
    try {
      if (arm === "RC") { const a = r.signal(0); const X = r.computed(() => { a(); r.onCleanup(cb); return 1; }); X(); armed = true; a.set(1); X(); }
      else if (arm === "FC") { const X = r.computed(() => 1); r.runWithOwner(X, () => r.onCleanup(cb)); armed = true; X(); }
      else if (arm === "RE") { const q = [], a = r.signal(0); r.effect(() => { a(); r.onCleanup(cb); }, { scheduler: (run) => q.push(run) }); q.shift()(); armed = true; a.set(1); q.shift()(); }
      else if (arm === "FE") { const q = []; const X = r.effect(() => {}, { scheduler: (run) => q.push(run) }); r.runWithOwner(X, () => r.onCleanup(cb)); armed = true; q.shift()(); }
    } catch (e) { return res + " / outer E:" + msg70(e); }
    return res;
  }
  function phase2(r) {
    const t = r.signal(0); let armed = false, Xh = null, Y = null;
    Xh = r.effect(() => { t(); r.effect(() => { r.onCleanup(() => { if (!armed) return; armed = false; Xh(); Y = r.effect(() => {}); }); }); });
    const before = fill(r); armed = true; let err = null;
    try { t.set(1); } catch (e) { err = msg70(e); }
    const st = r.stats();
    return { before, err, pool: st.nodePoolPopulation, Ycreated: Y !== null };
  }
  const out = [];
  for (const pol of ["grow", "throw"]) for (const op of ["none", "reset", "destroy"]) for (const arm of op === "none" ? ["-"] : ["RE", "RC", "FE", "FC"]) {
    const r = E.createRegistry({ onCapacityExceeded: pol });
    const p1 = op === "none" ? "-" : phase1(r, op, arm);
    const p2 = phase2(r);
    out.push({ row: "armop/" + op + "/" + arm + "/" + pol, op: p1, p2 });
  }
  return out;
}
// ---- L21B (b228 probes/probe-l21b.mjs): the SECOND equals call (batch revert check) of a signal / signalBox ----
function nodeOf(h) { const k = Object.getOwnPropertySymbols(h).find((s) => typeof h[s] === "object" && h[s] !== null && "gen" in h[s]); return k ? h[k] : null; }
export function l21bRows(E) {
  const out = [];
  for (const pol of ["grow", "throw"]) for (const kind of ["signal", "box"]) for (const call of [1, 2]) for (const ret of [false, true]) for (const v of ["dispose", "nodispose"]) {
    const r = E.createRegistry({ onCapacityExceeded: pol });
    let n = 0, s = null, y = null, yRuns = 0, sNode = null, sameSlot = null;
    const eq = (a, b) => { n++; if (n === call) { if (v === "dispose") r.dispose(s); y = kind === "signal" ? r.signal("Y") : r.signalBox("Y"); sameSlot = nodeOf(y) === sNode;
        r.effect(() => { yRuns++; kind === "signal" ? y() : y.get(); }); return ret; } return false; };
    s = kind === "signal" ? r.signal(0, { equals: eq }) : r.signalBox(0, { equals: eq }); sNode = nodeOf(s);
    let err = null; try { if (call === 2) r.batch(() => s.set(1)); else s.set(1); } catch (e) { err = msg70(e); }
    let yv; try { yv = y ? (kind === "signal" ? y() : y.get()) : "none"; } catch (e) { yv = "E:" + msg70(e); }
    const yRunsAfter = yRuns; let yRuns2 = null;
    try { if (y) { y.set("Y2"); yRuns2 = yRuns; } } catch (e) { yRuns2 = "E:" + msg70(e); }
    out.push({ row: "L21/" + kind + "/eq" + call + "/ret" + ret + "/" + v + "/" + pol, eqCalls: n, err, sameSlot, yv, yRuns: yRunsAfter, yRunsAfterSetY2: yRuns2, defect: v === "dispose" ? yRunsAfter !== 1 : null });
  }
  return out;
}
// ---- locals (r1d/ALL3/locals.mjs; L-3/L-4 rows + the LOCALS KNOWN rows; L-1 pre-walk is B1's l1pwRow, L-9 is not a B2 row) ----
const lmsg = (e) => String(e && e.name === "CapacityError" ? "CapacityError" : (e && e.name) + ":" + (e && e.message)).slice(0, 90);
const lbefore = (log, s) => { const a = log.indexOf("--after"), i = log.indexOf(s); return i >= 0 && (a < 0 || i < a); };
const lafterHas = (log, s) => { const a = log.indexOf("--after"); return a >= 0 && log.indexOf(s, a) >= 0; };
export async function localsRows(E) {
  const out = [];
  async function row(name, pol, fn) {
    const log = []; let err = null, res = {};
    const r = E.createRegistry({ onCapacityExceeded: pol });
    try { res = await fn(r, log); } catch (e) { err = lmsg(e); }
    let st = null; try { const s = r.stats(); st = { active: s.activeNodes, links: s.activeLinks, pool: s.nodePoolPopulation }; } catch {}
    out.push({ row: name, pol, err, ...res, log: log.join(" | "), stats: st });
  }
  const msg = lmsg, before = lbefore, afterHas = lafterHas;
  for (const pol of ["grow", "throw"]) {
  // L-3 / L-4 dispose path: top-level (d0) or in-effect (d1) dispose(P); child C's cleanup disposes P again (re-entrant, P -> FL),
  // then creates effect Y (onCleanup + owned child effect Z): Y pops P's slot; the outer disposeOwned / runCleanup holds P.
  for (const [kindP, inner] of [["effect", "call"], ["effect", "rdispose"], ["computed", "rdispose"]]) for (const depth of ["d0", "d1"]) await row("L34/" + kindP + "/" + inner + "/" + depth, pol, async (r, log) => {
    let armed = false, Ph = null, Yh = null, Zh = null;
    const body = () => { r.effect(() => { r.onCleanup(() => { log.push("C:cleanup"); if (!armed) return; armed = false;
      if (inner === "call") Ph(); else r.dispose(Ph); log.push("P:re-disposed");
      Yh = r.effect(() => { log.push("Y:run"); r.onCleanup(() => log.push("Y:cleanup"));
        Zh = r.effect(() => { log.push("Z:run"); r.onCleanup(() => log.push("Z:cleanup")); }); });
      log.push("Y:created"); }); }); return 1; };
    if (kindP === "effect") Ph = r.effect(body); else { Ph = r.computed(body); Ph(); }
    const disp = () => { armed = true; if (kindP === "effect") Ph(); else r.dispose(Ph); };
    if (depth === "d0") disp();
    else { const go = r.signal(0); r.effect(() => { if (go() === 1) disp(); }); go.set(1); }
    await settle(); log.push("--after");
    const st = r.stats(); const activeMid = st.activeNodes;
    try { if (Yh) { Yh(); log.push("Y:disposed-by-test"); } } catch (e) { log.push("Ydispose " + msg(e)); }
    const zEarly = before(log, "Z:cleanup"), yEarly = before(log, "Y:cleanup");
    return { Yc: !!Yh, zEarly, yEarly, yCleanupAtTest: afterHas(log, "Y:cleanup"), zCleanupAtTest: afterHas(log, "Z:cleanup"), activeMid, defect: zEarly || yEarly };
  });
  // L-6 op-2 listener: the dispose hook (fired before the flags test) re-disposes x and creates a node Y (pops x's slot).
  for (const kindX of ["signal", "effect"]) await row("L6-OP2/" + kindX, pol, async (r, log) => {
    const src = r.signal(0); const x = kindX === "signal" ? r.signal(1) : r.effect(() => { src(); });
    const xid = r.nodeId(x); let armed = true, y = null; const a0 = r.stats().activeNodes;
    const off = r.onGraphMutation((op, a) => { if (op === 2 && a === xid && armed) { armed = false; r.dispose(x); y = r.signal(7); log.push("hook:x-re-disposed,y-created"); } });
    r.dispose(x); off();
    let yv; try { yv = y ? y() : "none"; } catch (e) { yv = "E:" + msg(e); }
    const a1 = r.stats().activeNodes;
    return { yv, activeDelta: a1 - a0, defect: yv !== 7 || a1 - a0 !== 0 };
  });
  // L-7 disposeNode dep-link walk: X reads s, t; dispose(X); s's 1->0 callback (onDisconnect | op-4 listener) disposes X again
  // and creates effect Y reading u (pops X's slot); the outer walk re-reads node.headDep = Y's link to u.
  for (const via of ["onDisconnect", "op4"]) for (const inner of ["call", "rdispose"]) await row("L7-DW/" + via + "/" + inner, pol, async (r, log) => {
    const s = r.signal(0), t = r.signal(0), u = r.signal(0); let armed = true, Yh = null, off = null;
    const Xh = r.effect(() => { s(); t(); log.push("X:run"); });
    const cb = () => { if (!armed) return; armed = false; if (inner === "call") Xh(); else r.dispose(Xh); log.push("X:re-disposed"); Yh = r.effect(() => { log.push("Y:" + u()); }); };
    if (via === "onDisconnect") r.observeObservers(s, { onDisconnect: cb });
    else { const sid = r.nodeId(s); off = r.onGraphMutation((op, a) => { if (op === 4 && a === sid) cb(); }); }
    Xh(); if (off) off();
    await settle(); log.push("--after"); u.set(1);
    const Y1 = afterHas(log, "Y:1");
    return { Yc: !!Yh, Y1, defect: !!Yh && !Y1 };
  });
  // L-21 / L-22 user equals on set / box set: equals disposes its own signal s and creates signal Y (pops s's slot).
  for (const kindS of ["signal", "box"]) await row("L2122-EQ/" + kindS, pol, async (r, log) => {
    let armed = true, y = null, s = null;
    const eq = () => { if (armed) { armed = false; r.dispose(s); y = kindS === "signal" ? r.signal("Y") : r.signalBox("Y"); log.push("eq:s-disposed,y-created"); } return false; };
    s = kindS === "signal" ? r.signal(0, { equals: eq }) : r.signalBox(0, { equals: eq });
    let yRuns = 0; s.set(1);
    let yv; try { yv = y ? (kindS === "signal" ? y() : y.get()) : "none"; } catch (e) { yv = "E:" + msg(e); }
    return { yv, defect: yv !== "Y" };
  });
  // L-24 op-1 hook during computed / effect / computedBox creation inside effect O's body: the hook disposes O (COMPUTING ->
  // pinned; the cascade frees the new non-COMPUTING child -> FL) and creates z = signal(5) (pops the child's slot).
  for (const kindC of ["computed", "effect", "computedBox"]) await row("L24-OP1/" + kindC, pol, async (r, log) => {
    const go = r.signal(0); let armed = false, z = null, Oh = null, made = null;
    const off = r.onGraphMutation((op) => { if (op === 1 && armed) { armed = false; Oh(); z = r.signal(5); log.push("hook:O-disposed,z-created"); } });
    Oh = r.effect(() => { if (go() !== 1) return; armed = true;
      made = kindC === "computed" ? r.computed(() => { log.push("c:run"); return 9; }) : kindC === "effect" ? r.effect(() => { log.push("e:run"); }) : r.computedBox(() => { log.push("cb:run"); return 9; });
      log.push("made"); });
    const s0 = r.stats();
    go.set(1); off();
    let zv, mv; try { zv = z ? z() : "none"; } catch (e) { zv = "E:" + msg(e); }
    try { mv = made === null ? "none" : kindC === "computed" ? made() : kindC === "computedBox" ? made.get() : typeof made; } catch (e) { mv = "E:" + msg(e); }
    let zv2; try { zv2 = z ? z() : "none"; } catch (e) { zv2 = "E:" + msg(e); }
    let alias = null; try { alias = made !== null && z !== null && typeof r.nodeId === "function" ? r.nodeId(made) !== undefined && r.nodeId(made) === r.nodeId(z) : null; } catch (e) { alias = "E:" + msg(e); }
    const s1 = r.stats(); const ks = Object.keys(s1).filter((q) => /^(signals|computeds|effects|computedCount|signalCount|effectCount)$/.test(q));
    return { zv, mv, zv2, alias, statsKinds: Object.fromEntries(ks.map((q) => [q, s1[q] - s0[q]])), defect: zv !== 5 || zv2 !== 5 || alias === true };
  });
  // L-37 / L-38 introspection walks: fn disposes the NEXT node; recycle = then create a node that pops the freed link / node.
  for (const walk of ["forEachObserver", "forEachSource", "forEachOwned"]) for (const recycle of [false, true]) await row("L3738/" + walk + "/" + (recycle ? "recycle" : "norecycle"), pol, async (r, log) => {
    const w = r.signal(0); let n = 0; const seen = []; let ids, target, killNext;
    if (walk === "forEachObserver") { const s = r.signal(0); const hs = [0, 1, 2].map(() => r.effect(() => { s(); })); target = s;
      ids = []; r.forEachObserver(s, (d) => ids.push(d.id)); killNext = () => hs[1](); }
    else if (walk === "forEachSource") { const ss = [0, 1, 2].map(() => r.signal(0)); const X = r.effect(() => { for (const q of ss) q(); }); target = X;
      ids = []; r.forEachSource(X, (d) => ids.push(d.id)); killNext = () => r.dispose(ss.find((q) => r.nodeId(q) === ids[1])); }
    else { const hs = []; const P = r.effect(() => { for (let i = 0; i < 3; i++) hs.push(r.effect(() => {})); }); target = P;
      ids = []; r.forEachOwned(P, (d) => ids.push(d.id)); killNext = () => { const h = hs.find((q) => r.nodeId(q) === ids[1]); h(); }; }
    let walkErr = null;
    try { r[walk](target, (d) => { seen.push(d.id); if (n++ === 0) { killNext(); if (recycle) r.effect(() => { w(); }); } }); } catch (e) {
      // V8 message text varies across Node majors (CI 22 / 24 / 26): pin the class + the property read
      walkErr = (e instanceof TypeError && /\(reading 'gen'\)/.test(String(e.message))) ? "TypeError:null.gen" : msg(e);
    }
    const stranger = seen.filter((id) => !ids.includes(id)), skipped = ids.filter((id, i) => i !== 1 && !seen.includes(id));
    return { ids, seen, walkErr, stranger, skipped, defect: walkErr !== null || stranger.length > 0 || skipped.length > 0 };
  });
  }
  return out;
}

// ---- plain patched loader (ZEROARM-RESET / ZEROARM-DESTROY: the U1 reviewer's mutants re-applied to the coded text; hit counter = reach) ----
const ZA = {
  "ZEROARM-RESET": (t) => rep(t, "        disposeDepth++;\n        try { errs = batch(resetRounds); }", "        disposeDepth++; armDepth = (" + HIT("ZEROARM") + ", 0);\n        try { errs = batch(resetRounds); }"),
  "ZEROARM-DESTROY": (t) => rep(t, "        scopePinHead = null;   // SG2: scope pins likewise; armDepth is not zeroed here (R1bNZ)\n", "        armDepth = (" + HIT("ZEROARM") + ", 0); scopePinHead = null;   // SG2: scope pins likewise; armDepth is not zeroed here (R1bNZ)\n"),
};
globalThis.__B230I.hit.ZEROARM = 0;
export async function loadZeroArm(srcFile, name) {
  const text = ZA[name](readFileSync(srcFile, "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "b230z-"));
  writeFileSync(join(dir, "Signal.js"), text); copyFileSync(join(dirname(srcFile), "Watch.js"), join(dir, "Watch.js"));
  return import(pathToFileURL(join(dir, "Signal.js")).href + "?z=" + (seq++));
}
