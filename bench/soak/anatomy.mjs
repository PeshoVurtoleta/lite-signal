/**
 * @zakkster/lite-signal soak -- the REPORT-ONLY anatomy lane (S2 group B, B-B4b; PLAN-0s-bb4b SPEC / TASKS 2-3).
 *
 * The visit-anatomy counters (harness/visit-anchors.mjs NAMES: cursorHit .. depWalk, 12 slots) for the soak's own
 * worlds. openAnatomy() instruments the RESOLVED kernel source (kernel.mjs KERNEL_FILES[0]: the tree, SOAK_KERNEL or
 * the SOAK_NEARWRAP-derived file) and imports it as a second, SHADOW engine; on worlds w % SHAPE_EVERY === 0 main
 * re-runs a freshly generated copy of the world's script through runWorld on that engine and the lane folds the
 * shadow's counters into the cycle. It gates nothing: gates.mjs lists 'anatomy' in REPORT_ONLY_GATES (B2).
 *
 *   const { lane, why } = openAnatomy({ source }?)       SYNCHRONOUS (see the load note below)
 *                              never throws for an UNAVAILABLE lane: lane null + why (one line). source (test seam):
 *                              an engine source string used instead of the kernel file. A bad option throws TypeError.
 *   lane.adapter               the shadow adapter (adapters/lite.mjs liteAdapterFor(K'); name 'lite', base knownAs)
 *   lane.vc                    the shadow engine's Int32Array(16) counter block (globalThis.__VISIT__, captured, then
 *                                deleted from globalThis)
 *   lane.dir                   the temp dir the instrumented copy was imported from (already removed)
 *   lane.shape(ad, script, r)  one shape world: ad = the (tapped) shadow adapter, script = a FRESH generateWorld()
 *                                of the same (desc, ws, opts), r = the oracle world's runWorld result
 *   lane.reset()               clear the cycle (once per lane-cycle); a disabled lane stays disabled
 *   lane.why                   null, or why toJSON() is null this cycle (one line)
 *   lane.toJSON() -> { worlds, counts: { <NAMES> }, markDedupe } | null
 *
 * shape(): vc.fill(0) BEFORE and AFTER the shadow run (a world never sees another world's counts, and nothing a
 * non-shape world does is ever folded). The shadow run is compared with the oracle's r:
 *   - both failed                      -> skipped (not folded; nothing to compare)
 *   - exactly one failed (EITHER way, D2) or ops differ -> DIVERGENT: the cycle reads null (why /divergent/)
 *   - the shadow threw                 -> null + the lane DISABLED for the rest of the run (why /shadow threw/)
 *   - a slot < 0 or >= 2^30            -> OVERFLOW: the cycle reads null (why /overflow/); nothing folded
 * After a cycle turns null the remaining shape worlds of that cycle are not run (the cycle cannot recover).
 *
 * toJSON(): null on a disabled lane, a divergent or overflowed cycle, or 0 folded worlds (null is not zero).
 * counts are exact integers (Float64Array accumulators, < 2^53). markDedupe = markStamp / markEdge, or null when
 * markEdge is 0 (never NaN: JSON would turn NaN into null with no reason).
 *
 * Allocation: foldCounts() is a plain typed-array loop (Int32Array -> Float64Array) that returns a boolean: 0 B per
 * call. Everything else is cold (once per run or once per shape world).
 *
 * The instrumented copy is written to a fresh mkdtempSync dir as Signal.mjs (an explicit ESM extension: the temp
 * dir has no package.json), loaded ONCE through require(esm) (createRequire; the engine has no top-level await), and
 * the dir is removed in a finally -- synchronous, so main opens the lane in line and a test needs no await. A Node
 * without require(esm) (< 20.19 / 22.12) fails the load: lane null + why, never a throw. instrument() refuses any
 * module reference, so the copy needs no sibling Watch.js (its re-export is stripped; visit-anchors.mjs EDITS).
 *
 * COLD module: main.mjs (B2) imports it dynamically; replay.mjs and shrink.mjs never do.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { NAMES, I, instrument } from '../../harness/visit-anchors.mjs';
import { KERNEL_FILES } from './kernel.mjs';
import { liteAdapterFor } from './adapters/lite.mjs';
import { runWorld } from './exec.mjs';
import { nearest } from './config.mjs';

/** The counter block every instrumented engine installs (visit-anchors.mjs EDITS[0]: new Int32Array(16)). */
export const VC_LENGTH = 16;
/** Per-world slot ceiling: a slot at or past it (or negative) is OVERFLOW, never folded (zero-box law: < 2^30). */
export const SLOT_MAX = 0x40000000;

