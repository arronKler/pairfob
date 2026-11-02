#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

go run ./cmd/genvectors "$tmp"
if cmp -s "$tmp/pairfob-vectors.json" proto/pairfob-vectors.json; then
  echo "proto vectors match"
  exit 0
fi

echo "proto vectors drifted; regenerate with: go run ./cmd/genvectors proto" >&2
diff -u proto/pairfob-vectors.json "$tmp/pairfob-vectors.json" | head -40 >&2 || true
exit 1