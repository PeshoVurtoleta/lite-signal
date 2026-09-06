# profiler-signal x devtools -- combined harness

Proof that [`@zakkster/lite-profiler-signal`](https://www.npmjs.com/package/@zakkster/lite-profiler-signal)
and [`@zakkster/lite-devtools`](https://www.npmjs.com/package/@zakkster/lite-devtools) compose against
one lite-signal registry: the profiler bridge **writes** frame telemetry into signals; devtools
**inspects** that live graph without perturbing it.

## What it shows (all assertions pass on lite-signal 1.6.0-preview.2)

```
capabilities: {"floor":"1.1.5","owners":true,"mutationHook":true,"burst":true}
fps=144.5 | fps observers=1 | frameP99 observers=2
graph: 7 nodes, 6 edges
toTree(frameP99):
  signal#4 = 50.5                  <- frameP99 (ms), elevated by injected hitches
    effect#19 = undefined          <- the dashboard effect
    computed#20 = false            <- the "over budget?" computed
monitor: activeNodes 21 -> 21 | poolCap 1024 -> 1024 | dashboard recomputes: 4 | onJank fired: 2
```

1. **devtools reports the engine's capabilities** -- `owners` / `mutationHook` / `burst` all true at 1.6.
2. **devtools sees the profiler's signals and who consumes them** -- `fps` has 1 observer (the dashboard),
   `frameP99` has 2 (the dashboard effect + an "over budget" computed).
3. **It renders the live telemetry DAG** -- `graph()` -> 7 nodes / 6 edges; `toTree` / `toDot` draw it.
4. **Introspection is non-perturbing** -- after a battery of `inspect` / `graph` / `toDot` / `dependencies`
   / `monitor` calls, the observer count on `fps` is unchanged. devtools never subscribes.
5. **Steady state allocates nothing** -- 2000 more frames, and `devtools.monitor()` shows `activeNodes`
   and pool capacity flat. The profiler's anti-trap design (one `tick.set` per frame; a throttle gates
   the recompute -- 4 recomputes, not 2000) is confirmed *through the inspector*.

## The roles are complementary

`lite-profiler-signal` is the only writer into the telemetry signals; `lite-devtools` is read-only and
non-perturbing (peek + `forEachObserver` / `forEachSource` / `forEachOwned` walks). So the inspector can
sit on a running profiler and never change its behaviour -- the same `stats()` it monitors is the one the
profiler's own anti-trap test guards.

## Versioning reality

devtools peers `lite-signal >=1.6.0-preview` (+ `lite-time`); profiler-signal peers `>=1.3.0 ||
>=1.4.0-beta.1`. By semver prerelease rules those ranges do not overlap on any *published* version, so
the combined harness pins **lite-signal 1.6.0-preview.2** and installs with `--legacy-peer-deps` (or an
`overrides` block). The clean fix is lite-signal 1.6.0 **stable** (satisfies both) or widening
profiler-signal's peer to admit the 1.5/1.6 prerelease lines. devtools effectively sets the floor at 1.6.

## Run

```sh
./setup.sh        # installs the stack + pins lite-signal 1.6.0-preview.2
node --test       # runs harness.test.mjs
```
