/**
 * @zakkster/lite-signal soak -- seed derivation (port of lite-pick benchmark/soak/seeds.mjs:15-66).
 *
 * lite-pick once mixed `lane.name.length` into its seed, so lanes with equal-length names drew IDENTICAL
 * streams (L4). Here the seed derives from the lane INDEX through murmur3's fmix32, a BIJECTION on uint32.
 *
 * Exact property: for one base, distinct (laneIndex, cycle) give distinct seeds, with exactly ONE possible
 * exception, the remap pair. A seed of 0 is remapped to 0x9e3779b9, so the packed input p = base (whose
 * fmix32 is 0) and the packed input p = base ^ PRE (PRE = the fmix32 preimage of 0x9e3779b9) share a seed.
 * The pair exists in a run iff BOTH packed values lie in its domain: (p >>> 4) < cycles (a forever run uses
 * CYCLES_MAX) and (p & 15) < laneCount. remapCollision() decides that exactly in O(1) for any span, and the
 * header records it as DATA (seedRemapCollision), never a failure. selfCheckSeeds() only scans a finite span.
 *
 * worldSeed(cycleSeed, w) derives one seed per world inside a lane-cycle. Math.imul(w + 1, 0x9e3779b9) is
 * a bijection on uint32 (odd multiplier), XOR with cycleSeed is a bijection, and so is fmix32: the worlds
 * of one lane-cycle get distinct seeds by construction.
 *
 * COLD module: seeds are drawn once per lane-cycle and once per world, never on a hot path.
 */

