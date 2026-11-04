#!/usr/bin/env bash
# bytecode-budget.sh -- the bytecode LENGTH of NAMED functions on one node binary: a REPORT, or a GATE
# against per-function maxima recorded on a known node version.
# Or a DIFF (--diff): the same functions in two DRIVERs on that binary, their length multisets compared.
# Ref / file mode of the diff: ONE module file per side (two git refs, or a frozen copy and the live file), each
# staged beside a copy of ONE driver.
#
#   bytecode-budget.sh [opts] --fn LIST DRIVER                                   # report
#   bytecode-budget.sh [opts] --max fn=N[,fn=N] --node-version vX.Y.Z DRIVER     # gate
#   bytecode-budget.sh [opts] --diff --fn LIST DRIVER_BEFORE DRIVER_AFTER          # diff
#   bytecode-budget.sh [opts] --diff --fn LIST --out DIR --driver FILE --before-ref REF --after-ref REF --module REL  # diff (ref)
#   bytecode-budget.sh [opts] --diff --fn LIST --out DIR --driver FILE --before FILE --after FILE      # diff (file)
#
#   e.g. bytecode-budget.sh --max add=6,mid=211 --node-version v26.8.2 test/fixtures/bytecode-budget/node-26.8.2/driver.mjs
#
# Options
#   --fn LIST              report mode: function names, comma separated
#                          (diff mode: the same, with --diff; --max is refused there)
#   --max fn=N[,fn=N]      gate mode: every function named fn must have a bytecode length <= N (1..9 digits)
#   --node-version vX.Y.Z  gate mode (required): the node version the maxima were taken on; report mode
#                          (optional): the node version expected. Must equal `<node> --version` exactly, else
#                          NO-VERDICT before any probe.
#                          Diff mode (optional): as in report mode.
#   --runs N               probes per function, 2..20 (default 2). Run 1 vs runs 2..N is the null control.
#   --node BIN             node binary (default: $NODE, else node), resolved ONCE to an absolute path from the
#                          caller's cwd (a bare name through PATH). It must be an executable file, else exit 2
#                          before any node spawn ("node binary not found", "node binary is not a file on PATH
#                          (...)", "node binary is not an executable file", "node binary: cannot resolve the
#                          directory of ...").
#   --v8-flags STR         extra V8 flags for every probe, split on spaces (flags only, each `--` and a letter; any
#                          *print-bytecode* flag is refused; a max*inlined*bytecode* flag must be --name=N, N an
#                          integer of 1..9 digits; a reserve*inline*budget* flag must be --name=X, X = N or N.M, N and
#                          M of 1..9 digits (e.g. 1.2))
#   --out DIR              keep DIR/report.txt and DIR/raw/<fn>.<k>.txt (raw output of run k, 0x addresses kept;
#                          a space in fn becomes -). DIR/raw must be absent or an empty, readable and writable
#                          directory; DIR/report.txt must not be a symlink. Without --out nothing is written to
#                          disk.
#                          Diff mode: DIR/report.txt, DIR/raw/before/<fn>.<k>.txt and DIR/raw/after/<fn>.<k>.txt.
#   --diff                 diff mode: probe DRIVER_BEFORE and DRIVER_AFTER (run k of each side, k = 1..N, in turn)
#                          and compare the two length multisets per fn. Needs --fn and exactly two DRIVERs, or a
#                          ref / file pair below (then no DRIVER: --driver FILE and --out DIR).
#   --before-ref REF       ref mode (with --diff): the before side is --module as committed at REF (a commit-ish,
#                          resolved to its full sha; never starting with -). Goes with --after-ref.
#   --after-ref REF        ref mode: the after side, the same way. Both refs are required.
#   --module REL           ref mode (required): the module's path from the repo root (e.g. src/Thing.js): relative,
#                          no empty, . or .. segment; at each ref it must be a blob (`git cat-file -t`).
#   --before FILE          file mode (with --diff): the before module, a FROZEN copy (see Frozen "before" below).
#                          Goes with --after; never with --before-ref / --after-ref, never with --module.
#   --after FILE           file mode: the after module (the live working-tree file may be given); NAME = its file name.
#   --driver FILE          ref / file mode (required): ONE driver that imports the module as './NAME' or "./NAME"
#                          (NAME = the file name of --module, or of --after); its own file name must differ from NAME.
#   --repo DIR             the git repo. Ref mode: the refs and --module are read there (default: the repo around the
#                          current directory). File mode: one more <top> for the Frozen "before" check below.
#   --self-test            canned checks, then exit 0 (all ok) or 1 (a FAIL line per failed check)
#   --fixtures DIR         with --self-test: also check the real-trace captures in DIR (the node-26.8.2 set)
#   -h, --help             this text (exit 2)
#   Each value option is given at most once (one comma list) and never empty (--v8-flags never only blanks);
#   --fn / --max / --v8-flags take no newline and --fn / --max no empty entry (stray comma). --self-test takes
#   only --fixtures. --self-test / --help take no =value; an explicit empty --opt= is refused, never filled
#   from the next argument.
#   --diff is given at most once, takes no =value, and goes neither with --max nor with --self-test.
#   A ref / file pair needs --diff; --driver / --module / --repo go only with a ref / file pair; their values take
#   no newline.
#
# DRIVER: exactly one existing readable file (diff mode: exactly two, DRIVER_BEFORE DRIVER_AFTER), each run as
#   `node [v8 flags] --print-bytecode --print-bytecode-filter=<fn> DRIVER`
#   with cwd = its directory and NODE_OPTIONS stripped. V8 prints a function only once it is compiled.
# fn: a short V8 name, ^[A-Za-z_$][A-Za-z0-9_$]*( [A-Za-z_$][A-Za-z0-9_$]*)?$ (e.g. read, get value). Never
#   qualified: Store.read prints nothing on node 26, so it is refused. A repeated fn is refused.
#   Matching is EXACT and counts EVERY function with that name (same-name functions, class and object
#   methods); each one is gated. read never matches reader or read.set.
# Per fn and run, the probe output is reduced to "<count> <bad> <lengths>": matched headers, matched headers
#   not followed by "Bytecode length: N", and every length in input order (duplicates kept; "-" if none).
#   N has 1..9 digits (< 10^9: exact in awk doubles and bash (( )); real V8 lengths are far smaller), so a longer N
#   counts as not followed (bad), never as a length.
#   No address reaches that line, so run k must equal run 1 as text (null control).
# Report lines (run 1):
#   "  <fn>: <count> match(es): <l1,l2,..>"
#   "    <len> bytes: over <limit> (<op><value>)[, ...]" or "    <len> bytes: within every limit" (each distinct length)
#   "  <fn>: <WITHIN|OVER|REPORTED|NO-VERDICT> -- <reason>"
#   Limits are this binary's (one `--v8-options` read, then --v8-flags overrides; a NOTE lists any node 26
#   default ASSUMED), with inlining-budget-diff's operators: TurboFan small <=, small where a HeapNumber may
#   cross the call <=, single-inline <=; Maglev eager (greedy small) <, small <=, single-inline <.
# Diff lines (after "before  <path>  sha256/8 <x>" and "after   <path>  sha256/8 <x>" in the head; run 1 of each side):
#   "  <fn>: before <count> match(es): <l1,..>" and "  <fn>: after  <count> match(es): <l1,..>"
#   "    <len> bytes: ..." (each distinct length of either side, as in report mode), then one of
#   "  <fn>: SAME -- identical length multiset (<before lengths> | <after lengths>)"
#   "  <fn>: DIFF -- length multiset differs (before <lengths> | after <lengths>)", then per length whose count
#     differs (ascending): "    before=<n> after=<m>  <len>"
#   "  <fn>: NO-VERDICT -- <before|after>: <reason>" (one line per side that has a NO-VERDICT reason below)
#   "  <fn>: NO-VERDICT -- node version mismatch: <bin> --version is <v>, --node-version is <v>" (no before /
#     after prefix: printed for every fn before any probe, instead of the lines above)
#   The multiset is order-free and counts duplicates: 6,19 equals 19,6; 6 differs from 6,6.
# NO-VERDICT reasons, one line per fn ("  <fn>: NO-VERDICT -- <reason>"):
#   node version mismatch: <bin> --version is <v>, the maxima are for <v>     (gate mode)
#   node version mismatch: <bin> --version is <v>, --node-version is <v>      (report and diff mode)
#   driver exited <rc> in run <k>
#   null control: run <k> differs from run 1 (run <k>: <line> | run 1: <line>)
#   no function named '<fn>' in run 1 (not compiled: never called / lazy, or no such name)
#   <b> of <n> matched header(s) not followed by 'Bytecode length: N' in run 1 (unknown format)
#     (N of 1..9 digits: a length of 10 or more digits is counted here)
# Verdict, over every fn (NO-VERDICT > OVER > WITHIN): exit 0 WITHIN, 1 OVER, 2 NO-VERDICT. Report mode:
#   exit 0 REPORTED, or 2 NO-VERDICT. A refused argument (Options, DRIVER, fn) exits 2 before any node is
#   spawned; a --node BIN whose --version fails, or a V8 flag node rejects (NO-VERDICT: driver exited <rc>),
#   exits 2 after its spawn(s) (a rejected V8 flag still runs every probe). Spawns: one --version, one
#   --v8-options, then fn x runs probes.
# Diff verdict, over every fn (NO-VERDICT > DIFF > SAME): exit 0 SAME, 1 DIFF, 2 NO-VERDICT. Spawns: one --version,
#   one --v8-options, then fn x runs x 2 probes. --diff with --max, or not exactly two DRIVERs, exits 2 before any spawn.
#   (Ref / file mode: no DRIVER; any DRIVER path exits 2 before any spawn.)
# Ref / file mode: --out DIR is required and DIR/stage must be absent or empty. Before any probe, DIR/stage/before and
#   DIR/stage/after each get that side's module as NAME (ref mode: `git cat-file blob <sha>:REL`, plumbing, no
#   textconv; file mode: a cp, so an edit after staging cannot leak in) plus a copy of --driver, and each side's
#   driver runs there (cwd = DIR/stage/<side>). One module file per side: a module with relative imports of its own
#   fails closed (its driver exits non-zero: NO-VERDICT). Head: "before  <REF> @ <sha 12>  <REL>  sha256/8 <x>" (ref)
#   or "before  <abs FILE>  sha256/8 <x>" (file), x = the staged copy's, the same for after, then
#   "driver  <abs --driver>  sha256/8 <x>", and when the two staged modules are byte-identical
#   "NOTE    before and after modules are byte-identical: this run is a null control (expect SAME)".
#   The mode line says "diff (ref)" or "diff (file)". Spawns, lines and verdict as in diff mode; DIR holds report.txt,
#   raw/ and stage/. Every ref / file refusal exits 2 before any spawn and before anything is written to DIR.
# Frozen "before" (file mode): --before must be a FROZEN copy. It is refused with NO-VERDICT when it, or the end of
#   its symlink chain, is git-tracked, or when it is the same file (device:inode) as a tracked <top>/Signal.js or
#   <top>/<same name>, <top> = the repo around the current directory, around --after, around --before and its link
#   target, and --repo; or when it is the same file as --after (-ef: a hard link or symlink, anywhere). Ref and file
#   modes need git (file mode for this check). Both refuse a set GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
#   GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR or GIT_CEILING_DIRECTORIES (each can make a tracked --before read as
#   untracked): each repo is found from its path. Ref mode is frozen by construction (both sides from git objects).
# Not detected: a driver that reaches the live module by another path (an absolute path, or a package
#   self-reference) instead of './NAME'; a hard link of --before to a tracked file that is not --after,
#   <top>/Signal.js or <top>/<same name>; and a git error while checking (e.g. safe.directory "dubious ownership")
#   reads as untracked, so a tracked --before behind such an error is not refused.
# Tier: DETERMINISTIC (gated in npm test): the gate verdict -- the lengths come from one node binary and
#   one driver, the gate is pinned to that node version (--node-version) and any run-to-run change is
#   NO-VERDICT, never OVER -- and --self-test (canned text; with --fixtures, the recorded node v26.8.2
#   captures). REPORTED: the limit values both modes print are this binary's (its --v8-options, then
#   --v8-flags), a measurement of that binary, not a law.
# Tier (diff mode): DETERMINISTIC on the same terms: both DRIVERs on one node binary, and any run-to-run change
#   on either side is NO-VERDICT, never DIFF.
# Tier (ref / file mode): DETERMINISTIC on the same terms (one node binary; each staged side keeps its null control),
#   gated in npm test by the --self-test ref / file rows (a temp git repo and a fake node; with no git on PATH they
#   are one FAIL line and --self-test exits 1).
# Any unexpected failure (a command that fails outside the checks above) exits 2 NO-VERDICT, never 1.

