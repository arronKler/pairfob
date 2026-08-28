#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT/site/doc" && bun run build)
exec python3 "$ROOT/scripts/site-preview.py" \
  --dir "$ROOT/site" \
  --doc-dir "$ROOT/site/doc/.vitepress/dist" \
  --port "${PORT:-8765}"
