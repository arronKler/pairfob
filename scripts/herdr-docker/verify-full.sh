#!/usr/bin/env bash
# Verify a writable source snapshot; never change the read-only host checkout.
set -euo pipefail
mkdir -p /work
# Only repository sources, including this task's untracked files. Excludes
# ignored credentials, host native node_modules and generated build output.
git -c safe.directory=/src -C /src ls-files -z --cached --others --exclude-standard \
  | tar -C /src --null -T - -cf - | tar -C /work -xf -
cd /work
for dir in pwa site/doc workers/pairfob-origin workers/pairfob-downloads; do
  (cd "$dir" && bun install --frozen-lockfile)
done
# Permission-denial tests must run as a normal user: root bypasses mode 000.
id pairfob-test >/dev/null 2>&1 || useradd --create-home --uid 1000 pairfob-test
mkdir -p /cache
chown -R 1000:1000 /work /go/pkg/mod /cache
runuser -u pairfob-test -- env GOPATH=/home/pairfob-test/go GOMODCACHE=/go/pkg/mod GOCACHE=/cache GOFLAGS=-p=1 ./scripts/verify.sh
