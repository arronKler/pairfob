#!/usr/bin/env bash
# Cross-compile pairfob for hosted download at https://pairfob.com/dl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=ship-guard.sh
. "$ROOT/scripts/ship-guard.sh"
pairfob_require_clean_tree "$ROOT"

VERSION="${VERSION:-dev}"
if [[ "$VERSION" == "dev" ]] && command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)"
fi
COMMIT="${COMMIT:-}"
if [[ -z "$COMMIT" ]] && command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
fi
pairfob_require_shipable_version "$VERSION" "release.sh VERSION"

OUT="${OUT:-$ROOT/dist/dl}"
rm -rf "$OUT"
mkdir -p "$OUT"

ldflags="-s -w -X main.version=${VERSION}"
if [[ -n "$COMMIT" ]]; then
  ldflags="${ldflags} -X main.commit=${COMMIT}"
fi

for os in darwin linux; do
  for arch in amd64 arm64; do
    dest="${OUT}/pairfob-${os}-${arch}"
    echo "build ${dest}"
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "$ldflags" -o "$dest" ./cmd/pairfob
  done
done

printf '%s\n' "$VERSION" >"${OUT}/VERSION"

(
  cd "$OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum pairfob-* VERSION >SHA256SUMS
  else
    shasum -a 256 pairfob-* VERSION >SHA256SUMS
  fi
)

echo "artifacts in ${OUT}"
echo "production: PAIRFOB_PACK_DL=1 ./scripts/pack-origin-assets.sh then wrangler deploy"
echo "verify.sh omits binaries so Worker e2e stays small."
