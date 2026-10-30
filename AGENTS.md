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

**Each handwritten source file is at most 800 lines.** Applies to Go, Rust,
TypeScript, CSS, tests, and scripts. Excludes `node_modules/`, `pwa/dist/`,
`desktop/target/`, generated output, and lockfiles.

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
| `pwa/src/features/<domain>` | one subdirectory per screen part or flow (session: `chat/`, `full-terminal/`, `keypad/`, `attachments/`, …) |
| `pwa/src/lib/protocol` | pairing handshake, session RPC, frame checks |
| `pwa/src/style.scss` | by screen or control family in `pwa/src/styles/` and next to the feature, no copied selectors |

Recheck with `wc -l` after edits; split before continuing if a file went over.

`internal/runtime/herdr.go`, `internal/mux/hub.go`,
`pwa/src/lib/protocol/client.ts`, and `pwa/src/style.scss` are already split by
duty. Herdr adapt lives in `herdr_observe.go` / `herdr_execute.go`, the session
screen in `pwa/src/features/session/`, PWA styles in `pwa/src/styles/`.

Multiple files in one Go package is normal. After a TypeScript split, re-export
from the original module so imports do not churn.

## Directories

| Path | Duty |
| --- | --- |
| `cmd/pairfob` | outbound origin, pairing CLI, local Herdr |
| `desktop` | native window over the local Herdr session (Rust + GPUI); attaches to `herdr-client.sock`, never owns a PTY |
| `workers/pairfob-origin` | the only relay: Worker + R2 + DaemonRoom DO (production and `wrangler dev`) |
| `workers/pairfob-downloads` | daemon, Android and desktop artifacts at `dl.pairfob.com`; owns legacy daemon download/install routes independently of the relay |
| `cmd/genvectors` | generate `proto/pairfob-vectors.json` from the Go crypto |
| `internal/mux` | frame routing; does not touch FWD plaintext |
| `internal/daemon` | pairing, session, RPC, push, operation ledger |
| `internal/runtime` | Herdr adapt; Herdr method names must not cross the `Runtime` interface |
| `internal/envelope` `internal/crypto/*` | protocol primitives (AEAD, canon, HKDF, SPAKE2+, session keys, PGP words) |
| `internal/workspace` | bounded views and file operations inside a live workspace root |
| `internal/journal` | agent transcript adapters (Claude Code, Codex, Grok, Pi, Prime Agent, Cursor, Hermes, opencode) |
| `internal/state` `admin` `audit` | durable identity and devices, local operator socket, security audit log |
| `internal/phone` | Go phone client for daemon end-to-end tests only |
| `pwa/src/app` | boot, lifecycle, layout, width tier and input mode; `main.ts` only calls `startApplication` |
| `pwa/src/pages` | per-route bridges between application state and features |
| `pwa/src/features/<domain>` | screens and flows; import rules in `src/architecture-boundaries.test.ts` and `features/layer-boundaries.test.ts` |
| `pwa/src/shared` | UI primitives and models with no page, store or protocol imports (`shared/ui/README.md`) |
| `pwa/src/lib` | pure functions, i18n strings, codecs |
| `pwa/src/lib/protocol` | browser protocol |
| `pwa/qa` | fixture scenes for browser checks and site stills |
| `proto/` | frozen envelope, RPC schema, vectors, PGP words; per-feature protocol notes (`agent-*`, `workspace-*`, `machine-link`, …) |
| `site/` `site/doc` | homepage and VitePress docs, packed into the Worker by `scripts/pack-origin-assets.sh` |
| `herdr-plugin.toml` `plugin/herdr` | Herdr plugin listing and its pane scripts |
| `scripts/verify.sh` | format, vet, Go tests (including race), PWA tests, Worker origin tests, typecheck, production build |
| `scripts/verify-web.sh` `scripts/verify-android.sh` | the web and APK halves of the gate, run through `scripts/verify.sh --pwa-only` / `--android-only` after its scope check |
| `scripts/pwa-release-scope.ts` `scripts/android-release-scope.ts` | refuse a scoped release whose changes left that scope |
| `scripts/install.sh` | one-line install of pairfob (checksum, enroll, user-level service) |
| `scripts/release.sh` | cross-compile SemVer `dist/daemon/pairfob-{os}-{arch}` + SHA256SUMS (`git tag vX.Y.Z`) |
| `scripts/publish-daemon.sh` | publish verified daemon artifacts through the download Worker while preserving the live Android channel |
| `scripts/release-desktop.sh` | build SemVer `dist/desktop/pairfob-desktop-{os}-{arch}` for the host or named Rust targets |
| `scripts/publish-desktop.sh` | publish verified desktop artifacts through the download Worker while preserving the daemon and Android channels |
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
- The daemon self-updates patch releases within its own major.minor. It reads
  `https://dl.pairfob.com/daemon/VERSION` six-hourly, installs a target only
  after it has stayed current for the soak window (`PAIRFOB_AUTO_UPDATE_SOAK`,
  default 12h), only when no RPC has arrived for 60s, and attempts each target
  once. `PAIRFOB_AUTO_UPDATE=0` disables it; `DaemonUpdate` remains the manual
  path.
