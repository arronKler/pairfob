# Pairfob agent notes

**Product, protocol, and scale are defined by this repo and `proto/`.** The
hosted data plane is `pairfob.v2` (Cloudflare Worker + one Durable Object per
`daemon_id`, origin `https://pairfob.com`). Envelope bytes stay `pairfob.v1`:
`proto/envelope.md`, `proto/rpc.schema.json`, `proto/pairfob-vectors.json`. Do
not change HKDF info, AAD, Argon2id, DeviceHello transcript, or inner RPC
fields. v2 only adds the mux control plane (`proto/envelope-v2.md`); `pair_loc`
never enters SPAKE / Argon2.

```
phone PWA --HTTPS/WSS pairfob.v2--> pairfob.com (Worker+R2)
                                      Worker /v2/ws → DaemonRoom DO
pairfob --outbound WSS--> that DO --opaque FWD-- the phone on the same DO
pairfob --loopback--> HarnessRuntime
```

The relay / DO is frame-level only and does not parse `FWD`. Identity and keys
live only on the daemon. Reads and writes require an `Established` session. The
product relay is `workers/pairfob-origin` (`pairfob.v2`). `https://pairfob.com`
is this project's official instance. User docs do not offer a self-hosted origin. The
`internal/mux` Hub is an in-process test stand-in, not a deployable origin.

## File size (hard limit)

**Each handwritten source file is at most 800 lines.** Applies to Go,
TypeScript, CSS, tests, and scripts. Excludes `node_modules/`, `pwa/dist/`,
generated output, and lockfiles.

The point is a clear project shape: split on duty, keep logic readable.

When changing code:

- Already over 800 lines: split by duty first, then change behavior. Do not
  keep stacking.
- About to go over 800: split in the same change. Do not leave a "finish then
  split" giant file.
- Do not pad the limit with dump files named `utils` / `helpers` / `misc` /
  `part2`.
- Do not dodge the limit by deleting blank lines, cramming comments, or shoving
  unrelated logic into another file that is already large.
- Tests and implementation stay in separate files; one test file covers one
  module or one family of behavior.
- After a split, each file should still read on its own: package comments or
  file headers only for non-obvious boundaries, never a changelog.

Split on **duty**, not line number. Prefer these seams:

| Layer | Split |
| --- | --- |
| `internal/daemon` | session handshake, RPC dispatch, concrete mutations (worktree / layout / keys / push), persistence |
| `internal/mux` | daemon register, pairing bind, session attach, FWD forward |
| `internal/runtime` | transport/fault, snapshot adapt, Herdr calls for each Command |
| `pwa/src/main.ts` | boot/pairing/SAS, dashboard, pane session, settings |
| `pwa/src/lib/protocol` | pairing handshake, session RPC, frame checks |
| `pwa/src/style.css` | by screen or control family, imported CSS sources, no copied selectors |

There are no over-limit files right now. Recheck with `wc -l` after edits; split
before continuing if a file went over.

`internal/runtime/herdr.go`, `internal/mux/hub.go`,
`pwa/src/lib/protocol/client.ts`, and `pwa/src/style.css` are already split by
duty. Herdr adapt lives in `herdr_observe.go` / `herdr_execute.go`, the session
screen in `pwa/src/ui/session/`, PWA styles in `pwa/src/styles/`.

Multiple files in one Go package is normal. After a TypeScript split, re-export
from the original module so imports do not churn.

## Directories

| Path | Duty |
| --- | --- |
| `cmd/pairfob` | outbound origin, pairing CLI, local Herdr |
| `workers/pairfob-origin` | the only relay: Worker + R2 + DaemonRoom DO (production and `wrangler dev`) |
| `cmd/genvectors` | generate `proto/pairfob-vectors.json` from the Go crypto |
| `internal/mux` | frame routing; does not touch FWD plaintext |
| `internal/daemon` | pairing, session, RPC, push, operation ledger |
| `internal/runtime` | Herdr adapt; Herdr method names must not cross the `Runtime` interface |
| `internal/envelope` `aeadfwd` `canon` `hkdfk` `spake2plus` `session` | protocol primitives |
| `pwa/src/lib/protocol` | browser protocol |
| `pwa/src/lib` | UI pure functions and DOM helpers; `main.ts` only orchestrates |
| `proto/` | frozen envelope, RPC schema, vectors, PGP words |
| `scripts/verify.sh` | format, vet, Go tests (including race), PWA tests, Worker origin tests, typecheck, production build |
| `scripts/install.sh` | one-line install of pairfob (checksum, enroll, user-level service) |
| `scripts/release.sh` | cross-compile SemVer `dist/dl/pairfob-{os}-{arch}` + SHA256SUMS (`git tag vX.Y.Z`) |
| `scripts/site-shots.ts` | render the homepage product stills `site/img/home/{en,zh}` from the `pwa/qa` fixtures; rerun after PWA screen changes |

