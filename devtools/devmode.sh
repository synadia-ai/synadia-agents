#!/usr/bin/env bash
# devmode — toggle synadia-agents consumers between file: links and
# ^semver pins for the SDK pair (@synadia-ai/agents +
# @synadia-ai/agent-service). Caller-only consumers (e.g. agent-web-ui)
# only have the first dep; agent harnesses and headless examples have
# both. The script handles whichever subset a consumer lists.
#
# Run './devmode.sh --help' for full usage.

set -euo pipefail

# ---------- argument parsing ----------------------------------------------

MODE=""
WANT_COLOR="auto"   # auto | never | always
WANT_JSON=0
QUIET=0

usage() {
  cat <<'EOF'
devmode — toggle synadia-agents consumers between dev and release wiring.

USAGE
  ./devmode.sh [flags] [command]

COMMANDS
  status            show current state per (consumer, SDK dep) pair (default)
  on                switch every dep to a file: link to the local SDK source
  off               switch every dep to a ^semver pin from npm
  check-release     exit 0 iff every dep is pinned to its SDK's current
                    semver, non-zero otherwise (CI-friendly)

FLAGS
  -h, --help        show this help and exit
  --no-color        disable ANSI color (also: --nocolor)
  --color           force color output (overrides TTY auto-detect)
  --json            emit machine-readable JSON (status, check-release)
  -q, --quiet       suppress progress chatter; only errors and exit code

ENVIRONMENT
  REPO              override the synadia-agents checkout location
                    (default: ../synadia-agents next to this script)
  NO_COLOR          if set (any value), disable color (https://no-color.org)
  FORCE_COLOR       if set to 1, emit color even when stdout is not a TTY

CONSUMER DISCOVERY
  Consumers are auto-discovered by scanning $REPO/examples/*/package.json
  AND $REPO/agents/*/package.json for any that depend on @synadia-ai/agents
  and/or @synadia-ai/agent-service. Names listed in .devmodeignore (next to
  this script) are excluded — by default this is just 'dspy' (a private
  example that lives on file: permanently).

SDK PAIR
  @synadia-ai/agents          ← caller (client-sdk/typescript)
  @synadia-ai/agent-service   ← host   (agent-sdk/typescript)

  Both versioned in lockstep. Each dep is toggled independently against
  its own SDK's package.json version.
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)            usage; exit 0 ;;
    --no-color|--nocolor) WANT_COLOR="never" ;;
    --color)              WANT_COLOR="always" ;;
    --json)               WANT_JSON=1 ;;
    -q|--quiet)           QUIET=1 ;;
    on|off|status|check-release)
      if [[ -n "$MODE" ]]; then
        echo "error: more than one command given ($MODE, $arg)" >&2
        exit 64
      fi
      MODE="$arg"
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "       run './devmode.sh --help' for usage" >&2
      exit 64
      ;;
  esac
done

MODE="${MODE:-status}"

# JSON is meant to be machine-parsed — strip color regardless of TTY.
if (( WANT_JSON )); then
  WANT_COLOR="never"
fi

# ---------- color setup ---------------------------------------------------

use_color=0
case "$WANT_COLOR" in
  never)  use_color=0 ;;
  always) use_color=1 ;;
  auto)
    if [[ -n "${NO_COLOR:-}" ]]; then
      use_color=0
    elif [[ "${FORCE_COLOR:-}" == "1" ]]; then
      use_color=1
    elif [[ -t 1 && "${TERM:-}" != "dumb" ]]; then
      use_color=1
    fi
    ;;
esac

if (( use_color )); then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_MAGENTA=$'\033[35m'
  C_CYAN=$'\033[36m'
else
  C_RESET="" C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW=""
  C_BLUE="" C_MAGENTA="" C_CYAN=""
fi

err_color=0
if (( use_color )); then
  err_color=1
elif [[ -z "${NO_COLOR:-}" && "$WANT_COLOR" != "never" && -t 2 && "${TERM:-}" != "dumb" ]]; then
  err_color=1
fi

err() {
  if (( err_color )); then
    printf '\033[31m\033[1merror:\033[0m %s\n' "$*" >&2
  else
    printf 'error: %s\n' "$*" >&2
  fi
}

