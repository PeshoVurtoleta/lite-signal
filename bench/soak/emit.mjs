/**
 * @zakkster/lite-signal soak -- the kernel-only STANDALONE test of a shrunk world (s3c C4, burst 143 R6;
 * D-b143-1b).
 *
 *   SOAK_REPLAY=<LANE>:<cycle>:0x<seed> SOAK_SHRINK=1 node --expose-gc bench/soak/shrink.mjs --smoke --emit-test
 *
 * shrink.mjs always writes the harness-bound shrink-<LANE>-0x<seed>.test.mjs (it replays the minimal script
 * through exec.mjs and the lite-s3 adapter). With --emit-test it also writes shrink-<LANE>-0x<seed>.standalone
 * .test.mjs: a node:test file that imports node:* and the SOAK_KERNEL module ONLY, replays the minimal script
 * against the kernel's createRegistry() straight-line, and asserts the model values the failing oracle printed.
 * It is what a bug report to the engine carries: no soak module, no model, no adapter.
 *
 * emittable(info, r) -> {ok, reason, expect}. info: the shrink json (lane, script, ...); r: the CONFIRM run's
 * runWorld() result. The first refusal wins, in this order:
 *   lane:    the lane is not in EMIT_LANES (O6 lanes ERROR / REGISTRY / CAPACITY, the lane-state lanes HOOK /
 *            LIFECYCLE / OWNER / RECYCLE / SCHEDULER, any future lane): their oracles need the harness
 *   target:  a fails[].oracle outside O1c, O1e, O5 (the text names its family key, main.mjs familyKeys)
 *   op:      an op outside PLAIN_OPS, or a batch sub-op outside BATCH_SUB_OPS (exec.mjs applySub)
 *   flag:    an OP_FLAGS key on any op (a batch thr included), a SPEC_FLAGS key on any spec
 *   key:     an op key outside OP_KEYS, a spec key outside SPEC_KEYS, a script key outside SCRIPT_KEYS; a
 *            required key missing or malformed (an index that is not a non-negative integer)
 *   kind:    a spec kind outside PLAIN_KINDS, or refs that are not non-negative integers
 *   value:   a value code that is not a non-negative integer (a VALUE_POOL code < 0, the equals bomb)
 *   detail:  a fail detail whose want does not parse as an int or -0 (a cut() '...' tail, a showValue string,
 *            undefined, ERR(..)), or an O1c read that is not unique in its step
 * expect = {step, op, checks[]}: one check per fail, {o: 'O1c', node, want} | {o: 'O1e', node, seen [[r, v]]} |
 * {o: 'O5', field, want} (field signals / computeds / effects / activeNodes / activeLinks) | {o: 'O5', field:
 * 'teardown'}.
 *
 * emitStandalone(info, expect) -> the node:test source. It mirrors adapters/lite.mjs openWorld call for call
 * (createRegistry({maxNodes: 4096, onCapacityExceeded: 'grow'[, maxFlushPasses]}), every handle kept, close()
 * disposes them newest first) and exec.mjs for every engine call a plain script makes: the creation order, the
 * setTop / applySub / readCheck / disposeIdx guards, one stats() per top-level op (atRest, caps.links 'stats'),
 * the end check (o1c: the live computeds in mulberry32(seed ^ END_CHECK_SALT) shuffle order, a tainted one
 * skipped -- the taint mirror is model.mjs kill / tainted over each body's last-run reads). At the failing step
 * (an op index, 'end' or 'teardown') it asserts: O1c the value of the step's one top-level read of the node, O1e
 * the effect's last observation (refs and values, Object.is), O5 the stats() count. At teardown it always
 * asserts activeNodes 0 and activeLinks 0.
 *
 * STANDALONE EXIT CONTRACT (`node <file>`; it takes no arguments):
 *   2  any argument; SOAK_KERNEL unset, '', relative, failing to load, or without createRegistry(): one stderr
 *      line `standalone-test: CONFIG -- ...`, before any test() is registered
 *   3  the kernel threw during the ops replay (an emitted script never throws): `standalone-test: CRASH -- ...`
 *   1  an assertion fails (the target reproduces)
 *   0  every assertion passes
 *
 * specToSource(spec) -> the source of `(read) => {...}` for a PLAIN_KINDS spec: the same reads in the same
 * order and the same result (Object.is) as kinds.mjs evalKind(spec, read, id) for that spec. Self-contained
 * (its own toNum), so `new Function('return (' + src + ')')()` evaluates it anywhere.
 *
 * Kernel-free on import; pure (no fs, no clock). COLD module: no hot body.
 */

