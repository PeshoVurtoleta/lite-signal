#!/usr/bin/env bash
# Capture manifest versions same-host (cold per version x workload), then gate.
#   bash matrix.sh gate <candidate-version>   # floor + rolling + candidate, then gate.mjs
#   bash matrix.sh calibrate                  # rolling captured twice, then calibrate.mjs
set -euo pipefail
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
    CAND="${2:?usage: matrix.sh gate <candidate-version>}"
    echo "capturing floor=$FLOOR rolling=$ROLLING candidate=$CAND (same host, INTERLEAVED rounds, cold per workload)..."
    capture_interleaved "$FLOOR" "$ROLLING" "$CAND"
    node gate.mjs "$CAND"
    ;;
  gate-self)
    CANDLABEL="${2:?usage: matrix.sh gate-self <candidate-label> <engine-path>}"
    ENGINE="${3:?usage: matrix.sh gate-self <candidate-label> <engine-path>}"
    echo "capturing floor=$FLOOR rolling=$ROLLING (published) + candidate=$CANDLABEL (current tree: $ENGINE), INTERLEAVED rounds..."
    rm -rf "baselines/$FLOOR" "baselines/$ROLLING" "baselines/$CANDLABEL"
    # primers (discarded): absorb the cold-start penalty for all three sources
    swap "$FLOOR";   for w in $WORKLOADS; do node run.mjs "$FLOOR" "$w" --rep=0 >/dev/null 2>&1 || true; done
    if [ "$ROLLING" != "$FLOOR" ]; then swap "$ROLLING"; for w in $WORKLOADS; do node run.mjs "$ROLLING" "$w" --rep=0 >/dev/null 2>&1 || true; done; fi
    for w in $WORKLOADS; do node run.mjs "$CANDLABEL" "$w" --engine="$ENGINE" --rep=0 >/dev/null 2>&1 || true; done
    rm -f "baselines/$FLOOR"/*.rep0.json "baselines/$ROLLING"/*.rep0.json "baselines/$CANDLABEL"/*.rep0.json
    # interleaved rounds: every label samples every time window, so host drift
    # (thermal ramp, background load) cancels in the comparison instead of
    # skewing whichever label captures last
    for k in $(seq 1 "$REPS"); do
      swap "$FLOOR";   for w in $WORKLOADS; do node run.mjs "$FLOOR" "$w" --rep="$k" >/dev/null; done
      if [ "$ROLLING" != "$FLOOR" ]; then swap "$ROLLING"; for w in $WORKLOADS; do node run.mjs "$ROLLING" "$w" --rep="$k" >/dev/null; done; fi
      for w in $WORKLOADS; do node run.mjs "$CANDLABEL" "$w" --engine="$ENGINE" --rep="$k" >/dev/null; done
    done
    node aggregate.mjs "$FLOOR"; [ "$ROLLING" != "$FLOOR" ] && node aggregate.mjs "$ROLLING"; node aggregate.mjs "$CANDLABEL"
    swap "$FLOOR";   hash_engine "$FLOOR" "node_modules/@zakkster/lite-signal/Signal.js"
    if [ "$ROLLING" != "$FLOOR" ]; then swap "$ROLLING"; hash_engine "$ROLLING" "node_modules/@zakkster/lite-signal/Signal.js"; fi
    hash_engine "$CANDLABEL" "$ENGINE"
    node gate.mjs "$CANDLABEL"
    ;;
  recapture)
    # Recapture ONE workload cleanly for floor (+ rolling if distinct) + current-tree
    # candidate, REPS reps, interleaved, then aggregate and print the deltas. This is the
    # fast "is broadcast-fanout real or noise?" loop -- no need to re-run all 4 workloads.
    #   bash matrix.sh recapture broadcast-fanout ../../Signal.js   (engine optional)
    W="${2:?usage: matrix.sh recapture <workload> [candidate-engine-path]}"
    ENGINE="${3:-}"
    CANDLABEL="candidate-recapture"
    LABELS=("$FLOOR"); [ "$ROLLING" != "$FLOOR" ] && LABELS+=("$ROLLING")
    echo "recapturing '$W' for ${LABELS[*]}${ENGINE:+ + $CANDLABEL} ($REPS reps, interleaved)..."
    for L in "${LABELS[@]}" "$CANDLABEL"; do rm -rf "baselines/$L"; done
    # primers (discarded)
    for L in "${LABELS[@]}"; do swap "$L"; node run.mjs "$L" "$W" --rep=0 >/dev/null 2>&1 || true; done
    [ -n "$ENGINE" ] && node run.mjs "$CANDLABEL" "$W" --engine="$ENGINE" --rep=0 >/dev/null 2>&1 || true
    for L in "${LABELS[@]}" "$CANDLABEL"; do rm -f "baselines/$L/$W".rep0.json 2>/dev/null || true; done
    for k in $(seq 1 "$REPS"); do
      for L in "${LABELS[@]}"; do swap "$L"; node run.mjs "$L" "$W" --rep="$k" >/dev/null; done
      [ -n "$ENGINE" ] && node run.mjs "$CANDLABEL" "$W" --engine="$ENGINE" --rep="$k" >/dev/null
    done
    for L in "${LABELS[@]}"; do node aggregate.mjs "$L"; done
    [ -n "$ENGINE" ] && node aggregate.mjs "$CANDLABEL"
    node -e '
      const fs=require("fs"); const w=process.argv[1], labels=process.argv.slice(2);
      const load=(l)=>{try{return JSON.parse(fs.readFileSync(`baselines/${l}/${w}.json`,"utf8"));}catch{return null;}};
      const base=load(labels[0]); if(!base){console.error("no baseline for",labels[0]);process.exit(1);}
      console.error(`\n${w}: median frame.avg (n reps, spread)`);
      for(const l of labels){const s=load(l); if(!s)continue;
        const d=(s.frame.avg-base.frame.avg)/base.frame.avg*100;
        console.error(`  ${l.padEnd(22)} ${s.frame.avg.toFixed(4)}ms  vs ${labels[0]} ${d>=0?"+":""}${d.toFixed(1)}%  (n=${s.reps}, spread ${s.evidence&&s.evidence.spreadPct!=null?s.evidence.spreadPct+"%":"n/a"})`);
      }
    ' "$W" "${LABELS[@]}" ${ENGINE:+$CANDLABEL}
    ;;
  calibrate)
    echo "capturing $ROLLING twice for self-noise..."
    capture "$ROLLING"; capture "${ROLLING}__b" "$ROLLING"
    node calibrate.mjs "$ROLLING" "${ROLLING}__b"
    ;;
  *) echo "usage: bash matrix.sh [gate <ver> | gate-self <label> <engine> | recapture <workload> [engine] | calibrate]"; exit 2;;
esac
