// createRegistry input validation (1.4.5 backport into 1.6.0-beta-1).
//
// The full config matrix from BRIEF_SIGNAL.md. Every malformed row must throw a
// TypeError prefixed `createRegistry: "<name>"` -- naming the bad OPTION (or the
// unknown KEY) -- and NO row may reach the internal `TypeError: ... reading
// 'nextFree'` the unvalidated constructor produced on first use. Accepted rows are
// listed explicitly. Only createRegistry's cold construction path changed; the hot
// paths and torture gates are unchanged.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRegistry } from "../Signal.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const NAMED_OPTION = /^createRegistry: "(maxNodes|maxLinks|prealloc|onCapacityExceeded|maxFlushPasses|config)"/;
const NAMED_UNKNOWN = /^createRegistry: "[^"]+" is not a recognized option/;
const NEXTFREE = /nextFree/;

const MATRIX = [
    ["maxNodes: -1", { maxNodes: -1 }, "option"],
    ["maxNodes: 0", { maxNodes: 0 }, "option"],
    ["maxNodes: 1.5", { maxNodes: 1.5 }, "option"],
    ["maxNodes: \"32\"", { maxNodes: "32" }, "option"],
    ["maxNodes: null", { maxNodes: null }, "option"],
    ["maxNodes: NaN", { maxNodes: NaN }, "option"],
    // maxNodes: Infinity and 1e9 are OOM rows -> child process (see below).
    ["maxLinks: -1", { maxLinks: -1 }, "option"],
    // maxLinks: Infinity is an OOM row -> child process.
    ["prealloc: \"eger\"", { prealloc: "eger" }, "option"],
    ["prealloc: \"EAGER\"", { prealloc: "EAGER" }, "option"],
    ["prealloc: true", { prealloc: true }, "option"],
    ["prealloc: \"lazy\" + maxNodes: Infinity", { prealloc: "lazy", maxNodes: Infinity }, "option"],
    ["onCapacityExceeded: \"Grow\"", { onCapacityExceeded: "Grow" }, "option"],
    ["onCapacityExceeded: \"gro\"", { onCapacityExceeded: "gro" }, "option"],
    ["onCapacityExceeded: 1", { onCapacityExceeded: 1 }, "option"],
    ["maxFlushPasses: 0", { maxFlushPasses: 0 }, "option"],
    ["maxFlushPasses: -5", { maxFlushPasses: -5 }, "option"],
    ["maxNods: 32 (typo key)", { maxNods: 32 }, "unknown"],
    ["preAlloc: \"lazy\" (case)", { preAlloc: "lazy" }, "unknown"],
    ["unknown: whatever", { unknown: "whatever" }, "unknown"],
    ["config: null", null, "option"],
    ["config: 42", 42, "option"],
    ["config: \"eager\"", "eager", "option"],
    ["config: [] (array)", [], "option"],
    ["config: [1,2,3] (array)", [1, 2, 3], "option"],
    ["flushStrategy: \"sab\" (unknown here)", { flushStrategy: "sab" }, "unknown"],
    // Accepted baselines.
    ["config: undefined", undefined, "accept"],
    ["config: {}", {}, "accept"],
    ["config: Object.create(null)", Object.create(null), "accept"],
    ["prealloc: \"lazy\"", { prealloc: "lazy" }, "accept"],
    ["prealloc: \"eager\" small", { maxNodes: 8, prealloc: "eager" }, "accept"],
    ["onCapacityExceeded: \"grow\"", { onCapacityExceeded: "grow" }, "accept"],
    ["maxFlushPasses: 1", { maxFlushPasses: 1 }, "accept"],
];

describe("createRegistry validation matrix (1.4.5 backport)", () => {
    for (const [name, cfg, kind] of MATRIX) {
        it(name + " -> " + kind, () => {
            if (kind === "accept") {
                const r = createRegistry(cfg);
                assert.equal(typeof r.signal, "function", "accepted config must build a usable registry");
                const s = r.signal(1);
                assert.equal(s(), 1);
                return;
            }
            let threw = null;
            try {
                createRegistry(cfg);
            } catch (e) {
                threw = e;
            }
            assert.ok(threw !== null, "expected a throw, got a silently-built registry");
            assert.ok(threw instanceof TypeError, "expected a TypeError, got " + (threw && threw.name));
            assert.ok(!NEXTFREE.test(threw.message), "must not reach the internal nextFree path: " + threw.message);
            if (kind === "option") {
                assert.match(threw.message, NAMED_OPTION);
            } else {
                assert.match(threw.message, NAMED_UNKNOWN);
            }
        });
    }
});

describe("createRegistry unknown-key did-you-mean (1.4.5 backport)", () => {
    it("maxNods suggests maxNodes", () => {
        assert.throws(() => createRegistry({ maxNods: 32 }), (e) =>
            e instanceof TypeError && /did you mean "maxNodes"/.test(e.message));
    });
    it("preAlloc suggests prealloc", () => {
        assert.throws(() => createRegistry({ preAlloc: "lazy" }), (e) =>
            e instanceof TypeError && /did you mean "prealloc"/.test(e.message));
    });
    it("a far-off key gets no suggestion but still throws", () => {
        assert.throws(() => createRegistry({ zzzqqq: 1 }), (e) =>
            e instanceof TypeError && NAMED_UNKNOWN.test(e.message) && !/did you mean/.test(e.message));
    });
});

