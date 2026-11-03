#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The lockfile and CI both pin Bun in `.bun-version`. An older Bun on PATH
# silently changes the runner: 1.3.x ignores `--parallel`, so the PWA suite
# runs one file at a time and the gate takes three times as long. Resolve the
# pinned binary once here instead of trusting whichever `bun` comes first.
PINNED_BUN="$(cat "$ROOT/.bun-version")"
if [[ -n "${PAIRFOB_BUN:-}" ]]; then
  bun_bin="$PAIRFOB_BUN"
elif [[ -x "$HOME/.bun/bin/bun" && "$("$HOME/.bun/bin/bun" --version 2>/dev/null)" == "$PINNED_BUN" ]]; then
  bun_bin="$HOME/.bun/bin/bun"
else
  bun_bin="$(command -v bun || true)"
fi
bun_version="$("${bun_bin:-bun}" --version 2>/dev/null || true)"
if [[ "$bun_version" != "$PINNED_BUN" ]]; then
  echo "verify: Bun $PINNED_BUN is required, found ${bun_version:-none}" >&2
  echo "verify: install it with: curl -fsSL https://bun.sh/install | bash -s bun-v$PINNED_BUN" >&2
  exit 1
fi
PATH="$(cd "$(dirname "$bun_bin")" && pwd):$PATH"
export PATH

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

# The four gates write different trees and only read the checkout. Running
# them together keeps cores busy while one gate waits on a compiler, a
# browser, or the network. Each gate still runs every check it did before.
pids=()
labels=()
for gate in go scripts desktop web; do
  (
    start=$SECONDS
    bash "$ROOT/scripts/verify-$gate.sh"
    echo "verify: $gate gate passed in $((SECONDS - start))s"
  ) &
  pids+=("$!")
  labels+=("$gate")
done

status=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    echo "verify: ${labels[$i]} gate failed" >&2
    status=1
  fi
done
exit "$status"