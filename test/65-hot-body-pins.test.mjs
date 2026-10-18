// test/65-hot-body-pins.test.mjs -- burst 63 (PLAN-0w C2): source pins for the 7 hot bodies of the engine.
// Maintainer ruling R1 (b63): the hot-body gate is a per-function SOURCE pin (sha256 first 16 hex + UTF-8 byte length
// of the exact body text), V8-independent; there is no bytecode gate. A body = from the start of the unique line
// `    function NAME(` (4-space indent) through its matching close brace. The extractor is a small lexer: braces inside
// string / template / regex literals and comments do not count; ${...} inside templates nests. Regex detection is the
// usual previous-token heuristic, so the test also asserts the 7 bodies hold NO regex literal (fail closed: a body
// that gains one needs this extractor re-checked by hand before it is re-pinned).
// Fail closed: a name that is missing, or whose `function NAME(` occurs more than once, is an error naming it.
// RE-PIN = DELIBERATE: any edit to one of these bodies turns this test red by design. Re-pin in the SAME commit as the
// engine edit, after review: `HOT_BODY_PRINT=1 node --test test/65-hot-body-pins.test.mjs` prints the current table
// (diagnostic only; the test still asserts). Sibling pin: bench/soak/parity.json (engine parity), re-pinned likewise.
// Cross-check at pin time (b63): an independent extractor, .handoff/b62-evidence/qa/hotbody.mjs, gave the same 7 sha16.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js. Source is read, never imported.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? fileURLToPath(new URL('../Signal.js', import.meta.url));
const SRC = readFileSync(KPATH, 'utf8');

// Pinned on Signal.js sha256/8 d07e0b17 (burst 63).
const PINS = {
    flushEffects: { sha16: 'b4b77b7b0a6a8e2f', bytes: 2270 },
    executeEffect: { sha16: 'b054d7c092b84fa2', bytes: 3475 },
    createNode: { sha16: '3d19dc3fcd2ba343', bytes: 3757 },
    nodeMiss: { sha16: 'c6aa7fbe2f7077f0', bytes: 1535 },
    disposeNode: { sha16: 'd6262e1a459f3746', bytes: 6547 },
    effectTail: { sha16: '1b80da7167ba5bbf', bytes: 93 },
    pullComputed: { sha16: 'e4ef82dabc56d21b', bytes: 5055 },
};
const NAMES = ['flushEffects', 'executeEffect', 'createNode', 'nodeMiss', 'disposeNode', 'effectTail', 'pullComputed'];

const ID_CHAR = /[A-Za-z0-9_$]/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
    'case', 'do', 'else', 'yield', 'await']);

// Returns { text, start, end, stats } for the body of `function NAME(`; throws (naming NAME) on any doubt.
function extractBody(src, name) {
    const needle = 'function ' + name + '(';
    // Any declaration form counts (`function nodeMiss () {`, `function* x(`): a later spaced twin would shadow the pin.
    const count = (src.match(new RegExp('(^|[^A-Za-z0-9_$])function\\s*\\*?\\s*' + name + '\\s*\\(', 'g')) || []).length;
    if (count === 0) throw new Error(name + ': `function ' + name + '(` not found (missing hot body)');
    if (count > 1) throw new Error(name + ': `function ' + name + '(` occurs ' + count + 'x (must be unique)');
    const lineNeedle = '\n    ' + needle;
    const at = src.indexOf(lineNeedle);
    if (at === -1) throw new Error(name + ': not at the start of a line with 4-space indent');
    const start = at + 1;
    const stats = { comments: 0, strings: 0, templates: 0, regexes: 0 };
    let i = start + 4 + needle.length;
    let paren = 1;
    let prev = '(';         // last significant (non-space, non-comment) char, for the regex heuristic
    let prevWord = '';
    const stack = [];       // 'b' = code brace, 't' = template ${ ... }
    let bodyOpen = false;
    const n = src.length;
    const fail = (why) => { throw new Error(name + ': extractor ' + why + ' at offset ' + i); };
    const skipQuoted = (q) => {
        i++;
        while (i < n && src[i] !== q) { if (src[i] === '\\') i++; else if (src[i] === '\n') fail('newline in string'); i++; }
        if (i >= n) fail('unterminated string');
        i++;
    };
    // Scans template chars from i (just after ` or after the } closing a ${}). Returns true when ${ opened.
    const scanTemplate = () => {
        while (i < n) {
            const c = src[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '`') { i++; return false; }
            if (c === '$' && src[i + 1] === '{') { i += 2; stack.push('t'); return true; }
            i++;
        }
        return fail('unterminated template');
    };
    while (i < n) {
        const c = src[i];
        const d = src[i + 1];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        if (c === '/' && d === '/') {
            stats.comments++;
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && d === '*') {
            stats.comments++;
            const e = src.indexOf('*/', i + 2);
            if (e === -1) fail('unterminated block comment');
            i = e + 2;
            continue;
        }
        if (c === '\'' || c === '"') { stats.strings++; skipQuoted(c); prev = 'a'; prevWord = ''; continue; }
        if (c === '`') { stats.templates++; i++; scanTemplate(); prev = 'a'; prevWord = ''; continue; }
        if (c === '/') {
            const isRegex = '(,=:[!&|?{};+-*%<>~^'.includes(prev) || REGEX_AFTER_WORD.has(prevWord);
            if (isRegex) {
                stats.regexes++;
                i++;
                let cls = false;
                while (i < n) {
                    const r = src[i];
                    if (r === '\\') { i += 2; continue; }
                    if (r === '\n') fail('newline in regex');
                    if (cls) { if (r === ']') cls = false; } else if (r === '[') cls = true; else if (r === '/') break;
                    i++;
                }
                if (i >= n) fail('unterminated regex');
                i++;
                while (i < n && ID_CHAR.test(src[i])) i++;
                prev = 'a'; prevWord = '';
                continue;
            }
            prev = '/'; prevWord = ''; i++;
            continue;
        }
        if (ID_CHAR.test(c)) {
            let j = i;
            while (j < n && ID_CHAR.test(src[j])) j++;
            prevWord = src.slice(i, j);
            prev = 'a';
            i = j;
            continue;
        }
        if (!bodyOpen) {
            if (c === '(') paren++;
            else if (c === ')') paren--;
            else if (c === '{' && paren === 0) { bodyOpen = true; stack.push('b'); }
            else if (c === '{') stack.push('b');
            else if (c === '}') { if (stack.pop() === 't') { i++; scanTemplate(); prev = 'a'; continue; } }
            prev = c; prevWord = ''; i++;
            continue;
        }
        if (c === '{') stack.push('b');
        else if (c === '}') {
            const top = stack.pop();
            if (top === undefined) fail('unbalanced close brace');
            if (top === 't') { i++; scanTemplate(); prev = 'a'; prevWord = ''; continue; }
            if (stack.length === 0) {
                const end = i + 1;
                let k = end;
                while (k < n && src[k] !== '\n') k++;
                if (src.slice(end, k).length !== 0) fail('found text after the closing brace on its line');
                return { text: src.slice(start, end), start, end, stats };
            }
        }
        prev = c; prevWord = ''; i++;
    }
    return fail('ran off the end of the source (unbalanced braces)');
}

