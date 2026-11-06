// bench/torture/helpers/surface.mjs -- the engine surface Signal.d.ts DECLARES, as a floor key.
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT License
//
// WHY. run.mjs escalates a floor-77 skip to FAIL only when the engine is AT or ABOVE the
// scenario's floor. package.json's version stays at the last release for a whole dev cycle
// (1.5.2 while 1.6.0 is built), so a 1.6.0-floor scenario whose export was dropped would skip
// GREEN for the entire cycle. The declarations file moves with the code: once Signal.d.ts
// declares reset() / snapshot() / restore(), the 1.6.0 floors apply, whatever package.json says.
// run.mjs uses max(package.json key, declaredKey(Signal.d.ts)).
//
// Cold path, run once per torture run. No engine import (the runner must never load the
// engine it is judging into its own process).

/** Each row: a version and the declaration markers (plain substrings) that ALL must be
 *  present for the file to declare that version's surface. Highest matching row wins. */
export const SURFACE_MARKERS = [
    { version: "1.5.0", markers: ["signalBox", "computedBox", "getOwner(): Owner;"] },
    { version: "1.6.0", markers: ["reset(): void;", "snapshot(): Snapshot;", "restore(snap: Snapshot"] },
];

/** major.minor.patch -> comparable number (prerelease tags ignored); -1 when unreadable.
 *  Same encoding as run.mjs versionKey. */
export function surfaceVersionKey(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof v === "string" ? v : "");
    if (!m) return -1;
    return (+m[1]) * 1e6 + (+m[2]) * 1e3 + (+m[3]);
}

/** declaredKey(dtsText) -> the version key of the highest SURFACE_MARKERS row whose markers
 *  all occur in dtsText; 0 when no row matches; -1 when dtsText is not a string (fail closed:
 *  the caller must treat -1 as "cannot derive the surface", never as "no floor"). */
export function declaredKey(dtsText) {
    if (typeof dtsText !== "string") return -1;
    let best = 0;
    for (let i = 0; i < SURFACE_MARKERS.length; i++) {
        const row = SURFACE_MARKERS[i];
        let all = true;
        for (let j = 0; j < row.markers.length; j++) {
            if (!dtsText.includes(row.markers[j])) { all = false; break; }
        }
        if (all) {
            const k = surfaceVersionKey(row.version);
            if (k > best) best = k;
        }
    }
    return best;
}
