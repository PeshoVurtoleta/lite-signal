#!/bin/bash
# Mirror multi-rep runner (isolated-per-engine), modelled on run-all-bench.sh.
#
# ONE engine per cold Node process: `FW=<engine> node --expose-gc mirror.mjs` runs all
# rows of that engine in one process and stamps isolated-per-engine. Reps are scheduled
# ROUND-ROBIN (rep-major, engine-minor, rotated per wave by schedule.mjs) so thermal
# drift spreads across all engines instead of loading the last one (F3).
# Output: mirror-runs/<engine>-rep<k>.txt (stdout only), one file per process.
#
# It never overwrites or deletes a capture: if ANY mirror-runs/*-rep*.txt, *-rep*.txt.partial
# or COMPLETE exists it exits 2 before the first run. Copy the old set aside first (never
# mix old and new reps). Each process writes <engine>-rep<k>.txt.partial, renamed to .txt
# only when it exits 0; a mirror process that exits non-zero (a guard fired) stops the run
# (set -e) and its rep is left as .txt.partial, which report.mjs ignores and the next run
# refuses. COMPLETE (protocol, reps, engines, captureId; tmp + rename) is written LAST, only
# when every process exited 0; report.mjs refuses a capture dir without it (D-b187-4).
#
# Every run generates a fresh CAPTURE_ID (UTC second + 8 random hex digits; an inherited
# CAPTURE_ID is overridden) and exports it, so every mirror.mjs process stamps it; it is
# written into COMPLETE, and report.mjs (lib/rowcheck.mjs) refuses a rep file whose stamp
# carries another id (b251 M16).
#
#   REPS=10 bash bench/run-all-mirror.sh
set -e
cd "$(dirname "$0")"
REPS=${REPS:-10}
if ! [[ "$REPS" =~ ^[1-9][0-9]*$ ]]; then
  echo "run-all-mirror: REPS must be a positive integer (got '$REPS')" >&2
  exit 2
fi

ENGINES="lite-signal alien-signals reflex-quant"

# Refuse before any run when a capture already exists (never overwrite, never delete).
shopt -s nullglob
EXISTING=(mirror-runs/*-rep*.txt mirror-runs/*-rep*.txt.partial)
shopt -u nullglob
if [ "${#EXISTING[@]}" -gt 0 ]; then
  echo "run-all-mirror: REFUSING -- ${#EXISTING[@]} rep file(s) already in bench/mirror-runs/ (e.g. ${EXISTING[0]})." >&2
  echo "Copy the old set aside first; this runner never overwrites or deletes a capture." >&2
  exit 2
fi
if [ -e mirror-runs/COMPLETE ]; then
  echo "run-all-mirror: REFUSING -- bench/mirror-runs/COMPLETE already exists (a finished capture's marker)." >&2
  echo "Copy the old set aside first; this runner never overwrites or deletes a capture." >&2
  exit 2
fi
mkdir -p mirror-runs

# format: bench/lib/rowcheck.mjs CAPTURE_ID_RE (the one definition; this regex is a copy)
CAPTURE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
if ! [[ "$CAPTURE_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]]; then
  echo "run-all-mirror: could not generate a capture id (got '$CAPTURE_ID')" >&2
  exit 2
fi
export CAPTURE_ID

# scheduleLines(engines, reps) -> lines "engine rep", round-robin with rotated waves.
SCHEDULE=$(REPS="$REPS" node --input-type=module -e '
  import { scheduleLines } from "./lib/schedule.mjs";
  const engines = process.argv.slice(1);
  const reps = +process.env.REPS;
  console.log(scheduleLines(engines, reps).join("\n"));
' $ENGINES)

echo "mirror: $(echo "$ENGINES" | wc -w | tr -d ' ') engine(s) x $REPS rep(s), round-robin, one cold process each, capture $CAPTURE_ID"
while read -r eng rep; do
  [ -z "$eng" ] && continue
  echo "=== $eng (rep $rep) ==="
  FW="$eng" node --expose-gc mirror.mjs < /dev/null > "mirror-runs/${eng}-rep${rep}.txt.partial"
  mv "mirror-runs/${eng}-rep${rep}.txt.partial" "mirror-runs/${eng}-rep${rep}.txt"
done <<< "$SCHEDULE"

# Completion marker, LAST, only reached when every process exited 0 (set -e).
ENG_JSON=$(printf '"%s",' $ENGINES)
printf '{"kind":"bench-capture-complete/v1","writer":"run-all-mirror.sh","protocol":"isolated-per-engine","reps":%s,"engines":[%s],"captureId":"%s"}\n' \
  "$REPS" "${ENG_JSON%,}" "$CAPTURE_ID" > mirror-runs/COMPLETE.tmp
mv mirror-runs/COMPLETE.tmp mirror-runs/COMPLETE

echo "Done. Per-engine files + COMPLETE in bench/mirror-runs/. Report with: node bench/report.mjs"
