#!/usr/bin/env bash
# Render the share cards at the 1200x630 size link previews expect: og.png for /
# and og-en.png for /en/. Rerun when og*.html or og.css change; the PNGs are
# committed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${OG_PORT:-8912}"

command -v browse >/dev/null 2>&1 || {
  echo "build-og.sh: needs the browse CLI" >&2
  exit 1
}

python3 -m http.server "$PORT" --directory "$ROOT/site" >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
sleep 2

browse viewport 1200 630 --session og >/dev/null
for pair in "og.html:og.png" "og-en.html:og-en.png"; do
  src="${pair%%:*}"
  out="${pair##*:}"
  browse open "http://127.0.0.1:${PORT}/${src}" --session og >/dev/null
  sleep 3
  browse screenshot --session og --path "$ROOT/site/$out" >/dev/null
  echo "wrote site/$out"
done
browse stop --session og >/dev/null 2>&1 || true
