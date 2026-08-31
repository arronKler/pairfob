#!/usr/bin/env bash
# Render committed stills from site HTML: og.png / og-en.png (1200×630 share
# cards) and readme-hero.png (1400×520 GitHub README). Rerun when those HTML/CSS
# sources change.
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

browse viewport 1400 520 --session og >/dev/null
browse open "http://127.0.0.1:${PORT}/readme-hero.html" --session og >/dev/null
sleep 3
browse screenshot --session og --path "$ROOT/site/readme-hero.png" >/dev/null
echo "wrote site/readme-hero.png"
browse stop --session og >/dev/null 2>&1 || true
