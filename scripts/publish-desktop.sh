#!/usr/bin/env bash
# Publish verified desktop executables without deploying the relay or replacing
# daemon or Android assets. The manifest lives at
# https://dl.pairfob.com/desktop/release.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOWNLOADS="$ROOT/workers/pairfob-downloads"
SOURCE="$ROOT/dist/desktop"
ORIGIN="${PAIRFOB_DOWNLOAD_ORIGIN:-https://dl.pairfob.com}"
DEPLOY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:?missing source}"; shift 2 ;;
    --deploy) DEPLOY=1; shift ;;
    *) echo 'usage: publish-desktop.sh [--source DIR] [--deploy]' >&2; exit 2 ;;
  esac
done

. "$ROOT/scripts/ship-guard.sh"
# Local dirty fixtures must never bypass release checks in a publisher.
unset PAIRFOB_ALLOW_DIRTY
pairfob_require_clean_tree "$ROOT"
pairfob_require_desktop_dir "$SOURCE"

COMMIT="${COMMIT:-}"
if [[ -z "$COMMIT" ]]; then
  COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
if [[ ! "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "publish-desktop.sh requires a full git commit; set COMMIT=<40 hex>" >&2
  exit 1
fi

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
python3 "$ROOT/scripts/download-channel.py" preserve --channel daemon --origin "$ORIGIN" \
  --public "$PUBLIC" --receipt "$scratch/daemon.json"
python3 "$ROOT/scripts/download-channel.py" preserve --channel android --origin "$ORIGIN" \
  --public "$PUBLIC" --receipt "$scratch/android.json"
python3 "$ROOT/scripts/download-channel.py" stage-desktop --origin "$ORIGIN" --public "$PUBLIC" \
  --source "$SOURCE" --commit "$COMMIT" --receipt "$scratch/desktop.json"
echo "staged desktop $(tr -d '[:space:]' <"$SOURCE/VERSION") at $ORIGIN/desktop"
if [[ "$DEPLOY" != 1 ]]; then
  echo 'not deployed; rerun this publisher with --deploy after verification'
  exit 0
fi

python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/daemon.json"
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/android.json"
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/desktop.json"
(cd "$DOWNLOADS" && bunx wrangler deploy)
python3 "$ROOT/scripts/download-channel.py" verify-desktop --origin "$ORIGIN" --public "$PUBLIC"
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/daemon.json"
python3 "$ROOT/scripts/download-channel.py" check --receipt "$scratch/android.json"
echo "verified live desktop artifacts and unchanged daemon and Android channels on $ORIGIN"