# ---------- preflight -----------------------------------------------------

for bin in jq bun; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    err "required tool not found on PATH: $bin"
    exit 127
  fi
done

# Lives in-tree at $REPO/devtools/, so the repo root is just one level
# up. Override with `REPO=/path/to/synadia-agents` if running from elsewhere.
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-$(cd "$HERE/.." 2>/dev/null && pwd || true)}"

if [[ -z "$REPO" || ! -d "$REPO" ]]; then
  err "synadia-agents repo not found at \"${REPO:-unset}\""
  echo "       set REPO=/path/to/synadia-agents and re-run" >&2
  exit 64
fi

# Per-consumer `bun install` timeout (seconds). agents/openclaw's
# `peerDependencies: { openclaw: "" }` has tripped bun into a 100%-CPU
# walk twice during the SDK split rollout; cap each install so a stuck
# one doesn't block the whole flip. Override with BUN_INSTALL_TIMEOUT
# if your machine is slow on a clean install.
BUN_INSTALL_TIMEOUT="${BUN_INSTALL_TIMEOUT:-60}"
if ! [[ "$BUN_INSTALL_TIMEOUT" =~ ^[0-9]+$ ]]; then
  err "BUN_INSTALL_TIMEOUT must be a non-negative integer of seconds (got: $BUN_INSTALL_TIMEOUT)"
  exit 64
fi

# ---------- SDK pair ------------------------------------------------------

# Parallel arrays describing every SDK package devmode tracks. Adding a
# third SDK later is a matter of appending to all three arrays.
SDK_NAMES=("@synadia-ai/agents"     "@synadia-ai/agent-service")
SDK_DIRS=( "client-sdk/typescript"  "agent-sdk/typescript")
SDK_VERSIONS=()
SDK_SEMVER_REFS=()

