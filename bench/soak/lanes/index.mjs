/**
 * @zakkster/lite-signal soak -- the LANE ROSTER (SPEC-B v2 sections 5.1, 3.3).
 *
 * Each descriptor: { name, index, needsCaps, hardOracles, required, optional, scenCaps, mix, worldShape,
 * flushPasses, covOff, init(g), step(g) }. index is the roster position (seeds.mjs packs it into 4 bits).
 * S3 appends LIFECYCLE, HOOK, OWNER, SCHEDULER, BOX, REGISTRY, RECYCLE, CAPACITY, SNAPSHOT.
 */

import { GRAPH } from './graph.mjs';
import { BATCH } from './batch.mjs';
import { ERROR } from './error.mjs';
import { NEST } from './nest.mjs';
import { SCENARIOS } from '../scenarios.mjs';

export const ROSTER = Object.freeze(['GRAPH', 'BATCH', 'ERROR', 'NEST']);
const BY_NAME = { GRAPH, BATCH, ERROR, NEST };

export const LANES = Object.freeze(ROSTER.map((name, index) => Object.freeze(Object.assign({}, BY_NAME[name], { index }))));

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