describe("createRegistry eager ceiling (1.4.5 backport)", () => {
    it("eager over the ceiling throws by name, before allocating", () => {
        assert.throws(() => createRegistry({ maxNodes: (1 << 24) + 1, maxLinks: 1, prealloc: "eager" }), (e) =>
            e instanceof TypeError && /^createRegistry: "maxNodes"/.test(e.message) && /lazy/.test(e.message));
    });
    it("the ceiling gates on (maxNodes + maxLinks), not either alone", () => {
        const half = 1 << 23; // 8388608; half + (half + 1) = (1<<24) + 1 > ceiling
        assert.throws(() => createRegistry({ maxNodes: half, maxLinks: half + 1, prealloc: "eager" }), (e) =>
            e instanceof TypeError && /^createRegistry: "maxLinks"/.test(e.message));
    });
    it("a modest eager config is unaffected by the ceiling", () => {
        const r = createRegistry({ maxNodes: 1024, prealloc: "eager" });
        assert.equal(r.stats().nodePoolPopulation, 1024);
        assert.equal(r.stats().linkPoolPopulation, 4096);
    });
    it("lazy is exempt from the ceiling (unbounded ledger)", () => {
        const r = createRegistry({ maxNodes: 1e9, prealloc: "lazy" });
        assert.equal(r.stats().nodePoolPopulation, 0);
        assert.equal(r.stats().nodePoolCapacity, 1e9);
    });
});

describe("stats() population distinguishes eager from lazy (1.4.5 backport)", () => {
    it("eager populates the pool to capacity; lazy starts empty", () => {
        const N = 200000;
        const eager = createRegistry({ maxNodes: N, prealloc: "eager" });
        const lazy = createRegistry({ maxNodes: N, prealloc: "lazy" });

        assert.equal(eager.stats().nodePoolPopulation, N, "eager node population === capacity");
        assert.equal(eager.stats().linkPoolPopulation, N * 4, "eager link population === capacity");
        assert.equal(lazy.stats().nodePoolPopulation, 0, "lazy node population starts at 0");
        assert.equal(lazy.stats().linkPoolPopulation, 0, "lazy link population starts at 0");

        // stats() shape: 14 keys, no key removed.
        const keys = Object.keys(eager.stats());
        assert.equal(keys.length, 14);
        for (const k of ["signals", "computeds", "effects", "activeLinks", "pooledLinks",
            "linkPoolCapacity", "nodePoolCapacity", "nodePoolPopulation", "linkPoolPopulation",
            "activeNodes", "totalAllocations", "totalDisposals", "poolGrowths", "flushPasses"]) {
            assert.ok(keys.includes(k), "stats() must include " + k);
        }
    });

    it("retained heap delta: eager >20MB, lazy <2MB (requires --expose-gc)", () => {
        if (typeof globalThis.gc !== "function") {
            return;
        }
        const N = 200000;
        globalThis.gc();
        const before = process.memoryUsage().heapUsed;
        const eager = createRegistry({ maxNodes: N, prealloc: "eager" });
        globalThis.gc();
        const afterEager = process.memoryUsage().heapUsed;
        const lazy = createRegistry({ maxNodes: N, prealloc: "lazy" });
        globalThis.gc();
        const afterLazy = process.memoryUsage().heapUsed;

        const eagerMB = (afterEager - before) / 1048576;
        const lazyMB = (afterLazy - afterEager) / 1048576;
        assert.ok(eagerMB > 20, "eager must retain >20MB, got " + eagerMB.toFixed(1));
        assert.ok(lazyMB < 2, "lazy must retain <2MB, got " + lazyMB.toFixed(1));
        assert.equal(eager.stats().nodePoolPopulation, N);
        assert.equal(lazy.stats().nodePoolPopulation, 0);
    });
});

describe("flushStrategy is not an option on this engine (rejected as unknown)", () => {
    it("flushStrategy is refused as an unrecognized key", () => {
        assert.throws(() => createRegistry({ flushStrategy: "sab" }), (e) =>
            e instanceof TypeError && /is not a recognized option/.test(e.message));
    });
});

describe("createRegistry OOM rows are refused, not fatal (1.4.5 backport)", () => {
    const CHILD = join(HERE, "31-config-oom.child.mjs");
    for (const key of ["maxNodes:Infinity", "maxNodes:1e9", "maxLinks:Infinity"]) {
        it(key + " throws a named TypeError under a 256MB cap and exits 0", () => {
            const res = spawnSync(process.execPath,
                ["--max-old-space-size=256", CHILD, key],
                { encoding: "utf8", timeout: 30000 });
            assert.equal(res.signal, null, key + " killed by signal " + res.signal + " (SIGABRT = OOM regression)");
            assert.equal(res.status, 0, key + " exited " + res.status + " :: " + (res.stderr || res.stdout));
            assert.match(res.stdout, /^OK /);
        });
    }
});
