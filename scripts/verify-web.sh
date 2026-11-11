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

# `set -e` is suspended while a function runs in an `if` condition or after
# `||`; returning the command's status explicitly keeps a failed step from
# printing "passed" and letting its caller continue.
step() {
  local label="$1" start=$SECONDS
  shift
  echo "verify: starting $label"
  "$@" || return $?
  echo "verify: $label passed in $((SECONDS - start))s"
}

cd "$ROOT/pwa"

run_tests() {
  local files=() plan cache_key="" code=0
  # A green shard is reused when every input that can change its result is
  # byte-identical: the same rule AGENTS.md sets for a passed check and the one
  # Go's test cache already applies. A failure is never stored, and a changed
  # source file, lockfile or Bun version misses. `PAIRFOB_VERIFY_CACHE=0`
  # forces the suite to run.
  if [[ -d "$ROOT/pwa/node_modules" && "${PAIRFOB_VERIFY_CACHE:-1}" != "0" ]] &&
    cache_key="$(bun "$ROOT/scripts/verify-cache.ts" key pwa-tests "$SHARD_INDEX/$SHARD_TOTAL")" &&
    bun "$ROOT/scripts/verify-cache.ts" hit pwa-tests "$SHARD_INDEX/$SHARD_TOTAL" "$cache_key"; then
    echo "verify: PWA tests shard $SHARD_INDEX/$SHARD_TOTAL unchanged since a green run ($cache_key)"
    return 0
  fi
  # Capture the planner's output so its exit status is checked. A process
  # substitution would leave `files` empty on a planner crash and this shard
  # would report success without running anything.
  if ! plan="$(bun "$ROOT/scripts/pwa-test-shard.ts" "$SHARD_INDEX" "$SHARD_TOTAL")"; then
    echo "verify: PWA test shard planner failed" >&2
    return 1
  fi
  while IFS= read -r file; do
    if [[ -n "$file" ]]; then files+=("$file"); fi
  done <<< "$plan"
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
  # The timeout guards a hang, not a latency budget: a shared machine can stall
  # a test for a minute without a defect. One retry absorbs that stall; a real
  # regression fails both attempts, and every first failure still prints.
  # The timings manifest decides the split and starts the slowest files first.
  # Refresh it with
  # `bun test --timings=../scripts/pwa-test-timings.json --update-timings`.
  # Passing tests are not printed: a shard's log is thousands of lines, and the
  # job's log upload is part of its wall time. Failures and the summary stay.
  step "PWA tests shard $SHARD_INDEX/$SHARD_TOTAL" bun test --isolate --parallel --only-failures --timings="$ROOT/scripts/pwa-test-timings.json" --timeout 120000 --retry=1 "${files[@]}" || code=$?
  if ((code == 0)) && [[ -n "$cache_key" ]]; then
    bun "$ROOT/scripts/verify-cache.ts" store pwa-tests "$SHARD_INDEX/$SHARD_TOTAL" "$cache_key" || true
  fi
  return "$code"
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
  # One program covers both trees: the QA fixtures import most of `src`, and
  # checking that import graph twice wastes CPU without adding a file.
  run_check "PWA types" bun run typecheck:all & pids+=("$!"); labels+=("PWA types")
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
  # The native shell bundles a different entry (native flag, relay origin); a
  # PWA change can break it without breaking the browser build.
  step "PWA native build" bun run build:native
  step "PWA startup budget" bun run perf:budget
  step "origin pack (includes docs build)" bash "$ROOT/scripts/pack-origin-assets.sh"
  test -f "$ROOT/workers/pairfob-origin/public-dist/install.sh"
  test -f "$ROOT/workers/pairfob-origin/public-dist/doc/index.html"
}

run_workers() {
  local pids=() labels=() status=0 i
  (cd "$ROOT/workers/pairfob-origin" && step "Worker tests" bun test --only-failures src) & pids+=("$!"); labels+=("Worker tests")
  (cd "$ROOT/workers/pairfob-origin" && step "Worker harness" bun test --only-failures e2e) & pids+=("$!"); labels+=("Worker harness")
  (cd "$ROOT/workers/pairfob-origin" && step "Worker types" bun run typecheck) & pids+=("$!"); labels+=("Worker types")
  (cd "$ROOT/workers/pairfob-origin" && step "Worker integration" bun run e2e:wrangler) & pids+=("$!"); labels+=("Worker integration")
  (cd "$ROOT/workers/pairfob-downloads" && step "Download Worker tests" bun test --only-failures src) & pids+=("$!"); labels+=("Download Worker tests")
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      echo "verify: ${labels[$i]} failed" >&2
      status=1
    fi
  done
  return "$status"
}

# The four parts read the same source and write different outputs: tests,
# type checks, the packed build and the Worker suites do not depend on each
# other. Run them together so the gate costs its slowest part, not their sum.
run_all() {
  local parts=(tests static build workers) pids=() labels=() status=0 i
  for part in "${parts[@]}"; do
    case "$part" in
      tests) run_tests & ;;
      static) run_static & ;;
      build) run_build & ;;
      workers) run_workers & ;;
    esac
    pids+=("$!")
    labels+=("$part")
  done
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      echo "verify: web ${labels[$i]} failed" >&2
      status=1
    fi
  done
  return "$status"
}

case "$PART" in
  all) run_all ;;
  tests) run_tests ;;
  static) run_static ;;
  build) run_build ;;
  workers) run_workers ;;
esac
