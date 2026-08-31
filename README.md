# Pairfob

Phone surface for a [Herdr](https://herdr.dev) agent herd: the same live
sessions on computer and phone. Pairing code, outbound daemon, no Tailscale.
Pairfob is not an official Herdr product.

`https://pairfob.com` is this project's official instance (Cloudflare Worker +
one Durable Object per `daemon_id`). There is no account and no capacity
promise. New computer setup can close; already-enrolled computers keep working.

The relay is `pairfob.v2`. Envelope bytes stay `pairfob.v1`; see
`proto/envelope.md`, `proto/envelope-v2.md`, and `proto/pairfob-vectors.json`.
Local pairing uses the same Worker via `./scripts/dev-up.sh`.

The origin serves the PWA and forwards opaque binary envelopes. `pairfob`
keeps the device credentials and end-to-end keys, connects outbound, and is
the only process that talks to the Herdr Unix socket. The origin cannot read
terminal content or RPC payloads.

## Verify

```
(cd pwa && bun install)
./scripts/verify.sh
```

The verification script runs formatting and JSON checks, `go vet`, ordinary and
race-enabled Go tests, PWA tests, hosted origin unit/e2e tests (including workerd
enroll+HELLO), strict TypeScript checking, and a production Vite build.

## Official instance (pairfob.v2)

The official instance is `https://pairfob.com` (Cloudflare Worker + one Durable
Object per `daemon_id`). One `pairfob` process talks to one origin. There is no
Go relay process. First enroll is `curl | sh` with no install code.
`PAIRFOB_JOIN_TOKEN` is always rejected. The official origin defaults to
`https://pairfob.com`. The phone uses the same PWA dist; `GET /api/config`
returns `{protocol:2, build}`. The official instance has no fixed concurrent-connection
target; operational load checks protect mux behavior and cost regressions
rather than certify a capacity claim. Closing new setup (`SIGNUP_OPEN=0` /
`ENROLL_OPEN=0`) is a cost valve: already-enrolled computers keep working.

```
# user machine (macOS / Linux):
curl -fsSL https://pairfob.com/install.sh | sh
```

That installs `pairfob` to `/usr/local/bin` or `~/.local/bin`, adds `pairfobd`
as a compatibility alias, enrolls, and installs a user LaunchAgent / systemd
--user unit. Before enroll/rekey,
`pairfob` journals the client-minted replacement credential so an uncertain
HTTP outcome resumes the exact same operation. Later starts reuse `relay.json`.
A second computer runs the same installer, then pairs from the phone.

From a source checkout, `go run ./cmd/pairfob` is enough; `PAIRFOB_ORIGIN` and
`PAIRFOB_RELAY_WS` are optional against the official instance. In a terminal on
the computer, start the complete interactive pairing flow:

```
pairfob pair
```

It leads with a QR and keeps one manual pairing code as the fallback. After the
phone proves the code, the computer asks for one Enter confirmation.

Build downloadable binaries with `./scripts/release.sh` (writes `dist/dl/` plus
`SHA256SUMS`). Pack `install.sh` onto the origin with `scripts/pack-origin-assets.sh`.
A production origin that should serve the binaries also sets `PAIRFOB_PACK_DL=1`
before packing (files land at `/dl/`). `pairfob update` pulls those artifacts.

Hand entry on the official instance is one combined code (8 secret glyphs + 6 routing glyphs).
The PWA splits it locally: the last 6 glyphs are only a locator and never enter
SPAKE / Argon2. QR uses `d` and `r` and does not put the locator on the WebSocket
URL. `pairfob doctor` probes which mux protocol this process is on.

## Local test (real pairing in the browser)

```
./scripts/dev-up.sh     # Worker origin + pairfob + PWA on loopback
./scripts/dev-down.sh   # stop
```

This is the same `workers/pairfob-origin` as production, via `wrangler dev`.
It enrolls `pairfob` against the local origin and serves the PWA at `/pair`.

