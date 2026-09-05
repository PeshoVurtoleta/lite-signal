# lite-signal — 100% coverage notes (1.6.0-alpha)

Numbers below were produced with `c8@11` on Node 22:

```bash
npx c8 --reporter=text node --test 'test/*.test.mjs'
# lcov + text: npm run test:report
```

Codify is the project's canonical coverage runner — reconfirm the table and the
uncovered-line set against a codify run before tagging; the reachability analysis
and ignore manifest here are tool-independent, but the exact percentages are not.
(This file replaces a stale 1.1.x-era artifact that still listed 1.1.3/1.1.4/1.2.0
engines and the old `NN-name_test.mjs` filenames.)

| engine        | tests | pass | fail | skip | stmts | branch | funcs | lines |
|---------------|------:|-----:|-----:|-----:|------:|-------:|------:|------:|
| 1.6.0-alpha   |  459  | 458  |  0   |  1   |  100  |  100   |  100  |  100  |

The 1 skip is the architecturally-N/A SSR case in `17-reactivity`.
`25-devtools-real-boot` needs `@zakkster/lite-devtools` installed (the harness
setup tarball-installs it) or its tests report `cancelledByParent` and c8 exits
non-zero — an environment gap, not an engine fault.

`npm test` is scoped to `'test/*.test.mjs'`, so the opt-in harnesses
(`test/ProfilerTests/`, `harness/ProfilerTools/`, `harness/VersionMatrix/`) are not
part of these numbers.

---

## What this pass fixed and closed (96.96% → 100%)

1.6.0-alpha shipped at `96.96%` branch coverage and carried a crash reachable from
the plain public API. Both are addressed here.

### The crash (shared with the 1.4.0 / 1.5.0 line)

`disposeNode`'s sub-list teardown freed a link while an observer's re-tracking
cursor (`activeObserverCurrentDep`) was still parked on it:

```js
const a = r.signal(0), b = r.signal(0);
let runs = 0;
r.effect(() => {
    runs++;
    a();
    if (runs === 1) b();          // run 1 links [a, b]
    if (runs === 2) r.dispose(b); // run 2: cursor parked on link(b), never consumed
});
a.set(1);
// TypeError: Cannot set properties of null (setting 'headSub')   Signal.js:423
```

On the re-run the body reads `a` (cursor advances to `link(b)`), then disposes `b`
*without reading it*. `disposeNode` splices `link(b)` out and returns it to the free
list, but `activeObserverCurrentDep` still points at it; `severTail` then walks from
a freed link, wipes the observer's `headDep`, and double-frees the link.

**Fix** — one line in `disposeNode`'s sub-list loop:

```js
if (activeObserverCurrentDep === sLink) activeObserverCurrentDep = nDep;
```

O(1), disposal path only, no steady-state cost. With the cursor repaired at the
source, `freeLink`'s `link.source !== null ? ... : -1` defensive ternaries became
dead and were replaced by the passed params (`mutationHook(4, source.id, target.id)`)
— equivalent and branch-free. Pinned by *disposeNode: cursor repair when a source
dies under a parked cursor* in `12-coverage.test.mjs`.

### New in 1.6.0 — the flush-path profiler opcodes

The `1.6.0-alpha.0` gap was the hook-attached side of the two new opcodes, which the
active suite never hit because it never attached a hook:

| line | branch | test |
|------|--------|------|
| **751** | `mutationHook(7, ...)` — effect enqueued, in `markDownstream` | *mutation hook: flush-path opcodes 6 and 7* |
| **784** | `mutationHook(6, ...)` + `statFlushPasses` bump — flush pass, in `flushEffects` | *mutation hook: flush-path opcodes 6 and 7* |

One test attaches a hook, writes a signal, and asserts op 7 fires once for the
enqueued effect (carrying its node id) and op 6 fires per flush pass (carrying
`passNo, queueLen`). The inert (`mutationHook === null`) side was already covered.

### Reachable branches ported from the 1.4.0-rc pass — in `12-coverage.test.mjs`

| line | branch | test |
|------|--------|------|
| **338** | `allocateLink` dead-target gate | *eligibility gate on a target disposed mid-run* |
| **837** | `executeEffect` `FLAG_COMPUTING` cycle throw (scheduler trampoline, not the write path) | *synchronous re-entrancy guard* |
| **1126** | `computed` stale-handle `gen` guard | *computed: stale-handle read* |

### 1.5.0 box + owner surface — in `12-coverage.test.mjs`

| line(s) | surface | test |
|---------|---------|------|
| **1209 / 1225 / 1238** | `boxUpdate` / `boxComputedGet` / `boxComputedPeek` stale guards | *signalBox / computedBox: stale-handle guards* |
| **1293** | `computedBox` `opts.equals` arm | *computedBox: custom equals gates downstream recompute* |
| **1888 / 1896** | top-level `getOwner()` / `runWithOwner()` delegators | *top-level getOwner / runWithOwner route to the default registry* |

### Provably unreachable — `/* c8 ignore */`, proof inline

**388** — `doubled > maxLinkLimit` link-ledger clamp. `maxLinkLimit ===
initialLinkCapacity * 16`, and `currentLinkCapacity` is only ever a power-of-2
multiple of that same initial capacity, so `16m` sits *on* the doubling chain.
The `CapacityError` guard plus the chunk math cap `linkPool.length` at
`maxLinkLimit`; `doubled` terminates at exactly `16m`. Forcing it throws
`CapacityError` instead.

**1408** — `if (batchEpoch === 0) batchEpoch = 1`. `batchEpoch` is bumped only in
`batch()` (reset to 1 by `destroy()`), so reaching 0 costs 4,294,967,295 top-level
`batch()` calls. Retained because `revertEpoch` comparisons treat `0` as
"no capture".

`Watch.js` keeps its single pre-existing ignore on the `when()` re-entry guard.

---

## Known asymmetry (pinned, not changed)

`disposeNode`'s sub-list teardown inlines the link free rather than routing through
`freeLink`, so disposing a **source** emits opcode `2` (node-dispose) but no opcode
`4` (link-remove) for its outgoing edges. Opcode `4` fires only for edges severed by
a dep-set flip. Both behaviours are asserted in the cursor-repair test.
