/**
 * @zakkster/lite-signal soak -- the engine-agnostic ADAPTER CONTRACT (SPEC-B v2 sections 3.2-3.3, D6).
 *
 *   adapter = { name, version(), files(), caps, open(opts) -> world }
 *   world   = { signal(v, opts?), set(h, v), read(h), peek(h), computed(fn), effect(fn) -> stop, batch(fn),
 *               untrack(fn), dispose(h), settle(), stats(), links(), lifecycle(h, {onConnect, onDisconnect})
 *               -> off, normalizeEscape(err), close() -> {nodes, links} | null }
 *
 * CAPS is a frozen key list; every adapter declares EVERY key with an allowed value, or validateAdapter
 * reports it (main.mjs exits 2). applicability() decides, per lane, RUN or SKIP, the oracles that are n/a
 * and the scenarios that are n/a. engine=lite must SKIP nothing (a SKIP on lite is a roster bug).
 *
 * COLD module.
 */

/** cap -> allowed values. */
export const CAPS = Object.freeze({
    effects: Object.freeze(['sync', 'drain']),
    batch: Object.freeze(['native', 'deferred-drain', 'no']),
    untrack: Object.freeze([true, false]),
    disposeSignal: Object.freeze([true, false]),
    disposeComputed: Object.freeze([true, false]),
    stopEffect: Object.freeze([true, false]),
    childEffects: Object.freeze(['parent-run', 'no']),
    effectErrors: Object.freeze(['aggregate', 'propagate', 'adapter-collected']),
    equality: Object.freeze(['is', '===']),
    links: Object.freeze(['stats', 'introspect', 'no']),
    lifecycle: Object.freeze(['register', 'options', 'no']),
    hook: Object.freeze([true, false]),
    scheduler: Object.freeze([true, false]),
    owner: Object.freeze([true, false]),
    destroy: Object.freeze([true, false]),
    recycle: Object.freeze([true, false]),
    counters32: Object.freeze([true, false]),
    capacity: Object.freeze([true, false]),
    box: Object.freeze([true, false]),
    snapshot: Object.freeze([true, false]),
});
export const CAP_KEYS = Object.freeze(Object.keys(CAPS));

/** A cap value that counts as PRESENT for needsCaps (anything but false / 'no'). */
export function hasCap(caps, key) {
    const v = caps[key];
    return v !== undefined && v !== false && v !== 'no';
}

const WORLD_METHODS = Object.freeze(['signal', 'set', 'read', 'peek', 'computed', 'effect', 'batch', 'untrack', 'dispose',
    'settle', 'stats', 'links', 'lifecycle', 'normalizeEscape', 'close']);
export { WORLD_METHODS };

/** Returns a list of problems (empty = valid). Checks the static shape; open() is probed by the caller. */
export function validateAdapter(a) {
    const out = [];
    if (a === null || typeof a !== 'object') return ['adapter is not an object'];
    if (typeof a.name !== 'string' || a.name === '') out.push('adapter.name must be a non-empty string');
    for (const f of ['version', 'files', 'open']) if (typeof a[f] !== 'function') out.push('adapter.' + f + ' must be a function');
    const caps = a.caps;
    if (caps === null || typeof caps !== 'object') {
        out.push('adapter.caps must be an object');
        return out;
    }
    for (const k of CAP_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(caps, k)) out.push('caps.' + k + ' is not declared');
        else if (CAPS[k].indexOf(caps[k]) === -1) out.push('caps.' + k + '=' + JSON.stringify(caps[k]) + ' is not one of ' + JSON.stringify(CAPS[k]));
    }
    for (const k of Object.keys(caps)) if (CAP_KEYS.indexOf(k) === -1) out.push('caps.' + k + ' is not a known cap');
    return out;
}

/** Check an opened world exposes every method. */
export function validateWorld(w) {
    const out = [];
    for (const m of WORLD_METHODS) if (typeof w[m] !== 'function') out.push('world.' + m + ' must be a function');
    return out;
}

/** Oracle -> caps it needs. */
export const ORACLE_CAPS = Object.freeze({
    O1c: [], O1e: [], O2: [], O4: [], O6: [],
    O5: ['links'],
    O7a: ['lifecycle'],
});

/**
 * Lane applicability on an adapter. desc: a lanes/index.mjs descriptor.
 * Returns { status: 'run'|'skip', missingCaps[], oraclesNA[], scenariosNA[], requiredApplicable[] }.
 */
export function applicability(desc, caps) {
    const missingCaps = desc.needsCaps.filter((c) => !hasCap(caps, c));
    const oraclesNA = Object.keys(ORACLE_CAPS).filter((o) => ORACLE_CAPS[o].some((c) => !hasCap(caps, c)));
    const scenariosNA = [];
    for (const s of desc.required.concat(desc.optional)) {
        const need = desc.scenCaps[s] || [];
        if (need.some((c) => !hasCap(caps, c))) scenariosNA.push(s);
    }
    const requiredApplicable = desc.required.filter((s) => scenariosNA.indexOf(s) === -1);
    const hardLeft = desc.hardOracles.filter((o) => oraclesNA.indexOf(o) === -1);
    let status = 'run';
    if (missingCaps.length > 0 || hardLeft.length === 0 || requiredApplicable.length === 0) status = 'skip';
    return { status, missingCaps, oraclesNA, scenariosNA, requiredApplicable };
}