import { mulberry32, shuffle } from '../torture/helpers/index.mjs';
import { oracleFamily } from './gates.mjs';

/** Lanes whose failures a plain script can carry (every other lane is refused with `lane:`). */
export const EMIT_LANES = Object.freeze(['GRAPH', 'BATCH', 'NEST', 'WIE']);

/** The oracles a standalone can assert without the harness (fails[].oracle, not the family). */
export const EMIT_ORACLES = Object.freeze(['O1c', 'O1e', 'O5']);

/** Top-level ops (exec.mjs apply :288-303) the standalone replays; seq sub-ops use the same set. */
export const PLAIN_OPS = Object.freeze(['sig', 'comp', 'eff', 'set', 'burst', 'read', 'disp', 'stop', 'batch', 'seq']);

/** Batch body sub-ops (exec.mjs applySub :508-541); any other throws in exec. */
export const BATCH_SUB_OPS = Object.freeze(['set', 'read', 'eff', 'batch']);

/** The five plain body kinds of kinds.mjs evalKind :145-155 (NEST outer / inner / child need the harness). */
export const PLAIN_KINDS = Object.freeze(['sum', 'identity', 'select', 'cond', 'hash']);

/**
 * Op flags: every op key exec.mjs or gen.mjs read beyond the plain shape. chk (+cs) exec.mjs:826 / gen.mjs:226,
 * pull exec.mjs:394 :628 / gen.mjs:161, u exec.mjs:295, thr exec.mjs:298, eq exec.mjs:367 / gen.mjs:153, dis rank
 * role exec.mjs:365 / gen.mjs:150-152, cyc exec.mjs:293. cs is not listed: it rides on chk (the `key:` rule).
 */
export const OP_FLAGS = Object.freeze(['chk', 'pull', 'u', 'thr', 'eq', 'dis', 'cyc', 'rank', 'role']);

/** Spec flags: thr (kinds.mjs evalKind :163, gen.mjs:219), try (exec.mjs:707), w (exec.mjs:379 :675). */
export const SPEC_FLAGS = Object.freeze(['thr', 'try', 'w']);

export const OP_KEYS = Object.freeze(['o', 'i', 'v', 'vs', 'is', 'body', 'ops', 'spec']);
export const SPEC_KEYS = Object.freeze(['k', 'd', 's']);

/** A minimal script's top-level keys (gen.mjs:231-241, non-capacity lanes; r6-evidence README 0(e)). */
export const SCRIPT_KEYS = Object.freeze(['genVersion', 'lane', 'seed', 'large', 'covOff', 'flushPasses', 'ops']);

/** exec.mjs:91 (not exported there): the end check's shuffle salt. */
const END_CHECK_SALT = 0x5bd1e995;

/** Keys each plain op needs (exec.mjs reads them unguarded). */
const NEEDS = Object.freeze({
    sig: ['i', 'v'], comp: ['i', 'spec'], eff: ['i', 'spec'], set: ['i', 'v'], burst: ['i', 'vs'], read: ['is'],
    disp: ['i'], stop: ['i'], batch: ['body'], seq: ['ops'],
});

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isIdx = (x) => Number.isInteger(x) && x >= 0;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const no = (reason) => ({ ok: false, reason, expect: null });
const PLAIN_VALUE = ' (only a non-negative integer code is a plain value)';

/** Every op of a script, in exec order: {path, op, sub} (sub: a batch body entry, exec.mjs applySub). */
function walk(ops, base, sub, out) {
    for (let k = 0; k < ops.length; k++) {
        const op = ops[k];
        const path = base + '[' + k + ']';
        out.push({ path, op, sub });
        if (!isObj(op)) continue;
        if (op.o === 'batch' && Array.isArray(op.body)) walk(op.body, path + '.body', true, out);
        else if (op.o === 'seq' && !sub && Array.isArray(op.ops)) walk(op.ops, path + '.ops', false, out);
    }
    return out;
}

