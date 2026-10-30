#!/usr/bin/env bash
# Desktop client gate. The GPUI feature is part of the lint pass, because the
# window is the product; tests stay on the light build so they need no display.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/desktop"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to verify the desktop client" >&2
  exit 1
fi

step() {
  local label="$1" start=$SECONDS
  shift
  echo "verify: starting $label"
  "$@"
  echo "verify: $label passed in $((SECONDS - start))s"
}

step "desktop format" cargo fmt --all -- --check
step "desktop lints" cargo clippy --all-targets -- -D warnings
step "desktop screenshot lints" cargo clippy --all-targets --features shot -- -D warnings
step "desktop performance HUD lints" cargo clippy --all-targets --features perf-hud -- -D warnings
step "desktop tests" cargo test
step "desktop headless tests" cargo test --no-default-features
