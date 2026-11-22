// mutants.mjs -- b232 (D-b231-1): the six pinned-slot engine mutants (+ b245 XA6: the four NODEC-normal), as count-checked text
// edits of the LIVE Signal.js. The b232 edit definitions are copied verbatim from .handoff/b228/mutants/mutants.mjs (rows
// RE/RC/FE/FC-NODEC-catch, UO-SOLATE, H18-NOFLAGS). Every edit is count-checked: a wrong match count THROWS (the row that asked
// for the mutant FAILS, never skips).
import { mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const DECC_F = "} catch (e) { armDepth--; node.flags &= ~FLAG_COMPUTING; throw e; }", DECC_R = "armDepth--;   // R1bNZ: throw exit";
// b245 XA6 (D-b240-7, ON-7): the four NODEC-normal edits, nth of 4 normal-exit decrements in source order (FE firstRunCleanupE,
// FC firstRunCleanupC, RE rerunCleanupEffect, RC rerunCleanupComputed); same edits as .handoff/b245/xa6/probe/run-e.mjs stage().
const DECN_R = "armDepth--;   // R1bNZ: normal exit", DECN_T = "void 0;   // R1bNZ: normal exit";
const SO = "const so = scopeDepth !== 0 && scopeOwned(node);";
const UNLINK = "        if (n === null) return;\n        if (p === null) pinnedHead = n.nextFree; else p.nextFree = n.nextFree;\n";
const SG2CALL = "if (scoped && node.flags === 0) unpinScope(node);";
const E = (from, to, count = 1, nth) => ({ from, to, count, nth });
export const MUT = {
    "RE-NODEC-catch": [E(DECC_R, "void 0;   // R1bNZ: throw exit", 2, 1)],
    "RC-NODEC-catch": [E(DECC_R, "void 0;   // R1bNZ: throw exit", 2, 2)],
    "FE-NODEC-catch": [E(DECC_F, "} catch (e) { node.flags &= ~FLAG_COMPUTING; throw e; }", 2, 1)],
    "FC-NODEC-catch": [E(DECC_F, "} catch (e) { node.flags &= ~FLAG_COMPUTING; throw e; }", 2, 2)],
    "FE-NODEC-normal": [E(DECN_R, DECN_T, 4, 1)],
    "FC-NODEC-normal": [E(DECN_R, DECN_T, 4, 2)],
    "RE-NODEC-normal": [E(DECN_R, DECN_T, 4, 3)],
    "RC-NODEC-normal": [E(DECN_R, DECN_T, 4, 4)],
    "UO-SOLATE": [E(SO, "let so = false;"), E(UNLINK, UNLINK.replace("n.nextFree;\n", "n.nextFree; so = scopeDepth !== 0 && scopeOwned(node);\n") + "        if (p === null) pinnedHead = n.nextFree; else p.nextFree = n.nextFree;\n")],
    "H18-NOFLAGS": [E(SG2CALL, "if (scoped) unpinScope(node);")],
};
export function patch(text, name) {
    const edits = MUT[name]; if (!edits) throw new Error("stage: b232 mutants: unknown " + name);
    for (const e of edits) {
        const n = text.split(e.from).length - 1;
        if (n !== e.count) throw new Error("stage: b232 mutants: " + name + ": anchor matched " + n + " times (want " + e.count + "): " + JSON.stringify(e.from.slice(0, 60)));
        if (e.nth) { let idx = -1; for (let k = 0; k < e.nth; k++) idx = text.indexOf(e.from, idx + 1); text = text.slice(0, idx) + e.to + text.slice(idx + e.from.length); }
        else text = text.split(e.from).join(e.to);
    }
    return text;
}
// stage a mutant tree (Signal.js + Watch.js) in os.tmpdir(); returns the Signal.js path
export function stageMutant(srcFile, text, name) {
    const out = patch(text, name);
    if (out === text) throw new Error("stage: b232 mutants: " + name + ": patch changed nothing");
    const dir = mkdtempSync(join(tmpdir(), "b232-" + name + "-"));
    writeFileSync(join(dir, "Signal.js"), out);
    copyFileSync(join(dirname(srcFile), "Watch.js"), join(dir, "Watch.js"));
    return join(dir, "Signal.js");
}
