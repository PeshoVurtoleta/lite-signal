#!/usr/bin/env bash
# Run the hard suite against a set of lite-signal versions (current + future).
# Usage: ./run-matrix.sh [version ...]
set -u
VERSIONS=("$@")
[ ${#VERSIONS[@]} -eq 0 ] && VERSIONS=(1.3.0 1.4.0-beta.1 1.5.0-alpha.1 1.6.0-preview.2)
for v in "${VERSIONS[@]}"; do
  echo "==================== lite-signal@$v ===================="
  npm pack "@zakkster/lite-signal@$v" --pack-destination /tmp >/dev/null 2>&1 || { echo "  (could not fetch $v)"; continue; }
  TGZ=$(ls -t /tmp/zakkster-lite-signal-*.tgz | head -1)
  rm -rf node_modules/@zakkster/lite-signal && mkdir -p node_modules/@zakkster/lite-signal
  tar -xzf "$TGZ" -C node_modules/@zakkster/lite-signal --strip-components=1
  node --test 2>&1 | grep -E '^# (tests|pass|fail|skipped|todo)'
  rm -f "$TGZ"
  echo ""
done