const N = NAMES.length;
const STAMP = I.markStamp;
const EDGE = I.markEdge;
const OPT_KEYS = Object.freeze(['source']);
const requireEsm = createRequire(import.meta.url);

/** First line of an error message (every why is ONE line). */
function line(e) {
    return String(e && e.message !== undefined ? e.message : e).split('\n')[0];
}

function isPlainObject(o) {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return false;
    const p = Object.getPrototypeOf(o);
    return p === Object.prototype || p === null;
}

/**
 * Fold one world's counters into the cycle: A[i] += VC[i] for i < A.length. Returns true (and writes NOTHING) when
 * any slot is < 0 or >= SLOT_MAX -- the read-only scan runs before the first write. 0 B per call.
 */
export function foldCounts(VC, A) {
    if (!(VC instanceof Int32Array) || !(A instanceof Float64Array) || VC.length < A.length) {
        throw new TypeError('anatomy: foldCounts(VC, A) needs an Int32Array VC and a Float64Array A no longer than VC');
    }
    const n = A.length;
    for (let i = 0; i < n; i++) {
        const v = VC[i];
        if (v < 0 || v >= SLOT_MAX) return true;
    }
    for (let i = 0; i < n; i++) A[i] += VC[i];
    return false;
}

export class AnatomyLane {
    #adapter;
    #vc;
    #dir;
    #A = new Float64Array(N);
    #worlds = 0;
    #skipped = 0;
    #why = null;        // the current cycle's reason (null = healthy so far)
    #disabled = null;   // the run-long reason once the shadow threw (survives reset)

    /** adapter: the shadow adapter; vc: its engine's Int32Array(VC_LENGTH); dir: the (removed) import dir or null. */
    constructor(adapter, vc, dir) {
        if (adapter === null || typeof adapter !== 'object' || typeof adapter.open !== 'function') {
            throw new TypeError('anatomy: AnatomyLane(adapter, vc, dir) needs an adapter with open()');
        }
        if (!(vc instanceof Int32Array) || vc.length !== VC_LENGTH) {
            throw new TypeError('anatomy: AnatomyLane vc must be an Int32Array(' + VC_LENGTH + ')');
        }
        if (dir !== null && typeof dir !== 'string') throw new TypeError('anatomy: AnatomyLane dir must be a string or null');
        this.#adapter = adapter;
        this.#vc = vc;
        this.#dir = dir;
        Object.seal(this);
    }