/** murmur3 fmix32 finalizer: a bijective avalanche mix over uint32. */
export function fmix32(h) {
    h >>>= 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

// laneIndex < 16, so `(cycle << 4) | laneIndex` is injective over (laneIndex, cycle) while laneIndex stays
// in [0, 16). config.mjs ROSTER_MAX and selfCheckSeeds both enforce the bound.
const LANE_BITS = 4;
const LANE_MASK = (1 << LANE_BITS) - 1;
export const LANE_LIMIT = 1 << LANE_BITS;
// (cycle << 4) keeps only the low 28 bits of cycle, so cycles c and c + 2^28 would alias. Policy: the cycle
// index never wraps; seedFor throws at or past CYCLE_LIMIT, and config.mjs CYCLES_MAX equals it (a test pins
// the equality). A forever run ends at the cap instead of reusing seeds.
export const CYCLE_LIMIT = 2 ** (32 - LANE_BITS);
const REMAP = 0x9e3779b9;   // seed 0 -> this (a xorshift-style PRNG stuck at 0 stays 0)

function invOdd(a) {   // multiplicative inverse of an odd uint32 mod 2^32 (Newton; 5 steps double to 32 bits)
    let x = a >>> 0;
    for (let i = 0; i < 5; i++) x = Math.imul(x, 2 - Math.imul(a, x)) >>> 0;
    return x >>> 0;
}
const INV_C1 = invOdd(0x85ebca6b);
const INV_C2 = invOdd(0xc2b2ae35);

/** The inverse of fmix32 (exact; fmix32(unfmix32(x)) === x for every uint32 x). */
export function unfmix32(h) {
    h >>>= 0;
    h ^= h >>> 16;
    h = Math.imul(h, INV_C2) >>> 0;
    h ^= (h >>> 13) ^ (h >>> 26);
    h = Math.imul(h >>> 0, INV_C1) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
}

/** The packed input whose natural seed equals the remap value. */
export const REMAP_PREIMAGE = unfmix32(REMAP);

/**
 * The remap pair of a run, or null when it cannot occur. O(1), exact for ANY cycle span:
 *   cycles     the run's cycle count; 0 (forever) means every index below CYCLE_LIMIT
 *   laneCount  the roster size (lane INDEX space, not the selected subset)
 * Returns {cycleA, laneA, cycleB, laneB}: (laneA, cycleA) is the remapped one, (laneB, cycleB) the natural one.
 */
export function remapCollision(base, laneCount, cycles) {
    const span = cycles === 0 ? CYCLE_LIMIT : cycles;
    if (!(Number.isInteger(span) && span >= 1 && span <= CYCLE_LIMIT)) throw new RangeError('remapCollision: cycles ' + cycles + ' outside [0, ' + CYCLE_LIMIT + ']');
    if (!(Number.isInteger(laneCount) && laneCount >= 1 && laneCount <= LANE_LIMIT)) throw new RangeError('remapCollision: laneCount ' + laneCount + ' outside [1, ' + LANE_LIMIT + ']');
    const pA = base >>> 0;
    const pB = (pA ^ REMAP_PREIMAGE) >>> 0;
    const inDomain = (p) => (p >>> LANE_BITS) < span && (p & LANE_MASK) < laneCount;
    if (!inDomain(pA) || !inDomain(pB)) return null;
    return { cycleA: pA >>> LANE_BITS, laneA: pA & LANE_MASK, cycleB: pB >>> LANE_BITS, laneB: pB & LANE_MASK };
}

/** The seed for (base, laneIndex, cycle). Pure. Throws RangeError on an index that would alias. */
export function seedFor(base, laneIndex, cycle) {
    if (!(Number.isInteger(cycle) && cycle >= 0 && cycle < CYCLE_LIMIT)) throw new RangeError('seedFor: cycle ' + cycle + ' outside [0, ' + CYCLE_LIMIT + ')');
    if (!(Number.isInteger(laneIndex) && laneIndex >= 0 && laneIndex < LANE_LIMIT)) throw new RangeError('seedFor: laneIndex ' + laneIndex + ' outside [0, ' + LANE_LIMIT + ')');
    const input = ((base >>> 0) ^ (((cycle << LANE_BITS) | (laneIndex & LANE_MASK)) >>> 0)) >>> 0;
    const s = fmix32(input);
    return s === 0 ? REMAP : s;
}

/** The seed of world `w` (0-based) inside a lane-cycle. Pure. Distinct for w in [0, 2^32 - 1). */
export function worldSeed(cycleSeed, w) {
    if (!(Number.isInteger(w) && w >= 0 && w < 0xFFFFFFFF)) throw new RangeError('worldSeed: world ' + w + ' outside [0, 2^32 - 1)');
    const s = fmix32(((cycleSeed >>> 0) ^ (Math.imul(w + 1, 0x9e3779b9) >>> 0)) >>> 0);
    return s === 0 ? REMAP : s;
}

export const SEED_FORMULA = 'fmix32((base ^ ((cycle << 4) | laneIndex)) >>> 0); seed 0 -> 0x9e3779b9';
export const WORLD_SEED_FORMULA = 'fmix32((cycleSeed ^ Math.imul(world + 1, 0x9e3779b9)) >>> 0); seed 0 -> 0x9e3779b9';

/**
 * Startup self-check (L4): every (laneIndex, cycle) seed is DISTINCT for cycles 0..cycleSpan-1, and the
 * roster fits the 4-bit lane field. Returns null on success, else a description string (the caller exits 2).
 */
export function selfCheckSeeds(base, laneCount, cycleSpan) {
    if (!Number.isInteger(laneCount) || laneCount < 1 || laneCount > LANE_LIMIT) {
        return 'roster of ' + laneCount + ' lanes does not fit the ' + LANE_BITS + '-bit lane field (max ' + LANE_LIMIT + ')';
    }
    const span = cycleSpan === undefined ? 1024 : cycleSpan;
    if (!(Number.isInteger(span) && span >= 1 && span <= CYCLE_LIMIT)) return 'cycle span ' + span + ' outside [1, ' + CYCLE_LIMIT + ']';
    const seen = new Map();
    for (let cy = 0; cy < span; cy++) {
        for (let li = 0; li < laneCount; li++) {
            const s = seedFor(base, li, cy);
            const prev = seen.get(s);
            if (prev !== undefined) {
                return 'seed collision 0x' + s.toString(16) + ' at (lane ' + li + ', cycle ' + cy +
                    ') and (lane ' + (prev & LANE_MASK) + ', cycle ' + (prev >>> LANE_BITS) + ')';
            }
            seen.set(s, ((cy << LANE_BITS) | li) >>> 0);
        }
    }
    return null;
}

const WORLD_MUL = 0x9e3779b9;            // worldSeed's odd multiplier
const INV_WORLD_MUL = invOdd(WORLD_MUL);

/**
 * The world index w in [0, max) of lane-cycle (base, laneIndex, cycle) whose worldSeed equals `ws`, or -1
 * when no such world exists (replay.mjs: a key unreachable from SOAK_SEED exits 2). O(1), no scan: every
 * step of worldSeed is a bijection, so each candidate preimage is computed directly and then VERIFIED
 * forward (fail closed: a candidate is returned only when worldSeed(cycleSeed, w) === ws). The remap value
 * 0x9e3779b9 has two preimages (the natural one and the zero input); the smaller valid index wins, which
 * is the world a forward scan from 0 would meet first.
 *   lane  the roster INDEX (seeds never see names); max  the exclusive world bound, in [1, 2^32 - 1]
 */
export function findWorldIndex(base, lane, cycle, ws, max) {
    if (!(Number.isInteger(ws) && ws >= 0 && ws <= 0xFFFFFFFF)) throw new RangeError('findWorldIndex: world seed ' + ws + ' is not a uint32');
    if (!(Number.isInteger(max) && max >= 1 && max <= 0xFFFFFFFF)) throw new RangeError('findWorldIndex: max ' + max + ' outside [1, 2^32 - 1]');
    const cycleSeed = seedFor(base, lane, cycle);   // validates lane and cycle
    const inputs = ws === REMAP ? [REMAP_PREIMAGE, 0] : [unfmix32(ws)];
    let best = -1;
    for (const x of inputs) {
        const m = ((x ^ cycleSeed) >>> 0);          // = Math.imul(w + 1, WORLD_MUL) >>> 0
        const w1 = Math.imul(m, INV_WORLD_MUL) >>> 0;   // = w + 1 (mod 2^32)
        if (w1 === 0) continue;                     // w would be -1
        const w = w1 - 1;
        if (w >= max) continue;
        if (worldSeed(cycleSeed, w) !== ws) continue;
        if (best === -1 || w < best) best = w;
    }
    return best;
}
