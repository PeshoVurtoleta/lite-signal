// test/65-hot-body-pins.test.mjs -- burst 63 (PLAN-0w C2): source pins for the 8 hot bodies of the engine.
// Maintainer ruling R1 (b63): the hot-body gate is a per-function SOURCE pin (sha256 first 16 hex + UTF-8 byte length
// of the exact body text), V8-independent; there is no bytecode gate. A body = from the start of the unique line
// `    function NAME(` (4-space indent) through its matching close brace. The extractor is a small lexer: braces inside
// string / template / regex literals and comments do not count; ${...} inside templates nests. Regex detection is the
// usual previous-token heuristic, so the test also asserts the 8 bodies hold NO regex literal (fail closed: a body
// that gains one needs this extractor re-checked by hand before it is re-pinned).
// Fail closed: a name that is missing, or whose `function NAME(` occurs more than once, is an error naming it.
// RE-PIN = DELIBERATE: any edit to one of these bodies turns this test red by design. Re-pin in the SAME commit as the
// engine edit, after review: `HOT_BODY_PRINT=1 node --test test/65-hot-body-pins.test.mjs` prints the current table
// (diagnostic only; the test still asserts). Sibling pin: bench/soak/parity.json (engine parity), re-pinned likewise.
// Cross-check at pin time (b63): an independent extractor, .handoff/b62-evidence/qa/hotbody.mjs, gave the same 7 sha16.
// b102 (FIX-T W2, PLAN-0s-fixt ADDENDUM 7 task 6): pullComputed split into the refreshComputed body + a thin
// wrapper; both are pinned (8 bodies). The other 6 pins are byte-identical to b63. The computed read closure is an
// anonymous function expression (not `function NAME(`), so it is NOT pinned here (b102: unchanged scope).
// b104 (LEDGER #44, PLAN-44 TASK 6): the four readers are pinned too (12 bodies). boxGet + boxComputedGet by name;
// the two `const read = () => {` closures as readSignal / readComputed via an anchor extractor that searches only
// inside the 4-space `function signal(` / `function computed(` body and fails closed on 0 or >1 hits there.
// Kernel: LITE_SIGNAL_KERNEL (absolute path to a Signal.js), default ../Signal.js. Source is read, never imported.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KPATH = process.env.LITE_SIGNAL_KERNEL ?? fileURLToPath(new URL('../Signal.js', import.meta.url));
const SRC = readFileSync(KPATH, 'utf8');

// Pinned on Signal.js sha256/8 d07e0b17 (burst 63); pullComputed re-pinned + refreshComputed added on 4292ebea (b102);
// the four readers added on e912e302 (b104, LEDGER #44); createNode + disposeNode re-pinned on 0f75866f (b108, A3 FIX-R).
const PINS = {
    flushEffects: { sha16: 'b4b77b7b0a6a8e2f', bytes: 2270 },
    executeEffect: { sha16: 'b054d7c092b84fa2', bytes: 3475 },
    createNode: { sha16: '7a8c545056853c6a', bytes: 3780 },
    nodeMiss: { sha16: 'c6aa7fbe2f7077f0', bytes: 1535 },
    disposeNode: { sha16: 'a79e91b70041f7eb', bytes: 6599 },
    effectTail: { sha16: '1b80da7167ba5bbf', bytes: 93 },
    pullComputed: { sha16: '5420227134aa9791', bytes: 346 },
    refreshComputed: { sha16: 'ed8d9d7ae754ef9b', bytes: 5005 },
    boxGet: { sha16: '2938d89e667b9f07', bytes: 640 },
    boxComputedGet: { sha16: '5940c249c8717ecf', bytes: 618 },
    readSignal: { sha16: 'bb06aefbf682ef8f', bytes: 605 },
    readComputed: { sha16: 'bb6f6be2c79aeb23', bytes: 991 },
};
const NAMES = ['flushEffects', 'executeEffect', 'createNode', 'nodeMiss', 'disposeNode', 'effectTail', 'pullComputed',
    'refreshComputed', 'boxGet', 'boxComputedGet', 'readSignal', 'readComputed'];

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
    return scanBody(src, name, start, start + 4 + needle.length, '');
}

// Lexes from i (just after the opening `(` of the parameter list) to the brace that closes the body. `tail` is the
// only text allowed after that brace on its line ('' for a declaration, ';' for `const x = () => {...};`); the
// returned text runs from `start` through the tail.
function scanBody(src, name, start, i, tail) {
    const stats = { comments: 0, strings: 0, templates: 0, regexes: 0 };
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
                if (src.slice(end, k) !== tail) fail('found text after the closing brace on its line');
                return { text: src.slice(start, end + tail.length), start, end: end + tail.length, stats };
            }
        }
        prev = c; prevWord = ''; i++;
    }
    return fail('ran off the end of the source (unbalanced braces)');
}