    get adapter() { return this.#adapter; }

    get vc() { return this.#vc; }

    get dir() { return this.#dir; }

    /** null, or why toJSON() reads null this cycle. */
    get why() {
        if (this.#disabled !== null) return this.#disabled;
        if (this.#why !== null) return this.#why;
        if (this.#worlds === 0) {
            return this.#skipped === 0
                ? 'no shape world this cycle'
                : 'no shape world folded (' + this.#skipped + ' skipped: oracle and shadow both failed)';
        }
        return null;
    }

    /** Clear the cycle. A lane disabled by a shadow throw stays disabled for the run. */
    reset() {
        this.#A.fill(0);
        this.#worlds = 0;
        this.#skipped = 0;
        this.#why = null;
    }

    /**
     * One shape world. r: the ORACLE world's runWorld result ({failure, ops}); checked before any state is touched.
     * Never throws for a shadow failure (that is the lane's verdict, recorded in why).
     */
    shape(ad, script, r) {
        if (r === null || typeof r !== 'object' || !Object.hasOwn(r, 'failure') || typeof r.ops !== 'number') {
            throw new TypeError('anatomy: shape(ad, script, r) needs the oracle runWorld result r');
        }
        if (this.#disabled !== null || this.#why !== null) return;
        const VC = this.#vc;
        VC.fill(0);
        let s;
        try {
            s = runWorld(ad, script);
        } catch (e) {
            VC.fill(0);
            this.#disabled = 'shadow threw: ' + line(e) + ' (lane disabled for the run)';
            return;
        }
        const of = r.failure !== null;
        const sf = s.failure !== null;
        if (of && sf) {
            VC.fill(0);
            this.#skipped++;
            return;
        }
        if (of !== sf || s.ops !== r.ops) {
            VC.fill(0);
            this.#why = 'divergent: oracle ' + (of ? 'failed' : 'passed') + ' ops=' + r.ops +
                ', shadow ' + (sf ? 'failed' : 'passed') + ' ops=' + s.ops;
            return;
        }
        if (foldCounts(VC, this.#A)) {
            let k = 0;
            while (k < N && VC[k] >= 0 && VC[k] < SLOT_MAX) k++;
            this.#why = 'overflow: ' + NAMES[k] + '=' + VC[k] + ' in one world (slot range [0, 2^30))';
            VC.fill(0);
            return;
        }
        VC.fill(0);
        this.#worlds++;
    }

    /** { worlds, counts: { <NAMES> }, markDedupe } or null (see why). COLD. */
    toJSON() {
        if (this.why !== null) return null;
        const A = this.#A;
        const counts = {};
        for (let i = 0; i < N; i++) counts[NAMES[i]] = A[i];
        return { worlds: this.#worlds, counts, markDedupe: A[EDGE] === 0 ? null : A[STAMP] / A[EDGE] };
    }
}

/**
 * Build the anatomy lane over the resolved kernel (or `source`). Never throws for an unavailable lane: returns
 * { lane: null, why } -- kernel file changed since load, globalThis.__VISIT__ already taken, anchor drift, import
 * failure, a missing / wrong counter block, no createRegistry. A bad opts value throws TypeError (caller bug).
 */
export function openAnatomy(opts) {
    if (opts !== undefined) {
        if (!isPlainObject(opts)) throw new TypeError('anatomy: openAnatomy(opts) needs a plain object { source? }');
        if (Object.getOwnPropertySymbols(opts).length !== 0) throw new TypeError('anatomy: openAnatomy options take no Symbol keys');
        for (const k of Object.keys(opts)) {
            if (OPT_KEYS.indexOf(k) === -1) {
                const h = nearest(k, OPT_KEYS);
                throw new TypeError("anatomy: unknown option '" + k + "'" + (h === null ? ' (known: source)' : ' (did you mean ' + h + '?)'));
            }
        }
        if (Object.hasOwn(opts, 'source') && opts.source !== undefined && typeof opts.source !== 'string') {
            throw new TypeError('anatomy: openAnatomy source must be the engine source as a string');
        }
    }
    const fail = (why) => ({ lane: null, why: 'anatomy UNAVAILABLE: ' + why });
    if (globalThis.__VISIT__ !== undefined) return fail('globalThis.__VISIT__ is already defined (another instrumented engine is loaded)');
    let src;
    // own key only: an inherited Object.prototype.source is not an option (an explicit source: undefined = absent)
    if (opts !== undefined && Object.hasOwn(opts, 'source') && opts.source !== undefined) {
        src = opts.source;
    } else {
        const kf = KERNEL_FILES[0];
        let bytes;
        try { bytes = readFileSync(kf.path); } catch (e) { return fail('cannot re-read the kernel ' + kf.path + ': ' + line(e)); }
        const sha = createHash('sha256').update(bytes).digest('hex');
        if (sha !== kf.sha256) return fail('kernel ' + kf.path + ' changed since load (sha256 ' + sha + ', loaded ' + kf.sha256 + ')');
        src = bytes.toString('utf8');
    }
    let gen;
    try {
        gen = instrument(src);
    } catch (e) {
        return fail(line(e) + (Array.isArray(e && e.drift) ? ': ' + e.drift.join('; ') : ''));
    }
    let dir = null, mod, vc, loadFailed = false, loadErr, rmFailed = false, rmErr;
    try {
        dir = mkdtempSync(join(tmpdir(), 'soak-anatomy-'));
        const p = join(dir, 'Signal.mjs');
        writeFileSync(p, gen);
        mod = requireEsm(p);
    } catch (e) {
        loadFailed = true;
        loadErr = e;
    } finally {
        vc = globalThis.__VISIT__;
        delete globalThis.__VISIT__;
        // a throwing rmSync must not escape openAnatomy (main.mjs does not catch it): it is an UNAVAILABLE lane
        if (dir !== null) {
            try { rmSync(dir, { recursive: true, force: true }); } catch (e) { rmFailed = true; rmErr = e; }
        }
    }
    const rmWhy = rmFailed ? 'cannot remove ' + dir + ': ' + line(rmErr) : null;
    if (loadFailed) return fail('the instrumented kernel failed to load: ' + line(loadErr) + (rmWhy === null ? '' : '; ' + rmWhy));
    if (rmWhy !== null) return fail(rmWhy);
    if (!(vc instanceof Int32Array) || vc.length !== VC_LENGTH) {
        return fail('the instrumented kernel did not install an Int32Array(' + VC_LENGTH + ') counter block');
    }
    if (mod === null || typeof mod !== 'object' || typeof mod.createRegistry !== 'function') {
        return fail('the instrumented kernel does not export createRegistry()');
    }
    return { lane: new AnatomyLane(liteAdapterFor(mod), vc, dir), why: null };
}
