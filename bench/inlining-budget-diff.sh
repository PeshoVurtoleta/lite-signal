#!/usr/bin/env bash
# inlining-budget-diff.sh -- TurboFan + Maglev inlining-DECISION diff plus a BUDGET report,
# BEFORE vs AFTER, for one or more NAMED functions, on one node binary.
#
#   ME=m0 inlining-budget-diff.sh [opts] DRIVER_BEFORE DRIVER_AFTER      # driver mode (any project)
#   inlining-budget-diff.sh [opts] --before-ref REF --after-ref REF       # lite-signal: builds from git refs
#   inlining-budget-diff.sh [opts] --before FILE --after FILE             # lite-signal: two Signal.js files
#
#   e.g. bench/inlining-budget-diff.sh --fn read.set,sharedSignalPeek --before-ref main --after-ref origin/1.6.0-dev
#
# Options
#   --fn LIST        named functions, comma/space separated (default: $ME, else m0)
#   --runs N         runs per side per tier, 2..50 (default 3). Run 1 vs runs 2..N is the null control.
#   --tiers LIST     turbo,maglev (default both)
#   --only-fn        narrow the verdict to lines that name <fn> or were made while compiling <fn> itself
#                    (blind to <fn>'s callees once <fn> is inlined into a caller; the default is not)
#   --concurrent     keep V8's concurrent recompilation (default: off, so compiles are synchronous)
#   --driver FILE    ref/file modes: driver importing './Signal.js' (default: the inline-diff driver)
#   --repo DIR       ref mode: the git repo (default: the repo around the current directory)
#   --node BIN       node binary (default: $NODE, else node)
#   --v8-flags STR   extra V8 flags for BOTH sides, e.g. "--max-maglev-inlined-bytecode-size=120"
#   --out DIR        artifact dir (default: $OUTDIR, else $TMPDIR/inl-diff-<timestamp>); always kept
#   --no-bytecode    skip the --print-bytecode length probe for each <fn>
#   --self-test      check the normalizer / multiset / guard on canned trace text, then exit
#
# Verdict (per tier; GATED):  exit 0 SAME, 1 DIFF, 2 NO-VERDICT (NO-VERDICT > DIFF > SAME).
#   * Decision lines are normalized (addresses, node ids, frequencies, scores, callee sizes; limits
#     are kept) and tagged with the compile unit they were made in ([step@TF], [read@ML#2]; taken
#     from --trace-opt, so a decision that moves to another caller is a DIFF). TurboFan keeps
#     Inlining / Cannot consider / Not inlining / Not considering, Maglev keeps == Inlining /
#     greedy inlining / cannot inline, and on newer V8 SKIP / INLINE / budget exhausted. Same line
#     set as lite-signal 1.6.0-dev bench/inline-diff.mjs, plus the unit tag and the newer format.
#   * Compared as a MULTISET (sort | uniq -c, never sort -u): inlined at 2 sites -> 1 site is a DIFF.
#   * Guard: a run with no line naming <fn> (and no compile of <fn>) is NO-VERDICT, never "identical".
#     The default scope is the whole trace, so the diff is printed once per tier for all <fn>;
#     --only-fn gives one diff per <fn>.
#   * Null control: all before runs must match each other, and all after runs, else NO-VERDICT.
#   * A driver that exits non-zero, or a tier that prints no trace at all, is NO-VERDICT.
#
# Budget report (REPORTED from run 1, NEVER part of the verdict):
#   * bytecode length of each <fn> (from --print-bytecode) and every limit it crosses;
#   * per compile unit that involves <fn>: inlines, bytes charged and the cumulative budget.
#     TurboFan charges only non-small inlines and skips a candidate SILENTLY when
#     used + int(1.2 * (size + existing inlined size)) > 920 (V8 truncates the reserve; probed on
#     node v26.8.2); those are listed as "dropped".
#     Maglev on V8 <= 14.6 (node <= 26) prints no budget counters; newer V8 prints
#     small_budget / regular_budget, which are reported when present.
# Node 22: Maglev does not run by default, so the maglev tier is NO-VERDICT; use --tiers turbo.
# Artifacts: raw/ dec/ bud/ ms/ under the out dir, plus all.<tier>.diff.txt (<fn>.<tier>.diff.txt with
# --only-fn), budget.<tier>.tsv (every unit, both sides) and report.txt (this output).
#   The last budget.<tier>.tsv column is the TurboFan budget-model check: ok = the summed charged
#   inline sizes equal V8's last printed "Budget used"; ok(+N after last print) = inlines happened
#   after the last print; MISMATCH = V8 printed MORE than the model charged (the model is wrong for
#   this V8). REPORTED: a MISMATCH is printed as a NOTE and never changes the verdict.
#
# Tier: the verdict is STATISTICAL and the budget report is REPORTED. Inlining follows tier-up
# timing, so a real comparison is NEVER part of `npm test` / `npm run verify`; only --self-test is
# (canned trace text, deterministic). Run comparisons under the host quiet lock, e.g.
#   node ~/.claude/hooks/quiet-lock.mjs run "<pkg> inline-budget" -- inlining-budget-diff.sh ...
# Frozen "before" (file mode): --before, and the Watch.js beside it, must be FROZEN copies. It is
# refused with NO-VERDICT when it, or the end of its symlink chain, is git-tracked, or when it is the
# same file (device:inode) as a tracked <top>/Signal.js or <top>/<same name>, <top> = the repo around
# the current directory, around --after, around --before and its link target, and --repo. A hard
# link made from outside all of those repos is NOT detected. File mode needs git for this check.
# Ref mode (--before-ref) is frozen by construction.
# Newer V8 (> 14.6): the SKIP / INLINE / budget-counter / colour / emoji formats are verified only
# against canned sample text in --self-test, not against a real newer node binary.
# Any unexpected failure (a command that fails outside the checks above) exits 2 NO-VERDICT, never 1.

set -euo pipefail
# Fail closed: an exit that is not a planned verdict (FINAL=1), a die / usage (2) or 0 becomes 2 NO-VERDICT,
# so a command that fails under set -e can never pose as exit 1 DIFF. Subshells do not inherit this trap.
FINAL=""
trap 'rc=$?; if [[ -z $FINAL && $rc -ne 0 && $rc -ne 2 ]]; then printf "inlining-budget-diff: unexpected error (exit %s)\nVERDICT NO-VERDICT\n" "$rc" >&2; exit 2; fi' EXIT
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
export LC_ALL=C   # byte-wise sort / awk: stable multisets, emoji stripped as bytes

# ---------------------------------------------------------------------------------------------
# awk programs (POSIX awk: mawk, gawk, BSD awk)
# ---------------------------------------------------------------------------------------------

