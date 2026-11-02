#!/usr/bin/env bash
# Publish verified daemon artifacts without deploying the relay or replacing APKs.
# The staged release.json is signed here; the daemon verifies it against the
# public key that release.sh embedded.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOWNLOADS="$ROOT/workers/pairfob-downloads"
SOURCE="$ROOT/dist/daemon"
ORIGIN="${PAIRFOB_DOWNLOAD_ORIGIN:-https://dl.pairfob.com}"
DEPLOY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:?missing source}"; shift 2 ;;
    --deploy) DEPLOY=1; shift ;;
    *) echo 'usage: publish-daemon.sh [--source DIR] [--deploy]' >&2; exit 2 ;;
  esac
done
. "$ROOT/scripts/ship-guard.sh"
# Local dirty fixtures must never bypass release checks in a publisher.
unset PAIRFOB_ALLOW_DIRTY
pairfob_require_release_dir "$SOURCE"
. "$ROOT/scripts/macos-signing.sh"
pairfob_verify_macos_release "$SOURCE"
# Both publishers deploy the same Worker. Keep the lock outside the checkout so
# two checkouts on one machine cannot publish concurrently.
LOCK="${PAIRFOB_PUBLISH_LOCK:-$HOME/.cache/pairfob/publish.lock}"
mkdir -p "$(dirname "$LOCK")"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another download publication is running: $LOCK" >&2
  exit 1
fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"; rmdir "$LOCK" 2>/dev/null || true' EXIT
PUBLIC="$DOWNLOADS/public"
python3 "$ROOT/scripts/download-channel.py" preserve --channel android --origin "$ORIGIN" \
  --public "$PUBLIC" --receipt "$scratch/android.json"
python3 "$ROOT/scripts/download-channel.py" stage-daemon --origin "$ORIGIN" --public "$PUBLIC" \
  --source "$SOURCE" --installer "$ROOT/scripts/install.sh" --receipt "$scratch/daemon.json"
echo "staged daemon $(cat "$SOURCE/VERSION") at $ORIGIN/daemon"

MANIFEST="$PUBLIC/daemon/release.json"
release_key="${PAIRFOB_RELEASE_KEY:-$HOME/.config/pairfob/release-signing.key}"
if [[ ! -f "$release_key" ]]; then
  cat >&2 <<EOF
publish-daemon.sh signs $MANIFEST with an Ed25519 key.
  PAIRFOB_RELEASE_KEY=<private key file>
  or $release_key
Generate one with ./scripts/release-keygen.sh and keep a backup offline.
EOF
  exit 1
fi
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
publish-daemon.sh needs the public half of the release signing key.
  PAIRFOB_RELEASE_PUBKEY=<64 hex characters, or a file containing them>
  or $HOME/.config/pairfob/release-signing.pub
release.sh embeds the same key in the daemon it builds.
EOF
  exit 1
fi
release_pubkey="$(printf '%s' "$release_pubkey" | tr '[:upper:]' '[:lower:]')"

releasekey=(go -C "$ROOT" run ./cmd/releasekey)
if ! "${releasekey[@]}" sign --key "$release_key" --in "$MANIFEST" --out "$MANIFEST.sig"; then
  rm -f "$MANIFEST.sig"
  echo "could not sign $MANIFEST; refusing to publish an unsigned daemon manifest" >&2
  exit 1
fi
if ! "${releasekey[@]}" verify --pub "$release_pubkey" --in "$MANIFEST" --sig "$MANIFEST.sig"; then
  rm -f "$MANIFEST.sig"
  echo "the release signing key does not match $release_pubkey" >&2
  exit 1
fi
echo "signed $MANIFEST with ${release_pubkey:0:16}..."

if [[ "$DEPLOY" != 1 ]]; then
  echo 'not deployed; rerun this publisher with --deploy after verification'
  exit 0
fi
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/android.json"
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/daemon.json"
(cd "$DOWNLOADS" && bunx wrangler deploy)
python3 "$ROOT/scripts/download-channel.py" verify-daemon --origin "$ORIGIN" --public "$PUBLIC"
live="$scratch/live"
mkdir -p "$live"
fetch_live() {
  if ! curl --silent --show-error --fail --max-time 120 --retry 2 -o "$2" "$ORIGIN$1"; then
    echo "could not read $ORIGIN$1 from the live download channel" >&2
    exit 1
  fi
}
fetch_live /daemon/release.json "$live/release.json"
fetch_live /daemon/release.json.sig "$live/release.json.sig"
if ! "${releasekey[@]}" verify --pub "$release_pubkey" --in "$live/release.json" --sig "$live/release.json.sig"; then
  echo "the live daemon manifest does not carry a valid signature from $release_pubkey" >&2
  exit 1
fi
live_version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$live/release.json")"
staged_version="$(tr -d '[:space:]' <"$SOURCE/VERSION")"
if [[ "$live_version" != "$staged_version" ]]; then
  echo "live release.json is $live_version but the staged VERSION is $staged_version" >&2
  exit 1
fi
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/android.json"
echo "verified live daemon artifacts $live_version, their signature, and the unchanged Android channel on $ORIGIN"
