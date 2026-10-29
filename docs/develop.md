# Developing Pairfob

This page holds the contributor and maintainer detail that used to live in the
README: running the stack locally, testing on a real phone, verification, and
releases. Agent-facing rules live in [`AGENTS.md`](../AGENTS.md).

## Local stack

Install the lockfiles the gate uses, once:

```sh
(cd pwa && bun install --frozen-lockfile)
(cd workers/pairfob-origin && bun install --frozen-lockfile)
(cd site/doc && bun install --frozen-lockfile)
```

Local Worker tests run against the in-repo harness.

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

With demo data, the origin is up when `http://127.0.0.1:18786/v2/health`
returns `{"ok":true,"protocol":2}`. The app is `http://127.0.0.1:18786/pair`.
Daemon commands use the binary and state directory `dev-up` created:

```sh
PAIRFOB_STATE_DIR="$PWD/.dev/state" .dev/pairfob list
```

Run `pair offer` in a persistent terminal and leave its stdin open until
pairing completes:

```sh
PAIRFOB_STATE_DIR="$PWD/.dev/state" .dev/pairfob pair offer
```

The command prints one JSON line containing `pair_url`, then waits. Opening
that URL pairs the browser; after the page proves the code, the same process
accepts the device. Closing stdin is the operator walking away, so the command
denies the slot as soon as it has printed `pair_url`. An agent shell that
closes stdin does that: the URL is already cancelled, and opening it cannot
pair the browser. If a previous copy is still recorded under `.dev/*.pid`, run
`./scripts/dev-down.sh` before starting another one.

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

### Herdr install and upgrade in Docker

`scripts/herdr-docker/` exercises the installer against the real official Herdr
downloads on Linux: clean install, upgrade from an older release, TTY restart
confirmation, and the full repository gate with the host checkout read-only.

```sh
# Install, upgrade and regression tests.
docker build -t pairfob-herdr-test -f scripts/herdr-docker/Dockerfile .
docker run --rm -v "$PWD:/src:ro" \
  -v pairfob-herdr-gomod:/go/pkg/mod \
  -v pairfob-herdr-gocache:/root/.cache/go-build pairfob-herdr-test

# Full repository gate inside Docker.
docker build -t pairfob-herdr-full -f scripts/herdr-docker/Dockerfile.full .
docker run --rm -v "$PWD:/src:ro" \
  -v pairfob-herdr-gomod:/go/pkg/mod \
  -v pairfob-herdr-gocache:/cache pairfob-herdr-full
```

The live chain (PWA protocol client → local Worker → Pairfob in Docker → real
Herdr) needs a local Worker at an address both the host and the container can
reach, such as the host's LAN IP. Never point it at the production origin. From
`workers/pairfob-origin`:

```sh
bunx wrangler d1 migrations apply DB --local --persist-to /tmp/pairfob-herdr-worker
bunx wrangler dev --local --ip 0.0.0.0 --port 18786 --persist-to /tmp/pairfob-herdr-worker
```

Then, from the repository root, run `PAIRFOB_TEST_ORIGIN=http://HOST_IP:18786
scripts/herdr-docker/live.sh`. With Vite serving the PWA on port 5180,
`ego-browser nodejs < scripts/herdr-docker/browser-qa.mjs` drives the page with
real input.

## Protocol invariants

Envelope bytes stay `pairfob.v1` (`proto/envelope.md`, `proto/rpc.schema.json`,
`proto/pairfob-vectors.json`). Mux control is `pairfob.v2`
(`proto/envelope-v2.md`). HKDF info, AAD, Argon2id, DeviceHello and inner RPC
fields are frozen; `pair_loc` never enters SPAKE / Argon2. There is no `/v1/ws`
origin.

`GetConfig.capabilities` is the only authority for which operations the phone
shows. Keys are additive: a known key must be a boolean, and a key this build
does not know is ignored, so a packaged client (the Android shell bundles its
page) keeps working against a daemon that advertises more. Mutations carry a
fresh `operation_id` and are never retried automatically; `unknown_outcome`
refreshes, it does not replay. Paths and cwd fail closed outside live snapshot
roots or `PAIRFOB_ALLOWED_ROOTS`.

## Durable Object duration diagnostics

