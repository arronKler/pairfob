#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find "$ROOT/scripts" "$ROOT/plugin/herdr" -type f -name '*.sh' -print0 |
  while IFS= read -r -d '' script; do
    bash -n "$script"
  done

python3 scripts/download-channel.test.py
python3 scripts/android-provenance.test.py

bash "$ROOT/scripts/check-source-size.sh"

jq empty proto/pairfob-vectors.json proto/pgp-words.json proto/rpc.schema.json

bun test scripts/*.test.ts --timeout 30000
bun test plugin/herdr/plugin.test.ts
(cd site/doc && bun test)

bash "$ROOT/scripts/check-vectors.sh"