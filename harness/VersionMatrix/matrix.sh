#!/usr/bin/env bash
# Capture manifest versions same-host (cold per version x workload), then gate.
#   bash matrix.sh gate <candidate-version>   # floor + rolling + candidate, then judge (CONTROL_LABEL refused: exit 2)
#   bash matrix.sh calibrate                  # rolling captured twice, then calibrate.mjs
#   bash matrix.sh judge <candidate-label>    # verdict only: gate.mjs on the candidate (+ CONTROL_LABEL)
# gate-self optional sabotage control: CONTROL_LABEL=<label> CONTROL_ENGINE=<engine file>.
# Exit codes: 0 PASS, 1 FAIL, 3 NO EVIDENCE (gate.mjs; with a control: either gate refused
# -> PENDING); 4 the control ran with evidence and did not trip (NO VERDICT); 5 harness
# error (swap / npm pack / run.mjs / aggregate failed, a control gate crash -- never a 1);
# 2 usage error (missing argument, CONTROL_LABEL in gate mode) -- never a 1.
set -euo pipefail
set -E
trap 'exit 5' ERR
cd "$(dirname "$0")"

FLOOR=$(node -p "require('./manifest.json').floor")
ROLLING=$(node -p "require('./manifest.json').rolling")
WORKLOADS=$(node -p "require('./manifest.json').workloads.join(' ')")

