# lite-signal — 100% coverage notes (1.4.0-rc)

Numbers below were produced with `c8@11` on Node 22:

```bash
npx c8 --reporter=text node --test 'test/*.test.mjs'
```

Codify is the project's canonical coverage runner — reconfirm the table and the
uncovered-line set against a codify run before tagging; the reachability analysis
and ignore manifest here are tool-independent, but the exact percentages are not.
(This file replaces a stale 1.3.0-era artifact that still claimed 100% branch and
used the old `NN-name_test.mjs` filenames.)

| engine    | tests | pass | fail | skip | stmts | branch | funcs | lines |
|-----------|------:|-----:|-----:|-----:|------:|-------:|------:|------:|
| 1.4.0-rc  |  425  | 415  |  0   |  10  |  100  |  100   |  100  |  100  |

The 10 skips are the 9 `{skip:true}` `signalBox` tests staged in `24-signalbox` (the API
lands in 1.5.0) plus the 1 architecturally-N/A SSR case in `17-reactivity`.

`npm test` is scoped to `'test/*.test.mjs'`, so the opt-in harnesses
(`test/ProfilerTests/`, `harness/ProfilerTools/`, `harness/VersionMatrix/`) are not swept in
and are not part of these numbers.

---

## What closed the 98.26% → 100% branch gap

The rc reported six uncovered lines in `Signal.js`: `333, 383, 415, 826, 1115, 1241`
(seven branch arms — 415 carried two). They split three ways.

### Reachable — closed by tests in `12-coverage.test.mjs`

| line | branch | test |
|------|--------|------|
| **333** | `allocateLink`: `if (target.flags === 0) return null` | *eligibility gate on a target disposed mid-run* |
| **826** | `executeEffect`: `FLAG_COMPUTING` cycle throw | *synchronous re-entrancy guard* |
| **1115** | `computed` read closure: `if (node.gen !== birthGen) return undefined` | *stale-handle read* |

**333 — the shape that reaches it.** `disposeNode` only nulls the tracking context when
`currentObserver === node`, so a plain self-dispose cannot get here: the reads after it are
already no-ops. The gate is reached when an effect disposes itself from inside a *nested*
pull (`currentObserver` is the computed, not the effect). When `pullComputed` unwinds it
restores `currentObserver` to the now-dead effect node, and the next read in the rest of the
body hits `allocateLink` with `target.flags === 0`. The computed must be created *outside*
the effect, or the owner cascade tears it down mid-pull and the shape never forms.

**826 — the write path genuinely cannot reach this.** `markDownstream` refuses to re-queue a
node carrying `FLAG_COMPUTING`, which is why the 1.1.x/1.2.0 notes called this branch
unreachable and ignored it. That reasoning covered writes, not the **scheduler trampoline**:
`node.scheduler(node.schedulerThunk)` hands the run thunk to user code, and nothing stops
that code from invoking it from inside the body it is already running. That re-enters
`executeEffect` with `FLAG_COMPUTING` set and throws. The guard is load-bearing, not dead —
the old ignore was hiding a real path. The outer `finally` still clears the flag and restores
the tracking context, so the registry survives the throw (asserted).

**1115 — distinct from the pins in `21-perf-pins`.** That suite pins `peek()` on a stale
computed handle (`sharedComputedPeek`); the gen guard on the **read** closure is a separate
branch and needed its own case.

### Reachable only through a defect — fixed, then removed

**415** (`freeLink`: `link.source !== null ? link.source.id : -1`, and the same for `.target`).

The only path that reached those `-1` arms **crashed two lines later**, and it is reachable
from the plain public API:

```js
const a = r.signal(0), b = r.signal(0);
let runs = 0;
r.effect(() => {
    runs++;
    a();
    if (runs === 1) b();          // run 1 links [a, b]
    if (runs === 2) r.dispose(b); // run 2: cursor is parked on link(b), never consumed
});
a.set(1);
// TypeError: Cannot set properties of null (setting 'headSub')   Signal.js:418
```

On the re-run the body reads `a` (cursor advances to `link(b)`) and then disposes `b`
*without reading it*. `disposeNode`'s sub-list walk splices `link(b)` out and returns it to
the free list — but `activeObserverCurrentDep` is still pointing at it. `severTail` then
walks from a freed link whose `prevDep` is `null`, wipes the observer's `headDep` (orphaning
every surviving dep), and double-frees the link; `freeLink` null-derefs on `source.headSub`.

**Root-cause fix** — `disposeNode`, in the sub-list teardown loop:

```js
if (activeObserverCurrentDep === sLink) activeObserverCurrentDep = nDep;
```

O(1), disposal path only, no steady-state cost. With the cursor repaired at the source,
`freeLink` can never see a freed link, so the two defensive ternaries were dead weight and
were replaced by the already-passed params (`mutationHook(4, source.id, target.id)`) —
equivalent, branch-free, and two fewer branches in the count.

Pinned as a regression by *disposeNode: cursor repair when a source dies under a parked
cursor* in `12-coverage.test.mjs`.

### Provably unreachable — `/* c8 ignore */`, proof inline

**383** — `currentLinkCapacity = doubled > maxLinkLimit ? maxLinkLimit : doubled`.
`maxLinkLimit === initialLinkCapacity * 16`, and `currentLinkCapacity` is only ever assigned
a power-of-2 multiple of that same initial capacity — so `16m` sits **on** the doubling chain
(`m, 2m, 4m, 8m, 16m`). The `CapacityError` guard above (`linkPool.length >= maxLinkLimit`)
plus the chunk arithmetic (`chunk = limit - linkPool.length`) cap `linkPool.length` **at**
`maxLinkLimit`, so `doubled` terminates at exactly `16m` and can never exceed it. Attempting
to force it throws `CapacityError: links capacity (160) exceeded` instead. Retained as a clamp.

**1241** — `if (batchEpoch === 0) batchEpoch = 1`. `batchEpoch` is bumped only in `batch()`
(and reset to 1 by `destroy()`), so reaching 0 costs 4,294,967,295 top-level `batch()` calls.
Retained because the `revertEpoch` comparisons at 1071/1077 treat `0` as "no capture".
(This is item 5 of the historical 1.1.x/1.2.0 ignore manifest; the directive was lost in the
1.3/1.4 rebuild, which is why it resurfaced here.)

`Watch.js` keeps its single pre-existing ignore on the `if (fired) return` guard in `when()`
(`stop()` precludes re-entry).

---

## Known asymmetry (pinned, not changed)

`disposeNode`'s sub-list teardown inlines the link free rather than routing through
`freeLink`. Consequence: disposing a **source** node emits opcode `2` (node-dispose) but no
opcode `4` (link-remove) for its outgoing edges — a hook consumer infers those edges died
with the node. Opcode `4` fires only for edges severed by a dep-set flip (`allocateLink` /
`severTail`). Both behaviours are now asserted in the cursor-repair test, so a future
refactor of that loop has to be a deliberate contract change rather than a silent one.
