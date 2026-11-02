#!/usr/bin/env bash
# Shared web gate. Production callers may set PAIRFOB_PACK_DL=1 to pack once.
#
# One entry point for local and CI: no arguments runs every part in order.
# CI runs one part per job, and each job decides its own scope at dispatch, so
# the checks start together instead of waiting for the changes job. The tests
# part takes a shard of the PWA suite, so one slow test file costs its shard.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PART=all
SHARD_INDEX=0
SHARD_TOTAL=1

usage() {
  echo "usage: verify-web.sh [--part all|tests|static|build|workers] [--shard <index>/<total>]" >&2
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
  all | tests | static | build | workers) ;;
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

cd "$ROOT/pwa"

run_tests() {
  local files=()
  while IFS= read -r file; do
    files+=("$file")
  done < <(bun "$ROOT/scripts/pwa-test-shard.ts" "$SHARD_INDEX" "$SHARD_TOTAL")
  if ((${#files[@]} == 0)); then
    echo "verify: PWA test shard $SHARD_INDEX/$SHARD_TOTAL is empty"
    return
  fi
  # Bun's 5 s default sits at the cost of the heaviest architecture and DOM tests
  # on a loaded machine. A leak from one file, or a test cut off mid-jsdom, must
  # not reach the next: each file keeps its own globals and module registry.
  # Bun 1.4.3 runs the files in worker processes; `--isolate` still holds when an
  # older Bun ignores `--parallel` and runs them in order. A preload's
  # setDefaultTimeout does not reach a directory run, so pass it here.
  # The timings manifest starts the slowest files first; it only orders files
  # inside a shard, so the size-balanced split does not depend on it. Refresh it
  # with `bun test --timings=scripts/pwa-test-timings.json --update-timings`.
  step "PWA tests shard $SHARD_INDEX/$SHARD_TOTAL" bun test --isolate --parallel --timings="$ROOT/scripts/pwa-test-timings.json" --timeout 30000 "${files[@]}"
}

run_check() {
  local label="$1" start=$SECONDS
  shift
  echo "verify: starting $label"
  "$@"
  echo "verify: $label passed in $((SECONDS - start))s"
}

# The static checks read different inputs and write no shared files. Run them
# together so the job costs the slowest check instead of their sum.
run_static() {
  local pids=() labels=() status=0 i
  run_check "PWA QA" bun run test:qa & pids+=("$!"); labels+=("PWA QA")
  run_check "PWA types" bun run typecheck & pids+=("$!"); labels+=("PWA types")
  run_check "PWA QA types" bun run typecheck:qa & pids+=("$!"); labels+=("PWA QA types")
  run_check "PWA performance tooling" bun run test:performance & pids+=("$!"); labels+=("PWA performance tooling")
  run_check "PWA asset retention" bun test "$ROOT/scripts/retain-pwa-assets.test.ts" & pids+=("$!"); labels+=("PWA asset retention")
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      echo "verify: ${labels[$i]} failed" >&2
      status=1
    fi
  done
  return "$status"
}

run_build() {
  step "PWA build" bun run build
  step "PWA startup budget" bun run perf:budget
  step "origin pack (includes docs build)" bash "$ROOT/scripts/pack-origin-assets.sh"
  test -f "$ROOT/workers/pairfob-origin/public-dist/install.sh"
  test -f "$ROOT/workers/pairfob-origin/public-dist/doc/index.html"
}

run_workers() {
  cd "$ROOT/workers/pairfob-origin"
  step "Worker tests" bun test src
  step "Worker harness" bun test e2e
  step "Worker types" bun run typecheck
  step "Worker integration" bun run e2e:wrangler

  cd "$ROOT/workers/pairfob-downloads"
  step "Download Worker tests" bun test src
}

case "$PART" in
  all) run_tests; run_static; run_build; run_workers ;;
  tests) run_tests ;;
  static) run_static ;;
  build) run_build ;;
  workers) run_workers ;;
esac
