#!/usr/bin/env bash
# Build Pairfob Desktop executables for the current or requested Rust targets.
# Publish them with scripts/publish-desktop.sh; this script never deploys.
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
  echo "release-desktop.sh requires semver: git tag vX.Y.Z on this commit, or set VERSION=X.Y.Z" >&2
  exit 1
fi
pairfob_require_shipable_version "$VERSION" "release-desktop.sh VERSION"

targets="${PAIRFOB_DESKTOP_TARGETS:-}"
if [[ -z "$targets" ]]; then
  targets="$(rustc -vV | awk '/^host: /{ print $2 }')"
fi
if [[ -z "$targets" ]]; then
  echo "could not determine a Rust target; set PAIRFOB_DESKTOP_TARGETS" >&2
  exit 1
fi

desktop_name() {
  case "$1" in
    aarch64-apple-darwin) echo darwin-arm64 ;;
    x86_64-apple-darwin) echo darwin-amd64 ;;
    aarch64-unknown-linux-gnu) echo linux-arm64 ;;
    x86_64-unknown-linux-gnu) echo linux-amd64 ;;
    *) return 1 ;;
  esac
}

OUT="${OUT:-$ROOT/dist/desktop}"
mkdir -p "$OUT"
# Building on another OS may add its platform to the same version, so keep the
# existing platform binaries and rewrite the shared inventory afterwards. Mixing
# artifact versions in one directory is never allowed.
if [[ -f "$OUT/VERSION" ]]; then
  previous="$(tr -d '[:space:]' <"$OUT/VERSION")"
  if [[ "$previous" != "$VERSION" ]] && compgen -G "$OUT/pairfob-desktop-*" >/dev/null; then
    echo "$OUT already contains $previous artifacts; use a fresh OUT for $VERSION" >&2
    exit 1
  fi
elif compgen -G "$OUT/pairfob-desktop-*" >/dev/null; then
  echo "$OUT contains desktop binaries without VERSION; use a fresh OUT" >&2
  exit 1
fi

names=()
for triple in $targets; do
  name="$(desktop_name "$triple")" || {
    echo "unsupported desktop target: $triple" >&2
    echo "supported: aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu" >&2
    exit 2
  }
  if [[ " ${names[*]:-} " == *" $name "* ]]; then
    echo "duplicate desktop target: $name" >&2
    exit 2
  fi
  echo "build pairfob-desktop $name ($triple)"
  (
    cd "$ROOT/desktop"
    PAIRFOB_DESKTOP_VERSION="$VERSION" cargo build \
      --release \
      --target "$triple" \
      --bin pairfob-desktop
  )
  source_binary="$ROOT/desktop/target/$triple/release/pairfob-desktop"
  if [[ ! -x "$source_binary" ]]; then
    echo "cargo did not produce $source_binary" >&2
    exit 1
  fi
  cp "$source_binary" "$OUT/pairfob-desktop-$name"
  chmod 0755 "$OUT/pairfob-desktop-$name"
  names+=("$name")
done

printf '%s\n' "$VERSION" >"$OUT/VERSION"
(
  cd "$OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum pairfob-desktop-* VERSION >SHA256SUMS
  else
    shasum -a 256 pairfob-desktop-* VERSION >SHA256SUMS
  fi
)
pairfob_require_desktop_dir "$OUT"

host_triple="$(rustc -vV | awk '/^host: /{ print $2 }')"
host_name="$(desktop_name "$host_triple" 2>/dev/null || true)"
if [[ -n "$host_name" && -x "$OUT/pairfob-desktop-$host_name" ]]; then
  reported="$("$OUT/pairfob-desktop-$host_name" --version)"
  if [[ "$reported" != "pairfob-desktop $VERSION" ]]; then
    echo "native build reports '$reported', expected 'pairfob-desktop $VERSION'" >&2
    exit 1
  fi
fi

echo "artifacts in ${OUT}"
echo "production: ./scripts/publish-desktop.sh --source \"${OUT}\" --deploy"
echo "Publishing deploys only the download Worker; the relay is unchanged."