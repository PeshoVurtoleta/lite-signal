// test/90-inline-diff.test.mjs -- pure logic of bench/inline-diff.mjs on CANNED trace text.
// No V8 spawn here: the timed trace runs are STATISTICAL / REPORTED tier and never part of npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    normalizeTurbo, normalizeMaglev, normalize, hasGuard, scopeLines, multiset, multisetDiff,
    tierVerdict, overallVerdict, exitCode, parseArgs, assertNotLive, fnToken, DEFAULT_DRIVER, v8Flags,
    assertFrozenBuild, sameFile,
} from '../bench/inline-diff.mjs';

// Canned node v26 trace fragments (two runs that differ only in addresses / ids / frequencies).
const TURBO_1 = [
    'Considering 0x1a2b3c {0x4d5e6f <SharedFunctionInfo read.set>} for inlining with 0x77 {0x88 <FeedbackVector[38]>}',
    '- candidate: JSCall node #232 with frequency 423.986, has_heapnum_param:0, 1 target(s):',
    '  - target: 0x11 {0x22 <SharedFunctionInfo read.set>}, bytecode size: 285',
    'Budget used: 233/920 -- 2 candidate(s) for inlining:',
    'Inlining 0xabc {0xdef <SharedFunctionInfo markDownstream>} into 0x123 {0x456 <SharedFunctionInfo read.set>}',
    'Inlining 0xabc {0xdef <SharedFunctionInfo sharedSignalPeek>} into 0x123 {0x456 <SharedFunctionInfo>}',
    'Cannot consider 0x9 {0x8 <SharedFunctionInfo refreshComputed>} for inlining (reason: exceeds bytecode limit)',
    'Inlining small function(s) at call site #140:JSCall',
].join('\n');
const TURBO_2 = TURBO_1.replace(/0x[0-9a-f]+/g, (h) => h + 'f').replace(/#232/, '#999').replace('423.986', '1.5');
const MAG_1 = [
    'Concurrent maglev has been disabled for tracing.',
    '  cannot inline 0x10 {0x20 <SharedFunctionInfo markDownstream>}: call frequency (0.89781) < minimum threshold (0.95)',
    '  cannot inline 0x10 {0x20 <SharedFunctionInfo read.set>}: big function, size (285) >= max-size (100)',
    '== Inlining 0x30 <SharedFunctionInfo sharedSignalPeek>',
    '  greedy inlining 0x40 {0x50 <SharedFunctionInfo batch>}: small function, skipping max-depth',
].join('\n');

test('90.1 normalizeTurbo: addresses, #ids, frequencies collapse; only decision lines kept', () => {
    const a = normalizeTurbo(TURBO_1), b = normalizeTurbo(TURBO_2);
    assert.deepEqual(a, b);
    assert.deepEqual(a, [
        'Inlining 0x {0x <SharedFunctionInfo markDownstream>} into 0x {0x <SharedFunctionInfo read.set>}',
        'Inlining 0x {0x <SharedFunctionInfo sharedSignalPeek>} into 0x {0x <SharedFunctionInfo>}',
        'Cannot consider 0x {0x <SharedFunctionInfo refreshComputed>} for inlining (reason: exceeds bytecode limit)',
    ]);
    assert.deepEqual(normalizeTurbo('Not inlining 0x1 {0x2 <SharedFunctionInfo f>} into 0x3 {0x4 <SharedFunctionInfo g>} because call has an exception handler\n' +
        'Not considering call site #12:JSCall, because of recursive inlining\nInlinee contains 3 calls without local exception handler'),
        ['Not inlining 0x {0x <SharedFunctionInfo f>} into 0x {0x <SharedFunctionInfo g>} because call has an exception handler',
            'Not considering call site #N:JSCall, because of recursive inlining']);
    assert.deepEqual(normalizeTurbo('Inlining 0x1 {0x2 <SharedFunctionInfo f>} into 0x3 {0x4 <SharedFunctionInfo g>} took 12.5 ms'),
        ['Inlining 0x {0x <SharedFunctionInfo f>} into 0x {0x <SharedFunctionInfo g>} took T ms']);
});

test('90.2 normalizeMaglev: frequency + size collapse, limits and reasons kept', () => {
    const a = normalizeMaglev(MAG_1);
    assert.deepEqual(a, [
        'cannot inline 0x {0x <SharedFunctionInfo markDownstream>}: call frequency (F) < minimum threshold (0.95)',
        'cannot inline 0x {0x <SharedFunctionInfo read.set>}: big function, size (S) >= max-size (100)',
        '== Inlining 0x <SharedFunctionInfo sharedSignalPeek>',
        'greedy inlining 0x {0x <SharedFunctionInfo batch>}: small function, skipping max-depth',
    ]);
    assert.deepEqual(normalizeMaglev(MAG_1.replace('(285)', '(301)').replace('0.89781', '0.5')), a);
    assert.deepEqual(normalize('maglev', MAG_1), a);
    assert.throws(() => normalize('sparkplug', ''), /unknown tier/);
});

test('90.3 multiset keeps call-site multiplicity (a sort -u implementation fails here)', () => {
    const L = 'Inlining 0x {0x <SharedFunctionInfo f>} into 0x {0x <SharedFunctionInfo g>}';
    assert.equal(multiset([L, L]).get(L), 2);
    assert.deepEqual(multisetDiff([L, L], [L]), [{ line: L, before: 2, after: 1 }]);
    const r = tierVerdict({ fn: 'f', beforeRuns: [[L, L], [L, L]], afterRuns: [[L], [L]] });
    assert.equal(r.verdict, 'DIFF');
    assert.deepEqual(r.diff, [{ line: L, before: 2, after: 1 }]);
});

test('90.4 multisetDiff is order-insensitive and lists both directions sorted', () => {
    assert.deepEqual(multisetDiff(['b', 'a', 'a'], ['a', 'b', 'a']), []);
    assert.deepEqual(multisetDiff(['a', 'c'], ['b', 'c']), [{ line: 'a', before: 1, after: 0 }, { line: 'b', before: 0, after: 1 }]);
});

test('90.5 guard: a run that never names <fn> is NO-VERDICT (a missing-guard implementation fails here)', () => {
    const other = ['Inlining 0x {0x <SharedFunctionInfo g>} into 0x {0x <SharedFunctionInfo h>}'];
    assert.equal(hasGuard(other, 'f'), false);
    const both = tierVerdict({ fn: 'f', beforeRuns: [other, other], afterRuns: [other, other] });
    assert.equal(both.verdict, 'NO-VERDICT');
    assert.match(both.reason, /no trace of SharedFunctionInfo f> in before run 1/);
    const withF = ['Inlining 0x {0x <SharedFunctionInfo f>} into 0x {0x <SharedFunctionInfo h>}'];
    const afterOnly = tierVerdict({ fn: 'f', beforeRuns: [withF, withF], afterRuns: [withF, other] });
    assert.equal(afterOnly.verdict, 'NO-VERDICT');
    assert.match(afterOnly.reason, /no trace of .* in after run 2/);
});

test('90.6 guard token is exact: read does not match read.set, anonymous never matches', () => {
    const lines = normalizeTurbo(TURBO_1);
    assert.equal(fnToken('read'), 'SharedFunctionInfo read>');
    assert.equal(hasGuard(lines, 'read'), false);
    assert.equal(hasGuard(lines, 'read.set'), true);
    assert.equal(hasGuard(['Inlining 0x {0x <SharedFunctionInfo>} into 0x {0x <SharedFunctionInfo>}'], ''), false);
    assert.deepEqual(scopeLines(lines, 'read.set', true), [lines[0]]);
    assert.equal(scopeLines(lines, 'read.set', false).length, 3);
});

test('90.7 null control: before runs that disagree are NO-VERDICT even when before[0] == after[0] (a skipped null control fails here)', () => {
    const A = 'Inlining 0x {0x <SharedFunctionInfo f>} into 0x {0x <SharedFunctionInfo g>}';
    const B = 'Inlining 0x {0x <SharedFunctionInfo f>} into 0x {0x <SharedFunctionInfo h>}';
    const r = tierVerdict({ fn: 'f', beforeRuns: [[A], [A, B], [A]], afterRuns: [[A], [A], [A]] });
    assert.equal(r.verdict, 'NO-VERDICT');
    assert.match(r.reason, /null control: before run 1 vs before run 2/);
    assert.deepEqual(r.nullDiff, [{ line: B, before: 0, after: 1 }]);
    const unstableAfter = tierVerdict({ fn: 'f', beforeRuns: [[A], [A]], afterRuns: [[A], [B]] });
    assert.equal(unstableAfter.verdict, 'NO-VERDICT');
    assert.match(unstableAfter.reason, /stability: after run 1 vs after run 2/);
});

test('90.8 null control needs >= 2 runs per side with equal counts', () => {
    const A = ['Inlining 0x {0x <SharedFunctionInfo f>} into 0x {0x <SharedFunctionInfo g>}'];
    assert.equal(tierVerdict({ fn: 'f', beforeRuns: [A], afterRuns: [A] }).verdict, 'NO-VERDICT');
    assert.equal(tierVerdict({ fn: 'f', beforeRuns: [A, A], afterRuns: [A] }).verdict, 'NO-VERDICT');
    assert.equal(tierVerdict({ fn: 'f', beforeRuns: null, afterRuns: [A, A] }).verdict, 'NO-VERDICT');
    assert.equal(tierVerdict({ fn: 'f', beforeRuns: [A, A], afterRuns: [A, A] }).verdict, 'SAME');
});

test('90.9 end to end on canned text: address-only drift is SAME, a lost inline site is DIFF', () => {
    const b = [normalizeTurbo(TURBO_1), normalizeTurbo(TURBO_2)];
    assert.equal(tierVerdict({ fn: 'markDownstream', beforeRuns: b, afterRuns: [normalizeTurbo(TURBO_2), normalizeTurbo(TURBO_1)] }).verdict, 'SAME');
    const lost = TURBO_1.replace(/Inlining 0xabc \{0xdef <SharedFunctionInfo markDownstream>[^\n]*\n/, '');
    const r = tierVerdict({ fn: 'markDownstream', beforeRuns: b, afterRuns: [normalizeTurbo(lost), normalizeTurbo(lost)] });
    assert.equal(r.verdict, 'NO-VERDICT');   // the only markDownstream line vanished -> guard, not a silent DIFF
    const r2 = tierVerdict({ fn: 'sharedSignalPeek', onlyFn: true, beforeRuns: b, afterRuns: [normalizeTurbo(lost), normalizeTurbo(lost)] });
    assert.equal(r2.verdict, 'SAME');        // --only-fn (callee-side only): blind to the other line
    const r3 = tierVerdict({ fn: 'sharedSignalPeek', beforeRuns: b, afterRuns: [normalizeTurbo(lost), normalizeTurbo(lost)] });
    assert.equal(r3.verdict, 'DIFF');        // default scope = whole decision trace
});

test('90.10 overall verdict precedence and exit codes 0 / 1 / 2', () => {
    const S = { verdict: 'SAME' }, D = { verdict: 'DIFF' }, N = { verdict: 'NO-VERDICT' };
    assert.equal(overallVerdict({ turbo: S, maglev: S }), 'SAME');
    assert.equal(overallVerdict({ turbo: S, maglev: D }), 'DIFF');
    assert.equal(overallVerdict({ turbo: D, maglev: N }), 'NO-VERDICT');
    assert.equal(overallVerdict({}), 'NO-VERDICT');
    assert.equal(overallVerdict({ turbo: { verdict: 'same' } }), 'NO-VERDICT');
    assert.deepEqual([exitCode('SAME'), exitCode('DIFF'), exitCode('NO-VERDICT'), exitCode('bogus'), exitCode('toString')], [0, 1, 2, 2, 2]);
});

test('90.11 parseArgs: required keys, --runs bounds, did-you-mean, named fn only', () => {
    const base = ['--before', 'b.js', '--after', 'a.js', '--fn', 'read.set'];
    assert.deepEqual(parseArgs(base), { runs: 3, onlyFn: false, concurrent: false, help: false, before: 'b.js', after: 'a.js', fn: 'read.set' });
    assert.equal(parseArgs([...base, '--runs', '5']).runs, 5);
    for (const bad of ['1', '0', '-3', '2.5', 'x', '51']) assert.throws(() => parseArgs([...base, '--runs', bad]), /--runs must be/);
    assert.throws(() => parseArgs([...base, '--rusn', '3']), /unknown option --rusn \(did you mean --runs\?\)/);
    assert.throws(() => parseArgs(['--before', 'b.js', '--fn', 'f']), /--after is required/);
    assert.throws(() => parseArgs([...base, '--driver']), /--driver needs a value/);
    assert.throws(() => parseArgs(['--before', 'b', '--after', 'a', '--fn', '<anonymous>']), /NAMED function/);
    assert.throws(() => parseArgs([...base, 'stray']), /unexpected argument/);
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs([...base, '--concurrent']).concurrent, true);
    assert.equal(parseArgs([...base, '--only-fn']).onlyFn, true);
    assert.throws(() => parseArgs([...base, '--all']), /unknown option --all/);
    assert.deepEqual(v8Flags('turbo', false), ['--trace-turbo-inlining', '--no-concurrent-recompilation']);
    assert.deepEqual(v8Flags('maglev', true), ['--trace-maglev-inlining']);
});

test('90.12 assertNotLive refuses the live main file, directly or through a symlink', () => {
    const d = mkdtempSync(join(tmpdir(), 'inline-diff-t90-'));
    try {
        const live = join(d, 'Signal.js'), frozen = join(d, 'frozen.js'), link = join(d, 'link.js');
        writeFileSync(live, '// live\n');
        writeFileSync(frozen, '// live\n');
        symlinkSync(live, link);
        assert.throws(() => assertNotLive(live, live), /resolves to the LIVE/);
        assert.throws(() => assertNotLive(link, live), /resolves to the LIVE/);
        assert.throws(() => assertNotLive(join(d, 'missing.js'), live), /--before not found/);
        assert.doesNotThrow(() => assertNotLive(frozen, live));
        const hard = join(d, 'hard.js');
        linkSync(live, hard);
        assert.throws(() => assertNotLive(hard, live), /resolves to the LIVE/);
        const upper = join(d, 'SIGNAL.JS');
        if (existsSync(upper)) assert.throws(() => assertNotLive(upper, live), /resolves to the LIVE/);   // case-insensitive FS
        assert.equal(sameFile(join(d, 'missing.js'), live), false);
        // Watch.js beside --before must not be the live Watch.js (Signal.js re-exports it)
        const liveDir = join(d, 'live'), fz = join(d, 'fz');
        mkdirSync(liveDir); mkdirSync(fz);
        writeFileSync(join(liveDir, 'Signal.js'), '// s\n'); writeFileSync(join(liveDir, 'Watch.js'), '// w\n');
        writeFileSync(join(fz, 'Signal.js'), '// s\n');
        linkSync(join(liveDir, 'Watch.js'), join(fz, 'Watch.js'));
        assert.throws(() => assertFrozenBuild(join(fz, 'Signal.js'), liveDir), /Watch\.js beside --before resolves to the LIVE/);
        rmSync(join(fz, 'Watch.js')); writeFileSync(join(fz, 'Watch.js'), '// w\n');
        assert.doesNotThrow(() => assertFrozenBuild(join(fz, 'Signal.js'), liveDir));
        rmSync(join(fz, 'Watch.js'));
        assert.throws(() => assertFrozenBuild(join(fz, 'Signal.js'), liveDir), /Watch\.js beside --before not found/);
        assert.throws(() => assertFrozenBuild(join(liveDir, 'Signal.js'), liveDir), /--before resolves to the LIVE/);
    } finally {
        rmSync(d, { recursive: true, force: true });
    }
});

test('90.13 default driver imports ./Signal.js and exercises set / read / peek / computed / effect / batch', () => {
    assert.match(DEFAULT_DRIVER, /from '\.\/Signal\.js'/);
    for (const k of ['signal(', 'computed(', 'effect(', 'batch(', '.set(', '.peek()']) assert.ok(DEFAULT_DRIVER.includes(k), k);
});

test('90.14 default scope sees a decision inside <fn>\'s inlined body (callee-side-only scope is blind to it)', () => {
    const K = 'Inlining 0x1 {0x2 <SharedFunctionInfo pullComputed>} into 0x3 {0x4 <SharedFunctionInfo step>}';
    const before = normalizeTurbo(K);
    const after = normalizeTurbo(K + '\nCannot consider 0x5 {0x6 <SharedFunctionInfo helper>} for inlining (reason: exceeds bytecode limit)');
    const r = tierVerdict({ fn: 'pullComputed', beforeRuns: [before, before], afterRuns: [after, after] });
    assert.equal(r.verdict, 'DIFF');
    assert.deepEqual(r.diff, [{ line: 'Cannot consider 0x {0x <SharedFunctionInfo helper>} for inlining (reason: exceeds bytecode limit)', before: 0, after: 1 }]);
    assert.equal(tierVerdict({ fn: 'pullComputed', onlyFn: true, beforeRuns: [before, before], afterRuns: [after, after] }).verdict, 'SAME');
    const mb = normalizeMaglev('== Inlining 0x1 <SharedFunctionInfo pullComputed>');
    const ma = normalizeMaglev('== Inlining 0x1 <SharedFunctionInfo pullComputed>\n  cannot inline 0x7 {0x8 <SharedFunctionInfo helper>}: big function, size (500) >= max-size (100)');
    assert.equal(tierVerdict({ fn: 'pullComputed', beforeRuns: [mb, mb], afterRuns: [ma, ma] }).verdict, 'DIFF');
});
