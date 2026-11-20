#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
swiftc -O -target "$(uname -m)-apple-macos14.4" scripts/desktop-latency/native/*.swift -o "$dir/probe"
go build -o "$dir/server" ./scripts/desktop-latency
"$dir/server" -probe "$dir/probe" "$@"