/** The top-level reads of node i that op makes (exec.mjs read :295, applySub read :521, seq :302). */
function readsOf(op, i, sub) {
    if (!isObj(op)) return 0;
    let n = 0;
    if (op.o === 'read' && Array.isArray(op.is)) for (const x of op.is) if (x === i) n++;
    if (op.o === 'batch' && Array.isArray(op.body)) for (const s of op.body) n += readsOf(s, i, true);
    if (op.o === 'seq' && !sub && Array.isArray(op.ops)) for (const s of op.ops) n += readsOf(s, i, false);
    return n;
}

const INT_TEXT = /^(-0|0|-?[1-9][0-9]*)$/;

/** An oracle want printed by showValue (kinds.mjs:128) as an int or -0; null when it is anything else. */
function parseWant(text) {
    if (!INT_TEXT.test(text)) return null;
    if (text === '-0') return -0;
    const n = Number(text);
    return Number.isSafeInteger(n) && String(n) === text ? n : null;
}

/** '#r=v,#r=v' (oracles.mjs fmtSeen) -> [[r, v]], or null when an entry is no int ref = int / -0 value. */
function parseSeen(text) {
    if (text === '') return [];
    const out = [];
    for (const e of text.split(',')) {
        const m = /^#(0|[1-9][0-9]*)=(.*)$/.exec(e);
        if (m === null) return null;
        const v = parseWant(m[2]);
        if (v === null) return null;
        out.push([Number(m[1]), v]);
    }
    return out;
}

const O5_FIELDS = Object.freeze(['signals', 'computeds', 'effects']);

/** One fail -> its check, or a `detail:` reason string. step / n: the failing step and the script length. */
function checkOf(f, script, step, n) {
    const d = typeof f.detail === 'string' ? f.detail : null;
    const bad = (why) => 'detail: ' + f.oracle + ' ' + String(f.sig) + ' ' + why + ' (' + JSON.stringify(d) + ')';
    if (d === null) return bad('has no detail string');
    if (d.endsWith('...')) return bad('was cut at 240 chars');
    if (f.oracle === 'O1c') {
        const m = /^node#(0|[1-9][0-9]*) \((\w+)\) engine=.* model=(\S+)$/.exec(d);
        const want = m === null ? null : parseWant(m[3]);
        if (want === null) return bad('model value is not an int');
        const node = Number(m[1]);
        const reads = step === n ? 1 : readsOf(script.ops[step], node, false);
        if (reads !== 1) {
            return bad('node#' + node + ' is read ' + reads + ' times in step ' + step +
                ' (the failing read is not unique)');
        }
        return { o: 'O1c', node, want };
    }
    if (f.oracle === 'O1e') {
        const m = /^effect#(0|[1-9][0-9]*) saw \[([^\]]*)\] model \[([^\]]*)\]$/.exec(d);
        const seen = m === null ? null : parseSeen(m[3]);
        if (seen === null) return bad('model observation is not a list of int values');
        if (step >= n) return bad('is not an at-rest step');
        return { o: 'O1e', node: Number(m[1]), seen };
    }
    if (d.indexOf('after close(): ') === 0) return { o: 'O5', field: 'teardown' };
    let m = /^(signals|computeds|effects) engine=\S+ model=(\S+)$/.exec(d);
    if (m !== null && O5_FIELDS.indexOf(m[1]) !== -1) {
        const want = parseWant(m[2]);
        return want === null ? bad('model count is not an int') : { o: 'O5', field: m[1], want };
    }
    m = /^activeNodes engine=\S+ model=(\S+)$/.exec(d);
    if (m !== null) {
        const want = parseWant(m[1]);
        return want === null ? bad('model count is not an int') : { o: 'O5', field: 'activeNodes', want };
    }
    m = /^activeLinks engine=\S+ expected=(\S+) \(slack 0\)$/.exec(d);
    if (m !== null) {
        const want = parseWant(m[1]);
        return want === null ? bad('expected count is not an int') : { o: 'O5', field: 'activeLinks', want };
    }
    return bad('does not parse');
}

