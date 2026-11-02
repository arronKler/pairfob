#!/usr/bin/env bash
# Generate the Ed25519 key pair that signs daemon release manifests.
set -euo pipefail

KEY_DIR="${PAIRFOB_RELEASE_KEY_DIR:-$HOME/.config/pairfob}"
FORCE=0

usage() { echo 'usage: release-keygen.sh [--force]' >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) echo 'usage: release-keygen.sh [--force]'; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

private_key="$KEY_DIR/release-signing.key"
public_key="$KEY_DIR/release-signing.pub"

if [[ -e "$private_key" || -e "$public_key" ]]; then
  if (( FORCE == 0 )); then
    echo "a release signing key already exists in $KEY_DIR" >&2
    echo "refusing to overwrite it; pass --force to replace the pair deliberately" >&2
    exit 1
  fi
  echo "replacing $private_key; daemons built with the old key stop trusting new releases" >&2
  rm -f "$private_key" "$public_key"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo 'python3 is required to print the public key fingerprint' >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT" && go run ./cmd/releasekey gen --out "$KEY_DIR")

public_hex="$(tr -d '[:space:]' <"$public_key")"
fingerprint="$(python3 -c '
import hashlib, sys
digest = hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest().upper()
print(":".join(digest[i:i + 2] for i in range(0, len(digest), 2)))
' "$public_hex")"

cat <<EOF
public key fingerprint: $fingerprint
public key:             $public_hex

Back up $private_key offline now: anyone holding it can sign daemon updates.
release.sh bakes this public key into the daemon, and publish-daemon.sh signs
release.json with the private half.
EOF
