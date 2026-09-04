# Pairfob

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![pairfob.com](https://img.shields.io/badge/site-pairfob.com-111111)](https://pairfob.com)

**English** | [简体中文](README_zh.md)

The phone surface for [Herdr](https://herdr.dev). Codex, Claude, and Grok keep
running on your computer; the phone opens those same live sessions. Pair once.
The computer dials out — no inbound ports, no Tailscale.

![The same live agent list on a computer running Herdr and on a phone running Pairfob](site/readme-hero.png)

## What you get

- **The same sessions, not copies.** The phone reads the rendered pane and
  sends keys back to the PTY; a session stays one session on both sides.
- **End-to-end encrypted.** SPAKE2+ pairing with an authenticated code and
  Argon2id-hardened session keys. Keys live only on the computer and the
  paired device; the relay forwards ciphertext it cannot read.
- **Direct when possible.** An established session upgrades to a WebRTC
  DataChannel in the background and keeps the relay as fallback.
- **Outbound only.** The computer dials out; no inbound ports, no VPN.
- **Three pane modes.** Control (the phone-friendly default), Terminal (the
  real PTY), and Chat with the agent.
- **Workspace inspection.** Browse files and read git status, diff, and
  branches from the phone, read-only.
- **Optional notifications.** Push when an agent needs you or finishes a task.
- **中文 / English.** The phone UI follows the browser language or a pinned
  choice.

## Install

macOS or Linux. Herdr 0.7 or newer.

```sh
curl -fsSL https://pairfob.com/install.sh | sh
pairfob pair
```

Or install Pairfob as a Herdr community plugin (Herdr 0.8.2 or newer):

```sh
herdr plugin install arronKler/pairfob
herdr plugin action invoke pair --plugin pairfob
```

The first **Pair a device** action installs the same verified standalone binary
and user service, then opens pairing in an interactive Herdr overlay. Removing the
plugin removes only the Herdr entrypoints; Pairfob and its paired-device state
remain independently installed. See [`plugin/herdr/`](plugin/herdr/README.md).

On the phone, open [pairfob.com/pair](https://pairfob.com/pair) and scan. Press
Enter once on the computer to admit the device.

Docs: [pairfob.com/doc](https://pairfob.com/doc/).

## How it works

```
phone  --HTTPS/WSS pairfob.v2-->  pairfob.com (Worker + Durable Object)
pairfob --outbound WSS---------->  same room  --opaque FWD-->  phone
          \-- WebRTC DataChannel after authenticated setup --/
pairfob --loopback-------------->  Herdr
```

`pairfob.com` is the project's official instance. It forwards ciphertext frames
and cannot read the session. Keys live on the computer and the paired device.
The established session attempts a WebRTC direct upgrade in the background and
keeps relay as fallback. See [`proto/direct-transport.md`](proto/direct-transport.md).

## Commands

```
pairfob pair
pairfob list
pairfob forget 1
pairfob update
pairfob doctor
pairfob service status
pairfob version
```

With no subcommand, `pairfob` prints a short status when the daemon is running
and starts it otherwise. `pair`, `list`, and `forget` talk to that daemon over
`$PAIRFOB_STATE_DIR/pairfob.sock` (0600); `forget` also accepts a device name.
`pairfob service` manages the login service (`status`, `start`, `stop`,
`restart`, `install`, `uninstall`), and `pairfob help` lists the rest.
A second computer runs the same installer; pair it from the phone with
**Settings → Add another computer**.

## Develop

```
(cd pwa && bun install)
./scripts/verify.sh
```

`scripts/verify.sh` is the gate before sending a change: gofmt, vet, Go tests
(including race), vuln check, PWA / Worker / site tests, typecheck, and the
production build. If your change touches protocol primitives or test vectors,
regenerate them with `go run ./cmd/genvectors` first.

Local pairing against the same Worker as production:

```
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
and ACME account data stay under `.dev/acme` and are reused until renewal is needed. Supported DNS
providers are `cloudflare`, `route53`, `alidns`, `tencentcloud`, `huaweicloud`,
and `digitalocean`. The A record must not use an HTTP proxy/CDN because the
private address must remain visible to devices on the same LAN.

Cross-compile downloadable binaries with `./scripts/release.sh`. Pack the origin
(including `/dl/` when `PAIRFOB_PACK_DL=1`) with `scripts/pack-origin-assets.sh`.

## Protocol

Envelope bytes stay `pairfob.v1` (`proto/envelope.md`, `proto/rpc.schema.json`,
`proto/pairfob-vectors.json`). Mux control is `pairfob.v2`
(`proto/envelope-v2.md`). Do not change HKDF info, AAD, Argon2id, DeviceHello,
or inner RPC fields. `pair_loc` never enters SPAKE / Argon2. There is no
`/v1/ws` origin.

`GetConfig.capabilities` is a closed eleven-key object. Mutations carry a fresh
`operation_id` and are never retried automatically. `unknown_outcome` refreshes;
it does not replay. Paths and cwd fail closed outside live snapshot roots or
`PAIRFOB_ALLOWED_ROOTS`.

Each pane can switch among **控制** (Control, the default phone UI), **终端**
(Terminal, the real PTY), and **对话** (Chat). The product loop is not a
terminal emulator: read the rendered pane, send keys back to the PTY.

## Contributing

Issues and pull requests are welcome at
[github.com/arronKler/pairfob](https://github.com/arronKler/pairfob). Make
`./scripts/verify.sh` pass before sending a change. The envelope, vectors, and
RPC fields under `proto/` are frozen by design — a change there needs its own
discussion, not an incidental tweak; see [Protocol](#protocol).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

## Security

Report vulnerabilities privately: [SECURITY.md](SECURITY.md).
