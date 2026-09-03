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
| `scripts/release.sh` | cross-compile `dist/dl/pairfob-{os}-{arch}` + SHA256SUMS |

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
- The eleven `GetConfig.capabilities` keys are the authority for showing and
  allowing operations; do not invent aggregate aliases.
- Paths and cwd must land in a live snapshot root or `PAIRFOB_ALLOWED_ROOTS`;
  failures fail closed.
- The product loop is not a terminal emulator: read the rendered pane, send
  keys back to the PTY.

## Verify

After protocol or cross-language primitive changes, run `go run ./cmd/genvectors`
first if vectors would change, then:

```
(cd pwa && bun install)
./scripts/verify.sh
```

Go must be `gofmt`. PWA uses bun. Do not loosen schema or turn fail-closed into
guess-success to make tests pass.
