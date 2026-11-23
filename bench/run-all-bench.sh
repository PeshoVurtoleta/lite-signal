#!/bin/bash
# Microscope multi-rep runner (bench protocol v3), structure ported from run-all-mirror.sh.
#
# ONE engine per cold Node process (isolation): `FW=<engine> node --expose-gc benchmark.mjs`
# stamps isolated-per-engine. Reps are scheduled ROUND-ROBIN instead of `for eng; for rep`.
# Engine-major ordering pinned the last engine to the hottest chassis -- the thermal
# artifact that faked a monotonic trend across sha-identical engines (F3). schedule.mjs
# rotates every rep wave so drift spreads across all engines and cancels.
# Output: bench-runs/<engine>-rep<k>.txt (stdout only), one file per process.
#
# It never overwrites or deletes a capture: if ANY bench-runs/*-rep*.txt, *-rep*.txt.partial,
# COMPLETE or COMPLETE.tmp exists it exits 2 before the first run. Copy the old set aside
# first (never mix old and new reps). Each process writes <engine>-rep<k>.txt.partial,
# renamed to .txt only when it exits 0; a benchmark process that exits non-zero (a guard
# fired: dead / inexact sink, INVALID RUN) stops the run (set -e) and its rep is left as
# .txt.partial, which aggregate.mjs refuses. COMPLETE (writer, protocol, reps, engines;
# tmp + rename) is written LAST, only when every process exited 0; aggregate.mjs refuses a
# capture dir without it (M5).
#
# Run from anywhere (it cd's to its own directory).
#   REPS=10 bash bench/run-all-bench.sh
set -e
cd "$(dirname "$0")"
REPS=${REPS:-10}
if ! [[ "$REPS" =~ ^[1-9][0-9]*$ ]]; then
  echo "run-all-bench: REPS must be a positive integer (got '$REPS')" >&2
  exit 2
fi

# Refuse before any run when a capture already exists (never overwrite, never delete).
shopt -s nullglob
EXISTING=(bench-runs/*-rep*.txt bench-runs/*-rep*.txt.partial)
shopt -u nullglob
if [ "${#EXISTING[@]}" -gt 0 ]; then
  echo "run-all-bench: REFUSING -- ${#EXISTING[@]} rep file(s) already in bench/bench-runs/ (e.g. ${EXISTING[0]})." >&2
  echo "Copy the old set aside first; this runner never overwrites or deletes a capture." >&2
  exit 2
fi
if [ -e bench-runs/COMPLETE ] || [ -e bench-runs/COMPLETE.tmp ]; then
  echo "run-all-bench: REFUSING -- bench/bench-runs/COMPLETE (or COMPLETE.tmp) already exists (a capture's marker)." >&2
  echo "Copy the old set aside first; this runner never overwrites or deletes a capture." >&2
  exit 2
fi

# Engines from the single source of truth (frameworks.mjs); schedule from schedule.mjs.
ENGINES=$(node --input-type=module -e 'import("./frameworks.mjs").then((m) => console.log(m.ENGINE_KEYS.join(" ")))')
if [ -z "$ENGINES" ]; then
  echo "run-all-bench: no engines from frameworks.mjs" >&2
  exit 2
fi
mkdir -p bench-runs

# scheduleLines(engines, reps) -> lines "engine rep", round-robin with rotated waves.
SCHEDULE=$(REPS="$REPS" node --input-type=module -e '
  import { scheduleLines } from "./lib/schedule.mjs";
  const engines = process.argv.slice(1);
  const reps = +process.env.REPS;
  console.log(scheduleLines(engines, reps).join("\n"));
' $ENGINES)

echo "microscope: $(echo "$ENGINES" | wc -w | tr -d ' ') engine(s) x $REPS rep(s), round-robin, one cold process each"
while read -r eng rep; do
  [ -z "$eng" ] && continue
  echo "=== $eng (rep $rep) ==="
  FW="$eng" node --expose-gc benchmark.mjs < /dev/null > "bench-runs/${eng}-rep${rep}.txt.partial"
  mv "bench-runs/${eng}-rep${rep}.txt.partial" "bench-runs/${eng}-rep${rep}.txt"
done <<< "$SCHEDULE"

# Completion marker, LAST, only reached when every process exited 0 (set -e).
ENG_JSON=$(printf '"%s",' $ENGINES)
printf '{"kind":"bench-capture-complete/v1","writer":"run-all-bench.sh","protocol":"isolated-per-engine","reps":%s,"engines":[%s]}\n' \
  "$REPS" "${ENG_JSON%,}" > bench-runs/COMPLETE.tmp
mv bench-runs/COMPLETE.tmp bench-runs/COMPLETE

echo "Done. Per-engine files + COMPLETE in bench/bench-runs/. Aggregate with: node bench/aggregate.mjs --reps $REPS"