# raw trace -> dec (unit TAB normalized decision line) + bud (budget events, raw numbers)
# shellcheck disable=SC2016
NORMALIZE_AWK='
function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
function sfi(s,   i, r, j) {                     # first <SharedFunctionInfo NAME> in s
  i = index(s, "<SharedFunctionInfo"); if (i == 0) return "?"
  r = substr(s, i + 19); if (substr(r, 1, 1) == ">") return "(anon)"
  r = substr(r, 2); j = index(r, ">"); return (j > 0) ? substr(r, 1, j - 1) : "?"
}
function num_after(s, re, skip) { return match(s, re) ? substr(s, RSTART + skip, RLENGTH - skip) : "" }
function norm_turbo(l) {
  gsub(/0x[0-9a-fA-F]+/, "0x", l); gsub(/#[0-9]+/, "#N", l)
  gsub(/frequency [0-9.eE+-]+/, "frequency F", l); gsub(/took [0-9.]+ ?ms/, "took T ms", l)
  return l
}
function norm_maglev(l) {
  gsub(/0x[0-9a-fA-F]+/, "0x", l); gsub(/frequency \([0-9.eE+-]+\)/, "frequency (F)", l)
  gsub(/max-size \(/, "@MAXSIZE@", l); gsub(/size \([0-9]+\)/, "size (S)", l); gsub(/@MAXSIZE@/, "max-size (", l)
  gsub(/Score: ?[0-9.]+/, "Score: F", l); gsub(/Node: n[0-9]+/, "Node: nN", l)
  gsub(/\([0-9]+ \+ [0-9]+ >/, "(U + S >", l); gsub(/exhausted \([0-9]+ >/, "exhausted (U >", l)
  gsub(/took [0-9.]+ ?ms/, "took T ms", l)
  return l
}
function reason_of(l,   p) {
  if ((p = index(l, "(reason: ")) > 0) { l = substr(l, p + 9); sub(/\)$/, "", l); return l }
  if ((p = index(l, " because ")) > 0) return substr(l, p + 9)
  if ((p = index(l, "for inlining (")) > 0) { l = substr(l, p + 14); sub(/\)$/, "", l); return l }
  if ((p = index(l, "}: ")) > 0) return substr(l, p + 3)
  return ""
}
function emit(l) { print unit "\t" l > dec }
function ev(s) { print s > bud }
BEGIN { unit = (tag == 1) ? "?" : "*"; greedy = 0 }
{
  l = $0
  gsub(/\033\[[0-9;]*[mK]/, "", l)               # ANSI colours (newer Maglev tracer)
  sub(/^\[(ML|TLV):[0-9]+\] */, "", l)            # --trace-with-compilation-id prefix
}
l ~ /^\[compiling method / {
  if (tag != 1) next
  nm = ""; i = index(l, "<JSFunction ")
  if (i > 0) { r = substr(l, i + 12); j = index(r, " (sfi"); if (j > 1) nm = substr(r, 1, j - 1) }
  if (nm == "") nm = "(anon)"
  t = (l ~ /target MAGLEV/) ? "ML" : (l ~ /target TURBOFAN/) ? "TF" : "?"
  if (l ~ /\) OSR/) t = t "-OSR"
  u = nm "@" t; occ[u]++; unit = (occ[u] > 1) ? u "#" occ[u] : u
  ev("K\t" unit "\t" nm)
  next
}
l ~ /^\[(completed compiling|aborted|bailout)/ { if (tag == 1) unit = "?"; next }
l ~ /^\[/ { next }
tier == "turbo" {
  l = trim(l)
  if (l ~ /^Budget used: [0-9]+\/[0-9]+/) { split(substr(l, 14), a, /[\/ ]/); ev("U\t" unit "\t" a[1] "\t" a[2]); next }
  if (l ~ /^- target: /) {
    sz = num_after(l, "bytecode size: [0-9]+", 15); if (sz == "") sz = "?"
    ex = num_after(l, "inlined bytecode size: [0-9]+", 23); if (ex == "") ex = 0
    ev("C\t" unit "\t" sfi(l) "\t" sz "\t" ex); next
  }
  if (l ~ /^Inlining small function/) { greedy = 1; next }
  if (l ~ /^Inlining 0x/) { ev("I\t" unit "\t" sfi(l) "\t" greedy); greedy = 0 }
  else if (l ~ /^(Cannot consider|Not inlining|Not considering) /) ev("X\t" unit "\t" sfi(l) "\t" reason_of(l))
  n = norm_turbo(l)
  if (n ~ /^(Inlining 0x|Cannot consider |Not inlining |Not considering )/) emit(n)
  next
}
tier == "maglev" {
  eager = (index(l, "\342\232\241") > 0)          # U+26A1: eager INLINE on newer V8
  sub(/^[^A-Za-z=]+/, "", l); gsub(/[ \t]+/, " ", l); l = trim(l)
  split(l, f, " ")
  if (l ~ /^greedy inlining /) greedy = 1
  else if (l ~ /^== Inlining /) { ev("I\t" unit "\t" sfi(l) "\t" greedy); greedy = 0 }
  else if (l ~ /^cannot inline /) {
    ev("X\t" unit "\t" sfi(l) "\t" reason_of(l))
    sz = num_after(l, ", size \\([0-9]+", 8); if (sz != "") ev("Z\t" unit "\t" sfi(l) "\t" sz)
  }
  else if (l ~ /^INLINE /) { ev("I\t" unit "\t" f[2] "\t" eager); if (eager) l = "INLINE(eager)" substr(l, 7) }
  else if (l ~ /^SKIP /) ev("X\t" unit "\t" f[2] "\t" substr(l, length(f[2]) + 7))
  else if (l ~ /^Generated [0-9]+ nodes\. (small|regular)_budget \+= [0-9]+ ~~> [0-9]+/)
    ev("B\t" unit "\t" (l ~ /small_budget/ ? "small" : "regular") "\t" f[6] "\t" f[8])
  else if (l ~ /^(Small|Main) budget exhausted/) ev("E\t" unit "\t" f[1])
  n = norm_maglev(l)
  if (n ~ /^(== Inlining|greedy inlining|cannot inline|SKIP |INLINE|Small budget exhausted|Main budget exhausted)/) emit(n)
  next
}
'

# dec file -> 0 if the run carries evidence about fn (exact name; read never matches read.set)
# shellcheck disable=SC2016
GUARD_AWK='
BEGIN { tok = "SharedFunctionInfo " fn ">" }
{ u = $0; sub(/\t.*/, "", u); sub(/@.*/, "", u); l = $0; sub(/^[^\t]*\t/, "", l); split(l, f, " ") }
index(l, tok) > 0 || u == fn || ((f[1] == "SKIP" || f[1] ~ /^INLINE/) && f[2] == fn) { found = 1; exit }
END { exit !found }
'

# dec file -> lines in scope (all, or only lines naming fn / made while compiling fn)
# shellcheck disable=SC2016
SCOPE_AWK='
BEGIN { tok = "SharedFunctionInfo " fn ">" }
only != 1 { print; next }
{ u = $0; sub(/\t.*/, "", u); sub(/@.*/, "", u); l = $0; sub(/^[^\t]*\t/, "", l); split(l, f, " ") }
index(l, tok) > 0 || u == fn || ((f[1] == "SKIP" || f[1] ~ /^INLINE/) && f[2] == fn) { print }
'

# two `uniq -c` files -> lines whose counts differ: "before=N after=M  [unit] line"
# shellcheck disable=SC2016
MSDIFF_AWK='
function key(s) { sub(/^ *[0-9]+ /, "", s); return s }
function show(k,   u, l) { u = k; sub(/\t.*/, "", u); l = k; sub(/^[^\t]*\t/, "", l); return (u == "*") ? l : "[" u "] " l }
FNR == NR { k = key($0); b[k] = $1 + 0; all[k] = 1; next }
{ k = key($0); a[k] = $1 + 0; all[k] = 1 }
END { for (k in all) if (b[k] + 0 != a[k] + 0) printf "  before=%d after=%d  %s\n", b[k], a[k], show(k) }
'

# `node --v8-options` -> name=value for the inlining limits; then --v8-flags overrides
# shellcheck disable=SC2016
LIMITS_AWK='
/default: --max-(maglev-)?inlined-bytecode-size|default: --reserve-inline-budget-scale-factor/ {
  s = $0; sub(/.*default: --/, "", s); print s
}
'

# --print-bytecode output -> distinct "Bytecode length" values of functions named exactly fn
# shellcheck disable=SC2016
BYTECODE_AWK='
/^\[generated bytecode for function: / {
  s = $0; sub(/^\[generated bytecode for function: /, "", s); sub(/ \(0x.*$/, "", s); want = (s == fn); next
}
want && /^Bytecode length: [0-9]+/ { seen[$3 + 0] = 1; want = 0 }
END { out = ""; for (n in seen) out = out (out == "" ? "" : ",") n; print out }
'

# bud(before run 1) + bud(after run 1) -> per-unit budget rows (TSV) for every unit
# shellcheck disable=SC2016
BUDGET_AWK='
function base(u) { sub(/@.*/, "", u); return u }
{ k = $1; u = $2 }
k == "K" { units[side, u] = 1; ord[side, ++nu[side]] = u; next }
k != "K" && !((side, u) in units) { units[side, u] = 1; ord[side, ++nu[side]] = u }
k == "C" { csz[side, u, $3] = $4; cex[side, u, $3] = $5; if (!((side, u, $3) in cand)) { cand[side, u, $3] = 1; clist[side, u] = clist[side, u] SUBSEP $3 } ; if ($3 == fn) inv[side, u] = 1 }
k == "U" { if (!((side, u) in peak) || $3 + 0 > peak[side, u] + 0) peak[side, u] = $3; lim[side, u] = $4 }
k == "I" { inl[side, u]++; got[side, u, $3] = 1; if ($4 == 1) small[side, u]++; else { nsmall[side, u, ++ni[side, u]] = $3 } ; if ($3 == fn) inv[side, u] = 1 }
k == "X" { rej[side, u]++; if ($3 == fn) inv[side, u] = 1 }
k == "B" { bt[side, u, $3] = $5 }
k == "E" { exh[side, u] = exh[side, u] + 1 }
END {
  for (s = 1; s <= 2; s++) {
    sd = (s == 1) ? "before" : "after"
    for (i = 1; i <= nu[sd]; i++) {
      u = ord[sd, i]; if (seen[sd, u]++) continue
      if (u !~ ("@" want) && u != "?" && u != "*") continue
      charged = 0; unk = 0
      for (j = 1; j <= ni[sd, u]; j++) { nm = nsmall[sd, u, j]; z = csz[sd, u, nm]; if (z ~ /^[0-9]+$/) charged += z; else unk = 1 }
      used = (u ~ /@TF/) ? (unk ? "?" : charged) : ((sd, u, "regular") in bt ? bt[sd, u, "regular"] : "-")
      sm = (u ~ /@TF/) ? "-" : ((sd, u, "small") in bt ? bt[sd, u, "small"] : "-")
      L = (u ~ /@TF/) ? (lim[sd, u] != "" ? lim[sd, u] : tfcum) : mgcum
      drop = ""
      if (u ~ /@TF/) {
        n = split(clist[sd, u], cl, SUBSEP)
        for (c = 2; c <= n; c++) {
          nm = cl[c]; if ((sd, u, nm) in got) continue
          z = csz[sd, u, nm]; e = cex[sd, u, nm]
          why = (z ~ /^[0-9]+$/ && used ~ /^[0-9]+$/ && used + int((z + e) * scale) > L) ? "budget?" : "other"
          drop = drop (drop == "" ? "" : " ") nm "(" z (e > 0 ? "+" e : "") "," why ")"
        }
      }
      chk = "-"
      if (u ~ /@TF/ && used ~ /^[0-9]+$/ && ((sd, u) in peak)) {
        if (used + 0 == peak[sd, u] + 0) chk = "ok"
        else if (used + 0 > peak[sd, u] + 0) chk = "ok(+" (used - peak[sd, u]) " after last print)"
        else chk = "MISMATCH(model " used " < printed " peak[sd, u] ")"
      }
      printf "%s\t%s\t%d\t%d\t%d\t%s\t%s\t%s\t%s\t%d\t%d\t%s\t%s\n", sd, u, (base(u) == fn || inv[sd, u]) ? 1 : 0,
        inl[sd, u], small[sd, u], used, (((sd, u) in peak) ? peak[sd, u] : "-"), sm, L, rej[sd, u], exh[sd, u], (drop == "" ? "-" : drop), chk
    }
  }
}
'

# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
die() { printf 'inlining-budget-diff: %s\nVERDICT NO-VERDICT\n' "$*" >&2; exit 2; }
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
# --self-test: canned node 26 / newer-V8 text through the same awk programs
# ---------------------------------------------------------------------------------------------
self_test() {
  local d; d=$(mktemp -d)
  local fails=0
  check() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1"; echo "     want: $3"; echo "     got:  $2"; fails=$((fails + 1)); fi; }
  local ESC=$'\033' XM=$'\xe2\x9d\x8c' CK=$'\xe2\x9c\x85' MG=$'\xf0\x9f\x94\x8d'   # U+274C U+2705 U+1F50D
  cat >"$d/t1" <<'EOF'
[compiling method 0x1d8653c8 <JSFunction read.set (sfi = 0x11ec74af73f1)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]
Considering 0x1d866858 {0x11ec74af3511 <SharedFunctionInfo markDownstream>} for inlining with 0x1d8870a0 {0x11ec74af8929 <FeedbackVector[33]>}
Budget used: 0/920 -- 2 candidate(s) for inlining:
- candidate: JSCall node #268 with frequency 0.624484, has_heapnum_param:0, 1 target(s):
  - target: 0x1d866858 {0x11ec74af3511 <SharedFunctionInfo markDownstream>}, bytecode size: 194
- candidate: JSCall node #280 with frequency 0.125172, has_heapnum_param:0, 1 target(s):
  - target: 0x1d866930 {0x11ec74af3559 <SharedFunctionInfo flushEffects>}, bytecode size: 440, existing opt code's inlined bytecode size: 128
Inlining 0x1d866858 {0x11ec74af3511 <SharedFunctionInfo markDownstream>} into 0x1d8653c8 {0x11ec74af73f1 <SharedFunctionInfo read.set>}
Inlining small function(s) at call site #314:JSCall
Inlining 0x1d866580 {0x11ec74af3361 <SharedFunctionInfo runCleanup>} into 0x1d8653c8 {0x11ec74af73f1 <SharedFunctionInfo read.set>}
Inlinee contains 2 calls without local exception handler; linking to surrounding exception handler.
Cannot consider 0x9 {0x8 <SharedFunctionInfo refreshComputed>} for inlining (reason: exceeds bytecode limit)
[completed compiling 0x1d8653c8 <JSFunction read.set (sfi = 0x11ec74af73f1)> (target TURBOFAN_JS) - took 0.1, 2.0, 0.1 ms]
EOF
  sed -e 's/0x1d8/0x9a9/g; s/#268/#999/; s/0\.624484/0.5/; s/bytecode size: 194/bytecode size: 190/' "$d/t1" >"$d/t2"
  awk -v tier=turbo -v tag=1 -v dec="$d/t1.dec" -v bud="$d/t1.bud" "$NORMALIZE_AWK" "$d/t1"
  awk -v tier=turbo -v tag=1 -v dec="$d/t2.dec" -v bud="$d/t2.bud" "$NORMALIZE_AWK" "$d/t2"
  check "turbo: addresses / ids / frequencies / callee sizes do not reach the verdict" "$(cmp -s "$d/t1.dec" "$d/t2.dec" && echo same)" same
  check "turbo: kept lines + unit tag" "$(cut -f1 "$d/t1.dec" | sort -u)|$(wc -l <"$d/t1.dec" | tr -d ' ')" "read.set@TF|3"
  check "turbo: Considering / Budget used / small-call-site / Inlinee lines dropped" \
    "$(grep -cE 'Considering|Budget used|call site|Inlinee' "$d/t1.dec" || true)" 0
  check "turbo: Cannot consider normalized" "$(grep 'Cannot' "$d/t1.dec" | cut -f2)" \
    "Cannot consider 0x {0x <SharedFunctionInfo refreshComputed>} for inlining (reason: exceeds bytecode limit)"
  awk -v fn=read.set -v want=TF -v tfcum=920 -v mgcum=920 -v scale=1.2 -F '\t' "$BUDGET_AWK" side=before "$d/t1.bud" side=after "$d/t2.bud" >"$d/b.tsv"
  check "turbo budget: charged = non-small inlines only (194), small inline counted apart" \
    "$(awk -F '\t' '$1=="before"{print $4"/"$5"/"$6"/"$12}' "$d/b.tsv")" "2/1/194/flushEffects(440+128,other)"

  printf '%s\n' \
    '[compiling method 0x45 <JSFunction step (sfi = 0x3f)> (target MAGLEV), mode: ConcurrencyMode::kSynchronous]' \
    '  cannot inline 0x45b10e78 {0x3f3c6b9b73f1 <SharedFunctionInfo read.set>}: big function, size (285) >= max-size (100)' \
    '  cannot inline 0x45b10e79 {0x3f3c6b9b73f2 <SharedFunctionInfo read.set>}: big function, size (285) >= max-size (100)' \
    '  cannot inline 0x45 {0x3f <SharedFunctionInfo markDownstream>}: call frequency (0.624484) < minimum threshold (0.95)' \
    '  greedy inlining 0x45 {0x3f <SharedFunctionInfo batch>}: small function, skipping max-depth' \
    '== Inlining 0x3f3c6b9ae4b1 <SharedFunctionInfo batch>' \
    "${ESC}[90m[ML:7] ${ESC}[0m${ESC}[91m${XM} SKIP   ${ESC}[0m${ESC}[36mm0                            ${ESC}[0m big function" \
    "${ESC}[92m${CK} INLINE ${ESC}[0m${ESC}[36mpullComputed                  ${ESC}[0m " \
    "          Generated 41 nodes. regular_budget += 64 ~~> 64${ESC}[0m" \
    "${ESC}[93m${MG} TRY    ${ESC}[0m${ESC}[36mm0                            ${ESC}[0m Score:   1.25, Node: n42" \
    >"$d/m1"
  awk -v tier=maglev -v tag=1 -v dec="$d/m1.dec" -v bud="$d/m1.bud" "$NORMALIZE_AWK" "$d/m1"
  check "maglev: size collapsed, max-size kept" "$(sed -n 1p "$d/m1.dec" | cut -f2)" \
    "cannot inline 0x {0x <SharedFunctionInfo read.set>}: big function, size (S) >= max-size (100)"
  check "maglev: newer-V8 colour / prefix / emoji stripped; TRY dropped" "$(cut -f2 "$d/m1.dec" | grep -E '^(SKIP|INLINE|TRY)' | tr '\n' '|')" \
    "SKIP m0 big function|INLINE pullComputed|"
  check "maglev: newer-V8 regular_budget event" "$(grep '^B' "$d/m1.bud" | cut -f3-)" "$(printf 'regular\t64\t64')"
  multiset <"$d/m1.dec" >"$d/m1.ms"
  check "multiset keeps call-site multiplicity (sort -u would merge the two read.set lines)" \
    "$(grep -c 'read.set' "$d/m1.ms")|$(grep 'read.set' "$d/m1.ms" | awk '{print $1}')" "1|2"
  head -2 "$d/m1.dec" | multiset >"$d/one.ms"; grep -v 'read.set' "$d/m1.dec" | multiset >>"$d/one.ms"
  head -1 "$d/m1.dec" | multiset >"$d/two.ms"; grep -v 'read.set' "$d/m1.dec" | multiset >>"$d/two.ms"
  check "multiset diff reports 2 -> 1" "$(awk "$MSDIFF_AWK" "$d/one.ms" "$d/two.ms" | cut -c1-21)" "  before=2 after=1  ["
  check "guard: read does not match read.set" "$(awk -v fn=read "$GUARD_AWK" "$d/m1.dec" && echo hit || echo miss)" miss
  check "guard: read.set matches" "$(awk -v fn=read.set "$GUARD_AWK" "$d/m1.dec" && echo hit || echo miss)" hit
  check "guard: newer-V8 name field (m0)" "$(awk -v fn=m0 "$GUARD_AWK" "$d/m1.dec" && echo hit || echo miss)" hit
  check "guard: compile unit of fn counts as evidence" "$(awk -v fn=step "$GUARD_AWK" "$d/m1.dec" && echo hit || echo miss)" hit
  check "--only-fn scope: lines naming fn or compiled in fn" \
    "$(awk -v fn=batch -v only=1 "$SCOPE_AWK" "$d/m1.dec" | wc -l | tr -d ' ')" 2
  printf '%s\n' '[generated bytecode for function: read (0x1 <SharedFunctionInfo read>)]' 'Bytecode length: 106' \
    '[generated bytecode for function: read.set (0x2 <SharedFunctionInfo read.set>)]' 'Bytecode length: 285' >"$d/bc"
  check "bytecode probe: exact name" "$(awk -v fn=read "$BYTECODE_AWK" "$d/bc")" 106
  printf 'K\tf@TF\tf\nU\tf@TF\t0\t920\nC\tf@TF\tg\t767\t0\nC\tf@TF\th\t768\t0\n' >"$d/t3.bud"
  awk -v fn=f -v want=TF -v tfcum=920 -v mgcum=920 -v scale=1.2 -F '\t' "$BUDGET_AWK" side=before "$d/t3.bud" side=after "$d/t3.bud" >"$d/b3.tsv"
  check "turbo budget: reserve compare truncates like V8: int(1.2*767)=920 is not > 920, int(1.2*768)=921 is" \
    "$(awk -F '\t' '$1=="before"{print $12}' "$d/b3.tsv")" "g(767,other) h(768,budget?)"
  check "turbo budget model: equal -> ok" "$(awk -F '\t' '$1=="before"{print $13}' "$d/b3.tsv")" "ok"
  check "turbo budget model: inlines after the last print" "$(awk -F '\t' '$1=="before"{print $13}' "$d/b.tsv")" "ok(+194 after last print)"
  printf 'K\tf@TF\tf\nU\tf@TF\t500\t920\nC\tf@TF\tg\t100\t0\nI\tf@TF\tg\t0\n' >"$d/t4.bud"
  awk -v fn=f -v want=TF -v tfcum=920 -v mgcum=920 -v scale=1.2 -F '\t' "$BUDGET_AWK" side=before "$d/t4.bud" side=after "$d/t4.bud" >"$d/b4.tsv"
  check "turbo budget model: V8 printed more than the model charged -> MISMATCH" \
    "$(awk -F '\t' '$1=="before"{print $13}' "$d/b4.tsv")" "MISMATCH(model 100 < printed 500)"
  if command -v git >/dev/null 2>&1; then
    local rc out x
    mkdir -p "$d/repo/sub" "$d/alias" "$d/alias2" "$d/sym" "$d/frozen" "$d/frozen3" "$d/frozen4" "$d/after"
    printf 'export const x = 1;\n' >"$d/repo/Signal.js"; printf 'export const w = 1;\n' >"$d/repo/Watch.js"
    cp "$d/repo/Signal.js" "$d/after/Signal.js"
    for x in frozen frozen3 frozen4; do cp "$d/repo/Signal.js" "$d/$x/Signal.js"; done
    git -C "$d/repo" init -q && git -C "$d/repo" add Signal.js Watch.js
    ln "$d/repo/Signal.js" "$d/alias/Signal.js"; ln "$d/repo/Signal.js" "$d/alias2/Signal.js"
    ln "$d/repo/Signal.js" "$d/repo/sub/Signal.js"; ln -s ../repo/Signal.js "$d/sym/Signal.js"
    ln -s "$d/repo/Watch.js" "$d/frozen3/Watch.js"; ln "$d/repo/Watch.js" "$d/frozen4/Watch.js"
    refusal() { # cwd pattern args... -> "rc|lines matching pattern" (--node false: no node is ever spawned)
      local cwd="$1" pat="$2"; shift 2
      out=$(cd "$cwd" && "$BASH" "$SELF" --node false "$@" 2>&1) && rc=0 || rc=$?
      printf '%s|%s' "$rc" "$(printf '%s\n' "$out" | grep -c -- "$pat" || true)"
    }
    check "file mode: a git-tracked --before is refused (exit 2)" \
      "$(refusal "$d" 'git-tracked' --before "$d/repo/Signal.js" --after "$d/after/Signal.js" --out "$d/o1")" "2|1"
    check "file mode: a hard link to the live tracked file is refused (cwd in the repo)" \
      "$(refusal "$d/repo" 'same file as the live' --before "$d/alias/Signal.js" --after "$d/after/Signal.js" --out "$d/o2")" "2|1"
    check "file mode: a hard link found through the --after repo is refused (cwd outside)" \
      "$(refusal "$d" 'same file as the live' --before "$d/alias2/Signal.js" --after "$d/repo/Signal.js" --out "$d/o4")" "2|1"
    check "file mode: a hard link inside the repo around --before is refused (cwd outside)" \
      "$(refusal "$d" 'same file as the live' --before "$d/repo/sub/Signal.js" --after "$d/after/Signal.js" --out "$d/o5")" "2|1"
    check "file mode: a symlink to the live tracked file is refused (cwd outside)" \
      "$(refusal "$d" 'git-tracked' --before "$d/sym/Signal.js" --after "$d/after/Signal.js" --out "$d/o6")" "2|1"
    check "file mode: a symlinked Watch.js beside --before is refused (cwd outside)" \
      "$(refusal "$d" 'Watch.js beside --before is a git-tracked' --before "$d/frozen3/Signal.js" --after "$d/after/Signal.js" --out "$d/o7")" "2|1"
    check "file mode: a hard-linked Watch.js beside --before is refused (cwd in the repo)" \
      "$(refusal "$d/repo" 'Watch.js beside --before is the same file' --before "$d/frozen4/Signal.js" --after "$d/after/Signal.js" --out "$d/o8")" "2|1"
    out=$(cd "$d/repo" && "$BASH" "$SELF" --node false --before "$d/frozen/Signal.js" --after "$d/after/Signal.js" --out "$d/o3" 2>&1) && rc=0 || rc=$?
    check "file mode: a frozen copy passes the check; an unexpected failure exits 2, never 1" \
      "$rc|$(printf '%s\n' "$out" | grep -ci 'frozen' || true)|$(printf '%s\n' "$out" | grep -c 'unexpected error' || true)" "2|0|1"
  else
    check "git available (the file-mode frozen-copy checks need it)" "missing" "present"
  fi
  local fk="$d/fake" rc2
  mkdir -p "$fk"
  printf '%s\n' '#!/bin/sh' 'case "$1" in --v8-options) exit 0 ;; -p) echo "v0 (V8 0)"; exit 0 ;; esac' \
    'for a; do last="$a"; done' 'cat "$last"' >"$fk/node"
  chmod +x "$fk/node"
  cp "$d/t1" "$fk/before.trace"; cp "$d/t2" "$fk/same.trace"
  grep -v '^Inlining 0x1d866858' "$d/t1" >"$fk/drop.trace"      # markDownstream no longer inlined into read.set
  printf '%s\n' '[compiling method 0x1 <JSFunction read.set (sfi = 0x2)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]' \
    'Budget used: 500/920 -- 1 candidate(s) for inlining:' \
    '  - target: 0x3 {0x4 <SharedFunctionInfo helper>}, bytecode size: 100' \
    'Inlining 0x3 {0x4 <SharedFunctionInfo helper>} into 0x1 {0x2 <SharedFunctionInfo read.set>}' \
    '[completed compiling 0x1 <JSFunction read.set (sfi = 0x2)> (target TURBOFAN_JS) - took 0.1, 0.1, 0.1 ms]' >"$fk/mm.trace"
  fake() { # before after -> "rc|verdict line"
    "$BASH" "$SELF" --node "$fk/node" --tiers turbo --no-bytecode --fn read.set --out "$d/o-$2" "$fk/$1" "$fk/$2" \
      >"$d/fake-$2.out" 2>&1 && rc2=0 || rc2=$?
    printf '%s|%s' "$rc2" "$(grep '^VERDICT ' "$d/fake-$2.out" || true)"
  }
  check "driver mode (fake node): a real DIFF exits 1 (the EXIT trap keeps a planned exit)" "$(fake before.trace drop.trace)" "1|VERDICT DIFF"
  check "driver mode (fake node): addresses / frequencies only -> SAME, exit 0" "$(fake before.trace same.trace)" "0|VERDICT SAME"
  check "driver mode (fake node): a budget-model MISMATCH prints a NOTE and leaves the verdict SAME" \
    "$(fake mm.trace mm.trace)|$(grep -c 'NOTE budget model MISMATCH' "$d/fake-mm.trace.out" || true)" "0|VERDICT SAME|1"
  rm -rf "$d"; echo
  if [[ $fails -eq 0 ]]; then echo "self-test: all checks passed"; return 0; fi
  echo "self-test: $fails check(s) FAILED"; return 1
}

# ---------------------------------------------------------------------------------------------
# options
# ---------------------------------------------------------------------------------------------
FNS="${ME:-m0}"; RUNS=3; TIERS="turbo,maglev"; ONLY=0; CONCURRENT=0; DRIVER=""; REPO=""
NODE_BIN="${NODE:-node}"; V8FLAGS=""; OUT="${OUTDIR:-}"; BYTECODE=1
BEFORE_REF=""; AFTER_REF=""; BEFORE_FILE=""; AFTER_FILE=""; POS=()
need() { # value from --opt=value (returns 0) or from the next argument (returns 1: caller shifts)
  if [[ -n "$v" ]]; then return 0; fi
  [[ $# -ge 2 ]] || die "$a needs a value"
  v="$2"; return 1
}
while [[ $# -gt 0 ]]; do
  a="$1"; v=""
  case "$a" in --*=*) v="${a#*=}"; a="${a%%=*}" ;; esac
  case "$a" in
    -h|--help) usage; exit 2 ;;
    --self-test) if self_test; then FINAL=1; exit 0; else FINAL=1; exit 1; fi ;;
    --only-fn) ONLY=1 ;;
    --concurrent) CONCURRENT=1 ;;
    --no-bytecode) BYTECODE=0 ;;
    --fn|--runs|--tiers|--driver|--repo|--node|--v8-flags|--out|--before-ref|--after-ref|--before|--after)
      if ! need "$@"; then shift; fi
      case "$a" in
        --fn) FNS="$v" ;; --runs) RUNS="$v" ;; --tiers) TIERS="$v" ;; --driver) DRIVER="$v" ;;
        --repo) REPO="$v" ;; --node) NODE_BIN="$v" ;; --v8-flags) V8FLAGS="$v" ;; --out) OUT="$v" ;;
        --before-ref) BEFORE_REF="$v" ;; --after-ref) AFTER_REF="$v" ;;
        --before) BEFORE_FILE="$v" ;; --after) AFTER_FILE="$v" ;;
      esac ;;
    --*) die "unknown option $a (see --help)" ;;
    *) POS+=("$a") ;;
  esac
  shift
