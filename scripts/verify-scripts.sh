#!/usr/bin/env bash
# Script, proto and documentation checks. They read the checkout and write
# temporary files, so they run together and the gate costs its slowest check.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pids=()
labels=()

run_check() {
  local label="$1" start=$SECONDS
  shift
  echo "verify: starting $label"
  "$@"
  echo "verify: $label passed in $((SECONDS - start))s"
}

start_check() {
  local label="$1"
  shift
  run_check "$label" "$@" &
  pids+=("$!")
  labels+=("$label")
}

check_shell_syntax() {
  find "$ROOT/scripts" "$ROOT/plugin/herdr" -type f -name '*.sh' -print0 |
    while IFS= read -r -d '' script; do
      bash -n "$script"
    done
}

check_plugin() { bun test plugin/herdr/plugin.test.ts; }
check_docs() { (cd site/doc && bun test); }
# The repository is public; a lockfile URL pointing at an internal mirror makes
# a fresh checkout uninstallable outside it.
check_registry() {
  local lockfile
  for lockfile in pwa/bun.lock mobile/bun.lock workers/pairfob-origin/bun.lock workers/pairfob-downloads/bun.lock site/doc/bun.lock; do
    [[ -f "$lockfile" ]] || continue
    if grep -q 'bnpm\.byted\.org' "$lockfile"; then
      echo "verify: internal package registry in $lockfile" >&2
      return 1
    fi
  done
}
# The files work in their own temp trees and spawn their own processes, so
# they can share workers instead of queuing behind the slowest git call.
check_scripts() { bun test --isolate --parallel scripts/*.test.ts --timeout 30000; }

start_check "shell syntax" check_shell_syntax
start_check "download channel tests" python3 scripts/download-channel.test.py
start_check "android provenance tests" python3 scripts/android-provenance.test.py
start_check "source size" bash "$ROOT/scripts/check-source-size.sh"
start_check "proto JSON" jq empty proto/pairfob-vectors.json proto/pgp-words.json proto/rpc.schema.json
start_check "public registry" check_registry
start_check "script tests" check_scripts
start_check "Herdr plugin test" check_plugin
start_check "site docs" check_docs
start_check "proto vectors" bash "$ROOT/scripts/check-vectors.sh"

status=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    echo "verify: ${labels[$i]} failed" >&2
    status=1
  fi
done
exit "$status"