function pinOf(text) {
    const sha16 = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
    return { sha16, bytes: Buffer.byteLength(text, 'utf8') };
}

test('kernel under test', (t) => {
    const sha = createHash('sha256').update(readFileSync(KPATH)).digest('hex');
    t.diagnostic('kernel ' + KPATH + ' sha256 ' + sha);
    if (process.env.HOT_BODY_PRINT === '1') {
        const rows = [];
        for (const nm of NAMES) {
            let row;
            try {
                const p = pinOf(extractBody(SRC, nm).text);
                row = '    ' + nm + ": { sha16: '" + p.sha16 + "', bytes: " + p.bytes + ' },';
            } catch (e) { row = '    // ' + e.message; }
            rows.push(row);
            t.diagnostic(row.trim());
        }
        console.log('// HOT_BODY_PRINT (sha256/8 ' + sha.slice(0, 8) + ')\nconst PINS = {\n' + rows.join('\n') + '\n};');
    }
    assert.equal(NAMES.length, 7, 'exactly 7 hot bodies (PLAN-0w C2)');
    assert.deepEqual(Object.keys(PINS).sort(), NAMES.slice().sort(), 'pin table must cover exactly the 7 hot bodies');
});

describe('extractor self-test (synthetic sources)', () => {
    const wrap = (body) => 'const a = 1;\n    function hot(x, y = { k: 1 }) {\n' + body + '\n    }\nconst z = 2;\n';
    it('ignores braces in strings, templates, comments and regexes; nests ${}', () => {
        const body = [
            "        const s = '}' + \"{\" + '\\'}';",
            '        // } a stray close in a line comment',
            '        /* { an open in a block comment */',
            '        const t = `}${ { a: `{${x}}` }.a }}`;',
            '        const re = /[}{]\\}/g; const q = x / y / 2;',
            '        if (x) { return re.test(s) ? t : q; }',
        ].join('\n');
        const src = wrap(body);
        const got = extractBody(src, 'hot');
        assert.equal(got.text, src.slice(src.indexOf('    function hot('), src.indexOf('\n    }\n') + 6));
        assert.equal(got.stats.regexes, 1);
        assert.equal(got.stats.templates, 2);
        assert.ok(got.stats.comments === 2 && got.stats.strings === 3);
    });
    it('fails closed on a missing name', () => {
        assert.throws(() => extractBody(wrap('        return 1;'), 'nodeMiss'), /nodeMiss: .*not found/);
    });
    it('fails closed on a duplicated name', () => {
        const src = wrap('        return 1;') + wrap('        return 2;');
        assert.throws(() => extractBody(src, 'hot'), /hot: .*occurs 2x/);
    });
    it('fails closed on a name not at 4-space line start', () => {
        assert.throws(() => extractBody('function hot() { return 1; }\n', 'hot'), /hot: not at the start/);
    });
    it('fails closed on unbalanced braces', () => {
        assert.throws(() => extractBody('x;\n    function hot() {\n        if (a) {\n', 'hot'), /hot: extractor ran off/);
    });
    it('a prefix-sharing name is not counted as a duplicate', () => {
        const src = wrap('        return 1;') + '    function xhot() { return 2; }\n    function hotter() {}\n';
        assert.equal(extractBody(src, 'hot').stats.regexes, 0);
    });
});

describe('hot-body source pins', () => {
    for (const nm of NAMES) {
        it(nm, (t) => {
            const body = extractBody(SRC, nm);
            const got = pinOf(body.text);
            const line = SRC.slice(0, body.start).split('\n').length;
            t.diagnostic(nm + ' line ' + line + ' sha16 ' + got.sha16 + ' bytes ' + got.bytes +
                ' stats ' + JSON.stringify(body.stats));
            assert.equal(body.stats.regexes, 0, nm + ': hot body holds a regex literal -- re-check the extractor by hand');
            assert.deepEqual(got, PINS[nm], nm + ': hot body changed (pinned ' + PINS[nm].sha16 + '/' + PINS[nm].bytes +
                'B, now ' + got.sha16 + '/' + got.bytes + 'B) -- re-pin deliberately, same commit as the engine edit');
        });
    }
});
