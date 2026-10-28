// test/87-soak-owner.test.mjs -- burst 125, R3 OWNER batch H1 (PLAN-R3-owner.md TASK 3 + ASSERTIONS 2 + ADDENDA).
// Oracle: the interface contract of bench/soak/oracles.mjs (OW oracle: checkOwOrder / checkOwThis) and the B1 kernel
// facts (.handoff/b125-evidence/r3/README.md). No expected value is copied from a run of the new code.
// Groups: REG, ORDER (fires / silent), THIS, MALFORMED (TypeError matrix), KERNEL (B1 tree facts pinned on Signal.js),
// LANE (live, burst 126 H1b: bench/soak/lanes/owner.mjs imported directly; the lane is not rostered). Oracle rows are new (no prior OW export): they fail on the old code by import.
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../bench/soak/oracles.mjs';
import { createRegistry } from '../Signal.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Model } from '../bench/soak/model.mjs';
import { generateWorld } from '../bench/soak/gen.mjs';
import { runWorld } from '../bench/soak/exec.mjs';
import { liteS3Adapter } from '../bench/soak/adapters/lite-s3.mjs';
import { OWNER } from '../bench/soak/lanes/owner.mjs';

const WORLDS = 10;   // OWNER worlds per kernel in the mutant row
const { checkOwOrder, checkOwThis, ORACLES, SIGS } = O;

// tree: 1 -> 2 -> 3 (grandparent chain), 1 -> 4 (sibling of 2), 5 and 6 are unrelated roots. unknown ids -> -1.
const PAR = { 1: -1, 2: 1, 3: 2, 4: 1, 5: -1, 6: -1 };
const parentOf = (id) => (id in PAR ? PAR[id] : -1);
const f = (o, k) => ({ o, k });

describe('OW registration', () => {
    it('ORACLES holds OW and SIGS.OW is [cleanup-order, callback-this]', () => {
        assert.ok(ORACLES.includes('OW'), JSON.stringify(ORACLES));
        assert.deepEqual(SIGS.OW, ['cleanup-order', 'callback-this']);
    });
});

describe('ORDER: checkOwOrder fires', () => {
    const expectFire = (r) => {
        assert.notEqual(r, null);
        assert.equal(r.oracle, 'OW');
        assert.equal(r.sig, 'cleanup-order');
        assert.equal(typeof r.detail, 'string');
    };
    it('LIFO of 2 cleanups in one owner', () => expectFire(checkOwOrder([f(5, 1), f(5, 0)], parentOf)));
    it('LIFO of 3 (k 0,2,1)', () => expectFire(checkOwOrder([f(5, 0), f(5, 2), f(5, 1)], parentOf)));
    it('LIFO interleaved with another owner', () => expectFire(checkOwOrder([f(5, 1), f(6, 0), f(5, 0)], parentOf)));
    it('parent fires before child', () => expectFire(checkOwOrder([f(1, 0), f(2, 0)], parentOf)));
    it('child fires before grandchild (root silent)', () => expectFire(checkOwOrder([f(2, 0), f(3, 0)], parentOf)));
    it('grandparent fires before grandchild', () => expectFire(checkOwOrder([f(1, 0), f(3, 0)], parentOf)));
    it('grandchild, then grandparent, then child (grandparent before child)', () =>
        expectFire(checkOwOrder([f(3, 0), f(1, 0), f(2, 0)], parentOf)));
});

