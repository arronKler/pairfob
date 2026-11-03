#!/usr/bin/env bash
# Go gate. No arguments runs every part; `all` runs the suite once under the
# race detector, sharded across the machine's cores, and starts vet and the
# vulnerability scan beside it. CI runs one part per job and splits the race
# suite by weight.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PART=all
SHARD_INDEX=0
SHARD_TOTAL=1

cpu_count() {
  if command -v nproc >/dev/null 2>&1; then
    nproc
  else
    sysctl -n hw.ncpu
  fi
}

JOBS="${PAIRFOB_VERIFY_JOBS:-$(cpu_count)}"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "verify: PAIRFOB_VERIFY_JOBS must be a positive integer" >&2; exit 2; }

usage() {
  echo "usage: verify-go.sh [--part all|fmt-vet|test|race|vuln] [--shard <index>/<total>]" >&2
  exit 2
}

while (($#)); do
  case "$1" in
    --part) (($# >= 2)) || usage; PART="$2"; shift 2 ;;
    --shard) (($# >= 2)) || usage; SHARD_INDEX="${2%%/*}"; SHARD_TOTAL="${2##*/}"; shift 2 ;;
    *) usage ;;
  esac
done

case "$PART" in
  all | fmt-vet | test | race | vuln) ;;
  *) usage ;;
esac
[[ "$SHARD_INDEX" =~ ^[0-9]+$ && "$SHARD_TOTAL" =~ ^[0-9]+$ ]] || usage
((SHARD_TOTAL >= 1 && SHARD_INDEX < SHARD_TOTAL)) || usage

# `set -e` is suspended while a function runs in an `if` condition; returning
# the command's status explicitly keeps a failed step from printing "passed"
# and letting its callers continue with missing build output.
step() {
  local label="$1" start=$SECONDS
  shift
  echo "verify: starting $label"
  "$@" || return $?
  echo "verify: $label passed in $((SECONDS - start))s"
}

check_fmt() {
  local unformatted
  unformatted="$(gofmt -l ./cmd ./internal)"
  if [[ -n "$unformatted" ]]; then
    echo "gofmt required:" >&2
    echo "$unformatted" >&2
    exit 1
  fi
}

run_fmt_vet() {
  check_fmt
  step "go vet" go vet ./...
}

# Test names are read from source, so building an inventory costs two `go list`
# calls (without and with the race build tag) instead of compiling every test
# binary just to list its tests.
write_inventory() {
  bun "$ROOT/scripts/go-test-shard.ts" --inventory > "$1"
}

# Every shard gets a balanced share of whole packages and of the tests inside
# the large packages, then runs its share in one process at a time. With a
# binary directory the share is executed directly, so the go tool does not
# load and link the same test binary in every shard.
run_shards() {
  local mode="$1" total="$2" inventory="$3" bindir="${4:-}"
  local pids=() labels=() status=0 i start
  start=$SECONDS
  for ((i = 0; i < total; i++)); do
    (
      local shard_start=$SECONDS code=0
      if [[ -n "$bindir" ]]; then
        planner=(--mode "$mode" --shard "$i/$total" --inventory "$inventory" --bindir "$bindir")
      else
        planner=(--mode "$mode" --shard "$i/$total" --inventory "$inventory")
      fi
      if ! bun "$ROOT/scripts/go-test-shard.ts" "${planner[@]}"; then
        code=1
      fi
      echo "verify: go $mode shard $i/$total finished in $((SECONDS - shard_start))s" >&2
      exit "$code"
    ) &
    pids+=("$!")
    labels+=("$mode shard $i/$total")
  done
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      echo "verify: ${labels[$i]} failed" >&2
      status=1
    fi
  done
  echo "verify: go $mode phase finished in $((SECONDS - start))s"
  return "$status"
}

build_binaries() {
  step "go test binaries" bun "$ROOT/scripts/go-test-shard.ts" --build "$BINDIR" --inventory "$INVENTORY"
}

run_test() {
  if ((SHARD_TOTAL == 1)); then
    step "go test" go test -timeout 20m ./...
    return
  fi
  local inventory
  inventory="$(mktemp)"
  write_inventory "$inventory"
  if ! step "go test shard $SHARD_INDEX/$SHARD_TOTAL" \
    bun "$ROOT/scripts/go-test-shard.ts" --mode test --shard "$SHARD_INDEX/$SHARD_TOTAL" --inventory "$inventory"; then
    rm -f "$inventory"
    return 1
  fi
  rm -f "$inventory"
}

run_race() {
  if ((SHARD_TOTAL == 1)); then
    step "go race" go test -race -timeout 20m ./...
    return
  fi
  local inventory
  inventory="$(mktemp)"
  write_inventory "$inventory"
  if ! step "go race shard $SHARD_INDEX/$SHARD_TOTAL" \
    bun "$ROOT/scripts/go-test-shard.ts" --mode race --shard "$SHARD_INDEX/$SHARD_TOTAL" --inventory "$inventory"; then
    rm -f "$inventory"
    return 1
  fi
  rm -f "$inventory"
}

run_vuln() {
  step "go vulnerability scan" go run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...
}

# The EXIT trap runs after this function has returned, so the paths are global.
INVENTORY=""
BINDIR=""
cleanup_inventory() {
  [[ -n "$INVENTORY" ]] && rm -f "$INVENTORY"
  [[ -n "$BINDIR" ]] && rm -rf "$BINDIR"
  return 0
}
trap cleanup_inventory EXIT

run_all() {
  local status=0 vet_pid vuln_pid built=1 bindir=""
  INVENTORY="$(mktemp)"
  BINDIR="$(mktemp -d)"
  write_inventory "$INVENTORY"

  check_fmt
  # Vet compiles the same packages the tests need, and the vulnerability scan
  # is mostly package loading: both can fill cores the test shards leave idle.
  (step "go vet" go vet ./...) & vet_pid=$!
  (run_vuln) & vuln_pid=$!

  # By default each shard runs `go test`, so Go's test-result cache replays
  # packages whose inputs are unchanged: a repeat run after an unrelated edit
  # costs seconds instead of rerunning the suite. `PAIRFOB_VERIFY_BINARIES=1`
  # links each split package's binary once instead; that is faster on a cold
  # cache (no prebuilt result to replay) but reruns every test.
  if [[ "${PAIRFOB_VERIFY_BINARIES:-0}" == "1" ]]; then
    if ! build_binaries; then
      built=0
      status=1
    fi
    bindir="$BINDIR"
  fi
  # Every test runs once under the race detector; the ordinary build adds a
  # package only when its build-tagged test files differ between the two
  # builds. One plan keeps every core loaded to the end instead of draining one
  # phase's tail before the other starts.
  if ((built)); then
    run_shards coverage "$JOBS" "$INVENTORY" "$bindir" || status=1
  fi

  wait "$vet_pid" || { echo "verify: go vet failed" >&2; status=1; }
  wait "$vuln_pid" || { echo "verify: go vulnerability scan failed" >&2; status=1; }
  return "$status"
}

case "$PART" in
  all) run_all ;;
  fmt-vet) run_fmt_vet ;;
  test) run_test ;;
  race) run_race ;;
  vuln) run_vuln ;;
esac