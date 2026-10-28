/**
 * @zakkster/lite-signal soak -- the LANE ROSTER (SPEC-B v2 sections 5.1, 3.3).
 *
 * Each descriptor: { name, index, needsCaps, hardOracles, required, optional, scenCaps, mix, worldShape,
 * flushPasses, covOff, init(g), step(g) } (+ optional ops: { <op>: (exec, op, k) => void }, the lane-owned ops
 * exec.mjs apply() dispatches after its core ops). index is LANE_INDEX[name], a RESERVED literal (S3-D6, SPEC-B 5.3
 * order), never the roster position: seeds.mjs packs it into 4 bits, so a lane keeps its seeds, replay keys and
 * calibration rows whichever lanes are rostered before it. GRAPH 0 .. WIE 4 never move.
 */

import { GRAPH } from './graph.mjs';
import { BATCH } from './batch.mjs';
import { ERROR } from './error.mjs';
import { NEST } from './nest.mjs';
import { WIE } from './wie.mjs';
import { HOOK } from './hook.mjs';
import { LIFECYCLE } from './lifecycle.mjs';
import { OWNER } from './owner.mjs';
import { RECYCLE } from './recycle.mjs';
import { SCENARIOS } from '../scenarios.mjs';
import { LANE_LIMIT, remapCollision } from '../seeds.mjs';

/** Reserved lane indices (S3-D6). A lane lands in ROSTER in any order; its index never changes. */
export const LANE_INDEX = Object.freeze({
    GRAPH: 0, BATCH: 1, ERROR: 2, NEST: 3, WIE: 4, LIFECYCLE: 5, HOOK: 6, OWNER: 7, SCHEDULER: 8, BOX: 9, REGISTRY: 10,
    RECYCLE: 11, CAPACITY: 12, SNAPSHOT: 13,
});

/**
 * Fail closed on an index table seeds.mjs cannot pack: a roster name with no entry, a value that is not an integer
 * in [0, LANE_LIMIT), or two names sharing a value (their seeds would alias). Runs at import (below); exported so
 * test/74 can show each case throws.
 */
export function checkLaneIndex(table, roster) {
    for (const name of roster) {
        if (!Object.hasOwn(table, name)) throw new Error('lanes/index: roster lane ' + name + ' has no LANE_INDEX entry');
    }
    const seen = new Map();
    for (const name of Object.keys(table)) {
        const v = table[name];
        if (!(Number.isInteger(v) && v >= 0 && v < LANE_LIMIT)) throw new RangeError('lanes/index: LANE_INDEX.' + name + ' = ' + v + ' outside [0, ' + LANE_LIMIT + ')');
        if (seen.has(v)) throw new Error('lanes/index: LANE_INDEX.' + name + ' = ' + v + ' duplicates ' + seen.get(v));
        seen.set(v, name);
    }
}

// HOOK (index 6) landed S3 R1; LIFECYCLE (index 5) S3 R2 (b111), OWNER (index 7) R3 (b126) and RECYCLE (index 11)
// R4a (b130) are appended last, so the span is 12 (laneSpan: max LANE_INDEX + 1)
export const ROSTER = Object.freeze(['GRAPH', 'BATCH', 'ERROR', 'NEST', 'WIE', 'HOOK', 'LIFECYCLE', 'OWNER', 'RECYCLE']);
const BY_NAME = { GRAPH, BATCH, ERROR, NEST, WIE, HOOK, LIFECYCLE, OWNER, RECYCLE };
checkLaneIndex(LANE_INDEX, ROSTER);

/**
 * The lane INDEX span of a roster: max LANE_INDEX + 1 over its names (S3 R1). Seeds pack the index, not the roster
 * position, so a roster [GRAPH .. WIE, HOOK] spans 7 indices with 6 lanes; every seed-domain check uses the span. An
 * empty roster or a name with no LANE_INDEX entry throws (fail closed; the domain would be unknown).
 */
export function laneSpan(roster) {
    if (!Array.isArray(roster) || roster.length === 0) throw new TypeError('laneSpan: roster must be a non-empty array of lane names');
    let max = -1;
    for (const name of roster) {
        if (!Object.hasOwn(LANE_INDEX, name)) throw new Error('laneSpan: roster lane ' + name + ' has no LANE_INDEX entry');
        if (LANE_INDEX[name] > max) max = LANE_INDEX[name];
    }
    return max + 1;
}

/**
 * The remap pair of a run over `roster` (seeds.mjs remapCollision over laneSpan(roster)), returned only when BOTH
 * laneA and laneB are rostered indices, else null: an index inside the span that no rostered lane holds never draws
 * a seed. Exact, O(roster).
 */
export function rosterRemapCollision(base, roster, cycles) {
    const hit = remapCollision(base, laneSpan(roster), cycles);
    if (hit === null) return null;
    let a = false;
    let b = false;
    for (const name of roster) {
        if (LANE_INDEX[name] === hit.laneA) a = true;
        if (LANE_INDEX[name] === hit.laneB) b = true;
    }
    return a && b ? hit : null;
}

export const LANES = Object.freeze(ROSTER.map((name) => Object.freeze(Object.assign({}, BY_NAME[name], { index: LANE_INDEX[name] }))));

export function laneByName(name) {
    const i = ROSTER.indexOf(name);
    return i === -1 ? null : LANES[i];
}

/** Every scenario id any roster lane can count (config.mjs validates cov-off against it). */
export const ALL_SCENARIOS = SCENARIOS;

/** Scenarios whose cov-off switch is implemented, lane -> [scenario]. */
export const COV_OFF_SUPPORTED = Object.freeze(Object.fromEntries(LANES.map((d) => [d.name, Object.keys(d.covOff)])));

/** Is world w of a lane-cycle LARGE (GRAPH: 1 in LARGE_WORLD_EVERY)? Deterministic from the index. */
export function isLargeWorld(desc, w, every) {
    const e = every === undefined ? desc.worldShape.largeEvery : every;
    return e > 0 && (w % e) === e - 1;
}