unset CDPATH   # before the prologue: SELF, every cd and every "cd X && pwd" join resolve X itself, never a CDPATH entry
set -euo pipefail
# Fail closed: an exit that is not a planned verdict (FINAL=1), a die / usage (2) or 0 becomes 2 NO-VERDICT,
# so a command that fails under set -e can never pose as exit 1 DIFF. Subshells do not inherit this trap.
FINAL=""
trap 'rc=$?; if [[ -z $FINAL && $rc -ne 0 && $rc -ne 2 ]]; then printf "bytecode-budget: unexpected error (exit %s)\nVERDICT NO-VERDICT\n" "$rc" >&2; exit 2; fi' EXIT
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
export LC_ALL=C   # byte-wise sort / awk: stable multisets, emoji stripped as bytes

# ---------------------------------------------------------------------------------------------
# awk programs (POSIX awk: mawk, gawk, BSD awk)
# ---------------------------------------------------------------------------------------------

# `node --v8-options` -> name=value for the inlining limits; then --v8-flags overrides.
# Two formats: "default: --flag=value" (node 26) and an older "default: value" under a "  --flag (...)" header.
# shellcheck disable=SC2016
LIMITS_AWK='
/^  --(max-(maglev-)?(eager-)?inlined-bytecode-size[a-z-]*|reserve-inline-budget-scale-factor) / { k = $1; sub(/^--/, "", k); next }
/default: --(max-(maglev-)?(eager-)?inlined-bytecode-size|reserve-inline-budget-scale-factor)/ {
  s = $0; sub(/.*default: --/, "", s); print s; k = ""; next
}
k != "" && /default:/ { s = $0; sub(/.*default: */, "", s); sub(/ .*/, "", s); print k "=" s; k = "" }
'

