#!/usr/bin/env bash
# Go gate. No arguments runs every part in order. CI runs one part per job and
# splits the race suite by package, because the race detector is the long pole.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PART=all
SHARD_INDEX=0
SHARD_TOTAL=1

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

step() {
  local label="$1" start=$SECONDS
  shift
  echo "verify: starting $label"
  "$@"
  echo "verify: $label passed in $((SECONDS - start))s"
}

run_fmt_vet() {
  local unformatted
  unformatted="$(gofmt -l ./cmd ./internal)"
  if [[ -n "$unformatted" ]]; then
    echo "gofmt required:" >&2
    echo "$unformatted" >&2
    exit 1
  fi
  step "go vet" go vet ./...
}

shard_packages() {
  go list ./... | awk -v shard="$SHARD_INDEX" -v total="$SHARD_TOTAL" 'NR % total == shard'
}

run_test() {
  # These packages include many Argon2 handshakes and encrypted media transfers.
  # Give the whole package the same budget with and without the race detector;
  # individual RPC/network deadlines remain bounded in their tests.
  step "go test" go test -timeout 20m ./...
}

run_race() {
  local packages=()
  while IFS= read -r package; do
    packages+=("$package")
  done < <(shard_packages)
  if ((${#packages[@]} == 0)); then
    echo "verify: go race shard $SHARD_INDEX/$SHARD_TOTAL is empty"
    return
  fi
  step "go race shard $SHARD_INDEX/$SHARD_TOTAL" go test -race -timeout 20m "${packages[@]}"
}

run_vuln() {
  step "go vulnerability scan" go run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...
}

case "$PART" in
  all) run_fmt_vet; run_test; run_race; run_vuln ;;
  fmt-vet) run_fmt_vet ;;
  test) run_test ;;
  race) run_race ;;
  vuln) run_vuln ;;
esac
