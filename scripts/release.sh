#!/usr/bin/env bash
# Cross-compile pairfob for hosted download at https://dl.pairfob.com/daemon.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=ship-guard.sh
. "$ROOT/scripts/ship-guard.sh"
pairfob_require_clean_tree "$ROOT"

VERSION="${VERSION:-}"
if [[ -z "$VERSION" ]] && command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  VERSION="$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || true)"
fi
if [[ -z "$VERSION" ]]; then
  echo "pairfob /dl requires semver: git tag vX.Y.Z on this commit, or set VERSION=X.Y.Z" >&2
  exit 1
fi
COMMIT="${COMMIT:-}"
if [[ -z "$COMMIT" ]] && command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
fi
pairfob_require_shipable_version "$VERSION" "release.sh VERSION"

# Daemons verify release.json against a key embedded at build time. Bake in
# exactly the key publish-daemon.sh signs with.
release_pubkey="${PAIRFOB_RELEASE_PUBKEY:-}"
if [[ -n "$release_pubkey" && -f "$release_pubkey" ]]; then
  release_pubkey="$(tr -d '[:space:]' <"$release_pubkey")"
fi
if [[ -z "$release_pubkey" && -f "$HOME/.config/pairfob/release-signing.pub" ]]; then
  release_pubkey="$(tr -d '[:space:]' <"$HOME/.config/pairfob/release-signing.pub")"
fi
release_pubkey="$(printf '%s' "$release_pubkey" | tr -d '[:space:]')"
if [[ ! "$release_pubkey" =~ ^[0-9a-fA-F]{64}$ ]]; then
  cat >&2 <<EOF
release.sh needs the Ed25519 public key that daemon updates trust.
  PAIRFOB_RELEASE_PUBKEY=<64 hex characters, or a file containing them>
  or $HOME/.config/pairfob/release-signing.pub
Generate a key pair once with: ./scripts/release-keygen.sh
EOF
  exit 1
fi
release_pubkey="$(printf '%s' "$release_pubkey" | tr '[:upper:]' '[:lower:]')"

. "$ROOT/scripts/macos-signing.sh"
pairfob_prepare_macos_signing

OUT="${OUT:-$ROOT/dist/daemon}"
rm -rf "$OUT"
mkdir -p "$OUT"

ldflags="-s -w -X main.version=${VERSION} -X pairfob/internal/release.PublicKeyHex=${release_pubkey}"
if [[ -n "$COMMIT" ]]; then
  ldflags="${ldflags} -X main.commit=${COMMIT}"
fi

for os in darwin linux; do
  for arch in amd64 arm64; do
    dest="${OUT}/pairfob-${os}-${arch}"
    echo "build ${dest}"
# Native macOS Keychain access disables interaction for background reads.
    # Linux remains static; macOS builds retain the native Keychain reader.
    build_env=(CGO_ENABLED=0)
    if [[ "$os" == darwin && "$(uname -s)" == Darwin ]]; then
      # Match Go 1.26's minimum OS instead of inheriting the build Mac's OS.
      build_env=(CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=12.0
        "CGO_CFLAGS=-O2 -g -mmacosx-version-min=12.0"
        "CGO_LDFLAGS=-O2 -g -mmacosx-version-min=12.0")
    fi
    env "${build_env[@]}" GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "$ldflags" -o "$dest" ./cmd/pairfob
    if [[ "$os" == darwin ]]; then
      pairfob_sign_macos_binary "$dest"
    fi
    dest="${OUT}/pairfob-chat-${os}-${arch}"
    echo "build ${dest}"
    env "${build_env[@]}" GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "$ldflags" -o "$dest" ./cmd/pairfob-chat
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

pairfob_require_release_dir "$OUT"

echo "artifacts in ${OUT}"
echo "production: ./scripts/publish-daemon.sh --source \"${OUT}\" --deploy"
echo "Publishing deploys only the download Worker; the relay is unchanged."