/**
 * Can this shrunk world become a kernel-only standalone test? info: the shrink json fields (lane, script);
 * r: the confirm run's runWorld() result. Pure; never throws on a malformed info / r (it refuses).
 */
export function emittable(info, r) {
    const lane = info !== null && typeof info === 'object' ? info.lane : undefined;
    if (EMIT_LANES.indexOf(lane) === -1) {
        return no('lane: ' + String(lane) + ' (standalone lanes: ' + EMIT_LANES.join(', ') + ')');
    }
    const failure = r !== null && typeof r === 'object' ? r.failure : null;
    if (!isObj(failure) || !Array.isArray(failure.fails) || failure.fails.length === 0) {
        return no('target: none (the confirm run did not fail)');
    }
    for (const f of failure.fails) {
        if (!isObj(f) || EMIT_ORACLES.indexOf(f.oracle) === -1) {
            let fam;
            try { fam = oracleFamily(f.oracle); } catch (e) { fam = String(isObj(f) ? f.oracle : f); }
            const sig = String(isObj(f) ? f.sig : '?');
            return no('target: ' + fam + ':' + sig + ' (standalone oracles: ' + EMIT_ORACLES.join(', ') + ')');
        }
    }
    const script = info.script;
    if (!isObj(script) || !Array.isArray(script.ops)) return no('key: script.ops missing');
    const all = walk(script.ops, 'ops', false, []);
    for (const { path, op, sub } of all) {
        const o = isObj(op) ? op.o : undefined;
        if (sub ? BATCH_SUB_OPS.indexOf(o) === -1 : PLAIN_OPS.indexOf(o) === -1) {
            const what = JSON.stringify(o === undefined ? null : o);
            return no('op: ' + path + '.o ' + what + (sub ? ' (not a batch sub-op)' : ''));
        }
    }
    for (const { path, op } of all) {
        for (const f of OP_FLAGS) if (own(op, f)) return no('flag: ' + path + '.' + f);
        if (isObj(op.spec)) for (const f of SPEC_FLAGS) if (own(op.spec, f)) return no('flag: ' + path + '.spec.' + f);
    }
    for (const { path, op } of all) {
        for (const k of Object.keys(op)) if (OP_KEYS.indexOf(k) === -1) return no('key: ' + path + '.' + k);
        for (const k of NEEDS[op.o]) if (!own(op, k)) return no('key: ' + path + '.' + k + ' missing');
        if (own(op, 'i') && !isIdx(op.i)) return no('key: ' + path + '.i is not a node index');
        if (own(op, 'is') && !(Array.isArray(op.is) && op.is.every(isIdx))) {
            return no('key: ' + path + '.is is not a list of node indices');
        }
        if (own(op, 'vs') && !Array.isArray(op.vs)) return no('key: ' + path + '.vs is not a list');
        if (own(op, 'body') && !Array.isArray(op.body)) return no('key: ' + path + '.body is not a list');
        if (own(op, 'ops') && !Array.isArray(op.ops)) return no('key: ' + path + '.ops is not a list');
        if (own(op, 'spec')) {
            if (!isObj(op.spec)) return no('key: ' + path + '.spec is not an object');
            for (const k of Object.keys(op.spec)) {
                if (SPEC_KEYS.indexOf(k) === -1) return no('key: ' + path + '.spec.' + k);
            }
        }
    }
    for (const k of Object.keys(script)) if (SCRIPT_KEYS.indexOf(k) === -1) return no('key: script.' + k);
    if (!(script.flushPasses === null || script.flushPasses === undefined || isIdx(script.flushPasses))) {
        return no('key: script.flushPasses is neither null nor a non-negative integer');
    }
    if (!Number.isInteger(script.seed)) return no('key: script.seed is not an integer');
    for (const { path, op } of all) {
        if (!own(op, 'spec')) continue;
        const s = op.spec;
        if (PLAIN_KINDS.indexOf(s.k) === -1) {
            return no('kind: ' + path + '.spec.k ' + JSON.stringify(s.k === undefined ? null : s.k));
        }
        if (!(Array.isArray(s.d) && s.d.every(isIdx))) {
            return no('kind: ' + path + '.spec.d is not a list of node indices');
        }
        if (s.k === 'select' && !isIdx(s.s)) return no('kind: ' + path + '.spec.s is not a node index');
    }
    for (const { path, op } of all) {
        if (own(op, 'v') && !isIdx(op.v)) return no('value: ' + path + '.v ' + String(op.v) + PLAIN_VALUE);
        if (own(op, 'vs')) {
            for (let k = 0; k < op.vs.length; k++) {
                if (!isIdx(op.vs[k])) return no('value: ' + path + '.vs[' + k + '] ' + String(op.vs[k]) + PLAIN_VALUE);
            }
        }
    }
    const n = script.ops.length;
    const step = failure.step;
    const atOp = isIdx(step) && step < n;
    if (!(atOp || (step === n && (failure.op === 'end' || failure.op === 'teardown')))) {
        return no('detail: failure step ' + String(step) + ' / op ' + String(failure.op) +
            ' is not a step of this script');
    }
    const checks = [];
    for (const f of failure.fails) {
        const c = checkOf(f, script, step, n);
        if (typeof c === 'string') return no(c);
        checks.push(c);
    }
    return { ok: true, reason: null, expect: { step, op: failure.op, checks } };
}