for ((i=0; i<${#SDK_NAMES[@]}; i++)); do
  pkg="$REPO/${SDK_DIRS[$i]}/package.json"
  if [[ ! -f "$pkg" ]]; then
    err "\"$REPO\" doesn't look like a synadia-agents checkout"
    echo "       (no ${SDK_DIRS[$i]}/package.json)" >&2
    exit 64
  fi
  ver="$(jq -r .version "$pkg")"
  SDK_VERSIONS+=("$ver")
  SDK_SEMVER_REFS+=("^${ver}")
done

# Build the `file:` ref for ($consumer, $sdk_index). Counts the depth of
# the consumer relative to repo root so a future consumer at any depth
# (e.g. `examples/foo/bar/baz/`) gets the right number of `../`s. The
# discovery glob currently only matches depth-2 consumers, but this
# keeps the path computation honest if that invariant ever changes.
file_ref_for() {
  local consumer="$1" idx="$2" slashes prefix=""
  slashes="$(printf '%s' "$consumer" | tr -cd '/' | wc -c | tr -d ' ')"
  local depth=$((slashes + 1))
  while (( depth > 0 )); do
    prefix="../$prefix"
    depth=$((depth - 1))
  done
  printf 'file:%s%s' "$prefix" "${SDK_DIRS[$idx]}"
}

# Best-effort branch lookup. Empty if synadia-agents isn't a git checkout
# or git isn't on PATH.
SDK_BRANCH=""
if command -v git >/dev/null 2>&1; then
  SDK_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi

# Look up the index of an SDK by package name. Echoes the index or "" if
# not tracked. Used to skip deps the script doesn't know about.
sdk_index_of() {
  local name="$1" i
  for ((i=0; i<${#SDK_NAMES[@]}; i++)); do
    [[ "${SDK_NAMES[$i]}" == "$name" ]] && { echo "$i"; return; }
  done
  echo ""
}

# ---------- consumer discovery -------------------------------------------

# .devmodeignore: one dirname per line, '#' comments. Tolerates absence.
read_ignored() {
  local f="$HERE/.devmodeignore"
  [[ -f "$f" ]] || return 0
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] || printf '%s\n' "$line"
  done < "$f"
}

# `mapfile -t` would be cleaner but ships only with bash 4+; stock macOS
# is bash 3.2. Use a portable while-read loop instead.
IGNORED=()
while IFS= read -r line; do
  IGNORED+=("$line")
done < <(read_ignored)

# True if a consumer (path "kind/name") references at least one tracked SDK
# in its dependencies OR devDependencies block. devDependencies match so
# that the caller SDK's `file:`-linked devDep on `@synadia-ai/agent-service`
# (used by its integration tests) gets flipped in lockstep — published
# devDeps are noise rather than load-bearing, but a stray `file:` ref in a
# published package.json is still ugly.
consumer_has_tracked_dep() {
  local pkg="$1" name dep
  for name in "${SDK_NAMES[@]}"; do
    dep="$(jq -r --arg n "$name" '(.dependencies[$n] // .devDependencies[$n]) // empty' "$pkg" 2>/dev/null || true)"
    [[ -n "$dep" ]] && return 0
  done
  return 1
}

# Stable-sorted list of "<kind>/<name>" entries (no trailing /package.json).
# Scans every monorepo subtree where a tracked SDK might be `file:`-linked:
# `examples/*` and `agents/*` for consumers, plus `agent-sdk/*` and
# `client-sdk/*` for the SDK packages themselves (the host SDK depends on
# the caller via `file:`; the caller has the host listed in its
# devDependencies for integration tests). All four trees flip in lockstep
# so publishing leaves no `file:` ref behind.
discover_consumers() {
  local pkg name kind dirname ig skip
  local -a found=()
  for kind in examples agents agent-sdk client-sdk; do
    for pkg in "$REPO/$kind"/*/package.json; do
      [[ -f "$pkg" ]] || continue
      consumer_has_tracked_dep "$pkg" || continue
      dirname="$(basename "$(dirname "$pkg")")"
      skip=0
      if (( ${#IGNORED[@]} > 0 )); then
        for ig in "${IGNORED[@]}"; do
          [[ "$dirname" == "$ig" ]] && skip=1 && break
        done
      fi
      (( skip )) && continue
      found+=("$kind/$dirname")
    done
  done
  if (( ${#found[@]} > 0 )); then
    printf '%s\n' "${found[@]}" | sort
  fi
}

CONSUMERS=()
while IFS= read -r line; do
  CONSUMERS+=("$line")
done < <(discover_consumers)

if (( ${#CONSUMERS[@]} == 0 )); then
  err "no consumers discovered under $REPO/{examples,agents}/"
  echo "       (none depend on a tracked SDK, or all are listed in .devmodeignore)" >&2
  exit 65
fi

# ---------- helpers -------------------------------------------------------

pkg_path_of() { echo "$REPO/$1/package.json"; }

# Echoes the dep ref for ($consumer, $sdk_name) or "" if absent. Looks at
# both `dependencies` and `devDependencies` — whichever block holds the
# entry, that's the one we'll classify and flip.
get_ref() {
  local pkg="$1" name="$2"
  jq -r --arg n "$name" '(.dependencies[$n] // .devDependencies[$n]) // empty' "$pkg"
}

# Echoes which dep block ("dependencies" or "devDependencies") holds the
# named SDK, or "" if neither does.
get_block() {
  local pkg="$1" name="$2"
  jq -r --arg n "$name" '
    if (.dependencies // {}) | has($n) then "dependencies"
    elif (.devDependencies // {}) | has($n) then "devDependencies"
    else empty
    end' "$pkg"
}

# Updates the SDK ref in whichever block already holds it (preserves the
# `dependencies` vs `devDependencies` placement). Cleans up the .tmp
# write file on either jq or mv failure so a partial write doesn't sit
# next to the original.
set_ref() {
  local pkg="$1" name="$2" ref="$3" block tmp
  tmp="$pkg.tmp"
  block="$(get_block "$pkg" "$name")"
  [[ -z "$block" ]] && return 0
  if jq --arg n "$name" --arg r "$ref" --arg b "$block" \
       '.[$b][$n] = $r' "$pkg" > "$tmp" \
       && mv "$tmp" "$pkg"; then
    return 0
  fi
  rm -f "$tmp"
  err "failed to write $pkg (jq or mv error)"
  return 1
}

# Classify a (sdk_index, ref) pair. Echoes:
#   "dev"            ref starts with file:
#   "release-sync"   ref equals the SDK's current ^semver
#   "release-drift"  ref looks like semver/range but doesn't match
#   "unknown"        anything else
classify_ref() {
  local idx="$1" ref="$2"
  local expected="${SDK_SEMVER_REFS[$idx]}"
  case "$ref" in
    file:*)            echo "dev" ;;
    "$expected")       echo "release-sync" ;;
    \^*|~*|[0-9]*)     echo "release-drift" ;;
    *)                 echo "unknown" ;;
  esac
}

say()        { (( QUIET )) || printf '%b' "$*"; }
sayln()      { (( QUIET )) || printf '%b\n' "$*"; }
sayf()       { (( QUIET )) || printf "$@"; }

# ---------- pretty printing ----------------------------------------------

# Column widths sized to the longest values in the discovered set.
column_widths() {
  local rel name max_consumer=0 max_sdk=0
  for rel in "${CONSUMERS[@]}"; do
    (( ${#rel} > max_consumer )) && max_consumer=${#rel}
  done
  for name in "${SDK_NAMES[@]}"; do
    (( ${#name} > max_sdk )) && max_sdk=${#name}
  done
  (( max_consumer < 22 )) && max_consumer=22
  (( max_sdk < 26 )) && max_sdk=26
  printf '%d %d\n' "$max_consumer" "$max_sdk"
}
read -r CONSUMER_W SDK_W < <(column_widths)

render_state() {
  local state="$1" ref="$2" idx="$3"
  case "$state" in
    dev)
      printf '%bdev%b      %b%s%b' \
        "$C_GREEN$C_BOLD" "$C_RESET" "$C_DIM" "$ref" "$C_RESET"
      ;;
    release-sync)
      printf '%brelease%b  %s' \
        "$C_BLUE$C_BOLD" "$C_RESET" "$ref"
      ;;
    release-drift)
      printf '%brelease%b  %b%s%b %b(expected %s)%b' \
        "$C_YELLOW$C_BOLD" "$C_RESET" "$C_YELLOW" "$ref" "$C_RESET" \
        "$C_DIM" "${SDK_SEMVER_REFS[$idx]}" "$C_RESET"
      ;;
    *)
      printf '%bunknown%b  %s' \
        "$C_RED$C_BOLD" "$C_RESET" "$ref"
      ;;
  esac
}

print_status_header() {
  printf '%bdevmode status%b  %s%s%s\n' \
    "$C_BOLD$C_CYAN" "$C_RESET" "$C_DIM" "$REPO" "$C_RESET"
  if [[ -n "$SDK_BRANCH" ]]; then
    printf '  %sbranch:%s %b%s%b\n' \
      "$C_DIM" "$C_RESET" "$C_MAGENTA$C_BOLD" "$SDK_BRANCH" "$C_RESET"
  fi
  local i
  for ((i=0; i<${#SDK_NAMES[@]}; i++)); do
    printf '  %s%-*s%s %b%s%b\n' \
      "$C_DIM" "$SDK_W" "${SDK_NAMES[$i]}" "$C_RESET" \
      "$C_BOLD" "${SDK_VERSIONS[$i]}" "$C_RESET"
  done
  echo
}

print_status_pretty() {
  print_status_header

  local rel pkg name ref state idx
  local n_dev=0 n_sync=0 n_drift=0 n_unknown=0 n_total=0

  for rel in "${CONSUMERS[@]}"; do
    pkg="$(pkg_path_of "$rel")"
    for ((idx=0; idx<${#SDK_NAMES[@]}; idx++)); do
      name="${SDK_NAMES[$idx]}"
      ref="$(get_ref "$pkg" "$name")"
      [[ -z "$ref" ]] && continue
      state="$(classify_ref "$idx" "$ref")"
      n_total=$((n_total + 1))
      case "$state" in
        dev)            n_dev=$((n_dev + 1)) ;;
        release-sync)   n_sync=$((n_sync + 1)) ;;
        release-drift)  n_drift=$((n_drift + 1)) ;;
        *)              n_unknown=$((n_unknown + 1)) ;;
      esac
      printf '  %b%-*s%b  %-*s  ' \
        "$C_BOLD" "$CONSUMER_W" "$rel" "$C_RESET" \
        "$SDK_W" "$name"
      render_state "$state" "$ref" "$idx"
      printf '\n'
    done
  done

  echo
  if (( n_unknown > 0 )); then
    printf '  %b✗%b deps in %bunknown%b state — investigate manually\n' \
      "$C_RED$C_BOLD" "$C_RESET" "$C_RED$C_BOLD" "$C_RESET"
  elif (( n_drift > 0 )); then
    printf '  %b⚠%b release pin drift — run %b./devmode.sh off%b to re-pin\n' \
      "$C_YELLOW$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  elif (( n_dev > 0 && n_sync > 0 )); then
    printf '  %b⚠%b mixed state — %d dev, %d release\n' \
      "$C_YELLOW$C_BOLD" "$C_RESET" "$n_dev" "$n_sync"
  elif (( n_dev == n_total )); then
    printf '  %b✓%b all %d deps in %bdev%b mode (file: link)\n' \
      "$C_GREEN$C_BOLD" "$C_RESET" "$n_total" "$C_GREEN$C_BOLD" "$C_RESET"
  else
    printf '  %b✓%b all %d deps in %brelease%b mode, in sync with their SDKs\n' \
      "$C_GREEN$C_BOLD" "$C_RESET" "$n_total" "$C_BLUE$C_BOLD" "$C_RESET"
  fi
}

# Build a JSON document describing current state. One entry per
# (consumer, SDK dep) pair the consumer actually lists.
build_status_json() {
  local rel pkg name ref state idx
  {
    for rel in "${CONSUMERS[@]}"; do
      pkg="$(pkg_path_of "$rel")"
      for ((idx=0; idx<${#SDK_NAMES[@]}; idx++)); do
        name="${SDK_NAMES[$idx]}"
        ref="$(get_ref "$pkg" "$name")"
        [[ -z "$ref" ]] && continue
        state="$(classify_ref "$idx" "$ref")"
        jq -n \
          --arg consumer "$rel" \
          --arg path "$rel/package.json" \
          --arg sdk "$name" \
          --arg ref "$ref" \
          --arg expected_ref "${SDK_SEMVER_REFS[$idx]}" \
          --arg state "$state" \
          '{consumer:$consumer, path:$path, sdk:$sdk, ref:$ref, expected_ref:$expected_ref, state:$state}'
      done
    done
  } | jq -s \
        --arg repo "$REPO" \
        --arg branch "$SDK_BRANCH" \
        --argjson sdks "$(jq -n \
          --argjson names  "$(printf '%s\n' "${SDK_NAMES[@]}"      | jq -R . | jq -s .)" \
          --argjson dirs   "$(printf '%s\n' "${SDK_DIRS[@]}"       | jq -R . | jq -s .)" \
          --argjson vers   "$(printf '%s\n' "${SDK_VERSIONS[@]}"   | jq -R . | jq -s .)" \
          --argjson refs   "$(printf '%s\n' "${SDK_SEMVER_REFS[@]}" | jq -R . | jq -s .)" \
          '[range(0; ($names | length)) | {name:$names[.], dir:$dirs[.], version:$vers[.], expected_ref:$refs[.]}]')" '
    {
      repo: $repo,
      branch: (if $branch == "" then null else $branch end),
      sdks: $sdks,
      deps: .,
      summary: {
        total: length,
        dev:           ([.[] | select(.state=="dev")]           | length),
        release_sync:  ([.[] | select(.state=="release-sync")]  | length),
        release_drift: ([.[] | select(.state=="release-drift")] | length),
        unknown:       ([.[] | select(.state=="unknown")]       | length),
        all_dev:           (length > 0 and all(.state == "dev")),
        all_release_sync:  (length > 0 and all(.state == "release-sync"))
      }
    }
  '
}

bun_install_each() {
  local direction="$1"      # "dev" or "release" — only affects the failure note
  local rel dir log rc
  local ok=0 fail=0
  sayln ""
  sayf '%brefreshing bun.lock in each consumer…%b\n' "$C_BOLD" "$C_RESET"
  for rel in "${CONSUMERS[@]}"; do
    dir="$REPO/$rel"
    log="$(mktemp)"
    rc=0
    # `timeout` exit 124 = exceeded the deadline. Wrapping bun install
    # protects against pathological dep walks (openclaw's empty-string
    # peer dep is the canonical case — burns CPU forever otherwise).
    ( cd "$dir" && timeout "$BUN_INSTALL_TIMEOUT" bun install --silent ) \
      >"$log" 2>&1 || rc=$?
    if (( rc == 0 )); then
      sayf '  %b✓%b %s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$rel"
      ok=$((ok + 1))
    elif (( rc == 124 )); then
      sayf '  %b⏱%b %s%b (bun install timed out after %ds)%b\n' \
        "$C_YELLOW$C_BOLD" "$C_RESET" "$rel" "$C_DIM" "$BUN_INSTALL_TIMEOUT" "$C_RESET"
      fail=$((fail + 1))
    else
      sayf '  %b✗%b %s%b (bun install exit %d)%b\n' \
        "$C_RED$C_BOLD" "$C_RESET" "$rel" "$C_DIM" "$rc" "$C_RESET"
      if (( !QUIET )); then
        head -3 "$log" | sed 's/^/      /' >&2
      fi
      fail=$((fail + 1))
    fi
    rm -f "$log"
  done

  if (( fail == 0 )); then
    return 0
  fi

  sayln ""
  sayf '%bnote:%b %d of %d installs failed.\n' \
    "$C_YELLOW$C_BOLD" "$C_RESET" "$fail" "$((ok + fail))"
  sayf '  The package.json flips themselves succeeded — only the\n'
  sayf '  bun.lock refresh failed.\n'
  case "$direction" in
    release)
      sayf '  This is %bexpected pre-publish%b — the ^semver pins resolve\n' \
        "$C_BOLD" "$C_RESET"
      sayf '  only after the SDKs land on npm. Re-run %b./devmode.sh off%b\n' \
        "$C_BOLD" "$C_RESET"
      sayf '  after the publish to refresh bun.lock files.\n'
      ;;
    dev)
      sayf '  Investigate the per-consumer errors above — for file:\n'
      sayf '  links a failure usually means a missing peer dep or a\n'
      sayf '  broken sibling SDK build.\n'
      ;;
  esac
}

# Apply a target state ("dev" or "release") to every (consumer, dep) pair.
# Returns 0 if anything changed, non-zero if every dep was already at target.
apply_state() {
  local target_state="$1"
  local rel pkg name ref before target idx changed=0
  local target_color

  case "$target_state" in
    dev)
      target_color="$C_GREEN"
      sayf '%bswitching to dev mode%b → %bfile:%b links to local SDK source\n' \
        "$C_BOLD" "$C_RESET" "$C_GREEN$C_BOLD" "$C_RESET"
      ;;
    release)
      target_color="$C_BLUE"
      sayf '%bswitching to release mode%b → %b^semver%b pins from npm\n' \
        "$C_BOLD" "$C_RESET" "$C_BLUE$C_BOLD" "$C_RESET"
      for ((idx=0; idx<${#SDK_NAMES[@]}; idx++)); do
        sayf '  %s→ %s = %b%s%b\n' \
          "$C_DIM" "${SDK_NAMES[$idx]}" "$C_BLUE$C_BOLD" "${SDK_SEMVER_REFS[$idx]}" "$C_RESET"
      done
      ;;
  esac
  sayln ""

  for rel in "${CONSUMERS[@]}"; do
    pkg="$(pkg_path_of "$rel")"
    for ((idx=0; idx<${#SDK_NAMES[@]}; idx++)); do
      name="${SDK_NAMES[$idx]}"
      ref="$(get_ref "$pkg" "$name")"
      [[ -z "$ref" ]] && continue   # consumer doesn't list this dep

      case "$target_state" in
        dev)     target="$(file_ref_for "$rel" "$idx")" ;;
        release) target="${SDK_SEMVER_REFS[$idx]}" ;;
      esac
      before="$ref"

      if [[ "$before" == "$target" ]]; then
        sayf '  %b·%b %-*s  %-*s  %balready %s%b\n' \
          "$C_DIM" "$C_RESET" \
          "$CONSUMER_W" "$rel" "$SDK_W" "$name" \
          "$C_DIM" "$target" "$C_RESET"
      else
        set_ref "$pkg" "$name" "$target"
        changed=1
        sayf '  %b✓%b %-*s  %-*s  %b%s%b → %b%s%b\n' \
          "$C_GREEN$C_BOLD" "$C_RESET" \
          "$CONSUMER_W" "$rel" "$SDK_W" "$name" \
          "$C_DIM" "$before" "$C_RESET" \
          "$target_color" "$target" "$C_RESET"
      fi
    done
  done

  return $(( 1 - changed ))
}

# Sets globals N_DEV, N_SYNC, N_DRIFT, N_UNKNOWN. Returns 0 iff every dep
# is in release-sync.
evaluate_release_state() {
  N_DEV=0 N_SYNC=0 N_DRIFT=0 N_UNKNOWN=0
  local rel pkg name ref state idx total=0
  for rel in "${CONSUMERS[@]}"; do
    pkg="$(pkg_path_of "$rel")"
    for ((idx=0; idx<${#SDK_NAMES[@]}; idx++)); do
      name="${SDK_NAMES[$idx]}"
      ref="$(get_ref "$pkg" "$name")"
      [[ -z "$ref" ]] && continue
      state="$(classify_ref "$idx" "$ref")"
      total=$((total + 1))
      case "$state" in
        dev)            N_DEV=$((N_DEV + 1)) ;;
        release-sync)   N_SYNC=$((N_SYNC + 1)) ;;
        release-drift)  N_DRIFT=$((N_DRIFT + 1)) ;;
        *)              N_UNKNOWN=$((N_UNKNOWN + 1)) ;;
      esac
    done
  done
  (( total > 0 && N_SYNC == total ))
}

# ---------- main ---------------------------------------------------------

case "$MODE" in
  status)
    if (( WANT_JSON )); then
      build_status_json
    else
      print_status_pretty
    fi
    exit 0
    ;;

  check-release)
    if evaluate_release_state; then
      if (( WANT_JSON )); then
        build_status_json | jq '. + {ok: true}'
      elif (( !QUIET )); then
        local_total=$(( N_SYNC ))
        printf '%b✓%b release-clean — all %d deps pinned to their SDK versions' \
          "$C_GREEN$C_BOLD" "$C_RESET" "$local_total"
        [[ -n "$SDK_BRANCH" ]] && printf ' %b(branch: %s)%b' "$C_DIM" "$SDK_BRANCH" "$C_RESET"
        printf '\n'
      fi
      exit 0
    else
      if (( WANT_JSON )); then
        build_status_json | jq '. + {ok: false}'
      elif (( !QUIET )); then
        print_status_pretty
        printf '\n%b✗%b not release-clean: %d dev, %d drift, %d unknown — expected all release-sync\n' \
          "$C_RED$C_BOLD" "$C_RESET" \
          "$N_DEV" "$N_DRIFT" "$N_UNKNOWN"
      fi
      exit 1
    fi
    ;;

  on)
    if apply_state "dev"; then
      bun_install_each "dev"
    else
      sayf '\n%bnothing to do — every dep already on file:%b\n' "$C_DIM" "$C_RESET"
      exit 0
    fi
    ;;

  off)
    if apply_state "release"; then
      # ^semver pins only resolve once the SDKs are on npm — install
      # failures pre-publish are expected, not fatal.
      bun_install_each "release"
    else
      sayf '\n%bnothing to do — every dep already pinned to its SDK semver%b\n' \
        "$C_DIM" "$C_RESET"
      exit 0
    fi
    ;;

  *)
    err "unknown command: $MODE"
    echo "       run './devmode.sh --help' for usage" >&2
    exit 64
    ;;
esac

sayln ""
sayf '%b✓ done.%b\n' "$C_GREEN$C_BOLD" "$C_RESET"