describe('ORDER: checkOwOrder silent on twins', () => {
    it('a repeated k is not a FIFO violation (the sentinel counts)', () => assert.equal(checkOwOrder([f(5, 0), f(5, 0)], parentOf), null));
    it('FIFO of 2 in one owner', () => assert.equal(checkOwOrder([f(5, 0), f(5, 1)], parentOf), null));
    it('child before parent', () => assert.equal(checkOwOrder([f(2, 0), f(1, 0)], parentOf), null));
    it('grandchild, child, grandparent', () => assert.equal(checkOwOrder([f(3, 0), f(2, 0), f(1, 0)], parentOf), null));
    it('sibling subtrees, order 1', () => assert.equal(checkOwOrder([f(3, 0), f(2, 0), f(4, 0), f(1, 0)], parentOf), null));
    it('sibling subtrees, order 2', () => assert.equal(checkOwOrder([f(4, 0), f(3, 0), f(2, 0), f(1, 0)], parentOf), null));
    it('a missing fire (k 0 and 2 only)', () => assert.equal(checkOwOrder([f(5, 0), f(5, 2)], parentOf), null));
    it('a missing fire (parent never fires)', () => assert.equal(checkOwOrder([f(3, 0), f(2, 0)], parentOf), null));
    it('unknown owners with parent -1', () => assert.equal(checkOwOrder([f(99, 0), f(77, 0), f(99, 1)], parentOf), null));
    it('empty fires', () => assert.equal(checkOwOrder([], parentOf), null));
    it('the B1 observed order is ok', () => {
        // P=1, A=2, B=4 (children of 1), G=3 under A: B.c1 B.c2 G.c1 G.c2 A.c1 A.c2 P.c1 P.c2
        const seq = [f(4, 0), f(4, 1), f(3, 0), f(3, 1), f(2, 0), f(2, 1), f(1, 0), f(1, 1)];
        assert.equal(checkOwOrder(seq, parentOf), null);
    });
});

describe('THIS: checkOwThis', () => {
    it('fires on this = []', () => {
        const r = checkOwThis('cleanup', []);
        assert.equal(r.oracle, 'OW');
        assert.equal(r.sig, 'callback-this');
        assert.ok(r.detail.includes('cleanup'));
        assert.ok(r.detail.includes('array(0)'));
    });
    it('fires on the full 2-element cleanup array (DIV-48 shape)', () => {
        const r = checkOwThis('cleanup', [() => {}, () => {}]);
        assert.equal(r.sig, 'callback-this');
        assert.ok(r.detail.includes('array(2)'));
    });
    it('fires on an object', () => {
        const r = checkOwThis('createRoot', {});
        assert.equal(r.oracle, 'OW');
        assert.equal(r.sig, 'callback-this');
        assert.ok(r.detail.includes('createRoot'));
        assert.ok(r.detail.includes('object'));
    });
    it('silent on undefined', () => assert.equal(checkOwThis('runWithOwner', undefined), null));
    it('fires on null (not undefined)', () => assert.equal(checkOwThis('x', null).sig, 'callback-this'));
});

describe('MALFORMED: TypeError matrix', () => {
    const bad = (fires, p = parentOf) => assert.throws(() => checkOwOrder(fires, p), TypeError);
    it('fires not an array', () => { bad(null); bad(undefined); bad({}); bad('ab'); });
    it('entry not an object', () => { bad([null]); bad([7]); });
    for (const v of [-0, -1, 1.5, NaN, '1', undefined, Infinity, null]) {
        const nm = Object.is(v, -0) ? '-0' : String(v);
        it('o = ' + nm, () => bad([{ o: v, k: 0 }]));
        it('k = ' + nm, () => bad([{ o: 5, k: v }]));
    }
    it('parentOf returns a non-int', () => { for (const v of [-0, -2, 1.5, NaN, '1', undefined, null]) bad([f(5, 0)], (id) => (id === 5 ? v : -1)); });
    it('parentOf not a function', () => { const ok = [f(5, 0)]; bad(ok, null); assert.throws(() => checkOwOrder(ok, undefined), TypeError); bad(ok, {}); bad(ok, 3); });
    it('parent cycle (2-cycle)', () => {
        const cyc = (id) => (id === 8 ? 9 : id === 9 ? 8 : -1);
        bad([f(8, 0), f(9, 0)], cyc);
    });
});

describe('KERNEL: B1 tree facts pinned on Signal.js', () => {
    it('dispose(P) fires B.c1 B.c2 A.c1 A.c2 P.c1 P.c2, this === undefined each; checkOwOrder null', () => {
        const r = createRegistry();
        const seq = [], thises = [];
        const reg = (name) => r.onCleanup(function () { seq.push(name); thises.push(this); });
        const dP = r.effect(() => {
            reg('P.c1');
            r.effect(() => { reg('A.c1'); reg('A.c2'); });
            r.effect(() => { reg('B.c1'); reg('B.c2'); });
            reg('P.c2');
        });
        assert.deepEqual(seq, []);
        dP();
        assert.deepEqual(seq, ['B.c1', 'B.c2', 'A.c1', 'A.c2', 'P.c1', 'P.c2']);
        assert.deepEqual(thises, [undefined, undefined, undefined, undefined, undefined, undefined]);
        // owner ids: P=1, A=2, B=3 (A,B children of P); k = ordinal within owner (name digit - 1)
        const id = { P: 1, A: 2, B: 3 };
        const fires = seq.map((s) => ({ o: id[s[0]], k: +s[3] - 1 }));
        assert.equal(checkOwOrder(fires, (x) => (x === 2 || x === 3 ? 1 : -1)), null);
    });
});