1. 在电脑执行 `dev-up.sh` 打印的 `pairfob pair`（带上同一个 `PAIRFOB_STATE_DIR`），它会优先展示二维码，并保留配对码作为兜底。
2. 打开 PWA `http://127.0.0.1:18786/pair`，扫码会直接开始；无法扫码时，展开「输入配对码」再连接。
3. 电脑出现手机已验证提示后，直接按 Enter。手机会自动进入已连接状态。
4. 进入「需要你」。点一张卡片，打开的是你电脑上 Herdr 里那个真实会话。

`./scripts/dev-up.sh` 默认连本机 Herdr。点对话框、打字、回车都会进那个 pane。
只有显式设置 `PAIRFOB_DEV_FAKE_RUNTIME=1` 才走内置演示数据。默认单会话下，
`pairfob` 发现没有 Herdr socket 时会用已安装的 CLI 无感启动持久 Herdr server；
用户之后运行普通 `herdr` 会附着到同一个 server。启动失败时 RPC 会报
`herdr_offline`，界面会给出手动启动提示；Herdr 稍后出现后会自动恢复，不需要
重启 `pairfob` 或重新配对。显式设置 `PAIRFOB_HERDR_AUTOSTART=0` 可关闭自动启动；
多会话模式也不会猜测要启动哪个 session。

The encrypted RPC surface also supports creating a conversation, creating tabs
and splits, prompting a detected agent, listing/creating/opening Git worktrees,
and bounded pane resize/swap/zoom controls. `GetConfig.capabilities` is the
authority for showing these controls; `GetConfig.agent_kinds` is the authority
for the agent picker. Omitting `agent_kind` on `CreateConversation` creates a
terminal workspace without starting an agent. A newer installed Herdr CLI does not make an older running
server capable: Pairfob gates each operation on the live server protocol and
returns `unsupported` before attempting a mutation.

