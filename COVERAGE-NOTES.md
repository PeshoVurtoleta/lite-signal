# lite-signal — 100% coverage notes (1.7.0-alpha)

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
| 1.7.0-alpha   |  485  | 484  |  0   |  1   |  100  |  100   |  100  |  100  |

`npm test` runs 477 of the 485; 8 are gated on `--expose-gc` (`04-zero-gc` x3,
`09-conformance` x4, `11-adopted-reactive` x1) and need `npm run test:gc` or
`test:coverage`. The 1 skip is the architecturally-N/A SSR case in `17-reactivity`.
`25-devtools-real-boot` needs `@zakkster/lite-devtools` installed (the harness
setup tarball-installs it) or its tests report `cancelledByParent`.

`npm test` is scoped to `'test/*.test.mjs'`, so the opt-in harnesses are not part
of these numbers.

---

## What this pass fixed and closed (99.24% → 100%)

1.7.0-alpha shipped at `99.24%` branch coverage. Three of the four uncovered arms
were `freeLink`'s two `-1` fallbacks plus the two genuinely-unreachable clamps.
The `freeLink` arms were **not** unreachable defensive code, as earlier notes and
the README claimed — they were reachable, and *only* reachable, through a crash.

### The crash (shared with the 1.4.0 → 1.6.0 line)

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
// TypeError: Cannot set properties of null (setting 'headSub')   Signal.js:462
```

On the re-run the body reads `a` (cursor advances to `link(b)`), then disposes `b`
*without reading it*. `disposeNode` splices `link(b)` out and frees it, but
`activeObserverCurrentDep` still points at it; `severTail` then walks from a freed
link, wipes the observer's `headDep`, and double-frees the link. The `-1` fallbacks
in `freeLink` are the only thing that path touches before the null-deref.

**Fix** — one line in `disposeNode`'s sub-list loop:

```js
if (activeObserverCurrentDep === sLink) activeObserverCurrentDep = nDep;
```

O(1), disposal path only, no steady-state cost. With the cursor repaired at the
source, `freeLink` can never see a freed link, so the two `-1` ternaries are dead
and were removed (`mutationHook(4, source.id, target.id)` — always live, branch-free).
Pinned by *disposeNode: cursor repair when a source dies under a parked cursor* in
`12-coverage.test.mjs`.

The remaining 1.7 surface (the non-eager `.set` / `boxSet` bodies, `flush()`, the
`flush` / `getOwner` / `runWithOwner` delegators, the `allocateLink` eligibility
gate, the `executeEffect` re-entrancy `CycleError`, the box + computed stale-handle
guards, and opcodes 6/7) was already closed by the preview.2 closure section in
`12-coverage.test.mjs`.

### Provably unreachable — `/* c8 ignore */`, proof inline

**link-ledger clamp** (`doubled > maxLinkLimit ? maxLinkLimit : doubled`).
`maxLinkLimit === maxLinks * 16`, and `currentLinkCapacity` only ever doubles from
`maxLinks`, so `16m` sits *on* the doubling chain. The `CapacityError` guard plus
the chunk math cap `linkPool.length` at `maxLinkLimit`; `doubled` terminates at
exactly `16m`. The ceiling is a real wall (`26` / `12-coverage` prove the
`CapacityError`); only the clamp is dead.

**`batchEpoch` wraparound** (`if (batchEpoch === 0) batchEpoch = 1`). Bumped only in
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
