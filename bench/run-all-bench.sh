#!/bin/bash
# Microscope multi-rep runner (bench protocol v3).
#
# ONE engine per cold Node process (isolation), but reps are scheduled ROUND-ROBIN
# instead of `for eng; for rep`. Engine-major ordering pinned the last engine to the
# hottest chassis -- the thermal artifact that faked a monotonic trend across
# sha-identical engines (F3). schedule.mjs rotates every rep wave so drift spreads
# across all engines and cancels. Each process is stamped by benchmark.mjs, so
# aggregate.mjs can refuse an inconsistent merge.
#
# Run from the repo root (where Signal.js lives).
#   REPS=10 bash bench/run-all-bench.sh
set -e
cd "$(dirname "$0")"
mkdir -p bench-runs
REPS=${REPS:-10}

# Engines from the single source of truth (frameworks.mjs); schedule from schedule.mjs.
ENGINES=$(node -e 'import("./frameworks.mjs").then(m => console.log(m.ENGINE_KEYS.join(" ")))')
# scheduleLines(engines, reps) -> lines "engine rep", round-robin with rotated waves.
SCHEDULE=$(node --input-type=module -e '
  import { scheduleLines } from "./lib/schedule.mjs";
  const engines = process.argv.slice(1);
  const reps = +(process.env.REPS || 10);
  console.log(scheduleLines(engines, reps).join("\n"));
' $ENGINES)

echo "microscope: $(echo "$ENGINES" | wc -w) engine(s) x $REPS rep(s), round-robin, one cold process each"
while read -r eng rep; do
  [ -z "$eng" ] && continue
  echo "=== $eng (rep $rep) ==="
  FW="$eng" node --expose-gc benchmark.mjs > "bench-runs/${eng}-rep${rep}.txt" 2>&1
done <<< "$SCHEDULE"

echo "Done. Per-engine files in bench-runs/. Aggregate with: node bench/aggregate.mjs"
