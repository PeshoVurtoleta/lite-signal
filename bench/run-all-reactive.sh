#!/bin/bash
# run-all-reactive.sh -- RETIRED (bench protocol v3).
#
# This was the FIVE-ENGINES-IN-ONE-PROCESS "smoke" runner -- the weakest protocol in the
# tree and the origin of the phantom "lite is ahead on the dyn family / large web app"
# claim that the mirror, the microscope, and Andrii's own log all contradict once
# measured in isolation. It is retired, not demoted: its shared-process protocol must
# never produce a publishable number again.
#
#   node --expose-gc bench/sweep.mjs         # per-row cold isolation, stamped, guarded
echo "run-all-reactive.sh is RETIRED (shared-process smoke; never publishable). Use: node --expose-gc bench/sweep.mjs" >&2
exit 2
