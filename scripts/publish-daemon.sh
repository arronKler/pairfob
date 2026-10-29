#!/usr/bin/env bash
# Publish verified daemon artifacts without deploying the relay or replacing APKs.
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
if [[ "$DEPLOY" != 1 ]]; then
  echo 'not deployed; rerun this publisher with --deploy after verification'
  exit 0
fi
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/android.json"
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/daemon.json"
(cd "$DOWNLOADS" && bunx wrangler deploy)
python3 "$ROOT/scripts/download-channel.py" verify-daemon --origin "$ORIGIN" --public "$PUBLIC"
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/android.json"
echo "verified live daemon artifacts and unchanged Android channel on $ORIGIN"
