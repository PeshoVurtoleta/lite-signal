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
import { SCENARIOS } from '../scenarios.mjs';
import { LANE_LIMIT } from '../seeds.mjs';

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

export const ROSTER = Object.freeze(['GRAPH', 'BATCH', 'ERROR', 'NEST', 'WIE']);
const BY_NAME = { GRAPH, BATCH, ERROR, NEST, WIE };
checkLaneIndex(LANE_INDEX, ROSTER);

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