/* ---- specToSource --------------------------------------------------------------------------------- */

const TO_NUM = 'const T = (x) => { const n = Number(x); return Number.isFinite(n) ? (n | 0) : 0; };';

/**
 * The source of `(read) => {...}` equal to kinds.mjs evalKind(spec, read, id) for a PLAIN_KINDS spec (no thr).
 * Throws TypeError on any other spec (fail closed: a refused spec has no source).
 */
export function specToSource(spec) {
    if (!isObj(spec) || PLAIN_KINDS.indexOf(spec.k) === -1) {
        throw new TypeError('specToSource: not a plain kind: ' + JSON.stringify(spec));
    }
    for (const f of SPEC_FLAGS) if (own(spec, f)) throw new TypeError('specToSource: spec.' + f + ' is not emittable');
    if (!(Array.isArray(spec.d) && spec.d.every(isIdx))) {
        throw new TypeError('specToSource: spec.d is not a list of node indices');
    }
    const d = spec.d;
    const ref = (k) => (k < d.length ? String(d[k]) : 'undefined');
    switch (spec.k) {
        case 'sum': {
            const b = ['(read) => { ' + TO_NUM + ' let a = 0;'];
            for (let k = 0; k < d.length; k++) b.push('a = (a + T(read(' + d[k] + '))) | 0;');
            b.push('return a; }');
            return b.join(' ');
        }
        case 'identity':
            return '(read) => read(' + ref(0) + ')';
        case 'select': {
            if (!isIdx(spec.s)) throw new TypeError('specToSource: select spec.s is not a node index');
            return '(read) => { ' + TO_NUM + ' const D = [' + d.join(', ') + ']; const sel = T(read(' + spec.s + '));' +
                ' const n = D.length; return read(D[((sel % n) + n) % n]); }';
        }
        case 'cond':
            return '(read) => { ' + TO_NUM + ' const a = read(' + ref(0) + ');' +
                ' return (T(a) > 50 && ' + d.length + ' > 1) ? read(' + ref(1) + ') : a; }';
        default: {   // hash
            const b = ['(read) => { ' + TO_NUM + ' let h = 7;'];
            for (let k = 0; k < d.length; k++) b.push('h = (Math.imul(h, 31) + T(read(' + d[k] + '))) | 0;');
            b.push('return h; }');
            return b.join(' ');
        }
    }
}

/* ---- emitStandalone ------------------------------------------------------------------------------- */

