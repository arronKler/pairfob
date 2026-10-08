# Developing Pairfob

This page holds the contributor and maintainer detail that used to live in the
README: running the stack locally, testing on a real phone, verification, and
releases. Agent-facing rules live in [`AGENTS.md`](../AGENTS.md).

## Local stack

Install PWA dependencies once:

```sh
(cd pwa && bun install --frozen-lockfile)
```

Local pairing runs against the same Worker as production:

```sh
./scripts/dev-up.sh     # origin + pairfob + PWA on loopback
./scripts/dev-down.sh
```

1. On the computer, run the `pairfob pair` command printed by `dev-up.sh`
   (same `PAIRFOB_STATE_DIR`). It shows a QR first and keeps a pairing code as
   fallback.
2. Open `http://127.0.0.1:18786/pair`. Scan to start, or expand **Enter pairing
   code**.
3. When the computer says the phone proved the code, press Enter. The phone
   connects on its own.
4. Open a **Needs you** card. That is the live Herdr session on the computer.

`dev-up.sh` attaches to local Herdr by default. Set
`PAIRFOB_DEV_FAKE_RUNTIME=1` for built-in demo data. Set
`PAIRFOB_HERDR_AUTOSTART=0` to skip starting Herdr. Never enable
`PAIRFOB_DEV_AUTO_ADMIT` outside an isolated test.

## Testing on a real phone

For phone testing without installing a local CA, create a DNS-only A record
that points a hostname you control to this computer's LAN IPv4, then use the
optional DNS-01 mode:

```sh
PAIRFOB_ACME_DOMAIN=pairfob-dev.example.com \
PAIRFOB_ACME_DNS=cloudflare \
PAIRFOB_ACME_EMAIL=you@example.com \
CF_DNS_API_TOKEN='<zone-scoped token>' \
./scripts/dev-up.sh
```

The hostname makes `dev-up.sh` listen on the LAN automatically. The first run
downloads a pinned, checksum-verified `lego` under `.dev/tools`; certificates
and ACME account data stay under `.dev/acme` and are reused until renewal is
needed. Supported DNS providers are `cloudflare`, `route53`, `alidns`,
`tencentcloud`, `huaweicloud`, and `digitalocean`. The A record must not use an
HTTP proxy/CDN because the private address must remain visible to devices on
the same LAN.

## Verification

Choose checks by change scope and stage; the full rules are in
[`AGENTS.md#verify`](../AGENTS.md#verify). In short:

- During local iteration, run affected module tests and relevant type/format
  checks. Include affected consumers when shared code changes.
- For UI behavior/layout changes, check the changed interactions and viewports
  in a browser. Documentation/copy-only changes need relevant diff, link or
  rendering checks, not unrelated code suites.
- Before delivering backend, protocol, cross-module contract or release-tooling
  changes, run `./scripts/verify.sh` once on the final candidate. This includes
  gofmt, vet, Go tests (including race), vulnerability checks, PWA / Worker /
  site tests, typechecks and production builds. Regenerate changed protocol
  vectors with `go run ./cmd/genvectors` first.
- Reuse passed checks while their inputs, dependencies, configuration and
  relevant environment remain unchanged. Rerun checks affected by later edits;
  a new commit or status request alone does not require another full run.

## Protocol invariants

Envelope bytes stay `pairfob.v1` (`proto/envelope.md`, `proto/rpc.schema.json`,
`proto/pairfob-vectors.json`). Mux control is `pairfob.v2`
(`proto/envelope-v2.md`). HKDF info, AAD, Argon2id, DeviceHello and inner RPC
fields are frozen; `pair_loc` never enters SPAKE / Argon2. There is no `/v1/ws`
origin.

`GetConfig.capabilities` is a closed object (eleven required keys plus optional
ones such as `rename_file`, `delete_file` and `upload_file_v2`) and is the only
authority for which operations the phone shows. Mutations carry a fresh
`operation_id` and are never retried automatically; `unknown_outcome`
refreshes, it does not replay. Paths and cwd fail closed outside live snapshot
roots or `PAIRFOB_ALLOWED_ROOTS`.

## Durable Object duration diagnostics

`ROOM_DIAGNOSTICS_SAMPLE_RATE` (0–1, default 0) and an ISO8601
`ROOM_DIAGNOSTICS_UNTIL` must both be set to enable temporary message tracing.
Use a low production rate; traces stop automatically at the deadline. A sampled
`room_handler` emits matching `start` and `end`/`error` records with an opaque
object ID, event ID, header type, role, build, timestamps and elapsed milliseconds.
It does not decode payloads, log credentials, add timers, access storage or call
`waitUntil`. Synchronous handlers remain synchronous. These records measure
handler completion, not socket flush or Cloudflare's billable duration.
Cloudflare's event clock can stay fixed during synchronous execution, so a zero
`elapsed_ms` is not a precise CPU measurement; use the platform CPU metric.

`room_socket_close` records the numeric close code, cleanliness and an allowlisted
reason category; arbitrary peer text is `other`. `room_socket_error` records the
role without treating a non-disconnection error as a reason to close all peers.
Late-alarm logs include `ms`. Existing Analytics Engine counters remain available.

For a duration investigation, compare the **same object, deployment and time
window** in periodic DO metrics and invocation metrics. Periodic `duration` is
GB-s, while `activeTime` and `cpuTime` are microseconds. Hibernating inbound
messages are counted in invocations; periodic inbound zero is not evidence of
zero incoming messages. Do not sum event wall times to attribute billed duration.
An `end` marker preceding a long platform wall time is a lead for runtime
investigation, not by itself proof of a platform defect. Validate against an
isolated hibernating echo object with the same heartbeat cadence before changing
the protocol or promising savings.

## Releases

Cross-compile downloadable binaries with `./scripts/release.sh` (SemVer from
`git tag vX.Y.Z`). Pack the origin (including `/dl/` when `PAIRFOB_PACK_DL=1`)
with `scripts/pack-origin-assets.sh`.

### PWA UI-only release

Use the current local branch and checkout and compare against a known verified
release commit. Commit and push on that branch; do not create a release branch
or worktree unless explicitly requested:

```sh
(cd pwa && bun install --frozen-lockfile)
PAIRFOB_PACK_DL=1 ./scripts/verify.sh --pwa-only <verified-release-commit>
```

Set the origin's `BUILD` stamp before this command. The scope check includes
committed, staged, unstaged and untracked changes; it permits only PWA changes
and a BUILD-only origin config edit. Protocol files in `pwa/src/lib/protocol/`
require the full gate, as do backend, site, release-tooling or other changes.
Any protocol/cross-language behavior change needs the full gate regardless of
its location. Do not choose an unverified `HEAD` just to satisfy the scope
check.

This path retains all PWA tests, QA, typechecks, fresh builds and Worker
integration checks, while reusing the unchanged backend's prior verification.
It prints timings for each web stage. `dist/dl/` must contain the existing
shippable binaries; this command validates and packs them without rebuilding.
After success, deploy the packed tree directly with `wrangler deploy
--keep-vars` from `workers/pairfob-origin`; do not repeat the pack/docs build
if inputs have not changed. Verify the live BUILD and asset hashes before
declaring it live. The default full gate remains unchanged in coverage.
