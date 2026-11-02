#!/usr/bin/env bash
# Shared web gate. Production callers may set PAIRFOB_PACK_DL=1 to pack once.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

step() {
  local label="$1" start=$SECONDS
  shift
  echo "verify: starting $label"
  "$@"
  echo "verify: $label passed in $((SECONDS - start))s"
}

cd "$ROOT/pwa"
# Bun's 5 s default sits at the cost of the heaviest architecture and DOM tests
# on a loaded machine. A leak from one file, or a test cut off mid-jsdom, must
# not reach the next: isolate each file's globals and module registry. A
# preload's setDefaultTimeout does not reach a directory run, so pass it here.
step "PWA tests" bun test src --isolate --timeout 30000
step "PWA QA" bun run test:qa
step "PWA types" bun run typecheck
step "PWA QA types" bun run typecheck:qa
step "PWA performance tooling" bun run test:performance
step "PWA asset retention" bun test "$ROOT/scripts/retain-pwa-assets.test.ts"
step "PWA build" bun run build
step "PWA startup budget" bun run perf:budget
step "origin pack (includes docs build)" bash "$ROOT/scripts/pack-origin-assets.sh"
test -f "$ROOT/workers/pairfob-origin/public-dist/install.sh"
test -f "$ROOT/workers/pairfob-origin/public-dist/doc/index.html"

cd "$ROOT/workers/pairfob-origin"
step "Worker tests" bun test src
step "Worker harness" bun test e2e
step "Worker types" bun run typecheck
step "Worker integration" bun run e2e:wrangler

cd "$ROOT/workers/pairfob-downloads"
step "Download Worker tests" bun test src