# --print-bytecode output -> distinct "Bytecode length" values of functions named exactly fn
# shellcheck disable=SC2016
BYTECODE_AWK='
/^\[generated bytecode for function: / {
  s = $0; sub(/^\[generated bytecode for function: /, "", s); sub(/ \(0x.*$/, "", s); want = (s == fn); next
}
want && /^Bytecode length: [0-9]+/ { v = $3 + 0; if (!(v in seen)) { seen[v] = 1; ord[++nv] = v }; want = 0 }
END { out = ""; for (i = 1; i <= nv; i++) out = out (out == "" ? "" : ",") ord[i]; print out }   # first-seen order
'

# two `uniq -c` files -> lines whose counts differ: "before=N after=M  [unit] line"
# shellcheck disable=SC2016
MSDIFF_AWK='
function key(s) { sub(/^ *[0-9]+ /, "", s); return s }
function show(k,   u, l) { u = k; sub(/\t.*/, "", u); l = k; sub(/^[^\t]*\t/, "", l); return (u == "*") ? l : "[" u "] " l }
FILENAME == ARGV[1] { k = key($0); b[k] = $1 + 0; all[k] = 1; next }   # not FNR == NR: an empty first file breaks it
{ k = key($0); a[k] = $1 + 0; all[k] = 1 }
END { for (k in all) if (b[k] + 0 != a[k] + 0) printf "  before=%d after=%d  %s\n", b[k], a[k], show(k) }
'

# --print-bytecode output -> "<count> <bad> <lengths>" for the functions named EXACTLY fn (see the header).
# shellcheck disable=SC2016
COUNT_AWK='
/^\[generated bytecode for function: / {
  s = $0; sub(/^\[generated bytecode for function: /, "", s); sub(/ \(0x.*$/, "", s)
  want = (s == fn); n += want; next
}
want && /^Bytecode length: [0-9]+$/ && length($3) <= 9 { good++; out = out (out == "" ? "" : ",") ($3 + 0) }
{ want = 0 }
END { bad = n - good; print n + 0, bad + 0, (out == "" ? "-" : out) }
'

# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
die() { printf 'bytecode-budget: %s\nVERDICT NO-VERDICT\n' "$*" >&2; exit 2; }
say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
sha8() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-8; }
usage() { sed -n '2,/^$/{s/^# \{0,1\}//;p;}' "$0"; }
multiset() { sort | uniq -c; }   # the ONE multiset: judge() and --self-test both use it (never sort -u)
devino() { # device:inode, following symlinks (GNU stat, else BSD / macOS stat)
  if stat -L -c '%d:%i' "$1" >/dev/null 2>&1; then stat -L -c '%d:%i' "$1"; else stat -L -f '%d:%i' "$1"; fi
}
live_tops() { # dirs...: repo toplevels around cwd, --after, --repo and each given dir
  { git rev-parse --show-toplevel 2>/dev/null || true
    [[ -n "$AFTER_FILE" ]] && git -C "$(dirname "$AFTER_FILE")" rev-parse --show-toplevel 2>/dev/null || true
    [[ -n "$REPO" ]] && git -C "$REPO" rev-parse --show-toplevel 2>/dev/null || true
    for x in "$@"; do git -C "$x" rev-parse --show-toplevel 2>/dev/null || true; done; } | sort -u
}
resolve_links() { # path: follow a symlink chain (at most 40 hops) and print its end
  local p="$1" l n=0
  while [[ -L "$p" ]]; do
    n=$((n + 1)); [[ $n -le 40 ]] || die "symlink chain too long (or a loop) at $1"
    l=$(readlink "$p")
    case "$l" in /*) p="$l" ;; *) p="$(dirname "$p")/$l" ;; esac
  done
  printf '%s\n' "$p"
}
is_tracked() { # path: 0 iff git tracks it in the work tree around it
  local d b
  d=$(cd "$(dirname "$1")" 2>/dev/null && pwd) || return 1
  b=$(basename "$1")
  git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 && git -C "$d" ls-files --error-unmatch -- "$b" >/dev/null 2>&1
}
refuse_live() { # file label: die unless file is a FROZEN copy (not tracked, not an alias of a tracked file)
  local f="$1" what="$2" p me top t
  p=$(resolve_links "$f")
  for t in "$f" "$p"; do
    if is_tracked "$t"; then die "$what is a git-tracked working-tree file ($t): use a FROZEN copy (untracked) or --before-ref"; fi
  done
  me=$(devino "$f")
  while IFS= read -r top; do
    [[ -n "$top" ]] || continue
    for t in "$top/Signal.js" "$top/$(basename "$f")" "$top/$(basename "$p")"; do
      if [[ -e "$t" ]] && [[ "$(devino "$t")" == "$me" ]] && is_tracked "$t"; then
        die "$what is the same file as the live $t (hard link / symlink): use a FROZEN copy or --before-ref"
      fi
    done
  done < <(live_tops "$(dirname "$f")" "$(dirname "$p")")
}
worst() { # NO-VERDICT > DIFF > SAME
  if [[ $1 == NO-VERDICT || $2 == NO-VERDICT ]]; then echo NO-VERDICT
  elif [[ $1 == DIFF || $2 == DIFF ]]; then echo DIFF
  else echo SAME; fi
}

# ---------------------------------------------------------------------------------------------
# ref / file staging: a frozen copy of one module per side, beside a copy of the driver
# ---------------------------------------------------------------------------------------------
STAGE_MODE=""; STAGE_NAME=""; STAGE_DRIVER=""; STAGE_ABS_B=""; STAGE_ABS_A=""; STAGE_SHA_B=""; STAGE_SHA_A=""
stage_check() { # refuse a bad ref / file staging (no disk write); set the STAGE_* inputs of stage_write
  local side ref sha x t=""
  [[ -z "$BEFORE_REF$AFTER_REF" || -z "$BEFORE_FILE$AFTER_FILE" ]] \
    || die "--before-ref/--after-ref (ref mode) and --before/--after (file mode) are exclusive: give one pair"
  if [[ -n "$BEFORE_REF$AFTER_REF" ]]; then
    STAGE_MODE=ref
    [[ -n "$BEFORE_REF" && -n "$AFTER_REF" ]] || die "--before-ref and --after-ref go together"
  else
    STAGE_MODE=file
    [[ -n "$BEFORE_FILE" && -n "$AFTER_FILE" ]] || die "--before and --after go together"
  fi
  [[ ${#POS[@]} -eq 0 ]] || die "$STAGE_MODE mode takes no DRIVER paths (give --driver FILE), got ${#POS[@]}"
  for x in "$BEFORE_REF" "$AFTER_REF" "$BEFORE_FILE" "$AFTER_FILE" "$MODULE" "$DRIVER" "$REPO"; do
    [[ "$x" != *$'\n'* ]] || die "--before-ref / --after-ref / --before / --after / --module / --driver / --repo: a newline is not allowed"
  done
  [[ -n "$OUT" ]] || die "$STAGE_MODE mode needs --out DIR (the staged copies are written to DIR/stage)"
  [[ -n "$DRIVER" ]] || die "$STAGE_MODE mode needs --driver FILE (a driver that imports the module as './<name>')"
  [[ -f "$DRIVER" && -r "$DRIVER" ]] || die "--driver not found (or not a readable file): $DRIVER"
  [[ -z "${GIT_DIR+x}${GIT_WORK_TREE+x}${GIT_INDEX_FILE+x}${GIT_OBJECT_DIRECTORY+x}${GIT_COMMON_DIR+x}${GIT_CEILING_DIRECTORIES+x}" ]] || die "GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR or GIT_CEILING_DIRECTORIES is set: unset it ($STAGE_MODE mode finds each repo from its path)"
  command -v git >/dev/null 2>&1 || die "$STAGE_MODE mode needs git (ref mode reads the refs; file mode checks that --before is a frozen copy)"
  if [[ -n "$REPO" ]]; then
    t=$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null) || die "--repo is not a git work tree: $REPO"
  elif [[ $STAGE_MODE == ref ]]; then
    t=$(git rev-parse --show-toplevel 2>/dev/null) || die "ref mode: the cwd is not inside a git work tree (give --repo DIR)"
  fi
  if [[ $STAGE_MODE == ref ]]; then
    [[ -n "$MODULE" ]] || die "ref mode needs --module REL (the module's path from the repo root, e.g. src/Thing.js)"
    [[ "$MODULE" != /* ]] || die "--module must be relative to the repo root, got '$MODULE'"
    case "/$MODULE/" in */./*|*/../*|*//*) die "--module must not have an empty, '.' or '..' segment, got '$MODULE'" ;; esac
    REPO="$t"
    for side in before after; do
      if [[ $side == before ]]; then ref="$BEFORE_REF"; else ref="$AFTER_REF"; fi
      [[ "$ref" != -* ]] || die "--$side-ref must not start with '-', got '$ref'"
      sha=$(git -C "$REPO" rev-parse --verify --quiet "$ref^{commit}") || die "--$side-ref: '$ref' is not a commit in $REPO (git fetch?)"
      [[ "$(git -C "$REPO" cat-file -t "$sha:$MODULE" 2>/dev/null)" == blob ]] || die "--$side-ref: $ref ($sha) has no file $MODULE"
      if [[ $side == before ]]; then STAGE_SHA_B="$sha"; else STAGE_SHA_A="$sha"; fi
    done
    STAGE_NAME=$(basename "$MODULE")
  else
    [[ -z "$MODULE" ]] || die "file mode takes no --module (the module name is --after's file name)"
    for side in before after; do
      if [[ $side == before ]]; then x="$BEFORE_FILE"; else x="$AFTER_FILE"; fi
      [[ -f "$x" && -r "$x" ]] || die "--$side not found (or not a readable file): $x"
    done
    refuse_live "$BEFORE_FILE" --before
    [[ ! "$BEFORE_FILE" -ef "$AFTER_FILE" ]] || die "--before and --after are the same file (hard link / symlink): --before must be a FROZEN copy"
    STAGE_NAME=$(basename "$AFTER_FILE")
    STAGE_ABS_B=$(cd "$(dirname "$BEFORE_FILE")" && pwd)/$(basename "$BEFORE_FILE")
    STAGE_ABS_A=$(cd "$(dirname "$AFTER_FILE")" && pwd)/$(basename "$AFTER_FILE")
  fi
  [[ "$STAGE_NAME" != "$(basename "$DRIVER")" ]] || die "the module and --driver have the same file name ($STAGE_NAME): rename the driver"
  grep -q -F -e "'./$STAGE_NAME'" -e "\"./$STAGE_NAME\"" "$DRIVER" || die "--driver must import './$STAGE_NAME' (the staged module beside it): $DRIVER"
  STAGE_DRIVER=$(cd "$(dirname "$DRIVER")" && pwd)/$(basename "$DRIVER")
  [[ -z "$(ls -A "$OUT/stage" 2>/dev/null)" ]] || die "--out: $OUT/stage is not empty (give a new or empty DIR)"
}
stage_write() { # OUT/stage/<side>: that side's module as STAGE_NAME plus the driver; set DRV_B DRV_A STAGE_SAME DESC_*
  local side dir b x
  b=$(basename "$STAGE_DRIVER")
  mkdir -p "$OUT/stage" && mkdir "$OUT/stage/before" "$OUT/stage/after" 2>/dev/null \
    || die "--out: cannot create $OUT/stage/before and $OUT/stage/after"
  for side in before after; do
    dir="$OUT/stage/$side"
    if [[ $STAGE_MODE == ref ]]; then
      if [[ $side == before ]]; then x="$STAGE_SHA_B"; else x="$STAGE_SHA_A"; fi
      git -C "$REPO" cat-file blob "$x:$MODULE" >"$dir/$STAGE_NAME" || die "cannot read $MODULE at $x"   # plumbing: no textconv
    else
      if [[ $side == before ]]; then x="$BEFORE_FILE"; else x="$AFTER_FILE"; fi
      cp "$x" "$dir/$STAGE_NAME" || die "cannot copy $x"   # the copy IS the freeze: later edits to $x cannot leak in
    fi
    cp "$STAGE_DRIVER" "$dir/$b" || die "cannot copy $STAGE_DRIVER"
  done
  DRV_B="$OUT/stage/before/$b"; DRV_A="$OUT/stage/after/$b"
  if cmp -s "$OUT/stage/before/$STAGE_NAME" "$OUT/stage/after/$STAGE_NAME"; then STAGE_SAME=1; else STAGE_SAME=0; fi
  if [[ $STAGE_MODE == ref ]]; then
    DESC_B="$BEFORE_REF @ ${STAGE_SHA_B:0:12}  $MODULE  sha256/8 $(sha8 "$OUT/stage/before/$STAGE_NAME")"
    DESC_A="$AFTER_REF @ ${STAGE_SHA_A:0:12}  $MODULE  sha256/8 $(sha8 "$OUT/stage/after/$STAGE_NAME")"
  else
    DESC_B="$STAGE_ABS_B  sha256/8 $(sha8 "$OUT/stage/before/$STAGE_NAME")"
    DESC_A="$STAGE_ABS_A  sha256/8 $(sha8 "$OUT/stage/after/$STAGE_NAME")"
  fi
  DESC_D="$STAGE_DRIVER  sha256/8 $(sha8 "$DRV_B")"
}

FN_RE='^[A-Za-z_$][A-Za-z0-9_$]*( [A-Za-z_$][A-Za-z0-9_$]*)?$'
LINE_RE='^0 [0-9]+ [0-9]+ (-|[0-9]+(,[0-9]+)*)$'   # a probe line "<driver exit> <count> <bad> <lengths>" of a clean run

vworst() { local a; for a in NO-VERDICT OVER; do if [[ $1 == "$a" || $2 == "$a" ]]; then echo "$a"; return 0; fi; done; echo "$1"; }

distinct() { printf '%s\n' "$1" | tr ',' '\n' | awk '!seen[$0]++'; }   # "l1,l2,.." -> distinct values, first-seen order
# "l1,l2,.." -> its length multiset as MSDIFF_AWK input ("<count> *<TAB><len>", unit * = none), order-free
lens_ms() { printf '%s\n' "$1" | tr ',' '\n' | awk '{ print "*\t" $0 }' | multiset; }

# judge FN MAX LINE1 .. LINER: LINEk = "<driver exit> <count> <bad> <lengths>" of run k; MAX empty = report mode.
# Sets JV (WITHIN OVER REPORTED NO-VERDICT) and JWHY (the reason).
judge() {
  local fn="$1" max="$2" first="$3" line k rc n bad lens l over=""
  local -a lens_a
  shift 2
  JV=NO-VERDICT; JWHY=""
  k=0
  for line in "$@"; do
    k=$((k + 1)); rc="${line%% *}"
    if [[ "$rc" != 0 ]]; then JWHY="driver exited $rc in run $k"; return 0; fi
  done
  k=0
  for line in "$@"; do
    k=$((k + 1))
    if [[ "$line" != "$first" ]]; then JWHY="null control: run $k differs from run 1 (run $k: ${line#* } | run 1: ${first#* })"; return 0; fi
  done
  if ! [[ "$first" =~ $LINE_RE ]]; then JWHY="unreadable probe result '$first' in run 1"; return 0; fi
  read -r rc n bad lens <<<"$first"
  if [[ "$n" == 0 ]]; then JWHY="no function named '$fn' in run 1 (not compiled: never called / lazy, or no such name)"; return 0; fi
  if [[ "$bad" != 0 ]]; then JWHY="$bad of $n matched header(s) not followed by 'Bytecode length: N' in run 1 (unknown format)"; return 0; fi
  if [[ -z "$max" ]]; then JV=REPORTED; JWHY="$n match(es), not gated"; return 0; fi
  IFS=, read -r -a lens_a <<<"$lens"
  for l in "${lens_a[@]}"; do if (( l > max )); then over="$over $l"; fi; done
  if [[ -n "$over" ]]; then JV=OVER; JWHY="length(s)$over > max $max"; else JV=WITHIN; JWHY="every length <= max $max"; fi
}

# over_limits LEN: the limits LEN is outside of (lib/v8limits.sh values; operators as inlining-budget-diff's cross())
over_limits() {
  local l=$1 o=""
  (( l <= TF_SMALL )) || o="$o, TurboFan small (<=$TF_SMALL)"
  (( l <= TF_SMALL_HN )) || o="$o, TurboFan small where a HeapNumber may cross the call (<=$TF_SMALL_HN)"
  (( l <= TF_ONE )) || o="$o, TurboFan single-inline (<=$TF_ONE)"
  (( l < MG_EAGER )) || o="$o, Maglev eager (greedy small) (<$MG_EAGER)"
  (( l <= MG_SMALL )) || o="$o, Maglev small (<=$MG_SMALL)"
  (( l < MG_ONE )) || o="$o, Maglev single-inline (<$MG_ONE)"
  if [[ -z "$o" ]]; then echo "within every limit"; else echo "over ${o#, }"; fi
}

# diff_fn FN: one fn of diff mode, from RB[@] / RA[@] (the before / after probe lines, run k at index k-1): judge()
# each side, then compare the run-1 length multisets. Prints the fn's lines, sets FV (SAME DIFF NO-VERDICT) and
# folds it into VERDICT with worst(). The diff branch and --self-test both run it (one code path).
diff_fn() {
  local fn="$1" VB VA WB WA LB LA LS MSB MSA n l
  judge "$fn" "" "${RB[@]}"; VB=$JV; WB=$JWHY
  judge "$fn" "" "${RA[@]}"; VA=$JV; WA=$JWHY
  LB=-; LA=-
  if [[ "${RB[0]}" =~ $LINE_RE ]]; then read -r _ n _ LB <<<"${RB[0]}"; say "  $fn: before $n match(es): $LB"; fi
  if [[ "${RA[0]}" =~ $LINE_RE ]]; then read -r _ n _ LA <<<"${RA[0]}"; say "  $fn: after  $n match(es): $LA"; fi
  LS="$LB,$LA"; LS="${LS//-/}"; LS="${LS#,}"; LS="${LS%,}"
  if [[ -n "$LS" ]]; then
    while IFS= read -r l; do say "    $l bytes: $(over_limits "$l")"; done < <(distinct "$LS")
  fi
  if [[ $VB == NO-VERDICT || $VA == NO-VERDICT ]]; then
    FV=NO-VERDICT
    if [[ $VB == NO-VERDICT ]]; then say "  $fn: NO-VERDICT -- before: $WB"; fi
    if [[ $VA == NO-VERDICT ]]; then say "  $fn: NO-VERDICT -- after: $WA"; fi
  else
    MSB=$(lens_ms "$LB"); MSA=$(lens_ms "$LA")
    if [[ "$MSB" == "$MSA" ]]; then
      FV=SAME; say "  $fn: SAME -- identical length multiset ($LB | $LA)"
    else
      FV=DIFF; say "  $fn: DIFF -- length multiset differs (before $LB | after $LA)"
      while IFS= read -r l; do say "  $l"; done < <(awk "$MSDIFF_AWK" <(printf '%s\n' "$MSB") <(printf '%s\n' "$MSA") | sort -k3,3n)
    fi
  fi
  VERDICT=$(worst "$VERDICT" "$FV")
}

# ---------------------------------------------------------------------------------------------
# --self-test: canned text through the same awk / judge code, then this script with a fake node
# ---------------------------------------------------------------------------------------------
self_test() {
  local d; d=$(mktemp -d)
  local fails=0 REPORT=/dev/null
  check() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1"; echo "     want: $3"; echo "     got:  $2"; fails=$((fails + 1)); fi; }
  hdr() { printf '[generated bytecode for function: %s (0x%s <SharedFunctionInfo %s>)]\n' "$1" "$2" "$1"; }
  { hdr add 0a1b2c3d4e5f; printf '%s\n' 'Bytecode length: 6' 'Parameter count 3'; } >"$d/add"
  check "count: one header -> count 1, bad 0, its length" "$(awk -v fn=add "$COUNT_AWK" "$d/add")" "1 0 6"
  { hdr read.set 1; echo 'Bytecode length: 285'; hdr reader 2; echo 'Bytecode length: 40'
    hdr read 3; echo 'Bytecode length: 106'; hdr rea 4; echo 'Bytecode length: 9'; } >"$d/names"
  check "count: exact name (read never matches read.set, reader; rea never matches read)" \
    "$(awk -v fn=read "$COUNT_AWK" "$d/names")|$(awk -v fn=rea "$COUNT_AWK" "$d/names")" "1 0 106|1 0 9"
  { hdr f 1; echo 'Bytecode length: 106'; hdr f 2; echo 'Bytecode length: 35'
    hdr g 5; echo 'Bytecode length: 7'; hdr f 3; echo 'Bytecode length: 210'; hdr f 4; echo 'Bytecode length: 106'
    hdr f 6; hdr g 7; echo 'Bytecode length: 7'; hdr f 8; } >"$d/dups"
  check "count: same-name functions keep every length in input order (duplicates kept)" \
    "$(awk -v fn=f "$COUNT_AWK" "$d/dups")" "6 2 106,35,210,106"
  { hdr f 1; echo 'Parameter count 3'; hdr f 2; echo 'Bytecode length: 6'; hdr f 3; } >"$d/bad"
  check "count: a matched header not followed by 'Bytecode length: N' is counted bad (also at EOF)" \
    "$(awk -v fn=f "$COUNT_AWK" "$d/bad")" "3 2 6"
  { hdr f 1; echo 'Bytecode length: 999999999'; hdr f 2; echo 'Bytecode length: 1000000000'
    hdr f 3; echo 'Bytecode length: 9007199254740993'; hdr f 4; echo 'Bytecode length: 0000000006'; } >"$d/cap"
  check "count: a length has 1..9 digits (999999999 is one; 10+ digits, leading zeros included, count bad)" "$(awk -v fn=f "$COUNT_AWK" "$d/cap")" "4 3 999999999"
  { printf '[generated bytecode for function:  (0x1 <SharedFunctionInfo>)]\n'; echo 'Bytecode length: 400'
    hdr 'get value' 2; echo 'Bytecode length: 8'; } >"$d/anon"
  check "count: getter name with a space, anonymous (empty) name" \
    "$(awk -v fn='get value' "$COUNT_AWK" "$d/anon")|$(awk -v fn= "$COUNT_AWK" "$d/anon")" "1 0 8|1 0 400"
  check "count: no match -> 0 0 -" "$(awk -v fn=nosuch "$COUNT_AWK" "$d/dups")|$(awk -v fn=x "$COUNT_AWK" /dev/null)" "0 0 -|0 0 -"
  sed -e 's/0x\([0-9a-f]*\)/0x7ff\1abc/' "$d/dups" >"$d/dups2"
  judge f 999 "0 $(awk -v fn=f "$COUNT_AWK" "$d/dups")" "0 $(awk -v fn=f "$COUNT_AWK" "$d/dups2")"
  check "null control: captures differing only in 0x addresses compare SAME (past the null control)" \
    "$(cmp -s "$d/dups" "$d/dups2" && echo raw-same || echo raw-differs)|$JV|${JWHY%% (*}" \
    "raw-differs|NO-VERDICT|2 of 6 matched header(s) not followed by 'Bytecode length: N' in run 1"
  judge f 999 "0 1 0 6" "0 1 0 7"
  check "null control: run 2 with a changed length -> NO-VERDICT" "$JV|${JWHY%% (*}" "NO-VERDICT|null control: run 2 differs from run 1"
  judge f 6 "0 1 0 6" "0 1 0 6"
  check "gate: a length equal to the max is WITHIN (> not >=)" "$JV|$JWHY" "WITHIN|every length <= max 6"
  judge f 18 "0 2 0 6,19" "0 2 0 6,19" "0 2 0 6,19"
  check "gate: every same-name match is gated (6,19 vs 18 -> OVER)" "$JV|$JWHY" "OVER|length(s) 19 > max 18"
  judge lazy 100 "0 0 0 -" "0 0 0 -"
  check "judge: no match -> NO-VERDICT naming the fn" "$JV|$JWHY" \
    "NO-VERDICT|no function named 'lazy' in run 1 (not compiled: never called / lazy, or no such name)"
  judge f 100 "0 2 1 6" "0 2 1 6"
  check "judge: a bad header -> NO-VERDICT" "$JV|${JWHY%% (*}" "NO-VERDICT|1 of 2 matched header(s) not followed by 'Bytecode length: N' in run 1"
  judge f 100 "0 1 0 6" "3 0 0 -"
  check "judge: a driver exit != 0 in any run -> NO-VERDICT" "$JV|$JWHY" "NO-VERDICT|driver exited 3 in run 2"
  judge f "" "0 4 0 6,5,6,6" "0 4 0 6,5,6,6"
  check "judge: report mode (no max) -> REPORTED" "$JV|$JWHY" "REPORTED|4 match(es), not gated"
  check "worst: NO-VERDICT > OVER > WITHIN (either order)" \
    "$(vworst OVER NO-VERDICT) $(vworst NO-VERDICT OVER) $(vworst WITHIN OVER) $(vworst WITHIN WITHIN) $(vworst REPORTED NO-VERDICT)" \
    "NO-VERDICT NO-VERDICT OVER WITHIN NO-VERDICT"
  local x got=""
  for x in add '$x' _y 'get value' Store.read a.b 'get  value' 1x '' 'a b c' 'a-b'; do
    if [[ "$x" =~ $FN_RE ]]; then got="$got+"; else got="$got-"; fi
  done
  check "fn names: add \$x _y 'get value' accepted; Store.read a.b 'get  value' 1x '' 'a b c' a-b refused" "$got" "++++-------"
  local TF_SMALL=30 TF_SMALL_HN=75 TF_ONE=460 MG_EAGER=30 MG_SMALL=27 MG_ONE=100
  check "crossings: lib limits with cross() operators (TF <=, Maglev eager / single <, small <=)" \
    "$(over_limits 27)|$(over_limits 30)|$(over_limits 100)|$(over_limits 461)" \
    "within every limit|over Maglev eager (greedy small) (<30), Maglev small (<=27)|over TurboFan small (<=30), TurboFan small where a HeapNumber may cross the call (<=75), Maglev eager (greedy small) (<30), Maglev small (<=27), Maglev single-inline (<100)|over TurboFan small (<=30), TurboFan small where a HeapNumber may cross the call (<=75), TurboFan single-inline (<=460), Maglev eager (greedy small) (<30), Maglev small (<=27), Maglev single-inline (<100)"

  # --- diff mode, canned probe lines through diff_fn (the diff branch's judge / multiset / worst code) ---
  local VERDICT FV; local -a RB RA
  dj() { IFS=';' read -r -a RB <<<"$2"; IFS=';' read -r -a RA <<<"$3"; diff_fn "$1" >"$d/dj.out"; }   # FN "B1;B2" "A1;A2"
  djhas() { grep -c -F -x -e "$1" "$d/dj.out" || true; }
  VERDICT=SAME; dj dup "0 2 0 6,19;0 2 0 6,19" "0 2 0 19,6;0 2 0 19,6"
  check "diff: a length multiset is order-free (6,19 | 19,6 -> SAME)" \
    "$FV|$VERDICT|$(djhas '  dup: SAME -- identical length multiset (6,19 | 19,6)')" "SAME|SAME|1"
  VERDICT=SAME; dj f "0 1 0 6;0 1 0 6" "0 2 0 6,6;0 2 0 6,6"
  check "diff: a length multiset counts duplicates (6 | 6,6 -> DIFF, before=1 after=2)" \
    "$FV|$VERDICT|$(djhas '    before=1 after=2  6')" "DIFF|DIFF|1"
  VERDICT=SAME; dj f "0 1 0 6;0 1 0 6" "0 0 0 -;0 0 0 -"
  check "diff: each side is judged (after count 0 -> NO-VERDICT naming after)" \
    "$FV|$VERDICT|$(djhas "  f: NO-VERDICT -- after: no function named 'f' in run 1 (not compiled: never called / lazy, or no such name)")|$(grep -c -e ' -- before: ' "$d/dj.out" || true)" \
    "NO-VERDICT|NO-VERDICT|1|0"
  VERDICT=SAME; dj f "0 1 0 6;0 1 0 6" "0 1 0 6;0 1 0 7"
  check "diff: each side keeps its null control (after run 2 6 -> 7 -> NO-VERDICT naming after)" \
    "$FV|$VERDICT|$(djhas '  f: NO-VERDICT -- after: null control: run 2 differs from run 1 (run 2: 1 0 7 | run 1: 1 0 6)')|$(grep -c -e ' -- before: ' "$d/dj.out" || true)" \
    "NO-VERDICT|NO-VERDICT|1|0"
  VERDICT=SAME; dj f "0 1 0 6;0 1 0 7" "0 1 0 6;0 1 0 6"
  check "diff: each side keeps its null control (before run 2 6 -> 7 -> NO-VERDICT naming before)" \
    "$FV|$VERDICT|$(djhas '  f: NO-VERDICT -- before: null control: run 2 differs from run 1 (run 2: 1 0 7 | run 1: 1 0 6)')|$(grep -c -e ' -- after: ' "$d/dj.out" || true)" \
    "NO-VERDICT|NO-VERDICT|1|0"
  VERDICT=SAME; got=""
  for x in mid lazy - lazy mid; do
    case "$x" in
      -) VERDICT=SAME; got="$got |" ;;
      mid) dj mid "0 1 0 211;0 1 0 211" "0 1 0 212;0 1 0 212"; got="$got $FV>$VERDICT" ;;
      lazy) dj lazy "0 0 0 -;0 0 0 -" "0 0 0 -;0 0 0 -"; got="$got $FV>$VERDICT" ;;
    esac
  done
  check "diff: worst() over fns, NO-VERDICT > DIFF > SAME (mid DIFF + lazy NO-VERDICT -> NO-VERDICT, either order)" \
    "$got" " DIFF>DIFF NO-VERDICT>NO-VERDICT | NO-VERDICT>NO-VERDICT DIFF>NO-VERDICT"

  # --- this script end to end, with a fake node (logs argv, prints a version, cats a capture per filter) ---
  local fk="$d/fk" drv="$d/drv/driver.mjs" rc out
  mkdir -p "$fk" "$d/drv" "$d/tmp" "$d/cwd"; : >"$drv"
  printf '%s\n' '#!/bin/sh' 'd=$(dirname "$0")' 'printf "%s\n" "$*" >>"$d/log"' \
    'case "$1" in --version) echo "${FAKE_VER:-v26.8.2}"; exit 0 ;; --v8-options) exit 0 ;; esac' \
    'f=""; for a; do case "$a" in --print-bytecode-filter=*) f="${a#--print-bytecode-filter=}" ;; esac; done' \
    'n=$(( $(cat "$d/$f.n" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$d/$f.n"' \
    'src="$d/$f.txt"; [ -f "$d/$f.$n.txt" ] && src="$d/$f.$n.txt"' \
    '[ -f "./$f.txt" ] && src="./$f.txt"' \
    '[ -f "$src" ] && sed "s/(0x/(0x$n/" "$src"' 'exit "${FAKE_RC:-0}"' >"$fk/node"
  chmod +x "$fk/node"
  cp "$d/add" "$fk/add.txt"; : >"$fk/lazy.txt"
  { hdr mid 1; echo 'Bytecode length: 211'; } >"$fk/mid.txt"
  { hdr dup 1; echo 'Bytecode length: 6'; hdr dup 2; echo 'Bytecode length: 19'; } >"$fk/dup.txt"
  { hdr read 1; echo 'Bytecode length: 6'; hdr read 2; echo 'Bytecode length: 5'
    hdr read 3; echo 'Bytecode length: 6'; hdr read 4; echo 'Bytecode length: 6'; } >"$fk/read.txt"
  spawn() { # ENV|- args... -> "rc|VERDICT line|node spawns"; output in $d/sp.out
    local -a e=()
    [[ "$1" == - ]] || e=("$1")
    shift
    rm -f "$fk"/*.n; : >"$fk/log"
    (cd "$d/cwd" && env ${e[@]+"${e[@]}"} TMPDIR="$d/tmp" "$BASH" "$SELF" --node "$fk/node" "$@") >"$d/sp.out" 2>&1 && rc=0 || rc=$?
    printf '%s|%s|%s' "$rc" "$(grep '^VERDICT ' "$d/sp.out" || true)" "$(wc -l <"$fk/log" | tr -d ' ')"
  }
  has() { grep -c -e "$1" "$d/sp.out" || true; }
  check "gate (fake node): 3 fns within -> exit 0; 8 spawns (--version, --v8-options, 3 fns x 2 runs)" \
    "$(spawn - --max add=6,mid=211,dup=19 --node-version v26.8.2 "$drv")" "0|VERDICT WITHIN|8"
  check "without --out nothing is written to disk (cwd and TMPDIR stay empty)" \
    "$(find "$d/tmp" "$d/cwd" -mindepth 1 | wc -l | tr -d ' ')" 0
  check "gate (fake node): over -> exit 1 OVER (FINAL=1 keeps the planned exit), reason names fn" \
    "$(spawn - --max mid=210 --node-version v26.8.2 "$drv")|$(has '^  mid: OVER -- length(s) 211 > max 210$')" "1|VERDICT OVER|4|1"
  check "gate (fake node): every same-name function is gated (dup 6,19 vs 18 -> OVER)" \
    "$(spawn - --max dup=18 --node-version v26.8.2 "$drv")" "1|VERDICT OVER|4"
  check "gate (fake node): node version mismatch -> exit 2 before any probe (1 spawn), reason names fn" \
    "$(spawn FAKE_VER=v26.8.1 --max mid=1 --node-version v26.8.2 "$drv")|$(has '^  mid: NO-VERDICT -- node version mismatch: ')" \
    "2|VERDICT NO-VERDICT|1|1"
  check "fn regex: a qualified name (Store.read) exits 2 with 0 spawns" \
    "$(spawn - --max Store.read=1 --node-version v26.8.2 "$drv")" "2|VERDICT NO-VERDICT|0"
  check "report mode (fake node): exit 0 REPORTED; read = 4 matches in input order" \
    "$(spawn - --fn read,dup "$drv")|$(has '^  read: 4 match(es): 6,5,6,6$')" "0|VERDICT REPORTED|6|1"
  check "lazy (no match) -> exit 2 NO-VERDICT, reason names fn" \
    "$(spawn - --max lazy=100 --node-version v26.8.2 "$drv")|$(has "^  lazy: NO-VERDICT -- no function named 'lazy' in run 1")" \
    "2|VERDICT NO-VERDICT|4|1"
  check "driver exit 1 -> exit 2 NO-VERDICT (never OVER)" \
    "$(spawn FAKE_RC=1 --max mid=1 --node-version v26.8.2 "$drv")|$(has '^  mid: NO-VERDICT -- driver exited 1 in run 1$')" \
    "2|VERDICT NO-VERDICT|4|1"
  { hdr mid 1; echo 'Bytecode length: 212'; } >"$fk/mid.2.txt"
  check "null control (fake node): run 2 prints another length -> exit 2 NO-VERDICT" \
    "$(spawn - --max mid=211 --node-version v26.8.2 "$drv")|$(has '^  mid: NO-VERDICT -- null control: run 2 differs from run 1')" \
    "2|VERDICT NO-VERDICT|4|1"
  rm -f "$fk/mid.2.txt"
  check "--out: report.txt + raw/ with one raw file per fn per run, 0x addresses kept raw" \
    "$(spawn - --out "$d/o" --max add=6,mid=211,dup=19 --node-version v26.8.2 "$drv")|$(grep -c '^VERDICT WITHIN$' "$d/o/report.txt" || true)|$(find "$d/o/raw" -type f | wc -l | tr -d ' ')|$(cat "$d/o/raw/dup.2.txt" | grep -c '(0x21 ' || true)" \
    "0|VERDICT WITHIN|8|1|6|1"
  got=""
  for x in '--fn add,add' '--runs 1 --fn add' '--runs 21 --fn add' '--fn add --max add=1 --node-version v26.8.2' \
    '--fn add --v8-flags --print_bytecode' '--fn add --v8-flags x.js' '--max add=1' '--max add=x --node-version v26.8.2' \
    '--max add=1 --node-version 26.8.2' '--fn add --nod-version v26.8.2' '--fn add'; do
    # shellcheck disable=SC2086
    out=$(spawn - $x "$drv"); got="$got${out%%|*}:${out##*|} "
  done
  out=$(spawn - --fn add); got="$got${out%%|*}:${out##*|} "
  out=$(spawn - --fn add "$drv" "$drv"); got="$got${out%%|*}:${out##*|}"
  check "refused before any spawn (exit 2, 0 spawns): repeated fn, runs 1 / 21, --fn with --max, *print-bytecode* / non-flag v8 flag, no --node-version, bad N, bad version, unknown option; then a valid --fn add runs; no DRIVER, two DRIVERs" \
    "$got" "2:0 2:0 2:0 2:0 2:0 2:0 2:0 2:0 2:0 2:0 0:4 2:0 2:0"

  # --- diff mode end to end: the fake node cats <fn>.txt beside the driver (cwd) when there, so the sides differ ---
  local drva="$d/drva/driver.mjs"
  mkdir -p "$d/drva"; : >"$drva"
  { hdr mid 1; echo 'Bytecode length: 212'; } >"$d/drva/mid.txt"
  { hdr dup 1; echo 'Bytecode length: 19'; hdr dup 2; echo 'Bytecode length: 6'; } >"$d/drva/dup.txt"
  { hdr add 1; echo 'Bytecode length: 6'; hdr add 2; echo 'Bytecode length: 6'; } >"$d/drva/add.txt"
  : >"$d/drva/read.txt"
  check "diff (fake node): one DRIVER on both sides -> exit 0 SAME; 6 spawns (--version, --v8-options, 1 fn x 2 runs x 2 sides); nothing on disk" \
    "$(spawn - --diff --fn mid "$drv" "$drv")|$(has '^  mid: SAME -- identical length multiset (211 | 211)$')|$(find "$d/tmp" "$d/cwd" -mindepth 1 | wc -l | tr -d ' ')" \
    "0|VERDICT SAME|6|1|0"
  check "diff (fake node): mid 211 | 212 -> exit 1 DIFF (FINAL=1 keeps the planned exit), one count line per length" \
    "$(spawn - --diff --fn mid "$drv" "$drva")|$(has '^    before=1 after=0  211$')|$(has '^    before=0 after=1  212$')" "1|VERDICT DIFF|6|1|1"
  check "diff (fake node): dup 6,19 | 19,6 -> exit 0 SAME (order-free)" \
    "$(spawn - --diff --fn dup "$drv" "$drva")" "0|VERDICT SAME|6"
  check "diff (fake node): add 6 | 6,6 -> exit 1 DIFF (multiplicity)" \
    "$(spawn - --diff --fn add "$drv" "$drva")|$(has '^    before=1 after=2  6$')" "1|VERDICT DIFF|6|1"
  check "diff (fake node): read 4 matches | none -> exit 2 NO-VERDICT naming after" \
    "$(spawn - --diff --fn read "$drv" "$drva")|$(has "^  read: NO-VERDICT -- after: no function named 'read' in run 1 ")" "2|VERDICT NO-VERDICT|6|1"
  check "diff (fake node): mid DIFF + lazy NO-VERDICT -> exit 2 NO-VERDICT (worst over fns)" \
    "$(spawn - --diff --fn mid,lazy "$drv" "$drva")" "2|VERDICT NO-VERDICT|10"
  check "diff --out (fake node): 3 fns x 2 runs -> 14 spawns, report.txt, raw/before and raw/after 6 files each" \
    "$(spawn - --out "$d/od" --diff --fn add,mid,dup "$drv" "$drva")|$(grep -c '^VERDICT DIFF$' "$d/od/report.txt" || true)|$(find "$d/od/raw/before" -type f | wc -l | tr -d ' ')|$(find "$d/od/raw/after" -type f | wc -l | tr -d ' ')" \
    "1|VERDICT DIFF|14|1|6|6"
  check "diff (fake node): node version mismatch -> exit 2 before any probe (1 spawn), report-mode wording" \
    "$(spawn FAKE_VER=v26.8.1 --diff --fn mid --node-version v26.8.2 "$drv" "$drva")|$(has '^  mid: NO-VERDICT -- node version mismatch: .*, --node-version is v26.8.2$')" \
    "2|VERDICT NO-VERDICT|1|1"
  got=""
  for x in "--diff --max mid=1 --node-version v26.8.2 $drv $drva" "--diff --fn mid $drv" "--diff --fn mid $drv $drv $drva" \
    "--diff=x --fn mid $drv $drva" "--diff --diff --fn mid $drv $drva" "--diff $drv $drva" "--diff --fn mid $drv $d/drva/nosuch.mjs"; do
    # shellcheck disable=SC2086
    out=$(spawn - $x); got="$got${out%%|*}:${out##*|} "
  done
  check "diff refusals before any spawn (exit 2, 0 spawns): --diff with --max, 1 DRIVER, 3 DRIVERs, --diff=x, --diff twice, no --fn, a missing DRIVER_AFTER" \
    "$got" "2:0 2:0 2:0 2:0 2:0 2:0 2:0 "

  # --- ref / file modes end to end (lib/stage.sh): a temp git repo (m/mid.txt: r1 = 211, r2 = 212), every git call
  # isolated (no global / system config, no hooks, no signing); the fake node cats ./mid.txt from cwd = the stage dir.
  # The six GIT_* vars stage_check refuses are unset for these rows, so they also run from inside a git hook.
  if command -v git >/dev/null 2>&1; then
    local R="$d/repo" sd="$d/sdrv/driver.mjs" frz="$d/frz/mid.txt" sr=0
    local -a RR
    tg() { (unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_CEILING_DIRECTORIES
      GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -c core.hooksPath=/dev/null -c user.name=t -c user.email=t@t \
        -c commit.gpgsign=false "$@"); }
    sspawn() { (unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_CEILING_DIRECTORIES
      export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; spawn "$@"); }
    rf() { out=$(sspawn "$@"); got="$got${out%%|*}:${out##*|} "; }
    mkdir -p "$R/m" "$d/sdrv" "$d/frz/deep"
    printf '%s\n' "import './mid.txt';" >"$sd"; printf '%s\n' '// imports nothing' >"$d/sdrv/noimp.mjs"
    { hdr mid 1; echo 'Bytecode length: 211'; } >"$R/m/mid.txt"
    { tg init -q "$R" && tg -C "$R" add m/mid.txt && tg -C "$R" commit -q -m r1 && tg -C "$R" tag r1 \
      && { hdr mid 1; echo 'Bytecode length: 212'; } >"$R/m/mid.txt" && tg -C "$R" commit -q -a -m r2 && tg -C "$R" tag r2 \
      && tg -C "$R" cat-file blob r1:m/mid.txt >"$frz" && ln "$R/m/mid.txt" "$d/frz/deep/renamed.txt" \
      && tg init -q "$d/other"; } >"$d/git.log" 2>&1 || sr=$?
  fi
  if ! command -v git >/dev/null 2>&1; then
    check "ref / file modes: git on PATH (their rows need git; MD-7: no git fails closed)" "git not found on PATH" "git found"
  elif [[ $sr != 0 ]]; then
    check "ref / file modes: temp git repo set up (init, commits r1 r2, tags)" "git exited $sr: $(tail -n 1 "$d/git.log")" "ok"
  else
    check "ref mode (fake node, temp git repo): --before-ref r1 --after-ref r2, m/mid.txt 211 | 212 -> exit 1 DIFF, 6 spawns, before=1 after=0  211" \
      "$(sspawn - --out "$d/sr1" --diff --fn mid --before-ref r1 --after-ref r2 --module m/mid.txt --driver "$sd" --repo "$R")|$(has '^    before=1 after=0  211$')" \
      "1|VERDICT DIFF|6|1"
    check "ref mode: --before-ref r1 --after-ref r1 (byte-identical modules) -> exit 0 SAME plus the null-control NOTE" \
      "$(sspawn - --out "$d/sr2" --diff --fn mid --before-ref r1 --after-ref r1 --module m/mid.txt --driver "$sd" --repo "$R")|$(has '^NOTE    before and after modules are byte-identical: this run is a null control (expect SAME)$')" \
      "0|VERDICT SAME|6|1"
    check "file mode: --before a FROZEN copy (r1, 211) --after the live tracked m/mid.txt (212) -> exit 1 DIFF; OUT holds 9 files (report.txt, raw 2 + 2, stage 2 + 2)" \
      "$(sspawn - --out "$d/sf" --diff --fn mid --before "$frz" --after "$R/m/mid.txt" --driver "$sd")|$(find "$d/sf" -type f | wc -l | tr -d ' ')" \
      "1|VERDICT DIFF|6|9"
    got=""; RR=(--before-ref r1 --after-ref r2 --module m/mid.txt --driver "$sd" --repo "$R")
    rf - --diff --fn mid --out "$d/rf1" --before-ref r1 --module m/mid.txt --driver "$sd" --repo "$R"; got="${got% }+$(has '^bytecode-budget: --before-ref and --after-ref go together$') "
    rf - --fn mid --out "$d/rf2" "${RR[@]}"; got="${got% }+$(has '^bytecode-budget: --before-ref/--after-ref and --before/--after need --diff ') "
    rf - --diff --fn mid "${RR[@]}"; got="${got% }+$(has '^bytecode-budget: ref mode needs --out DIR') "
    rf - --diff --fn mid --out "$d/rf3" --before-ref r1 --after-ref r2 --module m/mid.txt --driver "$d/sdrv/noimp.mjs" --repo "$R"
    rf - --diff --fn mid --out "$d/rf4" --before-ref nosuch --after-ref r2 --module m/mid.txt --driver "$sd" --repo "$R"
    rf - --diff --fn mid --out "$d/rf5" --before-ref r1 --after-ref r2 --module m/../m/mid.txt --driver "$sd" --repo "$R"; got="${got% }+$(has "^bytecode-budget: --module must not have an empty, '.' or '..' segment, got 'm/../m/mid.txt'$") "
    rf - --diff --fn mid --out "$d/rf6" "${RR[@]}" --before "$frz" --after "$R/m/mid.txt"
    rf - --diff --fn mid --out "$d/rf7" --before "$R/m/mid.txt" --after "$frz" --driver "$sd"
    rf - --diff --fn mid --out "$d/rf8" --before "$d/frz/deep/renamed.txt" --after "$R/m/mid.txt" --driver "$sd"
    rf GIT_DIR="$d/other/.git" --diff --fn mid --out "$d/rf9" --before "$R/m/mid.txt" --after "$frz" --driver "$sd"
    rf GIT_INDEX_FILE="$d/noindex" --diff --fn mid --out "$d/rf10" --before "$R/m/mid.txt" --after "$frz" --driver "$sd"
    mkdir -p "$d/sne/stage/x"; rf - --diff --fn mid --out "$d/sne" "${RR[@]}"
    check "ref / file refusals before any spawn (exit 2, 0 spawns, no OUT dir): --before-ref alone, no --diff, no --out (+1: its line says 'needs --out'), a driver without './mid.txt', a bad ref, a '..' --module, ref + file pairs, a tracked --before, --before a hard link of --after, GIT_DIR / GIT_INDEX_FILE set + a tracked --before, a non-empty OUT/stage (left as it was)" \
      "$got|$(find "$d" -maxdepth 1 -name 'rf*' | wc -l | tr -d ' ')|$(ls -A "$d/sne")" \
      "2:0+1 2:0+1 2:0+1 2:0 2:0 2:0+1 2:0 2:0 2:0 2:0 2:0 2:0 |0|stage"
  fi

  if [[ -n "$FIXTURES" ]]; then
    # TASK 0 census (grep -A1 over the captures, no script awk): every matched header has its length line.
    local row file fn want pairs="" mis=""
    while IFS='|' read -r file fn want; do
      if [[ -r "$FIXTURES/$file" ]]; then got=$(awk -v fn="$fn" "$COUNT_AWK" "$FIXTURES/$file"); else got="missing $file"; fi
      check "fixture $file [$fn]" "$got" "$want"
      pairs="$pairs$file|$fn"$'\n'
    done <<'EOF'
add.txt|add|1 0 6
mid.txt|mid|1 0 211
big.txt|big|1 0 628
read.txt|read|4 0 6,5,6,6
Store.read.txt|Store.read|0 0 -
get-value.txt|get value|1 0 8
make.txt|make|1 0 11
dup.txt|dup|2 0 6,19
lazy.txt|lazy|0 0 -
inner.txt|inner|1 0 6
nosuchfn.txt|nosuchfn|0 0 -
empty-filter.txt||5 0 5,119,400,6,6
re-star.txt|read|4 0 6,5,6,6
all.txt|add|1 0 6
all.txt|mid|1 0 211
all.txt|big|1 0 628
all.txt|read|4 0 6,5,6,6
all.txt|dup|2 0 6,19
all.txt|inner|1 0 6
all.txt|lazy|0 0 -
all.txt|Store|1 0 8
all.txt|get value|1 0 8
EOF
    if [[ -r "$FIXTURES/v8-options-excerpt.txt" && -r "$FIXTURES/limits.txt" ]]; then
      got=$(awk "$LIMITS_AWK" "$FIXTURES/v8-options-excerpt.txt" | cmp -s - "$FIXTURES/limits.txt" && echo same || echo differs)
    else got="missing v8-options-excerpt.txt or limits.txt"; fi
    check "fixture LIMITS_AWK(v8-options-excerpt.txt) == limits.txt" "$got" same
    pairs="${pairs}re-star.txt|re*"$'\n'
    while IFS='|' read -r file fn; do
      [[ -n "$file" ]] || continue
      if [[ ! -r "$FIXTURES/$file" ]]; then mis="$mis missing:$file"; continue; fi
      row=$(awk -v fn="$fn" "$COUNT_AWK" "$FIXTURES/$file"); row="${row##* }"; [[ "$row" != - ]] || row=""
      row=$(distinct "$row" | awk 'NF' | paste -sd, -)
      [[ "$row" == "$(awk -v fn="$fn" "$BYTECODE_AWK" "$FIXTURES/$file")" ]] || mis="$mis $file[$fn]"
    done <<<"$pairs"
    check "fixture distinct(COUNT_AWK) == BYTECODE_AWK on all 23 pairs" "${mis:-none}" none
  fi
  rm -rf "$d"; echo
  if [[ $fails -eq 0 ]]; then echo "self-test: all checks passed"; return 0; fi
  echo "self-test: $fails check(s) FAILED"; return 1
}

# ---------------------------------------------------------------------------------------------
# options (every check below runs before any node is spawned)
# ---------------------------------------------------------------------------------------------
FNLIST=""; MAXLIST=""; WANT_VER=""; RUNS=2; NODE_BIN="${NODE:-node}"; V8FLAGS=""; OUT=""
SELFTEST=0; FIXTURES=""; POS=(); GOTOPT=" "; DIFFMODE=0
BEFORE_REF=""; AFTER_REF=""; BEFORE_FILE=""; AFTER_FILE=""; MODULE=""; DRIVER=""; REPO=""; STAGED=0
OPTS="--fn --max --node-version --runs --node --v8-flags --out --self-test --fixtures --help --diff --before-ref --after-ref --before --after --module --driver --repo"
hint() { local o; for o in $OPTS; do if [[ "$o" == "$1"* || "$1" == "$o"* ]]; then printf ' (did you mean %s?)' "$o"; return 0; fi; done; }
need() { # value from --opt=value (returns 0) or from the next argument (returns 1: caller shifts)
  if [[ -n "$v" ]]; then return 0; fi
  [[ $# -ge 2 ]] || die "$a needs a value"
  v="$2"; return 1
}
while [[ $# -gt 0 ]]; do
  a="$1"; v=""; EQ=0
  case "$a" in --*=*) v="${a#*=}"; a="${a%%=*}"; EQ=1 ;; esac
  case "$a" in
    -h|--help) [[ $EQ -eq 0 ]] || die "$a takes no value"; usage; exit 2 ;;
    --self-test) [[ $EQ -eq 0 ]] || die "$a takes no value"; SELFTEST=1 ;;
    --diff)
      [[ $EQ -eq 0 ]] || die "$a takes no value"
      [[ "$GOTOPT" != *" $a "* ]] || die "$a given twice"
      GOTOPT="$GOTOPT $a "; DIFFMODE=1 ;;
    --fn|--max|--node-version|--runs|--node|--v8-flags|--out|--fixtures|--before-ref|--after-ref|--before|--after|--module|--driver|--repo)
      [[ "$GOTOPT" != *" $a "* ]] || die "$a given twice (give one comma list)"
      GOTOPT="$GOTOPT $a "
      if [[ $EQ -eq 0 ]] && ! need "$@"; then shift; fi
      [[ -n "$v" ]] || die "$a needs a non-empty value"
      case "$a" in
        --fn) FNLIST="$v" ;; --max) MAXLIST="$v" ;; --node-version) WANT_VER="$v" ;; --runs) RUNS="$v" ;;
        --node) NODE_BIN="$v" ;; --v8-flags) V8FLAGS="$v" ;; --out) OUT="$v" ;; --fixtures) FIXTURES="$v" ;;
        --before-ref) BEFORE_REF="$v" ;; --after-ref) AFTER_REF="$v" ;; --before) BEFORE_FILE="$v" ;; --after) AFTER_FILE="$v" ;;
        --module) MODULE="$v" ;; --driver) DRIVER="$v" ;; --repo) REPO="$v" ;;
      esac ;;
    -*) die "unknown option $a$(hint "$a") (see --help)" ;;
    *) POS+=("$a") ;;
  esac
  shift
done

if [[ $SELFTEST == 1 ]]; then
  g="${GOTOPT// --fixtures /}"
  [[ -z "${g// /}" && ${#POS[@]} -eq 0 ]] || die "--self-test takes only --fixtures DIR"
  if [[ -n "$FIXTURES" ]]; then [[ -d "$FIXTURES" && -r "$FIXTURES" && -x "$FIXTURES" ]] || die "--fixtures: not a readable directory: $FIXTURES"; fi
  if self_test; then FINAL=1; exit 0; else FINAL=1; exit 1; fi
fi
[[ -z "$FIXTURES" ]] || die "--fixtures goes with --self-test"
[[ "$FNLIST$MAXLIST$V8FLAGS" != *$'\n'* ]] || die "--fn / --max / --v8-flags: a newline is not allowed"
[[ $DIFFMODE == 0 || -z "$MAXLIST" ]] || die "--diff and --max are exclusive: --diff compares two DRIVERs with --fn LIST, --max gates one"
if [[ -n "$BEFORE_REF$AFTER_REF$BEFORE_FILE$AFTER_FILE" ]]; then STAGED=1; fi
[[ $STAGED == 0 || $DIFFMODE == 1 ]] || die "--before-ref/--after-ref and --before/--after need --diff (ref and file modes are diff modes)"
[[ $STAGED == 1 || -z "$DRIVER$MODULE$REPO" ]] || die "--driver / --module / --repo go only with --before-ref/--after-ref or --before/--after (and --diff)"

[[ -n "$FNLIST$MAXLIST" ]] || die "need --fn LIST (report) or --max fn=N[,fn=N] (gate) (see --help)"
[[ -z "$FNLIST" || -z "$MAXLIST" ]] || die "--fn (report) and --max (gate) are exclusive: give one"
[[ "$FNLIST$MAXLIST" != ,* && "$FNLIST$MAXLIST" != *, && "$FNLIST$MAXLIST" != *,,* ]] \
  || die "--fn / --max: empty entry (stray comma)"
TARGETS=(); MAXES=()
if [[ -n "$MAXLIST" ]]; then
  IFS=, read -r -a ENTS <<<"$MAXLIST"
  for e in ${ENTS[@]+"${ENTS[@]}"}; do
    [[ "$e" == *=* ]] || die "--max entries are fn=N, got '$e'"
    n="${e#*=}"
    [[ "$n" =~ ^[0-9]{1,9}$ ]] || die "--max ${e%%=*}: N must be an integer of 1..9 digits, got '$n'"
    TARGETS+=("${e%%=*}"); MAXES+=("$((10#$n))")
  done
  [[ -n "$WANT_VER" ]] || die "gate mode (--max) needs --node-version vX.Y.Z: the node version the maxima were taken on"
else
  IFS=, read -r -a TARGETS <<<"$FNLIST"
fi
[[ ${#TARGETS[@]} -gt 0 ]] || die "no function named (--fn / --max is empty)"
SEEN="|"
for t in "${TARGETS[@]}"; do
  [[ "$t" =~ $FN_RE ]] || die "fn must be a short V8 function name (e.g. read, get value; never Store.read), got '$t'"
  [[ "$SEEN" != *"|$t|"* ]] || die "fn '$t' is given twice"
  SEEN="$SEEN$t|"
done
[[ -z "$WANT_VER" || "$WANT_VER" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--node-version must be vX.Y.Z (as \`node --version\` prints it), got '$WANT_VER'"
[[ "$RUNS" =~ ^[0-9]{1,2}$ ]] && RUNS=$((10#$RUNS)) && [[ $RUNS -ge 2 && $RUNS -le 20 ]] \
  || die "--runs must be an integer in [2, 20] (null control), got '$RUNS'"
read -r -a V8_EXTRA <<<"$V8FLAGS" || true
[[ -z "$V8FLAGS" || ${#V8_EXTRA[@]} -gt 0 ]] || die "--v8-flags needs at least one flag, got only blanks"
for f in ${V8_EXTRA[@]+"${V8_EXTRA[@]}"}; do
  [[ "$f" == --[A-Za-z]* ]] || die "--v8-flags takes flags only (each starts with -- and a letter), got '$f'"
  g="${f//_/-}"
  [[ "$g" != *print-bytecode* ]] || die "--v8-flags must not set $f: the probe sets --print-bytecode itself"
  g="${g#--}"; g="${g%%=*}"; g="${g#no}"; g="${g#-}"
  case "$g" in
    max*inlined*bytecode*)
      [[ "$f" =~ ^--[^=]+=[0-9]{1,9}$ && "${f:2:2}" != no ]] || die "--v8-flags: $f needs =N (an integer of 1..9 digits)" ;;
    reserve*inline*budget*)
      [[ "$f" =~ ^--[^=]+=[0-9]{1,9}(\.[0-9]{1,9})?$ && "${f:2:2}" != no ]] || die "--v8-flags: $f needs =X (a decimal number, e.g. 1.2)" ;;
  esac
done
[[ "$OUT" != -* ]] || OUT="./$OUT"
if [[ $DIFFMODE == 1 && $STAGED == 1 ]]; then
  stage_check   # lib/stage.sh: every ref / file refusal, before any disk write
elif [[ $DIFFMODE == 1 ]]; then
  [[ ${#POS[@]} -eq 2 ]] || die "--diff needs exactly two DRIVER files (BEFORE AFTER), got ${#POS[@]} (see --help)"
  [[ -f "${POS[0]}" && -r "${POS[0]}" ]] || die "DRIVER (before) not found (or not a readable file): ${POS[0]}"
  [[ -f "${POS[1]}" && -r "${POS[1]}" ]] || die "DRIVER (after) not found (or not a readable file): ${POS[1]}"
  DRV_B_DIR=$(cd -- "$(dirname -- "${POS[0]}")" && pwd); DRV_B_BASE=$(basename -- "${POS[0]}")
  [[ "$DRV_B_DIR/$DRV_B_BASE" -ef "${POS[0]}" ]] || die "DRIVER (before): cannot resolve the directory of ${POS[0]} (a symlink before '..'?)"
  DRV_A_DIR=$(cd -- "$(dirname -- "${POS[1]}")" && pwd); DRV_A_BASE=$(basename -- "${POS[1]}")
  [[ "$DRV_A_DIR/$DRV_A_BASE" -ef "${POS[1]}" ]] || die "DRIVER (after): cannot resolve the directory of ${POS[1]} (a symlink before '..'?)"
  SHA_B=$(sha8 "$DRV_B_DIR/$DRV_B_BASE"); SHA_A=$(sha8 "$DRV_A_DIR/$DRV_A_BASE")
  DESC_B="${DRV_B_DIR%/}/$DRV_B_BASE  sha256/8 $SHA_B"; DESC_A="${DRV_A_DIR%/}/$DRV_A_BASE  sha256/8 $SHA_A"
else
  [[ ${#POS[@]} -eq 1 ]] || die "need exactly one DRIVER file, got ${#POS[@]} (see --help)"
  [[ -f "${POS[0]}" && -r "${POS[0]}" ]] || die "DRIVER not found (or not a readable file): ${POS[0]}"
  DRV_DIR=$(cd -- "$(dirname -- "${POS[0]}")" && pwd); DRV_BASE=$(basename -- "${POS[0]}")
  [[ "$DRV_DIR/$DRV_BASE" -ef "${POS[0]}" ]] || die "DRIVER: cannot resolve the directory of ${POS[0]} (a symlink before '..'?)"
fi
# resolve the binary ONCE, from the caller's cwd: every spawn (--version, --v8-options, each probe in its driver dir)
# runs this absolute path, so a relative PATH entry can never pick a different node per cwd. A name with a slash is a
# path (never looked up on PATH): it goes straight to the -f / -x check, so a directory is named as such
NODE_RES=$NODE_BIN
if [[ "$NODE_BIN" != */* ]]; then NODE_RES=$(command -v -- "$NODE_BIN" 2>/dev/null) || die "node binary not found: $NODE_BIN"; fi
[[ "$NODE_RES" == */* ]] || die "node binary is not a file on PATH (a function, alias or builtin?): $NODE_BIN -> $NODE_RES"
[[ -f "$NODE_RES" && -x "$NODE_RES" ]] || die "node binary is not an executable file: $NODE_RES"
NODE_DIR=$(dirname -- "$NODE_RES"); [[ "$NODE_DIR" != - ]] || NODE_DIR=./-
NODE_DIR=$(cd -- "$NODE_DIR" 2>/dev/null && pwd) || die "node binary: cannot resolve the directory of $NODE_RES"
NODE_BIN="${NODE_DIR%/}/$(basename -- "$NODE_RES")"
[[ "$NODE_BIN" -ef "$NODE_RES" ]] || die "node binary is not an executable file: $NODE_RES"
if [[ -n "$OUT" ]]; then
  # refuse before any write: an unreadable raw/ fools the emptiness test below; a symlinked report.txt redirects the write
  [[ ! -e "$OUT/raw" || ( -r "$OUT/raw" && -x "$OUT/raw" ) ]] || die "--out: $OUT/raw is not readable"
  [[ ! -e "$OUT/raw" || -w "$OUT/raw" ]] || die "--out: $OUT/raw is not writable"
  [[ ! -L "$OUT/report.txt" ]] || die "--out: $OUT/report.txt is a symlink (refused: the write would follow it)"
  mkdir -p -- "$OUT/raw" 2>/dev/null || die "--out: cannot create $OUT/raw"
  # keep the logical name when it is the directory just created; a symlink before '..' -> the physical one
  OUT_L=$(cd -- "$OUT" && pwd); [[ "$OUT_L" -ef "$OUT" ]] || OUT_L=$(cd -P -- "$OUT" && pwd -P); OUT=$OUT_L
  [[ -z "$(ls -A "$OUT/raw")" ]] || die "--out: $OUT/raw is not empty (give a new or empty DIR)"
  if [[ $DIFFMODE == 1 ]]; then mkdir "$OUT/raw/before" "$OUT/raw/after" 2>/dev/null || die "--out: cannot create $OUT/raw/before and $OUT/raw/after"; fi
  REPORT="$OUT/report.txt"; { : >"$REPORT"; } 2>/dev/null || die "--out: cannot write $REPORT"
else
  REPORT=/dev/null   # nothing is written to disk without --out
fi
if [[ $STAGED == 1 ]]; then
  stage_write   # lib/stage.sh: OUT/stage/before and OUT/stage/after, each the module + the driver
  DRV_B_DIR=$(dirname "$DRV_B"); DRV_B_BASE=$(basename "$DRV_B")
  DRV_A_DIR=$(dirname "$DRV_A"); DRV_A_BASE=$(basename "$DRV_A")
fi

# ---------------------------------------------------------------------------------------------
# node version (S-6): checked before any probe
# ---------------------------------------------------------------------------------------------
GOT_VER=$(env -u NODE_OPTIONS "$NODE_BIN" --version 2>/dev/null) || die "cannot run $NODE_BIN --version"
if [[ -n "$MAXLIST" ]]; then MODE="gate (maxima for node $WANT_VER)"; elif [[ $DIFFMODE == 1 ]]; then MODE="diff"; else MODE="report"; fi
if [[ $STAGED == 1 ]]; then MODE="diff ($STAGE_MODE)"; fi
say "bytecode-budget  node $GOT_VER  $NODE_BIN  (NODE_OPTIONS stripped)"
if [[ $DIFFMODE == 1 ]]; then
  say "before  $DESC_B"
  say "after   $DESC_A"
  if [[ $STAGED == 1 ]]; then
    say "driver  $DESC_D"
    if [[ $STAGE_SAME == 1 ]]; then say "NOTE    before and after modules are byte-identical: this run is a null control (expect SAME)"; fi
  fi
else
  say "driver  ${DRV_DIR%/}/$DRV_BASE"
fi
say "mode    $MODE  runs $RUNS  v8 flags ${V8FLAGS:+$V8FLAGS }--print-bytecode --print-bytecode-filter=<fn>"
if [[ -n "$OUT" ]]; then say "out     $OUT"; fi
if [[ -n "$WANT_VER" && "$GOT_VER" != "$WANT_VER" ]]; then
  for t in "${TARGETS[@]}"; do
    if [[ -n "$MAXLIST" ]]; then w="the maxima are for $WANT_VER"; else w="--node-version is $WANT_VER"; fi
    say "  $t: NO-VERDICT -- node version mismatch: $NODE_BIN --version is $GOT_VER, $w"
  done
  say "VERDICT NO-VERDICT"
  FINAL=1; exit 2
fi

# ---------------------------------------------------------------------------------------------
# limits (from this node binary, then --v8-flags overrides)
# ---------------------------------------------------------------------------------------------
LIMITS=$("$NODE_BIN" --v8-options 2>/dev/null | awk "$LIMITS_AWK")
for f in ${V8_EXTRA[@]+"${V8_EXTRA[@]}"}; do
  case "$f" in --max*inlined*bytecode*=*|--reserve*inline*budget*=*)
    f="${f#--}"; f="${f//_/-}"; LIMITS=$(printf '%s\n%s\n' "$LIMITS" "$f") ;;
  esac
done
# lim VAR KEY DEFAULT: VAR = this binary's value (or the last --v8-flags override). A limit the binary does not
# report falls back to the node 26 default and is listed in ASSUMED, which the report prints as a NOTE.
ASSUMED=""
lim() {
  local v
  v=$(printf '%s\n' "$LIMITS" | awk -F= -v k="$2" '$1 == k { v = $2 } END { print v }')
  if [[ -z "$v" ]]; then v="$3"; ASSUMED="$ASSUMED $2=$3"; fi
  printf -v "$1" '%s' "$v"   # bash >= 3.1, so macOS /bin/bash 3.2 too
}
lim TF_SMALL max-inlined-bytecode-size-small 30; lim TF_SMALL_HN max-inlined-bytecode-size-small-with-heapnum-in-out 75
lim TF_ONE max-inlined-bytecode-size 460; lim TF_CUM max-inlined-bytecode-size-cumulative 920
lim SCALE reserve-inline-budget-scale-factor 1.2
lim MG_SMALL max-maglev-inlined-bytecode-size-small 27; lim MG_ONE max-maglev-inlined-bytecode-size 100
lim MG_EAGER max-maglev-eager-inlined-bytecode-size 30
lim MG_CUM max-maglev-inlined-bytecode-size-cumulative 920
for f in TF_SMALL TF_SMALL_HN TF_ONE MG_EAGER MG_SMALL MG_ONE; do
  [[ "${!f}" =~ ^[0-9]{1,9}$ ]] || die "inlining limit $f='${!f}' is not an integer (check --v8-flags)"
  printf -v "$f" '%s' "$((10#${!f}))"
done
say "limits  TurboFan small<=$TF_SMALL (<=$TF_SMALL_HN if a HeapNumber may cross) single<=$TF_ONE | Maglev eager (greedy small)<$MG_EAGER small<=$MG_SMALL single<$MG_ONE"
if [[ -n "$ASSUMED" ]]; then
  say "NOTE    limits not reported by this node binary, ASSUMED (node 26 defaults; crossings may be wrong):$ASSUMED"
fi
say ""

# ---------------------------------------------------------------------------------------------
# probe: fn x runs, each reduced to "<driver exit> <count> <bad> <lengths>"
# ---------------------------------------------------------------------------------------------
probe() { # fn k dir base rawrel: run the driver dir/base once; with --out the raw output goes to $OUT/raw/<rawrel>
  local rc=0 line
  if [[ -n "$OUT" ]]; then
    line=$( (cd "$3" && env -u NODE_OPTIONS "$NODE_BIN" ${V8_EXTRA[@]+"${V8_EXTRA[@]}"} --print-bytecode \
      --print-bytecode-filter="$1" "./$4" 2>&1) | tee "$OUT/raw/$5" | awk -v fn="$1" "$COUNT_AWK") || rc=$?
  else
    line=$( (cd "$3" && env -u NODE_OPTIONS "$NODE_BIN" ${V8_EXTRA[@]+"${V8_EXTRA[@]}"} --print-bytecode \
      --print-bytecode-filter="$1" "./$4" 2>&1) | awk -v fn="$1" "$COUNT_AWK") || rc=$?
  fi
  printf '%s %s\n' "$rc" "$line"
}

# ---------------------------------------------------------------------------------------------
# diff mode: per fn, runs k = 1..R alternate before / after; judge() each side, then the length multisets
# ---------------------------------------------------------------------------------------------
if [[ $DIFFMODE == 1 ]]; then
  VERDICT=SAME
  for fn in "${TARGETS[@]}"; do
    r="${fn// /-}"; RB=(); RA=()
    for k in $(seq 1 "$RUNS"); do
      RB+=("$(probe "$fn" "$k" "$DRV_B_DIR" "$DRV_B_BASE" "before/$r.$k.txt")")
      RA+=("$(probe "$fn" "$k" "$DRV_A_DIR" "$DRV_A_BASE" "after/$r.$k.txt")")
    done
    diff_fn "$fn"
  done
  say ""
  say "VERDICT $VERDICT"
  FINAL=1; case "$VERDICT" in SAME) exit 0 ;; DIFF) exit 1 ;; *) exit 2 ;; esac
fi

if [[ -n "$MAXLIST" ]]; then VERDICT=WITHIN; else VERDICT=REPORTED; fi
i=0
for fn in "${TARGETS[@]}"; do
  max=""; [[ -z "$MAXLIST" ]] || max="${MAXES[$i]}"
  i=$((i + 1))
  RL=()
  for k in $(seq 1 "$RUNS"); do RL+=("$(probe "$fn" "$k" "$DRV_DIR" "$DRV_BASE" "${fn// /-}.$k.txt")"); done
  judge "$fn" "$max" "${RL[@]}"
  if [[ "${RL[0]}" =~ $LINE_RE ]]; then
    read -r _ n _ lens <<<"${RL[0]}"
    say "  $fn: $n match(es): $lens"
    if [[ "$lens" != - ]]; then
      while IFS= read -r l; do say "    $l bytes: $(over_limits "$l")"; done < <(distinct "$lens")
    fi
  fi
  say "  $fn: $JV -- $JWHY"
  VERDICT=$(vworst "$VERDICT" "$JV")
done
say ""
say "VERDICT $VERDICT"
FINAL=1
case "$VERDICT" in WITHIN|REPORTED) exit 0 ;; OVER) exit 1 ;; *) exit 2 ;; esac
