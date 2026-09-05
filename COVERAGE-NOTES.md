# lite-signal — 100% coverage notes (1.8.0-preview)

Numbers below were produced with `c8@11` on Node 22:

```bash
npx c8 --reporter=text node --test 'test/*.test.mjs'
# lcov + text: npm run test:report
```

Codify is the project's canonical coverage runner — reconfirm the table and the
uncovered-line set against a codify run before tagging; the reachability analysis
and ignore manifest here are tool-independent, but the exact percentages are not.

| engine        | tests | pass | fail | skip | stmts | branch | funcs | lines |
|---------------|------:|-----:|-----:|-----:|------:|-------:|------:|------:|
| 1.8.0-preview |  484  | 483  |  0   |  1   |  100  |  100   |  100  |  100  |

The 1 skip is the architecturally-N/A SSR case in `17-reactivity`.
`25-devtools-real-boot` needs `@zakkster/lite-devtools` installed (the harness
setup tarball-installs it) or its tests report `cancelledByParent`.

`npm test` is scoped to `'test/*.test.mjs'`, so the opt-in harnesses are not part
of these numbers.

---

## What this pass fixed and closed

1.8.0 was branched from the same pre-1.5.0-beta.2 base as 1.6.0/1.7.0, so it
started at the 96.96% base; porting the full box/owner/opcode closure suite forward
plus the two items below brought it to 100%.

### The crash (fixed) — shared with the 1.4.0 → 1.7.0 line

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
// TypeError: Cannot set properties of null (setting 'headSub')   Signal.js:499
```

On the re-run the body reads `a` (cursor advances to `link(b)`), then disposes `b`
*without reading it*. `disposeNode` splices `link(b)` out and frees it, but the
cursor still points at it; `severTail` walks from the freed link, wipes `headDep`,
and double-frees. Fixed with a one-line cursor repair in `disposeNode`; the two
`freeLink` `-1` ternaries are dead and were removed. It composes with the new
cleanup-return path (the returned cleanup still fires across the disposal re-run).
Pinned by *disposeNode: cursor repair when a source dies under a parked cursor* in
`12-coverage.test.mjs`.

### New in 1.8.0 — the cleanup-return array-append arm

`registerCleanupReturn` promotes `node.cleanupFn` from `undefined` -> a function ->
an array as cleanups accumulate. The array-append arm (`existing.push(ret)`) is
reached only when **two or more imperative `onCleanup` calls** have already made
`cleanupFn` an array *and* the effect body also returns a cleanup. The behavioral
suite only exercised the single and promote cases; *a returned cleanup appends when
two+ imperative cleanups already made an array* in `33-cleanup-return.test.mjs`
closes it.

### Provably unreachable — `/* c8 ignore */`, proof inline

**link-ledger clamp** (`doubled > maxLinkLimit ? maxLinkLimit : doubled`).
`maxLinkLimit === maxLinks * 16`; the ledger only doubles from `maxLinks`, so the
chain lands exactly on `16m`. The `CapacityError` guard caps `linkPool.length` at
`maxLinkLimit`. The ceiling is a real wall; only the clamp is dead.

**`batchEpoch` wraparound** (`if (batchEpoch === 0) batchEpoch = 1`). Bumped only in
`batch()`; reaching 0 costs 2^32 batches. Retained because `revertEpoch` treats `0`
as "no capture".

`Watch.js` keeps its single pre-existing ignore on the `when()` re-entry guard.

---

## Test-suite notes

- `28-scope.test.mjs` was a byte-identical duplicate of `29-scope.test.mjs` (the
  1.7.0 rename left both on the same base); the `28-` copy is dropped, `29-scope`
  is canonical. `28-run-with-owner` keeps the `28-` slot.

## Known asymmetry (pinned, not changed)

`disposeNode` inlines the sub-list free rather than routing through `freeLink`, so
disposing a **source** emits opcode `2` (node-dispose) but no opcode `4` for its
outgoing edges. Opcode `4` fires only for a dep-set flip. Asserted in the pinned test.
