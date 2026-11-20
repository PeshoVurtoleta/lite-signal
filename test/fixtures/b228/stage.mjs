// stage.mjs -- b230 U3 B1: count-checked engine patcher + loader (the test/123 pattern: a temp copy in os.tmpdir(), a dynamic
// import; Signal.js on the package path is never touched). EVERY replacement is count-checked: a count != 1 THROWS, so the row
// that asked for the patch FAILS (never skips). The controls below patch the CODED text (29731ff9); on any other text an anchor
// that does not match exactly once is a FAIL by design.
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export function rep1(text, a, b, what) {
    const n = text.split(a).length - 1;
    if (n !== 1) throw new Error("stage: " + what + ": anchor matched " + n + " times (want exactly 1): " + JSON.stringify(a.slice(0, 80)));
    return text.split(a).join(b);
}
// Counter hooks (every row builds with them; hw / pins / unpins are part of the pinned tuples). Observation only: each hook is a
// call placed after an existing statement, never changing a branch. hw = max length of pinnedHead + scopePinHead (walked on each
// pin event); pins = disposeNode pin events (running -> pinnedHead, scope-owned -> scopePinHead); unpins = unpinOwn removals
// from pinnedHead (free or move to the scope list). The before build has no scopePinHead / unpinOwn: its tuple has hw / pins only.
export function withHooks(text) {
    const coded = text.includes("function unpinOwn(");
    let t = rep1(text, "            pinnedHead = node;\n", "            pinnedHead = node; globalThis.__B230.pin(pinnedHead, " + (coded ? "scopePinHead" : "null") + ");\n", "hook pinnedHead = node");
    if (coded) {
        t = rep1(t, "            scopePinHead = node;\n", "            scopePinHead = node; globalThis.__B230.pin(pinnedHead, scopePinHead);\n", "hook scopePinHead = node");
        t = rep1(t, "        if (p === null) pinnedHead = n.nextFree; else p.nextFree = n.nextFree;\n        if (so) {", "        if (p === null) pinnedHead = n.nextFree; else p.nextFree = n.nextFree;\n        globalThis.__B230.unpins++;\n        if (so) {", "hook unpinOwn removal");
    }
    return t;
}
const len = (n) => { let k = 0; for (; n !== null; n = n.nextFree) k++; return k; };
globalThis.__B230 = { pins: 0, unpins: 0, hw: 0, hit: {}, pin(a, b) { this.pins++; const k = len(a) + len(b); if (k > this.hw) this.hw = k; } };

