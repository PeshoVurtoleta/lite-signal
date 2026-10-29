// test/94-inlining-budget-diff.test.mjs -- bench/inlining-budget-diff.sh --self-test (canned trace text).
// No V8 spawn here (every self-test sub-run passes --node false or a fake node): the real before / after trace runs are STATISTICAL / REPORTED tier and never part of
// npm test. The self-test runs the script's own awk programs and refusal paths; the must-fail rows prove
// that it has teeth (each mutant of the script must turn the self-test red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'inlining-budget-diff.sh');
const CHECKS = 31;   // every `check` call in self_test(); a new check moves this literal
const skip = process.platform === 'win32' ? 'bash script: POSIX hosts only' : false;

function selfTest(path) {
    return spawnSync('bash', [path, '--self-test'], { encoding: 'utf8', timeout: 60000 });
}
function okCount(out) { return (out.match(/^ok {3}/gm) || []).length; }

// A copy of the script in a temp dir, with ONE exact edit (must match exactly once, else the row is invalid).
function variant(dir, name, from, to) {
    const src = readFileSync(SCRIPT, 'utf8');
    const n = src.split(from).length - 1;
    assert.equal(n, 1, `mutant ${name}: anchor must match exactly once, matched ${n}`);
    const p = join(dir, `${name}.sh`);
    writeFileSync(p, src.replace(from, () => to));
    chmodSync(p, 0o755);
    return p;
}

test('inlining-budget-diff --self-test: every check passes', { skip }, () => {
    const r = selfTest(SCRIPT);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^self-test: all checks passed$/m);
    assert.doesNotMatch(r.stdout, /^FAIL /m);
    assert.equal(okCount(r.stdout), CHECKS);
});

test('inlining-budget-diff --self-test: an unmodified copy outside the repo passes (baseline for the mutants)', { skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ibd-base-'));
    try {
        const r = selfTest(variant(dir, 'baseline', '#!/usr/bin/env bash\n', '#!/usr/bin/env bash\n'));
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(okCount(r.stdout), CHECKS);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

const MUTANTS = [
    ['multiset-sort-u', 'multiset() { sort | uniq -c; }', 'multiset() { sort -u; }',
        'multiset keeps call-site multiplicity'],
    ['budget-double-compare', 'used + int((z + e) * scale) > L', 'used + (z + e) * scale > L',
        'reserve compare truncates like V8'],
    // (TurboFan keeps no frequency in its decision lines, so dropping that gsub is an equivalent mutant;
    // dropping the address gsub is not: the canned before / after runs differ in every address.)
    ['no-turbo-address-normalize', 'gsub(/0x[0-9a-fA-F]+/, "0x", l); gsub(/#[0-9]+/, "#N", l)', 'gsub(/#[0-9]+/, "#N", l)',
        'turbo: addresses / ids / frequencies'],
    // (the tracked --before row stays green here: the tracked Watch.js beside it is refused instead)
    ['no-live-refusal', '  refuse_live "$BEFORE_FILE" "--before"\n', '',
        'a hard link to the live tracked file is refused (cwd in the repo)'],
    ['no-exit-trap', /^trap 'rc=\$\?;.*' EXIT\n/m, '',
        'an unexpected failure exits 2, never 1'],
    ['no-watch-refusal', 'if [[ -f "$(dirname "$BEFORE_FILE")/Watch.js" ]]; then refuse_live', 'if false; then refuse_live',
        'a symlinked Watch.js beside --before is refused'],
    ['trap-ignores-final', '[[ -z $FINAL && $rc -ne 0', '[[ $rc -ne 0',
        'a real DIFF exits 1'],
    ['no-final-before-verdict', 'FINAL=1\ncase "$VERDICT"', 'case "$VERDICT"',
        'a real DIFF exits 1'],
    ['no-after-top', '    [[ -n "$AFTER_FILE" ]] && git -C "$(dirname "$AFTER_FILE")" rev-parse --show-toplevel 2>/dev/null || true\n', '',
        'a hard link found through the --after repo is refused'],
    ['rel-link-unresolved', '*) p="$(dirname "$p")/$l" ;;', '*) p="$l" ;;', 'a symlink to the live tracked file is refused'],
    ['ok-label', 'if (used + 0 == peak[sd, u] + 0) chk = "ok"', 'if (used + 0 == peak[sd, u] + 0) chk = "okX"',
        'budget model: equal -> ok'],
    ['no-mismatch-note', 'if grep -q \'MISMATCH\' "$OUT/budget.$tier.tsv"; then', 'if false; then',
        'a budget-model MISMATCH prints a NOTE'],
];

for (const [name, from, to, failing] of MUTANTS) {
    test(`inlining-budget-diff --self-test MUST FAIL on mutant ${name}`, { skip }, () => {
        const dir = mkdtempSync(join(tmpdir(), `ibd-${name}-`));
        try {
            let anchor = from;
            if (from instanceof RegExp) {
                const m = readFileSync(SCRIPT, 'utf8').match(new RegExp(from.source, 'gm'));
                assert.equal(m && m.length, 1, `mutant ${name}: regex anchor must match exactly once`);
                anchor = m[0];
            }
            const r = selfTest(variant(dir, name, anchor, to));
            // red = exit 1, or 2 when the mutant breaks the planned-exit path itself (trap-ignores-final)
            assert.ok(r.status === 1 || r.status === 2, `mutant ${name} survived: ${r.stdout}${r.stderr}`);
            assert.match(r.stdout, /^self-test: \d+ check\(s\) FAILED$/m);
            assert.ok(r.stdout.split('\n').some((l) => l.startsWith('FAIL ') && l.includes(failing)),
                `mutant ${name}: expected a FAIL line naming "${failing}"\n${r.stdout}`);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
}