const asciiJson = (x) => JSON.stringify(x).replace(/[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const lit = (v) => (Object.is(v, -0) ? '-0' : String(v));

/** One op as standalone statements (exec.mjs apply / applySub). out: the lines; bodies: the spec constants. */
function opLines(op, sub, ind, out, bodies) {
    const p = ' '.repeat(ind);
    const body = (i, spec) => {
        const name = 'B' + bodies.length;
        bodies.push('// #' + i + ' ' + JSON.stringify(spec));
        bodies.push('const ' + name + ' = ' + specToSource(spec) + ';');
        return name;
    };
    switch (op.o) {
        case 'sig': out.push(p + 'sig(' + op.i + ', ' + lit(op.v) + ');'); break;
        case 'comp': out.push(p + 'comp(' + op.i + ', ' + body(op.i, op.spec) + ');'); break;
        case 'eff': out.push(p + 'eff(' + op.i + ', ' + body(op.i, op.spec) + ');'); break;
        case 'set': out.push(p + (sub ? 'setSub(' : 'setTop(') + op.i + ', ' + lit(op.v) + ');'); break;
        case 'burst': for (const v of op.vs) out.push(p + 'setTop(' + op.i + ', ' + lit(v) + ');'); break;
        case 'read': for (const i of op.is) out.push(p + 'top(' + i + ');'); break;
        case 'stop':
        case 'disp': out.push(p + 'disp(' + op.i + ');'); break;
        case 'batch':
            out.push(p + 'r.batch(() => {');
            for (const s of op.body) opLines(s, true, ind + 4, out, bodies);
            out.push(p + '});');
            break;
        default:   // seq
            for (const s of op.ops) opLines(s, false, ind, out, bodies);
    }
}

/**
 * The standalone node:test source for an emittable world. info: the shrink json fields (key, target, ops,
 * opsOriginal, script); expect: emittable(info, r).expect. Pure.
 */
export function emitStandalone(info, expect) {
    const script = info.script;
    const n = script.ops.length;
    const FS = expect.step;
    const replay = [];
    const bodies = [];
    const last = FS < n ? FS : n - 1;
    for (let k = 0; k <= last; k++) {
        replay.push('    S = ' + k + ';   // ' + JSON.stringify(script.ops[k]).slice(0, 96));
        opLines(script.ops[k], false, 4, replay, bodies);
        replay.push('    rest(' + k + ');');
    }
    if (FS === n) {
        replay.push('    S = ' + n + ';   // the end check: every live computed, shuffled, a tainted one skipped');
        replay.push('    const order = [];');
        replay.push('    for (let k = 0; k < TY.length; k++) if (TY[k] === \'c\' && LIVE[k]) order.push(k);');
        replay.push('    shuffle(mulberry32(' + (((script.seed ^ END_CHECK_SALT) >>> 0) | 0) + '), order);');
        replay.push('    for (const i of order) { if (LIVE[i] && !tainted(i, new Map())) top(i); }');
        // exec makes no stats() call at the end; only an O5 count check placed there needs one (never on a live run)
        if (expect.checks.some((c) => c.o === 'O5' && c.field !== 'teardown')) replay.push('    END = r.stats();');
    }
    const cfg = script.flushPasses !== null && script.flushPasses !== undefined
        ? '{ maxNodes: 4096, onCapacityExceeded: \'grow\', maxFlushPasses: ' + script.flushPasses + ' }'
        : '{ maxNodes: 4096, onCapacityExceeded: \'grow\' }';
    const tests = [];
    const at = FS === n ? 'end' : 'step ' + FS;
    const o1e = [];
    for (const c of expect.checks) {
        if (c.o === 'O1c') {
            tests.push(
                'test(KEY + \' ' + at + ': O1c node#' + c.node + ' reads ' + lit(c.want) + '\', () => {',
                '    const x = READS.find((e) => e[0] === ' + FS + ' && e[1] === ' + c.node + ');',
                '    assert.ok(x !== undefined, \'node#' + c.node + ' was not read in ' + at + '\');',
                '    assert.ok(Object.is(x[2], ' + lit(c.want) + '),',
                '        \'node#' + c.node + ' engine=\' + String(x[2]) + \' model=' + lit(c.want) + '\');',
                '});');
        } else if (c.o === 'O1e') {
            o1e.push(c.node);
            const want = '[' + c.seen.map((e) => '[' + e[0] + ', ' + lit(e[1]) + ']').join(', ') + ']';
            tests.push(
                'test(KEY + \' ' + at + ': O1e effect#' + c.node + ' last saw ' + want + '\', () => {',
                '    const want = ' + want + ';',
                '    const got = SEEN_AT[' + c.node + '];',
                '    assert.ok(Array.isArray(got), \'effect#' + c.node + ' never ran\');',
                '    const show = (v) => (Object.is(v, -0) ? \'-0\' : String(v));',
                '    const txt = (l) => l.map((e) => \'#\' + e[0] + \'=\' + show(e[1])).join(\',\');',
                '    const same = got.length === want.length',
                '        && got.every((e, k) => e[0] === want[k][0] && Object.is(e[1], want[k][1]));',
                '    assert.ok(same, \'effect#' + c.node + ' saw [\' + txt(got) + \'] model [\' + txt(want) + \']\');',
                '});');
        } else if (c.field !== 'teardown') {
            const src = FS === n ? 'END' : 'STATS[' + FS + ']';
            tests.push(
                'test(KEY + \' ' + at + ': O5 ' + c.field + ' ' + lit(c.want) + '\', () => {',
                '    assert.equal(' + src + '.' + c.field + ', ' + lit(c.want) + ');',
                '});');
        }
    }
    const snap = o1e.length > 0 ? '        if (k === ' + FS + ') for (const e of ' + JSON.stringify(o1e) +
        ') SEEN_AT[e] = SEEN[e] === null || SEEN[e] === undefined ? null : SEEN[e].slice();' : null;
    const L = [
        '// GENERATED by the lite-signal soak shrinker (--emit-test, burst 143 R6). Do not edit: re-run the shrink.',
        '// key ' + info.key + '  target ' + info.target.join(',') + '  ops ' + info.ops +
            ' (from ' + info.opsOriginal + ')  fails at ' + at + ' (' + expect.op + ')',
        '// KERNEL-ONLY: imports node:* and the SOAK_KERNEL module, nothing else. The script below replays the minimal',
        '// world against createRegistry() and asserts the model values the soak oracle printed at the failing step.',
        '// Run: SOAK_KERNEL=/abs/dir/Signal.js node <this file>   (no arguments; SOAK_KERNEL required, ABSOLUTE)',
        '// Exit: 1 an assertion fails (the target reproduces), 0 every assertion passes, 2 config (an argument;',
        '// SOAK_KERNEL unset, empty, relative, failing to load, no createRegistry), 3 the kernel threw in the replay.',
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { writeSync } from 'node:fs';",
        "import { isAbsolute } from 'node:path';",
        "import { pathToFileURL } from 'node:url';",
        '',
        'const KEY = ' + asciiJson(info.key) + ';',
        "const say = (s) => writeSync(2, 'standalone-test: ' + s + '\\n');",
        'if (process.argv.length > 2) {',
        "    say('CONFIG -- this test takes no arguments (set SOAK_KERNEL instead)'); process.exit(2);",
        '}',
        'const KP = process.env.SOAK_KERNEL;',
        "if (KP === undefined || KP === '') {",
        "    say('CONFIG -- SOAK_KERNEL is required (an absolute path to a frozen <dir>/Signal.js)'); process.exit(2);",
        '}',
        'if (!isAbsolute(KP)) {',
        "    say('CONFIG -- SOAK_KERNEL must be an absolute path (got ' + KP + ')'); process.exit(2);",
        '}',
        'let K;',
        'try { K = await import(pathToFileURL(KP).href); } catch (e) {',
        "    say('CONFIG -- SOAK_KERNEL failed to load: ' + String(e && e.message ? e.message : e).split('\\n')[0]);",
        '    process.exit(2);',
        '}',
        "if (K === null || typeof K !== 'object' || typeof K.createRegistry !== 'function') {",
        "    say('CONFIG -- SOAK_KERNEL exports no createRegistry()'); process.exit(2);",
        '}',
        '',
        '// the end check order (exec.mjs o1c; bench/torture helpers, verbatim)',
        mulberry32.toString(),
        shuffle.toString(),
        '',
        '// the bodies (kinds.mjs evalKind, one per created node)',
        ...bodies,
        '',
        '// the world (adapters/lite.mjs openWorld): H handles by node, TY kind; LIVE / SEEN / TAINT mirror model.mjs',
        'const H = [], TY = [], LIVE = [], SEEN = [], TAINT = [], handles = [], stack = [];',
        'const READS = [], STATS = [], SEEN_AT = [];',
        'let r = null, S = -1, END = null, RES = null;',
        'const rd = (ref) => {',
        '    const f = stack[stack.length - 1];',
        '    if (H[ref] === undefined) { f.push([ref, undefined]); return undefined; }',
        '    const v = H[ref]();',
        '    f.push([ref, v]);',
        '    return v;',
        '};',
        'const run = (i, body) => {',
        '    const f = [];',
        '    stack.push(f);',
        '    try { return body(rd); } finally { stack.pop(); SEEN[i] = f; TAINT[i] = false; }',
        '};',
        'const mk = (i, t) => { TY[i] = t; LIVE[i] = true; SEEN[i] = null; TAINT[i] = false; };',
        'const keep = (h) => { handles.push(h); return h; };',
        'const sig = (i, v) => { mk(i, \'s\'); H[i] = keep(r.signal(v)); };',
        'const comp = (i, b) => { mk(i, \'c\'); H[i] = keep(r.computed(() => run(i, b))); };',
        'const eff = (i, b) => { mk(i, \'e\'); H[i] = keep(r.effect(() => { run(i, b); })); };',
        'const setTop = (i, v) => { if (TY[i] !== \'s\' || H[i] === undefined) return; H[i].set(v); };',
        'const setSub = (i, v) => { if (TY[i] === undefined || !LIVE[i] || H[i] === undefined) return; H[i].set(v); };',
        'const top = (i) => {',
        '    if (TY[i] === undefined || H[i] === undefined || TY[i] === \'e\') return;',
        '    READS.push([S, i, H[i]()]);',
        '};',
        'const disp = (j) => {',
        '    if (TY[j] === undefined || !LIVE[j] || H[j] === undefined) return;',
        '    LIVE[j] = false;',
        '    for (let k = 0; k < SEEN.length; k++) {',
        '        const s = SEEN[k];',
        '        if (!LIVE[k] || s === null || s === undefined) continue;',
        '        for (let x = 0; x < s.length; x++) if (s[x][0] === j) { TAINT[k] = true; break; }',
        '    }',
        '    r.dispose(H[j]);',
        '};',
        'const tainted = (i, m) => {',
        '    if (TY[i] === undefined) return false;',
        '    if (m.has(i)) return m.get(i);',
        '    m.set(i, false);',
        '    let t = TAINT[i] === true;',
        '    const s = SEEN[i];',
        '    if (!t && s !== null && s !== undefined) {',
        '        for (let x = 0; x < s.length; x++) {',
        '            const q = s[x][0];',
        '            if (TY[q] === \'c\' && LIVE[q] && tainted(q, m)) { t = true; break; }',
        '        }',
        '    }',
        '    m.set(i, t);',
        '    return t;',
        '};',
        'const rest = (k) => {',
        '    STATS[k] = r.stats();',
    ];
    if (snap !== null) L.push(snap.slice(4));
    L.push(
        '};',
        '',
        'try {',
        '    r = K.createRegistry(' + cfg + ');',
        ...replay,
        '    // teardown (adapters/lite.mjs close()): dispose every handle, newest first',
        '    for (let k = handles.length - 1; k >= 0; k--) r.dispose(handles[k]);',
        '    RES = r.stats();',
        '} catch (e) {',
        "    say('CRASH -- ' + (e && e.stack ? e.stack : String(e)));",
        '    process.exit(3);',
        '}',
        '',
        ...tests,
        'test(KEY + \' teardown: activeNodes 0 / activeLinks 0 after every handle is disposed\', () => {',
        '    assert.equal(RES.activeNodes, 0, \'activeNodes after close\');',
        '    assert.equal(RES.activeLinks, 0, \'activeLinks after close\');',
        '});',
        '');
    return L.join('\n');
}
