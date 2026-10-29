#!/usr/bin/env bash
# Android shell gate, for an APK-only release whose changes stayed inside
# --android-only scope. Covers the page the APK bundles, the channel publisher
# and the APK's own provenance checks. Run scripts/verify.sh --android-only
# <verified-commit> instead of calling this directly: it checks the scope first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

step() {
  local label="$1" start=$SECONDS
  shift
  echo "verify: starting $label"
  "$@"
  echo "verify: $label passed in $((SECONDS - start))s"
}

bash -n "$ROOT/scripts/build-android-release.sh"
bash -n "$ROOT/scripts/publish-android-beta.sh"
step "Android provenance" python3 "$ROOT/scripts/android-provenance.test.py"
step "download channel" python3 "$ROOT/scripts/download-channel.test.py"

cd "$ROOT/pwa"
# Bun's 5 s default sits at the cost of the heaviest architecture and DOM tests
# on a loaded machine, and one test cut off mid-jsdom poisons every later file.
step "PWA tests" bun test src --timeout 30000
step "PWA QA" bun run test:qa
step "PWA types" bun run typecheck
step "PWA QA types" bun run typecheck:qa
step "PWA performance tooling" bun run test:performance
step "PWA asset retention" bun test "$ROOT/scripts/retain-pwa-assets.test.ts"
# The APK ships dist-native, so measure and budget that exact bundle.
step "PWA native build" bun run build:native
step "PWA startup budget" bun scripts/performance-budget.ts dist-native

cd "$ROOT/workers/pairfob-downloads"
step "Download Worker tests" bun test src
