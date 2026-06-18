#!/bin/bash
# Correct benchmark protocol: ONE engine per cold Node process.
# Each engine runs in isolation so no cross-engine inline-cache pollution.
# Run from the repo root (where Signal.js lives).
set -e
mkdir -p bench-reactive-runs
ENGINES="lite-signal alien-signals preact solid vue-reactivity"
REPS=${REPS:-10}   # repeat each engine N times; override with REPS=5 ./run-all-benchreactive.sh

for eng in $ENGINES; do
  for rep in $(seq 1 $REPS); do
    echo "=== $eng (rep $rep/$REPS) ==="
    FW="$eng" node --expose-gc benchmarkReactive.mjs > "bench-reactive-runs/${eng}-rep${rep}.txt" 2>&1
  done
done
echo "Done. Per-engine files in bench-runs/. Aggregate with: node aggregate.mjs"
