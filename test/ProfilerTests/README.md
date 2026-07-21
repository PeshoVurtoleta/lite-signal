# lite-signal hard suite

An adversarial, **version-portable** conformance + hardening suite for
[`@zakkster/lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal).
It pins the invariants that quietly break reactive engines, and it is built to be
**ratcheted stricter with every release** -- so a regression in a future version
fails loudly instead of shipping.

`node:test` only, zero test deps. Each file imports the **bare** package
(`@zakkster/lite-signal`), so it self-references inside the engine's own repo and
resolves whatever version is installed when run standalone. Advanced cases are
**feature-gated**: an older engine simply skips the cases for APIs it does not have
yet, and they light up automatically as the surface grows.

## Why this exists

The hard part of a reactive engine is not "does a signal update an effect." It is
glitch-freedom on diamonds, dropping the untaken branch on dynamic dependencies,
keeping unobserved computeds lazy, running cleanups in the right order, surviving a
throwing effect, not leaking nodes or links under churn, and cascade-disposing an
ownership scope. Those are the cases here -- the same ones worth asking about in an
interview, and the same ones that regress when an engine is re-tuned for speed.

## Version matrix (verified)

Run against every published line. Zero failures; progressively more cases activate
as the engine gains APIs:

| lite-signal           | pass | fail | skipped | newly active                         |
| --------------------- | ---- | ---- | ------- | ------------------------------------ |
| `1.3.0` (stable)      | 22   | 0    | 6       | baseline: correctness, lifecycle, introspection, memory |
| `1.4.0-beta.1`        | 22   | 0    | 6       | perf fixes only -- same API surface  |
| `1.5.0-alpha.1`       | 23   | 0    | 5       | `createRoot` -> detach/`ownerOf` case |
| `1.6.0-preview.2`     | 25   | 0    | 3       | `createScope` -> 2 ownership cases    |
| `1.7.0` (unpublished) | 28*  | --   | 0*      | `flushStrategy` -> 3 cases (pre-armed)|

The 3 cases skipped on the published line are the `flushStrategy` tests (`sab` /
`manual`), which require >= 1.7.0. They are written and waiting.

## Running

Standalone against one version:

```sh
npm pack @zakkster/lite-signal@1.6.0-preview.2 --pack-destination /tmp
mkdir -p node_modules/@zakkster/lite-signal
tar -xzf /tmp/zakkster-lite-signal-1.6.0-preview.2.tgz -C node_modules/@zakkster/lite-signal --strip-components=1
node --test                 # or: node --test --expose-gc
```

Across the matrix:

```sh
./run-matrix.sh 1.3.0 1.4.0-beta.1 1.5.0-alpha.1 1.6.0-preview.2
```

In the `lite-signal` repo itself, drop the `test/*.test.mjs` files into the repo's
test dir -- the bare specifier self-resolves to the package, so the suite runs
against the working tree with no path edits.

## What is covered

- **`correctness.test.mjs`** -- glitch-freedom on an observed diamond; deep-chain
  single propagation; wide fan-out; no-op (`Object.is`) and custom-`equals` skips;
  unobserved-computed laziness; dynamic/conditional dependency re-tracking;
  `untrack`; batch coalescing; net-unchanged-in-batch.
- **`lifecycle.test.mjs`** -- `onCleanup` ordering (before re-run, once on dispose);
  idempotent dispose; engine recovery after a throwing effect/computed; self-cycle
  (effect writes its own dep) settles without runaway; custom `scheduler`.
- **`ownership.test.mjs`** (gated) -- `createScope` cascade-dispose; `createRoot`
  detaches (no owner); `ownerOf` reflects adoption; and the **introspection**
  surface lite-devtools relies on (`forEachSource` / `forEachObserver` /
  `hasObservers`), including the non-perturbing guarantee (walking adds no observer).
- **`memory.test.mjs`** -- registry isolation; node-pool reclamation (live
  `activeNodes` returns to baseline after 3000 create/dispose cycles; pool capacity
  stays bounded by peak concurrency, not cumulative count); link-pool stability
  under repeated re-tracking.
- **`advanced.test.mjs`** (gated, >= 1.7.0) -- `flushStrategy: "manual"` (nothing
  delivers until `flush()`) and `"sab"` (bare `.set` defers, batch exit delivers),
  plus rejection of an unknown strategy.

## Hardening it over time

This is a floor, not a ceiling. As the engine stabilizes:

- Tighten the lenient bounds -- e.g. the self-cycle test asserts "no runaway"
  (`runs <= 16`); once the `#180/#213` self-no-re-run guarantee is locked, assert the
  exact count.
- Add `signalBox` / `computedBox` round-trip cases once the box API is fixed.
- Deepen the ownership cases (nested scopes, owner trees) and add `serialize` /
  `diff` round-trips against lite-devtools graphs.
- Promote any new invariant a release introduces into a permanent regression case.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
