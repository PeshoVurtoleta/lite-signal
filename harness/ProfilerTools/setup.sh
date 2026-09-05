#!/usr/bin/env bash
# Reproduce the combined harness environment on lite-signal 1.6.0-preview.2.
# --legacy-peer-deps bypasses the prerelease-peer mismatch (devtools wants
# >=1.6.0-preview; profiler-signal's published range tops at the 1.4.0 beta).
set -eu
npm install --no-audit --no-fund --legacy-peer-deps \
  @zakkster/lite-time @zakkster/lite-profiler @zakkster/lite-stats-math \
  @zakkster/lite-throttle @zakkster/lite-watch-ex @zakkster/lite-profiler-signal

# Pin lite-signal to the devtools floor (satisfies profiler-signal at runtime).
npm pack @zakkster/lite-signal@1.6.0-preview.2 --pack-destination /tmp >/dev/null
rm -rf node_modules/@zakkster/lite-signal && mkdir -p node_modules/@zakkster/lite-signal
tar -xzf /tmp/zakkster-lite-signal-1.6.0-preview.2.tgz -C node_modules/@zakkster/lite-signal --strip-components=1

# Add devtools via tarball (skips its prerelease peer at install time).
npm pack @zakkster/lite-devtools --pack-destination /tmp >/dev/null
rm -rf node_modules/@zakkster/lite-devtools && mkdir -p node_modules/@zakkster/lite-devtools
tar -xzf "$(ls -t /tmp/zakkster-lite-devtools-*.tgz | head -1)" -C node_modules/@zakkster/lite-devtools --strip-components=1

echo "ready -- run: node --test"