Put new code in an existing module. Add `internal/<name>` only when no current
package can express that duty.

## Implementation constraints

- Crypto and envelope bytes stay `pairfob.v1` (header `version=0x01`). The only
  mux subprotocol is `pairfob.v2`. Canonical bytes, Argon2id, SPAKE2+, HKDF
  info, and DeviceHello follow `proto/` (especially `pairfob-vectors.json`) and
  the Go/TS implementations; both ends must be bit-identical. Mux JSON `"v":2`
  is in `proto/envelope-v2.md`. Do not implement a `/v1/ws` origin again.
- Public paths are default-deny. Do not trust a client-claimed `device_id`, and
  do not expose the Herdr HTTP/Unix socket to the relay.
- Mutations carry a fresh `operation_id` and are not retried automatically;
  `unknown_outcome` only refreshes, never replays.
- The `GetConfig.capabilities` keys are the authority for showing and
  allowing operations; do not invent aggregate aliases. `rename_file` and
  `delete_file` advertise workspace file mutations; absence on older daemons means false.
- `link_machine` advertises machine linking (`proto/machine-link.md`). A linked
  machine keeps its own daemon identity; never proxy its panes or hold its keys
  on the linking computer, and never send an SSH target to a paired device.
- Paths and cwd must land in a live snapshot root or `PAIRFOB_ALLOWED_ROOTS`;
  failures fail closed.
- The product loop is not a terminal emulator: read the rendered pane, send
  keys back to the PTY.

## Branch and release workflow

Commit, push and deploy from the user's current local branch and checkout.
Do not create a release branch or a separate worktree unless the user explicitly
requests one. Preserve unrelated working changes and stage only the authorized
scope. If edits continue during verification, compare source snapshots before
publishing rather than moving the work to another branch. Push to the current
branch's configured upstream; do not force-push.

## Verify

Choose verification by **change scope and task stage**. Do not run the full
repository gate after every local edit or merely because a task is ending.

| Change / stage | Required verification |
| --- | --- |
| Documentation or copy-only edit | Check the diff, links and affected rendering as relevant; no unrelated code suites. |
| Local implementation iteration | Run affected module tests and relevant type/format checks. For shared code, include its affected consumers. |
| UI behavior or layout change | Add focused browser checks for the changed interaction or viewport; fixtures, live transport and physical-device acceptance are distinct. |
| Agent transcript adapter (`internal/journal`) or an agent CLI upgrade | Run `PAIRFOB_SCAN_LOCAL_TRANSCRIPTS=1 go test ./internal/journal -run LocalTranscripts -v` on a machine with real Claude Code / Codex / Grok / Pi sessions; a hit is injected context leaking into chat. |
| PWA UI-only production release | Run `PAIRFOB_PACK_DL=1 ./scripts/verify.sh --pwa-only <verified-release-commit>` against a trustworthy baseline in the current checkout. |
| Backend, protocol, cross-module contract or release-tooling delivery | Run the full `./scripts/verify.sh` once on the final candidate before handoff/merge/release. Use focused checks during iteration. |
| Production release outside the guarded PWA-only scope, or without a trustworthy baseline | Run the full gate on the final release candidate. |

For ordinary non-release changes, submitting a commit or PR does not itself
require unrelated full-repository tests. Finish the checks appropriate to the
actual change. Escalate when dependencies or failures show broader impact; if
scope cannot be established, use the full gate and state why.

Reuse a passed check when its source inputs, dependencies, configuration and
relevant environment are unchanged. A new commit ID or a request to report
status is not a reason to rerun it. After further edits, rerun affected checks;
repeat the full gate only when those edits invalidate the required full-gate
evidence. Before release, confirm the final source and packed artifacts match
the verified snapshot. Never treat a partial/failed run as a passed full gate.
Report what was checked and any remaining acceptance gaps.

After protocol or cross-language primitive changes, regenerate vectors with
`go run ./cmd/genvectors` if they would change, then run the full gate on the
final candidate:

```
(cd pwa && bun install --frozen-lockfile)
./scripts/verify.sh
```

Go must be `gofmt`. PWA uses bun. Do not loosen schema or turn fail-closed into
guess-success to make tests pass.
