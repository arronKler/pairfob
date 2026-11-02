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

go vet ./...
# These packages include many Argon2 handshakes and encrypted media transfers.
# Give the whole package the same budget with and without the race detector;
# individual RPC/network deadlines remain bounded in their tests.
go test -timeout 20m ./...
go test -race -timeout 20m ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...