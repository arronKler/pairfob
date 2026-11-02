#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--pwa-only" && $# == 2 ]]; then
  bun "$ROOT/scripts/pwa-release-scope.ts" "$2"
  exec bash "$ROOT/scripts/verify-web.sh"
elif [[ "${1:-}" == "--android-only" && $# == 2 ]]; then
  bun "$ROOT/scripts/android-release-scope.ts" "$2"
  exec bash "$ROOT/scripts/verify-android.sh"
elif [[ $# != 0 ]]; then
  echo "usage: $0 [--pwa-only|--android-only <previously-verified-commit>]" >&2
  exit 2
fi

unformatted="$(gofmt -l ./cmd ./internal)"
if [[ -n "$unformatted" ]]; then
  echo "gofmt required:" >&2
  echo "$unformatted" >&2
  exit 1
fi

bash -n "$ROOT/scripts/install.sh"
bash -n "$ROOT/scripts/check-source-size.sh"
bash -n "$ROOT/scripts/release.sh"
bash -n "$ROOT/scripts/release-keygen.sh"
bash -n "$ROOT/scripts/release-desktop.sh"
bash -n "$ROOT/scripts/macos-signing.sh"
bash -n "$ROOT/scripts/build-android-release.sh"
bash -n "$ROOT/scripts/publish-android-beta.sh"
bash -n "$ROOT/scripts/publish-daemon.sh"
bash -n "$ROOT/scripts/publish-desktop.sh"
python3 "$ROOT/scripts/download-channel.test.py"
python3 "$ROOT/scripts/android-provenance.test.py"
bash -n "$ROOT/scripts/pack-origin-assets.sh"
bash -n "$ROOT/scripts/ship-guard.sh"
bash -n "$ROOT/scripts/verify-web.sh"
bash -n "$ROOT/scripts/verify-desktop.sh"
bash -n "$ROOT/scripts/verify-android.sh"
bash -n "$ROOT/scripts/dev-acme.sh"
bash -n "$ROOT/scripts/dev-up.sh"
bash -n "$ROOT/scripts/dev-down.sh"
bash -n "$ROOT/plugin/herdr/open-pane.sh"
bash -n "$ROOT/plugin/herdr/pairfob.sh"

bash "$ROOT/scripts/check-source-size.sh"

jq empty proto/pairfob-vectors.json proto/pgp-words.json proto/rpc.schema.json

vectors_dir="$(mktemp -d)"
trap 'rm -rf "$vectors_dir"' EXIT
go run ./cmd/genvectors "$vectors_dir"
if ! cmp -s "$vectors_dir/pairfob-vectors.json" proto/pairfob-vectors.json; then
  echo "proto/pairfob-vectors.json is stale; regenerate with go run ./cmd/genvectors" >&2
  diff -u proto/pairfob-vectors.json "$vectors_dir/pairfob-vectors.json" >&2 || true
  exit 1
fi
rm -rf "$vectors_dir"
trap - EXIT

go vet ./...
# These packages include many Argon2 handshakes and encrypted media transfers.
# Give the whole package the same budget with and without the race detector;
# individual RPC/network deadlines remain bounded in their tests.
go test -timeout 20m ./...
go test -race -timeout 20m ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...
bun test scripts/load-mux.test.ts
bun test scripts/dev-acme.test.ts
bun test scripts/ship-guard.test.ts --timeout 30000
bun test scripts/macos-signing.test.ts
bun test scripts/pwa-release-scope.test.ts
bun test scripts/android-release-scope.test.ts
bun test plugin/herdr/plugin.test.ts
(cd "$ROOT/site/doc" && bun test)

bash "$ROOT/scripts/verify-desktop.sh"
bash "$ROOT/scripts/verify-web.sh"