// b104 (LEDGER #44 TASK 6): the anonymous `const read = () => {` closure inside the 4-space `function OUTER(` body.
// Fail closed: OUTER missing or not unique at 4-space indent, the closure declared 0 or >1 times inside it (any
// `const|let|var read =` counts, so a respaced twin cannot shadow the pin), or not at an 8-space line start.
const READ_ANCHOR = 'const read = () => {';
function extractReadClosure(src, label, outer) {
    const outerHits = (src.match(new RegExp('^    function\\s*\\*?\\s*' + outer + '\\s*\\(', 'gm')) || []).length;
    if (outerHits !== 1) throw new Error(label + ': `    function ' + outer + '(` occurs ' + outerHits + 'x (must be 1)');
    const oStart = src.indexOf('\n    function ' + outer + '(') + 1;
    if (oStart === 0) throw new Error(label + ': `function ' + outer + '(` not in canonical form');
    const o = scanBody(src, label + ' (outer ' + outer + ')', oStart, oStart + 14 + outer.length, '');
    const decls = (o.text.match(/(^|[^A-Za-z0-9_$.])(const|let|var)\s+read\s*=/g) || []).length;
    if (decls !== 1) throw new Error(label + ': `' + READ_ANCHOR + '` occurs ' + decls + 'x inside ' + outer + ' (must be 1)');
    const rel = o.text.indexOf('\n        ' + READ_ANCHOR);
    if (rel === -1) throw new Error(label + ': `' + READ_ANCHOR + '` not at an 8-space line start inside ' + outer);
    const start = o.start + rel + 1;
    return scanBody(src, label, start, start + 8 + READ_ANCHOR.indexOf('(') + 1, ';');
}
const ANCHORED = { readSignal: 'signal', readComputed: 'computed' };
const extractPinned = (src, nm) => (Object.hasOwn(ANCHORED, nm) ? extractReadClosure(src, nm, ANCHORED[nm])
    : extractBody(src, nm));

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
                const p = pinOf(extractPinned(SRC, nm).text);
                row = '    ' + nm + ": { sha16: '" + p.sha16 + "', bytes: " + p.bytes + ' },';
            } catch (e) { row = '    // ' + e.message; }
            rows.push(row);
            t.diagnostic(row.trim());
        }
        console.log('// HOT_BODY_PRINT (sha256/8 ' + sha.slice(0, 8) + ')\nconst PINS = {\n' + rows.join('\n') + '\n};');
    }
    assert.equal(NAMES.length, 12, 'exactly 12 hot bodies (PLAN-0w C2 + b102 refreshComputed + b104 the four readers)');
    assert.deepEqual(Object.keys(PINS).sort(), NAMES.slice().sort(), 'pin table must cover exactly the 12 hot bodies');
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

describe('read-closure anchor extractor self-test (synthetic sources)', () => {
    const one = '        const read = () => {\n            if (x) { return \'}\'; }\n            return 1;\n        };';
    const sig = (inner) => 'const a = 1;\n    function signal(v) {\n' + inner + '\n        return read;\n    }\n' +
        'export function signal(v) { return 0; }\n';
    it('extracts the closure through its `};` (a column-0 export twin of the outer does not count)', () => {
        const got = extractReadClosure(sig(one), 'readSignal', 'signal');
        assert.equal(got.text, one);
        assert.equal(got.stats.strings, 1);
    });
    it('fails closed on two closures inside the outer body', () => {
        assert.throws(() => extractReadClosure(sig(one + '\n' + one), 'readSignal', 'signal'), /readSignal: .*occurs 2x inside signal/);
    });
    it('fails closed on a respaced twin inside the outer body', () => {
        const twin = '        const read=() => 2;';
        assert.throws(() => extractReadClosure(sig(one + '\n' + twin), 'readSignal', 'signal'), /occurs 2x inside signal/);
    });
    it('fails closed on 0 hits inside the outer body (an anchor outside it does not count)', () => {
        const src = sig('        const r = 1;') + '    function other() {\n' + one + '\n    }\n';
        assert.throws(() => extractReadClosure(src, 'readSignal', 'signal'), /readSignal: .*occurs 0x inside signal/);
    });
    it('fails closed on a missing or duplicated 4-space outer', () => {
        assert.throws(() => extractReadClosure(sig(one), 'readComputed', 'computed'), /readComputed: .*computed\(` occurs 0x/);
        assert.throws(() => extractReadClosure(sig(one) + sig(one), 'readSignal', 'signal'), /readSignal: .*signal\(` occurs 2x/);
    });
    it('fails closed on a closure not at an 8-space line start', () => {
        const deep = '            const read = () => {\n                return 1;\n            };';
        assert.throws(() => extractReadClosure(sig(deep), 'readSignal', 'signal'), /not at an 8-space line start/);
    });
    it('fails closed on text after the closing `};`', () => {
        const bad = '        const read = () => {\n            return 1;\n        }; x();';
        assert.throws(() => extractReadClosure(sig(bad), 'readSignal', 'signal'), /found text after the closing brace/);
    });
});

describe('hot-body source pins', () => {
    for (const nm of NAMES) {
        it(nm, (t) => {
            const body = extractPinned(SRC, nm);
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
