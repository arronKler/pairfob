#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--pwa-only" && $# == 2 ]]; then
  bun "$ROOT/scripts/pwa-release-scope.ts" "$2"
  exec bash "$ROOT/scripts/verify-web.sh"
elif [[ "${1:-}" == "--android-only" && $# == 2 ]]; then
  bun "$ROOT/scripts/android-release-scope.ts" "$2"
  exec bash "$ROOT/scripts/verify-android.sh"
elif [[ $# != 0 ]]; then
  echo "usage: $0 [--pwa-only|--android-only <previously-verified-commit>]" >&2
  exit 2
fi

bash "$ROOT/scripts/verify-go.sh"
bash "$ROOT/scripts/verify-scripts.sh"
bash "$ROOT/scripts/verify-desktop.sh"
bash "$ROOT/scripts/verify-web.sh"