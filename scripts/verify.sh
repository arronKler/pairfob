#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

unformatted="$(gofmt -l ./cmd ./internal)"
if [[ -n "$unformatted" ]]; then
  echo "gofmt required:" >&2
  echo "$unformatted" >&2
  exit 1
fi

bash -n "$ROOT/scripts/install.sh"
bash -n "$ROOT/scripts/release.sh"
bash -n "$ROOT/scripts/pack-origin-assets.sh"
bash -n "$ROOT/scripts/ship-guard.sh"
bash -n "$ROOT/scripts/dev-up.sh"
bash -n "$ROOT/scripts/dev-down.sh"

jq empty proto/pairfob-vectors.json proto/pgp-words.json proto/rpc.schema.json proto/pairfob-v2-wire.json
go vet ./...
go test ./...
go test -race ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...
bun test scripts/load-mux.test.ts
(cd "$ROOT/site/doc" && bun test)

(
  cd pwa
  bun test src
  bun run typecheck
  bun run build
)

"$ROOT/scripts/pack-origin-assets.sh"
test -f "$ROOT/workers/pairfob-origin/public-dist/install.sh"
test -f "$ROOT/workers/pairfob-origin/public-dist/doc/index.html"

(
  cd workers/pairfob-origin
  bun test src
  bun test e2e
  bun run typecheck
  bun run e2e:wrangler
)