- The `GetConfig.capabilities` keys are the authority for showing and
  allowing operations; do not invent aggregate aliases. `rename_file` and
  `delete_file` advertise workspace file mutations; `download_file` advertises
  the P2P-only chunked file download (`proto/workspace-download.md`); absence on
  older daemons means false.
- `link_machine` advertises machine linking (`proto/machine-link.md`). A linked
  machine keeps its own daemon identity; never proxy its panes or hold its keys
  on the linking computer, and never send an SSH target to a paired device.
- Paths and cwd must land in a live snapshot root or `PAIRFOB_ALLOWED_ROOTS`;
  failures fail closed.
- The product loop is not a terminal emulator: read the rendered pane, send
  keys back to the PTY.

## PWA: one app, three surfaces

The PWA is used on a phone, on a tablet and in a desktop browser. They are one
codebase and one set of screens, laid out by two independent questions. A UI
change that is right on one surface is not done until the other two are
checked.

**Width decides the layout** (`pwa/src/shared/ui/dom/width-tier.ts`,
re-exported from `app/viewport.ts`):

| Window | Layout |
| --- | --- |
| under 720px | Phone: one screen at a time, tab bar at the bottom |
| 720–899px | The list stays beside the session; files and the board take the whole page |
| 900–1199px | Files and changes open beside the session, and the list gives way while they are open |
| 1200px and up | List, session, files and changes side by side |

