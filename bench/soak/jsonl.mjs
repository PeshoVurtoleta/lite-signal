/**
 * @zakkster/lite-signal soak -- durable JSONL stream, protocol lines and fatal handlers
 * (port of lite-pick benchmark/soak/jsonl.mjs:26-81; SPEC-B v2 section 7).
 *
 * Every record carries `type`, a contiguous `seq` from 0 and `tMs` since run start. Each stream KIND has a
 * closed set of record types; writing any other type throws (lite-pick documented a `checkpoint` type it
 * never emitted: digest section 2, L21). Writes are appendFileSync, so a kill mid-run leaves a complete
 * prefix. A fresh, unique file per run (default bench/soak/out/<kind>-<iso>-<sha7>.jsonl).
 *
 * Protocol lines (stderr) and the END sentinel (stdout) are written with fs.writeSync, so a process.exit()
 * can never drop them (lite-pick's macOS pipe truncation, digest section 11, L17).
 *
 * COLD module.
 */

import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { writeLineSync, configExit } from './config.mjs';

export const RECORD_TYPES = Object.freeze({
    'burn-in': Object.freeze(['header', 'cycle', 'summary', 'fatal']),
    wrap: Object.freeze(['header', 'wrap', 'summary', 'fatal']),
    replay: Object.freeze(['header', 'replay', 'summary', 'fatal']),
});
export const FATAL_KINDS = Object.freeze(['uncaughtException', 'unhandledRejection', 'mainRejection', 'lostRun']);
const FILE_PREFIX = Object.freeze({ 'burn-in': 'soak', wrap: 'wrap', replay: 'replay' });

/** Default output path under bench/soak/out/ (git-ignored). */
export function defaultOutPath(kind, sha) {
    if (!Object.prototype.hasOwnProperty.call(FILE_PREFIX, kind)) throw new TypeError('defaultOutPath: unknown stream kind ' + kind);
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const sha7 = sha ? String(sha).slice(0, 7) : 'nogit';
    return fileURLToPath(new URL('./out/' + FILE_PREFIX[kind] + '-' + iso + '-' + sha7 + '.jsonl', import.meta.url));
}

/**
 * Create a FRESH stream file. Opened with flag wx: an existing file (a reused SOAK_OUT) is NEVER truncated;
 * it exits 2 (config) before any record. Call only after config, kernel and provenance passed.
 */
export function openStream(path, t0, kind) {
    if (!Object.prototype.hasOwnProperty.call(RECORD_TYPES, kind)) throw new TypeError('openStream: unknown stream kind ' + kind);
    mkdirSync(dirname(path), { recursive: true });
    try {
        writeFileSync(path, '', { flag: 'wx' });
    } catch (e) {
        if (e && e.code === 'EEXIST') configExit('SOAK_OUT: ' + path + ' already exists; refusing to overwrite a previous stream (pick a new path)');
        throw e;
    }
    return { path, t0, kind, seq: 0, summarized: false };
}

/** Append one typed record; stamps type, seq, tMs. Throws on a type this stream kind does not carry. */
export function writeRecord(stream, type, body) {
    if (RECORD_TYPES[stream.kind].indexOf(type) === -1) {
        throw new TypeError('writeRecord: type ' + type + ' is not a ' + stream.kind + ' record (' + RECORD_TYPES[stream.kind].join('|') + ')');
    }
    const rec = body || {};
    rec.type = type;
    rec.seq = stream.seq;
    rec.tMs = +(performance.now() - stream.t0).toFixed(1);
    appendFileSync(stream.path, JSON.stringify(rec) + '\n');
    stream.seq++;   // only after a successful append: a failed write never leaves a seq gap
    if (type === 'summary') stream.summarized = true;
    return rec;
}

/** Write one fatal record carrying the crash context. */
export function writeFatal(stream, kind, ctx, err) {
    if (FATAL_KINDS.indexOf(kind) === -1) throw new TypeError('writeFatal: unknown fatal kind ' + kind);
    const c = ctx || {};
    const pick = (k) => (c[k] === undefined ? null : c[k]);
    return writeRecord(stream, 'fatal', {
        kind,
        lane: pick('lane'), cycle: pick('cycle'), world: pick('world'), worldSeed: pick('worldSeed'),
        message: String(err && err.message !== undefined ? err.message : err),
        stack: err && err.stack ? String(err.stack) : null,
    });
}

/** One stderr protocol line (`soak: BREACH ...`, `soak: INCONCLUSIVE -- ...`, ...). Newlines are flattened. */
export function protocol(line) {
    writeLineSync(2, String(line).replace(/\r?\n/g, ' | '));
}

/** One stdout line (heartbeat). */
export function stdoutLine(line) {
    writeLineSync(1, String(line).replace(/\r?\n/g, ' | '));
}

/** The END sentinel: the LAST stdout line of every run. A teeth control without it is a MISS. */
export function endLine(verdict, exitCode, records) {
    writeLineSync(1, 'soak: END verdict=' + verdict + ' exit=' + exitCode + ' records=' + records);
}

/**
 * Install the crash path. On uncaughtException / unhandledRejection (re-entrancy guarded), or on
 * `beforeExit` without a summary (lostRun), it writes a fatal record, then `summarize('fatal')` (which must
 * write the summary record and return the record count), a `soak: CRASH --` line and the END sentinel, and
 * exits 1. An unhandled rejection is a CRASH, never an assertion (lite-pick 2026-10-05).
 * Returns `fatal(kind, err)` for main's own catch (`mainRejection`).
 */
export function installFatalHandlers(stream, getContext, summarize) {
    let firing = false;
    const fatal = (kind, err) => {
        // Re-entrant fatal (e.g. summarize() itself threw an uncaught error): record nothing more and
        // return, so the OUTER handler finishes the summary, the CRASH line and the END sentinel.
        if (firing) { process.exitCode = 1; return; }
        firing = true;
        process.exitCode = 1;
        let records = stream.seq;
        try {
            writeFatal(stream, kind, (getContext && getContext()) || {}, err);
            if (summarize && !stream.summarized) summarize('fatal');
            records = stream.seq;
        } catch (e) {
            records = stream.seq;   // count whatever DID land (e.g. the fatal record before summarize threw)
            try { protocol('soak: CRASH -- fatal-handler write failed: ' + (e && e.stack ? e.stack : e)); } catch (e2) { /* nothing left to try */ }
        }
        try {
            protocol('soak: CRASH -- ' + kind + ': ' + (err && err.stack ? err.stack : String(err)));
            endLine('FAIL', 1, records);
        } catch (e) { /* the exit code still carries the verdict */ }
        process.exit(1);
    };
    process.on('uncaughtException', (err) => fatal('uncaughtException', err));
    process.on('unhandledRejection', (err) => fatal('unhandledRejection', err));
    process.on('beforeExit', () => {
        if (!stream.summarized && !firing) fatal('lostRun', new Error('event loop drained before a summary record was written'));
    });
    return fatal;
}