Use Cloudflare invocation logs and periodic Durable Object metrics, together
with the existing Analytics Engine counters. The production room does not
include temporary per-message or lifecycle trace hooks. Close reasons passed
to application metrics remain allowlisted; arbitrary peer text is `other`.

For a duration investigation, compare the **same object, deployment and time
window** in periodic DO metrics and invocation metrics. Periodic `duration` is
GB-s, while `activeTime` and `cpuTime` are microseconds. Hibernating inbound
messages are counted in invocations; periodic inbound zero is not evidence of
zero incoming messages. Do not sum event wall times to attribute billed duration.
A long platform wall time is not by itself proof of a platform defect or of
client-visible latency. Correlate client RTT and an isolated hibernating echo
object with the same heartbeat cadence before changing the protocol or
promising savings.

## Releases

### GitHub Releases and downloadable binaries

[GitHub Releases](https://github.com/arronKler/pairfob/releases) publishes
versioned daemon downloads and release notes. A pushed tag alone does not
create a Release. The first GitHub Release is `v1.3.8`, backfilled from the
existing official downloads; earlier versions remain available as Git tags.
The hosted PWA can advance independently of the daemon version.

For a new daemon version, use the current branch and checkout. Finish and
commit the intended changes, including `version = "X.Y.Z"` in
`herdr-plugin.toml` and its assertion in `plugin/herdr/plugin.test.ts`,
choose an unused `vX.Y.Z` tag, and build once
from a clean tree with `VERSION=vX.Y.Z ./scripts/release.sh`. Run the full
`./scripts/verify.sh` gate on that candidate before publishing. Daemon releases
use `scripts/publish-daemon.sh`; they do not pack or deploy the relay. Preserve the verified source and
artifact snapshot; subsequent edits require the affected checks again.

#### macOS signing and privacy permissions

Build and publish daemon releases on macOS with the release team's **Developer
ID Application** certificate and private key installed. Before `release.sh`:

```sh
export PAIRFOB_MACOS_TEAM_ID=YOURTEAMID
export PAIRFOB_MACOS_SIGN_IDENTITY='Developer ID Application: Your Name (YOURTEAMID)'
VERSION=vX.Y.Z ./scripts/release.sh
```

Keep the same Team ID and code identifier (`com.pairfob.daemon`) across releases.
The builder signs both Darwin architectures with a timestamp and hardened
runtime **before** calculating SHA256SUMS. Darwin builds enable CGO and link
the macOS Security framework for non-interactive Keychain reads; Xcode Command
Line Tools and its macOS SDK are required. Both Darwin architectures target
macOS 12.0 (Go 1.26's minimum), rather than inheriting the build Mac's deployment
target. Linux binaries remain CGO-free. The daemon publisher requires
`PAIRFOB_MACOS_TEAM_ID` and verifies both signatures before touching the download
channels. It rejects ad-hoc signatures, the wrong team/identifier, and designated
requirements pinned to a binary hash. Signing does not grant privacy permissions
or constitute Apple notarization; notarization is a separate distribution step.
See [Apple's distribution signing instructions](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/).

For a release without a certificate, explicitly enable the no-certificate mode
on a Mac with Xcode Command Line Tools for both building and publishing:

```sh
PAIRFOB_ALLOW_UNSIGNED_MACOS=1 VERSION=vX.Y.Z ./scripts/release.sh
PAIRFOB_ALLOW_UNSIGNED_MACOS=1 ./scripts/publish-daemon.sh --source dist/daemon --deploy
```

This mode applies and verifies ad-hoc signatures with `com.pairfob.daemon` on both
Darwin architectures before hashing or touching the download channels. It needs
no Team ID or certificate. Ad-hoc signing checks executable integrity, provides
no publisher identity, and is not notarization. These builds may lose privacy
grants after updates. The default mode still requires Developer ID signing. Do not re-sign an installed daemon
in place as a workaround: its published checksum would no longer match.

The CLI and remote updater verify the staged Darwin candidate before replacement
or execution. A signed installed image requires the same Team ID, code identifier,
and its original designated requirement. HTTPS updates of old unsigned/ad-hoc
images accept a valid ad-hoc candidate with `com.pairfob.daemon`, or migrate to a
valid Developer ID candidate with the same identifier. Both paths trust the
existing HTTPS/checksum channel; the first Developer ID migration establishes
the team for subsequent updates. A Developer ID installation rejects an ad-hoc
candidate even when no-certificate publication was explicitly enabled. Only
unsigned/ad-hoc development installs updated from an HTTP loopback server can
use unsigned fixtures. That exception never applies to a signed installed image.

A daemon installed by the user-level service also self-updates patch releases.
Every six hours it reads `https://dl.pairfob.com/daemon/VERSION` and installs a
target in the same major.minor after that target has stayed current for the
soak window (`PAIRFOB_AUTO_UPDATE_SOAK`, default `12h`), and only while no RPC
has arrived for a minute. Each target is attempted once, so a release that
fails to install waits for the next version instead of retrying. Set
`PAIRFOB_AUTO_UPDATE=0` to turn the loop off; updating from the app keeps
working either way.

Moving from an old ad-hoc build to the signed identity can require one new user
grant. Stable signing preserves identity across subsequent updates; it does not
turn macOS process-lifetime app-container consent into permanent access. Test
that boundary on a Mac without Full Disk Access: select a concrete project,
restart the daemon, then upgrade to another build signed by the same team.
Check directory consent separately from app-container and Keychain prompts.

Privacy acceptance on a disposable macOS account (do not reset an operator's TCC):

1. Deny a quota Keychain prompt through the explicit local authorize command.
   Refresh from two clients: expect `allow_keychain`, a paused doctor record,
   and zero background prompts. Test a locked Keychain separately; the native
   non-interactive API cannot always distinguish locking from missing consent.
2. Grant access through the same installed executable, then retry. Check both
   an Allow-once and an Always-Allow choice. No credential may reach CLI output,
   the admin response, logs, or a phone response.
3. Restart, lock/unlock, and sleep/wake. Reads may require local action again,
   but ordinary quota refresh must not display Keychain UI.
4. Upgrade between two builds signed by the same team and identifier; check
   retained file grants. Reject an ad-hoc, wrong-team, wrong-identifier, modified,
   or incompatible-requirement candidate before execution and replacement.
5. With `PAIRFOB_QUOTA_PROVIDERS=codex`, confirm disabled sources are not touched.
   With `none` or an invalid list, confirm no provider discovery occurs.

`PAIRFOB_TEST_KEYCHAIN=1 go test ./internal/runtime -run QuotaKeychainNativeQuery`
checks a nonexistent item without reading real credentials or requesting UI.
This smoke test does not substitute for the interactive acceptance above.

On macOS, workspace-wide search and Git discovery do not scan HOME or its
ancestors. File browsing and explicit file operations still work there; use a
specific project cwd for recursive search and Git review. This also avoids a
home-directory dotfiles repository causing Git to inspect personal folders.
This policy is not a replacement for workspace root authorization or macOS TCC.

Version numbers default to a patch bump: fixes and features both ship as
`vX.Y.(Z+1)`. Bump the minor only for a deliberate named milestone release and
the major only for a backward-incompatible change. Keep all three components;
the daemon and PWA updaters only order versions of equal length.

After verification, tag that exact commit and push the current branch to its
configured upstream, then push the tag to the same remote. Upload all six
files from the verified `dist/daemon/` directory; these are also the files served
at `https://dl.pairfob.com/daemon/`. Write reviewed release notes to a file outside
the working tree, including changes, requirements and upgrade instructions.
For example, replacing `vX.Y.Z` with the chosen version:

```sh
gh release create vX.Y.Z \
  dist/daemon/pairfob-darwin-amd64 dist/daemon/pairfob-darwin-arm64 \
  dist/daemon/pairfob-linux-amd64 dist/daemon/pairfob-linux-arm64 \
  dist/daemon/VERSION dist/daemon/SHA256SUMS \
  --repo arronKler/pairfob --verify-tag --draft \
  --title "Pairfob vX.Y.Z" --notes-file /tmp/pairfob-release-notes.md
```

Before publishing, download the draft's assets to a fresh directory with
`gh release download`, check every file against `SHA256SUMS`, and confirm
that `VERSION` matches the tag. Inspect all four binaries with
`go version -m`: their `vcs.revision` must match the tagged commit,
`vcs.modified` must be `false`, and their OS/architecture must match their
filenames. Check the native binary's `version` output as well. Then publish:

```sh
gh release edit vX.Y.Z --repo arronKler/pairfob --verify-tag --draft=false --latest
```

Confirm the public Release has all six assets and is the latest stable
release. Do not overwrite published assets or move a released tag; corrections
to binaries need a new version. GitHub publication does not update the download Worker. After checking the
GitHub assets, publish the same directory with:

```sh
./scripts/publish-daemon.sh --source dist/daemon --deploy
```

The download Worker serves `/daemon/VERSION`, `/daemon/SHA256SUMS`, the four
binaries and `/install.sh`. It also owns the legacy `pairfob.com/dl/` daemon
URLs and `pairfob.com/install.sh` through narrow Cloudflare routes. Old clients
and the PWA's same-origin version check keep working without redirects or a
relay deployment. New daemons download directly from `dl.pairfob.com`.

Both release publishers lock the shared download deployment, hydrate the other
channel from its live, hash-checked inventory, and reject a changed inventory
before deployment. A fresh checkout must not publish only its local channel.
Daemon build output is `dist/daemon`; Android staging remains `dist/dl/android`.
The historical `PAIRFOB_PACK_DL=1` origin pack is a legacy snapshot mechanism,
not the daemon publication path.

`.goreleaser.yaml` remains an
optional build configuration with publishing disabled; this workflow uses
`scripts/release.sh` so GitHub and the official site share identical artifacts.

When backfilling an already hosted version, reuse its exact artifacts after
checking the official checksums, version, clean build metadata and remote tag.
Do not rebuild it from a newer or dirty checkout. Record this as artifact
verification, not a new full test run.

### PWA performance and asset continuity

`bun run build` in `pwa/` emits a hashed dependency graph alongside the app.
The service worker caches the startup dependency closure, then each visited
feature's static dependencies and CSS. It publishes a new cached HTML shell
only after that shell's startup assets are available. Unvisited features still
require connectivity; downloading the connected UI precedes consuming a
one-use pairing ticket.
Browsers can retain a failed module import until navigation. An interrupted
feature download therefore asks for an explicit page refresh instead of an
automatic reload loop; saved credentials remain in place.

`bun run perf:budget` checks the complete static startup graph against gzip
budgets of 250,000 bytes of JavaScript and 25,000 bytes of CSS. The web gate
runs this check. Use `--report=<path>` to retain its per-asset measurements.
Local `performance` marks with the `pairfob:` prefix expose boot, connected
module readiness, session establishment and first session data/completed terminal write;
they contain no session content and are not uploaded. Compare cold and warm
loads separately, and do not substitute laboratory interaction samples for
field INP or physical-device acceptance.

Before packing a release on a fresh checkout, capture the currently hosted
assets and use that snapshot as the previous generation:

```sh
bun scripts/snapshot-pwa-assets.ts https://pairfob.com /tmp/pairfob-hosted-assets
PAIRFOB_PREVIOUS_ASSETS=/tmp/pairfob-hosted-assets ./scripts/verify.sh
```

Packing retains two prior generations of hashed assets, so existing tabs can
still download their deferred features after deployment. Without the explicit
snapshot, packing uses the existing `public-dist/` as its previous generation.
Retained files are checked for missing dependencies and hash-name collisions;
do not deploy a fresh pack without a trustworthy previous generation. The
internal Vite manifest remains in `pwa/dist/` for measurement and is excluded
from the public tree.

Cross-compile daemon binaries with `./scripts/release.sh` (SemVer from
`git tag vX.Y.Z`) and publish them with `scripts/publish-daemon.sh`.
PWA/site assets are packed separately with `scripts/pack-origin-assets.sh`.

### PWA UI-only release

Use the current local branch and checkout and compare against a known verified
release commit. Commit and push on that branch; do not create a release branch
or worktree unless explicitly requested:

```sh
(cd pwa && bun install --frozen-lockfile)
./scripts/verify.sh --pwa-only <verified-release-commit>
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
It prints timings for each web stage. Daemon binaries are published separately
by the download Worker and are not required for a PWA-only pack.
After success, deploy the packed tree directly with `wrangler deploy
--keep-vars` from `workers/pairfob-origin`; do not repeat the pack/docs build
if inputs have not changed. Verify the live BUILD and asset hashes before
declaring it live. The default full gate remains unchanged in coverage.
