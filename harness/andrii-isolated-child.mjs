// andrii-isolated-child.mjs
// Runs one framework + one row in this clean V8 process. Emits JSON.
//
// argv: framework row

const [, , FRAMEWORK, ROW] = process.argv;
const BENCH_RUNS = parseInt(process.env.BENCH_RUNS || "4", 10);

// ── Adapters ──
let adapter;
if (FRAMEWORK === "v120") {
    const {createRegistry} = await import(process.env.LITE_V120_PATH || "@zakkster/lite-signal");
    const r = createRegistry({maxNodes: 1 << 18, maxLinks: 1 << 22, onCapacityExceeded: "grow"});
    adapter = {
        signal: (initial) => {
            const v = r.signal(initial);
            return {read: v, write: v.set};
        },
        computed: (fn) => ({read: r.computed(fn)}),
    };
} else if (FRAMEWORK === "v121") {
    const {createRegistry} = await import(process.env.LITE_V121_PATH || "../Signal.js");
    const r = createRegistry({maxNodes: 1 << 18, maxLinks: 1 << 22, onCapacityExceeded: "grow"});
    adapter = {
        signal: (initial) => {
            const v = r.signal(initial);
            return {read: v, write: v.set};
        },
        computed: (fn) => ({read: r.computed(fn)}),
    };
} else if (FRAMEWORK === "alien") {
    const alien = await import(process.env.ALIEN_PATH || "alien-signals");
    adapter = {
        signal: (initial) => {
            const s = alien.signal(initial);
            return {read: s, write: s};
        },
        computed: (fn) => ({read: alien.computed(fn)}),
    };
} else {
    throw new Error("unknown framework " + FRAMEWORK);
}

const COUNT = 1e5;

const createComputation1 = (s) => adapter.computed(() => s());
const createComputation2 = (s1, s2) => adapter.computed(() => s1() + s2());
const createComputation4 = (s1, s2, s3, s4) => adapter.computed(() => s1() + s2() + s3() + s4());
const createComputation1000 = (ss, off) => adapter.computed(() => {
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += ss[off + i].read();
    return sum;
});

const SCENARIOS = {
    createDataSignals: {
        count: COUNT, scount: COUNT, body: (n, sources) => {
            for (let i = 0; i < n; i++) sources[i] = adapter.signal(i);
        }
    },
    createComputations0to1: {
        count: COUNT, scount: 0, body: (n, _sources) => {
            for (let i = 0; i < n; i++) adapter.computed(() => i);
        }
    },
    createComputations1to1: {
        count: COUNT, scount: COUNT, body: (n, sources) => {
            for (let i = 0; i < n; i++) {
                const get = sources[i].read;
                createComputation1(get);
            }
        }
    },
    createComputations2to1: {
        count: COUNT / 2, scount: COUNT, body: (n, sources) => {
            for (let i = 0; i < n; i++) createComputation2(sources[i * 2].read, sources[i * 2 + 1].read);
        }
    },
    createComputations4to1: {
        count: COUNT / 4, scount: COUNT, body: (n, sources) => {
            for (let i = 0; i < n; i++) createComputation4(sources[i * 4].read, sources[i * 4 + 1].read, sources[i * 4 + 2].read, sources[i * 4 + 3].read);
        }
    },
    createComputations1000to1: {
        count: COUNT / 1000, scount: COUNT, body: (n, sources) => {
            for (let i = 0; i < n; i++) createComputation1000(sources, i * 1000);
        }
    },
    createComputations1to2: {
        count: COUNT, scount: COUNT / 2, body: (n, sources) => {
            for (let i = 0; i < n / 2; i++) {
                const get = sources[i].read;
                createComputation1(get);
                createComputation1(get);
            }
        }
    },
    createComputations1to4: {
        count: COUNT, scount: COUNT / 4, body: (n, sources) => {
            for (let i = 0; i < n / 4; i++) {
                const get = sources[i].read;
                createComputation1(get);
                createComputation1(get);
                createComputation1(get);
                createComputation1(get);
            }
        }
    },
    createComputations1to8: {
        count: COUNT, scount: COUNT / 8, body: (n, sources) => {
            for (let i = 0; i < n / 8; i++) {
                const get = sources[i].read;
                createComputation1(get);
                createComputation1(get);
                createComputation1(get);
                createComputation1(get);
                createComputation1(get);
                createComputation1(get);
                createComputation1(get);
                createComputation1(get);
            }
        }
    },
    createComputations1to1000: {
        count: COUNT, scount: COUNT / 1000, body: (n, sources) => {
            for (let i = 0; i < n / 1000; i++) {
                const get = sources[i].read;
                for (let j = 0; j < 1000; j++) createComputation1(get);
            }
        }
    },
};

function createDataSignals(n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = adapter.signal(i);
    return out;
}

function runRow(scenarioName) {
    const {count, scount, body} = SCENARIOS[scenarioName];
    let sources = scount > 0 ? createDataSignals(scount) : null;
    body(count / 100, sources);
    sources = scount > 0 ? createDataSignals(scount) : null;
    body(count / 100, sources);
    sources = scount > 0 ? createDataSignals(scount) : null;
    body(count / 100, sources);

    sources = scount > 0 ? createDataSignals(scount) : null;
    if (scount > 0) for (let i = 0; i < scount; i++) sources[i].read();
    globalThis.gc?.();

    const t0 = performance.now();
    body(count, sources);
    const t1 = performance.now();

    sources = null;
    globalThis.gc?.();
    return t1 - t0;
}

const samples = [];
for (let i = 0; i < BENCH_RUNS; i++) samples.push(runRow(ROW));
process.stdout.write(JSON.stringify({
    framework: FRAMEWORK,
    row: ROW,
    samples,
    min: Math.min(...samples),
    median: [...samples].sort((a, b) => a - b)[samples.length >> 1],
}));