Each pane can switch among **控制** (phone UI for the rendered session), **终端**
(xterm on Herdr's existing terminal controller), and **对话** (Agent messages).
**控制** is the default. **终端** streams ordered ANSI frames and forwards raw
keyboard, resize, and scroll without starting another shell. Leaving **终端**,
hiding the PWA, or losing the encrypted session releases terminal ownership;
taking control from another client always asks for confirmation. **终端** requires
a running Herdr server compatible with the Herdr 0.8.2 terminal controller
interface.

The capability object is closed and always contains eleven independent boolean
keys: `create_conversation`, `create_tab`, `split_pane`, `prompt_agent`,
`history`, `list_worktrees`, `create_worktree`, `open_worktree`, `resize_pane`,
`swap_pane`, and `zoom_pane`. There are no aggregate `worktrees` or `layout`
aliases, so one unavailable operation does not hide its supported siblings.

Every mutation carries a fresh `operation_id` (`op_` plus 16 or more base64url
characters). It is separate from the RPC request `id`, is never an instruction
to retry, and must not be reused for a different payload. Pairfob never
automatically retries mutations. `unknown_outcome` means the caller must refresh
`Snapshot` or `ListWorktrees` instead of resending the operation; a composed
operation such as `CreateConversation` may report `partial_failure`.
Before a side effect starts, pairfob writes the device/session/intent fingerprint
to `operations.json`; terminal receipts are then updated atomically. A pending
row recovered after a crash returns `unknown_outcome` and is never replayed.
Completed rows are retained for 30 days, and a full 65,536-row ledger rejects new
mutations instead of evicting a still-valid id.

`History` has two computer-owned views. Conversation history resolves the pane
from a fresh trusted Herdr snapshot and uses only that pane's `agent_session`
reference; Codex, Claude, and Grok transcript adapters are supported when the
reference is usable. Safe execution-path entries expose a tool name, never model
thinking, tool arguments, or tool output. Rendered terminal history uses Herdr's
idle alternate-screen reader through a reserved opaque cursor and fixed
200–4096-line windows. The phone cannot submit a transcript ID, path, pane-read
source, or arbitrary line count. Missing mappings and containment failures fail
closed, and a busy or manually scrolled terminal must become idle before its
rendered history can be collected.
Successful pages have exactly `items: [{role, text}]`, nullable `next_cursor`,
and boolean `truncated`; legacy `messages`, `turns`, or timestamp variants are
not part of the wire interface.

The JSON Schema exposes named success-result definitions for `GetConfig`,
`History`, and every operation added above (for example,
`createConversationResult` and `listWorktreesResult`). A response intentionally
does not repeat `op`; the client matches `id` to its pending request and validates
`result` against that operation's named definition. These definitions are the
normative result interface even though a standalone response cannot select one.
Every mutation success echoes the request's `operation_id`. Conversation, tab,
split, prompt, and worktree creation succeed only as `applied`; opening an
already-open worktree and an unchanged resize/swap/zoom succeed as `noop`.

Every `cwd` supplied by the Web must resolve inside a workspace or pane root
from the fresh live snapshot, or an allowed local root. When
`PAIRFOB_ALLOWED_ROOTS` is unset, the daemon user's Home directory is the default
allowed root. Setting the variable explicitly replaces that Home default; an
explicit empty value leaves only live Herdr roots. The variable is an OS
path-list of absolute directories (for example,
`/Users/me/src:/Volumes/work` on Unix); invalid, missing, or relative entries
fail closed. A new `CreateWorktree.path` may also be a direct sibling of a live
checkout root after canonicalizing its existing parent. These rules do not
allow symlink/`..` escapes beyond the selected roots.
`ListWorktrees` must carry exactly one of `workspace_id` or `cwd`; it never falls
back to the focus state of Herdr or another client.

The Web surface deliberately does not expose raw Herdr server/plugin/integration
management, arbitrary commands or environment injection, worktree removal,
focus-stealing operations, or unrestricted `layout.apply`. Creation and layout
mutations always use `focus=false`.

## Operations

```
pairfob pair
pairfob list
pairfob forget 1
pairfob update
pairfob doctor
pairfob version
```

`pair`, `list`, and `forget` talk to the running daemon over `$PAIRFOB_STATE_DIR/pairfob.sock`
(0600). The other end can be a phone, tablet, or another computer running the
PWA. In a terminal, `pairfob` with no arguments shows a short status when the
daemon is already running. Advanced diagnostics (`pair new|status|accept|deny`,
`enroll`, `service`, `relay rekey`) stay available and are omitted from the default
help. There is no local browser confirm page. `update` replaces the binary and
restarts an installed user service. `doctor` prints a human checklist (running,
paired count, Herdr, origin).

`PAIRFOB_STATE_DIR` contains the daemon identity, reconnect credential, devices,
VAPID key, subscriptions, and audit JSONL. The directory is forced to `0700` and
state files to `0600`; writes are atomic. Back it up as sensitive credential
material. The admin device list deliberately omits PSKs, user agents, and
subscription endpoints/keys. New PWA pairings persist only a coarse device
label such as `iPhone` or `Android 手机`; Settings shows that label, recent
activity, and the subscription count. A phone may revoke only itself; use
`pairfob device revoke <device_id>` locally for any other device.

Web Push is off by default. Enable it with `PAIRFOB_PUSH=1` and set
`PAIRFOB_VAPID_SUBJECT` to an operator-controlled `mailto:` or `https:` URL.
Delivery rejects redirects and any endpoint that resolves to loopback, private,
link-local, unspecified, or multicast addresses. Push tests validate encryption
and delivery against a local TLS fixture; a public provider/device smoke test is
still deployment-specific.

Keep `PAIRFOB_MULTI_SESSION` off unless multiple Herdr session sockets are
intentionally enabled. Never enable `PAIRFOB_DEV_AUTO_ADMIT` outside an
isolated automated test.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

## Security

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).
