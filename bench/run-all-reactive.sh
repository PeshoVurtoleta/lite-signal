#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Configuration
REPS=10
COOLDOWN=60 # 60 seconds = 1 minute cooldown to prevent thermal throttling
SCRIPT="benchmarkReactive.mjs"
OUTPUT_DIR="bench-runs-reactive"

echo "Starting benchmark suite: $REPS runs with a ${COOLDOWN}s cooldown."
echo "Results will be saved to the $OUTPUT_DIR/ directory."
echo "------------------------------------------------------------------"

# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

for i in $(seq 1 $REPS); do
  echo ">>> [$(date +'%T')] Starting Run $i of $REPS"

  # Define the output file for this specific run
  OUTPUT_FILE="${OUTPUT_DIR}/run_${i}.txt"

  # Run the benchmark.
  # 'tee' allows you to see the output live on the screen AND saves it to the file.
  node --expose-gc "$SCRIPT" | tee "$OUTPUT_FILE"

  # If it is not the very last run, trigger the cooldown timer
  if [ "$i" -lt "$REPS" ]; then
    echo ""
    echo "--- Run $i complete. Cooling down for $COOLDOWN seconds to reset thermals... ---"
    sleep $COOLDOWN
    echo ""
  fi
done

echo "=================================================================="
echo "All $REPS runs completed successfully!"
echo "Check the $OUTPUT_DIR/ directory for your results."