swap () {
  npm pack "@zakkster/lite-signal@$1" --pack-destination /tmp >/dev/null 2>&1
  rm -rf node_modules/@zakkster/lite-signal && mkdir -p node_modules/@zakkster/lite-signal
  tar -xzf "/tmp/zakkster-lite-signal-$1.tgz" -C node_modules/@zakkster/lite-signal --strip-components=1
}
REPS="${REPS:-5}"
hash_engine () {  # hash_engine <label> <engine-path> -- persist sha256 of the engine source
  local label="$1"; local path="$2"
  [ -f "$path" ] || return 0
  mkdir -p "baselines/$label"
  node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$path" > "baselines/$label/engine.sha256"
}
capture () {  # capture <label> [version]  -- REPS cold processes per workload, then median
  local label="$1"; local ver="${2:-$1}"
  swap "$ver"
  rm -rf "baselines/$label"
  # PRIMER: one discarded pass per workload absorbs the cold-start penalty
  # (first cold process after idle pays JIT + file cache + macOS core
  # placement -- measured +12-17% on rep1 even in calm sessions).
  for w in $WORKLOADS; do node run.mjs "$label" "$w" --rep=0 >/dev/null 2>&1 || true; done
  rm -f "baselines/$label"/*.rep0.json
  for k in $(seq 1 "$REPS"); do for w in $WORKLOADS; do node run.mjs "$label" "$w" --rep="$k" >/dev/null; done; done
  node aggregate.mjs "$label"
  hash_engine "$label" "node_modules/@zakkster/lite-signal/Signal.js"
}

# judge <candidate-label>: the candidate's gate.mjs status. With CONTROL_LABEL set both
# gates run (D-QVM-2, b210), in this precedence:
#   (a) either gate REFUSED (candidate 3 or control --expect-fail 3) -> exit 3 (PENDING):
#       no evidence is no verdict, never "blind" and never a candidate PASS/FAIL;
#   (b) control 4 (ran with evidence, did not trip) -> exit 4, whatever the candidate said:
#       a run that cannot see a known regression judges nothing;
#   (c) control any other non-zero (a gate.mjs crash / usage) -> exit 5 harness error
#       (4 is reserved for an evidenced blind control);
#   (d) control tripped (0) -> the candidate's status.
judge () {
  local cand="$1"; local cst=0; local ctl=0
  node gate.mjs "$cand" || cst=$?
  if [ -n "${CONTROL_LABEL:-}" ]; then
    node gate.mjs "$CONTROL_LABEL" --expect-fail || ctl=$?
    if [ "$cst" -eq 3 ] || [ "$ctl" -eq 3 ]; then
      echo "judge: candidate gate exit $cst, control $CONTROL_LABEL expect-fail exit $ctl -- NO EVIDENCE -> PENDING (exit 3)" >&2
      exit 3
    fi
    if [ "$ctl" -eq 4 ]; then
      echo "judge: control $CONTROL_LABEL did not trip the gate -- NO VERDICT (exit 4) (candidate gate exit $cst)" >&2
      exit 4
    fi
    if [ "$ctl" -ne 0 ]; then
      echo "judge: control $CONTROL_LABEL gate crashed (expect-fail exit $ctl) -- harness error (exit 5) (candidate gate exit $cst)" >&2
      exit 5
    fi
  fi
  exit "$cst"
}

# INTERLEAVED gate capture: sequential per-label blocks (floor, then rolling,
# then candidate) turn any monotonic host drift -- thermal ramp, background
# task, power-state change -- into a systematic skew against whichever label
# captures LAST (always the candidate). Interleaving rounds puts every label
# in every time window, so drift hits all three equally and cancels in the
# comparison. This is the mechanism behind "broadcast fails, then deep-chain
# fails, then everything passes": the gate was measuring the machine's
# trajectory, not the engine.
capture_interleaved () {  # capture_interleaved <label1> <label2> <label3>
  local labels=("$@")
  for label in "${labels[@]}"; do rm -rf "baselines/$label"; done
  for label in "${labels[@]}"; do
    swap "$label"
    for w in $WORKLOADS; do node run.mjs "$label" "$w" --rep=0 >/dev/null 2>&1 || true; done
    rm -f "baselines/$label"/*.rep0.json
  done
  for k in $(seq 1 "$REPS"); do
    for label in "${labels[@]}"; do
      swap "$label"
      for w in $WORKLOADS; do node run.mjs "$label" "$w" --rep="$k" >/dev/null; done
    done
  done
  for label in "${labels[@]}"; do
    node aggregate.mjs "$label"
    swap "$label"
    hash_engine "$label" "node_modules/@zakkster/lite-signal/Signal.js"
  done
}

case "${1:-}" in
  gate)
    [ -n "${2:-}" ] || { echo "usage: matrix.sh gate <candidate-version>" >&2; exit 2; }
    CAND="$2"
    # D-b208-3: gate mode captures no control, so a CONTROL_LABEL here would be silently
    # ignored (a verdict with no control). Refuse BEFORE any capture or npm.
    if [ -n "${CONTROL_LABEL:-}" ]; then
      echo "matrix.sh gate: CONTROL_LABEL=$CONTROL_LABEL refused -- gate mode runs no control; gate-self is the controlled run (exit 2)" >&2; exit 2
    fi
    echo "capturing floor=$FLOOR rolling=$ROLLING candidate=$CAND (same host, INTERLEAVED rounds, cold per workload)..."
    capture_interleaved "$FLOOR" "$ROLLING" "$CAND"
    judge "$CAND"
    ;;
  gate-self)
    [ -n "${2:-}" ] || { echo "usage: matrix.sh gate-self <candidate-label> <engine-path>" >&2; exit 2; }
    [ -n "${3:-}" ] || { echo "usage: matrix.sh gate-self <candidate-label> <engine-path>" >&2; exit 2; }
    CANDLABEL="$2"; ENGINE="$3"
    CTL="${CONTROL_LABEL:-}"
    if [ -n "$CTL" ] && { [ -z "${CONTROL_ENGINE:-}" ] || [ ! -f "$CONTROL_ENGINE" ] || [ "$CTL" = "$FLOOR" ] || [ "$CTL" = "$ROLLING" ] || [ "$CTL" = "$CANDLABEL" ] || ! [[ "$CTL" =~ ^[a-z0-9_][a-z0-9._-]*$ ]]; }; then
      echo "gate-self: CONTROL_LABEL=$CTL needs CONTROL_ENGINE=<existing engine file> (got '${CONTROL_ENGINE:-}') and must differ from floor $FLOOR / rolling $ROLLING / candidate $CANDLABEL" >&2; exit 5
    fi
    echo "capturing floor=$FLOOR rolling=$ROLLING (published) + candidate=$CANDLABEL (current tree: $ENGINE)${CTL:+ + control=$CTL ($CONTROL_ENGINE)}, INTERLEAVED rounds..."
    rm -rf "baselines/$FLOOR" "baselines/$ROLLING" "baselines/$CANDLABEL" ${CTL:+"baselines/$CTL"}
    # primers (discarded): absorb the cold-start penalty for all three sources
    swap "$FLOOR";   for w in $WORKLOADS; do node run.mjs "$FLOOR" "$w" --rep=0 >/dev/null 2>&1 || true; done
    swap "$ROLLING"; for w in $WORKLOADS; do node run.mjs "$ROLLING" "$w" --rep=0 >/dev/null 2>&1 || true; done
    for w in $WORKLOADS; do node run.mjs "$CANDLABEL" "$w" --engine="$ENGINE" --rep=0 >/dev/null 2>&1 || true; done
    if [ -n "$CTL" ]; then for w in $WORKLOADS; do node run.mjs "$CTL" "$w" --engine="$CONTROL_ENGINE" --rep=0 >/dev/null 2>&1 || true; done; rm -f "baselines/$CTL"/*.rep0.json; fi
    rm -f "baselines/$FLOOR"/*.rep0.json "baselines/$ROLLING"/*.rep0.json "baselines/$CANDLABEL"/*.rep0.json
    # interleaved rounds: every label samples every time window, so host drift
    # (thermal ramp, background load) cancels in the comparison instead of
    # skewing whichever label captures last
    for k in $(seq 1 "$REPS"); do
      swap "$FLOOR";   for w in $WORKLOADS; do node run.mjs "$FLOOR" "$w" --rep="$k" >/dev/null; done
      swap "$ROLLING"; for w in $WORKLOADS; do node run.mjs "$ROLLING" "$w" --rep="$k" >/dev/null; done
      for w in $WORKLOADS; do node run.mjs "$CANDLABEL" "$w" --engine="$ENGINE" --rep="$k" >/dev/null; done
      if [ -n "$CTL" ]; then for w in $WORKLOADS; do node run.mjs "$CTL" "$w" --engine="$CONTROL_ENGINE" --rep="$k" >/dev/null; done; fi
    done
    node aggregate.mjs "$FLOOR"; node aggregate.mjs "$ROLLING"; node aggregate.mjs "$CANDLABEL"
    if [ -n "$CTL" ]; then node aggregate.mjs "$CTL"; fi
    swap "$FLOOR";   hash_engine "$FLOOR" "node_modules/@zakkster/lite-signal/Signal.js"
    swap "$ROLLING"; hash_engine "$ROLLING" "node_modules/@zakkster/lite-signal/Signal.js"
    hash_engine "$CANDLABEL" "$ENGINE"
    if [ -n "$CTL" ]; then hash_engine "$CTL" "$CONTROL_ENGINE"; fi
    judge "$CANDLABEL"
    ;;
  judge)
    [ -n "${2:-}" ] || { echo "usage: matrix.sh judge <candidate-label>" >&2; exit 2; }
    judge "$2"
    ;;
  calibrate)
    echo "capturing $ROLLING twice for self-noise..."
    capture "$ROLLING"; capture "${ROLLING}__b" "$ROLLING"
    node calibrate.mjs "$ROLLING" "${ROLLING}__b"
    ;;
  *) echo "usage: bash matrix.sh [gate <candidate-version> | gate-self <label> <engine-path> | judge <label> | calibrate]"; exit 2;;
esac