describe('LANE: OWNER lane rows (live; the lane is unrostered, imported directly)', () => {
    // Row 1 regression oracle: ASSERTIONS 1 (a cleanup with no live owner never fires). Fails if the lane (or model) logs a
    // fire / bumps the sentinel for a k = -1 registration; model + engine halves fail if addCleanup(-1) counts or the engine fires it.
    it('onCleanup outside an owner -> fired 0 (the cleanup never fires; model fired count stays 0)', () => {
        // model: no owner / unknown index / signal -> -1, fired stays 0
        const M = new Model({ childEffects: 'parent-run' });
        M.addSignal(0, 0, { role: 'sent' });
        M.setSentinel(0);
        assert.equal(M.addCleanup(-1), -1);
        assert.equal(M.addCleanup(99), -1);
        assert.equal(M.addCleanup(0), -1);
        assert.equal(M.fired, 0);
        assert.equal(M.n[0].v, 0);
        // engine: an onCleanup with no owner is a no-op; nothing fires across a root, an effect and a dispose
        const r = createRegistry();
        let calls = 0;
        r.onCleanup(() => { calls++; });
        const s = r.signal(0);
        const d = r.effect(() => { s(); });
        s.set(1);
        d();
        r.createRoot(() => { r.onCleanup(() => { calls++; }); });
        assert.equal(calls, 0);
        // lane: init (sentinel S + E_S + 4 rooted owners), then createRoot ops with 3 no-owner cleanups each, no owner node
        const script = generateWorld(OWNER, 0xB126, { steps: 0 });
        for (let j = 0; j < 3; j++) script.ops.push({ o: 'oroot', ci: -1, k: 'e', spec: null, cl: 3 });
        let cur = null;
        const laneOps = {};
        for (const k of Object.keys(OWNER.ops)) laneOps[k] = (x, op, sk) => { cur = x; return OWNER.ops[k](x, op, sk); };
        const res = runWorld(liteS3Adapter, script, { laneOps });
        assert.equal(res.failure, null);
        assert.ok(cur !== null && cur.ow !== null);
        assert.equal(cur.ow.fires.length, 0);
        assert.equal(cur.ow.st.fires, 0);
        assert.equal(cur.ow.sv, 0);
        assert.equal(cur.M.fired, 0);
    });

    // b130 B3 r1 (GATE TEETH + DOMAIN CHECK): a malformed cleanup count fails closed (owner.mjs checkCl) on each of
    // orwo.cl, oroot.cl and oroot.spec.cl separately; -0 is accepted and acts as 0. NaN runs first, so a coercing or
    // disabled check goes red before the unbounded values (Infinity / 2**31) could run the addCl loop out of memory.
    it('a malformed cleanup count (NaN, -1, 1.5, x, null, Infinity, 4, 2**31) on orwo.cl / oroot.cl / oroot.spec.cl throws; -0 acts as 0', () => {
        const base = () => generateWorld(OWNER, 0xB126, { steps: 0 });
        const fresh = (s) => 1 + Math.max(...[...JSON.stringify(s.ops).matchAll(/"c?i":(\d+)/g)].map((m) => Number(m[1])));
        const spec = (cl) => ({ k: 'outer', t: 2, pre: [], ic: null, icU: false, post: [], role: 'owner', cl });
        const SITES = {
            'orwo.cl': (s, v) => ({ o: 'orwo', h: 0, ci: -1, k: 'e', spec: null, cl: v, g: 0 }),
            'oroot.cl': (s, v) => ({ o: 'oroot', ci: -1, k: 'e', spec: null, cl: v }),
            'oroot.spec.cl': (s, v) => ({ o: 'oroot', ci: fresh(s), k: 'e', spec: spec(v), cl: 0 }),
        };
        assert.equal(base().ops[0].i, 0, 'index 0 is the sentinel signal (orwo h)');
        for (const v of [NaN, -1, 1.5, 'x', null, Infinity, 4, 2 ** 31]) {
            for (const site of Object.keys(SITES)) {
                const s = base();
                s.ops.push(SITES[site](s, v));
                assert.throws(() => runWorld(liteS3Adapter, s, { laneOps: OWNER.ops }), /is not a cleanup count/, site + ' = ' + String(v));
            }
        }
        for (const site of ['orwo.cl', 'oroot.cl']) {
            const s = base();
            s.ops.push(SITES[site](s, -0));
            assert.equal(runWorld(liteS3Adapter, s, { laneOps: OWNER.ops }).failure, null, site + ' = -0');
        }
    });

    // Row 2: ASSERTIONS 2. Fails if the mutant is not applied (0 failing worlds), if OW heads or appears in any world's
    // fails, if a head is not O1e / O4, or if the unmutated tree kernel fails a world (the control: not vacuously green).
    it('a dropped cleanup heads O1e/O4 via the sentinel, not OW (cleanup mutant: no OW breach)', () => {
        const ANCHOR = 'if (existing === undefined) currentOwner.cleanupFn = fn;';
        const src = readFileSync(new URL('../Signal.js', import.meta.url), 'utf8');
        assert.equal(src.split(ANCHOR).length - 1, 1, 'cleanup anchor must match exactly once');
        const tmp = mkdtempSync(join(tmpdir(), 'h1b-mut-'));
        try {
            writeFileSync(join(tmp, 'Signal.js'), src.replace(ANCHOR, 'if (existing === undefined) { /* assignment dropped (mutant) */ }'));
            copyFileSync(new URL('../Watch.js', import.meta.url), join(tmp, 'Watch.js'));
            const child = join(tmp, 'child.mjs');
            const root = new URL('../bench/soak/', import.meta.url).href;
            writeFileSync(child, [
                "const { liteS3Adapter } = await import('" + root + "adapters/lite-s3.mjs');",
                "const { generateWorld } = await import('" + root + "gen.mjs');",
                "const { runWorld } = await import('" + root + "exec.mjs');",
                "const { seedFor, worldSeed } = await import('" + root + "seeds.mjs');",
                "const { OWNER } = await import('" + new URL('../bench/soak/lanes/owner.mjs', import.meta.url).href + "');",
                'const cyc = seedFor(0xC0FFEE, OWNER.index, 0);',
                'const out = { n: 0, failing: 0, heads: [], all: [] };',
                'for (let w = 0; w < ' + WORLDS + '; w++) {',
                '  const r = runWorld(liteS3Adapter, generateWorld(OWNER, worldSeed(cyc, w), {}), { laneOps: OWNER.ops });',
                '  out.n++;',
                '  if (r.failure === null) continue;',
                '  out.failing++;',
                '  out.heads.push(r.failure.fails[0].oracle);',
                '  for (const f of r.failure.fails) out.all.push(f.oracle);',
                '}',
                'console.log("RESULT " + JSON.stringify(out));',
            ].join('\n'));
            const run = (kernel) => {
                const p = spawnSync(process.execPath, [child], { env: { ...process.env, SOAK_KERNEL: kernel }, encoding: 'utf8', timeout: 120000 });
                assert.equal(p.status, 0, 'child exit ' + p.status + ' ' + String(p.stderr).slice(0, 400));
                const line = p.stdout.split('\n').find((l) => l.startsWith('RESULT '));
                assert.ok(line !== undefined, 'no RESULT line: ' + p.stdout.slice(0, 200));
                return JSON.parse(line.slice(7));
            };
            const mut = run(join(tmp, 'Signal.js'));
            assert.equal(mut.n, WORLDS);
            assert.ok(mut.failing > 0, 'mutant must fail >= 1 world');
            for (const h of mut.heads) assert.ok(h === 'O1e' || h === 'O4', 'head ' + h + ' is not O1e / O4');
            assert.equal(mut.all.includes('OW'), false, 'no OW breach on the cleanup mutant');
            const ctl = run(fileURLToPath(new URL('../Signal.js', import.meta.url)));
            assert.equal(ctl.n, WORLDS);
            assert.equal(ctl.failing, 0, 'unmutated tree kernel: 0 failing worlds');
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
