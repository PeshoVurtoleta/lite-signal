# lite-signal — 100% coverage notes (1.9.0-canary)

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
| 1.9.0-canary  |  491  | 490  |  0   |  1   |  100  |  100   |  100  |  100  |

The 1 skip is the architecturally-N/A SSR case in `17-reactivity`.
`25-devtools-real-boot` needs `@zakkster/lite-devtools` installed.

`npm test` is scoped to `'test/*.test.mjs'`, so the opt-in harnesses are not part
of these numbers.

---

## What this pass fixed and closed

1.9.0 was cut from the 1.8.0 base and inherits the crash. Porting the full
box/owner/opcode closure suite forward plus the items below brought it to 100%.

### The crash (fixed) — shared with the 1.4.0 → 1.8.0 line

`disposeNode` freed a link while an observer's re-tracking cursor
(`activeObserverCurrentDep`) was still parked on it, so disposing a source from
inside an observer's own body (before re-reading it) null-dereferenced in
`freeLink`. Fixed with a one-line cursor repair in `disposeNode`; the two dead
`freeLink` `-1` ternaries were removed. Pinned by *disposeNode: cursor repair when
a source dies under a parked cursor* in `12-coverage.test.mjs`. Repro and full
walkthrough are identical to the earlier versions' notes.

### New in 1.9.0 — `using` / `Symbol.dispose`

Both box prototypes install a `[Symbol.dispose]` method (`dispose(this)`), so a
`using` declaration tears the box down at block scope exit. No test exercised it;
*box: Symbol.dispose disposes the box* in `24-signalbox.test.mjs` calls
`box[Symbol.dispose]()` directly (the `using` syntax isn't parseable on every
runtime, and the method is exactly what `using` invokes), on both `signalBox` and
`computedBox`, and asserts idempotence.

### Carried forward — cleanup-return array-append arm

This line inherits 1.8.0's effect cleanup-return, so `33-cleanup-return.test.mjs`
carries forward (it is absent from both test.zip and the canary's own `test/`).
Its array-append arm (`existing.push(ret)`, reached when 2+ imperative `onCleanup`
calls already made `cleanupFn` an array and the body also returns a cleanup) is
covered there.

### Provably unreachable — `/* c8 ignore */`, proof inline

- **link-ledger clamp** (`doubled > maxLinkLimit`). `maxLinkLimit === maxLinks * 16`;
  the ledger doubles from `maxLinks`, landing exactly on `16m`; the `CapacityError`
  guard caps `linkPool.length`. The ceiling is a real wall; only the clamp is dead.
- **`batchEpoch` wraparound** (`if (batchEpoch === 0) batchEpoch = 1`). Reaching 0
  costs 2^32 `batch()` calls. Retained because `revertEpoch` treats `0` as "no capture".
- **`Symbol.dispose` polyfill fallback** (`typeof Symbol.dispose === "symbol" ? … : null`).
  The `: null` arm is for runtimes predating `Symbol.dispose` (< Node 20); on every
  supported runtime the symbol exists and the true arm is taken.

`Watch.js` keeps its single pre-existing ignore on the `when()` re-entry guard.

---

## Test-suite notes (numbering)

- `33-computed-selfdirty-prev-owner.test.mjs` renamed to `34-` — the `33-` slot
  belongs to `33-cleanup-return.test.mjs`, which carries forward from 1.8.0 because
  this line inherits effect cleanup-return.
- `28-scope.test.mjs` (a byte-identical duplicate of `29-scope.test.mjs`) dropped;
  `29-scope` is canonical, `28-run-with-owner` keeps the `28-` slot.

## Known asymmetry (pinned, not changed)

`disposeNode` inlines the sub-list free rather than routing through `freeLink`, so
disposing a **source** emits opcode `2` but no opcode `4` for its outgoing edges.
Opcode `4` fires only for a dep-set flip. Asserted in the cursor-repair test.
