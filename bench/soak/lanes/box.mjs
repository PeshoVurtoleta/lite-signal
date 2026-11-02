/**
 * BOX lane (R7 group B task 3, burst 148; PLAN-R7-box.md C-3, C-4): the callable-vs-box TWIN lane. A BOX world is
 * one GRAPH / BATCH / ERROR / NEST / WIE world (1/5 each, C-4: ERROR stays in the mix while DIV-F22 is open), run by
 * twin.mjs runWorldTwin on the engine AND its contract.mjs TWINS twin (lite -> lite-box/alt), judged by the OT trace
 * oracle. No ops of its own: init / step delegate to the picked sub-lane descriptor (imports only, no copied rules).
 *
 * PICK: init(g) picks the sub-lane from the world seed (g.seed % 5, GRAPH, BATCH, ERROR, NEST, WIE), drawing NOTHING
 * from the generator's stream, so a BOX world replays its sub-lane's generator rules on the same seed (only the
 * script's lane name is 'BOX'). The pick lives in a module WeakMap keyed by g (dies with the generator); step(g)
 * before init(g) throws (fail closed). The sub-lane's init sets g.flushPasses itself (ERROR: 8; others leave null).
 *
 * Descriptor (lanes/index.mjs keys): twin true (contract.mjs applicability skips it with missingCaps ['twin'] on an
 * engine with no TWINS entry); hardOracles ['OT']; required = the two twin detectors; optional = every sub-lane
 * required + optional scenario (counted, never required); scenCaps = the sub-lanes' merged; needsCaps = the union of
 * the sub-lanes'; mix = the sub-lane weights; worldShape.largeEvery 0 (no LARGE world: trace memory, PLAN RISK);
 * flushPasses null (per sub-lane, set by its init); covOff {} (no cov-off switch: the must-fail control is the
 * adapter's {broken: 'box-untracked'}, C-7 / C-13). NOT rostered until group C (lanes/index.mjs ROSTER, LANE_INDEX 9).
 */

import { GRAPH } from './graph.mjs';
import { BATCH } from './batch.mjs';
import { ERROR } from './error.mjs';
import { NEST } from './nest.mjs';
import { WIE } from './wie.mjs';

const SUBS = Object.freeze([GRAPH, BATCH, ERROR, NEST, WIE]);
const PICK = new WeakMap();

function init(g) {
    const sub = SUBS[(g.seed >>> 0) % SUBS.length];
    PICK.set(g, sub);
    sub.init(g);
}

function step(g) {
    const sub = PICK.get(g);
    if (sub === undefined) throw new Error('lanes/box: step(g) before init(g)');
    sub.step(g);
}

function union(lists) {
    const out = [];
    for (const l of lists) for (const x of l) if (out.indexOf(x) === -1) out.push(x);
    return Object.freeze(out);
}

const SCEN_CAPS = {};
for (const d of SUBS) for (const s of Object.keys(d.scenCaps)) SCEN_CAPS[s] = d.scenCaps[s];

export const BOX = Object.freeze({
    name: 'BOX',
    twin: true,
    needsCaps: union(SUBS.map((d) => d.needsCaps)),
    hardOracles: Object.freeze(['OT']),
    required: Object.freeze(['box-trace-equal', 'box-interop']),
    optional: union(SUBS.map((d) => d.required.concat(d.optional))),
    scenCaps: Object.freeze(SCEN_CAPS),
    mix: Object.freeze({ GRAPH: 1, BATCH: 1, ERROR: 1, NEST: 1, WIE: 1 }),
    worldShape: Object.freeze({ steps: 400, largeEvery: 0, normal: 'one GRAPH / BATCH / ERROR / NEST / WIE normal world (1/5 each by seed), on the engine and its twin' }),
    flushPasses: null,
    covOff: Object.freeze({}),
    init,
    step,
});
