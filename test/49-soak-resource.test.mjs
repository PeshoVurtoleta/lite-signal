/**
 * test/49 -- the RSS sampler and its statistics (SPEC-S2-groupB task 1, ASSERTIONS 2).
 *
 * Oracle: a NAIVE reference sampler written here from the plan text: a Float64Array-sized store of RSS_BUF = 256
 * slots; push number i (0-based, counted over ALL pushes) is accepted iff i % stride === 0; when the store is full
 * keep the even indices and double the stride. p95 is nearest-rank (rank = ceil(0.95 n), 1-based, computed in
 * integers as ceil(95 n / 100)); bandMedian is the median.
 *
 * Surface used (names taken from rss.mjs after the reviewer ruling; the EXPECTED values stay from the plan): `new RssSampler()`,
 * push(v), samples(), stride, count, pushes, p95(), max(), p95(arr), bandMedian(arr). Compaction is eager (at the 256th stored
 * sample); the exact boundaries N = 256 * 2^k are still excluded from the random comparison and covered by hand elsewhere.
 * Fail closed: a non-number / NaN / +-Infinity / negative sample throws and is a byte-identical no-op; the array statistics
 * return NaN for an empty input or any element that is not a finite number >= 0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RssSampler, RSS_BUF, p95, bandMedian } from '../bench/soak/rss.mjs';

/* seeded 32-bit-exact PRNG (mulberry32); independent streams for sizes and values */
function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class RefSampler {
    constructor() { this.buf = []; this.stride = 1; this.i = 0; }
    push(v) {
        if (this.i % this.stride === 0) {
            this.buf.push(v);
            if (this.buf.length === 256) { this.buf = this.buf.filter((_, j) => j % 2 === 0); this.stride *= 2; }
        }
        this.i++;
    }
}

const retained = (s) => s.samples();

const refP95 = (a) => { const s = Array.from(a).sort((x, y) => x - y); return s[Math.ceil((95 * s.length) / 100) - 1]; };
const BOUNDARY = (n) => n >= 256 && (n & (n - 1)) === 0;      // 256 * 2^k are exactly the powers of two >= 256

test('RSS_BUF is 256', () => { assert.equal(RSS_BUF, 256); });

test('RssSampler: below the first compaction every push is retained in order, stride 1', () => {
    const s = new RssSampler();
    for (let i = 0; i < 255; i++) s.push(100 + i);
    assert.equal(s.stride, 1);
    assert.deepEqual(retained(s), Array.from({ length: 255 }, (_, i) => 100 + i));
});

test('RssSampler: the stride doubles at the 256th accepted sample and keeps the even indices (hand-computed)', () => {
    const s = new RssSampler();
    for (let i = 0; i < 300; i++) s.push(i);       // sample value == push index
    // compaction at accepted #256 keeps indices 0,2,...,254 (128 samples), stride 2; then pushes 256..299 accept the evens.
    const want = [];
    for (let i = 0; i <= 254; i += 2) want.push(i);
    for (let i = 256; i < 300; i += 2) want.push(i);
    assert.equal(s.stride, 2);
    assert.deepEqual(retained(s), want);
});

test('RssSampler vs the naive reference: 300 seeded random runs, state equal (retained samples and stride)', () => {
    const sizeRng = prng(0x5EED0001), valRng = prng(0x5EED0002);
    let trials = 0, deep = 0, maxStride = 0;
    while (trials < 300) {
        const n = 1 + Math.floor(sizeRng() * 6000);
        if (BOUNDARY(n)) continue;
        const real = new RssSampler(), ref = new RefSampler();
        let mx = -Infinity;
        for (let i = 0; i < n; i++) { const v = 50 + valRng() * 400; real.push(v); ref.push(v); if (v > mx) mx = v; }
        const got = retained(real);
        assert.equal(real.p95(), refP95(ref.buf), 'sampler p95 over the retained samples, n=' + n);
        assert.equal(real.max(), mx, 'max over EVERY push (decimated ones included), n=' + n);
        assert.equal(real.pushes, n);
        assert.equal(real.stride, ref.stride, 'stride n=' + n);
        assert.deepEqual(got, ref.buf, 'retained n=' + n);
        assert.ok(got.length <= RSS_BUF && got.length >= 1, 'bounded and non-empty');
        trials++;
        if (ref.stride >= 8) deep++;
        if (ref.stride > maxStride) maxStride = ref.stride;
    }
    // coverage floor: the stride-doubling path must really be exercised (n up to 6000 reaches stride 32 at the top).
    assert.ok(deep >= 60, 'trials with stride >= 8: ' + deep);
    assert.ok(maxStride >= 16, 'max stride reached ' + maxStride);
});

/* ---- p95 (nearest rank) ----------------------------------------------------------------------------- */

test('p95: hand-computed nearest-rank values', () => {
    const seq = (n) => Array.from({ length: n }, (_, i) => i + 1);      // 1..n, so the answer is the rank itself
    assert.equal(p95([42]), 42);
    assert.equal(p95(seq(20)), 19, 'n=20: ceil(19) = 19th');
    assert.equal(p95(seq(21)), 20, 'n=21: ceil(19.95) = 20th');
    assert.equal(p95(seq(100)), 95, 'n=100: 95th');
    assert.equal(p95(seq(256)), 244, 'n=256: ceil(243.2) = 244th');
    assert.equal(p95(seq(10)), 10, 'n=10: ceil(9.5) = 10th');
});

