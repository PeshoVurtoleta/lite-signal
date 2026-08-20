# lite-signal — 100% coverage notes (1.5.0-beta)

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

| engine       | tests | pass | fail | skip | stmts | branch | funcs | lines |
|--------------|------:|-----:|-----:|-----:|------:|-------:|------:|------:|
| 1.5.0-beta   |  454  | 453  |  0   |  1   |  100  |  100   |  100  |  100  |

The 1 skip is the architecturally-N/A SSR case in `17-reactivity` (lite has no DOM
layer). The 9 `24-signalbox` tests are active on 1.5.0 (the primitives shipped);
`25-devtools-real-boot` needs `@zakkster/lite-devtools` installed (the harness
setup tarball-installs it) or its 10 tests report `cancelledByParent` and c8 exits
non-zero — that is an environment gap, not an engine fault.

`npm test` is scoped to `'test/*.test.mjs'`, so the opt-in harnesses
(`test/ProfilerTests/`, `harness/ProfilerTools/`, `harness/VersionMatrix/`) are not
part of these numbers.

---

## What this pass fixed and closed (98.x → 100%)

1.5.0-beta shipped at `97.35%` branch coverage, and — critically — carried a
crash reachable from the plain public API. Both are addressed here.

### The crash (shared with the 1.4.0 line)

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
// TypeError: Cannot set properties of null (setting 'headSub')   Signal.js:420
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

### Reachable branches — closed by tests in `12-coverage.test.mjs`

| line | branch | test |
|------|--------|------|
| **335** | `allocateLink`: `if (target.flags === 0) return null` | *eligibility gate on a target disposed mid-run* |
| **828** | `executeEffect`: `FLAG_COMPUTING` cycle throw (via the scheduler trampoline, not the write path) | *synchronous re-entrancy guard* |
| **1117** | `computed` read closure: stale-handle `gen` guard | *computed: stale-handle read* |

### New-surface branches (1.5.0 box + owner API) — closed in `12-coverage.test.mjs`

| line(s) | surface | test |
|---------|---------|------|
| **1200 / 1216 / 1229** | `boxUpdate` / `boxComputedGet` / `boxComputedPeek` stale-handle guards | *signalBox / computedBox: stale-handle guards* |
| **1284** | `computedBox` `opts.equals` arm | *computedBox: custom equals gates downstream recompute* |
| **1775 / 1786** | top-level `getOwner()` / `runWithOwner()` delegators (previously uncovered functions) | *top-level getOwner / runWithOwner route to the default registry* |

`signalBox`'s `equals` (1259) and its `boxGet`/`boxSet` stale guards (1162/1175) were
already covered by `24-signalbox`; only the computed-box and update paths were open.

### Provably unreachable — `/* c8 ignore */`, proof inline

**385** — the `doubled > maxLinkLimit` link-ledger clamp. `maxLinkLimit ===
initialLinkCapacity * 16`, and `currentLinkCapacity` is only ever a power-of-2
multiple of that same initial capacity, so `16m` sits *on* the doubling chain
(`m, 2m, 4m, 8m, 16m`). The `CapacityError` guard plus the chunk math cap
`linkPool.length` at `maxLinkLimit`, so `doubled` terminates at exactly `16m`.
Forcing it throws `CapacityError` instead.

**1399** — `if (batchEpoch === 0) batchEpoch = 1`. `batchEpoch` is bumped only in
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