done

IFS=', ' read -r -a TARGETS <<<"$FNS"
[[ ${#TARGETS[@]} -gt 0 ]] || die "--fn is empty"
for t in "${TARGETS[@]}"; do
  [[ "$t" =~ ^[A-Za-z_\$][A-Za-z0-9_\$.]*$ ]] || die "--fn must name NAMED functions (e.g. m0, read.set), got '$t'"
done
[[ "$RUNS" =~ ^[0-9]+$ && $RUNS -ge 2 && $RUNS -le 50 ]] || die "--runs must be an integer in [2, 50] (null control), got '$RUNS'"
IFS=', ' read -r -a TIER_LIST <<<"$TIERS"
for t in "${TIER_LIST[@]}"; do [[ $t == turbo || $t == maglev ]] || die "unknown tier '$t' (turbo, maglev)"; done
read -r -a V8_EXTRA <<<"$V8FLAGS" || true
command -v "$NODE_BIN" >/dev/null 2>&1 || die "node binary not found: $NODE_BIN"

# ---------------------------------------------------------------------------------------------
# stage BEFORE / AFTER
# ---------------------------------------------------------------------------------------------
OUT="${OUT:-${TMPDIR:-/tmp}/inl-diff-$(date +%Y%m%d-%H%M%S)-$$}"
mkdir -p "$OUT"/raw "$OUT"/dec "$OUT"/bud "$OUT"/ms "$OUT"/stage
OUT=$(cd "$OUT" && pwd)
REPORT="$OUT/report.txt"; : >"$REPORT"

DEFAULT_DRIVER="// inline-diff default driver: signal read / set / peek, computed, effect, batch hot paths.
import { signal, computed, effect, batch } from './Signal.js';
const a = signal(0), b = signal(1);
const c = computed(() => a() + b());
const d = computed(() => c() * 2);
const sink = new Int32Array(1);
effect(() => { sink[0] = (sink[0] + d()) | 0; });
function step(i) {
    a.set(i);
    b.set(i ^ 1);
    batch(() => { a.set(i + 1); b.set(i); });
    return (a.peek() + c.peek() + d()) | 0;
}
let acc = 0;
for (let i = 0; i < 300000; i++) acc = (acc + step(i)) | 0;
if (acc === 7 && sink[0] === 7) console.log('');
"

write_driver() { # dir
  if [[ -n "$DRIVER" ]]; then
    [[ -f "$DRIVER" ]] || die "--driver not found: $DRIVER"
    grep -qE "['\"]\./Signal\.js['\"]" "$DRIVER" || die "--driver must import './Signal.js'"
    cp "$DRIVER" "$1/driver.mjs"
  else
    printf '%s' "$DEFAULT_DRIVER" >"$1/driver.mjs"
  fi
}

DESC_B=""; DESC_A=""; STAGED=1
if [[ -n "$BEFORE_REF$AFTER_REF" ]]; then
  [[ -n "$BEFORE_REF" && -n "$AFTER_REF" ]] || die "--before-ref and --after-ref go together"
  [[ ${#POS[@]} -eq 0 && -z "$BEFORE_FILE$AFTER_FILE" ]] || die "ref mode takes no driver paths / --before / --after"
  REPO="${REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
  [[ -n "$REPO" ]] || die "ref mode: not inside a git repo (use --repo)"
  for side in before after; do
    if [[ $side == before ]]; then ref="$BEFORE_REF"; else ref="$AFTER_REF"; fi
    sha=$(git -C "$REPO" rev-parse --short --verify --quiet "$ref^{commit}") || die "unknown git ref '$ref' in $REPO (git fetch origin $ref?)"
    dir="$OUT/stage/$side"; mkdir -p "$dir"
    git -C "$REPO" show "$sha:Signal.js" >"$dir/Signal.js" 2>/dev/null || die "$ref has no Signal.js"
    if git -C "$REPO" cat-file -e "$sha:Watch.js" 2>/dev/null; then git -C "$REPO" show "$sha:Watch.js" >"$dir/Watch.js"; fi
    write_driver "$dir"
    d="$ref @ $sha  Signal.js sha256/8 $(sha8 "$dir/Signal.js")"
    if [[ $side == before ]]; then DESC_B="$d"; else DESC_A="$d"; fi
  done
  DRV_B="$OUT/stage/before/driver.mjs"; DRV_A="$OUT/stage/after/driver.mjs"
elif [[ -n "$BEFORE_FILE$AFTER_FILE" ]]; then
  [[ -n "$BEFORE_FILE" && -n "$AFTER_FILE" ]] || die "--before and --after go together"
  [[ ${#POS[@]} -eq 0 ]] || die "file mode takes no driver paths"
  command -v git >/dev/null 2>&1 || die "file mode needs git to check that --before is a frozen copy (or use --before-ref)"
  [[ -f "$BEFORE_FILE" ]] || die "--before not found: $BEFORE_FILE"
  refuse_live "$BEFORE_FILE" "--before"
  if [[ -f "$(dirname "$BEFORE_FILE")/Watch.js" ]]; then refuse_live "$(dirname "$BEFORE_FILE")/Watch.js" "the Watch.js beside --before"; fi
  for side in before after; do
    if [[ $side == before ]]; then f="$BEFORE_FILE"; else f="$AFTER_FILE"; fi
    [[ -f "$f" ]] || die "--$side not found: $f"
    dir="$OUT/stage/$side"; mkdir -p "$dir"
    cp "$f" "$dir/Signal.js"     # the copy IS the freeze: edits to $f during the run cannot leak in
    w="$(dirname "$f")/Watch.js"
    if [[ -f "$w" ]]; then cp "$w" "$dir/Watch.js"
    elif grep -q '"./Watch.js"' "$dir/Signal.js"; then die "no Watch.js beside $f (Signal.js re-exports it)"; fi
    write_driver "$dir"
    d="$f  sha256/8 $(sha8 "$dir/Signal.js")"
    if [[ $side == before ]]; then DESC_B="$d"; else DESC_A="$d"; fi
  done
  DRV_B="$OUT/stage/before/driver.mjs"; DRV_A="$OUT/stage/after/driver.mjs"
else
  STAGED=0
  [[ ${#POS[@]} -eq 2 ]] || { usage >&2; die "need DRIVER_BEFORE DRIVER_AFTER, --before-ref/--after-ref, or --before/--after"; }
  for f in "${POS[@]}"; do [[ -f "$f" ]] || die "driver not found: $f"; done
  DRV_B=$(cd "$(dirname "${POS[0]}")" && pwd)/$(basename "${POS[0]}")
  DRV_A=$(cd "$(dirname "${POS[1]}")" && pwd)/$(basename "${POS[1]}")
  DESC_B="$DRV_B  sha256/8 $(sha8 "$DRV_B")"; DESC_A="$DRV_A  sha256/8 $(sha8 "$DRV_A")"
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
lim() { printf '%s\n' "$LIMITS" | awk -F= -v k="$1" -v d="$2" '$1 == k { v = $2 } END { print (v == "" ? d : v) }'; }
TF_SMALL=$(lim max-inlined-bytecode-size-small 27); TF_ONE=$(lim max-inlined-bytecode-size 460)
TF_CUM=$(lim max-inlined-bytecode-size-cumulative 920); SCALE=$(lim reserve-inline-budget-scale-factor 1.2)
MG_SMALL=$(lim max-maglev-inlined-bytecode-size-small 27); MG_ONE=$(lim max-maglev-inlined-bytecode-size 100)
MG_CUM=$(lim max-maglev-inlined-bytecode-size-cumulative 920)

# ---------------------------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------------------------
TAG=1; [[ $CONCURRENT == 1 ]] && TAG=0   # concurrent compiles interleave: unit attribution is off
run_trace() { # tier side k driver
  local flag raw="$OUT/raw/$1.$2.$3.txt"
  if [[ $1 == turbo ]]; then flag=--trace-turbo-inlining; else flag=--trace-maglev-inlining; fi
  local -a cmd=("$NODE_BIN" ${V8_EXTRA[@]+"${V8_EXTRA[@]}"} --trace-opt "$flag")
  [[ $CONCURRENT == 1 ]] || cmd+=(--no-concurrent-recompilation)
  cmd+=("$(basename "$4")")
  if ! (cd "$(dirname "$4")" && env -u NODE_OPTIONS "${cmd[@]}") >"$raw" 2>&1; then
    tail -n 20 "$raw" >&2
    die "driver exited non-zero: ${cmd[*]} (in $(dirname "$4"); trace in $raw)"
  fi
  awk -v tier="$1" -v tag="$TAG" -v dec="$OUT/dec/$1.$2.$3.tsv" -v bud="$OUT/bud/$1.$2.$3.tsv" "$NORMALIZE_AWK" "$raw"
  touch "$OUT/dec/$1.$2.$3.tsv" "$OUT/bud/$1.$2.$3.tsv"
}

# judge TIER KEY FN: multiset per run (FN empty = all lines), null control, then before vs after
judge() {
  local tier=$1 key=$2 fn=$3 v="" why="" shown="" side k nb na n label
  for k in $(seq 1 "$RUNS"); do
    for side in before after; do
      awk -v fn="$fn" -v only="$([[ -n $fn ]] && echo 1 || echo 0)" "$SCOPE_AWK" "$OUT/dec/$tier.$side.$k.tsv" \
        | multiset >"$OUT/ms/$key.$tier.$side.$k.txt"
    done
  done
  nb=$(awk '{s += $1} END {print s + 0}' "$OUT/ms/$key.$tier.before.1.txt")
  na=$(awk '{s += $1} END {print s + 0}' "$OUT/ms/$key.$tier.after.1.txt")
  for side in before after; do
    for k in $(seq 2 "$RUNS"); do
      if [[ -z "$v" ]] && ! cmp -s "$OUT/ms/$key.$tier.$side.1.txt" "$OUT/ms/$key.$tier.$side.$k.txt"; then
        v=NO-VERDICT; why="null control: $side run 1 vs $side run $k differ (tier-up noise on this host)"
        shown=$(awk "$MSDIFF_AWK" "$OUT/ms/$key.$tier.$side.1.txt" "$OUT/ms/$key.$tier.$side.$k.txt" | sort -k3)
      fi
    done
  done
  if [[ -z "$v" ]]; then
    shown=$(awk "$MSDIFF_AWK" "$OUT/ms/$key.$tier.before.1.txt" "$OUT/ms/$key.$tier.after.1.txt" | sort -k3)
    if [[ -z "$shown" ]]; then v=SAME; why="identical multiset"
    else v=DIFF; why="$(printf '%s\n' "$shown" | wc -l | tr -d ' ') line(s) differ"; fi
  fi
  if [[ -n $fn ]]; then label="$fn (--only-fn)"; else label="all decision lines"; fi
  say "  $label: $v -- $why  (lines before/after run 1: $nb/$na)"
  if [[ -n "$shown" ]]; then
    printf '%s\n' "$shown" >"$OUT/$key.$tier.diff.txt"
    printf '%s\n' "$shown" | awk 'NR <= 60' | tee -a "$REPORT"
    n=$(printf '%s\n' "$shown" | wc -l | tr -d ' ')
    if [[ $n -gt 60 ]]; then say "  ... $((n - 60)) more in $OUT/$key.$tier.diff.txt"; fi
  fi
  VERDICT=$(worst "$VERDICT" "$v")
}

NODE_V=$("$NODE_BIN" -p 'process.version + " (V8 " + process.versions.v8 + ")"')
say "inlining-budget-diff  node $NODE_V  $(command -v "$NODE_BIN")  (same binary both sides, NODE_OPTIONS stripped)"
say "before  $DESC_B"
say "after   $DESC_A"
if [[ $STAGED == 1 ]] && cmp -s "$DRV_B" "$DRV_A" && cmp -s "$(dirname "$DRV_B")/Signal.js" "$(dirname "$DRV_A")/Signal.js"; then
  say "NOTE    before and after are byte-identical: this run is a null control (expect SAME)"
fi
say "fn ${TARGETS[*]}  runs $RUNS  tiers ${TIER_LIST[*]}  scope $([[ $ONLY == 1 ]] && echo "--only-fn (lines naming fn / compiled in fn)" || echo "all decision lines (guarded on fn)")"
say "v8 flags ${V8FLAGS:+$V8FLAGS }--trace-opt <trace flag>$([[ $CONCURRENT == 1 ]] || echo ' --no-concurrent-recompilation')"
say "limits  TurboFan small<=$TF_SMALL single<=$TF_ONE cumulative $TF_CUM (reserve x$SCALE) | Maglev small<=$MG_SMALL single<$MG_ONE cumulative $MG_CUM"
say "out     $OUT"
say ""

VERDICT=SAME
for tier in "${TIER_LIST[@]}"; do
  for k in $(seq 1 "$RUNS"); do   # interleaved, so slow drift on the host hits both sides alike
    run_trace "$tier" before "$k" "$DRV_B"
    run_trace "$tier" after "$k" "$DRV_A"
  done

  if [[ ! -s "$OUT/dec/$tier.before.1.tsv" && ! -s "$OUT/dec/$tier.after.1.tsv" ]]; then
    hint=""; [[ $tier == maglev ]] && hint=" (node <= 22 does not run Maglev by default: use --tiers turbo)"
    say "=== $tier: NO-VERDICT -- the trace has no inlining decisions at all$hint"
    VERDICT=NO-VERDICT; say ""; continue
  fi

  say "=== $tier"
  # guard: every run must carry evidence about each fn
  guarded=""
  for fn in "${TARGETS[@]}"; do
    g=ok
    for k in $(seq 1 "$RUNS"); do
      for side in before after; do
        if [[ $g == ok ]] && ! awk -v fn="$fn" "$GUARD_AWK" "$OUT/dec/$tier.$side.$k.tsv"; then g="$side run $k"; fi
      done
    done
    if [[ $g == ok ]]; then guarded="$guarded $fn"
    else say "  $fn: NO-VERDICT -- no trace of $fn in $g (not compiled, not a callee: no evidence)"; VERDICT=NO-VERDICT; fi
  done
  if [[ $ONLY == 1 ]]; then
    for fn in $guarded; do judge "$tier" "$fn" "$fn"; done
  elif [[ -n "$guarded" ]]; then
    say "  guard ok:${guarded}"
    judge "$tier" all ""
  fi

  # ---- budget report (REPORTED, run 1) ----------------------------------------------------
  say "  --- budget, run 1 (REPORTED, not gated)"
  : >"$OUT/budget.$tier.tsv"
  for fn in "${TARGETS[@]}"; do
    awk -F '\t' -v fn="$fn" -v want="$([[ $tier == turbo ]] && echo TF || echo ML)" -v tfcum="$TF_CUM" -v mgcum="$MG_CUM" \
      -v scale="$SCALE" "$BUDGET_AWK" side=before "$OUT/bud/$tier.before.1.tsv" side=after "$OUT/bud/$tier.after.1.tsv" \
      | awk -v fn="$fn" '{ print fn "\t" $0 }' >>"$OUT/budget.$tier.tsv"
  done
  for fn in "${TARGETS[@]}"; do
    rows=$(awk -F '\t' -v fn="$fn" '$1 == fn && $4 == 1' "$OUT/budget.$tier.tsv")
    if [[ -z "$rows" ]]; then say "  $fn: no compile unit involves $fn"; continue; fi
    say "  $fn: units that compile $fn or decide about it   (inl N [small], used = bytes charged, rej = rejected)"
    printf '%s\n' "$rows" | awk -F '\t' -v tier="$tier" '
      { u = $3; if (!(u in seen)) { seen[u] = 1; ord[++n] = u }
        if (tier == "turbo") s = sprintf("inl %d [%d]  used %s/%s (last printed %s)  rej %d  model %s", $5, $6, $7, $10, $8, $11, $14)
        else s = sprintf("inl %d [%d]  regular %s/%s  small %s  rej %d  exhausted %d", $5, $6, $7, $10, $9, $11, $12)
        txt[$2, u] = s; dr[$2, u] = $13 }
      END { for (i = 1; i <= n; i++) { u = ord[i]
              b = ((("before", u) in txt) ? txt["before", u] : "(not compiled as a unit)")
              a = ((("after", u) in txt) ? txt["after", u] : "(not compiled as a unit)")
              printf "    %-24s before: %s\n    %-24s after:  %s\n", u, b, "", a
              if (!(("before", u) in dr)) dr["before", u] = "-"
              if (!(("after", u) in dr)) dr["after", u] = "-"
              if (tier == "turbo" && (dr["before", u] != "-" || dr["after", u] != "-"))
                printf "    %-24s dropped (size[+existing],why): before %s | after %s\n", "", dr["before", u], dr["after", u] } }' \
      | tee -a "$REPORT"
  done
  if grep -q 'MISMATCH' "$OUT/budget.$tier.tsv"; then
    say "  NOTE budget model MISMATCH (see budget.$tier.tsv): V8 printed more than the summed inline sizes (REPORTED; verdict unaffected)"
  fi
  if [[ $tier == maglev ]] && ! grep -q '^B' "$OUT/bud/maglev.before.1.tsv" "$OUT/bud/maglev.after.1.tsv" 2>/dev/null; then
    say "  (this V8 prints no Maglev budget counters: regular/small show '-'; sizes and limits below still apply)"
  fi
  say ""
done

# ---------------------------------------------------------------------------------------------
# bytecode lengths of each fn vs the limits (REPORTED)
# ---------------------------------------------------------------------------------------------
if [[ $BYTECODE == 1 ]]; then
  say "=== bytecode length (REPORTED: --print-bytecode, exact name; several values = several functions with that name)"
  probe() { # driver fn
    (cd "$(dirname "$1")" && env -u NODE_OPTIONS "$NODE_BIN" ${V8_EXTRA[@]+"${V8_EXTRA[@]}"} --print-bytecode \
      --print-bytecode-filter="$2" "$(basename "$1")" 2>&1) | awk -v fn="$2" "$BYTECODE_AWK"
  }
  cross() { # name op limit before after
    local b=$4 a=$5 ib ia
    if [[ $2 == "<=" ]]; then ib=$((b <= $3)); ia=$((a <= $3)); else ib=$((b < $3)); ia=$((a < $3)); fi
    if [[ $ib != "$ia" ]]; then printf '      CROSSES %s (%s%s): %s -> %s\n' "$1" "$2" "$3" \
      "$([[ $ib == 1 ]] && echo inside || echo outside)" "$([[ $ia == 1 ]] && echo inside || echo outside)"; fi
  }
  for fn in "${TARGETS[@]}"; do
    b=$(probe "$DRV_B" "$fn"); a=$(probe "$DRV_A" "$fn")
    if [[ "$b" =~ ^[0-9]+$ && "$a" =~ ^[0-9]+$ ]]; then
      say "  $fn: $b -> $a bytes ($( [[ $a -ge $b ]] && echo + )$((a - b)))"
      {
        cross "TurboFan small" "<=" "$TF_SMALL" "$b" "$a"
        cross "TurboFan single-inline limit" "<=" "$TF_ONE" "$b" "$a"
        cross "Maglev small" "<=" "$MG_SMALL" "$b" "$a"
        cross "Maglev single-inline limit" "<" "$MG_ONE" "$b" "$a"
      } | tee -a "$REPORT"
    else
      say "  $fn: ${b:-not compiled} -> ${a:-not compiled}"
    fi
  done
  say ""
fi

say "VERDICT $VERDICT"
FINAL=1
case "$VERDICT" in SAME) exit 0 ;; DIFF) exit 1 ;; *) exit 2 ;; esac