test('p95 vs the reference on 200 seeded shuffled arrays (plain and Float64Array); order of input is irrelevant', () => {
    const sizeRng = prng(0xA11CE001), valRng = prng(0xA11CE002);
    let big = 0;
    for (let t = 0; t < 200; t++) {
        const n = 1 + Math.floor(sizeRng() * 300);
        const arr = Array.from({ length: n }, () => Math.floor(valRng() * 1000) / 4);
        assert.equal(p95(arr), refP95(arr), 'n=' + n);
        assert.equal(p95(Float64Array.from(arr)), refP95(arr), 'typed n=' + n);
        if (n >= 100) big++;
    }
    assert.ok(big >= 100, 'coverage floor: arrays with n >= 100: ' + big);
});

test('p95 / bandMedian fail closed: empty and NaN-containing input never yield a finite number', () => {
    const fin = (x) => typeof x === 'number' && Number.isFinite(x);
    assert.ok(!fin(p95([])), 'p95 empty');
    assert.ok(!fin(p95([1, 2, NaN, 4])), 'p95 NaN sample');
    assert.ok(!fin(bandMedian([])), 'bandMedian empty');
    assert.ok(!fin(bandMedian([1, NaN, 3])), 'bandMedian NaN sample');
});

/* ---- bandMedian ------------------------------------------------------------------------------------- */

test('bandMedian: odd-length medians vs the reference (even length is not pinned by the plan)', () => {
    assert.equal(bandMedian([7]), 7);
    assert.equal(bandMedian([3, 1, 2]), 2);
    assert.equal(bandMedian([100, 90, 110, 95, 105]), 100);
    const rng = prng(0xBADA55);
    for (let t = 0; t < 100; t++) {
        const n = 2 * Math.floor(rng() * 40) + 1;
        const arr = Array.from({ length: n }, () => Math.floor(rng() * 5000) / 8);
        const want = Array.from(arr).sort((a, b) => a - b)[(n - 1) / 2];
        assert.equal(bandMedian(arr), want, 'n=' + n);
    }
});

/* ---- fail closed ------------------------------------------------------------------------------------ */

test('RssSampler.push refuses null, undefined, "5", NaN, -1, Infinity: throws and changes nothing', () => {
    const s = new RssSampler();
    for (let i = 0; i < 40; i++) s.push(100 + i);
    const snap = () => JSON.stringify([s.pushes, s.count, s.stride, s.samples(), s.max(), s.p95()]);
    const before = snap();
    for (const bad of [null, undefined, '5', NaN, -1, Infinity, -Infinity, {}, true]) {
        assert.throws(() => s.push(bad), undefined, 'push(' + String(bad) + ')');
        assert.equal(snap(), before, 'state unchanged after push(' + String(bad) + ')');
    }
    s.push(0);   // 0 is a legal sample (>= 0)
    assert.equal(s.pushes, 41);
    assert.equal(s.max(), 139);
});

test('RssSampler empty: p95() and max() are NaN (null is not zero); reset() returns to the empty state', () => {
    const s = new RssSampler();
    assert.ok(Number.isNaN(s.p95()) && Number.isNaN(s.max()));
    for (let i = 0; i < 700; i++) s.push(10 + i);
    s.reset();
    assert.equal(s.stride, 1); assert.equal(s.count, 0); assert.equal(s.pushes, 0);
    assert.ok(Number.isNaN(s.p95()) && Number.isNaN(s.max()));
});

test('p95 / bandMedian over an array holding null, undefined, a string, a negative or Infinity are NaN', () => {
    for (const bad of [null, undefined, '5', -1, Infinity, -Infinity]) {
        const a = [10, 20, 30, bad, 40];
        assert.ok(Number.isNaN(p95(a)), 'p95 with ' + String(bad));
        assert.ok(Number.isNaN(bandMedian(a)), 'bandMedian with ' + String(bad));
    }
    assert.equal(p95([10, 20, 30, 0, 40]), 40, 'control: 0 is a legal value');
});

test('RssSampler constructor rejects cap < 4 (2 and 3 throw RangeError; 4 is the smallest legal cap)', () => {
    // module header: cap is a power of two in [4, RSS_CAP_MAX]; cap 2 would let stride exceed 2^30
    for (const cap of [0, 1, 2, 3, 5, 6, 100, -4, NaN, '8']) assert.throws(() => new RssSampler(cap), RangeError, 'cap ' + String(cap));
    assert.equal(new RssSampler(4).cap, 4);
});

test('RssSampler: push after reset() recomputes max() / p95() from scratch (no stale max)', () => {
    const r = new RssSampler(8);
    for (const v of [500, 600, 700, 900]) r.push(v);
    assert.equal(r.max(), 900);
    r.reset();
    assert.ok(Number.isNaN(r.max()) && Number.isNaN(r.p95()), 'empty after reset');
    r.push(10); r.push(20); r.push(30);
    assert.equal(r.max(), 30, 'max is over post-reset pushes only');
    assert.equal(r.p95(), 30, 'nearest-rank p95 of [10,20,30] is v[ceil(2.85)-1] = 30');
    assert.deepEqual(r.samples(), [10, 20, 30]);
    assert.equal(r.pushes, 3); assert.equal(r.stride, 1);
});