A phone on its side keeps the phone layout below 900px (`handheld()` reads the
screen's short side, not the window).

**Input decides the interaction** (`pwa/src/app/input-mode.ts`,
`shared/ui/overlay/popover.ts`): a mouse gets hover actions, right-click menus,
popovers at the trigger and dialogs as cards; a finger gets swipes, long press,
bottom sheets and 44px targets; a hardware keyboard, proven by its first
physical key, gets Enter-to-send, F6 between columns and typing without a
click.

The two axes do not imply each other. A landscape tablet is a wide layout
driven by touch, a narrow laptop window is a phone layout driven by a mouse,
and a tablet may gain or lose a keyboard mid-session. So:

- Do not read width to decide an interaction, or the pointer to decide a
  layout. Ask the helper that owns the question.
- Do not write "desktop" or "phone" as a single condition. Name the tier or
  the input the rule is about.
- A field must not take focus by itself under a finger unless the screen exists
  to type into it: focus there raises the on-screen keyboard.
- Whatever changes the complete terminal's box resizes the program on the
  computer. Notices, side columns and drafts must float or pan, not take rows.
- Shared pieces (sheets, popovers, forms, the compose field, the send and stop
  button) serve all three surfaces. Changing one for a surface changes it for
  the others unless the change is behind the right helper.

## Branch and release workflow

Commit, push and deploy from the user's current local branch and checkout.
Do not create a release branch or a separate worktree unless the user explicitly
requests one. Preserve unrelated working changes and stage only the authorized
scope. If edits continue during verification, compare source snapshots before
publishing rather than moving the work to another branch. Push to the current
branch's configured upstream; do not force-push.

Daemon releases stay three-part SemVer `vX.Y.Z`: never drop a component, since
the daemon and PWA updaters refuse to order versions of different lengths.
Version bumps default to the patch: fixes and features both ship as
`vX.Y.(Z+1)`. Bump the minor only for a deliberate named milestone release, and
the major only for a backward-incompatible change. A release commit carries the
matching `herdr-plugin.toml` version and its `plugin/herdr/plugin.test.ts`
assertion.

Daemon artifacts publish with `scripts/publish-daemon.sh`, independently of
the relay. The shared download Worker also serves Android and the desktop
channel; use the channel publishers so a fresh checkout restores and verifies
the other live channels before deployment. Desktop builds are per platform:
`scripts/release-desktop.sh` builds the host or named Rust targets, and a new
version must include every platform the live desktop channel carries. Initial
migration publishes the daemon channel before the updated Android publisher can
deploy. The legacy origin binary pack is not the daemon publication path.

## Verify

Choose verification by **change scope and task stage**. Do not run the full
repository gate after every local edit or merely because a task is ending.

| Change / stage | Required verification |
| --- | --- |
| Documentation or copy-only edit | Check the diff, links and affected rendering as relevant; no unrelated code suites. |
| Local implementation iteration | Run affected module tests and relevant type/format checks. For shared code, include its affected consumers. |
| UI behavior or layout change | Add focused browser checks for the changed interaction, on each surface it can reach: a phone with touch (390x844), a tablet with touch (about 1024x768, and 820 wide for the 720–899 tier when the change touches layout), and a desktop with a mouse and keyboard (1440x900). Shared components and anything keyed on width or input reach all three. Drive them with real touch and mouse input through the `pwa/qa` scenes; a unit test at one width does not cover the others. Fixtures, live transport and physical-device acceptance are distinct. |
| Agent transcript adapter (`internal/journal`) or an agent CLI upgrade | Run `PAIRFOB_SCAN_LOCAL_TRANSCRIPTS=1 go test ./internal/journal -run LocalTranscripts -v` on a machine with real Claude Code / Codex / Grok / Pi / Prime Agent / Cursor / Hermes / opencode sessions; a hit is injected context leaking into chat. |
| PWA UI-only production release | Run `./scripts/verify.sh --pwa-only <verified-release-commit>` against a trustworthy baseline in the current checkout. |
| Desktop client change | Run `bash scripts/verify-desktop.sh`. Engine, input or lifecycle changes also run `PF_DESKTOP_LIVE=1 cargo test --test live -- --ignored` against a running `pffixture` session. A UI change is not verified until the window has been seen on the surfaces it reaches; say which ones you could not open. |
| Android shell / APK-only production release | Run `./scripts/verify.sh --android-only <verified-release-commit>` against a trustworthy baseline. It covers the bundled PWA, the download channel publisher and the APK provenance checks, and refuses changes to the protocol client, daemon, relay, release scripts or anything beyond the two version literals in `mobile/android/app/build.gradle`. |
| Backend, protocol, cross-module contract or release-tooling delivery | Run the full `./scripts/verify.sh` once on the final candidate before handoff/merge/release. Use focused checks during iteration. |
| Production release outside both guarded scopes, or without a trustworthy baseline | Run the full gate on the final release candidate. |

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

## Cursor Cloud specific instructions

Go 1.26.9 is already on the image. The environment install script puts Bun
1.4.3 on `/usr/local/bin` and runs the frozen installs in
[`docs/develop.md`](docs/develop.md#local-stack), then `go mod download`.
Login shells do not need `~/.bashrc` for Bun.

`start` runs `./scripts/dev-up.sh` with `PAIRFOB_DEV_FAKE_RUNTIME=1` because
Herdr is not on the image. It rebuilds the PWA for the checked-out branch and
keeps the process alive while the origin and daemon are up. When
`http://127.0.0.1:18786/v2/health` already returns `{"ok":true,"protocol":2}`,
a second start exits without rebuilding. The app, state directory, and
`pair offer` flow are in [`docs/develop.md`](docs/develop.md#local-stack).
