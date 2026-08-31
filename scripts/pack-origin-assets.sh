#!/usr/bin/env bash
# Overlay the marketing site at / and the PWA shell at /pair on the same origin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PWA="$ROOT/pwa/dist"
SITE="$ROOT/site"
DEST="$ROOT/workers/pairfob-origin/public-dist"

if [[ ! -f "$PWA/index.html" ]]; then
  echo "missing $PWA/index.html; run (cd pwa && bun run build)" >&2
  exit 1
fi

# lang.js is shared by the landing page and /doc, which version it in separate
# files. Drift means one of them keeps serving a cached copy after the other is
# updated, so the mismatch has to fail the build rather than ship silently.
site_v="$(grep -o 'lang\.js?v=[0-9]*' "$SITE/index.html" | head -1 | grep -o '[0-9]*')"
doc_v="$(grep -o 'lang\.js?v=[0-9]*' "$ROOT/site/doc/.vitepress/config.ts" | head -1 | grep -o '[0-9]*')"
if [[ -z "$site_v" || -z "$doc_v" ]]; then
  echo "pack: could not read the lang.js version from index.html or the doc config" >&2
  exit 1
fi
if [[ "$site_v" != "$doc_v" ]]; then
  echo "pack: lang.js version drift; index.html has v=$site_v, doc config has v=$doc_v" >&2
  exit 1
fi

# The PWA is copied first, so every root owned by the marketing site or Worker
# must remain absent from its build output. index.html is the one intentional
# overlap: the original PWA shell is copied to /pair after the site replaces /.
reserved_pwa_paths=(
  css doc dl home-i18n.js install.sh lang.js og-en.png og.png
  pair pair.html pair-shell.asset robots.txt site.js sitemap.xml zh zh-shell.asset
)
for path in "${reserved_pwa_paths[@]}"; do
  if [[ -e "$PWA/$path" ]]; then
    echo "pack: PWA output collides with origin-owned path: $path" >&2
    exit 1
  fi
done

# These icons intentionally serve both shells. Refuse to let copy order decide
# which visual identity reaches production if their source copies ever drift.
for path in icon.svg mask-icon.svg apple-touch-icon.png; do
  if [[ ! -f "$PWA/$path" || ! -f "$SITE/$path" ]]; then
    echo "pack: shared asset is missing from PWA or site: $path" >&2
    exit 1
  fi
  if ! cmp -s "$PWA/$path" "$SITE/$path"; then
    echo "pack: shared asset differs between PWA and site: $path" >&2
    exit 1
  fi
done

rm -rf "$DEST"
mkdir -p "$DEST/css" "$DEST/pair"
cp -R "$PWA/." "$DEST/"
# One document serves both locales; home-i18n.js swaps the copy client side.
# English holds the bare path because that is the head crawlers and unfurlers read.
cp "$SITE/index.html" "$DEST/index.html"
mkdir -p "$DEST/zh"
cp "$SITE/index.html" "$DEST/zh/index.html"
# /index.html canonicalizes to `/`. The Worker fetches this copy for /zh.
cp "$SITE/index.html" "$DEST/zh-shell.asset"
cp "$SITE/site.js" "$DEST/site.js"
cp "$SITE/lang.js" "$DEST/lang.js"
cp "$SITE/home-i18n.js" "$DEST/home-i18n.js"
cp "$SITE/css/"*.css "$DEST/css/"
cp "$SITE/icon.svg" "$DEST/icon.svg"
# og*.html and og.css are the sources for the cards (scripts/build-og.sh) and are
# not shipped; only the rendered PNGs are.
cp "$SITE/og.png" "$DEST/og.png"
cp "$SITE/og-en.png" "$DEST/og-en.png"
cp "$SITE/robots.txt" "$DEST/robots.txt"
cp "$SITE/sitemap.xml" "$DEST/sitemap.xml"
(cd "$ROOT/site/doc" && bun run build)
rm -rf "$DEST/doc"
cp -R "$ROOT/site/doc/.vitepress/dist" "$DEST/doc"
if [[ ! -f "$DEST/doc/index.html" ]]; then
  echo "vitepress dist missing index.html" >&2
  exit 1
fi
cp "$ROOT/scripts/install.sh" "$DEST/install.sh"
if [[ "${PAIRFOB_PACK_DL:-}" == "1" ]]; then
  # shellcheck source=ship-guard.sh
  . "$ROOT/scripts/ship-guard.sh"
  pairfob_require_release_dir "$ROOT/dist/dl"
  mkdir -p "$DEST/dl"
  cp "$ROOT/dist/dl/"* "$DEST/dl/"
fi
cp "$PWA/index.html" "$DEST/pair.html"
cp "$PWA/index.html" "$DEST/pair/index.html"
# Cloudflare Assets canonicalizes *.html and */index.html. The Worker fetches
# this opaque copy so /pair cannot be redirected back to itself.
cp "$PWA/index.html" "$DEST/pair-shell.asset"
