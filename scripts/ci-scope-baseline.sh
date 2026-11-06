#!/usr/bin/env bash
# Print the scope lines for this run, failing open to the full gate.
#
# The changes job and every web-test shard call this. A shard starts at
# dispatch instead of waiting for changes, so a web push begins its setup
# while the changes job is still provisioning; both must reach the same
# decision from the same baseline.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE=""
if [[ "${EVENT_NAME:-}" == "pull_request" ]]; then
  BASE="${PR_BASE:-}"
else
  # A push verifies the range since the last green main run. A red run leaves
  # the baseline older, so its changes run again.
  BASE="$(gh api \
    "repos/$GITHUB_REPOSITORY/actions/workflows/verify.yml/runs?branch=main&status=success&event=push&per_page=1" \
    --jq '.workflow_runs[0].head_sha // empty' || true)"
  # A baseline that is not an ancestor (rewritten main) would diff the wrong
  # range; fall back to the full gate.
  if [[ -n "$BASE" ]] && ! git merge-base --is-ancestor "$BASE" HEAD; then
    BASE=""
  fi
fi

SCOPE=""
if [[ -n "$BASE" ]]; then
  # An unreadable range must verify more, not less: fall back to the full gate
  # instead of failing into an all-skipped run.
  SCOPE="$(bun scripts/ci-scope.ts "$BASE")" || SCOPE=""
fi
if [[ -z "$SCOPE" ]]; then
  SCOPE="$(bun scripts/ci-scope.ts --all)"
fi

# A missing or malformed line must fail the job, never skip the suite.
for key in go web docs desktop mobile; do
  if ! grep -qx "$key=true" <<< "$SCOPE" && ! grep -qx "$key=false" <<< "$SCOPE"; then
    echo "scope: missing $key in classifier output" >&2
    exit 1
  fi
done

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf '%s\n' "$SCOPE" >> "$GITHUB_OUTPUT"
else
  printf '%s\n' "$SCOPE"
fi