// ---- controls (each a function text -> text; patch applied to the coded build, then withHooks) ----
const HIT = (n) => "globalThis.__B230.hit." + n + "++;";
const L = {
    // Each control DROPS one statement of the coded build and puts a hit counter (globalThis.__B230.hit.NAME) in its place, so a
    // row can assert the dropped statement was reached (a plant with no reach row is void). CTLX-NOLOOP / CTLX-NOPAIR drop a
    // condition clause (no counter possible): their reach rows are B2's (test/125 A-L34, zEarly / yEarly 8/8).
    // disposeNode's flushCur null (H3 R0c)
    CTLR0c: (t) => rep1(t, "if (node === flushCur) flushCur = null;", "if (node === flushCur) " + HIT("CTLR0c"), "CTLR0c flushCur null"),
    // severStale's gen-moved release (H1 R7a)
    CTLR7: (t) => rep1(t, "} else unpinOwn(node);   // R7a (F-b224-1)", "} else { " + HIT("CTLR7") + " }   // R7a (F-b224-1)", "CTLR7 H1 unpinOwn"),
    // disposeOwned loop gen test (H6) / disposeNode pair gen test (H2)
    "CTLX-NOLOOP": (t) => rep1(t, "while (node.gen === g && (child = node.firstOwned) !== null) {", "while ((child = node.firstOwned) !== null) {", "CTLX-NOLOOP H6"),
    "CTLX-NOPAIR": (t) => rep1(t, "if (node.gen === g && node.cleanupFn !== undefined) runOwnCleanup(node);", "if (node.cleanupFn !== undefined) runOwnCleanup(node);", "CTLX-NOPAIR H2"),
    // rerunCleanupEffect's catch armDepth-- (H9)
    CTLR1D: (t) => rep1(t, "            runCleanup(node);\n        } catch (err) {\n            armDepth--;   // R1bNZ: throw exit\n            if (node.gen === g) {\n                node.flags &= ~(FLAG_COMPUTING | FLAG_STALE_READ);",
        "            runCleanup(node);\n        } catch (err) {\n            " + HIT("CTLR1D") + "\n            if (node.gen === g) {\n                node.flags &= ~(FLAG_COMPUTING | FLAG_STALE_READ);", "CTLR1D H9 catch decrement"),
    // one arm family's armDepth++ (FE = firstRunCleanupE, FC = firstRunCleanupC, RE = rerunCleanupEffect, RC = rerunCleanupComputed)
    CTLR1FE: (t) => rep1(t, "            armDepth++;   // R1bNZ: a cleanup arm runs; releasePinned refuses until it exits\n            errs = drainPreRun(node);\n        } catch (e) { armDepth--; node.flags &= ~FLAG_COMPUTING; throw e; }   // R1bNZ: throw exit\n        armDepth--;   // R1bNZ: normal exit\n        if (node.gen !== g) unpinOwn(node);",
        "            " + HIT("CTLR1FE") + "\n            errs = drainPreRun(node);\n        } catch (e) { armDepth--; node.flags &= ~FLAG_COMPUTING; throw e; }   // R1bNZ: throw exit\n        armDepth--;   // R1bNZ: normal exit\n        if (node.gen !== g) unpinOwn(node);", "CTLR1FE"),
    CTLR1FC: (t) => rep1(t, "            armDepth++;   // R1bNZ: a cleanup arm runs; releasePinned refuses until it exits\n            errs = drainPreRun(node);\n        } catch (e) { armDepth--; node.flags &= ~FLAG_COMPUTING; throw e; }   // R1bNZ: throw exit\n        armDepth--;   // R1bNZ: normal exit\n        if (node.gen !== g) { unpinOwn(node); return true; }",
        "            " + HIT("CTLR1FC") + "\n            errs = drainPreRun(node);\n        } catch (e) { armDepth--; node.flags &= ~FLAG_COMPUTING; throw e; }   // R1bNZ: throw exit\n        armDepth--;   // R1bNZ: normal exit\n        if (node.gen !== g) { unpinOwn(node); return true; }", "CTLR1FC"),
    CTLR1RE: (t) => rep1(t, "            armDepth++;   // R1bNZ: a cleanup arm runs; releasePinned refuses until it exits\n            runCleanup(node);\n        } catch (err) {\n            armDepth--;   // R1bNZ: throw exit\n            if (node.gen === g) {\n                node.flags &= ~(FLAG_COMPUTING | FLAG_STALE_READ);",
        "            " + HIT("CTLR1RE") + "\n            runCleanup(node);\n        } catch (err) {\n            armDepth--;   // R1bNZ: throw exit\n            if (node.gen === g) {\n                node.flags &= ~(FLAG_COMPUTING | FLAG_STALE_READ);", "CTLR1RE"),
    CTLR1RC: (t) => rep1(t, "            armDepth++;   // R1bNZ: a cleanup arm runs; releasePinned refuses until it exits\n            runCleanup(node);\n        } catch (err) {\n            armDepth--;   // R1bNZ: throw exit\n            if (node.gen === g) {\n                // S1 (ARG-E2 F1)",
        "            " + HIT("CTLR1RC") + "\n            runCleanup(node);\n        } catch (err) {\n            armDepth--;   // R1bNZ: throw exit\n            if (node.gen === g) {\n                // S1 (ARG-E2 F1)", "CTLR1RC"),
    // SG2: runWithOwner finally's unpinScope call (H18) / nodeMiss's scopePinHead clause (H4) / reset's scopePinHead null (H19)
    SNOCALL: (t) => rep1(t, "if (scoped && node.flags === 0) unpinScope(node);", "if (scoped && node.flags === 0) " + HIT("SNOCALL"), "SNOCALL H18 call"),
    noH4: (t) => rep1(t, "if ((pinnedHead !== null || scopePinHead !== null) && cursorDepth === 0 && releasePinned())", "if ((pinnedHead !== null || (scopePinHead !== null && (globalThis.__B230.hit.noH4++, false))) && cursorDepth === 0 && releasePinned())", "noH4 nodeMiss guard"),
    noH19: (t) => rep1(t, "scopePinHead = null;   // SG2: scope pins likewise", "if (scopePinHead !== null) " + HIT("noH19") + "   // SG2 (dropped)", "noH19 reset scopePinHead"),
};
export const CONTROLS = Object.keys(L);
for (const c of CONTROLS) globalThis.__B230.hit[c] = 0;
export const hits = () => ({ ...globalThis.__B230.hit });
let seq = 0;
// name = "" (plain engine) or "A" / "A+B" (controls applied in order). Returns the loaded module of a staged temp copy.
export async function loadEngine(srcFile, name) {
    let text = readFileSync(srcFile, "utf8");
    if (name) for (const c of name.split("+")) { if (!L[c]) throw new Error("stage: unknown control " + c); text = L[c](text); }
    text = withHooks(text);
    const dir = mkdtempSync(join(tmpdir(), "b230-"));
    writeFileSync(join(dir, "Signal.js"), text);
    copyFileSync(join(dirname(srcFile), "Watch.js"), join(dir, "Watch.js"));
    return import(pathToFileURL(join(dir, "Signal.js")).href + "?b230=" + (seq++));   // a load failure rejects -> the row FAILS
}
